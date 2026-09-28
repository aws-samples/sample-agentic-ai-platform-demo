import assert from "node:assert/strict";
import test from "node:test";
import { historicalSource } from "./fixtures/compatibility/read-source.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as current from "../lambda/experience/invocation-store.mjs";
import { createJournalUsageProvider } from "../lambda/operations/journal-usage.mjs";
import { createOperationsService } from "../lambda/operations/service.mjs";
import { createConfiguredExperienceHandler } from "../lambda/experience/runtime.mjs";
import { costJournalEnabled, journalCompatibilityFromEnv } from "../lambda/experience/journal-compatibility.mjs";

const file = "experience/invocation-store.mjs";
const require = createRequire(import.meta.url);
const sdkUrl = pathToFileURL(require.resolve("@aws-sdk/client-dynamodb")).href;
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const historical = {};
// Pin the reader AND its local validator without requiring historical commits.
for (const sha of [
  "38b31309793b6b65bb1e9d4f6a07ea013ae1bc44",
  "1feeae25f786da0a952102f62f18044eb70ce4da",
  "4e4a5fe916994d4ce8ba4b4ca03df53ffa51484b",
]) {
  const show = path => historicalSource(sha, path);
  let source = show(file).replaceAll('"@aws-sdk/client-dynamodb"', JSON.stringify(sdkUrl));
  if (source.includes('"../agent-runtime/usage.mjs"')) {
    source = source.replaceAll('"../agent-runtime/usage.mjs"',
      JSON.stringify(dataUrl(show("agent-runtime/usage.mjs"))));
  }
  historical[sha] = await import(dataUrl(source));
}
const [legacy, accountingReader, lifecycleReader] = Object.values(historical);
const enabled = { writerVersion: "cost-v1", readerVersion: "cost-v1" };
const NOW = "2026-09-10T12:00:00.000Z";
const input = {
  actor: "synthetic-user", requestId: "synthetic-request", payloadFingerprint: "a".repeat(64),
  sessionId: "session-0123456789abcdef-abcdef0123456789", domainId: "support",
  projectId: "test-project", agentId: "test-agent", baselineFingerprint: null,
};
const get = { actor: input.actor, requestId: input.requestId, payloadFingerprint: input.payloadFingerprint };
const completion = {
  ...input, runtimeStatus: "SUCCEEDED", output: "Synthetic output", invocationId: "test-id",
};
const accounting = {
  version: 1, runId: createHash("sha256").update(`${input.actor}\0${input.requestId}`).digest("hex"),
  attemptId: "gateway-1", environment: "PRODUCTION", purpose: "user", modelId: "test-model",
  providerRequestId: null, traceId: null, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  metering: null, execution: null, pricingVersion: null, estimatedCostUsd: null,
};

function harness(module = current, compatibility) {
  let item;
  const commands = [];
  const dynamo = { async send(command) {
    commands.push(command.input);
    const value = command.input;
    if (command.constructor.name === "GetItemCommand") return { Item: structuredClone(item) };
    if (command.constructor.name === "PutItemCommand") {
      assert.equal(item, undefined);
      item = structuredClone(value.Item);
      return {};
    }
    assert.equal(command.constructor.name, "UpdateItemCommand");
    if (item.phase.S !== "STARTED") {
      throw Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
    }
    for (const assignment of value.UpdateExpression.replace(/^SET /, "").split(", ")) {
      const [name, key] = assignment.split(" = ");
      item[value.ExpressionAttributeNames[name]] = structuredClone(value.ExpressionAttributeValues[key]);
    }
    return { Attributes: structuredClone(item) };
  } };
  const store = module.createExperienceInvocationStore({
    tableName: "Synthetic", dynamo, now: () => new Date(NOW), compatibility,
  });
  return { store, dynamo, commands, row: () => structuredClone(item) };
}

function read(module, item) {
  return module.createExperienceInvocationStore({
    tableName: "Synthetic", now: () => new Date(NOW),
    dynamo: { async send() { return { Item: structuredClone(item) }; } },
  }).get(get);
}

