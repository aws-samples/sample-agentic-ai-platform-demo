export const HOSTED_DEPLOYED_ROUTES = Object.freeze([
  "GET /api/me",
  "GET /api/domains",
  "POST /api/domain-create",
  "GET /api/registry",
  "POST /api/registry-decide",
  "GET /api/ai-gateway",
  "POST /api/ai-gateway/model-policies",
  "POST /api/ai-gateway/model-access-requests",
  "POST /api/ai-gateway/model-access-decisions",
  "GET /api/projects",
  "POST /api/projects",
  "GET /api/agents",
  "GET /api/deployments",
  "GET /api/approvals",
  "POST /api/agents",
  "PUT /api/agents/{id}",
  "POST /api/agents/{id}/test",
  "POST /api/deployments/sandbox",
  "POST /api/deployments/production",
  "POST /api/deployment-decisions",
  "POST /api/journeys",
  "GET /api/journeys/{id}",
  "POST /api/journeys/{id}/messages",
  "POST /api/journeys/{id}/contract",
  "POST /api/delivery/previews",
  "GET /api/delivery/github",
  "GET /api/delivery/{id}",
  "POST /api/delivery/github/authorizations",
  "GET /oauth/github/callback",
  "POST /api/governance/agent-publications",
  "POST /api/governance/resources",
  "POST /api/governance/publications",
  "POST /api/governance/publication-decisions",
  "GET /api/governance/shared-resources",
  "POST /api/governance/access-requests",
  "POST /api/governance/access-decisions",
  "POST /api/governance/access-revocations",
  "GET /api/governance/agent-entitlements",
  "POST /api/governance/agent-entitlements",
  "POST /api/governance/agent-entitlement-revocations",
  "GET /api/access/domain-members",
  "POST /api/access/domain-memberships",
  "POST /api/access/domain-membership-revocations",
  "GET /api/access/project-members",
  "POST /api/access/project-memberships",
  "POST /api/access/project-membership-revocations",
  "GET /api/experience/agents",
  "POST /api/experience/invocations",
  "GET /api/experience/sessions",
  "GET /api/experience/access-requests",
  "POST /api/experience/feedback",
  "POST /api/experience/issues",
  "POST /api/experience/access-requests",
  "GET /api/operations",
  "GET /api/costs",
  "GET /api/operations/audit",
  "GET /api/incidents",
  "POST /api/incidents",
  "POST /api/incidents/{id}/actions",
  "GET /api/break-glass",
  "POST /api/break-glass/requests",
  "POST /api/break-glass/decisions",
  "POST /api/break-glass/activations",
  "POST /api/break-glass/revocations",
]);

