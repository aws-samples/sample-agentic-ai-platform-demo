// Actual app renderer and handlers with synthetic read-only transport; not live acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusHarness, inventory, adminCatalog } from './test-support/model-status-harness.mjs';

async function setup({ official = false } = {}) {
  const h = await statusHarness(); h.ctx.S.registryFilterType='Model';
  h.store.registry.entries = inventory(3);
  h.store.registry.entries[0].versions[0].content.ownedBy = 'Example Provider';
  h.store.registry.entries[1].versions[0].content.ownedBy = 'unknown';
  h.store.registry.entries[2].versions[0].content.ownedBy = 'system';
  h.store.registry.entries[1].name = 'Anthropic-looking name is not evidence';
  h.store.registry.entries[1].vendor = 'Unverified vendor';
  if (official) {
    const entry = h.store.registry.entries[0];
    entry.id = 'bedrock-mantle/anthropic.claude-haiku-4-5';
    entry.versions[0].content.gatewayModelId = entry.id;
  }
  let task;
  h.ctx.runSessionTask = fn => (task = fn());
  h.done = () => task;
  return h;
}

test('Model filter renders dedicated columns; mixed/native tabs retain native columns and actions', async () => {
  const h = await setup();
  await h.ctx.loadRegistry();
  assert.ok(h.reads.some(read=>read.path==='/api/registry'));
  assert.ok(!h.reads.some(read=>read.path.startsWith('/api/registry?')),
    'hosted Registry does not accept the legacy type query');
  assert.match(h.roots.regbox.innerHTML, /Models \(3\)|Provider|Input modalities|Output modalities|Model version/);
  for (const title of ['Type','Domain','Owner team','Governance','Default version','Approved by','Approved'])
    assert.ok(!h.roots.regbox.innerHTML.includes(`<th>${title}</th>`));
  assert.doesNotMatch(h.roots.regbox.innerHTML, /1\.0\.0|Unverified vendor/);
  h.ctx.S.registryProvider='Example Provider';
  h.ctx.S.registryFilterType='All';
  h.store.registry.entries.push({id:'native-test',type:'Skill',name:'Native test',domain:'operations',defaultVersion:'2.3.0',versions:[{semver:'2.3.0',status:'APPROVED'}]});
  h.ctx.clearHostedRegistryReadCache();
  await h.ctx.loadRegistry();
  assert.match(h.roots.regbox.innerHTML, /<th>Type<\/th>|2\.3\.0/);
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length,4);
  assert.doesNotMatch(h.roots.regbox.innerHTML, /id="regprovider"/);
});

test('provider uses exact official IDs, not ownedBy; dropdown missing-state, search and clear handlers work', async () => {
  const h = await setup({ official: true }); await h.ctx.loadRegistry();
  assert.match(h.roots.regbox.innerHTML, /value="Anthropic"/);
  assert.doesNotMatch(h.roots.regbox.innerHTML, /value="Example Provider"|value="Unverified vendor"|value="system"|value="unknown"/);
  let select=h.find('regprovider'); select.value='Anthropic'; select.onchange(); await h.done();
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length,1);
  select=h.find('regprovider'); select.value='__missing__'; select.onchange(); await h.done();
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length,2);
  h.ctx.S.registrySearch='nonexistent'; await h.ctx.loadRegistry();
  assert.match(h.roots.regbox.innerHTML,/No matching models/);
  h.find('regclear').onclick(); await h.done();
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length,3);
  h.ctx.S.registrySearch='claude haiku'; await h.ctx.loadRegistry();
  assert.equal(h.roots.regbox.querySelectorAll('.regrow').length,1);
});

test('actual detail entry hides wrapper, raw credentials, gateway approver and unrelated domains', async () => {
  const h = await setup(), e=h.store.registry.entries[0];
  Object.assign(e.versions[0].content,{gatewayUrl:'https://should-not-render.invalid',credential:'SYNTHETIC_PRIVATE',pricing:{private:'SYNTHETIC_PRICING'}});
  e.policy={allowedDomains:['SYNTHETIC_OTHER_DOMAIN']};
  await h.ctx.loadRegistry(); h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  const html=h.roots.regdrawerwrap.innerHTML;
  for (const heading of ['Overview','Access']) assert.ok(html.includes(`>${heading}</h3>`));
  assert.match(html, /<summary[^>]*>Technical details<\/summary>/);
  assert.match(html,/test-gateway\/model-0|test-runtime.model-0|Example Provider/);
  assert.doesNotMatch(html,/1\.0\.0|Version history|decided by gateway|SYNTHETIC_PRIVATE|SYNTHETIC_PRICING|SYNTHETIC_OTHER_DOMAIN|should-not-render/);
  assert.match(html,/Not provided|await backend metadata|not been end-to-end verified/);
  await h.find('registrygatewayopen').onclick();
  assert.equal(h.ctx.S.hostedGatewaySelectedModelId,e.id);
  assert.equal(h.writes.length,0);
});

