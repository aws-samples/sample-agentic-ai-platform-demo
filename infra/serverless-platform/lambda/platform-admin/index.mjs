import { randomUUID } from "node:crypto";
import {
  AgentRegistryControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  IdentityScopeError,
  ownStringClaim,
  preflightEffectiveIdentity,
  projectEffectiveIdentity,
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
import {
  createRegistryInventoryService,
} from "../control-plane/service.mjs";
import {
  PlatformAdminServiceError,
  createPlatformAdminService,
  isCommercialAwsRegion,
} from "./service.mjs";
import {
  createRegistryDecisionFinalizerClient,
} from "./finalizer-client.mjs";
import { createDomainDirectory } from "./domain-directory.mjs";
import { createPlatformState } from "./state.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CREATE_INPUT_KEYS = new Set([
  "name",
  "owner",
  "ownerGroup",
  "description",
  "tokenBudget",
]);
const DECISION_INPUT_KEYS = new Set([
  "id",
  "semver",
  "decision",
  "reason",
]);
const REGISTRY_CREATE_INPUT_KEYS = new Set([
  "type",
  "name",
  "displayName",
  "description",
  "version",
  "content",
  "endpoint",
  "transport",
  "structDef",
  "andApprove",
]);
const VALID_RECORD_TYPES = new Set(["A2AAgent", "MCPServer", "Skill", "CUSTOM"]);
const RECORD_TYPE_MAP = {
  A2AAgent: "AGENT",
  Skill: "SKILL",
  MCPServer: "MCP",
  CUSTOM: "CUSTOM",
};
const NAME_PATTERN = /^[a-z0-9_-]+$/;
const REGISTRY_CREATE_APPROVE_REASON =
  "Approved by platform administrator on creation.";
const ERROR_DEFINITIONS = {
  NOT_AUTHENTICATED: {
    statusCode: 401,
    message: "Sign in is required.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "Platform administrator access is required.",
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
  INVALID_BODY: {
    statusCode: 400,
    message: "Request body is invalid.",
    retryable: false,
  },
  INVALID_REQUEST_ID: {
    statusCode: 400,
    message: "Request ID is invalid.",
    retryable: false,
  },
  ROUTE_NOT_FOUND: {
    statusCode: 404,
    message: "The requested route is not available.",
    retryable: false,
  },
  PLATFORM_ADMIN_UNAVAILABLE: {
    statusCode: 503,
    message: "Platform administration is temporarily unavailable.",
    retryable: true,
  },
};
const ALLOWED_SERVICE_STATUS_CODES = new Set([400, 403, 409, 503]);

let productionService;

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
  const definition =
    ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.PLATFORM_ADMIN_UNAVAILABLE;
  return response(definition.statusCode, {
    ok: false,
    code: ERROR_DEFINITIONS[code] ? code : "PLATFORM_ADMIN_UNAVAILABLE",
    message: definition.message,
    requestId,
    retryable: definition.retryable,
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

function headerValues(headers, expectedName) {
  if (!isPlainObject(headers)) return [];
  return Object.keys(headers)
    .filter((key) => key.toLowerCase() === expectedName)
    .map((key) => headers[key]);
}

function trustedCorrelationId(context, correlationIdFactory) {
  const lambdaRequestId = context?.awsRequestId;
  if (
    typeof lambdaRequestId === "string"
    && REQUEST_ID_PATTERN.test(lambdaRequestId)
  ) {
    return lambdaRequestId;
  }
  const generated = correlationIdFactory();
  return typeof generated === "string" && REQUEST_ID_PATTERN.test(generated)
    ? generated
    : randomUUID();
}

function requestIdentity(
  event,
  context,
  correlationIdFactory,
  requireExplicit = false,
) {
  const gatewayRequestId = event.requestContext?.requestId;
  const gatewayRequestIdValid =
    typeof gatewayRequestId === "string"
    && REQUEST_ID_PATTERN.test(gatewayRequestId);
  const fallback = gatewayRequestIdValid
    ? gatewayRequestId
    : trustedCorrelationId(context, correlationIdFactory);
  const values = headerValues(event.headers, "x-request-id");
  if (values.length === 0) {
    return {
      requestId: fallback,
      valid: !requireExplicit,
    };
  }
  if (
    values.length !== 1
    || typeof values[0] !== "string"
    || !REQUEST_ID_PATTERN.test(values[0])
  ) {
    return { requestId: fallback, valid: false };
  }
  return { requestId: values[0], valid: true };
}

function decodeBody(event, allowedKeys, exactKeys = false) {
  if (typeof event.body !== "string" || event.body.length === 0) {
    throw new Error("Invalid body.");
  }
  let bytes;
  if (event.isBase64Encoded === true) {
    if (
      event.body.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        event.body,
      )
    ) {
      throw new Error("Invalid body.");
    }
    bytes = Buffer.from(event.body, "base64");
    if (bytes.toString("base64") !== event.body) {
      throw new Error("Invalid body.");
    }
  } else {
    bytes = Buffer.from(event.body, "utf8");
  }
  if (bytes.length > MAX_BODY_BYTES) {
    throw new Error("Invalid body.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Invalid body.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid body.");
  }
  if (
    !isPlainObject(parsed)
    || Object.keys(parsed).some((key) => !allowedKeys.has(key))
    || (
      exactKeys
      && (
        Object.keys(parsed).length !== allowedKeys.size
        || [...allowedKeys].some((key) => !Object.hasOwn(parsed, key))
      )
    )
  ) {
    throw new Error("Invalid body.");
  }
  return parsed;
}

function parseMandatoryTags(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Mandatory deployment tags are unavailable.");
  }
  const parsed = JSON.parse(value);
  if (!isPlainObject(parsed)) {
    throw new Error("Mandatory deployment tags are unavailable.");
  }
  return parsed;
}

function parseRegistryInventoryConfig(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Registry inventory configuration is unavailable.");
  }
  const parsed = JSON.parse(value);
  if (!isPlainObject(parsed)) {
    throw new Error("Registry inventory configuration is unavailable.");
  }
  return parsed;
}

