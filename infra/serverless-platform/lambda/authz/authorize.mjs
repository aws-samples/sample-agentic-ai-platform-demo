import { capabilitiesForRole } from "./capabilities.mjs";

const DECISION_DETAILS = Object.freeze({
  NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "Resource not found.",
  }),
  FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "The requested action is not permitted.",
  }),
  CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The resource state does not permit the requested action.",
  }),
});

const ROLES = new Set(["admin", "lead", "builder", "user"]);
const INPUT_KEYS = new Set([
  "requestContext",
  "action",
  "resourceRef",
  "approvalRef",
]);
const REQUIRED_DEPENDENCIES = Object.freeze([
  "resolvePrincipal",
  "resolveResource",
  "resolvePolicy",
  "clock",
]);
const OPTIONAL_DEPENDENCIES = Object.freeze([
  "resolveEntitlement",
  "resolveApproval",
  "resolveBreakGlass",
]);
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BREAK_GLASS_PAGE_SIZE = 100;
const MAX_BREAK_GLASS_PAGES = 100;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readOwnDataProperty(value, key, required = true) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) throw new TypeError(`Missing property ${key}.`);
    return Object.freeze({ present: false, value: undefined });
  }
  if (!hasOwn(descriptor, "value")) {
    throw new TypeError(`Property ${key} must be a data property.`);
  }
  return Object.freeze({ present: true, value: descriptor.value });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function snapshotStringList(value) {
  if (!Array.isArray(value)) return null;
  const lengthProperty = readOwnDataProperty(value, "length");
  if (
    !Number.isSafeInteger(lengthProperty.value)
    || lengthProperty.value < 0
  ) {
    return null;
  }

  const snapshot = [];
  for (let index = 0; index < lengthProperty.value; index += 1) {
    const item = readOwnDataProperty(value, String(index));
    if (!isNonEmptyString(item.value)) return null;
    snapshot.push(item.value);
  }
  return snapshot;
}

