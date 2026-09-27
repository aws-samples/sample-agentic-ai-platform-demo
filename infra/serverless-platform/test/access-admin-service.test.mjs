import assert from "node:assert/strict";
import test from "node:test";
import {
  AccessAdminServiceError,
  createAccessAdminService,
} from "../lambda/access-admin/service.mjs";

const NOW = Date.parse("2026-08-26T01:00:00.000Z");

const admin = Object.freeze({
  actor: "admin-sub",
  role: "admin",
  activeDomain: null,
  domainIds: ["customer_support", "operations", "platform"],
});
const lead = Object.freeze({
  actor: "lead-sub",
  role: "lead",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});
const builder = Object.freeze({
  actor: "builder-sub",
  role: "builder",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});

function user(overrides = {}) {
  return {
    username: "member.one",
    subject: "member-sub",
    enabled: true,
    userStatus: "CONFIRMED",
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    ownerSubject: "owner-sub",
    memberSubjects: ["member-sub"],
    status: "ACTIVE",
    ...overrides,
  };
}

function mutationInput(identity = lead, overrides = {}) {
  return {
    identity,
    requestId: "membership-request-001",
    domainId: "customer_support",
    username: "member.one",
    reason: "Assign the approved user to this domain.",
    ...overrides,
  };
}

function projectMutationInput(identity = lead, overrides = {}) {
  return {
    ...mutationInput(identity),
    projectId: "case-assist",
    ...overrides,
  };
}

function allowDecision(input, usedBreakGlass = false) {
  const resource = JSON.parse(
    Buffer.from(input.resourceRef.split(":")[1], "base64url")
      .toString("utf8"),
  );
  return {
    ok: true,
    actorId: input.requestContext.subject,
    role: input.requestContext.role,
    action: input.action,
    resourceId: resource.id,
    usedBreakGlass,
  };
}

