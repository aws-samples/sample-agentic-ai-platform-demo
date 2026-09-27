import assert from "node:assert/strict";
import test from "node:test";
import {
  createGovernanceHandler,
} from "../lambda/governance/index.mjs";

const CLAIMS = {
  sub: "operator-sub",
  token_use: "access",
  "cognito:groups": "[\"platform-admin\",\"demo-operator\"]",
};

function event(routeKey, path, body, {
  role = "builder",
  domain = "customer_support",
  requestId = "governance-request",
  query,
} = {}) {
  const value = {
    routeKey,
    requestContext: {
      requestId: "api-request",
      http: {
        method: routeKey.split(" ")[0],
        path,
      },
      authorizer: {
        jwt: { claims: CLAIMS },
      },
    },
    headers: {
      "content-type": "application/json",
      "x-demo-role": role,
      "x-active-domain": domain,
    },
    isBase64Encoded: false,
  };
  if (requestId) value.headers["x-request-id"] = requestId;
  if (body !== undefined) value.body = JSON.stringify(body);
  if (query !== undefined) {
    value.queryStringParameters = query;
    value.rawQueryString = new URLSearchParams(query).toString();
  }
  return value;
}

function handlerWith(calls = []) {
  return createGovernanceHandler({
    identityProjector: {
      projectAuthenticated() {
        return {
          actor: "operator-sub",
          role: "admin",
        };
      },
      projectEffective(_claims, headers) {
        return {
          actor: "operator-sub",
          role: headers["x-demo-role"],
          domain: headers["x-active-domain"] || null,
        };
      },
    },
    async identityVerifier() {
      return true;
    },
    domainDirectory: {
      async listActiveDomains() {
        return [
          { id: "customer_support" },
          { id: "operations" },
          { id: "platform" },
        ];
      },
    },
    governanceService: {
      async readCatalogVisibility() { return { items: [] }; },
      async setCatalogVisibility() { return {}; },
      async readGuardrails(input) { calls.push(["guardrails", input]); return { controls: [] }; },
      async listGuardrailExceptions(input) { calls.push(["exceptions", input]); return { exemptions: [], cursor: null }; },
      async requestGuardrailException(input) { calls.push(["exception-request", input]); return { exception: { id: "exception-test" } }; },
      async decideGuardrailException(input) { calls.push(["exception-decision", input]); return { exception: { id: input.id } }; },
      async readHitlPolicies() { throw new Error("not configured"); },
      async publishAgent(input) {
        calls.push(["agent-publication", input]);
        return {
          record: {
            domainId: input.domainId,
            resourceType: "AGENT",
            resourceId: `${input.projectId}/${input.agentId}`,
            status: "PENDING_APPROVAL",
          },
          approval: {
            projectId: input.projectId,
            status: "PENDING",
          },
        };
      },
      async registerDraft(input) {
        calls.push(["register", input]);
        return {
          registryId: "CustReg123456",
          recordId: "Rec123456789",
          status: "DRAFT",
        };
      },
      async submitPublication(input) {
        calls.push(["submit", input]);
        return {
          record: { status: "PENDING_APPROVAL" },
          approval: { id: input.approvalId, status: "PENDING" },
        };
      },
      async initiatePublication(input) {
        calls.push(["initiate", input]);
        return {
          record: { status: "PENDING_APPROVAL" },
          approval: { id: "publish-initiated", status: "PENDING" },
        };
      },
      async decidePublication(input) {
        calls.push(["publication-decision", input]);
        return {
          record: { status: "APPROVED" },
          approval: { id: input.approvalId, status: "APPROVED" },
        };
      },
      async discoverShared(input) {
        calls.push(["discover", input]);
        return { items: [] };
      },
      async listAgentEntitlements(input) {
        calls.push(["entitlement-list", input]);
        return {
          items: [{
            subjectType: "GROUP",
            subject: "domain-customer-support-users",
            domainId: "customer_support",
            projectId: "case-assist",
            agentId: "triage-agent",
            status: "ACTIVE",
            expiresAt: null,
            grantedAt: "2026-08-25T08:00:00.000Z",
            revokedAt: null,
          }],
          cursor: null,
        };
      },
      async requestAccess(input) {
        calls.push(["access-request", input]);
        return { id: input.approvalId, status: "PENDING" };
      },
      async decideAccess(input) {
        calls.push(["access-decision", input]);
        return {
          approval: { id: input.approvalId, status: "APPROVED" },
          grant: { status: "ACTIVE" },
        };
      },
      async revokeAccess(input) {
        calls.push(["revoke", input]);
        return { status: "REVOKED" };
      },
      async grantAgentEntitlement(input) {
        calls.push(["entitlement-grant", input]);
        return {
          subjectType: input.subjectType,
          subject: input.subject,
          domainId: input.domainId,
          projectId: input.projectId,
          agentId: input.agentId,
          status: "ACTIVE",
        };
      },
      async revokeAgentEntitlement(input) {
        calls.push(["entitlement-revoke", input]);
        return {
          subjectType: input.subjectType,
          subject: input.subject,
          domainId: input.domainId,
          projectId: input.projectId,
          agentId: input.agentId,
          status: "REVOKED",
        };
      },
    },
  });
}

