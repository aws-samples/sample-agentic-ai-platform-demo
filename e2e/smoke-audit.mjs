// G9 smoke: unified Audit page (decision record §7 ④). ONE chronological
// timeline over both audit stores — governance decisions (hitl-audit) and
// content-access events (obs-audit: grant lifecycle, break-glass reads,
// member changes, bundle edits). Capability-gated (viewAuditTrail: admin/lead
// only), domain-scoped server-side (filters never widen), rows are a fixed
// metadata projection, and the one content-ish field (toolInputSummary) is
// masked per-session exactly like /api/hitl-audit.
// Run: node e2e/smoke-audit.mjs   (expects console server on :4000)
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { apiLogin, authedGet, authedPost, uiLogin } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failures++ }
const rawGet = (p, token) =>
  fetch(BASE + '/api' + p, token ? { headers: { authorization: 'Bearer ' + token } } : {})

const admin = await apiLogin('melanie')
const alice = await apiLogin('alice')   // builder, customer-support
const carol = await apiLogin('carol')   // lead, customer-support
const bob = await apiLogin('bob')       // builder, operations
const enduser = await apiLogin('enduser')

// Unique per-run ids — the grant store is in-memory and accumulates across
// suite runs on a long-lived server.
const RUN = `audit-${process.pid}-${Date.now().toString(36)}`
const EMAIL = `${RUN}@example.com`

// Snapshot + restore projects.json (member add/remove seeds an audit event).
const projPath = new URL('../console/projects.json', import.meta.url).pathname
let projSnap = null
try { projSnap = readFileSync(projPath, 'utf8') } catch { /* store not created yet */ }
// Snapshot + restore the COMMITTED bundles config too — the R-007 round-trip
// save below rewrites the file byte-differently (no trailing newline).
const bundlesPath = new URL('../console/capability-bundles.json', import.meta.url).pathname
const bundlesSnap = readFileSync(bundlesPath, 'utf8')

