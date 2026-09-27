import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T15 smoke: blueprint expansion (SPEC WS-D, testplan T1/T2/S4).
// T1 — blueprintOptions carry Google ADK + EKS; template instances exercise
//      non-AgentCore targets (>=1 EKS, >=1 Lambda, >=1 Fargate) and >=3
//      non-Strands frameworks.
// T2 — framework × hosting compatibility matrix enforced in the wizard
//      (invalid combos unselectable, with reason) AND server-side on /generate.
// S4/R3/D3 — blueprints join the immutable-version + semver + pin mechanism:
//      bump a blueprint version -> pinned agents unaffected (upgrade badge, not
//      forced rebuild), new composes resolve the new version.
// Run: node e2e/smoke-blueprints.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard, openAdminOps } from './login.mjs'

const admin = await apiLogin('melanie')
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0, skips = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const skip = (name, reason) => { console.log(`SKIP  ${name} — ${reason}`); skips++ }
const apiGet = p => authedGet(p, admin)
const apiPost = (p, body) => authedPost(p, body, admin)

// --- T1: options + instances (from the APIs the wizard renders from) ---
const catalog = await apiGet('/catalog')
const bo = catalog.blueprintOptions || {}
check('blueprintOptions.framework includes Google ADK (5 frameworks)',
  (bo.framework || []).includes('Google ADK') && (bo.framework || []).length >= 5)
check('blueprintOptions.deployTarget includes Amazon EKS',
  (bo.deployTarget || []).includes('Amazon EKS'))

const blueprints = await apiGet('/blueprints')
const targets = t => blueprints.filter(b => b.template.deployTarget === t).length
check('>=1 template instance on Amazon EKS', targets('Amazon EKS') >= 1)
check('>=1 template instance on AWS Lambda', targets('AWS Lambda') >= 1)
check('>=1 template instance on ECS Fargate', targets('ECS Fargate') >= 1)
const nonStrands = [...new Set(blueprints.map(b => b.template.framework))].filter(f => f !== 'Strands')
check(`>=3 non-Strands frameworks among instances (${nonStrands.join(', ')})`, nonStrands.length >= 3)
check('a Google ADK template instance exists',
  blueprints.some(b => b.template.framework === 'Google ADK'))

// --- R3: every published blueprint is a versioned registry entry ---
const regBps = (await apiGet('/registry?type=Blueprint')).entries
check(`registry has one Blueprint entry per catalog blueprint (${blueprints.length})`,
  regBps.length === blueprints.length &&
  blueprints.every(b => regBps.some(e => e.id === b.id && e.resolved?.status === 'APPROVED')))
check('every /api/blueprints row carries its registry-resolved version',
  blueprints.every(b => !!b.version))

// --- T2 (UI): matrix enforced in the wizard, invalid combos unselectable + reason ---
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await uiLogin(page, 'alice')
await openBuildWizard(page)
await page.waitForSelector('[data-bp]')
check('step 1 renders the two new template cards (ADK + OpenAI ops)',
  (await page.locator('[data-bp="adk-data-agent"]').count()) === 1 &&
  (await page.locator('[data-bp="openai-ops-agent"]').count()) === 1)
check('blueprint cards carry their registry version chip',
  (await page.locator('[data-bp="chat-assistant"] .chip', { hasText: 'v1.' }).count()) >= 1)
await page.locator('[data-bp="chat-assistant"]').click()
await page.locator('#n1').click()
await page.waitForSelector('#pname')
check('step 2 has framework + hosting selects', (await page.locator('#framework').count()) === 1 &&
  (await page.locator('#deployTarget').count()) === 1)
await page.selectOption('#framework', 'Claude Agent SDK')
await page.waitForSelector('#compatnote')
check('incompatible hosting option is unselectable (Claude Agent SDK × AWS Lambda disabled)',
  await page.locator('#deployTarget option', { hasText: 'AWS Lambda' }).isDisabled())
check('the reason is shown to the user',
  (await page.locator('#compatnote').textContent()).includes('15-minute'))
await page.screenshot({ path: SHOT_DIR + 't15-compat-matrix.png', fullPage: true })
await page.selectOption('#framework', 'Strands')
await page.waitForTimeout(200)
check('compatible pairing has no disabled options for Strands',
  (await page.locator('#deployTarget option[disabled]').count()) === 0)

// --- T2 (server): a direct API call can't slip past the matrix ---
const badGen = await apiPost('/generate', {
  blueprint: 'chat-assistant', projectName: 't15badcombo',
  persona: 'x', framework: 'Claude Agent SDK', deployTarget: 'AWS Lambda',
})
check('server rejects an incompatible framework × hosting pairing on /generate',
  badGen.error && /not a supported pairing/.test(badGen.error))

