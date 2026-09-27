// G17 smoke: explicit confirmation -> generation actually fires (not narrated).
// Fixture turn 4 is a REAL recorded Bedrock reply under the G17 prompt: the
// builder says "Looks good ... go ahead" and Plato answers with the
// [[GENERATE_SPEC]] handoff marker. Asserts: the marker never reaches the
// transcript or the screen, the done/fallback responses carry handoff:true,
// and the UI starts contract generation immediately after the confirmation
// turn — no third confirmation, no extra click on the generate button.
// Boots its own PLATO_FIXTURE server on :4104; the main :4000 server stays live.
// Run: node e2e/smoke-plato-handoff.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { primeLastProject } from './login.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'http://localhost:4104'
const MARK = '[[GENERATE_SPEC]]'
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const fixture = JSON.parse(readFileSync(path.join(here, '../console/plato-fixture.json'), 'utf8'))
if (!fixture.replies[3] || !fixture.replies[3].includes(MARK))
  throw new Error('fixture turn 4 must carry the recorded handoff marker')

// --- boot a fixture-mode server on :4104 ---
const srv = spawn('node', [path.join(here, '../console/server.mjs')], {
  env: { ...process.env, PORT: '4104', PLATO_FIXTURE: '1' }, stdio: 'ignore',
})
let up = false
for (let i = 0; i < 30 && !up; i++) {
  try { await fetch(BASE + '/api/blueprints'); up = true }
  catch { await new Promise(r => setTimeout(r, 500)) }
}
if (!up) { console.error('fixture server failed to boot on :4104'); srv.kill(); process.exit(1) }

const login = async (user) => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, idp: 'okta' }),
  })
  return r.json()
}
const post = (token, url, body) => fetch(BASE + url, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify(body),
})

const browser = await chromium.launch()
try {
  // --- API: non-streaming path — handoff flag + marker stripped ---
  const alice = await login('alice')
  const flags = []
  let last = null
  for (const m of fixture.userMessages) {
    last = await post(alice.token, '/api/plato-chat', { message: m }).then(r => r.json())
    flags.push(!!last.handoff)
  }
  check('discovery turns do not hand off (handoff false until confirmation)', flags.slice(0, 3).every(f => f === false))
  check('confirmation turn returns handoff:true', last.ok === true && last.handoff === true)
  check('marker stripped from the reply text', !last.reply.includes(MARK) && last.reply.includes('generating the spec'))
  const tr = await fetch(BASE + '/api/plato-chat', { headers: { authorization: 'Bearer ' + alice.token } }).then(r => r.json())
  check('marker never lands in the stored transcript', !JSON.stringify(tr.transcript).includes(MARK))
  // earlier turns must NOT be flagged
  const bob = await login('bob')
  const t1 = await post(bob.token, '/api/plato-chat', { message: fixture.userMessages[0] }).then(r => r.json())
  check('first discovery turn carries handoff:false', t1.ok === true && !t1.handoff)

  // --- API: streaming path — chunks clean, done carries handoff ---
  for (const m of fixture.userMessages.slice(1, 3)) {
    const r = await post(bob.token, '/api/plato-chat', { message: m }).then(r => r.json())
    if (!r.ok) throw new Error('fixture turn failed: ' + r.error)
  }
  const resp = await post(bob.token, '/api/plato-chat-stream', { message: fixture.userMessages[3] })
  let assembled = '', doneHandoff = null, sawError = null
  {
    const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = ''
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      buf += dec.decode(value, { stream: true })
      const events = buf.split('\n\n'); buf = events.pop()
      for (const ev of events) {
        const et = (ev.match(/event: (\w+)/) || [])[1]
        const dm = (ev.match(/data: (.*)/s) || [])[1]
        if (!et || !dm) continue
        if (et === 'chunk') assembled += JSON.parse(dm)
        else if (et === 'done') doneHandoff = JSON.parse(dm).handoff
        else if (et === 'error') sawError = JSON.parse(dm)
      }
    }
  }
  check('stream: no error event on the confirmation turn', sawError === null)
  check('stream: no marker fragment ever reaches the client', !assembled.includes(MARK) && !assembled.includes('[['))
  check('stream: assembled text is the reply without the marker', assembled.trim() === 'Understood — generating the spec now.')
  check('stream: done event carries handoff:true', doneHandoff === true)

  // --- UI: confirmation auto-triggers generation (the actual Melanie/independent review repro) ---
  // fresh alice login = fresh session token = clean transcript (per-token store)
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  const session = await login('alice')
  // TLP-B2.3 hybrid landing: returning-visit path so the builder lands in the
  // workspace, not the My Projects cards page.
  await primeLastProject(session, BASE)
  await page.goto(BASE)
  await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), session)
  await page.goto(BASE)
  await page.waitForSelector('#whoami')
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('[data-door="plato"]')
  await page.locator('[data-door="plato"]').click()
  await page.waitForSelector('#pchat')
  await page.waitForFunction(() => !document.getElementById('pchat').textContent.includes('loading conversation'), { timeout: 10000 })
  // walk the recorded discovery turns through the UI-adjacent API, then send
  // the confirmation THROUGH THE UI — the handoff must fire from the chat path
  for (const m of fixture.userMessages.slice(0, 3)) {
    const r = await post(session.token, '/api/plato-chat', { message: m }).then(r => r.json())
    if (!r.ok) throw new Error('fixture turn failed: ' + r.error)
  }
  // TLP-B2: builders have no Overview — leave via the workspace Fleet tab,
  // then re-enter Build (same leave/re-enter intent).
  await page.locator('.nav[data-shellnav="fleet"]').click()
  await page.waitForSelector('#wsbody')
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('#pchat')
  await page.waitForFunction(() => document.querySelectorAll('#pchat .msg').length >= 6, { timeout: 10000 })
  await page.locator('#pmsg').fill(fixture.userMessages[3])
  await page.locator('#psend').click()
  // generation must start WITHOUT clicking #pgen: contract section appears
  await page.waitForSelector('#pcontract .sec-h', { timeout: 30000 })
  const contract = await page.locator('#pcontract').textContent()
  check('UI: generation fires after confirmation without clicking generate', contract.includes(fixture.profile.name))
  const chatTxt = await page.locator('#pchat').textContent()
  check('UI: no marker on the rendered chat', !chatTxt.includes(MARK) && !chatTxt.includes('[['))
  check('UI: no third confirmation ask (reply acknowledges, does not ask again)',
    chatTxt.includes('generating the spec') && !chatTxt.toLowerCase().includes('whenever you'))
  // server holds the inception too (generation really ran, not narrated)
  const inc = await fetch(BASE + '/api/plato-profile', { headers: { authorization: 'Bearer ' + session.token } }).then(r => r.json())
  check('server: inception contract exists after the handoff', inc.ok === true && inc.inception && inc.inception.profile.name === fixture.profile.name)
} finally {
  await browser.close()
  srv.kill()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
