import assert from "node:assert/strict";
import test from "node:test";
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const NOW = "2026-08-25T01:02:03.000Z";
const NOW_EPOCH = Math.floor(Date.parse(NOW) / 1000);
const TABLE_NAME = "PlatformState";
const FINGERPRINT = "a".repeat(64);

let workspaceStateModule;

async function loadWorkspaceState() {
  workspaceStateModule ??= import("../lambda/workspace/state.mjs");
  return workspaceStateModule;
}

async function stateWith(dynamo, now = () => NOW) {
  const { createWorkspaceState } = await loadWorkspaceState();
  return createWorkspaceState({
    tableName: TABLE_NAME,
    dynamo,
    now,
  });
}

function recordingDynamo(responses = [{}]) {
  const commands = [];
  const options = [];
  return {
    commands,
    options,
    async send(command, sendOptions) {
      commands.push(command);
      options.push(sendOptions);
      if (responses.length === 0) {
        throw new Error("Unexpected DynamoDB command.");
      }
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function mutation(entityType, resourceKey, overrides = {}) {
  const result = {
    entityType,
    resourceKey,
    operation: "CREATE",
    status: "SUCCEEDED",
    ...(overrides.result ?? {}),
  };
  const base = {
    actor: "builder-sub-123",
    requesterSubject: "builder-sub-123",
    effectiveRole: "builder",
    domainId: "customer_support",
    projectId: "case-assist",
    route: `POST /api/${entityType.toLowerCase()}s`,
    requestId: `${entityType.toLowerCase()}-request-123`,
    payloadFingerprint: FINGERPRINT,
    result,
    decision: result.operation.toLowerCase(),
    reason: "Authorized workspace mutation.",
    timestamp: NOW,
    createdAt: NOW,
  };
  return {
    ...base,
    ...overrides,
    result,
  };
}

function updateMutation(entityType, resourceKey, overrides = {}) {
  return mutation(entityType, resourceKey, {
    decision: "update",
    reason: "Authorized workspace update.",
    ...overrides,
    result: {
      operation: "UPDATE",
      ...(overrides.result ?? {}),
    },
  });
}

function project(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Customer support agent project.",
    ownerSubject: "builder-sub-123",
    memberSubjects: ["builder-sub-123"],
    status: "ACTIVE",
    createdBySubject: "builder-sub-123",
    createdAt: NOW,
    ...overrides,
  };
}

function buildConfig(overrides = {}) {
  return {
    instructions: "Route incoming support cases to the right queue.",
    modelParameters: {
      temperature: 0.2,
      maxTokens: 1024,
    },
    buildOptions: {
      framework: "Strands",
      deployTarget: "AgentCore Runtime",
      memory: "shortTerm",
      streaming: true,
      identity: true,
      guardrails: true,
    },
    ...overrides,
  };
}

function guardrailChain(overrides = {}) {
  const defaults = [
    {
      id: "pii-detection",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "",
      priority: 0,
    },
    {
      id: "harmful-content",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "",
      priority: 1,
    },
    {
      id: "jailbreaking",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "",
      priority: 2,
    },
    {
      id: "prompt-injection",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "",
      priority: 3,
    },
    {
      id: "topic-restriction",
      enabled: true,
      action: "Flag",
      runMode: "Post-Agent Execution",
      message: "",
      priority: 4,
    },
  ];
  return defaults.map((entry) => (
    entry.id === overrides.id ? { ...entry, ...overrides } : entry
  ));
}

function agent(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Routes inbound support cases.",
    ownerSubject: "builder-sub-123",
    modelId: "anthropic.claude-sonnet",
    toolIds: ["case-search"],
    mcpServerIds: ["support-mcp"],
    skillIds: ["case-triage"],
    blueprintIds: ["support-blueprint"],
    memoryIds: ["support-memory"],
    knowledgeBaseIds: ["support-kb"],
    buildConfig: buildConfig(),
    status: "DRAFT",
    createdBySubject: "builder-sub-123",
    createdAt: NOW,
    updatedAt: NOW,
    lastTestStatus: null,
    lastTestedAt: null,
    lastTestedBySubject: null,
    lastTestModelId: null,
    lastTestInputTokens: null,
    lastTestOutputTokens: null,
    lastTestRequestId: null,
    lastTestEvidenceHash: null,
    lastTestOutput: null,
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent-prod-001",
    agentId: "triage-agent",
    environment: "PRODUCTION",
    status: "REQUESTED",
    requesterSubject: "builder-sub-123",
    approverSubject: null,
    decisionReason: null,
    requestedAt: NOW,
    decidedAt: null,
    runtimeId: null,
    runtimeArn: null,
    runtimeStatus: null,
    endpointName: null,
    endpointArn: null,
    runtimeVersion: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "approval-prod-001",
    kind: "PRODUCTION_DEPLOYMENT",
    resourceType: "DEPLOYMENT",
    resourceId: "triage-agent-prod-001",
    projectId: "case-assist",
    status: "PENDING",
    requesterSubject: "builder-sub-123",
    approverSubject: null,
    reason: null,
    requestedAt: NOW,
    decidedAt: null,
    ...overrides,
  };
}

function resourceGrant(overrides = {}) {
  return {
    domainId: "customer_support",
    resourceType: "MODEL",
    resourceId: "anthropic.claude-sonnet",
    status: "ACTIVE",
    grantedBySubject: "lead-sub-123",
    grantedAt: NOW,
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function entitlement(overrides = {}) {
  return {
    subject: "user-sub-123",
    agentId: "triage-agent",
    domainId: "customer_support",
    projectId: "case-assist",
    status: "ACTIVE",
    grantedBySubject: "lead-sub-123",
    grantedAt: NOW,
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function typedEntitlement(subjectType, subject, overrides = {}) {
  return {
    ...entitlement({
      subject,
      ...overrides,
    }),
    subjectType,
    expiresAt: overrides.expiresAt ?? null,
  };
}

function session(overrides = {}) {
  return {
    actor: "user-sub-123",
    id: "session-001",
    agentId: "triage-agent",
    domainId: "customer_support",
    projectId: "case-assist",
    status: "ACTIVE",
    lastInvocationStatus: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function incident(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "incident-001",
    title: "Elevated agent failures",
    description: "The support agent is returning an elevated error rate.",
    severity: "HIGH",
    status: "OPEN",
    ownerSubject: "builder-sub-123",
    reporterSubject: "builder-sub-123",
    acknowledgedBySubject: null,
    acknowledgedAt: null,
    resolvedBySubject: null,
    resolvedAt: null,
    reopenedBySubject: null,
    reopenedAt: null,
    lastActionReason: "Reported after runtime alert validation.",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function breakGlass(overrides = {}) {
  return {
    id: "break-glass-001",
    domainId: "customer_support",
    projectId: "case-assist",
    resource: "trace/customer_support/case-assist/trace-001",
    action: "trace:read-content",
    status: "REQUESTED",
    requesterSubject: "admin-requester-sub",
    reason: "Investigate a critical production incident.",
    requestedAt: NOW,
    expiresAt: "2026-08-25T01:32:03.000Z",
    approverSubject: null,
    decisionReason: null,
    decidedAt: null,
    activatedBySubject: null,
    activationReason: null,
    activatedAt: null,
    revokedBySubject: null,
    revocationReason: null,
    revokedAt: null,
    ...overrides,
  };
}

function audit(overrides = {}) {
  return {
    resource: "deployment/customer_support/case-assist/triage-agent-prod-001",
    timestamp: NOW,
    requestId: "approval-request-123",
    actor: "lead-sub-123",
    requesterSubject: "builder-sub-123",
    effectiveRole: "lead",
    action: "deployment.approve",
    decision: "approve",
    reason: "Approved after domain review.",
    domainId: "customer_support",
    projectId: "case-assist",
    ...overrides,
  };
}

function string(value) {
  return { S: value };
}

function nullableString(value) {
  return value === null ? { NULL: true } : string(value);
}

function nullableNumber(value) {
  return value === null ? { NULL: true } : { N: String(value) };
}

function buildConfigAttribute(value) {
  return {
    M: {
      instructions: string(value.instructions),
      modelParameters: {
        M: {
          temperature: nullableNumber(value.modelParameters.temperature),
          maxTokens: nullableNumber(value.modelParameters.maxTokens),
        },
      },
      buildOptions: {
        M: {
          framework: string(value.buildOptions.framework),
          deployTarget: string(value.buildOptions.deployTarget),
          memory: string(value.buildOptions.memory),
          streaming: { BOOL: value.buildOptions.streaming },
          identity: { BOOL: value.buildOptions.identity },
          guardrails: { BOOL: value.buildOptions.guardrails },
        },
      },
      ...(Object.hasOwn(value, "guardrailChain")
        ? {
            guardrailChain: {
              L: value.guardrailChain.map((entry) => ({
                M: {
                  id: string(entry.id),
                  enabled: { BOOL: entry.enabled },
                  action: string(entry.action),
                  runMode: string(entry.runMode),
                  message: string(entry.message),
                  priority: { N: String(entry.priority) },
                },
              })),
            },
          }
        : {}),
    },
  };
}

function stringList(values) {
  return { L: values.map(string) };
}

function projectItem(value = project()) {
  return {
    pk: string(`PROJECT#${value.domainId}`),
    sk: string(`PROJECT#${value.id}`),
    entityType: string("PROJECT"),
    domainId: string(value.domainId),
    id: string(value.id),
    name: string(value.name),
    description: string(value.description),
    ownerSubject: string(value.ownerSubject),
    memberSubjects: stringList(value.memberSubjects),
    status: string(value.status),
    createdBySubject: string(value.createdBySubject),
    createdAt: string(value.createdAt),
  };
}

function agentItem(value = agent()) {
  return {
    pk: string(`AGENT#${value.domainId}#${value.projectId}`),
    sk: string(`AGENT#${value.id}`),
    entityType: string("AGENT"),
    domainId: string(value.domainId),
    projectId: string(value.projectId),
    id: string(value.id),
    name: string(value.name),
    description: string(value.description),
    ownerSubject: string(value.ownerSubject),
    modelId: string(value.modelId),
    toolIds: stringList(value.toolIds),
    mcpServerIds: stringList(value.mcpServerIds),
    skillIds: stringList(value.skillIds),
    blueprintIds: stringList(value.blueprintIds),
    memoryIds: stringList(value.memoryIds),
    knowledgeBaseIds: stringList(value.knowledgeBaseIds),
    buildConfig: buildConfigAttribute(value.buildConfig),
    status: string(value.status),
    createdBySubject: string(value.createdBySubject),
    createdAt: string(value.createdAt),
    updatedAt: string(value.updatedAt),
    lastTestStatus: nullableString(value.lastTestStatus),
    lastTestedAt: nullableString(value.lastTestedAt),
    lastTestedBySubject: nullableString(value.lastTestedBySubject),
    lastTestModelId: nullableString(value.lastTestModelId),
    lastTestInputTokens: nullableNumber(value.lastTestInputTokens),
    lastTestOutputTokens: nullableNumber(value.lastTestOutputTokens),
    lastTestRequestId: nullableString(value.lastTestRequestId),
    lastTestEvidenceHash: nullableString(value.lastTestEvidenceHash),
    lastTestOutput: nullableString(value.lastTestOutput),
  };
}

function deploymentItem(value = deployment()) {
  return {
    pk: string(`DEPLOYMENT#${value.domainId}#${value.projectId}`),
    sk: string(`DEPLOYMENT#${value.id}`),
    entityType: string("DEPLOYMENT"),
    domainId: string(value.domainId),
    projectId: string(value.projectId),
    id: string(value.id),
    agentId: string(value.agentId),
    environment: string(value.environment),
    status: string(value.status),
    requesterSubject: string(value.requesterSubject),
    approverSubject: nullableString(value.approverSubject),
    decisionReason: nullableString(value.decisionReason),
    requestedAt: string(value.requestedAt),
    decidedAt: nullableString(value.decidedAt),
    runtimeId: nullableString(value.runtimeId),
    runtimeArn: nullableString(value.runtimeArn),
    runtimeStatus: nullableString(value.runtimeStatus),
    endpointName: nullableString(value.endpointName),
    endpointArn: nullableString(value.endpointArn),
    runtimeVersion: nullableString(value.runtimeVersion),
    updatedAt: string(value.updatedAt),
  };
}

function approvalItem(value = approval()) {
  return {
    pk: string(`APPROVAL#${value.domainId}`),
    sk: string(`APPROVAL#${value.id}`),
    entityType: string("APPROVAL"),
    domainId: string(value.domainId),
    id: string(value.id),
    kind: string(value.kind),
    resourceType: string(value.resourceType),
    resourceId: string(value.resourceId),
    projectId: nullableString(value.projectId),
    status: string(value.status),
    requesterSubject: string(value.requesterSubject),
    approverSubject: nullableString(value.approverSubject),
    reason: nullableString(value.reason),
    requestedAt: string(value.requestedAt),
    decidedAt: nullableString(value.decidedAt),
  };
}

function grantItem(value = resourceGrant()) {
  return {
    pk: string(`GRANT#${value.domainId}`),
    sk: string(`GRANT#${value.resourceType}#${value.resourceId}`),
    entityType: string("RESOURCE_GRANT"),
    domainId: string(value.domainId),
    resourceType: string(value.resourceType),
    resourceId: string(value.resourceId),
    status: string(value.status),
    grantedBySubject: string(value.grantedBySubject),
    grantedAt: string(value.grantedAt),
    revokedBySubject: nullableString(value.revokedBySubject),
    revokedAt: nullableString(value.revokedAt),
  };
}

function entitlementItem(value = entitlement()) {
  const subjectPrefix = value.subjectType === undefined
    ? value.subject
    : `${value.subjectType}#${value.subject}`;
  const item = {
    pk: string(`ENTITLEMENT#${subjectPrefix}`),
    sk: string(
      `AGENT#${value.domainId}#${value.projectId}#${value.agentId}`,
    ),
    entityType: string("ENTITLEMENT"),
    subject: string(value.subject),
    agentId: string(value.agentId),
    domainId: string(value.domainId),
    projectId: string(value.projectId),
    status: string(value.status),
    grantedBySubject: string(value.grantedBySubject),
    grantedAt: string(value.grantedAt),
    revokedBySubject: nullableString(value.revokedBySubject),
    revokedAt: nullableString(value.revokedAt),
  };
  if (value.subjectType !== undefined) {
    item.subjectType = string(value.subjectType);
    item.expiresAt = nullableString(value.expiresAt);
  }
  return item;
}

function sessionItem(value = session()) {
  return {
    pk: string(`SESSION#${value.actor}`),
    sk: string(`SESSION#${value.id}`),
    entityType: string("SESSION"),
    actor: string(value.actor),
    id: string(value.id),
    agentId: string(value.agentId),
    domainId: string(value.domainId),
    projectId: string(value.projectId),
    status: string(value.status),
    lastInvocationStatus: nullableString(value.lastInvocationStatus),
    createdAt: string(value.createdAt),
    updatedAt: string(value.updatedAt),
  };
}

function incidentItem(value = incident()) {
  return {
    pk: string(`INCIDENT#${value.domainId}`),
    sk: string(`INCIDENT#${value.id}`),
    entityType: string("INCIDENT"),
    domainId: string(value.domainId),
    projectId: string(value.projectId),
    id: string(value.id),
    title: string(value.title),
    description: string(value.description),
    severity: string(value.severity),
    status: string(value.status),
    ownerSubject: string(value.ownerSubject),
    reporterSubject: string(value.reporterSubject),
    acknowledgedBySubject:
      nullableString(value.acknowledgedBySubject),
    acknowledgedAt: nullableString(value.acknowledgedAt),
    resolvedBySubject: nullableString(value.resolvedBySubject),
    resolvedAt: nullableString(value.resolvedAt),
    reopenedBySubject: nullableString(value.reopenedBySubject),
    reopenedAt: nullableString(value.reopenedAt),
    lastActionReason: string(value.lastActionReason),
    createdAt: string(value.createdAt),
    updatedAt: string(value.updatedAt),
  };
}

function breakGlassItem(value = breakGlass()) {
  return {
    pk: string("BREAK_GLASS"),
    sk: string(`BREAK_GLASS#${value.id}`),
    entityType: string("BREAK_GLASS"),
    id: string(value.id),
    domainId: string(value.domainId),
    projectId: nullableString(value.projectId),
    resource: string(value.resource),
    action: string(value.action),
    status: string(value.status),
    requesterSubject: string(value.requesterSubject),
    reason: string(value.reason),
    requestedAt: string(value.requestedAt),
    expiresAt: string(value.expiresAt),
    approverSubject: nullableString(value.approverSubject),
    decisionReason: nullableString(value.decisionReason),
    decidedAt: nullableString(value.decidedAt),
    activatedBySubject: nullableString(value.activatedBySubject),
    activationReason: nullableString(value.activationReason),
    activatedAt: nullableString(value.activatedAt),
    revokedBySubject: nullableString(value.revokedBySubject),
    revocationReason: nullableString(value.revocationReason),
    revokedAt: nullableString(value.revokedAt),
  };
}

function auditItem(value = audit()) {
  return {
    pk: string(`AUDIT#${value.resource}`),
    sk: string(`${value.timestamp}#${value.requestId}`),
    entityType: string("WORKSPACE_AUDIT"),
    resource: string(value.resource),
    timestamp: string(value.timestamp),
    requestId: string(value.requestId),
    actor: string(value.actor),
    requesterSubject: string(value.requesterSubject),
    effectiveRole: string(value.effectiveRole),
    action: string(value.action),
    decision: string(value.decision),
    reason: string(value.reason),
    domainId: string(value.domainId),
    projectId: nullableString(value.projectId),
  };
}

function mutationItem(value) {
  const result = {
    entityType: string(value.result.entityType),
    resourceKey: string(value.result.resourceKey),
    operation: string(value.result.operation),
    status: string(value.result.status),
  };
  if (value.result.accessAdmin !== undefined) {
    result.accessAdmin = {
      M: {
        username: string(value.result.accessAdmin.username),
        subject: string(value.result.accessAdmin.subject),
        membershipStatus: string(value.result.accessAdmin.membershipStatus),
        changed: { BOOL: value.result.accessAdmin.changed },
      },
    };
  }
  return {
    pk: string(`MUTATION#${value.actor}`),
    sk: string(`MUTATION#${value.route}#${value.requestId}`),
    entityType: string("MUTATION_RESULT"),
    actor: string(value.actor),
    requesterSubject: string(value.requesterSubject),
    effectiveRole: string(value.effectiveRole),
    domainId: string(value.domainId),
    projectId: nullableString(value.projectId),
    route: string(value.route),
    requestId: string(value.requestId),
    payloadFingerprint: string(value.payloadFingerprint),
    result: {
      M: result,
    },
    decision: string(value.decision),
    reason: string(value.reason),
    timestamp: string(value.timestamp),
    createdAt: string(value.createdAt),
  };
}

function mutationClaim(overrides = {}) {
  return {
    actor: "builder-sub-123",
    requesterSubject: "builder-sub-123",
    effectiveRole: "builder",
    domainId: "customer_support",
    projectId: "case-assist",
    route: "POST /api/agents/{id}/test",
    requestId: "test-request-123",
    payloadFingerprint: FINGERPRINT,
    resourceKey: "agent/customer_support/case-assist/triage-agent",
    operation: "UPDATE",
    ...overrides,
  };
}

function mutationClaimItem(value, { legacyExpiresAt } = {}) {
  const item = {
    pk: string(`MUTATION#${value.actor}`),
    sk: string(`CLAIM#${value.route}#${value.requestId}`),
    entityType: string("MUTATION_CLAIM"),
    actor: string(value.actor),
    requesterSubject: string(value.requesterSubject),
    effectiveRole: string(value.effectiveRole),
    domainId: string(value.domainId),
    projectId: nullableString(value.projectId),
    route: string(value.route),
    requestId: string(value.requestId),
    payloadFingerprint: string(value.payloadFingerprint),
    resourceKey: string(value.resourceKey),
    operation: string(value.operation),
    createdAt: string(NOW),
  };
  if (legacyExpiresAt !== undefined) {
    item.expiresAt = { N: String(legacyExpiresAt) };
  }
  return item;
}

function mutationAudit(value) {
  return {
    resource: value.result.resourceKey,
    timestamp: value.timestamp,
    requestId: value.requestId,
    actor: value.actor,
    requesterSubject: value.requesterSubject,
    effectiveRole: value.effectiveRole,
    action:
      `${value.result.entityType.toLowerCase()}.`
      + value.result.operation.toLowerCase(),
    decision: value.decision,
    reason: value.reason,
    domainId: value.domainId,
    projectId: value.projectId,
  };
}

function appendMutationForAudit(record, overrides = {}) {
  return mutation(
    "WORKSPACE_AUDIT",
    `audit/${record.resource}/${record.timestamp}/${record.requestId}`,
    {
      actor: record.actor,
      requesterSubject: record.requesterSubject,
      effectiveRole: record.effectiveRole,
      domainId: record.domainId,
      projectId: record.projectId,
      route: "POST /api/deployment-decisions",
      requestId: record.requestId,
      decision: record.decision,
      reason: record.reason,
      timestamp: record.timestamp,
      createdAt: record.timestamp,
      result: { operation: "APPEND" },
      ...overrides,
    },
  );
}

function expectCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

function resourceKeyFor(entityType, record) {
  if (entityType === "PROJECT") {
    return `project/${record.domainId}/${record.id}`;
  }
  if (entityType === "AGENT") {
    return `agent/${record.domainId}/${record.projectId}/${record.id}`;
  }
  if (entityType === "DEPLOYMENT") {
    return `deployment/${record.domainId}/${record.projectId}/${record.id}`;
  }
  if (entityType === "APPROVAL") {
    return `approval/${record.domainId}/${record.id}`;
  }
  if (entityType === "RESOURCE_GRANT") {
    return (
      `grant/${record.domainId}/${record.resourceType}/${record.resourceId}`
    );
  }
  if (entityType === "ENTITLEMENT") {
    const subject = record.subjectType === undefined
      ? record.subject
      : `${record.subjectType}/${record.subject}`;
    return (
      `entitlement/${subject}/${record.domainId}/`
      + `${record.projectId}/${record.agentId}`
    );
  }
  if (entityType === "INCIDENT") {
    return `incident/${record.domainId}/${record.projectId}/${record.id}`;
  }
  if (entityType === "BREAK_GLASS") {
    return `break-glass/${record.id}`;
  }
  return `session/${record.actor}/${record.id}`;
}

function createMutationFor(entityType, record, overrides = {}) {
  const baseOverrides = {};
  if (entityType === "PROJECT") {
    baseOverrides.projectId = record.id;
  }
  if (entityType === "DEPLOYMENT") {
    baseOverrides.actor = record.requesterSubject;
  }
  if (entityType === "RESOURCE_GRANT") {
    baseOverrides.actor = record.grantedBySubject;
    baseOverrides.effectiveRole = "lead";
    baseOverrides.projectId = null;
  }
  if (entityType === "ENTITLEMENT") {
    baseOverrides.actor = record.grantedBySubject;
    baseOverrides.effectiveRole = "lead";
    baseOverrides.decision = "grant";
  }
  if (entityType === "SESSION") {
    baseOverrides.actor = record.actor;
    baseOverrides.effectiveRole = "user";
  }
  if (entityType === "INCIDENT") {
    baseOverrides.actor = record.reporterSubject;
    baseOverrides.requesterSubject = record.reporterSubject;
    baseOverrides.projectId = record.projectId;
    baseOverrides.decision = "report";
    baseOverrides.reason = record.lastActionReason;
  }
  if (entityType === "BREAK_GLASS") {
    baseOverrides.actor = record.requesterSubject;
    baseOverrides.requesterSubject = record.requesterSubject;
    baseOverrides.effectiveRole = "admin";
    baseOverrides.projectId = record.projectId;
    baseOverrides.route = "POST /api/break-glass/requests";
    baseOverrides.requestId = "break-glass-request-123";
    baseOverrides.decision = "request";
    baseOverrides.reason = record.reason;
  }
  baseOverrides.requesterSubject =
    baseOverrides.requesterSubject
    ?? baseOverrides.actor
    ?? "builder-sub-123";
  return mutation(
    entityType,
    resourceKeyFor(entityType, record),
    { ...baseOverrides, ...overrides },
  );
}

function updateMutationFor(entityType, record, overrides = {}) {
  const base = createMutationFor(entityType, record);
  const actor = overrides.actor ?? base.actor;
  const requesterSubject =
    new Set([
      "DEPLOYMENT",
      "APPROVAL",
      "INCIDENT",
      "BREAK_GLASS",
    ]).has(entityType)
      ? base.requesterSubject
      : overrides.requesterSubject ?? actor;
  return updateMutation(
    entityType,
    resourceKeyFor(entityType, record),
    {
      actor,
      requesterSubject,
      effectiveRole: base.effectiveRole,
      domainId: base.domainId,
      projectId: base.projectId,
      route: base.route,
      requestId: base.requestId,
      ...overrides,
    },
  );
}

const createScenarios = [
  {
    name: "project",
    method: "putProject",
    entityType: "PROJECT",
    record: project(),
    item: projectItem(),
  },
  {
    name: "agent",
    method: "putAgent",
    entityType: "AGENT",
    record: agent(),
    item: agentItem(),
  },
  {
    name: "deployment",
    method: "putDeployment",
    entityType: "DEPLOYMENT",
    record: deployment(),
    item: deploymentItem(),
  },
  {
    name: "approval",
    method: "putApproval",
    entityType: "APPROVAL",
    record: approval(),
    item: approvalItem(),
  },
  {
    name: "resource grant",
    method: "putResourceGrant",
    entityType: "RESOURCE_GRANT",
    record: resourceGrant(),
    item: grantItem(),
  },
  {
    name: "entitlement",
    method: "putEntitlement",
    entityType: "ENTITLEMENT",
    record: entitlement(),
    item: entitlementItem(),
  },
  {
    name: "personal session",
    method: "putSession",
    entityType: "SESSION",
    record: session(),
    item: sessionItem(),
  },
];

for (const scenario of createScenarios) {
  test(`${scenario.name} creation atomically writes entity, audit, and mutation`, async () => {
    const request = createMutationFor(scenario.entityType, scenario.record);
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo);

    const result = await state[scenario.method]({
      record: scenario.record,
      mutation: request,
      expectedStatus: null,
    });

    assert.deepEqual(result, scenario.record);
    assert.equal(dynamo.commands.length, 1);
    assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
    const [entityWrite, auditWrite, mutationWrite] =
      dynamo.commands[0].input.TransactItems;
    assert.deepEqual(entityWrite.Put.Item, scenario.item);
    assert.equal(
      entityWrite.Put.ConditionExpression,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    assert.deepEqual(auditWrite.Put.Item, auditItem(mutationAudit(request)));
    assert.equal(
      auditWrite.Put.ConditionExpression,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    assert.deepEqual(mutationWrite.Put.Item, mutationItem(request));
    assert.equal(
      mutationWrite.Put.ConditionExpression,
      "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
    );
  });
}

test("typed group and domain entitlements persist exact indexed subjects without changing legacy user keys", async () => {
  for (const record of [
    typedEntitlement("GROUP", "support-users"),
    typedEntitlement("DOMAIN", "operations", {
      expiresAt: "2026-08-25T02:02:03.000Z",
    }),
  ]) {
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo);

    assert.deepEqual(
      await state.putEntitlement({
        record,
        mutation: createMutationFor("ENTITLEMENT", record),
        expectedStatus: null,
      }),
      record,
    );

    const entityWrite =
      dynamo.commands[0].input.TransactItems[0].Put.Item;
    assert.deepEqual(entityWrite, entitlementItem(record));
    assert.equal(
      entityWrite.pk.S,
      `ENTITLEMENT#${record.subjectType}#${record.subject}`,
    );
  }

  assert.equal(
    entitlementItem().pk.S,
    "ENTITLEMENT#user-sub-123",
  );
  assert.equal(
    Object.hasOwn(entitlementItem(), "subjectType"),
    false,
  );
});

test("typed entitlement lookups query one exact subject partition without scans", async () => {
  for (const record of [
    typedEntitlement("GROUP", "support-users"),
    typedEntitlement("DOMAIN", "operations"),
  ]) {
    const listDynamo = recordingDynamo([{
      Items: [entitlementItem(record)],
    }]);
    const listState = await stateWith(listDynamo);
    assert.deepEqual(
      await listState.listEntitlements({
        subjectType: record.subjectType,
        subject: record.subject,
      }),
      { items: [record], cursor: null },
    );
    assert.ok(listDynamo.commands[0] instanceof QueryCommand);
    assert.equal(
      listDynamo.commands[0].input.ExpressionAttributeValues[":pk"].S,
      `ENTITLEMENT#${record.subjectType}#${record.subject}`,
    );

    const getDynamo = recordingDynamo([{
      Item: entitlementItem(record),
    }]);
    const getState = await stateWith(getDynamo);
    assert.deepEqual(
      await getState.getEntitlement({
        subjectType: record.subjectType,
        subject: record.subject,
        domainId: record.domainId,
        projectId: record.projectId,
        agentId: record.agentId,
      }),
      record,
    );
    assert.ok(getDynamo.commands[0] instanceof GetItemCommand);
    assert.equal(
      getDynamo.commands[0].input.Key.pk.S,
      `ENTITLEMENT#${record.subjectType}#${record.subject}`,
    );
  }
});

test("agent entitlement inventory queries only the entitlement metadata index", async () => {
  const record = typedEntitlement("GROUP", "support-users");
  const cursor = {
    entityType: string("ENTITLEMENT"),
    pk: string("ENTITLEMENT#GROUP#support-users"),
    sk: string("AGENT#customer_support#case-assist#triage-agent"),
  };
  const dynamo = recordingDynamo([{
    Items: [entitlementItem(record)],
    LastEvaluatedKey: cursor,
  }]);
  const state = await stateWith(dynamo);

  const page = await state.listAgentEntitlements({
    domainId: "customer_support",
    limit: 25,
  });

  assert.deepEqual(page, {
    items: [record],
    cursor: {
      pk: "ENTITLEMENT#GROUP#support-users",
      sk: "AGENT#customer_support#case-assist#triage-agent",
    },
  });
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof QueryCommand);
  const query = dynamo.commands[0].input;
  assert.equal(query.IndexName, "EntityTypeIndex");
  assert.equal(
    query.KeyConditionExpression,
    "#entityType = :entityType AND begins_with(#sk, :domainPrefix)",
  );
  assert.equal(query.ExpressionAttributeValues[":entityType"].S, "ENTITLEMENT");
  assert.equal(
    query.ExpressionAttributeValues[":domainPrefix"].S,
    "AGENT#customer_support#",
  );
  assert.equal(query.Limit, 25);
  assert.equal(query.FilterExpression, undefined);
  assert.match(query.ProjectionExpression, /#entitlement/);
});

test("admin entitlement inventory is bounded and rejects malformed or cross-domain cursors", async () => {
  const record = typedEntitlement("DOMAIN", "operations", {
    domainId: "operations",
  });
  const dynamo = recordingDynamo([{ Items: [entitlementItem(record)] }]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.listAgentEntitlements({ limit: 50 }),
    { items: [record], cursor: null },
  );
  assert.equal(
    dynamo.commands[0].input.KeyConditionExpression,
    "#entityType = :entityType",
  );
  assert.equal(
    dynamo.commands[0].input.ExpressionAttributeValues[":domainPrefix"],
    undefined,
  );
  for (const input of [
    { limit: 0 },
    { limit: 101 },
    { domainId: "invalid-domain" },
    {
      domainId: "customer_support",
      cursor: {
        pk: "ENTITLEMENT#DOMAIN#operations",
        sk: "AGENT#operations#case-assist#triage-agent",
      },
    },
  ]) {
    await assert.rejects(
      state.listAgentEntitlements(input),
      expectCode(
        input.domainId === "invalid-domain"
          ? "INVALID_ENTITLEMENT_SCOPE"
          : "INVALID_READ_OPTIONS",
      ),
    );
  }
});

test("typed entitlement schema rejects malformed subjects and expiry evidence", async () => {
  const invalid = [
    typedEntitlement("GROUP", "invalid group"),
    typedEntitlement("DOMAIN", "customer-support"),
    typedEntitlement("DOMAIN", "operations", {
      expiresAt: NOW,
    }),
    {
      ...typedEntitlement("GROUP", "support-users"),
      extra: true,
    },
  ];

  for (const record of invalid) {
    const state = await stateWith(recordingDynamo([]));
    await assert.rejects(
      state.putEntitlement({
        record,
        mutation: createMutationFor("ENTITLEMENT", record),
        expectedStatus: null,
      }),
      expectCode("INVALID_ENTITLEMENT"),
    );
  }
});

test("typed entitlement renewal conditionally replaces expired or revoked grant evidence", async () => {
  const renewedAt = "2026-08-25T03:02:03.000Z";
  for (const expectedStatus of ["ACTIVE", "REVOKED"]) {
    const expectedRecord = typedEntitlement("GROUP", "support-users", {
      status: expectedStatus,
      expiresAt: "2026-08-25T02:30:00.000Z",
      grantedBySubject: "prior-lead-sub",
      grantedAt: "2026-08-25T01:30:00.000Z",
      revokedBySubject: expectedStatus === "REVOKED"
        ? "prior-lead-sub"
        : null,
      revokedAt: expectedStatus === "REVOKED"
        ? "2026-08-25T02:45:00.000Z"
        : null,
    });
    const record = typedEntitlement("GROUP", "support-users", {
      expiresAt: "2026-08-25T05:02:03.000Z",
      grantedBySubject: "lead-sub-456",
      grantedAt: renewedAt,
    });
    const request = updateMutationFor("ENTITLEMENT", record, {
      actor: "lead-sub-456",
      requesterSubject: "lead-sub-456",
      effectiveRole: "lead",
      route: "POST /api/governance/agent-entitlements",
      requestId: `renew-${expectedStatus.toLowerCase()}-entitlement`,
      decision: "grant",
      reason: "Renew approved production access.",
      timestamp: renewedAt,
      createdAt: renewedAt,
    });
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo, () => renewedAt);

    assert.deepEqual(await state.putEntitlement({
      record,
      mutation: request,
      expectedStatus,
      expectedRecord,
    }), record);

    const [entityWrite, auditWrite, mutationWrite] =
      dynamo.commands[0].input.TransactItems;
    assert.equal(
      entityWrite.Put.ExpressionAttributeValues[":expectedStatus"].S,
      expectedStatus,
    );
    for (const field of [
      "subject",
      "domainId",
      "projectId",
      "agentId",
    ]) {
      assert.equal(entityWrite.Put.ExpressionAttributeNames[`#${field}`], field);
    }
    assert.equal(
      entityWrite.Put.ExpressionAttributeNames["#grantedBySubject"],
      "grantedBySubject",
    );
    assert.equal(
      entityWrite.Put.ExpressionAttributeNames["#grantedAt"],
      "grantedAt",
    );
    assert.equal(
      entityWrite.Put.ExpressionAttributeValues[":priorGrantedAt"].S,
      expectedRecord.grantedAt,
    );
    assert.deepEqual(
      entityWrite.Put.ExpressionAttributeValues[":priorExpiresAt"],
      string(expectedRecord.expiresAt),
    );
    assert.deepEqual(
      entityWrite.Put.ExpressionAttributeValues[":priorRevokedAt"],
      nullableString(expectedRecord.revokedAt),
    );
    if (expectedStatus === "ACTIVE") {
      assert.equal(
        entityWrite.Put.ExpressionAttributeNames["#expiresAt"],
        "expiresAt",
      );
      assert.deepEqual(
        entityWrite.Put.ExpressionAttributeValues[":renewalCutoff"],
        string(renewedAt),
      );
      assert.match(
        entityWrite.Put.ConditionExpression,
        /#expiresAt <= :renewalCutoff/,
      );
    } else {
      assert.equal(
        entityWrite.Put.ExpressionAttributeNames["#expiresAt"],
        "expiresAt",
      );
      assert.equal(
        entityWrite.Put.ExpressionAttributeValues[":renewalCutoff"],
        undefined,
      );
    }
    assert.deepEqual(
      auditWrite.Put.Item,
      auditItem(mutationAudit(request)),
    );
    assert.deepEqual(
      mutationWrite.Put.Item,
      mutationItem(request),
    );
  }
});

test("stale entitlement renewal cannot overwrite a newer grant or revoke cycle", async () => {
  const prior = typedEntitlement("GROUP", "support-users", {
    expiresAt: "2026-08-25T02:30:00.000Z",
    grantedBySubject: "prior-lead-sub",
    grantedAt: "2026-08-25T01:30:00.000Z",
  });
  const renewedAt = "2026-08-25T03:02:03.000Z";
  const record = typedEntitlement("GROUP", "support-users", {
    expiresAt: "2026-08-25T05:02:03.000Z",
    grantedBySubject: "lead-sub-456",
    grantedAt: renewedAt,
  });
  const request = updateMutationFor("ENTITLEMENT", record, {
    actor: "lead-sub-456",
    requesterSubject: "lead-sub-456",
    effectiveRole: "lead",
    route: "POST /api/governance/agent-entitlements",
    requestId: "stale-renewal",
    decision: "grant",
    reason: "Renew approved production access.",
    timestamp: renewedAt,
    createdAt: renewedAt,
  });
  const dynamo = recordingDynamo([
    transactionCancellation([
      "ConditionalCheckFailed",
      "None",
      "None",
    ]),
    {},
  ]);
  const state = await stateWith(dynamo, () => renewedAt);

  await assert.rejects(
    state.putEntitlement({
      record,
      mutation: request,
      expectedStatus: "ACTIVE",
      expectedRecord: prior,
    }),
    expectCode("MUTATION_CONFLICT"),
  );
});

test("entitlement audit evidence preserves the exact break-glass grant identifier", async () => {
  const record = typedEntitlement("DOMAIN", "operations");
  const request = createMutationFor("ENTITLEMENT", record, {
    authorizationEvidenceId: "break-glass-001",
  });
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);

  await state.putEntitlement({
    record,
    mutation: request,
    expectedStatus: null,
  });

  const [, auditWrite, mutationWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.equal(
    auditWrite.Put.Item.authorizationEvidenceId.S,
    "break-glass-001",
  );
  assert.equal(
    mutationWrite.Put.Item.authorizationEvidenceId.S,
    "break-glass-001",
  );
});

test("incident creation writes the strict entity, immutable audit, and idempotency result", async () => {
  const record = incident();
  const request = createMutationFor("INCIDENT", record);
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);

  assert.deepEqual(await state.putIncident({
    record,
    mutation: request,
    expectedStatus: null,
  }), record);

  const [entityWrite, auditWrite, mutationWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(entityWrite.Put.Item, incidentItem(record));
  assert.equal(
    entityWrite.Put.ConditionExpression,
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );
  assert.deepEqual(auditWrite.Put.Item, auditItem(mutationAudit(request)));
  assert.deepEqual(mutationWrite.Put.Item, mutationItem(request));
});

test("incident lifecycle is exactly open, acknowledged, resolved, and reopened", async () => {
  const acknowledged = incident({
    status: "ACKNOWLEDGED",
    acknowledgedBySubject: "lead-sub-123",
    acknowledgedAt: NOW,
    lastActionReason: "Response ownership accepted.",
  });
  const resolved = incident({
    status: "RESOLVED",
    acknowledgedBySubject: "lead-sub-123",
    acknowledgedAt: NOW,
    resolvedBySubject: "lead-sub-123",
    resolvedAt: NOW,
    lastActionReason: "Runtime error rate returned to normal.",
  });
  const reopened = incident({
    status: "OPEN",
    reopenedBySubject: "lead-sub-123",
    reopenedAt: NOW,
    lastActionReason: "The elevated error rate returned.",
  });
  const transitions = [
    {
      record: acknowledged,
      expectedStatus: "OPEN",
      decision: "acknowledge",
      route: "POST /api/incidents/{id}/actions",
    },
    {
      record: resolved,
      expectedStatus: "ACKNOWLEDGED",
      decision: "resolve",
      route: "POST /api/incidents/{id}/actions",
    },
    {
      record: reopened,
      expectedStatus: "RESOLVED",
      decision: "reopen",
      route: "POST /api/incidents/{id}/actions",
    },
  ];

  for (const transition of transitions) {
    const request = updateMutationFor("INCIDENT", transition.record, {
      actor: "lead-sub-123",
      effectiveRole: "lead",
      route: transition.route,
      requestId: `incident-${transition.decision}-123`,
      decision: transition.decision,
      reason: transition.record.lastActionReason,
    });
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo);

    assert.deepEqual(await state.putIncident({
      record: transition.record,
      mutation: request,
      expectedStatus: transition.expectedStatus,
    }), transition.record);
    const put = dynamo.commands[0].input.TransactItems[0].Put;
    assert.equal(
      put.ExpressionAttributeValues[":expectedStatus"].S,
      transition.expectedStatus,
    );
  }

  const state = await stateWith(recordingDynamo([]));
  await assert.rejects(
    state.putIncident({
      record: resolved,
      mutation: updateMutationFor("INCIDENT", resolved, {
        actor: "lead-sub-123",
        effectiveRole: "lead",
        decision: "resolve",
        reason: resolved.lastActionReason,
      }),
      expectedStatus: "OPEN",
    }),
    expectCode("INVALID_INCIDENT_TRANSITION"),
  );
});

test("incident schema rejects extra fields and inconsistent action evidence", async () => {
  const state = await stateWith(recordingDynamo([]));
  const invalid = [
    { ...incident(), tracePayload: "must-not-be-stored" },
    incident({
      status: "ACKNOWLEDGED",
      acknowledgedBySubject: null,
      acknowledgedAt: NOW,
    }),
    incident({
      status: "RESOLVED",
      acknowledgedBySubject: "lead-sub-123",
      acknowledgedAt: NOW,
      resolvedBySubject: null,
      resolvedAt: NOW,
    }),
    incident({
      status: "OPEN",
      reopenedBySubject: "lead-sub-123",
      reopenedAt: null,
    }),
  ];

  for (const record of invalid) {
    await assert.rejects(
      state.putIncident({
        record,
        mutation: createMutationFor("INCIDENT", incident()),
        expectedStatus: null,
      }),
      expectCode("INVALID_INCIDENT"),
    );
  }
});

test("break-glass request, peer decision, activation, and revocation are conditional and audited", async () => {
  const requested = breakGlass();
  const approved = breakGlass({
    status: "APPROVED",
    approverSubject: "admin-approver-sub",
    decisionReason: "Peer review confirmed the incident scope.",
    decidedAt: NOW,
  });
  const active = breakGlass({
    status: "ACTIVE",
    approverSubject: "admin-approver-sub",
    decisionReason: "Peer review confirmed the incident scope.",
    decidedAt: NOW,
    activatedBySubject: "admin-requester-sub",
    activationReason: "Begin the approved incident investigation.",
    activatedAt: NOW,
  });
  const revoked = breakGlass({
    status: "REVOKED",
    approverSubject: "admin-approver-sub",
    decisionReason: "Peer review confirmed the incident scope.",
    decidedAt: NOW,
    activatedBySubject: "admin-requester-sub",
    activationReason: "Begin the approved incident investigation.",
    activatedAt: NOW,
    revokedBySubject: "admin-approver-sub",
    revocationReason: "Investigation completed before expiry.",
    revokedAt: NOW,
  });
  const writes = [
    {
      record: requested,
      expectedStatus: null,
      actor: "admin-requester-sub",
      decision: "request",
      reason: requested.reason,
      route: "POST /api/break-glass/requests",
    },
    {
      record: approved,
      expectedStatus: "REQUESTED",
      actor: "admin-approver-sub",
      decision: "approve",
      reason: approved.decisionReason,
      route: "POST /api/break-glass/decisions",
    },
    {
      record: active,
      expectedStatus: "APPROVED",
      actor: "admin-requester-sub",
      decision: "activate",
      reason: active.activationReason,
      route: "POST /api/break-glass/activations",
    },
    {
      record: revoked,
      expectedStatus: "ACTIVE",
      actor: "admin-approver-sub",
      decision: "revoke",
      reason: revoked.revocationReason,
      route: "POST /api/break-glass/revocations",
    },
  ];

  for (const write of writes) {
    const base = createMutationFor("BREAK_GLASS", write.record);
    const request = write.expectedStatus === null
      ? base
      : updateMutationFor("BREAK_GLASS", write.record, {
          actor: write.actor,
          effectiveRole: "admin",
          route: write.route,
          requestId: `break-glass-${write.decision}-123`,
          decision: write.decision,
          reason: write.reason,
        });
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo);

    assert.deepEqual(await state.putBreakGlass({
      record: write.record,
      mutation: request,
      expectedStatus: write.expectedStatus,
    }), write.record);
    assert.deepEqual(
      dynamo.commands[0].input.TransactItems[0].Put.Item,
      breakGlassItem(write.record),
    );
  }
});

test("break-glass rejects requester approval, non-requester activation, and unbounded grants", async () => {
  const selfApproved = breakGlass({
    status: "APPROVED",
    approverSubject: "admin-requester-sub",
    decisionReason: "Self approved.",
    decidedAt: NOW,
  });
  const foreignActivation = breakGlass({
    status: "ACTIVE",
    approverSubject: "admin-approver-sub",
    decisionReason: "Peer approved.",
    decidedAt: NOW,
    activatedBySubject: "admin-approver-sub",
    activationReason: "Activate.",
    activatedAt: NOW,
  });
  const unbounded = breakGlass({
    expiresAt: "2026-08-25T03:02:03.000Z",
  });

  for (const [record, code] of [
    [selfApproved, "REQUESTER_CANNOT_APPROVE"],
    [foreignActivation, "INVALID_BREAK_GLASS"],
    [unbounded, "INVALID_BREAK_GLASS"],
  ]) {
    const state = await stateWith(recordingDynamo([]));
    await assert.rejects(
      state.putBreakGlass({
        record,
        mutation: createMutationFor("BREAK_GLASS", breakGlass()),
        expectedStatus: null,
      }),
      expectCode(code),
    );
  }
});

test("tested agent configuration and evidence round-trip as one strict record", async () => {
  const modelOutput =
    "Readiness requires:\n\n"
    + "1. Tests passed\n"
    + "2. Review complete";
  const record = agent({
    status: "TESTED",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: NOW,
    lastTestedBySubject: "builder-sub-123",
    lastTestModelId: "anthropic.claude-sonnet",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request-123",
    lastTestEvidenceHash: FINGERPRINT,
    lastTestOutput: modelOutput,
  });
  const item = agentItem(record);
  const dynamo = recordingDynamo([
    {},
    { Item: item },
  ]);
  const state = await stateWith(dynamo);

  const result = await state.putAgent({
    record,
    mutation: updateMutationFor("AGENT", record),
    expectedStatus: "READY_FOR_TEST",
  });
  assert.deepEqual(result, record);
  assert.deepEqual(
    dynamo.commands[0].input.TransactItems[0].Put.Item,
    item,
  );
  assert.deepEqual(
    await state.getAgent({
      domainId: record.domainId,
      projectId: record.projectId,
      agentId: record.id,
    }),
    record,
  );
});

test("agent builder configuration round-trips as one strict DynamoDB map", async () => {
  const record = agent({ buildConfig: buildConfig() });
  const item = agentItem(record);
  const dynamo = recordingDynamo([{}, { Item: item }]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.putAgent({
      record,
      mutation: createMutationFor("AGENT", record),
      expectedStatus: null,
    }),
    record,
  );
  assert.deepEqual(
    dynamo.commands[0].input.TransactItems[0].Put.Item,
    item,
  );
  assert.deepEqual(
    await state.getAgent({
      domainId: record.domainId,
      projectId: record.projectId,
      agentId: record.id,
    }),
    record,
  );
});

test("agent guardrail chain round-trips with stable priority and messages", async () => {
  const chain = guardrailChain({
    id: "pii-detection",
    message: "Remove personal data before continuing.",
  });
  const record = agent({
    buildConfig: buildConfig({ guardrailChain: chain }),
  });
  const dynamo = recordingDynamo([{}, {
    Item: agentItem(record),
  }]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.putAgent({
      record,
      mutation: createMutationFor("AGENT", record),
      expectedStatus: null,
    }),
    record,
  );
  assert.deepEqual(
    await state.getAgent({
      domainId: record.domainId,
      projectId: record.projectId,
      agentId: record.id,
    }),
    record,
  );
});

test("agent guardrail chain rejects unknown, duplicated, weakened, or unbounded controls", async () => {
  const invalidChains = [
    guardrailChain().map((entry, index) => (
      index === 0 ? { ...entry, id: "unknown-control" } : entry
    )),
    guardrailChain().map((entry, index) => (
      index === 1 ? { ...entry, id: "pii-detection" } : entry
    )),
    guardrailChain({ id: "pii-detection", enabled: false }),
    guardrailChain({ id: "pii-detection", action: "Allow" }),
    guardrailChain({
      id: "pii-detection",
      runMode: "During Agent Execution",
    }),
    guardrailChain({
      id: "pii-detection",
      message: "x".repeat(501),
    }),
    guardrailChain({ id: "pii-detection", priority: 4 }),
  ];
  const state = await stateWith(recordingDynamo([]));

  for (const guardrailChain of invalidChains) {
    const record = agent({
      buildConfig: buildConfig({ guardrailChain }),
    });
    await assert.rejects(
      state.putAgent({
        record,
        mutation: createMutationFor("AGENT", record),
        expectedStatus: null,
      }),
      expectCode("INVALID_AGENT"),
    );
  }
});

test("agent guardrail chain requires guardrails to be enabled", async () => {
  const record = agent({
    buildConfig: buildConfig({
      buildOptions: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "shortTerm",
        streaming: true,
        identity: true,
        guardrails: false,
      },
      guardrailChain: guardrailChain(),
    }),
  });
  const state = await stateWith(recordingDynamo([]));

  await assert.rejects(
    state.putAgent({
      record,
      mutation: createMutationFor("AGENT", record),
      expectedStatus: null,
    }),
    expectCode("INVALID_AGENT"),
  );
});

test("legacy Agent items without builder configuration remain readable as null", async () => {
  const legacyRecord = agent();
  const legacyItem = agentItem(legacyRecord);
  delete legacyItem.buildConfig;
  const state = await stateWith(recordingDynamo([{
    Item: legacyItem,
  }]));

  assert.deepEqual(
    await state.getAgent({
      domainId: legacyRecord.domainId,
      projectId: legacyRecord.projectId,
      agentId: legacyRecord.id,
    }),
    {
      ...legacyRecord,
      buildConfig: null,
    },
  );
});

test("agent builder configuration rejects malformed or unbounded values", async () => {
  const invalidConfigs = [
    buildConfig({ instructions: "" }),
    buildConfig({ instructions: "x".repeat(16_385) }),
    buildConfig({
      modelParameters: { temperature: Number.NaN, maxTokens: 1024 },
    }),
    buildConfig({
      modelParameters: { temperature: 1.01, maxTokens: 1024 },
    }),
    buildConfig({
      modelParameters: { temperature: null, maxTokens: 0 },
    }),
    buildConfig({
      buildOptions: {
        ...buildConfig().buildOptions,
        framework: "",
      },
    }),
    buildConfig({
      buildOptions: {
        ...buildConfig().buildOptions,
        deployTarget: "x".repeat(129),
      },
    }),
    buildConfig({
      buildOptions: {
        ...buildConfig().buildOptions,
        memory: "forever",
      },
    }),
    buildConfig({
      buildOptions: {
        ...buildConfig().buildOptions,
        identity: 1,
      },
    }),
  ];
  const state = await stateWith(recordingDynamo([]));

  for (const config of invalidConfigs) {
    const record = agent({ buildConfig: config });
    await assert.rejects(
      state.putAgent({
        record,
        mutation: createMutationFor("AGENT", record),
        expectedStatus: null,
      }),
      expectCode("INVALID_AGENT"),
    );
  }
});

test("failed agent tests persist bounded evidence without entering TESTED", async () => {
  const record = agent({
    status: "TEST_FAILED",
    lastTestStatus: "FAILED",
    lastTestedAt: NOW,
    lastTestedBySubject: "builder-sub-123",
    lastTestModelId: "anthropic.claude-sonnet",
    lastTestInputTokens: 0,
    lastTestOutputTokens: 0,
    lastTestRequestId: "gateway-request-123",
    lastTestEvidenceHash: FINGERPRINT,
    lastTestOutput: null,
  });
  const request = updateMutationFor("AGENT", record, {
    decision: "abort",
    reason: "Gateway test failed with a retryable error.",
    result: { status: "FAILED" },
  });
  const state = await stateWith(recordingDynamo([{}]));

  assert.deepEqual(
    await state.putAgent({
      record,
      mutation: request,
      expectedStatus: "READY_FOR_TEST",
    }),
    record,
  );
});

test("retesting a tested agent persists fresh success or failure with a conditional status check", async () => {
  for (const success of [true, false]) {
    const record = agent({
      status: success ? "TESTED" : "TEST_FAILED",
      lastTestStatus: success ? "SUCCEEDED" : "FAILED",
      lastTestedAt: NOW,
      lastTestedBySubject: "builder-sub-123",
      lastTestModelId: "anthropic.claude-sonnet",
      lastTestInputTokens: success ? 12 : 0,
      lastTestOutputTokens: success ? 7 : 0,
      lastTestRequestId: "gateway-retest-123",
      lastTestEvidenceHash: FINGERPRINT,
      lastTestOutput: success ? "Fresh model response." : null,
    });
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo);
    const request = updateMutationFor("AGENT", record, success ? {} : {
      decision: "abort",
      reason: "Gateway test failed with a retryable error.",
      result: { status: "FAILED" },
    });
    assert.deepEqual(await state.putAgent({
      record, mutation: request, expectedStatus: "TESTED",
    }), record);
    const put = dynamo.commands[0].input.TransactItems[0].Put;
    assert.match(put.ConditionExpression, /#status = :expectedStatus/);
    assert.deepEqual(put.ExpressionAttributeValues[":expectedStatus"], { S: "TESTED" });
  }
});

test("agent resource selections and test evidence fail closed when partial or unbounded", async () => {
  const state = await stateWith(recordingDynamo([]));
  const invalidRecords = [
    agent({ toolIds: ["case-search", "case-search"] }),
    agent({
      memoryIds: Array.from(
        { length: 21 },
        (_, index) => `memory-${index}`,
      ),
    }),
    agent({
      lastTestStatus: "SUCCEEDED",
    }),
    agent({
      status: "TESTED",
    }),
    agent({
      status: "TESTED",
      lastTestStatus: "SUCCEEDED",
      lastTestedAt: NOW,
      lastTestedBySubject: "builder-sub-123",
      lastTestModelId: "anthropic.claude-sonnet",
      lastTestInputTokens: -1,
      lastTestOutputTokens: 7,
      lastTestRequestId: "gateway-request-123",
      lastTestEvidenceHash: FINGERPRINT,
      lastTestOutput: "Test response.",
    }),
    agent({
      status: "TESTED",
      lastTestStatus: "SUCCEEDED",
      lastTestedAt: NOW,
      lastTestedBySubject: "builder-sub-123",
      lastTestModelId: "anthropic.claude-sonnet",
      lastTestInputTokens: 12,
      lastTestOutputTokens: 7,
      lastTestRequestId: "gateway-request-123",
      lastTestEvidenceHash: FINGERPRINT,
      lastTestOutput: "Unsafe\u0000output",
    }),
  ];

  for (const record of invalidRecords) {
    await assert.rejects(
      state.putAgent({
        record,
        mutation: createMutationFor("AGENT", record),
        expectedStatus: null,
      }),
      expectCode("INVALID_AGENT"),
    );
  }
});

test("memory and knowledge-base resources may be granted to a domain", async () => {
  for (const [resourceType, resourceId] of [
    ["MEMORY", "support-memory"],
    ["KNOWLEDGE_BASE", "support-kb"],
  ]) {
    const record = resourceGrant({ resourceType, resourceId });
    const state = await stateWith(recordingDynamo([{}]));
    assert.deepEqual(
      await state.putResourceGrant({
        record,
        mutation: createMutationFor("RESOURCE_GRANT", record),
        expectedStatus: null,
      }),
      record,
    );
  }
});

test("project member assignments use a bounded DynamoDB string list", async () => {
  const record = project({
    memberSubjects: [
      "builder-sub-123",
      "second-builder-sub-456",
    ],
  });
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);

  await state.putProject({
    record,
    mutation: createMutationFor("PROJECT", record),
    expectedStatus: null,
  });

  assert.deepEqual(
    dynamo.commands[0].input.TransactItems[0].Put.Item.memberSubjects,
    {
      L: [
        string("builder-sub-123"),
        string("second-builder-sub-456"),
      ],
    },
  );
});

test("project assignments reject duplicate, malformed, and oversized lists", async () => {
  const state = await stateWith(recordingDynamo([]));
  const invalidLists = [
    ["builder-sub-123", "builder-sub-123"],
    ["builder-sub-123", "subject with spaces"],
    Array.from({ length: 101 }, (_, index) => `builder-${index}`),
  ];

  for (const memberSubjects of invalidLists) {
    const record = project({ memberSubjects });
    await assert.rejects(
      state.putProject({
        record,
        mutation: createMutationFor("PROJECT", record),
        expectedStatus: null,
      }),
      expectCode("INVALID_PROJECT"),
    );
  }
});

test("domain IDs follow the canonical identity segment pattern", async () => {
  const state = await stateWith(recordingDynamo([]));

  for (const domainId of [
    "_customer",
    "customer_",
    "customer__support",
    "Customer_support",
    "admin",
    "platform-admin",
    "platform_admin",
    "lead",
    "domain-lead",
    "domain_lead",
    "builder",
    "domain-builder",
    "domain_builder",
    "user",
    "end-user",
    "end_user",
    "demo-operator",
    "demo_operator",
  ]) {
    const record = project({ domainId });
    await assert.rejects(
      state.putProject({
        record,
        mutation: createMutationFor("PROJECT", record, { domainId }),
        expectedStatus: null,
      }),
      expectCode("INVALID_PROJECT"),
    );
  }
});

test("production starts requested while sandbox may start deploying", async () => {
  const state = await stateWith(recordingDynamo([{}]));
  const invalidProduction = deployment({
    status: "DEPLOYING",
    approverSubject: "lead-sub-123",
    decisionReason: "Attempted direct production deployment.",
    decidedAt: NOW,
  });

  await assert.rejects(
    state.putDeployment({
      record: invalidProduction,
      mutation: createMutationFor("DEPLOYMENT", invalidProduction),
      expectedStatus: null,
    }),
    expectCode("INVALID_DEPLOYMENT_TRANSITION"),
  );

  const sandbox = deployment({
    id: "triage-agent-sandbox-001",
    environment: "SANDBOX",
    status: "DEPLOYING",
  });
  await state.putDeployment({
    record: sandbox,
    mutation: createMutationFor("DEPLOYMENT", sandbox),
    expectedStatus: null,
  });
});

test("deployed records preserve complete AgentCore Runtime endpoint identity", async () => {
  const deployedAt = "2026-08-25T01:03:03.000Z";
  const record = deployment({
    id: "triage-agent-sandbox-001",
    environment: "SANDBOX",
    status: "DEPLOYED",
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    runtimeArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567",
    runtimeStatus: "READY",
    endpointName: "Sandbox",
    endpointArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime-endpoint/Sandbox",
    runtimeVersion: "1",
    requestedAt: NOW,
    updatedAt: deployedAt,
  });
  const state = await stateWith(recordingDynamo([{}]), () => deployedAt);

  assert.deepEqual(
    await state.putDeployment({
      record,
      mutation: updateMutationFor("DEPLOYMENT", record, {
        timestamp: deployedAt,
        createdAt: deployedAt,
      }),
      expectedStatus: "DEPLOYING",
    }),
    record,
  );
});

test("deployed records reject partial AgentCore Runtime identity", async () => {
  const state = await stateWith(recordingDynamo([]));
  const record = deployment({
    id: "triage-agent-sandbox-001",
    environment: "SANDBOX",
    status: "DEPLOYED",
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    runtimeArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567",
    runtimeStatus: null,
  });

  await assert.rejects(
    state.putDeployment({
      record,
      mutation: updateMutationFor("DEPLOYMENT", record),
      expectedStatus: "DEPLOYING",
    }),
    expectCode("INVALID_DEPLOYMENT"),
  );
});

test("successful test evidence remains attached through deployment lifecycle", async () => {
  const record = agent({
    status: "SANDBOX_DEPLOYED",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: NOW,
    lastTestedBySubject: "builder-sub-123",
    lastTestModelId: "anthropic.claude",
    lastTestInputTokens: 10,
    lastTestOutputTokens: 5,
    lastTestRequestId: "gateway-request",
    lastTestEvidenceHash: "a".repeat(64),
    lastTestOutput: "Test response.",
  });
  const state = await stateWith(recordingDynamo([{}]));

  assert.deepEqual(
    await state.putAgent({
      record,
      mutation: updateMutationFor("AGENT", record),
      expectedStatus: "TESTED",
    }),
    record,
  );
});

test("approval kinds accept only compatible resource types", async () => {
  const state = await stateWith(recordingDynamo([]));
  const invalidApprovals = [
    approval({
      resourceType: "MODEL",
      resourceId: "anthropic.claude-sonnet",
    }),
    approval({
      kind: "RESOURCE_PUBLICATION",
      resourceType: "DEPLOYMENT",
    }),
    approval({
      kind: "RESOURCE_ACCESS",
      resourceType: "DEPLOYMENT",
    }),
  ];

  for (const record of invalidApprovals) {
    await assert.rejects(
      state.putApproval({
        record,
        mutation: createMutationFor("APPROVAL", record),
        expectedStatus: null,
      }),
      expectCode("INVALID_APPROVAL"),
    );
  }
});

const editableSameStateScenarios = [
  {
    name: "active project membership",
    method: "putProject",
    entityType: "PROJECT",
    expectedStatus: "ACTIVE",
    record: project({
      name: "Case Assist Updated",
      memberSubjects: [
        "builder-sub-123",
        "second-builder-sub-456",
      ],
    }),
  },
  {
    name: "draft agent",
    method: "putAgent",
    entityType: "AGENT",
    expectedStatus: "DRAFT",
    record: agent({
      description: "Updated draft configuration.",
      updatedAt: NOW,
    }),
  },
  {
    name: "ready agent",
    method: "putAgent",
    entityType: "AGENT",
    expectedStatus: "READY_FOR_TEST",
    record: agent({
      status: "READY_FOR_TEST",
      description: "Updated test-ready configuration.",
      updatedAt: NOW,
    }),
  },
  {
    name: "active personal session",
    method: "putSession",
    entityType: "SESSION",
    expectedStatus: "ACTIVE",
    record: session({
      lastInvocationStatus: "SUCCEEDED",
      updatedAt: NOW,
    }),
  },
];

for (const scenario of editableSameStateScenarios) {
  test(`${scenario.name} permits a controlled same-state update`, async () => {
    const state = await stateWith(recordingDynamo([{}]));
    const result = await state[scenario.method]({
      record: scenario.record,
      mutation: updateMutationFor(
        scenario.entityType,
        scenario.record,
      ),
      expectedStatus: scenario.expectedStatus,
    });
    assert.deepEqual(result, scenario.record);
  });
}

const forbiddenSameStateScenarios = [
  {
    method: "putProject",
    entityType: "PROJECT",
    status: "ARCHIVED",
    record: project({ status: "ARCHIVED" }),
    code: "INVALID_PROJECT_TRANSITION",
  },
  {
    method: "putAgent",
    entityType: "AGENT",
    status: "RETIRED",
    record: agent({ status: "RETIRED" }),
    code: "INVALID_AGENT_TRANSITION",
  },
  {
    method: "putDeployment",
    entityType: "DEPLOYMENT",
    status: "REQUESTED",
    record: deployment(),
    code: "INVALID_DEPLOYMENT_TRANSITION",
  },
  {
    method: "putApproval",
    entityType: "APPROVAL",
    status: "PENDING",
    record: approval(),
    code: "INVALID_APPROVAL_TRANSITION",
  },
  {
    method: "putResourceGrant",
    entityType: "RESOURCE_GRANT",
    status: "ACTIVE",
    record: resourceGrant(),
    code: "INVALID_RESOURCE_GRANT_TRANSITION",
  },
  {
    method: "putSession",
    entityType: "SESSION",
    status: "COMPLETED",
    record: session({
      status: "COMPLETED",
      lastInvocationStatus: "SUCCEEDED",
    }),
    code: "INVALID_SESSION_TRANSITION",
  },
];

for (const scenario of forbiddenSameStateScenarios) {
  test(`${scenario.entityType} ${scenario.status} cannot be rewritten in place`, async () => {
    const state = await stateWith(recordingDynamo([]));
    await assert.rejects(
      state[scenario.method]({
        record: scenario.record,
        mutation: updateMutationFor(
          scenario.entityType,
          scenario.record,
        ),
        expectedStatus: scenario.status,
      }),
      expectCode(scenario.code),
    );
  });
}

function approvedDeployment() {
  return deployment({
    status: "APPROVED",
    approverSubject: "lead-sub-123",
    decisionReason: "Approved for the production domain.",
    decidedAt: NOW,
    updatedAt: NOW,
  });
}

function approvedApproval() {
  return approval({
    status: "APPROVED",
    approverSubject: "lead-sub-123",
    reason: "Approved after domain review.",
    decidedAt: NOW,
  });
}

function revokedGrant() {
  return resourceGrant({
    status: "REVOKED",
    revokedBySubject: "lead-sub-456",
    revokedAt: NOW,
  });
}

function revokedEntitlement() {
  return entitlement({
    status: "REVOKED",
    revokedBySubject: "lead-sub-456",
    revokedAt: NOW,
  });
}

const immutableUpdateScenarios = [
  {
    name: "project",
    method: "putProject",
    entityType: "PROJECT",
    expectedStatus: "ACTIVE",
    record: project({ name: "Updated Case Assist" }),
    fields: {
      domainId: "customer_support",
      id: "case-assist",
      ownerSubject: "builder-sub-123",
      createdBySubject: "builder-sub-123",
      createdAt: NOW,
    },
  },
  {
    name: "agent",
    method: "putAgent",
    entityType: "AGENT",
    expectedStatus: "DRAFT",
    record: agent({
      description: "Updated draft.",
      updatedAt: NOW,
    }),
    fields: {
      domainId: "customer_support",
      projectId: "case-assist",
      id: "triage-agent",
      ownerSubject: "builder-sub-123",
      createdBySubject: "builder-sub-123",
      createdAt: NOW,
    },
  },
  {
    name: "deployment",
    method: "putDeployment",
    entityType: "DEPLOYMENT",
    expectedStatus: "REQUESTED",
    record: approvedDeployment(),
    fields: {
      domainId: "customer_support",
      projectId: "case-assist",
      id: "triage-agent-prod-001",
      agentId: "triage-agent",
      environment: "PRODUCTION",
      requesterSubject: "builder-sub-123",
      requestedAt: NOW,
    },
    mutation: {
      actor: "lead-sub-123",
      effectiveRole: "lead",
      decision: "approve",
      reason: "Approved for the production domain.",
    },
  },
  {
    name: "approval",
    method: "putApproval",
    entityType: "APPROVAL",
    expectedStatus: "PENDING",
    record: approvedApproval(),
    fields: {
      domainId: "customer_support",
      id: "approval-prod-001",
      kind: "PRODUCTION_DEPLOYMENT",
      resourceType: "DEPLOYMENT",
      resourceId: "triage-agent-prod-001",
      projectId: "case-assist",
      requesterSubject: "builder-sub-123",
      requestedAt: NOW,
    },
    mutation: {
      actor: "lead-sub-123",
      effectiveRole: "lead",
      decision: "approve",
      reason: "Approved after domain review.",
    },
  },
  {
    name: "resource grant",
    method: "putResourceGrant",
    entityType: "RESOURCE_GRANT",
    expectedStatus: "ACTIVE",
    record: revokedGrant(),
    fields: {
      domainId: "customer_support",
      resourceType: "MODEL",
      resourceId: "anthropic.claude-sonnet",
      grantedBySubject: "lead-sub-123",
      grantedAt: NOW,
    },
    mutation: {
      actor: "lead-sub-456",
      effectiveRole: "lead",
      projectId: null,
      decision: "revoke",
    },
  },
  {
    name: "entitlement",
    method: "putEntitlement",
    entityType: "ENTITLEMENT",
    expectedStatus: "ACTIVE",
    record: revokedEntitlement(),
    fields: {
      subject: "user-sub-123",
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      grantedBySubject: "lead-sub-123",
      grantedAt: NOW,
    },
    mutation: {
      actor: "lead-sub-456",
      effectiveRole: "lead",
      decision: "revoke",
    },
  },
  {
    name: "session",
    method: "putSession",
    entityType: "SESSION",
    expectedStatus: "ACTIVE",
    record: session({
      lastInvocationStatus: "SUCCEEDED",
      updatedAt: NOW,
    }),
    fields: {
      actor: "user-sub-123",
      id: "session-001",
      agentId: "triage-agent",
      domainId: "customer_support",
      projectId: "case-assist",
      createdAt: NOW,
    },
  },
];

for (const scenario of immutableUpdateScenarios) {
  test(`${scenario.name} update condition preserves immutable identity`, async () => {
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo);
    const request = updateMutationFor(
      scenario.entityType,
      scenario.record,
      scenario.mutation,
    );

    await state[scenario.method]({
      record: scenario.record,
      mutation: request,
      expectedStatus: scenario.expectedStatus,
    });

    const put = dynamo.commands[0].input.TransactItems[0].Put;
    assert.match(put.ConditionExpression, /#status = :expectedStatus/);
    for (const [field, expected] of Object.entries(scenario.fields)) {
      assert.equal(put.ExpressionAttributeNames[`#${field}`], field);
      assert.deepEqual(
        put.ExpressionAttributeValues[`:${field}`],
        nullableString(expected),
      );
      assert.match(
        put.ConditionExpression,
        new RegExp(`#${field} = :${field}`),
      );
    }
  });
}

test("approved decision evidence remains immutable through later cancellation", async () => {
  const cancelledAt = "2026-08-25T01:05:03.000Z";
  const approved = approvedDeployment();
  const cancelled = {
    ...approved,
    status: "CANCELLED",
    updatedAt: cancelledAt,
  };
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo, () => cancelledAt);

  await state.putDeployment({
    record: cancelled,
    mutation: updateMutationFor("DEPLOYMENT", cancelled, {
      actor: approved.approverSubject,
      effectiveRole: "lead",
      decision: "cancel",
      reason: "Cancelled after an operational issue.",
      timestamp: cancelledAt,
      createdAt: cancelledAt,
    }),
    expectedStatus: "APPROVED",
  });

  const put = dynamo.commands[0].input.TransactItems[0].Put;
  for (const field of [
    "approverSubject",
    "decisionReason",
    "decidedAt",
  ]) {
    assert.equal(put.ExpressionAttributeNames[`#${field}`], field);
    assert.deepEqual(
      put.ExpressionAttributeValues[`:${field}`],
      nullableString(approved[field]),
    );
    assert.match(
      put.ConditionExpression,
      new RegExp(`#${field} = :${field}`),
    );
  }

  const cancelledApproval = {
    ...approvedApproval(),
    status: "CANCELLED",
    approverSubject: null,
    reason: "Attempted cancellation after approval.",
  };
  await assert.rejects(
    state.putApproval({
      record: cancelledApproval,
      mutation: updateMutationFor("APPROVAL", cancelledApproval, {
        actor: cancelledApproval.requesterSubject,
        decision: "cancel",
        reason: cancelledApproval.reason,
      }),
      expectedStatus: "APPROVED",
    }),
    expectCode("INVALID_APPROVAL_TRANSITION"),
  );
});

test("requesters cannot approve their own approval or production deployment", async () => {
  const state = await stateWith(recordingDynamo([]));
  const selfApproved = approvedApproval();
  selfApproved.approverSubject = selfApproved.requesterSubject;
  const selfApprovedDeployment = approvedDeployment();
  selfApprovedDeployment.approverSubject =
    selfApprovedDeployment.requesterSubject;

  await assert.rejects(
    state.putApproval({
      record: selfApproved,
      mutation: updateMutationFor("APPROVAL", selfApproved, {
        actor: selfApproved.requesterSubject,
        decision: "approve",
        reason: selfApproved.reason,
      }),
      expectedStatus: "PENDING",
    }),
    expectCode("REQUESTER_CANNOT_APPROVE"),
  );
  await assert.rejects(
    state.putDeployment({
      record: selfApprovedDeployment,
      mutation: updateMutationFor(
        "DEPLOYMENT",
        selfApprovedDeployment,
        {
          actor: selfApprovedDeployment.requesterSubject,
          decision: "approve",
          reason: selfApprovedDeployment.decisionReason,
        },
      ),
      expectedStatus: "REQUESTED",
    }),
    expectCode("REQUESTER_CANNOT_APPROVE"),
  );
});

test("mutation actor, role, scope, decision, reason, and timestamp are strict", async () => {
  const state = await stateWith(recordingDynamo([]));
  const record = project();
  const base = createMutationFor("PROJECT", record);
  const invalidMutations = [
    { ...base, actor: "other-subject" },
    { ...base, requesterSubject: "other-subject" },
    { ...base, effectiveRole: "super-admin" },
    { ...base, domainId: "finance" },
    { ...base, projectId: "other-project" },
    { ...base, decision: "" },
    { ...base, reason: "" },
    {
      ...base,
      timestamp: "2026-08-25T01:01:03.000Z",
    },
  ];

  const expectedCodes = [
    "ACTOR_MISMATCH",
    "MUTATION_REQUESTER_MISMATCH",
    "INVALID_MUTATION",
    "MUTATION_SCOPE_MISMATCH",
    "MUTATION_SCOPE_MISMATCH",
    "INVALID_MUTATION",
    "INVALID_MUTATION",
    "INVALID_MUTATION",
  ];
  for (let index = 0; index < invalidMutations.length; index += 1) {
    await assert.rejects(
      state.putProject({
        record,
        mutation: invalidMutations[index],
        expectedStatus: null,
      }),
      expectCode(expectedCodes[index]),
    );
  }
});

test("entity, audit, and mutation event timestamps match the transaction clock", async () => {
  const past = "2026-08-25T01:01:03.000Z";
  const future = "2026-08-25T01:03:03.000Z";
  const state = await stateWith(recordingDynamo([]));

  for (const createdAt of [past, future]) {
    const record = project({ createdAt });
    await assert.rejects(
      state.putProject({
        record,
        mutation: createMutationFor("PROJECT", record),
        expectedStatus: null,
      }),
      expectCode("INVALID_PROJECT"),
    );
  }

  for (const timestamp of [past, future]) {
    const record = project();
    const request = createMutationFor("PROJECT", record, {
      timestamp,
      createdAt: timestamp,
    });
    await assert.rejects(
      state.putProject({
        record,
        mutation: request,
        expectedStatus: null,
      }),
      expectCode("INVALID_MUTATION"),
    );
  }

  const updatedAgent = agent({ updatedAt: future });
  await assert.rejects(
    state.putAgent({
      record: updatedAgent,
      mutation: updateMutationFor("AGENT", updatedAgent),
      expectedStatus: "DRAFT",
    }),
    expectCode("INVALID_AGENT"),
  );

  const auditRecord = audit({ timestamp: past });
  await assert.rejects(
    state.appendAudit({
      record: auditRecord,
      mutation: mutation(
        "WORKSPACE_AUDIT",
        `audit/${auditRecord.resource}/${past}/${auditRecord.requestId}`,
        {
          actor: auditRecord.actor,
          requesterSubject: auditRecord.requesterSubject,
          effectiveRole: auditRecord.effectiveRole,
          domainId: auditRecord.domainId,
          projectId: auditRecord.projectId,
          route: "POST /api/deployment-decisions",
          requestId: auditRecord.requestId,
          decision: auditRecord.decision,
          reason: auditRecord.reason,
          timestamp: past,
          createdAt: past,
          result: { operation: "APPEND" },
        },
      ),
    }),
    expectCode("INVALID_AUDIT"),
  );
});

test("opaque transaction clocks anchor a write without sampling time twice", async () => {
  const later = "2026-08-25T01:02:04.000Z";
  const timestamps = [NOW, later];
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo, () => timestamps.shift());
  const transaction = state.beginTransaction();
  const record = project({ createdAt: transaction.timestamp });
  const request = createMutationFor("PROJECT", record, {
    timestamp: transaction.timestamp,
    createdAt: transaction.timestamp,
  });

  assert.deepEqual(
    await state.putProject({
      record,
      mutation: request,
      expectedStatus: null,
      transaction,
    }),
    record,
  );
  assert.deepEqual(timestamps, [later]);
});

test("opaque transaction clocks anchor audit completion without sampling time twice", async () => {
  const later = "2026-08-25T01:02:04.000Z";
  const timestamps = [NOW, later];
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo, () => timestamps.shift());
  const transaction = state.beginTransaction();
  const record = audit({ timestamp: transaction.timestamp });
  const request = mutation(
    "WORKSPACE_AUDIT",
    `audit/${record.resource}/${record.timestamp}/${record.requestId}`,
    {
      actor: record.actor,
      requesterSubject: record.requesterSubject,
      effectiveRole: record.effectiveRole,
      domainId: record.domainId,
      projectId: record.projectId,
      route: "POST /api/deployment-decisions",
      requestId: record.requestId,
      decision: record.decision,
      reason: record.reason,
      timestamp: record.timestamp,
      createdAt: record.timestamp,
      result: { operation: "APPEND" },
    },
  );

  assert.deepEqual(
    await state.appendAudit({
      record,
      mutation: request,
      transaction,
    }),
    record,
  );
  assert.deepEqual(timestamps, [later]);
});

