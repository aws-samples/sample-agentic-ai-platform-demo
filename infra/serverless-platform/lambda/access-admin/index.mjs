import {
  AccessAdminServiceError,
} from "./service.mjs";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;
const USER_STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MEMBERS = 50;

const ROUTES = Object.freeze({
  "GET /api/access/domain-members": Object.freeze({
    operation: "listDomainMembers",
    kind: "domain-list",
    statusCode: 200,
  }),
  "POST /api/access/domain-memberships": Object.freeze({
    operation: "grantDomainMembership",
    kind: "domain-mutation",
    statusCode: 201,
    bodyKeys: Object.freeze(["domainId", "username", "reason"]),
  }),
  "POST /api/access/domain-membership-revocations": Object.freeze({
    operation: "revokeDomainMembership",
    kind: "domain-mutation",
    statusCode: 200,
    bodyKeys: Object.freeze(["domainId", "username", "reason"]),
  }),
  "GET /api/access/project-members": Object.freeze({
    operation: "listProjectMembers",
    kind: "project-list",
    statusCode: 200,
  }),
  "POST /api/access/project-memberships": Object.freeze({
    operation: "grantProjectMembership",
    kind: "project-mutation",
    statusCode: 201,
    bodyKeys: Object.freeze([
      "domainId",
      "projectId",
      "username",
      "reason",
    ]),
  }),
  "POST /api/access/project-membership-revocations": Object.freeze({
    operation: "revokeProjectMembership",
    kind: "project-mutation",
    statusCode: 200,
    bodyKeys: Object.freeze([
      "domainId",
      "projectId",
      "username",
      "reason",
    ]),
  }),
});

const ERROR_DETAILS = Object.freeze({
  NOT_AUTHENTICATED: Object.freeze({
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  }),
  INVALID_QUERY: Object.freeze({
    statusCode: 400,
    message: "The access administration query is invalid.",
    retryable: false,
  }),
  INVALID_BODY: Object.freeze({
    statusCode: 400,
    message: "The access administration request body is invalid.",
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
    message: "The requested access administration action is not allowed.",
    retryable: false,
  }),
  IDENTITY_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Identity context is temporarily unavailable.",
    retryable: true,
  }),
  ACCESS_ADMIN_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Access administration is temporarily unavailable.",
    retryable: true,
  }),
  ROUTE_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  }),
});

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

function ownString(value, key) {
  const property = ownValue(value, key);
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
  const items = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    items.push(descriptor.value);
  }
  return items;
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
  const detail = ERROR_DETAILS[code]
    || ERROR_DETAILS.ACCESS_ADMIN_UNAVAILABLE;
  return response(detail.statusCode, {
    ok: false,
    code: Object.hasOwn(ERROR_DETAILS, code)
      ? code
      : "ACCESS_ADMIN_UNAVAILABLE",
    message: detail.message,
    requestId,
    retryable: detail.retryable,
  });
}

function singleHeader(headers, expectedName) {
  if (headers === undefined || headers === null) {
    return { present: false, value: null };
  }
  if (!isPlainObject(headers)) return { invalid: true };
  const keys = Reflect.ownKeys(headers).filter(
    (key) =>
      typeof key === "string"
      && key.toLowerCase() === expectedName,
  );
  if (keys.length > 1) return { invalid: true };
  if (keys.length === 0) return { present: false, value: null };
  const value = ownString(headers, keys[0]);
  return value === null
    ? { invalid: true }
    : { present: true, value };
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
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes);
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

function exactDataObject(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size
    && keys.every((key) => {
      if (typeof key !== "string" || !expected.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && Object.hasOwn(descriptor, "value"));
    })
  );
}

function safeMember(value) {
  if (
    !exactDataObject(
      value,
      new Set(["username", "subject", "enabled", "userStatus"]),
    )
  ) {
    return null;
  }
  const username = ownValue(value, "username").value;
  const subject = ownValue(value, "subject").value;
  const enabled = ownValue(value, "enabled").value;
  const userStatus = ownValue(value, "userStatus").value;
  if (
    typeof username !== "string"
    || !USERNAME_PATTERN.test(username)
    || typeof subject !== "string"
    || !SUBJECT_PATTERN.test(subject)
    || typeof enabled !== "boolean"
    || typeof userStatus !== "string"
    || !USER_STATUS_PATTERN.test(userStatus)
  ) {
    return null;
  }
  return { username, subject, enabled, userStatus };
}

