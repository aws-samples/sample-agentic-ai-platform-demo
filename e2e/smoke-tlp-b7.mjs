// TLP-B7 smoke — platform IA restructure + workspace reuse + blueprint approval.
//   1. Platform sidebar IA (scope 1): admin nav is EXACTLY the 11-entry
//      sidebar; every entry opens; the Home button wall is gone; the 4-eyes
//      queue lives in Governance & Approvals › Platform approvals; builder /
//      lead / end-user shells unchanged.
//   2. Build reuse (scope 2): platform picks a project and lands in the SAME
//      builder workspace; /api/platform-build-open is admin-only (lead /
//      builder / enduser -> 403) and grants NOTHING to other roles — their
//      scoped routes answer exactly as before (no widening).
//   3. Blueprint approval (scope 3): platform-only submit (builder/lead 403),
//      server-side schema validation (unknown enum, incompatible pairing,
//      duplicate id, malformed JSON body), self-approval 403 + audited,
//      lifecycle submit→approve→listed and submit→reject→never listed,
//      pending/rejected invisible to non-platform roles, audit entries for
//      submit/approve/reject.
// Hermetic: blueprint-submissions.json snapshotted & restored.
// Run: node e2e/smoke-tlp-b7.mjs   (expects console server on :4000)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin, ADMIN_NAV } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const here = path.dirname(fileURLToPath(import.meta.url))
const SUB_PATH = path.join(here, '../console/blueprint-submissions.json')
const subSnapshot = fs.existsSync(SUB_PATH) ? fs.readFileSync(SUB_PATH, 'utf8') : null

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}
const rawPost = (p, body, token) => fetch(BASE + '/api' + p, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify(body),
})

const melanie = await apiLogin('melanie')  // platform admin (peer 1)
const frank = await apiLogin('frank')      // platform admin (peer 2)
const carol = await apiLogin('carol')      // lead, customer-support
const alice = await apiLogin('alice')      // builder, customer-support
const enduser = await apiLogin('enduser')

const RUN = Date.now().toString(36).slice(-5)
const BP_OK = `b7ok${RUN}`     // approve-path blueprint
const BP_REJ = `b7rej${RUN}`   // reject-path blueprint
const TEMPLATE = { framework: 'Strands', deployTarget: 'AgentCore Runtime', protocol: 'HTTP', memory: 'shortTerm', streaming: true, identity: true, guardrails: true }

