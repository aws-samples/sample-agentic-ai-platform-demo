import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createConfiguredBedrockInference } from "../lambda/agent-runtime/bedrock-inference.mjs";
import {
  createBuilderRuntime,
} from "../lambda/builder/runtime.mjs";

const NOW = "2026-08-25T05:00:00.000Z";
const claims = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:username": "deployment-operator",
  "cognito:groups": ["platform-admin", "demo-operator"],
});
const MODEL_ID = "bedrock-claude/anthropic.claude-sonnet-5";

function buildConfig() {
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

function modelPolicy(overrides = {}) {
  return {
    modelId: MODEL_ID,
    allowedDomains: [],
    requestableDomains: ["customer_support"],
    limits: {
      requestsPerMinute: 60,
      tokensPerMinute: null,
      connectionsPerSecond: null,
    },
    revision: 1,
    applicationStatus: "ACTIVE",
    rateLimit: {
      id: "platform-model-domain-limits",
      status: "ACTIVE",
      reason: null,
      reconciledAt: "2026-08-25T04:45:00.000Z",
    },
    updatedBySubject: "operator-sub",
    updatedAt: "2026-08-25T04:45:00.000Z",
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Routes incoming cases.",
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: [],
    memoryIds: [],
    knowledgeBaseIds: [],
    buildConfig: buildConfig(),
    ...overrides,
  };
}

function event({
  routeKey = "POST /api/agents",
  path = "/api/agents",
  method = "POST",
  body = payload(),
  headers = {},
  pathParameters,
} = {}) {
  return {
    version: "2.0",
    routeKey,
    body: JSON.stringify(body),
    headers,
    pathParameters,
    requestContext: {
      requestId: "api-request",
      http: { method, path },
      authorizer: { jwt: { claims } },
    },
  };
}

function activeBreakGlass(overrides = {}) {
  return {
    id: "admin-builder-grant",
    domainId: "customer_support",
    projectId: "case-assist",
    resource: "project:customer_support/case-assist",
    action: "agent:create",
    status: "ACTIVE",
    requesterSubject: "operator-sub",
    reason: "Recover a customer support agent during an incident.",
    requestedAt: "2026-08-25T04:30:00.000Z",
    expiresAt: "2026-08-25T05:30:00.000Z",
    approverSubject: "peer-admin-sub",
    decisionReason: "Peer approved.",
    decidedAt: "2026-08-25T04:31:00.000Z",
    activatedBySubject: "operator-sub",
    activationReason: "Begin the approved recovery.",
    activatedAt: "2026-08-25T04:32:00.000Z",
    revokedBySubject: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  };
}

function runtimeHarness({
  breakGlassRecords = [],
  getModelPolicy = async () => modelPolicy(),
  getResourceGrant,
  inference,
} = {}) {
  const records = new Map();
  const modelPolicyCalls = [];
  const resourceGrantCalls = [];
  const project = {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Support workspace.",
    ownerSubject: "lead-sub",
    memberSubjects: ["operator-sub"],
    status: "ACTIVE",
    createdBySubject: "lead-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
  };
  const workspaceState = {
    beginTransaction() {
      return Object.freeze({
        timestamp: NOW,
        epochSeconds: Math.floor(Date.parse(NOW) / 1000),
      });
    },
    async getProject({ domainId, projectId }) {
      return domainId === project.domainId && projectId === project.id
        ? structuredClone(project)
        : null;
    },
    async getAgent({ domainId, projectId, agentId }) {
      const value = records.get(`${domainId}/${projectId}/${agentId}`);
      return value ? structuredClone(value) : null;
    },
    async getMutationResult() {
      return null;
    },
    async claimMutation() {
      return true;
    },
    async getResourceGrant({ domainId, resourceType, resourceId }) {
      const input = { domainId, resourceType, resourceId };
      resourceGrantCalls.push(structuredClone(input));
      if (getResourceGrant) return getResourceGrant(input);
      return {
        domainId,
        resourceType,
        resourceId,
        status: "ACTIVE",
        grantedBySubject: "lead-sub",
        grantedAt: "2026-08-25T02:00:00.000Z",
        revokedBySubject: null,
        revokedAt: null,
      };
    },
    async listBreakGlass({ requesterSubject }) {
      return {
        items: breakGlassRecords.filter(
          (record) => record.requesterSubject === requesterSubject,
        ),
        cursor: null,
      };
    },
    async putAgent({ record }) {
      records.set(
        `${record.domainId}/${record.projectId}/${record.id}`,
        structuredClone(record),
      );
      return structuredClone(record);
    },
    async abortMutation({ mutation }) {
      return structuredClone(mutation);
    },
  };
  const gatewayCalls = [];
  const handler = createBuilderRuntime({
    clock: () => new Date(NOW),
    domainDirectory: {
      async listActiveDomains() {
        return [
          { id: "platform" },
          { id: "customer_support" },
        ];
      },
    },
    gateway: inference ?? {
      async invoke(input) {
        gatewayCalls.push(structuredClone(input));
        return {
          output: "Test response.",
          requestId: "gateway-request",
          usage: {
            inputTokens: 8,
            outputTokens: 4,
            totalTokens: 12,
          },
        };
      },
    },
    identityVerifier: async () => true,
    resourceAccessResolver: async ({ payload }) => [
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
    modelPolicyState: {
      async getModelPolicy(input) {
        modelPolicyCalls.push(structuredClone(input));
        return getModelPolicy(input);
      },
    },
    workspaceState,
  });
  return {
    gatewayCalls,
    handler,
    modelPolicyCalls,
    records,
    resourceGrantCalls,
  };
}

function body(response) {
  return JSON.parse(response.body);
}

test("builder runtime requires complete production dependencies", () => {
  assert.throws(
    () => createBuilderRuntime(),
    /Builder runtime configuration is invalid/,
  );
});

test("production Builder uses Runtime model credentials and retains Gateway credentials for inventory", async () => {
  const source = await readFile(
    new URL("../lambda/builder/runtime.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /@aws-sdk\/client-sts/);
  assert.match(source, /createGatewayCredentialsProvider/);
  assert.match(source, /GATEWAY_INVOKER_ROLE_ARN/);
  assert.match(source, /credentialsProvider/);
  assert.match(
    source,
    /credentialsProvider:\s*dynamo\.config\.credentials/,
  );
  assert.match(source, /createConfiguredBedrockInference/);
  assert.doesNotMatch(source, /new AgentCoreGatewayClient/);
});

// Hosted Converse is opt-in, so an unconfigured deployment must still authorize
// and persist drafts; only the draft-test action may fail.
test("agent authoring survives unconfigured hosted inference and only draft test fails", async () => {
  // configuredHandler is module-private, so pin that it defers construction:
  // building Converse eagerly there 500s every Builder route when unconfigured.
  const source = await readFile(
    new URL("../lambda/builder/runtime.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /const\s+gateway\s*=\s*createConfiguredBedrockInference/,
  );
  assert.match(
    source,
    /inference\s*\?\?=\s*createConfiguredBedrockInference/,
  );
  let built = 0;
  const gateway = {
    invoke: (input) => {
      built += 1;
      return createConfiguredBedrockInference({
        env: {},
        credentialsProvider: async () => ({}),
      }).invoke(input);
    },
  };
  const modelId = "bedrock-claude/anthropic.claude-haiku-4-5";
  const h = runtimeHarness({
    inference: gateway,
    getModelPolicy: async () => modelPolicy({ modelId }),
  });
  const headers = {
    "x-demo-role": "builder",
    "x-active-domain": "customer_support",
    "x-request-id": "unconfigured-create",
  };
  const created = await h.handler(event({ headers, body: payload({ modelId }) }));
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await h.handler(event({
    headers: { ...headers, "x-request-id": "unconfigured-configure" },
    body: payload({ modelId }),
    routeKey: "PUT /api/agents/{id}",
    method: "PUT",
    path: "/api/agents/triage-agent",
    pathParameters: { id: "triage-agent" },
  }))).statusCode, 200);
  assert.equal(built, 0);
  const tested = await h.handler(event({
    routeKey: "POST /api/agents/{id}/test",
    path: "/api/agents/triage-agent/test",
    pathParameters: { id: "triage-agent" },
    headers: { ...headers, "x-request-id": "unconfigured-test" },
    body: {
      domainId: "customer_support",
      projectId: "case-assist",
      prompt: "Synthetic request.",
      maxTokens: 128,
    },
  }));
  assert.equal(tested.statusCode >= 400, true, tested.body);
  assert.equal(built, 1);
});

test("authorized Builder test uses bounded Converse while model/domain/project authorization remains effective", async () => {
  const modelId = "bedrock-claude/anthropic.claude-haiku-4-5";
  const calls = [];
  const inference = createConfiguredBedrockInference({
    env: { MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1", BEDROCK_RUNTIME_REGION: "us-west-2",
      BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{ modelId, domains: ["customer_support"] }]) },
    credentialsProvider: async () => ({ accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-only" }),
    fetchImpl: async (url, input) => {
      calls.push({ url, body: JSON.parse(input.body) });
      return new Response(JSON.stringify({
        output: { message: { role: "assistant", content: [{ text: "Synthetic answer." }] } },
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        stopReason: "end_turn", metrics: { latencyMs: 1 },
      }));
    },
  });
  const h = runtimeHarness({ inference, getModelPolicy: async () => modelPolicy({ modelId }) });
  const headers = { "x-demo-role": "builder", "x-active-domain": "customer_support", "x-request-id": "synthetic-create" };
  const created = await h.handler(event({ headers, body: payload({ modelId }) }));
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await h.handler(event({ headers: { ...headers, "x-request-id": "synthetic-configure" }, body: payload({ modelId }), routeKey: "PUT /api/agents/{id}",
    method: "PUT", path: "/api/agents/triage-agent", pathParameters: { id: "triage-agent" } }))).statusCode, 200);
  const request = { routeKey: "POST /api/agents/{id}/test", path: "/api/agents/triage-agent/test",
    pathParameters: { id: "triage-agent" }, headers: { ...headers, "x-request-id": "synthetic-test" }, body: {
      domainId: "customer_support", projectId: "case-assist", prompt: "Synthetic request.", maxTokens: 128,
    } };
  assert.equal((await h.handler(event(request))).statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.inferenceConfig.maxTokens, 128);
  assert.match(calls[0].url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\/model\/.*\/converse$/);
  for (const scope of [{ projectId: "ungranted" }, { domainId: "operations" }]) {
    assert.notEqual((await h.handler(event({ ...request, body: { ...request.body, ...scope } }))).statusCode, 200);
  }
  assert.equal(calls.length, 1);
});

test("production identity projection supports a switched Domain Builder journey", async () => {
  const {
    gatewayCalls,
    handler,
    modelPolicyCalls,
    resourceGrantCalls,
  } = runtimeHarness();
  const headers = {
    "x-demo-role": "builder",
    "x-active-domain": "customer_support",
  };

  const created = await handler(event({
    headers: { ...headers, "x-request-id": "create-1" },
  }));
  assert.equal(created.statusCode, 201);
  assert.equal(body(created).agent.status, "DRAFT");

  const configured = await handler(event({
    routeKey: "PUT /api/agents/{id}",
    method: "PUT",
    path: "/api/agents/triage-agent",
    pathParameters: { id: "triage-agent" },
    headers: { ...headers, "x-request-id": "configure-1" },
  }));
  assert.equal(configured.statusCode, 200);
  assert.equal(body(configured).agent.status, "READY_FOR_TEST");

  const tested = await handler(event({
    routeKey: "POST /api/agents/{id}/test",
    path: "/api/agents/triage-agent/test",
    pathParameters: { id: "triage-agent" },
    headers: { ...headers, "x-request-id": "test-1" },
    body: {
      domainId: "customer_support",
      projectId: "case-assist",
      prompt: "Classify this request.",
      maxTokens: 128,
    },
  }));
  assert.equal(tested.statusCode, 200);
  assert.equal(body(tested).agent.status, "TESTED");
  assert.deepEqual(gatewayCalls, [{
    modelId: MODEL_ID,
    prompt: "Classify this request.",
    maxTokens: 128,
    sourceIdentity: "domain_customer_support",
    systemPrompt: "Route incoming support cases to the right queue.",
    temperature: 0.2,
  }]);
  assert.deepEqual(modelPolicyCalls, [
    { modelId: MODEL_ID },
    { modelId: MODEL_ID },
    { modelId: MODEL_ID },
  ]);
  assert.deepEqual(resourceGrantCalls, [
    {
      domainId: "customer_support",
      resourceType: "MODEL",
      resourceId: MODEL_ID,
    },
    {
      domainId: "customer_support",
      resourceType: "MODEL",
      resourceId: MODEL_ID,
    },
    {
      domainId: "customer_support",
      resourceType: "MODEL",
      resourceId: MODEL_ID,
    },
  ]);
});

test("Platform Admin may build in an explicitly selected non-platform domain", async () => {
  const { handler, records } = runtimeHarness();
  const response = await handler(event({
    headers: {
      "x-active-domain": "customer_support",
      "x-request-id": "admin-create-1",
    },
  }));

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(body(response).agent.status, "DRAFT");
  assert.equal(body(response).agent.ownerSubject, "operator-sub");
  assert.equal(records.size, 1);
});

test("Platform Admin cannot build outside the selected domain without break-glass", async () => {
  const { handler, records } = runtimeHarness();
  const response = await handler(event({
    headers: {
      "x-active-domain": "platform",
      "x-request-id": "admin-create-cross-domain",
    },
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "FORBIDDEN");
  assert.equal(records.size, 0);
});

test("Platform Admin may build outside the selected domain with an active break-glass grant", async () => {
  const { handler, records } = runtimeHarness({
    breakGlassRecords: [activeBreakGlass()],
  });
  const response = await handler(event({
    headers: {
      "x-active-domain": "platform",
      "x-request-id": "admin-create-with-break-glass",
    },
  }));

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(body(response).agent.status, "DRAFT");
  assert.equal(body(response).agent.ownerSubject, "operator-sub");
  assert.equal(records.size, 1);
});
