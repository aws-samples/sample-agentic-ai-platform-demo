import { createHash } from "node:crypto";
import { validAccounting } from "../agent-runtime/usage.mjs";
import { validInvocationLifecycle } from "./invocation-store.mjs";

const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PUBLIC_AGENT_ID_PATTERN = /^agent-[a-f0-9]{32}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const COGNITO_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_GROUP_PATTERN = /^domain-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const SESSION_ID_PATTERN =
  /^session-[a-f0-9]{16}-[a-f0-9]{16}$/;
const RESULT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[A-Za-z0-9-]+:[0-9]{12}:.+$/;
const MAX_PROMPT_LENGTH = 16_384;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_AUTHENTICATED_GROUPS = 32;
const MAX_ENTITLEMENT_RECORDS = 100;
const MAX_CATALOG_DOMAINS = 100;
const MAX_CATALOG_PROJECTS = 100;
const MAX_CATALOG_AGENTS = 100;
const ENTITLEMENT_SUBJECT_TYPES = new Set(["USER", "GROUP", "DOMAIN"]);
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
const EXPERIENCE_ROUTE = "POST /api/experience/invocations";
const EXPERIENCE_CLAIM_ROUTE =
  "POST /api/experience/invocations/claim";
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const INVOCATION_REPLAY_OUTCOMES = Object.freeze({
  "Governed invocation completed with SUCCEEDED.": "SUCCEEDED",
  "Governed invocation completed with FAILED.": "FAILED",
});
const STATE_METHODS = Object.freeze([
  "beginTransaction",
  "listEntitlements",
  "listProjects",
  "listAgents",
  "getEntitlement",
  "getAgent",
  "listDeployments",
  "getSession",
  "listSessions",
  "listAccessRequests",
  "getMutationResult",
  "claimMutation",
  "putApproval",
  "putSession",
]);
const INVOCATION_STORE_METHODS = Object.freeze([
  "get",
  "start",
  "complete",
]);

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The experience request is invalid.",
    retryable: false,
  }),
  FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "The requested experience action is not allowed.",
    retryable: false,
  }),
  NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  }),
  CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The request conflicts with the current experience state.",
    retryable: true,
  }),
  INVOCATION_OUTCOME_UNKNOWN: Object.freeze({
    statusCode: 409,
    message:
      "The invocation outcome is indeterminate. Do not submit it again "
      + "with a new request ID.",
    retryable: false,
  }),
  RUNTIME_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "The governed agent Runtime is temporarily unavailable.",
    retryable: true,
  }),
  SUBMISSION_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "The end-user submission service is temporarily unavailable.",
    retryable: true,
  }),
  EXPERIENCE_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "The end-user experience is temporarily unavailable.",
    retryable: true,
  }),
});

export class ExperienceServiceError extends Error {
  constructor(code) {
    const definition = ERROR_DEFINITIONS[code];
    if (!definition) {
      throw new TypeError("Experience service error code is invalid.");
    }
    super(definition.message);
    this.name = "ExperienceServiceError";
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
  }
}

function fail(code) {
  throw new ExperienceServiceError(code);
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(value, key) {
  if (!isPlainObject(value)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  ) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

function strictValues(value, allowedKeys, requiredKeys) {
  if (!isPlainObject(value)) fail("INVALID_REQUEST");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
    || keys.some((key) => (
      !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
    || requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    fail("INVALID_REQUEST");
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  );
}

function validText(
  value,
  maxLength,
  { minimum = 1, allowNewlines = true } = {},
) {
  const controls = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  return (
    typeof value === "string"
    && value.length >= minimum
    && value.length <= maxLength
    && (
      minimum === 0
        ? value.length === 0 || value.trim().length > 0
        : value.trim().length >= minimum
    )
    && !controls.test(value)
  );
}

function snapshotStrings(value, maximum, pattern) {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    length === undefined
    || !Object.hasOwn(length, "value")
    || !Number.isSafeInteger(length.value)
    || length.value < 0
    || length.value > maximum
  ) {
    return null;
  }
  const values = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
      || !pattern.test(descriptor.value)
    ) {
      return null;
    }
    values.push(descriptor.value);
  }
  return new Set(values).size === values.length ? values : null;
}

function authenticatedDomainsForGroups(groups) {
  const domains = [];
  for (const group of groups) {
    const match = DOMAIN_GROUP_PATTERN.exec(group);
    if (!match) continue;
    const domainId = match[1].replaceAll("-", "_");
    if (
      !DOMAIN_ID_PATTERN.test(domainId)
      || RESERVED_DOMAIN_IDS.has(domainId)
      || domains.includes(domainId)
    ) {
      continue;
    }
    domains.push(domainId);
  }
  return domains;
}

function validateIdentity(input) {
  const values = strictValues(
    input,
    new Set([
      "actor",
      "role",
      "activeDomain",
      "domainIds",
      "authenticatedGroups",
      "authenticatedDomains",
    ]),
    [
      "actor",
      "role",
      "activeDomain",
      "domainIds",
      "authenticatedGroups",
      "authenticatedDomains",
    ],
  );
  const authenticatedGroups = snapshotStrings(
    values.authenticatedGroups,
    MAX_AUTHENTICATED_GROUPS,
    COGNITO_GROUP_PATTERN,
  );
  const authenticatedDomains = snapshotStrings(
    values.authenticatedDomains,
    MAX_AUTHENTICATED_GROUPS,
    DOMAIN_ID_PATTERN,
  );
  const expectedDomains = authenticatedGroups === null
    ? null
    : authenticatedDomainsForGroups(authenticatedGroups);
  if (
    !SUBJECT_PATTERN.test(values.actor)
    || values.role !== "user"
    || values.activeDomain !== null
    || !Array.isArray(values.domainIds)
    || Reflect.ownKeys(values.domainIds).some(
      (key) => key !== "length",
    )
    || values.domainIds.length !== 0
    || authenticatedGroups === null
    || authenticatedDomains === null
    || authenticatedDomains.some(
      (domainId) => !expectedDomains.includes(domainId),
    )
  ) {
    if (values.role !== "user") fail("FORBIDDEN");
    fail("INVALID_REQUEST");
  }
  return Object.freeze({
    actor: values.actor,
    role: "user",
    activeDomain: null,
    domainIds: Object.freeze([]),
    authenticatedGroups: Object.freeze(authenticatedGroups),
    authenticatedDomains: Object.freeze(authenticatedDomains),
  });
}

function entitlementSubjects(identity) {
  return Object.freeze([
    Object.freeze({
      subjectType: "USER",
      subject: identity.actor,
    }),
    ...identity.authenticatedGroups.map((subject) => Object.freeze({
      subjectType: "GROUP",
      subject,
    })),
    ...identity.authenticatedDomains.map((subject) => Object.freeze({
      subjectType: "DOMAIN",
      subject,
    })),
  ]);
}

function entitlementReadInput(subject, ref, { list = false } = {}) {
  return {
    ...(subject.subjectType === "USER"
      ? {}
      : { subjectType: subject.subjectType }),
    subject: subject.subject,
    ...(list
      ? { limit: 100 }
      : {
          domainId: ref.domainId,
          projectId: ref.projectId,
          agentId: ref.agentId,
        }),
  };
}

function numericClock(clock) {
  let value;
  try {
    value = clock();
  } catch {
    fail("EXPERIENCE_UNAVAILABLE");
  }
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) fail("EXPERIENCE_UNAVAILABLE");
  return timestamp;
}

