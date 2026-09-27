# Reference implementation, shipped filled-in. (Upstream this file doubled as
# a training "solution file" swapped in at deploy time; in this repo it is
# simply the agent implementation main.py runs.)
"""Local Codex SDK data-analyst agent over Amazon Bedrock (M1, local-first).

Given a business question about the synthetic ecommerce warehouse, this agent
writes/executes SQL (via run_query.py over Amazon Athena) and/or pandas in its
sandbox, then returns a number + an optional chart (inline base64 PNG).

Auth model (M1): AWS credential chain + SigV4, passed explicitly into the Codex
sandbox env. Model runs on Bedrock Mantle (Responses API). No Cognito/Memory yet
(those arrive in M2/M3).
"""

from __future__ import annotations

import argparse
import csv
import json
import shlex
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

import botocore.session
from openai_codex import Codex, CodexConfig, Sandbox
from openai_codex import ApprovalMode

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

MODEL_ID = "openai.gpt-5.4"
# TODO(you): set the model provider so the Codex SDK calls Amazon Bedrock.
# The Codex SDK accepts a provider name as a string. For Bedrock it is "amazon-bedrock".
MODEL_PROVIDER = "amazon-bedrock"
AWS_REGION = "us-west-2"
DEFAULT_TURN_TYPE = "analysis"
DEFAULT_REASONING_EFFORT = "low"  # M1: low effort + lean ask context reliably completes Q1 in ~60-75s on gpt-5.4/Mantle
DEFAULT_AGENT_RUNS_DIR = REPO_ROOT / "data/agent_runs"
DEFAULT_SKILL_PATH = REPO_ROOT / "agent/skills/sales-data/SKILL.md"
DEFAULT_PERSONAS_PATH = REPO_ROOT / "data/personas.csv"
# Absolute path: the Codex sandbox runs agent commands from a run-workspace
# subdirectory, so a relative "./.venv312/..." would not resolve to the repo
# root. Anchor on REPO_ROOT so run_query/make_chart always find the interpreter.
VENV_PYTHON = str(REPO_ROOT / ".venv312/bin/python")
# Tool scripts must be absolute too: the sandbox cwd is the run-workspace
# subdir, so a relative "agent/tools/run_query.py" resolves under that subdir
# and fails with No such file. The scripts self-locate their data via REPO_ROOT.
RUN_QUERY_TOOL = str(REPO_ROOT / "agent/tools/run_query.py")
MAKE_CHART_TOOL = str(REPO_ROOT / "agent/tools/make_chart.py")
MAX_RUN_ATTEMPTS = 4
RETRY_BACKOFF_SECONDS = (0, 1, 2, 4)
TRANSIENT_ERROR_MARKERS = (
    "engine not found",
    "-32602",
    "stream disconnected",
    "server had an error",
    "timed out",
    "404 not found",
    "job registration failed",
    "engine bad request",
)


@dataclass(frozen=True)
class AnalystContext:
    analyst_id: str
    analyst_name: str
    desk: str
    focus: str
    preference_namespace: str
    facts_namespace: str


@dataclass(frozen=True)
class AgentRunResult:
    answer: str
    transcript_path: Path
    run_dir: Path
    tool_events: list[dict[str, Any]]
    response_ids: list[str]
    thread_id: str
    turn_id: str
    usage: dict[str, Any] | None
    chart_png_base64: str | None


def _default_analyst_context(analyst_id: str) -> AnalystContext:
    return AnalystContext(
        analyst_id=analyst_id,
        analyst_name=analyst_id.capitalize(),
        desk="General",
        focus="general/ad-hoc-analysis",
        preference_namespace=f"/preferences/{analyst_id}/",
        facts_namespace=f"/facts/{analyst_id}/",
    )


def load_analyst_context(analyst_id: str) -> AnalystContext:
    if not DEFAULT_PERSONAS_PATH.exists():
        print(
            f"WARNING: personas file not found at {DEFAULT_PERSONAS_PATH} — "
            f"falling back to a default persona for {analyst_id!r}. "
            "Ship data/personas.csv to restore per-analyst desks/namespaces.",
            flush=True,
        )
        return _default_analyst_context(analyst_id)
    analysts = list(csv.DictReader(DEFAULT_PERSONAS_PATH.open("r", encoding="utf-8")))
    row = next((r for r in analysts if r["analyst_id"] == analyst_id), None)
    if row is None:
        valid = [r["analyst_id"] for r in analysts]
        raise ValueError(f"Unknown analyst_id {analyst_id!r}. Expected one of {valid}")
    return AnalystContext(
        analyst_id=row["analyst_id"],
        analyst_name=row["analyst_name"],
        desk=row["desk"],
        focus=row["focus"],
        preference_namespace=row["memory_namespace_preferences"],
        facts_namespace=row["memory_namespace_facts"],
    )