const SURFACES = Object.freeze([
  {
    id: "dashboard",
    label: "Dashboard",
    view: "hosteddashboard",
    section: "PLATFORM",
    capabilitiesAny: ["viewPlatformInventory"],
    routesAll: [
      "GET /api/domains",
      "GET /api/projects",
      "GET /api/agents",
      "GET /api/deployments",
      "GET /api/approvals",
    ],
  },
  {
    id: "domains",
    label: "Domains",
    view: "domains",
    section: "PLATFORM",
    capabilitiesAny: ["viewPlatformInventory"],
    routesAll: ["GET /api/domains"],
  },
  {
    id: "registry",
    label: "AI Registry",
    view: "registry",
    section: "GOVERNANCE",
    capabilitiesAny: ["viewPlatformInventory", "viewDomainRegistry"],
    routesAll: ["GET /api/registry"],
  },
  {
    id: "gateway",
    label: "AI Gateway",
    view: "hostedgateway",
    section: "PLATFORM",
    capabilitiesAny: [
      "manageGateway",
      "manageModelAccessPolicy",
      "selectApprovedModel",
      "requestModelAccess",
      "decideDomainResourceAccess",
    ],
    routesAll: ["GET /api/ai-gateway"],
  },
  {
    id: "projects",
    label: "Projects",
    view: "hostedprojects",
    section: "BUILD WORKSPACE",
    capabilitiesAny: [
      "viewPlatformInventory",
      "viewDomainInventory",
      "viewAssignedProjects",
    ],
    routesAll: ["GET /api/projects"],
  },
  {
    id: "agents",
    label: "Agents",
    view: "hostedagents",
    section: "BUILD WORKSPACE",
    capabilitiesAny: [
      "viewPlatformInventory",
      "viewDomainInventory",
      "viewAssignedProjects",
    ],
    routesAll: ["GET /api/agents"],
  },
  {
    id: "deployments",
    label: "Deployments",
    view: "hosteddeployments",
    section: "BUILD WORKSPACE",
    capabilitiesAny: [
      "viewPlatformInventory",
      "viewDomainInventory",
      "viewAssignedProjects",
    ],
    routesAll: ["GET /api/deployments"],
  },
  {
    id: "approvals",
    label: "Approvals",
    view: "hostedapprovals",
    section: "GOVERNANCE",
    capabilitiesAny: [
      "viewPlatformInventory",
      "approvePlatformDeployment",
      "approvePlatformPublication",
      "approveDomainDeployment",
      "approveDomainPublication",
      "decideDomainResourceAccess",
      "submitAgentProductionDeployment",
    ],
    routesAll: ["GET /api/approvals"],
  },
  {
    id: "domainaccess",
    label: "Users & Access",
    view: "hostedaccessadmin",
    section: "GOVERNANCE",
    capabilitiesAny: [
      "managePlatformPolicy",
      "manageDomainEntitlements",
    ],
    routesAll: [
      "GET /api/governance/agent-entitlements",
      "POST /api/governance/agent-entitlements",
      "POST /api/governance/agent-entitlement-revocations",
      "GET /api/access/domain-members",
      "POST /api/access/domain-memberships",
      "POST /api/access/domain-membership-revocations",
      "GET /api/access/project-members",
      "POST /api/access/project-memberships",
      "POST /api/access/project-membership-revocations",
    ],
  },
  {
    id: "build",
    label: "Build Agent",
    view: "hostedbuild",
    section: "BUILD WORKSPACE",
    capabilitiesAny: [
      "usePlatformBuilderWorkspace",
      "useDomainBuilderWorkspace",
      "createAgent",
    ],
    routesAll: [
      "GET /api/projects",
      "GET /api/agents",
      "POST /api/agents",
      "PUT /api/agents/{id}",
      "POST /api/agents/{id}/test",
      "POST /api/deployments/sandbox",
      "POST /api/deployments/production",
      "POST /api/journeys",
      "GET /api/journeys/{id}",
      "POST /api/journeys/{id}/messages",
      "POST /api/journeys/{id}/contract",
      "POST /api/delivery/previews",
      "GET /api/delivery/github",
      "GET /api/delivery/{id}",
      "POST /api/delivery/github/authorizations",
      "GET /oauth/github/callback",
      "GET /api/registry",
      "GET /api/ai-gateway",
      "GET /api/governance/shared-resources",
    ],
  },
  {
    id: "overview",
    label: "Overview",
    view: "hostedoverview",
    section: "EXPERIENCE",
    capabilitiesAny: ["discoverEntitledAgents", "viewOwnSessions"],
    routesAll: [
      "GET /api/experience/agents",
      "GET /api/experience/sessions",
      "GET /api/experience/access-requests",
    ],
  },
  {
    id: "approvedagents",
    label: "Approved Agents",
    view: "approvedagents",
    section: "EXPERIENCE",
    capabilitiesAny: ["discoverEntitledAgents"],
    routesAll: [
      "GET /api/experience/agents",
      "POST /api/experience/invocations",
      "POST /api/experience/feedback",
      "POST /api/experience/issues",
      "POST /api/experience/access-requests",
    ],
  },
  {
    id: "operations",
    label: "Operations",
    view: "hostedoperations",
    section: "OPERATIONS",
    capabilitiesAny: [
      "viewPlatformOperations",
      "viewDomainOperations",
      "viewOwnedOperations",
    ],
    routesAll: ["GET /api/operations"],
  },
  {
    id: "cost",
    label: "Cost",
    view: "hostedcost",
    section: "OPERATIONS",
    capabilitiesAny: [
      "viewPlatformCost",
      "viewDomainCost",
      "viewOwnedCost",
    ],
    routesAll: ["GET /api/costs"],
  },
  {
    id: "audit",
    label: "Audit",
    view: "hostedaudit",
    section: "OPERATIONS",
    capabilitiesAny: ["viewPlatformAudit", "viewDomainAudit"],
    routesAll: ["GET /api/operations/audit"],
  },
  {
    id: "incidents",
    label: "Incidents",
    view: "hostedincidents",
    section: "OPERATIONS",
    capabilitiesAny: [
      "managePlatformIncidents",
      "manageDomainIncidents",
      "viewOwnedIncidents",
    ],
    routesAll: ["GET /api/incidents"],
  },
  {
    id: "breakglass",
    label: "Break-glass",
    view: "hostedbreakglass",
    section: "GOVERNANCE",
    capabilitiesAny: [
      "viewBreakGlassAudit",
      "requestBreakGlassAccess",
      "approveBreakGlassAccess",
      "activateBreakGlassAccess",
      "revokeBreakGlassAccess",
    ],
    routesAll: ["GET /api/break-glass"],
  },
  {
    id: "publications",
    label: "Resource Governance",
    view: "hostedpublications",
    section: "GOVERNANCE",
    capabilitiesAny: [
      "registerDomainResourceDraft",
      "approvePlatformPublication",
      "approveDomainPublication",
      "submitDomainResourcePublication",
      "discoverSharedResources",
      "requestSharedResourceAccess",
      "decideDomainResourceAccess",
    ],
    routesAll: [
      "POST /api/governance/resources",
      "POST /api/governance/publications",
      "POST /api/governance/publication-decisions",
      "GET /api/governance/shared-resources",
      "POST /api/governance/access-requests",
      "POST /api/governance/access-decisions",
      "POST /api/governance/access-revocations",
    ],
  },
  {
    id: "sessions",
    label: "Sessions",
    view: "hostedsessions",
    section: "EXPERIENCE",
    capabilitiesAny: ["viewOwnSessions"],
    routesAll: ["GET /api/experience/sessions"],
  },
  {
    id: "accessrequests",
    label: "Access Requests",
    view: "hostedaccessrequests",
    section: "EXPERIENCE",
    capabilitiesAny: ["requestAgentAccess"],
    routesAll: [
      "GET /api/experience/access-requests",
      "POST /api/experience/access-requests",
    ],
  },
]);

