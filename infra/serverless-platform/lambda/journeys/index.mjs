import {
  JourneyServiceError,
} from "./service.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const GITHUB_ISSUER = "https://github.com/login/oauth";
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_STATE_PATTERN = /^gho_[A-Za-z0-9_-]{32,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const MUTATIONS = new Set([
  "createJourney",
  "addMessage",
  "createContract",
  "createPreview",
  "startGitHubAuthorization",
]);
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
  JOURNEY_UNAVAILABLE: {
    statusCode: 503,
    message: "The journey service is temporarily unavailable.",
    retryable: true,
  },
});

function plain(value) {
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
  if (!plain(value) || !Object.hasOwn(value, key)) return null;
  const field = value[key];
  return typeof field === "string"
    && field.length > 0
    && field === field.trim()
    && !/[\u0000-\u001f\u007f]/.test(field)
      ? field
      : null;
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

function validApplicationRootUrl(value) {
  if (typeof value !== "string" || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function redirect(applicationRootUrl, key, value, additional = {}) {
  const location = new URL(applicationRootUrl);
  location.searchParams.set(key, value);
  for (const [additionalKey, additionalValue] of Object.entries(additional)) {
    location.searchParams.set(additionalKey, additionalValue);
  }
  return {
    statusCode: 302,
    headers: {
      location: location.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
    body: "",
  };
}

function errorResponse(code, requestId) {
  const detail = ERROR_DETAILS[code] || ERROR_DETAILS.JOURNEY_UNAVAILABLE;
  return response(detail.statusCode, {
    ok: false,
    code: ERROR_DETAILS[code] ? code : "JOURNEY_UNAVAILABLE",
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
  if (!plain(headers)) return { invalid: true };
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
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return plain(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validBody(operation, value) {
  if (operation === "startGitHubAuthorization") {
    return plain(value)
      && Object.keys(value).length === (Object.hasOwn(value, "accessToken") ? 5 : 4)
      && (!Object.hasOwn(value, "accessToken")
        || (typeof value.accessToken === "string" && /^[\x21-\x7e]{20,2048}$/.test(value.accessToken)))
      && ownString(value, "previewId") !== null
      && ownString(value, "fingerprint") !== null
      && ownString(value, "confirmation") !== null
      && value.acknowledgePrivateRepository === true;
  }
  return true;
}

function githubCallback(event) {
  if (
    (event.body !== undefined && event.body !== null && event.body !== "")
    || typeof event.rawQueryString !== "string"
    || Buffer.byteLength(event.rawQueryString) > 4_096
  ) {
    return null;
  }
  const entries = [...new URLSearchParams(event.rawQueryString).entries()];
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) return null;
  const values = Object.fromEntries(entries);
  const state = ownString(values, "state");
  if (
    !state
    || !GITHUB_STATE_PATTERN.test(state)
    || (
      Object.hasOwn(values, "iss")
      && values.iss !== GITHUB_ISSUER
    )
  ) {
    return null;
  }
  const allowedCodeKeys = new Set(["code", "iss", "state"]);
  if (
    keys.length >= 2
    && keys.every((key) => allowedCodeKeys.has(key))
    && ownString(values, "code") !== null
    && Buffer.byteLength(values.code) <= 512
  ) {
    return { type: "code", payload: { code: values.code, state } };
  }
  const allowedErrorKeys = new Set([
    "error",
    "error_description",
    "error_uri",
    "iss",
    "state",
  ]);
  if (
    keys.length >= 2
    && keys.every((key) => allowedErrorKeys.has(key))
    && values.error === "access_denied"
    && (
      !Object.hasOwn(values, "error_description")
      || ownString(values, "error_description") !== null
    )
    && (
      !Object.hasOwn(values, "error_uri")
      || ownString(values, "error_uri") !== null
    )
  ) {
    return { type: "cancelled", payload: { state } };
  }
  return null;
}

function route(event) {
  const { routeKey } = event;
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path;
  if (
    routeKey === "POST /api/journeys"
    && method === "POST"
    && path === "/api/journeys"
  ) {
    return { operation: "createJourney", id: null };
  }
  if (
    routeKey === "POST /api/delivery/previews"
    && method === "POST"
    && path === "/api/delivery/previews"
  ) {
    return { operation: "createPreview", id: null };
  }
  if (
    routeKey === "GET /api/delivery/github"
    && method === "GET"
    && path === "/api/delivery/github"
  ) {
    return { operation: "getGitHubConnection", id: null };
  }
  if (
    routeKey === "POST /api/delivery/github/authorizations"
    && method === "POST"
    && path === "/api/delivery/github/authorizations"
  ) {
    return { operation: "startGitHubAuthorization", id: null };
  }
  if (
    routeKey === "GET /oauth/github/callback"
    && method === "GET"
    && path === "/oauth/github/callback"
  ) {
    return { operation: "completeGitHubAuthorization", id: null };
  }
  const id = event.pathParameters?.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  const routes = [
    [
      "GET /api/journeys/{id}",
      "GET",
      `/api/journeys/${id}`,
      "getJourney",
    ],
    [
      "POST /api/journeys/{id}/messages",
      "POST",
      `/api/journeys/${id}/messages`,
      "addMessage",
    ],
    [
      "POST /api/journeys/{id}/contract",
      "POST",
      `/api/journeys/${id}/contract`,
      "createContract",
    ],
    [
      "GET /api/delivery/{id}",
      "GET",
      `/api/delivery/${id}`,
      "getDelivery",
    ],
  ];
  const match = routes.find(([key, verb, expectedPath]) =>
    routeKey === key && method === verb && path === expectedPath);
  return match ? { operation: match[3], id } : null;
}

function validDomains(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const ids = value.map((entry) =>
    plain(entry) && Object.keys(entry).length === 1 ? entry.id : null);
  return ids.every((id) => typeof id === "string" && DOMAIN_PATTERN.test(id))
    && new Set(ids).size === ids.length
      ? ids
      : null;
}

function knownIdentityCode(error) {
  return error?.statusCode === 403
    && new Set([
      "DEMO_ROLE_NOT_ALLOWED",
      "DEMO_DOMAIN_REQUIRED",
      "DEMO_DOMAIN_NOT_ALLOWED",
    ]).has(error.code)
      ? error.code
      : null;
}

function effectiveIdentity(value, subject, anticipatedRole, activeDomains) {
  const domain = value?.domain
    || (
      value?.role === "admin"
      && activeDomains.includes("platform")
        ? "platform"
        : null
    );
  if (
    !plain(value)
    || value.actor !== subject
    || value.role !== anticipatedRole
    || !ROLES.has(value.role)
    || !DOMAIN_PATTERN.test(domain)
    || !activeDomains.includes(domain)
  ) {
    throw new Error("Effective identity is invalid.");
  }
  const domains = value.role === "admin"
    ? activeDomains
    : Array.isArray(value.domains)
      ? value.domains
      : [];
  if (
    domains.length > 100
    || domains.some((id) => !DOMAIN_PATTERN.test(id))
    || new Set(domains).size !== domains.length
    || !domains.includes(domain)
  ) {
    throw new Error("Effective identity is invalid.");
  }
  return {
    actor: subject,
    role: value.role,
    activeDomain: domain,
    domainIds: [...domains],
  };
}

export function createJourneyHandler({
  identityProjector,
  identityVerifier,
  domainDirectory,
  journeyService,
  applicationRootUrl,
  logSecurityEvent = console.error,
} = {}) {
  if (
    !identityProjector
    || typeof identityProjector.projectAuthenticated !== "function"
    || typeof identityProjector.projectEffective !== "function"
    || typeof identityVerifier !== "function"
    || !validApplicationRootUrl(applicationRootUrl)
    || typeof logSecurityEvent !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !journeyService
    || ![
      "createJourney",
      "getJourney",
      "addMessage",
      "createContract",
      "createPreview",
      "getDelivery",
      "getGitHubConnection",
      "startGitHubAuthorization",
      "cancelGitHubAuthorization",
      "completeGitHubAuthorization",
    ].every((method) => typeof journeyService[method] === "function")
  ) {
    throw new TypeError("Journey handler configuration is invalid.");
  }

  return async function journeyHandler(event = {}) {
    const correlationId = event.requestContext?.requestId || "unknown";
    const selectedRoute = route(event);
    if (!selectedRoute) {
      return errorResponse("ROUTE_NOT_FOUND", correlationId);
    }
    if (selectedRoute.operation === "completeGitHubAuthorization") {
      const callback = githubCallback(event);
      if (!callback) {
        const parameters = typeof event.rawQueryString === "string"
          ? new URLSearchParams(event.rawQueryString)
          : new URLSearchParams();
        try {
          await logSecurityEvent({
            event: "GITHUB_OAUTH_CALLBACK_REJECTED",
            error: parameters.get("error"),
            queryKeys: [...new Set(parameters.keys())].sort(),
          });
        } catch {
          // Callback diagnostics must not replace the stable redirect.
        }
        return redirect(
          applicationRootUrl,
          "github_error",
          "invalid_callback",
        );
      }
      if (callback.type === "cancelled") {
        try {
          await journeyService.cancelGitHubAuthorization({
            payload: callback.payload,
          });
          return redirect(
            applicationRootUrl,
            "github_error",
            "authorization_cancelled",
          );
        } catch (error) {
          const code = error instanceof JourneyServiceError
            && error.code === "CONFLICT"
            ? "authorization_expired"
            : "delivery_failed";
          return redirect(applicationRootUrl, "github_error", code);
        }
      }
      try {
        const delivery =
          await journeyService.completeGitHubAuthorization({
            payload: callback.payload,
          });
        if (!plain(delivery) || !ID_PATTERN.test(delivery.id)) {
          throw new Error("Invalid delivery.");
        }
        return redirect(
          applicationRootUrl,
          "github_delivery",
          delivery.id,
          delivery.warning === "GITHUB_REVOCATION_FAILED"
            ? { github_warning: "revocation_failed" }
            : {},
        );
      } catch (error) {
        const code = error instanceof JourneyServiceError
          ? error.code === "CONFLICT"
            ? "authorization_expired"
            : error.code === "GITHUB_REVOCATION_FAILED"
              ? "revocation_failed"
              : "delivery_failed"
          : "delivery_failed";
        if (
          typeof error?.deliveryId === "string"
          && ID_PATTERN.test(error.deliveryId)
        ) {
          return redirect(
            applicationRootUrl,
            "github_delivery",
            error.deliveryId,
            {
              github_error: code,
              ...(error.revocationFailed === true
                ? { github_warning: "revocation_failed" }
                : {}),
            },
          );
        }
        return redirect(applicationRootUrl, "github_error", code);
      }
    }
    if (
      event.queryStringParameters !== undefined
      && event.queryStringParameters !== null
      && (
        !plain(event.queryStringParameters)
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
      return errorResponse("JOURNEY_UNAVAILABLE", correlationId);
    }
    if (
      !plain(authenticated)
      || authenticated.actor !== subject
      || !ROLES.has(authenticated.role)
    ) {
      return errorResponse("JOURNEY_UNAVAILABLE", correlationId);
    }

    const roleHeader = singleHeader(event.headers, "x-demo-role");
    const domainHeader = singleHeader(event.headers, "x-active-domain");
    const requestHeader = singleHeader(event.headers, "x-request-id");
    if (
      roleHeader.invalid
      || (roleHeader.present && !ROLES.has(roleHeader.value))
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
    if (!domainHeader.present && anticipatedRole !== "admin") {
      return errorResponse("DEMO_DOMAIN_REQUIRED", correlationId);
    }
    if (anticipatedRole === "user") {
      return errorResponse("FORBIDDEN", correlationId);
    }
    if (
      requestHeader.invalid
      || (
        requestHeader.present
        && !REQUEST_ID_PATTERN.test(requestHeader.value)
      )
    ) {
      return errorResponse("INVALID_REQUEST_ID", correlationId);
    }
    if (
      MUTATIONS.has(selectedRoute.operation)
      && (
        !requestHeader.present
      )
    ) {
      return errorResponse("INVALID_REQUEST_ID", correlationId);
    }
    if (roleHeader.present) {
      try {
        if (await identityVerifier(requestClaims) !== true) {
          return errorResponse("DEMO_ROLE_NOT_ALLOWED", correlationId);
        }
      } catch {
        return errorResponse("JOURNEY_UNAVAILABLE", correlationId);
      }
    }

    let activeDomainRecords;
    let activeDomains;
    try {
      activeDomainRecords = await domainDirectory.listActiveDomains();
      activeDomains = validDomains(activeDomainRecords);
      if (!activeDomains) throw new Error("Invalid domains.");
    } catch {
      return errorResponse("JOURNEY_UNAVAILABLE", correlationId);
    }
    let identity;
    try {
      identity = effectiveIdentity(
        identityProjector.projectEffective(
          requestClaims,
          event.headers,
          {
            availableDomains: activeDomainRecords,
            availableDemoDomains: activeDomainRecords,
          },
        ),
        subject,
        anticipatedRole,
        activeDomains,
      );
    } catch (error) {
      return errorResponse(
        knownIdentityCode(error) || "JOURNEY_UNAVAILABLE",
        correlationId,
      );
    }

    const hasBody = MUTATIONS.has(selectedRoute.operation);
    let payload;
    if (hasBody) {
      payload = decodeBody(event);
      if (
        !payload
        || !validBody(selectedRoute.operation, payload)
      ) {
        return errorResponse("INVALID_BODY", correlationId);
      }
    } else if (
      event.body !== undefined
      && event.body !== null
      && event.body !== ""
    ) {
      return errorResponse("INVALID_BODY", correlationId);
    }

    const input = {
      identity,
      ...(MUTATIONS.has(selectedRoute.operation)
        ? { requestId: requestHeader.value, payload }
        : {}),
      ...(selectedRoute.operation.includes("Journey")
        && selectedRoute.id
        ? { journeyId: selectedRoute.id }
        : {}),
      ...(["addMessage", "createContract"].includes(selectedRoute.operation)
        ? { journeyId: selectedRoute.id }
        : {}),
      ...(selectedRoute.operation === "getDelivery"
        ? { deliveryId: selectedRoute.id }
        : {}),
    };

    try {
      const result = await journeyService[selectedRoute.operation](input);
      const delivery = new Set([
        "createPreview",
        "getDelivery",
      ])
        .has(selectedRoute.operation);
      const authorization =
        selectedRoute.operation === "startGitHubAuthorization";
      const github = selectedRoute.operation === "getGitHubConnection";
      return response(
        new Set([
          "createJourney",
          "createPreview",
          "startGitHubAuthorization",
        ])
          .has(selectedRoute.operation)
          ? 201
          : 200,
        {
          ok: true,
          [github
            ? "github"
            : authorization
              ? "authorization"
              : delivery
                ? "delivery"
                : "journey"]: result,
        },
      );
    } catch (error) {
      if (error instanceof JourneyServiceError) {
        return serviceErrorResponse(error, correlationId);
      }
      return errorResponse("JOURNEY_UNAVAILABLE", correlationId);
    }
  };
}
