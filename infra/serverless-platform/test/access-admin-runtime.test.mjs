import assert from "node:assert/strict";
import test from "node:test";

const runtimeModule = await import(
  "../lambda/access-admin/runtime.mjs"
).catch(() => Object.freeze({}));

const {
  AccessAdminWorkspaceCompatibilityError,
  createAccessAdminAuthorizer,
  createAccessAdminAuditAdapter,
  createAccessAdminIdempotencyAdapter,
  createAccessAdminRequestClock,
  createAccessAdminRuntime,
  createWorkspaceProjectMembershipAdapter,
} = runtimeModule;

const NOW = "2026-08-26T02:00:00.000Z";

function event() {
  return {
    version: "2.0",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
    queryStringParameters: {
      projectId: "case-assist",
      limit: "20",
    },
    rawQueryString: "projectId=case-assist&limit=20",
    requestContext: {
      requestId: "access-admin-request",
      http: {
        method: "GET",
        path: "/api/access/project-members",
      },
      authorizer: {
        jwt: {
          claims: {
            sub: "operator-sub",
            token_use: "access",
            "cognito:groups": [
              "platform-admin",
              "demo-operator",
              "domain-customer-support",
            ],
          },
        },
      },
    },
  };
}

function projectMemberships() {
  return {
    async listProjects() {
      return { items: [], cursor: null };
    },
    async getProject({ domainId, projectId }) {
      return {
        domainId,
        id: projectId,
        ownerSubject: "owner-sub",
        memberSubjects: ["member-sub"],
        status: "ACTIVE",
      };
    },
    async listProjectMemberSubjects() {
      return { items: ["member-sub"], cursor: null };
    },
    async addProjectMember() {
      return { changed: true };
    },
    async removeProjectMember() {
      return { changed: true };
    },
  };
}

test("workspace project adapter exposes the partitioned project listing", async () => {
  assert.equal(typeof createWorkspaceProjectMembershipAdapter, "function");
  const calls = [];
  const workspaceState = {
    async listProjects(input) {
      calls.push(["listProjects", input]);
      return { items: [], cursor: null };
    },
    async getProject() {},
    async listProjectMemberSubjects() {},
    async addProjectMember() {},
    async removeProjectMember() {},
  };
  const adapter = createWorkspaceProjectMembershipAdapter(workspaceState);
  const input = {
    domainId: "customer_support",
    limit: 100,
  };

  assert.deepEqual(
    await adapter.listProjects(input),
    { items: [], cursor: null },
  );
  assert.deepEqual(calls, [["listProjects", input]]);
});

function groupDirectory() {
  return {
    async listDomainMembers() {
      return { items: [], cursor: null };
    },
    async getUser({ username }) {
      return {
        username,
        subject: "member-sub",
        enabled: true,
        userStatus: "CONFIRMED",
      };
    },
    async getUserBySubject({ subject }) {
      return {
        username: "member.one",
        subject,
        enabled: true,
        userStatus: "CONFIRMED",
      };
    },
    async isDomainMember() {
      return true;
    },
    async addDomainMember() {
      return { changed: true };
    },
    async removeDomainMember() {
      return { changed: true };
    },
  };
}

test("runtime composes the existing handler and service with abstract adapters", async () => {
  assert.equal(typeof createAccessAdminRuntime, "function");
  const runtime = createAccessAdminRuntime({
    domainDirectory: {
      async getDomain(id) {
        return { id, status: "ACTIVE" };
      },
      async listActiveDomains() {
        return [{ id: "customer_support" }];
      },
    },
    groupDirectory: groupDirectory(),
    projectMemberships: projectMemberships(),
    identityVerifier: async () => true,
    authorizer: async (input) => {
      const resource = JSON.parse(
        Buffer.from(
          input.resourceRef.slice("access:".length),
          "base64url",
        ).toString("utf8"),
      );
      return {
        ok: true,
        actorId: input.requestContext.subject,
        role: input.requestContext.role,
        action: input.action,
        resourceId: resource.id,
        usedBreakGlass: false,
      };
    },
    clock: () => Date.parse(NOW),
    audit: { async append() { return true; } },
    idempotency: {
      async getResult() {
        return null;
      },
      async claim() {
        return true;
      },
    },
  });

  const response = await runtime(event());

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    domainId: "customer_support",
    projectId: "case-assist",
    items: [{
      username: "member.one",
      subject: "member-sub",
      enabled: true,
      userStatus: "CONFIRMED",
    }],
    cursor: null,
  });
});

