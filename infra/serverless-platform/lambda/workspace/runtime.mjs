import { STSClient } from "@aws-sdk/client-sts";
import { createControlPlaneService } from "../control-plane/service.mjs";
import { createModelPolicyState } from "../model-governance/state.mjs";
import { createGatewayCredentialsProvider } from "./gateway-credentials.mjs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createProjectResourceValidator } from "./project-resources.mjs";
import {
  createAuthorizer,
} from "../authz/authorize.mjs";
import {
  createActiveDomainDirectory,
} from "../api/domain-directory.mjs";
import {
  projectEffectiveIdentity,
  projectIdentity,
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
import {
  createPlatformState,
} from "../platform-admin/state.mjs";
import {
  createWorkspaceHandler,
} from "./index.mjs";
import {
  createWorkspaceState,
} from "./state.mjs";

const ROUTES_BY_ACTION = Object.freeze({
  "project:create": "projects",
  "workspace.projects.read": "projects",
  "workspace.agents.read": "agents",
  "workspace.deployments.read": "deployments",
  "workspace.approvals.read": "approvals",
});
const COLLECTION_AUTHORIZATION_STATES = Object.freeze({
  projects: "ACTIVE",
  agents: "ACTIVE",
  deployments: "REQUESTED",
  approvals: "PENDING",
});
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_DOMAIN_SCOPES = 100;
const MAX_ASSIGNEES = 101;
const COLLECTION_KEYS = new Set([
  "v",
  "route",
  "subject",
  "role",
  "activeDomain",
  "domainIds",
]);
const ITEM_KEYS = new Set([
  "v",
  "route",
  "id",
  "domainId",
  "projectId",
  "ownerId",
  "assigneeIds",
  "lifecycleState",
]);
const DOMAIN_KEYS = new Set([
  "v",
  "route",
  "domainId",
  "projectId",
  "subject",
]);

let productionHandler;

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

function hasExactKeys(value, expected) {
  return (
    isPlainObject(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key))
  );
}

function readOwnDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    throw new Error("Workspace authorization context is invalid.");
  }
  return descriptor.value;
}

function snapshotStringArray(value, maximum, validator) {
  if (!Array.isArray(value)) return null;
  const length = readOwnDataProperty(value, "length");
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    return null;
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const item = readOwnDataProperty(value, String(index));
    if (!validator(item)) return null;
    snapshot.push(item);
  }
  return new Set(snapshot).size === snapshot.length ? snapshot : null;
}

