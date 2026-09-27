// T07 Phase-1 gate: the adversarial matrix (reviewer A1/A2/A3/A6) + SSO login
// journey + the rendered-DOM hygiene sweep (H1). Consolidates the checks that
// gate Phase 1 (login, tenancy, scoping, de-mock) into one permanent file.
// T11 added the approval-workflow matrix rows A4/A5/A7/A8.
// Run: node e2e/smoke-gate.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openAdminOps } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

// Raw HTTP status helpers — the matrix asserts status codes, not bodies.
const rawGet = (p, token) =>
  fetch(BASE + '/api' + p, token ? { headers: { authorization: 'Bearer ' + token } } : {}).then(r => r.status)
const rawPost = (p, body, token) =>
  fetch(BASE + '/api' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  }).then(r => r.status)

// ---------- A1: every /api/* requires a valid session (no exemptions) ----------
for (const p of ['/blueprints', '/catalog', '/fleet', '/costs', '/registry', '/domains', '/memories', '/obs-traces?agent=supportdesk'])
  check(`A1 no session -> 401 on GET ${p}`, await rawGet(p) === 401)
check('A1 no session -> 401 on POST /generate', await rawPost('/generate', {}) === 401)
check('A1 no session -> 401 on POST /agent-detail', await rawPost('/agent-detail', { project: 'supportdesk' }) === 401)
check('A1 forged token -> 401', await rawGet('/fleet', 'not-a-real-token') === 401)
check('A1 unknown user cannot log in (401)', await rawPost('/login', { user: 'mallory', idp: 'okta' }) === 401)

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')
const bob = await apiLogin('bob')
const carol = await apiLogin('carol')

// A1 sessions die on logout — a replayed token is rejected.
const doomed = await apiLogin('alice')
await rawPost('/logout', {}, doomed.token)
check('A1 logged-out token replay -> 401', await rawGet('/fleet', doomed.token) === 401)

// ---------- A2: foreign-domain resource by ID -> 404, never an empty 200 ----------
check('A2 bob -> supportdesk agent-detail -> 404', await rawPost('/agent-detail', { project: 'supportdesk' }, bob.token) === 404)
check('A2 bob -> supportdesk eval-runs -> 404', await rawGet('/eval-runs?project=supportdesk', bob.token) === 404)
check('A2 bob -> supportdesk eval-dataset -> 404', await rawGet('/eval-dataset?project=supportdesk', bob.token) === 404)
check('A2 bob -> supportdesk obs-traces -> 404', await rawGet('/obs-traces?agent=supportdesk', bob.token) === 404)
check('A2 bob -> supportdesk agent metrics -> 404', await rawGet('/metrics?scope=agent&id=supportdesk', bob.token) === 404)
check('A2 bob -> foreign domain metrics -> 404', await rawGet('/metrics?scope=domain&id=customer-support', bob.token) === 404)
check('A2 bob -> fleet-rollup metrics -> 404 (scoped sessions have no fleet scope)', await rawGet('/metrics?scope=fleet&id=all', bob.token) === 404)
check('A2 bob -> supportdesk online-eval -> 404', await rawGet('/online-eval?scope=agent&id=supportdesk', bob.token) === 404)
check('A2 bob -> fleet-rollup online-eval -> 404', await rawGet('/online-eval?scope=fleet&id=all', bob.token) === 404)
check('A2 bob cannot grant HIMSELF access to a foreign agent -> 404', await rawPost('/obs-access-request', { kind: 'trace', id: 'supportdesk' }, bob.token) === 404)
check('A2 alice -> opsassistant agent-detail -> 404', await rawPost('/agent-detail', { project: 'opsassistant' }, alice.token) === 404)
check('A2 alice -> operations registry entry decide -> 404', await rawPost('/registry-decide', { id: 'it-troubleshooting', decision: 'approve', semver: '1.0.0' }, alice.token) === 404)
// Memory content is a domain resource too: any memory the admin sees but bob's
// scoped list omits must 404 for bob by ID (data-driven; skip if none attached).
const adminMems = (await authedGet('/memories', admin)).memories || []
const bobMemIds = new Set(((await authedGet('/memories', bob)).memories || []).map(m => m.id))
const foreignMem = adminMems.find(m => !bobMemIds.has(m.id))
if (foreignMem) check(`A2 bob -> foreign memory extractions (${foreignMem.id}) -> 404`, await rawGet('/memory-extractions?memoryId=' + encodeURIComponent(foreignMem.id), bob.token) === 404)
else console.log('SKIP  A2 foreign-memory check (no memory attached to a foreign-domain agent)')

