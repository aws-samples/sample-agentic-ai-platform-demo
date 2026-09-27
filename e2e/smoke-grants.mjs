// G3 smoke: the generalized grant-request API (trace|memory|tool|dataScope|
// toolCredential) — one store, one approval queue, one audit trail shared with
// the legacy /api/obs-access-* facade. Covers: gating, tool + toolCredential
// (evidence precondition) requests, cross-API queue visibility both ways,
// requester != approver (R-002), real-time expiry (R-003), foreign-domain 404,
// rejected -> legacy "denied" mapping, and no-content-in-grant-rows.
// Run: node e2e/smoke-grants.mjs  (expects console on :4000)
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawPost = (p, body, token) =>
  fetch(BASE + '/api' + p, {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  })

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support
const enduser = await apiLogin('enduser')

// ---------- gating ----------
check('no session -> 401', (await rawPost('/grant-request', { resourceType: 'tool', resourceId: 'x' }, null)).status === 401)
check('end user cannot request grants -> 403', (await rawPost('/grant-request', { resourceType: 'tool', resourceId: 'x', purpose: 'p', durationS: 60 }, enduser.token)).status === 403)
check('platform admin cannot request TOOL grants -> 403 (content break-glass only)',
  (await rawPost('/grant-request', { resourceType: 'tool', resourceId: 'x', purpose: 'p', durationS: 60 }, admin.token)).status === 403)
check('unknown resourceType -> 400', (await rawPost('/grant-request', { resourceType: 'spaceship', resourceId: 'x', purpose: 'p', durationS: 60 }, alice.token)).status === 400)
check('malformed JSON body -> 400 (R-010 precedent)', (await rawPost('/grant-request', '{not json', alice.token)).status === 400)
check('missing purpose -> 400 (R-011 precedent)', (await rawPost('/grant-request', { resourceType: 'tool', resourceId: 'x', durationS: 60 }, alice.token)).status === 400)

// ---------- tool grant: request -> lead approves -> visible in ONE queue ----------
const toolReq = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: 'web-search', purpose: 'G3 smoke: agent needs live search', durationS: 3600, onBehalfOfProject: 'supportdesk' }, alice)).request
check('tool grant request created with SPEC shape',
  !!toolReq && toolReq.resourceType === 'tool' && toolReq.status === 'pending' && toolReq.purpose.includes('live search') && toolReq.onBehalfOfProject === 'supportdesk')
const dupe = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: 'web-search', purpose: 'again', durationS: 60 }, alice)).request
check('open request is idempotent (same id returned)', dupe.id === toolReq.id)
const carolOwn = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: 'self-approval-probe', purpose: 'R-002: lead requesting for herself', durationS: 60 }, carol)).request
check('requester cannot approve their own request -> 403 (R-002)',
  (await rawPost('/grant-decide', { requestId: carolOwn.id, decision: 'approve' }, carol.token)).status === 403)
check('builder cannot decide -> 403', (await rawPost('/grant-decide', { requestId: toolReq.id, decision: 'approve' }, alice.token)).status === 403)
const approved = (await authedPost('/grant-decide', { requestId: toolReq.id, decision: 'approve' }, carol)).request
check('lead approves: status approved, expiresAt set, decidedBy carol',
  approved.status === 'approved' && !!approved.expiresAt && approved.decidedBy === 'carol')
check('approval is audited with grant id',
  (await authedGet('/obs-audit', carol)).events.some(e => e.action === 'access-approved' && e.requestId === toolReq.id))
check('decided request cannot be re-decided -> 409',
  (await rawPost('/grant-decide', { requestId: toolReq.id, decision: 'approve' }, carol.token)).status === 409)

// ---------- one store: legacy facade and new API see the SAME queue ----------
const legacyQ = (await authedGet('/obs-access-requests', carol)).requests
check('tool grant visible through the LEGACY queue endpoint (one store)',
  legacyQ.some(r => r.id === toolReq.id))
const legacyReq = (await authedPost('/obs-access-request', { kind: 'trace', id: 'supportdesk', justification: 'G3 smoke: legacy facade writes the shared store', durationS: 3600 }, alice)).request
const newQ = (await authedGet('/grant-requests', carol)).requests
check('legacy obs-access request visible through the NEW queue endpoint',
  newQ.some(r => r.id === legacyReq.id && r.resourceType === 'trace' && r.purpose === legacyReq.justification))
