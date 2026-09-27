import {
  BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { STSClient } from "@aws-sdk/client-sts";
import {
  createActiveDomainRecordDirectory,
} from "../api/domain-directory.mjs";
import {
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
import { createAuthorizer } from "../authz/authorize.mjs";
import {
  createControlPlaneService,
} from "../control-plane/service.mjs";
import {
  createPlatformState,
} from "../platform-admin/state.mjs";
import {
  createProductionIdentityProjector,
} from "../workspace/runtime.mjs";
import {
  createWorkspaceState,
} from "../workspace/state.mjs";
import {
  createGatewayCredentialsProvider,
} from "../workspace/gateway-credentials.mjs";
import {
  createModelGovernanceHandler,
} from "./index.mjs";
import {
  createGatewayRateLimitReconciler,
} from "./rate-limits.mjs";
import {
  handleBaselineModelPolicySeed,
} from "./seed.mjs";
import {
  createModelGovernanceService,
} from "./service.mjs";
import {
  createModelPolicyState,
} from "./state.mjs";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const APPROVAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const RESOURCE_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const ACTIONS = new Set([
  "model-catalog:read",
  "model-policy:update",
  "model-access:request",
  "model-access:decide",
  "model:use",
]);
const MAX_DOMAINS = 100;
const MAX_RESOURCE_REF_BYTES = 8 * 1024;

let productionEntrypoint;

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

function exactKeys(value, keys) {
  return (
    isPlainObject(value)
    && Reflect.ownKeys(value).length === keys.size
    && Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && keys.has(key),
    )
  );
}

function validateIdentity(value) {
  if (
    !exactKeys(
      value,
      new Set(["actor", "role", "activeDomain", "domainIds"]),
    )
    || !SUBJECT_PATTERN.test(value.actor)
    || !ROLES.has(value.role)
    || !Array.isArray(value.domainIds)
    || value.domainIds.length > MAX_DOMAINS
    || value.domainIds.some((domainId) => !DOMAIN_PATTERN.test(domainId))
    || new Set(value.domainIds).size !== value.domainIds.length
  ) {
    throw new Error("Model governance identity is invalid.");
  }
  return {
    actor: value.actor,
    role: value.role,
    activeDomain: value.activeDomain,
    domainIds: [...value.domainIds],
  };
}

function validateResource(value) {
  if (
    !isPlainObject(value)
    || Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string"
        || !["id", "domainId", "lifecycleState"].includes(key),
    )
    || !Object.hasOwn(value, "id")
    || !Object.hasOwn(value, "lifecycleState")
    || !RESOURCE_ID_PATTERN.test(value.id)
    || typeof value.lifecycleState !== "string"
    || value.lifecycleState.length === 0
    || value.lifecycleState.length > 64
    || (
      Object.hasOwn(value, "domainId")
      && !DOMAIN_PATTERN.test(value.domainId)
    )
  ) {
    throw new Error("Model governance resource is invalid.");
  }
  return {
    id: value.id,
    ...(Object.hasOwn(value, "domainId")
      ? { domainId: value.domainId }
      : {}),
    lifecycleState: value.lifecycleState,
  };
}

function resourceRef(resource) {
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    ...resource,
  })).toString("base64url");
  if (encoded.length > MAX_RESOURCE_REF_BYTES) {
    throw new Error("Model governance resource is invalid.");
  }
  return `model-governance:${encoded}`;
}

function decodeResourceRef(value) {
  if (
    typeof value !== "string"
    || !value.startsWith("model-governance:")
  ) {
    throw new Error("Model governance resource reference is invalid.");
  }
  const encoded = value.slice("model-governance:".length);
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (
      encoded.length === 0
      || bytes.byteLength > MAX_RESOURCE_REF_BYTES
      || bytes.toString("base64url") !== encoded
    ) {
      throw new Error();
    }
    const decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !isPlainObject(decoded)
      || decoded.v !== 1
      || Reflect.ownKeys(decoded).some(
        (key) =>
          typeof key !== "string"
          || !["v", "id", "domainId", "lifecycleState"].includes(key),
      )
    ) {
      throw new Error();
    }
    const { v: _version, ...resource } = decoded;
    return validateResource(resource);
  } catch {
    throw new Error("Model governance resource reference is invalid.");
  }
}

