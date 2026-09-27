#!/usr/bin/env node
// Scale fixture (T14 / testplan S1): seeds 3 extra domains and 110 AI Registry
// Agent entries so the console can be demoed at "domain #3..#30 is as cheap as
// #2" scale. Everything written is marked seededBy:"seed-scale" and removed
// exactly by --restore. The fixture only touches console-local data stores
// (domains.json + ai-registry.json) — it never fabricates AWS runtimes, usage
// ledger rows, or audit entries, so Operate/Cost keep showing only real state.
//
//   node scripts/seed-scale.mjs             # apply (idempotent)
//   node scripts/seed-scale.mjs --restore   # remove everything the seed added
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const CONSOLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "console")
const DOMAINS_PATH = join(CONSOLE_DIR, "domains.json")
const REGISTRY_PATH = join(CONSOLE_DIR, "ai-registry.json")
const MARK = "seed-scale"

const REGIONS = ["EU", "US", "APAC", "LATAM"]
const SEED_DOMAINS = [
  {
    id: "payments", name: "Payments", count: 40,
    description: "Payment processing, reconciliation and dispute agents.",
    bases: ["Invoice Reconciliation", "Refund Triage", "Chargeback Review", "Payment Retry",
      "Fraud Screening", "Settlement Report", "Vendor Payout", "Dunning Outreach",
      "FX Rate Watch", "Ledger Sync", "Card Dispute", "Payment Status"],
  },
  {
    id: "people-ops", name: "People Ops", count: 35,
    description: "HR self-service and employee lifecycle agents.",
    bases: ["Onboarding Concierge", "Benefits Q&A", "PTO Balance", "Payroll Inquiry",
      "Policy Lookup", "Recruiting Screen", "Offer Letter Draft", "Performance Reminder",
      "Training Recommender", "Org Chart Navigator", "Exit Checklist", "Timesheet Nudge"],
  },
  {
    id: "logistics", name: "Logistics", count: 35,
    description: "Shipping, inventory and carrier operations agents.",
    bases: ["Shipment Tracker", "Route Planner", "Customs Docs", "Inventory Forecast",
      "Warehouse Slotting", "Carrier Rate Quote", "Delivery Exception", "Fleet Maintenance",
      "Returns Routing", "Pallet Optimizer", "Dock Scheduler", "Freight Audit"],
  },
]

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
const die = msg => { console.error(`seed-scale: ${msg}`); process.exit(1) }

if (!existsSync(REGISTRY_PATH)) {
  die("console/ai-registry.json does not exist yet — start the console server once (it seeds the AI Registry), then re-run.")
}
const domains = JSON.parse(readFileSync(DOMAINS_PATH, "utf8"))
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))

if (process.argv.includes("--restore")) {
  const keptDomains = domains.filter(d => d.seededBy !== MARK)
  const keptRegistry = registry.filter(e => e.seededBy !== MARK)
  writeFileSync(DOMAINS_PATH, JSON.stringify(keptDomains, null, 2) + "\n")
  writeFileSync(REGISTRY_PATH, JSON.stringify(keptRegistry, null, 2) + "\n")
  console.log(`seed-scale: restored — removed ${domains.length - keptDomains.length} domains, ${registry.length - keptRegistry.length} registry entries.`)
  process.exit(0)
}

if (domains.some(d => d.seededBy === MARK)) {
  console.log("seed-scale: fixture already applied — nothing to do (use --restore to remove it).")
  process.exit(0)
}

const now = new Date().toISOString()
let agentIndex = 0
const newDomains = []
const newEntries = []

for (const d of SEED_DOMAINS) {
  const agentIds = []
  for (let i = 0; i < d.count; i++) {
    const base = d.bases[i % d.bases.length]
    const region = REGIONS[Math.floor(i / d.bases.length) % REGIONS.length]
    const name = `${base} (${region})`
    const id = `${d.id}-${slug(base)}-${region.toLowerCase()}`
    // deterministic status mix: mostly APPROVED, a few DRAFT / IN_REVIEW so the
    // Governance approval queue and status filters also show scale.
    const status = agentIndex % 9 === 3 ? "DRAFT" : agentIndex % 9 === 6 ? "IN_REVIEW" : "APPROVED"
    agentIndex++
    agentIds.push(id)
    newEntries.push({
      id, type: "Agent", name,
      description: `${base} agent for the ${region} region (${d.name} domain).`,
      governanceMode: "federated",
      domainOwner: `${d.name} domain team`,
      domain: d.id,
      defaultVersion: status === "APPROVED" ? "1.0.0" : null,
      seededBy: MARK,
      versions: [{
        semver: "1.0.0", status,
        content: { project: id, blueprint: agentIndex % 3 === 0 ? "workflow-orchestrator" : "chat-assistant" },
        changelog: "Scale fixture entry (seed-scale).",
        createdBy: MARK, createdAt: now,
        decidedBy: status === "APPROVED" ? "platform" : null,
        decidedAt: status === "APPROVED" ? now : null,
        autoChecks: [],
      }],
    })
  }
  newDomains.push({
    id: d.id, name: d.name,
    owner: `${d.name} domain team`,
    description: d.description,
    ownerGroup: `idp-group:${d.id}-builders`,
    tokenBudget: 2000000,
    agents: agentIds,
    users: [
      { id: `${d.id}-builder`, name: `${d.name} Builder`, role: "builder" },
      { id: `${d.id}-lead`, name: `${d.name} Lead`, role: "lead" },
    ],
    seededBy: MARK,
    seededAt: now,
  })
}

writeFileSync(DOMAINS_PATH, JSON.stringify([...domains, ...newDomains], null, 2) + "\n")
writeFileSync(REGISTRY_PATH, JSON.stringify([...registry, ...newEntries], null, 2) + "\n")
console.log(`seed-scale: applied — ${newDomains.length} domains (${newDomains.map(d => d.id).join(", ")}), ${newEntries.length} registry Agent entries. Restore with: node scripts/seed-scale.mjs --restore`)
