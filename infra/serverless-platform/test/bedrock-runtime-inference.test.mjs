import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredBedrockInference,
} from "../lambda/agent-runtime/bedrock-inference.mjs";

const HAIKU = "bedrock-claude/anthropic.claude-haiku-4-5";
const TARGET = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const ASTRA = "global.openai.gpt-6-astra";
const credentialsProvider = async () => ({
  accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-only",
});
const env = {
  MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1",
  BEDROCK_RUNTIME_REGION: "us-west-2",
  BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([
    { modelId: HAIKU, domains: ["support"] },
    { modelId: ASTRA, domains: ["support"] },
  ]),
};
const response = () => ({
  output: { message: { role: "assistant", content: [{ text: "Synthetic answer." }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0, cacheDetails: [] },
  metrics: { latencyMs: 1 },
});
function harness({ payload = response(), status = 200, fetchImpl, config = env, timeoutMs } = {}) {
  const calls = [];
  const provider = createConfiguredBedrockInference({
    env: config, credentialsProvider, ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl: fetchImpl ?? (async (url, input) => {
      calls.push({ url, ...input, parsed: JSON.parse(input.body) });
      return new Response(JSON.stringify(payload), {
        status, headers: { "x-amzn-requestid": "synthetic-provider-id" },
      });
    }),
  });
  return { provider, calls, invoke: extra => provider.invoke({
    modelId: HAIKU, prompt: "Synthetic prompt.", maxTokens: 128,
    sourceIdentity: "domain_support", ...extra,
  }) };
}

for (const modelId of [HAIKU, ASTRA]) {
  test(`SDK serializes bounded Converse for ${modelId}, without a response model field`, async () => {
    const h = harness();
    const observations = [];
    const result = await h.invoke({ modelId, onUsage: async value => observations.push(value) });
    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call.url, `https://bedrock-runtime.us-west-2.amazonaws.com/model/${encodeURIComponent(modelId === HAIKU ? TARGET : modelId)}/converse`);
    assert.equal(call.redirect, "error");
    assert.match(call.headers.authorization, /\/us-west-2\/bedrock\/aws4_request/);
    assert.deepEqual(call.parsed.messages, [{ role: "user", content: [{ text: "Synthetic prompt." }] }]);
    assert.deepEqual(call.parsed.inferenceConfig, { maxTokens: 128 });
    assert.equal(call.parsed.model, undefined);
    assert.equal(call.parsed.max_tokens, undefined);
    assert.equal(result.output, "Synthetic answer.");
    assert.equal(result.requestId, "synthetic-provider-id");
    assert.equal(observations[0].runtime.requestModelId, modelId === HAIKU ? TARGET : modelId);
    assert.equal(observations[0].runtime.providerModelId, null);
    assert.equal(observations[0].protocol, "bedrock-converse-v2");
    assert.equal(observations[0].runtime.inputTokenBasis, modelId === HAIKU ? "uncached" : "unknown");
  });
}

test("missing/invalid configuration, GPT5.5, unverified models and arbitrary endpoints fail closed", () => {
  for (const config of [
    {}, { ...env, MODEL_INFERENCE_ROUTE: "mantle" }, { ...env, BEDROCK_RUNTIME_REGION: "us-east-1" },
    ...["openai/gpt-5.5", "openai.gpt-5.5", "global.openai.gpt-5.5", "openai.gpt-5.6-terra",
      "https://api.openai.com/v1", "global.anthropic.claude-sonnet-5"].map(modelId => ({
      ...env, BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{ modelId, domains: ["support"] }]),
    })),
    { ...env, BEDROCK_RUNTIME_MODELS_JSON: "[]" },
  ]) assert.throws(() => harness({ config }), /Bedrock Runtime configuration/);
});

test("existing Gateway target alias supports the saved persona and temperature", async () => {
  const alias = "bedrock-mantle/anthropic.claude-haiku-4-5";
  const h = harness({ config: { ...env, BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{ modelId: alias, domains: ["support"] }]) } });
  await h.invoke({ modelId: alias, systemPrompt: "You help customers with order questions.", temperature: 0.3 });
  assert.deepEqual(h.calls[0].parsed.system, [{ text: "You help customers with order questions." }]);
  assert.equal(h.calls[0].parsed.inferenceConfig.temperature, 0.3);
  assert.ok(h.calls[0].url.endsWith(encodeURIComponent(TARGET) + "/converse"));
  await assert.rejects(h.invoke({ modelId: alias, temperature: 1.1 }), { code: "INVALID_BEDROCK_REQUEST" });
});

