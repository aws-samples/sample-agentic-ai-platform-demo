// independent review Round 7 (API-layer only) — G6 Members writes. Front-end/persona surface
// is deliberately deferred until implementation's UI/IA refactor lands.
// Four suspicions from the G6 code read + the R-006/B5/B9 sign-off criteria.
import { apiLogin, authedGet, authedPost } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const admin = await apiLogin('melanie')
const carol = await apiLogin('carol')   // lead, customer-support
const alice = await apiLogin('alice')   // builder, customer-support
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

const CS_PROJECT = 'supportdesk'
const OPS_PROJECT = 'opsassistant'

// ---- S1: directory vs write-path consistency -----------------------------
// memberDirectory() also lists domains.json vended users (d.users), but the
// write path only accepts consoleUser(principal). A picker that offers a name
// the writer rejects is a broken affordance.
{
  const d = await authedGet(`/project-detail?id=${CS_PROJECT}`, carol)
  const dir = d.directory || []
  check('S1.1 lead gets a member directory on project-detail', dir.length > 0, `n=${dir.length}`)
  const offered = dir.map(x => x.id)
  const rejected = []
  for (const id of offered) {
    const r = await authedPost('/project-member-set',
      { projectId: CS_PROJECT, principal: id, bundle: 'builder' }, carol)
    if (r.ok !== true) rejected.push(`${id}:${(r.error || '').slice(0, 40)}`)
  }
  check('S1.2 EVERY directory-offered principal is accepted by the write path',
    rejected.length === 0, rejected.join(' ; ') || 'none rejected')
  // cleanup: drop anyone we just added who was not an original member
  const orig = new Set((d.project?.members || []).map(m => m.principal))
  for (const id of offered) if (!orig.has(id)) {
    await authedPost('/project-member-remove', { projectId: CS_PROJECT, principal: id }, carol)
  }
}

// ---- S2: R-006 / B5 — capability-gated writes, no existence oracle -------
{
  for (const [who, s] of [['builder alice', alice], ['end user', enduser]]) {
    const r = await authedPost('/project-member-set',
      { projectId: CS_PROJECT, principal: 'alice', bundle: 'builder' }, s)
    check(`S2.1 ${who} cannot add members (403, capability-gated)`, r.ok === false,
      `err=${(r.error || '').slice(0, 45)}`)
    const rm = await authedPost('/project-member-remove',
      { projectId: CS_PROJECT, principal: 'alice' }, s)
    check(`S2.2 ${who} cannot remove members`, rm.ok === false, `err=${(rm.error || '').slice(0, 45)}`)
  }
  // foreign-domain project and unknown project must be indistinguishable
  const foreign = await authedPost('/project-member-set',
    { projectId: OPS_PROJECT, principal: 'bob', bundle: 'builder' }, carol)
  const unknown = await authedPost('/project-member-set',
    { projectId: 'no-such-project-zzz', principal: 'bob', bundle: 'builder' }, carol)
  check('S2.3 foreign-domain project -> same answer as unknown (no existence oracle)',
    foreign.ok === false && unknown.ok === false && foreign.error === unknown.error,
    `foreign="${(foreign.error || '').slice(0, 30)}" unknown="${(unknown.error || '').slice(0, 30)}"`)
}

// ---- S3: platform-tier escalation via bundle assignment (R-009 analog) ---
{
  // a domain lead must not hand out a bundle carrying platform-tier powers
  const esc = await authedPost('/project-member-set',
    { projectId: CS_PROJECT, principal: 'alice', bundle: 'admin' }, carol)
  check('S3.1 domain lead cannot assign the platform-tier "admin" bundle',
    esc.ok === false && /platform-tier/i.test(esc.error || ''), `err=${(esc.error || '').slice(0, 50)}`)
  // unknown bundle rejected (not silently defaulted)
  const unk = await authedPost('/project-member-set',
    { projectId: CS_PROJECT, principal: 'alice', bundle: 'no-such-bundle' }, carol)
  check('S3.2 unknown bundle rejected (not silently defaulted)', unk.ok === false,
    `err=${(unk.error || '').slice(0, 45)}`)
  // and the escalation attempt must not have partially landed
  const after = await authedGet(`/project-detail?id=${CS_PROJECT}`, carol)
  const arow = (after.project?.members || []).find(m => m.principal === 'alice')
  check('S3.3 failed escalation left no admin-bundle membership behind',
    !arow || arow.bundle !== 'admin', `bundle=${arow?.bundle}`)
  // platform admin MAY assign it (viewAllDomains) — then revert
  const ok = await authedPost('/project-member-set',
    { projectId: CS_PROJECT, principal: 'alice', bundle: 'admin' }, admin)
  check('S3.4 platform admin CAN assign a platform-tier bundle (tier check is scoped, not blanket)',
    ok.ok === true, `err=${(ok.error || '').slice(0, 45)}`)
  await authedPost('/project-member-set', { projectId: CS_PROJECT, principal: 'alice', bundle: 'builder' }, admin)
}

