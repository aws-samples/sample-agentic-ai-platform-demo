// TLP-B19 smoke — builder journey break-point fixes (B-J1 step 8 / B-J2 step 2
// / B-J3 step 1):
//   1. Lifecycle stepper on the fleet agent detail: 5 stages rendered from
//      GET /api/lifecycle, current stage highlighted, Advance calls
//      POST /api/lifecycle-advance and the new stage survives a reload.
//   2. Negative: the enduser agent detail renders NO lifecycle/Advance surface
//      (and the lifecycle APIs 403 an enduser session); at the terminal
//      'registered' stage the Advance button is gone.
//   3. Registry "Use in Build": APPROVED Skill/MCPServer rows carry the button,
//      non-APPROVED rows never do, and clicking one lands in the Build wizard
//      with that entry pre-selected (S.mcp/S.skills preseeded).
//   4. Builder-side blueprint submission: the compose door landing carries the
//      contribute form; a builder (alice) submit lands pending_approval in
//      melanie's Platform approvals queue.
//   5. Submit→approve closure: a platform peer approving the submission puts
//      the blueprint into /api/blueprints (catalog) for every role.
// Hermetic where state is written: blueprint-submissions.json and
// agent-lifecycle.json are snapshotted & restored (smoke-tlp-b7 pattern).
// Run: node e2e/smoke-tlp-b19.mjs   (expects console server, CONSOLE_BASE overridable)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const here = path.dirname(fileURLToPath(import.meta.url))
const SUB_PATH = path.join(here, '../console/blueprint-submissions.json')
const LC_PATH = path.join(here, '../console/agent-lifecycle.json')
const subSnapshot = fs.existsSync(SUB_PATH) ? fs.readFileSync(SUB_PATH, 'utf8') : null
const lcSnapshot = fs.existsSync(LC_PATH) ? fs.readFileSync(LC_PATH, 'utf8') : null

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}
const rawGet = (p, token) => fetch(BASE + '/api' + p, { headers: { authorization: 'Bearer ' + token } })
const rawPost = (p, body, token) => fetch(BASE + '/api' + p, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify(body),
})
const RUN = Date.now().toString(36).slice(-5)

const alice = await apiLogin('alice')       // builder, customer-support
const melanie = await apiLogin('melanie')   // platform admin (peer 1)
const frank = await apiLogin('frank')       // platform admin (peer 2)
const enduser = await apiLogin('enduser')