test("disabled new writer emits exactly old writer rows/commands even when Runtime supplies accounting", async () => {
  for (const compatibility of [undefined, {}, { writerVersion: "legacy" }, { readerVersion: "cost-v1" }]) {
    const old = harness(legacy);
    const next = harness(current, compatibility);
    await old.store.start(input);
    await next.store.start(input);
    assert.deepEqual(next.row(), old.row());
    assert.equal(next.store.markDispatched, undefined);
    assert.equal((await read(legacy, next.row())).phase, "STARTED");
    await old.store.complete(completion);
    const result = await next.store.complete({ ...completion, accounting });
    assert.equal(Object.hasOwn(result, "accounting"), false);
    assert.deepEqual(next.row(), old.row());
    assert.deepEqual(next.commands, old.commands);
    assert.deepEqual(await next.store.complete({ ...completion, accounting }), result);
    for (const reader of [legacy, accountingReader, lifecycleReader, current]) {
      assert.equal((await read(reader, next.row())).output, completion.output);
    }
  }
});

test("actual old writers remain readable by the new reader in reservation, success and failure states", async () => {
  for (const writer of [legacy, accountingReader]) {
    for (const status of ["SUCCEEDED", "FAILED"]) {
      const h = harness(writer);
      await h.store.start(input);
      assert.equal((await read(current, h.row())).phase, "STARTED");
      await h.store.complete(status === "FAILED"
        ? { ...input, runtimeStatus: status, output: null, invocationId: null }
        : { ...completion, ...(writer === accountingReader ? { accounting } : {}) });
      assert.equal((await read(current, h.row())).runtimeStatus, status);
      if (writer === accountingReader && status === "SUCCEEDED") {
        await assert.rejects(read(legacy, h.row()), { code: "INVOCATION_JOURNAL_CONFLICT" });
        assert.deepEqual(await read(accountingReader, h.row()), await read(current, h.row()));
        assert.deepEqual(await read(lifecycleReader, h.row()), await read(current, h.row()));
      }
    }
  }
});

test("disabled failure writes retain the legacy failure shape", async () => {
  const old = harness(legacy);
  const next = harness();
  for (const h of [old, next]) {
    await h.store.start(input);
    await h.store.complete({ ...input, runtimeStatus: "FAILED", output: null, invocationId: null });
  }
  assert.deepEqual(next.commands, old.commands);
  assert.equal((await read(legacy, next.row())).runtimeStatus, "FAILED");
});

test("enabled reservations, dispatch markers and completions expose the actual old-reader incompatibility", async () => {
  const h = harness(current, enabled);
  await h.store.start(input);
  const pending = h.row();
  await h.store.markDispatched({ ...input, region: "us-west-2" });
  const dispatched = h.row();
  await h.store.complete({ ...completion, accounting });
  const completed = h.row();
  for (const row of [pending, dispatched, completed]) {
    for (const reader of [legacy, accountingReader]) {
      await assert.rejects(read(reader, row), { code: "INVOCATION_JOURNAL_CONFLICT" });
    }
    assert.deepEqual(await read(current, row), await read(lifecycleReader, row));
  }
  assert.deepEqual((await read(current, completed)).accounting, accounting);
});

test("writer activation requires the exact explicit compatible-reader capability", () => {
  for (const compatibility of [
    { writerVersion: "cost-v1" }, { writerVersion: "cost-v1", readerVersion: "legacy" },
    { writerVersion: "cost-v1", readerVersion: "accounting-v1" },
    { writerVersion: "true", readerVersion: "cost-v1" }, { writerVersion: true },
    { writerVersion: "" }, { writerVersion: null }, { readerVersion: "COST-V1" },
    { writeVersion: "cost-v1", readerVersion: "cost-v1" },
  ]) assert.throws(() => harness(current, compatibility), /compatibility/i);
});

test("production environment requires explicit versions and never enables from reader capability alone", async () => {
  for (const env of [{}, { EXPERIENCE_JOURNAL_READER_VERSION: "cost-v1" }]) {
    assert.equal(costJournalEnabled(journalCompatibilityFromEnv(env)), false);
  }
  const clients = {
    dynamo: { async send() { assert.fail("no cloud calls"); } },
    agentRuntimeClient: { async send() { assert.fail("no Runtime calls"); } },
    secretsClient: { async send() { assert.fail("no secret calls"); } },
    cognito: { async send() { assert.fail("no Cognito calls"); } },
  };
  for (const readerVersion of [undefined, "legacy", "accounting-v1", "true"]) {
    await assert.rejects(createConfiguredExperienceHandler({
      ...clients, env: { PLATFORM_STATE_TABLE_NAME: "Synthetic",
        EXPERIENCE_JOURNAL_WRITE_VERSION: "cost-v1", EXPERIENCE_JOURNAL_READER_VERSION: readerVersion },
    }), /compatibility/i);
  }
  const compatibility = journalCompatibilityFromEnv({
    EXPERIENCE_JOURNAL_WRITE_VERSION: "cost-v1", EXPERIENCE_JOURNAL_READER_VERSION: "cost-v1",
  });
  assert.deepEqual(compatibility, enabled);
  assert.equal(costJournalEnabled(compatibility), true);
});

