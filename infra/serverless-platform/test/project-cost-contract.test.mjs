import assert from "node:assert/strict";
import test from "node:test";
import { createCloudWatchRuntimeProvider } from "../lambda/operations/runtime.mjs";
import { createCloudWatchUsageProvider } from "../lambda/operations/usage.mjs";

const scope = {
  type: "projects",
  domainIds: ["customer_support"],
  projectIds: ["customer_support/case-assist"],
};
const request = {
  scope,
  startTime: "2026-09-10T00:00:00.000Z",
  endTime: "2026-09-11T00:00:00.000Z",
  limit: 20,
};
function provider(values) {
  return createCloudWatchUsageProvider({
    runtimeProvider: {
      async listRuntimeAggregates() {
        return {
          items: [{
            scopeType: "project",
            domainId: "customer_support",
            projectId: "case-assist",
            runtimeCount: 1,
            healthyRuntimeCount: 1,
            invocationCount: 2,
            errorCount: 0,
            averageLatencyMs: 100,
            p95LatencyMs: 150,
            inputTokens: 1_000_000,
            outputTokens: 500_000,
            ...values,
          }],
          cursor: "next-page",
        };
      },
    },
    pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    budgets: { "project:customer_support/case-assist": 100 },
  });
}

test("legacy metrics without model, cache and price identity cannot be priced", async () => {
  const page = await provider().listInvocationUsageAggregates(request);
  assert.equal(page.items[0].estimatedCostUsd, null);
  assert.equal(page.cursor, "next-page");
});

test("unknown tokens survive the usage contract", async () => {
  const page = await provider({ inputTokens: null }).listInvocationUsageAggregates(request);
  assert.equal(page.items[0].inputTokens, null);
  assert.equal(page.items[0].estimatedCostUsd, null);
});

test("budget reader accepts service scope metadata and preserves USD units", async () => {
  const [budget] = await provider().listBudgets({
    scope,
    scopeKeys: ["project:customer_support/case-assist"],
    abortSignal: new AbortController().signal,
  });
  assert.equal(budget.monthlyLimitUsd, 100);
  assert.equal(budget.currency, "USD");
  assert.equal(Object.hasOwn(budget, "tokenBudget"), false);
});

test("absent CloudWatch datapoints stay unknown and dimensions match the emitter", async () => {
  const runtime = createCloudWatchRuntimeProvider({
    GetMetricDataCommand: class { constructor(input) { this.input = input; } },
    client: {
      async send({ input }) {
        assert.deepEqual(input.MetricDataQueries[0].MetricStat.Metric.Dimensions, [
          { Name: "ScopeType", Value: "project" },
          { Name: "DomainId", Value: "customer_support" },
          { Name: "ProjectId", Value: "case-assist" },
        ]);
        return {
          $metadata: { httpStatusCode: 200 },
          MetricDataResults: input.MetricDataQueries.map(({ Id }) => ({
            Id, StatusCode: "Complete", Timestamps: [], Values: [],
          })),
        };
      },
    },
  });
  const { items } = await runtime.listRuntimeAggregates(request);
  assert.equal(items[0].inputTokens, null);
  assert.equal(items[0].invocationCount, null);
});
