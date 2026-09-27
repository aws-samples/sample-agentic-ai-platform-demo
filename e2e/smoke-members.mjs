// G6 smoke: Members page over the G5 project store (decision 1 + 4).
// Member writes are capability-gated SERVER-side (manageProjectMembers —
// independent review R-006: a builder session calling the write API directly gets 4xx, not
// a UI mask), every write is audited (R-007: member-added / member-removed /
// member-bundle-changed), a domain-scoped manager cannot assign a bundle that
// carries platform-tier capabilities (R-009 analog), and the Members UI
// renders manage affordances only for sessions the server says canManage.
// Run: node e2e/smoke-members.mjs   (expects console server on :4000)
import fs from 'node:fs'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin, openProject } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support
const enduser = await apiLogin('enduser')

// Snapshot + restore the projects store (smoke-projects pattern): member
// writes mutate it, so put it back exactly as found (delete if it was absent).
const projPath = new URL('../console/projects.json', import.meta.url).pathname
const projSnap = fs.existsSync(projPath) ? fs.readFileSync(projPath, 'utf8') : null
const PROJ = 'supportdesk'

const browser = await chromium.launch()
try {
  // ---------- 1. detail echoes server-resolved manage state ----------
  const adminDetail = await authedGet(`/project-detail?id=${PROJ}`, admin)
  check('admin project detail says canManage', adminDetail.ok === true && adminDetail.canManage === true)
  check('managers get the bundle list + member directory for the pickers',
    Array.isArray(adminDetail.bundles) && adminDetail.bundles.includes('builder') &&
    Array.isArray(adminDetail.directory) && adminDetail.directory.some(u => u.id === 'carol'))
  const carolDetail = await authedGet(`/project-detail?id=${PROJ}`, carol)
  check('lead canManage in the own domain', carolDetail.ok === true && carolDetail.canManage === true)
  const aliceDetail = await authedGet(`/project-detail?id=${PROJ}`, alice)
  check('builder detail says canManage=false and carries no directory/bundles',
    aliceDetail.ok === true && aliceDetail.canManage === false &&
    !('directory' in aliceDetail) && !('bundles' in aliceDetail))

  // ---------- 2. R-006: writes are capability-gated server-side ----------
  const builderWrite = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ projectId: PROJ, principal: 'melanie', bundle: 'builder' }),
  })
  check('builder direct write API is 403 (R-006 — not a UI mask)', builderWrite.status === 403)
  const enduserWrite = await fetch(BASE + '/api/project-member-remove', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + enduser.token },
    body: JSON.stringify({ projectId: PROJ, principal: 'alice' }),
  })
  check('end user member write is 403', enduserWrite.status === 403)
  const anonWrite = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJ, principal: 'melanie', bundle: 'builder' }),
  })
  check('unauthenticated member write is 401', anonWrite.status === 401)
  const malformed = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
    body: '{not json',
  })
  check('malformed JSON body is 400 (R-010 precedent)', malformed.status === 400)

  // ---------- 3. lead add / reassign / remove lifecycle, all audited ----------
  const added = await authedPost('/project-member-set', { projectId: PROJ, principal: 'frank', bundle: 'builder' }, carol)
  check('lead adds a directory member', added.ok === true &&
    (added.project.members || []).some(m => m.principal === 'frank' && m.bundle === 'builder'))
  const afterAdd = await authedGet(`/project-detail?id=${PROJ}`, carol)
  check('membership persists in the store', (afterAdd.project.members || []).some(m => m.principal === 'frank'))
  const reassigned = await authedPost('/project-member-set', { projectId: PROJ, principal: 'frank', bundle: 'lead' }, carol)
  check('lead reassigns a member bundle', reassigned.ok === true &&
    (reassigned.project.members || []).some(m => m.principal === 'frank' && m.bundle === 'lead'))
  const removed = await authedPost('/project-member-remove', { projectId: PROJ, principal: 'frank' }, carol)
  check('lead removes the member', removed.ok === true && !(removed.project.members || []).some(m => m.principal === 'frank'))
  const audit = (await authedGet('/obs-audit', admin)).events || []
  const memberEvents = audit.filter(e => e.kind === 'project' && e.projectId === PROJ && e.principal === 'frank')
  check('all three writes are audited (member-added / member-bundle-changed / member-removed) with who + project',
    ['member-added', 'member-bundle-changed', 'member-removed'].every(a =>
      memberEvents.some(e => e.action === a && e.who === 'carol')))

  // ---------- 4. R-009 analog: domain lead cannot assign a platform-tier bundle ----------
  const escalate = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
    body: JSON.stringify({ projectId: PROJ, principal: 'frank', bundle: 'admin' }),
  })
  check('lead assigning the admin bundle is 403 (platform-tier stays platform-team)', escalate.status === 403)
  const adminAssign = await authedPost('/project-member-set', { projectId: PROJ, principal: 'frank', bundle: 'admin' }, admin)
  check('platform admin may assign the admin bundle', adminAssign.ok === true)
  await authedPost('/project-member-remove', { projectId: PROJ, principal: 'frank' }, admin)

  // ---------- 5. validation + foreign/unknown scoping ----------
  const ghost = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
    body: JSON.stringify({ projectId: PROJ, principal: 'not-a-real-user', bundle: 'builder' }),
  })
  check('unknown principal is 400', ghost.status === 400)
  const badBundle = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
    body: JSON.stringify({ projectId: PROJ, principal: 'frank', bundle: 'not-a-bundle' }),
  })
  check('unknown bundle is 400', badBundle.status === 400)
  const notMember = await fetch(BASE + '/api/project-member-remove', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
    body: JSON.stringify({ projectId: PROJ, principal: 'frank' }),
  })
  check('removing a non-member is 400', notMember.status === 400)
  const adminList = await authedGet('/projects', admin)
  const opsProject = (adminList.projects || []).find(p => p.domain === 'operations')
  const foreign = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
    body: JSON.stringify({ projectId: opsProject.id, principal: 'bob', bundle: 'builder' }),
  })
  const unknownProj = await fetch(BASE + '/api/project-member-set', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + carol.token },
    body: JSON.stringify({ projectId: 'no-such-project', principal: 'bob', bundle: 'builder' }),
  })
  check('foreign-domain project write is 404 for a lead', foreign.status === 404)
  check('unknown project id is the SAME 404 (no existence oracle)', unknownProj.status === 404)

  // ---------- 6. Members UI: landing header + capability-scoped affordances ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'carol')
  await openProject(page, PROJ, 'customer-support')
  await page.waitForSelector('#memaddbtn')
  const main = await page.locator('main').textContent()
  check('project landing header frames name / domain / created-by',
    main.includes(PROJ) && main.includes('Customer Support') && main.includes('created by'))
  check('lead sees the manage affordances (add member + remove)',
    (await page.locator('.memremove').count()) > 0 && (await page.locator('#memaddbtn').count()) === 1)
  // add via the UI, then verify against the API
  await page.locator('#memadd').selectOption('frank')
  await page.locator('#memaddbtn').click()
  await page.waitForFunction(() => [...document.querySelectorAll('tr[data-member]')].some(r => r.dataset.member === 'frank'))
  const afterUiAdd = await authedGet(`/project-detail?id=${PROJ}`, carol)
  check('UI add lands in the server store', (afterUiAdd.project.members || []).some(m => m.principal === 'frank'))
  // TLP-B2 v2: builders have no nav path to the project-detail Members page;
  // read-only stays enforced server-side (canManage=false, no directory/
  // bundles) and the builder workspace carries no manage affordances at all.
  const aliceMembers = await authedGet(`/project-detail?id=${PROJ}`, alice)
  check('builder members access is read-only server-side (canManage=false)',
    aliceMembers.ok === true && aliceMembers.canManage === false)
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot')
  check('builder workspace renders (no member-manage affordances exist there)',
    (await page.locator('.memremove').count()) === 0 && (await page.locator('#memaddbtn').count()) === 0)
  const enduserNav = await (async () => { await uiLogin(page, 'enduser'); return page.locator('.nav').allTextContents() })()
  check('end user has no Projects nav entry', !enduserNav.some(t => t.includes('Projects')))
} finally {
  await browser.close()
  if (projSnap === null) fs.rmSync(projPath, { force: true })
  else fs.writeFileSync(projPath, projSnap)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
