import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationsHandler,
} from "../lambda/operations/index.mjs";

const NOW = Date.parse("2026-08-25T03:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

function claims(subject = "operator-sub") {
  return {
    sub: subject,
    token_use: "access",
    "cognito:groups": ["platform-admin", "demo-operator"],
  };
}

function event({
  path,
  method = "GET",
  subject = "operator-sub",
  headers = {},
  queryStringParameters,
  rawQueryString,
  body,
  requestId = "operations-workflow-request",
} = {}) {
  return {
    version: "2.0",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    queryStringParameters,
    rawQueryString,
    requestContext: {
      requestId,
      http: { method, path },
      authorizer: { jwt: { claims: claims(subject) } },
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
    memberSubjects: [],
    status: "ACTIVE",
    createdBySubject: "operator-sub",
    createdAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function audit() {
  return {
    resource: "incident/customer_support/case-assist/incident-001",
    timestamp: NOW_ISO,
    requestId: "incident-request-001",
    actor: "operator-sub",
    requesterSubject: "operator-sub",
    effectiveRole: "lead",
    action: "incident.create",
    decision: "report",
    reason: "Reported after runtime alert validation.",
    domainId: "customer_support",
    projectId: "case-assist",
  };
}

function identityProjector() {
  return {
    projectAuthenticated(requestClaims) {
      return { actor: requestClaims.sub, role: "admin" };
    },
    projectEffective(requestClaims, headers, { availableDomains }) {
      const role = headers?.["x-demo-role"] ?? "admin";
      const domain = headers?.["x-active-domain"] ?? null;
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

function handlerWith() {
  const calls = [];
  const projects = [project()];
  const incidents = new Map();
  const grants = new Map();
  const state = {
    beginTransaction() {
      return Object.freeze({
        timestamp: NOW_ISO,
        epochSeconds: Math.floor(NOW / 1000),
      });
    },
    async getMutationResult() {
      return null;
    },
    async listProjects(input) {
      calls.push(["listProjects", input]);
      return {
        items: projects.filter(
          ({ domainId }) => domainId === input.domainId,
        ),
        cursor: null,
      };
    },
    async getProject(input) {
      calls.push(["getProject", input]);
      return projects.find(
        ({ domainId, id }) =>
          domainId === input.domainId && id === input.projectId,
      ) ?? null;
    },
    async listIncidents(input) {
      calls.push(["listIncidents", input]);
      return {
        items: [...incidents.values()].filter((record) =>
          record.domainId === input.domainId
          && (
            input.ownerSubject === undefined
            || record.ownerSubject === input.ownerSubject
          )),
        cursor: null,
      };
    },
    async getIncident(input) {
      calls.push(["getIncident", input]);
      return incidents.get(`${input.domainId}/${input.incidentId}`) ?? null;
    },
    async putIncident(input) {
      calls.push(["putIncident", structuredClone(input)]);
      incidents.set(
        `${input.record.domainId}/${input.record.id}`,
        structuredClone(input.record),
      );
      return input.record;
    },
    async listAuditMetadata(input) {
      calls.push(["listAuditMetadata", input]);
      return { items: [audit()], cursor: null };
    },
    async listBreakGlass(input) {
      calls.push(["listBreakGlass", input]);
      return { items: [...grants.values()], cursor: null };
    },
    async getBreakGlass(input) {
      calls.push(["getBreakGlass", input]);
      return grants.get(input.breakGlassId) ?? null;
    },
    async putBreakGlass(input) {
      calls.push(["putBreakGlass", structuredClone(input)]);
      grants.set(input.record.id, structuredClone(input.record));
      return input.record;
    },
  };
  const handler = createOperationsHandler({
    identityProjector: identityProjector(),
    identityVerifier: async () => true,
    domainDirectory: {
      async listActiveDomains() {
        return [
          { id: "customer_support" },
          { id: "operations" },
        ];
      },
    },
    workspaceState: state,
    authorizer: async (input) => {
      calls.push(["authorize", input]);
      return { ok: true };
    },
    cloudWatchProvider: {
      async listRuntimeAggregates() {
        return { items: [], cursor: null };
      },
    },
    usageProvider: {
      async listInvocationUsageAggregates() {
        return { items: [], cursor: null };
      },
      async listBudgets() {
        return [];
      },
    },
    clock: () => NOW,
    cursorSigningKey:
      "test-only-operations-handler-workflow-signing-key",
  });
  return { calls, grants, incidents, handler };
}

function body(response) {
  return JSON.parse(response.body);
}

test("audit and incident GET routes dispatch scoped metadata without trace content", async () => {
  const { handler } = handlerWith();
  const auditResponse = await handler(event({
    path: "/api/operations/audit",
  }));
  assert.equal(auditResponse.statusCode, 200);
  assert.equal(body(auditResponse).resource, "audit");
  assert.equal(JSON.stringify(body(auditResponse)).includes("trace"), false);

  const incidentResponse = await handler(event({
    path: "/api/incidents",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
  }));
  assert.equal(incidentResponse.statusCode, 200);
  assert.equal(body(incidentResponse).resource, "incidents");

  const denied = await handler(event({
    path: "/api/operations/audit",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
  }));
  assert.equal(denied.statusCode, 403);
  assert.equal(body(denied).code, "FORBIDDEN");
});

test("Builder incident reporting is denied and Lead reporting uses the Cognito subject", async () => {
  const { calls, handler } = handlerWith();
  const requestBody = {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "incident-001",
    title: "Elevated agent failures",
    description: "The support agent is returning an elevated error rate.",
    severity: "HIGH",
    reason: "Reported after runtime alert validation.",
  };
  const builderDenied = await handler(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
      "x-request-id": "builder-create-incident",
    },
    body: requestBody,
  }));
  assert.equal(builderDenied.statusCode, 403);
  assert.equal(body(builderDenied).code, "FORBIDDEN");

  const missingId = await handler(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
    body: requestBody,
  }));
  assert.equal(missingId.statusCode, 400);
  assert.equal(body(missingId).code, "INVALID_REQUEST_ID");

  const response = await handler(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "create-incident-001",
    },
    body: requestBody,
  }));
  assert.equal(response.statusCode, 201);
  assert.equal(body(response).incident.reporterSubject, "operator-sub");
  const write = calls.find(([name]) => name === "putIncident")[1];
  assert.equal(write.mutation.actor, "operator-sub");
  assert.equal(write.mutation.requesterSubject, "operator-sub");
});

