import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import {
  WorkspaceServiceError,
  createWorkspaceService,
} from "../lambda/workspace/service.mjs";
import {
  createWorkspaceInventoryAuthorizer,
} from "../lambda/workspace/runtime.mjs";
import { createAuthorizer } from "../lambda/authz/authorize.mjs";
import { createWorkspaceState } from "../lambda/workspace/state.mjs";

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
const platformAdmin = Object.freeze({
  actor: "admin-sub",
  role: "admin",
  activeDomain: null,
  domainIds: ["platform", "customer_support", "operations"],
});
const TRANSACTION = Object.freeze({
  timestamp: "2026-08-25T04:00:00.000Z",
  epochSeconds: Math.floor(
    Date.parse("2026-08-25T04:00:00.000Z") / 1000,
  ),
});

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support workspace.",
    ownerSubject: "builder-sub",
    memberSubjects: ["builder-sub"],
    status: "ACTIVE",
    createdBySubject: "lead-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

function agentBuildConfig() {
  return {
    instructions: "Route incoming support cases to the right queue.",
    modelParameters: {
      temperature: 0.2,
      maxTokens: 1024,
    },
    buildOptions: {
      framework: "Strands",
      deployTarget: "AgentCore Runtime",
      memory: "shortTerm",
      streaming: true,
      identity: true,
      guardrails: true,
    },
  };
}

