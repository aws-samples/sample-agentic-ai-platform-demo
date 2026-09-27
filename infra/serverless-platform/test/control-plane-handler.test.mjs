import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AgentRegistryControlClient,
} from "@aws-sdk/client-agent-registry-control";
import {
  BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  ControlPlaneServiceError,
} from "../lambda/control-plane/service.mjs";
import {
  projectEffectiveIdentity,
  projectIdentity,
} from "../lambda/api/identity.mjs";

const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const DEFAULT_SERVICE_CONFIG = {
  accountId: "111122223333",
  region: "us-west-2",
  sharedRegistryId: "SharedReg12345",
  domainRegistryIds: {
    platform: "PlatformReg123",
    customer_support: "SupportReg1234",
    operations: "OperationsReg1",
  },
  llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  llmGatewayName: "agentic-demo-llm-gateway",
  llmGatewayRegion: "us-east-1",
  llmGatewayUrl:
    "https://agentic-demo-llm-gateway-abcdefghij.gateway."
    + "bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
  toolsGatewayId: "platform-tools-gw-klmnopqrst",
  toolsGatewayName: "platform-tools-gw",
  toolsGatewayUrl:
    "https://platform-tools-gw-klmnopqrst.gateway."
    + "bedrock-agentcore.us-west-2.amazonaws.com/mcp",
};
const ACTIVE_DOMAINS = [
  {
    id: "platform",
    name: "Platform",
    registryId: "PlatformReg123",
    status: "ACTIVE",
  },
  {
    id: "customer_support",
    name: "Customer Support",
    registryId: "SupportReg1234",
    status: "ACTIVE",
  },
  {
    id: "operations",
    name: "Operations",
    registryId: "OperationsReg1",
    status: "ACTIVE",
  },
];

function accessClaims(groups, overrides = {}) {
  return {
    sub: "sub-123",
    token_use: "access",
    "cognito:groups": groups,
    ...overrides,
  };
}

function operatorClaims(overrides = {}) {
  return accessClaims(
    [
      "platform-admin",
      "demo-operator",
      "domain-platform",
    ],
    {
      "cognito:username": "operator-user",
      ...overrides,
    },
  );
}

function effectiveScope(claims, headers, requestId) {
  const baseIdentity = projectIdentity(claims);
  const canSwitchDemoRole =
    baseIdentity.role === "admin"
    && baseIdentity.groups.includes("demo-operator");
  const identity = projectEffectiveIdentity(
    claims,
    headers,
    canSwitchDemoRole
      ? {
          availableDomains: ACTIVE_DOMAINS,
          availableDemoDomains: ACTIVE_DOMAINS.filter(
            ({ id }) => id !== "platform" && id !== "shared",
          ),
        }
      : {},
  );
  return {
    actor: identity.actor,
    username: identity.username,
    requestId,
    role: identity.role,
    activeDomain: identity.domain,
    allowedDomains: identity.domains,
    capabilities: identity.capabilities,
    authenticatedRole: identity.authenticatedRole,
    assumedRole: identity.assumedRole,
  };
}

function request(path, {
  body,
  claims,
  headers,
  queryStringParameters,
  requestId = "request-123",
} = {}) {
  return {
    version: "2.0",
    routeKey: `GET ${path}`,
    body,
    headers,
    queryStringParameters,
    requestContext: {
      http: { method: "GET", path },
      requestId,
      ...(claims === undefined
        ? {}
        : { authorizer: { jwt: { claims } } }),
    },
  };
}

