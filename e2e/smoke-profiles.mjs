// G8 smoke: domain profile layer (decision 6).
// Factory profiles support-agent / workflow-agent are curated palettes
// (blueprints/skills/tools/guardrailPack) each carrying a runnable starter
// agent; create-project-from-profile pre-seeds the workspace through the
// NORMAL generate pipeline — registry APPROVED + domain visibility enforced
// server-side (a palette entry the session's domain can't see is dropped,
// never smuggled in) — and stamps profileId on the project row.
// Run: node e2e/smoke-profiles.mjs   (expects console server on :4000)
import fs from 'node:fs'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin } from './login.mjs'
// (TLP-B2 v2: the create-from-profile UI flow lives in the Domain Console
// Projects tab — a lead surface; builders reach profiles via the API only)

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

// Snapshot + restore the projects store; unique per-run names so leftovers on
// a long-lived server can't collide (smoke-projects pattern).
const projPath = new URL('../console/projects.json', import.meta.url).pathname
const projSnap = fs.existsSync(projPath) ? fs.readFileSync(projPath, 'utf8') : null
const RUN = String(Date.now() % 100000)
const P_SUPPORT = `g8support${RUN}`
const P_FOREIGN = `g8foreign${RUN}`
const P_UI = `g8ui${RUN}`
const genDirs = [P_SUPPORT, P_FOREIGN, P_UI].map(p => new URL(`../domain-examples/generated/${p}/`, import.meta.url).pathname)

