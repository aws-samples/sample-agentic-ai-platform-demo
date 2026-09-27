// R-015 smoke: memory-attribute claim path — an UNATTRIBUTED (domain:null)
// store is a governance task, not a dead end. Covers: platform-admin-only
// capability gate, unknown-domain / unknown-memoryId / already-owned
// rejections, the happy path (null -> domain + audit entry) and the
// Governance backlog badge. B23: the Memory-page "Attribute owner" UI is
// removed with the platform Memory Stores tab — the happy path runs through
// the API (POST /api/memory-attribute), which is unchanged.
// Self-sufficient (R-016 lesson): seeds its own orphan store into
// sim-memories.json — never depends on the account's real unattributed
// inventory — and restores every store it touches (sim-memories.json +
// memory-attributions.json snapshots), so back-to-back runs stay green.
// Run: node e2e/smoke-memory-attribute.mjs   (expects console server on :4000,
// or CONSOLE_BASE=http://localhost:<port> for a non-default server)
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawPost = (p, body, session) =>
  fetch(BASE + '/api' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.token },
    body: JSON.stringify(body),
  })

const ORPHAN = 'r015-attr-orphan'   // resolves to NO domain — the claim target

// Snapshot + restore the console-local stores this smoke mutates
// (smoke-pii-split pattern).
const memPath = new URL('../console/sim-memories.json', import.meta.url).pathname
const attrPath = new URL('../console/memory-attributions.json', import.meta.url).pathname
const auditPath = new URL('../console/obs-audit.json', import.meta.url).pathname
// A first hit seeds sim-memories.json on a fresh clone before we snapshot it.
const admin = await apiLogin('melanie')
await authedGet('/memories', admin)
const memSnap = existsSync(memPath) ? readFileSync(memPath, 'utf8') : null
const attrSnap = existsSync(attrPath) ? readFileSync(attrPath, 'utf8') : null
const auditSnap = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : null

const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support

const browser = await chromium.launch()
try {
  // ---------- fixture: an orphan store nothing resolves (domain:null) ----------
  const store = memSnap ? JSON.parse(memSnap) : []
  store.push({
    id: ORPHAN, name: 'r015AttrOrphanMemory', status: 'ACTIVE', simulated: true,
    eventExpiryDuration: 30, createdAt: '2026-08-06T00:00:00.000Z',
    strategies: [{ type: 'SEMANTIC', name: 'semantic_console', status: 'ACTIVE', namespaces: ['/'] }],
  })
  writeFileSync(memPath, JSON.stringify(store, null, 2))
  const orphanRow = ((await authedGet('/memories', admin)).memories || []).find(m => m.id === ORPHAN)
  check('fixture orphan surfaces in the admin inventory as domain:null', !!orphanRow && orphanRow.domain === null)

  // ---------- capability gate: platform admin only ----------
  check('builder (alice) is rejected with 403',
    (await rawPost('/memory-attribute', { memoryId: ORPHAN, domain: 'customer-support' }, alice)).status === 403)
  check('domain lead (carol) is rejected with 403',
    (await rawPost('/memory-attribute', { memoryId: ORPHAN, domain: 'customer-support' }, carol)).status === 403)

  // ---------- validation: domain must exist, store must exist + be unowned ----------
  check('unknown domain is rejected with 400',
    (await rawPost('/memory-attribute', { memoryId: ORPHAN, domain: 'no-such-domain' }, admin)).status === 400)
  check('unknown memoryId is rejected with 404',
    (await rawPost('/memory-attribute', { memoryId: 'no-such-memory', domain: 'customer-support' }, admin)).status === 404)
  check('a store that already has an owner is rejected with 400',
    (await rawPost('/memory-attribute', { memoryId: 'supportdesk-memory-seed', domain: 'operations' }, admin)).status === 400)
  check('rejected attempts left the orphan untouched (still domain:null)',
    ((await authedGet('/memories', admin)).memories || []).find(m => m.id === ORPHAN)?.domain === null)

  // ---------- Governance backlog badge: unattributed reads as a task ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'melanie')
  await page.locator('.nav', { hasText: 'Governance' }).click()
  await page.waitForSelector('[data-membacklog]', { timeout: 15000 })
  const badge = await page.locator('[data-membacklog]').textContent()
  check('Governance queue shows the "N store(s) need an owner" backlog badge', /need|owner/.test(badge))
  check('backlog badge count covers the orphan fixture',
    parseInt(await page.locator('[data-membacklog]').getAttribute('data-membacklog'), 10) >= 1)
  // B23: the badge no longer links to the removed Memory page — no jump button
  check('B23: backlog badge carries no jump to the removed Memory page',
    (await page.locator('#govmemgo').count()) === 0)

  // ---------- happy path via the API (B23: page UI removed, endpoint stays) ----------
  const attr = await rawPost('/memory-attribute', { memoryId: ORPHAN, domain: 'customer-support' }, admin)
  check('platform admin attributes the orphan via POST /api/memory-attribute (200)', attr.status === 200)
  check('attributed store left the admin default inventory (no longer null-bucket)',
    !((await authedGet('/memories', admin)).memories || []).some(m => m.id === ORPHAN))

  // ---------- the claim is real: domain stamped, owner can see it, audited ----------
  const adminCS = await apiLogin('melanie', 'okta', 'customer-support')
  const claimed = ((await authedGet('/memories', adminCS)).memories || []).find(m => m.id === ORPHAN)
  check('store domain went null -> customer-support', !!claimed && claimed.domain === 'customer-support')
  check('the owning domain lead (carol) now sees the store in her list',
    ((await authedGet('/memories', carol)).memories || []).some(m => m.id === ORPHAN))
  check('attribution wrote an audit entry (kind:memory action:attributed)',
    ((await authedGet('/obs-audit', admin)).events || []).some(e =>
      e.kind === 'memory' && e.memoryId === ORPHAN && e.action === 'attributed' && e.domain === 'customer-support'))
  check('re-attributing an already-claimed store is rejected with 400',
    (await rawPost('/memory-attribute', { memoryId: ORPHAN, domain: 'operations' }, admin)).status === 400)
} finally {
  // restore every store this smoke touched (R-016/R-017 lesson: leave the
  // checkout exactly as found so back-to-back runs and later smokes stay green)
  if (memSnap != null) writeFileSync(memPath, memSnap); else rmSync(memPath, { force: true })
  if (attrSnap != null) writeFileSync(attrPath, attrSnap); else rmSync(attrPath, { force: true })
  if (auditSnap != null) writeFileSync(auditPath, auditSnap); else rmSync(auditPath, { force: true })
  await browser.close()
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
