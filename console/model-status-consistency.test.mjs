import test from 'node:test';
import assert from 'node:assert/strict';
import { statusHarness, deferred, domainCatalog, inventory, adminCatalog, stamp } from './test-support/model-status-harness.mjs';

import { registryModelStatus } from './public/registry-model-status.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
test('actual Registry list and selected projection version: 47 discovered, one allowed, no native approval', async () => {
  const h = await statusHarness(), before = plain(h.store.registry);
  await h.ctx.loadRegistry();
  assert.equal(h.ctx.S.registryEntries.length, 47);
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length, 47);
  assert.match(h.roots.regbox.innerHTML, /47 entries  of 47 total/);
  assert.doesNotMatch(h.roots.regbox.innerHTML, /allowed|available for domain/);

  assert.doesNotMatch(h.roots.regbox.innerHTML, /Pending review|class="badge [^"]*"[^>]*>Approved<|>gateway<\/span><\/td>/);
  for (const row of [0,1]) {
    h.roots.regbox.querySelectorAll('.regrow')[row].onclick();
    assert.match(h.roots.regdrawerwrap.innerHTML, /<h3 id="modelaccess">Access/);
    assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /Pending review|>Approved<|regapprove|regreject|decided by gateway/);
    assert.equal(h.roots.regdrawerwrap.querySelectorAll('[data-regversion]').length, 0, 'Gateway wrapper is not model version history');
    assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /Authoritative status:|Pending review|>Approved</);
  }
  assert.deepEqual(plain(h.store.registry), before);
});
test('absent scoped model access stays discoverable and unverified, not denied or pending', async () => {
  const h = await statusHarness(); h.store.catalog.models = [];
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regbox.innerHTML, /47 entries  of 47 total/);
  assert.match(h.roots.regdrawerwrap.innerHTML, /Access information is not available|Current platform policy/);
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /Pending review|>DENIED<|not visible to this domain|policy: default/);
});
test('late old-domain Registry read cannot overwrite replacement domain', async () => {
  const h = await statusHarness(), gate = deferred(), entered = deferred();
  h.store.hook = async path => { if (path === '/api/ai-gateway') { entered.resolve(); await gate.promise; } };
  const old = h.ctx.loadRegistry();
  // Base does not read /ai-gateway; release on a registry read as well for red execution.
  await Promise.race([entered.promise, old]);
  h.ctx.domain = 'research'; h.store.catalog = domainCatalog('test-gateway/model-1','research');
  h.store.hook = async () => {}; await h.ctx.loadRegistry();
  gate.resolve(); await old;
  assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[0]).access, null);
  assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[1]).access.status, 'ALLOWED');
});

