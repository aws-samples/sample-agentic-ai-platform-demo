import assert from "node:assert/strict";
import test from "node:test";
import { createBudgetRunner } from "../lambda/operations/budget-runner.mjs";
import { createBudgetRunnerState } from "../lambda/operations/budget-runner-state.mjs";
import { createBudgetRunnerRuntime } from "../lambda/operations/budget-runner-runtime.mjs";
import { createWorkspaceState } from "../lambda/workspace/state.mjs";
import { createJournalUsageProvider } from "../lambda/operations/journal-usage.mjs";
import { evaluateProjectBudget } from "../lambda/operations/budgets.mjs";
import { NOW, TOPIC, scope, config, usage, harness } from "./helpers/budget-notification-fixtures.mjs";

const project = (id, domainId = "support", status = "ACTIVE") => ({
  domainId, id, name: "Synthetic", description: "", ownerSubject: "synthetic-builder", memberSubjects: [],
  status, createdBySubject: "synthetic-builder", createdAt: new Date(NOW).toISOString(),
});
const nativeItem = record => Object.fromEntries(Object.entries(record).map(([key, value]) =>
  [key, Array.isArray(value) ? { L: value.map(S => ({ S })) } : { S: value }]));
const commonUsage = () => createJournalUsageProvider({
  nativeExecution: true, compatibility: { readerVersion: "cost-v1", writerVersion: "cost-v1" },
  journal: { async listByProject(input) {
    // The real common reader must follow an empty first journal page.
    if (!input.cursor) return { items: [], cursor: { synthetic: "page-two" } };
    const occurredAt = new Date(NOW - 60_000).toISOString();
    return { items: [{
      domainId: input.domainId, projectId: input.projectId, runId: `synthetic-${input.projectId}`,
      createdAt: occurredAt, completedAt: occurredAt, phase: "COMPLETED", runtimeStatus: "SUCCEEDED",
      nativeExecution: { startedAt: occurredAt, terminal: { status: "SUCCEEDED", completedAt: occurredAt },
        usage: { occurredAt, price: { estimatedCostUsd: 8, priceSource: usage().priceSources[0], pricingRevision: "a".repeat(64) },
          observation: { usage: { inputTokens: 1, outputTokens: 1 } } } },
    }], cursor: null };
  } },
});

function setup(projects = [project(scope.projectId)], overrides = {}) {
  const h = harness();
  const directoryReads = [];
  const dynamo = { async send(command, options) {
    const input = command.input;
    const pk = input.Key?.pk.S ?? input.ExpressionAttributeValues?.[":pk"]?.S;
    if (pk?.startsWith("PROJECT#")) {
      options?.abortSignal?.throwIfAborted();
      const records = projects.filter(p => `PROJECT#${p.domainId}` === pk)
        .map(p => nativeItem({ pk, sk: `PROJECT#${p.id}`, entityType: "PROJECT", ...p }))
        .sort((a, b) => a.sk.S.localeCompare(b.sk.S));
      if (input.Key) return { Item: records.find(p => p.sk.S === input.Key.sk.S) };
      directoryReads.push(input);
      const remaining = records.filter(p => !input.ExclusiveStartKey || p.sk.S > input.ExclusiveStartKey.sk.S);
      const page = remaining.slice(0, input.Limit);
      return { Items: page, ...(remaining.length > page.length
        ? { LastEvaluatedKey: { pk: page.at(-1).pk, sk: page.at(-1).sk } } : {}) };
    }
    return h.dynamo.send(command, options);
  } };
  const workspaceState = createWorkspaceState({ tableName: "PlatformState", dynamo, now: () => new Date(h.clock()) });
  const runnerState = createBudgetRunnerState({ tableName: "PlatformState", dynamo: h.dynamo, clock: h.clock });
  const sends = [];
  const dependencies = { workspaceState, runnerState, budgetState: h.state,
    domainDirectory: { async listActiveDomains() { return [...new Set(projects.map(p => p.domainId))].map(id => ({ id })); } },
    usageProvider: commonUsage(), destination: TOPIC, clock: h.clock,
    publisher: { async publish(input) { sends.push(input); return { MessageId: `synthetic-${sends.length}` }; } },
    ...overrides };
  return { ...h, sends, projects, directoryReads, dependencies, runnerState, run: createBudgetRunner(dependencies) };
}

