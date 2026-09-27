import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionIdentityProjector,
  createWorkspaceInventoryAuthorizer,
} from "../lambda/workspace/runtime.mjs";
import { createWorkspaceHandler } from "../lambda/workspace/index.mjs";
import { createWorkspaceService } from "../lambda/workspace/service.mjs";

const claims = Object.freeze({
  sub: "production-admin-sub",
  token_use: "access",
  "cognito:username": "production-admin",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

function event() {
  return {
    version: "2.0",
    requestContext: {
      http: { method: "GET", path: "/api/projects" },
      requestId: "production-runtime-request",
      authorizer: { jwt: { claims } },
    },
  };
}

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support workspace.",
    ownerSubject: "builder-sub",
    memberSubjects: ["assigned-builder-sub"],
    status: "ACTIVE",
    createdBySubject: "lead-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

function stateWithProject() {
  return {
    async listProjects() {
      return { items: [project()], cursor: null };
    },
    async listAgents() {
      return { items: [], cursor: null };
    },
    async listDeployments() {
      return { items: [], cursor: null };
    },
    async listApprovals() {
      return { items: [], cursor: null };
    },
  };
}

function itemAuthorizationRef(route, lifecycleState) {
  const descriptor = Buffer.from(JSON.stringify({
    v: 1,
    route,
    id: `${route}-item`,
    domainId: "customer_support",
    projectId: "case-assist",
    ownerId: claims.sub,
    assigneeIds: [],
    lifecycleState,
  })).toString("base64url");
  return `workspace-item:${route}:${descriptor}`;
}

test("production identity projector adapts projectIdentity without losing Cognito sub", async () => {
  const handler = createWorkspaceHandler({
    identityProjector: createProductionIdentityProjector(),
    identityVerifier: async () => true,
    domainDirectory: {
      async listActiveDomains() {
        return [{ id: "customer_support" }];
      },
    },
    workspaceState: stateWithProject(),
    authorizer: async ({ requestContext }) => {
      assert.equal(requestContext.subject, claims.sub);
      return { ok: true };
    },
  });

  const response = await handler(event());

  assert.equal(response.statusCode, 200);
  assert.notEqual(
    JSON.parse(response.body).code,
    "IDENTITY_UNAVAILABLE",
  );
});

test("production workspace authorizer resolves actual item metadata and policy", async () => {
  const service = createWorkspaceService({
    workspaceState: stateWithProject(),
    authorizer: createWorkspaceInventoryAuthorizer(),
  });

  const result = await service.listProjects({
    identity: {
      actor: "assigned-builder-sub",
      role: "builder",
      activeDomain: "customer_support",
      domainIds: ["customer_support"],
    },
    limit: 10,
  });

  assert.deepEqual(result.items, [project()]);
});

test("production workspace authorizer permits every collection preflight without broadening item states", async () => {
  const service = createWorkspaceService({
    workspaceState: stateWithProject(),
    authorizer: createWorkspaceInventoryAuthorizer(),
  });
  const identity = {
    actor: "production-admin-sub",
    role: "admin",
    activeDomain: null,
    domainIds: ["customer_support"],
  };

  for (const method of [
    "listProjects",
    "listAgents",
    "listDeployments",
    "listApprovals",
  ]) {
    const result = await service[method]({ identity, limit: 10 });
    assert.ok(Array.isArray(result.items), method);
  }
});

test("production workspace authorizer preserves actual item lifecycle states", async () => {
  const authorizer = createWorkspaceInventoryAuthorizer();
  const requestContext = {
    source: "workspace-api",
    subject: claims.sub,
    role: "admin",
    activeDomain: null,
    domainIds: ["customer_support"],
  };
  const cases = [
    ["workspace.projects.read", "projects", "DELETED"],
    ["workspace.agents.read", "agents", "DELETED"],
    ["workspace.deployments.read", "deployments", "DRAFT"],
    ["workspace.approvals.read", "approvals", "ACTIVE"],
  ];

  for (const [action, route, lifecycleState] of cases) {
    await assert.rejects(
      authorizer({
        requestContext,
        action,
        resourceRef: itemAuthorizationRef(route, lifecycleState),
      }),
      (error) => (
        error?.decision === "CONFLICT"
        && error?.reason === "LIFECYCLE"
      ),
      action,
    );
  }
});

test("production workspace authorizer rejects context accessors without executing them", async () => {
  let getterCalls = 0;
  const requestContext = {
    source: "workspace-api",
    subject: "builder-sub",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  };
  Object.defineProperty(requestContext, "role", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("caller-controlled role getter");
    },
  });
  const descriptor = Buffer.from(JSON.stringify({
    v: 1,
    route: "projects",
    subject: "builder-sub",
    role: "builder",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  })).toString("base64url");
  const authorizer = createWorkspaceInventoryAuthorizer();

  await assert.rejects(
    authorizer({
      requestContext,
      action: "workspace.projects.read",
      resourceRef: `workspace-collection:projects:${descriptor}`,
    }),
    (error) => error?.decision === "FORBIDDEN",
  );
  assert.equal(getterCalls, 0);
});