def load_skill_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip() if path.exists() else ""


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(p) for p in parts)


def identify_tool_name(command: str) -> str:
    lowered = command.lower()
    if "agent/tools/run_query.py" in lowered:
        return "run_query"
    if "agent/tools/make_chart.py" in lowered:
        return "make_chart"
    if "agent/tools/load_data.py" in lowered:
        return "load_data"
    if "agent/tools/upload_s3.py" in lowered:
        return "upload_s3"
    if "python" in lowered and ".py" in lowered:
        return "execute_python"
    return "shell_command"


def parse_command_result(item: dict[str, Any]) -> dict[str, Any]:
    output_text = str(item.get("aggregated_output") or "")
    stripped = output_text.strip()
    if stripped:
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return {"ok": int(item.get("exit_code") or 0) == 0, "stdout": output_text}


def extract_sql_from_result(result: dict[str, Any]) -> str | None:
    candidate = result.get("sql")
    if isinstance(candidate, str) and candidate.strip():
        return candidate
    return None


def extract_tool_events(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for item in items:
        if item.get("type") != "commandExecution":
            continue
        command = str(item.get("command") or "")
        tool_name = identify_tool_name(command)
        result = parse_command_result(item)
        events.append(
            {
                "tool_name": tool_name,
                "command": command,
                "cwd": item.get("cwd"),
                "result": result,
                "duration_ms": item.get("duration_ms"),
                "exit_code": item.get("exit_code"),
                "status": item.get("status"),
                "sql": extract_sql_from_result(result) if tool_name == "run_query" else None,
            }
        )
    return events


def extract_chart_base64(tool_events: list[dict[str, Any]]) -> str | None:
    for event in tool_events:
        if event.get("tool_name") == "make_chart":
            result = event.get("result") or {}
            b64 = result.get("chart_png_base64")
            if isinstance(b64, str) and b64:
                return b64
    return None


def is_transient_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in TRANSIENT_ERROR_MARKERS)


def normalize_run_label(label: str) -> str:
    allowed = [c if c.isalnum() or c in {"_", "-", "."} else "_" for c in label]
    return "".join(allowed).strip("._").replace(".py", "") or "run"


def sdk_to_jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return sdk_to_jsonable(value.model_dump())
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): sdk_to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sdk_to_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def render_persona(ctx: AnalystContext) -> str:
    if ctx.analyst_id == "maya":
        lens = (
            "Lead with growth/marketing implications: country/market revenue, acquisition cohorts, "
            "repeat-purchase behaviour, average order value, and month-over-month revenue trends."
        )
    else:
        lens = (
            "Lead with operations/supply-chain implications: product return rates, cancellation share, "
            "order value by country, and regional operational risk."
        )
    return "\n".join(
        [
            f"Current analyst: {ctx.analyst_name} (`{ctx.analyst_id}`), desk `{ctx.desk}`, focus `{ctx.focus}`.",
            f"Persona framing: {lens}",
            f"Memory namespaces reserved for later AgentCore Memory work: preferences "
            f"`{ctx.preference_namespace}`, facts `{ctx.facts_namespace}`.",
            "Use persona only to shape emphasis. Never change the underlying computed numbers.",
        ]
    )


