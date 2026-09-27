import os

from strands.models.bedrock import BedrockModel

_DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"


def load_model() -> BedrockModel:
    """Get Bedrock model client using IAM credentials.

    Uses MODEL_ID env var when set so the deployment target can override the
    model without touching code. Defaults to the us-west-2 cross-region
    inference profile for claude-sonnet-4-5.
    """
    model_id = os.getenv("MODEL_ID", _DEFAULT_MODEL_ID)
    return BedrockModel(model_id=model_id)