function agent(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Routes support cases.",
    ownerSubject: "builder-sub",
    modelId: "anthropic.claude",
    toolIds: ["case-search"],
    mcpServerIds: ["support-mcp"],
    skillIds: ["case-triage"],
    blueprintIds: ["support-blueprint"],
    memoryIds: ["support-memory"],
    knowledgeBaseIds: ["support-kb"],
    buildConfig: agentBuildConfig(),
    status: "TESTED",
    createdBySubject: "builder-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    updatedAt: "2026-08-25T02:00:00.000Z",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: "2026-08-25T02:00:00.000Z",
    lastTestedBySubject: "builder-sub",
    lastTestModelId: "anthropic.claude",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request-123",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Test response.",
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-prod-001",
    agentId: "triage-agent",
    environment: "PRODUCTION",
    status: "REQUESTED",
    requesterSubject: "builder-sub",
    approverSubject: null,
    decisionReason: null,
    requestedAt: "2026-08-25T03:00:00.000Z",
    decidedAt: null,
    runtimeId: null,
    runtimeArn: null,
    runtimeStatus: null,
    endpointName: null,
    endpointArn: null,
    runtimeVersion: null,
    updatedAt: "2026-08-25T03:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "approval-prod-001",
    kind: "PRODUCTION_DEPLOYMENT",
    resourceType: "DEPLOYMENT",
    resourceId: "triage-prod-001",
    projectId: "case-assist",
    status: "PENDING",
    requesterSubject: "builder-sub",
    approverSubject: null,
    reason: null,
    requestedAt: "2026-08-25T03:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

function page(items, cursor = null) {
  return { items, cursor };
}

function projectPayload(overrides = {}) {
  return {
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support workspace.",
    ...overrides,
  };
}

function payloadFingerprint(value) {
  const canonical = Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, value[key]]),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function serviceWith({
  authorizer = async () => ({ ok: true }),
  state = {},
} = {}) {
  return createWorkspaceService({
    authorizer,
    workspaceState: {
      async listProjects() {
        return page([]);
      },
      async listAgents() {
        return page([]);
      },
      async listDeployments() {
        return page([]);
      },
      async listApprovals() {
        return page([]);
      },
      beginTransaction() {
        return TRANSACTION;
      },
      async getMutationResult() {
        return null;
      },
      async getProject() {
        return null;
      },
      async putProject({ record }) {
        return record;
      },
      ...state,
    },
  });
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof WorkspaceServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

test("workspace service requires a complete state adapter and authorizer", () => {
  assert.throws(
    () => createWorkspaceService({}),
    /Workspace state configuration is invalid/,
  );
  assert.throws(
    () => createWorkspaceService({
      workspaceState: {
        listProjects() {},
        listAgents() {},
        listDeployments() {},
        listApprovals() {},
      },
    }),
    /Workspace authorizer is invalid/,
  );
});

test("Domain Lead creates one ACTIVE project in the effective selected domain", async () => {
  const calls = [];
  const authorization = [];
  const payload = projectPayload();
  const expected = project({
    ownerSubject: "lead-sub",
    memberSubjects: [],
    createdAt: TRANSACTION.timestamp,
  });
  const service = serviceWith({
    authorizer: async (request) => {
      authorization.push(request);
      return { ok: true };
    },
    state: {
      async getMutationResult(input) {
        calls.push(["getMutationResult", input]);
        return null;
      },
      async getProject(input) {
        calls.push(["getProject", input]);
        return null;
      },
      beginTransaction() {
        calls.push(["beginTransaction"]);
        return TRANSACTION;
      },
      async putProject(input) {
        calls.push(["putProject", input]);
        return input.record;
      },
    },
  });

  const result = await service.createProject({
    identity: lead,
    requestId: "create-project-001",
    payload,
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(calls.map(([name]) => name), [
    "getMutationResult",
    "getProject",
    "beginTransaction",
    "putProject",
  ]);
  assert.deepEqual(calls[0][1], {
    actor: "lead-sub",
    route: "POST /api/projects",
    requestId: "create-project-001",
  });
  assert.deepEqual(calls[1][1], {
    domainId: "customer_support",
    projectId: "case-assist",
  });
  assert.equal(authorization.length, 1);
  assert.equal(authorization[0].action, "project:create");
  assert.deepEqual(authorization[0].requestContext, {
    source: "workspace-api",
    subject: "lead-sub",
    role: "lead",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
    abortSignal: undefined,
  });
  assert.match(
    authorization[0].resourceRef,
    /^workspace-domain:projects:[A-Za-z0-9_-]+$/,
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(
      authorization[0].resourceRef.split(":").at(-1),
      "base64url",
    ).toString("utf8")),
    {
      v: 1,
      route: "projects",
      domainId: "customer_support",
      projectId: "case-assist",
      subject: "lead-sub",
    },
  );
  assert.deepEqual(calls[3][1], {
    record: expected,
    expectedStatus: null,
    mutation: {
      actor: "lead-sub",
      requesterSubject: "lead-sub",
      effectiveRole: "lead",
      domainId: "customer_support",
      projectId: "case-assist",
      route: "POST /api/projects",
      requestId: "create-project-001",
      payloadFingerprint: payloadFingerprint(payload),
      result: {
        entityType: "PROJECT",
        resourceKey: "project/customer_support/case-assist",
        operation: "CREATE",
        status: "SUCCEEDED",
      },
      decision: "create",
      reason: "Authorized project creation.",
      timestamp: TRANSACTION.timestamp,
      createdAt: TRANSACTION.timestamp,
    },
    transaction: TRANSACTION,
  });
});

test("Platform Admin project creation is server-bound to the platform domain", async () => {
  let write;
  const service = serviceWith({
    state: {
      async putProject(input) {
        write = input;
        return input.record;
      },
    },
  });

  const result = await service.createProject({
    identity: platformAdmin,
    requestId: "create-platform-project-001",
    payload: projectPayload({ id: "platform-assistant" }),
  });

  assert.equal(result.domainId, "platform");
  assert.equal(result.ownerSubject, "admin-sub");
  assert.equal(result.createdBySubject, "admin-sub");
  assert.deepEqual(result.memberSubjects, []);
  assert.equal(write.mutation.domainId, "platform");
  assert.equal(write.mutation.projectId, "platform-assistant");
});

test("Domain Builder cannot create a project even through a direct API call", async () => {
  let write;
  const service = serviceWith({
    authorizer: createWorkspaceInventoryAuthorizer(),
    state: {
      async putProject(input) {
        write = input;
        return input.record;
      },
    },
  });

  await assert.rejects(service.createProject({
    identity: builder,
    requestId: "builder-project-create",
    payload: projectPayload(),
  }), error => error.code === "FORBIDDEN");
  assert.equal(write, undefined);
});

test("End User project creation is centrally denied before state", async () => {
  let authorizationCalls = 0;
  let stateCalls = 0;
  const service = serviceWith({
    authorizer: async () => {
      authorizationCalls += 1;
      return { ok: true };
    },
    state: {
      async getMutationResult() {
        stateCalls += 1;
        return null;
      },
      async getProject() {
        stateCalls += 1;
        return null;
      },
      async putProject() {
        stateCalls += 1;
      },
    },
  });

  await assert.rejects(
    service.createProject({
      identity: user,
      requestId: "denied-user",
      payload: projectPayload(),
    }),
    expectCode("FORBIDDEN"),
  );
  assert.equal(authorizationCalls, 1);
  assert.equal(stateCalls, 0);
});

test("End User project creation reaches the production capability denial before state", async () => {
  const productionAuthorizer = createWorkspaceInventoryAuthorizer();
  let authorizationError;
  let stateCalls = 0;
  const service = serviceWith({
    authorizer: async (input) => {
      try {
        return await productionAuthorizer(input);
      } catch (error) {
        authorizationError = error;
        throw error;
      }
    },
    state: {
      async getMutationResult() {
        stateCalls += 1;
        return null;
      },
      async getProject() {
        stateCalls += 1;
        return null;
      },
      async putProject() {
        stateCalls += 1;
      },
    },
  });

  await assert.rejects(
    service.createProject({
      identity: user,
      requestId: "production-user-project-create",
      payload: projectPayload(),
    }),
    expectCode("FORBIDDEN"),
  );

  assert.equal(authorizationError?.decision, "FORBIDDEN");
  assert.equal(authorizationError?.reason, "CAPABILITY");
  assert.equal(stateCalls, 0);
});

test("project creation passes the real workspace state mutation contract", async () => {
  const commands = [];
  const responses = [{}, {}, {}];
  const workspaceState = createWorkspaceState({
    tableName: "PlatformState",
    now: () => TRANSACTION.timestamp,
    dynamo: {
      async send(command) {
        commands.push(command);
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("Unexpected DynamoDB command.");
        }
        return response;
      },
    },
  });
  const service = createWorkspaceService({
    workspaceState,
    authorizer: async () => ({ ok: true }),
  });

  const result = await service.createProject({
    identity: lead,
    requestId: "real-state-project-create",
    payload: projectPayload(),
  });

  assert.equal(result.id, "case-assist");
  assert.equal(result.domainId, "customer_support");
  assert.equal(commands.length, 3);
  assert.ok(commands[2] instanceof TransactWriteItemsCommand);
});

test("project creation accepts only bounded id, name, and description", async () => {
  const service = serviceWith();
  for (const payload of [
    { ...projectPayload(), domainId: "operations" },
    { ...projectPayload(), ownerSubject: "forged-sub" },
    { ...projectPayload(), status: "ARCHIVED" },
    projectPayload({ id: "Invalid_ID" }),
    projectPayload({ id: `a${"b".repeat(64)}` }),
    projectPayload({ name: "n".repeat(129) }),
    projectPayload({ description: "d".repeat(4097) }),
  ]) {
    await assert.rejects(
      service.createProject({
        identity: lead,
        requestId: "invalid-project-payload",
        payload,
      }),
      expectCode("INVALID_REQUEST"),
    );
  }
});

test("same project request and payload replays exactly without duplicate writes", async () => {
  let mutationResult = null;
  let storedProject = null;
  let transactions = 0;
  let writes = 0;
  let authorizations = 0;
  const state = {
    async getMutationResult() {
      return mutationResult;
    },
    async getProject() {
      return storedProject;
    },
    beginTransaction() {
      transactions += 1;
      return TRANSACTION;
    },
    async putProject(input) {
      writes += 1;
      storedProject = structuredClone(input.record);
      mutationResult = structuredClone(input.mutation);
      return structuredClone(input.record);
    },
  };
  const service = serviceWith({
    authorizer: async () => {
      authorizations += 1;
      return { ok: true };
    },
    state,
  });
  const input = {
    identity: lead,
    requestId: "replay-project-001",
    payload: projectPayload(),
  };

  const created = await service.createProject(input);
  const replayed = await service.createProject(input);

  assert.deepEqual(replayed, created);
  assert.equal(transactions, 1);
  assert.equal(writes, 1);
  assert.equal(authorizations, 2);
});

test("project replay is reauthorized before returning stored state", async () => {
  let mutationResult = null;
  let storedProject = null;
  let authorizationCalls = 0;
  const service = serviceWith({
    authorizer: async () => {
      authorizationCalls += 1;
      if (authorizationCalls > 1) {
        throw Object.assign(new Error("revoked"), {
          decision: "FORBIDDEN",
        });
      }
      return { ok: true };
    },
    state: {
      async getMutationResult() {
        return mutationResult;
      },
      async getProject() {
        return storedProject;
      },
      async putProject(input) {
        mutationResult = structuredClone(input.mutation);
        storedProject = structuredClone(input.record);
        return structuredClone(input.record);
      },
    },
  });
  const input = {
    identity: lead,
    requestId: "reauthorized-replay-001",
    payload: projectPayload(),
  };

  await service.createProject(input);
  await assert.rejects(
    service.createProject(input),
    expectCode("FORBIDDEN"),
  );
  assert.equal(authorizationCalls, 2);
});

test("concurrent identical project requests replay the one committed record", async () => {
  let initialMutationReads = 0;
  let initialProjectReads = 0;
  let releaseMutationReads;
  let releaseProjectReads;
  let storedMutation = null;
  let storedProject = null;
  let transactionSequence = 0;
  let writes = 0;
  const mutationReadGate = new Promise((resolve) => {
    releaseMutationReads = resolve;
  });
  const projectReadGate = new Promise((resolve) => {
    releaseProjectReads = resolve;
  });
  const service = serviceWith({
    state: {
      async getMutationResult() {
        if (initialMutationReads < 2) {
          initialMutationReads += 1;
          if (initialMutationReads === 2) releaseMutationReads();
          await mutationReadGate;
          return null;
        }
        return storedMutation;
      },
      async getProject() {
        if (initialProjectReads < 2) {
          initialProjectReads += 1;
          if (initialProjectReads === 2) releaseProjectReads();
          await projectReadGate;
          return null;
        }
        return storedProject;
      },
      beginTransaction() {
        const timestamp = new Date(
          Date.parse(TRANSACTION.timestamp) + transactionSequence,
        ).toISOString();
        transactionSequence += 1;
        return {
          timestamp,
          epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
        };
      },
      async putProject(input) {
        writes += 1;
        if (storedProject === null) {
          storedMutation = structuredClone(input.mutation);
          storedProject = structuredClone(input.record);
          return structuredClone(input.record);
        }
        throw Object.assign(new Error("concurrent collision"), {
          code: "MUTATION_CONFLICT",
        });
      },
    },
  });
  const input = {
    identity: lead,
    requestId: "concurrent-project-001",
    payload: projectPayload(),
  };

  const [left, right] = await Promise.all([
    service.createProject(input),
    service.createProject(input),
  ]);

  assert.deepEqual(left, storedProject);
  assert.deepEqual(right, storedProject);
  assert.equal(writes, 2);
  assert.equal(transactionSequence, 2);
});

test("changed project payload or mutation ownership conflicts without another write", async () => {
  let storedMutation;
  let storedProject;
  let writes = 0;
  const service = serviceWith({
    state: {
      async getMutationResult() {
        return storedMutation ?? null;
      },
      async getProject() {
        return storedProject ?? null;
      },
      async putProject(input) {
        writes += 1;
        storedMutation = structuredClone(input.mutation);
        storedProject = structuredClone(input.record);
        return input.record;
      },
    },
  });
  const original = {
    identity: lead,
    requestId: "owned-project-request",
    payload: projectPayload(),
  };
  await service.createProject(original);

  await assert.rejects(
    service.createProject({
      ...original,
      payload: projectPayload({ name: "Changed Name" }),
    }),
    expectCode("CONFLICT"),
  );
  storedMutation = {
    ...storedMutation,
    requesterSubject: "different-owner-sub",
  };
  await assert.rejects(
    service.createProject(original),
    expectCode("CONFLICT"),
  );
  assert.equal(writes, 1);
});

test("an existing project ID or transactional mutation collision is a stable conflict", async () => {
  await assert.rejects(
    serviceWith({
      state: {
        async getProject() {
          return project();
        },
      },
    }).createProject({
      identity: lead,
      requestId: "existing-project-id",
      payload: projectPayload(),
    }),
    expectCode("CONFLICT"),
  );

  await assert.rejects(
    serviceWith({
      state: {
        async putProject() {
          throw Object.assign(new Error("collision"), {
            code: "MUTATION_CONFLICT",
          });
        },
      },
    }).createProject({
      identity: lead,
      requestId: "transaction-collision",
      payload: projectPayload(),
    }),
    expectCode("CONFLICT"),
  );
});

test("admin project inventory fans out across authoritative domains with the central authorizer request shape", async () => {
  const calls = [];
  const authorization = [];
  const service = serviceWith({
    authorizer: async (request) => {
      authorization.push(request);
      return { ok: true };
    },
    state: {
      async listProjects(input) {
        calls.push(input);
        return page([
          project({
            domainId: input.domainId,
            id: `${input.domainId.replaceAll("_", "-")}-project`,
          }),
        ]);
      },
    },
  });

  const result = await service.listProjects({
    identity: admin,
    limit: 20,
  });

  assert.deepEqual(
    result.items.map(({ domainId, id }) => ({ domainId, id })),
    [
      {
        domainId: "customer_support",
        id: "customer-support-project",
      },
      { domainId: "operations", id: "operations-project" },
    ],
  );
  assert.equal(result.cursor, null);
  assert.deepEqual(
    calls.map(({ domainId, limit }) => ({ domainId, limit })),
    [
      { domainId: "customer_support", limit: 20 },
      { domainId: "operations", limit: 19 },
    ],
  );
  assert.equal(authorization.length, 3);
  assert.deepEqual(Object.keys(authorization[0]).sort(), [
    "action",
    "requestContext",
    "resourceRef",
  ]);
  assert.equal(authorization[0].action, "workspace.projects.read");
  assert.deepEqual(authorization[0].requestContext, {
    source: "workspace-api",
    subject: "admin-sub",
    role: "admin",
    activeDomain: null,
    domainIds: ["customer_support", "operations"],
    abortSignal: undefined,
  });
  assert.match(
    authorization[0].resourceRef,
    /^workspace-collection:projects:[A-Za-z0-9_-]+$/,
  );
  assert.ok(
    authorization.slice(1).every(
      ({ action, resourceRef }) =>
        action === "workspace.projects.read"
        && /^workspace-item:projects:[A-Za-z0-9_-]+$/.test(resourceRef),
    ),
  );
  assert.equal("capabilities" in authorization[0], false);
  assert.equal("policy" in authorization[0], false);
  assert.equal("lifecycle" in authorization[0], false);
  assert.equal("requirements" in authorization[0], false);
});

test("lead inventory is confined to the selected domain", async () => {
  const calls = [];
  const service = serviceWith({
    state: {
      async listProjects(input) {
        calls.push(input);
        return page([project()]);
      },
    },
  });

  const result = await service.listProjects({
    identity: lead,
    limit: 10,
  });

  assert.deepEqual(result.items, [project()]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].domainId, "customer_support");
});

