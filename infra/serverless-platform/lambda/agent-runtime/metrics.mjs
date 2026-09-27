const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const INPUT_KEYS = new Set([
  "domainId",
  "projectId",
  "succeeded",
  "latencyMs",
  "inputTokens",
  "outputTokens",
]);
const METRICS = Object.freeze([
  Object.freeze({ Name: "RuntimeCount", Unit: "Count" }),
  Object.freeze({ Name: "HealthyRuntimeCount", Unit: "Count" }),
  Object.freeze({ Name: "InvocationCount", Unit: "Count" }),
  Object.freeze({ Name: "ErrorCount", Unit: "Count" }),
  Object.freeze({ Name: "Latency", Unit: "Milliseconds" }),
  Object.freeze({ Name: "InputTokens", Unit: "Count" }),
  Object.freeze({ Name: "OutputTokens", Unit: "Count" }),
]);

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function exactInput(value) {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== INPUT_KEYS.size
    || keys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))
  ) {
    return null;
  }
  const result = {};
  for (const key of INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function metricRecord({
  namespace,
  timestamp,
  dimensions,
  values,
}) {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: [dimensions],
        Metrics: METRICS.filter(({ Name }) =>
          (Name !== "InputTokens" || values.inputTokens !== null)
          && (Name !== "OutputTokens" || values.outputTokens !== null)),
      }],
    },
    ScopeType: values.scopeType,
    ...(values.domainId === null
      ? {}
      : { DomainId: values.domainId }),
    ...(values.projectId === null
      ? {}
      : { ProjectId: values.projectId }),
    RuntimeCount: 1,
    HealthyRuntimeCount: values.succeeded ? 1 : 0,
    InvocationCount: 1,
    ErrorCount: values.succeeded ? 0 : 1,
    Latency: values.latencyMs,
    ...(values.inputTokens === null ? {} : { InputTokens: values.inputTokens }),
    ...(values.outputTokens === null ? {} : { OutputTokens: values.outputTokens }),
  };
}

function timestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new Error("Agent Runtime metrics clock is invalid.");
  }
  const date = value instanceof Date ? value : new Date(value);
  const result = date.getTime();
  if (!Number.isFinite(result) || result < 0) {
    throw new Error("Agent Runtime metrics clock is invalid.");
  }
  return result;
}

export function createAgentRuntimeMetrics({
  write,
  clock,
  namespace = "bedrock-agentcore",
} = {}) {
  if (
    typeof write !== "function"
    || typeof clock !== "function"
    || typeof namespace !== "string"
    || !NAMESPACE_PATTERN.test(namespace)
  ) {
    throw new TypeError("Agent Runtime metrics configuration is invalid.");
  }

  return Object.freeze({
    recordInvocation(value) {
      const input = exactInput(value);
      if (
        input === null
        || !DOMAIN_ID_PATTERN.test(input.domainId)
        || !PROJECT_ID_PATTERN.test(input.projectId)
        || typeof input.succeeded !== "boolean"
        || typeof input.latencyMs !== "number"
        || !Number.isFinite(input.latencyMs)
        || input.latencyMs < 0
        || (input.inputTokens !== null
          && (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0))
        || (input.outputTokens !== null
          && (!Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0))
      ) {
        throw new TypeError("Agent Runtime metrics input is invalid.");
      }
      const currentTimestamp = timestamp(clock);
      const scopes = [
        {
          dimensions: ["ScopeType"],
          values: {
            ...input,
            scopeType: "platform",
            domainId: null,
            projectId: null,
          },
        },
        {
          dimensions: ["ScopeType", "DomainId"],
          values: {
            ...input,
            scopeType: "domain",
            projectId: null,
          },
        },
        {
          dimensions: ["ScopeType", "DomainId", "ProjectId"],
          values: {
            ...input,
            scopeType: "project",
          },
        },
      ];
      for (const scope of scopes) {
        write(JSON.stringify(metricRecord({
          namespace,
          timestamp: currentTimestamp,
          ...scope,
        })));
      }
    },
  });
}
