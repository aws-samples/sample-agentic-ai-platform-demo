import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T16 smoke: ML Platform model lineage in the AI Registry (SPEC WS-E, testplan T3).
// A fine-tuned model registered from the ML Platform renders its provenance
// chain — training job -> registry entry -> consuming agent — in the registry
// drawer. Consumers are server-derived from each project's effective model
// (same resolution the cost page uses), so the two surfaces always agree.
// Run: node e2e/smoke-lineage.mjs   (expects console server on :4000)
import { chromium } from 'playwright'
import { apiLogin, uiLogin, authedGet } from './login.mjs'

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

const FT_ID = 'acme.triage-ft-8b'

// --- API: the fine-tuned model is a registry entry with lineage content ---
const models = (await apiGet('/registry?type=Model')).entries
const ft = models.find(e => e.id === FT_ID)
check('fine-tuned model has a Model registry entry (self-seeds from catalog)', !!ft)
const lin = ft?.resolved?.content?.lineage
check('entry carries ML Platform lineage (training job + base model + dataset + eval report)',
  !!lin && /sagemaker/.test(lin.trainingJob || '') && !!lin.baseModel && !!lin.dataset && !!lin.evalReport)
check('lineage base model is itself a registered model', models.some(e => e.id === lin?.baseModel))
check('entry is federated with the ML Platform as owner',
  ft?.governanceMode === 'federated' && /ML Platform/i.test(ft?.domainOwner || ''))

// --- API: consumer derivation (registry "used by" == effective model per project) ---
check('every Model entry carries a consumers array', models.every(e => Array.isArray(e.consumers)))
const costs = await apiGet('/costs')
const sonnet = models.find(e => e.id === 'global.anthropic.claude-sonnet-5')
if (!sonnet || !costs.perAgent?.length) {
  skip('consumers agree with cost attribution', 'no recorded usage on this clone')
} else {
  // Reconciliation (T25): EVERY project the cost ledger attributes to a model
  // must appear in that model's registry consumers — consumers are the union
  // of directory scan and usage ledger, so this holds regardless of whether
  // the project has a local dir or which tests ran first (order-independence).
  let ok = true
  const attributed = []
  for (const a of costs.perAgent) {
    const m = models.find(e => e.id === a.model)
    attributed.push(a.project)
    if (!m || !(m.consumers || []).some(c => c.project === a.project)) {
      ok = false
      console.log(`      violation: ${a.project} -> ${a.model} not in consumers`)
    }
  }
  check(`cost-attributed projects appear in their model's consumers (${attributed.join(', ')})`, ok)
}

// --- UI: admin sees the lineage panel in the registry drawer ---
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'melanie')
  await page.locator('.nav[data-shellnav="registry"]').click()
  await page.waitForSelector('.regrow')
  await page.locator('[data-regtype="Model"]').click()
  await page.waitForTimeout(300)
  await page.locator(`.regrow[data-regid="${FT_ID}"]`).click()
  await page.waitForSelector('#regdrawerwrap .card')
  const drawer = await page.locator('#regdrawerwrap').textContent()
  check('drawer shows the ML Platform lineage section', drawer.includes('ML Platform lineage'))
  check('drawer renders the provenance chain (training job → registry → agent)',
    drawer.includes('training job → registry → agent') && drawer.includes('sagemaker') && drawer.includes('Bedrock Custom Model Import'))
  check('drawer shows base model, dataset and eval report',
    drawer.includes('google.gemma-4-31b') && drawer.includes('12,400 labeled tickets') && drawer.includes('91.4%'))
  check('drawer has a Used by section', drawer.includes('Used by'))
  await page.screenshot({ path: SHOT_DIR + 't16b-model-lineage.png', fullPage: true })

  // A vendor model without lineage gets no lineage panel, still gets Used by.
  await page.locator('#regdrawerclose').click()
  await page.locator('.regrow[data-regid="global.anthropic.claude-sonnet-5"]').click()
  await page.waitForSelector('#regdrawerwrap .card')
  const vendorDrawer = await page.locator('#regdrawerwrap').textContent()
  check('vendor model drawer has Used by but no lineage panel',
    vendorDrawer.includes('Used by') && !vendorDrawer.includes('ML Platform lineage'))

  // --- Builder: Model entries stay read-only; lineage still visible (discovery) ---
  await uiLogin(page, 'alice')
  await page.locator('.nav[data-shellnav="registry"]').click()
  await page.waitForSelector('.regrow')
  await page.locator('[data-regtype="Model"]').click()
  await page.waitForTimeout(300)
  await page.locator(`.regrow[data-regid="${FT_ID}"]`).click()
  await page.waitForSelector('#regdrawerwrap .card')
  const builderDrawer = await page.locator('#regdrawerwrap').textContent()
  check('builder sees the lineage (discovery surface)', builderDrawer.includes('ML Platform lineage'))
  check('builder stays read-only on the model entry', (await page.locator('#regproposeform').count()) === 0)

  // Builder consumers are domain-scoped: alice must not see foreign-domain projects.
  const aliceModels = (await authedGet('/registry?type=Model', await apiLogin('alice'))).entries
  const aliceSonnet = aliceModels.find(e => e.id === 'global.anthropic.claude-sonnet-5')
  check('builder consumer list only shows own-domain / explicitly-shared projects (default-deny)',
    (aliceSonnet?.consumers || []).every(c => c.domain === 'shared' || c.domain === 'customer-support'))
} finally {
  await browser.close()
}

console.log(failures === 0 ? `\nALL CHECKS PASSED${skips ? ` (${skips} skipped)` : ''}` : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
