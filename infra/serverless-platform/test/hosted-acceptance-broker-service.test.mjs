import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CreateRegistryRecordCommand,
  DeleteRegistryCommand,
  DeleteRegistryRecordCommand,
  GetRegistryCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  ListTagsForResourceCommand,
  SubmitRegistryRecordForApprovalCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  createWorkspaceState,
} from "../lambda/workspace/state.mjs";
import {
  domainGroupOperationToken,
} from "../lambda/platform-admin/domain-group-operation.mjs";

const ACCOUNT = "111122223333";
const REGION = "us-west-2";
const TABLE = "AgenticPlatform-Web-State";
const FIXTURE_REGISTRY_ID = "SharedReg12345";
const RECORD_ID = "Rec123456789";
const DOMAIN_REGISTRY_ID = "DomainReg1234";
const ACTOR = "admin-sub-123";
const OWNERSHIP = {
  runId: "12345",
  runAttempt: "2",
  domainName: "Hosted Acceptance 12345 2",
  domainId: "hosted_acceptance_12345_2",
  ownerGroup: "domain-hosted-acceptance-12345-2",
  registryEntryId: "hosted-acceptance-12345-2",
  registryRecordName: "hosted_acceptance_12345_2",
  registryVersion: "1.0.0",
  registryDisplayName: "Hosted Acceptance 12345 2 Blueprint",
  registryDescription:
    "Temporary governance fixture for hosted acceptance run 12345 attempt 2.",
  registryDescriptor: {
    resourceKind: "blueprint",
    blueprintId: "hosted-acceptance-12345-2",
    displayName: "Hosted Acceptance 12345 2 Blueprint",
    useCase:
      "Temporary governance fixture for hosted acceptance run 12345 attempt 2.",
    template: { framework: "Strands" },
    compat: {},
    version: "1.0.0",
    defaultVersion: "1.0.0",
    hostedAcceptance: {
      runId: "12345",
      runAttempt: "2",
      project: "agentic-ai-platform-demo",
      managedBy: "hosted-acceptance",
    },
  },
  tags: {
    "auto-delete": "no",
    project: "agentic-ai-platform-demo",
    managedBy: "hosted-acceptance",
  },
  fixtureClientToken: "b6a9e458-2293-4cf9-959c-fcc99c138993",
  requestIds: {
    domain: "01f7f12b-a9eb-4cf9-95a5-9cfa252958e1",
    registry: "ec3c19f5-1693-4b08-8cbd-3b10fbbe89a2",
    isolation: "6a6dcc80-9ade-42ce-b08d-77d3ab018551",
  },
};
const FIXTURE_REGISTRY_ARN =
  `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/${FIXTURE_REGISTRY_ID}`;
const RECORD_ARN = `${FIXTURE_REGISTRY_ARN}/record/${RECORD_ID}`;
const DOMAIN_REGISTRY_ARN =
  `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/${DOMAIN_REGISTRY_ID}`;
const CREATED_AT = new Date("2026-08-23T00:00:00.000Z");
const UPDATED_AT = new Date("2026-08-23T00:01:00.000Z");
const EXPERIENCE_DOMAIN_ID = "customer_support";
const RUNTIME_ID = "AgenticPlatformRuntime-ABC1234567";
const RUNTIME_ARN =
  `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:`
  + `runtime/${RUNTIME_ID}`;
const ENDPOINT_NAME = "Production";
const ENDPOINT_ARN =
  `${RUNTIME_ARN}/runtime-endpoint/${ENDPOINT_NAME}`;
const RUNTIME_IDENTITY = {
  runtimeId: RUNTIME_ID,
  runtimeArn: RUNTIME_ARN,
  runtimeStatus: "READY",
  endpointName: ENDPOINT_NAME,
  endpointArn: ENDPOINT_ARN,
  runtimeVersion: "7",
};
const EXPERIENCE_FIXTURE = {
  domainId: EXPERIENCE_DOMAIN_ID,
  projectId: "hosted-project-12345-2",
  agentId: "hosted-agent-12345-2",
  deploymentId: "hosted-production-12345-2",
};
const PERSONA_ACTORS = {
  administrator: ACTOR,
  reviewer: "reviewer-sub-456",
  ordinary: "ordinary-sub-789",
};
const PERSONA_PROJECT_ID = "hosted-project-12345-2";
const PERSONA_AGENT_ID = "acceptance-agent-12345-2";
const PERSONA_DEPLOYMENT_ID = "acceptance-production-12345-2";
const PERSONA_APPROVAL_ID =
  "acceptance-production-approval-12345-2";
const PERSONA_AGENT_NAME =
  `${OWNERSHIP.domainName} Positive Journey Agent`;
const PERSONA_AGENT_DESCRIPTION =
  "Temporary positive persona journey agent.";
const PERSONA_BLUEPRINT_ID = "chat-assistant";
const PERSONA_BUILD_CONFIG = {
  instructions:
    "Complete the requested task using only approved platform resources.",
  modelParameters: {
    temperature: 0,
    maxTokens: 128,
  },
  buildOptions: {
    framework: "Strands",
    deployTarget: "AgentCore Runtime",
    memory: "longAndShortTerm",
    streaming: true,
    identity: true,
    guardrails: true,
  },
};
const PERSONA_APPROVAL_REASON =
  "Approved by the hosted acceptance reviewer.";
const PERSONA_ENTITLEMENT_REASON =
  "Entitle the acceptance End User to the approved agent.";
const PERSONA_ACCESS_REASON =
  "Validate Domain Lead access administration.";
const PERSONA_INVOKE_PROMPT =
  "Run the hosted acceptance positive journey.";
const PERSONA_FEEDBACK_COMMENT =
  "Hosted acceptance positive journey verified.";
const PERSONA_TIMESTAMP = "2026-08-26T01:00:00.000Z";
const AGENT_BUILDING_FIXTURES = [
  {
    name: "journey-minimal-create",
    operation: "CREATE_JOURNEY",
    resourceType: "JOURNEY",
    resource: "minimalJourney",
  },
  {
    name: "journey-minimal-preview",
    operation: "CREATE_PREVIEW",
    resourceType: "DELIVERY",
    resource: "minimalDelivery",
  },
  {
    name: "journey-spec-create",
    operation: "CREATE_JOURNEY",
    resourceType: "JOURNEY",
    resource: "specJourney",
  },
  {
    name: "journey-spec-message-1",
    operation: "ADD_MESSAGE",
    resourceType: "JOURNEY",
    resource: "specJourney",
  },
  {
    name: "journey-spec-message-2",
    operation: "ADD_MESSAGE",
    resourceType: "JOURNEY",
    resource: "specJourney",
  },
  {
    name: "journey-spec-contract",
    operation: "CREATE_CONTRACT",
    resourceType: "JOURNEY",
    resource: "specJourney",
  },
  {
    name: "journey-spec-preview",
    operation: "CREATE_PREVIEW",
    resourceType: "DELIVERY",
    resource: "specDelivery",
  },
  {
    name: "journey-full-preview",
    operation: "CREATE_PREVIEW",
    resourceType: "DELIVERY",
    resource: "fullDelivery",
  },
];
const AGENT_BUILDING_RESOURCES = {
  minimalJourney: {
    type: "JOURNEY",
    id: "journey-minimal-a1b2c3",
    preset: "MINIMAL",
    repositoryName: "acceptance-minimal-12345-2",
  },
  minimalDelivery: {
    type: "DELIVERY",
    id: "delivery-minimal-a1b2c3",
    preset: "MINIMAL",
    repositoryName: "acceptance-minimal-12345-2",
  },
  specJourney: {
    type: "JOURNEY",
    id: "journey-spec-a1b2c3",
    preset: "SPEC",
    repositoryName: "acceptance-spec-12345-2",
  },
  specDelivery: {
    type: "DELIVERY",
    id: "delivery-spec-a1b2c3",
    preset: "SPEC",
    repositoryName: "acceptance-spec-12345-2",
  },
  fullDelivery: {
    type: "DELIVERY",
    id: "delivery-full-a1b2c3",
    preset: "FULL",
    repositoryName: "acceptance-full-12345-2",
  },
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function personaRequestIds() {
  const requestId = (operation) => deterministicUuid(
    `hosted-role-switching:${operation}:12345:2`,
  );
  return {
    builderCreateAgent: requestId("builder-create-agent"),
    builderTestAgent: requestId("builder-test-agent"),
    leadAccessGrant: requestId("lead-access-grant"),
    leadEntitlementGrant: requestId("lead-entitlement-grant"),
    userFeedback: requestId("user-feedback"),
    userInvoke: requestId("user-invoke"),
  };
}

function personaPublicAgentId() {
  return `agent-${
    createHash("sha256")
      .update(
        `${EXPERIENCE_DOMAIN_ID}\0${PERSONA_PROJECT_ID}\0`
        + PERSONA_AGENT_ID,
      )
      .digest("hex")
      .slice(0, 32)
  }`;
}

function personaSessionId() {
  const { userInvoke } = personaRequestIds();
  return `session-${
    createHash("sha256").update(ACTOR).digest("hex").slice(0, 16)
  }-${
    createHash("sha256")
      .update(`${ACTOR}\0${userInvoke}`)
      .digest("hex")
      .slice(0, 16)
  }`;
}

function personaFeedbackId() {
  const { userFeedback } = personaRequestIds();
  const payloadFingerprint = fingerprint({
    publicAgentId: personaPublicAgentId(),
    sessionId: personaSessionId(),
    rating: 5,
    comment: PERSONA_FEEDBACK_COMMENT,
  });
  return `feedback-${
    createHash("sha256")
      .update(
        `FEEDBACK\0${ACTOR}\0POST /api/experience/feedback\0`
        + `${userFeedback}\0${payloadFingerprint}`,
      )
      .digest("hex")
      .slice(0, 32)
  }`;
}

function primaryPersonaItems() {
  const requests = personaRequestIds();
  const sessionId = personaSessionId();
  const entitlementTimestamp = "2026-08-26T01:05:00.000Z";
  const entitlementResource =
    `entitlement/USER/${ACTOR}/${EXPERIENCE_DOMAIN_ID}/`
    + `${PERSONA_PROJECT_ID}/${PERSONA_AGENT_ID}`;
  const entitlementFingerprint = fingerprint({
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: PERSONA_PROJECT_ID,
    agentId: PERSONA_AGENT_ID,
    subjectType: "USER",
    subject: ACTOR,
    expiresAt: null,
    reason: PERSONA_ENTITLEMENT_REASON,
  });
  const invocationFingerprint = fingerprint({
    agentId: personaPublicAgentId(),
    sessionId,
    prompt: PERSONA_INVOKE_PROMPT,
  });
  const feedbackFingerprint = fingerprint({
    publicAgentId: personaPublicAgentId(),
    sessionId,
    rating: 5,
    comment: PERSONA_FEEDBACK_COMMENT,
  });
  return {
    agent: {
      pk: {
        S: `AGENT#${EXPERIENCE_DOMAIN_ID}#${PERSONA_PROJECT_ID}`,
      },
      sk: { S: `AGENT#${PERSONA_AGENT_ID}` },
      entityType: { S: "AGENT" },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      id: { S: PERSONA_AGENT_ID },
      name: { S: PERSONA_AGENT_NAME },
      description: { S: PERSONA_AGENT_DESCRIPTION },
      ownerSubject: { S: ACTOR },
      modelId: { S: "model-1" },
      toolIds: { L: [] },
      mcpServerIds: { L: [] },
      skillIds: { L: [] },
      blueprintIds: { L: [{ S: PERSONA_BLUEPRINT_ID }] },
      memoryIds: { L: [] },
      knowledgeBaseIds: { L: [] },
      buildConfig: {
        M: {
          instructions: { S: PERSONA_BUILD_CONFIG.instructions },
          modelParameters: {
            M: {
              temperature: {
                N: String(
                  PERSONA_BUILD_CONFIG.modelParameters.temperature,
                ),
              },
              maxTokens: {
                N: String(
                  PERSONA_BUILD_CONFIG.modelParameters.maxTokens,
                ),
              },
            },
          },
          buildOptions: {
            M: {
              framework: {
                S: PERSONA_BUILD_CONFIG.buildOptions.framework,
              },
              deployTarget: {
                S: PERSONA_BUILD_CONFIG.buildOptions.deployTarget,
              },
              memory: {
                S: PERSONA_BUILD_CONFIG.buildOptions.memory,
              },
              streaming: {
                BOOL: PERSONA_BUILD_CONFIG.buildOptions.streaming,
              },
              identity: {
                BOOL: PERSONA_BUILD_CONFIG.buildOptions.identity,
              },
              guardrails: {
                BOOL: PERSONA_BUILD_CONFIG.buildOptions.guardrails,
              },
            },
          },
        },
      },
      status: { S: "PRODUCTION_DEPLOYED" },
      createdBySubject: { S: ACTOR },
      createdAt: { S: PERSONA_TIMESTAMP },
      updatedAt: { S: "2026-08-26T01:04:00.000Z" },
      lastTestStatus: { S: "SUCCEEDED" },
      lastTestedAt: { S: "2026-08-26T01:01:00.000Z" },
      lastTestedBySubject: { S: ACTOR },
      lastTestModelId: { S: "model-1" },
      lastTestInputTokens: { N: "4" },
      lastTestOutputTokens: { N: "3" },
      lastTestRequestId: { S: "gateway-request" },
      lastTestEvidenceHash: { S: "a".repeat(64) },
      lastTestOutput: { S: "Hosted acceptance test response." },
    },
    deployment: {
      pk: {
        S: `DEPLOYMENT#${EXPERIENCE_DOMAIN_ID}#${PERSONA_PROJECT_ID}`,
      },
      sk: { S: `DEPLOYMENT#${PERSONA_DEPLOYMENT_ID}` },
      entityType: { S: "DEPLOYMENT" },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      id: { S: PERSONA_DEPLOYMENT_ID },
      agentId: { S: PERSONA_AGENT_ID },
      environment: { S: "PRODUCTION" },
      status: { S: "DEPLOYED" },
      requesterSubject: { S: ACTOR },
      approverSubject: { S: PERSONA_ACTORS.reviewer },
      decisionReason: { S: PERSONA_APPROVAL_REASON },
      requestedAt: { S: "2026-08-26T01:02:00.000Z" },
      decidedAt: { S: "2026-08-26T01:03:00.000Z" },
      runtimeId: { S: RUNTIME_IDENTITY.runtimeId },
      runtimeArn: { S: RUNTIME_IDENTITY.runtimeArn },
      runtimeStatus: { S: RUNTIME_IDENTITY.runtimeStatus },
      endpointName: { S: RUNTIME_IDENTITY.endpointName },
      endpointArn: { S: RUNTIME_IDENTITY.endpointArn },
      runtimeVersion: { S: RUNTIME_IDENTITY.runtimeVersion },
      updatedAt: { S: "2026-08-26T01:03:00.000Z" },
    },
    approval: {
      pk: { S: `APPROVAL#${EXPERIENCE_DOMAIN_ID}` },
      sk: { S: `APPROVAL#${PERSONA_APPROVAL_ID}` },
      entityType: { S: "APPROVAL" },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      id: { S: PERSONA_APPROVAL_ID },
      kind: { S: "PRODUCTION_DEPLOYMENT" },
      resourceType: { S: "DEPLOYMENT" },
      resourceId: { S: PERSONA_DEPLOYMENT_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      status: { S: "APPROVED" },
      requesterSubject: { S: ACTOR },
      approverSubject: { S: PERSONA_ACTORS.reviewer },
      reason: { S: PERSONA_APPROVAL_REASON },
      requestedAt: { S: "2026-08-26T01:02:00.000Z" },
      decidedAt: { S: "2026-08-26T01:03:00.000Z" },
    },
    entitlement: {
      pk: { S: `ENTITLEMENT#${ACTOR}` },
      sk: {
        S:
          `AGENT#${EXPERIENCE_DOMAIN_ID}#${PERSONA_PROJECT_ID}#`
          + PERSONA_AGENT_ID,
      },
      entityType: { S: "ENTITLEMENT" },
      subjectType: { S: "USER" },
      subject: { S: ACTOR },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      agentId: { S: PERSONA_AGENT_ID },
      status: { S: "ACTIVE" },
      expiresAt: { NULL: true },
      grantedBySubject: { S: PERSONA_ACTORS.reviewer },
      grantedAt: { S: "2026-08-26T01:05:00.000Z" },
      revokedBySubject: { NULL: true },
      revokedAt: { NULL: true },
    },
    entitlementMutation: {
      pk: { S: `MUTATION#${PERSONA_ACTORS.reviewer}` },
      sk: {
        S:
          "MUTATION#POST /api/governance/agent-entitlements#"
          + requests.leadEntitlementGrant,
      },
      entityType: { S: "MUTATION_RESULT" },
      actor: { S: PERSONA_ACTORS.reviewer },
      requesterSubject: { S: PERSONA_ACTORS.reviewer },
      effectiveRole: { S: "lead" },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      route: { S: "POST /api/governance/agent-entitlements" },
      requestId: { S: requests.leadEntitlementGrant },
      payloadFingerprint: { S: entitlementFingerprint },
      result: {
        M: {
          entityType: { S: "ENTITLEMENT" },
          resourceKey: { S: entitlementResource },
          operation: { S: "CREATE" },
          status: { S: "SUCCEEDED" },
        },
      },
      decision: { S: "grant" },
      reason: { S: PERSONA_ENTITLEMENT_REASON },
      timestamp: { S: entitlementTimestamp },
      createdAt: { S: entitlementTimestamp },
    },
    entitlementAudit: {
      pk: { S: `AUDIT#${entitlementResource}` },
      sk: {
        S: `${entitlementTimestamp}#${requests.leadEntitlementGrant}`,
      },
      entityType: { S: "WORKSPACE_AUDIT" },
      resource: { S: entitlementResource },
      timestamp: { S: entitlementTimestamp },
      requestId: { S: requests.leadEntitlementGrant },
      actor: { S: PERSONA_ACTORS.reviewer },
      requesterSubject: { S: PERSONA_ACTORS.reviewer },
      effectiveRole: { S: "lead" },
      action: { S: "entitlement.create" },
      decision: { S: "grant" },
      reason: { S: PERSONA_ENTITLEMENT_REASON },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
    },
    session: {
      pk: { S: `SESSION#${ACTOR}` },
      sk: { S: `SESSION#${sessionId}` },
      entityType: { S: "SESSION" },
      actor: { S: ACTOR },
      id: { S: sessionId },
      agentId: { S: PERSONA_AGENT_ID },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      status: { S: "ACTIVE" },
      lastInvocationStatus: { S: "SUCCEEDED" },
      createdAt: { S: "2026-08-26T01:06:00.000Z" },
      updatedAt: { S: "2026-08-26T01:06:00.000Z" },
    },
    invocation: {
      pk: { S: `EXPERIENCE_INVOCATION#${ACTOR}` },
      sk: { S: `REQUEST#${requests.userInvoke}` },
      entityType: { S: "EXPERIENCE_INVOCATION" },
      actor: { S: ACTOR },
      requestId: { S: requests.userInvoke },
      payloadFingerprint: { S: invocationFingerprint },
      sessionId: { S: sessionId },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      agentId: { S: PERSONA_AGENT_ID },
      baselineFingerprint: { S: "NONE" },
      phase: { S: "COMPLETED" },
      createdAt: { S: "2026-08-26T01:05:59.000Z" },
      runtimeStatus: { S: "SUCCEEDED" },
      output: { S: "Hosted acceptance invocation response." },
      invocationId: { S: "runtime-invocation-123" },
      completedAt: { S: "2026-08-26T01:06:00.000Z" },
    },
    feedback: {
      pk: { S: `SUBMISSION#${ACTOR}` },
      sk: { S: `FEEDBACK#${personaFeedbackId()}` },
      entityType: { S: "EXPERIENCE_SUBMISSION" },
      submissionType: { S: "FEEDBACK" },
      id: { S: personaFeedbackId() },
      status: { S: "RECORDED" },
      actor: { S: ACTOR },
      effectiveRole: { S: "user" },
      route: { S: "POST /api/experience/feedback" },
      requestId: { S: requests.userFeedback },
      payloadFingerprint: { S: feedbackFingerprint },
      createdAt: { S: "2026-08-26T01:07:00.000Z" },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
      projectId: { S: PERSONA_PROJECT_ID },
      agentId: { S: PERSONA_AGENT_ID },
      sessionId: { S: sessionId },
      rating: { N: "5" },
      comment: { S: PERSONA_FEEDBACK_COMMENT },
    },
  };
}

function failedEndUserInvocationItems() {
  const requests = personaRequestIds();
  const sessionId = personaSessionId();
  const timestamp = "2026-08-26T01:06:00.000Z";
  const resource = `session/${ACTOR}/${sessionId}`;
  const reason = "Governed invocation completed with FAILED.";
  const payloadFingerprint = fingerprint({
    agentId: personaPublicAgentId(),
    sessionId,
    prompt: PERSONA_INVOKE_PROMPT,
  });
  const items = primaryPersonaItems();
  items.session.lastInvocationStatus = { S: "FAILED" };
  items.invocation.runtimeStatus = { S: "FAILED" };
  items.invocation.output = { NULL: true };
  items.invocation.invocationId = { NULL: true };
  delete items.feedback;
  items.invocationMutation = {
    pk: { S: `MUTATION#${ACTOR}` },
    sk: {
      S:
        "MUTATION#POST /api/experience/invocations#"
        + requests.userInvoke,
    },
    entityType: { S: "MUTATION_RESULT" },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "user" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
    route: { S: "POST /api/experience/invocations" },
    requestId: { S: requests.userInvoke },
    payloadFingerprint: { S: payloadFingerprint },
    result: {
      M: {
        entityType: { S: "SESSION" },
        resourceKey: { S: resource },
        operation: { S: "CREATE" },
        status: { S: "SUCCEEDED" },
      },
    },
    decision: { S: "create" },
    reason: { S: reason },
    timestamp: { S: timestamp },
    createdAt: { S: timestamp },
  };
  items.invocationAudit = {
    pk: { S: `AUDIT#${resource}` },
    sk: { S: `${timestamp}#${requests.userInvoke}` },
    entityType: { S: "WORKSPACE_AUDIT" },
    resource: { S: resource },
    timestamp: { S: timestamp },
    requestId: { S: requests.userInvoke },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "user" },
    action: { S: "session.create" },
    decision: { S: "create" },
    reason: { S: reason },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
  };
  return items;
}

function builderCreateMutationFixture() {
  const { builderCreateAgent } = personaRequestIds();
  const route = "POST /api/agents";
  const resource =
    `agent/${EXPERIENCE_DOMAIN_ID}/${PERSONA_PROJECT_ID}/`
    + PERSONA_AGENT_ID;
  const payloadFingerprint = fingerprint({
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: PERSONA_PROJECT_ID,
    id: PERSONA_AGENT_ID,
    name: PERSONA_AGENT_NAME,
    description: PERSONA_AGENT_DESCRIPTION,
    modelId: "model-1",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: [PERSONA_BLUEPRINT_ID],
    memoryIds: [],
    knowledgeBaseIds: [],
    buildConfig: PERSONA_BUILD_CONFIG,
  });
  const mutation = {
    pk: { S: `MUTATION#${ACTOR}` },
    sk: { S: `MUTATION#${route}#${builderCreateAgent}` },
    entityType: { S: "MUTATION_RESULT" },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "builder" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
    route: { S: route },
    requestId: { S: builderCreateAgent },
    payloadFingerprint: { S: payloadFingerprint },
    result: {
      M: {
        entityType: { S: "AGENT" },
        resourceKey: { S: resource },
        operation: { S: "CREATE" },
        status: { S: "SUCCEEDED" },
      },
    },
    decision: { S: "create" },
    reason: { S: "Agent draft created." },
    timestamp: { S: PERSONA_TIMESTAMP },
    createdAt: { S: PERSONA_TIMESTAMP },
  };
  const audit = {
    pk: { S: `AUDIT#${resource}` },
    sk: { S: `${PERSONA_TIMESTAMP}#${builderCreateAgent}` },
    entityType: { S: "WORKSPACE_AUDIT" },
    resource: { S: resource },
    timestamp: { S: PERSONA_TIMESTAMP },
    requestId: { S: builderCreateAgent },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "builder" },
    action: { S: "agent.create" },
    decision: { S: "create" },
    reason: { S: "Agent draft created." },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
  };
  return { mutation, audit };
}

