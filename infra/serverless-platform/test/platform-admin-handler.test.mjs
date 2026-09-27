import assert from "node:assert/strict";
import test from "node:test";
import {
  PlatformAdminServiceError,
} from "../lambda/platform-admin/service.mjs";
import {
  projectEffectiveIdentity,
} from "../lambda/api/identity.mjs";

const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const ACTIVE_DOMAINS = [
  {
    id: "platform",
    name: "Platform",
    registryId: "PlatformReg1234",
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
    sub: "admin-sub-123",
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
  const identity = projectEffectiveIdentity(
    claims,
    headers,
    {
      availableDomains: ACTIVE_DOMAINS,
      availableDemoDomains: ACTIVE_DOMAINS.filter(
        ({ id }) => id !== "platform" && id !== "shared",
      ),
    },
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

function request(method, path, {
  body,
  claims,
  headers,
  isBase64Encoded,
  queryStringParameters,
  requestId = "gateway-request-123",
} = {}) {
  const resolvedHeaders = headers === undefined && method === "POST"
    ? { "x-request-id": requestId }
    : headers;
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    body,
    headers: resolvedHeaders,
    isBase64Encoded,
    queryStringParameters,
    requestContext: {
      http: { method, path },
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
  correlationIdFactory,
  createResult = {
    ok: true,
    domain: {
      id: "finance",
      name: "Finance",
      registryId: "FinanceReg1234",
      status: "ACTIVE",
    },
  },
  listResult = {
    ok: true,
    domains: [],
  },
  decideResult = {
    ok: true,
    version: {
      id: "customer-support-blueprint",
      semver: "1.0.0",
      status: "APPROVED",
      statusReason: "Approved by platform administrator.",
      _aws: {
        registryId: "SharedReg12345",
        recordId: "Rec123456789",
      },
    },
  },
  demoOperatorVerifier = async () => true,
  serviceError,
} = {}) {
  const module = await import("../lambda/platform-admin/index.mjs");
  assert.equal(typeof module.createPlatformAdminHandler, "function");
  assert.equal(typeof module.handler, "function");
  const calls = [];
  const logs = [];
  const service = {
    async listActiveDomains() {
      calls.push({ method: "listActiveDomains" });
      if (activeDomainsError) throw activeDomainsError;
      return activeDomains;
    },
    async createDomain(scope, input) {
      calls.push({
        method: "createDomain",
        scope: structuredClone(scope),
        input: structuredClone(input),
      });
      if (serviceError) throw serviceError;
      return createResult;
    },
    async listDomains(scope) {
      calls.push({
        method: "listDomains",
        scope: structuredClone(scope),
      });
      if (serviceError) throw serviceError;
      return listResult;
    },
    async decideRegistryVersion(scope, input) {
      calls.push({
        method: "decideRegistryVersion",
        scope: structuredClone(scope),
        input: structuredClone(input),
      });
      if (serviceError) throw serviceError;
      return decideResult;
    },
  };
  return {
    calls,
    handler: module.createPlatformAdminHandler({
      correlationIdFactory,
      demoOperatorVerifier,
      logger: {
        error(entry) {
          logs.push(entry);
        },
      },
      service,
    }),
    logs,
    module,
  };
}

test("GET /api/domains projects trusted claims and returns durable domains with requestId", async () => {
  const listResult = {
    ok: true,
    domains: [{
      id: "platform",
      name: "Platform",
      registryId: "PlatformReg1234",
      status: "ACTIVE",
    }],
  };
  const { calls, handler } = await harness({ listResult });
  const response = await handler(request("GET", "/api/domains", {
    body: JSON.stringify({
      role: "user",
      domain: "operations",
      requestId: "spoofed",
    }),
    claims: accessClaims([
      "platform-admin",
      "domain-platform",
      "domain-operations",
    ]),
    queryStringParameters: {
      role: "user",
      domain: "customer_support",
    },
    requestId: "list-request",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    ...listResult,
    requestId: "list-request",
  });
  assert.deepEqual(calls, [{
    method: "listDomains",
    scope: effectiveScope(
      accessClaims([
        "platform-admin",
        "domain-platform",
        "domain-operations",
      ]),
      undefined,
      "list-request",
    ),
  }]);
});

test("GET /api/domains validates an ordinary admin selected active domain", async () => {
  const listResult = {
    ok: true,
    domains: ACTIVE_DOMAINS,
  };
  const { calls, handler } = await harness({ listResult });
  const claims = accessClaims([
    "platform-admin",
    "domain-platform",
  ]);
  const headers = { "x-active-domain": "operations" };
  const response = await handler(request("GET", "/api/domains", {
    claims,
    headers,
    requestId: "permanent-admin-active",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    JSON.parse(response.body).domains.map(({ id }) => id),
    ["operations"],
  );
  assert.deepEqual(calls, [
    { method: "listActiveDomains" },
    {
      method: "listDomains",
      scope: effectiveScope(
        claims,
        headers,
        "permanent-admin-active",
      ),
    },
  ]);
});

test("GET /api/domains rejects ordinary admin selections outside active state", async () => {
  for (const domain of ["nonexistent", "retired"]) {
    const { calls, handler } = await harness({
      activeDomains: ACTIVE_DOMAINS,
      listResult: {
        ok: true,
        domains: ACTIVE_DOMAINS,
      },
    });
    const requestId = `permanent-admin-${domain}`;
    const response = await handler(request("GET", "/api/domains", {
      claims: accessClaims([
        "platform-admin",
        "domain-platform",
      ]),
      headers: { "x-active-domain": domain },
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
    assert.deepEqual(calls, [{ method: "listActiveDomains" }]);
  }
});

test("GET /api/domains validates a permanent Builder domain against active state", async () => {
  const listResult = {
    ok: true,
    domains: ACTIVE_DOMAINS,
  };
  const { calls, handler } = await harness({ listResult });
  const claims = accessClaims([
    "domain-builder",
    "domain-operations",
  ]);
  const response = await handler(request("GET", "/api/domains", {
    claims,
    requestId: "permanent-builder-active",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    JSON.parse(response.body).domains.map(({ id }) => id),
    ["operations"],
  );
  assert.deepEqual(calls, [
    { method: "listActiveDomains" },
    {
      method: "listDomains",
      scope: effectiveScope(
        claims,
        undefined,
        "permanent-builder-active",
      ),
    },
  ]);
});

test("GET /api/domains rejects a stale permanent Builder domain", async () => {
  const { calls, handler } = await harness({
    activeDomains: ACTIVE_DOMAINS,
    listResult: {
      ok: true,
      domains: [],
    },
  });
  const response = await handler(request("GET", "/api/domains", {
    claims: accessClaims([
      "domain-builder",
      "domain-retired",
    ]),
    requestId: "permanent-builder-retired",
  }));

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "DEMO_DOMAIN_NOT_ALLOWED",
    message: "The requested demo domain is not allowed.",
    requestId: "permanent-builder-retired",
    retryable: false,
  });
  assert.deepEqual(calls, [{ method: "listActiveDomains" }]);
});

test("POST /api/domain-create uses the header request ID and accepts base64 object JSON", async () => {
  const { calls, handler } = await harness();
  const domainInput = {
    name: "Finance",
    owner: "",
    ownerGroup: "",
    description: "",
    tokenBudget: "24000",
  };
  const response = await handler(request("POST", "/api/domain-create", {
    body: Buffer.from(JSON.stringify(domainInput)).toString("base64"),
    claims: accessClaims(
      ["platform-admin", "domain-platform"],
      { "cognito:username": "hosted-acceptance-admin-12345-2" },
    ),
    headers: { "X-Request-ID": "explicit-retry-123" },
    isBase64Encoded: true,
    queryStringParameters: {
      role: "builder",
      domain: "operations",
      requestId: "spoofed",
    },
    requestId: "gateway-request-ignored",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    domain: {
      id: "finance",
      name: "Finance",
      registryId: "FinanceReg1234",
      status: "ACTIVE",
    },
    requestId: "explicit-retry-123",
  });
  assert.deepEqual(calls, [{
    method: "createDomain",
    scope: effectiveScope(
      accessClaims(
        ["platform-admin", "domain-platform"],
        { "cognito:username": "hosted-acceptance-admin-12345-2" },
      ),
      { "X-Request-ID": "explicit-retry-123" },
      "explicit-retry-123",
    ),
    input: domainInput,
  }]);
});

test("POST /api/registry-decide permits platform Registry moderation", async () => {
  const { calls, handler } = await harness();
  const input = {
    id: "customer-support-blueprint",
    semver: "1.0.0",
    decision: "approve",
    reason: "",
  };
  const response = await handler(request("POST", "/api/registry-decide", {
    body: JSON.stringify(input),
    claims: accessClaims([
      "platform-admin",
      "domain-platform",
      "domain-operations",
    ]),
    headers: { "x-request-id": "registry-decision-request-123" },
    queryStringParameters: {
      role: "builder",
      capability: "none",
      requestId: "spoofed",
    },
    requestId: "gateway-request-ignored",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    version: {
      id: "customer-support-blueprint",
      semver: "1.0.0",
      status: "APPROVED",
      statusReason: "Approved by platform administrator.",
      _aws: {
        registryId: "SharedReg12345",
        recordId: "Rec123456789",
      },
    },
    requestId: "registry-decision-request-123",
  });
  assert.deepEqual(calls, [{
    method: "decideRegistryVersion",
    scope: effectiveScope(
      accessClaims([
        "platform-admin",
        "domain-platform",
        "domain-operations",
      ]),
      { "x-request-id": "registry-decision-request-123" },
      "registry-decision-request-123",
    ),
    input,
  }]);
});

test("mutation routes require an explicit valid x-request-id", async () => {
  for (const path of ["/api/domain-create", "/api/registry-decide"]) {
    const { calls, handler } = await harness();
    const response = await handler(request("POST", path, {
      body: path.endsWith("domain-create")
        ? JSON.stringify({ name: "Finance" })
        : JSON.stringify({
          id: "customer-support-blueprint",
          semver: "1.0.0",
          decision: "approve",
          reason: "",
        }),
      claims: accessClaims(["platform-admin"]),
      headers: {},
      requestId: "gateway-correlation-only",
    }));

    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "INVALID_REQUEST_ID",
      message: "Request ID is invalid.",
      requestId: "gateway-correlation-only",
      retryable: false,
    });
    assert.deepEqual(calls, []);
  }
});

test("POST /api/registry-decide requires a trusted hosted administrator", async () => {
  const { calls, handler, logs } = await harness();
  for (const [requestId, groups] of [
    ["builder-decide", ["domain-builder", "domain-platform"]],
    [
      "ambiguous-decide",
      ["platform-admin", "domain-builder", "domain-platform"],
    ],
  ]) {
    const response = await handler(request(
      "POST",
      "/api/registry-decide",
      {
        body: JSON.stringify({
          id: "customer-support-blueprint",
          semver: "1.0.0",
          decision: "approve",
          reason: "",
          role: "admin",
          capability: "approveRegistryVersion",
        }),
        claims: accessClaims(groups),
        queryStringParameters: {
          role: "admin",
          capability: "approveRegistryVersion",
        },
        requestId,
      },
    ));
    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "FORBIDDEN",
      message: "Platform administrator access is required.",
      requestId,
      retryable: false,
    });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test("platform Registry moderation rejects malformed request bodies", async () => {
  const oversized = JSON.stringify({
    id: "customer-support-blueprint",
    semver: "1.0.0",
    decision: "reject",
    reason: "x".repeat(16 * 1024),
  });
  const invalidBodies = [
    { body: undefined },
    { body: "" },
    { body: "{" },
    { body: "null" },
    { body: "[]" },
    {
      body: JSON.stringify({
        id: "customer-support-blueprint",
        semver: "1.0.0",
        decision: "approve",
      }),
    },
    {
      body: JSON.stringify({
        id: "customer-support-blueprint",
        semver: "1.0.0",
        decision: "approve",
        reason: "",
        requestId: "body-control",
      }),
    },
    {
      body: JSON.stringify({
        id: "customer-support-blueprint",
        semver: "1.0.0",
        decision: "approve",
        reason: "",
        capability: "approveRegistryVersion",
      }),
    },
    { body: oversized },
    { body: "not canonical base64 ***", isBase64Encoded: true },
    {
      body: Buffer.from([0xc3, 0x28]).toString("base64"),
      isBase64Encoded: true,
    },
  ];

  for (const [index, bodyOptions] of invalidBodies.entries()) {
    const { calls, handler, logs } = await harness();
    const requestId = `invalid-decision-body-${index}`;
    const response = await handler(request(
      "POST",
      "/api/registry-decide",
      {
        ...bodyOptions,
        claims: accessClaims(["platform-admin"]),
        requestId,
      },
    ));
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "INVALID_BODY",
      message: "Request body is invalid.",
      requestId,
      retryable: false,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
  }
});

test("platform admin routes require an own sub and an access token", async () => {
  const inheritedClaims = Object.create({
    sub: "inherited-sub",
    token_use: "access",
  });
  const { calls, handler, logs } = await harness();
  for (const [label, claims] of [
    ["missing", undefined],
    ["inherited", inheritedClaims],
    ["blank", { sub: " ", token_use: "access" }],
    ["id-token", { sub: "admin-sub-123", token_use: "id" }],
  ]) {
    const response = await handler(request("GET", "/api/domains", {
      claims,
      requestId: `auth-${label}`,
    }));
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "NOT_AUTHENTICATED",
      message: "Sign in is required.",
      requestId: `auth-${label}`,
      retryable: false,
    });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test("domain creation is admin-only and ignores body or query role elevation", async () => {
  const { calls, handler, logs } = await harness();
  for (const [requestId, groups] of [
    ["builder-create", ["domain-builder", "domain-finance"]],
    [
      "mixed-role-create",
      ["platform-admin", "domain-builder", "domain-finance"],
    ],
  ]) {
    const response = await handler(request("POST", "/api/domain-create", {
      body: JSON.stringify({ name: "Finance" }),
      claims: accessClaims(groups),
      queryStringParameters: { role: "admin" },
      requestId,
    }));

    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "FORBIDDEN",
      message: "Platform administrator access is required.",
      requestId,
      retryable: false,
    });
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test("POST parsing rejects malformed, oversized, non-object, and control-field bodies", async () => {
  const oversized = JSON.stringify({
    name: "Finance",
    description: "x".repeat(16 * 1024),
  });
  const invalidBodies = [
    { body: undefined },
    { body: "" },
    { body: "{" },
    { body: "null" },
    { body: "[]" },
    { body: JSON.stringify({ name: "Finance", role: "admin" }) },
    { body: JSON.stringify({ name: "Finance", requestId: "spoofed" }) },
    { body: oversized },
    { body: "not canonical base64 ***", isBase64Encoded: true },
  ];

  for (const [index, bodyOptions] of invalidBodies.entries()) {
    const { calls, handler, logs } = await harness();
    const requestId = `invalid-body-${index}`;
    const response = await handler(request(
      "POST",
      "/api/domain-create",
      {
        ...bodyOptions,
        claims: accessClaims(["platform-admin"]),
        requestId,
      },
    ));
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "INVALID_BODY",
      message: "Request body is invalid.",
      requestId,
      retryable: false,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
  }
});

test("invalid explicit request IDs fail validation instead of falling back", async () => {
  const { calls, handler } = await harness();
  for (const value of ["", " request ", "x".repeat(129), 123]) {
    const response = await handler(request("GET", "/api/domains", {
      claims: accessClaims(["platform-admin"]),
      headers: { "x-request-id": value },
      requestId: "gateway-fallback",
    }));
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code: "INVALID_REQUEST_ID",
      message: "Request ID is invalid.",
      requestId: "gateway-fallback",
      retryable: false,
    });
  }
  assert.deepEqual(calls, []);
});

test("missing or malformed API Gateway request IDs use trusted correlations for reads", async () => {
  const correlationIds = [
    "correlation-1",
    "correlation-2",
    "correlation-3",
  ];
  const { calls, handler } = await harness({
    correlationIdFactory: () => correlationIds.shift(),
  });
  const observedIds = [];
  for (const gatewayRequestId of [undefined, "", " request "]) {
    const event = request("GET", "/api/domains", {
      claims: accessClaims(["platform-admin"]),
      requestId: gatewayRequestId,
    });
    if (gatewayRequestId === undefined) {
      delete event.requestContext.requestId;
    }
    const response = await handler(event);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      ok: true,
      domains: [],
      requestId: `correlation-${observedIds.length + 1}`,
    });
    observedIds.push(JSON.parse(response.body).requestId);
  }
  assert.equal(new Set(observedIds).size, 3);
  assert.equal(observedIds.includes("unknown"), false);
  assert.deepEqual(
    calls.map(({ scope }) => scope.requestId),
    observedIds,
  );
});

test("invalid gateway request IDs use the trusted Lambda context correlation ID for reads", async () => {
  const { calls, handler } = await harness({
    correlationIdFactory: () => "factory-must-not-be-used",
  });
  const event = request("GET", "/api/domains", {
    claims: accessClaims(["platform-admin"]),
    requestId: "",
  });

  const response = await handler(event, {
    awsRequestId: "lambda-context-request-123",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    JSON.parse(response.body).requestId,
    "lambda-context-request-123",
  );
  assert.deepEqual(calls.map(({ method }) => method), ["listDomains"]);
});

test("real API Gateway request IDs fall back to the trusted Lambda correlation ID for reads", async () => {
  const { calls, handler } = await harness({
    correlationIdFactory: () => "factory-must-not-be-used",
  });
  const response = await handler(request("GET", "/api/domains", {
    claims: accessClaims(["platform-admin"]),
    requestId: "CkTywi19PHcEJlA=",
  }), {
    awsRequestId: "lambda-context-request-456",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    JSON.parse(response.body).requestId,
    "lambda-context-request-456",
  );
  assert.deepEqual(calls.map(({ method }) => method), ["listDomains"]);
});

test("configured handler service rejects non-commercial AWS regions", async () => {
  const module = await import("../lambda/platform-admin/index.mjs");
  assert.equal(
    typeof module.createConfiguredPlatformAdminService,
    "function",
  );
  const previous = {
    AWS_REGION: process.env.AWS_REGION,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    MANDATORY_TAGS_JSON: process.env.MANDATORY_TAGS_JSON,
    PLATFORM_ACCOUNT_ID: process.env.PLATFORM_ACCOUNT_ID,
    PLATFORM_STATE_TABLE_NAME: process.env.PLATFORM_STATE_TABLE_NAME,
  };
  Object.assign(process.env, {
    COGNITO_USER_POOL_ID: "us-west-2_Example123",
    MANDATORY_TAGS_JSON: JSON.stringify({
      "auto-delete": "no",
      project: "agentic-ai-platform-demo",
      managedBy: "cdk",
    }),
    PLATFORM_ACCOUNT_ID: "111122223333",
    PLATFORM_STATE_TABLE_NAME: "PlatformState",
  });
  try {
    for (const region of [
      "cn-north-1",
      "us-gov-west-1",
      "us-iso-east-1",
      "us-isob-east-1",
      "eu-isoe-west-1",
      "us-isof-south-1",
      "eusc-de-east-1",
    ]) {
      process.env.AWS_REGION = region;
      assert.throws(
        () => module.createConfiguredPlatformAdminService(),
        /configuration is unavailable/i,
        region,
      );
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("configured Platform Admin rejects missing or non-commercial Cognito pools", async () => {
  const module = await import("../lambda/platform-admin/index.mjs");
  const previous = {
    AWS_REGION: process.env.AWS_REGION,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    MANDATORY_TAGS_JSON: process.env.MANDATORY_TAGS_JSON,
    PLATFORM_ACCOUNT_ID: process.env.PLATFORM_ACCOUNT_ID,
    PLATFORM_STATE_TABLE_NAME: process.env.PLATFORM_STATE_TABLE_NAME,
    REGISTRY_DECISION_FINALIZER_FUNCTION_NAME:
      process.env.REGISTRY_DECISION_FINALIZER_FUNCTION_NAME,
    REGISTRY_INVENTORY_CONFIG: process.env.REGISTRY_INVENTORY_CONFIG,
  };
  Object.assign(process.env, {
    AWS_REGION: "us-west-2",
    MANDATORY_TAGS_JSON: JSON.stringify({
      "auto-delete": "no",
      project: "agentic-ai-platform-demo",
      managedBy: "cdk",
    }),
    PLATFORM_ACCOUNT_ID: "111122223333",
    PLATFORM_STATE_TABLE_NAME: "PlatformState",
    REGISTRY_DECISION_FINALIZER_FUNCTION_NAME:
      "AgenticPlatform-Web-RegistryDecisionFinalizer",
    REGISTRY_INVENTORY_CONFIG: JSON.stringify({
      accountId: "111122223333",
      region: "us-west-2",
      sharedRegistryId: "SharedReg12345",
      domainRegistryIds: {
        platform: "PlatReg123456",
        customer_support: "CustReg123456",
        operations: "OperReg123456",
      },
    }),
  });

  try {
    for (const userPoolId of [
      undefined,
      "",
      "pool-id",
      "us-gov-west-1_Example123",
      "cn-north-1_Example123",
    ]) {
      if (userPoolId === undefined) {
        delete process.env.COGNITO_USER_POOL_ID;
      } else {
        process.env.COGNITO_USER_POOL_ID = userPoolId;
      }
      assert.throws(
        () => module.createConfiguredPlatformAdminService(),
        /configuration is unavailable/i,
        String(userPoolId),
      );
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("configured Platform Admin needs only Registry inventory configuration", async () => {
  const module = await import("../lambda/platform-admin/index.mjs");
  const previous = {
    AWS_REGION: process.env.AWS_REGION,
    COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
    CONTROL_PLANE_CONFIG: process.env.CONTROL_PLANE_CONFIG,
    MANDATORY_TAGS_JSON: process.env.MANDATORY_TAGS_JSON,
    PLATFORM_ACCOUNT_ID: process.env.PLATFORM_ACCOUNT_ID,
    PLATFORM_STATE_TABLE_NAME: process.env.PLATFORM_STATE_TABLE_NAME,
    REGISTRY_DECISION_FINALIZER_FUNCTION_NAME:
      process.env.REGISTRY_DECISION_FINALIZER_FUNCTION_NAME,
    REGISTRY_INVENTORY_CONFIG: process.env.REGISTRY_INVENTORY_CONFIG,
  };
  Object.assign(process.env, {
    AWS_REGION: "us-west-2",
    COGNITO_USER_POOL_ID: "us-west-2_Example123",
    MANDATORY_TAGS_JSON: JSON.stringify({
      "auto-delete": "no",
      project: "agentic-ai-platform-demo",
      managedBy: "cdk",
    }),
    PLATFORM_ACCOUNT_ID: "111122223333",
    PLATFORM_STATE_TABLE_NAME: "PlatformState",
    REGISTRY_DECISION_FINALIZER_FUNCTION_NAME:
      "AgenticPlatform-Web-RegistryDecisionFinalizer",
    REGISTRY_INVENTORY_CONFIG: JSON.stringify({
      accountId: "111122223333",
      region: "us-west-2",
      sharedRegistryId: "SharedReg12345",
      domainRegistryIds: {
        platform: "PlatReg123456",
        customer_support: "CustReg123456",
        operations: "OperReg123456",
      },
    }),
  });
  delete process.env.CONTROL_PLANE_CONFIG;

  try {
    const service = module.createConfiguredPlatformAdminService();
    assert.equal(typeof service.decideRegistryVersion, "function");
    assert.equal(typeof service.createDomain, "function");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("known service errors preserve stable status families and request IDs", async () => {
  const cases = [
    ["INVALID_DOMAIN", "Domain details are invalid.", 400, false],
    ["FORBIDDEN", "Platform administrator access is required.", 403, false],
    ["DOMAIN_CONFLICT", "A domain with this ID already exists.", 409, false],
    [
      "IDEMPOTENCY_CONFLICT",
      "The request result could not be reconciled.",
      409,
      false,
    ],
    [
      "DOMAIN_PROVISIONING_FAILED",
      "Domain provisioning is temporarily unavailable.",
      503,
      true,
    ],
  ];

  for (const [code, message, statusCode, retryable] of cases) {
    const mutationError = [
      "INVALID_DOMAIN",
      "IDEMPOTENCY_CONFLICT",
    ].includes(code);
    const { handler, logs } = await harness({
      serviceError: new PlatformAdminServiceError(message, {
        code,
        statusCode,
        retryable,
      }),
    });
    const response = await handler(request(
      mutationError ? "POST" : "GET",
      mutationError
        ? "/api/domain-create"
        : "/api/domains",
      {
        body: mutationError
          ? JSON.stringify({ name: "Finance" })
          : undefined,
        claims: accessClaims(["platform-admin"]),
        requestId: `service-${code}`,
      },
    ));
    assert.equal(response.statusCode, statusCode);
    assert.deepEqual(JSON.parse(response.body), {
      ok: false,
      code,
      message,
      requestId: `service-${code}`,
      retryable,
    });
    assert.deepEqual(
      logs,
      statusCode === 503
        ? [{
            event: "platform_admin_request_failed",
            code,
            requestId: `service-${code}`,
          }]
        : [],
    );
  }
});

test("forged request-result corruption strings return a sanitized unavailable response", async () => {
  const secretError = Object.assign(
    new Error("TOP-SECRET Registry failure"),
    {
      name: "MalformedRequestResultItemError",
      code: "MALFORMED_REQUEST_RESULT_ITEM",
      credentials: { secretAccessKey: "TOP-SECRET" },
    },
  );
  const { handler, logs } = await harness({ serviceError: secretError });
  const response = await handler(request("GET", "/api/domains", {
    claims: accessClaims(["platform-admin"]),
    requestId: "unknown-failure",
  }));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    code: "PLATFORM_ADMIN_UNAVAILABLE",
    message: "Platform administration is temporarily unavailable.",
    requestId: "unknown-failure",
    retryable: true,
  });
  assert.doesNotMatch(response.body, /TOP-SECRET|credentials|stack/i);
  assert.deepEqual(logs, [{
    event: "platform_admin_request_failed",
    code: "PLATFORM_ADMIN_UNAVAILABLE",
    requestId: "unknown-failure",
  }]);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /TOP-SECRET|credentials|stack|message/i,
  );
});

test("the handler lazily creates its configured service once", async () => {
  const module = await import("../lambda/platform-admin/index.mjs");
  const calls = [];
  const serviceFactory = () => {
    calls.push("factory");
    return {
      async listDomains(scope) {
        calls.push(structuredClone(scope));
        return { ok: true, domains: [] };
      },
    };
  };
  const handler = module.createPlatformAdminHandler({ serviceFactory });

  for (const requestId of ["factory-1", "factory-2"]) {
    const response = await handler(request("GET", "/api/domains", {
      claims: accessClaims(["platform-admin"]),
      requestId,
    }));
    assert.equal(response.statusCode, 200);
  }
  assert.equal(calls.filter((entry) => entry === "factory").length, 1);
});

test("demo operator domain journeys enforce all, selected, and empty projections", async () => {
  const listResult = {
    ok: true,
    domains: ACTIVE_DOMAINS,
  };
  for (const [role, domain, expectedIds] of [
    ["admin", null, ["platform", "customer_support", "operations"]],
    ["admin", "operations", ["operations"]],
    ["lead", "operations", ["operations"]],
    ["builder", "customer_support", ["customer_support"]],
    ["user", null, []],
  ]) {
    const { calls, handler } = await harness({ listResult });
    const headers = {
      "x-demo-role": role,
      ...(domain ? { "x-active-domain": domain } : {}),
    };
    const requestId = `domains-${role}-${domain || "all"}`;
    const response = await handler(request("GET", "/api/domains", {
      claims: operatorClaims(),
      headers,
      requestId,
    }));

    assert.equal(response.statusCode, 200, `${role}/${domain}`);
    assert.deepEqual(
      JSON.parse(response.body).domains.map(({ id }) => id),
      expectedIds,
    );
    const listCall = calls.find(({ method }) => method === "listDomains");
    assert.deepEqual(
      listCall?.scope,
      effectiveScope(operatorClaims(), headers, requestId),
    );
    if (domain) {
      assert.deepEqual(calls[0], { method: "listActiveDomains" });
    }
  }
});

test("demo Lead, Builder, and End User cannot mutate platform administration", async () => {
  for (const [role, domain] of [
    ["lead", "operations"],
    ["builder", "operations"],
    ["user", null],
  ]) {
    for (const [path, body] of [
      ["/api/domain-create", { name: "Finance" }],
      ["/api/registry-decide", {
        id: "customer-support-blueprint",
        semver: "1.0.0",
        decision: "approve",
        reason: "",
      }],
    ]) {
      const { calls, handler } = await harness();
      const headers = {
        "x-request-id": `${role}-mutation`,
        "x-demo-role": role,
        ...(domain ? { "x-active-domain": domain } : {}),
      };
      const response = await handler(request("POST", path, {
        body: JSON.stringify(body),
        claims: operatorClaims(),
        headers,
        requestId: `${role}-mutation`,
      }));

      assert.equal(response.statusCode, 403);
      assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
      assert.deepEqual(calls, []);
    }
  }
});

test("forbidden mutations beat body parsing, service, and domain-state outages", async () => {
  const calls = [];
  const module = await import("../lambda/platform-admin/index.mjs");
  const handler = module.createPlatformAdminHandler({
    demoOperatorVerifier: async () => true,
    serviceFactory() {
      calls.push("factory");
      throw new Error("TOP-SECRET service outage");
    },
  });
  let bodyReads = 0;

  for (const [role, domain] of [
    ["lead", "operations"],
    ["builder", "operations"],
    ["user", null],
  ]) {
    for (const path of ["/api/domain-create", "/api/registry-decide"]) {
      const requestId = `forbidden-${role}-${path.split("-").at(-1)}`;
      const event = request("POST", path, {
        claims: operatorClaims(),
        headers: {
          "x-request-id": requestId,
          "x-demo-role": role,
          ...(domain ? { "x-active-domain": domain } : {}),
        },
        requestId,
      });
      Object.defineProperty(event, "body", {
        configurable: true,
        get() {
          bodyReads += 1;
          return "{";
        },
      });

      const response = await handler(event);

      assert.equal(response.statusCode, 403);
      assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
    }
  }
  assert.equal(bodyReads, 0);
  assert.deepEqual(calls, []);
});

test("demo Admin mutation preserves Cognito actor and effective metadata", async () => {
  const { calls, handler } = await harness();
  const input = { name: "Finance" };
  const headers = {
    "x-request-id": "assumed-admin-create",
    "x-demo-role": "admin",
  };
  const response = await handler(request("POST", "/api/domain-create", {
    body: JSON.stringify(input),
    claims: operatorClaims({ sub: "immutable-operator-sub" }),
    headers,
    requestId: "gateway-request-ignored",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{
    method: "createDomain",
    scope: effectiveScope(
      operatorClaims({ sub: "immutable-operator-sub" }),
      headers,
      "assumed-admin-create",
    ),
    input,
  }]);
  assert.equal(calls[0].scope.actor, "immutable-operator-sub");
  assert.equal(calls[0].scope.assumedRole, "admin");
});

test("forged demo roles fail before platform service construction", async () => {
  const calls = [];
  const module = await import("../lambda/platform-admin/index.mjs");
  const handler = module.createPlatformAdminHandler({
    serviceFactory() {
      calls.push("factory");
      return {};
    },
  });
  const response = await handler(request("GET", "/api/domains", {
    claims: accessClaims(["end-user"]),
    headers: { "x-demo-role": "admin" },
    requestId: "forged-admin",
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.deepEqual(calls, []);
});

test("forbidden mutations beat reserved or unavailable demo domains", async () => {
  for (const domain of ["platform", "finance"]) {
    const { calls, handler } = await harness();
    const response = await handler(request("POST", "/api/domain-create", {
      body: "{",
      claims: operatorClaims(),
      headers: {
        "x-request-id": `invalid-domain-${domain}`,
        "x-demo-role": "builder",
        "x-active-domain": domain,
      },
      requestId: `invalid-domain-${domain}`,
    }));

    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
    assert.deepEqual(calls, []);
  }
});

test("demo domain state failures map to the stable context error", async () => {
  const { calls, handler } = await harness({
    activeDomainsError: new Error("TOP-SECRET state failure"),
  });
  const response = await handler(request("GET", "/api/domains", {
    claims: operatorClaims(),
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "operations",
    },
    requestId: "domain-state-failure",
  }));

  assert.equal(response.statusCode, 503);
  assert.equal(
    JSON.parse(response.body).code,
    "DEMO_CONTEXT_UNAVAILABLE",
  );
  assert.doesNotMatch(response.body, /TOP-SECRET/);
  assert.deepEqual(calls, [{ method: "listActiveDomains" }]);
});

test("platform-admin routes deny stale demo-role claims before service access", async () => {
  const module = await import("../lambda/platform-admin/index.mjs");
  const verifierCalls = [];
  const serviceCalls = [];
  const handler = module.createPlatformAdminHandler({
    demoOperatorVerifier: async (claims) => {
      verifierCalls.push(claims);
      return false;
    },
    service: {
      async listActiveDomains() {
        serviceCalls.push("listActiveDomains");
        return ACTIVE_DOMAINS;
      },
      async listDomains() {
        serviceCalls.push("listDomains");
        return { ok: true, domains: [] };
      },
    },
  });
  const claims = operatorClaims();
  const response = await handler(request("GET", "/api/domains", {
    claims,
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "operations",
    },
    requestId: "revoked-platform-admin-operator",
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.deepEqual(verifierCalls, [claims]);
  assert.deepEqual(serviceCalls, []);
});
