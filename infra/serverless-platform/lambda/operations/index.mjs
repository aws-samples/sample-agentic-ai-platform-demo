import {
  OperationsServiceError,
  createOperationsService,
} from "./service.mjs";
import { createProjectBudgetService } from "./budgets.mjs";
import { createBudgetDelivery } from "./budget-delivery.mjs";

const ROUTES = Object.freeze({
  "GET /api/operations/project-budgets": Object.freeze({
    operation: "readProjectBudget",
    resource: "project-budget",
    kind: "project-read",
  }),
  "POST /api/operations/project-budgets": Object.freeze({
    operation: "writeProjectBudget",
    resource: "project-budget",
    kind: "mutation",
    statusCode: 200,
    bodyKeys: Object.freeze([
      "domainId", "projectId", "expectedVersion", "currency", "period", "monthlyLimitUsd", "thresholdPercent",
    ]),
  }),
  "POST /api/operations/project-budgets/evaluate": Object.freeze({
    operation: "evaluateProjectBudget",
    resource: "project-budget",
    kind: "mutation",
    statusCode: 200,
    bodyKeys: Object.freeze(["domainId", "projectId"]),
  }),
  "GET /api/operations": Object.freeze({
    operation: "listOperations",
    resource: "operations",
    kind: "aggregate",
  }),
  "GET /api/costs": Object.freeze({
    operation: "listCosts",
    resource: "costs",
    kind: "aggregate",
  }),
  "GET /api/platform-costs": Object.freeze({
    operation: "readPlatformCosts",
    resource: "platform-costs",
    kind: "platform-read",
  }),
  "GET /api/operations/audit": Object.freeze({
    operation: "listAudit",
    resource: "audit",
    kind: "list",
  }),
  "GET /api/incidents": Object.freeze({
    operation: "listIncidents",
    resource: "incidents",
    kind: "list",
  }),
  "POST /api/incidents": Object.freeze({
    operation: "createIncident",
    resource: "incident",
    kind: "mutation",
    statusCode: 201,
    bodyKeys: Object.freeze([
      "domainId",
      "projectId",
      "id",
      "title",
      "description",
      "severity",
      "reason",
    ]),
  }),
  "POST /api/break-glass/requests": Object.freeze({
    operation: "requestBreakGlass",
    resource: "break-glass",
    kind: "mutation",
    statusCode: 201,
    bodyKeys: Object.freeze([
      "id",
      "domainId",
      "projectId",
      "resource",
      "action",
      "reason",
      "durationMinutes",
    ]),
  }),
  "POST /api/break-glass/decisions": Object.freeze({
    operation: "decideBreakGlass",
    resource: "break-glass",
    kind: "mutation",
    statusCode: 200,
    bodyKeys: Object.freeze(["id", "decision", "reason"]),
  }),
  "POST /api/break-glass/activations": Object.freeze({
    operation: "activateBreakGlass",
    resource: "break-glass",
    kind: "mutation",
    statusCode: 200,
    bodyKeys: Object.freeze(["id", "reason"]),
  }),
  "POST /api/break-glass/revocations": Object.freeze({
    operation: "revokeBreakGlass",
    resource: "break-glass",
    kind: "mutation",
    statusCode: 200,
    bodyKeys: Object.freeze(["id", "reason"]),
  }),
  "GET /api/break-glass": Object.freeze({
    operation: "listBreakGlass",
    resource: "break-glass",
    kind: "list",
  }),
});
const KNOWN_PATHS = new Set(
  Object.keys(ROUTES).map((route) => route.slice(route.indexOf(" ") + 1)),
);
const INCIDENT_ACTION_PATH =
  /^\/api\/incidents\/([a-z][a-z0-9-]{0,63})\/actions$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,4096}$/;
const WINDOWS = new Set(["1h", "24h", "7d", "30d"]);
const MAX_PAGE_SIZE = 50;
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 1_500;

