import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  createOperationsWorkflowService,
} from "./workflows.mjs";
import { JOURNAL_USAGE_KEYS, NATIVE_USAGE_KEYS } from "./journal-usage.mjs";
import { publicProjectBudget } from "./budgets.mjs";

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/;
const PROVIDER_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PAGE_SIZE = 50;
const STATE_PAGE_SIZE = 100;
const MAX_PROJECT_PAGES_PER_DOMAIN = 10;
const MAX_SCOPED_PROJECTS = 500;
const MAX_DOMAIN_SCOPES = 100;
const MAX_MEMBERS = 100;
const MAX_BUDGETS = 500;
const MONTH_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const WINDOWS = Object.freeze({
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": MONTH_MILLISECONDS,
});

const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The operations request is invalid.",
    retryable: false,
  }),
  FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "The requested operation is not allowed.",
    retryable: false,
  }),
  NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  }),
  CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The resource state does not permit this operation.",
    retryable: false,
  }),
  REQUESTER_CANNOT_APPROVE: Object.freeze({
    statusCode: 403,
    message: "The requester cannot approve this operation.",
    retryable: false,
  }),
  OPERATIONS_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Operational data is temporarily unavailable.",
    retryable: true,
  }),
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
const OPERATIONS_PAGE_KEYS = new Set(["items", "cursor"]);
const OPERATION_AGGREGATE_KEYS = new Set([
  "scopeType",
  "domainId",
  "projectId",
  "runtimeCount",
  "healthyRuntimeCount",
  "invocationCount",
  "errorCount",
  "averageLatencyMs",
  "p95LatencyMs",
  "inputTokens",
  "outputTokens",
]);
const USAGE_KEYS = new Set([
  "scopeType",
  "domainId",
  "projectId",
  "invocationCount",
  "inputTokens",
  "outputTokens",
  "estimatedCostUsd",
]);
const BUDGET_KEYS = new Set([
  "scopeType",
  "domainId",
  "projectId",
  "monthlyLimitUsd",
  "currency",
]);

export class OperationsServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) throw new TypeError("Operations error code is invalid.");
    super(detail.message);
    this.name = "OperationsServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.retryable;
  }
}

function fail(code) {
  throw new OperationsServiceError(code);
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

function ownKeys(value) {
  return Reflect.ownKeys(value);
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = ownKeys(value);
  return (
    keys.length === expected.size
    && keys.every(
      (key) => typeof key === "string" && expected.has(key),
    )
  );
}

function snapshotExactRecord(value, expected, errorCode) {
  if (!hasExactKeys(value, expected)) fail(errorCode);
  const snapshot = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
    ) {
      fail(errorCode);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
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

function snapshotArray(value, maximum, errorCode = "INVALID_REQUEST") {
  if (!Array.isArray(value)) fail(errorCode);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, "value")
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximum
  ) {
    fail(errorCode);
  }
  const result = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
    ) {
      fail(errorCode);
    }
    result.push(descriptor.value);
  }
  return result;
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