test("runtime authorizer uses the canonical access action contracts", async () => {
  assert.equal(typeof createAccessAdminAuthorizer, "function");
  const authorize = createAccessAdminAuthorizer({
    workspaceState: {
      async listBreakGlass() {
        return { items: [], cursor: null };
      },
    },
    clock: () => Date.parse(NOW),
  });
  const resourceRef = `access:${Buffer.from(JSON.stringify({
    v: 1,
    id: "domain-members/customer_support",
    domainId: "customer_support",
    lifecycleState: "ACTIVE",
  })).toString("base64url")}`;

  const result = await authorize({
    requestContext: {
      source: "access-admin-service",
      subject: "lead-sub",
      role: "lead",
      activeDomain: "customer_support",
      domainIds: ["customer_support"],
    },
    action: "access.domain-members.read",
    resourceRef,
  });

  assert.deepEqual(result, {
    ok: true,
    decision: "ALLOW",
    actorId: "lead-sub",
    role: "lead",
    action: "access.domain-members.read",
    resourceId: "domain-members/customer_support",
    usedBreakGlass: false,
  });
});

test("request clock binds every state and service write to one instant", async () => {
  assert.equal(typeof createAccessAdminRequestClock, "function");
  let reads = 0;
  const requestClock = createAccessAdminRequestClock({
    now() {
      reads += 1;
      return new Date(
        reads === 1
          ? NOW
          : "2026-08-26T02:00:00.999Z",
      );
    },
  });

  const first = await requestClock.run(async () => ({
    date: requestClock.date().toISOString(),
    milliseconds: requestClock.milliseconds(),
    repeated: requestClock.date().toISOString(),
  }));
  const second = await requestClock.run(async () =>
    requestClock.date().toISOString());

  assert.deepEqual(first, {
    date: NOW,
    milliseconds: Date.parse(NOW),
    repeated: NOW,
  });
  assert.equal(second, "2026-08-26T02:00:00.999Z");
  assert.equal(reads, 2);
  assert.throws(
    () => requestClock.date(),
    /outside an active request/,
  );
});

test("audit adapter atomically binds service completion to workspace audit state", async () => {
  assert.equal(typeof createAccessAdminAuditAdapter, "function");
  const writes = [];
  const adapter = createAccessAdminAuditAdapter({
    workspaceState: {
      async appendAudit(input) {
        writes.push(structuredClone(input));
        return input.record;
      },
    },
  });
  const record = {
    resource: "domain-membership/customer_support/member-sub",
    timestamp: NOW,
    requestId: "membership-request-001",
    actor: "lead-sub",
    requesterSubject: "member-sub",
    effectiveRole: "lead",
    action: "access.domain-members.grant",
    decision: "grant",
    reason: "Assign the approved user to this domain.",
    domainId: "customer_support",
    projectId: null,
  };
  const completion = {
    actor: "lead-sub",
    requesterSubject: "member-sub",
    effectiveRole: "lead",
    domainId: "customer_support",
    projectId: null,
    route: "POST /api/access/domain-memberships",
    requestId: "membership-request-001",
    payloadFingerprint: "a".repeat(64),
    resourceKey: record.resource,
    operation: "CREATE",
    decision: "grant",
    reason: record.reason,
    username: "member.one",
    status: "ACTIVE",
    result: {
      domainId: "customer_support",
      username: "member.one",
      subject: "member-sub",
      status: "ACTIVE",
      changed: true,
    },
  };

  assert.equal(await adapter.append({ record, completion }), true);
  assert.deepEqual(writes, [{
    record,
    mutation: {
      actor: "lead-sub",
      requesterSubject: "member-sub",
      effectiveRole: "lead",
      domainId: "customer_support",
      projectId: null,
      route: "POST /api/access/domain-memberships",
      requestId: "membership-request-001",
      payloadFingerprint: "a".repeat(64),
      result: {
        entityType: "WORKSPACE_AUDIT",
        resourceKey:
          `audit/${record.resource}/${NOW}/membership-request-001`,
        operation: "APPEND",
        status: "SUCCEEDED",
        accessAdmin: {
          username: "member.one",
          subject: "member-sub",
          membershipStatus: "ACTIVE",
          changed: true,
        },
      },
      decision: "grant",
      reason: record.reason,
      timestamp: NOW,
      createdAt: NOW,
    },
  }]);
});