test("unallowed model/domain, raised cap and malformed input fail before transport", async () => {
  const h = harness();
  for (const extra of [
    { modelId: "openai/gpt-5.5" }, { modelId: TARGET },
    { sourceIdentity: "domain_finance" }, { sourceIdentity: "platform" },
    { maxTokens: 129 }, { maxTokens: "128" }, { maxTokens: 0 },
    { prompt: "" }, { endpoint: "https://api.openai.com" },
  ]) await assert.rejects(h.invoke(extra), { code: "INVALID_BEDROCK_REQUEST" });
  assert.equal(h.calls.length, 0);
});

test("measured usage is captured before invalid output; no invented model or pricing", async () => {
  const payload = response();
  payload.output.message.content = [{ toolUse: { toolUseId: "synthetic", name: "tool", input: {} } }];
  const h = harness({ payload });
  const observations = [];
  await assert.rejects(h.invoke({ onUsage: async o => observations.push(o) }), { code: "INVALID_BEDROCK_RESPONSE" });
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  assert.equal(observations[0].metering, null);
});

test("OpenAI Converse reasoning blocks do not hide the final text or enter stored metering", async () => {
  const payload = response();
  payload.output.message.content.unshift({ reasoningContent: { reasoningText: {
    text: "Synthetic private reasoning fixture.", signature: "synthetic-signature",
  } } });
  const seen = [];
  const result = await harness({ payload }).invoke({ modelId: ASTRA, onUsage: async o => seen.push(o) });
  assert.equal(result.output, "Synthetic answer.");
  assert.equal(JSON.stringify(seen).includes("reasoning"), false);
});

test("valid usage survives SDK output deserialization failure", async () => {
  const payload = response();
  payload.output.message.content = "malformed-content";
  const seen = [];
  await assert.rejects(harness({ payload }).invoke({ onUsage: async o => seen.push(o) }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].usage.outputTokens, 3);
});

test("Converse cache counters and TTL details are measured separately from normalized total", async () => {
  const payload = response();
  payload.usage = { inputTokens: 12, outputTokens: 3, totalTokens: 115,
    cacheReadInputTokens: 40, cacheWriteInputTokens: 60,
    cacheDetails: [{ ttl: "1h", inputTokens: 50 }, { ttl: "5m", inputTokens: 10 }] };
  const seen = [];
  await harness({ payload }).invoke({ onUsage: async o => seen.push(o) });
  assert.equal(seen[0].usage.totalTokens, 15);
  assert.equal(seen[0].runtime.providerTotalTokens, 115);
  assert.deepEqual(seen[0].runtime.cacheDetails, payload.usage.cacheDetails);
  assert.equal(seen[0].runtime.cacheWriteInputTokens, 60);
});

test("missing or invalid caches remain unknown while base usage survives", async () => {
  for (const cache of [
    {}, { cacheReadInputTokens: -1 }, { cacheWriteInputTokens: 10 },
    { cacheWriteInputTokens: 10, cacheDetails: [{ ttl: "30m", inputTokens: 10 }] },
    { cacheWriteInputTokens: 10, cacheDetails: [{ ttl: "5m", inputTokens: 9 }] },
  ]) {
    const payload = response();
    payload.usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15, ...cache };
    const seen = [];
    await harness({ payload }).invoke({ onUsage: async o => seen.push(o) });
    assert.equal(seen[0].runtime.cacheDetails, null);
    assert.equal(seen[0].metering, null);
  }
});

test("invalid base usage is never recorded as zero", async () => {
  for (const usage of [undefined, {}, { inputTokens: -1, outputTokens: 3, totalTokens: 2 },
    { inputTokens: 12, outputTokens: 3, totalTokens: 14 }]) {
    const payload = response();
    payload.usage = usage;
    let seen = 0;
    await assert.rejects(harness({ payload }).invoke({ onUsage: async () => { seen += 1; } }),
      { code: "INVALID_BEDROCK_RESPONSE" });
    assert.equal(seen, 0);
  }
});

for (const status of [400, 403, 429, 500, 503]) {
  test(`HTTP ${status} never retries or falls back`, async () => {
    const h = harness({ status });
    await assert.rejects(h.invoke());
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\/model\//);
  });
}

test("bounded response, abort and timeout stop without retry", async () => {
  const large = harness({ fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1)) });
  await assert.rejects(large.invoke(), { code: "BEDROCK_RESPONSE_TOO_LARGE" });
  const aborted = new AbortController();
  aborted.abort();
  const h = harness();
  await assert.rejects(h.invoke({ abortSignal: aborted.signal }), { code: "BEDROCK_ABORTED" });
  assert.equal(h.calls.length, 0);
  let calls = 0;
  const slow = harness({ timeoutMs: 10, fetchImpl: async () => { calls += 1; return new Promise(() => {}); } });
  await assert.rejects(slow.invoke(), { code: "BEDROCK_TIMEOUT" });
  assert.equal(calls, 1);
});