const ERROR_DEFINITIONS = Object.freeze({
  NOT_AUTHENTICATED: Object.freeze({
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  }),
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The operations request is invalid.",
    retryable: false,
  }),
  INVALID_QUERY: Object.freeze({
    statusCode: 400,
    message: "The operations query is invalid.",
    retryable: false,
  }),
  INVALID_REQUEST_ID: Object.freeze({
    statusCode: 400,
    message: "A valid idempotency request ID is required.",
    retryable: false,
  }),
  DEMO_ROLE_NOT_ALLOWED: Object.freeze({
    statusCode: 403,
    message: "The requested demo role is not allowed.",
    retryable: false,
  }),
  DEMO_DOMAIN_REQUIRED: Object.freeze({
    statusCode: 403,
    message: "An available demo domain is required.",
    retryable: false,
  }),
  DEMO_DOMAIN_NOT_ALLOWED: Object.freeze({
    statusCode: 403,
    message: "The requested demo domain is not allowed.",
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
  IDENTITY_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Identity context is temporarily unavailable.",
    retryable: true,
  }),
  OPERATIONS_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Operational data is temporarily unavailable.",
    retryable: true,
  }),
  OPERATIONS_TIMEOUT: Object.freeze({
    statusCode: 504,
    message: "The operations request timed out.",
    retryable: true,
  }),
  ROUTE_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  }),
});

class OperationsTimeoutError extends Error {
  constructor() {
    super("The operations request timed out.");
    this.name = "OperationsTimeoutError";
  }
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

function ownDataProperty(value, key) {
  if (!isPlainObject(value)) return { present: false, value: null };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
  ) {
    return { present: false, value: null };
  }
  return { present: true, value: descriptor.value };
}

function ownString(value, key) {
  const property = ownDataProperty(value, key);
  if (
    !property.present
    || typeof property.value !== "string"
    || property.value.length === 0
    || property.value !== property.value.trim()
    || /[\u0000-\u001f\u007f]/.test(property.value)
  ) {
    return null;
  }
  return property.value;
}

function validDomainId(value) {
  return (
    typeof value === "string"
    && value.length <= 64
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function response(statusCode, value) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(value),
  };
}

function errorResponse(code, requestId) {
  const detail = ERROR_DEFINITIONS[code]
    || ERROR_DEFINITIONS.OPERATIONS_UNAVAILABLE;
  return response(detail.statusCode, {
    ok: false,
    code: Object.hasOwn(ERROR_DEFINITIONS, code)
      ? code
      : "OPERATIONS_UNAVAILABLE",
    message: detail.message,
    requestId,
    retryable: detail.retryable,
  });
}

function singleHeader(headers, name) {
  if (headers === undefined || headers === null) {
    return { present: false, value: null };
  }
  if (!isPlainObject(headers)) {
    return { invalid: true, present: false, value: null };
  }
  const keys = Reflect.ownKeys(headers).filter(
    (key) =>
      typeof key === "string" && key.toLowerCase() === name,
  );
  if (keys.length > 1) {
    return { invalid: true, present: false, value: null };
  }
  if (keys.length === 0) return { present: false, value: null };
  const property = ownDataProperty(headers, keys[0]);
  if (
    !property.present
    || typeof property.value !== "string"
    || property.value.length === 0
    || property.value !== property.value.trim()
    || /[\u0000-\u001f\u007f]/.test(property.value)
  ) {
    return { invalid: true, present: true, value: null };
  }
  return { present: true, value: property.value };
}

function routeFor(method, path) {
  const exact = ROUTES[`${method} ${path}`];
  if (exact) return exact;
  const match = INCIDENT_ACTION_PATH.exec(path);
  if (method === "POST" && match) {
    return Object.freeze({
      operation: "actOnIncident",
      resource: "incident",
      kind: "mutation",
      statusCode: 200,
      bodyKeys: Object.freeze(["action", "reason"]),
      incidentId: match[1],
    });
  }
  return null;
}

function knownPath(path) {
  return KNOWN_PATHS.has(path) || INCIDENT_ACTION_PATH.test(path);
}

