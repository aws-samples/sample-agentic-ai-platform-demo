import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BuilderServiceError,
  createBuilderService,
} from "../lambda/builder/service.mjs";

const NOW = "2026-08-25T04:00:00.000Z";
const identity = Object.freeze({
  actor: "builder-sub",
  role: "builder",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});
const adminIdentity = Object.freeze({
  actor: "admin-sub",
  role: "admin",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});

function buildConfig(overrides = {}) {
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
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Support workspace.",
    ownerSubject: "builder-sub",
    memberSubjects: ["builder-sub"],
    status: "ACTIVE",
    createdBySubject: "lead-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

function agent(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Routes incoming cases.",
    ownerSubject: "builder-sub",
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    toolIds: ["case-search"],
    mcpServerIds: ["support-mcp"],
    skillIds: ["case-triage"],
    blueprintIds: ["support-blueprint"],
    memoryIds: ["support-memory"],
    knowledgeBaseIds: ["support-kb"],
    buildConfig: buildConfig(),
    status: "DRAFT",
    createdBySubject: "builder-sub",
    createdAt: NOW,
    updatedAt: NOW,
    lastTestStatus: null,
    lastTestedAt: null,
    lastTestedBySubject: null,
    lastTestModelId: null,
    lastTestInputTokens: null,
    lastTestOutputTokens: null,
    lastTestRequestId: null,
    lastTestEvidenceHash: null,
    lastTestOutput: null,
    ...overrides,
  };
}

function createPayload(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Routes incoming cases.",
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    toolIds: ["case-search"],
    mcpServerIds: ["support-mcp"],
    skillIds: ["case-triage"],
    blueprintIds: ["support-blueprint"],
    memoryIds: ["support-memory"],
    knowledgeBaseIds: ["support-kb"],
    buildConfig: buildConfig(),
    ...overrides,
  };
}

