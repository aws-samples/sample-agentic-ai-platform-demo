import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// One-shot screenshot generator for TLP-B3 (Domain Console deepening):
//   domain-dashboard.png    — carol's Dashboard (health chips + per-project cost)
//   domain-projects.png     — Projects cards (type badge, env lights, compliance)
//   domain-users-access.png — Users & Access matrix (tri-state)
//   domain-approvals.png    — Governance & Approvals with ≥1 pending row and
//                             ≥1 escalated read-only row visible
// Seeds the two rows itself and cleans them up after. Expects console on :4000.
// Run: node e2e/fixtures/shot-tlp-b3-domain.mjs
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost } from '../login.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SHOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../artifacts/screenshots/tlp-b3')
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
const BASE = 'http://localhost:4000'

const alice = await apiLogin('alice')
const carol = await apiLogin('carol')
const admin = await apiLogin('melanie')

// seed: one pending domain-queue row (alice -> carol's queue) ...
const pending = await authedPost('/grant-request', {
  resourceType: 'tool', resourceId: 'order_lookup',
  purpose: 'Give supportdesk the order-lookup tool for the returns flow pilot',
  durationS: 3600, onBehalfOfProject: 'supportdesk',
}, alice)
// ... and one escalated read-only row (carol's own memory request -> platform peer queue)
const mems = await authedGet('/memories', carol)
const csMem = (mems.memories || []).find(m => m.domain === 'customer-support')
const escalated = csMem ? await authedPost('/grant-request', {
  resourceType: 'memory', resourceId: csMem.id,
  purpose: 'Review the returns-flow session summaries before the pilot readout',
  durationS: 3600,
}, carol) : null

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(BASE)
await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), carol)
await page.goto(BASE)
await page.waitForSelector('#dcbody', { timeout: 15000 })

const settle = () => page.waitForFunction(() => !document.querySelector('#dcbody .spin, main .spin'), null, { timeout: 20000 }).catch(() => {})

await settle(); await page.waitForTimeout(500)
await page.screenshot({ path: path.join(SHOT_DIR, 'domain-dashboard.png') })
console.log('shot: domain-dashboard.png')

await page.locator('.nav[data-shellnav="projects"]').click()
await page.waitForSelector('#dccreate', { timeout: 15000 })
await settle(); await page.waitForTimeout(400)
await page.screenshot({ path: path.join(SHOT_DIR, 'domain-projects.png') })
console.log('shot: domain-projects.png')

await page.locator('.nav[data-shellnav="users"]').click()
await page.waitForSelector('#dcbody table', { timeout: 15000 })
await page.waitForTimeout(400)
await page.screenshot({ path: path.join(SHOT_DIR, 'domain-users-access.png') })
console.log('shot: domain-users-access.png')

await page.locator('.nav[data-shellnav="governance"]').click()
await page.waitForFunction(() => {
  const t = document.querySelector('main')?.innerText || ''
  return /Domain Policy/i.test(t) && /Escalated to Platform/i.test(t) && /Pending/i.test(t)
}, null, { timeout: 20000 })
await page.waitForTimeout(400)
// fullPage: the pending queue, the escalated READ-ONLY tracker and the Domain
// Policy card are three same-page sections — the shot must show all of them.
await page.screenshot({ path: path.join(SHOT_DIR, 'domain-approvals.png'), fullPage: true })
console.log('shot: domain-approvals.png')

await browser.close()

// cleanup: reject both seeded rows (carol decides alice's; a platform peer
// decides carol's escalated row) so the demo state stays clean.
if (pending?.request?.id) await authedPost('/grant-decide', { requestId: pending.request.id, decision: 'reject' }, carol).catch(() => {})
if (escalated?.request?.id) await authedPost('/grant-decide', { requestId: escalated.request.id, decision: 'reject' }, admin).catch(() => {})
console.log('seed rows cleaned up')
