import assert from "node:assert/strict";
import test from "node:test";
import {
  createBuilderHandler,
} from "../lambda/builder/index.mjs";
import {
  BuilderServiceError,
} from "../lambda/builder/service.mjs";

const claims = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:username": "deployment-operator",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

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

function projector() {
  return {
    projectAuthenticated(requestClaims) {
      return {
        actor: requestClaims.sub,
        role: "admin",
      };
    },
    projectEffective(requestClaims, headers, { availableDomains }) {
      const role = headers?.["x-demo-role"] || "admin";
      const domain = headers?.["x-active-domain"] || null;
      if (
        (role === "lead" || role === "builder")
        && !availableDomains.some(({ id }) => id === domain)
      ) {
        const error = new Error("domain not allowed");
        error.code = domain
          ? "DEMO_DOMAIN_NOT_ALLOWED"
          : "DEMO_DOMAIN_REQUIRED";
        error.statusCode = 403;
        throw error;
      }
      return {
        actor: requestClaims.sub,
        role,
        domain,
        domains: domain ? [domain] : [],
      };
    },
  };
}

function event({
  routeKey = "POST /api/agents",
  path = "/api/agents",
  method = "POST",
  body,
  headers = {},
  pathParameters,
  requestClaims = claims,
  requestId = "gateway-request",
  queryStringParameters,
  isBase64Encoded = false,
} = {}) {
  return {
    version: "2.0",
    routeKey,
    body: body === undefined
      ? undefined
      : isBase64Encoded
        ? Buffer.from(JSON.stringify(body)).toString("base64")
        : JSON.stringify(body),
    headers,
    isBase64Encoded,
    pathParameters,
    queryStringParameters,
    requestContext: {
      requestId,
      http: { method, path },
      authorizer: { jwt: { claims: requestClaims } },
    },
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

function handlerWith({
  identityVerifier = async () => true,
  identityProjector = projector(),
  domainDirectory,
  service,
} = {}) {
  const calls = [];
  const builderService = service || {
    async createAgent(input) {
      calls.push(["createAgent", structuredClone(input)]);
      return { id: input.payload.id, status: "DRAFT" };
    },
    async configureAgent(input) {
      calls.push(["configureAgent", structuredClone(input)]);
      return { id: input.agentRef.agentId, status: "READY_FOR_TEST" };
    },
    async testAgent(input) {
      calls.push(["testAgent", structuredClone(input)]);
      return {
        agent: { id: input.agentRef.agentId, status: "TESTED" },
        test: {
          output: "Test response.",
          requestId: "gateway-request",
          usage: { inputTokens: 4, outputTokens: 3 },
        },
      };
    },
  };
  return {
    calls,
    handler: createBuilderHandler({
      builderService,
      domainDirectory: domainDirectory || {
        async listActiveDomains() {
          calls.push(["domains"]);
          return [
            { id: "customer_support" },
            { id: "operations" },
          ];
        },
      },
      identityProjector,
      identityVerifier,
    }),
  };
}

function responseBody(response) {
  return JSON.parse(response.body);
}

test("builder handler requires trusted identity, domain, and service dependencies", () => {
  assert.throws(
    () => createBuilderHandler(),
    /Builder handler configuration is invalid/,
  );
});

test("builder mutation routes require Cognito access-token identity", async () => {
  const { handler, calls } = handlerWith();
  const response = await handler(event({
    requestClaims: { sub: "operator-sub", token_use: "id" },
    headers: { "x-request-id": "create-1" },
    body: createPayload(),
  }));
  assert.equal(response.statusCode, 401);
  assert.equal(responseBody(response).code, "NOT_AUTHENTICATED");
  assert.deepEqual(calls, []);
});

test("demo roles are reverified authoritatively before mutation", async () => {
  const { handler, calls } = handlerWith({
    identityVerifier: async () => false,
  });
  const response = await handler(event({
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
      "x-request-id": "create-1",
    },
    body: createPayload(),
  }));
  assert.equal(response.statusCode, 403);
  assert.equal(responseBody(response).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.equal(calls.some(([name]) => name === "createAgent"), false);
});

test("POST /api/agents dispatches an effective Builder identity and request ID", async () => {
  const { handler, calls } = handlerWith();
  const response = await handler(event({
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
      "x-request-id": "create-1",
    },
    body: createPayload(),
  }));
  assert.equal(response.statusCode, 201);
  assert.deepEqual(responseBody(response), {
    ok: true,
    agent: { id: "triage-agent", status: "DRAFT" },
  });
  assert.deepEqual(
    calls.find(([name]) => name === "createAgent")[1],
    {
      identity: {
        actor: "operator-sub",
        role: "builder",
        activeDomain: "customer_support",
        domainIds: ["customer_support"],
      },
      requestId: "create-1",
      payload: createPayload(),
    },
  );
});

test("PUT and test routes bind the path agent ID to the request", async () => {
  const { handler, calls } = handlerWith();
  const common = {
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
    pathParameters: { id: "triage-agent" },
  };
  const configured = await handler(event({
    ...common,
    routeKey: "PUT /api/agents/{id}",
    method: "PUT",
    path: "/api/agents/triage-agent",
    headers: { ...common.headers, "x-request-id": "configure-1" },
    body: createPayload(),
  }));
  assert.equal(configured.statusCode, 200);

  const tested = await handler(event({
    ...common,
    routeKey: "POST /api/agents/{id}/test",
    path: "/api/agents/triage-agent/test",
    headers: { ...common.headers, "x-request-id": "test-1" },
    body: {
      domainId: "customer_support",
      projectId: "case-assist",
      prompt: "Classify this request.",
      maxTokens: 128,
    },
  }));
  assert.equal(tested.statusCode, 200);
  assert.deepEqual(responseBody(tested), {
    ok: true,
    agent: { id: "triage-agent", status: "TESTED" },
    test: {
      output: "Test response.",
      requestId: "gateway-request",
      usage: { inputTokens: 4, outputTokens: 3 },
    },
  });
  assert.equal(
    calls.find(([name]) => name === "configureAgent")[1]
      .agentRef.agentId,
    "triage-agent",
  );
  assert.equal(
    calls.find(([name]) => name === "testAgent")[1]
      .agentRef.agentId,
    "triage-agent",
  );
});

test("mutation routes require one valid explicit idempotency header", async () => {
  const { handler, calls } = handlerWith();
  for (const headers of [
    {},
    { "x-request-id": "contains space" },
    {
      "x-request-id": "one",
      "X-Request-Id": "two",
    },
  ]) {
    const response = await handler(event({
      headers,
      body: createPayload(),
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(responseBody(response).code, "INVALID_REQUEST_ID");
  }
  assert.equal(calls.some(([name]) => name === "createAgent"), false);
});

test("invalid body, query, path, and route shapes fail before service access", async () => {
  const { handler, calls } = handlerWith();
  const cases = [
    event({
      headers: { "x-request-id": "create-1" },
      body: undefined,
    }),
    event({
      headers: { "x-request-id": "create-1" },
      body: createPayload(),
      queryStringParameters: { extra: "1" },
    }),
    event({
      routeKey: "PUT /api/agents/{id}",
      method: "PUT",
      path: "/api/agents/INVALID",
      pathParameters: { id: "INVALID" },
      headers: { "x-request-id": "configure-1" },
      body: createPayload(),
    }),
    event({
      routeKey: "DELETE /api/agents/{id}",
      method: "DELETE",
      path: "/api/agents/triage-agent",
      pathParameters: { id: "triage-agent" },
      headers: { "x-request-id": "delete-1" },
      body: createPayload(),
    }),
  ];
  for (const request of cases) {
    const response = await handler(request);
    assert.ok([400, 404].includes(response.statusCode));
  }
  assert.equal(
    calls.some(([name]) =>
      ["createAgent", "configureAgent", "testAgent"].includes(name)),
    false,
  );
});

test("service errors are returned without internal details", async () => {
  const { handler } = handlerWith({
    service: {
      async createAgent() {
        throw new BuilderServiceError("RESOURCE_NOT_GRANTED");
      },
      async configureAgent() {
        throw new Error("secret internal message");
      },
      async testAgent() {
        throw new Error("secret internal message");
      },
    },
  });
  const response = await handler(event({
    headers: { "x-request-id": "create-1" },
    body: createPayload(),
  }));
  assert.equal(response.statusCode, 403);
  assert.deepEqual(responseBody(response), {
    ok: false,
    code: "RESOURCE_NOT_GRANTED",
    message: "A selected resource is not granted to the active domain.",
    requestId: "gateway-request",
    retryable: false,
  });
  assert.doesNotMatch(response.body, /secret internal message/);
});
