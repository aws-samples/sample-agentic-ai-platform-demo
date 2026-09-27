import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T09/T34 smoke — memory listing, PII masking, grants and persona scoping.
// B23: the platform-level Memory Stores PAGE is removed (owner decision,
// Melanie 2026-08-14) — memory belongs under each agent (workspace Memory &
// KB tab). Every server API this smoke exercised is UNCHANGED, so the old
// page-level assertions are kept at the API level; the surviving UI surface
// (workspace Memory & KB tab) carries the UI assertions.
// Run: node e2e/smoke-memory.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard, openAdminOps } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const admin = await apiLogin('melanie')
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0, skips = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const skip = (name, reason) => { console.log(`SKIP  ${name} — ${reason}`); skips++ }

// Independent source of truth: the API (unchanged by B23).
const mem = await authedGet('/memories', admin)
const realMems = (mem.memories || []).filter(m => !m.simulated)

// --- API: listing still serves real AgentCore resources + metadata ---
check('/api/memories returns a list', Array.isArray(mem.memories))
if (realMems.length) {
  const withStrats = realMems.find(m => (m.strategies || []).length)
  if (withStrats) {
    check(`real memory ${withStrats.name} carries its ${withStrats.strategies.length} strategies`,
      withStrats.strategies.every(s => s.type))
  } else {
    skip('strategy metadata on a real memory', 'no real memory in the account has long-term strategies')
  }
} else {
  skip('real memory rows', 'account has no real AgentCore Memory resources')
}
if (mem.memories.length) {
  const anyRow = mem.memories[0]
  check('memory rows carry event/record counts (T34 metadata)',
    typeof anyRow.eventCount === 'number' && typeof anyRow.recordCount === 'number')
} else {
  skip('T34 counts checks', 'no memories in this account')
}

// --- B23 negative: the Memory Stores tab is gone for EVERY persona; the
// removed view is not routable; per-agent Memory & KB survives ---
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
const stripIcon = t => t.replace(/^[^\w]+/, '').trim()
for (const [user, hasMemKb] of [['melanie', true], ['carol', true], ['alice', true], ['enduser', false]]) {
  await uiLogin(page, user)
  const nav = (await page.locator('.nav').allTextContents()).map(stripIcon)
  check(`B23 ${user}: nav has NO "Memory Stores" (and no bare "Memory") entry`,
    !nav.some(t => t === 'Memory Stores' || t === 'Memory'))
  if (hasMemKb) check(`B23 ${user}: per-agent "Memory & KB" workspace tab survives`,
    nav.some(t => t === 'Memory & KB'))
}
// the removed view has no route left: state is module-scoped and there is no
// hash routing, so the only entries were nav nodes / in-app jump buttons —
// assert none of those exist and the page's container never renders.
await uiLogin(page, 'melanie')
check('B23 no DOM node routes to the removed memory view (nav/jump buttons gone, no #membox)',
  (await page.locator('.nav[data-shellnav="memory"]').count()) === 0 &&
  (await page.locator('#govmemgo, #wsmemfull').count()) === 0 &&
  (await page.locator('#membox').count()) === 0)

// --- T10/TLP-B1/G12 access model (API level — server untouched by B23) ---
const domainTeamMems = mem.memories.filter(m => m.domain !== 'platform' && m.domain != null)
const platformMems = mem.memories.filter(m => m.domain === 'platform')
check('G12 admin default list has zero domain-team entries', domainTeamMems.length === 0)
// self-heal: a live grant from an earlier run on this server would 200 here
await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, admin)
const adminExtStatus = await fetch(BASE + '/api/memory-extractions?memoryId=supportdesk-memory-seed',
  { headers: { authorization: 'Bearer ' + admin.token } }).then(r => r.status)
check('T10 admin -> domain-team memory-extractions API is 403', adminExtStatus === 403)
if (platformMems.length) {
  const pmStatus = await fetch(BASE + '/api/memory-extractions?memoryId=' + encodeURIComponent(platformMems[0].id),
    { headers: { authorization: 'Bearer ' + admin.token } }).then(r => r.status)
  check('TLP-B1: admin platform-domain store is LOCKED without a grant (memory grant-gated all roles)',
    pmStatus === 403)
} else skip('admin platform-store memory lock', 'no platform-domain memory store')

