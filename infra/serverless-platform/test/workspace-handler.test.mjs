import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceHandler } from "../lambda/workspace/index.mjs";
import {
  createProductionIdentityProjector,
  createWorkspaceInventoryAuthorizer,
} from "../lambda/workspace/runtime.mjs";

const claims = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:username": "deployment-operator",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

function event({
  path = "/api/projects",
  method = "GET",
  requestClaims = claims,
  headers,
  queryStringParameters,
  rawQueryString,
  body,
  requestId = "workspace-request",
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
      authorizer: {
        jwt: { claims: requestClaims },
      },
    },
  };
}

function identityProjector() {
  return {
    projectAuthenticated(requestClaims) {
      const role = requestClaims["cognito:groups"]?.includes("end-user")
        ? "user"
        : "admin";
      return {
        actor: requestClaims.sub,
        role,
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
        error.code = domain ? "DEMO_DOMAIN_NOT_ALLOWED" : "DEMO_DOMAIN_REQUIRED";
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

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support workspace.",
    ownerSubject: "operator-sub",
    memberSubjects: ["operator-sub"],
    status: "ACTIVE",
    createdBySubject: "operator-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

function handlerWith({
  authorizer = async () => ({ ok: true }),
  deadlineTimers,
  domainDirectory,
  identityVerifier = async () => true,
  projector = identityProjector(),
  timeoutMs,
  projectCreateTimeoutMs,
  workspaceState,
} = {}) {
  const calls = [];
  const state = {
    async listProjects(input) {
      calls.push(["projects", input]);
      return { items: [], cursor: null };
    },
    async listAgents(input) {
      calls.push(["agents", input]);
      return { items: [], cursor: null };
    },
    async listDeployments(input) {
      calls.push(["deployments", input]);
      return { items: [], cursor: null };
    },
    async listApprovals(input) {
      calls.push(["approvals", input]);
      return { items: [], cursor: null };
    },
    beginTransaction() {
      calls.push(["beginTransaction"]);
      return {
        timestamp: "2026-08-25T04:00:00.000Z",
        epochSeconds: Math.floor(
          Date.parse("2026-08-25T04:00:00.000Z") / 1000,
        ),
      };
    },
    async getMutationResult(input) {
      calls.push(["getMutationResult", input]);
      return null;
    },
    async getProject(input) {
      calls.push(["getProject", input]);
      return null;
    },
    async putProject(input) {
      calls.push(["putProject", input]);
      return input.record;
    },
    ...workspaceState,
  };
  const directory = domainDirectory || {
    async listActiveDomains() {
      calls.push(["domains"]);
      return [
        { id: "platform" },
        { id: "customer_support" },
        { id: "operations" },
      ];
    },
  };
  return {
    calls,
    handler: createWorkspaceHandler({
      authorizer,
      deadlineTimers,
      domainDirectory: directory,
      identityProjector: projector,
      identityVerifier,
      timeoutMs,
      projectCreateTimeoutMs,
      workspaceState: state,
    }),
  };
}

function body(response) {
  return JSON.parse(response.body);
}

const stableHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const createTimestamp = "2026-08-25T04:00:00.000Z";

test("workspace handler requires all injected trust-boundary dependencies", () => {
  assert.throws(
    () => createWorkspaceHandler(),
    /Identity projector is invalid/,
  );
  assert.throws(
    () => createWorkspaceHandler({
      identityProjector: identityProjector(),
      identityVerifier: async () => true,
    }),
    /Domain directory is invalid/,
  );
});

test("POST /api/projects creates a Lead-owned ACTIVE project in the selected domain", async () => {
  const { handler, calls } = handlerWith();
  const response = await handler(event({
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "create-project-001",
    },
    body: JSON.stringify({
      id: "case-assist",
      name: "Case Assist",
      description: "Customer support workspace.",
    }),
  }));

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.headers, stableHeaders);
  assert.deepEqual(body(response), {
    ok: true,
    resource: "project",
    project: project({
      memberSubjects: [],
      createdAt: createTimestamp,
    }),
  });
  const write = calls.find(([name]) => name === "putProject");
  assert.ok(write);
  assert.equal(write[1].record.domainId, "customer_support");
  assert.equal(write[1].record.ownerSubject, claims.sub);
  assert.equal(write[1].record.createdBySubject, claims.sub);
  assert.deepEqual(write[1].record.memberSubjects, []);
  assert.equal(write[1].record.status, "ACTIVE");
});

test("POST /api/projects integrates with the production domain-scoped authorizer", async () => {
  const { handler } = handlerWith({
    authorizer: createWorkspaceInventoryAuthorizer(),
  });
  const response = await handler(event({
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "production-authorizer-create",
    },
    body: JSON.stringify({
      id: "case-assist",
      name: "Case Assist",
      description: "",
    }),
  }));

  assert.equal(response.statusCode, 201);
  assert.equal(body(response).project.domainId, "customer_support");
});

test("Domain Builder POST /api/projects cannot create a project in the selected domain", async () => {
  const { handler } = handlerWith({
    authorizer: createWorkspaceInventoryAuthorizer(),
  });
  const response = await handler(event({
    method: "POST",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
      "x-request-id": "builder-project-create",
    },
    body: JSON.stringify({
      id: "case-assist",
      name: "Case Assist",
      description: "",
    }),
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "FORBIDDEN");
});

test("a permanent single-domain Builder cannot create a project without a demo domain header", async () => {
  const requestClaims = {
    sub: "builder-sub",
    token_use: "access",
    "cognito:username": "builder",
    "cognito:groups": ["domain-builder", "domain-customer-support"],
  };
  const { handler, calls } = handlerWith({
    authorizer: createWorkspaceInventoryAuthorizer(),
    projector: createProductionIdentityProjector(),
  });

  const created = await handler(event({
    method: "POST",
    requestClaims,
    headers: {
      "x-request-id": "permanent-builder-project-create",
    },
    body: JSON.stringify({
      id: "case-assist",
      name: "Case Assist",
      description: "",
    }),
  }));
  assert.equal(created.statusCode, 403);
  assert.equal(body(created).code, "FORBIDDEN");

  const foreign = await handler(event({
    method: "POST",
    requestClaims,
    headers: {
      "x-active-domain": "operations",
      "x-request-id": "permanent-builder-foreign-project-create",
    },
    body: JSON.stringify({
      id: "foreign-project",
      name: "Foreign Project",
      description: "",
    }),
  }));
  assert.equal(foreign.statusCode, 403);
  assert.equal(body(foreign).code, "FORBIDDEN");
  assert.equal(
    calls.filter(([name]) => name === "putProject").length,
    0,
  );
});

test("project creation is centrally authorized before domain-directory state", async () => {
  const events = [];
  const { handler } = handlerWith({
    authorizer: async () => {
      events.push("authorize");
      return { ok: true };
    },
    domainDirectory: {
      async listActiveDomains() {
        events.push("domains");
        return [
          { id: "platform" },
          { id: "customer_support" },
        ];
      },
    },
  });

  const response = await handler(event({
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "preauthorized-project-create",
    },
    body: JSON.stringify({
      id: "case-assist",
      name: "Case Assist",
      description: "",
    }),
  }));

  assert.equal(response.statusCode, 201);
  assert.deepEqual(events, ["authorize", "domains", "authorize"]);
});

test("Platform Admin POST /api/projects can create only in the platform domain", async () => {
  const { handler, calls } = handlerWith();
  const response = await handler(event({
    method: "POST",
    headers: {
      "x-request-id": "create-platform-project-001",
    },
    body: JSON.stringify({
      id: "platform-assistant",
      name: "Platform Assistant",
      description: "Platform-owned builder workspace.",
    }),
  }));

  assert.equal(response.statusCode, 201);
  assert.equal(body(response).project.domainId, "platform");
  const write = calls.find(([name]) => name === "putProject");
  assert.equal(write[1].record.domainId, "platform");
});

test("project creation requires one valid explicit idempotency request header", async () => {
  for (const headers of [
    {},
    { "x-request-id": "contains space" },
    {
      "x-request-id": "one",
      "X-Request-Id": "two",
    },
  ]) {
    const { handler, calls } = handlerWith();
    const response = await handler(event({
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "case-assist",
        name: "Case Assist",
        description: "",
      }),
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(body(response).code, "INVALID_REQUEST_ID");
    assert.equal(calls.length, 0);
  }
});

test("project creation body contains only bounded id, name, and description", async () => {
  for (const requestBody of [
    {
      id: "case-assist",
      name: "Case Assist",
      description: "",
      domainId: "operations",
    },
    {
      id: "case-assist",
      name: "Case Assist",
      description: "",
      ownerSubject: "forged-sub",
    },
    {
      id: "case-assist",
      name: "Case Assist",
      description: "",
      status: "ARCHIVED",
    },
    {
      id: "Invalid_ID",
      name: "Case Assist",
      description: "",
    },
    {
      id: "case-assist",
      name: "n".repeat(129),
      description: "",
    },
    {
      id: "case-assist",
      name: "Case Assist",
      description: "d".repeat(4097),
    },
  ]) {
    const { handler, calls } = handlerWith();
    const response = await handler(event({
      method: "POST",
      headers: { "x-request-id": "invalid-project-body" },
      body: JSON.stringify(requestBody),
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(body(response).code, "INVALID_REQUEST");
    assert.equal(calls.length, 0);
  }
});

test("End User project creation is denied without a write", async () => {
  let authorizationCalls = 0;
  const { handler, calls } = handlerWith({
    authorizer: async () => {
      authorizationCalls += 1;
      return { ok: true };
    },
  });
  const response = await handler(event({
    method: "POST",
    requestClaims: {
      sub: "end-user-sub",
      token_use: "access",
      "cognito:groups": ["end-user"],
    },
    headers: {
      "x-request-id": "user-project-create",
    },
    body: JSON.stringify({
      id: "case-assist",
      name: "Case Assist",
      description: "",
    }),
  }));
  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "FORBIDDEN");
  assert.equal(
    calls.some(([name]) => name === "putProject"),
    false,
  );
  assert.equal(
    calls.some(([name]) => name === "domains"),
    false,
  );
  assert.equal(authorizationCalls, 1);
});

test("only Cognito access-token subjects can reach workspace routes", async () => {
  const { handler, calls } = handlerWith();
  const cases = [
    null,
    { sub: "operator-sub", token_use: "id" },
    { sub: "", token_use: "access" },
    { token_use: "access" },
  ];
  Object.setPrototypeOf(cases[3], {
    sub: "inherited-sub",
  });

  for (const requestClaims of cases) {
    const response = await handler(event({
      requestClaims,
      requestId: "not-authenticated",
    }));
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.headers, stableHeaders);
    assert.equal(body(response).code, "NOT_AUTHENTICATED");
  }
  assert.equal(calls.length, 0);
});

test("demo role headers are honored only after authoritative verification", async () => {
  let verifierCalls = 0;
  let effectiveCalls = 0;
  const projector = identityProjector();
  const { handler, calls } = handlerWith({
    identityVerifier: async (requestClaims) => {
      verifierCalls += 1;
      assert.equal(requestClaims.sub, "operator-sub");
      return false;
    },
    projector: {
      ...projector,
      projectEffective(...args) {
        effectiveCalls += 1;
        return projector.projectEffective(...args);
      },
    },
  });

  const response = await handler(event({
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "DEMO_ROLE_NOT_ALLOWED");
  assert.equal(verifierCalls, 1);
  assert.equal(effectiveCalls, 0);
  assert.equal(calls.length, 0);
});

test("end users are rejected before domain directory or workspace state access", async () => {
  const { handler, calls } = handlerWith();
  const response = await handler(event({
    requestClaims: {
      sub: "end-user-sub",
      token_use: "access",
      "cognito:groups": ["end-user"],
    },
  }));

  assert.equal(response.statusCode, 403);
  assert.equal(body(response).code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("verified demo End User is rejected before state access", async () => {
  let verifierCalls = 0;
  const { handler, calls } = handlerWith({
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
  assert.equal(calls.length, 0);
});

test("the four GET collection routes dispatch with authoritative scopes", async () => {
  for (const [path, operation] of [
    ["/api/projects", "projects"],
    ["/api/agents", "agents"],
    ["/api/deployments", "deployments"],
    ["/api/approvals", "approvals"],
  ]) {
    const { handler, calls } = handlerWith({
      workspaceState: (
        operation === "agents" || operation === "deployments"
      )
        ? {
            async listProjects(input) {
              calls.push(["projects", input]);
              return {
                items: [project({
                  domainId: input.domainId,
                  id: `${input.domainId.replaceAll("_", "-")}-project`,
                })],
                cursor: null,
              };
            },
          }
        : undefined,
    });
    const response = await handler(event({ path }));
    assert.equal(response.statusCode, 200, path);
    assert.deepEqual(body(response), {
      ok: true,
      resource: operation,
      items: [],
      cursor: null,
    });
    assert.equal(calls[0][0], "domains");
    assert.ok(calls.some(([name]) => name === operation), operation);
    assert.equal(
      calls.some(([, input]) =>
        input?.actor === "forged-sub"
        || input?.domainId === "finance"
        || input?.projectId === "foreign-project"),
      false,
    );
  }
});

test("handler does not forward projected capabilities into the workspace service or authorizer", async () => {
  let authorizationRequest;
  const projector = identityProjector();
  const { handler } = handlerWith({
    projector: {
      projectAuthenticated(...args) {
        return {
          ...projector.projectAuthenticated(...args),
          capabilities: ["managePlatformPolicy"],
        };
      },
      projectEffective(...args) {
        return {
          ...projector.projectEffective(...args),
          capabilities: ["managePlatformPolicy"],
        };
      },
    },
    authorizer: async (request) => {
      authorizationRequest = request;
      return { ok: true };
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(authorizationRequest).sort(), [
    "action",
    "requestContext",
    "resourceRef",
  ]);
  assert.equal(
    JSON.stringify(authorizationRequest).includes("managePlatformPolicy"),
    false,
  );
});

test("lead and builder require an authoritative active domain", async () => {
  for (const role of ["lead", "builder"]) {
    const { handler, calls } = handlerWith();
    const missing = await handler(event({
      headers: { "x-demo-role": role },
      requestId: `${role}-missing-domain`,
    }));
    assert.equal(missing.statusCode, 403);
    assert.equal(body(missing).code, "DEMO_DOMAIN_REQUIRED");

    const foreign = await handler(event({
      headers: {
        "x-demo-role": role,
        "x-active-domain": "finance",
      },
      requestId: `${role}-foreign-domain`,
    }));
    assert.equal(foreign.statusCode, 403);
    assert.equal(body(foreign).code, "DEMO_DOMAIN_NOT_ALLOWED");

    const allowed = await handler(event({
      headers: {
        "x-demo-role": role,
        "x-active-domain": "customer_support",
      },
      requestId: `${role}-allowed-domain`,
    }));
    assert.equal(allowed.statusCode, 200);
    const stateCall = calls.filter(([name]) => name === "projects").at(-1);
    assert.equal(stateCall[1].domainId, "customer_support");
  }
});

test("project, actor, and domain query parameters are rejected before state", async () => {
  for (const queryStringParameters of [
    { actor: "forged-sub" },
    { domainId: "operations" },
    { projectId: "foreign-project" },
    { limit: "10", unexpected: "value" },
  ]) {
    const { handler, calls } = handlerWith();
    const response = await handler(event({
      queryStringParameters,
      rawQueryString: new URLSearchParams(queryStringParameters).toString(),
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(body(response).code, "INVALID_QUERY");
    assert.equal(calls.length, 0);
  }
});

test("query parsing is strict, bounded, and rejects duplicates", async () => {
  const invalid = [
    {
      queryStringParameters: { limit: "0" },
      rawQueryString: "limit=0",
    },
    {
      queryStringParameters: { limit: "51" },
      rawQueryString: "limit=51",
    },
    {
      queryStringParameters: { limit: "01" },
      rawQueryString: "limit=01",
    },
    {
      queryStringParameters: { cursor: "abc" },
      rawQueryString: "cursor=abc&cursor=def",
    },
  ];

  for (const options of invalid) {
    const { handler, calls } = handlerWith();
    const response = await handler(event(options));
    assert.equal(response.statusCode, 400);
    assert.equal(body(response).code, "INVALID_QUERY");
    assert.equal(calls.length, 0);
  }

  const { handler, calls } = handlerWith();
  const response = await handler(event({
    queryStringParameters: { limit: "25" },
    rawQueryString: "limit=25",
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(calls[1][1].limit, 25);
});

test("unknown routes, methods, and GET bodies receive stable errors", async () => {
  for (const request of [
    { path: "/api/operations" },
    { method: "POST" },
    { body: "{}" },
  ]) {
    const { handler, calls } = handlerWith();
    const response = await handler(event(request));
    assert.equal(
      response.statusCode,
      request.path ? 404 : 400,
    );
    assert.deepEqual(response.headers, stableHeaders);
    assert.equal(calls.length, 0);
  }
});

test("immutable actor is always the access-token subject", async () => {
  const projector = identityProjector();
  const { handler, calls } = handlerWith({
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
  assert.equal(calls.filter(([name]) => name === "projects").length, 0);
});

test("malformed domain directory results fail closed without leaking data", async () => {
  const { handler } = handlerWith({
    domainDirectory: {
      async listActiveDomains() {
        return [{
          id: "customer_support",
          secret: "must-not-leak",
        }];
      },
    },
  });
  const response = await handler(event({
    requestId: "malformed-domains",
  }));

  assert.equal(response.statusCode, 503);
  assert.equal(body(response).code, "WORKSPACE_UNAVAILABLE");
  assert.doesNotMatch(response.body, /must-not-leak|secret/);
});

test("domain directory enforces bounded canonical underscore-separated identifiers", async () => {
  for (const id of [
    "customer__support",
    "customer_",
    "customer-support",
    "a".repeat(65),
  ]) {
    const { handler } = handlerWith({
      domainDirectory: {
        async listActiveDomains() {
          return [{ id }];
        },
      },
    });
    const response = await handler(event({
      requestId: `invalid-domain-${id}`,
    }));
    assert.equal(response.statusCode, 503);
    assert.equal(body(response).code, "WORKSPACE_UNAVAILABLE");
  }
});

test("timeouts abort in-flight reads and return stable no-store JSON", async () => {
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
    domainDirectory: {
      async listActiveDomains({ abortSignal }) {
        observedSignal = abortSignal;
        return new Promise(() => {});
      },
    },
  });

  const pending = handler(event({ requestId: "timed-out" }));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].timeoutMs, 25);
  scheduled[0].callback();
  const response = await pending;

  assert.equal(observedSignal.aborted, true);
  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.headers, stableHeaders);
  assert.deepEqual(body(response), {
    ok: false,
    code: "WORKSPACE_TIMEOUT",
    message: "The workspace request timed out.",
    requestId: "timed-out",
    retryable: true,
  });
  assert.deepEqual(cleared, scheduled);
});

test("the request deadline also covers authoritative demo-role verification", async () => {
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
  const { handler, calls } = handlerWith({
    deadlineTimers,
    timeoutMs: 25,
    identityVerifier: async (_requestClaims, { abortSignal }) => {
      observedSignal = abortSignal;
      return new Promise(() => {});
    },
  });

  const pending = handler(event({
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
    requestId: "verifier-timed-out",
  }));
  assert.equal(scheduled.length, 1);
  scheduled[0].callback();
  const response = await pending;

  assert.equal(observedSignal.aborted, true);
  assert.equal(response.statusCode, 504);
  assert.equal(body(response).code, "WORKSPACE_TIMEOUT");
  assert.equal(calls.length, 0);
  assert.deepEqual(cleared, scheduled);
});

test("the request deadline aborts hung central authorization", async () => {
  const scheduled = [];
  const cleared = [];
  let authorizationSignal;
  let authorizationStarted;
  const started = new Promise((resolve) => {
    authorizationStarted = resolve;
  });
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
  const { handler, calls } = handlerWith({
    deadlineTimers,
    timeoutMs: 25,
    authorizer: async ({ requestContext }) => {
      authorizationSignal = requestContext.abortSignal;
      authorizationStarted();
      return new Promise(() => {});
    },
  });

  const pending = handler(event({
    requestId: "authorization-timed-out",
  }));
  await started;
  scheduled[0].callback();
  const response = await pending;

  assert.equal(authorizationSignal.aborted, true);
  assert.equal(response.statusCode, 504);
  assert.equal(body(response).code, "WORKSPACE_TIMEOUT");
  assert.equal(
    calls.some(([name]) => name === "projects"),
    false,
  );
  assert.deepEqual(cleared, scheduled);
});

test("foreign aggregate cursors remain a stable non-disclosing 404", async () => {
  const forgedCursor = Buffer.from(JSON.stringify({
    v: 1,
    r: "projects",
    i: 0,
    c: {
      pk: "PROJECT#finance",
      sk: "PROJECT#secret",
    },
  })).toString("base64url");
  const { handler } = handlerWith();
  const response = await handler(event({
    queryStringParameters: { cursor: forgedCursor },
    rawQueryString: `cursor=${encodeURIComponent(forgedCursor)}`,
  }));

  assert.equal(response.statusCode, 404);
  assert.deepEqual(body(response), {
    ok: false,
    code: "NOT_FOUND",
    message: "Resource not found.",
    requestId: "workspace-request",
    retryable: false,
  });
  assert.doesNotMatch(response.body, /finance|secret|PROJECT#/);
});

test("same-partition cursors with a foreign sort-key type return stable 404", async () => {
  const forgedCursor = Buffer.from(JSON.stringify({
    v: 1,
    r: "projects",
    i: 0,
    c: {
      pk: "PROJECT#customer_support",
      sk: "AGENT#secret",
    },
  })).toString("base64url");
  const { handler } = handlerWith();
  const response = await handler(event({
    queryStringParameters: { cursor: forgedCursor },
    rawQueryString: `cursor=${encodeURIComponent(forgedCursor)}`,
  }));

  assert.equal(response.statusCode, 404);
  assert.equal(body(response).code, "NOT_FOUND");
  assert.doesNotMatch(response.body, /AGENT#|secret/);
});

test("project create has a separate bounded catalog deadline while reads keep their original budget", async () => {
  const scheduled=[];
  const deadlineTimers={setTimeout(callback,timeoutMs){const h={callback,timeoutMs};scheduled.push(h);return h;},clearTimeout(){}};
  const {handler}=handlerWith({deadlineTimers,timeoutMs:1500,projectCreateTimeoutMs:25000,domainDirectory:{async listActiveDomains(){return new Promise(()=>{});}}});
  const read=handler(event());scheduled[0].callback();assert.equal((await read).statusCode,504);assert.equal(scheduled[0].timeoutMs,1500);
  const create=handler(event({method:'POST',headers:{'x-request-id':'deadline-create'},body:JSON.stringify({id:'deadline-project',name:'Deadline project',description:''})}));
  assert.equal(scheduled[1].timeoutMs,25000);scheduled[1].callback();assert.equal((await create).statusCode,504);
});
