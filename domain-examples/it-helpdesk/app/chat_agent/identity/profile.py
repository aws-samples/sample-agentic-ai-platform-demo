"""Identity — the Foundation Harness's per-user identity layer.

This is one of the platform-owned foundation capabilities (alongside
memory/session.py and telemetry.py). It resolves WHO is calling the agent.

How identity is wired (all platform-owned, locked in agentcore.json):
  1. The runtime enforces a CUSTOM_JWT authorizer (Amazon Cognito). A request
     with no valid token is rejected before this code ever runs.
  2. A trusted front end / gateway forwards the authenticated caller's Cognito
     profile as custom runtime headers (allowlisted in agentcore.json's
     requestHeaderAllowlist): user-id (the Cognito `sub`), user-name, user-email.
  3. AgentCore auto-prefixes bare custom header names and delivers them
     lower-cased, so we match case-insensitively against the prefixed form.

What the profile is used for:
  - user_id (Cognito sub) → the memory actor id, so each user's memory is
    isolated (see memory/session.py).
  - name / email → let the agent greet the user without being told who they are.
"""

from typing import NamedTuple


class UserProfile(NamedTuple):
    user_id: str   # Cognito sub — memory actor id (namespace isolation)
    name: str      # display name — so the agent knows who it's talking to
    email: str


def _header(lower: dict, *names: str, default: str = "") -> str:
    for n in names:
        v = lower.get(n)
        if v:
            return str(v)
    return default


def profile_from_context(context) -> UserProfile:
    """Resolve the authenticated caller's profile from custom runtime headers.

    Falls back gracefully to "anonymous" / empty when a header is absent (e.g.
    a blueprint deployed without the authorizer, or a tokenless local call).
    """
    headers = getattr(context, "request_headers", None) or {}
    lower = {str(k).lower(): v for k, v in headers.items()}
    user_id = _header(
        lower,
        "x-amzn-bedrock-agentcore-runtime-custom-user-id", "user-id",
        default="anonymous",
    )
    name = _header(
        lower,
        "x-amzn-bedrock-agentcore-runtime-custom-user-name", "user-name",
    )
    email = _header(
        lower,
        "x-amzn-bedrock-agentcore-runtime-custom-user-email", "user-email",
    )
    return UserProfile(user_id=user_id, name=name, email=email)


def personalize(base_prompt: str, profile: UserProfile) -> str:
    """Append the caller's identity to the system prompt so the agent can address
    them by name. No-op when we don't know who the user is."""
    if profile.name and profile.name != "anonymous":
        who = f"You are talking to {profile.name}"
        if profile.email:
            who += f" ({profile.email})"
        return f"{base_prompt}\n{who}. Address them by name when it feels natural.\n"
    return base_prompt
