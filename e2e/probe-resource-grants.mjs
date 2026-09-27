// independent review Round 4 adversarial probes — G3 generalized grants + G18 fail-closed
// memory attribution. Uses login.mjs helpers only (they own the auth header).
import { apiLogin, apiSwitchDomain, authedGet, authedPost } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// The real deployed CS store (G18 repro) — resolved from carol's inventory at
// runtime because the AWS-side store id ROTATES when the memory is recreated
// (the old hardcoded supportdesk_supportdeskMemory-aOjzhu8I8W went stale and
// made P1.3-P1.6 fail with "No memory" instead of the locked response).
const ORPHAN = 'plato_agent_memory-dePnp07q8q'               // unattributed after G18

async function resolveCsStore() {
  const carol = await apiLogin('carol')
  const inv = await authedGet('/memories', carol)
  const live = (inv.memories || []).find(m => m.domain === 'customer-support' && /supportdeskMemory-/.test(m.id))
  return live ? live.id : 'supportdesk_supportdeskMemory-gone'
}
const CS_STORE = await resolveCsStore()
console.log(`      [info] CS store resolved: ${CS_STORE}`)

// ---- P1: G18 regression — the original MAJOR must stay closed -------------
{
  const admin = await apiLogin('melanie')
  const alice = await apiLogin('alice')
  const carol = await apiLogin('carol')

  const a = await authedGet(`/memory-extractions?memoryId=${CS_STORE}`, admin)
  check('P1.1 admin canNOT read CS store content without a grant (G18)',
    a.ok === false || a.locked === true, `ok=${a.ok} locked=${a.locked} n=${(a.extractions || []).length}`)
  check('P1.2 admin read is not own-plane', !a.ownPlane, `ownPlane=${a.ownPlane}`)

  // TLP-B1 / spec v2.1 §8 A3: own-plane default RETIRED — memory content is
  // grant-gated for EVERY role including the owning-domain lead. (Old v1
  // assertion "lead regains own-plane access" was retired with the spec;
  // independent review probe updated 2026-08-08 after replay confirmed locked:true is
  // the correct v2.1/v2.2 behavior, not a regression.)
  const c = await authedGet(`/memory-extractions?memoryId=${CS_STORE}`, carol)
  check('P1.3 owning-domain LEAD is locked by default too (v2.1 A3: no own-plane)',
    c.ok === true && c.locked === true && !c.extractions, `ok=${c.ok} locked=${c.locked}`)
  check('P1.4 lead lock response carries a grant path, not a dead end',
    typeof c.reason === 'string' && c.reason.length > 0, `reason=${(c.reason || '').slice(0, 40)}`)

  const b = await authedGet(`/memory-extractions?memoryId=${CS_STORE}`, alice)
  // ISOLATION: the official smoke-memory.mjs approves a 4-HOUR memory grant for
  // alice on this exact store and never revokes it, so on a shared server this
  // check reads content through THAT grant (false "builder not locked").
  // Drop any live grant of hers first, then assert the locked default.
  await authedPost('/obs-access-revoke', { kind: 'memory', id: CS_STORE }, alice)
  const b2 = await authedGet(`/memory-extractions?memoryId=${CS_STORE}`, alice)
  check('P1.5 same-domain BUILDER stays locked without a grant (grant path)',
    b2.locked === true, `ok=${b2.ok} locked=${b2.locked} (pre-revoke: locked=${b.locked})`)

  const cl = await authedGet('/memories', carol)
  check('P1.6 lead sees the store in her inventory',
    (cl.memories || []).some(m => m.id === CS_STORE && m.domain === 'customer-support'))
}

// ---- P2: break-glass self-approval boundary (R-002 holds for admins) -------
{
  const admin = await apiLogin('melanie')
  const rq = await authedPost('/grant-request',
    { resourceType: 'memory', resourceId: 'supportdesk-memory-seed', purpose: 'independent review P2 break-glass', durationS: 60 }, admin)
  check('P2.1 admin break-glass request routes to the OWNING domain queue',
    rq.ok === true && rq.request?.domain === 'customer-support', `domain=${rq.request?.domain}`)
  if (rq.ok) {
    const self = await authedPost('/grant-decide', { requestId: rq.request.id, decision: 'approve' }, admin)
    check('P2.2 admin cannot self-approve (no decideAccessRequests)', self.ok === false, `err=${(self.error || '').slice(0, 50)}`)
    const sw = await apiSwitchDomain(admin, 'customer-support')
    const self2 = await authedPost('/grant-decide', { requestId: rq.request.id, decision: 'approve' }, sw)
    check('P2.3 admin STILL cannot self-approve after switching into the owning domain',
      self2.ok === false, `err=${(self2.error || '').slice(0, 50)}`)
    // and the grant never became active
    const rd = await authedGet(`/memory-extractions?memoryId=supportdesk-memory-seed`, sw)
    check('P2.4 no content leaked through the self-approve attempt', rd.ok === false || rd.locked === true,
      `ok=${rd.ok} locked=${rd.locked}`)
  }
}