test("incident action routes bind the path ID and exact lifecycle action", async () => {
  const { handler } = handlerWith();
  const created = await handler(event({
    path: "/api/incidents",
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "create-incident-001",
    },
    body: {
      domainId: "customer_support",
      projectId: "case-assist",
      id: "incident-001",
      title: "Elevated agent failures",
      description: "The support agent is returning an elevated error rate.",
      severity: "HIGH",
      reason: "Reported after runtime alert validation.",
    },
  }));
  assert.equal(created.statusCode, 201);

  const response = await handler(event({
    path: "/api/incidents/incident-001/actions",
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "acknowledge-incident-001",
    },
    body: {
      action: "acknowledge",
      reason: "Response ownership accepted.",
    },
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(body(response).incident.status, "ACKNOWLEDGED");
  assert.equal(
    body(response).incident.acknowledgedBySubject,
    "operator-sub",
  );
});

test("break-glass routes enforce Admin-only peer approval and requester activation", async () => {
  const { handler } = handlerWith();
  const denied = await handler(event({
    path: "/api/break-glass/requests",
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "lead-break-glass",
    },
    body: {
      id: "break-glass-001",
      domainId: "customer_support",
      projectId: "case-assist",
      resource: "trace/customer_support/case-assist/trace-001",
      action: "trace:read-content",
      reason: "Lead cannot request platform break-glass.",
      durationMinutes: 30,
    },
  }));
  assert.equal(denied.statusCode, 403);

  const requested = await handler(event({
    path: "/api/break-glass/requests",
    method: "POST",
    subject: "requester-admin-sub",
    headers: { "x-request-id": "request-break-glass" },
    body: {
      id: "break-glass-001",
      domainId: "customer_support",
      projectId: "case-assist",
      resource: "trace/customer_support/case-assist/trace-001",
      action: "trace:read-content",
      reason: "Investigate a critical production incident.",
      durationMinutes: 30,
    },
  }));
  assert.equal(requested.statusCode, 201);

  const approved = await handler(event({
    path: "/api/break-glass/decisions",
    method: "POST",
    subject: "approver-admin-sub",
    headers: { "x-request-id": "approve-break-glass" },
    body: {
      id: "break-glass-001",
      decision: "approve",
      reason: "Peer review confirmed the exact resource and action.",
    },
  }));
  assert.equal(approved.statusCode, 200);
  assert.equal(body(approved).breakGlass.status, "APPROVED");

  const activated = await handler(event({
    path: "/api/break-glass/activations",
    method: "POST",
    subject: "requester-admin-sub",
    headers: { "x-request-id": "activate-break-glass" },
    body: {
      id: "break-glass-001",
      reason: "Begin the approved incident investigation.",
    },
  }));
  assert.equal(activated.statusCode, 200);
  assert.equal(body(activated).breakGlass.status, "ACTIVE");

  const revoked = await handler(event({
    path: "/api/break-glass/revocations",
    method: "POST",
    subject: "approver-admin-sub",
    headers: { "x-request-id": "revoke-break-glass" },
    body: {
      id: "break-glass-001",
      reason: "Investigation completed before expiry.",
    },
  }));
  assert.equal(revoked.statusCode, 200);
  assert.equal(body(revoked).breakGlass.status, "REVOKED");

  const listed = await handler(event({
    path: "/api/break-glass",
  }));
  assert.equal(listed.statusCode, 200);
  assert.equal(body(listed).items[0].effectiveStatus, "REVOKED");
});
