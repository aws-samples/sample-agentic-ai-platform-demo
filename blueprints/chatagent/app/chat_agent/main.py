from pathlib import Path
from typing import Any
from collections import OrderedDict
from strands import Agent, tool
import asyncio
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from strands.vended_plugins.skills import AgentSkills
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
from mcp_client.client import get_streamable_http_mcp_client
from memory.session import get_memory_session_manager
from identity.profile import profile_from_context, personalize
from telemetry import setup_langfuse
from metrics import AgentMetrics

app = BedrockAgentCoreApp()
log = app.logger

# Define a Streamable HTTP MCP Client
mcp_clients = [get_streamable_http_mcp_client()]

# Three-tier prompt (Hermes/OpenClaw pattern): this STABLE tier never changes
# mid-session (provider prompt caching stays warm). Session context (who the user
# is) is appended by _build_system_prompt; recalled memories arrive per-turn via
# the memory session manager.
#
# The agent's instructions live in an EDITABLE runtime file — instructions.md next
# to this module — NOT hardcoded here and NOT in AGENTS.md (AGENTS.md is guidance
# for the coding assistant, a different audience). A domain team edits
# instructions.md and redeploys to change the agent's behavior without touching
# code. The console writes this file when composing an agent. If it's missing we
# fall back to a safe built-in default.
_FALLBACK_PROMPT = """
# Role
You are a helpful assistant.

# How you work
- Prefer tools over guessing: answer from real data, and say which tool you used when it matters.
- When a platform skill matches the task, activate it (via the skills tool) and briefly say so, then follow its instructions.
- For multi-step requests, state your plan in one line before executing, then work through it step by step.

# Boundaries
- If you don't know something or a tool fails, say so plainly. Never invent data, IDs, or policy.
- Before finishing, check you actually answered what was asked — every part of it.
"""


def _load_instructions() -> str:
    """Load the editable runtime system prompt (instructions.md), else fallback."""
    f = Path(__file__).parent / "instructions.md"
    try:
        text = f.read_text().strip()
        if text:
            return text
    except FileNotFoundError:
        pass
    return _FALLBACK_PROMPT.strip()


DEFAULT_SYSTEM_PROMPT = _load_instructions()


# Define a collection of tools used by the model
tools = []

_INLINE_FUNCTION_NAMES = set()

# Define a simple function tool
@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a+b
tools.append(add_numbers)



# Add MCP client to tools if available
for mcp_client in mcp_clients:
    if mcp_client:
        tools.append(mcp_client)


def _discover_skills() -> list:
    """Find bundled Agent Skills (agentskills.io format: skills/<name>/SKILL.md).

    Skills load via progressive disclosure — only name+description go into the
    system prompt; the agent activates a skill's full instructions on demand via
    the plugin's `skills` tool. This keeps the prompt small no matter how many
    skills the platform catalog attaches.
    """
    skills_dir = Path(__file__).parent / "skills"
    return sorted(str(d) for d in skills_dir.iterdir()
                  if d.is_dir() and (d / "SKILL.md").exists()) if skills_dir.exists() else []


_skill_paths = _discover_skills()
plugins = [AgentSkills(skills=_skill_paths)] if _skill_paths else []


def _make_conversation_manager():
    # The AgentCore memory session manager injects retrieved long-term memory as a
    # <context> block into the current turn's messages. NullConversationManager can
    # drop that injected context; the sliding-window manager preserves it so the
    # model actually sees recalled facts across sessions.
    from strands.agent.conversation_manager.sliding_window_conversation_manager import (
        SlidingWindowConversationManager,
    )
    return SlidingWindowConversationManager(window_size=40)

def _build_system_prompt(profile) -> str:
    # Identity personalization lives in the identity module (Foundation Harness).
    return personalize(DEFAULT_SYSTEM_PROMPT, profile)


def agent_factory():
    cache = {}
    def get_or_create_agent(session_id, profile):
        _actor_id = profile.user_id
        key = f"{session_id}/{_actor_id}"
        if key not in cache:
            cache[key] = Agent(
                model=load_model(),
                session_manager=get_memory_session_manager(session_id, _actor_id),
                conversation_manager=_make_conversation_manager(),
                system_prompt=_build_system_prompt(profile),
                tools=tools,
                plugins=plugins,
                # Langfuse maps session.id / user.id straight onto its trace model,
                # so per-user and per-session filtering works in both backends.
                trace_attributes={
                    "session.id": session_id,
                    "user.id": _actor_id,
                    "langfuse.tags": ["agentcore", "foundation-harness"],
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
    metrics = AgentMetrics(context, payload, "chatagent")

    session_id = getattr(context, 'session_id', 'default-session')
    profile = profile_from_context(context)  # identity module (Foundation Harness)
    log.info("resolved actor_id=%s name=%s session_id=%s", profile.user_id, profile.name, session_id)
    agent = get_or_create_agent(session_id, profile)

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
