import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createExperienceService,
  ExperienceServiceError,
} from "../lambda/experience/service.mjs";
import {
  createWorkspaceState,
} from "../lambda/workspace/state.mjs";

const NOW = "2026-08-25T05:00:00.000Z";
const ACTOR = "user-sub-123";

function actorSessionPrefix(actor = ACTOR) {
  return `session-${
    createHash("sha256").update(actor).digest("hex").slice(0, 16)
  }`;
}

function identity(overrides = {}) {
  return {
    actor: ACTOR,
    role: "user",
    activeDomain: null,
    domainIds: [],
    authenticatedGroups: ["end-user"],
    authenticatedDomains: [],
    ...overrides,
  };
}

function entitlement(overrides = {}) {
  return {
    subject: ACTOR,
    agentId: "triage-agent",
    domainId: "customer_support",
    projectId: "case-assist",
    status: "ACTIVE",
    grantedBySubject: "lead-sub-123",
    grantedAt: "2026-08-25T01:00:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function typedEntitlement(subjectType, subject, overrides = {}) {
  return {
    ...entitlement({
      subject,
      ...overrides,
    }),
    subjectType,
    expiresAt: overrides.expiresAt ?? null,
  };
}

function matchesEntitlementScope(record, input) {
  return (
    (record.subjectType ?? "USER") === (input.subjectType ?? "USER")
    && record.subject === input.subject
  );
}

function agent(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Helps classify customer support requests.",
    ownerSubject: "builder-sub-123",
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    toolIds: ["case-search"],
    mcpServerIds: ["support-mcp"],
    skillIds: ["triage"],
    blueprintIds: ["support-blueprint"],
    memoryIds: ["support-memory"],
    knowledgeBaseIds: ["support-kb"],
    status: "PRODUCTION_DEPLOYED",
    createdBySubject: "builder-sub-123",
    createdAt: "2026-08-25T01:00:00.000Z",
    updatedAt: "2026-08-25T04:00:00.000Z",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: "2026-08-25T02:00:00.000Z",
    lastTestedBySubject: "builder-sub-123",
    lastTestModelId: "bedrock-claude/anthropic.claude-sonnet-5",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "test-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Internal test output.",
    governance: { decision: "APPROVED" },
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support agent workspace.",
    ownerSubject: "builder-sub-123",
    memberSubjects: ["builder-sub-123"],
    status: "ACTIVE",
    createdBySubject: "builder-sub-123",
    createdAt: "2026-08-25T01:00:00.000Z",
    updatedAt: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-production",
    agentId: "triage-agent",
    environment: "PRODUCTION",
    status: "DEPLOYED",
    requesterSubject: "builder-sub-123",
    approverSubject: "lead-sub-123",
    decisionReason: "Approved.",
    requestedAt: "2026-08-25T02:00:00.000Z",
    decidedAt: "2026-08-25T03:00:00.000Z",
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    runtimeArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567",
    runtimeStatus: "READY",
    endpointName: "Production",
    endpointArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime-endpoint/Production",
    runtimeVersion: "1",
    updatedAt: "2026-08-25T04:00:00.000Z",
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    actor: ACTOR,
    id: `${actorSessionPrefix()}-abcdef0123456789`,
    agentId: "triage-agent",
    domainId: "customer_support",
    projectId: "case-assist",
    status: "ACTIVE",
    lastInvocationStatus: "SUCCEEDED",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function accessRequest(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "access-0123456789abcdef0123456789abcdef",
    kind: "RESOURCE_ACCESS",
    resourceType: "AGENT",
    resourceId: "triage-agent",
    projectId: "case-assist",
    status: "PENDING",
    requesterSubject: ACTOR,
    approverSubject: null,
    reason: "Required for customer support duties.",
    requestedAt: NOW,
    decidedAt: null,
    ...overrides,
  };
}

function memoryState({
  entitlements = [entitlement()],
  projects = [project()],
  agents = [agent()],
  deployments = [deployment()],
  approvals = [],
  sessions = [],
  mutationResults = new Map(),
  failures = {},
} = {}) {
  const calls = [];
  const records = {
    entitlements,
    projects,
    agents,
    deployments,
    approvals,
    sessions: [...sessions],
    mutationResults,
  };
  let sequence = 0;
  return {
    calls,
    records,
    beginTransaction() {
      calls.push(["beginTransaction"]);
      const timestamp = new Date(Date.parse(NOW) + sequence * 1000)
        .toISOString();
      sequence += 1;
      return {
        timestamp,
        epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
      };
    },
    async listEntitlements(input) {
      calls.push(["listEntitlements", structuredClone(input)]);
      if (failures.listEntitlements) throw failures.listEntitlements;
      return {
        items: records.entitlements.filter((item) =>
          matchesEntitlementScope(item, input)),
        cursor: null,
      };
    },
    async listProjects(input) {
      calls.push(["listProjects", structuredClone(input)]);
      if (failures.listProjects) throw failures.listProjects;
      return {
        items: records.projects.filter(
          (item) => item.domainId === input.domainId,
        ),
        cursor: null,
      };
    },
    async listAgents(input) {
      calls.push(["listAgents", structuredClone(input)]);
      if (failures.listAgents) throw failures.listAgents;
      return {
        items: records.agents.filter((item) =>
          item.domainId === input.domainId
          && item.projectId === input.projectId),
        cursor: null,
      };
    },
    async getEntitlement(input) {
      calls.push(["getEntitlement", structuredClone(input)]);
      if (failures.getEntitlement) throw failures.getEntitlement;
      return records.entitlements.find((item) =>
        matchesEntitlementScope(item, input)
        && item.domainId === input.domainId
        && item.projectId === input.projectId
        && item.agentId === input.agentId) ?? null;
    },
    async getAgent(input) {
      calls.push(["getAgent", structuredClone(input)]);
      if (failures.getAgent) throw failures.getAgent;
      return records.agents.find((item) =>
        item.domainId === input.domainId
        && item.projectId === input.projectId
        && item.id === input.agentId) ?? null;
    },
    async listDeployments(input) {
      calls.push(["listDeployments", structuredClone(input)]);
      if (failures.listDeployments) throw failures.listDeployments;
      return {
        items: records.deployments.filter((item) =>
          item.domainId === input.domainId
          && item.projectId === input.projectId),
        cursor: null,
      };
    },
    async getSession(input) {
      calls.push(["getSession", structuredClone(input)]);
      if (failures.getSession) throw failures.getSession;
      return records.sessions.find((item) =>
        item.actor === input.actor && item.id === input.sessionId) ?? null;
    },
    async listSessions(input) {
      calls.push(["listSessions", structuredClone(input)]);
      if (failures.listSessions) throw failures.listSessions;
      return {
        items: records.sessions.filter((item) => item.actor === input.actor),
        cursor: null,
      };
    },
    async listAccessRequests(input) {
      calls.push(["listAccessRequests", structuredClone(input)]);
      if (failures.listAccessRequests) {
        throw failures.listAccessRequests;
      }
      return {
        items: records.approvals.filter((item) =>
          item.requesterSubject === input.requesterSubject
          && item.kind === "RESOURCE_ACCESS"
          && item.resourceType === "AGENT"),
        cursor: null,
      };
    },
    async getMutationResult(input) {
      calls.push(["getMutationResult", structuredClone(input)]);
      if (failures.getMutationResult) throw failures.getMutationResult;
      return records.mutationResults.get(
        `${input.actor}|${input.route}|${input.requestId}`,
      ) ?? null;
    },
    async claimMutation(input) {
      calls.push(["claimMutation", structuredClone(input)]);
      if (failures.claimMutation) throw failures.claimMutation;
      return true;
    },
    async putSession(input) {
      calls.push(["putSession", structuredClone(input)]);
      if (failures.putSession) throw failures.putSession;
      const index = records.sessions.findIndex((item) =>
        item.actor === input.record.actor && item.id === input.record.id);
      if (index === -1) records.sessions.push(input.record);
      else records.sessions[index] = input.record;
      records.mutationResults.set(
        `${input.mutation.actor}|${input.mutation.route}|${input.mutation.requestId}`,
        input.mutation,
      );
      return input.record;
    },
    async putApproval(input) {
      calls.push(["putApproval", structuredClone(input)]);
      if (failures.putApproval) throw failures.putApproval;
      records.approvals.push(input.record);
      return input.record;
    },
  };
}

function serviceWith({
  state = memoryState(),
  authorizer,
  domainDirectory,
  runtimeAdapter,
  invocationStore,
  submissionStore,
} = {}) {
  const calls = [];
  const invocationRecords = new Map();
  const service = createExperienceService({
    workspaceState: state,
    domainDirectory: domainDirectory || {
      async listActiveDomains() {
        return [
          { id: "customer_support" },
          { id: "operations" },
        ];
      },
    },
    clock: () => new Date(NOW),
    authorizer: authorizer || (async (input) => {
      calls.push(["authorize", structuredClone(input)]);
      return { ok: true };
    }),
    runtimeAdapter: runtimeAdapter || {
      async invoke(input) {
        calls.push(["runtime", structuredClone(input)]);
        return {
          output: "The request is an account-access issue.",
          invocationId: "runtime-invocation-123",
        };
      },
    },
    invocationStore: invocationStore || {
      async get(input) {
        calls.push(["invocationGet", structuredClone(input)]);
        return invocationRecords.get(
          `${input.actor}|${input.requestId}`,
        ) ?? null;
      },
      async start(input) {
        calls.push(["invocationStart", structuredClone(input)]);
        const key = `${input.actor}|${input.requestId}`;
        if (invocationRecords.has(key)) {
          throw new Error("Invocation journal conflict.");
        }
        const record = {
          ...structuredClone(input),
          phase: "STARTED",
          runtimeStatus: null,
          output: null,
          invocationId: null,
        };
        invocationRecords.set(key, record);
        return structuredClone(record);
      },
      async complete(input) {
        calls.push(["invocationComplete", structuredClone(input)]);
        const key = `${input.actor}|${input.requestId}`;
        const current = invocationRecords.get(key);
        if (!current || current.phase !== "STARTED") {
          throw new Error("Invocation journal conflict.");
        }
        const record = {
          ...current,
          phase: "COMPLETED",
          runtimeStatus: input.runtimeStatus,
          output: input.output,
          invocationId: input.invocationId,
        };
        invocationRecords.set(key, record);
        return structuredClone(record);
      },
    },
    submissionStore: submissionStore || {
      async submitFeedback(input) {
        calls.push(["feedback", structuredClone(input)]);
        return { id: "feedback-123", status: "RECORDED" };
      },
      async reportIssue(input) {
        calls.push(["issue", structuredClone(input)]);
        return { id: "issue-123", status: "RECORDED" };
      },
      async requestAccess(input) {
        calls.push(["access", structuredClone(input)]);
        return { id: "access-123", status: "PENDING" };
      },
    },
  });
  return { calls, service, state };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof ExperienceServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

test("service requires durable state, strict authorization, Runtime, and submission adapters", () => {
  assert.throws(
    () => createExperienceService(),
    /configuration is invalid/i,
  );
  const state = memoryState();
  assert.throws(
    () => createExperienceService({
      workspaceState: state,
      domainDirectory: { listActiveDomains: async () => [] },
      authorizer: async () => ({ ok: true }),
      runtimeAdapter: { invoke: async () => ({}) },
      invocationStore: {
        get: async () => null,
        start: async () => ({}),
        complete: async () => ({}),
      },
    }),
    /submission store/i,
  );
});

test("Experience connects authorized journal dispatch before Runtime and preserves client failures", async () => {
  let record;
  const events = [];
  const { service } = serviceWith({
    invocationStore: {
      async get() { return record ?? null; },
      async start(input) {
        events.push("reserve");
        record = { ...input, phase: "STARTED", runtimeStatus: null, output: null, invocationId: null,
          lifecycle: { version: 1, environment: "PRODUCTION", purpose: "user", startedAt: null, region: null } };
        return structuredClone(record);
      },
      async markDispatched(input) {
        assert.equal(input.domainId, "customer_support");
        assert.equal(input.projectId, "case-assist");
        assert.equal(input.region, "us-west-2");
        events.push("dispatch-marker");
        record.lifecycle = { ...record.lifecycle, startedAt: NOW, region: input.region };
        return structuredClone(record);
      },
      async prepareExecution(input, signed) {
        assert.equal(input.domainId, "customer_support");
        assert.equal(input.projectId, "case-assist");
        assert.equal(input.payloadFingerprint, record.payloadFingerprint);
        assert.deepEqual(signed, { payload: "adapter-owned-signed-payload" });
        events.push("native-binding");
      },
      async complete(input) {
        events.push("terminal");
        record = { ...record, runtimeStatus: input.runtimeStatus, phase: "COMPLETED" };
        return structuredClone(record);
      },
    },
    runtimeAdapter: { async invoke(input) {
      assert.equal(input.nativeExecution.payloadFingerprint, record.payloadFingerprint);
      await input.nativeExecution.prepare({ payload: "adapter-owned-signed-payload" });
      await input.onDispatch({ region: "us-west-2" });
      events.push("sdk");
      throw new Error("transport outcome unknown");
    } },
  });
  const catalog = await service.listAgents({ identity: identity() });
  await assert.rejects(service.invoke({
    identity: identity(), agentId: catalog.items[0].id, requestId: "dispatch-test", prompt: "Synthetic test.",
  }), expectCode("RUNTIME_UNAVAILABLE"));
  assert.deepEqual(events, ["reserve", "native-binding", "dispatch-marker", "sdk", "terminal"]);
  assert.equal(record.lifecycle.startedAt, NOW);
  assert.equal(record.runtimeStatus, "FAILED");
});

test("catalog returns only opaque display identity for active entitled deployed agents", async () => {
  const { service, state, calls } = serviceWith();

  const result = await service.listAgents({ identity: identity() });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.requestableItems, []);
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    "description",
    "id",
    "name",
  ]);
  assert.match(result.items[0].id, /^agent-[a-f0-9]{32}$/);
  assert.equal(result.items[0].name, "Triage Agent");
  assert.equal(result.items[0].description, agent().description);
  assert.equal(
    JSON.stringify(result).includes("customer_support"),
    false,
  );
  for (const secret of [
    "modelId",
    "toolIds",
    "mcpServerIds",
    "blueprintIds",
    "memoryIds",
    "knowledgeBaseIds",
    "runtimeArn",
    "endpointArn",
    "governance",
    "ownerSubject",
    "projectId",
  ]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.deepEqual(
    state.calls.find(([name]) => name === "listEntitlements")[1],
    { subject: ACTOR, limit: 100 },
  );
  assert.equal(calls[0][0], "authorize");
  assert.equal(calls[0][1].requestContext.subject, ACTOR);
});

