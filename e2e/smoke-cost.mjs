import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T08 smoke: Cost view — per-agent token/cost breakdown fed by real invocations,
// model rate card (pricing metadata), fleet cost badges, persona scoping.
// Counts are derived from /api/costs and /api/fleet (falsifiable, not vacuous).
// Run: node e2e/smoke-cost.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard, openAdminOps } from './login.mjs'

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

// Independent source of truth: the API the view renders from.
const costs = await authedGet('/costs', admin)
const fleet = await authedGet('/fleet', admin)
const catalog = await authedGet('/catalog', admin)
const pricedModels = (catalog.models || []).filter(m => m.pricing)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await uiLogin(page, 'melanie')

// --- Platform Admin: Cost view (TLP-B2: reached via Platform Console Home › Operations) ---
await openAdminOps(page, 'cost')
await page.waitForSelector('#costpricing table')
check('admin reaches Cost via Platform Console Home Operations',
  (await page.locator('main h1').first().textContent()) === 'Cost')
const totalsText = await page.locator('#costtotals').textContent()
check(`totals show ${costs.invocations} recorded invocations (from /api/costs)`,
  totalsText.includes(String(costs.invocations)))
check(`totals show total tokens ${costs.totalTokens}`,
  totalsText.includes(costs.totalTokens.toLocaleString()))

// per-agent table: exactly as many rows as the API reports
const rowCount = await page.locator('[data-cost]').count()
check(`per-agent breakdown has exactly ${costs.perAgent.length} row(s)`, rowCount === costs.perAgent.length)
if (costs.perAgent.length) {
  const a = costs.perAgent[0]
  const row = await page.locator(`[data-cost="${a.project}"]`).textContent()
  check(`row for ${a.project} shows its invocation count (${a.invocations})`, row.includes(String(a.invocations)))
  check(`row for ${a.project} shows input tokens (${a.inputTokens})`, row.includes(a.inputTokens.toLocaleString()))
  check('heuristic-counted rows carry a visible "estimated" chip',
    !a.estimated || row.includes('estimated'))
} else {
  skip('per-agent row content', 'ledger is empty — chat with a deployed agent first')
}

// rate card: one priced row per catalog model with pricing metadata
const rateCard = await page.locator('#costpricing').textContent()
check(`rate card lists all ${pricedModels.length} priced models`,
  pricedModels.every(m => rateCard.includes(m.label)))
check('rate card shows input price for first model',
  rateCard.includes('$' + pricedModels[0].pricing.inputPer1k.toFixed(4)) ||
  rateCard.includes('$' + pricedModels[0].pricing.inputPer1k.toFixed(5)))

// --- T35: per-model breakdown table (same ledger, grouped by model) ---
const modelRowCount = await page.locator('#costmodelbox tbody tr').count()
check(`per-model breakdown has exactly ${costs.perModel.length} row(s)`, modelRowCount === (costs.perModel.length || 0))
if (costs.perModel.length) {
  const m = costs.perModel[0]
  const mrow = await page.locator('#costmodelbox').textContent()
  check(`per-model table shows invocation count for ${m.model}`, mrow.includes(String(m.invocations)))
} else {
  skip('per-model row content', 'ledger is empty — chat with a deployed agent first')
}

// --- T36: per-agent cost trend sparkline (svg, reused from Observability) ---
if (costs.perAgent.some(a => (a.costTrend || []).length > 1)) {
  const sparkCount = await page.locator('#costbox svg').count()
  check('at least one per-agent row shows a cost trend sparkline (svg)', sparkCount > 0)
} else {
  skip('cost trend sparkline', 'no agent has >1 day of ledger activity yet')
}
await page.screenshot({ path: SHOT_DIR + 't08-admin-cost.png', fullPage: true })

// --- Fleet cost badges (admin) ---
await openAdminOps(page, 'fleet')
// wait past the "loading live runtimes…" placeholder (fleet API shells to aws CLI)
await page.waitForFunction(() => {
  const b = document.querySelector('#fleetbox')
  return b && !b.textContent.includes('loading')
}, { timeout: 30000 })
const withCost = fleet.agents.filter(a => a.cost)
if (withCost.length) {
  for (const a of withCost) {
    const badge = await page.locator(`[data-costbadge="${a.project}"]`).count()
    check(`fleet row for ${a.project} carries a cost badge`, badge === 1)
  }
  await page.screenshot({ path: SHOT_DIR + 't08-admin-fleet-cost.png', fullPage: true })
} else if (fleet.agents.length) {
  skip('fleet cost badges', 'no fleet agent has recorded usage yet')
} else {
  skip('fleet cost badges', 'live fleet is empty in this account')
}

// --- Domain Builder: Cost nav present ---
// TLP-B2: the builder Cost surface is the WORKSPACE cost tab — a
// PROJECT-scoped table in #wsbody (no [data-cost] rows; those are admin-only).
// Expected rows = alice's /api/costs perAgent entries whose agent belongs to
// her current workspace project (first project with member alice).
const aliceApi = await apiLogin('alice')
const aliceCosts = await authedGet('/costs', aliceApi)
const aliceProjects = (await authedGet('/projects', aliceApi)).projects || []
const aliceWsProject = aliceProjects.find(p => (p.members || []).some(m => m.principal === 'alice'))
const expectedCostRows = (aliceCosts.perAgent || []).filter(a => ((aliceWsProject || {}).agents || []).includes(a.project))
await uiLogin(page, 'alice')
check('builder nav has Cost', (await page.locator('.nav[data-shellnav="cost"]').count()) === 1)
await page.locator('.nav[data-shellnav="cost"]').click()
await page.waitForFunction(() => {
  const b = document.getElementById('wsbody')
  return b && !b.querySelector('.spin')
}, null, { timeout: 30000 })
check(`builder workspace cost tab renders project-scoped rows or empty state (${expectedCostRows.length} from alice's /api/costs)`,
  (await page.locator('#wsbody tbody tr').count()) === expectedCostRows.length ||
  (expectedCostRows.length === 0 && (await page.locator('#wsbody .empty').count()) === 1))

// --- End User: no Cost nav ---
await uiLogin(page, 'enduser')
const userNav = await page.locator('.nav').allTextContents()
check('end user has no Cost nav', !userNav.some(t => t.includes('Cost')))

// --- Regression: observability + wizard still render ---
await uiLogin(page, 'melanie')
await openAdminOps(page, 'observability')
await page.waitForTimeout(500)
const obs = await page.locator('main').textContent()
check('Observability still renders (two backends)', obs.includes('CloudWatch') && obs.includes('Langfuse'))
await openBuildWizard(page)
await page.waitForTimeout(400)
check('Build wizard still renders step 1', (await page.locator('[data-bp]').count()) > 0)

await browser.close()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}${skips ? ` (${skips} skipped)` : ''}`)
process.exit(failures === 0 ? 0 : 1)