function validateRequestContext(value) {
  if (
    !exactKeys(
      value,
      new Set(["source", "subject", "role", "domainIds"]),
    )
    || value.source !== "model-governance-service"
    || !SUBJECT_PATTERN.test(value.subject)
    || !ROLES.has(value.role)
    || !Array.isArray(value.domainIds)
    || value.domainIds.length > MAX_DOMAINS
    || value.domainIds.some((domainId) => !DOMAIN_PATTERN.test(domainId))
    || new Set(value.domainIds).size !== value.domainIds.length
  ) {
    throw new Error("Model governance authorization context is invalid.");
  }
  return value;
}

function numericClock(clock) {
  const value = clock();
  const timestamp = value instanceof Date
    ? value.getTime()
    : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Model governance authorization clock is invalid.");
  }
  return timestamp;
}

export function createModelGovernanceAuthorizer({
  workspaceState,
  clock,
} = {}) {
  if (
    !workspaceState
    || typeof workspaceState.getApproval !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError(
      "Model governance authorizer configuration is invalid.",
    );
  }
  const central = createAuthorizer({
    async resolvePrincipal({ requestContext, resourceRef: reference }) {
      decodeResourceRef(reference);
      const context = validateRequestContext(requestContext);
      return {
        id: context.subject,
        role: context.role,
        domainIds: [...context.domainIds],
        projectIds: [],
      };
    },
    async resolveResource({ resourceRef: reference }) {
      return decodeResourceRef(reference);
    },
    async resolveApproval({
      action,
      approvalRef,
      resource,
    }) {
      if (
        action !== "model-access:decide"
        || !APPROVAL_ID_PATTERN.test(approvalRef)
        || !DOMAIN_PATTERN.test(resource.domainId)
      ) {
        throw new Error("Model access approval reference is invalid.");
      }
      const approval = await workspaceState.getApproval({
        domainId: resource.domainId,
        approvalId: approvalRef,
      });
      if (approval === null) return null;
      if (
        !isPlainObject(approval)
        || approval.domainId !== resource.domainId
        || approval.id !== approvalRef
        || approval.kind !== "RESOURCE_ACCESS"
        || approval.resourceType !== "MODEL"
        || approval.projectId !== null
        || approval.status !== "PENDING"
        || !SUBJECT_PATTERN.test(approval.requesterSubject)
      ) {
        throw new Error("Model access approval state is invalid.");
      }
      return {
        requesterId: approval.requesterSubject,
        resourceId: resource.id,
        action,
      };
    },
    async resolvePolicy({ resourceRef: reference }) {
      decodeResourceRef(reference);
      return { allowed: true };
    },
    clock: () => numericClock(clock),
  });

  return async function authorizeModelGovernance(input) {
    if (
      !isPlainObject(input)
      || Reflect.ownKeys(input).some(
        (key) =>
          typeof key !== "string"
          || !["identity", "action", "resource", "approvalId"].includes(key),
      )
      || !Object.hasOwn(input, "identity")
      || !Object.hasOwn(input, "action")
      || !Object.hasOwn(input, "resource")
      || !ACTIONS.has(input.action)
      || (
        input.action === "model-access:decide"
        && !APPROVAL_ID_PATTERN.test(input.approvalId)
      )
      || (
        input.action !== "model-access:decide"
        && Object.hasOwn(input, "approvalId")
      )
    ) {
      throw new Error("Model governance authorization input is invalid.");
    }
    const identity = validateIdentity(input.identity);
    const resource = validateResource(input.resource);
    return central({
      requestContext: {
        source: "model-governance-service",
        subject: identity.actor,
        role: identity.role,
        domainIds: identity.domainIds,
      },
      action: input.action,
      resourceRef: resourceRef(resource),
      ...(input.action === "model-access:decide"
        ? { approvalRef: input.approvalId }
        : {}),
    });
  };
}