test("idempotency adapter delegates compatible permanent claims", async () => {
  assert.equal(typeof createAccessAdminIdempotencyAdapter, "function");
  const claims = [];
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return null;
      },
      async claimMutation(input) {
        claims.push(structuredClone(input));
        return true;
      },
    },
  });
  const claim = {
    actor: "lead-sub",
    requesterSubject: "member-sub",
    effectiveRole: "lead",
    domainId: "customer_support",
    projectId: "case-assist",
    route: "POST /api/access/project-memberships",
    requestId: "membership-request-001",
    payloadFingerprint: "a".repeat(64),
    resourceKey:
      "project-membership/customer_support/case-assist/member-sub",
    operation: "UPDATE",
    decision: "grant",
    reason: "Assign the approved user to this project.",
    username: "member.one",
    status: "ACTIVE",
  };

  assert.equal(await adapter.getResult({
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
  }), null);
  assert.equal(await adapter.claim(claim), true);
  assert.deepEqual(claims, [{
    actor: claim.actor,
    requesterSubject: claim.requesterSubject,
    effectiveRole: claim.effectiveRole,
    domainId: claim.domainId,
    projectId: claim.projectId,
    route: claim.route,
    requestId: claim.requestId,
    payloadFingerprint: claim.payloadFingerprint,
    resourceKey: claim.resourceKey,
    operation: claim.operation,
  }]);
});

test("idempotency adapter reconciles exact pending claims and normalizes revocations", async () => {
  const calls = [];
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return null;
      },
      async claimMutation(input) {
        calls.push(structuredClone(input));
        if (calls.length === 2) {
          throw Object.assign(new Error("exact claim is pending"), {
            code: "MUTATION_IN_PROGRESS",
          });
        }
        return true;
      },
    },
  });
  const claim = {
    actor: "lead-sub",
    requesterSubject: "member-sub",
    effectiveRole: "lead",
    domainId: "customer_support",
    projectId: null,
    route: "POST /api/access/domain-membership-revocations",
    requestId: "membership-request-001",
    payloadFingerprint: "a".repeat(64),
    resourceKey: "domain-membership/customer_support/member-sub",
    operation: "DELETE",
    decision: "revoke",
    reason: "Remove access from this domain.",
    username: "member.one",
    status: "REVOKED",
  };

  assert.equal(await adapter.claim(claim), true);
  assert.deepEqual(await adapter.claim(claim), claim);
  assert.equal(calls[0].operation, "UPDATE");
  assert.equal(calls[1].operation, "UPDATE");
});

test("idempotency adapter fails closed for incomplete permanent replays", async () => {
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return {
          actor: "lead-sub",
          requesterSubject: "member-sub",
          effectiveRole: "lead",
          domainId: "customer_support",
          projectId: null,
          route: "POST /api/access/domain-memberships",
          requestId: "membership-request-001",
          payloadFingerprint: "a".repeat(64),
          result: {
            entityType: "WORKSPACE_AUDIT",
            resourceKey: "audit/example",
            operation: "APPEND",
            status: "SUCCEEDED",
          },
          decision: "grant",
          reason: "Assign the approved user to this domain.",
          timestamp: NOW,
          createdAt: NOW,
        };
      },
      async claimMutation() {
        return true;
      },
    },
  });

  await assert.rejects(
    adapter.getResult({
      actor: "lead-sub",
      route: "POST /api/access/domain-memberships",
      requestId: "membership-request-001",
    }),
    (error) => (
      error instanceof AccessAdminWorkspaceCompatibilityError
      && /replay-complete/.test(error.message)
    ),
  );
});