function safeMembers(value) {
  const members = boundedArray(value, MAX_MEMBERS);
  if (members === null) return null;
  const items = members.map(safeMember);
  if (
    items.some((item) => item === null)
    || new Set(items.map(({ username }) => username)).size !== items.length
    || new Set(items.map(({ subject }) => subject)).size !== items.length
  ) {
    return null;
  }
  return items;
}

function safeCursor(value) {
  return value === null
    || (
      typeof value === "string"
      && CURSOR_PATTERN.test(value)
    )
    ? value
    : undefined;
}

function safeListResult(value, projectScoped) {
  const expected = new Set([
    "domainId",
    ...(projectScoped ? ["projectId"] : []),
    "items",
    "cursor",
  ]);
  if (!exactDataObject(value, expected)) return null;
  const domainId = ownValue(value, "domainId").value;
  const projectId = projectScoped
    ? ownValue(value, "projectId").value
    : undefined;
  const items = safeMembers(ownValue(value, "items").value);
  const cursor = safeCursor(ownValue(value, "cursor").value);
  if (
    typeof domainId !== "string"
    || !DOMAIN_PATTERN.test(domainId)
    || (
      projectScoped
      && (
        typeof projectId !== "string"
        || !SLUG_PATTERN.test(projectId)
      )
    )
    || items === null
    || cursor === undefined
  ) {
    return null;
  }
  return {
    domainId,
    ...(projectScoped ? { projectId } : {}),
    items,
    cursor,
  };
}

function safeMutationResult(value, projectScoped, expectedStatus) {
  const expected = new Set([
    "domainId",
    ...(projectScoped ? ["projectId"] : []),
    "username",
    "subject",
    "status",
    "changed",
  ]);
  if (!exactDataObject(value, expected)) return null;
  const domainId = ownValue(value, "domainId").value;
  const projectId = projectScoped
    ? ownValue(value, "projectId").value
    : undefined;
  const username = ownValue(value, "username").value;
  const subject = ownValue(value, "subject").value;
  const status = ownValue(value, "status").value;
  const changed = ownValue(value, "changed").value;
  if (
    typeof domainId !== "string"
    || !DOMAIN_PATTERN.test(domainId)
    || (
      projectScoped
      && (
        typeof projectId !== "string"
        || !SLUG_PATTERN.test(projectId)
      )
    )
    || typeof username !== "string"
    || !USERNAME_PATTERN.test(username)
    || typeof subject !== "string"
    || !SUBJECT_PATTERN.test(subject)
    || status !== expectedStatus
    || typeof changed !== "boolean"
  ) {
    return null;
  }
  return {
    domainId,
    ...(projectScoped ? { projectId } : {}),
    username,
    subject,
    status,
    changed,
  };
}

function safeServiceResult(route, value) {
  if (route.kind === "domain-list") {
    return safeListResult(value, false);
  }
  if (route.kind === "project-list") {
    return safeListResult(value, true);
  }
  return safeMutationResult(
    value,
    route.kind === "project-mutation",
    route.operation.startsWith("grant") ? "ACTIVE" : "REVOKED",
  );
}

