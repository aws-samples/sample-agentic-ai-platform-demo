// B14 screenshot capture: admin/builder/lead × both obs entries → /tmp/b14-shots/
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'
import fs from 'node:fs'

const DIR = '/tmp/b14-shots/'
fs.mkdirSync(DIR, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const settle = () => page.waitForTimeout(1200)

// admin: Platform Monitoring + bwobs Observability
await uiLogin(page, 'melanie')
await page.locator('.nav[data-shellnav="monitoring"]').click()
await page.waitForSelector('#obsbox .item', { timeout: 20000 })
await settle()
await page.screenshot({ path: DIR + 'admin-platform-monitoring.png', fullPage: true })
await page.locator('.nav[data-shellnav="bwobs"]').click()
await page.waitForSelector('#tracebox .item, #obsbox .item', { timeout: 20000 })
await settle()
await page.screenshot({ path: DIR + 'admin-bwobs-observability.png', fullPage: true })

// builder (alice): workspace Observability
await uiLogin(page, 'alice')
await page.locator('.nav[data-shellnav="obs"]').click()
await page.waitForSelector('#obsbox .item, .obstab', { timeout: 20000 })
await settle()
await page.screenshot({ path: DIR + 'builder-observability.png', fullPage: true })

// lead (carol): bwobs Observability (lead has the BUILD WORKSPACE section)
await uiLogin(page, 'carol')
await page.locator('.nav[data-shellnav="bwobs"]').click()
await page.waitForSelector('#tracebox .item, #obsbox .item, .obstab', { timeout: 20000 })
await settle()
await page.screenshot({ path: DIR + 'lead-bwobs-observability.png', fullPage: true })

await browser.close()
console.log('shots saved to ' + DIR)