function parseTimestamp(value) {
  if (!isNonEmptyString(value) || !ISO_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function actionContract({
  capability,
  capabilitiesByRole,
  operation,
  domainScope = false,
  projectScope = false,
  selectedDomainScope = false,
  ownerRoles = [],
  entitlement = false,
  approval = false,
  adminPlatformOnly = false,
  adminSelectedDomainMutation = false,
  protectedTrace = false,
  allowedStates,
}) {
  return deepFreeze({
    capability: capability ?? null,
    capabilitiesByRole: capabilitiesByRole
      ? { ...capabilitiesByRole }
      : null,
    operation,
    domainScope,
    projectScope,
    ...(selectedDomainScope ? { selectedDomainScope: true } : {}),
    ownerRoles: [...ownerRoles],
    entitlement,
    approval,
    ...(adminPlatformOnly ? { adminPlatformOnly: true } : {}),
    ...(adminSelectedDomainMutation
      ? { adminSelectedDomainMutation: true }
      : {}),
    protectedTrace,
    allowedStates: [...allowedStates],
  });
}

const contracts = Object.create(null);
const AGENT_READ_STATES = Object.freeze([
  "DRAFT",
  "CONFIGURED",
  "READY_FOR_TEST",
  "TEST_FAILED",
  "TESTED",
  "SANDBOX_ACTIVE",
  "SANDBOX_DEPLOYED",
  "PENDING_APPROVAL",
  "PRODUCTION_PENDING",
  "APPROVED",
  "PRODUCTION_APPROVED",
  "ACTIVE",
  "PRODUCTION_DEPLOYED",
  "SUSPENDED",
  "FAILED",
  "REJECTED",
  "RETIRED",
]);

for (const action of ["read", "grant", "revoke"]) {
  contracts[`access.domain-members.${action}`] = actionContract({
    capabilitiesByRole: action === "read"
      ? {
          admin: "viewPlatformInventory",
          lead: "manageDomainMembers",
        }
      : {
          admin: "managePlatformPolicy",
          lead: "manageDomainMembers",
        },
    operation: action === "read"
      ? "read"
      : "domain-content-mutation",
    domainScope: true,
    selectedDomainScope: true,
    allowedStates: ["ACTIVE"],
  });
  contracts[`access.project-members.${action}`] = actionContract({
    capabilitiesByRole: action === "read"
      ? {
          admin: "viewPlatformInventory",
          lead: "manageDomainMembers",
        }
      : {
          admin: "managePlatformPolicy",
          lead: "manageDomainMembers",
        },
    operation: action === "read"
      ? "read"
      : "domain-content-mutation",
    domainScope: true,
    projectScope: true,
    selectedDomainScope: true,
    allowedStates: ["ACTIVE"],
  });
}

contracts["project:read"] = actionContract({
  capability: "viewAssignedProjects",
  operation: "read",
  domainScope: true,
  projectScope: true,
  allowedStates: ["DRAFT", "ACTIVE", "SUSPENDED"],
});
contracts["project:create"] = actionContract({
  capabilitiesByRole: {
    admin: "usePlatformBuilderWorkspace",
    lead: "createDomainProject",
  },
  operation: "domain-content-mutation",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["agent:read"] = actionContract({
  capability: "viewDomainInventory",
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: AGENT_READ_STATES,
});
contracts["agent:create"] = actionContract({
  capability: "createAgent",
  operation: "domain-content-mutation",
  domainScope: true,
  projectScope: true,
  adminSelectedDomainMutation: true,
  ownerRoles: ["builder"],
  allowedStates: ["ACTIVE"],
});
contracts["agent:update"] = actionContract({
  capability: "editOwnedAgent",
  operation: "domain-content-mutation",
  domainScope: true,
  projectScope: true,
  adminSelectedDomainMutation: true,
  ownerRoles: ["builder"],
  allowedStates: ["DRAFT", "REJECTED"],
});
contracts["agent:test"] = actionContract({
  capability: "testAgent",
  operation: "domain-content-mutation",
  domainScope: true,
  projectScope: true,
  adminSelectedDomainMutation: true,
  ownerRoles: ["builder"],
  allowedStates: ["READY_FOR_TEST", "TEST_FAILED", "TESTED"],
});
contracts["agent:sandbox-deploy"] = actionContract({
  capability: "deployAgentToSandbox",
  operation: "domain-content-mutation",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: ["TESTED"],
});
contracts["agent:production-submit"] = actionContract({
  capability: "submitAgentProductionDeployment",
  operation: "domain-content-mutation",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: ["TESTED", "SANDBOX_DEPLOYED"],
});
contracts["deployment:approve"] = actionContract({
  capabilitiesByRole: {
    admin: "approvePlatformDeployment",
    lead: "approveDomainDeployment",
  },
  operation: "domain-approval",
  domainScope: true,
  projectScope: true,
  approval: true,
  adminPlatformOnly: true,
  allowedStates: [
    "PENDING_APPROVAL",
    "APPROVED",
    "DEPLOYING",
    "DEPLOYED",
    "REJECTED",
  ],
});
contracts["trace:read-content"] = actionContract({
  capability: "viewDomainOperations",
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  protectedTrace: true,
  allowedStates: ["ACTIVE", "RUNNING", "FAILED"],
});
contracts["agent:invoke"] = actionContract({
  capability: "invokeEntitledAgent",
  operation: "invoke",
  entitlement: true,
  allowedStates: ["ACTIVE"],
});
contracts["agent:access-request"] = actionContract({
  capability: "requestAgentAccess",
  operation: "user-request",
  allowedStates: ["ACTIVE"],
});
contracts["agent:entitlement-decide"] = actionContract({
  capability: "manageDomainEntitlements",
  operation: "domain-approval",
  domainScope: true,
  approval: true,
  allowedStates: ["PENDING_APPROVAL"],
});
contracts["agent:entitlement-grant"] = actionContract({
  capabilitiesByRole: {
    admin: "managePlatformPolicy",
    lead: "manageDomainEntitlements",
  },
  operation: "domain-approval",
  domainScope: true,
  allowedStates: ["PRODUCTION_DEPLOYED"],
});
contracts["agent:entitlement-revoke"] = actionContract({
  capabilitiesByRole: {
    admin: "managePlatformPolicy",
    lead: "manageDomainEntitlements",
  },
  operation: "domain-approval",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["platform-policy:update"] = actionContract({
  capability: "managePlatformPolicy",
  operation: "platform-governance-mutation",
  allowedStates: ["ACTIVE"],
});
contracts["model-catalog:read"] = actionContract({
  capabilitiesByRole: {
    admin: "manageModelAccessPolicy",
    lead: "selectApprovedModel",
    builder: "selectApprovedModel",
  },
  operation: "read",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["model-policy:update"] = actionContract({
  capability: "manageModelAccessPolicy",
  operation: "platform-governance-mutation",
  allowedStates: ["ACTIVE"],
});
contracts["model-access:request"] = actionContract({
  capability: "requestModelAccess",
  operation: "domain-content-mutation",
  domainScope: true,
  allowedStates: ["REQUESTABLE"],
});
contracts["model-access:decide"] = actionContract({
  capability: "decideDomainResourceAccess",
  operation: "domain-approval",
  domainScope: true,
  approval: true,
  allowedStates: ["PENDING_APPROVAL"],
});
contracts["model:use"] = actionContract({
  capability: "selectApprovedModel",
  operation: "domain-content-mutation",
  domainScope: true,
  adminSelectedDomainMutation: true,
  allowedStates: ["ACTIVE"],
});
contracts["workspace.projects.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformInventory",
    lead: "viewDomainInventory",
    builder: "viewAssignedProjects",
  },
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: ["DRAFT", "ACTIVE", "ARCHIVED", "SUSPENDED"],
});
contracts["workspace.agents.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformInventory",
    lead: "viewDomainInventory",
    builder: "viewDomainInventory",
  },
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: AGENT_READ_STATES,
});
contracts["workspace.deployments.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformInventory",
    lead: "viewDomainOperations",
    builder: "viewOwnedOperations",
  },
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: [
    "REQUESTED",
    "PENDING_APPROVAL",
    "APPROVED",
    "REJECTED",
    "DEPLOYING",
    "DEPLOYED",
    "FAILED",
    "SUSPENDED",
    "CANCELLED",
    "RETIRED",
  ],
});
contracts["workspace.approvals.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformAudit",
    lead: "viewDomainAudit",
    builder: "viewOwnedOperations",
  },
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: [
    "PENDING",
    "PENDING_APPROVAL",
    "APPROVED",
    "REJECTED",
    "CANCELLED",
  ],
});
contracts["workspace.operations.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformOperations",
    lead: "viewDomainOperations",
    builder: "viewOwnedOperations",
  },
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: ["ACTIVE", "RUNNING", "FAILED", "SUSPENDED"],
});
contracts["workspace.costs.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformCost",
    lead: "viewDomainCost",
    builder: "viewOwnedCost",
  },
  operation: "read",
  domainScope: true,
  projectScope: true,
  ownerRoles: ["builder"],
  allowedStates: ["ACTIVE"],
});
// The consolidated AWS bill has no domain/project scope to narrow — it is a
// platform-owner report, so only the admin capability unlocks it.
contracts["workspace.platform-costs.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformCost",
  },
  operation: "read",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["workspace.audit.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformAudit",
    lead: "viewDomainAudit",
  },
  operation: "read",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["workspace.incidents.read"] = actionContract({
  capabilitiesByRole: {
    admin: "viewPlatformOperations",
    lead: "viewDomainOperations",
    builder: "viewOwnedIncidents",
  },
  operation: "read",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["workspace.incidents.create"] = actionContract({
  capabilitiesByRole: {
    admin: "managePlatformIncidents",
    lead: "manageDomainIncidents",
  },
  operation: "operational-mutation",
  domainScope: true,
  projectScope: true,
  allowedStates: ["ACTIVE"],
});
for (const action of ["acknowledge", "resolve", "reopen"]) {
  contracts[`workspace.incidents.${action}`] = actionContract({
    capabilitiesByRole: {
      admin: "managePlatformIncidents",
      lead: "manageDomainIncidents",
    },
    operation: "operational-mutation",
    domainScope: true,
    projectScope: true,
    allowedStates: action === "acknowledge"
      ? ["OPEN"]
      : action === "resolve"
        ? ["ACKNOWLEDGED"]
        : ["RESOLVED"],
  });
}
contracts["workspace.break-glass.read"] = actionContract({
  capability: "viewBreakGlassAudit",
  operation: "read",
  allowedStates: ["ACTIVE"],
});
contracts["workspace.break-glass.request"] = actionContract({
  capability: "requestBreakGlassAccess",
  operation: "platform-governance-mutation",
  domainScope: true,
  allowedStates: ["REQUESTED"],
});
contracts["workspace.break-glass.decide"] = actionContract({
  capability: "approveBreakGlassAccess",
  operation: "platform-governance-mutation",
  domainScope: true,
  allowedStates: ["REQUESTED"],
});
contracts["workspace.break-glass.activate"] = actionContract({
  capability: "activateBreakGlassAccess",
  operation: "platform-governance-mutation",
  domainScope: true,
  allowedStates: ["APPROVED"],
});
contracts["workspace.break-glass.revoke"] = actionContract({
  capability: "revokeBreakGlassAccess",
  operation: "platform-governance-mutation",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["resource:draft-register"] = actionContract({
  capability: "registerDomainResourceDraft",
  operation: "domain-content-mutation",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});
contracts["resource:publication-submit"] = actionContract({
  capability: "submitDomainResourcePublication",
  operation: "domain-content-mutation",
  domainScope: true,
  ownerRoles: ["builder"],
  allowedStates: ["DRAFT", "REJECTED"],
});
// Platform admin initiates a formal publication request on the owner's behalf
// for a genuinely-pending resource in ANY domain, so an admin-discovered
// in-review resource is no longer a dead-end. Modeled as a platform-governance
// mutation (admin platform-wide, no break-glass) and gated on a dedicated
// admin-only capability; the request is still decided under the normal
// approval contract, so the reviewer trail is preserved.
contracts["resource:publication-initiate"] = actionContract({
  capability: "initiateDomainResourcePublication",
  operation: "platform-governance-mutation",
  domainScope: true,
  allowedStates: ["DRAFT", "REJECTED", "PENDING_APPROVAL"],
});
contracts["resource:publication-approve"] = actionContract({
  capabilitiesByRole: {
    admin: "approvePlatformPublication",
    lead: "approveDomainPublication",
  },
  operation: "domain-approval",
  domainScope: true,
  approval: true,
  adminPlatformOnly: true,
  allowedStates: ["PENDING_APPROVAL", "APPROVED", "REJECTED"],
});
contracts["shared-resource:discover"] = actionContract({
  capability: "discoverSharedResources",
  operation: "read",
  allowedStates: ["APPROVED"],
});
// The platform team's post-approval decision on which domains may discover an
// approved catalog record. Platform-scope mutation, admin capability only.
contracts["resource:visibility-set"] = actionContract({
  capabilitiesByRole: {
    admin: "manageCatalogVisibility",
  },
  operation: "platform-governance-mutation",
  domainScope: true,
  allowedStates: ["APPROVED"],
});
contracts["resource:access-request"] = actionContract({
  capability: "requestSharedResourceAccess",
  operation: "domain-content-mutation",
  domainScope: true,
  allowedStates: ["APPROVED"],
});
contracts["resource:access-decide"] = actionContract({
  capability: "decideDomainResourceAccess",
  operation: "domain-approval",
  domainScope: true,
  approval: true,
  allowedStates: ["PENDING_APPROVAL"],
});
contracts["resource:access-revoke"] = actionContract({
  capability: "decideDomainResourceAccess",
  operation: "domain-approval",
  domainScope: true,
  allowedStates: ["ACTIVE"],
});

export const ACTION_CONTRACTS = Object.freeze(contracts);

export class AuthorizationError extends Error {
  constructor(decision, reason, cause) {
    const details = DECISION_DETAILS[decision];
    if (!details) throw new TypeError("Unknown authorization decision.");

    super(details.message);
    Object.defineProperties(this, {
      name: {
        value: "AuthorizationError",
        configurable: true,
      },
      decision: {
        value: decision,
        enumerable: true,
      },
      statusCode: {
        value: details.statusCode,
        enumerable: true,
      },
      reason: {
        value: reason,
        enumerable: false,
      },
      ...(cause === undefined
        ? {}
        : {
            cause: {
              value: cause,
              enumerable: false,
            },
          }),
    });
  }

  toJSON() {
    return {
      decision: this.decision,
      statusCode: this.statusCode,
      message: this.message,
    };
  }
}

function deny(decision, reason, cause) {
  throw new AuthorizationError(decision, reason, cause);
}

function invalidInput() {
  deny("FORBIDDEN", "INVALID_INPUT");
}

function validateDependencies(dependencies) {
  if (!isRecord(dependencies)) {
    throw new TypeError("Authorizer dependencies must be a plain object.");
  }

  const validated = Object.create(null);
  for (const name of REQUIRED_DEPENDENCIES) {
    const property = readOwnDataProperty(dependencies, name, false);
    if (!property.present || typeof property.value !== "function") {
      throw new TypeError(`Authorizer dependency ${name} must be a function.`);
    }
    validated[name] = property.value;
  }
  for (const name of OPTIONAL_DEPENDENCIES) {
    const property = readOwnDataProperty(dependencies, name, false);
    if (property.present && typeof property.value !== "function") {
      throw new TypeError(`Authorizer dependency ${name} must be a function.`);
    }
    if (property.present) validated[name] = property.value;
  }
  return Object.freeze(validated);
}

function validateRequest(input) {
  if (!isRecord(input)) invalidInput();
  const keys = Reflect.ownKeys(input);
  if (
    keys.some(
      (key) => typeof key !== "string" || !INPUT_KEYS.has(key),
    )
  ) {
    invalidInput();
  }

  function requestValue(key, required = true) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) {
      if (required) invalidInput();
      return undefined;
    }
    if (!hasOwn(descriptor, "value")) invalidInput();
    return descriptor.value;
  }

  const requestContext = requestValue("requestContext");
  const action = requestValue("action");
  const resourceRef = requestValue("resourceRef");
  const approvalRef = requestValue("approvalRef", false);
  if (
    !isNonEmptyString(action)
    || !isNonEmptyString(resourceRef)
    || !hasOwn(ACTION_CONTRACTS, action)
  ) {
    invalidInput();
  }

  const contract = ACTION_CONTRACTS[action];
  if (
    contract.approval
    && !isNonEmptyString(approvalRef)
  ) {
    invalidInput();
  }
  if (!contract.approval && approvalRef !== undefined) invalidInput();

  return {
    requestContext,
    action,
    resourceRef,
    approvalRef,
    contract,
  };
}

async function resolveAuthoritative(resolver, args, reason) {
  try {
    return await resolver(args);
  } catch (error) {
    deny("FORBIDDEN", `${reason}_RESOLVER_FAILED`, error);
  }
}

function normalizeAuthoritative(normalizer, value, reason, ...args) {
  try {
    return normalizer(value, ...args);
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    deny("FORBIDDEN", `${reason}_INVALID`, error);
  }
}

function normalizePrincipal(value) {
  if (!isRecord(value)) {
    deny("FORBIDDEN", "PRINCIPAL_INVALID");
  }
  const id = readOwnDataProperty(value, "id").value;
  const role = readOwnDataProperty(value, "role").value;
  const domainIds = snapshotStringList(
    readOwnDataProperty(value, "domainIds").value,
  );
  const projectIds = snapshotStringList(
    readOwnDataProperty(value, "projectIds").value,
  );
  const activeDomainProperty =
    readOwnDataProperty(value, "activeDomain", false);
  const activeDomain = activeDomainProperty.present
    ? activeDomainProperty.value
    : null;
  if (
    !isNonEmptyString(id)
    || !ROLES.has(role)
    || domainIds === null
    || projectIds === null
    || (
      activeDomain !== null
      && (
        !isNonEmptyString(activeDomain)
        || !domainIds.includes(activeDomain)
      )
    )
  ) {
    deny("FORBIDDEN", "PRINCIPAL_INVALID");
  }

  return Object.freeze({
    id,
    role,
    activeDomain,
    domainIds: Object.freeze(domainIds),
    projectIds: Object.freeze(projectIds),
    capabilities: capabilitiesForRole(role),
  });
}

function normalizeResource(value, contract) {
  if (value === null || value === undefined) {
    deny("NOT_FOUND", "RESOURCE_MISSING");
  }
  if (!isRecord(value)) {
    deny("FORBIDDEN", "RESOURCE_INVALID");
  }

  const id = readOwnDataProperty(value, "id").value;
  const lifecycleState = readOwnDataProperty(value, "lifecycleState").value;
  const domainProperty = readOwnDataProperty(value, "domainId", false);
  const projectProperty = readOwnDataProperty(value, "projectId", false);
  const ownerProperty = readOwnDataProperty(value, "ownerId", false);
  const assigneeProperty = readOwnDataProperty(value, "assigneeIds", false);
  const assigneeIds = assigneeProperty.present
    ? snapshotStringList(assigneeProperty.value)
    : [];

  if (!isNonEmptyString(id) || !isNonEmptyString(lifecycleState)) {
    deny("FORBIDDEN", "RESOURCE_INVALID");
  }
  if (
    (domainProperty.present && !isNonEmptyString(domainProperty.value))
    || (projectProperty.present && !isNonEmptyString(projectProperty.value))
    || (ownerProperty.present && !isNonEmptyString(ownerProperty.value))
    || assigneeIds === null
  ) {
    deny("FORBIDDEN", "RESOURCE_INVALID");
  }

  if (contract.domainScope && !isNonEmptyString(domainProperty.value)) {
    deny("FORBIDDEN", "RESOURCE_INVALID");
  }
  if (contract.projectScope && !isNonEmptyString(projectProperty.value)) {
    deny("FORBIDDEN", "RESOURCE_INVALID");
  }
  if (
    contract.ownerRoles.length > 0
    && (
      !isNonEmptyString(ownerProperty.value)
      || assigneeIds === null
    )
  ) {
    deny("FORBIDDEN", "RESOURCE_INVALID");
  }

  return Object.freeze({
    id,
    domainId: domainProperty.value,
    projectId: projectProperty.value,
    ownerId: ownerProperty.value,
    assigneeIds: Object.freeze(assigneeIds),
    lifecycleState,
  });
}

function normalizePolicy(value) {
  if (!isRecord(value)) {
    deny("FORBIDDEN", "POLICY_INVALID");
  }
  const allowed = readOwnDataProperty(value, "allowed").value;
  if (typeof allowed !== "boolean") {
    deny("FORBIDDEN", "POLICY_INVALID");
  }
  return Object.freeze({ allowed });
}

function normalizeEntitlement(value) {
  if (!isRecord(value)) {
    deny("FORBIDDEN", "ENTITLEMENT_INVALID");
  }
  const granted = readOwnDataProperty(value, "granted").value;
  if (typeof granted !== "boolean") {
    deny("FORBIDDEN", "ENTITLEMENT_INVALID");
  }
  return Object.freeze({ granted });
}

function normalizeApproval(value) {
  if (!isRecord(value)) {
    deny("FORBIDDEN", "APPROVAL_INVALID");
  }
  const requesterId = readOwnDataProperty(value, "requesterId").value;
  const resourceId = readOwnDataProperty(value, "resourceId").value;
  const action = readOwnDataProperty(value, "action").value;
  if (
    !isNonEmptyString(requesterId)
    || !isNonEmptyString(resourceId)
    || !isNonEmptyString(action)
  ) {
    deny("FORBIDDEN", "APPROVAL_INVALID");
  }
  return Object.freeze({
    requesterId,
    resourceId,
    action,
  });
}

function normalizeBreakGlass(value) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    deny("FORBIDDEN", "BREAK_GLASS_INVALID");
  }
  const actorId = readOwnDataProperty(value, "actorId").value;
  const resourceId = readOwnDataProperty(value, "resourceId").value;
  const action = readOwnDataProperty(value, "action").value;
  const active = readOwnDataProperty(value, "active").value;
  const activatedAt = parseTimestamp(
    readOwnDataProperty(value, "activatedAt").value,
  );
  const expiresAt = parseTimestamp(
    readOwnDataProperty(value, "expiresAt").value,
  );
  if (
    !isNonEmptyString(actorId)
    || !isNonEmptyString(resourceId)
    || !isNonEmptyString(action)
    || typeof active !== "boolean"
    || activatedAt === null
    || expiresAt === null
  ) {
    deny("FORBIDDEN", "BREAK_GLASS_INVALID");
  }
  return Object.freeze({
    actorId,
    resourceId,
    action,
    active,
    activatedAt,
    expiresAt,
  });
}

