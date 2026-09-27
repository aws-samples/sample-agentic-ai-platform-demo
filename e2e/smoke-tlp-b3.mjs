// TLP-B3 smoke — Domain Admin Console deepening (spec §6 + §9 domain side).
//   1. Dashboard aggregates: /api/domain-cost-rollup + /api/domain-health are
//      domain-scoped (cross-domain 403, builder 403 on rollup, end-user 403).
//   2. Projects cards: /api/domain-projects full fields; P2 fixes — rendered
//      cards say "1 agent" (never "1 agents") and never show "backfill".
//   3. Users & Access matrix: /api/domain-users domain-scoped; assign/revoke
//      rides the capability-gated member routes (builder 403, foreign 404).
//   4. Governance & Approvals: approve/reject with requester≠approver
//      (self-approval 403), escalated-to-platform rows are READ-ONLY for the
//      lead (grant-decide 404), Domain Policy persists + is lead-only.
//   5. D6 justification PII masking: email + phone + AWS key + bearer token in
//      a justification are masked in EVERY list/detail response.
// Hermetic: every grant this file creates is decided/rejected at the end;
// domain-policies.json and projects.json are snapshotted and restored.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
const here = path.dirname(fileURLToPath(import.meta.url))
const POLICY_PATH = path.join(here, '../console/domain-policies.json')
const PROJECTS_PATH = path.join(here, '../console/projects.json')
const policySnapshot = existsSync(POLICY_PATH) ? readFileSync(POLICY_PATH, 'utf8') : null
const projectsSnapshot = existsSync(PROJECTS_PATH) ? readFileSync(PROJECTS_PATH, 'utf8') : null

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

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const bob = await apiLogin('bob')       // builder, operations
const carol = await apiLogin('carol')   // lead, customer-support
const enduser = await apiLogin('enduser')
const RUN = 'b3-' + Date.now().toString(36)
const cleanupIds = []   // [requestId, deciderSession]