export function buildRegistryDescriptors(type, { name, displayName, description, content, endpoint, transport, structDef, domain, actor }) {
  const ownerSubject = typeof actor === "string" && actor.length > 0
    ? actor
    : "platform-bootstrap";
  const xPlatform = {
    id: name,
    displayName: displayName || name,
    domain: domain || "shared",
    governanceMode: "owned",
    domainOwner: null,
    access: ["admin"],
    createdBy: ownerSubject,
    changelog: "Initial version.",
  };

  if (type === "A2AAgent") {
    let card = {};
    try { card = JSON.parse(content); } catch { /* use empty */ }
    // A2A card: merge supplied card with x-platform metadata. Schema version is "0.3.0".
    return {
      a2aAgentCard: {
        dataSchemaVersion: "0.3.0",
        data: JSON.stringify({
          ...card,
          "x-platform": xPlatform,
        }),
      },
    };
  }

  if (type === "Skill") {
    const slug = name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    const definition = {
      id: name,
      name: slug,
      displayName: displayName || name,
      description: description || "",
      tags: [domain || "shared", "skill"].filter(Boolean),
      "x-platform": xPlatform,
    };
    if (structDef) {
      try { definition.structuredDefinition = JSON.parse(structDef); } catch { /* omit */ }
    }
    // Markdown content goes into additionalData.skillMd.data; key is agentSkillsDefinition.
    const skillMd = content || `# ${displayName || name}\n\n${description || ""}`;
    return {
      agentSkillsDefinition: {
        dataSchemaVersion: "0.1.0",
        data: JSON.stringify(definition),
        additionalData: { skillMd: { data: skillMd } },
      },
    };
  }

  if (type === "MCPServer") {
    // MCP schema 2025-12-11 requires remotes[].type = "streamable-http" (hyphen, not underscore).
    // Extra top-level keys (like x-platform) violate the schema — omit them.
    const mcpTransport = String(transport || "streamable-http").replace(/_/g, "-");
    return {
      mcpServer: {
        dataSchemaVersion: "2025-12-11",
        data: JSON.stringify({
          $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
          name: `io.platform/${name}`,
          description: description || displayName || name,
          version: "1.0.0",
          remotes: [{ type: mcpTransport, url: endpoint }],
        }),
      },
    };
  }

  // CUSTOM (Blueprint-style)
  let customData;
  try { customData = JSON.parse(content || "{}"); } catch { customData = {}; }
  return {
    custom: {
      data: JSON.stringify({
        resourceKind: "custom",
        resourceId: name,
        displayName: displayName || name,
        description: description || "",
        domain: domain || "shared",
        content: customData,
        "x-platform": xPlatform,
      }),
    },
  };
}

