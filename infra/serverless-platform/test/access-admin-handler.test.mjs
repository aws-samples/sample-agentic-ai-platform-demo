import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessAdminHandler,
} from "../lambda/access-admin/index.mjs";
import {
  AccessAdminServiceError,
} from "../lambda/access-admin/service.mjs";
import {
  createProductionIdentityProjector,
} from "../lambda/workspace/runtime.mjs";

const CLAIMS = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

function event({
  method = "GET",
  path = "/api/access/domain-members",
  headers = {},
  claims = CLAIMS,
  query,
  rawQueryString,
  body,
  requestId = "api-request-001",
} = {}) {
  return {
    version: "2.0",
    headers,
    ...(query === undefined
      ? {}
      : { queryStringParameters: query }),
    ...(rawQueryString === undefined
      ? {}
      : { rawQueryString }),
    ...(body === undefined
      ? {}
      : {
          body: typeof body === "string"
            ? body
            : JSON.stringify(body),
          isBase64Encoded: false,
        }),
    requestContext: {
      requestId,
      http: { method, path },
      authorizer: { jwt: { claims } },
    },
  };
}

function identityProjector() {
  return {
    projectAuthenticated(claims) {
      return {
        actor: claims.sub,
        role: "admin",
      };
    },
    projectEffective(claims, headers, { availableDomains }) {
      const role = headers?.["x-demo-role"] || "admin";
      const domain = headers?.["x-active-domain"] || null;
      if (
        (role === "lead" || role === "builder")
        && !availableDomains.some(({ id }) => id === domain)
      ) {
        const error = new Error("domain unavailable");
        error.code = domain
          ? "DEMO_DOMAIN_NOT_ALLOWED"
          : "DEMO_DOMAIN_REQUIRED";
        error.statusCode = 403;
        throw error;
      }
      return {
        actor: claims.sub,
        role,
        domain,
        domains: domain ? [domain] : availableDomains.map(({ id }) => id),
      };
    },
  };
}

function handlerWith({
  projector = identityProjector(),
  verifier = async () => true,
  directory,
  service,
} = {}) {
  const calls = [];
  const accessAdminService = {
    async listDomainMembers(input) {
      calls.push(["listDomainMembers", input]);
      return {
        domainId: input.domainId || input.identity.activeDomain,
        items: [],
        cursor: null,
      };
    },
    async grantDomainMembership(input) {
      calls.push(["grantDomainMembership", input]);
      return {
        domainId: input.domainId,
        username: input.username,
        subject: "member-sub",
        status: "ACTIVE",
        changed: true,
      };
    },
    async revokeDomainMembership(input) {
      calls.push(["revokeDomainMembership", input]);
      return {
        domainId: input.domainId,
        username: input.username,
        subject: "member-sub",
        status: "REVOKED",
        changed: true,
      };
    },
    async listProjectMembers(input) {
      calls.push(["listProjectMembers", input]);
      return {
        domainId: input.domainId || input.identity.activeDomain,
        projectId: input.projectId,
        items: [],
        cursor: null,
      };
    },
    async grantProjectMembership(input) {
      calls.push(["grantProjectMembership", input]);
      return {
        domainId: input.domainId,
        projectId: input.projectId,
        username: input.username,
        subject: "member-sub",
        status: "ACTIVE",
        changed: true,
      };
    },
    async revokeProjectMembership(input) {
      calls.push(["revokeProjectMembership", input]);
      return {
        domainId: input.domainId,
        projectId: input.projectId,
        username: input.username,
        subject: "member-sub",
        status: "REVOKED",
        changed: true,
      };
    },
    ...service,
  };
  const handler = createAccessAdminHandler({
    identityProjector: projector,
    identityVerifier: async (...args) => {
      calls.push(["verify", ...args]);
      return verifier(...args);
    },
    domainDirectory: directory || {
      async listActiveDomains() {
        calls.push(["domains"]);
        return [
          { id: "customer_support" },
          { id: "operations" },
          { id: "platform" },
        ];
      },
    },
    accessAdminService,
  });
  return { calls, handler };
}

function parsed(response) {
  return JSON.parse(response.body);
}

const stableHeaders = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
});

test("handler requires all injected trust-boundary dependencies", () => {
  assert.throws(
    () => createAccessAdminHandler(),
    /Access administration handler configuration is invalid/,
  );
});

