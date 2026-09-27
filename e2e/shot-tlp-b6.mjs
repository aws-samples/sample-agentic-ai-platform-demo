// TLP-B6 screenshots: exemption expiry+revoked chips, cost footnote with
// totalWithSharedUsd, visual polish (chevron / baseline chip / dashed card).
// Seeds two exemption rows through the real 4-eyes flow (one applied-with-
// expiry, one revoked), shoots, then restores the stores (hermetic).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin } from './login.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = new URL('../artifacts/screenshots/tlp-b6/', import.meta.url).pathname
fs.mkdirSync(SHOT_DIR, { recursive: true })
const PROJECTS_PATH = path.join(here, '../console/projects.json')
const projectsSnapshot = fs.existsSync(PROJECTS_PATH) ? fs.readFileSync(PROJECTS_PATH, 'utf8') : null
const EXEMPT_PATH = path.join(here, '../console/policy-exemptions.json')
const exemptSnapshot = fs.existsSync(EXEMPT_PATH) ? fs.readFileSync(EXEMPT_PATH, 'utf8') : null

const alice = await apiLogin('alice')
const carol = await apiLogin('carol')
const melanie = await apiLogin('melanie')
const frank = await apiLogin('frank')

const RUN = Date.now().toString(36).slice(-5)
const P_A = `b6shota${RUN}`, P_B = `b6shotb${RUN}`
const genDirs = [P_A, P_B].map(p => path.join(here, `../domain-examples/generated/${p}`))

const browser = await chromium.launch()
try {
  const meta = await authedGet('/wizard-templates', alice)
  const LOCKED = [...meta.orgEnforced.map(g => g.id), ...meta.domainEnforced]
  for (const p of [P_A, P_B])
    await authedPost('/wizard-create', { draft: { template: 'chatbot', projectName: p, description: 'b6 shots', guardrails: LOCKED } }, carol)
  const flow = async (project, reason, ttlDays) => {
    const r = await authedPost('/policy-exemption-request', { project, guardrail: 'tone-review', reason }, carol)
    const id = r.exemption.id
    await authedPost('/policy-exemption-decide', { id, decision: 'approve' }, melanie)
    await authedPost('/policy-exemption-decide', { id, decision: 'approve', ...(ttlDays ? { ttlDays } : {}) }, frank)
    return id
  }
  await flow(P_A, 'latency-critical pilot — tone eval adds 400ms; time-boxed relief', 14)
  const revId = await flow(P_B, 'one-off migration window; revoked after cutover completed', 30)
  await authedPost('/policy-exemption-revoke', { id: revId, reason: 'cutover done — restoring the guardrail early' }, carol)

  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })

  // 1. Platform approvals (TLP-B7: a Governance & Approvals tab) — expiry
  // chip on the applied row + a revoked row
  await uiLogin(page, 'melanie')
  await page.locator('.nav[data-shellnav="governance"]').click()
  await page.waitForSelector('.govtab[data-tab="exemptions"]', { timeout: 20000 })
  await page.locator('.govtab[data-tab="exemptions"]').click()
  await page.waitForSelector('[data-expiry]', { timeout: 20000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: SHOT_DIR + 'exemption-expiry.png', fullPage: true })
  console.log('saved exemption-expiry.png')

  // 2. Domain Console dashboard — totalWithSharedUsd + direct-cost footnote
  await uiLogin(page, 'carol')
  await page.waitForSelector('[data-costfootnote]', { timeout: 20000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: SHOT_DIR + 'cost-footnote.png', fullPage: true })
  console.log('saved cost-footnote.png')

  // 3. Builder workspace — chevron switcher, baseline chip, dashed create card
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsnewagent', { timeout: 20000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: SHOT_DIR + 'visual-polish.png', fullPage: true })
  console.log('saved visual-polish.png')

  await page.close()
} finally {
  await browser.close()
  if (projectsSnapshot === null) fs.rmSync(PROJECTS_PATH, { force: true })
  else fs.writeFileSync(PROJECTS_PATH, projectsSnapshot)
  if (exemptSnapshot === null) fs.rmSync(EXEMPT_PATH, { force: true })
  else fs.writeFileSync(EXEMPT_PATH, exemptSnapshot)
  for (const d of genDirs) fs.rmSync(d, { recursive: true, force: true })
}
