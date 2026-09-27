import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T10/T13A smoke: approval policies + interrupt flow, now living inside
// Governance (§7 sub-modules): policy CRUD on the "Approval policies" tab,
// pending decisions on the cross-type "Approval queue" tab, per-agent queryable
// log on the "Audit trail" tab. Counts derived from /api/hitl + /api/fleet.
// Run: node e2e/smoke-hitl.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard, openAdminOps, ADMIN_NAV } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const admin = await apiLogin('melanie')
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0, skips = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const skip = (name, reason) => { console.log(`SKIP  ${name} — ${reason}`); skips++ }
const getHitl = () => authedGet('/hitl', admin)
const govTab = async (page, tab) => {
  await page.locator(`.govtab[data-tab="${tab}"]`).click()
  await page.waitForFunction(() => !document.querySelector('#main .spin'), null, { timeout: 15000 }).catch(() => {})
}

// Self-healing: a crashed earlier run can leave its SmokePolicy* behind, and a
// leftover would match this run's smoke_delete_* tool first, corrupting the
// "interrupt names the matching policy" check. Remove stale ones up front.
for (const p of (await getHitl()).policies.filter(p => p.name.startsWith('SmokePolicy'))) {
  await authedPost('/hitl-policy-remove', { id: p.id }, admin)
}

// Independent sources of truth: the APIs the view renders from.
const before = await getHitl()
const fleet = await authedGet('/fleet', admin)
const agentName = (fleet.agents || []).map(a => a.project || a.name)[0]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
page.on('dialog', d => d.accept())
await uiLogin(page, 'melanie')

// --- T13A: the old HITL nav item is absorbed into Governance (TLP-B2 v2 +
// TLP-B4 'Platform Approvals': admin shell is exactly the ADMIN_NAV list) ---
let nav = await page.locator('.nav').allTextContents()
check('admin nav is the Platform Console shell (TLP-B7 sidebar, per ADMIN_NAV, no HITL)',
  nav.length === ADMIN_NAV.length &&
  ADMIN_NAV.every(l => nav.some(t => t.includes(l))) &&
  !nav.some(t => t.includes('HITL')))
await page.locator('.nav', { hasText: 'Governance' }).click()
await page.waitForSelector('.govtab')
check('Governance shows all nine sub-module tabs (§7 + §8.5 + Access requests + TLP-B7 Platform approvals)',
  (await page.locator('.govtab').count()) === 9)

// --- Approval policies tab: policy list + create form (ex-HITL view) ---
await govTab(page, 'policies')
await page.waitForSelector('[data-policy]', { timeout: 15000 })
check(`policy list shows exactly ${before.policies.length} policies (from /api/hitl)`,
  (await page.locator('[data-policy]').count()) === before.policies.length)
check('interrupt demo card carries a visible [illustrative] chip',
  (await page.locator('.card', { hasText: 'Demo an interrupt' }).first().textContent()).includes('illustrative'))
check('Approval policies tab carries no mock/simulated wording (D6)',
  !/mock|simulated/i.test(await page.locator('main').textContent()))

// --- Create a policy through the form ---
const polName = 'SmokePolicy' + Date.now().toString(36)
const toolName = 'smoke_delete_' + Date.now().toString(36)
await page.fill('#hpname', polName)
await page.fill('#hptools', 'smoke_delete_*')
await page.locator('#hpcreate').click()
await page.waitForSelector('#hpstatus .status.ok', { timeout: 10000 })
const afterCreate = await getHitl()
check('policy create added exactly one policy (API count +1)',
  afterCreate.policies.length === before.policies.length + 1)
await page.waitForFunction(n => [...document.querySelectorAll('[data-policy]')].some(e => e.textContent.includes(n)), polName)
check('created policy visible in the list',
  (await page.locator('[data-policy]', { hasText: polName }).count()) === 1)

