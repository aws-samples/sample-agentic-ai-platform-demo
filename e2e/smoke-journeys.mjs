import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T19 smoke: persona customer-journey animation (SPEC WS-G, testplan M2/M4).
// Platform Console Home (admin) carries the "Customer journeys" card: one animated stepper per persona
// (Admin / Builder / Domain Lead / End User) mirroring the real demo
// click-paths, with step stories and persona-gated deep links; the End User
// journey adds the invocation trace-flow (end user → agent → tools/memory →
// response) with a traveling pulse. M4: no external assets, reduced-motion
// freezes the sweep, clicks keep working either way.
// Run: node e2e/smoke-journeys.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

  // M4: everything must come from this server — record any foreign request
  const foreign = []
  page.on('request', r => { if (!r.url().startsWith(process.env.CONSOLE_BASE || 'http://localhost:4000')) foreign.push(r.url()) })

  // --- Admin: four journey tabs, own journey selected, live marker sweeps ---
  await uiLogin(page, 'melanie')
  // TLP-B2 v2 shells: the journeys card lives on Platform Console Home.
  await page.locator('.nav[data-shellnav="home"]').click()
  await page.waitForSelector('#journeys')
  const tabs = await page.locator('.jtab').allTextContents()
  check('all four persona journey tabs render',
    tabs.length === 4 && ['Platform Admin', 'Domain Builder', 'Domain Lead', 'End User'].every(t => tabs.some(x => x.includes(t))))
  check('admin lands on the admin journey (7 steps)',
    (await page.locator('.jm-node').count()) === 7)
  const live1 = await page.evaluate(() => document.querySelector('.jm-node.live')?.dataset.jstep ?? null)
  await page.waitForTimeout(2200)
  const live2 = await page.evaluate(() => document.querySelector('.jm-node.live')?.dataset.jstep ?? null)
  check('live marker sweeps the stepper (moves between samples)', live1 !== live2)

  // Step click → story panel + deep link into the live view
  await page.locator('.jm-node[data-jstep="1"]').click()
  const p1 = await page.locator('#jpanel').textContent()
  check('admin Governance step narrates the approval queue', p1.includes('Governance') && p1.includes('approval queue'))
  await page.locator('[data-jopen="governance"]').click()
  await page.waitForSelector('.nav.active[data-view="governance"]')
  check('admin step deep-link lands on the live Governance view', true)

  // Tab switch: End User journey shows the trace flow, pulse travels it
  await page.locator('.nav[data-shellnav="home"]').click()
  await page.waitForSelector('#journeys')
  await page.locator('.jtab[data-jtab="user"]').click()
  await page.waitForSelector('#tftrack')
  const tfLabels = await page.evaluate(() => [...document.querySelectorAll('.tf-node text:first-of-type')].map(t => t.textContent))
  check('trace flow renders end user → agent → tools/memory → response',
    ['End user', 'Agent', 'Tools', 'Memory', 'Response'].every(l => tfLabels.includes(l)))
  const tf1 = await page.evaluate(() => Number(document.querySelector('.tf-pulse').getAttribute('cx')))
  await page.waitForTimeout(700)
  const tf2 = await page.evaluate(() => Number(document.querySelector('.tf-pulse').getAttribute('cx')))
  check('trace-flow pulse travels the invocation path', tf1 !== tf2)
  await page.screenshot({ path: SHOT_DIR + 't19-journeys.png', fullPage: true })

  // --- Builder (alice): TLP-B2 v2 shells — builders have NO Overview and no
  // journeys surface anymore; the shell lands on the project workspace.
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot')
  check('builder lands on the project workspace (#wsroot)', true)
  const builderNav = await page.locator('.nav').allTextContents()
  check('builder shell has no Overview (journeys surface retired for builders)',
    !builderNav.some(t => t.includes('Overview')))

  // --- Domain Lead (carol): TLP-B2 v2 shells — leads have NO Overview and no
  // journeys surface; the shell lands on the Domain Console dashboard.
  await uiLogin(page, 'carol')
  await page.waitForSelector('#dcbody')
  check('domain lead lands on the Domain Console (#dcbody)', true)
  const leadNav = await page.locator('.nav').allTextContents()
  check('lead shell has no Overview (journeys surface retired for leads)',
    !leadNav.some(t => t.includes('Overview')))

  // --- End User: de-text round 2 — the overview is data-first (h1 + one line
  // + Recommended tiles). The journey stepper and trace-flow diagram were
  // tutorial chrome and are gone; their reappearance is a regression.
  await uiLogin(page, 'enduser')
  await page.waitForSelector('#ovrecs')
  check('end user overview carries no journey stepper (tutorial chrome retired)',
    (await page.locator('#journeys').count()) === 0 &&
    (await page.locator('.jm-node').count()) === 0)
  check('end user overview carries no trace-flow diagram',
    (await page.locator('#tftrack').count()) === 0)
  check('end user overview is data-first: Recommended agents card renders',
    (await page.locator('#ovrecs').count()) === 1)

  check('no external network requests (works offline / no CDN)', foreign.length === 0)

  // --- M4: prefers-reduced-motion freezes sweep + pulse, clicks still work ---
  const rmPage = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await rmPage.emulateMedia({ reducedMotion: 'reduce' })
  await uiLogin(rmPage, 'melanie')
  // TLP-B2 v2: journeys card lives on Platform Console Home.
  await rmPage.locator('.nav[data-shellnav="home"]').click()
  await rmPage.waitForSelector('#journeys')
  await rmPage.waitForTimeout(2000)
  check('reduced-motion: live marker never starts',
    (await rmPage.locator('.jm-node.live').count()) === 0)
  await rmPage.locator('.jtab[data-jtab="user"]').click()
  await rmPage.waitForSelector('#tftrack')
  const rm1 = await rmPage.evaluate(() => Number(document.querySelector('.tf-pulse').getAttribute('cx')))
  await rmPage.waitForTimeout(700)
  const rm2 = await rmPage.evaluate(() => Number(document.querySelector('.tf-pulse').getAttribute('cx')))
  check('reduced-motion: trace-flow pulse does not travel', rm1 === rm2)
  await rmPage.locator('.jm-node[data-jstep="2"]').click()
  check('reduced-motion: step click still narrates',
    (await rmPage.locator('#jpanel').textContent()).includes('Chat'))
  await rmPage.close()
} finally {
  await browser.close()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
