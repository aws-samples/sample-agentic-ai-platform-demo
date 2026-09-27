import assert from "node:assert/strict";
import test from "node:test";
import { createOperationsRuntime } from "../lambda/operations/handler-runtime.mjs";
import { createProjectBudgetState } from "../lambda/operations/budget-state.mjs";
import { createJournalUsageProvider } from "../lambda/operations/journal-usage.mjs";
import { createProjectBudgetController } from "../../../console/public/modules/project-budget.mjs";
import { adaptCosts } from "../../../console/public/main-ui-compat.mjs";
import { attributedCostSummary } from "../../../console/public/cost-view.mjs";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const scope = { domainId: "support", projectId: "case-assist" };
const project = { domainId: "support", id: "case-assist", name: "Synthetic project", description: "",
  ownerSubject: "owner-sub", memberSubjects: ["member-sub"], status: "ACTIVE",
  createdBySubject: "owner-sub", createdAt: "2026-09-01T00:00:00.000Z" };
const write = overrides => ({ ...scope, expectedVersion: 0, currency: "USD",
  period: "CALENDAR_MONTH_UTC", monthlyLimitUsd: 10, thresholdPercent: 80, ...overrides });

function event({ method = "GET", path = "/api/operations/project-budgets", query = scope,
  body, role = "lead", actor = "lead-sub", requestId = "write-1", verified = true } = {}) {
  return {
    headers: { "x-demo-role": role, "x-active-domain": "support", "x-request-id": requestId },
    ...(method === "GET" ? { queryStringParameters: query, rawQueryString: new URLSearchParams(query).toString() }
      : { body: JSON.stringify(body) }),
    requestContext: { requestId: "synthetic-http", http: { method, path },
      ...(verified ? { authorizer: { jwt: { claims: { sub: actor, token_use: "access",
        "cognito:username": "synthetic", "cognito:groups": ["platform-admin", "demo-operator"] } } } } : {}) },
  };
}

