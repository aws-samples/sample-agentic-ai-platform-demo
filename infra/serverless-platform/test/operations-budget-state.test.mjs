import assert from "node:assert/strict";
import test from "node:test";
import { GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { createProjectBudgetState } from "../lambda/operations/budget-state.mjs";
import { createBudgetDelivery } from "../lambda/operations/budget-delivery.mjs";
import { budgetAlertId, evaluateProjectBudget } from "../lambda/operations/budgets.mjs";
import { createOperationsRuntime } from "../lambda/operations/handler-runtime.mjs";
import { createJournalUsageProvider } from "../lambda/operations/journal-usage.mjs";

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

async function crossing(h, changes) {
  const budget = await h.state.writeConfig(config(changes), 0);
  const evaluation = await evaluateProjectBudget({
    config: budget, now: h.clock(),
    usageProvider: { async listInvocationUsageAggregates() { return { items: [usage()], cursor: null }; } },
  });
  return h.state.recordCrossing(budget, evaluation);
}
const alerts = h => h.state.listAlerts(scope);
const notifier = (h, publisher, destination = TOPIC, budgetState = h.state) => createBudgetDelivery({
  budgetState, publisher, destination, clock: h.clock,
});

test("config write atomically records durable idempotent result; stale or changed request conflicts", async () => {
  const h = harness();
  const original = await h.state.writeConfig(config(), 0);
  assert.deepEqual(await h.state.writeConfig(config({ updatedAt: new Date(NOW + 1).toISOString() }), 0), original);
  await assert.rejects(h.state.writeConfig(config({ monthlyLimitUsd: 11 }), 0), { code: "CONFLICT" });
  await h.state.writeConfig(config({ version: 2, requestId: "budget-2", monthlyLimitUsd: 20 }), 1);
  assert.deepEqual(await h.state.writeConfig(config(), 0), original);
  assert.equal((await h.state.getConfig(scope)).version, 2);
  await assert.rejects(h.state.writeConfig(config({ version: 2, requestId: "stale" }), 1), { code: "CONFLICT" });
  assert.equal(h.items.size, 3);
});

test("competing config writers have one conditional winner", async () => {
  const h = harness();
  const results = await Promise.allSettled([
    h.state.writeConfig(config(), 0), h.state.writeConfig(config({ requestId: "other" }), 0),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "CONFLICT");
  assert.equal(h.items.size, 2);
});

test("duplicate/concurrent evaluations create exactly one semantic crossing/outbox", async () => {
  const h = harness();
  const first = await crossing(h);
  const results = await Promise.all(Array.from({ length: 8 }, () => h.state.recordCrossing(config(), first.evaluation)));
  assert.ok(results.every(record => record.id === first.id && record.revision === 1));
  assert.equal((await alerts(h)).items.length, 1);
  assert.equal(first.id, budgetAlertId(config(), first.evaluation.window));
  assert.notEqual(first.id, budgetAlertId(config({ version: 2 }), first.evaluation.window));
  assert.notEqual(first.id, budgetAlertId(config({ domainId: "finance" }), first.evaluation.window));
});

test("atomic crossing persists across response loss and does not use existing entity indexes", async () => {
  const h = harness();
  let lost = false;
  h.after(command => {
    if (!lost && command instanceof TransactWriteItemsCommand && command.input.TransactItems[0].ConditionCheck) {
      lost = true;
      throw new Error("simulated process loss after commit");
    }
  });
  await assert.rejects(crossing(h), /process loss/);
  h.after(null);
  const stored = (await alerts(h)).items[0];
  assert.equal(stored.status, "PENDING");
  assert.deepEqual(await h.state.recordCrossing(config(), stored.evaluation), stored);
  for (const item of h.items.values()) {
    assert.match(item.pk.S, /^PROJECT_BUDGET#support#case-assist$/);
    assert.deepEqual(Object.keys(item).sort(), ["pk", "record", "revision", "sk"]);
  }
});

test("config update racing an evaluation prevents stale-version outbox creation", async () => {
  const h = harness();
  const original = await crossing(h);
  await h.state.writeConfig(config({ version: 2, requestId: "second" }), 1);
  await assert.rejects(h.state.recordCrossing(config(), original.evaluation), { code: "CONFLICT" });
  assert.equal((await alerts(h)).items.length, 1);
});

test("missing destination and missing publisher are explicit, never delivery success", async () => {
  for (const destination of [null, TOPIC]) {
    const h = harness();
    await crossing(h, { destination });
    const result = await notifier(h, null, destination).deliverProject(scope);
    assert.equal(result.items[0].status, destination === null ? "UNCONFIGURED" : "PUBLISHER_UNAVAILABLE");
    assert.equal(result.items[0].attempts, 0);
    assert.equal(result.items[0].providerMessageId, null);
    assert.equal(result.items[0].recipientReceipt, "UNVERIFIED");
  }
});

test("concurrent delivery claims send once; MessageId is only provider acceptance", async () => {
  const h = harness();
  const original = await crossing(h);
  const sends = [];
  const delivery = notifier(h, { async publish(input) {
    sends.push(input);
    assert.equal(input.destination, TOPIC);
    assert.equal(input.idempotencyKey, original.id);
    const message = JSON.parse(input.message);
    assert.equal(message.knownEstimatedCostUsd, 8);
    assert.equal(message.coverage.project, "partial");
    assert.equal(message.window.interval, "[start,end)");
    assert.equal(message.asOf, new Date(NOW).toISOString());
    assert.equal(message.pricing.sources[0].id, "synthetic");
    assert.equal(message.updatedBy, undefined);
    return { MessageId: "provider-accepted-1" };
  } });
  await Promise.all([delivery.deliverProject(scope), delivery.deliverProject(scope), delivery.deliverProject(scope)]);
  await delivery.deliverProject(scope);
  assert.equal(sends.length, 1);
  const stored = (await alerts(h)).items[0];
  assert.equal(stored.status, "PROVIDER_ACCEPTED");
  assert.equal(stored.recipientReceipt, "UNVERIFIED");
  assert.equal(stored.attempts, 1);
});

test("transient failure retries the same alert after bounded backoff then exhausts at three attempts", async () => {
  const h = harness();
  const original = await crossing(h);
  const ids = [];
  const delivery = notifier(h, { async publish(input) {
    ids.push(input.idempotencyKey);
    throw Object.assign(new Error("retry"), { name: "ThrottlingException" });
  } });
  await delivery.deliverProject(scope);
  await delivery.deliverProject(scope);
  assert.equal(ids.length, 1);
  h.setTime(NOW + 60_000);
  await delivery.deliverProject(scope);
  h.setTime(NOW + 180_000);
  await delivery.deliverProject(scope);
  h.setTime(NOW + 999_000);
  await delivery.deliverProject(scope);
  assert.deepEqual(ids, [original.id, original.id, original.id]);
  assert.equal((await alerts(h)).items[0].status, "EXHAUSTED");
});

test("retry succeeds without a second crossing; permanent failure stops retrying", async () => {
  const h = harness();
  await crossing(h);
  let count = 0;
  const delivery = notifier(h, { async publish() {
    if (++count === 1) throw Object.assign(new Error("temporary"), { retryable: true });
    return { MessageId: "accepted-after-retry" };
  } });
  await delivery.deliverProject(scope);
  h.setTime(NOW + 60_000);
  await delivery.deliverProject(scope);
  assert.equal((await alerts(h)).items[0].status, "PROVIDER_ACCEPTED");
  assert.equal((await alerts(h)).items.length, 1);
  const permanent = harness();
  await crossing(permanent);
  let failures = 0;
  const fail = notifier(permanent, { async publish() { failures++; throw new Error("permission denied"); } });
  await fail.deliverProject(scope);
  permanent.setTime(NOW + 60_000);
  await fail.deliverProject(scope);
  assert.equal(failures, 1);
  assert.equal((await alerts(permanent)).items[0].status, "FAILED");
});

test("provider accepted then storage crashed: expired lease retries with possible duplicate, never claims receipt", async () => {
  const h = harness();
  await crossing(h);
  let crash = true;
  let sends = 0;
  const state = { ...h.state, async saveAlert(previous, next, current) {
    if (next.status === "PROVIDER_ACCEPTED" && crash) {
      crash = false;
      throw new Error("crash after provider acceptance");
    }
    return h.state.saveAlert(previous, next, current);
  } };
  const delivery = notifier(h, { async publish() { sends++; return { MessageId: `accepted-${sends}` }; } }, TOPIC, state);
  await assert.rejects(delivery.deliverProject(scope), /crash/);
  assert.equal((await alerts(h)).items[0].status, "SENDING");
  await delivery.deliverProject(scope);
  assert.equal(sends, 1);
  h.setTime(NOW + 30_000);
  await delivery.deliverProject(scope);
  assert.equal(sends, 2);
  assert.equal((await alerts(h)).items[0].recipientReceipt, "UNVERIFIED");
});

test("lease replacement fences a delayed provider response from overwriting newer result", async () => {
  const h = harness();
  await crossing(h);
  let release;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let calls = 0;
  const delivery = notifier(h, { async publish() {
    if (++calls === 1) { enter(); return new Promise(resolve => { release = resolve; }); }
    return { MessageId: "new-lease-acceptance" };
  } });
  const first = delivery.deliverProject(scope);
  await entered;
  h.setTime(NOW + 30_000);
  await delivery.deliverProject(scope);
  release({ MessageId: "old-lease-acceptance" });
  await first;
  assert.equal((await alerts(h)).items[0].providerMessageId, "new-lease-acceptance");
});

test("destination changes never reroute pending versions; updated versions supersede old alerts", async () => {
  const h = harness();
  await crossing(h);
  let sends = 0;
  const newTopic = `${TOPIC}-new`;
  const delivery = notifier(h, { async publish() { sends++; return { MessageId: "x" }; } }, newTopic);
  await delivery.deliverProject(scope);
  assert.equal((await alerts(h)).items[0].status, "DESTINATION_MISMATCH");
  await h.state.writeConfig(config({ version: 2, requestId: "new-config", destination: newTopic }), 1);
  await delivery.deliverProject(scope);
  assert.equal((await alerts(h)).items[0].status, "SUPERSEDED");
  assert.equal((await alerts(h)).items[0].destination, TOPIC);
  assert.equal(sends, 0);
});

test("invalid stored records and foreign continuation keys fail closed", async () => {
  const h = harness();
  await crossing(h);
  await assert.rejects(h.state.listAlerts(scope, { pk: { S: "PROJECT_BUDGET#finance#other" },
    sk: { S: `ALERT#${"a".repeat(64)}` } }), { code: "INVALID_REQUEST" });
  const stored = [...h.items.values()].find(item => item.sk.S === "CONFIG");
  stored.extra = { S: "invalid schema" };
  await assert.rejects(h.state.getConfig(scope), { code: "OPERATIONS_UNAVAILABLE" });
});

test("bounded outbox pagination returns every semantic alert once, including older versions", async () => {
  const h = harness();
  let budget;
  for (let version = 1; version <= 12; version++) {
    budget = await h.state.writeConfig(config({ version, requestId: `version-${version}` }), version - 1);
    const evaluation = await evaluateProjectBudget({ config: budget, now: NOW,
      usageProvider: { async listInvocationUsageAggregates() { return { items: [usage()], cursor: null }; } } });
    await h.state.recordCrossing(budget, evaluation);
  }
  const delivery = notifier(h, null);
  const page1 = await delivery.deliverProject(scope);
  const page2 = await delivery.deliverProject(scope, page1.cursor);
  assert.equal(page1.items.length, 10);
  assert.equal(page2.items.length, 2);
  assert.equal(page2.cursor, null);
  assert.equal(new Set([...page1.items, ...page2.items].map(alert => alert.id)).size, 12);
  assert.equal([...page1.items, ...page2.items].filter(alert => alert.status === "SUPERSEDED").length, 11);
});

test("failed transaction writes neither a config nor its replay result", async () => {
  const h = harness();
  h.before(command => {
    if (command instanceof TransactWriteItemsCommand) throw new Error("synthetic storage unavailable");
  });
  await assert.rejects(h.state.writeConfig(config(), 0), /storage unavailable/);
  assert.equal(h.items.size, 0);
  h.before(null);
  assert.equal((await h.state.writeConfig(config(), 0)).version, 1);
});

test("a config update between delivery read and claim prevents any publish", async () => {
  const h = harness();
  await crossing(h);
  let publishes = 0;
  const state = { ...h.state, async saveAlert(previous, next, current) {
    if (current) await h.state.writeConfig(config({ version: 2, requestId: "racing-version" }), 1);
    return h.state.saveAlert(previous, next, current);
  } };
  await notifier(h, { async publish() { publishes++; return { MessageId: "unexpected" }; } }, TOPIC, state).deliverProject(scope);
  assert.equal(publishes, 0);
  assert.equal((await alerts(h)).items[0].status, "PENDING");
});

test("missing MessageId is an ambiguous retry, never provider or recipient delivery", async () => {
  const h = harness();
  await crossing(h);
  const result = await notifier(h, { async publish() { return {}; } }).deliverProject(scope);
  assert.equal(result.items[0].status, "RETRY");
  assert.equal(result.items[0].providerMessageId, null);
  assert.equal(result.items[0].recipientReceipt, "UNVERIFIED");
});

test("a hung publisher is aborted at five seconds and leaves a retryable durable record", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  await crossing(h);
  let entered;
  let signal;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = notifier(h, { async publish(input) {
    signal = input.abortSignal;
    entered();
    return new Promise(() => {});
  } }).deliverProject(scope);
  await started;
  t.mock.timers.tick(5_000);
  const result = await pending;
  assert.equal(signal.aborted, true);
  assert.equal(result.items[0].status, "RETRY");
  assert.equal(result.items[0].attempts, 1);
});

test("corrupted outbox cost provenance is rejected before publishing", async () => {
  const h = harness();
  await crossing(h);
  const stored = [...h.items.values()].find(item => item.sk.S.startsWith("ALERT#"));
  const record = JSON.parse(stored.record.S);
  record.evaluation.source = "caller-cost";
  stored.record.S = JSON.stringify(record);
  let published = false;
  await assert.rejects(notifier(h, { async publish() { published = true; } }).deliverProject(scope), { code: "OPERATIONS_UNAVAILABLE" });
  assert.equal(published, false);
});

function api(h, { publisher = null, destination = TOPIC, projectOverride, usageOverride, usageProvider } = {}) {
  const project = { domainId: scope.domainId, id: scope.projectId, name: "Synthetic", description: "",
    ownerSubject: "builder-sub", memberSubjects: ["builder-sub"], status: "ACTIVE",
    createdBySubject: "builder-sub", createdAt: "2026-09-01T00:00:00.000Z", ...projectOverride };
  const reads = [];
  const noopPage = async () => ({ items: [], cursor: null });
  const workspaceState = {
    beginTransaction() {}, async getMutationResult() { return null; }, listProjects: noopPage,
    async getProject(input) { reads.push(input); return input.projectId === project.id ? project : null; },
    listIncidents: noopPage, async getIncident() { return null; }, async putIncident() {},
    listAuditMetadata: noopPage, listBreakGlass: noopPage, async getBreakGlass() { return null; }, async putBreakGlass() {},
  };
  const handler = createOperationsRuntime({
    workspaceState, budgetState: h.state, budgetDestination: destination, budgetPublisher: publisher,
    domainDirectory: { async listActiveDomains() { return [{ id: "support" }, { id: "finance" }]; } },
    cloudWatchProvider: { listRuntimeAggregates: noopPage },
    usageProvider: usageProvider ?? { listBudgets: async () => [], async listInvocationUsageAggregates() {
      return { items: [usage(usageOverride)], cursor: null };
    } },
    identityVerifier: async () => true, clock: h.clock, cursorSigningKey: "synthetic-budget-cursor-key-123456789",
  });
  return { reads, handler };
}
function event({ body, path = "/api/operations/project-budgets", role = "lead", actor = "operator-sub",
  request = "budget-1", groups = ["platform-admin", "demo-operator"], authenticated = true } = {}) {
  return {
    version: "2.0", body: JSON.stringify(body),
    headers: { "x-demo-role": role, "x-active-domain": "support", "x-request-id": request },
    requestContext: { requestId: "synthetic-http-request", http: { method: "POST", path },
      ...(authenticated ? { authorizer: { jwt: { claims: { sub: actor, token_use: "access",
        "cognito:username": "synthetic", "cognito:groups": groups } } } } : {}) },
  };
}
const writeBody = overrides => ({ ...scope, expectedVersion: 0, currency: "USD", period: "CALENDAR_MONTH_UTC",
  monthlyLimitUsd: 10, thresholdPercent: 80, ...overrides });
const evaluated = overrides => event({ path: "/api/operations/project-budgets/evaluate", body: scope, ...overrides });

test("real Operations projection/authorization -> versioned config -> derived crossing -> durable injected delivery", async () => {
  const h = harness();
  const sends = [];
  const { handler } = api(h, { publisher: { async publish(input) {
    sends.push(input); return { MessageId: "synthetic-acceptance" };
  } } });
  const written = await handler(event({ body: writeBody() }));
  assert.equal(written.statusCode, 200, written.body);
  assert.equal(JSON.parse(written.body).budget.updatedBy, "operator-sub");
  const response = await handler(evaluated());
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.evaluation.status, "CROSSED");
  assert.equal(body.deliveries.items[0].status, "PROVIDER_ACCEPTED");
  assert.equal(body.deliveries.items[0].recipientReceipt, "UNVERIFIED");
  await handler(evaluated());
  assert.equal(sends.length, 1);
  assert.equal((await alerts(h)).items.length, 1);
});

test("budget API version persistence -> common native journal threshold -> durable outbox without publisher", async () => {
  const h = harness();
  const occurredAt = "2026-09-11T11:59:00.000Z";
  const reads = [];
  const common = createJournalUsageProvider({
    journal: { async listByProject(input) {
      reads.push(input);
      return { items: [{ ...scope, runId: "synthetic-budget-run", createdAt: occurredAt,
        completedAt: occurredAt, phase: "COMPLETED", runtimeStatus: "SUCCEEDED",
        lifecycle: { startedAt: occurredAt }, nativeExecution: {
          startedAt: occurredAt, terminal: { status: "SUCCEEDED", completedAt: occurredAt },
          usage: { occurredAt, price: { estimatedCostUsd: 8,
            priceSource: usage().priceSources[0], pricingRevision: "a".repeat(64) },
          observation: { usage: { inputTokens: 1, outputTokens: 1 } } },
        } }], cursor: null };
    } },
    nativeExecution: true, compatibility: { readerVersion: "cost-v1", writerVersion: "cost-v1" },
  });
  const { handler } = api(h, { usageProvider: common });
  const first = await handler(event({ body: writeBody({ monthlyLimitUsd: 20 }) }));
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(JSON.parse(first.body).budget.version, 1);
  const updated = await handler(event({ body: writeBody({ expectedVersion: 1 }), request: "budget-2" }));
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(JSON.parse(updated.body).budget.version, 2);
  const evaluation = await handler(evaluated());
  assert.equal(evaluation.statusCode, 200, evaluation.body);
  const body = JSON.parse(evaluation.body);
  assert.equal(body.evaluation.configVersion, 2);
  assert.equal(body.evaluation.status, "CROSSED");
  assert.equal(body.evaluation.thresholdUsd, 8);
  assert.equal(body.evaluation.knownEstimatedCostUsd, 8);
  assert.equal(body.evaluation.runCount, 1);
  assert.equal(body.evaluation.costPerRunUsd, 8);
  assert.equal(body.evaluation.source, "experience-invocation-journal");
  assert.equal(body.deliveries.items[0].status, "PUBLISHER_UNAVAILABLE");
  assert.equal(body.deliveries.items[0].recipientReceipt, "UNVERIFIED");
  assert.ok(reads.length > 0);
  assert.equal(reads[0].domainId, scope.domainId);
  assert.equal(reads[0].projectId, scope.projectId);
  const persisted = (await alerts(h)).items;
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].evaluation.configVersion, 2);
  assert.equal(persisted[0].evaluation.knownEstimatedCostUsd, 8);
  const repeated = await handler(evaluated());
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal((await alerts(h)).items.length, 1);
});

