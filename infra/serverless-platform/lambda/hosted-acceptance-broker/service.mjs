import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  domainGroupOperationToken,
} from "../platform-admin/domain-group-operation.mjs";

const DEFAULT_POLL_ATTEMPTS = 15;
const DEFAULT_POLL_DELAY_MS = 2_000;
const CLEANUP_LEASE_DURATION_SECONDS = 180;
const ACCEPTANCE_TAGS = Object.freeze({
  "auto-delete": "no",
  project: "agentic-ai-platform-demo",
  managedBy: "hosted-acceptance",
});
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const JOURNEY_RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUNTIME_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]{0,99}-[A-Za-z0-9]{10}$/;
const ENDPOINT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const RUNTIME_VERSION_PATTERN = /^[1-9][0-9]{0,4}$/;
const ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]{0,12}:.{1,1024}$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9]{12,16}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9]{12}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESERVED_DOMAIN_IDS = new Set([
  "admin",
  "platform_admin",
  "lead",
  "domain_lead",
  "builder",
  "domain_builder",
  "user",
  "end_user",
  "demo_operator",
]);
const EXPERIENCE_INPUT_KEYS = new Set([
  "actor",
  "domainId",
  "ownership",
]);
const EXPERIENCE_RECOVERY_INPUT_KEYS = new Set([
  "actor",
  "ownership",
]);
const EXPERIENCE_CLEANUP_INPUT_KEYS = new Set([
  ...EXPERIENCE_INPUT_KEYS,
  "fixture",
]);
const EXPERIENCE_FIXTURE_KEYS = new Set([
  "domainId",
  "projectId",
  "agentId",
  "deploymentId",
]);
const PERSONA_INPUT_KEYS = new Set([
  "actors",
  "domainId",
  "ownership",
]);
const PERSONA_ACTOR_KEYS = new Set([
  "administrator",
  "reviewer",
  "ordinary",
]);
const PERSONA_CLEANUP_INPUT_KEYS = new Set(["ownership"]);
const AGENT_BUILDING_CLEANUP_INPUT_KEYS = new Set([
  "actor",
  "domainId",
  "ownership",
]);
const RETRYABLE_DOMAIN_REQUEST_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  "actor",
  "route",
  "requestId",
  "result",
  "expiresAt",
  "createdAt",
]);
const RETRYABLE_DOMAIN_RESULT_BASE_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
]);
const RETRYABLE_DOMAIN_RESULT_KEYS = new Set([
  ...RETRYABLE_DOMAIN_RESULT_BASE_KEYS,
  "registry",
]);
const IN_PROGRESS_DOMAIN_RESULT_BASE_KEYS = new Set([
  ...RETRYABLE_DOMAIN_RESULT_BASE_KEYS,
  "ownerToken",
  "claimExpiresAt",
]);
const IN_PROGRESS_DOMAIN_RESULT_KEYS = new Set([
  ...IN_PROGRESS_DOMAIN_RESULT_BASE_KEYS,
  "registry",
]);
const RETRYABLE_DOMAIN_REGISTRY_KEYS = new Set([
  "registryId",
  "registryArn",
]);
const RUNTIME_IDENTITY_KEYS = new Set([
  "runtimeId",
  "runtimeArn",
  "runtimeStatus",
  "endpointName",
  "endpointArn",
  "runtimeVersion",
]);

function cleanupFailure() {
  return new Error("Hosted acceptance cleanup failed.");
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function requiredString(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function exactDataObject(value, keys) {
  if (!isPlainObject(value)) throw cleanupFailure();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.size
    || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))
  ) {
    throw cleanupFailure();
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw cleanupFailure();
    }
    result[key] = descriptor.value;
  }
  return result;
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

function roleSwitchingRequestIds(ownership) {
  const requestId = (operation) => deterministicUuid(
    `hosted-role-switching:${operation}:`
      + `${ownership.runId}:${ownership.runAttempt}`,
  );
  return {
    builderConfigureAgent: requestId("builder-configure-agent"),
    builderCreateAgent: requestId("builder-create-agent"),
    builderProduction: requestId("builder-production"),
    builderTestAgent: requestId("builder-test-agent"),
    journeyFullPreview: requestId("journey-full-preview"),
    journeyMinimalCreate: requestId("journey-minimal-create"),
    journeyMinimalPreview: requestId("journey-minimal-preview"),
    journeySpecContract: requestId("journey-spec-contract"),
    journeySpecCreate: requestId("journey-spec-create"),
    journeySpecMessage1: requestId("journey-spec-message-1"),
    journeySpecMessage2: requestId("journey-spec-message-2"),
    journeySpecPreview: requestId("journey-spec-preview"),
    leadAccessGrant: requestId("lead-access-grant"),
    leadApproval: requestId("lead-approval"),
    leadEntitlementGrant: requestId("lead-entitlement-grant"),
    userFeedback: requestId("user-feedback"),
    userInvoke: requestId("user-invoke"),
  };
}

function runComponent(value, maximumLength) {
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]*$/.test(value)
    || value.length > maximumLength
  ) {
    throw cleanupFailure();
  }
  return value;
}

function expectedOwnership(runIdValue, runAttemptValue) {
  const runId = runComponent(runIdValue, 20);
  const runAttempt = runComponent(runAttemptValue, 6);
  const domainName = `Hosted Acceptance ${runId} ${runAttempt}`;
  const domainId = `hosted_acceptance_${runId}_${runAttempt}`;
  const registryEntryId = `hosted-acceptance-${runId}-${runAttempt}`;
  const registryVersion = "1.0.0";
  const registryDisplayName = `${domainName} Blueprint`;
  const registryDescription =
    `Temporary governance fixture for hosted acceptance run `
    + `${runId} attempt ${runAttempt}.`;
  return {
    runId,
    runAttempt,
    domainName,
    domainId,
    ownerGroup: `domain-hosted-acceptance-${runId}-${runAttempt}`,
    registryEntryId,
    registryRecordName: `hosted_acceptance_${runId}_${runAttempt}`,
    registryVersion,
    registryDisplayName,
    registryDescription,
    registryDescriptor: {
      resourceKind: "blueprint",
      blueprintId: registryEntryId,
      displayName: registryDisplayName,
      useCase: registryDescription,
      template: { framework: "Strands" },
      compat: {},
      version: registryVersion,
      defaultVersion: registryVersion,
      hostedAcceptance: {
        runId,
        runAttempt,
        project: ACCEPTANCE_TAGS.project,
        managedBy: ACCEPTANCE_TAGS.managedBy,
      },
    },
    tags: { ...ACCEPTANCE_TAGS },
    fixtureClientToken: deterministicUuid(
      `hosted-acceptance:fixture:${runId}:${runAttempt}`,
    ),
    requestIds: {
      domain: deterministicUuid(
        `hosted-acceptance:domain:${runId}:${runAttempt}`,
      ),
      registry: deterministicUuid(
        `hosted-acceptance:registry:${runId}:${runAttempt}`,
      ),
      isolation: deterministicUuid(
        `hosted-acceptance:isolation:${runId}:${runAttempt}`,
      ),
    },
  };
}

function validatedOwnership(value) {
  if (!isPlainObject(value)) throw cleanupFailure();
  const expected = expectedOwnership(value.runId, value.runAttempt);
  if (!isDeepStrictEqual(value, expected)) throw cleanupFailure();
  return expected;
}

function exactDomainId(value) {
  if (
    !requiredString(value, DOMAIN_ID_PATTERN)
    || value.length > 64
    || RESERVED_DOMAIN_IDS.has(value)
  ) {
    throw cleanupFailure();
  }
  return value;
}

function experienceFixtureIdentity(domainId, ownership) {
  return {
    domainId,
    projectId:
      `hosted-project-${ownership.runId}-${ownership.runAttempt}`,
    agentId: `hosted-agent-${ownership.runId}-${ownership.runAttempt}`,
    deploymentId:
      `hosted-production-${ownership.runId}-${ownership.runAttempt}`,
  };
}

function personaFixtureIdentity(domainId, ownership) {
  const projectId =
    `hosted-project-${ownership.runId}-${ownership.runAttempt}`;
  const agentId =
    `acceptance-agent-${ownership.runId}-${ownership.runAttempt}`;
  return {
    domainId,
    projectId,
    agentId,
    deploymentId:
      `acceptance-production-${ownership.runId}-${ownership.runAttempt}`,
    approvalId:
      `acceptance-production-approval-`
      + `${ownership.runId}-${ownership.runAttempt}`,
  };
}

function personaMappingKey(ownership) {
  return {
    pk: stringAttribute("HOSTED_ROLE_SWITCHING"),
    sk: stringAttribute(
      `RUN#${ownership.runId}#ATTEMPT#${ownership.runAttempt}`,
    ),
  };
}

function personaInput(value) {
  const fields = exactDataObject(value, PERSONA_INPUT_KEYS);
  const actors = exactDataObject(fields.actors, PERSONA_ACTOR_KEYS);
  for (const actor of Object.values(actors)) {
    if (!requiredString(actor, ACTOR_PATTERN)) throw cleanupFailure();
  }
  if (new Set(Object.values(actors)).size !== PERSONA_ACTOR_KEYS.size) {
    throw cleanupFailure();
  }
  const domainId = exactDomainId(fields.domainId);
  const ownership = validatedOwnership(fields.ownership);
  return {
    actors,
    domainId,
    ownership,
    fixture: personaFixtureIdentity(domainId, ownership),
  };
}

function personaMappingItem(input) {
  return {
    ...personaMappingKey(input.ownership),
    entityType: stringAttribute("HOSTED_ROLE_SWITCHING_RUN"),
    administratorActor: stringAttribute(input.actors.administrator),
    reviewerActor: stringAttribute(input.actors.reviewer),
    ordinaryActor: stringAttribute(input.actors.ordinary),
    domainId: stringAttribute(input.domainId),
    projectId: stringAttribute(input.fixture.projectId),
    agentId: stringAttribute(input.fixture.agentId),
    deploymentId: stringAttribute(input.fixture.deploymentId),
    approvalId: stringAttribute(input.fixture.approvalId),
    managedBy: stringAttribute(ACCEPTANCE_TAGS.managedBy),
    project: stringAttribute(ACCEPTANCE_TAGS.project),
    runId: stringAttribute(input.ownership.runId),
    runAttempt: stringAttribute(input.ownership.runAttempt),
  };
}