test("catalog returns a separate safe requestable production-agent catalog usable for access requests", async () => {
  const requestableProject = project({
    domainId: "operations",
    id: "claims-assist",
    name: "Claims Assist",
  });
  const requestableAgent = agent({
    domainId: "operations",
    projectId: "claims-assist",
    id: "claims-agent",
    name: "Claims Agent",
    description: "Helps classify claims.",
    modelId: "bedrock-claude/internal-model-id",
    toolIds: ["claims-search"],
    mcpServerIds: ["claims-mcp"],
    skillIds: ["claims-skill"],
    blueprintIds: ["claims-blueprint"],
    memoryIds: ["claims-memory"],
    knowledgeBaseIds: ["claims-kb"],
  });
  const requestableDeployment = deployment({
    domainId: "operations",
    projectId: "claims-assist",
    agentId: "claims-agent",
    id: "claims-production",
  });
  const state = memoryState({
    projects: [project(), requestableProject],
    agents: [agent(), requestableAgent],
    deployments: [deployment(), requestableDeployment],
  });
  const { service } = serviceWith({ state });

  const result = await service.listAgents({ identity: identity() });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.requestableItems, [{
    id: `agent-${
      createHash("sha256")
        .update("operations\0claims-assist\0claims-agent")
        .digest("hex")
        .slice(0, 32)
    }`,
    domainId: "operations",
    name: "Claims Agent",
    description: "Helps classify claims.",
  }]);
  assert.deepEqual(
    Object.keys(result.requestableItems[0]).sort(),
    ["description", "domainId", "id", "name"],
  );
  for (const secret of [
    "modelId",
    "toolIds",
    "mcpServerIds",
    "skillIds",
    "blueprintIds",
    "memoryIds",
    "knowledgeBaseIds",
    "runtimeArn",
    "endpointArn",
    "governance",
    "ownerSubject",
    "projectId",
    "deployment",
  ]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }

  const requested = result.requestableItems[0];
  const access = await service.requestAccess({
    identity: identity(),
    requestId: "request-from-catalog",
    domainId: requested.domainId,
    agentId: requested.id,
    reason: "Required for claims support duties.",
  });
  assert.equal(access.status, "PENDING");
});

