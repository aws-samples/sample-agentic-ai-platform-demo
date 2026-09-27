// TLP-B6 smoke — final close-out batch.
//   1. 17 entry-point availability tests (spec §10 last item / BUILD-PLAN B6):
//      builder 7 (six workspace tabs + the My Projects hybrid landing),
//      domain console 4, platform console 6 (incl. the Build hybrid
//      workspace reuse — TLP-B7 sidebar IA). Each: page opens, core content renders, and
//      NO response on the wire was a 5xx.
//   2. Exemption expiry + revoke (booked P2, B4 signoff §4): TTL stamped at
//      layer-2 approval (approver ttlDays or 30d default), expiry honored at
//      READ time (backdated store row flips to expired + guardrail restored),
//      revoke immediate + audited, 403 for non-approver roles, self-revoke
//      allowed but audited, 409 on double revoke.
//   3. Spec §10 item 4 (v2.1): governance justification free text passes the
//      masking pipeline in EVERY render path — domain queue, platform queue,
//      decision echoes, audit trail — probed with realistic email + intl
//      phone + passport shapes (superset of the B4 phone/passport probe).
//   4. Spec §10 item 2 evidence: wizard-created resources carry the full
//      domain-id/project-id tag set (§3.2 convention) in agentcore.json.
//   5. totalWithSharedUsd (booked P3, B5 signoff §3): direct + shared ==
//      total within 1e-9 on all three response shapes; per-layer costUsd
//      stays direct-only; the direct-cost footnote renders on cost views.
// Hermetic: policy-exemptions.json / projects.json snapshotted & restored,
// generated dirs removed, unique per-run names (smoke-tlp-b4 pattern).
// Run: node e2e/smoke-tlp-b6.mjs   (expects console server on :4000)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const here = path.dirname(fileURLToPath(import.meta.url))
const PROJECTS_PATH = path.join(here, '../console/projects.json')
const projectsSnapshot = fs.existsSync(PROJECTS_PATH) ? fs.readFileSync(PROJECTS_PATH, 'utf8') : null
const EXEMPT_PATH = path.join(here, '../console/policy-exemptions.json')
const exemptSnapshot = fs.existsSync(EXEMPT_PATH) ? fs.readFileSync(EXEMPT_PATH, 'utf8') : null

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}
const rawPost = (p, body, token) => fetch(BASE + '/api' + p, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify(body),
})
const rawGet = (p, token) => fetch(BASE + '/api' + p, { headers: { authorization: 'Bearer ' + token } })

const alice = await apiLogin('alice')     // builder, customer-support
const carol = await apiLogin('carol')     // lead, customer-support (single-lead domain)
const bob = await apiLogin('bob')         // builder, operations (wrong-domain role probe)
const enduser = await apiLogin('enduser')
const melanie = await apiLogin('melanie') // platform admin (peer 1)
const frank = await apiLogin('frank')     // platform admin (peer 2)

const RUN = Date.now().toString(36).slice(-5)
const P_EXP = `b6exp${RUN}`   // expiry-path project
const P_REV = `b6rev${RUN}`   // revoke-path + PII render-path project
const genDirs = [P_EXP, P_REV].map(p => path.join(here, `../domain-examples/generated/${p}`))

