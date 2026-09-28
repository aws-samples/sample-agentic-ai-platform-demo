import { createHash } from "node:crypto";
import { validAccounting } from "../agent-runtime/usage.mjs";

const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value);
const rateKeys = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable === true && Object.hasOwn(property, "value");
  });

function invalid() {
  throw new TypeError("Model price book is invalid.");
}

const routeKeys = ["attestationId", "modelId", "providerModelId", "provider", "gatewayRegion",
  "billingRegion", "inferenceMode", "serviceTier", "cacheMode"];

export function validUsageRoute(value) {
  return exact(value, routeKeys) && routeKeys.every(key => identifier(value[key]))
    && ["bedrock", "anthropic", "openai", "synthetic"].includes(value.provider)
    && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.gatewayRegion)
    && ["global", "regional", "cross-region"].includes(value.inferenceMode)
    && ["standard", "priority", "flex", "batch"].includes(value.serviceTier)
    && value.cacheMode === "explicit-counters";
}

// No default prices. A trusted deployment may inject dated, explicit route,
// provider model, region, cache semantics and effective-interval price entries.
export function createModelPriceBook(configuration = { version: 1, entries: [] }) {
  if (!exact(configuration, ["version", "entries"]) || ![1, 2].includes(configuration.version)
    || !Array.isArray(configuration.entries) || configuration.entries.length > 500) invalid();
  const native = configuration.version === 2;
  const entries = configuration.entries.map(entry => {
    if (!exact(entry, ["id", "modelId", "providerModelId", "region", "inputTokenBasis",
      "currency", "effectiveFrom", "effectiveTo", "source", "usdPerMillionTokens",
      ...(native ? ["activation", "route"] : [])])
      || !["id", "modelId", "providerModelId"].every(key => identifier(entry[key]))
      || typeof entry.region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(entry.region)
      || !["uncached", "includes-cache"].includes(entry.inputTokenBasis) || entry.currency !== "USD"
      || !instant(entry.effectiveFrom) || !instant(entry.effectiveTo) || entry.effectiveFrom >= entry.effectiveTo
      || !exact(entry.source, ["url", "retrievedAt"]) || !instant(entry.source.retrievedAt)
      || typeof entry.source.url !== "string" || entry.source.url.length > 2048
      || !exact(entry.usdPerMillionTokens, rateKeys)
      || !rateKeys.every(key => entry.usdPerMillionTokens[key] === null
        || (typeof entry.usdPerMillionTokens[key] === "number"
          && Number.isFinite(entry.usdPerMillionTokens[key]) && entry.usdPerMillionTokens[key] >= 0))) invalid();
    let url;
    try { url = new URL(entry.source.url); } catch { invalid(); }
    if (url.protocol !== "https:" || url.username || url.password) invalid();
    if (native && (!["candidate", "active"].includes(entry.activation) || !validUsageRoute(entry.route)
      || entry.route.modelId !== entry.modelId || entry.route.providerModelId !== entry.providerModelId
      || entry.route.gatewayRegion !== entry.region)) invalid();
    // Anthropic's direct rate card is not authority for a Bedrock rate.
    if (native && entry.activation === "active" && entry.route.provider === "bedrock"
      && !(url.hostname === "aws.amazon.com" || url.hostname.endsWith(".amazonaws.com"))) invalid();
    return JSON.parse(JSON.stringify(entry));
  });
  const sameIdentity = (left, right) => ["modelId", "providerModelId", "region", "inputTokenBasis"]
    .every(key => left[key] === right[key])
    && (!native || routeKeys.every(key => left.route[key] === right.route[key]));
  entries.forEach((entry, index) => {
    if (entries.slice(0, index).some(other => other.id === entry.id
      || (sameIdentity(entry, other) && entry.effectiveFrom < other.effectiveTo
        && other.effectiveFrom < entry.effectiveTo))) invalid();
  });
  return Object.freeze({
    fingerprint: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    estimateUsage(observation, route, occurredAt) {
      const unknown = { estimatedCostUsd: null, pricingVersion: null, priceSource: null };
      if (!native || !validUsageRoute(route) || !instant(occurredAt) || !observation?.metering) return unknown;
      const entry = entries.find(rate => rate.activation === "active"
        && routeKeys.every(key => rate.route[key] === route[key])
        && rate.providerModelId === observation.metering.modelId
        && rate.inputTokenBasis === observation.metering.inputTokenBasis
        && rate.effectiveFrom <= occurredAt && occurredAt < rate.effectiveTo);
      if (!entry) return unknown;
      // Reuse the established token/cache calculation. Native settlement uses
      // the final usage observation time, and seals this revision in the event.
      const { activation, route: ignoredRoute, ...legacyEntry } = entry;
      return createModelPriceBook({ version: 1, entries: [legacyEntry] }).estimate({
        version: 1, runId: "0".repeat(64), attemptId: "gateway-1", environment: "PRODUCTION",
        purpose: "user", modelId: route.modelId, providerRequestId: observation.providerRequestId,
        traceId: null, usage: observation.usage, metering: observation.metering,
        execution: { startedAt: occurredAt, completedAt: occurredAt },
        pricingVersion: null, estimatedCostUsd: null,
      }, route.gatewayRegion);
    },
    estimate(accounting, region) {
      const unknown = { estimatedCostUsd: null, pricingVersion: null, priceSource: null };
      if (native || !validAccounting(accounting) || !accounting.metering || !accounting.execution) return unknown;
      const metering = accounting.metering;
      const at = accounting.execution.startedAt;
      const entry = entries.find(rate => rate.modelId === accounting.modelId
        && rate.providerModelId === metering.modelId && rate.region === region
        && rate.inputTokenBasis === metering.inputTokenBasis
        && rate.effectiveFrom <= at && at < rate.effectiveTo);
      if (!entry) return unknown;
      const result = { ...unknown, pricingVersion: entry.id, priceSource: {
        id: entry.id, ...entry.source, effectiveFrom: entry.effectiveFrom, effectiveTo: entry.effectiveTo,
      } };
      const quantities = {
        input: accounting.usage.inputTokens, output: accounting.usage.outputTokens,
        cacheRead: metering.cacheReadInputTokens,
      };
      if (quantities.cacheRead === null) return result;
      if (metering.inputTokenBasis === "includes-cache") {
        // For this explicit basis, cache creation remains part of normal input.
        if (["cacheWriteInputTokens", "cacheWrite5mInputTokens", "cacheWrite1hInputTokens"]
          .some(key => metering[key] !== null && metering[key] !== 0)) return result;
        quantities.input -= quantities.cacheRead;
        if (quantities.input < 0) return result;
      } else {
        if (metering.cacheWriteInputTokens === null) return result;
        if (metering.cacheWriteInputTokens > 0) {
          quantities.cacheWrite5m = metering.cacheWrite5mInputTokens;
          quantities.cacheWrite1h = metering.cacheWrite1hInputTokens;
          if (quantities.cacheWrite5m === null || quantities.cacheWrite1h === null
            || quantities.cacheWrite5m + quantities.cacheWrite1h !== metering.cacheWriteInputTokens) return result;
        } else if ((metering.cacheWrite5mInputTokens ?? 0) !== 0
          || (metering.cacheWrite1hInputTokens ?? 0) !== 0) return result;
      }
      let total = 0;
      for (const [key, quantity] of Object.entries(quantities)) {
        const rate = entry.usdPerMillionTokens[key];
        // A known zero quantity contributes zero without inventing a rate.
        if (quantity === 0) continue;
        if (rate === null) return result;
        total += quantity * rate;
      }
      return { ...result, estimatedCostUsd: Number.isFinite(total) ? total / 1_000_000 : null };
    },
  });
}