function validateRequestId(value) {
  if (
    typeof value !== "string"
    || !REQUEST_ID_PATTERN.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function publicAgentId(ref) {
  return `agent-${
    createHash("sha256")
      .update(`${ref.domainId}\0${ref.projectId}\0${ref.agentId}`)
      .digest("hex")
      .slice(0, 32)
  }`;
}

function accessRequestProjection(value, actor) {
  const values = strictValues(
    value,
    new Set([
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
    ]),
    [
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
    ],
  );
  if (
    !DOMAIN_ID_PATTERN.test(values.domainId)
    || !SLUG_PATTERN.test(values.projectId)
    || !SLUG_PATTERN.test(values.resourceId)
    || !RESULT_ID_PATTERN.test(values.id)
    || values.kind !== "RESOURCE_ACCESS"
    || values.resourceType !== "AGENT"
    || !new Set([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "CANCELLED",
    ]).has(values.status)
    || values.requesterSubject !== actor
    || !validText(values.reason, 1024, { minimum: 0 })
    || !Number.isFinite(Date.parse(values.requestedAt))
    || !(
      values.decidedAt === null
      || Number.isFinite(Date.parse(values.decidedAt))
    )
  ) {
    fail("EXPERIENCE_UNAVAILABLE");
  }
  return {
    id: values.id,
    domainId: values.domainId,
    agentId: publicAgentId({
      domainId: values.domainId,
      projectId: values.projectId,
      agentId: values.resourceId,
    }),
    status: values.status,
    reason: values.reason,
    requestedAt: values.requestedAt,
    decidedAt: values.decidedAt,
  };
}

function actorSessionPrefix(actor) {
  return `session-${
    createHash("sha256").update(actor).digest("hex").slice(0, 16)
  }`;
}

function generatedSessionId(actor, requestId) {
  return `${actorSessionPrefix(actor)}-${
    createHash("sha256")
      .update(`${actor}\0${requestId}`)
      .digest("hex")
      .slice(0, 16)
  }`;
}

function validateSessionId(value, actor) {
  if (
    typeof value !== "string"
    || !SESSION_ID_PATTERN.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
  if (!value.startsWith(`${actorSessionPrefix(actor)}-`)) {
    fail("NOT_FOUND");
  }
  return value;
}

function strictDecision(value) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "ok") return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "ok");
  return Boolean(
    descriptor
    && Object.hasOwn(descriptor, "value")
    && descriptor.enumerable === true
    && descriptor.value === true,
  );
}

function page(value) {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2
    || !keys.includes("items")
    || !keys.includes("cursor")
  ) {
    return null;
  }
  const items = ownDataValue(value, "items");
  const cursor = ownDataValue(value, "cursor");
  if (
    !items.present
    || !Array.isArray(items.value)
    || items.value.length > 100
    || !cursor.present
    || cursor.value !== null
  ) {
    return null;
  }
  const values = [];
  for (let index = 0; index < items.value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      items.value,
      String(index),
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
    values.push(descriptor.value);
  }
  return values;
}

function authoritativeString(value, key, pattern) {
  const property = ownDataValue(value, key);
  return (
    property.present
    && typeof property.value === "string"
    && pattern.test(property.value)
  )
    ? property.value
    : null;
}

function storedValues(value, expectedKeys) {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size
    || keys.some((key) =>
      typeof key !== "string" || !expectedKeys.has(key))
  ) {
    return null;
  }
  const values = {};
  for (const key of keys) {
    const property = ownDataValue(value, key);
    if (!property.present) return null;
    values[key] = property.value;
  }
  return values;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

function entitlementRef(value, expectedSubject, now) {
  const legacyKeys = new Set([
    "subject",
    "agentId",
    "domainId",
    "projectId",
    "status",
    "grantedBySubject",
    "grantedAt",
    "revokedBySubject",
    "revokedAt",
  ]);
  const typedKeys = new Set([
    ...legacyKeys,
    "subjectType",
    "expiresAt",
  ]);
  const typed = isPlainObject(value)
    && Reflect.ownKeys(value).includes("subjectType");
  const values = storedValues(value, typed ? typedKeys : legacyKeys);
  if (values === null) return null;
  const subjectType = typed ? values.subjectType : "USER";
  const subject = typeof values.subject === "string"
    && SUBJECT_PATTERN.test(values.subject)
    ? values.subject
    : null;
  if (
    !ENTITLEMENT_SUBJECT_TYPES.has(subjectType)
    || subject === null
  ) {
    return null;
  }
  if (
    subjectType !== expectedSubject.subjectType
    || subject !== expectedSubject.subject
  ) {
    return Object.freeze({ foreign: true });
  }
  const domainId = authoritativeString(
    values,
    "domainId",
    DOMAIN_ID_PATTERN,
  );
  const projectId = authoritativeString(
    values,
    "projectId",
    SLUG_PATTERN,
  );
  const agentId = authoritativeString(
    values,
    "agentId",
    SLUG_PATTERN,
  );
  const status = authoritativeString(
    values,
    "status",
    /^(?:ACTIVE|REVOKED)$/,
  );
  const grantedBySubject = typeof values.grantedBySubject === "string"
    && SUBJECT_PATTERN.test(values.grantedBySubject)
    ? values.grantedBySubject
    : null;
  const grantedAt = canonicalTimestamp(values.grantedAt);
  const revokedBySubject = values.revokedBySubject === null
    ? null
    : (
        typeof values.revokedBySubject === "string"
        && SUBJECT_PATTERN.test(values.revokedBySubject)
          ? values.revokedBySubject
          : undefined
      );
  const revokedAt = values.revokedAt === null
    ? null
    : canonicalTimestamp(values.revokedAt);
  const expiresAt = typed && values.expiresAt !== null
    ? canonicalTimestamp(values.expiresAt)
    : null;
  if (
    !domainId
    || !projectId
    || !agentId
    || !status
    || grantedBySubject === null
    || grantedAt === null
    || revokedBySubject === undefined
    || revokedAt === undefined
    || (
      typed
      && values.expiresAt !== null
      && expiresAt === null
    )
    || (
      expiresAt !== null
      && expiresAt <= grantedAt
    )
    || (
      status === "ACTIVE"
      && (revokedBySubject !== null || revokedAt !== null)
    )
    || (
      status === "REVOKED"
      && (
        revokedBySubject === null
        || revokedAt === null
        || revokedAt < grantedAt
      )
    )
  ) {
    return null;
  }
  return Object.freeze({
    subjectType,
    subject,
    domainId,
    projectId,
    agentId,
    status,
    expired: expiresAt !== null && expiresAt <= now,
  });
}

function validateAgent(value, ref) {
  if (!isPlainObject(value)) return null;
  const domainId = authoritativeString(
    value,
    "domainId",
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
  );
  const projectId = authoritativeString(
    value,
    "projectId",
    /^[a-z][a-z0-9-]{0,63}$/,
  );
  const id = authoritativeString(
    value,
    "id",
    /^[a-z][a-z0-9-]{0,63}$/,
  );
  const name = ownDataValue(value, "name");
  const description = ownDataValue(value, "description");
  const status = ownDataValue(value, "status");
  if (
    domainId !== ref.domainId
    || projectId !== ref.projectId
    || id !== ref.agentId
    || !name.present
    || !validText(name.value, 128, { allowNewlines: false })
    || !description.present
    || !validText(description.value, 4096, { minimum: 0 })
    || !status.present
    || typeof status.value !== "string"
  ) {
    return null;
  }
  return {
    record: value,
    id,
    name: name.value,
    description: description.value,
    status: status.value,
  };
}

