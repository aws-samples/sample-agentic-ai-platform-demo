import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T18 smoke: Golden Path animated flow (SPEC WS-G, testplan M1/M4).
// One SVG serpentine on Platform Console Home (admin) — Login → Blueprint → Compose → Evaluate →
// Approve → Deploy → Operate → Observe → Improve — with a traveling pulse,
// clickable stages that show platform-provided vs domain-owned responsibilities,
// and deep links into the live views. M4: no external assets, animation stops
// under prefers-reduced-motion, click-through keeps working either way.
// Run: node e2e/smoke-goldenpath.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const STAGES = ['Login', 'Blueprint', 'Compose', 'Evaluate', 'Approve', 'Deploy', 'Agent Fleet', 'Observe', 'Improve']

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

  // M4: everything must come from this server — record any foreign request
  const foreign = []
  page.on('request', r => { if (!r.url().startsWith(process.env.CONSOLE_BASE || 'http://localhost:4000')) foreign.push(r.url()) })

  // --- Admin: full path renders, pulse travels, stages narrate ownership ---
  await uiLogin(page, 'melanie')
  // TLP-B2 v2 shells: the golden path lives on Platform Console HOME —
  // navigate there explicitly.
  await page.locator('.nav[data-shellnav="home"]').click()
  await page.waitForSelector('#goldenpath')
  const labels = await page.locator('.gstage').allTextContents()
  check('all nine golden-path stages render in order',
    labels.length === 9 && STAGES.every((s, i) => labels[i].includes(s)))
  const legend = await page.locator('#goldenpath').textContent()
  check('ownership legend present (platform / domain / shared)',
    ['platform-provided', 'domain-owned', 'shared'].every(t => legend.includes(t)))

  // M1: the pulse actually travels the path (two samples, must differ)
  const cx1 = await page.evaluate(() => Number(document.querySelector('.gp-pulse').getAttribute('cx')))
  await page.waitForTimeout(800)
  const cx2 = await page.evaluate(() => Number(document.querySelector('.gp-pulse').getAttribute('cx')))
  check('pulse travels the path (cx moves)', cx1 !== cx2)

  // Stage click → ownership panel: platform vs domain columns, story line
  await page.locator('.gstage[data-gstage="4"]').click()
  const p4 = await page.locator('#gpanel').textContent()
  check('Approve stage panel narrates governance ownership',
    p4.includes('Approve — governance decides') && p4.includes('Platform provides') && p4.includes('Domain team owns'))
  check('clicked stage is highlighted', (await page.locator('.gstage.sel').getAttribute('data-gstage')) === '4')
  await page.screenshot({ path: SHOT_DIR + 't18-goldenpath.png', fullPage: true })

  // Deep link: Open Governance lands on the live Governance view (admin nav
  // still carries a Governance entry, so nav.active marks it)
  await page.locator('[data-gopen="governance"]').click()
  await page.waitForSelector('.nav.active[data-shellnav="governance"]')
  check('stage deep-link lands on the live Governance view', true)

  // Deep link: Blueprints is still an admin nav entry too
  await page.locator('.nav[data-shellnav="home"]').click()
  await page.waitForSelector('#goldenpath')
  await page.locator('.gstage[data-gstage="1"]').click()
  await page.locator('[data-gopen="blueprints"]').click()
  await page.waitForSelector('.nav.active[data-shellnav="blueprints"]')
  check('admin deep-link to Blueprints lands', true)

  // --- Builder: TLP-B2 v2 shells — builders have NO Overview and NO golden
  // path surface. Governance is NOT reachable as a nav destination for
  // builders (spec §1.2 ⑦ — replaces the old 'builder gets NO deep link into
  // Governance' semantics).
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot')
  check('builder lands on the project workspace (#wsroot)', true)
  const builderNav = await page.locator('.nav').allTextContents()
  check('builder nav has NO Governance / Blueprints / Overview entries',
    !builderNav.some(t => t.includes('Governance') || t.includes('Blueprints') || t.includes('Overview')))
  const BUILDER_NAV = ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry']
  check('builder nav is exactly Fleet/Build Agent +/Memory & KB/Cost/Observability/AI Registry',
    builderNav.length === 6 && BUILDER_NAV.every((l, i) => builderNav[i].includes(l)))

  // --- End User: no golden path (their overview is chat-focused) ---
  await uiLogin(page, 'enduser')
  check('end user overview has no golden path', (await page.locator('#goldenpath').count()) === 0)

  check('no external network requests (works offline / no CDN)', foreign.length === 0)

  // --- M4: prefers-reduced-motion freezes the pulse, page stays usable ---
  const rmPage = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await rmPage.emulateMedia({ reducedMotion: 'reduce' })
  await uiLogin(rmPage, 'melanie')
  // TLP-B2 v2: golden path lives on Platform Console Home.
  await rmPage.locator('.nav[data-shellnav="home"]').click()
  await rmPage.waitForSelector('#goldenpath')
  const r1 = await rmPage.evaluate(() => Number(document.querySelector('.gp-pulse').getAttribute('cx')))
  await rmPage.waitForTimeout(800)
  const r2 = await rmPage.evaluate(() => Number(document.querySelector('.gp-pulse').getAttribute('cx')))
  check('reduced-motion: pulse does not travel', r1 === r2)
  await rmPage.locator('.gstage[data-gstage="2"]').click()
  check('reduced-motion: stage click still narrates',
    (await rmPage.locator('#gpanel').textContent()).includes('Compose the Domain Harness'))
  await rmPage.close()
} finally {
  await browser.close()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
