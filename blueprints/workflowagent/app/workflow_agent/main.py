import json
from typing import Any
from collections import OrderedDict
from strands import Agent, tool
import asyncio
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
from mcp_client.client import get_streamable_http_mcp_client
from memory.session import get_memory_session_manager
from telemetry import setup_langfuse
from metrics import AgentMetrics

app = BedrockAgentCoreApp()
log = app.logger

# Define a Streamable HTTP MCP Client
mcp_clients = [get_streamable_http_mcp_client()]

# Plan-then-execute orchestrator (the pattern that separates a workflow agent
# from a chat agent): every request becomes an explicit plan tracked step by
# step through the plan tools below, so progress is visible, auditable, and —
# because plan state lives in short-term memory via the session transcript —
# resumable after the runtime recycles the microVM.
DEFAULT_SYSTEM_PROMPT = """
# Role
You are a workflow orchestrator. You run multi-step processes to completion —
you don't just chat about them.

# How you work
1. PLAN FIRST. For any multi-step request, call create_plan with concrete,
   verifiable steps before doing anything else. Show the user the plan.
2. EXECUTE step by step. Before starting a step call update_step(step, "in_progress");
   when it completes call update_step(step, "done", note). One step at a time.
3. REPORT with the plan. When you answer, include current plan status so the
   user always sees where the workflow stands.
4. RESUME, don't restart. If the user returns mid-workflow ("continue", "where
   were we"), call get_plan first and pick up at the first step that isn't done.

# Boundaries
- Steps that would have real side effects you cannot perform (sending email,
  provisioning infra) — mark the step "blocked" with a note saying what a human
  or tool integration must do. Never pretend a side effect happened.
- If a step fails, mark it "failed" with the error and propose a recovery step.
"""


# Define a collection of tools used by the model
tools = []

_INLINE_FUNCTION_NAMES = set()

# --- Plan tools: explicit workflow state, one plan per session ---------------
# In-process store keyed by session; the conversation transcript (short-term
# memory) is what makes plans survive microVM recycling — the model re-creates
# state from the visible plan history when the process restarts.
# ContextVar (not a module global): concurrent invocations each see their own
# session key, so two in-flight requests can't cross-contaminate plans.
import contextvars
_plans: dict = {}
_plan_session: contextvars.ContextVar = contextvars.ContextVar("plan_session", default="default")


def _plan() -> dict:
    return _plans.setdefault(_plan_session.get(), {"goal": "", "steps": []})


def _render_plan(plan: dict) -> str:
    if not plan["steps"]:
        return "No plan yet."
    icons = {"pending": "◻", "in_progress": "▶", "done": "✅", "failed": "❌", "blocked": "⏸"}
    lines = [f"Goal: {plan['goal']}"]
    for i, s in enumerate(plan["steps"], 1):
        note = f" — {s['note']}" if s.get("note") else ""
        lines.append(f"{icons.get(s['status'], '◻')} {i}. {s['title']} [{s['status']}]{note}")
    return "\n".join(lines)


@tool
def create_plan(goal: str, steps: list) -> str:
    """Create the workflow plan for this session. Call this FIRST for any multi-step request.

    goal: one-line statement of what the workflow achieves.
    steps: ordered list of concrete step titles (strings), each independently verifiable.
    """
    plan = _plan()
    plan["goal"] = goal
    plan["steps"] = [{"title": str(t), "status": "pending", "note": ""} for t in steps]
    return _render_plan(plan)
tools.append(create_plan)


@tool
def update_step(step_number: int, status: str, note: str = "") -> str:
    """Update one plan step's status: in_progress | done | failed | blocked.

    step_number is 1-based. Returns the full plan so you can show progress.
    """
    plan = _plan()
    if not 1 <= step_number <= len(plan["steps"]):
        return f"No step {step_number}; plan has {len(plan['steps'])} steps. " + _render_plan(plan)
    if status not in ("pending", "in_progress", "done", "failed", "blocked"):
        return "status must be one of: pending, in_progress, done, failed, blocked"
    plan["steps"][step_number - 1]["status"] = status
    plan["steps"][step_number - 1]["note"] = note
    return _render_plan(plan)
tools.append(update_step)


@tool
def get_plan() -> str:
    """Return the current workflow plan and step statuses. Call when resuming a session."""
    return _render_plan(_plan())
tools.append(get_plan)