function serviceWith({
  authorize,
  domains,
  groups,
  projects,
  clock,
  audit,
  idempotency,
} = {}) {
  const calls = [];
  const completed = new Map();
  const claims = new Map();
  const key = ({ actor, route, requestId }) =>
    `${actor}\u0000${route}\u0000${requestId}`;

  const domainDirectory = {
    async getDomain(domainId) {
      calls.push(["getDomain", domainId]);
      return {
        id: domainId,
        status: "ACTIVE",
      };
    },
    ...domains,
  };
  const groupDirectory = {
    async listDomainMembers(input) {
      calls.push(["listDomainMembers", input]);
      return {
        items: [user()],
        cursor: null,
      };
    },
    async getUser(input) {
      calls.push(["getUser", input]);
      return user({ username: input.username });
    },
    async getUserBySubject(input) {
      calls.push(["getUserBySubject", input]);
      return user({ subject: input.subject });
    },
    async isDomainMember(input) {
      calls.push(["isDomainMember", input]);
      return true;
    },
    async addDomainMember(input) {
      calls.push(["addDomainMember", input]);
      return { changed: true };
    },
    async removeDomainMember(input) {
      calls.push(["removeDomainMember", input]);
      return { changed: true };
    },
    ...groups,
  };
  const projectMemberships = {
    async listProjects(input) {
      calls.push(["listProjects", input]);
      return {
        items: [],
        cursor: null,
      };
    },
    async getProject(input) {
      calls.push(["getProject", input]);
      return project({
        domainId: input.domainId,
        id: input.projectId,
      });
    },
    async listProjectMemberSubjects(input) {
      calls.push(["listProjectMemberSubjects", input]);
      return {
        items: ["member-sub"],
        cursor: null,
      };
    },
    async addProjectMember(input) {
      calls.push(["addProjectMember", input]);
      return { changed: true };
    },
    async removeProjectMember(input) {
      calls.push(["removeProjectMember", input]);
      return { changed: true };
    },
    ...projects,
  };
  const auditLog = {
    async append({ record, completion }) {
      calls.push(["audit", record]);
      calls.push(["auditCompletion", completion]);
      completed.set(key(completion), structuredClone(completion));
      return true;
    },
  };
  if (audit?.append) {
    const persist = auditLog.append.bind(auditLog);
    auditLog.append = (input) => audit.append(input, persist);
  }
  const idempotencyStore = {
    async getResult(input) {
      calls.push(["getResult", input]);
      return completed.get(key(input)) ?? null;
    },
    async claim(input) {
      calls.push(["claim", input]);
      const claimKey = key(input);
      if (claims.has(claimKey)) {
        return structuredClone(claims.get(claimKey));
      }
      claims.set(claimKey, structuredClone(input));
      return true;
    },
    async abort(input) {
      calls.push(["abort", input]);
      claims.delete(key(input));
      return true;
    },
    ...idempotency,
  };

  const service = createAccessAdminService({
    domainDirectory,
    groupDirectory,
    projectMemberships,
    authorizer: async (input) => {
      calls.push(["authorize", input]);
      if (authorize) return authorize(input);
      const resource = JSON.parse(
        Buffer.from(input.resourceRef.split(":")[1], "base64url")
          .toString("utf8"),
      );
      return allowDecision(
        input,
        input.requestContext.role === "admin"
          && resource.domainId !== "platform",
      );
    },
    clock: clock || (() => NOW),
    audit: auditLog,
    idempotency: idempotencyStore,
  });

  return { calls, service, completed };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof AccessAdminServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

test("service requires every trust-boundary dependency", () => {
  assert.throws(
    () => createAccessAdminService(),
    /Active domain directory is invalid/,
  );
  assert.throws(
    () => createAccessAdminService({
      domainDirectory: { getDomain() {} },
    }),
    /Cognito domain group directory is invalid/,
  );
});

test("Domain Lead lists only the selected active domain and the group is server-derived", async () => {
  const { calls, service } = serviceWith();

  const result = await service.listDomainMembers({
    identity: lead,
    limit: 25,
  });

  assert.deepEqual(result, {
    domainId: "customer_support",
    items: [user()],
    cursor: null,
  });
  assert.deepEqual(
    calls.find(([name]) => name === "listDomainMembers")[1],
    {
      groupName: "domain-customer-support",
      limit: 25,
    },
  );
  assert.equal(
    calls.find(([name]) => name === "authorize")[1].action,
    "access.domain-members.read",
  );
});

test("Platform Admin can inspect an exact active domain without break-glass", async () => {
  const { calls, service } = serviceWith({
    authorize: async (input) => allowDecision(input, false),
  });

  const result = await service.listDomainMembers({
    identity: admin,
    domainId: "operations",
    limit: 20,
  });

  assert.equal(result.domainId, "operations");
  assert.deepEqual(
    calls.find(([name]) => name === "listDomainMembers")[1],
    {
      groupName: "domain-operations",
      limit: 20,
    },
  );
});

test("lead scope, unsupported roles, inactive domains, and malformed cursors fail closed", async () => {
  const { service } = serviceWith({
    domains: {
      async getDomain(domainId) {
        return domainId === "customer_support"
          ? { id: domainId, status: "SUSPENDED" }
          : null;
      },
    },
  });

  await assert.rejects(
    service.listDomainMembers({
      identity: lead,
      domainId: "operations",
      limit: 20,
    }),
    expectCode("NOT_FOUND"),
  );
  await assert.rejects(
    service.listDomainMembers({
      identity: builder,
      limit: 20,
    }),
    expectCode("FORBIDDEN"),
  );
  await assert.rejects(
    service.listDomainMembers({
      identity: lead,
      limit: 20,
      cursor: "cursor with spaces",
    }),
    expectCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    service.listDomainMembers({
      identity: lead,
      limit: 20,
    }),
    expectCode("NOT_FOUND"),
  );
});

test("domain member responses reject unsafe directory fields and pagination overflow", async () => {
  const unsafe = serviceWith({
    groups: {
      async listDomainMembers() {
        return {
          items: [{
            ...user(),
            email: "private@example.invalid",
          }],
          cursor: null,
        };
      },
    },
  }).service;
  await assert.rejects(
    unsafe.listDomainMembers({ identity: lead, limit: 20 }),
    expectCode("IDENTITY_UNAVAILABLE"),
  );

  const oversized = serviceWith({
    groups: {
      async listDomainMembers() {
        return {
          items: Array.from({ length: 51 }, () => user()),
          cursor: null,
        };
      },
    },
  }).service;
  await assert.rejects(
    oversized.listDomainMembers({ identity: lead, limit: 50 }),
    expectCode("ACCESS_ADMIN_UNAVAILABLE"),
  );
});

test("accessor-backed directory records are rejected without executing getters", async () => {
  let getterCalls = 0;
  const { calls, service } = serviceWith({
    groups: {
      async getUser() {
        const value = {
          subject: "member-sub",
          enabled: true,
          userStatus: "CONFIRMED",
        };
        Object.defineProperty(value, "username", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "member.one";
          },
        });
        return value;
      },
    },
  });

  await assert.rejects(
    service.grantDomainMembership(mutationInput()),
    expectCode("IDENTITY_UNAVAILABLE"),
  );
  assert.equal(getterCalls, 0);
  assert.equal(
    calls.some(([name]) => name === "addDomainMember"),
    false,
  );
});

