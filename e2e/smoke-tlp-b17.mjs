// TLP-B17 smoke — fleet cards + workspace header/copy fixes.
//   1. Builder workspace Fleet tab renders one card per agent: lifecycle badge,
//      approval badge + follow-up note (R2-4), health, 7-day invocations/cost,
//      last-deploy date, Open/Chat/Traces entry points, and a summary bar.
//      Exercised hermetically by stubbing /api/fleet (no shared-state writes).
//   2. Both states hold (R2-2): stubbed-empty fleet -> B13 onboarding card;
//      stubbed agents -> card list. Real data asserted data-driven like B13 E6.
//   3. Workspace H1 leads with the function name (B1): admin Fleet / Memory &
//      KB / Cost pages carry three distinct H1s, project name kept as context.
//   4. Lead Dashboard vs Projects intros are no longer word-for-word identical (B3).
//   5. NEXT story-strip step is a link, not a clipped button (C4) — the long
//      "Watch their budget in Cost" label renders in full, unclipped.
import { chromium } from 'playwright'
import { apiLogin, authedGet, uiLogin } from './login.mjs'

const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'
let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`)
  if (!ok) failures++
}

const alice = await apiLogin('alice')
const myProjects = (await authedGet('/my-projects', alice)).projects || []
const projIds = myProjects.map(p => p.id)
const firstProj = projIds[0]

const browser = await chromium.launch()
try {
  // ---------- 1+2. Fleet cards (stubbed fleet, hermetic) ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  // both stub agents live in the ACTIVE project — the workspace fleet tab is
  // project-scoped, agents from other projects never render here.
  const stubAgents = [
    { name: `${firstProj}_chat_agent`, status: 'READY', project: firstProj,
      approval: 'APPROVED', health: 'healthy', errorRate: 1.2,
      lastDeploy: '2026-08-10T12:00:00Z', updated: '2026-08-10T12:00:00Z', version: 'skill@1.0' },
    { name: `${firstProj}_workflow_agent`, status: 'READY', project: firstProj,
      approval: 'IN_REVIEW', health: 'degraded', errorRate: 4.1,
      lastDeploy: '2026-08-11T09:00:00Z', updated: '2026-08-11T09:00:00Z', version: '(no pinned deps)' },
  ]
  await page.route('**/api/fleet', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ region: 'us-west-2', agents: stubAgents }) }))
  await uiLogin(page, 'alice')
  await page.waitForSelector('.wsfleetcard', { timeout: 20000 })
  check('F1 workspace Fleet tab renders one card per project agent',
    (await page.locator('.wsfleetcard').count()) === stubAgents.length)
  check('F2 summary bar shows agent count, deployed count and 7-day spend',
    /\d+ agents?/.test(await page.locator('#wsfleetsummary').textContent()) &&
    (await page.locator('#wsfleetsummary').textContent()).includes('deployed') &&
    (await page.locator('#wsfleetsummary').textContent()).includes('last 7 days'))
  const c1 = `.wsfleetcard[data-agentcard="${firstProj}_chat_agent"]`
  const card1 = await page.locator(c1).textContent()
  check('F3 card carries a lifecycle badge (registered for an APPROVED agent)',
    (await page.locator(`${c1} [data-lcbadge]`).count()) === 1 && card1.includes('Registered'))
  check('F4 card carries the approval badge', card1.includes('APPROVED'))
  check('F5 card carries health + last-deploy + cost numbers',
    card1.includes('healthy') && card1.includes('deployed 2026-08-10') &&
    card1.includes('invocations') && card1.includes('last 7 days'))
  check('F6 card explains the approval follow-up (R2-4)',
    (await page.locator(`${c1} .wsapprovalnote`).textContent()).includes('platform team'))
  check('F7 card has the three entry points: Open / Chat / Traces',
    (await page.locator(`${c1} .wsopenagent`).count()) === 1 &&
    (await page.locator(`${c1} .wschatagent`).count()) === 1 &&
    (await page.locator(`${c1} .wstraceagent`).count()) === 1)
  const card2 = await page.locator(`.wsfleetcard[data-agentcard="${firstProj}_workflow_agent"]`).textContent()
  check('F8 IN_REVIEW card: deployed lifecycle stage + in-review follow-up note',
    card2.includes('Deployed') && card2.includes('IN_REVIEW') && card2.includes('In review since'))
  // H1 leads with the function name; project name stays as context (B1)
  const builderH1 = (await page.locator('main h1').first().textContent()) || ''
  check('F9 builder workspace H1 leads with "Fleet" and keeps the project name',
    builderH1.trim().startsWith('Fleet') && builderH1.includes(firstProj))

  // ---------- 2. Empty state (R2-2): onboarding card must survive ----------
  await page.unroute('**/api/fleet')
  await page.route('**/api/fleet', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ region: 'us-west-2', agents: [] }) }))
  await page.locator('.nav[data-shellnav="cost"]').click()
  await page.waitForSelector('#wsbody table, #wsbody .empty', { timeout: 20000 })
  await page.locator('.nav[data-shellnav="fleet"]').click()
  await page.waitForSelector('#fleetonboard', { timeout: 20000 })
  // De-text round 2: builder empty state is AWS-pattern — heading "No agents"
  // + one line + CTA. The old 3-sentence onboarding prose is a regression.
  check('E1 empty fleet -> AWS-pattern empty state (no cards, no summary bar, no onboarding prose)',
    (await page.locator('.wsfleetcard').count()) === 0 &&
    (await page.locator('#wsfleetsummary').count()) === 0 &&
    (await page.locator('#fleetonboard').textContent()).includes('No agents') &&
    !(await page.locator('#fleetonboard').textContent()).includes('Build your first agent'))
  await page.locator('#wsnewagent2').click()
  await page.waitForSelector('[data-door], [data-bp], #pname', { timeout: 15000 })
  check('E2 onboarding CTA still opens the Build wizard', true)
  await page.unroute('**/api/fleet')

  // real data, no stub: cards when agents exist, onboarding when they don't
  const realFleet = (await authedGet('/fleet', alice)).agents || []
  const realMine = realFleet.filter(a => projIds.includes(a.project))
  await uiLogin(page, 'alice')
  await page.waitForSelector('.wsfleetcard, #fleetonboard', { timeout: 20000 })
  if (realMine.length) {
    check('E3 real fleet data renders cards, NOT the onboarding card',
      (await page.locator('.wsfleetcard').count()) === realMine.length &&
      (await page.locator('#fleetonboard').count()) === 0)
  } else {
    check('E3 no project agents on this account: onboarding card renders on live data',
      (await page.locator('#fleetonboard').count()) === 1)
  }
  await page.close()

  // ---------- 3. Admin workspace H1s distinct per function (B1) ----------
  const admin = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(admin, 'melanie')
  const h1s = {}
  for (const [nav, fn] of [['bwfleet', 'Fleet'], ['bwmemorykb', 'Memory & KB'], ['bwcost', 'Cost']]) {
    await admin.locator(`.nav[data-shellnav="${nav}"]`).click()
    await admin.waitForFunction(f => (document.querySelector('main h1')?.textContent || '').trim().startsWith(f), fn, { timeout: 30000 })
    h1s[nav] = ((await admin.locator('main h1').first().textContent()) || '').trim()
    check(`A1 admin ${nav} H1 leads with "${fn}"`, h1s[nav].startsWith(fn), h1s[nav])
  }
  check('A2 the three admin workspace H1s are pairwise distinct',
    new Set(Object.values(h1s)).size === 3, Object.values(h1s).join(' || '))

  // ---------- 5. NEXT story step is an unclipped link (C4) ----------
  await admin.locator('.nav[data-shellnav="domains"]').click()
  await admin.waitForSelector('#storyline .storynext', { timeout: 30000 })
  const next = await admin.evaluate(() => {
    const el = document.querySelector('#storyline .storynext')
    return { tag: el.tagName, text: el.textContent.trim(), clipped: el.scrollWidth > el.clientWidth + 2 }
  })
  check('C1 NEXT step renders as a link (A), not a button', next.tag === 'A', next.tag)
  check('C2 long NEXT label renders in full, unclipped',
    next.text === 'Watch their budget in Cost →' && !next.clipped, next.text)
  await admin.locator('#storyline .storynext').click()
  await admin.waitForFunction(() => (document.querySelector('main h1')?.textContent || '').includes('Cost'), null, { timeout: 30000 })
  check('C3 NEXT link still navigates (Domains -> Cost)', true)
  check('C4 no button element remains inside the story strip',
    await admin.evaluate(() => !document.querySelector('#storyline button')))
  await admin.close()

  // ---------- 4. Lead intros: Dashboard vs Projects no longer identical (B3) ----------
  const lead = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  await uiLogin(lead, 'carol')
  await lead.locator('.nav[data-shellnav="dashboard"]').click()
  await lead.waitForSelector('.subtitle', { timeout: 20000 })
  const dashIntro = (await lead.locator('.subtitle').first().textContent()).trim()
  await lead.locator('.nav[data-shellnav="projects"]').click()
  await lead.waitForFunction(t => (document.querySelector('.subtitle')?.textContent || '').trim() !== t, dashIntro, { timeout: 20000 }).catch(() => {})
  const projIntro = (await lead.locator('.subtitle').first().textContent()).trim()
  check('L1 lead Dashboard and Projects intros differ', dashIntro !== projIntro)
  check('L2 each intro speaks to its own page',
    /health|spend|budget/i.test(dashIntro) && /project/i.test(projIntro),
    `dash: ${dashIntro.slice(0, 60)}… proj: ${projIntro.slice(0, 60)}…`)
  // lead build workspace still renders (same shared view as builder/admin)
  await lead.locator('.nav[data-shellnav="bwfleet"]').click()
  await lead.waitForSelector('#wsbody', { timeout: 30000 })
  await lead.waitForFunction(() => {
    const b = document.getElementById('wsbody')
    return b && !b.querySelector('.spin')
  }, null, { timeout: 30000 })
  check('L3 lead build-workspace Fleet tab renders without error',
    !/Could not load|\[object Object\]|Internal Server Error/.test(await lead.locator('main').textContent()))
  await lead.close()
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