test("idempotency adapter reconstructs access administration permanent replays", async () => {
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return {
          actor: "lead-sub",
          requesterSubject: "member-sub",
          effectiveRole: "lead",
          domainId: "customer_support",
          projectId: null,
          route: "POST /api/access/domain-memberships",
          requestId: "membership-request-001",
          payloadFingerprint: "a".repeat(64),
          result: {
            entityType: "WORKSPACE_AUDIT",
            resourceKey:
              "audit/domain-membership/customer_support/member-sub/"
              + `${NOW}/membership-request-001`,
            operation: "APPEND",
            status: "SUCCEEDED",
            accessAdmin: {
              username: "member.one",
              subject: "member-sub",
              membershipStatus: "ACTIVE",
              changed: true,
            },
          },
          decision: "grant",
          reason: "Assign the approved user to this domain.",
          timestamp: NOW,
          createdAt: NOW,
        };
      },
      async claimMutation() {
        return true;
      },
    },
  });

  assert.deepEqual(
    await adapter.getResult({
      actor: "lead-sub",
      route: "POST /api/access/domain-memberships",
      requestId: "membership-request-001",
    }),
    {
      actor: "lead-sub",
      requesterSubject: "member-sub",
      effectiveRole: "lead",
      domainId: "customer_support",
      projectId: null,
      route: "POST /api/access/domain-memberships",
      requestId: "membership-request-001",
      payloadFingerprint: "a".repeat(64),
      resourceKey: "domain-membership/customer_support/member-sub",
      operation: "CREATE",
      decision: "grant",
      reason: "Assign the approved user to this domain.",
      username: "member.one",
      status: "ACTIVE",
      result: {
        domainId: "customer_support",
        username: "member.one",
        subject: "member-sub",
        status: "ACTIVE",
        changed: true,
      },
    },
  );
});

test("idempotency adapter reconstructs project membership grants as updates", async () => {
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return {
          actor: "lead-sub",
          requesterSubject: "member-sub",
          effectiveRole: "lead",
          domainId: "customer_support",
          projectId: "case-assist",
          route: "POST /api/access/project-memberships",
          requestId: "membership-request-001",
          payloadFingerprint: "a".repeat(64),
          result: {
            entityType: "WORKSPACE_AUDIT",
            resourceKey:
              "audit/project-membership/customer_support/case-assist/"
              + `member-sub/${NOW}/membership-request-001`,
            operation: "APPEND",
            status: "SUCCEEDED",
            accessAdmin: {
              username: "member.one",
              subject: "member-sub",
              membershipStatus: "ACTIVE",
              changed: true,
            },
          },
          decision: "grant",
          reason: "Assign the approved user to this project.",
          timestamp: NOW,
          createdAt: NOW,
        };
      },
      async claimMutation() {
        return true;
      },
    },
  });

  assert.deepEqual(
    await adapter.getResult({
      actor: "lead-sub",
      route: "POST /api/access/project-memberships",
      requestId: "membership-request-001",
    }),
    {
      actor: "lead-sub",
      requesterSubject: "member-sub",
      effectiveRole: "lead",
      domainId: "customer_support",
      projectId: "case-assist",
      route: "POST /api/access/project-memberships",
      requestId: "membership-request-001",
      payloadFingerprint: "a".repeat(64),
      resourceKey:
        "project-membership/customer_support/case-assist/member-sub",
      operation: "UPDATE",
      decision: "grant",
      reason: "Assign the approved user to this project.",
      username: "member.one",
      status: "ACTIVE",
      result: {
        domainId: "customer_support",
        projectId: "case-assist",
        username: "member.one",
        subject: "member-sub",
        status: "ACTIVE",
        changed: true,
      },
    },
  );
});

