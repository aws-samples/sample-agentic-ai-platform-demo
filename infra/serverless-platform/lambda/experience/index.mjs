import {
  ExperienceServiceError,
} from "./service.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PUBLIC_AGENT_ID_PATTERN = /^agent-[a-f0-9]{32}$/;
const SESSION_ID_PATTERN =
  /^session-[a-f0-9]{16}-[a-f0-9]{16}$/;
const RESULT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const COGNITO_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_GROUP_PATTERN = /^domain-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const MAX_AUTHENTICATED_GROUPS = 32;
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
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const ROUTES = Object.freeze({
  "GET /api/experience/agents": Object.freeze({
    method: "GET",
    path: "/api/experience/agents",
    operation: "listAgents",
  }),
  "POST /api/experience/invocations": Object.freeze({
    method: "POST",
    path: "/api/experience/invocations",
    operation: "invoke",
  }),
  "GET /api/experience/sessions": Object.freeze({
    method: "GET",
    path: "/api/experience/sessions",
    operation: "listSessions",
  }),
  "GET /api/experience/access-requests": Object.freeze({
    method: "GET",
    path: "/api/experience/access-requests",
    operation: "listAccessRequests",
  }),
  "POST /api/experience/feedback": Object.freeze({
    method: "POST",
    path: "/api/experience/feedback",
    operation: "submitFeedback",
  }),
  "POST /api/experience/issues": Object.freeze({
    method: "POST",
    path: "/api/experience/issues",
    operation: "reportIssue",
  }),
  "POST /api/experience/access-requests": Object.freeze({
    method: "POST",
    path: "/api/experience/access-requests",
    operation: "requestAccess",
  }),
});

const ERROR_DEFINITIONS = Object.freeze({
  NOT_AUTHENTICATED: Object.freeze({
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  }),
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The experience request is invalid.",
    retryable: false,
  }),
  INVALID_REQUEST_ID: Object.freeze({
    statusCode: 400,
    message: "A valid idempotency request ID is required.",
    retryable: false,
  }),
  INVALID_BODY: Object.freeze({
    statusCode: 400,
    message: "The request body is invalid.",
    retryable: false,
  }),
  DEMO_ROLE_NOT_ALLOWED: Object.freeze({
    statusCode: 403,
    message: "The requested demo role is not allowed.",
    retryable: false,
  }),
  DEMO_DOMAIN_NOT_ALLOWED: Object.freeze({
    statusCode: 403,
    message: "The requested demo domain is not allowed.",
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
  IDENTITY_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Identity context is temporarily unavailable.",
    retryable: true,
  }),
  EXPERIENCE_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "The end-user experience is temporarily unavailable.",
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

function ownString(value, key) {
  const property = ownDataValue(value, key);
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

function authenticatedGroups(claims) {
  const property = ownDataValue(claims, "cognito:groups");
  if (!property.present) return Object.freeze([]);
  let values = property.value;
  if (typeof values === "string") {
    const normalized = values.trim();
    if (!normalized) return Object.freeze([]);
    if (normalized.startsWith("[")) {
      try {
        values = JSON.parse(normalized);
      } catch {
        throw new Error("Authenticated groups are invalid.");
      }
    } else {
      values = normalized.split(/[,\s]+/);
    }
  }
  if (!Array.isArray(values)) {
    throw new Error("Authenticated groups are invalid.");
  }
  const length = Object.getOwnPropertyDescriptor(values, "length");
  if (
    length === undefined
    || !Object.hasOwn(length, "value")
    || !Number.isSafeInteger(length.value)
    || length.value < 0
    || length.value > MAX_AUTHENTICATED_GROUPS
  ) {
    throw new Error("Authenticated groups are invalid.");
  }
  const groups = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      values,
      String(index),
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
      || descriptor.value !== descriptor.value.trim()
      || !COGNITO_GROUP_PATTERN.test(descriptor.value)
    ) {
      throw new Error("Authenticated groups are invalid.");
    }
    groups.push(descriptor.value);
  }
  if (new Set(groups).size !== groups.length) {
    throw new Error("Authenticated groups are invalid.");
  }
  return Object.freeze(groups);
}