for (const failure of ['403','500','malformed','missing-access','duplicate-model','wrong-domain','admin-metadata','throw']) test(`actual Registry preserves inventory when access is ${failure}`, async () => {
  const h = await statusHarness();
  if (failure === '403') { h.store.catalog = { ok: false, code: 'FORBIDDEN' }; h.store.httpStatus = 403; }
  if (failure === '500') { h.store.catalog = { ok: false, code: 'MODEL_GOVERNANCE_UNAVAILABLE' }; h.store.httpStatus = 500; }
  if (failure === 'malformed') h.store.catalog = '<html>TEST failure</html>';
  if (failure === 'missing-access') delete h.store.catalog.models[0].access;
  if (failure === 'duplicate-model') h.store.catalog.models.push(structuredClone(h.store.catalog.models[0]));
  if (failure === 'wrong-domain') h.store.catalog.domainId = 'research';
  if (failure === 'admin-metadata') h.store.catalog = { ok: true, source: 'aws', models: [{ ...inventory(1)[0], policy: { allowedDomains: ['operations'] } }] };
  if (failure === 'throw') h.store.catalog = Error('TEST endpoint unavailable');
  await h.ctx.loadRegistry();
  assert.equal(h.ctx.S.registryEntries.length, 47);
  // AUD-003 follow-up: a failed/unavailable AI Gateway read must say
  // unknown, not a fabricated "0 allowed · 0 available for domain".
  assert.match(h.roots.regbox.innerHTML, /47 entries  of 47 total/);
  h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regdrawerwrap.innerHTML, /Could not load access/);
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /Pending review|>DENIED<|regapprove|policy: default/);
});
for (const status of ['ALLOWED','GRANTED','REQUESTABLE','PENDING','REJECTED']) test(`actual scoped ${status} remains separate from inventory/native approval`, async () => {
  const h = await statusHarness(), a = h.store.catalog.models[0].access;
  Object.assign(a, { status, usable: ['ALLOWED','GRANTED'].includes(status), requestable: !['ALLOWED','GRANTED'].includes(status) });
  if (status === 'GRANTED') a.grant = { status: 'ACTIVE', grantedAt: '2026-09-01T00:00:00.000Z' };
  if (['PENDING','REJECTED'].includes(status)) a.latestRequest = { id: 'test-current-request', status, requestedAt: '2026-09-01T00:00:00.000Z' };
  assert.equal(h.ctx.validHostedGatewayCatalog(h.store.catalog), true);
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  const view = h.ctx.registryModelView(h.ctx.S.registryEntries[0]);
  assert.equal(view.inventory, 'DISCOVERED'); assert.equal(view.access.status, status);
  assert.equal(view.available, a.usable); assert.equal(view.pending, status === 'PENDING');
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /Pending review|regapprove|regreject/);
  assert.equal(h.roots.regdrawerwrap.innerHTML.includes('Latest access request: PENDING'), status === 'PENDING');
  if (status === 'REQUESTABLE') assert.match(h.roots.regdrawerwrap.innerHTML, /Requestable: Yes/);
});
for (const malformed of ['pending-without-request','requestable-pending','allowed-not-usable','bad-request-time']) test(`inconsistent public contract ${malformed} becomes unverified`, async () => {
  const h = await statusHarness(), a = h.store.catalog.models[0].access;
  if (malformed === 'pending-without-request') Object.assign(a,{ status: 'PENDING', usable: false, requestable: true });
  if (malformed === 'requestable-pending') Object.assign(a,{ status: 'REQUESTABLE', usable: false, requestable: true, latestRequest: { id: 'test-request', status: 'PENDING', requestedAt: '2026-09-01T00:00:00.000Z' } });
  if (malformed === 'allowed-not-usable') a.usable = false;
  if (malformed === 'bad-request-time') a.latestRequest = { id: 'test-request', status: 'PENDING', requestedAt: 'bad' };
  await h.ctx.loadRegistry(); assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[0]).access, null);
});
test('actual limits retain null dimensions and failed reconciliation without fabricated zero limits', async () => {
  const h = await statusHarness(), a = h.store.catalog.models[0].access;
  a.rateLimit = { status: 'RECONCILIATION_FAILED', reason: 'TEST capacity unavailable', reconciledAt: '2026-09-01T00:00:00.000Z' };
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regdrawerwrap.innerHTML, /Limits could not be applied/);
  assert.match(h.roots.regdrawerwrap.innerHTML, /<b>60<\/b><div class="d">Requests \/ minute/);
  assert.match(h.roots.regdrawerwrap.innerHTML, /<b>Not configured<\/b><div class="d">Tokens \/ minute/);
  assert.match(h.roots.regdrawerwrap.innerHTML, /<b>Not configured<\/b><div class="d">Connections \/ second/);
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /USABLE|Verified/);
  a.limits = null; a.rateLimit = null; await h.ctx.loadRegistry();
  assert.match(h.roots.regdrawerwrap.innerHTML, /No model-specific limits are configured/);
});
for (const mismatch of ['gateway-id','runtime-only-catalog','display-name','case','duplicate-inventory','missing-alias','resolved-mismatch']) test(`exact alias contract: ${mismatch} never borrows entitlement`, async () => {
  const h = await statusHarness(), e = h.store.registry.entries[0];
  if (mismatch === 'gateway-id') e.versions[0].content.gatewayModelId = 'different-model';
  if (mismatch === 'runtime-only-catalog') h.store.catalog.models[0].id = e.versions[0].content.runtimeModelId;
  if (mismatch === 'display-name') { h.store.catalog.models[0].id = 'other-model'; h.store.catalog.models[0].name = e.name; }
  if (mismatch === 'case') h.store.catalog.models[0].id = e.id.toUpperCase();
  if (mismatch === 'duplicate-inventory') h.store.registry.entries.push(structuredClone(e));
  if (mismatch === 'missing-alias') delete e.versions[0].content.runtimeModelId;
  if (mismatch === 'resolved-mismatch') e.resolved = { ...e.versions[0], content: { ...e.versions[0].content, gatewayModelId: 'other-model' } };
  await h.ctx.loadRegistry();
  assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[0]).access, null);
});
test('different runtime aliases are displayed exactly; shared runtime aliases do not redirect exact Gateway identities', async () => {
  const h = await statusHarness();
  h.store.registry.entries[1].versions[0].content.runtimeModelId = h.store.registry.entries[0].versions[0].content.runtimeModelId;
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regdrawerwrap.innerHTML, /test-gateway\/model-0/);
  assert.match(h.roots.regdrawerwrap.innerHTML, /test-runtime.model-0/);
  assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[1]).access, null);
});
for (const role of ['admin','lead','builder','user']) test(`${role}: native lifecycle/capability and projection read-only controls preserved`, async () => {
  const h = await statusHarness(); h.ctx.SESSION.role = role; h.ctx.hasCap = () => role === 'admin';
  const native = { id: 'test-native', name: 'TEST native Skill', type: 'Skill', domain: 'platform', governanceMode: 'owned',
    _source: 'agentcore-registry', _registryId: 'SyntheticReg1', defaultVersion: '1.0.0', versions: [
      { semver: '1.0.0', status: 'IN_REVIEW', _aws: { registryId: 'SyntheticReg1', recordId: 'SyntheticRec', awsStatus: 'PENDING_APPROVAL' } },
      { semver: '0.9.0', status: 'APPROVED', decidedBy: 'test-native-reviewer', decidedAt: '2026-09-01T00:00:00.000Z' },
    ] };
  h.store.registry.entries.push(native); const before = plain(native);
  await h.ctx.loadRegistry();
  h.ctx.S.registryDrawerId = native.id; h.ctx.renderRegistryDrawer();
  assert.match(h.roots.regdrawerwrap.innerHTML, /Pending review/);
  assert.equal(h.roots.regdrawerwrap.querySelectorAll('.regapprove').length, role === 'admin' ? 1 : 0);
  assert.deepEqual(plain(h.ctx.S.registryEntries.at(-1)), before);
  h.ctx.S.registryDrawerId = h.ctx.S.registryEntries[0].id; h.ctx.renderRegistryDrawer();
  assert.equal(h.roots.regdrawerwrap.querySelectorAll('.regapprove,.regreject').length, 0);
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /hostedgatewaydecision/);
  assert.ok(h.find('registrygatewayopen'));
});
test('Model chip uses the same live catalog without mutating inventory', async () => {
  const h = await statusHarness(), before = plain(h.store.registry);
  h.ctx.S.registryFilterType='Model';
  await h.ctx.loadRegistry();
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length, 47);
  assert.match(h.roots.regbox.innerHTML, /Models \(47\)/);
  assert.ok(h.reads.some(read=>read.path.startsWith('/api/registry')), 'Model view reads the same registered inventory');
  h.ctx.S.registryFilterType='All';
  await h.ctx.loadRegistry();
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length, 47);
  assert.deepEqual(plain(h.store.registry), before);
  assert.equal(h.writes.length, 0);
});
for (const loader of ['loadRegistry','loadHostedGateway']) for (const change of ['domain','actor','role','epoch','headers','capabilities','route','dom','generation']) test(`${loader}: ${change} during read discards delayed response`, async () => {
  const h = await statusHarness(), gate = deferred(), entered = deferred();
  h.store.hook = async path => { if (path === '/api/ai-gateway') { entered.resolve(); await gate.promise; } };
  const pending = h.ctx[loader](); await entered.promise;
  if (change === 'domain') h.ctx.domain = 'research';
  if (change === 'actor') h.ctx.SESSION.actor = 'test-other';
  if (change === 'role') h.ctx.SESSION.role = 'builder';
  if (change === 'epoch') h.ctx.sessionEpoch++;
  if (change === 'headers') h.ctx.demoContextHeaders = () => ({ 'x-active-domain': 'research', 'x-demo-role': 'builder' });
  if (change === 'capabilities') h.ctx.caps = [];
  if (change === 'route') h.ctx.S.view = 'other';
  if (change === 'dom') h.roots[loader === 'loadRegistry' ? 'regbox' : 'hostedgateway'].isConnected = false;
  if (change === 'generation') { h.store.hook = async () => {}; h.store.catalog = domainCatalog('test-gateway/model-1'); await h.ctx[loader](); }
  const state = plain(h.ctx.S), html = h.roots.regbox.innerHTML, effects = [...h.effects];
  gate.resolve(); await pending;
  assert.deepEqual(plain(h.ctx.S), state); assert.equal(h.roots.regbox.innerHTML, html); assert.deepEqual(h.effects, effects);
});
test('old domain access clears immediately before replacement read and in drawer during loading', async () => {
  const h = await statusHarness(); await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regdrawerwrap.innerHTML, /Access: ALLOWED/);
  h.ctx.domain = 'research'; const gate = deferred(), entered = deferred();
  h.store.hook = async path => { if (path === '/api/ai-gateway') { entered.resolve(); await gate.promise; } };
  const pending = h.ctx.loadRegistry(); await entered.promise;
  assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[0]).access, null);
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /Access: ALLOWED/);
  assert.match(h.roots.regdrawerwrap.innerHTML, /Loading access/);
  gate.resolve(); await pending;
});
for (const change of ['domain','actor','role','epoch','headers','capabilities']) test(`Registry cache invalidates narrowly for ${change} and rejects old pending read`, async () => {
  const h = await statusHarness(); await h.ctx.readHostedRegistry(); await h.ctx.readHostedRegistry();
  assert.equal(h.reads.filter(x => x.path === '/api/registry').length, 1);
  h.ctx.clearHostedRegistryReadCache(); const gate = deferred(), entered = deferred();
  h.store.hook = async path => { if (path === '/api/registry') { entered.resolve(); await gate.promise; } };
  const pending = h.ctx.readHostedRegistry().catch(error => error); await entered.promise;
  if (change === 'domain') h.ctx.domain = 'research';
  if (change === 'actor') h.ctx.SESSION.actor = 'test-other';
  if (change === 'role') h.ctx.SESSION.role = 'builder';
  if (change === 'epoch') h.ctx.sessionEpoch++;
  if (change === 'headers') h.ctx.demoContextHeaders = () => ({ 'x-active-domain': 'research' });
  if (change === 'capabilities') h.ctx.caps = [];
  h.store.hook = async () => {}; await h.ctx.readHostedRegistry(); gate.resolve();
  assert.equal(await pending, h.ctx.CANCELED_REQUEST);
  await h.ctx.readHostedRegistry(); assert.equal(h.reads.filter(x => x.path === '/api/registry').length, 3);
});