test("API rejects builder, foreign domain/project, forged identity/cost/destination and unauthenticated writes", async () => {
  const h = harness();
  const { handler, reads } = api(h);
  for (const [input, expected] of [
    [event({ body: writeBody(), role: "builder" }), 403],
    [event({ body: writeBody({ domainId: "finance" }) }), 404],
    [event({ body: writeBody({ projectId: "other" }) }), 404],
    [event({ body: writeBody({ identity: { role: "admin" } }) }), 400],
    [event({ body: writeBody({ actor: "forged" }) }), 400],
    [event({ body: writeBody({ destination: TOPIC }) }), 400],
    [event({ body: writeBody(), authenticated: false }), 401],
    [evaluated({ body: { ...scope, costUsd: 100 } }), 400],
  ]) {
    const response = await handler(input);
    assert.equal(response.statusCode, expected, response.body);
  }
  assert.equal(h.items.size, 0);
  assert.equal(reads.length, 1);
});

test("authoritative project record mismatch and inactive project cannot write config", async () => {
  for (const [override, status] of [[{ domainId: "finance" }, 503], [{ status: "ARCHIVED" }, 409]]) {
    const h = harness();
    const response = await api(h, { projectOverride: override }).handler(event({ body: writeBody() }));
    assert.equal(response.statusCode, status, response.body);
    assert.equal(h.items.size, 0);
  }
});

