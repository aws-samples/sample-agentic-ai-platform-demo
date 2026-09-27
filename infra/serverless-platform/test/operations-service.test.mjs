import assert from "node:assert/strict";
import test from "node:test";
import {
  OperationsServiceError,
  createOperationsService,
} from "../lambda/operations/service.mjs";

const NOW = Date.parse("2026-08-25T00:00:00.000Z");

const admin = Object.freeze({
  actor: "admin-sub",
  role: "admin",
  activeDomain: null,
  domainIds: ["customer_support", "operations"],
});
const lead = Object.freeze({
  actor: "lead-sub",
  role: "lead",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});
const builder = Object.freeze({
  actor: "builder-sub",
  role: "builder",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});
const user = Object.freeze({
  actor: "user-sub",
  role: "user",
  activeDomain: null,
  domainIds: [],
});

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support workspace.",
    ownerSubject: "builder-sub",
    memberSubjects: [],
    status: "ACTIVE",
    createdBySubject: "lead-sub",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function operationAggregate(overrides = {}) {
  return {
    scopeType: "platform",
    domainId: null,
    projectId: null,
    runtimeCount: 2,
    healthyRuntimeCount: 2,
    invocationCount: 25,
    errorCount: 1,
    averageLatencyMs: 320.5,
    p95LatencyMs: 710,
    inputTokens: 1200,
    outputTokens: 450,
    ...overrides,
  };
}

function usageAggregate(overrides = {}) {
  return {
    scopeType: "project",
    domainId: "customer_support",
    projectId: "case-assist",
    invocationCount: 2,
    inputTokens: 150,
    outputTokens: 60,
    estimatedCostUsd: 1.5,
    ...overrides,
  };
}

function budget(overrides = {}) {
  return {
    scopeType: "project",
    domainId: "customer_support",
    projectId: "case-assist",
    monthlyLimitUsd: 100,
    currency: "USD",
    ...overrides,
  };
}

const costMetadata = {
  contractVersion: 1,
  currency: "USD",
  basis: "estimate",
  source: "cloudwatch-runtime-metrics",
  pricingVersion: null,
  updatedAt: null,
  environment: null,
  coverage: {
    included: ["model-inference"],
    excluded: ["runtime", "gateway", "memory", "tools", "evaluation", "shared"],
  },
  completeness: "partial",
  runCount: null,
  costPerRunUsd: null,
};

function page(items = [], cursor = null) {
  return { items, cursor };
}

function serviceWith({
  authorize = async () => ({ ok: true }),
  cloudWatch,
  state,
  usageProvider,
} = {}) {
  const calls = [];
  const workspaceState = {
    beginTransaction() {
      return Object.freeze({
        timestamp: new Date(NOW).toISOString(),
        epochSeconds: Math.floor(NOW / 1000),
      });
    },
    async getMutationResult() {
      return null;
    },
    async listProjects(input) {
      calls.push(["projects", input]);
      return page([]);
    },
    async getProject() {
      return null;
    },
    async listIncidents() {
      return page([]);
    },
    async getIncident() {
      return null;
    },
    async putIncident({ record }) {
      return record;
    },
    async listAuditMetadata() {
      return page([]);
    },
    async listBreakGlass() {
      return page([]);
    },
    async getBreakGlass() {
      return null;
    },
    async putBreakGlass({ record }) {
      return record;
    },
    ...state,
  };
  const cloudWatchProvider = {
    async listRuntimeAggregates(input) {
      calls.push(["cloudwatch", input]);
      return page([]);
    },
    ...cloudWatch,
  };
  const usage = {
    async listInvocationUsageAggregates(input) {
      calls.push(["usage", input]);
      return page([]);
    },
    async listBudgets(input) {
      calls.push(["budgets", input]);
      return [];
    },
    ...usageProvider,
  };
  return {
    calls,
    service: createOperationsService({
      workspaceState,
      authorizer: async (input) => {
        calls.push(["authorize", input]);
        return authorize(input);
      },
      cloudWatchProvider,
      usageProvider: usage,
      clock: () => NOW,
      cursorSigningKey:
        "test-only-operations-cursor-signing-key-material",
    }),
  };
}

