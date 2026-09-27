import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T13 journey: Domain Builder — the full build-an-agent flow:
// compose -> validate -> deploy (reuses the T12-deployed supportdesk runtime,
// as the PRD allows for speed; deploy state asserted from real fleet data) ->
// chat (real streaming) -> eval (REAL golden-dataset run, scored) -> export
// (SSO demo org: the real export code path without creating an external repo).
// Counts derive from the APIs the views render from (falsifiable).
// Run: node e2e/journey-builder.mjs   (expects console server on :4000; the
// eval stage waits ~3 min for trace ingestion, total runtime ~6 min)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const admin = await apiLogin('melanie')
const apiGet = p => authedGet(p, admin)
const alice = await apiLogin('alice')

// Independent sources of truth
const blueprints = await apiGet('/blueprints')
const approvedMcp = (await apiGet('/wizard-picks')).mcpServers || []
// The chat/eval target must be an agent the ACTING persona (alice, Support
// builder) can legitimately invoke — fetch the fleet AS alice so guardProject
// reality (G18 default-deny) is baked into the selection. The admin fleet's
// first READY row can be a platform-domain agent alice is CORRECTLY denied on.
let fleet = (await authedGet('/fleet', alice)).agents || []
let deployed = fleet.find(a => a.project && a.status === 'READY')
if (!deployed) {
  // Fresh clone: the T12-era supportdesk runtime may be live in AWS while its
  // gitignored local project dir + deploy state (domain-examples/generated/,
  // agentcore/.cli/) are absent — the fleet row then has no `project`. Self-
  // seed through the product's own paths: regenerate the project via the same
  // wizard API, then a warm-up invoke lets the server rebuild deploy state
  // from the live runtime (restoreDeployStateFromAws). If no live runtime
  // exists at all, run the build flow's real deploy step.
  console.log('no READY project agent visible to alice — self-seeding supportdesk (fresh-clone T12 state missing)')
  const gen = await authedPost('/generate', {
    blueprint: 'chat-assistant', projectName: 'supportdesk',
    persona: 'Customer support assistant for order status, returns and shipping questions',
  }, alice)
  // "already exists" = the local project + deploy state survived; reuse it.
  if (gen.error && !/already exists/i.test(gen.error)) {
    console.log('FATAL: seeding generate failed: ' + gen.error); process.exit(1)
  }
  const warm = await authedPost('/invoke', { project: 'supportdesk', prompt: 'Reply with exactly: OK' }, alice)
  if (warm.ok === false && /isn't deployed/.test(warm.output || '')) {
    console.log('no live supportdesk runtime in AWS — running a real deploy (this takes minutes)')
    // fetch can hit undici's header timeout on a >5min deploy; the server keeps
    // deploying regardless, so on error poll for the deploy state instead.
    const dep = await authedPost('/deploy', { project: 'supportdesk' }, alice).catch(e => ({ ok: false, output: String(e) }))
    if (!dep.ok) {
      console.log('deploy call returned/failed early — polling deploy state. Last output:\n' + String(dep.output || '').slice(-400))
      for (let i = 0; i < 60; i++) {
        if ((await authedPost('/agent-detail', { project: 'supportdesk' }, admin)).integration) break
        await new Promise(s => setTimeout(s, 10000))
      }
    }
  }
  fleet = (await authedGet('/fleet', alice)).agents || []
  deployed = fleet.find(a => a.project && a.status === 'READY')
}
check('a READY deployed agent VISIBLE TO ALICE exists for deploy/chat/eval (self-seeded if a fresh clone lost the T12 state)', !!deployed)
if (!deployed) {
  console.log('\nFATAL: full build flow needs a deployed runtime in alice\'s domain (self-seeding failed).')
  process.exit(1)
}

const PROJECT = 't13build' + Date.now().toString(36).slice(-4)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await uiLogin(page, 'alice')

// --- Builder sees the paved road: blueprints inside the Build wizard (TLP-B2
// v2: builders have no Blueprints nav item; the same blueprint data renders as
// [data-bp] cards on wizard step 1 "Choose Blueprint") ---
await openBuildWizard(page)
await page.waitForSelector('[data-bp]')
check(`Build wizard step 1 shows exactly ${blueprints.length} blueprint cards (from /api/blueprints)`,
  blueprints.length >= 2 &&
  (await page.locator('[data-bp]').count()) === blueprints.length)