function validateDeployment(value, ref) {
  if (!isPlainObject(value)) return null;
  const domainId = authoritativeString(
    value,
    "domainId",
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
  );
  const projectId = authoritativeString(
    value,
    "projectId",
    /^[a-z][a-z0-9-]{0,63}$/,
  );
  const agentId = authoritativeString(
    value,
    "agentId",
    /^[a-z][a-z0-9-]{0,63}$/,
  );
  const environment = ownDataValue(value, "environment");
  const status = ownDataValue(value, "status");
  const runtimeStatus = ownDataValue(value, "runtimeStatus");
  const runtimeId = ownDataValue(value, "runtimeId");
  const runtimeArn = ownDataValue(value, "runtimeArn");
  const endpointName = ownDataValue(value, "endpointName");
  const endpointArn = ownDataValue(value, "endpointArn");
  const runtimeVersion = ownDataValue(value, "runtimeVersion");
  if (
    domainId !== ref.domainId
    || projectId !== ref.projectId
    || agentId !== ref.agentId
    || !environment.present
    || !status.present
    || !runtimeStatus.present
    || !runtimeId.present
    || !runtimeArn.present
    || !endpointName.present
    || !endpointArn.present
    || !runtimeVersion.present
    || typeof runtimeId.value !== "string"
    || runtimeId.value.length === 0
    || typeof runtimeArn.value !== "string"
    || !ARN_PATTERN.test(runtimeArn.value)
    || typeof endpointName.value !== "string"
    || endpointName.value.length === 0
    || typeof endpointArn.value !== "string"
    || !ARN_PATTERN.test(endpointArn.value)
    || typeof runtimeVersion.value !== "string"
    || runtimeVersion.value.length === 0
  ) {
    return null;
  }
  return {
    record: value,
    environment: environment.value,
    status: status.value,
    runtimeStatus: runtimeStatus.value,
  };
}

function validateSession(value, actor) {
  if (!isPlainObject(value)) return null;
  const storedActor = authoritativeString(value, "actor", SUBJECT_PATTERN);
  const id = authoritativeString(value, "id", SESSION_ID_PATTERN);
  const agentId = authoritativeString(
    value,
    "agentId",
    /^[a-z][a-z0-9-]{0,63}$/,
  );
  const domainId = authoritativeString(
    value,
    "domainId",
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
  );
  const projectId = authoritativeString(
    value,
    "projectId",
    /^[a-z][a-z0-9-]{0,63}$/,
  );
  const status = authoritativeString(
    value,
    "status",
    /^(?:ACTIVE|COMPLETED|FAILED|CANCELLED)$/,
  );
  const invocation = ownDataValue(value, "lastInvocationStatus");
  const createdAt = ownDataValue(value, "createdAt");
  const updatedAt = ownDataValue(value, "updatedAt");
  if (
    storedActor !== actor
    || !id
    || !id.startsWith(`${actorSessionPrefix(actor)}-`)
    || !agentId
    || !domainId
    || !projectId
    || !status
    || !invocation.present
    || !(
      invocation.value === null
      || invocation.value === "SUCCEEDED"
      || invocation.value === "FAILED"
    )
    || !createdAt.present
    || !updatedAt.present
    || typeof createdAt.value !== "string"
    || typeof updatedAt.value !== "string"
  ) {
    return null;
  }
  return {
    record: value,
    id,
    agentId,
    domainId,
    projectId,
    status,
    lastInvocationStatus: invocation.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  };
}

function beginTransaction(state) {
  let value;
  try {
    value = state.beginTransaction();
  } catch {
    fail("EXPERIENCE_UNAVAILABLE");
  }
  if (!isPlainObject(value)) fail("EXPERIENCE_UNAVAILABLE");
  const timestamp = ownDataValue(value, "timestamp");
  const epochSeconds = ownDataValue(value, "epochSeconds");
  const parsed = typeof timestamp.value === "string"
    ? Date.parse(timestamp.value)
    : Number.NaN;
  if (
    Reflect.ownKeys(value).length !== 2
    || !timestamp.present
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== timestamp.value
    || !epochSeconds.present
    || !Number.isSafeInteger(epochSeconds.value)
    || epochSeconds.value !== Math.floor(parsed / 1000)
  ) {
    fail("EXPERIENCE_UNAVAILABLE");
  }
  return {
    timestamp: timestamp.value,
    epochSeconds: epochSeconds.value,
    original: value,
  };
}

async function stateCall(state, method, input) {
  try {
    return await state[method](input);
  } catch (error) {
    if (
      error?.code === "MUTATION_CONFLICT"
      || error?.code === "MUTATION_IN_PROGRESS"
      || String(error?.code).includes("TRANSITION")
      || String(error?.code).includes("CONFLICT")
    ) {
      fail("CONFLICT");
    }
    fail("EXPERIENCE_UNAVAILABLE");
  }
}

async function authorize(
  authorizer,
  identity,
  ref,
  action = "agent:invoke",
  entitlementSubject = null,
) {
  let decision;
  try {
    decision = await authorizer({
      requestContext: Object.freeze({
        source: "experience-service",
        subject: identity.actor,
        role: identity.role,
        activeDomain: null,
        domainIds: Object.freeze([]),
        authenticatedGroups: identity.authenticatedGroups,
        authenticatedDomains: identity.authenticatedDomains,
        entitlementSubject: entitlementSubject === null
          ? null
          : Object.freeze({
              subjectType: entitlementSubject.subjectType,
              subject: entitlementSubject.subject,
            }),
      }),
      action,
      resourceRef:
        `agent:${ref.domainId}/${ref.projectId}/${ref.agentId}`,
    });
  } catch (error) {
    if (
      error?.decision === "NOT_FOUND"
      || error?.decision === "FORBIDDEN"
      || error?.decision === "CONFLICT"
    ) {
      return false;
    }
    fail("FORBIDDEN");
  }
  if (!strictDecision(decision)) fail("FORBIDDEN");
  return true;
}