test("transaction clocks are state-bound, opaque, and single-use", async () => {
  const first = await stateWith(recordingDynamo([{}]));
  const second = await stateWith(recordingDynamo([]));
  const transaction = first.beginTransaction();
  const record = project({ createdAt: transaction.timestamp });
  const request = createMutationFor("PROJECT", record, {
    timestamp: transaction.timestamp,
    createdAt: transaction.timestamp,
  });

  await first.putProject({
    record,
    mutation: request,
    expectedStatus: null,
    transaction,
  });

  for (const [state, candidate] of [
    [first, transaction],
    [second, transaction],
    [
      second,
      Object.freeze({
        timestamp: transaction.timestamp,
        epochSeconds: transaction.epochSeconds,
      }),
    ],
  ]) {
    await assert.rejects(
      state.putProject({
        record,
        mutation: request,
        expectedStatus: null,
        transaction: candidate,
      }),
      expectCode("INVALID_TRANSACTION"),
    );
  }
});

test("approval decision audit metadata must match the decision record", async () => {
  const state = await stateWith(recordingDynamo([]));
  const record = approvedApproval();

  await assert.rejects(
    state.putApproval({
      record,
      mutation: updateMutationFor("APPROVAL", record, {
        actor: record.approverSubject,
        effectiveRole: "lead",
        decision: "reject",
        reason: record.reason,
      }),
      expectedStatus: "PENDING",
    }),
    expectCode("MUTATION_DECISION_MISMATCH"),
  );
  await assert.rejects(
    state.putApproval({
      record,
      mutation: updateMutationFor("APPROVAL", record, {
        actor: record.approverSubject,
        effectiveRole: "lead",
        decision: "approve",
        reason: "Different reason.",
      }),
      expectedStatus: "PENDING",
    }),
    expectCode("MUTATION_DECISION_MISMATCH"),
  );
});