// --- Compose: step 1 pick blueprint, step 2 configure ---
await page.locator('[data-bp="chat-assistant"]').click()
await page.locator('#n1').click()
await page.waitForSelector('#pname')
await page.fill('#pname', PROJECT)
await page.fill('#persona', 'You are a concise T13 journey test agent for enterprise IT questions.')
await page.selectOption('#model', 'global.anthropic.claude-haiku-4-5-20251001-v1:0')
await page.fill('#mp-temp', '0.3')
if (approvedMcp.length) {
  await page.locator(`[data-mcpsrv="${approvedMcp[0].id}"]`).click()
  check(`APPROVED MCP pick (${approvedMcp[0].id}) lands in the harness preview`,
    (await page.locator('#prev').textContent()).includes(approvedMcp[0].id))
} else {
  check('at least one APPROVED MCP server offered to the builder', false)
}
await page.screenshot({ path: SHOT_DIR + 't13-builder-compose.png', fullPage: true })

// --- Generate -> step 3 ---
await page.locator('#gen').click()
await page.waitForSelector('#eval-dataset', { timeout: 30000 })
check('generate lands on step 3 (Evaluation setup present, no Deploy button — GitHub-first per TLP-B8)',
  (await page.locator('#dep').count()) === 0)

// The construct is not deployed: handoff must not offer a model-call acceptance test.
check('no Agent test is required before export', (await page.locator('#val').count()) === 0)

// --- Deploy: reuse the T12 runtime (PRD-sanctioned). Assert real deploy state. ---
const detail = await authedPost('/agent-detail', { project: deployed.project }, admin)
check(`deployed agent ${deployed.project} has a real runtime ARN in deploy state`,
  !!detail.integration && /arn:aws:bedrock-agentcore/.test(detail.integration.runtimeArn || ''))

// --- Chat: real streaming against the deployed agent, via the Fleet agent
// detail page (R-B10-02: wizard step-3 chat panel removed, GitHub-first;
// chat coverage moved to the Fleet detail view's #fmsg/#fsend/#fchat, reached
// right below via the same .wsopenagent drill-down used for eval). ---
await page.locator('.nav[data-shellnav="fleet"]').click()
await page.waitForSelector(`.wsopenagent[data-agent="${deployed.project}"]`, { timeout: 60000 })
await page.locator(`.wsopenagent[data-agent="${deployed.project}"]`).click()
await page.waitForSelector('#fmsg')
await page.fill('#fmsg', 'In one short sentence, how do I reset my VPN password?')
await page.locator('#fsend').click()
await page.waitForFunction(() => {
  const c = document.getElementById('fchat')
  if (!c || c.querySelector('.spin')) return false
  const msgs = c.querySelectorAll('.msg .body')
  const last = msgs[msgs.length - 1]
  return last && last.textContent.trim().length > 30
}, null, { timeout: 180000 })
const chatTxt = await page.locator('#fchat').textContent()
check('Fleet agent-detail chat returns a real streamed response',
  chatTxt.length > 60 && !chatTxt.includes('⚠') && !chatTxt.includes("isn't deployed"))
await page.screenshot({ path: SHOT_DIR + 't13-builder-chat.png', fullPage: true })

// --- Export: SSO demo org (real export code path, no external repo) ---
await page.locator('.nav[data-shellnav="build"]').click()
await page.waitForSelector('#ghorg', { timeout: 30000 })
await page.selectOption('#ghorg', 'acme-platform')
await page.locator('#exp').click()
await page.waitForFunction(() => /repo created|export failed/.test(document.getElementById('es')?.textContent || ''), null, { timeout: 60000 })
check('GitHub export succeeds against the SSO demo org',
  (await page.locator('#es').textContent()).includes('repo created (SSO demo org)'))

