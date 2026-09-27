// KeyStone feature 6 (manual 3-step agent registration wizard).
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const OUT = process.env.SHOT_OUT || '/tmp/keystone-features'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await uiLogin(page, 'melanie')
await page.locator('.nav[data-shellnav="registry"]').click()
await page.waitForTimeout(2000)

// Registry page: manual Register agent button, no Discovered list
console.log('register button:', await page.locator('#regwizopen').count())
console.log('no discovered rows:', await page.locator('[data-discovered]').count() === 0 ? 'yes' : 'no')
console.log('no warning flashbar:', await page.locator('.flashbar.warning').count() === 0 ? 'yes' : 'no')
await page.screenshot({ path: OUT + '/f6-registry-no-discovered.png' })

// Open registration wizard — starts blank
await page.locator('#regwizopen').click()
await page.waitForTimeout(800)
console.log('wizard open:', await page.locator('#regwiz').count())
console.log('name field blank:', (await page.locator('#rwname').inputValue()) === '' ? 'yes' : 'no')
await page.screenshot({ path: OUT + '/f6a-register-wizard-step1.png' })

// Step 1: next without name/domain should error
await page.locator('#rwnext').click()
await page.waitForTimeout(300)
console.log('required-field error:', await page.locator('#rwstatus .status.err').count())
// fill and advance
await page.locator('#rwname').fill('invoice-parser')
await page.locator('#rwalias').fill('Invoice Parser')
await page.locator('#rwdomain').selectOption({ index: 1 })
await page.locator('#rwnext').click()
await page.waitForTimeout(500)
console.log('on step 2 (risk select present):', await page.locator('#rwrisk').count())
await page.screenshot({ path: OUT + '/f6b-register-wizard-step2.png' })
await page.locator('#rwrisk').selectOption('4')
await page.locator('#rwnext').click()
await page.waitForTimeout(500)
console.log('on step 3 (submit present):', await page.locator('#rwsubmit').count())
await page.screenshot({ path: OUT + '/f6c-register-wizard-review.png' })
await page.locator('#rwsubmit').click()
await page.waitForTimeout(1200)
console.log('registered confirmation:', await page.locator('.status.ok:has-text("registered as a DRAFT")').count())

// Registry list still renders after the wizard closes
await page.waitForTimeout(1500)
console.log('managed rows render:', await page.locator('.regrow').count())

console.log('JS errors:', errors.length ? errors : 'none')
await browser.close()
process.exit(errors.length ? 1 : 0)