// ---------- A3: the legacy ?access=granted URL param is dead ----------
check('A3 ?access=granted on obs-traces -> 403 (admin)', await rawGet('/obs-traces?agent=supportdesk&access=granted', admin.token) === 403)
check('A3 ?access=granted on obs-traces -> 403 even for the domain owner (alice)', await rawGet('/obs-traces?agent=supportdesk&access=granted', alice.token) === 403)
check('A3 ?access=granted on memory-extractions -> 403', await rawGet('/memory-extractions?memoryId=x&access=granted', admin.token) === 403)

// ---------- T10 (WS-B inversion): no content path from a platform session ----------
// J1.5: no route/tab/button/API reachable from an admin session returns trace
// payloads or memory content. The API side: content routes + the grant endpoint
// all 403 for admin (and for end-user — content is domain-plane ONLY).
const enduser = await apiLogin('enduser')
check('T10 admin -> obs-traces -> 403 (content is domain-plane only)', await rawGet('/obs-traces?agent=supportdesk', admin.token) === 403)
check('T10 admin -> memory-extractions -> 403', await rawGet('/memory-extractions?memoryId=x', admin.token) === 403)
check('T10 admin -> obs-access-request -> 403 (cannot even self-grant)', await rawPost('/obs-access-request', { kind: 'trace', id: 'supportdesk' }, admin.token) === 403)
check('T10 end user -> obs-traces -> 403', await rawGet('/obs-traces?agent=supportdesk', enduser.token) === 403)
check('T10 end user -> obs-access-request -> 403', await rawPost('/obs-access-request', { kind: 'trace', id: 'supportdesk' }, enduser.token) === 403)
// Self-heal (R-016/R-017 hermeticity): the grant store is in-memory and
// accumulates on a long-lived server. A LIVE grant or an OPEN (pending)
// alice/trace/supportdesk request left by an earlier suite file would hijack
// the idempotent 5s request below (createGrantRequest returns the open request
// instead of a new one) and break A8's per-request expiry. Drop both first.
await authedPost('/obs-access-revoke', { kind: 'trace', id: 'supportdesk' }, alice)
{
  const stale = ((await authedGet('/grant-requests?type=trace', alice)).requests || [])
    .find(r => r.resourceId === 'supportdesk' && r.requestedBy === 'alice' && r.status === 'pending')
  if (stale) await authedPost('/obs-access-decide', { requestId: stale.id, decision: 'reject' }, carol)
}
// D9: seconds-scale duration — this same 5s request is approved + expiry-tested in A8 below.
check('T10 alice (domain plane) can still file an access request', await rawPost('/obs-access-request', { kind: 'trace', id: 'supportdesk', justification: 'A-matrix: approval-flow checks (5s grant for A8 expiry)', durationS: 5 }, alice.token) === 200)

// ---------- T11 approval workflow: A4 / A5 / A7 / A8 ----------
// R2/D2: same-domain Domain Lead approves, requester ≠ approver. D9: duration
// is a request parameter (seconds granularity), expiry enforced per-request.
const jpost = (p, body, token) =>
  fetch(BASE + '/api' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  }).then(r => r.json())
