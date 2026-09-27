// One-shot evidence capture: project detail Delivery card with REAL CI
// telemetry (Part 3 acceptance). Run: node e2e/shot-delivery-card.mjs
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_SHELL ||
    '/Users/peiyaoli/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
await uiLogin(page, 'melanie')
// Navigate via UI: Domains nav -> platform domain -> data-analyst project.
await page.click('[data-shellnav="domains"]')
await page.waitForSelector('[data-domain="platform"], .domrow', { timeout: 10000 }).catch(() => {})
await page.waitForTimeout(800)
// domain roster: click into platform domain detail
const domainCard = await page.$('[data-domain="platform"]')
if (domainCard) { await domainCard.click(); await page.waitForTimeout(800) }
await page.waitForSelector('#projroster [data-project="data-analyst"]', { timeout: 15000 })
await page.click('#projroster [data-project="data-analyst"]')
await page.waitForFunction(() => {
  const el = document.getElementById('projdelivery')
  return el && !el.innerText.includes('Loading')
}, { timeout: 20000 })
await page.evaluate(() => document.getElementById('projdelivery')?.scrollIntoView({ block: 'center' }))
await page.waitForTimeout(400)
await page.screenshot({ path: 'artifacts/screenshots/delivery-card.png' })
console.log('CARD TEXT:\n' + await page.$eval('#projdelivery', el => el.innerText.slice(0, 900)))
await browser.close()