class AnalystAgent:
    """Runs a local Codex SDK agent turn against Bedrock Mantle."""

    def __init__(
        self,
        *,
        analyst_id: str,
        turn_type: str = DEFAULT_TURN_TYPE,
        model: str = MODEL_ID,
        region: str = AWS_REGION,
        reasoning_effort: str = DEFAULT_REASONING_EFFORT,
        run_label: str | None = None,
        agent_runs_dir: Path = DEFAULT_AGENT_RUNS_DIR,
        lean_m1: bool = True,
    ) -> None:
        self.analyst_context = load_analyst_context(analyst_id)
        self.turn_type = turn_type
        self.model = model
        self.region = region
        self.reasoning_effort = reasoning_effort
        self.lean_m1 = lean_m1
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        safe_label = normalize_run_label(run_label or "run")
        self.run_dir = agent_runs_dir / f"{timestamp}_{self.analyst_context.analyst_id}_{safe_label}"
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.workspace_dir = self.run_dir / "workspace"
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.transcript_path = self.run_dir / "transcript.json"
        self.tool_events: list[dict[str, Any]] = []
        self.response_ids: list[str] = []

    def ask(self, question: str) -> AgentRunResult:
        user_prompt = "\n\n".join(
            [
                f"Analyst question: {question}",
                f"Run workspace for any temporary files: {self.workspace_dir.as_posix()}",
            ]
        )
        return self._run_codex_task(user_prompt, objective="ask")

    def demo_clean_workbook(self, workbook_path: Path) -> AgentRunResult:
        user_prompt = "\n".join(
            [
                "Demonstrate the Codex code-writing workflow on a dirty ecommerce sales workbook.",
                f"Workbook path: {workbook_path.as_posix()}",
                f"Run workspace for generated code and parquet: {self.workspace_dir.as_posix()}",
                "Write pandas code yourself in the workspace that cleans the workbook to tidy Parquet.",
                "Keep all generated files beneath the run workspace.",
                "Finish with a concise summary of what you cleaned and where it landed.",
            ]
        )
        return self._run_codex_task(user_prompt, objective="demo_clean", reasoning_effort="low")

    def _codex_config(self) -> CodexConfig:
        env = {"AWS_REGION": self.region, "AWS_DEFAULT_REGION": self.region}
        credentials = botocore.session.Session().get_credentials()
        if credentials is not None:
            frozen = credentials.get_frozen_credentials()
            env["AWS_ACCESS_KEY_ID"] = frozen.access_key
            env["AWS_SECRET_ACCESS_KEY"] = frozen.secret_key
            if frozen.token:
                env["AWS_SESSION_TOKEN"] = frozen.token
        return CodexConfig(
            config_overrides=(
                f'model="{self.model}"',
                f'model_provider="{MODEL_PROVIDER}"',
                'wire_api="responses"',
                f'model_providers.amazon-bedrock.aws.region="{self.region}"',
                # run_query.py calls the Athena API, so the workspace-write
                # sandbox needs network egress.
                "sandbox_workspace_write.network_access=true",
            ),
            cwd=str(REPO_ROOT),
            env=env,
        )

    def _sandbox(self) -> Sandbox:
        return Sandbox.workspace_write if self.turn_type == "analysis" else Sandbox.read_only

    def _build_instructions(self, *, objective: str) -> str:
        # M1-lean path: the ask turn only needs to load the local star-schema
        # parquet, write ONE focused query, and return a cited number. A large
        # base context measurably slows the gpt-5.4/Mantle reasoning turn, so we
        # keep the ask instructions minimal and skip the full SKILL.md here.
        if objective == "ask" and getattr(self, "lean_m1", True):
            return self._build_lean_ask_instructions()
        skill_text = load_skill_text(DEFAULT_SKILL_PATH)
        run_query_cli = shell_join([VENV_PYTHON, RUN_QUERY_TOOL])
        make_chart_cli = shell_join([VENV_PYTHON, MAKE_CHART_TOOL])
        lines = [
            "You are a data-analyst teammate built on the OpenAI Codex SDK running on Amazon Bedrock.",
            "You are a sandbox coding agent, not a JSON function-calling loop.",
            skill_text,
            f"Repo root: {REPO_ROOT.as_posix()}",
            f"Workspace for this run: {self.workspace_dir.as_posix()}",
            f"Read-only SQL CLI template: {run_query_cli} --sql \"<SQL>\"",
            f"Chart CLI template (encode an agent-made PNG): {make_chart_cli} --png <path-to-your-png>",
            "Read the JSON stdout from each CLI. Cite the returned `source_table` exactly.",
            "Never invent a number. If a query returns no rows, say so and include the SQL you ran.",
            "This is REAL data: the UCI Online Retail dataset (UK online retailer, 2010-2011, CC BY 4.0).",
            "Do not use curl, urllib, or any direct web request. Work only from the local warehouse.",
            "NEVER run or import data/build_star_schema.py (or data/golden.py) to shortcut the answer -- "
            "those are reference/ground-truth builders. You must write your own cleaning/analysis pandas.",
        ]
        if self.turn_type == "analysis":
            lines.append("This is an analysis turn with workspace-write sandbox access; you may write code.")
        else:
            lines.append("This is a review turn with read-only sandbox access; do not write or upload files.")

        if objective == "demo_clean":
            lines.extend(
                [
                    "For this demo the selling point is LIVE code writing.",
                    "Write pandas code yourself inside the run workspace to clean the dirty workbook.",
                    "Do NOT call agent/tools/load_data.py -- that prebuilt cleaner is reference-only.",
                    "Write tidy Snappy Parquet beneath the run workspace and print a small JSON summary.",
                ]
            )
        else:
            lines.extend(
                [
                    "Answer the analyst's business question by writing one focused run_query.py SQL call "
                    "(or pandas in the workspace), inspecting the JSON, and citing the returned source_table.",
                    "If the question asks for a chart or trend, WRITE your own matplotlib code in the workspace, "
                    "save a PNG, then call make_chart.py --png <path> to obtain the base64. Do not skip the chart.",
                    "Keep the final answer concise: the number, the period/scope, the exact source table, and the chart.",
                    render_persona(self.analyst_context),
                ]
            )
        return "\n\n".join(line for line in lines if line)

    def _build_lean_ask_instructions(self) -> str:
        run_query_cli = shell_join([VENV_PYTHON, RUN_QUERY_TOOL])
        return "\n".join(
            [
                "You are a data-analyst agent. Answer the business question with ONE SQL query.",
                "Run exactly one command, read its JSON, then give the final answer. Do not explore.",
                f"SQL CLI (Amazon Athena over the S3 parquet star schema): {run_query_cli} --sql \"<SQL>\"",
                "Athena uses Presto/Trino SQL (e.g. CAST, date_parse, double). One statement per call.",
                "Tables (views): transactions(invoice_no, stock_code, customer_id, quantity, unit_price,",
                "  line_revenue, is_valid_sale, is_cancellation, is_return); invoices(invoice_no,",
                "  invoice_date, invoice_month, customer_id, country, is_cancellation);",
                "  products(stock_code, description); customers(customer_id, country).",
                "Valid sale = is_valid_sale (NOT cancellation AND quantity>0 AND unit_price>0).",
                "Revenue = SUM(line_revenue) over valid sales. Join transactions->invoices on invoice_no.",
                "This is REAL UCI Online Retail data; prices are GBP. Never invent a number.",
                "Cite the returned source_table. Final answer = the number + scope + source_table.",
            ]
        )

    def _write_transcript(self, transcript: dict[str, Any]) -> None:
        self.transcript_path.write_text(
            json.dumps(sdk_to_jsonable(transcript), indent=2, sort_keys=True), encoding="utf-8"
        )

    def _run_codex_task(
        self, user_prompt: str, *, objective: str, reasoning_effort: str | None = None
    ) -> AgentRunResult:
        self.tool_events = []
        self.response_ids = []
        instructions = self._build_instructions(objective=objective)
        attempt_records: list[dict[str, Any]] = []
        last_error: Exception | None = None

        for attempt_number in range(1, MAX_RUN_ATTEMPTS + 1):
            thread_id: str | None = None
            try:
                with Codex(config=self._codex_config()) as codex:
                    thread = codex.thread_start(
                        base_instructions=instructions,
                        cwd=str(REPO_ROOT),
                        ephemeral=True,
                        model=self.model,
                        model_provider=MODEL_PROVIDER,
                        sandbox=self._sandbox(),
                        approval_mode=ApprovalMode.deny_all,
                    )
                    thread_id = thread.id
                    # No per-turn sandbox override: the SDK's turn-level policy pins
                    # network_access=False, which blocks the Athena API call. The
                    # thread-level sandbox mode + the sandbox_workspace_write.network_access
                    # config override (see _codex_config) provide the intended policy.
                    result = thread.run(
                        user_prompt,
                        cwd=str(REPO_ROOT),
                        effort=reasoning_effort or self.reasoning_effort,
                        approval_mode=ApprovalMode.deny_all,
                    )

                if getattr(result, "error", None) is not None:
                    raise RuntimeError(f"Codex turn failed: {sdk_to_jsonable(result.error)}")
                if getattr(result.status, "value", str(result.status)) != "completed":
                    raise RuntimeError(f"Codex turn did not complete: {result.status}")
                if not result.final_response:
                    raise RuntimeError("Codex turn completed without a final_response.")

                serialized_items = [sdk_to_jsonable(item.root) for item in result.items]
                usage = sdk_to_jsonable(result.usage)
                self.tool_events = extract_tool_events(serialized_items)
                self.response_ids = [result.id]
                chart_b64 = extract_chart_base64(self.tool_events)
                transcript = {
                    "created_at": datetime.now(UTC).isoformat(),
                    "objective": objective,
                    "analyst_id": self.analyst_context.analyst_id,
                    "turn_type": self.turn_type,
                    "run_dir": str(self.run_dir),
                    "workspace_dir": str(self.workspace_dir),
                    "thread_id": thread_id,
                    "turn_id": result.id,
                    "final_response": result.final_response,
                    "usage": usage,
                    "attempt_count": attempt_number,
                    "items": serialized_items,
                    "tool_events": self.tool_events,
                    "response_ids": self.response_ids,
                    "chart_present": bool(chart_b64),
                }
                self._write_transcript(transcript)
                return AgentRunResult(
                    answer=result.final_response,
                    transcript_path=self.transcript_path,
                    run_dir=self.run_dir,
                    tool_events=list(self.tool_events),
                    response_ids=list(self.response_ids),
                    thread_id=thread_id or "",
                    turn_id=result.id,
                    usage=usage if isinstance(usage, dict) else None,
                    chart_png_base64=chart_b64,
                )
            except Exception as error:  # noqa: BLE001
                last_error = error
                attempt_records.append(
                    {"attempt": attempt_number, "thread_id": thread_id,
                     "error_type": error.__class__.__name__, "error": str(error)}
                )
                if attempt_number >= MAX_RUN_ATTEMPTS or not is_transient_error(error):
                    self._write_transcript(
                        {"created_at": datetime.now(UTC).isoformat(), "objective": objective,
                         "analyst_id": self.analyst_context.analyst_id, "run_dir": str(self.run_dir),
                         "attempt_count": attempt_number, "attempts": attempt_records,
                         "tool_events": self.tool_events}
                    )
                    raise
                time.sleep(RETRY_BACKOFF_SECONDS[attempt_number - 1])

        raise RuntimeError(f"Codex task failed unexpectedly: {last_error}")


