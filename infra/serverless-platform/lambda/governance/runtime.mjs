import {
  AgentRegistryControlClient,
} from "@aws-sdk/client-agent-registry-control";
import {
  DynamoDBClient,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createAuthorizer,
  createWorkspaceBreakGlassResolver,
} from "../authz/authorize.mjs";
import {
  createActiveDomainRecordDirectory,
} from "../api/domain-directory.mjs";
import {
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
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
  createVisibilityCatalogReader,
  createVisibilityCatalogWriter,
} from "../workspace/catalog-visibility.mjs";
import {
  createGovernanceHandler,
} from "./index.mjs";
import {
  createGovernanceService,
} from "./service.mjs";
import { createGuardrailExceptionStore } from "./guardrail-exceptions.mjs";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const APPROVAL_REF =
  /^approval:([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\/([a-z][a-z0-9-]{0,63})$/;
const MAX_RESOURCE_REF_BYTES = 8 * 1024;
const MUTATION_CLAIM_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  "actor",
  "requesterSubject",
  "effectiveRole",
  "domainId",
  "projectId",
  "route",
  "requestId",
  "payloadFingerprint",
  "resourceKey",
  "operation",
  "createdAt",
]);
const MANDATORY_TAGS = Object.freeze({
  "auto-delete": "no",
  managedBy: "cdk",
  project: "agentic-ai-platform-demo",
});

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

function ownDataValue(value, key, required = true) {
  if (!isPlainObject(value)) {
    throw new Error("Governance authorization reference is invalid.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (!required) return { present: false, value: undefined };
    throw new Error("Governance authorization reference is invalid.");
  }
  if (
    !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  ) {
    throw new Error("Governance authorization reference is invalid.");
  }
  return { present: true, value: descriptor.value };
}

function validString(value, maximum = 1024) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function decodeResourceRef(value) {
  if (
    typeof value !== "string"
    || !value.startsWith("governance:")
  ) {
    throw new Error("Governance authorization reference is invalid.");
  }
  const encoded = value.slice("governance:".length);
  let decoded;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (
      encoded.length === 0
      || bytes.byteLength > MAX_RESOURCE_REF_BYTES
      || bytes.toString("base64url") !== encoded
    ) {
      throw new Error();
    }
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("Governance authorization reference is invalid.");
  }
  if (!isPlainObject(decoded) || ownDataValue(decoded, "v").value !== 1) {
    throw new Error("Governance authorization reference is invalid.");
  }
  const id = ownDataValue(decoded, "id").value;
  const lifecycleState = ownDataValue(
    decoded,
    "lifecycleState",
  ).value;
  const domain = ownDataValue(decoded, "domainId", false);
  const project = ownDataValue(decoded, "projectId", false);
  const owner = ownDataValue(decoded, "ownerId", false);
  const assignees = ownDataValue(decoded, "assigneeIds", false);
  if (
    !validString(id)
    || !validString(lifecycleState, 64)
    || (
      domain.present
      && !DOMAIN_PATTERN.test(domain.value)
    )
    || (
      project.present
      && !SLUG_PATTERN.test(project.value)
    )
    || (
      owner.present
      && !SUBJECT_PATTERN.test(owner.value)
    )
    || (
      assignees.present
      && (
        !Array.isArray(assignees.value)
        || assignees.value.length > 100
        || assignees.value.some(
          (subject) => !SUBJECT_PATTERN.test(subject),
        )
        || new Set(assignees.value).size !== assignees.value.length
      )
    )
  ) {
    throw new Error("Governance authorization reference is invalid.");
  }
  return Object.freeze({
    id,
    lifecycleState,
    ...(domain.present ? { domainId: domain.value } : {}),
    ...(project.present ? { projectId: project.value } : {}),
    ...(owner.present ? { ownerId: owner.value } : {}),
    ...(assignees.present
      ? { assigneeIds: Object.freeze([...assignees.value]) }
      : {}),
  });
}

function parseApprovalRef(value) {
  if (typeof value !== "string") {
    throw new Error("Governance approval reference is invalid.");
  }
  const match = APPROVAL_REF.exec(value);
  if (!match) {
    throw new Error("Governance approval reference is invalid.");
  }
  return { domainId: match[1], approvalId: match[2] };
}

function numericClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Governance authorization clock is invalid.");
  }
  return timestamp;
}

function dynamoString(item, key) {
  const attribute = item[key];
  if (
    !isPlainObject(attribute)
    || Reflect.ownKeys(attribute).length !== 1
    || typeof attribute.S !== "string"
  ) {
    throw new Error("Governance mutation claim is invalid.");
  }
  return attribute.S;
}

function dynamoNullableString(item, key) {
  const attribute = item[key];
  if (
    isPlainObject(attribute)
    && Reflect.ownKeys(attribute).length === 1
    && attribute.NULL === true
  ) {
    return null;
  }
  return dynamoString(item, key);
}

