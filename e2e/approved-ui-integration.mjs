// Offline browser acceptance of the actual console/public application.
// ALL HTTP responses below are test-only interceptions. No live authentication,
// cloud call, pricing, account, private identity, or persistence is proven here.
// Run with Node 22: node e2e/approved-ui-integration.mjs <evidence-directory>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { GOLDEN_PATH, JOURNEYS } from '../console/public/modules/landing.mjs';

assert.match(process.version, /^v22\./, 'Use the approved Node 22 runtime');
const isMain = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
const output = path.resolve(process.argv[2] || '/private/tmp/approved-ui-integration-evidence');
if (isMain) await mkdir(output, { recursive: true });
const publicRoot = path.resolve(fileURLToPath(new URL('../console/public/', import.meta.url)));
const origin = 'https://console.test';
const idp = 'https://identity.test';
const baseWindow = { startTime: '2026-09-10T00:00:00.000Z', endTime: '2026-09-11T00:00:00.000Z' };
const caps = {
  admin: ['viewPlatformInventory','usePlatformBuilderWorkspace','viewPlatformCost','viewPlatformOperations','managePlatformPolicy','approvePlatformDeployment','approvePlatformPublication','createAgent','selectApprovedModel','discoverSharedResources'],
  lead: ['viewDomainInventory','viewDomainRegistry','useDomainBuilderWorkspace','createDomainProject','viewDomainCost','viewDomainOperations','manageDomainEntitlements','manageDomainMembers','approveDomainDeployment','approveDomainPublication','createAgent','selectApprovedModel','discoverSharedResources'],
  builder: ['viewDomainInventory','viewAssignedProjects','viewDomainRegistry','createDomainProject','createAgent','viewOwnedCost','viewOwnedOperations','selectApprovedModel','discoverSharedResources'],
  user: ['discoverEntitledAgents','invokeEntitledAgent','viewOwnSessions','requestAgentAccess'],
};
const navs = {
  admin: ['home','domains','blueprints','registry','governance','cost','bwfleet','bwbuild','bwmemorykb','bwcost'],
  lead: ['dashboard','projects','users','governance','bwfleet','bwbuild','bwmemorykb','bwcost','bwregistry'],
  builder: ['fleet','build','memorykb','cost','registry'],
  user: ['overview','fleet'],
};
const domains = ['platform','domain_a','domain_b'].map(id => ({ id, name: `Synthetic ${id}`, status: 'ACTIVE' }));
const project = domainId => ({ id: 'sample', domainId, name: `Synthetic ${domainId} project`, ownerSubject: 'synthetic-operator', memberSubjects: ['synthetic-operator'], status: 'ACTIVE' });
const costRow = domainId => ({
  contractVersion: 1, currency: 'USD', basis: 'estimate', scopeType: 'project', domainId, projectId: 'sample',
  source: 'experience-invocation-journal', environment: 'PRODUCTION', consistency: 'eventual',
  windowBasis: 'usage-occurrence-and-execution-start', runBoundary: 'runtime-durable-start',
  dispatchBoundary: 'accepted-runtime-dispatch', runCountUnavailableReason: null,
  modelCoverage: 'complete', completeness: 'partial', runCount: 2, knownRunCount: 2, acceptedDispatchCount: 3,
  estimatedCostUsd: .000003, knownEstimatedCostUsd: .000003, inputTokens: 12, outputTokens: 4,
  monthlyBudgetUsd: 100, pricingVersion: 'synthetic-price', updatedAt: baseWindow.endTime,
  coverage: { included: ['retained-model-usage'], excluded: ['shared','runtime'] },
});
const checks = [], requests = [], loaded = new Map(), unexpected = [], errors = [];
let browser;
const workspaceScopeOnly = process.env.WORKSPACE_SCOPE === '1';
async function check(name, fn) {
  await fn(); checks.push(name); console.log(`PASS ${name}`);
}
async function ready(page, selector) { await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 }); }
async function poll(fn, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(message);
}
function profile(role, domain, canSwitch = true) {
  return { ok: true, user: 'synthetic-operator', name: 'Synthetic Operator', authenticatedRole: canSwitch ? 'admin' : role,
    role, domain: ['lead','builder'].includes(role) ? domain : null,
    domains: ['lead','builder'].includes(role) ? [domain] : role === 'admin' ? domains.map(d => d.id) : [],
    capabilities: caps[role], demoRoleActive: canSwitch, canSwitchDemoRole: canSwitch,
    availableDemoRoles: canSwitch ? ['admin','lead','builder','user'] : [],
    availableDemoDomains: canSwitch ? domains.filter(d => d.id !== 'platform') : [],
  };
}
async function fixture(role = 'admin', options = {}, browserInstance = browser, sourceRoot = publicRoot) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', ...options });
  const state = { role, domain: 'domain_a', denyContext: false, wrongIdentity: false, conflict: false, failSave: false, failRead: false, readAfterSaveFailure: false, costMode: 'populated', budgets: new Map(), authorize: null, verifier: null, posts: 0, canSwitch: true, projects: null, agents: [], costRows: null, delayedCosts: null, denyAgents: false, projectsMode: 'ok', projectPages: null, domainMembers: [], projectMembers: [], memberPageSize: 50, failMembership: false, operationsRows: null, dialogs: [], projectPosts: 0 };
  for (const domain of domains) state.budgets.set(domain.id, { domainId: domain.id, projectId: 'sample', version: 1, monthlyLimitUsd: 100, thresholdPercent: 80, currency: 'USD', period: 'CALENDAR_MONTH_UTC', updatedAt: baseWindow.endTime });
  await context.addInitScript(() => {
    sessionStorage.setItem('console.demo-assist', 'false');
    sessionStorage.setItem('console.demo-assist.journey', JSON.stringify({ journeyId: 'build-agent', step: 2 }));
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.origin === idp) {
      if (url.pathname === '/oauth2/authorize') {
        state.authorize = Object.fromEntries(url.searchParams);
        return route.fulfill({ contentType: 'text/html', body: '<title>Synthetic IdP test boundary</title>' });
      }
      if (url.pathname === '/oauth2/token') {
        const body = new URLSearchParams(req.postData()); state.verifier = body.get('code_verifier');
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('redirect_uri'), `${origin}/callback`);
        assert.equal(body.get('code'), 'synthetic-code');
        return json({ access_token: 'synthetic-access', id_token: 'synthetic-id', expires_in: 3600 });
      }
      if (url.pathname === '/logout') {
        assert.equal(url.searchParams.get('logout_uri'), origin + '/');
        return route.fulfill({ contentType: 'text/html', body: '<title>Synthetic logout boundary</title>' });
      }
    }
    if (url.origin !== origin) { unexpected.push(`${url.origin}${url.pathname}`); return route.abort(); }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/runtime-config.js') return route.fulfill({ contentType: 'text/javascript', body: `window.__RUNTIME_CONFIG__=${JSON.stringify({ authMode: 'cognito', apiBaseUrl: '/api', cognito: { domain: idp, clientId: 'synthetic-client', redirectUri: origin + '/callback', logoutUri: origin + '/', scopes: ['openid','profile'] } })}` });
    if (url.pathname.startsWith('/api/')) {
      assert.equal(req.headers().authorization, 'Bearer synthetic-access', 'Private APIs require the actual auth-client token transport');
      const resource = url.pathname.slice(5), headers = req.headers();
      const activeRole = headers['x-demo-role'] || state.role;
      const activeDomain = headers['x-active-domain'] || state.domain;
      requests.push({ resource, method: req.method(), role: activeRole, domain: activeDomain, query: Object.fromEntries(url.searchParams) });
      const page = (resource, items) => ({ ok: true, resource, items, cursor: null });
      if (resource === 'me') {
        if (state.denyContext && headers['x-demo-role']) return json({ ok: false, code: 'DEMO_ROLE_NOT_ALLOWED' }, 403);
        const value = profile(activeRole, activeDomain, state.canSwitch);
        if (state.wrongIdentity) value.user = 'different-synthetic-identity';
        return json(value);
      }
      if (resource === 'domains') return json({ ok: true, domains: activeRole === 'admin' ? domains : domains.filter(d => d.id === activeDomain) });
      if (resource === 'projects') {
        if (req.method() === 'POST') {
          const body = JSON.parse(req.postData());
          state.projectPosts++;
          const created = { ...project(activeRole === 'admin' ? 'platform' : activeDomain), ...body };
          state.projects = [...(state.projects || []), created];
          return json({ ok: true, resource: 'project', project: created }, 201);
        }
        if (state.projectsMode === 'denied') return json({ ok: false, code: 'FORBIDDEN' }, 403);
        if (state.projectsMode === 'error') return json({ ok: false, code: 'WORKSPACE_UNAVAILABLE' }, 503);
        if (state.projectsMode === 'malformed') return json({ ok: true, resource: 'projects', items: [{}], cursor: null });
        if (state.projectPages) return json(state.projectPages[url.searchParams.get('cursor') || 'first']);
        return json(page('projects', state.projects || (activeRole === 'admin' ? domains.map(d => project(d.id)) : [project(activeDomain)])));
      }
      if (resource === 'costs') {
        if (state.delayedCosts) await state.delayedCosts;
        if (state.costMode === 'denied') return json({ ok: false, code: 'FORBIDDEN' }, 403);
        let items = state.costRows || (activeRole === 'admin' ? domains.map(d => d.id) : [activeDomain]).map(costRow);
        if (state.costMode === 'empty') items = [];
        if (state.costMode === 'unknown') items = items.map(row => ({ ...row, estimatedCostUsd: null, knownEstimatedCostUsd: .000003, modelCoverage: 'partial' }));
        if (state.costMode === 'zero') items = items.map(row => ({ ...row, estimatedCostUsd: 0, knownEstimatedCostUsd: 0, runCount: 0, knownRunCount: 0 }));
        return json({ ...page('costs', items), scope: { type: 'projects' }, window: baseWindow });
      }
      if (resource === 'operations/project-budgets') {
        if (req.method() === 'POST') {
          state.posts++;
          const body = JSON.parse(req.postData());
          if (activeRole === 'builder' || state.failSave) return json({ ok: false, code: 'FORBIDDEN' }, 403);
          const key = body.projectId === 'sample' ? body.domainId : `${body.domainId}/${body.projectId}`;
          const current = state.budgets.get(key) || { ...body, version: 0, updatedAt: baseWindow.endTime };
          if (state.conflict) { state.conflict = false; state.budgets.set(key, { ...current, version: current.version + 1 }); return json({ ok: false, code: 'CONFLICT' }, 409); }
          assert.equal(body.expectedVersion, current.version);
          const budget = { ...current, ...body, version: current.version + 1 };
          state.budgets.set(key, budget);
          if (state.readAfterSaveFailure) state.failRead = true;
          return json({ ok: true, budget });
        }
        if (state.failRead) return json({ ok: false, code: 'UNAVAILABLE' }, 503);
        const domainId = url.searchParams.get('domainId'), projectId = url.searchParams.get('projectId');
        if (activeRole !== 'admin' && domainId !== activeDomain) return json({ ok: false, code: 'FORBIDDEN' }, 403);
        return json({ ok: true, resource: 'project-budget', scope: { domainId, projectId }, project: { ...project(domainId), id: projectId, projectId },
          access: { role: activeRole, canEdit: ['admin','lead'].includes(activeRole) }, budget: state.budgets.get(projectId === 'sample' ? domainId : `${domainId}/${projectId}`) || null, evaluation: null });
      }
      if (['access/domain-members','access/project-members'].includes(resource)) {
        const domainId = url.searchParams.get('domainId'), projectId = url.searchParams.get('projectId');
        if (activeRole !== 'admin' && domainId !== activeDomain) return json({ ok: false, code: 'FORBIDDEN' }, 403);
        const rows = resource.endsWith('/project-members') ? state.projectMembers : state.domainMembers;
        const offset = Number(url.searchParams.get('cursor') || 0), end = offset + state.memberPageSize;
        return json({ ok: true, domainId, ...(projectId ? { projectId } : {}), items: rows.slice(offset, end), cursor: end < rows.length ? String(end) : null });
      }
      if (resource === 'access/project-memberships' && req.method() === 'POST') {
        const body = JSON.parse(req.postData());
        if (state.failMembership) return json({ ok: false, code: 'FORBIDDEN' }, 403);
        assert.ok(['admin','lead'].includes(activeRole));
        assert.equal(body.domainId, activeRole === 'admin' ? 'platform' : activeDomain);
        const member = { username: body.username, subject: 'test-member-subject', userStatus: 'CONFIRMED', enabled: true };
        state.projectMembers.push(member);
        return json({ ok: true, ...body, subject: member.subject, status: 'ACTIVE', changed: true }, 201);
      }
      if (resource === 'agents') return state.denyAgents ? json({ ok: false, code: 'FORBIDDEN' }, 403) : json(page('agents', state.agents));
      if (resource === 'operations') return json({ ...page('operations', state.operationsRows || [{ scopeType: activeRole === 'admin' ? 'platform' : 'domain', domainId: activeRole === 'admin' ? null : activeDomain, projectId: null, runtimeCount: 2, healthyRuntimeCount: 1, invocationCount: 12, errorCount: 1, averageLatencyMs: 4, p95LatencyMs: null }]), scope: state.operationsRows ? { type: 'projects', domainId: activeDomain } : activeRole === 'admin' ? { type: 'platform' } : { type: 'domain', domainId: activeDomain }, window: baseWindow });
      if (resource === 'registry') return json({ ok: true, entries: [] });
      if (resource === 'ai-gateway') return json({ ok: true, models: [], providers: [], accessRequests: [], domains: [] });
      if (resource === 'delivery/github') return json({ ok: true, github: { configured: false } });
      if (['agents','deployments','approvals','experience/agents','experience/sessions','experience/access-requests','governance/shared-resources','access/domain-members','access/project-members','governance/agent-entitlements','operations/audit','incidents','break-glass'].includes(resource)) return json(page(resource, []));
      // Legacy read-only screens may ask for unsupported data. Preserve explicit
      // unavailable responses instead of inventing successful private services.
      return json({ ok: false, code: 'OFFLINE_UNAVAILABLE', message: 'Unavailable in the offline test' }, 503);
    }
    const pathname = decodeURIComponent(url.pathname);
    const local = path.resolve(sourceRoot, '.' + pathname);
    if (local !== sourceRoot && !local.startsWith(sourceRoot + path.sep)) return route.abort();
    let file = local;
    if (!path.extname(pathname) || pathname === '/') file = path.join(sourceRoot, 'index.html');
    try {
      const bytes = await readFile(file);
      loaded.set(path.relative(sourceRoot, file), createHash('sha256').update(bytes).digest('hex'));
      const type = { '.mjs':'text/javascript','.js':'text/javascript','.html':'text/html','.css':'text/css','.woff2':'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      return route.fulfill({ contentType: type, body: bytes });
    } catch { unexpected.push(pathname); return route.fulfill({ status: 404, body: 'Missing static asset' }); }
  });
  const page = await context.newPage();
  // Test disclosure occupies its own document row, never overlays an action.
  const screenshot=page.screenshot.bind(page);
  page.screenshot=async options=>{
    await page.evaluate(()=>{
      if(document.querySelector('[data-test-disclosure]'))return;
      const marker=document.createElement('p');marker.dataset.testDisclosure='';
      marker.textContent='TEST MOCKS NOT LIVE';
      marker.style.cssText='position:relative;display:block;clear:both;padding:12px;background:#fff4cc;color:#111;pointer-events:none';
      document.body.append(marker);
    });
    return screenshot(options);
  };
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { state.dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.dismiss(); });
  return { page, context, state };
}
async function signIn(f) {
  await f.page.goto(origin);
  await ready(f.page, '#cognitosignin');
  await f.page.locator('#cognitosignin').click();
  await f.page.waitForURL(idp + '/oauth2/authorize**');
  assert.equal(f.state.authorize.code_challenge_method, 'S256');
  assert.equal(f.state.authorize.response_type, 'code');
  await f.page.goto(`${origin}/callback?code=synthetic-code&state=${encodeURIComponent(f.state.authorize.state)}`);
  await ready(f.page, '#tbprofile');
  assert.equal(createHash('sha256').update(f.state.verifier).digest('base64url'), f.state.authorize.code_challenge);
  assert.equal(new URL(f.page.url()).searchParams.has('code'), false);
  assert.equal(await f.page.evaluate(() => sessionStorage.getItem('console.demo-assist.journey')), null);
}
async function navigate(page, id) {
  const button = page.locator(`[data-shellnav="${id}"]`);
  const group = button.locator('xpath=ancestor::details');
  if (await group.count() && !(await group.evaluate(node => node.open))) await group.locator('summary').click();
  const previousContent = await page.locator('#main').evaluateHandle(node => node.firstElementChild);
  await button.click();
  // Sidebar context updates before async views replace the previous page.
  await page.waitForFunction(node => !node?.isConnected, previousContent);
  await previousContent.dispose();
  await page.waitForFunction(() => !document.querySelector('#main .spin'));
  await poll(async () => (await page.locator(`[data-shellnav="${id}"]`).getAttribute('aria-current')) === 'page', `Route ${id} must remain current`);
}
async function openBudget(f, domain = 'domain_a') {
  if (f.state.role === 'admin') await navigate(f.page, 'cost');
  else await navigate(f.page, f.state.role === 'lead' ? 'bwcost' : 'cost');
  if (f.state.role === 'admin') {
    await ready(f.page, `[data-project-budget-open][data-domain="${domain}"]`);
    await f.page.locator(`[data-project-budget-open][data-domain="${domain}"]`).click();
  }
  await ready(f.page, '[data-project-budget]');
}
export { fixture, signIn, navigate, ready, poll, profile, project, costRow, navs, requests, loaded, unexpected, errors, origin };

