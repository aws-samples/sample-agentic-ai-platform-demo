// P0 platform improvements (independent review slice) smoke — item 2: VALIDATE IS A READ.
//
// Validation answers "would this work". It must leave the filesystem exactly as
// it found it, so a dry run is distinguishable from a real one and validating
// before a commit never dirties the tree. Several console stores are lazily
// seeded on first read, which used to make /api/wizard-validate CREATE
// console/ai-registry.json and console/domain-policies.json as a side effect.
//
//   1. /api/validate on the COMMITTED data-analyst fixture: `git status` and
//      every console/*.json byte-identical afterwards.
//   2. /api/wizard-validate with both seed-on-read stores deliberately REMOVED
//      (the case that used to create them): still no file, tree still clean.
//   3. Suppressing the write must not change the ANSWER: with domain-policies
//      absent, the seeded domain-enforced guardrail is still enforced — a step-5
//      payload that omits tone-review is still rejected. (A suppression that
//      just let the read fail would return {} here and allow the omission.)
//   4. --write-env opts back in: the same call on a flagged server DOES
//      materialize the store.
//
// Item 5: A BLUEPRINT REFERENCE IS GATED SERVER-SIDE. The wizard only offers
// blueprints a session may use, but a hidden option is not a control, so both
// entry points — /api/generate (agent compose/import) and the wizard's
// validate/create (project create/bootstrap) — run the same blueprintUsableError
// rule: usable iff APPROVED in the AI Registry and visible to the session's
// domain, OR a peer-approved contribution.
//   5. Refused with a 400 naming the reason, on BOTH paths: a non-APPROVED
//      registry entry, a pending_approval contribution, a rejected one, an id
//      that exists nowhere, and an APPROVED entry owned by another domain.
//      Plus: the refusal happens before any work (no project directory), and
//      both accepted provenances still pass.
//
// Hermetic: runs against ITS OWN servers (:4300 default, :4301 --write-env),
// never the shared :4000; both stores are snapshotted and restored in a finally.
// Run: node e2e/smoke-validation-readonly-blueprint-policy.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const consoleDir = path.join(here, '../console')
const repoDir = path.join(here, '..')
const AI_REGISTRY = path.join(consoleDir, 'ai-registry.json')
const DOMAIN_POLICIES = path.join(consoleDir, 'domain-policies.json')
const SUBMISSIONS = path.join(consoleDir, 'blueprint-submissions.json')
// The one project name section 5 ever asks for: every refusal must leave it
// absent, and the single positive control creates it (removed in the finally).
const GATE_PROJECT = 'p0validationgate'
const GATE_DIR = path.join(repoDir, 'domain-examples/generated', GATE_PROJECT)
// The two seed-on-read stores this test removes to expose the side effect.
const CLEARED = [AI_REGISTRY, DOMAIN_POLICIES]
// Restored wholesale at the end: the stores are gitignored runtime state, so
// nothing else would notice if this test left one rewritten or missing.
const listStores = () => fs.readdirSync(consoleDir).filter(f => f.endsWith('.json'))
const snapshots = new Map(listStores().map(f => [f, fs.readFileSync(path.join(consoleDir, f), 'utf8')]))

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const startServer = (port, args = []) => spawn(process.execPath, ['server.mjs', ...args], {
  cwd: consoleDir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
})
const waitUp = async base => {
  for (let i = 0; i < 150; i++) {
    if (await fetch(base + '/').then(r => r.ok, () => false)) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}
const login = (base, user) => fetch(base + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user, idp: 'okta' }),
}).then(r => r.json())
const post = (base, p, body, s) => fetch(base + '/api' + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }))

// The two halves of "the working tree is unchanged": tracked files, per git, and
// the gitignored runtime stores, which git would not report at all.
const gitStatus = () => execSync('git status --porcelain', { cwd: repoDir }).toString()
const storeDigests = () => Object.fromEntries(listStores()
  .map(f => [f, createHash('md5').update(fs.readFileSync(path.join(consoleDir, f))).digest('hex')]))
