import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// J-T1 smoke: Build tab three-door entry (builder journeys).
// Doors render per persona, route correctly, and the existing blueprint
// wizard still works behind door one.
// Run: node e2e/smoke-doors.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { uiLogin, openAdminOps } from './login.mjs'

const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

// --- Builder (alice): landing shows exactly three doors ---
await uiLogin(page, 'alice')
await page.locator('.nav[data-shellnav="build"]').click()
await page.waitForSelector('[data-door]')
check('builder landing shows exactly 3 door cards', (await page.locator('[data-door]').count()) === 3)
const landing = await page.locator('main').textContent()
check('door titles present (AI-assisted / Foundation start / Blueprint)',
  ['Start from Blueprint', 'AI-assisted design', 'Foundation start'].every(t => landing.includes(t)))
check('landing states the one-gate rule', landing.includes('one gate out'))
check('preset chips on the cards (FULL/SPEC/MINIMAL)',
  ['FULL preset', 'SPEC preset', 'MINIMAL preset'].every(t => landing.includes(t)))
check('no blueprint cards before a door is picked', (await page.locator('[data-bp]').count()) === 0)
await page.screenshot({ path: SHOT_DIR + 'j-t1-doors-landing.png', fullPage: true })

// --- Door 1: blueprint -> existing wizard step 1, back returns to landing ---
await page.locator('[data-door="blueprint"]').click()
await page.waitForSelector('[data-bp]')
const wiz = await page.locator('main').textContent()
check('blueprint door opens wizard step 1 (Choose Blueprint + cards)',
  wiz.includes('Choose Blueprint') && (await page.locator('[data-bp]').count()) >= 2)
await page.locator('#doorback').click()
await page.waitForSelector('[data-door]')
check('back from wizard returns to the three-door landing', (await page.locator('[data-door]').count()) === 3)

// --- Door 2: Plato placeholder routes + back ---
await page.locator('[data-door="plato"]').click()
await page.waitForSelector('#doorback')
const plato = await page.locator('main').textContent()
check('Plato door renders its journey panel', plato.includes('AI-assisted design') && plato.includes('CLAUDE.md'))
check('Plato panel names the shared gate', plato.includes('golden dataset'))
await page.locator('#doorback').click()
await page.waitForSelector('[data-door]')

// --- Door 3: scratch placeholder routes ---
await page.locator('[data-door="scratch"]').click()
await page.waitForSelector('#doorback')
const scratch = await page.locator('main').textContent()
check('scratch door renders its journey panel (now "Foundation start", TLP-B8)', scratch.includes('Foundation start') && scratch.includes('org foundation'))
await page.screenshot({ path: SHOT_DIR + 'j-t1-door-scratch.png', fullPage: true })

// --- Wizard state survives the door: pick a blueprint, leave, come back ---
await page.locator('#doorback').click()
await page.locator('[data-door="blueprint"]').click()
await page.waitForSelector('[data-bp]')
await page.locator('[data-bp="chat-assistant"]').click()
await page.locator('#n1').click()
await page.waitForSelector('#pname')
check('wizard step 2 reachable through the door', (await page.locator('#pname').count()) === 1)

// --- Admin (melanie): same three doors (TLP-B2 v2: reached via Platform
// Console Home › Operations — openBuildWizard would also enter the blueprint
// door, and this test wants the landing) ---
await uiLogin(page, 'melanie')
await openAdminOps(page, 'compose')
await page.waitForSelector('[data-door]')
check('admin landing shows the same 3 doors', (await page.locator('[data-door]').count()) === 3)

// --- End user: no build entry at all (doors unreachable) ---
await uiLogin(page, 'enduser')
const userNav = await page.locator('.nav').allTextContents()
check('end user has no build nav entry (no doors)', !userNav.some(t => t.includes('Build')))

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
