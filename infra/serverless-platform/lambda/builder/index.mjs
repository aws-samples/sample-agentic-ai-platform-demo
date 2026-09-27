import {
  BuilderServiceError,
} from "./service.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const ERROR_DETAILS = Object.freeze({
  NOT_AUTHENTICATED: {
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested operation is not allowed.",
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
    message: "The request body is invalid.",
    retryable: false,
  },
  ROUTE_NOT_FOUND: {
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  },
  BUILDER_UNAVAILABLE: {
    statusCode: 503,
    message: "The builder workspace is temporarily unavailable.",
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
  if (!isPlainObject(value) || !Object.hasOwn(value, key)) return null;
  const field = value[key];
  if (
    typeof field !== "string"
    || field.length === 0
    || field !== field.trim()
    || /[\u0000-\u001f\u007f]/.test(field)
  ) {
    return null;
  }
  return field;
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
  const detail = ERROR_DETAILS[code] || ERROR_DETAILS.BUILDER_UNAVAILABLE;
  return response(detail.statusCode, {
    ok: false,
    code: ERROR_DETAILS[code] ? code : "BUILDER_UNAVAILABLE",
    message: detail.message,
    requestId,
    retryable: detail.retryable,
  });
}

function serviceErrorResponse(error, requestId) {
  return response(error.statusCode, {
    ok: false,
    code: error.code,
    message: error.message,
    requestId,
    retryable: error.retryable === true,
  });
}

function singleHeader(headers, expected) {
  if (headers === undefined || headers === null) {
    return { present: false, value: null };
  }
  if (!isPlainObject(headers)) return { invalid: true };
  const keys = Object.keys(headers)
    .filter((key) => key.toLowerCase() === expected);
  if (keys.length > 1) return { invalid: true };
  if (keys.length === 0) return { present: false, value: null };
  const value = headers[keys[0]];
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return { invalid: true };
  }
  return { present: true, value };
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

function validateDomains(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Domain directory is invalid.");
  }
  const ids = [];
  for (const entry of value) {
    if (
      !isPlainObject(entry)
      || Object.keys(entry).length !== 1
      || !DOMAIN_PATTERN.test(entry.id)
      || ids.includes(entry.id)
    ) {
      throw new Error("Domain directory is invalid.");
    }
    ids.push(entry.id);
  }
  return ids;
}

function validateEffective(value, subject, anticipatedRole, activeDomainIds) {
  if (
    !isPlainObject(value)
    || value.actor !== subject
    || value.role !== anticipatedRole
    || !ROLES.has(value.role)
  ) {
    throw new Error("Effective identity is invalid.");
  }
  if (
    (value.role === "lead" || value.role === "builder")
    && (
      !DOMAIN_PATTERN.test(value.domain)
      || !activeDomainIds.includes(value.domain)
    )
  ) {
    throw new Error("Effective identity is invalid.");
  }
  return {
    actor: subject,
    role: value.role,
    activeDomain: value.role === "admin" ? (value.domain ?? null) : value.domain,
    domainIds: value.role === "admin"
      ? activeDomainIds
      : value.role === "user"
        ? []
        : [value.domain],
  };
}

