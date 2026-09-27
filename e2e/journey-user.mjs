import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T13 journey: End User — the POSITIVE approval path, end to end:
// 1. Platform Admin approves a deployed fleet agent in Governance.
// 2. End User persona sees exactly the APPROVED agents in Agents.
// 3. End User opens the approved agent and completes a REAL streaming chat.
// Per PRD: an empty-state or SKIP does NOT satisfy this journey — if no
// deployable agent exists the test FAILS loudly.
// Restores the agent's prior approval status afterward (leave state as found).
// Run: node e2e/journey-user.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const admin = await apiLogin('melanie')
const apiGet = p => authedGet(p, admin)
const apiPost = (p, body) => authedPost(p, body, admin)

// The journey needs one READY agent with a local project. T12 keeps supportdesk
// deployed for exactly this. Hard-fail if missing (no vacuous SKIP).
const fleet = await apiGet('/fleet')
const target = (fleet.agents || []).find(a => a.project && a.status === 'READY')
check('a READY deployable agent exists in the fleet (T12 keeps supportdesk)', !!target)
if (!target) {
  console.log('\nFATAL: positive approval path cannot run without a READY agent.')
  process.exit(1)
}
const priorApproval = target.approval

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await uiLogin(page, 'melanie')

// --- Step 1: Platform Admin approves the agent in Governance (UI, not API) ---
await page.locator('.nav', { hasText: 'Governance' }).click()
await page.waitForSelector(`[data-gov="${target.name}"]`, { timeout: 60000 })
if (priorApproval !== 'APPROVED') {
  await page.locator(`[data-gov="${target.name}"] .govact[data-to="APPROVED"]`).click()
  await page.waitForFunction(n =>
    document.querySelector(`[data-gov="${n}"]`)?.textContent.includes('APPROVED'), target.name)
}
const regNow = (await apiGet('/governance')).agents.find(a => a.name === target.name)
check(`admin approval persists server-side (${target.name} → APPROVED)`, regNow.approval === 'APPROVED')
await page.screenshot({ path: SHOT_DIR + 't13-user-admin-approves.png', fullPage: true })

// --- Step 2: End User sees exactly the APPROVED agents ---
await uiLogin(page, 'enduser')
const userNav = await page.locator('.nav').allTextContents()
check('end user nav is Overview + Agents only',
  userNav.length === 2 && userNav.some(t => t.includes('Agents')))
await page.locator('.nav', { hasText: 'Agents' }).click()
// the loading state is also .empty (with a spinner) — wait for the spinner to clear
// B18: the enduser Agents page renders cards (.eufleetcard), not the table.
await page.waitForFunction(() => {
  const box = document.getElementById('fleetbox')
  return box && !box.querySelector('.spin') && (box.querySelector('.eufleetcard') || box.querySelector('.empty'))
}, null, { timeout: 60000 })
const fleetNow = (await apiGet('/fleet')).agents
const approvedNow = fleetNow.filter(a => a.project && a.approval === 'APPROVED')
check(`end user sees exactly ${approvedNow.length} APPROVED agent card(s) (fleet has ${fleetNow.length})`,
  approvedNow.length >= 1 &&
  (await page.locator('#fleetbox .eufleetcard').count()) === approvedNow.length)
check('end user sees no approval/cost surface and no Delete buttons',
  (await page.locator('.gdel').count()) === 0 &&
  !(await page.locator('#fleetbox').textContent()).includes('APPROVED'))
await page.screenshot({ path: SHOT_DIR + 't13-user-agents.png', fullPage: true })

// --- Step 3: End User opens the approved agent and chats for real ---
await page.locator(`[data-agent="${target.project}"]`).click()
await page.waitForSelector('#fmsg')
check('end user agent page is chat-only (no setup/metadata, no eval/evidence cards)',
  (await page.locator('#detailbox').count()) === 0 &&
  (await page.locator('#gecard').count()) === 0 &&
  (await page.locator('#pecard').count()) === 0)
await page.fill('#fmsg', 'In one short sentence, what can you help me with?')
await page.locator('#fsend').click()
// Streaming completes when the agent message has real text and no spinner.
await page.waitForFunction(() => {
  const chat = document.getElementById('fchat')
  if (!chat || chat.querySelector('.spin')) return false
  const msgs = chat.querySelectorAll('.msg .body')
  const last = msgs[msgs.length - 1]
  return last && last.textContent.trim().length > 30
}, null, { timeout: 180000 })
const chatTxt = await page.locator('#fchat').textContent()
check('real streaming chat returns a substantive response (>30 chars, no error)',
  chatTxt.length > 60 && !chatTxt.includes('⚠') && !chatTxt.includes('(no response)') &&
  !/MODULE_NOT_FOUND|Traceback \(most recent call last\)|Cannot find module/.test(chatTxt))
console.log(`(agent replied: ${chatTxt.slice(-140).replace(/\s+/g, ' ').trim()})`)
await page.screenshot({ path: SHOT_DIR + 't13-user-chat.png', fullPage: true })

// --- Restore prior approval status (leave the registry as we found it) ---
if (priorApproval !== 'APPROVED') {
  const back = await apiPost('/agent-status', { id: target.name, status: priorApproval })
  check(`restored ${target.name} approval to ${priorApproval}`, back.ok && back.agent.status === priorApproval)
}

await browser.close()
console.log(`\n${failures} failure(s)`)
process.exit(failures ? 1 : 0)