function failedBuilderTestFixture() {
  const { builderTestAgent } = personaRequestIds();
  const gatewayRequestId = "req_gateway_retryable_12345";
  const route = "POST /api/agents/{id}/test";
  const resource =
    `agent/${EXPERIENCE_DOMAIN_ID}/${PERSONA_PROJECT_ID}/`
    + PERSONA_AGENT_ID;
  const payloadFingerprint = fingerprint({
    agentRef: {
      domainId: EXPERIENCE_DOMAIN_ID,
      projectId: PERSONA_PROJECT_ID,
      agentId: PERSONA_AGENT_ID,
    },
    prompt: "Confirm this acceptance agent is ready.",
    maxTokens: 128,
  });
  const reason = "Gateway test failed with a retryable error.";
  const timestamp = "2026-08-26T01:01:00.000Z";
  const agent = primaryPersonaItems().agent;
  agent.status = { S: "TEST_FAILED" };
  agent.updatedAt = { S: timestamp };
  agent.lastTestStatus = { S: "FAILED" };
  agent.lastTestedAt = { S: timestamp };
  agent.lastTestInputTokens = { N: "0" };
  agent.lastTestOutputTokens = { N: "0" };
  agent.lastTestRequestId = { S: gatewayRequestId };
  agent.lastTestEvidenceHash = { S: fingerprint({
    status: "FAILED",
    modelId: agent.modelId.S,
    inputTokens: 0,
    outputTokens: 0,
    requestId: gatewayRequestId,
    retryable: true,
  }) };
  agent.lastTestOutput = { NULL: true };
  const claim = {
    pk: { S: `MUTATION#${ACTOR}` },
    sk: { S: `CLAIM#${route}#${builderTestAgent}` },
    entityType: { S: "MUTATION_CLAIM" },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "builder" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
    route: { S: route },
    requestId: { S: builderTestAgent },
    payloadFingerprint: { S: payloadFingerprint },
    resourceKey: { S: resource },
    operation: { S: "UPDATE" },
    createdAt: { S: timestamp },
  };
  const mutation = {
    pk: { S: `MUTATION#${ACTOR}` },
    sk: { S: `MUTATION#${route}#${builderTestAgent}` },
    entityType: { S: "MUTATION_RESULT" },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "builder" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
    route: { S: route },
    requestId: { S: builderTestAgent },
    payloadFingerprint: { S: payloadFingerprint },
    result: {
      M: {
        entityType: { S: "AGENT" },
        resourceKey: { S: resource },
        operation: { S: "UPDATE" },
        status: { S: "FAILED" },
      },
    },
    decision: { S: "abort" },
    reason: { S: reason },
    timestamp: { S: timestamp },
    createdAt: { S: timestamp },
  };
  const audit = {
    pk: { S: `AUDIT#${resource}` },
    sk: { S: `${timestamp}#${builderTestAgent}` },
    entityType: { S: "WORKSPACE_AUDIT" },
    resource: { S: resource },
    timestamp: { S: timestamp },
    requestId: { S: builderTestAgent },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "builder" },
    action: { S: "agent.update" },
    decision: { S: "abort" },
    reason: { S: reason },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
  };
  return { agent, claim, mutation, audit };
}

async function loadService() {
  const module =
    await import("../lambda/hosted-acceptance-broker/service.mjs");
  return {
    ...module,
    createHostedAcceptanceBrokerService(configuration) {
      let cleanupLease = null;
      const dynamoClient = configuration.dynamoClient === undefined
        ? undefined
        : {
            async send(command) {
              const itemKey = command instanceof PutItemCommand
                ? dynamoKey(command.input.Item)
                : null;
              const key = command instanceof DeleteItemCommand
                ? dynamoKey(command.input.Key)
                : null;
              const leaseKey = dynamoKey(cleanupLeaseKey());
              if (
                command instanceof PutItemCommand
                && itemKey === leaseKey
              ) {
                const renewal =
                  command.input.ExpressionAttributeValues
                    ?.[":cleanupExecutionToken"] !== undefined;
                if (renewal) {
                  if (
                    cleanupLease?.cleanupExecutionToken?.S
                      !== command.input.ExpressionAttributeValues
                        ?.[":cleanupExecutionToken"]?.S
                  ) {
                    throw conditionalFailure();
                  }
                } else if (cleanupLease !== null) {
                  throw conditionalFailure();
                }
                cleanupLease = structuredClone(command.input.Item);
                return {};
              }
              if (
                command instanceof DeleteItemCommand
                && key === leaseKey
              ) {
                if (
                  cleanupLease?.cleanupExecutionToken?.S
                    !== command.input.ExpressionAttributeValues
                      ?.[":cleanupExecutionToken"]?.S
                ) {
                  throw conditionalFailure();
                }
                cleanupLease = null;
                return {};
              }
              return configuration.dynamoClient.send(command);
            },
          };
      return module.createHostedAcceptanceBrokerService({
        domainDirectory: NOOP_DOMAIN_DIRECTORY,
        ...configuration,
        cleanupClock: configuration.cleanupClock ?? (() => 1_000_000),
        cleanupExecutionTokenFactory:
          configuration.cleanupExecutionTokenFactory
          ?? (() => "88888888-8888-4888-8888-888888888888"),
        dynamoClient,
      });
    },
  };
}

async function loadRawService() {
  return import("../lambda/hosted-acceptance-broker/service.mjs");
}

function readyRuntimeControl(identity = RUNTIME_IDENTITY) {
  return {
    calls: [],
    runtimeId: RUNTIME_ID,
    productionEndpointName: ENDPOINT_NAME,
    async resolveEndpoint(environment) {
      this.calls.push(environment);
      return identity;
    },
  };
}

const NOOP_DOMAIN_DIRECTORY = Object.freeze({
  async deleteGroupExact() {},
});

function activeDomainItem(id = EXPERIENCE_DOMAIN_ID, status = "ACTIVE") {
  return {
    pk: { S: "DOMAIN" },
    sk: { S: `DOMAIN#${id}` },
    entityType: { S: "DOMAIN" },
    id: { S: id },
    name: { S: "Customer Support" },
    owner: { S: "Customer Support domain team" },
    ownerGroup: { S: "domain-customer-support" },
    description: { S: "Customer support agents." },
    tokenBudget: { NULL: true },
    registryId: { S: DOMAIN_REGISTRY_ID },
    registryArn: { S: DOMAIN_REGISTRY_ARN },
    createdBy: { S: ACTOR },
    status: { S: status },
    createdAt: { S: "2026-08-23T00:00:00.000Z" },
  };
}

function dynamoKey(key) {
  return `${key.pk.S}|${key.sk.S}`;
}