function activeGrant(resourceType, resourceId) {
  return {
    domainId: "customer_support",
    resourceType,
    resourceId,
    status: "ACTIVE",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T02:00:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function harness({
  authorize = async () => ({ ok: true }),
  gateway = async () => ({
    output: "Test response.",
    requestId: "gateway-request",
    usage: { inputTokens: 12, outputTokens: 7 },
  }),
  getAgent = async () => agent(),
  getMutationResult = async () => null,
  getProject = async () => project(),
  getResourceGrant = async ({ resourceType, resourceId }) =>
    activeGrant(resourceType, resourceId),
  resolveResourceAccess = async ({ payload }) => [
    ...payload.toolIds.map((resourceId) => ({
      resourceType: "TOOL",
      resourceId,
    })),
    ...payload.mcpServerIds.map((resourceId) => ({
      resourceType: "MCP_SERVER",
      resourceId,
    })),
    ...payload.skillIds.map((resourceId) => ({
      resourceType: "SKILL",
      resourceId,
    })),
    ...payload.blueprintIds
      .filter((resourceId) =>
        !new Set(["chat-assistant", "workflow-orchestrator"])
          .has(resourceId))
      .map((resourceId) => ({
        resourceType: "BLUEPRINT",
        resourceId,
      })),
    ...payload.memoryIds.map((resourceId) => ({
      resourceType: "MEMORY",
      resourceId,
    })),
    ...payload.knowledgeBaseIds.map((resourceId) => ({
      resourceType: "KNOWLEDGE_BASE",
      resourceId,
    })),
  ],
  resolveModelAccess = async () => true,
  resolveModelSelection,
  putAgent = async ({ record }) => record,
  claimMutation = async () => true,
  abortMutation = async ({ mutation }) => mutation,
  beginTransaction = () => Object.freeze({
    timestamp: NOW,
    epochSeconds: Math.floor(Date.parse(NOW) / 1000),
  }),
} = {}) {
  const calls = [];
  const service = createBuilderService({
    authorizer: async (input) => {
      calls.push(["authorize", structuredClone(input)]);
      return authorize(input);
    },
    clock: () => new Date(NOW),
    modelSelectionResolver: resolveModelSelection,
    modelAccessResolver: async (input) => {
      calls.push(["resolveModelAccess", structuredClone(input)]);
      return resolveModelAccess(input);
    },
    resourceAccessResolver: async (input) => {
      calls.push(["resolveResourceAccess", structuredClone(input)]);
      return resolveResourceAccess(input);
    },
    gateway: {
      async invoke(input) {
        calls.push(["gateway", structuredClone(input)]);
        return gateway(input);
      },
    },
    workspaceState: {
      beginTransaction() {
        const transaction = beginTransaction();
        calls.push(["beginTransaction", transaction]);
        return transaction;
      },
      async getProject(input) {
        calls.push(["getProject", structuredClone(input)]);
        return getProject(input);
      },
      async getAgent(input) {
        calls.push(["getAgent", structuredClone(input)]);
        return getAgent(input);
      },
      async getMutationResult(input) {
        calls.push(["getMutationResult", structuredClone(input)]);
        return getMutationResult(input);
      },
      async getResourceGrant(input) {
        calls.push(["getResourceGrant", structuredClone(input)]);
        return getResourceGrant(input);
      },
      async putAgent(input) {
        calls.push(["putAgent", structuredClone(input), input.transaction]);
        return putAgent(input);
      },
      async claimMutation(input) {
        calls.push(["claimMutation", structuredClone(input)]);
        return claimMutation(input);
      },
      async abortMutation(input) {
        calls.push([
          "abortMutation",
          structuredClone(input),
          input.transaction,
        ]);
        return abortMutation(input);
      },
    },
  });
  return { calls, service };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof BuilderServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

test("builder service requires complete trusted dependencies", () => {
  assert.throws(
    () => createBuilderService(),
    /Builder service configuration is invalid/,
  );
});

test("End User is denied before state, authorization, or Gateway access", async () => {
  const { calls, service } = harness();
  await assert.rejects(
    service.createAgent({
      identity: {
        actor: "user-sub",
        role: "user",
        activeDomain: null,
        domainIds: [],
      },
      requestId: "create-1",
      payload: createPayload(),
    }),
    expectCode("FORBIDDEN"),
  );
  assert.deepEqual(calls, []);
});

test("createAgent authorizes and resolves model access before other grants", async () => {
  const { calls, service } = harness();
  const result = await service.createAgent({
    identity,
    requestId: "create-1",
    payload: createPayload(),
  });

  assert.deepEqual(result, agent());
  assert.deepEqual(
    calls.filter(([name]) => name === "getResourceGrant")
      .map(([, input]) => [input.resourceType, input.resourceId]),
    [
      ["TOOL", "case-search"],
      ["MCP_SERVER", "support-mcp"],
      ["SKILL", "case-triage"],
      ["BLUEPRINT", "support-blueprint"],
      ["MEMORY", "support-memory"],
      ["KNOWLEDGE_BASE", "support-kb"],
    ],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "resolveModelAccess")
      .map(([, input]) => input),
    [{
      domainId: "customer_support",
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    }],
  );
  const authorizations = calls
    .filter(([name]) => name === "authorize")
    .map(([, input]) => input);
  const authorization = authorizations[0];
  assert.equal(authorization.action, "agent:create");
  assert.match(authorization.resourceRef, /^project:/);
  assert.deepEqual(
    Object.keys(authorization).sort(),
    ["action", "requestContext", "resourceRef"],
  );
  assert.equal(authorizations[1].action, "model:use");
  assert.equal(
    authorizations[1].resourceRef,
    "project:customer_support/case-assist",
  );
  const write = calls.find(([name]) => name === "putAgent")[1];
  assert.equal(write.expectedStatus, null);
  assert.equal(write.record.status, "DRAFT");
  assert.equal(write.mutation.effectiveRole, "builder");
  assert.equal(write.mutation.requesterSubject, "builder-sub");
  assert.equal(write.mutation.domainId, "customer_support");
  assert.equal(write.mutation.projectId, "case-assist");
  assert.equal(write.mutation.route, "POST /api/agents");
  assert.equal(write.mutation.requestId, "create-1");
  assert.match(write.mutation.payloadFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(write.mutation.result.operation, "CREATE");
  assert.equal(write.mutation.result.status, "SUCCEEDED");
  assert.equal(write.mutation.decision, "create");
  assert.equal(
    calls.find(([name]) => name === "putAgent")[2],
    calls.find(([name]) => name === "beginTransaction")[1],
  );
});

test("platform-owned runnable blueprints do not require duplicate domain grants", async () => {
  const { calls, service } = harness({
    getResourceGrant: async ({ resourceType, resourceId }) => {
      assert.notEqual(resourceType, "BLUEPRINT");
      return activeGrant(resourceType, resourceId);
    },
  });

  await service.createAgent({
    identity,
    requestId: "create-platform-blueprint",
    payload: createPayload({
      blueprintIds: ["chat-assistant"],
    }),
  });

  assert.equal(
    calls.some(([, input]) =>
      input?.resourceType === "BLUEPRINT"),
    false,
  );
  assert.equal(calls.some(([name]) => name === "putAgent"), true);
});

test("createAgent persists the validated builder configuration", async () => {
  const { calls, service } = harness();
  const config = buildConfig({
    instructions: "Route incoming support cases.\nPreserve escalation context.",
  });

  await service.createAgent({
    identity,
    requestId: "create-with-build-config",
    payload: createPayload({ buildConfig: config }),
  });

  assert.deepEqual(
    calls.find(([name]) => name === "putAgent")[1].record.buildConfig,
    config,
  );
});

test("createAgent and configureAgent require an exact valid builder configuration", async () => {
  const invalidConfigs = [
    undefined,
    buildConfig({ instructions: "" }),
    buildConfig({ instructions: "x".repeat(16_385) }),
    buildConfig({
      modelParameters: { temperature: -0.1, maxTokens: 1024 },
    }),
    buildConfig({
      modelParameters: { temperature: 0.2, maxTokens: 4097 },
    }),
    buildConfig({
      buildOptions: {
        ...buildConfig().buildOptions,
        memory: "forever",
      },
    }),
    buildConfig({
      buildOptions: {
        ...buildConfig().buildOptions,
        streaming: "yes",
      },
    }),
  ];

  for (const [index, config] of invalidConfigs.entries()) {
    for (const method of ["createAgent", "configureAgent"]) {
      const { calls, service } = harness();
      const payload = createPayload(
        config === undefined ? {} : { buildConfig: config },
      );
      if (config === undefined) delete payload.buildConfig;
      const input = {
        identity,
        requestId: `invalid-build-config-${method}-${index}`,
        payload,
      };
      if (method === "configureAgent") {
        input.agentRef = {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        };
      }
      await assert.rejects(
        service[method](input),
        expectCode("INVALID_REQUEST"),
      );
      assert.deepEqual(calls, []);
    }
  }
});

test("createAgent fails closed when any selected resource is not actively granted", async () => {
  const { calls, service } = harness({
    getResourceGrant: async ({ resourceType, resourceId }) =>
      resourceType === "SKILL"
        ? null
        : activeGrant(resourceType, resourceId),
  });
  await assert.rejects(
    service.createAgent({
      identity,
      requestId: "create-2",
      payload: createPayload(),
    }),
    expectCode("RESOURCE_NOT_GRANTED"),
  );
  assert.equal(calls.some(([name]) => name === "putAgent"), false);
});

test("malformed transaction clocks fail closed without persisting", async () => {
  const { calls, service } = harness({
    beginTransaction: () => Object.freeze({
      timestamp: "not-a-timestamp",
      epochSeconds: 0,
    }),
  });

  await assert.rejects(
    service.createAgent({
      identity,
      requestId: "create-invalid-clock",
      payload: createPayload(),
    }),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
  assert.equal(calls.some(([name]) => name === "putAgent"), false);
});

test("configureAgent updates a draft to ready-for-test after revalidating grants", async () => {
  const { calls, service } = harness();
  const configuredBuildConfig = buildConfig({
    instructions: "Use the approved queues and preserve escalation context.",
    modelParameters: {
      temperature: null,
      maxTokens: null,
    },
    buildOptions: {
      ...buildConfig().buildOptions,
      memory: "longAndShortTerm",
    },
  });
  const result = await service.configureAgent({
    identity,
    requestId: "configure-1",
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    payload: createPayload({
      description: "Configured support routing.",
      buildConfig: configuredBuildConfig,
    }),
  });

  assert.equal(result.status, "READY_FOR_TEST");
  assert.equal(result.description, "Configured support routing.");
  assert.deepEqual(result.buildConfig, configuredBuildConfig);
  assert.deepEqual(
    calls.filter(([name]) => name === "authorize")
      .map(([, input]) => input.action),
    ["agent:update", "model:use"],
  );
  assert.deepEqual(
    calls.find(([name]) => name === "resolveModelAccess")[1],
    {
      domainId: "customer_support",
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    },
  );
  const write = calls.find(([name]) => name === "putAgent")[1];
  assert.equal(write.expectedStatus, "DRAFT");
  assert.deepEqual(write.record.buildConfig, configuredBuildConfig);
  assert.equal(write.mutation.route, "PUT /api/agents/{id}");
  assert.equal(write.mutation.result.operation, "UPDATE");
  assert.equal(write.mutation.decision, "update");
  assert.equal(
    calls.find(([name]) => name === "putAgent")[2],
    calls.find(([name]) => name === "beginTransaction")[1],
  );
});

test("testAgent returns model output and records bounded success evidence", async () => {
  const ready = agent({
    status: "READY_FOR_TEST",
    buildConfig: null,
  });
  const { calls, service } = harness({
    getAgent: async () => ready,
  });
  const result = await service.testAgent({
    identity,
    requestId: "test-1",
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    prompt: "Classify this support request.",
    maxTokens: 128,
  });

  assert.equal(result.agent.status, "TESTED");
  assert.equal(result.agent.lastTestStatus, "SUCCEEDED");
  assert.equal(result.agent.lastTestInputTokens, 12);
  assert.equal(result.agent.lastTestOutputTokens, 7);
  assert.equal(result.agent.lastTestRequestId, "gateway-request");
  assert.equal(result.agent.lastTestOutput, "Test response.");
  assert.match(result.agent.lastTestEvidenceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.test, {
    output: "Test response.",
    requestId: "gateway-request",
    usage: {
      inputTokens: 12,
      outputTokens: 7,
    },
  });
  assert.deepEqual(calls.find(([name]) => name === "gateway")[1], {
    modelId: ready.modelId,
    prompt: "Classify this support request.",
    maxTokens: 128,
    sourceIdentity: "domain_customer_support",
  });
  assert.deepEqual(
    calls.filter(([name]) => name === "authorize")
      .map(([, input]) => input.action),
    ["agent:test", "model:use"],
  );
  assert.deepEqual(
    calls.find(([name]) => name === "resolveModelAccess")[1],
    {
      domainId: "customer_support",
      modelId: ready.modelId,
    },
  );
  assert.equal(
    calls.findIndex(([name]) => name === "claimMutation")
      < calls.findIndex(([name]) => name === "gateway"),
    true,
  );
  const write = calls.find(([name]) => name === "putAgent")[1];
  assert.equal(write.expectedStatus, "READY_FOR_TEST");
  assert.equal(write.mutation.route, "POST /api/agents/{id}/test");
  assert.equal(write.mutation.decision, "update");
  assert.equal(
    calls.find(([name]) => name === "putAgent")[2],
    calls.find(([name]) => name === "beginTransaction")[1],
  );
});

test("retesting an undeployed agent uses its saved instructions and model temperature", async () => {
  const configured=agent({status:"TESTED",buildConfig:buildConfig({instructions:"Help the customer with order questions.",modelParameters:{temperature:0.3,maxTokens:128}})});
  const {calls,service}=harness({getAgent:async()=>configured});
  await service.testAgent({identity,requestId:"test-again",agentRef:{domainId:configured.domainId,projectId:configured.projectId,agentId:configured.id},prompt:"How can you help?",maxTokens:128});
  const request=calls.find(([name])=>name==="gateway")[1];
  assert.equal(request.systemPrompt,"Help the customer with order questions.");
  assert.equal(request.temperature,0.3);
});

test("model access is rechecked on create, configure, and test", async () => {
  const scenarios = [
    {
      method: "createAgent",
      input: {
        identity,
        requestId: "model-denied-create",
        payload: createPayload(),
      },
    },
    {
      method: "configureAgent",
      input: {
        identity,
        requestId: "model-denied-configure",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        payload: createPayload(),
      },
    },
    {
      method: "testAgent",
      input: {
        identity,
        requestId: "model-denied-test",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        prompt: "Classify this support request.",
        maxTokens: 128,
      },
      options: {
        getAgent: async () => agent({ status: "READY_FOR_TEST" }),
      },
    },
  ];

  for (const scenario of scenarios) {
    const { calls, service } = harness({
      ...scenario.options,
      resolveModelAccess: async () => false,
    });
    await assert.rejects(
      service[scenario.method](scenario.input),
      expectCode("RESOURCE_NOT_GRANTED"),
    );
    assert.equal(
      calls.filter(([name]) => name === "resolveModelAccess").length,
      1,
    );
    assert.equal(calls.some(([name]) => name === "putAgent"), false);
    assert.equal(calls.some(([name]) => name === "gateway"), false);
  }
});

test("Admin model use always calls central authorization", async () => {
  const scenarios = [
    {
      method: "createAgent",
      action: "agent:create",
      input: {
        identity: adminIdentity,
        requestId: "admin-model-create",
        payload: createPayload({
          toolIds: [],
          mcpServerIds: [],
          skillIds: [],
          blueprintIds: [],
          memoryIds: [],
          knowledgeBaseIds: [],
        }),
      },
    },
    {
      method: "configureAgent",
      action: "agent:update",
      input: {
        identity: adminIdentity,
        requestId: "admin-model-configure",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        payload: createPayload({
          toolIds: [],
          mcpServerIds: [],
          skillIds: [],
          blueprintIds: [],
          memoryIds: [],
          knowledgeBaseIds: [],
        }),
      },
    },
    {
      method: "testAgent",
      action: "agent:test",
      input: {
        identity: adminIdentity,
        requestId: "admin-model-test",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        prompt: "Classify this support request.",
        maxTokens: 128,
      },
      options: {
        getAgent: async () => agent({ status: "READY_FOR_TEST" }),
      },
    },
    {
      method: "createAgent",
      action: "agent:create",
      input: {
        identity: {
          actor: "admin-sub",
          role: "admin",
          activeDomain: null,
          domainIds: [],
        },
        requestId: "admin-platform-model-create",
        payload: createPayload({
          domainId: "platform",
          toolIds: [],
          mcpServerIds: [],
          skillIds: [],
          blueprintIds: [],
          memoryIds: [],
          knowledgeBaseIds: [],
        }),
      },
      options: {
        getProject: async () => project({ domainId: "platform" }),
      },
    },
  ];

  for (const scenario of scenarios) {
    const { calls, service } = harness(scenario.options);
    await service[scenario.method](scenario.input);
    assert.deepEqual(
      calls.filter(([name]) => name === "authorize")
        .map(([, input]) => input.action),
      [scenario.action, "model:use"],
    );
  }
});

test("unavailable model access dependencies fail before writes or Gateway use", async () => {
  const { calls, service } = harness({
    resolveModelAccess: async () => {
      throw new Error("backend unavailable");
    },
  });

  await assert.rejects(
    service.createAgent({
      identity,
      requestId: "model-unavailable",
      payload: createPayload(),
    }),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
  assert.equal(calls.some(([name]) => name === "putAgent"), false);
  assert.equal(calls.some(([name]) => name === "gateway"), false);
});

test("foreign domains are denied before model policy or grant reads", async () => {
  const { calls, service } = harness();

  await assert.rejects(
    service.createAgent({
      identity,
      requestId: "foreign-model-domain",
      payload: createPayload({ domainId: "finance" }),
    }),
    expectCode("NOT_FOUND"),
  );
  assert.deepEqual(calls, []);
});

test("completed model tests replay stored evidence without invoking Gateway", async () => {
  const tested = agent({
    status: "TESTED",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: NOW,
    lastTestedBySubject: "builder-sub",
    lastTestModelId: "bedrock-claude/anthropic.claude-sonnet-5",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Stored response.",
  });
  const { calls, service } = harness({
    getAgent: async () => tested,
    getMutationResult: async () => ({
      actor: "builder-sub",
      requesterSubject: "builder-sub",
      effectiveRole: "builder",
      domainId: "customer_support",
      projectId: "case-assist",
      route: "POST /api/agents/{id}/test",
      requestId: "test-replay",
      payloadFingerprint:
        "a6f6fdde4b9451113525054fa3d17e1bf860f29431eaafeb67495294b7621eb8",
      result: {
        entityType: "AGENT",
        resourceKey: "agent/customer_support/case-assist/triage-agent",
        operation: "UPDATE",
        status: "SUCCEEDED",
      },
      decision: "update",
      reason: "Gateway test succeeded.",
      timestamp: NOW,
      createdAt: NOW,
    }),
  });

  const result = await service.testAgent({
    identity,
    requestId: "test-replay",
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    prompt: "Classify this support request.",
    maxTokens: 128,
  });

  assert.equal(result.agent.status, "TESTED");
  assert.equal(result.test.output, "Stored response.");
  assert.equal(calls.some(([name]) => name === "gateway"), false);
  assert.equal(calls.some(([name]) => name === "claimMutation"), false);
  assert.equal(calls.some(([name]) => name === "putAgent"), false);
});

test("completed model tests replay after later deployment lifecycle transitions", async () => {
  const deployed = agent({
    status: "SANDBOX_DEPLOYED",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: NOW,
    lastTestedBySubject: "builder-sub",
    lastTestModelId: "bedrock-claude/anthropic.claude-sonnet-5",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Stored response.",
  });
  const { calls, service } = harness({
    getAgent: async () => deployed,
    getMutationResult: async () => ({
      actor: "builder-sub",
      requesterSubject: "builder-sub",
      effectiveRole: "builder",
      domainId: "customer_support",
      projectId: "case-assist",
      route: "POST /api/agents/{id}/test",
      requestId: "test-replay",
      payloadFingerprint:
        "a6f6fdde4b9451113525054fa3d17e1bf860f29431eaafeb67495294b7621eb8",
      result: {
        entityType: "AGENT",
        resourceKey: "agent/customer_support/case-assist/triage-agent",
        operation: "UPDATE",
        status: "SUCCEEDED",
      },
      decision: "update",
      reason: "Gateway test succeeded.",
      timestamp: NOW,
      createdAt: NOW,
    }),
  });

  const result = await service.testAgent({
    identity,
    requestId: "test-replay",
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    prompt: "Classify this support request.",
    maxTokens: 128,
  });

  assert.equal(result.agent.status, "SANDBOX_DEPLOYED");
  assert.equal(result.test.output, "Stored response.");
  assert.equal(calls.some(([name]) => name === "gateway"), false);
  assert.equal(calls.some(([name]) => name === "claimMutation"), false);
  assert.equal(calls.some(([name]) => name === "putAgent"), false);
});

test("create, configure, and successful test replays recheck revoked model access", async () => {
  const payload = createPayload();
  const testInput = {
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    prompt: "Classify this support request.",
    maxTokens: 128,
  };
  const tested = agent({
    status: "TESTED",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: NOW,
    lastTestedBySubject: "builder-sub",
    lastTestModelId: payload.modelId,
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Stored response.",
  });
  const scenarios = [
    {
      method: "createAgent",
      input: {
        identity,
        requestId: "revoked-create-replay",
        payload,
      },
      mutation: {
        route: "POST /api/agents",
        requestId: "revoked-create-replay",
        payloadFingerprint: fingerprint(payload),
        operation: "CREATE",
        decision: "create",
        reason: "Agent draft created.",
      },
    },
    {
      method: "configureAgent",
      input: {
        identity,
        requestId: "revoked-configure-replay",
        agentRef: testInput.agentRef,
        payload,
      },
      mutation: {
        route: "PUT /api/agents/{id}",
        requestId: "revoked-configure-replay",
        payloadFingerprint: fingerprint(payload),
        operation: "UPDATE",
        decision: "update",
        reason: "Agent configuration completed.",
      },
    },
    {
      method: "testAgent",
      input: {
        identity,
        requestId: "revoked-test-replay",
        ...testInput,
      },
      options: {
        getAgent: async () => tested,
      },
      mutation: {
        route: "POST /api/agents/{id}/test",
        requestId: "revoked-test-replay",
        payloadFingerprint: fingerprint(testInput),
        operation: "UPDATE",
        decision: "update",
        reason: "Gateway test succeeded.",
      },
    },
  ];

  for (const scenario of scenarios) {
    const { calls, service } = harness({
      ...scenario.options,
      resolveModelAccess: async () => false,
      getMutationResult: async () => ({
        actor: "builder-sub",
        requesterSubject: "builder-sub",
        effectiveRole: "builder",
        domainId: "customer_support",
        projectId: "case-assist",
        route: scenario.mutation.route,
        requestId: scenario.mutation.requestId,
        payloadFingerprint: scenario.mutation.payloadFingerprint,
        result: {
          entityType: "AGENT",
          resourceKey:
            "agent/customer_support/case-assist/triage-agent",
          operation: scenario.mutation.operation,
          status: "SUCCEEDED",
        },
        decision: scenario.mutation.decision,
        reason: scenario.mutation.reason,
        timestamp: NOW,
        createdAt: NOW,
      }),
    });

    await assert.rejects(
      service[scenario.method](scenario.input),
      expectCode("RESOURCE_NOT_GRANTED"),
    );
    assert.equal(
      calls.filter(([name]) => name === "resolveModelAccess").length,
      1,
    );
    assert.equal(calls.some(([name]) => name === "putAgent"), false);
    assert.equal(calls.some(([name]) => name === "gateway"), false);
  }
});

test("replays recheck the original project or agent permission", async () => {
  const payload = createPayload();
  const testInput = {
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    prompt: "Classify this support request.",
    maxTokens: 128,
  };
  const tested = agent({
    status: "TESTED",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: NOW,
    lastTestedBySubject: "builder-sub",
    lastTestModelId: payload.modelId,
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Stored response.",
  });
  const scenarios = [
    {
      method: "createAgent",
      action: "agent:create",
      input: {
        identity,
        requestId: "revoked-create-project-replay",
        payload,
      },
      mutation: {
        route: "POST /api/agents",
        requestId: "revoked-create-project-replay",
        payloadFingerprint: fingerprint(payload),
        operation: "CREATE",
        decision: "create",
        reason: "Agent draft created.",
      },
    },
    {
      method: "configureAgent",
      action: "agent:update",
      input: {
        identity,
        requestId: "revoked-update-project-replay",
        agentRef: testInput.agentRef,
        payload,
      },
      mutation: {
        route: "PUT /api/agents/{id}",
        requestId: "revoked-update-project-replay",
        payloadFingerprint: fingerprint(payload),
        operation: "UPDATE",
        decision: "update",
        reason: "Agent configuration completed.",
      },
    },
    {
      method: "testAgent",
      action: "agent:test",
      input: {
        identity,
        requestId: "revoked-test-project-replay",
        ...testInput,
      },
      options: {
        getAgent: async () => tested,
      },
      mutation: {
        route: "POST /api/agents/{id}/test",
        requestId: "revoked-test-project-replay",
        payloadFingerprint: fingerprint(testInput),
        operation: "UPDATE",
        decision: "update",
        reason: "Gateway test succeeded.",
      },
    },
  ];

  for (const scenario of scenarios) {
    const { calls, service } = harness({
      ...scenario.options,
      authorize: async (input) => {
        if (input.action === scenario.action) {
          const error = new Error("project membership revoked");
          error.decision = "FORBIDDEN";
          throw error;
        }
        return { ok: true };
      },
      getMutationResult: async () => ({
        actor: "builder-sub",
        requesterSubject: "builder-sub",
        effectiveRole: "builder",
        domainId: "customer_support",
        projectId: "case-assist",
        route: scenario.mutation.route,
        requestId: scenario.mutation.requestId,
        payloadFingerprint: scenario.mutation.payloadFingerprint,
        result: {
          entityType: "AGENT",
          resourceKey:
            "agent/customer_support/case-assist/triage-agent",
          operation: scenario.mutation.operation,
          status: "SUCCEEDED",
        },
        decision: scenario.mutation.decision,
        reason: scenario.mutation.reason,
        timestamp: NOW,
        createdAt: NOW,
      }),
    });

    await assert.rejects(
      service[scenario.method](scenario.input),
      expectCode("FORBIDDEN"),
      scenario.method,
    );
    assert.equal(
      calls.some(([name]) => name === "gateway"),
      false,
      scenario.method,
    );
  }
});

test("failed and rejected test replays recheck revoked model access first", async () => {
  const testInput = {
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    prompt: "Classify this support request.",
    maxTokens: 128,
  };

  for (const [requestId, reason] of [
    [
      "revoked-failed-test-replay",
      "Gateway test failed with a retryable error.",
    ],
    [
      "revoked-rejected-test-replay",
      "Gateway test was rejected.",
    ],
  ]) {
    const { calls, service } = harness({
      getAgent: async () => agent({ status: "TEST_FAILED" }),
      resolveModelAccess: async () => false,
      getMutationResult: async () => ({
        actor: "builder-sub",
        requesterSubject: "builder-sub",
        effectiveRole: "builder",
        domainId: "customer_support",
        projectId: "case-assist",
        route: "POST /api/agents/{id}/test",
        requestId,
        payloadFingerprint: fingerprint(testInput),
        result: {
          entityType: "AGENT",
          resourceKey:
            "agent/customer_support/case-assist/triage-agent",
          operation: "UPDATE",
          status: "FAILED",
        },
        decision: "abort",
        reason,
        timestamp: NOW,
        createdAt: NOW,
      }),
    });

    await assert.rejects(
      service.testAgent({
        identity,
        requestId,
        ...testInput,
      }),
      expectCode("RESOURCE_NOT_GRANTED"),
    );
    assert.equal(
      calls.filter(([name]) => name === "resolveModelAccess").length,
      1,
    );
    assert.equal(calls.some(([name]) => name === "gateway"), false);
  }
});

test("failed and rejected test replays preserve stored errors after access succeeds", async () => {
  const testInput = {
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    prompt: "Classify this support request.",
    maxTokens: 128,
  };

  for (const [requestId, reason, code] of [
    [
      "allowed-failed-test-replay",
      "Gateway test failed with a retryable error.",
      "GATEWAY_UNAVAILABLE",
    ],
    [
      "allowed-rejected-test-replay",
      "Gateway test was rejected.",
      "GATEWAY_REJECTED",
    ],
  ]) {
    const { calls, service } = harness({
      getAgent: async () => agent({ status: "TEST_FAILED" }),
      getMutationResult: async () => ({
        actor: "builder-sub",
        requesterSubject: "builder-sub",
        effectiveRole: "builder",
        domainId: "customer_support",
        projectId: "case-assist",
        route: "POST /api/agents/{id}/test",
        requestId,
        payloadFingerprint: fingerprint(testInput),
        result: {
          entityType: "AGENT",
          resourceKey:
            "agent/customer_support/case-assist/triage-agent",
          operation: "UPDATE",
          status: "FAILED",
        },
        decision: "abort",
        reason,
        timestamp: NOW,
        createdAt: NOW,
      }),
    });

    await assert.rejects(
      service.testAgent({
        identity,
        requestId,
        ...testInput,
      }),
      expectCode(code),
    );
    assert.equal(
      calls.filter(([name]) => name === "resolveModelAccess").length,
      1,
    );
    assert.equal(calls.some(([name]) => name === "gateway"), false);
  }
});

test("an in-flight duplicate model test never invokes Gateway", async () => {
  const { calls, service } = harness({
    getAgent: async () => agent({ status: "READY_FOR_TEST" }),
    claimMutation: async () => {
      throw Object.assign(new Error("already running"), {
        code: "MUTATION_IN_PROGRESS",
      });
    },
  });

  await assert.rejects(
    service.testAgent({
      identity,
      requestId: "test-in-flight",
      agentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
      prompt: "Classify this support request.",
      maxTokens: 128,
    }),
    (error) => (
      expectCode("REQUEST_IN_PROGRESS")(error)
      && error.retryable === false
      && /new request/i.test(error.message)
    ),
  );
  assert.equal(calls.some(([name]) => name === "gateway"), false);
  assert.equal(calls.some(([name]) => name === "putAgent"), false);
});

test("failed Gateway tests persist failed agent evidence without entering TESTED", async () => {
  const ready = agent({ status: "READY_FOR_TEST" });
  const { calls, service } = harness({
    getAgent: async () => ready,
    gateway: async () => {
      throw Object.assign(new Error("sensitive upstream text"), {
        code: "GATEWAY_UNAVAILABLE",
      });
    },
  });
  await assert.rejects(
    service.testAgent({
      identity,
      requestId: "test-2",
      agentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
      prompt: "Classify this support request.",
      maxTokens: 128,
    }),
    expectCode("GATEWAY_UNAVAILABLE"),
  );
  assert.equal(calls.some(([name]) => name === "abortMutation"), false);
  const failed = calls.find(([name]) => name === "putAgent")[1];
  assert.equal(failed.record.status, "TEST_FAILED");
  assert.equal(failed.record.lastTestStatus, "FAILED");
  assert.equal(failed.record.lastTestedBySubject, "builder-sub");
  assert.equal(failed.record.lastTestModelId, ready.modelId);
  assert.equal(failed.record.lastTestRequestId, "test-2");
  assert.equal(failed.record.lastTestOutput, null);
  assert.equal(failed.mutation.requesterSubject, "builder-sub");
  assert.equal(failed.mutation.decision, "abort");
  assert.equal(failed.mutation.result.operation, "UPDATE");
  assert.equal(failed.mutation.result.status, "FAILED");
  assert.equal(
    failed.mutation.reason,
    "Gateway test failed with a retryable error.",
  );
  assert.equal(
    calls.find(([name]) => name === "putAgent")[2],
    calls.find(([name]) => name === "beginTransaction")[1],
  );
  assert.doesNotMatch(
    JSON.stringify(failed),
    /sensitive upstream text/,
  );
});

test("non-retryable Gateway rejection is preserved for the caller and audit", async () => {
  const { calls, service } = harness({
    getAgent: async () => agent({ status: "READY_FOR_TEST" }),
    gateway: async () => {
      throw Object.assign(new Error("provider details"), {
        code: "GATEWAY_INVOCATION_REJECTED",
        retryable: false,
      });
    },
  });

  await assert.rejects(
    service.testAgent({
      identity,
      requestId: "test-rejected",
      agentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
      prompt: "Classify this support request.",
      maxTokens: 128,
    }),
    expectCode("GATEWAY_REJECTED"),
  );
  const failed = calls.find(([name]) => name === "putAgent")[1];
  assert.equal(failed.mutation.reason, "Gateway test was rejected.");
});

test("archived projects cannot configure or test agents", async () => {
  for (const [method, input] of [
    [
      "configureAgent",
      {
        identity,
        requestId: "archived-configure",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        payload: createPayload(),
      },
    ],
    [
      "testAgent",
      {
        identity,
        requestId: "archived-test",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        prompt: "Classify this support request.",
        maxTokens: 128,
      },
    ],
  ]) {
    const { calls, service } = harness({
      getProject: async () => project({ status: "ARCHIVED" }),
      getAgent: async () => agent({ status: "READY_FOR_TEST" }),
    });
    await assert.rejects(
      service[method](input),
      expectCode("CONFLICT"),
    );
    assert.equal(calls.some(([name]) => name === "gateway"), false);
    assert.equal(calls.some(([name]) => name === "putAgent"), false);
  }
});

test("foreign domains, unknown agents, invalid bodies, and stale states fail closed", async () => {
  const cases = [
    {
      method: "createAgent",
      input: {
        identity,
        requestId: "invalid-body",
        payload: { ...createPayload(), extra: true },
      },
      code: "INVALID_REQUEST",
    },
    {
      method: "configureAgent",
      input: {
        identity,
        requestId: "missing-agent",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        payload: createPayload(),
      },
      code: "NOT_FOUND",
      options: { getAgent: async () => null },
    },
    {
      method: "testAgent",
      input: {
        identity,
        requestId: "stale-agent",
        agentRef: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
        prompt: "test",
        maxTokens: 128,
      },
      code: "CONFLICT",
      options: { getAgent: async () => agent({ status: "DRAFT" }) },
    },
  ];
  for (const scenario of cases) {
    const { service } = harness(scenario.options);
    await assert.rejects(
      service[scenario.method](scenario.input),
      expectCode(scenario.code),
    );
  }
});


test("project subset allows development with an unconfigured model but blocks invocation and other project resources", async () => {
  const payload=createPayload({modelId:"gateway/model-a",toolIds:[],mcpServerIds:[],skillIds:[],blueprintIds:["chat-assistant"],memoryIds:[],knowledgeBaseIds:[]});
  const selectedProject=project({resourcePolicy:{resources:[{type:"Model",id:"gateway/model-a",registryId:null},{type:"Blueprint",id:"chat-assistant",registryId:"registry"}]}});
  const {service,calls}=harness({getProject:async()=>selectedProject,resolveModelSelection:async()=>true,resolveModelAccess:async()=>false,
    getAgent:async()=>agent({...payload,status:"READY_FOR_TEST"})});
  assert.equal((await service.createAgent({identity,requestId:"draft-pending",payload})).modelId,"gateway/model-a");
  await assert.rejects(service.createAgent({identity,requestId:"wrong-model",payload:{...payload,modelId:"gateway/model-b"}}),expectCode("RESOURCE_NOT_GRANTED"));
  await assert.rejects(service.createAgent({identity,requestId:"wrong-template",payload:{...payload,blueprintIds:["workflow-orchestrator"]}}),expectCode("RESOURCE_NOT_GRANTED"));
  await assert.rejects(service.testAgent({identity,requestId:"no-runtime",agentRef:{domainId:payload.domainId,projectId:payload.projectId,agentId:payload.id},prompt:"Hello",maxTokens:32}),expectCode("RESOURCE_NOT_GRANTED"));
  assert.equal(calls.filter(([name])=>name==="gateway").length,0);
});

test("empty and malformed runtime output cannot mark an agent tested", async () => {
 for (const result of [null, {output:"",usage:{inputTokens:1,outputTokens:0}}, {output:"hello",usage:{inputTokens:1,outputTokens:-1}}]) {
  const configured=agent({status:"READY_FOR_TEST"});
  const {calls,service}=harness({getAgent:async()=>configured,gateway:async()=>result});
  await assert.rejects(service.testAgent({identity,requestId:"invalid-output",agentRef:{domainId:configured.domainId,projectId:configured.projectId,agentId:configured.id},prompt:"Hello",maxTokens:128}),expectCode("GATEWAY_UNAVAILABLE"));
  assert.equal(calls.some(([name, input])=>name==="putAgent" && input.record?.status==="TESTED"),false);
 }
});
