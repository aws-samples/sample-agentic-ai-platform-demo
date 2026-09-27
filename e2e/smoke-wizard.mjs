import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T11 smoke: Build wizard upgrades — model parameter controls, built-in tools
// concept (visible [simulated] chip), APPROVED MCP/A2A picks (governance-gated),
// external integration info panel on deployed agents; plus regression of the
// existing wizard flow (compose -> generate -> validate -> chat -> eval card ->
// GitHub export to a mock org) and the Observability view.
// Counts derive from the APIs the views render from (falsifiable, not vacuous).
// Run: node e2e/smoke-wizard.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard, openAdminOps } from './login.mjs'

const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0, skips = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const skip = (name, reason) => { console.log(`SKIP  ${name} — ${reason}`); skips++ }

// Independent sources of truth
const admin = await apiLogin('melanie')
const mcpAll = (await authedGet('/registry?type=MCPServer', admin)).entries || []
const a2aAll = (await authedGet('/registry?type=A2AAgent', admin)).entries || []
const picks = await authedGet('/wizard-picks', admin)
const gatewayModels = picks.models || []
const testModel = gatewayModels.find(m => /anthropic\.claude-haiku-4-5/i.test(m.id))
  || gatewayModels.find(m => /anthropic\.claude/i.test(m.id))
  || gatewayModels[0]
const approvedMcp = picks.mcpServers || []
const approvedA2a = picks.a2aAgents || []
// The step-3 chat below runs AS ALICE — pick the deployed agent from HER
// fleet so guardProject (G18 default-deny) can't 404 the chat when the AWS
// fleet list happens to sort a platform-domain agent first (the admin fleet's
// order is not stable). Admin sees a superset, so the same agent also works
// for the admin-side integration-panel section.
const aliceApi = await apiLogin('alice')
const fleet = (await authedGet('/fleet', aliceApi)).agents || []
const deployed = fleet.find(a => a.project && a.status === 'READY')

const PROJECT = 't11wiz' + Date.now().toString(36).slice(-4)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
// --- Builder persona: wizard step 1 (blueprints unchanged) ---
await uiLogin(page, 'alice')
await openBuildWizard(page)
await page.waitForSelector('[data-bp]')
check('step 1 still shows blueprint cards', (await page.locator('[data-bp]').count()) >= 2)
await page.locator('[data-bp="chat-assistant"]').click()
await page.locator('#n1').click()
await page.waitForSelector('#pname')

// --- Step 2: NEW model parameter controls ---
check('step 2 has temperature control', (await page.locator('#mp-temp').count()) === 1)
check('step 2 has max output tokens control', (await page.locator('#mp-maxtok').count()) === 1)
// gateway-config.json is account-specific and NOT committed: a fresh clone runs
// in catalog mode. When a gateway IS configured, every discovered model must
// carry its routing info; otherwise the catalog fallback must still fill picks.
if (picks.modelSource === 'gateway') {
  check('wizard-picks returns gateway-discovered models',
    gatewayModels.length > 0 && gatewayModels.every(m => m.gatewayId && m.region))
} else {
  check('wizard-picks falls back to catalog models when no gateway is configured',
    picks.modelSource === 'catalog' && gatewayModels.length > 0)
}
await page.fill('#pname', PROJECT)
await page.fill('#persona', 'You are a concise T11 wizard test agent.')
await page.selectOption('#model', testModel?.id || '')
await page.fill('#mp-temp', '0.2')
await page.fill('#mp-maxtok', '1024')
const prev1 = await page.locator('#prev').textContent()
check('live preview reflects model params', prev1.includes('temperature: 0.2') && prev1.includes('max_tokens: 1024'))

// --- Step 2: NEW built-in tools concept with visible illustrative chip ---
check('built-in tools section carries a visible [illustrative] chip',
  (await page.locator('.sec-h', { hasText: 'Built-in tools' }).locator('.chip', { hasText: 'illustrative' }).count()) === 1)
check('wizard step 2 carries no mock/simulated wording (D6)',
  !/mock|simulated/i.test(await page.locator('main').textContent()))
check('offers exactly 2 built-in tools (code interpreter + browser)',
  (await page.locator('[data-builtin]').count()) === 2)
