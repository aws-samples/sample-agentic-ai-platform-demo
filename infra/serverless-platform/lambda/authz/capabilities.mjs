const LEGACY_CAPABILITY_BUNDLES = {
  admin: [
    "viewAllDomains",
    "createDomain",
    "approveRegistryVersion",
    "manageRegistryEntries",
    "viewDomainCostRollup",
    "manageApprovalPolicies",
    "decideInterrupts",
    "manageAlertPolicies",
    "manageIncidents",
    "manageIntegrations",
    "manageModelAccess",
    "exportAudit",
    "approveAgentDeploy",
    "manageCapabilityBundles",
    "requestPlatformContentAccess",
    "decideBreakGlass",
    "attributeMemoryStores",
    "ownContentPlane",
    "viewDomainOperations",
    "viewAlerts",
    "useBuilderSurfaces",
    "manageProjectMembers",
    "viewAuditTrail",
  ],
  lead: [
    "useBuilderSurfaces",
    "domainContentPlane",
    "requestContentAccess",
    "requestModelAccess",
    "decideAccessRequests",
    "viewDomainCostRollup",
    "ownContentPlane",
    "viewDomainOperations",
    "viewAlerts",
    "manageProjectMembers",
    "viewAuditTrail",
  ],
  builder: [
    "useBuilderSurfaces",
    "domainContentPlane",
    "requestContentAccess",
    "requestModelAccess",
    "viewDomainOperations",
    "viewAlerts",
  ],
  user: [],
};

const BUILDER_CAPABILITIES = [
  "viewDomainInventory",
  "viewAssignedProjects",
  "viewDomainRegistry",
  "createAgent",
  "configureAgent",
  "editOwnedAgent",
  "selectApprovedModel",
  "selectApprovedTool",
  "selectApprovedMcpServer",
  "selectApprovedSkill",
  "selectApprovedBlueprint",
  "selectApprovedMemory",
  "selectApprovedKnowledgeBase",
  "testAgent",
  "deployAgentToSandbox",
  "submitAgentProductionDeployment",
  "registerDomainResourceDraft",
  "submitDomainResourcePublication",
  "discoverSharedResources",
  "requestSharedResourceAccess",
  "viewOwnedOperations",
  "viewOwnedIncidents",
  "viewOwnedCost",
  "retireOwnedResource",
];

const DOMAIN_LEAD_CAPABILITIES = [
  "useDomainBuilderWorkspace",
  "createDomainProject",
  "manageDomainProjects",
  "manageDomainMembers",
  "manageDomainPolicy",
  "manageDomainQuota",
  "manageDomainEntitlements",
  "approveDomainDeployment",
  "approveDomainPublication",
  "decideDomainResourceAccess",
  "suspendDomainResource",
  "manageDomainIncidents",
  "viewDomainCost",
  "viewDomainAudit",
];

const PLATFORM_ADMIN_CAPABILITIES = [
  "viewPlatformInventory",
  "createPlatformDomain",
  "managePlatformPolicy",
  "manageCapabilityPolicy",
  "manageGlobalQuota",
  "managePlatformIntegrations",
  "manageModelAccessPolicy",
  "manageGateway",
  "managePlatformAlerts",
  "managePlatformIncidents",
  "viewPlatformOperations",
  "viewPlatformCost",
  "viewPlatformAudit",
  "exportPlatformAudit",
  "requestBreakGlassAccess",
  "approveBreakGlassAccess",
  "activateBreakGlassAccess",
  "revokeBreakGlassAccess",
  "viewBreakGlassAudit",
  "approveRestrictedPolicyException",
  "approvePlatformDeployment",
  "approvePlatformPublication",
  "initiateDomainResourcePublication",
  "manageCatalogVisibility",
  "suspendGovernedResource",
  "usePlatformBuilderWorkspace",
];

const END_USER_CAPABILITIES = [
  "discoverEntitledAgents",
  "invokeEntitledAgent",
  "viewOwnSessions",
  "submitAgentFeedback",
  "requestAgentAccess",
];

function immutableUnique(values) {
  return Object.freeze([...new Set(values)]);
}

export const RESERVED_ACCESS_GROUP_NAMES = Object.freeze([
  "platform-admin",
  "domain-builder",
  "domain-lead",
  "end-user",
  "demo-operator",
]);

export const RESERVED_DOMAIN_IDS = Object.freeze([
  "builder",
  "lead",
  "platform_admin",
  "domain_builder",
  "end_user",
  "demo_operator",
]);

export const RESERVED_DOMAIN_GROUP_NAMES = Object.freeze(
  RESERVED_DOMAIN_IDS.map(
    (id) => `domain-${id.replaceAll("_", "-")}`,
  ),
);

export const ROLE_CAPABILITY_BUNDLES = Object.freeze({
  admin: immutableUnique([
    ...LEGACY_CAPABILITY_BUNDLES.admin.filter(
      (capability) =>
        capability !== "approveAgentDeploy",
    ),
    ...BUILDER_CAPABILITIES,
    ...PLATFORM_ADMIN_CAPABILITIES,
  ]),
  lead: immutableUnique([
    ...LEGACY_CAPABILITY_BUNDLES.lead,
    ...BUILDER_CAPABILITIES,
    ...DOMAIN_LEAD_CAPABILITIES,
  ]),
  builder: immutableUnique([
    ...LEGACY_CAPABILITY_BUNDLES.builder,
    ...BUILDER_CAPABILITIES,
  ]),
  user: immutableUnique(END_USER_CAPABILITIES),
});

export const CAPABILITIES = Object.freeze(
  Object.fromEntries(
    immutableUnique(
      Object.values(ROLE_CAPABILITY_BUNDLES).flat(),
    ).map((capability) => [capability, capability]),
  ),
);

const NO_CAPABILITIES = Object.freeze([]);

export function capabilitiesForRole(role) {
  return Object.hasOwn(ROLE_CAPABILITY_BUNDLES, role)
    ? ROLE_CAPABILITY_BUNDLES[role]
    : NO_CAPABILITIES;
}