test("approval audit preserves requester and decision actor separately", async () => {
  const record = approvedApproval();
  const request = updateMutationFor("APPROVAL", record, {
    actor: record.approverSubject,
    effectiveRole: "lead",
    decision: "approve",
    reason: record.reason,
  });
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);

  await state.putApproval({
    record,
    mutation: request,
    expectedStatus: "PENDING",
  });

  const auditWrite = dynamo.commands[0].input.TransactItems[1].Put;
  assert.deepEqual(auditWrite.Item, auditItem(mutationAudit(request)));
  assert.equal(auditWrite.Item.requesterSubject.S, record.requesterSubject);
  assert.equal(auditWrite.Item.actor.S, record.approverSubject);
});

function transactionCancellation(codes) {
  return new TransactionCanceledException({
    $metadata: {},
    message: "cancelled",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

test("conditional conflicts replay only the original committed entity", async () => {
  const requested = project();
  const changed = project({
    name: "Authoritative Case Assist",
    description: "Changed after the original request committed.",
    memberSubjects: [
      "builder-sub-123",
      "second-builder-sub-456",
    ],
  });
  const request = createMutationFor("PROJECT", requested);
  const cancellationPatterns = [
    ["ConditionalCheckFailed", "None", "None"],
    ["None", "ConditionalCheckFailed", "None"],
    ["None", "None", "ConditionalCheckFailed"],
    [
      "ConditionalCheckFailed",
      "ConditionalCheckFailed",
      "ConditionalCheckFailed",
    ],
  ];

  for (const pattern of cancellationPatterns) {
    const dynamo = recordingDynamo([
      transactionCancellation(pattern),
      { Item: mutationItem(request) },
      { Item: projectItem(requested) },
    ]);
    const state = await stateWith(dynamo);

    const result = await state.putProject({
      record: requested,
      mutation: request,
      expectedStatus: null,
    });

    assert.deepEqual(result, requested);
    assert.ok(dynamo.commands[1] instanceof GetItemCommand);
    assert.deepEqual(dynamo.commands[1].input.Key, {
      pk: string(`MUTATION#${request.actor}`),
      sk: string(`MUTATION#${request.route}#${request.requestId}`),
    });
    assert.deepEqual(dynamo.commands[2].input.Key, {
      pk: string("PROJECT#customer_support"),
      sk: string("PROJECT#case-assist"),
    });
  }

  const state = await stateWith(recordingDynamo([
    transactionCancellation([
      "None",
      "None",
      "ConditionalCheckFailed",
    ]),
    { Item: mutationItem(request) },
    { Item: projectItem(changed) },
  ]));
  await assert.rejects(
    state.putProject({
      record: requested,
      mutation: request,
      expectedStatus: null,
    }),
    expectCode("MUTATION_CONFLICT"),
  );
});

test("idempotent replay requires exact mutation and scope metadata", async () => {
  const record = project();
  const request = createMutationFor("PROJECT", record);
  const mismatches = [
    { payloadFingerprint: "b".repeat(64) },
    { requesterSubject: "other-builder-sub" },
    { effectiveRole: "admin" },
    { domainId: "finance" },
    { projectId: "other-project" },
    { decision: "update" },
    { reason: "Different reason." },
    { timestamp: "2026-08-25T01:01:03.000Z" },
    {
      result: {
        ...request.result,
        resourceKey: "project/customer_support/other-project",
      },
    },
    {
      result: {
        ...request.result,
        operation: "UPDATE",
      },
    },
    {
      result: {
        ...request.result,
        status: "FAILED",
      },
    },
  ];

  for (const mismatch of mismatches) {
    const stored = {
      ...request,
      ...mismatch,
    };
    const dynamo = recordingDynamo([
      transactionCancellation([
        "None",
        "None",
        "ConditionalCheckFailed",
      ]),
      { Item: mutationItem(stored) },
    ]);
    const state = await stateWith(dynamo);

    await assert.rejects(
      state.putProject({
        record,
        mutation: request,
        expectedStatus: null,
      }),
      (error) => {
        assert.equal(error.code, "MUTATION_CONFLICT");
        assert.doesNotMatch(error.message, /customer_support|case-assist/);
        return true;
      },
    );
    assert.equal(dynamo.commands.length, 2);
  }
});

test("idempotent replay fails closed when mutation or entity is absent", async () => {
  const record = project();
  const request = createMutationFor("PROJECT", record);
  const cancellation = transactionCancellation([
    "None",
    "None",
    "ConditionalCheckFailed",
  ]);

  for (const responses of [
    [cancellation, {}],
    [cancellation, { Item: mutationItem(request) }, {}],
  ]) {
    const state = await stateWith(recordingDynamo(responses));
    await assert.rejects(
      state.putProject({
        record,
        mutation: request,
        expectedStatus: null,
      }),
      expectCode("MUTATION_CONFLICT"),
    );
  }
});

test("non-conditional transaction cancellation is not treated as replay", async () => {
  const error = transactionCancellation([
    "ValidationError",
    "None",
    "None",
  ]);
  const state = await stateWith(recordingDynamo([error]));
  const record = project();

  await assert.rejects(
    state.putProject({
      record,
      mutation: createMutationFor("PROJECT", record),
      expectedStatus: null,
    }),
    (caught) => caught === error,
  );
});

test("standalone audit metadata is exactly bound to its mutation", async () => {
  const record = audit();
  const state = await stateWith(recordingDynamo([]));
  const mismatches = [
    { actor: "other-lead-sub" },
    { requesterSubject: "other-builder-sub" },
    { effectiveRole: "admin" },
    { domainId: "finance" },
    { projectId: "other-project" },
    { requestId: "other-request" },
    { decision: "reject" },
    { reason: "Different reason." },
  ];

  for (const mismatch of mismatches) {
    await assert.rejects(
      state.appendAudit({
        record,
        mutation: appendMutationForAudit(record, mismatch),
      }),
      expectCode(
        Object.hasOwn(mismatch, "actor")
          ? "ACTOR_MISMATCH"
          : "MUTATION_AUDIT_MISMATCH",
      ),
    );
  }
});

test("standalone audit append remains immutable and idempotent", async () => {
  const record = audit();
  const request = appendMutationForAudit(record);
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);

  const result = await state.appendAudit({
    record,
    mutation: request,
  });

  assert.deepEqual(result, record);
  const [auditWrite, mutationWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(auditWrite.Put.Item, auditItem(record));
  assert.deepEqual(mutationWrite.Put.Item, mutationItem(request));
});

test("mutation abort writes terminal evidence without changing the entity", async () => {
  const record = project();
  const request = createMutationFor("PROJECT", record, {
    decision: "abort",
    reason: "UPSTREAM_WORKFLOW_FAILED",
    result: { status: "FAILED" },
  });
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.abortMutation({ mutation: request }),
    request,
  );
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  const writes = dynamo.commands[0].input.TransactItems;
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].Put.Item, auditItem(mutationAudit(request)));
  assert.deepEqual(writes[1].Put.Item, mutationItem(request));
  assert.equal(
    writes.some(({ Put }) => Put.Item.entityType?.S === "PROJECT"),
    false,
  );
  assert.ok(writes.every(({ Put }) => Put.ConditionExpression));

  const replayState = await stateWith(recordingDynamo([
    transactionCancellation([
      "ConditionalCheckFailed",
      "ConditionalCheckFailed",
    ]),
    { Item: mutationItem(request) },
    { Item: auditItem(mutationAudit(request)) },
  ]));
  assert.deepEqual(
    await replayState.abortMutation({ mutation: request }),
    request,
  );

  await assert.rejects(
    state.putProject({
      record,
      mutation: request,
      expectedStatus: null,
    }),
    expectCode("INVALID_MUTATION"),
  );
});

