import assert from "node:assert/strict";
import test from "node:test";
import { budgetWindow, evaluateProjectBudget } from "../lambda/operations/budgets.mjs";
import { createJournalUsageProvider } from "../lambda/operations/journal-usage.mjs";

const NOW = Date.parse("2026-09-11T12:00:42.000Z");
const scope = { domainId: "support", projectId: "case-assist" };
const config = {
  ...scope, schemaVersion: 1, version: 1, currency: "USD",
  period: "CALENDAR_MONTH_UTC", monthlyLimitUsd: 10, thresholdPercent: 80,
  destination: null, updatedAt: new Date(NOW).toISOString(),
  updatedBy: "lead-sub", requestId: "budget-1",
};
const priceSource = {
  id: "synthetic", url: "https://example.invalid/prices",
  retrievedAt: "2026-09-01T00:00:00.000Z",
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  effectiveTo: "2026-11-01T00:00:00.000Z",
};

function usage(overrides = {}) {
  return {
    scopeType: "project", ...scope, source: "experience-invocation-journal",
    environment: "PRODUCTION", windowBasis: "usage-occurrence-and-execution-start",
    runBoundary: "runtime-durable-start", runCount: 2, knownRunCount: 2,
    estimatedCostUsd: 8, knownEstimatedCostUsd: 8,
    modelCoverage: "complete", consistency: "eventual",
    pricingRevision: "a".repeat(64), pricingRevisions: ["a".repeat(64)],
    priceSources: [priceSource], updatedAt: "2026-09-11T11:59:00.000Z",
    ...overrides,
  };
}
const provider = row => ({
  async listInvocationUsageAggregates() { return { items: [row], cursor: null }; },
});

test("calendar UTC month has stable half-open bounds and a whole-minute observation cutoff", () => {
  assert.deepEqual(budgetWindow(NOW), {
    startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z",
    evaluatedThrough: "2026-09-11T12:00:00.000Z", timezone: "UTC", interval: "[start,end)",
  });
  assert.equal(budgetWindow(Date.parse("2028-02-29T23:59:00.000Z")).endTime, "2028-03-01T00:00:00.000Z");
});

test("equality crosses from attributed usage with partial coverage and actual-run KPI", async () => {
  const result = await evaluateProjectBudget({ config, usageProvider: provider(usage()), now: NOW });
  assert.equal(result.status, "CROSSED");
  assert.equal(result.thresholdUsd, 8);
  assert.equal(result.costPerRunUsd, 4);
  assert.equal(result.coverage.project, "partial");
  assert.equal(result.basis, "estimate");
  assert.equal(result.source, "experience-invocation-journal");
});

test("below threshold, empty history and missing prices never assert under-budget zero", async () => {
  for (const row of [
    usage({ estimatedCostUsd: 7, knownEstimatedCostUsd: 7 }),
    usage({ estimatedCostUsd: 0, knownEstimatedCostUsd: 0, runCount: 0, priceSources: [], updatedAt: null }),
    usage({ estimatedCostUsd: null, knownEstimatedCostUsd: 0, priceSources: [], modelCoverage: "unavailable" }),
  ]) {
    const result = await evaluateProjectBudget({ config, usageProvider: provider(row), now: NOW });
    assert.ok(["UNKNOWN", "INCOMPLETE"].includes(result.status));
    assert.notEqual(result.status, "UNDER_BUDGET");
  }
});

test("known partial lower bound may cross; stale or absent pricing cannot establish a crossing", async () => {
  const partial = await evaluateProjectBudget({
    config, usageProvider: provider(usage({ estimatedCostUsd: null, modelCoverage: "partial" })), now: NOW,
  });
  assert.equal(partial.status, "CROSSED");
  assert.equal(partial.costPerRunUsd, null);
  const stale = await evaluateProjectBudget({
    config, usageProvider: provider(usage({ priceSources: [{ ...priceSource, retrievedAt: "2026-01-01T00:00:00.000Z" }] })), now: NOW,
  });
  assert.equal(stale.status, "UNKNOWN");
  assert.equal(stale.knownEstimatedCostUsd, null);
});

