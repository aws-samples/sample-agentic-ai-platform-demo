// T20 smoke — RE-BASELINED for the de-text pass (Melanie 2026-08-24, "too much
// explanatory text"): the story strip's "You are / You own" copy was cut; the
// strip now carries ONLY the Next cross-link (still allowedViews()-gated, still
// a real navigation path — e.g. the lead's only route into Observability).
// This smoke asserts: (1) the Next link renders and navigates live per persona,
// (2) the removed explainer copy stays removed, (3) at most one Next per page.
// Run: node e2e/smoke-story.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { uiLogin, openAdminOps } from './login.mjs'

let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const ADMIN_NAV_VIEWS = ['registry', 'governance', 'blueprints']
const ADMIN_OPS_VIEWS = ['fleet', 'cost', 'observability']

// async views replace #main after an await — wait for the strip NODE to change
const withNewStrip = async (page, go) => {
  const old = await page.evaluateHandle(() => document.getElementById('storyline'))
  await go()
  await page.waitForFunction(o => {
    const n = document.getElementById('storyline')
    return n && n !== o
  }, old)
}
const gotoView = (page, view) =>
  withNewStrip(page, () => page.locator(`.nav[data-view="${view}"]`).first().click())

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

  // --- Admin: Next link on every reachable old story view; no explainer copy ---
  await uiLogin(page, 'melanie')
  let allAdmin = true
  for (const v of ADMIN_NAV_VIEWS) {
    await gotoView(page, v)
    const t = await page.locator('#storyline').textContent()
    const links = await page.locator('#storyline .storynext').count()
    const ok = links === 1 && !t.includes('You are') && !t.includes('You own')
    if (!ok) { allAdmin = false; console.log(`      admin strip broken on view=${v}: ${t.slice(0, 120)}`) }
  }
  for (const v of ADMIN_OPS_VIEWS) {
    await withNewStrip(page, () => openAdminOps(page, v))
    const t = await page.locator('#storyline').textContent()
    const links = await page.locator('#storyline .storynext').count()
    const ok = links === 1 && !t.includes('You are') && !t.includes('You own')
    if (!ok) { allAdmin = false; console.log(`      admin strip broken on view=${v}: ${t.slice(0, 120)}`) }
  }
  check('admin: Next-only strip (no You are/You own explainer) on all 6 story pages', allAdmin)

  // Next link navigates live: Governance -> Agent Fleet
  await gotoView(page, 'governance')
  const govNext = await page.locator('#storyline .storynext').textContent()
  check('admin governance strip offers a Next step', govNext.includes('Agent Fleet'))
  await page.locator('#storyline .storynext').click()
  await page.waitForSelector('h1:has-text("Agent Fleet")')
  check('admin governance Next lands on the live Agent Fleet view', true)

  // --- Builder (alice): Next link renders on obs + registry nav pages ---
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot')
  let allBuilder = true
  for (const v of ['observability', 'registry']) {
    await gotoView(page, v)
    const links = await page.locator('#storyline .storynext').count()
    if (links !== 1) { allBuilder = false; console.log(`      builder strip broken on view=${v}`) }
  }
  check('builder: Next link on obs + registry nav pages', allBuilder)

  // --- Domain Lead (carol): the governance strip Next is her ONLY route into
  // Observability (Observability left the lead nav) — must render + navigate.
  await uiLogin(page, 'carol')
  await page.waitForSelector('#dcbody')
  await withNewStrip(page, () => page.locator('.nav[data-shellnav="governance"]').click())
  check('lead governance strip carries the Observability route',
    (await page.locator('#storyline .storynext[data-goview="observability"]').count()) === 1)
  await page.locator('#storyline .storynext').click()
  await page.waitForSelector('.obstab')
  check('lead governance Next lands on the live Observability view', true)

  // --- End User: Next on both pages, navigates back to Overview ---
  await uiLogin(page, 'enduser')
  await page.waitForSelector('#storyline')
  check('end-user overview strip carries a Next link',
    (await page.locator('#storyline .storynext').count()) === 1)
  await gotoView(page, 'fleet')
  await page.locator('#storyline .storynext').click()
  await page.waitForSelector('.nav.active[data-view="overview"]')
  check('end-user Agents Next lands back on Overview', true)

  // at most one Next per page (the strip is a line, not a menu)
  const nexts = await page.locator('#storyline .storynext').count()
  check('strip carries at most one Next action', nexts <= 1)
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures ? 1 : 0)
