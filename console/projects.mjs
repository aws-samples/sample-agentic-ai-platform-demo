// G5 (governance-foundation): project = durable multi-agent workspace.
// Decision record: agent.md (current ownership and authorization contract).
// A project owns 1:N agents and carries a members list ([{principal, bundle}])
// so capability bundles attach to people-in-a-project, not global roles.
// The store is a runtime JSON file (like ai-registry.json): backfilled from
// the existing single-agent compositions on first read, never committed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.CONSOLE_DATA_DIR || __dirname
export const PROJECTS_PATH = join(DATA_DIR, "projects.json")
export const PROJECTS_SEED_PATH = join(__dirname, "projects.seed.json")

// The seed is a write a READ performs on the caller's behalf, so the console's
// validating paths (server.mjs nonMutating) must be able to hold it: while the
// hold is on, readProjects hands the seed back in memory instead of
// materializing projects.json — same DATA, no file (the domainPolicies
// pattern). Injected by server.mjs; the default never holds, so direct use
// (tests, scripts) keeps the explicit existsSync-short-circuited seed.
let holdSeedWrites = () => false
export function setSeedWriteHold(fn) { holdSeedWrites = fn }

export function seedProjectsIfMissing(projectsPath = PROJECTS_PATH, seedPath = PROJECTS_SEED_PATH) {
  if (existsSync(projectsPath) || !existsSync(seedPath)) return false
  if (holdSeedWrites()) return false
  mkdirSync(dirname(projectsPath), { recursive: true })
  copyFileSync(seedPath, projectsPath)
  return true
}

export function readProjects() {
  seedProjectsIfMissing()
  if (!existsSync(PROJECTS_PATH) && existsSync(PROJECTS_SEED_PATH)) {
    try { return JSON.parse(readFileSync(PROJECTS_SEED_PATH, "utf8")) } catch { return [] }
  }
  try { return JSON.parse(readFileSync(PROJECTS_PATH, "utf8")) } catch { return [] }
}

export function saveProjects(list) {
  mkdirSync(dirname(PROJECTS_PATH), { recursive: true })
  writeFileSync(PROJECTS_PATH, JSON.stringify(list, null, 2))
}

// Pure + idempotent: every composition not yet owned by ANY project becomes a
// new single-agent project (SPEC: "each becomes a project owning that one
// agent"), and a project whose agents have ALL been deleted is pruned — the
// mirror of backfill, so the store never accumulates rows pointing at
// compositions that no longer exist (wizard smokes generate-then-delete
// agents every run). Existing live projects are never touched, so re-running
// is a no-op — the composition set, not a "seeded" flag, is the idempotency
// key (self-healing, like ensureDomainFields).
// compositions: [{ id, domain }]; membersForDomain(domain) -> [{principal, bundle}].
export function backfillProjects(existing, compositions, membersForDomain) {
  const live = new Set(compositions.map(c => c.id))
  const kept = existing.filter(p => !(p.agents || []).length || (p.agents || []).some(a => live.has(a)))
  const owned = new Set(kept.flatMap(p => p.agents || []))
  const added = compositions
    .filter(c => !owned.has(c.id))
    .map(c => ({
      id: c.id,
      name: c.id,
      domain: c.domain,
      profileId: null,
      members: membersForDomain(c.domain),
      agents: [c.id],
      createdBy: "backfill",
      createdAt: new Date().toISOString(),
    }))
  return added.length || kept.length !== existing.length
    ? { projects: [...kept, ...added], changed: true }
    : { projects: existing, changed: false }
}
