// G7 smoke: unified access-requests inbox over the G3 grant store (§7 ③④),
// now living as the Governance › Access requests tab (the standalone Requests
// nav item folded in — owner request 2026-08-06). ONE queue for every
// grant-request type with approve/reject (purpose + expiry visible),
// type/status/domain filters that only ever NARROW the server-scoped set
// (a domain-scoped session cannot widen into a foreign domain via ?domain=),
// decide buttons rendered only for deciders and never on own requests (R-002
// stays server-enforced), and the compat links: the lead's old obs approvals
// tab and the admin's grant-metadata panel both land on the Governance tab.
// Run: node e2e/smoke-inbox.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin, openAdminOps, ADMIN_NAV } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

// Unique resource ids per run — the grant store is in-memory and accumulates
// across suite runs on a long-lived server; uniqueness keeps checks exact.
const RUN = `inbox-${process.pid}-${Date.now().toString(36)}`
const TOOL_A = `${RUN}-tool-approve`
const TOOL_B = `${RUN}-tool-reject`
const TOOL_OPS = `${RUN}-tool-ops`

// ---------- seed: three requests across two domains + two types ----------
const reqA = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: TOOL_A, purpose: 'G7 smoke: approve path', durationS: 3600 }, alice)).request
const reqB = (await authedPost('/grant-request', { resourceType: 'toolCredential', resourceId: TOOL_B, purpose: 'G7 smoke: reject path', durationS: 3600, evidence: 'eval-run-42' }, alice)).request
const reqOps = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: TOOL_OPS, purpose: 'G7 smoke: operations-domain row', durationS: 3600 }, bob)).request
check('seed: three pending requests created', !!reqA?.id && !!reqB?.id && !!reqOps?.id)

// ---------- API filters (status/domain are new in G7) ----------
const byStatus = (await authedGet('/grant-requests?status=pending', admin)).requests
check('?status=pending returns only pending rows', byStatus.length > 0 && byStatus.every(r => r.status === 'pending'))
const byType = (await authedGet('/grant-requests?type=toolCredential', admin)).requests
check('?type= filter still narrows to one resourceType', byType.some(r => r.id === reqB.id) && byType.every(r => r.resourceType === 'toolCredential'))
const byDomain = (await authedGet('/grant-requests?domain=operations', admin)).requests
check('admin ?domain=operations narrows to that domain', byDomain.some(r => r.id === reqOps.id) && byDomain.every(r => r.domain === 'operations'))
const combined = (await authedGet('/grant-requests?type=tool&status=pending&domain=customer-support', admin)).requests
check('filters combine (type+status+domain)', combined.some(r => r.id === reqA.id) && !combined.some(r => r.id === reqOps.id || r.id === reqB.id))
// Security: filters narrow the SCOPED set — a domain-scoped lead cannot widen
// into a foreign domain by naming it.
const carolForeign = (await authedGet('/grant-requests?domain=operations', carol)).requests
check('lead ?domain=<foreign> yields nothing (filter never widens scope)', carolForeign.length === 0)
check('end user cannot list the queue -> 403',
  (await fetch(BASE + '/api/grant-requests', { headers: { authorization: 'Bearer ' + enduser.token } })).status === 403)

