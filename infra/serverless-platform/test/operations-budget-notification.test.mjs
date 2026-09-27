import assert from "node:assert/strict";
import test from "node:test";
import { createBudgetSnsPublisher } from "../lambda/operations/budget-sns-publisher.mjs";
import { createBudgetDelivery } from "../lambda/operations/budget-delivery.mjs";
import { createBudgetRunner } from "../lambda/operations/budget-runner.mjs";
import { createBudgetRunnerState } from "../lambda/operations/budget-runner-state.mjs";
import { createJournalUsageProvider } from "../lambda/operations/journal-usage.mjs";
import { createProjectBudgetService, evaluateProjectBudget } from "../lambda/operations/budgets.mjs";
import { NOW, TOPIC, scope, config, usage, harness } from "./helpers/budget-notification-fixtures.mjs";

const input = { destination: TOPIC, idempotencyKey: "a".repeat(64), message: '{"synthetic":true}' };
const credentials = { accessKeyId: "synthetic", secretAccessKey: "synthetic" };
const response = (statusCode, body) => ({ response: { statusCode, headers: {}, body: Buffer.from(body) } });
const accepted = response(200, '<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><PublishResult><MessageId>exact-id-123</MessageId></PublishResult></PublishResponse>');

test("absent topic stays unavailable; invalid topic shapes fail before SDK access", async () => {
  assert.equal(await createBudgetSnsPublisher(), null);
  for (const destination of ["", `${TOPIC}:extra`, `${TOPIC}${"x".repeat(256)}`, "https://example.invalid"]) {
    await assert.rejects(createBudgetSnsPublisher({ destination }), /destination/i);
  }
});

test("real SNSClient serializes exact topic and returns exact MessageId; standard and FIFO", async () => {
  for (const destination of [TOPIC, `${TOPIC}.fifo`]) {
    const requests = [];
    const publisher = await createBudgetSnsPublisher({ destination, credentials,
      requestHandler: { async handle(request) { requests.push(request); return accepted; } } });
    assert.deepEqual(await publisher.publish({ ...input, destination }), { MessageId: "exact-id-123" });
    const params = new URLSearchParams(requests[0].body);
    assert.equal(params.get("TopicArn"), destination);
    assert.equal(params.get("Message"), input.message);
    assert.equal(params.get("MessageDeduplicationId"), destination.endsWith(".fifo") ? input.idempotencyKey : null);
    assert.equal(params.get("MessageGroupId"), destination.endsWith(".fifo") ? "project-budget" : null);
    assert.equal(requests[0].hostname, "sns.us-west-2.amazonaws.com");
    await assert.rejects(publisher.publish({ ...input, destination: `${TOPIC}-other` }), /destination/i);
    await assert.rejects(publisher.publish({ ...input, destination, message: "x".repeat(65_537) }), /payload/i);
    await assert.rejects(publisher.publish({ ...input, destination, message: "not-json" }), /payload/i);
    assert.equal(requests.length, 1);
  }
});

test("SDK service failure has no hidden retries and transport honors abort", async () => {
  let calls = 0;
  const publisher = await createBudgetSnsPublisher({ destination: TOPIC, credentials,
    requestHandler: { async handle() { calls++; return response(503,
      '<ErrorResponse><Error><Type>Receiver</Type><Code>InternalError</Code><Message>synthetic</Message></Error></ErrorResponse>'); } } });
  await assert.rejects(publisher.publish(input));
  assert.equal(calls, 1);
  const controller = new AbortController();
  const aborting = await createBudgetSnsPublisher({ destination: TOPIC, credentials,
    requestHandler: { handle(_request, { abortSignal }) {
      return new Promise((_, reject) => {
        abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        controller.abort();
      });
    } } });
  await assert.rejects(aborting.publish({ ...input, abortSignal: controller.signal }), { name: "AbortError" });
});

