// T14 smoke (testplan S1/S2): scale fixture — 100+ registry agents across 5+
// domains via scripts/seed-scale.mjs, then verify the AI Registry stays usable
// (pagination + search, full count shown, no truncation), API latency holds,
// a seeded-domain builder is scoped correctly with zero code change, and
// listEvalRuns returns 25+ runs fully (S2 root fix). The fixture is ALWAYS
// removed in finally (seed-scale --restore), so the suite stays order-
// independent and later exact-count tests see the committed 2-domain roster.
// Run: node e2e/smoke-scale.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiLogin, uiLogin, authedGet } from './login.mjs'

let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const skip = (name, why) => console.log(`SKIP  ${name} (${why})`)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED = path.join(ROOT, 'scripts', 'seed-scale.mjs')
const seedRun = (...args) => spawnSync('node', [SEED, ...args], { encoding: 'utf8' })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

const admin = await apiLogin('melanie')
const baselineReg = (await authedGet('/registry', admin)).entries.length
const baselineDomains = (await authedGet('/domains', admin)).domains.length

const applied = seedRun()
check('seed-scale applies cleanly', applied.status === 0 && /applied/.test(applied.stdout))

try {
  // ---------- S1: 100+ agents across >=5 domains, live without a restart ----------
  const roster = (await authedGet('/domains', admin)).domains
  check(`domain roster grows to ${roster.length} (>=5) domains`, roster.length >= 5 && roster.length === baselineDomains + 3)
  const t0 = Date.now()
  const reg = (await authedGet('/registry', admin)).entries
  const latencyMs = Date.now() - t0
  check(`registry lists ${reg.length} entries (>=100 over the ${baselineReg} baseline)`, reg.length >= baselineReg + 100)
  check(`registry API latency acceptable at scale (${latencyMs}ms < 2000ms)`, latencyMs < 2000)
  const seededDomains = ['payments', 'people-ops', 'logistics']
  check('seeded agents span all three new domains',
    seededDomains.every(d => reg.filter(e => e.domain === d && e.type === 'Agent').length >= 30))

  // ---------- Registry UI: pagination + search hold up (no truncation) ----------
  await uiLogin(page, 'melanie')
  await page.locator('.nav[data-shellnav="registry"]').click()
  await page.waitForSelector('.regrow')
  check('page 1 renders the page size, not the full set', (await page.locator('.regrow').count()) === 50)
  const footer1 = await page.locator('#regbox').textContent()
  check(`footer shows the FULL count (${reg.length} entries) — no silent truncation`,
    footer1.includes(`${reg.length} entries`) && footer1.includes('page 1/'))
  await page.locator('#regnext').click()
  await page.waitForFunction(() => document.querySelector('#regbox')?.textContent.includes('page 2/'))
  check('Next › pages forward (page 2 renders rows)', (await page.locator('.regrow').count()) > 0)
  await page.locator('#regprev').click()
  await page.waitForFunction(() => document.querySelector('#regbox')?.textContent.includes('page 1/'))
  check('‹ Prev pages back', (await page.locator('.regrow').count()) === 50)
  // search narrows across the whole set (not just the current page)
  await page.fill('#regsearch', 'payments')
  await page.waitForFunction(() => document.querySelector('#regbox')?.textContent.includes('matching'))
  const paymentsCount = reg.filter(e =>
    (e.name || '').toLowerCase().includes('payments') || (e.id || '').toLowerCase().includes('payments') ||
    (e.domain || '').toLowerCase().includes('payments')).length
  check(`search "payments" narrows to ${paymentsCount} matches across all pages`,
    (await page.locator('#regbox').textContent()).includes(`${paymentsCount} entries matching`))
  await page.fill('#regsearch', '')
  await page.waitForFunction(() => !document.querySelector('#regbox')?.textContent.includes('matching'))
  check('registry page carries no mock/simulated wording at scale (H1)',
    !/mock|simulated/i.test(await page.locator('main').textContent()))
  await page.screenshot({ path: '/tmp/e2e-shots/t14-registry-scale.png', fullPage: true }).catch(() => {})

  // ---------- Seeded-domain builder: scoped correctly, zero code change ----------
  const pb = await apiLogin('payments-builder')
  check('seeded builder login works (vended with the fixture domain)', pb.role === 'builder' && pb.domain === 'payments')
  const pbReg = (await authedGet('/registry', pb)).entries
  check('seeded builder sees own-domain + explicitly-shared entries only (default-deny)',
    pbReg.some(e => e.domain === 'payments') && pbReg.every(e => e.domain === 'payments' || e.domain === 'shared'))
  const pbScopes = await authedGet('/obs-scopes', pb)
  check('seeded builder obs scope: payments domain only, with its 40 agents',
    !pbScopes.fleet && pbScopes.domains.length === 1 && pbScopes.domains[0].id === 'payments' &&
    pbScopes.domains[0].agents.length === 40)

  // ---------- S2: listEvalRuns >10 truncation root-fixed — 25+ runs list fully ----------
  const runsDir = path.join(ROOT, 'domain-examples', 'generated', 'supportdesk', 'agentcore', '.cli', 'eval-runs')
  if (!existsSync(runsDir)) {
    skip('S2 eval-run truncation check', 'no local supportdesk eval runs (fresh clone)')
  } else {
    // The original check required 25+ REAL accumulated runs on disk — an
    // environment-dependent precondition (the author's machine had them; a
    // fresh-ish clone has only what journey-builder produced). Seed synthetic
    // finished-run files up to 25 so the >10-truncation property is actually
    // exercised everywhere, then remove exactly the files we added (fixture
    // seed+restore, same pattern as the rest of this smoke).
    const seeded = []
    try {
      const real = readdirSync(runsDir).filter(f => f.endsWith('.json')).length
      for (let i = real; i < 25; i++) {
        const f = `run-0000-s2-fixture-${String(i).padStart(3, '0')}.json`
        writeFileSync(path.join(runsDir, f), JSON.stringify({
          runId: f.replace(/\.json$/, ''), project: 'supportdesk', dataset: 'golden',
          status: 'done', total: 4, invoked: 4, scored: 4,
          startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z',
          scenarios: [], evaluators: [], snapshot: {}, aggregate: { overall: 0.9 },
        }))
        seeded.push(f)
      }
      const onDisk = readdirSync(runsDir).filter(f => f.endsWith('.json')).length
      const runs = (await authedGet('/eval-runs?project=supportdesk', admin)).runs
      check(`S2: /api/eval-runs returns ALL ${onDisk} finished runs (>=25, no >10 truncation)`,
        onDisk >= 25 && runs.length >= onDisk)
    } finally {
      for (const f of seeded) rmSync(path.join(runsDir, f), { force: true })
    }
  }
} finally {
  const restored = seedRun('--restore')
  check('seed-scale --restore removes the fixture', restored.status === 0 && /restored/.test(restored.stdout))
  const afterReg = (await authedGet('/registry', admin)).entries.length
  const afterDomains = (await authedGet('/domains', admin)).domains.length
  check(`counts back to baseline (${afterReg} entries, ${afterDomains} domains)`,
    afterReg === baselineReg && afterDomains === baselineDomains)
  await browser.close()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
