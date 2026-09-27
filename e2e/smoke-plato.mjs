import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// J-T7/J-T8 smoke: Plato inception chat + contract generation (spec-first journey).
// Chat replies come from a live LLM, so this spec boots ITS OWN server on
// :4100 with PLATO_FIXTURE=1 — replaying a conversation recorded from a real
// Bedrock run (console/plato-fixture.json). The main :4000 server stays live.
// Run: node e2e/smoke-plato.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { primeLastProject } from './login.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
const BASE = 'http://localhost:4100'
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const fixture = JSON.parse(readFileSync(path.join(here, '../console/plato-fixture.json'), 'utf8'))

// --- boot a fixture-mode server on :4100 ---
const srv = spawn('node', [path.join(here, '../console/server.mjs')], {
  env: { ...process.env, PORT: '4100', PLATO_FIXTURE: '1' }, stdio: 'ignore',
})
let up = false
for (let i = 0; i < 30 && !up; i++) {
  try { await fetch(BASE + '/api/blueprints'); up = true }
  catch { await new Promise(r => setTimeout(r, 500)) }
}
if (!up) { console.error('fixture server failed to boot on :4100'); srv.kill(); process.exit(1) }

const login = async (user) => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, idp: 'okta' }),
  })
  return r.json()
}

