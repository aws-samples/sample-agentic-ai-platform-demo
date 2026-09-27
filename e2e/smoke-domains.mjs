// T12 smoke: "Create Domain" vending (WS-A2/R4, testplan S3/S5). Admin vends a
// domain → scoped namespace + obs scope + online-eval scope + cost bucket with
// budget bar are live immediately, and the vended builder/lead can sign in with
// correct server-side scoping — zero code change (the L3 scale proof).
// The test snapshots domains.json and ALWAYS restores it (finally), so the
// suite stays order-independent and the committed roster stays at 2 domains.
// Run: node e2e/smoke-domains.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiLogin, uiLogin, authedGet, authedPost, openAdminOps } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawStatus = (p, token, body) =>
  fetch(BASE + '/api' + p, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
  }).then(r => r.status)

const DOMAINS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'console', 'domains.json')
const domainsSnapshot = readFileSync(DOMAINS_PATH, 'utf8')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

try {
  const admin = await apiLogin('melanie')
  const alice = await apiLogin('alice')

  // ---------- authorization: vending is an admin power ----------
  check('builder cannot create a domain -> 403', await rawStatus('/domain-create', alice.token, { name: 'Evil' }) === 403)
  check('no session cannot create a domain -> 401', await rawStatus('/domain-create', null, { name: 'Evil' }) === 401)

  // ---------- validation ----------
  const dup = await authedPost('/domain-create', { name: 'Operations' }, admin)
  check('duplicate domain id rejected', dup.ok === false && /exists/.test(dup.error))
  const badBudget = await authedPost('/domain-create', { name: 'Finance', tokenBudget: '-5' }, admin)
  check('negative token budget rejected', badBudget.ok === false && /budget/i.test(badBudget.error))

  // ---------- UI: admin vends "Finance" from the Domains page ----------
  await uiLogin(page, 'melanie')
  await openAdminOps(page, 'domains')
  await page.waitForSelector('[data-domain="customer-support"]')
  check('Domains page lists the existing roster', (await page.locator('#domroster .item').count()) >= 2)
  await page.fill('#dname', 'Finance')
  await page.fill('#downer', 'Finance domain team')
  await page.fill('#dgroup', 'idp-group:finance-builders')
  await page.fill('#dbudget', '500000')
  await page.fill('#ddesc', 'Financial reporting and reconciliation agents.')
  await page.locator('#dcreate').click()
  await page.waitForSelector('#domstatus .status.ok')
  const okText = await page.locator('#domstatus').textContent()
  check('vend confirmation names the new sign-ins', okText.includes('Finance Builder') && okText.includes('Finance Lead'))
  await page.waitForSelector('[data-domain="finance"]')
  const rowText = await page.locator('[data-domain="finance"]').textContent()
  check('roster row shows owner group + budget + vended accounts',
    rowText.includes('idp-group:finance-builders') && rowText.includes('500,000') && rowText.includes('Finance Lead'))

  // ---------- vended sign-ins: role/domain resolved server-side ----------
  const fb = await apiLogin('finance-builder')
  const fl = await apiLogin('finance-lead')
  check('vended builder signs in as builder · finance', fb.role === 'builder' && fb.domain === 'finance')
  check('vended lead signs in as lead · finance', fl.role === 'lead' && fl.domain === 'finance')

  // ---------- S3: the new domain is scoped end-to-end with zero code change ----------
  const scopes = await authedGet('/obs-scopes', fb)
  check('vended builder obs scope: finance only, no fleet rollup',
    !scopes.fleet && scopes.domains.length === 1 && scopes.domains[0].id === 'finance')
  check('vended builder -> foreign agent metrics -> 404', await rawStatus('/metrics?scope=agent&id=supportdesk', fb.token) === 404)
  check('vended builder -> own domain metrics -> 200', await rawStatus('/metrics?scope=domain&id=finance', fb.token) === 200)
  check('vended builder -> own domain online-eval -> 200', await rawStatus('/online-eval?scope=domain&id=finance', fb.token) === 200)
  const oe = await authedGet('/online-eval?scope=domain&id=finance', fb)
  check('new domain online-eval starts honestly empty (no traffic yet)', oe.days.length === 0 && oe.score.avg === null)
  const reg = await authedGet('/registry', fb)
  check('vended builder registry: own-domain + explicitly-shared entries only (default-deny)',
    Array.isArray(reg.entries) && reg.entries.every(e => e.domain === 'finance' || e.domain === 'shared'))
  check('vended builder -> foreign eval-runs -> 404', await rawStatus('/eval-runs?project=supportdesk', fb.token) === 404)
  const adminScopes = await authedGet('/obs-scopes', admin)
  check('admin obs drill-down includes the new domain', adminScopes.domains.some(d => d.id === 'finance'))

  // ---------- S5: cost bucket + budget bar ----------
  const costs = await authedGet('/costs', admin)
  const fin = (costs.domains || []).find(d => d.id === 'finance')
  check('admin cost view has a finance bucket with its vended budget', !!fin && fin.tokenBudget === 500000 && fin.tokensUsed === 0 && fin.alert === 'ok')
  // TLP-B1 (spec §8): domain-level cost ROLLUPS are lead/admin only — a
  // builder keeps per-agent detail but gets no domain bucket at all.
  const aliceCosts = await authedGet('/costs', alice)
  check('builder gets NO domain cost bucket (TLP-B1 rollup gating)',
    (aliceCosts.domains || []).length === 0)
  const carolCosts = await authedGet('/costs', await apiLogin('carol'))
  check('scoped LEAD sees only her own domain bucket',
    (carolCosts.domains || []).length === 1 && carolCosts.domains[0].id === 'customer-support')
  // Over-budget alert (S5): data-driven — give customer-support a budget below
  // its REAL ledger token usage and assert the alert flips. Skipped on a fresh
  // clone whose ledger has no customer-support traffic yet.
  const cs = (costs.domains || []).find(d => d.id === 'customer-support')
  if (cs && cs.tokensUsed > 0) {
    const list = JSON.parse(readFileSync(DOMAINS_PATH, 'utf8'))
    list.find(d => d.id === 'customer-support').tokenBudget = Math.max(1, Math.floor(cs.tokensUsed / 2))
    writeFileSync(DOMAINS_PATH, JSON.stringify(list, null, 2))
    const over = ((await authedGet('/costs', admin)).domains || []).find(d => d.id === 'customer-support')
    check('domain over its token budget reports alert=over', over.alert === 'over' && over.budgetPct >= 100)
    await openAdminOps(page, 'cost')
    await page.waitForSelector('[data-costdomain="customer-support"]')
    const bucketText = await page.locator('[data-costdomain="customer-support"]').textContent()
    check('cost page shows the over-budget alert chip + burn %', bucketText.includes('over budget') && /% of token budget consumed/.test(bucketText))
    check('cost page renders the budget bar', (await page.locator('[data-costdomain="customer-support"] .budgetbar').count()) === 1)
  } else {
    console.log('SKIP  S5 over-budget alert (usage ledger has no customer-support traffic yet)')
  }

  // ---------- login page: vended accounts appear as tiles ----------
  await page.locator('#tbprofile').click()
  await page.locator('#tbswitchuser').click()
  await page.waitForSelector('.idptile')
  await page.locator('.idptile[data-idp="okta"]').click()
  await page.waitForSelector('.usertile[data-loginuser="finance-lead"]')
  check('login page offers the vended accounts', (await page.locator('.usertile[data-loginuser="finance-builder"]').count()) === 1)
  await page.locator('.usertile[data-loginuser="finance-builder"]').click()
  await page.waitForSelector('#whoami')
  const who = await page.locator('#whoami').textContent()
  check('vended builder UI session shows name + domain badge', who.includes('Finance Builder') && who.includes('Finance'))
  // TLP-B2 shells: a builder-role user (vended included) lands on the Build
  // Workspace. With no project memberships yet the workspace shows its empty
  // state ('No project yet'), so assert the shell root rather than content.
  await page.waitForSelector('#wsroot')
  check('vended builder lands on the Build Workspace shell', (await page.locator('#wsroot').count()) === 1)
  const nav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^A-Za-z]+/, ''))
  check('vended builder gets exactly the builder nav (no Governance, no Domains)',
    JSON.stringify(nav) === JSON.stringify(['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry']))
  await page.locator('.nav[data-shellnav="cost"]').click()
  await page.waitForSelector('#wsroot')
  check('vended builder Cost tab stays inside the workspace shell', (await page.locator('#wsroot').count()) === 1)
} finally {
  writeFileSync(DOMAINS_PATH, domainsSnapshot)
  await browser.close()
}

// restored roster: the committed 3-domain file is back (order-independence)
const admin2 = await apiLogin('melanie')
const roster = (await authedGet('/domains', admin2)).domains
check('domains.json restored to the committed 3-domain roster', roster.length === 3)
check('vended login is gone after restore (identity is data-driven too)',
  await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'finance-builder', idp: 'okta' }) }).then(r => r.status) === 401)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