function frozenResolverArgs(context, additions = {}) {
  return Object.freeze({
    requestContext: context.requestContext,
    action: context.action,
    resourceRef: context.resourceRef,
    ...(context.approvalRef === undefined
      ? {}
      : { approvalRef: context.approvalRef }),
    ...additions,
  });
}

function requiresBreakGlass(contract, principal, resource) {
  const selectedDomainBuild =
    contract.adminSelectedDomainMutation === true
    && principal.activeDomain === resource.domainId;
  // "shared" is the platform-curated catalog: reviewing its records is
  // ordinary platform-admin work, not a cross-domain intervention, so it does
  // not demand break-glass any more than the platform domain does.
  const externalDomainMutation =
    principal.role === "admin"
    && (
      contract.operation === "domain-content-mutation"
      || contract.operation === "domain-approval"
      || contract.operation === "operational-mutation"
    )
    && resource.domainId !== "platform"
    && resource.domainId !== "shared"
    && !selectedDomainBuild;
  const protectedTraceRead =
    principal.role === "admin" && contract.protectedTrace;

  return externalDomainMutation || protectedTraceRead;
}

function activeMatchingBreakGlass({
  grant,
  principal,
  resource,
  action,
  now,
}) {
  return grant !== null
    && grant.active === true
    && grant.actorId === principal.id
    && grant.resourceId === resource.id
    && grant.action === action
    && grant.activatedAt <= now
    && grant.expiresAt > now;
}