async function listCandidates(state, authorizer, identity, now) {
  const candidates = new Map();
  let entitlementCount = 0;
  for (const entitlementSubject of entitlementSubjects(identity)) {
    const entitlements = page(await stateCall(
      state,
      "listEntitlements",
      entitlementReadInput(
        entitlementSubject,
        null,
        { list: true },
      ),
    ));
    if (entitlements === null) fail("EXPERIENCE_UNAVAILABLE");
    entitlementCount += entitlements.length;
    if (entitlementCount > MAX_ENTITLEMENT_RECORDS) {
      fail("EXPERIENCE_UNAVAILABLE");
    }

    for (const entitlement of entitlements) {
      const ref = entitlementRef(
        entitlement,
        entitlementSubject,
        now,
      );
      if (ref === null) fail("EXPERIENCE_UNAVAILABLE");
      if (ref.foreign || ref.status !== "ACTIVE" || ref.expired) continue;
      const candidateId = publicAgentId(ref);
      const existing = candidates.get(candidateId);
      if (existing) {
        if (
          existing.ref.domainId !== ref.domainId
          || existing.ref.projectId !== ref.projectId
          || existing.ref.agentId !== ref.agentId
        ) {
          fail("EXPERIENCE_UNAVAILABLE");
        }
        if (
          await authorize(
            authorizer,
            identity,
            ref,
            "agent:invoke",
            entitlementSubject,
          )
        ) {
          existing.entitlementSubjects.push(entitlementSubject);
        }
        continue;
      }

      const rawAgent = await stateCall(state, "getAgent", {
        domainId: ref.domainId,
        projectId: ref.projectId,
        agentId: ref.agentId,
      });
      if (rawAgent === null) continue;
      const agent = validateAgent(rawAgent, ref);
      if (agent === null) fail("EXPERIENCE_UNAVAILABLE");
      if (agent.status !== "PRODUCTION_DEPLOYED") continue;

      const deployments = page(await stateCall(
        state,
        "listDeployments",
        {
          domainId: ref.domainId,
          projectId: ref.projectId,
          limit: 100,
        },
      ));
      if (deployments === null) fail("EXPERIENCE_UNAVAILABLE");
      const available = [];
      for (const rawDeployment of deployments) {
        const deployment = validateDeployment(rawDeployment, ref);
        if (deployment === null) continue;
        if (
          deployment.environment === "PRODUCTION"
          && deployment.status === "DEPLOYED"
          && deployment.runtimeStatus === "READY"
        ) {
          available.push(deployment);
        }
      }
      if (available.length === 0) continue;
      if (available.length !== 1) fail("EXPERIENCE_UNAVAILABLE");
      if (
        !(await authorize(
          authorizer,
          identity,
          ref,
          "agent:invoke",
          entitlementSubject,
        ))
      ) {
        continue;
      }
      candidates.set(candidateId, {
        publicId: candidateId,
        ref,
        agent,
        deployment: available[0],
        entitlementSubjects: [entitlementSubject],
      });
    }
  }
  return [...candidates.values()];
}

async function resolveCandidate(
  state,
  authorizer,
  identity,
  requestedPublicId,
  now,
) {
  if (
    typeof requestedPublicId !== "string"
    || !PUBLIC_AGENT_ID_PATTERN.test(requestedPublicId)
  ) {
    fail("INVALID_REQUEST");
  }
  const candidates = await listCandidates(
    state,
    authorizer,
    identity,
    now,
  );
  const candidate = candidates.find(
    ({ publicId }) => publicId === requestedPublicId,
  );
  if (!candidate) fail("NOT_FOUND");
  for (const entitlementSubject of candidate.entitlementSubjects) {
    const current = await stateCall(
      state,
      "getEntitlement",
      entitlementReadInput(entitlementSubject, candidate.ref),
    );
    if (current === null) continue;
    const currentRef = entitlementRef(
      current,
      entitlementSubject,
      now,
    );
    if (currentRef === null) fail("EXPERIENCE_UNAVAILABLE");
    if (
      currentRef.foreign
      || currentRef.status !== "ACTIVE"
      || currentRef.expired
    ) {
      continue;
    }
    if (
      currentRef.domainId !== candidate.ref.domainId
      || currentRef.projectId !== candidate.ref.projectId
      || currentRef.agentId !== candidate.ref.agentId
    ) {
      fail("EXPERIENCE_UNAVAILABLE");
    }
    if (
      await authorize(
        authorizer,
        identity,
        candidate.ref,
        "agent:invoke",
        entitlementSubject,
      )
    ) {
      return candidate;
    }
  }
  fail("NOT_FOUND");
}

function sessionMutation({
  identity,
  requestId,
  payloadFingerprint,
  record,
  expectedStatus,
  transaction,
}) {
  return {
    actor: identity.actor,
    requesterSubject: identity.actor,
    effectiveRole: "user",
    domainId: record.domainId,
    projectId: record.projectId,
    route: EXPERIENCE_ROUTE,
    requestId,
    payloadFingerprint,
    result: {
      entityType: "SESSION",
      resourceKey: `session/${identity.actor}/${record.id}`,
      operation: expectedStatus === null ? "CREATE" : "UPDATE",
      status: "SUCCEEDED",
    },
    decision: expectedStatus === null ? "create" : "update",
    reason:
      `Governed invocation completed with ${record.lastInvocationStatus}.`,
    timestamp: transaction.timestamp,
    createdAt: transaction.timestamp,
  };
}

function mutationReplay(value, {
  identity,
  requestId,
  payloadFingerprint: expectedFingerprint,
  sessionId,
}) {
  if (!isPlainObject(value)) return null;
  const actor = ownDataValue(value, "actor");
  const route = ownDataValue(value, "route");
  const storedRequestId = ownDataValue(value, "requestId");
  const storedFingerprint = ownDataValue(value, "payloadFingerprint");
  const result = ownDataValue(value, "result");
  const reason = ownDataValue(value, "reason");
  if (
    !actor.present
    || actor.value !== identity.actor
    || !route.present
    || route.value !== EXPERIENCE_ROUTE
    || !storedRequestId.present
    || storedRequestId.value !== requestId
    || !storedFingerprint.present
    || storedFingerprint.value !== expectedFingerprint
    || !result.present
    || !isPlainObject(result.value)
    || !reason.present
    || typeof reason.value !== "string"
    || !Object.hasOwn(INVOCATION_REPLAY_OUTCOMES, reason.value)
  ) {
    fail("CONFLICT");
  }
  const entityType = ownDataValue(result.value, "entityType");
  const resourceKey = ownDataValue(result.value, "resourceKey");
  const status = ownDataValue(result.value, "status");
  if (
    !entityType.present
    || entityType.value !== "SESSION"
    || !resourceKey.present
    || resourceKey.value !== `session/${identity.actor}/${sessionId}`
    || !status.present
    || status.value !== "SUCCEEDED"
  ) {
    fail("CONFLICT");
  }
  return INVOCATION_REPLAY_OUTCOMES[reason.value];
}

function normalizeRuntimeOutcome(value) {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== (Object.hasOwn(value, "accounting") ? 3 : 2)
    || !keys.includes("output")
    || !keys.includes("invocationId")
  ) {
    return null;
  }
  const output = ownDataValue(value, "output");
  const invocationId = ownDataValue(value, "invocationId");
  if (
    !output.present
    || typeof output.value !== "string"
    || Buffer.byteLength(output.value, "utf8") > MAX_OUTPUT_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
      output.value,
    )
    || !invocationId.present
    || typeof invocationId.value !== "string"
    || !RESULT_ID_PATTERN.test(invocationId.value)
    || (Object.hasOwn(value, "accounting")
      && !validAccounting(ownDataValue(value, "accounting").value))
  ) {
    return null;
  }
  return {
    output: output.value,
    invocationId: invocationId.value,
    ...(Object.hasOwn(value, "accounting")
      ? { accounting: ownDataValue(value, "accounting").value } : {}),
  };
}

