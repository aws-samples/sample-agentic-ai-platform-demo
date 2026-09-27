import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as costs from './public/cost-view.mjs';
import * as operations from './public/modules/workspace-scope.mjs';
import * as monitoring from './public/platform-monitoring-view.mjs';
import * as workspaceTabs from './public/workspace-tabs-view.mjs';

const source = readFileSync(new URL('./public/modules/app.mjs', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `actual app function ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const projects = [
  { id: 'sample', domain: 'domain_a', name: 'Alpha', agents: ['a'] },
  { id: 'second', domain: 'domain_a', name: 'Second', agents: ['b'] },
  { id: 'sample', domain: 'domain_b', name: 'Beta same slug', agents: ['c'] },
];
const window = { startTime: '2026-09-10T00:00:00.000Z', endTime: '2026-09-11T00:00:00.000Z' };
const costPage = (items = []) => ({ ok: true, resource: 'costs', scope: { type: 'projects' }, window, items, cursor: null });
const costRow = (domainId, projectId, estimatedCostUsd) => ({
  scopeType: 'project', domainId, projectId, estimatedCostUsd, knownEstimatedCostUsd: estimatedCostUsd,
  currency: 'USD', basis: 'estimate', contractVersion: 1,
});
function setup(role = 'admin', state = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {}, isConnected: true, dataset: {},
      querySelectorAll: () => [], querySelector: () => null, focus() {}, addEventListener() {} });
    return elements.get(id);
  };
  const switches = projects.map(p => ({ dataset: { project: p.id, domain: p.domain }, style: {} }));
  el('wsroot').querySelectorAll = selector => selector === '.wsswitchitem' ? switches : [];
  const calls = [], renders = [];
  const ctx = vm.createContext({ ...costs, ...operations, ...monitoring, ...workspaceTabs, hostedWindowControl: () => '', S: { workspaceProjects: projects, workspaceProject: 'sample', workspaceDomain: 'domain_a', wsTab: 'cost', view: 'workspace', obsScope: { type: 'domain', id: 'domain_a' }, ...state },
    SESSION: { role }, SHELL: () => role, SHELL_NAV: { builder: [] }, ICONS: {}, ic2: () => '',
    FOLDER_IC: '', esc: v => String(v), domainLabel: d => d, pluralize: (n, s) => `${n} ${s}`,
    authMode: () => 'cognito', activeDomain: () => 'domain_a', scopeNote: () => '', storyLine: () => '',
    document: { getElementById: el, querySelectorAll: () => [] },
    clearBusinessDrafts:()=>{}, confirmContextChange: () => true, invalidateSessionWork: () => { ctx.sessionEpoch++; },
    sessionEpoch: 0, sessionEpochIsCurrent: epoch => epoch === ctx.sessionEpoch,
    CANCELED_REQUEST: Symbol('canceled'), runSessionTask: f => f(), sessionTaskHandler: f => f,
    render: () => renders.push(ctx.S.view), api: async path => { calls.push(path); return { ok: true, projects }; },
    wireHostedCostBudgets: () => {}, loadWorkspaceTab: async () => {},
  });
  for (const name of ['ensureWorkspaceProjects', 'vWorkspace', 'loadWorkspace', 'vObservability', 'loadScopedHostedCost', 'loadWorkspaceObservability', 'vHostedOperations', 'loadHostedOperations']) vm.runInContext(fn(name), ctx);
  // New functions are loaded when present, leaving the original path intact for red tests.
  for (const name of ['workspaceSelectionStorage', 'groupProjectsByDomain', 'workspaceProjectMatches', 'selectWorkspaceProject', 'workspaceRequestIsCurrent', 'workspaceFunction', 'workspaceScopeText', 'workspaceProjectState', 'readWorkspaceProjects']) {
    if (source.includes(`function ${name}(`)) vm.runInContext(fn(name), ctx);
  }
  return { ctx, el, switches, calls, renders };
}
for (const role of ['admin', 'lead', 'builder']) test(`${role}: actual workspace renders only sidebar navigation, retaining project heading and switcher`, async () => {
  const { ctx, el } = setup(role);
  await ctx.loadWorkspace();
  assert.doesNotMatch(el('wsroot').innerHTML, /id="wstabs"|class="ghost wstabbtn/);
  assert.match(el('wsroot').innerHTML, /<h1|id="wsswitchbtn"/);
});
test('project switch preserves Cost, clears stale selection/cache, and distinguishes same slug across domains', async () => {
  const { ctx, switches } = setup('builder', { traceAgent: 'a', obsScopes: { private: true }, fleetAgent: { id: 'a' }, detail: { private: true } });
  await ctx.loadWorkspace();
  switches[2].onclick();
  assert.equal(ctx.S.workspaceDomain, 'domain_b');
  assert.equal(ctx.S.workspaceProject, 'sample');
  assert.equal(ctx.S.wsTab, 'cost');
  assert.equal(ctx.S.traceAgent, '');
  assert.equal(ctx.S.obsScopes, null);
  assert.equal(ctx.S.detail, null);
  assert.equal(ctx.sessionEpoch, 1);
});
test('same-domain project switch preserves functional page', async () => {
  const { ctx, switches } = setup('builder', { view: 'observability', wsTab: 'obs' });
  await ctx.loadWorkspace();
  switches[1].onclick();
  assert.equal(ctx.S.workspaceProject, 'second');
  assert.equal(ctx.S.view, 'observability');
  assert.equal(ctx.S.wsTab, 'obs');
});
test('selected project lookup requires exact domain and project, not first matching slug', async () => {
  const { ctx, el } = setup('builder', { workspaceDomain: 'domain_b' });
  await ctx.loadWorkspace();
  assert.match(el('wsroot').innerHTML, /Beta same slug/);
  assert.doesNotMatch(el('wsroot').innerHTML.split('id="wsswitchwrap"')[0], /Alpha/);
});
test('403 project list does not become cached empty success or select a global project', async () => {
  const { ctx } = setup('admin', { workspaceProjects: null });
  ctx.rawApi = ctx.api = async () => ({ ok: false, code: 'FORBIDDEN' });
  await assert.rejects(ctx.ensureWorkspaceProjects());
  assert.equal(ctx.S.workspaceProjects, null);
});
test('workspace scope copy distinguishes platform, domain lead, and assigned builder projects', () => {
  assert.match(setup('admin').ctx.workspaceScopeText(), /Platform domain projects only/);
  assert.match(setup('lead').ctx.workspaceScopeText(), /all projects in domain_a/);
  assert.match(setup('builder').ctx.workspaceScopeText(), /projects assigned to you in domain_a/);
});
test('Observability enters selected workspace header instead of domain agents/global trace loaders', async () => {
  const { ctx } = setup('admin', { obsScopes: { domains: [{ id: 'domain_a', agents: [{ id: 'foreign', label: 'Foreign agent' }] }] } });
  const html = await ctx.vObservability();
  assert.match(html, /id="wsroot"/);
  assert.doesNotMatch(html, /all workspace projects|Foreign agent|id="tracebox"/);
});
test('delayed old cost response cannot overwrite new scope or reporting window', async () => {
  const { ctx, el } = setup();
  let release;
  ctx.api = () => new Promise(resolve => { release = resolve; });
  const box = el('cost');
  const pending = ctx.loadScopedHostedCost(box, { domainId: 'domain_a', projectId: 'sample' });
  ctx.sessionEpoch++;
  box.innerHTML = 'new scope';
  release(costPage([costRow('domain_a', 'sample', 987)]));
  await pending;
  assert.equal(box.innerHTML, 'new scope');
});
for (const response of [{ ok: false, code: 'FORBIDDEN' }, costPage(), new Error('unavailable')]) test(`project cost ${response.code || (response instanceof Error ? 'error' : 'empty')} never falls back to global totals`, async () => {
  const { ctx, el, calls } = setup();
  ctx.api = async path => { calls.push(path); if (response instanceof Error) throw response; return response; };
  await ctx.loadScopedHostedCost(el('cost'), { domainId: 'domain_a', projectId: 'sample' });
  assert.equal(calls.length, 1);
  assert.deepEqual([...new URLSearchParams(calls[0].split('?')[1]).keys()].sort(), ['groupBy', 'limit', 'window']);
  assert.match(el('cost').innerHTML, /unavailable|No usage data/i);
  assert.doesNotMatch(el('cost').innerHTML, /\$0/);
});
test('same admin project and platform costs have distinct totals and layouts', async () => {
  const { ctx, el } = setup();
  const page = costPage([costRow('domain_a', 'sample', 2), costRow('domain_a', 'second', 3), costRow('domain_b', 'sample', 90)]);
  ctx.api = async () => page;
  await ctx.loadScopedHostedCost(el('cost'), { domainId: 'domain_a', projectId: 'sample' });
  const html = el('cost').innerHTML;
  assert.match(html, /\$2\.00/);
  assert.doesNotMatch(html, /domain_b|\$95\.00|Domain cost summary|Account-wide Cost Explorer/);
  assert.match(html, /data-project-cost/);
  assert.match(costs.hostedCostHtml(page), /\$95\.00|Domain cost summary/);
});

const agentPage = { ok: true, resource: 'agents', cursor: null, items: [
  { id: 'a', name: 'Own A', domainId: 'domain_a', projectId: 'sample', status: 'DRAFT' },
  { id: 'b', name: 'Other project B', domainId: 'domain_a', projectId: 'second', status: 'DRAFT' },
  { id: 'c', name: 'Foreign domain C', domainId: 'domain_b', projectId: 'sample', status: 'DRAFT' },
] };
const opsPage = (items, scope = { type: 'projects', domainId: 'domain_a', projectIds: ['sample', 'second'] }) => ({ ok: true, resource: 'operations', scope, window, cursor: null, items });
const op = (projectId, requests) => ({ scopeType: 'project', domainId: 'domain_a', projectId, invocationCount: requests, runtimeCount: 1, healthyRuntimeCount: 1, errorCount: 0, averageLatencyMs: null });

test('actual workspace Observability uses own project agents and never requests native traces without a backend contract', async () => {
  const { ctx, el, calls } = setup('admin', { obsTab: 'traces', traceAgent: 'c' });
  ctx.readHostedCollection = async resource => { calls.push(resource); return agentPage; };
  await ctx.loadWorkspaceObservability(projects[0]);
  assert.match(el('wsbody').innerHTML, /Own A/);
  assert.doesNotMatch(el('wsbody').innerHTML, /Other project B|Foreign domain C/);
  assert.match(el('workspaceobsdetail').innerHTML, /Project native traces are unavailable/);
  assert.equal(ctx.S.traceAgent, '');
  assert.equal(ctx.S.obsScope.domainId, 'domain_a');
  assert.equal(ctx.S.obsScope.id, 'sample');
  assert.deepEqual(calls, ['agents']);
  el('workspaceobsagent').value = 'c';
  el('workspaceobsagent').onchange();
  assert.equal(ctx.S.traceAgent, '');
  assert.deepEqual(calls, ['agents'], 'foreign selection performs no request');
});

test('actual project metrics reject admin/lead aggregates, and select only exact builder project rows', async () => {
  for (const scope of [{ type: 'platform' }, { type: 'domain', domainId: 'domain_a' }, { type: 'projects', domainId: 'domain_a' }]) {
    const { ctx, el, calls } = setup('builder', { obsTab: 'metrics' });
    ctx.readHostedCollection = async () => agentPage;
    ctx.api = async path => {
      calls.push(path);
      return scope.type === 'projects' ? opsPage([op('sample', 12), op('second', 987)], scope)
        : opsPage([{ scopeType: scope.type, domainId: scope.domainId || null, projectId: null, invocationCount: 987 }], scope);
    };
    await ctx.loadWorkspaceObservability(projects[0]);
    const html = el('workspaceobsdetail').innerHTML;
    assert.doesNotMatch(html, /987/);
    if (scope.type === 'projects') { assert.match(html, /12/); assert.match(html, /Unavailable/); }
    else assert.match(html, /data-obs-unavailable|project.*telemetry|metrics.*unavailable/i);
    assert.deepEqual(calls, ['/operations?window=24h&limit=50']);
  }
});

for (const response of [{ ok: false, code: 'FORBIDDEN' }, new Error('network')]) test(`observability agents ${response.code || (response instanceof Error ? 'error' : 'empty')} cannot widen to domain or platform`, async () => {
  const { ctx, el, calls } = setup('builder', { obsTab: 'traces', traceAgent: 'foreign' });
  ctx.readHostedCollection = async () => { if (response instanceof Error) throw response; return response; };
  await ctx.loadWorkspaceObservability(projects[0]);
  assert.equal(ctx.S.traceAgent, '');
  assert.deepEqual(calls, []);
  // Error and forbidden paths set body.innerHTML directly with an unavailable message.
  assert.match(el('wsbody').innerHTML, /unavailable/i);
});

test('observability empty agent list resets traceAgent and renders project scope chip', async () => {
  const { ctx, el, calls } = setup('builder', { obsTab: 'traces', traceAgent: 'foreign' });
  ctx.readHostedCollection = async () => ({ ...agentPage, items: [] });
  await ctx.loadWorkspaceObservability(projects[0]);
  assert.equal(ctx.S.traceAgent, '');
  assert.deepEqual(calls, []);
  // Empty agents: body shows the project scope chip and tab controls; the
  // detail panel (separate element in the DOM) renders the tab-specific message.
  assert.match(el('wsbody').innerHTML, /obsscopechip|domain_a.*sample/i);
  assert.doesNotMatch(el('wsbody').innerHTML, /domain_b|second/);
});

test('delayed operations and agent lists cannot render under a new project', async () => {
  for (const delayed of ['operations', 'agents']) {
    const { ctx, el } = setup('builder', { obsTab: 'metrics' });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    ctx.readHostedCollection = async () => delayed === 'agents' ? pending : agentPage;
    ctx.api = async () => pending;
    const loading = ctx.loadWorkspaceObservability(projects[0]);
    await new Promise(resolve => setImmediate(resolve));
    ctx.sessionEpoch++;
    el('wsbody').innerHTML = 'new project'; el('workspaceobsdetail').innerHTML = 'new metrics';
    release(delayed === 'agents' ? agentPage : opsPage([op('sample', 987)]));
    await loading;
    assert.equal(el('wsbody').innerHTML, 'new project');
    assert.equal(el('workspaceobsdetail').innerHTML, 'new metrics');
  }
});

test('overlapping cost requests: newest reporting window wins even within the same session', async () => {
  const { ctx, el } = setup();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let n = 0;
  ctx.api = async () => ++n === 1 ? waiting : costPage([costRow('domain_a', 'sample', 2)]);
  const old = ctx.loadScopedHostedCost(el('cost'), { domainId: 'domain_a', projectId: 'sample' });
  ctx.S.workspaceCostWindow = '7d';
  await ctx.loadScopedHostedCost(el('cost'), { domainId: 'domain_a', projectId: 'sample' });
  release(costPage([costRow('domain_a', 'sample', 987)])); await old;
  assert.match(el('cost').innerHTML, /\$2\.00/);
  assert.doesNotMatch(el('cost').innerHTML, /987/);
});

test('Operations pagination fails closed on duplicate scopes, cursor loops, changed window and forbidden pages', async () => {
  const first = { ...opsPage([op('sample', 12)]), cursor: 'next' };
  for (const next of [opsPage([op('sample', 987)]), { ...opsPage([]), cursor: 'next' }, { ...opsPage([]), window: { ...window, endTime: '2026-09-12T00:00:00.000Z' } }, { ok: false, code: 'FORBIDDEN' }]) {
    const responses = [first, next], calls = [];
    await assert.rejects(operations.loadOperationsPages(async path => { calls.push(path); return responses.shift(); }, '7d'));
    assert.deepEqual(calls, ['/operations?window=7d&limit=50', '/operations?window=7d&limit=50&cursor=next']);
  }
});

test('platform/domain telemetry renders only authorized aggregate allowlisted metrics, never private payload or invented zero', () => {
  const page = opsPage([{ scopeType: 'platform', domainId: null, projectId: null, invocationCount: 12, p95LatencyMs: null, prompt: 'PRIVATE PROMPT', traces: [{ text: 'PRIVATE TRACE' }] }], { type: 'platform' });
  const html = operations.operationsHtml(page);
  assert.match(html, /Entire platform|12|Unavailable/);
  assert.doesNotMatch(html, /PRIVATE|<b>0/);
  assert.match(operations.operationsHtml(page, { domainId: 'domain_a' }), /Domain metrics are unavailable/);
  const domain = opsPage([op('sample', 2), { ...op('sample', 987), domainId: 'domain_b' }]);
  assert.doesNotMatch(operations.operationsHtml(domain, { domainId: 'domain_a' }), /987|domain_b/);
});

test('removed or unauthorized selected pair is unavailable, never replaced with another project automatically', async () => {
  const { ctx, el } = setup('builder', { workspaceDomain: 'domain_c', workspaceProject: 'sample' });
  await ctx.loadWorkspace();
  assert.match(el('wsroot').innerHTML, /selected project is unavailable/);
  assert.equal(ctx.S.workspaceDomain, 'domain_c');
  assert.doesNotMatch(el('wsroot').innerHTML, /id="wsbody"|data-project-cost/); // Explicit choices are safe; no different project's data loads.
});

test('multiple projects without a selection render a chooser and no project body', async () => {
  const {ctx,el}=setup('lead',{workspaceProject:null,workspaceDomain:null});
  await ctx.loadWorkspace();
  assert.match(el('wsroot').innerHTML,/data-workspace-state="choose"/);
  assert.doesNotMatch(el('wsroot').innerHTML,/id="wsbody"/);
  assert.equal(ctx.S.workspaceProject,null);
});
test('stale legacy project is not silently replaced by the first inventory item', async () => {
  const {ctx,el}=setup('builder',{workspaceProject:'removed',workspaceDomain:null});
  await ctx.loadWorkspace();
  assert.match(el('wsroot').innerHTML,/unavailable or ambiguous/);
  assert.doesNotMatch(el('wsroot').innerHTML,/id="wsbody"/);
});
test('expired persisted choice remains an explicit chooser across page renders', async () => {
  const {ctx,el}=setup('lead',{workspaceProject:null,workspaceDomain:null,workspaceProjects:[projects[0]],workspaceSelectionChecked:true,workspaceSelectionRequired:true});
  await ctx.loadWorkspace();await ctx.loadWorkspace();
  assert.match(el('wsroot').innerHTML,/data-workspace-state="choose"/);
  assert.doesNotMatch(el('wsroot').innerHTML,/id="wsbody"/);
});
test('no active domain cannot populate workspace with cross-domain inventory', async () => {
  const {ctx}=setup('lead',{workspaceProjects:null});
  ctx.activeDomain=()=>null;
  ctx.loadWorkspaceProjectPages=async()=>projects.map(p=>({...p,domainId:p.domain,status:'ACTIVE'}));
  ctx.rawApi=()=>{};
  assert.deepEqual(Array.from(await ctx.ensureWorkspaceProjects()),[]);
});

test('legacy slug-only selection is never guessed when two domains share that project slug', async () => {
  const { ctx, el } = setup('builder', { workspaceDomain: null });
  await ctx.loadWorkspace();
  assert.match(el('wsroot').innerHTML, /ambiguous/);
  assert.doesNotMatch(el('wsroot').innerHTML, /id="wsbody"/);
  assert.equal(ctx.S.workspaceDomain, null);
});

test('project navigation aborts actual pending session requests and discards timeouts before re-render', () => {
  const { ctx } = setup('builder');
  let aborted = 0, cacheCleared = 0;
  ctx.pendingHostedApprovalDecisions = new Set();
  ctx.activeSessionRequests = new Set([{ controller: { abort: () => { aborted++; } } }]);
  ctx.activeSessionTimeouts = new Set(); ctx.activeSessionIntervals = new Set();
  ctx.clearHostedRegistryReadCache = () => { cacheCleared++; };
  ctx.clearTimeout = () => {}; ctx.clearInterval = () => {};
  vm.runInContext(fn('invalidateSessionWork'), ctx);
  ctx.selectWorkspaceProject(projects[1]);
  assert.equal(aborted, 1);
  assert.equal(ctx.activeSessionRequests.size, 0);
  assert.equal(ctx.sessionEpoch, 1);
  assert.equal(cacheCleared, 1);
  assert.equal(ctx.S.workspaceProject, 'second');
});

test('actual monitoring renders platform metadata without foreign scoped-detail links or private telemetry payload', async () => {
  const { ctx, el } = setup('admin');
  ctx.api = async () => opsPage([{ scopeType: 'platform', domainId: null, projectId: null, invocationCount: 8, prompt: 'PRIVATE' }], { type: 'platform' });
  await ctx.loadHostedOperations();
  // Admin path uses platformMonitoringHtml: shows invocation count in new KPI format.
  assert.match(el('hostedoperations').innerHTML, /Total invocations: <b>8/);
  // Private payload fields and trace components must never appear.
  assert.doesNotMatch(el('hostedoperations').innerHTML, /PRIVATE|tracebox|lfbox/);
  // Admin path does not render the project inventory section (no per-domain breakdown from platform aggregate).
  assert.doesNotMatch(el('hostedoperations').innerHTML, /data-monitoring-projects/);
});

// Synthetic browser SecurityError getter, actual renderer/selection functions.
function denyStorageGetter(ctx){
  ctx.SESSION={user:'synthetic-builder',role:'builder',domain:'domain_a'};
  const browserGlobal={};
  Object.defineProperty(browserGlobal,'sessionStorage',{get(){throw Object.assign(new Error('Synthetic storage blocked'),{name:'SecurityError'});}});
  ctx.globalThis=browserGlobal;
}
test('storage getter SecurityError cannot interrupt first Workspace chooser rendering',async()=>{
  const {ctx,el}=setup('builder',{workspaceProject:null,workspaceDomain:null});
  denyStorageGetter(ctx);
  await ctx.loadWorkspace();
  assert.match(el('wsroot').innerHTML,/Choose a project to continue/);
  assert.equal(ctx.S.workspaceProject,null);
});
test('storage getter SecurityError cannot prevent confirmed project switch from rendering',()=>{
  const {ctx,renders}=setup('builder');denyStorageGetter(ctx);
  ctx.selectWorkspaceProject(projects[1]);
  assert.equal(ctx.S.workspaceProject,'second');assert.equal(ctx.S.workspaceDomain,'domain_a');
  assert.equal(ctx.sessionEpoch,1);assert.equal(renders.length,1);
});
test('storage getter SecurityError does not alter Cancel draft and selection semantics',()=>{
  const {ctx,renders}=setup('builder');denyStorageGetter(ctx);let cleared=0;
  ctx.confirmContextChange=()=>false;ctx.clearBusinessDrafts=()=>{cleared++;};
  ctx.selectWorkspaceProject(projects[1]);
  assert.equal(ctx.S.workspaceProject,'sample');assert.equal(ctx.sessionEpoch,0);assert.equal(cleared,0);assert.equal(renders.length,0);
});
test('storage getter SecurityError does not hide project read failure or empty state',async()=>{
  for(const failing of [false,true]){
    const {ctx,el}=setup('builder',{workspaceProjects:[],workspaceProject:null,workspaceDomain:null});denyStorageGetter(ctx);
    if(failing)ctx.ensureWorkspaceProjects=async()=>{throw Error('Project list is unavailable.');};
    await ctx.loadWorkspace();
    assert.match(el('wsroot').innerHTML,failing?/data-workspace-state="error"/:/data-workspace-state="empty"/);
  }
});

// ---------- groupProjectsByDomain unit tests ----------
{
  const ctx = vm.createContext({});
  vm.runInContext(fn('groupProjectsByDomain'), ctx);
  const group = ctx.groupProjectsByDomain;

  test('groupProjectsByDomain returns empty array for empty input', () => {
    const r = group([]); assert.equal(r.length, 0);
  });
  test('groupProjectsByDomain keeps single-domain list as one group', () => {
    const result = group([{id:'a',domain:'domain_a',name:'A'},{id:'b',domain:'domain_a',name:'B'}]);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'domain_a');
    assert.equal(result[0].projects.length, 2);
  });
  test('groupProjectsByDomain splits multi-domain list preserving insertion order', () => {
    const input = [{id:'a',domain:'domain_b',name:'B'},{id:'b',domain:'domain_a',name:'A'},{id:'c',domain:'domain_b',name:'C'}];
    const result = group(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].domain, 'domain_b');
    assert.equal(result[0].projects.length, 2);
    assert.equal(result[1].domain, 'domain_a');
    assert.equal(result[1].projects.length, 1);
  });
  test('groupProjectsByDomain preserves project objects by reference', () => {
    const p = {id:'x',domain:'domain_a',name:'X'};
    const result = group([p]);
    assert.strictEqual(result[0].projects[0], p);
  });
}
