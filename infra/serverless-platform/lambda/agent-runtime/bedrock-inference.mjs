import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { validUsage } from "./usage.mjs";

const HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";
// Exact profiles in the saved AWS SYSTEM_DEFINED metadata. Catalog presence
// alone does not authorize a model: configuration and domain policy still apply.
const TARGETS = Object.freeze({
  "bedrock-claude/anthropic.claude-haiku-4-5": `global.${HAIKU}`,
  "bedrock-mantle/anthropic.claude-haiku-4-5": `global.${HAIKU}`,
  [`global.${HAIKU}`]: `global.${HAIKU}`,
  [`us.${HAIKU}`]: `us.${HAIKU}`,
  "global.openai.gpt-6-astra": "global.openai.gpt-6-astra",
  "us.openai.gpt-6-astra": "us.openai.gpt-6-astra",
  "bedrock-mantle/moonshotai.kimi-k3": "global.moonshotai.kimi-k3",
  "global.moonshotai.kimi-k3": "global.moonshotai.kimi-k3",
  "us.moonshotai.kimi-k3": "us.moonshotai.kimi-k3",
});
const REGION = "us-west-2";
const HOST = `bedrock-runtime.${REGION}.amazonaws.com`;
const MAX_RESPONSE_BYTES = 256 * 1024;
const count = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable === true && Object.hasOwn(property, "value");
  });
const runtimeKeys = ["endpoint", "api", "region", "requestModelId", "providerModelId",
  "providerTotalTokens", "inputTokenBasis", "cacheReadInputTokens", "cacheWriteInputTokens", "cacheDetails"];

export const converseModelTarget = modelId => Object.hasOwn(TARGETS, modelId) ? TARGETS[modelId] : null;

// This is request/profile metadata, never a claim about a returned provider ID
// or the AWS Region that actually served a global request.
export function converseRequestBinding(modelId) {
  const target = converseModelTarget(modelId);
  if (target === null) return null;
  return {
    bindingVersion: "aws-system-profile-2026-09-11", modelId,
    foundationModelId: target.includes(".anthropic.") ? HAIKU : "openai.gpt-6-astra",
    inferenceMode: target.startsWith("global.") ? "global" : "cross-region",
    capacityMode: "on-demand", serviceTier: "default", performanceLatency: "standard",
    cacheMode: "no-explicit-checkpoints",
  };
}

function validCacheDetails(details, total) {
  return Array.isArray(details) && details.length <= 2
    && details.every(item => exact(item, ["ttl", "inputTokens"])
      && ["5m", "1h"].includes(item.ttl) && count(item.inputTokens))
    && new Set(details.map(item => item.ttl)).size === details.length
    && details.reduce((sum, item) => sum + item.inputTokens, 0) === total;
}

export function validConverseRuntime(value, protocol = "bedrock-converse-v1") {
  const current = protocol === "bedrock-converse-v2";
  const binding = current ? converseRequestBinding(value?.request?.modelId) : null;
  return exact(value, [...runtimeKeys, ...(current ? ["request", "response"] : [])])
    && (!current || (binding !== null && exact(value.request, Object.keys(binding))
      && Object.keys(binding).every(key => value.request[key] === binding[key])
      && converseModelTarget(value.request.modelId) === value.requestModelId
      && exact(value.response, ["serviceTier", "performanceLatency"])
      && [null, "default", "priority", "flex", "reserved", "unknown"].includes(value.response.serviceTier)
      && [null, "standard", "optimized", "unknown"].includes(value.response.performanceLatency)))
    && value.endpoint === "bedrock-runtime" && value.api === "Converse"
    && value.region === REGION && Object.values(TARGETS).includes(value.requestModelId)
    && value.providerModelId === null && count(value.providerTotalTokens)
    && value.inputTokenBasis === (value.requestModelId.includes(".anthropic.") ? "uncached" : "unknown")
    && [value.cacheReadInputTokens, value.cacheWriteInputTokens].every(v => v === null || count(v))
    && (value.cacheDetails === null || validCacheDetails(value.cacheDetails, value.cacheWriteInputTokens));
}

function failure(code) {
  return Object.assign(new Error("Bedrock Runtime inference is unavailable."), {
    code, statusCode: code === "BEDROCK_TIMEOUT" ? 504 : 502, retryable: false,
  });
}

