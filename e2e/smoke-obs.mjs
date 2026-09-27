import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// Obs smoke: Platform Observability (aggregate, scope drill-down fleet→domain→
// agent with numbers that actually change) + Domain Builder permission-gated
// Traces (locked → request access → synthetic content). All figures are a
// [illustrative]; content traces are gated by an [illustrative] elevated-access step.
// Run: node e2e/smoke-obs.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openAdminOps } from './login.mjs'

const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const admin = await apiLogin('melanie')
const apiGet = p => authedGet(p, admin)

// --- API-level: scope drill-down must shrink volume metrics (falsifiable) ---
const fleetM = await apiGet('/metrics?scope=fleet&id=all')
const domM = await apiGet('/metrics?scope=domain&id=customer-support')
const agM = await apiGet('/metrics?scope=agent&id=supportdesk')
check('fleet invocations > domain > agent (volume rolls up)',
  fleetM.series.invocations.total > domM.series.invocations.total &&
  domM.series.invocations.total > agM.series.invocations.total)
// T03: domains are data-driven (console/domains.json) — 2 real domains now.
check('per-domain cost breakdown present at fleet scope (chargeback)',
  Array.isArray(fleetM.domains) && fleetM.domains.length >= 2 && fleetM.domains.every(d => typeof d.costUsd === 'number'))
check('metrics carry the synthetic-data flag (honest API labeling)', fleetM.mock === true)
check('same scope is deterministic (stable across calls)',
  (await apiGet('/metrics?scope=agent&id=supportdesk')).series.invocations.total === agM.series.invocations.total)

// --- T09: online eval (production sampled scoring) reconciles with real numbers (D7/H2) ---
// Denominators come from the real usage ledger; on a FRESH clone the ledger is
// empty until a journey test invokes an agent, so the reconciliation checks are
// data-driven (skip pattern, same as smoke-gate's foreign-memory check).
const oe = await apiGet('/online-eval?scope=agent&id=supportdesk')
check('online-eval carries the synthetic-scores flag + day shape (honest API labeling)',
  oe.scoresSimulated === true && Array.isArray(oe.days))
if (oe.days.length) {
  check('online-eval samples <= real invocations on EVERY day (D7)',
    oe.days.every(d => d.samples >= 1 && d.samples <= d.invocations))
  check('online-eval totals reconcile (samples <= invocations)',
    oe.totals.samples <= oe.totals.invocations)
  const costRow = (await apiGet('/costs')).perAgent.find(a => a.project === 'supportdesk')
  check('online-eval invocation denominators come from the same ledger the Cost page uses (H2)',
    costRow && oe.totals.invocations <= costRow.invocations && oe.totals.invocations >= 1)
  check('online-eval judge scores are 0-1', oe.days.every(d => d.score >= 0 && d.score <= 1))
  check('online-eval is deterministic (stable across calls)',
    JSON.stringify((await apiGet('/online-eval?scope=agent&id=supportdesk')).days) === JSON.stringify(oe.days))
  const oeFleet = await apiGet('/online-eval?scope=fleet&id=all')
  check('fleet-scope online-eval aggregates at least the agent slice',
    oeFleet.totals.invocations >= oe.totals.invocations && typeof oeFleet.score.avg === 'number')
} else console.log('SKIP  T09 reconciliation checks (fresh ledger — no recorded supportdesk invocations yet)')

// --- API-level: traces are gated (grant lives on the SERVER session, T02B) ---
// T10 (WS-B inversion): content routes are DOMAIN-plane only — the grant/reveal
// flow below runs as alice (Support builder). Admin gets 403 on all of them.
const alice = await apiLogin('alice')
const aliceGet = p => authedGet(p, alice)
const carol = await apiLogin('carol')
// Self-heal (R-016/R-017 hermeticity): the grant store is in-memory and
// accumulates on a long-lived server — drop any live alice grant and reject
// any stale open request from an earlier suite file so default-deny is
// testable (same pattern as smoke-domain-governance / smoke-segregation).
await authedPost('/obs-access-revoke', { kind: 'trace', id: 'supportdesk' }, alice)
{
  const stale = ((await authedGet('/grant-requests?type=trace', alice)).requests || [])
    .find(r => r.resourceId === 'supportdesk' && r.requestedBy === 'alice' && r.status === 'pending')
  if (stale) await authedPost('/grant-decide', { requestId: stale.id, decision: 'reject' }, carol)
}
const rawStatusAs = (p, session) => fetch((process.env.CONSOLE_BASE || 'http://localhost:4000') + '/api' + p, { headers: { authorization: 'Bearer ' + session.token } }).then(r => r.status)
check('T10 admin -> obs-traces is 403 (no content path from a platform session)',
  await rawStatusAs('/obs-traces?agent=supportdesk', admin) === 403)
