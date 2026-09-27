import assert from "node:assert/strict";
import test from "node:test";
import * as authorization from "../lambda/authz/authorize.mjs";

const NOW = Date.parse("2026-08-25T00:00:00.000Z");
const REQUEST_CONTEXT = Object.freeze({
  requestId: "request-1",
  token: "opaque-authentication-context",
});

const PUBLIC_ERRORS = Object.freeze({
  NOT_FOUND: {
    decision: "NOT_FOUND",
    statusCode: 404,
    message: "Resource not found.",
  },
  FORBIDDEN: {
    decision: "FORBIDDEN",
    statusCode: 403,
    message: "The requested action is not permitted.",
  },
  CONFLICT: {
    decision: "CONFLICT",
    statusCode: 409,
    message: "The resource state does not permit the requested action.",
  },
});

const INVENTORY_CASES = Object.freeze([
  Object.freeze({
    action: "workspace.projects.read",
    state: "ACTIVE",
    capabilitiesByRole: Object.freeze({
      admin: "viewPlatformInventory",
      lead: "viewDomainInventory",
      builder: "viewAssignedProjects",
    }),
  }),
  Object.freeze({
    action: "workspace.agents.read",
    state: "CONFIGURED",
    capabilitiesByRole: Object.freeze({
      admin: "viewPlatformInventory",
      lead: "viewDomainInventory",
      builder: "viewDomainInventory",
    }),
  }),
  Object.freeze({
    action: "workspace.deployments.read",
    state: "DEPLOYED",
    capabilitiesByRole: Object.freeze({
      admin: "viewPlatformInventory",
      lead: "viewDomainOperations",
      builder: "viewOwnedOperations",
    }),
  }),
  Object.freeze({
    action: "workspace.approvals.read",
    state: "PENDING",
    capabilitiesByRole: Object.freeze({
      admin: "viewPlatformAudit",
      lead: "viewDomainAudit",
      builder: "viewOwnedOperations",
    }),
  }),
  Object.freeze({
    action: "workspace.operations.read",
    state: "RUNNING",
    capabilitiesByRole: Object.freeze({
      admin: "viewPlatformOperations",
      lead: "viewDomainOperations",
      builder: "viewOwnedOperations",
    }),
  }),
  Object.freeze({
    action: "workspace.costs.read",
    state: "ACTIVE",
    capabilitiesByRole: Object.freeze({
      admin: "viewPlatformCost",
      lead: "viewDomainCost",
      builder: "viewOwnedCost",
    }),
  }),
]);

const AGENT_READ_STATES = Object.freeze([
  "DRAFT",
  "CONFIGURED",
  "READY_FOR_TEST",
  "TEST_FAILED",
  "TESTED",
  "SANDBOX_ACTIVE",
  "SANDBOX_DEPLOYED",
  "PENDING_APPROVAL",
  "PRODUCTION_PENDING",
  "APPROVED",
  "PRODUCTION_APPROVED",
  "ACTIVE",
  "PRODUCTION_DEPLOYED",
  "SUSPENDED",
  "FAILED",
  "REJECTED",
  "RETIRED",
]);

function builderPrincipal(overrides = {}) {
  return {
    id: "builder-1",
    role: "builder",
    domainIds: ["customer_support"],
    projectIds: ["project-1"],
    ...overrides,
  };
}

function leadPrincipal(overrides = {}) {
  return {
    id: "lead-1",
    role: "lead",
    domainIds: ["customer_support"],
    projectIds: [],
    ...overrides,
  };
}

function adminPrincipal(overrides = {}) {
  return {
    id: "admin-1",
    role: "admin",
    domainIds: [],
    projectIds: [],
    ...overrides,
  };
}

function userPrincipal(overrides = {}) {
  return {
    id: "user-1",
    role: "user",
    domainIds: [],
    projectIds: [],
    ...overrides,
  };
}

function agentResource(overrides = {}) {
  return {
    id: "agent-1",
    domainId: "customer_support",
    projectId: "project-1",
    ownerId: "builder-1",
    assigneeIds: [],
    lifecycleState: "DRAFT",
    ...overrides,
  };
}

function governedResource(overrides = {}) {
  return {
    id: "resource-1",
    domainId: "customer_support",
    lifecycleState: "DRAFT",
    ...overrides,
  };
}

function matchingBreakGlass(overrides = {}) {
  return {
    actorId: "admin-1",
    resourceId: "agent-1",
    action: "agent:update",
    active: true,
    activatedAt: "2026-08-24T00:00:00.000Z",
    expiresAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function storedBreakGlass(overrides = {}) {
  return {
    id: "break-glass-1",
    domainId: "customer_support",
    projectId: "project-1",
    resource: "agent-1",
    action: "agent:update",
    status: "ACTIVE",
    requesterSubject: "admin-1",
    reason: "Restore a domain service during an incident.",
    requestedAt: "2026-08-24T23:30:00.000Z",
    expiresAt: "2026-08-25T00:30:00.000Z",
    approverSubject: "admin-2",
    decisionReason: "Peer approved.",
    decidedAt: "2026-08-24T23:31:00.000Z",
    activatedBySubject: "admin-1",
    activationReason: "Begin incident recovery.",
    activatedAt: "2026-08-24T23:32:00.000Z",
    revokedBySubject: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  };
}

function approvalRecord(overrides = {}) {
  return {
    requesterId: "builder-1",
    resourceId: "agent-1",
    action: "deployment:approve",
    ...overrides,
  };
}

function request(action, {
  resourceRef = "resource-ref-1",
  approvalRef,
} = {}) {
  const input = {
    requestContext: REQUEST_CONTEXT,
    action,
    resourceRef,
  };
  if (approvalRef !== undefined) input.approvalRef = approvalRef;
  return input;
}

function makeHarness({
  principal = builderPrincipal(),
  resource = agentResource(),
  policy = { allowed: true },
  entitlement = { granted: true },
  approval = approvalRecord(),
  breakGlass = null,
  clock = () => NOW,
  omit = [],
} = {}) {
  const calls = {
    principal: [],
    resource: [],
    policy: [],
    entitlement: [],
    approval: [],
    breakGlass: [],
    clock: 0,
  };

  async function resolve(value, args) {
    return typeof value === "function"
      ? value(args)
      : value;
  }

  const dependencies = {
    resolvePrincipal: async (args) => {
      calls.principal.push(args);
      return resolve(principal, args);
    },
    resolveResource: async (args) => {
      calls.resource.push(args);
      return resolve(resource, args);
    },
    resolvePolicy: async (args) => {
      calls.policy.push(args);
      return resolve(policy, args);
    },
    resolveEntitlement: async (args) => {
      calls.entitlement.push(args);
      return resolve(entitlement, args);
    },
    resolveApproval: async (args) => {
      calls.approval.push(args);
      return resolve(approval, args);
    },
    resolveBreakGlass: async (args) => {
      calls.breakGlass.push(args);
      return resolve(breakGlass, args);
    },
    clock: () => {
      calls.clock += 1;
      return clock();
    },
  };

  for (const name of omit) delete dependencies[name];

  return {
    authorize: authorization.createAuthorizer(dependencies),
    calls,
  };
}

async function expectDecision(work, decision, reason) {
  let error;
  try {
    await work();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof authorization.AuthorizationError);
  assert.equal(error.decision, decision);
  assert.equal(error.statusCode, PUBLIC_ERRORS[decision].statusCode);
  assert.equal(error.message, PUBLIC_ERRORS[decision].message);
  assert.equal(error.reason, reason);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(error, "reason"),
    false,
  );
  assert.deepEqual(error.toJSON(), PUBLIC_ERRORS[decision]);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), PUBLIC_ERRORS[decision]);
  assert.equal("code" in error, false);
  assert.equal("retryable" in error, false);
  return error;
}

test("authorization exports only the server-owned authorizer entry point", () => {
  assert.equal(typeof authorization.createAuthorizer, "function");
  assert.equal(typeof authorization.authorize, "undefined");
});