const drift = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter(k => before[k] !== after[k])

// Section-5 fixtures. Real store shapes: a registry Blueprint resolves through
// its defaultVersion pointer, a contribution through blueprint-submissions.json.
const AT = '2026-01-01T00:00:00.000Z'
const bpEntry = (id, domain, status) => ({
  id, type: 'Blueprint', name: `P0 independent review ${status} blueprint`,
  description: 'p0-independent review item-5 fixture', governanceMode: 'owned', domainOwner: null, domain,
  defaultVersion: '1.0.0',
  versions: [{
    semver: '1.0.0', status, content: { template: {} }, changelog: 'p0-independent review item-5 fixture',
    createdBy: 'p0validation-smoke', createdAt: AT, decidedBy: null, decidedAt: null, autoChecks: [],
  }],
})
const submission = (blueprintId, status) => ({
  id: `p0validation-sub-${blueprintId}`, blueprintId, name: `P0 independent review ${status} contribution`,
  useCase: 'p0-independent review item-5 fixture', template: {},
  submittedBy: 'alice', submitterName: 'alice', status,
  decidedBy: status === 'pending_approval' ? null : 'frank',
  decidedAt: status === 'pending_approval' ? null : AT,
  submittedAt: AT, history: [{ action: 'submitted', who: 'alice', at: AT }],
})

