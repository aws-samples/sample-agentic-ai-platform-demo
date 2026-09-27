import assert from "node:assert/strict";
import test from "node:test";
import {
  ListRegistryRecordsCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import * as governanceRuntime
  from "../lambda/governance/runtime.mjs";
import {
  createGovernanceRuntime,
} from "../lambda/governance/runtime.mjs";

const DOMAIN = {
  id: "customer_support",
  registryId: "CustReg123456",
  registryArn:
    "arn:aws:agent-registry:us-west-2:111122223333:"
    + "registry/CustReg123456",
  status: "ACTIVE",
};
const FOREIGN_DOMAIN = {
  id: "operations",
  registryId: "OpsReg1234567",
  registryArn:
    "arn:aws:agent-registry:us-west-2:111122223333:"
    + "registry/OpsReg1234567",
  status: "ACTIVE",
};

function activeBreakGlass(overrides = {}) {
  return {
    id: "admin-governance-grant",
    domainId: "customer_support",
    projectId: null,
    resource: "case-triage",
    action: "resource:draft-register",
    status: "ACTIVE",
    requesterSubject: "operator-sub",
    reason: "Restore a domain Registry record during an incident.",
    requestedAt: "2026-08-25T07:30:00.000Z",
    expiresAt: "2026-08-25T08:30:00.000Z",
    approverSubject: "peer-admin-sub",
    decisionReason: "Peer approved.",
    decidedAt: "2026-08-25T07:31:00.000Z",
    activatedBySubject: "operator-sub",
    activationReason: "Begin the approved recovery.",
    activatedAt: "2026-08-25T07:32:00.000Z",
    revokedBySubject: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  };
}

function state({
  approvals = [],
  breakGlassRecords = [],
  breakGlassCalls = [],
  currentEntitlement = null,
  entitlementPage = { items: [], cursor: null },
  entitlementListCalls = [],
  agent = null,
  deployments = { items: [], cursor: null },
  writes = [],
} = {}) {
  return {
    beginTransaction() {
      return {
        timestamp: "2026-08-25T08:00:00.000Z",
        epochSeconds: 1787644800,
      };
    },
    async getApproval({ domainId, approvalId }) {
      return approvals.find(
        (approval) =>
          approval.domainId === domainId
          && approval.id === approvalId,
      ) ?? null;
    },
    async getResourceGrant() {
      return null;
    },
    async getEntitlement() {
      return currentEntitlement;
    },
    async listAgentEntitlements(input) {
      entitlementListCalls.push(structuredClone(input));
      return structuredClone(entitlementPage);
    },
    async getProject() {
      return null;
    },
    async getAgent() {
      return agent;
    },
    async listDeployments() {
      return deployments;
    },
    async listBreakGlass({ requesterSubject }) {
      breakGlassCalls.push(requesterSubject);
      return {
        items: breakGlassRecords.filter(
          (record) => record.requesterSubject === requesterSubject,
        ),
        cursor: null,
      };
    },
    async getMutationResult() {
      return null;
    },
    async getMutationClaim() {
      return null;
    },
    async claimMutation() {
      return true;
    },
    async appendAudit({ record }) {
      return record;
    },
    async putApproval({ record }) {
      return record;
    },
    async putResourceGrant({ record }) {
      return record;
    },
    async putEntitlement(input) {
      writes.push(input);
      currentEntitlement = input.record;
      return input.record;
    },
    async putAccessDecision(input) {
      return {
        approval: input.approval.record,
        ...(input.grant
          ? { grant: input.grant.record }
          : { entitlement: input.entitlement.record }),
      };
    },
  };
}

function event({
  routeKey = "GET /api/governance/shared-resources",
  method = "GET",
  path = "/api/governance/shared-resources",
  headers = {
    "x-demo-role": "builder",
    "x-active-domain": "customer_support",
  },
  body,
} = {}) {
  return {
    version: "2.0",
    routeKey,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(method === "GET"
      ? {
          queryStringParameters: { limit: "20" },
          rawQueryString: "limit=20",
        }
      : {}),
    requestContext: {
      requestId: "api-request-123",
      http: {
        method,
        path,
      },
      authorizer: {
        jwt: {
          claims: {
            sub: "operator-sub",
            token_use: "access",
            "cognito:groups": ["platform-admin", "demo-operator"],
          },
        },
      },
    },
  };
}

test("governance mutation claim resolver reads one exact consistent claim", async () => {
  const claim = {
    actor: "operator-sub",
    requesterSubject: "builder-sub",
    effectiveRole: "lead",
    domainId: "customer_support",
    projectId: null,
    route: "POST /api/governance/publication-decisions",
    requestId: "publication-decision-retry",
    payloadFingerprint: "a".repeat(64),
    resourceKey: "approval/customer_support/publication-approval",
    operation: "UPDATE",
  };
  const item = {
    pk: { S: `MUTATION#${claim.actor}` },
    sk: { S: `CLAIM#${claim.route}#${claim.requestId}` },
    entityType: { S: "MUTATION_CLAIM" },
    actor: { S: claim.actor },
    requesterSubject: { S: claim.requesterSubject },
    effectiveRole: { S: claim.effectiveRole },
    domainId: { S: claim.domainId },
    projectId: { NULL: true },
    route: { S: claim.route },
    requestId: { S: claim.requestId },
    payloadFingerprint: { S: claim.payloadFingerprint },
    resourceKey: { S: claim.resourceKey },
    operation: { S: claim.operation },
    createdAt: { S: "2026-08-25T08:00:00.000Z" },
  };
  const calls = [];
  const resolver =
    governanceRuntime.createGovernanceMutationClaimResolver({
      tableName: "platform-state",
      dynamo: {
        async send(command) {
          calls.push(command);
          return { Item: item };
        },
      },
    });

  assert.deepEqual(await resolver({
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
  }), claim);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof GetItemCommand);
  assert.deepEqual(calls[0].input, {
    TableName: "platform-state",
    Key: {
      pk: { S: `MUTATION#${claim.actor}` },
      sk: { S: `CLAIM#${claim.route}#${claim.requestId}` },
    },
    ConsistentRead: true,
  });
});

