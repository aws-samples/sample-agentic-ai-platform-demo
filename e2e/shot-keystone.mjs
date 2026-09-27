// KeyStone-features smoke + screenshots (temporary; used during the
// feat/cloudscape-ui KeyStone batch — see /tmp/keystone-features/).
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const OUT = '/tmp/keystone-features'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await uiLogin(page, 'melanie')
const nav = async (id, ms = 1800) => {
  await page.locator(`.nav[data-shellnav="${id}"]`).click()
  await page.waitForTimeout(ms)
}

// F1+F5: Cost view — src badges + FinOps optimization table
await nav('cost', 2500)
await page.waitForSelector('#finopsopt', { timeout: 8000 })
await page.locator('#finopsopt').scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: OUT + '/f5-finops-optimization.png' })
console.log('cost view srcbadges:', await page.locator('.srcbadge').count())

// F5 apply action
await page.locator('.finopsapply').first().click()
await page.waitForTimeout(400)
console.log('finops applied chip:', await page.locator('#finopsopt .chip:has-text("applied")').count())

// F1: platform console dashboard badge
await nav('home', 2000).catch(() => {})
await page.screenshot({ path: OUT + '/f1-data-source-badges.png' })
console.log('dashboard srcbadges:', await page.locator('.srcbadge').count())

console.log('JS errors:', errors.length ? errors : 'none')
await browser.close()
process.exit(errors.length ? 1 : 0)