await page.locator('[data-builtin="code_interpreter"]').click()
const prev2 = await page.locator('#prev').textContent()
check('preview reflects picked built-in tool', prev2.includes('code_interpreter'))

// --- Step 2: APPROVED MCP servers only (governance gate, exact count from API) ---
check(`wizard offers exactly ${approvedMcp.length} APPROVED MCP server(s) (of ${mcpAll.length} registered)`,
  (await page.locator('[data-mcpsrv]').count()) === approvedMcp.length)
check(`wizard offers exactly ${approvedA2a.length} APPROVED A2A agent(s) (of ${a2aAll.length} registered)`,
  (await page.locator('[data-a2apick]').count()) === approvedA2a.length)
if (approvedMcp.length) {
  await page.locator(`[data-mcpsrv="${approvedMcp[0].id}"]`).click()
  const prev3 = await page.locator('#prev').textContent()
  check('preview reflects picked MCP server', prev3.includes(approvedMcp[0].id))
} else skip('MCP pick reflected in preview', 'no APPROVED MCP servers')
await page.screenshot({ path: SHOT_DIR + 't11-wizard-step2.png', fullPage: true })

// --- Generate -> step 3 (existing flow regression) ---
await page.locator('#gen').click()
await page.waitForSelector('#eval-dataset', { timeout: 30000 })
check('generate lands on step 3 (Evaluation setup present, no Deploy button — GitHub-first per TLP-B8)',
  (await page.locator('#dep').count()) === 0)

// harness manifest recorded the new fields (server-side truth)
const detail = await authedPost('/agent-detail', { project: PROJECT }, admin)
check('harness records modelParams temperature=0.2', detail.modelParams?.temperature === 0.2)
check('harness records modelParams maxTokens=1024', detail.modelParams?.maxTokens === 1024)
check('harness records built-in tool pick', (detail.builtinTools || []).includes('code_interpreter'))
check('undeployed project has no integration panel data', detail.integration === null)

// The construct is not deployed: handoff must not offer a model-call acceptance test.
check('no Agent test is required before export', (await page.locator('#val').count()) === 0)

// --- Chat regression: fleet-chat coverage for a deployed agent lives in
// journey-user.mjs (fsend/fchat) since the wizard step-3 chat panel was
// removed (R-B10-02, GitHub-first: export/hand-off replaces in-wizard chat).

// --- Eval card regression (renders + dataset API responds) ---
check('optional evaluation setup renders on step 3', (await page.locator('#eval-dataset').count()) === 1)
const ds = await authedGet('/eval-dataset?project=' + PROJECT, admin)
check('eval-dataset API responds with presets for the new project', Array.isArray(ds.presets) && ds.presets.length >= 1)

// --- J-T5: export manifest preview (FULL preset) renders the CI gate contents ---
await page.waitForFunction(() => {
  const t = document.getElementById('expprev')?.textContent || ''
  return t && !t.includes('composing manifest')
}, null, { timeout: 30000 })
const prevTxt = await page.locator('#expprev').textContent()
check('export preview lists the three gate workflows',
  ['eval.yml', 'tests.yml', 'compliance.yml'].every(f => prevTxt.includes(`.github/workflows/${f}`)))
check('export preview carries the golden dataset and gate rules README',
  prevTxt.includes('agentcore/datasets/golden.jsonl') && prevTxt.includes('gates/README.md'))
const manifest = await authedPost('/export-manifest', {project:PROJECT,preset:'FULL',evaluation:{dataset:{source:'later'},evaluator:{type:'later'}}}, admin)
check(`export preview file count matches the manifest API (${(manifest.files || []).length})`,
  manifest.ok && prevTxt.includes(`${manifest.files.length}`) && manifest.pending.length === 0)