for (const status of ['ALLOWED','DENIED','REQUESTABLE']) test(`admin exact accessByDomain ${status} is authoritative only for selected domain`, async () => {
  const h = await statusHarness(); h.ctx.SESSION.role = 'admin'; h.store.catalog = adminCatalog('operations', status);
  assert.equal(h.ctx.validHostedGatewayCatalog(h.store.catalog), true);
  await h.ctx.loadRegistry(); const view = h.ctx.registryModelView(h.ctx.S.registryEntries[0]);
  assert.equal(view.access.status, status); assert.equal(view.pending, false);
  h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regdrawerwrap.innerHTML, new RegExp(status));
  h.ctx.domain = 'research'; await h.ctx.loadRegistry();
  assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[0]).access, null);
  assert.match(h.roots.regdrawerwrap.innerHTML, /Access information is not available|Current platform policy/);
});
test('admin policy application PENDING is not a pending access request and does not hide returned usability', async () => {
  const h = await statusHarness(); h.ctx.SESSION.role = 'admin'; h.ctx.domain = 'platform';
  h.store.catalog = adminCatalog('platform'); const m = h.store.catalog.models[0];
  m.policy.applicationStatus = 'PENDING'; m.policy.rateLimit = null; m.accessByDomain.platform.rateLimit = null;
  assert.equal(h.ctx.validHostedGatewayCatalog(h.store.catalog), true);
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  const view = h.ctx.registryModelView(h.ctx.S.registryEntries[0]);
  assert.equal(view.applicationStatus, 'PENDING'); assert.equal(view.pending, false); assert.equal(view.available, true);
  assert.match(h.roots.regdrawerwrap.innerHTML, /Application: PENDING/);
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /Access request PENDING|Pending review/);
});
test('admin catalog cannot substitute for Lead scoped contract even with matching accessByDomain', async () => {
  const h = await statusHarness(); h.store.catalog = adminCatalog();
  assert.equal(h.ctx.validHostedGatewayCatalog(h.store.catalog), true);
  await h.ctx.loadRegistry(); assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[0]).access, null);
});
// AUD-003: platform admin with no domain selected must see the actual page
// consume platformAdmission, not just the isolated helper. "Select a domain"
// is a distinct, honest state from "Access unverified" — and an ACTIVE
// application status is never rendered as approval/verification.
test('admin, no domain selected, model has an ACTIVE application and a granted domain: the rendered row says so, not "Access unverified"', async () => {
  const h = await statusHarness(); h.ctx.SESSION.role = 'admin'; h.ctx.domain = null;
  h.store.catalog = adminCatalog('operations', 'ALLOWED');
  await h.ctx.loadRegistry();
  const row = h.ctx.registryModelStatusHtml(h.ctx.S.registryEntries[0]);
  assert.match(row, /Select a domain to view access/);
  assert.match(row, /Policy active/);
  assert.match(row, /Granted in:[^<]*operations/);
  assert.doesNotMatch(row, /Access unverified/);
  assert.doesNotMatch(row, />Approved</);
  assert.doesNotMatch(row, /Verified/);
});
test('admin, no domain selected, model never admitted anywhere: "No policy configured", not "Policy active" or "Access unverified"', async () => {
  const h = await statusHarness(); h.ctx.SESSION.role = 'admin'; h.ctx.domain = null;
  h.store.catalog = adminCatalog('operations', 'DENIED');
  await h.ctx.loadRegistry();
  const row = h.ctx.registryModelStatusHtml(h.ctx.S.registryEntries[0]);
  assert.match(row, /Select a domain to view access/);
  assert.match(row, /No policy configured/);
  assert.doesNotMatch(row, /Policy active|Policy pending|Policy reconciliation failed|Unknown/);
  assert.doesNotMatch(row, /Access unverified/);
});
test('admin, no domain selected, model policy is PENDING: "Policy pending", not "Policy active" or "No policy configured"', async () => {
  const h = await statusHarness(); h.ctx.SESSION.role = 'admin'; h.ctx.domain = null;
  h.store.catalog = adminCatalog('operations', 'DENIED');
  const limits = { requestsPerMinute: 60, tokensPerMinute: null, connectionsPerSecond: null };
  h.store.catalog.models[0].policy = { modelId: h.store.catalog.models[0].id, allowedDomains: [], requestableDomains: [],
    limits, applicationStatus: 'PENDING', rateLimit: null, updatedBySubject: 'test-admin', updatedAt: stamp, revision: 1 };
  h.store.catalog.models[0].accessByDomain.operations.limits = limits;
  await h.ctx.loadRegistry();
  const row = h.ctx.registryModelStatusHtml(h.ctx.S.registryEntries[0]);
  assert.match(row, /Select a domain to view access/);
  assert.match(row, /Policy pending/);
  assert.doesNotMatch(row, /Policy active|No policy configured|Policy reconciliation failed|Unknown/);
});
test('admin, no domain selected, model policy is RECONCILIATION_FAILED: "Policy reconciliation failed"', async () => {
  const h = await statusHarness(); h.ctx.SESSION.role = 'admin'; h.ctx.domain = null;
  h.store.catalog = adminCatalog('operations', 'DENIED');
  const limits = { requestsPerMinute: 60, tokensPerMinute: null, connectionsPerSecond: null };
  const failedRateLimit = { id: null, status: 'RECONCILIATION_FAILED', reason: 'TEST reconciliation failure', reconciledAt: stamp };
  h.store.catalog.models[0].policy = { modelId: h.store.catalog.models[0].id, allowedDomains: [], requestableDomains: [],
    limits, applicationStatus: 'RECONCILIATION_FAILED', rateLimit: failedRateLimit, updatedBySubject: 'test-admin', updatedAt: stamp, revision: 1 };
  h.store.catalog.models[0].accessByDomain.operations.limits = limits;
  h.store.catalog.models[0].accessByDomain.operations.rateLimit = failedRateLimit;
  await h.ctx.loadRegistry();
  const row = h.ctx.registryModelStatusHtml(h.ctx.S.registryEntries[0]);
  assert.match(row, /Policy reconciliation failed/);
  assert.doesNotMatch(row, /Policy active|No policy configured|Policy pending|Unknown/);
});
test('lead never sees platformAdmission wording even when SESSION/domain state is manipulated', async () => {
  const h = await statusHarness(); h.ctx.domain = null;
  h.store.catalog = adminCatalog('operations', 'ALLOWED');
  await h.ctx.loadRegistry();
  const row = h.ctx.registryModelStatusHtml(h.ctx.S.registryEntries[0]);
  assert.doesNotMatch(row, /Select a domain to view access|Policy active|Granted in:/);
  assert.match(row, /Access unverified/);
});
test('admin, no domain selected: model rows render without "discovered" summary text', async () => {
  const h = await statusHarness(); h.ctx.S.registryFilterType='All'; h.ctx.SESSION.role = 'admin'; h.ctx.domain = null;
  h.store.registry.entries = h.store.registry.entries.slice(0, 1);
  h.store.catalog = adminCatalog('operations', 'ALLOWED');
  await h.ctx.loadRegistry();
  // 1 model entry → 1 row in the unified table; no "discovered" summary
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length, 1);
  assert.doesNotMatch(h.roots.regbox.innerHTML, /discovered/);
});
test('admin, no domain selected: all 47 model rows render without fabricated summary text', async () => {
  const h = await statusHarness(); h.ctx.S.registryFilterType='All'; h.ctx.SESSION.role = 'admin'; h.ctx.domain = null;
  h.store.catalog = adminCatalog('operations', 'ALLOWED');
  await h.ctx.loadRegistry();
  // 47 model entries from inventory() → 47 rows (paginated by REG_PAGE_SIZE if necessary)
  assert.doesNotMatch(h.roots.regbox.innerHTML, /discovered/);
  assert.doesNotMatch(h.roots.regbox.innerHTML, /0 allowed · 0 available for domain/);
});
test('domain selected and AI Gateway read is ready: model rows render normally in unified table', async () => {
  const h = await statusHarness(); h.ctx.S.registryFilterType='All'; h.store.catalog.models = [];
  await h.ctx.loadRegistry();
  assert.equal(h.ctx.S.registryModelAccess.state, 'ready');
  // Models display as regular table rows; no "discovered" summary line
  assert.doesNotMatch(h.roots.regbox.innerHTML, /discovered/);
  assert.ok(h.roots.regbox.querySelectorAll('.regrow').length > 0);
});
test('model projection state is display only and never promotes ALLOWED into usable', () => {
  const e = inventory(1)[0], catalog = domainCatalog(); catalog.models[0].access.usable = false;
  const view = registryModelStatus(e, { catalog, domainId: 'operations', role: 'lead' });
  assert.equal(view.access.status, 'ALLOWED'); assert.equal(view.available, false);
  // The actual loader additionally rejects this inconsistent current public contract.
});
test('native records are not transformed by the pure projection helper', () => {
  const native = { ...inventory(1)[0], _source: 'agentcore-registry' }, before = structuredClone(native);
  assert.equal(registryModelStatus(native), null); assert.deepEqual(native, before);
});
for (const status of ['APPROVED','REJECTED','CANCELLED']) test(`latest ${status} request is historical access metadata, never native approval or pending`, async () => {
  const h = await statusHarness();
  h.store.catalog.models[0].access.latestRequest = { id: 'test-history', status, requestedAt: '2026-09-01T00:00:00.000Z' };
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.equal(h.ctx.registryModelView(h.ctx.S.registryEntries[0]).pending, false);
  assert.match(h.roots.regdrawerwrap.innerHTML, new RegExp('Latest access request: '+status));
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML, /regapprove|regreject|Access request PENDING|Pending review/);
});

