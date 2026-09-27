// independent review Round 11b — independent verification of the two things Melanie SAW in
// the UI: the ordered list rendering as "1 1 1 1 1", and the absence of
// streaming. Asserted on the rendered DOM (what she actually looked at), not
// on the product's own smoke assertions.
import { chromium } from 'playwright'
import { apiLogin, primeLastProject } from './login.mjs'

const BASE = 'http://localhost:4000'
let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const page = await browser.newPage()
const s = await apiLogin('alice')
// TLP-B2.3 hybrid landing: model a returning visit (last-used project set) so
// alice lands in the workspace with the Build nav entry available.
await primeLastProject(s)
await page.goto(BASE)
await page.evaluate(v => localStorage.setItem('console.session', v), JSON.stringify(s))
await page.goto(BASE)
// wait for the workspace SIDEBAR nav (the <nav> shell element is static HTML
// and exists before render — the resume hop makes the old wait racy)
await page.waitForSelector('.nav[data-shellnav="build"]')

// open the inception (Plato) chat — the builder's Build entry -> the "Design
// with Plato" door. NOTE: the door id is `plato` (not `inception`) and the
// real chat widgets are #pchat (transcript) + #pmsg (textarea) — my first run
// clicked a story link and landed on Agent Fleet instead, so target the ids
// directly. TLP-B2 shells: the builder nav entry is "Build Agent +".
await page.evaluate(() => {
  const el = Array.from(document.querySelector('nav').querySelectorAll('div'))
    .find(d => /Build (an Agent|Agent \+)$/.test(d.textContent.trim()))
  el?.click()
})
await page.waitForTimeout(1500)
const door = await page.evaluate(() => {
  const d = document.querySelector('[data-door="plato"]')
  if (d) { d.click(); return true }
  return false
})
await page.waitForSelector('#pmsg', { timeout: 15000 })
await page.waitForTimeout(800)
console.log(`      [info] plato door opened: ${door}, chat widgets present: ${await page.evaluate(() => !!document.getElementById('pchat') && !!document.getElementById('pmsg'))}`)

// send the exact message Melanie used, through the real input + Enter handler
const sent = await page.evaluate(() => {
  const box = document.getElementById('pmsg')
  if (!box) return 'no #pmsg'
  box.value = 'I want to build a devops agent'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return 'Enter dispatched on #pmsg'
})
console.log(`      [info] send: ${sent}`)

// ---- X1: STREAMING — text must grow progressively, not appear at once ----
{
  const samples = []
  // 40 samples x 500ms: the reply can take ~6s to start on a busy server; a
  // 24-sample window occasionally cut off mid-stream in the full regression.
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500)
    const len = await page.evaluate(() => {
      const box = document.getElementById('pchat')
      if (!box) return 0
      const msgs = box.children
      return msgs.length ? (msgs[msgs.length - 1].textContent || '').length : 0
    })
    samples.push(len)
    if (len > 400 && samples.slice(-3).every(x => x === len)) break
  }
  const growth = samples.filter((v, i) => i > 0 && v > samples[i - 1]).length
  console.log(`      [info] reply length samples: ${samples.join(',')}`)
  check('X1.1 reply arrives PROGRESSIVELY (streaming, >1 growth step)', growth > 1,
    `growth steps=${growth}`)
  check('X1.2 a reply actually arrived', Math.max(...samples) > 100, `maxLen=${Math.max(...samples)}`)
}

// ---- X2: MARKDOWN — the "1 1 1 1 1" bug Melanie saw ---------------------
{
  const md = await page.evaluate(() => {
    const host = document.getElementById('pchat') || document.querySelector('main')
    const ols = Array.from(host.querySelectorAll('ol'))
    const out = ols.map(ol => ({
      items: ol.children.length,
      // browser-computed marker text is what the human eye sees
      markers: Array.from(ol.children).map(li => getComputedStyle(li, '::marker').content || ''),
      start: ol.getAttribute('start'),
    }))
    // Measure INSIDE each rendered message body — raw host.textContent
    // concatenates the role label with the next body ("…agent"+"plato"+
    // "Welcome" -> "agentplatoWelcome"), a DOM artifact that false-positived
    // this probe whenever a reply ended without punctuation.
    const bodies = Array.from(host.querySelectorAll('.msg .body'))
    const text = (bodies.length ? bodies.map(b => b.textContent) : [host.textContent || '']).join('\n')
    return {
      ols: out,
      olCount: ols.length,
      // asterisk leaks / eaten spaces — the sibling bugs from the same family
      asteriskLeak: (text.match(/\*\*?\w/g) || []).slice(0, 3),
      eatenSpace: (text.match(/\b[a-z]{3,}[A-Z][a-z]{3,}/g) || [])
        .filter(w => !/^(GitHub|PagerDuty|OpsGenie|DevOps|ChatOps|AgentCore|CloudWatch)$/i.test(w)).slice(0, 3),
      liTotal: host.querySelectorAll('ol > li').length,
    }
  })
  console.log(`      [info] ol blocks=${md.olCount} total li=${md.liTotal} details=${JSON.stringify(md.ols)}`)
  check('X2.1 numbered list renders as ONE <ol> (not N separate single-item lists)',
    md.olCount <= 2 && md.liTotal >= 3, `ol=${md.olCount} li=${md.liTotal}`)
  check('X2.2 no <ol> is a lone single-item list (the "1 1 1 1 1" signature)',
    !(md.olCount >= 3 && md.ols.every(o => o.items === 1)),
    md.ols.map(o => o.items).join(','))
  check('X2.3 no raw asterisks leaked into rendered text', md.asteriskLeak.length === 0,
    md.asteriskLeak.join(' '))
  check('X2.4 no eaten spaces around emphasis (about*triaging* -> abouttriaging)',
    md.eatenSpace.length === 0, md.eatenSpace.join(' '))
}

await page.screenshot({ path: '/tmp/independent review-ia-plato.png', fullPage: false })
console.log('      [info] screenshot: /tmp/independent review-ia-plato.png')
await browser.close()
console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
