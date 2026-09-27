// TEST MOCKS NOT LIVE. Actual app and backend identity projection; every HTTP
// response is intercepted. Never disable Chromium's sandbox or call a live API.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectEffectiveIdentity } from '../infra/serverless-platform/lambda/api/identity.mjs';
import { fixture, signIn, navigate, ready, poll, project, errors, unexpected, loaded } from './approved-ui-integration.mjs';

assert.equal(process.version, 'v22.23.2');
const output = path.resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const checks = [], failures = [], screenshots = [], writes = [];
let browser;
const domains = [{ id: 'operations', name: 'Offline Operations' }, { id: 'domain_a', name: 'Offline A' }];
function profile(role, demo = false, domain = 'platform') {
  const claims = { sub: 'offline-person', name: 'Offline Person',
    'cognito:groups': demo ? ['platform-admin', 'demo-operator']
      : [({ admin: 'platform-admin', lead: 'domain-lead', builder: 'domain-builder', user: 'end-user' })[role], 'domain-' + domain.replaceAll('_', '-')] };
  return { ...projectEffectiveIdentity(claims, demo
    ? { 'x-demo-role': role, ...(['lead', 'builder'].includes(role) ? { 'x-active-domain': domain } : {}) } : {},
  demo ? { availableDomains: domains, availableDemoDomains: domains, demoOperatorAuthorized: true } : { demoOperatorAuthorized: false }),
  availableDemoDomains: demo ? domains : [] };
}
const native = { id: 'offline-skill', name: 'Offline native skill', type: 'Skill', domain: 'platform',
  _source: 'agentcore-registry', _registryId: 'OfflineRegistry',
  versions: [{ semver: '1.0.0', status: 'IN_REVIEW', _aws: { registryId: 'OfflineRegistry', recordId: 'OfflineRec01', awsStatus: 'PENDING_APPROVAL' } }] };
const approval = (kind, domainId = 'platform', extra = {}) => ({ id: kind.toLowerCase().replaceAll('_', '-'), kind, domainId,
  projectId: 'sample', resourceId: 'offline-resource', resourceType: kind === 'PRODUCTION_DEPLOYMENT' ? 'DEPLOYMENT' : 'AGENT',
  status: 'PENDING', requesterSubject: 'different-person', ...extra });
