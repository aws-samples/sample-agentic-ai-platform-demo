// OFFLINE actual-app VM execution, synthetic TEST API. No browser/live proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness, approval, deferred } from './test-support/model-approval-harness.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
function unchanged(h, before) {
  assert.deepEqual(plain(h.store.rows), before.rows);
  assert.deepEqual(plain(h.ctx.S.hostedGatewayCatalog), before.catalog);
}
const snapshot = h => ({ rows: plain(h.store.rows), catalog: plain(h.ctx.S.hostedGatewayCatalog) });
for (const surface of ['queue', 'drawer']) {
  for (const decision of ['APPROVE', 'REJECT']) test(`${surface} ${decision}: exact MODEL body and real x-request-id transport`, async () => {
    const h = appHarness({ surface, decision });
    await h.button.onclick();
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].path, '/api/ai-gateway/model-access-decisions');
    assert.deepEqual(h.writes[0].body, { approvalId: h.row.id, decision,
      reason: 'QA rejection' });
    assert.match(h.writes[0].headers['x-request-id'], /^[0-9a-f-]{36}$/);
    assert.equal(h.writes[0].headers['x-active-domain'], 'operations');
    assert.ok(h.reads.some(read => read.path === '/api/ai-gateway'));
    assert.ok(h.reads.some(read => read.path.startsWith('/api/approvals?')));
  });
  for (const change of ['session', 'domain', 'actor', 'role', 'capability', 'disconnect', 'model-selection']) test(`${surface}: ${change} during read blocks mutation`, async () => {
    const h = appHarness({ surface });
    const before = snapshot(h), gate = deferred(), entered = deferred();
    h.store.hook = async (path, options) => { if (options.method === 'GET') { entered.resolve(); await gate.promise; } };
    const pending = h.button.onclick(); await entered.promise;
    if (change === 'session') h.ctx.sessionEpoch++;
    if (change === 'domain') h.ctx.domain = 'foreign';
    if (change === 'actor') h.ctx.SESSION.actor = 'other-reviewer';
    if (change === 'role') h.ctx.SESSION.role = 'admin';
    if (change === 'capability') h.ctx.caps = ['approveAccessRequests'];
    if (change === 'disconnect') h.button.isConnected = false;
    if (change === 'model-selection') {
      if (surface === 'drawer') h.ctx.S.hostedGatewaySelectedModelId = 'other-model';
      else h.button.dataset.resource = 'other-model';
    }
    gate.resolve(); await pending;
    assert.equal(h.writes.length, 0); unchanged(h, before);
  });
  for (const status of ['APPROVED', 'REJECTED', 'CANCELLED', '', 'FUTURE']) test(`${surface}: current ${status || 'missing'} status is read-only`, async () => {
    const h = appHarness({ surface }); h.store.rows[0].status = status;
    await h.button.onclick(); assert.equal(h.writes.length, 0);
  });
  for (const failure of ['missing', 'duplicate', 'changed-model', 'changed-kind', 'changed-domain', 'changed-date', 'own', 'no-requester', 'no-permission', 'generic-permission', 'no-actor']) test(`${surface}: ${failure} fails closed`, async () => {
    const h = appHarness({ surface });
    if (failure === 'missing') h.store.rows = [];
    if (failure === 'duplicate') h.store.rows.push({ ...h.row });
    if (failure === 'changed-model') h.store.rows[0].resourceId = 'bedrock/other';
    if (failure === 'changed-kind') h.store.rows[0].kind = 'RESOURCE_PUBLICATION';
    if (failure === 'changed-domain') h.store.rows[0].domainId = 'foreign';
    if (failure === 'changed-date') h.store.rows[0].requestedAt = '2026-09-02T00:00:00.000Z';
    if (failure === 'own') h.store.rows[0].requesterSubject = 'reviewer';
    if (failure === 'no-requester') delete h.store.rows[0].requesterSubject;
    if (failure === 'no-permission') h.ctx.caps = [];
    if (failure === 'generic-permission') h.ctx.caps = ['decideAccessRequests'];
    if (failure === 'no-actor') h.ctx.SESSION.actor = '';
    await h.button.onclick(); assert.equal(h.writes.length, 0);
  });
  for (const failure of ['missing-id', 'malformed-id', 'absent-model', 'wrong-domain', 'no-requestable-policy', 'no-limits', 'no-active-reconciliation', 'different-request', 'malformed-catalog', 'catalog-error', 'catalog-throw', 'record-error', 'record-throw']) test(`${surface}: ${failure} cannot infer model policy identity`, async () => {
    const h = appHarness({ surface });
    if (failure === 'missing-id') delete h.store.catalog.models[0].id;
    if (failure === 'malformed-id') h.store.catalog.models[0].id = ' bad model ';
    if (failure === 'absent-model') h.store.catalog.models[0].id = 'bedrock/other';
    if (failure === 'wrong-domain') h.store.catalog.domainId = 'foreign';
    if (failure === 'no-requestable-policy') h.store.catalog.models[0].access.requestable = false;
    if (failure === 'no-limits') h.store.catalog.models[0].access.limits = null;
    if (failure === 'no-active-reconciliation') h.store.catalog.models[0].access.rateLimit = null;
    if (failure === 'different-request') h.store.catalog.models[0].access.latestRequest.id = 'other-request';
    if (failure === 'malformed-catalog') h.store.catalog = { ok: true, models: [] };
    if (failure === 'catalog-error') h.store.catalog = { ok: false };
    if (failure === 'catalog-throw') h.store.catalog = Error('TEST catalog outage');
    if (failure === 'record-error') h.store.approvalsResponse = { ok: false, resource: 'approvals' };
    if (failure === 'record-throw') h.store.approvalsResponse = Error('TEST approvals outage');
    await h.button.onclick(); assert.equal(h.writes.length, 0);
  });
  for (const failure of [{ ok: false, message: 'TEST conflict' }, Error('TEST network outage')]) test(`${surface}: decision ${failure instanceof Error ? 'throws' : 'non-ok'} preserves state and permits retry`, async () => {
    const h = appHarness({ surface }); const before = snapshot(h), state = plain(h.ctx.S); h.store.post = failure;
    await h.button.onclick();
    assert.equal(h.writes.length, 1); unchanged(h, before);
    assert.equal(h.effects.includes('clear'), false); assert.equal(h.effects.includes('reload'), false);
    assert.equal(h.effects.includes('render'), false, 'failed decisions retain the entered reason and existing controls');
    assert.deepEqual(plain(h.ctx.S), state);
    assert.equal(h.reason.value, 'QA rejection');
    assert.equal(h.button.disabled, false);
    h.store.post = { ok: true }; await h.button.onclick();
    assert.equal(h.writes.length, 2); assert.ok(h.effects.includes('reload'));
  });
  test(`${surface}: late successful response cannot alter a replacement session`, async () => {
    const h = appHarness({ surface }), gate = deferred(), entered = deferred();
    h.store.hook = async (path, options) => { if (options.method === 'POST') { entered.resolve(); await gate.promise; } };
    const pending = h.button.onclick(); await entered.promise; h.ctx.sessionEpoch++;
    h.ctx.S = { marker: 'new-session' }; gate.resolve(); await pending;
    assert.deepEqual(plain(h.ctx.S), { marker: 'new-session' }); assert.deepEqual(h.effects, []);
  });
}
for (const change of ['domain', 'capability', 'actor', 'own-record', 'status']) test(`queue: ${change} during rejection prompt blocks mutation`, async () => {
  const h = appHarness({ decision: 'REJECT' }), gate = deferred();
  h.ctx.requestDemoChoice = () => gate.promise;
  const pending = h.button.onclick();
  if (change === 'domain') h.ctx.domain = 'foreign';
  if (change === 'capability') h.ctx.caps = [];
  if (change === 'actor') h.ctx.SESSION.actor = 'other-reviewer';
  if (change === 'own-record') h.store.rows[0].requesterSubject = 'reviewer';
  if (change === 'status') h.store.rows[0].status = 'APPROVED';
  gate.resolve('QA rejection'); await pending; assert.equal(h.writes.length, 0);
});
for (const type of ['AGENT', 'TOOL', 'MCP_SERVER', 'SKILL', 'BLUEPRINT']) test(`queue native ${type} exact access route/body/header`, async () => {
  const h = appHarness({ row: approval({ resourceType: type, resourceId: 'SyntheticReg1/SyntheticRec' }) });
  await h.button.onclick(); assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, '/api/governance/access-decisions');
  assert.deepEqual(h.writes[0].body, { approvalId: h.row.id, decision: 'APPROVE', reason: 'QA rejection' });
  assert.match(h.writes[0].headers['x-request-id'], /^[0-9a-f-]{36}$/);
  assert.equal(h.reads.some(read => read.path === '/api/ai-gateway'), false);
});
for (const type of ['SKILL', 'BLUEPRINT', 'AGENT', 'DEPLOYMENT']) test(`queue ${type} canonical publication/deployment body and header`, async () => {
  const deployment = type === 'DEPLOYMENT';
  const h = appHarness({ row: approval({ kind: deployment ? 'PRODUCTION_DEPLOYMENT' : 'RESOURCE_PUBLICATION', resourceType: type,
    resourceId: deployment ? 'deploy-one' : 'SyntheticReg1/SyntheticRec', projectId: deployment ? 'project-one' : null }) });
  h.ctx.caps = [deployment ? 'approveDomainDeployment' : 'approveDomainPublication'];
  await h.button.onclick(); assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, deployment ? '/api/deployment-decisions' : '/api/governance/publication-decisions');
  assert.deepEqual(h.writes[0].body, { ...(deployment ? { domainId: 'operations', projectId: 'project-one', deploymentId: 'deploy-one' } : {}),
    approvalId: h.row.id, decision: 'APPROVE', reason: 'QA rejection' });
  assert.match(h.writes[0].headers['x-request-id'], /^[0-9a-f-]{36}$/);
});
test('queue renderer hides unsupported types and own requester without dropping the row', () => {
  const h = appHarness();
  for (const patch of [{ resourceType: 'FUTURE' }, { resourceType: '' }, { resourceType: undefined }, { requesterSubject: 'reviewer' }]) {
    const html = h.ctx.hostedCollectionItems('approvals', [approval(patch)], { approvalActions: true });
    assert.match(html, /qa-model-access/); assert.doesNotMatch(html, /class="ghost hostedapproval"/);
  }
});
test('drawer requires explicit exact selected model identity, with no first-model fallback', async () => {
  for (const id of ['', undefined, 'missing', ' bad ']) {
    const h = appHarness({ surface: 'drawer' }); h.ctx.S.hostedGatewaySelectedModelId = id; h.bind();
    await h.button.onclick(); assert.equal(h.writes.length, 0);
  }
});
test('queue changed requester and mutable DOM metadata cannot redirect an action', async () => {
  for (const mutate of [h => { h.store.rows[0].requesterSubject = 'another-requester'; }, h => { h.button.dataset.approval = 'other-request'; }]) {
    const h = appHarness(); mutate(h); await h.button.onclick(); assert.equal(h.writes.length, 0);
  }
});
test('queue rejects empty reason input without writes', async () => {
  for (const value of [null, '', '   ']) {
    const h = appHarness({ decision: 'REJECT' }); h.reason.value = value;
    await h.button.onclick(); assert.equal(h.writes.length, 0);
  }
});
test('both actual queue loaders pass real records to action binding', async () => {
  for (const loader of ['loadHostedCollection', 'loadGovQueue']) {
    const h = appHarness();
    Object.assign(h.ctx, { hasCap: () => false, usableDomainId: () => true, runSessionTask: () => {}, loadGovMemBacklog: () => {} });
    await h.ctx[loader]('approvals'); await h.button.onclick();
    assert.equal(h.writes.length, 1, loader); assert.equal(h.writes[0].path, '/api/ai-gateway/model-access-decisions');
  }
});
for (const surface of ['queue', 'drawer']) {
  for (const change of ['domain', 'capability', 'actor']) test(`${surface}: ${change} during catalog read is rechecked immediately before writing`, async () => {
    const h = appHarness({ surface }), gate = deferred(), entered = deferred();
    h.store.hook = async path => { if (path === '/api/ai-gateway') { entered.resolve(); await gate.promise; } };
    const pending = h.button.onclick(); await entered.promise;
    if (change === 'domain') h.ctx.domain = 'foreign';
    if (change === 'capability') h.ctx.caps = [];
    if (change === 'actor') h.ctx.SESSION.actor = 'other-reviewer';
    gate.resolve(); await pending; assert.equal(h.writes.length, 0);
  });
  test(`${surface}: malformed current model record cannot borrow catalog identity`, async () => {
    for (const patch of [{ resourceId: '' }, { resourceId: 'bad id' }, { resourceId: undefined }, { projectId: 'not-null' }, { resourceType: 'FUTURE' }]) {
      const h = appHarness({ surface }); Object.assign(h.store.rows[0], patch);
      await h.button.onclick(); assert.equal(h.writes.length, 0);
    }
  });
  test(`${surface}: read outage preserves state and controls for retry`, async () => {
    const h = appHarness({ surface }), state = plain(h.ctx.S);
    h.store.approvalsResponse = Error('TEST read outage'); await h.button.onclick();
    assert.equal(h.writes.length, 0); assert.equal(h.button.disabled, surface === 'queue');
    assert.deepEqual(plain(h.ctx.S), state);
    if(surface === 'queue') { assert.equal(h.button.onclick, null); return; }
    delete h.store.approvalsResponse; await h.button.onclick(); assert.equal(h.writes.length, 1);
  });
  test(`${surface}: generic approval affordance cannot replace canonical MODEL capability`, async () => {
    const h = appHarness({ surface }); h.ctx.hostedApprovalActionEnabled = () => true; h.ctx.caps = ['approveDomainPublication'];
    await h.button.onclick(); assert.equal(h.writes.length, 0);
  });
}
test('actual drawer renderer emits exact model metadata only for eligible domain capability', () => {
  const h = appHarness({ surface: 'drawer' }), model = h.ctx.S.hostedGatewayCatalog.models[0];
  const html = h.ctx.hostedGatewayAccessActions(model, model.access);
  assert.equal((html.match(/data-model="bedrock\/model-alias"/g) || []).length, 2);
  h.ctx.caps = []; assert.doesNotMatch(h.ctx.hostedGatewayAccessActions(model, model.access), /hostedgatewaydecision/);
});
for (const type of ['Skill', 'Blueprint']) test(`actual native ${type} queue retains guarded /registry-decide route, body and header`, async () => {
  const h = appHarness();
  const entry = { id: 'native-resource', name: 'Synthetic native resource', type, domain: 'platform',
    _source: 'agentcore-registry', _registryId: 'SyntheticReg1', versions: [{ semver: '1.0.0', status: 'IN_REVIEW',
      _aws: { registryId: 'SyntheticReg1', recordId: 'SyntheticRec', awsStatus: 'PENDING_APPROVAL' } }] };
  h.store.registry = { ok: true, source: 'aws', entries: [entry] }; h.store.rows = [];
  h.button.dataset = { id: entry.id, semver: '1.0.0', d: 'approve' };
  h.box.querySelectorAll = selector => selector === '.qreg' ? [h.button] : [];
  Object.assign(h.ctx, { hasCap: () => true, REG_TYPE_ICON: {}, ICONS: {}, ic2: () => '', regStatusBadge: () => '',
    runSessionTask: () => h.effects.push('reload'), loadGovMemBacklog: () => {} });
  await h.ctx.loadGovQueue(); await h.button.onclick();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].path, '/api/registry-decide');
  assert.deepEqual(h.writes[0].body, { id: entry.id, semver: '1.0.0', decision: 'approve', reason: '', registryId: 'SyntheticReg1', recordId: 'SyntheticRec' });
  assert.match(h.writes[0].headers['x-request-id'], /^[0-9a-f-]{36}$/);
  assert.equal(entry.versions[0].status, 'IN_REVIEW');
});
test('MODEL publication, unknown kind and malformed deployment remain unsupported', async () => {
  for (const patch of [{ kind: 'RESOURCE_PUBLICATION' }, { kind: 'FUTURE_KIND' },
    { kind: 'PRODUCTION_DEPLOYMENT', resourceType: 'DEPLOYMENT', projectId: null }]) {
    const h = appHarness({ row: approval(patch) });
    h.ctx.caps = ['approveDomainPublication', 'approveDomainDeployment'];
    await h.button.onclick(); assert.equal(h.writes.length, 0);
  }
});

