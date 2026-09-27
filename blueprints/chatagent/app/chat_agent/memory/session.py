import logging
import os
import uuid
from typing import Optional
from identity.profile import require_memory_actor

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

log = logging.getLogger(__name__)

def _discover_memory_id() -> Optional[str]:
    """Find the AgentCore Memory id injected by the deploy.

    The CDK injects it as MEMORY_<MEMORYNAME>_ID, where <MEMORYNAME> is derived
    from the memory resource name (uppercased, non-alphanumerics stripped). That
    name changes when a domain team renames the project, so we discover it at
    runtime instead of hardcoding a single variable name (which silently
    disabled memory before).
    """
    explicit = os.getenv("AGENTCORE_MEMORY_ID")
    if explicit:
        return explicit
    for key, value in os.environ.items():
        if key.startswith("MEMORY_") and key.endswith("_ID") and value:
            return value
    return None


MEMORY_ID = _discover_memory_id()
REGION = os.getenv("AWS_REGION")

def get_memory_session_manager(session_id: Optional[str], actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    if not MEMORY_ID:
        log.warning("AgentCore memory disabled — no MEMORY_*_ID env var (deploy first or set manually)")
        return None
    actor_id = require_memory_actor(actor_id)

    # AgentCoreMemoryConfig rejects None; OAuth/CUSTOM_JWT callers can reach us
    # without a runtime session header, so synthesize one when absent.
    session_id = session_id or uuid.uuid4().hex

    # Namespaces must line up with BOTH the strategy templates in agentcore.json and
    # the IAM namespace condition the deploy generates (`/summaries/*/*` = two path
    # segments). Prefix queries end with a trailing "/" so actor "alice" can never
    # prefix-match actor "alice2"'s records — without it, retrieval both leaks across
    # actors and fails the IAM condition (AccessDeniedException on RetrieveMemoryRecords).
    retrieval_config = {
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.2),
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k=3, relevance_score=0.2),
        f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.2),
        f"/summaries/{actor_id}/": RetrievalConfig(top_k=3, relevance_score=0.2),
    }

    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
            retrieval_config=retrieval_config,
        ),
        REGION
    )