// ---------- inbox UI ----------
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

  // The inbox is the Governance › Access requests tab now (lead + admin nav
  // both carry a governance entry in the TLP-B2 shells; builders don't).
  const openInbox = async () => {
    await page.locator('.nav[data-shellnav="governance"]').click()
    await page.waitForSelector('.govtab[data-tab="requests"]')
    await page.locator('.govtab[data-tab="requests"]').click()
    await page.waitForSelector('#reqinbox')
  }

  // Lead: nav entry, pending rows with purpose, approve + reject with expiry visible.
  await uiLogin(page, 'carol')
  await openInbox()
  await page.waitForSelector('#reqinbox .item')
  let txt = await page.locator('#reqinbox').textContent()
  check('lead inbox shows the pending request with its purpose', txt.includes(TOOL_A) && txt.includes('approve path'))
  check('lead inbox shows both types in ONE queue', txt.includes(TOOL_A) && txt.includes(TOOL_B))
  check('toolCredential row surfaces its evidence', txt.includes('eval-run-42'))
  check('lead sees decide buttons on domain requests', (await page.locator(`.req-decide[data-d="approve"]`).count()) >= 2)
  // approve A from the UI -> lands in history with approver + expiry visible
  await page.locator(`.req-decide[data-req="${reqA.id}"][data-d="approve"]`).click()
  await page.waitForFunction(id => !document.querySelector(`.req-decide[data-req="${id}"]`), reqA.id)
  txt = await page.locator('#reqinbox').textContent()
  check('approved request moves to history with approver + expiry visible',
    txt.includes('decided by carol') && txt.includes('expires') && txt.includes('approved'))
  // reject B from the UI
  await page.locator(`.req-decide[data-req="${reqB.id}"][data-d="reject"]`).click()
  await page.waitForFunction(id => !document.querySelector(`.req-decide[data-req="${id}"]`), reqB.id)
  txt = await page.locator('#reqinbox').textContent()
  check('rejected request shows in history as rejected', txt.includes('rejected'))
  const afterA = (await authedGet('/grant-requests?type=tool', carol)).requests.find(r => r.id === reqA.id)
  const afterB = (await authedGet('/grant-requests?type=toolCredential', carol)).requests.find(r => r.id === reqB.id)
  check('UI decisions landed server-side (approved + rejected, decidedBy carol)',
    afterA?.status === 'approved' && !!afterA?.expiresAt && afterB?.status === 'rejected' && afterB?.decidedBy === 'carol')
  // status filter in the UI. Wait for TOOL_B to DISAPPEAR, not TOOL_A to
  // appear — A is already in the pre-filter DOM (decision history), so the
  // old wait could resolve on stale content and read B before the re-render
  // (flaked on a long-lived server whose accumulated grant store slows the
  // filtered reload).
  await page.locator('#reqfstatus').selectOption('approved')
  await page.waitForFunction(id => {
    const t = document.querySelector('#reqinbox')?.textContent || ''
    return t && !t.includes(id)
  }, TOOL_B)
  txt = await page.locator('#reqinbox').textContent()
  check('UI status filter narrows to approved rows', txt.includes(TOOL_A) && !txt.includes(TOOL_B))
  check('lead has no domain filter (domain-scoped session)', (await page.locator('#reqfdomain').count()) === 0)
  // own request renders without decide buttons (R-002 affordance mirror)
  const carolOwn = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: `${RUN}-carol-own`, purpose: 'G7 smoke: own request', durationS: 600 }, carol)).request
  await page.locator('#reqfstatus').selectOption('pending')
  await page.waitForFunction(id => document.querySelector('#reqinbox')?.textContent.includes(id), `${RUN}-carol-own`)
  check('a decider\'s OWN request carries no decide buttons',
    (await page.locator(`.req-decide[data-req="${carolOwn.id}"]`).count()) === 0)

  // Lead route to the inbox: TLP-B2 retired the lead's Observability nav
  // entry (obs is content-link-only for leads), so the old obs
  // "Access requests →" compat hop is not nav-reachable. The lead-driven
  // route IS the nav: Governance & Approvals lands on the same inbox.
  await page.locator('.nav[data-shellnav="governance"]').click()
  await page.waitForSelector('.nav.active[data-view="governance"]')
  await page.waitForSelector('#reqinbox')
  check('lead Governance & Approvals nav lands on the access-requests inbox', true)
  check('lead sees ONLY the access-requests Governance tab (no admin tabs)',
    (await page.locator('.govtab').count()) === 1 &&
    (await page.locator('.govtab[data-tab="requests"]').count()) === 1)

  // Builder: TLP-B2 — no Governance nav at all (request-access is an inline
  // action, never a nav destination). Assert the absence, then the same
  // visibility rules via the API the inbox rendered from: own requests with
  // status, and deciding stays forbidden (R-002 server-enforced).
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot')
  const aliceNav = await page.locator('.nav').allTextContents()
  check('builder has no Governance nav entry (inbox not nav-reachable)', !aliceNav.some(t => t.includes('Governance')))
  const aliceReqs = (await authedGet('/grant-requests', alice)).requests
  check('builder still sees own requests with status (API)',
    aliceReqs.some(r => r.resourceId === TOOL_A && r.status === 'approved'))
  check('builder cannot decide (server-enforced) -> 403',
    (await fetch(BASE + '/api/grant-decide', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token }, body: JSON.stringify({ requestId: reqOps.id, decision: 'approve' }) })).status === 403)

  // Admin: cross-domain metadata view with a domain filter, no decide buttons.
  await uiLogin(page, 'melanie')
  await openInbox()
  await page.waitForSelector('#reqinbox .item')
  txt = await page.locator('#reqinbox').textContent()
  check('admin inbox spans domains (customer-support + operations rows)', txt.includes(TOOL_A) && txt.includes(TOOL_OPS))
  check('admin gets the domain filter', (await page.locator('#reqfdomain').count()) === 1)
  await page.locator('#reqfdomain').selectOption('operations')
  await page.waitForFunction(id => document.querySelector('#reqinbox')?.textContent.includes(id), TOOL_OPS)
  txt = await page.locator('#reqinbox').textContent()
  check('admin UI domain filter narrows to operations', txt.includes(TOOL_OPS) && !txt.includes(TOOL_A))
  check('admin (no decideAccessRequests) sees no decide buttons', (await page.locator('.req-decide').count()) === 0)
  // Admin compat link: obs grant-metadata panel leads to the Governance tab.
  await openAdminOps(page, 'observability')
  await page.waitForSelector('#agopeninbox')
  await page.locator('#agopeninbox').click()
  await page.waitForSelector('.nav.active[data-view="governance"]')
  await page.waitForSelector('#reqinbox')
  check('admin obs grant-metadata panel links into Governance › Access requests', true)

  // No standalone Requests nav item for any persona — TLP-B2 shells render
  // exactly these per-role nav lists (icon-stripped for comparison).
  const EXPECT_NAV = {
    melanie: ADMIN_NAV,
    alice: ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry'],
    carol: ['Dashboard', 'Projects', 'Users & Access', 'Governance & Approvals',
      'Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry'],
  }
  for (const u of ['melanie', 'alice', 'carol']) {
    await uiLogin(page, u)
    const nv = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^A-Za-z]+/, ''))
    check(`${u} nav is exactly the ${u === 'melanie' ? 'admin' : u === 'carol' ? 'lead' : 'builder'} shell list (no Requests residue)`,
      JSON.stringify(nv) === JSON.stringify(EXPECT_NAV[u]))
  }

  // End user: no Requests nav (and no Governance either).
  await uiLogin(page, 'enduser')
  const nav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^A-Za-z]+/, ''))
  check('end user nav is exactly Overview/Agents', JSON.stringify(nav) === JSON.stringify(['Overview', 'Agents']))
  check('end user has no Governance nav entry', !nav.some(t => t.includes('Governance')))
} finally {
  await browser.close()
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
