// Task 07/08 smoke: canonical observability API + API-first evaluation packs
// rendered in the browser. Expects console server on CONSOLE_BASE or :4000.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin, openAdminOps } from './login.mjs'

const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
mkdirSync(SHOT_DIR, { recursive: true })

let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const admin = await apiLogin('melanie')
const fleet = await authedGet('/fleet', admin)
const target = (fleet.agents || []).find(a => a.project)
check('Precondition: live fleet exposes at least one project-backed agent', !!target)
if (!target) process.exit(1)
const AGENT = target.project
const DOMAIN = target.domain || 'platform'

const obs = await authedGet('/obs/metrics?scope=fleet&scopeId=all&metrics=invocations,latency,errors,ttft&window=7d&granularity=1d', admin)
check('Task 07 canonical obs endpoint returns labeled data source', obs.ok === true && ['mock', 'cloudwatch'].includes(obs.source))
check('Task 07 canonical obs metrics include invocations + latency', !!obs.series?.invocations && !!obs.series?.latency)
check('Task 07 fallback is honest when not CloudWatch', obs.source === 'cloudwatch' || obs.backend === 'mock')

const ds = await authedPost('/eval/datasets', {
  name: 'Task 07/08 browser smoke dataset',
  project: AGENT,
  domain: DOMAIN,
  agentRuntimeId: AGENT,
  cases: [
    {
      id: 'TC-RETURNS',
      category: 'policy',
      input: 'Can I return opened electronics?',
      expected_behavior: 'allow',
      expected_output_contains: ['14 days', 'restocking'],
      expected_output_not_contains: ['guaranteed full refund'],
      must_have_facts: ['opened electronics'],
      replay_output: 'Opened electronics can be returned within 14 days; a restocking fee may apply.',
    },
    {
      id: 'TC-ORDER',
      category: 'grounding',
      input: 'Where is my order?',
      expected_output_contains: ['order number'],
      expected_output_not_contains: ['delivered yesterday'],
      replay_output: 'Please share your order number so I can look up the current status.',
    },
  ],
}, admin)
check('Task 08 creates a real platform dataset record', ds.ok === true && ds.dataset?.caseCount === 2)

const smoke = await authedPost('/eval/run', { datasetId: ds.dataset.id, agentRuntimeId: AGENT, pack: 'smoke' }, admin)
check('Task 08 Smoke pack runs deterministic checks', smoke.ok === true && smoke.run.status === 'completed')
check('Task 08 Smoke gate passes with replay outputs', smoke.run.gate?.decision === 'PASS')

const standard = await authedPost('/eval/run', { datasetId: ds.dataset.id, agentRuntimeId: AGENT, pack: 'standard' }, admin)
check('Task 08 Standard pack is explicit when backend is not configured', standard.ok === true && standard.run.status === 'not_configured')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
await uiLogin(page, 'melanie')

await openAdminOps(page, 'observability')
await page.waitForSelector('#obsbox .item', { timeout: 15000 })
const obsText = await page.locator('#obsbox').textContent()
check('Browser: Observability renders canonical metric labels', /agent\.latency|CloudWatch|offline demo fallback/.test(obsText))
check('Browser: Observability renders metric cards', await page.locator('#obsbox .item').count() >= 6)
await page.screenshot({ path: SHOT_DIR + 'task-07-observability.png', fullPage: true })

await openAdminOps(page, 'fleet')
await page.waitForSelector(`[data-agent="${AGENT}"]`, { timeout: 15000 })
await page.locator(`[data-agent="${AGENT}"]`).click()
await page.waitForSelector('#epbox', { timeout: 15000 })
await page.waitForFunction(() => document.querySelector('#epbox')?.textContent?.includes('Evaluation packs'))
const evalText = await page.locator('#epbox').textContent()
check('Browser: agent detail shows API-first evaluation packs', evalText.includes('Evaluation packs') && evalText.includes('Dataset record'))
await page.locator('#epbox .eprun[data-pack="smoke"]').click()
await page.waitForFunction(() => document.querySelector('#epstatus')?.textContent?.includes('gate'), null, { timeout: 15000 })
const runText = await page.locator('#epstatus').textContent()
check('Browser: Smoke pack can be launched from UI and shows gate', runText.includes('smoke pack') && runText.includes('gate'))
await page.screenshot({ path: SHOT_DIR + 'task-08-eval-packs.png', fullPage: true })

await browser.close()

if (failures) {
  console.error(`${failures} checks failed`)
  process.exit(1)
}