test("idempotency adapter reconstructs project membership revocations as updates", async () => {
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return {
          actor: "lead-sub",
          requesterSubject: "member-sub",
          effectiveRole: "lead",
          domainId: "customer_support",
          projectId: "case-assist",
          route: "POST /api/access/project-membership-revocations",
          requestId: "membership-request-001",
          payloadFingerprint: "a".repeat(64),
          result: {
            entityType: "WORKSPACE_AUDIT",
            resourceKey:
              "audit/project-membership/customer_support/case-assist/"
              + `member-sub/${NOW}/membership-request-001`,
            operation: "APPEND",
            status: "SUCCEEDED",
            accessAdmin: {
              username: "member.one",
              subject: "member-sub",
              membershipStatus: "REVOKED",
              changed: false,
            },
          },
          decision: "revoke",
          reason: "Remove the user from this project.",
          timestamp: NOW,
          createdAt: NOW,
        };
      },
      async claimMutation() {
        return true;
      },
    },
  });

  assert.deepEqual(
    await adapter.getResult({
      actor: "lead-sub",
      route: "POST /api/access/project-membership-revocations",
      requestId: "membership-request-001",
    }),
    {
      actor: "lead-sub",
      requesterSubject: "member-sub",
      effectiveRole: "lead",
      domainId: "customer_support",
      projectId: "case-assist",
      route: "POST /api/access/project-membership-revocations",
      requestId: "membership-request-001",
      payloadFingerprint: "a".repeat(64),
      resourceKey:
        "project-membership/customer_support/case-assist/member-sub",
      operation: "UPDATE",
      decision: "revoke",
      reason: "Remove the user from this project.",
      username: "member.one",
      status: "REVOKED",
      result: {
        domainId: "customer_support",
        projectId: "case-assist",
        username: "member.one",
        subject: "member-sub",
        status: "REVOKED",
        changed: false,
      },
    },
  );
});

test("idempotency adapter fails closed for unknown access replay routes", async () => {
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return {
          actor: "lead-sub",
          requesterSubject: "member-sub",
          effectiveRole: "lead",
          domainId: "customer_support",
          projectId: "case-assist",
          route: "POST /api/access/project-membership-reviews",
          requestId: "membership-request-001",
          payloadFingerprint: "a".repeat(64),
          result: {
            entityType: "WORKSPACE_AUDIT",
            resourceKey:
              "audit/project-membership/customer_support/case-assist/"
              + `member-sub/${NOW}/membership-request-001`,
            operation: "APPEND",
            status: "SUCCEEDED",
            accessAdmin: {
              username: "member.one",
              subject: "member-sub",
              membershipStatus: "ACTIVE",
              changed: true,
            },
          },
          decision: "grant",
          reason: "Assign the approved user to this project.",
          timestamp: NOW,
          createdAt: NOW,
        };
      },
      async claimMutation() {
        return true;
      },
    },
  });

  await assert.rejects(
    adapter.getResult({
      actor: "lead-sub",
      route: "POST /api/access/project-membership-reviews",
      requestId: "membership-request-001",
    }),
    (error) => (
      error instanceof AccessAdminWorkspaceCompatibilityError
      && /route/.test(error.message)
    ),
  );
});

test("idempotency adapter fails closed for unknown access replay decisions", async () => {
  const adapter = createAccessAdminIdempotencyAdapter({
    workspaceState: {
      async getMutationResult() {
        return {
          actor: "lead-sub",
          requesterSubject: "member-sub",
          effectiveRole: "lead",
          domainId: "customer_support",
          projectId: null,
          route: "POST /api/access/domain-memberships",
          requestId: "membership-request-001",
          payloadFingerprint: "a".repeat(64),
          result: {
            entityType: "WORKSPACE_AUDIT",
            resourceKey:
              "audit/domain-membership/customer_support/member-sub/"
              + `${NOW}/membership-request-001`,
            operation: "APPEND",
            status: "SUCCEEDED",
            accessAdmin: {
              username: "member.one",
              subject: "member-sub",
              membershipStatus: "ACTIVE",
              changed: true,
            },
          },
          decision: "review",
          reason: "Assign the approved user to this domain.",
          timestamp: NOW,
          createdAt: NOW,
        };
      },
      async claimMutation() {
        return true;
      },
    },
  });

  await assert.rejects(
    adapter.getResult({
      actor: "lead-sub",
      route: "POST /api/access/domain-memberships",
      requestId: "membership-request-001",
    }),
    (error) => (
      error instanceof AccessAdminWorkspaceCompatibilityError
      && /decision/.test(error.message)
    ),
  );
});

test("runtime rejects raw workspace state as an unsafe project membership adapter", () => {
  assert.throws(
    () => createAccessAdminRuntime({
      domainDirectory: {
        getDomain() {},
        listActiveDomains() {},
      },
      groupDirectory: groupDirectory(),
      projectMemberships: {
        getProject() {},
        putProject() {},
      },
      identityVerifier() {},
      authorizer() {},
      clock() {
        return Date.parse(NOW);
      },
      audit: { append() {} },
      idempotency: {
        getResult() {},
        claim() {},
      },
    }),
    /Project membership adapter is invalid/,
  );
});
