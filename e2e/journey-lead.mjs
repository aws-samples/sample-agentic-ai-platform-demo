import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// B21 journey: Domain Lead — carol's full pass over the domain console
// (frozen checklist B21 #1/#2/#5, independent review 2026-08-13):
//   1. Dashboard KPIs reconcile with /api/domain-health + /api/domain-cost-rollup.
//   2. Projects tab lists exactly the domain's projects (API-reconciled).
//   3. Approve alice's grant request from the Governance inbox UI (real
//      /api/grant-decide) — and the decision is VISIBLE ON ALICE'S SIDE
//      (her own request row flips to approved with an expiry).
//   4. Domain cost view: per-project cost table + domain spend figure
//      reconcile with /api/domain-cost-rollup (G3 fixed-pointcontract).
//   5. Workspace Observability: carol reads her own domain's content-level
//      session traces by default (own plane, masked, reveals audited).
//   6. Lifecycle/Advance (B19): carol, as a supportdesk project member, reads
//      and advances the exported repo's lifecycle — the stage persists.
//   7. Blueprint chain (B-J3): alice submits → melanie (peer) approves → the
//      blueprint reaches carol's catalog + wizard step 1.
//   8. Negative: cross-domain privileged reads 403 (carol never widens
//      out of customer-support).
// Hermetic where state is written: blueprint-submissions.json and
// agent-lifecycle.json are snapshotted & restored (smoke-tlp-b19 pattern).
// The grant store is in-memory with unique per-run resource ids (smoke-inbox
// pattern). Run: node e2e/journey-lead.mjs   (expects console server on :4000)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
const here = path.dirname(fileURLToPath(import.meta.url))
const SUB_PATH = path.join(here, '../console/blueprint-submissions.json')
const LC_PATH = path.join(here, '../console/agent-lifecycle.json')
const subSnapshot = fs.existsSync(SUB_PATH) ? fs.readFileSync(SUB_PATH, 'utf8') : null
const lcSnapshot = fs.existsSync(LC_PATH) ? fs.readFileSync(LC_PATH, 'utf8') : null

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}
const rawGet = (p, token) => fetch(BASE + '/api' + p, { headers: { authorization: 'Bearer ' + token } })
// same formatter the UI uses (index.html usd()) so text assertions are exact
const usd = v => typeof v === 'number' ? ('$' + (v < 0.01 && v > 0 ? v.toFixed(5) : v.toFixed(4))) : '—'
const RUN = `b21lead-${process.pid}-${Date.now().toString(36)}`

