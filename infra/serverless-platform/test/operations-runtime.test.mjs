import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationsRuntime,
} from "../lambda/operations/handler-runtime.mjs";

const claims = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:username": "deployment-operator",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

function event({
  path = "/api/operations",
  method = "GET",
  headers,
  body,
  requestClaims = claims,
} = {}) {
  return {
    version: "2.0",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    requestContext: {
      requestId: "operations-runtime-request",
      http: { method, path },
      authorizer: { jwt: { claims: requestClaims } },
    },
  };
}

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support agent workspace.",
    ownerSubject: "operator-sub",
    memberSubjects: [],
    status: "ACTIVE",
    createdBySubject: "operator-sub",
    createdAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function aggregate(overrides = {}) {
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

function activeBreakGlass(overrides = {}) {
  return {
    id: "break-glass-runtime-incident",
    domainId: "customer_support",
    projectId: "case-assist",
    resource: "case-assist",
    action: "workspace.incidents.create",
    status: "ACTIVE",
    requesterSubject: "operator-sub",
    reason: "Investigate the customer support incident.",
    requestedAt: "2026-08-24T23:30:00.000Z",
    expiresAt: "2026-08-25T00:30:00.000Z",
    approverSubject: "peer-admin-sub",
    decisionReason: "Peer approved.",
    decidedAt: "2026-08-24T23:31:00.000Z",
    activatedBySubject: "operator-sub",
    activationReason: "Begin incident response.",
    activatedAt: "2026-08-24T23:32:00.000Z",
    revokedBySubject: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  };
}

function runtimeWith({
  breakGlassRecords = [],
  domainRecords = [
    { id: "customer_support" },
    { id: "operations" },
  ],
  projectRecords = [project()],
} = {}) {
  const calls = [];
  const runtime = createOperationsRuntime({
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
        return {
          items: projectRecords.filter(
            ({ domainId }) => domainId === input.domainId,
          ),
          cursor: null,
        };
      },
      async getProject(input) {
        calls.push(["get-project", input]);
        return projectRecords.find(
          ({ domainId, id }) =>
            domainId === input.domainId && id === input.projectId,
        ) ?? null;
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
      async listBreakGlass(input) {
        calls.push(["break-glass", input]);
        return { items: breakGlassRecords, cursor: null };
      },
      async getBreakGlass() {
        return null;
      },
      async putBreakGlass({ record }) {
        return record;
      },
    },
    domainDirectory: {
      async listActiveDomains(input) {
        calls.push(["domains", input]);
        return domainRecords;
      },
    },
    cloudWatchProvider: {
      async listRuntimeAggregates(input) {
        calls.push(["cloudwatch", input]);
        if (input.scope.type === "platform") {
          return { items: [aggregate()], cursor: null };
        }
        if (input.scope.type === "domain") {
          return {
            items: [aggregate({
              scopeType: "domain",
              domainId: input.scope.domainIds[0],
            })],
            cursor: null,
          };
        }
        return {
          items: input.scope.projectIds.map((value) => {
            const [domainId, projectId] = value.split("/");
            return aggregate({
              scopeType: "project",
              domainId,
              projectId,
            });
          }),
          cursor: null,
        };
      },
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
    },
    identityVerifier: async () => true,
    clock: () => Date.parse("2026-08-25T00:00:00.000Z"),
    cursorSigningKey:
      "test-only-operations-runtime-cursor-signing-key",
  });
  return { calls, runtime };
}

test("operations runtime composes canonical platform authorization", async () => {
  const { calls, runtime } = runtimeWith();

  const response = await runtime(event());

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.scope, { type: "platform" });
  assert.deepEqual(body.items, [aggregate()]);
  assert.deepEqual(
    calls.filter(([name]) => name === "cloudwatch")[0][1].scope,
    {
      type: "platform",
      domainIds: ["customer_support", "operations"],
      projectIds: ["customer_support/case-assist"],
    },
  );
});

