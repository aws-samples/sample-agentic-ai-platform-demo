import os
import logging
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

# TLP-B11 #16: no hardcoded third-party endpoint. An exported repo must not
# make undeclared outbound network calls just because someone ran it locally.
# Point MCP_SERVER_URL at the MCP server your team actually uses; to use a
# server that supports bearer auth, add headers={"Authorization": f"Bearer {access_token}"}.
MCP_ENDPOINT = os.environ.get("MCP_SERVER_URL", "")


def get_streamable_http_mcp_client():
    """Returns an MCP Client compatible with Strands, or None when MCP_SERVER_URL is unset."""
    if not MCP_ENDPOINT:
        logger.warning(
            "MCP client disabled — set MCP_SERVER_URL to enable (no outbound MCP calls will be made)"
        )
        return None
    return MCPClient(lambda: streamablehttp_client(MCP_ENDPOINT))