test("all six routes dispatch exact safe service inputs", async () => {
  const { calls, handler } = handlerWith();
  const requests = [
    event({
      query: { domainId: "operations", limit: "25" },
      rawQueryString: "domainId=operations&limit=25",
    }),
    event({
      method: "POST",
      path: "/api/access/domain-memberships",
      headers: { "x-request-id": "domain-grant-001" },
      body: {
        domainId: "operations",
        username: "member.one",
        reason: "Assign the approved user to this domain.",
      },
    }),
    event({
      method: "POST",
      path: "/api/access/domain-membership-revocations",
      headers: { "x-request-id": "domain-revoke-001" },
      body: {
        domainId: "operations",
        username: "member.one",
        reason: "Remove the user's domain assignment.",
      },
    }),
    event({
      path: "/api/access/project-members",
      query: {
        domainId: "operations",
        projectId: "ops-assist",
        limit: "10",
      },
      rawQueryString:
        "domainId=operations&projectId=ops-assist&limit=10",
    }),
    event({
      method: "POST",
      path: "/api/access/project-memberships",
      headers: { "x-request-id": "project-grant-001" },
      body: {
        domainId: "operations",
        projectId: "ops-assist",
        username: "member.one",
        reason: "Assign the user to the approved project.",
      },
    }),
    event({
      method: "POST",
      path: "/api/access/project-membership-revocations",
      headers: { "x-request-id": "project-revoke-001" },
      body: {
        domainId: "operations",
        projectId: "ops-assist",
        username: "member.one",
        reason: "Remove the user's project assignment.",
      },
    }),
  ];

  for (const request of requests) {
    const response = await handler(request);
    assert.ok([200, 201].includes(response.statusCode));
    assert.deepEqual(response.headers, stableHeaders);
    assert.equal(parsed(response).ok, true);
  }

  assert.deepEqual(
    calls.filter(([name]) =>
      !["domains", "verify"].includes(name))
      .map(([name]) => name),
    [
      "listDomainMembers",
      "grantDomainMembership",
      "revokeDomainMembership",
      "listProjectMembers",
      "grantProjectMembership",
      "revokeProjectMembership",
    ],
  );
  const grant = calls.find(
    ([name]) => name === "grantProjectMembership",
  )[1];
  assert.deepEqual(grant, {
    identity: {
      actor: "operator-sub",
      role: "admin",
      activeDomain: null,
      domainIds: ["customer_support", "operations", "platform"],
    },
    requestId: "project-grant-001",
    domainId: "operations",
    projectId: "ops-assist",
    username: "member.one",
    reason: "Assign the user to the approved project.",
  });
});

