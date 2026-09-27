// TEST ONLY: execute the actual application functions, never a reconstructed UI.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { foundationCatalog } from './public/domain-foundation-catalog.mjs';
import { readFileSync } from 'node:fs';
import * as scope from './public/modules/workspace-scope.mjs';
import { collectPagedItems } from './public/main-ui-compat.mjs';
import { createDirtyTracker } from './public/dirty-state.mjs';
import { createFormDirtyGuard } from './public/form-dirty-guard.mjs';
import { hostedActionEnabled } from './public/hosted-persona.mjs';
const source = readFileSync(new URL('./public/modules/app.mjs', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const projects = [
  { id: 'same', domainId: 'domain_a', name: 'Alpha', status: 'ACTIVE' },
  { id: 'second', domainId: 'domain_a', name: 'Second', status: 'ACTIVE' },
  { id: 'same', domainId: 'domain_b', name: 'Foreign same slug', status: 'ACTIVE' },
];
const page = items => ({ ok: true, resource: 'projects', items, cursor: null });
function setup(role = 'lead', state = {}) {
  const elements = new Map(), calls = [], prompts = [];
  const el = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {}, isConnected: true, value: '', dataset: {},
      querySelectorAll: () => [], querySelector: selector => selector === '[data-project-setup]' ? el('setup') : null,
      focus() {}, addEventListener() {} });
    return elements.get(id);
  };
  const ctx = vm.createContext({ foundationCatalog, ...scope, collectPagedItems, composeDirty:createDirtyTracker(), composeDraft:()=>({}), businessForms:createFormDirtyGuard(), wizardDirty:createDirtyTracker(), domainBootstrapDirty:()=>false, projectBudgetDirty:()=>false, clearBusinessDrafts:()=>{}, S: { view: 'workspace', wsTab: 'cost', workspaceProjects: null, ...state },
    SESSION: { role, canSwitchDemoRole: true, capabilities: role === 'lead' ? ['createDomainProject','manageDomainEntitlements','manageDomainMembers'] : [] },
    SHELL: () => role, activeDomain: () => 'domain_a', authMode: () => 'cognito', sessionEpoch: 0,
    sessionEpochIsCurrent: epoch => epoch === ctx.sessionEpoch, CANCELED_REQUEST: Symbol('cancel'),
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null },
    esc: value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), domainLabel: value => value, ICONS: {}, FOLDER_IC: '', pluralize: (n, s) => `${n} ${s}`,
    hostedActionEnabled, hostedCaps: () => ctx.SESSION.capabilities,
    api: async (path, body, options) => { calls.push({ path, body, options }); return path === '/registry' ? {ok:true,entries:[]} : page(projects); },
    rawApi: async (path, body, options) => { calls.push({ path, body, options }); return path === '/registry' ? {ok:true,entries:[]} : page(projects); },
    runSessionTask: f => f(), sessionTaskHandler: f => f, render: () => {},
    invalidateSessionWork: () => ctx.sessionEpoch++, loadWorkspaceTab: async () => {},
    scopeNote: () => '', apiErrorMessage: (r, fallback) => r?.message || fallback,
    confirm: message => { prompts.push(message); return false; }, prompt: () => 'manually entered reason',
    createRequestId: () => 'test-id',
  });
  for (const name of ['hasUnsavedContextChanges','confirmContextChange','workspaceProjectMatches','selectWorkspaceProject',
    'ensureWorkspaceProjects','loadWorkspace','loadHostedProjectSetup','loadDomainConsole','wizOpen','renderWizard',
    'applyDemoAssistToHostedView','requestDemoChoice','hostedAccessDomainId','hostedAccessDomainProjects',
    'hostedAccessSelectedProject','loadHostedAccessAdmin','loadHostedMemberships']) vm.runInContext(fn(name), ctx);
  for (const name of ['workspaceSelectionStorage','groupProjectsByDomain','workspaceFunction','workspaceScopeText','workspaceProjectState','hostedProjectCreateAllowed','readWorkspaceProjects',
    'renderHostedProjectWizard','wireHostedProjectWizard','collectHostedProjectWizard','validateHostedProjectWizard',
    'createHostedWizardProject','loadHostedMemberPage']) if (source.includes(`function ${name}(`)) vm.runInContext(fn(name), ctx);
  vm.runInContext(source.match(/^const WIZ_STEPS=.*$/m)[0], ctx);
  return { ctx, el, calls, prompts };
}
for (const [tab, title] of [['fleet','Fleet'],['memorykb','Memory & KB'],['cost','Cost & Budget'],['obs','Observability']]) {
  test(`genuine empty ${tab} preserves destination with explicit chooser, no automatic form`, async () => {
    const { ctx, el } = setup('lead', { wsTab: tab, workspaceProjects: [] });
    let setups = 0; ctx.loadHostedProjectSetup = async () => { setups++; };
    await ctx.loadWorkspace();
    assert.match(el('wsroot').innerHTML, new RegExp(`<h1>${title.replace('&', '&(?:amp;)?')}`));
    assert.match(el('wsroot').innerHTML, /data-workspace-state="empty"/);
    assert.equal(setups, 0);
    assert.equal(ctx.S.wsTab, tab);
  });
}
for (const [response, message] of [[{ ok: false, code: 'FORBIDDEN' }, /denied/i], [{ ok: false, code: 'WORKSPACE_UNAVAILABLE' }, /unavailable/i], [{ ok: true, resource: 'projects' }, /invalid/i], [page([{}]), /invalid/i]]) {
  test(`project inventory distinguishes ${JSON.stringify(response)} from empty`, async () => {
    const { ctx, el } = setup(); ctx.rawApi = ctx.api = async () => response;
    await ctx.loadWorkspace();
    assert.match(el('wsroot').innerHTML, /<h1>Cost/);
    assert.match(el('wsroot').innerHTML, message);
    assert.doesNotMatch(el('wsroot').innerHTML, /data-workspace-state="empty"/);
    assert.equal(ctx.S.workspaceProjects, null);
  });
}
test('raw hosted project inventory paginates, requires exact identity and filters builder domain', async () => {
  const { ctx, calls } = setup('builder'); let n = 0;
  ctx.rawApi = async path => { calls.push({ path }); return n++ === 0 ? { ...page([projects[0]]), cursor: 'next' } : page(projects.slice(1)); };
  const items = await ctx.ensureWorkspaceProjects();
  assert.deepEqual(Array.from(items, p => [p.domain,p.id]), [['domain_a','same'],['domain_a','second']]);
  assert.equal(calls.length, 2);
  assert.match(calls[1].path, /cursor=next/);
});
test('delayed old projects never populate a replaced working context', async () => {
  const { ctx } = setup(); let release;
  ctx.rawApi = ctx.api = () => new Promise(resolve => { release = resolve; });
  const pending = ctx.ensureWorkspaceProjects(); ctx.sessionEpoch++;
  release(page(projects));
  await assert.rejects(pending, error => error === ctx.CANCELED_REQUEST);
  assert.equal(ctx.S.workspaceProjects, null);
});
test('stored assist never invokes input replacement and reasons stay manual', async () => {
  const { ctx } = setup(); let calls = 0;
  ctx.DEMO_ASSIST = { applyDemoAssist: () => calls++ }; ctx.demoAssistEnabled = () => true;
  ctx.demoActionPresets = () => ['preset'];
  ctx.applyDemoAssistToHostedView();
  assert.equal(calls, 0);
  assert.equal(await ctx.requestDemoChoice('reason','Why?'), 'manually entered reason');
  assert.doesNotMatch(source, /id="whoami"|id="tbdemoassist"/);
});
test('Domain Users dispatches to hosted access instead of the absent domain-users route', async () => {
  const { ctx, calls, el } = setup('lead', { dcTab: 'users' }); let loads = 0;
  // The foundation panel is rendered only on the domain Dashboard.
  ctx.document.getElementById = id => id === 'domain-foundation-summary' ? null : el(id);
  ctx.vHostedAccessAdmin = () => '<div id="hostedaccessadmin"></div>';
  ctx.loadHostedAccessAdmin = async () => loads++;
  await ctx.loadDomainConsole();
  assert.equal(loads, 1);
  assert.equal(calls.length, 0);
  assert.match(el('dcbody').innerHTML, /hostedaccessadmin/);
});
test('hosted wizard opens with no legacy API calls and retains the six accepted steps', async () => {
  const { ctx, calls, el } = setup();
  await ctx.wizOpen();
  assert.equal(ctx.S.wiz?.hosted, true);
  assert.deepEqual(calls.map(c => c.path), ['/registry']);
  ctx.renderWizard(el('wizard'));
  for (const title of ['Template','Basics','Blueprint &amp; Harness','Members &amp; Budget','Policy','Review &amp; Create']) assert.ok(el('wizard').innerHTML.includes(title), title);
  assert.match(el('wizard').innerHTML, /id="wnext"/);
});

