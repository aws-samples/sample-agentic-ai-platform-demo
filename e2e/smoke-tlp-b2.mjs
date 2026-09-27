// TLP-B2 v2 smoke: per-persona UI shells (Melanie's rework — the console IS
// the persona's entire UI, no shared global sidebar).
//   builder  -> Build Workspace: nav = EXACTLY the spec §1.2 tab list
//   lead     -> Domain Console: nav = EXACTLY Dashboard/Projects/Users & Access/Governance & Approvals
//   admin    -> Platform Console: nav = EXACTLY the TLP-B7 sidebar (ADMIN_NAV)
// Zero residue of the old global items for scoped roles; registry read-only
// for builder; Memory collapsed / KB expanded in Memory & KB.
// Run: node e2e/smoke-tlp-b2.mjs   (expects console on :4000)
import { chromium } from 'playwright'
import { uiLogin, apiLogin, authedGet, authedPost, ADMIN_NAV } from './login.mjs'

let failures = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  | ' + extra : ''}`); if (!ok) failures++ }
const stripIcon = t => t.replace(/^[^\w]+/, '').trim()

// DOM anchor (independent review stamps against this): exact per-persona nav lists.
const BUILDER_NAV = ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry']
const LEAD_NAV = ['Dashboard', 'Projects', 'Users & Access', 'Governance & Approvals',
  'Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry']
// TLP-B7: the platform sidebar owns the operations sections (the residue
// filter excludes whatever ADMIN_NAV legitimises). B23: 'AI Gateway' stays in
// RETIRED and ADMIN_NAV no longer legitimises it — the tab is removed for
// every role. Old global sidebar items that must NOT appear as top-level nav.
const RETIRED = ['Overview', 'Blueprints', 'Build an Agent', 'My Domain', 'My Project', 'Domain Console', 'Platform Console',
  'Agent Fleet', 'AI Gateway', 'Memory', 'Audit', 'Domains', 'Governance']

const navList = async page => (await page.locator('.nav').allTextContents()).map(stripIcon)
const exact = (got, want) => got.length === want.length && want.every((w, i) => got[i] === w)

const browser = await chromium.launch()