function decodeBody(event) {
  if (typeof event.body !== "string" || event.body.length === 0) {
    return null;
  }
  let bytes;
  if (event.isBase64Encoded === true) {
    if (
      event.body.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        event.body,
      )
    ) {
      return null;
    }
    bytes = Buffer.from(event.body, "base64");
    if (bytes.toString("base64") !== event.body) return null;
  } else {
    bytes = Buffer.from(event.body, "utf8");
  }
  if (bytes.length > MAX_BODY_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function exactBody(body, expected) {
  if (!isPlainObject(body)) return false;
  const keys = Reflect.ownKeys(body);
  return (
    keys.length === expected.length
    && keys.every(
      (key) => typeof key === "string" && expected.includes(key),
    )
  );
}

function hasNoQuery(event) {
  if (
    event.queryStringParameters !== undefined
    && event.queryStringParameters !== null
  ) {
    if (
      !isPlainObject(event.queryStringParameters)
      || Reflect.ownKeys(event.queryStringParameters).length > 0
    ) {
      return false;
    }
  }
  return (
    event.rawQueryString === undefined
    || event.rawQueryString === ""
  );
}

function parseListQuery(event) {
  const query = event.queryStringParameters;
  if (
    query !== undefined
    && query !== null
    && !isPlainObject(query)
  ) {
    return null;
  }
  const values = query ?? {};
  const keys = Reflect.ownKeys(values);
  if (
    keys.length > 2
    || keys.some(
      (key) =>
        !["limit", "cursor"].includes(key)
        || typeof ownDataProperty(values, key).value !== "string",
    )
  ) {
    return null;
  }
  if (
    event.rawQueryString !== undefined
    && typeof event.rawQueryString !== "string"
  ) {
    return null;
  }
  if (typeof event.rawQueryString === "string") {
    const raw = new URLSearchParams(event.rawQueryString);
    const rawKeys = [...raw.keys()];
    if (
      rawKeys.length !== keys.length
      || new Set(rawKeys).size !== rawKeys.length
      || rawKeys.some(
        (key) =>
          !["limit", "cursor"].includes(key)
          || raw.get(key) !== values[key],
      )
    ) {
      return null;
    }
  }
  const limit = Object.hasOwn(values, "limit")
    ? Number(values.limit)
    : 20;
  if (
    (
      Object.hasOwn(values, "limit")
      && !/^[1-9][0-9]?$/.test(values.limit)
    )
    || limit > MAX_PAGE_SIZE
    || (
      Object.hasOwn(values, "cursor")
      && !CURSOR_PATTERN.test(values.cursor)
    )
  ) {
    return null;
  }
  return {
    limit,
    ...(Object.hasOwn(values, "cursor")
      ? { cursor: values.cursor }
      : {}),
  };
}

function parseBudgetQuery(event) {
  const values = event.queryStringParameters;
  if (!exactBody(values, ["domainId", "projectId"])
    || !validDomainId(values.domainId)
    || typeof values.projectId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(values.projectId)) return null;
  if (event.rawQueryString !== undefined) {
    if (typeof event.rawQueryString !== "string") return null;
    const raw = new URLSearchParams(event.rawQueryString);
    if ([...raw.keys()].length !== 2 || raw.getAll("domainId").length !== 1
      || raw.getAll("projectId").length !== 1
      || raw.get("domainId") !== values.domainId || raw.get("projectId") !== values.projectId) return null;
  }
  return { domainId: values.domainId, projectId: values.projectId };
}

function parseQuery(event, costs = false) {
  const query = event.queryStringParameters;
  if (
    query !== undefined
    && query !== null
    && !isPlainObject(query)
  ) {
    return null;
  }
  const values = query ?? {};
  const keys = Reflect.ownKeys(values);
  const allowed = ["window", "limit", "cursor", ...(costs ? ["groupBy"] : [])];
  if (
    keys.some(
      (key) =>
        typeof key !== "string"
        || !allowed.includes(key),
    )
  ) {
    return null;
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const property = ownDataProperty(values, key);
    if (!property.present || typeof property.value !== "string") {
      return null;
    }
    snapshot[key] = property.value;
  }

  if (
    event.rawQueryString !== undefined
    && typeof event.rawQueryString !== "string"
  ) {
    return null;
  }
  if (typeof event.rawQueryString === "string") {
    const raw = new URLSearchParams(event.rawQueryString);
    const rawKeys = [...raw.keys()];
    if (
      rawKeys.some(
        (key) => !allowed.includes(key),
      )
      || new Set(rawKeys).size !== rawKeys.length
      || rawKeys.length !== keys.length
      || rawKeys.some((key) => raw.get(key) !== snapshot[key])
    ) {
      return null;
    }
  }

  const window = Object.hasOwn(snapshot, "window")
    ? snapshot.window
    : "24h";
  if (!WINDOWS.has(window)) return null;
  if (Object.hasOwn(snapshot, "groupBy") && snapshot.groupBy !== "project") return null;

  let limit = 20;
  if (Object.hasOwn(snapshot, "limit")) {
    if (!/^[1-9][0-9]?$/.test(snapshot.limit)) return null;
    limit = Number(snapshot.limit);
    if (limit > MAX_PAGE_SIZE) return null;
  }
  if (
    Object.hasOwn(snapshot, "cursor")
    && !CURSOR_PATTERN.test(snapshot.cursor)
  ) {
    return null;
  }
  return {
    window,
    limit,
    ...(snapshot.groupBy ? { groupBy: snapshot.groupBy } : {}),
    ...(Object.hasOwn(snapshot, "cursor")
      ? { cursor: snapshot.cursor }
      : {}),
  };
}

function validateAuthenticatedProjection(value, subject) {
  const actor = ownDataProperty(value, "actor");
  const role = ownDataProperty(value, "role");
  if (
    !isPlainObject(value)
    || !actor.present
    || actor.value !== subject
    || !role.present
    || !ROLES.has(role.value)
  ) {
    throw new Error("Authenticated identity projection is invalid.");
  }
  return Object.freeze({
    actor: actor.value,
    role: role.value,
  });
}

function validateEffectiveProjection(
  value,
  subject,
  anticipatedRole,
  activeDomainIds,
) {
  const actor = ownDataProperty(value, "actor");
  const role = ownDataProperty(value, "role");
  const domain = ownDataProperty(value, "domain");
  if (
    !isPlainObject(value)
    || !actor.present
    || actor.value !== subject
    || !role.present
    || role.value !== anticipatedRole
    || !ROLES.has(role.value)
    || !domain.present
  ) {
    throw new Error("Effective identity projection is invalid.");
  }
  if (
    (role.value === "lead" || role.value === "builder")
    && (
      !validDomainId(domain.value)
      || !activeDomainIds.includes(domain.value)
    )
  ) {
    throw new Error("Effective domain projection is invalid.");
  }
  return Object.freeze({
    actor: actor.value,
    role: role.value,
    domain: domain.value,
  });
}

function validateDomains(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Domain directory is invalid.");
  }
  const ids = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
    ) {
      throw new Error("Domain directory is invalid.");
    }
    const domain = descriptor.value;
    if (
      !isPlainObject(domain)
      || Reflect.ownKeys(domain).length !== 1
      || !Object.hasOwn(domain, "id")
    ) {
      throw new Error("Domain directory is invalid.");
    }
    const id = ownString(domain, "id");
    if (!validDomainId(id) || ids.includes(id)) {
      throw new Error("Domain directory is invalid.");
    }
    ids.push(id);
  }
  return ids;
}

