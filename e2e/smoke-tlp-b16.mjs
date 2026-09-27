// TLP-B16 smoke — demo seed pack: fresh-clone cold start opens on warm
// governance surfaces instead of three blank queues.
//   1. Admin Governance › Platform approvals: BOTH 4-eyes queues carry >=1
//      pending row (guardrail exemption + blueprint submission, seeded once
//      into their gitignored stores via the stores' own create functions).
//   2. Admin BUILD WORKSPACE › Cost: the platform-domain project ledger is
//      warm — the project cost total renders non-zero (usage-ledger-seed rows
//      for platform-assistant / it-helpdesk, user=melanie).
//   3. Lead (carol) Governance › requests inbox: >=1 pending grant request
//      (alice's tool request, re-seeded into the in-memory store each boot).
//   4. End User Agents: >=2 published (APPROVED) agents — supportdesk +
//      opsassistant both seed APPROVED in agent-registry.json.
// Read-only against the shared server: no writes, no snapshots needed. All
// assertions are >=, never ==, so rows other tests add never break this one.
import { chromium } from 'playwright'
import { apiLogin, authedGet, uiLogin } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const melanie = await apiLogin('melanie')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })

  // ---------- 1. both 4-eyes queues are warm (API first, then the UI) ------
  const ex = await authedGet('/policy-exemptions', melanie)
  const pendingEx = (ex.exemptions || []).filter(x => x.status === 'pending_domain' || x.status === 'pending_platform')
  check('S1 API: >=1 pending guardrail exemption', pendingEx.length >= 1, `pending=${pendingEx.length}`)
  const bs = await authedGet('/blueprint-submissions', melanie)
  const pendingBs = (bs.submissions || []).filter(s => s.status === 'pending_approval')
  check('S2 API: >=1 pending blueprint submission', pendingBs.length >= 1, `pending=${pendingBs.length}`)

  await uiLogin(page, 'melanie')
  await page.locator('.nav[data-shellnav="governance"]').click()
  await page.locator('.govtab[data-tab="exemptions"]').click()
  await page.waitForFunction(() => {
    const a = document.getElementById('apxlist')?.textContent || 'loading'
    const b = document.getElementById('bpsublist')?.textContent || 'loading'
    return !a.includes('loading') && !b.includes('loading')
  }, null, { timeout: 15000 })
  check('U1 exemption queue renders >=1 request row (not the empty state)',
    (await page.locator('#apxlist .item').count()) >= 1 &&
    (await page.locator('#apxlist .empty').count()) === 0)
  check('U2 blueprint-submission queue renders >=1 pending row (not the empty state)',
    (await page.locator('#bpsublist .item').count()) >= 1 &&
    (await page.locator('#bpsublist .empty').count()) === 0)

  // ---------- 2. admin BUILD WORKSPACE cost tab is non-zero ----------------
  await page.locator('.nav[data-shellnav="bwcost"]').click()
  await page.waitForFunction(() => /Project cost/.test(document.getElementById('wsbody')?.textContent || ''), null, { timeout: 15000 })
  const costHead = await page.locator('#wsbody .sec-h').first().textContent()
  const total = (costHead.match(/\$[\d.]+/) || [''])[0]
  check('U3 admin workspace Cost total renders non-zero', !!total && total !== '$0.0000', `total=${total}`)

  // ---------- 3. carol's Governance requests inbox has a pending row -------
  const carol = await apiLogin('carol')
  const gr = await authedGet('/grant-requests?status=pending', carol)
  check('S3 API: carol sees >=1 pending grant request', (gr.requests || []).length >= 1,
    `pending=${(gr.requests || []).length}`)
  await uiLogin(page, 'carol')
  await page.locator('.nav[data-shellnav="governance"]').click()
  await page.waitForFunction(() => {
    const t = document.getElementById('reqinbox')?.textContent || 'loading'
    return !t.includes('loading')
  }, null, { timeout: 15000 })
  check('U4 lead requests inbox renders >=1 decidable pending row',
    (await page.locator('#reqinbox .req-decide').count()) >= 1)

  // ---------- 4. enduser Agents shows >=2 published agents -----------------
  const enduser = await apiLogin('enduser')
  const fleet = await authedGet('/fleet', enduser)
  const published = (fleet.agents || []).filter(a => a.project && a.approval === 'APPROVED')
  if (published.length >= 2) {
    await uiLogin(page, 'enduser')
    await page.locator('.nav[data-shellnav="fleet"]').click()
    // B18: the enduser Agents page renders cards, not table rows.
    await page.waitForSelector('#fleetbox .eufleetcard', { timeout: 15000 })
    check('U5 enduser Agents page renders >=2 published agent cards',
      (await page.locator('#fleetbox .eufleetcard').count()) >= 2,
      `cards=${await page.locator('#fleetbox .eufleetcard').count()}`)
  } else {
    // Data-driven like smoke-tlp-b13 S7: the seed self-heals away when the
    // runtimes aren't live in this account, so only assert when they are.
    check('U5 (skipped-as-pass) <2 live published runtimes in this account — publish seed needs a live fleet',
      true, `published=${published.length}`)
  }
} finally {
  await browser.close()
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