test("builder project inventory exposes projects owned by or explicitly assigned to the actor", async () => {
  const service = serviceWith({
    state: {
      async listProjects() {
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
  });

  const result = await service.listProjects({
    identity: builder,
    limit: 10,
  });

  assert.deepEqual(result.items, [
    project(),
    project({
      id: "assigned-project",
      ownerSubject: "other-builder",
      memberSubjects: ["builder-sub"],
    }),
  ]);
});

test("assigned builders see all centrally permitted agents in visible projects", async () => {
  const agentCalls = [];
  const service = serviceWith({
    state: {
      async listProjects() {
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
      async listAgents(input) {
        agentCalls.push(input);
        return page([
          agent({
            id: `${input.projectId}-owned-agent`,
            projectId: input.projectId,
          }),
          agent({
            id: `${input.projectId}-foreign-agent`,
            projectId: input.projectId,
            ownerSubject: "other-builder",
          }),
        ]);
      },
    },
  });

  const result = await service.listAgents({
    identity: builder,
    limit: 10,
  });

  assert.deepEqual(
    result.items.map(({ id }) => id),
    [
      "case-assist-owned-agent",
      "case-assist-foreign-agent",
      "assigned-project-owned-agent",
      "assigned-project-foreign-agent",
    ],
  );
  assert.deepEqual(
    agentCalls.map(({ domainId, projectId }) => ({
      domainId,
      projectId,
    })),
    [
      { domainId: "customer_support", projectId: "case-assist" },
      { domainId: "customer_support", projectId: "assigned-project" },
    ],
  );
});

test("agent inventory preserves durable configuration and test evidence", async () => {
  const service = serviceWith({
    state: {
      async listProjects() {
        return page([project()]);
      },
      async listAgents() {
        return page([agent()]);
      },
    },
  });

  const result = await service.listAgents({
    identity: builder,
    limit: 10,
  });

  assert.deepEqual(result.items, [agent()]);
});

test("agent inventory preserves multiline model test output after production deployment", async () => {
  const deployedAgent = agent({
    status: "PRODUCTION_DEPLOYED",
    lastTestOutput:
      "The acceptance agent is ready.\n\n- Runtime: ready\n- Policy: passed",
  });
  const service = serviceWith({
    state: {
      async listProjects({ domainId }) {
        return page(
          domainId === deployedAgent.domainId ? [project()] : [],
        );
      },
      async listAgents() {
        return page([deployedAgent]);
      },
    },
  });

  const result = await service.listAgents({
    identity: admin,
    limit: 10,
  });

  assert.deepEqual(result.items, [deployedAgent]);
});

test("agent inventory preserves failed test evidence", async () => {
  const failedAgent = agent({
    status: "TEST_FAILED",
    lastTestStatus: "FAILED",
    lastTestInputTokens: 0,
    lastTestOutputTokens: 0,
    lastTestOutput: null,
  });
  const service = serviceWith({
    state: {
      async listProjects() {
        return page([project()]);
      },
      async listAgents() {
        return page([failedAgent]);
      },
    },
  });

  const result = await service.listAgents({
    identity: builder,
    limit: 10,
  });

  assert.deepEqual(result.items, [failedAgent]);
});

test("assigned builders see all centrally permitted deployments in visible projects", async () => {
  const deploymentCalls = [];
  const service = serviceWith({
    state: {
      async listProjects() {
        return page([project()]);
      },
      async listDeployments(input) {
        deploymentCalls.push(input);
        return page([
          deployment({
            id: "owned-deployment",
            projectId: input.projectId,
          }),
          deployment({
            id: "foreign-deployment",
            projectId: input.projectId,
            requesterSubject: "other-builder",
          }),
        ]);
      },
    },
  });

  const result = await service.listDeployments({
    identity: builder,
    limit: 10,
  });

  assert.deepEqual(
    result.items.map(({ id }) => id),
    ["owned-deployment", "foreign-deployment"],
  );
  assert.deepEqual(
    deploymentCalls.map(({ domainId, projectId }) => ({
      domainId,
      projectId,
    })),
    [{ domainId: "customer_support", projectId: "case-assist" }],
  );
});

test("approval visibility follows the approved role matrix", async () => {
  const calls = [];
  const service = serviceWith({
    state: {
      async listApprovals(input) {
        calls.push(input);
        return page([
          approval({
            domainId: input.domainId,
            id: `${input.domainId.replaceAll("_", "-")}-owned`,
          }),
          approval({
            domainId: input.domainId,
            id: `${input.domainId.replaceAll("_", "-")}-foreign`,
            requesterSubject: "other-builder",
          }),
        ]);
      },
    },
  });

  const adminResult = await service.listApprovals({
    identity: admin,
    limit: 20,
  });
  const leadResult = await service.listApprovals({
    identity: lead,
    limit: 20,
  });
  const builderResult = await service.listApprovals({
    identity: builder,
    limit: 20,
  });

  // Admins additionally read the virtual "shared" partition — shared-catalog
  // publication approvals persist there and have no domain team of their own.
  // Leads and builders keep their exact domain scope.
  assert.equal(adminResult.items.length, 6);
  assert.equal(leadResult.items.length, 2);
  assert.deepEqual(
    builderResult.items.map(({ id }) => id),
    ["customer-support-owned"],
  );
  assert.deepEqual(
    calls.map(({ domainId }) => domainId),
    [
      "customer_support",
      "operations",
      "shared",
      "customer_support",
      "customer_support",
    ],
  );
});

test("approval inventory accepts memory and knowledge-base resources", async () => {
  const service = serviceWith({
    state: {
      async listApprovals() {
        return page([
          approval({
            id: "memory-publication",
            kind: "RESOURCE_PUBLICATION",
            resourceType: "MEMORY",
            resourceId: "support-memory",
          }),
          approval({
            id: "knowledge-base-access",
            kind: "RESOURCE_ACCESS",
            resourceType: "KNOWLEDGE_BASE",
            resourceId: "support-kb",
          }),
        ]);
      },
    },
  });

  const result = await service.listApprovals({
    identity: lead,
    limit: 10,
  });

  assert.deepEqual(
    result.items.map(({ resourceType }) => resourceType),
    ["MEMORY", "KNOWLEDGE_BASE"],
  );
});

test("builder approvals include own requests and requests in assigned projects", async () => {
  const service = serviceWith({
    state: {
      async listProjects() {
        return page([
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
      async listApprovals() {
        return page([
          approval({ id: "own-request" }),
          approval({
            id: "assigned-request",
            projectId: "assigned-project",
            requesterSubject: "other-builder",
          }),
          approval({
            id: "foreign-request",
            projectId: "foreign-project",
            requesterSubject: "other-builder",
          }),
        ]);
      },
    },
  });

  const result = await service.listApprovals({
    identity: builder,
    limit: 10,
  });

  assert.deepEqual(
    result.items.map(({ id }) => id),
    ["own-request", "assigned-request"],
  );
});

test("every returned item is centrally authorized from authoritative item metadata", async () => {
  const requests = [];
  const service = serviceWith({
    authorizer: async (request) => {
      requests.push(request);
      if (!request.resourceRef.startsWith("workspace-item:")) {
        return { ok: true };
      }
      const encoded = request.resourceRef.split(":").at(-1);
      const descriptor = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      return descriptor.id === "hidden-project"
        ? { ok: false }
        : { ok: true };
    },
    state: {
      async listProjects() {
        return page([
          project(),
          project({ id: "hidden-project" }),
        ]);
      },
    },
  });

  const result = await service.listProjects({
    identity: lead,
    limit: 10,
  });

  assert.deepEqual(result.items, [project()]);
  assert.equal(requests.length, 3);
  const itemRequests = requests.slice(1);
  assert.ok(itemRequests.every(
    ({ action }) => action === "workspace.projects.read",
  ));
  const descriptor = JSON.parse(
    Buffer.from(
      itemRequests[0].resourceRef.split(":").at(-1),
      "base64url",
    ).toString("utf8"),
  );
  assert.deepEqual(descriptor, {
    v: 1,
    route: "projects",
    id: "case-assist",
    domainId: "customer_support",
    projectId: "case-assist",
    ownerId: "builder-sub",
    assigneeIds: ["builder-sub"],
    lifecycleState: "ACTIVE",
  });
});

test("all collection routes use exact workspace action contracts for collection and item checks", async () => {
  const cases = [
    {
      method: "listProjects",
      action: "workspace.projects.read",
      state: {
        async listProjects() {
          return page([project()]);
        },
      },
    },
    {
      method: "listAgents",
      action: "workspace.agents.read",
      state: {
        async listProjects() {
          return page([project()]);
        },
        async listAgents() {
          return page([agent()]);
        },
      },
    },
    {
      method: "listDeployments",
      action: "workspace.deployments.read",
      state: {
        async listProjects() {
          return page([project()]);
        },
        async listDeployments() {
          return page([deployment()]);
        },
      },
    },
    {
      method: "listApprovals",
      action: "workspace.approvals.read",
      state: {
        async listApprovals() {
          return page([approval()]);
        },
      },
    },
  ];

  for (const entry of cases) {
    const actions = [];
    const service = serviceWith({
      authorizer: async ({ action }) => {
        actions.push(action);
        return { ok: true };
      },
      state: entry.state,
    });
    await service[entry.method]({
      identity: lead,
      limit: 10,
    });
    assert.deepEqual(actions, [entry.action, entry.action]);
  }
});

test("end users and denied authorization never reach workspace state", async () => {
  let stateCalls = 0;
  const state = {
    async listProjects() {
      stateCalls += 1;
      return page([]);
    },
  };
  const user = {
    actor: "user-sub",
    role: "user",
    activeDomain: null,
    domainIds: [],
  };

  await assert.rejects(
    serviceWith({ state }).listProjects({
      identity: user,
      limit: 10,
    }),
    expectCode("FORBIDDEN"),
  );
  await assert.rejects(
    serviceWith({
      authorizer: async () => ({ ok: false }),
      state,
    }).listProjects({
      identity: lead,
      limit: 10,
    }),
    expectCode("FORBIDDEN"),
  );
  assert.equal(stateCalls, 0);
});

test("actor, domain, and project scope cannot be supplied outside identity", async () => {
  const service = serviceWith();
  for (const extra of [
    { actor: "forged-sub" },
    { domainId: "operations" },
    { projectId: "foreign-project" },
  ]) {
    await assert.rejects(
      service.listProjects({
        identity: builder,
        limit: 10,
        ...extra,
      }),
      expectCode("INVALID_REQUEST"),
    );
  }
});

test("aggregate cursors are route-bound and cannot select a foreign partition", async () => {
  const firstStateCursor = {
    pk: "PROJECT#customer_support",
    sk: "PROJECT#next",
  };
  const service = serviceWith({
    state: {
      async listProjects(input) {
        if (!input.cursor) {
          return page([project()], firstStateCursor);
        }
        return page([
          project({ id: "next-project" }),
        ]);
      },
    },
  });

  const first = await service.listProjects({
    identity: lead,
    limit: 1,
  });
  assert.equal(typeof first.cursor, "string");

  const second = await service.listProjects({
    identity: lead,
    limit: 10,
    cursor: first.cursor,
  });
  assert.deepEqual(
    second.items.map(({ id }) => id),
    ["next-project"],
  );

  await assert.rejects(
    service.listApprovals({
      identity: lead,
      limit: 10,
      cursor: first.cursor,
    }),
    expectCode("NOT_FOUND"),
  );

  const forged = Buffer.from(JSON.stringify({
    v: 1,
    r: "projects",
    i: 0,
    c: {
      pk: "PROJECT#operations",
      sk: "PROJECT#secret",
    },
  })).toString("base64url");
  await assert.rejects(
    service.listProjects({
      identity: lead,
      limit: 10,
      cursor: forged,
    }),
    expectCode("NOT_FOUND"),
  );

  const samePartitionForeignSortKey = Buffer.from(JSON.stringify({
    v: 1,
    r: "projects",
    i: 0,
    c: {
      pk: "PROJECT#customer_support",
      sk: "AGENT#secret",
    },
  })).toString("base64url");
  await assert.rejects(
    service.listProjects({
      identity: lead,
      limit: 10,
      cursor: samePartitionForeignSortKey,
    }),
    expectCode("NOT_FOUND"),
  );
});

test("malformed state and raw trace fields fail closed", async () => {
  const malformedPages = [
    null,
    { items: "not-an-array", cursor: null },
    page([{ ...project(), rawTrace: { prompt: "secret" } }]),
    page([project({
      memberSubjects: ["builder-sub", "builder-sub"],
    })]),
    page([project({
      memberSubjects: Array.from(
        { length: 101 },
        (_, index) => `builder-${index}`,
      ),
    })]),
    page([project()], { pk: "PROJECT#foreign", sk: "PROJECT#next" }),
  ];

  for (const malformed of malformedPages) {
    const service = serviceWith({
      state: {
        async listProjects() {
          return malformed;
        },
      },
    });
    await assert.rejects(
      service.listProjects({
        identity: lead,
        limit: 10,
      }),
      expectCode("WORKSPACE_UNAVAILABLE"),
    );
  }
});

test("bounded pagination and abort signals are passed to state reads", async () => {
  const controller = new AbortController();
  const calls = [];
  const service = serviceWith({
    state: {
      async listProjects(input) {
        calls.push(input);
        return page([]);
      },
    },
  });

  await assert.rejects(
    service.listProjects({ identity: lead, limit: 0 }),
    expectCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    service.listProjects({ identity: lead, limit: 51 }),
    expectCode("INVALID_REQUEST"),
  );
  await service.listProjects({
    identity: lead,
    limit: 50,
    abortSignal: controller.signal,
  });

  assert.equal(calls[0].limit, 50);
  assert.equal(calls[0].abortSignal, controller.signal);
});

test("abort signals are passed into central authorization and cancel a hung authorizer", async () => {
  const controller = new AbortController();
  let authorizationRequest;
  let stateCalls = 0;
  const service = serviceWith({
    authorizer: async (request) => {
      authorizationRequest = request;
      return new Promise(() => {});
    },
    state: {
      async listProjects() {
        stateCalls += 1;
        return page([]);
      },
    },
  });

  const pending = service.listProjects({
    identity: lead,
    limit: 10,
    abortSignal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error?.name === "AbortError",
  );
  assert.equal(
    authorizationRequest.requestContext.abortSignal,
    controller.signal,
  );
  assert.equal(stateCalls, 0);
});

test("workspace collection and item refs integrate with the revised central authorizer interface", async () => {
  const calls = [];
  const centralAuthorizer = createAuthorizer({
    async resolvePrincipal({ requestContext, resourceRef }) {
      calls.push(["principal", requestContext]);
      const descriptor = resourceRef.startsWith("workspace-item:")
        ? JSON.parse(
            Buffer.from(
              resourceRef.split(":").at(-1),
              "base64url",
            ).toString("utf8"),
          )
        : null;
      return {
        id: requestContext.subject,
        role: requestContext.role,
        domainIds: requestContext.domainIds,
        projectIds: descriptor === null
          ? ["workspace-collection"]
          : [descriptor.projectId],
      };
    },
    async resolveResource({ requestContext, resourceRef, action }) {
      calls.push(["resource", { requestContext, resourceRef, action }]);
      const encoded = resourceRef.split(":").at(-1);
      const descriptor = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      if (resourceRef.startsWith("workspace-item:")) {
        return descriptor;
      }
      return {
        id: resourceRef,
        domainId: requestContext.activeDomain,
        projectId: "workspace-collection",
        ownerId: requestContext.subject,
        assigneeIds: [requestContext.subject],
        lifecycleState: "ACTIVE",
      };
    },
    async resolvePolicy({ requestContext }) {
      calls.push(["policy", requestContext]);
      return { allowed: true };
    },
    clock: () => Date.parse("2026-08-25T00:00:00.000Z"),
  });
  const service = serviceWith({
    authorizer: centralAuthorizer,
    state: {
      async listProjects() {
        return page([project()]);
      },
    },
  });

  const result = await service.listProjects({
    identity: builder,
    limit: 10,
  });

  assert.deepEqual(result.items, [project()]);
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "principal",
      "resource",
      "policy",
      "principal",
      "resource",
      "policy",
    ],
  );
});

test("canonical domain identifiers reject empty underscore segments", async () => {
  const service = serviceWith();
  for (const domainId of [
    "customer__support",
    "customer_",
    "customer-support",
    "a".repeat(65),
  ]) {
    await assert.rejects(
      service.listProjects({
        identity: {
          ...lead,
          activeDomain: domainId,
          domainIds: [domainId],
        },
        limit: 10,
      }),
      expectCode("INVALID_REQUEST"),
    );
  }
});

test("authoritative identity scope is bounded before authorization or state", async () => {
  let authorizationCalls = 0;
  let stateCalls = 0;
  const service = serviceWith({
    authorizer: async () => {
      authorizationCalls += 1;
      return { ok: true };
    },
    state: {
      async listProjects() {
        stateCalls += 1;
        return page([]);
      },
    },
  });

  await assert.rejects(
    service.listProjects({
      identity: {
        ...admin,
        domainIds: Array.from(
          { length: 101 },
          (_, index) => `domain_${index}`,
        ),
      },
      limit: 10,
    }),
    expectCode("INVALID_REQUEST"),
  );
  assert.equal(authorizationCalls, 0);
  assert.equal(stateCalls, 0);
});

test("workspace identity accessors fail closed without executing caller code", async () => {
  let getterCalls = 0;
  let authorizationCalls = 0;
  let stateCalls = 0;
  const identityWithAccessor = {
    actor: "builder-sub",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  };
  Object.defineProperty(identityWithAccessor, "role", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "builder";
    },
  });
  const service = serviceWith({
    authorizer: async () => {
      authorizationCalls += 1;
      return { ok: true };
    },
    state: {
      async listProjects() {
        stateCalls += 1;
        return page([]);
      },
    },
  });

  await assert.rejects(
    service.listProjects({
      identity: identityWithAccessor,
      limit: 10,
    }),
    expectCode("INVALID_REQUEST"),
  );
  assert.equal(getterCalls, 0);
  assert.equal(authorizationCalls, 0);
  assert.equal(stateCalls, 0);
});


test("approval list preserves strict publication owner/version binding",async()=>{
 const binding={ownerSubject:"synthetic-owner",recordVersion:"1.0.0-platform-descriptor.1",initiationReason:"Synthetic independent review requested."};
 const make=(patch={})=>serviceWith({state:{async listApprovals(input){return page([approval({domainId:input.domainId,kind:"RESOURCE_PUBLICATION",resourceType:"AGENT",resourceId:"SyntheticReg1/SyntheticRec",projectId:null,...binding,...patch})]);}}});
 const result=await make().listApprovals({identity:platformAdmin,limit:20});
 assert.equal(result.items[0].ownerSubject,binding.ownerSubject);
 assert.equal(result.items[0].recordVersion,binding.recordVersion);
 for(const patch of [{ownerSubject:""},{recordVersion:""},{initiationReason:null},{kind:"RESOURCE_ACCESS"}])await assert.rejects(make(patch).listApprovals({identity:platformAdmin,limit:20}));
});