function entitlementDomains(groups) {
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
  return Object.freeze(domains);
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
  const definition = ERROR_DEFINITIONS[code]
    || ERROR_DEFINITIONS.EXPERIENCE_UNAVAILABLE;
  return response(definition.statusCode, {
    ok: false,
    code: Object.hasOwn(ERROR_DEFINITIONS, code)
      ? code
      : "EXPERIENCE_UNAVAILABLE",
    message: definition.message,
    requestId,
    retryable: definition.retryable,
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
    (key) => typeof key === "string" && key.toLowerCase() === name,
  );
  if (keys.length > 1) {
    return { invalid: true, present: false, value: null };
  }
  if (keys.length === 0) return { present: false, value: null };
  const property = ownDataValue(headers, keys[0]);
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

function hasNoQuery(event) {
  const query = event.queryStringParameters;
  if (
    query !== undefined
    && query !== null
    && (
      !isPlainObject(query)
      || Reflect.ownKeys(query).length !== 0
    )
  ) {
    return false;
  }
  return (
    event.rawQueryString === undefined
    || event.rawQueryString === null
    || event.rawQueryString === ""
  );
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
  } else if (
    event.isBase64Encoded === false
    || event.isBase64Encoded === undefined
  ) {
    bytes = Buffer.from(event.body, "utf8");
  } else {
    return null;
  }
  if (bytes.length > MAX_BODY_BYTES) return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strictBody(value, allowed, required) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || keys.some((key) => (
      !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
    || required.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    return null;
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  );
}

function routeFor(event) {
  const route = ROUTES[event.routeKey];
  if (
    !route
    || event.requestContext?.http?.method !== route.method
    || event.requestContext?.http?.path !== route.path
  ) {
    return null;
  }
  return route;
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
    const entry = descriptor.value;
    if (
      !isPlainObject(entry)
      || Reflect.ownKeys(entry).length !== 1
      || !Object.hasOwn(entry, "id")
    ) {
      throw new Error("Domain directory is invalid.");
    }
    const id = ownString(entry, "id");
    if (!id || !DOMAIN_ID_PATTERN.test(id) || ids.includes(id)) {
      throw new Error("Domain directory is invalid.");
    }
    ids.push(id);
  }
  return ids;
}

function authenticatedProjection(value, subject) {
  const actor = ownDataValue(value, "actor");
  const role = ownDataValue(value, "role");
  if (
    !isPlainObject(value)
    || !actor.present
    || actor.value !== subject
    || !role.present
    || !ROLES.has(role.value)
  ) {
    throw new Error("Authenticated identity is invalid.");
  }
  return { actor: subject, role: role.value };
}

function effectiveProjection(value, subject, entitlementIdentity) {
  const actor = ownDataValue(value, "actor");
  const role = ownDataValue(value, "role");
  const domain = ownDataValue(value, "domain");
  if (
    !isPlainObject(value)
    || !actor.present
    || actor.value !== subject
    || !role.present
    || role.value !== "user"
    || !domain.present
    || domain.value !== null
  ) {
    throw new Error("Effective identity is invalid.");
  }
  return Object.freeze({
    actor: subject,
    role: "user",
    activeDomain: null,
    domainIds: Object.freeze([]),
    authenticatedGroups: entitlementIdentity.groups,
    authenticatedDomains: entitlementIdentity.domains,
  });
}

function validText(value, maxLength, { allowEmpty = false } = {}) {
  return (
    typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.trim().length > 0)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function parseServiceInput(operation, body, identity, requestId) {
  if (operation === "invoke") {
    const values = strictBody(
      body,
      new Set(["agentId", "sessionId", "prompt"]),
      ["agentId", "prompt"],
    );
    if (!values) return null;
    return {
      identity,
      requestId,
      agentId: values.agentId,
      prompt: values.prompt,
      ...(values.sessionId === undefined
        ? {}
        : { sessionId: values.sessionId }),
    };
  }
  if (operation === "submitFeedback") {
    const values = strictBody(
      body,
      new Set([
        "agentId",
        "sessionId",
        "rating",
        "comment",
      ]),
      ["agentId", "sessionId", "rating", "comment"],
    );
    return values ? { identity, requestId, ...values } : null;
  }
  if (operation === "reportIssue") {
    const values = strictBody(
      body,
      new Set(["agentId", "sessionId", "description"]),
      ["agentId", "sessionId", "description"],
    );
    return values ? { identity, requestId, ...values } : null;
  }
  if (operation === "requestAccess") {
    const values = strictBody(
      body,
      new Set(["domainId", "agentId", "reason"]),
      ["domainId", "agentId", "reason"],
    );
    return values ? { identity, requestId, ...values } : null;
  }
  return null;
}

function validCatalog(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < 1
    || keys.length > 2
    || keys.some((key) =>
      key !== "items" && key !== "requestableItems")
  ) {
    return false;
  }
  const items = ownDataValue(value, "items");
  if (!items.present || !Array.isArray(items.value)) return false;
  for (let index = 0; index < items.value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      items.value,
      String(index),
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
    ) {
      return false;
    }
    const item = descriptor.value;
    if (
      !isPlainObject(item)
      || Reflect.ownKeys(item).length !== 3
      || !PUBLIC_AGENT_ID_PATTERN.test(ownString(item, "id"))
      || !validText(ownDataValue(item, "name").value, 128)
      || !validText(
        ownDataValue(item, "description").value,
        4096,
        { allowEmpty: true },
      )
    ) {
      return false;
    }
  }
  const requestableItems = ownDataValue(value, "requestableItems");
  if (!requestableItems.present) return true;
  if (!Array.isArray(requestableItems.value)) return false;
  for (
    let index = 0;
    index < requestableItems.value.length;
    index += 1
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(
      requestableItems.value,
      String(index),
    );
    const item = descriptor?.value;
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || !isPlainObject(item)
      || Reflect.ownKeys(item).length !== 4
      || !PUBLIC_AGENT_ID_PATTERN.test(ownString(item, "id"))
      || !DOMAIN_ID_PATTERN.test(ownString(item, "domainId"))
      || !validText(ownDataValue(item, "name").value, 128)
      || !validText(
        ownDataValue(item, "description").value,
        4096,
        { allowEmpty: true },
      )
    ) {
      return false;
    }
  }
  return true;
}

