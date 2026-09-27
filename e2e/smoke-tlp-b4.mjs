// TLP-B4 smoke — 6-step create-project wizard (chunk 1).
//   1. /api/wizard-templates: builder surface (end-user 403), template palette +
//      the policy vocabulary (org tier + domain tier from the TLP-B3 §6.4 store).
//   2. Per-step server validation: /api/wizard-validate rejects bad payloads for
//      every step 1-5 with clear 400s; step 6 covers all; domain never a form field.
//   3. Template differentiation: creating chatbot vs workflow produces MATERIALLY
//      different artifacts (blueprint codebase, instructions.md persona, load.py
//      model, SKILL.md modules, harness manifest) — asserted on the diff.
//   4. Policy step: org/domain-enforced guardrails cannot be dropped (400), and
//      the created harness records the merged locked set.
//   5. No parallel write path: create is capability-gated (end-user 403), rows
//      ride createProjectRow (owner/domain/profileId stamped), member seats ride
//      setProjectMemberCore (unknown principal rejected at validate).
//   6. UI happy path: lead walks all 6 steps in the Domain Console; step 5 shows
//      LOCKED chips; create lands on the project detail.
// Hermetic: unique per-run names; projects.json snapshotted/restored; generated
// dirs removed (smoke-profiles pattern).
// Run: node e2e/smoke-tlp-b4.mjs   (expects console server on :4000)
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
const DOMAIN_POLICY_PATH = path.join(here, '../console/domain-policies.json')
const domainPolicySnapshot = fs.existsSync(DOMAIN_POLICY_PATH) ? fs.readFileSync(DOMAIN_POLICY_PATH, 'utf8') : null

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}
const rawPost = (p, body, token) => fetch(BASE + '/api' + p, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const rawGet = (p, token) => fetch(BASE + '/api' + p, { headers: { authorization: 'Bearer ' + token } })

const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support
const enduser = await apiLogin('enduser')
const melanie = await apiLogin('melanie') // platform admin (peer 1)
const frank = await apiLogin('frank')     // platform admin (peer 2)

const RUN = Date.now().toString(36).slice(-5)
const P_CHAT = `b4chat${RUN}`
const P_FLOW = `b4flow${RUN}`
const P_UI = `b4ui${RUN}`
const genDirs = [P_CHAT, P_FLOW, P_UI].map(p => path.join(here, `../domain-examples/generated/${p}`))
const findFile = (dir, name) => {
  const out = []
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) walk(path.join(d, f.name)); else if (f.name === name) out.push(path.join(d, f.name)) } }
  walk(dir)
  return out
}

