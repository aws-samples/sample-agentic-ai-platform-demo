import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloudWatchUsageProvider,
} from "../lambda/operations/usage.mjs";

function request(overrides = {}) {
  return {
    scope: {
      type: "projects",
      domainIds: ["customer_support"],
      projectIds: ["customer_support/case-assist"],
    },
    startTime: "2026-08-24T00:00:00.000Z",
    endTime: "2026-08-25T00:00:00.000Z",
    limit: 20,
    ...overrides,
  };
}

function aggregate(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test("usage provider preserves token metrics without assigning an unverified generic price", async () => {
  const calls = [];
  const provider = createCloudWatchUsageProvider({
    runtimeProvider: {
      async listRuntimeAggregates(input) {
        calls.push(input);
        return {
          items: [aggregate()],
          cursor: "next-page",
        };
      },
    },
    pricing: {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
    budgets: {
      platform: 1_000,
      "domain:customer_support": 500,
      "project:customer_support/case-assist": 100,
    },
  });

  const result = await provider.listInvocationUsageAggregates(request());

  assert.deepEqual(result, {
    items: [{
      scopeType: "project",
      domainId: "customer_support",
      projectId: "case-assist",
      invocationCount: 2,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      estimatedCostUsd: null,
    }],
    cursor: "next-page",
  });
  assert.deepEqual(calls, [request()]);
});

test("budget lookup returns only requested configured scopes", async () => {
  const provider = createCloudWatchUsageProvider({
    runtimeProvider: {
      async listRuntimeAggregates() {
        return { items: [], cursor: null };
      },
    },
    pricing: {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
    budgets: {
      platform: 1_000,
      "domain:customer_support": 500,
      "project:customer_support/case-assist": 100,
    },
  });

  const result = await provider.listBudgets({
    scopeKeys: [
      "project:customer_support/case-assist",
      "domain:customer_support",
    ],
  });

  assert.deepEqual(result, [
    {
      scopeType: "project",
      domainId: "customer_support",
      projectId: "case-assist",
      monthlyLimitUsd: 100,
      currency: "USD",
    },
    {
      scopeType: "domain",
      domainId: "customer_support",
      projectId: null,
      monthlyLimitUsd: 500,
      currency: "USD",
    },
  ]);
});

test("usage provider validates pricing, budgets, provider pages, and scope keys", async () => {
  assert.throws(
    () => createCloudWatchUsageProvider(),
    /configuration is invalid/i,
  );
  assert.throws(
    () => createCloudWatchUsageProvider({
      runtimeProvider: {
        async listRuntimeAggregates() {
          return { items: [], cursor: null };
        },
      },
      pricing: {
        inputUsdPerMillionTokens: -1,
        outputUsdPerMillionTokens: 15,
      },
      budgets: {},
    }),
    /configuration is invalid/i,
  );

  const malformed = createCloudWatchUsageProvider({
    runtimeProvider: {
      async listRuntimeAggregates() {
        return {
          items: [{ ...aggregate(), secret: "trace" }],
          cursor: null,
        };
      },
    },
    pricing: {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
    budgets: {},
  });
  await assert.rejects(
    malformed.listInvocationUsageAggregates(request()),
    /usage metrics are invalid/i,
  );
  await assert.rejects(
    malformed.listBudgets({ scopeKeys: ["project:invalid"] }),
    /budget scope is invalid/i,
  );
});

test("empty CloudWatch usage remains empty instead of fabricating records", async () => {
  const provider = createCloudWatchUsageProvider({
    runtimeProvider: {
      async listRuntimeAggregates() {
        return { items: [], cursor: null };
      },
    },
    pricing: {
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
    },
    budgets: {},
  });

  assert.deepEqual(
    await provider.listInvocationUsageAggregates(request()),
    { items: [], cursor: null },
  );
});