test("project listing requires explicit domain scope and bounded pages", async () => {
  const value = project();
  const lastKey = {
    pk: string("PROJECT#customer_support"),
    sk: string("PROJECT#next-project"),
  };
  const dynamo = recordingDynamo([{
    Items: [projectItem(value)],
    LastEvaluatedKey: lastKey,
  }]);
  const state = await stateWith(dynamo);

  const page = await state.listProjects({
    domainId: "customer_support",
    limit: 25,
  });

  assert.deepEqual(page, {
    items: [value],
    cursor: {
      pk: "PROJECT#customer_support",
      sk: "PROJECT#next-project",
    },
  });
  assert.ok(dynamo.commands[0] instanceof QueryCommand);
  assert.equal(dynamo.commands[0].input.Limit, 25);
  await assert.rejects(
    state.listProjects({ limit: 25 }),
    expectCode("INVALID_PROJECT_SCOPE"),
  );
  await assert.rejects(
    state.listProjects({
      domainId: "customer_support",
      limit: 101,
    }),
    expectCode("INVALID_READ_OPTIONS"),
  );
});

test("scoped reads preserve real abort signals", async () => {
  const controller = new AbortController();
  const dynamo = recordingDynamo([{ Items: [] }]);
  const state = await stateWith(dynamo);

  await state.listProjects({
    domainId: "customer_support",
    abortSignal: controller.signal,
  });

  assert.equal(dynamo.options[0].abortSignal, controller.signal);
});