function normalizeUsage(payload, modelId, requestId) {
  const target = TARGETS[modelId];
  const raw = payload?.usage;
  const usage = { inputTokens: raw?.inputTokens, outputTokens: raw?.outputTokens,
    totalTokens: raw?.inputTokens + raw?.outputTokens };
  if (!validUsage(usage) || !count(raw?.totalTokens)) throw failure("INVALID_BEDROCK_RESPONSE");
  const read = count(raw.cacheReadInputTokens) ? raw.cacheReadInputTokens : null;
  const writeCount = count(raw.cacheWriteInputTokens) ? raw.cacheWriteInputTokens : null;
  const detailsValid = validCacheDetails(raw.cacheDetails, writeCount);
  // A contradictory TTL partition invalidates the write basis, including a
  // zero write counter paired with positive TTL details. Missing is distinct.
  const write = raw.cacheDetails !== undefined && !detailsValid ? null : writeCount;
  // Retain the provider's total separately: cache-inclusive totals must not
  // silently change the established input+output accounting contract.
  if (raw.totalTokens !== usage.totalTokens
    && !(read !== null && writeCount !== null && raw.totalTokens === usage.totalTokens + read + writeCount)) {
    throw failure("INVALID_BEDROCK_RESPONSE");
  }
  return {
    protocol: "bedrock-converse-v2", providerRequestId: requestId, usage,
    // Converse has no required returned model identity. Legacy native-body
    // metering/price matching cannot safely be applied to this response.
    metering: null,
    runtime: {
      endpoint: "bedrock-runtime", api: "Converse", region: REGION,
      requestModelId: target, providerModelId: null, providerTotalTokens: raw.totalTokens,
      // AWS prompt-caching.html, Converse API: input excludes read AND write.
      inputTokenBasis: target.includes(".anthropic.") ? "uncached" : "unknown",
      cacheReadInputTokens: read, cacheWriteInputTokens: write,
      // TokenUsage.cacheDetails is the documented TTL breakdown, not the
      // Anthropic-native cache_creation object. Never infer TTL from a total.
      cacheDetails: detailsValid
        ? raw.cacheDetails.map(({ ttl, inputTokens }) => ({ ttl, inputTokens })) : null,
      request: converseRequestBinding(modelId),
      // Missing optional response selectors preserve the explicit request
      // binding. Malformed or conflicting selectors cannot receive its rate.
      response: {
        serviceTier: payload.serviceTier === undefined ? null
          : exact(payload.serviceTier, ["type"])
            && ["default", "priority", "flex", "reserved"].includes(payload.serviceTier.type)
            ? payload.serviceTier.type : "unknown",
        performanceLatency: payload.performanceConfig === undefined ? null
          : exact(payload.performanceConfig, ["latency"])
            && ["standard", "optimized"].includes(payload.performanceConfig.latency)
            ? payload.performanceConfig.latency : "unknown",
      },
    },
  };
}

