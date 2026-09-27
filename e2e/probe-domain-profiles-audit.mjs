// independent review Round 9+10 (API-layer only) — G8 domain profiles + G9 unified audit trail.
// G8 angles: B8 "starter agent really runs, not a shell", body-supplied domain
// must be ignored (session-only), foreign-domain palette entries dropped not
// smuggled, unknown profileId gives no existence oracle.
// G9 angles: viewAuditTrail gate, cross-domain isolation, fixed projection.
import { apiLogin, authedGet, authedPost } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const admin = await apiLogin('melanie')
const carol = await apiLogin('carol')
const alice = await apiLogin('alice')   // builder, customer-support
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

// ===================== G8 — domain profiles ==============================
console.log('--- G8 profiles ---')
let created = null
{
  const p = await authedGet('/profiles', alice)
  const ids = (p.profiles || []).map(x => x.id)
  check('U1.1 builder can list factory profiles', p.ok === true && ids.length > 0, `ids=${ids.join(',')}`)
  const eu = await authedGet('/profiles', enduser)
  check('U1.2 end user cannot list profiles (useBuilderSurfaces gate)', eu.ok === false,
    `err=${(eu.error || '').slice(0, 40)}`)

  const pid = ids[0]
  // U2: body-supplied domain must be IGNORED — the session decides.
  created = await authedPost('/project-from-profile',
    { profileId: pid, projectName: 'didir9probe', domain: 'operations' }, alice)
  check('U2.1 create-from-profile succeeds for the builder', created.ok === true,
    `err=${(created.error || '').slice(0, 60)}`)
  if (created.ok) {
    const detail = await authedGet(`/project-detail?id=${created.project?.id || 'didir9probe'}`, alice)
    check('U2.2 body-supplied domain IGNORED — project lands in the SESSION domain',
      detail.project?.domain === 'customer-support', `domain=${detail.project?.domain}`)
    check('U2.3 project is stamped with the profile it came from',
      !!detail.project?.profileId, `profileId=${detail.project?.profileId}`)
    // U3 (B8): the starter agent must be real, not a shell
    const agents = detail.project?.agents || []
    check('U3.1 project carries at least one starter agent', agents.length > 0, `agents=${agents.join(',')}`)
    const ad = await authedPost('/agent-detail', { project: agents[0] || 'didir9probe' }, alice)
    check('U3.2 starter agent has a real runtime (not an empty shell)',
      !!ad.runtime, `runtime=${!!ad.runtime} err=${(ad.error || '').slice(0, 50)}`)
    // registry visibility: the deployed runtime shows up in the domain fleet.
    // NOTE: fleet ids are DEPLOY names (`<project>_chat_agent-<suffix>`), not the
    // project id — matching on the project id verbatim was a probe-authoring
    // bug on my first run. A profile-created project has no deployed runtime
    // until it is deployed, so assert the fleet stays domain-scoped instead.
    const fleet = await authedGet('/fleet', alice)
    const foreign = (fleet.agents || []).filter(a => a.domain && a.domain !== 'customer-support')
    check('U3.3 domain fleet stays scoped to the builder\'s own domain',
      foreign.length === 0, `n=${(fleet.agents || []).length} foreign=${foreign.length}`)
  }
}
{
  // U4: unknown / foreign profileId must not be an existence oracle
  const unk = await authedPost('/project-from-profile', { profileId: 'no-such-profile-zzz', projectName: 'didir9x' }, alice)
  check('U4.1 unknown profileId refused', unk.ok === false, `err=${(unk.error || '').slice(0, 50)}`)
  const eu = await authedPost('/project-from-profile', { profileId: 'support-agent', projectName: 'didir9y' }, enduser)
  check('U4.2 end user cannot create from a profile', eu.ok === false, `err=${(eu.error || '').slice(0, 50)}`)
}

// ===================== G9 — unified audit trail ==========================
console.log('--- G9 audit trail ---')
{
  // V1: capability gate — builders and end users have no audit surface
  for (const [who, s] of [['builder alice', alice], ['end user', enduser]]) {
    const r = await authedGet('/audit-trail', s)
    check(`V1.1 ${who} has no audit trail (viewAuditTrail gate)`, r.ok === false,
      `err=${(r.error || '').slice(0, 45)}`)
  }
  const lead = await authedGet('/audit-trail', carol)
  const adm = await authedGet('/audit-trail', admin)
  check('V1.2 lead and admin both get the trail', lead.ok === true && adm.ok === true)

  // V2: fixed 9-field projection, no content smuggling
  const EXPECTED = new Set(['stream', 'type', 'action', 'who', 'domain', 'at', 'requestId', 'subject', 'detail'])
  const extra = [...new Set((adm.events || []).flatMap(e => Object.keys(e)))].filter(k => !EXPECTED.has(k))
  check('V2.1 projection is exactly the 9 declared fields', extra.length === 0, `extra=${extra.join(',') || 'none'}`)
  const CONTENT_KEYS = /extraction|record|snippet|preview|body|text/i
  const suspicious = [...new Set((adm.events || []).flatMap(e => Object.keys(e)))].filter(k => CONTENT_KEYS.test(k))
  check('V2.2 no content-bearing key names in the projection', suspicious.length === 0, suspicious.join(','))

  // V3: cross-domain isolation on the ACCESS stream
  const bobTrail = await authedGet('/audit-trail', bob)
  if (bobTrail.ok) {
    const foreign = (bobTrail.events || []).filter(e => e.stream === 'access' && e.domain && e.domain !== 'operations')
    check('V3.1 operations session sees no foreign-domain access rows', foreign.length === 0,
      `foreign=${foreign.length} domains=${[...new Set((bobTrail.events||[]).map(e=>e.domain))].join(',')}`)
  } else {
    check('V3.1 (bob has no audit capability — isolation vacuously holds)', true, bobTrail.error)
  }
  const csForeign = (lead.events || []).filter(e => e.stream === 'access' && e.domain && e.domain !== 'customer-support')
  check('V3.2 CS lead sees no foreign-domain access rows', csForeign.length === 0,
    `foreign=${csForeign.length}`)

  // V4: filters narrow only
  const baseN = (lead.events || []).length
  const typed = await authedGet(`/audit-trail?type=${encodeURIComponent((lead.types || [])[0] || 'trace')}`, carol)
  check('V4.1 type filter narrows (never widens)', (typed.events || []).length <= baseN,
    `${(typed.events || []).length} <= ${baseN}`)
  const bogus = await authedGet('/audit-trail?type=not-a-type', carol)
  check('V4.2 unknown type filter yields empty, not everything', (bogus.events || []).length === 0,
    `n=${(bogus.events || []).length}`)
  const foreignDomainQ = await authedGet('/audit-trail?domain=operations', carol)
  const leaked = (foreignDomainQ.events || []).filter(e => e.stream === 'access')
  check('V4.3 ?domain=operations gives a CS lead no foreign access rows', leaked.length === 0,
    `n=${leaked.length}`)

  // V5: the types picker must not advertise types outside this session's scope
  const leadTypes = new Set(lead.types || [])
  const leadActual = new Set((lead.events || []).map(e => e.type))
  const phantom = [...leadTypes].filter(t => !leadActual.has(t))
  check('V5.1 types picker only offers types present in this scope', phantom.length === 0,
    `phantom=${phantom.join(',') || 'none'}`)
}

// cleanup: remove the probe project's composition + row if it landed
if (created?.ok) {
  const id = created.project?.id || 'didir9probe'
  await authedPost('/project-member-remove', { projectId: id, principal: 'alice' }, admin).catch(() => {})
}

console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