check('T10 admin -> memory-extractions is 403', await rawStatusAs('/memory-extractions?memoryId=x', admin) === 403)
check('T10 admin cannot self-grant content access (403)',
  await fetch((process.env.CONSOLE_BASE || 'http://localhost:4000') + '/api/obs-access-request', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token }, body: JSON.stringify({ kind: 'trace', id: 'supportdesk' }) }).then(r => r.status) === 403)
const locked = await aliceGet('/obs-traces?agent=supportdesk')
check('traces locked without elevated access (no content returned)', locked.locked === true && !locked.traces)
// A3: the legacy ?access=granted query param is dead — 403, param ignored.
const rawStatus = p => rawStatusAs(p, alice)
check('legacy ?access=granted on obs-traces returns 403', await rawStatus('/obs-traces?agent=supportdesk&access=granted') === 403)
check('legacy ?access=granted on memory-extractions returns 403', await rawStatus('/memory-extractions?memoryId=x&access=granted') === 403)
// T11: a request is no longer an instant grant — it needs a justification +
// duration and a SAME-DOMAIN Domain Lead's approval before content unlocks.
const noWhy = await authedPost('/obs-access-request', { kind: 'trace', id: 'supportdesk', durationS: 3600 }, alice)
check('T11 request without justification is rejected', noWhy.ok === false && /justification/i.test(noWhy.error))
const reqR = await authedPost('/obs-access-request', { kind: 'trace', id: 'supportdesk', justification: 'triage refund loop ticket 4521', durationS: 14400 }, alice)
check('T11 obs-access-request creates a PENDING request (not a grant)', reqR.ok === true && reqR.request.status === 'pending')
check('T11 traces stay locked while the request is pending',
  (await aliceGet('/obs-traces?agent=supportdesk')).locked === true)
const approveR = await authedPost('/obs-access-decide', { requestId: reqR.request.id, decision: 'approve' }, carol)
check('T11 same-domain lead approval activates the grant with an expiry',
  approveR.ok === true && approveR.request.status === 'approved' && !!approveR.request.expiresAt)
const opened = await aliceGet('/obs-traces?agent=supportdesk')
check('T11 unlocked response names the approver + expiry', opened.grant?.approvedBy === 'carol' && !!opened.grant?.expiresAt)
check('traces returned only with access, flagged synthetic in the API', opened.locked === false && opened.simulated === true && opened.traces.length > 0)
check('trace records carry input + output + tools', opened.traces.every(t => t.input && t.output && Array.isArray(t.tools)))