function request(identity, overrides = {}) {
  return {
    identity,
    window: "24h",
    limit: 20,
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof OperationsServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

test("operations service requires every trust-boundary dependency", () => {
  assert.throws(
    () => createOperationsService(),
    /Operations state configuration is invalid/,
  );
  assert.throws(
    () => createOperationsService({
      workspaceState: { listProjects() {} },
    }),
    /Operations authorizer is invalid/,
  );
  assert.throws(
    () => createOperationsService({
      workspaceState: { listProjects() {} },
      authorizer() {},
    }),
    /CloudWatch provider is invalid/,
  );
  assert.throws(
    () => createOperationsService({
      workspaceState: { listProjects() {} },
      authorizer() {},
      cloudWatchProvider: { listRuntimeAggregates() {} },
    }),
    /Usage provider is invalid/,
  );
  assert.throws(
    () => createOperationsService({
      workspaceState: { listProjects() {} },
      authorizer() {},
      cloudWatchProvider: { listRuntimeAggregates() {} },
      usageProvider: {
        listInvocationUsageAggregates() {},
        listBudgets() {},
      },
      clock() {},
    }),
    /cursor signing key is invalid/,
  );
});

test("end users are denied before authorization, state, or provider access", async () => {
  const { calls, service } = serviceWith();

  await assert.rejects(
    service.listOperations(request(user)),
    expectCode("FORBIDDEN"),
  );
  await assert.rejects(
    service.listCosts(request(user)),
    expectCode("FORBIDDEN"),
  );

  assert.deepEqual(calls, []);
});

test("authorizer decisions require an own data-property allow result", async () => {
  let getterCalls = 0;
  const decisions = [
    true,
    { ok: true, unexpected: true },
    Object.assign({ ok: true }, {
      [Symbol("unexpected")]: true,
    }),
    Object.create({ ok: true }),
    Object.defineProperty({}, "ok", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    }),
  ];

  for (const decision of decisions) {
    const { calls, service } = serviceWith({
      authorize: async () => decision,
    });
    await assert.rejects(
      service.listOperations(request(admin)),
      expectCode("FORBIDDEN"),
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["authorize"],
    );
  }
  assert.equal(getterCalls, 0);
});

test("admin operations return platform aggregates without trace payloads", async () => {
  const { calls, service } = serviceWith({
    state: {
      async listProjects(input) {
        calls.push(["projects", input]);
        return page([
          project({
            domainId: input.domainId,
            id: `${input.domainId.replaceAll("_", "-")}-project`,
          }),
        ]);
      },
    },
    cloudWatch: {
      async listRuntimeAggregates(input) {
        calls.push(["cloudwatch", input]);
        return page([operationAggregate()]);
      },
    },
  });

  const result = await service.listOperations(request(admin));

  assert.deepEqual(result, {
    scope: { type: "platform" },
    window: {
      startTime: "2026-08-24T00:00:00.000Z",
      endTime: "2026-08-25T00:00:00.000Z",
    },
    items: [operationAggregate()],
    cursor: null,
  });
  const authorization = calls[0][1];
  assert.equal(authorization.action, "workspace.operations.read");
  assert.deepEqual(Object.keys(authorization).sort(), [
    "action",
    "requestContext",
    "resourceRef",
  ]);
  const providerCall = calls.find(([name]) => name === "cloudwatch")[1];
  assert.deepEqual(providerCall.scope, {
    type: "platform",
    domainIds: ["customer_support", "operations"],
    projectIds: [
      "customer_support/customer-support-project",
      "operations/operations-project",
    ],
  });
  assert.equal(JSON.stringify(result).includes("trace"), false);
});

test("admin aggregate responses reject trace-shaped provider payloads", async () => {
  const { service } = serviceWith({
    cloudWatch: {
      async listRuntimeAggregates() {
        return page([{
          ...operationAggregate(),
          tracePayload: "customer-secret",
        }]);
      },
    },
  });

  await assert.rejects(
    service.listOperations(request(admin)),
    (error) => {
      assert.ok(error instanceof OperationsServiceError);
      assert.equal(error.code, "OPERATIONS_UNAVAILABLE");
      assert.doesNotMatch(error.message, /customer-secret|tracePayload/);
      return true;
    },
  );
});

test("lead operations are confined to the selected domain", async () => {
  const { calls, service } = serviceWith({
    state: {
      async listProjects(input) {
        calls.push(["projects", input]);
        return page([project()]);
      },
    },
    cloudWatch: {
      async listRuntimeAggregates(input) {
        calls.push(["cloudwatch", input]);
        return page([operationAggregate({
          scopeType: "domain",
          domainId: "customer_support",
        })]);
      },
    },
  });

  const result = await service.listOperations(request(lead));

  assert.deepEqual(result.scope, {
    type: "domain",
    domainId: "customer_support",
  });
  assert.deepEqual(
    calls.find(([name]) => name === "cloudwatch")[1].scope,
    {
      type: "domain",
      domainIds: ["customer_support"],
      projectIds: ["customer_support/case-assist"],
    },
  );
});

test("builder operations include only owned or assigned project aggregates", async () => {
  const { calls, service } = serviceWith({
    state: {
      async listProjects(input) {
        calls.push(["projects", input]);
        return page([
          project(),
          project({
            id: "assigned-project",
            ownerSubject: "other-builder",
            memberSubjects: ["builder-sub"],
          }),
          project({
            id: "foreign-project",
            ownerSubject: "other-builder",
            memberSubjects: ["other-builder"],
          }),
        ]);
      },
    },
    cloudWatch: {
      async listRuntimeAggregates(input) {
        calls.push(["cloudwatch", input]);
        return page([
          operationAggregate({
            scopeType: "project",
            domainId: "customer_support",
            projectId: "case-assist",
          }),
          operationAggregate({
            scopeType: "project",
            domainId: "customer_support",
            projectId: "assigned-project",
          }),
        ]);
      },
    },
  });

  const result = await service.listOperations(request(builder));

  assert.deepEqual(result.scope, {
    type: "projects",
    domainId: "customer_support",
    projectIds: ["case-assist", "assigned-project"],
  });
  assert.deepEqual(
    result.items.map(({ projectId }) => projectId),
    ["case-assist", "assigned-project"],
  );
  assert.deepEqual(
    calls.find(([name]) => name === "cloudwatch")[1].scope.projectIds,
    [
      "customer_support/case-assist",
      "customer_support/assigned-project",
    ],
  );
});

test("foreign provider aggregates fail closed", async () => {
  const { service } = serviceWith({
    state: {
      async listProjects() {
        return page([project()]);
      },
    },
    cloudWatch: {
      async listRuntimeAggregates() {
        return page([operationAggregate({
          scopeType: "project",
          domainId: "customer_support",
          projectId: "foreign-project",
        })]);
      },
    },
  });

  await assert.rejects(
    service.listOperations(request(builder)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
});

test("duplicate provider aggregates for the same scope fail closed", async () => {
  const { service } = serviceWith({
    cloudWatch: {
      async listRuntimeAggregates() {
        return page([
          operationAggregate(),
          operationAggregate({ invocationCount: 30 }),
        ]);
      },
    },
  });

  await assert.rejects(
    service.listOperations(request(admin)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
});

test("costs aggregate real usage and project budgets into projections", async () => {
  const { calls, service } = serviceWith({
    state: {
      async listProjects(input) {
        calls.push(["projects", input]);
        return page([project()]);
      },
    },
    usageProvider: {
      async listInvocationUsageAggregates(input) {
        calls.push(["usage", input]);
        return page([usageAggregate()]);
      },
      async listBudgets(input) {
        calls.push(["budgets", input]);
        assert.deepEqual(input.scopeKeys, [
          "project:customer_support/case-assist",
        ]);
        return [budget()];
      },
    },
  });

  const result = await service.listCosts(request(builder));

  assert.deepEqual(result, {
    scope: {
      type: "projects",
      domainId: "customer_support",
      projectIds: ["case-assist"],
    },
    window: {
      startTime: "2026-08-24T00:00:00.000Z",
      endTime: "2026-08-25T00:00:00.000Z",
    },
    items: [{
      scopeType: "project",
      domainId: "customer_support",
      projectId: "case-assist",
      invocationCount: 2,
      inputTokens: 150,
      outputTokens: 60,
      estimatedCostUsd: 1.5,
      projectedMonthlyCostUsd: 45,
      monthlyBudgetUsd: 100,
      projectedBudgetUtilizationPercent: 45,
      ...costMetadata,
    }],
    cursor: null,
  });
  const usageCall = calls.find(([name]) => name === "usage")[1];
  assert.equal(usageCall.limit, 20);
  assert.deepEqual(usageCall.scope.projectIds, [
    "customer_support/case-assist",
  ]);
  assert.equal(JSON.stringify(result).includes("agentId"), false);
  assert.equal(JSON.stringify(result).includes("modelId"), false);
});

test("cost projections fail closed when derived values are not finite", async () => {
  const projectionOverflow = serviceWith({
    usageProvider: {
      async listInvocationUsageAggregates() {
        return page([usageAggregate({
          scopeType: "platform",
          domainId: null,
          projectId: null,
          estimatedCostUsd: Number.MAX_VALUE,
        })]);
      },
      async listBudgets() {
        return [];
      },
    },
  }).service;
  await assert.rejects(
    projectionOverflow.listCosts(request(admin)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );

  const utilizationOverflow = serviceWith({
    state: {
      async listProjects() {
        return page([project()]);
      },
    },
    usageProvider: {
      async listInvocationUsageAggregates() {
        return page([usageAggregate()]);
      },
      async listBudgets() {
        return [budget({ monthlyLimitUsd: Number.MIN_VALUE })];
      },
    },
  }).service;
  await assert.rejects(
    utilizationOverflow.listCosts(request(builder)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
});

test("admin costs are returned as one platform aggregate", async () => {
  const { service } = serviceWith({
    state: {
      async listProjects(input) {
        return page([project({
          domainId: input.domainId,
          id: input.domainId === "customer_support"
            ? "case-assist"
            : "operations-project",
        })]);
      },
    },
    usageProvider: {
      async listInvocationUsageAggregates() {
        return page([usageAggregate({
          scopeType: "platform",
          domainId: null,
          projectId: null,
          estimatedCostUsd: 3,
          inputTokens: 200,
          outputTokens: 80,
        })]);
      },
      async listBudgets() {
        return [{
          scopeType: "platform",
          domainId: null,
          projectId: null,
          monthlyLimitUsd: 200,
          currency: "USD",
        }];
      },
    },
  });

  const result = await service.listCosts(request(admin));

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    scopeType: "platform",
    domainId: null,
    projectId: null,
    invocationCount: 2,
    inputTokens: 200,
    outputTokens: 80,
    estimatedCostUsd: 3,
    projectedMonthlyCostUsd: 90,
    monthlyBudgetUsd: 200,
    projectedBudgetUtilizationPercent: 45,
    ...costMetadata,
  });
});

test("empty provider records remain empty instead of fabricating costs", async () => {
  let budgetCalls = 0;
  const { service } = serviceWith({
    usageProvider: {
      async listBudgets() {
        budgetCalls += 1;
        return [budget()];
      },
    },
  });

  const result = await service.listCosts(request(admin));

  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, null);
  assert.equal(budgetCalls, 0);
});

test("cost records outside the authoritative project scope fail closed", async () => {
  const { service } = serviceWith({
    state: {
      async listProjects() {
        return page([project()]);
      },
    },
    usageProvider: {
      async listInvocationUsageAggregates() {
        return page([
          usageAggregate({ projectId: "foreign-project" }),
        ]);
      },
    },
  });

  await assert.rejects(
    service.listCosts(request(builder)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
});

test("provider pagination is opaque, route-bound, and bounded", async () => {
  const providerCursors = [];
  const { service } = serviceWith({
    cloudWatch: {
      async listRuntimeAggregates(input) {
        providerCursors.push(input.cursor);
        return page([operationAggregate()], "provider-next");
      },
    },
  });

  const first = await service.listOperations(request(admin, { limit: 10 }));
  assert.match(first.cursor, /^[A-Za-z0-9_-]+$/);

  await service.listOperations(request(admin, {
    limit: 10,
    cursor: first.cursor,
  }));
  assert.deepEqual(providerCursors, [undefined, "provider-next"]);

  await assert.rejects(
    service.listCosts(request(admin, { cursor: first.cursor })),
    expectCode("NOT_FOUND"),
  );
  await assert.rejects(
    service.listOperations(request(admin, {
      limit: 5,
      cursor: first.cursor,
    })),
    expectCode("NOT_FOUND"),
  );
  await assert.rejects(
    service.listOperations(request(admin, { limit: 51 })),
    expectCode("INVALID_REQUEST"),
  );
});

test("provider cursors are bound to actor, scope, and time window", async () => {
  const providerCursors = [];
  const { service } = serviceWith({
    cloudWatch: {
      async listRuntimeAggregates(input) {
        providerCursors.push(input.cursor);
        return page([operationAggregate()], "provider-next");
      },
    },
  });

  const first = await service.listOperations(request(admin));

  await assert.rejects(
    service.listOperations(request(admin, {
      window: "7d",
      cursor: first.cursor,
    })),
    expectCode("NOT_FOUND"),
  );
  await assert.rejects(
    service.listOperations(request({
      ...admin,
      actor: "different-admin-sub",
    }, {
      cursor: first.cursor,
    })),
    expectCode("NOT_FOUND"),
  );
  assert.deepEqual(providerCursors, [undefined]);
});

test("signed provider cursors reject rewritten query timestamps", async () => {
  const providerCalls = [];
  const { service } = serviceWith({
    cloudWatch: {
      async listRuntimeAggregates(input) {
        providerCalls.push(input);
        return page([operationAggregate()], "provider-next");
      },
    },
  });
  const first = await service.listOperations(request(admin));
  const envelope = JSON.parse(
    Buffer.from(first.cursor, "base64url").toString("utf8"),
  );
  envelope.startTime = "2020-01-01T00:00:00.000Z";
  envelope.endTime = "2020-01-02T00:00:00.000Z";
  const tampered = Buffer.from(
    JSON.stringify(envelope),
  ).toString("base64url");

  await assert.rejects(
    service.listOperations(request(admin, { cursor: tampered })),
    expectCode("NOT_FOUND"),
  );
  assert.equal(providerCalls.length, 1);
});

test("abort signals cancel hung providers and are forwarded to state", async () => {
  const controller = new AbortController();
  let stateSignal;
  let providerSignal;
  const { service } = serviceWith({
    state: {
      async listProjects({ abortSignal }) {
        stateSignal = abortSignal;
        return page([]);
      },
    },
    cloudWatch: {
      async listRuntimeAggregates({ abortSignal }) {
        providerSignal = abortSignal;
        return new Promise(() => {});
      },
    },
  });

  const pending = service.listOperations(request(admin, {
    abortSignal: controller.signal,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(stateSignal, controller.signal);
  assert.equal(providerSignal, controller.signal);
});

test("malformed state and provider schemas return stable non-disclosing errors", async () => {
  const { service } = serviceWith({
    state: {
      async listProjects() {
        return {
          items: [{
            ...project(),
            secret: "state-secret",
          }],
          cursor: null,
        };
      },
    },
  });

  await assert.rejects(
    service.listOperations(request(admin)),
    (error) => {
      assert.ok(error instanceof OperationsServiceError);
      assert.equal(error.code, "OPERATIONS_UNAVAILABLE");
      assert.equal(
        error.message,
        "Operational data is temporarily unavailable.",
      );
      assert.doesNotMatch(error.message, /state-secret|secret/);
      return true;
    },
  );
});

test("state and provider accessors are rejected without being executed", async () => {
  let stateGetterCalls = 0;
  const accessorProject = project();
  Object.defineProperty(accessorProject, "domainId", {
    enumerable: true,
    get() {
      stateGetterCalls += 1;
      throw new Error("state getter executed");
    },
  });
  const stateHarness = serviceWith({
    state: {
      async listProjects() {
        return page([accessorProject]);
      },
    },
  });

  await assert.rejects(
    stateHarness.service.listOperations(request(admin)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
  assert.equal(stateGetterCalls, 0);

  let providerGetterCalls = 0;
  const accessorAggregate = operationAggregate();
  Object.defineProperty(accessorAggregate, "invocationCount", {
    enumerable: true,
    get() {
      providerGetterCalls += 1;
      throw new Error("provider getter executed");
    },
  });
  const providerHarness = serviceWith({
    cloudWatch: {
      async listRuntimeAggregates() {
        return page([accessorAggregate]);
      },
    },
  });

  await assert.rejects(
    providerHarness.service.listOperations(request(admin)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
  assert.equal(providerGetterCalls, 0);

  let cursorCoercionCalls = 0;
  const providerCursor = {};
  Object.defineProperty(providerCursor, Symbol.toPrimitive, {
    get() {
      cursorCoercionCalls += 1;
      throw new Error("cursor coercion executed");
    },
  });
  const cursorHarness = serviceWith({
    cloudWatch: {
      async listRuntimeAggregates() {
        return page([operationAggregate()], providerCursor);
      },
    },
  });

  await assert.rejects(
    cursorHarness.service.listOperations(request(admin)),
    expectCode("OPERATIONS_UNAVAILABLE"),
  );
  assert.equal(cursorCoercionCalls, 0);
});

test("non-string query values fail without coercing caller objects", async () => {
  let coercionCalls = 0;
  const window = {};
  Object.defineProperty(window, Symbol.toPrimitive, {
    get() {
      coercionCalls += 1;
      throw new Error("window coercion executed");
    },
  });
  const { calls, service } = serviceWith();

  await assert.rejects(
    service.listOperations(request(admin, { window })),
    expectCode("INVALID_REQUEST"),
  );
  assert.equal(coercionCalls, 0);
  assert.deepEqual(calls, []);
});

test("unknown costs do not become zero projections or a completed-run KPI", async () => {
  const { service } = serviceWith({
    usageProvider: {
      async listInvocationUsageAggregates() {
        return page([usageAggregate({
          scopeType: "platform", domainId: null, projectId: null,
          inputTokens: null, outputTokens: null, invocationCount: null,
          estimatedCostUsd: null,
        })]);
      },
      async listBudgets() { return []; },
    },
  });
  const result = await service.listCosts(request(admin));
  assert.equal(result.items[0].estimatedCostUsd, null);
  assert.equal(result.items[0].projectedMonthlyCostUsd, null);
  assert.equal(result.items[0].projectedBudgetUtilizationPercent, null);
  assert.equal(result.items[0].runCount, null);
  assert.equal(result.items[0].costPerRunUsd, null);
  assert.equal(result.items[0].completeness, "unavailable");
});
