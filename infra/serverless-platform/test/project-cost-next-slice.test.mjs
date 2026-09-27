import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { createExperienceInvocationStore } from "../lambda/experience/invocation-store.mjs";
import { createOperationsService } from "../lambda/operations/service.mjs";

const compatibility = { writerVersion: "cost-v1", readerVersion: "cost-v1" };
const START = "2026-09-10T00:00:00.000Z";
const NOW = "2026-09-10T12:00:00.000Z";
const END = "2026-09-11T00:00:00.000Z";
const binding = (requestId, domainId = "support", projectId = "case-assist") => ({
  actor: "test-user", requestId, domainId, projectId, agentId: "triage",
  payloadFingerprint: createHash("sha256").update(requestId).digest("hex"),
  sessionId: "session-0123456789abcdef-abcdef0123456789", baselineFingerprint: null,
});
const accounting = requestId => ({
  version: 1, runId: createHash("sha256").update(`test-user\0${requestId}`).digest("hex"),
  attemptId: "gateway-1", environment: "PRODUCTION", purpose: "user",
  modelId: "test-route/test-model", providerRequestId: "provider-test", traceId: null,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  metering: {
    version: 1, source: "provider", modelId: "test-model", inputTokenBasis: "uncached",
    cacheReadInputTokens: 30, cacheWriteInputTokens: 12,
    cacheWrite5mInputTokens: 10, cacheWrite1hInputTokens: 2,
  },
  execution: { startedAt: NOW, completedAt: NOW },
  pricingVersion: null, estimatedCostUsd: null,
});
// Synthetic rates only; this is deliberately not a live/public price card.
const prices = () => ({
  version: 1,
  entries: [{
    id: "synthetic-v1", modelId: "test-route/test-model", providerModelId: "test-model",
    region: "us-west-2", inputTokenBasis: "uncached", currency: "USD",
    effectiveFrom: START, effectiveTo: END,
    source: { url: "https://example.invalid/synthetic-prices", retrievedAt: START },
    usdPerMillionTokens: { input: 2, output: 4, cacheRead: 1, cacheWrite5m: 3, cacheWrite1h: 5 },
  }],
});
const request = (scope = {
  type: "projects", domainIds: ["support"], projectIds: ["support/case-assist"],
}) => ({ scope, startTime: START, endTime: END, limit: 20 });

