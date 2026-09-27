import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// J-T10 smoke: from-scratch journey (MINIMAL preset) — minimal form, live
// file-list preview, single-digit export with the org gate pack.
// Run: node e2e/smoke-scratch.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { uiLogin, apiLogin, authedGet } from './login.mjs'

const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

// --- API security: builder surface, session-derived domain ---
const noAuth = await fetch((process.env.CONSOLE_BASE || 'http://localhost:4000') + '/api/scratch-manifest?name=x')
check('scratch-manifest without a session -> 401', noAuth.status === 401)
const eu = await apiLogin('enduser')
const euResp = await fetch((process.env.CONSOLE_BASE || 'http://localhost:4000') + '/api/scratch-manifest?name=x', {
  headers: { authorization: 'Bearer ' + eu.token } })
check('end-user session -> 403 (builder surface)', euResp.status === 403)
const alice = await apiLogin('alice')
const unnamed = await fetch((process.env.CONSOLE_BASE || 'http://localhost:4000') + '/api/scratch-manifest?name=%20', {
  headers: { authorization: 'Bearer ' + alice.token } })
check('blank agent name -> 400', unnamed.status === 400)
const m = await authedGet('/scratch-manifest?name=inventory-helper', alice)
check('manifest is single-digit and nothing pending', m.ok && m.files.length <= 9 && m.pending.length === 0)
const paths = (m.files || []).map(f => f.path)
check('manifest = gates + baseline dataset + top-level README, no code/spec',
  ['README.md', '.github/workflows/eval.yml', '.github/workflows/tests.yml', '.github/workflows/compliance.yml',
   'gates/platform-gates.json', 'agentcore/datasets/golden.jsonl'].every(p => paths.includes(p)) &&
  !paths.some(p => p.startsWith('app/') || p === 'CLAUDE.md' || p === 'SPEC.md'))

// --- UI: alice walks the scratch door ---
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await uiLogin(page, 'alice')
await page.locator('.nav[data-shellnav="build"]').click()
await page.waitForSelector('[data-door="scratch"]')
await page.locator('[data-door="scratch"]').click()
await page.waitForSelector('#scname')
const panel = await page.locator('main').textContent()
check('scratch door opens the minimal form (not a placeholder)',
  (await page.locator('#scname').count()) === 1 && !panel.includes('being wired'))
check('domain comes from the session, gates named all-on',
  panel.includes('customer-support') && panel.includes('eval · tests · compliance'))
check('preview asks for a name first', panel.includes('Name your agent'))

// type a name -> debounced live preview matches the manifest API
await page.locator('#scname').fill('inventory-helper')
await page.waitForFunction(() => (document.getElementById('scprev')?.textContent || '').includes('README.md'), { timeout: 10000 })
const prev = await page.locator('#scprev').textContent()
check('live preview lists the gate pack files',
  ['.github/workflows/eval.yml', 'gates/platform-gates.json', 'agentcore/datasets/golden.jsonl', 'README.md']
    .every(p => prev.includes(p)))
check(`preview count matches the manifest API (${m.files.length} files)`, prev.includes(`${m.files.length}`))
await page.screenshot({ path: SHOT_DIR + 'j-t10-scratch-door.png', fullPage: true })

// export to a demo SSO org (no GitHub call; staging + local commit are real)
await page.locator('#scghorg').selectOption('acme-domain-support')
await page.locator('#scexp').click()
await page.waitForFunction(() => document.getElementById('sces')?.textContent.includes('SSO demo org'), { timeout: 20000 })
const exp = await page.locator('#sces').textContent()
check('MINIMAL export stages the gate pack (demo org, honest wording)', exp.includes('gate pack'))

// staged repo on disk: exactly the manifest, nothing else
const fsx = await import('node:fs')
const staged = new URL('../.export-staging/inventory-helper/', import.meta.url).pathname
check('staged export on disk carries the gate pack', paths.every(p => fsx.existsSync(staged + p)))
const gitFiles = (await import('node:child_process')).execSync('git ls-files', { cwd: staged, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
check(`staged repo is single-digit on disk (${gitFiles.length} committed files)`,
  gitFiles.length === m.files.length && gitFiles.length <= 9)
const readme = fsx.readFileSync(staged + 'README.md', 'utf8')
check('README is the one-page gate rules and calls the seeded dataset a placeholder',
  ['eval.yml', 'tests.yml', 'compliance.yml', 'threshold', 'Placeholders'].every(s => readme.includes(s)))

// hygiene: no mock/simulated wording on the rendered door
const dom = (await page.locator('main').textContent()).toLowerCase()
check('no mock/simulated wording on the rendered door', !dom.includes('mock') && !dom.includes('simulated'))

// back to the landing
await page.locator('#doorback').click()
await page.waitForSelector('[data-door]')
check('back returns to the three-door landing', (await page.locator('[data-door]').count()) === 3)

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
