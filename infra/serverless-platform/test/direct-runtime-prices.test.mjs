import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createModelPriceBook } from "../lambda/operations/model-prices.mjs";
import { createConfiguredBedrockInference } from "../lambda/agent-runtime/bedrock-inference.mjs";

const example = JSON.parse(await readFile(new URL("../../../docs/bedrock-runtime-prices.example.json", import.meta.url)));
const active = () => {
  const config = structuredClone(example);
  config.entries[0].activation = "active";
  return config;
};
const AT = "2026-09-11T12:00:00.000Z";
const MODEL = example.entries[0].request.modelId;
const usage = () => ({ inputTokens: 100, outputTokens: 20, totalTokens: 120,
  cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
async function observe(raw = usage(), modelId = MODEL, extra = {}) {
  let observation;
  let wire;
  const provider = createConfiguredBedrockInference({
    env: { MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1", BEDROCK_RUNTIME_REGION: "us-west-2",
      BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{ modelId, domains: ["support"] }]) },
    credentialsProvider: async () => ({ accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-only" }),
    fetchImpl: async (url, input) => {
      wire = { url, body: JSON.parse(input.body) };
      return new Response(JSON.stringify({
        output: { message: { role: "assistant", content: [
          { reasoningContent: { reasoningText: { text: "Synthetic reasoning", signature: "synthetic" } } },
          { text: "Yes." },
        ] } }, usage: raw, ...extra,
      }));
    },
  });
  await provider.invoke({ modelId, maxTokens: 128, sourceIdentity: "domain_support", prompt: "Synthetic",
    onUsage: async value => { observation = value; } });
  return { observation, wire };
}

test("direct SDK request metadata and provider counters select the verified Haiku catalog", async () => {
  const { observation, wire } = await observe();
  assert.deepEqual(wire.body.serviceTier, { type: "default" });
  assert.deepEqual(wire.body.performanceConfig, { latency: "standard" });
  assert.equal(observation.protocol, "bedrock-converse-v2");
  assert.deepEqual(observation.runtime.request, example.entries[0].request);
  assert.equal(observation.runtime.providerModelId, null);
  const result = createModelPriceBook(active()).estimateUsage(observation, null, AT);
  assert.equal(result.estimatedCostUsd, .0002); // All 20 output tokens, including reasoning.
  assert.equal(result.settlement.entry.provenance.catalogVersion, "20260901183649");
  assert.deepEqual(result.settlement.quantities, { input: 100, output: 20, cacheRead: 0,
    cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.equal(JSON.stringify(result).includes("Synthetic reasoning"), false);
  assert.equal(createModelPriceBook(example).estimateUsage(observation, null, AT).estimatedCostUsd, null);
});

test("Converse uncached input never overlaps cache categories or uses native Messages cache fields", async () => {
  const { observation } = await observe({ inputTokens: 12, outputTokens: 3, totalTokens: 115,
    cacheReadInputTokens: 40, cacheWriteInputTokens: 60,
    cacheDetails: [{ ttl: "1h", inputTokens: 50 }, { ttl: "5m", inputTokens: 10 }] });
  const result = createModelPriceBook(active()).estimateUsage(observation, null, AT);
  // AWS Converse docs: 12 uncached + 40 read + 60 write, not 12 inclusive input.
  assert.equal(result.estimatedCostUsd, .0001435);
  assert.equal(result.settlement.quantities.input, 12);
  assert.equal(observation.runtime.providerTotalTokens, 115);
});

test("missing counters, write TTL or charged rates stay incomplete even without checkpoints", async () => {
  for (const raw of [
    { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    { ...usage(), cacheReadInputTokens: undefined },
    { ...usage(), cacheWriteInputTokens: undefined },
    { ...usage(), cacheWriteInputTokens: 10 },
    { ...usage(), cacheWriteInputTokens: 10, cacheDetails: [{ ttl: "5m", inputTokens: 9 }] },
    { ...usage(), cacheWriteInputTokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10 } },
    { ...usage(), cacheDetails: [{ ttl: "5m", inputTokens: 10 }] },
  ]) {
    const { observation } = await observe(raw);
    assert.equal(createModelPriceBook(active()).estimateUsage(observation, null, AT).estimatedCostUsd, null);
  }
  const { observation } = await observe();
  for (const dimension of ["input", "output"]) {
    const config = active();
    config.entries[0].usdPerMillionTokens[dimension] = null;
    assert.equal(createModelPriceBook(config).estimateUsage(observation, null, AT).estimatedCostUsd, null);
  }
  const zeroCache = active();
  for (const key of ["cacheRead", "cacheWrite5m", "cacheWrite1h"]) zeroCache.entries[0].usdPerMillionTokens[key] = null;
  assert.equal(createModelPriceBook(zeroCache).estimateUsage(observation, null, AT).estimatedCostUsd, .0002);
  const cached = (await observe({ ...usage(), totalTokens: 150, cacheReadInputTokens: 10, cacheWriteInputTokens: 20,
    cacheDetails: [{ ttl: "5m", inputTokens: 10 }, { ttl: "1h", inputTokens: 10 }] })).observation;
  for (const dimension of ["cacheRead", "cacheWrite5m", "cacheWrite1h"]) {
    const config = active();
    config.entries[0].usdPerMillionTokens[dimension] = null;
    assert.equal(createModelPriceBook(config).estimateUsage(cached, null, AT).estimatedCostUsd, null);
  }
});

test("wrong model, region, global mode, tier, currency, basis, catalog or rates cannot borrow Haiku pricing", async () => {
  for (const edit of [
    e => { e.requestModelId = "us.anthropic.claude-haiku-4-5-20251001-v1:0"; },
    e => { e.requestModelId = "global.openai.gpt-6-astra"; },
    e => { e.request.foundationModelId = "openai.gpt-6-astra"; },
    e => { e.region = "us-east-1"; }, e => { e.request.inferenceMode = "cross-region"; },
    e => { e.request.capacityMode = "batch"; }, e => { e.request.serviceTier = "priority"; },
    e => { e.currency = "AUD"; }, e => { e.inputTokenBasis = "includes-cache"; },
    e => { e.request.cacheMode = "disabled"; },
    e => { e.source.url = "https://platform.claude.com/docs/en/about-claude/pricing"; },
    e => { e.provenance.catalogVersion = "other-version"; },
    e => { e.usdPerMillionTokens.input = 1.1; },
    e => { e.provenance.rateCodes.input = "CEFVF9AGX63DZ82A.4799GE89SK.6YS6EN2CT7"; },
  ]) {
    const config = active();
    edit(config.entries[0]);
    assert.throws(() => createModelPriceBook(config), /price book is invalid/);
  }
  const book = createModelPriceBook(active());
  for (const modelId of ["global.openai.gpt-6-astra", "us.openai.gpt-6-astra",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0"]) {
    assert.equal(book.estimateUsage((await observe(usage(), modelId)).observation, null, AT).estimatedCostUsd, null);
  }
  for (const extra of [{ serviceTier: { type: "priority" } }, { serviceTier: {} },
    { performanceConfig: { latency: "optimized" } }]) {
    assert.equal(book.estimateUsage((await observe(usage(), MODEL, extra)).observation, null, AT).estimatedCostUsd, null);
  }
});

test("catalog applicability uses a bounded half-open observation interval and snapshots caller configuration", async () => {
  const config = active();
  const book = createModelPriceBook(config);
  const { observation } = await observe();
  for (const [at, expected] of [
    ["2026-09-11T02:59:59.999Z", null], [config.entries[0].effectiveFrom, .0002],
    ["2026-09-12T02:59:59.999Z", .0002], [config.entries[0].effectiveTo, null],
  ]) assert.equal(book.estimateUsage(observation, null, at).estimatedCostUsd, expected);
  config.entries[0].usdPerMillionTokens.input = 999;
  assert.equal(book.estimateUsage(observation, null, AT).estimatedCostUsd, .0002);
  const overlap = active();
  overlap.entries.push({ ...structuredClone(overlap.entries[0]), id: "another" });
  assert.throws(() => createModelPriceBook(overlap));
  const historic = active();
  historic.entries[0].effectiveFrom = "2026-08-01T00:00:00.000Z";
  assert.throws(() => createModelPriceBook(historic));
});
