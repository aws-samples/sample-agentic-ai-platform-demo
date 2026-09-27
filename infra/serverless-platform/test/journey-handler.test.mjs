import assert from "node:assert/strict";
import test from "node:test";
import {
  createJourneyHandler,
} from "../lambda/journeys/index.mjs";
import {
  JourneyServiceError,
} from "../lambda/journeys/service.mjs";

const claims = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:username": "deployment-operator",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

function projector() {
  return {
    projectAuthenticated(requestClaims) {
      return { actor: requestClaims.sub, role: "admin" };
    },
    projectEffective(requestClaims, headers) {
      const role = headers["x-demo-role"] || "admin";
      const domain = headers["x-active-domain"] || null;
      return {
        actor: requestClaims.sub,
        role,
        domain,
        domains: domain ? [domain] : [],
      };
    },
  };
}

function event(options = {}) {
  const {
    routeKey = "POST /api/journeys",
    method = "POST",
    path = "/api/journeys",
    headers = {
      "x-active-domain": "customer_support",
      "x-request-id": "request-1",
    },
    requestClaims = claims,
    requestId = "api-request-1",
    pathParameters,
    queryStringParameters,
    rawQueryString = "",
    isBase64Encoded = false,
  } = options;
  const body = Object.hasOwn(options, "body")
    ? options.body
    : {
        preset: "MINIMAL",
        repositoryName: "support-foundation",
      };
  return {
    version: "2.0",
    routeKey,
    headers,
    pathParameters,
    queryStringParameters,
    rawQueryString,
    isBase64Encoded,
    body: body === undefined
      ? undefined
      : isBase64Encoded
        ? Buffer.from(JSON.stringify(body)).toString("base64")
        : JSON.stringify(body),
    requestContext: {
      requestId,
      http: { method, path },
      authorizer: { jwt: { claims: requestClaims } },
    },
  };
}

function handlerWith({
  identityProjector = projector(),
  identityVerifier = async () => true,
  service,
  serviceOverrides = {},
  applicationRootUrl = "https://platform.example/",
  logSecurityEvent = () => {},
} = {}) {
  const calls = [];
  const journeyService = service || {
    async createJourney(input) {
      calls.push(["createJourney", structuredClone(input)]);
      return { id: "journey-1", preset: input.payload.preset };
    },
    async getJourney(input) {
      calls.push(["getJourney", structuredClone(input)]);
      return { id: input.journeyId, preset: "SPEC" };
    },
    async addMessage(input) {
      calls.push(["addMessage", structuredClone(input)]);
      return { id: input.journeyId, transcript: [] };
    },
    async createContract(input) {
      calls.push(["createContract", structuredClone(input)]);
      return { id: input.journeyId, status: "CONTRACT_READY" };
    },
    async createPreview(input) {
      calls.push(["createPreview", structuredClone(input)]);
      return { id: "delivery-1", manifest: { fingerprint: "a".repeat(64) } };
    },
    async getDelivery(input) {
      calls.push(["getDelivery", structuredClone(input)]);
      return { id: input.deliveryId, status: "PREVIEWED" };
    },
    async getGitHubConnection(input) {
      calls.push(["getGitHubConnection", structuredClone(input)]);
      return {
        configured: true,
        connected: true,
      };
    },
    async startGitHubAuthorization(input) {
      calls.push(["startGitHubAuthorization", structuredClone(input)]);
      return {
        url: "https://github.com/login/oauth/authorize?state=gho_test",
        expiresAt: "2026-08-28T10:00:00.000Z",
      };
    },
    async completeGitHubAuthorization(input) {
      calls.push(["completeGitHubAuthorization", structuredClone(input)]);
      return { id: "delivery-1", status: "COMPLETED" };
    },
    async cancelGitHubAuthorization(input) {
      calls.push(["cancelGitHubAuthorization", structuredClone(input)]);
    },
  };
  Object.assign(journeyService, serviceOverrides);
  return {
    calls,
    handler: createJourneyHandler({
      journeyService,
      identityProjector,
      identityVerifier,
      applicationRootUrl,
      logSecurityEvent,
      domainDirectory: {
        async listActiveDomains() {
          return [
            { id: "platform" },
            { id: "customer_support" },
            { id: "finance" },
          ];
        },
      },
    }),
  };
}