function enforceScope(contract, principal, resource) {
  if (principal.role === "admin") return;

  if (
    contract.selectedDomainScope
    && principal.role === "lead"
    && principal.domainIds.length !== 1
  ) {
    deny("NOT_FOUND", "SELECTED_DOMAIN_SCOPE");
  }

  if (
    contract.domainScope
    && !principal.domainIds.includes(resource.domainId)
  ) {
    deny("NOT_FOUND", "DOMAIN_SCOPE");
  }

  if (
    contract.projectScope
    && principal.role !== "lead"
    && !principal.projectIds.includes(resource.projectId)
  ) {
    deny("NOT_FOUND", "PROJECT_SCOPE");
  }

  if (
    contract.ownerRoles.includes(principal.role)
    && resource.ownerId !== principal.id
    && !resource.assigneeIds.includes(principal.id)
  ) {
    deny("NOT_FOUND", "OWNER_SCOPE");
  }
}

function requiredCapability(contract, role) {
  if (contract.capabilitiesByRole !== null) {
    return hasOwn(contract.capabilitiesByRole, role)
      ? contract.capabilitiesByRole[role]
      : null;
  }
  return contract.capability;
}

function readClock(clock) {
  let now;
  try {
    now = clock();
  } catch (error) {
    deny("FORBIDDEN", "CLOCK_INVALID", error);
  }
  if (!Number.isFinite(now) || now < 0) {
    deny("FORBIDDEN", "CLOCK_INVALID");
  }
  return now;
}