function deterministicUuid(namespace) {
  const bytes = createHash("sha256").update(namespace).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function agentBuildingRequestId(name) {
  return deterministicUuid(
    `hosted-role-switching:${name}:12345:2`,
  );
}

function agentBuildingMutation(spec, overrides = {}) {
  const requestId = agentBuildingRequestId(spec.name);
  const resource = AGENT_BUILDING_RESOURCES[spec.resource];
  return {
    pk: { S: `MUTATION#${ACTOR}` },
    sk: { S: `JOURNEY#${spec.operation}#${requestId}` },
    entityType: { S: "JOURNEY_MUTATION" },
    actor: { S: ACTOR },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    effectiveRole: { S: "builder" },
    operation: { S: spec.operation },
    requestId: { S: requestId },
    payloadFingerprint: { S: "a".repeat(64) },
    resourceType: { S: spec.resourceType },
    resourceId: { S: resource.id },
    status: { S: "SUCCEEDED" },
    leaseToken: { S: "77777777-7777-4777-8777-777777777777" },
    leaseExpiresAt: { S: "2026-08-26T01:00:45.000Z" },
    result: {
      M: {
        resourceType: { S: spec.resourceType },
        resourceId: { S: resource.id },
      },
    },
    createdAt: { S: PERSONA_TIMESTAMP },
    updatedAt: { S: PERSONA_TIMESTAMP },
    expiresAt: { N: "1819232400" },
    ...overrides,
  };
}

function agentBuildingResource(resource, overrides = {}) {
  const record = {
    actor: { S: ACTOR },
    id: { S: resource.id },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    preset: { S: resource.preset },
    repositoryName: { S: resource.repositoryName },
  };
  return {
    pk: { S: `${resource.type}#${ACTOR}#${resource.id}` },
    sk: { S: resource.type },
    entityType: { S: resource.type },
    actor: { S: ACTOR },
    id: { S: resource.id },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    preset: { S: resource.preset },
    status: {
      S: resource.type === "JOURNEY" ? "DRAFT" : "PREVIEWED",
    },
    createdAt: { S: PERSONA_TIMESTAMP },
    updatedAt: { S: PERSONA_TIMESTAMP },
    record: { M: record },
    mutation: { M: {} },
    expiresAt: { N: "1819232400" },
    ...(resource.type === "DELIVERY"
      ? {
          role: { S: "builder" },
          previewExpiresAt: { S: "2026-08-26T01:15:00.000Z" },
          manifestFingerprint: { S: "b".repeat(64) },
        }
      : {}),
    ...overrides,
  };
}

function agentBuildingItems() {
  const resources = Object.fromEntries(
    Object.entries(AGENT_BUILDING_RESOURCES).map(([name, resource]) => [
      name,
      agentBuildingResource(resource),
    ]),
  );
  const mutations = AGENT_BUILDING_FIXTURES.map(agentBuildingMutation);
  return {
    mutations,
    resources,
    all: [...mutations, ...Object.values(resources)],
  };
}

function transactionConditionMatches(operation, existing) {
  const expression = operation.ConditionExpression;
  if (typeof expression !== "string") return true;
  const names = operation.ExpressionAttributeNames ?? {};
  const values = operation.ExpressionAttributeValues ?? {};
  const absent = existing === undefined;
  const equalityMatches = () =>
    Object.entries(names).every(([placeholder, attributeName]) => {
      const valuePlaceholder = `:${placeholder.slice(1)}`;
      return isDeepStrictEqual(
        existing?.[attributeName],
        values[valuePlaceholder],
      );
    });
  if (expression.includes("attribute_not_exists")) {
    return expression.includes(" OR ")
      ? absent || equalityMatches()
      : absent;
  }
  return !absent && equalityMatches();
}

function fixtureDynamo(initialItems = [activeDomainItem()]) {
  const items = new Map(
    initialItems.map((item) => [dynamoKey(item), structuredClone(item)]),
  );
  return {
    commands: [],
    items,
    async send(command) {
      this.commands.push(command);
      if (command instanceof GetItemCommand) {
        const item = items.get(dynamoKey(command.input.Key));
        return item === undefined ? {} : { Item: structuredClone(item) };
      }
      if (command instanceof PutItemCommand) {
        items.set(
          dynamoKey(command.input.Item),
          structuredClone(command.input.Item),
        );
        return {};
      }
      if (command instanceof DeleteItemCommand) {
        items.delete(dynamoKey(command.input.Key));
        return {};
      }
      if (command instanceof QueryCommand) {
        const partitionKey =
          command.input.ExpressionAttributeValues?.[":pk"]?.S;
        const matches = [...items.values()]
          .filter((item) => item.pk?.S === partitionKey)
          .map((item) => structuredClone(item));
        return {
          Count: matches.length,
          Items: matches,
          ScannedCount: matches.length,
        };
      }
      if (command instanceof TransactWriteItemsCommand) {
        for (const operation of command.input.TransactItems) {
          const write = operation.Put ?? operation.Delete;
          const key = operation.Put?.Item ?? operation.Delete?.Key;
          if (
            !write
            || !transactionConditionMatches(
              write,
              items.get(dynamoKey(key)),
            )
          ) {
            const error = new Error("Transaction cancelled.");
            error.name = "TransactionCanceledException";
            error.code = "TransactionCanceledException";
            throw error;
          }
        }
        for (const operation of command.input.TransactItems) {
          if (operation.Put) {
            items.set(
              dynamoKey(operation.Put.Item),
              structuredClone(operation.Put.Item),
            );
          } else if (operation.Delete) {
            items.delete(dynamoKey(operation.Delete.Key));
          } else {
            throw new Error("Unexpected transaction operation.");
          }
        }
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  };
}

test("persona fixture persists one exact run-owned actor mapping", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );

  assert.deepEqual(await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  }), { ok: true });

  const writes = dynamo.commands.filter(
    (command) => command instanceof PutItemCommand,
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(
    {
      pk: writes[0].input.Item.pk,
      sk: writes[0].input.Item.sk,
      entityType: writes[0].input.Item.entityType,
      administratorActor: writes[0].input.Item.administratorActor,
      reviewerActor: writes[0].input.Item.reviewerActor,
      ordinaryActor: writes[0].input.Item.ordinaryActor,
      domainId: writes[0].input.Item.domainId,
    },
    {
      pk: { S: "HOSTED_ROLE_SWITCHING" },
      sk: { S: "RUN#12345#ATTEMPT#2" },
      entityType: { S: "HOSTED_ROLE_SWITCHING_RUN" },
      administratorActor: { S: ACTOR },
      reviewerActor: { S: "reviewer-sub-456" },
      ordinaryActor: { S: "ordinary-sub-789" },
      domainId: { S: EXPERIENCE_DOMAIN_ID },
    },
  );
  assert.match(
    writes[0].input.ConditionExpression,
    /attribute_not_exists\(pk\).*administratorActor/s,
  );
  assert.equal(
    writes[0].input.ExpressionAttributeNames?.["#project"],
    "project",
  );
  assert.match(
    writes[0].input.ConditionExpression,
    /#project = :project/,
  );
});

test("persona cleanup uses exact reads and one conditional delete transaction", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const { mutation, audit } = builderCreateMutationFixture();
  dynamo.items.set(dynamoKey(mutation), mutation);
  dynamo.items.set(dynamoKey(audit), audit);
  dynamo.commands.length = 0;

  assert.deepEqual(await service.cleanupPersonaJourneyFixture({
    ownership: OWNERSHIP,
  }), { ok: true });

  assert.equal(
    dynamo.commands.some((command) =>
      /Scan|Query|BatchWrite|CreateTable|DeleteTable|UpdateTable/
        .test(command.constructor.name)
    ),
    false,
  );
  const readKeys = dynamo.commands
    .filter((command) => command instanceof GetItemCommand)
    .map((command) => command.input.Key.pk.S);
  for (const prefix of [
    "AGENT#",
    "APPROVAL#",
    "AUDIT#",
    "DEPLOYMENT#",
    "ENTITLEMENT#",
    "EXPERIENCE_INVOCATION#",
    "MUTATION#",
    "SESSION#",
    "SUBMISSION#",
  ]) {
    assert.ok(readKeys.some((key) => key.startsWith(prefix)), prefix);
  }
  assert.equal(
    dynamo.commands.some(
      (command) => command instanceof DeleteItemCommand,
    ),
    false,
  );
  const transactions = dynamo.commands.filter(
    (command) => command instanceof TransactWriteItemsCommand,
  );
  assert.equal(transactions.length, 1);
  const deletes = transactions[0].input.TransactItems;
  assert.ok(deletes.length <= 100);
  assert.ok(deletes.every(({ Delete }) =>
    Delete?.TableName === TABLE
    && Delete.ConditionExpression.includes("entityType")
  ));
  assert.deepEqual(deletes.at(-1).Delete.Key, {
    pk: { S: "HOSTED_ROLE_SWITCHING" },
    sk: { S: "RUN#12345#ATTEMPT#2" },
  });
});

test("persona cleanup accepts a contract-generated governed Agent shape", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const agent = primaryPersonaItems().agent;
  agent.name = { S: "support-case-triage-assistant" };
  agent.description = {
    S: "Read-only assistant that helps support staff triage cases.",
  };
  agent.buildConfig.M.instructions = {
    S: [
      "Read-only assistant that helps support staff triage cases.",
      "Required capabilities:\n- Case data retrieval",
      "The Agent must remain read-only.",
      "Compliance requirements:\n- Read-only access",
    ].join("\n\n"),
  };
  dynamo.items.set(dynamoKey(agent), structuredClone(agent));
  dynamo.commands.length = 0;

  assert.deepEqual(await service.cleanupPersonaJourneyFixture({
    ownership: OWNERSHIP,
  }), { ok: true });

  const transaction = dynamo.commands.find(
    (command) => command instanceof TransactWriteItemsCommand,
  );
  assert.ok(transaction);
  assert.equal(
    transaction.input.TransactItems.some(({ Delete }) =>
      Delete.Key.pk.S === agent.pk.S
      && Delete.Key.sk.S === agent.sk.S),
    true,
  );
});

test("persona cleanup is retry-safe after an atomic transaction cancellation", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const dynamo = fixtureDynamo();
  const send = dynamo.send.bind(dynamo);
  let cancelNextTransaction = true;
  dynamo.send = async (command) => {
    if (
      cancelNextTransaction
      && command instanceof TransactWriteItemsCommand
    ) {
      cancelNextTransaction = false;
      dynamo.commands.push(command);
      const error = new Error("Transaction cancelled.");
      error.name = "TransactionCanceledException";
      error.code = "TransactionCanceledException";
      throw error;
    }
    return send(command);
  };
  const { service } = fixtureService(
    createHostedAcceptanceBrokerService,
    { dynamo },
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });

  await assert.rejects(
    service.cleanupPersonaJourneyFixture({ ownership: OWNERSHIP }),
    /cleanup failed/i,
  );
  assert.deepEqual(await service.cleanupPersonaJourneyFixture({
    ownership: OWNERSHIP,
  }), { ok: true });
  assert.equal(
    dynamo.items.has(
      "HOSTED_ROLE_SWITCHING|RUN#12345#ATTEMPT#2",
    ),
    false,
  );
});

test("persona cleanup recovers an audit-first partial delete from the prior implementation", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const { mutation } = builderCreateMutationFixture();
  dynamo.items.set(dynamoKey(mutation), mutation);
  dynamo.commands.length = 0;

  assert.deepEqual(await service.cleanupPersonaJourneyFixture({
    ownership: OWNERSHIP,
  }), { ok: true });
  assert.equal(dynamo.items.has(dynamoKey(mutation)), false);
  assert.equal(
    dynamo.items.has(
      "HOSTED_ROLE_SWITCHING|RUN#12345#ATTEMPT#2",
    ),
    false,
  );
});

test("persona cleanup rejects a foreign same-key entity before any transaction", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const agent = {
    pk: {
      S:
        `AGENT#${EXPERIENCE_DOMAIN_ID}#hosted-project-12345-2`,
    },
    sk: { S: "AGENT#acceptance-agent-12345-2" },
    entityType: { S: "AGENT" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: "hosted-project-12345-2" },
    id: { S: "acceptance-agent-12345-2" },
    ownerSubject: { S: "foreign-owner" },
    createdBySubject: { S: "foreign-owner" },
    status: { S: "PRODUCTION_DEPLOYED" },
  };
  dynamo.items.set(dynamoKey(agent), agent);
  dynamo.commands.length = 0;

  await assert.rejects(
    service.cleanupPersonaJourneyFixture({ ownership: OWNERSHIP }),
    /cleanup failed/i,
  );
  assert.equal(
    dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
  assert.deepEqual(dynamo.items.get(dynamoKey(agent)), agent);
  assert.equal(
    dynamo.items.has(
      "HOSTED_ROLE_SWITCHING|RUN#12345#ATTEMPT#2",
    ),
    true,
  );
});

test("persona cleanup accepts the complete production-shaped persona fixture", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const items = primaryPersonaItems();
  const { mutation, audit } = builderCreateMutationFixture();
  const requests = personaRequestIds();
  const claim = {
    pk: { S: `MUTATION#${ACTOR}` },
    sk: {
      S:
        "CLAIM#POST /api/agents/{id}/test#"
        + requests.builderTestAgent,
    },
    entityType: { S: "MUTATION_CLAIM" },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "builder" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
    route: { S: "POST /api/agents/{id}/test" },
    requestId: { S: requests.builderTestAgent },
    payloadFingerprint: {
      S: fingerprint({
        agentRef: {
          domainId: EXPERIENCE_DOMAIN_ID,
          projectId: PERSONA_PROJECT_ID,
          agentId: PERSONA_AGENT_ID,
        },
        prompt: "Confirm this acceptance agent is ready.",
        maxTokens: 128,
      }),
    },
    resourceKey: {
      S:
        `agent/${EXPERIENCE_DOMAIN_ID}/${PERSONA_PROJECT_ID}/`
        + PERSONA_AGENT_ID,
    },
    operation: { S: "UPDATE" },
    createdAt: { S: PERSONA_TIMESTAMP },
  };
  for (const item of [
    ...Object.values(items),
    mutation,
    audit,
    claim,
  ]) {
    dynamo.items.set(dynamoKey(item), structuredClone(item));
  }
  dynamo.commands.length = 0;

  assert.deepEqual(await service.cleanupPersonaJourneyFixture({
    ownership: OWNERSHIP,
  }), { ok: true });
  assert.equal(
    dynamo.commands.filter(
      (command) => command instanceof TransactWriteItemsCommand,
    ).length,
    1,
  );
  assert.equal(
    dynamo.items.has("HOSTED_ROLE_SWITCHING|RUN#12345#ATTEMPT#2"),
    false,
  );
});

test("persona cleanup accepts an exact failed End User invocation without feedback", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const items = failedEndUserInvocationItems();
  for (const item of Object.values(items)) {
    dynamo.items.set(dynamoKey(item), structuredClone(item));
  }
  dynamo.commands.length = 0;

  assert.deepEqual(await service.cleanupPersonaJourneyFixture({
    ownership: OWNERSHIP,
  }), { ok: true });
  assert.equal(
    dynamo.commands.filter(
      (command) => command instanceof TransactWriteItemsCommand,
    ).length,
    1,
  );
  assert.equal(
    dynamo.items.has("HOSTED_ROLE_SWITCHING|RUN#12345#ATTEMPT#2"),
    false,
  );
});

test("persona cleanup rejects mixed End User invocation outcomes", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const items = failedEndUserInvocationItems();
  items.session.lastInvocationStatus = { S: "SUCCEEDED" };
  for (const item of Object.values(items)) {
    dynamo.items.set(dynamoKey(item), structuredClone(item));
  }
  dynamo.commands.length = 0;

  await assert.rejects(
    service.cleanupPersonaJourneyFixture({ ownership: OWNERSHIP }),
    /cleanup failed/i,
  );
  assert.equal(
    dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
});

test("persona cleanup rejects a tampered failed End User invocation status attribute", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const items = failedEndUserInvocationItems();
  items.invocation.runtimeStatus = {
    S: "FAILED",
    tampered: true,
  };
  for (const item of Object.values(items)) {
    dynamo.items.set(dynamoKey(item), structuredClone(item));
  }
  dynamo.commands.length = 0;

  await assert.rejects(
    service.cleanupPersonaJourneyFixture({ ownership: OWNERSHIP }),
    /cleanup failed/i,
  );
  assert.equal(
    dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
});

test("persona cleanup rejects unexpected entitlement authorization evidence", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const items = primaryPersonaItems();
  items.entitlementMutation.authorizationEvidenceId = {
    S: "break-glass-001",
  };
  items.entitlementAudit.authorizationEvidenceId = {
    S: "break-glass-001",
  };
  for (const item of Object.values(items)) {
    dynamo.items.set(dynamoKey(item), structuredClone(item));
  }
  dynamo.commands.length = 0;

  await assert.rejects(
    service.cleanupPersonaJourneyFixture({ ownership: OWNERSHIP }),
    /cleanup failed/i,
  );
  assert.equal(
    dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
});

test("persona cleanup accepts an exact failed Gateway test fixture", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const { dynamo, service } = fixtureService(
    createHostedAcceptanceBrokerService,
  );
  await service.persistPersonaJourneyFixture({
    actors: PERSONA_ACTORS,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  });
  const items = failedBuilderTestFixture();
  for (const item of Object.values(items)) {
    dynamo.items.set(dynamoKey(item), structuredClone(item));
  }
  dynamo.commands.length = 0;

  assert.deepEqual(await service.cleanupPersonaJourneyFixture({
    ownership: OWNERSHIP,
  }), { ok: true });
  assert.equal(
    dynamo.commands.filter(
      (command) => command instanceof TransactWriteItemsCommand,
    ).length,
    1,
  );
  assert.equal(
    dynamo.items.has("HOSTED_ROLE_SWITCHING|RUN#12345#ATTEMPT#2"),
    false,
  );
});

test("persona cleanup rejects tampered primary persona entities before any transaction", async (t) => {
  const cases = [
    ["agent", (item) => {
      item.lastTestedBySubject = { S: "foreign-actor" };
    }],
    ["deployment", (item) => {
      item.updatedAt = { S: "not-a-timestamp" };
    }],
    ["approval", (item) => {
      item.requestedAt = { S: "not-a-timestamp" };
    }],
    ["entitlement", (item) => {
      item.revokedBySubject = { S: "foreign-actor" };
    }],
    ["session", (item) => {
      item.updatedAt = { S: "not-a-timestamp" };
    }],
    ["invocation", (item) => {
      item.payloadFingerprint = { S: "0".repeat(64) };
    }],
    ["feedback", (item) => {
      item.id = { S: "feedback-foreign" };
    }],
  ];

  for (const [name, tamper] of cases) {
    await t.test(name, async () => {
      const { createHostedAcceptanceBrokerService } = await loadService();
      const { dynamo, service } = fixtureService(
        createHostedAcceptanceBrokerService,
      );
      await service.persistPersonaJourneyFixture({
        actors: PERSONA_ACTORS,
        domainId: EXPERIENCE_DOMAIN_ID,
        ownership: OWNERSHIP,
      });
      const items = primaryPersonaItems();
      tamper(items[name]);
      for (const item of Object.values(items)) {
        dynamo.items.set(dynamoKey(item), structuredClone(item));
      }
      dynamo.commands.length = 0;

      await assert.rejects(
        service.cleanupPersonaJourneyFixture({ ownership: OWNERSHIP }),
        /cleanup failed/i,
      );
      assert.equal(
        dynamo.commands.some(
          (command) => command instanceof TransactWriteItemsCommand,
        ),
        false,
      );
    });
  }
});