test("real workspace directory/common paginated usage/evaluator/outbox: >first project page resumes durably", async () => {
  const h = setup(Array.from({ length: 12 }, (_, i) => project(`project-${String(i).padStart(2, "0")}`)));
  for (const p of h.projects) await h.state.writeConfig(config({ projectId: p.id }), 0);
  const first = await h.run();
  assert.equal(first.status, "CONTINUED");
  assert.equal(first.directoryPages, 10);
  assert.equal(first.projects, 10);
  const second = await createBudgetRunner(h.dependencies)();
  assert.equal(second.projects, 2);
  assert.equal(second.status, "COMPLETE");
  assert.equal(h.sends.length, 12);
  assert.equal(h.directoryReads[10].ExclusiveStartKey.sk.S, "PROJECT#project-09");
  for (const p of h.projects) {
    const alert = (await h.state.listAlerts({ domainId: "support", projectId: p.id })).items[0];
    assert.equal(alert.status, "PROVIDER_ACCEPTED");
    assert.equal(alert.recipientReceipt, "UNVERIFIED");
    assert.equal(alert.evaluation.runCount, 1);
    assert.equal(alert.evaluation.costPerRunUsd, 8);
  }
});

test("runner follows per-project alert cursor beyond ten records; old versions superseded", async () => {
  const h = setup();
  for (let version = 1; version <= 12; version++) {
    const budget = await h.state.writeConfig(config({ version, requestId: `v-${version}` }), version - 1);
    await h.state.recordCrossing(budget, await evaluateProjectBudget({ config: budget, now: NOW, usageProvider: commonUsage() }));
  }
  for (let i = 0; i < 12; i++) await createBudgetRunner(h.dependencies)();
  const first = await h.state.listAlerts(scope);
  const second = await h.state.listAlerts(scope, first.cursor);
  const items = [...first.items, ...second.items];
  assert.equal(items.filter(a => a.status === "SUPERSEDED").length, 11);
  assert.equal(items.filter(a => a.status === "PROVIDER_ACCEPTED").length, 1);
  assert.equal(h.sends.length, 1);
});

test("duplicate scheduled invocations use one durable lease and one publish", async () => {
  const h = setup();
  await h.state.writeConfig(config(), 0);
  const results = await Promise.all([h.run(), createBudgetRunner(h.dependencies)()]);
  assert.equal(results.filter(r => r.status === "BUSY").length, 1);
  assert.equal(h.sends.length, 1);
});

test("configuration changes between evaluation and claim fence the real runner publish", async () => {
  const h = setup();
  await h.state.writeConfig(config(), 0);
  const run = createBudgetRunner({ ...h.dependencies, budgetState: {
    ...h.state, async saveAlert(previous, next, current, options) {
      if (current) await h.state.writeConfig(config({ version: 2, requestId: "superseded" }), 1);
      return h.state.saveAlert(previous, next, current, options);
    },
  } });
  await run();
  assert.equal(h.sends.length, 0);
  assert.equal((await h.state.listAlerts(scope)).items[0].attempts, 0);
});

test("hung usage remains unknown while a retained crossing can still be delivered", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup();
  const budget = await h.state.writeConfig(config(), 0);
  await h.state.recordCrossing(budget, await evaluateProjectBudget({ config: budget, now: NOW, usageProvider: commonUsage() }));
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const run = createBudgetRunner({ ...h.dependencies, usageProvider: {
    listInvocationUsageAggregates() { entered(); return new Promise(() => {}); },
  } });
  const pending = run();
  await started;
  t.mock.timers.tick(2_000);
  const result = await pending;
  assert.equal(result.unknown, 1);
  assert.equal(h.sends.length, 1);
});