test("month query splits at provider's 30-day bound without overlapping intervals", async () => {
  const calls = [];
  const result = await evaluateProjectBudget({
    config, now: Date.parse("2026-10-31T23:59:30.000Z"),
    usageProvider: { async listInvocationUsageAggregates(input) {
      calls.push(input);
      return { items: [usage({
        estimatedCostUsd: 4, knownEstimatedCostUsd: 4,
        updatedAt: "2026-10-31T23:58:00.000Z",
        priceSources: [{ ...priceSource, retrievedAt: "2026-10-15T00:00:00.000Z" }],
      })], cursor: null };
    } },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].startTime, "2026-10-01T00:00:00.000Z");
  assert.equal(calls[0].endTime, calls[1].startTime);
  assert.equal(calls[1].endTime, "2026-10-31T23:59:00.000Z");
  assert.equal(result.knownEstimatedCostUsd, 8);
  assert.equal(result.runCount, 4);
});

test("common native journal provider enforces occurrence boundaries and rejects duplicate run rows", async () => {
  const record = (runId, occurredAt) => ({
    ...scope, runId, createdAt: occurredAt, completedAt: occurredAt,
    phase: "COMPLETED", runtimeStatus: "SUCCEEDED", lifecycle: { startedAt: occurredAt },
    nativeExecution: {
      startedAt: occurredAt, terminal: { status: "SUCCEEDED", completedAt: occurredAt },
      usage: { occurredAt, price: {
        estimatedCostUsd: 8, priceSource, pricingRevision: "a".repeat(64),
      }, observation: { usage: { inputTokens: 1, outputTokens: 1 } } },
    },
  });
  let rows = [
    record("start", "2026-09-01T00:00:00.000Z"),
    record("excluded", "2026-09-11T12:00:00.000Z"),
  ];
  const common = createJournalUsageProvider({
    journal: { async listByProject() { return { items: rows, cursor: null }; } },
    nativeExecution: true, compatibility: { readerVersion: "cost-v1", writerVersion: "cost-v1" },
  });
  const result = await evaluateProjectBudget({ config, usageProvider: common, now: NOW });
  assert.equal(result.knownEstimatedCostUsd, 8);
  assert.equal(result.runCount, 1);
  rows = [rows[0], rows[0]];
  const duplicate = await evaluateProjectBudget({ config, usageProvider: common, now: NOW });
  assert.equal(duplicate.status, "UNKNOWN");
  assert.equal(duplicate.knownEstimatedCostUsd, null);
});

test("stale usage and missing native starts remain explicit and never use dispatch denominator", async () => {
  const stale = await evaluateProjectBudget({ config, now: NOW, usageProvider: provider(usage({
    estimatedCostUsd: 7, knownEstimatedCostUsd: 7, updatedAt: "2026-09-01T00:00:00.000Z",
  })) });
  assert.equal(stale.status, "INCOMPLETE");
  assert.ok(stale.reasons.includes("stale-usage"));
  const unknownRuns = await evaluateProjectBudget({ config, now: NOW,
    usageProvider: provider(usage({ runCount: null, acceptedDispatchCount: 200 })) });
  assert.equal(unknownRuns.status, "CROSSED");
  assert.equal(unknownRuns.costPerRunUsd, null);
  const dispatch = await evaluateProjectBudget({ config, now: NOW, usageProvider: provider(usage({
    runBoundary: undefined, windowBasis: "dispatch-start-cohort", acceptedDispatchCount: 1000,
  })) });
  assert.equal(dispatch.status, "UNKNOWN");
  assert.equal(dispatch.runCount, null);
});

test("month start has no observed interval and no false zero; source errors and foreign rows fail closed", async () => {
  let reads = 0;
  const midnight = await evaluateProjectBudget({ config, now: Date.parse("2026-10-01T00:00:30.000Z"),
    usageProvider: { async listInvocationUsageAggregates() { reads++; throw new Error("must not read"); } } });
  assert.equal(midnight.status, "UNKNOWN");
  assert.equal(midnight.knownEstimatedCostUsd, null);
  assert.equal(reads, 0);
  const foreign = await evaluateProjectBudget({ config, now: NOW, usageProvider: provider(usage({ domainId: "finance" })) });
  assert.equal(foreign.status, "UNKNOWN");
  assert.equal(foreign.knownEstimatedCostUsd, null);
});