function validText(value, maxLength, { empty = false } = {}) {
  return (
    typeof value === "string"
    && value.length <= maxLength
    && (empty || value.length > 0)
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

function validDomainId(value) {
  return (
    nonEmptyString(value, 64)
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function validSubject(value) {
  return (
    nonEmptyString(value, 256)
    && SUBJECT_PATTERN.test(value)
  );
}

function validSlug(value) {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

function validNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validNonNegativeNumber(value) {
  return (
    typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
  );
}

function validateAbortSignal(value) {
  if (
    value === undefined
    || (
      value !== null
      && typeof value === "object"
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function"
      && typeof value.removeEventListener === "function"
    )
  ) {
    return value;
  }
  fail("INVALID_REQUEST");
}

function validateIdentity(value) {
  const keys = new Set([
    "actor",
    "role",
    "activeDomain",
    "domainIds",
  ]);
  if (!hasExactKeys(value, keys)) fail("INVALID_REQUEST");
  const actor = readOwnDataProperty(value, "actor").value;
  const role = readOwnDataProperty(value, "role").value;
  const activeDomain = readOwnDataProperty(value, "activeDomain").value;
  const domainIds = snapshotArray(
    readOwnDataProperty(value, "domainIds").value,
    MAX_DOMAIN_SCOPES,
  );
  if (
    !validSubject(actor)
    || !["admin", "lead", "builder", "user"].includes(role)
    || domainIds.some((domainId) => !validDomainId(domainId))
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
  } else if (activeDomain !== null || domainIds.length !== 0) {
    fail("INVALID_REQUEST");
  }
  return Object.freeze({
    actor,
    role,
    activeDomain,
    domainIds: Object.freeze(domainIds),
  });
}

function validateRequest(value) {
  const allowed = new Set([
    "identity",
    "window",
    "limit",
    "cursor",
    "abortSignal",
    "groupBy",
  ]);
  if (
    !isPlainObject(value)
    || ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.has(key),
    )
    || !Object.hasOwn(value, "identity")
  ) {
    fail("INVALID_REQUEST");
  }
  const identity = validateIdentity(
    readOwnDataProperty(value, "identity").value,
  );
  const window = Object.hasOwn(value, "window")
    ? readOwnDataProperty(value, "window").value
    : "24h";
  const limit = Object.hasOwn(value, "limit")
    ? readOwnDataProperty(value, "limit").value
    : 20;
  const cursor = Object.hasOwn(value, "cursor")
    ? readOwnDataProperty(value, "cursor").value
    : undefined;
  const abortSignal = Object.hasOwn(value, "abortSignal")
    ? validateAbortSignal(
        readOwnDataProperty(value, "abortSignal").value,
      )
    : undefined;
  const groupBy = Object.hasOwn(value, "groupBy")
    ? readOwnDataProperty(value, "groupBy").value : undefined;
  if (
    (groupBy !== undefined && groupBy !== "project")
    || typeof window !== "string"
    || !Object.hasOwn(WINDOWS, window)
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_PAGE_SIZE
    || (
      cursor !== undefined
      && (
        typeof cursor !== "string"
        || !REQUEST_CURSOR_PATTERN.test(cursor)
      )
    )
  ) {
    fail("INVALID_REQUEST");
  }
  return {
    identity,
    window,
    limit,
    cursor,
    abortSignal,
    groupBy,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Operations request was aborted.");
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
      const error = new Error("Operations request was aborted.");
      error.name = "AbortError";
      reject(error);
    };
    const cleanup = () => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function readClock(clock) {
  let value;
  try {
    value = clock();
  } catch {
    fail("OPERATIONS_UNAVAILABLE");
  }
  if (!Number.isFinite(value) || value < 0) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return value;
}

function timeWindow(clock, window, resource) {
  const now = readClock(clock);
  // CloudWatch rounds StartTime to minutes (<15d) or five minutes (15–63d).
  // Align both ends so valid buckets stay inside the declared window. Journal
  // cost reads retain their exact wall-clock window and cursor semantics.
  const resolution = WINDOWS[window] >= 15 * 24 * 60 * 60_000 ? 300_000 : 60_000;
  const end = resource === "operations" ? Math.floor(now / resolution) * resolution : now;
  const start = end - WINDOWS[window];
  if (!Number.isFinite(start) || start < 0) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString(),
  });
}

function cursorBinding(resource, identity, scope, limit) {
  return createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      resource,
      actor: identity.actor,
      role: identity.role,
      activeDomain: identity.activeDomain,
      ...(scope.type === "projects" && identity.role !== "builder" ? { groupBy: "project" } : {}),
      domainIds: scope.domainIds,
      projectIds: scope.projectIds,
      limit,
    }))
    .digest("hex");
}

function normalizeCursorSigningKey(value) {
  if (
    typeof value !== "string"
    || value.length < 32
    || value.length > 4096
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError("Operations cursor signing key is invalid.");
  }
  return Buffer.from(value, "utf8");
}

