# demo-env.sh — source this to flip the console into real-AWS mode.
#   OBS_BACKEND=cloudwatch   observability view queries live CloudWatch/AgentCore instead of the mock backend (server.mjs)
#   REGISTRY_BACKEND=aws     AI Registry uses the real AWS Agent Registry when console/registry-config.json is present (server falls back to the local JSON store otherwise)
#   unset PLATO_FIXTURE      chat invocations hit the real Bedrock runtime instead of replaying the recorded fixture (plato.mjs)
#   unset LANGFUSE_FIXTURE   Langfuse traces come from the live API (keys read from SSM) instead of a recorded response
#   MODEL_SOURCE             not exported: default is already "gateway" when console/gateway-config.json exists (gateway-models.mjs)
#   LANGFUSE_SSM_PREFIX      this account stores the Langfuse keys under /openclaw/langfuse (server default is /agentic-platform/langfuse)
export OBS_BACKEND=cloudwatch
export REGISTRY_BACKEND=aws
export LANGFUSE_SSM_PREFIX=/openclaw/langfuse
unset PLATO_FIXTURE LANGFUSE_FIXTURE
