import { chromium } from 'playwright'
import { uiLogin, openAdminOps } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const SHOT_DIR = new URL('../artifacts/screenshots/tlp-b5/', import.meta.url).pathname
import { mkdirSync } from 'node:fs'
mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })

// Platform Cost page — admin, component drill-down + shared allocated line
await uiLogin(page, 'melanie')
await openAdminOps(page, 'cost')
await page.waitForSelector('#costcomponents table, #costcomponents svg, #costcomponents')
await page.waitForTimeout(600)
await page.screenshot({ path: SHOT_DIR + 'platform-cost-components.png', fullPage: true })
console.log('saved platform-cost-components.png')

// Domain Console dashboard — lead, per-project shared-allocated column
await uiLogin(page, 'carol')
await page.waitForSelector('table', { timeout: 15000 }).catch(() => {})
await page.waitForTimeout(1200)
await page.screenshot({ path: SHOT_DIR + 'domain-console-cost-shared.png', fullPage: true })
console.log('saved domain-console-cost-shared.png')

await browser.close()