// --- Registry auto-check: an incompatible Blueprint version bounces at submit ---
// Uses a throwaway Blueprint entry; removed in finally (published blueprints
// re-seed pristine from catalog.json, so removal is always safe for them too).
const TMP_BP = 't15-tmp-blueprint'
try {
  const prop = await apiPost('/registry-propose', {
    id: TMP_BP, type: 'Blueprint', name: 'T15 temp blueprint',
    content: { template: { framework: 'LangGraph', deployTarget: 'AWS Lambda' } },
  })
  check('can propose a Blueprint version (typed registry entry)', prop.ok === true)
  const sub = await apiPost('/registry-submit', { id: TMP_BP, semver: '1.0.0' })
  check('auto-check bounces an incompatible framework × hosting blueprint back to DRAFT',
    sub.ok === true && sub.passed === false &&
    (sub.reasons || []).some(r => /15-minute/.test(r)))
} finally {
  await apiPost('/registry-remove', { id: TMP_BP })
}

// --- S4: version bump — pinned agents unaffected (badge only), new resolves move ---
const harnessPath = new URL('../domain-examples/generated/supportdesk/domain-harness.json', import.meta.url).pathname
const harnessExists = existsSync(harnessPath)
const harnessRaw = harnessExists ? readFileSync(harnessPath, 'utf8') : null
try {
  if (harnessExists) {
    // supportdesk predates T15 pinning — pin it at 1.0.0 for the drill, restore after.
    const h = JSON.parse(harnessRaw)
    h.blueprintVersion = '1.0.0'
    writeFileSync(harnessPath, JSON.stringify(h, null, 2))
  }
  const prop = await apiPost('/registry-propose', {
    id: 'chat-assistant', type: 'Blueprint', name: 'Chat Assistant',
    changelog: 'T15 e2e: bump to exercise the pin mechanism (S4).',
    suggestedBump: 'minor',
    content: { template: blueprints.find(b => b.id === 'chat-assistant').template },
  })
  check('platform can propose a new version on a published blueprint', prop.ok === true && prop.version?.semver === '1.1.0')
  const sub = await apiPost('/registry-submit', { id: 'chat-assistant', semver: '1.1.0' })
  check('compatible blueprint version passes auto-checks into IN_REVIEW', sub.ok === true && sub.passed === true)
  const dec = await apiPost('/registry-decide', { id: 'chat-assistant', semver: '1.1.0', decision: 'approve' })
  check('approving advances the blueprint defaultVersion to 1.1.0',
    dec.ok === true && dec.entry?.defaultVersion === '1.1.0')
  const after = await apiGet('/blueprints')
  check('new composes resolve the new version (blueprint card now v1.1.0)',
    after.find(b => b.id === 'chat-assistant')?.version === '1.1.0')
  if (harnessExists) {
    const fleet = (await apiGet('/fleet')).agents || []
    const sd = fleet.find(a => a.project === 'supportdesk')
    if (sd) {
      check('pinned agent is NOT rebuilt — it keeps v1.0.0 and gets an upgrade hint',
        sd.blueprintPin?.pinned === '1.0.0' && sd.blueprintUpgrade?.to === '1.1.0')
      await page.goto(process.env.CONSOLE_BASE || 'http://localhost:4000')
      await uiLogin(page, 'melanie')
      await openAdminOps(page, 'fleet')
      await page.waitForSelector('[data-bpupgrade]', { timeout: 15000 }).catch(() => {})
      const fleetTxt = await page.locator('#fleetbox').textContent()
      check('Operate card shows the "blueprint upgrade available" badge',
        fleetTxt.includes('blueprint upgrade available'))
      await page.screenshot({ path: SHOT_DIR + 't15-blueprint-upgrade-badge.png', fullPage: true })
    } else skip('pinned-agent badge checks', 'supportdesk not in the live fleet')
  } else skip('pinned-agent badge checks', 'supportdesk harness not present (fresh clone — gitignored generated/)')
} finally {
  if (harnessExists) writeFileSync(harnessPath, harnessRaw)
  // Published blueprints re-seed pristine (v1.0.0 APPROVED) from catalog.json
  // after removal — this restores baseline no matter what happened above.
  await apiPost('/registry-remove', { id: 'chat-assistant' })
  const restored = (await apiGet('/registry?type=Blueprint')).entries.find(e => e.id === 'chat-assistant')
  check('chat-assistant blueprint restored to pristine v1.0.0 (suite stays order-independent)',
    restored?.defaultVersion === '1.0.0' && restored?.resolved?.status === 'APPROVED')
}

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