function validSessions(value) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== 1) {
    return false;
  }
  const items = ownDataValue(value, "items");
  if (!items.present || !Array.isArray(items.value)) return false;
  const keys = new Set([
    "id",
    "agentId",
    "status",
    "lastInvocationStatus",
    "createdAt",
    "updatedAt",
  ]);
  for (let index = 0; index < items.value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      items.value,
      String(index),
    );
    const item = descriptor?.value;
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || !isPlainObject(item)
      || Reflect.ownKeys(item).length !== keys.size
      || Reflect.ownKeys(item).some(
        (key) => typeof key !== "string" || !keys.has(key),
      )
      || !SESSION_ID_PATTERN.test(ownString(item, "id"))
      || !PUBLIC_AGENT_ID_PATTERN.test(ownString(item, "agentId"))
      || !new Set([
        "ACTIVE",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
      ]).has(ownString(item, "status"))
      || !(
        ownDataValue(item, "lastInvocationStatus").value === null
        || ownString(item, "lastInvocationStatus") === "SUCCEEDED"
        || ownString(item, "lastInvocationStatus") === "FAILED"
      )
      || !Number.isFinite(Date.parse(ownString(item, "createdAt")))
      || !Number.isFinite(Date.parse(ownString(item, "updatedAt")))
    ) {
      return false;
    }
  }
  return true;
}