test("empty project pages and domain transitions retain their continuation", async () => {
  const h = setup([project("first", "finance"), project("second", "support")]);
  for (const p of h.projects) await h.state.writeConfig(config({ domainId: p.domainId, projectId: p.id }), 0);
  let empty = true;
  const original = h.dependencies.workspaceState;
  const run = createBudgetRunner({ ...h.dependencies, workspaceState: {
    ...original, listProjects(input) {
      if (empty) { empty = false; return { items: [], cursor: { pk: "PROJECT#finance", sk: "PROJECT#empty" } }; }
      return original.listProjects(input);
    },
  } });
  const result = await run();
  assert.equal(result.directoryPages, 3);
  assert.equal(h.sends.length, 2);
});

test("due retries honor backoff; inactive and foreign project scopes cannot publish", async () => {
  let calls = 0;
  const h = setup([project(scope.projectId), project("archived", "support", "ARCHIVED")], {
    publisher: { async publish() {
      calls++;
      if (calls === 1) throw Object.assign(new Error("synthetic throttle"), { name: "Throttled" });
      return { MessageId: "synthetic-retry" };
    } },
  });
  await h.state.writeConfig(config(), 0);
  await h.state.writeConfig(config({ projectId: "archived" }), 0);
  await h.run();
  await h.run();
  assert.equal(calls, 1);
  h.setTime(NOW + 60_000);
  await h.run();
  assert.equal(calls, 2);
  assert.equal((await h.state.listAlerts({ ...scope, projectId: "archived" })).items.length, 0);
  const foreign = createBudgetRunner({ ...h.dependencies, workspaceState: {
    async listProjects() { return { items: [project("foreign", "finance")], cursor: null }; },
    async getProject() { throw new Error("must not read"); },
  } });
  await assert.rejects(foreign(), { code: "OPERATIONS_UNAVAILABLE" });
  assert.equal(calls, 2);
});

test("hung project read is bounded and does not starve later projects", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup([project("a-hung"), project("b-good")]);
  for (const p of h.projects) await h.state.writeConfig(config({ projectId: p.id }), 0);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const run = createBudgetRunner({ ...h.dependencies, workspaceState: {
    ...h.dependencies.workspaceState,
    getProject(input) {
      if (input.projectId === "a-hung") { entered(); return new Promise(() => {}); }
      return h.dependencies.workspaceState.getProject(input);
    },
  } });
  const pending = run();
  await started;
  t.mock.timers.tick(8_000);
  const result = await pending;
  assert.equal(result.projects, 2);
  assert.equal(result.errors, 1);
  assert.equal(h.sends.length, 1);
  assert.equal(JSON.parse(h.sends[0].message).projectId, "b-good");
});

test("finite invocation deadline leaves lease held until expiry and resumes past interrupted project", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup([project("a-hung"), project("b-good")]);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const run = createBudgetRunner({ ...h.dependencies, workspaceState: {
    ...h.dependencies.workspaceState,
    getProject() { entered(); return new Promise(() => {}); },
  } });
  const pending = run();
  await started;
  t.mock.timers.tick(20_000);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await h.run()).status, "BUSY");
  h.setTime(NOW + 60_000);
  assert.equal((await h.run()).projects, 1);
});

test("hung checkpoint/domain reads terminate; expired leases fence stale progress", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = createBudgetRunner({ ...h.dependencies, domainDirectory: {
    listActiveDomains() { entered(); return new Promise(() => {}); },
  } })();
  await started;
  t.mock.timers.tick(2_000);
  await assert.rejects(pending, { name: "AbortError" });
  h.setTime(NOW + 60_000);
  const lease = await h.runnerState.claim();
  h.setTime(NOW + 120_000);
  const next = await h.runnerState.claim();
  assert.notEqual(lease.leaseToken, next.leaseToken);
  await assert.rejects(h.runnerState.advance(lease, lease.position), { code: "CONFLICT" });
});