test('admin policy comes from validated current catalog, never unscoped entry metadata', async () => {
  const h=await setup();h.ctx.SESSION.role='admin';h.ctx.domain=null;
  h.store.catalog=adminCatalog(); await h.ctx.loadRegistry();
  h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regdrawerwrap.innerHTML,/Current platform policy|operations: ALLOWED|Application: ACTIVE/);
  h.store.httpStatus=503; h.store.catalog={ok:false,code:"MODEL_GOVERNANCE_UNAVAILABLE"}; await h.ctx.loadRegistry();
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML,/Current platform policy|operations: ALLOWED/);
});

test('technical IDs remain accurate without migration project copy', async () => {
  const h=await setup(),e=h.store.registry.entries[0];
  e.id='bedrock-mantle/synthetic-model'; e.versions[0].content.gatewayModelId=e.id;
  await h.ctx.loadRegistry();h.roots.regbox.querySelectorAll('.regrow')[0].onclick();
  assert.match(h.roots.regdrawerwrap.innerHTML,/bedrock-mantle\/synthetic-model/);
  assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML,/not migrated|Runtime-only requirement|Verified|Approved/);
  assert.match(h.roots.regdrawerwrap.innerHTML,/Runtime adapter alias/);
});

test('empty inventory differs from filtered empty and backend failure has retry', async () => {
  const h=await setup();h.store.registry.entries=[];await h.ctx.loadRegistry();
  assert.match(h.roots.regbox.innerHTML,/No models discovered/);
  h.store.registry={ok:false,source:'aws'};h.ctx.clearHostedRegistryReadCache();await h.ctx.loadRegistry();
  assert.match(h.roots.regbox.innerHTML,/role="alert"|Could not load Registry inventory/);
  assert.equal(typeof h.find('regretry').onclick,'function');
});

test('integration Model count labels distinguish total inventory and filtered matches, including zero',async()=>{
 const h=await setup({official:true});h.ctx.S.registryProvider='Anthropic';await h.ctx.loadRegistry();
 assert.match(h.roots.regbox.innerHTML,/3 total models/);assert.match(h.roots.regbox.innerHTML,/1 matching model/);
 h.ctx.S.registrySearch='no-synthetic-match';await h.ctx.loadRegistry();assert.match(h.roots.regbox.innerHTML,/3 total models/);assert.match(h.roots.regbox.innerHTML,/0 matching models/);
});

test('Registry Model tab accepts a click while the first inventory read is pending', async () => {
  const { source } = await import('./test-support/model-approval-harness.mjs');
  const { default: vm } = await import('node:vm');
  const h = await setup();
  h.ctx.S.registryFilterType = 'All';
  const chip = { dataset: { regtype: 'Model' } };
  const query = h.ctx.document.querySelectorAll;
  h.ctx.document.querySelectorAll = selector => selector === '[data-regtype]' ? [chip] : query(selector);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  h.store.hook = () => pending;
  let nextRead;
  h.ctx.render = () => { nextRead = h.ctx.loadRegistry(); };
  h.ctx.vRegistry = () => '';
  h.ctx.m = { innerHTML: '' };
  const branch = source.match(/else if\(S\.view==='registry'\)\{([^\n]+)\}/)[1];
  const firstRead = vm.runInContext(`(async()=>{${branch}})()`, h.ctx);
  try {
    assert.equal(typeof chip.onclick, 'function', 'visible tabs must be wired before awaiting inventory');
    chip.onclick();
    assert.equal(h.ctx.S.registryFilterType, 'Model');
  } finally { release(); }
  await Promise.all([firstRead, nextRead]);
  assert.match(h.roots.regbox.innerHTML, /model-provider-group/);
});
