import { createHash } from "node:crypto";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;
const USER_STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const PROJECT_STATUSES = new Set(["ACTIVE", "ARCHIVED"]);
const MAX_DOMAINS = 100;
const MAX_MEMBERS = 50;
const MAX_PROJECTS_PER_PAGE = 100;
const MAX_PROJECT_PAGES = 10;

const ROUTES = Object.freeze({
  domainGrant: "POST /api/access/domain-memberships",
  domainRevoke: "POST /api/access/domain-membership-revocations",
  projectGrant: "POST /api/access/project-memberships",
  projectRevoke: "POST /api/access/project-membership-revocations",
});

const ACTIONS = Object.freeze({
  domainRead: "access.domain-members.read",
  domainGrant: "access.domain-members.grant",
  domainRevoke: "access.domain-members.revoke",
  projectRead: "access.project-members.read",
  projectGrant: "access.project-members.grant",
  projectRevoke: "access.project-members.revoke",
});

const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The access administration request is invalid.",
    retryable: false,
  }),
  FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "The requested access administration action is not allowed.",
    retryable: false,
  }),
  SELF_ELEVATION_FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "Requesters cannot grant access to themselves.",
    retryable: false,
  }),
  NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  }),
  CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The resource state does not permit this access change.",
    retryable: false,
  }),
  IDENTITY_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "The identity directory is temporarily unavailable.",
    retryable: true,
  }),
  ACCESS_ADMIN_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Access administration is temporarily unavailable.",
    retryable: true,
  }),
});

export class AccessAdminServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) {
      throw new TypeError("Access administration error code is invalid.");
    }
    super(detail.message);
    this.name = "AccessAdminServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.retryable;
  }
}

function fail(code) {
  throw new AccessAdminServiceError(code);
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

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size
    && keys.every(
      (key) => {
        if (typeof key !== "string" || !expected.has(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(
          descriptor && Object.hasOwn(descriptor, "value"),
        );
      },
    )
  );
}

function ownValue(value, key) {
  if (!isPlainObject(value)) {
    return { present: false, value: undefined };
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
  ) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

function strictText(value, maximum) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function boundedArray(value, maximum) {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length
    || !Object.hasOwn(length, "value")
    || !Number.isSafeInteger(length.value)
    || length.value < 0
    || length.value > maximum
  ) {
    return null;
  }
  const result = [];
  for (let index = 0; index < length.value; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !Object.hasOwn(item, "value")) return null;
    result.push(item.value);
  }
  return result;
}

function validateIdentity(value) {
  if (
    !exactKeys(
      value,
      new Set(["actor", "role", "activeDomain", "domainIds"]),
    )
    || typeof value.actor !== "string"
    || !SUBJECT_PATTERN.test(value.actor)
    || !ROLES.has(value.role)
  ) {
    fail("INVALID_REQUEST");
  }
  const domainIds = boundedArray(value.domainIds, MAX_DOMAINS);
  if (
    domainIds === null
    || domainIds.some(
      (domainId) =>
        typeof domainId !== "string" || !DOMAIN_PATTERN.test(domainId),
    )
    || new Set(domainIds).size !== domainIds.length
  ) {
    fail("INVALID_REQUEST");
  }
  if (
    value.role === "admin"
    && (
      value.activeDomain !== null
      && !domainIds.includes(value.activeDomain)
    )
  ) {
    fail("INVALID_REQUEST");
  }
  if (
    (value.role === "lead" || value.role === "builder")
    && (
      typeof value.activeDomain !== "string"
      || !DOMAIN_PATTERN.test(value.activeDomain)
      || domainIds.length !== 1
      || domainIds[0] !== value.activeDomain
    )
  ) {
    fail("INVALID_REQUEST");
  }
  if (
    value.role === "user"
    && (value.activeDomain !== null || domainIds.length !== 0)
  ) {
    fail("INVALID_REQUEST");
  }
  return Object.freeze({
    actor: value.actor,
    role: value.role,
    activeDomain: value.activeDomain,
    domainIds: Object.freeze([...domainIds]),
  });
}