const ACTIONS = Object.freeze({
  createDomain: {
    capabilitiesAny: ["createPlatformDomain"],
    routesAll: ["POST /api/domain-create"],
  },
  createProject: {
    capabilitiesAny: [
      "createDomainProject",
      "usePlatformBuilderWorkspace",
    ],
    routesAll: ["POST /api/projects"],
  },
  updateModelPolicy: {
    capabilitiesAny: ["manageModelAccessPolicy"],
    routesAll: ["POST /api/ai-gateway/model-policies"],
  },
  requestModelAccess: {
    capabilitiesAny: ["requestModelAccess"],
    routesAll: ["POST /api/ai-gateway/model-access-requests"],
  },
  decideModelAccess: {
    capabilitiesAny: ["decideDomainResourceAccess"],
    routesAll: ["POST /api/ai-gateway/model-access-decisions"],
  },
  createAgent: {
    capabilitiesAny: ["createAgent"],
    routesAll: ["POST /api/agents"],
  },
  configureAgent: {
    capabilitiesAny: ["configureAgent"],
    routesAll: ["PUT /api/agents/{id}"],
  },
  testAgent: {
    capabilitiesAny: ["testAgent"],
    routesAll: ["POST /api/agents/{id}/test"],
  },
  deploySandbox: {
    capabilitiesAny: ["deployAgentToSandbox"],
    routesAll: ["POST /api/deployments/sandbox"],
  },
  submitProductionDeployment: {
    capabilitiesAny: ["submitAgentProductionDeployment"],
    routesAll: ["POST /api/deployments/production"],
  },
  publishAgent: {
    capabilitiesAny: ["submitDomainResourcePublication"],
    routesAll: ["POST /api/governance/agent-publications"],
  },
  decideProductionDeployment: {
    capabilitiesAny: [
      "approvePlatformDeployment",
      "approveDomainDeployment",
    ],
    routesAll: ["POST /api/deployment-decisions"],
  },
  registerResourceDraft: {
    capabilitiesAny: ["registerDomainResourceDraft"],
    routesAll: ["POST /api/governance/resources"],
  },
  submitResourcePublication: {
    capabilitiesAny: ["submitDomainResourcePublication"],
    routesAll: ["POST /api/governance/publications"],
  },
  decideResourcePublication: {
    capabilitiesAny: [
      "approvePlatformPublication",
      "approveDomainPublication",
    ],
    routesAll: ["POST /api/governance/publication-decisions"],
  },
  discoverSharedResources: {
    capabilitiesAny: ["discoverSharedResources"],
    routesAll: ["GET /api/governance/shared-resources"],
  },
  requestSharedResourceAccess: {
    capabilitiesAny: ["requestSharedResourceAccess"],
    routesAll: ["POST /api/governance/access-requests"],
  },
  decideSharedResourceAccess: {
    capabilitiesAny: ["decideDomainResourceAccess"],
    routesAll: ["POST /api/governance/access-decisions"],
  },
  revokeSharedResourceAccess: {
    capabilitiesAny: ["decideDomainResourceAccess"],
    routesAll: ["POST /api/governance/access-revocations"],
  },
  grantAgentEntitlement: {
    capabilitiesAny: [
      "managePlatformPolicy",
      "manageDomainEntitlements",
    ],
    routesAll: ["POST /api/governance/agent-entitlements"],
  },
  revokeAgentEntitlement: {
    capabilitiesAny: [
      "managePlatformPolicy",
      "manageDomainEntitlements",
    ],
    routesAll: [
      "POST /api/governance/agent-entitlement-revocations",
    ],
  },
  grantDomainMembership: {
    capabilitiesAny: [
      "managePlatformPolicy",
      "manageDomainMembers",
    ],
    routesAll: ["POST /api/access/domain-memberships"],
  },
  revokeDomainMembership: {
    capabilitiesAny: [
      "managePlatformPolicy",
      "manageDomainMembers",
    ],
    routesAll: [
      "POST /api/access/domain-membership-revocations",
    ],
  },
  grantProjectMembership: {
    capabilitiesAny: [
      "managePlatformPolicy",
      "manageDomainMembers",
    ],
    routesAll: ["POST /api/access/project-memberships"],
  },
  revokeProjectMembership: {
    capabilitiesAny: [
      "managePlatformPolicy",
      "manageDomainMembers",
    ],
    routesAll: [
      "POST /api/access/project-membership-revocations",
    ],
  },
  invokeEntitledAgent: {
    capabilitiesAny: ["invokeEntitledAgent"],
    routesAll: ["POST /api/experience/invocations"],
  },
  submitAgentFeedback: {
    capabilitiesAny: ["submitAgentFeedback"],
    routesAll: ["POST /api/experience/feedback"],
  },
  reportAgentIssue: {
    capabilitiesAny: ["submitAgentFeedback"],
    routesAll: ["POST /api/experience/issues"],
  },
  requestAgentAccess: {
    capabilitiesAny: ["requestAgentAccess"],
    routesAll: ["POST /api/experience/access-requests"],
  },
  createIncident: {
    capabilitiesAny: [
      "managePlatformIncidents",
      "manageDomainIncidents",
    ],
    routesAll: ["POST /api/incidents"],
  },
  actOnIncident: {
    capabilitiesAny: [
      "managePlatformIncidents",
      "manageDomainIncidents",
    ],
    routesAll: ["POST /api/incidents/{id}/actions"],
  },
  requestBreakGlass: {
    capabilitiesAny: ["requestBreakGlassAccess"],
    routesAll: ["POST /api/break-glass/requests"],
  },
  decideBreakGlass: {
    capabilitiesAny: ["approveBreakGlassAccess"],
    routesAll: ["POST /api/break-glass/decisions"],
  },
  activateBreakGlass: {
    capabilitiesAny: ["activateBreakGlassAccess"],
    routesAll: ["POST /api/break-glass/activations"],
  },
  revokeBreakGlass: {
    capabilitiesAny: ["revokeBreakGlassAccess"],
    routesAll: ["POST /api/break-glass/revocations"],
  },
});