const browser = await chromium.launch()
try {
  // --- API security: identity comes from the server session only ---
  const noAuth = await fetch(BASE + '/api/plato-chat')
  check('plato-chat without a session -> 401', noAuth.status === 401)
  const eu = await login('enduser')
  const euResp = await fetch(BASE + '/api/plato-chat', { headers: { authorization: 'Bearer ' + eu.token } })
  check('end-user session -> 403 (builder surface)', euResp.status === 403)
  const alice = await login('alice')
  const empty = await fetch(BASE + '/api/plato-chat', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ message: '   ' }),
  })
  check('empty message -> 400', empty.status === 400)

  // --- UI: alice walks the plato door ---
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  const session = await login('alice')
  // TLP-B2.3 hybrid landing: model a returning visit (last-used set) so the
  // builder lands in the workspace, not the My Projects cards page.
  await primeLastProject(session, BASE)
  await page.goto(BASE)
  await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), session)
  await page.goto(BASE)
  await page.waitForSelector('#whoami')
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('[data-door="plato"]')
  await page.locator('[data-door="plato"]').click()
  await page.waitForSelector('#pchat')
  // wait for the transcript load (async) to replace the loading spinner
  await page.waitForFunction(() => !document.getElementById('pchat').textContent.includes('loading conversation'), { timeout: 10000 })
  const panel = await page.locator('main').textContent()
  check('plato door opens the chat panel (not a placeholder)', (await page.locator('#pmsg').count()) === 1 && !panel.includes('being wired'))
  check('panel names the journey exit (spec repo + gate)', panel.includes('CLAUDE.md') && panel.includes('golden dataset'))
  check('empty chat invites discovery', panel.includes('questions, not architecture'))

  // send turn 1 — fixture replay of a real Bedrock conversation. Wait for the
  // reply itself (2 messages AND no pending spinner — the spinner is a .msg too).
  await page.locator('#pmsg').fill(fixture.userMessages[0])
  await page.locator('#psend').click()
  // G15: replies stream — wait for the final render (no in-progress bubble)
  await page.waitForFunction(() =>
    document.querySelectorAll('#pchat .msg').length >= 2 && !document.querySelector('#pchat .spin')
    && !document.querySelector('#pchat [data-streaming]'), { timeout: 15000 })
  const msgs = await page.locator('#pchat .msg').count()
  check('turn 1: user + plato messages rendered', msgs === 2)
  // markdown-insensitive compare: md() strips **/# markers from textContent
  const norm = s => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const chatTxt = await page.locator('#pchat').textContent()
  check('plato reply matches the recorded conversation', norm(chatTxt).includes(norm(fixture.replies[0]).slice(0, 80)))
  check('reply asks discovery questions, not architecture', /\?/.test(chatTxt))
  await page.screenshot({ path: SHOT_DIR + 'j-t7-plato-chat.png', fullPage: true })

  // transcript survives navigation (server-side per session; the door stays
  // open in client state, so re-entering Build lands back in the chat).
  // TLP-B2: builders have no Overview — leave via the workspace Fleet tab.
  await page.locator('.nav[data-shellnav="fleet"]').click()
  await page.waitForSelector('#wsbody')
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('#pchat')
  await page.waitForFunction(() => document.querySelectorAll('#pchat .msg').length >= 2, { timeout: 10000 })
  check('transcript survives tab navigation (server-held)', (await page.locator('#pchat .msg').count()) === 2)

  // --- J-T8: inception -> contract generation ---
  // a session with <2 user turns must be refused (API guard)
  const bob = await login('bob')
  const tooEarly = await fetch(BASE + '/api/plato-profile', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bob.token }, body: '{}',
  })
  check('profile generation with <2 turns -> 400', tooEarly.status === 400)

  // complete alice's discovery via API (turns 2+3 of the recorded conversation)
  for (const m of fixture.userMessages.slice(1)) {
    const r = await fetch(BASE + '/api/plato-chat', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.token },
      body: JSON.stringify({ message: m }),
    }).then(r => r.json())
    if (!r.ok) throw new Error('fixture turn failed: ' + r.error)
  }
  await page.locator('#pgen').click()
  await page.waitForSelector('#pcontract .sec-h', { timeout: 20000 })
  const contract = await page.locator('#pcontract').textContent()
  check('contract renders the extracted profile', contract.includes(fixture.profile.name) && contract.includes('risk'))
  check('recommendations carry choice + why', contract.includes('Framework') && contract.includes('Guardrail profile') && contract.includes('PII'))
  check('spec preview names the three contract files',
    contract.includes('CLAUDE.md') && contract.includes('SPEC.md') && contract.includes('tests/test_acceptance.py'))
  const claudePrev = await page.evaluate(() => {
    const d = [...document.querySelectorAll('#pcontract details')]
    return d.length ? d[0].querySelector('pre').textContent : ''
  })
  check('CLAUDE.md preview has the three zones', ['🔒 Foundation', '✅ Composed', '🔨 BUILD THIS'].every(z => claudePrev.includes(z)))
  await page.screenshot({ path: SHOT_DIR + 'j-t8-plato-contract.png', fullPage: true })

  // contract survives tab navigation (server-held, refetched deterministically)
  // TLP-B2: leave via the workspace Fleet tab, then re-enter Build.
  await page.locator('.nav[data-shellnav="fleet"]').click()
  await page.waitForSelector('#wsbody')
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('#pcontract .sec-h', { timeout: 10000 })
  check('contract survives tab navigation', (await page.locator('#pcontract').textContent()).includes(fixture.profile.name))

  // export the SPEC repo to a demo SSO org (no GitHub call; staging is real)
  await page.locator('#pghorg').selectOption('acme-domain-support')
  await page.locator('#pghrepo').fill('smoke-plato-spec')
  await page.locator('#pexp').click()
  await page.waitForFunction(() => document.getElementById('pes')?.textContent.includes('SSO demo org'), { timeout: 20000 })
  const exp = await page.locator('#pes').textContent()
  check('SPEC export stages the repo (demo org, honest wording)', exp.includes('spec contract + TDD skeleton + CI gate'))

  // start over resets transcript AND contract on the server
  await page.locator('#preset2').click()
  await page.waitForFunction(() => document.querySelectorAll('#pchat .msg').length === 0, { timeout: 10000 })
  const cleared = await fetch(BASE + '/api/plato-chat', { headers: { authorization: 'Bearer ' + session.token } }).then(r => r.json())
  check('start over clears the transcript on the server', (cleared.transcript || []).length === 0)
  const clearedInc = await fetch(BASE + '/api/plato-profile', { headers: { authorization: 'Bearer ' + session.token } }).then(r => r.json())
  check('start over clears the contract on the server', clearedInc.inception === null)

  // hygiene: no mock/simulated wording on the rendered door
  const dom = (await page.locator('main').textContent()).toLowerCase()
  check('no mock/simulated wording on the rendered door', !dom.includes('mock') && !dom.includes('simulated'))

  // back to the landing still works
  await page.locator('#doorback').click()
  await page.waitForSelector('[data-door]')
  check('back returns to the three-door landing', (await page.locator('[data-door]').count()) === 3)
} finally {
  await browser.close()
  srv.kill()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
