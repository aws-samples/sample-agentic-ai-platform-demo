import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validUsage } from "../agent-runtime/usage.mjs";
import { converseRequestBinding, validConverseRuntime } from "../agent-runtime/bedrock-inference.mjs";

// Public AWS evidence verified on 2026-09-11. This is a validation allowlist,
// not an activated price book. See docs/bedrock-runtime-pricing.md.
const SOURCE = {
  "url": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-west-2/index.json",
  "retrievedAt": "2026-09-11T02:57:42.490Z"
};
const PROVENANCE = {
  "catalogVersion": "20260901183649",
  "publicationDate": "2026-09-01T18:36:49.000Z",
  "termEffectiveDate": "2026-08-01T00:00:00.000Z",
  "catalogSha256": "2408c8b69b89853fa215e33385c51d6f0f6aae57256da59d56cfb70e97dc7536",
  "unit": "1M tokens",
  "rateCodes": {
    "input": "4JSTB8J9NP4VP73F.4799GE89SK.6YS6EN2CT7",
    "output": "JRZBRVPV4WU854WK.4799GE89SK.6YS6EN2CT7",
    "cacheRead": "JWC87WDBUGJS96NF.4799GE89SK.6YS6EN2CT7",
    "cacheWrite5m": "73F7XT6NJRHUGT6P.4799GE89SK.6YS6EN2CT7",
    "cacheWrite1h": "68HWT9R4XYRCD8UE.4799GE89SK.6YS6EN2CT7"
  },
  "cacheTtlSource": {
    "url": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json",
    "manifest": "plc-bedrockfoundationmodels-usd-20260901183649",
    "sha256": "8a44f70a6dc69e1543eb7f2eecc0077577615abd36c69c1b3e78c67b1b150e87"
  },
  "profileMetadataSha256": "c30ee7430bf614737f7ac05b7bfd06b5d1edda229ff2ea1df5d21453612c728d",
  "usageDocumentation": {
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html",
    "sha256": "6611ac3dec8da66c1e66994d1e9342faaa5621b765fb494275d580e21d5798e1"
  },
  "modelDocumentation": {
    "url": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html",
    "sha256": "059fdce9c98fba91723fa86a03275cfdb9dc63c72048322da03d94745d35a92e"
  }
};
const RATES = {
  "input": 1,
  "output": 5,
  "cacheRead": 0.1,
  "cacheWrite5m": 1.25,
  "cacheWrite1h": 2
};
const TARGET = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable === true && Object.hasOwn(property, "value");
  });
const entryKeys = ["id", "activation", "inputTokenBasis", "currency", "effectiveFrom", "effectiveTo",
  "region", "requestModelId", "request", "source", "provenance", "usdPerMillionTokens"];

function validEntry(entry) {
  return exact(entry, entryKeys)
    && typeof entry.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(entry.id)
    && ["candidate", "active"].includes(entry.activation)
    && entry.inputTokenBasis === "uncached" && entry.currency === "USD"
    && entry.region === "us-west-2" && entry.requestModelId === TARGET
    && ["bedrock-claude/anthropic.claude-haiku-4-5", TARGET].includes(entry.request?.modelId)
    && isDeepStrictEqual(entry.request, converseRequestBinding(entry.request.modelId))
    && isDeepStrictEqual(entry.source, SOURCE) && isDeepStrictEqual(entry.provenance, PROVENANCE)
    && instant(entry.effectiveFrom) && instant(entry.effectiveTo)
    && SOURCE.retrievedAt <= entry.effectiveFrom && entry.effectiveFrom < entry.effectiveTo
    && exact(entry.usdPerMillionTokens, Object.keys(RATES))
    && Object.keys(RATES).every(key => entry.usdPerMillionTokens[key] === null
      || entry.usdPerMillionTokens[key] === RATES[key]);
}

export function unpricedDirectUsage(reason = "direct-prices-unconfigured") {
  return { estimatedCostUsd: null, pricingVersion: null, priceSource: null,
    settlement: { reason, entry: null, quantities: null } };
}