const APPROVAL_ACTIONS = Object.freeze({
  PRODUCTION_DEPLOYMENT: Object.freeze({
    action: "decideProductionDeployment",
    platformCapability: "approvePlatformDeployment",
    domainCapability: "approveDomainDeployment",
  }),
  RESOURCE_PUBLICATION: Object.freeze({
    action: "decideResourcePublication",
    platformCapability: "approvePlatformPublication",
    domainCapability: "approveDomainPublication",
  }),
  RESOURCE_ACCESS: Object.freeze({
    action: "decideSharedResourceAccess",
    domainCapability: "decideDomainResourceAccess",
  }),
});

function valueSet(values) {
  return new Set(
    Array.isArray(values)
      ? values.filter((value) => typeof value === "string" && value)
      : [],
  );
}

export function hostedResourceKey(resource) {
  if (
    !resource
    || typeof resource !== "object"
    || typeof resource.domainId !== "string"
    || !resource.domainId
    || typeof resource.projectId !== "string"
    || !resource.projectId
    || typeof resource.id !== "string"
    || !resource.id
  ) {
    return null;
  }
  return `${resource.domainId}/${resource.projectId}/${resource.id}`;
}

export function hostedBuildRegistryEntriesForDomain(entries, domainId) {
  if (!Array.isArray(entries) || typeof domainId !== "string" || !domainId) {
    return [];
  }
  return entries.filter((entry) =>
    entry?.domain === "shared" || entry?.domain === domainId);
}

