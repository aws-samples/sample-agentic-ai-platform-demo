// One-shot screenshot generator for TLP-B4 (wizard + 4-eyes + P3 polish):
//   wizard-step1..6.png       — carol walking all 6 create-project steps
//   fourEyes-pending-domain.png    — Platform Approvals: layer 1 pending
//   fourEyes-pending-platform.png  — layer 1 cleared, layer 2 pending
//   fourEyes-applied.png           — both layers signed off, exemption applied
//   p3-workspace-polish.png   — builder workspace (chevron switcher, chip
//                               baseline, dashed + New Agent card, 65ch)
//   p3-platform-projects.png  — admin Platform Projects (tooltip'd copy)
// Seeds its own wizard project + exemption request and cleans both up after.
// Expects console on :4000. Run: node e2e/fixtures/shot-tlp-b4.mjs
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin } from '../login.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = path.join(here, '../../artifacts/screenshots/tlp-b4')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const BASE = 'http://localhost:4000'
const PROJECTS_PATH = path.join(here, '../../console/projects.json')
const projectsSnapshot = fs.existsSync(PROJECTS_PATH) ? fs.readFileSync(PROJECTS_PATH, 'utf8') : null
const EXEMPT_PATH = path.join(here, '../../console/policy-exemptions.json')
const exemptSnapshot = fs.existsSync(EXEMPT_PATH) ? fs.readFileSync(EXEMPT_PATH, 'utf8') : null

const carol = await apiLogin('carol')
const melanie = await apiLogin('melanie')
const frank = await apiLogin('frank')
const P = 'shotb4' + Date.now().toString(36).slice(-4)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
const shot = async name => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(SHOT_DIR, name) }); console.log('shot:', name) }
// The wizard renders below the project cards — bring it into the viewport.
const shotWizard = async name => {
  await page.evaluate(() => document.getElementById('dcwizard')?.scrollIntoView({ block: 'start' })).catch(() => {})
  await shot(name)
}

try {
  // ---- the 6 wizard steps (carol, Domain Console -> Create Project) ----
  await uiLogin(page, 'carol')
  await page.locator('.nav[data-shellnav="projects"]').click()
  await page.waitForSelector('#dcprojgo', { timeout: 15000 })
  await page.locator('#dcprojgo').click()
  await page.waitForSelector('[data-wtpl]', { timeout: 15000 })
  await shotWizard('wizard-step1-template.png')
  await page.locator('[data-wtpl="chatbot"]').click()
  await page.locator('#wnext').click()
  await page.waitForSelector('#wname', { timeout: 15000 })
  await page.fill('#wname', P)
  await page.fill('#wdesc', 'Returns-flow pilot assistant for the customer-support desk.')
  await shotWizard('wizard-step2-basics.png')
  await page.locator('#wnext').click()
  await page.waitForSelector('#wbp', { timeout: 15000 })
  await shotWizard('wizard-step3-harness.png')
  await page.locator('#wnext').click()
  await page.waitForSelector('[data-wmember]', { timeout: 15000 })
  await shotWizard('wizard-step4-members.png')
  await page.locator('#wnext').click()
  await page.waitForSelector('[data-wlocked]', { timeout: 15000 })
  await shotWizard('wizard-step5-policy.png')
  await page.locator('#wnext').click()
  await page.waitForSelector('#wcreate', { timeout: 15000 })
  await shotWizard('wizard-step6-review.png')
  await page.locator('#wcreate').click()
  await page.waitForSelector('#projdetail h1', { timeout: 120000 })

  // ---- 4-eyes exemption flow: three states on the Platform Approvals page ----
  const rq = await authedPost('/policy-exemption-request', {
    project: P, guardrail: 'tone-review',
    reason: 'Latency-critical pilot — the tone eval adds 400ms per turn.',
  }, carol)
  const XID = rq.exemption?.id
  if (!XID) throw new Error('exemption seed failed: ' + JSON.stringify(rq))

  const openApprovals = async () => {
    await page.locator('.nav[data-shellnav="approvals"]').click()
    await page.waitForFunction(() => /Platform Approvals/.test(document.querySelector('main h1')?.textContent || ''), null, { timeout: 15000 })
    await page.waitForFunction(() => !document.querySelector('#apxlist .spin'), null, { timeout: 15000 }).catch(() => {})
  }
  await uiLogin(page, 'melanie')
  await openApprovals()
  await shot('fourEyes-pending-domain.png')

  await authedPost('/policy-exemption-decide', { id: XID, decision: 'approve' }, melanie)
  await openApprovals()
  await shot('fourEyes-pending-platform.png')

  await authedPost('/policy-exemption-decide', { id: XID, decision: 'approve' }, frank)
  await openApprovals()
  await shot('fourEyes-applied.png')

  // ---- P3-polished pages ----
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot, #wstabs, [data-wstab]', { timeout: 15000 }).catch(() => {})
  await page.waitForFunction(() => !document.querySelector('main .spin'), null, { timeout: 20000 }).catch(() => {})
  await shot('p3-workspace-polish.png')

  await uiLogin(page, 'melanie')
  await page.locator('.nav[data-shellnav="platformprojects"]').click()
  await page.waitForSelector('[data-ppopen]', { timeout: 15000 })
  await shot('p3-platform-projects.png')
} finally {
  await browser.close()
  if (projectsSnapshot === null) fs.rmSync(PROJECTS_PATH, { force: true })
  else fs.writeFileSync(PROJECTS_PATH, projectsSnapshot)
  if (exemptSnapshot === null) fs.rmSync(EXEMPT_PATH, { force: true })
  else fs.writeFileSync(EXEMPT_PATH, exemptSnapshot)
  fs.rmSync(path.join(here, `../../domain-examples/generated/${P}`), { recursive: true, force: true })
  console.log('seed state cleaned up')
}