// A7: builders (and platform/end-user sessions) cannot decide requests at all.
const aliceReq = (await jpost('/obs-access-request', { kind: 'trace', id: 'supportdesk', justification: 'A-matrix: approval-flow checks', durationS: 5 }, alice.token)).request
check('A7 direct POST to the approval endpoint as a builder -> 403', await rawPost('/obs-access-decide', { requestId: aliceReq.id, decision: 'approve' }, bob.token) === 403)
check('A7 approval endpoint as admin -> 403 (deciding is a domain-lead power)', await rawPost('/obs-access-decide', { requestId: aliceReq.id, decision: 'approve' }, admin.token) === 403)
check('A7 approval endpoint without a session -> 401', await rawPost('/obs-access-decide', { requestId: aliceReq.id, decision: 'approve' }) === 401)
// A5: bob's Operations request stays pending — there is NO lead in Ops to
// approve it, and carol (Support lead) cannot see it (foreign domain -> 404).
const bobReq = (await jpost('/obs-access-request', { kind: 'trace', id: 'opsassistant', justification: 'A5: ops request with no lead to approve it', durationS: 3600 }, bob.token)).request
check('A5 bob (Ops, no domain lead) request is created but stays pending', bobReq.status === 'pending')
check('A5 foreign-domain lead cannot decide it -> 404', await rawPost('/obs-access-decide', { requestId: bobReq.id, decision: 'approve' }, carol.token) === 404)
check('A5 bob still locked (no self-serve escalation path)', (await authedGet('/obs-traces?agent=opsassistant', bob)).locked === true)
// A4: requester ≠ approver — a lead cannot approve their OWN request.
const carolReq = (await jpost('/obs-access-request', { kind: 'trace', id: 'supportdesk', justification: 'A4: lead requesting for herself', durationS: 3600 }, carol.token)).request
check('A4 self-approval rejected (requester = approver) -> 403', await rawPost('/obs-access-decide', { requestId: carolReq.id, decision: 'approve' }, carol.token) === 403)
// Ownership-plane default (2026-07-27): the lead OWNS her domain's data plane —
// own-domain traces are open by DEFAULT (masked), no self-approval loop needed.
const carolOwn = await authedGet('/obs-traces?agent=supportdesk', carol)
check('A4 carol (lead) reads own-domain traces by default — own plane, masked, no grant',
  carolOwn.locked === false && carolOwn.ownPlane === true && !carolOwn.grant && carolOwn.traces.every(t => t.masked === true))
// A8: a seconds-scale grant (D9: no test-mode backdoors) expires per-request —
// the replay is blocked AND leaves an audit entry.
const approved = await jpost('/obs-access-decide', { requestId: aliceReq.id, decision: 'approve' }, carol.token)
check('A8 setup: carol approves alice\'s 5s grant', approved.ok === true && approved.request.expiresAt !== null)
check('A8 setup: grant works while live', (await authedGet('/obs-traces?agent=supportdesk', alice)).locked === false)
await new Promise(s => setTimeout(s, 5500))
const replay = await authedGet('/obs-traces?agent=supportdesk', alice)
check('A8 expired grant replay is blocked (locked again, per-request expiry)', replay.locked === true && replay.request?.status === 'expired')
check('A8 expiry wrote an audit entry', (await authedGet('/obs-audit', alice)).events.some(e => e.action === 'access-expired' && e.requestId === aliceReq.id))
// J1.6: the admin sees request METADATA (who/why/duration/status) — never content.
const adminReqs = (await authedGet('/obs-access-requests', admin)).requests
check('T11 admin sees grant metadata for all domains', adminReqs.some(r => r.requestedBy === 'alice') && adminReqs.some(r => r.requestedBy === 'bob'))
check('T11 metadata surface carries no content fields', adminReqs.every(r => !r.input && !r.output && !r.text && !r.traces))
check('T11 end user cannot list access requests -> 403', await rawGet('/obs-access-requests', enduser.token) === 403)

// ---------- Scoping: admin sees both domains; builders are disjoint ----------
const roster = (await authedGet('/domains', admin)).domains
check('domains roster is data-driven with 3 domains (incl. Platform)', roster.length === 3 && roster.some(d => d.id === 'customer-support') && roster.some(d => d.id === 'operations') && roster.some(d => d.id === 'platform'))
const adminReg = (await authedGet('/registry', admin)).entries
const aliceReg = (await authedGet('/registry', alice)).entries
const bobReg = (await authedGet('/registry', bob)).entries
check('admin registry covers both domains', adminReg.some(e => e.domain === 'customer-support') && adminReg.some(e => e.domain === 'operations'))
check('scoped registries are disjoint on domain-owned entries',
  !aliceReg.some(e => e.domain === 'operations') && !bobReg.some(e => e.domain === 'customer-support'))