test("after disabling, terminal delivery remains idempotent without dropping retained accounting", async () => {
  const h = harness(current, enabled);
  await h.store.start(input);
  await h.store.markDispatched({ ...input, region: "us-west-2" });
  const result = await h.store.complete({ ...completion, accounting });
  const before = h.row();
  const disabled = current.createExperienceInvocationStore({
    tableName: "Synthetic", dynamo: h.dynamo, now: () => new Date(NOW),
  });
  assert.equal(disabled.markDispatched, undefined);
  assert.deepEqual(await disabled.complete({ ...completion, accounting }), result);
  await assert.rejects(disabled.complete({
    ...completion, accounting: { ...accounting, providerRequestId: "changed" },
  }), { code: "INVOCATION_JOURNAL_CONFLICT" });
  assert.deepEqual(h.row(), before);
});

test("disabling writes preserves existing records and cannot authorize an incompatible rollback", async () => {
  const h = harness(current, enabled);
  await h.store.start(input);
  const pending = h.row();
  await h.store.markDispatched({ ...input, region: "us-west-2" });
  await h.store.complete({ ...completion, accounting });
  const completed = h.row();
  assert.deepEqual((await read(current, completed)).accounting, accounting);
  assert.deepEqual(h.row(), completed);
  const oldAccounting = harness(accountingReader);
  await oldAccounting.store.start(input);
  await oldAccounting.store.complete({ ...completion, accounting });
  const oldLegacy = harness(legacy);
  await oldLegacy.store.start(input);
  const check = (items, readerVersion = "legacy", changes = {}) =>
    current.assertInvocationJournalRollbackSafe({
      items, readerVersion, writerVersion: "legacy",
      writersDrained: true, inventoryComplete: true, ...changes,
    });
  assert.equal(check([oldLegacy.row()]), true);
  assert.equal(check([oldAccounting.row()], "accounting-v1"), true);
  assert.equal(check([pending, completed, oldAccounting.row()], "cost-v1"), true);
  for (const row of [pending, completed, oldAccounting.row()]) {
    assert.throws(() => check([row]), { code: "UNSAFE_INVOCATION_JOURNAL_ROLLBACK" });
  }
  assert.throws(() => check([pending], "accounting-v1"), { code: "UNSAFE_INVOCATION_JOURNAL_ROLLBACK" });
  for (const changes of [
    { writerVersion: "cost-v1" }, { writerVersion: undefined }, { writersDrained: false },
    { writersDrained: undefined }, { inventoryComplete: false }, { inventoryComplete: undefined },
    { readerVersion: "unknown" }, { items: undefined }, { items: [{}] },
  ]) assert.throws(() => check([], "legacy", changes));
});

test("gated costs return unavailable before any journal query, including empty scopes", async () => {
  let reads = 0;
  const usageProvider = createJournalUsageProvider({
    journal: { async listByProject() { reads += 1; return { items: [], cursor: null }; } },
  });
  for (const projectIds of [[], ["support/test-project"]]) {
    await assert.rejects(usageProvider.listInvocationUsageAggregates({
      scope: { type: "projects", domainIds: ["support"], projectIds },
      startTime: "2026-09-10T00:00:00.000Z", endTime: "2026-09-11T00:00:00.000Z", limit: 20,
    }), /unavailable/i);
  }
  const service = createOperationsService({
    workspaceState: {
      ...Object.fromEntries(["beginTransaction", "getMutationResult", "getProject", "listIncidents",
        "getIncident", "putIncident", "listAuditMetadata", "listBreakGlass", "getBreakGlass", "putBreakGlass"]
        .map(name => [name, async () => { throw new Error("unexpected workflow"); }])),
      async listProjects() { return { items: [], cursor: null }; },
    },
    usageProvider, authorizer: async () => ({ ok: true }),
    cloudWatchProvider: { async listRuntimeAggregates() { throw new Error("unexpected metrics"); } },
    clock: () => Date.parse(NOW), cursorSigningKey: "synthetic-cursor-key-0123456789abcdef",
  });
  await assert.rejects(service.listCosts({
    identity: { actor: "builder", role: "builder", activeDomain: "support", domainIds: ["support"] },
  }), { code: "OPERATIONS_UNAVAILABLE" });
  assert.equal(reads, 0);
});