export function normalizeHostedBuildSelections(
  resources,
  form = {},
  selected = {},
) {
  const available = new Map();
  for (const resource of Array.isArray(resources) ? resources : []) {
    if (
      typeof resource?.field !== "string"
      || !resource.field
      || typeof resource?.id !== "string"
      || !resource.id
    ) {
      continue;
    }
    const ids = available.get(resource.field) || [];
    if (!ids.includes(resource.id)) ids.push(resource.id);
    available.set(resource.field, ids);
  }

  const filterIds = (field) => {
    const requested = Object.hasOwn(form, field)
      ? form[field]
      : selected?.[field];
    const allowed = new Set(available.get(field) || []);
    return [...new Set(
      (Array.isArray(requested) ? requested : [])
        .filter((id) => typeof id === "string" && allowed.has(id)),
    )];
  };

  const blueprintIds = available.get("blueprintIds") || [];
  const requestedBlueprint = Object.hasOwn(form, "blueprintId")
    ? form.blueprintId
    : selected?.blueprintIds?.[0];
  const blueprintId = blueprintIds.includes(requestedBlueprint)
    ? requestedBlueprint
    : blueprintIds[0] || "";

  return {
    toolIds: filterIds("toolIds"),
    skillIds: filterIds("skillIds"),
    mcpServerIds: filterIds("mcpServerIds"),
    blueprintId,
    blueprintIds: blueprintId ? [blueprintId] : [],
  };
}

export function hostedBuildPublicationCanSubmit(agentStatus, registryStatus) {
  const publishableAgentStatuses = new Set([
    "TESTED",
    "SANDBOX_DEPLOYED",
    "PRODUCTION_PENDING",
    "PRODUCTION_APPROVED",
    "PRODUCTION_DEPLOYED",
    "REJECTED",
  ]);
  return publishableAgentStatuses.has(agentStatus)
    && ["NOT_SUBMITTED", "DRAFT"].includes(
      registryStatus || "NOT_SUBMITTED",
    );
}

function requirementMet(definition, capabilities, routes) {
  const requiredCapabilities = definition.capabilitiesAny || [];
  const requiredRoutes = definition.routesAll || [];
  return requiredCapabilities.some((capability) =>
    capabilities.has(capability))
    && requiredRoutes.every((route) => routes.has(route));
}

export function enabledHostedSurfaces(
  capabilities,
  { deployedRoutes = HOSTED_DEPLOYED_ROUTES } = {},
) {
  const capabilitySet = valueSet(capabilities);
  const routeSet = valueSet(deployedRoutes);
  return SURFACES
    .filter((surface) =>
      requirementMet(surface, capabilitySet, routeSet))
    .map((surface) => ({ ...surface }));
}

export function hostedActionEnabled(
  action,
  capabilities,
  { deployedRoutes = HOSTED_DEPLOYED_ROUTES } = {},
) {
  const definition = ACTIONS[action];
  if (!definition) return false;
  return requirementMet(
    definition,
    valueSet(capabilities),
    valueSet(deployedRoutes),
  );
}

export function hostedApprovalActionEnabled(
  kind,
  capabilities,
  {
    recordDomainId,
    activeDomainId = null,
    deployedRoutes = HOSTED_DEPLOYED_ROUTES,
  } = {},
) {
  const definition = APPROVAL_ACTIONS[kind];
  if (
    !definition
    || typeof recordDomainId !== "string"
    || !recordDomainId
    || !hostedActionEnabled(definition.action, capabilities, {
      deployedRoutes,
    })
  ) {
    return false;
  }

  const capabilitySet = valueSet(capabilities);
  // The virtual "shared" domain (org catalog) is platform-curated work, same
  // as "platform" — the governance service accepts these decisions only from
  // platform admins (adminPlatformOnly), so the console must offer the
  // controls to the same audience.
  if (recordDomainId === "platform" || recordDomainId === "shared") {
    return !!definition.platformCapability
      && capabilitySet.has(definition.platformCapability);
  }

  const hasPlatformApprovalAuthority = [
    "approvePlatformDeployment",
    "approvePlatformPublication",
  ].some((capability) => capabilitySet.has(capability));
  return !hasPlatformApprovalAuthority
    && typeof activeDomainId === "string"
    && activeDomainId === recordDomainId
    && capabilitySet.has(definition.domainCapability);
}

export function hostedHomeView(
  capabilities,
  options,
) {
  const surfaces = enabledHostedSurfaces(capabilities, options);
  for (const preferred of [
    "hosteddashboard",
    "hostedprojects",
    "hostedoverview",
    "approvedagents",
  ]) {
    if (surfaces.some(({ view }) => view === preferred)) return preferred;
  }
  return surfaces[0]?.view || null;
}