// --- Eval: REAL golden-dataset run on the deployed agent, through the UI ---
const runsBefore = ((await apiGet('/eval-runs?project=' + deployed.project)).runs || []).length
// TLP-B2 v2: builder fleet is the workspace Fleet tab with agent cards; the
// .wsopenagent button lands on the same old agent-detail view.
await page.locator('.nav[data-shellnav="fleet"]').click()
await page.waitForSelector(`.wsopenagent[data-agent="${deployed.project}"]`, { timeout: 60000 })
await page.locator(`.wsopenagent[data-agent="${deployed.project}"]`).click()
await page.waitForSelector('#gerun', { timeout: 30000 })
// #gerun starts enabled in the markup and only gets its `disabled` state set
// once loadGoldenEval()'s async /api/eval-dataset fetch resolves (render()
// fires wireGoldenEval() without awaiting it). Checking isDisabled() right
// after the selector resolves races that fetch, so wait for the dataset info
// panel to finish loading (spinner gone) before reading the button's state.
await page.waitForFunction(() => !document.getElementById('geinfo')?.textContent.includes('loading dataset'), null, { timeout: 30000 })
// --- T08 Promotion evidence: card renders on agent detail (evidence or honest empty state) ---
await page.waitForFunction(() => {
  const t = document.getElementById('pebox')?.textContent || ''
  return t && !t.includes('loading')
}, null, { timeout: 30000 })
check('promotion evidence card renders on agent detail (gate verdict or no-evidence state)',
  (await page.locator('#pecard').count()) === 1 &&
  /Gate (passed|not met)|No gate evidence yet/.test(await page.locator('#pebox').textContent()))
// Golden dataset is locally persisted state (not in the repo) — on a fresh
// clone the deployed agent has none yet. If so, load the curated one-click
// starter preset via the existing UI flow before proceeding, so this journey
// is self-contained.
if (await page.locator('#gerun').isDisabled()) {
  await page.waitForSelector('#gestarter', { timeout: 30000 })
  await page.locator('#gestarter').click()
  const saveResp = await page.waitForResponse(r => r.url().includes('/api/eval-dataset-save'), { timeout: 30000 }).catch(() => null)
  if (saveResp) {
    const body = await saveResp.json().catch(() => null)
    if (!body?.ok) console.log('eval-dataset-save response (for debugging if the branch stalls):', JSON.stringify(body))
  }
  await page.waitForFunction(() => !document.getElementById('gerun')?.disabled, null, { timeout: 30000 })
}
await page.waitForFunction(() => !document.getElementById('gerun')?.disabled, null, { timeout: 30000 })
await page.locator('#gerun').click()
await page.waitForSelector('#geconfirmrun')
await page.locator('#geconfirmrun').click()
// invoke each scenario -> wait ~3 min ingestion -> LLM-as-judge scoring
await page.waitForFunction(() =>
  (document.getElementById('geconfirm')?.textContent || '').includes('Evaluation complete'),
  null, { timeout: 480000 })
const runsAfter = (await apiGet('/eval-runs?project=' + deployed.project)).runs || []
const newest = runsAfter[0]
check(`eval produced a new saved run (${runsBefore} -> ${runsAfter.length})`,
  runsAfter.length === runsBefore + 1)
check('new run is done with every scenario scored',
  newest.status === 'done' && newest.scored === newest.total && newest.total >= 4)
check('new run has numeric aggregate scores (LLM-as-judge output)',
  newest.aggregate && Object.values(newest.aggregate).every(v => typeof v === 'number'))
// After a completed run, promotion evidence must show a gate verdict fed by it.
await page.waitForFunction(() => /Gate (passed|not met)/.test(document.getElementById('pebox')?.textContent || ''), null, { timeout: 30000 })
const peTxt = await page.locator('#pebox').textContent()
check('promotion evidence shows a gate verdict fed by the completed run',
  /Gate (passed|not met)/.test(peTxt) && peTxt.includes('scenarios scored'))
await page.screenshot({ path: SHOT_DIR + 't13-builder-eval.png', fullPage: true })

// --- Cleanup: remove the generated (never deployed) project + export staging ---
const fs = await import('node:fs')
fs.rmSync(new URL(`../domain-examples/generated/${PROJECT}/`, import.meta.url).pathname, { recursive: true, force: true })
fs.rmSync(new URL(`../.export-staging/${PROJECT}/`, import.meta.url).pathname, { recursive: true, force: true })
console.log(`cleaned up generated project ${PROJECT}`)

await browser.close()
console.log(`\n${failures} failure(s)`)
process.exit(failures ? 1 : 0)
