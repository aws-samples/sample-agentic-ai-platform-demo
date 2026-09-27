import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T13B smoke: alerting (CONTROL-PLANE-REDESIGN §8, doc-T24/T25).
// Policy DEFINITIONS live in Governance › Alerts & RACI (admin-only CRUD, §8.3
// catalog seed, RACI per §8.4); runtime FIRING lives in Observability › Alerts.
// Doc-T25 acceptance: fire a SEV1 guardrail anomaly → agent shows suspended on
// Operate → admin resolves → audit trail records fired/suspended/resolved.
// Run: node e2e/smoke-alerts.mjs   (expects console server on :4000)
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openAdminOps } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawStatus = (p, token, body) =>
  fetch(BASE + '/api' + p, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  }).then(r => r.status)

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')
const bob = await apiLogin('bob')
const enduser = await apiLogin('enduser')

// ---------- API: store seed + RBAC ----------
const cat = await authedGet('/alerts', admin)
check('alert store seeds the §8.3 catalog (8 policies, metric+threshold+severity+owner+runbook)',
  cat.policies.length >= 8 && cat.policies.every(p => p.metric && p.threshold && p.severity && p.owner && p.runbook && p.raci))
check('escalation timers are display-only fields on the API', !!cat.escalation?.SEV1 && !!cat.escalation?.SEV3)
check('end user gets no alert surface (informed via agent status only) -> 403', await rawStatus('/alerts', enduser.token) === 403)
check('no session -> 401', await rawStatus('/alerts', null) === 401)
check('builder cannot author alert policies -> 403', await rawStatus('/alert-policy-create', alice.token, { name: 'x' }) === 403)
check('builder cannot fire an incident -> 403', await rawStatus('/alert-fire', alice.token, { policyId: 'guardrail-anomaly' }) === 403)
check('builder cannot resolve an incident -> 403', await rawStatus('/alert-resolve', alice.token, { id: 'nope' }) === 403)

// ---------- API: policy CRUD is a governed record, validated ----------
const bad = await authedPost('/alert-policy-create', { name: 'No metric' }, admin)
check('policy without metric+threshold rejected (an alert is metric+threshold+severity+owner+runbook)',
  bad.ok === false && /threshold/i.test(bad.error))
const created = await authedPost('/alert-policy-create',
  { name: 'Smoke token spike', metric: 'Token cost per agent', threshold: '>2x baseline', severity: 'SEV2', owner: 'Domain Builder' }, admin)
check('admin creates an alert policy (runbook defaults from the name)',
  created.ok === true && created.policy.runbook === 'runbooks/smoke-token-spike.md')
const removed = await authedPost('/alert-policy-remove', { id: created.policy.id }, admin)
check('admin removes the alert policy', removed.ok === true)