test("directory usernames and subjects require actual strings without coercion", async () => {
  let coercionCalls = 0;
  const coercibleSubject = {
    toString() {
      coercionCalls += 1;
      return "member-sub";
    },
  };
  const invalidUsers = [
    user({ username: null }),
    user({ subject: null }),
    user({ subject: coercibleSubject }),
  ];

  for (const current of invalidUsers) {
    const { calls, service } = serviceWith({
      groups: {
        async getUser() {
          return current;
        },
      },
    });
    await assert.rejects(
      service.grantDomainMembership(mutationInput()),
      expectCode("IDENTITY_UNAVAILABLE"),
    );
    assert.equal(
      calls.some(([name]) => name === "addDomainMember"),
      false,
    );
  }
  assert.equal(coercionCalls, 0);
});

test("Domain Lead grants domain membership with immutable actor and exact audit evidence", async () => {
  const { calls, service } = serviceWith();

  const result = await service.grantDomainMembership(mutationInput());

  assert.deepEqual(result, {
    domainId: "customer_support",
    username: "member.one",
    subject: "member-sub",
    status: "ACTIVE",
    changed: true,
  });
  assert.deepEqual(
    calls.find(([name]) => name === "addDomainMember")[1],
    {
      username: "member.one",
      subject: "member-sub",
      groupName: "domain-customer-support",
    },
  );
  const authorization = calls.find(([name]) => name === "authorize")[1];
  assert.equal(authorization.action, "access.domain-members.grant");
  assert.equal(authorization.requestContext.subject, "lead-sub");
  const audit = calls.find(([name]) => name === "audit")[1];
  assert.deepEqual(audit, {
    resource: "domain-membership/customer_support/member-sub",
    timestamp: "2026-08-26T01:00:00.000Z",
    requestId: "membership-request-001",
    actor: "lead-sub",
    requesterSubject: "member-sub",
    effectiveRole: "lead",
    action: "access.domain-members.grant",
    decision: "grant",
    reason: "Assign the approved user to this domain.",
    domainId: "customer_support",
    projectId: null,
  });
  assert.deepEqual(
    calls.find(([name]) => name === "auditCompletion")[1].result,
    result,
  );
});

test("Admin foreign-domain mutations require an explicit matching break-glass decision", async () => {
  const { calls, service } = serviceWith({
    authorize: async (input) => allowDecision(input, false),
  });

  await assert.rejects(
    service.grantDomainMembership(mutationInput(admin, {
      domainId: "operations",
    })),
    expectCode("FORBIDDEN"),
  );
  assert.equal(
    calls.some(([name]) => name === "addDomainMember"),
    false,
  );
  assert.equal(
    calls.some(([name]) => name === "claim"),
    false,
  );
});

test("canonical authorization decisions must bind actor, role, action, and resource", async () => {
  const invalidDecisions = [
    (input) => ({ ...allowDecision(input), actorId: "other-sub" }),
    (input) => ({ ...allowDecision(input), role: "admin" }),
    (input) => ({
      ...allowDecision(input),
      action: "access.domain-members.grant",
    }),
    (input) => ({
      ...allowDecision(input),
      resourceId: "domain-members/operations",
    }),
  ];
  for (const authorize of invalidDecisions) {
    const { calls, service } = serviceWith({ authorize });
    await assert.rejects(
      service.listDomainMembers({ identity: lead, limit: 20 }),
      expectCode("FORBIDDEN"),
    );
    assert.equal(
      calls.some(([name]) => name === "listDomainMembers"),
      false,
    );
  }
});