export function createGovernanceMutationClaimResolver({
  dynamo,
  tableName,
} = {}) {
  if (
    !dynamo
    || typeof dynamo.send !== "function"
    || typeof tableName !== "string"
    || !tableName.trim()
  ) {
    throw new TypeError(
      "Governance mutation claim resolver configuration is invalid.",
    );
  }
  const resolvedTableName = tableName.trim();
  return async function resolveMutationClaim({
    actor,
    route,
    requestId,
  }) {
    if (
      !SUBJECT_PATTERN.test(actor)
      || !validString(route, 256)
      || !validString(requestId, 128)
    ) {
      throw new Error("Governance mutation claim reference is invalid.");
    }
    const pk = `MUTATION#${actor}`;
    const sk = `CLAIM#${route}#${requestId}`;
    const response = await dynamo.send(new GetItemCommand({
      TableName: resolvedTableName,
      Key: {
        pk: { S: pk },
        sk: { S: sk },
      },
      ConsistentRead: true,
    }));
    if (!isPlainObject(response)) {
      throw new Error("Governance mutation claim response is invalid.");
    }
    if (response.Item === undefined) return null;
    const item = response.Item;
    const keys = new Set(Reflect.ownKeys(item));
    if (
      !isPlainObject(item)
      || (
        keys.size !== MUTATION_CLAIM_ITEM_KEYS.size
        && !(
          keys.size === MUTATION_CLAIM_ITEM_KEYS.size + 1
          && keys.has("expiresAt")
        )
      )
      || [...MUTATION_CLAIM_ITEM_KEYS].some((key) => !keys.has(key))
      || dynamoString(item, "pk") !== pk
      || dynamoString(item, "sk") !== sk
      || dynamoString(item, "entityType") !== "MUTATION_CLAIM"
    ) {
      throw new Error("Governance mutation claim response is invalid.");
    }
    return Object.freeze({
      actor: dynamoString(item, "actor"),
      requesterSubject: dynamoString(item, "requesterSubject"),
      effectiveRole: dynamoString(item, "effectiveRole"),
      domainId: dynamoString(item, "domainId"),
      projectId: dynamoNullableString(item, "projectId"),
      route: dynamoString(item, "route"),
      requestId: dynamoString(item, "requestId"),
      payloadFingerprint: dynamoString(item, "payloadFingerprint"),
      resourceKey: dynamoString(item, "resourceKey"),
      operation: dynamoString(item, "operation"),
    });
  };
}

export function createGovernanceAuthorizer({
  workspaceState,
  clock,
}) {
  return async function authorizeGovernance(input) {
    let authorizationEvidenceId = null;
    const resolveBreakGlass = async (context) => {
      let selectedEvidenceId = null;
      const resolver = createWorkspaceBreakGlassResolver({
        workspaceState: {
          async listBreakGlass(query) {
            const page = await workspaceState.listBreakGlass(query);
            if (isPlainObject(page) && Array.isArray(page.items)) {
              for (const record of page.items) {
                if (
                  !isPlainObject(record)
                  || record.requesterSubject !== context.principal.id
                  || record.domainId !== context.resource.domainId
                  || record.resource !== context.resource.id
                  || record.action !== context.action
                  || record.status !== "ACTIVE"
                ) {
                  continue;
                }
                if (!SLUG_PATTERN.test(record.id)) {
                  throw new Error(
                    "Break-glass authorization evidence is invalid.",
                  );
                }
                selectedEvidenceId = record.id;
                break;
              }
            }
            return page;
          },
        },
      });
      const grant = await resolver(context);
      if (grant !== null) {
        if (selectedEvidenceId === null) {
          throw new Error(
            "Break-glass authorization evidence is unavailable.",
          );
        }
        authorizationEvidenceId = selectedEvidenceId;
      }
      return grant;
    };
    const authorize = createAuthorizer({
      async resolvePrincipal({ requestContext, resourceRef }) {
        decodeResourceRef(resourceRef);
        if (
          !isPlainObject(requestContext)
          || requestContext.source !== "governance-service"
          || !SUBJECT_PATTERN.test(requestContext.subject)
          || !["admin", "lead", "builder"].includes(requestContext.role)
          || !Array.isArray(requestContext.domainIds)
          || requestContext.domainIds.length > 100
          || requestContext.domainIds.some(
            (domainId) => !DOMAIN_PATTERN.test(domainId),
          )
        ) {
          throw new Error("Governance authorization context is invalid.");
        }
        return {
          id: requestContext.subject,
          role: requestContext.role,
          domainIds: [...requestContext.domainIds],
          projectIds: [],
        };
      },
      async resolveResource({ resourceRef }) {
        return decodeResourceRef(resourceRef);
      },
      async resolveApproval({
        action,
        approvalRef,
        principal,
        resource,
      }) {
        const ref = parseApprovalRef(approvalRef);
        const approval = await workspaceState.getApproval(ref);
        if (approval === null) return null;
        if (
          !isPlainObject(approval)
          || approval.domainId !== ref.domainId
          || approval.id !== ref.approvalId
          || !SUBJECT_PATTERN.test(approval.requesterSubject)
          || approval.resourceId !== resource.id
          || !["PENDING", "APPROVED", "REJECTED"].includes(
            approval.status,
          )
          || (
            approval.status !== "PENDING"
            && approval.approverSubject !== principal.id
          )
        ) {
          throw new Error("Governance approval state is invalid.");
        }
        return {
          requesterId: approval.requesterSubject,
          resourceId: approval.resourceId,
          action,
        };
      },
      async resolvePolicy({ resourceRef }) {
        decodeResourceRef(resourceRef);
        return { allowed: true };
      },
      resolveBreakGlass,
      clock: () => numericClock(clock),
    });
    const result = await authorize(input);
    if (!result.usedBreakGlass) return result;
    if (authorizationEvidenceId === null) {
      throw new Error(
        "Break-glass authorization evidence is unavailable.",
      );
    }
    return Object.freeze({
      ...result,
      authorizationEvidenceId,
    });
  };
}