test("scheduled runner/common journal/evaluator/state/delivery uses real SNSClient request transport", async () => {
  const h = harness();
  await h.state.writeConfig(config(), 0);
  let requests = 0;
  const publisher = await createBudgetSnsPublisher({ destination: TOPIC, credentials,
    requestHandler: { async handle(request) {
      requests++;
      const message = JSON.parse(new URLSearchParams(request.body).get("Message"));
      assert.equal(message.knownEstimatedCostUsd, 8);
      assert.equal(message.runCount, 1);
      return accepted;
    } } });
  const occurredAt = new Date(NOW - 60_000).toISOString();
  const usageProvider = createJournalUsageProvider({
    nativeExecution: true, compatibility: { readerVersion: "cost-v1", writerVersion: "cost-v1" },
    journal: { async listByProject() { return { cursor: null, items: [{
      ...scope, runId: "synthetic", createdAt: occurredAt, completedAt: occurredAt,
      phase: "COMPLETED", runtimeStatus: "SUCCEEDED",
      nativeExecution: { startedAt: occurredAt, terminal: { status: "SUCCEEDED", completedAt: occurredAt },
        usage: { occurredAt, price: { estimatedCostUsd: 8, priceSource: usage().priceSources[0], pricingRevision: "a".repeat(64) },
          observation: { usage: { inputTokens: 1, outputTokens: 1 } } } },
    }] }; } },
  });
  const project = { domainId: scope.domainId, id: scope.projectId, status: "ACTIVE" };
  const run = createBudgetRunner({ budgetState: h.state, publisher, usageProvider, destination: TOPIC, clock: h.clock,
    runnerState: createBudgetRunnerState({ tableName: "PlatformState", dynamo: h.dynamo, clock: h.clock }),
    domainDirectory: { async listActiveDomains() { return [{ id: scope.domainId }]; } },
    workspaceState: { async listProjects() { return { items: [project], cursor: null }; }, async getProject() { return project; } },
  });
  await run();
  await run();
  assert.equal(requests, 1);
  const alert = (await h.state.listAlerts(scope)).items[0];
  assert.equal(alert.providerMessageId, "exact-id-123");
  assert.equal(alert.recipientReceipt, "UNVERIFIED");
});

test("SNS named throttles retry; authorization/KMS failures are permanent", async () => {
  for (const [name, status] of [["Throttled", "RETRY"], ["KMSThrottling", "RETRY"],
    ["AuthorizationError", "FAILED"], ["KMSAccessDenied", "FAILED"], ["InvalidParameter", "FAILED"]]) {
    const h = harness();
    const budget = await h.state.writeConfig(config(), 0);
    await h.state.recordCrossing(budget, await evaluateProjectBudget({ config: budget, now: NOW,
      usageProvider: { async listInvocationUsageAggregates() { return { items: [usage()], cursor: null }; } } }));
    const delivery = createBudgetDelivery({ budgetState: h.state, destination: TOPIC, clock: h.clock,
      publisher: { async publish() { throw Object.assign(new Error("synthetic"), { name }); } } });
    const result = await delivery.deliverProject(scope);
    assert.equal(result.items[0].status, status);
    assert.equal(result.items[0].recipientReceipt, "UNVERIFIED");
  }
});

test("aborted reconciliation never claims or publishes; hung state reads have a finite deadline", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const delivery = createBudgetDelivery({ budgetState: { async listAlerts() { reads++; return new Promise(() => {}); } } });
  await assert.rejects(delivery.deliverProject(scope, undefined, { abortSignal: controller.signal }), { name: "AbortError" });
  assert.equal(reads, 0);
  await assert.rejects(delivery.deliverProject(scope, undefined, { timeoutMs: 20 }), { name: "AbortError" });
});

test("HTTP evaluation aborts hung usage and cannot create a late crossing or publish", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  await h.state.writeConfig(config(), 0);
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  let publishes = 0;
  const service = createProjectBudgetService({
    budgetState: h.state, clock: h.clock,
    workspaceState: { async getProject() { return { domainId: scope.domainId, id: scope.projectId,
      ownerSubject: "synthetic", memberSubjects: [], status: "ACTIVE" }; } },
    authorizer: async () => ({ ok: true }),
    usageProvider: { listInvocationUsageAggregates() { entered(); return new Promise(resolve => { release = resolve; }); } },
    delivery: { async deliverProject() { publishes++; } },
  });
  const pending = service.evaluateProjectBudget({ ...scope, requestId: "synthetic",
    identity: { actor: "synthetic", role: "lead", activeDomain: "support", domainIds: ["support"] } });
  await started;
  t.mock.timers.tick(1_400);
  await assert.rejects(pending, { name: "AbortError" });
  release({ items: [usage()], cursor: null });
  await new Promise(setImmediate);
  assert.equal((await h.state.listAlerts(scope)).items.length, 0);
  assert.equal(publishes, 0);
});
