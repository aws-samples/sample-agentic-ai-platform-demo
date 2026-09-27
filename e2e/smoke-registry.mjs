import { mkdirSync as ensureScreenshotDirectory } from 'node:fs'
// T18 smoke: AI Registry view — replaces smoke-mcp.mjs + smoke-a2a.mjs.
// Covers: list+filter, owned/federated badges, propose->submit(auto-checks)
// ->approve advances defaultVersion, reject path, drift demotes + Fleet
// drifted badge. Run: node e2e/smoke-registry.mjs (expects console on :4000)
import { chromium } from 'playwright'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { apiLogin, uiLogin, authedGet, authedPost, openBuildWizard, openAdminOps } from './login.mjs'

const admin = await apiLogin('melanie')
const SHOT_DIR = new URL('../artifacts/screenshots/', import.meta.url).pathname
ensureScreenshotDirectory(SHOT_DIR, { recursive: true })
let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}
const apiGet = p => authedGet(p, admin)
const apiPost = (p, body) => authedPost(p, body, admin)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
await uiLogin(page, 'melanie')

// --- Platform Admin: list + filter ---
await page.locator('.nav[data-shellnav="registry"]').click()
await page.waitForSelector('.regrow')
check('admin nav has AI Registry (replaces Catalog+MCP+A2A)', true)
const all = (await apiGet('/registry')).entries
check(`admin sees all ${all.length} registry entries (per API)`, (await page.locator('.regrow').count()) === all.length)

await page.locator('[data-regtype="MCPServer"]').click()
await page.waitForTimeout(300)
const mcpOnly = (await apiGet('/registry?type=MCPServer')).entries
check(`MCPServer filter chip narrows to ${mcpOnly.length} rows`, (await page.locator('.regrow').count()) === mcpOnly.length)

// --- Owned vs federated governance badges ---
await page.locator('[data-regtype="All"]').click()
await page.waitForTimeout(300)
const bodyTxt = await page.locator('#regbox').textContent()
check('owned + federated governance badges both rendered', bodyTxt.includes('owned') && bodyTxt.includes('federated'))
await page.screenshot({ path: SHOT_DIR + 't16-registry-admin.png', fullPage: true })

// --- Drawer: version history, auto-checks, diff ---
await page.locator('.regrow[data-regid="aws-docs"]').click()
await page.waitForSelector('#regdrawerwrap .card')
const drawerTxt = await page.locator('#regdrawerwrap').textContent()
check('drawer shows version history for aws-docs', drawerTxt.includes('v1.0.0') && drawerTxt.includes('Changelog'))
await page.screenshot({ path: SHOT_DIR + 't16-registry-drawer.png', fullPage: true })

// --- Propose -> submit (auto-checks) -> approve advances defaultVersion ---
await page.fill('#regchangelog', 'Bump AWS Docs MCP tool schema (e2e smoke).')
await page.selectOption('#regbump', 'minor')
await page.locator('#regcontent').fill(JSON.stringify({ url: 'https://mcp.aws.example/aws-docs', transport: 'streamable_http', type: 'remote_mcp', access: ['admin', 'builder'], tools: [] }))
await page.locator('#regsubmit').click()
await page.waitForFunction(() => document.querySelector('#regproposestatus')?.textContent.includes('IN_REVIEW') || document.querySelector('#regproposestatus')?.textContent.includes('bounced'))
const submitStatus = await page.locator('#regproposestatus').textContent()
check('propose+submit ran auto-checks and reached IN_REVIEW (or bounced with a reason)', submitStatus.includes('IN_REVIEW') || submitStatus.includes('bounced'))

if (submitStatus.includes('IN_REVIEW')) {
  const before = (await apiGet('/registry?type=MCPServer')).entries.find(e => e.id === 'aws-docs').defaultVersion
  await page.locator('.regapprove').first().click()
  await page.waitForFunction(() => !document.querySelector('.regapprove'))
  const afterApprove = await apiGet('/registry?type=MCPServer')
  const awsDocs = afterApprove.entries.find(e => e.id === 'aws-docs')
  // idempotent across re-runs: the default version must advance past whatever it
  // was (>= 1.1.0), not equal a fixed number that only holds on the first run.
  const cmp = (a, b) => a.split('.').map(Number).reduce((acc, n, i) => acc || (n - b.split('.').map(Number)[i]), 0)
  check('approve advanced defaultVersion to the new APPROVED version', cmp(awsDocs.defaultVersion, before) > 0)
}
await page.screenshot({ path: SHOT_DIR + 't16-registry-builder-propose.png', fullPage: true })

