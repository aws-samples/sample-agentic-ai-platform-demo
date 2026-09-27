import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T04 smoke: login + role-scoped nav + maturity journey Overview.
// Run: node e2e/smoke-personas.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, apiSwitchDomain, uiLogin, authedGet, authedPost, openBuildWizard, openAdminOps, ADMIN_NAV } from './login.mjs'

const admin = await apiLogin('melanie')
const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await uiLogin(page, 'melanie')

// --- Platform Admin ---
check('sidebar shows signed-in identity', (await page.locator('#whoami').textContent()).includes('Melanie'))
check('signed in as Platform Admin', (await page.locator('#rolechip').textContent()) === 'Platform Admin')
const adminNav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^\w]+/, ''))
check('admin nav is exactly the TLP-B7 platform sidebar (Dashboard … Build, per ADMIN_NAV)',
  adminNav.join('|') === ADMIN_NAV.join('|'))
// IA restructure: the fleet view is labelled "Agent Fleet", never a bare "Operate"
check('no nav entry says "Operate" (IA rename)', !adminNav.some(t => t.includes('Operate')))
// Maturity journey now lives on Platform Console Home (TLP-B2: no Overview view).
await page.locator('.nav[data-shellnav="home"]').click()
await page.waitForSelector('.mrung.l3')
const body = await page.locator('main').textContent()
check('Home shows L1-L4 ladder', ['Ad Hoc Agents', 'Platform Foundation', 'Self-Service Scale', 'Adaptive Platform'].every(s => body.includes(s)))
check('L3 marked "You are here"', await page.locator('.mrung.l3 .here').textContent() === 'You are here')
check('L4 marked north star + platform-as-agent pointer', (await page.locator('.mrung.l4 .nstar').count()) === 1 && body.includes('platform as an agent'))
check('roadmap link present', await page.locator('a[href="/roadmap"]').count() >= 1)
// Design-system canvas token applied (TLP-B7 Cloudscape reskin: --bg #f2f3f3)
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
check('design-system page background is the Cloudscape canvas (#f2f3f3)', bg === 'rgb(242, 243, 243)')
await page.screenshot({ path: SHOT_DIR + 't04-admin-overview.png', fullPage: true })

// --- Platform Admin: T04 domain affordances ---
check('admin sidebar shows "all domains" chip', (await page.locator('#whoami').textContent()).includes('all domains'))
check('admin sidebar has an active-domain selector', await page.locator('#domainselect').count() === 1)
check('admin selector offers Customer Support + Operations',
  (await page.locator('#domainselect').textContent()).includes('Customer Support') &&
  (await page.locator('#domainselect').textContent()).includes('Operations'))
await openAdminOps(page, 'fleet')
await page.waitForFunction(() => {
  const b = document.getElementById('fleetbox')
  return b && !b.querySelector('.spin')
}, null, { timeout: 60000 })
check('admin Agent Fleet table has a Domain column', (await page.locator('#fleetbox thead').textContent()).includes('Domain'))
check('fleet page renders "Agent Fleet" heading (IA rename)', (await page.locator('main h1').first().textContent()) === 'Agent Fleet')
// Data-driven: every domain the fleet API reports must appear as a chip label.
const domRoster = (await authedGet('/domains', admin)).domains
const fleetDomains = [...new Set(((await authedGet('/fleet', admin)).agents || []).map(a => a.domain).filter(Boolean))]
const adminFleetTxt = await page.locator('#fleetbox').textContent()
check(`admin Operate shows a domain chip per fleet domain (${fleetDomains.length})`,
  fleetDomains.every(d => adminFleetTxt.includes((domRoster.find(x => x.id === d) || {}).name || d)))

// Active-domain switch: admin can enter one domain's resource view without a new login.
await page.locator('#domainselect').selectOption('customer-support')
await page.waitForFunction(() => JSON.parse(localStorage.getItem('console.session') || '{}').domain === 'customer-support')
// Readiness = the SCOPED re-render, not "fleetbox has no spinner": right after
// the localStorage session flips, the OLD fully-loaded fleetbox (spinner-free)
// is still in the DOM while the onchange handler awaits /session-domain +
// ensure() refetches — a no-spinner wait passes instantly against the stale
// view and reads `main` before the scope note exists (TLP-B6 flake root cause).
await page.waitForFunction(() => (document.querySelector('main')?.textContent || '').includes('Scoped to active domain'), null, { timeout: 60000 })
await page.waitForFunction(() => {
  const b = document.getElementById('fleetbox')
  return b && !b.querySelector('.spin')
}, null, { timeout: 60000 })
const scopedTxt = await page.locator('main').textContent()
check('admin active-domain view states Customer Support scope',
  scopedTxt.includes('Scoped to active domain') && scopedTxt.includes('Customer Support'))
check('admin active-domain Operate hides Operations resources',
  !(await page.locator('#fleetbox').textContent()).includes('Operations'))
await page.locator('#domainselect').selectOption('')
await page.waitForFunction(() => JSON.parse(localStorage.getItem('console.session') || '{}').domain === null)

await openAdminOps(page, 'cost')
await page.waitForSelector('#costpricing table')
check('admin Cost per-agent table has a Domain column',
  (await page.locator('#costbox').textContent()).includes('No invocations') ||
  (await page.locator('#costbox thead').textContent()).includes('Domain'))
