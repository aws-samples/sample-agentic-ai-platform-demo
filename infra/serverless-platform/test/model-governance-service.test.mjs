import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelGovernanceServiceError,
  createModelGovernanceService,
} from "../lambda/model-governance/service.mjs";

const admin = Object.freeze({
  actor: "admin-sub",
  role: "admin",
  activeDomain: null,
  domainIds: ["platform", "customer_support", "operations"],
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

const models = Object.freeze([
  {
    id: "bedrock-mantle/anthropic.claude-sonnet-4-5",
    type: "Model",
    name: "Claude Sonnet 4.5",
    description: "Anthropic balanced",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      content: {
        gatewayModelId:
          "bedrock-mantle/anthropic.claude-sonnet-4-5",
        ownedBy: "anthropic",
        source: "agentcore-gateway",
      },
    }],
  },
  {
    id: "bedrock-mantle/meta.llama-4-405b",
    type: "Model",
    name: "Llama 4 405B",
    description: "Meta reasoning",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      content: {
        gatewayModelId: "bedrock-mantle/meta.llama-4-405b",
        ownedBy: "meta",
        source: "agentcore-gateway",
      },
    }],
  },
  {
    id: "bedrock-mantle/mistral.large",
    type: "Model",
    name: "Mistral Large",
    description: "Mistral general",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      content: {
        gatewayModelId: "bedrock-mantle/mistral.large",
        ownedBy: "mistral",
        source: "agentcore-gateway",
      },
    }],
  },
]);

const policies = Object.freeze([
  {
    modelId: models[0].id,
    allowedDomains: ["customer_support"],
    requestableDomains: [],
    limits: {
      requestsPerMinute: 60,
      tokensPerMinute: 120000,
      connectionsPerSecond: 4,
    },
    applicationStatus: "ACTIVE",
    rateLimit: {
      id: "platform-model-domain-limits",
      status: "ACTIVE",
      reason: null,
      reconciledAt: "2026-08-25T06:00:00.000Z",
    },
    updatedBySubject: "admin-sub",
    updatedAt: "2026-08-25T06:00:00.000Z",
    revision: 1,
  },
  {
    modelId: models[1].id,
    allowedDomains: [],
    requestableDomains: ["customer_support"],
    limits: {
      requestsPerMinute: 30,
      tokensPerMinute: 60000,
      connectionsPerSecond: 2,
    },
    applicationStatus: "ACTIVE",
    rateLimit: {
      id: "platform-model-domain-limits",
      status: "ACTIVE",
      reason: null,
      reconciledAt: "2026-08-25T06:00:00.000Z",
    },
    updatedBySubject: "admin-sub",
    updatedAt: "2026-08-25T06:00:00.000Z",
    revision: 1,
  },
]);

