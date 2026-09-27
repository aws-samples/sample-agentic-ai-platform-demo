import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T13 journey: Platform Admin — one pass over every admin view: maturity
// Overview, Governance (six §7 sub-module tabs incl. the absorbed approval
// policies), Fleet (approval badges), Cost, Observability. All counts
// derive from the APIs the views render from (falsifiable, not vacuous).
// B23: the platform Memory Stores page is removed — its stop asserts the
// nav absence + API liveness instead.
// Run: node e2e/journey-admin.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openAdminOps } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0, skips = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const skip = (name, reason) => { console.log(`SKIP  ${name} — ${reason}`); skips++ }
const admin = await apiLogin('melanie')
const apiGet = p => authedGet(p, admin)

// Independent sources of truth
const [gov, fleet, costs, mem, hitl, catalog] = await Promise.all([
  apiGet('/governance'), apiGet('/fleet'), apiGet('/costs'),
  apiGet('/memories'), apiGet('/hitl'), apiGet('/catalog'),
])

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await uiLogin(page, 'melanie')

// --- Overview: maturity journey framing ---
check('signed in as Platform Admin', (await page.locator('#rolechip').textContent()) === 'Platform Admin')
// TLP-B2 v2: the old Overview content (ladder/golden path/journeys) lives on
// Platform Console Home now.
await page.locator('.nav[data-shellnav="home"]').click()
await page.waitForSelector('.mrung.l3')
const body = await page.locator('main').textContent()
check('Overview tells the L1-L4 maturity story',
  ['Ad Hoc Agents', 'Platform Foundation', 'Self-Service Scale', 'Adaptive Platform'].every(s => body.includes(s)))
check('L3 is "You are here", L4 points at platform-as-agent',
  (await page.locator('.mrung.l3 .here').count()) === 1 && body.includes('platform as an agent'))

// --- Governance: nine sub-module tabs (the seven + Access requests folded
// in per owner request 2026-08-06 + TLP-B7 Platform approvals); queue tab
// lists the governed resources ---
await page.locator('.nav', { hasText: 'Governance' }).click()
await page.waitForSelector('#govmcp [data-gov]')
check('Governance shows the nine sub-module tabs (§7 + §8.5 + Access requests + Platform approvals)',
  (await page.locator('.govtab').count()) === 9 &&
  (await page.locator('.govtab[data-tab="requests"]').count()) === 1)
check(`Governance lists exactly ${gov.mcp.length} MCP servers`,
  (await page.locator('#govmcp .item').count()) === gov.mcp.length && gov.mcp.length >= 2)
check(`Governance lists exactly ${gov.a2a.length} A2A agents`,
  (await page.locator('#gova2a .item').count()) === gov.a2a.length && gov.a2a.length >= 2)
if (gov.agents.length === 0) {
  skip('fleet section of Governance', 'live fleet is empty in this account right now')
} else {
  check(`Governance lists exactly ${gov.agents.length} fleet agents with approval status`,
    (await page.locator('#govagents .item').count()) === gov.agents.length &&
    gov.agents.every(a => ['DRAFT', 'APPROVED', 'REJECTED'].includes(a.approval)))
}
check('registry backing store labeled console-local in the UI',
  (await page.locator('main').textContent()).includes('console-local store'))
check('governance page carries no mock/simulated wording (D6)',
  !/mock|simulated/i.test(await page.locator('main').textContent()))
await page.screenshot({ path: SHOT_DIR + 't13-admin-governance.png', fullPage: true })

// --- Approval policies tab (absorbed HITL view) renders with API-derived counts ---
await page.locator('.govtab[data-tab="policies"]').click()
// the loading placeholder is also .empty — wait for the spinner to clear
await page.waitForFunction(() => {
  const b = document.getElementById('hitlpolicies')
  return b && !b.querySelector('.spin')
}, null, { timeout: 30000 })
const policyCount = (hitl.policies || []).length
if (policyCount === 0) {
  check('Approval policies tab renders an explicit empty policy state',
    (await page.locator('#hitlpolicies .empty').count()) === 1)
} else {
  check(`Approval policies tab lists exactly ${policyCount} approval policies`,
    (await page.locator('#hitlpolicies [data-policy]').count()) === policyCount)
}
// --- Guardrail policy / RBAC / Compliance tabs render derived content ---
await page.locator('.govtab[data-tab="guardrails"]').click()
await page.waitForSelector('[data-guard]')
check('Guardrail policy tab lists every blueprint class',
  (await page.locator('[data-guard]').count()) >= 5 &&
  (await page.locator('main').textContent()).includes('enforced in the Foundation Harness'))