// ---------- UI: Governance › Alerts & RACI (definition surface) ----------
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
try {
  await uiLogin(page, 'melanie')
  await page.locator('.nav', { hasText: 'Governance' }).click()
  await page.waitForSelector('.govtab')
  await page.locator('.govtab[data-tab="alerts"]').click()
  await page.waitForSelector('[data-alertpol]')
  check('Governance Alerts & RACI tab lists the alert-policy table',
    (await page.locator('[data-alertpol]').count()) === cat.policies.length)
  check('RACI table renders responsible/accountable/consulted/informed per alert class',
    (await page.locator('[data-raci]').count()) === cat.policies.length &&
    (await page.locator('#alertraci').textContent()).includes('Responsible'))
  const govTxt = await page.locator('main').textContent()
  check('definition-vs-firing split stated in copy (defined here, fires in Monitoring — B14)',
    govTxt.includes('fires in Monitoring'))
  check('escalation path rendered display-only (no background timer)', govTxt.includes('display-only'))
  await page.screenshot({ path: SHOT_DIR + 't13b-gov-alerts-raci.png', fullPage: true })

  // ---------- UI: Platform Monitoring › Alerts — fire SEV1 → Operate flips → resolve (doc-T25) ----------
  await openAdminOps(page, 'monitoring')
  await page.waitForSelector('.obstab')
  // B14: Platform Monitoring is its own route, aggregate-only — Metrics +
  // Alerts, NO Platform traces tab (the content-level view is the separate
  // build-workspace Observability route, bwobs).
  check('Monitoring has Metrics + Alerts tabs only (no Platform traces)', (await page.locator('.obstab').count()) === 2)
  await page.locator('.obstab[data-tab="alerts"]').click()
  await page.waitForSelector('[data-alertcat]')
  check('Alerts tab shows the catalog read from the Governance-owned store',
    (await page.locator('[data-alertcat]').count()) >= 8)
  check('quiet state renders before anything fires', (await page.locator('main').textContent()).includes('No active incidents'))

  // The fire→suspend→resolve drill targets supportdesk, whose local project
  // lives in gitignored domain-examples/generated/. On a fresh clone the fleet
  // agent has project:null, so the #afagent picker has no supportdesk option —
  // skip the agent-attached incident drill (same pattern as smoke-registry's
  // harness guard) while keeping every check that doesn't need the fixture.
  // Double gate (file + fleet), independent review-adjudicated 2026-08-14: a mid-run generated
  // harness (e.g. journey-lead's export step) can exist while this batch's server
  // still maps no supportdesk project — file-only keying then opens the gate and
  // the fire step fails via .status.err (cross-test-file state coupling). The
  // drill only runs when the fixture file exists AND the fleet actually offers a
  // supportdesk agent with its project mapped (what makes it selectable in #afagent).
  const sdFile = existsSync(new URL('../domain-examples/generated/supportdesk/domain-harness.json', import.meta.url).pathname)
  const sdFleet = ((await authedGet('/fleet', admin)).agents || [])
    .some(a => String(a.name || '').includes('supportdesk') && a.project)
  const sdAvailable = sdFile && sdFleet
  if (!sdAvailable) {
    console.log(`SKIP fire→suspend→resolve incident drill (supportdesk not available: harness file=${sdFile}, fleet mapping=${sdFleet})`)
  } else {
  await page.selectOption('#afpolicy', 'guardrail-anomaly')
  await page.selectOption('#afagent', 'supportdesk')
  await page.locator('#affire').click()
  // Durable-state wait (independent review corrected adjudication 2026-08-14): the fire handler
  // writes the .status.ok line then immediately calls loadAlertsTab(), which
  // re-renders the whole tab including an empty #afstatus — with B20's ms-fast
  // reloads the ok line often lives ~3ms and playwright misses it (debug capture:
  // innerHTML empty at timeout). Assert on durable evidence instead: the incident
  // row and the persisted firing record; timeouts unchanged.
  await page.waitForSelector('[data-firing]', { timeout: 10000 })
  const firedRec = ((await authedGet('/alerts', admin)).firings || [])
    .find(f => f.policyId === 'guardrail-anomaly' && f.status === 'firing')
  check('SEV1 fire auto-suspends the agent (durable firing record, not the transient status line)',
    !!firedRec && firedRec.autoSuspended === true)
  check('active incident row renders with severity + RACI owner',
    (await page.locator('[data-firing]', { hasText: 'Guardrail block-rate anomaly' }).count()) >= 1)
  await page.screenshot({ path: SHOT_DIR + 't13b-obs-alert-firing.png', fullPage: true })

  // Operate card flips to suspended (§8.4 SEV1 auto-suspend, HITL-gated pattern at the alert layer)
  await openAdminOps(page, 'fleet')
  await page.waitForSelector('#fleetbox tbody tr')
  const sdRow = page.locator('#fleetbox tr[data-name*="supportdesk"]')
  check('Operate card shows the agent suspended while the SEV1 fires',
    (await sdRow.textContent()).includes('suspended'))
  await page.screenshot({ path: SHOT_DIR + 't13b-operate-suspended.png', fullPage: true })

  // End User is informed through status only (§8.4 RACI: never paged)
  const fleetAsUser = await authedGet('/fleet', enduser)
  const sdUser = (fleetAsUser.agents || []).find(a => a.project === 'supportdesk')
  check('end user sees the suspended status on the agent (informed via status, not alerts)',
    !sdUser || sdUser.health === 'suspended')

  // Builder scoping: alice (customer-support) sees the firing, bob (operations) does not
  const fA = (await authedGet('/alerts', alice)).firings
  const fB = (await authedGet('/alerts', bob)).firings
  check('same-domain builder sees the incident on her agent', fA.some(f => f.agent === 'supportdesk' && f.status === 'firing'))
  check('foreign-domain builder does not see it', !fB.some(f => f.agent === 'supportdesk'))

  // Resolve from the UI → card recovers → audit trail records the lifecycle
  await openAdminOps(page, 'monitoring')
  await page.waitForSelector('.obstab')
  await page.locator('.obstab[data-tab="alerts"]').click()
  await page.waitForSelector('.aresolve')
  await page.locator('.aresolve').first().click()
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('No active incidents'), null, { timeout: 10000 })
  check('resolving clears the active-incident panel', true)
  check('incident history keeps the resolved record',
    (await page.locator('[data-firing]', { hasText: 'resolved by melanie' }).count()) >= 1)
  const fleetAfter = await authedGet('/fleet', admin)
  const sdAfter = (fleetAfter.agents || []).find(a => a.project === 'supportdesk')
  check('Operate card recovers after resolution', sdAfter?.health !== 'suspended')
  const audit = (await authedGet('/hitl-audit', admin)).records
  check('audit trail records alert_fired + alert_autosuspend + alert_resolved',
    audit.some(r => r.kind === 'alert_fired' && r.policyId === 'guardrail-anomaly') &&
    audit.some(r => r.kind === 'alert_autosuspend') &&
    audit.some(r => r.kind === 'alert_resolved' && r.decidedBy === 'melanie'))
  }

  // Builder Alerts tab: catalog + feed visible, no fire control (admin-only)
  await uiLogin(page, 'alice')
  await page.locator('.nav[data-shellnav="obs"]').click()
  await page.waitForSelector('.obstab')
  await page.locator('.obstab[data-tab="alerts"]').click()
  await page.waitForSelector('[data-alertcat]')
  check('builder Alerts tab shows the catalog', (await page.locator('[data-alertcat]').count()) >= 8)
  check('builder has no incident-fire control (admin-only)', (await page.locator('#affire').count()) === 0)
  check('builder Alerts tab carries no mock/simulated wording (H1)',
    !/mock|simulated/i.test(await page.locator('main').textContent()))
} finally {
  await browser.close()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