test("requestable catalog fails closed when authoritative discovery fails", async () => {
  for (const fixture of [
    {
      domainDirectory: {
        async listActiveDomains() {
          throw new Error("directory unavailable");
        },
      },
    },
    {
      state: memoryState({
        failures: { listProjects: new Error("state unavailable") },
      }),
    },
  ]) {
    await assert.rejects(
      serviceWith(fixture).service.listAgents({
        identity: identity(),
      }),
      expectCode("EXPERIENCE_UNAVAILABLE"),
    );
  }
});

test("catalog and invocation accept an exact authenticated Cognito group entitlement", async () => {
  const state = memoryState({
    entitlements: [
      typedEntitlement("GROUP", "support-users"),
    ],
  });
  const { calls, service } = serviceWith({ state });
  const currentIdentity = identity({
    authenticatedGroups: ["end-user", "support-users"],
  });

  const catalog = await service.listAgents({ identity: currentIdentity });
  assert.equal(catalog.items.length, 1);
  assert.deepEqual(catalog.requestableItems, []);
  assert.deepEqual(
    state.calls
      .filter(([name]) => name === "listEntitlements")
      .map(([, input]) => input),
    [
      { subject: ACTOR, limit: 100 },
      { subjectType: "GROUP", subject: "end-user", limit: 100 },
      { subjectType: "GROUP", subject: "support-users", limit: 100 },
    ],
  );

  await service.invoke({
    identity: currentIdentity,
    requestId: "group-invoke-request",
    agentId: catalog.items[0].id,
    prompt: "Classify this request.",
  });

  assert.equal(calls.some(([name]) => name === "runtime"), true);
  assert.equal(
    state.calls.some(([name, input]) =>
      name === "getEntitlement"
      && input.subjectType === "GROUP"
      && input.subject === "support-users"),
    true,
  );
});

test("catalog and invocation accept an exact authenticated domain entitlement", async () => {
  const state = memoryState({
    entitlements: [
      typedEntitlement("DOMAIN", "operations"),
    ],
  });
  const { calls, service } = serviceWith({ state });
  const currentIdentity = identity({
    authenticatedGroups: ["end-user", "domain-operations"],
    authenticatedDomains: ["operations"],
  });

  const catalog = await service.listAgents({ identity: currentIdentity });
  assert.equal(catalog.items.length, 1);
  assert.deepEqual(catalog.requestableItems, []);

  await service.invoke({
    identity: currentIdentity,
    requestId: "domain-invoke-request",
    agentId: catalog.items[0].id,
    prompt: "Classify this request.",
  });

  assert.equal(calls.some(([name]) => name === "runtime"), true);
  assert.equal(
    state.calls.some(([name, input]) =>
      name === "getEntitlement"
      && input.subjectType === "DOMAIN"
      && input.subject === "operations"),
    true,
  );
});