const browser = await chromium.launch()
try {
  // =========================================================================
  // 1. SCOPE 1 — platform sidebar IA
  // =========================================================================
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await uiLogin(page, 'melanie')
    const nav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^\w]+/, '').trim())
    check('IA1 admin nav is EXACTLY the TLP-B7 sidebar (ADMIN_NAV)',
      nav.length === ADMIN_NAV.length && ADMIN_NAV.every((w, i) => nav[i] === w), nav.join(' | '))
    // B23: the AI Gateway and platform Memory Stores tabs are removed
    // (UI only — data planes stay; per-agent memory = workspace Memory & KB)
    check('IA1b admin nav has no AI Gateway entry', !nav.some(t => t.includes('AI Gateway')))
    check('IA1c admin nav has no Memory Stores entry', !nav.some(t => t.includes('Memory Stores')))
    check('IA2 Domains is a top-level section (not a drill-down)', nav.includes('Domains'))
    check('IA4 no Operations button wall on Dashboard',
      (await page.locator('[data-pcgo]').count()) === 0)
    check('IA5 retired entries gone (Platform Approvals / Platform Projects / Home)',
      !nav.some(t => ['Platform Approvals', 'Platform Projects', 'Home'].includes(t)))

    // every sidebar entry opens on its own surface (deep-link per section)
    const SWEEP = [
      ['home', () => /Platform Console/.test(document.querySelector('main h1')?.textContent || '') && !!document.querySelector('.kpi')],
      ['domains', () => /Domains/.test(document.querySelector('main h1')?.textContent || '') && !!document.getElementById('domroster')],
      ['blueprints', () => /Blueprints/.test(document.querySelector('main h1')?.textContent || '')],
      ['cost', () => /Cost/.test(document.querySelector('main h1')?.textContent || '')],
      ['monitoring', () => /Platform Monitoring/.test(document.querySelector('main h1')?.textContent || '')],
      ['registry', () => /AI Registry/.test(document.querySelector('main h1')?.textContent || '')],
      ['governance', () => /Governance/.test(document.querySelector('main h1')?.textContent || '')],
      // TLP-B9: the admin Build picker page is retired — BUILD WORKSPACE's
      // Build Agent + lands straight on the compose surface.
      ['bwbuild', () => /Build an Agent/.test(document.querySelector('main h1')?.textContent || '')],
    ]
    let allOpen = true
    for (const [id, fn] of SWEEP) {
      await page.locator(`.nav[data-shellnav="${id}"]`).click()
      try { await page.waitForFunction(fn, null, { timeout: 20000 }) }
      catch { allOpen = false; console.log(`      section "${id}" did not render its surface`) }
      const active = await page.locator(`.nav.active[data-shellnav="${id}"]`).count()
      if (active !== 1) { allOpen = false; console.log(`      section "${id}" not highlighted active`) }
    }
    check('IA6 all sidebar entries open + highlight active', allOpen)

    // the 4-eyes queue lives in Governance & Approvals now
    await page.locator('.nav[data-shellnav="governance"]').click()
    await page.waitForSelector('.govtab[data-tab="exemptions"]', { timeout: 15000 })
    await page.locator('.govtab[data-tab="exemptions"]').click()
    await page.waitForFunction(() => !(document.getElementById('apxlist')?.textContent || 'loading').includes('loading'), null, { timeout: 15000 })
    check('IA7 Platform approvals tab renders the exemption queue + blueprint queue',
      (await page.locator('#apxlist').count()) === 1 && (await page.locator('#bpsublist').count()) === 1)
    await page.close()
  }

  // other shells unchanged
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await uiLogin(page, 'carol')
    const leadNav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^\w]+/, '').trim())
    check('IA8 lead shell is DOMAIN governance + BUILD WORKSPACE (spec v2.5)',
      leadNav.join('|') === ['Dashboard', 'Projects', 'Users & Access', 'Governance & Approvals',
        'Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry'].join('|'), leadNav.join(' | '))
    await uiLogin(page, 'alice')
    const bNav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^\w]+/, '').trim())
    check('IA9 builder shell unchanged (six workspace tabs)',
      bNav.join('|') === ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry'].join('|'), bNav.join(' | '))
    await page.close()
  }

  // =========================================================================
  // 2. SCOPE 2 — platform Build reuses the builder workspace
  // =========================================================================
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await uiLogin(page, 'melanie')
    // TLP-B9: the Build picker page is retired — BUILD WORKSPACE lands straight
    // on the reused builder workspace, scoped to platform-domain projects.
    await page.locator('.nav[data-shellnav="bwfleet"]').click()
    await page.waitForSelector('#wstabs', { timeout: 15000 })
    check('B1 BUILD WORKSPACE opens the SAME builder workspace shell (in-page tabs render)', true)
    check('B4 workspace has the Build tab (build capability present)',
      (await page.locator('.wstabbtn[data-wstab="build"]').count()) === 1)
    await page.close()
  }
  // server-side gate: only the platform role opens arbitrary workspaces this way
  const anyProject = ((await authedGet('/projects', melanie)).projects || [])[0]
  check('B5 admin platform-build-open succeeds', (await authedPost('/platform-build-open', { project: anyProject.id }, melanie)).ok === true)
  for (const [who, s] of [['carol (lead)', carol], ['alice (builder)', alice], ['enduser', enduser]]) {
    const st = (await rawPost('/platform-build-open', { project: anyProject.id }, s.token)).status
    check(`B6 ${who} platform-build-open -> 403`, st === 403)
  }
  // no widening: the other roles' scoped reads answer exactly as before
  const aliceMine = await authedGet('/my-projects', alice)
  check('B7 builder /my-projects stays membership-filtered (no foreign rows)',
    (aliceMine.projects || []).every(p => p.domain === 'customer-support'))
  const carolProjects = await authedGet('/projects', carol)
  check('B8 lead /projects stays domain-scoped',
    (carolProjects.projects || []).every(p => p.domain === 'customer-support'))
  const endGen = (await rawPost('/generate', { blueprint: 'chat-assistant', projectName: `b7x${RUN}` }, enduser.token)).status
  check('B9 enduser still cannot reach build write routes (generate -> 403)', endGen === 403)
  const foreignDetail = (await rawPost('/agent-detail', { project: 'platform-assistant' }, alice.token)).status
  check('B10 builder still 404s on a foreign-domain project (guardProject intact)', foreignDetail === 404)

  // =========================================================================
  // 3. SCOPE 3 — blueprint submission + approval
  // =========================================================================
  // role gates — TLP-B19 (B-J3 step 1) opened submission to builder surfaces
  // (builders/leads contribute from their own shell); the boundary moved to
  // the DECISION, which stays platform-peer-only. End users still 403.
  const bp1 = await rawPost('/blueprint-submit', { id: `b7prea${RUN}`, name: 'x', useCase: 'x', template: TEMPLATE }, alice.token)
  check('BP1 builder submit accepted (B19: contribution entry, decision stays platform-only)', bp1.status === 200)
  const bp2 = await rawPost('/blueprint-submit', { id: `b7prec${RUN}`, name: 'x', useCase: 'x', template: TEMPLATE }, carol.token)
  check('BP2 lead submit accepted (B19: builder surface)', bp2.status === 200)
  check('BP3 enduser submit -> 403', (await rawPost('/blueprint-submit', { id: BP_OK, name: 'x', useCase: 'x', template: TEMPLATE }, enduser.token)).status === 403)
  // schema validation
  const badFw = await authedPost('/blueprint-submit', { id: `b7bad${RUN}`, name: 'Bad', useCase: 'x', template: { ...TEMPLATE, framework: 'NotAFramework' } }, melanie)
  check('BP4 unknown framework rejected with a named error', badFw.ok === false && (badFw.errors || []).some(e => /framework/.test(e)))
  const badPair = await authedPost('/blueprint-submit', { id: `b7bad${RUN}`, name: 'Bad', useCase: 'x', template: { ...TEMPLATE, framework: 'LangGraph', deployTarget: 'AWS Lambda' } }, melanie)
  check('BP5 incompatible framework×hosting rejected (same matrix as the registry)', badPair.ok === false)
  const badShape = await authedPost('/blueprint-submit', { id: `b7bad${RUN}`, name: 'Bad', useCase: 'x', template: { ...TEMPLATE, streaming: 'yes' } }, melanie)
  check('BP6 non-boolean flag rejected', badShape.ok === false && (badShape.errors || []).some(e => /streaming/.test(e)))
  const badId = await authedPost('/blueprint-submit', { id: 'chat-assistant', name: 'Dup', useCase: 'x', template: TEMPLATE }, melanie)
  check('BP7 duplicate catalog id rejected', badId.ok === false)

  // lifecycle A: submit → approve → listed
  const subA = await authedPost('/blueprint-submit', { id: BP_OK, name: `B7 Approved ${RUN}`, useCase: 'b7 smoke approve path', template: TEMPLATE }, melanie)
  check('BP8 platform submit lands pending_approval', subA.ok === true && subA.submission.status === 'pending_approval')
  const midList = await authedGet('/blueprints', alice)
  check('BP9 pending blueprint NOT in the blueprint list', !midList.some(b => b.id === BP_OK))
  check('BP10 non-platform roles cannot read the submission queue',
    (await authedGet('/blueprint-submissions', carol)).ok === false &&
    (await authedGet('/blueprint-submissions', alice)).ok === false)
  const selfTry = await rawPost('/blueprint-submission-decide', { id: subA.submission.id, decision: 'approve' }, melanie.token)
  check('BP11 self-approval -> 403 (submitter ≠ approver, server-enforced)', selfTry.status === 403)
  const afterBlock = (await authedGet('/blueprint-submissions', frank)).submissions.find(s => s.id === subA.submission.id)
  check('BP12 blocked self-approval recorded on the row history (never silent)',
    (afterBlock.history || []).some(h => h.action === 'self-approval-blocked' && h.who === 'melanie'))
  const decA = await authedPost('/blueprint-submission-decide', { id: subA.submission.id, decision: 'approve' }, frank)
  check('BP13 peer approve succeeds', decA.ok === true && decA.submission.status === 'approved' && decA.submission.decidedBy === 'frank')
  const listedAll = await authedGet('/blueprints', alice)
  check('BP14 approved blueprint appears in the list for every role', listedAll.some(b => b.id === BP_OK))
  check('BP15 double-decide -> 409', (await rawPost('/blueprint-submission-decide', { id: subA.submission.id, decision: 'reject' }, frank.token)).status === 409)

  // lifecycle B: submit → reject → never listed
  const subB = await authedPost('/blueprint-submit', { id: BP_REJ, name: `B7 Rejected ${RUN}`, useCase: 'b7 smoke reject path', template: TEMPLATE }, frank)
  const decB = await authedPost('/blueprint-submission-decide', { id: subB.submission.id, decision: 'reject', reason: 'not paved-road' }, melanie)
  check('BP16 peer reject succeeds', decB.ok === true && decB.submission.status === 'rejected')
  check('BP17 rejected blueprint never reaches the list',
    !(await authedGet('/blueprints', enduser)).some?.(b => b.id === BP_REJ) &&
    !(await authedGet('/blueprints', melanie)).some(b => b.id === BP_REJ))

  // audit entries for submit / approve / reject (+ the blocked attempt)
  const audit = await authedGet('/audit-trail?type=blueprint', melanie)
  const acts = new Set((audit.events || []).map(e => e.action))
  check('BP18 audit trail carries blueprint-submitted / -approved / -rejected / self-approval-blocked',
    acts.has('blueprint-submitted') && acts.has('blueprint-approved') && acts.has('blueprint-rejected') && acts.has('self-approval-blocked'),
    [...acts].join(','))

  // UI: submission entry on Blueprints (platform) + queue decide (peer)
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
    await uiLogin(page, 'melanie')
    await page.locator('.nav[data-shellnav="blueprints"]').click()
    await page.waitForSelector('#bpsubmitcard', { timeout: 15000 })
    check('BP19 Blueprints page has the add-a-blueprint submission entry (platform only)', true)
    await page.fill('#bsid', `b7ui${RUN}`)
    await page.fill('#bsname', `B7 UI ${RUN}`)
    await page.fill('#bsusecase', 'submitted through the form')
    await page.locator('#bssubmit').click()
    await page.waitForFunction(() => /pending peer approval/.test(document.getElementById('bsmsg')?.textContent || ''), null, { timeout: 15000 })
    check('BP20 form submit lands in the pending strip', true)
    // peer decides in Governance & Approvals › Platform approvals
    await uiLogin(page, 'frank')
    await page.locator('.nav[data-shellnav="governance"]').click()
    await page.waitForSelector('.govtab[data-tab="exemptions"]', { timeout: 15000 })
    await page.locator('.govtab[data-tab="exemptions"]').click()
    await page.waitForSelector('.bpsubdecide', { timeout: 15000 })
    const row = page.locator('[data-bpsub]', { hasText: `b7ui${RUN}` })
    await row.locator('.bpsubdecide[data-d="reject"]').click()
    await page.waitForFunction(id => {
      const el = [...document.querySelectorAll('[data-bpsub]')].find(x => x.textContent.includes(id))
      return el && /rejected/.test(el.textContent)
    }, `b7ui${RUN}`, { timeout: 15000 })
    check('BP21 peer decision works from the Platform approvals queue UI', true)
    await page.close()
  }
} finally {
  await browser.close()
  if (subSnapshot === null) fs.rmSync(SUB_PATH, { force: true })
  else fs.writeFileSync(SUB_PATH, subSnapshot)
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
