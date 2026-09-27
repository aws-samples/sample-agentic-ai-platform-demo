"""AgentCore Runtime entrypoint for the data-analyst teammate (Phase 2 / M3).

This is the deployed app. It wraps the verified M1 Codex SDK analyst agent (the
lean-context fast path) so a remote caller gets the SAME "write SQL -> cited
number" workflow that runs locally, but inside Bedrock AgentCore Runtime.

Auth model (M3): SigV4 / IAM only. There is NO Cognito JWT authorizer yet --
JWT identity + Memory + KB + Gateway all arrive in M4. The analyst persona is
therefore taken from the request payload (default `maya`); in M4 it will be
derived from a verified JWT claim instead.

Outbound model auth: a short-lived Bedrock bearer token minted from the
execution role via aws_bedrock_token_generator.provide_token(). The Codex CLI
is the bundled arm64 (musl) binary shipped in .codex-runtime/.

Data plane: Amazon Athena over the UCI Online Retail star-schema parquet on S3
(Glue database `uci_retail`, workgroup `data_analyst_agent`), queried through
agent/tools/run_query.py. Provisioned platform-side (the provisioning script
is not shipped in this repo).
"""

from __future__ import annotations

import json
import os
import shlex
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

import botocore.session
from aws_bedrock_token_generator import provide_token
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext as AgentCoreRequestContext
from openai_codex import ApprovalMode, Codex, CodexConfig, Sandbox


MODEL_ID = os.environ.get("MODEL_ID", "openai.gpt-5.4")
MODEL_PROVIDER = "amazon-bedrock"
AWS_REGION = os.environ.get("AWS_REGION", "us-west-2")
DEFAULT_REASONING_EFFORT = "low"  # mirrors the verified M1 lean fast path (~70s for Q1)
DEFAULT_TURN_TYPE = "analysis"
DEFAULT_ANALYST_ID = "maya"
TRACE_PREFIX = "ANALYST_TRACE "

REPO_ROOT = Path(__file__).resolve().parent
PERSONAS_PATH = REPO_ROOT / "data/personas.csv"
PROCESSED_DATA_DIR = REPO_ROOT / "data/processed/uci_retail"
RUNTIME_RUNS_DIR = Path("/tmp/data_analyst_runtime_runs")
CODEX_HOME = Path("/tmp/data_analyst_codex_home")
CODEX_BIN_PATH = (
    REPO_ROOT / ".codex-runtime" / "package" / "vendor"
    / "aarch64-unknown-linux-musl" / "bin" / "codex"
)

MAX_RUN_ATTEMPTS = 4
RETRY_BACKOFF_SECONDS = (0, 1, 2, 4)


def _ensure_codex_executable() -> Path | None:
    """Ensure the codex binary is executable.

    In Lambda-style zip deployments (read-only /var/task), binaries from wheels
    may not have the execute bit. We copy to /tmp (writable) and chmod there.
    Returns the path to a usable executable, or None if not found.
    """
    import glob, shutil, stat
    candidates = [
        str(CODEX_BIN_PATH),
        # openai-codex-cli-bin wheel installs the binary here
        "/var/task/codex_cli_bin/bin/codex",
    ]
    # Also search the installed package locations
    candidates += glob.glob("/var/task/*/bin/codex")
    candidates += glob.glob("/var/task/.venv*/bin/codex")

    for src in candidates:
        if src and os.path.isfile(src):
            try:
                current = os.stat(src).st_mode
                if current & stat.S_IXUSR:
                    return Path(src)  # already executable
                # /var/task is read-only in Lambda — copy to /tmp
                tmp_bin = Path("/tmp/codex_bin/codex")
                tmp_bin.parent.mkdir(parents=True, exist_ok=True)
                if not tmp_bin.exists():
                    shutil.copy2(src, tmp_bin)
                os.chmod(tmp_bin, tmp_bin.stat().st_mode | stat.S_IRWXU | stat.S_IXGRP | stat.S_IXOTH)
                print(f"Copied codex to {tmp_bin} with execute permission.", flush=True)
                return tmp_bin
            except OSError as e:
                print(f"WARNING: could not prepare codex binary from {src}: {e}", flush=True)
    return None


