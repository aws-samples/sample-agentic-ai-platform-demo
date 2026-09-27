// TLP Batch 1 (§3.1a default-deny): one-shot, idempotent migration that
// backfills domain/project attribution onto existing seeded/runtime resources
// so the default-deny hard constraint doesn't strand pre-existing demo data.
//
//   node scripts/migrate-tlp-attribution.mjs          # apply (idempotent)
//   node scripts/migrate-tlp-attribution.mjs --check  # report only, exit 1 if work remains
//
// What it covers:
//   1. console/projects.json rows with a null/missing domain -> resolved from
//      the domains.json roster or the composition's domain-harness.json;
//      unresolvable rows are REPORTED (they need the platform claim flow, not
//      a silent directional default — QA C4).
//   2. domain-examples/generated/<p>/domain-harness.json missing `domain` ->
//      backfilled from projects.json / domains.json roster.
//   3. generated compositions' agentcore.json missing the §3.2 tag set
//      (domain-id/project-id/component/managed-by/env) -> stamped.
//   4. console/ai-registry.json entries with domain:null -> stamped with the
//      same rule the server seeds with (Agent -> platform, else shared),
//      except entries whose id matches a domain roster agent (roster wins).
//   5. console/sim-memories.json stores nothing resolves -> REPORTED as
//      unattributed (the R-015 claim flow owns those; never auto-claimed).
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, "..")
const CONSOLE = join(REPO, "console")
const GENERATED = join(REPO, "domain-examples", "generated")
const CHECK = process.argv.includes("--check")

const readJson = p => { try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null } }
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2))

const domains = readJson(join(CONSOLE, "domains.json")) || []
const rosterDomain = agentId => domains.find(d => (d.agents || []).includes(String(agentId)))?.id || null

let changes = 0
const unresolved = []
const log = msg => console.log(`  ${msg}`)

// ---- 1+2. projects.json rows + generated harness domains -------------------
const projectsPath = join(CONSOLE, "projects.json")
const projects = readJson(projectsPath)
const harnessDomain = id => {
  const p = join(GENERATED, String(id).replace(/[^a-z0-9-]/gi, "").replace(/-/g, ""), "domain-harness.json")
  const alt = join(GENERATED, String(id), "domain-harness.json")
  return readJson(p)?.domain || readJson(alt)?.domain || null
}
if (projects) {
  let touched = false
  for (const p of projects) {
    if (p.domain != null) continue
    const resolved = rosterDomain(p.id) || (p.agents || []).map(rosterDomain).find(Boolean)
      || harnessDomain(p.id) || (p.agents || []).map(harnessDomain).find(Boolean)
    if (resolved) {
      log(`projects.json: ${p.id} domain null -> ${resolved}`)
      if (!CHECK) { p.domain = resolved; touched = true }
      changes++
    } else {
      unresolved.push(`projects.json: ${p.id} has no resolvable domain — claim it via the platform claim flow`)
    }
  }
  if (touched) writeJson(projectsPath, projects)
}

// ---- 2+3. generated compositions: harness domain + §3.2 tags ---------------
if (existsSync(GENERATED)) {
  for (const d of readdirSync(GENERATED)) {
    const dir = join(GENERATED, d)
    const cfgPath = join(dir, "agentcore", "agentcore.json")
    if (!existsSync(cfgPath)) continue
    const harnessPath = join(dir, "domain-harness.json")
    const harness = readJson(harnessPath)
    let domain = harness?.domain || null
    if (!domain) {
      domain = rosterDomain(d) || (projects || []).find(p => (p.agents || []).includes(d))?.domain || null
      if (domain) {
        log(`generated/${d}: harness domain missing -> ${domain}`)
        if (!CHECK) writeJson(harnessPath, { ...(harness || { project: d }), domain })
        changes++
      } else {
        unresolved.push(`generated/${d}: no harness domain and nothing resolves one — unattributed (claim flow)`)
        continue
      }
    }
    const cfg = readJson(cfgPath)
    if (!cfg) continue
    const tags = cfg.tags || {}
    if (tags["domain-id"] !== domain || tags["project-id"] !== (cfg.name || d)) {
      log(`generated/${d}: stamping §3.2 tags (domain-id=${domain})`)
      if (!CHECK) {
        cfg.tags = { ...tags, "domain-id": domain, "project-id": cfg.name || d,
          component: tags.component || "runtime", "managed-by": tags["managed-by"] || "plato-bootstrap",
          env: tags.env || "nonprod" }
        writeJson(cfgPath, cfg)
      }
      changes++
    }
  }
}

// ---- 4. ai-registry.json null domains ---------------------------------------
const registryPath = join(CONSOLE, "ai-registry.json")
const registry = readJson(registryPath)
if (registry) {
  let touched = false
  for (const e of registry) {
    if (e.domain != null) continue
    const resolved = rosterDomain(e.id) || (e.type === "Agent" ? "platform" : "shared")
    log(`ai-registry.json: ${e.type} ${e.id} domain null -> ${resolved}`)
    if (!CHECK) { e.domain = resolved; touched = true }
    changes++
  }
  if (touched) writeJson(registryPath, registry)
}

// ---- 5. sim-memories: report-only (claim flow owns unattributed stores) ----
const mems = readJson(join(CONSOLE, "sim-memories.json")) || []
const attribs = readJson(join(CONSOLE, "memory-attributions.json")) || {}
for (const m of mems) {
  if (m.domain == null && !attribs[m.id]) {
    const roster = domains.find(dm => (dm.agents || []).some(a =>
      String(m.name || "").toLowerCase().startsWith(String(a).replace(/-/g, "").toLowerCase() + "_")))
    if (!roster) unresolved.push(`sim-memories.json: ${m.id} is unattributed — attribute it via POST /api/memory-attribute`)
  }
}

console.log(`\n${CHECK ? "[check] " : ""}${changes} change(s) ${CHECK ? "needed" : "applied"}; ${unresolved.length} unresolved`)
for (const u of unresolved) console.log(`  UNRESOLVED: ${u}`)
process.exit(CHECK && (changes > 0 || unresolved.length > 0) ? 1 : 0)
