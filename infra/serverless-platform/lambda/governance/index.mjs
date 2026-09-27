import {
  GovernanceServiceError,
} from "./service.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ENTITLEMENT_SUBJECT_TYPES = new Set(["USER", "GROUP", "DOMAIN"]);
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const ROUTES = Object.freeze({
  "GET /api/governance/guardrails": "readGuardrails",
  "GET /api/policy-exemptions": "listGuardrailExceptions",
  "POST /api/policy-exemption-request": "requestGuardrailException",
  "POST /api/policy-exemption-decide": "decideGuardrailException",
  "GET /api/alerts": "readAlertPolicies",
  "POST /api/governance/alert-drafts": "saveAlertDraft",
  "POST /api/governance/policy-drafts": "savePolicyDraft",
  "GET /api/governance/publication-context": "readPublicationContext",
  "GET /api/hitl": "readHitlPolicies",
  "POST /api/governance/agent-publications": "publishAgent",
  "POST /api/governance/resources": "registerDraft",
  "POST /api/governance/publications": "submitPublication",
  "POST /api/governance/publication-initiations": "initiatePublication",
  "POST /api/governance/publication-decisions": "decidePublication",
  "GET /api/governance/shared-resources": "discoverShared",
  "POST /api/governance/catalog-visibility": "setCatalogVisibility",
  "GET /api/governance/catalog-visibility": "readCatalogVisibility",
  "GET /api/governance/agent-entitlements": "listAgentEntitlements",
  "POST /api/governance/access-requests": "requestAccess",
  "POST /api/governance/access-decisions": "decideAccess",
  "POST /api/governance/access-revocations": "revokeAccess",
  "POST /api/governance/agent-entitlements": "grantAgentEntitlement",
  "POST /api/governance/agent-entitlement-revocations":
    "revokeAgentEntitlement",
});
const BODY_KEYS = Object.freeze({
  requestGuardrailException: ["domainId", "projectId", "guardrailId", "reason", "compensatingControls", "expiresAt"],
  decideGuardrailException: ["domainId", "id", "decision", "reason"],
  saveAlertDraft: ["operation", "expectedRevision", "expectedPolicyVersion", "policy", "reason"],
  savePolicyDraft: ["operation", "expectedRevision", "expectedPolicyVersion", "policy", "reason"],
  publishAgent: [
    "domainId",
    "projectId",
    "agentId",
  ],
  registerDraft: [
    "domainId",
    "resourceType",
    "resourceId",
    "displayName",
    "description",
    "version",
    "shared",
    "specification",
  ],
  submitPublication: [
    "approvalId",
    "registryId",
    "recordId",
  ],
  initiatePublication: [
    "registryId",
    "recordId",
    "reason",
  ],
  decidePublication: [
    "approvalId",
    "decision",
    "reason",
  ],
  setCatalogVisibility: [
    "registryId",
    "recordId",
    "mode",
    "allowedDomainIds",
    "reason",
  ],
  requestAccess: [
    "approvalId",
    "sourceDomainId",
    "registryId",
    "recordId",
  ],
  decideAccess: [
    "approvalId",
    "decision",
    "reason",
  ],
  revokeAccess: [
    "resourceType",
    "resourceId",
    "reason",
  ],
  grantAgentEntitlement: [
    "domainId",
    "projectId",
    "agentId",
    "subjectType",
    "subject",
    "expiresAt",
    "reason",
  ],
  revokeAgentEntitlement: [
    "domainId",
    "projectId",
    "agentId",
    "subjectType",
    "subject",
    "reason",
  ],
});
const ERROR_DETAILS = Object.freeze({
  NOT_AUTHENTICATED: {
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested governance action is not allowed.",
    retryable: false,
  },
  DEMO_ROLE_NOT_ALLOWED: {
    statusCode: 403,
    message: "The requested demo role is not allowed.",
    retryable: false,
  },
  DEMO_DOMAIN_REQUIRED: {
    statusCode: 403,
    message: "An available demo domain is required.",
    retryable: false,
  },
  DEMO_DOMAIN_NOT_ALLOWED: {
    statusCode: 403,
    message: "The requested demo domain is not allowed.",
    retryable: false,
  },
  INVALID_REQUEST_ID: {
    statusCode: 400,
    message: "A valid idempotency request ID is required.",
    retryable: false,
  },
  INVALID_BODY: {
    statusCode: 400,
    message: "The governance request body is invalid.",
    retryable: false,
  },
  INVALID_QUERY: {
    statusCode: 400,
    message: "The governance query is invalid.",
    retryable: false,
  },
  ROUTE_NOT_FOUND: {
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  },
  GOVERNANCE_UNAVAILABLE: {
    statusCode: 503,
    message: "Governance is temporarily unavailable.",
    retryable: true,
  },
});

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

