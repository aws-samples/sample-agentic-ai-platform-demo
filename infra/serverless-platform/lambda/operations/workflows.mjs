import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PAGE_SIZE = 50;
const MAX_DOMAIN_SCOPES = 100;
const MAX_BREAK_GLASS_MINUTES = 60;

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
const INCIDENT_KEYS = new Set([
  "domainId",
  "projectId",
  "id",
  "title",
  "description",
  "severity",
  "status",
  "ownerSubject",
  "reporterSubject",
  "acknowledgedBySubject",
  "acknowledgedAt",
  "resolvedBySubject",
  "resolvedAt",
  "reopenedBySubject",
  "reopenedAt",
  "lastActionReason",
  "createdAt",
  "updatedAt",
]);
const BREAK_GLASS_KEYS = new Set([
  "id",
  "domainId",
  "projectId",
  "resource",
  "action",
  "status",
  "requesterSubject",
  "reason",
  "requestedAt",
  "expiresAt",
  "approverSubject",
  "decisionReason",
  "decidedAt",
  "activatedBySubject",
  "activationReason",
  "activatedAt",
  "revokedBySubject",
  "revocationReason",
  "revokedAt",
]);
const AUDIT_KEYS = new Set([
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
]);
const STATE_CURSOR_KEYS = new Set(["pk", "sk"]);
const WORKFLOW_CURSOR_KEYS = new Set([
  "v",
  "resource",
  "binding",
  "limit",
  "providerCursor",
  "signature",
]);
const MUTATION_KEYS = new Set([
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
]);
const MUTATION_RESULT_KEYS = new Set([
  "entityType",
  "resourceKey",
  "operation",
  "status",
]);

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

function ownData(value, key, required = true) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return required
      ? { valid: false, value: undefined }
      : { valid: true, present: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    return { valid: false, value: undefined };
  }
  return {
    valid: true,
    present: true,
    value: descriptor.value,
  };
}

function exactSnapshot(value, keys, fail, code) {
  if (!isPlainObject(value)) fail(code);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.size
    || actual.some(
      (key) => typeof key !== "string" || !keys.has(key),
    )
  ) {
    fail(code);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const property = ownData(value, key);
    if (!property.valid) fail(code);
    result[key] = property.value;
  }
  return result;
}

function exactInput(value, keys, fail) {
  return exactSnapshot(value, new Set(keys), fail, "INVALID_REQUEST");
}

