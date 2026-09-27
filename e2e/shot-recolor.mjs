// Recolor before/after screenshots (temporary). Usage:
//   CONSOLE_BASE=http://localhost:4111 node e2e/shot-recolor.mjs before|after
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const phase = process.argv[2] || 'before'
const OUT = `artifacts/screenshots/recolor/${phase}`
import { mkdirSync } from 'node:fs'
mkdirSync(OUT, { recursive: true })

const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await uiLogin(page, 'melanie')
const nav = async (id, ms = 2000) => {
  await page.locator(`.nav[data-shellnav="${id}"]`).click()
  await page.waitForTimeout(ms)
}

await page.waitForTimeout(1500)
await page.screenshot({ path: OUT + '/01-admin-dashboard.png' })

await nav('domains', 2200)
await page.screenshot({ path: OUT + '/02-domains.png' })

await nav('cost', 2500)
await page.screenshot({ path: OUT + '/03-cost.png' })

await nav('governance', 2200)
await page.screenshot({ path: OUT + '/04-governance.png' })

console.log('done', phase, 'errors:', errors.length ? errors : 'none')
await browser.close()
process.exit(0)
