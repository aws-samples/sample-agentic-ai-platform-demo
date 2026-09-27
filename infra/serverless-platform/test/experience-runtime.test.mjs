import assert from "node:assert/strict";
import test from "node:test";
import {
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  createConfiguredExperienceHandler,
  createExperienceRuntime,
} from "../lambda/experience/runtime.mjs";

const ACTOR = "end-user-sub";
const PROOF_SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:111122223333:"
  + "secret:agentic-platform/runtime-proof-AbCdEf";
const PROOF_SECRET =
  "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function entitlement() {
  return {
    subject: ACTOR,
    agentId: "triage-agent",
    domainId: "customer_support",
    projectId: "case-assist",
    status: "ACTIVE",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T01:00:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
  };
}

function typedEntitlement(subjectType, subject) {
  return {
    ...entitlement(),
    subjectType,
    subject,
    expiresAt: null,
  };
}

function agent() {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Classifies support requests.",
    ownerSubject: "builder-sub",
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: [],
    memoryIds: [],
    knowledgeBaseIds: [],
    status: "PRODUCTION_DEPLOYED",
    createdBySubject: "builder-sub",
    createdAt: "2026-08-25T01:00:00.000Z",
    updatedAt: "2026-08-25T04:00:00.000Z",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: "2026-08-25T02:00:00.000Z",
    lastTestedBySubject: "builder-sub",
    lastTestModelId: "bedrock-claude/anthropic.claude-sonnet-5",
    lastTestInputTokens: 10,
    lastTestOutputTokens: 5,
    lastTestRequestId: "test-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Internal output.",
  };
}

function deployment() {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-production",
    agentId: "triage-agent",
    environment: "PRODUCTION",
    status: "DEPLOYED",
    requesterSubject: "builder-sub",
    approverSubject: "lead-sub",
    decisionReason: "Approved.",
    requestedAt: "2026-08-25T02:00:00.000Z",
    decidedAt: "2026-08-25T03:00:00.000Z",
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    runtimeArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567",
    runtimeStatus: "READY",
    endpointName: "Production",
    endpointArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567/"
      + "runtime-endpoint/Production",
    runtimeVersion: "1",
    updatedAt: "2026-08-25T04:00:00.000Z",
  };
}

function state({ entitlements = [entitlement()] } = {}) {
  return {
    beginTransaction() {
      return {
        timestamp: "2026-08-25T08:00:00.000Z",
        epochSeconds: 1787644800,
      };
    },
    async listEntitlements({ subject, subjectType }) {
      return {
        items: entitlements.filter((item) =>
          item.subject === subject
          && (item.subjectType ?? "USER") === (subjectType ?? "USER")),
        cursor: null,
      };
    },
    async listProjects() {
      return { items: [], cursor: null };
    },
    async listAgents() {
      return { items: [], cursor: null };
    },
    async getEntitlement({ subject, subjectType }) {
      return entitlements.find((item) =>
        item.subject === subject
        && (item.subjectType ?? "USER") === (subjectType ?? "USER")) ?? null;
    },
    async getAgent() {
      return agent();
    },
    async listDeployments() {
      return { items: [deployment()], cursor: null };
    },
    async getSession() {
      return null;
    },
    async listSessions() {
      return { items: [], cursor: null };
    },
    async listAccessRequests() {
      return { items: [], cursor: null };
    },
    async getMutationResult() {
      return null;
    },
    async claimMutation() {
      return true;
    },
    async putApproval({ record }) {
      return record;
    },
    async putSession({ record }) {
      return record;
    },
  };
}

function event(groups = ["end-user"]) {
  return {
    version: "2.0",
    routeKey: "GET /api/experience/agents",
    requestContext: {
      requestId: "api-request-123",
      http: {
        method: "GET",
        path: "/api/experience/agents",
      },
      authorizer: {
        jwt: {
          claims: {
            sub: ACTOR,
            username: "end-user",
            token_use: "access",
            "cognito:groups": groups,
          },
        },
      },
    },
  };
}

