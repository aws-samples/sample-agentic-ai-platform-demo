// L4 round-2 smoke: segregation-audit fixes (P0-1 eval-dataset triple gate,
// P0-2/P1-1 HITL metadata-vs-content split, P1-2 memory single content path,
// P2-1 usage-ledger regression guard). Implements audit §4 assertions
// #1-#10, #14, #15, #16 (persona + request + expected).
// L4 round-3 (2026-07-27) adds §4.5: #17 default-deny domain scoping (the
// null-domain leak regression) + #18/#19/#20 ownership-plane content defaults.
// Run: node e2e/smoke-segregation.mjs   (expects console server on :4000)
import fs, { readFileSync } from 'node:fs'
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawGet = (p, token) =>
  fetch(BASE + '/api' + p, token ? { headers: { authorization: 'Bearer ' + token } } : {})

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')
const bob = await apiLogin('bob')
const carol = await apiLogin('carol')

// PII forms the masking regexes catch (emails / phones / order ids) — a raw
// leak of any of these in a platform response is the failure this suite hunts.
const PII_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|#\d{3,6}\b|\bREQ-\d{3,6}\b|\b\d{3}-\d{2}-\d{4}\b/
// R-016 follow-up: 'supportdesk' is a gitignored backfilled example and is
// absent on a fresh clone. Self-sufficient pattern (same as smoke-projects/
// smoke-domain-project): generate the customer-support composition this
// suite needs via /api/generate instead of assuming it pre-exists on disk.
const PROJECT = 'g14segsmoke'
const genDir = new URL(`../domain-examples/generated/${PROJECT}/`, import.meta.url).pathname
const gen = await authedPost('/generate', { blueprint: 'chat-assistant', projectName: PROJECT, persona: 'Seg smoke' }, alice)
if (!gen.project) throw new Error('setup: failed to generate the seg-smoke composition: ' + JSON.stringify(gen))

// Self-heal from crashed earlier runs: drop any live dataset grant so
// default-deny is testable, and remove stale smoke approval policies.
await authedPost('/obs-access-revoke', { kind: 'dataset', id: PROJECT }, admin)
for (const p of ((await authedGet('/hitl', admin)).policies || []).filter(p => p.name.startsWith('SegSmokePolicy'))) {
  await authedPost('/hitl-policy-remove', { id: p.id }, admin)
}