function validateInvocationJournal(value, expected) {
  const keys = [
    "actor",
    "requestId",
    "payloadFingerprint",
    "sessionId",
    "domainId",
    "projectId",
    "agentId",
    "baselineFingerprint",
    "phase",
    "runtimeStatus",
    "output",
    "invocationId",
    ...(isPlainObject(value) && Object.hasOwn(value, "accounting") ? ["accounting"] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, "lifecycle") ? ["lifecycle"] : []),
  ];
  if (
    !isPlainObject(value)
    || Reflect.ownKeys(value).length !== keys.length
    || Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    )
  ) {
    fail("EXPERIENCE_UNAVAILABLE");
  }
  const values = {};
  for (const key of keys) {
    const property = ownDataValue(value, key);
    if (!property.present) fail("EXPERIENCE_UNAVAILABLE");
    values[key] = property.value;
  }
  if (
    values.actor !== expected.actor
    || values.requestId !== expected.requestId
    || values.payloadFingerprint !== expected.payloadFingerprint
    || values.sessionId !== expected.sessionId
    || values.domainId !== expected.domainId
    || values.projectId !== expected.projectId
    || values.agentId !== expected.agentId
    || !(
      values.baselineFingerprint === null
      || FINGERPRINT_PATTERN.test(values.baselineFingerprint)
    )
    || (values.accounting !== undefined && !validAccounting(values.accounting))
    || (values.lifecycle !== undefined && !validInvocationLifecycle(values.lifecycle))
  ) {
    fail("CONFLICT");
  }
  if (
    values.phase === "STARTED"
    && values.runtimeStatus === null
    && values.output === null
    && values.invocationId === null
  ) {
    return values;
  }
  if (
    values.phase === "COMPLETED"
    && (
      (
        values.runtimeStatus === "SUCCEEDED"
        && normalizeRuntimeOutcome({
          output: values.output,
          invocationId: values.invocationId,
        }) !== null
      )
      || (
        values.runtimeStatus === "FAILED"
        && values.output === null
        && values.invocationId === null
      )
    )
  ) {
    return values;
  }
  fail("EXPERIENCE_UNAVAILABLE");
}

async function invocationStoreCall(store, method, input) {
  try {
    return await store[method](input);
  } catch (error) {
    if (error?.code === "INVOCATION_JOURNAL_CONFLICT") {
      fail("CONFLICT");
    }
    fail("EXPERIENCE_UNAVAILABLE");
  }
}

function invocationJournalInput({
  identity,
  requestId,
  payloadFingerprint,
  sessionId,
  candidate,
  existing,
}) {
  return {
    actor: identity.actor,
    requestId,
    payloadFingerprint,
    sessionId,
    domainId: candidate.ref.domainId,
    projectId: candidate.ref.projectId,
    agentId: candidate.ref.agentId,
    baselineFingerprint:
      existing === null ? null : fingerprint(existing.record),
  };
}

function validateJournalBaseline(journal, existing) {
  const actual = existing === null ? null : fingerprint(existing.record);
  if (actual !== journal.baselineFingerprint) fail("CONFLICT");
}

async function persistInvocationSession({
  workspaceState,
  identity,
  requestId,
  payloadFingerprint,
  sessionId,
  candidate,
  existing,
  journal,
  replayed,
}) {
  validateJournalBaseline(journal, existing);
  const transaction = beginTransaction(workspaceState);
  const record = {
    actor: identity.actor,
    id: sessionId,
    agentId: candidate.ref.agentId,
    domainId: candidate.ref.domainId,
    projectId: candidate.ref.projectId,
    status: "ACTIVE",
    lastInvocationStatus: journal.runtimeStatus,
    createdAt: existing?.createdAt ?? transaction.timestamp,
    updatedAt: transaction.timestamp,
  };
  await stateCall(workspaceState, "putSession", {
    record,
    expectedStatus: existing?.status ?? null,
    mutation: sessionMutation({
      identity,
      requestId,
      payloadFingerprint,
      record,
      expectedStatus: existing?.status ?? null,
      transaction,
    }),
    transaction: transaction.original,
  });
  if (journal.runtimeStatus === "FAILED") fail("RUNTIME_UNAVAILABLE");
  return {
    sessionId,
    status: "SUCCEEDED",
    output: journal.output,
    invocationId: journal.invocationId,
    replayed,
  };
}

function validateSubmissionResult(value, expectedStatus) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== 2) {
    fail("SUBMISSION_UNAVAILABLE");
  }
  const id = ownDataValue(value, "id");
  const status = ownDataValue(value, "status");
  if (
    !id.present
    || typeof id.value !== "string"
    || !RESULT_ID_PATTERN.test(id.value)
    || !status.present
    || status.value !== expectedStatus
  ) {
    fail("SUBMISSION_UNAVAILABLE");
  }
  return { id: id.value, status: status.value };
}

async function submit(submissionStore, method, input, expectedStatus) {
  try {
    return validateSubmissionResult(
      await submissionStore[method](input),
      expectedStatus,
    );
  } catch (error) {
    if (error instanceof ExperienceServiceError) throw error;
    fail("SUBMISSION_UNAVAILABLE");
  }
}

async function requireMatchingSession(state, identity, candidate, sessionId) {
  const id = validateSessionId(sessionId, identity.actor);
  const stored = await stateCall(state, "getSession", {
    actor: identity.actor,
    sessionId: id,
  });
  if (stored === null) fail("NOT_FOUND");
  const session = validateSession(stored, identity.actor);
  if (
    session === null
    || session.domainId !== candidate.ref.domainId
    || session.projectId !== candidate.ref.projectId
    || session.agentId !== candidate.ref.agentId
  ) {
    fail("NOT_FOUND");
  }
  return session;
}

function validateProjectRef(value, domainId) {
  if (!isPlainObject(value)) return null;
  const storedDomain = authoritativeString(
    value,
    "domainId",
    DOMAIN_ID_PATTERN,
  );
  const id = authoritativeString(value, "id", SLUG_PATTERN);
  if (storedDomain !== domainId || !id) return null;
  return { domainId, projectId: id };
}

async function activeDomainIds(domainDirectory) {
  let value;
  try {
    value = await domainDirectory.listActiveDomains();
  } catch {
    fail("EXPERIENCE_UNAVAILABLE");
  }
  if (!Array.isArray(value) || value.length > MAX_CATALOG_DOMAINS) {
    fail("EXPERIENCE_UNAVAILABLE");
  }
  const domainIds = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    const record = descriptor?.value;
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || !isPlainObject(record)
      || Reflect.ownKeys(record).length !== 1
    ) {
      fail("EXPERIENCE_UNAVAILABLE");
    }
    const domainId = authoritativeString(
      record,
      "id",
      DOMAIN_ID_PATTERN,
    );
    if (
      !domainId
      || domainId === "shared"
      || domainIds.includes(domainId)
    ) {
      fail("EXPERIENCE_UNAVAILABLE");
    }
    domainIds.push(domainId);
  }
  return domainIds;
}

async function hasActiveEntitlement(state, identity, ref, now) {
  for (const entitlementSubject of entitlementSubjects(identity)) {
    const current = await stateCall(
      state,
      "getEntitlement",
      entitlementReadInput(entitlementSubject, ref),
    );
    if (current === null) continue;
    const currentRef = entitlementRef(
      current,
      entitlementSubject,
      now,
    );
    if (
      currentRef === null
      || currentRef.foreign
      || currentRef.domainId !== ref.domainId
      || currentRef.projectId !== ref.projectId
      || currentRef.agentId !== ref.agentId
    ) {
      fail("EXPERIENCE_UNAVAILABLE");
    }
    if (currentRef.status === "ACTIVE" && !currentRef.expired) {
      return true;
    }
  }
  return false;
}