test("persona cleanup rejects tampered mutation, claim, and audit ownership before any transaction", async (t) => {
  const requests = personaRequestIds();
  const claim = {
    pk: { S: `MUTATION#${ACTOR}` },
    sk: {
      S:
        "CLAIM#POST /api/agents/{id}/test#"
        + requests.builderTestAgent,
    },
    entityType: { S: "MUTATION_CLAIM" },
    actor: { S: ACTOR },
    requesterSubject: { S: ACTOR },
    effectiveRole: { S: "builder" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: PERSONA_PROJECT_ID },
    route: { S: "POST /api/agents/{id}/test" },
    requestId: { S: requests.builderTestAgent },
    payloadFingerprint: {
      S: fingerprint({
        agentRef: {
          domainId: EXPERIENCE_DOMAIN_ID,
          projectId: PERSONA_PROJECT_ID,
          agentId: PERSONA_AGENT_ID,
        },
        prompt: "Confirm this acceptance agent is ready.",
        maxTokens: 128,
      }),
    },
    resourceKey: {
      S:
        `agent/${EXPERIENCE_DOMAIN_ID}/${PERSONA_PROJECT_ID}/`
        + PERSONA_AGENT_ID,
    },
    operation: { S: "UPDATE" },
    createdAt: { S: PERSONA_TIMESTAMP },
  };
  const cases = [
    ["mutation", (items) => {
      items.mutation.requesterSubject = { S: "foreign-actor" };
    }],
    ["claim", (items) => {
      items.claim.operation = { S: "DELETE" };
    }],
    ["audit", (items) => {
      items.audit.action = { S: "agent.delete" };
    }],
  ];

  for (const [name, tamper] of cases) {
    await t.test(name, async () => {
      const { createHostedAcceptanceBrokerService } = await loadService();
      const { dynamo, service } = fixtureService(
        createHostedAcceptanceBrokerService,
      );
      await service.persistPersonaJourneyFixture({
        actors: PERSONA_ACTORS,
        domainId: EXPERIENCE_DOMAIN_ID,
        ownership: OWNERSHIP,
      });
      const mutationFixture = builderCreateMutationFixture();
      const items = {
        ...mutationFixture,
        claim: structuredClone(claim),
      };
      tamper(items);
      for (const item of Object.values(items)) {
        dynamo.items.set(dynamoKey(item), structuredClone(item));
      }
      dynamo.commands.length = 0;

      await assert.rejects(
        service.cleanupPersonaJourneyFixture({ ownership: OWNERSHIP }),
        /cleanup failed/i,
      );
      assert.equal(
        dynamo.commands.some(
          (command) => command instanceof TransactWriteItemsCommand,
        ),
        false,
      );
    });
  }
});

test("agent-building cleanup discovers exact mutation pointers and verifies bounded deletion", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const fixtures = agentBuildingItems();
  const dynamo = fixtureDynamo([
    activeDomainItem(),
    ...fixtures.all,
  ]);
  const { service } = fixtureService(
    createHostedAcceptanceBrokerService,
    { dynamo },
  );

  assert.deepEqual(await service.cleanupAgentBuildingJourneyFixtures({
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  }), { ok: true });

  for (const item of fixtures.all) {
    assert.equal(dynamo.items.has(dynamoKey(item)), false);
  }
  const transactionIndex = dynamo.commands.findIndex(
    (command) => command instanceof TransactWriteItemsCommand,
  );
  assert.notEqual(transactionIndex, -1);
  const transaction = dynamo.commands[transactionIndex];
  assert.equal(transaction.input.TransactItems.length, 13);
  assert.ok(transaction.input.TransactItems.every(({ Delete }) =>
    Delete?.TableName === TABLE
    && Delete.ConditionExpression.includes("#entityType = :entityType")
    && Object.keys(Delete.ExpressionAttributeValues).length
      === Object.keys(
        fixtures.all.find((item) =>
          dynamoKey(item) === dynamoKey(Delete.Key)
        ),
      ).length
  ));
  const stagedReads = dynamo.commands.slice(0, transactionIndex)
    .filter((command) => command instanceof GetItemCommand)
    .map((command) => command.input.Key);
  assert.deepEqual(
    stagedReads.slice(0, AGENT_BUILDING_FIXTURES.length),
    AGENT_BUILDING_FIXTURES.map((spec) => ({
      pk: { S: `MUTATION#${ACTOR}` },
      sk: {
        S:
          `JOURNEY#${spec.operation}#`
          + agentBuildingRequestId(spec.name),
      },
    })),
  );
  assert.deepEqual(
    stagedReads.slice(AGENT_BUILDING_FIXTURES.length)
      .map(dynamoKey)
      .sort(),
    Object.values(fixtures.resources).map(dynamoKey).sort(),
  );
  assert.deepEqual(
    dynamo.commands.slice(transactionIndex + 1)
      .filter((command) => command instanceof GetItemCommand)
      .map((command) => dynamoKey(command.input.Key))
      .sort(),
    fixtures.all.map(dynamoKey).sort(),
  );
});

test("agent-building cleanup tolerates empty and partial prior runs", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const empty = fixtureService(createHostedAcceptanceBrokerService);
  assert.deepEqual(
    await empty.service.cleanupAgentBuildingJourneyFixtures({
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    }),
    { ok: true },
  );
  assert.equal(
    empty.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );

  const mutation = agentBuildingMutation(AGENT_BUILDING_FIXTURES[0]);
  const dynamo = fixtureDynamo([activeDomainItem(), mutation]);
  const partial = fixtureService(
    createHostedAcceptanceBrokerService,
    { dynamo },
  );
  assert.deepEqual(
    await partial.service.cleanupAgentBuildingJourneyFixtures({
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    }),
    { ok: true },
  );
  assert.equal(dynamo.items.has(dynamoKey(mutation)), false);
  assert.equal(
    dynamo.commands.find(
      (command) => command instanceof TransactWriteItemsCommand,
    ).input.TransactItems.length,
    1,
  );
});

test("agent-building cleanup removes exact in-progress claims and their bounded resources", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const spec = AGENT_BUILDING_FIXTURES[0];
  const mutation = agentBuildingMutation(spec, {
    status: { S: "IN_PROGRESS" },
    result: { NULL: true },
  });
  const resource = agentBuildingResource(
    AGENT_BUILDING_RESOURCES.minimalJourney,
  );
  const dynamo = fixtureDynamo([
    activeDomainItem(),
    mutation,
    resource,
  ]);
  const { service } = fixtureService(
    createHostedAcceptanceBrokerService,
    { dynamo },
  );

  assert.deepEqual(
    await service.cleanupAgentBuildingJourneyFixtures({
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    }),
    { ok: true },
  );
  assert.equal(dynamo.items.has(dynamoKey(mutation)), false);
  assert.equal(dynamo.items.has(dynamoKey(resource)), false);
});

test("agent-building cleanup rejects mutation and resource ownership mismatches", async (t) => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const spec = AGENT_BUILDING_FIXTURES[0];
  const requestId = agentBuildingRequestId(spec.name);
  const mutationMismatches = {
    actor: { actor: { S: "foreign-actor" } },
    domain: { domainId: { S: "finance" } },
    operation: { operation: { S: "CREATE_PREVIEW" } },
    request: { requestId: { S: deterministicUuid("foreign-request") } },
    status: { status: { S: "FAILED" } },
    inProgressResult: {
      status: { S: "IN_PROGRESS" },
      result: {
        M: {
          resourceType: { S: "JOURNEY" },
          resourceId: {
            S: AGENT_BUILDING_RESOURCES.minimalJourney.id,
          },
        },
      },
    },
    resourceType: { resourceType: { S: "DELIVERY" } },
    result: {
      result: {
        M: {
          resourceType: { S: "JOURNEY" },
          resourceId: { S: "foreign-resource" },
        },
      },
    },
  };
  for (const [name, overrides] of Object.entries(mutationMismatches)) {
    await t.test(name, async () => {
      const mutation = agentBuildingMutation(spec, overrides);
      const dynamo = fixtureDynamo([activeDomainItem(), mutation]);
      const { service } = fixtureService(
        createHostedAcceptanceBrokerService,
        { dynamo },
      );
      await assert.rejects(
        service.cleanupAgentBuildingJourneyFixtures({
          actor: ACTOR,
          domainId: EXPERIENCE_DOMAIN_ID,
          ownership: OWNERSHIP,
        }),
        /cleanup failed/i,
      );
      assert.equal(
        dynamo.commands.some(
          (command) => command instanceof TransactWriteItemsCommand,
        ),
        false,
      );
      assert.equal(
        mutation.sk.S,
        `JOURNEY#${spec.operation}#${requestId}`,
      );
    });
  }

  for (const [name, tamper] of [
    ["actor", (item) => { item.actor = { S: "foreign-actor" }; }],
    ["domain", (item) => { item.domainId = { S: "finance" }; }],
    ["preset", (item) => { item.preset = { S: "SPEC" }; }],
    [
      "repository",
      (item) => {
        item.record.M.repositoryName = { S: "foreign-repository" };
      },
    ],
  ]) {
    await t.test(`resource ${name}`, async () => {
      const mutation = agentBuildingMutation(spec);
      const resource = agentBuildingResource(
        AGENT_BUILDING_RESOURCES.minimalJourney,
      );
      tamper(resource);
      const dynamo = fixtureDynamo([
        activeDomainItem(),
        mutation,
        resource,
      ]);
      const { service } = fixtureService(
        createHostedAcceptanceBrokerService,
        { dynamo },
      );
      await assert.rejects(
        service.cleanupAgentBuildingJourneyFixtures({
          actor: ACTOR,
          domainId: EXPERIENCE_DOMAIN_ID,
          ownership: OWNERSHIP,
        }),
        /cleanup failed/i,
      );
      assert.equal(
        dynamo.commands.some(
          (command) => command instanceof TransactWriteItemsCommand,
        ),
        false,
      );
    });
  }
});

test("agent-building cleanup preserves a replacement that loses the exact delete condition", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const mutation = agentBuildingMutation(AGENT_BUILDING_FIXTURES[0]);
  const resource = agentBuildingResource(
    AGENT_BUILDING_RESOURCES.minimalJourney,
  );
  const dynamo = fixtureDynamo([
    activeDomainItem(),
    mutation,
    resource,
  ]);
  const send = dynamo.send.bind(dynamo);
  dynamo.send = async (command) => {
    if (command instanceof TransactWriteItemsCommand) {
      dynamo.items.get(dynamoKey(resource)).status = { S: "CONTRACT_READY" };
    }
    return send(command);
  };
  const { service } = fixtureService(
    createHostedAcceptanceBrokerService,
    { dynamo },
  );

  await assert.rejects(
    service.cleanupAgentBuildingJourneyFixtures({
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    }),
    /cleanup failed/i,
  );
  assert.equal(dynamo.items.has(dynamoKey(mutation)), true);
  assert.equal(dynamo.items.has(dynamoKey(resource)), true);
});

function fixtureService(createHostedAcceptanceBrokerService, {
  dynamo = fixtureDynamo(),
  runtimeControl = readyRuntimeControl(),
} = {}) {
  return {
    dynamo,
    runtimeControl,
    service: createHostedAcceptanceBrokerService({
      accountId: ACCOUNT,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      region: REGION,
      platformStateTableName: TABLE,
      registryClient: {
        async send() {
          throw new Error("unexpected registry");
        },
      },
      dynamoClient: dynamo,
      runtimeControl,
    }),
  };
}

function record(status = "PENDING_APPROVAL") {
  return {
    registryArn: FIXTURE_REGISTRY_ARN,
    recordId: RECORD_ID,
    recordArn: RECORD_ARN,
    name: OWNERSHIP.registryRecordName,
    displayName: OWNERSHIP.registryDisplayName,
    description: OWNERSHIP.registryDescription,
    recordType: "CUSTOM",
    recordVersion: OWNERSHIP.registryVersion,
    status,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    descriptors: {
      custom: {
        data: JSON.stringify(OWNERSHIP.registryDescriptor),
      },
    },
  };
}

function recordSummary(status = "PENDING_APPROVAL") {
  const {
    descriptors: _descriptors,
    ...summary
  } = record(status);
  return summary;
}

function domain() {
  return {
    id: OWNERSHIP.domainId,
    name: OWNERSHIP.domainName,
    owner: `${OWNERSHIP.domainName} domain team`,
    ownerGroup: OWNERSHIP.ownerGroup,
    description: `${OWNERSHIP.domainName} domain agents.`,
    tokenBudget: null,
    registryId: DOMAIN_REGISTRY_ID,
    registryArn: DOMAIN_REGISTRY_ARN,
    status: "ACTIVE",
    createdBy: ACTOR,
    createdAt: "2026-08-23T00:00:00.000Z",
  };
}

function cleanupLeaseKey() {
  return {
    pk: { S: "HOSTED_ROLE_SWITCHING" },
    sk: {
      S: "CLEANUP_LEASE#RUN#12345#ATTEMPT#2",
    },
  };
}

function hostedDomainItem() {
  return Object.fromEntries(
    Object.entries({
      pk: "DOMAIN",
      sk: `DOMAIN#${OWNERSHIP.domainId}`,
      entityType: "DOMAIN",
      ...domain(),
    }).map(([name, value]) => [
      name,
      value === null
        ? { NULL: true }
        : typeof value === "number"
          ? { N: String(value) }
          : { S: value },
    ]),
  );
}

