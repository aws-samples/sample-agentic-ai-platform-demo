// independent review Round 5 adversarial probes — G4 PII split / metadata whitelist (R-004).
// Angle: the whitelist protects memory ROWS, but PII can ride in on USER-SUPPLIED
// free text (grant purpose, project names) and surface on OTHER governance
// surfaces (audit-trail detail, inbox purpose, project-detail) unmasked.
import { apiLogin, apiSwitchDomain, authedGet, authedPost } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}
// Independent PII scanners (never trust the product's own pattern list).
const SCAN = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/],
  ['PHONE', /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/],
  // R-B3-01 floor (independent review 2026-08-08): international phone (+61 AU shape leaked
  // pre-fix) and 8-char passports (letter + 7 digits leaked pre-fix). These
  // two are the new lower bound — the product's PII_PATTERNS must never be
  // narrowed below what this scanner catches.
  ['INTL_PHONE', /\+\d{1,3}[-.\s]?\d{1,4}(?:[-.\s]?\d{2,4}){2,3}/],
  ['PASSPORT', /\b[A-Z]\d{7,8}\b/],
  ['IBAN', /\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b/],
  ['CARD', /\b(?:\d[ -]?){13,16}\b/],
]
const scan = s => SCAN.filter(([, re]) => re.test(String(s || ''))).map(([n]) => n)

// PII deliberately embedded in USER-SUPPLIED free text.
const DIRTY = 'contact jane.doe@acme.com ssn 123-45-6789 passport X12345678 card 4111 1111 1111 1111'

const alice = await apiLogin('alice')
const carol = await apiLogin('carol')
const admin = await apiLogin('melanie')

// ---- P1: grant `purpose` is user free text — where does it resurface? -----
const rq = await authedPost('/grant-request',
  { resourceType: 'trace', resourceId: 'supportdesk', purpose: `independent review R5 ${DIRTY}`, durationS: 120 }, alice)
check('P1.1 request with PII-bearing purpose accepted (input not rejected)', rq.ok === true,
  `err=${(rq.error || '').slice(0, 50)}`)

// (a) the inbox — lead + admin both read purposes here
for (const [who, s] of [['lead', carol], ['admin', admin]]) {
  const r = await authedGet('/grant-requests', s)
  const row = (r.requests || []).find(x => x.id === rq.request?.id)
  const hits = row ? scan(row.purpose) : []
  check(`P1.2 inbox purpose as seen by ${who}: PII masked`, row != null && hits.length === 0,
    row ? `leaks=${hits.join(',') || 'none'}` : 'row not visible')
}

// (b) the unified audit trail `detail` field (G9 projection)
for (const [who, s] of [['lead', carol], ['admin', admin]]) {
  const a = await authedGet('/audit-trail', s)
  const rows = (a.events || []).filter(e => e.requestId === rq.request?.id)
  const hits = [...new Set(rows.flatMap(e => scan(e.detail)))]
  check(`P1.3 audit-trail detail as seen by ${who}: PII masked`, rows.length > 0 && hits.length === 0,
    `rows=${rows.length} leaks=${hits.join(',') || 'none'}`)
}

// ---- P2: full-response sweep — no PII anywhere in governance JSON --------
// NOTE on scope: the ACCESS stream (grants) must be PII-free for EVERY reader
// (R-014). The GOVERNANCE stream (HITL interrupts) is different by design —
// `toolInputSummary` is domain CONTENT, and a domain-plane session legitimately
// reads its OWN domain's raw summaries (server.mjs maskHitlRecord); only
// non-domain-plane sessions (platform admin) get it masked. So the lead's trail
// is swept on the access stream + cross-domain rows only. Verified 2026-08-05:
// admin sees 0 raw-email governance rows, carol sees 9 — all her own domain.
const sweepTrail = (r, { allowOwnDomainGovernance = null } = {}) => {
  const rows = (r.events || []).filter(e =>
    !(allowOwnDomainGovernance && e.stream === 'governance' && e.domain === allowOwnDomainGovernance))
  return scan(JSON.stringify(rows))
}
for (const [name, p, s, opts] of [
  ['grant-requests(admin)', '/grant-requests', admin, null],
  ['memories(admin)', '/memories', admin, null],
  ['projects(admin)', '/projects', admin, null],
]) {
  const r = await authedGet(p, s)
  const hits = scan(JSON.stringify(r))
  check(`P2 ${name}: whole-response PII sweep clean`, hits.length === 0, `leaks=${hits.join(',') || 'none'}`)
}
{
  const a = await authedGet('/audit-trail', admin)
  check('P2 audit-trail(admin): whole-response PII sweep clean',
    sweepTrail(a).length === 0, `leaks=${sweepTrail(a).join(',') || 'none'}`)
  const c = await authedGet('/audit-trail', carol)
  const h = sweepTrail(c, { allowOwnDomainGovernance: 'customer-support' })
  check('P2 audit-trail(lead): access stream + cross-domain rows PII-free',
    h.length === 0, `leaks=${h.join(',') || 'none'}`)
  // and the platform admin must NOT see raw HITL content even in her own trail
  const adminGovLeaks = (a.events || [])
    .filter(e => e.stream === 'governance' && scan(e.detail).length > 0)
  check('P2 audit-trail(admin): governance-stream content is masked for the platform plane',
    adminGovLeaks.length === 0, `rows=${adminGovLeaks.length}`)
}

