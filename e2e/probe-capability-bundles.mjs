// independent review Round 1 adversarial probes — G1 capability API
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = 'http://localhost:4000'
let failures = 0
const check = (name, ok, extra='') => { console.log(`${ok?'PASS':'FAIL'}  ${name}${extra?'  | '+extra:''}`); if(!ok) failures++ }
const BUNDLES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'console', 'capability-bundles.json')
const snapshot = readFileSync(BUNDLES_PATH, 'utf8')

try {
  const admin = await apiLogin('melanie')
  const alice = await apiLogin('alice') // builder

  // A. R-005 real config-driven test: brand-new custom bundle accepted without code change
  const r = await authedGet('/capability-bundles', admin)
  const cfg = JSON.parse(JSON.stringify(r.config))
  cfg.bundles.auditor = { description: 'independent review probe', capabilities: ['viewAlerts', 'viewDomainOperations'] }
  const w = await authedPost('/capability-bundles', { config: cfg }, admin)
  check('A1: brand-new custom bundle accepted (config-driven, no code change)', w.ok === true && !!w.config.bundles.auditor)
  const r2 = await authedGet('/capability-bundles', admin)
  check('A2: custom bundle persisted', !!r2.config.bundles.auditor)

  // B. escalation surface: domainOverrides can add ADMIN capability to builder — accepted?
  const esc = JSON.parse(JSON.stringify(r2.config))
  // R-009 FIXED (G2b @ c269503): expectations flipped — platform-tier capability in
  // domainOverrides.add must now be REJECTED (PLATFORM_TIER set in capabilities.mjs).
  esc.domainOverrides = { 'customer-support': { builder: { add: ['manageCapabilityBundles'] } } }
  const we = await authedPost('/capability-bundles', { config: esc }, admin)
  check('B1: override escalating builder->manageCapabilityBundles REJECTED (R-009 platform-tier guard)', we.ok === false && /platform-tier/.test(we.error || ''), `ok=${we.ok} err=${we.error||''}`)
  // and it must NOT take effect: builder still cannot read bundles config
  {
    const st = await fetch(BASE + '/api/capability-bundles', { headers: { authorization: 'Bearer ' + alice.token } }).then(x=>x.status)
    check('B2: builder(customer-support) still cannot READ bundles (no escalation leaked)', st === 403, `status=${st}`)
  }
  // restore before next probes (no-op if rejected, kept for safety)
  await authedPost('/capability-bundles', { config: r.config }, admin)

  // C. malformed body handling
  const mal = await fetch(BASE + '/api/capability-bundles', { method: 'POST', headers: { 'content-type':'application/json', authorization: 'Bearer ' + admin.token }, body: '{not json' }).then(x=>x.status).catch(()=> 'ERR')
  check('C1: malformed JSON body does not 500', mal !== 500 && mal !== 'ERR', `status=${mal}`)

  // D. validation-failure status code hygiene (returns 200+ok:false today?)
  const bad = JSON.parse(JSON.stringify(r.config)); delete bad.bundles.builder
  const badRes = await fetch(BASE + '/api/capability-bundles', { method: 'POST', headers: { 'content-type':'application/json', authorization: 'Bearer ' + admin.token }, body: JSON.stringify({ config: bad }) })
  check('D1: invalid config returns 4xx (API hygiene)', badRes.status >= 400, `status=${badRes.status}`)

  // E. deleting the 'user' bundle allowed? (user not in DEFAULT_BUNDLES)
  const noUser = JSON.parse(JSON.stringify(r.config)); delete noUser.bundles.user
  const wu = await authedPost('/capability-bundles', { config: noUser }, admin)
  check('E1: deleting "user" bundle rejected (it is a shipped default too)', wu.ok === false, `ok=${wu.ok}`)
  await authedPost('/capability-bundles', { config: r.config }, admin)
} finally {
  writeFileSync(BUNDLES_PATH, snapshot)
}
check('bundles file restored', readFileSync(BUNDLES_PATH, 'utf8') === snapshot)
console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
