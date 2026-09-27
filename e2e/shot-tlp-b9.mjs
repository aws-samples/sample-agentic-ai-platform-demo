// TLP-B9 screenshots — spec v2.5 dual-section sidebar on real UI state:
//   b9-admin-sidebar.png      platform shell: PLATFORM governance + BUILD WORKSPACE sections
//   b9-admin-buildws.png      admin inside its own platform-domain project workspace (bwfleet)
//   b9-lead-sidebar.png       domain lead shell: DOMAIN governance + BUILD WORKSPACE sections
//   b9-lead-buildws.png       lead inside its own domain project workspace
//   b9-builder-sidebar.png    builder shell (single section, unchanged — the isomorphism reference)
// Run: node e2e/shot-tlp-b9.mjs   (expects console server on :4000)
import fs from 'node:fs'
import { chromium } from 'playwright'
import { uiLogin } from './login.mjs'

const SHOT_DIR = '/tmp/tlp-b9-shots/'
fs.mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  // 1. admin: dashboard with the dual-section sidebar
  await uiLogin(page, 'melanie')
  await page.waitForSelector('.kpi', { timeout: 20000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: SHOT_DIR + 'b9-admin-sidebar.png' })
  console.log('saved b9-admin-sidebar.png')

  // 2. admin: BUILD WORKSPACE › Fleet (platform-domain project workspace)
  await page.locator('.nav[data-shellnav="bwfleet"]').click()
  await page.waitForSelector('#wsroot, #wsbody', { timeout: 20000 })
  await page.waitForFunction(() => !document.querySelector('#main .spin'), null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(500)
  await page.screenshot({ path: SHOT_DIR + 'b9-admin-buildws.png' })
  console.log('saved b9-admin-buildws.png')

  // 3+4. lead: domain console with dual sections, then its build workspace
  await uiLogin(page, 'carol')
  await page.waitForSelector('.nav[data-shellnav="bwfleet"]', { timeout: 20000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: SHOT_DIR + 'b9-lead-sidebar.png' })
  console.log('saved b9-lead-sidebar.png')
  await page.locator('.nav[data-shellnav="bwfleet"]').click()
  await page.waitForSelector('#wsroot, #wsbody', { timeout: 20000 })
  await page.waitForFunction(() => !document.querySelector('#main .spin'), null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(500)
  await page.screenshot({ path: SHOT_DIR + 'b9-lead-buildws.png' })
  console.log('saved b9-lead-buildws.png')

  // 5. builder: the isomorphism reference (alice's workspace nav)
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot, #wsbody', { timeout: 20000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: SHOT_DIR + 'b9-builder-sidebar.png' })
  console.log('saved b9-builder-sidebar.png')

  console.log('ALL SHOTS SAVED')
} finally {
  await browser.close()
}