test("production Platform Admin receives every authoritative active domain", async () => {
  const { calls, handler } = handlerWith({
    projector: createProductionIdentityProjector(),
    directory: {
      async listActiveDomains() {
        calls.push(["domains"]);
        return [
          { id: "customer_support" },
          { id: "new_customer_domain" },
          { id: "operations" },
          { id: "platform" },
        ];
      },
    },
  });
  const response = await handler(event({
    query: { domainId: "new_customer_domain", limit: "25" },
    rawQueryString: "domainId=new_customer_domain&limit=25",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    calls.find(([name]) => name === "listDomainMembers")[1].identity,
    {
      actor: "operator-sub",
      role: "admin",
      activeDomain: null,
      domainIds: [
        "customer_support",
        "new_customer_domain",
        "operations",
        "platform",
      ],
    },
  );
});

test("lead requests are forced to the authoritative selected domain", async () => {
  const { calls, handler } = handlerWith();
  const response = await handler(event({
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
    query: { projectId: "case-assist" },
    rawQueryString: "projectId=case-assist",
    path: "/api/access/project-members",
  }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    calls.find(([name]) => name === "listProjectMembers")[1].identity,
    {
      actor: "operator-sub",
      role: "lead",
      activeDomain: "customer_support",
      domainIds: ["customer_support"],
    },
  );
});

test("only valid Cognito access-token subjects can reach the service", async () => {
  for (const claims of [
    null,
    { sub: "operator-sub", token_use: "id" },
    { sub: "", token_use: "access" },
    { token_use: "access" },
  ]) {
    const { calls, handler } = handlerWith();
    const response = await handler(event({ claims }));
    assert.equal(response.statusCode, 401);
    assert.equal(parsed(response).code, "NOT_AUTHENTICATED");
    assert.equal(
      calls.some(([name]) => name === "listDomainMembers"),
      false,
    );
  }
});

test("immutable actor mismatch fails closed before service access", async () => {
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
  assert.equal(parsed(response).code, "IDENTITY_UNAVAILABLE");
  assert.equal(
    calls.some(([name]) => name === "listDomainMembers"),
    false,
  );
});

test("demo role switching is verified and invalid role/domain headers are rejected", async () => {
  const { calls, handler } = handlerWith();
  const allowed = await handler(event({
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
  }));
  assert.equal(allowed.statusCode, 200);
  assert.equal(
    calls.filter(([name]) => name === "verify").length,
    1,
  );

  for (const headers of [
    { "x-demo-role": "owner" },
    {
      "X-Demo-Role": "lead",
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
    {
      "x-demo-role": "lead",
      "x-active-domain": "foreign_domain",
    },
  ]) {
    const response = await handler(event({ headers }));
    assert.equal(response.statusCode, 403);
  }
});

test("GET queries are exact, bounded, and reject duplicate raw parameters", async () => {
  const invalid = [
    [{ unexpected: "value" }, "unexpected=value"],
    [{ limit: "0" }, "limit=0"],
    [{ limit: "51" }, "limit=51"],
    [{ limit: "01" }, "limit=01"],
    [{ cursor: "cursor with spaces" }, "cursor=cursor+with+spaces"],
    [{ domainId: "Operations" }, "domainId=Operations"],
    [{ projectId: "missing-domain" }, "projectId=missing-domain"],
    [{ domainId: "operations" }, "domainId=operations&domainId=platform"],
  ];
  for (const [query, rawQueryString] of invalid) {
    const { calls, handler } = handlerWith();
    const response = await handler(event({
      query,
      rawQueryString,
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(parsed(response).code, "INVALID_QUERY");
    assert.equal(
      calls.some(([name]) => name === "listDomainMembers"),
      false,
    );
  }
});

test("POST bodies are exact and require an explicit valid request ID", async () => {
  const body = {
    domainId: "operations",
    username: "member.one",
    reason: "Assign the approved user to this domain.",
  };
  const invalid = [
    event({
      method: "POST",
      path: "/api/access/domain-memberships",
      body,
    }),
    event({
      method: "POST",
      path: "/api/access/domain-memberships",
      headers: { "x-request-id": " request " },
      body,
    }),
    event({
      method: "POST",
      path: "/api/access/domain-memberships",
      headers: { "x-request-id": "request-001" },
      body: { ...body, groupName: "platform-admin" },
    }),
    event({
      method: "POST",
      path: "/api/access/domain-memberships",
      headers: { "x-request-id": "request-001" },
      body: { ...body, username: "member one" },
    }),
  ];

  for (const request of invalid) {
    const { calls, handler } = handlerWith();
    const response = await handler(request);
    assert.equal(response.statusCode, 400);
    assert.equal(
      calls.some(([name]) => name === "grantDomainMembership"),
      false,
    );
  }
});

test("unknown routes, GET bodies, and POST queries receive stable errors", async () => {
  const requests = [
    event({ path: "/api/access/unknown" }),
    event({ body: "{}" }),
    event({
      method: "POST",
      path: "/api/access/domain-memberships",
      headers: { "x-request-id": "request-001" },
      query: { domainId: "operations" },
      rawQueryString: "domainId=operations",
      body: {
        domainId: "operations",
        username: "member.one",
        reason: "Assign the approved user to this domain.",
      },
    }),
  ];
  for (const request of requests) {
    const { calls, handler } = handlerWith();
    const response = await handler(request);
    assert.ok([400, 404].includes(response.statusCode));
    assert.deepEqual(response.headers, stableHeaders);
    assert.equal(
      calls.some(([name]) =>
        name.startsWith("list") || name.startsWith("grant")),
      false,
    );
  }
});

test("service errors map to stable non-disclosing responses", async () => {
  const { handler } = handlerWith({
    service: {
      async listDomainMembers() {
        throw new AccessAdminServiceError("FORBIDDEN");
      },
    },
  });
  const response = await handler(event({ requestId: "denied-request" }));

  assert.deepEqual(parsed(response), {
    ok: false,
    code: "FORBIDDEN",
    message: "The requested access administration action is not allowed.",
    requestId: "denied-request",
    retryable: false,
  });
});

test("unexpected dependency failures return a non-disclosing availability error", async () => {
  const { handler } = handlerWith({
    service: {
      async listDomainMembers() {
        throw new Error("private-user-pool-id");
      },
    },
  });
  const response = await handler(event({
    requestId: "provider-failure",
  }));

  assert.equal(response.statusCode, 503);
  assert.equal(parsed(response).code, "ACCESS_ADMIN_UNAVAILABLE");
  assert.doesNotMatch(response.body, /private-user-pool-id/);
});

test("route responses reject extra or overridden service fields", async () => {
  const unsafeResponses = [
    {
      operation: "listDomainMembers",
      request: event(),
      result: {
        domainId: "operations",
        items: [],
        cursor: null,
        internalToken: "private-token",
      },
    },
    {
      operation: "grantDomainMembership",
      request: event({
        method: "POST",
        path: "/api/access/domain-memberships",
        headers: { "x-request-id": "domain-grant-unsafe" },
        body: {
          domainId: "operations",
          username: "member.one",
          reason: "Assign the approved user to this domain.",
        },
      }),
      result: {
        ok: false,
        domainId: "operations",
        username: "member.one",
        subject: "member-sub",
        status: "ACTIVE",
        changed: true,
      },
    },
  ];

  for (const { operation, request, result } of unsafeResponses) {
    const { handler } = handlerWith({
      service: {
        async [operation]() {
          return result;
        },
      },
    });
    const response = await handler(request);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(parsed(response), {
      ok: false,
      code: "ACCESS_ADMIN_UNAVAILABLE",
      message: "Access administration is temporarily unavailable.",
      requestId: request.requestContext.requestId,
      retryable: true,
    });
    assert.doesNotMatch(response.body, /private-token/);
  }
});
