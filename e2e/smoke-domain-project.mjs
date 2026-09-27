// G14 smoke: the Domain <-> Project relation made explicit.
// Domain = governance boundary; Project = delivery unit inside exactly ONE
// domain. Creation paths resolve the owning domain from the server-side
// session only — a client-supplied domain field is ignored (R-001: no
// null-domain project ever exists). Drill-down pages carry a
// Domain › Project › Agent breadcrumb wired to the real objects.
// Run: node e2e/smoke-domain-project.mjs   (expects console server on :4000)
import fs from 'node:fs'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin, openProject } from './login.mjs'

let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support

// Snapshot + restore the projects store (smoke-projects pattern): generate
// creates project rows.
const projPath = new URL('../console/projects.json', import.meta.url).pathname
const projSnap = fs.existsSync(projPath) ? fs.readFileSync(projPath, 'utf8') : null
const GEN_A = 'g14adminsmoke'
const GEN_B = 'g14buildersmoke'
const genDirs = [GEN_A, GEN_B].map(g => new URL(`../domain-examples/generated/${g}/`, import.meta.url).pathname)

const browser = await chromium.launch()
try {
  // ---------- 1. no null-domain project exists (R-001) ----------
  const all = await authedGet('/projects', admin)
  check('admin project list responds', all.ok === true && Array.isArray(all.projects) && all.projects.length > 0)
  check('every project has a non-empty domain (no null-domain rows)',
    all.projects.every(p => typeof p.domain === 'string' && p.domain.length > 0))

  // ---------- 2. creation domain comes from the session, never the client ----------
  // A fleet-wide platform session smuggling domain:"customer-support" into the
  // body still lands in the Platform domain (server overwrites from session).
  const genA = await authedPost('/generate',
    { blueprint: 'chat-assistant', projectName: GEN_A, persona: 'G14 smoke', domain: 'customer-support' }, admin)
  check('admin generate succeeds', !!genA.project)
  const detailA = await authedGet(`/project-detail?id=${GEN_A}`, admin)
  check('client-supplied domain ignored: platform session project lands in platform domain',
    detailA.ok === true && detailA.project?.domain === 'platform')
  // A domain-scoped builder smuggling a foreign domain lands in the OWN domain.
  const genB = await authedPost('/generate',
    { blueprint: 'chat-assistant', projectName: GEN_B, persona: 'G14 smoke', domain: 'operations' }, alice)
  check('builder generate succeeds', !!genB.project)
  const detailB = await authedGet(`/project-detail?id=${GEN_B}`, alice)
  check('client-supplied foreign domain ignored: builder project lands in the session domain',
    detailB.ok === true && detailB.project?.domain === 'customer-support')

  // ---------- 3. agent detail exposes the Domain › Project › Agent chain ----------
  // R-016 follow-up: assert against GEN_B, the composition alice just created
  // in the customer-support domain via /api/generate (section 2 above) —
  // 'supportdesk' is a gitignored backfilled example, absent on a fresh clone.
  const agentDetail = await authedPost('/agent-detail', { project: GEN_B }, admin)
  check('agent detail carries its domain and owning project',
    agentDetail.domain === 'customer-support' && agentDetail.owningProject === GEN_B)

  // ---------- 4. UI breadcrumbs (admin) ----------
  const page = await browser.newPage()
  await uiLogin(page, 'melanie')
  await openProject(page, GEN_B, 'customer-support')
  await page.waitForSelector('.crumbs')
  check('project detail crumb: domain segment links to the owning domain',
    (await page.locator('.crumb[data-goview="domains"][data-domain="customer-support"]').count()) === 1)
  check('project detail crumb: project is the current (unlinked) segment',
    ((await page.locator('.crumbs').textContent()) || '').includes(GEN_B))
  // Agent drill-down from the project workspace.
  await page.locator(`.projagent[data-agent="${GEN_B}"]`).click()
  await page.waitForSelector('#agentcrumb .crumb')
  check('agent detail crumb: Domain › Project › Agent with both parents linked',
    (await page.locator('#agentcrumb .crumb[data-goview="domains"][data-domain="customer-support"]').count()) === 1 &&
    (await page.locator(`#agentcrumb .crumb[data-goview="projects"][data-project="${GEN_B}"]`).count()) === 1 &&
    ((await page.locator('#agentcrumb').textContent()) || '').trim().endsWith(GEN_B))
  // Crumb navigation: project segment returns to the project workspace
  // (#projback only exists on the projects view, so no stale-DOM race).
  await page.locator('#agentcrumb .crumb[data-goview="projects"]').click()
  await page.waitForSelector('#projback')
  await page.waitForSelector('.crumbs')
  check('clicking the project crumb lands back on the project workspace',
    ((await page.locator('main h1').first().textContent()) || '').includes(GEN_B))
  // Crumb navigation: domain segment opens the domain drill-down.
  await page.locator('.crumb[data-goview="domains"]').click()
  await page.waitForSelector('#domback')
  await page.waitForFunction(() => (document.querySelector('#domdetail')?.textContent || '').includes('Customer Support'))
  check('clicking the domain crumb opens the owning domain detail', true)

  // ---------- 5. builder workspace (TLP-B2 v2: builders have no nav path to
  // the project-detail page; the domain ownership shows in the workspace h1
  // instead — project name + owning-domain chip) ----------
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsswitchbtn')
  await page.locator('#wsswitchbtn').click()
  await page.locator(`.wsswitchitem[data-project="${GEN_B}"]`).click()
  await page.waitForFunction(n => (document.querySelector('#wsroot h1')?.textContent || '').includes(n), GEN_B)
  check('builder workspace shows her project inside its owning domain (Customer Support chip)',
    ((await page.locator('#wsroot h1').textContent()) || '').includes('Customer Support'))
  // Creation surfaces state the forced target domain (no domain form field).
  await page.locator('.nav[data-shellnav="build"]').click()
  await page.waitForSelector('[data-door], #doorback')
  const composeText = (await page.locator('main').textContent()) || ''
  check('compose page states the session-resolved target domain',
    composeText.includes('exactly one domain') && composeText.includes('Customer Support'))
  await page.close()
} finally {
  if (projSnap === null) fs.rmSync(projPath, { force: true })
  else fs.writeFileSync(projPath, projSnap)
  for (const d of genDirs) fs.rmSync(d, { recursive: true, force: true })
  await browser.close()
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