const browser = await chromium.launch()
try {
  // =========================================================================
  // 1. 17 ENTRY-POINT AVAILABILITY TESTS (7 builder + 4 domain + 6 platform)
  // Every page load is watched for 5xx responses on the wire.
  // =========================================================================
  const watch5xx = page => {
    const bad = []
    page.on('response', r => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`) })
    return bad
  }
  const settle = async page => { await page.waitForTimeout(400) }

  // ---- builder (alice): six workspace tabs + the hybrid My Projects landing
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const bad = watch5xx(page)
    await uiLogin(page, 'alice')
    await page.waitForSelector('#wsbody', { timeout: 20000 })

    await page.locator('.nav[data-shellnav="fleet"]').click()
    await page.waitForSelector('#wsbody', { timeout: 15000 })
    await settle(page)
    check('EP-B1 builder entry "Fleet" opens (workspace agent cards render)',
      ((await page.locator('#wsbody').textContent()) || '').length > 0)

    await page.locator('.nav[data-shellnav="build"]').click()
    await page.waitForSelector('[data-door], [data-bp], #pname, #doorback', { timeout: 15000 })
    check('EP-B2 builder entry "Build Agent +" opens (journey doors / wizard render)', true)

    await page.locator('.nav[data-shellnav="memorykb"]').click()
    await page.waitForFunction(() => (document.getElementById('wsbody')?.textContent || '').includes('Knowledge Base'), null, { timeout: 15000 })
    check('EP-B3 builder entry "Memory & KB" opens (KB section + collapsed memory render)', true)

    await page.locator('.nav[data-shellnav="cost"]').click()
    await page.waitForFunction(() => (document.getElementById('wsbody')?.textContent || '').includes('Project cost'), null, { timeout: 15000 })
    check('EP-B4 builder entry "Cost" opens (project-scoped cost table renders)', true)

    await page.locator('.nav[data-shellnav="obs"]').click()
    await page.waitForSelector('#obsbox', { timeout: 15000 })
    await settle(page)
    check('EP-B5 builder entry "Observability" opens (metrics box renders)', true)

    await page.locator('.nav[data-shellnav="registry"]').click()
    await page.waitForSelector('#regbox', { timeout: 15000 })
    await page.waitForFunction(() => !(document.getElementById('regbox')?.textContent || '').includes('loading'), null, { timeout: 15000 })
    check('EP-B6 builder entry "AI Registry (read-only)" opens (catalog renders)', true)

    check('EP-B1..6 no 5xx on the wire across the six builder tabs', bad.length === 0, bad.join(' '))
    await page.close()
  }
  {
    // hybrid landing: a builder session with NO last-used project lands on
    // the My Projects cards page; opening a card enters the workspace.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const bad = watch5xx(page)
    const fresh = await apiLogin('alice')
    await authedPost('/last-project', { project: null }, fresh)
    await page.goto(BASE)
    await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), fresh)
    await page.goto(BASE)
    await page.waitForSelector('.projcard', { timeout: 20000 })
    await page.locator('.projcard').first().click()
    await page.waitForSelector('#wsbody', { timeout: 15000 })
    check('EP-B7 builder entry "My Projects hybrid landing" opens (cards page -> workspace)', bad.length === 0, bad.join(' '))
    await page.close()
    // hermeticity: restore the fresh-boot no-last-used state
    await authedPost('/last-project', { project: null }, fresh)
  }

  // ---- domain console (carol): 4 nav entries
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const bad = watch5xx(page)
    await uiLogin(page, 'carol')

    await page.locator('.nav[data-shellnav="dashboard"]').click()
    await page.waitForFunction(() => (document.getElementById('dcbody')?.textContent || '').includes('Cost control'), null, { timeout: 20000 })
    check('EP-D1 domain entry "Dashboard" opens (cost rollup + health render)', true)

    await page.locator('.nav[data-shellnav="projects"]').click()
    await page.waitForFunction(() => { const t = document.getElementById('dcbody')?.textContent || ''; return t.includes('Create Project') || !!document.querySelector('[data-project]') }, null, { timeout: 15000 })
    check('EP-D2 domain entry "Projects" opens (project cards + Create Project render)', true)

    await page.locator('.nav[data-shellnav="users"]').click()
    await page.waitForFunction(() => { const t = document.getElementById('dcbody')?.textContent || ''; return !t.includes('loading') && t.length > 40 }, null, { timeout: 15000 })
    check('EP-D3 domain entry "Users & Access" opens (users x projects matrix renders)', true)

    await page.locator('.nav[data-shellnav="governance"]').click()
    await page.waitForSelector('.govtab', { timeout: 15000 })
    await settle(page)
    check('EP-D4 domain entry "Governance & Approvals" opens (domain approval inbox renders)', true)

    check('EP-D1..4 no 5xx on the wire across the domain console', bad.length === 0, bad.join(' '))
    await page.close()
  }

  // ---- platform console (melanie): TLP-B7 sidebar — Dashboard, the folded
  // Governance & Approvals (4-eyes queue is a tab now), Blueprints, and the
  // Build picker (the hybrid workspace reuse, ex Platform Projects)
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const bad = watch5xx(page)
    await uiLogin(page, 'melanie')

    await page.locator('.nav[data-shellnav="home"]').click()
    await page.waitForSelector('.kpi', { timeout: 20000 })
    check('EP-P1 platform entry "Dashboard" opens (KPI row + domains overview render)', true)

    await page.locator('.nav[data-shellnav="registry"]').click()
    await page.waitForSelector('.regrow', { timeout: 15000 })
    check('EP-P2 platform entry "AI Registry" opens (writable catalog rows render)', true)

    await page.locator('.nav[data-shellnav="governance"]').click()
    await page.waitForSelector('.govtab', { timeout: 15000 })
    await settle(page)
    check('EP-P3 platform entry "Governance & Approvals" opens (governance tabs render)', true)

    await page.locator('.govtab[data-tab="exemptions"]').click()
    await page.waitForFunction(() => !(document.getElementById('apxlist')?.textContent || 'loading').includes('loading'), null, { timeout: 15000 })
    check('EP-P4 Platform approvals tab opens (4-eyes exemption queue renders)', true)

    await page.locator('.nav[data-shellnav="blueprints"]').click()
    await page.waitForFunction(() => /Blueprints/.test(document.querySelector('main h1')?.textContent || '') && document.querySelectorAll('main .card').length > 3, null, { timeout: 15000 })
    check('EP-P5 platform entry "Blueprints" opens (template cards render)', true)

    // TLP-B9: the Build picker page is retired — BUILD WORKSPACE lands straight
    // on the reused builder workspace (platform-scoped projects).
    await page.locator('.nav[data-shellnav="bwfleet"]').click()
    await page.waitForSelector('#wstabs', { timeout: 15000 })
    check('EP-P6 platform entry "BUILD WORKSPACE" opens (hybrid workspace reuse)', true)

    check('EP-P1..6 no 5xx on the wire across the platform console', bad.length === 0, bad.join(' '))
    await page.close()
  }

  // =========================================================================
  // 2 + 3. EXEMPTION EXPIRY / REVOKE + §10 item 4 PII RENDER PATHS
  // =========================================================================
  const meta = await authedGet('/wizard-templates', alice)
  const LOCKED = [...meta.orgEnforced.map(g => g.id), ...meta.domainEnforced]
  const mk = name => authedPost('/wizard-create', { draft: { template: 'chatbot', projectName: name, description: 'b6 smoke', guardrails: LOCKED } }, carol)
  check('S1 setup: two wizard projects created', (await mk(P_EXP)).ok === true && (await mk(P_REV)).ok === true)

  // §10 item 2 evidence: bootstrap-produced resources carry the full tag set.
  const cfg = JSON.parse(fs.readFileSync(path.join(genDirs[0], 'agentcore', 'agentcore.json'), 'utf8'))
  check('S2 §10-2 bootstrap resources carry domain-id/project-id tags (§3.2 convention)',
    cfg.tags?.['domain-id'] === 'customer-support' && cfg.tags?.['project-id'] === P_EXP &&
    cfg.tags?.['managed-by'] === 'plato-bootstrap')

  const harnessOf = p => JSON.parse(fs.readFileSync(path.join(here, `../domain-examples/generated/${p}/domain-harness.json`), 'utf8'))
  const exReq = (project, reason) => rawPost('/policy-exemption-request', { project, guardrail: 'tone-review', reason }, carol.token)
  const exDecide = (id, s, decision = 'approve', extra = {}) => rawPost('/policy-exemption-decide', { id, decision, ...extra }, s.token)
  const exRevoke = (id, s, reason) => rawPost('/policy-exemption-revoke', { id, ...(reason ? { reason } : {}) }, s.token)
  const queueRow = async (id, s = melanie) => ((await authedGet('/policy-exemptions', s)).exemptions || []).find(x => x.id === id)

  // ---- PII shapes for the render-path sweep (email is NEW vs the B4 probe)
  const PII_EMAIL = 'jane.doe-77@customer-corp.example.com'
  const PII_PHONE = '+44-7911-123456'
  const PII_PASSPORT = 'P9876543'
  const scanRaw = obj => {
    const s = JSON.stringify(obj)
    return [PII_EMAIL, PII_PHONE, PII_PASSPORT].filter(n => s.includes(n))
  }

  // ---- revoke path (P_REV) with the PII-loaded reason
  const xr = await (await exReq(P_REV, `pilot exemption — contact ${PII_EMAIL} or ${PII_PHONE}, passport ${PII_PASSPORT} on file`)).json()
  const RID = xr.exemption?.id
  check('R1 lead requests exemption -> pending_domain', xr.ok === true && !!RID)
  check('R2 §10-4 creation echo masks email+phone+passport', scanRaw(xr).length === 0,
    scanRaw(xr).join(','))
  const l1 = await (await exDecide(RID, melanie)).json()
  check('R3 layer-1 approve -> pending_platform', l1.exemption?.status === 'pending_platform')
  check('R3b §10-4 layer-1 decision echo: zero raw PII', scanRaw(l1).length === 0)

  // approver-chosen TTL validation + stamp
  const badTtl = await exDecide(RID, frank, 'approve', { ttlDays: 9999 })
  check('R4 out-of-range ttlDays -> 400', badTtl.status === 400)
  const l2 = await (await exDecide(RID, frank, 'approve', { ttlDays: 7 })).json()
  check('R5 layer-2 approve stamps expiresAt (approver-chosen 7d TTL)',
    l2.exemption?.status === 'applied' && !!l2.exemption?.expiresAt &&
    Math.abs(new Date(l2.exemption.expiresAt) - Date.now() - 7 * 86400000) < 60000)
  check('R5b effect applied: guardrail out of the harness', !harnessOf(P_REV).guardrails.includes('tone-review'))

  // 403s: same roles that approve — nobody else
  check('R6 builder cannot revoke -> 403', (await exRevoke(RID, alice)).status === 403)
  check('R6b end user cannot revoke -> 403', (await exRevoke(RID, enduser)).status === 403)
  check('R6c wrong-domain builder cannot revoke -> 403', (await exRevoke(RID, bob)).status === 403)

  // §10 item 4: BOTH queue projections masked while the row is applied
  const platQueue = await authedGet('/policy-exemptions', melanie)
  const domQueue = await authedGet('/policy-exemptions', carol)
  check('R7 §10-4 platform queue: zero raw PII across all rows', scanRaw(platQueue).length === 0)
  check('R7b §10-4 domain queue: zero raw PII across all rows', scanRaw(domQueue).length === 0)
  check('R7c masked placeholders present (replaced, not stripped)',
    (platQueue.exemptions || []).find(x => x.id === RID)?.reason?.includes('<EMAIL>'))

  // self-revoke: carol requested it AND revokes it — allowed, audited
  const rv = await (await exRevoke(RID, carol, `pilot done, ping ${PII_EMAIL}`)).json()
  check('R8 owning-domain lead self-revokes her own exemption -> revoked',
    rv.ok === true && rv.exemption?.status === 'revoked' && rv.exemption?.revokedBy === 'carol')
  check('R8b §10-4 revoke echo (incl. free-text note): zero raw PII', scanRaw(rv).length === 0)
  check('R9 revoke is immediate: guardrail restored to the harness', harnessOf(P_REV).guardrails.includes('tone-review'))
  check('R9b harness lineage entry closed with ending=revoked',
    (harnessOf(P_REV).guardrailExemptions || []).some(e => e.exemptionId === RID && e.ending === 'revoked'))
  const rvRow = await queueRow(RID)
  check('R10 revoked row carries revokedBy/revokedAt + history entry',
    rvRow?.revokedBy === 'carol' && !!rvRow?.revokedAt &&
    (rvRow.history || []).some(h => h.action === 'revoked' && h.who === 'carol'))
  const obsA = await authedGet('/obs-audit', melanie)
  check('R10b self-revoke lands on the obs audit trail (never invisible)',
    obsA.events.some(e => e.action === 'exemption-revoked' && e.requestId === RID && e.who === 'carol'))
  check('R11 double revoke -> 409', (await exRevoke(RID, melanie)).status === 409)
  check('R11b deciding a revoked row -> 409', (await exDecide(RID, frank)).status === 409)

  // §10 item 4: audit render paths (obs feed + unified audit trail) stay clean
  check('R12 §10-4 obs-audit feed: zero raw PII', scanRaw(obsA).length === 0)
  const trail = await authedGet('/audit-trail', melanie)
  check('R12b §10-4 unified audit trail: zero raw PII, exemption events present',
    scanRaw(trail).length === 0 && trail.events.some(e => e.requestId === RID))

  // ---- expiry path (P_EXP): default TTL + read-time expiry sweep
  const xe = await (await exReq(P_EXP, 'expiry-path exemption')).json()
  const EID = xe.exemption?.id
  await exDecide(EID, melanie)
  const el2 = await (await exDecide(EID, frank)).json()   // no ttlDays -> default
  check('E1 layer-2 approve without ttlDays stamps the 30d default',
    el2.exemption?.status === 'applied' &&
    Math.abs(new Date(el2.exemption.expiresAt) - Date.now() - 30 * 86400000) < 60000)
  check('E1b effect applied: guardrail out of the harness', !harnessOf(P_EXP).guardrails.includes('tone-review'))

  // Backdate the store row (the server reads the disk store on every access,
  // same trick smoke-gate plays on grant expiry) and let a READ trip expiry.
  const store = JSON.parse(fs.readFileSync(EXEMPT_PATH, 'utf8'))
  store.find(x => x.id === EID).expiresAt = new Date(Date.now() - 60000).toISOString()
  fs.writeFileSync(EXEMPT_PATH, JSON.stringify(store, null, 2))
  const expRow = await queueRow(EID)
  check('E2 expiry honored at READ time: applied row past expiresAt -> expired',
    expRow?.status === 'expired' && !!expRow?.expiredAt &&
    (expRow.history || []).some(h => h.action === 'expired' && h.who === 'system'))
  check('E3 expired exemption stops taking effect: guardrail restored to the harness',
    harnessOf(P_EXP).guardrails.includes('tone-review'))
  check('E3b harness lineage entry closed with ending=expired',
    (harnessOf(P_EXP).guardrailExemptions || []).some(e => e.exemptionId === EID && e.ending === 'expired'))
  check('E4 expiry lands on the obs audit trail',
    (await authedGet('/obs-audit', melanie)).events.some(e => e.action === 'exemption-expired' && e.requestId === EID))
  check('E5 revoking an expired row -> 409', (await exRevoke(EID, melanie)).status === 409)

  // =========================================================================
  // 5. totalWithSharedUsd (P3): arithmetic exact on every response shape
  // =========================================================================
  const roll = await authedGet('/domain-cost-rollup?id=customer-support', carol)
  const exact = (direct, shared, total) => Math.abs(direct + shared - total) < 1e-9
  check('T1 domain rollup: costUsd + sharedAllocatedUsd == totalWithSharedUsd (1e-9)',
    typeof roll.totalWithSharedUsd === 'number' && exact(roll.costUsd, roll.sharedAllocatedUsd, roll.totalWithSharedUsd))
  check('T1b per-layer costUsd stays DIRECT-only (total is strictly larger when shared > 0)',
    roll.sharedAllocatedUsd === 0 || roll.totalWithSharedUsd > roll.costUsd)
  check('T2 every per-project row: exact arithmetic',
    (roll.projects || []).every(p => typeof p.totalWithSharedUsd === 'number' && exact(p.costUsd, p.sharedAllocatedUsd, p.totalWithSharedUsd)))
  const costs = await authedGet('/costs', melanie)
  check('T3 /api/costs domain buckets: exact arithmetic on every row',
    (costs.domains || []).length > 0 &&
    costs.domains.every(d => typeof d.totalWithSharedUsd === 'number' && exact(d.costUsd, d.sharedAllocatedUsd, d.totalWithSharedUsd)))

  // UI footnote on the shared-allocation cost views
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await uiLogin(page, 'carol')
    await page.locator('.nav[data-shellnav="dashboard"]').click()
    await page.waitForSelector('[data-costfootnote]', { timeout: 20000 })
    const note = await page.locator('[data-costfootnote]').first().textContent()
    check('T4 direct-cost footnote renders on the domain cost view',
      /Totals shown are direct costs; shared platform allocation listed separately/.test(note || ''))
    check('T4b totalWithShared figure renders next to the direct+shared line',
      (await page.locator('[data-totalshared]').count()) === 1)
    await page.close()
  }
} finally {
  await browser.close()
  if (projectsSnapshot === null) fs.rmSync(PROJECTS_PATH, { force: true })
  else fs.writeFileSync(PROJECTS_PATH, projectsSnapshot)
  if (exemptSnapshot === null) fs.rmSync(EXEMPT_PATH, { force: true })
  else fs.writeFileSync(EXEMPT_PATH, exemptSnapshot)
  for (const d of genDirs) fs.rmSync(d, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nsmoke-tlp-b6: ALL CHECKS PASSED' : `\nsmoke-tlp-b6: ${failures} CHECK(S) FAILED`)
process.exit(failures ? 1 : 0)