// Startup fires an async fleet sync that seeds console/agent-registry.json about
// a second later — a BOOT write, not a validate write. Wait for the store set to
// stop moving before snapshotting, or that background write lands mid-test and
// gets blamed on the request under test.
const settle = async () => {
  let prev = null, stable = 0
  for (let i = 0; i < 60; i++) {
    const now = JSON.stringify(storeDigests())
    stable = now === prev ? stable + 1 : 0
    prev = now
    if (stable >= 4 && i >= 7) return true
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

const PORT_A = 4300, PORT_B = 4301
const baseA = `http://localhost:${PORT_A}`, baseB = `http://localhost:${PORT_B}`
let srvA = null, srvB = null

try {
  srvA = startServer(PORT_A)
  if (!await waitUp(baseA)) throw new Error(`server did not come up on ${PORT_A}`)
  const melanie = await login(baseA, 'melanie')
  const alice = await login(baseA, 'alice')
  check('0 the console stores settle after boot', await settle())
  // Section 5 doctors the registry, and needs the boot-seeded one as its base:
  // the wizard's chatbot template resolves real skill/tool entries out of it, so
  // a from-scratch list would fail step 3 for an unrelated reason. Captured here
  // because section 2 deletes the store (and the item-2 fix means nothing on the
  // read path puts it back), and the store is gitignored — it may not have
  // existed at module-load time on a fresh clone.
  const baseRegistry = JSON.parse(fs.readFileSync(AI_REGISTRY, 'utf8'))

  // ---- 1. /api/validate on a committed fixture writes nothing --------------
  // data-analyst is tracked in git, so a mutation of the project itself would
  // show up in `git status` alongside any new store.
  const git1 = gitStatus()
  const stores1 = storeDigests()
  const v = await post(baseA, '/validate', { project: 'data-analyst' }, melanie)
  check('1a validate on the data-analyst fixture succeeds',
    v.status === 200 && v.body.ok === true, JSON.stringify(v.body).slice(0, 120))
  check('1b tracked working tree unchanged by validate', gitStatus() === git1)
  check('1c no console/*.json created or modified by validate',
    drift(stores1, storeDigests()).length === 0, drift(stores1, storeDigests()).join(', '))

  // ---- 2. wizard-validate with the seed-on-read stores absent --------------
  // The server is already up, so anything that reappears was created by the
  // request itself — which is exactly what this endpoint used to do.
  for (const p of CLEARED) fs.rmSync(p, { force: true })
  const git2 = gitStatus()
  const stores2 = storeDigests()
  const draft = { template: 'chatbot', projectName: 'p0validation', blueprint: 'chat-assistant' }
  const w = await post(baseA, '/wizard-validate', { step: 6, draft }, alice)
  check('2a wizard-validate still answers with both stores absent',
    w.status === 200 && w.body.ok === true, JSON.stringify(w.body).slice(0, 160))
  check('2b ai-registry.json NOT created by validate', !fs.existsSync(AI_REGISTRY))
  check('2c domain-policies.json NOT created by validate', !fs.existsSync(DOMAIN_POLICIES))
  check('2d tracked working tree unchanged', gitStatus() === git2)
  check('2e no other console/*.json created or modified',
    drift(stores2, storeDigests()).length === 0, drift(stores2, storeDigests()).join(', '))

  // ---- 3. suppressing the write does not change the answer ----------------
  // The seeded policy enforces tone-review for customer-support, and alice is a
  // customer-support builder, so omitting it must still be a 400.
  const omit = await post(baseA, '/wizard-validate',
    { step: 5, draft: { ...draft, guardrails: ['pii-filter', 'security-scan-gate'] } }, alice)
  check('3a the in-memory policy seed is still enforced (omission rejected)',
    omit.status === 400 && (omit.body.errors || []).some(e => /tone-review/.test(e) && /domain-enforced/.test(e)),
    JSON.stringify(omit.body).slice(0, 160))
  const keep = await post(baseA, '/wizard-validate',
    { step: 5, draft: { ...draft, guardrails: ['pii-filter', 'security-scan-gate', 'tone-review'] } }, alice)
  check('3b a compliant guardrail list still passes',
    keep.status === 200 && keep.body.ok === true, JSON.stringify(keep.body).slice(0, 160))
  check('3c three validate calls later, both stores are still absent',
    !fs.existsSync(AI_REGISTRY) && !fs.existsSync(DOMAIN_POLICIES))

  // ---- 4. --write-env opts back in ---------------------------------------
  srvB = startServer(PORT_B, ['--write-env'])
  if (!await waitUp(baseB)) throw new Error(`--write-env server did not come up on ${PORT_B}`)
  // Startup warms some stores on its own, so clear it AFTER boot has settled:
  // only what the request does is under test.
  await settle()
  fs.rmSync(DOMAIN_POLICIES, { force: true })
  const alice2 = await login(baseB, 'alice')
  const w2 = await post(baseB, '/wizard-validate', { step: 6, draft }, alice2)
  check('4a --write-env server validates the same draft',
    w2.status === 200 && w2.body.ok === true, JSON.stringify(w2.body).slice(0, 160))
  check('4b --write-env DOES materialize the seed store', fs.existsSync(DOMAIN_POLICIES))

  // ---- 5. item 5: non-APPROVED blueprint references are refused ------------
  // Both stores are re-read per request, so doctoring them exercises the branches
  // no committed fixture reaches: a registry Blueprint that is NOT approved, one
  // approved but owned by another domain, and contributions in each state.
  // (Ordered last: it rewrites the stores the drift checks above assert on.)
  fs.writeFileSync(AI_REGISTRY, JSON.stringify([
    ...baseRegistry,
    bpEntry('p0validation-inreview-bp', 'shared', 'IN_REVIEW'),
    bpEntry('p0validation-foreign-bp', 'operations', 'APPROVED'),
  ], null, 2))
  fs.writeFileSync(SUBMISSIONS, JSON.stringify([
    submission('p0validation-pending-bp', 'pending_approval'),
    submission('p0validation-rejected-bp', 'rejected'),
    submission('p0validation-approved-bp', 'approved'),
  ], null, 2))

  // The five refusals, asserted on BOTH entry points: /api/generate is the agent
  // compose/import path, /api/wizard-validate step 3 the project create path.
  const REFUSALS = [
    ['5a', 'p0validation-inreview-bp', /IN_REVIEW in the AI Registry/, 'non-APPROVED registry entry'],
    ['5b', 'p0validation-pending-bp', /pending approval/, 'contribution still pending_approval'],
    ['5c', 'p0validation-rejected-bp', /is rejected/, 'rejected contribution'],
    ['5d', 'p0validation-nope-bp', /Unknown blueprint id/, 'blueprint that exists nowhere'],
    ['5e', 'p0validation-foreign-bp', /belongs to another domain/, "APPROVED but another domain's"],
  ]
  for (const [n, bp, re, what] of REFUSALS) {
    const g = await post(baseA, '/generate', { blueprint: bp, projectName: GATE_PROJECT, persona: 'p0 item5' }, alice)
    check(`${n}-gen /api/generate refuses a ${what}`,
      g.status === 400 && re.test(String(g.body.error || '')), `${g.status} ${JSON.stringify(g.body).slice(0, 140)}`)
    const v3 = await post(baseA, '/wizard-validate',
      { step: 3, draft: { template: 'custom', projectName: GATE_PROJECT, blueprint: bp } }, alice)
    check(`${n}-wiz /api/wizard-validate step 3 refuses a ${what}`,
      v3.status === 400 && (v3.body.errors || []).some(e => re.test(e)), `${v3.status} ${JSON.stringify(v3.body).slice(0, 140)}`)
  }
  // The gate lands BEFORE any work: a refused compose leaves no project behind.
  check('5f a refused compose created no project directory', !fs.existsSync(GATE_DIR))
  // Create, not just validate, enforces it — /api/wizard-create runs the same
  // step-6 pass, so a client that skips validate is refused too.
  const c = await post(baseA, '/wizard-create',
    { draft: { template: 'chatbot', projectName: GATE_PROJECT, blueprint: 'p0validation-pending-bp',
      guardrails: ['pii-filter', 'security-scan-gate', 'tone-review'] } }, alice)
  check('5g /api/wizard-create itself refuses the pending contribution',
    c.status === 400 && (c.body.errors || []).some(e => /pending approval/.test(e)),
    `${c.status} ${JSON.stringify(c.body).slice(0, 160)}`)

  // Positive controls — the gate must not be a blanket "no". Both accepted
  // provenances pass: an APPROVED registry blueprint, and (the b19 rule) an
  // approved contribution, which never enters the AI Registry at all.
  const okReg = await post(baseA, '/wizard-validate',
    { step: 3, draft: { template: 'chatbot', projectName: GATE_PROJECT, blueprint: 'chat-assistant' } }, alice)
  check('5h APPROVED registry blueprint still validates',
    okReg.status === 200 && okReg.body.ok === true, JSON.stringify(okReg.body).slice(0, 160))
  const okSub = await post(baseA, '/wizard-validate',
    { step: 3, draft: { template: 'custom', projectName: GATE_PROJECT, blueprint: 'p0validation-approved-bp' } }, alice)
  check('5i peer-approved contribution still validates (a registry-only gate would break b19)',
    okSub.status === 200 && okSub.body.ok === true, JSON.stringify(okSub.body).slice(0, 160))
  const gen = await post(baseA, '/generate',
    { blueprint: 'chat-assistant', projectName: GATE_PROJECT, persona: 'p0 item5' }, alice)
  check('5j /api/generate still composes from an APPROVED blueprint',
    gen.status === 200 && typeof gen.body.project === 'string', `${gen.status} ${JSON.stringify(gen.body).slice(0, 140)}`)
} finally {
  fs.rmSync(GATE_DIR, { recursive: true, force: true })
  if (srvA) srvA.kill()
  if (srvB) srvB.kill()
  for (const [f, snap] of snapshots) fs.writeFileSync(path.join(consoleDir, f), snap)
  // A store this run brought into existence (agent-registry.json on a clean
  // checkout) goes away again, so the checkout is left as it was found.
  for (const f of listStores()) if (!snapshots.has(f)) fs.rmSync(path.join(consoleDir, f), { force: true })
}

console.log(failures === 0 ? '\nP0-independent review SMOKE PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)