function validateLimit(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_MEMBERS
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateCursor(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CURSOR_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateDomainId(value) {
  if (typeof value !== "string" || !DOMAIN_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateProjectId(value) {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateUsername(value) {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateReason(value) {
  if (!strictText(value, 1024) || value.length < 3) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateListInput(value, projectScoped) {
  const allowed = projectScoped
    ? new Set([
        "identity",
        "domainId",
        "projectId",
        "limit",
        "cursor",
      ])
    : new Set(["identity", "domainId", "limit", "cursor"]);
  if (
    !isPlainObject(value)
    || Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.has(key),
    )
    || !Object.hasOwn(value, "identity")
  ) {
    fail("INVALID_REQUEST");
  }
  const identity = validateIdentity(value.identity);
  const domainId = Object.hasOwn(value, "domainId")
    ? validateDomainId(value.domainId)
    : undefined;
  const projectId = projectScoped
    ? validateProjectId(value.projectId)
    : undefined;
  const limit = Object.hasOwn(value, "limit")
    ? validateLimit(value.limit)
    : 20;
  const cursor = Object.hasOwn(value, "cursor")
    ? validateCursor(value.cursor)
    : undefined;
  return {
    identity,
    domainId,
    projectId,
    limit,
    cursor,
  };
}

function validateMutationInput(value, projectScoped) {
  const expected = projectScoped
    ? new Set([
        "identity",
        "requestId",
        "domainId",
        "projectId",
        "username",
        "reason",
      ])
    : new Set([
        "identity",
        "requestId",
        "domainId",
        "username",
        "reason",
      ]);
  if (!exactKeys(value, expected)) fail("INVALID_REQUEST");
  return {
    identity: validateIdentity(value.identity),
    requestId: validateRequestId(value.requestId),
    domainId: validateDomainId(value.domainId),
    ...(projectScoped
      ? { projectId: validateProjectId(value.projectId) }
      : {}),
    username: validateUsername(value.username),
    reason: validateReason(value.reason),
  };
}

function scopedDomain(identity, requestedDomainId) {
  if (identity.role !== "admin" && identity.role !== "lead") {
    fail("FORBIDDEN");
  }
  if (identity.role === "lead") {
    if (
      requestedDomainId !== undefined
      && requestedDomainId !== identity.activeDomain
    ) {
      fail("NOT_FOUND");
    }
    return identity.activeDomain;
  }
  if (
    requestedDomainId === undefined
    || !identity.domainIds.includes(requestedDomainId)
  ) {
    fail("NOT_FOUND");
  }
  return requestedDomainId;
}

function domainGroupName(domainId) {
  return `domain-${domainId.replaceAll("_", "-")}`;
}

function safeDomain(value, expectedDomainId) {
  if (!isPlainObject(value)) fail("ACCESS_ADMIN_UNAVAILABLE");
  const id = ownValue(value, "id");
  const status = ownValue(value, "status");
  if (
    !id.present
    || id.value !== expectedDomainId
    || !status.present
    || typeof status.value !== "string"
  ) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  if (status.value !== "ACTIVE") fail("NOT_FOUND");
  return Object.freeze({
    id: expectedDomainId,
    status: "ACTIVE",
  });
}

async function activeDomain(domainDirectory, domainId) {
  let value;
  try {
    value = await domainDirectory.getDomain(domainId);
  } catch {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  if (value === null || value === undefined) fail("NOT_FOUND");
  return safeDomain(value, domainId);
}

function safeUser(value, expected = {}) {
  if (
    !exactKeys(
      value,
      new Set(["username", "subject", "enabled", "userStatus"]),
    )
    || typeof value.username !== "string"
    || !USERNAME_PATTERN.test(value.username)
    || typeof value.subject !== "string"
    || !SUBJECT_PATTERN.test(value.subject)
    || typeof value.enabled !== "boolean"
    || typeof value.userStatus !== "string"
    || !USER_STATUS_PATTERN.test(value.userStatus)
    || (
      expected.username !== undefined
      && value.username !== expected.username
    )
    || (
      expected.subject !== undefined
      && value.subject !== expected.subject
    )
  ) {
    fail("IDENTITY_UNAVAILABLE");
  }
  return Object.freeze({
    username: value.username,
    subject: value.subject,
    enabled: value.enabled,
    userStatus: value.userStatus,
  });
}

function safeUserPage(value, limit) {
  if (!exactKeys(value, new Set(["items", "cursor"]))) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  const items = boundedArray(value.items, limit);
  if (items === null) fail("ACCESS_ADMIN_UNAVAILABLE");
  const sanitized = items.map((item) => safeUser(item));
  if (
    new Set(sanitized.map(({ username }) => username)).size
      !== sanitized.length
    || new Set(sanitized.map(({ subject }) => subject)).size
      !== sanitized.length
  ) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  const cursor = value.cursor === null
    ? null
    : validateProviderCursor(value.cursor);
  return Object.freeze({
    items: Object.freeze(sanitized),
    cursor,
  });
}

function validateProviderCursor(value) {
  if (typeof value !== "string" || !CURSOR_PATTERN.test(value)) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  return value;
}

function safeSubjectPage(value, limit) {
  if (!exactKeys(value, new Set(["items", "cursor"]))) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  const items = boundedArray(value.items, limit);
  if (
    items === null
    || items.some(
      (subject) =>
        typeof subject !== "string" || !SUBJECT_PATTERN.test(subject),
    )
    || new Set(items).size !== items.length
  ) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  return Object.freeze({
    items: Object.freeze([...items]),
    cursor: value.cursor === null
      ? null
      : validateProviderCursor(value.cursor),
  });
}

function safeProject(value, domainId, projectId) {
  if (!isPlainObject(value)) fail("ACCESS_ADMIN_UNAVAILABLE");
  const recordDomain = ownValue(value, "domainId");
  const id = ownValue(value, "id");
  const owner = ownValue(value, "ownerSubject");
  const members = boundedArray(
    ownValue(value, "memberSubjects").value,
    100,
  );
  const status = ownValue(value, "status");
  if (
    !recordDomain.present
    || recordDomain.value !== domainId
    || !id.present
    || id.value !== projectId
    || !owner.present
    || typeof owner.value !== "string"
    || !SUBJECT_PATTERN.test(owner.value)
    || members === null
    || members.some(
      (subject) =>
        typeof subject !== "string" || !SUBJECT_PATTERN.test(subject),
    )
    || new Set(members).size !== members.length
    || !status.present
    || typeof status.value !== "string"
  ) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  if (status.value !== "ACTIVE") fail("CONFLICT");
  return Object.freeze({
    domainId,
    id: projectId,
    ownerSubject: owner.value,
    memberSubjects: Object.freeze([...members]),
    status: "ACTIVE",
  });
}

function safeDomainProject(value, domainId) {
  if (!isPlainObject(value)) fail("ACCESS_ADMIN_UNAVAILABLE");
  const recordDomain = ownValue(value, "domainId");
  const id = ownValue(value, "id");
  const owner = ownValue(value, "ownerSubject");
  const members = boundedArray(
    ownValue(value, "memberSubjects").value,
    MAX_PROJECTS_PER_PAGE,
  );
  const status = ownValue(value, "status");
  if (
    !recordDomain.present
    || recordDomain.value !== domainId
    || !id.present
    || typeof id.value !== "string"
    || !SLUG_PATTERN.test(id.value)
    || !owner.present
    || typeof owner.value !== "string"
    || !SUBJECT_PATTERN.test(owner.value)
    || members === null
    || members.some(
      (subject) =>
        typeof subject !== "string" || !SUBJECT_PATTERN.test(subject),
    )
    || new Set(members).size !== members.length
    || !status.present
    || !PROJECT_STATUSES.has(status.value)
  ) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  return Object.freeze({
    domainId,
    id: id.value,
    ownerSubject: owner.value,
    memberSubjects: Object.freeze([...members]),
    status: status.value,
  });
}

function safeProjectCursor(value, domainId) {
  if (
    !exactKeys(value, new Set(["pk", "sk"]))
    || value.pk !== `PROJECT#${domainId}`
    || typeof value.sk !== "string"
    || !value.sk.startsWith("PROJECT#")
    || !SLUG_PATTERN.test(value.sk.slice("PROJECT#".length))
  ) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  return Object.freeze({
    pk: value.pk,
    sk: value.sk,
  });
}

function safeDomainProjectPage(value, domainId) {
  if (!exactKeys(value, new Set(["items", "cursor"]))) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  const records = boundedArray(value.items, MAX_PROJECTS_PER_PAGE);
  if (records === null) fail("ACCESS_ADMIN_UNAVAILABLE");
  const items = records.map(
    (record) => safeDomainProject(record, domainId),
  );
  if (
    new Set(items.map(({ id }) => id)).size !== items.length
  ) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  return Object.freeze({
    items: Object.freeze(items),
    cursor: value.cursor === null
      ? null
      : safeProjectCursor(value.cursor, domainId),
  });
}

async function readProject(projectMemberships, domainId, projectId) {
  let value;
  try {
    value = await projectMemberships.getProject({
      domainId,
      projectId,
    });
  } catch {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  if (value === null || value === undefined) fail("NOT_FOUND");
  return safeProject(value, domainId, projectId);
}

async function requireProjectCleanup(
  projectMemberships,
  domainId,
  subject,
) {
  const seenCursors = new Set();
  let previousCursor = null;
  let cursor;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const result = safeDomainProjectPage(
      await projectCall(
        projectMemberships,
        "listProjects",
        {
          domainId,
          limit: MAX_PROJECTS_PER_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        },
      ),
      domainId,
    );
    if (
      result.items.some(
        (record) =>
          record.ownerSubject === subject
          || record.memberSubjects.includes(subject),
      )
    ) {
      fail("CONFLICT");
    }
    if (result.cursor === null) return;
    const marker = `${result.cursor.pk}\u0000${result.cursor.sk}`;
    if (
      seenCursors.has(marker)
      || (previousCursor !== null && marker <= previousCursor)
      || page + 1 >= MAX_PROJECT_PAGES
    ) {
      fail("ACCESS_ADMIN_UNAVAILABLE");
    }
    seenCursors.add(marker);
    previousCursor = marker;
    cursor = result.cursor;
  }
  fail("ACCESS_ADMIN_UNAVAILABLE");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(
        (key) => [key, canonical(value[key])],
      ),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function resourceReference(resource) {
  return `access:${Buffer.from(
    JSON.stringify({ v: 1, ...resource }),
    "utf8",
  ).toString("base64url")}`;
}

async function authorize(authorizer, identity, action, resource) {
  let decision;
  try {
    decision = await authorizer({
      requestContext: Object.freeze({
        source: "access-admin-service",
        subject: identity.actor,
        role: identity.role,
        activeDomain: identity.activeDomain,
        domainIds: Object.freeze([...identity.domainIds]),
      }),
      action,
      resourceRef: resourceReference(resource),
    });
  } catch (error) {
    if (error?.decision === "NOT_FOUND") fail("NOT_FOUND");
    if (error?.decision === "CONFLICT") fail("CONFLICT");
    fail("FORBIDDEN");
  }
  const ok = ownValue(decision, "ok");
  const actorId = ownValue(decision, "actorId");
  const role = ownValue(decision, "role");
  const authorizedAction = ownValue(decision, "action");
  const resourceId = ownValue(decision, "resourceId");
  const usedBreakGlass = ownValue(decision, "usedBreakGlass");
  if (
    !ok.present
    || ok.value !== true
    || !actorId.present
    || actorId.value !== identity.actor
    || !role.present
    || role.value !== identity.role
    || !authorizedAction.present
    || authorizedAction.value !== action
    || !resourceId.present
    || resourceId.value !== resource.id
    || !usedBreakGlass.present
    || typeof usedBreakGlass.value !== "boolean"
  ) {
    fail("FORBIDDEN");
  }
  return Object.freeze({
    ok: true,
    usedBreakGlass: usedBreakGlass.value,
  });
}

function requireMutationBreakGlass(identity, domainId, decision) {
  if (
    identity.role === "admin"
    && domainId !== "platform"
    && decision.usedBreakGlass !== true
  ) {
    fail("FORBIDDEN");
  }
}

async function directoryCall(groupDirectory, method, input) {
  try {
    return await groupDirectory[method](input);
  } catch (error) {
    if (error instanceof AccessAdminServiceError) throw error;
    fail("IDENTITY_UNAVAILABLE");
  }
}

async function projectCall(projectMemberships, method, input) {
  try {
    return await projectMemberships[method](input);
  } catch (error) {
    if (error instanceof AccessAdminServiceError) throw error;
    if (error?.code === "NOT_FOUND") fail("NOT_FOUND");
    if (
      error?.code === "CONFLICT"
      || error?.code === "MUTATION_CONFLICT"
    ) {
      fail("CONFLICT");
    }
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
}

async function resolveUser(groupDirectory, username) {
  const value = await directoryCall(
    groupDirectory,
    "getUser",
    { username },
  );
  if (value === null || value === undefined) fail("NOT_FOUND");
  return safeUser(value, { username });
}

function readClock(clock) {
  let value;
  try {
    value = clock();
  } catch {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  if (!Number.isFinite(value) || value < 0) {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  return new Date(value).toISOString();
}

function safeMutationResult(value, expected) {
  const fields = [
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
    "decision",
    "reason",
    "username",
    "status",
    "result",
  ];
  if (!isPlainObject(value)) fail("CONFLICT");
  const record = Object.create(null);
  for (const field of fields) {
    const property = ownValue(value, field);
    if (!property.present) fail("CONFLICT");
    record[field] = property.value;
  }
  const subject = record.requesterSubject;
  const resourceKey = expected.projectId === null
    ? `domain-membership/${expected.domainId}/${subject}`
    : `project-membership/${expected.domainId}/${expected.projectId}/${subject}`;
  if (
    record.actor !== expected.actor
    || typeof subject !== "string"
    || !SUBJECT_PATTERN.test(subject)
    || record.effectiveRole !== expected.effectiveRole
    || record.domainId !== expected.domainId
    || record.projectId !== expected.projectId
    || record.route !== expected.route
    || record.requestId !== expected.requestId
    || record.payloadFingerprint !== expected.payloadFingerprint
    || record.resourceKey !== resourceKey
    || record.operation !== expected.operation
    || record.decision !== expected.decision
    || record.reason !== expected.reason
    || record.username !== expected.username
    || record.status !== expected.status
    || !exactKeys(
      record.result,
      expected.projectId === null
        ? new Set([
            "domainId",
            "username",
            "subject",
            "status",
            "changed",
          ])
        : new Set([
            "domainId",
            "projectId",
            "username",
            "subject",
            "status",
            "changed",
          ]),
    )
    || record.result.domainId !== expected.domainId
    || record.result.projectId !== (
      expected.projectId === null ? undefined : expected.projectId
    )
    || record.result.username !== expected.username
    || record.result.subject !== subject
    || record.result.status !== expected.status
    || typeof record.result.changed !== "boolean"
  ) {
    fail("CONFLICT");
  }
  return Object.freeze({ ...record.result });
}

async function completedMutation(idempotency, claim) {
  let value;
  try {
    value = await idempotency.getResult({
      actor: claim.actor,
      route: claim.route,
      requestId: claim.requestId,
    });
  } catch {
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
  return value === null ? null : safeMutationResult(value, claim);
}

function requireExactPendingClaim(value, expected) {
  const fields = Object.keys(expected);
  if (!exactKeys(value, new Set(fields))) fail("CONFLICT");
  for (const field of fields) {
    if (ownValue(value, field).value !== expected[field]) {
      fail("CONFLICT");
    }
  }
}

async function claimMutation(idempotency, claim) {
  try {
    const outcome = await idempotency.claim(claim);
    if (outcome === true) return;
    requireExactPendingClaim(outcome, claim);
  } catch (error) {
    if (error instanceof AccessAdminServiceError) throw error;
    if (
      error?.code === "MUTATION_IN_PROGRESS"
      || error?.code === "MUTATION_CONFLICT"
    ) {
      fail("CONFLICT");
    }
    fail("ACCESS_ADMIN_UNAVAILABLE");
  }
}

async function completeMutation({
  audit,
  idempotency,
  claim,
  result,
  timestamp,
  action,
}) {
  const record = {
    resource: claim.resourceKey,
    timestamp,
    requestId: claim.requestId,
    actor: claim.actor,
    requesterSubject: claim.requesterSubject,
    effectiveRole: claim.effectiveRole,
    action,
    decision: claim.decision,
    reason: claim.reason,
    domainId: claim.domainId,
    projectId: claim.projectId,
  };
  let appendFailure = null;
  try {
    if (await audit.append({
      record,
      completion: {
        ...claim,
        result,
      },
    }) !== true) {
      fail("ACCESS_ADMIN_UNAVAILABLE");
    }
    return result;
  } catch (error) {
    appendFailure = error;
  }
  const replay = await completedMutation(idempotency, claim);
  if (replay !== null) return replay;
  if (appendFailure instanceof AccessAdminServiceError) {
    throw appendFailure;
  }
  fail("ACCESS_ADMIN_UNAVAILABLE");
}

function mutationExpectation({
  request,
  route,
  action,
  status,
  operation,
}) {
  const payload = {
    domainId: request.domainId,
    ...(request.projectId
      ? { projectId: request.projectId }
      : {}),
    username: request.username,
    reason: request.reason,
  };
  return Object.freeze({
    actor: request.identity.actor,
    effectiveRole: request.identity.role,
    domainId: request.domainId,
    projectId: request.projectId ?? null,
    route,
    requestId: request.requestId,
    payloadFingerprint: fingerprint(payload),
    operation,
    decision: action.endsWith(".grant") ? "grant" : "revoke",
    reason: request.reason,
    username: request.username,
    status,
  });
}

function mutationClaim(expected, subject) {
  return Object.freeze({
    ...expected,
    requesterSubject: subject,
    resourceKey: expected.projectId
      ? `project-membership/${expected.domainId}/${expected.projectId}/${subject}`
      : `domain-membership/${expected.domainId}/${subject}`,
  });
}

function mutationResult(request, subject, status, changed) {
  return Object.freeze({
    domainId: request.domainId,
    ...(request.projectId
      ? { projectId: request.projectId }
      : {}),
    username: request.username,
    subject,
    status,
    changed,
  });
}

function safeChanged(value, unavailableCode) {
  if (
    !exactKeys(value, new Set(["changed"]))
    || typeof value.changed !== "boolean"
  ) {
    fail(unavailableCode);
  }
  return value.changed;
}

export function createAccessAdminService({
  domainDirectory,
  groupDirectory,
  projectMemberships,
  authorizer,
  clock,
  audit,
  idempotency,
} = {}) {
  if (
    !domainDirectory
    || typeof domainDirectory.getDomain !== "function"
  ) {
    throw new TypeError("Active domain directory is invalid.");
  }
  const groupMethods = [
    "listDomainMembers",
    "getUser",
    "getUserBySubject",
    "isDomainMember",
    "addDomainMember",
    "removeDomainMember",
  ];
  if (
    !groupDirectory
    || groupMethods.some(
      (method) => typeof groupDirectory[method] !== "function",
    )
  ) {
    throw new TypeError("Cognito domain group directory is invalid.");
  }
  const projectMethods = [
    "listProjects",
    "getProject",
    "listProjectMemberSubjects",
    "addProjectMember",
    "removeProjectMember",
  ];
  if (
    !projectMemberships
    || projectMethods.some(
      (method) => typeof projectMemberships[method] !== "function",
    )
  ) {
    throw new TypeError("Project membership adapter is invalid.");
  }
  if (typeof authorizer !== "function") {
    throw new TypeError("Access administration authorizer is invalid.");
  }
  if (typeof clock !== "function") {
    throw new TypeError("Access administration clock is invalid.");
  }
  if (!audit || typeof audit.append !== "function") {
    throw new TypeError("Access administration audit adapter is invalid.");
  }
  const idempotencyMethods = [
    "getResult",
    "claim",
  ];
  if (
    !idempotency
    || idempotencyMethods.some(
      (method) => typeof idempotency[method] !== "function",
    )
  ) {
    throw new TypeError(
      "Access administration idempotency adapter is invalid.",
    );
  }

  async function prepareDomainList(input) {
    const request = validateListInput(input, false);
    const domainId = scopedDomain(
      request.identity,
      request.domainId,
    );
    const domain = await activeDomain(domainDirectory, domainId);
    await authorize(
      authorizer,
      request.identity,
      ACTIONS.domainRead,
      {
        id: `domain-members/${domainId}`,
        domainId,
        lifecycleState: domain.status,
      },
    );
    return { ...request, domainId };
  }

  async function prepareProjectList(input) {
    const request = validateListInput(input, true);
    const domainId = scopedDomain(
      request.identity,
      request.domainId,
    );
    await activeDomain(domainDirectory, domainId);
    const projectRecord = await readProject(
      projectMemberships,
      domainId,
      request.projectId,
    );
    await authorize(
      authorizer,
      request.identity,
      ACTIONS.projectRead,
      {
        id: `project-members/${domainId}/${request.projectId}`,
        domainId,
        projectId: request.projectId,
        ownerId: projectRecord.ownerSubject,
        assigneeIds: projectRecord.memberSubjects,
        lifecycleState: projectRecord.status,
      },
    );
    return { ...request, domainId, projectRecord };
  }

  async function prepareMutation(input, {
    projectScoped,
    action,
  }) {
    const request = validateMutationInput(input, projectScoped);
    const domainId = scopedDomain(
      request.identity,
      request.domainId,
    );
    const normalized = { ...request, domainId };
    const domain = await activeDomain(domainDirectory, domainId);
    let projectRecord = null;
    if (projectScoped) {
      projectRecord = await readProject(
        projectMemberships,
        domainId,
        request.projectId,
      );
    }
    const decision = await authorize(
      authorizer,
      request.identity,
      action,
      projectScoped
        ? {
            id: `project-members/${domainId}/${request.projectId}`,
            domainId,
            projectId: request.projectId,
            ownerId: projectRecord.ownerSubject,
            assigneeIds: projectRecord.memberSubjects,
            lifecycleState: projectRecord.status,
          }
        : {
            id: `domain-members/${domainId}`,
            domainId,
            lifecycleState: domain.status,
          },
    );
    requireMutationBreakGlass(request.identity, domainId, decision);
    return {
      ...normalized,
      projectRecord,
    };
  }

  async function mutate(input, {
    projectScoped,
    action,
    route,
    status,
    operation,
    method,
  }) {
    const request = await prepareMutation(input, {
      projectScoped,
      action,
    });
    const expected = mutationExpectation({
      request,
      route,
      action,
      status,
      operation,
    });
    const replay = await completedMutation(idempotency, expected);
    if (replay !== null) return replay;
    const target = await resolveUser(
      groupDirectory,
      request.username,
    );
    if (
      action.endsWith(".grant")
      && target.subject === request.identity.actor
    ) {
      fail("SELF_ELEVATION_FORBIDDEN");
    }
    if (
      projectScoped
      && action.endsWith(".revoke")
      && target.subject === request.projectRecord.ownerSubject
    ) {
      fail("CONFLICT");
    }
    if (!projectScoped && action === ACTIONS.domainRevoke) {
      await requireProjectCleanup(
        projectMemberships,
        request.domainId,
        target.subject,
      );
    }
    if (projectScoped && action.endsWith(".grant")) {
      const member = await directoryCall(
        groupDirectory,
        "isDomainMember",
        {
          username: target.username,
          subject: target.subject,
          groupName: domainGroupName(request.domainId),
        },
      );
      if (member !== true) fail("NOT_FOUND");
    }
    const claim = mutationClaim(expected, target.subject);
    await claimMutation(idempotency, claim);

    const providerResult = projectScoped
      ? await projectCall(
          projectMemberships,
          method,
          {
            domainId: request.domainId,
            projectId: request.projectId,
            subject: target.subject,
          },
        )
      : await directoryCall(
        groupDirectory,
        method,
        {
          username: target.username,
          subject: target.subject,
          groupName: domainGroupName(request.domainId),
        },
      );
    const changed = safeChanged(
      providerResult,
      projectScoped
        ? "ACCESS_ADMIN_UNAVAILABLE"
        : "IDENTITY_UNAVAILABLE",
    );

    const result = mutationResult(
      request,
      target.subject,
      status,
      changed,
    );
    return completeMutation({
      audit,
      idempotency,
      claim,
      result,
      timestamp: readClock(clock),
      action,
    });
  }

  return Object.freeze({
    async listDomainMembers(input) {
      const request = await prepareDomainList(input);
      const page = safeUserPage(
        await directoryCall(
          groupDirectory,
          "listDomainMembers",
          {
            groupName: domainGroupName(request.domainId),
            limit: request.limit,
            ...(request.cursor
              ? { cursor: request.cursor }
              : {}),
          },
        ),
        request.limit,
      );
      return Object.freeze({
        domainId: request.domainId,
        items: page.items,
        cursor: page.cursor,
      });
    },

    async grantDomainMembership(input) {
      return mutate(input, {
        projectScoped: false,
        action: ACTIONS.domainGrant,
        route: ROUTES.domainGrant,
        status: "ACTIVE",
        operation: "CREATE",
        method: "addDomainMember",
      });
    },

    async revokeDomainMembership(input) {
      return mutate(input, {
        projectScoped: false,
        action: ACTIONS.domainRevoke,
        route: ROUTES.domainRevoke,
        status: "REVOKED",
        operation: "DELETE",
        method: "removeDomainMember",
      });
    },

    async listProjectMembers(input) {
      const request = await prepareProjectList(input);
      const page = safeSubjectPage(
        await projectCall(
          projectMemberships,
          "listProjectMemberSubjects",
          {
            domainId: request.domainId,
            projectId: request.projectId,
            limit: request.limit,
            ...(request.cursor
              ? { cursor: request.cursor }
              : {}),
          },
        ),
        request.limit,
      );
      if (
        page.items.some(
          (subject) =>
            !request.projectRecord.memberSubjects.includes(subject),
        )
      ) {
        fail("ACCESS_ADMIN_UNAVAILABLE");
      }
      const items = [];
      for (const subject of page.items) {
        const current = await directoryCall(
          groupDirectory,
          "getUserBySubject",
          { subject },
        );
        if (current === null || current === undefined) {
          fail("IDENTITY_UNAVAILABLE");
        }
        items.push(safeUser(current, { subject }));
      }
      if (
        new Set(items.map(({ username }) => username)).size
          !== items.length
      ) {
        fail("IDENTITY_UNAVAILABLE");
      }
      return Object.freeze({
        domainId: request.domainId,
        projectId: request.projectId,
        items: Object.freeze(items),
        cursor: page.cursor,
      });
    },

    async grantProjectMembership(input) {
      return mutate(input, {
        projectScoped: true,
        action: ACTIONS.projectGrant,
        route: ROUTES.projectGrant,
        status: "ACTIVE",
        operation: "UPDATE",
        method: "addProjectMember",
      });
    },

    async revokeProjectMembership(input) {
      return mutate(input, {
        projectScoped: true,
        action: ACTIONS.projectRevoke,
        route: ROUTES.projectRevoke,
        status: "REVOKED",
        operation: "UPDATE",
        method: "removeProjectMember",
      });
    },
  });
}