test("requesters cannot silently grant domain or project membership to themselves", async () => {
  const { calls, service } = serviceWith({
    groups: {
      async getUser({ username }) {
        return user({
          username,
          subject: "lead-sub",
        });
      },
    },
  });

  await assert.rejects(
    service.grantDomainMembership(mutationInput()),
    expectCode("SELF_ELEVATION_FORBIDDEN"),
  );
  await assert.rejects(
    service.grantProjectMembership(projectMutationInput()),
    expectCode("SELF_ELEVATION_FORBIDDEN"),
  );
  assert.equal(
    calls.some(([name]) =>
      name === "addDomainMember" || name === "addProjectMember"),
    false,
  );
});

test("mutation inputs validate exact keys, request IDs, usernames, and immutable identity", async () => {
  const { service } = serviceWith();
  const invalid = [
    { ...mutationInput(), actor: "forged-sub" },
    { ...mutationInput(), requestId: " request " },
    { ...mutationInput(), username: "member one" },
    { ...mutationInput(), reason: "x" },
    {
      ...mutationInput(),
      identity: { ...lead, actor: "subject with spaces" },
    },
  ];
  for (const input of invalid) {
    await assert.rejects(
      service.grantDomainMembership(input),
      expectCode("INVALID_REQUEST"),
    );
  }
});

test("idempotent replay is authorization-bound and payload-bound", async () => {
  let userLookups = 0;
  const { calls, service } = serviceWith({
    groups: {
      async getUser({ username }) {
        userLookups += 1;
        if (userLookups > 1) {
          throw new Error("user was removed after completion");
        }
        return user({ username });
      },
    },
  });
  const input = mutationInput();

  const first = await service.grantDomainMembership(input);
  const second = await service.grantDomainMembership(input);

  assert.deepEqual(second, first);
  assert.equal(
    calls.filter(([name]) => name === "addDomainMember").length,
    1,
  );
  assert.equal(
    calls.filter(([name]) => name === "authorize").length,
    2,
  );
  assert.equal(userLookups, 1);

  await assert.rejects(
    service.grantDomainMembership({
      ...input,
      reason: "A different payload must not reuse the request ID.",
    }),
    expectCode("CONFLICT"),
  );
});

test("project members are listed by immutable subject and resolved to a safe directory projection", async () => {
  const { calls, service } = serviceWith();

  const result = await service.listProjectMembers({
    identity: lead,
    projectId: "case-assist",
    limit: 10,
  });

  assert.deepEqual(result, {
    domainId: "customer_support",
    projectId: "case-assist",
    items: [user()],
    cursor: null,
  });
  assert.deepEqual(
    calls.find(([name]) => name === "getUserBySubject")[1],
    { subject: "member-sub" },
  );
  assert.equal(
    calls.find(([name]) => name === "authorize")[1].action,
    "access.project-members.read",
  );
});

test("project grants require current domain membership and write the immutable subject", async () => {
  const denied = serviceWith({
    groups: {
      async isDomainMember() {
        return false;
      },
    },
  });
  await assert.rejects(
    denied.service.grantProjectMembership(projectMutationInput()),
    expectCode("NOT_FOUND"),
  );
  assert.equal(
    denied.calls.some(([name]) => name === "addProjectMember"),
    false,
  );

  const { calls, service } = serviceWith();
  const result = await service.grantProjectMembership(
    projectMutationInput(),
  );
  assert.deepEqual(result, {
    domainId: "customer_support",
    projectId: "case-assist",
    username: "member.one",
    subject: "member-sub",
    status: "ACTIVE",
    changed: true,
  });
  assert.deepEqual(
    calls.find(([name]) => name === "addProjectMember")[1],
    {
      domainId: "customer_support",
      projectId: "case-assist",
      subject: "member-sub",
    },
  );
});

test("project owner membership revocation fails closed before mutation", async () => {
  const { calls, service } = serviceWith({
    groups: {
      async getUser({ username }) {
        return user({
          username,
          subject: "owner-sub",
        });
      },
    },
  });

  await assert.rejects(
    service.revokeProjectMembership(projectMutationInput()),
    expectCode("CONFLICT"),
  );
  assert.equal(
    calls.some(([name]) => name === "claim"),
    false,
  );
  assert.equal(
    calls.some(([name]) => name === "removeProjectMember"),
    false,
  );
});

