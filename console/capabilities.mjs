// G1 (governance-foundation): capability resolver. Every authorization
// decision goes through can(session, capability); what a role may do is DATA
// (console/capability-bundles.json), not code. Bundles are named sets of
// capability flags; a session resolves to a bundle by its assigned bundle
// name (project membership, later phases) or its role name as the default.
// Domain-scoped overrides let one domain tighten/extend a bundle without
// forking it. Decision record: agent.md (current ownership and authorization contract).
import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const BUNDLES_PATH = join(__dirname, "capability-bundles.json")

// The capability catalog: every flag a bundle may grant, with the human
// description the Governance UI renders. A capability only has effect where a
// route handler checks it — editing bundles rewires WHO may do a thing, the
// catalog itself defines WHAT things exist.
export const CAPABILITIES = {
  viewAllDomains: "Operate with no active domain: fleet-wide resource views and the 'All domains' scope.",
  createDomain: "Vend a new domain (namespace, scopes, cost bucket, builder/lead sign-ins).",
  approveRegistryVersion: "Approve or reject submitted registry entry versions.",
  manageRegistryEntries: "Propose, submit, drift-demote and remove AI Registry entries (platform-team registry CRUD — spec §7.2: builders/domains consume the registry read-only).",
  manageApprovalPolicies: "Create, update, and remove HITL approval policies.",
  decideInterrupts: "Approve or deny interrupted tool calls in the HITL queue.",
  manageAlertPolicies: "Create, update, and remove alert policies.",
  manageIncidents: "Fire demo incidents and resolve firing incidents.",
  manageIntegrations: "Wire ecosystem integrations and run SIEM audit exports.",
  exportAudit: "Export audit records to external systems.",
  approveAgentDeploy: "Approve deployed agents for production traffic.",
  manageCapabilityBundles: "Read and edit the capability bundles themselves (this config).",
  requestPlatformContentAccess: "Request time-boxed platform-side access to domain memory/dataset content (break-glass path).",
  decideBreakGlass: "Decide MEMORY-content break-glass grant requests as a platform peer (spec §8: memory content is grant-gated for every role — a lead's own-domain request and an admin's platform-store request both need a second pair of eyes; requester ≠ approver still holds).",
  attributeMemoryStores: "Attribute an unattributed (ownerless) memory store to a domain so its content gets an owning lead (R-015 claim path).",
  ownContentPlane: "Own a content plane: default (audited) content visibility for the plane this session owns.",
  viewDomainCostRollup: "See domain/org-level cost rollups and budget burn (spec §8: builders see own-project cost detail only, never the domain/org aggregate).",
  viewDomainOperations: "Open domain operational views (drill-down, fleet slices).",
  viewAlerts: "See the alerting feed and firing incidents.",
  useBuilderSurfaces: "Use builder surfaces: Build tab, doors, AI-assisted inception, from-scratch journey.",
  manageProjectMembers: "Add or remove project members and assign their capability bundles (own-scope projects).",
  domainContentPlane: "Domain-plane content scope: trace/memory/dataset content paths inside the session's own domain.",
  requestContentAccess: "File access requests for content owned by another plane.",
  decideAccessRequests: "Decide (approve/deny) content access requests for the owned domain.",
  viewAuditTrail: "Open the unified audit timeline: governance decisions and content-access events (own scope).",
  requestModelAccess: "Request time-boxed access to a restricted LLM gateway model for the active domain.",
  manageModelAccess: "Manage LLM gateway model access policy and rate-limit profiles.",
}

// G2 routes every handler through can(), including per-item list filters, so
// the parsed config is cached keyed on raw file CONTENT: edits (API or direct
// file write) still apply immediately, without a JSON parse per capability
// check. Content, not mtime — xfs mtime granularity is too coarse to see two
// quick successive writes, so an mtime key misses direct writes (independent review R-013).
let cached = null, cachedRaw = null
export function loadBundles() {
  const raw = readFileSync(BUNDLES_PATH, "utf8")
  if (!cached || raw !== cachedRaw) {
    cached = JSON.parse(raw)
    cachedRaw = raw
  }
  return cached
}
export function saveBundles(config) { writeFileSync(BUNDLES_PATH, JSON.stringify(config, null, 2)); cached = null }

