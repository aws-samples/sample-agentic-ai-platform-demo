import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_CONTRACTS,
  AuthorizationError,
  createAuthorizer,
} from "../lambda/authz/authorize.mjs";

const NOW = Date.parse("2026-08-26T01:00:00.000Z");
const REQUEST_CONTEXT = Object.freeze({
  requestId: "access-admin-request-1",
  source: "access-admin-authorizer-test",
});

const ACTIONS = Object.freeze({
  domainRead: "access.domain-members.read",
  domainGrant: "access.domain-members.grant",
  domainRevoke: "access.domain-members.revoke",
  projectRead: "access.project-members.read",
  projectGrant: "access.project-members.grant",
  projectRevoke: "access.project-members.revoke",
});

const READ_ACTIONS = Object.freeze([
  ACTIONS.domainRead,
  ACTIONS.projectRead,
]);

const MUTATION_ACTIONS = Object.freeze([
  ACTIONS.domainGrant,
  ACTIONS.domainRevoke,
  ACTIONS.projectGrant,
  ACTIONS.projectRevoke,
]);

function principal(role, overrides = {}) {
  const defaults = {
    admin: {
      id: "admin-1",
      domainIds: [],
      projectIds: [],
    },
    lead: {
      id: "lead-1",
      domainIds: ["customer_support"],
      projectIds: [],
    },
    builder: {
      id: "builder-1",
      domainIds: ["customer_support"],
      projectIds: ["case-assist"],
    },
    user: {
      id: "user-1",
      domainIds: [],
      projectIds: [],
    },
  };
  return {
    role,
    ...defaults[role],
    ...overrides,
  };
}

function domainResource(overrides = {}) {
  return {
    id: "domain-members/customer_support",
    domainId: "customer_support",
    lifecycleState: "ACTIVE",
    ...overrides,
  };
}

function projectResource(overrides = {}) {
  return {
    id: "project-members/customer_support/case-assist",
    domainId: "customer_support",
    projectId: "case-assist",
    lifecycleState: "ACTIVE",
    ...overrides,
  };
}

function matchingBreakGlass(action, resource, overrides = {}) {
  return {
    actorId: "admin-1",
    resourceId: resource.id,
    action,
    active: true,
    activatedAt: "2026-08-26T00:00:00.000Z",
    expiresAt: "2026-08-26T02:00:00.000Z",
    ...overrides,
  };
}

function request(action) {
  return {
    requestContext: REQUEST_CONTEXT,
    action,
    resourceRef: "access-resource-ref",
  };
}

function makeHarness({
  actor = principal("lead"),
  resource = domainResource(),
  policy = { allowed: true },
  breakGlass = null,
} = {}) {
  const calls = {
    resource: 0,
    policy: 0,
    breakGlass: 0,
  };
  const authorize = createAuthorizer({
    async resolvePrincipal() {
      return actor;
    },
    async resolveResource() {
      calls.resource += 1;
      return resource;
    },
    async resolvePolicy() {
      calls.policy += 1;
      return policy;
    },
    async resolveBreakGlass() {
      calls.breakGlass += 1;
      return breakGlass;
    },
    clock() {
      return NOW;
    },
  });
  return { authorize, calls };
}

async function expectDecision(work, decision, reason) {
  await assert.rejects(
    work,
    (error) => {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.decision, decision);
      assert.equal(error.reason, reason);
      assert.deepEqual(error.toJSON(), {
        decision,
        statusCode: decision === "NOT_FOUND"
          ? 404
          : decision === "CONFLICT"
            ? 409
            : 403,
        message: decision === "NOT_FOUND"
          ? "Resource not found."
          : decision === "CONFLICT"
            ? "The resource state does not permit the requested action."
            : "The requested action is not permitted.",
      });
      return true;
    },
  );
}

test("access administration contracts use canonical capabilities and scopes", () => {
  for (const action of READ_ACTIONS) {
    const contract = ACTION_CONTRACTS[action];
    assert.deepEqual(contract.capabilitiesByRole, {
      admin: "viewPlatformInventory",
      lead: "manageDomainMembers",
    });
    assert.equal(contract.operation, "read");
    assert.equal(contract.domainScope, true);
    assert.equal(
      contract.projectScope,
      action === ACTIONS.projectRead,
    );
    assert.equal(contract.selectedDomainScope, true);
    assert.deepEqual(contract.allowedStates, ["ACTIVE"]);
  }

  for (const action of MUTATION_ACTIONS) {
    const contract = ACTION_CONTRACTS[action];
    assert.deepEqual(contract.capabilitiesByRole, {
      admin: "managePlatformPolicy",
      lead: "manageDomainMembers",
    });
    assert.equal(contract.operation, "domain-content-mutation");
    assert.equal(contract.domainScope, true);
    assert.equal(
      contract.projectScope,
      action.startsWith("access.project-members."),
    );
    assert.equal(contract.selectedDomainScope, true);
    assert.deepEqual(contract.allowedStates, ["ACTIVE"]);
  }
});