test("guardrails and exception queues use dedicated authenticated routes and strict request schemas", async () => {
  const calls=[],handler=handlerWith(calls);
  assert.equal((await handler(event("GET /api/governance/guardrails","/api/governance/guardrails",undefined))).statusCode,200);
  assert.equal((await handler(event("GET /api/policy-exemptions","/api/policy-exemptions",undefined,{query:{limit:"50"}}))).statusCode,200);
  const payload={domainId:"customer_support",projectId:"case-assist",guardrailId:"topic-restriction",reason:"Reviewed test scope",compensatingControls:"Reviewed dataset only",expiresAt:"2026-09-24T00:00:00.000Z"};
  assert.equal((await handler(event("POST /api/policy-exemption-request","/api/policy-exemption-request",payload))).statusCode,200);
  assert.equal((await handler(event("POST /api/policy-exemption-request","/api/policy-exemption-request",{...payload,status:"approved"}))).statusCode,400);
  assert.deepEqual(calls.map(([name])=>name),["guardrails","exceptions","exception-request"]);
  assert.equal(calls[2][1].identity.actor,"operator-sub");
});

test("builder registers a Registry draft with effective role and selected domain", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const response = await handler(event(
    "POST /api/governance/resources",
    "/api/governance/resources",
    {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "case-triage",
      displayName: "Case Triage",
      description: "Routes cases to an approved queue.",
      version: "1.0.0",
      shared: true,
      specification: {},
    },
  ));

  assert.equal(response.statusCode, 201);
  assert.equal(calls[0][0], "register");
  assert.deepEqual(calls[0][1].identity, {
    actor: "operator-sub",
    role: "builder",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  });
  assert.equal(calls[0][1].requestId, "governance-request");
});

test("builder submits a tested Agent to Registry with only authoritative references", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const response = await handler(event(
    "POST /api/governance/agent-publications",
    "/api/governance/agent-publications",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  ));

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls[0], [
    "agent-publication",
    {
      identity: {
        actor: "operator-sub",
        role: "builder",
        activeDomain: "customer_support",
        domainIds: ["customer_support"],
      },
      requestId: "governance-request",
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  ]);
});

test("publication and access routes call distinct governed operations", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const requests = [
    event(
      "POST /api/governance/publications",
      "/api/governance/publications",
      {
        approvalId: "publish-case-triage",
        registryId: "CustReg123456",
        recordId: "Rec123456789",
      },
    ),
    event(
      "POST /api/governance/publication-decisions",
      "/api/governance/publication-decisions",
      {
        approvalId: "publish-case-triage",
        decision: "APPROVE",
        reason: "Approved after domain review.",
      },
      { role: "lead" },
    ),
    event(
      "POST /api/governance/access-requests",
      "/api/governance/access-requests",
      {
        approvalId: "request-ops-tool",
        sourceDomainId: "operations",
        registryId: "OpsReg1234567",
        recordId: "Rec987654321",
      },
    ),
    event(
      "POST /api/governance/access-decisions",
      "/api/governance/access-decisions",
      {
        approvalId: "request-ops-tool",
        decision: "APPROVE",
        reason: "Approved for this domain.",
      },
      { role: "lead" },
    ),
    event(
      "POST /api/governance/access-revocations",
      "/api/governance/access-revocations",
      {
        resourceType: "TOOL",
        resourceId: "OpsReg1234567/Rec987654321",
        reason: "The dependency is no longer required.",
      },
      { role: "lead" },
    ),
  ];
  for (const request of requests) {
    const response = await handler(request);
    assert.ok([200, 201].includes(response.statusCode));
  }
  assert.deepEqual(calls.map(([name]) => name), [
    "submit",
    "publication-decision",
    "access-request",
    "access-decision",
    "revoke",
  ]);
});