test("experience runtime composes authoritative state and exact allow decisions", async () => {
  const runtime = createExperienceRuntime({
    workspaceState: state(),
    domainDirectory: {
      async listActiveDomains() {
        return [{ id: "customer_support" }];
      },
    },
    runtimeAdapter: {
      async invoke() {
        return {
          output: "Response.",
          invocationId: "runtime-request-123",
        };
      },
    },
    invocationStore: {
      async get() {
        return null;
      },
      async start(input) {
        return {
          ...input,
          phase: "STARTED",
          runtimeStatus: null,
          output: null,
          invocationId: null,
        };
      },
      async complete(input) {
        return {
          ...input,
          phase: "COMPLETED",
        };
      },
    },
    submissionStore: {
      async submitFeedback() {
        return { id: "feedback-123", status: "RECORDED" };
      },
      async reportIssue() {
        return { id: "issue-123", status: "RECORDED" };
      },
    },
    identityVerifier: async () => false,
    groupDirectory: {
      async resolveCurrentGroups(claims) {
        return claims["cognito:groups"] || [];
      },
    },
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
  });

  const response = await runtime(event());
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.requestableItems, []);
  assert.equal(body.items[0].name, "Triage Agent");
  assert.deepEqual(Object.keys(body.items[0]).sort(), [
    "description",
    "id",
    "name",
  ]);
});

test("experience runtime authorizes exact authenticated group and domain entitlement subjects", async () => {
  for (const scenario of [
    {
      entitlement: typedEntitlement("GROUP", "support-users"),
      groups: ["end-user", "support-users"],
    },
    {
      entitlement: typedEntitlement("DOMAIN", "operations"),
      groups: ["end-user", "domain-operations"],
    },
  ]) {
    const runtime = createExperienceRuntime({
      workspaceState: state({
        entitlements: [scenario.entitlement],
      }),
      domainDirectory: {
        async listActiveDomains() {
          return [
            { id: "customer_support" },
            { id: "operations" },
          ];
        },
      },
      runtimeAdapter: {
        async invoke() {
          return {
            output: "Response.",
            invocationId: "runtime-request-123",
          };
        },
      },
      invocationStore: {
        async get() {
          return null;
        },
        async start(input) {
          return {
            ...input,
            phase: "STARTED",
            runtimeStatus: null,
            output: null,
            invocationId: null,
          };
        },
        async complete(input) {
          return {
            ...input,
            phase: "COMPLETED",
          };
        },
      },
      submissionStore: {
        async submitFeedback() {
          return { id: "feedback-123", status: "RECORDED" };
        },
        async reportIssue() {
          return { id: "issue-123", status: "RECORDED" };
        },
      },
      identityVerifier: async () => false,
      groupDirectory: {
        async resolveCurrentGroups(claims) {
          return claims["cognito:groups"] || [];
        },
      },
      clock: () => new Date("2026-08-25T08:00:00.000Z"),
    });

    const response = await runtime(event(scenario.groups));
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(body.items.length, 1);
  }
});

test("experience runtime fails configuration closed", () => {
  assert.throws(
    () => createExperienceRuntime(),
    /configuration is invalid/i,
  );
});

test("configured Experience handler defers deployment proof loading until invocation", async () => {
  const secretCalls = [];
  const configured = await createConfiguredExperienceHandler({
    env: {
      PLATFORM_STATE_TABLE_NAME: "AgenticPlatformState",
      RUNTIME_INVOCATION_PROOF_SECRET_ARN: PROOF_SECRET_ARN,
      COGNITO_USER_POOL_ID: "us-west-2_example",
    },
    dynamo: { async send() {} },
    agentRuntimeClient: { async send() {} },
    cognito: { async send() {} },
    secretsClient: {
      async send(command) {
        secretCalls.push(command);
        return {
          ARN: PROOF_SECRET_ARN,
          SecretString: PROOF_SECRET,
          VersionStages: ["AWSCURRENT"],
        };
      },
    },
    identityVerifier: async () => false,
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
  });

  assert.equal(typeof configured, "function");
  assert.equal(secretCalls.length, 0);
});

test("configured Experience handler construction does not expose unavailable proof details", async () => {
  let secretCalls = 0;
  const configured = await createConfiguredExperienceHandler({
    env: {
      PLATFORM_STATE_TABLE_NAME: "AgenticPlatformState",
      RUNTIME_INVOCATION_PROOF_SECRET_ARN: PROOF_SECRET_ARN,
      COGNITO_USER_POOL_ID: "us-west-2_example",
    },
    dynamo: { async send() {} },
    agentRuntimeClient: { async send() {} },
    cognito: { async send() {} },
    secretsClient: {
      async send() {
        secretCalls += 1;
        throw new Error(`do not expose ${PROOF_SECRET}`);
      },
    },
    identityVerifier: async () => false,
    clock: () => new Date("2026-08-25T08:00:00.000Z"),
  });

  assert.equal(typeof configured, "function");
  assert.equal(secretCalls, 0);
});