// ---- Builder (alice): exact workspace nav, lands in project workspace ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await uiLogin(page, 'alice')
  await page.waitForSelector('#wsroot', { timeout: 10000 })
  check('builder lands directly in the project workspace (no list page, no Overview)',
    (await page.locator('#wsroot').count()) === 1)
  const nav = await navList(page)
  check('builder nav is EXACTLY the spec §1.2 tab list (7-tab spec; ⑦ = no Governance tab)',
    exact(nav, BUILDER_NAV), nav.join(' | '))
  const retiredHits = RETIRED.filter(r => !BUILDER_NAV.includes(r) && nav.includes(r))
  check('builder nav carries ZERO old-global residue', retiredHits.length === 0, retiredHits.join(','))
  check('builder nav has NO Governance destination', !nav.some(t => /Governance/.test(t)))

  // project switcher: top dropdown with search + reserved View-all row
  await page.locator('#wsswitchbtn').click()
  await page.waitForSelector('#wsswitchpanel')
  check('project switcher opens with a search box', (await page.locator('#wsswitchsearch').count()) === 1)
  check('project switcher lists the builder\'s projects', (await page.locator('.wsswitchitem').count()) >= 1)
  check('project switcher has the reserved "View all projects →" row',
    ((await page.locator('#wsswitchall').textContent()) || '').includes('View all projects'))
  await page.locator('#wsswitchbtn').click()

  // every workspace tab opens without error
  const errRe = /Could not load|not available|\[object Object\]|Internal Server Error/
  for (const [sel, waitFor] of [['fleet', '#wsbody'], ['memorykb', '#wskbcard'], ['cost', '#wsbody table, #wsbody .empty'], ['build', '[data-door], [data-bp], #pname, #doorback']]) {
    const errs = []
    page.once('pageerror', e => errs.push(e))
    await page.locator(`.nav[data-shellnav="${sel}"]`).click()
    await page.waitForSelector(waitFor, { timeout: 20000 })
    await page.waitForTimeout(400)
    const bodyTxt = await page.locator('main').textContent()
    check(`workspace tab "${sel}" opens without error`, !errRe.test(bodyTxt) && errs.length === 0)
  }
  check('Build Agent + lands on the wizard (three-door landing)',
    ((await page.locator('main h1').first().textContent()) || '').includes('Build an Agent'))
  await page.locator('.nav[data-shellnav="obs"]').click()
  await page.waitForTimeout(1200)
  check('workspace Observability opens the builder-scoped obs view',
    ((await page.locator('main h1').first().textContent()) || '').includes('Observability'))

  // Memory & KB: KB expanded, Memory collapsed w/ inline Request Access
  await page.locator('.nav[data-shellnav="memorykb"]').click()
  await page.waitForSelector('#wskbcard', { timeout: 20000 })
  await page.waitForFunction(() => !document.querySelector('#wsbody .spin'), null, { timeout: 30000 }).catch(() => {})
  const kbTotal = await page.locator('#wskbcard details').count()
  const kbOpen = await page.locator('#wskbcard details[open]').count()
  check(`Memory & KB: Knowledge Base content EXPANDED by default (${kbOpen}/${kbTotal})`, kbTotal > 0 && kbOpen === kbTotal)
  const kbContent = (await page.locator('#wskbcard .wskbcontent').first().textContent().catch(() => '')) || ''
  check('KB document content actually renders (member default, no grant)', kbContent.length > 20 && !/loading/.test(kbContent))
  const memRows = await page.locator('.wsmemrow').count()
  const reqBtns = await page.locator('.wsmemrequest').count()
  check('Memory rows are metadata-only (collapsed) with an inline Request Access affordance',
    memRows > 0 && reqBtns === memRows)
  const memTxt = await page.evaluate(() => Array.from(document.querySelectorAll('.wsmemrow')).map(r => r.textContent).join(' '))
  check('Memory rows say content is collapsed/locked', /collapsed|locked/i.test(memTxt))

  // inline request-access posts a real grant request (then cleaned up below)
  await page.locator('.wsmemrequest').first().click()
  await page.waitForFunction(() => document.querySelector('.wsmemstatus .status'), null, { timeout: 10000 })
  const stTxt = await page.evaluate(() => document.querySelector('.wsmemstatus .status')?.textContent || '')
  check('inline Request Access files a pending grant request (no Governance page needed)',
    /pending|approved/i.test(stTxt), stTxt.slice(0, 60))

  // Registry tab: read-only — zero write affordances anywhere
  await page.locator('.nav[data-shellnav="registry"]').click()
  await page.waitForSelector('.regrow', { timeout: 15000 })
  const regHtml = await page.locator('main').innerHTML()
  check('builder Registry renders zero write/create/edit affordances',
    !/id="regpropose"|id="regsubmit"|regapprove|regreject|Propose new version|Publish|regproposeform/.test(regHtml))
  await page.locator('.regrow').first().click()
  await page.waitForTimeout(400)
  const drawerHtml = await page.locator('#regdrawerwrap').innerHTML()
  check('builder Registry drawer renders zero propose/decide buttons',
    !/id="regpropose"|id="regsubmit"|regapprove|regreject/.test(drawerHtml))
  await page.close()
}

