// G4 smoke: PII split / platform-only memory oversight (decision 5).
// The platform admin sees memory METADATA ONLY — content is structurally
// unreachable through the list endpoint (field whitelist, independent review R-004), and the
// only content path (/api/memory-extractions) requires the domain plane OR an
// approved, unexpired, purpose-bound memory grant (break-glass), with every
// platform break-glass read audit-logged with grant id + purpose.
// Adversarial fixture: out-of-pattern PII (SSN/passport) injected directly into
// the sim-memories store must never appear in ANY memory-surfacing response.
// Run: node e2e/smoke-pii-split.mjs   (expects console server on :4000)
import { readFileSync, writeFileSync } from 'node:fs'
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawGet = (p, token) =>
  fetch(BASE + '/api' + p, token ? { headers: { authorization: 'Bearer ' + token } } : {})

const admin = await apiLogin('melanie')
// G12: the admin's DEFAULT (all-domains) inventory is platform-account stores
// only — domain-team metadata appears inside that domain's view, so the
// inventory checks below use a second admin session scoped to customer-support.
const adminCS = await apiLogin('melanie', 'okta', 'customer-support')
const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support
const enduser = await apiLogin('enduser')

// Out-of-pattern PII the maskPII regexes do NOT catch — if the whitelist ever
// regresses to a blacklist, these leak and this smoke fails (independent review R-004).
const SSN = '899-01-2345'
const PASSPORT = 'passport K48291736'
const CANARY = 'pii-split-canary'
const PROBE = 'g18-regression-probe'      // independent review Round 4 supportdesk repro fixture
const ORPHAN = 'g18-orphan'         // resolves to NO domain — must fail closed

// Snapshot + restore the sim-memories store (smoke-domains pattern).
const memPath = new URL('../console/sim-memories.json', import.meta.url).pathname
const memSnap = readFileSync(memPath, 'utf8')