const browser = await chromium.launch()
try {
  // =========================================================================
  // 1. Lifecycle stepper on the fleet agent detail (B-J1 step 8)
  // =========================================================================
  // Ensure supportdesk has an exported repo (mock SSO org — no external write).
  const exp = await authedPost('/export', { project: 'supportdesk', preset: 'FULL' }, alice)
  check('L0 supportdesk export to the mock org succeeds (stepper precondition)', exp.ok === true, exp.repo || exp.error)

  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'alice')
  await page.waitForSelector('.wsfleetcard', { timeout: 20000 })
  await page.locator('.wsopenagent[data-agent="supportdesk"]').click()
  await page.waitForSelector('[data-fleetlifecycle="supportdesk"]', { timeout: 20000 })
  check('L1 agent detail renders the lifecycle stepper with all 5 stages',
    (await page.locator('[data-fleetlifecycle] [data-lcstage]').count()) === 5)
  const cur0 = (await page.locator('[data-fleetlifecycle] [data-lccurrent]').textContent()).trim()
  check('L2 current stage is highlighted (Exported after a fresh export)', cur0.includes('Exported'), cur0)
  // F5: the Advance button is a demo-only stand-in for a real trigger (a commit
  // landing, CI finishing, a deploy) and is HIDDEN unless the server ran with
  // SHOW_SIM=1. With it off the stage moves through the same advance API and the
  // stepper re-renders by re-opening the detail — real UI, no button.
  const simUi = (await authedGet('/catalog', alice))._showSim === true
  check('F5 Advance button is hidden unless SHOW_SIM=1',
    (await page.locator('#flcadvance').count()) === (simUi ? 1 : 0), 'SHOW_SIM=' + simUi)
  if (simUi) {
    check('L3 Advance button offers exactly the next stage',
      (await page.locator('#flcadvance').textContent()).includes('In development'))
    await page.locator('#flcadvance').click()
  } else {
    const adv = await authedPost('/lifecycle-advance', { repo: exp.repo, stage: 'in_development' }, alice)
    check('L3 advance API moves the stage one step (button hidden)',
      adv.ok === true && adv.lifecycle?.stage === 'in_development', adv.error || '')
    await page.locator('#fleetback').click()
    await page.waitForSelector('.wsfleetcard', { timeout: 20000 })
    await page.locator('.wsopenagent[data-agent="supportdesk"]').click()
  }
  await page.waitForFunction(() =>
    document.querySelector('[data-fleetlifecycle] [data-lccurrent]')?.textContent.includes('In development'),
    null, { timeout: 15000 })
  check('L4 stepper reflects the advanced stage (real /api/lifecycle-advance)', true)
  // persistence: server-side state, not client paint — survives a full reload
  await page.reload()
  await page.waitForSelector('#whoami')
  await page.waitForSelector('.wsfleetcard', { timeout: 20000 })
  await page.locator('.wsopenagent[data-agent="supportdesk"]').click()
  await page.waitForSelector('[data-fleetlifecycle] [data-lccurrent]', { timeout: 20000 })
  check('L5 advanced stage survives a reload (persisted server-side)',
    (await page.locator('[data-fleetlifecycle] [data-lccurrent]').textContent()).includes('In development'))

  // ---- negative (#2): terminal stage hides Advance ----
  const repo = exp.repo
  for (const stage of ['eval_available', 'deployed', 'registered'])
    await authedPost('/lifecycle-advance', { repo, stage }, alice)
  check('L6 API confirms terminal stage registered',
    (await authedGet('/lifecycle?repo=' + encodeURIComponent(repo), alice)).lifecycle?.stage === 'registered')
  await page.locator('#fleetback').click()
  await page.waitForSelector('.wsfleetcard', { timeout: 20000 })
  await page.locator('.wsopenagent[data-agent="supportdesk"]').click()
  await page.waitForSelector('[data-fleetlifecycle] [data-lccurrent]', { timeout: 20000 })
  check('L7 at terminal registered the Advance button is gone (Lifecycle complete note instead)',
    (await page.locator('#flcadvance').count()) === 0 &&
    (await page.locator('[data-fleetlifecycle]').textContent()).includes('Lifecycle complete'))

  // ---- negative (#2): enduser gets no Advance entry, APIs 403 ----
  check('L8 enduser lifecycle read -> 403',
    (await rawGet('/lifecycle?repo=' + encodeURIComponent(repo), enduser.token)).status === 403)
  check('L9 enduser lifecycle-advance -> 403',
    (await rawPost('/lifecycle-advance', { repo, stage: 'in_development' }, enduser.token)).status === 403)
  {
    const upage = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await uiLogin(upage, 'enduser')
    await upage.locator('.nav[data-shellnav="fleet"], .nav[data-shellnav="agents"]').first().click().catch(() => {})
    await upage.waitForSelector('.eufleetcard', { timeout: 20000 })
    await upage.locator('.eufleetcard').first().click()
    await upage.waitForSelector('#fchat', { timeout: 20000 })
    check('L10 enduser agent detail renders NO lifecycle stepper or Advance button',
      (await upage.locator('[data-fleetlifecycle]').count()) === 0 &&
      (await upage.locator('#flcadvance').count()) === 0)
    await upage.close()
  }

  // =========================================================================
  // 3. Registry "Use in Build" (B-J2 step 2)
  // =========================================================================
  await page.locator('.nav[data-shellnav="registry"]').click()
  await page.waitForSelector('.regrow', { timeout: 20000 })
  const useButtons = await page.locator('.regusebuild').count()
  check('R1 APPROVED registry rows carry a "Use in Build" button', useButtons > 0, `${useButtons} buttons`)
  // falsifiable against the API: every button sits on a row whose entry is
  // APPROVED and of a wizard-consumable type; non-APPROVED rows carry none.
  const regEntries = (await authedGet('/registry', alice)).entries || []
  const approvedIds = new Set(regEntries
    .filter(e => (e.resolved || {}).status === 'APPROVED' && ['Skill', 'MCPServer'].includes(e.type))
    .map(e => e.id))
  const btnIds = await page.evaluate(() =>
    [...document.querySelectorAll('.regusebuild')].map(b => b.dataset.useid))
  check('R2 every Use-in-Build button sits on an APPROVED Skill/MCPServer entry (API-reconciled)',
    btnIds.length > 0 && btnIds.every(id => approvedIds.has(id)), btnIds.join(','))
  // Status is a badge whose LABEL is humanized (APPROVED -> "Approved") and whose
  // title carries the raw status — read the title, not the row text.
  const nonApprovedWithBtn = await page.evaluate(() => {
    let bad = 0
    document.querySelectorAll('.regrow').forEach(tr => {
      const status = tr.querySelector('td:last-child .badge')?.title || ''
      if (tr.querySelector('.regusebuild') && status !== 'APPROVED') bad++
    })
    return bad
  })
  check('R3 negative: no non-APPROVED row renders the button', nonApprovedWithBtn === 0)
  // click an MCP server's button -> wizard with the entry pre-selected
  const mcpRow = page.locator('.regrow', { has: page.locator('.chip.type', { hasText: 'MCPServer' }) })
    .filter({ has: page.locator('.regusebuild') }).first()
  const useBtn = mcpRow.locator('.regusebuild')
  const mcpId = await useBtn.getAttribute('data-useid')
  await useBtn.click()
  await page.waitForSelector('[data-bp]', { timeout: 15000 })
  await page.locator('[data-bp="chat-assistant"]').click()
  await page.locator('#n1').click()
  await page.waitForSelector('#pname', { timeout: 15000 })
  check(`R4 Use in Build lands in the wizard with ${mcpId} pre-selected (S.mcp preseeded)`,
    (await page.locator(`[data-mcpsrv="${mcpId}"].sel`).count()) === 1)
  check('R5 the pre-selected MCP shows in the live harness preview',
    (await page.locator('#prev').textContent()).includes(mcpId))

  // =========================================================================
  // 4+5. Builder blueprint submission -> approvals queue -> catalog (B-J3)
  // =========================================================================
  const BP_ID = `b19bp${RUN}`
  await page.locator('#doorback').click()
  await page.waitForSelector('#bbsubmitcard', { timeout: 15000 })
  check('S1 compose door landing carries the builder contribute-a-blueprint form', true)
  await page.fill('#bbid', BP_ID)
  await page.fill('#bbname', `B19 Smoke ${RUN}`)
  await page.fill('#bbusecase', 'b19 smoke: builder-side submission')
  await page.locator('#bbsubmit').click()
  await page.waitForFunction(() =>
    /pending platform peer approval/.test(document.getElementById('bbmsg')?.textContent || ''),
    null, { timeout: 15000 })
  check('S2 builder form submit succeeds (POST /api/blueprint-submit as alice)', true)
  // the submission is visible in melanie's Platform approvals queue (API + UI)
  const q = await authedGet('/blueprint-submissions', melanie)
  const row = (q.submissions || []).find(s => s.blueprintId === BP_ID)
  check('S3 submission lands pending_approval in the platform queue, submitter=alice',
    !!row && row.status === 'pending_approval' && row.submittedBy === 'alice')
  {
    const mpage = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
    await uiLogin(mpage, 'melanie')
    await mpage.locator('.nav[data-shellnav="governance"]').click()
    await mpage.waitForSelector('.govtab[data-tab="exemptions"]', { timeout: 15000 })
    await mpage.locator('.govtab[data-tab="exemptions"]').click()
    await mpage.waitForSelector(`[data-bpsub="${row.id}"]`, { timeout: 15000 })
    check("S4 melanie's Platform approvals queue UI shows the builder submission",
      (await mpage.locator(`[data-bpsub="${row.id}"]`).textContent()).includes(BP_ID))
    await mpage.close()
  }
  // closure (#5): peer approve -> blueprint joins the catalog + wizard step 1
  check('S5 pending blueprint NOT yet in the catalog',
    !(await authedGet('/blueprints', alice)).some(b => b.id === BP_ID))
  const dec = await authedPost('/blueprint-submission-decide', { id: row.id, decision: 'approve' }, frank)
  check('S6 platform peer (frank) approves the builder submission', dec.ok === true && dec.submission.status === 'approved')
  check('S7 approved blueprint appears in /api/blueprints (catalog) for the builder',
    (await authedGet('/blueprints', alice)).some(b => b.id === BP_ID))
  {
    const bpage = await browser.newPage({ viewport: { width: 1440, height: 950 } })
    await uiLogin(bpage, 'alice')
    await bpage.locator('.nav[data-shellnav="build"]').click()
    await bpage.waitForSelector('[data-door="blueprint"]', { timeout: 15000 })
    await bpage.locator('[data-door="blueprint"]').click()
    await bpage.waitForSelector('[data-bp]', { timeout: 15000 })
    check('S8 approved blueprint is selectable in wizard step 1 (submit→approve→catalog closed)',
      (await bpage.locator(`[data-bp="${BP_ID}"]`).count()) === 1)
    await bpage.close()
  }
  await page.close()
} finally {
  await browser.close()
  if (subSnapshot === null) fs.rmSync(SUB_PATH, { force: true })
  else fs.writeFileSync(SUB_PATH, subSnapshot)
  if (lcSnapshot === null) fs.rmSync(LC_PATH, { force: true })
  else fs.writeFileSync(LC_PATH, lcSnapshot)
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
