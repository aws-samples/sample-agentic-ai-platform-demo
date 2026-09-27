// KeyStone features 3 (dry-run) + 4 (HITL review queue) smoke + screenshots.
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const OUT = '/tmp/keystone-features'
const errors = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await uiLogin(page, 'melanie')
await page.locator('.nav[data-shellnav="governance"]').click()
await page.waitForTimeout(2000)

// F4: HITL Pending Review Queue on the Approval queue tab
await page.waitForSelector('#hitlreviewq', { timeout: 8000 })
console.log('review queue rows:', await page.locator('[data-hitlrq]').count())
console.log('OVERDUE badges:', await page.locator('#hitlreviewq .badge-red:has-text("OVERDUE")').count())
const t0 = await page.locator('.hitlrq-timer[data-id="rq1"]').textContent()
await page.waitForTimeout(2500)
const t1 = await page.locator('.hitlrq-timer[data-id="rq1"]').textContent()
console.log('countdown ticks:', t0.trim(), '->', t1.trim(), t0 !== t1 ? 'OK' : 'STUCK')
await page.locator('#hitlreviewq').scrollIntoViewIfNeeded()
await page.screenshot({ path: OUT + '/f4-hitl-review-queue.png' })
// approve + reject actions
await page.locator('.hitlrqact[data-id="rq1"][data-d="approved"]').click()
await page.waitForTimeout(300)
await page.locator('.hitlrqact[data-id="rq2"][data-d="rejected"]').click()
await page.waitForTimeout(300)
console.log('decided badges:', await page.locator('#hitlreviewq .badge:has-text("APPROVED")').count(), await page.locator('#hitlreviewq .badge:has-text("REJECTED")').count())

// F3: dry-run on Approval policies tab
await page.locator('.govtab[data-tab="policies"]').click()
await page.waitForTimeout(1500)
await page.waitForSelector('#govdryrun', { timeout: 8000 })
console.log('dryrun rows:', await page.locator('[data-dryrun]').count())
await page.locator('#govdryrun').scrollIntoViewIfNeeded()
await page.screenshot({ path: OUT + '/f3-policy-dry-run.png' })
// promote the zero-false-positive one (no confirm dialog expected)
await page.locator('.drpromote[data-id="dr3"]').click()
await page.waitForTimeout(300)
console.log('enforcing badges:', await page.locator('#govdryrun .badge:has-text("ENFORCING")').count())
// keep-in-dry-run status
await page.locator('.drkeep[data-id="dr2"]').click()
await page.waitForTimeout(200)
console.log('keep status shown:', await page.locator('#drstatus .status').count())
// promote with false positives → confirm dialog
page.once('dialog', d => d.dismiss())
await page.locator('.drpromote[data-id="dr1"]').click()
await page.waitForTimeout(300)
console.log('dr1 still dry-run after dismissed confirm:', await page.locator('[data-dryrun="dr1"] .badge:has-text("DRY RUN")').count())

console.log('JS errors:', errors.length ? errors : 'none')
await browser.close()
process.exit(errors.length ? 1 : 0)