async function listRequestableCandidates(
  state,
  domainDirectory,
  authorizer,
  identity,
  now,
  entitledCandidates,
) {
  const entitledIds = new Set(
    entitledCandidates.map(({ publicId }) => publicId),
  );
  const candidates = new Map();
  let projectCount = 0;
  let agentCount = 0;
  for (const domainId of await activeDomainIds(domainDirectory)) {
    const projects = page(await stateCall(
      state,
      "listProjects",
      { domainId, limit: 100 },
    ));
    if (projects === null) fail("EXPERIENCE_UNAVAILABLE");
    projectCount += projects.length;
    if (projectCount > MAX_CATALOG_PROJECTS) {
      fail("EXPERIENCE_UNAVAILABLE");
    }
    for (const rawProject of projects) {
      const project = validateProjectRef(rawProject, domainId);
      if (project === null) fail("EXPERIENCE_UNAVAILABLE");
      const agents = page(await stateCall(
        state,
        "listAgents",
        {
          domainId,
          projectId: project.projectId,
          limit: 100,
        },
      ));
      if (agents === null) fail("EXPERIENCE_UNAVAILABLE");
      agentCount += agents.length;
      if (agentCount > MAX_CATALOG_AGENTS) {
        fail("EXPERIENCE_UNAVAILABLE");
      }
      const deployments = page(await stateCall(
        state,
        "listDeployments",
        {
          domainId,
          projectId: project.projectId,
          limit: 100,
        },
      ));
      if (deployments === null) fail("EXPERIENCE_UNAVAILABLE");
      for (const rawAgent of agents) {
        const rawId = authoritativeString(rawAgent, "id", SLUG_PATTERN);
        if (!rawId) fail("EXPERIENCE_UNAVAILABLE");
        const ref = {
          domainId,
          projectId: project.projectId,
          agentId: rawId,
        };
        const publicId = publicAgentId(ref);
        if (candidates.has(publicId)) fail("EXPERIENCE_UNAVAILABLE");
        const agent = validateAgent(rawAgent, ref);
        if (agent === null) fail("EXPERIENCE_UNAVAILABLE");
        if (agent.status !== "PRODUCTION_DEPLOYED") continue;
        const available = deployments
          .map((value) => validateDeployment(value, ref))
          .filter((value) =>
            value !== null
            && value.environment === "PRODUCTION"
            && value.status === "DEPLOYED"
            && value.runtimeStatus === "READY");
        if (available.length > 1) fail("EXPERIENCE_UNAVAILABLE");
        if (available.length === 0 || entitledIds.has(publicId)) continue;
        if (await hasActiveEntitlement(
          state,
          identity,
          ref,
          now,
        )) {
          continue;
        }
        if (!await authorize(
          authorizer,
          identity,
          ref,
          "agent:access-request",
        )) {
          continue;
        }
        candidates.set(publicId, {
          publicId,
          ref,
          agent,
        });
      }
    }
  }
  return [...candidates.values()];
}

async function resolveRequestableCandidate(
  state,
  authorizer,
  identity,
  domainId,
  requestedPublicId,
) {
  const projects = page(await stateCall(
    state,
    "listProjects",
    { domainId, limit: 100 },
  ));
  if (projects === null) fail("EXPERIENCE_UNAVAILABLE");
  const matches = [];
  for (const rawProject of projects) {
    const project = validateProjectRef(rawProject, domainId);
    if (project === null) fail("EXPERIENCE_UNAVAILABLE");
    const agents = page(await stateCall(
      state,
      "listAgents",
      {
        domainId,
        projectId: project.projectId,
        limit: 100,
      },
    ));
    if (agents === null) fail("EXPERIENCE_UNAVAILABLE");
    for (const rawAgent of agents) {
      const rawId = authoritativeString(rawAgent, "id", SLUG_PATTERN);
      if (!rawId) fail("EXPERIENCE_UNAVAILABLE");
      const ref = {
        domainId,
        projectId: project.projectId,
        agentId: rawId,
      };
      if (publicAgentId(ref) !== requestedPublicId) continue;
      const agent = validateAgent(rawAgent, ref);
      if (agent === null) fail("EXPERIENCE_UNAVAILABLE");
      if (agent.status !== "PRODUCTION_DEPLOYED") continue;
      const deployments = page(await stateCall(
        state,
        "listDeployments",
        {
          domainId,
          projectId: project.projectId,
          limit: 100,
        },
      ));
      if (deployments === null) fail("EXPERIENCE_UNAVAILABLE");
      const available = deployments
        .map((value) => validateDeployment(value, ref))
        .filter((value) =>
          value !== null
          && value.environment === "PRODUCTION"
          && value.status === "DEPLOYED"
          && value.runtimeStatus === "READY");
      if (available.length > 1) fail("EXPERIENCE_UNAVAILABLE");
      if (available.length === 0) continue;
      if (!await authorize(
        authorizer,
        identity,
        ref,
        "agent:access-request",
      )) {
        continue;
      }
      matches.push({ ref, agent, deployment: available[0] });
    }
  }
  if (matches.length === 0) fail("NOT_FOUND");
  if (matches.length !== 1) fail("EXPERIENCE_UNAVAILABLE");
  return matches[0];
}

function accessApprovalId(identity, requestId, payloadHash) {
  return `access-${
    createHash("sha256")
      .update(
        `${identity.actor}\0${requestId}\0${payloadHash}`,
      )
      .digest("hex")
      .slice(0, 32)
  }`;
}

function accessApprovalMutation({
  identity,
  requestId,
  payloadHash,
  approval,
  transaction,
}) {
  return {
    actor: identity.actor,
    requesterSubject: identity.actor,
    effectiveRole: "user",
    domainId: approval.domainId,
    projectId: approval.projectId,
    route: "POST /api/experience/access-requests",
    requestId,
    payloadFingerprint: payloadHash,
    result: {
      entityType: "APPROVAL",
      resourceKey: `approval/${approval.domainId}/${approval.id}`,
      operation: "CREATE",
      status: "SUCCEEDED",
    },
    decision: "request",
    reason: approval.reason,
    timestamp: transaction.timestamp,
    createdAt: transaction.timestamp,
  };
}