export function createConfiguredPlatformAdminService() {
  if (productionService) return productionService;
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const account = process.env.PLATFORM_ACCOUNT_ID;
  const region = process.env.AWS_REGION;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const finalizerFunctionName =
    process.env.REGISTRY_DECISION_FINALIZER_FUNCTION_NAME;
  if (
    typeof tableName !== "string"
    || !tableName.trim()
    || typeof account !== "string"
    || !/^[0-9]{12}$/.test(account)
    || typeof finalizerFunctionName !== "string"
    || !finalizerFunctionName.trim()
    || !isCommercialAwsRegion(region)
    || typeof userPoolId !== "string"
    || userPoolId.length > 55
    || !new RegExp(
      `^${region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[A-Za-z0-9]+$`,
    ).test(userPoolId)
  ) {
    throw new Error("Platform admin configuration is unavailable.");
  }
  const dynamo = new DynamoDBClient({ region });
  const registry = new AgentRegistryControlClient({ region });
  const cognito = new CognitoIdentityProviderClient({ region });
  const state = createPlatformState({
    tableName,
    dynamo,
    now: () => new Date(),
  });
  const inventoryConfig = parseRegistryInventoryConfig(
    process.env.REGISTRY_INVENTORY_CONFIG,
  );
  const registryInventory = createRegistryInventoryService({
    config: inventoryConfig,
    registryClient: registry,
  });
  productionService = {
    ...createPlatformAdminService({
      state,
      registry,
      domainDirectory: createDomainDirectory({
        cognito,
        userPoolId,
      }),
      registryInventory,
      decisionFinalizer: createRegistryDecisionFinalizerClient({
        functionName: finalizerFunctionName,
        region,
      }),
      region,
      account,
      tags: parseMandatoryTags(process.env.MANDATORY_TAGS_JSON),
    }),
    async listActiveDomains() {
      return (await state.listDomains())
        .filter(({ status }) => status === "ACTIVE");
    },
    async createRegistryRecord(scope, input) {
      const domain = scope.activeDomain || "shared";
      const registryId = inventoryConfig.domainRegistryIds?.[domain]
        || inventoryConfig.sharedRegistryId;
      if (!registryId) {
        throw new Error("Registry ID is unavailable for domain.");
      }
      // The runtime permissions boundary only allows CreateRegistryRecord when
      // the request carries the mandatory deployment tags (see
      // config/runtime-permissions-boundary.json CreateGovernedRegistryRecords).
      const mandatoryTags = parseMandatoryTags(process.env.MANDATORY_TAGS_JSON);
      const descriptors = buildRegistryDescriptors(input.type, {
        name: input.name,
        displayName: input.displayName,
        description: input.description,
        content: input.content,
        endpoint: input.endpoint,
        transport: input.transport,
        structDef: input.structDef,
        domain,
        actor: scope.actor,
      });
      // clientToken must be ≥33 chars. Combine requestId + suffix to guarantee it.
      const clientToken = `${scope.requestId}-rc-${input.name}`.slice(0, 128);
      const created = await registry.send(new CreateRegistryRecordCommand({
        registryId,
        name: input.name,
        displayName: input.displayName || input.name,
        description: input.description || "",
        recordType: RECORD_TYPE_MAP[input.type] || "CUSTOM",
        recordVersion: "1.0.0",
        descriptors,
        clientToken,
        tags: mandatoryTags,
      }));
      // CreateRegistryRecord response has recordArn but not recordId — parse from ARN.
      const recordId = created.recordId || created.recordArn?.split("/").pop();
      if (!recordId) {
        throw new Error("Registry record creation did not return a record ID.");
      }
      let finalStatus = created.status || "CREATING";
      if (input.andApprove) {
        // Creation is async — status comes back CREATING. Poll until DRAFT before submitting.
        // Lambda timeout is 30s; poll for up to 20s (10 × 2s) to stay within budget.
        if (finalStatus === "CREATING" || finalStatus === "UPDATING") {
          for (let i = 0; i < 10 && (finalStatus === "CREATING" || finalStatus === "UPDATING"); i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const polled = await registry.send(new GetRegistryRecordCommand({ registryId, recordId }));
            finalStatus = polled.status || finalStatus;
          }
        }
        if (finalStatus === "DRAFT") {
          await registry.send(new SubmitRegistryRecordForApprovalCommand({ registryId, recordId }));
          await registry.send(new UpdateRegistryRecordStatusCommand({
            registryId,
            recordId,
            status: "APPROVED",
            statusReason: REGISTRY_CREATE_APPROVE_REASON,
          }));
          finalStatus = "APPROVED";
        }
        // If still CREATING after polling, return ok with approved:false and a note.
      }
      const approved = input.andApprove && finalStatus === "APPROVED";
      return {
        ok: true,
        entry: {
          id: input.name,
          type: input.type,
          name: input.displayName || input.name,
          description: input.description || "",
          domain,
          defaultVersion: approved ? "1.0.0" : null,
          versions: [{
            semver: "1.0.0",
            status: approved ? "APPROVED" : finalStatus === "CREATING" ? "CREATING" : "DRAFT",
            content: descriptors,
            changelog: "Initial version.",
            createdBy: scope.actor,
            createdAt: new Date().toISOString(),
            decidedBy: approved ? scope.actor : null,
            decidedAt: approved ? new Date().toISOString() : null,
            _aws: {
              registryId,
              recordId,
            },
          }],
        },
        approved,
        ...(input.andApprove && !approved
          ? { note: "Record was created but is still processing. Approval was not applied." }
          : {}),
      };
    },
  };
  return productionService;
}