test("action contracts are immutable, deeply frozen, and prototype-safe", () => {
  assert.equal(Object.getPrototypeOf(authorization.ACTION_CONTRACTS), null);
  assert.equal(Object.isFrozen(authorization.ACTION_CONTRACTS), true);
  assert.equal(
    Object.isFrozen(
      authorization.ACTION_CONTRACTS["agent:update"].allowedStates,
    ),
    true,
  );
  assert.deepEqual(
    Object.keys(authorization.ACTION_CONTRACTS).sort(),
    [
      "access.domain-members.grant",
      "access.domain-members.read",
      "access.domain-members.revoke",
      "access.project-members.grant",
      "access.project-members.read",
      "access.project-members.revoke",
      "agent:access-request",
      "agent:create",
      "agent:entitlement-decide",
      "agent:entitlement-grant",
      "agent:entitlement-revoke",
      "agent:invoke",
      "agent:production-submit",
      "agent:read",
      "agent:sandbox-deploy",
      "agent:test",
      "agent:update",
      "deployment:approve",
      "model-access:decide",
      "model-access:request",
      "model-catalog:read",
      "model-policy:update",
      "model:use",
      "platform-policy:update",
      "project:create",
      "project:read",
      "resource:access-decide",
      "resource:access-request",
      "resource:access-revoke",
      "resource:draft-register",
      "resource:publication-approve",
      "resource:publication-initiate",
      "resource:publication-submit",
      "resource:visibility-set",
      "shared-resource:discover",
      "trace:read-content",
      "workspace.agents.read",
      "workspace.approvals.read",
      "workspace.audit.read",
      "workspace.break-glass.activate",
      "workspace.break-glass.decide",
      "workspace.break-glass.read",
      "workspace.break-glass.request",
      "workspace.break-glass.revoke",
      "workspace.costs.read",
      "workspace.deployments.read",
      "workspace.incidents.acknowledge",
      "workspace.incidents.create",
      "workspace.incidents.read",
      "workspace.incidents.reopen",
      "workspace.incidents.resolve",
      "workspace.operations.read",
      "workspace.platform-costs.read",
      "workspace.projects.read",
    ],
  );
  assert.throws(
    () => {
      authorization.ACTION_CONTRACTS["agent:update"].capability =
        "managePlatformPolicy";
    },
    TypeError,
  );
  assert.throws(
    () => {
      authorization.ACTION_CONTRACTS["agent:update"].allowedStates.push(
        "ACTIVE",
      );
    },
    TypeError,
  );
});

test("operations workflow contracts preserve the approved persona boundaries", () => {
  assert.deepEqual(
    authorization.ACTION_CONTRACTS["workspace.audit.read"]
      .capabilitiesByRole,
    {
      admin: "viewPlatformAudit",
      lead: "viewDomainAudit",
    },
  );
  assert.deepEqual(
    authorization.ACTION_CONTRACTS["workspace.incidents.read"]
      .capabilitiesByRole,
    {
      admin: "viewPlatformOperations",
      lead: "viewDomainOperations",
      builder: "viewOwnedIncidents",
    },
  );
  for (const action of [
    "workspace.incidents.create",
    "workspace.incidents.acknowledge",
    "workspace.incidents.resolve",
    "workspace.incidents.reopen",
  ]) {
    assert.deepEqual(
      authorization.ACTION_CONTRACTS[action].capabilitiesByRole,
      {
        admin: "managePlatformIncidents",
        lead: "manageDomainIncidents",
      },
      action,
    );
  }
  for (const [action, capability, state] of [
    ["workspace.break-glass.request", "requestBreakGlassAccess", "REQUESTED"],
    ["workspace.break-glass.decide", "approveBreakGlassAccess", "REQUESTED"],
    ["workspace.break-glass.activate", "activateBreakGlassAccess", "APPROVED"],
    ["workspace.break-glass.revoke", "revokeBreakGlassAccess", "ACTIVE"],
  ]) {
    const contract = authorization.ACTION_CONTRACTS[action];
    assert.equal(contract.capability, capability);
    assert.deepEqual(contract.allowedStates, [state]);
    assert.equal(contract.domainScope, true);
  }
  assert.equal(
    authorization.ACTION_CONTRACTS["workspace.break-glass.read"].capability,
    "viewBreakGlassAudit",
  );
});

test("platform and domain approvals use distinct role capabilities", () => {
  for (const [action, adminCapability, leadCapability] of [
    [
      "deployment:approve",
      "approvePlatformDeployment",
      "approveDomainDeployment",
    ],
    [
      "resource:publication-approve",
      "approvePlatformPublication",
      "approveDomainPublication",
    ],
  ]) {
    const contract = authorization.ACTION_CONTRACTS[action];
    assert.equal(contract.capability, null);
    assert.deepEqual(contract.capabilitiesByRole, {
      admin: adminCapability,
      lead: leadCapability,
    });
    assert.equal(contract.adminPlatformOnly, true);
  }
});

test("workspace inventory contracts centralize approved capabilities and scopes", () => {
  for (const inventory of INVENTORY_CASES) {
    const contract = authorization.ACTION_CONTRACTS[inventory.action];
    assert.ok(contract, inventory.action);
    assert.equal(contract.operation, "read");
    assert.equal(contract.domainScope, true);
    assert.equal(contract.projectScope, true);
    assert.deepEqual(contract.ownerRoles, ["builder"]);
    assert.deepEqual(
      contract.capabilitiesByRole,
      inventory.capabilitiesByRole,
    );
    assert.equal(Object.isFrozen(contract.capabilitiesByRole), true);
    assert.equal(contract.entitlement, false);
    assert.equal(contract.approval, false);
    assert.equal(contract.protectedTrace, false);
  }
});

test("project creation is a domain-scoped canonical capability action for Admin and Lead only", async () => {
  const contract = authorization.ACTION_CONTRACTS["project:create"];
  assert.deepEqual(contract.capabilitiesByRole, {
    admin: "usePlatformBuilderWorkspace",
    lead: "createDomainProject",
  });
  assert.equal(contract.operation, "domain-content-mutation");
  assert.equal(contract.domainScope, true);
  assert.equal(contract.projectScope, false);
  assert.deepEqual(contract.ownerRoles, []);
  assert.deepEqual(contract.allowedStates, ["ACTIVE"]);

  for (const principal of [
    adminPrincipal({ domainIds: ["platform"] }),
    leadPrincipal(),
  ]) {
    const domainId = principal.role === "admin"
      ? "platform"
      : "customer_support";
    const { authorize } = makeHarness({
      principal,
      resource: governedResource({
        id: `project-create:${domainId}/case-assist`,
        domainId,
        lifecycleState: "ACTIVE",
      }),
    });
    assert.equal(
      (await authorize(request("project:create"))).decision,
      "ALLOW",
    );
  }

  for (const principal of [userPrincipal(), builderPrincipal()]) {
    const { authorize, calls } = makeHarness({
      principal,
      resource: governedResource({ lifecycleState: "ACTIVE" }),
    });
    await expectDecision(
      () => authorize(request("project:create")),
      "FORBIDDEN",
      "CAPABILITY",
    );
    assert.equal(calls.resource.length, 0);
  }
});

test("model governance contracts preserve the approved persona decisions", () => {
  assert.deepEqual(
    authorization.ACTION_CONTRACTS["model-catalog:read"]
      .capabilitiesByRole,
    {
      admin: "manageModelAccessPolicy",
      lead: "selectApprovedModel",
      builder: "selectApprovedModel",
    },
  );
  assert.equal(
    authorization.ACTION_CONTRACTS["model-policy:update"].capability,
    "manageModelAccessPolicy",
  );
  assert.equal(
    authorization.ACTION_CONTRACTS["model-access:request"].capability,
    "requestModelAccess",
  );
  assert.equal(
    authorization.ACTION_CONTRACTS["model-access:decide"].capability,
    "decideDomainResourceAccess",
  );
  assert.equal(
    authorization.ACTION_CONTRACTS["model-access:decide"].approval,
    true,
  );
  assert.equal(
    authorization.ACTION_CONTRACTS["model:use"].capability,
    "selectApprovedModel",
  );
});