function fixture({ status = "ACTIVE", verifier = true, empty = false } = {}) {
  const records = new Map();
  const commands = [];
  const key = item => `${item.pk.S}|${item.sk.S}`;
  const dynamo = { async send(command) {
    commands.push(command);
    const input = command.input;
    if (command.constructor.name === "GetItemCommand") {
      assert.equal(input.ConsistentRead, true);
      return { Item: structuredClone(records.get(key(input.Key))) };
    }
    assert.equal(command.constructor.name, "TransactWriteItemsCommand");
    for (const { Put } of input.TransactItems) {
      const previous = records.get(key(Put.Item));
      if (Put.ConditionExpression === "attribute_not_exists(pk)" ? previous
        : previous?.revision.N !== Put.ExpressionAttributeValues[":version"].N) {
        throw Object.assign(new Error("synthetic conflict"), { name: "TransactionCanceledException",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
      }
    }
    for (const { Put } of input.TransactItems) records.set(key(Put.Item), structuredClone(Put.Item));
    return {};
  } };
  const budgetState = createProjectBudgetState({ tableName: "SyntheticState", dynamo });
  const projects = [{ ...project, status }, { ...project, id: "second", ownerSubject: "other-sub", memberSubjects: [] }];
  const noop = async () => ({ items: [], cursor: null });
  const workspaceState = {
    beginTransaction() {}, async getMutationResult() { return null; },
    async listProjects({ domainId }) { return { items: projects.filter(p => p.domainId === domainId), cursor: null }; },
    async getProject({ domainId, projectId }) { return projects.find(p => p.domainId === domainId && p.id === projectId) ?? null; },
    listIncidents: noop, async getIncident() { return null; }, async putIncident() {},
    listAuditMetadata: noop, listBreakGlass: noop, async getBreakGlass() { return null; }, async putBreakGlass() {},
  };
  const at = "2026-09-11T11:59:00.000Z";
  const usageProvider = createJournalUsageProvider({
    journal: { async listByProject(input) { return { items: empty ? [] : [{
      domainId: input.domainId, projectId: input.projectId, runId: `run-${input.projectId}`,
      createdAt: at, completedAt: at, phase: "COMPLETED", runtimeStatus: "SUCCEEDED",
      lifecycle: { startedAt: at }, nativeExecution: {
        startedAt: at, terminal: { status: "SUCCEEDED", completedAt: at },
        usage: { occurredAt: at, observation: { usage: { inputTokens: 12, outputTokens: 4 } },
          price: { estimatedCostUsd: 8, pricingRevision: "a".repeat(64),
            priceSource: { id: "synthetic", url: "https://example.invalid/prices", retrievedAt: "2026-09-01T00:00:00.000Z",
              effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveTo: "2026-10-01T00:00:00.000Z" } } },
      },
    }], cursor: null }; } },
    budgets: { "project:support/case-assist": 999, platform: 5000, "domain:support": 1000 },
    nativeExecution: true, compatibility: { readerVersion: "cost-v1", writerVersion: "cost-v1" },
  });
  const handler = createOperationsRuntime({
    workspaceState, budgetState, usageProvider,
    budgetDestination: "arn:aws:sns:us-west-2:000000000000:synthetic-private-destination",
    domainDirectory: { async listActiveDomains() { return [{ id: "support" }, { id: "finance" }]; } },
    cloudWatchProvider: { listRuntimeAggregates: noop }, identityVerifier: async () => verifier,
    clock: () => NOW, cursorSigningKey: "synthetic-budget-reader-key-123456789",
  });
  return { handler, commands, records, budgetState };
}

test("GET reads persisted config and safe access metadata, with pure monthly evaluation and no delivery writes", async () => {
  const f = fixture();
  let response = await f.handler(event());
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(JSON.parse(response.body).budget, null);
  assert.equal(JSON.parse(response.body).access.canEdit, true);
  assert.equal((await f.handler(event({ method: "POST", body: write() }))).statusCode, 200);
  const before = f.commands.length;
  response = await f.handler(event({ role: "builder", actor: "member-sub" }));
  assert.equal(response.statusCode, 200, response.body);
  const result = JSON.parse(response.body);
  assert.equal(result.budget.monthlyLimitUsd, 10);
  assert.equal(result.budget.version, 1);
  assert.equal(result.project.ownerSubject, "owner-sub");
  assert.equal(result.access.canEdit, false);
  assert.equal(result.evaluation.status, "CROSSED");
  assert.equal(result.evaluation.costPerRunUsd, 8);
  assert.doesNotMatch(response.body, /arn:|destination|secret/i);
  assert.ok(f.commands.slice(before).every(c => c.constructor.name === "GetItemCommand"));
});

test("GET enforces verified identity, active project membership and domain scope before budget storage", async () => {
  for (const [options, request, expected] of [
    [{}, { verified: false }, 401],
    [{ verifier: false }, {}, 403],
    [{}, { role: "builder", actor: "stranger-sub" }, 404],
    [{}, { query: { ...scope, domainId: "finance" } }, 404],
    [{}, { query: { ...scope, projectId: "missing" } }, 404],
    [{ status: "ARCHIVED" }, {}, 409],
  ]) {
    const f = fixture(options);
    const response = await f.handler(event(request));
    assert.equal(response.statusCode, expected, response.body);
    assert.equal(f.commands.length, 0);
  }
  const f = fixture();
  assert.equal((await f.handler(event({ role: "builder", actor: "owner-sub" }))).statusCode, 200);
  assert.equal((await f.handler(event({ role: "admin" }))).statusCode, 200);
});

test("GET rejects extra/duplicate query fields and bodies; builders still cannot write", async () => {
  const f = fixture();
  for (const query of [{ domainId: "support" }, { ...scope, actor: "other" }, { ...scope, projectId: "../other" }]) {
    assert.equal((await f.handler(event({ query }))).statusCode, 400);
  }
  assert.equal((await f.handler({ ...event(), rawQueryString: "domainId=support&domainId=finance&projectId=case-assist" })).statusCode, 400);
  assert.equal((await f.handler({ ...event(), body: "{}" })).statusCode, 400);
  assert.equal((await f.handler(event({ method: "POST", body: write(), role: "builder", actor: "owner-sub" }))).statusCode, 403);
});

test("version conflicts leave authoritative GET unchanged and new reader sees update", async () => {
  const f = fixture();
  assert.equal((await f.handler(event({ method: "POST", body: write() }))).statusCode, 200);
  assert.equal((await f.handler(event({ method: "POST", body: write({ expectedVersion: 1, monthlyLimitUsd: 20 }), requestId: "update" }))).statusCode, 200);
  assert.equal((await f.handler(event({ method: "POST", body: write({ monthlyLimitUsd: 99 }), requestId: "stale" }))).statusCode, 409);
  const result = JSON.parse((await f.handler(event())).body);
  assert.equal(result.budget.monthlyLimitUsd, 20);
  assert.equal(result.budget.version, 2);
  assert.equal(result.evaluation.status, "INCOMPLETE");
});

test("cost project breakdown reads durable budgets, scopes Builder rows and preserves default accounting contract", async () => {
  const f = fixture();
  await f.handler(event({ method: "POST", body: write() }));
  for (const role of ["admin", "lead", "builder"]) {
    const response = await f.handler(event({ path: "/api/costs", role, actor: "member-sub",
      query: { groupBy: "project", window: "24h", limit: "50" } }));
    assert.equal(response.statusCode, 200, response.body);
    const result = JSON.parse(response.body);
    assert.equal(result.scope.type, "projects");
    assert.equal(result.items.length, role === "builder" ? 1 : 2);
    assert.equal(result.items[0].monthlyBudgetUsd, 10);
    assert.equal(result.items[0].projectBudget.version, 1);
    assert.equal(result.items[0].projectBudget.thresholdPercent, 80);
    assert.equal(result.items[0].estimatedCostUsd, 8);
    assert.doesNotMatch(response.body, /999|arn:|destination/);
  }
  const legacy = JSON.parse((await f.handler(event({ path: "/api/costs", role: "admin", query: {} }))).body);
  assert.equal(legacy.scope.type, "platform");
  assert.equal(legacy.items[0].monthlyBudgetUsd, 5000);
  assert.equal(legacy.items[0].estimatedCostUsd, 16);
});

test("unset durable budget never falls back to environment project config; empty monthly history stays unknown", async () => {
  const f = fixture({ empty: true });
  const costs = JSON.parse((await f.handler(event({ path: "/api/costs", role: "builder", actor: "member-sub", query: {} }))).body);
  assert.equal(costs.items[0].monthlyBudgetUsd, null);
  assert.equal(costs.items[0].projectBudget, null);
  await f.handler(event({ method: "POST", body: write() }));
  const result = JSON.parse((await f.handler(event())).body);
  assert.equal(result.evaluation.status, "UNKNOWN");
  assert.equal(result.evaluation.knownEstimatedCostUsd, null);
});

test("actual console controller -> authenticated handler -> durable state -> GET and cost adapter round trip", async () => {
  const f = fixture();
  let requestNumber = 0;
  const request = async (path, body, options) => {
    const [route, query] = path.split("?");
    return JSON.parse((await f.handler(event({
      path: `/api${route}`, query: Object.fromEntries(new URLSearchParams(query)),
      method: body ? "POST" : "GET", body, requestId: options?.requestId,
    }))).body);
  };
  const controller = createProjectBudgetController({ request, scope, requestId: () => `console-${++requestNumber}` });
  await controller.load();
  await controller.save({ monthlyLimitUsd: "25.50", thresholdPercent: "90" });
  assert.equal(controller.state.phase, "saved");
  assert.equal(controller.state.view.budget.monthlyLimitUsd, 25.5);
  assert.equal(controller.state.view.budget.thresholdPercent, 90);
  assert.equal(controller.state.view.evaluation.status, "INCOMPLETE");
  const refreshed = createProjectBudgetController({ request, scope });
  await refreshed.load();
  assert.equal(refreshed.state.view.budget.version, 1);
  const costs = adaptCosts(await request("/costs?groupBy=project&window=24h&limit=50"));
  assert.equal(costs.items[0].monthlyBudgetUsd, 25.5);
  assert.equal(costs.domains[0].tokenBudget, null);
  assert.equal(costs.totalCostUsd, 16);
  assert.equal(attributedCostSummary(costs).fullPlatformCostUsd, null);
});

test("project breakdown cursor binds grouping and identity, preserves window and handles active scope only", async () => {
  const f = fixture();
  const first = JSON.parse((await f.handler(event({ role: "admin", path: "/api/costs",
    query: { groupBy: "project", window: "24h", limit: "1" } }))).body);
  assert.equal(first.items.length, 1);
  assert.ok(first.cursor);
  const second = await f.handler(event({ role: "admin", path: "/api/costs",
    query: { groupBy: "project", window: "24h", limit: "1", cursor: first.cursor } }));
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(JSON.parse(second.body).items[0].projectId, "second");
  assert.deepEqual(JSON.parse(second.body).window, first.window);
  for (const query of [
    { window: "24h", limit: "1", cursor: first.cursor },
    { groupBy: "project", window: "7d", limit: "1", cursor: first.cursor },
    { groupBy: "domain" },
  ]) assert.ok([400, 404].includes((await f.handler(event({ role: "admin", path: "/api/costs", query }))).statusCode));
  const changedRole = await f.handler(event({ role: "builder", actor: "member-sub", path: "/api/costs",
    query: { groupBy: "project", window: "24h", limit: "1", cursor: first.cursor } }));
  assert.equal(changedRole.statusCode, 404);
});