export function createWorkspaceBreakGlassResolver({
  workspaceState,
} = {}) {
  if (
    !workspaceState
    || typeof workspaceState.listBreakGlass !== "function"
  ) {
    throw new TypeError("Break-glass resolver configuration is invalid.");
  }
  return async function resolveWorkspaceBreakGlass({
    action,
    principal,
    resource,
  } = {}) {
    if (
      !isRecord(principal)
      || !isRecord(resource)
      || !isNonEmptyString(action)
      || !isNonEmptyString(principal.id)
      || !isNonEmptyString(resource.id)
      || !isNonEmptyString(resource.domainId)
    ) {
      throw new TypeError("Break-glass lookup context is invalid.");
    }

    let cursor;
    const seenCursors = new Set();
    for (let pageNumber = 0;
      pageNumber < MAX_BREAK_GLASS_PAGES;
      pageNumber += 1) {
      const page = await workspaceState.listBreakGlass({
        requesterSubject: principal.id,
        limit: BREAK_GLASS_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (
        !isRecord(page)
        || !Array.isArray(page.items)
        || !(page.cursor === null || isRecord(page.cursor))
      ) {
        throw new TypeError("Break-glass state page is invalid.");
      }

      for (const record of page.items) {
        if (!isRecord(record)) {
          throw new TypeError("Break-glass state record is invalid.");
        }
        const requesterSubject =
          readOwnDataProperty(record, "requesterSubject").value;
        const domainId = readOwnDataProperty(record, "domainId").value;
        const resourceId = readOwnDataProperty(record, "resource").value;
        const recordAction = readOwnDataProperty(record, "action").value;
        if (
          requesterSubject !== principal.id
          || domainId !== resource.domainId
          || resourceId !== resource.id
          || recordAction !== action
        ) {
          continue;
        }

        const status = readOwnDataProperty(record, "status").value;
        if (status !== "ACTIVE") continue;
        const activatedBySubject =
          readOwnDataProperty(record, "activatedBySubject").value;
        const activatedAt =
          readOwnDataProperty(record, "activatedAt").value;
        const expiresAt = readOwnDataProperty(record, "expiresAt").value;
        const revokedBySubject =
          readOwnDataProperty(record, "revokedBySubject").value;
        const revokedAt = readOwnDataProperty(record, "revokedAt").value;
        if (
          activatedBySubject !== principal.id
          || parseTimestamp(activatedAt) === null
          || parseTimestamp(expiresAt) === null
          || revokedBySubject !== null
          || revokedAt !== null
        ) {
          throw new TypeError("Active break-glass grant is invalid.");
        }
        return Object.freeze({
          actorId: principal.id,
          resourceId: resource.id,
          action,
          active: true,
          activatedAt,
          expiresAt,
        });
      }

      if (page.cursor === null) return null;
      const pk = readOwnDataProperty(page.cursor, "pk").value;
      const sk = readOwnDataProperty(page.cursor, "sk").value;
      if (!isNonEmptyString(pk) || !isNonEmptyString(sk)) {
        throw new TypeError("Break-glass state cursor is invalid.");
      }
      const cursorKey = `${pk}\u0000${sk}`;
      if (seenCursors.has(cursorKey)) {
        throw new TypeError("Break-glass state cursor repeated.");
      }
      seenCursors.add(cursorKey);
      cursor = Object.freeze({ pk, sk });
    }
    throw new TypeError("Break-glass lookup exceeded its page limit.");
  };
}

export function createAuthorizer(dependencies) {
  const validatedDependencies = validateDependencies(dependencies);
  const {
    resolvePrincipal,
    resolveResource,
    resolvePolicy,
    resolveEntitlement,
    resolveApproval,
    resolveBreakGlass,
    clock,
  } = validatedDependencies;

  return async function authorizeRequest(input) {
    let context;
    try {
      context = validateRequest(input);
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      deny("FORBIDDEN", "INVALID_INPUT", error);
    }

    const rawPrincipal = await resolveAuthoritative(
      resolvePrincipal,
      frozenResolverArgs(context),
      "PRINCIPAL",
    );
    const principal = normalizeAuthoritative(
      normalizePrincipal,
      rawPrincipal,
      "PRINCIPAL",
    );
    const capability = requiredCapability(context.contract, principal.role);
    if (
      capability === null
      || !principal.capabilities.includes(capability)
    ) {
      deny("FORBIDDEN", "CAPABILITY");
    }

    const rawResource = await resolveAuthoritative(
      resolveResource,
      frozenResolverArgs(context, { principal }),
      "RESOURCE",
    );
    const resource = normalizeAuthoritative(
      normalizeResource,
      rawResource,
      "RESOURCE",
      context.contract,
    );

    enforceScope(context.contract, principal, resource);

    // The shared catalog is platform-curated: its records have no domain team,
    // so their reviews are platform-admin work exactly like platform-domain
    // ones. Leads/builders are never scoped into "shared" (identity rejects
    // it), so admitting it here widens nothing for non-admins.
    const platformCurated = resource.domainId === "platform"
      || resource.domainId === "shared";
    if (
      context.contract.adminPlatformOnly === true
      && (
        (
          principal.role === "admin"
          && !platformCurated
        )
        || (
          principal.role !== "admin"
          && platformCurated
        )
      )
    ) {
      deny("FORBIDDEN", "PLATFORM_APPROVAL_SCOPE");
    }

    if (context.contract.entitlement) {
      if (typeof resolveEntitlement !== "function") {
        deny("FORBIDDEN", "ENTITLEMENT_RESOLVER_UNAVAILABLE");
      }
      const rawEntitlement = await resolveAuthoritative(
        resolveEntitlement,
        frozenResolverArgs(context, { principal, resource }),
        "ENTITLEMENT",
      );
      const entitlement = normalizeAuthoritative(
        normalizeEntitlement,
        rawEntitlement,
        "ENTITLEMENT",
      );
      if (!entitlement.granted) deny("NOT_FOUND", "ENTITLEMENT");
    }

    let approval = null;
    if (context.contract.approval) {
      if (typeof resolveApproval !== "function") {
        deny("FORBIDDEN", "APPROVAL_RESOLVER_UNAVAILABLE");
      }
      const rawApproval = await resolveAuthoritative(
        resolveApproval,
        frozenResolverArgs(context, { principal, resource }),
        "APPROVAL",
      );
      if (rawApproval === null || rawApproval === undefined) {
        deny("NOT_FOUND", "APPROVAL_MISSING");
      }
      approval = normalizeAuthoritative(
        normalizeApproval,
        rawApproval,
        "APPROVAL",
      );
      if (
        approval.resourceId !== resource.id
        || approval.action !== context.action
      ) {
        deny("NOT_FOUND", "APPROVAL_SCOPE");
      }
    }

    let usedBreakGlass = false;
    let breakGlassGrant = null;
    if (requiresBreakGlass(context.contract, principal, resource)) {
      if (typeof resolveBreakGlass !== "function") {
        deny("FORBIDDEN", "BREAK_GLASS_RESOLVER_UNAVAILABLE");
      }
      const rawGrant = await resolveAuthoritative(
        resolveBreakGlass,
        frozenResolverArgs(context, { principal, resource }),
        "BREAK_GLASS",
      );
      const grant = normalizeAuthoritative(
        normalizeBreakGlass,
        rawGrant,
        "BREAK_GLASS",
      );
      if (grant === null) {
        deny("FORBIDDEN", "BREAK_GLASS_REQUIRED");
      }
      const now = readClock(clock);
      if (!activeMatchingBreakGlass({
        grant,
        principal,
        resource,
        action: context.action,
        now,
      })) {
        deny("FORBIDDEN", "BREAK_GLASS_REQUIRED");
      }
      usedBreakGlass = true;
      breakGlassGrant = grant;
    }

    const rawPolicy = await resolveAuthoritative(
      resolvePolicy,
      frozenResolverArgs(context, { principal, resource }),
      "POLICY",
    );
    const policy = normalizeAuthoritative(
      normalizePolicy,
      rawPolicy,
      "POLICY",
    );
    if (!policy.allowed) deny("FORBIDDEN", "POLICY");

    if (approval !== null && approval.requesterId === principal.id) {
      deny("FORBIDDEN", "REQUESTER_IS_APPROVER");
    }

    if (
      !context.contract.allowedStates.includes(resource.lifecycleState)
    ) {
      deny("CONFLICT", "LIFECYCLE");
    }

    if (
      usedBreakGlass
      && !activeMatchingBreakGlass({
        grant: breakGlassGrant,
        principal,
        resource,
        action: context.action,
        now: readClock(clock),
      })
    ) {
      deny("FORBIDDEN", "BREAK_GLASS_REQUIRED");
    }

    return Object.freeze({
      ok: true,
      decision: "ALLOW",
      actorId: principal.id,
      role: principal.role,
      action: context.action,
      resourceId: resource.id,
      usedBreakGlass,
    });
  };
}