try {
  // Self-heal: drop any live admin grant from a crashed earlier run.
  await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, admin)

  // ---------- adversarial fixture: content-bearing fields in the raw store ----------
  const store = JSON.parse(memSnap)
  store.push({
    id: CANARY, name: 'piiSplitCanaryMemory', status: 'ACTIVE', simulated: true,
    domain: 'customer-support', agent: 'supportdesk', piiFlagged: true,
    eventExpiryDuration: 30, createdAt: '2026-08-01T00:00:00.000Z',
    strategies: [{ type: 'SEMANTIC', name: 'semantic_console', status: 'ACTIVE', namespaces: ['/'] }],
    // fields a naive spread would leak — none of these may survive the API
    text: `customer SSN ${SSN}`,
    records: [{ text: `traveler ${PASSPORT}` }],
    events: [{ payload: `raw event with SSN ${SSN}` }],
    extractions: [{ text: `semantic fact: ${PASSPORT}` }],
    notes: `${PASSPORT} and SSN ${SSN}`,
  })
  writeFileSync(memPath, JSON.stringify(store, null, 2))

  // ---------- 1. list endpoint: metadata whitelist, structurally content-free ----------
  const WHITELIST = new Set(['id', 'name', 'status', 'simulated', 'domain', 'agent',
    'attachedAgents', 'strategies', 'eventCount', 'recordCount', 'countsSimulated',
    'piiFlagged', 'eventExpiryDuration', 'retentionDays', 'createdAt', 'auditEvents', 'lastAudit'])
  // G12: domain-team metadata lives in that domain's view — the admin reads
  // the canary's row through a customer-support-scoped session.
  const adminList = await authedGet('/memories', adminCS)
  const canaryRow = (adminList.memories || []).find(m => m.id === CANARY)
  check('R-004 adversarial store entry appears in the admin inventory (fixture live)', !!canaryRow)
  // G18: null-domain (unattributed) rows are allowed governance metadata in the
  // admin inventory — what must never appear is a NAMED domain team's store.
  check('G12 admin DEFAULT (all-domains) inventory omits domain-team stores entirely',
    ((await authedGet('/memories', admin)).memories || []).every(m => m.domain === 'platform' || m.domain === 'shared' || m.domain == null))
  check('R-004 every memory row is the field WHITELIST exactly — injected content fields stripped',
    (adminList.memories || []).length >= 1 &&
    adminList.memories.every(m => Object.keys(m).every(k => WHITELIST.has(k))))
  check('R-004 out-of-pattern PII (SSN/passport) absent from the whole /api/memories response',
    !JSON.stringify(adminList).includes(SSN) && !JSON.stringify(adminList).includes('K48291736'))
  check('G4 inventory rows carry related-audit metadata fields (auditEvents count, lastAudit)',
    adminList.memories.every(m => typeof m.auditEvents === 'number' && 'lastAudit' in m))
  // Same projection guards every other memory-surfacing endpoint.
  const dd = await authedGet('/domain-detail?id=customer-support', admin)
  check('R-004 domain-detail memory rows leak no injected content either',
    (dd.memories || []).some(m => m.id === CANARY) &&
    !JSON.stringify(dd).includes(SSN) && !JSON.stringify(dd).includes('K48291736'))

  // ---------- 2. content path: platform admin is 403 by default, everywhere ----------
  check('admin -> domain-team memory content is 403 without a grant',
    (await rawGet('/memory-extractions?memoryId=' + CANARY, admin.token)).status === 403)
  check('admin -> unknown memory id is 403 (probe cannot enumerate content)',
    (await rawGet('/memory-extractions?memoryId=does-not-exist', admin.token)).status === 403)
  check('end user -> memory inventory is 403 (not an end-user surface)',
    (await rawGet('/memories', enduser.token)).status === 403)
  check('end user -> memory content is 403',
    (await rawGet('/memory-extractions?memoryId=' + CANARY, enduser.token)).status === 403)

  // ---------- 3. break-glass: purpose-bound grant -> audited read -> revoke re-locks ----------
  const PURPOSE = 'G4 smoke: verifying break-glass audit trail'
  const req = (await authedPost('/grant-request',
    { resourceType: 'memory', resourceId: CANARY, purpose: PURPOSE, durationS: 3600 }, admin)).request
  check('admin break-glass request routes to the OWNING domain queue', !!req && req.domain === 'customer-support')
  check('admin cannot decide grants (no decideAccessRequests capability) -> 403',
    (await fetch(BASE + '/api/grant-decide', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token }, body: JSON.stringify({ requestId: req.id, decision: 'approve' }) })).status === 403)
  await authedPost('/grant-decide', { requestId: req.id, decision: 'approve' }, carol)
  const granted = await authedGet('/memory-extractions?memoryId=' + CANARY, admin)
  check('approved grant unlocks content (masked) for the admin',
    granted.ok === true && granted.locked === false && (granted.extractions || []).length >= 1 &&
    granted.extractions.every(e => e.masked === true))
  check('unlocked content is DERIVED preview data — injected store fields still never surface',
    !JSON.stringify(granted).includes(SSN) && !JSON.stringify(granted).includes('K48291736'))
  const audit = (await authedGet('/obs-audit', admin)).events || []
  const bg = audit.find(e => e.action === 'break-glass-read' && e.memoryId === CANARY)
  check('break-glass read is audit-logged with grant id + purpose',
    !!bg && bg.who === 'melanie' && bg.requestId === req.id && bg.purpose === PURPOSE)
  check('break-glass audit is visible in the inventory row (lastAudit metadata)',
    ((await authedGet('/memories', adminCS)).memories.find(m => m.id === CANARY) || {}).auditEvents >= 1)
  await authedPost('/obs-access-revoke', { kind: 'memory', id: CANARY }, admin)
  check('revoking the grant re-locks the content path (403)',
    (await rawGet('/memory-extractions?memoryId=' + CANARY, admin.token)).status === 403)

  // ---------- 4. expiry: a lapsed grant denies in real time (R-003) ----------
  const short = (await authedPost('/grant-request',
    { resourceType: 'memory', resourceId: CANARY, purpose: 'G4 smoke: 1s expiry', durationS: 1 }, admin)).request
  await authedPost('/grant-decide', { requestId: short.id, decision: 'approve' }, carol)
  await new Promise(r => setTimeout(r, 1300))
  check('expired grant denies on the very next read (R-003)',
    (await rawGet('/memory-extractions?memoryId=' + CANARY, admin.token)).status === 403)

  // ---------- 5. domain plane unaffected: membership still reads own-domain content ----------
  check('builder (alice) still lists only her own domain inventory',
    ((await authedGet('/memories', alice)).memories || []).every(m => m.domain === 'customer-support' || m.domain === 'shared'))
  // TLP-B1 (spec §8 v2.1 A3): the lead's own-plane default is retired for
  // MEMORY — she is grant-gated like everyone; her request routes to a
  // platform peer (no self-approval loop). smoke-visibility-matrix covers the
  // full peer-approval round-trip.
  const carolRead = await authedGet('/memory-extractions?memoryId=' + CANARY, carol)
  check('owning-domain lead is LOCKED on her own plane too (TLP-B1: memory grant-gated all roles)',
    carolRead.ok === true && carolRead.locked === true && !carolRead.extractions)
  check('lead lock is NOT stamped break-glass (no read happened)',
    !((await authedGet('/obs-audit', admin)).events || []).some(e => e.action === 'break-glass-read' && e.who === 'carol'))

  // ---------- 6. G18 (independent review Round 4): no platform fallback on unresolved domains ----------
  // independent review's supportdesk repro: a store carrying NO explicit domain/agent stamp
  // whose deploy-style name prefixes a rostered domain agent. The old
  // `?? "platform"` fallback attributed it to the admin's own plane (content
  // readable with zero grant + zero break-glass audit) while the owning
  // domain's own lead got "not found". It must resolve to customer-support.
  const store2 = JSON.parse(readFileSync(memPath, 'utf8'))
  store2.push({
    id: PROBE, name: 'supportdesk_g18ProbeMemory', status: 'ACTIVE', simulated: true,
    eventExpiryDuration: 30, createdAt: '2026-08-02T00:00:00.000Z',
    strategies: [{ type: 'SEMANTIC', name: 'semantic_console', status: 'ACTIVE', namespaces: ['/'] }],
  }, {
    // and a store NOTHING resolves — must be domain:null (unattributed), never platform
    id: ORPHAN, name: 'g18OrphanMemory', status: 'ACTIVE', simulated: true,
    eventExpiryDuration: 30, createdAt: '2026-08-02T00:00:00.000Z',
    strategies: [{ type: 'SEMANTIC', name: 'semantic_console', status: 'ACTIVE', namespaces: ['/'] }],
  })
  writeFileSync(memPath, JSON.stringify(store2, null, 2))
  const probeRow = ((await authedGet('/memories', adminCS)).memories || []).find(m => m.id === PROBE)
  check('G18 independent review repro: unstamped supportdesk-prefixed store resolves to customer-support (roster fallback), not platform',
    !!probeRow && probeRow.domain === 'customer-support' && (probeRow.attachedAgents || []).includes('supportdesk'))
  check('G18 independent review repro: the owning domain lead (carol) CAN see her domain\'s store in her list',
    ((await authedGet('/memories', carol)).memories || []).some(m => m.id === PROBE))
  const carolProbe = await authedGet('/memory-extractions?memoryId=' + PROBE, carol)
  check('G18 independent review repro: carol sees the store as HERS — locked pending grant, not "not found" (TLP-B1 gate on top of G18 attribution)',
    carolProbe.ok === true && carolProbe.locked === true)
  check('G18 independent review repro: admin gets NO own-plane content read on it (403 — break-glass grant path only)',
    (await rawGet('/memory-extractions?memoryId=' + PROBE, admin.token)).status === 403)
  check('G18 independent review repro: admin default (all-domains) list omits it (domain-team store)',
    !((await authedGet('/memories', admin)).memories || []).some(m => m.id === PROBE))
  // Unattributed store: inventory metadata for the platform team, content
  // fail-closed for EVERYONE — no fallback plane, no lead to grant access.
  const adminDefault = (await authedGet('/memories', admin)).memories || []
  const orphanRow = adminDefault.find(m => m.id === ORPHAN)
  check('G18 orphan store surfaces in the admin inventory as domain:null metadata (governable, never "platform")',
    !!orphanRow && orphanRow.domain === null)
  check('G18 orphan content is fail-closed for the admin (403, no own-plane fallback)',
    (await rawGet('/memory-extractions?memoryId=' + ORPHAN, admin.token)).status === 403)
  check('G18 orphan grant request is denied (no owning lead exists to approve it)',
    (await fetch(BASE + '/api/grant-request', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token }, body: JSON.stringify({ resourceType: 'memory', resourceId: ORPHAN, purpose: 'G18 smoke: must be denied', durationS: 3600 }) })).status === 403)
  check('G18 orphan is invisible to domain-scoped sessions (list + 404 by id)',
    !((await authedGet('/memories', carol)).memories || []).some(m => m.id === ORPHAN) &&
    (await rawGet('/memory-extractions?memoryId=' + ORPHAN, carol.token)).status === 404)
  check('G18 zero audit bypass: no break-glass (or any memory-kind) audit event exists for the orphan',
    !((await authedGet('/obs-audit', admin)).events || []).some(e => e.memoryId === ORPHAN))
} finally {
  writeFileSync(memPath, memSnap)
  await authedPost('/obs-access-revoke', { kind: 'memory', id: CANARY }, admin)
  await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, admin)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
