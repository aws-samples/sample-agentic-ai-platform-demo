// independent review Round 8 (API-layer only) — G7 unified Requests inbox over the G3 store.
// Attack angles: filters must only ever NARROW the scoped set, a requester-only
// session must not gain other people's rows through filter combinations, and a
// memory-type row must never carry resource content into the inbox projection.
import { apiLogin, apiSwitchDomain, authedGet, authedPost } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const admin = await apiLogin('melanie')
const carol = await apiLogin('carol')   // lead, customer-support (decider)
const alice = await apiLogin('alice')   // builder, customer-support (requester only)
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

// Seed rows from two different requesters in the SAME domain, so "requester
// sees only her own" is actually testable.
const aliceReq = await authedPost('/grant-request',
  { resourceType: 'trace', resourceId: 'supportdesk', purpose: 'R8 alice row', durationS: 300 }, alice)
const carolReq = await authedPost('/grant-request',
  { resourceType: 'memory', resourceId: 'supportdesk-memory-seed', purpose: 'R8 carol row', durationS: 300 }, carol)
const bobReq = await authedPost('/grant-request',
  { resourceType: 'trace', resourceId: 'opsassistant', purpose: 'R8 bob row', durationS: 300 }, bob)
check('setup: three rows created across two domains',
  aliceReq.ok === true && carolReq.ok === true && bobReq.ok === true,
  `alice=${aliceReq.ok} carol=${carolReq.ok} bob=${bobReq.ok}`)

// ---- T1: filters only NARROW — never widen past the scoped set -----------
{
  const base = await authedGet('/grant-requests', alice)
  const baseIds = new Set((base.requests || []).map(r => r.id))
  check('T1.1 requester-only builder sees ONLY her own rows',
    (base.requests || []).every(r => r.requestedBy === 'alice'),
    `others=${(base.requests || []).filter(r => r.requestedBy !== 'alice').length}`)

  for (const q of ['type=memory', 'status=pending', 'domain=customer-support',
                   'type=trace&status=pending&domain=customer-support',
                   'domain=operations', 'status=approved', 'type=toolCredential']) {
    const r = await authedGet(`/grant-requests?${q}`, alice)
    const ids = (r.requests || []).map(x => x.id)
    const widened = ids.filter(i => !baseIds.has(i))
    const foreign = (r.requests || []).filter(x => x.requestedBy !== 'alice')
    check(`T1.2 ?${q} cannot widen alice's scope`, widened.length === 0 && foreign.length === 0,
      `widened=${widened.length} foreign=${foreign.length}`)
  }
  check('T1.3 carol\'s own row is NOT visible to alice (same domain, different requester)',
    !baseIds.has(carolReq.request?.id))
}

// ---- T2: decider scope — lead sees the owned-domain queue, not others ----
{
  const r = await authedGet('/grant-requests', carol)
  const rows = r.requests || []
  check('T2.1 lead sees both requesters in her own domain',
    rows.some(x => x.id === aliceReq.request?.id) && rows.some(x => x.id === carolReq.request?.id))
  check('T2.2 lead sees NO operations-domain rows',
    !rows.some(x => x.id === bobReq.request?.id) &&
    // spec v2.2 §9 single-lead exception (d6bfde20): carol's OWN memory
    // request routes to the platform peer queue, so her list may legitimately
    // contain platform-routed rows SHE initiated. Only foreign-domain rows
    // from OTHER requesters are a leak. (independent review probe updated 2026-08-08 —
    // old assertion counted self-initiated platform rows as a leak: false FAIL.)
    rows.every(x => x.domain === 'customer-support' ||
      (x.domain === 'platform' && x.requestedBy === 'carol')),
    `domains=${[...new Set(rows.map(x => x.domain))].join(',')}`)
  // a foreign ?domain= filter must yield empty, never a cross-domain leak
  const foreign = await authedGet('/grant-requests?domain=operations', carol)
  check('T2.3 ?domain=operations for a CS lead yields empty (not a leak)',
    (foreign.requests || []).length === 0, `n=${(foreign.requests || []).length}`)
}