// --- Reject path: propose a bad Skill (secret in content) -> submit -> DRAFT bounce ---
// Remove throwaway entries first so the spec is idempotent across re-runs against
// a shared server (propose on an existing id would create v1.1.0, not v1.0.0).
await apiPost('/registry-remove', { id: 'e2e-secret-skill' })
await apiPost('/registry-remove', { id: 'e2e-reject-skill' })
const propose = await apiPost('/registry-propose', { type: 'Skill', id: 'e2e-secret-skill', name: 'E2E Secret Skill', description: 'test', content: { note: 'api_key: "sk_live_deadbeef123456"' } })
check('propose creates a DRAFT version for a new Skill entry', propose.ok && propose.version.status === 'DRAFT')
const submitBad = await apiPost('/registry-submit', { id: 'e2e-secret-skill', semver: '1.0.0' })
check('secret-scan auto-check fails and bounces back to DRAFT', submitBad.ok && !submitBad.passed && submitBad.version.status === 'DRAFT')

const rejectPropose = await apiPost('/registry-propose', { type: 'Skill', id: 'e2e-reject-skill', name: 'E2E Reject Skill', description: 'test', content: { name: 'x', description: 'y' } })
await apiPost('/registry-submit', { id: 'e2e-reject-skill', semver: '1.0.0' })
const decideReject = await apiPost('/registry-decide', { id: 'e2e-reject-skill', semver: '1.0.0', decision: 'reject', reason: 'e2e smoke reject path' })
check('reject decision sets version to REJECTED', decideReject.ok && decideReject.version.status === 'REJECTED')

// --- Drift: demotes federated APPROVED -> IN_REVIEW ---
// Test hygiene: this step mutates persisted, server-side shared state (the
// registry file's github-mcp entry) and a repo file (supportdesk's harness).
// A previous run of this same file could have crashed mid-mutation (e.g. a
// prior stale-state failure) and left github-mcp stuck IN_REVIEW forever,
// which then made every subsequent run's drift attempt fail with a thrown
// TypeError before cleanup ran — a permanent, self-perpetuating corruption.
// Snapshot the pre-drift state and ALWAYS restore it in a finally block, so a
// failure here never cascades into future runs.
const beforeDrift = await apiGet('/registry?type=MCPServer')
const driftTarget = beforeDrift.entries.find(e => e.id === 'github-mcp')
const driftTargetWasApproved = driftTarget?.resolved?.status === 'APPROVED'
const driftedSemver = driftTarget?.resolved?.semver || '1.0.0'

// Pin github-mcp onto the deployed supportdesk agent's harness so the Fleet
// drifted-dependency badge (§4.1.1) has something real to point at, then
// restore the harness after the screenshot — supportdesk itself ships with
// no pinned MCP servers.
// domain-examples/generated/ is gitignored (runtime-generated) so on a fresh
// clone the supportdesk harness may not exist yet. Guard the read/write and
// skip the harness-pinning + Fleet drifted-badge assertion in that case,
// while still running the drift API checks that don't depend on the file.
const harnessPath = new URL('../domain-examples/generated/supportdesk/domain-harness.json', import.meta.url).pathname
const harnessExists = existsSync(harnessPath)
const harnessRaw = harnessExists ? readFileSync(harnessPath, 'utf8') : null

try {
  if (harnessExists) {
    const harness = JSON.parse(harnessRaw)
    harness.mcpServers = [...(harness.mcpServers || []), { id: 'github-mcp' }]
    writeFileSync(harnessPath, JSON.stringify(harness, null, 2))
  }

  if (!driftTargetWasApproved) {
    check('github-mcp is APPROVED before drift (pre-condition; skips drift if state already drifted)', false)
  } else {
    const drift = await apiPost('/registry-drift', { id: 'github-mcp' })
    check('drift demotes the APPROVED version to IN_REVIEW', drift.ok && drift.version?.status === 'IN_REVIEW')
    check('drift records entry.drift metadata', !!drift.entry?.drift?.detectedAt)

    if (harnessExists) {
      await openAdminOps(page, 'fleet')
      await page.waitForSelector('[data-driftbadge]', { timeout: 15000 }).catch(() => {})
      const fleetTxt = await page.locator('#fleetbox').textContent()
      check('Fleet card shows drifted-dependency badge for supportdesk', fleetTxt.includes('drifted dependency'))
      await page.screenshot({ path: SHOT_DIR + 't16-registry-drift-badge.png', fullPage: true })
    } else {
      console.log('SKIP fleet drifted-badge check (supportdesk harness not present on fresh clone — gitignored generated/)')
    }
  }
} finally {
  // Restore supportdesk's harness so other e2e specs (which assume no pinned
  // deps) aren't affected, regardless of what happened above.
  if (harnessExists) {
    writeFileSync(harnessPath, harnessRaw)
  }

  // Restore github-mcp to APPROVED so the suite is order-independent: since T20
  // the wizard reads APPROVED entries from this registry, and a lingering
  // IN_REVIEW (drifted) github-mcp would drop it from the wizard's MCP picker in
  // any spec that runs after this one. Re-approve the drifted default version
  // unconditionally — this is idempotent (registry-decide on an already-
  // APPROVED version is a no-op error we ignore) and is what makes repeated
  // runs of this file self-healing instead of self-corrupting.
  const reapprove = await apiPost('/registry-decide', { id: 'github-mcp', semver: driftedSemver, decision: 'approve' })
  const nowApproved = (await apiGet('/registry?type=MCPServer')).entries.find(e => e.id === 'github-mcp')?.resolved?.status === 'APPROVED'
  check('github-mcp restored to APPROVED after drift test (suite stays order-independent)', nowApproved)
}