export function createGovernanceRuntime({
  workspaceState,
  domainDirectory,
  registryClient,
  identityVerifier,
  mutationClaimResolver,
  clock,
  mandatoryTags = MANDATORY_TAGS,
  sharedRegistry = null,
  visibilityCatalog = null,
  exceptionStore = null,
} = {}) {
  const resolvedMutationClaimResolver =
    typeof mutationClaimResolver === "function"
      ? mutationClaimResolver
      : workspaceState?.getMutationClaim?.bind(workspaceState);
  if (
    !workspaceState
    || ![
      "beginTransaction",
      "getApproval",
      "getResourceGrant",
      "getEntitlement",
      "getProject",
      "getAgent",
      "listAgentEntitlements",
      "listDeployments",
      "listBreakGlass",
      "putApproval",
      "putResourceGrant",
      "putEntitlement",
      "putAccessDecision",
    ].every((method) => typeof workspaceState[method] === "function")
    || !domainDirectory
    || typeof domainDirectory.getDomain !== "function"
    || typeof domainDirectory.listActiveDomains !== "function"
    || !registryClient
    || typeof registryClient.send !== "function"
    || typeof identityVerifier !== "function"
    || typeof resolvedMutationClaimResolver !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError("Governance runtime configuration is invalid.");
  }
  const service = createGovernanceService({
    workspaceState,
    domainDirectory,
    registryClient,
    authorizer: createGovernanceAuthorizer({ workspaceState, clock }),
    mutationClaimResolver: resolvedMutationClaimResolver,
    mandatoryTags,
    sharedRegistry,
    visibilityCatalog,
    exceptionStore,
  });
  return createGovernanceHandler({
    identityProjector: createProductionIdentityProjector(),
    identityVerifier,
    domainDirectory: {
      async listActiveDomains() {
        return (await domainDirectory.listActiveDomains())
          .map(({ id }) => ({ id }));
      },
    },
    governanceService: service,
  });
}

function configuredHandler() {
  if (productionHandler) return productionHandler;
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  if (typeof tableName !== "string" || !tableName.trim()) {
    throw new Error("Governance runtime configuration is unavailable.");
  }
  const clock = () => new Date();
  const dynamo = new DynamoDBClient({});
  const workspaceState = createWorkspaceState({
    tableName: tableName.trim(),
    dynamo,
    now: clock,
  });
  const domainState = createPlatformState({
    tableName: tableName.trim(),
    dynamo,
    now: clock,
  });
  // Shared-registry reviews are enabled only when the deployment provides the
  // registry identity; malformed configuration fails closed to the previous
  // domain-registries-only behavior rather than guessing.
  let sharedRegistry = null;
  const sharedRegistryId = process.env.SHARED_REGISTRY_ID;
  const sharedRegistryArn = process.env.SHARED_REGISTRY_ARN;
  if (
    typeof sharedRegistryId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sharedRegistryId)
    && typeof sharedRegistryArn === "string"
    && sharedRegistryArn.endsWith(`:registry/${sharedRegistryId}`)
  ) {
    sharedRegistry = {
      registryId: sharedRegistryId,
      registryArn: sharedRegistryArn,
    };
  }
  productionHandler = createGovernanceRuntime({
    workspaceState,
    domainDirectory: createActiveDomainRecordDirectory(domainState),
    registryClient: new AgentRegistryControlClient({}),
    identityVerifier: verifyCurrentDemoOperator,
    mutationClaimResolver: createGovernanceMutationClaimResolver({
      dynamo,
      tableName: tableName.trim(),
    }),
    clock,
    sharedRegistry,
    exceptionStore: createGuardrailExceptionStore({ dynamo, tableName: tableName.trim() }),
    visibilityCatalog: {
      read: createVisibilityCatalogReader({
        tableName: tableName.trim(),
        dynamo,
      }),
      write: createVisibilityCatalogWriter({
        tableName: tableName.trim(),
        dynamo,
      }),
    },
  });
  return productionHandler;
}

export async function handler(event, context) {
  return configuredHandler()(event, context);
}