// --- Alerts & RACI tab (T13B §8.3/§8.4): policy table + RACI from the store ---
await page.locator('.govtab[data-tab="alerts"]').click()
await page.waitForSelector('[data-alertpol]')
const alertPols = (await apiGet('/alerts')).policies
check(`Alerts & RACI tab lists exactly ${alertPols.length} alert policies (metric+threshold+severity+owner+runbook)`,
  (await page.locator('[data-alertpol]').count()) === alertPols.length && alertPols.length >= 8)
check('RACI table renders one row per alert class',
  (await page.locator('[data-raci]').count()) === alertPols.length)
check('Alerts tab states the definition-vs-firing split (fires in Monitoring — B14)',
  (await page.locator('main').textContent()).includes('fires in Monitoring'))
await page.locator('.govtab[data-tab="rbac"]').click()
await page.waitForSelector('[data-rbac]')
check('RBAC tab renders the role policy table',
  (await page.locator('[data-rbac]').count()) >= 8)
await page.locator('.govtab[data-tab="compliance"]').click()
await page.waitForSelector('[data-comp]')
const regEntries = (await apiGet('/registry')).entries
const regTypes = [...new Set(regEntries.map(e => e.type))]
check(`Compliance tab lifecycle table covers all ${regTypes.length} registry types`,
  (await page.locator('[data-comp]').count()) === regTypes.length)
// falsifiable: the APPROVED column of the lifecycle table must sum to the API's count
const approvedTotal = regEntries.reduce((n, e) => n + (e.versions || []).filter(v => v.status === 'APPROVED').length, 0)
const renderedApproved = await page.$$eval('[data-comp]', rows =>
  rows.reduce((n, r) => n + (parseInt(r.cells[3].textContent, 10) || 0), 0))
check(`Compliance APPROVED counts sum to the registry total (${approvedTotal})`,
  renderedApproved === approvedTotal)
check('Compliance tab reports the oldest unreviewed submission',
  (await page.locator('#gcompliance').textContent()).includes('Oldest unreviewed submission'))
await page.screenshot({ path: SHOT_DIR + 't13a-admin-gov-compliance.png', fullPage: true })

// --- AI Registry view (T18: replaces MCP Servers + A2A Agents nav items) ---
await page.locator('.nav[data-shellnav="registry"]').click()
await page.waitForSelector('.regrow')
const regAll = (await apiGet('/registry')).entries
check(`AI Registry lists exactly ${regAll.length} entries`,
  (await page.locator('.regrow').count()) === regAll.length && regAll.length >= 2)

// --- Fleet: every runtime row + approval badge + cost column ---
await openAdminOps(page, 'fleet')
// the loading placeholder is also .empty — wait for the spinner to clear
await page.waitForFunction(() => {
  const b = document.getElementById('fleetbox')
  return b && !b.querySelector('.spin')
}, null, { timeout: 60000 })
if (fleet.agents.length === 0) {
  skip('Fleet rows', 'live fleet is empty')
} else {
  check(`Fleet shows exactly ${fleet.agents.length} runtimes`,
    (await page.locator('#fleetbox tbody tr').count()) === fleet.agents.length)
  const fleetTxt = await page.locator('#fleetbox').textContent()
  check('Fleet rows carry approval badges', fleet.agents.every(a => fleetTxt.includes(a.approval)))
  // T30: health badge derived from errorRate — every deployed-project row shows healthy/degraded.
  check('Fleet rows carry a health badge (healthy/degraded)',
    fleet.agents.filter(a => a.project).every(a => fleetTxt.includes(a.health)))
  // T31: version + last-deploy columns — real, from T20 deploy records.
  check('Fleet header has Version + Last deploy columns',
    (await page.locator('#fleetbox thead').textContent()).includes('Version') &&
    (await page.locator('#fleetbox thead').textContent()).includes('Last deploy'))
  // T29/B14: Fleet → Monitoring drill-down link on each deployed-project row.
  // The admin has no per-agent monitoring scope (B14 aggregate boundary), so
  // the link lands on Platform Monitoring scoped to the agent's owning DOMAIN.
  const projectAgents = fleet.agents.filter(a => a.project)
  if (projectAgents.length) {
    check('Fleet rows carry a "View monitoring →" drill-down link',
      (await page.locator('.obsdrill').count()) === projectAgents.length)
    await page.locator('.obsdrill').first().click()
    await page.waitForSelector('#obsbox .item')
    check('drill-down navigates to Platform Monitoring scoped to that agent\'s domain',
      (await page.locator('h1').textContent()).includes('Platform Monitoring') &&
      (await page.locator('#obsscope').inputValue()).startsWith('domain:'))
    await page.screenshot({ path: SHOT_DIR + 't29-fleet-columns-drilldown.png', fullPage: true })
    await openAdminOps(page, 'fleet')
    await page.waitForFunction(() => {
      const b = document.getElementById('fleetbox')
      return b && !b.querySelector('.spin')
    }, null, { timeout: 60000 })
  }
}
await page.screenshot({ path: SHOT_DIR + 't13-admin-fleet.png', fullPage: true })

