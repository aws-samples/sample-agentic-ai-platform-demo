import assert from "node:assert/strict";
import test from "node:test";
import * as deploymentRuntime
  from "../lambda/deployment/runtime.mjs";

const NOW = "2026-08-25T08:00:00.000Z";

function activeBreakGlass(overrides = {}) {
  return {
    id: "admin-deployment-grant",
    domainId: "customer_support",
    projectId: "case-assist",
    resource: "agent:customer_support/case-assist/triage-agent",
    action: "agent:sandbox-deploy",
    status: "ACTIVE",
    requesterSubject: "operator-sub",
    reason: "Restore a domain sandbox during an incident.",
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
  deployments = [],
} = {}) {
  return {
    async getProject() {
      return {
        domainId: "customer_support",
        id: "case-assist",
        ownerSubject: "lead-sub",
        memberSubjects: ["operator-sub"],
        status: "ACTIVE",
      };
    },
    async getAgent() {
      return {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "triage-agent",
        ownerSubject: "builder-sub",
        status: "TESTED",
      };
    },
    async getDeployment({ domainId, projectId, deploymentId }) {
      return deployments.find(
        (deployment) =>
          deployment.domainId === domainId
          && deployment.projectId === projectId
          && deployment.id === deploymentId,
      ) ?? null;
    },
    async getApproval({ domainId, approvalId }) {
      return approvals.find(
        (approval) =>
          approval.domainId === domainId
          && approval.id === approvalId,
      ) ?? null;
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
  };
}

function runtimeDependencies() {
  return {
    clock: () => new Date(NOW),
    domainDirectory: {
      async listActiveDomains() {
        return [{ id: "customer_support" }];
      },
    },
    identityVerifier: async () => true,
    modelPolicyState: {
      async getModelPolicy() {
        return null;
      },
    },
    runtimeControl: {
      async resolveEndpoint() {
        throw new Error("not used");
      },
    },
    workspaceState: {
      ...state(),
      beginTransaction() {
        return {
          timestamp: NOW,
          epochSeconds: Math.floor(Date.parse(NOW) / 1000),
        };
      },
      async getResourceGrant() {
        return null;
      },
      async putAgent() {
        throw new Error("not used");
      },
      async putDeployment() {
        throw new Error("not used");
      },
      async putApproval() {
        throw new Error("not used");
      },
    },
  };
}

test("deployment runtime requires authoritative model policy dependencies", () => {
  const dependencies = runtimeDependencies();
  assert.equal(
    typeof deploymentRuntime.createDeploymentRuntime(dependencies),
    "function",
  );
  const { modelPolicyState, ...withoutModelPolicyState } = dependencies;
  assert.ok(modelPolicyState);
  assert.throws(
    () => deploymentRuntime.createDeploymentRuntime(
      withoutModelPolicyState,
    ),
    /Deployment runtime configuration is invalid/,
  );
});

test("deployment authorizer resolves a project-bound Platform Admin break-glass grant", async () => {
  assert.equal(
    typeof deploymentRuntime.createDeploymentAuthorizer,
    "function",
  );
  const breakGlassCalls = [];
  const authorize = deploymentRuntime.createDeploymentAuthorizer({
    workspaceState: state({
      breakGlassRecords: [activeBreakGlass()],
      breakGlassCalls,
    }),
    clock: () => new Date(NOW),
  });

  const result = await authorize({
    requestContext: {
      source: "deployment-service",
      subject: "operator-sub",
      role: "admin",
      activeDomain: "customer_support",
      domainIds: ["customer_support"],
    },
    action: "agent:sandbox-deploy",
    resourceRef: "agent:customer_support/case-assist/triage-agent",
  });

  assert.equal(result.ok, true);
  assert.equal(result.usedBreakGlass, true);
  assert.equal(
    result.resourceId,
    "agent:customer_support/case-assist/triage-agent",
  );
  assert.deepEqual(breakGlassCalls, ["operator-sub"]);
});

test("break-glass does not make Platform Admin a production deployment approver", async () => {
  const breakGlassCalls = [];
  const authorize = deploymentRuntime.createDeploymentAuthorizer({
    workspaceState: state({
      approvals: [{
        domainId: "customer_support",
        id: "triage-production-approval",
        kind: "PRODUCTION_DEPLOYMENT",
        resourceType: "DEPLOYMENT",
        resourceId: "triage-production",
        requesterSubject: "builder-sub",
        status: "PENDING",
      }],
      breakGlassRecords: [activeBreakGlass({
        resource: "triage-production",
        action: "deployment:approve",
      })],
      breakGlassCalls,
      deployments: [{
        domainId: "customer_support",
        projectId: "case-assist",
        id: "triage-production",
        requesterSubject: "builder-sub",
        status: "REQUESTED",
      }],
    }),
    clock: () => new Date(NOW),
  });

  await assert.rejects(
    authorize({
      requestContext: {
        source: "deployment-service",
        subject: "operator-sub",
        role: "admin",
        activeDomain: "customer_support",
        domainIds: ["customer_support"],
      },
      action: "deployment:approve",
      resourceRef:
        "deployment:customer_support/case-assist/triage-production",
      approvalRef:
        "approval:customer_support/triage-production-approval",
    }),
    (error) =>
      error?.decision === "FORBIDDEN"
      && error?.reason === "PLATFORM_APPROVAL_SCOPE",
  );
  assert.deepEqual(breakGlassCalls, []);
});

test("settled deployment approval authorization is limited to the recorded approver", async () => {
  const approvalRecord = {
    domainId: "customer_support",
    id: "triage-production-approval",
    kind: "PRODUCTION_DEPLOYMENT",
    resourceType: "DEPLOYMENT",
    resourceId: "triage-production",
    requesterSubject: "builder-sub",
    approverSubject: "operator-sub",
    status: "APPROVED",
  };
  const deployments = [{
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-production",
    requesterSubject: "builder-sub",
    status: "DEPLOYED",
  }];
  const authorize = deploymentRuntime.createDeploymentAuthorizer({
    workspaceState: state({
      approvals: [approvalRecord],
      deployments,
    }),
    clock: () => new Date(NOW),
  });
  const request = {
    requestContext: {
      source: "deployment-service",
      subject: "operator-sub",
      role: "lead",
      activeDomain: "customer_support",
      domainIds: ["customer_support"],
    },
    action: "deployment:approve",
    resourceRef:
      "deployment:customer_support/case-assist/triage-production",
    approvalRef:
      "approval:customer_support/triage-production-approval",
  };

  assert.equal((await authorize(request)).decision, "ALLOW");
  approvalRecord.approverSubject = "another-lead-sub";
  await assert.rejects(
    authorize(request),
    (error) =>
      error?.decision === "FORBIDDEN"
      && error?.reason === "APPROVAL_RESOLVER_FAILED",
  );
});
