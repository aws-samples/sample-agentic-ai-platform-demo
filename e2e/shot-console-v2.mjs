// Console v2 demo screenshots (AI Registry / YAML import / memory + eval /
// project bootstrap / Simulate-free wizard). Drives the REAL console over
// playwright the same way the smoke suite does — every state in these shots is
// produced by clicking the UI, not by injecting markup.
//
//   CONSOLE_BASE=http://localhost:4001 SHOT_DIR=/path/to/shots node e2e/shot-console-v2.mjs
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { apiLogin, authedPost, uiLogin, openBuildWizard } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4001'
const SHOT_DIR = process.env.SHOT_DIR || '/home/ec2-user/work/demo-recording/demo-v2/console-shots/'
const ONLY = process.argv.slice(2)
const want = name => !ONLY.length || ONLY.some(o => name.includes(o))
mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch()
const shots = []
async function shot(page, name) {
  await page.screenshot({ path: SHOT_DIR + name + '.png', fullPage: true })
  shots.push(name)
  console.log('shot  ' + name)
}
async function open(user) {
  const page = await browser.newPage({ viewport: { width: 1760, height: 1100 } })
  await uiLogin(page, user)
  return page
}

// ---- Feature 1: AI Registry ----
if (want('registry')) {
  // Re-runnable: the approve shot below decides the one pending pack for real,
  // so drop the entry first — the server re-seeds it pristine (IN_REVIEW) on the
  // next read, which is the same idempotent contract the other seeds use.
  await authedPost('/registry-remove', { id: 'guardrail-pack-retail-pii' }, await apiLogin('melanie'))
  const page = await open('melanie')
  await page.goto(BASE + '/registry')
  await page.waitForSelector('.regrow')
  await shot(page, '01-registry-list')
  await page.locator('#regsearch').fill('guardrail')
  await page.waitForTimeout(400)
  await shot(page, '01b-registry-guardrail-packs')

  // the single pending entry -> drawer -> Approve (a real /api/registry-decide)
  await page.locator('.regrow[data-regid="guardrail-pack-retail-pii"]').click()
  await page.waitForSelector('#regdrawerwrap .card')
  await shot(page, '02-registry-pending-drawer')
  await page.locator('.regapprove').first().click()
  await page.waitForFunction(() => !document.querySelector('.regapprove'))
  await page.waitForTimeout(400)
  await shot(page, '03-registry-approved')
  await page.close()
}

// ---- Feature 2: Build wizard — import agent-config.yaml ----
if (want('yaml')) {
  const page = await open('alice')
  await openBuildWizard(page)
  await page.waitForSelector('[data-bp]')
  await page.locator('[data-bp]').first().click()
  await page.locator('#n1').click()
  await page.waitForSelector('#actoggle')
  await shot(page, '04-wizard-compose-import-card')

  await page.locator('#actoggle').click()
  await page.waitForSelector('#acsample')
  await page.locator('#acsample').click()          // real GET /api/agent-config-sample
  await page.waitForFunction(() => document.querySelector('#acyaml')?.value.includes('retail-insights'))
  await shot(page, '05-wizard-yaml-pasted')

  // a genuinely invalid file must be refused, with the reason
  const good = await page.locator('#acyaml').inputValue()
  await page.locator('#acyaml').fill(good.replace('claude-haiku-4-5-20251001-v1:0', 'gpt-4o-turbo'))
  await page.locator('#acimport').click()
  await page.waitForSelector('.status.err')
  await shot(page, '06-wizard-yaml-rejected')

  await page.locator('#acyaml').fill(good)
  await page.locator('#acimport').click()          // real POST /api/agent-config-import
  await page.waitForSelector('#acclear')
  await shot(page, '07-wizard-yaml-imported-preview')
  await page.close()
}

await browser.close()
console.log(`\n${shots.length} screenshots -> ${SHOT_DIR}`)