function operationFromRoute(event) {
  if (
    event.routeKey === "POST /api/agents"
    && event.requestContext?.http?.method === "POST"
    && event.requestContext?.http?.path === "/api/agents"
  ) {
    return "createAgent";
  }
  const id = event.pathParameters?.id;
  if (!SLUG_PATTERN.test(id)) return null;
  if (
    event.routeKey === "PUT /api/agents/{id}"
    && event.requestContext?.http?.method === "PUT"
    && event.requestContext?.http?.path === `/api/agents/${id}`
  ) {
    return "configureAgent";
  }
  if (
    event.routeKey === "POST /api/agents/{id}/test"
    && event.requestContext?.http?.method === "POST"
    && event.requestContext?.http?.path === `/api/agents/${id}/test`
  ) {
    return "testAgent";
  }
  return null;
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

export function createBuilderHandler({
  identityProjector,
  identityVerifier,
  domainDirectory,
  builderService,
} = {}) {
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
    || typeof identityVerifier !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !builderService
    || !["createAgent", "configureAgent", "testAgent"]
      .every((method) => typeof builderService[method] === "function")
  ) {
    throw new TypeError("Builder handler configuration is invalid.");
  }

  return async function builderHandler(event = {}) {
    const correlationId = event.requestContext?.requestId || "unknown";
    const operation = operationFromRoute(event);
    if (!operation) return errorResponse("ROUTE_NOT_FOUND", correlationId);
    if (
      event.queryStringParameters !== undefined
      && event.queryStringParameters !== null
      && (
        !isPlainObject(event.queryStringParameters)
        || Object.keys(event.queryStringParameters).length > 0
      )
    ) {
      return errorResponse("INVALID_BODY", correlationId);
    }
    const requestClaims = event.requestContext?.authorizer?.jwt?.claims;
    const subject = ownString(requestClaims, "sub");
    if (
      !subject
      || !SUBJECT_PATTERN.test(subject)
      || ownString(requestClaims, "token_use") !== "access"
    ) {
      return errorResponse("NOT_AUTHENTICATED", correlationId);
    }

    let authenticated;
    try {
      authenticated =
        identityProjector.projectAuthenticated(requestClaims);
    } catch {
      return errorResponse("BUILDER_UNAVAILABLE", correlationId);
    }
    if (
      !isPlainObject(authenticated)
      || authenticated.actor !== subject
      || !ROLES.has(authenticated.role)
    ) {
      return errorResponse("BUILDER_UNAVAILABLE", correlationId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    const requestHeader = singleHeader(event.headers, "x-request-id");
    if (
      requestHeader.invalid
      || !requestHeader.present
      || !REQUEST_ID_PATTERN.test(requestHeader.value)
    ) {
      return errorResponse("INVALID_REQUEST_ID", correlationId);
    }
    if (
      roleHeader.invalid
      || (roleHeader.present && !ROLES.has(roleHeader.value))
    ) {
      return errorResponse("DEMO_ROLE_NOT_ALLOWED", correlationId);
    }
    if (domainHeader.invalid) {
      return errorResponse("DEMO_DOMAIN_NOT_ALLOWED", correlationId);
    }
    const anticipatedRole = roleHeader.present
      ? roleHeader.value
      : authenticated.role;
    if (anticipatedRole === "user") {
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
        if (await identityVerifier(requestClaims) !== true) {
          return errorResponse("DEMO_ROLE_NOT_ALLOWED", correlationId);
        }
      } catch {
        return errorResponse("BUILDER_UNAVAILABLE", correlationId);
      }
    }

    let activeDomains;
    try {
      activeDomains = await domainDirectory.listActiveDomains();
      validateDomains(activeDomains);
    } catch {
      return errorResponse("BUILDER_UNAVAILABLE", correlationId);
    }

    let identity;
    try {
      identity = validateEffective(
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
        validateDomains(activeDomains),
      );
    } catch (error) {
      const code = knownIdentityCode(error);
      return errorResponse(code || "BUILDER_UNAVAILABLE", correlationId);
    }

    const body = decodeBody(event);
    if (!body) return errorResponse("INVALID_BODY", correlationId);
    const pathId = event.pathParameters?.id;
    let serviceInput;
    if (operation === "createAgent") {
      serviceInput = {
        identity,
        requestId: requestHeader.value,
        payload: body,
      };
    } else if (operation === "configureAgent") {
      serviceInput = {
        identity,
        requestId: requestHeader.value,
        agentRef: {
          domainId: body.domainId,
          projectId: body.projectId,
          agentId: pathId,
        },
        payload: body,
      };
    } else {
      if (
        !isPlainObject(body)
        || Object.keys(body).sort().join(",")
          !== "domainId,maxTokens,projectId,prompt"
      ) {
        return errorResponse("INVALID_BODY", correlationId);
      }
      serviceInput = {
        identity,
        requestId: requestHeader.value,
        agentRef: {
          domainId: body.domainId,
          projectId: body.projectId,
          agentId: pathId,
        },
        prompt: body.prompt,
        maxTokens: body.maxTokens,
      };
    }

    try {
      const result = await builderService[operation](serviceInput);
      if (operation === "testAgent") {
        if (
          !isPlainObject(result)
          || !isPlainObject(result.agent)
          || !isPlainObject(result.test)
        ) {
          return errorResponse("BUILDER_UNAVAILABLE", correlationId);
        }
        return response(200, {
          ok: true,
          agent: result.agent,
          test: result.test,
        });
      }
      return response(operation === "createAgent" ? 201 : 200, {
        ok: true,
        agent: result,
      });
    } catch (error) {
      if (error instanceof BuilderServiceError) {
        return serviceErrorResponse(error, correlationId);
      }
      return errorResponse("BUILDER_UNAVAILABLE", correlationId);
    }
  };
}
