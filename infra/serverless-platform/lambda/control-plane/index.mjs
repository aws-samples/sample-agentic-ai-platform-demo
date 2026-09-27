import { safeDiagnostic } from './diagnostics.mjs';
import { createModelPolicyState } from "../model-governance/state.mjs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { STSClient } from "@aws-sdk/client-sts";
import {
  IdentityScopeError,
  ownStringClaim,
  preflightEffectiveIdentity,
  projectEffectiveIdentity,
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
import { createPlatformState } from "../platform-admin/state.mjs";
import {
  createGatewayCredentialsProvider,
} from "../workspace/gateway-credentials.mjs";
import {
  ControlPlaneServiceError,
  createControlPlaneService,
} from "./service.mjs";

const ERROR_DEFINITIONS = {
  NOT_AUTHENTICATED: {
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  },
  DOMAIN_REQUIRED: {
    statusCode: 403,
    message: "An allowed active domain is required.",
    retryable: false,
  },
  DOMAIN_NOT_ALLOWED: {
    statusCode: 403,
    message: "The active domain is not allowed.",
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
  DEMO_CONTEXT_UNAVAILABLE: {
    statusCode: 503,
    message: "Demo role context is temporarily unavailable.",
    retryable: true,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested operation is not allowed.",
    retryable: false,
  },
  CONTROL_PLANE_UNAVAILABLE: {
    statusCode: 503,
    message: "Control plane inventory is temporarily unavailable.",
    retryable: true,
  },
  INVALID_REGISTRY_TYPE: {
    statusCode: 400,
    message: "Registry type is invalid.",
    retryable: false,
  },
  ROUTE_NOT_FOUND: {
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  },
};

const REGISTRY_ENTRY_TYPES = new Set([
  "Agent",
  "Skill",
  "MCPServer",
  "A2AAgent",
  "Model",
  "Blueprint",
]);
const FAILURE_COMPONENTS = new Set([
  "domain-state",
  "model-gateway",
  "registry",
  "tools-gateway",
]);

let defaultService;

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
  const definition = ERROR_DEFINITIONS[code]
    || ERROR_DEFINITIONS.CONTROL_PLANE_UNAVAILABLE;
  return response(definition.statusCode, {
    ok: false,
    code: ERROR_DEFINITIONS[code]
      ? code
      : "CONTROL_PLANE_UNAVAILABLE",
    message: definition.message,
    requestId,
    retryable: definition.retryable,
  });
}

function registryTypeFromQuery(queryStringParameters) {
  if (
    queryStringParameters === null
    || (typeof queryStringParameters !== "object"
      && typeof queryStringParameters !== "function")
    || !Object.prototype.hasOwnProperty.call(queryStringParameters, "type")
  ) {
    return { valid: true, type: null };
  }

  const type = queryStringParameters.type;
  return typeof type === "string" && REGISTRY_ENTRY_TYPES.has(type)
    ? { valid: true, type }
    : { valid: false, type: null };
}

function endUserRegistryQueryAllowed(queryStringParameters) {
  if (
    queryStringParameters === null
    || (typeof queryStringParameters !== "object"
      && typeof queryStringParameters !== "function")
  ) {
    return false;
  }
  const keys = Object.keys(queryStringParameters);
  return (
    keys.length === 1
    && keys[0] === "type"
    && queryStringParameters.type === "Agent"
  );
}

function configuredService() {
  if (defaultService) {
    return defaultService;
  }
  const serialized = process.env.CONTROL_PLANE_CONFIG;
  if (typeof serialized !== "string" || !serialized.trim()) {
    throw new Error("Control plane configuration is unavailable.");
  }
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  if (typeof tableName !== "string" || !tableName.trim()) {
    throw new Error("Platform state table configuration is unavailable.");
  }
  const config = JSON.parse(serialized);
  const dynamo = new DynamoDBClient({});
  const domainState = createPlatformState({
    tableName: tableName.trim(),
    dynamo,
  });
  const gatewayCredentials = createGatewayCredentialsProvider({
    stsClient: new STSClient({
      region: config.llmGatewayRegion,
      credentials: dynamo.config.credentials,
    }),
    roleArn: process.env.GATEWAY_INVOKER_ROLE_ARN,
  });
  defaultService = createControlPlaneService({
    config,
    domainState,
    modelPolicyState: createModelPolicyState({ tableName: tableName.trim(), dynamo, now: () => new Date() }),
    credentials: ({ abortSignal }) => gatewayCredentials({
      sourceIdentity: "platform",
      abortSignal,
    }),
  });
  return defaultService;
}

function knownErrorCode(error) {
  const isAuthorizationError =
    error instanceof IdentityScopeError
    || error instanceof ControlPlaneServiceError;
  if (
    isAuthorizationError
    && error?.statusCode === 403
    && [
      "DOMAIN_REQUIRED",
      "DOMAIN_NOT_ALLOWED",
      "FORBIDDEN",
    ].includes(error.code)
  ) {
    return error.code;
  }
  if (
    error instanceof ControlPlaneServiceError
    && error.statusCode === 503
    && error.code === "CONTROL_PLANE_UNAVAILABLE"
  ) {
    return error.code;
  }
  return "CONTROL_PLANE_UNAVAILABLE";
}

function logFailure(logger, code, requestId, error) {
  try {
    const entry = {
      event: "control_plane_request_failed",
      code,
      requestId,
    };
    if (
      error instanceof ControlPlaneServiceError
      && FAILURE_COMPONENTS.has(error.component)
    ) {
      entry.component = error.component;
    }
    if (error instanceof ControlPlaneServiceError && (error.diagnostic || error.component === 'registry')) {
      Object.assign(entry, safeDiagnostic(error.diagnostic));
    }
    logger?.error?.(entry);
  } catch {
    // Logging must not change the stable API failure response.
  }
}

export function createControlPlaneHandler({
  demoOperatorVerifier = verifyCurrentDemoOperator,
  logger = console,
  service,
  serviceFactory = configuredService,
} = {}) {
  if (typeof demoOperatorVerifier !== "function") {
    throw new TypeError("Demo operator verifier is invalid.");
  }
  let resolvedService = service;
  function controlPlaneService() {
    resolvedService ??= serviceFactory();
    return resolvedService;
  }

  return async function controlPlaneHandler(event = {}) {
    const method = event.requestContext?.http?.method || "";
    const path = event.requestContext?.http?.path || "";
    const requestId = event.requestContext?.requestId || "unknown";
    const operation = path === "/api/registry"
      ? "registry"
      : path === "/api/ai-gateway"
        ? "aiGateway"
        : null;

    if (method !== "GET" || !operation) {
      return errorResponse("ROUTE_NOT_FOUND", requestId);
    }

    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (
      !ownStringClaim(claims, "sub")
      || ownStringClaim(claims, "token_use") !== "access"
    ) {
      return errorResponse("NOT_AUTHENTICATED", requestId);
    }

    let preflight;
    try {
      preflight = preflightEffectiveIdentity(claims, event.headers);
    } catch (error) {
      if (
        error instanceof IdentityScopeError
        && Object.hasOwn(ERROR_DEFINITIONS, error.code)
      ) {
        return errorResponse(error.code, requestId);
      }
      return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
    }

    if (preflight.roleHeader.present) {
      let currentlyAuthorized;
      try {
        currentlyAuthorized = await demoOperatorVerifier(claims);
      } catch {
        return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
      }
      if (currentlyAuthorized !== true) {
        return errorResponse("DEMO_ROLE_NOT_ALLOWED", requestId);
      }
    }

    const preflightRole = preflight.roleHeader.present
      ? preflight.roleHeader.value
      : preflight.authenticatedIdentity.role;
    if (operation === "aiGateway" && preflightRole !== "admin") {
      return errorResponse("FORBIDDEN", requestId);
    }

    let availableDomains;
    if (preflight.canSwitchDemoRole && preflight.requestedDomain) {
      try {
        availableDomains =
          await controlPlaneService().listActiveDomains();
      } catch {
        return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
      }
    }

    let identity;
    try {
      identity = projectEffectiveIdentity(
        claims,
        event.headers,
        availableDomains === undefined
          ? {}
          : {
              availableDomains,
              availableDemoDomains: availableDomains,
            },
      );
    } catch (error) {
      if (
        error instanceof IdentityScopeError
        && Object.hasOwn(ERROR_DEFINITIONS, error.code)
      ) {
        return errorResponse(error.code, requestId);
      }
      return errorResponse("DEMO_CONTEXT_UNAVAILABLE", requestId);
    }

    if (operation === "aiGateway" && identity.role !== "admin") {
      return errorResponse("FORBIDDEN", requestId);
    }
    if (
      operation === "registry"
      && identity.role === "user"
      && !endUserRegistryQueryAllowed(event.queryStringParameters)
    ) {
      return errorResponse("FORBIDDEN", requestId);
    }

    const registryType = operation === "registry"
      ? registryTypeFromQuery(event.queryStringParameters)
      : { valid: true, type: null };
    if (!registryType.valid) {
      return errorResponse("INVALID_REGISTRY_TYPE", requestId);
    }

    const scope = {
      actor: identity.actor,
      username: identity.username,
      requestId,
      role: identity.role,
      activeDomain: identity.domain,
      allowedDomains: identity.domains,
      capabilities: identity.capabilities,
      authenticatedRole: identity.authenticatedRole,
      assumedRole: identity.assumedRole,
    };

    try {
      const controlPlane = controlPlaneService();
      const result = await controlPlane[operation](scope);
      return response(
        200,
        operation === "registry"
          ? {
              ...result,
              entries: (result.entries || []).filter(
                (entry) => !registryType.type || entry?.type === registryType.type,
              ),
            }
          : result,
      );
    } catch (error) {
      const code = knownErrorCode(error);
      if (code === "CONTROL_PLANE_UNAVAILABLE") {
        logFailure(logger, code, requestId, error);
      }
      return errorResponse(code, requestId);
    }
  };
}

export const handler = createControlPlaneHandler();
