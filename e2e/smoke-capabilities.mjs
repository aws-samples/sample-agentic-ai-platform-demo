// G1 smoke: capability bundles admin API. Reading/editing the bundle config is
// itself capability-gated (manageCapabilityBundles); edits are validated
// (default bundles stay, unknown capabilities rejected, no admin self-lockout)
// and take effect without a server restart (config is read per-request).
// Snapshots capability-bundles.json and ALWAYS restores it (finally), so the
// suite stays order-independent. G2 extends this with the route-migration
// checks. Run: node e2e/smoke-capabilities.mjs  (expects console on :4000)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawStatus = (p, token, body) =>
  fetch(BASE + '/api' + p, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  }).then(r => r.status)

const BUNDLES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'console', 'capability-bundles.json')
const snapshot = readFileSync(BUNDLES_PATH, 'utf8')

try {
  const admin = await apiLogin('melanie')
  const alice = await apiLogin('alice')
  const carol = await apiLogin('carol')

  // ---------- gating: bundle management is a capability, not a role string ----------
  check('no session -> 401', await rawStatus('/capability-bundles', null) === 401)
  check('builder cannot read bundles -> 403', await rawStatus('/capability-bundles', alice.token) === 403)
  check('lead cannot read bundles -> 403', await rawStatus('/capability-bundles', carol.token) === 403)
  check('builder cannot edit bundles -> 403', await rawStatus('/capability-bundles', alice.token, { config: {} }) === 403)

  // ---------- read: config + capability catalog ----------
  const r = await authedGet('/capability-bundles', admin)
  check('admin reads config with admin/lead/builder default bundles',
    r.ok === true && !!r.config.bundles.admin && !!r.config.bundles.lead && !!r.config.bundles.builder)
  check('response carries the capability catalog with descriptions',
    !!r.catalog && typeof r.catalog.manageCapabilityBundles === 'string')

  // ---------- validation: bad edits rejected, file untouched ----------
  const noBuilder = JSON.parse(JSON.stringify(r.config)); delete noBuilder.bundles.builder
  const v1 = await authedPost('/capability-bundles', { config: noBuilder }, admin)
  check('removing a default bundle rejected', v1.ok === false && /builder/.test(v1.error))
  const unknown = JSON.parse(JSON.stringify(r.config)); unknown.bundles.builder.capabilities.push('flyToTheMoon')
  const v2 = await authedPost('/capability-bundles', { config: unknown }, admin)
  check('unknown capability rejected', v2.ok === false && /unknown capability/.test(v2.error))
  const lockout = JSON.parse(JSON.stringify(r.config))
  lockout.bundles.admin.capabilities = lockout.bundles.admin.capabilities.filter(c => c !== 'manageCapabilityBundles')
  const v3 = await authedPost('/capability-bundles', { config: lockout }, admin)
  check('admin self-lockout rejected', v3.ok === false && /manageCapabilityBundles/.test(v3.error))

  // ---------- G2b (independent review Round 1): R-009..R-012 hardening ----------
  // R-011: validation failures are 4xx at the HTTP layer, not 200+ok:false.
  check('G2b R-011: validation failure returns 400', await rawStatus('/capability-bundles', admin.token, { config: lockout }) === 400)
  // R-010: malformed JSON body is a 400 client error, not a 500.
  const malformed = await fetch(BASE + '/api/capability-bundles', {
    method: 'POST', body: '{not json',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token },
  })
  check('G2b R-010: malformed JSON body returns 400', malformed.status === 400)
  // R-012: the shipped "user" bundle is a default — deleting it is rejected.
  const noUser = JSON.parse(JSON.stringify(r.config)); delete noUser.bundles.user
  const v4 = await authedPost('/capability-bundles', { config: noUser }, admin)
  check('G2b R-012: removing the user bundle rejected', v4.ok === false && /user/.test(v4.error))
  // R-009: platform-tier capabilities cannot be delegated to a domain bundle.
  const delegate = JSON.parse(JSON.stringify(r.config))
  delegate.domainOverrides[alice.domain] = { builder: { add: ['manageCapabilityBundles'] } }
  const v5 = await authedPost('/capability-bundles', { config: delegate }, admin)
  check('G2b R-009: platform-tier capability in domainOverrides.add rejected',
    v5.ok === false && /platform-tier/.test(v5.error))
  check('rejected edits did not touch the file', readFileSync(BUNDLES_PATH, 'utf8') === snapshot)

  // ---------- edit round-trip: a valid change takes effect immediately ----------
  const edited = JSON.parse(JSON.stringify(r.config))
  edited.bundles.builder.capabilities = edited.bundles.builder.capabilities.filter(c => c !== 'useBuilderSurfaces')
  const w = await authedPost('/capability-bundles', { config: edited }, admin)
  check('valid edit accepted', w.ok === true && !w.config.bundles.builder.capabilities.includes('useBuilderSurfaces'))
  const r2 = await authedGet('/capability-bundles', admin)
  check('edit persisted (re-read shows the change)', !r2.config.bundles.builder.capabilities.includes('useBuilderSurfaces'))

  // ---------- G2: routes obey the bundles LIVE (config-driven, no restart) ----------
  // The edit above stripped useBuilderSurfaces from builder: a builder session
  // must now 403 on a builder surface, and recover the instant it's restored.
  check('G2: builder loses Plato when bundle drops useBuilderSurfaces', await rawStatus('/plato-chat', alice.token) === 403)
  writeFileSync(BUNDLES_PATH, snapshot)
  check('G2: builder regains Plato when config is restored', await rawStatus('/plato-chat', alice.token) === 200)
  // domainOverrides is live too: remove decideAccessRequests from lead inside
  // carol's domain only -> the decide endpoint flips from its normal path to 403.
  const withOverride = JSON.parse(snapshot)
  withOverride.domainOverrides[carol.domain] = { lead: { remove: ['decideAccessRequests'] } }
  const ov = await authedPost('/capability-bundles', { config: withOverride }, admin)
  check('G2: domain override accepted', ov.ok === true)
  check('G2: domain override strips lead decide capability -> 403',
    await rawStatus('/obs-access-decide', carol.token, { requestId: 'x', decision: 'approve' }) === 403)
  writeFileSync(BUNDLES_PATH, snapshot)
  const afterRestore = await fetch(BASE + '/api/obs-access-decide', {
    method: 'POST', body: JSON.stringify({ requestId: 'nonexistent-request', decision: 'approve' }),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
  })
  check('G2: restore returns lead decide capability (404 unknown id, not 403)', afterRestore.status === 404)

  // ---------- G2 hygiene: zero session.role checks left in server.mjs ----------
  const serverSrc = readFileSync(path.join(path.dirname(BUNDLES_PATH), 'server.mjs'), 'utf8')
  check('G2 hygiene: no session.role checks remain in server.mjs', !/session\.role/.test(serverSrc))
  check('G2 hygiene: no role-string authorization comparisons in handlers',
    serverSrc.split('\n').filter(l => /\.role\s*[!=]==/.test(l) && !/IDENTITY DERIVATION|chat\.filter|u\.role/.test(l))
      .filter(l => !l.includes('user.role')).length === 0)
} finally {
  writeFileSync(BUNDLES_PATH, snapshot)
}

check('capability-bundles.json restored to committed state', readFileSync(BUNDLES_PATH, 'utf8') === snapshot)
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