test("workspace inventory permits approved Admin, Lead, and Builder scopes", async () => {
  for (const inventory of INVENTORY_CASES) {
    const admin = makeHarness({
      principal: adminPrincipal(),
      resource: agentResource({
        domainId: "finance",
        projectId: "finance-project",
        ownerId: "finance-builder",
        lifecycleState: inventory.state,
      }),
    });
    assert.equal(
      (await admin.authorize(request(inventory.action))).decision,
      "ALLOW",
      `${inventory.action} admin`,
    );

    const lead = makeHarness({
      principal: leadPrincipal(),
      resource: agentResource({
        projectId: "any-domain-project",
        ownerId: "builder-2",
        lifecycleState: inventory.state,
      }),
    });
    assert.equal(
      (await lead.authorize(request(inventory.action))).decision,
      "ALLOW",
      `${inventory.action} lead`,
    );

    const builder = makeHarness({
      principal: builderPrincipal(),
      resource: agentResource({
        lifecycleState: inventory.state,
      }),
    });
    assert.equal(
      (await builder.authorize(request(inventory.action))).decision,
      "ALLOW",
      `${inventory.action} builder`,
    );
  }
});

test("workspace inventory conceals foreign Builder domain, project, and owner scopes", async () => {
  for (const inventory of INVENTORY_CASES) {
    for (const [reason, resource] of [
      ["DOMAIN_SCOPE", agentResource({
        domainId: "finance",
        lifecycleState: inventory.state,
      })],
      ["PROJECT_SCOPE", agentResource({
        projectId: "project-2",
        lifecycleState: inventory.state,
      })],
      ["OWNER_SCOPE", agentResource({
        ownerId: "builder-2",
        assigneeIds: ["builder-3"],
        lifecycleState: inventory.state,
      })],
    ]) {
      const { authorize } = makeHarness({ resource });
      await expectDecision(
        () => authorize(request(inventory.action)),
        "NOT_FOUND",
        reason,
      );
    }
  }
});

test("End User fails closed for every workspace inventory action", async () => {
  for (const inventory of INVENTORY_CASES) {
    const { authorize, calls } = makeHarness({
      principal: userPrincipal({
        capabilities: Object.values(inventory.capabilitiesByRole),
      }),
      resource: agentResource({ lifecycleState: inventory.state }),
    });

    await expectDecision(
      () => authorize(request(inventory.action)),
      "FORBIDDEN",
      "CAPABILITY",
    );
    assert.equal(calls.resource.length, 0, inventory.action);
    assert.equal(calls.policy.length, 0, inventory.action);
  }
});

test("agent detail and inventory reads support every legitimate lifecycle state", async () => {
  assert.deepEqual(
    authorization.ACTION_CONTRACTS["agent:read"].allowedStates,
    AGENT_READ_STATES,
  );
  assert.deepEqual(
    authorization.ACTION_CONTRACTS["workspace.agents.read"].allowedStates,
    AGENT_READ_STATES,
  );

  for (const action of ["agent:read", "workspace.agents.read"]) {
    for (const lifecycleState of AGENT_READ_STATES) {
      const { authorize } = makeHarness({
        resource: agentResource({ lifecycleState }),
      });
      assert.equal(
        (await authorize(request(action))).decision,
        "ALLOW",
        `${action} ${lifecycleState}`,
      );
    }

    const { authorize } = makeHarness({
      resource: agentResource({ lifecycleState: "DELETED" }),
    });
    await expectDecision(
      () => authorize(request(action)),
      "CONFLICT",
      "LIFECYCLE",
    );
  }
});

test("createAuthorizer rejects malformed server dependency configuration", () => {
  assert.throws(
    () => authorization.createAuthorizer(null),
    TypeError,
  );
  assert.throws(
    () => authorization.createAuthorizer({
      resolvePrincipal: async () => builderPrincipal(),
      resolveResource: async () => agentResource(),
      resolvePolicy: async () => ({ allowed: true }),
      clock: "now",
    }),
    TypeError,
  );
});

test("inherited optional dependencies cannot fabricate break-glass access", async () => {
  Object.defineProperty(Object.prototype, "resolveBreakGlass", {
    value: async () => matchingBreakGlass(),
    configurable: true,
    enumerable: false,
    writable: true,
  });

  try {
    const authorize = authorization.createAuthorizer({
      resolvePrincipal: async () => adminPrincipal(),
      resolveResource: async () => agentResource(),
      resolvePolicy: async () => ({ allowed: true }),
      clock: () => NOW,
    });

    await expectDecision(
      () => authorize(request("agent:update")),
      "FORBIDDEN",
      "BREAK_GLASS_RESOLVER_UNAVAILABLE",
    );
  } finally {
    delete Object.prototype.resolveBreakGlass;
  }
});

test("validated dependency resolvers are snapshotted exactly once", async () => {
  let dependencyReads = 0;
  const safePrincipal = async () => userPrincipal();
  const maliciousPrincipal = async () => adminPrincipal();
  const target = {
    resolvePrincipal: safePrincipal,
    resolveResource: async () =>
      agentResource({ lifecycleState: "ACTIVE" }),
    resolvePolicy: async () => ({ allowed: true }),
    clock: () => NOW,
  };
  const dependencies = new Proxy(target, {
    get(object, key, receiver) {
      if (key === "resolvePrincipal") {
        dependencyReads += 1;
        return maliciousPrincipal;
      }
      return Reflect.get(object, key, receiver);
    },
  });
  const authorize = authorization.createAuthorizer(dependencies);

  await expectDecision(
    () => authorize(request("platform-policy:update")),
    "FORBIDDEN",
    "CAPABILITY",
  );
  assert.equal(dependencyReads, 0);
});

test("the returned authorizer accepts only opaque context, action key, and references", async () => {
  const { authorize, calls } = makeHarness();

  const result = await authorize(request("agent:update"));

  assert.deepEqual(result, {
    ok: true,
    decision: "ALLOW",
    actorId: "builder-1",
    role: "builder",
    action: "agent:update",
    resourceId: "agent-1",
    usedBreakGlass: false,
  });
  assert.equal(calls.principal[0].requestContext, REQUEST_CONTEXT);
  assert.equal(calls.principal[0].action, "agent:update");
  assert.equal(calls.principal[0].resourceRef, "resource-ref-1");
  assert.equal(calls.resource[0].requestContext, REQUEST_CONTEXT);
  assert.equal(calls.resource[0].principal.id, "builder-1");
});

for (const [name, value] of [
  ["principal", builderPrincipal()],
  ["capabilities", ["managePlatformPolicy"]],
  ["requirements", { domainScope: false }],
  ["lifecycle", { allowedStates: ["DRAFT"] }],
  ["policy", { allowed: true }],
  ["entitlement", { granted: true }],
  ["breakGlass", matchingBreakGlass()],
  ["now", NOW],
]) {
  test(`caller cannot inject ${name}`, async () => {
    const { authorize, calls } = makeHarness();
    const input = request("agent:update");
    input[name] = value;

    await expectDecision(
      () => authorize(input),
      "FORBIDDEN",
      "INVALID_INPUT",
    );
    assert.equal(calls.principal.length, 0);
  });
}

test("caller cannot inject an approval body", async () => {
  const { authorize, calls } = makeHarness({
    principal: leadPrincipal(),
    resource: agentResource({ lifecycleState: "PENDING_APPROVAL" }),
  });
  const input = request("deployment:approve", {
    approvalRef: "approval-ref-1",
  });
  input.approval = approvalRecord();

  await expectDecision(
    () => authorize(input),
    "FORBIDDEN",
    "INVALID_INPUT",
  );
  assert.equal(calls.principal.length, 0);
});