test("Domain Lead grant and revoke routes pass strict typed entitlement requests", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const grant = await handler(event(
    "POST /api/governance/agent-entitlements",
    "/api/governance/agent-entitlements",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      subjectType: "GROUP",
      subject: "domain-customer-support-users",
      expiresAt: "2026-08-25T09:00:00.000Z",
      reason: "Grant the approved support group production access.",
    },
    { role: "lead", requestId: "grant-entitlement-request" },
  ));
  const revoke = await handler(event(
    "POST /api/governance/agent-entitlement-revocations",
    "/api/governance/agent-entitlement-revocations",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      subjectType: "GROUP",
      subject: "domain-customer-support-users",
      reason: "Remove access after the support rotation changed.",
    },
    { role: "lead", requestId: "revoke-entitlement-request" },
  ));

  assert.equal(grant.statusCode, 201, grant.body);
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.deepEqual(calls, [
    [
      "entitlement-grant",
      {
        identity: {
          actor: "operator-sub",
          role: "lead",
          activeDomain: "customer_support",
          domainIds: ["customer_support"],
        },
        requestId: "grant-entitlement-request",
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
        subjectType: "GROUP",
        subject: "domain-customer-support-users",
        expiresAt: "2026-08-25T09:00:00.000Z",
        reason: "Grant the approved support group production access.",
      },
    ],
    [
      "entitlement-revoke",
      {
        identity: {
          actor: "operator-sub",
          role: "lead",
          activeDomain: "customer_support",
          domainIds: ["customer_support"],
        },
        requestId: "revoke-entitlement-request",
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
        subjectType: "GROUP",
        subject: "domain-customer-support-users",
        reason: "Remove access after the support rotation changed.",
      },
    ],
  ]);
});

test("agent entitlement routes reject missing, extra, and malformed fields before service calls", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const valid = {
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
    subjectType: "USER",
    subject: "user-sub",
    expiresAt: null,
    reason: "Grant the approved user production access.",
  };
  const requests = [
    event(
      "POST /api/governance/agent-entitlements",
      "/api/governance/agent-entitlements",
      Object.fromEntries(
        Object.entries(valid).filter(([key]) => key !== "subject"),
      ),
      { role: "lead" },
    ),
    event(
      "POST /api/governance/agent-entitlements",
      "/api/governance/agent-entitlements",
      { ...valid, unexpected: true },
      { role: "lead" },
    ),
    event(
      "POST /api/governance/agent-entitlement-revocations",
      "/api/governance/agent-entitlement-revocations",
      {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
        subjectType: "TEAM",
        subject: "support-users",
        reason: "Remove access after the support rotation changed.",
      },
      { role: "lead" },
    ),
  ];

  for (const request of requests) {
    const response = await handler(request);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(calls.length, 0);
});

test("agent entitlement routes reject non-string domain and DOMAIN subject values without regex coercion", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const valid = {
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
    subjectType: "DOMAIN",
    subject: "customer_support",
    expiresAt: null,
    reason: "Grant the approved domain production access.",
  };
  const invalidValues = [
    null,
    undefined,
    {},
    { toString: "customer_support" },
  ];

  for (const value of invalidValues) {
    for (const field of ["domainId", "subject"]) {
      const body = { ...valid, [field]: value };
      const response = await handler(event(
        "POST /api/governance/agent-entitlements",
        "/api/governance/agent-entitlements",
        body,
        { role: "lead" },
      ));
      assert.equal(response.statusCode, 400, response.body);
    }
  }
  assert.equal(calls.length, 0);
});

test("shared discovery accepts only a bounded limit and no mutation ID", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const response = await handler(event(
    "GET /api/governance/shared-resources",
    "/api/governance/shared-resources",
    undefined,
    {
      requestId: "",
      query: { limit: "20" },
    },
  ));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls[0], [
    "discover",
    {
      identity: {
        actor: "operator-sub",
        role: "builder",
        activeDomain: "customer_support",
        domainIds: ["customer_support"],
      },
      limit: 20,
    },
  ]);

  const invalid = await handler(event(
    "GET /api/governance/shared-resources",
    "/api/governance/shared-resources",
    undefined,
    { query: { limit: "500" } },
  ));
  assert.equal(invalid.statusCode, 400);
});

