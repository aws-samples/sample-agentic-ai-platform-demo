import os
import time
from typing import Any


class AgentMetrics:
    """Best-effort CloudWatch metrics for AgentCore runtime invocations."""

    def __init__(self, context: Any, payload: dict | None = None, blueprint: str = "chatagent"):
        self.enabled = os.getenv("AGENT_METRICS_ENABLED", "true").lower() not in ("0", "false", "no")
        self.namespace = os.getenv("AGENT_METRICS_NAMESPACE", "AgenticPlatform/Agents")
        self.started = time.perf_counter()
        self.first_token_at = None
        self.event_count = 0
        self.tool_invocations = 0
        self.tool_errors = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.total_tokens = 0
        self.dimensions = [
            {"Name": "agent_name", "Value": os.getenv("AGENT_METRICS_AGENT_NAME") or getattr(context, "agent_name", "unknown")},
            {"Name": "agent_runtime_id", "Value": os.getenv("AGENT_METRICS_AGENT_RUNTIME_ID") or getattr(context, "agent_runtime_id", "local")},
            {"Name": "domain", "Value": os.getenv("AGENT_METRICS_DOMAIN", "platform")},
            {"Name": "model_id", "Value": os.getenv("AGENT_METRICS_MODEL_ID") or str((payload or {}).get("model_id") or "unknown")},
            {"Name": "blueprint", "Value": os.getenv("AGENT_METRICS_BLUEPRINT", blueprint)},
        ]

    def record_event(self, event: Any) -> None:
        self.event_count += 1
        text = str(event)
        if self.first_token_at is None and "contentBlockDelta" in text:
            self.first_token_at = time.perf_counter()
        if "toolUse" in text:
            self.tool_invocations += 1
        if "toolResult" in text and "error" in text.lower():
            self.tool_errors += 1
        usage = self._find_usage(event)
        if usage:
            self.input_tokens = max(self.input_tokens, usage.get("input", 0))
            self.output_tokens = max(self.output_tokens, usage.get("output", 0))
            self.total_tokens = max(self.total_tokens, usage.get("total", self.input_tokens + self.output_tokens))

    def finish(self, error: bool = False) -> None:
        if not self.enabled:
            return
        latency_ms = max(0, (time.perf_counter() - self.started) * 1000)
        datapoints = [
            self._metric("agent.invocations", 1, "Count"),
            self._metric("agent.latency", latency_ms, "Milliseconds"),
            self._metric("agent.reasoning.cycles", max(1, self.event_count), "Count"),
        ]
        if self.first_token_at is not None:
            datapoints.append(self._metric("agent.ttft", (self.first_token_at - self.started) * 1000, "Milliseconds"))
        if error:
            datapoints.append(self._metric("agent.errors", 1, "Count"))
        if self.input_tokens:
            datapoints.append(self._metric("agent.tokens.input", self.input_tokens, "Count"))
        if self.output_tokens:
            datapoints.append(self._metric("agent.tokens.output", self.output_tokens, "Count"))
        if self.total_tokens:
            datapoints.append(self._metric("agent.tokens.total", self.total_tokens, "Count"))
        if self.tool_invocations:
            datapoints.append(self._metric("agent.tool.invocations", self.tool_invocations, "Count"))
        if self.tool_errors:
            datapoints.append(self._metric("agent.tool.errors", self.tool_errors, "Count"))
        self._put(datapoints)

    def _metric(self, name: str, value: float, unit: str) -> dict:
        return {
            "MetricName": name,
            "Dimensions": self.dimensions,
            "Value": float(value),
            "Unit": unit,
        }

    def _put(self, datapoints: list[dict]) -> None:
        try:
            import botocore.session

            session = botocore.session.get_session()
            client = session.create_client("cloudwatch", region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"))
            for i in range(0, len(datapoints), 20):
                client.put_metric_data(Namespace=self.namespace, MetricData=datapoints[i:i + 20])
        except Exception:
            pass

    def _find_usage(self, obj: Any) -> dict | None:
        if isinstance(obj, dict):
            usage = obj.get("usage") or obj.get("tokenUsage") or obj.get("metrics")
            if isinstance(usage, dict):
                input_tokens = usage.get("inputTokens") or usage.get("input_tokens") or usage.get("input")
                output_tokens = usage.get("outputTokens") or usage.get("output_tokens") or usage.get("output")
                total_tokens = usage.get("totalTokens") or usage.get("total_tokens") or usage.get("total")
                if input_tokens or output_tokens or total_tokens:
                    return {"input": int(input_tokens or 0), "output": int(output_tokens or 0), "total": int(total_tokens or 0)}
            for value in obj.values():
                found = self._find_usage(value)
                if found:
                    return found
        if isinstance(obj, list):
            for value in obj:
                found = self._find_usage(value)
                if found:
                    return found
        return None