const scheduleArn = "arn:aws:events:us-west-2:000000000000:rule/synthetic-budget";
const scheduled = { version: "0", id: "synthetic", "detail-type": "Scheduled Event", source: "aws.events",
  account: "000000000000", time: new Date(NOW).toISOString(), region: "us-west-2", resources: [scheduleArn], detail: {} };
test("scheduled entry rejects HTTP/body principal/destination/directory and defaults disabled", async () => {
  let reads = 0;
  const dynamo = { async send() { reads++; throw new Error("unexpected"); } };
  assert.deepEqual(await createBudgetRunnerRuntime({ env: {}, dynamo })({}), { status: "DISABLED" });
  const run = createBudgetRunnerRuntime({ dynamo, env: {
    OPERATIONS_BUDGET_RUNNER_ENABLED: "true", OPERATIONS_BUDGET_SCHEDULE_ARN: scheduleArn, PLATFORM_STATE_TABLE_NAME: "PlatformState",
  } });
  for (const event of [{ body: "{}" }, { ...scheduled, detail: { identity: { role: "admin" } } },
    { ...scheduled, projects: [scope] }, { ...scheduled, destination: TOPIC },
    { ...scheduled, resources: [`${scheduleArn}-foreign`] }]) await assert.rejects(run(event), /internal scheduled event/);
  assert.equal(reads, 0);
  assert.deepEqual(await run(scheduled, { getRemainingTimeInMillis: () => 1_000 }), { status: "INSUFFICIENT_TIME" });
});

test("configured entry uses actual domain/workspace/common journal modules with exact read key boundaries", async () => {
  const h = setup();
  await h.state.writeConfig(config({ destination: null }), 0);
  const commands = [];
  const domain = nativeItem({ pk: "DOMAIN", sk: "DOMAIN#support", entityType: "DOMAIN", id: "support",
    name: "Synthetic", owner: "synthetic", ownerGroup: "domain-support", description: "Synthetic domain",
    registryId: "Synthetic123", registryArn: "arn:aws:agent-registry:us-west-2:000000000000:registry/Synthetic123",
    createdBy: "synthetic", status: "ACTIVE", createdAt: new Date(NOW).toISOString() });
  domain.tokenBudget = { NULL: true };
  const storedProject = nativeItem({ pk: "PROJECT#support", sk: `PROJECT#${scope.projectId}`, entityType: "PROJECT", ...project(scope.projectId) });
  const dynamo = { async send(command, options) {
    commands.push(command.input);
    assert.ok(options.abortSignal instanceof AbortSignal);
    if (command.input.ExpressionAttributeValues?.[":pk"]?.S === "DOMAIN") return { Items: [domain] };
    if (command.input.ExpressionAttributeValues?.[":pk"]?.S === "PROJECT#support") return { Items: [storedProject] };
    if (command.input.Key?.pk.S === "PROJECT#support") return { Item: storedProject };
    if (command.input.IndexName === "EntityTypeIndex") return { Items: [] };
    return h.dynamo.send(command, options);
  } };
  const run = createBudgetRunnerRuntime({ dynamo, clock: h.clock, env: {
    PLATFORM_STATE_TABLE_NAME: "PlatformState", OPERATIONS_BUDGET_RUNNER_ENABLED: "true",
    OPERATIONS_BUDGET_SCHEDULE_ARN: scheduleArn, OPERATIONS_NATIVE_EXECUTION_VERSION: "native-v1",
    EXPERIENCE_JOURNAL_READER_VERSION: "cost-v1", EXPERIENCE_JOURNAL_WRITE_VERSION: "cost-v1",
  } });
  const result = await run(scheduled);
  assert.equal(result.projects, 1);
  assert.equal(result.unknown, 1);
  assert.equal(result.errors, 0);
  assert.equal(commands.filter(c => c.IndexName === "EntityTypeIndex").length, 1);
  assert.equal((await h.state.listAlerts(scope)).items.length, 0);
});
