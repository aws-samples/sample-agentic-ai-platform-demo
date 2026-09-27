// F3 screenshots: wizard memory plan (step 2) + eval gate preview (step 3).
// Run: CONSOLE_BASE=http://localhost:4001 node e2e/shots-f3.mjs
import { chromium } from 'playwright'
import { uiLogin, openBuildWizard } from './login.mjs'

const OUT = '/home/ec2-user/work/demo-recording/demo-v2/console-shots/'
const PROJECT = process.env.SHOT_PROJECT || ('f3demo' + Date.now().toString().slice(-5))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, deviceScaleFactor: 1 })
page.on('pageerror', e => console.log('PAGEERROR', e.message))

await uiLogin(page, 'alice')
await openBuildWizard(page)

// Step 1: pick the Chat Assistant blueprint (the deployable one with a real
// memory plan in its agentcore.json).
await page.waitForSelector('[data-bp="chat-assistant"]')
await page.locator('[data-bp="chat-assistant"]').click()
await page.locator('#n1').click()
await page.waitForSelector('#pname')

// Step 2 — memory plan visual.
await page.fill('#pname', PROJECT)
await page.fill('#persona', 'You are a retail support assistant. Answer only from data you queried this turn.')
await page.waitForTimeout(400)
await page.locator('#opt-memory').scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: OUT + '08-wizard-memory-plan.png' })
console.log('08 memory plan namespace rows:', await page.locator('code:has-text("{actorId}")').count())
console.log('08 retention row present:', await page.locator('text=Retention policy').count())

// Generate -> step 3.
await page.locator('#gen').click()
await page.waitForSelector('#evalprev .card, #evalprev .status', { timeout: 180000 })
await page.waitForTimeout(1200)
await page.locator('#evalprev').scrollIntoViewIfNeeded()
// scroll up a little so the card's own "Eval gate" label is in frame, not clipped
await page.evaluate(() => window.scrollBy(0, -170))
await page.waitForTimeout(400)
await page.screenshot({ path: OUT + '09-wizard-eval-gate-preview.png' })
console.log('09 eval codes:', (await page.locator('#evalprev code').allTextContents()).slice(0, 8).join(' | '))
console.log('09 threshold:', await page.locator('#evalprev b').first().textContent())

// Full step-3 page (eval preview sitting above the export card).
await page.screenshot({ path: OUT + '10-wizard-preexport-full.png', fullPage: true })

await browser.close()
console.log('PROJECT=' + PROJECT)
