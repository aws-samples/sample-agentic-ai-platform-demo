// F4 screenshots: Domain Lead project bootstrap (step 4 provisioning terms +
// review), then the same project seen by the builder it was provisioned for.
// Run: CONSOLE_BASE=http://localhost:4001 node e2e/shots-f4.mjs
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const OUT = '/home/ec2-user/work/demo-recording/demo-v2/console-shots/'
const PROJECT = process.env.SHOT_PROJECT || ('f4demo' + Date.now().toString().slice(-5))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, deviceScaleFactor: 1 })
page.on('pageerror', e => console.log('PAGEERROR', e.message))

// ---- Carol (Domain Lead) provisions the project -------------------------
await uiLogin(page, 'carol')
await page.locator('.nav[data-shellnav="projects"]').click()
await page.waitForSelector('#dcprojgo')
await page.locator('#dcprojgo').click()

await page.waitForSelector('[data-wtpl="chatbot"]')
await page.locator('[data-wtpl="chatbot"]').click()
await page.locator('#wnext').click()

await page.waitForSelector('#wname')
await page.fill('#wname', PROJECT)
await page.fill('#wdesc', 'Returns triage assistant — provisioned for Alice with a scoped budget.')
await page.locator('#wnext').click()

await page.waitForSelector('#wbp')
await page.locator('#wnext').click()

// Step 4 — assign the builder, then set the provisioning terms.
await page.waitForSelector('#wbudget')
await page.selectOption('select[data-wmember="alice"]', 'builder')
await page.waitForSelector('#wbudget')
await page.fill('#wbudget', '6000')
await page.locator('[data-wpal="chat-assistant"]').click()
await page.locator('[data-wpal="rag-knowledge"]').click()
await page.waitForTimeout(300)
await page.locator('#wbudget').scrollIntoViewIfNeeded()
await page.evaluate(() => window.scrollBy(0, -220))
await page.waitForTimeout(300)
await page.screenshot({ path: OUT + '11-lead-project-bootstrap.png' })
console.log('11 budget field:', await page.locator('#wbudget').inputValue())
console.log('11 palette selected:', await page.locator('[data-wpal].sel').count())
console.log('11 allocation line:', (await page.locator('text=left of').first().textContent()).trim())

// Steps 5 -> 6, review the terms before creating.
await page.locator('#wnext').click()
await page.waitForTimeout(400)
await page.locator('#wnext').click()
await page.waitForSelector('#wizreview')
// frame the whole review table — the provisioning rows are its last two
await page.locator('#wizreview tr').last().scrollIntoViewIfNeeded()
await page.evaluate(() => window.scrollBy(0, 80))
await page.waitForTimeout(300)
await page.screenshot({ path: OUT + '12-lead-bootstrap-review.png' })
console.log('12 review rows:', (await page.locator('#wizreview tr').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim()).join(' | '))

// Re-shooting the review frame does not need another real project.
if (process.env.STOP_AT_REVIEW) { await browser.close(); process.exit(0) }

await page.locator('#wcreate').click()
await page.waitForSelector('#projdetail .card', { timeout: 240000 })
await page.waitForTimeout(1500)

// ---- Alice (the builder it was provisioned for) sees it ------------------
// A builder reaches the new project through the workspace switcher — the same
// two clicks the demo takes on camera.
await uiLogin(page, 'alice')
await page.waitForSelector('#wsswitchbtn')
await page.locator('#wsswitchbtn').click()
await page.waitForSelector(`.wsswitchitem[data-project="${PROJECT}"]`)
await page.locator(`.wsswitchitem[data-project="${PROJECT}"]`).click()
await page.waitForSelector('text=Provisioned for you', { timeout: 30000 })
await page.waitForTimeout(600)
await page.screenshot({ path: OUT + '13-builder-sees-provisioned-project.png' })
console.log('13 budget headline:', (await page.locator('text=token budget for this project').first().textContent()).trim())
console.log('13 palette chips:', await page.locator('#wsbody .chip.type').allTextContents())

await browser.close()
console.log('PROJECT=' + PROJECT)