if (!agentName) {
  skip('interrupt flow', 'no deployed agents in the fleet to demo against')
} else {
  // --- Simulated interrupt: matched tool call lands in the cross-type queue ---
  await page.selectOption('#hiagent', agentName)
  await page.fill('#hitool', toolName)
  await page.fill('#hiinput', '{"record": "R-1"}')
  await page.locator('#hifire').click()
  await page.waitForSelector('#histatus .status.ok', { timeout: 10000 })
  check('interrupt status names the matching policy',
    (await page.locator('#histatus').textContent()).includes(polName))
  check('interrupt status points at the Approval queue tab',
    (await page.locator('#histatus').textContent()).includes('Approval queue'))
  const pend1 = await getHitl()
  check('pending queue grew by exactly one (API)',
    pend1.pending.length === before.pending.length + 1)
  await govTab(page, 'queue')
  await page.waitForSelector(`[data-pending]`, { timeout: 10000 })
  const pendRow = page.locator('[data-pending]', { hasText: toolName })
  check('Approval queue shows the interrupted tool call', (await pendRow.count()) === 1)
  await page.screenshot({ path: SHOT_DIR + 't13a-gov-queue-pending.png', fullPage: true })

  // --- Approve it from the queue ---
  await pendRow.locator('.hdec[data-d="approved"]').click()
  await page.waitForFunction(t => ![...document.querySelectorAll('[data-pending]')].some(e => e.textContent.includes(t)), toolName, { timeout: 10000 })
  const afterApprove = await getHitl()
  check('approval drained the pending queue back (API)',
    afterApprove.pending.length === before.pending.length)
  const approved = afterApprove.audit.find(r => r.toolName === toolName)
  check('audit record is approved with decidedBy',
    approved?.status === 'approved' && approved?.decidedBy === 'melanie')

  // --- Fire again (from the policies tab) and reject from the queue ---
  await govTab(page, 'policies')
  await page.waitForSelector('#hitool')
  await page.selectOption('#hiagent', agentName)
  await page.fill('#hitool', toolName)
  await page.locator('#hifire').click()
  await page.waitForSelector('#histatus .status.ok', { timeout: 10000 })
  await govTab(page, 'queue')
  await page.waitForSelector('[data-pending]', { timeout: 10000 })
  await page.locator('[data-pending]', { hasText: toolName }).locator('.hdec[data-d="rejected"]').click()
  await page.waitForFunction(t => ![...document.querySelectorAll('[data-pending]')].some(e => e.textContent.includes(t)), toolName, { timeout: 10000 })
  const afterReject = await getHitl()
  const rejected = afterReject.audit.find(r => r.toolName === toolName && r.status === 'rejected')
  check('second call rejected in the audit trail', !!rejected)

  // --- Per-agent queryable audit trail (API + UI filter, Audit trail tab) ---
  const q = await authedGet(`/hitl-audit?agent=${encodeURIComponent(agentName)}`, admin)
  check(`audit query by agent returns only ${agentName} records (${q.total} total)`,
    q.total >= 2 && q.records.every(r => r.project === agentName))
  const qs = await authedGet(`/hitl-audit?agent=${encodeURIComponent(agentName)}&status=rejected`, admin)
  check('audit query by agent+status returns only rejected records',
    qs.total >= 1 && qs.records.every(r => r.status === 'rejected' && r.project === agentName))
  await govTab(page, 'audit')
  await page.waitForFunction(n => [...document.querySelectorAll('#haagent option')].some(o => o.value === n), agentName, { timeout: 10000 })
  await page.selectOption('#haagent', agentName)
  await page.waitForFunction(n => {
    const rows = document.querySelectorAll('#hitlaudit [data-audit]')
    return rows.length === n
  }, Math.min(q.total, 200), { timeout: 10000 })
  check('UI audit filter row count matches the API query',
    (await page.locator('#hitlaudit [data-audit]').count()) === Math.min(q.total, 200))
  await page.screenshot({ path: SHOT_DIR + 't13a-gov-audit.png', fullPage: true })
}

// --- Disable toggle stops matching ---
await govTab(page, 'policies')
await page.waitForSelector('[data-policy]', { timeout: 10000 })
const polRow = page.locator('[data-policy]', { hasText: polName })
await polRow.locator('.htoggle').click()
await page.waitForFunction(n => {
  const row = [...document.querySelectorAll('[data-policy]')].find(e => e.textContent.includes(n))
  return row && row.textContent.includes('disabled')
}, polName, { timeout: 10000 })
if (agentName) {
  const miss = await authedPost('/hitl-interrupt', { project: agentName, toolName }, admin)
  check('disabled policy no longer matches the tool call', miss.ok === true && miss.matched === false)
}

// --- Cleanup: remove the created policy, count restored ---
await page.locator('[data-policy]', { hasText: polName }).locator('.hpdel').click()
await page.waitForFunction(n => ![...document.querySelectorAll('[data-policy]')].some(e => e.textContent.includes(n)), polName, { timeout: 10000 })
const cleaned = await getHitl()
check('policy remove restored the original count', cleaned.policies.length === before.policies.length)

// --- T13A RBAC: policy CRUD + decide are admin-only server-side ---
const alice = await apiLogin('alice')
const carol = await apiLogin('carol')
const rawPost = (p, body, token) => fetch(BASE + '/api' + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body),
}).then(r => r.status)
check('builder cannot create approval policies -> 403',
  await rawPost('/hitl-policy-create', { name: 'x', toolMatch: 'x_*' }, alice.token) === 403)
check('lead cannot decide interrupted tool calls -> 403',
  await rawPost('/hitl-decide', { requestId: 'nope', decision: 'approved' }, carol.token) === 403)
check('builder cannot remove approval policies -> 403',
  await rawPost('/hitl-policy-remove', { id: 'nope' }, alice.token) === 403)

// --- Persona scoping (TLP-B2 v2): the builder shell has NO Governance nav at
// all — none of the HITL/approval-policy surfaces are reachable for it; the
// builder's request visibility survives on the API instead. End user has no
// Governance nav either ---
await uiLogin(page, 'alice')
nav = await page.locator('.nav').allTextContents()
check('builder nav has no Governance entry (TLP-B2 v2 shell)',
  !nav.some(t => t.includes('Governance')))
const aliceReqs = await authedGet('/grant-requests', alice)
check('builder can still list access requests via the API (own-request visibility)',
  aliceReqs.ok === true && Array.isArray(aliceReqs.requests))
await uiLogin(page, 'enduser')
nav = await page.locator('.nav').allTextContents()
check('end user has no Governance nav', !nav.some(t => t.includes('Governance')))

// --- Regression: fleet + wizard still render for admin ---
await uiLogin(page, 'melanie')
await openAdminOps(page, 'fleet')
await page.waitForFunction(() => {
  const b = document.querySelector('#fleetbox')
  return b && !b.textContent.includes('loading')
}, { timeout: 30000 })
check(`fleet still renders (${(fleet.agents || []).length} agents or empty state)`,
  (fleet.agents || []).length
    ? (await page.locator('#fleetbox tbody tr').count()) === fleet.agents.length
    : (await page.locator('#fleetbox .empty').count()) === 1)
await openBuildWizard(page)
await page.waitForTimeout(400)
check('Build wizard still renders step 1', (await page.locator('[data-bp]').count()) > 0)

await browser.close()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}${skips ? ` (${skips} skipped)` : ''}`)
process.exit(failures === 0 ? 0 : 1)
