import { frontendSource } from "./test-support/frontend-source.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_DEPLOYED_ROUTES,
  enabledHostedSurfaces,
  hostedActionEnabled,
  hostedApprovalActionEnabled,
  hostedHomeView,
  hostedResourceKey,
} from "./public/hosted-persona.mjs";
import * as hostedPersonaModule from "./public/hosted-persona.mjs";

const hostedHtml = frontendSource;

function sourceBetween(start, end) {
  const startIndex = hostedHtml.indexOf(start);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  const endIndex = hostedHtml.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return hostedHtml.slice(startIndex, endIndex);
}

const adminCapabilities = [
  "viewPlatformInventory",
  "createPlatformDomain",
  "manageGateway",
  "managePlatformPolicy",
  "manageModelAccessPolicy",
  "selectApprovedModel",
  "viewPlatformOperations",
  "viewPlatformCost",
  "viewPlatformAudit",
  "managePlatformIncidents",
  "requestBreakGlassAccess",
  "approveBreakGlassAccess",
  "activateBreakGlassAccess",
  "revokeBreakGlassAccess",
  "viewBreakGlassAudit",
  "usePlatformBuilderWorkspace",
  "createAgent",
  "configureAgent",
  "testAgent",
  "deployAgentToSandbox",
  "submitAgentProductionDeployment",
  "registerDomainResourceDraft",
  "submitDomainResourcePublication",
  "discoverSharedResources",
  "requestSharedResourceAccess",
  "approvePlatformDeployment",
  "approvePlatformPublication",
];

const leadCapabilities = [
  "viewDomainInventory",
  "viewDomainRegistry",
  "useDomainBuilderWorkspace",
  "createDomainProject",
  "approveDomainDeployment",
  "approveDomainPublication",
  "manageDomainQuota",
  "manageDomainMembers",
  "manageDomainEntitlements",
  "viewDomainCost",
  "viewDomainAudit",
  "manageDomainIncidents",
  "createAgent",
  "configureAgent",
  "testAgent",
  "deployAgentToSandbox",
  "submitAgentProductionDeployment",
  "registerDomainResourceDraft",
  "submitDomainResourcePublication",
  "discoverSharedResources",
  "requestSharedResourceAccess",
  "decideDomainResourceAccess",
  "selectApprovedModel",
  "requestModelAccess",
  "viewDomainOperations",
];

const builderCapabilities = [
  "viewDomainInventory",
  "viewAssignedProjects",
  "viewDomainRegistry",
  "createAgent",
  "configureAgent",
  "testAgent",
  "deployAgentToSandbox",
  "submitAgentProductionDeployment",
  "viewOwnedOperations",
  "viewOwnedIncidents",
  "viewOwnedCost",
  "registerDomainResourceDraft",
  "submitDomainResourcePublication",
  "discoverSharedResources",
  "requestSharedResourceAccess",
  "selectApprovedModel",
  "requestModelAccess",
];

const endUserCapabilities = [
  "discoverEntitledAgents",
  "invokeEntitledAgent",
  "viewOwnSessions",
  "submitAgentFeedback",
  "requestAgentAccess",
];

test("hosted build registry entries follow the selected project domain", () => {
  assert.equal(
    typeof hostedPersonaModule.hostedBuildRegistryEntriesForDomain,
    "function",
  );
  const entries = [
    { id: "chat-assistant", domain: "shared" },
    { id: "platform-tool", domain: "platform" },
    { id: "order_lookup", domain: "customer_support" },
    { id: "operations-tool", domain: "operations" },
  ];

  assert.deepEqual(
    hostedPersonaModule.hostedBuildRegistryEntriesForDomain(
      entries,
      "platform",
    ).map(({ id }) => id),
    ["chat-assistant", "platform-tool"],
  );
  assert.deepEqual(
    hostedPersonaModule.hostedBuildRegistryEntriesForDomain(
      entries,
      "customer_support",
    ).map(({ id }) => id),
    ["chat-assistant", "order_lookup"],
  );
  assert.deepEqual(
    hostedPersonaModule.hostedBuildRegistryEntriesForDomain(entries, ""),
    [],
  );
});