try {
  // Self-heal: drop any live admin memory grant from a crashed earlier run.
  await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, admin)
  // Self-heal: remove stale policies from a crashed earlier run.
  for (const p of ((await authedGet('/hitl', admin)).policies || []).filter(p => p.name.startsWith('SmokeAuditPolicy'))) {
    await authedPost('/hitl-policy-remove', { id: p.id }, admin)
  }

  // ---------- gating: capability, not persona nav ----------
  check('anon audit trail -> 401', (await rawGet('/audit-trail')).status === 401)
  check('end user audit trail -> 403', (await rawGet('/audit-trail', enduser.token)).status === 403)
  check('builder audit trail -> 403 (viewAuditTrail is admin/lead only)',
    (await rawGet('/audit-trail', alice.token)).status === 403)

  // ---------- seed one event of each class ----------
  // (1) grant lifecycle: request + approve in customer-support, request-only in operations.
  const csReq = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: `${RUN}-cs-tool`, purpose: 'G9 smoke: cs grant', durationS: 3600 }, alice)).request
  await authedPost('/grant-decide', { requestId: csReq.id, decision: 'approve' }, carol)
  const opsReq = (await authedPost('/grant-request', { resourceType: 'tool', resourceId: `${RUN}-ops-tool`, purpose: 'G9 smoke: ops-domain row', durationS: 3600 }, bob)).request
  check('seed: grant events created', !!csReq?.id && !!opsReq?.id)

  // (2) break-glass read: admin memory grant -> content read -> audited read.
  const BG_PURPOSE = 'G9 smoke: break-glass row for the audit page'
  const bgReq = (await authedPost('/grant-request', { resourceType: 'memory', resourceId: 'supportdesk-memory-seed', purpose: BG_PURPOSE, durationS: 3600 }, admin)).request
  await authedPost('/grant-decide', { requestId: bgReq.id, decision: 'approve' }, carol)
  await authedGet('/memory-extractions?memoryId=supportdesk-memory-seed', admin)

  // (3) member change: add + remove -> two audit events, store back to start.
  const csProject = ((await authedGet('/projects', carol)).projects || [])[0]
  if (csProject) {
    await authedPost('/project-member-set', { projectId: csProject.id, principal: 'frank', bundle: 'builder' }, carol)
    await authedPost('/project-member-remove', { projectId: csProject.id, principal: 'frank' }, carol)
  }

  // (4) bundle-definition edit (independent review R-007): a no-op round-trip save still audits.
  const cfg = (await authedGet('/capability-bundles', admin)).config
  await authedPost('/capability-bundles', { config: cfg }, admin)

  // (5) governance interrupt carrying PII in the tool input.
  await authedPost('/hitl-policy-create', { name: `SmokeAuditPolicy${RUN.slice(-6)}`, toolMatch: [`${RUN}_probe_*`] }, admin)
  await authedPost('/hitl-interrupt', { project: 'supportdesk', toolName: `${RUN}_probe_delete`, toolInput: `customer email ${EMAIL}` }, admin)

  // ---------- the unified trail (admin: everything) ----------
  const trail = (await authedGet('/audit-trail', admin))
  check('admin trail answers with events + type inventory', trail.ok === true && Array.isArray(trail.events) && Array.isArray(trail.types))
  const ev = trail.events
  check('grant decision lands in the trail (access-approved with request id)',
    ev.some(e => e.stream === 'access' && e.action === 'access-approved' && e.requestId === csReq.id && e.domain === 'customer-support'))
  check('break-glass read lands in the trail with purpose + domain',
    ev.some(e => e.action === 'break-glass-read' && e.who === 'melanie' && e.requestId === bgReq.id && e.detail === BG_PURPOSE && e.domain === 'customer-support'))
  check('member change lands in the trail', !csProject ||
    ev.some(e => e.type === 'project' && e.action === 'member-added' && String(e.subject || '').includes('frank')))
  check('bundle-definition edit is audited (independent review R-007 closed)',
    ev.some(e => e.type === 'capability-bundles' && e.action === 'bundles-updated' && e.who === 'melanie'))
  const gov = ev.find(e => e.stream === 'governance' && e.type === 'interrupt' && String(e.subject || '').includes(`${RUN}_probe_delete`))
  check('governance interrupt lands in the trail', !!gov)
  check('platform session sees tool input MASKED (content split follows the session)',
    !!gov && String(gov.detail || '').includes('<EMAIL>') && !JSON.stringify(ev).includes(EMAIL))
  const ROW_KEYS = new Set(['stream', 'type', 'action', 'who', 'domain', 'at', 'requestId', 'subject', 'detail'])
  check('every row is the fixed metadata projection (no extra fields)',
    ev.every(e => Object.keys(e).every(k => ROW_KEYS.has(k))))
  check('timeline is newest-first', ev.every((e, i) => i === 0 || String(ev[i - 1].at || '').localeCompare(String(e.at || '')) >= 0))

  // ---------- filters ----------
  const byType = (await authedGet('/audit-trail?type=tool', admin)).events
  check('?type= narrows to one event type', byType.length > 0 && byType.every(e => e.type === 'tool'))
  const byDomain = (await authedGet('/audit-trail?domain=operations', admin)).events
  check('admin ?domain=operations narrows to that domain',
    byDomain.some(e => e.requestId === opsReq.id) && byDomain.every(e => e.domain === 'operations'))

  // ---------- lead scoping: own domain only, filters never widen ----------
  const leadTrail = (await authedGet('/audit-trail', carol))
  check('lead sees own-domain access rows', leadTrail.events.some(e => e.requestId === csReq.id))
  check('lead never sees foreign-domain access rows',
    !leadTrail.events.some(e => e.requestId === opsReq.id) &&
    leadTrail.events.every(e => e.stream === 'governance' || e.domain === 'customer-support'))
  check('unattributed access rows stay platform-only (R-001 fail-closed)',
    !leadTrail.events.some(e => e.type === 'capability-bundles'))
  check('lead ?domain=<foreign> yields no foreign rows (filter never widens)',
    ((await authedGet('/audit-trail?domain=operations', carol)).events).every(e => e.domain === 'operations') &&
    !((await authedGet('/audit-trail?domain=operations', carol)).events).some(e => e.stream === 'access'))
  const leadGov = leadTrail.events.find(e => e.stream === 'governance' && String(e.subject || '').includes(`${RUN}_probe_delete`))
  check('own-domain lead reads her own plane RAW (same split as /api/hitl-audit)',
    !!leadGov && String(leadGov.detail || '').includes(EMAIL))

  // ---------- UI ----------
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

    // Lead: TLP-B2 — the Audit nav entry is RETIRED for leads (the lead audit
    // page is no longer nav-reachable). Assert the exact Domain Console nav,
    // then verify the audit DATA path via the same /audit-trail API the page
    // rendered (domain scoping already asserted in the lead-scoping block).
    await uiLogin(page, 'carol')
    await page.waitForSelector('#dcbody')
    const carolNav = (await page.locator('.nav').allTextContents()).map(t => t.replace(/^[^A-Za-z]+/, ''))
    check('lead nav is DOMAIN governance + BUILD WORKSPACE, still no Audit entry',
      JSON.stringify(carolNav) === JSON.stringify(['Dashboard', 'Projects', 'Users & Access', 'Governance & Approvals',
        'Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry']))
    const leadUiTrail = (await authedGet('/audit-trail', carol)).events
    check('lead audit trail (API) renders both streams',
      leadUiTrail.some(e => e.stream === 'governance') && leadUiTrail.some(e => e.stream === 'access'))
    const leadByType = (await authedGet('/audit-trail?type=tool', carol)).events
    check('lead type filter narrows the timeline (API)',
      leadByType.some(e => String(e.subject || '').includes(`${RUN}-cs-tool`)) &&
      leadByType.every(e => e.type === 'tool') &&
      !leadByType.some(e => e.action === 'member-added'))

    // Admin: the top-level Audit page merged into Governance › audit tab
    // (IA restructure) — the domain picker narrows there.
    await uiLogin(page, 'melanie')
    await page.locator('.nav[data-view="governance"]').click()
    await page.waitForSelector('.govtab[data-tab="audit"]')
    await page.locator('.govtab[data-tab="audit"]').click()
    await page.waitForSelector('#audlist .item')
    check('admin has a domain picker', (await page.locator('#audfdomain').count()) === 1)
    await page.locator('#audfdomain').selectOption('operations')
    await page.waitForFunction(([keep, drop]) => {
      const b = document.querySelector('#audlist')
      return b && b.textContent.includes(keep) && !b.textContent.includes(drop)
    }, [`${RUN}-ops-tool`, `${RUN}-cs-tool`])
    check('admin domain filter narrows to operations', true)

    // Builder + end user: no Audit surface at all.
    await uiLogin(page, 'alice')
    check('builder has no Audit nav entry', (await page.locator('.nav[data-view="audit"]').count()) === 0)
    await uiLogin(page, 'enduser')
    check('end user has no Audit nav entry', (await page.locator('.nav[data-view="audit"]').count()) === 0)
  } finally {
    await browser.close()
  }
} finally {
  if (projSnap !== null) writeFileSync(projPath, projSnap)
  writeFileSync(bundlesPath, bundlesSnap)
  await authedPost('/obs-access-revoke', { kind: 'memory', id: 'supportdesk-memory-seed' }, admin)
  for (const p of ((await authedGet('/hitl', admin)).policies || []).filter(p => p.name.startsWith('SmokeAuditPolicy'))) {
    await authedPost('/hitl-policy-remove', { id: p.id }, admin)
  }
  // Seed hygiene (P1-3): the probe interrupt this run created must not sit
  // pending in the primary governance queue after the suite exits.
  const pending = (await authedGet('/hitl-audit?status=pending', admin)).records || []
  for (const r of pending.filter(r => String(r.toolName || '').includes('_probe_delete'))) {
    await authedPost('/hitl-decide', { requestId: r.requestId, decision: 'rejected', reason: 'smoke-audit cleanup' }, admin)
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