// --- GitHub export regression (SSO demo org — real code path, no external repo) ---
await page.selectOption('#ghorg', 'acme-platform')
await page.locator('#exp').click()
await page.waitForFunction(() => /repo created|export failed/.test(document.getElementById('es')?.textContent || ''), null, { timeout: 60000 })
const esTxt = await page.locator('#es').textContent()
check('export to demo org succeeds (repo staged + committed locally)', esTxt.includes('repo created (SSO demo org)'))
// J-T5: the staged FULL export on disk actually carries the gate files
const fsx = await import('node:fs')
const staged = new URL(`../.export-staging/${PROJECT}/`, import.meta.url).pathname
check('staged export carries workflows + gate runners + contract + README on disk',
  ['.github/workflows/eval.yml', '.github/workflows/tests.yml', '.github/workflows/compliance.yml',
   'gates/run-eval.mjs', 'gates/run-tests.mjs', 'gates/check-guardrails.mjs',
   'gates/platform-gates.json', 'gates/README.md', 'agentcore/datasets/golden.jsonl', 'CLAUDE.md',
  ].every(f => fsx.existsSync(staged + f)))
await page.screenshot({ path: SHOT_DIR + 't11-wizard-step3.png', fullPage: true })

// --- NEW: external integration panel on a deployed fleet agent (admin) ---
if (deployed) {
  await uiLogin(page, 'melanie')
  await openAdminOps(page, 'fleet')
  await page.waitForSelector('[data-agent]')
  await page.locator(`[data-agent="${deployed.project}"]`).click()
  // The integration panel renders only after loadDetail()'s /api/agent-detail
  // fetch resolves, and only if the agent has LOCAL deploy state (the server
  // reads agentcore/.cli/deployed-state.json — gitignored, so absent on a
  // fresh clone until an invoke restores it from AWS). The step-3 chat above
  // ran against this same agent, which restores that state — so the readiness
  // signal is "detail box finished loading" (spinner gone), after which
  // #integration must be present. A bare 30s wait on #integration hid the
  // real failure (integration=null renders nothing, ever).
  await page.waitForFunction(() => {
    const b = document.getElementById('detailbox')
    return b && !b.querySelector('.spin')
  }, null, { timeout: 30000 })
  const intApi = (await authedPost('/agent-detail', { project: deployed.project }, admin)).integration
  check(`agent-detail reports deploy state for ${deployed.project} (integration non-null)`, !!intApi)
  const intRendered = (await page.locator('#integration').count()) === 1
  check('integration panel renders once detail is loaded', intRendered)
  if (intApi && intRendered) {
    const intTxt = await page.locator('#integration').textContent()
    check('integration panel shows the real invocation URL from deploy state',
      intTxt.includes(intApi.invocationUrl))
    check('integration panel states auth requirements', intTxt.includes('Inbound auth'))
    check('integration panel has a copy-ready boto3 snippet with the real runtime ARN',
      (await page.locator('#intsnippet').textContent()).includes(intApi.runtimeArn))
    check('integration panel has a Copy button', (await page.locator('#intcopy').count()) === 1)
    await page.screenshot({ path: SHOT_DIR + 't11-integration-panel.png', fullPage: true })
  } else {
    check('integration panel content checks (unreachable: deploy state missing)', false)
  }
} else skip('integration panel', 'no READY deployed agent in fleet')

// --- Observability regression (aggregate layer charts + view loads) ---
await uiLogin(page, 'melanie')
await openAdminOps(page, 'observability')
await page.waitForSelector('#obsbox .item', { timeout: 30000 })  // synthetic metrics render instantly
const obsTxt = await page.locator('#main').textContent()
check('observability shows the plain-language metric groups (Service health/Model performance/Agent reasoning/Cost & usage)', ['Service health', 'Model performance', 'Agent reasoning', 'Cost & usage'].every(l => obsTxt.includes(l)))
check('observability keeps the Langfuse backend reference', obsTxt.includes('Langfuse'))

// --- Cleanup: remove the generated (never deployed) project ---
const fs = await import('node:fs')
const genDir = new URL(`../domain-examples/generated/${PROJECT}/`, import.meta.url).pathname
fs.rmSync(genDir, { recursive: true, force: true })
const stageDir = new URL(`../.export-staging/${PROJECT}/`, import.meta.url).pathname
fs.rmSync(stageDir, { recursive: true, force: true })
console.log(`cleaned up generated project ${PROJECT}`)

await browser.close()
console.log(`\n${failures} failure(s), ${skips} skip(s)`)
process.exit(failures ? 1 : 0)