if (isMain) {
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  if (workspaceScopeOnly) {
    for (const role of ['admin', 'lead', 'builder']) {
      const f = await fixture(role);
      const domain = role === 'admin' ? 'platform' : 'domain_a';
      f.state.projects = [project(domain), { ...project(domain), id: 'second', name: 'Second project' }];
      f.state.agents = [{ id: 'own-agent', name: 'Own agent', domainId: domain, projectId: 'sample', status: 'DRAFT' },
        { id: 'other-agent', name: 'Other project agent', domainId: domain, projectId: 'second', status: 'DRAFT' },
        { id: 'foreign-agent', name: 'Foreign domain agent', domainId: 'domain_b', projectId: 'sample', status: 'DRAFT' }];
      f.state.costRows = [costRow(domain), { ...costRow(domain), projectId: 'second', estimatedCostUsd: 20 }, { ...costRow('domain_b'), estimatedCostUsd: 90 }];
      await signIn(f);
      if (role === 'builder') {
        await ready(f.page, '.projcard, #wscontextswitchbtn');
        if (await f.page.locator('.projcard').count()) await f.page.locator('[data-workspace-pick="sample"],.projcard[data-project="sample"]').first().click();
        await ready(f.page, '#wscontextswitchbtn');
      }
      await navigate(f.page, role === 'builder' ? 'cost' : 'bwcost');
      await ready(f.page, '.projcard, #wscontextswitchbtn');
      if (await f.page.locator('.projcard').count()) await f.page.locator('[data-workspace-pick="sample"],.projcard[data-project="sample"]').first().click();
      await ready(f.page, '#wscontextswitchbtn');
      await f.page.screenshot({ path: path.join(output, `${role}-workspace-cost.png`), fullPage: true });
      await check(`${role}: one workspace navigation and exact project cost`, async () => {
        assert.equal(await f.page.locator('#wstabs').count(), 0);
        const text = await f.page.locator('[data-budget-cost]').innerText();
        assert.match(text, /0\.000003/); assert.doesNotMatch(text, /90\.00|20\.00|Account-wide Cost Explorer/);
      });
      await check(`${role}: project switch preserves Cost and selected scope`, async () => {
        await f.page.locator('#wscontextswitchbtn').click();
        await f.page.locator('.wsswitchitem[data-project="second"]').click();
        await poll(async () => /20\.00/.test(await f.page.locator('[data-budget-cost]').innerText()), 'selected project cost finishes rendering');
        assert.match(await f.page.locator('h1').innerText(), /Cost/);
        assert.match(await f.page.locator('[data-budget-cost]').innerText(), /20\.00/);
      });
      await navigate(f.page, role === 'builder' ? 'fleet' : 'bwfleet');
      await check(`${role}: monitoring and observability entries are hidden from the demo`, async () => {
        assert.equal(await f.page.locator('[data-shellnav="monitoring"],[data-shellnav="obs"],[data-shellnav="bwobs"]').count(), 0);
        assert.equal(await f.page.locator('.wstraceagent,.obsdrill,.domobs,[data-goview="monitoring"],[data-goview="observability"]').count(), 0);
        assert.match(await f.page.locator('#main').innerText(), /Other project agent/);
        assert.doesNotMatch(await f.page.locator('#main').innerText(), /Own agent|Foreign domain agent/);
        await f.page.screenshot({ path: path.join(output, `${role}-workspace-fleet.png`), fullPage: true });
      });
      if (role === 'admin') {
        await navigate(f.page, 'cost');
        assert.match(await f.page.locator('#main').innerText(), /110\.00/);
        await f.page.screenshot({ path: path.join(output, 'platform-cost.png'), fullPage: true });
      }
      await f.context.close();
    }
    assert.ok(requests.filter(r => r.resource === 'costs').every(r => Object.keys(r.query).every(key => ['window','limit','cursor','groupBy'].includes(key))));
    assert.equal(requests.filter(r => /obs-traces|langfuse|obs\//.test(r.resource)).length, 0);
  } else {
  const publicFixture = await fixture();
  const p = publicFixture.page;
  await check('landing: 22 story details, nine stages, role resets and full original roadmap', async () => {
    await p.goto(origin); await ready(p, '#cognitosignin');
    assert.equal(requests.length, 0);
    for (const [role, journey] of Object.entries(JOURNEYS)) {
      await p.locator(`[data-jtab="${role}"]`).click();
      assert.equal(await p.locator('[data-jstep="0"]').getAttribute('aria-pressed'), 'true');
      for (let i = 0; i < journey.steps.length; i++) {
        await p.locator(`[data-jstep="${i}"]`).click();
        assert.ok((await p.locator('#landing-story-detail').innerText()).includes(journey.steps[i].story));
      }
      await p.locator(`[data-jtab="${role}"]`).click();
      assert.equal(await p.locator('[data-jstep="0"]').getAttribute('aria-pressed'), 'true');
    }
    for (let i = 0; i < GOLDEN_PATH.length; i++) {
      await p.locator(`[data-gstage="${i}"]`).click();
      const detail = await p.locator('#landing-golden-detail').innerText();
      for (const text of [GOLDEN_PATH[i].full, GOLDEN_PATH[i].story, ...GOLDEN_PATH[i].plat, ...GOLDEN_PATH[i].dom]) assert.ok(detail.includes(text));
    }
    await ready(p, '.landing-roadmap #l4');
    assert.equal(await p.locator('.landing-offline-diagram').count(), 2);
    await p.screenshot({ path: path.join(output, 'landing-desktop.png'), fullPage: true });
    await p.reload(); await ready(p, '[data-jtab="admin"][aria-selected="true"]');
  });
  await check('landing: autoplay, pause, reduced motion and narrow keyboard controls', async () => {
    assert.equal(await p.locator('.landing').evaluate(node => node.classList.contains('moving')), true);
    await p.locator('#landing-pause').click();
    assert.equal(await p.locator('.landing').evaluate(node => node.classList.contains('moving')), false);
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.locator('#landing-pause').click();
    assert.equal(await p.locator('.landing').evaluate(node => node.classList.contains('moving')), false);
    await p.setViewportSize({ width: 390, height: 844 });
    await p.locator('[data-jtab="admin"]').focus(); await p.keyboard.press('End');
    assert.equal(await p.locator('[data-jtab="user"]').getAttribute('aria-selected'), 'true');
    await p.keyboard.press('Home');
    await p.locator('[data-jstep="0"]').focus(); await p.keyboard.press('End');
    assert.equal(await p.locator('[data-jstep="6"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await p.screenshot({ path: path.join(output, 'landing-mobile-keyboard.png'), fullPage: true });
    await p.locator('.landing-motion a').click(); await ready(p, '#cognitosignin');
  });
  await publicFixture.context.close();
  for (const role of Object.keys(navs)) {
    const f = await fixture(role);
    await check(`${role}: real client PKCE/callback and every accepted navigation entry`, async () => {
      await signIn(f);
      if (role === 'builder') {
        // Cognito adapters resume the last authorized project automatically.
        await ready(f.page, '.projcard, #wsswitchbtn');
        if (await f.page.locator('.projcard').count()) await f.page.locator('.projcard').first().click();
        await ready(f.page, '#wsswitchbtn');
      }
      await ready(f.page, '[data-shellnav]');
      assert.deepEqual(await f.page.locator('[data-shellnav]').evaluateAll(nodes => nodes.map(node => node.dataset.shellnav)), navs[role]);
      for (const id of navs[role]) {
        await navigate(f.page, id);
        await f.page.waitForFunction(() => !document.querySelector('#main .spin'));
        assert.equal(await f.page.locator(`[data-shellnav="${id}"] svg`).count(), 0);
        assert.equal(await f.page.locator('#goldenpath,#journeys,#maturity,.demo-journey-guide,.demo-journey-strip').count(), 0);
        for (const selector of ['.govtab[data-tab]', '.obstab[data-tab]', '[data-access-tab]', '[data-regtype]', 'button[data-wstab]']) {
          const tabs = await f.page.locator(selector).evaluateAll(nodes => nodes.map(node => ({
            attribute: [...node.attributes].find(attr => /^data-(tab|access-tab|regtype|wstab)$/.test(attr.name)).name,
            value: node.dataset.tab || node.dataset.accessTab || node.dataset.regtype || node.dataset.wstab,
          })));
          for (const tab of tabs.filter(tab => tab.value !== 'goto-requests')) {
            const control = f.page.locator(`${selector}[${tab.attribute}="${tab.value}"]`);
            await control.click();
            await f.page.waitForFunction(() => !document.querySelector('#main .spin'));
            assert.ok(await f.page.locator('#main').innerText());
          }
        }
      }
      const group = f.page.locator('[data-nav-group]').first();
      if (await group.count()) {
        await group.locator('summary').focus(); await f.page.keyboard.press('Space');
        assert.equal(await group.evaluate(node => node.open), false);
        await f.page.keyboard.press('Space'); assert.equal(await group.evaluate(node => node.open), true);
      }
      await f.page.screenshot({ path: path.join(output, `${role}-actual-app.png`), fullPage: true });
      await f.page.setViewportSize({ width: 390, height: 844 });
      assert.deepEqual(await f.page.locator('[data-shellnav]').evaluateAll(nodes => nodes.map(node => node.dataset.shellnav)), navs[role]);
      await f.page.screenshot({ path: path.join(output, `${role}-mobile.png`), fullPage: true });
    });
    if (role === 'builder') await check('builder: budget stays read-only', async () => {
      await openBudget(f);
      await poll(async () => (await f.page.locator('[data-project-budget]').innerText()).includes('Ask an authorized admin or domain lead'), 'Authoritative read-only budget response rendered');
      assert.equal(await f.page.locator('[data-budget-form]').count(), 0);
      assert.match(await f.page.locator('[data-project-budget]').innerText(), /Ask an authorized admin or domain lead/);
      assert.equal(f.state.posts, 0);
    });
    await f.context.close();
  }
  const f = await fixture('admin'); await signIn(f);
  await check('context: denied /me, identity mismatch, dirty cancel and successful revalidation', async () => {
    await openBudget(f);
    const limit = f.page.locator('[name="monthlyLimitUsd"]'); await ready(f.page, '[name="monthlyLimitUsd"]');
    await limit.fill('123');
    const before = requests.filter(r => r.resource === 'me').length;
    await f.page.locator('#tbrole').selectOption('lead');
    assert.equal(await f.page.locator('#tbrole').inputValue(), 'admin');
    assert.equal(await limit.inputValue(), '123');
    assert.equal(requests.filter(r => r.resource === 'me').length, before);
    await limit.fill('100');
    f.state.denyContext = true; await f.page.locator('#tbrole').selectOption('lead');
    await poll(async () => await f.page.locator('#tbrole').inputValue() === 'admin', 'Denied switch rolls back');
    f.state.denyContext = false; f.state.wrongIdentity = true;
    await f.page.locator('#tbrole').selectOption('lead');
    await poll(async () => await f.page.locator('#tbrole').inputValue() === 'admin', 'Identity mismatch rolls back');
    f.state.wrongIdentity = false;
    await f.page.locator('#tbrole').selectOption('lead');
    await ready(f.page, '#tbdomain');
    f.state.role = 'lead';
    assert.equal(await f.page.locator('#tbrole').inputValue(), 'lead');
    assert.match(await f.page.locator('#tbprofile').innerText(), /Synthetic Operator/);
    assert.equal(await f.page.locator('[data-budget-form]').count(), 0);
    await navigate(f.page, 'bwfleet'); await ready(f.page, '#wsswitchbtn');
    assert.match(await f.page.locator('#main').innerText(), /Synthetic domain_a project/);
    await f.page.locator('#tbdomain').selectOption('domain_b');
    await poll(async () => await f.page.locator('#tbdomain').inputValue() === 'domain_b', 'Domain selected');
    f.state.domain = 'domain_b';
    await navigate(f.page, 'bwfleet'); await ready(f.page, '#wsswitchbtn');
    assert.match(await f.page.locator('#main').innerText(), /Synthetic domain_b project/);
    assert.doesNotMatch(await f.page.locator('#main').innerText(), /Synthetic domain_a project/);
  });
  await check('budget: save/GET confirmation, conflict, uncertain read-back, failed authorization', async () => {
    await openBudget(f); await ready(f.page, '[name="monthlyLimitUsd"]');
    await f.page.locator('[name="monthlyLimitUsd"]').fill('125');
    await f.page.getByRole('button', { name: 'Save USD budget', exact: true }).click();
    await poll(async () => (await f.page.locator('[data-project-budget]').innerText()).includes('Saved and verified'), 'Save verified');
    assert.equal(f.state.budgets.get('domain_b').monthlyLimitUsd, 125);
    f.state.conflict = true;
    await f.page.locator('[name="monthlyLimitUsd"]').fill('150');
    await f.page.getByRole('button', { name: 'Save USD budget', exact: true }).click();
    await poll(async () => (await f.page.locator('[data-project-budget]').innerText()).includes('Budget changed'), 'Conflict visible');
    assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').inputValue(), '150');
    f.state.readAfterSaveFailure = true;
    await f.page.getByRole('button', { name: 'Save USD budget', exact: true }).click();
    await poll(async () => (await f.page.locator('[data-project-budget]').innerText()).includes('unconfirmed'), 'Read-back failure stays unconfirmed');
    const posts = f.state.posts; f.state.failRead = false; f.state.readAfterSaveFailure = false;
    await f.page.getByRole('button', { name: 'Refresh persisted budget', exact: true }).click();
    await poll(async () => (await f.page.locator('[data-project-budget]').innerText()).includes('Saved and verified'), 'Refresh completes persisted version confirmation before reload');
    await ready(f.page, '[name="monthlyLimitUsd"]'); assert.equal(f.state.posts, posts);
    assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').inputValue(), '150');
    await f.page.reload(); await ready(f.page, '#tbrole'); await openBudget(f);
    await ready(f.page, '[name="monthlyLimitUsd"]');
    assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').inputValue(), '150');
    assert.equal(f.state.posts, posts, 'Reload uses GET without another mutation');
    f.state.failSave = true; await f.page.locator('[name="monthlyLimitUsd"]').fill('175');
    await f.page.getByRole('button', { name: 'Save USD budget', exact: true }).click();
    await poll(async () => (await f.page.locator('[data-project-budget]').innerText()).includes('Budget save failed'), 'Authorization error visible');
    assert.equal(f.state.budgets.get('domain_b').monthlyLimitUsd, 150);
    await f.page.screenshot({ path: path.join(output, 'budget-authorization-state.png'), fullPage: true });
  });
  await check('new synthetic session: persisted budget read-back and unauthorized context controls absent', async () => {
    const fresh = await fixture('lead');
    fresh.state.budgets = f.state.budgets;
    fresh.state.domain = 'domain_b';
    fresh.state.canSwitch = false;
    await signIn(fresh);
    assert.equal(await fresh.page.locator('#tbrole,#tbdomain').count(), 0);
    await openBudget(fresh); await ready(fresh.page, '[name="monthlyLimitUsd"]');
    assert.equal(await fresh.page.locator('[name="monthlyLimitUsd"]').inputValue(), '150');
    assert.equal(fresh.state.posts, 0);
    await fresh.context.close();
  });
  await check('failed budget save protects navigation until explicit confirmed discard', async () => {
    const before=f.state.dialogs.length;
    await f.page.locator('[data-shellnav="bwcost"]').click();
    await poll(()=>f.state.dialogs.length>before,'dirty failed-save draft asks before leaving');
    assert.match(f.state.dialogs.at(-1).message,/Discard unsaved/);
    assert.match(await f.page.locator('[data-project-budget]').innerText(),/Budget save failed/);
    f.page.removeAllListeners('dialog');
    f.page.once('dialog',async dialog=>{assert.equal(dialog.type(),'confirm');await dialog.accept()});
    await navigate(f.page,'bwcost');
    f.page.on('dialog',async dialog=>{f.state.dialogs.push({type:dialog.type(),message:dialog.message()});await dialog.dismiss()});
  });
  await check('cost: empty, unknown subtotal and explicit zero are distinct', async () => {
    for (const mode of ['empty','unknown','zero','populated']) {
      f.state.costMode = mode;
      await navigate(f.page, 'bwcost'); await ready(f.page, '[data-hosted-cost]');
      const text = await f.page.locator('[data-hosted-cost]').innerText();
      if (mode === 'empty') { assert.match(text, /No usage data/); assert.doesNotMatch(text, /\$0/); }
      if (mode === 'unknown') { assert.match(text, /Estimate: N\/A|Estimate:\s*N\/A/); assert.match(text, /0\.000003/); }
      if (mode === 'zero') assert.match(text, /\$0\.000000/);
      if (mode === 'populated') assert.match(text, /\$0\.000003/);
    }
    await f.page.screenshot({ path: path.join(output, 'cost-actual-app.png'), fullPage: true });
  });
  await check('signout: real client clears tokens and preserves logout route', async () => {
    await f.page.locator('#tbprofile').click(); await f.page.locator('#tbsignout').click();
    await f.page.waitForURL(idp + '/logout**');
    await f.page.goto(origin); await ready(f.page, '#cognitosignin');
    assert.equal(await f.page.evaluate(() => sessionStorage.getItem('console.cognito.tokens')), null);
  });
  await f.context.close();
  }
  assert.deepEqual(unexpected, [], 'All traffic stays in the intercepted offline boundary');
  assert.deepEqual(errors, [], 'Actual modules must execute without uncaught browser errors');
  assert.ok(loaded.has('modules/app.mjs') && loaded.has('auth-client.mjs') && loaded.has('modules/project-budget.mjs'));
} catch (error) {
  process.exitCode = 1;
  errors.push(error.stack || String(error));
  console.error(error);
} finally {
  if (browser) await browser.close();
  await writeFile(path.join(output, 'browser-results.json'), JSON.stringify({
    offlineOnly: true, realCognitoOrPrivateApisProven: false,
    sha: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(), node: process.version,
    passed: checks.length, checks, errors, unexpected, requests, loadedSourceSha256: Object.fromEntries(loaded),
  }, null, 2) + '\n');
}

}
