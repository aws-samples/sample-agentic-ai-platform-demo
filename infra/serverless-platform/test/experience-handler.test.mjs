import assert from "node:assert/strict";
import test from "node:test";
import {
  createExperienceHandler,
} from "../lambda/experience/index.mjs";
import {
  ExperienceServiceError,
} from "../lambda/experience/service.mjs";

const CLAIMS = Object.freeze({
  sub: "operator-sub",
  username: "operator-user",
  token_use: "access",
  "cognito:groups": ["platform-admin", "demo-operator"],
});
const END_USER_CLAIMS = Object.freeze({
  sub: "end-user-sub",
  username: "end-user",
  token_use: "access",
  "cognito:groups": ["end-user"],
});
const AGENT_ID = "agent-0123456789abcdef0123456789abcdef";
const SESSION_ID = "session-0123456789abcdef-abcdef0123456789";

function event({
  routeKey = "GET /api/experience/agents",
  method = routeKey.split(" ")[0],
  path = routeKey.split(" ")[1],
  claims = END_USER_CLAIMS,
  headers,
  queryStringParameters,
  rawQueryString,
  body,
  isBase64Encoded = false,
  requestId = "api-request-123",
} = {}) {
  return {
    version: "2.0",
    routeKey,
    headers,
    queryStringParameters,
    rawQueryString,
    body,
    isBase64Encoded,
    requestContext: {
      requestId,
      http: { method, path },
      authorizer: { jwt: { claims } },
    },
  };
}

function postEvent(routeKey, body, {
  claims = END_USER_CLAIMS,
  role,
  domain,
  requestId = "mutation-request-123",
  extraHeaders = {},
} = {}) {
  return event({
    routeKey,
    claims,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...(role === undefined ? {} : { "x-demo-role": role }),
      ...(domain === undefined
        ? {}
        : { "x-active-domain": domain }),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function projector() {
  return {
    projectAuthenticated(claims) {
      return {
        actor: claims.sub,
        role: claims["cognito:groups"]?.includes("end-user")
          ? "user"
          : "admin",
      };
    },
    projectEffective(claims, headers) {
      return {
        actor: claims.sub,
        role: headers?.["x-demo-role"] || (
          claims["cognito:groups"]?.includes("end-user")
            ? "user"
            : "admin"
        ),
        domain: headers?.["x-active-domain"] ?? null,
        domains: [],
      };
    },
  };
}

function handlerWith({
  identityProjector = projector(),
  identityVerifier = async () => true,
  groupDirectory,
  domainDirectory,
  service,
} = {}) {
  const calls = [];
  const experienceService = {
    async listAgents(input) {
      calls.push(["agents", structuredClone(input)]);
      return {
        items: [{
          id: AGENT_ID,
          name: "Triage Agent",
          description: "Helps classify customer support requests.",
        }],
      };
    },
    async invoke(input) {
      calls.push(["invoke", structuredClone(input)]);
      return {
        sessionId: SESSION_ID,
        status: "SUCCEEDED",
        output: "The request is an account-access issue.",
        invocationId: "runtime-invocation-123",
        replayed: false,
      };
    },
    async listSessions(input) {
      calls.push(["sessions", structuredClone(input)]);
      return {
        items: [{
          id: SESSION_ID,
          agentId: AGENT_ID,
          status: "ACTIVE",
          lastInvocationStatus: "SUCCEEDED",
          createdAt: "2026-08-25T05:00:00.000Z",
          updatedAt: "2026-08-25T05:00:00.000Z",
        }],
      };
    },
    async listAccessRequests(input) {
      calls.push(["accessRequests", structuredClone(input)]);
      return {
        items: [{
          id: "access-0123456789abcdef0123456789abcdef",
          domainId: "customer_support",
          agentId: AGENT_ID,
          status: "PENDING",
          reason: "Required for customer support duties.",
          requestedAt: "2026-08-25T05:00:00.000Z",
          decidedAt: null,
        }],
      };
    },
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
    ...service,
  };
  return {
    calls,
    handler: createExperienceHandler({
      identityProjector,
      identityVerifier,
      groupDirectory: groupDirectory || {
        async resolveCurrentGroups(claims) {
          return claims["cognito:groups"] || [];
        },
      },
      domainDirectory: domainDirectory || {
        async listActiveDomains(input) {
          calls.push(["domains", input]);
          return [
            { id: "customer_support" },
            { id: "operations" },
          ];
        },
      },
      experienceService,
    }),
  };
}

function parsed(response) {
  return JSON.parse(response.body);
}

const STABLE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});

test("handler requires identity, domain directory, and complete experience service dependencies", () => {
  assert.throws(
    () => createExperienceHandler(),
    /configuration is invalid/i,
  );
  assert.throws(
    () => createExperienceHandler({
      identityProjector: projector(),
      identityVerifier: async () => true,
      groupDirectory: { resolveCurrentGroups: async () => [] },
      domainDirectory: { listActiveDomains: async () => [] },
      experienceService: { listAgents: async () => ({ items: [] }) },
    }),
    /configuration is invalid/i,
  );
});

test("only Cognito access-token subjects reach experience dependencies", async () => {
  const { calls, handler } = handlerWith();
  for (const claims of [
    null,
    { sub: "end-user-sub", token_use: "id" },
    { sub: "", token_use: "access" },
    { token_use: "access" },
  ]) {
    const response = await handler(event({ claims }));
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.headers, STABLE_HEADERS);
    assert.equal(parsed(response).code, "NOT_AUTHENTICATED");
  }
  assert.deepEqual(calls, []);
});