async function setup(role, { demo = false, domain = 'platform', count = 0, patch = {} } = {}) {
  const f = await fixture(role, {}, browser);
  f.state.domain = domain;
  f.state.projects = [project(domain), { ...project(domain), id: 'second', name: 'Second authorized project' }].slice(0, count);
  f.state.projects.push({ ...project('foreign'), name: 'Foreign project must never render' });
  f.registry = { ok: true, source: 'aws', entries: [structuredClone(native)] };
  f.approvals = { ok: true, resource: 'approvals', items: [], cursor: null };
  f.reads = 0;
  await f.context.route('https://console.test/api/**', async route => {
    const req = route.request(), resource = new URL(req.url()).pathname.slice(5);
    assert.equal(req.headers().authorization, 'Bearer synthetic-access');
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (resource === 'me') {
      if (f.pendingIdentity) await f.pendingIdentity;
      return json({ ...profile(req.headers()['x-demo-role'] || role, demo, req.headers()['x-active-domain'] || domain), ...patch });
    }
    if (resource === 'registry') {
      if (f.registry === 'network-error') return route.abort();
      return json(f.registry, f.registry.ok ? 200 : 503);
    }
    if (resource === 'approvals') {
      f.reads++;
      const response = structuredClone(f.approvals);
      if (f.pendingApprovals) await f.pendingApprovals;
      if (response === 'network-error') return route.abort();
      return json(response, response.ok ? 200 : 503);
    }
    if (req.method() !== 'GET') {
      assert.ok(['registry-decide', 'deployment-decisions', 'governance/publication-decisions', 'governance/access-decisions'].includes(resource), resource);
      writes.push({ resource, body: JSON.parse(req.postData()), headers: { role: req.headers()['x-demo-role'], domain: req.headers()['x-active-domain'] } });
      if (f.pendingDecision) await f.pendingDecision;
      // The synthetic read store deliberately remains PENDING. The app must
      // reload server state, never optimistically mutate a hosted record.
      return json({ ok: true });
    }
    return route.fallback();
  });
  return f;
}
async function shot(f, name) {
  await f.page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  await writeFile(path.join(output, name + '.txt'), 'TEST MOCKS NOT LIVE\n' + await f.page.locator('#main').innerText());
  screenshots.push(name + '.png');
}
async function check(name, work) {
  try { await work(); checks.push(name); console.log('PASS', name); }
  catch (error) { failures.push({ name, error: error.stack }); console.error('FAIL', name, error.message); }
}
async function queue(f) {
  await navigate(f.page, 'governance');
  await poll(async () => !await f.page.locator('#govqueue .spin').count(), 'Queue settled');
}
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  for (const role of ['admin', 'lead', 'builder', 'user']) for (const count of [0, 2]) {
    await check(`ordinary ${role}, ${count} projects, backend-generated /me`, async () => {
      const f = await setup(role, { count });
      try {
        await signIn(f);
        assert.equal(await f.page.locator('#tbrole,#tbdomain').count(), 0, 'No demo-operator privilege');
        if (role !== 'user') {
          await navigate(f.page, role === 'builder' ? 'fleet' : 'bwfleet');
          await ready(f.page, count ? '#wsswitchbtn' : '[data-workspace-state="empty"]');
          assert.doesNotMatch(await f.page.locator('#main').innerText(), /Foreign project|Sign-in could not/);
          if (count) assert.equal(await f.page.locator('.wsswitchitem').count(), count);
        }
        await shot(f, `ordinary-${role}-${count}`);
      } finally { await f.context.close(); }
    });
  }
  for (const patch of [{ capabilities: null }, { capabilities: [null] }, { role: 'admin' }, { ok: false, code: 'UNAVAILABLE' }]) {
    await check('invalid or unavailable profile ' + JSON.stringify(patch), async () => {
      const f = await setup('builder', { patch });
      try {
        await f.page.goto('https://console.test');
        await f.page.locator('#cognitosignin').click();
        await f.page.waitForURL('https://identity.test/oauth2/authorize**');
        await f.page.goto('https://console.test/callback?code=synthetic-code&state=' + encodeURIComponent(f.state.authorize.state));
        await ready(f.page, '#cognitosignin');
        assert.equal(await f.page.locator('#tbprofile').count(), 0);
        assert.match(await f.page.locator('body').innerText(), /Sign-in could not be completed/);
      } finally { await f.context.close(); }
    });
  }
  await check('hosted queue has no fixtures/local decisions; native and supported rows retained', async () => {
    const f = await setup('admin');
    f.approvals.items = [approval('RESOURCE_PUBLICATION'), approval('PRODUCTION_DEPLOYMENT'), approval('FUTURE_KIND')];
    try {
      await signIn(f); await queue(f);
      assert.equal(await f.page.locator('#hitlreviewq,.hitlrqact,.hdec,.govact').count(), 0);
      assert.doesNotMatch(await f.page.locator('#main').innerText(), /Initiate wire transfer|Export medical records|Deploy prompt update|Fixture|console-local store/);
      assert.equal(await f.page.locator('[data-queue="reg-offline-skill-1.0.0"] .qreg').count(), 2);
      assert.equal(await f.page.locator('[data-kind="FUTURE_KIND"]').count(), 0);
      assert.match(await f.page.locator('#govqueue').innerText(), /read-only/);
      await shot(f, 'hosted-queue');
    } finally { await f.context.close(); }
  });
  for (const source of ['registry', 'approvals']) for (const mode of ['network-error', 'unavailable', 'malformed']) {
    await check(`${source} ${mode} retains other source and reports incomplete`, async () => {
      const f = await setup('admin');
      try {
        await signIn(f);
        // Enter the real queue with a retry control. Then fail only its read,
        // independently of bootstrap's separate registry inventory reads.
        f.approvals = { ok: false };
        await queue(f);
        f.approvals = { ok: true, resource: 'approvals', items: [approval('RESOURCE_PUBLICATION')], cursor: null };
        f[source] = mode === 'network-error' ? mode : mode === 'unavailable' ? { ok: false } : { ok: true };
        await f.page.waitForTimeout(1100); // Expire the existing 1s Registry cache.
        await f.page.locator('[data-queue-retry]').click();
        await poll(async () => (await f.page.locator('#govqueue').innerText()).includes(source === 'registry' ? 'Registry approvals are unavailable' : 'Hosted approvals are unavailable'), 'Failure settled');
        const text = await f.page.locator('#govqueue').innerText();
        assert.match(text, /unavailable.*incomplete/is); assert.doesNotMatch(text, /queue is clear/);
        assert.match(text, source === 'registry' ? /resource-publication/ : /Offline native skill/);
        await shot(f, source + '-' + mode);
      } finally { await f.context.close(); }
    });
  }
  for (const [kind, endpoint, role, domain] of [
    ['RESOURCE_PUBLICATION', 'governance/publication-decisions', 'admin', 'platform'],
    ['PRODUCTION_DEPLOYMENT', 'deployment-decisions', 'admin', 'platform'],
    ['RESOURCE_ACCESS', 'governance/access-decisions', 'lead', 'operations'],
  ]) {
    await check(kind + ' uses supported endpoint then reloads unchanged server status', async () => {
      const f = await setup(role, { domain }); f.approvals.items = [approval(kind, domain)];
      try {
        await signIn(f); await queue(f); const before = writes.length, reads = f.reads;
        await f.page.locator(`.hostedapproval[data-kind="${kind}"][data-decision="APPROVE"]`).click();
        await poll(() => f.reads > reads, 'Server readback');
        assert.equal(writes.length, before + 1); assert.equal(writes.at(-1).resource, endpoint);
        assert.equal(writes.at(-1).body.approvalId, f.approvals.items[0].id);
        assert.match(await f.page.locator('#govqueue').innerText(), /PENDING/);
      } finally { await f.context.close(); }
    });
  }
  await check('independent reviewer, scoped capabilities and unknown kind remain enforced', async () => {
    const f = await setup('lead', { domain: 'operations' });
    f.approvals.items = [approval('RESOURCE_PUBLICATION', 'operations', { requesterSubject: 'offline-person' }),
      approval('PRODUCTION_DEPLOYMENT', 'foreign'), approval('FUTURE_KIND', 'operations')];
    try {
      await signIn(f); await queue(f);
      assert.equal(await f.page.locator('.hostedapproval,.qreg').count(), 0);
      assert.match(await f.page.locator('#govqueue').innerText(), /different eligible reviewer/);
    } finally { await f.context.close(); }
  });
  for (const action of ['role-switch', 'signout']) {
    await check('pending approval read ignored after ' + action, async () => {
      const f = await setup('admin', { demo: true });
      try {
        await signIn(f); let release;
        f.pendingApprovals = new Promise(resolve => { release = resolve; });
        f.approvals.items = [approval('RESOURCE_PUBLICATION', 'platform', { id: 'stale-record' })];
        const before = f.reads;
        await f.page.locator('[data-shellnav="governance"]').click();
        await poll(() => f.reads > before, 'Pending read started');
        if (action === 'role-switch') {
          await f.page.locator('#tbrole').selectOption('builder');
          await poll(async () => await f.page.locator('#tbrole').inputValue() === 'builder', 'Role changed');
        } else {
          await f.page.locator('#tbprofile').click();
          await f.page.locator('#tbsignout').click();
        }
        release();
        await f.page.waitForTimeout(100);
        assert.doesNotMatch(await f.page.locator('body').innerText(), /stale-record/);
      } finally { await f.context.close(); }
    });
  }
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
} catch (error) {
  failures.push({ name: 'browser runner', error: error.stack });
} finally {
  if (browser) await browser.close();
  await writeFile(path.join(output, 'results.json'), JSON.stringify({
    offlineOnly: true, node: process.version, checks, passed: checks.length, failures, screenshots, writes,
    unexpected, errors, loaded: Object.fromEntries(loaded),
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}
