// TLP-B20 smoke — governance compliance tab + builder cost detail + C1-C3
// cold-start degrade. Frozen checklist (independent review 2026-08-13) items covered:
//   1. Compliance tab: per-registry-type lifecycle count cards, guardrail
//      wiring coverage %, oldest-pending SLA card (>7d red), working links
//      to the audit trail / approval queue.
//   2. Data truthfulness: card numbers reconcile with /api/registry +
//      /api/blueprint-submissions (API fetched independently here).
//   3. Builder Cost tab: per-agent rows (name + invocations + cost) that
//      reconcile EXACTLY with the /api/costs ledger rows (same source
//      /api/domain-cost-rollup aggregates), plus the domain-budget share bar.
//   4. C1 cold start: a FRESHLY SPAWNED server (own port, no warm caches in
//      this process) serves the Governance approval queue's first-screen
//      content within 3s of page navigation.
//   5. negative case: compliance tab with stubbed-empty registry + submissions renders
//      an honest empty state — no fabricated numbers.
// Run: node e2e/smoke-tlp-b20.mjs   (expects console server via CONSOLE_BASE)
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { apiLogin, authedGet, uiLogin } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

// ---- independent API truth ----
const admin = await apiLogin('melanie')
const reg = await authedGet('/registry', admin)
const subs = await authedGet('/blueprint-submissions', admin)
const fleet = await authedGet('/fleet', admin)
const regEntries = reg.entries || []
const regTypes = [...new Set(regEntries.map(e => e.type))]
const versionCount = t => regEntries.filter(e => e.type === t)
  .reduce((n, e) => n + (e.versions || []).length, 0)

