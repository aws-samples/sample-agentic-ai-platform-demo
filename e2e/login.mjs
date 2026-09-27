// Shared login helper (T02): the console requires a real server session on
// every /api/* call. Tests obtain a session via POST /api/login (same endpoint
// the SSO login page uses) and either call APIs with the bearer token or seed
// the browser's stored session before navigation.
// CONSOLE_BASE lets the whole suite target a non-default port (e.g. a second
// server on :4102 while :4000 is busy) without touching each test.
const BASE = process.env.CONSOLE_BASE || 'http://localhost:4000'

// Shared expected admin (melanie) top-level nav for the Platform Console shell.
// TLP-B9 (spec v2.5 §2): the admin sidebar is TWO persistent sections — the
// PLATFORM governance list, then the BUILD WORKSPACE list (isomorphic with
// the builder nav, scoped to the platform domain's own projects). This
// constant is the single source of truth so nav-list assertions across the
// e2e suite stay in sync when the shell changes again.
// B14: the aggregate entry is 'Platform Monitoring' (view 'monitoring') —
// a separate route from the build workspace's content-level 'Observability'.
// B23: the AI Gateway and platform-level Memory Stores tabs are removed
// (UI only — the gateway data plane, /api/models discovery, and all memory
// APIs stay). Per-agent memory lives in the workspace Memory & KB tab.
export const ADMIN_GOV_NAV = ['Dashboard', 'Domains', 'Blueprints',
  'AI Registry (org)', 'Governance & Approvals', 'Cost Management', 'Platform Monitoring']
export const BUILD_WORKSPACE_NAV = ['Fleet', 'Build Agent +', 'Memory & KB', 'Cost', 'Observability', 'AI Registry']
// B13: admin's BUILD WORKSPACE section drops the AI Registry entry — the
// org-level 'AI Registry (org)' in the governance section is the same page,
// so the duplicate was removed. Lead/builder keep the full workspace list.
export const ADMIN_NAV = [...ADMIN_GOV_NAV, ...BUILD_WORKSPACE_NAV.filter(l => l !== 'AI Registry')]

// API-side session: returns { token, user, name, role, domain, domains }.
export async function apiLogin(user = 'melanie', idp = 'okta', domain = undefined) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, idp }),
  })
  if (r.status !== 200) throw new Error(`login as ${user} failed: ${r.status}`)
  const session = await r.json()
  return domain === undefined ? session : apiSwitchDomain(session, domain)
}

export async function apiSwitchDomain(session, domain) {
  const r = await fetch(BASE + '/api/session-domain', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.token },
    body: JSON.stringify({ domain }),
  })
  if (r.status !== 200) throw new Error(`switch domain to ${domain ?? 'all'} failed: ${r.status}`)
  return r.json()
}

export const authedGet = (p, session) =>
  fetch(BASE + '/api' + p, { headers: { authorization: 'Bearer ' + session.token } }).then(r => r.json())

export const authedPost = (p, body, session) =>
  fetch(BASE + '/api' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.token },
    body: JSON.stringify(body),
  }).then(r => r.json())

// The Build wizard opens on the three-door journey landing (J-T1). Enter the
// blueprint door (the classic wizard); no-op if a door is already open from
// earlier in the session. TLP-B2 shells: builder has a "Build Agent +" nav
// entry; admin/lead (spec v2.5 §2) use the same entry inside their
// persistent BUILD WORKSPACE sidebar section (data-shellnav="bwbuild").
export async function openBuildWizard(page) {
  const builderNav = page.locator('.nav[data-shellnav="build"]')
  const bwNav = page.locator('.nav[data-shellnav="bwbuild"]')
  if (await builderNav.count()) await builderNav.click()
  else await bwNav.click()
  await page.waitForSelector('[data-door], [data-bp], #pname, #doorback')
  const door = page.locator('[data-door="blueprint"]')
  if (await door.count()) await door.click()
}

// TLP-B2 shells: a project detail opens from the shell's own surface —
// admin (TLP-B7): Domains sidebar section › domain › project;
// lead: Domain Console › Projects › project card.
export async function openProject(page, projectId, domainId) {
  const leadProjects = page.locator('.nav[data-shellnav="projects"]')
  if (await leadProjects.count()) {
    await leadProjects.click()
    await page.waitForSelector(`[data-project="${projectId}"]`)
    await page.locator(`[data-project="${projectId}"]`).click()
    return
  }
  await page.locator('.nav[data-shellnav="domains"]').click()
  await page.waitForSelector(`[data-domain="${domainId}"]`)
  await page.locator(`[data-domain="${domainId}"]`).click()
  await page.waitForSelector(`[data-project="${projectId}"]`)
  await page.locator(`[data-project="${projectId}"]`).click()
}

// TLP-B9 (spec v2.5 §2): the admin/lead operations surfaces are top-level
// PLATFORM/DOMAIN governance-section sidebar entries (fleet|cost|
// observability|domains); 'compose' opens through the persistent
// BUILD WORKSPACE section's "Build Agent +" entry (data-shellnav="bwbuild").
// Kept as the one shared entry helper so tests don't encode the IA individually.
export async function openAdminOps(page, view) {
  // B14: the admin's aggregate entry is data-shellnav="monitoring" — legacy
  // callers that ask for the old shared 'observability' view land there.
  if (view === 'observability') view = 'monitoring'
  if (view === 'compose') {
    await page.locator('.nav[data-shellnav="bwbuild"]').click()
    return
  }
  // R-B10-04: All Agents left the top-level admin nav (Melanie feedback) —
  // fleet is still a routable view, reached via Domains > Platform domain's
  // "Open full fleet view" link (unscoped table, same as before).
  if (view === 'fleet') {
    await page.locator('.nav[data-shellnav="home"]').click()
    await page.waitForSelector('#pcallfleet')
    await page.locator('#pcallfleet').click()
    return
  }
  await page.locator(`.nav[data-shellnav="${view}"]`).click()
}

// TLP-B2.3 hybrid landing: a builder with NO last-used project lands on the
// My Projects cards page. uiLogin models a RETURNING visit, so prime the
// last-used project to the first membership — builders land directly in the
// workspace, exactly like the pre-hybrid behavior every test was written
// against. The fresh cards-page path is covered explicitly in smoke-tlp-b2.
export async function primeLastProject(session, base = BASE) {
  if (session.role !== 'builder') return
  const h = { 'content-type': 'application/json', authorization: 'Bearer ' + session.token }
  const mp = await fetch(base + '/api/my-projects', { headers: h }).then(r => r.json())
  const first = (mp.projects || [])[0]
  if (first) await fetch(base + '/api/last-project', { method: 'POST', headers: h, body: JSON.stringify({ project: first.id }) })
}

// Browser-side session: log in via the API, seed the stored session, navigate.
// Persona switching in tests = uiLogin as a different user (real re-auth, not
// a client-side toggle). Waits for the signed-in sidebar to render.
export async function uiLogin(page, user = 'melanie', idp = 'okta', domain = undefined) {
  const session = await apiLogin(user, idp, domain)
  await primeLastProject(session)
  await page.goto(BASE)
  await page.evaluate(s => localStorage.setItem('console.session', JSON.stringify(s)), session)
  await page.goto(BASE)
  await page.waitForSelector('#whoami')
  return session
}