export function createExperienceService({
  workspaceState,
  domainDirectory,
  authorizer,
  runtimeAdapter,
  invocationStore,
  submissionStore,
  clock = () => new Date(),
} = {}) {
  if (
    !workspaceState
    || !STATE_METHODS.every(
      (method) => typeof workspaceState[method] === "function",
    )
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || typeof authorizer !== "function"
    || !runtimeAdapter
    || typeof runtimeAdapter.invoke !== "function"
    || !invocationStore
    || !INVOCATION_STORE_METHODS.every(
      (method) => typeof invocationStore[method] === "function",
    )
    || typeof clock !== "function"
  ) {
    throw new TypeError("Experience service configuration is invalid.");
  }
  if (
    !submissionStore
    || ![
      "submitFeedback",
      "reportIssue",
    ].every((method) => typeof submissionStore[method] === "function")
  ) {
    throw new TypeError(
      "Experience submission store configuration is invalid.",
    );
  }

  return Object.freeze({
    async listAgents(input) {
      const values = strictValues(
        input,
        new Set(["identity"]),
        ["identity"],
      );
      const currentIdentity = validateIdentity(values.identity);
      const now = numericClock(clock);
      const candidates = await listCandidates(
        workspaceState,
        authorizer,
        currentIdentity,
        now,
      );
      const requestableCandidates = await listRequestableCandidates(
        workspaceState,
        domainDirectory,
        authorizer,
        currentIdentity,
        now,
        candidates,
      );
      return {
        items: candidates.map(({ publicId, agent: record }) => ({
          id: publicId,
          name: record.name,
          description: record.description,
        })),
        requestableItems: requestableCandidates.map(({
          publicId,
          ref,
          agent: record,
        }) => ({
          id: publicId,
          domainId: ref.domainId,
          name: record.name,
          description: record.description,
        })),
      };
    },

    async invoke(input) {
      const values = strictValues(
        input,
        new Set([
          "identity",
          "requestId",
          "agentId",
          "sessionId",
          "prompt",
        ]),
        ["identity", "requestId", "agentId", "prompt"],
      );
      const currentIdentity = validateIdentity(values.identity);
      const requestId = validateRequestId(values.requestId);
      if (!validText(values.prompt, MAX_PROMPT_LENGTH)) {
        fail("INVALID_REQUEST");
      }
      const candidate = await resolveCandidate(
        workspaceState,
        authorizer,
        currentIdentity,
        values.agentId,
        numericClock(clock),
      );
      const sessionId = values.sessionId === undefined
        ? generatedSessionId(currentIdentity.actor, requestId)
        : validateSessionId(values.sessionId, currentIdentity.actor);
      const normalizedPayload = {
        agentId: values.agentId,
        sessionId,
        prompt: values.prompt,
      };
      const payloadHash = fingerprint(normalizedPayload);
      const expectedJournal = {
        actor: currentIdentity.actor,
        requestId,
        payloadFingerprint: payloadHash,
        sessionId,
        domainId: candidate.ref.domainId,
        projectId: candidate.ref.projectId,
        agentId: candidate.ref.agentId,
      };

      const completed = await stateCall(
        workspaceState,
        "getMutationResult",
        {
          actor: currentIdentity.actor,
          route: EXPERIENCE_ROUTE,
          requestId,
        },
      );
      if (completed !== null) {
        const originalInvocationStatus = mutationReplay(completed, {
          identity: currentIdentity,
          requestId,
          payloadFingerprint: payloadHash,
          sessionId,
        });
        const stored = await stateCall(workspaceState, "getSession", {
          actor: currentIdentity.actor,
          sessionId,
        });
        const replaySession = validateSession(
          stored,
          currentIdentity.actor,
        );
        if (replaySession === null) fail("CONFLICT");
        if (originalInvocationStatus === "FAILED") {
          fail("RUNTIME_UNAVAILABLE");
        }
        const journalValue = await invocationStoreCall(
          invocationStore,
          "get",
          {
            actor: currentIdentity.actor,
            requestId,
            payloadFingerprint: payloadHash,
          },
        );
        if (journalValue !== null) {
          const journal = validateInvocationJournal(
            journalValue,
            expectedJournal,
          );
          if (journal.phase === "STARTED") {
            fail("INVOCATION_OUTCOME_UNKNOWN");
          }
          if (journal.runtimeStatus !== "SUCCEEDED") fail("CONFLICT");
          return {
            sessionId,
            status: "SUCCEEDED",
            output: journal.output,
            invocationId: journal.invocationId,
            replayed: true,
          };
        }
        return {
          sessionId,
          status: "SUCCEEDED",
          output: null,
          invocationId: null,
          replayed: true,
        };
      }

      const journalValue = await invocationStoreCall(
        invocationStore,
        "get",
        {
          actor: currentIdentity.actor,
          requestId,
          payloadFingerprint: payloadHash,
        },
      );
      if (journalValue !== null) {
        const journal = validateInvocationJournal(
          journalValue,
          expectedJournal,
        );
        if (journal.phase === "STARTED") {
          fail("INVOCATION_OUTCOME_UNKNOWN");
        }
        const recoveryRaw = await stateCall(
          workspaceState,
          "getSession",
          {
            actor: currentIdentity.actor,
            sessionId,
          },
        );
        const recoverySession = recoveryRaw === null
          ? null
          : validateSession(recoveryRaw, currentIdentity.actor);
        if (
          recoveryRaw !== null
          && (
            recoverySession === null
            || recoverySession.domainId !== candidate.ref.domainId
            || recoverySession.projectId !== candidate.ref.projectId
            || recoverySession.agentId !== candidate.ref.agentId
            || recoverySession.status !== "ACTIVE"
          )
        ) {
          fail("CONFLICT");
        }
        return persistInvocationSession({
          workspaceState,
          identity: currentIdentity,
          requestId,
          payloadFingerprint: payloadHash,
          sessionId,
          candidate,
          existing: recoverySession,
          journal,
          replayed: true,
        });
      }

      const existingRaw = await stateCall(workspaceState, "getSession", {
        actor: currentIdentity.actor,
        sessionId,
      });
      let existing = null;
      if (existingRaw !== null) {
        existing = validateSession(existingRaw, currentIdentity.actor);
        if (
          existing === null
          || existing.domainId !== candidate.ref.domainId
          || existing.projectId !== candidate.ref.projectId
          || existing.agentId !== candidate.ref.agentId
        ) {
          fail("NOT_FOUND");
        }
        if (existing.status !== "ACTIVE") fail("CONFLICT");
      }

      await stateCall(workspaceState, "claimMutation", {
        actor: currentIdentity.actor,
        requesterSubject: currentIdentity.actor,
        effectiveRole: "user",
        domainId: candidate.ref.domainId,
        projectId: candidate.ref.projectId,
        route: EXPERIENCE_CLAIM_ROUTE,
        requestId,
        payloadFingerprint: payloadHash,
        resourceKey:
          `session/${currentIdentity.actor}/${sessionId}`,
        operation: existing === null ? "CREATE" : "UPDATE",
      });
      const journalInput = invocationJournalInput({
        identity: currentIdentity,
        requestId,
        payloadFingerprint: payloadHash,
        sessionId,
        candidate,
        existing,
      });
      const started = validateInvocationJournal(
        await invocationStoreCall(
          invocationStore,
          "start",
          journalInput,
        ),
        expectedJournal,
      );
      if (started.phase !== "STARTED") fail("CONFLICT");

      let outcome;
      let runtimeFailed = false;
      try {
        outcome = normalizeRuntimeOutcome(
          await runtimeAdapter.invoke({
            actor: currentIdentity.actor,
            requestId,
            sessionId,
            prompt: values.prompt,
            agent: candidate.agent.record,
            deployment: candidate.deployment.record,
            ...(typeof invocationStore.prepareExecution === "function" ? {
              nativeExecution: {
                payloadFingerprint: payloadHash,
                prepare: signed => invocationStore.prepareExecution(journalInput, signed),
              },
            } : {}),
            ...(typeof invocationStore.markDispatched === "function" ? {
              onDispatch: ({ region }) => invocationStore.markDispatched({ ...journalInput, region }),
            } : {}),
          }),
        );
        if (outcome === null || (outcome.accounting !== undefined && (
          outcome.accounting.modelId !== candidate.agent.record.modelId
          || outcome.accounting.runId !== createHash("sha256")
            .update(`${currentIdentity.actor}\0${requestId}`).digest("hex")
        ))) runtimeFailed = true;
      } catch {
        runtimeFailed = true;
      }

      let journal;
      try {
        const completedJournal = await invocationStore.complete({
          ...journalInput,
          runtimeStatus: runtimeFailed ? "FAILED" : "SUCCEEDED",
          output: runtimeFailed ? null : outcome.output,
          invocationId: runtimeFailed ? null : outcome.invocationId,
          ...(!runtimeFailed && outcome.accounting !== undefined
            ? { accounting: outcome.accounting } : {}),
        });
        journal = validateInvocationJournal(
          completedJournal,
          expectedJournal,
        );
        if (journal.phase !== "COMPLETED") {
          throw new Error("Invocation journal completion is invalid.");
        }
      } catch {
        fail("INVOCATION_OUTCOME_UNKNOWN");
      }
      return persistInvocationSession({
        workspaceState,
        identity: currentIdentity,
        requestId,
        payloadFingerprint: payloadHash,
        sessionId,
        candidate,
        existing,
        journal,
        replayed: false,
      });
    },

    async listSessions(input) {
      const values = strictValues(
        input,
        new Set(["identity"]),
        ["identity"],
      );
      const currentIdentity = validateIdentity(values.identity);
      const sessions = page(await stateCall(
        workspaceState,
        "listSessions",
        { actor: currentIdentity.actor, limit: 100 },
      ));
      if (sessions === null) fail("EXPERIENCE_UNAVAILABLE");
      return {
        items: sessions.map((value) => {
          const current = validateSession(value, currentIdentity.actor);
          if (current === null) fail("EXPERIENCE_UNAVAILABLE");
          return {
            id: current.id,
            agentId: publicAgentId({
              domainId: current.domainId,
              projectId: current.projectId,
              agentId: current.agentId,
            }),
            status: current.status,
            lastInvocationStatus: current.lastInvocationStatus,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
          };
        }),
      };
    },

    async listAccessRequests(input) {
      const values = strictValues(
        input,
        new Set(["identity"]),
        ["identity"],
      );
      const currentIdentity = validateIdentity(values.identity);
      const requests = page(await stateCall(
        workspaceState,
        "listAccessRequests",
        {
          requesterSubject: currentIdentity.actor,
          limit: 100,
        },
      ));
      if (requests === null) fail("EXPERIENCE_UNAVAILABLE");
      return {
        items: requests.map((value) =>
          accessRequestProjection(value, currentIdentity.actor)),
      };
    },

    async submitFeedback(input) {
      const values = strictValues(
        input,
        new Set([
          "identity",
          "requestId",
          "agentId",
          "sessionId",
          "rating",
          "comment",
        ]),
        [
          "identity",
          "requestId",
          "agentId",
          "sessionId",
          "rating",
          "comment",
        ],
      );
      const currentIdentity = validateIdentity(values.identity);
      const requestId = validateRequestId(values.requestId);
      if (
        !Number.isSafeInteger(values.rating)
        || values.rating < 1
        || values.rating > 5
        || !validText(values.comment, 2048, { minimum: 0 })
      ) {
        fail("INVALID_REQUEST");
      }
      const candidate = await resolveCandidate(
        workspaceState,
        authorizer,
        currentIdentity,
        values.agentId,
        numericClock(clock),
      );
      await requireMatchingSession(
        workspaceState,
        currentIdentity,
        candidate,
        values.sessionId,
      );
      const payload = {
        publicAgentId: values.agentId,
        sessionId: values.sessionId,
        rating: values.rating,
        comment: values.comment,
      };
      return submit(
        submissionStore,
        "submitFeedback",
        {
          actor: currentIdentity.actor,
          effectiveRole: "user",
          requestId,
          route: "POST /api/experience/feedback",
          payloadFingerprint: fingerprint(payload),
          agent: {
            domainId: candidate.ref.domainId,
            projectId: candidate.ref.projectId,
            agentId: candidate.ref.agentId,
          },
          sessionId: values.sessionId,
          rating: values.rating,
          comment: values.comment,
        },
        "RECORDED",
      );
    },

    async reportIssue(input) {
      const values = strictValues(
        input,
        new Set([
          "identity",
          "requestId",
          "agentId",
          "sessionId",
          "description",
        ]),
        [
          "identity",
          "requestId",
          "agentId",
          "sessionId",
          "description",
        ],
      );
      const currentIdentity = validateIdentity(values.identity);
      const requestId = validateRequestId(values.requestId);
      if (!validText(values.description, 4096)) {
        fail("INVALID_REQUEST");
      }
      const candidate = await resolveCandidate(
        workspaceState,
        authorizer,
        currentIdentity,
        values.agentId,
        numericClock(clock),
      );
      await requireMatchingSession(
        workspaceState,
        currentIdentity,
        candidate,
        values.sessionId,
      );
      const payload = {
        publicAgentId: values.agentId,
        sessionId: values.sessionId,
        description: values.description,
      };
      return submit(
        submissionStore,
        "reportIssue",
        {
          actor: currentIdentity.actor,
          effectiveRole: "user",
          requestId,
          route: "POST /api/experience/issues",
          payloadFingerprint: fingerprint(payload),
          agent: {
            domainId: candidate.ref.domainId,
            projectId: candidate.ref.projectId,
            agentId: candidate.ref.agentId,
          },
          sessionId: values.sessionId,
          description: values.description,
        },
        "RECORDED",
      );
    },

    async requestAccess(input) {
      const values = strictValues(
        input,
        new Set([
          "identity",
          "requestId",
          "domainId",
          "agentId",
          "reason",
        ]),
        ["identity", "requestId", "domainId", "agentId", "reason"],
      );
      const currentIdentity = validateIdentity(values.identity);
      const requestId = validateRequestId(values.requestId);
      if (
        !DOMAIN_ID_PATTERN.test(values.domainId)
        || values.domainId === "shared"
        || !PUBLIC_AGENT_ID_PATTERN.test(values.agentId)
        || !validText(values.reason, 2048)
      ) {
        fail("INVALID_REQUEST");
      }
      const candidate = await resolveRequestableCandidate(
        workspaceState,
        authorizer,
        currentIdentity,
        values.domainId,
        values.agentId,
      );
      const now = numericClock(clock);
      for (const entitlementSubject of entitlementSubjects(currentIdentity)) {
        const currentEntitlement = await stateCall(
          workspaceState,
          "getEntitlement",
          entitlementReadInput(entitlementSubject, candidate.ref),
        );
        if (currentEntitlement === null) continue;
        const currentRef = entitlementRef(
          currentEntitlement,
          entitlementSubject,
          now,
        );
        if (currentRef === null || currentRef.foreign) {
          fail("EXPERIENCE_UNAVAILABLE");
        }
        if (currentRef.status === "ACTIVE" && !currentRef.expired) {
          fail("CONFLICT");
        }
      }
      const payload = {
        domainId: values.domainId,
        publicAgentId: values.agentId,
        reason: values.reason,
      };
      const payloadHash = fingerprint(payload);
      const transaction = beginTransaction(workspaceState);
      const approval = {
        domainId: candidate.ref.domainId,
        id: accessApprovalId(
          currentIdentity,
          requestId,
          payloadHash,
        ),
        kind: "RESOURCE_ACCESS",
        resourceType: "AGENT",
        resourceId: candidate.ref.agentId,
        projectId: candidate.ref.projectId,
        status: "PENDING",
        requesterSubject: currentIdentity.actor,
        approverSubject: null,
        reason: values.reason,
        requestedAt: transaction.timestamp,
        decidedAt: null,
      };
      const stored = await stateCall(workspaceState, "putApproval", {
        record: approval,
        expectedStatus: null,
        mutation: accessApprovalMutation({
          identity: currentIdentity,
          requestId,
          payloadHash,
          approval,
          transaction,
        }),
        transaction: transaction.original,
      });
      if (
        !isPlainObject(stored)
        || stored.id !== approval.id
        || stored.status !== "PENDING"
      ) {
        fail("EXPERIENCE_UNAVAILABLE");
      }
      return { id: stored.id, status: stored.status };
    },
  });
}