test("API validates USD calendar config, idempotency and version updates", async () => {
  const h = harness();
  const { handler } = api(h);
  for (const changes of [
    { currency: "AUD" }, { period: "30D" }, { monthlyLimitUsd: 0 }, { thresholdPercent: 0 },
    { thresholdPercent: 101 }, { expectedVersion: -1 }, { expectedVersion: 0.5 },
  ]) assert.equal((await handler(event({ body: writeBody(changes) }))).statusCode, 400);
  const original = await handler(event({ body: writeBody() }));
  h.setTime(NOW + 1);
  assert.deepEqual(await handler(event({ body: writeBody() })), original);
  const update = await handler(event({ request: "v2", body: writeBody({ expectedVersion: 1, monthlyLimitUsd: 20 }) }));
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(JSON.parse(update.body).budget.version, 2);
  assert.equal((await handler(event({ request: "v3", body: writeBody({ expectedVersion: 1 }) }))).statusCode, 409);
});

test("permanent builder identity cannot self-promote to a lead using demo headers", async () => {
  const h = harness();
  const response = await api(h).handler(event({ body: writeBody(), role: "lead",
    actor: "builder-sub", groups: ["domain-builder", "domain-support"] }));
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(h.items.size, 0);
});

test("API without a destination preserves crossing as UNCONFIGURED; below-threshold evaluation creates no alert", async () => {
  for (const [amount, count] of [[8, 1], [7, 0]]) {
    const h = harness();
    const { handler } = api(h, { destination: null, usageOverride: { estimatedCostUsd: amount, knownEstimatedCostUsd: amount } });
    assert.equal((await handler(event({ body: writeBody() }))).statusCode, 200);
    const result = await handler(evaluated());
    assert.equal(result.statusCode, 200, result.body);
    assert.equal((await alerts(h)).items.length, count);
    if (count) assert.equal(JSON.parse(result.body).deliveries.items[0].status, "UNCONFIGURED");
    else assert.equal(JSON.parse(result.body).evaluation.status, "INCOMPLETE");
  }
});