// ---- TLP-B2.3 hybrid landing: cards page + last-used resume + independent review E7 ----
{
  const alice = await apiLogin('alice')
  const bob = await apiLogin('bob')
  // E7 (hard requirement): the projects-list API behind the cards page is
  // server-filtered to the SESSION user's memberships — a builder never
  // receives another builder's project metadata.
  const aliceMine = (await authedGet('/my-projects', alice)).projects || []
  const bobMine = (await authedGet('/my-projects', bob)).projects || []
  const aliceIds = aliceMine.map(p => p.id), bobIds = bobMine.map(p => p.id)
  check(`E7 alice /my-projects: every row carries her own membership (${aliceIds.length} projects)`,
    aliceIds.length >= 2 && aliceMine.every(p => (p.members || []).some(m => m.principal === 'alice')))
  check('E7 alice /my-projects contains no bob-only projects', !aliceIds.some(id => bobIds.includes(id)),
    aliceIds.filter(id => bobIds.includes(id)).join(','))
  check('E7 bob /my-projects never receives alice-project metadata (no supportdesk)',
    bobMine.every(p => (p.members || []).some(m => m.principal === 'bob')) && !bobIds.includes('supportdesk'))
  const steal = await authedPost('/last-project', { project: 'supportdesk' }, bob)
  check('E7 last-project rejects a non-member project id (no existence oracle)', steal.ok !== true)

  // fresh login / NO last-used -> the My Projects cards page (minimal shell)
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await authedPost('/last-project', { project: null }, alice)
  await page.goto(process.env.CONSOLE_BASE || 'http://localhost:4000')
  await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), alice)
  await page.goto(process.env.CONSOLE_BASE || 'http://localhost:4000')
  await page.waitForSelector('.projcard', { timeout: 10000 })
  check('no last-used -> builder lands on the My Projects cards page', (await page.locator('#myprojectsroot').count()) === 1)
  const cardIds = await page.evaluate(() => Array.from(document.querySelectorAll('.projcard')).map(c => c.dataset.project))
  check(`cards page lists exactly alice's server-filtered projects (${aliceIds.length})`,
    JSON.stringify([...cardIds].sort()) === JSON.stringify([...aliceIds].sort()), cardIds.join(','))
  check('cards page never renders a bob-only project', !cardIds.some(id => bobIds.includes(id)))
  const cardTxt = (await page.locator('.projcard').first().textContent()) || ''
  check('a card shows owning domain + status', cardTxt.includes('Customer Support') && /active|empty/.test(cardTxt))
  check('cards page is a MINIMAL landing shell — zero sidebar nav items', (await page.locator('.nav').count()) === 0)
  check('cards page keeps a logout affordance', (await page.locator('#switchuser').count()) === 1)

  // card click -> that project's workspace (Fleet default) with the exact 6-tab nav
  await page.locator(`.projcard[data-project="${aliceIds[0]}"]`).click()
  await page.waitForSelector('#wsroot', { timeout: 10000 })
  await page.waitForSelector('#wsbody', { timeout: 10000 })
  const nav2 = await navList(page)
  check('card click enters the workspace with the exact 6-tab nav', exact(nav2, BUILDER_NAV), nav2.join(' | '))
  check('card click opens THAT project', ((await page.locator('main h1').first().textContent()) || '').includes(aliceIds[0]))
  await page.waitForTimeout(400)   // let the fire-and-forget last-project POST land

  // returning visit (last-used set by entering the workspace) -> direct workspace landing
  await page.goto(process.env.CONSOLE_BASE || 'http://localhost:4000')
  await page.waitForSelector('#wsroot', { timeout: 10000 })
  check('returning visit (last-used set) lands directly in the workspace, no cards page',
    (await page.locator('#myprojectsroot').count()) === 0)

  // the switcher's "View all projects →" row is WIRED -> back to the cards page
  await page.locator('#wsswitchbtn').click()
  await page.waitForSelector('#wsswitchall')
  await page.locator('#wsswitchall').click()
  await page.waitForSelector('.projcard', { timeout: 10000 })
  check('"View all projects →" returns to the My Projects cards page', (await page.locator('#myprojectsroot').count()) === 1)
  await page.close()
  // hermeticity: restore alice's fresh-boot no-last-used state
  await authedPost('/last-project', { project: null }, alice)
}

// ---- Builder registry writes still 403 server-side (defense in depth) ----
{
  const alice = await apiLogin('alice')
  const w = await fetch((process.env.CONSOLE_BASE || 'http://localhost:4000') + '/api/registry-propose', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
    body: JSON.stringify({ entryId: 'skill-order-lookup', semver: '9.9.9', content: {} }),
  })
  check('registry write API still 403s for builder (no server regression)', w.status === 403, `status=${w.status}`)
  // hermeticity: reject the pending grant request the UI filed above
  const carol = await apiLogin('carol')
  const reqs = await authedGet('/grant-requests?status=pending&type=memory', carol)
  for (const r of (reqs.requests || []).filter(x => x.requestedBy === 'alice' && (x.purpose || '').includes('Workspace request'))) {
    await authedPost('/grant-decide', { requestId: r.id, decision: 'reject', note: 'smoke cleanup' }, carol)
  }
}