for (const action of READ_ACTIONS) {
  test(`Platform Admin reads every active resource for ${action}`, async () => {
    const resource = action === ACTIONS.projectRead
      ? projectResource({
          domainId: "finance",
          projectId: "ledger",
        })
      : domainResource({ domainId: "finance" });
    const { authorize, calls } = makeHarness({
      actor: principal("admin"),
      resource,
    });

    const result = await authorize(request(action));

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.usedBreakGlass, false);
    assert.equal(calls.breakGlass, 0);
  });

  test(`Domain Lead reads the selected active domain for ${action}`, async () => {
    const resource = action === ACTIONS.projectRead
      ? projectResource({ projectId: "unassigned-project" })
      : domainResource();
    const { authorize, calls } = makeHarness({ resource });

    const result = await authorize(request(action));

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.usedBreakGlass, false);
    assert.equal(calls.breakGlass, 0);
  });

  test(`Domain Lead cannot discover a foreign domain for ${action}`, async () => {
    const resource = action === ACTIONS.projectRead
      ? projectResource({
          domainId: "finance",
          projectId: "ledger",
          lifecycleState: "SUSPENDED",
        })
      : domainResource({
          domainId: "finance",
          lifecycleState: "SUSPENDED",
        });
    const { authorize, calls } = makeHarness({
      resource,
      policy: { allowed: false },
    });

    await expectDecision(
      () => authorize(request(action)),
      "NOT_FOUND",
      "DOMAIN_SCOPE",
    );
    assert.equal(calls.policy, 0);
  });
}

test("Domain Lead access administration requires one selected assigned domain", async () => {
  const { authorize, calls } = makeHarness({
    actor: principal("lead", {
      domainIds: ["customer_support", "finance"],
    }),
  });

  await expectDecision(
    () => authorize(request(ACTIONS.domainRead)),
    "NOT_FOUND",
    "SELECTED_DOMAIN_SCOPE",
  );
  assert.equal(calls.policy, 0);
});

for (const action of [...READ_ACTIONS, ...MUTATION_ACTIONS]) {
  for (const role of ["builder", "user"]) {
    test(`${role} is denied ${action} before resource disclosure`, async () => {
      const { authorize, calls } = makeHarness({
        actor: principal(role),
      });

      await expectDecision(
        () => authorize(request(action)),
        "FORBIDDEN",
        "CAPABILITY",
      );
      assert.equal(calls.resource, 0);
      assert.equal(calls.policy, 0);
    });
  }
}

for (const action of [
  ACTIONS.projectRead,
  ACTIONS.projectGrant,
  ACTIONS.projectRevoke,
]) {
  test(`${action} requires a project-scoped resource`, async () => {
    const { authorize, calls } = makeHarness({
      resource: domainResource(),
    });

    await expectDecision(
      () => authorize(request(action)),
      "FORBIDDEN",
      "RESOURCE_INVALID",
    );
    assert.equal(calls.policy, 0);
  });
}

for (const action of [...READ_ACTIONS, ...MUTATION_ACTIONS]) {
  test(`${action} rejects inactive resources after policy evaluation`, async () => {
    const resource = action.startsWith("access.project-members.")
      ? projectResource({ lifecycleState: "SUSPENDED" })
      : domainResource({ lifecycleState: "SUSPENDED" });
    const { authorize, calls } = makeHarness({ resource });

    await expectDecision(
      () => authorize(request(action)),
      "CONFLICT",
      "LIFECYCLE",
    );
    assert.equal(calls.policy, 1);
  });
}

for (const action of MUTATION_ACTIONS) {
  test(`Domain Lead mutates the selected domain without break-glass for ${action}`, async () => {
    const resource = action.startsWith("access.project-members.")
      ? projectResource({ projectId: "unassigned-project" })
      : domainResource();
    const { authorize, calls } = makeHarness({ resource });

    const result = await authorize(request(action));

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.usedBreakGlass, false);
    assert.equal(calls.breakGlass, 0);
  });

  test(`Platform Admin requires break-glass outside platform for ${action}`, async () => {
    const resource = action.startsWith("access.project-members.")
      ? projectResource()
      : domainResource();
    const { authorize, calls } = makeHarness({
      actor: principal("admin"),
      resource,
      breakGlass: null,
    });

    await expectDecision(
      () => authorize(request(action)),
      "FORBIDDEN",
      "BREAK_GLASS_REQUIRED",
    );
    assert.equal(calls.breakGlass, 1);
    assert.equal(calls.policy, 0);
  });

  test(`Platform Admin uses an exact active break-glass grant for ${action}`, async () => {
    const resource = action.startsWith("access.project-members.")
      ? projectResource()
      : domainResource();
    const { authorize, calls } = makeHarness({
      actor: principal("admin"),
      resource,
      breakGlass: matchingBreakGlass(action, resource),
    });

    const result = await authorize(request(action));

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.usedBreakGlass, true);
    assert.equal(calls.breakGlass, 1);
  });

  test(`Platform Admin rejects a grant for another resource for ${action}`, async () => {
    const resource = action.startsWith("access.project-members.")
      ? projectResource()
      : domainResource();
    const { authorize, calls } = makeHarness({
      actor: principal("admin"),
      resource,
      breakGlass: matchingBreakGlass(action, resource, {
        resourceId: "different-resource",
      }),
    });

    await expectDecision(
      () => authorize(request(action)),
      "FORBIDDEN",
      "BREAK_GLASS_REQUIRED",
    );
    assert.equal(calls.policy, 0);
  });

  test(`Platform Admin mutates platform membership without break-glass for ${action}`, async () => {
    const resource = action.startsWith("access.project-members.")
      ? projectResource({
          id: "project-members/platform/platform-project",
          domainId: "platform",
          projectId: "platform-project",
        })
      : domainResource({
          id: "domain-members/platform",
          domainId: "platform",
        });
    const { authorize, calls } = makeHarness({
      actor: principal("admin"),
      resource,
    });

    const result = await authorize(request(action));

    assert.equal(result.decision, "ALLOW");
    assert.equal(result.usedBreakGlass, false);
    assert.equal(calls.breakGlass, 0);
  });
}