// A small DOM double for unit-level interaction. Pixel/layout acceptance uses Playwright.
function wizardSetup() {
  const base = setup();
  const fields = new Map();
  const root = { isConnected: true, html: '', querySelector: () => null, querySelectorAll: selector => selector === '[data-wtpl]' ? [fields.get('template')].filter(Boolean) : [],
    get innerHTML() { return this.html; },
    set innerHTML(html) {
      this.html = html; fields.clear();
      for (const match of html.matchAll(/<(input|textarea|button|div)[^>]*\bid="([^"]+)"[^>]*>([^<]*)/g)) {
        fields.set(match[2], { value: match[0].match(/\bvalue="([^"]*)"/)?.[1] || (match[1] === 'textarea' ? match[3] : ''),
          addEventListener(type, handler) { this['on'+type] = handler; }, checked: /\bchecked/.test(match[0]), disabled: /\bdisabled/.test(match[0]), innerHTML: '', textContent: '' });
      }
      if (html.includes('data-wtpl')) fields.set('template', { dataset: { wtpl: 'blank' } });
    },
  };
  base.ctx.document = { getElementById: id => fields.get(id), querySelectorAll: () => [] };
  base.ctx.loadHostedCollection = async () => {};
  base.ctx.loadHostedProjectBudget = async () => {};
  return { ...base, root, fields };
}
test('real hosted wizard Next validates manual data, Back retains it, and Cancel uses the unchanged guard', async () => {
  const { ctx, root, fields, calls, prompts } = wizardSetup();
  await ctx.wizOpen(); ctx.renderWizard(root);
  assert.equal(fields.get('wnext').disabled, true);
  fields.get('template').onclick(); fields.get('wnext').onclick();
  assert.equal(ctx.S.wiz.step, 2);
  fields.get('wnext').onclick(); assert.equal(ctx.S.wiz.step, 2);
  fields.get('wid').value = 'manual-project'; fields.get('wname').value = 'Manual Project';
  fields.get('wdesc').value = 'Business description'; fields.get('wnext').onclick();
  assert.equal(ctx.S.wiz.step, 3);
  fields.get('wback').onclick(); assert.equal(fields.get('wname').value, 'Manual Project');
  fields.get('wnext').onclick(); fields.get('wnext').onclick();
  assert.equal(ctx.S.wiz.step, 4);
  fields.get('wmember').value = 'existing-user'; fields.get('wmemberreason').value = 'Manual assignment reason';
  fields.get('wnext').onclick(); fields.get('wnext').onclick();
  assert.equal(ctx.S.wiz.step, 6);
  assert.match(root.innerHTML, /Manual Project|Manual assignment reason/);
  assert.deepEqual(calls.map(c => c.path), ['/registry'], 'Next and Back never create, deploy or invoke');
  fields.get('wcancel').onclick();
  assert.equal(ctx.S.wiz.step, 6, 'declining the real dirty guard retains draft');
  assert.match(prompts[0], /Discard unsaved changes/);
});
test('project create partial membership failure retries assignment only, with exact scope and stable request ID', async () => {
  const { ctx, root, fields, calls } = wizardSetup();
  await ctx.wizOpen(); calls.length = 0;
  Object.assign(ctx.S.wiz, { step: 6, data: { template: 'blank', id: 'manual', projectName: 'Manual', description: '', username: 'member', reason: 'Business need', reviewBudget: false, resourcePolicy: null } });
  ctx.renderWizard(root);
  let fail = true, requestId = 0; ctx.createRequestId = () => `test-${++requestId}`;
  ctx.api = async (path, body, options) => {
    calls.push({ path, body, options });
    if (path === '/projects') return { ok: true, project: { domainId: 'domain_a', id: 'manual', status: 'ACTIVE' } };
    return fail ? { ok: false, code: 'FORBIDDEN' } : { ok: true, ...body, subject: 'subject', status: 'ACTIVE', changed: true };
  };
  await fields.get('wcreate').onclick();
  assert.match(fields.get('wizstatus').textContent, /Project created; member assignment is incomplete/);
  assert.equal(ctx.S.wiz.created.id, 'manual');
  fail = false; await fields.get('wcreate').onclick();
  assert.deepEqual(calls.map(c => c.path), ['/projects','/access/project-memberships','/access/project-memberships']);
  assert.equal(calls[1].options.requestId, calls[2].options.requestId);
  assert.equal(calls[1].body.domainId, 'domain_a');
  assert.equal(calls[1].body.projectId, 'manual');
  assert.equal(ctx.S.wiz, null);
  assert.match(root.innerHTML, /Project created/);
});
for (const result of [page([projects[0],projects[0]]), { ...page([]), cursor: '' }, { ...page([]), cursor: false }]) test('invalid raw project pagination never becomes an empty workspace', async () => {
  await assert.rejects(scope.loadWorkspaceProjectPages(async () => result), /invalid|duplicate/i);
});
test('one and two authorized projects exclude the same slug in a foreign domain', async () => {
  for (const count of [1,2]) {
    const { ctx } = setup();
    ctx.rawApi = async () => page([...projects.slice(0,count),projects[2]]);
    const result = await ctx.ensureWorkspaceProjects();
    assert.equal(result.length, count);
    assert.ok(result.every(p => p.domain === 'domain_a'));
  }
});
test('access inventory uses raw projects, with same-domain projects and exact membership scope', async () => {
  const { ctx, calls } = setup();
  ctx.S.hostedAccessProjectKey = 'domain_a/same';
  ctx.renderHostedAccessAdmin = () => {};
  ctx.api = async path => {
    calls.push({ path });
    if (path === '/domains') return { ok: true, domains: [{ id:'domain_a' }, { id:'domain_b' }] };
    if (path.startsWith('/access/')) return { ok: true, domainId: 'domain_a', ...(path.includes('/project-') ? { projectId: 'same' } : {}), items: [], cursor: null };
    if (path === '/projects') assert.fail('Must not pass through .projects compatibility adapter');
    return { ok: true, items: [], cursor: null };
  };
  await ctx.loadHostedAccessAdmin();
  assert.equal(ctx.S.hostedAccessProjects.length, 2);
  assert.deepEqual(Array.from(ctx.S.hostedAccessDomains, d => d.id), ['domain_a']);
  assert.ok(calls.some(c => c.path.includes('/access/project-members?domainId=domain_a&projectId=same')));
  assert.equal(ctx.S.hostedAccessDomainMembersError, null);
  assert.equal(ctx.S.hostedAccessProjectMembersError, null);
});
test('membership page supports its actual cursor alphabet, rejects scope mismatch, and ignores late old selection', async () => {
  const { ctx } = setup();
  ctx.S.hostedAccessDomains = [{ id:'domain_a' }]; ctx.S.hostedAccessProjects = projects;
  ctx.S.hostedAccessProjectKey = 'domain_a/same'; ctx.renderHostedAccessAdmin = () => {};
  ctx.api = async () => ({ ok:true, domainId:'domain_a', items:[], cursor:'opaque+/=' });
  assert.equal((await ctx.loadHostedMemberPage('/access/domain-members',{domainId:'domain_a'})).cursor, 'opaque+/=');
  await assert.rejects(ctx.loadHostedMemberPage('/access/domain-members',{domainId:'domain_b'}), /invalid/);
  const releases = [];
  ctx.api = path => new Promise(resolve => releases.push(() => resolve({ok:true,domainId:'domain_a',...(path.includes('/project-')?{projectId:'same'}:{}),items:[],cursor:null})));
  const pending = ctx.loadHostedMemberships(); ctx.S.hostedAccessProjectKey = 'domain_a/second';
  releases.forEach(release => release()); await pending;
  assert.deepEqual(Array.from(ctx.S.hostedAccessProjectMembers), []);
});
test('membership load-more appends only valid next pages and preserves exact scope', async () => {
  const { ctx, calls } = setup();
  ctx.S.hostedAccessDomains = [{ id:'domain_a' }]; ctx.S.hostedAccessProjects = projects;
  ctx.S.hostedAccessProjectKey = 'domain_a/same'; ctx.renderHostedAccessAdmin = () => {};
  const member = name => ({ username:name,subject:name,userStatus:'CONFIRMED',enabled:true });
  ctx.api = async path => {
    calls.push({path});
    if(path.includes('/project-')) return {ok:true,domainId:'domain_a',projectId:'same',items:[],cursor:null};
    return {ok:true,domainId:'domain_a',items:[member(path.includes('cursor=')?'second':'first')],cursor:path.includes('cursor=')?null:'next+/='};
  };
  await ctx.loadHostedMemberships(); await ctx.loadHostedMemberships({more:'domain'});
  assert.deepEqual(Array.from(ctx.S.hostedAccessDomainMembers, m => m.username), ['first','second']);
  assert.equal(ctx.S.hostedAccessDomainMembersCursor,null);
  assert.match(calls.at(-1).path,/cursor=next%2B%2F%3D/);
});