function personaFromMapping(item, ownership) {
  const actors = {
    administrator: item?.administratorActor?.S,
    reviewer: item?.reviewerActor?.S,
    ordinary: item?.ordinaryActor?.S,
  };
  const input = personaInput({
    actors,
    domainId: item?.domainId?.S,
    ownership,
  });
  if (!isDeepStrictEqual(item, personaMappingItem(input))) {
    throw cleanupFailure();
  }
  return input;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
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

function publicAgentId(fixture) {
  return `agent-${
    createHash("sha256")
      .update(
        `${fixture.domainId}\0${fixture.projectId}\0${fixture.agentId}`,
      )
      .digest("hex")
      .slice(0, 32)
  }`;
}

function generatedSessionId(actor, requestId) {
  return `session-${
    createHash("sha256").update(actor).digest("hex").slice(0, 16)
  }-${
    createHash("sha256")
      .update(`${actor}\0${requestId}`)
      .digest("hex")
      .slice(0, 16)
  }`;
}

function feedbackId(input, fixture, sessionId, requestId) {
  const payloadFingerprint = fingerprint({
    publicAgentId: publicAgentId(fixture),
    sessionId,
    rating: 5,
    comment: "Hosted acceptance positive journey verified.",
  });
  return `feedback-${
    createHash("sha256")
      .update(
        `FEEDBACK\0${input.actors.administrator}\0`
        + `POST /api/experience/feedback\0${requestId}\0`
        + payloadFingerprint,
      )
      .digest("hex")
      .slice(0, 32)
  }`;
}

function experienceInput(value, { cleanup = false } = {}) {
  const fields = exactDataObject(
    value,
    cleanup ? EXPERIENCE_CLEANUP_INPUT_KEYS : EXPERIENCE_INPUT_KEYS,
  );
  if (!requiredString(fields.actor, ACTOR_PATTERN)) throw cleanupFailure();
  const domainId = exactDomainId(fields.domainId);
  const ownership = validatedOwnership(fields.ownership);
  const fixture = experienceFixtureIdentity(domainId, ownership);
  if (cleanup) {
    const suppliedFixture = exactDataObject(
      fields.fixture,
      EXPERIENCE_FIXTURE_KEYS,
    );
    if (!isDeepStrictEqual(suppliedFixture, fixture)) {
      throw cleanupFailure();
    }
  }
  return {
    actor: fields.actor,
    domainId,
    ownership,
    fixture,
  };
}

function experienceRecoveryInput(value) {
  const fields = exactDataObject(value, EXPERIENCE_RECOVERY_INPUT_KEYS);
  if (!requiredString(fields.actor, ACTOR_PATTERN)) throw cleanupFailure();
  return {
    actor: fields.actor,
    ownership: validatedOwnership(fields.ownership),
  };
}

function deterministicTimestamp(ownership) {
  const seconds = createHash("sha256")
    .update(
      `hosted-acceptance:experience:timestamp:`
      + `${ownership.runId}:${ownership.runAttempt}`,
    )
    .digest()
    .readUInt32BE(0) % (5 * 365 * 24 * 60 * 60);
  return new Date(Date.UTC(2020, 0, 1) + (seconds * 1_000)).toISOString();
}

function stringAttribute(value) {
  return { S: value };
}

function nullableStringAttribute(value) {
  return value === null ? { NULL: true } : stringAttribute(value);
}

function stringListAttribute(values) {
  return { L: values.map(stringAttribute) };
}

function validateRuntimeIdentity(value, {
  accountId,
  endpointName,
  region,
  runtimeId,
}) {
  const identity = exactDataObject(value, RUNTIME_IDENTITY_KEYS);
  const expectedRuntimeArn =
    new RegExp(
      "^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):"
      + `bedrock-agentcore:${region}:${accountId}:runtime/${runtimeId}$`,
    );
  if (
    identity.runtimeId !== runtimeId
    || !requiredString(identity.runtimeArn, ARN_PATTERN)
    || !expectedRuntimeArn.test(identity.runtimeArn)
    || identity.runtimeStatus !== "READY"
    || identity.endpointName !== endpointName
    || !requiredString(identity.endpointArn, ARN_PATTERN)
    || identity.endpointArn
      !== `${identity.runtimeArn}/runtime-endpoint/${endpointName}`
    || !requiredString(identity.runtimeVersion, RUNTIME_VERSION_PATTERN)
  ) {
    throw cleanupFailure();
  }
  return identity;
}

function runtimeIdentityHash(identity) {
  return createHash("sha256")
    .update(
      [
        identity.runtimeId,
        identity.runtimeArn,
        identity.runtimeStatus,
        identity.endpointName,
        identity.endpointArn,
        identity.runtimeVersion,
      ].join("\n"),
    )
    .digest("hex");
}

function runtimeIdentityFromDeployment(item, context) {
  return validateRuntimeIdentity({
    runtimeId: item?.runtimeId?.S,
    runtimeArn: item?.runtimeArn?.S,
    runtimeStatus: item?.runtimeStatus?.S,
    endpointName: item?.endpointName?.S,
    endpointArn: item?.endpointArn?.S,
    runtimeVersion: item?.runtimeVersion?.S,
  }, context);
}

function experienceItems({
  actor,
  domainId,
  fixture,
  ownership,
  runtimeIdentity,
}) {
  const timestamp = deterministicTimestamp(ownership);
  const approver =
    `hosted-approver-${ownership.runId}-${ownership.runAttempt}`;
  const modelId =
    `hosted-acceptance-model-${ownership.runId}-${ownership.runAttempt}`;
  const testRequestId =
    `hosted-test-${ownership.runId}-${ownership.runAttempt}`;
  const runtimeHash = runtimeIdentityHash(runtimeIdentity);
  const testEvidenceHash = createHash("sha256")
    .update(
      `hosted-acceptance:experience:evidence:`
      + `${ownership.runId}:${ownership.runAttempt}:${runtimeHash}`,
    )
    .digest("hex");
  const project = {
    pk: stringAttribute(`PROJECT#${domainId}`),
    sk: stringAttribute(`PROJECT#${fixture.projectId}`),
    entityType: stringAttribute("PROJECT"),
    domainId: stringAttribute(domainId),
    id: stringAttribute(fixture.projectId),
    name: stringAttribute(`${ownership.domainName} Project`),
    description: stringAttribute(
      `Temporary entitled-agent project for hosted acceptance run `
      + `${ownership.runId} attempt ${ownership.runAttempt}.`,
    ),
    ownerSubject: stringAttribute(actor),
    memberSubjects: stringListAttribute([actor]),
    status: stringAttribute("ACTIVE"),
    createdBySubject: stringAttribute(actor),
    createdAt: stringAttribute(timestamp),
  };
  const agent = {
    pk: stringAttribute(
      `AGENT#${domainId}#${fixture.projectId}`,
    ),
    sk: stringAttribute(`AGENT#${fixture.agentId}`),
    entityType: stringAttribute("AGENT"),
    domainId: stringAttribute(domainId),
    projectId: stringAttribute(fixture.projectId),
    id: stringAttribute(fixture.agentId),
    name: stringAttribute(`${ownership.domainName} Agent`),
    description: stringAttribute(
      `Temporary entitled agent for hosted acceptance run `
      + `${ownership.runId} attempt ${ownership.runAttempt}.`,
    ),
    ownerSubject: stringAttribute(actor),
    modelId: stringAttribute(modelId),
    toolIds: stringListAttribute([]),
    mcpServerIds: stringListAttribute([]),
    skillIds: stringListAttribute([]),
    blueprintIds: stringListAttribute([]),
    memoryIds: stringListAttribute([]),
    knowledgeBaseIds: stringListAttribute([]),
    status: stringAttribute("PRODUCTION_DEPLOYED"),
    createdBySubject: stringAttribute(actor),
    createdAt: stringAttribute(timestamp),
    updatedAt: stringAttribute(timestamp),
    lastTestStatus: stringAttribute("SUCCEEDED"),
    lastTestedAt: stringAttribute(timestamp),
    lastTestedBySubject: stringAttribute(actor),
    lastTestModelId: stringAttribute(modelId),
    lastTestInputTokens: { N: "1" },
    lastTestOutputTokens: { N: "1" },
    lastTestRequestId: stringAttribute(testRequestId),
    lastTestEvidenceHash: stringAttribute(testEvidenceHash),
    lastTestOutput: stringAttribute(
      `Hosted acceptance test succeeded for run ${ownership.runId} `
      + `attempt ${ownership.runAttempt}.`,
    ),
  };
  const deployment = {
    pk: stringAttribute(
      `DEPLOYMENT#${domainId}#${fixture.projectId}`,
    ),
    sk: stringAttribute(`DEPLOYMENT#${fixture.deploymentId}`),
    entityType: stringAttribute("DEPLOYMENT"),
    domainId: stringAttribute(domainId),
    projectId: stringAttribute(fixture.projectId),
    id: stringAttribute(fixture.deploymentId),
    agentId: stringAttribute(fixture.agentId),
    environment: stringAttribute("PRODUCTION"),
    status: stringAttribute("DEPLOYED"),
    requesterSubject: stringAttribute(actor),
    approverSubject: stringAttribute(approver),
    decisionReason: stringAttribute(
      `Hosted acceptance production approval for run ${ownership.runId} `
      + `attempt ${ownership.runAttempt}.`,
    ),
    requestedAt: stringAttribute(timestamp),
    decidedAt: stringAttribute(timestamp),
    runtimeId: stringAttribute(runtimeIdentity.runtimeId),
    runtimeArn: stringAttribute(runtimeIdentity.runtimeArn),
    runtimeStatus: stringAttribute(runtimeIdentity.runtimeStatus),
    endpointName: stringAttribute(runtimeIdentity.endpointName),
    endpointArn: stringAttribute(runtimeIdentity.endpointArn),
    runtimeVersion: stringAttribute(runtimeIdentity.runtimeVersion),
    updatedAt: stringAttribute(timestamp),
  };
  const entitlement = {
    pk: stringAttribute(`ENTITLEMENT#${actor}`),
    sk: stringAttribute(
      `AGENT#${domainId}#${fixture.projectId}#${fixture.agentId}`,
    ),
    entityType: stringAttribute("ENTITLEMENT"),
    subject: stringAttribute(actor),
    agentId: stringAttribute(fixture.agentId),
    domainId: stringAttribute(domainId),
    projectId: stringAttribute(fixture.projectId),
    status: stringAttribute("ACTIVE"),
    grantedBySubject: stringAttribute(approver),
    grantedAt: stringAttribute(timestamp),
    revokedBySubject: nullableStringAttribute(null),
    revokedAt: nullableStringAttribute(null),
  };
  return { project, agent, deployment, entitlement };
}

function absentItemCondition() {
  return {
    ConditionExpression:
      "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
    },
  };
}