function hostedDomainRequestItem() {
  return {
    pk: { S: `REQUEST#${ACTOR}` },
    sk: {
      S: `REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
    },
    actor: { S: ACTOR },
    route: { S: "POST /api/domain-create" },
    requestId: { S: OWNERSHIP.requestIds.domain },
  };
}

function hostedActorMappingItem() {
  return {
    pk: { S: "HOSTED_ACCEPTANCE" },
    sk: { S: "RUN#12345#ATTEMPT#2" },
    entityType: { S: "HOSTED_ACCEPTANCE_RUN" },
    runId: { S: "12345" },
    runAttempt: { S: "2" },
    actor: { S: ACTOR },
    domainId: { S: OWNERSHIP.domainId },
    domainRequestId: { S: OWNERSHIP.requestIds.domain },
    registryRequestId: { S: OWNERSHIP.requestIds.registry },
    managedBy: { S: "hosted-acceptance" },
    project: { S: "agentic-ai-platform-demo" },
  };
}

function conditionalFailure() {
  return Object.assign(new Error("condition failed"), {
    name: "ConditionalCheckFailedException",
    code: "ConditionalCheckFailedException",
  });
}

function conditionMatches(item, input) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const equality = [
    ...input.ConditionExpression.matchAll(
      /([#A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)/g,
    ),
  ];
  return equality.every(([, nameToken, valueToken]) => {
    const name = names[nameToken] ?? nameToken;
    return isDeepStrictEqual(item?.[name], values[valueToken]);
  });
}

function cleanupLeaseDynamo({ existingLease } = {}) {
  const items = new Map([
    [dynamoKey(hostedDomainItem()), hostedDomainItem()],
    [dynamoKey(hostedDomainRequestItem()), hostedDomainRequestItem()],
    [dynamoKey(hostedActorMappingItem()), hostedActorMappingItem()],
    ...(existingLease === undefined
      ? []
      : [[dynamoKey(cleanupLeaseKey()), structuredClone(existingLease)]]),
  ]);
  return {
    commands: [],
    items,
    async send(command) {
      this.commands.push(command);
      if (command instanceof GetItemCommand) {
        const item = items.get(dynamoKey(command.input.Key));
        return item === undefined ? {} : { Item: structuredClone(item) };
      }
      if (
        command instanceof PutItemCommand
        && dynamoKey(command.input.Item) === dynamoKey(cleanupLeaseKey())
      ) {
        const key = dynamoKey(command.input.Item);
        const existing = items.get(key);
        const renewal =
          command.input.ExpressionAttributeValues
            ?.[":cleanupExecutionToken"] !== undefined;
        if (existing !== undefined) {
          const expected = command.input.ExpressionAttributeValues;
          const exactOwner = [
            ["actor", ":leaseActor"],
            ["domainId", ":leaseDomainId"],
            ["domainRequestId", ":leaseDomainRequestId"],
            ["entityType", ":leaseEntityType"],
            ["managedBy", ":leaseManagedBy"],
            ["operationToken", ":leaseOperationToken"],
            ["ownerGroup", ":leaseOwnerGroup"],
            ["project", ":leaseProject"],
            ["registryRequestId", ":leaseRegistryRequestId"],
            ["runAttempt", ":leaseRunAttempt"],
            ["runId", ":leaseRunId"],
          ].every(([attribute, placeholder]) =>
            isDeepStrictEqual(existing[attribute], expected[placeholder])
          );
          if (renewal) {
            const exactExecution =
              existing.cleanupExecutionToken?.S
                === expected[":cleanupExecutionToken"]?.S
              && isDeepStrictEqual(
                existing.leaseExpiresAt,
                expected[":previousLeaseExpiresAt"],
              );
            const unexpired =
              Number(existing.leaseExpiresAt?.N)
                > Number(expected[":leaseNow"]?.N);
            if (!exactOwner || !exactExecution || !unexpired) {
              throw conditionalFailure();
            }
          } else {
            const expired =
              Number(existing.leaseExpiresAt?.N)
                <= Number(expected[":leaseNow"]?.N);
            if (!exactOwner || !expired) throw conditionalFailure();
          }
        } else if (renewal) {
          throw conditionalFailure();
        }
        items.set(key, structuredClone(command.input.Item));
        return {};
      }
      if (command instanceof DeleteItemCommand) {
        const key = dynamoKey(command.input.Key);
        const existing = items.get(key);
        if (key === dynamoKey(cleanupLeaseKey())) {
          if (
            existing === undefined
            || existing.cleanupExecutionToken?.S
              !== command.input.ExpressionAttributeValues
                ?.[":cleanupExecutionToken"]?.S
          ) {
            throw conditionalFailure();
          }
        }
        if (
          existing !== undefined
          && command.input.ConditionExpression !== undefined
          && !conditionMatches(existing, command.input)
        ) {
          throw conditionalFailure();
        }
        items.delete(key);
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  };
}

test("broker service creates and submits one exact tagged fixture without broad listing", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  let recordReads = 0;
  const registry = {
    async send(command) {
      calls.push(command);
      if (command instanceof CreateRegistryRecordCommand) {
        return { recordArn: RECORD_ARN };
      }
      if (command instanceof GetRegistryRecordCommand) {
        recordReads += 1;
        return record(recordReads === 1 ? "DRAFT" : "PENDING_APPROVAL");
      }
      if (command instanceof SubmitRegistryRecordForApprovalCommand) return {};
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: OWNERSHIP.tags };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: registry,
    dynamoClient: { async send() { throw new Error("unexpected dynamo"); } },
    runtimeControl: readyRuntimeControl(),
    operationDelay: async () => {},
    pollAttempts: 3,
    pollDelayMs: 0,
  });

  assert.deepEqual(await service.createRegistryFixture({
    ownership: OWNERSHIP,
    registryId: FIXTURE_REGISTRY_ID,
  }), {
    entryId: OWNERSHIP.registryEntryId,
    name: OWNERSHIP.registryRecordName,
    registryId: FIXTURE_REGISTRY_ID,
    registryArn: FIXTURE_REGISTRY_ARN,
    recordId: RECORD_ID,
    recordArn: RECORD_ARN,
    semver: OWNERSHIP.registryVersion,
    status: "PENDING_APPROVAL",
    type: "Blueprint",
  });
  assert.equal(
    calls.some((command) => command instanceof ListRegistryRecordsCommand),
    false,
  );
  assert.deepEqual(calls[0].input.tags, OWNERSHIP.tags);
});

test("broker service recovers one registryRecords fixture when Get omits registryId", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  const registry = {
    async send(command) {
      calls.push(command);
      if (command instanceof ListRegistryRecordsCommand) {
        return {
          registryRecords: [recordSummary()],
        };
      }
      if (command instanceof GetRegistryRecordCommand) return record();
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: OWNERSHIP.tags };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: registry,
    dynamoClient: { async send() { throw new Error("unexpected dynamo"); } },
    runtimeControl: readyRuntimeControl(),
  });

  assert.deepEqual(await service.recoverRegistryFixture({
    ownership: OWNERSHIP,
    registryId: FIXTURE_REGISTRY_ID,
  }), {
    entryId: OWNERSHIP.registryEntryId,
    name: OWNERSHIP.registryRecordName,
    registryId: FIXTURE_REGISTRY_ID,
    registryArn: FIXTURE_REGISTRY_ARN,
    recordId: RECORD_ID,
    recordArn: RECORD_ARN,
    semver: OWNERSHIP.registryVersion,
    status: "PENDING_APPROVAL",
    type: "Blueprint",
  });
  assert.deepEqual(calls[0].input, {
    filters: [{
      name: "name",
      values: [OWNERSHIP.registryRecordName],
    }],
    maxResults: 10,
    registryId: FIXTURE_REGISTRY_ID,
  });
});

test("broker service keeps recovered record ownership bound to exact ARNs", async (t) => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const mismatches = [
    [
      "registryArn",
      `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/OtherReg1234`,
    ],
    [
      "recordArn",
      `${FIXTURE_REGISTRY_ARN}/record/Other1234567`,
    ],
  ];

  for (const [field, value] of mismatches) {
    await t.test(field, async () => {
      const service = createHostedAcceptanceBrokerService({
        accountId: ACCOUNT,
        fixtureRegistryId: FIXTURE_REGISTRY_ID,
        region: REGION,
        platformStateTableName: TABLE,
        registryClient: {
          async send(command) {
            if (command instanceof ListRegistryRecordsCommand) {
              return { registryRecords: [recordSummary()] };
            }
            if (command instanceof GetRegistryRecordCommand) {
              return { ...record(), [field]: value };
            }
            throw new Error(`Unexpected ${command.constructor.name}`);
          },
        },
        dynamoClient: {
          async send() {
            throw new Error("unexpected dynamo");
          },
        },
        runtimeControl: readyRuntimeControl(),
      });

      await assert.rejects(
        service.recoverRegistryFixture({
          ownership: OWNERSHIP,
          registryId: FIXTURE_REGISTRY_ID,
        }),
        /cleanup failed/i,
      );
    });
  }
});

test("broker service rejects ownership mismatches before mutations", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: {
      async send(command) {
        calls.push(command);
        return {};
      },
    },
    dynamoClient: {
      async send(command) {
        calls.push(command);
        return {};
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  await assert.rejects(
    service.persistActorMapping({
      actor: ACTOR,
      ownership: { ...OWNERSHIP, domainId: "other" },
    }),
    /cleanup failed/i,
  );
  assert.equal(calls.length, 0);
});

test("broker service cleanup deletes exact validated resources and never retags or deletes by prefix", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  const domainValue = domain();
  const registryDecisionRequestItem = {
    pk: { S: `REQUEST#${ACTOR}` },
    sk: {
      S: `REQUEST#POST /api/registry-decide#${OWNERSHIP.requestIds.registry}`,
    },
    actor: { S: ACTOR },
    route: { S: "POST /api/registry-decide" },
    requestId: { S: OWNERSHIP.requestIds.registry },
    responseStatus: { N: "200" },
    resultStatus: { S: "APPROVED" },
  };
  const requestItems = new Map([
    [
      `REQUEST#${ACTOR}|REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
      {
        pk: { S: `REQUEST#${ACTOR}` },
        sk: {
          S: `REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
        },
        actor: { S: ACTOR },
        route: { S: "POST /api/domain-create" },
        requestId: { S: OWNERSHIP.requestIds.domain },
      },
    ],
    [
      `REQUEST#${ACTOR}|REQUEST#POST /api/registry-decide#${OWNERSHIP.requestIds.registry}`,
      registryDecisionRequestItem,
    ],
  ]);
  let recordPresent = true;
  let registryPresent = true;
  let domainPresent = true;
  let mappingPresent = true;
  const registry = {
    async send(command) {
      calls.push(command);
      if (command instanceof GetRegistryRecordCommand) {
        return recordPresent ? record() : Promise.reject(
          Object.assign(new Error("missing"), {
            name: "ResourceNotFoundException",
          }),
        );
      }
      if (command instanceof DeleteRegistryRecordCommand) {
        recordPresent = false;
        return {};
      }
      if (command instanceof GetRegistryCommand) {
        return registryPresent
          ? {
              registryId: DOMAIN_REGISTRY_ID,
              registryArn: DOMAIN_REGISTRY_ARN,
              name: `domain_${OWNERSHIP.domainId}`,
              description: `${OWNERSHIP.domainName} domain registry`,
            }
          : Promise.reject(Object.assign(new Error("missing"), {
              name: "ResourceNotFoundException",
            }));
      }
      if (command instanceof ListTagsForResourceCommand) {
        return {
          tags: command.input.resourceArn === DOMAIN_REGISTRY_ARN
            ? {
                "auto-delete": "no",
                managedBy: "hosted-acceptance",
                project: "agentic-ai-platform-demo",
              }
            : OWNERSHIP.tags,
        };
      }
      if (command instanceof DeleteRegistryCommand) {
        registryPresent = false;
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  };
  const dynamo = {
    async send(command) {
      calls.push(command);
      if (command instanceof GetItemCommand) {
        const key = `${command.input.Key.pk.S}|${command.input.Key.sk.S}`;
        if (key === `DOMAIN|DOMAIN#${OWNERSHIP.domainId}`) {
          if (!domainPresent) return {};
          return {
            Item: Object.fromEntries(
              Object.entries({
                pk: "DOMAIN",
                sk: `DOMAIN#${OWNERSHIP.domainId}`,
                entityType: "DOMAIN",
                ...domainValue,
              }).map(([name, value]) => [
                name,
                value === null
                  ? { NULL: true }
                  : typeof value === "number"
                    ? { N: String(value) }
                    : { S: value },
              ]),
            ),
          };
        }
        if (key === `HOSTED_ACCEPTANCE|RUN#12345#ATTEMPT#2`) {
          if (!mappingPresent) return {};
          return {
            Item: {
              pk: { S: "HOSTED_ACCEPTANCE" },
              sk: { S: "RUN#12345#ATTEMPT#2" },
              entityType: { S: "HOSTED_ACCEPTANCE_RUN" },
              runId: { S: "12345" },
              runAttempt: { S: "2" },
              actor: { S: ACTOR },
              domainId: { S: OWNERSHIP.domainId },
              domainRequestId: { S: OWNERSHIP.requestIds.domain },
              registryRequestId: { S: OWNERSHIP.requestIds.registry },
              managedBy: { S: "hosted-acceptance" },
              project: { S: "agentic-ai-platform-demo" },
            },
          };
        }
        return { Item: requestItems.get(key) };
      }
      if (command instanceof DeleteItemCommand) {
        const key = `${command.input.Key.pk.S}|${command.input.Key.sk.S}`;
        if (key === `DOMAIN|DOMAIN#${OWNERSHIP.domainId}`) {
          domainPresent = false;
        }
        if (key === "HOSTED_ACCEPTANCE|RUN#12345#ATTEMPT#2") {
          mappingPresent = false;
        }
        requestItems.delete(key);
        return {};
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: registry,
    dynamoClient: dynamo,
    runtimeControl: readyRuntimeControl(),
    operationDelay: async () => {},
    pollAttempts: 2,
    pollDelayMs: 0,
  });

  await service.cleanupExactResources({
    actor: ACTOR,
    domain: domainValue,
    ownership: OWNERSHIP,
    registryRecord: {
      entryId: OWNERSHIP.registryEntryId,
      name: OWNERSHIP.registryRecordName,
      registryId: FIXTURE_REGISTRY_ID,
      registryArn: FIXTURE_REGISTRY_ARN,
      recordId: RECORD_ID,
      recordArn: RECORD_ARN,
      semver: OWNERSHIP.registryVersion,
      status: "PENDING_APPROVAL",
      type: "Blueprint",
    },
    requestIds: [
      {
        route: "POST /api/domain-create",
        requestId: OWNERSHIP.requestIds.domain,
      },
    ],
  });

  assert.equal(
    calls.some((command) => command.constructor.name === "TagResourceCommand"),
    false,
  );
  assert.equal(
    calls.some((command) =>
      /Scan|BatchWrite|ListRegistries/.test(command.constructor.name)
    ),
    false,
  );
  const deletes = calls.filter((command) =>
    command instanceof DeleteItemCommand
  );
  assert.equal(deletes.length, 3);
  assert.deepEqual(
    deletes.map((command) => command.input.Key),
    [
      {
        pk: { S: "DOMAIN" },
        sk: { S: `DOMAIN#${OWNERSHIP.domainId}` },
      },
      {
        pk: { S: `REQUEST#${ACTOR}` },
        sk: {
          S: `REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
        },
      },
      {
        pk: { S: "HOSTED_ACCEPTANCE" },
        sk: { S: "RUN#12345#ATTEMPT#2" },
      },
    ],
  );
  assert.equal(
    requestItems.has(
      `REQUEST#${ACTOR}|REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
    ),
    false,
  );
  assert.equal(
    requestItems.get(
      `REQUEST#${ACTOR}|REQUEST#POST /api/registry-decide#${OWNERSHIP.requestIds.registry}`,
    ),
    registryDecisionRequestItem,
  );
  assert.equal(
    calls.some((command) =>
      command instanceof GetItemCommand
      && command.input.Key.sk.S
        === `REQUEST#POST /api/registry-decide#${OWNERSHIP.requestIds.registry}`
    ),
    false,
  );
});

test("broker service requires an exact domain directory cleanup capability", async () => {
  const { createHostedAcceptanceBrokerService } = await loadRawService();
  const configuration = {
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: { async send() {} },
    dynamoClient: { async send() {} },
    runtimeControl: readyRuntimeControl(),
  };

  for (const domainDirectory of [
    undefined,
    null,
    {},
    { deleteGroupExact: true },
  ]) {
    assert.throws(
      () => createHostedAcceptanceBrokerService({
        ...configuration,
        domainDirectory,
      }),
      /configuration is invalid/i,
    );
  }
});

test("broker service requires valid cleanup lease dependencies", async () => {
  const { createHostedAcceptanceBrokerService } = await loadRawService();
  const configuration = {
    accountId: ACCOUNT,
    domainDirectory: NOOP_DOMAIN_DIRECTORY,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: { async send() {} },
    dynamoClient: { async send() {} },
    runtimeControl: readyRuntimeControl(),
  };

  for (const invalid of [
    { cleanupClock: null },
    { cleanupClock: 1_000_000 },
    { cleanupExecutionTokenFactory: null },
    { cleanupExecutionTokenFactory: "uuid" },
  ]) {
    assert.throws(
      () => createHostedAcceptanceBrokerService({
        ...configuration,
        ...invalid,
      }),
      /configuration is invalid/i,
    );
  }
});

test("broker cleanup deletes the exact operation-bound owner group before domain resources", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const order = [];
  let registryPresent = true;
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    domainDirectory: {
      async deleteGroupExact(ownerGroup, operationToken) {
        order.push(["group", ownerGroup, operationToken]);
      },
    },
    registryClient: {
      async send(command) {
        if (command instanceof GetRegistryCommand) {
          order.push(["registry-read"]);
          if (!registryPresent) {
            throw Object.assign(new Error("missing"), {
              name: "ResourceNotFoundException",
            });
          }
          return {
            registryId: DOMAIN_REGISTRY_ID,
            registryArn: DOMAIN_REGISTRY_ARN,
            name: `domain_${OWNERSHIP.domainId}`,
            description: `${OWNERSHIP.domainName} domain registry`,
          };
        }
        if (command instanceof ListTagsForResourceCommand) {
          return { tags: OWNERSHIP.tags };
        }
        assert.ok(command instanceof DeleteRegistryCommand);
        order.push(["registry-delete"]);
        registryPresent = false;
        return {};
      },
    },
    dynamoClient: {
      async send(command) {
        if (command instanceof GetItemCommand) {
          order.push(["domain-read"]);
          return {};
        }
        throw new Error(`Unexpected ${command.constructor.name}`);
      },
    },
    runtimeControl: readyRuntimeControl(),
    operationDelay: async () => {},
    pollAttempts: 2,
    pollDelayMs: 0,
  });

  await service.cleanupExactResources({
    actor: ACTOR,
    domain: domain(),
    ownership: OWNERSHIP,
  });

  const groupIndex = order.findIndex(([operation]) =>
    operation === "group"
  );
  assert.deepEqual(order[groupIndex], [
    "group",
    OWNERSHIP.ownerGroup,
    domainGroupOperationToken({
      actor: ACTOR,
      requestId: OWNERSHIP.requestIds.domain,
    }, OWNERSHIP.domainId),
  ]);
  assert.ok(
    groupIndex
      < order.findIndex(([operation]) => operation === "registry-delete"),
  );
});

test("broker cleanup fences every later deletion when exact group cleanup fails", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    domainDirectory: {
      async deleteGroupExact(ownerGroup, operationToken) {
        calls.push(["group", ownerGroup, operationToken]);
        throw new Error("foreign group");
      },
    },
    registryClient: {
      async send(command) {
        calls.push(["registry", command.constructor.name]);
        throw new Error("must not be reached");
      },
    },
    dynamoClient: {
      async send(command) {
        calls.push(["dynamo", command.constructor.name]);
        if (command instanceof GetItemCommand) {
          const key = dynamoKey(command.input.Key);
          if (key === dynamoKey(hostedDomainItem())) {
            return { Item: hostedDomainItem() };
          }
          if (key === dynamoKey(hostedDomainRequestItem())) {
            return { Item: hostedDomainRequestItem() };
          }
          if (key === dynamoKey(hostedActorMappingItem())) {
            return { Item: hostedActorMappingItem() };
          }
          return {};
        }
        throw new Error("must not be reached");
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  await assert.rejects(
    service.cleanupExactResources({
      actor: ACTOR,
      domain: domain(),
      ownership: OWNERSHIP,
      requestIds: [{
        route: "POST /api/domain-create",
        requestId: OWNERSHIP.requestIds.domain,
      }],
    }),
    /cleanup failed/i,
  );
  assert.deepEqual(
    calls.find(([operation]) => operation === "group"),
    [
      "group",
      OWNERSHIP.ownerGroup,
      domainGroupOperationToken({
        actor: ACTOR,
        requestId: OWNERSHIP.requestIds.domain,
      }, OWNERSHIP.domainId),
    ],
  );
  assert.equal(
    calls.some(([operation]) => operation === "registry"),
    false,
  );
  assert.equal(
    calls.some(([, command]) => command === "DeleteItemCommand"),
    false,
  );
});

test("broker cleanup skips a same-name group after all durable evidence is absent", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const groupCalls = [];
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    domainDirectory: {
      async deleteGroupExact(ownerGroup, operationToken) {
        groupCalls.push([ownerGroup, operationToken]);
      },
    },
    registryClient: {
      async send(command) {
        assert.ok(command instanceof GetRegistryCommand);
        throw Object.assign(new Error("missing"), {
          name: "ResourceNotFoundException",
        });
      },
    },
    dynamoClient: {
      async send(command) {
        assert.ok(command instanceof GetItemCommand);
        return {};
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  assert.deepEqual(await service.cleanupExactResources({
    actor: ACTOR,
    domain: domain(),
    ownership: OWNERSHIP,
  }), { ok: true });
  assert.equal(groupCalls.length, 0);
});

test("broker cleanup keeps the group fence when domain and request rows are already absent", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const order = [];
  const mapping = {
    pk: { S: "HOSTED_ACCEPTANCE" },
    sk: { S: "RUN#12345#ATTEMPT#2" },
    entityType: { S: "HOSTED_ACCEPTANCE_RUN" },
    runId: { S: "12345" },
    runAttempt: { S: "2" },
    actor: { S: ACTOR },
    domainId: { S: OWNERSHIP.domainId },
    domainRequestId: { S: OWNERSHIP.requestIds.domain },
    registryRequestId: { S: OWNERSHIP.requestIds.registry },
    managedBy: { S: "hosted-acceptance" },
    project: { S: "agentic-ai-platform-demo" },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    domainDirectory: {
      async deleteGroupExact(ownerGroup, operationToken) {
        order.push(["group", ownerGroup, operationToken]);
      },
    },
    registryClient: {
      async send(command) {
        throw new Error(`Unexpected ${command.constructor.name}`);
      },
    },
    dynamoClient: {
      async send(command) {
        if (command instanceof GetItemCommand) {
          const key = dynamoKey(command.input.Key);
          if (
            key === `DOMAIN|DOMAIN#${OWNERSHIP.domainId}`
            || key
              === `REQUEST#${ACTOR}|REQUEST#POST /api/domain-create#`
                + OWNERSHIP.requestIds.domain
          ) {
            return {};
          }
          if (key === "HOSTED_ACCEPTANCE|RUN#12345#ATTEMPT#2") {
            return { Item: mapping };
          }
        }
        assert.ok(command instanceof DeleteItemCommand);
        order.push(["mapping-delete"]);
        return {};
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  await service.cleanupExactResources({
    actor: ACTOR,
    ownership: OWNERSHIP,
    requestIds: [{
      route: "POST /api/domain-create",
      requestId: OWNERSHIP.requestIds.domain,
    }],
  });

  assert.deepEqual(order, [
    [
      "group",
      OWNERSHIP.ownerGroup,
      domainGroupOperationToken({
        actor: ACTOR,
        requestId: OWNERSHIP.requestIds.domain,
      }, OWNERSHIP.domainId),
    ],
    ["mapping-delete"],
  ]);
});

test("cleanup lease serializes concurrent deletion and preserves a recreated replacement", async () => {
  const { createHostedAcceptanceBrokerService } = await loadRawService();
  const operationToken = domainGroupOperationToken({
    actor: ACTOR,
    requestId: OWNERSHIP.requestIds.domain,
  }, OWNERSHIP.domainId);
  const oldExecutionToken = "11111111-1111-4111-8111-111111111111";
  const executionTokens = [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  const dynamo = cleanupLeaseDynamo({
    existingLease: {
      ...cleanupLeaseKey(),
      actor: { S: ACTOR },
      cleanupExecutionToken: { S: oldExecutionToken },
      domainId: { S: OWNERSHIP.domainId },
      domainRequestId: { S: OWNERSHIP.requestIds.domain },
      entityType: { S: "HOSTED_ROLE_SWITCHING_CLEANUP_LEASE" },
      leaseExpiresAt: { N: "1000" },
      managedBy: { S: "hosted-acceptance" },
      operationToken: { S: operationToken },
      ownerGroup: { S: OWNERSHIP.ownerGroup },
      project: { S: "agentic-ai-platform-demo" },
      registryRequestId: { S: OWNERSHIP.requestIds.registry },
      runAttempt: { S: OWNERSHIP.runAttempt },
      runId: { S: OWNERSHIP.runId },
    },
  });
  let registryPresent = true;
  let registryDeletes = 0;
  const registryClient = {
    async send(command) {
      if (command instanceof GetRegistryCommand) {
        if (!registryPresent) {
          throw Object.assign(new Error("missing"), {
            name: "ResourceNotFoundException",
          });
        }
        return {
          registryId: DOMAIN_REGISTRY_ID,
          registryArn: DOMAIN_REGISTRY_ARN,
          name: `domain_${OWNERSHIP.domainId}`,
          description: `${OWNERSHIP.domainName} domain registry`,
        };
      }
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: OWNERSHIP.tags };
      }
      assert.ok(command instanceof DeleteRegistryCommand);
      registryDeletes += 1;
      registryPresent = false;
      return {};
    },
  };
  let groupState = "original";
  let groupDeletes = 0;
  let releaseWinner;
  let signalWinner;
  const winnerEntered = new Promise((resolve) => {
    signalWinner = resolve;
  });
  const winnerMayContinue = new Promise((resolve) => {
    releaseWinner = resolve;
  });
  const domainDirectory = {
    async deleteGroupExact(ownerGroup, token) {
      assert.equal(ownerGroup, OWNERSHIP.ownerGroup);
      assert.equal(token, operationToken);
      groupDeletes += 1;
      if (groupDeletes === 1) {
        groupState = "replacement";
        signalWinner();
        await winnerMayContinue;
        return;
      }
      groupState = "absent";
    },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    cleanupClock: () => 1_000_000,
    cleanupExecutionTokenFactory: () => executionTokens.shift(),
    domainDirectory,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient,
    dynamoClient: dynamo,
    runtimeControl: readyRuntimeControl(),
    operationDelay: async () => {},
    pollAttempts: 2,
    pollDelayMs: 0,
  });
  const input = {
    actor: ACTOR,
    domain: domain(),
    ownership: OWNERSHIP,
    requestIds: [{
      route: "POST /api/domain-create",
      requestId: OWNERSHIP.requestIds.domain,
    }],
  };

  const winner = service.cleanupExactResources(input);
  await winnerEntered;
  await assert.rejects(
    service.cleanupExactResources(input),
    /cleanup failed/i,
  );
  assert.equal(groupDeletes, 1);
  assert.equal(registryDeletes, 0);
  assert.equal(
    dynamo.items.get(dynamoKey(cleanupLeaseKey()))
      ?.cleanupExecutionToken?.S,
    "22222222-2222-4222-8222-222222222222",
  );

  releaseWinner();
  assert.deepEqual(await winner, { ok: true });
  assert.equal(registryDeletes, 1);
  assert.equal(groupState, "replacement");
  assert.equal(
    dynamo.items.has(dynamoKey(cleanupLeaseKey())),
    false,
  );

  assert.deepEqual(await service.cleanupExactResources(input), {
    ok: true,
  });
  assert.equal(groupDeletes, 1);
  assert.equal(registryDeletes, 1);
  assert.equal(groupState, "replacement");

  const leasePuts = dynamo.commands.filter((command) =>
    command instanceof PutItemCommand
    && dynamoKey(command.input.Item) === dynamoKey(cleanupLeaseKey())
  );
  assert.ok(leasePuts.length > 3);
  assert.equal(
    leasePuts[0].input.Item.leaseExpiresAt.N,
    "1180",
  );
  assert.ok(
    Number(leasePuts[0].input.Item.leaseExpiresAt.N) - 1000 > 120,
  );
  assert.match(
    leasePuts[0].input.ConditionExpression,
    /attribute_not_exists\(pk\).*leaseExpiresAt <= :leaseNow/s,
  );
  assert.deepEqual(
    Object.fromEntries(
      [
        "actor",
        "domainId",
        "domainRequestId",
        "entityType",
        "managedBy",
        "operationToken",
        "ownerGroup",
        "project",
        "registryRequestId",
        "runAttempt",
        "runId",
      ].map((name) => [name, leasePuts[0].input.Item[name]]),
    ),
    {
      actor: { S: ACTOR },
      domainId: { S: OWNERSHIP.domainId },
      domainRequestId: { S: OWNERSHIP.requestIds.domain },
      entityType: { S: "HOSTED_ROLE_SWITCHING_CLEANUP_LEASE" },
      managedBy: { S: "hosted-acceptance" },
      operationToken: { S: operationToken },
      ownerGroup: { S: OWNERSHIP.ownerGroup },
      project: { S: "agentic-ai-platform-demo" },
      registryRequestId: { S: OWNERSHIP.requestIds.registry },
      runAttempt: { S: OWNERSHIP.runAttempt },
      runId: { S: OWNERSHIP.runId },
    },
  );
  const renewals = leasePuts.filter((command) =>
    command.input.ExpressionAttributeValues
      ?.[":cleanupExecutionToken"] !== undefined
  );
  assert.ok(renewals.length >= 5);
  assert.ok(renewals.every((command) =>
    command.input.ConditionExpression.includes(
      "cleanupExecutionToken = :cleanupExecutionToken",
    )
    && command.input.ConditionExpression.includes(
      "leaseExpiresAt > :leaseNow",
    )
    && [
      "actor",
      "domainId",
      "domainRequestId",
      "entityType",
      "managedBy",
      "operationToken",
      "ownerGroup",
      "registryRequestId",
      "runAttempt",
      "runId",
    ].every((name) =>
      command.input.ConditionExpression.includes(
        `${name} = :lease${
          name[0].toUpperCase() + name.slice(1)
        }`,
      )
    )
    && command.input.ConditionExpression.includes(
      "#project = :leaseProject",
    )
    && command.input.ConditionExpression.includes(
      "leaseExpiresAt = :previousLeaseExpiresAt",
    )
  ));
  const mappingDeleteIndex = dynamo.commands.findIndex((command) =>
    command instanceof DeleteItemCommand
    && dynamoKey(command.input.Key)
      === dynamoKey(hostedActorMappingItem())
  );
  const leaseDeleteIndex = dynamo.commands.findIndex((command) =>
    command instanceof DeleteItemCommand
    && dynamoKey(command.input.Key) === dynamoKey(cleanupLeaseKey())
  );
  assert.ok(mappingDeleteIndex >= 0 && mappingDeleteIndex < leaseDeleteIndex);
});

test("cleanup preserves a replaced DynamoDB row and all later evidence", async () => {
  const { createHostedAcceptanceBrokerService } = await loadRawService();
  const dynamo = cleanupLeaseDynamo();
  const domainKey = dynamoKey(hostedDomainItem());
  const replacementName = "Replacement domain";
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    cleanupClock: () => 1_000_000,
    cleanupExecutionTokenFactory: () =>
      "99999999-9999-4999-8999-999999999999",
    domainDirectory: {
      async deleteGroupExact() {
        const replacement = structuredClone(dynamo.items.get(domainKey));
        replacement.name = { S: replacementName };
        dynamo.items.set(domainKey, replacement);
      },
    },
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: {
      async send(command) {
        assert.ok(command instanceof GetRegistryCommand);
        throw Object.assign(new Error("missing"), {
          name: "ResourceNotFoundException",
        });
      },
    },
    dynamoClient: dynamo,
    runtimeControl: readyRuntimeControl(),
  });

  await assert.rejects(
    service.cleanupExactResources({
      actor: ACTOR,
      domain: domain(),
      ownership: OWNERSHIP,
      requestIds: [{
        route: "POST /api/domain-create",
        requestId: OWNERSHIP.requestIds.domain,
      }],
    }),
    /cleanup failed/i,
  );
  assert.equal(dynamo.items.get(domainKey)?.name?.S, replacementName);
  assert.equal(
    dynamo.items.has(dynamoKey(hostedDomainRequestItem())),
    true,
  );
  assert.equal(
    dynamo.items.has(dynamoKey(hostedActorMappingItem())),
    true,
  );
});

test("cleanup fences a late domain commit before removing run evidence", async () => {
  const { createHostedAcceptanceBrokerService } = await loadRawService();
  const dynamo = cleanupLeaseDynamo();
  const domainKey = dynamoKey(hostedDomainItem());
  const requestKey = dynamoKey(hostedDomainRequestItem());
  dynamo.items.delete(domainKey);
  let registryPresent = true;
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    cleanupClock: () => 1_000_000,
    cleanupExecutionTokenFactory: () =>
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    domainDirectory: {
      async deleteGroupExact() {},
    },
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: {
      async send(command) {
        if (command instanceof GetRegistryCommand) {
          if (!registryPresent) {
            throw Object.assign(new Error("missing"), {
              name: "ResourceNotFoundException",
            });
          }
          return {
            registryId: DOMAIN_REGISTRY_ID,
            registryArn: DOMAIN_REGISTRY_ARN,
            name: `domain_${OWNERSHIP.domainId}`,
            description: `${OWNERSHIP.domainName} domain registry`,
          };
        }
        if (command instanceof ListTagsForResourceCommand) {
          return { tags: OWNERSHIP.tags };
        }
        assert.ok(command instanceof DeleteRegistryCommand);
        registryPresent = false;
        dynamo.items.set(domainKey, hostedDomainItem());
        dynamo.items.set(requestKey, {
          ...hostedDomainRequestItem(),
          result: {
            M: {
              kind: { S: "DOMAIN_CREATE" },
              status: { S: "SUCCEEDED" },
            },
          },
        });
        return {};
      },
    },
    dynamoClient: dynamo,
    runtimeControl: readyRuntimeControl(),
    operationDelay: async () => {},
    pollAttempts: 2,
    pollDelayMs: 0,
  });

  assert.deepEqual(await service.cleanupExactResources({
    actor: ACTOR,
    domain: domain(),
    ownership: OWNERSHIP,
    requestIds: [{
      route: "POST /api/domain-create",
      requestId: OWNERSHIP.requestIds.domain,
    }],
  }), { ok: true });
  assert.equal(dynamo.items.has(domainKey), false);
  assert.equal(dynamo.items.has(requestKey), false);
  assert.equal(
    dynamo.items.has(dynamoKey(hostedActorMappingItem())),
    false,
  );
});

test("cleanup lease is conditionally released after destructive failure", async () => {
  const { createHostedAcceptanceBrokerService } = await loadRawService();
  const dynamo = cleanupLeaseDynamo();
  let groupAttempts = 0;
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    cleanupClock: () => 1_000_000,
    cleanupExecutionTokenFactory: () =>
      "55555555-5555-4555-8555-555555555555",
    domainDirectory: {
      async deleteGroupExact() {
        groupAttempts += 1;
        throw new Error("delete failed");
      },
    },
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: {
      async send(command) {
        throw new Error(`Unexpected ${command.constructor.name}`);
      },
    },
    dynamoClient: dynamo,
    runtimeControl: readyRuntimeControl(),
  });

  await assert.rejects(
    service.cleanupExactResources({
      actor: ACTOR,
      domain: domain(),
      ownership: OWNERSHIP,
      requestIds: [{
        route: "POST /api/domain-create",
        requestId: OWNERSHIP.requestIds.domain,
      }],
    }),
    /cleanup failed/i,
  );
  assert.equal(groupAttempts, 1);
  assert.equal(dynamo.items.has(dynamoKey(cleanupLeaseKey())), false);
  const leaseCommands = dynamo.commands.filter((command) =>
    (
      command instanceof PutItemCommand
      && dynamoKey(command.input.Item) === dynamoKey(cleanupLeaseKey())
    )
    || (
      command instanceof DeleteItemCommand
      && dynamoKey(command.input.Key) === dynamoKey(cleanupLeaseKey())
    )
  );
  assert.equal(leaseCommands.length, 3);
  assert.ok(leaseCommands[0] instanceof PutItemCommand);
  assert.ok(leaseCommands[1] instanceof PutItemCommand);
  assert.ok(leaseCommands[2] instanceof DeleteItemCommand);
  assert.equal(
    leaseCommands[2].input.ExpressionAttributeValues
      ?.[":cleanupExecutionToken"]?.S,
    "55555555-5555-4555-8555-555555555555",
  );
});

