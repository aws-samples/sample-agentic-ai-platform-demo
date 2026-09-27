import assert from "node:assert/strict";
import { GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { createProjectBudgetState } from "../../lambda/operations/budget-state.mjs";
const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const TOPIC = "arn:aws:sns:us-west-2:000000000000:synthetic-budget-test";
const scope = { domainId: "support", projectId: "case-assist" };
const config = overrides => ({
  schemaVersion: 1, ...scope, version: 1, currency: "USD", period: "CALENDAR_MONTH_UTC",
  monthlyLimitUsd: 10, thresholdPercent: 80, destination: TOPIC,
  updatedAt: new Date(NOW).toISOString(), updatedBy: "operator-sub", requestId: "budget-1", ...overrides,
});
const usage = overrides => ({
  scopeType: "project", ...scope, source: "experience-invocation-journal", environment: "PRODUCTION",
  windowBasis: "usage-occurrence-and-execution-start", runBoundary: "runtime-durable-start",
  runCount: 2, knownRunCount: 2, estimatedCostUsd: 8, knownEstimatedCostUsd: 8,
  modelCoverage: "complete", consistency: "eventual", pricingRevision: "a".repeat(64), pricingRevisions: ["a".repeat(64)],
  priceSources: [{ id: "synthetic", url: "https://example.invalid/prices",
    retrievedAt: "2026-09-01T00:00:00.000Z", effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveTo: "2026-10-01T00:00:00.000Z" }], updatedAt: new Date(NOW - 60_000).toISOString(), ...overrides,
});

// Atomic command model, not an AWS integration test. Conditions are checked
// against the original map before any transaction writes become visible.
function harness() {
  const items = new Map();
  const commands = [];
  let time = NOW;
  let before;
  let after;
  const storageKey = item => `${item.pk.S}|${item.sk.S}`;
  const conflict = transaction => {
    throw Object.assign(new Error("conditional conflict"), {
      name: transaction ? "TransactionCanceledException" : "ConditionalCheckFailedException",
      ...(transaction ? { CancellationReasons: [{ Code: "ConditionalCheckFailed" }] } : {}),
    });
  };
  function check(input, transactional) {
    const current = items.get(storageKey(input.Key ?? input.Item));
    const condition = input.ConditionExpression;
    if (condition === "attribute_not_exists(pk)") {
      if (current) conflict(transactional);
    } else {
      assert.equal(condition, "#revision = :version");
      assert.deepEqual(input.ExpressionAttributeNames, { "#revision": "revision" });
      if (!current || current.revision.N !== input.ExpressionAttributeValues[":version"].N) conflict(transactional);
    }
  }
  const dynamo = { async send(command) {
    commands.push(command);
    before?.(command);
    const input = command.input;
    assert.equal(input.TableName ?? input.TransactItems[0].Put?.TableName
      ?? input.TransactItems[0].ConditionCheck.TableName, "PlatformState");
    let response = {};
    if (command instanceof GetItemCommand) {
      assert.equal(input.ConsistentRead, true);
      response = { Item: structuredClone(items.get(storageKey(input.Key))) };
    } else if (command instanceof QueryCommand) {
      assert.equal(input.ConsistentRead, true);
      let matches = [...items.values()].filter(item => item.pk.S === input.ExpressionAttributeValues[":pk"].S
        && item.sk.S.startsWith(input.ExpressionAttributeValues[":prefix"].S)).sort((a, b) => a.sk.S.localeCompare(b.sk.S));
      if (input.ExclusiveStartKey) matches = matches.filter(item => item.sk.S > input.ExclusiveStartKey.sk.S);
      const page = matches.slice(0, input.Limit);
      response = { Items: structuredClone(page), ...(matches.length > page.length ? {
        LastEvaluatedKey: { pk: page.at(-1).pk, sk: page.at(-1).sk },
      } : {}) };
    } else if (command instanceof TransactWriteItemsCommand) {
      for (const operation of input.TransactItems) check(operation.Put ?? operation.ConditionCheck, true);
      for (const operation of input.TransactItems) {
        if (operation.Put) items.set(storageKey(operation.Put.Item), structuredClone(operation.Put.Item));
      }
    } else {
      assert.ok(command instanceof PutItemCommand);
      check(input, false);
      items.set(storageKey(input.Item), structuredClone(input.Item));
    }
    after?.(command);
    return response;
  } };
  const state = createProjectBudgetState({ tableName: "PlatformState", dynamo });
  return { state, dynamo, items, commands, clock: () => time,
    setTime(value) { time = value; }, before(fn) { before = fn; }, after(fn) { after = fn; } };
}
export { NOW, TOPIC, scope, config, usage, harness };
