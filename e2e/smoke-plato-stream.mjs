// G15 smoke: streaming inception chat (SSE from /api/plato-chat-stream).
// The fixture server replays the recorded Bedrock reply in paced word
// fragments, so "first token arrives before full completion" is testable
// deterministically. Boots its own PLATO_FIXTURE server on :4103; the main
// :4000 server stays live.
// Run: node e2e/smoke-plato-stream.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { primeLastProject } from './login.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'http://localhost:4103'
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const fixture = JSON.parse(readFileSync(path.join(here, '../console/plato-fixture.json'), 'utf8'))

// --- boot a fixture-mode server on :4103 ---
const srv = spawn('node', [path.join(here, '../console/server.mjs')], {
  env: { ...process.env, PORT: '4103', PLATO_FIXTURE: '1' }, stdio: 'ignore',
})
let up = false
for (let i = 0; i < 30 && !up; i++) {
  try { await fetch(BASE + '/api/blueprints'); up = true }
  catch { await new Promise(r => setTimeout(r, 500)) }
}
if (!up) { console.error('fixture server failed to boot on :4103'); srv.kill(); process.exit(1) }

const login = async (user) => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, idp: 'okta' }),
  })
  return r.json()
}

const browser = await chromium.launch()
try {
  // --- API security: same gates as the non-streaming endpoint ---
  const noAuth = await fetch(BASE + '/api/plato-chat-stream', { method: 'POST', body: '{}' })
  check('stream without a session -> 401', noAuth.status === 401)
  const eu = await login('enduser')
  const euResp = await fetch(BASE + '/api/plato-chat-stream', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + eu.token },
    body: JSON.stringify({ message: 'hi' }),
  })
  check('end-user session -> 403 (builder surface)', euResp.status === 403)
  const alice = await login('alice')
  const empty = await fetch(BASE + '/api/plato-chat-stream', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ message: '   ' }),
  })
  check('empty message -> 400', empty.status === 400)

  // --- SSE protocol: first token strictly before full completion ---
  const resp = await fetch(BASE + '/api/plato-chat-stream', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ message: fixture.userMessages[0] }),
  })
  check('stream responds with text/event-stream', (resp.headers.get('content-type') || '').includes('text/event-stream'))
  const t0 = Date.now()
  let firstChunkAt = null, doneAt = null, chunks = 0, assembled = '', sawError = null
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
        if (et === 'chunk') { chunks++; if (!firstChunkAt) firstChunkAt = Date.now() - t0; assembled += JSON.parse(dm) }
        else if (et === 'done') doneAt = Date.now() - t0
        else if (et === 'error') sawError = JSON.parse(dm)
      }
    }
  }
  check('no stream error event', sawError === null)
  check('reply arrives in multiple chunks (progressive, not one blob)', chunks >= 5)
  check('first token arrives BEFORE full completion', firstChunkAt !== null && doneAt !== null && firstChunkAt < doneAt)
  check('assembled stream equals the recorded reply', assembled === fixture.replies[0])
  const tr = await fetch(BASE + '/api/plato-chat', { headers: { authorization: 'Bearer ' + alice.token } }).then(r => r.json())
  check('streamed turn lands in the server transcript (user + assistant)',
    tr.transcript.length === 2 && tr.transcript[1].text === fixture.replies[0])

  // --- UI: progressive render — partial text visible before the reply completes ---
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  const session = await login('bob')
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
  // sample the reply bubble length while streaming: growth = progressive render
  await page.evaluate(() => {
    window.__samples = []
    const timer = setInterval(() => {
      const msgs = document.querySelectorAll('#pchat .msg')
      const last = msgs[msgs.length - 1]
      if (msgs.length >= 2 && last && !last.querySelector('.spin'))
        window.__samples.push(last.querySelector('.body').textContent.length)
    }, 60)
    window.__stopSampling = () => clearInterval(timer)
  })
  await page.locator('#pmsg').fill(fixture.userMessages[0])
  await page.locator('#psend').click()
  // completion = 2 messages, no typing spinner, AND the in-progress streaming
  // bubble (data-streaming) replaced by the final render
  await page.waitForFunction(() =>
    document.querySelectorAll('#pchat .msg').length >= 2 && !document.querySelector('#pchat .spin')
    && !document.querySelector('#pchat [data-streaming]'), { timeout: 20000 })
  const samples = await page.evaluate(() => { window.__stopSampling(); return window.__samples })
  const grew = samples.length >= 2 && samples[0] < samples[samples.length - 1]
  check('UI renders the reply progressively (bubble grows across samples)', grew)
  const finalTxt = await page.locator('#pchat .msg').nth(1).locator('.body').textContent()
  const norm = s => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
  check('final rendered reply matches the recorded conversation', norm(finalTxt).includes(norm(fixture.replies[0]).slice(0, 80)))
  check('markdown still renders after streaming (one ol, no raw asterisks)',
    (await page.locator('#pchat .msg').nth(1).locator('ol').count()) === 1 && !finalTxt.includes('**'))
  check('typing indicator gone after completion', (await page.locator('#pchat .spin').count()) === 0)

  // transcript consistency after a streamed UI turn
  const tr2 = await fetch(BASE + '/api/plato-chat', { headers: { authorization: 'Bearer ' + session.token } }).then(r => r.json())
  check('UI streamed turn persisted server-side', tr2.transcript.length === 2)
} finally {
  await browser.close()
  srv.kill()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