test("governance runtime composes scoped Agent Registry discovery", async () => {
  const calls = [];
  const runtime = createGovernanceRuntime({
    workspaceState: state(),
    domainDirectory: {
      async getDomain(id) {
        return [DOMAIN, FOREIGN_DOMAIN].find(
          (item) => item.id === id,
        ) ?? null;
      },
      async listActiveDomains() {
        return [DOMAIN, FOREIGN_DOMAIN];
      },
    },
    registryClient: {
      async send(command) {
        calls.push(command);
        assert.ok(command instanceof ListRegistryRecordsCommand);
        assert.equal(command.input.registryId, FOREIGN_DOMAIN.registryId);
        return { registryRecords: [] };
      },
    },
    identityVerifier: async () => true,
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  });

  const response = await runtime(event());
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.ok, true);
  assert.deepEqual(body.items, []);
  assert.equal(calls.length, 1);
});

test("governance runtime lists safe entitlements for the selected Domain Lead domain", async () => {
  const entitlementListCalls = [];
  const runtime = createGovernanceRuntime({
    workspaceState: state({
      entitlementListCalls,
      entitlementPage: {
        items: [{
          subjectType: "GROUP",
          subject: "domain-customer-support-users",
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "triage-agent",
          status: "ACTIVE",
          expiresAt: null,
          grantedBySubject: "lead-sub",
          grantedAt: "2026-08-25T08:00:00.000Z",
          revokedBySubject: null,
          revokedAt: null,
        }],
        cursor: null,
      },
    }),
    domainDirectory: {
      async getDomain(id) {
        return id === DOMAIN.id ? DOMAIN : null;
      },
      async listActiveDomains() {
        return [DOMAIN, FOREIGN_DOMAIN];
      },
    },
    registryClient: {
      async send() {
        throw new Error("Registry must not be called.");
      },
    },
    identityVerifier: async () => true,
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  });

  const response = await runtime(event({
    routeKey: "GET /api/governance/agent-entitlements",
    method: "GET",
    path: "/api/governance/agent-entitlements",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
  }));

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(entitlementListCalls, [{
    domainId: "customer_support",
    limit: 20,
  }]);
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
});

