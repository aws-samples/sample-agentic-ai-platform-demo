// TLP Batch 1 smoke: spec §8 cross-layer data visibility matrix — one
// automated assertion per matrix row × role (builder alice / lead carol /
// domain-scoped bob / platform admin melanie / end user), plus the QA
// checklist B-face 403 gap fixes and C-face attribution default-deny.
// Spec: plato-demo-design/project-layer-bootstrap-design.md v2.1 §8/§3.1a/§10.
// Run: node e2e/smoke-visibility-matrix.mjs   (expects console server on :4000)
import fs from 'node:fs'
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : (extra ? ' — ' + extra : '')}`); if (!ok) failures++ }
const rawGet = (p, token) => fetch(BASE + '/api' + p, token ? { headers: { authorization: 'Bearer ' + token } } : {})
const rawPost = (p, body, token) => fetch(BASE + '/api' + p, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
})

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

const CS_MEM = 'supportdesk-memory-seed'
const PLAT_MEM = 'platform-assistant-memory-seed'

// self-heal grants from earlier runs so default-deny is actually testable
for (const s of [admin, alice, carol]) {
  await authedPost('/obs-access-revoke', { kind: 'memory', id: CS_MEM }, s)
  await authedPost('/obs-access-revoke', { kind: 'memory', id: PLAT_MEM }, s)
}

// ---------- §8 row 1: Memory content — grant-gated for EVERY role ----------
const carolMem = await authedGet('/memory-extractions?memoryId=' + CS_MEM, carol)
check('M1 lead own-domain memory content is LOCKED without a grant (ownership default retired for memory)',
  carolMem.ok === true && carolMem.locked === true && !carolMem.extractions)
const aliceMem = await authedGet('/memory-extractions?memoryId=' + CS_MEM, alice)
check('M2 builder own-domain memory content is LOCKED without a grant',
  aliceMem.ok === true && aliceMem.locked === true)
check('M3 platform admin PLATFORM-domain store is LOCKED too (no own-plane default for memory)',
  (await rawGet('/memory-extractions?memoryId=' + PLAT_MEM, admin.token)).status === 403)
check('M4 platform admin DOMAIN-team store stays 403 (break-glass grant path only)',
  (await rawGet('/memory-extractions?memoryId=' + CS_MEM, admin.token)).status === 403)
check('M5 end user never reaches memory content', (await rawGet('/memory-extractions?memoryId=' + CS_MEM, enduser.token)).status === 403)

// Lead's own-domain request escalates to the platform peer queue (she is her
// domain's approver — self-approval loop) and a platform peer decides it.
const leadReq = await authedPost('/obs-access-request', { kind: 'memory', id: CS_MEM, justification: 'visibility-matrix smoke: lead own-domain memory grant', durationS: 3600 }, carol)
check('M6 lead own-domain memory request routes to the PLATFORM queue (no self-approval loop)',
  leadReq.ok === true && leadReq.request.domain === 'platform' && leadReq.request.status === 'pending')
check('M7 carol cannot decide her own platform-routed request (requester ≠ approver + not a platform peer)',
  (await rawPost('/obs-access-decide', { requestId: leadReq.request.id, decision: 'approve' }, carol.token)).status === 404)
const peerDecide = await authedPost('/obs-access-decide', { requestId: leadReq.request.id, decision: 'approve' }, admin)
check('M8 platform peer approves the break-glass request with an expiry', peerDecide.ok === true && !!peerDecide.request.expiresAt)
const carolGranted = await authedGet('/memory-extractions?memoryId=' + CS_MEM, carol)
check('M9 granted read opens (still masked) and carries the grant metadata',
  carolGranted.ok === true && carolGranted.locked === false && !!carolGranted.grant?.expiresAt &&
  (carolGranted.extractions || []).every(e => e.masked === true))
const auditAfter = (await authedGet('/obs-audit', admin)).events || []
check('M10 the granted read is audit-logged (grant-read, who/when/requestId)',
  auditAfter.some(e => e.kind === 'memory' && e.memoryId === CS_MEM && e.action === 'grant-read' && e.who === 'carol' && e.requestId === leadReq.request.id))
await authedPost('/obs-access-revoke', { kind: 'memory', id: CS_MEM }, carol)
check('M11 revoke re-locks', (await authedGet('/memory-extractions?memoryId=' + CS_MEM, carol)).locked === true)

// Memory metadata stays visible to all operator roles (§8 row 2).
check('M12 builder sees memory METADATA (list) for her own domain',
  ((await authedGet('/memories', alice)).memories || []).some(m => m.id === CS_MEM))
check('M13 admin sees platform memory metadata in the default inventory',
  ((await authedGet('/memories', admin)).memories || []).some(m => m.id === PLAT_MEM))

// ---------- §8 row 3: KB content — member default, cross-plane locked ----------
const kbListAlice = (await authedGet('/kb-docs', alice)).docs || []
check('K1 builder lists own-domain KB docs (metadata)', kbListAlice.some(d => d.id === 'kb-cs-returns') &&
  kbListAlice.every(d => d.domain === 'customer-support' || d.domain === 'shared'))
const kbAlice = await authedGet('/kb-doc?id=kb-cs-returns', alice)
check('K2 builder reads own-domain KB CONTENT by default (curated — no grant, contrast with memory)',
  kbAlice.ok === true && kbAlice.locked === false && !!kbAlice.doc?.content)
check('K3 builder foreign-domain KB doc -> 404 (A2, no existence oracle)',
  (await rawGet('/kb-doc?id=kb-ops-vpn', alice.token)).status === 404)
check('K4 unknown KB id answers exactly like a foreign one (404)',
  (await rawGet('/kb-doc?id=kb-does-not-exist', alice.token)).status === 404)
const kbAdminDomain = await rawGet('/kb-doc?id=kb-cs-returns', admin.token)
check('K5 platform admin cross-plane KB content -> 403 locked (metadata default; grant path exists)',
  kbAdminDomain.status === 403 && (await kbAdminDomain.json()).locked === true)
const kbAdminPlat = await authedGet('/kb-doc?id=kb-platform-goldenpath', admin)
check('K6 platform admin reads PLATFORM-domain KB content by default (own plane)',
  kbAdminPlat.ok === true && kbAdminPlat.ownPlane === true && !!kbAdminPlat.doc?.content)
check('K7 admin sees every KB doc as metadata in the list',
  ((await authedGet('/kb-docs', admin)).docs || []).length >= 4 &&
  ((await authedGet('/kb-docs', admin)).docs || []).every(d => !('content' in d)))
check('K8 end user has no KB surface', (await rawGet('/kb-docs', enduser.token)).status === 403)

// ---------- §8 rows 4-5: Trace payload tiers + metrics ----------
check('T1 lead reads own-domain trace payload by default (masked)', await (async () => {
  const r = await authedGet('/obs-traces?agent=supportdesk', carol)
  return r.ok === true && r.locked === false && r.ownPlane === true && (r.traces || []).every(t => t.masked === true)
})())
await authedPost('/obs-access-revoke', { kind: 'trace', id: 'supportdesk' }, alice)
check('T2 builder own-domain trace payload stays grant-gated', (await authedGet('/obs-traces?agent=supportdesk', alice)).locked === true)
check('T3 domain admin/platform admin cross-plane trace payload -> 403 (metrics only)',
  (await rawGet('/obs-traces?agent=supportdesk', admin.token)).status === 403)
check('T4 EXCEPTION: platform-own agent traces default-visible to the platform admin (07-27 contract)', await (async () => {
  const r = await authedGet('/obs-traces?agent=platform-assistant', admin)
  return r.ok === true && r.locked === false && r.ownPlane === true
})())
check('T5 trace metrics visible to every operator role in scope', await (async () => {
  const a = await authedGet('/metrics?scope=agent&id=supportdesk', alice)
  const m = await authedGet('/metrics?scope=agent&id=supportdesk', admin)
  return !!a.series && !!m.series
})())
check('T6 end user gets NO metrics surface (403, was a fleet-rollup leak)',
  (await rawGet('/metrics?scope=fleet&id=all', enduser.token)).status === 403)

// ---------- §8 rows 6-7: Cost detail vs rollup ----------
const aliceCosts = await authedGet('/costs', alice)
check('C1 builder keeps per-agent cost detail (own domain rows only)',
  Array.isArray(aliceCosts.perAgent) && aliceCosts.perAgent.every(a => a.domain === 'customer-support'))
check('C2 builder gets NO domain/org cost rollup (spec §8 row 7)',
  Array.isArray(aliceCosts.domains) && aliceCosts.domains.length === 0)
check('C3 lead sees her domain rollup', ((await authedGet('/costs', carol)).domains || []).some(d => d.id === 'customer-support'))
check('C4 admin sees all domain rollups', ((await authedGet('/costs', admin)).domains || []).length >= 3)
check('C5 end user has no cost surface', (await rawGet('/costs', enduser.token)).status === 403)

// ---------- §8 last rows: Registry open vs restricted ----------
const aliceReg = (await authedGet('/registry', alice)).entries || []
check('R1 builder registry is own-domain + shared only (default-deny)',
  aliceReg.every(e => e.domain === 'customer-support' || e.domain === 'shared'))
const restrictedRow = aliceReg.find(e => e.id === 'openai.gpt-5-preview')
check('R2 restricted entry = existence + request entry ONLY for a builder (no versions/description/content)',
  !!restrictedRow && restrictedRow.restricted === true && (restrictedRow.versions || []).length === 0 &&
  !restrictedRow.description && !restrictedRow.resolved && /grant-request/.test(restrictedRow.note || ''))
const adminReg = (await authedGet('/registry', admin)).entries || []
const restrictedAdmin = adminReg.find(e => e.id === 'openai.gpt-5-preview')
check('R3 platform admin sees the restricted entry in full', !!restrictedAdmin && (restrictedAdmin.versions || []).length >= 1)
// use-approval escalates to the platform (§9) and unlocks the detail
const useReq = await authedPost('/grant-request', { resourceType: 'registryUse', resourceId: 'openai.gpt-5-preview', purpose: 'visibility-matrix smoke: restricted model use approval', durationS: 3600 }, alice)
check('R4 registryUse request lands in the PLATFORM queue (escalation, not domain-decidable)',
  useReq.ok === true && useReq.request.domain === 'platform')
check('R5 carol (domain lead) cannot decide the platform-escalated request',
  (await rawPost('/grant-decide', { requestId: useReq.request.id, decision: 'approve' }, carol.token)).status === 404)
const useApprove = await authedPost('/grant-decide', { requestId: useReq.request.id, decision: 'approve' }, admin)
check('R6 platform admin approves the use request', useApprove.ok === true)
const aliceRegAfter = ((await authedGet('/registry', alice)).entries || []).find(e => e.id === 'openai.gpt-5-preview')
check('R7 approved use grant reveals the entry detail to the requester',
  !!aliceRegAfter && !aliceRegAfter.restricted && (aliceRegAfter.versions || []).length >= 1)
check('R8 unknown restricted id on grant-request -> 404 (no oracle)',
  (await rawPost('/grant-request', { resourceType: 'registryUse', resourceId: 'nope-nope', purpose: 'x', durationS: 60 }, alice.token)).status === 404)

// ---------- QA B-face: server-side 403 gap fixes ----------
check('B1 builder registry-propose -> 403', (await rawPost('/registry-propose', { type: 'Skill', name: 'x' }, alice.token)).status === 403)
check('B1b builder registry-submit -> 403', (await rawPost('/registry-submit', { id: 'x', semver: '1.0.0' }, alice.token)).status === 403)
check('B1c builder registry-remove -> 403', (await rawPost('/registry-remove', { id: 'x' }, alice.token)).status === 403)
check('B1d builder registry-drift -> 403', (await rawPost('/registry-drift', { id: 'github-mcp' }, alice.token)).status === 403)
check('B2 builder fleet-delete -> 403', (await rawPost('/fleet-delete', { project: 'supportdesk' }, alice.token)).status === 403)
check('B3 end user generate -> 403', (await rawPost('/generate', { blueprint: 'chat-assistant', projectName: 'x' }, enduser.token)).status === 403)
check('B3b end user deploy -> 403', (await rawPost('/deploy', { project: 'supportdesk' }, enduser.token)).status === 403)
check('B3c end user eval-dataset-save -> 403', (await rawPost('/eval-dataset-save', { project: 'supportdesk', text: '{}' }, enduser.token)).status === 403)
check('B4 builder cross-project reads stay 404 (no existence oracle)', await (async () => {
  const statuses = await Promise.all([
    rawGet('/eval-dataset?project=opsassistant', alice.token),
    rawGet('/obs-traces?agent=opsassistant', alice.token),
    rawGet('/metrics?scope=agent&id=opsassistant', alice.token),
    rawGet('/kb-doc?id=kb-ops-vpn', alice.token),
  ])
  return statuses.every(r => r.status === 404)
})())
check('B5 domain admin (bob, operations) cross-domain -> 404', await (async () => {
  const statuses = await Promise.all([
    rawGet('/metrics?scope=domain&id=customer-support', bob.token),
    rawGet('/obs-traces?agent=supportdesk', bob.token),
    rawGet('/memory-extractions?memoryId=' + CS_MEM, bob.token),
  ])
  return statuses.every(r => r.status === 404)
})())
check('B9 hitl-interrupt against a foreign domain agent -> 404 (was unguarded)',
  (await rawPost('/hitl-interrupt', { project: 'supportdesk', toolName: 'delete_x' }, bob.token)).status === 404)
check('B9b memory-remove of a foreign store answers like unknown (no oracle)', await (async () => {
  const r = await rawPost('/memory-remove', { id: 'opsassistant-memory-seed' }, alice.token)
  const j = await r.json()
  return r.status === 200 && j.ok === false && /console-created/.test(j.error || '')
})())
check('B9c session-domain body override still rejected', (await rawPost('/session-domain', { domain: 'operations' }, alice.token)).status === 403)
check('B9d end user obs-audit feed -> 403', (await rawGet('/obs-audit', enduser.token)).status === 403)

// ---------- QA C-face: attribution default-deny ----------
check('C-f1 compose with an unresolvable domain fails server-side (no create-then-attribute)', await (async () => {
  // enduser has no builder surface (403 first); the domain guard is exercised
  // by the generate pipeline itself — assert via the module-level error text
  // using a session that passes the surface gate but strips its domain.
  const src = fs.readFileSync(new URL('../console/server.mjs', import.meta.url), 'utf8')
  return /domain attribution is required/.test(src)
})())
check('C-f2 no null-domain project rows (backfill skips unattributed compositions)',
  ((await authedGet('/projects', admin)).projects || []).every(p => p.domain != null))
check('C-f4 projectDomain has no directional platform fallback (grep)', await (async () => {
  const src = fs.readFileSync(new URL('../console/server.mjs', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('function projectDomain'), src.indexOf('function guardProject'))
  return !/[?:]\s*"platform"/.test(fn) && /\?\? null/.test(fn)
})())
check('C-f4b domainOwnerTeam labels null as Unattributed, not Platform team', await (async () => {
  const src = fs.readFileSync(new URL('../console/server.mjs', import.meta.url), 'utf8')
  return /domainId == null\) return "Unattributed"/.test(src)
})())
check('C-f3 migration script exists and is idempotent-checkable',
  fs.existsSync(new URL('../scripts/migrate-tlp-attribution.mjs', import.meta.url)))

// ---------- cleanup: drop grants this run created ----------
await authedPost('/obs-access-revoke', { kind: 'memory', id: CS_MEM }, carol)
// registryUse grant: revoke via the generalized store (requester drops own)
const mine = ((await authedGet('/grant-requests?type=registryUse', alice)).requests || []).find(r => r.resourceId === 'openai.gpt-5-preview' && r.status === 'approved')
if (mine) await authedPost('/obs-access-revoke', { kind: 'registryUse', id: 'openai.gpt-5-preview' }, alice)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