test("Admin and Domain Lead list current typed entitlements with strict pagination", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const cursor = Buffer.from(JSON.stringify({
    v: 1,
    scope: "customer_support",
    pk: "ENTITLEMENT#GROUP#domain-customer-support-users",
    sk: "AGENT#customer_support#case-assist#triage-agent",
  })).toString("base64url");
  const response = await handler(event(
    "GET /api/governance/agent-entitlements",
    "/api/governance/agent-entitlements",
    undefined,
    {
      role: "lead",
      requestId: "",
      query: { limit: "25", cursor },
    },
  ));

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(calls[0], [
    "entitlement-list",
    {
      identity: {
        actor: "operator-sub",
        role: "lead",
        activeDomain: "customer_support",
        domainIds: ["customer_support"],
      },
      limit: 25,
      cursor,
    },
  ]);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    items: [{
      subjectType: "GROUP",
      subject: "domain-customer-support-users",
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      status: "ACTIVE",
      expiresAt: null,
      grantedAt: "2026-08-25T08:00:00.000Z",
      revokedAt: null,
    }],
    cursor: null,
  });

  for (const query of [
    { limit: "0" },
    { limit: "51" },
    { cursor: "not-canonical-base64url!" },
    { limit: "20", cursor, unexpected: "value" },
  ]) {
    const invalid = await handler(event(
      "GET /api/governance/agent-entitlements",
      "/api/governance/agent-entitlements",
      undefined,
      { role: "admin", requestId: "", query },
    ));
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  const leadDomainOverride = await handler(event(
    "GET /api/governance/agent-entitlements",
    "/api/governance/agent-entitlements",
    undefined,
    {
      role: "lead",
      requestId: "",
      query: { limit: "20", domainId: "operations" },
    },
  ));
  assert.equal(leadDomainOverride.statusCode, 400);
  assert.equal(calls.length, 1);
});

test("end user, malformed bodies, duplicate headers, and unknown routes fail before service calls", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const endUser = await handler(event(
    "POST /api/governance/resources",
    "/api/governance/resources",
    {},
    { role: "user", domain: "" },
  ));
  const malformed = await handler(event(
    "POST /api/governance/resources",
    "/api/governance/resources",
    { unexpected: true },
  ));
  const duplicate = event(
    "POST /api/governance/publications",
    "/api/governance/publications",
    {
      approvalId: "publish-case-triage",
      registryId: "CustReg123456",
      recordId: "Rec123456789",
    },
  );
  duplicate.headers["X-Request-Id"] = "another-request";
  const duplicated = await handler(duplicate);
  const unknown = await handler(event(
    "POST /api/governance/unknown",
    "/api/governance/unknown",
    {},
  ));

  assert.equal(endUser.statusCode, 403);
  assert.equal(malformed.statusCode, 400);
  assert.equal(duplicated.statusCode, 400);
  assert.equal(unknown.statusCode, 404);
  assert.equal(calls.length, 0);
});

test("role switching requires the current token subject to remain demo operator", async () => {
  const handler = createGovernanceHandler({
    identityProjector: {
      projectAuthenticated() {
        return { actor: "operator-sub", role: "admin" };
      },
      projectEffective() {
        throw new Error("must not project");
      },
    },
    async identityVerifier() {
      return false;
    },
    domainDirectory: {
      async listActiveDomains() {
        return [{ id: "customer_support" }];
      },
    },
    governanceService: Object.fromEntries(
      [
        "readHitlPolicies",
        "readCatalogVisibility",
        "setCatalogVisibility",
        "registerDraft",
        "publishAgent",
        "submitPublication",
        "initiatePublication",
        "decidePublication",
        "discoverShared",
        "listAgentEntitlements",
        "requestAccess",
        "decideAccess",
        "revokeAccess",
        "grantAgentEntitlement",
        "revokeAgentEntitlement",
      ].map((name) => [name, async () => {
        throw new Error("must not call");
      }]),
    ),
  });

  const response = await handler(event(
    "POST /api/governance/resources",
    "/api/governance/resources",
    {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "case-triage",
      displayName: "Case Triage",
      description: "Routes cases to an approved queue.",
      version: "1.0.0",
      shared: true,
      specification: {},
    },
  ));
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "DEMO_ROLE_NOT_ALLOWED");
});
