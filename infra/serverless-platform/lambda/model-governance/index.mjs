import {
  ModelGovernanceServiceError,
} from "./service.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ROUTES = Object.freeze({
  "GET /api/ai-gateway": "readCatalog",
  "POST /api/ai-gateway/model-policies": "putPolicy",
  "POST /api/ai-gateway/model-access-requests": "requestAccess",
  "POST /api/ai-gateway/model-access-decisions": "decideAccess",
});
const BODY_KEYS = Object.freeze({
  putPolicy: Object.freeze([
    "modelId",
    "allowedDomains",
    "requestableDomains",
    "limits",
  ]),
  requestAccess: Object.freeze(["approvalId", "modelId"]),
  decideAccess: Object.freeze([
    "approvalId",
    "decision",
    "reason",
  ]),
});
const ERROR_DETAILS = Object.freeze({
  NOT_AUTHENTICATED: Object.freeze({
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  }),
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The model governance request is invalid.",
    retryable: false,
  }),
  FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "The requested model governance action is not allowed.",
    retryable: false,
  }),
  NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested model resource was not found.",
    retryable: false,
  }),
  CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The requested model governance action conflicts with current state.",
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
  DEMO_CONTEXT_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Demo role context is temporarily unavailable.",
    retryable: true,
  }),
  MODEL_GOVERNANCE_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Model governance is temporarily unavailable.",
    retryable: true,
  }),
  ROUTE_NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  }),
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
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
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
  const detail = ERROR_DETAILS[code]
    || ERROR_DETAILS.MODEL_GOVERNANCE_UNAVAILABLE;
  const stableCode = Object.hasOwn(ERROR_DETAILS, code)
    ? code
    : "MODEL_GOVERNANCE_UNAVAILABLE";
  return response(detail.statusCode, {
    ok: false,
    code: stableCode,
    message: detail.message,
    requestId,
    retryable: detail.retryable,
  });
}

function identityFromProjection(projected, actor) {
  if (!isPlainObject(projected)) throw new Error("identity invalid");
  return {
    actor,
    role: projected.role,
    activeDomain: projected.domain ?? null,
    domainIds: Array.isArray(projected.domains)
      ? [...projected.domains]
      : [],
  };
}

function knownErrorCode(error) {
  if (
    error instanceof ModelGovernanceServiceError
    && Object.hasOwn(ERROR_DETAILS, error.code)
  ) {
    return error.code;
  }
  if (
    typeof error?.code === "string"
    && Object.hasOwn(ERROR_DETAILS, error.code)
  ) {
    return error.code;
  }
  return "MODEL_GOVERNANCE_UNAVAILABLE";
}

export function createModelGovernanceHandler({
  identityProjector,
  identityVerifier,
  domainDirectory,
  service,
  serviceFactory,
} = {}) {
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
    || typeof identityVerifier !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || (
      service === undefined
      && typeof serviceFactory !== "function"
    )
  ) {
    throw new TypeError("Model governance handler dependencies are invalid.");
  }
  let resolvedService = service;
  function modelGovernanceService() {
    resolvedService ??= serviceFactory();
    return resolvedService;
  }

  return async function modelGovernanceHandler(event = {}) {
    const method = event.requestContext?.http?.method || "";
    const path = event.requestContext?.http?.path || "";
    const requestId =
      event.requestContext?.requestId || "unknown";
    const operation = ROUTES[`${method} ${path}`];
    if (!operation) return errorResponse("ROUTE_NOT_FOUND", requestId);

    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const actor = ownString(claims, "sub");
    if (
      actor === null
      || ownString(claims, "token_use") !== "access"
    ) {
      return errorResponse("NOT_AUTHENTICATED", requestId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    if (roleHeader.invalid || domainHeader.invalid) {
      return errorResponse("INVALID_REQUEST", requestId);
    }
    if (roleHeader.present) {
      try {
        if (await identityVerifier(claims) !== true) {
          return errorResponse("DEMO_ROLE_NOT_ALLOWED", requestId);
        }
      } catch {
        return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
      }
    }

    let availableDomains = [];
    const requestedRole = roleHeader.present
      ? roleHeader.value
      : identityProjector.projectAuthenticated(claims).role;
    if (
      requestedRole === "lead"
      || requestedRole === "builder"
      || domainHeader.present
    ) {
      try {
        availableDomains = await domainDirectory.listActiveDomains();
      } catch {
        return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
      }
    }

    let identity;
    try {
      identity = identityFromProjection(
        identityProjector.projectEffective(
          claims,
          event.headers,
          {
            availableDomains,
            availableDemoDomains: availableDomains,
          },
        ),
        actor,
      );
    } catch (error) {
      return errorResponse(
        Object.hasOwn(ERROR_DETAILS, error?.code)
          ? error.code
          : "DEMO_CONTEXT_UNAVAILABLE",
        requestId,
      );
    }

    let input = { identity };
    if (method === "POST") {
      const mutationHeader = singleHeader(event.headers, "x-request-id");
      if (
        mutationHeader.invalid
        || !mutationHeader.present
        || !REQUEST_ID_PATTERN.test(mutationHeader.value)
      ) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      const body = decodeBody(event);
      if (!exactBody(body, BODY_KEYS[operation])) {
        return errorResponse("INVALID_REQUEST", requestId);
      }
      input = {
        identity,
        requestId: mutationHeader.value,
        ...body,
      };
    }

    try {
      const result = await modelGovernanceService()[operation](input);
      if (operation === "readCatalog") return response(200, result);
      if (operation === "putPolicy") {
        return response(200, { ok: true, policy: result });
      }
      if (operation === "requestAccess") {
        return response(201, { ok: true, approval: result });
      }
      return response(200, { ok: true, ...result });
    } catch (error) {
      return errorResponse(knownErrorCode(error), requestId);
    }
  };
}