test("governance runtime persists a typed domain entitlement for one ready production deployment", async () => {
  const writes = [];
  const runtime = createGovernanceRuntime({
    workspaceState: state({
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "triage-agent",
        status: "PRODUCTION_DEPLOYED",
      },
      deployments: {
        items: [{
          domainId: "customer_support",
          projectId: "case-assist",
          id: "triage-agent-production",
          agentId: "triage-agent",
          environment: "PRODUCTION",
          status: "DEPLOYED",
          runtimeStatus: "READY",
        }],
        cursor: null,
      },
      writes,
    }),
    domainDirectory: {
      async getDomain(id) {
        return id === DOMAIN.id ? DOMAIN : null;
      },
      async listActiveDomains() {
        return [DOMAIN];
      },
    },
    registryClient: {
      async send() {
        throw new Error("Registry must not be called.");
      },
    },
    identityVerifier: async () => true,
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  });

  const response = await runtime(event({
    routeKey: "POST /api/governance/agent-entitlements",
    method: "POST",
    path: "/api/governance/agent-entitlements",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "grant-runtime-entitlement",
    },
    body: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      subjectType: "DOMAIN",
      subject: "customer_support",
      expiresAt: null,
      reason: "Grant the approved domain production access.",
    },
  }));

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].record, {
    subjectType: "DOMAIN",
    subject: "customer_support",
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
    status: "ACTIVE",
    expiresAt: null,
    grantedBySubject: "operator-sub",
    grantedAt: "2026-08-25T08:00:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
  });
  assert.equal(writes[0].expectedStatus, null);
  assert.equal(writes[0].mutation.actor, "operator-sub");
});

test("Platform Admin requires matching break-glass for a foreign-domain entitlement grant", async () => {
  const request = event({
    routeKey: "POST /api/governance/agent-entitlements",
    method: "POST",
    path: "/api/governance/agent-entitlements",
    headers: {
      "x-demo-role": "admin",
      "x-active-domain": "operations",
      "x-request-id": "admin-foreign-entitlement",
    },
    body: {
      domainId: "operations",
      projectId: "case-assist",
      agentId: "triage-agent",
      subjectType: "DOMAIN",
      subject: "operations",
      expiresAt: null,
      reason: "Restore approved production access during an incident.",
    },
  });
  const createRuntime = (breakGlassRecords) => createGovernanceRuntime({
    workspaceState: state({
      breakGlassRecords,
      agent: {
        domainId: "operations",
        projectId: "case-assist",
        id: "triage-agent",
        status: "PRODUCTION_DEPLOYED",
      },
      deployments: {
        items: [{
          domainId: "operations",
          projectId: "case-assist",
          id: "triage-agent-production",
          agentId: "triage-agent",
          environment: "PRODUCTION",
          status: "DEPLOYED",
          runtimeStatus: "READY",
        }],
        cursor: null,
      },
    }),
    domainDirectory: {
      async getDomain(id) {
        return [DOMAIN, FOREIGN_DOMAIN].find(
          (item) => item.id === id,
        ) ?? null;
      },
      async listActiveDomains() {
        return [DOMAIN, FOREIGN_DOMAIN];
      },
    },
    registryClient: {
      async send() {
        throw new Error("Registry must not be called.");
      },
    },
    identityVerifier: async () => true,
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  });

  const denied = await createRuntime([])(request);
  assert.equal(denied.statusCode, 403, denied.body);

  const allowed = await createRuntime([
    activeBreakGlass({
      domainId: "operations",
      resource: "case-assist/triage-agent",
      action: "agent:entitlement-grant",
    }),
  ])(request);
  assert.equal(allowed.statusCode, 201, allowed.body);

  const wrongProject = await createRuntime([
    activeBreakGlass({
      domainId: "operations",
      resource: "other-project/triage-agent",
      action: "agent:entitlement-grant",
    }),
  ])(request);
  assert.equal(wrongProject.statusCode, 403, wrongProject.body);
});