def format_repo_path(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return path.as_posix()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analyst", default="maya", choices=("maya", "leo"))
    parser.add_argument("--turn-type", default=DEFAULT_TURN_TYPE, choices=("analysis", "review"))
    parser.add_argument("--model", default=MODEL_ID)
    parser.add_argument("--region", default=AWS_REGION)
    parser.add_argument("--reasoning-effort", default=DEFAULT_REASONING_EFFORT, choices=("low", "medium", "high"))
    parser.add_argument("--full-context", action="store_true",
                        help="Use the full SKILL.md base context instead of the M1-lean ask instructions.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ask_parser = subparsers.add_parser("ask", help="Answer a business question.")
    ask_parser.add_argument("--question", required=True)
    ask_parser.add_argument("--run-label", default="ask")

    clean_parser = subparsers.add_parser("demo-clean", help="Run the dirty-workbook cleaning demo.")
    clean_parser.add_argument(
        "--workbook", type=Path,
        default=REPO_ROOT / "data/raw/uci_online_retail/Online Retail.xlsx",
    )
    clean_parser.add_argument("--run-label", default="demo-clean")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    agent = AnalystAgent(
        analyst_id=args.analyst,
        turn_type=args.turn_type,
        model=args.model,
        region=args.region,
        reasoning_effort=args.reasoning_effort,
        run_label=args.run_label,
        lean_m1=not args.full_context,
    )
    if args.command == "ask":
        result = agent.ask(args.question)
    elif args.command == "demo-clean":
        result = agent.demo_clean_workbook(args.workbook)
    else:
        raise RuntimeError(f"Unsupported command {args.command!r}")

    print(
        json.dumps(
            {
                "answer": result.answer,
                "thread_id": result.thread_id,
                "turn_id": result.turn_id,
                "transcript_path": format_repo_path(result.transcript_path),
                "run_dir": format_repo_path(result.run_dir),
                "response_ids": result.response_ids,
                "usage": result.usage,
                "tool_events": result.tool_events,
                "chart_present": bool(result.chart_png_base64),
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