// ---- P3: unattributed store — fail-closed, no existence oracle ------------
{
  const admin = await apiLogin('melanie')  // fresh session, activeDomain=null
  const u = await authedPost('/grant-request',
    { resourceType: 'memory', resourceId: ORPHAN, purpose: 'independent review P3', durationS: 60 }, admin)
  check('P3.1 grant on an unattributed store is refused', u.ok === false, `err=${(u.error || '').slice(0, 60)}`)
  const k = await authedPost('/grant-request',
    { resourceType: 'memory', resourceId: 'no-such-store-zzz', purpose: 'independent review P3b', durationS: 60 }, admin)
  check('P3.2 unknown id gives the SAME answer (no existence oracle)',
    k.ok === false && k.error === u.error, `same=${k.error === u.error}`)
  const rd = await authedGet(`/memory-extractions?memoryId=${ORPHAN}`, admin)
  check('P3.3 unattributed content is locked for the admin too', rd.ok === false || rd.locked === true,
    `ok=${rd.ok} locked=${rd.locked}`)
}

// ---- P4: real-time expiry (R-003) + post-expiry replay -------------------
{
  const alice = await apiLogin('alice')
  const carol = await apiLogin('carol')
  // ISOLATION (learned the hard way): activeGrant() matches ANY approved grant
  // for (user, type, resource). If an earlier probe (independent review-probe-g4 P1 uses a
  // 120s trace grant on the same agent) left one alive, this 2s-expiry check
  // reads content through THAT grant and reports a false "expiry not enforced".
  // Use a dedicated resource and drop any pre-existing grant on it first.
  const RES = 'returns-bot'
  await authedPost('/obs-access-revoke', { kind: 'trace', id: RES }, alice)
  const pre = await authedGet('/grant-requests?type=trace', alice)
  const stillLive = (pre.requests || []).filter(r => r.resourceId === RES && r.status === 'approved')
  check('P4.0 no pre-existing live grant on the expiry-probe resource',
    stillLive.length === 0, `live=${stillLive.length}`)

  const rq = await authedPost('/grant-request',
    { resourceType: 'trace', resourceId: RES, purpose: 'independent review P4 expiry', durationS: 2 }, alice)
  check('P4.1 builder trace request accepted', rq.ok === true, `err=${(rq.error || '').slice(0, 50)}`)
  const dec = await authedPost('/grant-decide', { requestId: rq.request.id, decision: 'approve' }, carol)
  check('P4.2 lead approves (requester≠approver)', dec.ok === true, `err=${(dec.error || '').slice(0, 50)}`)

  const t0 = await authedGet(`/obs-traces?agent=${RES}`, alice)
  check('P4.3 t0: content readable under the fresh grant', t0.ok === true && t0.locked !== true,
    `ok=${t0.ok} locked=${t0.locked} n=${(t0.traces || []).length}`)
  await sleep(3200)
  const t1 = await authedGet(`/obs-traces?agent=${RES}`, alice)
  check('P4.4 t+3.2s: grant expired -> content locked again (real-time sweep)',
    t1.locked === true || t1.ok === false, `ok=${t1.ok} locked=${t1.locked} n=${(t1.traces || []).length}`)

  const aud = await authedGet('/audit-trail', carol)
  const mine = (aud.events || []).filter(r => r.requestId === rq.request.id).map(r => r.action)
  check('P4.5 full lifecycle audited (requested/approved/expired)',
    mine.includes('access-requested') && mine.includes('access-approved') && mine.includes('access-expired'),
    mine.join('->'))
  // replay the expired grant id: must not resurrect
  const re = await authedPost('/grant-decide', { requestId: rq.request.id, decision: 'approve' }, carol)
  check('P4.6 re-approving an EXPIRED request is refused (no resurrection)', re.ok === false,
    `err=${(re.error || '').slice(0, 50)}`)
}

// ---- P5: B6 dual-track — legacy facade and new API share ONE store --------
{
  const alice = await apiLogin('alice')
  const carol = await apiLogin('carol')
  const legacy = await authedPost('/obs-access-request',
    { kind: 'trace', id: 'returns-bot', justification: 'independent review P5 legacy track', durationS: 60 }, alice)
  check('P5.1 legacy /obs-access-request still accepted', legacy.ok === true, `err=${(legacy.error || '').slice(0, 50)}`)
  const viaNew = await authedGet('/grant-requests?type=trace', alice)
  check('P5.2 legacy-created request is visible on the NEW /grant-requests (one store)',
    (viaNew.requests || []).some(r => r.id === legacy.request.id), `n=${(viaNew.requests || []).length}`)
  // decide it through the NEW endpoint, read it back through the LEGACY one
  const dec = await authedPost('/grant-decide', { requestId: legacy.request.id, decision: 'approve' }, carol)
  check('P5.3 new /grant-decide can decide a legacy-created request', dec.ok === true)
  const legacyList = await authedGet('/obs-access-requests', carol)
  const row = (legacyList.requests || []).find(r => r.id === legacy.request.id)
  check('P5.4 legacy list reflects the new decision (no divergent second track)',
    row?.status === 'approved', `status=${row?.status}`)
  check('P5.5 legacy view never leaks the evidence field', row && !('evidence' in row))
  // legacy revoke -> new list agrees
  await authedPost('/obs-access-revoke', { kind: 'trace', id: 'returns-bot' }, alice)
  const after = await authedGet('/grant-requests?type=trace', alice)
  const nrow = (after.requests || []).find(r => r.id === legacy.request.id)
  check('P5.6 legacy revoke is visible on the new API (single source of truth)',
    nrow?.status === 'revoked', `status=${nrow?.status}`)
}

console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
