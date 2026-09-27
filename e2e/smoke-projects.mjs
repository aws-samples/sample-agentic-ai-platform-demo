// G5 smoke: project = durable multi-agent workspace (decision 1).
// Every existing composition backfills into a project owning that one agent
// (idempotent — a second read adds nothing); projects are domain-scoped with
// foreign/unknown ids both 404 (no existence oracle); composing a new agent
// creates its project stamped with the real composer; agent detail pages keep
// working on top of the project layer.
// Run: node e2e/smoke-projects.mjs   (expects console server on :4000)
import fs from 'node:fs'
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

// Snapshot + restore the projects store (smoke-domains pattern). The store may
// not exist yet — restore then means delete (the lazy backfill recreates it).
const projPath = new URL('../console/projects.json', import.meta.url).pathname
const projSnap = fs.existsSync(projPath) ? fs.readFileSync(projPath, 'utf8') : null
const GEN = 'g5projsmoke'
const genDir = new URL(`../domain-examples/generated/${GEN}/`, import.meta.url).pathname

try {
  // ---------- 1. backfill: every domain-roster agent is owned by a project ----------
  const adminView = await authedGet('/projects', admin)
  check('admin project list responds ok', adminView.ok === true && Array.isArray(adminView.projects))
  const domainsView = await authedGet('/domains', admin)
  const rosterAgents = (domainsView.domains || []).flatMap(d => d.agents || [])
  const owned = new Set((adminView.projects || []).flatMap(p => p.agents || []))
  check(`every domain-roster agent is owned by a project (${rosterAgents.length} agents)`,
    rosterAgents.length > 0 && rosterAgents.every(a => owned.has(a)))
  const ownerCount = {}
  for (const p of adminView.projects || []) for (const a of p.agents || []) ownerCount[a] = (ownerCount[a] || 0) + 1
  check('no agent is owned by two projects', Object.values(ownerCount).every(n => n === 1))

  // ---------- 2. SPEC project shape ----------
  const SHAPE = ['id', 'name', 'domain', 'profileId', 'members', 'agents', 'createdBy', 'createdAt']
  check('every project carries the SPEC shape (id/name/domain/profileId/members/agents/createdBy/createdAt)',
    (adminView.projects || []).every(p => SHAPE.every(k => k in p)))
  check('backfilled members are {principal, bundle} pairs',
    (adminView.projects || []).every(p => (p.members || []).every(m => typeof m.principal === 'string' && typeof m.bundle === 'string')))
  const sd = (adminView.projects || []).find(p => p.id === 'supportdesk')
  check('supportdesk project sits in customer-support with its domain team as members',
    !!sd && sd.domain === 'customer-support' &&
    (sd.members || []).some(m => m.principal === 'alice' && m.bundle === 'builder') &&
    (sd.members || []).some(m => m.principal === 'carol' && m.bundle === 'lead'))

  // ---------- 3. idempotency: a second read changes nothing ----------
  const storeAfterFirst = fs.readFileSync(projPath, 'utf8')
  await authedGet('/projects', admin)
  check('backfill is idempotent — store byte-identical after a second read',
    fs.readFileSync(projPath, 'utf8') === storeAfterFirst)

  // ---------- 4. domain scoping + auth gates ----------
  const aliceView = await authedGet('/projects', alice)
  check('builder sees own-domain projects only (customer-support, never operations/platform)',
    (aliceView.projects || []).length > 0 &&
    (aliceView.projects || []).every(p => p.domain === 'customer-support' || p.domain === 'shared'))
  const endUserView = await authedGet('/projects', enduser)
  check('end user gets 403 on the project list', endUserView.ok === false)
  const anon = await fetch(BASE + '/api/projects')
  check('unauthenticated project list is 401', anon.status === 401)

  // ---------- 5. project-detail: foreign and unknown ids are the same 404 ----------
  const detail = await authedGet('/project-detail?id=supportdesk', admin)
  check('admin opens a project detail', detail.ok === true && detail.project?.id === 'supportdesk')
  const opsProject = (adminView.projects || []).find(p => p.domain === 'operations')
  const foreign = await fetch(BASE + `/api/project-detail?id=${opsProject.id}`, { headers: { authorization: 'Bearer ' + alice.token } })
  const unknown = await fetch(BASE + '/api/project-detail?id=no-such-project', { headers: { authorization: 'Bearer ' + alice.token } })
  check('foreign-domain project id returns 404 for a builder', foreign.status === 404)
  check('unknown project id returns the SAME 404 (no existence oracle)', unknown.status === 404)
  const ownDetail = await authedGet(`/project-detail?id=${opsProject.id}`, bob)
  check('operations builder opens the same project alice cannot', ownDetail.ok === true)

  // ---------- 6. composing a new agent creates its project (real creator) ----------
  const gen = await authedPost('/generate', { blueprint: 'chat-assistant', projectName: GEN, persona: 'G5 smoke agent' }, alice)
  check('generate succeeds for the builder', !!gen.project)
  const genDetail = await authedGet(`/project-detail?id=${GEN}`, alice)
  check('composed agent got its own project in the composer domain',
    genDetail.ok === true && genDetail.project?.domain === 'customer-support' &&
    (genDetail.project?.agents || []).includes(GEN))
  check('project is stamped with the real composer, not the backfill',
    genDetail.project?.createdBy === 'alice' &&
    (genDetail.project?.members || []).some(m => m.principal === 'alice'))

  // ---------- 7. agent pages keep working on top of the project layer ----------
  // R-016: assert against the composition section 6 just generated — the
  // backfilled examples live in gitignored domain-examples/generated/, so a
  // fresh clone has no 'supportdesk' composition to open.
  const agentDetail = await authedPost('/agent-detail', { project: GEN }, admin)
  check('agent detail page still answers through the project layer',
    agentDetail.project === GEN && !!agentDetail.runtime)

  // ---------- 8. deleting the composition prunes its project row ----------
  fs.rmSync(genDir, { recursive: true, force: true })
  const afterDelete = await authedGet('/projects', alice)
  check('a project whose only composition was deleted is pruned from the list',
    !(afterDelete.projects || []).some(p => p.id === GEN))
} finally {
  if (projSnap === null) fs.rmSync(projPath, { force: true })
  else fs.writeFileSync(projPath, projSnap)
  fs.rmSync(genDir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