_CODEX_EXEC_PATH: Path | None = _ensure_codex_executable()
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

app = BedrockAgentCoreApp()


@dataclass(frozen=True)
class AnalystContext:
    analyst_id: str
    analyst_name: str
    desk: str
    focus: str
    preference_namespace: str
    facts_namespace: str


def emit_trace(event_type: str, /, **fields: Any) -> None:
    payload = {"event_type": event_type, "timestamp": datetime.now(UTC).isoformat(), **fields}
    print(f"{TRACE_PREFIX}{json.dumps(payload, default=str, sort_keys=True)}", flush=True)


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
    import csv

    if not PERSONAS_PATH.exists():
        print(
            f"WARNING: personas file not found at {PERSONAS_PATH} — "
            f"falling back to a default persona for {analyst_id!r}. "
            "Ship data/personas.csv to restore per-analyst desks/namespaces.",
            flush=True,
        )
        return _default_analyst_context(analyst_id)
    rows = list(csv.DictReader(PERSONAS_PATH.open("r", encoding="utf-8")))
    row = next((r for r in rows if r["analyst_id"] == analyst_id), None)
    if row is None:
        valid = [r["analyst_id"] for r in rows]
        raise ValueError(f"Unknown analyst_id {analyst_id!r}. Expected one of {valid}")
    return AnalystContext(
        analyst_id=row["analyst_id"],
        analyst_name=row["analyst_name"],
        desk=row["desk"],
        focus=row["focus"],
        preference_namespace=row["memory_namespace_preferences"],
        facts_namespace=row["memory_namespace_facts"],
    )


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(p) for p in parts)


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


def is_transient_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in TRANSIENT_ERROR_MARKERS)


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
            "Use persona only to shape emphasis. Never change the underlying computed numbers.",
        ]
    )


