// G11 smoke: chat-bubble markdown rendering (Melanie + independent review bug family).
// Every chat surface (Plato inception, fleet chat, agent chat) renders through
// the single md() in index.html, so asserting on the Plato door's rendered DOM
// covers them all. Bugs fixed: (1) ordered lists separated by blank lines
// rendered as N one-item lists — numbering showed "1 1 1 1"; (2) leading "* "
// bullets were eaten by the <em> pass, leaking raw asterisks; (3) inline _/*
// matched inside identifiers, so about_triaging_ lost its underscores/spacing.
// Uses the PLATO_FIXTURE server (deterministic replay of a real Bedrock run)
// on :4101 — the main :4000 server stays live.
// Run: node e2e/smoke-markdown.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { primeLastProject } from './login.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = 'http://localhost:4101'
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const fixture = JSON.parse(readFileSync(path.join(here, '../console/plato-fixture.json'), 'utf8'))

// --- boot a fixture-mode server on :4101 ---
const srv = spawn('node', [path.join(here, '../console/server.mjs')], {
  env: { ...process.env, PORT: '4101', PLATO_FIXTURE: '1' }, stdio: 'ignore',
})
let up = false
for (let i = 0; i < 30 && !up; i++) {
  try { await fetch(BASE + '/api/blueprints'); up = true }
  catch { await new Promise(r => setTimeout(r, 500)) }
}
if (!up) { console.error('fixture server failed to boot on :4101'); srv.kill(); process.exit(1) }

const browser = await chromium.launch()
try {
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'alice', idp: 'okta' }),
  }).then(r => r.json())

  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  // TLP-B2.3 hybrid landing: returning-visit path so alice lands in the
  // workspace (with the Build nav entry), not the My Projects cards page.
  await primeLastProject(login, BASE)
  await page.goto(BASE)
  await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), login)
  await page.goto(BASE)
  await page.waitForSelector('#whoami')
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('[data-door="plato"]')
  await page.locator('[data-door="plato"]').click()
  await page.waitForSelector('#pchat')
  await page.waitForFunction(() => !document.getElementById('pchat').textContent.includes('loading conversation'), { timeout: 10000 })

  // Turn 1: the recorded reply carries a 5-item numbered list (items separated
  // by blank lines — the exact shape that used to render "1 1 1 1 1") plus
  // **bold** question leads.
  await page.locator('#pmsg').fill(fixture.userMessages[0])
  await page.locator('#psend').click()
  await page.waitForFunction(() =>
    document.querySelectorAll('#pchat .msg').length >= 2 && !document.querySelector('#pchat .spin')
    && !document.querySelector('#pchat [data-streaming]'), { timeout: 15000 })

  const reply = page.locator('#pchat .msg').nth(1).locator('.body')
  check('numbered list renders as ONE <ol> (was one per item)', (await reply.locator('ol').count()) === 1)
  const olShape = await reply.evaluate(b => {
    const ol = b.querySelector('ol')
    return ol ? { start: ol.start, items: ol.querySelectorAll(':scope > li').length } : null
  })
  check('ol numbering is sequential 1..5 (start=1, 5 items in one list)',
    olShape && olShape.start === 1 && olShape.items === 5)
  const replyTxt = await reply.textContent()
  check('no raw ** asterisks leak into the rendered reply', !replyTxt.includes('**'))
  check('bold question leads render as <strong>', (await reply.locator('strong').count()) >= 4)
  check('list items keep their text (spot check first question)', replyTxt.includes("Who's the end user?"))

  // Turn 2: a crafted user message exercises the inline edge cases directly —
  // the user bubble renders through the same md(). snake_case identifiers and
  // math asterisks must pass through untouched (spacing intact); real emphasis
  // and code spans must format.
  const probe = 'talk about_triaging_ tickets, *emphasize this*, math 2 * 3, and `snake_case_fn` inline'
  await page.locator('#pmsg').fill(probe)
  await page.locator('#psend').click()
  await page.waitForFunction(() =>
    document.querySelectorAll('#pchat .msg').length >= 4 && !document.querySelector('#pchat .spin')
    && !document.querySelector('#pchat [data-streaming]'), { timeout: 15000 })

  const bubble = page.locator('#pchat .msg').nth(2).locator('.body')
  const txt = await bubble.textContent()
  check('snake_case keeps underscores and adjacent spacing (about_triaging_ tickets)',
    txt.includes('talk about_triaging_ tickets'))
  check('math asterisks with spaces stay literal (2 * 3)', txt.includes('2 * 3'))
  check('real *emphasis* renders as <em> (no raw asterisks left)',
    (await bubble.locator('em', { hasText: 'emphasize this' }).count()) === 1 && !txt.includes('*emphasize'))
  check('code span renders and protects its underscores',
    (await bubble.locator('code', { hasText: 'snake_case_fn' }).count()) === 1)

  // Bullet lists: a leading "* " must be a bullet, never swallowed as <em>.
  const bullets = '* first bullet with *nested em* inside\n* second bullet'
  await page.locator('#pmsg').fill(bullets)
  await page.locator('#psend').click()
  await page.waitForFunction(() =>
    document.querySelectorAll('#pchat .msg').length >= 6 && !document.querySelector('#pchat .spin')
    && !document.querySelector('#pchat [data-streaming]'), { timeout: 15000 })
  const ub = page.locator('#pchat .msg').nth(4).locator('.body')
  check('"* " lines render as one <ul> with 2 items',
    (await ub.locator('ul').count()) === 1 && (await ub.locator('ul > li').count()) === 2)
  const ubTxt = await ub.textContent()
  check('bullet text intact with nested em, no leaked asterisks',
    (await ub.locator('em', { hasText: 'nested em' }).count()) === 1 && !ubTxt.includes('*'))
} finally {
  await browser.close()
  srv.kill()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