function harness() {
  const items = new Map();
  const commands = [];
  let time = NOW;
  let queryOverride;
  const conditional = () => { throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" }); };
  const dynamo = { async send(command) {
    commands.push(command);
    const input = command.input;
    if (command instanceof QueryCommand) {
      if (queryOverride) return queryOverride(input);
      const values = input.ExpressionAttributeValues;
      return { Items: [...items.values()].filter(item =>
        item.domainId.S === values[":domainId"].S && item.projectId.S === values[":projectId"].S) };
    }
    const key = JSON.stringify(input.Key ?? { pk: input.Item.pk, sk: input.Item.sk });
    if (command instanceof GetItemCommand) return { Item: structuredClone(items.get(key)) };
    if (command instanceof PutItemCommand) {
      if (items.has(key)) conditional();
      items.set(key, structuredClone(input.Item));
      return {};
    }
    assert.ok(command instanceof UpdateItemCommand);
    const item = items.get(key);
    const values = input.ExpressionAttributeValues;
    if (!item || item.phase.S !== "STARTED") conditional();
    if (values[":pending"] && item.lifecycle?.S !== values[":pending"].S) conditional();
    for (const assignment of input.UpdateExpression.replace(/^SET /, "").split(", ")) {
      const [name, value] = assignment.split(" = ");
      item[input.ExpressionAttributeNames[name]] = structuredClone(values[value]);
    }
    return { Attributes: structuredClone(item) };
  } };
  const store = createExperienceInvocationStore({ compatibility, tableName: "PlatformState", dynamo, now: () => new Date(time) });
  return { store, items, commands, setTime(value) { time = value; }, queryWith(fn) { queryOverride = fn; } };
}

async function success(h, id, changes = {}) {
  const input = binding(id);
  await h.store.start(input);
  await h.store.markDispatched({ ...input, region: "us-west-2" });
  const completion = {
    ...input, runtimeStatus: "SUCCEEDED", output: "Synthetic output",
    invocationId: "provider-test", accounting: { ...accounting(id), ...changes },
  };
  await h.store.complete(completion);
  return completion;
}

test("durable lifecycle excludes preparation failures and retains dispatched failures and crash uncertainty", async () => {
  const h = harness();
  const pending = await h.store.start(binding("pending"));
  assert.equal(pending.lifecycle.startedAt, null);
  const started = await h.store.markDispatched({ ...binding("pending"), region: "us-west-2" });
  assert.equal(started.lifecycle.startedAt, NOW);
  assert.deepEqual(await h.store.markDispatched({ ...binding("pending"), region: "us-west-2" }), started);
  const completed = await h.store.complete({
    ...binding("pending"), runtimeStatus: "FAILED", output: null, invocationId: null,
  });
  assert.equal(completed.lifecycle.startedAt, NOW);
  assert.equal(completed.runtimeStatus, "FAILED");
  await h.store.start(binding("proof-failure"));
  await h.store.complete({
    ...binding("proof-failure"), runtimeStatus: "FAILED", output: null, invocationId: null,
  });
  await h.store.start(binding("crash"));
  await h.store.markDispatched({ ...binding("crash"), region: "us-west-2" });
  const result = await h.store.listByProject({ domainId: "support", projectId: "case-assist" });
  assert.equal(result.items.length, 3);
  assert.equal(result.items.find(item => item.runId === accounting("crash").runId).phase, "STARTED");
  assert.equal(result.items.find(item => item.runId === accounting("proof-failure").runId).lifecycle.startedAt, null);
  assert.equal(JSON.stringify(result).includes("Synthetic output"), false);
  assert.equal(Object.hasOwn(result.items[0], "actor"), false);
});

test("scoped journal query rejects foreign rows and follows only valid bounded index cursors", async () => {
  const h = harness();
  await h.store.start(binding("foreign", "finance"));
  h.queryWith(() => ({ Items: [...h.items.values()] }));
  await assert.rejects(h.store.listByProject({ domainId: "support", projectId: "case-assist" }), /conflict/i);
  h.queryWith(() => ({ Items: [], LastEvaluatedKey: { pk: { S: "OTHER" } } }));
  await assert.rejects(h.store.listByProject({ domainId: "support", projectId: "case-assist" }), /conflict/i);
});

test("versioned explicit model/cache rates require identity, dates, cache counters and provenance", async () => {
  const { createModelPriceBook } = await import("../lambda/operations/model-prices.mjs");
  const book = createModelPriceBook(prices());
  assert.equal(book.estimate(accounting("one"), "us-west-2").estimatedCostUsd, 0.00035);
  assert.equal(book.estimate(accounting("one"), "us-east-1").estimatedCostUsd, null);
  for (const changes of [
    { metering: null }, { execution: null }, { modelId: "other-model" },
    { metering: { ...accounting("one").metering, modelId: null } },
    { metering: { ...accounting("one").metering, cacheReadInputTokens: null } },
    { metering: { ...accounting("one").metering, cacheWrite5mInputTokens: null } },
    { execution: { startedAt: END, completedAt: END } },
  ]) assert.equal(book.estimate({ ...accounting("one"), ...changes }, "us-west-2").estimatedCostUsd, null);
  const unknown = prices();
  unknown.entries[0].usdPerMillionTokens.cacheRead = null;
  assert.equal(createModelPriceBook(unknown).estimate(accounting("one"), "us-west-2").estimatedCostUsd, null);
  const zero = accounting("zero");
  zero.metering.cacheReadInputTokens = 0;
  assert.equal(createModelPriceBook(unknown).estimate(zero, "us-west-2").estimatedCostUsd, 0.00032);
  const invalid = prices();
  delete invalid.entries[0].source;
  assert.throws(() => createModelPriceBook(invalid), /price/i);
  const overlap = prices();
  overlap.entries.push({ ...overlap.entries[0], id: "overlap" });
  assert.throws(() => createModelPriceBook(overlap), /price/i);
});

test("inclusive cache input is not double charged and price versions use half-open effective intervals", async () => {
  const { createModelPriceBook } = await import("../lambda/operations/model-prices.mjs");
  const config = prices();
  config.entries[0].inputTokenBasis = "includes-cache";
  config.entries[0].effectiveTo = NOW;
  config.entries.push({
    ...config.entries[0], id: "synthetic-v2", effectiveFrom: NOW, effectiveTo: END,
    usdPerMillionTokens: { input: 3, output: 5, cacheRead: 1, cacheWrite5m: null, cacheWrite1h: null },
  });
  const value = accounting("one");
  value.metering = { ...value.metering, inputTokenBasis: "includes-cache",
    cacheWriteInputTokens: null, cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: null };
  const book = createModelPriceBook(config);
  const result = book.estimate(value, "us-west-2");
  assert.equal(result.pricingVersion, "synthetic-v2");
  assert.equal(result.estimatedCostUsd, 0.00034); // 70*3 + 20*5 + 30*1, per million
  value.metering.cacheReadInputTokens = 101;
  assert.equal(book.estimate(value, "us-west-2").estimatedCostUsd, null);
});

test("journal costs dedupe dispatches, preserve unknown costs and use a dispatch-start cohort", async () => {
  const { createJournalUsageProvider } = await import("../lambda/operations/journal-usage.mjs");
  const h = harness();
  const completion = await success(h, "one");
  await h.store.complete(completion);
  await success(h, "real-retry");
  h.setTime(END);
  await success(h, "end-exclusive");
  const provider = createJournalUsageProvider({ compatibility, journal: h.store, priceBook: prices(), budgets: {} });
  let result = (await provider.listInvocationUsageAggregates(request())).items[0];
  assert.equal(result.acceptedDispatchCount, 2);
  assert.equal(result.runCount, null);
  assert.equal(result.invocationCount, null);
  assert.equal(result.runCountUnavailableReason, "actual-execution-start-unavailable");
  assert.equal(result.estimatedCostUsd, 0.0007);
  assert.equal(result.pricingVersion, "synthetic-v1");
  assert.equal(result.source, "experience-invocation-journal");
  assert.equal(result.modelCoverage, "complete");
  assert.equal(result.consistency, "eventual");
  h.setTime(NOW);
  await h.store.start(binding("failed"));
  await h.store.markDispatched({ ...binding("failed"), region: "us-west-2" });
  await h.store.complete({ ...binding("failed"), runtimeStatus: "FAILED", output: null, invocationId: null });
  result = (await provider.listInvocationUsageAggregates(request())).items[0];
  assert.equal(result.acceptedDispatchCount, 3);
  assert.equal(result.runCount, null);
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(result.knownEstimatedCostUsd, 0.0007);
  assert.equal(result.modelCoverage, "partial");
  assert.equal(result.failedDispatchCount, 1);
  assert.equal(result.inputTokens, null);
  const unknown = createJournalUsageProvider({ compatibility, journal: h.store, budgets: {} });
  assert.equal((await unknown.listInvocationUsageAggregates(request())).items[0].estimatedCostUsd, null);
});

test("accepted dispatch lost before SDK send supplies no actual agent-run evidence", async () => {
  const { createJournalUsageProvider } = await import("../lambda/operations/journal-usage.mjs");
  const h = harness();
  await h.store.start(binding("reserved-only"));
  await h.store.start(binding("lost-before-send"));
  await h.store.markDispatched({ ...binding("lost-before-send"), region: "us-west-2" });
  // Deliberately no SDK send, response, accounting or execution-start event.
  const provider = createJournalUsageProvider({ compatibility, journal: h.store, priceBook: prices() });
  const result = (await provider.listInvocationUsageAggregates(request())).items[0];
  assert.equal(result.acceptedDispatchCount, 1);
  assert.equal(result.unresolvedDispatchCount, 1);
  assert.equal(result.succeededDispatchCount, 0);
  assert.equal(result.runCount, null);
  assert.equal(result.invocationCount, null);
  assert.equal(result.runCountUnavailableReason, "actual-execution-start-unavailable");
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(result.knownEstimatedCostUsd, 0);
  assert.equal(result.modelCoverage, "unavailable");
});

test("legacy records keep lifecycle unknown and journal pagination fails closed on repetition", async () => {
  const { createJournalUsageProvider } = await import("../lambda/operations/journal-usage.mjs");
  const h = harness();
  await h.store.start(binding("legacy"));
  delete [...h.items.values()][0].lifecycle;
  const provider = createJournalUsageProvider({ compatibility, journal: h.store, budgets: {} });
  const result = (await provider.listInvocationUsageAggregates(request())).items[0];
  assert.equal(result.runCount, null);
  assert.equal(result.acceptedDispatchCount, null);
  assert.equal(result.legacyRecordCount, 1);
  const item = [...h.items.values()][0];
  h.queryWith(() => ({ Items: [], LastEvaluatedKey: { pk: item.pk, sk: item.sk, entityType: item.entityType } }));
  await assert.rejects(provider.listInvocationUsageAggregates(request()), /journal/i);
});

test("a legacy unresolved reservation crossing the window cannot establish zero started runs", async () => {
  const { createJournalUsageProvider } = await import("../lambda/operations/journal-usage.mjs");
  const h = harness();
  h.setTime("2026-09-09T23:59:59.000Z");
  await h.store.start(binding("legacy-crossing"));
  delete [...h.items.values()][0].lifecycle;
  const provider = createJournalUsageProvider({ compatibility, journal: h.store });
  const result = (await provider.listInvocationUsageAggregates(request())).items[0];
  assert.equal(result.runCount, null);
  assert.equal(result.estimatedCostUsd, null);
});

test("empty filtered pages are followed; duplicate rows, aborts and page overflow cannot produce a total", async () => {
  const { createJournalUsageProvider } = await import("../lambda/operations/journal-usage.mjs");
  const h = harness();
  await success(h, "one");
  const item = [...h.items.values()][0];
  const cursor = { pk: item.pk, sk: item.sk, entityType: item.entityType };
  let calls = 0;
  h.queryWith(input => {
    calls += 1;
    assert.equal(input.IndexName, "EntityTypeIndex");
    assert.equal(input.ExpressionAttributeValues[":domainId"].S, "support");
    assert.equal(input.ExpressionAttributeValues[":projectId"].S, "case-assist");
    return calls === 1 ? { Items: [], LastEvaluatedKey: cursor } : { Items: [item] };
  });
  const provider = createJournalUsageProvider({ compatibility, journal: h.store, priceBook: prices() });
  assert.equal((await provider.listInvocationUsageAggregates(request())).items[0].acceptedDispatchCount, 1);
  assert.equal(calls, 2);
  h.queryWith(() => ({ Items: [item, item] }));
  await assert.rejects(provider.listInvocationUsageAggregates(request()), /journal/i);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(provider.listInvocationUsageAggregates({ ...request(), abortSignal: abort.signal }), { name: "AbortError" });
  calls = 0;
  h.queryWith(() => ({
    Items: [], LastEvaluatedKey: { ...cursor, sk: { S: `REQUEST#page-${++calls}` } },
  }));
  await assert.rejects(provider.listInvocationUsageAggregates(request()), /journal/i);
  assert.equal(calls, 100);
});

test("domain/project pairs never become a cross product and price changes invalidate pagination", async () => {
  const { createJournalUsageProvider } = await import("../lambda/operations/journal-usage.mjs");
  const h = harness();
  await success(h, "support-run");
  const foreign = binding("finance-run", "finance");
  await h.store.start(foreign);
  await h.store.markDispatched({ ...foreign, region: "us-west-2" });
  await h.store.complete({
    ...foreign, runtimeStatus: "SUCCEEDED", output: "Synthetic",
    invocationId: "provider-test", accounting: accounting("finance-run"),
  });
  const provider = createJournalUsageProvider({ compatibility, journal: h.store, priceBook: prices() });
  const admin = await provider.listInvocationUsageAggregates(request({
    type: "platform", domainIds: ["support", "finance"],
    projectIds: ["support/case-assist", "finance/different-project"],
  }));
  assert.equal(admin.items[0].acceptedDispatchCount, 1);
  assert.equal(admin.items[0].runCount, null);
  assert.equal(admin.items[0].estimatedCostUsd, .00035);
  const input = { ...request({
    type: "projects", domainIds: ["support"], projectIds: ["support/case-assist", "support/second"],
  }), limit: 1 };
  const first = await provider.listInvocationUsageAggregates(input);
  const changed = prices();
  changed.entries[0].usdPerMillionTokens.input = 99;
  const repriced = createJournalUsageProvider({ compatibility, journal: h.store, priceBook: changed });
  await assert.rejects(repriced.listInvocationUsageAggregates({ ...input, cursor: first.cursor }));
  await assert.rejects(provider.listInvocationUsageAggregates(request({
    type: "projects", domainIds: ["support"], projectIds: ["finance/case-assist"],
  })));
});

test("authorized cost API separates dispatch diagnostics from unavailable agent KPIs and preserves projections", async () => {
  const { createJournalUsageProvider } = await import("../lambda/operations/journal-usage.mjs");
  const h = harness();
  await success(h, "one");
  const projects = ["case-assist", "second"].map(id => ({
    id, domainId: "support", name: id, description: "", ownerSubject: "builder",
    memberSubjects: [], status: "ACTIVE", createdBySubject: "builder", createdAt: START,
  }));
  const service = createOperationsService({
    workspaceState: {
      ...Object.fromEntries(["beginTransaction", "getMutationResult", "getProject", "listIncidents",
        "getIncident", "putIncident", "listAuditMetadata", "listBreakGlass", "getBreakGlass", "putBreakGlass"]
        .map(name => [name, async () => { throw new Error("unexpected workflow call"); }])),
      async listProjects() { return { items: projects, cursor: null }; },
    },
    authorizer: async () => ({ ok: true }),
    cloudWatchProvider: { async listRuntimeAggregates() { throw new Error("must not read metrics"); } },
    usageProvider: createJournalUsageProvider({ compatibility,
      journal: h.store, priceBook: prices(), budgets: { "project:support/case-assist": 100 },
    }),
    clock: () => Date.parse(END), cursorSigningKey: "synthetic-cursor-key-0123456789abcdef",
  });
  const identity = { actor: "builder", role: "builder", activeDomain: "support", domainIds: ["support"] };
  const first = await service.listCosts({ identity, limit: 1 });
  assert.equal(first.items[0].acceptedDispatchCount, 1);
  assert.equal(first.items[0].runCount, null);
  assert.equal(first.items[0].invocationCount, null);
  assert.equal(first.items[0].costPerRunUsd, null);
  assert.equal(first.items[0].runCountUnavailableReason, "actual-execution-start-unavailable");
  assert.equal(first.items[0].estimatedCostUsd, 0.00035);
  assert.equal(first.items[0].knownEstimatedCostUsd, 0.00035);
  assert.equal(first.items[0].inputTokens, 100);
  assert.equal(first.items[0].outputTokens, 20);
  assert.equal(first.items[0].modelCoverage, "complete");
  assert.equal(first.items[0].monthlyBudgetUsd, 100);
  assert.equal(first.items[0].projectedMonthlyCostUsd, null);
  assert.equal(first.items[0].projectedBudgetUtilizationPercent, null);
  assert.equal(first.items[0].completeness, "partial");
  const second = await service.listCosts({ identity, limit: 1, cursor: first.cursor });
  assert.deepEqual(second.window, first.window);
  assert.equal(second.items[0].acceptedDispatchCount, 0);
  assert.equal(second.items[0].estimatedCostUsd, 0);
  assert.equal(second.items[0].runCount, null);
  assert.equal(second.items[0].costPerRunUsd, null);
  await assert.rejects(service.listCosts({ identity, limit: 1, cursor: first.cursor, window: "7d" }));
  const lead = await service.listCosts({ identity: { ...identity, role: "lead" } });
  const admin = await service.listCosts({ identity: { ...identity, role: "admin", activeDomain: null } });
  assert.equal(lead.items[0].estimatedCostUsd, first.items[0].estimatedCostUsd);
  assert.equal(admin.items[0].runCount, first.items[0].runCount);
  assert.equal(admin.items[0].acceptedDispatchCount, first.items[0].acceptedDispatchCount);
  assert.equal(lead.items[0].runCount, null);
  assert.equal(lead.items[0].costPerRunUsd, null);
  assert.equal(admin.items[0].costPerRunUsd, null);

  await h.store.start(binding("lost-before-send"));
  await h.store.markDispatched({ ...binding("lost-before-send"), region: "us-west-2" });
  const unresolved = (await service.listCosts({ identity })).items[0];
  assert.equal(unresolved.acceptedDispatchCount, 2);
  assert.equal(unresolved.unresolvedDispatchCount, 1);
  assert.equal(unresolved.runCount, null);
  assert.equal(unresolved.costPerRunUsd, null);
  assert.equal(unresolved.estimatedCostUsd, null);
  assert.equal(unresolved.knownEstimatedCostUsd, .00035);
  assert.equal(unresolved.modelCoverage, "partial");
  assert.equal(unresolved.projectedMonthlyCostUsd, null);
  assert.equal(unresolved.projectedBudgetUtilizationPercent, null);
});