try {
  // ---------- §4.1 Eval datasets (P0-1) ----------
  // #6 first: alice (own-domain builder) uploads a dataset containing PII…
  const piiRow = { scenario_id: 'seg-pii', turns: [{ input: 'Customer jane.doe@example.com (SSN 123-45-6789) is asking about order #48213' }], assertions: ['handled'] }
  const save = await authedPost('/eval-dataset-save', { project: PROJECT, text: JSON.stringify(piiRow) }, alice)
  check('#6a builder uploads a PII-bearing golden dataset (own domain, unchanged)', save.ok === true && save.count === 1)

  // #1 admin default read = masked scenarios
  const adminDs = await authedGet(`/eval-dataset?project=${PROJECT}`, admin)
  const adminRow = (adminDs.scenarios || []).find(s => s.id === 'seg-pii')
  check('#1 admin sees scenarios[].input PII-masked (masked:true, placeholders present)',
    adminDs.masked === true && !!adminRow && !PII_RE.test(adminRow.input) && adminRow.input.includes('<EMAIL>') && adminRow.input.includes('<ORDER_ID>') && adminRow.input.includes('<SSN>'))
  check('#6b the just-uploaded email is masked for the admin (no grant yet)', !adminRow.input.includes('jane.doe@example.com'))
  check('#6c the just-uploaded SSN is masked for the admin (no grant yet)', !adminRow.input.includes('123-45-6789'))

  // #2 admin reveal without a grant = locked, no raw text
  const lockedRes = await rawGet(`/eval-dataset?project=${PROJECT}&reveal=true`, admin.token)
  const lockedBody = await lockedRes.json()
  check('#2 admin reveal without grant -> 403 locked:true, guidance, no scenario text',
    lockedRes.status === 403 && lockedBody.locked === true && /access-request|obs-access-request/i.test(lockedBody.error || '') && !lockedBody.scenarios)

  // #3 own-domain lead reads raw text (domain plane, no elevate)
  const carolDs = await authedGet(`/eval-dataset?project=${PROJECT}`, carol)
  check('#3 carol (own-domain lead) reads raw scenario text, no masked flag',
    carolDs.masked === undefined && (carolDs.scenarios || []).some(s => s.input.includes('jane.doe@example.com')))

  // #4 cross-domain builder: guardProject behavior unchanged. (The audit sheet
  // says 403; the platform's standing A2 contract is 404 — foreign-domain
  // resources do not exist for the session. Asserting the unchanged contract.)
  check('#4 bob (operations builder) -> supportdesk dataset -> 404 (A2, unchanged)',
    (await rawGet(`/eval-dataset?project=${PROJECT}`, bob.token)).status === 404)

  // #5 access-request -> owning-domain lead approves -> reveal raw + audited
  const dsReq = await authedPost('/obs-access-request', { kind: 'dataset', id: PROJECT, justification: 'Seg smoke: verify raw golden scenarios after domain-owner approval', durationS: 3600 }, admin)
  check('#5a admin dataset access request routes to the owning domain',
    dsReq.ok === true && dsReq.request.status === 'pending' && dsReq.request.domain === 'customer-support')
  check('#5b admin still locked while pending',
    (await rawGet(`/eval-dataset?project=${PROJECT}&reveal=true`, admin.token)).status === 403)
  const dsApprove = await authedPost('/obs-access-decide', { requestId: dsReq.request.id, decision: 'approve' }, carol)
  check('#5c owning-domain lead approves with an expiry', dsApprove.ok === true && !!dsApprove.request.expiresAt)
  const revealRes = await rawGet(`/eval-dataset?project=${PROJECT}&reveal=true`, admin.token)
  const revealBody = await revealRes.json()
  check('#5d granted reveal returns raw scenario text + grant metadata',
    revealRes.status === 200 && revealBody.locked === false && !!revealBody.grant?.expiresAt &&
    (revealBody.scenarios || []).some(s => s.input.includes('jane.doe@example.com')))
  const audit = (await authedGet('/obs-audit', admin)).events
  check('#5e dataset request/approval/reveal all land in the obs audit trail',
    audit.some(e => e.action === 'access-requested' && e.requestId === dsReq.request.id) &&
    audit.some(e => e.action === 'access-approved' && e.requestId === dsReq.request.id) &&
    audit.some(e => e.kind === 'dataset' && e.action === 'reveal' && e.who === 'melanie' && e.project === PROJECT))
  await authedPost('/obs-access-revoke', { kind: 'dataset', id: PROJECT }, admin)
  check('#5f revoke re-locks the reveal path',
    (await rawGet(`/eval-dataset?project=${PROJECT}&reveal=true`, admin.token)).status === 403)

  // ---------- §4.2 HITL audit (P0-2 / P1-1) ----------
  // Seed one interrupt whose tool input carries PII (policy matched, then decided).
  const polName = 'SegSmokePolicy' + Date.now().toString(36)
  const toolName = 'seg_smoke_notify_' + Date.now().toString(36)
  const pol = await authedPost('/hitl-policy-create', { name: polName, toolMatch: 'seg_smoke_*' }, admin)
  check('HITL fixture: policy created', pol.ok === true)
  const intr = await authedPost('/hitl-interrupt', { project: PROJECT, toolName, toolInput: '{"to":"jane.doe@example.com","order":"#48213"}' }, alice)
  check('HITL fixture: interrupt matched and parked', intr.ok === true && intr.matched === true)
  const decide = await authedPost('/hitl-decide', { requestId: intr.request.requestId, decision: 'approved' }, admin)
  check('HITL fixture: admin decision succeeds and echoes a MASKED record',
    decide.ok === true && !PII_RE.test(decide.request.toolInputSummary || ''))

  // #7 admin list: metadata visible, toolInputSummary masked on every record
  const adminHitl = await authedGet('/hitl-audit', admin)
  const segRec = adminHitl.records.find(r => r.toolName === toolName)
  check('#7a admin hitl-audit keeps approval metadata (policy/status/decidedBy)',
    !!segRec && segRec.policyName === polName && segRec.status === 'approved' && segRec.decidedBy === 'melanie')
  check('#7b admin hitl-audit masks toolInputSummary on every record (placeholders, no raw PII)',
    adminHitl.records.every(r => !r.toolInputSummary || !PII_RE.test(r.toolInputSummary)) &&
    segRec.toolInputSummary.includes('<EMAIL>') && segRec.toolInputSummary.includes('<ORDER_ID>'))

  // #8 own-domain lead sees the raw summary
  const carolHitl = await authedGet(`/hitl-audit?agent=${PROJECT}`, carol)
  const carolRec = carolHitl.records.find(r => r.toolName === toolName)
  check('#8 carol (own-domain lead) sees the raw toolInputSummary',
    !!carolRec && carolRec.toolInputSummary.includes('jane.doe@example.com'))

  // #9 cross-domain builder with explicit agent -> guardProject (A2, unchanged)
  check('#9 bob -> hitl-audit?agent=supportdesk -> 404 (A2, unchanged)',
    (await rawGet(`/hitl-audit?agent=${PROJECT}`, bob.token)).status === 404)

  // #10 metadata layer stays platform-wide: admin total == full store count
  // (SIEM export streams the whole hitl store, so its governance count is the
  // full hitlAudit() length — the domain filter must not bite for the admin).
  const exp = await authedGet('/integrations-audit-export', admin)
  const govCount = exp.events.filter(e => e.stream === 'governance').length
  const adminHitlAll = await authedGet('/hitl-audit', admin)
  check(`#10 admin hitl-audit total (${adminHitlAll.total}) equals full store count (${govCount}) — metadata unrestricted, content masked`,
    adminHitlAll.total === govCount)
  check('#10b SIEM export governance stream is masked too',
    exp.events.filter(e => e.stream === 'governance').every(e => !e.toolInputSummary || !PII_RE.test(e.toolInputSummary)))

  // ---------- §4.3 Memory single content path (P1-2 / #14) ----------
  // Long- AND short-term memory content share ONE read path: /api/memory-extractions
  // (triple-gated). The list endpoint must expose numbers only — if a "events"/
  // "records" content array ever appears there, short-term content has leaked
  // around the gate.
  const adminMems = (await authedGet('/memories', admin)).memories
  check('#14a /api/memories exposes event/record COUNTS only, never content arrays or text',
    adminMems.length >= 1 && adminMems.every(m =>
      typeof m.eventCount === 'number' && !('events' in m) && !('records' in m) && !('extractions' in m) && !('text' in m)))
  // Ownership-plane defaults: a DOMAIN-team store stays 403 for the admin.
  // G12: domain stores no longer appear in the admin's default list, so the
  // check targets the seeded customer-support store by id (content path unchanged).
  check('#14b admin DOMAIN-team memory content path stays 403 by default (same gate short- and long-term)',
    (await rawGet('/memory-extractions?memoryId=supportdesk-memory-seed', admin.token)).status === 403)

  // ---------- §4.4 Usage ledger / costs (P2-1 / #15 / #16) ----------
  const bobCosts = await authedGet('/costs', bob)
  const perAgentTokens = bobCosts.perAgent.reduce((s, a) => s + a.inputTokens + a.outputTokens, 0)
  const perAgentCost = +bobCosts.perAgent.reduce((s, a) => s + a.costUsd, 0).toFixed(6)
  check('#15a bob /api/costs perAgent contains only operations-domain agents',
    bobCosts.perAgent.every(a => a.domain === 'operations'))
  check('#15b bob totals reconcile with the filtered perAgent rows (no cross-domain aggregate leak)',
    bobCosts.totalTokens === perAgentTokens && bobCosts.totalCostUsd === perAgentCost)
  check('#15c cost rows are aggregates — no per-record user/timestamp fields',
    bobCosts.perAgent.every(a => !('user' in a) && !('ts' in a)))

  // #16 static regression guard: no GET endpoint returns the raw usageLedger()
  // array. Every usageLedger() call site must be internal (never fed to json()).
  const src = readFileSync(new URL('../console/server.mjs', import.meta.url), 'utf8')
  const ledgerLines = src.split('\n').filter(l => l.includes('usageLedger()'))
  check(`#16 no code path hands usageLedger() to a response (${ledgerLines.length} internal call sites)`,
    ledgerLines.length >= 1 && ledgerLines.every(l => !l.includes('json(')) && !/json\([^)]*usageLedger/.test(src))

  // ---------- §4.5 default-deny scoping + ownership-plane defaults (2026-07-27) ----------
  // Root-cause regression (Part A): domain=null used to read as "shared", so a
  // builder saw nearly the whole account's memory inventory. Now every resource
  // carries an explicit domain and default-deny means: own domain + "shared"
  // pass, ANYTHING else (incl. null/unknown) is invisible to domain-scoped roles.
  const aliceMemsDD = (await authedGet('/memories', alice)).memories
  check('#17a alice /api/memories returns ONLY customer-support + shared stores (no null-domain leak)',
    aliceMemsDD.length >= 1 && aliceMemsDD.every(m => m.domain === 'customer-support' || m.domain === 'shared'))
  // G18 (independent review Round 4) superseded the old #17b "none null" invariant: null no
  // longer falls back to "platform" (that fallback was the admin content
  // backdoor). Unattributed stores may exist as admin-inventory METADATA, but
  // their content is fail-closed for EVERYONE — admin included, no grant path.
  const adminMemsDD = (await authedGet('/memories', admin)).memories
  const nullMemsDD = adminMemsDD.filter(m => m.domain == null)
  if (nullMemsDD.length) {
    const nullReads = await Promise.all(nullMemsDD.map(m =>
      rawGet('/memory-extractions?memoryId=' + encodeURIComponent(m.id), admin.token)))
    check(`#17b unattributed (null-domain) stores are content-fail-closed even for admin (${nullMemsDD.length} store(s) -> 403)`,
      nullReads.every(r => r.status === 403))
  } else {
    check('#17b no unattributed store present (every domain stamped) — fail-closed rule not exercised here, covered by smoke-pii-split G18 probes', true)
  }
  const aliceRegDD = (await authedGet('/registry', alice)).entries
  check('#17c alice registry is own-domain + explicitly-shared only (default-deny)',
    aliceRegDD.every(e => e.domain === 'customer-support' || e.domain === 'shared'))
  const carolMemsDD = (await authedGet('/memories', carol)).memories
  check('#17d carol (lead) scoped identically to a same-domain builder on the list',
    carolMemsDD.every(m => m.domain === 'customer-support' || m.domain === 'shared'))
  // Platform-domain stores are invisible to domain-scoped roles even by ID (A2).
  const platMem = adminMemsDD.find(m => m.domain === 'platform')
  if (platMem) check('#17e alice -> platform-domain memory by ID -> 404 (A2, default-deny)',
    (await rawGet('/memory-extractions?memoryId=' + encodeURIComponent(platMem.id), alice.token)).status === 404)
  else console.log('SKIP  #17e (no platform-domain memory store)')

  // Ownership-plane defaults (Part B): own-plane content is open by default —
  // masked, no grant; cross-plane keeps request -> owner approval -> grant.
  // Admin ↔ Platform domain (the platform team's own data plane):
  const adminPlatTr = await authedGet('/obs-traces?agent=platform-assistant', admin)
  check('#18a admin -> platform-assistant traces 200 by DEFAULT (own plane, no grant)',
    adminPlatTr.ok === true && adminPlatTr.locked === false && adminPlatTr.ownPlane === true && !adminPlatTr.grant)
  check('#18b admin default platform traces are still maskPII\'d (no raw PII)',
    (adminPlatTr.traces || []).length >= 1 && adminPlatTr.traces.every(t => t.masked === true && !PII_RE.test(t.input + ' ' + t.output)))
  check('#18c admin -> DOMAIN-team agent traces stay 403 (cross-plane, metadata only)',
    (await rawGet('/obs-traces?agent=' + PROJECT, admin.token)).status === 403)
  if (platMem) {
    // TLP-B1 (spec §8 v2.1 A3): memory content is grant-gated for EVERY role —
    // the platform-own-plane default is retired for memory (traces keep it).
    check('#18d admin -> platform-domain memory extractions LOCKED without a grant (TLP-B1: memory grant-gated all roles)',
      (await rawGet('/memory-extractions?memoryId=' + encodeURIComponent(platMem.id), admin.token)).status === 403)
  } else console.log('SKIP  #18d (no platform-domain memory store)')
  await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, admin) // self-heal stale grants
  check('#18e admin -> domain-team memory extractions stay 403 without a grant',
    (await rawGet('/memory-extractions?memoryId=supportdesk-memory-seed', admin.token)).status === 403)
  // Lead ↔ her own domain (she is the approver — no self-approval loop):
  const carolTr = await authedGet('/obs-traces?agent=' + PROJECT, carol)
  check('#19a carol (lead) -> own-domain traces 200 by DEFAULT (own plane, masked, no grant)',
    carolTr.ok === true && carolTr.locked === false && carolTr.ownPlane === true && !carolTr.grant &&
    carolTr.traces.every(t => t.masked === true))
  check('#19b carol -> other-domain traces -> 404 (A2, unchanged)',
    (await rawGet('/obs-traces?agent=opsassistant', carol.token)).status === 404)
  await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, carol)
  const carolMemOwn = await authedGet('/memory-extractions?memoryId=supportdesk-memory-seed', carol)
  check('#19c carol -> own-domain memory extractions LOCKED without a grant (TLP-B1: memory grant-gated all roles, lead requests route to a platform peer)',
    carolMemOwn.ok === true && carolMemOwn.locked === true && !carolMemOwn.extractions)
  // Builders: unchanged — request -> lead approval, even in their own domain.
  await authedPost('/obs-access-revoke', { kind: 'trace', id: PROJECT }, alice)
  const aliceTr = await authedGet('/obs-traces?agent=' + PROJECT, alice)
  check('#20a alice (builder) own-domain traces still LOCKED without a lead-approved grant',
    aliceTr.ok === true && aliceTr.locked === true && !aliceTr.traces)
  await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, alice)
  const aliceMemOwn = await authedGet('/memory-extractions?memoryId=supportdesk-memory-seed', alice)
  check('#20b alice own-domain memory extractions still LOCKED without a grant',
    aliceMemOwn.ok === true && aliceMemOwn.locked === true && !aliceMemOwn.extractions)

  // ---------- cleanup: remove the smoke policy ----------
  await authedPost('/hitl-policy-remove', { id: pol.policy.id }, admin)
} finally {
  // R-016 follow-up: the composition was generated fresh for this run, so
  // cleanup is deleting it (no snapshot/restore needed, unlike the old
  // pre-existing-project pattern).
  fs.rmSync(genDir, { recursive: true, force: true })
  await authedPost('/obs-access-revoke', { kind: 'dataset', id: PROJECT }, admin)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