test("prototype-inherited request fields are rejected", async () => {
  const { authorize, calls } = makeHarness();
  const input = Object.create(request("agent:update"));

  await expectDecision(
    () => authorize(input),
    "FORBIDDEN",
    "INVALID_INPUT",
  );
  assert.equal(calls.principal.length, 0);
});

for (const [name, addHiddenField] of [
  ["non-enumerable", (input) => {
    Object.defineProperty(input, "policy", {
      value: { allowed: true },
      enumerable: false,
    });
  }],
  ["symbol", (input) => {
    input[Symbol("policy")] = { allowed: true };
  }],
]) {
  test(`${name} caller policy fields are rejected`, async () => {
    const { authorize, calls } = makeHarness();
    const input = request("agent:update");
    addHiddenField(input);

    await expectDecision(
      () => authorize(input),
      "FORBIDDEN",
      "INVALID_INPUT",
    );
    assert.equal(calls.principal.length, 0);
  });
}

test("request accessors fail closed without executing caller code", async () => {
  const { authorize, calls } = makeHarness();
  const input = request("agent:update");
  let getterCalls = 0;
  Object.defineProperty(input, "action", {
    get() {
      getterCalls += 1;
      throw new Error("caller-controlled getter detail");
    },
    enumerable: true,
  });

  const error = await expectDecision(
    () => authorize(input),
    "FORBIDDEN",
    "INVALID_INPUT",
  );
  assert.equal(getterCalls, 0);
  assert.doesNotMatch(JSON.stringify(error), /getter detail/i);
  assert.equal(calls.principal.length, 0);
});

for (const action of ["toString", "__proto__", "constructor", "unknown"]) {
  test(`prototype or unknown action key ${action} is rejected`, async () => {
    const { authorize } = makeHarness();
    await expectDecision(
      () => authorize(request(action)),
      "FORBIDDEN",
      "INVALID_INPUT",
    );
  });
}

test("canonical role capabilities ignore resolver-supplied capability escalation", async () => {
  const { authorize, calls } = makeHarness({
    principal: userPrincipal({
      capabilities: ["managePlatformPolicy"],
    }),
    resource: agentResource({ lifecycleState: "ACTIVE" }),
  });

  await expectDecision(
    () => authorize(request("platform-policy:update")),
    "FORBIDDEN",
    "CAPABILITY",
  );
  assert.equal(calls.resource.length, 0);
  assert.equal(calls.policy.length, 0);
});

test("canonical admin capabilities permit platform governance globally without break-glass", async () => {
  const { authorize, calls } = makeHarness({
    principal: adminPrincipal({ capabilities: [] }),
    resource: agentResource({
      domainId: "finance",
      projectId: "foreign-project",
      lifecycleState: "ACTIVE",
    }),
  });

  const result = await authorize(request("platform-policy:update"));

  assert.equal(result.decision, "ALLOW");
  assert.equal(result.usedBreakGlass, false);
  assert.equal(calls.breakGlass.length, 0);
});