function exactItemCondition(item) {
  const names = {};
  const values = {};
  const equality = [];
  for (const [name, attribute] of Object.entries(item)) {
    names[`#${name}`] = name;
    values[`:${name}`] = attribute;
    equality.push(`#${name} = :${name}`);
  }
  return {
    ConditionExpression: equality.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

function experienceKeys({ actor, domainId, fixture }) {
  return {
    project: {
      pk: stringAttribute(`PROJECT#${domainId}`),
      sk: stringAttribute(`PROJECT#${fixture.projectId}`),
    },
    agent: {
      pk: stringAttribute(
        `AGENT#${domainId}#${fixture.projectId}`,
      ),
      sk: stringAttribute(`AGENT#${fixture.agentId}`),
    },
    deployment: {
      pk: stringAttribute(
        `DEPLOYMENT#${domainId}#${fixture.projectId}`,
      ),
      sk: stringAttribute(`DEPLOYMENT#${fixture.deploymentId}`),
    },
    entitlement: {
      pk: stringAttribute(`ENTITLEMENT#${actor}`),
      sk: stringAttribute(
        `AGENT#${domainId}#${fixture.projectId}#${fixture.agentId}`,
      ),
    },
  };
}

function validateTags(tags, expectedTags = ACCEPTANCE_TAGS) {
  return Boolean(
    isPlainObject(tags)
    && Object.keys(tags).length === Object.keys(expectedTags).length
    && Object.entries(expectedTags).every(
      ([key, value]) => tags[key] === value,
    )
  );
}

function registryArn(region, accountId, registryId) {
  return `arn:aws:agent-registry:${region}:${accountId}:`
    + `registry/${registryId}`;
}

function recordArn(region, accountId, registryId, recordId) {
  return `${registryArn(region, accountId, registryId)}/record/${recordId}`;
}

function resourceNotFound(error) {
  return error?.name === "ResourceNotFoundException"
    || error?.code === "ResourceNotFoundException"
    || error?.Code === "ResourceNotFoundException";
}

function conditionalCheckFailed(error) {
  return error?.name === "ConditionalCheckFailedException"
    || error?.code === "ConditionalCheckFailedException"
    || error?.Code === "ConditionalCheckFailedException";
}

function mappingKey(ownership) {
  return {
    pk: { S: "HOSTED_ACCEPTANCE" },
    sk: {
      S: `RUN#${ownership.runId}#ATTEMPT#${ownership.runAttempt}`,
    },
  };
}

function cleanupLeaseKey(ownership) {
  return {
    pk: { S: "HOSTED_ROLE_SWITCHING" },
    sk: {
      S:
        `CLEANUP_LEASE#RUN#${ownership.runId}`
        + `#ATTEMPT#${ownership.runAttempt}`,
    },
  };
}

function cleanupLeaseItem({
  actor,
  cleanupExecutionToken,
  leaseExpiresAt,
  operationToken,
  ownership,
}) {
  return {
    ...cleanupLeaseKey(ownership),
    actor: { S: actor },
    cleanupExecutionToken: { S: cleanupExecutionToken },
    domainId: { S: ownership.domainId },
    domainRequestId: { S: ownership.requestIds.domain },
    entityType: { S: "HOSTED_ROLE_SWITCHING_CLEANUP_LEASE" },
    leaseExpiresAt: { N: String(leaseExpiresAt) },
    managedBy: { S: ACCEPTANCE_TAGS.managedBy },
    operationToken: { S: operationToken },
    ownerGroup: { S: ownership.ownerGroup },
    project: { S: ACCEPTANCE_TAGS.project },
    registryRequestId: { S: ownership.requestIds.registry },
    runAttempt: { S: ownership.runAttempt },
    runId: { S: ownership.runId },
  };
}

function mappingItem(actor, ownership) {
  return {
    ...mappingKey(ownership),
    actor: { S: actor },
    domainId: { S: ownership.domainId },
    domainRequestId: { S: ownership.requestIds.domain },
    entityType: { S: "HOSTED_ACCEPTANCE_RUN" },
    managedBy: { S: ACCEPTANCE_TAGS.managedBy },
    project: { S: ACCEPTANCE_TAGS.project },
    registryRequestId: { S: ownership.requestIds.registry },
    runAttempt: { S: ownership.runAttempt },
    runId: { S: ownership.runId },
  };
}

function actorFromMapping(item, ownership) {
  const actor = item?.actor?.S;
  if (
    !requiredString(actor, ACTOR_PATTERN)
    || !isDeepStrictEqual(item, mappingItem(actor, ownership))
  ) {
    throw cleanupFailure();
  }
  return actor;
}

function exactRecordIdentity({
  accountId,
  ownership,
  record,
  recordId,
  region,
  registryId,
}) {
  let descriptor;
  try {
    descriptor = JSON.parse(record?.descriptors?.custom?.data);
  } catch {
    throw cleanupFailure();
  }
  const expectedRegistryArn = registryArn(region, accountId, registryId);
  const expectedRecordArn = recordArn(
    region,
    accountId,
    registryId,
    recordId,
  );
  if (
    record?.registryArn !== expectedRegistryArn
    || record?.recordId !== recordId
    || record?.recordArn !== expectedRecordArn
    || record?.name !== ownership.registryRecordName
    || record?.displayName !== ownership.registryDisplayName
    || record?.description !== ownership.registryDescription
    || record?.recordType !== "CUSTOM"
    || record?.recordVersion !== ownership.registryVersion
    || !isDeepStrictEqual(descriptor, ownership.registryDescriptor)
  ) {
    throw cleanupFailure();
  }
  return {
    entryId: ownership.registryEntryId,
    name: ownership.registryRecordName,
    recordArn: expectedRecordArn,
    recordId,
    registryArn: expectedRegistryArn,
    registryId,
    semver: ownership.registryVersion,
    status: record.status,
    type: "Blueprint",
  };
}

function domainFromItem({
  accountId,
  actor,
  item,
  ownership,
  region,
}) {
  const read = (name) => item?.[name]?.S;
  const registryId = read("registryId");
  const createdBy = read("createdBy");
  if (
    read("pk") !== "DOMAIN"
    || read("sk") !== `DOMAIN#${ownership.domainId}`
    || read("entityType") !== "DOMAIN"
    || read("id") !== ownership.domainId
    || read("name") !== ownership.domainName
    || read("ownerGroup") !== ownership.ownerGroup
    || read("status") !== "ACTIVE"
    || !requiredString(registryId, REGISTRY_ID_PATTERN)
    || read("registryArn") !== registryArn(region, accountId, registryId)
    || !requiredString(createdBy, ACTOR_PATTERN)
    || (actor !== undefined && createdBy !== actor)
  ) {
    throw cleanupFailure();
  }
  return {
    createdBy,
    id: ownership.domainId,
    name: ownership.domainName,
    ownerGroup: ownership.ownerGroup,
    registryArn: read("registryArn"),
    registryId,
    status: "ACTIVE",
  };
}

function retryableDomainFromRequestItem({
  accountId,
  actor,
  item,
  ownership,
  region,
}) {
  const exactNames = (value, names) =>
    isPlainObject(value)
    && Reflect.ownKeys(value).length === names.size
    && Reflect.ownKeys(value).every(
      (name) => typeof name === "string" && names.has(name),
    );
  const exactString = (value, expected) =>
    isPlainObject(value)
    && Reflect.ownKeys(value).length === 1
    && value.S === expected;
  const validString = (value, pattern) =>
    isPlainObject(value)
    && Reflect.ownKeys(value).length === 1
    && typeof value.S === "string"
    && pattern.test(value.S);
  const validPositiveInteger = (value) =>
    isPlainObject(value)
    && Reflect.ownKeys(value).length === 1
    && typeof value.N === "string"
    && /^[1-9][0-9]*$/.test(value.N)
    && Number.isSafeInteger(Number(value.N));
  const validTimestamp = (value) =>
    isPlainObject(value)
    && Reflect.ownKeys(value).length === 1
    && typeof value.S === "string"
    && Number.isFinite(Date.parse(value.S))
    && new Date(Date.parse(value.S)).toISOString() === value.S;
  const route = "POST /api/domain-create";
  const result = item?.result?.M;
  const registry = result?.registry?.M;
  const registryId = registry?.registryId?.S;
  const expectedRegistryArn = registryArn(region, accountId, registryId);
  const retryableBase = result?.status?.S === "FAILED_RETRYABLE"
    && exactNames(result, RETRYABLE_DOMAIN_RESULT_BASE_KEYS);
  const retryableTarget = result?.status?.S === "FAILED_RETRYABLE"
    && exactNames(result, RETRYABLE_DOMAIN_RESULT_KEYS);
  const inProgressBase = result?.status?.S === "IN_PROGRESS"
    && exactNames(result, IN_PROGRESS_DOMAIN_RESULT_BASE_KEYS)
    && validString(result.ownerToken, UUID_PATTERN)
    && validPositiveInteger(result.claimExpiresAt);
  const inProgressTarget = result?.status?.S === "IN_PROGRESS"
    && exactNames(result, IN_PROGRESS_DOMAIN_RESULT_KEYS)
    && validString(result.ownerToken, UUID_PATTERN)
    && validPositiveInteger(result.claimExpiresAt);
  if (
    !exactNames(item, RETRYABLE_DOMAIN_REQUEST_ITEM_KEYS)
    || !exactString(item.pk, `REQUEST#${actor}`)
    || !exactString(
      item.sk,
      `REQUEST#${route}#${ownership.requestIds.domain}`,
    )
    || !exactString(item.entityType, "REQUEST_RESULT")
    || !exactString(item.actor, actor)
    || !exactString(item.route, route)
    || !exactString(item.requestId, ownership.requestIds.domain)
    || !isPlainObject(item.result)
    || Reflect.ownKeys(item.result).length !== 1
    || (
      !retryableBase
      && !retryableTarget
      && !inProgressBase
      && !inProgressTarget
    )
    || !exactString(result.kind, "DOMAIN_CREATE")
    || !validString(result.payloadFingerprint, /^[a-f0-9]{64}$/)
    || !validPositiveInteger(item.expiresAt)
    || !validTimestamp(item.createdAt)
  ) {
    throw cleanupFailure();
  }
  if (retryableBase || inProgressBase) return null;
  if (
    !isPlainObject(result.registry)
    || Reflect.ownKeys(result.registry).length !== 1
    || !exactNames(registry, RETRYABLE_DOMAIN_REGISTRY_KEYS)
    || !validString(registry.registryId, REGISTRY_ID_PATTERN)
    || !exactString(registry.registryArn, expectedRegistryArn)
  ) {
    throw cleanupFailure();
  }
  return {
    createdBy: actor,
    id: ownership.domainId,
    name: ownership.domainName,
    ownerGroup: ownership.ownerGroup,
    registryArn: expectedRegistryArn,
    registryId,
    status: "ACTIVE",
  };
}

function validateDomain({
  accountId,
  actor,
  domain,
  ownership,
  region,
}) {
  if (
    !isPlainObject(domain)
    || domain.id !== ownership.domainId
    || domain.name !== ownership.domainName
    || domain.ownerGroup !== ownership.ownerGroup
    || domain.status !== "ACTIVE"
    || !requiredString(domain.registryId, REGISTRY_ID_PATTERN)
    || domain.registryArn
      !== registryArn(region, accountId, domain.registryId)
    || !requiredString(domain.createdBy, ACTOR_PATTERN)
    || (actor !== undefined && domain.createdBy !== actor)
  ) {
    throw cleanupFailure();
  }
  return domain;
}

export function createHostedAcceptanceBrokerService({
  accountId,
  cleanupClock = Date.now,
  cleanupExecutionTokenFactory = randomUUID,
  domainDirectory,
  dynamoClient,
  fixtureRegistryId,
  operationDelay = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  platformStateTableName,
  pollAttempts = DEFAULT_POLL_ATTEMPTS,
  pollDelayMs = DEFAULT_POLL_DELAY_MS,
  region,
  registryClient,
  runtimeControl,
}) {
  if (
    !requiredString(accountId, /^[0-9]{12}$/)
    || !requiredString(
      region,
      /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/,
    )
    || !requiredString(
      platformStateTableName,
      /^[A-Za-z0-9_.-]{3,255}$/,
    )
    || !requiredString(fixtureRegistryId, REGISTRY_ID_PATTERN)
    || !registryClient
    || typeof registryClient.send !== "function"
    || !dynamoClient
    || typeof dynamoClient.send !== "function"
    || typeof cleanupClock !== "function"
    || typeof cleanupExecutionTokenFactory !== "function"
    || !domainDirectory
    || typeof domainDirectory.deleteGroupExact !== "function"
    || !runtimeControl
    || typeof runtimeControl.resolveEndpoint !== "function"
    || !requiredString(runtimeControl.runtimeId, RUNTIME_ID_PATTERN)
    || !requiredString(
      runtimeControl.productionEndpointName,
      ENDPOINT_NAME_PATTERN,
    )
    || typeof operationDelay !== "function"
    || !Number.isInteger(pollAttempts)
    || pollAttempts < 1
    || pollAttempts > 30
    || !Number.isInteger(pollDelayMs)
    || pollDelayMs < 0
    || pollDelayMs > 10_000
  ) {
    throw new TypeError("Hosted acceptance broker configuration is invalid.");
  }

  const exactRegistryId = (value, fixtureOnly = false) => {
    if (
      !requiredString(value, REGISTRY_ID_PATTERN)
      || (fixtureOnly && value !== fixtureRegistryId)
    ) {
      throw cleanupFailure();
    }
    return value;
  };
  const exactRecordId = (value) => {
    if (!requiredString(value, RECORD_ID_PATTERN)) throw cleanupFailure();
    return value;
  };
  const getRecord = async (registryId, recordId) => {
    try {
      return await registryClient.send(new GetRegistryRecordCommand({
        registryId,
        recordId,
      }));
    } catch (error) {
      if (resourceNotFound(error)) return null;
      throw error;
    }
  };
  const getRegistry = async (registryId) => {
    try {
      return await registryClient.send(new GetRegistryCommand({
        registryId,
      }));
    } catch (error) {
      if (resourceNotFound(error)) return null;
      throw error;
    }
  };
  const exactTags = async (resourceArn, expectedTags) => {
    const response = await registryClient.send(
      new ListTagsForResourceCommand({ resourceArn }),
    );
    if (!validateTags(response?.tags, expectedTags)) throw cleanupFailure();
  };
  const exactItem = async (key) => {
    const response = await dynamoClient.send(new GetItemCommand({
      TableName: platformStateTableName,
      Key: key,
      ConsistentRead: true,
    }));
    return response?.Item ?? null;
  };
  const acquireCleanupLease = async ({
    actor,
    operationToken,
    ownership,
  }) => {
    const nowMilliseconds = cleanupClock();
    const cleanupExecutionToken = cleanupExecutionTokenFactory();
    if (
      !Number.isSafeInteger(nowMilliseconds)
      || nowMilliseconds < 0
      || !UUID_PATTERN.test(cleanupExecutionToken)
    ) {
      throw cleanupFailure();
    }
    const leaseNow = Math.floor(nowMilliseconds / 1_000);
    const lease = cleanupLeaseItem({
      actor,
      cleanupExecutionToken,
      leaseExpiresAt: leaseNow + CLEANUP_LEASE_DURATION_SECONDS,
      operationToken,
      ownership,
    });
    try {
      await dynamoClient.send(new PutItemCommand({
        TableName: platformStateTableName,
        Item: lease,
        ConditionExpression:
          "attribute_not_exists(pk) OR ("
          + "actor = :leaseActor "
          + "AND domainId = :leaseDomainId "
          + "AND domainRequestId = :leaseDomainRequestId "
          + "AND entityType = :leaseEntityType "
          + "AND managedBy = :leaseManagedBy "
          + "AND operationToken = :leaseOperationToken "
          + "AND ownerGroup = :leaseOwnerGroup "
          + "AND #project = :leaseProject "
          + "AND registryRequestId = :leaseRegistryRequestId "
          + "AND runAttempt = :leaseRunAttempt "
          + "AND runId = :leaseRunId "
          + "AND leaseExpiresAt <= :leaseNow)",
        ExpressionAttributeNames: {
          "#project": "project",
        },
        ExpressionAttributeValues: {
          ":leaseActor": lease.actor,
          ":leaseDomainId": lease.domainId,
          ":leaseDomainRequestId": lease.domainRequestId,
          ":leaseEntityType": lease.entityType,
          ":leaseManagedBy": lease.managedBy,
          ":leaseNow": { N: String(leaseNow) },
          ":leaseOperationToken": lease.operationToken,
          ":leaseOwnerGroup": lease.ownerGroup,
          ":leaseProject": lease.project,
          ":leaseRegistryRequestId": lease.registryRequestId,
          ":leaseRunAttempt": lease.runAttempt,
          ":leaseRunId": lease.runId,
        },
      }));
    } catch {
      throw cleanupFailure();
    }
    return lease;
  };
  const releaseCleanupLease = async (lease) => {
    await dynamoClient.send(new DeleteItemCommand({
      TableName: platformStateTableName,
      Key: cleanupLeaseKey({
        runId: lease.runId.S,
        runAttempt: lease.runAttempt.S,
      }),
      ConditionExpression:
        "actor = :leaseActor "
        + "AND cleanupExecutionToken = :cleanupExecutionToken "
        + "AND domainId = :leaseDomainId "
        + "AND domainRequestId = :leaseDomainRequestId "
        + "AND entityType = :leaseEntityType "
        + "AND leaseExpiresAt = :leaseExpiresAt "
        + "AND managedBy = :leaseManagedBy "
        + "AND operationToken = :leaseOperationToken "
        + "AND ownerGroup = :leaseOwnerGroup "
        + "AND #project = :leaseProject "
        + "AND registryRequestId = :leaseRegistryRequestId "
        + "AND runAttempt = :leaseRunAttempt "
        + "AND runId = :leaseRunId",
      ExpressionAttributeNames: {
        "#project": "project",
      },
      ExpressionAttributeValues: {
        ":cleanupExecutionToken": lease.cleanupExecutionToken,
        ":leaseActor": lease.actor,
        ":leaseDomainId": lease.domainId,
        ":leaseDomainRequestId": lease.domainRequestId,
        ":leaseEntityType": lease.entityType,
        ":leaseExpiresAt": lease.leaseExpiresAt,
        ":leaseManagedBy": lease.managedBy,
        ":leaseOperationToken": lease.operationToken,
        ":leaseOwnerGroup": lease.ownerGroup,
        ":leaseProject": lease.project,
        ":leaseRegistryRequestId": lease.registryRequestId,
        ":leaseRunAttempt": lease.runAttempt,
        ":leaseRunId": lease.runId,
      },
    }));
  };
  const renewCleanupLease = async (lease) => {
    const nowMilliseconds = cleanupClock();
    if (
      !Number.isSafeInteger(nowMilliseconds)
      || nowMilliseconds < 0
    ) {
      throw cleanupFailure();
    }
    const leaseNow = Math.floor(nowMilliseconds / 1_000);
    const renewedLease = {
      ...lease,
      leaseExpiresAt: {
        N: String(leaseNow + CLEANUP_LEASE_DURATION_SECONDS),
      },
    };
    try {
      await dynamoClient.send(new PutItemCommand({
        TableName: platformStateTableName,
        Item: renewedLease,
        ConditionExpression:
          "actor = :leaseActor "
          + "AND cleanupExecutionToken = :cleanupExecutionToken "
          + "AND domainId = :leaseDomainId "
          + "AND domainRequestId = :leaseDomainRequestId "
          + "AND entityType = :leaseEntityType "
          + "AND leaseExpiresAt = :previousLeaseExpiresAt "
          + "AND leaseExpiresAt > :leaseNow "
          + "AND managedBy = :leaseManagedBy "
          + "AND operationToken = :leaseOperationToken "
          + "AND ownerGroup = :leaseOwnerGroup "
          + "AND #project = :leaseProject "
          + "AND registryRequestId = :leaseRegistryRequestId "
          + "AND runAttempt = :leaseRunAttempt "
          + "AND runId = :leaseRunId",
        ExpressionAttributeNames: {
          "#project": "project",
        },
        ExpressionAttributeValues: {
          ":cleanupExecutionToken": lease.cleanupExecutionToken,
          ":leaseActor": lease.actor,
          ":leaseDomainId": lease.domainId,
          ":leaseDomainRequestId": lease.domainRequestId,
          ":leaseEntityType": lease.entityType,
          ":leaseManagedBy": lease.managedBy,
          ":leaseNow": { N: String(leaseNow) },
          ":leaseOperationToken": lease.operationToken,
          ":leaseOwnerGroup": lease.ownerGroup,
          ":leaseProject": lease.project,
          ":leaseRegistryRequestId": lease.registryRequestId,
          ":leaseRunAttempt": lease.runAttempt,
          ":leaseRunId": lease.runId,
          ":previousLeaseExpiresAt": lease.leaseExpiresAt,
        },
      }));
    } catch {
      throw cleanupFailure();
    }
    return renewedLease;
  };
  const requireActiveDomain = async (domainId) => {
    const item = await exactItem({
      pk: { S: "DOMAIN" },
      sk: { S: `DOMAIN#${domainId}` },
    });
    if (
      item === null
      || item.pk?.S !== "DOMAIN"
      || item.sk?.S !== `DOMAIN#${domainId}`
      || item.entityType?.S !== "DOMAIN"
      || item.id?.S !== domainId
      || item.status?.S !== "ACTIVE"
    ) {
      throw cleanupFailure();
    }
  };
  const resolveProductionRuntime = async () =>
    validateRuntimeIdentity(
      await runtimeControl.resolveEndpoint("PRODUCTION"),
      {
        accountId,
        endpointName: runtimeControl.productionEndpointName,
        region,
        runtimeId: runtimeControl.runtimeId,
      },
    );
  const recoverExperience = async (input) => {
    const keys = experienceKeys(input);
    const names = ["project", "agent", "deployment", "entitlement"];
    const items = {};
    for (const name of names) {
      items[name] = await exactItem(keys[name]);
    }
    const present = names.filter((name) => items[name] !== null);
    if (present.length === 0) return null;
    if (present.length !== names.length) throw cleanupFailure();
    const runtimeIdentity = runtimeIdentityFromDeployment(
      items.deployment,
      {
        accountId,
        endpointName: runtimeControl.productionEndpointName,
        region,
        runtimeId: runtimeControl.runtimeId,
      },
    );
    const expected = experienceItems({
      ...input,
      runtimeIdentity,
    });
    if (names.some((name) => !isDeepStrictEqual(items[name], expected[name]))) {
      throw cleanupFailure();
    }
    return {
      fixture: input.fixture,
      items: expected,
      keys,
    };
  };
  const recoverExperienceByActor = async (value) => {
    const input = experienceRecoveryInput(value);
    const fixture = experienceFixtureIdentity(
      "placeholder",
      input.ownership,
    );
    const response = await dynamoClient.send(new QueryCommand({
      TableName: platformStateTableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: {
        "#pk": "pk",
      },
      ExpressionAttributeValues: {
        ":pk": stringAttribute(`ENTITLEMENT#${input.actor}`),
      },
    }));
    if (response?.LastEvaluatedKey !== undefined) throw cleanupFailure();
    const items = Array.isArray(response?.Items) ? response.Items : [];
    if (items.length === 0) return null;
    const candidates = [];
    for (const entitlement of items) {
      const domainId = entitlement?.domainId?.S;
      const projectId = entitlement?.projectId?.S;
      const agentId = entitlement?.agentId?.S;
      const status = entitlement?.status?.S;
      if (
        !requiredString(domainId, DOMAIN_ID_PATTERN)
        || typeof projectId !== "string"
        || !projectId
        || projectId.includes("#")
        || typeof agentId !== "string"
        || !agentId
        || agentId.includes("#")
        || entitlement.pk?.S !== `ENTITLEMENT#${input.actor}`
        || entitlement.sk?.S
          !== `AGENT#${domainId}#${projectId}#${agentId}`
        || entitlement.entityType?.S !== "ENTITLEMENT"
        || entitlement.subject?.S !== input.actor
        || !["ACTIVE", "REVOKED"].includes(status)
      ) {
        throw cleanupFailure();
      }
      if (
        projectId === fixture.projectId
        && agentId === fixture.agentId
      ) {
        if (status !== "ACTIVE") throw cleanupFailure();
        candidates.push({ domainId });
      }
    }
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw cleanupFailure();
    return recoverExperience(experienceInput({
      ...input,
      domainId: candidates[0].domainId,
    }));
  };
  const transactionCanceled = (error) =>
    error instanceof TransactionCanceledException
    || error?.name === "TransactionCanceledException"
    || error?.code === "TransactionCanceledException";
  const waitUntilAbsent = async (read) => {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      if (await read() === null) return;
      if (attempt < pollAttempts - 1) await operationDelay(pollDelayMs);
    }
    throw cleanupFailure();
  };
  const pollRecord = async ({
    ownership,
    recordId,
    registryId,
    statuses,
  }) => {
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      const record = await getRecord(registryId, recordId);
      if (record === null) throw cleanupFailure();
      const identity = exactRecordIdentity({
        accountId,
        ownership,
        record,
        recordId,
        region,
        registryId,
      });
      if (statuses.includes(record.status)) return identity;
      if (
        !["CREATING", "UPDATING", "DRAFT", "PENDING_APPROVAL"]
          .includes(record.status)
      ) {
        throw cleanupFailure();
      }
      if (attempt < pollAttempts - 1) await operationDelay(pollDelayMs);
    }
    throw cleanupFailure();
  };
  const stagePersonaCleanup = async (input) => {
    const requests = roleSwitchingRequestIds(input.ownership);
    const administrator = input.actors.administrator;
    const reviewer = input.actors.reviewer;
    const ordinary = input.actors.ordinary;
    const fixture = input.fixture;
    const sessionId = generatedSessionId(
      administrator,
      requests.userInvoke,
    );
    const exactKey = (pk, sk) => ({
      pk: stringAttribute(pk),
      sk: stringAttribute(sk),
    });
    const exactNames = (value, names) =>
      isPlainObject(value)
      && Reflect.ownKeys(value).length === names.length
      && names.every((name) => Object.hasOwn(value, name));
    const exactString = (value, expected) =>
      exactNames(value, ["S"]) && value.S === expected;
    const validString = (value, pattern = /^.{1,2048}$/s) =>
      exactNames(value, ["S"])
      && typeof value.S === "string"
      && pattern.test(value.S);
    const exactNull = (value) =>
      exactNames(value, ["NULL"]) && value.NULL === true;
    const exactNumber = (value, expected) =>
      exactNames(value, ["N"]) && value.N === String(expected);
    const nonnegativeInteger = (value) =>
      exactNames(value, ["N"])
      && /^(?:0|[1-9][0-9]*)$/.test(value.N)
      && Number.isSafeInteger(Number(value.N));
    const exactBoolean = (value, expected) =>
      exactNames(value, ["BOOL"]) && value.BOOL === expected;
    const emptyStringList = (value) =>
      exactNames(value, ["L"]) && Array.isArray(value.L)
      && value.L.length === 0;
    const exactSingleStringList = (value, expected) =>
      exactNames(value, ["L"])
      && Array.isArray(value.L)
      && value.L.length === 1
      && exactString(value.L[0], expected);
    const isoTimestamp = (value) =>
      exactNames(value, ["S"])
      && typeof value.S === "string"
      && Number.isFinite(Date.parse(value.S))
      && new Date(Date.parse(value.S)).toISOString() === value.S;
    const fingerprintAttribute = (value, expected) =>
      validString(value, /^[0-9a-f]{64}$/)
      && (expected === undefined || value.S === expected);
    const exactProject = (value, expected) =>
      expected === null
        ? exactNull(value)
        : exactString(value, expected);
    const validAuthorizationEvidence = (value) =>
      validString(value, /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/);
    const validateItemIdentity = (item, key, names) =>
      exactNames(item, names)
      && exactString(item.pk, key.pk.S)
      && exactString(item.sk, key.sk.S);
    const approvalReason =
      "Approved by the hosted acceptance reviewer.";
    const entitlementReason =
      "Entitle the acceptance End User to the approved agent.";
    const accessReason =
      "Validate Domain Lead access administration.";
    const invokePrompt =
      "Run the hosted acceptance positive journey.";
    const feedbackComment =
      "Hosted acceptance positive journey verified.";
    const personaBuildOptions = {
      "chat-assistant": {
        memory: "longAndShortTerm",
        identity: true,
      },
      "workflow-orchestrator": {
        memory: "shortTerm",
        identity: false,
      },
    };
    const validPersonaBuildConfig = (value, blueprintId) => {
      const expected = personaBuildOptions[blueprintId];
      const config = value?.M;
      const parameters = config?.modelParameters?.M;
      const options = config?.buildOptions?.M;
      return expected !== undefined
        && exactNames(value, ["M"])
        && exactNames(config, [
          "instructions",
          "modelParameters",
          "buildOptions",
        ])
        && validString(config.instructions, /^.{1,8000}$/s)
        && exactNames(config.modelParameters, ["M"])
        && exactNames(parameters, ["temperature", "maxTokens"])
        && exactNumber(parameters.temperature, 0)
        && exactNumber(parameters.maxTokens, 128)
        && exactNames(config.buildOptions, ["M"])
        && exactNames(options, [
          "framework",
          "deployTarget",
          "memory",
          "streaming",
          "identity",
          "guardrails",
        ])
        && exactString(options.framework, "Strands")
        && exactString(options.deployTarget, "AgentCore Runtime")
        && exactString(options.memory, expected.memory)
        && exactBoolean(options.streaming, true)
        && exactBoolean(options.identity, expected.identity)
        && exactBoolean(options.guardrails, true);
    };
    const ordinaryUsername =
      `hosted-role-switching-ordinary-${input.ownership.runId}-`
      + input.ownership.runAttempt;
    const agentResource =
      `agent/${fixture.domainId}/${fixture.projectId}/${fixture.agentId}`;
    const deploymentResource =
      `deployment/${fixture.domainId}/${fixture.projectId}/`
      + fixture.deploymentId;
    const approvalResource =
      `approval/${fixture.domainId}/${fixture.approvalId}`;
    const entitlementResource =
      `entitlement/USER/${administrator}/${fixture.domainId}/`
      + `${fixture.projectId}/${fixture.agentId}`;
    const sessionResource = `session/${administrator}/${sessionId}`;
    const membershipResource =
      `domain-membership/${fixture.domainId}/${ordinary}`;
    const invocationFingerprint = fingerprint({
      agentId: publicAgentId(fixture),
      sessionId,
      prompt: invokePrompt,
    });
    const feedbackFingerprint = fingerprint({
      publicAgentId: publicAgentId(fixture),
      sessionId,
      rating: 5,
      comment: feedbackComment,
    });
    const invocationOutcomes = new Set();
    let feedbackPresent = false;
    const recordInvocationOutcome = (outcome) => {
      if (!["SUCCEEDED", "FAILED"].includes(outcome)) {
        throw cleanupFailure();
      }
      invocationOutcomes.add(outcome);
      if (
        invocationOutcomes.size !== 1
        || (outcome === "FAILED" && feedbackPresent)
      ) {
        throw cleanupFailure();
      }
    };
    const testFingerprint = fingerprint({
      agentRef: {
        domainId: fixture.domainId,
        projectId: fixture.projectId,
        agentId: fixture.agentId,
      },
      prompt: "Confirm this acceptance agent is ready.",
      maxTokens: 128,
    });
    const accessFingerprint = fingerprint({
      domainId: fixture.domainId,
      username: ordinaryUsername,
      reason: accessReason,
    });
    const entitlementFingerprint = fingerprint({
      domainId: fixture.domainId,
      projectId: fixture.projectId,
      agentId: fixture.agentId,
      subjectType: "USER",
      subject: administrator,
      expiresAt: null,
      reason: entitlementReason,
    });
    const agentNames = [
      "pk",
      "sk",
      "entityType",
      "domainId",
      "projectId",
      "id",
      "name",
      "description",
      "ownerSubject",
      "modelId",
      "toolIds",
      "mcpServerIds",
      "skillIds",
      "blueprintIds",
      "memoryIds",
      "knowledgeBaseIds",
      "buildConfig",
      "status",
      "createdBySubject",
      "createdAt",
      "updatedAt",
      "lastTestStatus",
      "lastTestedAt",
      "lastTestedBySubject",
      "lastTestModelId",
      "lastTestInputTokens",
      "lastTestOutputTokens",
      "lastTestRequestId",
      "lastTestEvidenceHash",
      "lastTestOutput",
    ];
    const deploymentNames = [
      "pk",
      "sk",
      "entityType",
      "domainId",
      "projectId",
      "id",
      "agentId",
      "environment",
      "status",
      "requesterSubject",
      "approverSubject",
      "decisionReason",
      "requestedAt",
      "decidedAt",
      "runtimeId",
      "runtimeArn",
      "runtimeStatus",
      "endpointName",
      "endpointArn",
      "runtimeVersion",
      "updatedAt",
    ];
    const approvalNames = [
      "pk",
      "sk",
      "entityType",
      "domainId",
      "id",
      "kind",
      "resourceType",
      "resourceId",
      "projectId",
      "status",
      "requesterSubject",
      "approverSubject",
      "reason",
      "requestedAt",
      "decidedAt",
    ];
    const entitlementNames = [
      "pk",
      "sk",
      "entityType",
      "subject",
      "agentId",
      "domainId",
      "projectId",
      "status",
      "grantedBySubject",
      "grantedAt",
      "revokedBySubject",
      "revokedAt",
      "subjectType",
      "expiresAt",
    ];
    const sessionNames = [
      "pk",
      "sk",
      "entityType",
      "actor",
      "id",
      "agentId",
      "domainId",
      "projectId",
      "status",
      "lastInvocationStatus",
      "createdAt",
      "updatedAt",
    ];
    const invocationNames = [
      "pk",
      "sk",
      "entityType",
      "actor",
      "requestId",
      "payloadFingerprint",
      "sessionId",
      "domainId",
      "projectId",
      "agentId",
      "baselineFingerprint",
      "phase",
      "createdAt",
      "runtimeStatus",
      "output",
      "invocationId",
      "completedAt",
    ];
    const feedbackNames = [
      "pk",
      "sk",
      "entityType",
      "submissionType",
      "id",
      "status",
      "actor",
      "effectiveRole",
      "route",
      "requestId",
      "payloadFingerprint",
      "createdAt",
      "domainId",
      "projectId",
      "agentId",
      "sessionId",
      "rating",
      "comment",
    ];
    const entityReads = [
      {
        key: exactKey(
          `AGENT#${fixture.domainId}#${fixture.projectId}`,
          `AGENT#${fixture.agentId}`,
        ),
        validate(item, key) {
          const status = item.status?.S;
          const blueprintId = item.blueprintIds?.L?.[0]?.S;
          const succeeded = [
            "TESTED",
            "PRODUCTION_PENDING",
            "PRODUCTION_APPROVED",
            "PRODUCTION_DEPLOYED",
          ].includes(status);
          const failed = status === "TEST_FAILED";
          return validateItemIdentity(item, key, agentNames)
            && exactString(item.entityType, "AGENT")
            && exactString(item.domainId, fixture.domainId)
            && exactString(item.projectId, fixture.projectId)
            && exactString(item.id, fixture.agentId)
            && validString(item.name, /^.{1,128}$/s)
            && validString(item.description, /^.{1,4096}$/s)
            && exactString(item.ownerSubject, administrator)
            && validString(item.modelId, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/)
            && [
              "toolIds",
              "mcpServerIds",
              "skillIds",
              "memoryIds",
              "knowledgeBaseIds",
            ].every((name) => emptyStringList(item[name]))
            && exactSingleStringList(item.blueprintIds, blueprintId)
            && validPersonaBuildConfig(item.buildConfig, blueprintId)
            && [
              "DRAFT",
              "READY_FOR_TEST",
              "TEST_FAILED",
              "TESTED",
              "PRODUCTION_PENDING",
              "PRODUCTION_APPROVED",
              "PRODUCTION_DEPLOYED",
            ].includes(status)
            && exactString(item.createdBySubject, administrator)
            && isoTimestamp(item.createdAt)
            && isoTimestamp(item.updatedAt)
            && (
              succeeded
                ? (
                  exactString(item.lastTestStatus, "SUCCEEDED")
                  && isoTimestamp(item.lastTestedAt)
                  && exactString(item.lastTestedBySubject, administrator)
                  && exactString(item.lastTestModelId, item.modelId.S)
                  && nonnegativeInteger(item.lastTestInputTokens)
                  && nonnegativeInteger(item.lastTestOutputTokens)
                  && validString(item.lastTestRequestId)
                  && fingerprintAttribute(item.lastTestEvidenceHash)
                  && validString(item.lastTestOutput)
                )
                : failed
                  ? (
                    exactString(item.lastTestStatus, "FAILED")
                    && isoTimestamp(item.lastTestedAt)
                    && exactString(
                      item.lastTestedBySubject,
                      administrator,
                    )
                    && exactString(item.lastTestModelId, item.modelId.S)
                    && exactNumber(item.lastTestInputTokens, 0)
                    && exactNumber(item.lastTestOutputTokens, 0)
                    && validString(
                      item.lastTestRequestId,
                      /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/,
                    )
                    && [true, false].some((retryable) =>
                      fingerprintAttribute(
                        item.lastTestEvidenceHash,
                        fingerprint({
                          status: "FAILED",
                          modelId: item.modelId.S,
                          inputTokens: 0,
                          outputTokens: 0,
                          requestId: item.lastTestRequestId.S,
                          retryable,
                        }),
                      )
                    )
                    && exactNull(item.lastTestOutput)
                  )
                  : [
                    "lastTestStatus",
                    "lastTestedAt",
                    "lastTestedBySubject",
                    "lastTestModelId",
                    "lastTestInputTokens",
                    "lastTestOutputTokens",
                    "lastTestRequestId",
                    "lastTestEvidenceHash",
                    "lastTestOutput",
                  ].every((name) => exactNull(item[name]))
            );
        },
      },
      {
        key: exactKey(
          `DEPLOYMENT#${fixture.domainId}#${fixture.projectId}`,
          `DEPLOYMENT#${fixture.deploymentId}`,
        ),
        validate(item, key) {
          const status = item.status?.S;
          const runtimeNames = [
            "runtimeId",
            "runtimeArn",
            "runtimeStatus",
            "endpointName",
            "endpointArn",
            "runtimeVersion",
          ];
          const decisionFields = status === "REQUESTED"
            ? (
              exactNull(item.approverSubject)
              && exactNull(item.decisionReason)
              && exactNull(item.decidedAt)
            )
            : (
              exactString(item.approverSubject, reviewer)
              && exactString(item.decisionReason, approvalReason)
              && isoTimestamp(item.decidedAt)
            );
          let runtimeFields = runtimeNames.every(
            (name) => exactNull(item[name]),
          );
          if (status === "DEPLOYED") {
            try {
              runtimeIdentityFromDeployment(item, {
                accountId,
                endpointName: runtimeControl.productionEndpointName,
                region,
                runtimeId: runtimeControl.runtimeId,
              });
              runtimeFields = true;
            } catch {
              runtimeFields = false;
            }
          }
          return validateItemIdentity(item, key, deploymentNames)
            && exactString(item.entityType, "DEPLOYMENT")
            && exactString(item.domainId, fixture.domainId)
            && exactString(item.projectId, fixture.projectId)
            && exactString(item.id, fixture.deploymentId)
            && exactString(item.agentId, fixture.agentId)
            && exactString(item.environment, "PRODUCTION")
            && ["REQUESTED", "APPROVED", "DEPLOYING", "DEPLOYED"]
              .includes(status)
            && exactString(item.requesterSubject, administrator)
            && decisionFields
            && isoTimestamp(item.requestedAt)
            && runtimeFields
            && isoTimestamp(item.updatedAt);
        },
      },
      {
        key: exactKey(
          `APPROVAL#${fixture.domainId}`,
          `APPROVAL#${fixture.approvalId}`,
        ),
        validate(item, key) {
          const status = item.status?.S;
          return validateItemIdentity(item, key, approvalNames)
            && exactString(item.entityType, "APPROVAL")
            && exactString(item.domainId, fixture.domainId)
            && exactString(item.projectId, fixture.projectId)
            && exactString(item.id, fixture.approvalId)
            && exactString(item.resourceId, fixture.deploymentId)
            && exactString(item.kind, "PRODUCTION_DEPLOYMENT")
            && exactString(item.resourceType, "DEPLOYMENT")
            && ["PENDING", "APPROVED"].includes(status)
            && exactString(item.requesterSubject, administrator)
            && isoTimestamp(item.requestedAt)
            && (
              status === "PENDING"
                ? (
                  exactNull(item.approverSubject)
                  && exactNull(item.reason)
                  && exactNull(item.decidedAt)
                )
                : (
                  exactString(item.approverSubject, reviewer)
                  && exactString(item.reason, approvalReason)
                  && isoTimestamp(item.decidedAt)
                )
            );
        },
      },
      {
        key: exactKey(
          `ENTITLEMENT#${administrator}`,
          `AGENT#${fixture.domainId}#${fixture.projectId}`
            + `#${fixture.agentId}`,
        ),
        validate(item, key) {
          return validateItemIdentity(item, key, entitlementNames)
            && exactString(item.entityType, "ENTITLEMENT")
            && exactString(item.subjectType, "USER")
            && exactString(item.subject, administrator)
            && exactString(item.domainId, fixture.domainId)
            && exactString(item.projectId, fixture.projectId)
            && exactString(item.agentId, fixture.agentId)
            && exactString(item.status, "ACTIVE")
            && exactNull(item.expiresAt)
            && exactString(item.grantedBySubject, reviewer)
            && isoTimestamp(item.grantedAt)
            && exactNull(item.revokedBySubject)
            && exactNull(item.revokedAt);
        },
      },
      {
        key: exactKey(
          `SESSION#${administrator}`,
          `SESSION#${sessionId}`,
        ),
        outcome: (item) => item.lastInvocationStatus.S,
        validate(item, key) {
          return validateItemIdentity(item, key, sessionNames)
            && exactString(item.entityType, "SESSION")
            && exactString(item.actor, administrator)
            && exactString(item.id, sessionId)
            && exactString(item.domainId, fixture.domainId)
            && exactString(item.projectId, fixture.projectId)
            && exactString(item.agentId, fixture.agentId)
            && exactString(item.status, "ACTIVE")
            && ["SUCCEEDED", "FAILED"].some((outcome) =>
              exactString(item.lastInvocationStatus, outcome)
            )
            && isoTimestamp(item.createdAt)
            && isoTimestamp(item.updatedAt);
        },
      },
      {
        key: exactKey(
          `EXPERIENCE_INVOCATION#${administrator}`,
          `REQUEST#${requests.userInvoke}`,
        ),
        outcome: (item) => item.runtimeStatus.S,
        validate(item, key) {
          const runtimeStatus = item.runtimeStatus?.S;
          return validateItemIdentity(item, key, invocationNames)
            && exactString(item.entityType, "EXPERIENCE_INVOCATION")
            && exactString(item.actor, administrator)
            && exactString(item.requestId, requests.userInvoke)
            && fingerprintAttribute(
              item.payloadFingerprint,
              invocationFingerprint,
            )
            && exactString(item.sessionId, sessionId)
            && exactString(item.domainId, fixture.domainId)
            && exactString(item.projectId, fixture.projectId)
            && exactString(item.agentId, fixture.agentId)
            && exactString(item.baselineFingerprint, "NONE")
            && exactString(item.phase, "COMPLETED")
            && isoTimestamp(item.createdAt)
            && (
              runtimeStatus === "SUCCEEDED"
                ? (
                  exactString(item.runtimeStatus, "SUCCEEDED")
                  && validString(item.output)
                  && validString(item.invocationId)
                )
                : runtimeStatus === "FAILED"
                  ? (
                    exactString(item.runtimeStatus, "FAILED")
                    && exactNull(item.output)
                    && exactNull(item.invocationId)
                  )
                  : false
            )
            && isoTimestamp(item.completedAt);
        },
      },
      {
        key: exactKey(
          `SUBMISSION#${administrator}`,
          `FEEDBACK#${
            feedbackId(
              input,
              fixture,
              sessionId,
              requests.userFeedback,
            )
          }`,
        ),
        feedback: true,
        validate(item, key) {
          const id = feedbackId(
            input,
            fixture,
            sessionId,
            requests.userFeedback,
          );
          return validateItemIdentity(item, key, feedbackNames)
            && exactString(item.entityType, "EXPERIENCE_SUBMISSION")
            && exactString(item.submissionType, "FEEDBACK")
            && exactString(item.id, id)
            && exactString(item.status, "RECORDED")
            && exactString(item.actor, administrator)
            && exactString(item.effectiveRole, "user")
            && exactString(item.route, "POST /api/experience/feedback")
            && exactString(item.requestId, requests.userFeedback)
            && fingerprintAttribute(
              item.payloadFingerprint,
              feedbackFingerprint,
            )
            && isoTimestamp(item.createdAt)
            && exactString(item.domainId, fixture.domainId)
            && exactString(item.projectId, fixture.projectId)
            && exactString(item.agentId, fixture.agentId)
            && exactString(item.sessionId, sessionId)
            && exactNumber(item.rating, 5)
            && exactString(item.comment, feedbackComment);
        },
      },
    ];
    const mutationSpec = ({
      actor,
      requesterSubject = actor,
      effectiveRole,
      projectId = fixture.projectId,
      route,
      requestId,
      payloadFingerprint,
      entityType,
      resourceKey,
      operation,
      decision,
      reason,
      authorizationEvidence = false,
      accessAdmin = false,
      auditResource,
      auditAction,
      outcomes,
    }) => ({
      actor,
      requesterSubject,
      effectiveRole,
      projectId,
      route,
      requestId,
      payloadFingerprint,
      entityType,
      resourceKey,
      operation,
      decision,
      reason,
      authorizationEvidence,
      accessAdmin,
      auditResource,
      auditAction:
        auditAction ?? `${entityType.toLowerCase()}.${operation.toLowerCase()}`,
      outcomes,
    });
    const mutationSpecs = [
      mutationSpec({
        actor: administrator,
        effectiveRole: "builder",
        route: "POST /api/agents",
        requestId: requests.builderCreateAgent,
        entityType: "AGENT",
        resourceKey: agentResource,
        operation: "CREATE",
        decision: "create",
        reason: "Agent draft created.",
      }),
      mutationSpec({
        actor: administrator,
        effectiveRole: "builder",
        route: "PUT /api/agents/{id}",
        requestId: requests.builderConfigureAgent,
        entityType: "AGENT",
        resourceKey: agentResource,
        operation: "UPDATE",
        decision: "update",
        reason: "Agent configuration completed.",
      }),
      mutationSpec({
        actor: administrator,
        effectiveRole: "builder",
        route: "POST /api/agents/{id}/test",
        requestId: requests.builderTestAgent,
        payloadFingerprint: testFingerprint,
        entityType: "AGENT",
        resourceKey: agentResource,
        operation: "UPDATE",
        outcomes: [
          {
            decision: "update",
            reason: "Gateway test succeeded.",
            status: "SUCCEEDED",
          },
          {
            decision: "abort",
            reason: "Gateway test failed with a retryable error.",
            status: "FAILED",
          },
          {
            decision: "abort",
            reason: "Gateway test was rejected.",
            status: "FAILED",
          },
        ],
      }),
      mutationSpec({
        actor: administrator,
        effectiveRole: "builder",
        route: "POST /api/deployments/production",
        requestId: `${requests.builderProduction}.production-request`,
        entityType: "DEPLOYMENT",
        resourceKey: deploymentResource,
        operation: "CREATE",
        decision: "create",
        reason: "Production deployment requested.",
      }),
      mutationSpec({
        actor: administrator,
        effectiveRole: "builder",
        route: "POST /api/deployments/production",
        requestId: `${requests.builderProduction}.production-approval`,
        entityType: "APPROVAL",
        resourceKey: approvalResource,
        operation: "CREATE",
        decision: "create",
        reason: "Domain approval requested.",
      }),
      mutationSpec({
        actor: administrator,
        effectiveRole: "builder",
        route: "POST /api/deployments/production",
        requestId: `${requests.builderProduction}.production-agent`,
        entityType: "AGENT",
        resourceKey: agentResource,
        operation: "UPDATE",
        decision: "update",
        reason: "Agent lifecycle advanced to PRODUCTION_PENDING.",
      }),
      mutationSpec({
        actor: reviewer,
        requesterSubject: administrator,
        effectiveRole: "lead",
        route: "POST /api/deployment-decisions",
        requestId: `${requests.leadApproval}.approval-approve`,
        entityType: "APPROVAL",
        resourceKey: approvalResource,
        operation: "UPDATE",
        decision: "approve",
        reason: approvalReason,
      }),
      mutationSpec({
        actor: reviewer,
        requesterSubject: administrator,
        effectiveRole: "lead",
        route: "POST /api/deployment-decisions",
        requestId: `${requests.leadApproval}.deployment-approve`,
        entityType: "DEPLOYMENT",
        resourceKey: deploymentResource,
        operation: "UPDATE",
        decision: "approve",
        reason: approvalReason,
      }),
      mutationSpec({
        actor: reviewer,
        requesterSubject: administrator,
        effectiveRole: "lead",
        route: "POST /api/deployment-decisions",
        requestId: `${requests.leadApproval}.production-start`,
        entityType: "DEPLOYMENT",
        resourceKey: deploymentResource,
        operation: "UPDATE",
        decision: "update",
        reason: "Approved production deployment started.",
      }),
      mutationSpec({
        actor: reviewer,
        requesterSubject: administrator,
        effectiveRole: "lead",
        route: "POST /api/deployment-decisions",
        requestId: `${requests.leadApproval}.production-ready`,
        entityType: "DEPLOYMENT",
        resourceKey: deploymentResource,
        operation: "UPDATE",
        decision: "update",
        reason: "Production reached the governed Runtime endpoint.",
      }),
      mutationSpec({
        actor: reviewer,
        effectiveRole: "lead",
        route: "POST /api/deployment-decisions",
        requestId: `${requests.leadApproval}.agent-approved`,
        entityType: "AGENT",
        resourceKey: agentResource,
        operation: "UPDATE",
        decision: "update",
        reason: "Agent lifecycle advanced to PRODUCTION_APPROVED.",
      }),
      mutationSpec({
        actor: reviewer,
        effectiveRole: "lead",
        route: "POST /api/deployment-decisions",
        requestId: `${requests.leadApproval}.agent-deployed`,
        entityType: "AGENT",
        resourceKey: agentResource,
        operation: "UPDATE",
        decision: "update",
        reason: "Agent lifecycle advanced to PRODUCTION_DEPLOYED.",
      }),
      mutationSpec({
        actor: reviewer,
        requesterSubject: ordinary,
        effectiveRole: "lead",
        projectId: null,
        route: "POST /api/access/domain-memberships",
        requestId: requests.leadAccessGrant,
        payloadFingerprint: accessFingerprint,
        entityType: "WORKSPACE_AUDIT",
        resourceKey: (timestamp) =>
          `audit/${membershipResource}/${timestamp}/`
          + requests.leadAccessGrant,
        operation: "APPEND",
        decision: "grant",
        reason: accessReason,
        accessAdmin: true,
        auditResource: membershipResource,
        auditAction: "access.domain-members.grant",
      }),
      mutationSpec({
        actor: reviewer,
        effectiveRole: "lead",
        route: "POST /api/governance/agent-entitlements",
        requestId: requests.leadEntitlementGrant,
        payloadFingerprint: entitlementFingerprint,
        entityType: "ENTITLEMENT",
        resourceKey: entitlementResource,
        operation: "CREATE",
        decision: "grant",
        reason: entitlementReason,
      }),
      mutationSpec({
        actor: administrator,
        effectiveRole: "user",
        route: "POST /api/experience/invocations",
        requestId: requests.userInvoke,
        payloadFingerprint: invocationFingerprint,
        entityType: "SESSION",
        resourceKey: sessionResource,
        operation: "CREATE",
        outcomes: [
          {
            decision: "create",
            invocationStatus: "SUCCEEDED",
            reason: "Governed invocation completed with SUCCEEDED.",
            status: "SUCCEEDED",
          },
          {
            decision: "create",
            invocationStatus: "FAILED",
            reason: "Governed invocation completed with FAILED.",
            status: "SUCCEEDED",
          },
        ],
      }),
    ];
    const claimSpecs = [
      {
        actor: administrator,
        requesterSubject: administrator,
        effectiveRole: "builder",
        projectId: fixture.projectId,
        route: "POST /api/agents/{id}/test",
        requestId: requests.builderTestAgent,
        payloadFingerprint: testFingerprint,
        resourceKey: agentResource,
        operation: "UPDATE",
      },
      {
        actor: reviewer,
        requesterSubject: ordinary,
        effectiveRole: "lead",
        projectId: null,
        route: "POST /api/access/domain-memberships",
        requestId: requests.leadAccessGrant,
        payloadFingerprint: accessFingerprint,
        resourceKey: membershipResource,
        operation: "CREATE",
      },
      {
        actor: administrator,
        requesterSubject: administrator,
        effectiveRole: "user",
        projectId: fixture.projectId,
        route: "POST /api/experience/invocations/claim",
        requestId: requests.userInvoke,
        payloadFingerprint: invocationFingerprint,
        resourceKey: sessionResource,
        operation: "CREATE",
      },
    ];
    const deletes = [];
    for (const {
      key,
      validate,
      outcome: itemOutcome,
      feedback = false,
    } of entityReads) {
      const item = await exactItem(key);
      if (item === null) continue;
      if (validate(item, key) !== true) {
        throw cleanupFailure();
      }
      if (itemOutcome !== undefined) {
        recordInvocationOutcome(itemOutcome(item));
      }
      if (feedback) {
        feedbackPresent = true;
        if (invocationOutcomes.has("FAILED")) throw cleanupFailure();
      }
      deletes.push({ key, item });
    }
    const mutationItemNames = [
      "pk",
      "sk",
      "entityType",
      "actor",
      "requesterSubject",
      "effectiveRole",
      "domainId",
      "projectId",
      "route",
      "requestId",
      "payloadFingerprint",
      "result",
      "decision",
      "reason",
      "timestamp",
      "createdAt",
    ];
    const claimItemNames = [
      "pk",
      "sk",
      "entityType",
      "actor",
      "requesterSubject",
      "effectiveRole",
      "domainId",
      "projectId",
      "route",
      "requestId",
      "payloadFingerprint",
      "resourceKey",
      "operation",
      "createdAt",
    ];
    const auditItemNames = [
      "pk",
      "sk",
      "entityType",
      "resource",
      "timestamp",
      "requestId",
      "actor",
      "requesterSubject",
      "effectiveRole",
      "action",
      "decision",
      "reason",
      "domainId",
      "projectId",
    ];
    for (const spec of claimSpecs) {
      const key = exactKey(
        `MUTATION#${spec.actor}`,
        `CLAIM#${spec.route}#${spec.requestId}`,
      );
      const item = await exactItem(key);
      if (item === null) continue;
      if (
        !validateItemIdentity(item, key, claimItemNames)
        || !exactString(item.entityType, "MUTATION_CLAIM")
        || !exactString(item.actor, spec.actor)
        || !exactString(item.requesterSubject, spec.requesterSubject)
        || !exactString(item.effectiveRole, spec.effectiveRole)
        || !exactString(item.domainId, fixture.domainId)
        || !exactProject(item.projectId, spec.projectId)
        || !exactString(item.route, spec.route)
        || !exactString(item.requestId, spec.requestId)
        || !fingerprintAttribute(
          item.payloadFingerprint,
          spec.payloadFingerprint,
        )
        || !exactString(item.resourceKey, spec.resourceKey)
        || !exactString(item.operation, spec.operation)
        || !isoTimestamp(item.createdAt)
      ) {
        throw cleanupFailure();
      }
      deletes.push({ key, item });
    }
    for (const spec of mutationSpecs) {
      const key = exactKey(
        `MUTATION#${spec.actor}`,
        `MUTATION#${spec.route}#${spec.requestId}`,
      );
      const item = await exactItem(key);
      if (item === null) continue;
      const timestamp = item.timestamp?.S;
      const resource = typeof spec.resourceKey === "function"
        ? spec.resourceKey(timestamp)
        : spec.resourceKey;
      const resultNames = spec.accessAdmin
        ? [
            "entityType",
            "resourceKey",
            "operation",
            "status",
            "accessAdmin",
          ]
        : ["entityType", "resourceKey", "operation", "status"];
      const expectedMutationNames = spec.authorizationEvidence
        ? [...mutationItemNames, "authorizationEvidenceId"]
        : mutationItemNames;
      const result = item.result?.M;
      const outcome = Array.isArray(spec.outcomes)
        ? spec.outcomes.find((candidate) =>
            exactString(result?.status, candidate.status)
            && exactString(item.decision, candidate.decision)
            && exactString(item.reason, candidate.reason)
          )
        : {
            decision: spec.decision,
            reason: spec.reason,
            status: "SUCCEEDED",
          };
      if (
        !validateItemIdentity(item, key, expectedMutationNames)
        || !exactString(item.entityType, "MUTATION_RESULT")
        || !exactString(item.actor, spec.actor)
        || !exactString(item.requesterSubject, spec.requesterSubject)
        || !exactString(item.effectiveRole, spec.effectiveRole)
        || !exactString(item.domainId, fixture.domainId)
        || !exactProject(item.projectId, spec.projectId)
        || !exactString(item.route, spec.route)
        || !exactString(item.requestId, spec.requestId)
        || !fingerprintAttribute(
          item.payloadFingerprint,
          spec.payloadFingerprint,
        )
        || !exactNames(item.result, ["M"])
        || !exactNames(result, resultNames)
        || !exactString(result.entityType, spec.entityType)
        || !exactString(result.resourceKey, resource)
        || !exactString(result.operation, spec.operation)
        || outcome === undefined
        || !exactString(result.status, outcome.status)
        || !exactString(item.decision, outcome.decision)
        || !exactString(item.reason, outcome.reason)
        || !isoTimestamp(item.timestamp)
        || !isoTimestamp(item.createdAt)
        || item.createdAt.S !== timestamp
        || (
          spec.authorizationEvidence
          && !validAuthorizationEvidence(item.authorizationEvidenceId)
        )
      ) {
        throw cleanupFailure();
      }
      if (spec.accessAdmin) {
        const accessAdmin = result.accessAdmin?.M;
        if (
          !exactNames(result.accessAdmin, ["M"])
          || !exactNames(accessAdmin, [
            "username",
            "subject",
            "membershipStatus",
            "changed",
          ])
          || !exactString(accessAdmin.username, ordinaryUsername)
          || !exactString(accessAdmin.subject, ordinary)
          || !exactString(accessAdmin.membershipStatus, "ACTIVE")
          || !exactBoolean(accessAdmin.changed, true)
        ) {
          throw cleanupFailure();
        }
      }
      const auditResource = spec.auditResource ?? resource;
      const auditKey = exactKey(
        `AUDIT#${auditResource}`,
        `${timestamp}#${spec.requestId}`,
      );
      const audit = await exactItem(auditKey);
      if (audit !== null) {
        const expectedAuditNames = spec.authorizationEvidence
          ? [...auditItemNames, "authorizationEvidenceId"]
          : auditItemNames;
        if (
          !validateItemIdentity(audit, auditKey, expectedAuditNames)
          || !exactString(audit.entityType, "WORKSPACE_AUDIT")
          || !exactString(audit.resource, auditResource)
          || !exactString(audit.timestamp, timestamp)
          || !exactString(audit.requestId, spec.requestId)
          || !exactString(audit.actor, spec.actor)
          || !exactString(
            audit.requesterSubject,
            spec.requesterSubject,
          )
          || !exactString(audit.effectiveRole, spec.effectiveRole)
          || !exactString(audit.action, spec.auditAction)
          || !exactString(audit.decision, outcome.decision)
          || !exactString(audit.reason, outcome.reason)
          || !exactString(audit.domainId, fixture.domainId)
          || !exactProject(audit.projectId, spec.projectId)
          || (
            spec.authorizationEvidence
            && (
              !validAuthorizationEvidence(
                audit.authorizationEvidenceId,
              )
              || audit.authorizationEvidenceId.S
                !== item.authorizationEvidenceId.S
            )
          )
        ) {
          throw cleanupFailure();
        }
        deletes.push({ key: auditKey, item: audit });
      }
      if (outcome.invocationStatus !== undefined) {
        recordInvocationOutcome(outcome.invocationStatus);
      }
      deletes.push({ key, item });
    }
    return deletes;
  };
  const recoverExactDomain = async ({ actor, ownership }) => {
    const item = await exactItem({
      pk: { S: "DOMAIN" },
      sk: { S: `DOMAIN#${ownership.domainId}` },
    });
    if (item !== null) {
      return domainFromItem({
        accountId,
        actor,
        item,
        ownership,
        region,
      });
    }
    if (actor === undefined) return null;
    const requestItem = await exactItem({
      pk: { S: `REQUEST#${actor}` },
      sk: {
        S: "REQUEST#POST /api/domain-create#"
          + ownership.requestIds.domain,
      },
    });
    return requestItem === null
      ? null
      : retryableDomainFromRequestItem({
          accountId,
          actor,
          item: requestItem,
          ownership,
          region,
        });
  };

  return {
    async persistActorMapping({ actor, ownership: value }) {
      const ownership = validatedOwnership(value);
      if (!requiredString(actor, ACTOR_PATTERN)) throw cleanupFailure();
      const item = mappingItem(actor, ownership);
      await dynamoClient.send(new PutItemCommand({
        TableName: platformStateTableName,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(pk) OR ("
          + "entityType = :entityType AND runId = :runId "
          + "AND runAttempt = :runAttempt AND actor = :actor "
          + "AND domainId = :domainId "
          + "AND domainRequestId = :domainRequestId "
          + "AND registryRequestId = :registryRequestId)",
        ExpressionAttributeValues: {
          ":actor": item.actor,
          ":domainId": item.domainId,
          ":domainRequestId": item.domainRequestId,
          ":entityType": item.entityType,
          ":registryRequestId": item.registryRequestId,
          ":runAttempt": item.runAttempt,
          ":runId": item.runId,
        },
      }));
      return { ok: true };
    },

    async recoverActorMapping({ ownership: value }) {
      const ownership = validatedOwnership(value);
      const item = await exactItem(mappingKey(ownership));
      return item === null ? null : actorFromMapping(item, ownership);
    },

    async createRegistryFixture({ ownership: value, registryId }) {
      const ownership = validatedOwnership(value);
      const exactRegistry = exactRegistryId(registryId, true);
      const created = await registryClient.send(
        new CreateRegistryRecordCommand({
          clientToken: ownership.fixtureClientToken,
          description: ownership.registryDescription,
          descriptors: {
            custom: {
              data: JSON.stringify(ownership.registryDescriptor),
            },
          },
          displayName: ownership.registryDisplayName,
          name: ownership.registryRecordName,
          recordType: "CUSTOM",
          recordVersion: ownership.registryVersion,
          registryId: exactRegistry,
          tags: ownership.tags,
        }),
      );
      const prefix = `${registryArn(
        region,
        accountId,
        exactRegistry,
      )}/record/`;
      if (
        typeof created?.recordArn !== "string"
        || !created.recordArn.startsWith(prefix)
      ) {
        throw cleanupFailure();
      }
      const recordId = exactRecordId(created.recordArn.slice(prefix.length));
      await pollRecord({
        ownership,
        recordId,
        registryId: exactRegistry,
        statuses: ["DRAFT"],
      });
      await registryClient.send(
        new SubmitRegistryRecordForApprovalCommand({
          registryId: exactRegistry,
          recordId,
        }),
      );
      const identity = await pollRecord({
        ownership,
        recordId,
        registryId: exactRegistry,
        statuses: ["PENDING_APPROVAL"],
      });
      await exactTags(identity.recordArn);
      return identity;
    },

    async recoverRegistryFixture({ ownership: value, registryId }) {
      const ownership = validatedOwnership(value);
      const exactRegistry = exactRegistryId(registryId, true);
      const response = await registryClient.send(
        new ListRegistryRecordsCommand({
          filters: [{
            name: "name",
            values: [ownership.registryRecordName],
          }],
          maxResults: 10,
          registryId: exactRegistry,
        }),
      );
      if (response?.nextToken !== undefined) throw cleanupFailure();
      const matches = Array.isArray(response?.registryRecords)
        ? response.registryRecords.filter(
            (record) => record?.name === ownership.registryRecordName,
          )
        : [];
      if (matches.length === 0) return null;
      if (matches.length !== 1) throw cleanupFailure();
      const recordId = exactRecordId(matches[0].recordId);
      const record = await getRecord(exactRegistry, recordId);
      if (record === null) return null;
      const identity = exactRecordIdentity({
        accountId,
        ownership,
        record,
        recordId,
        region,
        registryId: exactRegistry,
      });
      await exactTags(identity.recordArn);
      return identity;
    },

    async recoverDomain({ actor, ownership: value }) {
      const ownership = validatedOwnership(value);
      if (actor !== undefined && !requiredString(actor, ACTOR_PATTERN)) {
        throw cleanupFailure();
      }
      return recoverExactDomain({ actor, ownership });
    },

    async provisionExperienceFixture(value) {
      const input = experienceInput(value);
      await requireActiveDomain(input.domainId);
      const items = experienceItems({
        ...input,
        runtimeIdentity: await resolveProductionRuntime(),
      });
      const puts = [
        items.project,
        items.agent,
        items.deployment,
        items.entitlement,
      ].map((item) => ({
        Put: {
          TableName: platformStateTableName,
          Item: item,
          ...absentItemCondition(),
        },
      }));
      try {
        await dynamoClient.send(new TransactWriteItemsCommand({
          TransactItems: puts,
        }));
      } catch (error) {
        if (transactionCanceled(error)) {
          const recovered = await recoverExperience(input);
          if (recovered === null) throw cleanupFailure();
          return recovered.fixture;
        }
        throw error;
      }
      return input.fixture;
    },

    async recoverExperienceFixture(value) {
      const recovered = isPlainObject(value)
        && Reflect.ownKeys(value).length === EXPERIENCE_RECOVERY_INPUT_KEYS.size
        && Reflect.ownKeys(value).every((key) =>
          typeof key === "string"
          && EXPERIENCE_RECOVERY_INPUT_KEYS.has(key)
        )
        ? await recoverExperienceByActor(value)
        : await recoverExperience(experienceInput(value));
      return recovered?.fixture ?? null;
    },

    async cleanupExperienceFixture(value) {
      const input = experienceInput(value, { cleanup: true });
      const recovered = await recoverExperience(input);
      if (recovered === null) return { ok: true };
      const deletes = [
        ["entitlement", recovered.items.entitlement],
        ["deployment", recovered.items.deployment],
        ["agent", recovered.items.agent],
        ["project", recovered.items.project],
      ].map(([name, item]) => ({
        Delete: {
          TableName: platformStateTableName,
          Key: recovered.keys[name],
          ...exactItemCondition(item),
        },
      }));
      try {
        await dynamoClient.send(new TransactWriteItemsCommand({
          TransactItems: deletes,
        }));
      } catch (error) {
        if (!transactionCanceled(error)) throw error;
        const after = await recoverExperience(input);
        if (after !== null) throw cleanupFailure();
      }
      return { ok: true };
    },

    async persistPersonaJourneyFixture(value) {
      const input = personaInput(value);
      const item = personaMappingItem(input);
      await dynamoClient.send(new PutItemCommand({
        TableName: platformStateTableName,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(pk) OR ("
          + "entityType = :entityType "
          + "AND administratorActor = :administratorActor "
          + "AND reviewerActor = :reviewerActor "
          + "AND ordinaryActor = :ordinaryActor "
          + "AND domainId = :domainId "
          + "AND projectId = :projectId "
          + "AND agentId = :agentId "
          + "AND deploymentId = :deploymentId "
          + "AND approvalId = :approvalId "
          + "AND managedBy = :managedBy AND #project = :project "
          + "AND runId = :runId AND runAttempt = :runAttempt)",
        ExpressionAttributeNames: {
          "#project": "project",
        },
        ExpressionAttributeValues: Object.fromEntries(
          Object.entries(item)
            .filter(([name]) => !["pk", "sk"].includes(name))
            .map(([name, attribute]) => [`:${name}`, attribute]),
        ),
      }));
      return { ok: true };
    },

    async cleanupPersonaJourneyFixture(value) {
      const fields = exactDataObject(
        value,
        PERSONA_CLEANUP_INPUT_KEYS,
      );
      const ownership = validatedOwnership(fields.ownership);
      const mappingKeyValue = personaMappingKey(ownership);
      const mapping = await exactItem(mappingKeyValue);
      if (mapping === null) return { ok: true };
      const input = personaFromMapping(mapping, ownership);
      const staged = [
        ...await stagePersonaCleanup(input),
        { key: mappingKeyValue, item: mapping },
      ];
      if (staged.length > 100) throw cleanupFailure();
      const deletes = staged.map(({ key, item }) => ({
        Delete: {
          TableName: platformStateTableName,
          Key: key,
          ...exactItemCondition(item),
        },
      }));
      try {
        await dynamoClient.send(new TransactWriteItemsCommand({
          TransactItems: deletes,
        }));
      } catch (error) {
        if (!transactionCanceled(error)) throw error;
        const after = await exactItem(mappingKeyValue);
        if (after === null) return { ok: true };
        if (!isDeepStrictEqual(after, mapping)) throw cleanupFailure();
        throw cleanupFailure();
      }
      return { ok: true };
    },

    async cleanupAgentBuildingJourneyFixtures(value) {
      const fields = exactDataObject(
        value,
        AGENT_BUILDING_CLEANUP_INPUT_KEYS,
      );
      if (!requiredString(fields.actor, ACTOR_PATTERN)) {
        throw cleanupFailure();
      }
      const actor = fields.actor;
      const domainId = exactDomainId(fields.domainId);
      const ownership = validatedOwnership(fields.ownership);
      const requests = roleSwitchingRequestIds(ownership);
      const repositoryName = (preset) =>
        `acceptance-${preset.toLowerCase()}-`
        + `${ownership.runId}-${ownership.runAttempt}`;
      const specs = [
        {
          requestId: requests.journeyMinimalCreate,
          operation: "CREATE_JOURNEY",
          resourceType: "JOURNEY",
          resource: "minimalJourney",
          preset: "MINIMAL",
        },
        {
          requestId: requests.journeyMinimalPreview,
          operation: "CREATE_PREVIEW",
          resourceType: "DELIVERY",
          resource: "minimalDelivery",
          preset: "MINIMAL",
        },
        {
          requestId: requests.journeySpecCreate,
          operation: "CREATE_JOURNEY",
          resourceType: "JOURNEY",
          resource: "specJourney",
          preset: "SPEC",
        },
        {
          requestId: requests.journeySpecMessage1,
          operation: "ADD_MESSAGE",
          resourceType: "JOURNEY",
          resource: "specJourney",
          preset: "SPEC",
        },
        {
          requestId: requests.journeySpecMessage2,
          operation: "ADD_MESSAGE",
          resourceType: "JOURNEY",
          resource: "specJourney",
          preset: "SPEC",
        },
        {
          requestId: requests.journeySpecContract,
          operation: "CREATE_CONTRACT",
          resourceType: "JOURNEY",
          resource: "specJourney",
          preset: "SPEC",
        },
        {
          requestId: requests.journeySpecPreview,
          operation: "CREATE_PREVIEW",
          resourceType: "DELIVERY",
          resource: "specDelivery",
          preset: "SPEC",
        },
        {
          requestId: requests.journeyFullPreview,
          operation: "CREATE_PREVIEW",
          resourceType: "DELIVERY",
          resource: "fullDelivery",
          preset: "FULL",
        },
      ].map((spec) => ({
        ...spec,
        repositoryName: repositoryName(spec.preset),
      }));
      const exactNames = (attribute, names) =>
        isPlainObject(attribute)
        && Reflect.ownKeys(attribute).length === names.length
        && names.every((name) => Object.hasOwn(attribute, name));
      const exactString = (attribute, expected) =>
        exactNames(attribute, ["S"]) && attribute.S === expected;
      const staged = [];
      const resources = new Map();

      for (const spec of specs) {
        const key = {
          pk: stringAttribute(`MUTATION#${actor}`),
          sk: stringAttribute(
            `JOURNEY#${spec.operation}#${spec.requestId}`,
          ),
        };
        const item = await exactItem(key);
        if (item === null) continue;
        const result = item.result?.M;
        const resourceId = item.resourceId?.S;
        const status = item.status?.S;
        const validResult = status === "IN_PROGRESS"
          ? exactNames(item.result, ["NULL"]) && item.result.NULL === true
          : status === "SUCCEEDED"
            && exactNames(item.result, ["M"])
            && exactNames(result, ["resourceType", "resourceId"])
            && exactString(result.resourceType, spec.resourceType)
            && exactString(result.resourceId, resourceId);
        if (
          !exactString(item.pk, key.pk.S)
          || !exactString(item.sk, key.sk.S)
          || !exactString(item.entityType, "JOURNEY_MUTATION")
          || !exactString(item.actor, actor)
          || !exactString(item.domainId, domainId)
          || !exactString(item.effectiveRole, "builder")
          || !exactString(item.operation, spec.operation)
          || !exactString(item.requestId, spec.requestId)
          || !["IN_PROGRESS", "SUCCEEDED"].includes(status)
          || !exactString(item.resourceType, spec.resourceType)
          || !requiredString(
            resourceId,
            JOURNEY_RESOURCE_ID_PATTERN,
          )
          || !validResult
        ) {
          throw cleanupFailure();
        }
        const previous = resources.get(spec.resource);
        if (previous !== undefined && previous.id !== resourceId) {
          throw cleanupFailure();
        }
        resources.set(spec.resource, {
          id: resourceId,
          type: spec.resourceType,
          preset: spec.preset,
          repositoryName: spec.repositoryName,
        });
        staged.push({ key, item });
      }

      for (const resource of resources.values()) {
        const key = {
          pk: stringAttribute(
            `${resource.type}#${actor}#${resource.id}`,
          ),
          sk: stringAttribute(resource.type),
        };
        const item = await exactItem(key);
        if (item === null) continue;
        const record = item.record?.M;
        if (
          !exactString(item.pk, key.pk.S)
          || !exactString(item.sk, key.sk.S)
          || !exactString(item.entityType, resource.type)
          || !exactString(item.actor, actor)
          || !exactString(item.id, resource.id)
          || !exactString(item.domainId, domainId)
          || !exactString(item.preset, resource.preset)
          || !exactNames(item.record, ["M"])
          || !isPlainObject(record)
          || !exactString(record.actor, actor)
          || !exactString(record.id, resource.id)
          || !exactString(record.domainId, domainId)
          || !exactString(record.preset, resource.preset)
          || !exactString(
            record.repositoryName,
            resource.repositoryName,
          )
        ) {
          throw cleanupFailure();
        }
        staged.push({ key, item });
      }

      if (staged.length === 0) return { ok: true };
      try {
        await dynamoClient.send(new TransactWriteItemsCommand({
          TransactItems: staged.map(({ key, item }) => ({
            Delete: {
              TableName: platformStateTableName,
              Key: key,
              ...exactItemCondition(item),
            },
          })),
        }));
      } catch (error) {
        if (!transactionCanceled(error)) throw error;
      }
      for (const { key } of staged) {
        if (await exactItem(key) !== null) throw cleanupFailure();
      }
      return { ok: true };
    },

    async cleanupExactResources({
      actor,
      domain,
      ownership: value,
      registryRecord,
      requestIds = [],
    }) {
      const ownership = validatedOwnership(value);
      const expectedRequests = [
        {
          route: "POST /api/domain-create",
          requestId: ownership.requestIds.domain,
        },
      ];
      const exactRequestSet = Array.isArray(requestIds)
        && requestIds.length === expectedRequests.length
        && expectedRequests.every((expected) =>
          requestIds.some((candidate) =>
            isDeepStrictEqual(candidate, expected)
          )
        );
      if (
        !requiredString(actor, ACTOR_PATTERN)
        || !Array.isArray(requestIds)
        || (requestIds.length > 0 && !exactRequestSet)
      ) {
        throw cleanupFailure();
      }
      const suppliedDomain =
        domain === undefined || domain === null
          ? null
          : validateDomain({
              accountId,
              actor,
              domain,
              ownership,
              region,
            });
      const operationToken = domainGroupOperationToken({
        actor,
        requestId: ownership.requestIds.domain,
      }, ownership.domainId);
      let lease;
      try {
        lease = await acquireCleanupLease({
          actor,
          operationToken,
          ownership,
        });
        const domainKey = {
          pk: { S: "DOMAIN" },
          sk: { S: `DOMAIN#${ownership.domainId}` },
        };
        const domainItem = await exactItem(domainKey);
        const authoritativeDomain = domainItem === null
          ? null
          : domainFromItem({
              accountId,
              actor,
              item: domainItem,
              ownership,
              region,
            });
        if (
          authoritativeDomain !== null
          && suppliedDomain !== null
          && (
            authoritativeDomain.registryId !== suppliedDomain.registryId
            || authoritativeDomain.registryArn !== suppliedDomain.registryArn
            || authoritativeDomain.createdBy !== suppliedDomain.createdBy
            || authoritativeDomain.ownerGroup !== suppliedDomain.ownerGroup
          )
        ) {
          throw cleanupFailure();
        }

        let requestItem = null;
        let requestKey = null;
        let mapping = null;
        if (exactRequestSet) {
          const request = expectedRequests[0];
          requestKey = {
            pk: { S: `REQUEST#${actor}` },
            sk: {
              S: `REQUEST#${request.route}#${request.requestId}`,
            },
          };
          requestItem = await exactItem(requestKey);
          if (
            requestItem !== null
            && (
              requestItem.pk?.S !== requestKey.pk.S
              || requestItem.sk?.S !== requestKey.sk.S
              || requestItem.actor?.S !== actor
              || requestItem.route?.S !== request.route
              || requestItem.requestId?.S !== request.requestId
            )
          ) {
            throw cleanupFailure();
          }
          mapping = await exactItem(mappingKey(ownership));
          if (
            mapping !== null
            && actorFromMapping(mapping, ownership) !== actor
          ) {
            throw cleanupFailure();
          }
        }

        let cleanupDomain = authoritativeDomain ?? suppliedDomain;
        if (
          cleanupDomain === null
          && requestItem !== null
        ) {
          cleanupDomain = retryableDomainFromRequestItem({
            accountId,
            actor,
            item: requestItem,
            ownership,
            region,
          });
        }

        const hasStoredDomainEvidence =
          domainItem !== null
          || requestItem !== null
          || mapping !== null;
        let domainRegistry = null;
        let domainRegistryChecked = false;
        if (cleanupDomain !== null && !hasStoredDomainEvidence) {
          domainRegistryChecked = true;
          domainRegistry = await getRegistry(cleanupDomain.registryId);
          if (
            domainRegistry !== null
            && (
              domainRegistry.registryId !== cleanupDomain.registryId
              || domainRegistry.registryArn !== cleanupDomain.registryArn
              || domainRegistry.name !== `domain_${ownership.domainId}`
              || domainRegistry.description
                !== `${ownership.domainName} domain registry`
            )
          ) {
            throw cleanupFailure();
          }
        }

        let recordIdentity = null;
        let recordChecked = false;
        if (
          registryRecord !== undefined
          && registryRecord !== null
          && !hasStoredDomainEvidence
          && domainRegistry === null
        ) {
          recordChecked = true;
          const registryId = exactRegistryId(
            registryRecord.registryId,
            true,
          );
          const recordId = exactRecordId(registryRecord.recordId);
          const record = await getRecord(registryId, recordId);
          if (record !== null) {
            recordIdentity = exactRecordIdentity({
              accountId,
              ownership,
              record,
              recordId,
              region,
              registryId,
            });
            if (!isDeepStrictEqual(recordIdentity, registryRecord)) {
              throw cleanupFailure();
            }
          }
        }

        const hasDurableEvidence =
          hasStoredDomainEvidence
          || domainRegistry !== null
          || recordIdentity !== null;
        if (!hasDurableEvidence) {
          await releaseCleanupLease(lease);
          lease = null;
          return { ok: true };
        }

        const hasDomainEvidence =
          domainItem !== null
          || requestItem !== null
          || mapping !== null
          || domainRegistry !== null;
        if (hasDomainEvidence || suppliedDomain !== null) {
          const cleanupOwnerGroup =
            cleanupDomain?.ownerGroup ?? ownership.ownerGroup;
          lease = await renewCleanupLease(lease);
          await domainDirectory.deleteGroupExact(
            cleanupOwnerGroup,
            operationToken,
          );
        }

        if (
          registryRecord !== undefined
          && registryRecord !== null
          && !recordChecked
        ) {
          const registryId = exactRegistryId(
            registryRecord.registryId,
            true,
          );
          const recordId = exactRecordId(registryRecord.recordId);
          const record = await getRecord(registryId, recordId);
          if (record !== null) {
            recordIdentity = exactRecordIdentity({
              accountId,
              ownership,
              record,
              recordId,
              region,
              registryId,
            });
            if (!isDeepStrictEqual(recordIdentity, registryRecord)) {
              throw cleanupFailure();
            }
          }
        }
        if (recordIdentity !== null) {
          await exactTags(recordIdentity.recordArn);
          lease = await renewCleanupLease(lease);
          await registryClient.send(new DeleteRegistryRecordCommand({
            registryId: recordIdentity.registryId,
            recordId: recordIdentity.recordId,
          }));
          await waitUntilAbsent(() =>
            getRecord(
              recordIdentity.registryId,
              recordIdentity.recordId,
            )
          );
        }

        if (cleanupDomain !== null && !domainRegistryChecked) {
          domainRegistry = await getRegistry(cleanupDomain.registryId);
          if (
            domainRegistry !== null
            && (
              domainRegistry.registryId !== cleanupDomain.registryId
              || domainRegistry.registryArn !== cleanupDomain.registryArn
              || domainRegistry.name !== `domain_${ownership.domainId}`
              || domainRegistry.description
                !== `${ownership.domainName} domain registry`
            )
          ) {
            throw cleanupFailure();
          }
        }
        if (domainRegistry !== null) {
          await exactTags(cleanupDomain.registryArn);
          lease = await renewCleanupLease(lease);
          await registryClient.send(new DeleteRegistryCommand({
            registryId: cleanupDomain.registryId,
          }));
          await waitUntilAbsent(
            () => getRegistry(cleanupDomain.registryId),
          );
        }
        if (domainItem !== null) {
          lease = await renewCleanupLease(lease);
          await dynamoClient.send(new DeleteItemCommand({
            TableName: platformStateTableName,
            Key: domainKey,
            ...exactItemCondition(domainItem),
          }));
        }

        if (requestKey !== null) {
          let requestFenced = false;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const currentRequest = await exactItem(requestKey);
            if (currentRequest === null) {
              requestFenced = true;
              break;
            }
            const request = expectedRequests[0];
            if (
              currentRequest.pk?.S !== requestKey.pk.S
              || currentRequest.sk?.S !== requestKey.sk.S
              || currentRequest.actor?.S !== actor
              || currentRequest.route?.S !== request.route
              || currentRequest.requestId?.S !== request.requestId
            ) {
              throw cleanupFailure();
            }
            lease = await renewCleanupLease(lease);
            try {
              await dynamoClient.send(new DeleteItemCommand({
                TableName: platformStateTableName,
                Key: requestKey,
                ...exactItemCondition(currentRequest),
              }));
              requestFenced = true;
              break;
            } catch (error) {
              if (!conditionalCheckFailed(error)) throw error;
            }
          }
          if (!requestFenced) throw cleanupFailure();

          const lateDomainItem = await exactItem(domainKey);
          if (lateDomainItem !== null) {
            const lateDomain = domainFromItem({
              accountId,
              actor,
              item: lateDomainItem,
              ownership,
              region,
            });
            if (
              cleanupDomain !== null
              && (
                lateDomain.registryId !== cleanupDomain.registryId
                || lateDomain.registryArn !== cleanupDomain.registryArn
                || lateDomain.createdBy !== cleanupDomain.createdBy
              )
            ) {
              throw cleanupFailure();
            }
            lease = await renewCleanupLease(lease);
            await dynamoClient.send(new DeleteItemCommand({
              TableName: platformStateTableName,
              Key: domainKey,
              ...exactItemCondition(lateDomainItem),
            }));
          }
        }
        if (mapping !== null) {
          lease = await renewCleanupLease(lease);
          await dynamoClient.send(new DeleteItemCommand({
            TableName: platformStateTableName,
            Key: mappingKey(ownership),
            ...exactItemCondition(mapping),
          }));
        }

        await releaseCleanupLease(lease);
        lease = null;
        return { ok: true };
      } catch {
        if (lease !== undefined && lease !== null) {
          try {
            await releaseCleanupLease(lease);
          } catch {
            // The exact lease owner must remain the only releaser.
          }
        }
        throw cleanupFailure();
      }
    },
  };
}