function ownString(value, key) {
  if (!isPlainObject(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    !descriptor
    || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "string"
    || descriptor.value.length === 0
    || descriptor.value !== descriptor.value.trim()
    || /[\u0000-\u001f\u007f]/.test(descriptor.value)
  ) {
    return null;
  }
  return descriptor.value;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

function errorResponse(code, requestId) {
  const detail = ERROR_DETAILS[code] || ERROR_DETAILS.GOVERNANCE_UNAVAILABLE;
  return response(detail.statusCode, {
    ok: false,
    code: Object.hasOwn(ERROR_DETAILS, code)
      ? code
      : "GOVERNANCE_UNAVAILABLE",
    message: detail.message,
    requestId,
    retryable: detail.retryable,
  });
}

function singleHeader(headers, expected) {
  if (headers === undefined || headers === null) {
    return { present: false, value: null };
  }
  if (!isPlainObject(headers)) return { invalid: true };
  const keys = Reflect.ownKeys(headers).filter(
    (key) =>
      typeof key === "string" && key.toLowerCase() === expected,
  );
  if (keys.length > 1) return { invalid: true };
  if (keys.length === 0) return { present: false, value: null };
  const descriptor = Object.getOwnPropertyDescriptor(headers, keys[0]);
  if (
    !descriptor
    || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "string"
    || descriptor.value.length === 0
    || descriptor.value !== descriptor.value.trim()
    || /[\u0000-\u001f\u007f]/.test(descriptor.value)
  ) {
    return { invalid: true };
  }
  return { present: true, value: descriptor.value };
}

function decodeBody(event) {
  if (typeof event.body !== "string" || event.body.length === 0) return null;
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

function validText(value, minimum, maximum) {
  return (
    typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validTimestamp(value) {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validEntitlementSubject(subjectType, subject) {
  if (!ENTITLEMENT_SUBJECT_TYPES.has(subjectType)) return false;
  if (typeof subject !== "string") return false;
  if (subjectType === "DOMAIN") return DOMAIN_PATTERN.test(subject);
  return (
    subjectType === "GROUP"
      ? GROUP_PATTERN.test(subject)
      : SUBJECT_PATTERN.test(subject)
  );
}

function validEntitlementBody(operation, body) {
  if (
    typeof body.domainId !== "string"
    || !DOMAIN_PATTERN.test(body.domainId)
    || typeof body.projectId !== "string"
    || !SLUG_PATTERN.test(body.projectId)
    || typeof body.agentId !== "string"
    || !SLUG_PATTERN.test(body.agentId)
    || !validEntitlementSubject(body.subjectType, body.subject)
    || !validText(body.reason, 3, 1024)
  ) {
    return false;
  }
  return operation !== "grantAgentEntitlement"
    || validTimestamp(body.expiresAt);
}

function validCursor(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4096
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function parseQuery(event, operation) {
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
  const allowed = ["readGuardrails", "readAlertPolicies", "readCatalogVisibility"].includes(operation) ? new Set([]) : operation === "readPublicationContext"
    ? new Set(["registryId", "recordId"])
    : ["listGuardrailExceptions", "listAgentEntitlements", "readHitlPolicies"].includes(operation)
    ? new Set(["limit", "cursor"])
    : new Set(["limit"]);
  if (
    keys.some(
      (key) =>
        typeof key !== "string"
        || !allowed.has(key)
        || typeof values[key] !== "string",
    )
    || keys.length > allowed.size
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
        (key) => !allowed.has(key) || raw.get(key) !== values[key],
      )
    ) {
      return null;
    }
  }
  if (["readGuardrails", "readAlertPolicies", "readCatalogVisibility"].includes(operation)) return {};
  if (operation === "readPublicationContext") return keys.length === 2
    && /^[A-Za-z0-9]{12,16}$/.test(values.registryId)
    && /^[A-Za-z0-9]{12}$/.test(values.recordId)
    ? { registryId: values.registryId, recordId: values.recordId } : null;
  const limitValue = Object.hasOwn(values, "limit")
    ? values.limit
    : "20";
  if (!/^[1-9][0-9]?$/.test(limitValue)) return null;
  const limit = Number(limitValue);
  if (limit > 50) return null;
  if (
    Object.hasOwn(values, "cursor")
    && !validCursor(values.cursor)
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

function validateDomains(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Domain directory is invalid.");
  }
  const ids = [];
  for (const item of value) {
    if (
      !isPlainObject(item)
      || Reflect.ownKeys(item).length !== 1
      || !DOMAIN_PATTERN.test(item.id)
      || ids.includes(item.id)
    ) {
      throw new Error("Domain directory is invalid.");
    }
    ids.push(item.id);
  }
  return ids;
}

function validateEffective(value, subject, role, domainIds) {
  if (
    !isPlainObject(value)
    || value.actor !== subject
    || value.role !== role
    || !ROLES.has(value.role)
  ) {
    throw new Error("Effective identity is invalid.");
  }
  if (
    (role === "lead" || role === "builder")
    && (
      !DOMAIN_PATTERN.test(value.domain)
      || !domainIds.includes(value.domain)
    )
  ) {
    throw new Error("Effective identity is invalid.");
  }
  return {
    actor: subject,
    role,
    activeDomain: role === "admin" ? (value.domain ?? null) : value.domain,
    domainIds: role === "admin"
      ? domainIds
      : role === "user"
        ? []
        : [value.domain],
  };
}

function operationFromEvent(event) {
  const operation = ROUTES[event.routeKey];
  if (!operation) return null;
  const [method, path] = event.routeKey.split(" ");
  return (
    event.requestContext?.http?.method === method
    && event.requestContext?.http?.path === path
  )
    ? operation
    : null;
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

export function createGovernanceHandler({
  identityProjector,
  identityVerifier,
  domainDirectory,
  governanceService,
} = {}) {
  const methods = [
    "readHitlPolicies",
    "publishAgent",
    "registerDraft",
    "submitPublication",
    "initiatePublication",
    "decidePublication",
    "discoverShared",
    "setCatalogVisibility",
    "readCatalogVisibility",
    "listAgentEntitlements",
    "requestAccess",
    "decideAccess",
    "revokeAccess",
    "grantAgentEntitlement",
    "revokeAgentEntitlement",
  ];
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
    || typeof identityVerifier !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !governanceService
    || methods.some(
      (method) => typeof governanceService[method] !== "function",
    )
  ) {
    throw new TypeError("Governance handler configuration is invalid.");
  }

  return async function governanceHandler(event = {}) {
    const correlationId = event.requestContext?.requestId || "unknown";
    const operation = operationFromEvent(event);
    if (!operation) return errorResponse("ROUTE_NOT_FOUND", correlationId);
    const isRead = new Set([
      "readGuardrails",
      "listGuardrailExceptions",
      "readPublicationContext",
      "readAlertPolicies",
      "readHitlPolicies",
      "discoverShared",
      "readCatalogVisibility",
      "listAgentEntitlements",
    ]).has(operation);
    const query = isRead ? parseQuery(event, operation) : null;
    if (
      (isRead && query === null)
      || (
        !isRead
        && event.queryStringParameters !== undefined
        && event.queryStringParameters !== null
        && (
          !isPlainObject(event.queryStringParameters)
          || Reflect.ownKeys(event.queryStringParameters).length > 0
        )
      )
    ) {
      return errorResponse(
        isRead ? "INVALID_QUERY" : "INVALID_BODY",
        correlationId,
      );
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
      authenticated = identityProjector.projectAuthenticated(claims);
    } catch {
      return errorResponse("GOVERNANCE_UNAVAILABLE", correlationId);
    }
    if (
      !isPlainObject(authenticated)
      || authenticated.actor !== subject
      || !ROLES.has(authenticated.role)
    ) {
      return errorResponse("GOVERNANCE_UNAVAILABLE", correlationId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    const requestHeader = singleHeader(event.headers, "x-request-id");
    if (
      roleHeader.invalid
      || (
        roleHeader.present
        && !ROLES.has(roleHeader.value)
      )
    ) {
      return errorResponse("DEMO_ROLE_NOT_ALLOWED", correlationId);
    }
    if (domainHeader.invalid) {
      return errorResponse("DEMO_DOMAIN_NOT_ALLOWED", correlationId);
    }
    if (
      !isRead
      && (
        requestHeader.invalid
        || !requestHeader.present
        || !REQUEST_ID_PATTERN.test(requestHeader.value)
      )
    ) {
      return errorResponse("INVALID_REQUEST_ID", correlationId);
    }
    if (isRead && requestHeader.invalid) {
      return errorResponse("INVALID_REQUEST_ID", correlationId);
    }

    const anticipatedRole = roleHeader.present
      ? roleHeader.value
      : authenticated.role;
    if (["savePolicyDraft", "saveAlertDraft", "readAlertPolicies"].includes(operation)
      && (authenticated.role !== "admin" || anticipatedRole !== "admin")) {
      return errorResponse("FORBIDDEN", correlationId);
    }
    if (anticipatedRole === "user") {
      return errorResponse("FORBIDDEN", correlationId);
    }
    if (
      operation === "listAgentEntitlements"
      && !new Set(["admin", "lead"]).has(anticipatedRole)
    ) {
      return errorResponse("FORBIDDEN", correlationId);
    }
    if (
      (anticipatedRole === "lead" || anticipatedRole === "builder")
      && !domainHeader.present
    ) {
      return errorResponse("DEMO_DOMAIN_REQUIRED", correlationId);
    }
    if (roleHeader.present) {
      try {
        if (await identityVerifier(claims) !== true) {
          return errorResponse("DEMO_ROLE_NOT_ALLOWED", correlationId);
        }
      } catch {
        return errorResponse("GOVERNANCE_UNAVAILABLE", correlationId);
      }
    }

    let domains;
    let domainIds;
    try {
      domains = await domainDirectory.listActiveDomains();
      domainIds = validateDomains(domains);
    } catch {
      return errorResponse("GOVERNANCE_UNAVAILABLE", correlationId);
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
        knownIdentityCode(error) || "GOVERNANCE_UNAVAILABLE",
        correlationId,
      );
    }

    let serviceInput;
    if (isRead) {
      if (event.body !== undefined && event.body !== null) {
        return errorResponse("INVALID_BODY", correlationId);
      }
      serviceInput = ["readGuardrails", "readAlertPolicies", "readCatalogVisibility"].includes(operation) ? { identity } : { identity, ...query };
    } else {
      const body = decodeBody(event);
      if (
        !exactBody(body, [...BODY_KEYS[operation],
          ...(["submitPublication", "initiatePublication"].includes(operation) && Object.hasOwn(body || {}, "expectedRecordVersion") ? ["expectedRecordVersion"] : [])])
        || (
          new Set([
            "grantAgentEntitlement",
            "revokeAgentEntitlement",
          ]).has(operation)
          && !validEntitlementBody(operation, body)
        )
      ) {
        return errorResponse("INVALID_BODY", correlationId);
      }
      if (operation === "registerDraft") {
        serviceInput = {
          identity,
          requestId: requestHeader.value,
          resource: body,
        };
      } else {
        serviceInput = {
          identity,
          requestId: requestHeader.value,
          ...body,
        };
      }
    }

    try {
      const result = await governanceService[operation](serviceInput);
      if (!isPlainObject(result)) {
        return errorResponse("GOVERNANCE_UNAVAILABLE", correlationId);
      }
      return response(
        new Set([
          "publishAgent",
          "registerDraft",
          "submitPublication",
          "initiatePublication",
          "requestAccess",
          "grantAgentEntitlement",
        ]).has(operation)
          ? 201
          : 200,
        { ok: true, ...result },
      );
    } catch (error) {
      if (error instanceof GovernanceServiceError) {
        return response(error.statusCode, {
          ok: false,
          code: error.code,
          message: error.message,
          requestId: correlationId,
          retryable: error.retryable === true,
        });
      }
      return errorResponse("GOVERNANCE_UNAVAILABLE", correlationId);
    }
  };
}