class RuntimeAnalystAgent:
    """AgentCore runtime wrapper around the M1 Codex SDK analyst thread."""

    def __init__(
        self,
        *,
        analyst_id: str,
        turn_type: str = DEFAULT_TURN_TYPE,
        reasoning_effort: str = DEFAULT_REASONING_EFFORT,
        session_id: str | None = None,
        lean_m1: bool = True,
    ) -> None:
        self.analyst_context = load_analyst_context(analyst_id)
        self.turn_type = turn_type
        self.reasoning_effort = reasoning_effort
        self.session_id = session_id
        self.lean_m1 = lean_m1
        self.tool_events: list[dict[str, Any]] = []
        self.response_ids: list[str] = []

    def ask(self, question: str) -> dict[str, Any]:
        run_paths = self._run_paths("ask")
        user_prompt = "\n\n".join(
            [
                f"Analyst question: {question}",
                f"Run workspace for any temporary files: {run_paths.workspace_dir.as_posix()}",
            ]
        )
        emit_trace(
            "agent_request_started",
            session_id=self.session_id,
            analyst_id=self.analyst_context.analyst_id,
            analyst_name=self.analyst_context.analyst_name,
            turn_type=self.turn_type,
            operation="ask",
            reasoning_effort=self.reasoning_effort,
            lean_m1=self.lean_m1,
        )
        return self._run_codex_task(user_prompt, objective="ask", run_paths=run_paths)

    def demo_clean_workbook(self, workbook_path: Path) -> dict[str, Any]:
        run_paths = self._run_paths("demo_clean")
        user_prompt = "\n".join(
            [
                "Demonstrate the Codex code-writing workflow on a dirty ecommerce sales workbook.",
                f"Workbook path: {workbook_path.as_posix()}",
                f"Run workspace for generated code and parquet: {run_paths.workspace_dir.as_posix()}",
                "Write pandas code yourself in the workspace that cleans the workbook to tidy Parquet.",
                "Keep all generated files beneath the run workspace.",
                "Finish with a concise summary of what you cleaned and where it landed.",
            ]
        )
        emit_trace(
            "agent_request_started",
            session_id=self.session_id,
            analyst_id=self.analyst_context.analyst_id,
            turn_type=self.turn_type,
            operation="demo_clean",
        )
        return self._run_codex_task(
            user_prompt, objective="demo_clean", run_paths=run_paths, reasoning_effort="low"
        )

    def _codex_config(self) -> CodexConfig:
        CODEX_HOME.mkdir(parents=True, exist_ok=True)
        env = {
            "AWS_REGION": AWS_REGION,
            "AWS_DEFAULT_REGION": AWS_REGION,
            "AWS_BEARER_TOKEN_BEDROCK": provide_token(region=AWS_REGION),
            "CODEX_HOME": str(CODEX_HOME),
        }
        credentials = botocore.session.Session().get_credentials()
        if credentials is not None:
            frozen = credentials.get_frozen_credentials()
            env["AWS_ACCESS_KEY_ID"] = frozen.access_key
            env["AWS_SECRET_ACCESS_KEY"] = frozen.secret_key
            if frozen.token:
                env["AWS_SESSION_TOKEN"] = frozen.token
        _exec = _CODEX_EXEC_PATH
        if _exec is not None and _exec.exists():
            env["PATH"] = os.pathsep.join(
                [
                    str(_exec.parent),
                    env.get("PATH", os.environ.get("PATH", "")),
                ]
            ).strip(os.pathsep)
        return CodexConfig(
            codex_bin=str(_exec) if _exec is not None and _exec.exists() else None,
            config_overrides=(
                f'model="{MODEL_ID}"',
                f'model_provider="{MODEL_PROVIDER}"',
                'wire_api="responses"',
                f'model_providers.amazon-bedrock.aws.region="{AWS_REGION}"',
                # run_query.py calls the Athena API, so the workspace-write
                # sandbox needs network egress.
                "sandbox_workspace_write.network_access=true",
            ),
            cwd=str(REPO_ROOT),
            env=env,
        )

    def _sandbox(self) -> Sandbox:
        return Sandbox.workspace_write if self.turn_type == "analysis" else Sandbox.read_only

    def _run_paths(self, run_label: str) -> Any:
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        safe = "".join(c if c.isalnum() or c in {"_", "-"} else "_" for c in run_label) or "run"
        run_dir = RUNTIME_RUNS_DIR / f"{timestamp}_{self.analyst_context.analyst_id}_{safe}"
        workspace_dir = run_dir / "workspace"
        workspace_dir.mkdir(parents=True, exist_ok=True)
        return type(
            "RunPaths",
            (),
            {
                "run_dir": run_dir,
                "workspace_dir": workspace_dir,
                "transcript_path": run_dir / "transcript.json",
            },
        )()

    def _build_lean_ask_instructions(self) -> str:
        # Runtime uses the bundled arm64 codex binary; the repo CLIs must be run
        # with the bundled python (sys.executable), NOT ./.venv312 (absent here).
        run_query_cli = shell_join(
            [sys.executable, str((REPO_ROOT / "agent/tools/run_query.py").resolve())]
        )
        return "\n".join(
            [
                "You are a data-analyst agent. Answer the business question with ONE SQL query.",
                "Run exactly one command, read its JSON, then give the final answer. Do not explore.",
                "Run all shell commands from the writable workspace, not the read-only bundle root.",
                f"SQL CLI (Amazon Athena over the S3 parquet star schema): {run_query_cli} --sql \"<SQL>\"",
                "Athena uses Presto/Trino SQL (e.g. CAST, date_parse, double). One statement per call.",
                "Tables (views): transactions(invoice_no, stock_code, customer_id, quantity, unit_price,",
                "  line_revenue, is_valid_sale, is_cancellation, is_return); invoices(invoice_no,",
                "  invoice_date, invoice_month, customer_id, country, is_cancellation);",
                "  products(stock_code, description); customers(customer_id, country).",
                "Valid sale = is_valid_sale (NOT cancellation AND quantity>0 AND unit_price>0).",
                "Revenue = SUM(line_revenue) over valid sales. Join transactions->invoices on invoice_no.",
                "customer_id can be NULL (guest/anonymous rows): when ranking or grouping BY CUSTOMER,",
                "  exclude rows with NULL/missing customer_id (WHERE customer_id IS NOT NULL).",
                "This is REAL UCI Online Retail data; prices are GBP. Never invent a number.",
                "Cite the returned source_table. Final answer = the number + scope + source_table.",
            ]
        )

    def _build_instructions(self, *, objective: str, workspace_dir: Path) -> str:
        if objective == "ask" and self.lean_m1:
            return self._build_lean_ask_instructions()
        run_query_cli = shell_join(
            [sys.executable, str((REPO_ROOT / "agent/tools/run_query.py").resolve())]
        )
        make_chart_cli = shell_join(
            [sys.executable, str((REPO_ROOT / "agent/tools/make_chart.py").resolve())]
        )
        lines = [
            "You are a data-analyst teammate built on the OpenAI Codex SDK running on Amazon Bedrock AgentCore Runtime.",
            "You are a sandbox coding agent, not a JSON function-calling loop.",
            f"Repo root: {REPO_ROOT.as_posix()}",
            f"Workspace for this run: {workspace_dir.as_posix()}",
            "Run all shell commands from the writable workspace, not the read-only bundle root.",
            "Do not use `./.venv312` in this runtime. Use the exact absolute command templates below.",
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

    def _run_codex_task(
        self,
        user_prompt: str,
        *,
        objective: str,
        run_paths: Any,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        self.tool_events = []
        self.response_ids = []
        instructions = self._build_instructions(objective=objective, workspace_dir=run_paths.workspace_dir)
        attempt_records: list[dict[str, Any]] = []
        last_error: Exception | None = None

        for attempt_number in range(1, MAX_RUN_ATTEMPTS + 1):
            thread_id: str | None = None
            try:
                with Codex(config=self._codex_config()) as codex:
                    thread = codex.thread_start(
                        base_instructions=instructions,
                        cwd=str(run_paths.workspace_dir),
                        ephemeral=True,
                        model=MODEL_ID,
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
                        cwd=str(run_paths.workspace_dir),
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
                emit_trace(
                    "mantle_response_received",
                    session_id=self.session_id,
                    analyst_id=self.analyst_context.analyst_id,
                    turn_type=self.turn_type,
                    response_id=result.id,
                    thread_id=thread_id,
                    attempt=attempt_number,
                    usage=usage,
                    tool_event_count=len(self.tool_events),
                )
                for event in self.tool_events:
                    if event.get("tool_name") == "run_query":
                        res = event.get("result") or {}
                        emit_trace(
                            "query_executed",
                            session_id=self.session_id,
                            analyst_id=self.analyst_context.analyst_id,
                            ok=bool(res.get("ok")),
                            engine=res.get("engine"),
                            sql=event.get("sql"),
                            row_count=(res.get("query") or {}).get("row_count"),
                            source_table=res.get("source_table"),
                        )
                emit_trace(
                    "agent_request_completed",
                    session_id=self.session_id,
                    analyst_id=self.analyst_context.analyst_id,
                    operation=objective,
                    ok=True,
                    attempt_count=attempt_number,
                    chart_present=bool(chart_b64),
                )
                return {
                    "ok": True,
                    "operation": objective,
                    "answer": result.final_response,
                    "analyst_id": self.analyst_context.analyst_id,
                    "analyst_name": self.analyst_context.analyst_name,
                    "desk": self.analyst_context.desk,
                    "focus": self.analyst_context.focus,
                    "thread_id": thread_id or "",
                    "turn_id": result.id,
                    "response_ids": list(self.response_ids),
                    "usage": usage if isinstance(usage, dict) else None,
                    "tool_events": list(self.tool_events),
                    "attempt_count": attempt_number,
                    "chart_present": bool(chart_b64),
                    "chart_png_base64": chart_b64,
                    "identity_source": "sigv4_iam",
                }
            except Exception as error:  # noqa: BLE001
                last_error = error
                attempt_records.append(
                    {
                        "attempt": attempt_number,
                        "thread_id": thread_id,
                        "error_type": error.__class__.__name__,
                        "error": str(error),
                    }
                )
                if attempt_number >= MAX_RUN_ATTEMPTS or not is_transient_error(error):
                    raise
                time.sleep(RETRY_BACKOFF_SECONDS[attempt_number - 1])

        raise RuntimeError(f"Codex task failed unexpectedly: {last_error}")


def resolve_session_id(context: AgentCoreRequestContext | None) -> str | None:
    if context is None:
        return None
    return getattr(context, "session_id", None)


@app.entrypoint
def invoke(payload: dict[str, Any], context: AgentCoreRequestContext | None = None) -> dict[str, Any]:
    operation = str(payload.get("operation") or payload.get("command") or "ask").strip().lower().replace("-", "_")
    # M3: identity is SigV4/IAM, not JWT. Persona comes from the payload (default maya).
    # In M4 this is replaced by a verified Cognito JWT claim (m4_integration is a
    # planned module, not shipped in this repo yet); when the runtime is deployed
    # behind the Cognito JWT authorizer, derive the analyst like this instead:
    #
    #   from m4_integration import analyst_id_from_jwt, AnalystMemoryBridge
    #   token = AgentCoreRequestContext.get_workload_access_token()  # or the inbound bearer token
    #   analyst_id, identity_source = analyst_id_from_jwt(token, payload, DEFAULT_ANALYST_ID)
    #   memory = AnalystMemoryBridge(analyst_id)
    #   recall = memory.recall(question)               # per-analyst preferences + facts
    #   # ... prepend AnalystMemoryBridge.format_recall(recall) to the agent instructions ...
    #   memory.remember(question, answer)              # persist the turn to this analyst's namespace
    #
    # The hook degrades gracefully (no token -> payload, no memory_config.json ->
    # skip recall), so it never breaks the M3 path bundled here.
    analyst_id = str(payload.get("analyst_id") or payload.get("analyst") or DEFAULT_ANALYST_ID).strip().lower()
    turn_type = str(payload.get("turn_type") or DEFAULT_TURN_TYPE).strip().lower()
    reasoning_effort = str(payload.get("reasoning_effort") or DEFAULT_REASONING_EFFORT).strip().lower()
    lean_m1 = bool(payload.get("lean_m1", True))
    session_id = resolve_session_id(context)

    try:
        if operation == "ping":
            ctx = load_analyst_context(analyst_id)
            result = {
                "ok": True,
                "operation": "ping",
                "status": "Healthy",
                "analyst_id": ctx.analyst_id,
                "analyst_name": ctx.analyst_name,
                "desk": ctx.desk,
                "focus": ctx.focus,
                "turn_type": turn_type,
                "session_id": session_id,
                "identity_source": "sigv4_iam",
                "codex_bin_bundled": CODEX_BIN_PATH.exists(),
                "data_dir_present": PROCESSED_DATA_DIR.exists(),
                "time_of_last_update": int(time.time()),
            }
            emit_trace("agent_request_completed", session_id=session_id, analyst_id=analyst_id, operation="ping", ok=True)
            return result

        agent = RuntimeAnalystAgent(
            analyst_id=analyst_id,
            turn_type=turn_type,
            reasoning_effort=reasoning_effort,
            session_id=session_id,
            lean_m1=lean_m1,
        )

        if operation == "ask":
            question = str(payload.get("question") or payload.get("prompt") or "").strip()
            if not question:
                raise ValueError("Payload must include a non-empty `question` for the `ask` operation.")
            return agent.ask(question)

        if operation == "demo_clean":
            workbook = str(payload.get("workbook") or "").strip()
            workbook_path = Path(workbook) if workbook else (REPO_ROOT / "data/raw/uci_online_retail/Online Retail.xlsx")
            return agent.demo_clean_workbook(workbook_path)

        raise ValueError(f"Unsupported operation {operation!r}. Expected `ask`, `demo_clean`, or `ping`.")
    except Exception as error:  # noqa: BLE001
        emit_trace(
            "agent_request_completed",
            session_id=session_id,
            analyst_id=analyst_id,
            operation=operation,
            ok=False,
            error_type=error.__class__.__name__,
            error=str(error),
        )
        return {
            "ok": False,
            "operation": operation,
            "analyst_id": analyst_id,
            "turn_type": turn_type,
            "error_type": error.__class__.__name__,
            "error": str(error),
        }


if __name__ == "__main__":
    app.run()