test("multi-domain builders may use the explicitly selected domain", async () => {
  const { calls, handler } = handlerWith({
    identityProjector: {
      projectAuthenticated() {
        return { actor: claims.sub, role: "builder" };
      },
      projectEffective() {
        return {
          actor: claims.sub,
          role: "builder",
          domain: "customer_support",
          domains: ["customer_support", "finance"],
        };
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[0][1].identity, {
    actor: claims.sub,
    role: "builder",
    activeDomain: "customer_support",
    domainIds: ["customer_support", "finance"],
  });
});

function body(response) {
  return JSON.parse(response.body);
}

test("handler requires identity, domain, and service dependencies", () => {
  assert.throws(
    () => createJourneyHandler(),
    /Journey handler configuration is invalid/,
  );
});

test("all eight authenticated routes map exact path, method, body, and identity inputs", async () => {
  const { calls, handler } = handlerWith();
  const cases = [
    {
      event: event(),
      operation: "createJourney",
      status: 201,
    },
    {
      event: event({
        routeKey: "GET /api/journeys/{id}",
        method: "GET",
        path: "/api/journeys/journey-1",
        body: undefined,
        headers: { "x-active-domain": "customer_support" },
        pathParameters: { id: "journey-1" },
      }),
      operation: "getJourney",
      status: 200,
    },
    {
      event: event({
        routeKey: "POST /api/journeys/{id}/messages",
        path: "/api/journeys/journey-1/messages",
        body: { text: "Triage support cases." },
        pathParameters: { id: "journey-1" },
      }),
      operation: "addMessage",
      status: 200,
    },
    {
      event: event({
        routeKey: "POST /api/journeys/{id}/contract",
        path: "/api/journeys/journey-1/contract",
        body: {},
        pathParameters: { id: "journey-1" },
      }),
      operation: "createContract",
      status: 200,
    },
    {
      event: event({
        routeKey: "POST /api/delivery/previews",
        path: "/api/delivery/previews",
        body: {
          preset: "MINIMAL",
          repositoryName: "support-foundation",
          journeyId: "journey-1",
        },
      }),
      operation: "createPreview",
      status: 201,
    },
    {
      event: event({
        routeKey: "GET /api/delivery/{id}",
        method: "GET",
        path: "/api/delivery/delivery-1",
        body: undefined,
        headers: { "x-active-domain": "customer_support" },
        pathParameters: { id: "delivery-1" },
      }),
      operation: "getDelivery",
      status: 200,
    },
    {
      event: event({
        routeKey: "GET /api/delivery/github",
        method: "GET",
        path: "/api/delivery/github",
        body: undefined,
        headers: { "x-active-domain": "customer_support" },
      }),
      operation: "getGitHubConnection",
      status: 200,
    },
    {
      event: event({
        routeKey: "POST /api/delivery/github/authorizations",
        method: "POST",
        path: "/api/delivery/github/authorizations",
        body: {
          previewId: "delivery-1",
          fingerprint: "a".repeat(64),
          confirmation: "support-foundation",
          acknowledgePrivateRepository: true,
        },
      }),
      operation: "startGitHubAuthorization",
      status: 201,
    },
  ];

  for (const item of cases) {
    const response = await handler(item.event);
    assert.equal(response.statusCode, item.status);
    assert.equal(body(response).ok, true);
    assert.equal(
      calls.some(([operation]) => operation === item.operation),
      true,
    );
  }
  assert.equal(
    calls.find(([operation]) => operation === "createJourney")[1]
      .identity.activeDomain,
    "customer_support",
  );
  assert.deepEqual(
    calls.find(([operation]) => operation === "startGitHubAuthorization")[1],
    {
      identity: {
        actor: claims.sub,
        role: "admin",
        activeDomain: "customer_support",
        domainIds: ["platform", "customer_support", "finance"],
      },
      requestId: "request-1",
      payload: {
        previewId: "delivery-1",
        fingerprint: "a".repeat(64),
        confirmation: "support-foundation",
        acknowledgePrivateRepository: true,
      },
    },
  );
});

test("GitHub callback exchanges server-side without JWT and redirects with only a delivery ID", async () => {
  const { calls, handler } = handlerWith();
  const state = `gho_${"a".repeat(32)}`;
  const response = await handler(event({
    routeKey: "GET /oauth/github/callback",
    method: "GET",
    path: "/oauth/github/callback",
    headers: {},
    requestClaims: {},
    body: undefined,
    rawQueryString: `code=github-code&state=${state}`,
    queryStringParameters: { code: "github-code", state },
  }));

  assert.equal(response.statusCode, 302);
  assert.equal(
    response.headers.location,
    "https://platform.example/?github_delivery=delivery-1",
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body, "");
  assert.deepEqual(
    calls.find(([operation]) => operation === "completeGitHubAuthorization"),
    [
      "completeGitHubAuthorization",
      { payload: { code: "github-code", state } },
    ],
  );
});

test("GitHub callback accepts GitHub's authorization-server issuer", async () => {
  const { calls, handler } = handlerWith();
  const state = `gho_${"a".repeat(32)}`;
  const response = await handler(event({
    routeKey: "GET /oauth/github/callback",
    method: "GET",
    path: "/oauth/github/callback",
    headers: {},
    requestClaims: {},
    body: undefined,
    rawQueryString:
      `code=github-code&state=${state}`
      + "&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth",
  }));

  assert.equal(response.statusCode, 302);
  assert.equal(
    response.headers.location,
    "https://platform.example/?github_delivery=delivery-1",
  );
  assert.deepEqual(
    calls.find(([operation]) => operation === "completeGitHubAuthorization"),
    [
      "completeGitHubAuthorization",
      { payload: { code: "github-code", state } },
    ],
  );
});

test("GitHub callback preserves delivery and surfaces grant revocation warning", async () => {
  const { handler } = handlerWith({
    serviceOverrides: {
      async completeGitHubAuthorization() {
        return {
          id: "delivery-1",
          warning: "GITHUB_REVOCATION_FAILED",
        };
      },
    },
  });
  const state = `gho_${"a".repeat(32)}`;
  const response = await handler(event({
    routeKey: "GET /oauth/github/callback",
    method: "GET",
    path: "/oauth/github/callback",
    headers: {},
    requestClaims: {},
    body: undefined,
    rawQueryString: `code=github-code&state=${state}`,
  }));

  assert.equal(response.statusCode, 302);
  assert.equal(
    response.headers.location,
    "https://platform.example/?github_delivery=delivery-1"
      + "&github_warning=revocation_failed",
  );
});

test("GitHub callback preserves a failed delivery and simultaneous token revocation warning", async () => {
  const { handler } = handlerWith({
    serviceOverrides: {
      async completeGitHubAuthorization() {
        throw Object.assign(
          new JourneyServiceError("GITHUB_UNAVAILABLE"),
          {
            deliveryId: "delivery-1",
            revocationFailed: true,
          },
        );
      },
    },
  });
  const state = `gho_${"a".repeat(32)}`;
  const response = await handler(event({
    routeKey: "GET /oauth/github/callback",
    method: "GET",
    path: "/oauth/github/callback",
    headers: {},
    requestClaims: {},
    body: undefined,
    rawQueryString: `code=github-code&state=${state}`,
  }));

  assert.equal(response.statusCode, 302);
  assert.equal(
    response.headers.location,
    "https://platform.example/?github_delivery=delivery-1"
      + "&github_error=delivery_failed"
      + "&github_warning=revocation_failed",
  );
});

test("GitHub callback returns stable redirects for cancellation and malformed queries", async () => {
  const { calls, handler } = handlerWith();
  const state = `gho_${"a".repeat(32)}`;
  const cancelled = await handler(event({
    routeKey: "GET /oauth/github/callback",
    method: "GET",
    path: "/oauth/github/callback",
    headers: {},
    requestClaims: {},
    body: undefined,
    rawQueryString:
      "error=access_denied"
      + "&error_description=The+user+denied+access"
      + "&error_uri=https%3A%2F%2Fdocs.github.com"
      + `&state=${state}`,
  }));
  assert.equal(cancelled.statusCode, 302);
  assert.equal(
    cancelled.headers.location,
    "https://platform.example/?github_error=authorization_cancelled",
  );
  assert.deepEqual(
    calls.find(([operation]) => operation === "cancelGitHubAuthorization"),
    [
      "cancelGitHubAuthorization",
      { payload: { state } },
    ],
  );

  for (const request of [
    event({
      routeKey: "GET /oauth/github/callback",
      method: "GET",
      path: "/oauth/github/callback",
      headers: {},
      requestClaims: {},
      body: undefined,
      rawQueryString: `code=one&code=two&state=${state}`,
    }),
    event({
      routeKey: "GET /oauth/github/callback",
      method: "GET",
      path: "/oauth/github/callback",
      headers: {},
      requestClaims: {},
      body: undefined,
      rawQueryString: `code=one&state=${state}&extra=reject`,
    }),
    event({
      routeKey: "GET /oauth/github/callback",
      method: "GET",
      path: "/oauth/github/callback",
      headers: {},
      requestClaims: {},
      body: undefined,
      rawQueryString:
        `code=one&state=${state}`
        + "&iss=https%3A%2F%2Fgithub.com",
    }),
    event({
      routeKey: "GET /oauth/github/callback",
      method: "GET",
      path: "/oauth/github/callback",
      headers: {},
      requestClaims: {},
      body: { reject: true },
      rawQueryString: `code=one&state=${state}`,
    }),
  ]) {
    const invalid = await handler(request);
    assert.equal(invalid.statusCode, 302);
    assert.equal(
      invalid.headers.location,
      "https://platform.example/?github_error=invalid_callback",
    );
  }
  assert.equal(
    calls.some(([operation]) => operation === "completeGitHubAuthorization"),
    false,
  );
});

test("GitHub callback logs only the safe shape of a malformed query", async () => {
  const securityEvents = [];
  const { handler } = handlerWith({
    logSecurityEvent(event) {
      securityEvents.push(structuredClone(event));
    },
  });
  const secretCode = "github-secret-code";
  const secretState = `gho_${"a".repeat(32)}`;

  await handler(event({
    routeKey: "GET /oauth/github/callback",
    method: "GET",
    path: "/oauth/github/callback",
    headers: {},
    requestClaims: {},
    body: undefined,
    rawQueryString:
      `code=${secretCode}&state=${secretState}`
      + "&unexpected=reject",
  }));

  assert.deepEqual(securityEvents, [{
    event: "GITHUB_OAUTH_CALLBACK_REJECTED",
    error: null,
    queryKeys: ["code", "state", "unexpected"],
  }]);
  assert.equal(JSON.stringify(securityEvents).includes(secretCode), false);
  assert.equal(JSON.stringify(securityEvents).includes(secretState), false);
});

test("GitHub authorization start enforces a strict body and request ID", async () => {
  const { calls, handler } = handlerWith();
  const missingRequestId = await handler(event({
    routeKey: "POST /api/delivery/github/authorizations",
    path: "/api/delivery/github/authorizations",
    headers: { "x-active-domain": "customer_support" },
    body: {
      previewId: "delivery-1",
      fingerprint: "a".repeat(64),
      confirmation: "support-foundation",
      acknowledgePrivateRepository: true,
    },
  }));
  assert.equal(missingRequestId.statusCode, 400);
  assert.equal(body(missingRequestId).code, "INVALID_REQUEST_ID");

  for (const extraBody of [{
    previewId: "delivery-1",
    fingerprint: "a".repeat(64),
    confirmation: "support-foundation",
    acknowledgePrivateRepository: true,
    extra: "reject",
  }]) {
    const invalid = await handler(event({
      routeKey: "POST /api/delivery/github/authorizations",
      path: "/api/delivery/github/authorizations",
      body: extraBody,
    }));
    assert.equal(invalid.statusCode, 400);
    assert.equal(body(invalid).code, "INVALID_BODY");
  }

  assert.equal(
    calls.some(([operation]) => operation === "createRepository"),
    false,
  );
});

test("handler defaults Platform Admin journeys to platform and requires domain scope for other roles", async () => {
  const { calls, handler } = handlerWith();
  const unauthenticated = await handler(event({
    requestClaims: { sub: "operator-sub", token_use: "id" },
  }));
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(body(unauthenticated).code, "NOT_AUTHENTICATED");

  const admin = await handler(event({
    headers: { "x-request-id": "request-1" },
  }));
  assert.equal(admin.statusCode, 201, admin.body);
  assert.equal(
    calls.find(([operation]) => operation === "createJourney")[1]
      .identity.activeDomain,
    "platform",
  );

  const builderWithoutDomain = await handler(event({
    headers: {
      "x-demo-role": "builder",
      "x-request-id": "request-2",
    },
  }));
  assert.equal(builderWithoutDomain.statusCode, 403);
  assert.equal(body(builderWithoutDomain).code, "DEMO_DOMAIN_REQUIRED");

  const user = await handler(event({
    headers: {
      "x-active-domain": "customer_support",
      "x-demo-role": "user",
      "x-request-id": "request-1",
    },
  }));
  assert.equal(user.statusCode, 403);
  assert.equal(body(user).code, "FORBIDDEN");
});

test("Platform Admin may run a journey in an explicitly selected active domain", async () => {
  const { calls, handler } = handlerWith();
  const response = await handler(event({
    headers: {
      "x-active-domain": "finance",
      "x-request-id": "admin-finance-journey",
    },
  }));

  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(
    calls.find(([operation]) => operation === "createJourney")[1].identity,
    {
      actor: claims.sub,
      role: "admin",
      activeDomain: "finance",
      domainIds: ["platform", "customer_support", "finance"],
    },
  );
});

test("demo role overrides require authoritative demo-operator verification", async () => {
  const { handler } = handlerWith({
    identityVerifier: async () => false,
  });
  const response = await handler(event({
    headers: {
      "x-active-domain": "customer_support",
      "x-demo-role": "builder",
      "x-request-id": "request-1",
    },
  }));
  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "DEMO_ROLE_NOT_ALLOWED");
});

test("mutations require one strict request ID while reads do not", async () => {
  const { handler } = handlerWith();
  for (const headers of [
    { "x-active-domain": "customer_support" },
    {
      "x-active-domain": "customer_support",
      "x-request-id": "one",
      "X-Request-Id": "two",
    },
  ]) {
    const response = await handler(event({ headers }));
    assert.equal(response.statusCode, 400);
    assert.equal(body(response).code, "INVALID_REQUEST_ID");
  }

  const read = await handler(event({
    routeKey: "GET /api/journeys/{id}",
    method: "GET",
    path: "/api/journeys/journey-1",
    body: undefined,
    headers: { "x-active-domain": "customer_support" },
    pathParameters: { id: "journey-1" },
  }));
  assert.equal(read.statusCode, 200);

  const malformedRead = await handler(event({
    routeKey: "GET /api/journeys/{id}",
    method: "GET",
    path: "/api/journeys/journey-1",
    body: undefined,
    headers: {
      "x-active-domain": "customer_support",
      "x-request-id": "one",
      "X-Request-Id": "two",
    },
    pathParameters: { id: "journey-1" },
  }));
  assert.equal(malformedRead.statusCode, 400);
  assert.equal(body(malformedRead).code, "INVALID_REQUEST_ID");
});

test("handler rejects malformed, oversized, query-bearing, and mismatched routes", async () => {
  const { handler } = handlerWith();
  const malformed = event();
  malformed.body = "{";
  const oversized = event();
  oversized.body = JSON.stringify({ text: "x".repeat(65_536) });
  const cases = [
    malformed,
    oversized,
    event({ queryStringParameters: { debug: "true" } }),
    event({
      routeKey: "GET /api/journeys/{id}",
      method: "GET",
      path: "/api/journeys/other",
      body: undefined,
      headers: { "x-active-domain": "customer_support" },
      pathParameters: { id: "journey-1" },
    }),
  ];
  for (const request of cases) {
    const response = await handler(request);
    assert.ok([400, 404].includes(response.statusCode));
  }
});

test("handler returns stable service errors and never leaks exception details", async () => {
  const error = new JourneyServiceError("INCEPTION_UNAVAILABLE");
  error.stack = "secret internal stack";
  const { handler } = handlerWith({
    service: Object.fromEntries(
      [
        "createJourney",
        "getJourney",
        "addMessage",
        "createContract",
        "createPreview",
        "getDelivery",
        "getGitHubConnection",
        "startGitHubAuthorization",
        "cancelGitHubAuthorization",
        "completeGitHubAuthorization",
      ].map((name) => [name, async () => {
        throw error;
      }]),
    ),
  });
  const response = await handler(event());
  assert.equal(response.statusCode, 503);
  assert.deepEqual(body(response), {
    ok: false,
    code: "INCEPTION_UNAVAILABLE",
    message: "The inception model is temporarily unavailable.",
    requestId: "api-request-1",
    retryable: true,
  });
  assert.equal(response.body.includes("secret internal stack"), false);
  assert.equal(response.headers["cache-control"], "no-store");
});
