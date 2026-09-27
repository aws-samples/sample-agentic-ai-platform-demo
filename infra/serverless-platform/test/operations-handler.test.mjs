import assert from "node:assert/strict";
import test from "node:test";
import { createOperationsHandler } from "../lambda/operations/index.mjs";

const claims = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:username": "deployment-operator",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

function event({
  path = "/api/operations",
  method = "GET",
  requestClaims = claims,
  headers,
  queryStringParameters,
  rawQueryString,
  body,
  requestId = "operations-request",
} = {}) {
  return {
    version: "2.0",
    body,
    headers,
    queryStringParameters,
    rawQueryString,
    requestContext: {
      http: { method, path },
      requestId,
      authorizer: { jwt: { claims: requestClaims } },
    },
  };
}

function identityProjector() {
  return {
    projectAuthenticated(requestClaims) {
      return {
        actor: requestClaims.sub,
        role: requestClaims["cognito:groups"]?.includes("end-user")
          ? "user"
          : "admin",
      };
    },
    projectEffective(requestClaims, headers, { availableDomains }) {
      const role = headers?.["x-demo-role"] || (
        requestClaims["cognito:groups"]?.includes("end-user")
          ? "user"
          : "admin"
      );
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

function operationAggregate(overrides = {}) {
  return {
    scopeType: "platform",
    domainId: null,
    projectId: null,
    runtimeCount: 1,
    healthyRuntimeCount: 1,
    invocationCount: 2,
    errorCount: 0,
    averageLatencyMs: 100,
    p95LatencyMs: 150,
    inputTokens: 20,
    outputTokens: 10,
    ...overrides,
  };
}

function handlerWith({
  cloudWatch,
  deadlineTimers,
  directory,
  identityVerifier = async () => true,
  projector = identityProjector(),
  state,
  timeoutMs,
  usage,
} = {}) {
  const calls = [];
  const handler = createOperationsHandler({
    identityProjector: projector,
    identityVerifier,
    domainDirectory: directory || {
      async listActiveDomains(input) {
        calls.push(["domains", input]);
        return [
          { id: "customer_support" },
          { id: "operations" },
        ];
      },
    },
    workspaceState: {
      beginTransaction() {
        const timestamp = "2026-08-25T00:00:00.000Z";
        return Object.freeze({
          timestamp,
          epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
        });
      },
      async getMutationResult() {
        return null;
      },
      async listProjects(input) {
        calls.push(["projects", input]);
        return { items: [], cursor: null };
      },
      async getProject() {
        return null;
      },
      async listIncidents() {
        return { items: [], cursor: null };
      },
      async getIncident() {
        return null;
      },
      async putIncident({ record }) {
        return record;
      },
      async listAuditMetadata() {
        return { items: [], cursor: null };
      },
      async listBreakGlass() {
        return { items: [], cursor: null };
      },
      async getBreakGlass() {
        return null;
      },
      async putBreakGlass({ record }) {
        return record;
      },
      ...state,
    },
    authorizer: async (input) => {
      calls.push(["authorize", input]);
      return { ok: true };
    },
    cloudWatchProvider: {
      async listRuntimeAggregates(input) {
        calls.push(["cloudwatch", input]);
        const item = input.scope.type === "platform"
          ? operationAggregate()
          : input.scope.type === "domain"
            ? operationAggregate({
                scopeType: "domain",
                domainId: input.scope.domainIds[0],
              })
            : operationAggregate({
                scopeType: "project",
                domainId: input.scope.domainIds[0],
                projectId: input.scope.projectIds[0]?.split("/")[1]
                  ?? "unassigned-project",
              });
        return {
          items: input.scope.type === "projects"
            && input.scope.projectIds.length === 0
            ? []
            : [item],
          cursor: null,
        };
      },
      ...cloudWatch,
    },
    usageProvider: {
      async listInvocationUsageAggregates(input) {
        calls.push(["usage", input]);
        return { items: [], cursor: null };
      },
      async listBudgets(input) {
        calls.push(["budgets", input]);
        return [];
      },
      ...usage,
    },
    clock: () => Date.parse("2026-08-25T00:00:00.000Z"),
    cursorSigningKey:
      "test-only-operations-cursor-signing-key-material",
    deadlineTimers,
    timeoutMs,
  });
  return { calls, handler };
}

function body(response) {
  return JSON.parse(response.body);
}

const stableHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

test("operations handler requires all injected trust-boundary dependencies", () => {
  assert.throws(
    () => createOperationsHandler(),
    /Identity projector is invalid/,
  );
  assert.throws(
    () => createOperationsHandler({
      identityProjector: identityProjector(),
      identityVerifier: async () => true,
    }),
    /Domain directory is invalid/,
  );
});

test("only Cognito access-token subjects can reach operations routes", async () => {
  const { calls, handler } = handlerWith();
  for (const requestClaims of [
    null,
    { sub: "operator-sub", token_use: "id" },
    { sub: "", token_use: "access" },
    { token_use: "access" },
  ]) {
    const response = await handler(event({ requestClaims }));
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.headers, stableHeaders);
    assert.equal(body(response).code, "NOT_AUTHENTICATED");
  }
  assert.equal(calls.length, 0);
});

test("end users are denied before domain, state, and provider access", async () => {
  const { calls, handler } = handlerWith();
  const response = await handler(event({
    requestClaims: {
      sub: "end-user-sub",
      token_use: "access",
      "cognito:groups": ["end-user"],
    },
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "FORBIDDEN");
  assert.deepEqual(calls, []);
});

test("verified demo End User is denied before data access", async () => {
  let verifierCalls = 0;
  const { calls, handler } = handlerWith({
    identityVerifier: async () => {
      verifierCalls += 1;
      return true;
    },
  });

  const response = await handler(event({
    headers: { "x-demo-role": "user" },
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "FORBIDDEN");
  assert.equal(verifierCalls, 1);
  assert.deepEqual(calls, []);
});

test("operations and costs routes dispatch authoritative scoped requests", async () => {
  for (const [path, provider] of [
    ["/api/operations", "cloudwatch"],
    ["/api/costs", "usage"],
  ]) {
    const { calls, handler } = handlerWith();
    const response = await handler(event({ path }));

    assert.equal(response.statusCode, 200);
    assert.equal(body(response).ok, true);
    assert.equal(body(response).resource, path.slice(5));
    assert.deepEqual(body(response).window, {
      startTime: "2026-08-24T00:00:00.000Z",
      endTime: "2026-08-25T00:00:00.000Z",
    });
    assert.ok(calls.some(([name]) => name === provider));
    assert.equal(
      calls.some(([, input]) =>
        input?.actor === "forged-sub"
        || input?.domainId === "finance"
        || input?.projectId === "foreign-project"),
      false,
    );
  }
});

test("lead and builder require an authoritative selected domain", async () => {
  for (const role of ["lead", "builder"]) {
    const { calls, handler } = handlerWith();
    const missing = await handler(event({
      headers: { "x-demo-role": role },
    }));
    assert.equal(missing.statusCode, 403);
    assert.equal(body(missing).code, "DEMO_DOMAIN_REQUIRED");

    const foreign = await handler(event({
      headers: {
        "x-demo-role": role,
        "x-active-domain": "finance",
      },
    }));
    assert.equal(foreign.statusCode, 403);
    assert.equal(body(foreign).code, "DEMO_DOMAIN_NOT_ALLOWED");

    const allowed = await handler(event({
      headers: {
        "x-demo-role": role,
        "x-active-domain": "customer_support",
      },
    }));
    assert.equal(allowed.statusCode, 200);
    assert.ok(calls.some(
      ([name, input]) =>
        name === "projects"
        && input.domainId === "customer_support",
    ));
  }
});

test("query parsing accepts only bounded window, limit, and opaque cursor", async () => {
  const invalid = [
    [{ domainId: "operations" }, "domainId=operations"],
    [{ window: "90d" }, "window=90d"],
    [{ limit: "0" }, "limit=0"],
    [{ limit: "51" }, "limit=51"],
    [{ limit: "01" }, "limit=01"],
    [{ cursor: "abc" }, "cursor=abc&cursor=def"],
  ];
  for (const [queryStringParameters, rawQueryString] of invalid) {
    const { calls, handler } = handlerWith();
    const response = await handler(event({
      queryStringParameters,
      rawQueryString,
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(body(response).code, "INVALID_QUERY");
    assert.equal(calls.length, 0);
  }

  const { calls, handler } = handlerWith();
  const response = await handler(event({
    queryStringParameters: { window: "7d", limit: "25" },
    rawQueryString: "window=7d&limit=25",
  }));
  assert.equal(response.statusCode, 200);
  const providerCall = calls.find(([name]) => name === "cloudwatch")[1];
  assert.equal(providerCall.limit, 25);
  assert.equal(providerCall.startTime, "2026-08-18T00:00:00.000Z");
});

test("list query parsing accepts one opaque cursor and rejects duplicates", async () => {
  const listInputs = [];
  const { handler } = handlerWith({
    state: {
      async listIncidents(input) {
        listInputs.push(structuredClone(input));
        return listInputs.length === 1
          ? {
              items: [],
              cursor: {
                pk: `INCIDENT#${input.domainId}`,
                sk: "INCIDENT#cursor-record",
              },
            }
          : { items: [], cursor: null };
      },
    },
  });
  const first = await handler(event({
    path: "/api/incidents",
    queryStringParameters: { limit: "10" },
    rawQueryString: "limit=10",
  }));
  const opaqueCursor = body(first).cursor;
  assert.match(opaqueCursor, /^[A-Za-z0-9_-]+$/);
  const accepted = await handler(event({
    path: "/api/incidents",
    queryStringParameters: { limit: "10", cursor: opaqueCursor },
    rawQueryString: `limit=10&cursor=${opaqueCursor}`,
  }));
  assert.equal(accepted.statusCode, 200);
  assert.equal(listInputs[1].limit, 10);
  assert.deepEqual(listInputs[1].cursor, {
    pk: "INCIDENT#customer_support",
    sk: "INCIDENT#cursor-record",
  });

  const duplicate = await handler(event({
    path: "/api/incidents",
    queryStringParameters: { cursor: opaqueCursor },
    rawQueryString: `cursor=${opaqueCursor}&cursor=other_cursor`,
  }));
  assert.equal(duplicate.statusCode, 400);
  assert.equal(body(duplicate).code, "INVALID_QUERY");
});

test("unknown routes, methods, and GET bodies receive stable errors", async () => {
  for (const request of [
    { path: "/api/unknown" },
    { method: "POST" },
    { body: "{}" },
  ]) {
    const { calls, handler } = handlerWith();
    const response = await handler(event(request));
    assert.equal(response.statusCode, request.path ? 404 : 400);
    assert.deepEqual(response.headers, stableHeaders);
    assert.equal(calls.length, 0);
  }
});

test("immutable actor always comes from the access-token subject", async () => {
  const projector = identityProjector();
  const { calls, handler } = handlerWith({
    projector: {
      ...projector,
      projectEffective(...args) {
        return {
          ...projector.projectEffective(...args),
          actor: "forged-sub",
        };
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 503);
  assert.equal(body(response).code, "IDENTITY_UNAVAILABLE");
  assert.equal(calls.some(([name]) => name === "projects"), false);
});

test("identity projection accessors are rejected without being executed", async () => {
  let getterCalls = 0;
  const { calls, handler } = handlerWith({
    projector: {
      projectAuthenticated() {
        const projection = { actor: "operator-sub" };
        Object.defineProperty(projection, "role", {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw new Error("projection getter executed");
          },
        });
        return projection;
      },
      projectEffective() {
        throw new Error("must not be called");
      },
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 503);
  assert.equal(body(response).code, "IDENTITY_UNAVAILABLE");
  assert.equal(getterCalls, 0);
  assert.deepEqual(calls, []);
});

test("timeouts abort in-flight providers and return stable no-store JSON", async () => {
  const scheduled = [];
  const cleared = [];
  let observedSignal;
  const deadlineTimers = {
    setTimeout(callback, timeoutMs) {
      const handle = { callback, timeoutMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };
  const { handler } = handlerWith({
    deadlineTimers,
    timeoutMs: 25,
    cloudWatch: {
      async listRuntimeAggregates({ abortSignal }) {
        observedSignal = abortSignal;
        return new Promise(() => {});
      },
    },
  });

  const pending = handler(event({ requestId: "timed-out" }));
  await new Promise((resolve) => setImmediate(resolve));
  scheduled[0].callback();
  const response = await pending;

  assert.equal(observedSignal.aborted, true);
  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.headers, stableHeaders);
  assert.deepEqual(body(response), {
    ok: false,
    code: "OPERATIONS_TIMEOUT",
    message: "The operations request timed out.",
    requestId: "timed-out",
    retryable: true,
  });
  assert.deepEqual(cleared, scheduled);
});

test("provider failures return stable non-disclosing errors", async () => {
  const { handler } = handlerWith({
    cloudWatch: {
      async listRuntimeAggregates() {
        throw new Error("account-secret-runtime-name");
      },
    },
  });

  const response = await handler(event({ requestId: "provider-failed" }));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(body(response), {
    ok: false,
    code: "OPERATIONS_UNAVAILABLE",
    message: "Operational data is temporarily unavailable.",
    requestId: "provider-failed",
    retryable: true,
  });
  assert.doesNotMatch(response.body, /account-secret-runtime-name/);
});