function validAccessRequests(value) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== 1) {
    return false;
  }
  const items = ownDataValue(value, "items");
  if (!items.present || !Array.isArray(items.value)) return false;
  const keys = new Set([
    "id",
    "domainId",
    "agentId",
    "status",
    "reason",
    "requestedAt",
    "decidedAt",
  ]);
  for (let index = 0; index < items.value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      items.value,
      String(index),
    );
    const item = descriptor?.value;
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || !isPlainObject(item)
      || Reflect.ownKeys(item).length !== keys.size
      || Reflect.ownKeys(item).some(
        (key) => typeof key !== "string" || !keys.has(key),
      )
      || !RESULT_ID_PATTERN.test(ownString(item, "id"))
      || !DOMAIN_ID_PATTERN.test(ownString(item, "domainId"))
      || !PUBLIC_AGENT_ID_PATTERN.test(ownString(item, "agentId"))
      || !new Set([
        "PENDING",
        "APPROVED",
        "REJECTED",
        "CANCELLED",
      ]).has(ownString(item, "status"))
      || !validText(
        ownDataValue(item, "reason").value,
        1024,
        { allowEmpty: true },
      )
      || !Number.isFinite(Date.parse(ownString(item, "requestedAt")))
      || !(
        ownDataValue(item, "decidedAt").value === null
        || Number.isFinite(Date.parse(ownString(item, "decidedAt")))
      )
    ) {
      return false;
    }
  }
  return true;
}

function validInvocation(value) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== 5) {
    return false;
  }
  const sessionId = ownString(value, "sessionId");
  const status = ownString(value, "status");
  const output = ownDataValue(value, "output");
  const invocationId = ownDataValue(value, "invocationId");
  const replayed = ownDataValue(value, "replayed");
  return Boolean(
    SESSION_ID_PATTERN.test(sessionId)
    && status === "SUCCEEDED"
    && output.present
    && (
      output.value === null
      || (
        typeof output.value === "string"
        && Buffer.byteLength(output.value, "utf8") <= 64 * 1024
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
          output.value,
        )
      )
    )
    && invocationId.present
    && (
      invocationId.value === null
      || (
        typeof invocationId.value === "string"
        && RESULT_ID_PATTERN.test(invocationId.value)
      )
    )
    && replayed.present
    && typeof replayed.value === "boolean"
  );
}

function validSubmission(value, operation) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== 2) {
    return false;
  }
  const id = ownString(value, "id");
  const status = ownString(value, "status");
  return Boolean(
    RESULT_ID_PATTERN.test(id)
    && status === (
      operation === "requestAccess" ? "PENDING" : "RECORDED"
    ),
  );
}

function validatedResponse(operation, value) {
  if (operation === "listAgents" && validCatalog(value)) {
    return {
      ok: true,
      items: value.items,
      ...(Object.hasOwn(value, "requestableItems")
        ? { requestableItems: value.requestableItems }
        : {}),
    };
  }
  if (operation === "listSessions" && validSessions(value)) {
    return { ok: true, items: value.items };
  }
  if (
    operation === "listAccessRequests"
    && validAccessRequests(value)
  ) {
    return { ok: true, items: value.items };
  }
  if (operation === "invoke" && validInvocation(value)) {
    return { ok: true, ...value };
  }
  if (
    ["submitFeedback", "reportIssue", "requestAccess"].includes(operation)
    && validSubmission(value, operation)
  ) {
    return { ok: true, ...value };
  }
  return null;
}