test("agent listing requires domain and project and may bind an owner", async () => {
  const value = agent();
  const dynamo = recordingDynamo([{ Items: [agentItem(value)] }]);
  const state = await stateWith(dynamo);

  const page = await state.listAgents({
    domainId: "customer_support",
    projectId: "case-assist",
    ownerSubject: "builder-sub-123",
  });

  assert.deepEqual(page, { items: [value], cursor: null });
  const query = dynamo.commands[0].input;
  assert.equal(
    query.ExpressionAttributeValues[":pk"].S,
    "AGENT#customer_support#case-assist",
  );
  assert.equal(query.FilterExpression, "#ownerSubject = :ownerSubject");
  await assert.rejects(
    state.listAgents({ domainId: "customer_support" }),
    expectCode("INVALID_AGENT_SCOPE"),
  );
});

test("incident listing is partitioned by domain and can bind the immutable project owner", async () => {
  const value = incident();
  const dynamo = recordingDynamo([{ Items: [incidentItem(value)] }]);
  const state = await stateWith(dynamo);

  const page = await state.listIncidents({
    domainId: "customer_support",
    ownerSubject: "builder-sub-123",
    limit: 25,
  });

  assert.deepEqual(page, { items: [value], cursor: null });
  const query = dynamo.commands[0].input;
  assert.ok(dynamo.commands[0] instanceof QueryCommand);
  assert.equal(
    query.ExpressionAttributeValues[":pk"].S,
    "INCIDENT#customer_support",
  );
  assert.equal(query.FilterExpression, "#ownerSubject = :ownerSubject");
  await assert.rejects(
    state.listIncidents({ ownerSubject: "builder-sub-123" }),
    expectCode("INVALID_INCIDENT_SCOPE"),
  );
});

