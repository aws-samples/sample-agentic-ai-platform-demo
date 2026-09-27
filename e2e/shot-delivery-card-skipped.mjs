// One-shot evidence capture: Delivery card rendering a SKIPPED deploy as a
// gray chip (Part 2g P1 acceptance). Run: node e2e/shot-delivery-card-skipped.mjs
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_SHELL ||
    '/Users/peiyaoli/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
await uiLogin(page, 'melanie')
await page.click('[data-shellnav="domains"]')
await page.waitForTimeout(800)
const domainCard = await page.$('[data-domain="platform"]')
if (domainCard) { await domainCard.click(); await page.waitForTimeout(800) }
await page.waitForSelector('#projroster [data-project="export-test-run"]', { timeout: 15000 })
await page.click('#projroster [data-project="export-test-run"]')
await page.waitForFunction(() => {
  const el = document.getElementById('projdelivery')
  return el && !el.innerText.includes('Loading')
}, { timeout: 20000 })
await page.evaluate(() => document.getElementById('projdelivery')?.scrollIntoView({ block: 'center' }))
await page.waitForTimeout(400)
await page.screenshot({ path: 'artifacts/screenshots/delivery-card-skipped.png' })
console.log('CARD TEXT:\n' + await page.$eval('#projdelivery', el => el.innerText.slice(0, 900)))
await browser.close()