function validText(value, maximum, { empty = false } = {}) {
  return (
    typeof value === "string"
    && value.length <= maximum
    && (empty || value.length > 0)
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validDomainId(value) {
  return (
    typeof value === "string"
    && value.length <= 64
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function validSlug(value) {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

function validSubject(value) {
  return (
    typeof value === "string"
    && value.length <= 256
    && SUBJECT_PATTERN.test(value)
  );
}

function validInstant(value) {
  return (
    typeof value === "string"
    && ISO_INSTANT.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
  );
}

function validNullable(value, validator) {
  return value === null || validator(value);
}

function validateAbortSignal(value, fail) {
  if (
    value !== undefined
    && (
      value === null
      || typeof value !== "object"
      || typeof value.aborted !== "boolean"
      || typeof value.addEventListener !== "function"
      || typeof value.removeEventListener !== "function"
    )
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateIdentity(value, fail) {
  const record = exactSnapshot(
    value,
    new Set(["actor", "role", "activeDomain", "domainIds"]),
    fail,
    "INVALID_REQUEST",
  );
  if (
    !validSubject(record.actor)
    || !["admin", "lead", "builder", "user"].includes(record.role)
    || !Array.isArray(record.domainIds)
    || record.domainIds.length > MAX_DOMAIN_SCOPES
    || record.domainIds.some((domainId) => !validDomainId(domainId))
    || new Set(record.domainIds).size !== record.domainIds.length
  ) {
    fail("INVALID_REQUEST");
  }
  if (record.role === "admin") {
    if (
      record.activeDomain !== null
      && !record.domainIds.includes(record.activeDomain)
    ) {
      fail("INVALID_REQUEST");
    }
  } else if (record.role === "lead" || record.role === "builder") {
    if (
      !validDomainId(record.activeDomain)
      || record.domainIds.length !== 1
      || record.domainIds[0] !== record.activeDomain
    ) {
      fail("INVALID_REQUEST");
    }
  } else if (
    record.activeDomain !== null
    || record.domainIds.length !== 0
  ) {
    fail("INVALID_REQUEST");
  }
  return Object.freeze({
    ...record,
    domainIds: Object.freeze([...record.domainIds]),
  });
}

function listRequest(value, fail) {
  if (!isPlainObject(value)) fail("INVALID_REQUEST");
  const allowed = new Set([
    "identity",
    "limit",
    "cursor",
    "abortSignal",
  ]);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.has(key),
    )
    || !Object.hasOwn(value, "identity")
  ) {
    fail("INVALID_REQUEST");
  }
  const identity = validateIdentity(ownData(value, "identity").value, fail);
  const limit = Object.hasOwn(value, "limit")
    ? ownData(value, "limit").value
    : 20;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_PAGE_SIZE
  ) {
    fail("INVALID_REQUEST");
  }
  const abortSignal = Object.hasOwn(value, "abortSignal")
    ? validateAbortSignal(ownData(value, "abortSignal").value, fail)
    : undefined;
  const cursor = Object.hasOwn(value, "cursor")
    ? ownData(value, "cursor").value
    : undefined;
  if (
    cursor !== undefined
    && (
      typeof cursor !== "string"
      || !OPAQUE_CURSOR_PATTERN.test(cursor)
    )
  ) {
    fail("INVALID_REQUEST");
  }
  return { identity, limit, cursor, abortSignal };
}

function validateProject(value, fail) {
  const record = exactSnapshot(
    value,
    PROJECT_KEYS,
    fail,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !validDomainId(record.domainId)
    || !validSlug(record.id)
    || !validText(record.name, 128)
    || !validText(record.description, 4096, { empty: true })
    || !validSubject(record.ownerSubject)
    || !Array.isArray(record.memberSubjects)
    || record.memberSubjects.length > 100
    || record.memberSubjects.some((subject) => !validSubject(subject))
    || new Set(record.memberSubjects).size !== record.memberSubjects.length
    || !["ACTIVE", "ARCHIVED"].includes(record.status)
    || !validSubject(record.createdBySubject)
    || !validInstant(record.createdAt)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({
    ...record,
    memberSubjects: Object.freeze([...record.memberSubjects]),
  });
}

function validateIncident(value, fail) {
  const record = exactSnapshot(
    value,
    INCIDENT_KEYS,
    fail,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !validDomainId(record.domainId)
    || !validSlug(record.projectId)
    || !validSlug(record.id)
    || !validText(record.title, 160)
    || !validText(record.description, 4096)
    || !["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(record.severity)
    || !["OPEN", "ACKNOWLEDGED", "RESOLVED"].includes(record.status)
    || !validSubject(record.ownerSubject)
    || !validSubject(record.reporterSubject)
    || !validNullable(record.acknowledgedBySubject, validSubject)
    || !validNullable(record.acknowledgedAt, validInstant)
    || !validNullable(record.resolvedBySubject, validSubject)
    || !validNullable(record.resolvedAt, validInstant)
    || !validNullable(record.reopenedBySubject, validSubject)
    || !validNullable(record.reopenedAt, validInstant)
    || !validText(record.lastActionReason, 1024)
    || !validInstant(record.createdAt)
    || !validInstant(record.updatedAt)
    || Date.parse(record.createdAt) > Date.parse(record.updatedAt)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  const paired = (left, right) =>
    (left === null && right === null)
    || (left !== null && right !== null);
  if (
    !paired(record.acknowledgedBySubject, record.acknowledgedAt)
    || !paired(record.resolvedBySubject, record.resolvedAt)
    || !paired(record.reopenedBySubject, record.reopenedAt)
    || (
      record.status === "OPEN"
      && (
        record.acknowledgedBySubject !== null
        || record.resolvedBySubject !== null
      )
    )
    || (
      record.status === "ACKNOWLEDGED"
      && (
        record.acknowledgedBySubject === null
        || record.resolvedBySubject !== null
      )
    )
    || (
      record.status === "RESOLVED"
      && (
        record.acknowledgedBySubject === null
        || record.resolvedBySubject === null
      )
    )
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  for (const timestamp of [
    record.acknowledgedAt,
    record.resolvedAt,
    record.reopenedAt,
  ]) {
    if (
      timestamp !== null
      && (
        Date.parse(timestamp) < Date.parse(record.createdAt)
        || Date.parse(timestamp) > Date.parse(record.updatedAt)
      )
    ) {
      fail("OPERATIONS_UNAVAILABLE");
    }
  }
  if (
    record.acknowledgedAt !== null
    && record.resolvedAt !== null
    && Date.parse(record.acknowledgedAt) > Date.parse(record.resolvedAt)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({ ...record });
}

function validateBreakGlass(value, fail) {
  const record = exactSnapshot(
    value,
    BREAK_GLASS_KEYS,
    fail,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !validSlug(record.id)
    || !validDomainId(record.domainId)
    || !validNullable(record.projectId, validSlug)
    || !validText(record.resource, 512)
    || typeof record.action !== "string"
    || !ACTION_PATTERN.test(record.action)
    || ![
      "REQUESTED",
      "APPROVED",
      "REJECTED",
      "ACTIVE",
      "REVOKED",
    ].includes(record.status)
    || !validSubject(record.requesterSubject)
    || !validText(record.reason, 1024)
    || !validInstant(record.requestedAt)
    || !validInstant(record.expiresAt)
    || Date.parse(record.expiresAt) <= Date.parse(record.requestedAt)
    || Date.parse(record.expiresAt) - Date.parse(record.requestedAt)
      < 60_000
    || Date.parse(record.expiresAt) - Date.parse(record.requestedAt)
      > MAX_BREAK_GLASS_MINUTES * 60_000
    || !validNullable(record.approverSubject, validSubject)
    || !validNullable(
      record.decisionReason,
      (item) => validText(item, 1024),
    )
    || !validNullable(record.decidedAt, validInstant)
    || !validNullable(record.activatedBySubject, validSubject)
    || !validNullable(
      record.activationReason,
      (item) => validText(item, 1024),
    )
    || !validNullable(record.activatedAt, validInstant)
    || !validNullable(record.revokedBySubject, validSubject)
    || !validNullable(
      record.revocationReason,
      (item) => validText(item, 1024),
    )
    || !validNullable(record.revokedAt, validInstant)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  const decision = [
    record.approverSubject,
    record.decisionReason,
    record.decidedAt,
  ];
  const activation = [
    record.activatedBySubject,
    record.activationReason,
    record.activatedAt,
  ];
  const revocation = [
    record.revokedBySubject,
    record.revocationReason,
    record.revokedAt,
  ];
  const complete = (values) => values.every((value) => value !== null);
  const empty = (values) => values.every((value) => value === null);
  const decisionComplete = complete(decision);
  const activationComplete = complete(activation);
  const revocationComplete = complete(revocation);
  const decisionEmpty = empty(decision);
  const activationEmpty = empty(activation);
  const revocationEmpty = empty(revocation);
  if (
    (!decisionEmpty && !decisionComplete)
    || (!activationEmpty && !activationComplete)
    || (!revocationEmpty && !revocationComplete)
    || (
      record.status === "REQUESTED"
      && (!decisionEmpty || !activationEmpty || !revocationEmpty)
    )
    || (
      ["APPROVED", "REJECTED"].includes(record.status)
      && (
        !decisionComplete
        || !activationEmpty
        || !revocationEmpty
      )
    )
    || (
      record.status === "ACTIVE"
      && (
        !decisionComplete
        || !activationComplete
        || !revocationEmpty
      )
    )
    || (
      record.status === "REVOKED"
      && (
        !decisionComplete
        || !activationComplete
        || !revocationComplete
      )
    )
    || (
      record.approverSubject !== null
      && record.approverSubject === record.requesterSubject
    )
    || (
      record.activatedBySubject !== null
      && record.activatedBySubject !== record.requesterSubject
    )
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  let previous = Date.parse(record.requestedAt);
  for (const timestamp of [
    record.decidedAt,
    record.activatedAt,
    record.revokedAt,
  ].filter((value) => value !== null)) {
    const current = Date.parse(timestamp);
    if (current < previous || current >= Date.parse(record.expiresAt)) {
      fail("OPERATIONS_UNAVAILABLE");
    }
    previous = current;
  }
  return Object.freeze({ ...record });
}

function validateAudit(value, fail) {
  const record = exactSnapshot(
    value,
    AUDIT_KEYS,
    fail,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !validText(record.resource, 512)
    || !validInstant(record.timestamp)
    || !REQUEST_ID_PATTERN.test(record.requestId)
    || !validSubject(record.actor)
    || !validSubject(record.requesterSubject)
    || !["admin", "lead", "builder", "user"].includes(record.effectiveRole)
    || !ACTION_PATTERN.test(record.action)
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(record.decision)
    || !validText(record.reason, 1024)
    || !validDomainId(record.domainId)
    || !validNullable(record.projectId, validSlug)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({ ...record });
}

function validatePage(value, validator, maximum, fail) {
  const page = exactSnapshot(
    value,
    new Set(["items", "cursor"]),
    fail,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !Array.isArray(page.items)
    || page.items.length > maximum
    || (page.cursor !== null && !isPlainObject(page.cursor))
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({
    items: Object.freeze(page.items.map((item) => validator(item, fail))),
    cursor: page.cursor,
  });
}

function readClock(clock, fail) {
  let value;
  try {
    value = clock();
  } catch {
    fail("OPERATIONS_UNAVAILABLE");
  }
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return milliseconds;
}

function transaction(state, fail) {
  let value;
  try {
    value = state.beginTransaction();
  } catch {
    fail("OPERATIONS_UNAVAILABLE");
  }
  if (
    !isPlainObject(value)
    || !validInstant(value.timestamp)
    || !Number.isSafeInteger(value.epochSeconds)
    || value.epochSeconds !== Math.floor(Date.parse(value.timestamp) / 1000)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return value;
}

async function readState(state, method, input, fail) {
  try {
    return await state[method](input);
  } catch {
    fail("OPERATIONS_UNAVAILABLE");
  }
}

function authorizationRef(resource) {
  return `operations-resource:${Buffer.from(
    JSON.stringify({ v: 1, ...resource }),
    "utf8",
  ).toString("base64url")}`;
}

async function authorize(authorizer, action, identity, resource, fail) {
  let decision;
  try {
    decision = await authorizer({
      requestContext: Object.freeze({
        source: "operations-api",
        subject: identity.actor,
        role: identity.role,
        activeDomain: identity.activeDomain,
        domainIds: Object.freeze([...identity.domainIds]),
      }),
      action,
      resourceRef: authorizationRef(resource),
    });
  } catch (error) {
    if (error?.decision === "NOT_FOUND" || error?.code === "NOT_FOUND") {
      fail("NOT_FOUND");
    }
    fail("FORBIDDEN");
  }
  const allowed = exactSnapshot(
    decision,
    new Set(["ok"]),
    fail,
    "FORBIDDEN",
  );
  if (allowed.ok !== true) fail("FORBIDDEN");
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function cursorBinding(resource, identity, limit) {
  return fingerprint({
    v: 1,
    resource,
    actor: identity.actor,
    role: identity.role,
    activeDomain: identity.activeDomain,
    domainIds: identity.domainIds,
    limit,
  });
}

function cursorSignature(payload, signingKey) {
  return createHmac("sha256", signingKey)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function validCursorSignature(value, expected) {
  return (
    typeof value === "string"
    && FINGERPRINT_PATTERN.test(value)
    && timingSafeEqual(
      Buffer.from(value, "hex"),
      Buffer.from(expected, "hex"),
    )
  );
}

function stateCursor(value, {
  partitionKey,
  sortKeyPrefix,
  anyPartition = false,
}, fail, code) {
  const cursor = exactSnapshot(
    value,
    STATE_CURSOR_KEYS,
    fail,
    code,
  );
  if (
    typeof cursor.pk !== "string"
    || cursor.pk.length === 0
    || cursor.pk.length > 1024
    || typeof cursor.sk !== "string"
    || cursor.sk.length === 0
    || cursor.sk.length > 1024
    || (!anyPartition && cursor.pk !== partitionKey)
    || (
      sortKeyPrefix !== undefined
      && !cursor.sk.startsWith(sortKeyPrefix)
    )
  ) {
    fail(code);
  }
  return Object.freeze({ pk: cursor.pk, sk: cursor.sk });
}

function providerCursor(resource, value, identity, fail, code) {
  if (resource === "audit") {
    return stateCursor(
      value,
      { anyPartition: true },
      fail,
      code,
    );
  }
  if (resource === "break-glass") {
    return stateCursor(
      value,
      {
        partitionKey: "BREAK_GLASS",
        sortKeyPrefix: "BREAK_GLASS#",
      },
      fail,
      code,
    );
  }
  if (resource !== "incidents") fail(code);
  const cursor = exactSnapshot(
    value,
    new Set(["domainIndex", "cursor"]),
    fail,
    code,
  );
  if (
    !Number.isSafeInteger(cursor.domainIndex)
    || cursor.domainIndex < 0
    || cursor.domainIndex >= identity.domainIds.length
    || (
      cursor.cursor !== null
      && !isPlainObject(cursor.cursor)
    )
  ) {
    fail(code);
  }
  const domainId = identity.domainIds[cursor.domainIndex];
  return Object.freeze({
    domainIndex: cursor.domainIndex,
    cursor: cursor.cursor === null
      ? null
      : stateCursor(
          cursor.cursor,
          {
            partitionKey: `INCIDENT#${domainId}`,
            sortKeyPrefix: "INCIDENT#",
          },
          fail,
          code,
        ),
  });
}

function encodeWorkflowCursor({
  resource,
  value,
  identity,
  limit,
  signingKey,
  fail,
}) {
  if (value === null) return null;
  const payload = {
    v: 1,
    resource,
    binding: cursorBinding(resource, identity, limit),
    limit,
    providerCursor: providerCursor(
      resource,
      value,
      identity,
      fail,
      "OPERATIONS_UNAVAILABLE",
    ),
  };
  const encoded = Buffer.from(JSON.stringify({
    ...payload,
    signature: cursorSignature(payload, signingKey),
  })).toString("base64url");
  if (!OPAQUE_CURSOR_PATTERN.test(encoded)) fail("OPERATIONS_UNAVAILABLE");
  return encoded;
}

function decodeWorkflowCursor({
  resource,
  value,
  identity,
  limit,
  signingKey,
  fail,
}) {
  if (value === undefined) return null;
  let parsed;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) fail("NOT_FOUND");
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    fail("NOT_FOUND");
  }
  const cursor = exactSnapshot(
    parsed,
    WORKFLOW_CURSOR_KEYS,
    fail,
    "NOT_FOUND",
  );
  const payload = {
    v: cursor.v,
    resource: cursor.resource,
    binding: cursor.binding,
    limit: cursor.limit,
    providerCursor: cursor.providerCursor,
  };
  if (
    payload.v !== 1
    || payload.resource !== resource
    || payload.binding !== cursorBinding(resource, identity, limit)
    || !FINGERPRINT_PATTERN.test(payload.binding)
    || payload.limit !== limit
    || !validCursorSignature(
      cursor.signature,
      cursorSignature(payload, signingKey),
    )
  ) {
    fail("NOT_FOUND");
  }
  return providerCursor(
    resource,
    payload.providerCursor,
    identity,
    fail,
    "NOT_FOUND",
  );
}

function mutation({
  identity,
  requestId,
  route,
  entityType,
  resourceKey,
  operation,
  domainId,
  projectId,
  decision,
  reason,
  clock,
  payload,
  requesterSubject = identity.actor,
}) {
  return {
    actor: identity.actor,
    requesterSubject,
    effectiveRole: identity.role,
    domainId,
    projectId,
    route,
    requestId,
    payloadFingerprint: fingerprint(payload),
    result: {
      entityType,
      resourceKey,
      operation,
      status: "SUCCEEDED",
    },
    decision,
    reason,
    timestamp: clock.timestamp,
    createdAt: clock.timestamp,
  };
}

function validateCompletedMutation(value, expected, fail) {
  const record = exactSnapshot(
    value,
    MUTATION_KEYS,
    fail,
    "OPERATIONS_UNAVAILABLE",
  );
  const result = exactSnapshot(
    record.result,
    MUTATION_RESULT_KEYS,
    fail,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !validSubject(record.actor)
    || !validSubject(record.requesterSubject)
    || !["admin", "lead", "builder", "user"].includes(record.effectiveRole)
    || !validDomainId(record.domainId)
    || !validNullable(record.projectId, validSlug)
    || typeof record.route !== "string"
    || record.route.length === 0
    || record.route.length > 263
    || !REQUEST_ID_PATTERN.test(record.requestId)
    || !FINGERPRINT_PATTERN.test(record.payloadFingerprint)
    || typeof result.entityType !== "string"
    || !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.entityType)
    || !validText(result.resourceKey, 512)
    || !["CREATE", "UPDATE", "APPEND"].includes(result.operation)
    || result.status !== "SUCCEEDED"
    || typeof record.decision !== "string"
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(record.decision)
    || !validText(record.reason, 1024)
    || !validInstant(record.timestamp)
    || record.createdAt !== record.timestamp
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  const mismatch = (
    record.actor !== expected.identity.actor
    || record.effectiveRole !== expected.identity.role
    || record.route !== expected.route
    || record.requestId !== expected.requestId
    || record.payloadFingerprint !== expected.payloadFingerprint
    || result.entityType !== expected.entityType
    || result.operation !== expected.operation
    || record.decision !== expected.decision
    || record.reason !== expected.reason
    || (
      Object.hasOwn(expected, "domainId")
      && record.domainId !== expected.domainId
    )
    || (
      Object.hasOwn(expected, "projectId")
      && record.projectId !== expected.projectId
    )
    || (
      Object.hasOwn(expected, "requesterSubject")
      && record.requesterSubject !== expected.requesterSubject
    )
    || (
      Object.hasOwn(expected, "resourceKey")
      && result.resourceKey !== expected.resourceKey
    )
  );
  if (mismatch) fail("CONFLICT");
  return Object.freeze({
    ...record,
    result: Object.freeze({ ...result }),
  });
}

async function completedMutation(state, expected, fail) {
  const stored = await readState(
    state,
    "getMutationResult",
    {
      actor: expected.identity.actor,
      route: expected.route,
      requestId: expected.requestId,
    },
    fail,
  );
  return stored === null
    ? null
    : validateCompletedMutation(stored, expected, fail);
}

function incidentMutationResource(value, expectedId, identity, fail) {
  const parts = value.split("/");
  if (
    parts.length !== 4
    || parts[0] !== "incident"
    || !validDomainId(parts[1])
    || !validSlug(parts[2])
    || parts[3] !== expectedId
    || !validSlug(parts[3])
    || !identity.domainIds.includes(parts[1])
    || (
      identity.role === "lead"
      && identity.activeDomain !== parts[1]
    )
  ) {
    fail("CONFLICT");
  }
  return Object.freeze({
    domainId: parts[1],
    projectId: parts[2],
    incidentId: parts[3],
  });
}

async function replayIncident(state, completed, incidentId, fail) {
  const ref = incidentMutationResource(
    completed.result.resourceKey,
    incidentId,
    {
      actor: completed.actor,
      role: completed.effectiveRole,
      activeDomain: completed.effectiveRole === "admin"
        ? null
        : completed.domainId,
      domainIds: [completed.domainId],
    },
    fail,
  );
  if (
    completed.domainId !== ref.domainId
    || completed.projectId !== ref.projectId
  ) {
    fail("CONFLICT");
  }
  const record = validateIncident(
    await readState(
      state,
      "getIncident",
      {
        domainId: ref.domainId,
        incidentId: ref.incidentId,
      },
      fail,
    ),
    fail,
  );
  if (
    record.domainId !== ref.domainId
    || record.projectId !== ref.projectId
    || record.id !== ref.incidentId
    || record.reporterSubject !== completed.requesterSubject
    || (
      completed.decision === "report"
      && (
        record.reporterSubject !== completed.actor
        || record.createdAt !== completed.timestamp
      )
    )
  ) {
    fail("CONFLICT");
  }
  return record;
}

function replayIncidentAction(record, completed, incidentId, fail) {
  const ref = incidentMutationResource(
    completed.result.resourceKey,
    incidentId,
    {
      actor: completed.actor,
      role: completed.effectiveRole,
      activeDomain: completed.effectiveRole === "admin"
        ? null
        : completed.domainId,
      domainIds: [completed.domainId],
    },
    fail,
  );
  const actionAt = Date.parse(completed.timestamp);
  if (
    completed.domainId !== ref.domainId
    || completed.projectId !== ref.projectId
    || record.domainId !== ref.domainId
    || record.projectId !== ref.projectId
    || record.id !== ref.incidentId
    || record.reporterSubject !== completed.requesterSubject
    || Date.parse(record.createdAt) > actionAt
    || Date.parse(record.updatedAt) < actionAt
  ) {
    fail("CONFLICT");
  }
  const priorReopenMatches = (
    record.reopenedAt === null
    || Date.parse(record.reopenedAt) <= actionAt
  );
  let replay;
  if (completed.decision === "acknowledge") {
    if (
      record.acknowledgedBySubject !== completed.actor
      || record.acknowledgedAt !== completed.timestamp
      || !priorReopenMatches
    ) {
      fail("CONFLICT");
    }
    replay = {
      ...record,
      status: "ACKNOWLEDGED",
      acknowledgedBySubject: completed.actor,
      acknowledgedAt: completed.timestamp,
      resolvedBySubject: null,
      resolvedAt: null,
      lastActionReason: completed.reason,
      updatedAt: completed.timestamp,
    };
  } else if (completed.decision === "resolve") {
    if (
      record.acknowledgedBySubject === null
      || record.acknowledgedAt === null
      || Date.parse(record.acknowledgedAt) > actionAt
      || record.resolvedBySubject !== completed.actor
      || record.resolvedAt !== completed.timestamp
      || !priorReopenMatches
    ) {
      fail("CONFLICT");
    }
    replay = {
      ...record,
      status: "RESOLVED",
      resolvedBySubject: completed.actor,
      resolvedAt: completed.timestamp,
      lastActionReason: completed.reason,
      updatedAt: completed.timestamp,
    };
  } else if (completed.decision === "reopen") {
    if (
      record.reopenedBySubject !== completed.actor
      || record.reopenedAt !== completed.timestamp
    ) {
      fail("CONFLICT");
    }
    replay = {
      ...record,
      status: "OPEN",
      acknowledgedBySubject: null,
      acknowledgedAt: null,
      resolvedBySubject: null,
      resolvedAt: null,
      reopenedBySubject: completed.actor,
      reopenedAt: completed.timestamp,
      lastActionReason: completed.reason,
      updatedAt: completed.timestamp,
    };
  } else {
    fail("CONFLICT");
  }
  return validateIncident(replay, fail);
}

async function replayBreakGlass(state, completed, id, fail) {
  if (completed.result.resourceKey !== `break-glass/${id}`) {
    fail("CONFLICT");
  }
  const record = validateBreakGlass(
    await readState(
      state,
      "getBreakGlass",
      { breakGlassId: id },
      fail,
    ),
    fail,
  );
  if (
    record.id !== id
    || record.domainId !== completed.domainId
    || record.projectId !== completed.projectId
    || record.requesterSubject !== completed.requesterSubject
  ) {
    fail("CONFLICT");
  }
  const evidence = {
    request:
      record.requestedAt === completed.timestamp
      && record.requesterSubject === completed.actor,
    approve:
      record.approverSubject === completed.actor
      && record.decisionReason === completed.reason
      && record.decidedAt === completed.timestamp,
    reject:
      record.approverSubject === completed.actor
      && record.decisionReason === completed.reason
      && record.decidedAt === completed.timestamp,
    activate:
      record.activatedBySubject === completed.actor
      && record.activationReason === completed.reason
      && record.activatedAt === completed.timestamp,
    revoke:
      record.revokedBySubject === completed.actor
      && record.revocationReason === completed.reason
      && record.revokedAt === completed.timestamp,
  }[completed.decision];
  if (evidence !== true) fail("CONFLICT");
  return record;
}

function stateConflict(error) {
  return (
    typeof error?.code === "string"
    && (
      error.code.includes("CONFLICT")
      || error.code.includes("TRANSITION")
    )
  );
}

async function writeStateWithReplay(
  state,
  method,
  input,
  expected,
  replay,
  fail,
) {
  try {
    return await state[method](input);
  } catch (error) {
    if (error?.code === "REQUESTER_CANNOT_APPROVE") {
      fail("REQUESTER_CANNOT_APPROVE");
    }
    if (!stateConflict(error)) fail("OPERATIONS_UNAVAILABLE");
  }
  const completed = await completedMutation(state, expected, fail);
  if (completed === null) fail("CONFLICT");
  return replay(completed);
}

function validateRequestId(value, fail) {
  if (
    typeof value !== "string"
    || !REQUEST_ID_PATTERN.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

async function projectFor(state, domainId, projectId, fail) {
  const value = await readState(
    state,
    "getProject",
    { domainId, projectId },
    fail,
  );
  if (value === null) fail("NOT_FOUND");
  const project = validateProject(value, fail);
  if (
    project.domainId !== domainId
    || project.id !== projectId
    || project.status !== "ACTIVE"
  ) {
    fail("NOT_FOUND");
  }
  return project;
}

function collectionResource(type, identity, domainId = null) {
  return {
    type,
    id: `${type}-collection`,
    domainId: domainId ?? "platform",
    projectId: "collection",
    ownerSubject: identity.actor,
    lifecycleState: "ACTIVE",
  };
}

function incidentResource(record) {
  return {
    type: "incident",
    id: record.id,
    domainId: record.domainId,
    projectId: record.projectId,
    ownerSubject: record.ownerSubject,
    lifecycleState: record.status,
  };
}

function breakGlassResource(record) {
  return {
    type: "break-glass",
    id: record.id,
    domainId: record.domainId,
    projectId: record.projectId ?? "domain",
    ownerSubject: record.requesterSubject,
    lifecycleState: record.status,
  };
}

function publicScope(identity) {
  return identity.role === "admin"
    ? Object.freeze({ type: "platform" })
    : identity.role === "lead"
      ? Object.freeze({
          type: "domain",
          domainId: identity.activeDomain,
        })
      : Object.freeze({
          type: "owned-projects",
          domainId: identity.activeDomain,
        });
}

function effectiveBreakGlass(record, now) {
  const expirable = new Set(["REQUESTED", "APPROVED", "ACTIVE"]);
  return Object.freeze({
    ...record,
    effectiveStatus:
      expirable.has(record.status)
      && Date.parse(record.expiresAt) <= now
        ? "EXPIRED"
        : record.status,
  });
}

export function createOperationsWorkflowService({
  workspaceState,
  authorizer,
  clock,
  cursorSigningKey,
  fail,
} = {}) {
  const requiredStateMethods = [
    "beginTransaction",
    "getMutationResult",
    "getProject",
    "listIncidents",
    "getIncident",
    "putIncident",
    "listAuditMetadata",
    "listBreakGlass",
    "getBreakGlass",
    "putBreakGlass",
  ];
  if (
    !workspaceState
    || requiredStateMethods.some(
      (method) => typeof workspaceState[method] !== "function",
    )
    || typeof authorizer !== "function"
    || typeof clock !== "function"
    || !Buffer.isBuffer(cursorSigningKey)
    || cursorSigningKey.length < 32
    || typeof fail !== "function"
  ) {
    throw new TypeError(
      "Operations workflow service configuration is invalid.",
    );
  }

  async function incidentById(identity, incidentId) {
    const matches = [];
    for (const domainId of identity.role === "admin"
      ? identity.domainIds
      : [identity.activeDomain]) {
      const value = await readState(
        workspaceState,
        "getIncident",
        { domainId, incidentId },
        fail,
      );
      if (value !== null) matches.push(validateIncident(value, fail));
    }
    if (matches.length !== 1) fail("NOT_FOUND");
    return matches[0];
  }

  async function grantById(id) {
    const value = await readState(
      workspaceState,
      "getBreakGlass",
      { breakGlassId: id },
      fail,
    );
    if (value === null) fail("NOT_FOUND");
    return validateBreakGlass(value, fail);
  }

  function adminIdentity(value) {
    const identity = validateIdentity(value, fail);
    if (identity.role !== "admin") fail("FORBIDDEN");
    return identity;
  }

  return Object.freeze({
    async listAudit(input) {
      const request = listRequest(input, fail);
      if (!["admin", "lead"].includes(request.identity.role)) {
        fail("FORBIDDEN");
      }
      const cursor = decodeWorkflowCursor({
        resource: "audit",
        value: request.cursor,
        identity: request.identity,
        limit: request.limit,
        signingKey: cursorSigningKey,
        fail,
      });
      await authorize(
        authorizer,
        "workspace.audit.read",
        request.identity,
        collectionResource(
          "audit",
          request.identity,
          request.identity.activeDomain,
        ),
        fail,
      );
      const page = validatePage(
        await readState(
          workspaceState,
          "listAuditMetadata",
          {
            ...(request.identity.role === "lead"
              ? { domainId: request.identity.activeDomain }
              : {}),
            limit: request.limit,
            ...(cursor ? { cursor } : {}),
            ...(request.abortSignal
              ? { abortSignal: request.abortSignal }
              : {}),
          },
          fail,
        ),
        validateAudit,
        request.limit,
        fail,
      );
      if (
        page.items.some((record) =>
          request.identity.role === "lead"
          && record.domainId !== request.identity.activeDomain)
      ) {
        fail("OPERATIONS_UNAVAILABLE");
      }
      return Object.freeze({
        scope: publicScope(request.identity),
        items: page.items,
        cursor: encodeWorkflowCursor({
          resource: "audit",
          value: page.cursor,
          identity: request.identity,
          limit: request.limit,
          signingKey: cursorSigningKey,
          fail,
        }),
      });
    },

    async listIncidents(input) {
      const request = listRequest(input, fail);
      if (request.identity.role === "user") fail("FORBIDDEN");
      const decodedCursor = decodeWorkflowCursor({
        resource: "incidents",
        value: request.cursor,
        identity: request.identity,
        limit: request.limit,
        signingKey: cursorSigningKey,
        fail,
      });
      await authorize(
        authorizer,
        "workspace.incidents.read",
        request.identity,
        collectionResource(
          "incidents",
          request.identity,
          request.identity.activeDomain,
        ),
        fail,
      );
      const items = [];
      let domainIndex = decodedCursor?.domainIndex ?? 0;
      let currentCursor = decodedCursor?.cursor ?? undefined;
      let nextCursor = null;
      while (
        domainIndex < request.identity.domainIds.length
        && items.length < request.limit
      ) {
        const domainId = request.identity.domainIds[domainIndex];
        const page = validatePage(
          await readState(
            workspaceState,
            "listIncidents",
            {
              domainId,
              ...(request.identity.role === "builder"
                ? { ownerSubject: request.identity.actor }
                : {}),
              limit: request.limit - items.length,
              ...(currentCursor ? { cursor: currentCursor } : {}),
              ...(request.abortSignal
                ? { abortSignal: request.abortSignal }
                : {}),
            },
            fail,
          ),
          validateIncident,
          request.limit - items.length,
          fail,
        );
        for (const record of page.items) {
          if (
            record.domainId !== domainId
            || (
              request.identity.role === "builder"
              && record.ownerSubject !== request.identity.actor
            )
          ) {
            fail("OPERATIONS_UNAVAILABLE");
          }
          items.push(record);
        }
        if (page.cursor !== null) {
          nextCursor = {
            domainIndex,
            cursor: page.cursor,
          };
          break;
        }
        domainIndex += 1;
        currentCursor = undefined;
        if (
          items.length === request.limit
          && domainIndex < request.identity.domainIds.length
        ) {
          nextCursor = {
            domainIndex,
            cursor: null,
          };
        }
      }
      items.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
        || left.id.localeCompare(right.id));
      return Object.freeze({
        scope: publicScope(request.identity),
        items: Object.freeze(items),
        cursor: encodeWorkflowCursor({
          resource: "incidents",
          value: nextCursor,
          identity: request.identity,
          limit: request.limit,
          signingKey: cursorSigningKey,
          fail,
        }),
      });
    },

    async createIncident(input) {
      const value = exactInput(input, [
        "identity",
        "requestId",
        "domainId",
        "projectId",
        "id",
        "title",
        "description",
        "severity",
        "reason",
      ], fail);
      const identity = validateIdentity(value.identity, fail);
      if (!["admin", "lead"].includes(identity.role)) fail("FORBIDDEN");
      validateRequestId(value.requestId, fail);
      if (
        !validDomainId(value.domainId)
        || !validSlug(value.projectId)
        || !validSlug(value.id)
        || !validText(value.title, 160)
        || !validText(value.description, 4096)
        || !["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(value.severity)
        || !validText(value.reason, 1024)
      ) {
        fail("INVALID_REQUEST");
      }
      if (
        !identity.domainIds.includes(value.domainId)
        || (
          identity.role === "lead"
          && value.domainId !== identity.activeDomain
        )
      ) {
        fail("NOT_FOUND");
      }
      const payload = {
        domainId: value.domainId,
        projectId: value.projectId,
        id: value.id,
        title: value.title,
        description: value.description,
        severity: value.severity,
        reason: value.reason,
      };
      const expectedMutation = {
        identity,
        requestId: value.requestId,
        route: "POST /api/incidents",
        payloadFingerprint: fingerprint(payload),
        entityType: "INCIDENT",
        operation: "CREATE",
        domainId: value.domainId,
        projectId: value.projectId,
        requesterSubject: identity.actor,
        resourceKey:
          `incident/${value.domainId}/${value.projectId}/${value.id}`,
        decision: "report",
        reason: value.reason,
      };
      const completed = await completedMutation(
        workspaceState,
        expectedMutation,
        fail,
      );
      if (completed !== null) {
        return Object.freeze({
          incident: await replayIncident(
            workspaceState,
            completed,
            value.id,
            fail,
          ),
        });
      }
      const project = await projectFor(
        workspaceState,
        value.domainId,
        value.projectId,
        fail,
      );
      await authorize(
        authorizer,
        "workspace.incidents.create",
        identity,
        {
          type: "project",
          id: project.id,
          domainId: project.domainId,
          projectId: project.id,
          ownerSubject: project.ownerSubject,
          lifecycleState: project.status,
        },
        fail,
      );
      const tx = transaction(workspaceState, fail);
      const record = validateIncident({
        domainId: project.domainId,
        projectId: project.id,
        id: value.id,
        title: value.title,
        description: value.description,
        severity: value.severity,
        status: "OPEN",
        ownerSubject: project.ownerSubject,
        reporterSubject: identity.actor,
        acknowledgedBySubject: null,
        acknowledgedAt: null,
        resolvedBySubject: null,
        resolvedAt: null,
        reopenedBySubject: null,
        reopenedAt: null,
        lastActionReason: value.reason,
        createdAt: tx.timestamp,
        updatedAt: tx.timestamp,
      }, fail);
      const saved = await writeStateWithReplay(
        workspaceState,
        "putIncident",
        {
          record,
          expectedStatus: null,
          mutation: mutation({
            identity,
            requestId: value.requestId,
            route: "POST /api/incidents",
            entityType: "INCIDENT",
            resourceKey:
              `incident/${record.domainId}/${record.projectId}/${record.id}`,
            operation: "CREATE",
            domainId: record.domainId,
            projectId: record.projectId,
            decision: "report",
            reason: record.lastActionReason,
            clock: tx,
            payload,
          }),
          transaction: tx,
        },
        expectedMutation,
        (stored) => replayIncident(
          workspaceState,
          stored,
          value.id,
          fail,
        ),
        fail,
      );
      return Object.freeze({
        incident: validateIncident(saved, fail),
      });
    },

    async actOnIncident(input) {
      const value = exactInput(input, [
        "identity",
        "requestId",
        "incidentId",
        "action",
        "reason",
      ], fail);
      const identity = validateIdentity(value.identity, fail);
      if (!["admin", "lead"].includes(identity.role)) fail("FORBIDDEN");
      validateRequestId(value.requestId, fail);
      if (
        !validSlug(value.incidentId)
        || !["acknowledge", "resolve", "reopen"].includes(value.action)
        || !validText(value.reason, 1024)
      ) {
        fail("INVALID_REQUEST");
      }
      const payload = {
        incidentId: value.incidentId,
        action: value.action,
        reason: value.reason,
      };
      const expectedMutation = {
        identity,
        requestId: value.requestId,
        route: "POST /api/incidents/{id}/actions",
        payloadFingerprint: fingerprint(payload),
        entityType: "INCIDENT",
        operation: "UPDATE",
        decision: value.action,
        reason: value.reason,
        ...(identity.role === "lead"
          ? { domainId: identity.activeDomain }
          : {}),
      };
      const completed = await completedMutation(
        workspaceState,
        expectedMutation,
        fail,
      );
      const currentIncident = async () => {
        const current = await incidentById(identity, value.incidentId);
        if (
          identity.role === "lead"
          && current.domainId !== identity.activeDomain
        ) {
          fail("NOT_FOUND");
        }
        return current;
      };
      const authorizeIncidentAction = async (current) => {
        await authorize(
          authorizer,
          `workspace.incidents.${value.action}`,
          identity,
          incidentResource(current),
          fail,
        );
      };
      const replayAction = async (stored) => {
        const current = await currentIncident();
        await authorizeIncidentAction(current);
        return replayIncidentAction(
          current,
          stored,
          value.incidentId,
          fail,
        );
      };
      if (completed !== null) {
        return Object.freeze({
          incident: await replayAction(completed),
        });
      }
      const current = await currentIncident();
      const expected = {
        acknowledge: "OPEN",
        resolve: "ACKNOWLEDGED",
        reopen: "RESOLVED",
      }[value.action];
      if (current.status !== expected) fail("CONFLICT");
      await authorizeIncidentAction(current);
      const tx = transaction(workspaceState, fail);
      const record = validateIncident({
        ...current,
        status: value.action === "acknowledge"
          ? "ACKNOWLEDGED"
          : value.action === "resolve"
            ? "RESOLVED"
            : "OPEN",
        acknowledgedBySubject: value.action === "acknowledge"
          ? identity.actor
          : value.action === "reopen"
            ? null
            : current.acknowledgedBySubject,
        acknowledgedAt: value.action === "acknowledge"
          ? tx.timestamp
          : value.action === "reopen"
            ? null
            : current.acknowledgedAt,
        resolvedBySubject: value.action === "resolve"
          ? identity.actor
          : value.action === "reopen"
            ? null
            : current.resolvedBySubject,
        resolvedAt: value.action === "resolve"
          ? tx.timestamp
          : value.action === "reopen"
            ? null
            : current.resolvedAt,
        reopenedBySubject: value.action === "reopen"
          ? identity.actor
          : current.reopenedBySubject,
        reopenedAt: value.action === "reopen"
          ? tx.timestamp
          : current.reopenedAt,
        lastActionReason: value.reason,
        updatedAt: tx.timestamp,
      }, fail);
      const saved = await writeStateWithReplay(
        workspaceState,
        "putIncident",
        {
          record,
          expectedStatus: current.status,
          mutation: mutation({
            identity,
            requestId: value.requestId,
            route: "POST /api/incidents/{id}/actions",
            entityType: "INCIDENT",
            resourceKey:
              `incident/${record.domainId}/${record.projectId}/${record.id}`,
            operation: "UPDATE",
            domainId: record.domainId,
            projectId: record.projectId,
            decision: value.action,
            reason: value.reason,
            clock: tx,
            payload,
            requesterSubject: record.reporterSubject,
          }),
          transaction: tx,
        },
        expectedMutation,
        replayAction,
        fail,
      );
      return Object.freeze({
        incident: validateIncident(saved, fail),
      });
    },

    async requestBreakGlass(input) {
      const value = exactInput(input, [
        "identity",
        "requestId",
        "id",
        "domainId",
        "projectId",
        "resource",
        "action",
        "reason",
        "durationMinutes",
      ], fail);
      const identity = adminIdentity(value.identity);
      validateRequestId(value.requestId, fail);
      if (
        !validSlug(value.id)
        || !validDomainId(value.domainId)
        || !identity.domainIds.includes(value.domainId)
        || !validNullable(value.projectId, validSlug)
        || !validText(value.resource, 512)
        || typeof value.action !== "string"
        || !ACTION_PATTERN.test(value.action)
        || !validText(value.reason, 1024)
        || !Number.isSafeInteger(value.durationMinutes)
        || value.durationMinutes < 1
        || value.durationMinutes > MAX_BREAK_GLASS_MINUTES
      ) {
        fail("INVALID_REQUEST");
      }
      const payload = {
        id: value.id,
        domainId: value.domainId,
        projectId: value.projectId,
        resource: value.resource,
        action: value.action,
        reason: value.reason,
        durationMinutes: value.durationMinutes,
      };
      const expectedMutation = {
        identity,
        requestId: value.requestId,
        route: "POST /api/break-glass/requests",
        payloadFingerprint: fingerprint(payload),
        entityType: "BREAK_GLASS",
        operation: "CREATE",
        domainId: value.domainId,
        projectId: value.projectId,
        requesterSubject: identity.actor,
        resourceKey: `break-glass/${value.id}`,
        decision: "request",
        reason: value.reason,
      };
      const completed = await completedMutation(
        workspaceState,
        expectedMutation,
        fail,
      );
      if (completed !== null) {
        return Object.freeze({
          breakGlass: await replayBreakGlass(
            workspaceState,
            completed,
            value.id,
            fail,
          ),
        });
      }
      if (value.projectId !== null) {
        await projectFor(
          workspaceState,
          value.domainId,
          value.projectId,
          fail,
        );
      }
      const pending = {
        id: value.id,
        domainId: value.domainId,
        projectId: value.projectId,
        resource: value.resource,
        action: value.action,
        requesterSubject: identity.actor,
        status: "REQUESTED",
      };
      await authorize(
        authorizer,
        "workspace.break-glass.request",
        identity,
        breakGlassResource(pending),
        fail,
      );
      const tx = transaction(workspaceState, fail);
      const record = validateBreakGlass({
        ...pending,
        reason: value.reason,
        requestedAt: tx.timestamp,
        expiresAt: new Date(
          Date.parse(tx.timestamp) + value.durationMinutes * 60_000,
        ).toISOString(),
        approverSubject: null,
        decisionReason: null,
        decidedAt: null,
        activatedBySubject: null,
        activationReason: null,
        activatedAt: null,
        revokedBySubject: null,
        revocationReason: null,
        revokedAt: null,
      }, fail);
      const saved = await writeStateWithReplay(
        workspaceState,
        "putBreakGlass",
        {
          record,
          expectedStatus: null,
          mutation: mutation({
            identity,
            requestId: value.requestId,
            route: "POST /api/break-glass/requests",
            entityType: "BREAK_GLASS",
            resourceKey: `break-glass/${record.id}`,
            operation: "CREATE",
            domainId: record.domainId,
            projectId: record.projectId,
            decision: "request",
            reason: record.reason,
            clock: tx,
            payload,
          }),
          transaction: tx,
        },
        expectedMutation,
        (stored) => replayBreakGlass(
          workspaceState,
          stored,
          value.id,
          fail,
        ),
        fail,
      );
      return Object.freeze({
        breakGlass: validateBreakGlass(saved, fail),
      });
    },

    async decideBreakGlass(input) {
      const value = exactInput(input, [
        "identity",
        "requestId",
        "id",
        "decision",
        "reason",
      ], fail);
      const identity = adminIdentity(value.identity);
      validateRequestId(value.requestId, fail);
      if (
        !validSlug(value.id)
        || !["approve", "reject"].includes(value.decision)
        || !validText(value.reason, 1024)
      ) {
        fail("INVALID_REQUEST");
      }
      const payload = {
        id: value.id,
        decision: value.decision,
        reason: value.reason,
      };
      const expectedMutation = {
        identity,
        requestId: value.requestId,
        route: "POST /api/break-glass/decisions",
        payloadFingerprint: fingerprint(payload),
        entityType: "BREAK_GLASS",
        operation: "UPDATE",
        decision: value.decision,
        reason: value.reason,
      };
      const completed = await completedMutation(
        workspaceState,
        expectedMutation,
        fail,
      );
      if (completed !== null) {
        return Object.freeze({
          breakGlass: await replayBreakGlass(
            workspaceState,
            completed,
            value.id,
            fail,
          ),
        });
      }
      const current = await grantById(value.id);
      if (current.requesterSubject === identity.actor) {
        fail("REQUESTER_CANNOT_APPROVE");
      }
      if (
        current.status !== "REQUESTED"
        || Date.parse(current.expiresAt) <= readClock(clock, fail)
      ) {
        fail("CONFLICT");
      }
      await authorize(
        authorizer,
        "workspace.break-glass.decide",
        identity,
        breakGlassResource(current),
        fail,
      );
      const tx = transaction(workspaceState, fail);
      const record = validateBreakGlass({
        ...current,
        status: value.decision === "approve" ? "APPROVED" : "REJECTED",
        approverSubject: identity.actor,
        decisionReason: value.reason,
        decidedAt: tx.timestamp,
      }, fail);
      const saved = await writeStateWithReplay(
        workspaceState,
        "putBreakGlass",
        {
          record,
          expectedStatus: "REQUESTED",
          mutation: mutation({
            identity,
            requestId: value.requestId,
            route: "POST /api/break-glass/decisions",
            entityType: "BREAK_GLASS",
            resourceKey: `break-glass/${record.id}`,
            operation: "UPDATE",
            domainId: record.domainId,
            projectId: record.projectId,
            decision: value.decision,
            reason: value.reason,
            clock: tx,
            payload,
            requesterSubject: record.requesterSubject,
          }),
          transaction: tx,
        },
        expectedMutation,
        (stored) => replayBreakGlass(
          workspaceState,
          stored,
          value.id,
          fail,
        ),
        fail,
      );
      return Object.freeze({
        breakGlass: validateBreakGlass(saved, fail),
      });
    },

    async activateBreakGlass(input) {
      const value = exactInput(input, [
        "identity",
        "requestId",
        "id",
        "reason",
      ], fail);
      const identity = adminIdentity(value.identity);
      validateRequestId(value.requestId, fail);
      if (!validSlug(value.id) || !validText(value.reason, 1024)) {
        fail("INVALID_REQUEST");
      }
      const payload = {
        id: value.id,
        reason: value.reason,
      };
      const expectedMutation = {
        identity,
        requestId: value.requestId,
        route: "POST /api/break-glass/activations",
        payloadFingerprint: fingerprint(payload),
        entityType: "BREAK_GLASS",
        operation: "UPDATE",
        decision: "activate",
        reason: value.reason,
      };
      const completed = await completedMutation(
        workspaceState,
        expectedMutation,
        fail,
      );
      if (completed !== null) {
        return Object.freeze({
          breakGlass: await replayBreakGlass(
            workspaceState,
            completed,
            value.id,
            fail,
          ),
        });
      }
      const current = await grantById(value.id);
      if (current.requesterSubject !== identity.actor) fail("FORBIDDEN");
      if (
        current.status !== "APPROVED"
        || Date.parse(current.expiresAt) <= readClock(clock, fail)
      ) {
        fail("CONFLICT");
      }
      await authorize(
        authorizer,
        "workspace.break-glass.activate",
        identity,
        breakGlassResource(current),
        fail,
      );
      const tx = transaction(workspaceState, fail);
      const record = validateBreakGlass({
        ...current,
        status: "ACTIVE",
        activatedBySubject: identity.actor,
        activationReason: value.reason,
        activatedAt: tx.timestamp,
      }, fail);
      const saved = await writeStateWithReplay(
        workspaceState,
        "putBreakGlass",
        {
          record,
          expectedStatus: "APPROVED",
          mutation: mutation({
            identity,
            requestId: value.requestId,
            route: "POST /api/break-glass/activations",
            entityType: "BREAK_GLASS",
            resourceKey: `break-glass/${record.id}`,
            operation: "UPDATE",
            domainId: record.domainId,
            projectId: record.projectId,
            decision: "activate",
            reason: value.reason,
            clock: tx,
            payload,
            requesterSubject: record.requesterSubject,
          }),
          transaction: tx,
        },
        expectedMutation,
        (stored) => replayBreakGlass(
          workspaceState,
          stored,
          value.id,
          fail,
        ),
        fail,
      );
      return Object.freeze({
        breakGlass: validateBreakGlass(saved, fail),
      });
    },

    async revokeBreakGlass(input) {
      const value = exactInput(input, [
        "identity",
        "requestId",
        "id",
        "reason",
      ], fail);
      const identity = adminIdentity(value.identity);
      validateRequestId(value.requestId, fail);
      if (!validSlug(value.id) || !validText(value.reason, 1024)) {
        fail("INVALID_REQUEST");
      }
      const payload = {
        id: value.id,
        reason: value.reason,
      };
      const expectedMutation = {
        identity,
        requestId: value.requestId,
        route: "POST /api/break-glass/revocations",
        payloadFingerprint: fingerprint(payload),
        entityType: "BREAK_GLASS",
        operation: "UPDATE",
        decision: "revoke",
        reason: value.reason,
      };
      const completed = await completedMutation(
        workspaceState,
        expectedMutation,
        fail,
      );
      if (completed !== null) {
        return Object.freeze({
          breakGlass: await replayBreakGlass(
            workspaceState,
            completed,
            value.id,
            fail,
          ),
        });
      }
      const current = await grantById(value.id);
      if (
        current.status !== "ACTIVE"
        || Date.parse(current.expiresAt) <= readClock(clock, fail)
      ) {
        fail("CONFLICT");
      }
      await authorize(
        authorizer,
        "workspace.break-glass.revoke",
        identity,
        breakGlassResource(current),
        fail,
      );
      const tx = transaction(workspaceState, fail);
      const record = validateBreakGlass({
        ...current,
        status: "REVOKED",
        revokedBySubject: identity.actor,
        revocationReason: value.reason,
        revokedAt: tx.timestamp,
      }, fail);
      const saved = await writeStateWithReplay(
        workspaceState,
        "putBreakGlass",
        {
          record,
          expectedStatus: "ACTIVE",
          mutation: mutation({
            identity,
            requestId: value.requestId,
            route: "POST /api/break-glass/revocations",
            entityType: "BREAK_GLASS",
            resourceKey: `break-glass/${record.id}`,
            operation: "UPDATE",
            domainId: record.domainId,
            projectId: record.projectId,
            decision: "revoke",
            reason: value.reason,
            clock: tx,
            payload,
            requesterSubject: record.requesterSubject,
          }),
          transaction: tx,
        },
        expectedMutation,
        (stored) => replayBreakGlass(
          workspaceState,
          stored,
          value.id,
          fail,
        ),
        fail,
      );
      return Object.freeze({
        breakGlass: validateBreakGlass(saved, fail),
      });
    },

    async listBreakGlass(input) {
      const request = listRequest(input, fail);
      const identity = adminIdentity(request.identity);
      const cursor = decodeWorkflowCursor({
        resource: "break-glass",
        value: request.cursor,
        identity,
        limit: request.limit,
        signingKey: cursorSigningKey,
        fail,
      });
      await authorize(
        authorizer,
        "workspace.break-glass.read",
        identity,
        collectionResource("break-glass", identity),
        fail,
      );
      const page = validatePage(
        await readState(
          workspaceState,
          "listBreakGlass",
          {
            limit: request.limit,
            ...(cursor ? { cursor } : {}),
            ...(request.abortSignal
              ? { abortSignal: request.abortSignal }
              : {}),
          },
          fail,
        ),
        validateBreakGlass,
        request.limit,
        fail,
      );
      const now = readClock(clock, fail);
      return Object.freeze({
        scope: Object.freeze({ type: "platform" }),
        items: Object.freeze(
          page.items
            .map((record) => effectiveBreakGlass(record, now))
            .sort((left, right) =>
              right.requestedAt.localeCompare(left.requestedAt)
              || left.id.localeCompare(right.id)),
        ),
        cursor: encodeWorkflowCursor({
          resource: "break-glass",
          value: page.cursor,
          identity,
          limit: request.limit,
          signingKey: cursorSigningKey,
          fail,
        }),
      });
    },
  });
}