const browser = await chromium.launch()
try {
  // ---------- 1. templates + policy vocabulary ----------
  check('W1 unauthenticated wizard-templates -> 401', (await fetch(BASE + '/api/wizard-templates')).status === 401)
  check('W2 end user wizard-templates -> 403 (builder surface)', (await rawGet('/wizard-templates', enduser.token)).status === 403)
  const meta = await authedGet('/wizard-templates', alice)
  const tplIds = (meta.templates || []).map(t => t.id)
  check('W3 builder gets the template palette (chatbot / workflow / custom)',
    meta.ok === true && tplIds.includes('chatbot') && tplIds.includes('workflow') && tplIds.includes('custom'))
  check('W4 templates pre-wire DIFFERENT blueprints/models/picks (not just labels)',
    (() => { const c = meta.templates.find(t => t.id === 'chatbot'), w = meta.templates.find(t => t.id === 'workflow')
      return c.blueprint !== w.blueprint && c.model !== w.model &&
        JSON.stringify(c.skillIds) !== JSON.stringify(w.skillIds) &&
        JSON.stringify(c.defaultGuardrails) !== JSON.stringify(w.defaultGuardrails) })())
  check('W5 policy vocabulary carries the org tier (pii-filter + security-scan-gate)',
    (meta.orgEnforced || []).map(g => g.id).includes('pii-filter') &&
    (meta.orgEnforced || []).map(g => g.id).includes('security-scan-gate'))
  check('W6 domain tier reads the TLP-B3 §6.4 store (customer-support enforces tone-review)',
    Array.isArray(meta.domainEnforced) && meta.domainEnforced.includes('tone-review'))
  const LOCKED = [...meta.orgEnforced.map(g => g.id), ...meta.domainEnforced]

  // ---------- 2. per-step server validation ----------
  const v = (step, draft, s = alice) => rawPost('/wizard-validate', { step, draft }, s.token)
  check('V0 malformed JSON body -> 400', (await rawPost('/wizard-validate', '{not json', alice.token)).status === 400)
  check('V0b step out of range -> 400', (await v(9, {})).status === 400)
  check('V0c end user validate -> 403', (await v(1, {}, enduser)).status === 403)
  const s1a = await v(1, {})
  check('V1 step 1: missing template -> 400 with a clear error',
    s1a.status === 400 && ((await s1a.json()).errors || []).some(e => /template is required/.test(e)))
  check('V1b step 1: unknown template -> 400', (await v(1, { template: 'no-such' })).status === 400)
  check('V1c step 1: valid template -> 200', (await v(1, { template: 'chatbot' })).status === 200)
  check('V2 step 2: missing projectName -> 400', (await v(2, { template: 'chatbot' })).status === 400)
  check('V2b step 2: symbol-only projectName -> 400', (await v(2, { template: 'chatbot', projectName: '!!!' })).status === 400)
  check('V2c step 2: oversize description -> 400',
    (await v(2, { template: 'chatbot', projectName: 'ok1', description: 'x'.repeat(501) })).status === 400)
  check('V3 step 3: custom template without a blueprint -> 400', (await v(3, { template: 'custom' })).status === 400)
  check('V3b step 3: unknown blueprint id -> 400', (await v(3, { template: 'chatbot', blueprint: 'bogus-bp' })).status === 400)
  check('V3c step 3: unknown model id -> 400', (await v(3, { template: 'chatbot', model: 'bogus-model' })).status === 400)
  const s3d = await v(3, { template: 'chatbot', skillIds: ['knowledge_base'] })
  check('V3d step 3: foreign-domain registry pick -> 400 (operations skill, customer-support session)',
    s3d.status === 400 && ((await s3d.json()).errors || []).some(e => /knowledge_base/.test(e)))
  check('V3e step 3: template defaults alone validate -> 200', (await v(3, { template: 'chatbot' })).status === 200)
  check('V4 step 4: unknown principal -> 400', (await v(4, { members: [{ principal: 'ghost', bundle: 'builder' }] }, carol)).status === 400)
  check('V4b step 4: unknown bundle -> 400', (await v(4, { members: [{ principal: 'alice', bundle: 'megaboss' }] }, carol)).status === 400)
  check('V4c step 4: platform-tier bundle from a domain lead -> 400 (R-009 analog)',
    (await v(4, { members: [{ principal: 'alice', bundle: 'admin' }] }, carol)).status === 400)
  check('V4d step 4: a plain builder adding member seats -> 403 (manageProjectMembers)',
    (await v(4, { members: [{ principal: 'carol', bundle: 'builder' }] }, alice)).status === 403)
  const s5a = await v(5, { template: 'chatbot', guardrails: ['tone-review'] })
  check('V5 step 5: dropping an ORG-enforced guardrail -> 400 naming it locked',
    s5a.status === 400 && ((await s5a.json()).errors || []).some(e => /pii-filter.*org-enforced/.test(e)))
  const s5b = await v(5, { template: 'chatbot', guardrails: meta.orgEnforced.map(g => g.id) })
  check('V5b step 5: dropping a DOMAIN-enforced guardrail -> 400 naming it locked',
    s5b.status === 400 && ((await s5b.json()).errors || []).some(e => /tone-review.*domain-enforced/.test(e)))
  check('V5c step 5: unknown guardrail id -> 400', (await v(5, { template: 'chatbot', guardrails: [...LOCKED, 'bogus-guard'] })).status === 400)
  check('V5d step 5: full locked set -> 200', (await v(5, { template: 'chatbot', guardrails: LOCKED })).status === 200)
  check('V6 step 6 re-validates ALL steps (empty draft names template + name + blueprint)',
    await (async () => { const r = await v(6, {}); if (r.status !== 400) return false
      const errs = (await r.json()).errors || []
      return errs.some(e => /template/.test(e)) && errs.some(e => /projectName/.test(e)) && errs.some(e => /blueprint|guardrails/.test(e)) })())
  const vDom = await v(2, { template: 'chatbot', projectName: 'ok2', domain: 'operations' })
  check('V7 client-sent domain is rejected — domain resolves from the session, never the form',
    vDom.status === 400 && ((await vDom.json()).errors || []).some(e => /session/.test(e)))

  // ---------- 3. create: gating + template differentiation ----------
  check('C1 end user wizard-create -> 403', (await rawPost('/wizard-create', { draft: { template: 'chatbot' } }, enduser.token)).status === 403)
  check('C2 incomplete draft create -> 400 (server re-validates, nothing created)',
    (await rawPost('/wizard-create', { draft: { template: 'chatbot' } }, alice.token)).status === 400 &&
    !fs.existsSync(path.join(here, '../domain-examples/generated/undefined')))
  const mkDraft = (template, projectName) => ({ template, projectName, description: `b4 smoke ${template}`, guardrails: LOCKED })
  const mkDraftNoGuardrails = (template, projectName) => ({ template, projectName, description: `b4 smoke ${template}` })
  const mChat = await authedPost('/wizard-create', { draft: { ...mkDraft('chatbot', P_CHAT), members: [{ principal: 'alice', bundle: 'builder' }] } }, carol)
  check('C3 lead creates a chatbot-template project', mChat.ok === true && mChat.project === P_CHAT && mChat.template === 'chatbot')
  const mFlow = await authedPost('/wizard-create', { draft: mkDraftNoGuardrails('workflow', P_FLOW) }, carol)
  check('C4 lead creates a workflow-template project', mFlow.ok === true && mFlow.project === P_FLOW && mFlow.template === 'workflow')

  const dirChat = genDirs[0], dirFlow = genDirs[1]
  const hChat = JSON.parse(fs.readFileSync(path.join(dirChat, 'domain-harness.json'), 'utf8'))
  const hFlow = JSON.parse(fs.readFileSync(path.join(dirFlow, 'domain-harness.json'), 'utf8'))
  check('D1 harness manifests record different BLUEPRINTS (chat-assistant vs workflow-orchestrator)',
    hChat.blueprint === 'chat-assistant' && hFlow.blueprint === 'workflow-orchestrator')
  check('D2 harness manifests record different MODELS', hChat.model !== hFlow.model,
    `${hChat.model} vs ${hFlow.model}`)
  check('D3 harness manifests record different SKILL sets',
    JSON.stringify(hChat.skills.map(s => s.id)) !== JSON.stringify(hFlow.skills.map(s => s.id)))
  check('D4 harness manifests record the template id', hChat.template === 'chatbot' && hFlow.template === 'workflow')
  check('D5 harness guardrails carry the merged locked set on BOTH projects',
    LOCKED.every(g => hChat.guardrails.includes(g)) && LOCKED.every(g => hFlow.guardrails.includes(g)))
  check('D6 workflow template adds its own default guardrail beyond the locked set',
    hFlow.guardrails.includes('rate-limit'))
  check('D6b explicit-selection override semantics: chatbot harness (explicit LOCKED-only guardrails) omits the workflow template default when it is not itself locked',
    meta.domainEnforced.includes('rate-limit') || !hChat.guardrails.includes('rate-limit'))
  const instrChat = fs.readFileSync(findFile(dirChat, 'instructions.md')[0], 'utf8')
  const instrFlow = fs.readFileSync(findFile(dirFlow, 'instructions.md')[0], 'utf8')
  check('D7 generated instructions.md persona DIFFERS (conversational vs step-orchestrator)',
    instrChat !== instrFlow && /conversational assistant/.test(instrChat) && /orchestrate multi-step/.test(instrFlow))
  const modelOf = dir => (fs.readFileSync(findFile(dir, 'load.py')[0], 'utf8').match(/model_id="([^"]*)"/) || [])[1]
  check('D8 generated load.py model_id DIFFERS in the actual code', modelOf(dirChat) !== modelOf(dirFlow),
    `${modelOf(dirChat)} vs ${modelOf(dirFlow)}`)
  const skillsOf = dir => findFile(dir, 'SKILL.md').map(f => path.basename(path.dirname(f))).sort()
  check('D9 shipped SKILL.md modules DIFFER (hr-policy vs data-analysis)',
    JSON.stringify(skillsOf(dirChat)) !== JSON.stringify(skillsOf(dirFlow)),
    `${skillsOf(dirChat)} vs ${skillsOf(dirFlow)}`)
  const chatFiles = findFile(dirChat, 'main.py')[0], flowFiles = findFile(dirFlow, 'main.py')[0]
  check('D10 blueprint codebases differ (different runtime dirs / main.py path)',
    path.relative(dirChat, chatFiles) !== path.relative(dirFlow, flowFiles),
    `${path.relative(dirChat, chatFiles)} vs ${path.relative(dirFlow, flowFiles)}`)

  // ---------- 4. rows ride the normal project pipeline ----------
  const dChat = await authedGet(`/project-detail?id=${P_CHAT}`, carol)
  check('R1 project row carries domain/creator/template (createProjectRow path)',
    dChat.ok === true && dChat.project?.domain === 'customer-support' &&
    dChat.project?.createdBy === 'carol' && dChat.project?.template === 'chatbot')
  check('R2 template profileId lineage stamped on the row (chatbot -> support-agent)',
    dChat.project?.profileId === 'support-agent')
  check('R3 step-4 member seat landed via the shared member core (alice: builder)',
    (dChat.project?.members || []).some(m => m.principal === 'alice' && m.bundle === 'builder'))
  const agent = await authedPost('/agent-detail', { project: P_CHAT }, alice)
  check('R4 created agent answers on the normal agent-detail surface (runnable files)',
    agent.project === P_CHAT && !!agent.runtime)

  // ---------- 5. UI happy path (lead, all 6 steps) ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(page, 'carol')
  await page.locator('.nav[data-shellnav="projects"]').click()
  await page.waitForSelector('#dcprojgo', { timeout: 15000 })
  check('U1 Projects section keeps the Create Project entry point', (await page.locator('#dcprojgo').count()) === 1)
  await page.locator('#dcprojgo').click()
  await page.waitForSelector('[data-wtpl]', { timeout: 15000 })
  check('U2 step 1 renders the template cards', (await page.locator('[data-wtpl]').count()) >= 3)
  check('U3 Continue is disabled until a template is picked', await page.locator('#wnext').isDisabled())
  await page.locator('[data-wtpl="chatbot"]').click()
  await page.locator('#wnext').click()
  await page.waitForSelector('#wname', { timeout: 15000 })
  await page.locator('#wnext').click()   // empty name — server must bounce it
  await page.waitForSelector('#wizstatus .status.err', { timeout: 15000 })
  check('U4 step 2 empty name is rejected by the SERVER (error rendered from the 400)',
    /projectName is required/.test(await page.locator('#wizstatus').innerText()))
  await page.fill('#wname', P_UI)
  await page.locator('#wnext').click()
  await page.waitForSelector('#wbp', { timeout: 15000 })
  check('U5 step 3 pre-seeds the chatbot template blueprint + persona',
    (await page.locator('#wbp').inputValue()) === 'chat-assistant' &&
    /conversational assistant/.test(await page.locator('#wpersona').inputValue()))
  await page.locator('#wnext').click()
  await page.waitForSelector('[data-wmember]', { timeout: 15000 })
  check('U6 step 4 offers the domain member directory', (await page.locator('[data-wmember]').count()) >= 1)
  await page.locator('#wnext').click()
  await page.waitForSelector('[data-wlocked]', { timeout: 15000 })
  const lockedChips = await page.locator('[data-wlocked]').allTextContents()
  check('U7 step 5 shows org-enforced AND domain-enforced guardrails as LOCKED chips',
    lockedChips.some(t => /org-enforced · locked/.test(t)) && lockedChips.some(t => /domain-enforced · locked/.test(t)))
  check('U8 locked guardrails carry no toggle affordance (chips, not .pick items)',
    (await page.locator('[data-wguard][data-wlocked]').count()) === 0)
  await page.locator('#wnext').click()
  await page.waitForSelector('#wcreate', { timeout: 15000 })
  const review = await page.locator('#wizreview').innerText()
  check('U9 step 6 review summarizes template, name and locked guardrails',
    review.includes('chatbot') && review.includes(P_UI) && review.includes('pii-filter'))
  await page.locator('#wcreate').click()
  await page.waitForSelector('#projdetail h1', { timeout: 120000 })
  check('U10 create lands on the project detail', (await page.locator('#projdetail').textContent()).includes(P_UI))
  const uiDetail = await authedGet(`/project-detail?id=${P_UI}`, carol)
  check('U11 UI-created row persisted with the template stamp', uiDetail.ok === true && uiDetail.project?.template === 'chatbot')
  await page.close()

  // ---------- 6. two-layer (4-eyes) guardrail-exemption flow ----------
  // Requester: carol (the ONLY customer-support lead, so layer 1 escalates to
  // the platform peers). Layer 1: melanie. Layer 2: frank. Every blocked
  // attempt must be a 403 AND land on the row's history[] audit array.
  const harnessOf = () => JSON.parse(fs.readFileSync(path.join(genDirs[0], 'domain-harness.json'), 'utf8'))
  const exReq = (body, s = carol) => rawPost('/policy-exemption-request', body, s.token)
  const exDecide = (id, s, decision = 'approve') => rawPost('/policy-exemption-decide', { id, decision }, s.token)
  const exRow = async id => ((await authedGet('/policy-exemptions', melanie)).exemptions || []).find(x => x.id === id)

  check('X1 builder cannot request an exemption -> 403 (lead action)',
    (await exReq({ project: P_CHAT, guardrail: 'tone-review', reason: 'nope' }, alice)).status === 403)
  const xOrg = await exReq({ project: P_CHAT, guardrail: 'pii-filter', reason: 'drop the org tier' })
  check('X2 ORG-enforced guardrail exemption is refused outright (403, never reaches layer 1)',
    xOrg.status === 403 && /org-enforced.*never exemptable/.test((await xOrg.json()).error))
  check('X2b refused org request created NO row',
    !((await authedGet('/policy-exemptions', melanie)).exemptions || []).some(x => x.project === P_CHAT && x.guardrail === 'pii-filter'))
  // a domain-tier option that is NOT currently enforced (store is runtime state)
  const notEnforced = ['pii-strict', 'multilingual-eval', 'rate-limit'].find(g => !meta.domainEnforced.includes(g))
  check('X3 non-domain-enforced guardrail -> 400 (nothing to exempt)',
    (await exReq({ project: P_CHAT, guardrail: notEnforced, reason: 'not enforced here' })).status === 400)

  const xr = await (await exReq({ project: P_CHAT, guardrail: 'tone-review', reason: 'latency-critical pilot, tone eval adds 400ms' })).json()
  const XID = xr.exemption?.id
  check('X4 lead requests a domain-enforced exemption -> pending_domain',
    xr.ok === true && xr.exemption?.status === 'pending_domain' && !!XID)
  check('X4b single-lead domain: layer 1 escalated to the platform peer queue',
    xr.exemption?.layer1Queue === 'platform' &&
    (xr.exemption?.history || []).some(h => h.action === 'requested' && /escalated to platform/.test(h.note || '')))
  check('X4c guardrail still enforced in the harness while pending', harnessOf().guardrails.includes('tone-review'))

  // -- self-approval at layer 1
  const xSelf1 = await exDecide(XID, carol)
  check('X5 requester deciding her own request at LAYER 1 -> 403',
    xSelf1.status === 403 && /different people/.test((await xSelf1.json()).error))
  check('X5b blocked layer-1 self-approval is AUDITED on the row history',
    ((await exRow(XID)).history || []).some(h => h.action === 'self-approval-blocked' && h.who === 'carol'))

  // -- layer 1 approved by melanie: state advances, effect must NOT apply yet
  const xL1 = await (await exDecide(XID, melanie)).json()
  check('X6 layer-1 approval by a distinct platform peer -> pending_platform',
    xL1.ok === true && xL1.exemption?.status === 'pending_platform' && xL1.exemption?.layer1DecidedBy === 'melanie')
  check('X6b EFFECT DOES NOT APPLY at layer 1 — guardrail still enforced in the harness',
    harnessOf().guardrails.includes('tone-review'))

  // -- self-approval at layer 2
  const xSelf2 = await exDecide(XID, carol)
  check('X7 requester deciding her own request at LAYER 2 -> 403',
    xSelf2.status === 403 && /different people/.test((await xSelf2.json()).error))
  check('X7b blocked layer-2 self-approval is AUDITED on the row history',
    ((await exRow(XID)).history || []).filter(h => h.action === 'self-approval-blocked' && h.who === 'carol').length === 2)

  // -- same approver on both layers
  const xDup = await exDecide(XID, melanie)
  check('X8 the layer-1 approver deciding layer 2 too -> 403 (two distinct humans required)',
    xDup.status === 403 && /already decided layer 1/.test((await xDup.json()).error))
  check('X8b blocked duplicate-approver attempt is AUDITED on the row history',
    ((await exRow(XID)).history || []).some(h => h.action === 'duplicate-approver-blocked' && h.who === 'melanie'))
  check('X8c effect still NOT applied after the blocked attempts', harnessOf().guardrails.includes('tone-review'))

  // -- lead without decideBreakGlass cannot decide the platform-escalated layer
  check('X9 a domain lead cannot decide a platform-queue layer -> 403',
    (await exDecide(XID, carol, 'reject')).status === 403)

  // -- legitimate second approver: NOW (and only now) the effect applies
  const xL2 = await (await exDecide(XID, frank)).json()
  check('X10 layer-2 approval by a SECOND distinct admin -> applied',
    xL2.ok === true && xL2.exemption?.status === 'applied' && xL2.exemption?.layer2DecidedBy === 'frank')
  check('X10b EFFECT applies only at `applied`: guardrail now removed from the harness',
    !harnessOf().guardrails.includes('tone-review'))
  check('X10c harness records the exemption lineage (guardrailExemptions -> request id)',
    (harnessOf().guardrailExemptions || []).some(e => e.guardrail === 'tone-review' && e.exemptionId === XID))
  check('X10d org-enforced guardrails survived untouched',
    harnessOf().guardrails.includes('pii-filter') && harnessOf().guardrails.includes('security-scan-gate'))
  const finalRow = await exRow(XID)
  check('X11 history[] carries the FULL audit: request, 2 blocked self-approvals, L1, blocked dup, L2',
    ['requested', 'self-approval-blocked', 'layer1-approved', 'duplicate-approver-blocked', 'layer2-approved-applied']
      .every(a => (finalRow.history || []).some(h => h.action === a)) && (finalRow.history || []).length >= 6)
  check('X12 deciding an already-applied request -> 409', (await exDecide(XID, frank)).status === 409)

  // -- a REJECT at layer 1 never reaches layer 2
  const xr2 = await (await exReq({ project: P_FLOW, guardrail: 'tone-review', reason: 'second try' })).json()
  const xRej = await (await exDecide(xr2.exemption.id, melanie, 'reject')).json()
  check('X13 layer-1 reject -> rejected_domain, and the guardrail stays in the harness',
    xRej.exemption?.status === 'rejected_domain' &&
    JSON.parse(fs.readFileSync(path.join(genDirs[1], 'domain-harness.json'), 'utf8')).guardrails.includes('tone-review'))
  check('X14 end user cannot read the exemption queue -> 403',
    (await rawGet('/policy-exemptions', enduser.token)).status === 403)

  // ---------- 7. R-B4-03: exemption `reason` masked at EVERY egress ----------
  // R-014 family, 3rd recurrence (grant purpose -> B3 justification -> B4
  // exemption reason). Whole-JSON scan for zero raw leakage on every response
  // shape that echoes an exemption row: creation echo, admin queue GET, and
  // both decision responses (incl. history[] notes).
  const PII_PHONE = '+61-498-765-432', PII_PASSPORT = 'N1234567'
  const scanRaw = (obj, needle) => JSON.stringify(obj).includes(needle)
  const xrPii = await (await exReq({ project: P_FLOW, guardrail: 'tone-review',
    reason: `pilot needs it, contact ${PII_PHONE} passport ${PII_PASSPORT} on file` })).json()
  const XPID = xrPii.exemption?.id
  check('X15 creation echo masks phone+passport in `reason` (placeholders present, raw absent)',
    xrPii.exemption?.reason?.includes('<PHONE>') && xrPii.exemption?.reason?.includes('<PASSPORT>') &&
    !scanRaw(xrPii, PII_PHONE) && !scanRaw(xrPii, PII_PASSPORT))

  const adminQueue = await authedGet('/policy-exemptions', melanie)
  const leadQueue = await authedGet('/policy-exemptions', carol)
  check('X16 admin GET /api/policy-exemptions: zero raw leakage across ALL rows',
    !scanRaw(adminQueue, PII_PHONE) && !scanRaw(adminQueue, PII_PASSPORT))
  check('X16b lead-visible domain queue: zero raw leakage',
    !scanRaw(leadQueue, PII_PHONE) && !scanRaw(leadQueue, PII_PASSPORT))
  check('X16c admin queue row still carries the masked placeholders (not stripped, replaced)',
    (adminQueue.exemptions || []).find(x => x.id === XPID)?.reason?.includes('<PHONE>'))

  const xPiiL1 = await (await exDecide(XPID, melanie)).json()
  check('X17 post-layer-1 decision response: zero raw leakage (reason echoed in the row)',
    !scanRaw(xPiiL1, PII_PHONE) && !scanRaw(xPiiL1, PII_PASSPORT) &&
    xPiiL1.exemption?.reason?.includes('<PHONE>'))

  // decision `note` (user free text on the decide call) also lands in history[]
  // and must be masked at every future echo — layer 2 approve carries a note.
  const xPiiL2 = await (await rawPost('/policy-exemption-decide',
    { id: XPID, decision: 'approve', reason: `approved, backup contact ${PII_PHONE}` }, frank.token)).json()
  check('X18 post-layer-2 decision response: zero raw leakage incl. the decision note',
    !scanRaw(xPiiL2, PII_PHONE) &&
    (xPiiL2.exemption?.history || []).some(h => h.action === 'layer2-approved-applied' && (h.note || '').includes('<PHONE>')))
  check('X18b history[] as a whole carries zero raw PII across every entry',
    !scanRaw(xPiiL2.exemption?.history, PII_PHONE) && !scanRaw(xPiiL2.exemption?.history, PII_PASSPORT))

  const finalQueue = await authedGet('/policy-exemptions', melanie)
  check('X19 final admin queue re-read: zero raw leakage (idempotent masking, not one-shot)',
    !scanRaw(finalQueue, PII_PHONE) && !scanRaw(finalQueue, PII_PASSPORT))

  // RAW must still be in the store on disk (hermetic, mirrors the grant pattern) —
  // masking is a view concern only, never a write-time mutation.
  const rawStore = JSON.parse(fs.readFileSync(EXEMPT_PATH, 'utf8'))
  const rawRow = rawStore.find(x => x.id === XPID)
  check('X20 RAW store on disk still holds the ORIGINAL unmasked reason + decision note',
    rawRow?.reason?.includes(PII_PHONE) && rawRow?.reason?.includes(PII_PASSPORT) &&
    (rawRow?.history || []).some(h => (h.note || '').includes(PII_PHONE)))

  // idempotent-existing-open-request echo (X4-style re-request) also masked
  const xrPiiAgain = await (await exReq({ project: P_FLOW, guardrail: 'tone-review', reason: 'second try' })).json()
  check('X21 sanity: unrelated non-PII reason unaffected by masking (no accidental corruption)',
    xrPiiAgain.exemption?.reason === 'second try' || xrPiiAgain.existing === true)
} finally {
  await browser.close()
  if (projectsSnapshot === null) fs.rmSync(PROJECTS_PATH, { force: true })
  else fs.writeFileSync(PROJECTS_PATH, projectsSnapshot)
  if (exemptSnapshot === null) fs.rmSync(EXEMPT_PATH, { force: true })
  else fs.writeFileSync(EXEMPT_PATH, exemptSnapshot)
  if (domainPolicySnapshot === null) fs.rmSync(DOMAIN_POLICY_PATH, { force: true })
  else fs.writeFileSync(DOMAIN_POLICY_PATH, domainPolicySnapshot)
  for (const d of genDirs) fs.rmSync(d, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