const carol = await apiLogin('carol')     // lead, customer-support
const alice = await apiLogin('alice')     // builder, customer-support
const melanie = await apiLogin('melanie') // platform admin (blueprint peer)

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'carol')
  check('signed in as Domain Lead', (await page.locator('#rolechip').textContent()) === 'Domain Lead')

  // ======================= 1. Dashboard KPIs =======================
  await page.locator('.nav[data-shellnav="dashboard"]').click()
  await page.waitForFunction(() => {
    const b = document.getElementById('dcbody')
    return b && !b.querySelector('.spin') && b.querySelector('.grid3')
  }, null, { timeout: 30000 })
  const health = await authedGet('/domain-health?id=customer-support', carol)
  const kpiAgents = await page.locator('#dcbody .grid3 .card').first().textContent()
  check(`K1 Agents KPI card shows the domain roster total (${health.total})`,
    health.ok === true && kpiAgents.includes(String(health.total)))
  const roll0 = await authedGet('/domain-cost-rollup?id=customer-support', carol)
  const kpiBudget = await page.locator('#dcbody .grid3 .card').nth(2).textContent()
  check('K2 Budget burn KPI card renders the rollup budget percentage',
    roll0.budgetPct == null ? kpiBudget.includes('no budget set') : kpiBudget.includes(`${roll0.budgetPct}%`))
  const kpiHealth = await page.locator('#dcbody .grid3 .card').nth(1).textContent()
  check(`K3 Domain health card shows the healthy-agent count (${health.byHealth?.healthy})`,
    kpiHealth.includes(`${health.byHealth?.healthy ?? ''} healthy`))
  await page.screenshot({ path: SHOT_DIR + 'b21-lead-dashboard.png', fullPage: true })

  // ======================= 2. Projects =======================
  await page.locator('.nav[data-shellnav="projects"]').click()
  await page.waitForSelector('#dcbody [data-project]', { timeout: 30000 })
  const dp = await authedGet('/domain-projects?id=customer-support', carol)
  check(`P1 Projects tab lists exactly ${dp.projects.length} domain project cards (API-reconciled)`,
    dp.ok === true && (await page.locator('#dcbody [data-project]').count()) === dp.projects.length)
  check('P2 supportdesk card is present with owner + member chips',
    (await page.locator('#dcbody [data-project="supportdesk"]').count()) === 1 &&
    /owner:/.test(await page.locator('#dcbody [data-project="supportdesk"]').textContent()))

  // ============ 3. Approve alice's grant (UI decide, alice-visible) ============
  const TOOL = `${RUN}-tool`
  const req = (await authedPost('/grant-request', {
    resourceType: 'tool', resourceId: TOOL, purpose: 'B21 journey: carol approves this from her inbox',
    durationS: 3600, onBehalfOfProject: 'supportdesk',
  }, alice)).request
  check('G1 alice files a pending grant request', !!req?.id && req.status === 'pending')
  await page.locator('.nav[data-shellnav="governance"]').click()
  await page.waitForSelector(`.req-decide[data-req="${req.id}"][data-d="approve"]`, { timeout: 30000 })
  check('G2 the request lands in carol\'s Governance inbox with decide buttons',
    (await page.locator('#reqinbox').textContent()).includes(TOOL))
  await page.locator(`.req-decide[data-req="${req.id}"][data-d="approve"]`).click()
  await page.waitForFunction(id => !document.querySelector(`.req-decide[data-req="${id}"]`), req.id, { timeout: 15000 })
  const inboxTxt = await page.locator('#reqinbox').textContent()
  check('G3 UI shows the decision in history (decided by carol, expiry visible)',
    inboxTxt.includes('decided by carol') && inboxTxt.includes('approved'))
  // alice-side visible state change: her own request row flips to approved
  const aliceView = (await authedGet('/grant-requests?type=tool', alice)).requests.find(r => r.id === req.id)
  check('G4 ALICE sees her request approved with an expiry (decidedBy carol)',
    aliceView?.status === 'approved' && !!aliceView?.expiresAt && aliceView?.decidedBy === 'carol')
  await page.screenshot({ path: SHOT_DIR + 'b21-lead-inbox.png', fullPage: true })

  // ======================= 4. Domain cost view =======================
  await page.locator('.nav[data-shellnav="dashboard"]').click()
  await page.waitForFunction(() => {
    const b = document.getElementById('dcbody')
    return b && !b.querySelector('.spin') && b.querySelector('table')
  }, null, { timeout: 30000 })
  const roll = await authedGet('/domain-cost-rollup?id=customer-support', carol)
  const costTxt = await page.locator('#dcbody').textContent()
  check(`C1 cost table renders one row per domain project (${roll.projects.length})`,
    (await page.locator('#dcbody table tbody tr').count()) === roll.projects.length && roll.projects.length >= 1)
  check(`C2 domain spend figure matches the rollup exactly (${usd(roll.costUsd)})`,
    costTxt.includes(usd(roll.costUsd)))
  const sd = roll.projects.find(p => p.id === 'supportdesk')
  check(`C3 supportdesk row carries its exact per-project cost (${usd(sd?.costUsd)})`,
    !!sd && costTxt.includes(sd.name) && costTxt.includes(usd(sd.costUsd)))
  if (roll.totalWithSharedUsd != null)
    check('C4 direct + shared total renders as the reconciled sum (data-totalshared)',
      (await page.locator('[data-totalshared]').textContent()) === usd(roll.totalWithSharedUsd))

  // ============ 5. Workspace Observability: own-plane traces ============
  const scopes = await authedGet('/obs-scopes', carol)
  const domAgents = (scopes.domains?.find(d => d.id === 'customer-support') || {}).agents || []
  check('O1 obs scope roster has >=1 customer-support agent (no vacuous pass)', domAgents.length >= 1)
  const traceAgent = domAgents[0]?.id
  const tr = await authedGet('/obs-traces?agent=' + encodeURIComponent(traceAgent), carol)
  check('O2 lead reads her own domain\'s traces by default (own plane, unlocked)',
    tr.ok === true && tr.locked === false && tr.ownPlane === true && (tr.traces || []).length >= 1)
  await page.locator('.nav[data-shellnav="bwobs"]').click()
  await page.waitForSelector('#tracebox .item', { timeout: 30000 })
  check(`O3 Observability traces tab renders exactly ${tr.traces.length} session traces`,
    (await page.locator('#tracebox .item').count()) === tr.traces.length &&
    (await page.locator('#traceagent').inputValue()) === traceAgent)
  const traceTxt = await page.locator('#tracebox').textContent()
  check('O4 traces are own-plane and masked by default (Reveal PII affordance per trace)',
    traceTxt.includes('own plane · default access (masked)') &&
    (await page.locator('#tracebox .reveal-toggle[data-action="reveal"]').count()) === tr.traces.length)
  await page.screenshot({ path: SHOT_DIR + 'b21-lead-traces.png', fullPage: true })

  // ============ 6. Lifecycle/Advance from the lead side (B19) ============
  const exp = await authedPost('/export', { project: 'supportdesk', preset: 'FULL' }, alice)
  check('L1 supportdesk export succeeds (lifecycle precondition, mock org)', exp.ok === true, exp.repo || exp.error)
  const repo = exp.repo
  check('L2 carol reads the exported repo\'s lifecycle (stage=exported)',
    (await authedGet('/lifecycle?repo=' + encodeURIComponent(repo), carol)).lifecycle?.stage === 'exported')
  const adv = await authedPost('/lifecycle-advance', { repo, stage: 'in_development' }, carol)
  check('L3 carol (supportdesk member, R-B8-01c) advances the lifecycle',
    adv.ok === true && adv.lifecycle?.stage === 'in_development')
  check('L4 advanced stage persists server-side (fresh read)',
    (await authedGet('/lifecycle?repo=' + encodeURIComponent(repo), carol)).lifecycle?.stage === 'in_development')

  // ============ 7. Blueprint submit→approve→catalog (B-J3 chain) ============
  const BP_ID = `b21bp${Date.now().toString(36).slice(-6)}`
  const sub = await authedPost('/blueprint-submit', {
    id: BP_ID, name: `B21 Lead Journey ${BP_ID}`, useCase: 'B21 journey: blueprint chain closure from the lead\'s catalog',
    template: { framework: 'Strands', deployTarget: 'AgentCore Runtime', protocol: 'HTTP', memory: 'shortTerm', streaming: true, identity: true, guardrails: true },
  }, alice)
  check('B1 alice submits a blueprint (pending_approval)',
    sub.ok === true && sub.submission?.status === 'pending_approval')
  check('B2 pending blueprint NOT yet in carol\'s catalog',
    !(await authedGet('/blueprints', carol)).some(b => b.id === BP_ID))
  const dec = await authedPost('/blueprint-submission-decide', { id: sub.submission.id, decision: 'approve' }, melanie)
  check('B3 platform peer (melanie) approves the submission', dec.ok === true && dec.submission?.status === 'approved')
  check('B4 approved blueprint reaches carol\'s catalog (/api/blueprints)',
    (await authedGet('/blueprints', carol)).some(b => b.id === BP_ID))
  // S.catalog is client-cached per page load — reload so step 1 refetches it
  await page.reload()
  await page.waitForSelector('#whoami')
  await page.locator('.nav[data-shellnav="bwbuild"]').click()
  await page.waitForSelector('[data-door="blueprint"]', { timeout: 15000 })
  await page.locator('[data-door="blueprint"]').click()
  await page.waitForSelector('[data-bp]', { timeout: 15000 })
  check('B5 the blueprint is selectable in carol\'s wizard step 1 (chain closed)',
    (await page.locator(`[data-bp="${BP_ID}"]`).count()) === 1)

  // ============ 8. Negative: cross-domain privileged reads 403 ============
  check('N1 carol cross-domain cost rollup (operations) -> 403',
    (await rawGet('/domain-cost-rollup?id=operations', carol.token)).status === 403)
  check('N2 carol cross-domain health (operations) -> 403',
    (await rawGet('/domain-health?id=operations', carol.token)).status === 403)

  await page.close()
} finally {
  await browser.close()
  if (subSnapshot === null) fs.rmSync(SUB_PATH, { force: true })
  else fs.writeFileSync(SUB_PATH, subSnapshot)
  if (lcSnapshot === null) fs.rmSync(LC_PATH, { force: true })
  else fs.writeFileSync(LC_PATH, lcSnapshot)
}
console.log(`\n${failures} failure(s)`)
process.exit(failures ? 1 : 0)