test("the three GET routes use the immutable Cognito actor and expose no-store responses", async () => {
  for (const [routeKey, operation] of [
    ["GET /api/experience/agents", "agents"],
    ["GET /api/experience/sessions", "sessions"],
    ["GET /api/experience/access-requests", "accessRequests"],
  ]) {
    const { calls, handler } = handlerWith();
    const response = await handler(event({ routeKey }));

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.headers, STABLE_HEADERS);
    assert.equal(parsed(response).ok, true);
    const call = calls.find(([name]) => name === operation);
    assert.deepEqual(call[1], {
      identity: {
        actor: "end-user-sub",
        role: "user",
        activeDomain: null,
        domainIds: [],
        authenticatedGroups: ["end-user"],
        authenticatedDomains: [],
      },
    });
  }
});

test("agent catalog returns a separately validated requestable projection", async () => {
  const requestable = {
    id: "agent-0123456789abcdef0123456789abcdef",
    domainId: "operations",
    name: "Claims Agent",
    description: "Helps classify claims.",
  };
  const { handler } = handlerWith({
    service: {
      async listAgents() {
        return {
          items: [{
            id: AGENT_ID,
            name: "Triage Agent",
            description: "Helps classify customer support requests.",
          }],
          requestableItems: [requestable],
        };
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(parsed(response), {
    ok: true,
    items: [{
      id: AGENT_ID,
      name: "Triage Agent",
      description: "Helps classify customer support requests.",
    }],
    requestableItems: [requestable],
  });
});

test("agent catalog rejects unsafe requestable metadata", async () => {
  const { handler } = handlerWith({
    service: {
      async listAgents() {
        return {
          items: [],
          requestableItems: [{
            id: "agent-0123456789abcdef0123456789abcdef",
            domainId: "operations",
            name: "Claims Agent",
            description: "Helps classify claims.",
            modelId: "must-not-leak",
          }],
        };
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 503);
  assert.equal(parsed(response).code, "EXPERIENCE_UNAVAILABLE");
});

test("authenticated Cognito groups and domain groups reach Experience independently of the effective role", async () => {
  const claims = {
    sub: "entitled-user-sub",
    username: "entitled-user",
    token_use: "access",
    "cognito:groups": [
      "end-user",
      "support-users",
      "domain-operations",
    ],
  };
  const { calls, handler } = handlerWith();

  const response = await handler(event({ claims }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    calls.find(([name]) => name === "agents")[1].identity,
    {
      actor: "entitled-user-sub",
      role: "user",
      activeDomain: null,
      domainIds: [],
      authenticatedGroups: [
        "end-user",
        "support-users",
        "domain-operations",
      ],
      authenticatedDomains: ["operations"],
    },
  );
});

test("inactive domain groups do not become entitlement domains", async () => {
  const claims = {
    sub: "entitled-user-sub",
    username: "entitled-user",
    token_use: "access",
    "cognito:groups": [
      "end-user",
      "domain-retired",
    ],
  };
  const { calls, handler } = handlerWith({
    domainDirectory: {
      async listActiveDomains() {
        return [{ id: "operations" }];
      },
    },
  });

  const response = await handler(event({ claims }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    calls.find(([name]) => name === "agents")[1].identity
      .authenticatedDomains,
    [],
  );
});

test("a verified demo operator can switch to End User without changing actor", async () => {
  let verifierCalls = 0;
  const { calls, handler } = handlerWith({
    identityVerifier: async (claims) => {
      verifierCalls += 1;
      assert.equal(claims.sub, "operator-sub");
      return true;
    },
  });

  const response = await handler(event({
    claims: CLAIMS,
    headers: { "x-demo-role": "user" },
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(verifierCalls, 1);
  assert.equal(
    calls.find(([name]) => name === "agents")[1].identity.actor,
    "operator-sub",
  );
  assert.deepEqual(
    calls.find(([name]) => name === "agents")[1].identity
      .authenticatedGroups,
    ["platform-admin", "demo-operator"],
  );
});

test("live Cognito membership overrides stale token group claims", async () => {
  const { calls, handler } = handlerWith({
    groupDirectory: {
      async resolveCurrentGroups() {
        return ["end-user"];
      },
    },
  });

  const response = await handler(event({
    claims: {
      sub: "entitled-user-sub",
      username: "entitled-user",
      token_use: "access",
      "cognito:groups": [
        "end-user",
        "support-users",
        "domain-operations",
      ],
    },
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    calls.find(([name]) => name === "agents")[1].identity,
    {
      actor: "entitled-user-sub",
      role: "user",
      activeDomain: null,
      domainIds: [],
      authenticatedGroups: ["end-user"],
      authenticatedDomains: [],
    },
  );
});

test("unavailable live Cognito membership fails closed before state access", async () => {
  const { calls, handler } = handlerWith({
    groupDirectory: {
      async resolveCurrentGroups() {
        throw new Error("private Cognito transport detail");
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 503);
  assert.equal(parsed(response).code, "IDENTITY_UNAVAILABLE");
  assert.equal(
    calls.some(([name]) => ["agents", "domains"].includes(name)),
    false,
  );
  assert.equal(response.body.includes("private Cognito"), false);
});

test("non-user roles and End User domain headers are denied before state access", async () => {
  for (const headers of [
    undefined,
    { "x-demo-role": "admin" },
    {
      "x-demo-role": "user",
      "x-active-domain": "customer_support",
    },
  ]) {
    const claims = headers === undefined ? CLAIMS : CLAIMS;
    const { calls, handler } = handlerWith();
    const response = await handler(event({ claims, headers }));
    assert.equal(response.statusCode, 403);
    assert.equal(parsed(response).code, "FORBIDDEN");
    assert.equal(
      calls.some(([name]) =>
        ["agents", "sessions"].includes(name)),
      false,
    );
  }
});

test("demo switching requires verifier approval and a valid effective projection", async () => {
  const denied = handlerWith({
    identityVerifier: async () => false,
  });
  const deniedResponse = await denied.handler(event({
    claims: CLAIMS,
    headers: { "x-demo-role": "user" },
  }));
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(parsed(deniedResponse).code, "DEMO_ROLE_NOT_ALLOWED");

  const mismatched = handlerWith({
    identityProjector: {
      ...projector(),
      projectEffective() {
        return {
          actor: "forged-sub",
          role: "user",
          domain: null,
          domains: [],
        };
      },
    },
  });
  const mismatchResponse = await mismatched.handler(event());
  assert.equal(mismatchResponse.statusCode, 503);
  assert.equal(parsed(mismatchResponse).code, "IDENTITY_UNAVAILABLE");
});

test("effective projection fields cannot forge entitlement groups or domains", async () => {
  const { calls, handler } = handlerWith({
    identityProjector: {
      ...projector(),
      projectEffective(claims) {
        return {
          actor: claims.sub,
          role: "user",
          domain: null,
          domains: ["customer_support"],
          groups: ["forged-group", "domain-customer-support"],
        };
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    calls.find(([name]) => name === "agents")[1].identity,
    {
      actor: "end-user-sub",
      role: "user",
      activeDomain: null,
      domainIds: [],
      authenticatedGroups: ["end-user"],
      authenticatedDomains: [],
    },
  );
});

test("malformed or unbounded authenticated group claims fail closed", async () => {
  for (const groups of [
    ["end-user", "invalid group"],
    Array.from({ length: 33 }, (_, index) => `group-${index}`),
  ]) {
    const { calls, handler } = handlerWith();
    const response = await handler(event({
      claims: {
        sub: "end-user-sub",
        username: "end-user",
        token_use: "access",
        "cognito:groups": groups,
      },
    }));

    assert.equal(response.statusCode, 503);
    assert.equal(parsed(response).code, "IDENTITY_UNAVAILABLE");
    assert.equal(
      calls.some(([name]) => name === "agents"),
      false,
    );
  }
});

test("route keys, methods, paths, bodies, and queries must match the seven exact routes", async () => {
  const { calls, handler } = handlerWith();
  const invalid = [
    event({ routeKey: "GET /api/experience/unknown" }),
    event({
      routeKey: "GET /api/experience/agents",
      method: "POST",
    }),
    event({
      routeKey: "GET /api/experience/agents",
      path: "/api/experience/sessions",
    }),
    event({
      routeKey: "GET /api/experience/agents",
      body: "{}",
    }),
    event({
      routeKey: "GET /api/experience/agents",
      queryStringParameters: { actor: "forged-sub" },
      rawQueryString: "actor=forged-sub",
    }),
  ];
  const expectedCodes = [
    "ROUTE_NOT_FOUND",
    "ROUTE_NOT_FOUND",
    "ROUTE_NOT_FOUND",
    "INVALID_REQUEST",
    "INVALID_REQUEST",
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    const response = await handler(invalid[index]);
    assert.equal(parsed(response).code, expectedCodes[index]);
  }
  assert.equal(
    calls.some(([name]) =>
      ["agents", "invoke", "sessions"].includes(name)),
    false,
  );
});

test("invocation route accepts only the bounded end-user request shape", async () => {
  const { calls, handler } = handlerWith();
  const response = await handler(postEvent(
    "POST /api/experience/invocations",
    {
      agentId: AGENT_ID,
      prompt: "I cannot access my account.",
      sessionId: SESSION_ID,
    },
  ));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, STABLE_HEADERS);
  assert.deepEqual(
    calls.find(([name]) => name === "invoke")[1],
    {
      identity: {
        actor: "end-user-sub",
        role: "user",
        activeDomain: null,
        domainIds: [],
        authenticatedGroups: ["end-user"],
        authenticatedDomains: [],
      },
      requestId: "mutation-request-123",
      agentId: AGENT_ID,
      prompt: "I cannot access my account.",
      sessionId: SESSION_ID,
    },
  );
  assert.deepEqual(parsed(response), {
    ok: true,
    sessionId: SESSION_ID,
    status: "SUCCEEDED",
    output: "The request is an account-access issue.",
    invocationId: "runtime-invocation-123",
    replayed: false,
  });
});

test("feedback, issue, and access-request routes dispatch strict actor-free bodies", async () => {
  const scenarios = [
    {
      routeKey: "POST /api/experience/feedback",
      operation: "feedback",
      body: {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        rating: 4,
        comment: "Useful response.",
      },
    },
    {
      routeKey: "POST /api/experience/issues",
      operation: "issue",
      body: {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        description: "The escalation path was missing.",
      },
    },
    {
      routeKey: "POST /api/experience/access-requests",
      operation: "access",
      body: {
        domainId: "customer_support",
        agentId: AGENT_ID,
        reason: "Required for customer support duties.",
      },
    },
  ];
  for (const scenario of scenarios) {
    const { calls, handler } = handlerWith();
    const response = await handler(postEvent(
      scenario.routeKey,
      scenario.body,
    ));
    assert.equal(response.statusCode, 201);
    const input = calls.find(
      ([name]) => name === scenario.operation,
    )[1];
    assert.equal(input.identity.actor, "end-user-sub");
    assert.equal(input.requestId, "mutation-request-123");
    assert.equal(Object.hasOwn(input, "actor"), false);
    assert.equal(
      Object.hasOwn(input, "domainId"),
      scenario.operation === "access",
    );
  }
});

test("POST routes reject missing request IDs, wrong content types, oversized bodies, and forged fields", async () => {
  const { calls, handler } = handlerWith();
  const validBody = {
    agentId: AGENT_ID,
    prompt: "Hello",
  };
  const missingId = await handler(event({
    routeKey: "POST /api/experience/invocations",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  }));
  const wrongType = await handler(event({
    routeKey: "POST /api/experience/invocations",
    headers: {
      "content-type": "text/plain",
      "x-request-id": "request-123",
    },
    body: JSON.stringify(validBody),
  }));
  const oversized = await handler(event({
    routeKey: "POST /api/experience/invocations",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-123",
    },
    body: JSON.stringify({
      agentId: AGENT_ID,
      prompt: "x".repeat(65_536),
    }),
  }));
  const forged = await handler(postEvent(
    "POST /api/experience/invocations",
    {
      ...validBody,
      actor: "forged-sub",
      domainId: "finance",
      runtimeUrl: "https://attacker.example",
    },
  ));

  assert.equal(parsed(missingId).code, "INVALID_REQUEST_ID");
  assert.equal(parsed(wrongType).code, "INVALID_BODY");
  assert.equal(parsed(oversized).code, "INVALID_BODY");
  assert.equal(parsed(forged).code, "INVALID_BODY");
  assert.equal(calls.some(([name]) => name === "invoke"), false);
});

test("duplicate case-insensitive trust headers and invalid base64 fail closed", async () => {
  const { calls, handler } = handlerWith();
  const duplicate = await handler(event({
    routeKey: "POST /api/experience/invocations",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-123",
      "X-Request-Id": "request-456",
    },
    body: JSON.stringify({ agentId: AGENT_ID, prompt: "Hello" }),
  }));
  const invalidBase64 = await handler(event({
    routeKey: "POST /api/experience/invocations",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-123",
    },
    body: "not-base64",
    isBase64Encoded: true,
  }));

  assert.equal(parsed(duplicate).code, "INVALID_REQUEST_ID");
  assert.equal(parsed(invalidBase64).code, "INVALID_BODY");
  assert.equal(calls.some(([name]) => name === "invoke"), false);
});

test("known service errors and unexpected failures are sanitized", async () => {
  const forbidden = handlerWith({
    service: {
      async listAgents() {
        throw new ExperienceServiceError("NOT_FOUND");
      },
    },
  });
  const unavailable = handlerWith({
    service: {
      async listAgents() {
        throw new Error("secret database endpoint");
      },
    },
  });
  const indeterminate = handlerWith({
    service: {
      async invoke() {
        throw new ExperienceServiceError(
          "INVOCATION_OUTCOME_UNKNOWN",
        );
      },
    },
  });

  const missing = await forbidden.handler(event());
  const failed = await unavailable.handler(event());
  const unknown = await indeterminate.handler(postEvent(
    "POST /api/experience/invocations",
    { agentId: AGENT_ID, prompt: "Do this once" },
  ));

  assert.equal(missing.statusCode, 404);
  assert.equal(parsed(missing).code, "NOT_FOUND");
  assert.equal(failed.statusCode, 503);
  assert.equal(parsed(failed).code, "EXPERIENCE_UNAVAILABLE");
  assert.equal(failed.body.includes("secret"), false);
  assert.equal(unknown.statusCode, 409);
  assert.equal(
    parsed(unknown).code,
    "INVOCATION_OUTCOME_UNKNOWN",
  );
  assert.equal(parsed(unknown).retryable, false);
});

test("handler validates dependency output before returning it", async () => {
  const { handler } = handlerWith({
    service: {
      async listAgents() {
        return {
          items: [{
            id: AGENT_ID,
            name: "Triage Agent",
            description: "Safe",
            modelId: "must-not-leak",
          }],
        };
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 503);
  assert.equal(parsed(response).code, "EXPERIENCE_UNAVAILABLE");
  assert.equal(response.body.includes("modelId"), false);
});

test("handler rejects unsafe control characters in dependency invocation output", async () => {
  const { handler } = handlerWith({
    service: {
      async invoke() {
        return {
          sessionId: SESSION_ID,
          status: "SUCCEEDED",
          output: "unsafe\u0000output",
          invocationId: "runtime-invocation-123",
          replayed: false,
        };
      },
    },
  });

  const response = await handler(postEvent(
    "POST /api/experience/invocations",
    { agentId: AGENT_ID, prompt: "Hello" },
  ));

  assert.equal(response.statusCode, 503);
  assert.equal(parsed(response).code, "EXPERIENCE_UNAVAILABLE");
  assert.equal(response.body.includes("unsafe"), false);
});