test("domain revocation requires project owner and member cleanup first", async (t) => {
  for (const [name, blockedProject] of [
    [
      "owner",
      project({
        ownerSubject: "member-sub",
        memberSubjects: [],
      }),
    ],
    [
      "archived member",
      project({
        memberSubjects: ["member-sub"],
        status: "ARCHIVED",
      }),
    ],
  ]) {
    await t.test(name, async () => {
      const { calls, service } = serviceWith({
        projects: {
          async listProjects(input) {
            calls.push(["listProjects", input]);
            return {
              items: [blockedProject],
              cursor: null,
            };
          },
        },
      });

      await assert.rejects(
        service.revokeDomainMembership(mutationInput()),
        expectCode("CONFLICT"),
      );
      assert.deepEqual(
        calls.find(([method]) => method === "listProjects")[1],
        {
          domainId: "customer_support",
          limit: 100,
        },
      );
      assert.equal(
        calls.some(([method]) => method === "claim"),
        false,
      );
      assert.equal(
        calls.some(([method]) => method === "removeDomainMember"),
        false,
      );
    });
  }
});

test("domain revocation checks every authoritative project page", async () => {
  const pages = [
    {
      items: [project({
        id: "first-project",
        memberSubjects: [],
      })],
      cursor: {
        pk: "PROJECT#customer_support",
        sk: "PROJECT#first-project",
      },
    },
    {
      items: [project({
        id: "second-project",
        memberSubjects: ["member-sub"],
      })],
      cursor: null,
    },
  ];
  const { calls, service } = serviceWith({
    projects: {
      async listProjects(input) {
        calls.push(["listProjects", input]);
        return pages.shift();
      },
    },
  });

  await assert.rejects(
    service.revokeDomainMembership(mutationInput()),
    expectCode("CONFLICT"),
  );
  assert.deepEqual(
    calls.filter(([method]) => method === "listProjects")
      .map(([, input]) => input),
    [
      {
        domainId: "customer_support",
        limit: 100,
      },
      {
        domainId: "customer_support",
        limit: 100,
        cursor: {
          pk: "PROJECT#customer_support",
          sk: "PROJECT#first-project",
        },
      },
    ],
  );
  assert.equal(
    calls.some(([method]) => method === "removeDomainMember"),
    false,
  );
});

test("domain revocation fails closed on incomplete project pagination", async (t) => {
  await t.test("repeated cursor", async () => {
    const cursor = {
      pk: "PROJECT#customer_support",
      sk: "PROJECT#case-assist",
    };
    const { calls, service } = serviceWith({
      projects: {
        async listProjects(input) {
          calls.push(["listProjects", input]);
          return { items: [], cursor };
        },
      },
    });

    await assert.rejects(
      service.revokeDomainMembership(mutationInput()),
      expectCode("ACCESS_ADMIN_UNAVAILABLE"),
    );
    assert.equal(
      calls.filter(([method]) => method === "listProjects").length,
      2,
    );
    assert.equal(
      calls.some(([method]) => method === "removeDomainMember"),
      false,
    );
  });

  await t.test("page bound", async () => {
    let page = 0;
    const { calls, service } = serviceWith({
      projects: {
        async listProjects(input) {
          calls.push(["listProjects", input]);
          page += 1;
          return {
            items: [],
            cursor: {
              pk: "PROJECT#customer_support",
              sk: `PROJECT#page-${page}`,
            },
          };
        },
      },
    });

    await assert.rejects(
      service.revokeDomainMembership(mutationInput()),
      expectCode("ACCESS_ADMIN_UNAVAILABLE"),
    );
    assert.equal(
      calls.filter(([method]) => method === "listProjects").length,
      10,
    );
    assert.equal(
      calls.some(([method]) => method === "removeDomainMember"),
      false,
    );
  });

  await t.test("malformed cursor", async () => {
    const { calls, service } = serviceWith({
      projects: {
        async listProjects(input) {
          calls.push(["listProjects", input]);
          return {
            items: [],
            cursor: {
              pk: "PROJECT#operations",
              sk: "PROJECT#case-assist",
            },
          };
        },
      },
    });

    await assert.rejects(
      service.revokeDomainMembership(mutationInput()),
      expectCode("ACCESS_ADMIN_UNAVAILABLE"),
    );
    assert.equal(
      calls.some(([method]) => method === "removeDomainMember"),
      false,
    );
  });

  await t.test("regressing cursor", async () => {
    const cursors = [
      {
        pk: "PROJECT#customer_support",
        sk: "PROJECT#zeta-project",
      },
      {
        pk: "PROJECT#customer_support",
        sk: "PROJECT#alpha-project",
      },
    ];
    const { calls, service } = serviceWith({
      projects: {
        async listProjects(input) {
          calls.push(["listProjects", input]);
          return {
            items: [],
            cursor: cursors.shift(),
          };
        },
      },
    });

    await assert.rejects(
      service.revokeDomainMembership(mutationInput()),
      expectCode("ACCESS_ADMIN_UNAVAILABLE"),
    );
    assert.equal(
      calls.filter(([method]) => method === "listProjects").length,
      2,
    );
    assert.equal(
      calls.some(([method]) => method === "removeDomainMember"),
      false,
    );
  });
});