function nonEmptyString(value, maxLength = 1024) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validDomainId(value) {
  return (
    nonEmptyString(value, 64)
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function validSubject(value) {
  return (
    nonEmptyString(value, 256)
    && SUBJECT_PATTERN.test(value)
  );
}

function validUniqueStrings(value, maximum, validator = nonEmptyString) {
  return (
    Array.isArray(value)
    && value.length <= maximum
    && value.every((item) => validator(item))
    && new Set(value).size === value.length
  );
}

function ownCognitoSubject(claims) {
  if (!isPlainObject(claims)) return "";
  const descriptor = Object.getOwnPropertyDescriptor(claims, "sub");
  return descriptor && Object.hasOwn(descriptor, "value")
    && validSubject(descriptor.value)
    ? descriptor.value
    : "";
}

export function createProductionIdentityProjector({
  authenticatedProjector = projectIdentity,
  effectiveProjector = projectEffectiveIdentity,
} = {}) {
  if (
    typeof authenticatedProjector !== "function"
    || typeof effectiveProjector !== "function"
  ) {
    throw new TypeError("Production identity projector is invalid.");
  }

  return Object.freeze({
    projectAuthenticated(claims) {
      const projected = authenticatedProjector(claims);
      if (!isPlainObject(projected)) {
        throw new Error("Authenticated identity projection is invalid.");
      }
      return {
        ...projected,
        actor: ownCognitoSubject(claims),
      };
    },
    projectEffective(claims, headers, options) {
      const projected = effectiveProjector(claims, headers, options);
      if (!isPlainObject(projected)) {
        throw new Error("Effective identity projection is invalid.");
      }
      return {
        ...projected,
        actor: ownCognitoSubject(claims),
      };
    },
  });
}

function decodeDescriptor(resourceRef, prefix) {
  try {
    const encoded = resourceRef.slice(prefix.length);
    const decoded = Buffer.from(encoded, "base64url");
    if (
      encoded.length === 0
      || decoded.toString("base64url") !== encoded
    ) {
      throw new Error("Workspace authorization reference is invalid.");
    }
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("Workspace authorization reference is invalid.");
  }
}

function validateRequestContext(requestContext) {
  if (!isPlainObject(requestContext)) {
    throw new Error("Workspace authorization context is invalid.");
  }
  const source = readOwnDataProperty(requestContext, "source");
  const subject = readOwnDataProperty(requestContext, "subject");
  const role = readOwnDataProperty(requestContext, "role");
  const activeDomain = readOwnDataProperty(requestContext, "activeDomain");
  const domainIds = snapshotStringArray(
    readOwnDataProperty(requestContext, "domainIds"),
    MAX_DOMAIN_SCOPES,
    validDomainId,
  );
  if (
    source !== "workspace-api"
    || !validSubject(subject)
    || !ROLES.has(role)
    || (
      activeDomain !== null
      && !validDomainId(activeDomain)
    )
    || domainIds === null
  ) {
    throw new Error("Workspace authorization context is invalid.");
  }
  return Object.freeze({
    source,
    subject,
    role,
    activeDomain,
    domainIds: Object.freeze(domainIds),
  });
}

function resolveAuthorizationDescriptor({
  requestContext,
  action,
  resourceRef,
}) {
  const route = ROUTES_BY_ACTION[action];
  if (!route || typeof resourceRef !== "string") {
    throw new Error("Workspace authorization reference is invalid.");
  }
  const validatedContext = validateRequestContext(requestContext);

  const collectionPrefix = `workspace-collection:${route}:`;
  const itemPrefix = `workspace-item:${route}:`;
  const domainPrefix = `workspace-domain:${route}:`;
  if (action === "project:create") {
    if (!resourceRef.startsWith(domainPrefix)) {
      throw new Error("Workspace authorization reference is invalid.");
    }
    const descriptor = decodeDescriptor(resourceRef, domainPrefix);
    if (
      !hasExactKeys(descriptor, DOMAIN_KEYS)
      || descriptor.v !== 1
      || descriptor.route !== route
      || !validDomainId(descriptor.domainId)
      || !PROJECT_ID_PATTERN.test(descriptor.projectId)
      || descriptor.subject !== validatedContext.subject
    ) {
      throw new Error("Workspace authorization reference is invalid.");
    }
    return {
      kind: "domain",
      descriptor,
      requestContext: validatedContext,
    };
  }

  if (resourceRef.startsWith(collectionPrefix)) {
    const descriptor = decodeDescriptor(resourceRef, collectionPrefix);
    if (
      !hasExactKeys(descriptor, COLLECTION_KEYS)
      || descriptor.v !== 1
      || descriptor.route !== route
      || descriptor.subject !== validatedContext.subject
      || descriptor.role !== validatedContext.role
      || descriptor.activeDomain !== validatedContext.activeDomain
      || !validUniqueStrings(
        descriptor.domainIds,
        MAX_DOMAIN_SCOPES,
        validDomainId,
      )
      || JSON.stringify(descriptor.domainIds)
        !== JSON.stringify(validatedContext.domainIds)
    ) {
      throw new Error("Workspace authorization reference is invalid.");
    }
    return {
      kind: "collection",
      descriptor,
      requestContext: validatedContext,
    };
  }

  if (!resourceRef.startsWith(itemPrefix)) {
    throw new Error("Workspace authorization reference is invalid.");
  }
  const descriptor = decodeDescriptor(resourceRef, itemPrefix);
  if (
    !hasExactKeys(descriptor, ITEM_KEYS)
    || descriptor.v !== 1
    || descriptor.route !== route
    || !nonEmptyString(descriptor.id, 256)
    || !validDomainId(descriptor.domainId)
    || !nonEmptyString(descriptor.projectId, 64)
    || !validSubject(descriptor.ownerId)
    || !validUniqueStrings(
      descriptor.assigneeIds,
      MAX_ASSIGNEES,
      validSubject,
    )
    || !nonEmptyString(descriptor.lifecycleState, 64)
  ) {
    throw new Error("Workspace authorization reference is invalid.");
  }
  return {
    kind: "item",
    descriptor,
    requestContext: validatedContext,
  };
}

export function createWorkspaceInventoryAuthorizer() {
  return createAuthorizer({
    async resolvePrincipal(input) {
      const resolved = resolveAuthorizationDescriptor(input);
      const { requestContext } = resolved;
      const assignedToItem =
        resolved.kind === "item"
        && (
          resolved.descriptor.ownerId === requestContext.subject
          || resolved.descriptor.assigneeIds.includes(
            requestContext.subject,
          )
        );
      return {
        id: requestContext.subject,
        role: requestContext.role,
        domainIds: [...requestContext.domainIds],
        projectIds: resolved.kind === "collection"
          ? ["workspace-collection"]
          : resolved.kind === "item" && assignedToItem
            ? [resolved.descriptor.projectId]
            : [],
      };
    },
    async resolveResource(input) {
      const resolved = resolveAuthorizationDescriptor(input);
      if (resolved.kind === "item") return resolved.descriptor;
      if (resolved.kind === "domain") {
        return {
          id: input.resourceRef,
          domainId: resolved.descriptor.domainId,
          lifecycleState: "ACTIVE",
        };
      }
      return {
        id: input.resourceRef,
        domainId:
          resolved.descriptor.activeDomain
          || resolved.descriptor.domainIds[0]
          || "platform",
        projectId: "workspace-collection",
        ownerId: resolved.descriptor.subject,
        assigneeIds: [resolved.descriptor.subject],
        lifecycleState:
          COLLECTION_AUTHORIZATION_STATES[resolved.descriptor.route],
      };
    },
    async resolvePolicy(input) {
      resolveAuthorizationDescriptor(input);
      return { allowed: true };
    },
    clock: Date.now,
  });
}

function configuredHandler() {
  if (productionHandler) return productionHandler;

  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  if (typeof tableName !== "string" || !tableName.trim()) {
    throw new Error("Platform state table configuration is unavailable.");
  }
  const dynamo = new DynamoDBClient({});
  const workspaceState = createWorkspaceState({
    tableName: tableName.trim(),
    dynamo,
    now: () => new Date(),
  });
  const domainState = createPlatformState({
    tableName: tableName.trim(),
    dynamo,
    now: () => new Date(),
  });
  const authorizer = createWorkspaceInventoryAuthorizer();

  productionHandler = createWorkspaceHandler({
    projectCreateTimeoutMs: 25_000,
    identityProjector: createProductionIdentityProjector(),
    identityVerifier: verifyCurrentDemoOperator,
    domainDirectory: createActiveDomainDirectory(domainState),
    workspaceState,
    authorizer,
    projectResourceValidator: createProjectResourceValidator({ dynamo, tableName: tableName.trim(),
      catalogProvider: async ({ domainId, abortSignal }) => {
        abortSignal?.throwIfAborted();
        const config = JSON.parse(process.env.CONTROL_PLANE_CONFIG || "null");
        if (!config) throw new Error("Project resource catalog is not configured.");
        const credentials = createGatewayCredentialsProvider({
          stsClient: new STSClient({ region: config.llmGatewayRegion, credentials: dynamo.config.credentials }),
          roleArn: process.env.GATEWAY_INVOKER_ROLE_ARN,
        });
        const inventory = await createControlPlaneService({ config, domainState,
          modelPolicyState: createModelPolicyState({ tableName: tableName.trim(), dynamo, now: () => new Date() }),
          credentials: ({ abortSignal }) => credentials({ sourceIdentity: `domain_${domainId}`, abortSignal }),
        }).registry({ role: domainId === "platform" ? "admin" : "lead", activeDomain: domainId, allowedDomains: [domainId] });
        abortSignal?.throwIfAborted();
        return inventory;
      },
    }),
  });
  return productionHandler;
}

export async function handler(event, context) {
  return configuredHandler()(event, context);
}