test("domain entitlement lookup never widens beyond authenticated domain groups", async () => {
  const state = memoryState({
    entitlements: [
      typedEntitlement("DOMAIN", "customer_support"),
    ],
  });
  const { service } = serviceWith({ state });

  const result = await service.listAgents({
    identity: identity({
      authenticatedGroups: ["end-user", "domain-operations"],
      authenticatedDomains: ["operations"],
    }),
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.requestableItems.length, 1);
  assert.equal(
    result.requestableItems[0].domainId,
    "customer_support",
  );
  const lookups = state.calls
    .filter(([name]) => name === "listEntitlements")
    .map(([, input]) => input);
  assert.equal(
    lookups.some((input) =>
      input.subjectType === "DOMAIN"
      && input.subject === "operations"),
    true,
  );
  assert.equal(
    lookups.some((input) => input.subject === "customer_support"),
    false,
  );
});

test("revoked, expired, malformed, and foreign typed entitlements never grant access", async () => {
  const currentIdentity = identity({
    authenticatedGroups: ["end-user", "support-users", "domain-operations"],
    authenticatedDomains: ["operations"],
  });
  for (const record of [
    typedEntitlement("GROUP", "support-users", {
      status: "REVOKED",
      revokedBySubject: "lead-sub-123",
      revokedAt: NOW,
    }),
    typedEntitlement("GROUP", "support-users", {
      expiresAt: "2026-08-25T04:59:59.000Z",
    }),
    typedEntitlement("DOMAIN", "customer_support"),
  ]) {
    const { service } = serviceWith({
      state: memoryState({ entitlements: [record] }),
    });
    const result = await service.listAgents({
      identity: currentIdentity,
    });
    assert.deepEqual(result.items, []);
    assert.equal(result.requestableItems.length, 1);
  }

  const malformedState = memoryState();
  malformedState.listEntitlements = async ({ subject }) => ({
    items: subject === ACTOR
      ? [entitlement({
          revokedBySubject: "lead-sub-123",
          revokedAt: NOW,
        })]
      : [],
    cursor: null,
  });
  await assert.rejects(
    serviceWith({ state: malformedState }).service.listAgents({
      identity: identity(),
    }),
    expectCode("EXPERIENCE_UNAVAILABLE"),
  );
});

test("invocation rechecks every authoritative grant and denies a revoked group grant", async () => {
  const grant = typedEntitlement("GROUP", "support-users");
  const state = memoryState({ entitlements: [grant] });
  const { calls, service } = serviceWith({ state });
  const currentIdentity = identity({
    authenticatedGroups: ["end-user", "support-users"],
  });
  const catalog = await service.listAgents({ identity: currentIdentity });

  Object.assign(grant, {
    status: "REVOKED",
    revokedBySubject: "lead-sub-123",
    revokedAt: NOW,
  });

  await assert.rejects(
    service.invoke({
      identity: currentIdentity,
      requestId: "revoked-group-invoke",
      agentId: catalog.items[0].id,
      prompt: "Do not run.",
    }),
    expectCode("NOT_FOUND"),
  );
  assert.equal(calls.some(([name]) => name === "runtime"), false);
});

test("catalog fails closed on entitlement-store failure or an incomplete page", async () => {
  const failed = serviceWith({
    state: memoryState({
      failures: { listEntitlements: new Error("database details") },
    }),
  });
  await assert.rejects(
    failed.service.listAgents({ identity: identity() }),
    expectCode("EXPERIENCE_UNAVAILABLE"),
  );

  const state = memoryState();
  state.listEntitlements = async () => ({
    items: [entitlement()],
    cursor: "another-page",
  });
  const paged = serviceWith({ state });
  await assert.rejects(
    paged.service.listAgents({ identity: identity() }),
    expectCode("EXPERIENCE_UNAVAILABLE"),
  );
});

test("catalog makes inactive grants requestable but conceals non-production agents", async () => {
  const scenarios = [
    {
      state: memoryState({
        entitlements: [entitlement({
          status: "REVOKED",
          revokedBySubject: "lead-sub-123",
          revokedAt: NOW,
        })],
      }),
      requestableCount: 1,
    },
    {
      state: memoryState({ agents: [agent({ status: "DRAFT" })] }),
      requestableCount: 0,
    },
    {
      state: memoryState({ agents: [agent({ status: "REJECTED" })] }),
      requestableCount: 0,
    },
    {
      state: memoryState({ agents: [agent({ status: "RETIRED" })] }),
      requestableCount: 0,
    },
    {
      state: memoryState({
        deployments: [deployment({ status: "SUSPENDED" })],
      }),
      requestableCount: 0,
    },
    {
      state: memoryState({
        deployments: [deployment({ status: "FAILED" })],
      }),
      requestableCount: 0,
    },
    {
      state: memoryState({
        deployments: [deployment({ environment: "SANDBOX" })],
      }),
      requestableCount: 0,
    },
  ];

  for (const scenario of scenarios) {
    const { service } = serviceWith(scenario);
    const result = await service.listAgents({
      identity: identity(),
    });
    assert.deepEqual(result.items, []);
    assert.equal(
      result.requestableItems.length,
      scenario.requestableCount,
    );
  }
});

test("catalog rejects bare, accessor-backed, and extended authorization decisions", async () => {
  const accessor = {};
  Object.defineProperty(accessor, "ok", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  for (const decision of [
    true,
    { ok: true, decision: "ALLOW" },
    accessor,
    Object.assign(Object.create({ ok: true }), {}),
  ]) {
    const { service } = serviceWith({
      authorizer: async () => decision,
    });
    await assert.rejects(
      service.listAgents({ identity: identity() }),
      expectCode("FORBIDDEN"),
    );
  }
});

test("catalog filters an authoritatively denied entitled agent", async () => {
  const denial = Object.assign(new Error("policy denied"), {
    decision: "FORBIDDEN",
  });
  const { service } = serviceWith({
    authorizer: async () => {
      throw denial;
    },
  });

  assert.deepEqual(
    await service.listAgents({ identity: identity() }),
    { items: [], requestableItems: [] },
  );
});

test("catalog requires complete governed Runtime and endpoint identity", async () => {
  for (const overrides of [
    { runtimeArn: null },
    { runtimeArn: "https://attacker.example/runtime" },
    { endpointArn: null },
    { endpointArn: "https://attacker.example/endpoint" },
  ]) {
    const { service } = serviceWith({
      state: memoryState({
        deployments: [deployment(overrides)],
      }),
    });
    assert.deepEqual(
      await service.listAgents({ identity: identity() }),
      { items: [], requestableItems: [] },
    );
  }
});

test("only the effective End User with an immutable actor may use the service", async () => {
  const { service } = serviceWith();
  for (const invalid of [
    identity({ actor: "" }),
    identity({ role: "admin" }),
    identity({ activeDomain: "customer_support" }),
    identity({ domainIds: ["customer_support"] }),
    identity({ authenticatedGroups: ["end-user", "end-user"] }),
    identity({
      authenticatedGroups: ["end-user", "domain-operations"],
      authenticatedDomains: ["customer_support"],
    }),
    { ...identity(), subject: "forged-sub" },
  ]) {
    await assert.rejects(
      service.listAgents({ identity: invalid }),
      expectCode(
        invalid.role === "admin" ? "FORBIDDEN" : "INVALID_REQUEST",
      ),
    );
  }
});

test("invocation resolves opaque agent identity and calls only the governed Runtime adapter", async () => {
  const { service, calls, state } = serviceWith();
  const catalog = await service.listAgents({ identity: identity() });
  calls.length = 0;
  state.calls.length = 0;

  const result = await service.invoke({
    identity: identity(),
    requestId: "invoke-request-123",
    agentId: catalog.items[0].id,
    prompt: "I cannot access my account.",
  });

  assert.match(
    result.sessionId,
    /^session-[a-f0-9]{16}-[a-f0-9]{16}$/,
  );
  assert.deepEqual(result, {
    sessionId: result.sessionId,
    status: "SUCCEEDED",
    output: "The request is an account-access issue.",
    invocationId: "runtime-invocation-123",
    replayed: false,
  });
  const runtime = calls.find(([name]) => name === "runtime")[1];
  assert.deepEqual(Object.keys(runtime).sort(), [
    "actor",
    "agent",
    "deployment",
    "prompt",
    "requestId",
    "sessionId",
  ]);
  assert.equal(runtime.actor, ACTOR);
  assert.equal(runtime.agent.modelId, agent().modelId);
  assert.equal(runtime.deployment.runtimeArn, deployment().runtimeArn);
  assert.equal(
    Object.hasOwn(runtime, "url")
      || Object.hasOwn(runtime, "credentials"),
    false,
  );
  const written = state.calls.find(([name]) => name === "putSession")[1];
  assert.equal(written.record.actor, ACTOR);
  assert.equal(written.record.lastInvocationStatus, "SUCCEEDED");
  assert.equal(written.mutation.actor, ACTOR);
  assert.equal(written.mutation.effectiveRole, "user");
  assert.equal(
    written.mutation.route,
    "POST /api/experience/invocations",
  );
});

test("invocation session evidence satisfies the real workspace state contract", async () => {
  const { service, state } = serviceWith();
  const catalog = await service.listAgents({ identity: identity() });
  state.calls.length = 0;

  await service.invoke({
    identity: identity(),
    requestId: "invoke-request-123",
    agentId: catalog.items[0].id,
    prompt: "I cannot access my account.",
  });

  const captured = state.calls.find(
    ([name]) => name === "putSession",
  )[1];
  const commands = [];
  const realState = createWorkspaceState({
    tableName: "PlatformState",
    dynamo: {
      async send(command) {
        commands.push(command);
        return {};
      },
    },
    now: () => NOW,
  });
  const {
    transaction: _memoryTransaction,
    ...standaloneWrite
  } = captured;

  assert.deepEqual(
    await realState.putSession(standaloneWrite),
    captured.record,
  );
  assert.equal(commands.length, 1);
});

test("invocation never accepts browser trust-boundary configuration", async () => {
  const { service, calls } = serviceWith();
  const { items } = await service.listAgents({ identity: identity() });
  calls.length = 0;
  const forgedFields = [
    ["actor", "forged-sub"],
    ["domainId", "finance"],
    ["projectId", "foreign"],
    ["role", "admin"],
    ["entitlement", { status: "ACTIVE" }],
    ["modelId", "attacker-model"],
    ["toolIds", ["attacker-tool"]],
    ["runtimeUrl", "https://attacker.example"],
    ["runtimeArn", "arn:aws:bedrock-agentcore:x:x:runtime/x"],
    ["endpoint", "attacker"],
    ["credentials", { accessKeyId: "secret" }],
  ];
  for (const [field, value] of forgedFields) {
    await assert.rejects(
      service.invoke({
        identity: identity(),
        requestId: "invoke-request-123",
        agentId: items[0].id,
        prompt: "Hello",
        [field]: value,
      }),
      expectCode("INVALID_REQUEST"),
    );
  }
  assert.equal(calls.some(([name]) => name === "runtime"), false);
});

test("invocation denies revoked, foreign, and invalid-lifecycle agent access before Runtime", async () => {
  const base = serviceWith();
  const publicId = (await base.service.listAgents({
    identity: identity(),
  })).items[0].id;
  const scenarios = [
    memoryState({
      entitlements: [entitlement({
        status: "REVOKED",
        revokedBySubject: "lead-sub-123",
        revokedAt: NOW,
      })],
    }),
    memoryState({
      entitlements: [entitlement({ subject: "other-sub" })],
    }),
    memoryState({ agents: [agent({ status: "REJECTED" })] }),
    memoryState({ agents: [agent({ status: "RETIRED" })] }),
    memoryState({
      deployments: [deployment({ status: "SUSPENDED" })],
    }),
    memoryState({
      deployments: [deployment({ environment: "SANDBOX" })],
    }),
  ];

  for (const state of scenarios) {
    const { calls, service } = serviceWith({ state });
    await assert.rejects(
      service.invoke({
        identity: identity(),
        requestId: "invoke-request-123",
        agentId: publicId,
        prompt: "Hello",
      }),
      expectCode("NOT_FOUND"),
    );
    assert.equal(calls.some(([name]) => name === "runtime"), false);
  }
});

test("foreign actor-bound sessions are concealed before state and Runtime access", async () => {
  const { service, calls, state } = serviceWith();
  const { items } = await service.listAgents({ identity: identity() });
  calls.length = 0;
  state.calls.length = 0;

  await assert.rejects(
    service.invoke({
      identity: identity(),
      requestId: "invoke-request-123",
      agentId: items[0].id,
      sessionId: "session-ffffffffffffffff-abcdef0123456789",
      prompt: "Hello",
    }),
    expectCode("NOT_FOUND"),
  );

  assert.equal(
    state.calls.some(([name]) => name === "getSession"),
    false,
  );
  assert.equal(calls.some(([name]) => name === "runtime"), false);
});

test("an existing session must belong to the same authoritative agent", async () => {
  const initial = serviceWith();
  const publicId = (await initial.service.listAgents({
    identity: identity(),
  })).items[0].id;
  const state = memoryState({
    sessions: [session({
      id: `${actorSessionPrefix()}-abcdef0123456789`,
      agentId: "different-agent",
    })],
  });
  const { calls, service } = serviceWith({ state });

  await assert.rejects(
    service.invoke({
      identity: identity(),
      requestId: "invoke-request-123",
      agentId: publicId,
      sessionId: state.records.sessions[0].id,
      prompt: "Hello",
    }),
    expectCode("NOT_FOUND"),
  );
  assert.equal(calls.some(([name]) => name === "runtime"), false);
});

test("request IDs are claimed before Runtime and completed mutations replay without reinvocation", async () => {
  const { service, calls, state } = serviceWith();
  const { items } = await service.listAgents({ identity: identity() });
  calls.length = 0;
  state.calls.length = 0;
  const first = await service.invoke({
    identity: identity(),
    requestId: "invoke-request-123",
    agentId: items[0].id,
    prompt: "Hello",
  });
  const runtimeCalls = calls.filter(([name]) => name === "runtime").length;
  const replay = await service.invoke({
    identity: identity(),
    requestId: "invoke-request-123",
    agentId: items[0].id,
    sessionId: first.sessionId,
    prompt: "Hello",
  });

  assert.equal(
    state.calls.findIndex(([name]) => name === "claimMutation")
      < state.calls.findIndex(([name]) => name === "putSession"),
    true,
  );
  assert.equal(
    calls.filter(([name]) => name === "runtime").length,
    runtimeCalls,
  );
  assert.deepEqual(replay, {
    sessionId: first.sessionId,
    status: "SUCCEEDED",
    output: "The request is an account-access issue.",
    invocationId: "runtime-invocation-123",
    replayed: true,
  });
});

test("a completed Runtime outcome repairs failed session persistence without reinvoking Runtime", async () => {
  const state = memoryState();
  const originalPutSession = state.putSession.bind(state);
  let putAttempts = 0;
  state.putSession = async (input) => {
    putAttempts += 1;
    if (putAttempts === 1) {
      throw new Error("temporary session persistence failure");
    }
    return originalPutSession(input);
  };
  let runtimeCalls = 0;
  const { service, calls } = serviceWith({
    state,
    runtimeAdapter: {
      async invoke() {
        runtimeCalls += 1;
        calls.push(["runtimeAttempt", runtimeCalls]);
        return {
          output: "Durable original output.",
          invocationId: "runtime-durable-original",
        };
      },
    },
  });
  const { items } = await service.listAgents({ identity: identity() });
  const input = {
    identity: identity(),
    requestId: "invoke-session-write-recovery",
    agentId: items[0].id,
    prompt: "Recover this exact result",
  };

  await assert.rejects(
    service.invoke(input),
    expectCode("EXPERIENCE_UNAVAILABLE"),
  );
  assert.equal(runtimeCalls, 1);
  assert.equal(
    calls.filter(([name]) => name === "invocationComplete").length,
    1,
  );

  const recovered = await service.invoke(input);

  assert.deepEqual(recovered, {
    sessionId: recovered.sessionId,
    status: "SUCCEEDED",
    output: "Durable original output.",
    invocationId: "runtime-durable-original",
    replayed: true,
  });
  assert.equal(runtimeCalls, 1);
  assert.equal(putAttempts, 2);
});

test("an indeterminate post-Runtime journal failure never invokes Runtime again", async () => {
  const records = new Map();
  let runtimeCalls = 0;
  let completeCalls = 0;
  const invocationStore = {
    async get(input) {
      return records.get(`${input.actor}|${input.requestId}`) ?? null;
    },
    async start(input) {
      const record = {
        ...structuredClone(input),
        phase: "STARTED",
        runtimeStatus: null,
        output: null,
        invocationId: null,
      };
      records.set(`${input.actor}|${input.requestId}`, record);
      return record;
    },
    async complete() {
      completeCalls += 1;
      throw new Error("journal completion unavailable");
    },
  };
  const { service } = serviceWith({
    invocationStore,
    runtimeAdapter: {
      async invoke() {
        runtimeCalls += 1;
        return {
          output: "Runtime may have caused side effects.",
          invocationId: "runtime-indeterminate",
        };
      },
    },
  });
  const { items } = await service.listAgents({ identity: identity() });
  const input = {
    identity: identity(),
    requestId: "invoke-indeterminate-outcome",
    agentId: items[0].id,
    prompt: "Do this once",
  };

  await assert.rejects(
    service.invoke(input),
    expectCode("INVOCATION_OUTCOME_UNKNOWN"),
  );
  await assert.rejects(
    service.invoke(input),
    expectCode("INVOCATION_OUTCOME_UNKNOWN"),
  );

  assert.equal(runtimeCalls, 1);
  assert.equal(completeCalls, 1);
});

test("a malformed post-Runtime journal acknowledgement remains indeterminate", async () => {
  let started;
  let runtimeCalls = 0;
  const { service } = serviceWith({
    invocationStore: {
      async get() {
        return started ?? null;
      },
      async start(input) {
        started = {
          ...structuredClone(input),
          phase: "STARTED",
          runtimeStatus: null,
          output: null,
          invocationId: null,
        };
        return started;
      },
      async complete() {
        return { phase: "COMPLETED" };
      },
    },
    runtimeAdapter: {
      async invoke() {
        runtimeCalls += 1;
        return {
          output: "Runtime completed.",
          invocationId: "runtime-malformed-ack",
        };
      },
    },
  });
  const { items } = await service.listAgents({ identity: identity() });
  const input = {
    identity: identity(),
    requestId: "invoke-malformed-journal-ack",
    agentId: items[0].id,
    prompt: "Do this once",
  };

  await assert.rejects(
    service.invoke(input),
    expectCode("INVOCATION_OUTCOME_UNKNOWN"),
  );
  await assert.rejects(
    service.invoke(input),
    expectCode("INVOCATION_OUTCOME_UNKNOWN"),
  );
  assert.equal(runtimeCalls, 1);
});

test("recovery refuses to overwrite a session changed after the original Runtime result", async () => {
  const state = memoryState({
    sessions: [session()],
  });
  const originalPutSession = state.putSession.bind(state);
  let putAttempts = 0;
  state.putSession = async (input) => {
    putAttempts += 1;
    if (putAttempts === 1) {
      throw new Error("temporary session persistence failure");
    }
    return originalPutSession(input);
  };
  let runtimeCalls = 0;
  const { service } = serviceWith({
    state,
    runtimeAdapter: {
      async invoke() {
        runtimeCalls += 1;
        return {
          output: "Original output.",
          invocationId: "runtime-original",
        };
      },
    },
  });
  const { items } = await service.listAgents({ identity: identity() });
  const input = {
    identity: identity(),
    requestId: "invoke-session-baseline-conflict",
    agentId: items[0].id,
    sessionId: state.records.sessions[0].id,
    prompt: "Do not overwrite later session state",
  };

  await assert.rejects(
    service.invoke(input),
    expectCode("EXPERIENCE_UNAVAILABLE"),
  );
  state.records.sessions[0] = session({
    updatedAt: "2026-08-25T05:00:10.000Z",
    lastInvocationStatus: "FAILED",
  });

  await assert.rejects(
    service.invoke(input),
    expectCode("CONFLICT"),
  );
  assert.equal(runtimeCalls, 1);
  assert.equal(putAttempts, 1);
});

test("successful invocation replay remains successful after a later session failure", async () => {
  let runtimeCalls = 0;
  const { service } = serviceWith({
    runtimeAdapter: {
      async invoke() {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          return {
            output: "Original success.",
            invocationId: "runtime-success-original",
          };
        }
        throw new Error("later Runtime failure");
      },
    },
  });
  const { items } = await service.listAgents({ identity: identity() });
  const first = await service.invoke({
    identity: identity(),
    requestId: "invoke-success-original",
    agentId: items[0].id,
    prompt: "Original prompt",
  });

  await assert.rejects(
    service.invoke({
      identity: identity(),
      requestId: "invoke-failure-later",
      agentId: items[0].id,
      sessionId: first.sessionId,
      prompt: "Later prompt",
    }),
    expectCode("RUNTIME_UNAVAILABLE"),
  );

  assert.deepEqual(
    await service.invoke({
      identity: identity(),
      requestId: "invoke-success-original",
      agentId: items[0].id,
      sessionId: first.sessionId,
      prompt: "Original prompt",
    }),
    {
      sessionId: first.sessionId,
      status: "SUCCEEDED",
      output: "Original success.",
      invocationId: "runtime-success-original",
      replayed: true,
    },
  );
  assert.equal(runtimeCalls, 2);
});

test("failed invocation replay remains failed after a later session success", async () => {
  let runtimeCalls = 0;
  const { service, state } = serviceWith({
    runtimeAdapter: {
      async invoke() {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          throw new Error("original Runtime failure");
        }
        return {
          output: "Later success.",
          invocationId: "runtime-success-later",
        };
      },
    },
  });
  const { items } = await service.listAgents({ identity: identity() });

  await assert.rejects(
    service.invoke({
      identity: identity(),
      requestId: "invoke-failure-original",
      agentId: items[0].id,
      prompt: "Original prompt",
    }),
    expectCode("RUNTIME_UNAVAILABLE"),
  );
  const sessionId = state.records.sessions[0].id;
  await service.invoke({
    identity: identity(),
    requestId: "invoke-success-later",
    agentId: items[0].id,
    sessionId,
    prompt: "Later prompt",
  });

  await assert.rejects(
    service.invoke({
      identity: identity(),
      requestId: "invoke-failure-original",
      agentId: items[0].id,
      sessionId,
      prompt: "Original prompt",
    }),
    expectCode("RUNTIME_UNAVAILABLE"),
  );
  assert.equal(runtimeCalls, 2);
});

