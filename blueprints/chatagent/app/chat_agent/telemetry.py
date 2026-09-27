"""Dual observability: add a Langfuse OTLP exporter next to the ADOT/CloudWatch one.

AgentCore Runtime wraps the entrypoint with `opentelemetry-instrument` (ADOT),
which owns the global TracerProvider and exports to CloudWatch. OTEL env vars
only support ONE endpoint, so the second (Langfuse) exporter is attached in
code: we grab the already-configured global provider and add another span
processor. Same spans, two backends.

Credentials are never stored in the repo: the Langfuse keys live in SSM
SecureString parameters (/agentic-platform/langfuse/{public-key,secret-key})
and the deploy step grants the agent's execution role read access. If the
parameters or the permission are absent, we log once and stay CloudWatch-only.
"""

import base64
import logging
import os

logger = logging.getLogger(__name__)

_SSM_PREFIX = os.getenv("LANGFUSE_SSM_PREFIX", "/agentic-platform/langfuse")
_HOST = os.getenv("LANGFUSE_HOST", "https://us.cloud.langfuse.com")

_done = False


def _read_keys():
    import boto3
    ssm = boto3.client("ssm", region_name=os.getenv("AWS_REGION", "us-west-2"))
    resp = ssm.get_parameters(
        Names=[f"{_SSM_PREFIX}/public-key", f"{_SSM_PREFIX}/secret-key"],
        WithDecryption=True,
    )
    values = {p["Name"].rsplit("/", 1)[-1]: p["Value"] for p in resp["Parameters"]}
    if "public-key" not in values or "secret-key" not in values:
        raise KeyError(f"missing Langfuse params under {_SSM_PREFIX}")
    return values["public-key"], values["secret-key"]


def _real_provider():
    """Unwrap the global tracer provider to the SDK one (or None).

    Under `opentelemetry-instrument` the global is normally the real SDK
    provider by the time app code imports; guard against the proxy anyway.
    """
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider

    provider = trace.get_tracer_provider()
    inner = getattr(provider, "_real_tracer_provider", provider)
    return inner if isinstance(inner, SDKTracerProvider) else None


def setup_langfuse() -> bool:
    """Attach a Langfuse span processor to the global provider. Idempotent.

    Returns True when attached (now or previously). Never raises — a missing
    key/permission must not break the agent, it just means single-backend
    observability.
    """
    global _done
    if _done:
        return True
    try:
        provider = _real_provider()
        if provider is None:
            logger.info("langfuse: tracer provider not ready yet; will retry on first invoke")
            return False

        public_key, secret_key = _read_keys()
        auth = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()

        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        exporter = OTLPSpanExporter(
            endpoint=f"{_HOST}/api/public/otel/v1/traces",
            headers={"Authorization": f"Basic {auth}"},
        )
        # Short delay + small batches: AgentCore freezes the microVM between
        # invocations, so spans must flush while the response is still streaming.
        provider.add_span_processor(
            BatchSpanProcessor(exporter, schedule_delay_millis=1000, max_export_batch_size=64)
        )
        _done = True
        logger.info("langfuse: second OTEL exporter attached (%s)", _HOST)
        return True
    except Exception as e:  # fail-open by design: observability must never take the agent down
        logger.warning("langfuse: not attached (%s: %s) — CloudWatch-only", type(e).__name__, e)
        _done = True  # don't retry forever on a hard failure (missing perms won't heal mid-life)
        return False