async function harness({
  activeDomains = ACTIVE_DOMAINS,
  activeDomainsError,
  aiGatewayResult = { ok: true, source: "aws", models: [] },
  demoOperatorVerifier = async () => true,
  registryResult = { entries: [], source: "aws" },
  serviceError,
} = {}) {
  const module = await import("../lambda/control-plane/index.mjs");
  assert.equal(typeof module.createControlPlaneHandler, "function");
  const calls = [];
  const logs = [];
  const logger = {
    error(entry) {
      logs.push(entry);
    },
  };
  const service = {
    async listActiveDomains() {
      calls.push({ method: "listActiveDomains" });
      if (activeDomainsError) {
        throw activeDomainsError;
      }
      return activeDomains;
    },
    async registry(scope) {
      calls.push({ method: "registry", scope });
      if (serviceError) {
        throw serviceError;
      }
      return registryResult;
    },
    async aiGateway(scope) {
      calls.push({ method: "aiGateway", scope });
      if (serviceError) {
        throw serviceError;
      }
      return aiGatewayResult;
    },
  };
  return {
    calls,
    handler: module.createControlPlaneHandler({
      demoOperatorVerifier,
      logger,
      service,
    }),
    logs,
  };
}

test("GET /api/registry uses verified admin claims and ignores spoofed input", async () => {
  const registryResult = {
    entries: [{ id: "skill-1" }],
    source: "aws",
  };
  const { calls, handler } = await harness({ registryResult });
  const response = await handler(request("/api/registry", {
    body: JSON.stringify({
      role: "builder",
      domain: "operations",
      activeDomain: "operations",
    }),
    claims: accessClaims(
      "[platform-admin,domain-platform,domain-customer-support]",
    ),
    queryStringParameters: {
      role: "builder",
      domain: "operations",
      activeDomain: "operations",
    },
    requestId: "registry-admin",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), registryResult);
  assert.deepEqual(calls, [{
    method: "registry",
    scope: effectiveScope(
      accessClaims(
        "[platform-admin,domain-platform,domain-customer-support]",
      ),
      undefined,
      "registry-admin",
    ),
  }]);
});

test("GET /api/registry projects a dynamic admin domain header", async () => {
  const { calls, handler } = await harness();
  const response = await handler(request("/api/registry", {
    claims: accessClaims(["platform-admin"]),
    headers: { "x-active-domain": "finance" },
    requestId: "registry-admin-finance",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{
    method: "registry",
    scope: effectiveScope(
      accessClaims(["platform-admin"]),
      { "x-active-domain": "finance" },
      "registry-admin-finance",
    ),
  }]);
});

test("GET /api/registry preserves stable 403s for malformed admin domains", async () => {
  for (const [label, activeDomain] of [
    ["empty", ""],
    ["blank", "   "],
    ["leading-space", " finance"],
    ["trailing-space", "finance "],
    ["uppercase", "Finance"],
    ["traversal", "../finance"],
    ["overlong", `f${"a".repeat(64)}`],
    ["non-string", 42],
  ]) {
    const { calls, handler, logs } = await harness();
    const requestId = `registry-admin-${label}`;
    const response = await handler(request("/api/registry", {
      claims: accessClaims(["platform-admin"]),
      headers: { "x-active-domain": activeDomain },
      requestId,
    }));

    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "DEMO_DOMAIN_NOT_ALLOWED",
      message: "The requested demo domain is not allowed.",
      requestId,
      retryable: false,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
  }
});

test("GET /api/registry filters mixed results by a supported type", async () => {
  const registryResult = {
    ok: true,
    entries: [
      { id: "skill-1", type: "Skill" },
      { id: "model-1", type: "Model" },
      { id: "blueprint-1", type: "Blueprint" },
      { id: "model-2", type: "Model" },
    ],
    types: [
      "Skill",
      "MCPServer",
      "A2AAgent",
      "Agent",
      "Model",
      "Blueprint",
    ],
    statuses: ["DRAFT", "APPROVED"],
    store: "AWS Agent Registry + AgentCore Gateway",
    source: "aws",
  };
  const { handler } = await harness({ registryResult });
  const response = await handler(request("/api/registry", {
    claims: accessClaims(["platform-admin"]),
    queryStringParameters: { type: "Model" },
    requestId: "registry-model-filter",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    ...registryResult,
    entries: [
      { id: "model-1", type: "Model" },
      { id: "model-2", type: "Model" },
    ],
  });
});

test("GET /api/registry rejects blank or unsupported type filters", async () => {
  for (const [label, type] of [
    ["blank", ""],
    ["unsupported", "Prompt"],
  ]) {
    const { calls, handler, logs } = await harness();
    const requestId = `registry-${label}-type`;
    const response = await handler(request("/api/registry", {
      claims: accessClaims(["platform-admin"]),
      queryStringParameters: { type },
      requestId,
    }));

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.headers, RESPONSE_HEADERS);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "INVALID_REGISTRY_TYPE",
      message: "Registry type is invalid.",
      requestId,
      retryable: false,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
  }
});

test("End User route authorization precedes explicit type validation", async () => {
  const { calls, handler, logs } = await harness();
  const response = await handler(request("/api/registry", {
    claims: accessClaims(["end-user"]),
    queryStringParameters: { type: "Prompt" },
    requestId: "domain-required-before-registry-type",
  }));

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "FORBIDDEN",
    message: "The requested operation is not allowed.",
    requestId: "domain-required-before-registry-type",
    retryable: false,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test("GET /api/ai-gateway denies Builder before Gateway reads", async () => {
  const { calls, handler } = await harness();
  const response = await handler(request("/api/ai-gateway", {
    body: JSON.stringify({
      role: "admin",
      domain: "platform",
      activeDomain: "platform",
    }),
    claims: accessClaims([
      "domain-builder",
      "domain-platform",
      "domain-operations",
    ]),
    headers: { "X-Active-Domain": "operations" },
    queryStringParameters: {
      role: "admin",
      domain: "platform",
      activeDomain: "platform",
      "x-active-domain": "platform",
    },
    requestId: "gateway-builder",
  }));

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "FORBIDDEN",
    message: "The requested operation is not allowed.",
    requestId: "gateway-builder",
    retryable: false,
  });
  assert.deepEqual(calls, []);
});

test("control-plane routes fail closed without valid access-token claims", async () => {
  const { calls, handler, logs } = await harness();

  for (const [path, claims] of [
    ["/api/registry", undefined],
    ["/api/ai-gateway", { sub: "sub-123", token_use: "id" }],
  ]) {
    const response = await handler(request(path, {
      claims,
      requestId: `unauthenticated-${path}`,
    }));

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.headers, RESPONSE_HEADERS);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "NOT_AUTHENTICATED",
      message: "Sign in is required.",
      requestId: `unauthenticated-${path}`,
      retryable: false,
    });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test("an end user may request only the approved Agent Registry projection", async () => {
  const { calls, handler, logs } = await harness();
  const response = await handler(request("/api/registry", {
    claims: accessClaims(["end-user"]),
    queryStringParameters: { type: "Agent" },
    requestId: "end-user-agents",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    entries: [],
    source: "aws",
  });
  assert.deepEqual(calls, [{
    method: "registry",
    scope: effectiveScope(
      accessClaims(["end-user"]),
      undefined,
      "end-user-agents",
    ),
  }]);
  assert.deepEqual(logs, []);
});

test("a forbidden Builder AI Gateway route wins before domain projection", async () => {
  const { calls, handler, logs } = await harness();
  const response = await handler(request("/api/ai-gateway", {
    body: JSON.stringify({
      role: "admin",
      domain: "operations",
      activeDomain: "operations",
    }),
    claims: accessClaims(["domain-builder", "domain-operations"]),
    headers: { "x-active-domain": "platform" },
    queryStringParameters: {
      role: "admin",
      domain: "operations",
      activeDomain: "operations",
    },
    requestId: "domain-not-allowed",
  }));

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "FORBIDDEN",
    message: "The requested operation is not allowed.",
    requestId: "domain-not-allowed",
    retryable: false,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test("backend unavailability returns a stable 503 with the request ID", async () => {
  const serviceError = new ControlPlaneServiceError(
    "Control plane inventory is temporarily unavailable.",
    {
      code: "CONTROL_PLANE_UNAVAILABLE",
      component: "registry",
      statusCode: 503,
      retryable: true,
    },
  );
  const { calls, handler, logs } = await harness({ serviceError });
  const response = await handler(request("/api/registry", {
    claims: accessClaims(["platform-admin"]),
    requestId: "backend-unavailable",
  }));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "CONTROL_PLANE_UNAVAILABLE",
    message: "Control plane inventory is temporarily unavailable.",
    requestId: "backend-unavailable",
    retryable: true,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, [{
    event: "control_plane_request_failed",
    code: "CONTROL_PLANE_UNAVAILABLE",
    component: "registry",
    requestId: "backend-unavailable",
    stage: "unknown",
    errorCode: "UNKNOWN",
  }]);
});

test("malformed default configuration logs only safe request context", async () => {
  const module = await import("../lambda/control-plane/index.mjs");
  const logs = [];
  const logger = {
    error(entry) {
      logs.push(entry);
    },
  };
  const previousConfig = process.env.CONTROL_PLANE_CONFIG;
  const previousTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  process.env.CONTROL_PLANE_CONFIG =
    "{\"region\":\"us-west-2\",\"credentials\":\"TOP-SECRET\"";
  process.env.PLATFORM_STATE_TABLE_NAME = "PlatformState";

  try {
    const handler = module.createControlPlaneHandler({ logger });
    const response = await handler(request("/api/registry", {
      claims: accessClaims(["platform-admin"]),
      requestId: "malformed-config",
    }));

    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "CONTROL_PLANE_UNAVAILABLE",
      message: "Control plane inventory is temporarily unavailable.",
      requestId: "malformed-config",
      retryable: true,
    });
    assert.doesNotMatch(response.body, /TOP-SECRET/);
    assert.deepEqual(logs, [{
      event: "control_plane_request_failed",
      code: "CONTROL_PLANE_UNAVAILABLE",
      requestId: "malformed-config",
    }]);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /TOP-SECRET|credentials|us-west-2|stack|message/i,
    );
  } finally {
    if (previousConfig === undefined) {
      delete process.env.CONTROL_PLANE_CONFIG;
    } else {
      process.env.CONTROL_PLANE_CONFIG = previousConfig;
    }
    if (previousTableName === undefined) {
      delete process.env.PLATFORM_STATE_TABLE_NAME;
    } else {
      process.env.PLATFORM_STATE_TABLE_NAME = previousTableName;
    }
  }
});

test("arbitrary backend exceptions never leak secret error details", async () => {
  const serviceError = Object.assign(
    new Error("TOP-SECRET backend failure"),
    {
      code: "DOMAIN_NOT_ALLOWED",
      configuration: { endpoint: "https://TOP-SECRET.invalid" },
      credentials: { secretAccessKey: "TOP-SECRET" },
      statusCode: 403,
    },
  );
  const { handler, logs } = await harness({ serviceError });
  const response = await handler(request("/api/ai-gateway", {
    claims: accessClaims(["platform-admin"]),
    requestId: "secret-backend-error",
  }));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "CONTROL_PLANE_UNAVAILABLE",
    message: "Control plane inventory is temporarily unavailable.",
    requestId: "secret-backend-error",
    retryable: true,
  });
  assert.doesNotMatch(response.body, /TOP-SECRET/);
  assert.deepEqual(logs, [{
    event: "control_plane_request_failed",
    code: "CONTROL_PLANE_UNAVAILABLE",
    requestId: "secret-backend-error",
  }]);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /TOP-SECRET|credentials|configuration|stack|message/i,
  );
});