test("filtered incident reads fill the requested page across DynamoDB query pages", async () => {
  const value = incident();
  const firstCursor = {
    pk: string("INCIDENT#customer_support"),
    sk: string("INCIDENT#foreign-owner"),
  };
  const dynamo = recordingDynamo([
    { Items: [], LastEvaluatedKey: firstCursor },
    { Items: [incidentItem(value)] },
  ]);
  const state = await stateWith(dynamo);

  const page = await state.listIncidents({
    domainId: "customer_support",
    ownerSubject: "builder-sub-123",
    limit: 1,
  });

  assert.deepEqual(page, { items: [value], cursor: null });
  assert.equal(dynamo.commands.length, 2);
  assert.deepEqual(
    dynamo.commands[1].input.ExclusiveStartKey,
    firstCursor,
  );
});

test("break-glass listing is a bounded admin partition query with optional requester scope", async () => {
  const value = breakGlass();
  const dynamo = recordingDynamo([{ Items: [breakGlassItem(value)] }]);
  const state = await stateWith(dynamo);

  const page = await state.listBreakGlass({
    requesterSubject: "admin-requester-sub",
  });

  assert.deepEqual(page, { items: [value], cursor: null });
  const query = dynamo.commands[0].input;
  assert.ok(dynamo.commands[0] instanceof QueryCommand);
  assert.equal(query.ExpressionAttributeValues[":pk"].S, "BREAK_GLASS");
  assert.equal(
    query.FilterExpression,
    "#requesterSubject = :requesterSubject",
  );
  await assert.rejects(
    state.listBreakGlass({ requesterSubject: "invalid subject" }),
    expectCode("INVALID_BREAK_GLASS_SCOPE"),
  );
});