async function realGateway(h) {
  const { fn } = await import('./test-support/model-approval-harness.mjs');
  const vm = await import('node:vm');
  h.ctx.applyDemoAssistToHostedView = () => {};
  for (const name of ['renderHostedGateway','hostedGatewayDetail','hostedGatewayProvider','hostedGatewayLimits','hostedGatewayRateLimit','hostedGatewayPolicyEditor','hostedGatewayDomainCoverage','hostedSessionTime']) vm.runInContext(fn(name), h.ctx);
}
test('actual Registry drawer navigation selects exact Gateway ID and renders the same scoped ALLOWED/USABLE/limits', async () => {
  const h = await statusHarness(); await realGateway(h); delete h.roots.hostedgateway;
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  await h.find('registrygatewayopen').onclick();
  assert.equal(h.ctx.S.hostedGatewaySelectedModelId, 'test-gateway/model-0');
  assert.match(h.find('hostedgateway').innerHTML, /ALLOWED/);
  assert.match(h.find('hostedgateway').innerHTML, /USABLE/);
  assert.match(h.find('hostedgateway').innerHTML, /60/);
  assert.equal(h.writes.length, 0);
});
test('embedded Gateway exact requested model wins over a valid previous selection', async () => {
  const h = await statusHarness(); await realGateway(h); delete h.roots.hostedgateway;
  h.store.catalog.models.push(domainCatalog('test-gateway/model-1').models[0]);
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[1].onclick();
  h.ctx.S.hostedGatewaySelectedModelId = 'test-gateway/model-0';
  await h.find('registrygatewayopen').onclick();
  assert.equal(h.ctx.S.hostedGatewaySelectedModelId, 'test-gateway/model-1');
  assert.match(h.find('hostedgateway').innerHTML, /data-gateway-model="test-gateway\/model-1"[^>]*aria-current="true"/);
});
test('unreturned Registry model cannot silently select the first allowed Gateway model', async () => {
  const h = await statusHarness(); delete h.roots.hostedgateway;
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[1].onclick();
  await h.find('registrygatewayopen').onclick();
  assert.equal(h.ctx.S.hostedGatewayCatalog, null);
  assert.match(h.find('hostedgateway').innerHTML, /no other model has been selected/);
});
test('ambiguous Registry identity keeps governed navigation read-only without guessing an alias', async () => {
  const h = await statusHarness(); h.store.registry.entries[0].versions[0].content.gatewayModelId = 'other-model';
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick(); const before = h.reads.length;
  await h.find('registrygatewayopen').onclick(); assert.equal(h.reads.length, before);
  assert.match(h.find('registrygatewaypanel').innerHTML, /reconcile the exact Gateway model identity/);
});
for (const change of ['drawer-model','drawer-close','panel-identity','replacement-node']) test(`embedded Gateway ignores late read after ${change}`, async () => {
  const h = await statusHarness(); delete h.roots.hostedgateway;
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  const gate = deferred(), entered = deferred(); h.store.hook = async path => { if (path === '/api/ai-gateway') { entered.resolve(); await gate.promise; } };
  const pending = h.find('registrygatewayopen').onclick(); await entered.promise;
  if (change === 'drawer-model') { h.ctx.S.registryDrawerId = 'test-gateway/model-1'; h.ctx.renderRegistryDrawer(); }
  if (change === 'drawer-close') h.find('regdrawerclose').onclick();
  if (change === 'panel-identity') h.find('registrygatewaypanel').dataset.model = 'test-gateway/model-1';
  if (change === 'replacement-node') h.find('registrygatewaypanel').innerHTML = '<div id="hostedgateway"></div>';
  const state = plain(h.ctx.S), html = h.roots.regdrawerwrap.innerHTML;
  gate.resolve(); await pending; assert.deepEqual(plain(h.ctx.S), state); assert.equal(h.roots.regdrawerwrap.innerHTML, html);
  assert.equal(h.effects.includes('render'), false);
});
for (const failure of [{ ok: false, code: 'FORBIDDEN' }, { ok: false, code: 'MODEL_GOVERNANCE_UNAVAILABLE' }, { ok: true, models: [] }, Error('TEST unavailable')]) test(`Gateway refresh clears prior access on ${failure.code || failure.message || 'malformed'}`, async () => {
  const h = await statusHarness(); await h.ctx.loadHostedGateway(); assert.ok(h.ctx.S.hostedGatewayCatalog);
  h.store.catalog = failure; await h.ctx.loadHostedGateway(); assert.equal(h.ctx.S.hostedGatewayCatalog, null);
});
test('switching to a native type resets the model-only filter and makes no Gateway request', async () => {
  const h = await statusHarness(); h.ctx.S.registryModelFilter = 'available';
  h.roots.regbox.innerHTML = '<span data-regtype="Skill"></span>';
  h.ctx.wireRegistry(); h.roots.regbox.querySelectorAll('[data-regtype]')[0].onclick();
  assert.equal(h.ctx.S.registryModelFilter, 'all'); await h.ctx.loadRegistry();
  assert.equal(h.reads.filter(read => read.path === '/api/ai-gateway').length, 0);
});
test('actual Gateway read-only limits agree with Registry: null is unconfigured, never an invented zero', async () => {
  const h = await statusHarness(); await realGateway(h); delete h.roots.hostedgateway;
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  await h.find('registrygatewayopen').onclick();
  const html = h.find('hostedgateway').innerHTML;
  assert.match(html, /<b>60<\/b><div class="d">Requests \/ minute/);
  assert.match(html, /<b>Not configured<\/b><div class="d">Tokens \/ minute/);
  assert.match(html, /<b>Not configured<\/b><div class="d">Connections \/ second/);
  assert.doesNotMatch(html, /<b>0<\/b>/);
});
