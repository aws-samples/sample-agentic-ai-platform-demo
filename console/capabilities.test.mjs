// Unit tests for the G1 capability resolver: bundle resolution, domain
// overrides, config validation, and the zero-behavior-change contract of the
// committed default bundles (admin/lead/builder/user reproduce the
// pre-refactor role checks).
// Run: node --test console/capabilities.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { can, resolveCapabilities, loadBundles, validateBundlesConfig, CAPABILITIES, BUNDLES_PATH } from "./capabilities.mjs"

const CONFIG = {
  bundles: {
    admin: { capabilities: ["createDomain", "manageCapabilityBundles"] },
    lead: { capabilities: ["decideAccessRequests", "domainContentPlane"] },
    builder: { capabilities: ["domainContentPlane"] },
  },
  domainOverrides: {
    finance: {
      builder: { add: ["decideAccessRequests"], remove: ["domainContentPlane"] },
    },
  },
}

test("resolves the session's role to its bundle", () => {
  assert.equal(can({ role: "admin" }, "createDomain", CONFIG), true)
  assert.equal(can({ role: "builder" }, "createDomain", CONFIG), false)
  assert.equal(can({ role: "lead", domain: "ops" }, "decideAccessRequests", CONFIG), true)
})

test("no session / unknown bundle resolves to zero capabilities", () => {
  assert.equal(can(null, "createDomain", CONFIG), false)
  assert.equal(can({ role: "ghost" }, "createDomain", CONFIG), false)
  assert.deepEqual([...resolveCapabilities(CONFIG, undefined)], [])
})

test("explicit bundle assignment wins over role name", () => {
  assert.equal(can({ role: "builder", bundle: "lead" }, "decideAccessRequests", CONFIG), true)
})

test("domain override adds and removes flags inside that domain only", () => {
  const inFinance = { role: "builder", domain: "finance" }
  const elsewhere = { role: "builder", domain: "ops" }
  assert.equal(can(inFinance, "decideAccessRequests", CONFIG), true)
  assert.equal(can(inFinance, "domainContentPlane", CONFIG), false)
  assert.equal(can(elsewhere, "decideAccessRequests", CONFIG), false)
  assert.equal(can(elsewhere, "domainContentPlane", CONFIG), true)
})

test("validation: default bundles are required, unknown capabilities rejected, no admin self-lockout", () => {
  assert.equal(validateBundlesConfig(loadBundles()), null)
  assert.match(validateBundlesConfig({ bundles: { admin: { capabilities: [] }, lead: { capabilities: [] } } }), /builder/)
  assert.match(validateBundlesConfig({
    bundles: { admin: { capabilities: ["manageCapabilityBundles", "flyToTheMoon"] }, lead: { capabilities: [] }, builder: { capabilities: [] }, user: { capabilities: [] } },
  }), /unknown capability/)
  assert.match(validateBundlesConfig({
    bundles: { admin: { capabilities: [] }, lead: { capabilities: [] }, builder: { capabilities: [] }, user: { capabilities: [] } },
  }), /manageCapabilityBundles/)
  assert.match(validateBundlesConfig({
    bundles: { admin: { capabilities: ["manageCapabilityBundles"] }, lead: { capabilities: [] }, builder: { capabilities: [] }, user: { capabilities: [] } },
    domainOverrides: { ops: { ghost: { add: [] } } },
  }), /unknown bundle/)
})

test("R-012: the shipped user bundle cannot be deleted", () => {
  assert.match(validateBundlesConfig({
    bundles: { admin: { capabilities: ["manageCapabilityBundles"] }, lead: { capabilities: [] }, builder: { capabilities: [] } },
  }), /user/)
})

test("R-009: platform-tier capabilities cannot be delegated via domainOverrides.add", () => {
  const base = {
    bundles: { admin: { capabilities: ["manageCapabilityBundles"] }, lead: { capabilities: [] }, builder: { capabilities: [] }, user: { capabilities: [] } },
  }
  assert.match(validateBundlesConfig({
    ...base, domainOverrides: { ops: { builder: { add: ["manageCapabilityBundles"] } } },
  }), /platform-tier/)
  assert.match(validateBundlesConfig({
    ...base, domainOverrides: { ops: { lead: { add: ["exportAudit"] } } },
  }), /platform-tier/)
  // removing is fine (a domain may tighten), and domain-tier adds stay legal.
  assert.equal(validateBundlesConfig({
    ...base, domainOverrides: { ops: { builder: { remove: ["domainContentPlane"] }, lead: { add: ["decideInterrupts"] } } },
  }), null)
})