test("hosted build can submit new and existing Registry drafts for approval", () => {
  const canSubmit = hostedPersonaModule.hostedBuildPublicationCanSubmit;
  assert.equal(typeof canSubmit, "function");

  assert.equal(canSubmit("TESTED", null), true);
  assert.equal(canSubmit("TESTED", "NOT_SUBMITTED"), true);
  assert.equal(canSubmit("TESTED", "DRAFT"), true);
  assert.equal(canSubmit("SANDBOX_DEPLOYED", "DRAFT"), true);

  assert.equal(canSubmit("READY_FOR_TEST", "DRAFT"), false);
  assert.equal(canSubmit("TESTED", "PENDING_APPROVAL"), false);
  assert.equal(canSubmit("TESTED", "APPROVED"), false);
  assert.equal(canSubmit("TESTED", "REJECTED"), false);
});

test("deployed route catalog matches the real hosted APIs exactly", () => {
  assert.deepEqual(HOSTED_DEPLOYED_ROUTES, [
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
  assert.equal(
    HOSTED_DEPLOYED_ROUTES.includes("GET /api/governance/publications"),
    false,
  );
  assert.equal(
    HOSTED_DEPLOYED_ROUTES.includes("POST /api/delivery/repositories"),
    false,
  );
});

test("Platform Admin receives every currently deployed platform and builder surface", () => {
  const ids = enabledHostedSurfaces(adminCapabilities)
    .map(({ id }) => id);

  assert.deepEqual(ids, [
    "dashboard",
    "domains",
    "registry",
    "gateway",
    "projects",
    "agents",
    "deployments",
    "approvals",
    "domainaccess",
    "build",
    "operations",
    "cost",
    "audit",
    "incidents",
    "breakglass",
    "publications",
  ]);
  assert.equal(hostedHomeView(adminCapabilities), "hosteddashboard");
});

test("Domain Lead receives the complete deployed Builder journey plus approvals", () => {
  const ids = enabledHostedSurfaces(leadCapabilities)
    .map(({ id }) => id);

  assert.deepEqual(ids, [
    "registry",
    "gateway",
    "projects",
    "agents",
    "deployments",
    "approvals",
    "domainaccess",
    "build",
    "operations",
    "cost",
    "audit",
    "incidents",
    "publications",
  ]);
  assert.equal(hostedHomeView(leadCapabilities), "hostedprojects");
  assert.equal(
    hostedActionEnabled("decideProductionDeployment", leadCapabilities),
    true,
  );
  assert.equal(
    hostedActionEnabled("createProject", leadCapabilities),
    true,
  );
  for (const action of [
    "decideResourcePublication",
    "decideSharedResourceAccess",
    "revokeSharedResourceAccess",
  ]) {
    assert.equal(hostedActionEnabled(action, leadCapabilities), true, action);
  }
});

test("approval controls enforce platform and selected-domain ownership", () => {
  for (const kind of [
    "PRODUCTION_DEPLOYMENT",
    "RESOURCE_PUBLICATION",
  ]) {
    assert.equal(
      hostedApprovalActionEnabled(kind, adminCapabilities, {
        recordDomainId: "platform",
        activeDomainId: null,
      }),
      true,
      `Platform Admin can decide ${kind} owned by platform`,
    );
    assert.equal(
      hostedApprovalActionEnabled(kind, adminCapabilities, {
        recordDomainId: "shared",
        activeDomainId: null,
      }),
      true,
      `Platform Admin can decide ${kind} in the shared org catalog`,
    );
    assert.equal(
      hostedApprovalActionEnabled(kind, leadCapabilities, {
        recordDomainId: "shared",
        activeDomainId: "shared",
      }),
      false,
      `Domain Lead cannot decide shared-catalog ${kind}`,
    );
    assert.equal(
      hostedApprovalActionEnabled(kind, adminCapabilities, {
        recordDomainId: "operations",
        activeDomainId: "operations",
      }),
      false,
      `Platform Admin cannot use platform approval capability for ${kind} owned by a domain`,
    );
    assert.equal(
      hostedApprovalActionEnabled(kind, leadCapabilities, {
        recordDomainId: "operations",
        activeDomainId: "operations",
      }),
      true,
      `Domain Lead can decide ${kind} in the selected domain`,
    );
    assert.equal(
      hostedApprovalActionEnabled(kind, leadCapabilities, {
        recordDomainId: "customer-support",
        activeDomainId: "operations",
      }),
      false,
      `Domain Lead cannot decide ${kind} in another domain`,
    );
    assert.equal(
      hostedApprovalActionEnabled(kind, leadCapabilities, {
        recordDomainId: "platform",
        activeDomainId: "platform",
      }),
      false,
      `Domain Lead cannot decide platform-owned ${kind}`,
    );
    for (const capabilities of [
      builderCapabilities,
      endUserCapabilities,
    ]) {
      assert.equal(
        hostedApprovalActionEnabled(kind, capabilities, {
          recordDomainId: "operations",
          activeDomainId: "operations",
        }),
        false,
        `${kind} is unavailable without an approval capability`,
      );
    }
  }
});

test("approval controls remain disabled when their decision route is unavailable", () => {
  const withoutDeploymentDecision = HOSTED_DEPLOYED_ROUTES.filter(
    (route) => route !== "POST /api/deployment-decisions",
  );
  assert.equal(
    hostedApprovalActionEnabled(
      "PRODUCTION_DEPLOYMENT",
      adminCapabilities,
      {
        recordDomainId: "platform",
        deployedRoutes: withoutDeploymentDecision,
      },
    ),
    false,
  );

  const withoutPublicationDecision = HOSTED_DEPLOYED_ROUTES.filter(
    (route) =>
      route !== "POST /api/governance/publication-decisions",
  );
  assert.equal(
    hostedApprovalActionEnabled(
      "RESOURCE_PUBLICATION",
      leadCapabilities,
      {
        recordDomainId: "operations",
        activeDomainId: "operations",
        deployedRoutes: withoutPublicationDecision,
      },
    ),
    false,
  );
});

test("Domain Builder receives deployed create, test, sandbox, and production submission actions", () => {
  const ids = enabledHostedSurfaces(builderCapabilities)
    .map(({ id }) => id);

  assert.deepEqual(ids, [
    "registry",
    "gateway",
    "projects",
    "agents",
    "deployments",
    "approvals",
    "build",
    "operations",
    "cost",
    "incidents",
    "publications",
  ]);
  for (const action of [
    "createAgent",
    "configureAgent",
    "testAgent",
    "deploySandbox",
    "submitProductionDeployment",
    "publishAgent",
    "registerResourceDraft",
    "submitResourcePublication",
    "discoverSharedResources",
    "requestSharedResourceAccess",
  ]) {
    assert.equal(
      hostedActionEnabled(action, builderCapabilities),
      true,
      action,
    );
  }
  assert.equal(
    hostedActionEnabled(
      "decideProductionDeployment",
      builderCapabilities,
    ),
    false,
  );
  assert.equal(hostedActionEnabled("createIncident", builderCapabilities), false);
  assert.equal(hostedActionEnabled("actOnIncident", builderCapabilities), false);
  assert.equal(hostedActionEnabled("createProject", builderCapabilities), false);
});

test("Domain Users & Access is available only to Platform Admin and Domain Lead", () => {
  for (const capabilities of [adminCapabilities, leadCapabilities]) {
    const surface = enabledHostedSurfaces(capabilities)
      .find(({ id }) => id === "domainaccess");
    assert.deepEqual(surface, {
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
    });
    assert.equal(
      hostedActionEnabled("grantAgentEntitlement", capabilities),
      true,
    );
    assert.equal(
      hostedActionEnabled("revokeAgentEntitlement", capabilities),
      true,
    );
    for (const action of [
      "grantDomainMembership",
      "revokeDomainMembership",
      "grantProjectMembership",
      "revokeProjectMembership",
    ]) {
      assert.equal(
        hostedActionEnabled(action, capabilities),
        true,
        action,
      );
    }
  }

  for (const capabilities of [builderCapabilities, endUserCapabilities]) {
    assert.equal(
      enabledHostedSurfaces(capabilities)
        .some(({ id }) => id === "domainaccess"),
      false,
    );
    assert.equal(
      hostedActionEnabled("grantAgentEntitlement", capabilities),
      false,
    );
    assert.equal(
      hostedActionEnabled("revokeAgentEntitlement", capabilities),
      false,
    );
    for (const action of [
      "grantDomainMembership",
      "revokeDomainMembership",
      "grantProjectMembership",
      "revokeProjectMembership",
    ]) {
      assert.equal(
        hostedActionEnabled(action, capabilities),
        false,
        action,
      );
    }
  }

  const withoutRevocation = HOSTED_DEPLOYED_ROUTES.filter(
    (route) =>
      route !== "POST /api/governance/agent-entitlement-revocations",
  );
  assert.equal(
    enabledHostedSurfaces(leadCapabilities, {
      deployedRoutes: withoutRevocation,
    }).some(({ id }) => id === "domainaccess"),
    false,
  );
  assert.equal(
    hostedActionEnabled("revokeAgentEntitlement", leadCapabilities, {
      deployedRoutes: withoutRevocation,
    }),
    false,
  );

  const withoutListing = HOSTED_DEPLOYED_ROUTES.filter(
    (route) => route !== "GET /api/governance/agent-entitlements",
  );
  assert.equal(
    enabledHostedSurfaces(leadCapabilities, {
      deployedRoutes: withoutListing,
    }).some(({ id }) => id === "domainaccess"),
    false,
  );

  const withoutMembershipListing = HOSTED_DEPLOYED_ROUTES.filter(
    (route) => route !== "GET /api/access/domain-members",
  );
  assert.equal(
    enabledHostedSurfaces(leadCapabilities, {
      deployedRoutes: withoutMembershipListing,
    }).some(({ id }) => id === "domainaccess"),
    false,
  );
});

test("project creation is enabled for Platform Admin, Domain Lead, and Domain Builder", () => {
  assert.equal(hostedActionEnabled("createProject", adminCapabilities), true);
  assert.equal(hostedActionEnabled("createProject", leadCapabilities), true);
  assert.equal(hostedActionEnabled("createProject", builderCapabilities), false);

  const withoutProjectCreate = HOSTED_DEPLOYED_ROUTES.filter(
    (route) => route !== "POST /api/projects",
  );
  assert.equal(
    hostedActionEnabled("createProject", leadCapabilities, {
      deployedRoutes: withoutProjectCreate,
    }),
    false,
  );
});



test("AI Gateway model actions are capability and deployed-route gated", () => {
  assert.equal(
    hostedActionEnabled("updateModelPolicy", adminCapabilities),
    true,
  );
  assert.equal(
    hostedActionEnabled("requestModelAccess", adminCapabilities),
    false,
  );
  assert.equal(
    hostedActionEnabled("requestModelAccess", leadCapabilities),
    true,
  );
  assert.equal(
    hostedActionEnabled("requestModelAccess", builderCapabilities),
    true,
  );
  assert.equal(
    hostedActionEnabled("decideModelAccess", leadCapabilities),
    true,
  );
  assert.equal(
    hostedActionEnabled("decideModelAccess", builderCapabilities),
    false,
  );
  assert.equal(
    enabledHostedSurfaces(["selectApprovedModel"]).some(
      ({ id }) => id === "gateway",
    ),
    true,
  );
  assert.equal(
    enabledHostedSurfaces(["discoverEntitledAgents"]).some(
      ({ id }) => id === "gateway",
    ),
    false,
  );

  const withoutRequestRoute = HOSTED_DEPLOYED_ROUTES.filter(
    (route) => route !== "POST /api/ai-gateway/model-access-requests",
  );
  assert.equal(
    hostedActionEnabled("requestModelAccess", builderCapabilities, {
      deployedRoutes: withoutRequestRoute,
    }),
    false,
  );
});

test("Operations lifecycle actions are capability and route gated", () => {
  for (const action of ["createIncident", "actOnIncident"]) {
    assert.equal(hostedActionEnabled(action, adminCapabilities), true, action);
    assert.equal(hostedActionEnabled(action, leadCapabilities), true, action);
    assert.equal(hostedActionEnabled(action, builderCapabilities), false, action);
  }
  for (const action of [
    "requestBreakGlass",
    "decideBreakGlass",
    "activateBreakGlass",
    "revokeBreakGlass",
  ]) {
    assert.equal(hostedActionEnabled(action, adminCapabilities), true, action);
    assert.equal(hostedActionEnabled(action, leadCapabilities), false, action);
  }
});

test("End User receives the complete deployed experience journey", () => {
  assert.deepEqual(
    enabledHostedSurfaces(endUserCapabilities).map(({ id }) => id),
    ["overview", "approvedagents", "sessions", "accessrequests"],
  );
  assert.equal(hostedHomeView(endUserCapabilities), "hostedoverview");
  for (const action of [
    "invokeEntitledAgent",
    "submitAgentFeedback",
    "reportAgentIssue",
    "requestAgentAccess",
  ]) {
    assert.equal(
      hostedActionEnabled(action, endUserCapabilities),
      true,
      action,
    );
  }
});

test("surface selection depends on capabilities and route support, never a role name", () => {
  const withSameCapabilities = enabledHostedSurfaces(builderCapabilities);
  const independentlyConstructed = enabledHostedSurfaces(
    [...builderCapabilities].reverse(),
  );
  assert.deepEqual(independentlyConstructed, withSameCapabilities);

  const withoutAgentWriteRoute = HOSTED_DEPLOYED_ROUTES.filter(
    (route) => route !== "POST /api/agents",
  );
  assert.equal(
    enabledHostedSurfaces(builderCapabilities, {
      deployedRoutes: withoutAgentWriteRoute,
    }).some(({ id }) => id === "build"),
    false,
  );
});

test("every real operations, governance, and experience surface is enabled by capability", () => {
  const everyCapability = [
    ...adminCapabilities,
    ...leadCapabilities,
    ...builderCapabilities,
    "approveDomainPublication",
    "submitDomainResourcePublication",
    "decideDomainResourceAccess",
    "discoverSharedResources",
    "requestSharedResourceAccess",
    "discoverEntitledAgents",
    "invokeEntitledAgent",
    "viewOwnSessions",
    "submitAgentFeedback",
    "requestAgentAccess",
  ];
  const ids = enabledHostedSurfaces(everyCapability)
    .map(({ id }) => id);

  for (const deployed of [
    "operations",
    "cost",
    "audit",
    "incidents",
    "breakglass",
    "publications",
    "sessions",
  ]) {
    assert.equal(ids.includes(deployed), true, deployed);
  }
});

test("hosted resource keys keep same-named agents in different projects distinct", () => {
  assert.equal(
    hostedResourceKey({
      domainId: "operations",
      projectId: "case_management",
      id: "triage_agent",
    }),
    "operations/case_management/triage_agent",
  );
  assert.notEqual(
    hostedResourceKey({
      domainId: "operations",
      projectId: "case_management",
      id: "triage_agent",
    }),
    hostedResourceKey({
      domainId: "operations",
      projectId: "incident_management",
      id: "triage_agent",
    }),
  );
  assert.equal(hostedResourceKey(null), null);
});