function cursorSignature(payload, signingKey) {
  return createHmac("sha256", signingKey)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function validCursorSignature(value, expected) {
  if (
    typeof value !== "string"
    || !/^[a-f0-9]{64}$/.test(value)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(value, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function encodeCursor({
  resource,
  providerCursor,
  windowName,
  window,
  binding,
  limit,
  signingKey,
}) {
  if (providerCursor === null) return null;
  const payload = {
    v: 1,
    resource,
    windowName,
    startTime: window.startTime,
    endTime: window.endTime,
    binding,
    limit,
    providerCursor,
  };
  const encoded = Buffer.from(JSON.stringify({
    ...payload,
    signature: cursorSignature(payload, signingKey),
  })).toString("base64url");
  if (!REQUEST_CURSOR_PATTERN.test(encoded)) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return encoded;
}

function decodeCursor(
  value,
  resource,
  windowName,
  binding,
  limit,
  signingKey,
) {
  if (value === undefined) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) fail("NOT_FOUND");
    const parsed = JSON.parse(decoded.toString("utf8"));
    if (
      !hasExactKeys(
        parsed,
        new Set([
          "v",
          "resource",
          "windowName",
          "startTime",
          "endTime",
          "binding",
          "limit",
          "providerCursor",
          "signature",
        ]),
      )
    ) {
      fail("NOT_FOUND");
    }
    const payload = {
      v: parsed.v,
      resource: parsed.resource,
      windowName: parsed.windowName,
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      binding: parsed.binding,
      limit: parsed.limit,
      providerCursor: parsed.providerCursor,
    };
    if (
      payload.v !== 1
      || payload.resource !== resource
      || payload.windowName !== windowName
      || !validInstant(payload.startTime)
      || !validInstant(payload.endTime)
      || Date.parse(payload.endTime) - Date.parse(payload.startTime)
        !== WINDOWS[windowName]
      || payload.binding !== binding
      || !/^[a-f0-9]{64}$/.test(payload.binding)
      || payload.limit !== limit
      || typeof payload.providerCursor !== "string"
      || !PROVIDER_CURSOR_PATTERN.test(payload.providerCursor)
      || !validCursorSignature(
        parsed.signature,
        cursorSignature(payload, signingKey),
      )
    ) {
      fail("NOT_FOUND");
    }
    return Object.freeze({
      providerCursor: payload.providerCursor,
      window: Object.freeze({
        startTime: payload.startTime,
        endTime: payload.endTime,
      }),
    });
  } catch (error) {
    if (error instanceof OperationsServiceError) throw error;
    fail("NOT_FOUND");
  }
}

function validateProject(record) {
  const value = snapshotExactRecord(
    record,
    PROJECT_KEYS,
    "OPERATIONS_UNAVAILABLE",
  );
  const members = snapshotArray(
    value.memberSubjects,
    MAX_MEMBERS,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !validDomainId(value.domainId)
    || !validSlug(value.id)
    || !validText(value.name, 128)
    || !validText(value.description, 4096, { empty: true })
    || !validSubject(value.ownerSubject)
    || members.some((subject) => !validSubject(subject))
    || new Set(members).size !== members.length
    || !["ACTIVE", "ARCHIVED"].includes(value.status)
    || !validSubject(value.createdBySubject)
    || !validInstant(value.createdAt)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({
    ...value,
    memberSubjects: Object.freeze(members),
  });
}

function validateStateCursor(value, domainId) {
  if (value === null) return null;
  const cursor = snapshotExactRecord(
    value,
    new Set(["pk", "sk"]),
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    cursor.pk !== `PROJECT#${domainId}`
    || !nonEmptyString(cursor.sk, 1024)
    || !cursor.sk.startsWith("PROJECT#")
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({ pk: cursor.pk, sk: cursor.sk });
}

function validateProjectPage(value, domainId) {
  const page = snapshotExactRecord(
    value,
    new Set(["items", "cursor"]),
    "OPERATIONS_UNAVAILABLE",
  );
  const items = snapshotArray(
    page.items,
    STATE_PAGE_SIZE,
    "OPERATIONS_UNAVAILABLE",
  ).map(validateProject);
  if (items.some((project) => project.domainId !== domainId)) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({
    items: Object.freeze(items),
    cursor: validateStateCursor(page.cursor, domainId),
  });
}

async function collectProjects(state, request) {
  const projects = [];
  const projectKeys = new Set();
  for (const domainId of request.identity.domainIds) {
    let cursor;
    const seenCursors = new Set();
    for (let pageNumber = 0; ; pageNumber += 1) {
      throwIfAborted(request.abortSignal);
      if (pageNumber >= MAX_PROJECT_PAGES_PER_DOMAIN) {
        fail("OPERATIONS_UNAVAILABLE");
      }
      let page;
      try {
        page = validateProjectPage(
          await waitForAbortablePromise(
            state.listProjects({
              domainId,
              limit: STATE_PAGE_SIZE,
              ...(cursor ? { cursor } : {}),
              ...(request.abortSignal
                ? { abortSignal: request.abortSignal }
                : {}),
            }),
            request.abortSignal,
          ),
          domainId,
        );
      } catch (error) {
        if (
          error?.name === "AbortError"
          || error instanceof OperationsServiceError
        ) {
          throw error;
        }
        fail("OPERATIONS_UNAVAILABLE");
      }
      for (const project of page.items) {
        const projectKey = `${project.domainId}/${project.id}`;
        if (projectKeys.has(projectKey)) {
          fail("OPERATIONS_UNAVAILABLE");
        }
        projectKeys.add(projectKey);
        if (
          request.identity.role !== "builder"
          || project.ownerSubject === request.identity.actor
          || project.memberSubjects.includes(request.identity.actor)
        ) {
          projects.push(project);
          if (projects.length > MAX_SCOPED_PROJECTS) {
            fail("OPERATIONS_UNAVAILABLE");
          }
        }
      }
      if (page.cursor === null) break;
      const cursorKey = `${page.cursor.pk}\n${page.cursor.sk}`;
      if (seenCursors.has(cursorKey)) fail("OPERATIONS_UNAVAILABLE");
      seenCursors.add(cursorKey);
      cursor = page.cursor;
    }
  }
  return projects;
}

function publicScope(identity, projects) {
  if (identity.role === "admin") {
    return Object.freeze({ type: "platform" });
  }
  if (identity.role === "lead") {
    return Object.freeze({
      type: "domain",
      domainId: identity.activeDomain,
    });
  }
  return Object.freeze({
    type: "projects",
    domainId: identity.activeDomain,
    projectIds: Object.freeze(projects.map(({ id }) => id)),
  });
}

function providerScope(identity, projects) {
  return Object.freeze({
    type: identity.role === "admin"
      ? "platform"
      : identity.role === "lead"
        ? "domain"
        : "projects",
    domainIds: Object.freeze([...identity.domainIds]),
    projectIds: Object.freeze(
      projects.map(({ domainId, id }) => `${domainId}/${id}`),
    ),
  });
}

function authorizationRequestContext(identity, abortSignal) {
  return Object.freeze({
    source: "operations-api",
    subject: identity.actor,
    role: identity.role,
    activeDomain: identity.activeDomain,
    domainIds: Object.freeze([...identity.domainIds]),
    abortSignal,
  });
}

function collectionResourceRef(resource, identity) {
  const descriptor = Buffer.from(JSON.stringify({
    v: 1,
    resource,
    subject: identity.actor,
    role: identity.role,
    activeDomain: identity.activeDomain,
    domainIds: identity.domainIds,
  })).toString("base64url");
  return `operations-collection:${resource}:${descriptor}`;
}

async function authorizeRead(authorizer, resource, request) {
  let decision;
  try {
    decision = await waitForAbortablePromise(
      authorizer({
        requestContext: authorizationRequestContext(
          request.identity,
          request.abortSignal,
        ),
        action: `workspace.${resource}.read`,
        resourceRef: collectionResourceRef(
          resource,
          request.identity,
        ),
      }),
      request.abortSignal,
    );
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error?.decision === "NOT_FOUND" || error?.code === "NOT_FOUND") {
      fail("NOT_FOUND");
    }
    fail("FORBIDDEN");
  }
  if (!hasExactKeys(decision, new Set(["ok"]))) fail("FORBIDDEN");
  const allowed = Object.getOwnPropertyDescriptor(decision, "ok");
  if (
    allowed === undefined
    || !Object.hasOwn(allowed, "value")
    || allowed.value !== true
  ) {
    fail("FORBIDDEN");
  }
}

function validateProviderCursor(value) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !PROVIDER_CURSOR_PATTERN.test(value)
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return value;
}

function operationScopeMatches(record, identity, projectKeys, projectBreakdown = false) {
  if (!projectBreakdown && identity.role === "admin") {
    return (
      record.scopeType === "platform"
      && record.domainId === null
      && record.projectId === null
    );
  }
  if (!projectBreakdown && identity.role === "lead") {
    return (
      record.scopeType === "domain"
      && record.domainId === identity.activeDomain
      && record.projectId === null
    );
  }
  return (
    record.scopeType === "project"
    && validDomainId(record.domainId)
    && validSlug(record.projectId)
    && projectKeys.has(`${record.domainId}/${record.projectId}`)
  );
}

function validateOperationAggregate(record, identity, projectKeys, projectBreakdown = false) {
  const value = snapshotExactRecord(
    record,
    OPERATION_AGGREGATE_KEYS,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !operationScopeMatches(value, identity, projectKeys, projectBreakdown)
    || !["runtimeCount", "healthyRuntimeCount", "invocationCount",
      "errorCount", "inputTokens", "outputTokens"].every(
      (key) => value[key] === null || validNonNegativeInteger(value[key]),
    )
    || (value.runtimeCount !== null
      && value.healthyRuntimeCount > value.runtimeCount)
    || (value.invocationCount !== null
      && value.errorCount > value.invocationCount)
    || !["averageLatencyMs", "p95LatencyMs"].every(
      (key) => value[key] === null || validNonNegativeNumber(value[key]),
    )
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({ ...value });
}

function validateOperationsPage(value, identity, projects, limit, projectBreakdown = false) {
  const page = snapshotExactRecord(
    value,
    OPERATIONS_PAGE_KEYS,
    "OPERATIONS_UNAVAILABLE",
  );
  const items = snapshotArray(
    page.items,
    limit,
    "OPERATIONS_UNAVAILABLE",
  );
  const projectKeys = new Set(
    projects.map(({ domainId, id }) => `${domainId}/${id}`),
  );
  const validatedItems = items.map((item) =>
    validateOperationAggregate(item, identity, projectKeys, projectBreakdown));
  const scopeKeys = validatedItems.map((record) =>
    budgetScopeKey(
      record.scopeType,
      record.domainId,
      record.projectId,
    ));
  if (new Set(scopeKeys).size !== validatedItems.length) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({
    items: Object.freeze(validatedItems),
    cursor: validateProviderCursor(page.cursor),
  });
}

function validateUsageAggregate(record, identity, projectKeys, projectBreakdown) {
  const journal = isPlainObject(record) && Object.hasOwn(record, "source");
  const native = journal && record.runBoundary === "runtime-durable-start";
  const value = snapshotExactRecord(
    record,
    journal ? new Set([...USAGE_KEYS, ...JOURNAL_USAGE_KEYS, ...(native ? NATIVE_USAGE_KEYS : [])]) : USAGE_KEYS,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !operationScopeMatches(value, identity, projectKeys, projectBreakdown)
    || !["invocationCount", "inputTokens", "outputTokens"].every(
      (key) => value[key] === null || validNonNegativeInteger(value[key]),
    )
    || !(value.estimatedCostUsd === null
      || validNonNegativeNumber(value.estimatedCostUsd))
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  if (journal) {
    const counts = ["succeededDispatchCount", "failedDispatchCount", "unresolvedDispatchCount", "legacyRecordCount", "pricedDispatchCount"];
    if (value.source !== "experience-invocation-journal" || value.environment !== "PRODUCTION"
      || value.consistency !== "eventual"
      || value.windowBasis !== (native ? "usage-occurrence-and-execution-start" : "dispatch-start-cohort")
      || value.dispatchBoundary !== "accepted-runtime-dispatch"
      || typeof value.pricingRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.pricingRevision)
      || !counts.every(key => validNonNegativeInteger(value[key]))
      || (!native && value.runCount !== null) || value.invocationCount !== null
      || value.runCountUnavailableReason !== (native && value.runCount !== null
        ? null : "actual-execution-start-unavailable")
      || (native && (!NATIVE_USAGE_KEYS.slice(1, -1).every(key => validNonNegativeInteger(value[key]))
        || value.knownRunCount !== value.succeededRunCount + value.failedRunCount + value.unresolvedRunCount
        || value.runCount !== (value.legacyRecordCount > 0 ? null : value.knownRunCount)
        || !Array.isArray(value.pricingRevisions) || value.pricingRevisions.length > 500
        || value.pricingRevisions.some(revision => typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision))))
      || !(value.acceptedDispatchCount === null || validNonNegativeInteger(value.acceptedDispatchCount))
      || (!native && value.legacyRecordCount > 0 && value.acceptedDispatchCount !== null)
      || ((native || value.legacyRecordCount === 0)
        && value.acceptedDispatchCount !== value.succeededDispatchCount + value.failedDispatchCount + value.unresolvedDispatchCount)
      || value.pricedDispatchCount > value.succeededDispatchCount
      || !validNonNegativeNumber(value.knownEstimatedCostUsd)
      || !(value.updatedAt === null || validInstant(value.updatedAt))
      || !["complete", "partial", "unavailable"].includes(value.modelCoverage)
      || (value.modelCoverage === "complete") !== (value.estimatedCostUsd !== null)
      || (value.estimatedCostUsd !== null && value.estimatedCostUsd !== value.knownEstimatedCostUsd)
      || !Array.isArray(value.priceSources) || value.priceSources.length > 500
      || value.priceSources.some(source => !hasExactKeys(source,
        new Set(["id", "url", "retrievedAt", "effectiveFrom", "effectiveTo"]))
        || !nonEmptyString(source.id, 512) || !nonEmptyString(source.url, 2048)
        || !validInstant(source.retrievedAt) || !validInstant(source.effectiveFrom)
        || !validInstant(source.effectiveTo) || source.effectiveFrom >= source.effectiveTo)
      || new Set(value.priceSources.map(source => source.id)).size !== value.priceSources.length
      || value.pricingVersion !== (value.priceSources.length === 1 ? value.priceSources[0].id : null)) {
      fail("OPERATIONS_UNAVAILABLE");
    }
  }
  return Object.freeze({ ...value });
}

function validateUsagePage(value, identity, projects, limit, projectBreakdown) {
  const page = snapshotExactRecord(
    value,
    OPERATIONS_PAGE_KEYS,
    "OPERATIONS_UNAVAILABLE",
  );
  const projectKeys = new Set(
    projects.map(({ domainId, id }) => `${domainId}/${id}`),
  );
  const items = snapshotArray(
    page.items,
    limit,
    "OPERATIONS_UNAVAILABLE",
  ).map((record) =>
    validateUsageAggregate(record, identity, projectKeys, projectBreakdown));
  const scopeKeys = items.map((record) =>
    budgetScopeKey(
      record.scopeType,
      record.domainId,
      record.projectId,
    ));
  if (new Set(scopeKeys).size !== items.length) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return Object.freeze({
    items: Object.freeze(items),
    scopeKeys: Object.freeze(scopeKeys),
    cursor: validateProviderCursor(page.cursor),
  });
}

function budgetScopeKey(scopeType, domainId, projectId) {
  if (scopeType === "platform") return "platform";
  if (scopeType === "domain") return `domain:${domainId}`;
  return `project:${domainId}/${projectId}`;
}

function validateBudget(record, identity, scope, allowedScopeKeys) {
  const value = snapshotExactRecord(
    record,
    BUDGET_KEYS,
    "OPERATIONS_UNAVAILABLE",
  );
  if (
    !validNonNegativeNumber(value.monthlyLimitUsd)
    || value.currency !== "USD"
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  if (identity.role === "admin") {
    if (
      value.scopeType !== "platform"
      || value.domainId !== null
      || value.projectId !== null
    ) {
      fail("OPERATIONS_UNAVAILABLE");
    }
  } else if (identity.role === "lead") {
    if (
      value.scopeType !== "domain"
      || value.domainId !== identity.activeDomain
      || value.projectId !== null
    ) {
      fail("OPERATIONS_UNAVAILABLE");
    }
  } else if (
    value.scopeType !== "project"
    || !validDomainId(value.domainId)
    || !validSlug(value.projectId)
    || !scope.projectIds.includes(
      `${value.domainId}/${value.projectId}`,
    )
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  const validated = Object.freeze({ ...value });
  if (
    !allowedScopeKeys.has(
      budgetScopeKey(
        validated.scopeType,
        validated.domainId,
        validated.projectId,
      ),
    )
  ) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return validated;
}

function validateBudgets(value, identity, scope, scopeKeys) {
  const allowedScopeKeys = new Set(scopeKeys);
  const budgets = snapshotArray(
    value,
    Math.min(MAX_BUDGETS, scopeKeys.length),
    "OPERATIONS_UNAVAILABLE",
  ).map((record) =>
    validateBudget(record, identity, scope, allowedScopeKeys));
  const keys = budgets.map((record) =>
    budgetScopeKey(
      record.scopeType,
      record.domainId,
      record.projectId,
    ));
  if (new Set(keys).size !== keys.length) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return budgets;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  const factor = 10 ** digits;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  if (!Number.isFinite(rounded)) {
    fail("OPERATIONS_UNAVAILABLE");
  }
  return rounded;
}

function aggregateCosts(usageAggregates, budgets, window, projectBudgets) {
  const budgetsByScope = new Map(
    budgets.map((record) => [
      budgetScopeKey(
        record.scopeType,
        record.domainId,
        record.projectId,
      ),
      record,
    ]),
  );
  const duration = Date.parse(window.endTime) - Date.parse(window.startTime);
  return usageAggregates
    .map((usage) => {
      const key = budgetScopeKey(
        usage.scopeType,
        usage.domainId,
        usage.projectId,
      );
      const durable = usage.scopeType === "project" && projectBudgets !== undefined;
      const budgetRecord = durable ? projectBudgets.get(key) ?? null : budgetsByScope.get(key) ?? null;
      const projectedMonthlyCostUsd = usage.source === "experience-invocation-journal"
        || usage.estimatedCostUsd === null ? null : round(
        usage.estimatedCostUsd * MONTH_MILLISECONDS / duration,
      );
      const monthlyBudgetUsd = budgetRecord?.monthlyLimitUsd ?? null;
      const projectedBudgetUtilizationPercent =
        monthlyBudgetUsd === null || projectedMonthlyCostUsd === null
          ? null
          : monthlyBudgetUsd === 0
            ? (projectedMonthlyCostUsd === 0 ? 0 : null)
            : round(
                projectedMonthlyCostUsd / monthlyBudgetUsd * 100,
                2,
              );
      return Object.freeze({
        scopeType: usage.scopeType,
        domainId: usage.domainId,
        projectId: usage.projectId,
        invocationCount: usage.invocationCount,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
        projectedMonthlyCostUsd,
        monthlyBudgetUsd,
        ...(durable ? { projectBudget: budgetRecord } : {}),
        projectedBudgetUtilizationPercent,
        contractVersion: 1,
        currency: "USD",
        basis: "estimate",
        source: "cloudwatch-runtime-metrics",
        pricingVersion: null,
        updatedAt: null,
        environment: null,
        coverage: {
          included: ["model-inference"],
          excluded: ["runtime", "gateway", "memory", "tools", "evaluation", "shared"],
        },
        completeness: usage.estimatedCostUsd === null ? "unavailable" : "partial",
        // Neither completion metrics nor accepted dispatches establish the
        // complete actual-start denominator required by the agent-run KPI.
        runCount: null,
        costPerRunUsd: null,
        ...(usage.source === "experience-invocation-journal" ? {
          ...Object.fromEntries(JOURNAL_USAGE_KEYS.map(key => [key, usage[key]])),
          ...(usage.runBoundary === "runtime-durable-start" ? {
            ...Object.fromEntries(NATIVE_USAGE_KEYS.map(key => [key, usage[key]])),
            costPerRunUsd: usage.runCount > 0 && usage.estimatedCostUsd !== null
              ? usage.estimatedCostUsd / usage.runCount : null,
          } : {}),
          completeness: usage.estimatedCostUsd === null ? "unavailable" : "partial",
          coverage: {
            included: [usage.runBoundary === "runtime-durable-start"
              ? "retained-provider-usage-including-failures" : "retained-successful-model-responses"],
            excluded: ["unobserved-attempts", "runtime", "gateway", "memory", "tools", "evaluation", "shared"],
          },
        } : {}),
      });
    })
    .sort((left, right) =>
      `${left.domainId ?? ""}/${left.projectId ?? ""}`.localeCompare(
        `${right.domainId ?? ""}/${right.projectId ?? ""}`,
      ));
}

export function createOperationsService({
  workspaceState,
  authorizer,
  cloudWatchProvider,
  usageProvider,
  budgetState,
  platformCostsReader = null,
  clock,
  cursorSigningKey,
} = {}) {
  if (
    !workspaceState
    || typeof workspaceState.listProjects !== "function"
  ) {
    throw new TypeError("Operations state configuration is invalid.");
  }
  if (typeof authorizer !== "function") {
    throw new TypeError("Operations authorizer is invalid.");
  }
  if (
    !cloudWatchProvider
    || typeof cloudWatchProvider.listRuntimeAggregates !== "function"
  ) {
    throw new TypeError("CloudWatch provider is invalid.");
  }
  if (
    !usageProvider
    || typeof usageProvider.listInvocationUsageAggregates !== "function"
    || typeof usageProvider.listBudgets !== "function"
  ) {
    throw new TypeError("Usage provider is invalid.");
  }
  if (typeof clock !== "function") {
    throw new TypeError("Operations clock is invalid.");
  }
  const signingKey = normalizeCursorSigningKey(cursorSigningKey);
  const workflowService = createOperationsWorkflowService({
    workspaceState,
    authorizer,
    clock,
    cursorSigningKey: signingKey,
    fail,
  });

  async function prepare(input, resource) {
    const request = validateRequest(input);
    // groupBy=project fans the aggregate out per ACTIVE project. Costs and
    // operations share the same descriptor machinery; other resources stay
    // aggregate-only.
    if (request.groupBy && !["costs", "operations"].includes(resource)) {
      fail("INVALID_REQUEST");
    }
    if (request.identity.role === "user") fail("FORBIDDEN");
    await authorizeRead(authorizer, resource, request);
    const projects = (await collectProjects(workspaceState, request))
      .filter(project => !request.groupBy || project.status === "ACTIVE");
    const baseScope = providerScope(request.identity, projects);
    const scope = request.groupBy ? Object.freeze({ ...baseScope, type: "projects" }) : baseScope;
    const binding = cursorBinding(
      resource,
      request.identity,
      scope,
      request.limit,
    );
    const decodedCursor = decodeCursor(
      request.cursor,
      resource,
      request.window,
      binding,
      request.limit,
      signingKey,
    );
    return {
      request,
      projects,
      scope,
      publicScope: request.groupBy ? Object.freeze({
        type: "projects", domainIds: scope.domainIds, projectIds: scope.projectIds,
      }) : publicScope(request.identity, projects),
      window: decodedCursor?.window ?? timeWindow(clock, request.window, resource),
      providerCursor: decodedCursor?.providerCursor,
      cursorBinding: binding,
    };
  }

  return Object.freeze({
    ...workflowService,
    async readPlatformCosts(input) {
      // Reuses the shared window/identity validation so the identity shape
      // and abort handling stay identical to every other read path.
      const request = validateRequest(input);
      if (request.identity.role !== "admin") fail("FORBIDDEN");
      await authorizeRead(authorizer, "platform-costs", request);
      if (!platformCostsReader) fail("OPERATIONS_UNAVAILABLE");
      let billing;
      try {
        billing = await waitForAbortablePromise(
          platformCostsReader.read({
            ...(request.abortSignal
              ? { abortSignal: request.abortSignal }
              : {}),
          }),
          request.abortSignal,
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        fail("OPERATIONS_UNAVAILABLE");
      }
      return Object.freeze({ billing });
    },
    async listOperations(input) {
      const prepared = await prepare(input, "operations");
      let page;
      try {
        page = validateOperationsPage(
          await waitForAbortablePromise(
            cloudWatchProvider.listRuntimeAggregates({
              scope: prepared.scope,
              startTime: prepared.window.startTime,
              endTime: prepared.window.endTime,
              limit: prepared.request.limit,
              ...(prepared.providerCursor
                ? { cursor: prepared.providerCursor }
                : {}),
              ...(prepared.request.abortSignal
                ? { abortSignal: prepared.request.abortSignal }
                : {}),
            }),
            prepared.request.abortSignal,
          ),
          prepared.request.identity,
          prepared.projects,
          prepared.request.limit,
          Boolean(prepared.request.groupBy),
        );
      } catch (error) {
        if (
          error?.name === "AbortError"
          || error instanceof OperationsServiceError
        ) {
          throw error;
        }
        fail("OPERATIONS_UNAVAILABLE");
      }
      return Object.freeze({
        scope: prepared.publicScope,
        window: prepared.window,
        items: page.items,
        cursor: encodeCursor({
          resource: "operations",
          providerCursor: page.cursor,
          windowName: prepared.request.window,
          window: prepared.window,
          binding: prepared.cursorBinding,
          limit: prepared.request.limit,
          signingKey,
        }),
      });
    },

    async listCosts(input) {
      const prepared = await prepare(input, "costs");
      let usagePage;
      let budgets = [];
      let projectBudgets;
      try {
        usagePage = validateUsagePage(
          await waitForAbortablePromise(
            usageProvider.listInvocationUsageAggregates({
              scope: prepared.scope,
              startTime: prepared.window.startTime,
              endTime: prepared.window.endTime,
              limit: prepared.request.limit,
              ...(prepared.providerCursor
                ? { cursor: prepared.providerCursor }
                : {}),
              ...(prepared.request.abortSignal
                ? { abortSignal: prepared.request.abortSignal }
                : {}),
            }),
            prepared.request.abortSignal,
          ),
          prepared.request.identity,
          prepared.projects,
          prepared.request.limit,
          prepared.request.groupBy === "project",
        );
        if (usagePage.items.length > 0 && prepared.scope.type === "projects" && budgetState) {
          projectBudgets = new Map();
          for (const item of usagePage.items) {
            throwIfAborted(prepared.request.abortSignal);
            const config = publicProjectBudget(await waitForAbortablePromise(
              budgetState.getConfig({ domainId: item.domainId, projectId: item.projectId }),
              prepared.request.abortSignal,
            ));
            if (config && (config.domainId !== item.domainId || config.projectId !== item.projectId)) {
              fail("OPERATIONS_UNAVAILABLE");
            }
            projectBudgets.set(budgetScopeKey("project", item.domainId, item.projectId), config);
          }
        } else if (prepared.request.groupBy) {
          // A requested durable project view never falls back to environment configuration.
          if (!budgetState) fail("OPERATIONS_UNAVAILABLE");
          projectBudgets = new Map();
        } else if (usagePage.items.length > 0) {
          budgets = validateBudgets(
            await waitForAbortablePromise(
            usageProvider.listBudgets({
              scope: prepared.scope,
              scopeKeys: usagePage.scopeKeys,
              ...(prepared.request.abortSignal
                ? { abortSignal: prepared.request.abortSignal }
                : {}),
            }),
            prepared.request.abortSignal,
          ),
            prepared.request.identity,
            prepared.scope,
            usagePage.scopeKeys,
          );
        }
      } catch (error) {
        if (
          error?.name === "AbortError"
          || error instanceof OperationsServiceError
        ) {
          throw error;
        }
        fail("OPERATIONS_UNAVAILABLE");
      }
      return Object.freeze({
        scope: prepared.publicScope,
        window: prepared.window,
        items: Object.freeze(
          aggregateCosts(
            usagePage.items,
            budgets,
            prepared.window,
            projectBudgets,
          ),
        ),
        cursor: encodeCursor({
          resource: "costs",
          providerCursor: usagePage.cursor,
          windowName: prepared.request.window,
          window: prepared.window,
          binding: prepared.cursorBinding,
          limit: prepared.request.limit,
          signingKey,
        }),
      });
    },
  });
}
