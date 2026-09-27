// OFFLINE ONLY: actual source functions in a VM; synthetic API/DOM boundaries.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import * as capabilities from '../infra/serverless-platform/lambda/authz/capabilities.mjs';
import { hostedActionEnabled, hostedApprovalActionEnabled } from './public/hosted-persona.mjs';
import { registryDecisionAllowed } from './public/registry-decision-target.mjs';
import { collectPagedItems } from './public/main-ui-compat.mjs';
import { projectPendingWork } from './public/pending-work.mjs';
import { hostedApprovalRequest } from './public/hosted-approval-request.mjs';

const source = readFileSync(new URL('./public/modules/app.mjs', import.meta.url), 'utf8');
test('submitted blueprint names and template fields render as text, not markup', () => {
  const ctx = app({ BP_IC:'', LOCK_IC:'', S:{}, URL }, ['blueprintCard', 'foundationRows', 'blueprintHarnessDetail']);
  vm.runInContext(source.match(/^const esc = .*$/m)[0], ctx);
  const value = '<img src=x onerror=alert(1)>';
  const html = ctx.blueprintCard({
    id: '" onclick="alert(1)', name:value, useCase:value,
    template:{framework:value,deployTarget:value,memory:value},
  }, {pick:true});
  assert.doesNotMatch(html, /<img|data-bp="" onclick=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&quot; onclick=&quot;/);
  assert.doesNotMatch(ctx.foundationRows({identity:value,memory:value}), /<img/);
  assert.doesNotMatch(ctx.blueprintHarnessDetail({source:{kind:'github',url:'javascript:alert(1)'}}), /href="javascript:/);
  assert.match(ctx.blueprintHarnessDetail({source:{kind:'github',url:'https://github.com/example/template'}}), /href="https:\/\/github.com\/example\/template"/);
});

function fn(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const backend = vm.createContext({ ...capabilities });
vm.runInContext(readFileSync(new URL('../infra/serverless-platform/lambda/api/identity.mjs', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, ''), backend);
function profile(role = 'builder', domain = 'platform', groups) {
  const claims = { sub: 'offline-subject', name: 'Offline Subject',
    'cognito:groups': groups || [role === 'admin' ? 'platform-admin' : role === 'user' ? 'end-user' : role === 'lead' ? 'domain-lead' : 'domain-builder', 'domain-' + domain.replaceAll('_', '-')] };
  return { ...backend.projectEffectiveIdentity(claims, {}, { demoOperatorAuthorized: false }), availableDemoDomains: [] };
}
function app(overrides = {}, names = ['usableCognitoProfile']) {
  const ctx = vm.createContext({
    usableDomainId: value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value) && value.length <= 64,
    sessionEpoch: 0, CANCELED_REQUEST: Symbol('canceled'), ...overrides,
  });
  ctx.sessionEpochIsCurrent = epoch => ctx.sessionEpoch === epoch;
  for (const name of names) vm.runInContext(fn(name), ctx);
  return ctx;
}
for (const role of ['admin', 'lead', 'builder', 'user']) {
  test(`actual backend permanent ${role} profile works with an empty demo selector`, () => {
    const value = profile(role);
    assert.equal(value.role, role);
    assert.equal(value.canSwitchDemoRole, false);
    assert.equal(app().usableCognitoProfile(value), true);
  });
}
test('permanent multi-domain membership uses the active member, not single-demo-domain equality', () => {
  const value = { ...backend.projectEffectiveIdentity({
    sub: 'offline-subject', 'cognito:groups': ['domain-builder', 'domain-platform', 'domain-operations'],
  }, { 'x-active-domain': 'platform' }, { demoOperatorAuthorized: false }), availableDemoDomains: [] };
  assert.deepEqual(Array.from(value.domains), ['platform', 'operations']);
  assert.equal(app().usableCognitoProfile(value), true);
});
test('permanent platform admin active scope need not be a Cognito domain group', () => {
  const value = { ...backend.projectEffectiveIdentity({
    sub: 'offline-subject', 'cognito:groups': ['platform-admin'],
  }, { 'x-active-domain': 'platform' }, { demoOperatorAuthorized: false }), availableDemoDomains: [] };
  assert.equal(app().usableCognitoProfile(value), true);
});
const demo = () => ({ ...backend.projectEffectiveIdentity({
  sub: 'offline-operator', 'cognito:groups': ['platform-admin', 'demo-operator'],
}, { 'x-demo-role': 'builder', 'x-active-domain': 'operations' },
{ availableDomains: [{ id: 'operations' }], availableDemoDomains: [{ id: 'operations' }], demoOperatorAuthorized: true }),
availableDemoDomains: [{ id: 'operations', name: 'Operations' }] });
test('authorized demo profile retains exact active domain and role authority', () => {
  assert.equal(app().usableCognitoProfile(demo()), true);
  for (const patch of [
    { availableDemoDomains: [] }, { domains: ['operations', 'platform'] },
    { canSwitchDemoRole: false }, { authenticatedRole: 'builder' },
    { availableDemoRoles: ['admin'] },
  ]) assert.equal(app().usableCognitoProfile({ ...demo(), ...patch }), false, JSON.stringify(patch));
});
test('malformed capabilities and unauthorized role/scope never become valid identities', () => {
  for (const patch of [
    { capabilities: null }, { capabilities: ['createAgent', null] }, { capabilities: [{}] },
    { capabilities: [''] }, { ok: false }, { domain: 'foreign' }, { domain: null },
    { domains: [] }, { user: '' }, { role: 'admin' }, { canSwitchDemoRole: true },
  ]) assert.equal(app().usableCognitoProfile({ ...profile(), ...patch }), false, JSON.stringify(patch));
});
function hydration() {
  let release, started;
  const requested = new Promise(resolve => { started = resolve; });
  const calls = [];
  const ctx = app({
    SESSION: null, S: {}, authMode: () => 'cognito', completeSignIn: async () => {},
    getAccessToken: () => 'offline-access', getDemoContext: () => ({ role: 'builder', domain: 'operations' }),
    api: () => new Promise(resolve => { release = resolve; started(); }),
    clearAuthentication: () => calls.push('clear-auth'), clearDemoContext: () => calls.push('clear-context'),
    clearDemoAssist: () => {}, clearActiveDemoJourney: () => {}, restoreDemoContext: () => {},
    readHostedGitHubCallback: () => null, mainHomeView: () => 'workspace',
    cognitoErrorMessage: () => 'Sign-in could not be completed.',
  }, ['usableCognitoProfile', 'demoContextWasRejected', 'authoritativeDemoContext', 'hydrateCognitoSession']);
  ctx.replaceSession = value => { ctx.sessionEpoch++; ctx.SESSION = value; ctx.S = {}; };
  ctx.resetSignedOutState = () => ctx.replaceSession(null);
  return { ctx, calls, requested, release: value => release(value) };
}
test('failed hydration reports a retryable bootstrap error without clearing authentication or stored context', async () => {
  const h = hydration(), pending = h.ctx.hydrateCognitoSession();
  await h.requested; h.release({ ok: false, code: 'UNAVAILABLE' }); await pending;
  assert.equal(h.ctx.SESSION, null);
  assert.deepEqual(h.calls, []);
  assert.equal(h.ctx.cognitoBootstrapError, 'Your domains could not be loaded. Try again.');
});
test('pending hydration cannot overwrite a newer signed-in or signed-out session', async () => {
  for (const next of [null, profile('admin')]) {
    const h = hydration(), pending = h.ctx.hydrateCognitoSession();
    await h.requested; h.ctx.replaceSession(next); h.release(profile());
    await pending; assert.equal(h.ctx.SESSION, next);
    assert.equal(h.calls.length, 0, 'stale work cannot clear newer authentication');
  }
});
const native = { id: 'native-skill', name: 'Offline native skill', type: 'Skill', domain: 'platform',
  _source: 'agentcore-registry', _registryId: 'OfflineRegistry',
  versions: [{ semver: '1.0.0', status: 'IN_REVIEW', _aws: { registryId: 'OfflineRegistry', recordId: 'OfflineRec01', awsStatus: 'PENDING_APPROVAL' } }] };
const approval = (kind = 'RESOURCE_PUBLICATION', extra = {}) => ({
  id: 'offline-approval', kind, domainId: 'platform', projectId: 'sample', resourceId: 'offline-resource',
  resourceType: 'AGENT', status: 'PENDING', requesterSubject: 'different-subject', ...extra,
});
function governance({ registry = { ok: true, source: 'aws', entries: [native] },
  approvals = { ok: true, resource: 'approvals', items: [], cursor: null }, buttons = [] } = {}) {
  const reason = { value: 'Offline manual reason' };
  const element = () => ({ innerHTML: '', className: '', dataset: {}, append(...nodes) { this.innerHTML += nodes.map(node => node.innerHTML).join(''); } });
  const box = { innerHTML: '', isConnected: true, querySelectorAll: selector => selector === '.hostedapproval' ? buttons : [], contains: button => buttons.includes(button),
    querySelector: selector => selector.includes('data-reason-for') ? reason : null,
    append(...nodes) { this.innerHTML += nodes.map(node => node.innerHTML).join(''); } };
  const calls = [];
  const records = buttons.map(({ dataset: data }) => approval(data.kind, {
    domainId: data.domain, projectId: data.project || null, resourceId: data.resource, resourceType: data.resourceType,
  }));
  if (records.length) approvals = { ok: true, resource: 'approvals', items: records, cursor: null };
  const ctx = app({
    SESSION: { ...profile('admin'), actor: 'offline-subject' }, S: {}, authMode: () => 'cognito',
    document: { getElementById: id => id === 'govqueue' ? box : null, createElement: element },
    crypto: webcrypto, TextEncoder, CSS: { escape: value => String(value) }, pendingHostedApprovalDecisions: new Map(), mountPublicationSubmission: () => {},
    api: async (path, body) => { calls.push({ path, body }); return typeof registry === 'function' ? registry() : registry; },
    readHostedCollection: async () => typeof approvals === 'function' ? approvals() : approvals,
    hostedCaps: () => capabilities.capabilitiesForRole('admin'), hasCap: () => true, activeDomain: () => null,
    esc: value => String(value ?? ''), REG_TYPE_ICON: {}, ICONS: {}, ic2: () => '', regStatusBadge: () => '',
    projectPendingWork, hostedModelReadContext: () => 'test-context', registryDecisionAllowed, hostedActionEnabled, hostedApprovalActionEnabled, hostedApprovalRequest, hostedEmpty: () => 'empty', hostedStatus: value => value,
    runSessionTask: () => {}, sessionTaskHandler: callback => callback, createRequestId: () => 'offline-id',
    requestDemoChoice: async () => 'Offline manual reason', alert: () => {}, loadGovMemBacklog: () => {},
    apiErrorMessage: (r, fallback) => r?.message || fallback,
  }, ['readGovPendingWork', 'pendingWorkSummaryHtml', 'loadGovQueue', 'hostedCollectionRow', 'hostedCollectionItems', 'hostedApprovalRecordAllowed', 'hostedApprovalReadOnlyReason', 'sameHostedApprovalRecord', 'revalidateHostedApproval', 'wireHostedApprovalActions']);
  return { ctx, box, calls, records };
}
test('fixture review card and dry-run functions removed from source', () => {
  // hitlReviewQueueCard, wireHitlReviewQueue, govDryRunCard, wireGovDryRun are deleted —
  // verify they no longer exist in the module so fixture content cannot appear.
  assert.equal(source.indexOf('function hitlReviewQueueCard('), -1, 'hitlReviewQueueCard removed');
  assert.equal(source.indexOf('function wireHitlReviewQueue('), -1, 'wireHitlReviewQueue removed');
  assert.equal(source.indexOf('function govDryRunCard('), -1, 'govDryRunCard removed');
  assert.equal(source.indexOf('function wireGovDryRun('), -1, 'wireGovDryRun removed');
});
for (const failure of [{ ok: false }, { ok: true, items: null }, () => { throw new Error('offline outage'); }]) {
  test(`approval failure retains native Registry rows and reports incomplete queue: ${String(failure)}`, async () => {
    const { ctx, box } = governance({ approvals: failure }); await ctx.loadGovQueue();
    assert.match(box.innerHTML, /Offline native skill/); assert.match(box.innerHTML, /unavailable|incomplete/i);
    assert.doesNotMatch(box.innerHTML, /queue is clear/i);
  });
}
test('Registry outage retains genuine approvals including resource access and unknown kinds read-only', async () => {
  const { ctx, box } = governance({ registry: () => { throw Error('offline outage'); },
    approvals: { ok: true, resource: 'approvals', cursor: null, items: [approval(), approval('RESOURCE_ACCESS', { id: 'access' }), approval('FUTURE_KIND', { id: 'unknown' })] } });
  await ctx.loadGovQueue();
  for (const text of ['offline-approval', 'access', 'unknown', 'unavailable']) assert.ok(box.innerHTML.includes(text));
  assert.doesNotMatch(box.innerHTML, /data-kind="FUTURE_KIND"/);
});
test('unavailable or malformed Registry cannot be presented as a clear queue', async () => {
  for (const registry of [{ ok: false }, { ok: true }, { ok: true, source: 'file-fallback', entries: [] }]) {
    const { ctx, box } = governance({ registry }); await ctx.loadGovQueue();
    assert.match(box.innerHTML, /unavailable|incomplete/i); assert.doesNotMatch(box.innerHTML, /queue is clear/);
  }
});
test('valid empty sources alone produce a clear queue', async () => {
  const { ctx, box } = governance({ registry: { ok: true, source: 'aws', entries: [] } });
  await ctx.loadGovQueue(); assert.match(box.innerHTML, /No formal approval requests in this scope/);
});
test('all native Registry rows remain, while native Agents never use the Registry writer', async () => {
  const entries = [native, { ...native, id: 'native-agent', type: 'Agent', name: 'Offline native agent', versions: [{ ...native.versions[0], _aws: { ...native.versions[0]._aws, recordId: 'OfflineRec02' } }] }];
  const { ctx, box } = governance({ registry: { ok: true, source: 'aws', entries },
    approvals: { ok: true, resource: 'approvals', cursor: null, items: [approval()] } });
  await ctx.loadGovQueue();
  assert.match(box.innerHTML, /Offline native skill/); assert.match(box.innerHTML, /Offline native agent/);
  assert.equal((box.innerHTML.match(/class="(?:primary|ghost) qreg"/g) || []).length, 2);
  assert.match(box.innerHTML, /data-kind="RESOURCE_PUBLICATION"/);
});
test('pending queue response cannot render after session replacement or navigation', async () => {
  for (const replaced of ['session', 'element']) {
    let release;
    const { ctx, box } = governance({ approvals: () => new Promise(resolve => { release = resolve; }) });
    const pending = ctx.loadGovQueue();
    if (replaced === 'session') ctx.sessionEpoch++; else box.isConnected = false;
    release({ ok: true, resource: 'approvals', cursor: null, items: [approval()] }); await pending;
    assert.equal(box.innerHTML, '');
  }
});
function button(kind = 'RESOURCE_PUBLICATION', decision = 'APPROVE') {
  return { isConnected: true, closest: () => null, dataset: { kind, resourceType: kind === 'PRODUCTION_DEPLOYMENT' ? 'DEPLOYMENT' : 'AGENT', decision, domain: 'platform', project: 'sample', resource: 'offline-resource', approval: 'offline-approval' } };
}
test('supported approval actions use existing exact endpoints and bodies only', async () => {
  for (const [kind, path, domain] of [
    ['PRODUCTION_DEPLOYMENT', '/deployment-decisions', 'platform'],
    ['RESOURCE_PUBLICATION', '/governance/publication-decisions', 'platform'],
    ['RESOURCE_ACCESS', '/governance/access-decisions', 'operations'],
  ]) {
    const b = button(kind); b.dataset.domain = domain;
    const { ctx, box, calls, records } = governance({ buttons: [b] });
    if (domain === 'operations') { ctx.hostedCaps = () => capabilities.capabilitiesForRole('lead'); ctx.activeDomain = () => domain; }
    let reloaded = 0; ctx.wireHostedApprovalActions(box, async () => reloaded++, records);
    await b.onclick(); assert.equal(calls[0].path, path); assert.equal(calls[0].body.approvalId, 'offline-approval');
    assert.equal(reloaded, 1);
  }
});
test('stale approval click, pending revalidation read, and late action result cannot cross sessions', async () => {
  for (const phase of ['click', 'revalidation', 'response']) {
    const b = button('RESOURCE_PUBLICATION', phase === 'revalidation' ? 'REJECT' : 'APPROVE');
    const { ctx, box, calls, records } = governance({ buttons: [b] }); let release, started, reloaded = 0;
    const entered = new Promise(resolve => { started = resolve; });
    if (phase === 'revalidation') ctx.readHostedCollection = () => new Promise(resolve => { release = resolve; started(); });
    if (phase === 'response') ctx.api = async (path, body) => { calls.push({ path, body }); return new Promise(resolve => { release = resolve; started(); }); };
    ctx.wireHostedApprovalActions(box, async () => reloaded++, records);
    if (phase === 'click') ctx.sessionEpoch++;
    const pending = b.onclick();
    if (phase !== 'click') await entered;
    if (phase !== 'click') { ctx.sessionEpoch++; release(phase === 'revalidation' ? { ok: true, resource: 'approvals', cursor: null, items: records } : { ok: true }); }
    await pending;
    assert.equal(calls.length, phase === 'response' ? 1 : 0, phase);
    assert.equal(reloaded, 0, phase);
  }
});
test('actual hosted collection reader uses the scoped paginated approvals contract', async () => {
  const paths = [];
  const ctx = app({ collectPagedItems, rawApi: async path => {
    paths.push(path);
    return { ok: true, resource: 'approvals', items: [approval()], cursor: paths.length === 1 ? 'next' : null };
  } }, ['readHostedCollection']);
  const result = await ctx.readHostedCollection('approvals');
  assert.equal(result.items.length, 2);
  assert.deepEqual(paths, ['/approvals?limit=50', '/approvals?limit=50&cursor=next']);
  ctx.rawApi = async () => ({ ok: true, resource: 'projects', items: [], cursor: null });
  assert.equal((await ctx.readHostedCollection('approvals')).ok, false);
});
test('own requester, missing requester, foreign scope and unknown kind cannot render decisions', () => {
  const { ctx } = governance();
  ctx.SESSION = profile('lead', 'operations');
  ctx.hostedCaps = () => capabilities.capabilitiesForRole('lead');
  ctx.activeDomain = () => 'operations';
  for (const row of [
    approval('RESOURCE_PUBLICATION', { domainId: 'operations', requesterSubject: 'offline-subject' }),
    approval('RESOURCE_PUBLICATION', { domainId: 'operations', requesterSubject: undefined }),
    approval('RESOURCE_PUBLICATION', { domainId: 'foreign' }),
    approval('FUTURE_KIND', { domainId: 'operations' }),
  ]) assert.doesNotMatch(ctx.hostedCollectionItems('approvals', [row], { approvalActions: true }), /class="ghost hostedapproval"/);
});
test('unsupported hosted resource inventories are unavailable without legacy writes or fabricated emptiness', async () => {
  const elements = new Map(['govagents', 'govmcp', 'gova2a'].map(id => [id, { innerHTML: '' }]));
  const ctx = app({ authMode: () => 'cognito', document: { getElementById: id => elements.get(id) },
    api: () => assert.fail('Unsupported hosted /governance call') }, ['loadGovResources']);
  await ctx.loadGovResources();
  for (const element of elements.values()) {
    assert.match(element.innerHTML, /unavailable/);
    assert.doesNotMatch(element.innerHTML, /No deployed|No MCP|No A2A|govact/);
  }
});
test('superseded queue reads cannot replace newer results in the same DOM', async () => {
  let release;
  const { ctx, box } = governance({ approvals: () => new Promise(resolve => { release = resolve; }) });
  const old = ctx.loadGovQueue();
  ctx.readHostedCollection = async () => ({ ok: true, resource: 'approvals', cursor: null, items: [approval('RESOURCE_PUBLICATION', { id: 'new-approval' })] });
  await ctx.loadGovQueue();
  release({ ok: true, resource: 'approvals', cursor: null, items: [approval('RESOURCE_PUBLICATION', { id: 'old-approval' })] });
  await old;
  assert.match(box.innerHTML, /new-approval/); assert.doesNotMatch(box.innerHTML, /old-approval/);
});
test('actual replaceSession aborts old requests, clears drafts/caches and resets scoped state', () => {
  const controller = new AbortController(), cleared = [];
  const ctx = app({ S: { workspaceProjects: ['old'], hitlQueue: ['old'] }, activeSessionRequests: new Set([{ controller }]),
    activeSessionTimeouts: new Set(), activeSessionIntervals: new Set(), pendingHostedApprovalDecisions: new Map(),
    clearBusinessDrafts: () => cleared.push('drafts'), clearHostedRegistryReadCache: () => cleared.push('registry'),
    setSession: value => { ctx.SESSION = value; }, createUserState: () => ({ view: 'workspace' }),
  }, ['invalidateSessionWork', 'replaceSession']);
  const next = profile();
  ctx.replaceSession(next);
  assert.equal(controller.signal.aborted, true);
  assert.equal(ctx.sessionEpoch, 1);
  assert.equal(ctx.SESSION, next);
  assert.deepEqual(cleared, ['drafts', 'registry']);
  assert.equal(ctx.S.workspaceProjects, undefined); assert.equal(ctx.S.hitlQueue, undefined);
});
test('pending demo switch invalidates old work immediately and never restores over a newer session', async () => {
  for (const reject of [false, true]) {
    let release, fail, started;
    const requested = new Promise(resolve => { started = resolve; });
    const initial = demo();
    const ctx = app({
      SESSION: initial, S: { view: 'workspace' }, demoContextSwitching: false,
      authMode: () => 'cognito', confirmContextChange: () => true, getDemoContext: () => null,
      setDemoContext: () => {}, setDemoControlsDisabled: () => {},
      api: () => new Promise((resolve, reject) => { release = resolve; fail = reject; started(); }),
      restoreDemoContext: () => assert.fail('stale context restoration'),
      failClosedCognitoSession: () => assert.fail('stale switch cleared a newer session'),
      render: () => {}, getAccessToken: () => 'offline',
    }, ['usableCognitoProfile', 'switchDemoContext', 'sameAuthenticatedIdentity']);
    ctx.invalidateSessionWork = () => ctx.sessionEpoch++;
    const pending = ctx.switchDemoContext({ role: 'lead', domain: 'operations' });
    await requested; assert.equal(ctx.sessionEpoch, 1);
    ctx.sessionEpoch++; ctx.SESSION = profile('user');
    const next = ctx.SESSION;
    if (reject) fail(ctx.CANCELED_REQUEST); else release({ ...initial, role: 'lead' });
    await pending;
    assert.equal(ctx.SESSION, next);
  }
});