test("R-013: direct file write invalidates the loadBundles cache immediately", () => {
  const snapshot = readFileSync(BUNDLES_PATH, "utf8")
  try {
    assert.equal(can({ role: "user" }, "useBuilderSurfaces", loadBundles()), false)
    const edited = JSON.parse(snapshot)
    edited.bundles.user.capabilities = ["useBuilderSurfaces"]
    // Two writes back-to-back inside one mtime tick — the exact race independent review hit
    // on xfs. The content-keyed cache must see the final state either way.
    writeFileSync(BUNDLES_PATH, JSON.stringify(edited, null, 2))
    writeFileSync(BUNDLES_PATH, JSON.stringify(edited, null, 2) + "\n")
    assert.equal(can({ role: "user" }, "useBuilderSurfaces", loadBundles()), true)
    writeFileSync(BUNDLES_PATH, snapshot)
    assert.equal(can({ role: "user" }, "useBuilderSurfaces", loadBundles()), false)
  } finally {
    writeFileSync(BUNDLES_PATH, snapshot)
  }
})

test("committed defaults reproduce today's role behavior (zero behavior change)", () => {
  const config = loadBundles()
  const admin = { role: "admin", domain: null }
  const lead = { role: "lead", domain: "customer-support" }
  const builder = { role: "builder", domain: "customer-support" }
  const user = { role: "user", domain: null }

  // Every capability the config grants must exist in the catalog.
  for (const b of Object.values(config.bundles))
    for (const c of b.capabilities) assert.ok(CAPABILITIES[c], `capability ${c} is cataloged`)

  // admin-only powers: exactly the session.role === "admin" gates being replaced.
  for (const cap of ["createDomain", "manageRegistryEntries", "approveRegistryVersion", "manageApprovalPolicies", "decideInterrupts",
    "manageAlertPolicies", "manageIncidents", "manageIntegrations", "exportAudit", "approveAgentDeploy",
    "manageCapabilityBundles", "viewAllDomains"]) {
    assert.equal(can(admin, cap, config), true, `admin has ${cap}`)
    assert.equal(can(lead, cap, config), false, `lead lacks ${cap}`)
    assert.equal(can(builder, cap, config), false, `builder lacks ${cap}`)
    assert.equal(can(user, cap, config), false, `user lacks ${cap}`)
  }
  // lead-only: deciding access requests (role === "lead" gate).
  assert.equal(can(lead, "decideAccessRequests", config), true)
  for (const s of [admin, builder, user]) assert.equal(can(s, "decideAccessRequests", config), false)
  // G6 (independent review R-006): member management is lead/admin, never builder/user.
  for (const s of [admin, lead]) assert.equal(can(s, "manageProjectMembers", config), true)
  for (const s of [builder, user]) assert.equal(can(s, "manageProjectMembers", config), false)
  // G9: the audit trail is admin/lead per prd — builders and end users never see it.
  for (const s of [admin, lead]) assert.equal(can(s, "viewAuditTrail", config), true)
  for (const s of [builder, user]) assert.equal(can(s, "viewAuditTrail", config), false)
  // domain plane (builder/lead only — domainPlaneScoped today).
  for (const s of [lead, builder]) assert.equal(can(s, "domainContentPlane", config), true)
  for (const s of [admin, user]) assert.equal(can(s, "domainContentPlane", config), false)
  // builder surfaces exclude end users only (role === "user" 403s today).
  for (const s of [admin, lead, builder]) assert.equal(can(s, "useBuilderSurfaces", config), true)
  assert.equal(can(user, "useBuilderSurfaces", config), false)
  // end users hold no capabilities at all.
  assert.deepEqual([...resolveCapabilities(config, user)], [])
})