// IDENTITY DERIVATION (not authorization): the session's bundle name is its
// explicit bundle assignment or its role name. Exported so callers that STORE
// a bundle name (G5 project members) derive it the same way the resolver does.
export const bundleNameFor = session => session.bundle || session.role

// Pure resolver (unit-testable without the file): the active domain may carry
// an override that adds/removes flags for that bundle inside that domain only.
export function resolveCapabilities(config, session) {
  if (!session) return new Set()
  const bundleName = bundleNameFor(session)
  const bundle = config?.bundles?.[bundleName]
  if (!bundle) return new Set()
  const caps = new Set(bundle.capabilities || [])
  const override = session.domain ? config?.domainOverrides?.[session.domain]?.[bundleName] : null
  if (override) {
    for (const c of override.add || []) caps.add(c)
    for (const c of override.remove || []) caps.delete(c)
  }
  return caps
}

export function can(session, capability, config = loadBundles()) {
  return resolveCapabilities(config, session).has(capability)
}

// Validation for the admin edit API: bundles stay well-formed, only cataloged
// capabilities may be granted, the shipped default bundles cannot be deleted,
// and the admin bundle cannot drop manageCapabilityBundles (self-lockout).
const DEFAULT_BUNDLES = ["admin", "lead", "builder", "user"]

// Platform-tier capabilities (independent review R-009): flags whose blast radius exceeds a
// single domain. They may live in bundles (platform team roles), but a
// domainOverrides.add must not silently delegate them to a domain-scoped
// session — that would hand platform governance to one domain's members.
export const PLATFORM_TIER = new Set([
  "viewAllDomains",
  "createDomain",
  "manageCapabilityBundles",
  "manageIntegrations",
  "manageModelAccess",
  "exportAudit",
  "requestPlatformContentAccess",
  "attributeMemoryStores",
  "manageRegistryEntries",
  "decideBreakGlass",
])
export function validateBundlesConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "Config must be an object."
  if (!config.bundles || typeof config.bundles !== "object" || Array.isArray(config.bundles)) return "Config needs a bundles object."
  for (const name of DEFAULT_BUNDLES) {
    if (!config.bundles[name]) return `Default bundle "${name}" cannot be removed.`
  }
  for (const [name, bundle] of Object.entries(config.bundles)) {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return `Bundle "${name}" must be an object.`
    if (!Array.isArray(bundle.capabilities)) return `Bundle "${name}" needs a capabilities array.`
    for (const c of bundle.capabilities) {
      if (!CAPABILITIES[c]) return `Bundle "${name}" grants unknown capability "${c}".`
    }
  }
  if (!config.bundles.admin.capabilities.includes("manageCapabilityBundles"))
    return "The admin bundle must keep manageCapabilityBundles (otherwise no one can edit bundles)."
  if (config.domainOverrides !== undefined) {
    if (typeof config.domainOverrides !== "object" || Array.isArray(config.domainOverrides)) return "domainOverrides must be an object."
    for (const [domain, byBundle] of Object.entries(config.domainOverrides)) {
      if (!byBundle || typeof byBundle !== "object" || Array.isArray(byBundle)) return `domainOverrides.${domain} must be an object.`
      for (const [bundleName, ov] of Object.entries(byBundle)) {
        if (!config.bundles[bundleName]) return `domainOverrides.${domain} targets unknown bundle "${bundleName}".`
        for (const c of [...(ov?.add || []), ...(ov?.remove || [])]) {
          if (!CAPABILITIES[c]) return `domainOverrides.${domain}.${bundleName} uses unknown capability "${c}".`
        }
        for (const c of ov?.add || []) {
          if (PLATFORM_TIER.has(c)) return `domainOverrides.${domain}.${bundleName} cannot add platform-tier capability "${c}" — platform governance is not delegable to one domain.`
        }
      }
    }
  }
  return null
}