function validReason(value) {
  return (
    typeof value === "string"
    && value.length >= 3
    && value.length <= 1024
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validBody(body, projectScoped) {
  return (
    typeof body.domainId === "string"
    && DOMAIN_PATTERN.test(body.domainId)
    && (
      !projectScoped
      || (
        typeof body.projectId === "string"
        && SLUG_PATTERN.test(body.projectId)
      )
    )
    && typeof body.username === "string"
    && USERNAME_PATTERN.test(body.username)
    && validReason(body.reason)
  );
}

function noQuery(event) {
  const query = event.queryStringParameters;
  return (
    (
      query === undefined
      || query === null
      || (
        isPlainObject(query)
        && Reflect.ownKeys(query).length === 0
      )
    )
    && (
      event.rawQueryString === undefined
      || event.rawQueryString === ""
    )
  );
}

function rawQueryMatches(rawQueryString, query, allowed) {
  if (rawQueryString === undefined || rawQueryString === "") {
    return Reflect.ownKeys(query).length === 0;
  }
  if (typeof rawQueryString !== "string") return false;
  const params = new URLSearchParams(rawQueryString);
  const names = [...new Set(params.keys())];
  if (
    names.some(
      (name) =>
        !allowed.has(name)
        || params.getAll(name).length !== 1
        || !Object.hasOwn(query, name)
        || query[name] !== params.get(name),
    )
    || Reflect.ownKeys(query).some(
      (name) =>
        typeof name !== "string" || !names.includes(name),
    )
  ) {
    return false;
  }
  return true;
}

function parseListQuery(event, projectScoped) {
  const query = event.queryStringParameters ?? {};
  if (!isPlainObject(query)) return null;
  const allowed = projectScoped
    ? new Set(["domainId", "projectId", "limit", "cursor"])
    : new Set(["domainId", "limit", "cursor"]);
  const keys = Reflect.ownKeys(query);
  if (
    keys.some(
      (key) =>
        typeof key !== "string"
        || !allowed.has(key)
        || typeof ownValue(query, key).value !== "string",
    )
    || !rawQueryMatches(event.rawQueryString, query, allowed)
  ) {
    return null;
  }
  if (
    Object.hasOwn(query, "domainId")
    && !DOMAIN_PATTERN.test(query.domainId)
  ) {
    return null;
  }
  if (
    projectScoped
    && (
      !Object.hasOwn(query, "projectId")
      || !SLUG_PATTERN.test(query.projectId)
    )
  ) {
    return null;
  }
  if (
    Object.hasOwn(query, "limit")
    && (
      !/^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit)
      || Number(query.limit) < 1
      || Number(query.limit) > 50
    )
  ) {
    return null;
  }
  if (
    Object.hasOwn(query, "cursor")
    && !CURSOR_PATTERN.test(query.cursor)
  ) {
    return null;
  }
  return {
    ...(Object.hasOwn(query, "domainId")
      ? { domainId: query.domainId }
      : {}),
    ...(projectScoped ? { projectId: query.projectId } : {}),
    limit: Object.hasOwn(query, "limit")
      ? Number(query.limit)
      : 20,
    ...(Object.hasOwn(query, "cursor")
      ? { cursor: query.cursor }
      : {}),
  };
}

function validateDomains(value) {
  const domains = boundedArray(value, 100);
  if (domains === null) throw new TypeError("Invalid domain directory.");
  const ids = [];
  for (const domain of domains) {
    const id = ownString(domain, "id");
    if (!id || !DOMAIN_PATTERN.test(id) || ids.includes(id)) {
      throw new TypeError("Invalid domain directory.");
    }
    ids.push(id);
  }
  return ids;
}

function validateAuthenticated(value, subject) {
  const actor = ownString(value, "actor");
  const role = ownString(value, "role");
  if (
    actor !== subject
    || !role
    || !ROLES.has(role)
  ) {
    throw new TypeError("Invalid authenticated identity.");
  }
  return { actor, role };
}

function validateEffective(
  value,
  subject,
  anticipatedRole,
  availableDomainIds,
) {
  const actor = ownString(value, "actor");
  const role = ownString(value, "role");
  const domain = ownValue(value, "domain");
  const projectedDomains = boundedArray(
    ownValue(value, "domains").value,
    100,
  );
  if (
    actor !== subject
    || role !== anticipatedRole
    || !domain.present
    || projectedDomains === null
    || projectedDomains.some(
      (domainId) =>
        typeof domainId !== "string"
        || !DOMAIN_PATTERN.test(domainId)
        || !availableDomainIds.includes(domainId),
    )
    || new Set(projectedDomains).size !== projectedDomains.length
  ) {
    throw new TypeError("Invalid effective identity.");
  }
  if (
    (role === "lead" || role === "builder")
    && (
      typeof domain.value !== "string"
      || projectedDomains.length !== 1
      || projectedDomains[0] !== domain.value
    )
  ) {
    throw new TypeError("Invalid domain identity.");
  }
  if (
    role === "admin"
    && (
      domain.value !== null
      && (
        typeof domain.value !== "string"
        || !availableDomainIds.includes(domain.value)
      )
    )
  ) {
    throw new TypeError("Invalid admin identity.");
  }
  if (role === "user") {
    throw new TypeError("Unsupported access administration identity.");
  }
  return Object.freeze({
    actor,
    role,
    activeDomain: domain.value,
    domainIds: Object.freeze([
      ...(role === "admin" ? availableDomainIds : projectedDomains),
    ]),
  });
}

function knownIdentityCode(error) {
  if (
    error?.statusCode === 403
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

export function createAccessAdminHandler({
  identityProjector,
  identityVerifier,
  domainDirectory,
  accessAdminService,
} = {}) {
  const methods = [
    "listDomainMembers",
    "grantDomainMembership",
    "revokeDomainMembership",
    "listProjectMembers",
    "grantProjectMembership",
    "revokeProjectMembership",
  ];
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
    || typeof identityVerifier !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !accessAdminService
    || methods.some(
      (method) => typeof accessAdminService[method] !== "function",
    )
  ) {
    throw new TypeError(
      "Access administration handler configuration is invalid.",
    );
  }

  return async function accessAdminHandler(event = {}) {
    const correlationId = event.requestContext?.requestId || "unknown";
    const method = event.requestContext?.http?.method;
    const path = event.requestContext?.http?.path;
    const route = ROUTES[`${method} ${path}`];
    if (!route) {
      return errorResponse("ROUTE_NOT_FOUND", correlationId);
    }

    const isList = route.kind.endsWith("-list");
    let query;
    let body;
    const requestHeader = singleHeader(event.headers, "x-request-id");
    if (isList) {
      if (event.body !== undefined && event.body !== null) {
        return errorResponse("INVALID_BODY", correlationId);
      }
      query = parseListQuery(
        event,
        route.kind === "project-list",
      );
      if (query === null) {
        return errorResponse("INVALID_QUERY", correlationId);
      }
      if (requestHeader.invalid) {
        return errorResponse("INVALID_REQUEST_ID", correlationId);
      }
    } else {
      if (!noQuery(event)) {
        return errorResponse("INVALID_QUERY", correlationId);
      }
      if (
        requestHeader.invalid
        || !requestHeader.present
        || !REQUEST_ID_PATTERN.test(requestHeader.value)
      ) {
        return errorResponse("INVALID_REQUEST_ID", correlationId);
      }
      body = decodeBody(event);
      if (
        !exactBody(body, route.bodyKeys)
        || !validBody(
          body,
          route.kind === "project-mutation",
        )
      ) {
        return errorResponse("INVALID_BODY", correlationId);
      }
    }

    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const subject = ownString(claims, "sub");
    if (
      !subject
      || !SUBJECT_PATTERN.test(subject)
      || ownString(claims, "token_use") !== "access"
    ) {
      return errorResponse("NOT_AUTHENTICATED", correlationId);
    }
    let authenticated;
    try {
      authenticated = validateAuthenticated(
        identityProjector.projectAuthenticated(claims),
        subject,
      );
    } catch {
      return errorResponse("IDENTITY_UNAVAILABLE", correlationId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    if (
      roleHeader.invalid
      || (
        roleHeader.present
        && !ROLES.has(roleHeader.value)
      )
    ) {
      return errorResponse("DEMO_ROLE_NOT_ALLOWED", correlationId);
    }
    if (
      domainHeader.invalid
      || (
        domainHeader.present
        && !DOMAIN_PATTERN.test(domainHeader.value)
      )
    ) {
      return errorResponse("DEMO_DOMAIN_NOT_ALLOWED", correlationId);
    }
    const anticipatedRole = roleHeader.present
      ? roleHeader.value
      : authenticated.role;
    if (anticipatedRole === "builder" || anticipatedRole === "user") {
      return errorResponse("FORBIDDEN", correlationId);
    }
    if (anticipatedRole === "lead" && !domainHeader.present) {
      return errorResponse("DEMO_DOMAIN_REQUIRED", correlationId);
    }
    if (roleHeader.present) {
      try {
        if (await identityVerifier(claims) !== true) {
          return errorResponse(
            "DEMO_ROLE_NOT_ALLOWED",
            correlationId,
          );
        }
      } catch {
        return errorResponse("IDENTITY_UNAVAILABLE", correlationId);
      }
    }

    let domains;
    let domainIds;
    try {
      domains = await domainDirectory.listActiveDomains();
      domainIds = validateDomains(domains);
    } catch {
      return errorResponse("IDENTITY_UNAVAILABLE", correlationId);
    }

    let identity;
    try {
      identity = validateEffective(
        identityProjector.projectEffective(
          claims,
          event.headers,
          {
            availableDomains: domains,
            availableDemoDomains: domains,
          },
        ),
        subject,
        anticipatedRole,
        domainIds,
      );
    } catch (error) {
      return errorResponse(
        knownIdentityCode(error) || "IDENTITY_UNAVAILABLE",
        correlationId,
      );
    }

    const serviceInput = isList
      ? { identity, ...query }
      : {
          identity,
          requestId: requestHeader.value,
          ...body,
        };
    try {
      const serviceResult = await accessAdminService[route.operation](
        serviceInput,
      );
      const result = safeServiceResult(route, serviceResult);
      if (result === null) {
        return errorResponse(
          "ACCESS_ADMIN_UNAVAILABLE",
          correlationId,
        );
      }
      return response(route.statusCode, { ok: true, ...result });
    } catch (error) {
      if (error instanceof AccessAdminServiceError) {
        return response(error.statusCode, {
          ok: false,
          code: error.code,
          message: error.message,
          requestId: correlationId,
          retryable: error.retryable === true,
        });
      }
      return errorResponse("ACCESS_ADMIN_UNAVAILABLE", correlationId);
    }
  };
}
