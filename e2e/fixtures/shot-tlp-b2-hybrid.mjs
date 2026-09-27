import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// One-shot screenshot generator for the TLP-B2.3 hybrid builder landing:
//   builder-projects-cards.png  — alice fresh login (no last-used) -> My Projects cards page
//   builder-resume-lastused.png — alice returning (last-used set) -> direct workspace landing
// Run: node e2e/fixtures/shot-tlp-b2-hybrid.mjs   (expects console on :4000)
import { chromium } from 'playwright'
import { apiLogin, authedPost } from '../login.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../artifacts/screenshots/tlp-b2-v2')
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
const BASE = 'http://localhost:4000'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

// fresh login, no last-used -> cards page
const alice = await apiLogin('alice')
await authedPost('/last-project', { project: null }, alice)
await page.goto(BASE)
await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), alice)
await page.goto(BASE)
await page.waitForSelector('.projcard', { timeout: 15000 })
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(SHOT_DIR, 'builder-projects-cards.png'), fullPage: false })
console.log('shot: builder-projects-cards.png')

// pick a project (sets last-used), then relaunch -> direct workspace landing
await page.locator('.projcard[data-project="supportdesk"]').click()
await page.waitForSelector('#wsbody', { timeout: 15000 })
await page.waitForTimeout(800)   // let the last-project POST land
await page.goto(BASE)            // relaunch: fresh page load with the stored session
await page.waitForSelector('#wsbody', { timeout: 15000 })
await page.waitForFunction(() => !document.querySelector('#wsbody .spin'), null, { timeout: 20000 }).catch(() => {})
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(SHOT_DIR, 'builder-resume-lastused.png'), fullPage: false })
console.log('shot: builder-resume-lastused.png')

// leave the demo state fresh: no last-used
await authedPost('/last-project', { project: null }, alice)
await browser.close()