test("Runtime failures persist a bounded failed outcome and expose no provider details", async () => {
  const runtimeFailure = Object.assign(
    new Error("credential SECRET and endpoint details"),
    { statusCode: 503, retryable: true },
  );
  const { service, state } = serviceWith({
    runtimeAdapter: {
      async invoke() {
        throw runtimeFailure;
      },
    },
  });
  const { items } = await service.listAgents({ identity: identity() });

  await assert.rejects(
    service.invoke({
      identity: identity(),
      requestId: "invoke-request-123",
      agentId: items[0].id,
      prompt: "Hello",
    }),
    (error) => (
      expectCode("RUNTIME_UNAVAILABLE")(error)
      && !String(error).includes("SECRET")
    ),
  );
  const written = state.calls.find(([name]) => name === "putSession")[1];
  assert.equal(written.record.lastInvocationStatus, "FAILED");
});

test("malformed or oversized Runtime outcomes fail closed", async () => {
  const accessor = {};
  Object.defineProperty(accessor, "output", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  Object.defineProperty(accessor, "invocationId", {
    enumerable: true,
    value: "runtime-request",
  });
  for (const outcome of [
    { output: "ok", invocationId: "valid", extra: true },
    { output: "x".repeat(65_537), invocationId: "valid" },
    { output: "ok", invocationId: "invalid id with spaces" },
    accessor,
  ]) {
    const { service } = serviceWith({
      runtimeAdapter: { async invoke() { return outcome; } },
    });
    const { items } = await service.listAgents({ identity: identity() });
    await assert.rejects(
      service.invoke({
        identity: identity(),
        requestId: "invoke-request-123",
        agentId: items[0].id,
        prompt: "Hello",
      }),
      expectCode("RUNTIME_UNAVAILABLE"),
    );
  }
});

test("personal sessions are listed only under the immutable actor and redact scope", async () => {
  const state = memoryState({
    sessions: [
      session(),
      session({ actor: "other-sub", id: "session-other" }),
    ],
  });
  const { service } = serviceWith({ state });

  const result = await service.listSessions({ identity: identity() });

  assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    "agentId",
    "createdAt",
    "id",
    "lastInvocationStatus",
    "status",
    "updatedAt",
  ]);
  assert.equal(JSON.stringify(result).includes("customer_support"), false);
  assert.equal(JSON.stringify(result).includes("case-assist"), false);
  assert.deepEqual(
    state.calls.find(([name]) => name === "listSessions")[1],
    { actor: ACTOR, limit: 100 },
  );
});

