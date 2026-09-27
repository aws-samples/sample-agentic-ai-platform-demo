import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeploymentService,
  DeploymentServiceError,
} from "../lambda/deployment/service.mjs";
import {
  createDeploymentAuthorizer,
} from "../lambda/deployment/runtime.mjs";

const START = Date.parse("2026-08-25T04:00:00.000Z");

function identity(role = "builder", actor = "builder-sub") {
  return {
    actor,
    role,
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  };
}

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "",
    ownerSubject: "builder-sub",
    memberSubjects: ["builder-sub", "lead-sub"],
    status: "ACTIVE",
    createdBySubject: "builder-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    updatedAt: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

function agent(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "",
    ownerSubject: "builder-sub",
    modelId: "anthropic.claude",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: [],
    memoryIds: [],
    knowledgeBaseIds: [],
    status: "TESTED",
    createdBySubject: "builder-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    updatedAt: "2026-08-25T02:00:00.000Z",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: "2026-08-25T02:00:00.000Z",
    lastTestedBySubject: "builder-sub",
    lastTestModelId: "anthropic.claude",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Test response.",
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-production",
    agentId: "triage-agent",
    environment: "PRODUCTION",
    status: "REQUESTED",
    requesterSubject: "builder-sub",
    approverSubject: null,
    decisionReason: null,
    requestedAt: "2026-08-25T03:00:00.000Z",
    decidedAt: null,
    runtimeId: null,
    runtimeArn: null,
    runtimeStatus: null,
    endpointName: null,
    endpointArn: null,
    runtimeVersion: null,
    updatedAt: "2026-08-25T03:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "triage-production-approval",
    kind: "PRODUCTION_DEPLOYMENT",
    resourceType: "DEPLOYMENT",
    resourceId: "triage-production",
    projectId: "case-assist",
    status: "PENDING",
    requesterSubject: "builder-sub",
    approverSubject: null,
    reason: null,
    requestedAt: "2026-08-25T03:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

function runtimeIdentity(environment) {
  const endpointName = environment === "SANDBOX"
    ? "Sandbox"
    : "Production";
  return {
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    runtimeArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567",
    runtimeStatus: "READY",
    endpointName,
    endpointArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + `runtime-endpoint/${endpointName}`,
    runtimeVersion: "1",
  };
}

function memoryState({
  currentAgent = agent(),
  currentDeployment = null,
  currentApproval = null,
} = {}) {
  let sequence = 0;
  const records = {
    project: project(),
    agent: currentAgent,
    deployment: currentDeployment,
    approval: currentApproval,
  };
  const writes = [];
  return {
    records,
    writes,
    beginTransaction() {
      const timestamp = new Date(START + sequence * 1000).toISOString();
      sequence += 1;
      return {
        timestamp,
        epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
      };
    },
    async getProject() {
      return records.project;
    },
    async getAgent() {
      return records.agent;
    },
    async getDeployment() {
      return records.deployment;
    },
    async getApproval() {
      return records.approval;
    },
    async listBreakGlass() {
      return { items: [], cursor: null };
    },
    async putAgent(input) {
      writes.push(["agent", input]);
      records.agent = input.record;
      return records.agent;
    },
    async putDeployment(input) {
      writes.push(["deployment", input]);
      records.deployment = input.record;
      return records.deployment;
    },
    async putApproval(input) {
      writes.push(["approval", input]);
      records.approval = input.record;
      return records.approval;
    },
  };
}

function serviceWith({
  state = memoryState(),
  runtimeControl = {
    async resolveEndpoint(environment) {
      return runtimeIdentity(environment);
    },
  },
  modelAccessResolver = async () => true,
  authorizeCalls = [],
} = {}) {
  return {
    state,
    service: createDeploymentService({
      workspaceState: state,
      async authorizer(input) {
        authorizeCalls.push(input);
        return true;
      },
      runtimeControl,
      modelAccessResolver,
    }),
    authorizeCalls,
  };
}

function serviceWithProductionAuthorizer({
  state = memoryState(),
  runtimeControl = {
    async resolveEndpoint(environment) {
      return runtimeIdentity(environment);
    },
  },
  modelAccessResolver = async () => true,
} = {}) {
  return {
    state,
    service: createDeploymentService({
      workspaceState: state,
      authorizer: createDeploymentAuthorizer({
        workspaceState: state,
        clock: () => new Date(START),
      }),
      runtimeControl,
      modelAccessResolver,
    }),
  };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof DeploymentServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

test("deployment service requires complete state, authorization, and Runtime adapters", () => {
  assert.throws(
    () => createDeploymentService(),
    /configuration is invalid/i,
  );
  const state = memoryState();
  assert.throws(
    () => createDeploymentService({
      workspaceState: state,
      async authorizer() {
        return true;
      },
      runtimeControl: {
        async resolveEndpoint(environment) {
          return runtimeIdentity(environment);
        },
      },
    }),
    /configuration is invalid/i,
  );
});

test("revoked model access blocks sandbox deployment before authorization or mutation", async () => {
  const authorizeCalls = [];
  let runtimeCalls = 0;
  const { service, state } = serviceWith({
    authorizeCalls,
    modelAccessResolver: async ({ domainId, modelId }) => {
      assert.equal(domainId, "customer_support");
      assert.equal(modelId, "anthropic.claude");
      return false;
    },
    runtimeControl: {
      async resolveEndpoint() {
        runtimeCalls += 1;
        return runtimeIdentity("SANDBOX");
      },
    },
  });

  await assert.rejects(
    service.deploySandbox({
      identity: identity(),
      requestId: "sandbox-model-revoked",
      deploymentId: "triage-sandbox",
      agentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(authorizeCalls.length, 0);
  assert.equal(runtimeCalls, 0);
  assert.equal(state.writes.length, 0);
});

test("revoked model access blocks production submission before mutation", async () => {
  const authorizeCalls = [];
  const { service, state } = serviceWith({
    authorizeCalls,
    modelAccessResolver: async () => false,
  });

  await assert.rejects(
    service.submitProduction({
      identity: identity(),
      requestId: "production-model-revoked",
      deploymentId: "triage-production",
      approvalId: "triage-production-approval",
      agentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(authorizeCalls.length, 0);
  assert.equal(state.writes.length, 0);
});

test("production approval rechecks model access before any approval mutation", async () => {
  const state = memoryState({
    currentAgent: agent({ status: "PRODUCTION_PENDING" }),
    currentDeployment: deployment(),
    currentApproval: approval(),
  });
  const { service, authorizeCalls } = serviceWith({
    state,
    modelAccessResolver: async () => false,
  });

  await assert.rejects(
    service.decideProduction({
      identity: identity("lead", "lead-sub"),
      requestId: "approval-model-revoked",
      deploymentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        deploymentId: "triage-production",
      },
      approvalId: "triage-production-approval",
      decision: "APPROVE",
      reason: "Approved after domain review.",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(authorizeCalls.length, 1);
  assert.equal(state.writes.length, 0);
});

test("model access dependency failures fail closed as workspace unavailable", async () => {
  const { service, state } = serviceWith({
    modelAccessResolver: async () => {
      throw new Error("policy store unavailable");
    },
  });

  await assert.rejects(
    service.deploySandbox({
      identity: identity(),
      requestId: "sandbox-model-unavailable",
      deploymentId: "triage-sandbox",
      agentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
    }),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
  assert.equal(state.writes.length, 0);
});

test("builder deploys a tested agent to the real sandbox endpoint", async () => {
  const { service, state, authorizeCalls } = serviceWith();

  const result = await service.deploySandbox({
    identity: identity(),
    requestId: "sandbox-request",
    deploymentId: "triage-sandbox",
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });

  assert.equal(result.deployment.status, "DEPLOYED");
  assert.equal(result.deployment.environment, "SANDBOX");
  assert.deepEqual(
    {
      runtimeId: result.deployment.runtimeId,
      runtimeArn: result.deployment.runtimeArn,
      runtimeStatus: result.deployment.runtimeStatus,
      endpointName: result.deployment.endpointName,
      endpointArn: result.deployment.endpointArn,
      runtimeVersion: result.deployment.runtimeVersion,
    },
    runtimeIdentity("SANDBOX"),
  );
  assert.equal(result.agent.status, "SANDBOX_DEPLOYED");
  assert.equal(authorizeCalls[0].action, "agent:sandbox-deploy");
  assert.deepEqual(
    state.writes.map(([type, input]) => [type, input.record.status]),
    [
      ["deployment", "DEPLOYING"],
      ["deployment", "DEPLOYED"],
      ["agent", "SANDBOX_DEPLOYED"],
    ],
  );
});

test("builder production submission creates a domain approval and pending agent state", async () => {
  const { service, state, authorizeCalls } = serviceWith();

  const result = await service.submitProduction({
    identity: identity(),
    requestId: "production-request",
    deploymentId: "triage-production",
    approvalId: "triage-production-approval",
    agentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });

  assert.equal(result.deployment.status, "REQUESTED");
  assert.equal(result.approval.status, "PENDING");
  assert.equal(result.agent.status, "PRODUCTION_PENDING");
  assert.equal(authorizeCalls[0].action, "agent:production-submit");
  assert.deepEqual(
    state.writes.map(([type, input]) => [type, input.record.status]),
    [
      ["deployment", "REQUESTED"],
      ["approval", "PENDING"],
      ["agent", "PRODUCTION_PENDING"],
    ],
  );
});

test("a different Domain Lead approval deploys production through AgentCore Runtime", async () => {
  const state = memoryState({
    currentAgent: agent({ status: "PRODUCTION_PENDING" }),
    currentDeployment: deployment(),
    currentApproval: approval(),
  });
  const { service, authorizeCalls } = serviceWith({ state });

  const result = await service.decideProduction({
    identity: identity("lead", "lead-sub"),
    requestId: "approval-request",
    deploymentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      deploymentId: "triage-production",
    },
    approvalId: "triage-production-approval",
    decision: "APPROVE",
    reason: "Approved after domain review.",
  });

  assert.equal(result.approval.status, "APPROVED");
  assert.equal(result.deployment.status, "DEPLOYED");
  assert.equal(result.deployment.endpointName, "Production");
  assert.equal(result.agent.status, "PRODUCTION_DEPLOYED");
  assert.equal(authorizeCalls[0].action, "deployment:approve");
  assert.deepEqual(
    state.writes.map(([type, input]) => [type, input.record.status]),
    [
      ["approval", "APPROVED"],
      ["deployment", "APPROVED"],
      ["deployment", "DEPLOYING"],
      ["deployment", "DEPLOYED"],
      ["agent", "PRODUCTION_APPROVED"],
      ["agent", "PRODUCTION_DEPLOYED"],
    ],
  );
});

test("production authorizer permits an identical deployment approval retry after partial and full success", async () => {
  const request = {
    identity: identity("lead", "lead-sub"),
    requestId: "production-authorizer-approval-retry",
    deploymentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      deploymentId: "triage-production",
    },
    approvalId: "triage-production-approval",
    decision: "APPROVE",
    reason: "Approved after domain review.",
  };
  const partialState = memoryState({
    currentAgent: agent({ status: "PRODUCTION_PENDING" }),
    currentDeployment: deployment(),
    currentApproval: approval({
      status: "APPROVED",
      approverSubject: "lead-sub",
      reason: request.reason,
      decidedAt: "2026-08-25T03:30:00.000Z",
    }),
  });
  const partial = serviceWithProductionAuthorizer({
    state: partialState,
  });

  const recovered = await partial.service.decideProduction(request);
  assert.equal(recovered.approval.status, "APPROVED");
  assert.equal(recovered.deployment.status, "DEPLOYED");
  assert.equal(recovered.agent.status, "PRODUCTION_DEPLOYED");

  const replayed = await partial.service.decideProduction(request);
  assert.deepEqual(replayed, recovered);
});

test("production authorizer does not let another approver or decision adopt a completed deployment approval", async () => {
  const reason = "Approved after domain review.";
  const state = memoryState({
    currentAgent: agent({ status: "PRODUCTION_DEPLOYED" }),
    currentDeployment: deployment({
      status: "DEPLOYED",
      approverSubject: "lead-sub",
      decisionReason: reason,
      decidedAt: "2026-08-25T03:30:00.000Z",
      ...runtimeIdentity("PRODUCTION"),
    }),
    currentApproval: approval({
      status: "APPROVED",
      approverSubject: "lead-sub",
      reason,
      decidedAt: "2026-08-25T03:30:00.000Z",
    }),
  });
  state.records.project = project({
    memberSubjects: ["builder-sub", "lead-sub", "other-lead-sub"],
  });
  const { service } = serviceWithProductionAuthorizer({ state });
  const request = {
    identity: identity("lead", "lead-sub"),
    requestId: "completed-deployment-approval",
    deploymentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      deploymentId: "triage-production",
    },
    approvalId: "triage-production-approval",
    decision: "APPROVE",
    reason,
  };

  await assert.rejects(
    service.decideProduction({
      ...request,
      identity: identity("lead", "other-lead-sub"),
    }),
    expectCode("FORBIDDEN"),
  );
  await assert.rejects(
    service.decideProduction({
      ...request,
      decision: "REJECT",
      reason: "Changed after the approval completed.",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(state.writes.length, 0);
});

test("Domain Lead can reject production without contacting Runtime", async () => {
  let runtimeCalls = 0;
  let modelAccessCalls = 0;
  const state = memoryState({
    currentAgent: agent({ status: "PRODUCTION_PENDING" }),
    currentDeployment: deployment(),
    currentApproval: approval(),
  });
  const { service } = serviceWith({
    state,
    runtimeControl: {
      async resolveEndpoint() {
        runtimeCalls += 1;
        throw new Error("must not be called");
      },
    },
    modelAccessResolver: async () => {
      modelAccessCalls += 1;
      return false;
    },
  });

  const result = await service.decideProduction({
    identity: identity("lead", "lead-sub"),
    requestId: "rejection-request",
    deploymentRef: {
      domainId: "customer_support",
      projectId: "case-assist",
      deploymentId: "triage-production",
    },
    approvalId: "triage-production-approval",
    decision: "REJECT",
    reason: "Security evidence is incomplete.",
  });

  assert.equal(runtimeCalls, 0);
  assert.equal(modelAccessCalls, 0);
  assert.equal(result.approval.status, "REJECTED");
  assert.equal(result.deployment.status, "REJECTED");
  assert.equal(result.agent.status, "REJECTED");
});

test("requesters cannot approve their own production submission", async () => {
  const state = memoryState({
    currentAgent: agent({ status: "PRODUCTION_PENDING" }),
    currentDeployment: deployment(),
    currentApproval: approval(),
  });
  const { service } = serviceWith({ state });

  await assert.rejects(
    service.decideProduction({
      identity: identity("lead", "builder-sub"),
      requestId: "self-approval-request",
      deploymentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        deploymentId: "triage-production",
      },
      approvalId: "triage-production-approval",
      decision: "APPROVE",
      reason: "Self approved.",
    }),
    expectCode("REQUESTER_CANNOT_APPROVE"),
  );
  assert.equal(state.writes.length, 0);
});

test("Runtime readiness failure does not advance the tested agent", async () => {
  const state = memoryState();
  const { service } = serviceWith({
    state,
    runtimeControl: {
      async resolveEndpoint() {
        throw new Error("Runtime is not ready.");
      },
    },
  });

  await assert.rejects(
    service.deploySandbox({
      identity: identity(),
      requestId: "sandbox-unavailable",
      deploymentId: "triage-sandbox",
      agentRef: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
    }),
    expectCode("RUNTIME_UNAVAILABLE"),
  );
  assert.equal(state.records.deployment.status, "DEPLOYING");
  assert.equal(state.records.agent.status, "TESTED");
});