// --- Governance reads the same unified registry (T13C): counts must agree ---
await page.locator('.nav', { hasText: 'Governance' }).click()
await page.waitForSelector('#govmcp [data-gov]')
const gov = await apiGet('/governance')
const regMcpCount = (await apiGet('/registry?type=MCPServer')).entries.length
const regA2aCount = (await apiGet('/registry?type=A2AAgent')).entries.length
check('Governance MCP/A2A rows come from the unified registry (counts agree)',
  gov.mcp.length === regMcpCount && gov.a2a.length === regA2aCount &&
  (await page.locator('#govmcp .item').count()) === gov.mcp.length &&
  (await page.locator('#gova2a .item').count()) === gov.a2a.length)
await page.screenshot({ path: SHOT_DIR + 't16-governance-unchanged.png', fullPage: true })

// --- Nav: Catalog/MCP Servers/A2A Agents no longer present ---
const navTexts = await page.locator('.nav').allTextContents()
check('Catalog/MCP Servers/A2A Agents nav items removed', !navTexts.some(t => t.includes('Catalog') || t.includes('MCP Servers') || t.includes('A2A Agents')))
check('AI Registry nav item present for admin', navTexts.some(t => t.includes('AI Registry')))

// --- Domain Builder: browse-all + propose on Skill/MCPServer/A2AAgent, Model read-only ---
await uiLogin(page, 'alice')
// TLP-B2: builder nav carries AI Registry too (routes to the same read-only vRegistry).
check('builder has AI Registry nav item (TLP-B2 Build Workspace nav)',
  (await page.locator('.nav[data-shellnav="registry"]').count()) === 1)
await page.locator('.nav[data-shellnav="registry"]').click()
await page.waitForSelector('.regrow')
await page.locator('[data-regtype="Model"]').click()
await page.waitForTimeout(300)
await page.locator('.regrow').first().click()
await page.waitForSelector('#regdrawerwrap .card')
check('builder read-only on Model (no propose form)', (await page.locator('#regproposeform').count()) === 0)
await page.locator('[data-regtype="MCPServer"]').click()
await page.waitForTimeout(300)
await page.locator('.regrow').first().click()
await page.waitForSelector('#regdrawerwrap .card')
// TLP-B2 (spec §1.2/§7.2): builder/lead Registry is read-only across every
// type, not just Model — write actions (propose/edit/publish) are a
// platform-team action. Supersedes the old per-type propose behavior
// intentionally (spec wins over pre-existing code per Batch 2 scope).
check('builder is read-only on MCPServer too (spec §1.2/§7.2 supersedes old per-type propose)', (await page.locator('#regproposeform').count()) === 0)
check('builder has no admin decide/drift controls', (await page.locator('.regapprove, .regreject, #regdrift').count()) === 0)

// --- End User: no AI Registry nav item (§4.2) ---
await uiLogin(page, 'enduser')
const userNav = await page.locator('.nav').allTextContents()
check('end user has no AI Registry nav', !userNav.some(t => t.includes('AI Registry')))

// --- Regression: wizard still renders (old registry data still feeds it) ---
await uiLogin(page, 'melanie')
await openBuildWizard(page)
await page.waitForTimeout(400)
check('Build wizard still renders step 1', (await page.locator('[data-bp]').count()) > 0)

// Cleanup: drop the throwaway Skill entries so the store is left as we found it.
await apiPost('/registry-remove', { id: 'e2e-secret-skill' })
await apiPost('/registry-remove', { id: 'e2e-reject-skill' })

await browser.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