test("audit metadata index query is role-scopeable and projects no trace content", async () => {
  const value = audit();
  const dynamo = recordingDynamo([{ Items: [auditItem(value)] }]);
  const state = await stateWith(dynamo);

  const page = await state.listAuditMetadata({
    domainId: "customer_support",
    limit: 25,
  });

  assert.deepEqual(page, { items: [value], cursor: null });
  const query = dynamo.commands[0].input;
  assert.ok(dynamo.commands[0] instanceof QueryCommand);
  assert.equal(query.IndexName, "EntityTypeIndex");
  assert.equal(query.Limit, 25);
  assert.equal(query.KeyConditionExpression, "#entityType = :auditType");
  assert.match(query.FilterExpression, /#domainId = :domainId/);
  assert.doesNotMatch(query.ProjectionExpression, /trace/i);
  await assert.rejects(
    state.listAuditMetadata({ domainId: "finance operations" }),
    expectCode("INVALID_AUDIT_SCOPE"),
  );
});

test("filtered audit reads fill the requested page across DynamoDB index pages", async () => {
  const value = audit();
  const firstCursor = {
    entityType: string("WORKSPACE_AUDIT"),
    pk: string("PROJECT#customer_support"),
    sk: string("PROJECT#case-assist"),
  };
  const dynamo = recordingDynamo([
    { Items: [], LastEvaluatedKey: firstCursor },
    { Items: [auditItem(value)] },
  ]);
  const state = await stateWith(dynamo);

  const page = await state.listAuditMetadata({
    domainId: "customer_support",
    limit: 1,
  });

  assert.deepEqual(page, { items: [value], cursor: null });
  assert.equal(dynamo.commands.length, 2);
  assert.deepEqual(
    dynamo.commands[1].input.ExclusiveStartKey,
    firstCursor,
  );
});

test("access request listing uses the approval index and binds the immutable requester", async () => {
  const value = approval({
    kind: "RESOURCE_ACCESS",
    resourceType: "AGENT",
  });
  const dynamo = recordingDynamo([{ Items: [approvalItem(value)] }]);
  const state = await stateWith(dynamo);

  const page = await state.listAccessRequests({
    requesterSubject: value.requesterSubject,
    limit: 25,
  });

  assert.deepEqual(page, { items: [value], cursor: null });
  const query = dynamo.commands[0].input;
  assert.ok(dynamo.commands[0] instanceof QueryCommand);
  assert.equal(query.IndexName, "EntityTypeIndex");
  assert.equal(
    query.KeyConditionExpression,
    "#entityType = :approvalType",
  );
  assert.equal(
    query.FilterExpression,
    "#requesterSubject = :requesterSubject AND "
      + "#kind = :kind AND #resourceType = :resourceType",
  );
  assert.equal(
    query.ExpressionAttributeValues[":requesterSubject"].S,
    value.requesterSubject,
  );
  await assert.rejects(
    state.listAccessRequests({ requesterSubject: "invalid subject" }),
    expectCode("INVALID_APPROVAL_SCOPE"),
  );
});

const scopedLists = [
  {
    method: "listDeployments",
    scope: {
      domainId: "customer_support",
      projectId: "case-assist",
    },
    invalidScope: { domainId: "customer_support" },
    code: "INVALID_DEPLOYMENT_SCOPE",
    pk: "DEPLOYMENT#customer_support#case-assist",
    prefix: "DEPLOYMENT#",
    item: deploymentItem(),
    record: deployment(),
  },
  {
    method: "listApprovals",
    scope: { domainId: "customer_support" },
    invalidScope: {},
    code: "INVALID_APPROVAL_SCOPE",
    pk: "APPROVAL#customer_support",
    prefix: "APPROVAL#",
    item: approvalItem(),
    record: approval(),
  },
  {
    method: "listResourceGrants",
    scope: { domainId: "customer_support" },
    invalidScope: {},
    code: "INVALID_RESOURCE_GRANT_SCOPE",
    pk: "GRANT#customer_support",
    prefix: "GRANT#",
    item: grantItem(),
    record: resourceGrant(),
  },
  {
    method: "listEntitlements",
    scope: { subject: "user-sub-123" },
    invalidScope: {},
    code: "INVALID_ENTITLEMENT_SCOPE",
    pk: "ENTITLEMENT#user-sub-123",
    prefix: "AGENT#",
    item: entitlementItem(),
    record: entitlement(),
  },
  {
    method: "listSessions",
    scope: { actor: "user-sub-123" },
    invalidScope: {},
    code: "INVALID_SESSION_SCOPE",
    pk: "SESSION#user-sub-123",
    prefix: "SESSION#",
    item: sessionItem(),
    record: session(),
  },
  {
    method: "listAudits",
    scope: {
      resource:
        "deployment/customer_support/case-assist/triage-agent-prod-001",
    },
    invalidScope: {},
    code: "INVALID_AUDIT_SCOPE",
    pk:
      "AUDIT#deployment/customer_support/case-assist/"
      + "triage-agent-prod-001",
    prefix: `${NOW}#`,
    item: auditItem(),
    record: audit(),
  },
];

test("grant queries exclude bootstrap catalog policy documents in the same partition", async () => {
  const dynamo = recordingDynamo([{ Items: [grantItem()] }]);
  const state = await stateWith(dynamo);
  const result = await state.listResourceGrants({ domainId: "customer_support" });
  assert.deepEqual(result.items, [resourceGrant()]);
  const query = dynamo.commands[0].input;
  assert.equal(query.KeyConditionExpression, "#pk = :pk AND begins_with(#sk, :skPrefix)");
  assert.equal(query.ExpressionAttributeNames["#sk"], "sk");
  assert.equal(query.ExpressionAttributeValues[":skPrefix"].S, "GRANT#");
  assert.equal(query.FilterExpression, undefined);
});

for (const scenario of scopedLists) {
  test(`${scenario.method} queries only its explicit partition`, async () => {
    const dynamo = recordingDynamo([{ Items: [scenario.item] }]);
    const state = await stateWith(dynamo);

    const page = await state[scenario.method](scenario.scope);

    assert.deepEqual(page, {
      items: [scenario.record],
      cursor: null,
    });
    assert.equal(
      dynamo.commands[0].input.ExpressionAttributeValues[":pk"].S,
      scenario.pk,
    );
    await assert.rejects(
      state[scenario.method](scenario.invalidScope),
      expectCode(scenario.code),
    );
  });
}

test("caller cursors cannot cross partitions or sort-key families", async () => {
  const state = await stateWith(recordingDynamo([]));
  const cursors = [
    {
      pk: "PROJECT#finance",
      sk: "PROJECT#forecasting",
    },
    {
      pk: "PROJECT#customer_support",
      sk: "AGENT#triage-agent",
    },
  ];

  for (const cursor of cursors) {
    await assert.rejects(
      state.listProjects({
        domainId: "customer_support",
        cursor,
      }),
      expectCode("INVALID_READ_OPTIONS"),
    );
  }
});

test("DynamoDB cursors must retain the scoped sort-key prefix", async () => {
  const state = await stateWith(recordingDynamo([{
    Items: [],
    LastEvaluatedKey: {
      pk: string("PROJECT#customer_support"),
      sk: string("AGENT#triage-agent"),
    },
  }]));

  await assert.rejects(
    state.listProjects({ domainId: "customer_support" }),
    expectCode("MALFORMED_DYNAMODB_RESPONSE"),
  );
});

const missingGets = [
  {
    method: "getProject",
    scope: { domainId: "customer_support", projectId: "case-assist" },
    pk: "PROJECT#customer_support",
    sk: "PROJECT#case-assist",
  },
  {
    method: "getAgent",
    scope: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    pk: "AGENT#customer_support#case-assist",
    sk: "AGENT#triage-agent",
  },
  {
    method: "getDeployment",
    scope: {
      domainId: "customer_support",
      projectId: "case-assist",
      deploymentId: "triage-agent-prod-001",
    },
    pk: "DEPLOYMENT#customer_support#case-assist",
    sk: "DEPLOYMENT#triage-agent-prod-001",
  },
  {
    method: "getApproval",
    scope: {
      domainId: "customer_support",
      approvalId: "approval-prod-001",
    },
    pk: "APPROVAL#customer_support",
    sk: "APPROVAL#approval-prod-001",
  },
  {
    method: "getResourceGrant",
    scope: {
      domainId: "customer_support",
      resourceType: "MODEL",
      resourceId: "anthropic.claude-sonnet",
    },
    pk: "GRANT#customer_support",
    sk: "GRANT#MODEL#anthropic.claude-sonnet",
  },
  {
    method: "getEntitlement",
    scope: {
      subject: "user-sub-123",
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    pk: "ENTITLEMENT#user-sub-123",
    sk: "AGENT#customer_support#case-assist#triage-agent",
  },
  {
    method: "getSession",
    scope: {
      actor: "user-sub-123",
      sessionId: "session-001",
    },
    pk: "SESSION#user-sub-123",
    sk: "SESSION#session-001",
  },
  {
    method: "getIncident",
    scope: {
      domainId: "customer_support",
      incidentId: "incident-001",
    },
    pk: "INCIDENT#customer_support",
    sk: "INCIDENT#incident-001",
  },
  {
    method: "getBreakGlass",
    scope: {
      breakGlassId: "break-glass-001",
    },
    pk: "BREAK_GLASS",
    sk: "BREAK_GLASS#break-glass-001",
  },
];

for (const scenario of missingGets) {
  test(`${scenario.method} returns non-disclosing null for absence`, async () => {
    const dynamo = recordingDynamo([{}]);
    const state = await stateWith(dynamo);

    const result = await state[scenario.method](scenario.scope);

    assert.equal(result, null);
    assert.ok(dynamo.commands[0] instanceof GetItemCommand);
    assert.deepEqual(dynamo.commands[0].input.Key, {
      pk: string(scenario.pk),
      sk: string(scenario.sk),
    });
  });
}

test("entitlement lookup requires subject, domain, project, and agent", async () => {
  const state = await stateWith(recordingDynamo([]));

  await assert.rejects(
    state.getEntitlement({
      subject: "user-sub-123",
      agentId: "triage-agent",
    }),
    expectCode("INVALID_ENTITLEMENT_SCOPE"),
  );
});

test("mutation lookup preserves durable immutable metadata", async () => {
  const record = project();
  const request = createMutationFor("PROJECT", record);
  const historical = {
    ...request,
    requestId: "historical-request",
    timestamp: "2026-08-24T01:02:03.000Z",
    createdAt: "2026-08-24T01:02:03.000Z",
  };
  const dynamo = recordingDynamo([
    { Item: mutationItem(request) },
    { Item: mutationItem(historical) },
    {},
  ]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.getMutationResult({
      actor: request.actor,
      route: request.route,
      requestId: request.requestId,
    }),
    request,
  );
  assert.deepEqual(
    await state.getMutationResult({
      actor: request.actor,
      route: request.route,
      requestId: historical.requestId,
    }),
    historical,
  );
  assert.equal(
    await state.getMutationResult({
      actor: request.actor,
      route: request.route,
      requestId: "missing-request",
    }),
    null,
  );
});

test("mutation lookup preserves access administration replay completion", async () => {
  const request = {
    ...mutation(
      "WORKSPACE_AUDIT",
      "audit/domain-membership/customer_support/member-sub/"
        + `${NOW}/membership-request-001`,
      {
        actor: "lead-sub",
        requesterSubject: "member-sub",
        effectiveRole: "lead",
        domainId: "customer_support",
        projectId: null,
        route: "POST /api/access/domain-memberships",
        requestId: "membership-request-001",
        payloadFingerprint: FINGERPRINT,
        decision: "grant",
        reason: "Assign the approved user to this domain.",
        result: {
          operation: "APPEND",
          accessAdmin: {
            username: "member.one",
            subject: "member-sub",
            membershipStatus: "ACTIVE",
            changed: true,
          },
        },
      },
    ),
  };
  const dynamo = recordingDynamo([{ Item: mutationItem(request) }]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.getMutationResult({
      actor: request.actor,
      route: request.route,
      requestId: request.requestId,
    }),
    request,
  );
});

test("mutation claims permit only one side-effecting request at a time", async () => {
  const claim = mutationClaim();
  const conflict = Object.assign(new Error("conditional conflict"), {
    name: "ConditionalCheckFailedException",
  });
  const dynamo = recordingDynamo([
    {},
    conflict,
    { Item: mutationClaimItem(claim) },
  ]);
  const state = await stateWith(dynamo);

  assert.equal(await state.claimMutation(claim), true);
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.match(
    dynamo.commands[0].input.ConditionExpression,
    /attribute_not_exists/,
  );
  assert.equal(
    Object.hasOwn(dynamo.commands[0].input.Item, "expiresAt"),
    false,
  );
  await assert.rejects(
    state.claimMutation(claim),
    expectCode("MUTATION_IN_PROGRESS"),
  );
  assert.ok(dynamo.commands[2] instanceof GetItemCommand);
});

test("mutation claims fail closed when a request ID is reused for new work", async () => {
  const claim = mutationClaim();
  const conflict = Object.assign(new Error("conditional conflict"), {
    name: "ConditionalCheckFailedException",
  });
  const dynamo = recordingDynamo([
    conflict,
    {
      Item: mutationClaimItem({
        ...claim,
        payloadFingerprint: "b".repeat(64),
      }),
    },
  ]);
  const state = await stateWith(dynamo);

  await assert.rejects(
    state.claimMutation(claim),
    expectCode("MUTATION_CONFLICT"),
  );
});

test("legacy expired mutation claims remain permanent request bindings", async () => {
  const claim = mutationClaim();
  const conflict = Object.assign(new Error("conditional conflict"), {
    name: "ConditionalCheckFailedException",
  });
  const dynamo = recordingDynamo([
    conflict,
    {
      Item: mutationClaimItem(claim, {
        legacyExpiresAt: NOW_EPOCH + 1,
      }),
    },
  ]);
  const state = await stateWith(
    dynamo,
    () => "2026-08-25T01:04:03.000Z",
  );

  await assert.rejects(
    state.claimMutation(claim),
    expectCode("MUTATION_IN_PROGRESS"),
  );
});

test("legacy expired mutation claims cannot be rebound to new work", async () => {
  const claim = mutationClaim();
  const conflict = Object.assign(new Error("conditional conflict"), {
    name: "ConditionalCheckFailedException",
  });
  const dynamo = recordingDynamo([
    conflict,
    {
      Item: mutationClaimItem(
        {
          ...claim,
          payloadFingerprint: "b".repeat(64),
        },
        {
          legacyExpiresAt: NOW_EPOCH + 1,
        },
      ),
    },
  ]);
  const state = await stateWith(
    dynamo,
    () => "2026-08-25T01:04:03.000Z",
  );

  await assert.rejects(
    state.claimMutation(claim),
    expectCode("MUTATION_CONFLICT"),
  );
});

test("stored mutation claims reject malformed project identifiers", async () => {
  const claim = mutationClaim();
  const conflict = Object.assign(new Error("conditional conflict"), {
    name: "ConditionalCheckFailedException",
  });
  const dynamo = recordingDynamo([
    conflict,
    {
      Item: mutationClaimItem({
        ...claim,
        projectId: "NOT A PROJECT",
      }),
    },
  ]);
  const state = await stateWith(dynamo);

  await assert.rejects(
    state.claimMutation(claim),
    expectCode("MALFORMED_DYNAMODB_RESPONSE"),
  );
});

test("malformed project membership and DynamoDB pages fail closed", async () => {
  const malformedProject = {
    ...projectItem(),
    memberSubjects: { SS: ["builder-sub-123"] },
  };
  const state = await stateWith(recordingDynamo([
    { Items: [malformedProject] },
  ]));

  await assert.rejects(
    state.listProjects({ domainId: "customer_support" }),
    expectCode("MALFORMED_DYNAMODB_RESPONSE"),
  );
});

test("project member listing is deterministic, paginated, and uses an exact consistent read", async () => {
  const value = project({
    memberSubjects: [
      "zeta-builder",
      "alpha-builder",
      "middle-builder",
    ],
  });
  const dynamo = recordingDynamo([
    { Item: projectItem(value) },
    { Item: projectItem(value) },
  ]);
  const state = await stateWith(dynamo);

  const first = await state.listProjectMemberSubjects({
    domainId: value.domainId,
    projectId: value.id,
    limit: 2,
  });
  assert.deepEqual(first.items, [
    "alpha-builder",
    "middle-builder",
  ]);
  assert.equal(typeof first.cursor, "string");
  assert.ok(first.cursor.length > 0);

  const second = await state.listProjectMemberSubjects({
    domainId: value.domainId,
    projectId: value.id,
    limit: 2,
    cursor: first.cursor,
  });
  assert.deepEqual(second, {
    items: ["zeta-builder"],
    cursor: null,
  });

  assert.equal(dynamo.commands.length, 2);
  for (const command of dynamo.commands) {
    assert.ok(command instanceof GetItemCommand);
    assert.deepEqual(command.input.Key, {
      pk: string("PROJECT#customer_support"),
      sk: string("PROJECT#case-assist"),
    });
    assert.equal(command.input.ConsistentRead, true);
  }
});

test("project member cursors are bound to the exact scope and member list", async () => {
  const initial = project({
    memberSubjects: [
      "alpha-builder",
      "middle-builder",
      "zeta-builder",
    ],
  });
  const changed = project({
    memberSubjects: [
      "alpha-builder",
      "new-builder",
      "zeta-builder",
    ],
  });
  const dynamo = recordingDynamo([
    { Item: projectItem(initial) },
    { Item: projectItem(changed) },
  ]);
  const state = await stateWith(dynamo);
  const first = await state.listProjectMemberSubjects({
    domainId: initial.domainId,
    projectId: initial.id,
    limit: 1,
  });

  await assert.rejects(
    state.listProjectMemberSubjects({
      domainId: initial.domainId,
      projectId: initial.id,
      limit: 1,
      cursor: first.cursor,
    }),
    expectCode("INVALID_READ_OPTIONS"),
  );
  await assert.rejects(
    state.listProjectMemberSubjects({
      domainId: "finance",
      projectId: initial.id,
      limit: 1,
      cursor: first.cursor,
    }),
    expectCode("INVALID_READ_OPTIONS"),
  );
});

test("adding a project member conditionally updates only the exact previously-read list", async () => {
  const value = project({
    memberSubjects: ["builder-sub-123", "alpha-builder"],
  });
  const dynamo = recordingDynamo([
    { Item: projectItem(value) },
    {},
  ]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.addProjectMember({
      domainId: value.domainId,
      projectId: value.id,
      subject: "zeta-builder",
    }),
    { changed: true },
  );

  assert.equal(dynamo.commands.length, 2);
  assert.ok(dynamo.commands[0] instanceof GetItemCommand);
  const update = dynamo.commands[1];
  assert.ok(update instanceof UpdateItemCommand);
  assert.deepEqual(update.input.Key, {
    pk: string("PROJECT#customer_support"),
    sk: string("PROJECT#case-assist"),
  });
  assert.equal(
    update.input.UpdateExpression,
    "SET #memberSubjects = :nextMemberSubjects",
  );
  assert.match(update.input.ConditionExpression, /#memberSubjects = :expectedMemberSubjects/);
  assert.match(update.input.ConditionExpression, /#status = :expectedStatus/);
  assert.match(update.input.ConditionExpression, /#ownerSubject = :ownerSubject/);
  assert.match(update.input.ConditionExpression, /#createdBySubject = :createdBySubject/);
  assert.match(update.input.ConditionExpression, /#createdAt = :createdAt/);
  assert.deepEqual(
    update.input.ExpressionAttributeValues[":expectedMemberSubjects"],
    stringList(value.memberSubjects),
  );
  assert.deepEqual(
    update.input.ExpressionAttributeValues[":nextMemberSubjects"],
    stringList([
      "alpha-builder",
      "builder-sub-123",
      "zeta-builder",
    ]),
  );
  assert.equal(update.input.ReturnValues, "NONE");
});

test("project membership add and remove are idempotent without unnecessary writes", async () => {
  const value = project({
    memberSubjects: ["builder-sub-123", "second-builder"],
  });
  const addDynamo = recordingDynamo([
    { Item: projectItem(value) },
  ]);
  const addState = await stateWith(addDynamo);
  assert.deepEqual(
    await addState.addProjectMember({
      domainId: value.domainId,
      projectId: value.id,
      subject: "second-builder",
    }),
    { changed: false },
  );
  assert.equal(addDynamo.commands.length, 1);

  const removeDynamo = recordingDynamo([
    { Item: projectItem(value) },
  ]);
  const removeState = await stateWith(removeDynamo);
  assert.deepEqual(
    await removeState.removeProjectMember({
      domainId: value.domainId,
      projectId: value.id,
      subject: "not-a-member",
    }),
    { changed: false },
  );
  assert.equal(removeDynamo.commands.length, 1);
});

test("removing a project member conditionally writes the exact remaining set", async () => {
  const value = project({
    memberSubjects: [
      "builder-sub-123",
      "second-builder",
      "third-builder",
    ],
  });
  const dynamo = recordingDynamo([
    { Item: projectItem(value) },
    {},
  ]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.removeProjectMember({
      domainId: value.domainId,
      projectId: value.id,
      subject: "second-builder",
    }),
    { changed: true },
  );
  const update = dynamo.commands[1];
  assert.ok(update instanceof UpdateItemCommand);
  assert.deepEqual(
    update.input.ExpressionAttributeValues[":expectedMemberSubjects"],
    stringList(value.memberSubjects),
  );
  assert.deepEqual(
    update.input.ExpressionAttributeValues[":nextMemberSubjects"],
    stringList(["builder-sub-123", "third-builder"]),
  );
});

test("project membership mutations enforce the 100-member bound", async () => {
  const value = project({
    memberSubjects: Array.from(
      { length: 100 },
      (_, index) => `builder-${index}`,
    ),
  });
  const dynamo = recordingDynamo([
    { Item: projectItem(value) },
  ]);
  const state = await stateWith(dynamo);

  await assert.rejects(
    state.addProjectMember({
      domainId: value.domainId,
      projectId: value.id,
      subject: "overflow-builder",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(dynamo.commands.length, 1);
});

test("project membership conditional conflicts have a stable service-mappable code", async () => {
  const conditional = Object.assign(
    new Error("conditional conflict"),
    { name: "ConditionalCheckFailedException" },
  );
  const value = project();
  const dynamo = recordingDynamo([
    { Item: projectItem(value) },
    conditional,
  ]);
  const state = await stateWith(dynamo);

  await assert.rejects(
    state.addProjectMember({
      domainId: value.domainId,
      projectId: value.id,
      subject: "second-builder",
    }),
    expectCode("MUTATION_CONFLICT"),
  );
});

test("project membership adapters fail closed for missing, archived, and malformed projects", async () => {
  const archived = project({ status: "ARCHIVED" });
  const malformed = {
    ...projectItem(),
    memberSubjects: { SS: ["builder-sub-123"] },
  };
  const state = await stateWith(recordingDynamo([
    {},
    { Item: projectItem(archived) },
    { Item: malformed },
  ]));

  await assert.rejects(
    state.addProjectMember({
      domainId: "customer_support",
      projectId: "case-assist",
      subject: "second-builder",
    }),
    expectCode("NOT_FOUND"),
  );
  await assert.rejects(
    state.removeProjectMember({
      domainId: "customer_support",
      projectId: "case-assist",
      subject: "builder-sub-123",
    }),
    expectCode("CONFLICT"),
  );
  await assert.rejects(
    state.listProjectMemberSubjects({
      domainId: "customer_support",
      projectId: "case-assist",
      limit: 20,
    }),
    expectCode("MALFORMED_DYNAMODB_RESPONSE"),
  );
});

test("project membership adapters reject sparse DynamoDB string lists", async () => {
  const sparseMembers = [];
  sparseMembers.length = 1;
  const malformed = {
    ...projectItem(),
    memberSubjects: { L: sparseMembers },
  };
  const state = await stateWith(recordingDynamo([
    { Item: malformed },
  ]));

  await assert.rejects(
    state.listProjectMemberSubjects({
      domainId: "customer_support",
      projectId: "case-assist",
      limit: 20,
    }),
    expectCode("MALFORMED_DYNAMODB_RESPONSE"),
  );
});