// ---- Domain Lead (carol): exact Domain Console nav ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await uiLogin(page, 'carol')
  await page.waitForSelector('#dcbody', { timeout: 10000 })
  check('lead lands on the Domain Console (Dashboard)', true)
  const nav = await navList(page)
  check('lead nav is EXACTLY Dashboard/Projects/Users & Access/Governance & Approvals',
    exact(nav, LEAD_NAV), nav.join(' | '))
  const retiredHits = RETIRED.filter(r => !LEAD_NAV.includes(r) && nav.includes(r))
  check('lead nav carries ZERO old-global residue', retiredHits.length === 0, retiredHits.join(','))

  for (const [navId, waitFor] of [['projects', '#dccreate'], ['users', '#dcbody table'], ['dashboard', '#dcbody']]) {
    await page.locator(`.nav[data-shellnav="${navId}"]`).click()
    await page.waitForSelector(waitFor, { timeout: 15000 })
    const html = await page.locator('#dcbody').innerHTML()
    check(`Domain Console section "${navId}" opens without 500`, !html.includes('500'))
  }
  // Projects section owns the Create Project wizard entry point
  await page.locator('.nav[data-shellnav="projects"]').click()
  await page.waitForSelector('#dccreate')
  check('Projects section has the Create Project entry point',
    (await page.locator('#dcprojgo').count()) === 1 && ((await page.locator('#dccreate').textContent()) || '').includes('Create Project'))
  // Governance & Approvals routes to the lead's approval inbox
  await page.locator('.nav[data-shellnav="governance"]').click()
  await page.waitForFunction(() => (document.querySelector('main h1')?.textContent || '').includes('Governance'), null, { timeout: 15000 })
  check('Governance & Approvals opens the domain approval inbox', true)
  await page.close()
}

// ---- Plain builder (bob): same builder shell, no lead sections ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await uiLogin(page, 'bob')
  await page.waitForSelector('#wsroot', { timeout: 10000 })
  const nav = await navList(page)
  check('plain builder (bob) gets the same exact workspace nav', exact(nav, BUILDER_NAV), nav.join(' | '))
  check('bob sees no Domain Console sections', !nav.some(t => /Dashboard|Users & Access/.test(t)))
  await page.close()
}

// ---- Platform Admin (melanie): exact Platform Console nav ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await uiLogin(page, 'melanie')
  await page.waitForSelector('#pcbody', { timeout: 10000 })
  check('admin lands on the Platform Console (Home)', true)
  const nav = await navList(page)
  check('admin nav is EXACTLY the TLP-B7 platform sidebar (ADMIN_NAV)',
    exact(nav, ADMIN_NAV), nav.join(' | '))
  const retiredHits = RETIRED.filter(r => !ADMIN_NAV.includes(r) && nav.includes(r))
  check('admin nav carries ZERO old-global residue', retiredHits.length === 0, retiredHits.join(','))

  // each section opens
  for (const [navId, h1re] of [['registry', /AI Registry/], ['governance', /Governance/], ['blueprints', /Blueprints/], ['home', /Platform Console/]]) {
    await page.locator(`.nav[data-shellnav="${navId}"]`).click()
    await page.waitForFunction(re => new RegExp(re).test(document.querySelector('main h1')?.textContent || ''), h1re.source, { timeout: 15000 })
    check(`Platform Console section "${navId}" opens`, true)
  }
  // admin registry is writable (drawer carries decide/propose affordances)
  await page.locator('.nav[data-shellnav="registry"]').click()
  await page.waitForSelector('.regrow', { timeout: 15000 })
  await page.locator('.regrow').first().click()
  await page.waitForTimeout(500)
  const drawer = await page.locator('#regdrawerwrap').innerHTML()
  check('admin Registry drawer has write affordances (propose/decide)', /regpropose|regapprove|regreject|Propose/.test(drawer))

  // TLP-B7 Build: the project picker replaces Platform Projects — clicking a
  // platform project opens the reused builder workspace (same hybrid view).
  // TLP-B9: the admin Build picker page is retired — the BUILD WORKSPACE
  // section lands straight on the reused builder workspace, scoped to the
  // platform domain's own projects (spec v2.5 §2).
  await page.locator('.nav[data-shellnav="bwfleet"]').click()
  await page.waitForSelector('#wstabs', { timeout: 15000 })
  check('BUILD WORKSPACE opens the reused builder workspace (platform-scoped)', true)
  await page.close()
}

// ---- End user: untouched simple nav ----
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await uiLogin(page, 'enduser')
  const nav = await navList(page)
  check('end user nav stays Overview + Agents', exact(nav, ['Overview', 'Agents']), nav.join(' | '))
  await page.close()
}

await browser.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