test("the handler lazily creates its default service through the service factory", async () => {
  const module = await import("../lambda/control-plane/index.mjs");
  const calls = [];
  const serviceFactory = () => {
    calls.push("factory");
    return {
      async registry(scope) {
        calls.push({ method: "registry", scope });
        return { entries: [], source: "aws" };
      },
    };
  };
  const handler = module.createControlPlaneHandler({ serviceFactory });
  const response = await handler(request("/api/registry", {
    claims: accessClaims(["platform-admin"]),
    requestId: "default-service",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    entries: [],
    source: "aws",
  });
  assert.deepEqual(calls, [
    "factory",
    {
      method: "registry",
      scope: effectiveScope(
        accessClaims(["platform-admin"]),
        undefined,
        "default-service",
      ),
    },
  ]);
});

test("demo operator Registry journeys use effective scopes and durable domains", async () => {
  const journeys = [
    {
      role: "admin",
      domain: null,
      queryStringParameters: { type: "Skill" },
    },
    {
      role: "lead",
      domain: "operations",
      queryStringParameters: { type: "Skill" },
    },
    {
      role: "builder",
      domain: "customer_support",
      queryStringParameters: { type: "Agent" },
    },
    {
      role: "user",
      domain: null,
      queryStringParameters: { type: "Agent" },
    },
  ];

  for (const journey of journeys) {
    const { calls, handler } = await harness();
    const headers = {
      "x-demo-role": journey.role,
      ...(journey.domain
        ? { "x-active-domain": journey.domain }
        : {}),
    };
    const requestId = `journey-${journey.role}`;
    const response = await handler(request("/api/registry", {
      claims: operatorClaims(),
      headers,
      queryStringParameters: journey.queryStringParameters,
      requestId,
    }));

    assert.equal(response.statusCode, 200, journey.role);
    const registryCall = calls.find(({ method }) => method === "registry");
    assert.deepEqual(
      registryCall?.scope,
      effectiveScope(operatorClaims(), headers, requestId),
      journey.role,
    );
    if (journey.domain) {
      assert.deepEqual(calls[0], { method: "listActiveDomains" });
    }
  }
});

test("demo Lead, Builder, and End User cannot reach AI Gateway", async () => {
  for (const [role, domain] of [
    ["lead", "operations"],
    ["builder", "operations"],
    ["user", null],
  ]) {
    const { calls, handler } = await harness();
    const headers = {
      "x-demo-role": role,
      ...(domain ? { "x-active-domain": domain } : {}),
    };
    const response = await handler(request("/api/ai-gateway", {
      claims: operatorClaims(),
      headers,
      requestId: `gateway-${role}`,
    }));

    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
    assert.deepEqual(calls, []);
  }
});

test("forbidden AI Gateway routes beat service and domain-state outages", async () => {
  const calls = [];
  const module = await import("../lambda/control-plane/index.mjs");
  const handler = module.createControlPlaneHandler({
    demoOperatorVerifier: async () => true,
    serviceFactory() {
      calls.push("factory");
      throw new Error("TOP-SECRET service outage");
    },
  });

  for (const [role, domain] of [
    ["lead", "operations"],
    ["builder", "operations"],
    ["user", null],
  ]) {
    const response = await handler(request("/api/ai-gateway", {
      claims: operatorClaims(),
      headers: {
        "x-demo-role": role,
        ...(domain ? { "x-active-domain": domain } : {}),
      },
      requestId: `forbidden-outage-${role}`,
    }));

    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
  }
  assert.deepEqual(calls, []);
});

test("End User Registry rejects missing, foreign, and extra query shapes before reads", async () => {
  for (const queryStringParameters of [
    undefined,
    { type: "Skill" },
    { type: "Agent", domain: "operations" },
  ]) {
    const { calls, handler } = await harness();
    const response = await handler(request("/api/registry", {
      claims: operatorClaims(),
      headers: { "x-demo-role": "user" },
      queryStringParameters,
      requestId: "end-user-query-denied",
    }));

    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
    assert.deepEqual(calls, []);
  }
});

test("forged demo roles fail before service construction or backend reads", async () => {
  const calls = [];
  const module = await import("../lambda/control-plane/index.mjs");
  const handler = module.createControlPlaneHandler({
    serviceFactory() {
      calls.push("factory");
      return {};
    },
  });

  const response = await handler(request("/api/registry", {
    claims: accessClaims(["end-user"]),
    headers: { "x-demo-role": "admin" },
    queryStringParameters: { type: "Agent" },
    requestId: "forged-role",
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.deepEqual(calls, []);
});

test("reserved and unavailable demo domains return stable errors before inventory reads", async () => {
  for (const domain of ["platform", "finance"]) {
    const { calls, handler } = await harness();
    const response = await handler(request("/api/registry", {
      claims: operatorClaims(),
      headers: {
        "x-demo-role": "builder",
        "x-active-domain": domain,
      },
      queryStringParameters: { type: "Agent" },
      requestId: `invalid-demo-domain-${domain}`,
    }));

    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).code, "DEMO_DOMAIN_NOT_ALLOWED");
    assert.deepEqual(calls, [{ method: "listActiveDomains" }]);
  }
});

test("demo domain state failures map safely while invalid roles win before state reads", async () => {
  const stateFailure = new Error("TOP-SECRET state failure");
  const { calls, handler } = await harness({
    activeDomainsError: stateFailure,
  });
  const unavailable = await handler(request("/api/registry", {
    claims: operatorClaims(),
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "operations",
    },
    queryStringParameters: { type: "Skill" },
    requestId: "demo-state-failure",
  }));
  assert.equal(unavailable.statusCode, 503);
  assert.equal(
    JSON.parse(unavailable.body).code,
    "DEMO_CONTEXT_UNAVAILABLE",
  );
  assert.doesNotMatch(unavailable.body, /TOP-SECRET/);
  assert.deepEqual(calls, [{ method: "listActiveDomains" }]);

  const invalid = await handler(request("/api/registry", {
    claims: operatorClaims(),
    headers: {
      "x-demo-role": "owner",
      "x-active-domain": "operations",
    },
    queryStringParameters: { type: "Prompt" },
    requestId: "invalid-role-precedence",
  }));
  assert.equal(invalid.statusCode, 403);
  assert.equal(JSON.parse(invalid.body).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.deepEqual(calls, [{ method: "listActiveDomains" }]);
});

test("the default service resolves durable domains from the platform state table", async () => {
  const source = await readFile(
    new URL("../lambda/control-plane/index.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /@aws-sdk\/client-dynamodb/);
  assert.match(source, /createPlatformState/);
  assert.match(source, /PLATFORM_STATE_TABLE_NAME/);
  assert.match(source, /domainState/);
  assert.match(source, /@aws-sdk\/client-sts/);
  assert.match(source, /createGatewayCredentialsProvider/);
  assert.match(source, /GATEWAY_INVOKER_ROLE_ARN/);
  assert.match(source, /sourceIdentity:\s*"platform"/);
});

test("the default handler fails closed when the platform state table is absent", async () => {
  const previousEnvironment = {
    CONTROL_PLANE_CONFIG: process.env.CONTROL_PLANE_CONFIG,
    PLATFORM_STATE_TABLE_NAME: process.env.PLATFORM_STATE_TABLE_NAME,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  };
  const previousRegistrySend = AgentRegistryControlClient.prototype.send;
  const previousGatewaySend = BedrockAgentCoreControlClient.prototype.send;
  const previousFetch = globalThis.fetch;
  const backendCalls = [];
  const logs = [];
  const logger = {
    error(entry) {
      logs.push(entry);
    },
  };

  process.env.CONTROL_PLANE_CONFIG =
    JSON.stringify(DEFAULT_SERVICE_CONFIG);
  process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  process.env.AWS_SESSION_TOKEN = "token";
  AgentRegistryControlClient.prototype.send = async (command) => {
    backendCalls.push(command.constructor.name);
    return { registryRecords: [] };
  };
  BedrockAgentCoreControlClient.prototype.send = async (command) => {
    backendCalls.push(command.constructor.name);
    return { items: [] };
  };
  globalThis.fetch = async (...args) => {
    backendCalls.push(["fetch", ...args]);
    return {
      ok: true,
      text: async () => JSON.stringify({ data: [] }),
    };
  };

  try {
    for (const [label, tableName] of [
      ["missing", undefined],
      ["blank", "   "],
    ]) {
      if (tableName === undefined) {
        delete process.env.PLATFORM_STATE_TABLE_NAME;
      } else {
        process.env.PLATFORM_STATE_TABLE_NAME = tableName;
      }
      const module = await import(
        `../lambda/control-plane/index.mjs?missing-table=${label}-${Date.now()}`
      );
      const handler = module.createControlPlaneHandler({ logger });
      const requestId = `missing-platform-state-${label}`;
      const response = await handler(request("/api/registry", {
        claims: accessClaims(["platform-admin"]),
        requestId,
      }));

      assert.equal(response.statusCode, 503);
      assert.deepEqual(JSON.parse(response.body), {
        ok: false,
        code: "CONTROL_PLANE_UNAVAILABLE",
        message: "Control plane inventory is temporarily unavailable.",
        requestId,
        retryable: true,
      });
    }
    assert.deepEqual(backendCalls, []);
    assert.deepEqual(logs, [
      {
        event: "control_plane_request_failed",
        code: "CONTROL_PLANE_UNAVAILABLE",
        requestId: "missing-platform-state-missing",
      },
      {
        event: "control_plane_request_failed",
        code: "CONTROL_PLANE_UNAVAILABLE",
        requestId: "missing-platform-state-blank",
      },
    ]);
  } finally {
    AgentRegistryControlClient.prototype.send = previousRegistrySend;
    BedrockAgentCoreControlClient.prototype.send = previousGatewaySend;
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("control-plane routes deny stale demo-role claims before service access", async () => {
  const module = await import("../lambda/control-plane/index.mjs");
  const verifierCalls = [];
  const serviceCalls = [];
  const handler = module.createControlPlaneHandler({
    demoOperatorVerifier: async (claims) => {
      verifierCalls.push(claims);
      return false;
    },
    service: {
      async listActiveDomains() {
        serviceCalls.push("listActiveDomains");
        return ACTIVE_DOMAINS;
      },
      async registry() {
        serviceCalls.push("registry");
        return { entries: [], source: "aws" };
      },
    },
  });
  const claims = operatorClaims();
  const response = await handler(request("/api/registry", {
    claims,
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "operations",
    },
    requestId: "revoked-control-plane-operator",
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.deepEqual(verifierCalls, [claims]);
  assert.deepEqual(serviceCalls, []);
});

test('internal diagnostic log revalidates enums and never exposes raw cause or client details',async()=>{
 for(const diagnostic of [{stage:'registry-list',errorCode:'THROTTLED',message:'SYNTHETIC_PRIVATE',credentials:'SYNTHETIC_PRIVATE'},{stage:'SYNTHETIC_PRIVATE',errorCode:'SYNTHETIC_PRIVATE'}]){
  const serviceError=new ControlPlaneServiceError('SYNTHETIC_PRIVATE',{code:'CONTROL_PLANE_UNAVAILABLE',component:'registry',statusCode:503,diagnostic});serviceError.stack='SYNTHETIC_PRIVATE';serviceError.rawDescriptor={content:'SYNTHETIC_PRIVATE'};
  const {handler,logs}=await harness({serviceError});const r=await handler(request('/api/registry',{claims:accessClaims(['platform-admin']),requestId:'synthetic-safe-diagnostic'}));assert.equal(r.statusCode,503);assert.doesNotMatch(r.body,/stage|errorCode|SYNTHETIC_PRIVATE/);assert.deepEqual(Object.keys(logs[0]).sort(),['code','component','errorCode','event','requestId','stage']);assert.doesNotMatch(JSON.stringify(logs),/SYNTHETIC_PRIVATE|message|stack|credentials|rawDescriptor/);assert.equal(logs[0].stage,diagnostic.stage==='registry-list'?'registry-list':'unknown');
 }
});