function approval(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "llama-access",
    kind: "RESOURCE_ACCESS",
    resourceType: "MODEL",
    resourceId: models[1].id,
    projectId: null,
    status: "PENDING",
    requesterSubject: "builder-sub",
    approverSubject: null,
    reason: null,
    requestedAt: "2026-08-25T06:05:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

function grant(overrides = {}) {
  return {
    domainId: "customer_support",
    resourceType: "MODEL",
    resourceId: models[1].id,
    status: "ACTIVE",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T06:10:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function harness({
  policyRecords = policies,
  approvals = [approval()],
  grants = [],
  authorize,
  rateReconcile,
} = {}) {
  const calls = [];
  const service = createModelGovernanceService({
    modelPolicyState: {
      async beginTransaction() {
        calls.push(["policy.beginTransaction"]);
        return {
          timestamp: "2026-08-25T07:00:00.000Z",
          epochSeconds: 1787641200,
        };
      },
      async getModelPolicy({ modelId }) {
        calls.push(["policy.get", modelId]);
        return policyRecords.find((record) => record.modelId === modelId)
          ?? null;
      },
      async listModelPolicies(input) {
        calls.push(["policy.list", input]);
        return { items: [...policyRecords], cursor: null };
      },
      async getMutationResult(input) {
        calls.push(["policy.mutation", input]);
        return null;
      },
      async putModelPolicy(input) {
        calls.push(["policy.put", input]);
        return input.record;
      },
      async finalizeModelPolicyApplication(input) {
        calls.push(["policy.finalize", input]);
        return input.record;
      },
    },
    workspaceState: {
      beginTransaction() {
        calls.push(["workspace.beginTransaction"]);
        return {
          timestamp: "2026-08-25T07:00:00.000Z",
          epochSeconds: 1787641200,
        };
      },
      async listApprovals(input) {
        calls.push(["approval.list", input]);
        return { items: [...approvals], cursor: null };
      },
      async listResourceGrants(input) {
        calls.push(["grant.list", input]);
        return { items: [...grants], cursor: null };
      },
      async getApproval(input) {
        calls.push(["approval.get", input]);
        return approvals.find((item) => item.id === input.approvalId)
          ?? null;
      },
      async getResourceGrant(input) {
        calls.push(["grant.get", input]);
        return grants.find(
          (item) =>
            item.domainId === input.domainId
            && item.resourceType === input.resourceType
            && item.resourceId === input.resourceId,
        ) ?? null;
      },
      async getMutationResult(input) {
        calls.push(["workspace.mutation", input]);
        return null;
      },
      async putApproval(input) {
        calls.push(["approval.put", input]);
        return input.record;
      },
      async putAccessDecision(input) {
        calls.push(["access.put", input]);
        return {
          approval: input.approval.record,
          grant: input.grant?.record ?? null,
        };
      },
    },
    domainDirectory: {
      async listActiveDomains() {
        calls.push(["domains"]);
        return [
          { id: "platform" },
          { id: "customer_support" },
          { id: "operations" },
        ];
      },
    },
    inventoryReader: async () => {
      calls.push(["inventory"]);
      return {
        ok: true,
        source: "aws",
        region: "us-west-2",
        toolsGateway: {
          gatewayId: "platform-tools-abcdefghij",
          name: "platform-tools",
          gatewayUrl: "https://platform-tools-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp",
          targetCount: 1,
          targets: [{ targetId: "aws-docs", name: "AWS Documentation" }],
        },
        llmGateway: {
          gatewayId: "agentic-demo-llm-gateway-abcdefghij",
          name: "agentic-demo-llm-gateway",
          gatewayUrl:
            "https://agentic-demo-llm-gateway-abcdefghij.gateway."
            + "bedrock-agentcore.us-west-2.amazonaws.com/inference/v1",
          modelCount: models.length,
        },
        models: [...models],
      };
    },
    rateLimitManager: {
      async reconcile(input) {
        calls.push(["rateLimits.reconcile", input]);
        if (rateReconcile) return rateReconcile(input);
        return {
          rateLimitId: "platform-model-domain-limits",
          status: "ACTIVE",
          synchronizedAt: "2026-08-25T07:00:00.000Z",
        };
      },
    },
    authorizer: authorize ?? (async (input) => {
      calls.push(["authorize", input]);
      return { ok: true };
    }),
  });
  return { service, calls };
}

function policyInput(overrides = {}) {
  return {
    identity: admin,
    requestId: "apply-model-policy-001",
    modelId: models[1].id,
    allowedDomains: ["operations"],
    requestableDomains: ["customer_support"],
    limits: {
      requestsPerMinute: 45,
      tokensPerMinute: 90000,
      connectionsPerSecond: 3,
    },
    ...overrides,
  };
}

function expectCode(code) {
  return (error) =>
    error instanceof ModelGovernanceServiceError
    && error.code === code;
}

test("Platform Admin sees complete Gateway, model, policy, workflow, and limit state", async () => {
  const { service, calls } = harness({ grants: [grant()] });

  const result = await service.readCatalog({ identity: admin });

  assert.equal(result.region, "us-west-2");
  assert.equal(result.toolsGateway.gatewayId, "platform-tools-abcdefghij");
  assert.equal(result.toolsGateway.targetCount, 1);
  assert.equal(result.toolsGateway.targets[0].targetId, "aws-docs");
  assert.equal(result.llmGateway.gatewayUrl.includes("/inference/v1"), true);
  assert.equal(result.models.length, 3);
  assert.equal(result.models[0].policy.modelId, models[0].id);
  assert.equal(result.models[1].accessByDomain.customer_support.grant.status, "ACTIVE");
  assert.equal(
    result.models[1].accessByDomain.customer_support.latestRequest.status,
    "PENDING",
  );
  assert.equal(result.models[2].policy, null);
  assert.deepEqual(
    calls.filter(([name]) => name === "approval.list").map(([, input]) =>
      input.domainId),
    ["platform", "customer_support", "operations"],
  );
});

test("Domain Lead and Builder receive only their selected-domain redacted catalog", async () => {
  for (const identity of [lead, builder]) {
    const { service } = harness();

    const result = await service.readCatalog({ identity });

    assert.deepEqual(Object.keys(result).sort(), [
      "domainId",
      "models",
      "ok",
      "source",
    ]);
    assert.equal(result.domainId, "customer_support");
    assert.deepEqual(
      result.models.map((model) => [model.id, model.access.status]),
      [
        [models[0].id, "ALLOWED"],
        [models[1].id, "PENDING"],
      ],
    );
    assert.equal(Object.hasOwn(result.models[0], "versions"), false);
    assert.equal(Object.hasOwn(result.models[0], "gatewayUrl"), false);
    assert.equal(
      result.models[0].access.limits.requestsPerMinute,
      60,
    );
    assert.deepEqual(
      Object.keys(result.models[0].access.rateLimit).sort(),
      ["reason", "reconciledAt", "status"],
    );
    assert.equal(
      Object.hasOwn(result.models[0].access.rateLimit, "id"),
      false,
    );
    assert.deepEqual(
      Object.keys(result.models[1].access.latestRequest).sort(),
      ["id", "requestedAt", "status"],
    );
    assert.equal(
      Object.hasOwn(
        result.models[1].access.latestRequest,
        "requesterSubject",
      ),
      false,
    );
  }
});

test("active model grants make requestable models usable for the selected domain", async () => {
  const { service } = harness({
    approvals: [],
    grants: [grant()],
  });

  const result = await service.readCatalog({ identity: builder });

  assert.equal(result.models[1].access.status, "GRANTED");
  assert.equal(result.models[1].access.usable, true);
  assert.deepEqual(
    Object.keys(result.models[1].access.grant).sort(),
    ["grantedAt", "status"],
  );
  assert.equal(
    Object.hasOwn(result.models[1].access.grant, "grantedBySubject"),
    false,
  );
});

test("End User is denied before policy, workflow, domain, or Gateway reads", async () => {
  const { service, calls } = harness({
    authorize: async (input) => {
      calls.push(["authorize", input]);
      const error = new Error("denied");
      error.decision = "FORBIDDEN";
      throw error;
    },
  });

  await assert.rejects(
    service.readCatalog({ identity: user }),
    expectCode("FORBIDDEN"),
  );
  assert.deepEqual(calls.map(([name]) => name), ["authorize"]);
});

test("Platform Admin applies a validated policy only after full native rate-limit reconciliation", async () => {
  const { service, calls } = harness();

  const result = await service.putPolicy(policyInput());

  assert.equal(result.applicationStatus, "ACTIVE");
  assert.equal(result.revision, 2);
  assert.equal(result.rateLimit.status, "ACTIVE");
  const reconcile = calls.find(([name]) => name === "rateLimits.reconcile");
  assert.ok(reconcile);
  assert.deepEqual(
    reconcile[1].policies.map(({ modelId }) => modelId).sort(),
    [models[0].id, models[1].id].sort(),
  );
  const write = calls.find(([name]) => name === "policy.put");
  assert.ok(write);
  assert.equal(write[1].record.modelId, models[1].id);
  assert.equal(write[1].record.applicationStatus, "PENDING");
  assert.equal(write[1].mutation.operation, "UPSERT");
  const finalize = calls.find(([name]) => name === "policy.finalize");
  assert.ok(finalize);
  assert.equal(finalize[1].record.applicationStatus, "ACTIVE");
  assert.equal(finalize[1].mutation.operation, "FINALIZE");
  assert.equal(
    calls.findIndex(([name]) => name === "rateLimits.reconcile")
      > calls.findIndex(([name]) => name === "policy.put"),
    true,
  );
});

test("policy limits accept any non-empty subset and normalize omitted dimensions", async () => {
  const cases = [
    {
      name: "requestsPerMinute",
      input: { requestsPerMinute: 45 },
      expected: {
        requestsPerMinute: 45,
        tokensPerMinute: null,
        connectionsPerSecond: null,
      },
    },
    {
      name: "tokensPerMinute",
      input: { tokensPerMinute: 90_000 },
      expected: {
        requestsPerMinute: null,
        tokensPerMinute: 90_000,
        connectionsPerSecond: null,
      },
    },
    {
      name: "connectionsPerSecond",
      input: { connectionsPerSecond: 3 },
      expected: {
        requestsPerMinute: null,
        tokensPerMinute: null,
        connectionsPerSecond: 3,
      },
    },
    {
      name: "canonical-null-shape",
      input: {
        requestsPerMinute: null,
        tokensPerMinute: 90_000,
        connectionsPerSecond: null,
      },
      expected: {
        requestsPerMinute: null,
        tokensPerMinute: 90_000,
        connectionsPerSecond: null,
      },
    },
  ];

  for (const fixture of cases) {
    const { service, calls } = harness();
    const result = await service.putPolicy(policyInput({
      requestId: `apply-model-policy-${fixture.name}`,
      limits: fixture.input,
    }));

    assert.deepEqual(result.limits, fixture.expected);
    const pending = calls.find(([name]) => name === "policy.put");
    assert.deepEqual(pending[1].record.limits, fixture.expected);
    const reconciliation = calls.find(
      ([name]) => name === "rateLimits.reconcile",
    );
    assert.deepEqual(
      reconciliation[1].policies.find(
        ({ modelId }) => modelId === models[1].id,
      ).limits,
      fixture.expected,
    );
  }
});

test("policy validation rejects an all-omitted active limit set before mutation", async () => {
  const { service, calls } = harness();

  for (const limits of [
    {},
    {
      requestsPerMinute: null,
      tokensPerMinute: null,
      connectionsPerSecond: null,
    },
  ]) {
    await assert.rejects(
      service.putPolicy(policyInput({ limits })),
      expectCode("INVALID_REQUEST"),
    );
  }

  assert.deepEqual(calls, []);
});

test("policy validation rejects unknown models, inactive domains, and overlapping scopes before Gateway mutation", async () => {
  for (const input of [
    policyInput({ modelId: "bedrock-mantle/unknown.model" }),
    policyInput({ allowedDomains: ["inactive_domain"] }),
    policyInput({
      allowedDomains: ["customer_support"],
      requestableDomains: ["customer_support"],
    }),
  ]) {
    const { service, calls } = harness();
    await assert.rejects(
      service.putPolicy(input),
      expectCode("INVALID_REQUEST"),
    );
    assert.equal(
      calls.some(([name]) => name === "rateLimits.reconcile"),
      false,
    );
    assert.equal(
      calls.some(([name]) => name === "policy.put"),
      false,
    );
  }
});

test("Gateway rate-limit failure is recorded as unusable policy evidence", async () => {
  const { service, calls } = harness({
    rateReconcile: async () => {
      throw new Error("backend detail must not escape");
    },
  });

  await assert.rejects(
    service.putPolicy(policyInput()),
    expectCode("MODEL_GOVERNANCE_UNAVAILABLE"),
  );

  const write = calls.find(([name]) => name === "policy.finalize");
  assert.ok(write);
  assert.equal(
    write[1].record.applicationStatus,
    "RECONCILIATION_FAILED",
  );
  assert.equal(write[1].record.rateLimit.id, null);
  assert.equal(
    write[1].record.rateLimit.status,
    "RECONCILIATION_FAILED",
  );
  assert.equal(write[1].mutation.decision, "fail");
});

test("non-Admin policy mutation is centrally denied before authoritative reads", async () => {
  const { service, calls } = harness({
    authorize: async (input) => {
      calls.push(["authorize", input]);
      const error = new Error("denied");
      error.decision = "FORBIDDEN";
      throw error;
    },
  });

  await assert.rejects(
    service.putPolicy(policyInput({
      identity: builder,
      requestId: "builder-policy-attempt",
    })),
    expectCode("FORBIDDEN"),
  );
  assert.deepEqual(calls.map(([name]) => name), ["authorize"]);
});

test("Domain Builder requests access only to a requestable selected-domain model", async () => {
  const { service, calls } = harness({ approvals: [], grants: [] });

  const result = await service.requestAccess({
    identity: builder,
    requestId: "request-model-access-001",
    approvalId: "llama-access-new",
    modelId: models[1].id,
  });

  assert.equal(result.status, "PENDING");
  assert.equal(result.resourceType, "MODEL");
  assert.equal(result.resourceId, models[1].id);
  assert.equal(result.domainId, "customer_support");
  assert.equal(result.requesterSubject, builder.actor);
  const write = calls.find(([name]) => name === "approval.put");
  assert.ok(write);
  assert.equal(write[1].mutation.result.entityType, "APPROVAL");
  assert.equal(write[1].mutation.decision, "create");
});

test("directly allowed, already granted, and non-requestable models cannot create access requests", async () => {
  const cases = [
    {
      input: {
        identity: builder,
        requestId: "request-direct-model",
        approvalId: "direct-access",
        modelId: models[0].id,
      },
      grants: [],
    },
    {
      input: {
        identity: builder,
        requestId: "request-granted-model",
        approvalId: "granted-access",
        modelId: models[1].id,
      },
      grants: [grant()],
    },
    {
      input: {
        identity: builder,
        requestId: "request-missing-policy",
        approvalId: "missing-policy",
        modelId: models[2].id,
      },
      grants: [],
    },
  ];
  for (const item of cases) {
    const { service, calls } = harness({
      approvals: [],
      grants: item.grants,
    });
    await assert.rejects(
      service.requestAccess(item.input),
      expectCode("CONFLICT"),
    );
    assert.equal(
      calls.some(([name]) => name === "approval.put"),
      false,
    );
  }
});

test("a different Domain Lead atomically approves a pending model request and grant", async () => {
  const pending = approval();
  const { service, calls } = harness({
    approvals: [pending],
    grants: [],
  });

  const result = await service.decideAccess({
    identity: lead,
    requestId: "decide-model-access-001",
    approvalId: pending.id,
    decision: "APPROVE",
    reason: "Approved for the domain workload.",
  });

  assert.equal(result.approval.status, "APPROVED");
  assert.equal(result.approval.approverSubject, lead.actor);
  assert.equal(result.grant.status, "ACTIVE");
  assert.equal(result.grant.resourceType, "MODEL");
  const write = calls.find(([name]) => name === "access.put");
  assert.ok(write);
  assert.equal(write[1].approval.expectedStatus, "PENDING");
  assert.equal(write[1].grant.expectedStatus, null);
  assert.equal(
    write[1].approval.mutation.timestamp,
    write[1].grant.mutation.timestamp,
  );
});

test("requester self-approval and Builder decisions are denied before grant writes", async () => {
  for (const identity of [
    { ...lead, actor: "builder-sub" },
    builder,
  ]) {
    const { service, calls } = harness();
    await assert.rejects(
      service.decideAccess({
        identity,
        requestId: `denied-model-decision-${identity.role}`,
        approvalId: "llama-access",
        decision: "APPROVE",
        reason: "Should not be accepted.",
      }),
      expectCode("FORBIDDEN"),
    );
    assert.equal(
      calls.some(([name]) => name === "access.put"),
      false,
    );
  }
});