// --- T32: masking is always on, even after access is granted ---
check('masked traces carry full-span placeholders, not partial retention',
  opened.traces.every(t => t.masked === true) &&
  opened.traces.some(t => /<EMAIL>|<PHONE>|<ORDER_ID>/.test(t.input + t.output)) &&
  !opened.traces.some(t => /\d{3,6}/.test((t.output.match(/<ORDER_ID>|#\d+/g) || []).join(''))))

// --- T33: reveal unmasks one trace + writes an audit event; revoke re-masks ---
const targetTrace = opened.traces[0].traceId
const revealed = await aliceGet('/obs-traces?agent=supportdesk&revealed=' + targetTrace)
const revealedTrace = revealed.traces.find(t => t.traceId === targetTrace)
check('revealed trace is unmasked', revealedTrace.masked === false)
check('other traces stay masked while one is revealed',
  revealed.traces.filter(t => t.traceId !== targetTrace).every(t => t.masked === true))
const auditBefore = (await aliceGet('/obs-audit')).events.length
const revealPost = await authedPost('/obs-audit', { agentId: 'supportdesk', traceId: targetTrace, action: 'reveal' }, alice)
check('reveal writes an audit event', revealPost.ok === true && revealPost.event.action === 'reveal')
const auditAfterReveal = await aliceGet('/obs-audit')
// the store is intentionally capped at 200 events (appendObsAudit drops the
// oldest) — once saturated, length stays 200; persistence is proven by the
// new event sitting at the top of the store.
check('audit event exists in the store after reveal',
  auditAfterReveal.events.length === Math.min(auditBefore + 1, 200) &&
  auditAfterReveal.events[0].traceId === targetTrace && auditAfterReveal.events[0].action === 'reveal')
// T10: the admin still sees GRANT METADATA (who/when/what) via the audit trail — never content.
const adminAudit = await apiGet('/obs-audit')
check('T10 admin sees reveal-event metadata in the audit trail (who/what, no content)',
  (adminAudit.events || []).some(e => e.traceId === targetTrace && e.who === 'alice') &&
  (adminAudit.events || []).every(e => !e.input && !e.output && !e.text))
const revokePost = await authedPost('/obs-audit', { agentId: 'supportdesk', traceId: targetTrace, action: 'revoke' }, alice)
check('revoke also writes an audit event', revokePost.ok === true && revokePost.event.action === 'revoke')
const reRevoked = await aliceGet('/obs-traces?agent=supportdesk')  // no revealed param -> re-masked
check('after revoke (no reveal param), trace is masked again', reRevoked.traces.find(t => t.traceId === targetTrace).masked === true)
// T11: grants attach to the USER identity (carol approved alice the person, not
// a browser tab) — a fresh session for the same user keeps the active grant.
const freshAlice = await apiLogin('alice')
const freshOpened = await authedGet('/obs-traces?agent=supportdesk', freshAlice)
check('T11 an approved grant follows the user across sessions', freshOpened.locked === false)
// ...and a DIFFERENT same-domain user never inherits it: carol holds no grant
// of her own — she reads by OWNERSHIP (lead of this domain's plane), not by
// alice's grant (ownership-plane default, 2026-07-27).
const freshCarol = await authedGet('/obs-traces?agent=supportdesk', carol)
check('T11 the grant is per-user (carol reads via own plane, not alice\'s grant)',
  freshCarol.locked === false && freshCarol.ownPlane === true && !freshCarol.grant)
const revoke = await authedPost('/obs-access-revoke', { kind: 'trace', id: 'supportdesk' }, alice)
check('obs-access-revoke drops the grant server-side', revoke.ok === true && (await aliceGet('/obs-traces?agent=supportdesk')).locked === true)
check('T11 revocation is audited', (await aliceGet('/obs-audit')).events.some(e => e.action === 'access-revoked' && e.who === 'alice'))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
await uiLogin(page, 'melanie')

// --- Platform Admin: aggregate Monitoring view renders, scope switch changes the DOM ---
await openAdminOps(page, 'monitoring')
await page.waitForSelector('#obsbox .item')
// B14: the admin's aggregate entry is its own route with its own H1 — the
// nav label and page title match ('Platform Monitoring'), distinct from the
// build workspace's content-level 'Observability'.
check('admin Monitoring H1 is "Platform Monitoring" (matches the nav label)',
  (await page.locator('main h1').first().textContent()).trim() === 'Platform Monitoring')
check('admin monitoring renders stat cards', (await page.locator('#obsbox .item').count()) >= 6)
check('admin monitoring renders SVG layer charts', (await page.locator('#obsbox svg').count()) >= 4)
check('scope selector offers fleet + domains only (no per-agent scope — B14 aggregate boundary)',
  (await page.locator('#obsscope option').count()) >= 3 &&
  (await page.locator('#obsscope option').evaluateAll(o => o.every(x => !x.value.startsWith('agent:')))))
check('content-level traces explicitly NOT shown to platform (governance note)',
  (await page.locator('main').textContent()).includes('Content-level traces are not shown here'))
// T09: platform obs shows the AGGREGATE online-eval quality score only — no per-day trend table.
await page.waitForSelector('#oebox .card')
const oeAdminTxt = await page.locator('#oebox').textContent()
check('admin obs shows the online-eval card', oeAdminTxt.includes('Online evaluation'))
if (oe.days.length) {
  check('admin online-eval shows aggregate quality score only', oeAdminTxt.includes('Aggregate quality score'))
  check('admin online-eval card has NO per-day trend table (detail is domain-owned)',
    (await page.locator('#oebox table').count()) === 0 && oeAdminTxt.includes('builder view'))
}
const firstStatFleet = await page.locator('#obsbox .item h4').first().textContent()
await page.selectOption('#obsscope', 'domain:customer-support')
await page.waitForFunction(prev => document.querySelector('#obsbox .item h4')?.textContent !== prev, firstStatFleet)
check('switching scope (fleet → domain) re-renders metrics with different numbers',
  (await page.locator('#obsbox .item h4').first().textContent()) !== firstStatFleet)
await page.screenshot({ path: SHOT_DIR + 't22-obs-platform.png', fullPage: true })

// --- B14 (supersedes R-B10-05/TLP-B10.1): Platform Monitoring (view
// 'monitoring') and the Build Workspace's Observability (view
// 'observability', bwobs) are now SEPARATE ROUTES with separate view
// functions. The two pages must be visually distinct: different H1s,
// different persona banners, no trace element on Monitoring, no
// platform-wide aggregate on bwobs. ---
await openAdminOps(page, 'monitoring')
await page.waitForSelector('#obsscopechip')
const monitoringScope = await page.locator('#obsscopechip').textContent()
check('Monitoring entry shows the platform-aggregate scope chip', monitoringScope.includes('Platform-wide aggregates'))
check('Monitoring entry has NO Platform traces tab at all (aggregate-only governance view)',
  (await page.locator('.obstab', { hasText: 'Platform traces' }).count()) === 0)
check('Monitoring entry still has Metrics + Alerts tabs', (await page.locator('.obstab').count()) === 2)
check('Monitoring page has NO trace DOM elements at all (B14 boundary)',
  (await page.locator('#tracebox').count()) === 0 &&
  (await page.locator('#traceagent').count()) === 0)
const monitoringBanner = await page.locator('#storyline').textContent()
const monitoringMain = await page.locator('main').textContent()
check('Monitoring page carries no decorative illustrative/demo-grade chips (B14 chip cleanup)',
  !monitoringMain.includes('demo-grade pattern masking') &&
  (await page.locator('main .chip', { hasText: 'illustrative' }).count()) === 0)
await page.locator('.nav[data-shellnav="bwobs"]').click()
await page.waitForSelector('#obsscopechip')
check('bwobs H1 is "Observability" (distinct from Platform Monitoring)',
  (await page.locator('main h1').first().textContent()).trim() === 'Observability')
const bwobsScope = await page.locator('#obsscopechip').textContent()
check('bwobs entry shows a different (build-workspace) scope chip', bwobsScope !== monitoringScope && bwobsScope.includes('Build workspace'))
check('bwobs entry lands on trace detail by DEFAULT (first screen), not Metrics',
  (await page.locator('.obstab.primary').textContent()).includes('Platform traces'))
await page.waitForSelector('#tracebox .item', { timeout: 15000 })
check('bwobs first screen renders trace content directly (no extra click needed)',
  (await page.locator('#tracebox .item').count()) >= 1)
const bwobsBanner = await page.locator('#storyline').textContent()
check('B14: the two pages carry DIFFERENT persona banners (no shared YOU OWN copy)',
  bwobsBanner !== monitoringBanner)
check('bwobs traces carry no decorative illustrative/demo-grade chips (B14 chip cleanup)',
  (await page.locator('#tracebox .chip', { hasText: 'illustrative' }).count()) === 0 &&
  (await page.locator('#tracebox .chip', { hasText: 'demo-grade pattern masking' }).count()) === 0)
// B14 scope no-crosstalk: bwobs Metrics scope selector never offers the
// platform-wide fleet aggregate; only this workspace's domain + its agents.
await page.locator('.obstab', { hasText: 'Metrics' }).click()
await page.waitForSelector('#obsscope')
check('bwobs scope selector has NO fleet/platform-wide option and no foreign domain (B14 boundary)',
  await page.locator('#obsscope option').evaluateAll(o =>
    o.every(x => !x.value.startsWith('fleet:')) &&
    o.filter(x => x.value.startsWith('domain:')).every(x => x.value === 'domain:platform')))
await page.locator('.obstab', { hasText: 'Platform traces' }).click()
await page.waitForSelector('#tracebox .item', { timeout: 15000 })

// --- Ownership-plane defaults (2026-07-27): bwobs (build-workspace, domain
// scope) gives the admin/lead a Platform traces tab for the agents THEIR
// domain owns (own plane, open by default, masked); other domains' agents
// never appear in it.
check('bwobs Platform traces tab opens WITHOUT a grant (own plane)',
  (await page.locator('#tracebox .item').count()) >= 1 &&
  (await page.locator('#tracebox').textContent()).includes('own plane · default access'))
check('bwobs platform traces are masked by default',
  (await page.locator('#tracebox').textContent()).match(/<ORDER_ID>|<EMAIL>|<PHONE>/) !== null ||
  (await page.locator('#tracebox').textContent()).includes('masked by default'))
check('bwobs traces selector offers only Platform-domain agents',
  (await page.locator('#traceagent option').allTextContents()).every(t => !/supportdesk|opsassistant/.test(t)))
await page.locator('.obstab', { hasText: 'Metrics' }).click()
await page.waitForSelector('#obsbox .item')

// Back on Monitoring: aggregate metrics + scope drill-down still work exactly
// as before (no regression to the platform-wide view itself).
await page.locator('.nav[data-shellnav="monitoring"]').click()
await page.waitForSelector('#obsbox .item')


// --- Domain Builder: Metrics tab + permission-gated Traces tab ---
await uiLogin(page, 'alice')
await page.locator('.nav[data-shellnav="obs"]').click()
await page.waitForSelector('.obstab')
check('builder obs has Metrics + Traces + Alerts tabs (T13B)', (await page.locator('.obstab').count()) === 3)
// T09: builder obs Metrics tab shows the per-agent online-eval TREND DETAIL (per-day table).
await page.waitForSelector('#oebox .card')
const oeBuilderTxt = await page.locator('#oebox').textContent()
check('builder obs shows the online-eval card', oeBuilderTxt.includes('Online evaluation'))
if (oe.days.length) {
  check('builder obs shows online-eval trend detail with per-day sampling table',
    (await page.locator('#oebox table tbody tr').count()) >= 1 &&
    oeBuilderTxt.includes('Sampled') && oeBuilderTxt.includes('Judge score'))
  check('builder online-eval names the reconciliation source (usage ledger)', oeBuilderTxt.includes('usage ledger'))
}
await page.locator('.obstab', { hasText: 'Traces' }).click()
await page.waitForSelector('#tracebox .areq')
check('Traces tab is LOCKED by default (elevated access required)',
  (await page.locator('#tracebox .areq-send').count()) === 1 &&
  (await page.locator('#tracebox').textContent()).includes('Elevated access required'))
check('locked state shows NO trace content', (await page.locator('#tracebox .item').count()) === 0)
check('T11 request form asks for justification + duration presets (4h/1h)',
  (await page.locator('#tracebox .areq-why').count()) === 1 &&
  (await page.locator('#tracebox .areq-dur option[value="14400"]').count()) === 1 &&
  (await page.locator('#tracebox .areq-dur option[value="3600"]').count()) === 1)
await page.screenshot({ path: SHOT_DIR + 't22-obs-traces-locked.png', fullPage: true })
// T11: submit the request from the UI, approve it as carol via the API (the
// lead's UI queue is exercised in smoke-gate), reload -> unlocked.
await page.fill('#tracebox .areq-why', 'UI smoke: verifying reveal flow')
await page.click('#tracebox .areq-send')
await page.waitForFunction(() => document.querySelector('#tracebox')?.textContent.includes('pending'), null, { timeout: 15000 })
check('T11 UI shows the pending state after submitting a request',
  (await page.locator('#tracebox').textContent()).includes('awaiting a decision'))
const pendingUi = (await authedGet('/obs-access-requests', carol)).requests.find(r => r.status === 'pending' && r.requestedBy === 'alice')
await authedPost('/obs-access-decide', { requestId: pendingUi.id, decision: 'approve' }, carol)
await page.locator('.obstab', { hasText: 'Metrics' }).click()
await page.locator('.obstab', { hasText: 'Traces' }).click()
await page.waitForSelector('#revokeaccess')
check('lead-approved access unlocks synthetic session traces',
  (await page.locator('#tracebox .item').count()) >= 5)
check('T11 unlocked header names approver + expiry',
  (await page.locator('#tracebox').textContent()).includes('access granted by carol'))
check('unlocked traces show input + output content',
  (await page.locator('#tracebox').textContent()).includes('▸ input') &&
  (await page.locator('#tracebox').textContent()).includes('◂ output'))
// De-text round 2: the illustrative marker is a [synthetic] chip whose tooltip
// carries the "illustrative synthetic data" detail (prose block compressed).
check('unlocked traces carry a synthetic-data marker chip with the illustrative tooltip',
  (await page.locator('#tracebox [data-tracenote="synthetic"]').count()) === 1 &&
  ((await page.locator('#tracebox [data-tracenote="synthetic"]').getAttribute('title')) || '').includes('illustrative'))
check('unlocked traces carry no mock/simulated wording (D6)',
  !/mock|simulated/i.test(await page.locator('#tracebox').textContent()))
// T32: masked by default even after access granted — full-span placeholders, demo-grade copy.
check('traces are masked by default (full-span placeholders)',
  (await page.locator('#tracebox').textContent()).match(/<ORDER_ID>|<EMAIL>|<PHONE>/) !== null)
// De-text round 2: the demo-grade disclaimer moved into the [masked] chip's
// tooltip — the contract (labels itself demo-grade, not production) holds there.
const maskedTitle = (await page.locator('#tracebox [data-tracenote="masked"]').getAttribute('title')) || ''
check('masking chip tooltip labels itself demo-grade, not production PII detection',
  maskedTitle.includes('demo-grade pattern masking') &&
  maskedTitle.includes('not') &&
  maskedTitle.includes('Comprehend'))
await page.screenshot({ path: SHOT_DIR + 't32-trace-masked.png', fullPage: true })
// T33: reveal one trace → unmasked + persistent "access granted · audited" + audit list.
await page.locator('.reveal-toggle', { hasText: 'Reveal PII' }).first().click()
await page.waitForSelector('.reveal-toggle[data-action="revoke"]', { timeout: 15000 })
await page.waitForTimeout(150)
check('revealed trace shows a persistent "access granted · audited" indicator',
  (await page.locator('#tracebox').textContent()).includes('access granted · audited'))
check('"Recently revealed" audit list appears with the revealed trace', (await page.locator('#tracebox').textContent()).includes('Recently revealed'))
await page.screenshot({ path: SHOT_DIR + 't33-reveal-audit.png', fullPage: true })
// revoke re-masks that trace and is itself audited
await page.locator('.reveal-toggle', { hasText: 'Revoke' }).first().click()
await page.waitForSelector('.reveal-toggle[data-action="reveal"]', { timeout: 15000 })
await page.waitForTimeout(150)
check('revoking re-masks the trace', (await page.locator('#tracebox').textContent()).includes('access granted · audited') === false)
check('audit list shows the re-mask event too', (await page.locator('#tracebox').textContent()).includes('re-masked'))
// revoke returns to locked
await page.locator('#revokeaccess').click()
await page.waitForSelector('#tracebox .areq')
check('revoking access re-locks the traces', (await page.locator('#tracebox .areq-send').count()) === 1)

// --- Domain Lead (carol): own-domain traces open by default (ownership plane) ---
await uiLogin(page, 'carol')
// TLP-B2: lead has no Observability nav item — reach it through the governance
// page's story-strip content link ("See the content views").
await page.locator('.nav[data-shellnav="governance"]').click()
await page.waitForSelector('.storynext[data-goview="observability"]')
await page.locator('.storynext[data-goview="observability"]').click()
await page.waitForSelector('.obstab')
await page.locator('.obstab', { hasText: 'Traces' }).click()
await page.waitForSelector('#tracebox .item', { timeout: 15000 })
check('lead Traces tab opens by DEFAULT — no request form, own plane',
  (await page.locator('#tracebox .areq-send').count()) === 0 &&
  (await page.locator('#tracebox').textContent()).includes('own plane · default access'))
check('lead default traces stay masked with the reveal/audit affordance intact',
  (await page.locator('#tracebox').textContent()).match(/<ORDER_ID>|<EMAIL>|<PHONE>/) !== null &&
  (await page.locator('.reveal-toggle').count()) >= 1)

// --- End User: no Observability nav at all ---
await uiLogin(page, 'enduser')
check('end user has no Observability nav', !(await page.locator('.nav').allTextContents()).some(t => t.includes('Observability')))

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