// ---- S4: B9 — every member write is audited ------------------------------
{
  // Use a principal that is definitely NOT already a member, so "set" takes the
  // ADD path (an existing member would take the reassign path and never emit
  // member-added — that was a probe-authoring bug on my first run, not a gap).
  const PRINCIPAL = 'frank'
  await authedPost('/project-member-remove', { projectId: CS_PROJECT, principal: PRINCIPAL }, carol)

  const before = (await authedGet('/audit-trail', carol)).events || []
  const nAdd = before.filter(e => e.action === 'member-added').length
  const nChg = before.filter(e => e.action === 'member-bundle-changed').length
  const nRem = before.filter(e => e.action === 'member-removed').length

  await authedPost('/project-member-set', { projectId: CS_PROJECT, principal: PRINCIPAL, bundle: 'builder' }, carol)
  await authedPost('/project-member-set', { projectId: CS_PROJECT, principal: PRINCIPAL, bundle: 'lead' }, carol)
  await authedPost('/project-member-remove', { projectId: CS_PROJECT, principal: PRINCIPAL }, carol)

  const after = (await authedGet('/audit-trail', carol)).events || []
  const dAdd = after.filter(e => e.action === 'member-added').length - nAdd
  const dChg = after.filter(e => e.action === 'member-bundle-changed').length - nChg
  const dRem = after.filter(e => e.action === 'member-removed').length - nRem
  check('S4.1 add is audited', dAdd >= 1, `delta=${dAdd}`)
  check('S4.2 bundle reassign is audited as its own action', dChg >= 1, `delta=${dChg}`)
  check('S4.3 remove is audited', dRem >= 1, `delta=${dRem}`)
  // audit rows must not leak content, and must carry the owning domain
  const mine = after.filter(e => /^member-/.test(e.action)).slice(0, 5)
  check('S4.4 member audit rows carry the owning domain',
    mine.every(e => e.domain === 'customer-support'), mine.map(e => e.domain).join(','))
}

// ---- S5: remove-protection semantics (judgment call to rule on) ----------
{
  // DESTRUCTIVE + SHARED STATE: console/projects.json is a persistent store and
  // the official smoke-projects.mjs asserts supportdesk's seeded roster
  // (alice:builder + carol:lead). My first version emptied the members and
  // restored only what S5 happened to see — S4 had already removed carol, so
  // carol stayed gone and I broke smoke-projects + smoke-domain-project +
  // journey-builder for the whole suite. Capture the SEEDED roster up front and
  // restore exactly that in a finally block.
  const SEEDED = [{ principal: 'alice', bundle: 'builder' }, { principal: 'carol', bundle: 'lead' }]
  try {
    const d = await authedGet(`/project-detail?id=${CS_PROJECT}`, carol)
    const members = (d.project?.members || []).map(m => `${m.principal}:${m.bundle}`)
    console.log(`      [info] ${CS_PROJECT} members now: ${members.join(', ') || '(none)'}`)
    const emptied = []
    for (const m of (d.project?.members || [])) {
      const r = await authedPost('/project-member-remove', { projectId: CS_PROJECT, principal: m.principal }, carol)
      if (r.ok) emptied.push(m.principal)
    }
    const now = await authedGet(`/project-detail?id=${CS_PROJECT}`, carol)
    console.log(`      [info] removed ${emptied.length} member(s); ${(now.project?.members || []).length} left`)
    check('S5.1 project survives losing every member (no 500 / no broken detail)',
      now.ok === true, `ok=${now.ok} left=${(now.project?.members || []).length}`)
  } finally {
    // restore the SEEDED roster (not "whatever S5 saw") so the shared store is
    // exactly as the official smokes expect it
    for (const m of SEEDED) {
      await authedPost('/project-member-set',
        { projectId: CS_PROJECT, principal: m.principal, bundle: m.bundle }, admin)
    }
    const restored = await authedGet(`/project-detail?id=${CS_PROJECT}`, carol)
    const got = (restored.project?.members || [])
    check('S5.2 SEEDED roster restored (alice:builder + carol:lead) — shared store left clean',
      SEEDED.every(s => got.some(m => m.principal === s.principal && m.bundle === s.bundle)),
      got.map(m => `${m.principal}:${m.bundle}`).join(',') || '(none)')
  }
}

console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