// --- T34 masking + grant flow, exercised as a builder (alice) ---
// UI surface: the workspace Memory & KB tab (the ONLY memory UI post-B23);
// grant approval + masked extraction read stay API-level (endpoints unchanged).
const alice = await apiLogin('alice')
const aliceMems = (await authedGet('/memories', alice)).memories || []
if (aliceMems.length) {
  await uiLogin(page, 'alice')
  check('builder nav has Memory & KB (memory content lives in the workspace)',
    (await page.locator('.nav[data-shellnav="memorykb"]').count()) === 1)
  await page.locator('.nav[data-shellnav="memorykb"]').click()
  await page.waitForSelector('.wsmemrow', { timeout: 30000 })
  check('workspace Memory & KB renders memory rows collapsed with Request Access',
    (await page.locator('.wsmemrequest').count()) >= 1)
  check('workspace memory rows never render extraction content by default',
    !(await page.locator('#wsbody').textContent()).includes('masked by default'))
  await page.screenshot({ path: SHOT_DIR + 't34-memory-workspace.png', fullPage: true })

  const target = aliceMems[0]
  // self-heal: a previous run's grant may still be live for alice
  await authedPost('/obs-access-revoke', { kind: 'memory', id: target.id }, alice)
  const lockedRead = await authedGet('/memory-extractions?memoryId=' + encodeURIComponent(target.id), alice)
  check('memory extractions locked behind elevated access by default (API)',
    lockedRead.ok === true && lockedRead.locked === true && !lockedRead.extractions)
  // T11: request -> same-domain lead approves -> masked preview renders
  const req = (await authedPost('/obs-access-request',
    { kind: 'memory', id: target.id, justification: 'memory smoke: verifying extraction masking', durationS: 3600 }, alice)).request
  check('T11 access request files (pending)', !!req && req.status === 'pending')
  const carol = await apiLogin('carol')
  const memPending = (await authedGet('/obs-access-requests', carol)).requests.find(r => r.status === 'pending' && r.kind === 'memory' && r.resourceId === target.id)
  check('T11 memory access request lands in the lead queue', !!memPending)
  await authedPost('/obs-access-decide', { requestId: memPending.id, decision: 'approve' }, carol)
  const grantedRead = await authedGet('/memory-extractions?memoryId=' + encodeURIComponent(target.id), alice)
  check('after lead approval, extraction preview returns (masked)',
    grantedRead.ok === true && grantedRead.locked === false)
  const firstRec = (grantedRead.extractions || [])[0]
  if (firstRec) {
    await authedPost('/obs-audit', { memoryId: target.id, recordId: firstRec.recordId, action: 'reveal', kind: 'memory' }, alice)
    const audit = await authedGet('/obs-audit', admin)
    check('reveal action wrote a memory-kind audit entry (admin sees the metadata)',
      (audit.events || []).some(e => e.kind === 'memory' && e.memoryId === target.id))
  } else {
    skip('memory extraction reveal/audit', 'no extraction preview rows for this memory')
  }
  // Hygiene: revoke the smoke grant so later tests keep their default-deny.
  await authedPost('/obs-access-revoke', { kind: 'memory', id: target.id }, alice)
  const revokedExt = await authedGet('/memory-extractions?memoryId=' + encodeURIComponent(target.id), alice)
  check('cleanup: revoking the smoke grant re-locks memory extractions for alice',
    revokedExt.ok === true && revokedExt.locked === true && !revokedExt.extractions)
} else {
  skip('memory PII masking checks', 'no memories visible to alice')
}

// --- Console-local create/remove (API level — the page form is removed) ---
const simName = 'SmokeTestMemory' + Date.now().toString(36)
const created = await authedPost('/memory-create',
  { name: simName, eventExpiryDuration: 30, strategies: ['SEMANTIC', 'USER_PREFERENCE'] }, admin)
check('memory-create API still works (illustrative store)', created.ok === true && created.memory?.name === simName)
const after = await authedGet('/memories', admin)
check('create added exactly one entry (API count +1)',
  after.memories.length === mem.memories.length + 1)
const simRow = after.memories.find(m => m.name === simName)
check('created memory is flagged simulated (illustrative) with both strategies',
  !!simRow && simRow.simulated === true &&
  ['SEMANTIC', 'USER_PREFERENCE'].every(t => (simRow.strategies || []).some(s => s.type === t)))
const removed = await authedPost('/memory-remove', { id: simRow?.id }, admin)
check('memory-remove API still works', removed.ok === true)
const cleaned = await authedGet('/memories', admin)
check('remove restored the original API count', cleaned.memories.length === mem.memories.length)

// --- API guard: real memories cannot be removed via the sim endpoint ---
if (realMems.length) {
  const guard = await authedPost('/memory-remove', { id: realMems[0].id }, admin)
  check('memory-remove refuses a real (cloud) memory id', guard.ok === false)
} else {
  skip('real-memory remove guard', 'no real memories to test against')
}

// --- Persona scoping (T10 inversion, TLP-B2 shells): builder's memory surface
// is the workspace Memory & KB tab; end user has none ---
await uiLogin(page, 'alice')
let nav = (await page.locator('.nav').allTextContents()).map(stripIcon)
check('builder nav is the exact Build Workspace list (Memory & KB carries the memory surface)',
  nav.join('|') === ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry'].join('|'))
await uiLogin(page, 'enduser')
nav = (await page.locator('.nav').allTextContents()).map(stripIcon)
check('end user nav is Overview + Agents only (no Memory)',
  nav.length === 2 && nav.some(t => t.includes('Agents')) && !nav.some(t => t.includes('Memory')))

// --- Regression: fleet + wizard still render for admin ---
await uiLogin(page, 'melanie')
await openAdminOps(page, 'fleet')
await page.waitForFunction(() => {
  const b = document.querySelector('#fleetbox')
  return b && !b.textContent.includes('loading')
}, { timeout: 30000 })
const fleet = await authedGet('/fleet', admin)
check(`fleet still renders (${fleet.agents.length} agents or empty state)`,
  fleet.agents.length
    ? (await page.locator('#fleetbox tbody tr').count()) === fleet.agents.length
    : (await page.locator('#fleetbox .empty').count()) === 1)
await openBuildWizard(page)
await page.waitForTimeout(400)
check('Build wizard still renders step 1', (await page.locator('[data-bp]').count()) > 0)

await browser.close()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}${skips ? ` (${skips} skipped)` : ''}`)
process.exit(failures === 0 ? 0 : 1)