test("domain and project revocations use distinct routes and return safe schemas", async () => {
  const { calls, service } = serviceWith();

  const domainResult = await service.revokeDomainMembership(
    mutationInput(),
  );
  const projectResult = await service.revokeProjectMembership(
    projectMutationInput(lead, {
      requestId: "project-revoke-001",
    }),
  );

  assert.equal(domainResult.status, "REVOKED");
  assert.equal(projectResult.status, "REVOKED");
  assert.deepEqual(
    calls.filter(([name]) => name === "authorize")
      .map(([, input]) => input.action),
    [
      "access.domain-members.revoke",
      "access.project-members.revoke",
    ],
  );
  assert.equal(
    calls.find(([name]) => name === "removeDomainMember")[1].groupName,
    "domain-customer-support",
  );
});

test("ambiguous provider failures keep the claim and return non-disclosing availability errors", async () => {
  const { calls, service } = serviceWith({
    groups: {
      async addDomainMember() {
        throw new Error("private-user-pool-name");
      },
    },
  });

  await assert.rejects(
    service.grantDomainMembership(mutationInput()),
    (error) => {
      assert.ok(error instanceof AccessAdminServiceError);
      assert.equal(error.code, "IDENTITY_UNAVAILABLE");
      assert.doesNotMatch(error.message, /private-user-pool-name/);
      return true;
    },
  );
  assert.equal(calls.some(([name]) => name === "abort"), false);
  assert.equal(calls.some(([name]) => name === "audit"), false);
});

test("ambiguous atomic audit completion failures keep the reservation intact", async () => {
  const { calls, service } = serviceWith({
    audit: {
      async append() {
        throw new Error("completion write timed out");
      },
    },
  });

  await assert.rejects(
    service.grantDomainMembership(mutationInput()),
    expectCode("ACCESS_ADMIN_UNAVAILABLE"),
  );
  assert.equal(
    calls.filter(([name]) => name === "addDomainMember").length,
    1,
  );
  assert.equal(calls.some(([name]) => name === "abort"), false);
});

test("same-request retry reconciles an exact pending claim without duplicating domain membership", async () => {
  const members = new Set();
  let providerAttempts = 0;
  let completionAttempts = 0;
  const { service } = serviceWith({
    groups: {
      async addDomainMember({ username }) {
        providerAttempts += 1;
        const changed = !members.has(username);
        members.add(username);
        return { changed };
      },
    },
    audit: {
      async append(input, persist) {
        completionAttempts += 1;
        if (completionAttempts === 1) {
          throw new Error("completion write timed out");
        }
        return persist(input);
      },
    },
  });
  const input = mutationInput();

  await assert.rejects(
    service.grantDomainMembership(input),
    expectCode("ACCESS_ADMIN_UNAVAILABLE"),
  );

  const recovered = await service.grantDomainMembership(input);
  assert.deepEqual(recovered, {
    domainId: "customer_support",
    username: "member.one",
    subject: "member-sub",
    status: "ACTIVE",
    changed: false,
  });
  assert.equal(providerAttempts, 2);
  assert.deepEqual([...members], ["member.one"]);
  assert.equal(completionAttempts, 2);

  assert.deepEqual(
    await service.grantDomainMembership(input),
    recovered,
  );
  assert.equal(providerAttempts, 2);
  assert.equal(completionAttempts, 2);
});