try {
  // ---------- 1. Dashboard aggregates ----------
  const roll = await authedGet('/domain-cost-rollup?id=customer-support', carol)
  check('D1 lead reads her domain cost rollup (per-project rows, ledger-derived)',
    roll.ok === true && Array.isArray(roll.projects) && roll.projects.some(p => p.id === 'supportdesk' && p.costUsd > 0))
  check('D1b rollup rows resolve a real owner (never "backfill")',
    roll.projects.every(p => p.owner !== 'backfill'))
  check('D2 cross-domain rollup -> 403', (await rawGet('/domain-cost-rollup?id=operations', carol.token)).status === 403)
  check('D3 builder rollup -> 403 (lead/admin surface)', (await rawGet('/domain-cost-rollup?id=customer-support', alice.token)).status === 403)
  check('D4 unknown domain -> 404', (await rawGet('/domain-cost-rollup?id=nope', carol.token)).status === 404)
  const health = await authedGet('/domain-health?id=customer-support', carol)
  check('D5 domain health summary counts agents by status',
    health.ok === true && health.total >= 1 && typeof health.byHealth.healthy === 'number' &&
    health.total === health.byHealth.healthy + health.byHealth.degraded + health.byHealth.suspended + health.byHealth.undeployed)
  check('D6 cross-domain health -> 403', (await rawGet('/domain-health?id=operations', carol.token)).status === 403)
  check('D7 end-user health -> 403', (await rawGet('/domain-health?id=customer-support', enduser.token)).status === 403)
  const adminRoll = await authedGet('/domain-cost-rollup?id=operations', admin)
  check('D8 admin (look-across) reads any domain rollup', adminRoll.ok === true && adminRoll.domain === 'operations')

  // ---------- 2. Projects cards (server fields) ----------
  const dp = await authedGet('/domain-projects?id=customer-support', carol)
  check('P1 domain-projects returns full card fields (type/env/compliance/owner/createdAt)',
    dp.ok === true && dp.projects.length > 0 && dp.projects.every(p =>
      'type' in p && p.env && 'nonprod' in p.env && 'prod' in p.env && 'compliance' in p && 'owner' in p && 'createdAt' in p))
  check('P2 env lights are SEPARATE signals with the light vocabulary',
    dp.projects.every(p => ['green', 'amber', 'red', 'none'].includes(p.env.nonprod) && ['green', 'red', 'none'].includes(p.env.prod)))
  check('P3 owner is resolved, never the "backfill" placeholder',
    dp.projects.every(p => p.owner !== 'backfill'))
  const deployed = dp.projects.find(p => p.id === 'supportdesk')
  check('P4 deployed project carries a type badge + a live non-prod light',
    !!deployed && deployed.type === 'Chatbot' && deployed.env.nonprod !== 'none')
  check('P5 cross-domain projects -> 403', (await rawGet('/domain-projects?id=operations', carol.token)).status === 403)
  // /api/projects + /api/my-projects both leave with owner resolved (P2 platform-wide)
  const projList = await authedGet('/projects', admin)
  check('P6 /api/projects rows carry resolved owner (platform-wide fix)',
    (projList.projects || []).every(p => p.owner && p.owner !== 'backfill'))
  const mine = await authedGet('/my-projects', alice)
  check('P7 /api/my-projects rows carry resolved owner', (mine.projects || []).every(p => p.owner !== 'backfill'))

  // ---------- 3. Users & Access matrix ----------
  const ua = await authedGet('/domain-users?id=customer-support', carol)
  check('U1 matrix data: domain users × projects with members', ua.ok === true &&
    ua.users.some(u => u.id === 'alice') && ua.projects.some(p => p.id === 'supportdesk') && ua.canManage === true)
  check('U2 matrix lists ONLY this domain\'s projects',
    ua.projects.every(p => (dp.projects || []).some(x => x.id === p.id)))
  check('U3 cross-domain matrix -> 403 (carol cannot see operations users)',
    (await rawGet('/domain-users?id=operations', carol.token)).status === 403)
  check('U4 builder matrix read is scoped but canManage=false',
    (await authedGet('/domain-users?id=customer-support', alice)).canManage === false)
  // assign via the SAME gated member route the matrix uses
  const assign = await authedPost('/project-member-set', { projectId: 'returns-bot', principal: 'bob', bundle: 'builder' }, carol)
  check('U5 lead assigns access through the matrix write path', assign.ok === true &&
    (assign.project.members || []).some(m => m.principal === 'bob' && m.bundle === 'builder'))
  check('U6 builder member-write -> 403',
    (await rawPost('/project-member-set', { projectId: 'returns-bot', principal: 'bob', bundle: 'builder' }, alice.token)).status === 403)
  check('U7 foreign-domain member-write -> 404 (no existence oracle)',
    (await rawPost('/project-member-set', { projectId: 'opsassistant', principal: 'bob', bundle: 'builder' }, carol.token)).status === 404)
  const revoke = await authedPost('/project-member-remove', { projectId: 'returns-bot', principal: 'bob' }, carol)
  check('U8 lead revokes the same seat', revoke.ok === true && !(revoke.project.members || []).some(m => m.principal === 'bob'))

  // ---------- 4. Governance & Approvals ----------
  // pending queue + decide, requester ≠ approver
  const req = await authedPost('/grant-request', { resourceType: 'tool', resourceId: `${RUN}-tool`, purpose: 'B3 smoke: queue decision', durationS: 300 }, alice)
  check('G1 builder request lands in the domain queue', req.ok === true && req.request.domain === 'customer-support')
  // FIXED resourceId: a single-lead domain has no second decider for carol's
  // own tool request, so this pending row cannot be cleaned up — the fixed id
  // makes re-runs reuse it idempotently instead of accumulating one per run
  // (same pattern as smoke-grants' self-approval-probe).
  const carolOwn = await authedPost('/grant-request', { resourceType: 'tool', resourceId: 'b3-self-approval-probe', purpose: 'B3 smoke: self-approval probe', durationS: 300 }, carol)
  check('G2 SELF-APPROVAL -> 403 (requester ≠ approver, server-side)',
    (await rawPost('/grant-decide', { requestId: carolOwn.request.id, decision: 'approve' }, carol.token)).status === 403)
  const approve = await authedPost('/grant-decide', { requestId: req.request.id, decision: 'approve' }, carol)
  check('G3 lead approves another requester\'s row', approve.ok === true && approve.request.status === 'approved' && approve.request.decidedBy === 'carol')
  // (the approved grant is keyed on this run's unique resourceId and expires
  //  on its own — no cross-run collision surface)
  check('G4 non-lead decide -> 403',
    (await rawPost('/grant-decide', { requestId: carolOwn.request.id, decision: 'approve' }, alice.token)).status === 403)

  // escalated-to-platform rows: read-only tracking for the lead
  const mems = await authedGet('/memories', carol)
  const csMem = (mems.memories || []).find(m => m.domain === 'customer-support')
  check('G5 fixture: a customer-support memory store exists', !!csMem, csMem?.id || 'none')
  if (csMem) {
    const esc = await authedPost('/grant-request', { resourceType: 'memory', resourceId: csMem.id, purpose: 'B3 smoke: single-lead escalation tracking', durationS: 300 }, carol)
    check('G6 single-lead own-domain memory request escalates to the platform queue (spec §9 v2.2)',
      esc.ok === true && esc.request.domain === 'platform')
    const track = await authedGet('/domain-escalations?id=customer-support', carol)
    const row = (track.requests || []).find(r => r.id === esc.request.id)
    check('G7 escalated row shows in the domain\'s READ-ONLY tracker (readOnly flag, status visible)',
      !!row && row.readOnly === true && row.status === 'pending')
    check('G8 the lead CANNOT decide the escalated row (404 — platform peers only)',
      (await rawPost('/grant-decide', { requestId: esc.request.id, decision: 'approve' }, carol.token)).status === 404)
    check('G9 builder escalation tracker -> 403 (lead/admin surface)',
      (await rawGet('/domain-escalations?id=customer-support', alice.token)).status === 403)
    check('G10 cross-domain escalation tracker -> 403',
      (await rawGet('/domain-escalations?id=operations', carol.token)).status === 403)
    cleanupIds.push([esc.request.id, admin])
  }

  // Domain Policy: persists, lead-only write, org tier immutable
  const pol0 = await authedGet('/domain-policy?id=customer-support', carol)
  check('G11 domain policy read: org-enforced (locked) + domain options + current set',
    pol0.ok === true && pol0.orgEnforced.length >= 1 && pol0.options.length >= 1 && Array.isArray(pol0.enforced) && pol0.canEdit === true)
  const before = pol0.enforced
  const want = [...new Set([...before, 'rate-limit'])]
  const wr = await authedPost('/domain-policy', { domain: 'customer-support', enforced: want }, carol)
  check('G12 lead updates the domain-enforced list', wr.ok === true && wr.enforced.includes('rate-limit'))
  const pol1 = await authedGet('/domain-policy?id=customer-support', carol)
  check('G13 domain policy PERSISTS (re-read shows the write + updatedBy)',
    pol1.enforced.includes('rate-limit') && pol1.updatedBy === 'carol')
  check('G14 builder policy write -> 403',
    (await rawPost('/domain-policy', { domain: 'customer-support', enforced: [] }, alice.token)).status === 403)
  check('G15 foreign-lead policy write -> 403 (bob is operations)',
    (await rawPost('/domain-policy', { domain: 'customer-support', enforced: [] }, bob.token)).status === 403)
  check('G16 admin policy write -> 403 (owning lead only)',
    (await rawPost('/domain-policy', { domain: 'customer-support', enforced: [] }, admin.token)).status === 403)
  check('G17 org-tier guardrail id rejected from the domain tier',
    (await rawPost('/domain-policy', { domain: 'customer-support', enforced: ['pii-filter'] }, carol.token)).status === 400)
  await authedPost('/domain-policy', { domain: 'customer-support', enforced: before }, carol)   // restore

  // ---------- 5. D6 justification PII masking (adversarial) ----------
  const PII = `B3 adversarial: reach me at jane.doe@corp.example or +1 (415) 555-0182, ci key AKIAIOSFODNN7EXAMPLE, token sk-live_abcdef1234567890, backup ghp_A1b2C3d4E5f6G7h8`
  const LEAKS = ['jane.doe@corp.example', '555-0182', 'AKIAIOSFODNN7EXAMPLE', 'sk-live_abcdef1234567890', 'ghp_A1b2C3d4E5f6G7h8']
  const scan = (s) => LEAKS.filter(l => String(s).includes(l))
  const prq = await authedPost('/grant-request', { resourceType: 'tool', resourceId: `${RUN}-pii`, purpose: PII, durationS: 300 }, alice)
  check('M1 PII-bearing justification accepted (input not rejected)', prq.ok === true)
  check('M2 POST echo is masked', scan(prq.request.purpose).length === 0, prq.request.purpose)
  cleanupIds.push([prq.request.id, carol])
  for (const [who, s] of [['carol (domain queue)', carol], ['melanie (platform queue)', admin], ['alice (requester list)', alice]]) {
    const rows = (await authedGet('/grant-requests', s)).requests || []
    const row = rows.find(r => r.resourceId === `${RUN}-pii`)
    check(`M3 ${who}: justification masked in the list view`, !!row && scan(row.purpose).length === 0,
      row ? scan(row.purpose).join(',') || 'clean' : 'row missing')
  }
  const legacy = (await authedGet('/obs-access-requests', carol)).requests || []
  const legacyRow = legacy.find(r => r.resourceId === `${RUN}-pii`)
  check('M4 legacy queue facade: justification masked', !legacyRow || scan(legacyRow.justification).length === 0)
  const audit = (await authedGet('/obs-audit', carol)).events || []
  const auditLeaks = audit.flatMap(e => scan(JSON.stringify(e)))
  check('M5 audit log carries NO raw justification PII (grant rows are purpose-free by contract)', auditLeaks.length === 0, auditLeaks.join(','))
  check('M6 masked spans use full-span placeholders (no partial leak of the AWS key prefix)',
    !String(prq.request.purpose).includes('AKIA'))

  // ---------- 5b. R-B3-01: international phone + 7-digit passport (independent review's floor) ----------
  const PII2 = `R-B3-01 probe: AU mobile +61-412-345-678, passport N1234567, also NANP +1 (415) 555-0199, ` +
    `9-char passport A12345678, card 4111111111111111, ssn 123-45-6789, iban GB29NWBK60161331926819, ` +
    `email carol.lead@corp.example, and audit trail refs express-4.18.2 and lodash@4.17.21 must survive untouched`
  const LEAKS2 = ['+61-412-345-678', 'N1234567', '415) 555-0199', 'A12345678', '4111111111111111',
    '123-45-6789', 'GB29NWBK60161331926819', 'carol.lead@corp.example']
  const scan2 = (s) => LEAKS2.filter(l => String(s).includes(l))
  const prq2 = await authedPost('/grant-request', { resourceType: 'tool', resourceId: `${RUN}-pii2`, purpose: PII2, durationS: 300 }, alice)
  check('N1 R-B3-01 justification accepted', prq2.ok === true)
  const maskedPurpose2 = String(prq2.request.purpose)
  check('N2 AU international phone masked as <PHONE>', scan2(maskedPurpose2).length === 0 &&
    !maskedPurpose2.includes('+61-412-345-678'), maskedPurpose2)
  check('N3 7-digit passport (N1234567) fully masked as <PASSPORT>', !maskedPurpose2.includes('N1234567'), maskedPurpose2)
  check('N4 regression: NANP phone still masks', !maskedPurpose2.includes('415) 555-0199'), maskedPurpose2)
  check('N5 regression: 9-char (1+8) passport still masks', !maskedPurpose2.includes('A12345678'), maskedPurpose2)
  check('N6 regression: 16-digit card masks as <CARD> (not fragmented by PHONE)',
    !maskedPurpose2.includes('4111111111111111') && maskedPurpose2.includes('<CARD>'), maskedPurpose2)
  check('N7 regression: SSN still masks', !maskedPurpose2.includes('123-45-6789'), maskedPurpose2)
  check('N8 regression: IBAN still masks', !maskedPurpose2.includes('GB29NWBK60161331926819'), maskedPurpose2)
  check('N9 regression: email still masks', !maskedPurpose2.includes('carol.lead@corp.example'), maskedPurpose2)
  check('N10 no false positive: pkg@version audit-trail strings survive untouched',
    maskedPurpose2.includes('express-4.18.2') && maskedPurpose2.includes('lodash@4.17.21'), maskedPurpose2)
  cleanupIds.push([prq2.request.id, carol])
  const rows2 = (await authedGet('/grant-requests', carol)).requests || []
  const row2 = rows2.find(r => r.resourceId === `${RUN}-pii2`)
  check('N11 domain queue list view: same masking holds', !!row2 && scan2(row2.purpose).length === 0,
    row2 ? row2.purpose : 'row missing')

  // ---------- 6. Rendered-card P2 assertions (browser) ----------
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(BASE)
    await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), carol)
    await page.goto(BASE)
    await page.waitForSelector('#dcbody', { timeout: 15000 })
    await page.locator('.nav[data-shellnav="projects"]').click()
    await page.waitForSelector('#dccreate', { timeout: 15000 })
    await page.waitForFunction(() => !document.querySelector('#dcbody .spin'), null, { timeout: 15000 }).catch(() => {})
    const cardsText = await page.locator('#dcbody').innerText()
    check('R1 rendered cards pluralize counts ("1 agent", never "1 agents")',
      !/\b1 (agents|members|projects|users)\b/.test(cardsText))
    check('R2 rendered cards never show the "backfill" placeholder', !cardsText.includes('backfill'))
    check('R3 cards carry the full field set (type badge, env lights, compliance, owner, created)',
      /non-prod/.test(cardsText) && /prod/.test(cardsText) && /complian/i.test(cardsText) && /owner:/.test(cardsText) && /created:/.test(cardsText))
    // dashboard chips render from the new aggregates
    await page.locator('.nav[data-shellnav="dashboard"]').click()
    await page.waitForFunction(() => /Cost control/i.test(document.querySelector('#dcbody')?.innerText || ''), null, { timeout: 15000 })
    const dashText = await page.locator('#dcbody').innerText()
    check('R4 dashboard shows the health summary + per-project cost table',
      /Domain health/i.test(dashText) && /healthy/i.test(dashText) && /supportdesk/.test(dashText) && /Budget burn/i.test(dashText))
    check('R5 dashboard pluralizes too', !/\b1 (agents|projects)\b/.test(dashText))
    // governance: three same-page sections
    await page.locator('.nav[data-shellnav="governance"]').click()
    // the three same-page sections load independently — wait for ALL of them
    await page.waitForFunction(() => {
      const t = document.querySelector('main')?.innerText || ''
      return /Domain Policy/i.test(t) && /Escalated to Platform/i.test(t) && /Pending/i.test(t)
    }, null, { timeout: 15000 })
    const govText = await page.locator('main').innerText()
    check('R6 Governance & Approvals carries queue + read-only escalations + domain policy on one page',
      /Pending/i.test(govText) && /Escalated to Platform/i.test(govText) && /read-only/i.test(govText) && /Domain Policy/i.test(govText))
    check('R7 escalated section renders NO decision buttons',
      (await page.locator('#dcescalations .req-decide, #dcescalations button').count()) === 0)
    await page.close()
  } finally {
    await browser.close()
  }
} finally {
  // hermeticity: decide away every pending row this run created
  for (const [id, decider] of cleanupIds) {
    await authedPost('/grant-decide', { requestId: id, decision: 'reject' }, decider).catch(() => {})
  }
  // restore the policy + projects stores exactly as found
  if (policySnapshot != null) writeFileSync(POLICY_PATH, policySnapshot)
  else if (existsSync(POLICY_PATH)) unlinkSync(POLICY_PATH)
  if (projectsSnapshot != null) writeFileSync(PROJECTS_PATH, projectsSnapshot)
}

console.log(failures === 0 ? '\nsmoke-tlp-b3: ALL PASS' : `\nsmoke-tlp-b3: ${failures} FAILED`)
process.exit(failures ? 1 : 0)
