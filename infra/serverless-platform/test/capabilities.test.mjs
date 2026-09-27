import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL(
  "../lambda/authz/capabilities.mjs",
  import.meta.url,
);

const LEGACY_CAPABILITIES = {
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

const BUILDER_JOURNEY = [
  "viewDomainInventory",
  "viewAssignedProjects",
  "createAgent",
  "configureAgent",
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
  "viewOwnedCost",
];

async function loadCapabilities() {
  try {
    return await import(moduleUrl);
  } catch (error) {
    assert.fail(
      `expected canonical hosted capability module: ${error?.message || error}`,
    );
  }
}

test("canonical hosted bundles preserve every legacy capability", async () => {
  const { ROLE_CAPABILITY_BUNDLES } = await loadCapabilities();
  const intentionallyReplacedAdminCapabilities = new Set([
    "approveAgentDeploy",
  ]);

  for (const [role, legacyCapabilities] of Object.entries(
    LEGACY_CAPABILITIES,
  )) {
    for (const capability of legacyCapabilities) {
      if (
        role === "admin"
        && intentionallyReplacedAdminCapabilities.has(capability)
      ) {
        continue;
      }
      assert.ok(
        ROLE_CAPABILITY_BUNDLES[role].includes(capability),
        `${role} must preserve ${capability}`,
      );
    }
  }
});

test("Platform Admin receives platform control and platform-domain builder capabilities", async () => {
  const { ROLE_CAPABILITY_BUNDLES } = await loadCapabilities();

  for (const capability of [
    "viewPlatformInventory",
    "managePlatformPolicy",
    "manageGateway",
    "approveRegistryVersion",
    "viewPlatformOperations",
    "viewPlatformAudit",
    "requestBreakGlassAccess",
    "activateBreakGlassAccess",
    "revokeBreakGlassAccess",
    "approveRestrictedPolicyException",
    "approvePlatformDeployment",
    "approvePlatformPublication",
    "initiateDomainResourcePublication",
    "usePlatformBuilderWorkspace",
    ...BUILDER_JOURNEY,
  ]) {
    assert.ok(
      ROLE_CAPABILITY_BUNDLES.admin.includes(capability),
      `admin must receive ${capability}`,
    );
  }
  for (const routineDomainApproval of [
    "approveAgentDeploy",
    "approveDomainPublication",
    "approveDomainDeployment",
  ]) {
    assert.equal(
      ROLE_CAPABILITY_BUNDLES.admin.includes(routineDomainApproval),
      false,
      `admin must not receive routine domain approval ${routineDomainApproval}`,
    );
  }
});

test("Domain Lead receives complete builder and domain governance capabilities", async () => {
  const { ROLE_CAPABILITY_BUNDLES } = await loadCapabilities();

  for (const capability of [
    ...BUILDER_JOURNEY,
    "manageDomainMembers",
    "manageDomainPolicy",
    "manageDomainQuota",
    "manageDomainEntitlements",
    "approveDomainDeployment",
    "approveDomainPublication",
    "decideDomainResourceAccess",
    "manageDomainIncidents",
    "viewDomainAudit",
  ]) {
    assert.ok(
      ROLE_CAPABILITY_BUNDLES.lead.includes(capability),
      `lead must receive ${capability}`,
    );
  }
});

test("Domain Builder receives the approved build and submission journey only", async () => {
  const { ROLE_CAPABILITY_BUNDLES } = await loadCapabilities();

  assert.ok(
    !ROLE_CAPABILITY_BUNDLES.builder.includes("createDomainProject"),
    "builder creates agents in assigned projects, not projects",
  );
  for (const capability of BUILDER_JOURNEY) {
    assert.ok(
      ROLE_CAPABILITY_BUNDLES.builder.includes(capability),
      `builder must receive ${capability}`,
    );
  }
  for (const forbidden of [
    "approveDomainDeployment",
    "approveDomainPublication",
    "decideDomainResourceAccess",
    "manageDomainMembers",
    "managePlatformPolicy",
    "manageGateway",
  ]) {
    assert.equal(
      ROLE_CAPABILITY_BUNDLES.builder.includes(forbidden),
      false,
      `builder must not receive ${forbidden}`,
    );
  }
});

test("End User receives only the approved consumption journey", async () => {
  const { ROLE_CAPABILITY_BUNDLES } = await loadCapabilities();

  assert.deepEqual(
    ROLE_CAPABILITY_BUNDLES.user,
    [
      "discoverEntitledAgents",
      "invokeEntitledAgent",
      "viewOwnSessions",
      "submitAgentFeedback",
      "requestAgentAccess",
    ],
  );
});

test("canonical hosted capability exports are immutable", async () => {
  const {
    CAPABILITIES,
    RESERVED_ACCESS_GROUP_NAMES,
    RESERVED_DOMAIN_GROUP_NAMES,
    RESERVED_DOMAIN_IDS,
    ROLE_CAPABILITY_BUNDLES,
  } = await loadCapabilities();

  assert.equal(Object.isFrozen(CAPABILITIES), true);
  assert.deepEqual(
    RESERVED_ACCESS_GROUP_NAMES,
    [
      "platform-admin",
      "domain-builder",
      "domain-lead",
      "end-user",
      "demo-operator",
    ],
  );
  assert.deepEqual(
    RESERVED_DOMAIN_IDS,
    [
      "builder",
      "lead",
      "platform_admin",
      "domain_builder",
      "end_user",
      "demo_operator",
    ],
  );
  assert.deepEqual(
    RESERVED_DOMAIN_GROUP_NAMES,
    [
      "domain-builder",
      "domain-lead",
      "domain-platform-admin",
      "domain-domain-builder",
      "domain-end-user",
      "domain-demo-operator",
    ],
  );
  assert.equal(Object.isFrozen(RESERVED_ACCESS_GROUP_NAMES), true);
  assert.equal(Object.isFrozen(RESERVED_DOMAIN_IDS), true);
  assert.equal(Object.isFrozen(RESERVED_DOMAIN_GROUP_NAMES), true);
  assert.equal(Object.isFrozen(ROLE_CAPABILITY_BUNDLES), true);
  for (const capabilities of Object.values(ROLE_CAPABILITY_BUNDLES)) {
    assert.equal(Object.isFrozen(capabilities), true);
  }
  assert.throws(
    () => ROLE_CAPABILITY_BUNDLES.builder.push("managePlatformPolicy"),
    TypeError,
  );
});

test("unknown roles fail closed without inheriting End User capabilities", async () => {
  const { capabilitiesForRole } = await loadCapabilities();

  const capabilities = capabilitiesForRole("unknown-role");
  assert.deepEqual(capabilities, []);
  assert.equal(Object.isFrozen(capabilities), true);
});

test("prototype property names fail closed as unknown roles", async () => {
  const { capabilitiesForRole } = await loadCapabilities();

  for (const role of ["__proto__", "constructor", "toString"]) {
    const capabilities = capabilitiesForRole(role);
    assert.deepEqual(capabilities, [], role);
    assert.equal(Object.isFrozen(capabilities), true, role);
  }
});