test("agent access requests are listed only for the immutable actor with public agent identity", async () => {
  const own = accessRequest();
  const state = memoryState({
    approvals: [
      own,
      accessRequest({
        id: "access-fedcba9876543210fedcba9876543210",
        requesterSubject: "other-user-sub",
      }),
    ],
  });
  const { service } = serviceWith({ state });

  const result = await service.listAccessRequests({
    identity: identity(),
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    "agentId",
    "decidedAt",
    "domainId",
    "id",
    "reason",
    "requestedAt",
    "status",
  ]);
  assert.match(result.items[0].agentId, /^agent-[a-f0-9]{32}$/);
  assert.equal(result.items[0].domainId, "customer_support");
  assert.equal(result.items[0].status, "PENDING");
  assert.equal(JSON.stringify(result).includes("case-assist"), false);
  assert.equal(JSON.stringify(result).includes("triage-agent"), false);
  assert.deepEqual(
    state.calls.find(([name]) => name === "listAccessRequests")[1],
    { requesterSubject: ACTOR, limit: 100 },
  );
});

test("feedback and issue reports require an entitled matching personal session", async () => {
  const seed = serviceWith();
  const agentId = (await seed.service.listAgents({
    identity: identity(),
  })).items[0].id;
  const ownedSession = session({
    id: `${actorSessionPrefix()}-abcdef0123456789`,
  });
  const { service, calls } = serviceWith({
    state: memoryState({ sessions: [ownedSession] }),
  });

  const feedback = await service.submitFeedback({
    identity: identity(),
    requestId: "feedback-request-123",
    agentId,
    sessionId: ownedSession.id,
    rating: 4,
    comment: "Useful response.",
  });
  const issue = await service.reportIssue({
    identity: identity(),
    requestId: "issue-request-123",
    agentId,
    sessionId: ownedSession.id,
    description: "The answer omitted the escalation path.",
  });

  assert.deepEqual(feedback, { id: "feedback-123", status: "RECORDED" });
  assert.deepEqual(issue, { id: "issue-123", status: "RECORDED" });
  const feedbackInput = calls.find(([name]) => name === "feedback")[1];
  const issueInput = calls.find(([name]) => name === "issue")[1];
  assert.equal(feedbackInput.actor, ACTOR);
  assert.equal(feedbackInput.effectiveRole, "user");
  assert.deepEqual(feedbackInput.agent, {
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
  });
  assert.match(feedbackInput.payloadFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(issueInput.actor, ACTOR);
  assert.deepEqual(issueInput.agent, {
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
  });
  assert.match(issueInput.payloadFingerprint, /^[a-f0-9]{64}$/);
});

test("feedback rejects whitespace-only comments before submission", async () => {
  const seed = serviceWith();
  const agentId = (await seed.service.listAgents({
    identity: identity(),
  })).items[0].id;
  const ownedSession = session();
  const { calls, service } = serviceWith({
    state: memoryState({ sessions: [ownedSession] }),
  });

  await assert.rejects(
    service.submitFeedback({
      identity: identity(),
      requestId: "feedback-request-123",
      agentId,
      sessionId: ownedSession.id,
      rating: 4,
      comment: "   ",
    }),
    expectCode("INVALID_REQUEST"),
  );
  assert.equal(calls.some(([name]) => name === "feedback"), false);
});

test("access requests resolve a real production agent and create a domain approval", async () => {
  const { service, state, calls } = serviceWith({
    state: memoryState({ entitlements: [] }),
  });
  const publicAgentId = `agent-${
    createHash("sha256")
      .update("customer_support\0case-assist\0triage-agent")
      .digest("hex")
      .slice(0, 32)
  }`;
  const result = await service.requestAccess({
    identity: identity(),
    requestId: "access-request-123",
    domainId: "customer_support",
    agentId: publicAgentId,
    reason: "Required for customer support duties.",
  });

  assert.match(result.id, /^access-[a-f0-9]{32}$/);
  assert.equal(result.status, "PENDING");
  const write = state.calls.find(([name]) => name === "putApproval")[1];
  assert.deepEqual(write.record, {
    domainId: "customer_support",
    id: result.id,
    kind: "RESOURCE_ACCESS",
    resourceType: "AGENT",
    resourceId: "triage-agent",
    projectId: "case-assist",
    status: "PENDING",
    requesterSubject: ACTOR,
    approverSubject: null,
    reason: "Required for customer support duties.",
    requestedAt: NOW,
    decidedAt: null,
  });
  assert.equal(
    calls.find(([name]) => name === "authorize")[1].action,
    "agent:access-request",
  );
});

test("access requests reject an existing active USER, GROUP, or DOMAIN entitlement", async () => {
  const publicAgentId = `agent-${
    createHash("sha256")
      .update("customer_support\0case-assist\0triage-agent")
      .digest("hex")
      .slice(0, 32)
  }`;
  const fixtures = [
    {
      name: "USER",
      identity: identity(),
      entitlement: typedEntitlement("USER", ACTOR),
      expectedLookup: { subject: ACTOR },
    },
    {
      name: "GROUP",
      identity: identity({
        authenticatedGroups: ["end-user", "support-users"],
      }),
      entitlement: typedEntitlement("GROUP", "support-users"),
      expectedLookup: {
        subjectType: "GROUP",
        subject: "support-users",
      },
    },
    {
      name: "DOMAIN",
      identity: identity({
        authenticatedGroups: ["end-user", "domain-operations"],
        authenticatedDomains: ["operations"],
      }),
      entitlement: typedEntitlement("DOMAIN", "operations"),
      expectedLookup: {
        subjectType: "DOMAIN",
        subject: "operations",
      },
    },
  ];

  for (const fixture of fixtures) {
    const state = memoryState({
      entitlements: [fixture.entitlement],
    });
    const { service } = serviceWith({ state });

    await assert.rejects(
      service.requestAccess({
        identity: fixture.identity,
        requestId: `access-request-${fixture.name.toLowerCase()}`,
        domainId: "customer_support",
        agentId: publicAgentId,
        reason: "Required for customer support duties.",
      }),
      expectCode("CONFLICT"),
      fixture.name,
    );
    assert.equal(
      state.calls.some(([name]) => name === "putApproval"),
      false,
      fixture.name,
    );
    assert.ok(
      state.calls.some(([name, input]) =>
        name === "getEntitlement"
        && input.subject === fixture.expectedLookup.subject
        && (
          fixture.expectedLookup.subjectType === undefined
          ? input.subjectType === undefined
          : input.subjectType === fixture.expectedLookup.subjectType
        )),
      fixture.name,
    );
  }
});

test("expired or revoked typed entitlements do not block a new access request", async () => {
  const publicAgentId = `agent-${
    createHash("sha256")
      .update("customer_support\0case-assist\0triage-agent")
      .digest("hex")
      .slice(0, 32)
  }`;
  const records = [
    typedEntitlement("USER", ACTOR, {
      expiresAt: "2026-08-25T04:59:59.000Z",
    }),
    typedEntitlement("GROUP", "support-users", {
      status: "REVOKED",
      revokedBySubject: "lead-sub-123",
      revokedAt: "2026-08-25T04:30:00.000Z",
    }),
  ];
  const state = memoryState({ entitlements: records });
  const { service } = serviceWith({ state });

  const result = await service.requestAccess({
    identity: identity({
      authenticatedGroups: ["end-user", "support-users"],
    }),
    requestId: "access-request-after-expiry",
    domainId: "customer_support",
    agentId: publicAgentId,
    reason: "Access needs to be renewed.",
  });

  assert.equal(result.status, "PENDING");
  assert.equal(
    state.calls.filter(([name]) => name === "putApproval").length,
    1,
  );
});

test("submission integration failures fail closed without a local fallback", async () => {
  const seed = serviceWith();
  const agentId = (await seed.service.listAgents({
    identity: identity(),
  })).items[0].id;
  const state = memoryState({
    sessions: [session({
      id: `${actorSessionPrefix()}-abcdef0123456789`,
    })],
  });
  const failedStore = {
    async submitFeedback() { throw new Error("storage failed"); },
    async reportIssue() { throw new Error("storage failed"); },
    async requestAccess() { throw new Error("storage failed"); },
  };
  const { service } = serviceWith({
    state,
    submissionStore: failedStore,
  });

  await assert.rejects(
    service.submitFeedback({
      identity: identity(),
      requestId: "feedback-request-123",
      agentId,
      sessionId: state.records.sessions[0].id,
      rating: 5,
      comment: "Good.",
    }),
    expectCode("SUBMISSION_UNAVAILABLE"),
  );
  const unavailable = serviceWith({
    state: memoryState({
      entitlements: [],
      failures: { listProjects: new Error("storage failed") },
    }),
  }).service;
  await assert.rejects(
    unavailable.requestAccess({
      identity: identity(),
      requestId: "access-request-123",
      domainId: "customer_support",
      agentId: "agent-0123456789abcdef0123456789abcdef",
      reason: "Required for my work.",
    }),
    expectCode("EXPERIENCE_UNAVAILABLE"),
  );
});

test("experience persists provider accounting under the authorized journal scope", async () => {
  const requestId = "accounting-request-1";
  const accounting = {
    version: 1,
    runId: createHash("sha256").update(`${ACTOR}\0${requestId}`).digest("hex"),
    attemptId: "gateway-1", environment: "PRODUCTION", purpose: "user",
    modelId: agent().modelId, providerRequestId: "provider-1", traceId: null,
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    metering: null, execution: null, pricingVersion: null, estimatedCostUsd: null,
  };
  const { service, calls } = serviceWith({
    runtimeAdapter: { async invoke() {
      return { output: "ok", invocationId: "provider-1", accounting };
    } },
  });
  const catalog = await service.listAgents({ identity: identity() });
  await service.invoke({ identity: identity(), requestId, agentId: catalog.items[0].id, prompt: "Test" });
  const completion = calls.find(([name]) => name === "invocationComplete")[1];
  assert.deepEqual(completion.accounting, accounting);
  assert.equal(completion.domainId, "customer_support");
  assert.equal(completion.projectId, "case-assist");
});
