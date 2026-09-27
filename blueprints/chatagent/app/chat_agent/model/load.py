import os
from strands.models.bedrock import BedrockModel


def platform_model_controls():
    guardrail = os.environ.get("PLATFORM_GUARDRAIL_ID")
    version = os.environ.get("PLATFORM_GUARDRAIL_VERSION")
    if bool(guardrail) != bool(version):
        raise ValueError("Platform guardrail ID and version must be configured together")
    return {"guardrail_id": guardrail, "guardrail_version": version} if guardrail else {}


def load_model() -> BedrockModel:
    """Get Bedrock model client using IAM credentials."""
    controls = platform_model_controls()
    return BedrockModel(model_id="global.anthropic.claude-sonnet-5", **controls)
