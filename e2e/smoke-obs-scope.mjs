// G13 smoke (Melanie UI finding): observability trace scoping.
// Two rules under test:
//   (1) visibility follows the DEPLOYMENT ACCOUNT — the platform console's
//       Langfuse trace list shows platform-account-deployed agents (plus
//       fail-closed unattributed rows) ONLY; agents deployed into a domain
//       surface only in that domain's obs view;
//   (2) traces are grouped/filterable PER AGENT — the rows carry the agent id,
//       the response carries an agents inventory, and ?agent= narrows (never
//       widens) the already-scoped set.
// Uses a LANGFUSE_FIXTURE replay server on :4102 (PLATO_FIXTURE pattern) so the
// scoping rules are testable without live Langfuse keys; the main :4000 server
// stays untouched. Also asserts the generate pipeline stamps `project:<id>`
// into langfuse.tags — the tag the attribution keys off.
// Run: node e2e/smoke-obs-scope.mjs
import { chromium } from 'playwright'
import { openAdminOps, primeLastProject } from './login.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'http://localhost:4102'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const projPath = path.join(here, '../console/projects.json')
const projSnap = fs.existsSync(projPath) ? fs.readFileSync(projPath, 'utf8') : null
const GEN = 'g13tag' + Math.random().toString(36).slice(2, 6)
const genDir = path.join(here, '../domain-examples/generated', GEN)

// --- boot a fixture-mode server on :4102 ---
const srv = spawn('node', [path.join(here, '../console/server.mjs')], {
  env: { ...process.env, PORT: '4102', LANGFUSE_FIXTURE: path.join(here, 'fixtures/langfuse-traces.json') },
  stdio: 'ignore',
})
let up = false
for (let i = 0; i < 30 && !up; i++) {
  try { await fetch(BASE + '/api/blueprints'); up = true }
  catch { await new Promise(r => setTimeout(r, 500)) }
}
if (!up) { console.error('fixture server failed to boot on :4102'); srv.kill(); process.exit(1) }

const login = async (user) => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, idp: 'okta' }),
  })
  return r.json()
}
const get = (p, s) => fetch(BASE + '/api' + p, { headers: { authorization: 'Bearer ' + s.token } }).then(r => r.json())
const getStatus = (p, s) => fetch(BASE + '/api' + p, s ? { headers: { authorization: 'Bearer ' + s.token } } : {}).then(r => r.status)
const post = (p, body, s) => fetch(BASE + '/api' + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token },
  body: JSON.stringify(body),
}).then(r => r.json())

