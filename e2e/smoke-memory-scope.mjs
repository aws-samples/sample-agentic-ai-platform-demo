// G12 smoke: memory SCOPE isolation on top of the G4 PII split (Melanie UI
// finding, 2026-08-02). The platform admin's DEFAULT memory view is the
// platform account's own stores only; a domain team's memory METADATA is
// visible only inside that domain's view (active-domain switch / domain-detail);
// cross-domain CONTENT stays behind the G3 break-glass grant + audit path.
// Run: node e2e/smoke-memory-scope.mjs   (expects console server on :4000)
import { apiLogin, apiSwitchDomain, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawGet = (p, token) =>
  fetch(BASE + '/api' + p, token ? { headers: { authorization: 'Bearer ' + token } } : {})

const admin = await apiLogin('melanie')          // fleet-wide (all domains)
const alice = await apiLogin('alice')            // builder, customer-support
const carol = await apiLogin('carol')            // lead, customer-support
const SEED = 'supportdesk-memory-seed'           // customer-support domain store

// ---------- 1. admin DEFAULT list: zero domain-agent entries ----------
const defaultList = (await authedGet('/memories', admin)).memories || []
check('admin default (all-domains) list is non-empty (platform stores exist)',
  defaultList.some(m => m.domain === 'platform'))
// G18: unattributed (domain:null) stores may appear as governance metadata —
// only NAMED domain teams' stores are excluded from the default inventory.
check('admin default list contains ZERO domain-agent entries (platform/shared/unattributed only)',
  defaultList.every(m => m.domain === 'platform' || m.domain === 'shared' || m.domain == null))
check(`admin default list omits the ${SEED} customer-support store`,
  !defaultList.some(m => m.id === SEED))

// ---------- 2. domain-scoped admin view: that domain's metadata only ----------
const adminCS = await apiSwitchDomain(admin, 'customer-support')
const csList = (await authedGet('/memories', adminCS)).memories || []
check('domain-scoped admin view lists the domain\'s stores (metadata incl. seed)',
  csList.some(m => m.id === SEED))
check('domain-scoped admin view never mixes in OTHER domains\' stores',
  csList.every(m => m.domain === 'customer-support' || m.domain === 'shared'))
await apiSwitchDomain(admin, null) // restore fleet-wide scope for content checks

// ---------- 3. content stays break-glass regardless of list visibility ----------
// self-heal: drop any live grant from an earlier run on this server
await authedPost('/obs-access-revoke', { kind: 'memory', id: SEED }, admin)
check('admin -> domain-store content by ID is 403 without a grant (list scoping is not an access change)',
  (await rawGet('/memory-extractions?memoryId=' + SEED, admin.token)).status === 403)
const req = (await authedPost('/grant-request',
  { resourceType: 'memory', resourceId: SEED, purpose: 'G12 smoke: cross-domain break-glass', durationS: 3600 }, admin)).request
check('admin break-glass request still routes to the owning domain', !!req && req.domain === 'customer-support')
await authedPost('/grant-decide', { requestId: req.id, decision: 'approve' }, carol)
const unlocked = await authedGet('/memory-extractions?memoryId=' + SEED, admin)
check('approved grant unlocks the domain store (masked) for the admin',
  unlocked.ok === true && unlocked.locked === false && (unlocked.extractions || []).every(e => e.masked === true))
check('break-glass read is audit-logged with grant id + purpose',
  ((await authedGet('/obs-audit', admin)).events || []).some(e =>
    e.action === 'break-glass-read' && e.memoryId === SEED && e.requestId === req.id))
await authedPost('/obs-access-revoke', { kind: 'memory', id: SEED }, admin)
check('revoke re-locks the content path',
  (await rawGet('/memory-extractions?memoryId=' + SEED, admin.token)).status === 403)

// ---------- 4. domain-plane scoping unchanged ----------
check('builder list still own-domain + shared only',
  ((await authedGet('/memories', alice)).memories || []).every(m => m.domain === 'customer-support' || m.domain === 'shared'))
check('lead list still own-domain + shared only',
  ((await authedGet('/memories', carol)).memories || []).every(m => m.domain === 'customer-support' || m.domain === 'shared'))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
