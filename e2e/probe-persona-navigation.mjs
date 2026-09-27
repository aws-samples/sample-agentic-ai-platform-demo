// independent review probe — FRONT-END / IA surface (updated for TLP-B2 v2 per-persona
// shells @ feat/three-layer-persona). Melanie's rework: the console IS the
// persona's entire UI — no shared global sidebar. Every persona's nav must be
// EXACTLY its shell's list, walked in a real browser, every entry rendering.
// Real renders — no code reading substituted for behaviour.
import { chromium } from 'playwright'
import { apiLogin, primeLastProject } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const browser = await chromium.launch()
const page = await browser.newPage()

// Log in as a user and return the rendered sidebar (labels in order, icons stripped).
async function navFor(user) {
  const s = await apiLogin(user)
  // TLP-B2.3 hybrid landing: returning-visit path (last-used set) — the
  // fresh cards-page path is asserted in smoke-tlp-b2.mjs.
  await primeLastProject(s)
  await page.goto(BASE)
  await page.evaluate(v => localStorage.setItem('console.session', v), JSON.stringify(s))
  await page.goto(BASE)
  await page.waitForSelector('nav .nav', { timeout: 15000 })
  await page.waitForTimeout(600)
  const items = await page.evaluate(() =>
    Array.from(document.querySelectorAll('nav .nav')).map(d => d.textContent.trim().replace(/^[^\w]+/, '')))
  return { session: s, items }
}

// ---- W1: the per-persona shells — exact nav lists (TLP-B2 v2 DOM anchor) ---
const EXPECT = {
  alice:   ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry'],
  carol:   ['Dashboard', 'Projects', 'Users & Access', 'Governance & Approvals'],
  // TLP-B4: 'Platform Approvals' = the 4-eyes guardrail-exemption queue (layer 2).
  // Deliberately a LITERAL, not the shared ADMIN_NAV constant: this probe is an
  // independent ruler — if the shared constant drifts wrong, coupling would make
  // this probe wrong with it. Literal copies crosscheck each other. (R-B4-02)
  melanie: ['Home', 'AI Registry', 'Governance', 'Platform Approvals', 'Blueprints', 'Platform Projects'],
  enduser: ['Overview', 'Agents'],
}
// Retired-as-global items that must never reappear as top-level nav for scoped roles.
const RETIRED = ['Overview', 'Blueprints', 'Build an Agent', 'My Domain', 'My Project', 'Domain Console',
  'Agent Fleet', 'AI Gateway', 'Memory', 'Audit', 'Domains', 'Integrations', 'Access Requests', 'Operate']

const NAVS = {}
for (const u of ['melanie', 'alice', 'carol', 'enduser']) NAVS[u] = await navFor(u)

for (const [u, want] of Object.entries(EXPECT)) {
  const got = NAVS[u].items
  console.log(`\n      [${u} / ${NAVS[u].session.role}] ${got.join(' | ')}`)
  check(`W1 ${u}: nav is EXACTLY the shell list (${want.length} entries)`,
    got.length === want.length && want.every((w, i) => got[i] === w), got.join(','))
  const allowed = new Set(want)
  const residue = got.filter(t => RETIRED.includes(t) && !allowed.has(t))
  check(`W1b ${u}: zero old-global residue`, residue.length === 0, residue.join(','))
}

// ---- W2: shells are mutually exclusive — no persona sees another's sections
{
  check('W2.1 builder sees no console sections (Dashboard/Users & Access/Home/Platform Projects)',
    !NAVS.alice.items.some(t => /Dashboard|Users & Access|Platform Projects|^Home$/.test(t)))
  check('W2.2 lead sees no workspace tabs or platform sections',
    !NAVS.carol.items.some(t => /Fleet|Memory & KB|Build Agent|Platform Projects|^Home$/.test(t)))
  check('W2.3 admin sees no workspace tabs or domain sections',
    !NAVS.melanie.items.some(t => /^Fleet$|Memory & KB|Build Agent|Dashboard|Users & Access/.test(t)))
  check('W2.4 end user sees only Overview + Agents',
    NAVS.enduser.items.length === 2 &&
    !NAVS.enduser.items.some(t => /Governance|Cost|Memory|Gateway|Audit|Requests/i.test(t)),
    NAVS.enduser.items.join(','))
}

// ---- W3: capability boundaries survive the reshuffle
{
  check('W3.1 builder has NO Governance destination in nav',
    !NAVS.alice.items.some(t => /Governance/.test(t)))
  check('W3.2 lead Governance & Approvals is present (decideAccessRequests seat)',
    NAVS.carol.items.some(t => t === 'Governance & Approvals'))
  check('W3.3 admin AI Registry is a top-level (writable) section',
    NAVS.melanie.items.includes('AI Registry'))
}

// ---- W4: EVERY nav entry of EVERY persona actually renders ----------------
// Click each entry, assert the <h1> lands on the expected surface.
const VIEW_H1 = {
  alice: {
    'Fleet': /./,                       // workspace h1 = project name
    'Build Agent +': /Build an Agent/i,
    'Memory & KB': /./,
    'Cost': /./,
    'Observability': /Observability/i,
    'AI Registry': /AI Registry/i,
  },
  carol: {
    'Dashboard': /Dashboard/i, 'Projects': /Projects/i,
    'Users & Access': /Users & Access/i, 'Governance & Approvals': /Governance/i,
  },
  melanie: {
    'Home': /Platform Console/i, 'AI Registry': /AI Registry/i, 'Governance': /Governance/i,
    'Platform Approvals': /Platform Approvals/i,
    'Blueprints': /Blueprints/i, 'Platform Projects': /Platform (Console|Projects)/i,
  },
  enduser: { 'Overview': /Agentic AI Platform/i, 'Agents': /Agents/i },
}
console.log('\n--- W4: walking every sidebar entry per persona ---')
for (const u of ['melanie', 'alice', 'carol', 'enduser']) {
  const { items } = await navFor(u)
  for (const label of items) {
    const clicked = await page.evaluate(l => {
      const el = Array.from(document.querySelectorAll('nav .nav'))
        .find(d => d.textContent.trim().replace(/^[^\w]+/, '') === l)
      if (!el) return false
      el.click(); return true
    }, label)
    if (!clicked) { check(`W4 ${u} → ${label}`, false, 'nav entry not clickable'); continue }
    const want = VIEW_H1[u]?.[label]
    try {
      await page.waitForFunction(
        re => new RegExp(re, 'i').test(document.querySelector('main h1')?.textContent || ''),
        (want || /./).source, { timeout: 15000 })
    } catch { /* assertion below reports */ }
    await page.waitForTimeout(400)
    const h1 = await page.evaluate(() => document.querySelector('main h1')?.textContent?.trim() || '')
    const err = await page.evaluate(() => {
      const t = document.querySelector('main')?.textContent || ''
      return /Could not load|not available|undefined|NaN|\[object Object\]/.test(t)
        ? (t.match(/Could not load[^.]*|not available[^.]*|undefined|NaN|\[object Object\]/) || [''])[0] : ''
    })
    check(`W4 ${u} → ${label}`, !!h1 && (!want || want.test(h1)) && !err,
      `h1="${h1}"${err ? ' ERR=' + err : ''}`)
  }
}

await browser.close()
console.log(failures ? `\n${failures} PROBE(S) FLAGGED` : '\nALL PROBES CLEAN')