test("cleanup lease refuses an expired foreign owner without destructive calls", async () => {
  const { createHostedAcceptanceBrokerService } = await loadRawService();
  const dynamo = cleanupLeaseDynamo({
    existingLease: {
      ...cleanupLeaseKey(),
      actor: { S: ACTOR },
      cleanupExecutionToken: {
        S: "66666666-6666-4666-8666-666666666666",
      },
      domainId: { S: OWNERSHIP.domainId },
      domainRequestId: { S: OWNERSHIP.requestIds.domain },
      entityType: { S: "HOSTED_ROLE_SWITCHING_CLEANUP_LEASE" },
      leaseExpiresAt: { N: "999" },
      managedBy: { S: "hosted-acceptance" },
      operationToken: {
        S: domainGroupOperationToken({
          actor: ACTOR,
          requestId: OWNERSHIP.requestIds.domain,
        }, OWNERSHIP.domainId),
      },
      ownerGroup: { S: "domain-foreign-owner" },
      project: { S: "agentic-ai-platform-demo" },
      registryRequestId: { S: OWNERSHIP.requestIds.registry },
      runAttempt: { S: OWNERSHIP.runAttempt },
      runId: { S: OWNERSHIP.runId },
    },
  });
  let destructiveCalls = 0;
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    cleanupClock: () => 1_000_000,
    cleanupExecutionTokenFactory: () =>
      "77777777-7777-4777-8777-777777777777",
    domainDirectory: {
      async deleteGroupExact() {
        destructiveCalls += 1;
      },
    },
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: {
      async send() {
        destructiveCalls += 1;
        return {};
      },
    },
    dynamoClient: dynamo,
    runtimeControl: readyRuntimeControl(),
  });

  await assert.rejects(
    service.cleanupExactResources({
      actor: ACTOR,
      domain: domain(),
      ownership: OWNERSHIP,
      requestIds: [{
        route: "POST /api/domain-create",
        requestId: OWNERSHIP.requestIds.domain,
      }],
    }),
    /cleanup failed/i,
  );
  assert.equal(destructiveCalls, 0);
  assert.equal(
    dynamo.items.get(dynamoKey(cleanupLeaseKey()))
      ?.ownerGroup?.S,
    "domain-foreign-owner",
  );
});