// Execute the real queue handler across fresh VM contexts sharing only browser
// storage, modelling a full page reload. API I/O stays synthetic in this suite.
test('actual queue reload reads current state before reusing the exact pending request',async()=>{
 const {createApprovalDecisionRetries}=await import('./public/approval-decision-retries.mjs');
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const row=approval({kind:'RESOURCE_PUBLICATION',resourceType:'MCP_SERVER',resourceId:'SyntheticReg1/SyntheticRec',recordVersion:'1.0.0-platform-descriptor.1'});
 const setup=()=>{const h=appHarness({row});h.ctx.caps=['approveDomainPublication'];h.ctx.pendingHostedApprovalDecisions=createApprovalDecisionRetries(storage);return h;};
 const first=setup();first.store.post=Error('Synthetic unknown response');await first.button.onclick();assert.equal(first.writes.length,1);const requestId=first.writes[0].headers['x-request-id'];
 const reload=setup();assert.equal(reload.writes.length,0,'reload never auto-writes');await reload.button.onclick();assert.ok(reload.reads.some(r=>r.path.startsWith('/api/approvals?')));assert.equal(reload.writes[0].headers['x-request-id'],requestId);assert.equal(values.size,0,'confirmed success retires metadata');
 const uncertain=setup();uncertain.store.post=Error('Synthetic timeout');await uncertain.button.onclick();const old=uncertain.writes[0].headers['x-request-id'];
 const changed=appHarness({row:{...row,recordVersion:'2.0.0-platform-descriptor.1'}});changed.ctx.caps=['approveDomainPublication'];changed.ctx.pendingHostedApprovalDecisions=createApprovalDecisionRetries(storage);await changed.button.onclick();assert.equal(changed.writes.length,0,'changed version cannot reuse old request');
 const other=setup();other.ctx.SESSION.actor='another-independent-reviewer';other.bind();await other.button.onclick();assert.notEqual(other.writes[0].headers['x-request-id'],old,'different actor cannot borrow request identity');
 const terminal=setup();terminal.store.rows[0].status='APPROVED';await terminal.button.onclick();assert.equal(terminal.writes.length,0,'terminal read never resubmits');
});