test('latest project inventory wins even when two reads share the same context epoch', async () => {
  const { ctx } = setup(); let release, reads = 0;
  ctx.rawApi = async () => ++reads === 1 ? new Promise(resolve => { release = resolve; }) : page([projects[1]]);
  const old = ctx.ensureWorkspaceProjects();
  const latest = await ctx.ensureWorkspaceProjects();
  assert.equal(latest[0].id, 'second');
  release(page([projects[0]]));
  await assert.rejects(old, error => error === ctx.CANCELED_REQUEST);
  assert.equal(ctx.S.workspaceProjects[0].id, 'second');
});

test('archived projects remain in the domain list but cannot become the active workspace', async () => {
  const { ctx } = setup(); ctx.rawApi = async () => page([{...projects[0],status:'ARCHIVED'}]);
  assert.equal((await ctx.readWorkspaceProjects())[0].status,'ARCHIVED');
  assert.equal((await ctx.ensureWorkspaceProjects()).length,0);
});

test('project management defaults to active and exposes archived records only by explicit filter', async () => {
  const {ctx,el}=setup();
  const inventory=[...projects.filter(p=>p.domainId==='domain_a'),{id:'old',domainId:'domain_a',name:'Old',status:'ARCHIVED'}];
  ctx.readWorkspaceProjects=async()=>inventory;
  ctx.HOSTED_COLLECTION_META={projects:{title:'Projects'}};
  ctx.hostedCollectionItems=(_resource,items)=>items.map(p=>p.id).join(',');
  ctx.wireHostedProjectCreate=()=>{};
  vm.runInContext(fn('loadHostedCollection'),ctx);
  await ctx.loadHostedCollection('projects');
  assert.equal(el('hostedcollection').innerHTML,'same,second');
  assert.match(el('project-list-count').textContent,/2 active · 1 archived/);
  el('project-status-filter').value='ARCHIVED';
  await el('project-status-filter').onchange();
  assert.equal(el('hostedcollection').innerHTML,'old');
  el('project-status-filter').value='ALL';
  await el('project-status-filter').onchange();
  assert.equal(el('hostedcollection').innerHTML,'same,second,old');
});