test("broker service recovers an exact retryable domain Registry target", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const requestItem = {
    pk: { S: `REQUEST#${ACTOR}` },
    sk: {
      S: `REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: ACTOR },
    route: { S: "POST /api/domain-create" },
    requestId: { S: OWNERSHIP.requestIds.domain },
    result: {
      M: {
        kind: { S: "DOMAIN_CREATE" },
        status: { S: "FAILED_RETRYABLE" },
        payloadFingerprint: { S: "a".repeat(64) },
        registry: {
          M: {
            registryId: { S: DOMAIN_REGISTRY_ID },
            registryArn: { S: DOMAIN_REGISTRY_ARN },
          },
        },
      },
    },
    expiresAt: { N: "1787719999" },
    createdAt: { S: "2026-08-26T01:00:00.000Z" },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: { async send() { throw new Error("unexpected"); } },
    dynamoClient: {
      async send(command) {
        assert.ok(command instanceof GetItemCommand);
        const key = dynamoKey(command.input.Key);
        if (key === `DOMAIN|DOMAIN#${OWNERSHIP.domainId}`) return {};
        if (
          key
            === `REQUEST#${ACTOR}|REQUEST#POST /api/domain-create#`
              + OWNERSHIP.requestIds.domain
        ) {
          return { Item: requestItem };
        }
        throw new Error(`Unexpected key ${key}`);
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  assert.deepEqual(await service.recoverDomain({
    actor: ACTOR,
    ownership: OWNERSHIP,
  }), {
    createdBy: ACTOR,
    id: OWNERSHIP.domainId,
    name: OWNERSHIP.domainName,
    ownerGroup: OWNERSHIP.ownerGroup,
    registryArn: DOMAIN_REGISTRY_ARN,
    registryId: DOMAIN_REGISTRY_ID,
    status: "ACTIVE",
  });
});

test("broker service recovers an exact in-progress domain Registry target", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const requestItem = {
    pk: { S: `REQUEST#${ACTOR}` },
    sk: {
      S: `REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: ACTOR },
    route: { S: "POST /api/domain-create" },
    requestId: { S: OWNERSHIP.requestIds.domain },
    result: {
      M: {
        kind: { S: "DOMAIN_CREATE" },
        status: { S: "IN_PROGRESS" },
        payloadFingerprint: { S: "a".repeat(64) },
        ownerToken: { S: "123e4567-e89b-42d3-a456-426614174000" },
        claimExpiresAt: { N: "1787719700" },
        registry: {
          M: {
            registryId: { S: DOMAIN_REGISTRY_ID },
            registryArn: { S: DOMAIN_REGISTRY_ARN },
          },
        },
      },
    },
    expiresAt: { N: "1787719999" },
    createdAt: { S: "2026-08-26T01:00:00.000Z" },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: { async send() { throw new Error("unexpected"); } },
    dynamoClient: {
      async send(command) {
        assert.ok(command instanceof GetItemCommand);
        const key = dynamoKey(command.input.Key);
        if (key === `DOMAIN|DOMAIN#${OWNERSHIP.domainId}`) return {};
        if (
          key
            === `REQUEST#${ACTOR}|REQUEST#POST /api/domain-create#`
              + OWNERSHIP.requestIds.domain
        ) {
          return { Item: requestItem };
        }
        throw new Error(`Unexpected key ${key}`);
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  assert.deepEqual(await service.recoverDomain({
    actor: ACTOR,
    ownership: OWNERSHIP,
  }), {
    createdBy: ACTOR,
    id: OWNERSHIP.domainId,
    name: OWNERSHIP.domainName,
    ownerGroup: OWNERSHIP.ownerGroup,
    registryArn: DOMAIN_REGISTRY_ARN,
    registryId: DOMAIN_REGISTRY_ID,
    status: "ACTIVE",
  });
});

test("broker cleanup recovers a pending Registry before deleting request evidence", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  let registryPresent = true;
  let requestPresent = true;
  const requestItem = {
    pk: { S: `REQUEST#${ACTOR}` },
    sk: {
      S: `REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: ACTOR },
    route: { S: "POST /api/domain-create" },
    requestId: { S: OWNERSHIP.requestIds.domain },
    result: {
      M: {
        kind: { S: "DOMAIN_CREATE" },
        status: { S: "FAILED_RETRYABLE" },
        payloadFingerprint: { S: "a".repeat(64) },
        registry: {
          M: {
            registryId: { S: DOMAIN_REGISTRY_ID },
            registryArn: { S: DOMAIN_REGISTRY_ARN },
          },
        },
      },
    },
    expiresAt: { N: "1787719999" },
    createdAt: { S: "2026-08-26T01:00:00.000Z" },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    operationDelay: async () => {},
    pollAttempts: 2,
    pollDelayMs: 0,
    registryClient: {
      async send(command) {
        calls.push(command);
        if (command instanceof GetRegistryCommand) {
          if (!registryPresent) {
            throw Object.assign(new Error("missing"), {
              name: "ResourceNotFoundException",
            });
          }
          return {
            registryId: DOMAIN_REGISTRY_ID,
            registryArn: DOMAIN_REGISTRY_ARN,
            name: `domain_${OWNERSHIP.domainId}`,
            description: `${OWNERSHIP.domainName} domain registry`,
          };
        }
        if (command instanceof ListTagsForResourceCommand) {
          return {
            tags: {
              "auto-delete": "no",
              managedBy: "hosted-acceptance",
              project: "agentic-ai-platform-demo",
            },
          };
        }
        assert.ok(command instanceof DeleteRegistryCommand);
        registryPresent = false;
        return {};
      },
    },
    dynamoClient: {
      async send(command) {
        calls.push(command);
        if (command instanceof GetItemCommand) {
          const key = dynamoKey(command.input.Key);
          if (key === `DOMAIN|DOMAIN#${OWNERSHIP.domainId}`) return {};
          if (
            key
              === `REQUEST#${ACTOR}|REQUEST#POST /api/domain-create#`
                + OWNERSHIP.requestIds.domain
          ) {
            return requestPresent ? { Item: requestItem } : {};
          }
          if (key === `HOSTED_ACCEPTANCE|RUN#12345#ATTEMPT#2`) {
            return {};
          }
          throw new Error(`Unexpected key ${key}`);
        }
        assert.ok(command instanceof DeleteItemCommand);
        requestPresent = false;
        return {};
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  await service.cleanupExactResources({
    actor: ACTOR,
    ownership: OWNERSHIP,
    requestIds: [{
      route: "POST /api/domain-create",
      requestId: OWNERSHIP.requestIds.domain,
    }],
  });

  assert.equal(registryPresent, false);
  assert.equal(requestPresent, false);
  assert.ok(
    calls.findIndex((command) => command instanceof DeleteRegistryCommand)
      < calls.findIndex((command) => command instanceof DeleteItemCommand),
  );
});

test("broker service preserves actor mapping when exact request cleanup fails", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: { async send() { throw new Error("unexpected"); } },
    dynamoClient: {
      async send(command) {
        calls.push(command);
        if (command instanceof GetItemCommand) {
          throw new Error("read failed");
        }
        return {};
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  await assert.rejects(
    service.cleanupExactResources({
      actor: ACTOR,
      ownership: OWNERSHIP,
      requestIds: [{
        route: "POST /api/domain-create",
        requestId: OWNERSHIP.requestIds.domain,
      }],
    }),
    /cleanup failed/i,
  );
  assert.equal(
    calls.some((command) =>
      command instanceof DeleteItemCommand
      && command.input.Key.pk.S === "HOSTED_ACCEPTANCE"
    ),
    false,
  );
});

test("broker service preserves actor mapping when temporary resource cleanup fails", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const calls = [];
  const requestItem = {
    pk: { S: `REQUEST#${ACTOR}` },
    sk: {
      S: `REQUEST#POST /api/domain-create#${OWNERSHIP.requestIds.domain}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: ACTOR },
    route: { S: "POST /api/domain-create" },
    requestId: { S: OWNERSHIP.requestIds.domain },
    result: {
      M: {
        kind: { S: "DOMAIN_CREATE" },
        status: { S: "FAILED_RETRYABLE" },
        payloadFingerprint: { S: "a".repeat(64) },
        registry: {
          M: {
            registryId: { S: DOMAIN_REGISTRY_ID },
            registryArn: { S: DOMAIN_REGISTRY_ARN },
          },
        },
      },
    },
    expiresAt: { N: "1787719999" },
    createdAt: { S: "2026-08-26T01:00:00.000Z" },
  };
  const service = createHostedAcceptanceBrokerService({
    accountId: ACCOUNT,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    region: REGION,
    platformStateTableName: TABLE,
    registryClient: {
      async send(command) {
        calls.push(command);
        throw new Error("registry cleanup failed");
      },
    },
    dynamoClient: {
      async send(command) {
        calls.push(command);
        if (command instanceof GetItemCommand) {
          const key = `${command.input.Key.pk.S}|${command.input.Key.sk.S}`;
          if (
            key
              === `REQUEST#${ACTOR}|REQUEST#POST /api/domain-create#`
                + OWNERSHIP.requestIds.domain
          ) {
            return { Item: requestItem };
          }
          if (key === `HOSTED_ACCEPTANCE|RUN#12345#ATTEMPT#2`) {
            return {
              Item: {
                pk: { S: "HOSTED_ACCEPTANCE" },
                sk: { S: "RUN#12345#ATTEMPT#2" },
                entityType: { S: "HOSTED_ACCEPTANCE_RUN" },
                runId: { S: "12345" },
                runAttempt: { S: "2" },
                actor: { S: ACTOR },
                domainId: { S: OWNERSHIP.domainId },
                domainRequestId: { S: OWNERSHIP.requestIds.domain },
                registryRequestId: { S: OWNERSHIP.requestIds.registry },
                managedBy: { S: "hosted-acceptance" },
                project: { S: "agentic-ai-platform-demo" },
              },
            };
          }
          return {};
        }
        return {};
      },
    },
    runtimeControl: readyRuntimeControl(),
  });

  await assert.rejects(
    service.cleanupExactResources({
      actor: ACTOR,
      domain: domain(),
      ownership: OWNERSHIP,
      requestIds: [{
        route: "POST /api/domain-create",
        requestId: OWNERSHIP.requestIds.domain,
      }],
    }),
    /cleanup failed/i,
  );
  assert.equal(
    calls.some((command) =>
      command instanceof DeleteItemCommand
      && command.input.Key.pk.S === "HOSTED_ACCEPTANCE"
    ),
    false,
  );
  assert.equal(
    calls.some((command) =>
      command instanceof DeleteItemCommand
      && command.input.Key.pk.S === `REQUEST#${ACTOR}`
    ),
    false,
  );
});

test("experience fixture provision atomically writes four schema-compatible records from ownership", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const {
    dynamo,
    runtimeControl,
    service,
  } = fixtureService(createHostedAcceptanceBrokerService);
  const input = {
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  };

  assert.deepEqual(
    await service.provisionExperienceFixture(input),
    EXPERIENCE_FIXTURE,
  );
  assert.deepEqual(runtimeControl.calls, ["PRODUCTION"]);
  const transactions = dynamo.commands.filter(
    (command) => command instanceof TransactWriteItemsCommand,
  );
  assert.equal(transactions.length, 1);
  const writes = transactions[0].input.TransactItems;
  assert.equal(writes.length, 4);
  assert.ok(writes.every((operation) =>
    Object.keys(operation).length === 1
    && operation.Put
    && operation.Put.TableName === TABLE
    && operation.Put.ConditionExpression.includes("attribute_not_exists")
  ));
  assert.deepEqual(
    writes.map((operation) => dynamoKey(operation.Put.Item)),
    [
      `PROJECT#${EXPERIENCE_DOMAIN_ID}|PROJECT#${EXPERIENCE_FIXTURE.projectId}`,
      `AGENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
        + `|AGENT#${EXPERIENCE_FIXTURE.agentId}`,
      `DEPLOYMENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
        + `|DEPLOYMENT#${EXPERIENCE_FIXTURE.deploymentId}`,
      `ENTITLEMENT#${ACTOR}|AGENT#${EXPERIENCE_DOMAIN_ID}`
        + `#${EXPERIENCE_FIXTURE.projectId}#${EXPERIENCE_FIXTURE.agentId}`,
    ],
  );

  const state = createWorkspaceState({
    tableName: TABLE,
    dynamo,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  const project = await state.getProject({
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: EXPERIENCE_FIXTURE.projectId,
  });
  const agent = await state.getAgent({
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: EXPERIENCE_FIXTURE.projectId,
    agentId: EXPERIENCE_FIXTURE.agentId,
  });
  const deployment = await state.getDeployment({
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: EXPERIENCE_FIXTURE.projectId,
    deploymentId: EXPERIENCE_FIXTURE.deploymentId,
  });
  const entitlement = await state.getEntitlement({
    subject: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: EXPERIENCE_FIXTURE.projectId,
    agentId: EXPERIENCE_FIXTURE.agentId,
  });

  assert.deepEqual(project, {
    domainId: EXPERIENCE_DOMAIN_ID,
    id: EXPERIENCE_FIXTURE.projectId,
    name: "Hosted Acceptance 12345 2 Project",
    description:
      "Temporary entitled-agent project for hosted acceptance run 12345 "
      + "attempt 2.",
    ownerSubject: ACTOR,
    memberSubjects: [ACTOR],
    status: "ACTIVE",
    createdBySubject: ACTOR,
    createdAt: project.createdAt,
  });
  assert.equal(new Date(project.createdAt).toISOString(), project.createdAt);
  assert.equal(agent.status, "PRODUCTION_DEPLOYED");
  assert.equal(agent.ownerSubject, ACTOR);
  assert.equal(agent.createdBySubject, ACTOR);
  assert.equal(agent.lastTestStatus, "SUCCEEDED");
  assert.equal(agent.lastTestedBySubject, ACTOR);
  assert.equal(agent.lastTestModelId, agent.modelId);
  assert.equal(agent.lastTestInputTokens, 1);
  assert.equal(agent.lastTestOutputTokens, 1);
  assert.match(agent.lastTestEvidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(agent.createdAt, project.createdAt);
  assert.equal(agent.updatedAt, project.createdAt);
  assert.equal(agent.lastTestedAt, project.createdAt);
  assert.deepEqual(deployment, {
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: EXPERIENCE_FIXTURE.projectId,
    id: EXPERIENCE_FIXTURE.deploymentId,
    agentId: EXPERIENCE_FIXTURE.agentId,
    environment: "PRODUCTION",
    status: "DEPLOYED",
    requesterSubject: ACTOR,
    approverSubject: "hosted-approver-12345-2",
    decisionReason:
      "Hosted acceptance production approval for run 12345 attempt 2.",
    requestedAt: project.createdAt,
    decidedAt: project.createdAt,
    ...RUNTIME_IDENTITY,
    updatedAt: project.createdAt,
  });
  assert.deepEqual(entitlement, {
    subject: ACTOR,
    agentId: EXPERIENCE_FIXTURE.agentId,
    domainId: EXPERIENCE_DOMAIN_ID,
    projectId: EXPERIENCE_FIXTURE.projectId,
    status: "ACTIVE",
    grantedBySubject: "hosted-approver-12345-2",
    grantedAt: project.createdAt,
    revokedBySubject: null,
    revokedAt: null,
  });

  const firstItems = writes.map((operation) => operation.Put.Item);
  dynamo.commands.length = 0;
  assert.deepEqual(
    await service.provisionExperienceFixture(input),
    EXPERIENCE_FIXTURE,
  );
  const repeatedTransactions = dynamo.commands.filter(
    (command) => command instanceof TransactWriteItemsCommand,
  );
  assert.equal(repeatedTransactions.length, 1);
  assert.deepEqual(
    repeatedTransactions[0].input.TransactItems
      .map((operation) => operation.Put.Item),
    firstItems,
  );
  const recoveryReads = dynamo.commands.filter(
    (command) => command instanceof GetItemCommand,
  );
  assert.equal(recoveryReads.length, 5);
  assert.equal(
    recoveryReads.filter((command) =>
      command.input.ConsistentRead === true
    ).length,
    5,
  );
  assert.equal(
    dynamo.commands.some((command) =>
      /Scan|Query|BatchWrite/.test(command.constructor.name)
    ),
    false,
  );
});

test("experience fixture provision never overwrites a foreign superset", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const configured = fixtureService(createHostedAcceptanceBrokerService);
  const input = {
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  };
  await configured.service.provisionExperienceFixture(input);
  const projectKey =
    `PROJECT#${EXPERIENCE_DOMAIN_ID}|PROJECT#${EXPERIENCE_FIXTURE.projectId}`;
  const foreignProject = configured.dynamo.items.get(projectKey);
  foreignProject.foreignMarker = { S: "must-remain" };
  const before = structuredClone(foreignProject);
  configured.dynamo.commands.length = 0;

  await assert.rejects(
    configured.service.provisionExperienceFixture(input),
    /cleanup failed/i,
  );

  assert.deepEqual(configured.dynamo.items.get(projectKey), before);
  assert.equal(
    configured.dynamo.commands.filter(
      (command) => command instanceof TransactWriteItemsCommand,
    ).length,
    1,
  );
  assert.equal(
    configured.dynamo.commands.filter(
      (command) => command instanceof GetItemCommand,
    ).length,
    5,
  );
});

test("experience fixture provision rejects caller-controlled identity and inactive domains before writes", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const active = fixtureService(createHostedAcceptanceBrokerService);
  for (const input of [
    {
      actor: "actor with spaces",
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    },
    {
      actor: ACTOR,
      domainId: "Customer_support",
      ownership: OWNERSHIP,
    },
    {
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: { ...OWNERSHIP, runAttempt: "3" },
    },
    {
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
      projectId: "caller-controlled",
    },
  ]) {
    await assert.rejects(
      active.service.provisionExperienceFixture(input),
      /cleanup failed/i,
    );
  }
  assert.equal(active.dynamo.commands.length, 0);
  assert.equal(active.runtimeControl.calls.length, 0);

  for (const initialItems of [
    [],
    [activeDomainItem(EXPERIENCE_DOMAIN_ID, "SUSPENDED")],
  ]) {
    const configured = fixtureService(
      createHostedAcceptanceBrokerService,
      { dynamo: fixtureDynamo(initialItems) },
    );
    await assert.rejects(
      configured.service.provisionExperienceFixture({
        actor: ACTOR,
        domainId: EXPERIENCE_DOMAIN_ID,
        ownership: OWNERSHIP,
      }),
      /cleanup failed/i,
    );
    assert.equal(
      configured.dynamo.commands.some(
        (command) => command instanceof TransactWriteItemsCommand,
      ),
      false,
    );
    assert.equal(configured.runtimeControl.calls.length, 0);
  }
});

