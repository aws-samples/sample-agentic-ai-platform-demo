import logging
import os
import uuid
from typing import Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

log = logging.getLogger(__name__)

MEMORY_ID = os.getenv("MEMORY_WORKFLOW_AGENTMEMORY_ID")
REGION = os.getenv("AWS_REGION")

def get_memory_session_manager(session_id: Optional[str], actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    if not MEMORY_ID:
        log.warning("AgentCore memory disabled — no MEMORY_*_ID env var (deploy first or set manually)")
        return None

    # AgentCoreMemoryConfig rejects None; OAuth/CUSTOM_JWT callers can reach us
    # without a runtime session header, so synthesize one when absent.
    session_id = session_id or uuid.uuid4().hex


    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
        ),
        REGION
    )