export function createExperienceHandler({
  identityProjector,
  identityVerifier,
  groupDirectory,
  domainDirectory,
  experienceService,
} = {}) {
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
    || typeof identityVerifier !== "function"
    || !groupDirectory
    || typeof groupDirectory.resolveCurrentGroups !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !experienceService
    || ![
      "listAgents",
      "invoke",
      "listSessions",
      "listAccessRequests",
      "submitFeedback",
      "reportIssue",
      "requestAccess",
    ].every((method) => typeof experienceService[method] === "function")
  ) {
    throw new TypeError("Experience handler configuration is invalid.");
  }

  return async function experienceHandler(event = {}) {
    const correlationId =
      event.requestContext?.requestId || "unknown";
    const route = routeFor(event);
    if (!route) return errorResponse("ROUTE_NOT_FOUND", correlationId);
    if (!hasNoQuery(event)) {
      return errorResponse("INVALID_REQUEST", correlationId);
    }
    if (
      route.method === "GET"
      && event.body !== undefined
      && event.body !== null
    ) {
      return errorResponse("INVALID_REQUEST", correlationId);
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
    let authenticatedGroupList;
    try {
      authenticated = authenticatedProjection(
        identityProjector.projectAuthenticated(claims),
        subject,
      );
      authenticatedGroupList = authenticatedGroups({
        "cognito:groups":
          await groupDirectory.resolveCurrentGroups(claims),
      });
    } catch {
      return errorResponse("IDENTITY_UNAVAILABLE", correlationId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    if (
      roleHeader.invalid
      || (roleHeader.present && !ROLES.has(roleHeader.value))
    ) {
      return errorResponse("DEMO_ROLE_NOT_ALLOWED", correlationId);
    }
    if (domainHeader.invalid) {
      return errorResponse(
        "DEMO_DOMAIN_NOT_ALLOWED",
        correlationId,
      );
    }
    const anticipatedRole = roleHeader.present
      ? roleHeader.value
      : authenticated.role;
    if (anticipatedRole !== "user" || domainHeader.present) {
      return errorResponse("FORBIDDEN", correlationId);
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
    let activeDomainIds;
    try {
      domains = await domainDirectory.listActiveDomains();
      activeDomainIds = validateDomains(domains);
    } catch {
      return errorResponse("IDENTITY_UNAVAILABLE", correlationId);
    }
    let identity;
    try {
      identity = effectiveProjection(
        identityProjector.projectEffective(
          claims,
          event.headers,
          {
            availableDomains: domains,
            availableDemoDomains: domains,
          },
        ),
        subject,
        Object.freeze({
          groups: authenticatedGroupList,
          domains: Object.freeze(
            entitlementDomains(authenticatedGroupList)
              .filter((domainId) => activeDomainIds.includes(domainId)),
          ),
        }),
      );
    } catch (error) {
      if (
        error?.statusCode === 403
        && error?.code === "DEMO_ROLE_NOT_ALLOWED"
      ) {
        return errorResponse(error.code, correlationId);
      }
      return errorResponse("IDENTITY_UNAVAILABLE", correlationId);
    }

    let serviceInput = { identity };
    if (route.method === "POST") {
      const requestHeader = singleHeader(
        event.headers,
        "x-request-id",
      );
      if (
        requestHeader.invalid
        || !requestHeader.present
        || !REQUEST_ID_PATTERN.test(requestHeader.value)
      ) {
        return errorResponse(
          "INVALID_REQUEST_ID",
          correlationId,
        );
      }
      const contentType = singleHeader(
        event.headers,
        "content-type",
      );
      if (
        contentType.invalid
        || !contentType.present
        || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          contentType.value,
        )
      ) {
        return errorResponse("INVALID_BODY", correlationId);
      }
      const body = decodeBody(event);
      if (!body) return errorResponse("INVALID_BODY", correlationId);
      serviceInput = parseServiceInput(
        route.operation,
        body,
        identity,
        requestHeader.value,
      );
      if (!serviceInput) {
        return errorResponse("INVALID_BODY", correlationId);
      }
    }

    try {
      const result = await experienceService[route.operation](
        serviceInput,
      );
      const body = validatedResponse(route.operation, result);
      if (!body) {
        return errorResponse(
          "EXPERIENCE_UNAVAILABLE",
          correlationId,
        );
      }
      const statusCode = [
        "submitFeedback",
        "reportIssue",
        "requestAccess",
      ].includes(route.operation)
        ? 201
        : 200;
      return response(statusCode, body);
    } catch (error) {
      if (
        error instanceof ExperienceServiceError
        && Object.hasOwn(ERROR_DEFINITIONS, error.code)
      ) {
        return errorResponse(error.code, correlationId);
      }
      return errorResponse("EXPERIENCE_UNAVAILABLE", correlationId);
    }
  };
}