const browser = await chromium.launch()
try {
  // ---------- 1. profile list: gating + SPEC shape ----------
  const anon = await fetch(BASE + '/api/profiles')
  check('unauthenticated profile list is 401', anon.status === 401)
  const euList = await fetch(BASE + '/api/profiles', { headers: { authorization: 'Bearer ' + enduser.token } })
  check('end user gets 403 on profiles (builder surface)', euList.status === 403)
  const list = await authedGet('/profiles', alice)
  check('builder lists profiles', list.ok === true && Array.isArray(list.profiles))
  const SHAPE = ['id', 'name', 'description', 'blueprints', 'skills', 'tools', 'guardrailPack', 'starterAgent']
  check('every profile carries the SPEC shape (id/name/description/blueprints/skills/tools/guardrailPack/starterAgent)',
    list.profiles.length >= 2 && list.profiles.every(p => SHAPE.every(k => k in p)))
  const support = list.profiles.find(p => p.id === 'support-agent')
  const workflow = list.profiles.find(p => p.id === 'workflow-agent')
  check('factory profiles support-agent and workflow-agent exist', !!support && !!workflow)
  check('each factory profile carries a runnable starter agent spec (blueprint + persona)',
    [support, workflow].every(p => p.starterAgent?.blueprint && p.starterAgent?.persona))
  check('starter blueprints are the deployable pair (chat-assistant / workflow-orchestrator)',
    support.starterAgent.blueprint === 'chat-assistant' && workflow.starterAgent.blueprint === 'workflow-orchestrator')

  // ---------- 2. create-from-profile: gating + validation ----------
  const euCreate = await fetch(BASE + '/api/project-from-profile', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + enduser.token },
    body: JSON.stringify({ profileId: 'support-agent', projectName: 'nope' }),
  })
  check('end user gets 403 on create-from-profile', euCreate.status === 403)
  const badProfile = await fetch(BASE + '/api/project-from-profile', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ profileId: 'no-such-profile', projectName: 'nope' }),
  })
  check('unknown profile id is 400', badProfile.status === 400)
  const badName = await fetch(BASE + '/api/project-from-profile', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ profileId: 'support-agent' }),
  })
  check('missing project name is 400', badName.status === 400)
  const badJson = await fetch(BASE + '/api/project-from-profile', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: '{not json',
  })
  check('malformed JSON body is 400', badJson.status === 400)

  // ---------- 3. builder creates from support-agent: pre-seeded + demoable ----------
  const made = await authedPost('/project-from-profile', { profileId: 'support-agent', projectName: P_SUPPORT }, alice)
  check('builder creates a project from support-agent', made.ok === true && made.project === P_SUPPORT)
  const detail = await authedGet(`/project-detail?id=${P_SUPPORT}`, alice)
  check('project row is stamped with the profileId', detail.ok === true && detail.project?.profileId === 'support-agent')
  check('project sits in the composer domain with the real creator',
    detail.project?.domain === 'customer-support' && detail.project?.createdBy === 'alice')
  check('workspace is pre-seeded with the starter agent', (detail.project?.agents || []).includes(P_SUPPORT))
  const agent = await authedPost('/agent-detail', { project: P_SUPPORT }, alice)
  check('starter agent composition answers on the agent detail page (runnable files in place)',
    agent.project === P_SUPPORT && !!agent.runtime)
  check('starter agent harness records the profile persona',
    typeof agent.persona === 'string' && agent.persona.includes('customer support agent'))
  check('starter agent carries the profile skills + tools (own-domain palette resolves fully)',
    (agent.skills || []).some(s => s.id === 'customer-support') &&
    (agent.tools || []).some(t => t.id === 'order_lookup') &&
    (agent.tools || []).some(t => t.id === 'web_browser'))
  const ds = await authedGet('/eval-dataset?project=' + P_SUPPORT, alice)
  check('eval-dataset presets answer for the starter agent (demoable end-to-end)',
    Array.isArray(ds.presets) && ds.presets.length >= 1)

  // ---------- 4. foreign-domain palette entries are dropped, never smuggled ----------
  const foreign = await authedPost('/project-from-profile', { profileId: 'support-agent', projectName: P_FOREIGN }, bob)
  check('operations builder can also start from support-agent', foreign.ok === true)
  const fAgent = await authedPost('/agent-detail', { project: P_FOREIGN }, bob)
  check('foreign-domain palette entries are dropped by registry visibility (customer-support skill/tools absent)',
    !(fAgent.skills || []).some(s => s.id === 'customer-support') &&
    !(fAgent.tools || []).some(t => t.id === 'order_lookup'))
  check('shared palette entries still resolve for the foreign-domain builder',
    (fAgent.tools || []).some(t => t.id === 'web_browser'))
  const fDetail = await authedGet(`/project-detail?id=${P_FOREIGN}`, bob)
  check('foreign-created project lands in the creating builder domain (operations)',
    fDetail.ok === true && fDetail.project?.domain === 'operations' && fDetail.project?.profileId === 'support-agent')

  // ---------- 5. UI: create via the Domain Console wizard (lead) ----------
  // (TLP-B4: the single profile+name form became the 6-step wizard. The
  // workflow TEMPLATE descends from the workflow-agent profile — the create
  // still stamps profileId on the row, so the G8 contract holds.)
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'carol')
  await page.locator('.nav[data-shellnav="projects"]').click()
  await page.waitForSelector('#dcprojgo', { timeout: 15000 })
  await page.locator('#dcprojgo').click()
  await page.waitForSelector('[data-wtpl]', { timeout: 15000 })
  const tplNames = await page.locator('[data-wtpl]').allTextContents()
  check('wizard step 1 offers the profile-descended templates (Chatbot / Workflow)',
    tplNames.some(t => t.includes('Chatbot')) && tplNames.some(t => t.includes('Workflow')))
  await page.locator('[data-wtpl="workflow"]').click()
  await page.locator('#wnext').click()
  await page.waitForSelector('#wname', { timeout: 15000 })
  await page.fill('#wname', P_UI)
  await page.locator('#wnext').click()                        // -> 3 config
  await page.waitForSelector('#wbp', { timeout: 15000 })
  await page.locator('#wnext').click()                        // -> 4 members
  await page.waitForSelector('[data-wmember], .empty', { timeout: 15000 })
  await page.locator('#wnext').click()                        // -> 5 policy
  await page.waitForSelector('[data-wlocked]', { timeout: 15000 })
  await page.locator('#wnext').click()                        // -> 6 review
  await page.waitForSelector('#wcreate', { timeout: 15000 })
  await page.locator('#wcreate').click()
  await page.waitForSelector('#projdetail h1', { timeout: 120000 })
  const hdr = await page.locator('#projdetail').textContent()
  check('UI wizard create lands on the project detail with the profile framing',
    hdr.includes(P_UI) && hdr.includes('workflow-agent'))
  const uiDetail = await authedGet(`/project-detail?id=${P_UI}`, alice)
  check('UI-created project persisted with profileId workflow-agent',
    uiDetail.ok === true && uiDetail.project?.profileId === 'workflow-agent' && (uiDetail.project?.agents || []).includes(P_UI))

  // ---------- 6. end user sees no profile cards ----------
  // (body.textContent would match the inline <script> source — check rendered
  // nodes: no Projects nav entry, no profile cards anywhere in the DOM)
  const euPage = await browser.newPage()
  await uiLogin(euPage, 'enduser')
  const euNav = await euPage.locator('.nav').allTextContents()
  check('end user UI has no profile creation surface (no Projects nav, no profile cards)',
    !euNav.some(t => t.includes('Projects')) && (await euPage.locator('.profcreate').count()) === 0)
} finally {
  await browser.close()
  if (projSnap === null) fs.rmSync(projPath, { force: true })
  else fs.writeFileSync(projPath, projSnap)
  for (const d of genDirs) fs.rmSync(d, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