async function boundedResponse(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw failure("BEDROCK_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        cancel();
        throw failure("BEDROCK_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw failure("INVALID_BEDROCK_RESPONSE"); }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createConfiguredBedrockInference({
  env, credentialsProvider, fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  let models;
  try { models = JSON.parse(env?.BEDROCK_RUNTIME_MODELS_JSON); } catch { /* fail closed below */ }
  if (env?.MODEL_INFERENCE_ROUTE !== "bedrock-runtime-converse-v1"
    || env.BEDROCK_RUNTIME_REGION !== REGION || !Array.isArray(models) || models.length < 1 || models.length > 8
    || models.some(entry => !exact(entry, ["modelId", "domains"]) || !Object.hasOwn(TARGETS, entry.modelId)
      || !Array.isArray(entry.domains) || entry.domains.length < 1 || entry.domains.length > 32
      || entry.domains.some(domain => typeof domain !== "string"
        || domain.length < 2 || domain.length > 57 || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(domain))
      || new Set(entry.domains).size !== entry.domains.length)
    || new Set(models.map(entry => entry.modelId)).size !== models.length
    || typeof credentialsProvider !== "function" || typeof fetchImpl !== "function"
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Bedrock Runtime configuration is invalid.");
  }
  const allowed = new Map(models.map(entry => [entry.modelId, new Set(entry.domains)]));
  function validateModel({ modelId, sourceIdentity, maxTokens }) {
    if (typeof sourceIdentity !== "string" || !sourceIdentity.startsWith("domain_")
      || !allowed.get(modelId)?.has(sourceIdentity.slice(7))
      || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128) {
      throw failure("INVALID_BEDROCK_REQUEST");
    }
  }
  return Object.freeze({
    validateModel,
    async invoke(input) {
      const keys = ["modelId", "sourceIdentity", "maxTokens", "prompt", "systemPrompt", "temperature", "onUsage", "abortSignal"];
      if (!input || typeof input !== "object" || Array.isArray(input)
        || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
        || Reflect.ownKeys(input).some(key => !keys.includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), "value")
        || Object.getOwnPropertyDescriptor(input, key).enumerable !== true)
        || typeof input.prompt !== "string" || input.prompt.length > 16_384 || !input.prompt.trim()
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.prompt)
        || (input.systemPrompt !== undefined && (typeof input.systemPrompt !== "string" || !input.systemPrompt.trim() || input.systemPrompt.length > 16_384))
        || (input.temperature !== undefined && (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 1))
        || (input.onUsage !== undefined && typeof input.onUsage !== "function")
        || (input.abortSignal !== undefined && !(input.abortSignal instanceof AbortSignal))) {
        throw failure("INVALID_BEDROCK_REQUEST");
      }
      validateModel(input);
      if (input.abortSignal?.aborted) throw failure("BEDROCK_ABORTED");
      const controller = new AbortController();
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      const onAbort = () => controller.abort(failure("BEDROCK_ABORTED"));
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(failure("BEDROCK_TIMEOUT")), timeoutMs);
      const target = TARGETS[input.modelId];
      const path = `/model/${encodeURIComponent(target)}/converse`;
      let observation;
      const client = new BedrockRuntimeClient({
        region: REGION, endpoint: `https://${HOST}`, maxAttempts: 1,
        credentials: async () => {
          try { return await credentialsProvider({ abortSignal: controller.signal }); }
          catch { throw failure("BEDROCK_CREDENTIALS_UNAVAILABLE"); }
        },
        // Use the installed SDK serializer/signer with a bounded transport.
        // The endpoint and exact path are checked again after serialization;
        // neither shared AWS endpoint configuration nor redirects may reroute.
        requestHandler: { async handle(request) {
          if (request.protocol !== "https:" || request.hostname !== HOST || request.path !== path
            || request.method !== "POST" || Object.keys(request.query ?? {}).length
            || Buffer.byteLength(request.body, "utf8") > 32 * 1024) throw failure("INVALID_BEDROCK_REQUEST");
          controller.signal.throwIfAborted();
          const response = await fetchImpl(`https://${HOST}${path}`, {
            method: "POST", headers: request.headers, body: request.body,
            signal: controller.signal, redirect: "error",
          });
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            throw failure(response.status >= 400 && response.status < 500
              ? "BEDROCK_INVOCATION_REJECTED" : "BEDROCK_INVOCATION_FAILED");
          }
          const bytes = await boundedResponse(response, controller.signal);
          let raw;
          try { raw = JSON.parse(bytes.toString("utf8")); }
          catch { throw failure("INVALID_BEDROCK_RESPONSE"); }
          const id = response.headers.get("x-amzn-requestid");
          const requestId = typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(id) ? id : null;
          observation = normalizeUsage(raw, input.modelId, requestId);
          // Capture before even the SDK's output union deserializer can fail.
          if (input.onUsage) await input.onUsage(observation);
          return { response: { statusCode: response.status,
            headers: Object.fromEntries(response.headers), body: bytes } };
        } },
      });
      let payload;
      try {
        payload = await Promise.race([client.send(new ConverseCommand({
          modelId: target,
          messages: [{ role: "user", content: [{ text: input.prompt }] }],
          ...(input.systemPrompt ? { system: [{ text: input.systemPrompt }] } : {}),
          inferenceConfig: { maxTokens: input.maxTokens, ...(input.temperature === undefined ? {} : { temperature: input.temperature }) },
          serviceTier: { type: "default" },
          performanceConfig: { latency: "standard" },
          requestMetadata: { domain: input.sourceIdentity.slice(7) },
        }), { abortSignal: controller.signal }), aborted]);
      } catch (error) {
        if (error?.code?.startsWith("BEDROCK_") || error?.code?.startsWith("INVALID_BEDROCK_")) throw error;
        if (error?.code?.startsWith("EXECUTION_JOURNAL_")) throw error;
        throw failure(observation ? "INVALID_BEDROCK_RESPONSE" : "BEDROCK_INVOCATION_FAILED");
      } finally {
        clearTimeout(timer);
        input.abortSignal?.removeEventListener("abort", onAbort);
        client.destroy();
      }
      const requestId = observation.providerRequestId;
      const message = payload.output?.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content) || !message.content.length
        || message.content.some(block => typeof block.text !== "string" && !exact(block, ["reasoningContent"]))
        || !message.content.some(block => typeof block.text === "string")
        || observation.usage.outputTokens > input.maxTokens) throw failure("INVALID_BEDROCK_RESPONSE");
      const output = message.content.filter(block => typeof block.text === "string").map(block => block.text).join("");
      if (Buffer.byteLength(output, "utf8") > 128 * 1024) throw failure("INVALID_BEDROCK_RESPONSE");
      return { output, usage: observation.usage, ...(requestId === null ? {} : { requestId }) };
    },
  });
}