test("same-request retry reconciles an ambiguous provider success without duplicating the side effect", async () => {
  const members = new Set();
  let providerAttempts = 0;
  const { service } = serviceWith({
    groups: {
      async addDomainMember({ username }) {
        providerAttempts += 1;
        const changed = !members.has(username);
        members.add(username);
        if (providerAttempts === 1) {
          throw new Error("provider response was lost");
        }
        return { changed };
      },
    },
  });
  const input = mutationInput();

  await assert.rejects(
    service.grantDomainMembership(input),
    expectCode("IDENTITY_UNAVAILABLE"),
  );

  assert.deepEqual(
    await service.grantDomainMembership(input),
    {
      domainId: "customer_support",
      username: "member.one",
      subject: "member-sub",
      status: "ACTIVE",
      changed: false,
    },
  );
  assert.equal(providerAttempts, 2);
  assert.deepEqual([...members], ["member.one"]);
});

test("completion response loss reconciles the durable result before retrying the provider", async () => {
  let providerAttempts = 0;
  let completionAttempts = 0;
  const { service } = serviceWith({
    groups: {
      async addDomainMember() {
        providerAttempts += 1;
        return { changed: true };
      },
    },
    audit: {
      async append(input, persist) {
        completionAttempts += 1;
        await persist(input);
        throw new Error("completion response was lost");
      },
    },
  });

  assert.deepEqual(
    await service.grantDomainMembership(mutationInput()),
    {
      domainId: "customer_support",
      username: "member.one",
      subject: "member-sub",
      status: "ACTIVE",
      changed: true,
    },
  );
  assert.equal(providerAttempts, 1);
  assert.equal(completionAttempts, 1);
});

test("pending retries reject changed payloads and directory subject re-binding before repeating a side effect", async (t) => {
  await t.test("changed payload fingerprint", async () => {
    let providerAttempts = 0;
    const { service } = serviceWith({
      groups: {
        async addDomainMember() {
          providerAttempts += 1;
          return { changed: true };
        },
      },
      audit: {
        async append() {
          throw new Error("completion unavailable");
        },
      },
    });
    const input = mutationInput();
    await assert.rejects(
      service.grantDomainMembership(input),
      expectCode("ACCESS_ADMIN_UNAVAILABLE"),
    );

    await assert.rejects(
      service.grantDomainMembership({
        ...input,
        reason: "A changed payload cannot take over the pending claim.",
      }),
      expectCode("CONFLICT"),
    );
    assert.equal(providerAttempts, 1);
  });

  await t.test("directory subject re-binding", async () => {
    let lookupAttempts = 0;
    let providerAttempts = 0;
    const { service } = serviceWith({
      groups: {
        async getUser({ username }) {
          lookupAttempts += 1;
          return user({
            username,
            subject: lookupAttempts === 1
              ? "member-sub"
              : "replacement-sub",
          });
        },
        async addDomainMember() {
          providerAttempts += 1;
          return { changed: true };
        },
      },
      audit: {
        async append() {
          throw new Error("completion unavailable");
        },
      },
    });
    const input = mutationInput();
    await assert.rejects(
      service.grantDomainMembership(input),
      expectCode("ACCESS_ADMIN_UNAVAILABLE"),
    );

    await assert.rejects(
      service.grantDomainMembership(input),
      expectCode("CONFLICT"),
    );
    assert.equal(providerAttempts, 1);
  });
});

test("completed replay rejects altered top-level username and status bindings", async (t) => {
  for (const [field, value] of [
    ["username", "replacement.user"],
    ["status", "REVOKED"],
  ]) {
    await t.test(field, async () => {
      const { completed, service } = serviceWith();
      const input = mutationInput();
      await service.grantDomainMembership(input);
      const stored = completed.values().next().value;
      stored[field] = value;

      await assert.rejects(
        service.grantDomainMembership(input),
        expectCode("CONFLICT"),
      );
    });
  }
});