await page.locator('.nav[data-shellnav="registry"]').click()
await page.waitForSelector('.regrow')
check('admin AI Registry table has a Domain column', (await page.locator('#regbox thead').textContent()).includes('Domain'))
await page.screenshot({ path: SHOT_DIR + 't04b-admin-fleet-domains.png', fullPage: true })

// --- Frank Huang: added admin user with the same governed domain-switch capability ---
const frank = await apiLogin('frank')
check('Frank Huang can sign in as Platform Admin',
  frank.name === 'Frank Huang' && frank.role === 'admin' && (frank.domains || []).includes('customer-support') && (frank.domains || []).includes('operations'))
const frankOps = await apiSwitchDomain(frank, 'operations')
check('Frank can switch active domain to Operations', frankOps.domain === 'operations')
const badSwitchStatus = await fetch(BASE + '/api/session-domain', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + frank.token },
  body: JSON.stringify({ domain: 'not-a-real-domain' }),
}).then(r => r.status)
check('invalid active-domain switch is rejected', badSwitchStatus === 403)

// --- Domain Builder ---
await uiLogin(page, 'alice')
// TLP-B2: builder lands on the project workspace; the Build Workspace nav is a
// fixed six-item list (no Overview, no Blueprints).
await page.waitForSelector('#wsroot')
check('builder lands on the project workspace (#wsroot)', (await page.locator('#wsroot').count()) === 1)
const builderNav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^\w]+/, ''))
check('builder nav is exactly Fleet / Build Agent + / Memory & KB / Cost / Observability / AI Registry',
  builderNav.join('|') === ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry'].join('|'))
// T04: active user + domain badge; lists visibly scoped to the builder's domain.
check('builder sidebar shows domain badge (Customer Support)', (await page.locator('#whoami').textContent()).includes('Customer Support'))
// Workspace Fleet tab: project-scoped agent CARDS (not the old #fleetbox table).
await page.locator('.nav[data-shellnav="fleet"]').click()
await page.waitForFunction(() => {
  const b = document.getElementById('wsbody')
  return b && !b.querySelector('.spin')
}, null, { timeout: 60000 })
const aliceApi = await apiLogin('alice')
const aliceFleet = await authedGet('/fleet', aliceApi)
const aliceProjects = (await authedGet('/projects', aliceApi)).projects || []
const wsProject = aliceProjects.find(p => (p.members || []).some(m => m.principal === 'alice'))
const expectedCards = (aliceFleet.agents || []).filter(a => ((wsProject || {}).agents || []).includes(a.project))
check(`workspace Fleet tab cards match alice's project-scoped fleet (${expectedCards.length})`,
  (await page.locator('#wsbody .wsopenagent').count()) === expectedCards.length ||
  (expectedCards.length === 0 && (await page.locator('#wsbody .empty').count()) === 1))
check('workspace fleet cards never mention an Operations-domain chip', !(await page.locator('#wsbody').textContent()).includes('Operations'))
await page.locator('.nav[data-shellnav="registry"]').click()
await page.waitForSelector('.regrow')
check('builder AI Registry states its domain scope', (await page.locator('main').textContent()).includes('Scoped to your domain'))
await page.screenshot({ path: SHOT_DIR + 't04b-builder-scoped.png', fullPage: true })

// --- End User ---
await uiLogin(page, 'enduser')
const userNav = await page.locator('.nav').allTextContents()
check('end user nav is Overview + Agents only', userNav.length === 2 && userNav.some(t => t.includes('Agents')))
check('end user has no Build/Operate/Observability nav', !userNav.some(t => t.includes('Build') || t.includes('Observability') || t.includes('Blueprints') || t.includes('Operate')))
// Agents view: no delete buttons
await page.locator('.nav', { hasText: 'Agents' }).click()
await page.waitForTimeout(4000) // live AgentCore list
const delBtns = await page.locator('.gdel').count()
check('end user sees no Delete buttons', delBtns === 0)
await page.screenshot({ path: SHOT_DIR + 't04-user-agents.png', fullPage: true })

// --- Switch back to admin: nav restored, Operate has delete affordance ---
await uiLogin(page, 'melanie')
await openAdminOps(page, 'fleet')
await page.waitForTimeout(4000)
const adminDel = await page.locator('.gdel').count()
// Non-vacuous check: derive expected count independently from /api/fleet.
// Admin gets a Delete button for every locally-sourced agent (a.project set).
const fleetRes = await authedGet('/fleet', admin)
const expectedDel = (fleetRes.agents || []).filter(a => a.project).length
if ((fleetRes.agents || []).length === 0) {
  console.log('SKIP  admin Delete-button check (fleet is empty — no agents deployed)')
} else {
  check(`admin Delete buttons match locally-sourced agents (expected ${expectedDel})`, adminDel === expectedDel)
}
console.log(`(admin delete buttons visible: ${adminDel}, fleet agents: ${(fleetRes.agents || []).length})`)

// --- Regression: wizard step 1 still renders ---
await openBuildWizard(page)
await page.waitForTimeout(300)
const wiz = await page.locator('main').textContent()
check('Build wizard renders step 1 (blueprints pickable)', wiz.includes('Choose Blueprint') && (await page.locator('[data-bp]').count()) > 0)

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