export function createModelGovernanceRuntime({
  modelPolicyState,
  workspaceState,
  domainDirectory,
  inventoryReader,
  rateLimitManager,
  identityVerifier,
  clock,
} = {}) {
  if (
    !modelPolicyState
    || !workspaceState
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || typeof inventoryReader !== "function"
    || !rateLimitManager
    || typeof rateLimitManager.reconcile !== "function"
    || typeof identityVerifier !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError("Model governance runtime configuration is invalid.");
  }
  const service = createModelGovernanceService({
    modelPolicyState,
    workspaceState,
    domainDirectory,
    inventoryReader,
    rateLimitManager,
    authorizer: createModelGovernanceAuthorizer({
      workspaceState,
      clock,
    }),
  });
  return createModelGovernanceHandler({
    identityProjector: createProductionIdentityProjector(),
    identityVerifier,
    domainDirectory: {
      async listActiveDomains() {
        return (await domainDirectory.listActiveDomains())
          .map(({ id }) => ({ id }));
      },
    },
    service,
  });
}

export function createModelGovernanceEntrypoint({
  apiHandler,
  seedHandler,
} = {}) {
  if (
    typeof apiHandler !== "function"
    || typeof seedHandler !== "function"
  ) {
    throw new TypeError("Model governance entrypoint is invalid.");
  }
  return async function modelGovernanceEntrypoint(event, context) {
    if (
      isPlainObject(event)
      && ["Create", "Update", "Delete"].includes(event.RequestType)
    ) {
      return seedHandler(event, context);
    }
    return apiHandler(event, context);
  };
}

function configuredHandler() {
  if (productionEntrypoint) return productionEntrypoint;
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const serialized = process.env.CONTROL_PLANE_CONFIG;
  if (
    typeof tableName !== "string"
    || !tableName.trim()
    || typeof serialized !== "string"
    || !serialized.trim()
  ) {
    throw new Error("Model governance runtime configuration is unavailable.");
  }
  const config = JSON.parse(serialized);
  const clock = () => new Date();
  const dynamo = new DynamoDBClient({});
  const domainState = createPlatformState({
    tableName: tableName.trim(),
    dynamo,
    now: clock,
  });
  const domainDirectory = createActiveDomainRecordDirectory(domainState);
  const workspaceState = createWorkspaceState({
    tableName: tableName.trim(),
    dynamo,
    now: clock,
  });
  const modelPolicyState = createModelPolicyState({
    tableName: tableName.trim(),
    dynamo,
    now: () => clock().toISOString(),
  });
  const gatewayCredentials = createGatewayCredentialsProvider({
    stsClient: new STSClient({
      region: config.llmGatewayRegion,
      credentials: dynamo.config.credentials,
    }),
    roleArn: process.env.GATEWAY_INVOKER_ROLE_ARN,
    clock,
  });
  const controlPlane = createControlPlaneService({
    config,
    domainState,
    credentials: ({ abortSignal }) => gatewayCredentials({
      sourceIdentity: "platform",
      abortSignal,
    }),
  });
  const gatewayControl = new BedrockAgentCoreControlClient({
    region: config.llmGatewayRegion,
  });
  const rateLimitManager = createGatewayRateLimitReconciler({
    client: gatewayControl,
    gatewayIdentifier: config.llmGatewayId,
    now: clock,
  });
  const inventoryReader = () => controlPlane.aiGateway({
    actor: "model-governance-service",
    username: "model-governance-service",
    requestId: "model-governance-model-catalog",
    role: "admin",
    activeDomain: null,
    allowedDomains: [],
    capabilities: [],
    authenticatedRole: "admin",
    assumedRole: null,
  });
  const service = createModelGovernanceService({
    modelPolicyState,
    workspaceState,
    domainDirectory,
    inventoryReader,
    rateLimitManager,
    authorizer: createModelGovernanceAuthorizer({
      workspaceState,
      clock,
    }),
  });
  const apiHandler = createModelGovernanceHandler({
    identityProjector: createProductionIdentityProjector(),
    identityVerifier: verifyCurrentDemoOperator,
    domainDirectory: {
      async listActiveDomains() {
        return (await domainDirectory.listActiveDomains())
          .map(({ id }) => ({ id }));
      },
    },
    service,
  });
  productionEntrypoint = createModelGovernanceEntrypoint({
    apiHandler,
    seedHandler: (event, context) =>
      handleBaselineModelPolicySeed(event, context, service),
  });
  return productionEntrypoint;
}

export async function handler(event, context) {
  return configuredHandler()(event, context);
}