test("governance runtime fails configuration closed", () => {
  assert.throws(
    () => createGovernanceRuntime(),
    /configuration is invalid/i,
  );
});

test("governance authorizer resolves an active Platform Admin break-glass grant", async () => {
  const breakGlassCalls = [];
  assert.equal(
    typeof governanceRuntime.createGovernanceAuthorizer,
    "function",
  );
  const authorizer = governanceRuntime.createGovernanceAuthorizer({
    workspaceState: state({
      breakGlassRecords: [activeBreakGlass()],
      breakGlassCalls,
    }),
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
  });
  const reference = Buffer.from(JSON.stringify({
    v: 1,
    id: "case-triage",
    domainId: "customer_support",
    lifecycleState: "ACTIVE",
  })).toString("base64url");
  const result = await authorizer({
    requestContext: {
      source: "governance-service",
      subject: "operator-sub",
      role: "admin",
      activeDomain: "customer_support",
      domainIds: ["customer_support", "operations"],
    },
    action: "resource:draft-register",
    resourceRef: `governance:${reference}`,
  });

  assert.equal(result.ok, true);
  assert.equal(result.usedBreakGlass, true);
  assert.equal(
    result.authorizationEvidenceId,
    "admin-governance-grant",
  );
  assert.deepEqual(breakGlassCalls, ["operator-sub"]);
});

test("break-glass does not make Platform Admin a domain publication approver", async () => {
  const breakGlassCalls = [];
  const authorizer = governanceRuntime.createGovernanceAuthorizer({
    workspaceState: state({
      breakGlassRecords: [activeBreakGlass({
        resource: "CustReg123456/Rec123456789",
        action: "resource:publication-approve",
      })],
      breakGlassCalls,
    }),
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
  });
  const reference = Buffer.from(JSON.stringify({
    v: 1,
    id: "CustReg123456/Rec123456789",
    domainId: "customer_support",
    lifecycleState: "PENDING_APPROVAL",
  })).toString("base64url");

  await assert.rejects(
    authorizer({
      requestContext: {
        source: "governance-service",
        subject: "operator-sub",
        role: "admin",
        activeDomain: "customer_support",
        domainIds: ["customer_support"],
      },
      action: "resource:publication-approve",
      resourceRef: `governance:${reference}`,
      approvalRef: "approval:customer_support/publication-approval",
    }),
    (error) => error?.decision === "FORBIDDEN",
  );
  assert.deepEqual(breakGlassCalls, []);
});

test("settled publication approval authorization is limited to the recorded approver", async () => {
  const approval = {
    domainId: "customer_support",
    id: "publication-approval",
    kind: "RESOURCE_PUBLICATION",
    resourceType: "TOOL",
    resourceId: "CustReg123456/Rec123456789",
    requesterSubject: "builder-sub",
    approverSubject: "operator-sub",
    status: "APPROVED",
  };
  const authorizer = governanceRuntime.createGovernanceAuthorizer({
    workspaceState: state({ approvals: [approval] }),
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
  });
  const reference = Buffer.from(JSON.stringify({
    v: 1,
    id: approval.resourceId,
    domainId: "customer_support",
    lifecycleState: "APPROVED",
  })).toString("base64url");
  const request = {
    requestContext: {
      source: "governance-service",
      subject: "operator-sub",
      role: "lead",
      activeDomain: "customer_support",
      domainIds: ["customer_support"],
    },
    action: "resource:publication-approve",
    resourceRef: `governance:${reference}`,
    approvalRef: "approval:customer_support/publication-approval",
  };

  assert.equal((await authorizer(request)).decision, "ALLOW");
  approval.approverSubject = "another-lead-sub";
  await assert.rejects(
    authorizer(request),
    (error) =>
      error?.decision === "FORBIDDEN"
      && error?.reason === "APPROVAL_RESOLVER_FAILED",
  );
});