const browser = await chromium.launch()
try {
  // ---------- 1. gate ----------
  check('anon -> 401', await getStatus('/langfuse-traces', null) === 401)
  const enduser = await login('enduser')
  check('end user -> 403 (operator planes only)', await getStatus('/langfuse-traces', enduser) === 403)

  // ---------- 2. deployment-account scoping: platform console ----------
  const admin = await login('melanie')
  const adminR = await get('/langfuse-traces', admin)
  const adminAgents = (adminR.traces || []).map(t => t.agent)
  check('platform default list has platform-account rows', adminAgents.includes('platform-assistant'))
  check('platform default list has ZERO domain-deployed rows (the Melanie assertion)',
    !adminAgents.includes('supportdesk') && !adminAgents.includes('opsassistant'))
  check('unattributed rows (no project tag) stay platform-visible-only, fail-closed',
    adminAgents.includes(null))
  check('agents inventory matches the platform scope',
    (adminR.agents || []).includes('platform-assistant') && !(adminR.agents || []).includes('supportdesk'))

  // ---------- 3. deployment-account scoping: domain views ----------
  const alice = await login('alice')   // customer-support builder
  const aliceR = await get('/langfuse-traces', alice)
  const aliceAgents = (aliceR.traces || []).map(t => t.agent)
  check('cs builder sees own-domain agent traces', aliceAgents.includes('supportdesk'))
  check('cs builder never sees platform-account, foreign-domain or unattributed rows',
    !aliceAgents.includes('platform-assistant') && !aliceAgents.includes('opsassistant') && !aliceAgents.includes(null))
  const bob = await login('bob')       // operations builder
  const bobR = await get('/langfuse-traces', bob)
  const bobAgents = (bobR.traces || []).map(t => t.agent)
  check('ops builder sees own-domain agent traces only',
    bobAgents.includes('opsassistant') && !bobAgents.includes('supportdesk') && !bobAgents.includes(null))
  const carol = await login('carol')   // customer-support lead — same domain plane
  const carolAgents = ((await get('/langfuse-traces', carol)).traces || []).map(t => t.agent)
  check('lead scoping matches her domain', carolAgents.includes('supportdesk') && !carolAgents.includes('opsassistant'))

  // admin scoped INTO a domain sees that domain's rows (G12 precedent)
  const sw = await fetch(BASE + '/api/session-domain', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token },
    body: JSON.stringify({ domain: 'customer-support' }),
  })
  const adminCsAgents = ((await get('/langfuse-traces', admin)).traces || []).map(t => t.agent)
  check('admin scoped to a domain sees that domain\'s traces (and nothing else)',
    sw.status === 200 && adminCsAgents.includes('supportdesk') &&
    !adminCsAgents.includes('platform-assistant') && !adminCsAgents.includes('opsassistant'))
  await fetch(BASE + '/api/session-domain', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + admin.token },
    body: JSON.stringify({ domain: 'all' }),
  })

  // ---------- 4. per-agent filter narrows, never widens ----------
  const adminOne = await get('/langfuse-traces?agent=platform-assistant', admin)
  check('?agent= narrows to that agent', (adminOne.traces || []).length > 0 &&
    (adminOne.traces || []).every(t => t.agent === 'platform-assistant'))
  const adminForeign = await get('/langfuse-traces?agent=supportdesk', admin)
  check('?agent= naming an out-of-scope agent yields empty, never widened data',
    (adminForeign.traces || []).length === 0)
  const aliceForeign = await get('/langfuse-traces?agent=opsassistant', alice)
  check('builder ?agent= on a foreign-domain agent yields empty', (aliceForeign.traces || []).length === 0)

  // ---------- 5. metadata projection (no raw Langfuse fields pass through) ----------
  const FIELDS = ['agent', 'timestamp', 'userId', 'sessionId', 'totalTokens', 'latency']
  check('rows are a fixed metadata projection (no extra fields, no tags/input/output)',
    (adminR.traces || []).every(t => Object.keys(t).every(k => FIELDS.includes(k))))

  // ---------- 6. generate pipeline stamps project:<id> into langfuse.tags ----------
  const gen = await post('/generate', { blueprint: 'chat-assistant', projectName: GEN, persona: 'G13 smoke agent' }, alice)
  check('generate succeeds', !!gen.project)
  const mainFiles = []
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) walk(path.join(d, f.name))
    else if (f.name === 'main.py') mainFiles.push(path.join(d, f.name)) } }
  if (fs.existsSync(genDir)) walk(genDir)
  const stamped = mainFiles.some(f => fs.readFileSync(f, 'utf8').includes(`"project:${GEN}"`))
  check('generated agent carries project:<id> in langfuse.tags (attribution source)', stamped)

  // ---------- 7. UI: agent grouping + scope per persona ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await page.goto(BASE)
  await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), admin)
  await page.goto(BASE)
  await page.waitForSelector('#whoami')
  // B14: the Langfuse trace table is a content-level surface — it lives on
  // the build workspace's Observability route (bwobs), not on the aggregate
  // Platform Monitoring page.
  await page.locator('.nav[data-shellnav="bwobs"]').click()
  await page.waitForSelector('#lfagent', { timeout: 10000 })
  const opts = await page.locator('#lfagent option').allTextContents()
  check('UI: build-workspace obs has a per-agent selector over Langfuse traces',
    opts.some(o => o.includes('platform-assistant')))
  check('UI: platform agent selector lists no domain-deployed agents',
    opts.every(o => !o.includes('supportdesk') && !o.includes('opsassistant')))
  await page.locator('#lfagent').selectOption('platform-assistant')
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#lfbox tbody tr')]
    return rows.length > 0 && rows.every(r => r.textContent.includes('platform-assistant'))
  }, { timeout: 5000 })
  check('UI: selecting an agent narrows the trace table to it', true)

  const bpage = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  // TLP-B2.3 hybrid landing: returning-visit path so alice lands in the
  // workspace (with the obs nav entry), not the My Projects cards page.
  await primeLastProject(alice, BASE)
  await bpage.goto(BASE)
  await bpage.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), alice)
  await bpage.goto(BASE)
  await bpage.waitForSelector('#whoami')
  await bpage.locator('.nav[data-shellnav="obs"]').click()
  await bpage.waitForSelector('#lfbox table', { timeout: 10000 })
  const btxt = await bpage.locator('#lfbox').textContent()
  check('UI: builder obs Langfuse table shows own-domain traces only',
    btxt.includes('supportdesk') && !btxt.includes('platform-assistant') && !btxt.includes('opsassistant'))
} finally {
  await browser.close()
  srv.kill()
  if (projSnap === null) fs.rmSync(projPath, { force: true })
  else fs.writeFileSync(projPath, projSnap)
  fs.rmSync(genDir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
