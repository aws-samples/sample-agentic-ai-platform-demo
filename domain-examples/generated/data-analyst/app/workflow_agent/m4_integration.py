"""M4 integration helpers for the AgentCore Runtime entrypoint.

M3 took the analyst id from the request payload under SigV4/IAM auth. M4 adds a
Cognito JWT authorizer in front of the runtime, so the analyst id comes from a
verified token claim instead of a client-supplied field. This module holds the
two M4 hooks the runtime needs, kept separate from main.py so the M3 path stays
untouched and the workshop can show the M4 diff cleanly:

  1. analyst_id_from_jwt(context, payload): derive the analyst from the verified
     JWT 'username'/'cognito:username' claim, falling back to the payload only
     when no token is present (local dev / M3 compatibility).

  2. AnalystMemoryBridge: load this analyst's preferences and facts before a
     turn and persist the turn afterward, scoped to the analyst's own namespace.

Both hooks degrade gracefully: if memory_config.json is absent or the token is
missing, the runtime still answers (it just skips the memory recall / JWT
identity), so a partial M4 deploy never breaks the agent.
"""

from __future__ import annotations

import base64
import binascii
import json
from pathlib import Path
from typing import Any

RUNTIME_DIR = Path(__file__).resolve().parent
MEMORY_CONFIG_PATH = RUNTIME_DIR / "memory" / "memory_config.json"

_CLAIM_KEYS = ("username", "cognito:username", "sub")


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """Decode a JWT payload segment without verifying the signature.

    The AgentCore JWT authorizer has already verified the token before the
    request reaches the entrypoint, so this only reads claims. Never use this
    to make a trust decision on an unverified token.
    """
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    segment = parts[1]
    segment += "=" * (-len(segment) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(segment).decode("utf-8"))
    except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError):
        return {}


def analyst_id_from_jwt(token: str | None, payload: dict[str, Any], default: str) -> tuple[str, str]:
    """Return (analyst_id, identity_source).

    Prefers a verified JWT claim. Falls back to the payload analyst field (M3
    behaviour) when no token is present, then to the default.
    """
    if token:
        # Module 4 blank, completed: the AgentCore JWT authorizer has already
        # verified the token, so reading its claims is safe here. Leaving this
        # as {} silently collapses every caller onto the payload/default
        # identity — tests/test_m4_identity_isolation.py guards against that.
        claims = _decode_jwt_claims(token)
        for key in _CLAIM_KEYS:
            value = claims.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip().lower(), "cognito_jwt"
    payload_value = payload.get("analyst_id") or payload.get("analyst")
    if isinstance(payload_value, str) and payload_value.strip():
        return payload_value.strip().lower(), "payload"
    return default, "default"


class AnalystMemoryBridge:
    """Per-analyst memory recall and persistence for one runtime turn.

    Loads lazily so a runtime without bedrock_agentcore memory deps or without
    memory_config.json still imports and runs. All reads and writes are pinned
    to the analyst's own namespace; there is no cross-analyst path.
    """

    def __init__(self, analyst_id: str, *, config_path: Path | None = None) -> None:
        self.analyst_id = analyst_id
        self.enabled = False
        self._memory = None
        path = config_path or MEMORY_CONFIG_PATH
        if not path.exists():
            return
        try:
            # Import here so the module loads even when the dep is missing.
            import sys

            repo_root = RUNTIME_DIR
            if str(repo_root) not in sys.path:
                sys.path.insert(0, str(repo_root))
            from memory.memory_client import AnalystMemory

            self._memory = AnalystMemory(analyst_id, config_path=path)
            self.enabled = True
        except Exception:  # noqa: BLE001 - memory is best-effort context
            self.enabled = False
            self._memory = None

    def recall(self, question: str, *, top_k: int = 3) -> dict[str, list[dict[str, Any]]]:
        if not self.enabled or self._memory is None:
            return {"preferences": [], "facts": []}
        try:
            return {
                "preferences": self._memory.retrieve_preferences(question, top_k=top_k),
                "facts": self._memory.retrieve_facts(question, top_k=top_k),
            }
        except Exception:  # noqa: BLE001
            return {"preferences": [], "facts": []}

    def remember(self, question: str, answer: str, *, session: str = "runtime") -> bool:
        if not self.enabled or self._memory is None:
            return False
        try:
            self._memory.save_fact(question, answer, session=session)
            return True
        except Exception:  # noqa: BLE001
            return False

    @staticmethod
    def format_recall(recall: dict[str, list[dict[str, Any]]]) -> str:
        """Turn recalled records into a short instruction block for the agent."""
        lines: list[str] = []
        for record in recall.get("preferences", []):
            text = _record_text(record)
            if text:
                lines.append(f"- preference: {text}")
        for record in recall.get("facts", []):
            text = _record_text(record)
            if text:
                lines.append(f"- known fact: {text}")
        if not lines:
            return ""
        return "Relevant memory for this analyst (use as context, never override computed numbers):\n" + "\n".join(lines)


def _record_text(record: dict[str, Any]) -> str:
    content = record.get("content")
    if isinstance(content, dict):
        return str(content.get("text") or "").strip()
    if isinstance(content, str):
        return content.strip()
    return str(record.get("text") or "").strip()