const adminScopes = await authedGet('/obs-scopes', admin)
check('admin obs scopes include fleet + both domains',
  !!adminScopes.fleet && ['customer-support', 'operations'].every(d => adminScopes.domains.some(x => x.id === d)))
// T24: every really-deployed fleet agent with a local project must be selectable
// in the admin obs drill-down (Fleet → Obs drill-down lands on agent:<project>).
const fleetProjects = (await authedGet('/fleet', admin)).agents.filter(a => a.project).map(a => a.project)
const adminScopeIds = new Set(adminScopes.domains.flatMap(d => d.agents.map(a => a.id))
  .concat((adminScopes.shared || []).map(a => a.id)))
check(`T24 admin obs scopes cover all ${fleetProjects.length} fleet projects`,
  fleetProjects.every(p => adminScopeIds.has(p)))
const aliceScopes = await authedGet('/obs-scopes', alice)
check('alice obs scopes: own domain only, no fleet rollup',
  !aliceScopes.fleet && aliceScopes.domains.length === 1 && aliceScopes.domains[0].id === 'customer-support')
check('T24 alice gets no platform-shared scope entries', (aliceScopes.shared || []).length === 0)
const carolScopes = await authedGet('/obs-scopes', carol)
check('carol (lead) is scoped exactly like a same-domain builder',
  !carolScopes.fleet && carolScopes.domains.length === 1 && carolScopes.domains[0].id === 'customer-support')

// ---------- SSO tiles: all three IdPs land a real signed-in session ----------
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const freshLoginPage = async () => {
  await page.goto(BASE)
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE)
  await page.waitForSelector('.idptile')
}
const IDP_CASES = [
  ['okta', 'melanie', 'Platform Admin'],
  ['entra', 'carol', 'Domain Lead'],
  ['cognito', 'bob', 'Domain Builder'],
]
for (const [idp, user, role] of IDP_CASES) {
  await freshLoginPage()
  await page.locator(`.idptile[data-idp="${idp}"]`).click()
  await page.waitForSelector(`.usertile[data-loginuser="${user}"]`)
  await page.locator(`.usertile[data-loginuser="${user}"]`).click()
  await page.waitForSelector('#whoami')
  check(`SSO tile ${idp} -> ${user} signed in as ${role}`, (await page.locator('#rolechip').textContent()) === role)
}
// End User tile: silent session, zero extra clicks, and the token is real.
await freshLoginPage()
await page.locator('.idptile[data-idp="okta"]').click()
await page.waitForSelector('.usertile[data-loginuser="enduser"]')
await page.locator('.usertile[data-loginuser="enduser"]').click()
await page.waitForSelector('#whoami')
check('End User tile silently issues a session (D8)', (await page.locator('#whoami').textContent()).includes('End User'))
check('End User session token is accepted by the API', await page.evaluate(async () => {
  const s = JSON.parse(localStorage.getItem('console.session'))
  return (await fetch('/api/blueprints', { headers: { authorization: 'Bearer ' + s.token } })).status
}) === 200)

// ---------- A6: devtools tampering of the stored session has no server effect ----------
await uiLogin(page, 'alice')
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('console.session'))
  s.role = 'admin'; s.domain = null   // client-side lie
  localStorage.setItem('console.session', JSON.stringify(s))
})
await page.goto(BASE)
await page.waitForSelector('#whoami')
// The tampered client renders the ADMIN shell (role lie is client-side), so
// Agent Fleet opens via Platform Console Home › Operations — the server data
// stays alice-scoped regardless.
await openAdminOps(page, 'fleet')
await page.waitForFunction(() => {
  const b = document.getElementById('fleetbox')
  return b && !b.querySelector('.spin')
}, null, { timeout: 60000 })
const aliceFleet = ((await authedGet('/fleet', alice)).agents || [])
const tamperedRows = await page.locator('#fleetbox tbody tr').count()
check(`A6 tampered role/domain fields change nothing server-side (fleet rows still alice's ${aliceFleet.length})`,
  tamperedRows === aliceFleet.length || (aliceFleet.length === 0 && (await page.locator('#fleetbox .empty').count()) === 1))