// --- Memory (B23): the platform Memory Stores page is removed — memory
// lives under each agent (workspace Memory & KB tab). The listing API is
// unchanged; the admin nav must NOT offer a Memory Stores entry. ---
check('B23: /api/memories still serves the inventory (data plane untouched)',
  Array.isArray(mem.memories))
const b23nav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^\w]+/, '').trim())
check('B23: admin nav has no Memory Stores and no AI Gateway entry',
  !b23nav.some(t => t === 'Memory Stores' || t === 'AI Gateway'))
check('B23: admin keeps the per-agent Memory & KB workspace tab',
  (await page.locator('.nav[data-shellnav="bwmemorykb"]').count()) === 1)

// --- Cost: totals + rate card from the ledger and catalog ---
await openAdminOps(page, 'cost')
await page.waitForSelector('#costpricing table')
const totalsText = await page.locator('#costtotals').textContent()
// Re-fetch costs right before asserting: earlier steps in this same journey
// (fleet drill-downs, observability navigation) can trigger real invocations
// that bump the ledger between the initial snapshot and this check, so the
// initial `costs` snapshot goes stale and the count assertion flakes. Read
// the count at the moment we're about to compare it against the UI instead.
const costsNow = await apiGet('/costs')
check(`Cost totals show ${costsNow.invocations} recorded invocations`,
  totalsText.includes(String(costsNow.invocations)))
const pricedModels = (catalog.models || []).filter(m => m.pricing)
const rateTxt = await page.locator('#costpricing').textContent()
check(`rate card names all ${pricedModels.length} priced models (from /api/catalog)`,
  pricedModels.length >= 2 && pricedModels.every(m => rateTxt.includes(m.label)))

// --- Platform Monitoring (B14): aggregate layer charts + fleet/domain scope ---
await openAdminOps(page, 'monitoring')
await page.waitForSelector('#obsbox .item', { timeout: 30000 })
const obsTxt = await page.locator('main').textContent()
check('Monitoring H1 is "Platform Monitoring" (B14 title/nav match)',
  (await page.locator('main h1').first().textContent()).trim() === 'Platform Monitoring')
check('Monitoring shows the plain-language metric groups (Service health/Model performance/Agent reasoning/Cost & usage)', ['Service health', 'Model performance', 'Agent reasoning', 'Cost & usage'].every(l => obsTxt.includes(l)))
check('Monitoring has a fleet→domain scope selector (no per-agent scope — B14)',
  (await page.locator('#obsscope option').count()) >= 3 &&
  (await page.locator('#obsscope option').evaluateAll(o => o.every(x => !x.value.startsWith('agent:')))))
check('Monitoring keeps the Langfuse backend reference', obsTxt.includes('Langfuse'))
check('Monitoring states content traces stay in the domain (least privilege)',
  obsTxt.includes('Content-level traces are not shown here'))

// --- Design-system canvas token applied everywhere (TLP-B7 Cloudscape: --bg #f2f3f3) ---
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('design-system page background is the Cloudscape canvas (#f2f3f3)', bg === 'rgb(242, 243, 243)')

await browser.close()
console.log(`\n${failures} failure(s), ${skips} skip(s)`)
process.exit(failures ? 1 : 0)
