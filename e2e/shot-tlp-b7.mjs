// TLP-B7 screenshots — the four scopes on real UI state:
//   platform-sidebar.png     new platform shell with the 11-entry sidebar
//   platform-build-reuse.png platform user inside a project workspace via Build
//   blueprint-approval.png   pending blueprint submission in the peer queue
//   aws-reskin-dashboard.png Cloudscape reskin on the platform dashboard
//   aws-reskin-builder.png   Cloudscape reskin on the builder workspace
// Hermetic: blueprint-submissions.json snapshotted & restored.
// Run: node e2e/shot-tlp-b7.mjs   (expects console server on :4000)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiLogin, authedPost, uiLogin } from './login.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = path.join(here, '../artifacts/screenshots/tlp-b7/')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const SUB_PATH = path.join(here, '../console/blueprint-submissions.json')
const subSnapshot = fs.existsSync(SUB_PATH) ? fs.readFileSync(SUB_PATH, 'utf8') : null

const browser = await chromium.launch()
try {
  const melanie = await apiLogin('melanie')
  await authedPost('/blueprint-submit', {
    id: 'voice-assistant', name: 'Voice Assistant',
    useCase: 'Speech-driven assistant with tool use and short-term memory',
    template: { framework: 'Strands', deployTarget: 'AgentCore Runtime', protocol: 'HTTP', memory: 'shortTerm', streaming: true, identity: true, guardrails: true },
  }, melanie)

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  // 1 + 4. platform shell with sidebar / reskinned dashboard
  await uiLogin(page, 'melanie')
  await page.waitForSelector('.kpi', { timeout: 20000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: SHOT_DIR + 'platform-sidebar.png' })
  console.log('saved platform-sidebar.png')
  await page.screenshot({ path: SHOT_DIR + 'aws-reskin-dashboard.png', fullPage: true })
  console.log('saved aws-reskin-dashboard.png')

  // 2. platform user inside a project workspace via Build
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('.pbopen', { timeout: 15000 })
  await page.locator('.pbopen').first().click()
  await page.waitForSelector('#wstabs', { timeout: 15000 })
  await page.waitForFunction(() => !document.querySelector('#wsbody .spin'), null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: SHOT_DIR + 'platform-build-reuse.png' })
  console.log('saved platform-build-reuse.png')

  // 3. pending blueprint in the peer approval queue (frank's view — he can decide)
  await uiLogin(page, 'frank')
  await page.locator('.nav[data-shellnav="governance"]').click()
  await page.waitForSelector('.govtab[data-tab="exemptions"]', { timeout: 15000 })
  await page.locator('.govtab[data-tab="exemptions"]').click()
  await page.waitForSelector('.bpsubdecide', { timeout: 15000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: SHOT_DIR + 'blueprint-approval.png', fullPage: true })
  console.log('saved blueprint-approval.png')

  // 5. reskin on the builder workspace
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsbody', { timeout: 20000 })
  await page.waitForFunction(() => !document.querySelector('#wsbody .spin'), null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: SHOT_DIR + 'aws-reskin-builder.png' })
  console.log('saved aws-reskin-builder.png')

  await page.close()
} finally {
  await browser.close()
  if (subSnapshot === null) fs.rmSync(SUB_PATH, { force: true })
  else fs.writeFileSync(SUB_PATH, subSnapshot)
}