check('?type= filter narrows the queue', (await authedGet('/grant-requests?type=tool', carol)).requests.every(r => r.resourceType === 'tool'))
check('grant rows carry metadata only — no content/text/extraction fields',
  newQ.every(r => !('text' in r) && !('content' in r) && !('extractions' in r) && !('traces' in r)))

// ---------- evidence precondition (data-driven, toolCredential) ----------
const noEv = await rawPost('/grant-request', { resourceType: 'toolCredential', resourceId: 'zendesk-api-key', purpose: 'agent calls zendesk', durationS: 3600 }, alice.token)
check('toolCredential without evidence -> 400 precondition', noEv.status === 400 && /evidence/i.test((await noEv.json()).error))
const credReq = (await authedPost('/grant-request', { resourceType: 'toolCredential', resourceId: 'zendesk-api-key', purpose: 'agent calls zendesk', durationS: 3600, evidence: 'eval-run-supportdesk-42' }, alice)).request
check('toolCredential with evidence accepted, evidence recorded',
  !!credReq && credReq.status === 'pending' && credReq.evidence === 'eval-run-supportdesk-42')

// ---------- rejected -> legacy "denied" compat mapping ----------
const rejected = (await authedPost('/grant-decide', { requestId: credReq.id, decision: 'reject' }, carol)).request
check('reject: SPEC status "rejected"', rejected.status === 'rejected')
check('legacy view maps rejected -> denied',
  (await authedGet('/obs-access-requests', carol)).requests.find(r => r.id === credReq.id)?.status === 'denied')

// ---------- R-003: real-time expiry on the read path ----------
const shortReq = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: 'short-lived-tool', purpose: 'G3 smoke: 1s expiry probe', durationS: 1 }, alice)).request
await authedPost('/grant-decide', { requestId: shortReq.id, decision: 'approve' }, carol)
await new Promise(r => setTimeout(r, 1500))
const afterExpiry = (await authedGet('/grant-requests?type=tool', alice)).requests.find(r => r.id === shortReq.id)
check('expired grant flips to "expired" on the next read (R-003)', afterExpiry?.status === 'expired')
check('expiry is audited', (await authedGet('/obs-audit', carol)).events.some(e => e.action === 'access-expired' && e.requestId === shortReq.id))

// ---------- scoping: foreign-domain 404, cross-domain queue isolation ----------
check('foreign-domain trace resource -> 404 (not empty 200)',
  (await rawPost('/grant-request', { resourceType: 'trace', resourceId: 'opsassistant', purpose: 'probe', durationS: 60 }, alice.token)).status === 404)
const bob = await apiLogin('bob')
check("bob (operations) does not see customer-support requests in his queue",
  !(await authedGet('/grant-requests', bob)).requests.some(r => r.id === toolReq.id))
check('foreign-domain builder cannot decide -> 403 (no decide capability)',
  (await rawPost('/grant-decide', { requestId: legacyReq.id, decision: 'approve' }, bob.token)).status === 403)
check('lead deciding an unknown/foreign request id -> 404',
  (await rawPost('/grant-decide', { requestId: 'nonexistent-request', decision: 'approve' }, carol.token)).status === 404)
check('admin sees the full queue (metadata view)',
  (await authedGet('/grant-requests', admin)).requests.some(r => r.id === toolReq.id))

// ---------- suite-level hermeticity: restore the trace state this file created ----------
// legacyReq (alice/trace/supportdesk) would otherwise stay PENDING forever and
// hijack smoke-gate's A8 idempotent 5s request on the NEXT suite run —
// createGrantRequest returns an open request instead of creating a new one, so
// carol would approve THIS hour-scale grant and A8's per-request expiry never
// fires (R-016/R-017 lesson: every smoke restores what it creates). Reject it
// as the same-domain lead. Tool/toolCredential rows are decided (approved/
// rejected/expired) above, so idempotent re-creation works on re-runs; only
// open trace state is the cross-file hazard.
await authedPost('/grant-decide', { requestId: legacyReq.id, decision: 'reject' }, carol)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