// HITL read contract: real runtime/router/service, synthetic identity/storage.
function policyRuntime({ directoryFails = false } = {}) {
  const calls = [];
  const workspace = state();
  for (const method of Object.keys(workspace)) {
    workspace[method] = async () => { calls.push(method); throw Error('unexpected state access'); };
  }
  const runtime = createGovernanceRuntime({
    workspaceState: { ...workspace, readHitlPolicyCatalog: async () => null },
    domainDirectory: {
      async getDomain() { throw Error('unexpected domain record read'); },
      async listActiveDomains() {
        if (directoryFails) throw Error('synthetic backend failure');
        return [DOMAIN, FOREIGN_DOMAIN];
      },
    },
    registryClient: { async send() { calls.push('registry'); throw Error('unexpected Registry read'); } },
    identityVerifier: async () => false,
    clock: () => new Date('2026-09-12T08:00:00.000Z'),
    mandatoryTags: { 'auto-delete': 'no', managedBy: 'cdk', project: 'agentic-ai-platform-demo' },
  });
  return { runtime, calls };
}
function policyEvent(groups = ['platform-admin'], domain = 'customer_support') {
  return {
    routeKey: 'GET /api/hitl', headers: domain ? { 'x-active-domain': domain } : {},
    requestContext: { requestId: 'synthetic-policy-read', http: { method: 'GET', path: '/api/hitl' },
      authorizer: { jwt: { claims: { sub: 'synthetic-policy-reader', token_use: 'access', 'cognito:groups': groups } } } },
  };
}
for (const [name, prepare, expected, code] of [
  ['unconfigured, never empty', e => e, 503, 'HITL_POLICY_NOT_CONFIGURED'],
  ['unauthenticated', e => { delete e.requestContext.authorizer; return e; }, 401, 'NOT_AUTHENTICATED'],
  ['no capability', () => policyEvent(['domain-builder', 'domain-customer-support'], 'customer_support'), 403, 'FORBIDDEN'],
  ['domain lead not policy admin', () => policyEvent(['domain-lead', 'domain-customer-support'], 'customer_support'), 403, 'FORBIDDEN'],
  ['cross-domain', () => policyEvent(['domain-builder', 'domain-customer-support'], 'operations'), 403, null],
  ['unavailable domain', () => policyEvent(['platform-admin'], 'unknown_domain'), 403, null],
  ['client role escalation', e => { e.headers['x-demo-role'] = 'admin'; return e; }, 403, 'DEMO_ROLE_NOT_ALLOWED'],
  ['no write route', e => { e.routeKey = 'POST /api/hitl'; e.requestContext.http.method = 'POST'; return e; }, 404, 'ROUTE_NOT_FOUND'],
  ['invalid token type', e => { e.requestContext.authorizer.jwt.claims.token_use = 'id'; return e; }, 401, 'NOT_AUTHENTICATED'],
  ['method spoof', e => { e.requestContext.http.method = 'POST'; return e; }, 404, 'ROUTE_NOT_FOUND'],
  ['no query contract', e => { e.queryStringParameters = { domainId: 'operations' }; e.rawQueryString = 'domainId=operations'; return e; }, 400, 'INVALID_QUERY'],
  ['no body', e => { e.body = '{}'; return e; }, 400, 'INVALID_BODY'],
]) test(`HITL read runtime ${name}`, async () => {
  const { runtime, calls } = policyRuntime();
  const response = await runtime(prepare(policyEvent()));
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, expected);
  if (code) assert.equal(body.code, code);
  assert.equal(body.ok, false);
  assert.equal(Object.hasOwn(body, 'policies'), false);
  assert.deepEqual(calls, []);
  assert.equal(response.headers['cache-control'], 'no-store');
});
test('HITL read runtime backend failure is not missing configuration or empty', async () => {
  const { runtime, calls } = policyRuntime({ directoryFails: true });
  const response = await runtime(policyEvent());
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).code, 'GOVERNANCE_UNAVAILABLE');
  assert.deepEqual(calls, []);
});
