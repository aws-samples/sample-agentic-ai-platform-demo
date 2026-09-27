// Unit tests for the G5 project backfill: SPEC project shape, idempotency
// (re-run adds nothing), new compositions migrate without touching existing
// projects, and members seed from the domain roster.
// Run: node --test console/projects.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { backfillProjects, PROJECTS_SEED_PATH, seedProjectsIfMissing } from "./projects.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const members = domain =>
  domain === "customer-support"
    ? [{ principal: "alice", bundle: "builder" }, { principal: "carol", bundle: "lead" }]
    : [{ principal: "melanie", bundle: "admin" }]

const roster = [
  { id: "supportdesk", domain: "customer-support" },
  { id: "it-helpdesk", domain: "platform" },
]

test("backfill creates one SPEC-shaped project per unowned composition", () => {
  const { projects, changed } = backfillProjects([], roster, members)
  assert.equal(changed, true)
  assert.equal(projects.length, 2)
  const p = projects.find(x => x.id === "supportdesk")
  assert.deepEqual(Object.keys(p).sort(),
    ["agents", "createdAt", "createdBy", "domain", "id", "members", "name", "profileId"])
  assert.equal(p.domain, "customer-support")
  assert.equal(p.profileId, null)
  assert.deepEqual(p.agents, ["supportdesk"])
  assert.deepEqual(p.members, [{ principal: "alice", bundle: "builder" }, { principal: "carol", bundle: "lead" }])
  assert.equal(p.createdBy, "backfill")
  assert.ok(p.createdAt)
})

test("backfill is idempotent: second run over the same roster changes nothing", () => {
  const first = backfillProjects([], roster, members)
  const second = backfillProjects(first.projects, roster, members)
  assert.equal(second.changed, false)
  assert.equal(second.projects, first.projects)
})

test("a composition owned by ANY project is never re-backfilled", () => {
  const existing = [{
    id: "cs-workspace", name: "CS Workspace", domain: "customer-support", profileId: null,
    members: [{ principal: "carol", bundle: "lead" }],
    agents: ["supportdesk", "returns-bot"], createdBy: "carol", createdAt: "2026-08-01T00:00:00.000Z",
  }]
  const { projects, changed } = backfillProjects(existing, roster, members)
  assert.equal(changed, true)
  assert.equal(projects.length, 2)
  // the multi-agent workspace is untouched; only the unowned composition migrated
  assert.equal(projects[0], existing[0])
  assert.equal(projects[1].id, "it-helpdesk")
})

test("a project whose compositions are ALL gone is pruned (backfill mirror)", () => {
  const first = backfillProjects([], [...roster, { id: "t11wizephemeral", domain: "customer-support" }], members)
  assert.equal(first.projects.length, 3)
  // the ephemeral wizard project's composition is deleted -> its row goes too
  const { projects, changed } = backfillProjects(first.projects, roster, members)
  assert.equal(changed, true)
  assert.deepEqual(projects.map(p => p.id).sort(), ["it-helpdesk", "supportdesk"])
  // a multi-agent project keeps its row while ANY member agent is live
  const multi = [{
    id: "cs-workspace", name: "CS Workspace", domain: "customer-support", profileId: null,
    members: [], agents: ["supportdesk", "gone-agent"], createdBy: "carol", createdAt: "2026-08-01T00:00:00.000Z",
  }]
  const kept = backfillProjects(multi, roster, members)
  assert.ok(kept.projects.some(p => p.id === "cs-workspace"))
})

test("new composition appears without disturbing prior backfill (append-only)", () => {
  const first = backfillProjects([], roster, members)
  const grown = [...roster, { id: "returns-bot", domain: "customer-support" }]
  const { projects, changed } = backfillProjects(first.projects, grown, members)
  assert.equal(changed, true)
  assert.equal(projects.length, 3)
  assert.equal(projects[0], first.projects[0])
  assert.equal(projects[1], first.projects[1])
  assert.deepEqual(projects[2].agents, ["returns-bot"])
})

test("seed bootstrap initializes a missing projects.json without overwriting an existing store", t => {
  const dir = mkdtempSync(join(tmpdir(), "projects-seed-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dest = join(dir, "projects.json")

  assert.equal(seedProjectsIfMissing(dest), true)
  const seeded = JSON.parse(readFileSync(dest, "utf8"))
  assert.equal(seeded.length, 4)
  assert.ok(seeded.some(p => p.id === "concierge"))

  writeFileSync(dest, JSON.stringify([{ id: "existing" }], null, 2))
  assert.equal(seedProjectsIfMissing(dest), false)
  assert.deepEqual(JSON.parse(readFileSync(dest, "utf8")), [{ id: "existing" }])
})

test("projects seed has supportdesk budget headroom and no seeded project starts over budget", () => {
  const projects = JSON.parse(readFileSync(PROJECTS_SEED_PATH, "utf8"))
  const ledger = JSON.parse(readFileSync(join(__dirname, "usage-ledger-seed.json"), "utf8"))
  const usage = {}
  for (const row of ledger) usage[row.project] = (usage[row.project] || 0) + row.inputTokens + row.outputTokens

  const supportdesk = projects.find(p => p.id === "supportdesk")
  assert.equal(supportdesk.tokenBudget, 16000)
  assert.ok(usage.supportdesk / supportdesk.tokenBudget >= 0.6)
  assert.ok(usage.supportdesk / supportdesk.tokenBudget <= 0.7)

  const overBudget = projects.filter(p => p.tokenBudget != null && (usage[p.id] || 0) > p.tokenBudget)
  assert.deepEqual(overBudget, [])
})