function logFailure(logger, code, requestId, cause) {
  try {
    logger?.error?.({
      event: "platform_admin_request_failed",
      code,
      requestId,
      // Stable codes only: upstream errors may contain private request content.
    });
  } catch {
    // Logging must not change the stable API response.
  }
}

function projectDomainResult(result, identity) {
  if (
    !isPlainObject(result)
    || !Array.isArray(result.domains)
  ) {
    throw new Error("Platform domain response is malformed.");
  }
  const domains = identity.role === "user"
    ? []
    : identity.domain
      ? result.domains.filter(({ id }) => id === identity.domain)
      : result.domains;
  return {
    ...result,
    domains,
  };
}

export function createPlatformAdminHandler({
  correlationIdFactory = randomUUID,
  demoOperatorVerifier = verifyCurrentDemoOperator,
  logger = console,
  service,
  serviceFactory = createConfiguredPlatformAdminService,
} = {}) {
  if (typeof correlationIdFactory !== "function") {
    throw new TypeError("Correlation ID factory is invalid.");
  }
  if (typeof demoOperatorVerifier !== "function") {
    throw new TypeError("Demo operator verifier is invalid.");
  }
  let resolvedService = service;
  function platformAdminService() {
    resolvedService ??= serviceFactory();
    return resolvedService;
  }

  return async function platformAdminHandler(event = {}, context = {}) {
    const method = event.requestContext?.http?.method || "";
    const path = event.requestContext?.http?.path || "";
    const operation =
      method === "GET" && path === "/api/domains"
        ? "listDomains"
        : method === "POST" && path === "/api/domain-create"
          ? "createDomain"
          : method === "POST" && path === "/api/registry-decide"
            ? "decideRegistryVersion"
          : method === "POST" && path === "/api/registry-create"
            ? "createRegistryRecord"
          : null;
    const request = requestIdentity(
      event,
      context,
      correlationIdFactory,
      operation === "createDomain"
        || operation === "decideRegistryVersion"
        || operation === "createRegistryRecord",
    );
    if (!request.valid) {
      return errorResponse("INVALID_REQUEST_ID", request.requestId);
    }
    if (!operation) {
      return errorResponse("ROUTE_NOT_FOUND", request.requestId);
    }

    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const actor = ownStringClaim(claims, "sub");
    if (!actor || ownStringClaim(claims, "token_use") !== "access") {
      return errorResponse("NOT_AUTHENTICATED", request.requestId);
    }

    let preflight;
    try {
      preflight = preflightEffectiveIdentity(claims, event.headers);
    } catch (error) {
      if (
        error instanceof IdentityScopeError
        && Object.hasOwn(ERROR_DEFINITIONS, error.code)
      ) {
        return errorResponse(error.code, request.requestId);
      }
      return errorResponse("DEMO_CONTEXT_UNAVAILABLE", request.requestId);
    }

    if (preflight.roleHeader.present) {
      let currentlyAuthorized;
      try {
        currentlyAuthorized = await demoOperatorVerifier(claims);
      } catch {
        return errorResponse(
          "DEMO_CONTEXT_UNAVAILABLE",
          request.requestId,
        );
      }
      if (currentlyAuthorized !== true) {
        return errorResponse("DEMO_ROLE_NOT_ALLOWED", request.requestId);
      }
    }

    const isMutation =
      operation === "createDomain"
      || operation === "decideRegistryVersion"
      || operation === "createRegistryRecord";
    const preflightRole = preflight.roleHeader.present
      ? preflight.roleHeader.value
      : preflight.authenticatedIdentity.role;
    // createRegistryRecord is available to admin AND to publishers (registerDomainResourceDraft)
    const requiresAdmin =
      operation === "createDomain"
      || operation === "decideRegistryVersion"
      || (operation === "createRegistryRecord" && false); // publishers allowed below
    if (requiresAdmin && preflightRole !== "admin") {
      return errorResponse("FORBIDDEN", request.requestId);
    }
    if (operation === "createRegistryRecord" && preflightRole !== "admin") {
      // Must have registerDomainResourceDraft capability (domain publisher or lead)
      const preflightCaps = preflight.authenticatedIdentity?.capabilities ?? [];
      if (!preflightCaps.includes("registerDomainResourceDraft")) {
        return errorResponse("FORBIDDEN", request.requestId);
      }
    }

    let availableDomains;
    const permanentDomainValidation =
      operation === "listDomains"
      && !preflight.roleHeader.present
      && preflight.authenticatedIdentity.role !== "user"
      && (
        preflight.requestedDomain
        || (
          preflight.authenticatedIdentity.role !== "admin"
          && preflight.authenticatedIdentity.domains.length === 1
        )
      );
    if (
      (preflight.canSwitchDemoRole && preflight.requestedDomain)
      || permanentDomainValidation
    ) {
      try {
        availableDomains =
          await platformAdminService().listActiveDomains();
      } catch {
        return errorResponse(
          "DEMO_CONTEXT_UNAVAILABLE",
          request.requestId,
        );
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
        return errorResponse(error.code, request.requestId);
      }
      return errorResponse("DEMO_CONTEXT_UNAVAILABLE", request.requestId);
    }

    if (
      isMutation
      && operation !== "createRegistryRecord"
      && (
        identity.role !== "admin"
        || (
          operation === "decideRegistryVersion"
          && !identity.capabilities.includes("approveRegistryVersion")
        )
      )
    ) {
      return errorResponse("FORBIDDEN", request.requestId);
    }
    // createRegistryRecord: admin or publisher — admin may andApprove, publisher DRAFT-only in own domain
    if (operation === "createRegistryRecord") {
      const isAdmin = identity.role === "admin";
      const isPublisher = identity.capabilities.includes("registerDomainResourceDraft");
      if (!isAdmin && !isPublisher) {
        return errorResponse("FORBIDDEN", request.requestId);
      }
    }
    const scope = {
      actor: identity.actor,
      username: identity.username,
      requestId: request.requestId,
      role: identity.role,
      activeDomain: identity.domain,
      allowedDomains: identity.domains,
      capabilities: identity.capabilities,
      authenticatedRole: identity.authenticatedRole,
      assumedRole: identity.assumedRole,
    };

    let input;
    if (isMutation) {
      try {
        input = operation === "createDomain"
          ? decodeBody(event, CREATE_INPUT_KEYS)
          : operation === "createRegistryRecord"
            ? decodeBody(event, REGISTRY_CREATE_INPUT_KEYS)
            : decodeBody(event, new Set([...DECISION_INPUT_KEYS, "registryId", "recordId"]));
        if (operation === "decideRegistryVersion" && (
          [...DECISION_INPUT_KEYS].some(key => !Object.hasOwn(input, key))
          || Object.hasOwn(input, "registryId") !== Object.hasOwn(input, "recordId")
        )) throw new Error("Invalid body.");
        if (operation === "createRegistryRecord") {
          const type = String(input.type || "").trim();
          if (!VALID_RECORD_TYPES.has(type)) throw new Error("Invalid body.");
          const name = String(input.name || "").trim();
          if (!name || !NAME_PATTERN.test(name)) throw new Error("Invalid body.");
          const content = String(input.content || "");
          if (content.length > 65536) throw new Error("Invalid body.");
          if (type === "A2AAgent") {
            try {
              const card = JSON.parse(content);
              if (!card.name || (!card.url && !card.serviceEndpoint)) throw new Error("Invalid card.");
            } catch { throw new Error("Invalid body."); }
          }
          if (type === "MCPServer") {
            const endpoint = String(input.endpoint || "").trim();
            if (!endpoint || !endpoint.startsWith("https://")) throw new Error("Invalid body.");
          }
          // Publishers (non-admin) cannot andApprove
          if (input.andApprove && identity.role !== "admin") {
            throw new Error("Invalid body.");
          }
          // Domain-scoped publishers may only create in their own domain
          if (identity.role !== "admin" && identity.domain && scope.activeDomain !== identity.domain) {
            throw new Error("Invalid body.");
          }
        }
      } catch {
        return errorResponse("INVALID_BODY", request.requestId);
      }
    }

    try {
      const result = operation === "createDomain"
        ? await platformAdminService().createDomain(scope, input)
        : operation === "createRegistryRecord"
          ? await platformAdminService().createRegistryRecord(scope, {
              ...input,
              type: String(input.type || "").trim(),
              name: String(input.name || "").trim(),
              displayName: String(input.displayName || input.name || "").trim(),
              description: String(input.description || "").trim(),
              content: String(input.content || ""),
              endpoint: String(input.endpoint || "").trim(),
              transport: String(input.transport || "streamable_http"),
              structDef: input.structDef ? String(input.structDef) : null,
              andApprove: identity.role === "admin" && input.andApprove === true,
            })
          : operation === "decideRegistryVersion"
            ? await platformAdminService().decideRegistryVersion(scope, input)
            : projectDomainResult(
                await platformAdminService().listDomains(scope),
                identity,
              );
      return response(200, {
        ...result,
        requestId: request.requestId,
      });
    } catch (error) {
      if (
        error instanceof PlatformAdminServiceError
        && typeof error.code === "string"
        && ALLOWED_SERVICE_STATUS_CODES.has(error.statusCode)
      ) {
        if (error.statusCode === 503) {
          logFailure(logger, error.code, request.requestId);
        }
        return serviceErrorResponse(error, request.requestId);
      }
      logFailure(
        logger,
        "PLATFORM_ADMIN_UNAVAILABLE",
        request.requestId,
        error,
      );
      return errorResponse(
        "PLATFORM_ADMIN_UNAVAILABLE",
        request.requestId,
      );
    }
  };
}

export const handler = createPlatformAdminHandler();