check('A6 tampered session leaks no Operations-domain data', !(await page.locator('#fleetbox').textContent()).includes('Operations'))

// ---------- H1: rendered-DOM hygiene sweep — zero mock/simulated wording ----------
// PRIMARY de-mock check (SPEC S5/H1): every nav view for every persona, plus
// both login steps. details elements are force-opened before scanning.
const BANNED = /mock|simulated|\[sim\]/i
const scanDom = async (label) => {
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true }))
  const txt = await page.evaluate(() => document.body.innerText)
  const m = txt.match(BANNED)
  check(`H1 ${label}: no mock/simulated wording in rendered DOM`, !m)
  if (m) console.log(`      banned match "${m[0]}" near: …${txt.slice(Math.max(0, m.index - 60), m.index + 60).replace(/\s+/g, ' ')}…`)
}
await freshLoginPage()
await scanDom('login step 1 (IdP picker)')
await page.locator('.idptile[data-idp="okta"]').click()
await page.waitForSelector('.usertile')
await scanDom('login step 2 (account picker)')
// TLP-B2 shells: each persona's nav is a distinct list — sweep every entry
// and gate each stop on its expected h1 (workspace h1 = the project name for
// builder tabs; Domain Console = '<domain> · <section>'; Platform Console =
// 'Platform Console…'; admin registry/governance/blueprints h1s unchanged).
// Workspace stops used to anchor on the 📁 emoji in the h1; the tlp-skin
// reskin replaced emoji icons with SVG, so they anchor on the structural
// #wsbody container instead (h1 there is the project name — not stable text).
const WORKSPACE = '__WORKSPACE__'
const BUILDER_SWEEP = [
  ['fleet', WORKSPACE], ['build', 'Build an Agent'], ['memorykb', WORKSPACE],
  ['cost', WORKSPACE], ['obs', 'Observability'], ['registry', 'AI Registry'],
]
const SHELL_SWEEP = {
  // TLP-B9 (spec v2.5 §2) sidebar IA: PLATFORM governance section (operations
  // drill-downs as top-level stops) + the persistent BUILD WORKSPACE section
  // (bw-prefixed ids, isomorphic with BUILDER_SWEEP, workspace stops anchor
  // on #wsbody like the builder ones).
  melanie: [
    ['home', 'Platform Console'], ['domains', 'Domains'],
    ['blueprints', 'Blueprints'], ['cost', 'Cost'],
    ['monitoring', 'Platform Monitoring'],
    ['registry', 'AI Registry'], ['governance', 'Governance'],
    // B13: admin bwregistry removed (duplicate of the org-level AI Registry).
    ['bwfleet', WORKSPACE], ['bwbuild', 'Build an Agent'], ['bwmemorykb', WORKSPACE],
    ['bwcost', WORKSPACE], ['bwobs', 'Observability'],
  ],
  alice: BUILDER_SWEEP,
  bob: BUILDER_SWEEP,
  carol: [
    ['dashboard', 'Customer Support · Dashboard'], ['projects', 'Customer Support · Projects'],
    ['users', 'Customer Support · Users & Access'], ['governance', 'Governance'],
  ],
  enduser: [['overview', 'Agentic AI Platform'], ['fleet', 'Agents']],
}
for (const user of ['melanie', 'alice', 'bob', 'carol', 'enduser']) {
  await uiLogin(page, user)
  for (const [id, h1] of SHELL_SWEEP[user]) {
    await page.locator(`.nav[data-shellnav="${id}"]`).click()
    await page.waitForFunction(src => {
      if (src === '__WORKSPACE__') return !!document.querySelector('#wsbody')
      const h = document.querySelector('main h1')
      return h && new RegExp(src).test(h.textContent)
    }, h1, { timeout: 60000 })
    await page.waitForFunction(() => !document.querySelector('#main .spin'), null, { timeout: 60000 }).catch(() => {})
    await page.waitForTimeout(250)
    await scanDom(`${user} / ${id}`)
  }
}

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
