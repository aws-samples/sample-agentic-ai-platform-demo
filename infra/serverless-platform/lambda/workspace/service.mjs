import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validateAgentBuildConfig } from "./state.mjs";
import { validateProjectResourcePolicy } from "../../../../console/public/project-resource-policy.mjs";

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const RESOURCE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]{0,12}:.{1,1024}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PAGE_SIZE = 50;
const STATE_PAGE_SIZE = 100;
const MAX_STATE_READS = 100;
const MAX_ITEM_AUTHORIZATIONS = 500;
const MAX_PROJECT_PAGES_PER_DOMAIN = 10;
const MAX_SCOPED_PROJECTS = 500;
const MAX_CURSOR_LENGTH = 4096;
const MAX_DOMAIN_SCOPES = 100;
const MAX_DOMAIN_ID_LENGTH = 64;
const PROJECT_WRITE_CONFLICT = Symbol("PROJECT_WRITE_CONFLICT");

const COLLECTION_ACTIONS = Object.freeze({
  projects: "workspace.projects.read",
  agents: "workspace.agents.read",
  deployments: "workspace.deployments.read",
  approvals: "workspace.approvals.read",
});

const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: {
    statusCode: 400,
    message: "The workspace request is invalid.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested operation is not allowed.",
    retryable: false,
  },
  NOT_FOUND: {
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  },
  CONFLICT: {
    statusCode: 409,
    message: "The resource state does not permit this operation.",
    retryable: false,
  },
  WORKSPACE_UNAVAILABLE: {
    statusCode: 503,
    message: "Workspace inventory is temporarily unavailable.",
    retryable: true,
  },
});

const PROJECT_KEYS = new Set([
  "domainId",
  "id",
  "name",
  "description",
  "ownerSubject",
  "memberSubjects",
  "status",
  "createdBySubject",
  "createdAt",
]);
const AGENT_KEYS = new Set([
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
]);
const DEPLOYMENT_KEYS = new Set([
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
]);
const APPROVAL_KEYS = new Set([
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
]);
const AGENT_STATUSES = new Set([
  "DRAFT",
  "READY_FOR_TEST",
  "TEST_FAILED",
  "TESTED",
  "SANDBOX_DEPLOYED",
  "PRODUCTION_PENDING",
  "PRODUCTION_APPROVED",
  "PRODUCTION_DEPLOYED",
  "REJECTED",
  "RETIRED",
]);
const DEPLOYMENT_STATUSES = new Set([
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "DEPLOYING",
  "DEPLOYED",
  "FAILED",
  "SUSPENDED",
  "CANCELLED",
  "RETIRED",
]);
const APPROVAL_STATUSES = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);
const APPROVAL_KINDS = new Set([
  "PRODUCTION_DEPLOYMENT",
  "RESOURCE_PUBLICATION",
  "RESOURCE_ACCESS",
]);
const RESOURCE_TYPES = new Set([
  "AGENT",
  "MODEL",
  "TOOL",
  "MCP_SERVER",
  "SKILL",
  "BLUEPRINT",
  "MEMORY",
  "KNOWLEDGE_BASE",
  "DEPLOYMENT",
]);

export class WorkspaceServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) throw new TypeError("Workspace error code is invalid.");
    super(detail.message);
    this.name = "WorkspaceServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.retryable;
  }
}

function fail(code) {
  throw new WorkspaceServiceError(code);
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expected.size
    && keys.every((key) => expected.has(key))
  );
}

function readOwnDataProperty(value, key, required = true) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) fail("INVALID_REQUEST");
    return { present: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) fail("INVALID_REQUEST");
  return { present: true, value: descriptor.value };
}

function snapshotDataArray(value, maximum) {
  if (!Array.isArray(value)) return null;
  const lengthProperty = readOwnDataProperty(value, "length");
  if (
    !Number.isSafeInteger(lengthProperty.value)
    || lengthProperty.value < 0
    || lengthProperty.value > maximum
  ) {
    return null;
  }
  const snapshot = [];
  for (let index = 0; index < lengthProperty.value; index += 1) {
    snapshot.push(readOwnDataProperty(value, String(index)).value);
  }
  return snapshot;
}

function nonEmptyString(value, maxLength = 4096) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validInstant(value) {
  return (
    nonEmptyString(value, 32)
    && ISO_INSTANT.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
  );
}

function validNullableString(value, maxLength = 4096) {
  return value === null || nonEmptyString(value, maxLength);
}