const browser = await chromium.launch()
try {
  // ============ 1+2. compliance tab against live API data ============
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'melanie')
  await page.locator('.nav', { hasText: 'Governance' }).click()
  await page.locator('.govtab[data-tab="compliance"]').click()
  await page.waitForSelector('[data-compcard]', { timeout: 15000 })

  check(`C1 one lifecycle count card per registry type (${regTypes.length})`,
    (await page.locator('[data-compcard]').count()) === regTypes.length)

  // data truthfulness: every card's total equals that type's version count in the API
  let cardsReconcile = true
  for (const t of regTypes) {
    const rendered = parseInt(await page.locator(`[data-compcard="${t}"] [data-compcard-total]`).getAttribute('data-compcard-total'), 10)
    if (rendered !== versionCount(t)) { cardsReconcile = false; console.log(`   mismatch ${t}: UI=${rendered} API=${versionCount(t)}`) }
  }
  check('C2 every type card total reconciles with /api/registry version counts', cardsReconcile)

  // guardrail wiring %: same derivation as the UI, from the independent fleet fetch
  const agents = fleet.agents || []
  const expectedPct = agents.length ? Math.round(agents.filter(a => a.project).length / agents.length * 100) : null
  check('C3 guardrail wiring coverage % matches the fleet-derived figure',
    (await page.locator('#gcompwiring').getAttribute('data-wired-pct')) === String(expectedPct ?? ''),
    `expected=${expectedPct}`)

  // SLA card: age must equal the API's oldest pending item (registry IN_REVIEW
  // ∪ pending blueprint submissions); red styling asserted iff >7d.
  const pendingAts = [
    ...regEntries.flatMap(e => (e.versions || []).filter(v => v.status === 'IN_REVIEW').map(v => v.createdAt)),
    ...(subs.submissions || []).filter(s => s.status === 'pending_approval').map(s => s.submittedAt),
  ].sort()
  const expectedDays = pendingAts.length ? Math.floor((Date.now() - new Date(pendingAts[0]).getTime()) / 86400000) : null
  const slaDays = await page.locator('#gcompsla').getAttribute('data-sla-days')
  check('C4 oldest-pending SLA card age matches API oldest pending item',
    slaDays === String(expectedDays ?? ''), `UI=${slaDays} API=${expectedDays}`)
  if (expectedDays != null) {
    const slaText = await page.locator('#gcompsla').textContent()
    check('C5 SLA card states breach iff >7 days',
      expectedDays > 7 ? slaText.includes('SLA breach') : slaText.includes('within 7d SLA'))
  }

  // pending blueprint submissions card reconciles with the API
  const pendingSubs = (subs.submissions || []).filter(s => s.status === 'pending_approval').length
  check('C6 blueprint submissions card reconciles with /api/blueprint-submissions',
    (await page.locator('[data-gcsubs]').getAttribute('data-gcsubs')) === String(pendingSubs))

  // links: audit + queue both navigate
  await page.locator('#gcomp2audit').click()
  await page.waitForSelector('#audlist', { timeout: 10000 })
  check('C7 audit link lands on the audit trail tab', true)
  await page.locator('.govtab[data-tab="compliance"]').click()
  await page.waitForSelector('#gcomp2queue2', { timeout: 10000 })
  await page.locator('#gcomp2queue2').click()
  await page.waitForSelector('#govqueue', { timeout: 10000 })
  check('C8 queue link lands on the approval queue tab', true)
  await page.close()

  // ============ 5. negative case: honest empty state, no fabricated numbers ============
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await page2.route('**/api/registry', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) }))
  await page2.route('**/api/blueprint-submissions', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, submissions: [] }) }))
  await uiLogin(page2, 'melanie')
  await page2.locator('.nav', { hasText: 'Governance' }).click()
  await page2.locator('.govtab[data-tab="compliance"]').click()
  await page2.waitForSelector('[data-compempty]', { timeout: 15000 })
  const emptyBox = await page2.locator('#gcompliance').textContent()
  check('E1 empty registry+submissions -> honest empty state, zero count cards',
    (await page2.locator('[data-compcard]').count()) === 0 && /nothing to report/i.test(emptyBox))
  check('E2 empty state fabricates no percentages or day counts', !/\d+%|\d+d/.test(emptyBox))
  await page2.close()

  // ============ 3. builder cost tab per-agent rows reconcile exactly ============
  const alice = await apiLogin('alice')
  const myProjects = (await authedGet('/my-projects', alice)).projects || []
  const costsApi = await authedGet('/costs', alice)
  const page3 = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page3, 'alice')
  await page3.waitForSelector('.nav[data-shellnav="cost"]', { timeout: 15000 })
  await page3.locator('.nav[data-shellnav="cost"]').click()
  await page3.waitForSelector('[data-costtotal]', { timeout: 15000 })
  // the workspace landed on alice's last-used project — read it from the H1 context span
  const projName = (await page3.locator('h1 span').first().textContent()).trim()
  const proj = myProjects.find(p => p.name === projName) || myProjects[0]
  const apiRows = (costsApi.perAgent || []).filter(a => (proj.agents || []).includes(a.project))
  check(`B1 cost tab renders one row per ledger agent (${apiRows.length})`,
    (await page3.locator('[data-agentcost]').count()) === apiRows.length)
  let rowsReconcile = apiRows.length > 0
  for (const a of apiRows) {
    const row = page3.locator(`[data-agentcost="${a.project}"]`)
    if ((await row.count()) !== 1 ||
        (await row.getAttribute('data-invocations')) !== String(a.invocations) ||
        (await row.getAttribute('data-cost')) !== String(a.costUsd)) {
      rowsReconcile = false
      console.log(`   mismatch ${a.project}: API inv=${a.invocations} cost=${a.costUsd}`)
    }
  }
  check('B2 every agent row reconciles EXACTLY (invocations + costUsd) with /api/costs', rowsReconcile)
  const expectedTotal = +apiRows.reduce((s, a) => s + a.costUsd, 0).toFixed(6)
  check('B3 project total is the fixed-point sum of its agent rows (G3contract)',
    (await page3.locator('[data-costtotal]').getAttribute('data-costtotal')) === String(expectedTotal))
  // budget share bar: G3 arithmetic against the domain's vended tokenBudget
  const dom = ((await authedGet('/domains', alice)).domains || []).find(d => d.id === proj.domain)
  const tokensUsed = apiRows.reduce((s, a) => s + (a.inputTokens || 0) + (a.outputTokens || 0), 0)
  const expectedPct2 = dom && dom.tokenBudget ? Math.round(tokensUsed / dom.tokenBudget * 100) : null
  check('B4 domain-budget share bar renders with the rollup percentage arithmetic',
    (await page3.locator('[data-budgetpct]').first().getAttribute('data-budgetpct')) === String(expectedPct2 ?? ''),
    `expected=${expectedPct2}`)
  await page3.close()

  // ============ 4. C1 cold start: fresh server, first screen ≤3s ============
  // A brand-new server process (no warm fleet cache) must put first-screen
  // content on the Governance approval queue within 3s of page navigation.
  const COLD_PORT = 4297
  const consoleDir = new URL('../console/', import.meta.url).pathname
  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: consoleDir, env: { ...process.env, PORT: String(COLD_PORT) }, stdio: 'ignore',
  })
  try {
    const coldBase = `http://localhost:${COLD_PORT}`
    // wait for the port only — NOT for the preheat to finish
    // 15s window: on a loaded host node startup alone can exceed 5s (false red);
    // S1/S2 ≤3s first-screen SLAs below are unaffected by this wait.
    let up = false
    for (let i = 0; i < 150 && !up; i++) {
      up = await fetch(coldBase + '/').then(r => r.ok, () => false)
      if (!up) await new Promise(r => setTimeout(r, 100))
    }
    check('S0 cold server came up', up)
    const login = await fetch(coldBase + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'melanie', idp: 'okta' }),
    }).then(r => r.json())
    const page4 = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await page4.goto(coldBase)
    await page4.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), login)
    await page4.goto(coldBase)
    await page4.waitForSelector('#whoami', { timeout: 15000 })
    await page4.locator('.nav', { hasText: 'Governance' }).click()
    const t0 = Date.now()
    // first-screen content = queue box AND the fleet-backed deployed-agents
    // box (the historical 6-8s hang) both past their ⟳ placeholders.
    await page4.waitForFunction(() => {
      const done = id => { const b = document.getElementById(id); return b && !b.textContent.includes('loading') && b.textContent.trim().length > 0 }
      return done('govqueue') && done('govagents')
    }, null, { timeout: 15000 })
    const elapsed = Date.now() - t0
    check(`S1 cold-start approval queue first-screen content in ≤3s (took ${elapsed}ms)`, elapsed <= 3000)
    // C3 area: the Monitoring Alerts tab (fleet-backed too) on the same cold server
    await page4.locator('.nav[data-shellnav="monitoring"]').click()
    await page4.waitForSelector('.obstab[data-tab="alerts"]', { timeout: 10000 })
    await page4.locator('.obstab[data-tab="alerts"]').click()
    const t1 = Date.now()
    await page4.waitForFunction(() => {
      const b = document.getElementById('alertsbox')
      return b && !b.textContent.includes('loading') && b.textContent.trim().length > 0
    }, null, { timeout: 15000 })
    const elapsed2 = Date.now() - t1
    check(`S2 cold-start Alerts tab first-screen content in ≤3s (took ${elapsed2}ms)`, elapsed2 <= 3000)
    await page4.close()
  } finally {
    srv.kill()
  }
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures ? 1 : 0)