// ---- P3: memory metadata whitelist holds against a poisoned store --------
{
  const created = await authedPost('/memory-create',
    { name: `didi_r5_probe`, strategies: ['SEMANTIC'], eventExpiryDuration: 30 }, carol)
  if (created.ok) {
    const keys = Object.keys(created.memory)
    const ALLOWED = new Set(['id', 'name', 'status', 'simulated', 'domain', 'agent', 'attachedAgents',
      'strategies', 'eventCount', 'recordCount', 'countsSimulated', 'piiFlagged',
      'eventExpiryDuration', 'retentionDays', 'createdAt'])
    const extra = keys.filter(k => !ALLOWED.has(k))
    check('P3.1 memory-create response carries ONLY whitelisted fields', extra.length === 0,
      `extra=${extra.join(',') || 'none'}`)
    check('P3.2 created store is stamped with the creator domain (not null/platform)',
      created.memory.domain === 'customer-support', `domain=${created.memory.domain}`)
    await authedPost('/memory-remove', { id: created.memory.id }, carol)
  } else {
    check('P3.1 memory-create usable for whitelist probe', false, created.error)
  }
}

// ---- P4: masked content must be FULL-SPAN placeholders, no partials ------
{
  // v2.1 A3: content is locked by default even for the lead, so read it the
  // legitimate way — request + approve a short grant, scan, then revoke.
  // (independent review probe updated 2026-08-08: old direct read returned n=0 after the
  // own-plane retirement — precondition failed, scan never ran.)
  const MEM = 'supportdesk-memory-seed'
  const rq = await authedPost('/grant-request',
    { resourceType: 'memory', resourceId: MEM, purpose: 'independent review P4 masking scan', durationS: 90 }, carol)
  let texts = []
  if (rq.ok && rq.request?.id) {
    const admin2 = await apiLogin('melanie')
    const dec = await authedPost('/grant-decide', { requestId: rq.request.id, decision: 'approve' }, admin2)
    check('P4.0 lead grant approved by platform peer (v2.2 single-lead route)', dec.ok === true,
      `err=${(dec.error || '').slice(0, 50)}`)
    const ex = await authedGet(`/memory-extractions?memoryId=${MEM}`, carol)
    texts = (ex.extractions || []).map(e => e.text)
    // clean up our grant so later suites see the locked default
    await authedPost('/obs-access-revoke', { kind: 'memory', id: MEM }, carol)
  } else {
    check('P4.0 grant request path usable for masking scan', false, rq.error)
  }
  const hits = [...new Set(texts.flatMap(scan))]
  check('P4.1 granted extractions carry zero raw PII', texts.length > 0 && hits.length === 0,
    `n=${texts.length} leaks=${hits.join(',') || 'none'}`)
  const partial = texts.filter(t => /[A-Za-z0-9]\*{2,}|\*{2,}@|@\w*\*/.test(t))
  check('P4.2 no partial-masking style (j***@acme.com) — full-span placeholders only',
    partial.length === 0, partial.slice(0, 1).join(''))
}

// ---- P5: cross-domain audit isolation (bob must not see CS access rows) --
{
  const bob = await apiLogin('bob')
  const a = await authedGet('/audit-trail', bob)
  const foreign = (a.events || []).filter(e => e.stream === 'access' && e.domain === 'customer-support')
  check('P5.1 operations lead/builder sees no customer-support access rows',
    foreign.length === 0, `foreign=${foreign.length}`)
  const mineOnly = (a.events || []).filter(e => e.stream === 'access')
    .every(e => e.domain === 'operations' || e.domain == null)
  check('P5.2 every visible access row belongs to his own domain', mineOnly)
}

// cleanup: drop the probe grant so the suite state stays comparable
await authedPost('/obs-access-revoke', { kind: 'trace', id: 'supportdesk' }, alice)

console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
