// TLP-B21 smoke — B16 seed idempotency + restart self-heal (frozen checklist
// B21 #3: "seed data recovers on restart after tests consume it"). Runs against ITS OWN spawned
// servers (never the shared :4000) so boots and kills are observable:
//   1. Fresh-clone cold start (both gitignored JSON stores removed): server A
//      seeds ONE pending row into each approval surface — guardrail-exemption
//      queue, blueprint-submission queue, grant-request inbox.
//   2. Tests CONSUME the seeds (carol decides the grant, melanie decides the
//      blueprint submission) — both leave the pending state.
//   3. Restart (server B, same stores): the in-memory grant seed SELF-HEALS
//      (alice's salesforce-connector request is pending again), while the
//      JSON stores are IDEMPOTENT — the consumed blueprint decision survives
//      and no duplicate seed row appears (existsSync-once guard).
// Hermetic: policy-exemptions.json + blueprint-submissions.json snapshotted
// & restored; the servers live on their own ports and are killed on exit.
// Run: node e2e/smoke-tlp-b21.mjs
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const consoleDir = path.join(here, '../console')
const EX_PATH = path.join(consoleDir, 'policy-exemptions.json')
const SUB_PATH = path.join(consoleDir, 'blueprint-submissions.json')
const exSnapshot = fs.existsSync(EX_PATH) ? fs.readFileSync(EX_PATH, 'utf8') : null
const subSnapshot = fs.existsSync(SUB_PATH) ? fs.readFileSync(SUB_PATH, 'utf8') : null

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const startServer = port => spawn(process.execPath, ['server.mjs'], {
  cwd: consoleDir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
})
const waitUp = async base => {
  for (let i = 0; i < 150; i++) {
    if (await fetch(base + '/').then(r => r.ok, () => false)) return true
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}
const login = async (base, user) => {
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, idp: 'okta' }),
  })
  return r.json()
}
const get = (base, p, s) =>
  fetch(base + '/api' + p, { headers: { authorization: 'Bearer ' + s.token } }).then(r => r.json())
const post = (base, p, body, s) =>
  fetch(base + '/api' + p, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token },
    body: JSON.stringify(body),
  }).then(r => r.json())

const PORT_A = 4298, PORT_B = 4299
const baseA = `http://localhost:${PORT_A}`, baseB = `http://localhost:${PORT_B}`
let srvA = null, srvB = null
try {
  // ---- 1. fresh-clone cold start: stores absent -> server A seeds all three
  fs.rmSync(EX_PATH, { force: true })
  fs.rmSync(SUB_PATH, { force: true })
  srvA = startServer(PORT_A)
  check('A0 fresh server A came up (stores removed = fresh-clone shape)', await waitUp(baseA))
  const melA = await login(baseA, 'melanie')
  const carolA = await login(baseA, 'carol')

  const ex1 = await get(baseA, '/policy-exemptions', melA)
  const seedEx = (ex1.exemptions || []).filter(x =>
    x.guardrail === 'tone-review' && x.project === 'supportdesk' &&
    (x.status === 'pending_domain' || x.status === 'pending_platform'))
  check('A1 guardrail-exemption seed recreated on cold start (tone-review/supportdesk pending)',
    seedEx.length === 1, `rows=${seedEx.length}`)

  const bs1 = await get(baseA, '/blueprint-submissions', melA)
  const seedBs = (bs1.submissions || []).filter(s => s.blueprintId === 'faq-summarizer')
  check('A2 blueprint-submission seed recreated on cold start (faq-summarizer pending_approval)',
    seedBs.length === 1 && seedBs[0].status === 'pending_approval', `rows=${seedBs.length}`)

  const gr1 = await get(baseA, '/grant-requests?status=pending', carolA)
  const seedGr = (gr1.requests || []).filter(r =>
    r.resourceId === 'salesforce-connector' && r.requestedBy === 'alice')
  check('A3 grant-request seed present on boot (alice/salesforce-connector pending)',
    seedGr.length === 1, `rows=${seedGr.length}`)

  // ---- 2. consume the seeds ----
  const decidedGr = await post(baseA, '/grant-decide', { requestId: seedGr[0].id, decision: 'approve' }, carolA)
  check('A4 carol consumes the grant seed (approve)', decidedGr.ok === true && decidedGr.request.status === 'approved')
  const decidedBs = await post(baseA, '/blueprint-submission-decide', { id: seedBs[0].id, decision: 'reject', reason: 'B21 seed idempotency probe' }, melA)
  check('A5 melanie consumes the blueprint seed (reject)', decidedBs.ok === true && decidedBs.submission.status === 'rejected')
  const grAfter = await get(baseA, '/grant-requests?status=pending', carolA)
  check('A6 no pending salesforce-connector seed remains after consumption',
    !(grAfter.requests || []).some(r => r.resourceId === 'salesforce-connector'))

  // ---- 3. restart: in-memory seed self-heals; JSON stores stay idempotent ----
  srvA.kill()
  srvA = null
  srvB = startServer(PORT_B)
  check('B0 restarted server B came up', await waitUp(baseB))
  const melB = await login(baseB, 'melanie')
  const carolB = await login(baseB, 'carol')

  const gr2 = await get(baseB, '/grant-requests?status=pending', carolB)
  const healedGr = (gr2.requests || []).filter(r =>
    r.resourceId === 'salesforce-connector' && r.requestedBy === 'alice')
  check('B1 consumed grant seed SELF-HEALS on restart (pending again, exactly one row)',
    healedGr.length === 1, `rows=${healedGr.length}`)

  const bs2 = await get(baseB, '/blueprint-submissions', melB)
  const bsRows = (bs2.submissions || []).filter(s => s.blueprintId === 'faq-summarizer')
  check('B2 blueprint store is idempotent: the consumed decision survives the restart',
    bsRows.length === 1 && bsRows[0].status === 'rejected', `rows=${bsRows.length} status=${bsRows[0]?.status}`)

  const ex2 = await get(baseB, '/policy-exemptions', melB)
  const exRows = (ex2.exemptions || []).filter(x => x.guardrail === 'tone-review' && x.project === 'supportdesk')
  check('B3 exemption store is idempotent: restart adds NO duplicate seed row',
    exRows.length === 1, `rows=${exRows.length}`)
} finally {
  if (srvA) srvA.kill()
  if (srvB) srvB.kill()
  if (exSnapshot === null) fs.rmSync(EX_PATH, { force: true })
  else fs.writeFileSync(EX_PATH, exSnapshot)
  if (subSnapshot === null) fs.rmSync(SUB_PATH, { force: true })
  else fs.writeFileSync(SUB_PATH, subSnapshot)
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
