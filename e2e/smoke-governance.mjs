import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T07 smoke: Governance workflow over the unified AI Registry (T13C — the
// legacy mcp-/a2a-registry stores are retired). Deployed agents auto-register
// as DRAFT; MCP/A2A rows read from the registry and their lifecycle runs
// propose -> submit -> decide in the Governance Approval queue; the wizard
// offers APPROVED only; End User sees APPROVED agents only.
// Run: node e2e/smoke-governance.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard } from './login.mjs'

const admin = await apiLogin('melanie')
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`)

// Independent source of truth: the APIs the UI must agree with.
const apiGet = p => authedGet(p, admin)
const apiPost = (p, body) => authedPost(p, body, admin)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await uiLogin(page, 'melanie')

// --- Admin: Governance view lists all three governed resource kinds ---
const gov = await apiGet('/governance')
await page.locator('.nav', { hasText: 'Governance' }).click()
// wait for real data, not the "loading…" placeholder (which is also .empty)
await page.waitForSelector('#govmcp [data-gov]')
check('admin nav has Governance view', true)
check(`MCP section lists exactly ${gov.mcp.length} servers (from /api/governance, backed by the AI Registry)`,
  (await page.locator('#govmcp .item').count()) === gov.mcp.length && gov.mcp.length >= 2)
check(`A2A section lists exactly ${gov.a2a.length} agents (from /api/governance, backed by the AI Registry)`,
  (await page.locator('#gova2a .item').count()) === gov.a2a.length && gov.a2a.length >= 2)
check('MCP/A2A rows point at the registry lifecycle (no direct approve buttons)',
  (await page.locator('#govmcp .govact, #gova2a .govact').count()) === 0 &&
  (await page.locator('#govmcp .item').first().textContent()).includes('AI Registry'))
if (gov.agents.length === 0) {
  skip('deployed agents auto-register as DRAFT', 'live fleet is empty in this account right now; auto-register sync verified via API below')
  check('empty fleet renders an explicit empty state, not a dead section',
    (await page.locator('#govagents .empty').count()) === 1)
} else {
  check(`agents section lists exactly ${gov.agents.length} runtimes with approval badges`,
    (await page.locator('#govagents .item').count()) === gov.agents.length)
  check('every fleet agent carries an approval status from the registry',
    gov.agents.every(a => ['DRAFT', 'APPROVED', 'REJECTED'].includes(a.approval)))
}
check('backing store labeled console-local in the UI',
  (await page.locator('main').textContent()).includes('console-local store'))
check('governance page carries no mock/simulated wording (D6)',
  !/mock|simulated/i.test(await page.locator('main').textContent()))
await page.screenshot({ path: SHOT_DIR + 't07-admin-governance.png', fullPage: true })

// --- Auto-register semantics (API-level, falsifiable): fleet and governance agree ---
const fleet = await apiGet('/fleet')
check('governance agents === fleet agents (same sync)',
  gov.agents.length === fleet.agents.length &&
  fleet.agents.every(a => ['DRAFT', 'APPROVED', 'REJECTED'].includes(a.approval)))

// --- MCP lifecycle: propose -> submit -> approve via the Governance queue UI ---
// Test hygiene: this mutates persisted server-side shared state (gov-test-mcp /
// gov-test-a2a in ai-registry.json). Wrap in try/finally so cleanup always runs
// and repeated runs stay self-healing instead of self-corrupting.
try {
const reg = await apiPost('/registry-propose', {
  type: 'MCPServer', id: 'gov-test-mcp', name: 'Gov Test MCP',
  description: 'e2e governance lifecycle test server',
  content: { url: 'https://mcp.example/gov-test', transport: 'streamable_http' },
})
check('test MCP server proposed as DRAFT v1.0.0', reg.ok && reg.version.status === 'DRAFT' && reg.version.semver === '1.0.0')
const sub = await apiPost('/registry-submit', { id: 'gov-test-mcp', semver: '1.0.0' })
check('submit passes auto-checks -> IN_REVIEW', sub.ok !== false && sub.passed === true)

// the submitted version lands in the Governance Approval queue
// (TLP-B2: bounce via Platform Console Home to force a Governance re-render)
await page.locator('.nav[data-shellnav="home"]').click()
await page.locator('.nav', { hasText: 'Governance' }).click()
await page.waitForSelector('[data-queue="reg-gov-test-mcp-1.0.0"]')
check('IN_REVIEW version appears in the Approval queue', true)
await page.locator('[data-queue="reg-gov-test-mcp-1.0.0"] .qreg[data-d="approve"]').click()
await page.waitForSelector('[data-queue="reg-gov-test-mcp-1.0.0"]', { state: 'detached' })
const mcpNow = (await apiGet('/registry?type=MCPServer')).entries.find(e => e.id === 'gov-test-mcp')
check('queue approve persists server-side (IN_REVIEW → APPROVED, default advances)',
  mcpNow?.resolved?.status === 'APPROVED' && mcpNow.defaultVersion === '1.0.0')
await page.screenshot({ path: SHOT_DIR + 't07-admin-governance-approved.png', fullPage: true })

// --- A2A lifecycle: propose -> submit -> REJECT via the queue UI ---
const a2aReg = await apiPost('/registry-propose', {
  type: 'A2AAgent', id: 'gov-test-a2a', name: 'Gov Test A2A',
  description: 'e2e governance reject-path test agent',
  content: { baseUrl: 'https://agents.example/gov-test', card: { name: 'Gov Test A2A', description: 'e2e reject path', version: '1.0.0', authentication: { schemes: ['bearer'] } } },
})
check('test A2A agent proposed as DRAFT', a2aReg.ok && a2aReg.version.status === 'DRAFT')
const a2aSub = await apiPost('/registry-submit', { id: 'gov-test-a2a', semver: '1.0.0' })
check('A2A submit passes auto-checks -> IN_REVIEW', a2aSub.passed === true)
await page.locator('.nav[data-shellnav="home"]').click()
await page.locator('.nav', { hasText: 'Governance' }).click()
await page.waitForSelector('[data-queue="reg-gov-test-a2a-1.0.0"]')
// the reject button prompts for a reason; Playwright auto-dismisses -> ''
await page.locator('[data-queue="reg-gov-test-a2a-1.0.0"] .qreg[data-d="reject"]').click()
await page.waitForSelector('[data-queue="reg-gov-test-a2a-1.0.0"]', { state: 'detached' })
const a2aNow = (await apiGet('/registry?type=A2AAgent')).entries.find(e => e.id === 'gov-test-a2a')
check('queue reject persists server-side (IN_REVIEW → REJECTED)',
  a2aNow?.versions?.[0]?.status === 'REJECTED')

// --- Wizard offers APPROVED MCP/A2A only (counts from /api/wizard-picks) ---
const picks = await apiGet('/wizard-picks')
const approvedMcpCount = (picks.mcpServers || []).length
const approvedA2aCount = (picks.a2aAgents || []).length
await openBuildWizard(page)
await page.waitForSelector('[data-bp]')
await page.locator('[data-bp="chat-assistant"]').click()
await page.locator('#n1').click()
await page.waitForSelector('[data-mcpsrv], [data-a2apick]')
check(`wizard step 2 offers exactly ${approvedMcpCount} APPROVED MCP servers`,
  (await page.locator('[data-mcpsrv]').count()) === approvedMcpCount && approvedMcpCount >= 3)
check(`wizard step 2 offers exactly ${approvedA2aCount} APPROVED A2A agents`,
  (await page.locator('[data-a2apick]').count()) === approvedA2aCount && approvedA2aCount >= 1)
check('wizard never offers the REJECTED test A2A agent',
  (await page.locator('[data-a2apick="gov-test-a2a"]').count()) === 0)
check('wizard never offers the DRAFT A2A seed',
  (await page.locator('[data-a2apick="supply-chain-tracker"]').count()) === 0)
// picking an MCP server updates the live harness preview
await page.locator('[data-mcpsrv="gov-test-mcp"]').click()
check('picked MCP server lands in the harness preview',
  (await page.locator('#prev').textContent()).includes('gov-test-mcp'))
await page.screenshot({ path: SHOT_DIR + 't07-builder-wizard-approved.png', fullPage: true })

// --- Remove the test server, verify the wizard drops it on re-render ---
const rm1 = await apiPost('/registry-remove', { id: 'gov-test-mcp' })
check('registry-remove drops the test server', rm1.ok === true)
// leave and re-enter the wizard (step 2 state persists; re-entry re-fetches the gate)
await page.locator('.nav[data-shellnav="home"]').click()
await openBuildWizard(page)
await openBuildWizard(page)
await page.waitForSelector('[data-mcpsrv]')
check('wizard drops the removed server',
  (await page.locator('[data-mcpsrv="gov-test-mcp"]').count()) === 0)
// back to step 1 so later regression checks see a clean wizard
await page.locator('#b2').click()
await page.waitForSelector('[data-bp]')

// --- End User: only APPROVED agents in the Agents view; no governance nav ---
await uiLogin(page, 'enduser')
const userNav = await page.locator('.nav').allTextContents()
check('end user has no Governance nav', !userNav.some(t => t.includes('Governance')))
await page.locator('.nav', { hasText: 'Agents' }).click()
// B13.1: the loading spinner is itself a `.empty` node, so waiting for
// `.empty OR table` can resolve on the spinner while the cold /fleet AWS
// call is still in flight (independent review repro: rows=0 vs expected 1). Wait for the
// fetch to actually settle: spinner gone, then empty-state or table.
// B18: the enduser Agents page renders cards (.eufleetcard), not the table.
await page.waitForFunction(() => {
  const box = document.getElementById('fleetbox')
  return box && !box.querySelector('.spin') && (box.querySelector('.eufleetcard') || box.querySelector('.empty'))
}, null, { timeout: 60000 })
const userVisible = fleet.agents.filter(a => a.project && a.approval === 'APPROVED')
if (fleet.agents.length === 0) {
  skip('end user APPROVED-only fleet filter', 'live fleet is empty; filter verified via API above')
  check('end user Agents view shows an explicit empty state',
    (await page.locator('#fleetbox .empty').count()) === 1)
} else {
  check(`end user sees exactly ${userVisible.length} APPROVED agent cards (fleet has ${fleet.agents.length})`,
    (await page.locator('#fleetbox .eufleetcard').count()) === userVisible.length)
}
await page.screenshot({ path: SHOT_DIR + 't07-user-agents.png', fullPage: true })

// --- Builder: TLP-B2 removed the builder Governance nav entry (the requests
// inbox is no longer nav-reachable); governance for builders is an embedded
// workspace action. The access-request list semantics stay asserted via API.
await uiLogin(page, 'alice')
const builderNav = await page.locator('.nav').allTextContents()
check('builder has NO Governance nav destination (TLP-B2 Build Workspace nav)',
  !builderNav.some(t => t.includes('Governance')))
const alice = await apiLogin('alice')
const aliceReqs = await authedGet('/grant-requests', alice)
check('builder grant-requests API stays available and scoped to her own requests',
  Array.isArray(aliceReqs.requests) && aliceReqs.requests.every(r => r.requestedBy === 'alice'))

// --- Regression: AI Registry (replaces Catalog nav per T18) + wizard step 1 still render ---
await page.locator('.nav[data-shellnav="registry"]').click()
await page.waitForTimeout(400)
const regView = await page.locator('main').textContent()
check('AI Registry still renders (replaces old Catalog nav item)', regView.includes('AI Registry'))
await openBuildWizard(page)
await page.waitForTimeout(400)
check('Build wizard still renders step 1', (await page.locator('[data-bp]').count()) > 0)
} finally {
  // --- Cleanup: remove both test entries, unconditionally (self-healing).
  // "No registry entry" counts as clean — the entry was never created or
  // already removed by the in-flow check above.
  const gone = r => r.ok === true || /No registry entry/.test(r.error || '')
  const rm1 = await apiPost('/registry-remove', { id: 'gov-test-mcp' })
  const rm2 = await apiPost('/registry-remove', { id: 'gov-test-a2a' })
  check('test registry entries cleaned up', gone(rm1) && gone(rm2))
}

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