test("operations runtime enforces selected domain and owned Builder projects", async () => {
  const { calls, runtime } = runtimeWith();

  const response = await runtime(event({
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
  }));

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.deepEqual(body.scope, {
    type: "projects",
    domainId: "customer_support",
    projectIds: ["case-assist"],
  });
  assert.deepEqual(body.items, [aggregate({
    scopeType: "project",
    domainId: "customer_support",
    projectId: "case-assist",
  })]);
  assert.deepEqual(
    calls.filter(([name]) => name === "cloudwatch")[0][1].scope,
    {
      type: "projects",
      domainIds: ["customer_support"],
      projectIds: ["customer_support/case-assist"],
    },
  );
});

test("operations runtime authorizes audit, incident, and break-glass capabilities by canonical role", async () => {
  const { runtime } = runtimeWith();

  const audit = await runtime(event({
    path: "/api/operations/audit",
  }));
  assert.equal(audit.statusCode, 200);
  assert.equal(JSON.parse(audit.body).resource, "audit");

  const incidents = await runtime(event({
    path: "/api/incidents",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
  }));
  assert.equal(incidents.statusCode, 200);
  assert.equal(JSON.parse(incidents.body).resource, "incidents");

  const breakGlass = await runtime(event({
    path: "/api/break-glass",
  }));
  assert.equal(breakGlass.statusCode, 200);
  assert.equal(JSON.parse(breakGlass.body).resource, "break-glass");

  const builderAudit = await runtime(event({
    path: "/api/operations/audit",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
  }));
  assert.equal(builderAudit.statusCode, 403);

  const incidentBody = {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "runtime-incident",
    title: "Elevated runtime failures",
    description: "The runtime failure rate exceeded the alert threshold.",
    severity: "HIGH",
    reason: "Reported after validating runtime health.",
  };
  const builderCreate = await runtime(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
      "x-request-id": "builder-create-incident",
    },
    body: incidentBody,
  }));
  assert.equal(builderCreate.statusCode, 403);

  const adminCreateDenied = await runtime(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-request-id": "admin-create-incident",
    },
    body: incidentBody,
  }));
  assert.equal(adminCreateDenied.statusCode, 403);

  const granted = runtimeWith({
    breakGlassRecords: [activeBreakGlass()],
  });
  const adminCreate = await granted.runtime(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-request-id": "admin-create-incident-with-break-glass",
    },
    body: incidentBody,
  }));
  assert.equal(adminCreate.statusCode, 201);
  assert.equal(
    JSON.parse(adminCreate.body).incident.reporterSubject,
    "operator-sub",
  );
  assert.equal(
    granted.calls.filter(([name]) => name === "break-glass").length,
    1,
  );

  const platformProject = project({
    domainId: "platform",
    id: "platform-operations",
  });
  const platform = runtimeWith({
    domainRecords: [
      { id: "customer_support" },
      { id: "operations" },
      { id: "platform" },
    ],
    projectRecords: [platformProject],
  });
  const platformCreate = await platform.runtime(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-request-id": "admin-create-platform-incident",
    },
    body: {
      ...incidentBody,
      domainId: "platform",
      projectId: "platform-operations",
      id: "platform-runtime-incident",
    },
  }));
  assert.equal(
    platformCreate.statusCode,
    201,
    JSON.stringify({
      body: JSON.parse(platformCreate.body),
      calls: platform.calls,
    }),
  );
  assert.equal(
    platform.calls.filter(([name]) => name === "break-glass").length,
    0,
  );
});

test("operations runtime fails closed on incomplete dependencies", () => {
  assert.throws(
    () => createOperationsRuntime(),
    /operations runtime configuration is invalid/i,
  );
  assert.throws(
    () => createOperationsRuntime({
      workspaceState: {
        beginTransaction() {},
        getMutationResult() {},
        listProjects() {},
        getProject() {},
        listIncidents() {},
        getIncident() {},
        putIncident() {},
        listAuditMetadata() {},
        listBreakGlass() {},
        getBreakGlass() {},
        putBreakGlass() {},
      },
      domainDirectory: { listActiveDomains() {} },
      cloudWatchProvider: { listRuntimeAggregates() {} },
      usageProvider: {
        listInvocationUsageAggregates() {},
        listBudgets() {},
      },
      identityVerifier() {},
      clock() {},
      cursorSigningKey: "too-short",
    }),
    /cursor signing key is invalid/i,
  );
});