function matches(entry, observation, occurredAt) {
  const runtime = observation?.runtime;
  return observation?.protocol === "bedrock-converse-v2" && observation.metering === null
    && validUsage(observation.usage) && validConverseRuntime(runtime, observation.protocol)
    && (runtime.providerTotalTokens === observation.usage.totalTokens
      || (runtime.cacheReadInputTokens !== null && runtime.cacheWriteInputTokens !== null
        && runtime.providerTotalTokens === observation.usage.totalTokens
          + runtime.cacheReadInputTokens + runtime.cacheWriteInputTokens))
    && entry.activation === "active" && instant(occurredAt)
    && entry.effectiveFrom <= occurredAt && occurredAt < entry.effectiveTo
    && entry.region === runtime.region && entry.requestModelId === runtime.requestModelId
    && entry.inputTokenBasis === runtime.inputTokenBasis
    && isDeepStrictEqual(entry.request, runtime.request)
    && [null, entry.request.serviceTier].includes(runtime.response.serviceTier)
    && [null, entry.request.performanceLatency].includes(runtime.response.performanceLatency);
}

function settle(entry, observation) {
  const runtime = observation.runtime;
  const result = { estimatedCostUsd: null, pricingVersion: entry.id, priceSource: {
    id: entry.id, ...entry.source, effectiveFrom: entry.effectiveFrom, effectiveTo: entry.effectiveTo,
  }, settlement: { reason: "incomplete-usage", entry: structuredClone(entry), quantities: null } };
  // No cache checkpoints does not establish zero: Haiku supports implicit
  // caching. AWS Converse inputTokens excludes BOTH read and write tokens.
  if (runtime.cacheReadInputTokens === null || runtime.cacheWriteInputTokens === null
    || (runtime.cacheWriteInputTokens > 0 && runtime.cacheDetails === null)) return result;
  const quantities = {
    input: observation.usage.inputTokens, output: observation.usage.outputTokens,
    cacheRead: runtime.cacheReadInputTokens,
    cacheWrite5m: runtime.cacheDetails?.find(item => item.ttl === "5m")?.inputTokens ?? 0,
    cacheWrite1h: runtime.cacheDetails?.find(item => item.ttl === "1h")?.inputTokens ?? 0,
  };
  // The validator requires a complete, exact TTL partition when supplied.
  // Output is the provider counter, including billed reasoning, not text size.
  result.settlement.quantities = quantities;
  let total = 0;
  for (const key of Object.keys(RATES)) {
    if (quantities[key] === 0) continue;
    if (entry.usdPerMillionTokens[key] === null) {
      result.settlement.reason = "missing-rate";
      return result;
    }
    total += quantities[key] * entry.usdPerMillionTokens[key];
  }
  result.estimatedCostUsd = total / 1_000_000;
  result.settlement.reason = "priced";
  return result;
}

export function createDirectRuntimePriceBook(configuration) {
  if (!exact(configuration, ["version", "entries"]) || configuration.version !== 3
    || !Array.isArray(configuration.entries) || configuration.entries.length > 500
    || !configuration.entries.every(validEntry)) throw new TypeError("Model price book is invalid.");
  const entries = structuredClone(configuration.entries);
  entries.forEach((entry, index) => {
    if (entries.slice(0, index).some(other => other.id === entry.id
      || (entry.request.modelId === other.request.modelId && entry.effectiveFrom < other.effectiveTo
        && other.effectiveFrom < entry.effectiveTo))) throw new TypeError("Model price book is invalid.");
  });
  return Object.freeze({
    fingerprint: createHash("sha256").update(JSON.stringify({ version: 3, entries })).digest("hex"),
    estimateUsage(observation, route, occurredAt) {
      if (observation?.protocol !== "bedrock-converse-v2") {
        return { estimatedCostUsd: null, pricingVersion: null, priceSource: null };
      }
      const entry = route === null && entries.find(rate => matches(rate, observation, occurredAt));
      return entry ? settle(entry, observation) : unpricedDirectUsage("no-applicable-direct-rate");
    },
    // A direct book cannot price legacy invocation/Gateway accounting.
    estimate() { return { estimatedCostUsd: null, pricingVersion: null, priceSource: null }; },
  });
}

// Replay verifies the sealed rate and calculation, never consults today's
// configuration. New catalog revisions must retain this validator for old rows.
export function validDirectPrice(price, observation, occurredAt) {
  if (!exact(price, ["estimatedCostUsd", "pricingVersion", "priceSource", "pricingRevision", "settlement"])
    || !/^[a-f0-9]{64}$/.test(price.pricingRevision)
    || !exact(price.settlement, ["reason", "entry", "quantities"])) return false;
  const { pricingRevision, ...recorded } = price;
  const entry = price.settlement.entry;
  if (entry === null) return ["direct-prices-unconfigured", "no-applicable-direct-rate"].some(reason =>
    isDeepStrictEqual(recorded, unpricedDirectUsage(reason)));
  return validEntry(entry) && matches(entry, observation, occurredAt)
    && isDeepStrictEqual(recorded, settle(entry, observation));
}
