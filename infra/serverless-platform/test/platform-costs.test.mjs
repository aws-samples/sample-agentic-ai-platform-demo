import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformCostsReader } from "../lambda/operations/platform-costs.mjs";

const NOW = new Date("2026-09-13T10:00:00.000Z");

function explorer(responses) {
  const calls = [];
  return {
    calls,
    getCostAndUsage: async (params) => {
      calls.push(params);
      const key = `${params.TimePeriod.Start}/${params.TimePeriod.End}`;
      if (!(key in responses)) throw new Error(`Unexpected window ${key}`);
      const value = responses[key];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function window(groups, estimated = false) {
  return {
    ResultsByTime: [{
      Estimated: estimated,
      Groups: groups.map(([service, amount]) => ({
        Keys: [service],
        Metrics: { UnblendedCost: { Amount: amount, Unit: "USD" } },
      })),
    }],
  };
}

test("reads month-to-date and previous month grouped by service", async () => {
  const client = explorer({
    "2026-09-01/2026-09-13": window([["Amazon Bedrock", "12.50"], ["AWS Lambda", "0.75"]], true),
    "2026-08-01/2026-09-01": window([["Amazon Bedrock", "40.00"]]),
  });
  const reader = createPlatformCostsReader({ costExplorer: client, clock: () => NOW });
  const result = await reader.read();
  assert.equal(result.source, "aws-cost-explorer");
  assert.equal(result.currency, "USD");
  assert.equal(result.monthToDate.totalUsd, 13.25);
  assert.equal(result.monthToDate.estimated, true);
  assert.deepEqual(result.monthToDate.services[0], { service: "Amazon Bedrock", amountUsd: 12.5 });
  assert.equal(result.previousMonth.totalUsd, 40);
  assert.equal(result.previousMonth.startDate, "2026-08-01");
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[0].GroupBy, [{ Type: "DIMENSION", Key: "SERVICE" }]);
});

test("first-of-month keeps the MTD window non-empty", async () => {
  const first = new Date("2026-09-01T01:00:00.000Z");
  const client = explorer({
    "2026-09-01/2026-09-02": window([]),
    "2026-08-01/2026-09-01": window([]),
  });
  const reader = createPlatformCostsReader({ costExplorer: client, clock: () => first });
  const result = await reader.read();
  assert.equal(result.monthToDate.totalUsd, 0);
});

test("fails closed on malformed amounts and transport errors", async () => {
  for (const bad of [
    window([["Amazon Bedrock", "not-a-number"]]),
    { ResultsByTime: [] },
    { ResultsByTime: [{ Groups: [{ Keys: [], Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } } }] }] },
    new Error("throttled"),
  ]) {
    const client = explorer({
      "2026-09-01/2026-09-13": bad,
      "2026-08-01/2026-09-01": window([]),
    });
    const reader = createPlatformCostsReader({ costExplorer: client, clock: () => NOW });
    await assert.rejects(reader.read(), (error) => error.code === "PLATFORM_COSTS_UNAVAILABLE");
  }
});

test("caps the service list and rolls the tail into otherUsd", async () => {
  const groups = Array.from({ length: 30 }, (_, index) => [`Service ${index}`, `${30 - index}.00`]);
  const client = explorer({
    "2026-09-01/2026-09-13": window(groups),
    "2026-08-01/2026-09-01": window([]),
  });
  const reader = createPlatformCostsReader({ costExplorer: client, clock: () => NOW });
  const result = await reader.read();
  assert.equal(result.monthToDate.services.length, 25);
  assert.equal(result.monthToDate.otherUsd, 5 + 4 + 3 + 2 + 1);
  assert.equal(result.monthToDate.totalUsd, groups.reduce((sum, [, amount]) => sum + Number(amount), 0));
});