# --- Domain workflow tools (demo: employee onboarding checks) ----------------
@tool
def check_system_access(system: str, employee_id: str) -> str:
    """Check whether an employee has access to an internal system (demo data).

    system: one of "email", "vpn", "hr-portal", "code-repo".
    """
    granted = {"email": True, "vpn": True, "hr-portal": True, "code-repo": False}
    ok = granted.get(system.lower())
    if ok is None:
        return f"Unknown system '{system}'. Known: email, vpn, hr-portal, code-repo."
    return f"{system}: {'ACCESS GRANTED' if ok else 'NO ACCESS — request must go through the access-request workflow'} for employee {employee_id}"
tools.append(check_system_access)


@tool
def business_days_until(days: int) -> str:
    """Return the number of business days in the next N calendar days (demo helper)."""
    full_weeks, rem = divmod(max(0, days), 7)
    return f"~{full_weeks * 5 + min(rem, 5)} business days in the next {days} calendar days"
tools.append(business_days_until)



# Add MCP client to tools if available
for mcp_client in mcp_clients:
    if mcp_client:
        tools.append(mcp_client)


def _make_conversation_manager():
    # Sliding window (not Null): the plan history in the transcript is the
    # resumability mechanism, so the model must keep seeing it.
    from strands.agent.conversation_manager.sliding_window_conversation_manager import (
        SlidingWindowConversationManager,
    )
    return SlidingWindowConversationManager(window_size=40)

def agent_factory():
    cache = {}
    def get_or_create_agent(session_id, user_id):
        _actor_id = user_id
        key = f"{session_id}/{_actor_id}"
        if key not in cache:
            cache[key] = Agent(
                model=load_model(),
                session_manager=get_memory_session_manager(session_id, _actor_id),
                conversation_manager=_make_conversation_manager(),
                system_prompt=DEFAULT_SYSTEM_PROMPT,
                tools=tools,
                trace_attributes={
                    "session.id": session_id,
                    "user.id": _actor_id,
                    "langfuse.tags": ["agentcore", "workflow-orchestrator"],
                },
                hooks=[
                ],
            )
        return cache[key]
    return get_or_create_agent
get_or_create_agent = agent_factory()


def _extract_prompt(payload: dict):
    """Accept harness-style messages[], tool_results[], or plain prompt string payloads."""
    if "messages" in payload:
        return payload["messages"]
    if "tool_results" in payload:
        return [{"role": "user", "content": [{"toolResult": {
            "toolUseId": tr["toolUseId"],
            "status": tr.get("status", "success"),
            "content": tr.get("content", []),
        }} for tr in payload["tool_results"]]}]
    return payload.get("prompt", "")


def _has_inline_function_call(messages) -> bool:
    """Return True if messages contains an assistant toolUse for an inline function tool."""
    if not _INLINE_FUNCTION_NAMES or not isinstance(messages, list):
        return False
    for msg in messages:
        if msg.get("role") == "assistant":
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("toolUse", {}).get("name") in _INLINE_FUNCTION_NAMES:
                    return True
    return False


def _is_inline_function_call(event: dict) -> bool:
    """Check if a contentBlockStart event is for an inline function tool."""
    if not _INLINE_FUNCTION_NAMES:
        return False
    cbs = event.get("contentBlockStart", {})
    start = cbs.get("start", {})
    tool_use = start.get("toolUse") if isinstance(start, dict) else None
    return tool_use is not None and tool_use.get("name") in _INLINE_FUNCTION_NAMES



@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")
    setup_langfuse()  # attach second OTEL exporter once the ADOT provider exists
    metrics = AgentMetrics(context, payload, "workflowagent")

    session_id = getattr(context, 'session_id', 'default-session')
    # This blueprint runs without end-user identity (no JWT authorizer), so there is
    # no stable user id. Never fall back to one shared actor: that would let any
    # caller who knows a session id resume another caller's workflow transcript.
    # Scope the memory actor to the session instead — short-term memory here exists
    # for session durability (microVM recycling), not cross-session recall.
    user_id = getattr(context, 'user_id', None) or f"session-{session_id}"
    _plan_session.set(session_id)  # plan tools operate on this session's plan
    agent = get_or_create_agent(session_id, user_id)

    prompt = _extract_prompt(payload)

    try:
        async for event in agent.stream_async(
            prompt,
        ):
            metrics.record_event(event)
            if not isinstance(event, dict) or "event" not in event:
                continue
            cbs = event["event"].get("contentBlockStart")
            if cbs is not None and not cbs.get("start"):
                continue
            yield event
    except Exception:
        metrics.finish(error=True)
        raise
    else:
        metrics.finish()


if __name__ == "__main__":
    app.run()