// ---- T3: platform session sees all — METADATA only, never content -------
{
  const r = await authedGet('/grant-requests', admin)
  const rows = r.requests || []
  check('T3.1 admin sees rows from both domains', 
    rows.some(x => x.domain === 'customer-support') && rows.some(x => x.domain === 'operations'))
  // a memory-type row must not smuggle extraction text / content fields
  const memRows = rows.filter(x => x.resourceType === 'memory')
  const CONTENT_KEYS = ['extractions', 'text', 'records', 'content', 'preview', 'snippet', 'body']
  const leaked = memRows.flatMap(x => Object.keys(x).filter(k => CONTENT_KEYS.includes(k)))
  check('T3.2 memory-type rows carry zero content-bearing fields',
    memRows.length > 0 && leaked.length === 0, `n=${memRows.length} leaked=${leaked.join(',') || 'none'}`)
  // field shape should be the fixed grant projection
  const EXPECTED = new Set(['id', 'resourceType', 'resourceId', 'requestedBy', 'requesterName',
    'onBehalfOfProject', 'domain', 'purpose', 'durationS', 'evidence', 'status',
    'requestedAt', 'decidedBy', 'decidedAt', 'expiresAt'])
  const extra = [...new Set(rows.flatMap(x => Object.keys(x)))].filter(k => !EXPECTED.has(k))
  check('T3.3 inbox projection has no unexpected fields', extra.length === 0, `extra=${extra.join(',') || 'none'}`)
}

// ---- T4: end user has no inbox at all -----------------------------------
{
  const r = await authedGet('/grant-requests', enduser)
  check('T4.1 end user gets no queue (capability-gated)', r.ok === false, `err=${(r.error || '').slice(0, 40)}`)
}

// ---- T5: decide-button truth — R-002 at the API, incl. self-row ---------
{
  // carol is the DECIDER but also the requester of carolReq -> must not decide it
  const self = await authedPost('/grant-decide', { requestId: carolReq.request?.id, decision: 'approve' }, carol)
  check('T5.1 lead cannot decide her OWN request (requester≠approver)', self.ok === false,
    `err=${(self.error || '').slice(0, 50)}`)
  // admin holds no decideAccessRequests -> cannot decide anything
  const byAdmin = await authedPost('/grant-decide', { requestId: aliceReq.request?.id, decision: 'approve' }, admin)
  check('T5.2 platform admin cannot decide a domain request', byAdmin.ok === false,
    `err=${(byAdmin.error || '').slice(0, 50)}`)
  // foreign lead cannot decide a CS request (bob is a builder; use domain switch on admin is not enough)
  const byBob = await authedPost('/grant-decide', { requestId: aliceReq.request?.id, decision: 'approve' }, bob)
  check('T5.3 foreign-domain session cannot decide a CS request', byBob.ok === false,
    `err=${(byBob.error || '').slice(0, 50)}`)
  // the legitimate decider works
  const ok = await authedPost('/grant-decide', { requestId: aliceReq.request?.id, decision: 'approve' }, carol)
  check('T5.4 the owning lead CAN decide someone else\'s request', ok.ok === true,
    `err=${(ok.error || '').slice(0, 50)}`)
}

// ---- T6: status filter reflects reality after the decision ---------------
{
  const pending = await authedGet('/grant-requests?status=pending', carol)
  const approved = await authedGet('/grant-requests?status=approved', carol)
  check('T6.1 decided row left the pending filter',
    !(pending.requests || []).some(x => x.id === aliceReq.request?.id))
  check('T6.2 decided row appears under status=approved',
    (approved.requests || []).some(x => x.id === aliceReq.request?.id))
  const bogus = await authedGet('/grant-requests?status=not-a-status', carol)
  check('T6.3 unknown status filter yields empty, not everything',
    (bogus.requests || []).length === 0, `n=${(bogus.requests || []).length}`)
  const bogusType = await authedGet('/grant-requests?type=not-a-type', carol)
  check('T6.4 unknown type filter yields empty, not everything',
    (bogusType.requests || []).length === 0, `n=${(bogusType.requests || []).length}`)
}

// cleanup
await authedPost('/obs-access-revoke', { kind: 'trace', id: 'supportdesk' }, alice)

console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