function knownIdentityCode(error) {
  if (
    error
    && error.statusCode === 403
    && [
      "DEMO_ROLE_NOT_ALLOWED",
      "DEMO_DOMAIN_REQUIRED",
      "DEMO_DOMAIN_NOT_ALLOWED",
    ].includes(error.code)
  ) {
    return error.code;
  }
  return null;
}

function mapServiceError(error) {
  if (
    error instanceof OperationsServiceError
    && Object.hasOwn(ERROR_DEFINITIONS, error.code)
  ) {
    return error.code;
  }
  if (error?.name === "AbortError") return "OPERATIONS_TIMEOUT";
  return "OPERATIONS_UNAVAILABLE";
}

export function createOperationsHandler({
  identityProjector,
  identityVerifier,
  domainDirectory,
  workspaceState,
  authorizer,
  cloudWatchProvider,
  usageProvider,
  budgetState,
  budgetDestination = null,
  budgetPublisher = null,
  platformCostsReader = null,
  clock,
  cursorSigningKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deadlineTimers = globalThis,
} = {}) {
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
  ) {
    throw new TypeError("Identity projector is invalid.");
  }
  if (typeof identityVerifier !== "function") {
    throw new TypeError("Identity verifier is invalid.");
  }
  if (
    !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
  ) {
    throw new TypeError("Domain directory is invalid.");
  }
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30_000
    || !deadlineTimers
    || typeof deadlineTimers.setTimeout !== "function"
    || typeof deadlineTimers.clearTimeout !== "function"
  ) {
    throw new TypeError("Operations timeout configuration is invalid.");
  }

  const service = {
    ...createOperationsService({
      workspaceState, authorizer, cloudWatchProvider, usageProvider, budgetState, platformCostsReader, clock, cursorSigningKey,
    }),
    ...createProjectBudgetService({
      workspaceState, budgetState, usageProvider, authorizer, clock, destination: budgetDestination,
      delivery: budgetState ? createBudgetDelivery({
        budgetState, destination: budgetDestination, publisher: budgetPublisher, clock,
      }) : undefined,
    }),
  };

  return async function operationsHandler(event = {}) {
    const method = event.requestContext?.http?.method || "";
    const path = event.requestContext?.http?.path || "";
    const requestId = event.requestContext?.requestId || "unknown";
    const route = routeFor(method, path);
    if (!route) {
      return errorResponse(
        knownPath(path) ? "INVALID_REQUEST" : "ROUTE_NOT_FOUND",
        requestId,
      );
    }
    let query;
    let requestBody;
    if (route.kind === "platform-read") {
      if (
        (event.body !== undefined && event.body !== null)
        || !hasNoQuery(event)
      ) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      query = {};
    } else if (route.kind === "aggregate" || route.kind === "list" || route.kind === "project-read") {
      if (event.body !== undefined && event.body !== null) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      query = route.kind === "project-read" ? parseBudgetQuery(event) : route.kind === "aggregate"
        ? parseQuery(event, ["costs", "operations"].includes(route.resource))
        : parseListQuery(event);
      if (!query) return errorResponse("INVALID_QUERY", requestId);
    } else {
      if (!hasNoQuery(event)) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      requestBody = decodeBody(event);
      if (!exactBody(requestBody, route.bodyKeys)) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
    }

    const requestClaims = event.requestContext?.authorizer?.jwt?.claims;
    const subject = ownString(requestClaims, "sub");
    if (
      !subject
      || !SUBJECT_PATTERN.test(subject)
      || ownString(requestClaims, "token_use") !== "access"
    ) {
      return errorResponse("NOT_AUTHENTICATED", requestId);
    }

    let authenticated;
    try {
      authenticated = validateAuthenticatedProjection(
        identityProjector.projectAuthenticated(requestClaims),
        subject,
      );
    } catch {
      return errorResponse("IDENTITY_UNAVAILABLE", requestId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    const mutationRequestHeader = route.kind === "mutation"
      ? singleHeader(event.headers, "x-request-id")
      : { present: false, value: null };
    if (roleHeader.invalid) {
      return errorResponse("DEMO_ROLE_NOT_ALLOWED", requestId);
    }
    if (domainHeader.invalid) {
      return errorResponse("DEMO_DOMAIN_NOT_ALLOWED", requestId);
    }
    if (
      route.kind === "mutation"
      && (
        mutationRequestHeader.invalid
        || !mutationRequestHeader.present
        || !REQUEST_ID_PATTERN.test(mutationRequestHeader.value)
      )
    ) {
      return errorResponse("INVALID_REQUEST_ID", requestId);
    }

    let anticipatedRole = roleHeader.present
      ? null
      : authenticated.role;
    if (!roleHeader.present && anticipatedRole === "user") {
      return errorResponse("FORBIDDEN", requestId);
    }
    if (
      !roleHeader.present
      && (anticipatedRole === "lead" || anticipatedRole === "builder")
      && !domainHeader.present
    ) {
      return errorResponse("DEMO_DOMAIN_REQUIRED", requestId);
    }

    const abortController = new AbortController();
    let timeoutHandle;
    const timeout = new Promise((_, reject) => {
      timeoutHandle = deadlineTimers.setTimeout(() => {
        abortController.abort();
        reject(new OperationsTimeoutError());
      }, timeoutMs);
    });

    const operation = (async () => {
      if (roleHeader.present) {
        let verified;
        try {
          verified = await identityVerifier(requestClaims, {
            abortSignal: abortController.signal,
          });
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          throw Object.assign(new Error("Identity unavailable."), {
            operationsCode: "IDENTITY_UNAVAILABLE",
          });
        }
        if (verified !== true || !ROLES.has(roleHeader.value)) {
          throw Object.assign(new Error("Demo role not allowed."), {
            operationsCode: "DEMO_ROLE_NOT_ALLOWED",
          });
        }
        anticipatedRole = roleHeader.value;
        if (anticipatedRole === "user") {
          throw Object.assign(new Error("Forbidden."), {
            operationsCode: "FORBIDDEN",
          });
        }
        if (
          (anticipatedRole === "lead" || anticipatedRole === "builder")
          && !domainHeader.present
        ) {
          throw Object.assign(new Error("Demo domain required."), {
            operationsCode: "DEMO_DOMAIN_REQUIRED",
          });
        }
      }

      const activeDomains = await domainDirectory.listActiveDomains({
        abortSignal: abortController.signal,
      });
      const activeDomainIds = validateDomains(activeDomains);

      let effective;
      try {
        effective = validateEffectiveProjection(
          identityProjector.projectEffective(
            requestClaims,
            event.headers,
            {
              availableDomains: activeDomains,
              availableDemoDomains: activeDomains,
            },
          ),
          subject,
          anticipatedRole,
          activeDomainIds,
        );
      } catch (error) {
        const code = knownIdentityCode(error);
        if (code) {
          throw Object.assign(new Error(code), {
            operationsCode: code,
          });
        }
        throw Object.assign(new Error("Identity unavailable."), {
          operationsCode: "IDENTITY_UNAVAILABLE",
        });
      }

      const identity = {
        actor: subject,
        role: effective.role,
        activeDomain: effective.role === "admin"
          ? (effective.domain ?? null)
          : effective.domain,
        domainIds: effective.role === "admin"
          ? activeDomainIds
          : [effective.domain],
      };
      if (route.kind === "platform-read") {
        // The consolidated AWS bill is a platform-owner view; domain leads
        // and builders keep their journal-attributed scopes on /api/costs.
        if (identity.role !== "admin") {
          throw Object.assign(new Error("Forbidden."), {
            operationsCode: "FORBIDDEN",
          });
        }
        return response(200, {
          ok: true,
          resource: route.resource,
          ...await service.readPlatformCosts({
            identity,
            abortSignal: abortController.signal,
          }),
        });
      }
      if (route.kind === "project-read") {
        return response(200, {
          ok: true,
          ...await service.readProjectBudget({ identity, ...query, abortSignal: abortController.signal }),
        });
      }
      if (route.kind === "aggregate") {
        const result = await service[route.operation]({
          identity,
          ...query,
          abortSignal: abortController.signal,
        });
        return response(200, {
          ok: true,
          resource: route.resource,
          scope: result.scope,
          window: result.window,
          items: result.items,
          cursor: result.cursor,
        });
      }
      if (route.kind === "list") {
        const result = await service[route.operation]({
          identity,
          ...query,
          abortSignal: abortController.signal,
        });
        return response(200, {
          ok: true,
          resource: route.resource,
          scope: result.scope,
          items: result.items,
          cursor: result.cursor,
        });
      }
      const result = await service[route.operation]({
        identity,
        requestId: mutationRequestHeader.value,
        ...requestBody,
        ...(route.operation === "evaluateProjectBudget" ? { abortSignal: abortController.signal } : {}),
        ...(route.incidentId
          ? { incidentId: route.incidentId }
          : {}),
      });
      return response(route.statusCode, {
        ok: true,
        ...result,
      });
    })();

    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof OperationsTimeoutError) {
        return errorResponse("OPERATIONS_TIMEOUT", requestId);
      }
      if (error?.operationsCode) {
        return errorResponse(error.operationsCode, requestId);
      }
      return errorResponse(mapServiceError(error), requestId);
    } finally {
      deadlineTimers.clearTimeout(timeoutHandle);
    }
  };
}
