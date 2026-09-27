// J-T-B11: FULL-preset TDD starter tests — Foundation Harness identity/memory/
// multi-turn. Generated alongside app/chat_agent code by export-composer.mjs's
// tddApp section. Zero AWS dependencies; run by gates/run-tests.mjs (pytest
// auto-detection) so a FULL export is never a zero-test baseline.
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The generated app's code directory (agentcore.json runtimes[0].codeLocation,
// e.g. "app/chat_agent"). tddApp writes tests under <codeLocation>/tests/, next
// to the app package the tests import from. Absent when there is no project
// dir (Plato/inception exports never take the FULL preset) or no agentcore.json.
export function codeLocationFor(ctx) {
  if (!ctx.dir) return null
  try {
    const cfg = JSON.parse(readFileSync(join(ctx.dir, "agentcore", "agentcore.json"), "utf8"))
    const loc = (cfg.runtimes || [])[0]?.codeLocation
    return loc ? loc.replace(/\/$/, "") : null
  } catch { return null }
}

// test_identity.py — Foundation Harness identity headers. Constructs the
// X-Amzn-Bedrock-AgentCore-Runtime-Custom-user-* headers exactly as the
// runtime delivers them (identity/profile.py) and asserts correct parsing,
// plus the anonymous fallback when no headers are present at all.
export function testIdentityPy() {
  return `"""Foundation Harness identity — unit tests, zero AWS dependencies.

Constructs the runtime headers AgentCore delivers after the CUSTOM_JWT
authorizer resolves the caller (see identity/profile.py for the contract),
and checks profile_from_context() parses them, plus the anonymous fallback.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from identity.profile import profile_from_context  # noqa: E402


class _Ctx:
    def __init__(self, headers):
        self.request_headers = headers


def test_parses_custom_user_headers():
    ctx = _Ctx({
        "x-amzn-bedrock-agentcore-runtime-custom-user-id": "user-123",
        "x-amzn-bedrock-agentcore-runtime-custom-user-name": "Ada Lovelace",
        "x-amzn-bedrock-agentcore-runtime-custom-user-email": "ada@example.com",
    })
    profile = profile_from_context(ctx)
    assert profile.user_id == "user-123"
    assert profile.name == "Ada Lovelace"
    assert profile.email == "ada@example.com"


def test_anonymous_fallback_with_no_headers():
    ctx = _Ctx({})
    profile = profile_from_context(ctx)
    assert profile.user_id == "anonymous"
    assert profile.name == ""
    assert profile.email == ""
`
}

// test_memory_local.py — memory local fallback (companion to the #6 warning
// added to memory/session.py): asserts get_memory_session_manager() returns
// None when no MEMORY_*_ID env var is set, and that it logs a warning rather
// than silently no-op'ing.
export function testMemoryLocalPy() {
  return `"""Foundation Harness memory — local-fallback unit test, zero AWS dependencies.

Without a MEMORY_*_ID env var (i.e. before the project is deployed, or a
local dev run), get_memory_session_manager() must return None — and must
warn, not silently no-op (see memory/session.py).
"""
import importlib
import logging
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))


def test_no_memory_id_returns_none_and_warns(monkeypatch, caplog):
    for key in list(os.environ):
        if key.startswith("MEMORY_") and key.endswith("_ID"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("AGENTCORE_MEMORY_ID", raising=False)

    import memory.session as session_mod
    importlib.reload(session_mod)  # MEMORY_ID is resolved at import time

    with caplog.at_level(logging.WARNING):
        result = session_mod.get_memory_session_manager("session-1", "actor-1")

    assert result is None
    assert any("memory" in rec.message.lower() and "disabled" in rec.message.lower() for rec in caplog.records), (
        "expected a warning that memory is disabled when no MEMORY_*_ID is set — "
        "silent no-op was the bug this test guards against"
    )
`
}

// test_multiturn.py — structural check that the agent factory wires
// SlidingWindowConversationManager (not NullConversationManager, which drops
// the memory session manager's injected <context> block — see main.py's
// comment on _make_conversation_manager). This is a static/structural check,
// not a live multi-turn conversation (that needs a running runtime; see
// CLAUDE.md "Testing multi-turn locally" for the curl-based version).
export function testMultiturnPy() {
  return `"""Foundation Harness multi-turn — structural unit test, zero AWS dependencies.

Asserts the agent is built with SlidingWindowConversationManager, which
preserves the memory session manager's injected <context> block across turns
in the same session. NullConversationManager would silently drop it — that
regression is what this test guards against. (Live multi-turn behavior is
verified locally with two curl calls sharing a session id — see CLAUDE.md.)
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))


def test_conversation_manager_is_sliding_window():
    from strands.agent.conversation_manager.sliding_window_conversation_manager import (
        SlidingWindowConversationManager,
    )
    import main

    mgr = main._make_conversation_manager()
    assert isinstance(mgr, SlidingWindowConversationManager), (
        "expected SlidingWindowConversationManager — NullConversationManager drops "
        "the memory session manager's injected context across turns"
    )


def test_same_session_reuses_cached_agent():
    import main
    from identity.profile import UserProfile

    profile = UserProfile(user_id="actor-1", name="Test User", email="")
    agent_a = main.get_or_create_agent("session-1", profile)
    agent_b = main.get_or_create_agent("session-1", profile)
    assert agent_a is agent_b, "same session_id + actor_id must reuse the cached agent (preserves in-memory state)"
`
}
