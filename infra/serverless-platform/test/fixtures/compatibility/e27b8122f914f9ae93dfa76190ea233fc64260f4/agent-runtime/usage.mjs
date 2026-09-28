const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableCount = value => value === null || count(value);
const id = value => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value);

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property?.enumerable === true && Object.hasOwn(property, "value");
    });
}

export function validUsage(value) {
  return exact(value, ["inputTokens", "outputTokens", "totalTokens"])
    && count(value.inputTokens) && count(value.outputTokens)
    && count(value.totalTokens)
    && value.totalTokens === value.inputTokens + value.outputTokens;
}

const METERING_KEYS = [
  "version", "source", "modelId", "inputTokenBasis",
  "cacheReadInputTokens", "cacheWriteInputTokens",
  "cacheWrite5mInputTokens", "cacheWrite1hInputTokens",
];

export function validMetering(value) {
  return exact(value, METERING_KEYS)
    && value.version === 1 && value.source === "provider"
    && (value.modelId === null || id(value.modelId))
    && ["uncached", "includes-cache"].includes(value.inputTokenBasis)
    && METERING_KEYS.slice(4).every(key => nullableCount(value[key]))
    && (value.cacheWriteInputTokens === null
      || value.cacheWrite5mInputTokens === null || value.cacheWrite1hInputTokens === null
      || value.cacheWriteInputTokens === value.cacheWrite5mInputTokens + value.cacheWrite1hInputTokens);
}

// Missing cache counters are unknown, including on providers that omit them.
// Only copy bounded usage metadata; never persist arbitrary response content.
export function gatewayMetering(payload, protocol) {
  const anthropic = protocol === "anthropic";
  const usage = payload.usage;
  const value = {
    version: 1,
    source: "provider",
    modelId: payload.model ?? null,
    inputTokenBasis: anthropic ? "uncached" : "includes-cache",
    cacheReadInputTokens: (anthropic
      ? usage.cache_read_input_tokens
      : usage.prompt_tokens_details?.cached_tokens) ?? null,
    cacheWriteInputTokens: anthropic ? usage.cache_creation_input_tokens ?? null : null,
    cacheWrite5mInputTokens: anthropic ? usage.cache_creation?.ephemeral_5m_input_tokens ?? null : null,
    cacheWrite1hInputTokens: anthropic ? usage.cache_creation?.ephemeral_1h_input_tokens ?? null : null,
  };
  if (!validMetering(value)
    || (!anthropic && value.cacheReadInputTokens !== null
      && value.cacheReadInputTokens > usage.prompt_tokens)) {
    throw new Error("Provider metering is invalid.");
  }
  return value;
}

export function validExecution(value) {
  const instant = timestamp => typeof timestamp === "string"
    && Number.isFinite(Date.parse(timestamp))
    && new Date(timestamp).toISOString() === timestamp;
  return exact(value, ["startedAt", "completedAt"])
    && instant(value.startedAt) && instant(value.completedAt)
    && Date.parse(value.startedAt) <= Date.parse(value.completedAt);
}

export function validAccounting(value) {
  return exact(value, [
    "version", "runId", "attemptId", "environment", "purpose", "modelId",
    "providerRequestId", "traceId", "usage", "metering", "execution",
    "pricingVersion", "estimatedCostUsd",
  ])
    && value.version === 1 && typeof value.runId === "string"
    && /^[a-f0-9]{64}$/.test(value.runId)
    && value.attemptId === "gateway-1"
    && value.environment === "PRODUCTION" && value.purpose === "user"
    && id(value.modelId)
    && (value.providerRequestId === null || id(value.providerRequestId))
    && (value.traceId === null || id(value.traceId))
    && validUsage(value.usage)
    && (value.metering === null || validMetering(value.metering))
    && (value.execution === null || validExecution(value.execution))
    && value.pricingVersion === null && value.estimatedCostUsd === null;
}