test("experience fixture recovery uses four exact reads and fails closed on absent, partial, or foreign state", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const input = {
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  };
  const absent = fixtureService(
    createHostedAcceptanceBrokerService,
    { dynamo: fixtureDynamo([]) },
  );
  assert.equal(await absent.service.recoverExperienceFixture(input), null);
  assert.equal(
    absent.dynamo.commands.filter(
      (command) => command instanceof GetItemCommand,
    ).length,
    4,
  );
  assert.equal(absent.runtimeControl.calls.length, 0);

  const configured = fixtureService(createHostedAcceptanceBrokerService);
  await configured.service.provisionExperienceFixture(input);
  configured.dynamo.commands.length = 0;
  configured.runtimeControl.calls.length = 0;
  configured.runtimeControl.resolveEndpoint = async () => {
    throw new Error("Runtime changed after fixture provision.");
  };
  assert.deepEqual(
    await configured.service.recoverExperienceFixture(input),
    EXPERIENCE_FIXTURE,
  );
  assert.deepEqual(
    configured.dynamo.commands.map((command) => dynamoKey(command.input.Key)),
    [
      `PROJECT#${EXPERIENCE_DOMAIN_ID}|PROJECT#${EXPERIENCE_FIXTURE.projectId}`,
      `AGENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
        + `|AGENT#${EXPERIENCE_FIXTURE.agentId}`,
      `DEPLOYMENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
        + `|DEPLOYMENT#${EXPERIENCE_FIXTURE.deploymentId}`,
      `ENTITLEMENT#${ACTOR}|AGENT#${EXPERIENCE_DOMAIN_ID}`
        + `#${EXPERIENCE_FIXTURE.projectId}#${EXPERIENCE_FIXTURE.agentId}`,
    ],
  );
  assert.deepEqual(configured.runtimeControl.calls, []);

  const entitlementKey =
    `ENTITLEMENT#${ACTOR}|AGENT#${EXPERIENCE_DOMAIN_ID}`
    + `#${EXPERIENCE_FIXTURE.projectId}#${EXPERIENCE_FIXTURE.agentId}`;
  configured.dynamo.items.delete(entitlementKey);
  configured.dynamo.commands.length = 0;
  configured.runtimeControl.calls.length = 0;
  await assert.rejects(
    configured.service.recoverExperienceFixture(input),
    /cleanup failed/i,
  );
  assert.equal(
    configured.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
  assert.equal(configured.runtimeControl.calls.length, 0);

  const foreign = fixtureService(createHostedAcceptanceBrokerService);
  await foreign.service.provisionExperienceFixture(input);
  const agentKey =
    `AGENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
    + `|AGENT#${EXPERIENCE_FIXTURE.agentId}`;
  foreign.dynamo.items.get(agentKey).description.S = "Foreign content.";
  foreign.dynamo.commands.length = 0;
  await assert.rejects(
    foreign.service.recoverExperienceFixture(input),
    /cleanup failed/i,
  );
  assert.equal(
    foreign.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
});

test("experience fixture recovery discovers one exact domain from the immutable actor partition", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const configured = fixtureService(createHostedAcceptanceBrokerService);
  const input = {
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  };
  await configured.service.provisionExperienceFixture(input);
  configured.dynamo.commands.length = 0;

  assert.deepEqual(
    await configured.service.recoverExperienceFixture({
      actor: ACTOR,
      ownership: OWNERSHIP,
    }),
    EXPERIENCE_FIXTURE,
  );
  const queries = configured.dynamo.commands.filter(
    (command) => command instanceof QueryCommand,
  );
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].input, {
    TableName: TABLE,
    ConsistentRead: true,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: {
      "#pk": "pk",
    },
    ExpressionAttributeValues: {
      ":pk": { S: `ENTITLEMENT#${ACTOR}` },
    },
  });
  assert.equal(
    configured.dynamo.commands.filter(
      (command) => command instanceof GetItemCommand,
    ).length,
    4,
  );
  assert.equal(
    configured.dynamo.commands.some((command) =>
      /Scan|BatchWrite/.test(command.constructor.name)
    ),
    false,
  );
});

test("experience fixture recovery selects the exact fixture among valid entitlements", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const configured = fixtureService(createHostedAcceptanceBrokerService);
  const input = {
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  };
  await configured.service.provisionExperienceFixture(input);
  const personaEntitlement = {
    pk: { S: `ENTITLEMENT#${ACTOR}` },
    sk: {
      S:
        `AGENT#${EXPERIENCE_DOMAIN_ID}#hosted-project-12345-2`
        + "#acceptance-agent-12345-2",
    },
    entityType: { S: "ENTITLEMENT" },
    subject: { S: ACTOR },
    agentId: { S: "acceptance-agent-12345-2" },
    domainId: { S: EXPERIENCE_DOMAIN_ID },
    projectId: { S: "hosted-project-12345-2" },
    status: { S: "ACTIVE" },
    grantedBySubject: { S: PERSONA_ACTORS.reviewer },
    grantedAt: { S: "2026-08-26T01:00:00.000Z" },
    revokedBySubject: { NULL: true },
    revokedAt: { NULL: true },
  };
  configured.dynamo.items.set(
    dynamoKey(personaEntitlement),
    personaEntitlement,
  );
  configured.dynamo.commands.length = 0;

  assert.deepEqual(
    await configured.service.recoverExperienceFixture({
      actor: ACTOR,
      ownership: OWNERSHIP,
    }),
    EXPERIENCE_FIXTURE,
  );
});

test("experience fixture recovery fails closed on ambiguous or malformed fixture candidates", async (t) => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const candidate = (domainId, overrides = {}) => ({
    pk: { S: `ENTITLEMENT#${ACTOR}` },
    sk: {
      S:
        `AGENT#${domainId}#${EXPERIENCE_FIXTURE.projectId}`
        + `#${EXPERIENCE_FIXTURE.agentId}`,
    },
    entityType: { S: "ENTITLEMENT" },
    subject: { S: ACTOR },
    agentId: { S: EXPERIENCE_FIXTURE.agentId },
    domainId: { S: domainId },
    projectId: { S: EXPERIENCE_FIXTURE.projectId },
    status: { S: "ACTIVE" },
    grantedBySubject: { S: "hosted-approver" },
    grantedAt: { S: "2026-08-26T01:00:00.000Z" },
    revokedBySubject: { NULL: true },
    revokedAt: { NULL: true },
    ...overrides,
  });

  await t.test("ambiguous candidates", async () => {
    const configured = fixtureService(createHostedAcceptanceBrokerService);
    await configured.service.provisionExperienceFixture({
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    });
    const ambiguous = candidate("operations");
    configured.dynamo.items.set(dynamoKey(ambiguous), ambiguous);
    await assert.rejects(
      configured.service.recoverExperienceFixture({
        actor: ACTOR,
        ownership: OWNERSHIP,
      }),
      /cleanup failed/i,
    );
  });

  await t.test("malformed candidate", async () => {
    const configured = fixtureService(createHostedAcceptanceBrokerService);
    await configured.service.provisionExperienceFixture({
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    });
    const malformed = candidate("operations", {
      projectId: { S: "foreign-project" },
    });
    configured.dynamo.items.set(dynamoKey(malformed), malformed);
    await assert.rejects(
      configured.service.recoverExperienceFixture({
        actor: ACTOR,
        ownership: OWNERSHIP,
      }),
      /cleanup failed/i,
    );
  });
});

test("experience fixture cleanup validates all records then atomically deletes children before parents", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const configured = fixtureService(createHostedAcceptanceBrokerService);
  const input = {
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  };
  const fixture = await configured.service.provisionExperienceFixture(input);
  configured.dynamo.commands.length = 0;
  configured.runtimeControl.calls.length = 0;
  configured.runtimeControl.resolveEndpoint = async () => {
    throw new Error("Runtime changed after fixture provision.");
  };

  assert.deepEqual(
    await configured.service.cleanupExperienceFixture({
      ...input,
      fixture,
    }),
    { ok: true },
  );
  const transactions = configured.dynamo.commands.filter(
    (command) => command instanceof TransactWriteItemsCommand,
  );
  assert.equal(transactions.length, 1);
  const deletes = transactions[0].input.TransactItems;
  assert.equal(deletes.length, 4);
  assert.ok(deletes.every((operation) =>
    Object.keys(operation).length === 1
    && operation.Delete
    && operation.Delete.TableName === TABLE
    && operation.Delete.ConditionExpression.includes("entityType")
  ));
  assert.deepEqual(
    deletes.map((operation) => dynamoKey(operation.Delete.Key)),
    [
      `ENTITLEMENT#${ACTOR}|AGENT#${EXPERIENCE_DOMAIN_ID}`
        + `#${EXPERIENCE_FIXTURE.projectId}#${EXPERIENCE_FIXTURE.agentId}`,
      `DEPLOYMENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
        + `|DEPLOYMENT#${EXPERIENCE_FIXTURE.deploymentId}`,
      `AGENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
        + `|AGENT#${EXPERIENCE_FIXTURE.agentId}`,
      `PROJECT#${EXPERIENCE_DOMAIN_ID}|PROJECT#${EXPERIENCE_FIXTURE.projectId}`,
    ],
  );
  assert.deepEqual(configured.runtimeControl.calls, []);
  assert.equal(
    configured.dynamo.commands.some((command) =>
      /Scan|Query|BatchWrite/.test(command.constructor.name)
    ),
    false,
  );

  configured.dynamo.commands.length = 0;
  configured.runtimeControl.calls.length = 0;
  assert.deepEqual(
    await configured.service.cleanupExperienceFixture({
      ...input,
      fixture,
    }),
    { ok: true },
  );
  assert.equal(
    configured.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
  assert.equal(configured.runtimeControl.calls.length, 0);
});

test("experience fixture cleanup rejects malformed, partial, and foreign state before any delete", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const input = {
    actor: ACTOR,
    domainId: EXPERIENCE_DOMAIN_ID,
    ownership: OWNERSHIP,
  };
  const configured = fixtureService(createHostedAcceptanceBrokerService);
  const fixture = await configured.service.provisionExperienceFixture(input);
  configured.dynamo.commands.length = 0;

  await assert.rejects(
    configured.service.cleanupExperienceFixture({
      ...input,
      fixture: { ...fixture, agentId: "caller-agent" },
    }),
    /cleanup failed/i,
  );
  assert.equal(configured.dynamo.commands.length, 0);

  const projectKey =
    `PROJECT#${EXPERIENCE_DOMAIN_ID}|PROJECT#${EXPERIENCE_FIXTURE.projectId}`;
  configured.dynamo.items.delete(projectKey);
  await assert.rejects(
    configured.service.cleanupExperienceFixture({
      ...input,
      fixture,
    }),
    /cleanup failed/i,
  );
  assert.equal(
    configured.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );

  const foreign = fixtureService(createHostedAcceptanceBrokerService);
  await foreign.service.provisionExperienceFixture(input);
  const deploymentKey =
    `DEPLOYMENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
    + `|DEPLOYMENT#${EXPERIENCE_FIXTURE.deploymentId}`;
  foreign.dynamo.items.get(deploymentKey).runtimeVersion.S = "8";
  foreign.dynamo.commands.length = 0;
  await assert.rejects(
    foreign.service.cleanupExperienceFixture({
      ...input,
      fixture,
    }),
    /cleanup failed/i,
  );
  assert.equal(
    foreign.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );

  const coordinated = fixtureService(createHostedAcceptanceBrokerService);
  await coordinated.service.provisionExperienceFixture(input);
  const coordinatedDeployment =
    coordinated.dynamo.items.get(deploymentKey);
  const coordinatedAgentKey =
    `AGENT#${EXPERIENCE_DOMAIN_ID}#${EXPERIENCE_FIXTURE.projectId}`
    + `|AGENT#${EXPERIENCE_FIXTURE.agentId}`;
  const alternateRuntimeId = "AlternateRuntimeName-XYZ9876543";
  const alternateRuntimeArn =
    `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:`
    + `runtime/${alternateRuntimeId}`;
  const alternateIdentity = {
    runtimeId: alternateRuntimeId,
    runtimeArn: alternateRuntimeArn,
    runtimeStatus: "READY",
    endpointName: ENDPOINT_NAME,
    endpointArn: `${alternateRuntimeArn}/runtime-endpoint/${ENDPOINT_NAME}`,
    runtimeVersion: "8",
  };
  for (const [name, value] of Object.entries(alternateIdentity)) {
    coordinatedDeployment[name].S = value;
  }
  const runtimeHash = createHash("sha256")
    .update([
      alternateIdentity.runtimeId,
      alternateIdentity.runtimeArn,
      alternateIdentity.runtimeStatus,
      alternateIdentity.endpointName,
      alternateIdentity.endpointArn,
      alternateIdentity.runtimeVersion,
    ].join("\n"))
    .digest("hex");
  coordinated.dynamo.items.get(
    coordinatedAgentKey,
  ).lastTestEvidenceHash.S = createHash("sha256")
    .update(
      `hosted-acceptance:experience:evidence:`
      + `${OWNERSHIP.runId}:${OWNERSHIP.runAttempt}:${runtimeHash}`,
    )
    .digest("hex");
  coordinated.dynamo.commands.length = 0;
  await assert.rejects(
    coordinated.service.cleanupExperienceFixture({
      ...input,
      fixture,
    }),
    /cleanup failed/i,
  );
  assert.equal(
    coordinated.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
});

test("experience fixture rejects malformed live runtime identity before transaction", async () => {
  const { createHostedAcceptanceBrokerService } = await loadService();
  const configured = fixtureService(
    createHostedAcceptanceBrokerService,
    {
      runtimeControl: readyRuntimeControl({
        ...RUNTIME_IDENTITY,
        runtimeStatus: "UPDATING",
      }),
    },
  );

  await assert.rejects(
    configured.service.provisionExperienceFixture({
      actor: ACTOR,
      domainId: EXPERIENCE_DOMAIN_ID,
      ownership: OWNERSHIP,
    }),
    /cleanup failed/i,
  );
  assert.equal(
    configured.dynamo.commands.some(
      (command) => command instanceof TransactWriteItemsCommand,
    ),
    false,
  );
});