test("foreign domain scope is concealed before policy and lifecycle checks", async () => {
  const { authorize, calls } = makeHarness({
    principal: builderPrincipal(),
    resource: agentResource({
      domainId: "finance",
      lifecycleState: "ACTIVE",
    }),
    policy: { allowed: false },
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "NOT_FOUND",
    "DOMAIN_SCOPE",
  );
  assert.equal(calls.policy.length, 0);
});

test("foreign project scope is concealed", async () => {
  const { authorize } = makeHarness({
    resource: agentResource({ projectId: "project-2" }),
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "NOT_FOUND",
    "PROJECT_SCOPE",
  );
});

test("foreign owner scope is concealed from a builder", async () => {
  const { authorize } = makeHarness({
    resource: agentResource({
      ownerId: "builder-2",
      assigneeIds: ["builder-3"],
    }),
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "NOT_FOUND",
    "OWNER_SCOPE",
  );
});

test("a builder may mutate an owned or assigned domain resource", async () => {
  const owned = makeHarness();
  assert.equal(
    (await owned.authorize(request("agent:update"))).decision,
    "ALLOW",
  );

  const assigned = makeHarness({
    resource: agentResource({
      ownerId: "builder-2",
      assigneeIds: ["builder-1"],
    }),
  });
  assert.equal(
    (await assigned.authorize(request("agent:update"))).decision,
    "ALLOW",
  );
});

test("a Domain Lead may mutate another builder resource inside the owned domain", async () => {
  const { authorize, calls } = makeHarness({
    principal: leadPrincipal(),
    resource: agentResource({
      projectId: "project-not-assigned-to-lead",
      ownerId: "builder-2",
    }),
  });

  assert.equal(
    (await authorize(request("agent:update"))).decision,
    "ALLOW",
  );
  assert.equal(calls.breakGlass.length, 0);
});

test("Platform Admin may read foreign project metadata without break-glass", async () => {
  const { authorize, calls } = makeHarness({
    principal: adminPrincipal(),
    resource: agentResource({
      domainId: "finance",
      projectId: "finance-project",
      lifecycleState: "ACTIVE",
    }),
  });

  assert.equal(
    (await authorize(request("project:read"))).decision,
    "ALLOW",
  );
  assert.equal(calls.breakGlass.length, 0);
});

test("an entitled End User may invoke an active agent", async () => {
  const { authorize, calls } = makeHarness({
    principal: userPrincipal(),
    resource: agentResource({ lifecycleState: "ACTIVE" }),
    entitlement: { granted: true },
  });

  const result = await authorize(request("agent:invoke"));

  assert.equal(result.decision, "ALLOW");
  assert.equal(calls.entitlement.length, 1);
});

test("an unentitled agent is concealed before capability and policy checks", async () => {
  const { authorize, calls } = makeHarness({
    principal: userPrincipal({
      capabilities: ["invokeEntitledAgent"],
    }),
    resource: agentResource({ lifecycleState: "ACTIVE" }),
    entitlement: { granted: false },
    policy: { allowed: false },
  });

  await expectDecision(
    () => authorize(request("agent:invoke")),
    "NOT_FOUND",
    "ENTITLEMENT",
  );
  assert.equal(calls.policy.length, 0);
});

test("missing entitlement resolver fails closed", async () => {
  const { authorize } = makeHarness({
    principal: userPrincipal(),
    resource: agentResource({ lifecycleState: "ACTIVE" }),
    omit: ["resolveEntitlement"],
  });

  await expectDecision(
    () => authorize(request("agent:invoke")),
    "FORBIDDEN",
    "ENTITLEMENT_RESOLVER_UNAVAILABLE",
  );
});

test("lifecycle allowed states come from the immutable action contract", async () => {
  const { authorize } = makeHarness({
    resource: agentResource({ lifecycleState: "ACTIVE" }),
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "CONFLICT",
    "LIFECYCLE",
  );
});

for (const lifecycleState of ["READY_FOR_TEST", "TEST_FAILED", "TESTED"]) {
test(`configured agents can be tested from ${lifecycleState}`, async () => {
  const { authorize } = makeHarness({
    resource: agentResource({ lifecycleState }),
  });

  assert.equal(
    (await authorize(request("agent:test"))).decision,
    "ALLOW",
  );
});
}

test("retesting does not allow a builder to test another owner's agent", async () => {
  const { authorize } = makeHarness({
    resource: agentResource({ lifecycleState: "TESTED", ownerId: "another-builder" }),
  });
  await expectDecision(
    () => authorize(request("agent:test")),
    "NOT_FOUND",
    "OWNER_SCOPE",
  );
});

test("sandbox-deployed agents may be submitted for production", async () => {
  const { authorize } = makeHarness({
    resource: agentResource({ lifecycleState: "SANDBOX_DEPLOYED" }),
  });

  assert.equal(
    (await authorize(request("agent:production-submit"))).decision,
    "ALLOW",
  );
});

test("authoritative policy denial cannot be overridden by the caller", async () => {
  const { authorize } = makeHarness({
    policy: { allowed: false },
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "POLICY",
  );
});

test("a different Domain Lead may approve a pending deployment", async () => {
  const { authorize, calls } = makeHarness({
    principal: leadPrincipal(),
    resource: agentResource({ lifecycleState: "PENDING_APPROVAL" }),
    approval: approvalRecord({ requesterId: "builder-1" }),
  });

  const result = await authorize(request("deployment:approve", {
    approvalRef: "approval-ref-1",
  }));

  assert.equal(result.decision, "ALLOW");
  assert.equal(calls.approval.length, 1);
});

test("all approvals enforce requester-not-approver", async () => {
  const { authorize } = makeHarness({
    principal: leadPrincipal(),
    resource: agentResource({ lifecycleState: "PENDING_APPROVAL" }),
    approval: approvalRecord({ requesterId: "lead-1" }),
  });

  await expectDecision(
    () => authorize(request("deployment:approve", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "REQUESTER_IS_APPROVER",
  );
});

for (const [name, approval] of [
  ["resource", approvalRecord({ resourceId: "agent-2" })],
  ["action", approvalRecord({ action: "publication:approve" })],
]) {
  test(`approval reference cannot be rebound to another ${name}`, async () => {
    const { authorize } = makeHarness({
      principal: leadPrincipal(),
      resource: agentResource({ lifecycleState: "PENDING_APPROVAL" }),
      approval,
    });

    await expectDecision(
      () => authorize(request("deployment:approve", {
        approvalRef: "approval-ref-1",
      })),
      "NOT_FOUND",
      "APPROVAL_SCOPE",
    );
  });
}

test("approval actions require an opaque approval reference", async () => {
  const { authorize, calls } = makeHarness({
    principal: leadPrincipal(),
    resource: agentResource({ lifecycleState: "PENDING_APPROVAL" }),
  });

  await expectDecision(
    () => authorize(request("deployment:approve")),
    "FORBIDDEN",
    "INVALID_INPUT",
  );
  assert.equal(calls.principal.length, 0);
});

test("non-approval actions reject an approval reference", async () => {
  const { authorize, calls } = makeHarness();

  await expectDecision(
    () => authorize(request("agent:update", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "INVALID_INPUT",
  );
  assert.equal(calls.principal.length, 0);
});

test("Platform Admin cannot become a routine domain approver through break-glass", async () => {
  const { authorize } = makeHarness({
    principal: adminPrincipal(),
    resource: agentResource({ lifecycleState: "PENDING_APPROVAL" }),
    approval: approvalRecord(),
    breakGlass: matchingBreakGlass({
      action: "deployment:approve",
    }),
  });

  await expectDecision(
    () => authorize(request("deployment:approve", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "PLATFORM_APPROVAL_SCOPE",
  );
});

test("operational incident mutations use exact break-glass for foreign Admin only", async () => {
  for (const [action, lifecycleState] of [
    ["workspace.incidents.create", "ACTIVE"],
    ["workspace.incidents.acknowledge", "OPEN"],
    ["workspace.incidents.resolve", "ACKNOWLEDGED"],
    ["workspace.incidents.reopen", "RESOLVED"],
  ]) {
    const resource = agentResource({
      id: action === "workspace.incidents.create"
        ? "case-assist"
        : "incident-1",
      lifecycleState,
    });
    const denied = makeHarness({
      principal: adminPrincipal(),
      resource,
    });
    await expectDecision(
      () => denied.authorize(request(action)),
      "FORBIDDEN",
      "BREAK_GLASS_REQUIRED",
    );

    const exactGrant = makeHarness({
      principal: adminPrincipal(),
      resource,
      breakGlass: matchingBreakGlass({
        resourceId: resource.id,
        action,
      }),
    });
    assert.equal(
      (await exactGrant.authorize(request(action))).usedBreakGlass,
      true,
      action,
    );

    const platform = makeHarness({
      principal: adminPrincipal(),
      resource: {
        ...resource,
        domainId: "platform",
        projectId: "platform-project",
      },
    });
    assert.equal(
      (await platform.authorize(request(action))).usedBreakGlass,
      false,
      action,
    );
    assert.equal(platform.calls.breakGlass.length, 0, action);

    const lead = makeHarness({
      principal: leadPrincipal(),
      resource,
    });
    assert.equal(
      (await lead.authorize(request(action))).decision,
      "ALLOW",
      action,
    );
    assert.equal(lead.calls.breakGlass.length, 0, action);
  }
});

test("Platform Admin may mutate platform-domain content without break-glass", async () => {
  const { authorize, calls } = makeHarness({
    principal: adminPrincipal(),
    resource: agentResource({
      domainId: "platform",
      projectId: "platform-project",
    }),
  });

  const result = await authorize(request("agent:update"));

  assert.equal(result.decision, "ALLOW");
  assert.equal(result.usedBreakGlass, false);
  assert.equal(calls.breakGlass.length, 0);
});

test("Platform Admin may build inside the explicitly selected domain without break-glass", async () => {
  for (const [action, lifecycleState] of [
    ["agent:create", "ACTIVE"],
    ["agent:update", "DRAFT"],
    ["agent:test", "READY_FOR_TEST"],
    ["agent:test", "TESTED"],
    ["model:use", "ACTIVE"],
  ]) {
    const { authorize, calls } = makeHarness({
      principal: adminPrincipal({
        activeDomain: "customer_support",
        domainIds: ["platform", "customer_support"],
      }),
      resource: agentResource({ lifecycleState }),
    });

    const result = await authorize(request(action));

    assert.equal(result.decision, "ALLOW", action);
    assert.equal(result.usedBreakGlass, false, action);
    assert.equal(calls.breakGlass.length, 0, action);
  }
});

test("Platform Admin still needs break-glass outside the explicitly selected domain", async () => {
  const { authorize } = makeHarness({
    principal: adminPrincipal({
      activeDomain: "platform",
      domainIds: ["platform", "customer_support"],
    }),
    resource: agentResource({ lifecycleState: "DRAFT" }),
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "BREAK_GLASS_REQUIRED",
  );
});

test("authz exposes a portable workspace break-glass resolver", () => {
  assert.equal(
    typeof authorization.createWorkspaceBreakGlassResolver,
    "function",
  );
});

test("workspace break-glass resolver returns an exact active actor grant", async () => {
  const calls = [];
  const resolveBreakGlass =
    authorization.createWorkspaceBreakGlassResolver({
      workspaceState: {
        async listBreakGlass(input) {
          calls.push(input);
          return {
            items: [storedBreakGlass()],
            cursor: null,
          };
        },
      },
    });

  const result = await resolveBreakGlass({
    action: "agent:update",
    principal: adminPrincipal(),
    resource: agentResource(),
  });

  assert.deepEqual(result, matchingBreakGlass({
    activatedAt: "2026-08-24T23:32:00.000Z",
    expiresAt: "2026-08-25T00:30:00.000Z",
  }));
  assert.deepEqual(calls, [{
    requesterSubject: "admin-1",
    limit: 100,
  }]);
});

for (const [name, record] of [
  [
    "wrong actor",
    storedBreakGlass({ requesterSubject: "different-admin" }),
  ],
  [
    "wrong domain",
    storedBreakGlass({ domainId: "operations" }),
  ],
  [
    "wrong resource",
    storedBreakGlass({ resource: "agent-2" }),
  ],
  [
    "wrong action",
    storedBreakGlass({ action: "agent:test" }),
  ],
  [
    "revoked grant",
    storedBreakGlass({
      status: "REVOKED",
      revokedBySubject: "admin-2",
      revocationReason: "Incident recovery completed.",
      revokedAt: "2026-08-24T00:03:00.000Z",
    }),
  ],
  [
    "expired grant",
    storedBreakGlass({
      requestedAt: "2026-08-24T00:00:00.000Z",
      decidedAt: "2026-08-24T00:01:00.000Z",
      activatedAt: "2026-08-24T00:02:00.000Z",
      expiresAt: "2026-08-24T01:00:00.000Z",
    }),
  ],
]) {
  test(`workspace break-glass resolver fails closed for ${name}`, async () => {
    const resolveBreakGlass =
      authorization.createWorkspaceBreakGlassResolver({
        workspaceState: {
          async listBreakGlass() {
            return { items: [record], cursor: null };
          },
        },
      });
    const { authorize } = makeHarness({
      principal: adminPrincipal(),
      breakGlass: resolveBreakGlass,
    });

    await expectDecision(
      () => authorize(request("agent:update")),
      "FORBIDDEN",
      "BREAK_GLASS_REQUIRED",
    );
  });
}

test("workspace break-glass resolver follows bounded state cursors", async () => {
  const cursor = {
    pk: "BREAK_GLASS",
    sk: "BREAK_GLASS#first-page",
  };
  const calls = [];
  const resolveBreakGlass =
    authorization.createWorkspaceBreakGlassResolver({
      workspaceState: {
        async listBreakGlass(input) {
          calls.push(input);
          return input.cursor === undefined
            ? {
                items: [storedBreakGlass({ resource: "agent-2" })],
                cursor,
              }
            : {
                items: [storedBreakGlass()],
                cursor: null,
              };
        },
      },
    });

  const result = await resolveBreakGlass({
    action: "agent:update",
    principal: adminPrincipal(),
    resource: agentResource(),
  });

  assert.equal(result.active, true);
  assert.deepEqual(calls, [
    {
      requesterSubject: "admin-1",
      limit: 100,
    },
    {
      requesterSubject: "admin-1",
      limit: 100,
      cursor,
    },
  ]);
});

test("Platform Admin cannot mutate non-platform domain content without break-glass", async () => {
  const { authorize, calls } = makeHarness({
    principal: adminPrincipal(),
    breakGlass: null,
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "BREAK_GLASS_REQUIRED",
  );
  assert.equal(calls.breakGlass.length, 1);
});

test("Platform Admin may mutate non-platform content with active matching break-glass", async () => {
  const { authorize, calls } = makeHarness({
    principal: adminPrincipal(),
    breakGlass: matchingBreakGlass(),
  });

  const result = await authorize(request("agent:update"));

  assert.equal(result.decision, "ALLOW");
  assert.equal(result.usedBreakGlass, true);
  assert.equal(calls.breakGlass.length, 1);
  assert.equal(calls.clock, 2);
});

for (const [name, grant] of [
  ["actor", matchingBreakGlass({ actorId: "admin-2" })],
  ["resource", matchingBreakGlass({ resourceId: "agent-2" })],
  ["action", matchingBreakGlass({ action: "agent:test" })],
  ["activation flag", matchingBreakGlass({ active: false })],
  ["future activation", matchingBreakGlass({
    activatedAt: "2026-08-25T00:00:00.001Z",
  })],
  ["expiry", matchingBreakGlass({
    expiresAt: "2026-08-25T00:00:00.000Z",
  })],
]) {
  test(`break-glass rejects a non-matching or inactive ${name}`, async () => {
    const { authorize } = makeHarness({
      principal: adminPrincipal(),
      breakGlass: grant,
    });

    await expectDecision(
      () => authorize(request("agent:update")),
      "FORBIDDEN",
      "BREAK_GLASS_REQUIRED",
    );
  });
}

test("caller time cannot extend a grant evaluated by the server clock", async () => {
  const { authorize } = makeHarness({
    principal: adminPrincipal(),
    breakGlass: matchingBreakGlass({
      expiresAt: "2026-08-25T00:00:00.001Z",
    }),
    clock: () => Date.parse("2026-08-25T00:00:00.002Z"),
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "BREAK_GLASS_REQUIRED",
  );
});

test("break-glass never bypasses authoritative policy", async () => {
  const { authorize } = makeHarness({
    principal: adminPrincipal(),
    breakGlass: matchingBreakGlass(),
    policy: { allowed: false },
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "POLICY",
  );
});

test("break-glass never bypasses lifecycle constraints", async () => {
  const { authorize } = makeHarness({
    principal: adminPrincipal(),
    resource: agentResource({ lifecycleState: "ACTIVE" }),
    breakGlass: matchingBreakGlass(),
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "CONFLICT",
    "LIFECYCLE",
  );
});

test("protected trace content requires break-glass for Platform Admin", async () => {
  const denied = makeHarness({
    principal: adminPrincipal(),
    resource: agentResource({ lifecycleState: "ACTIVE" }),
  });
  await expectDecision(
    () => denied.authorize(request("trace:read-content")),
    "FORBIDDEN",
    "BREAK_GLASS_REQUIRED",
  );

  const allowed = makeHarness({
    principal: adminPrincipal(),
    resource: agentResource({ lifecycleState: "ACTIVE" }),
    breakGlass: matchingBreakGlass({
      action: "trace:read-content",
    }),
  });
  assert.equal(
    (await allowed.authorize(request("trace:read-content"))).usedBreakGlass,
    true,
  );
});

test("Domain Lead may read trace content inside the owned domain without break-glass", async () => {
  const { authorize, calls } = makeHarness({
    principal: leadPrincipal(),
    resource: agentResource({
      ownerId: "builder-2",
      lifecycleState: "ACTIVE",
    }),
  });

  assert.equal(
    (await authorize(request("trace:read-content"))).decision,
    "ALLOW",
  );
  assert.equal(calls.breakGlass.length, 0);
});

test("Domain Builder may read owned trace content but not another builder trace", async () => {
  const owned = makeHarness({
    resource: agentResource({ lifecycleState: "ACTIVE" }),
  });
  assert.equal(
    (await owned.authorize(request("trace:read-content"))).decision,
    "ALLOW",
  );

  const foreign = makeHarness({
    resource: agentResource({
      ownerId: "builder-2",
      lifecycleState: "ACTIVE",
    }),
  });
  await expectDecision(
    () => foreign.authorize(request("trace:read-content")),
    "NOT_FOUND",
    "OWNER_SCOPE",
  );
});

test("governance action contracts expose the approved domain workflow", () => {
  assert.deepEqual(
    Object.fromEntries([
      "resource:draft-register",
      "resource:publication-submit",
      "resource:publication-approve",
      "shared-resource:discover",
      "resource:access-request",
      "resource:access-decide",
      "resource:access-revoke",
    ].map((action) => [
      action,
      authorization.ACTION_CONTRACTS[action],
    ])),
    {
      "resource:draft-register": {
        capability: "registerDomainResourceDraft",
        capabilitiesByRole: null,
        operation: "domain-content-mutation",
        domainScope: true,
        projectScope: false,
        ownerRoles: [],
        entitlement: false,
        approval: false,
        protectedTrace: false,
        allowedStates: ["ACTIVE"],
      },
      "resource:publication-submit": {
        capability: "submitDomainResourcePublication",
        capabilitiesByRole: null,
        operation: "domain-content-mutation",
        domainScope: true,
        projectScope: false,
        ownerRoles: ["builder"],
        entitlement: false,
        approval: false,
        protectedTrace: false,
        allowedStates: ["DRAFT", "REJECTED"],
      },
      "resource:publication-approve": {
        capability: null,
        capabilitiesByRole: {
          admin: "approvePlatformPublication",
          lead: "approveDomainPublication",
        },
        operation: "domain-approval",
        domainScope: true,
        projectScope: false,
        adminPlatformOnly: true,
        ownerRoles: [],
        entitlement: false,
        approval: true,
        protectedTrace: false,
        allowedStates: ["PENDING_APPROVAL", "APPROVED", "REJECTED"],
      },
      "shared-resource:discover": {
        capability: "discoverSharedResources",
        capabilitiesByRole: null,
        operation: "read",
        domainScope: false,
        projectScope: false,
        ownerRoles: [],
        entitlement: false,
        approval: false,
        protectedTrace: false,
        allowedStates: ["APPROVED"],
      },
      "resource:access-request": {
        capability: "requestSharedResourceAccess",
        capabilitiesByRole: null,
        operation: "domain-content-mutation",
        domainScope: true,
        projectScope: false,
        ownerRoles: [],
        entitlement: false,
        approval: false,
        protectedTrace: false,
        allowedStates: ["APPROVED"],
      },
      "resource:access-decide": {
        capability: "decideDomainResourceAccess",
        capabilitiesByRole: null,
        operation: "domain-approval",
        domainScope: true,
        projectScope: false,
        ownerRoles: [],
        entitlement: false,
        approval: true,
        protectedTrace: false,
        allowedStates: ["PENDING_APPROVAL"],
      },
      "resource:access-revoke": {
        capability: "decideDomainResourceAccess",
        capabilitiesByRole: null,
        operation: "domain-approval",
        domainScope: true,
        projectScope: false,
        ownerRoles: [],
        entitlement: false,
        approval: false,
        protectedTrace: false,
        allowedStates: ["ACTIVE"],
      },
    },
  );
});

test("agent access requests and entitlement decisions use distinct persona capabilities", () => {
  assert.deepEqual(
    authorization.ACTION_CONTRACTS["agent:access-request"],
    {
      capability: "requestAgentAccess",
      capabilitiesByRole: null,
      operation: "user-request",
      domainScope: false,
      projectScope: false,
      ownerRoles: [],
      entitlement: false,
      approval: false,
      protectedTrace: false,
      allowedStates: ["ACTIVE"],
    },
  );
  assert.deepEqual(
    authorization.ACTION_CONTRACTS["agent:entitlement-decide"],
    {
      capability: "manageDomainEntitlements",
      capabilitiesByRole: null,
      operation: "domain-approval",
      domainScope: true,
      projectScope: false,
      ownerRoles: [],
      entitlement: false,
      approval: true,
      protectedTrace: false,
      allowedStates: ["PENDING_APPROVAL"],
    },
  );
  for (const [action, state] of [
    ["agent:entitlement-grant", "PRODUCTION_DEPLOYED"],
    ["agent:entitlement-revoke", "ACTIVE"],
  ]) {
    assert.deepEqual(
      authorization.ACTION_CONTRACTS[action],
      {
        capability: null,
        capabilitiesByRole: {
          admin: "managePlatformPolicy",
          lead: "manageDomainEntitlements",
        },
        operation: "domain-approval",
        domainScope: true,
        projectScope: false,
        ownerRoles: [],
        entitlement: false,
        approval: false,
        protectedTrace: false,
        allowedStates: [state],
      },
    );
  }
});

test("builders may register and submit owned resources but cannot approve them", async () => {
  const draft = makeHarness({
    resource: governedResource({
      lifecycleState: "ACTIVE",
    }),
  });
  assert.equal(
    (await draft.authorize(request("resource:draft-register"))).decision,
    "ALLOW",
  );

  const submit = makeHarness({
    resource: governedResource({
      ownerId: "builder-1",
      assigneeIds: [],
      lifecycleState: "DRAFT",
    }),
  });
  assert.equal(
    (await submit.authorize(request("resource:publication-submit"))).decision,
    "ALLOW",
  );

  const decide = makeHarness({
    resource: governedResource({
      lifecycleState: "PENDING_APPROVAL",
    }),
    approval: approvalRecord({
      action: "resource:publication-approve",
    }),
  });
  await expectDecision(
    () => decide.authorize(request("resource:publication-approve", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "CAPABILITY",
  );
});

test("lead approval is domain-scoped and requester-not-approver", async () => {
  const permitted = makeHarness({
    principal: leadPrincipal(),
    resource: governedResource({
      lifecycleState: "PENDING_APPROVAL",
    }),
    approval: approvalRecord({
      requesterId: "builder-1",
      resourceId: "resource-1",
      action: "resource:publication-approve",
    }),
  });
  assert.equal(
    (await permitted.authorize(request("resource:publication-approve", {
      approvalRef: "approval-ref-1",
    }))).decision,
    "ALLOW",
  );

  const selfApproval = makeHarness({
    principal: leadPrincipal(),
    resource: governedResource({
      lifecycleState: "PENDING_APPROVAL",
    }),
    approval: approvalRecord({
      requesterId: "lead-1",
      resourceId: "resource-1",
      action: "resource:publication-approve",
    }),
  });
  await expectDecision(
    () => selfApproval.authorize(request("resource:publication-approve", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "REQUESTER_IS_APPROVER",
  );
});

test("peer Admin approves platform work but never foreign-domain work", async () => {
  for (const [action, resourceId] of [
    ["deployment:approve", "agent-1"],
    ["resource:publication-approve", "resource-1"],
  ]) {
    const resource = action === "deployment:approve"
      ? agentResource({
          domainId: "platform",
          projectId: "platform-project",
          lifecycleState: "PENDING_APPROVAL",
        })
      : governedResource({
          domainId: "platform",
          lifecycleState: "PENDING_APPROVAL",
        });
    const approval = approvalRecord({
      requesterId: "requester-admin-sub",
      resourceId,
      action,
    });
    const peerAdmin = makeHarness({
      principal: adminPrincipal({ id: "peer-admin-sub" }),
      resource,
      approval,
    });
    assert.equal(
      (await peerAdmin.authorize(request(action, {
        approvalRef: "approval-ref-1",
      }))).decision,
      "ALLOW",
      action,
    );
    assert.equal(peerAdmin.calls.breakGlass.length, 0, action);

    const selfApproval = makeHarness({
      principal: adminPrincipal({ id: "requester-admin-sub" }),
      resource,
      approval,
    });
    await expectDecision(
      () => selfApproval.authorize(request(action, {
        approvalRef: "approval-ref-1",
      })),
      "FORBIDDEN",
      "REQUESTER_IS_APPROVER",
    );

    const foreignResource = {
      ...resource,
      domainId: "customer_support",
      projectId: resource.projectId ?? "case-assist",
    };
    const foreignAdmin = makeHarness({
      principal: adminPrincipal({ id: "peer-admin-sub" }),
      resource: foreignResource,
      approval,
      breakGlass: matchingBreakGlass({
        actorId: "peer-admin-sub",
        resourceId,
        action,
      }),
    });
    await expectDecision(
      () => foreignAdmin.authorize(request(action, {
        approvalRef: "approval-ref-1",
      })),
      "FORBIDDEN",
      "PLATFORM_APPROVAL_SCOPE",
    );
    assert.equal(foreignAdmin.calls.breakGlass.length, 0, action);
  }
});

test("Domain Lead retains selected-domain deployment and publication approval", async () => {
  for (const [action, resource] of [
    [
      "deployment:approve",
      agentResource({ lifecycleState: "PENDING_APPROVAL" }),
    ],
    [
      "resource:publication-approve",
      governedResource({ lifecycleState: "PENDING_APPROVAL" }),
    ],
  ]) {
    const { authorize, calls } = makeHarness({
      principal: leadPrincipal(),
      resource,
      approval: approvalRecord({
        requesterId: "builder-1",
        resourceId: resource.id,
        action,
      }),
    });
    assert.equal(
      (await authorize(request(action, {
        approvalRef: "approval-ref-1",
      }))).decision,
      "ALLOW",
      action,
    );
    assert.equal(calls.breakGlass.length, 0, action);
  }
});

test("Domain Lead cannot approve platform deployment or publication work", async () => {
  for (const [action, resource] of [
    [
      "deployment:approve",
      agentResource({
        domainId: "platform",
        projectId: "platform-project",
        lifecycleState: "PENDING_APPROVAL",
      }),
    ],
    [
      "resource:publication-approve",
      governedResource({
        domainId: "platform",
        lifecycleState: "PENDING_APPROVAL",
      }),
    ],
  ]) {
    const { authorize } = makeHarness({
      principal: leadPrincipal({
        domainIds: ["platform"],
        projectIds: ["platform-project"],
      }),
      resource,
      approval: approvalRecord({
        requesterId: "builder-1",
        resourceId: resource.id,
        action,
      }),
    });
    await expectDecision(
      () => authorize(request(action, {
        approvalRef: "approval-ref-1",
      })),
      "FORBIDDEN",
      "PLATFORM_APPROVAL_SCOPE",
    );
  }
});

test("shared discovery does not grant use and access decisions remain lead-only", async () => {
  const discover = makeHarness({
    resource: governedResource({
      domainId: "another_domain",
      lifecycleState: "APPROVED",
    }),
  });
  assert.equal(
    (await discover.authorize(request("shared-resource:discover"))).decision,
    "ALLOW",
  );

  const accessRequest = makeHarness({
    resource: governedResource({
      lifecycleState: "APPROVED",
    }),
  });
  assert.equal(
    (await accessRequest.authorize(request("resource:access-request"))).decision,
    "ALLOW",
  );

  const builderDecision = makeHarness({
    resource: governedResource({
      lifecycleState: "PENDING_APPROVAL",
    }),
    approval: approvalRecord({
      action: "resource:access-decide",
    }),
  });
  await expectDecision(
    () => builderDecision.authorize(request("resource:access-decide", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "CAPABILITY",
  );
});

test("platform admin sees governance metadata but cannot routinely approve domain work", async () => {
  const adminApproval = makeHarness({
    principal: adminPrincipal(),
    resource: governedResource({
      lifecycleState: "PENDING_APPROVAL",
    }),
    approval: approvalRecord({
      action: "resource:publication-approve",
    }),
  });
  await expectDecision(
    () => adminApproval.authorize(request("resource:publication-approve", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "PLATFORM_APPROVAL_SCOPE",
  );
});

for (const [name, options, action, reason] of [
  [
    "principal",
    { principal: { id: "actor", role: "root", domainIds: [], projectIds: [] } },
    "agent:update",
    "PRINCIPAL_INVALID",
  ],
  [
    "resource",
    { resource: [] },
    "agent:update",
    "RESOURCE_INVALID",
  ],
  [
    "policy",
    { policy: { allowed: "yes" } },
    "agent:update",
    "POLICY_INVALID",
  ],
  [
    "entitlement",
    {
      principal: userPrincipal(),
      resource: agentResource({ lifecycleState: "ACTIVE" }),
      entitlement: {},
    },
    "agent:invoke",
    "ENTITLEMENT_INVALID",
  ],
  [
    "approval",
    {
      principal: leadPrincipal(),
      resource: agentResource({ lifecycleState: "PENDING_APPROVAL" }),
      approval: {},
    },
    "deployment:approve",
    "APPROVAL_INVALID",
  ],
  [
    "break-glass",
    {
      principal: adminPrincipal(),
      breakGlass: { active: true },
    },
    "agent:update",
    "BREAK_GLASS_INVALID",
  ],
]) {
  test(`malformed authoritative ${name} resolver output fails closed`, async () => {
    const { authorize } = makeHarness(options);
    const approvalRef = action === "deployment:approve"
      ? "approval-ref-1"
      : undefined;

    await expectDecision(
      () => authorize(request(action, { approvalRef })),
      "FORBIDDEN",
      reason,
    );
  });
}

test("a missing authoritative resource is non-disclosing", async () => {
  const { authorize } = makeHarness({ resource: null });

  await expectDecision(
    () => authorize(request("agent:update")),
    "NOT_FOUND",
    "RESOURCE_MISSING",
  );
});

test("resolver exceptions fail closed without leaking their message", async () => {
  const { authorize } = makeHarness({
    policy: () => {
      throw new Error("sensitive policy service detail");
    },
  });

  const error = await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "POLICY_RESOLVER_FAILED",
  );
  assert.doesNotMatch(JSON.stringify(error), /sensitive/i);
});

test("authoritative resolver accessors fail closed without leaking their message", async () => {
  const resource = agentResource();
  Object.defineProperty(resource, "id", {
    get() {
      throw new Error("sensitive resource getter detail");
    },
    enumerable: true,
  });
  const { authorize } = makeHarness({ resource });

  const error = await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "RESOURCE_INVALID",
  );
  assert.doesNotMatch(JSON.stringify(error), /getter detail/i);
});

test("stateful authoritative accessors cannot change a validated policy decision", async () => {
  let getterCalls = 0;
  const policy = {};
  Object.defineProperty(policy, "allowed", {
    get() {
      getterCalls += 1;
      return getterCalls > 1;
    },
    enumerable: true,
  });
  const { authorize } = makeHarness({ policy });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "POLICY_INVALID",
  );
  assert.equal(getterCalls, 0);
});

test("prototype pollution cannot fabricate an authoritative administrator", async () => {
  const polluted = {
    id: "admin-1",
    role: "admin",
    domainIds: [],
    projectIds: [],
  };
  const descriptors = Object.fromEntries(
    Object.entries(polluted).map(([key, value]) => [
      key,
      {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
      },
    ]),
  );
  Object.defineProperties(Object.prototype, descriptors);

  try {
    const { authorize, calls } = makeHarness({
      principal: {},
      resource: agentResource({ lifecycleState: "ACTIVE" }),
    });

    await expectDecision(
      () => authorize(request("platform-policy:update")),
      "FORBIDDEN",
      "PRINCIPAL_INVALID",
    );
    assert.equal(calls.policy.length, 0);
  } finally {
    for (const key of Object.keys(polluted)) delete Object.prototype[key];
  }
});

test("break-glass is rechecked after asynchronous policy evaluation", async () => {
  const clockValues = [
    NOW,
    Date.parse("2026-08-25T00:00:00.010Z"),
  ];
  const { authorize, calls } = makeHarness({
    principal: adminPrincipal(),
    breakGlass: matchingBreakGlass({
      expiresAt: "2026-08-25T00:00:00.005Z",
    }),
    policy: async () => {
      await Promise.resolve();
      return { allowed: true };
    },
    clock: () => clockValues.shift(),
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "BREAK_GLASS_REQUIRED",
  );
  assert.equal(calls.clock, 2);
});

test("malformed server clock fails closed when break-glass is evaluated", async () => {
  const { authorize } = makeHarness({
    principal: adminPrincipal(),
    breakGlass: matchingBreakGlass(),
    clock: () => Number.NaN,
  });

  await expectDecision(
    () => authorize(request("agent:update")),
    "FORBIDDEN",
    "CLOCK_INVALID",
  );
});

// The shared catalog is platform-curated: its publication reviews are ordinary
// platform-admin work. Pin that an admin can approve a shared-domain
// publication without break-glass, that leads stay excluded from it, and that
// other business domains still demand break-glass from admins.
test("shared-catalog publication approval is platform-admin work without break-glass", async () => {
  const shared = makeHarness({
    principal: adminPrincipal(),
    resource: agentResource({
      id: "SharedReg1234/Rec123456789",
      domainId: "shared",
      projectId: "shared-catalog",
      ownerId: "platform-bootstrap",
      lifecycleState: "PENDING_APPROVAL",
    }),
    approval: approvalRecord({
      requesterId: "admin-2",
      resourceId: "SharedReg1234/Rec123456789",
      action: "resource:publication-approve",
    }),
  });
  const allowed = await shared.authorize(request("resource:publication-approve", {
    approvalRef: "approval-ref-1",
  }));
  assert.equal(allowed.decision, "ALLOW");
  assert.equal(shared.calls.breakGlass.length, 0);

  const leadDenied = makeHarness({
    principal: leadPrincipal({ domainIds: ["shared"] }),
    resource: agentResource({
      id: "SharedReg1234/Rec123456789",
      domainId: "shared",
      projectId: "shared-catalog",
      ownerId: "platform-bootstrap",
      lifecycleState: "PENDING_APPROVAL",
    }),
    approval: approvalRecord({
      requesterId: "admin-2",
      resourceId: "SharedReg1234/Rec123456789",
      action: "resource:publication-approve",
    }),
  });
  await expectDecision(
    () => leadDenied.authorize(request("resource:publication-approve", {
      approvalRef: "approval-ref-1",
    })),
    "FORBIDDEN",
    "PLATFORM_APPROVAL_SCOPE",
  );
});