function validText(value, maxLength, { empty = false } = {}) {
  return (
    typeof value === "string"
    && value.length <= maxLength
    && (empty || value.length > 0)
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validInvocationOutput(value, maxLength) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function validDomainId(value) {
  return (
    typeof value === "string"
    && value.length <= MAX_DOMAIN_ID_LENGTH
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function validResourceIds(value) {
  return (
    Array.isArray(value)
    && value.length <= 20
    && value.every((resourceId) => RESOURCE_ID_PATTERN.test(resourceId))
    && new Set(value).size === value.length
  );
}

function validNullableNonNegativeInteger(value) {
  return value === null
    || (Number.isSafeInteger(value) && value >= 0);
}

function validateAbortSignal(value) {
  if (
    value === undefined
    || (
      value !== null
      && typeof value === "object"
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function"
    )
  ) {
    return value;
  }
  fail("INVALID_REQUEST");
}

function validateIdentity(identity) {
  const keys = new Set([
    "actor",
    "role",
    "activeDomain",
    "domainIds",
  ]);
  if (!hasExactKeys(identity, keys)) fail("INVALID_REQUEST");
  const actor = readOwnDataProperty(identity, "actor").value;
  const role = readOwnDataProperty(identity, "role").value;
  const activeDomain = readOwnDataProperty(identity, "activeDomain").value;
  const domainIds = snapshotDataArray(
    readOwnDataProperty(identity, "domainIds").value,
    MAX_DOMAIN_SCOPES,
  );
  if (
    !SUBJECT_PATTERN.test(actor)
    || !["admin", "lead", "builder", "user"].includes(role)
    || domainIds === null
    || domainIds.some((id) => !validDomainId(id))
    || new Set(domainIds).size !== domainIds.length
  ) {
    fail("INVALID_REQUEST");
  }

  if (role === "admin") {
    if (
      activeDomain !== null
      && !domainIds.includes(activeDomain)
    ) {
      fail("INVALID_REQUEST");
    }
  } else if (role === "lead" || role === "builder") {
    if (
      !validDomainId(activeDomain)
      || domainIds.length !== 1
      || domainIds[0] !== activeDomain
    ) {
      fail("INVALID_REQUEST");
    }
  } else if (
    activeDomain !== null
    || domainIds.length !== 0
  ) {
    fail("INVALID_REQUEST");
  }

  return {
    actor,
    role,
    activeDomain,
    domainIds,
  };
}

function validateRequest(input) {
  const allowed = new Set([
    "identity",
    "limit",
    "cursor",
    "abortSignal",
  ]);
  if (
    !isPlainObject(input)
    || Object.keys(input).some((key) => !allowed.has(key))
    || !Object.hasOwn(input, "identity")
  ) {
    fail("INVALID_REQUEST");
  }
  const identity = readOwnDataProperty(input, "identity").value;
  const limit = input.limit === undefined ? 20 : input.limit;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_PAGE_SIZE
  ) {
    fail("INVALID_REQUEST");
  }
  if (
    input.cursor !== undefined
    && (
      !nonEmptyString(input.cursor, MAX_CURSOR_LENGTH)
      || !/^[A-Za-z0-9_-]+$/.test(input.cursor)
    )
  ) {
    fail("INVALID_REQUEST");
  }
  return {
    identity: validateIdentity(identity),
    limit,
    cursor: input.cursor,
    abortSignal: validateAbortSignal(input.abortSignal),
  };
}

function validateCreateProjectRequest(input) {
  const allowed = new Set([
    "identity",
    "payload",
    "requestId",
    "abortSignal",
  ]);
  if (
    !isPlainObject(input)
    || Object.keys(input).some((key) => !allowed.has(key))
    || !Object.hasOwn(input, "identity")
    || !Object.hasOwn(input, "payload")
    || !Object.hasOwn(input, "requestId")
  ) {
    fail("INVALID_REQUEST");
  }
  const identity = validateIdentity(
    readOwnDataProperty(input, "identity").value,
  );
  const payload = readOwnDataProperty(input, "payload").value;
  if (
    !hasExactKeys(payload, new Set(["id", "name", "description",
      ...(Object.hasOwn(payload || {}, "resourcePolicy") ? ["resourcePolicy"] : [])]))
  ) {
    fail("INVALID_REQUEST");
  }
  const id = readOwnDataProperty(payload, "id").value;
  const name = readOwnDataProperty(payload, "name").value;
  const description = readOwnDataProperty(payload, "description").value;
  const requestId = readOwnDataProperty(input, "requestId").value;
  if (
    typeof id !== "string"
    || !SLUG_PATTERN.test(id)
    || !validText(name, 128)
    || !validText(description, 4096, { empty: true })
    || typeof requestId !== "string"
    || !REQUEST_ID_PATTERN.test(requestId)
  ) {
    fail("INVALID_REQUEST");
  }
  let resourcePolicy;
  if (Object.hasOwn(payload, "resourcePolicy")) {
    try { resourcePolicy = validateProjectResourcePolicy(payload.resourcePolicy); }
    catch { fail("INVALID_REQUEST"); }
  }
  return {
    identity,
    payload: { id, name, description, ...(resourcePolicy !== undefined ? { resourcePolicy } : {}) },
    requestId,
    abortSignal: validateAbortSignal(input.abortSignal),
  };
}

function validateRecordShape(record, keys) {
  if (!hasExactKeys(record, keys)) fail("WORKSPACE_UNAVAILABLE");
}

function validateCommonRecord(record) {
  if (
    !validDomainId(record.domainId)
    || !SLUG_PATTERN.test(record.id)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
}

function sanitizeProject(record) {
  validateRecordShape(record, new Set([...PROJECT_KEYS, ...(Object.hasOwn(record || {}, "resourcePolicy") ? ["resourcePolicy"] : [])]));
  try { validateProjectResourcePolicy(record.resourcePolicy ?? null); }
  catch { fail("WORKSPACE_UNAVAILABLE"); }
  validateCommonRecord(record);
  if (
    !validText(record.name, 128)
    || !validText(record.description, 4096, { empty: true })
    || !SUBJECT_PATTERN.test(record.ownerSubject)
    || !Array.isArray(record.memberSubjects)
    || record.memberSubjects.length > 100
    || record.memberSubjects.some((subject) =>
      !SUBJECT_PATTERN.test(subject))
    || new Set(record.memberSubjects).size !== record.memberSubjects.length
    || !["ACTIVE", "ARCHIVED"].includes(record.status)
    || !SUBJECT_PATTERN.test(record.createdBySubject)
    || !validInstant(record.createdAt)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return { ...record };
}

function validAgentBuildConfig(value) {
  if (value === null) return true;
  try {
    return isDeepStrictEqual(validateAgentBuildConfig(value), value);
  } catch {
    return false;
  }
}

function sanitizeAgent(record) {
  validateRecordShape(record, AGENT_KEYS);
  validateCommonRecord(record);
  const evidence = [
    record.lastTestStatus,
    record.lastTestedAt,
    record.lastTestedBySubject,
    record.lastTestModelId,
    record.lastTestInputTokens,
    record.lastTestOutputTokens,
    record.lastTestRequestId,
    record.lastTestEvidenceHash,
  ];
  const evidenceIsEmpty = evidence.every((value) => value === null);
  const evidenceIsComplete = evidence.every((value) => value !== null);
  const successfulTestStates = new Set([
    "TESTED",
    "SANDBOX_DEPLOYED",
    "PRODUCTION_PENDING",
    "PRODUCTION_APPROVED",
    "PRODUCTION_DEPLOYED",
    "REJECTED",
  ]);
  if (
    !SLUG_PATTERN.test(record.projectId)
    || !validText(record.name, 128)
    || !validText(record.description, 4096, { empty: true })
    || !SUBJECT_PATTERN.test(record.ownerSubject)
    || !RESOURCE_ID_PATTERN.test(record.modelId)
    || !validResourceIds(record.toolIds)
    || !validResourceIds(record.mcpServerIds)
    || !validResourceIds(record.skillIds)
    || !validResourceIds(record.blueprintIds)
    || !validResourceIds(record.memoryIds)
    || !validResourceIds(record.knowledgeBaseIds)
    || !validAgentBuildConfig(record.buildConfig)
    || !AGENT_STATUSES.has(record.status)
    || !SUBJECT_PATTERN.test(record.createdBySubject)
    || !validInstant(record.createdAt)
    || !validInstant(record.updatedAt)
    || Date.parse(record.createdAt) > Date.parse(record.updatedAt)
    || (
      record.lastTestStatus !== null
      && !["SUCCEEDED", "FAILED"].includes(record.lastTestStatus)
    )
    || (
      record.lastTestedAt !== null
      && !validInstant(record.lastTestedAt)
    )
    || (
      record.lastTestedBySubject !== null
      && !SUBJECT_PATTERN.test(record.lastTestedBySubject)
    )
    || (
      record.lastTestModelId !== null
      && !RESOURCE_ID_PATTERN.test(record.lastTestModelId)
    )
    || !validNullableNonNegativeInteger(record.lastTestInputTokens)
    || !validNullableNonNegativeInteger(record.lastTestOutputTokens)
    || (
      record.lastTestRequestId !== null
      && !REQUEST_ID_PATTERN.test(record.lastTestRequestId)
    )
    || (
      record.lastTestEvidenceHash !== null
      && !FINGERPRINT_PATTERN.test(record.lastTestEvidenceHash)
    )
    || (
      record.lastTestOutput !== null
      && !validInvocationOutput(record.lastTestOutput, 65_536)
    )
    || (!evidenceIsEmpty && !evidenceIsComplete)
    || (
      successfulTestStates.has(record.status)
      && (
        !evidenceIsComplete
        || record.lastTestStatus !== "SUCCEEDED"
        || record.lastTestOutput === null
      )
    )
    || (
      record.status === "TEST_FAILED"
      && (
        !evidenceIsComplete
        || record.lastTestStatus !== "FAILED"
        || record.lastTestOutput !== null
      )
    )
    || (
      !successfulTestStates.has(record.status)
      && record.status !== "TEST_FAILED"
      && (!evidenceIsEmpty || record.lastTestOutput !== null)
    )
    || (
      record.lastTestedAt !== null
      && (
        Date.parse(record.lastTestedAt) < Date.parse(record.createdAt)
        || Date.parse(record.lastTestedAt) > Date.parse(record.updatedAt)
      )
    )
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return { ...record };
}

function sanitizeDeployment(record) {
  validateRecordShape(record, DEPLOYMENT_KEYS);
  validateCommonRecord(record);
  if (
    !SLUG_PATTERN.test(record.projectId)
    || !SLUG_PATTERN.test(record.agentId)
    || !["SANDBOX", "PRODUCTION"].includes(record.environment)
    || !DEPLOYMENT_STATUSES.has(record.status)
    || !SUBJECT_PATTERN.test(record.requesterSubject)
    || (
      record.approverSubject !== null
      && !SUBJECT_PATTERN.test(record.approverSubject)
    )
    || !validNullableString(record.decisionReason, 1024)
    || !validInstant(record.requestedAt)
    || (
      record.decidedAt !== null
      && !validInstant(record.decidedAt)
    )
    || (
      record.runtimeArn !== null
      && !ARN_PATTERN.test(record.runtimeArn)
    )
    || (
      record.runtimeId !== null
      && !RESOURCE_ID_PATTERN.test(record.runtimeId)
    )
    || (
      record.runtimeStatus !== null
      && record.runtimeStatus !== "READY"
    )
    || (
      record.endpointName !== null
      && !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(record.endpointName)
    )
    || (
      record.endpointArn !== null
      && !ARN_PATTERN.test(record.endpointArn)
    )
    || (
      record.runtimeVersion !== null
      && !/^[1-9][0-9]{0,4}$/.test(record.runtimeVersion)
    )
    || !validInstant(record.updatedAt)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return { ...record };
}

function sanitizeApproval(record) {
  const bindingKeys = ["ownerSubject", "recordVersion", "initiationReason"];
  const hasBinding = record && bindingKeys.some(key => Object.hasOwn(record, key));
  validateRecordShape(record, hasBinding ? new Set([...APPROVAL_KEYS, ...bindingKeys]) : APPROVAL_KEYS);
  if (hasBinding && (record.kind !== "RESOURCE_PUBLICATION"
    || !SUBJECT_PATTERN.test(record.ownerSubject)
    || typeof record.recordVersion !== "string" || !record.recordVersion.trim()
    || !validNullableString(record.initiationReason, 2000) || !record.initiationReason?.trim())) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  validateCommonRecord(record);
  if (
    !APPROVAL_KINDS.has(record.kind)
    || !RESOURCE_TYPES.has(record.resourceType)
    || !RESOURCE_ID_PATTERN.test(record.resourceId)
    || (
      record.projectId !== null
      && !SLUG_PATTERN.test(record.projectId)
    )
    || !APPROVAL_STATUSES.has(record.status)
    || !SUBJECT_PATTERN.test(record.requesterSubject)
    || (
      record.approverSubject !== null
      && !SUBJECT_PATTERN.test(record.approverSubject)
    )
    || !validNullableString(record.reason, 1024)
    || !validInstant(record.requestedAt)
    || (
      record.decidedAt !== null
      && !validInstant(record.decidedAt)
    )
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return { ...record };
}

function expectedPartition(route, target) {
  if (route === "projects") return `PROJECT#${target.domainId}`;
  if (route === "agents") {
    return `AGENT#${target.domainId}#${target.projectId}`;
  }
  if (route === "deployments") {
    return `DEPLOYMENT#${target.domainId}#${target.projectId}`;
  }
  return `APPROVAL#${target.domainId}`;
}

function expectedSortKeyPrefix(route) {
  if (route === "projects") return "PROJECT#";
  if (route === "agents") return "AGENT#";
  if (route === "deployments") return "DEPLOYMENT#";
  return "APPROVAL#";
}

function validateStateCursor(cursor, partitionKey, sortKeyPrefix) {
  if (cursor === null) return null;
  if (
    !hasExactKeys(cursor, new Set(["pk", "sk"]))
    || cursor.pk !== partitionKey
    || !nonEmptyString(cursor.sk, 1024)
    || !cursor.sk.startsWith(sortKeyPrefix)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return { pk: cursor.pk, sk: cursor.sk };
}

function validateStatePage(
  page,
  partitionKey,
  sortKeyPrefix,
  sanitizer,
  limit,
) {
  if (
    !hasExactKeys(page, new Set(["items", "cursor"]))
    || !Array.isArray(page.items)
    || page.items.length > limit
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return {
    items: page.items.map(sanitizer),
    cursor: validateStateCursor(
      page.cursor,
      partitionKey,
      sortKeyPrefix,
    ),
  };
}

function encodeCursor(route, index, cursor) {
  return Buffer.from(JSON.stringify({
    v: 1,
    r: route,
    i: index,
    c: cursor,
  })).toString("base64url");
}

function decodeCursor(value, route) {
  if (value === undefined) return { index: 0, cursor: null };
  let parsed;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) fail("NOT_FOUND");
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch (error) {
    if (error instanceof WorkspaceServiceError) throw error;
    fail("NOT_FOUND");
  }
  if (
    !hasExactKeys(parsed, new Set(["v", "r", "i", "c"]))
    || parsed.v !== 1
    || parsed.r !== route
    || !Number.isSafeInteger(parsed.i)
    || parsed.i < 0
    || (
      parsed.c !== null
      && (
        !hasExactKeys(parsed.c, new Set(["pk", "sk"]))
        || !nonEmptyString(parsed.c.pk, 1024)
        || !nonEmptyString(parsed.c.sk, 1024)
      )
    )
  ) {
    fail("NOT_FOUND");
  }
  return {
    index: parsed.i,
    cursor: parsed.c,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Workspace request was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

function waitForAbortablePromise(promise, abortSignal) {
  if (!abortSignal) return Promise.resolve(promise);
  throwIfAborted(abortSignal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      const error = new Error("Workspace request was aborted.");
      error.name = "AbortError";
      reject(error);
    };
    const cleanup = () => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function collectionResourceRef(route, identity) {
  const descriptor = Buffer.from(JSON.stringify({
    v: 1,
    route,
    subject: identity.actor,
    role: identity.role,
    activeDomain: identity.activeDomain,
    domainIds: identity.domainIds,
  })).toString("base64url");
  return `workspace-collection:${route}:${descriptor}`;
}

function projectCreateResourceRef(identity, domainId, projectId) {
  const descriptor = Buffer.from(JSON.stringify({
    v: 1,
    route: "projects",
    domainId,
    projectId,
    subject: identity.actor,
  })).toString("base64url");
  return `workspace-domain:projects:${descriptor}`;
}

function itemResourceRef(route, descriptor) {
  const encoded = Buffer.from(
    JSON.stringify({ v: 1, route, ...descriptor }),
  ).toString("base64url");
  return `workspace-item:${route}:${encoded}`;
}

function uniqueSubjects(...subjects) {
  return [...new Set(subjects.flat())];
}

function projectItemDescriptor(record) {
  return {
    id: record.id,
    domainId: record.domainId,
    projectId: record.id,
    ownerId: record.ownerSubject,
    assigneeIds: [...record.memberSubjects],
    lifecycleState: record.status,
  };
}

function projectTarget(project) {
  return {
    domainId: project.domainId,
    projectId: project.id,
    projectAssigneeIds: uniqueSubjects(
      project.ownerSubject,
      project.memberSubjects,
    ),
  };
}

function agentItemDescriptor(record, target) {
  return {
    id: record.id,
    domainId: record.domainId,
    projectId: record.projectId,
    ownerId: record.ownerSubject,
    assigneeIds: [...target.projectAssigneeIds],
    lifecycleState: record.status,
  };
}

function deploymentItemDescriptor(record, target) {
  return {
    id: record.id,
    domainId: record.domainId,
    projectId: record.projectId,
    ownerId: record.requesterSubject,
    assigneeIds: [...target.projectAssigneeIds],
    lifecycleState: record.status,
  };
}

function approvalItemDescriptor(record, projectByIdentity) {
  const project = record.projectId === null
    ? null
    : projectByIdentity.get(`${record.domainId}/${record.projectId}`) ?? null;
  return {
    id: record.id,
    domainId: record.domainId,
    projectId: record.projectId ?? "domain-requests",
    ownerId: record.requesterSubject,
    assigneeIds: project === null
      ? []
      : uniqueSubjects(project.ownerSubject, project.memberSubjects),
    lifecycleState: record.status,
  };
}

function authorizationRequestContext(identity, abortSignal) {
  return Object.freeze({
    source: "workspace-api",
    subject: identity.actor,
    role: identity.role,
    activeDomain: identity.activeDomain,
    domainIds: Object.freeze([...identity.domainIds]),
    abortSignal,
  });
}

async function authorizeProjectCreate(
  authorizer,
  identity,
  domainId,
  projectId,
  abortSignal,
) {
  let decision;
  try {
    decision = await waitForAbortablePromise(
      authorizer({
        requestContext: authorizationRequestContext(
          identity,
          abortSignal,
        ),
        action: "project:create",
        resourceRef: projectCreateResourceRef(
          identity,
          domainId,
          projectId,
        ),
      }),
      abortSignal,
    );
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error?.decision === "NOT_FOUND" || error?.code === "NOT_FOUND") {
      fail("NOT_FOUND");
    }
    if (error?.decision === "CONFLICT" || error?.code === "CONFLICT") {
      fail("CONFLICT");
    }
    fail("FORBIDDEN");
  }
  if (decision !== true && decision?.ok !== true) fail("FORBIDDEN");
}

async function authorizeCollectionRead(
  authorizer,
  route,
  identity,
  abortSignal,
) {
  let decision;
  try {
    decision = await waitForAbortablePromise(
      authorizer({
        requestContext: authorizationRequestContext(
          identity,
          abortSignal,
        ),
        action: COLLECTION_ACTIONS[route],
        resourceRef: collectionResourceRef(route, identity),
      }),
      abortSignal,
    );
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error?.decision === "NOT_FOUND" || error?.code === "NOT_FOUND") {
      fail("NOT_FOUND");
    }
    fail("FORBIDDEN");
  }
  if (decision !== true && decision?.ok !== true) fail("FORBIDDEN");
}

async function authorizeItemRead(
  authorizer,
  route,
  identity,
  descriptor,
  abortSignal,
) {
  try {
    const decision = await waitForAbortablePromise(
      authorizer({
        requestContext: authorizationRequestContext(
          identity,
          abortSignal,
        ),
        action: COLLECTION_ACTIONS[route],
        resourceRef: itemResourceRef(route, descriptor),
      }),
      abortSignal,
    );
    return decision === true || decision?.ok === true;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (
      ["NOT_FOUND", "FORBIDDEN", "CONFLICT"].includes(
        error?.decision ?? error?.code,
      )
    ) {
      return false;
    }
    fail("WORKSPACE_UNAVAILABLE");
  }
}

async function aggregate({
  route,
  targets,
  request,
  read,
  sanitizer,
  include = () => true,
  authorizer,
  itemDescriptor,
}) {
  const position = decodeCursor(request.cursor, route);
  if (
    position.index > targets.length
    || (
      position.index === targets.length
      && (position.cursor !== null || targets.length > 0)
    )
  ) {
    fail("NOT_FOUND");
  }
  if (targets.length === 0) {
    if (request.cursor !== undefined) fail("NOT_FOUND");
    return { items: [], cursor: null };
  }

  let index = position.index;
  let stateCursor = position.cursor;
  let reads = 0;
  let itemAuthorizations = 0;
  const seenCursors = new Set();
  const items = [];

  while (index < targets.length && items.length < request.limit) {
    throwIfAborted(request.abortSignal);
    if (reads >= MAX_STATE_READS) fail("WORKSPACE_UNAVAILABLE");

    const target = targets[index];
    const partitionKey = expectedPartition(route, target);
    const sortKeyPrefix = expectedSortKeyPrefix(route);
    if (
      stateCursor !== null
      && (
        stateCursor.pk !== partitionKey
        || !stateCursor.sk.startsWith(sortKeyPrefix)
      )
    ) {
      fail("NOT_FOUND");
    }
    const remaining = request.limit - items.length;
    const page = validateStatePage(
      await read(target, {
        limit: remaining,
        cursor: stateCursor,
        abortSignal: request.abortSignal,
      }),
      partitionKey,
      sortKeyPrefix,
      sanitizer,
      remaining,
    );
    reads += 1;

    for (const item of page.items) {
      if (
        item.domainId !== target.domainId
        || (
          Object.hasOwn(target, "projectId")
          && item.projectId !== target.projectId
        )
      ) {
        fail("WORKSPACE_UNAVAILABLE");
      }
      if (!include(item, target)) continue;
      if (itemAuthorizations >= MAX_ITEM_AUTHORIZATIONS) {
        fail("WORKSPACE_UNAVAILABLE");
      }
      itemAuthorizations += 1;
      if (
        await authorizeItemRead(
          authorizer,
          route,
          request.identity,
          itemDescriptor(item, target),
          request.abortSignal,
        )
      ) {
        items.push(item);
      }
    }

    if (page.cursor !== null) {
      const cursorKey = `${index}\n${page.cursor.pk}\n${page.cursor.sk}`;
      if (seenCursors.has(cursorKey)) fail("WORKSPACE_UNAVAILABLE");
      seenCursors.add(cursorKey);
      if (items.length >= request.limit) {
        return {
          items,
          cursor: encodeCursor(route, index, page.cursor),
        };
      }
      stateCursor = page.cursor;
      continue;
    }

    index += 1;
    stateCursor = null;
  }

  return {
    items,
    cursor: index < targets.length
      ? encodeCursor(route, index, null)
      : null,
  };
}

async function collectVisibleProjects(state, identity, abortSignal) {
  const projects = [];
  const identities = new Set();
  for (const domainId of identity.domainIds) {
    let cursor;
    for (let pageNumber = 0; ; pageNumber += 1) {
      throwIfAborted(abortSignal);
      if (pageNumber >= MAX_PROJECT_PAGES_PER_DOMAIN) {
        fail("WORKSPACE_UNAVAILABLE");
      }
      const partitionKey = `PROJECT#${domainId}`;
      const page = validateStatePage(
        await state.listProjects({
          domainId,
          limit: STATE_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          ...(abortSignal ? { abortSignal } : {}),
        }),
        partitionKey,
        "PROJECT#",
        sanitizeProject,
        STATE_PAGE_SIZE,
      );
      for (const project of page.items) {
        if (project.domainId !== domainId) fail("WORKSPACE_UNAVAILABLE");
        if (
          identity.role === "builder"
          && project.ownerSubject !== identity.actor
          && !project.memberSubjects.includes(identity.actor)
        ) {
          continue;
        }
        const key = `${project.domainId}/${project.id}`;
        if (identities.has(key)) fail("WORKSPACE_UNAVAILABLE");
        identities.add(key);
        projects.push(project);
        if (projects.length > MAX_SCOPED_PROJECTS) {
          fail("WORKSPACE_UNAVAILABLE");
        }
      }
      if (page.cursor === null) break;
      cursor = page.cursor;
    }
  }
  return projects;
}

function beginTransaction(state) {
  let transaction;
  try {
    transaction = state.beginTransaction();
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  const timestampEpoch = typeof transaction?.timestamp === "string"
    ? Date.parse(transaction.timestamp)
    : Number.NaN;
  if (
    !isPlainObject(transaction)
    || Object.keys(transaction).sort().join(",")
      !== "epochSeconds,timestamp"
    || !validInstant(transaction.timestamp)
    || !Number.isSafeInteger(transaction.epochSeconds)
    || transaction.epochSeconds !== Math.floor(timestampEpoch / 1000)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return transaction;
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

function projectCreateMutation({
  identity,
  domainId,
  projectId,
  requestId,
  payloadFingerprint,
  timestamp,
}) {
  return {
    actor: identity.actor,
    requesterSubject: identity.actor,
    effectiveRole: identity.role,
    domainId,
    projectId,
    route: "POST /api/projects",
    requestId,
    payloadFingerprint,
    result: {
      entityType: "PROJECT",
      resourceKey: `project/${domainId}/${projectId}`,
      operation: "CREATE",
      status: "SUCCEEDED",
    },
    decision: "create",
    reason: "Authorized project creation.",
    timestamp,
    createdAt: timestamp,
  };
}

function mutationMatchesProjectCreate(stored, expected) {
  return (
    isPlainObject(stored)
    && isPlainObject(stored.result)
    && stored.actor === expected.identity.actor
    && stored.requesterSubject === expected.identity.actor
    && stored.effectiveRole === expected.identity.role
    && stored.domainId === expected.domainId
    && stored.projectId === expected.projectId
    && stored.route === "POST /api/projects"
    && stored.requestId === expected.requestId
    && stored.payloadFingerprint === expected.payloadFingerprint
    && stored.result.entityType === "PROJECT"
    && stored.result.resourceKey
      === `project/${expected.domainId}/${expected.projectId}`
    && stored.result.operation === "CREATE"
    && stored.result.status === "SUCCEEDED"
    && stored.decision === "create"
    && stored.reason === "Authorized project creation."
    && validInstant(stored.timestamp)
    && stored.createdAt === stored.timestamp
  );
}

async function readMutationResult(state, request) {
  try {
    return await state.getMutationResult({
      actor: request.identity.actor,
      route: "POST /api/projects",
      requestId: request.requestId,
      ...(request.abortSignal
        ? { abortSignal: request.abortSignal }
        : {}),
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
}

async function readProject(state, domainId, projectId, abortSignal) {
  try {
    return await state.getProject({
      domainId,
      projectId,
      ...(abortSignal ? { abortSignal } : {}),
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
}

async function replayProjectCreate(state, request, expected) {
  const stored = await readMutationResult(state, request);
  if (stored === null) return null;
  if (!mutationMatchesProjectCreate(stored, expected)) fail("CONFLICT");
  const record = sanitizeProject(
    await readProject(
      state,
      expected.domainId,
      expected.projectId,
      request.abortSignal,
    ),
  );
  const expectedRecord = {
    domainId: expected.domainId,
    id: expected.projectId,
    name: request.payload.name,
    description: request.payload.description,
    ownerSubject: request.identity.actor,
    memberSubjects: [],
    status: "ACTIVE",
    createdBySubject: request.identity.actor,
    createdAt: stored.timestamp,
  };
  if (!isDeepStrictEqual(record, expectedRecord)) fail("CONFLICT");
  return record;
}

async function persistProject(state, input) {
  try {
    return await state.putProject(input);
  } catch (error) {
    if (error?.code === "MUTATION_CONFLICT") {
      return PROJECT_WRITE_CONFLICT;
    }
    if (error instanceof WorkspaceServiceError) throw error;
    fail("WORKSPACE_UNAVAILABLE");
  }
}

export function createWorkspaceService({ workspaceState, authorizer, projectResourceValidator } = {}) {
  const requiredMethods = [
    "listProjects",
    "listAgents",
    "listDeployments",
    "listApprovals",
  ];
  if (
    !workspaceState
    || requiredMethods.some(
      (method) => typeof workspaceState[method] !== "function",
    )
  ) {
    throw new TypeError("Workspace state configuration is invalid.");
  }
  if (typeof authorizer !== "function") {
    throw new TypeError("Workspace authorizer is invalid.");
  }

  async function prepare(input, route) {
    const request = validateRequest(input);
    if (request.identity.role === "user") fail("FORBIDDEN");
    await authorizeCollectionRead(
      authorizer,
      route,
      request.identity,
      request.abortSignal,
    );
    return request;
  }

  async function prepareProjectCreate(input, { validateResources = true } = {}) {
    const request = validateCreateProjectRequest(input);
    const domainId =
      request.identity.role === "lead"
      || request.identity.role === "builder"
        ? request.identity.activeDomain
        : "platform";
    await authorizeProjectCreate(
      authorizer,
      request.identity,
      domainId,
      request.payload.id,
      request.abortSignal,
    );
    if (
      request.identity.role !== "lead"
      && request.identity.role !== "admin"
    ) {
      fail("FORBIDDEN");
    }
    if (!request.identity.domainIds.includes(domainId)) fail("FORBIDDEN");
    if (validateResources && projectResourceValidator) {
      let allowed;
      try {
        allowed = await projectResourceValidator({ domainId,
          resourcePolicy: request.payload.resourcePolicy ?? null, abortSignal: request.abortSignal });
      } catch { fail("WORKSPACE_UNAVAILABLE"); }
      if (!allowed) fail("FORBIDDEN");
    } else if (validateResources && request.payload.resourcePolicy != null) {
      // An explicit subset cannot be trusted without an authoritative parent.
      fail("WORKSPACE_UNAVAILABLE");
    }
    const payloadFingerprint = fingerprint(request.payload);
    return {
      request,
      domainId,
      payloadFingerprint,
      expected: {
        identity: request.identity,
        domainId,
        projectId: request.payload.id,
        requestId: request.requestId,
        payloadFingerprint,
      },
    };
  }

  return {
    async preauthorizeProjectCreate(input) {
      // Preflight checks identity and scope; the actual create revalidates
      // the catalog after effective domain authorization, before any write.
      await prepareProjectCreate(input, { validateResources: false });
      return true;
    },

    async createProject(input) {
      const {
        request,
        domainId,
        payloadFingerprint,
        expected,
      } = await prepareProjectCreate(input);
      const replay = await replayProjectCreate(
        workspaceState,
        request,
        expected,
      );
      if (replay !== null) return replay;
      const existing = await readProject(
        workspaceState,
        domainId,
        request.payload.id,
        request.abortSignal,
      );
      if (existing !== null) {
        const sanitized = sanitizeProject(existing);
        if (
          sanitized.domainId !== domainId
          || sanitized.id !== request.payload.id
        ) {
          fail("WORKSPACE_UNAVAILABLE");
        }
        fail("CONFLICT");
      }
      const transaction = beginTransaction(workspaceState);
      const record = {
        domainId,
        ...request.payload,
        ownerSubject: request.identity.actor,
        memberSubjects: [],
        status: "ACTIVE",
        createdBySubject: request.identity.actor,
        createdAt: transaction.timestamp,
      };
      const persisted = await persistProject(workspaceState, {
        record,
        expectedStatus: null,
        mutation: projectCreateMutation({
          identity: request.identity,
          domainId,
          projectId: request.payload.id,
          requestId: request.requestId,
          payloadFingerprint,
          timestamp: transaction.timestamp,
        }),
        transaction,
      });
      if (persisted !== PROJECT_WRITE_CONFLICT) return persisted;
      const concurrentReplay = await replayProjectCreate(
        workspaceState,
        request,
        expected,
      );
      if (concurrentReplay === null) fail("CONFLICT");
      return concurrentReplay;
    },

    async listProjects(input) {
      const request = await prepare(input, "projects");
      return aggregate({
        route: "projects",
        targets: request.identity.domainIds.map((domainId) => ({
          domainId,
        })),
        request,
        sanitizer: sanitizeProject,
        authorizer,
        itemDescriptor: projectItemDescriptor,
        include: request.identity.role === "builder"
          ? (record) =>
              record.ownerSubject === request.identity.actor
              || record.memberSubjects.includes(request.identity.actor)
          : undefined,
        read: ({ domainId }, options) =>
          workspaceState.listProjects({
            domainId,
            limit: options.limit,
            ...(options.cursor ? { cursor: options.cursor } : {}),
            ...(options.abortSignal
              ? { abortSignal: options.abortSignal }
              : {}),
          }),
      });
    },

    async listAgents(input) {
      const request = await prepare(input, "agents");
      const projects = await collectVisibleProjects(
        workspaceState,
        request.identity,
        request.abortSignal,
      );
      return aggregate({
        route: "agents",
        targets: projects.map(projectTarget),
        request,
        sanitizer: sanitizeAgent,
        authorizer,
        itemDescriptor: agentItemDescriptor,
        read: ({ domainId, projectId }, options) =>
          workspaceState.listAgents({
            domainId,
            projectId,
            limit: options.limit,
            ...(options.cursor ? { cursor: options.cursor } : {}),
            ...(options.abortSignal
              ? { abortSignal: options.abortSignal }
              : {}),
          }),
      });
    },

    async listDeployments(input) {
      const request = await prepare(input, "deployments");
      const projects = await collectVisibleProjects(
        workspaceState,
        request.identity,
        request.abortSignal,
      );
      return aggregate({
        route: "deployments",
        targets: projects.map(projectTarget),
        request,
        sanitizer: sanitizeDeployment,
        authorizer,
        itemDescriptor: deploymentItemDescriptor,
        read: ({ domainId, projectId }, options) =>
          workspaceState.listDeployments({
            domainId,
            projectId,
            limit: options.limit,
            ...(options.cursor ? { cursor: options.cursor } : {}),
            ...(options.abortSignal
              ? { abortSignal: options.abortSignal }
              : {}),
          }),
      });
    },

    async listApprovals(input) {
      const request = await prepare(input, "approvals");
      const visibleProjects = request.identity.role === "builder"
        ? await collectVisibleProjects(
            workspaceState,
            request.identity,
            request.abortSignal,
          )
        : [];
      const projectByIdentity = new Map(
        visibleProjects.map((project) => [
          `${project.domainId}/${project.id}`,
          project,
        ]),
      );
      // Shared-catalog publication approvals persist under APPROVAL#shared —
      // a virtual partition with no DOMAIN record, so it is never in
      // identity.domainIds. Admins review the shared catalog, so their queue
      // must include it; other roles keep their exact domain scope.
      const approvalDomainIds = request.identity.role === "admin"
        && !request.identity.domainIds.includes("shared")
        ? [...request.identity.domainIds, "shared"]
        : request.identity.domainIds;
      return aggregate({
        route: "approvals",
        targets: approvalDomainIds.map((domainId) => ({
          domainId,
        })),
        request,
        sanitizer: sanitizeApproval,
        authorizer,
        itemDescriptor: (record) =>
          approvalItemDescriptor(record, projectByIdentity),
        include: request.identity.role === "builder"
          ? (record) =>
              record.requesterSubject === request.identity.actor
              || (
                record.projectId !== null
                && projectByIdentity.has(
                  `${record.domainId}/${record.projectId}`,
                )
              )
          : undefined,
        read: ({ domainId }, options) =>
          workspaceState.listApprovals({
            domainId,
            limit: options.limit,
            ...(options.cursor ? { cursor: options.cursor } : {}),
            ...(options.abortSignal
              ? { abortSignal: options.abortSignal }
              : {}),
          }),
      });
    },
  };
}
