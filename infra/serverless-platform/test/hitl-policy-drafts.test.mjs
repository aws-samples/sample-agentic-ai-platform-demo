import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, TransactWriteItemsCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { createWorkspaceState } from '../lambda/workspace/state.mjs';
import { createGovernanceRuntime, createGovernanceMutationClaimResolver } from '../lambda/governance/runtime.mjs';
import { buildHitlCatalogItem, buildHitlCatalogInitialization } from '../lambda/workspace/hitl-policies.mjs';
const at = '2026-09-12T08:00:00.000Z';
const policy = (id = 'synthetic-write') => ({ id, version: 1, name: 'Synthetic write', toolMatch: ['delete_*'], mode: 'require_approval', scope: { kind: 'domain' }, enabled: true, createdAt: at });
const catalog = (policies = [policy()]) => ({ schemaVersion: 1, revision: 1, domainId: 'platform', updatedAt: at, policies });
function setup(document, { fails = false, raw, race = false } = {}) {
  // Persisted AttributeValue bytes at the Dynamo transport seam, not a service stub.
  const stored = new Map();
  if (document) stored.set('HITL_POLICY#platform/CATALOG', JSON.stringify(buildHitlCatalogItem(document)));
  if (raw) stored.set('HITL_POLICY#platform/CATALOG', JSON.stringify(raw));
  const calls = [];
  const dynamo = { async send(command) {
    calls.push(command);
    if(command instanceof TransactWriteItemsCommand){
      const tx=command.input.TransactItems;
      assert.equal(tx.length,3);assert.equal(tx[0].Put.Item.pk.S,'HITL_POLICY#platform');
      const existing=JSON.parse(stored.get('HITL_POLICY#platform/CATALOG'));
      const conflict=race||existing.document.S!==tx[0].Put.ExpressionAttributeValues[':expected'].S||tx.slice(1).some(x=>stored.has(x.Put.Item.pk.S+'/'+x.Put.Item.sk.S));
      if(conflict)throw new TransactionCanceledException({$metadata:{},message:'synthetic conflict',CancellationReasons:[{Code:'ConditionalCheckFailed'},{Code:'None'},{Code:'None'}]});
      if(fails)throw Error('synthetic transaction unavailable');
      for(const {Put} of tx)stored.set(Put.Item.pk.S+'/'+Put.Item.sk.S,JSON.stringify(Put.Item));return {};
    }
    assert.ok(command instanceof GetItemCommand);assert.equal(command.input.ConsistentRead,true);
    const key = command.input.Key.pk.S + '/' + command.input.Key.sk.S;
    return stored.has(key) ? { Item: JSON.parse(stored.get(key)) } : {};
  } };
  const state = createWorkspaceState({ tableName: 'synthetic-state', dynamo, now: () => new Date(at) });
  const runtime = createGovernanceRuntime({
    workspaceState: state, mutationClaimResolver: createGovernanceMutationClaimResolver({ tableName: 'synthetic-state', dynamo }),
    domainDirectory: { async getDomain() { throw Error('unexpected'); }, async listActiveDomains() { return [{ id: 'platform' }, { id: 'operations' }]; } },
    registryClient: { async send() { throw Error('not an HITL source'); } },
    identityVerifier: async () => false, clock: () => new Date(at),
  });
  return { runtime, calls, state, stored };
}
function event({ groups = ['platform-admin'], domain = 'platform', query, authenticated = true } = {}) {
  return { routeKey: 'GET /api/hitl', headers: { 'x-active-domain': domain },
    ...(query ? { queryStringParameters: query, rawQueryString: new URLSearchParams(query).toString() } : {}),
    requestContext: { requestId: 'synthetic-read', http: { method: 'GET', path: '/api/hitl' },
      ...(authenticated ? { authorizer: { jwt: { claims: { sub: 'synthetic-reader', token_use: 'access', 'cognito:groups': groups } } } } : {}) } };
}
const body = r => JSON.parse(r.body);

const draft=(patch={})=>({operation:'create',expectedRevision:1,expectedPolicyVersion:null,policy:{id:'synthetic-draft',name:'Synthetic draft',toolMatch:['synthetic_*'],mode:'require_approval',scope:{kind:'domain'}},reason:'Synthetic QA draft configuration only.',...patch});
function writeEvent(payload=draft(),options={}){const e=event(options);e.routeKey='POST /api/governance/policy-drafts';e.requestContext.http={method:'POST',path:'/api/governance/policy-drafts'};e.headers['x-request-id']=options.requestId||'synthetic-draft-request';e.body=JSON.stringify(payload);return e;}
test('actual runtime writes disabled draft/catalog+audit+mutation atomically and replays exact request',async()=>{
 const h=setup(catalog([]));const first=await h.runtime(writeEvent());assert.equal(first.statusCode,200,first.body);const result=body(first);assert.equal(result.catalog.revision,2);assert.equal(result.catalog.policies[0].enabled,false);assert.equal(result.catalog.policies[0].version,1);assert.equal(result.enforcement,'NOT_CONFIGURED');
 const read=body(await h.runtime(event()));assert.equal(read.policies[0].id,'synthetic-draft');assert.equal(read.policies[0].enabled,false);
 assert.equal(h.calls.filter(c=>c instanceof TransactWriteItemsCommand).length,1);const audits=[...h.stored.values()].map(JSON.parse).filter(x=>x.entityType.S==='WORKSPACE_AUDIT');assert.equal(audits.length,1);assert.equal(audits[0].actor.S,'synthetic-reader');assert.equal(audits[0].action.S,'hitl_policy.create');
 const replay=await h.runtime(writeEvent());assert.equal(replay.statusCode,200,replay.body);assert.equal(body(replay).replayed,true);assert.equal(h.calls.filter(c=>c instanceof TransactWriteItemsCommand).length,1);
 const changed=await h.runtime(writeEvent(draft({reason:'Different synthetic reason.'})));assert.equal(changed.statusCode,409);
});
test('draft update increments both versions and stale revision cannot overwrite',async()=>{
 const h=setup(catalog([]));assert.equal((await h.runtime(writeEvent())).statusCode,200);
 const update=draft({operation:'update',expectedRevision:2,expectedPolicyVersion:1,policy:{...draft().policy,name:'Synthetic revised draft'}});
 const saved=await h.runtime(writeEvent(update,{requestId:'synthetic-update'}));assert.equal(saved.statusCode,200,saved.body);assert.equal(body(saved).catalog.revision,3);assert.equal(body(saved).catalog.policies[0].version,2);assert.equal(body(saved).catalog.policies[0].enabled,false);
 const conflict=await h.runtime(writeEvent(update,{requestId:'synthetic-stale'}));assert.equal(conflict.statusCode,409);assert.equal(h.calls.filter(c=>c instanceof TransactWriteItemsCommand).length,2);
});
for(const [label,options] of [['anonymous',{authenticated:false}],['lead',{groups:['domain-lead','domain-operations'],domain:'operations'}],['builder',{groups:['domain-builder','domain-operations'],domain:'operations'}],['user',{groups:[]}],['non-platform-admin',{domain:'operations'}]])test(`draft authorization rejects ${label} before storage`,async()=>{const h=setup(catalog([]));const r=await h.runtime(writeEvent(draft(),options));assert.ok([401,403].includes(r.statusCode),r.body);assert.equal(h.calls.length,0)});
test('activation, unknown fields, invalid scope and missing reason cannot write',async()=>{
 for(const payload of [draft({enabled:true}),draft({policy:{...draft().policy,enabled:true}}),draft({reason:''}),draft({policy:{...draft().policy,scope:{kind:'agent',agentId:'invented'}}}),draft({expectedRevision:0}),draft({expectedPolicyVersion:1})]){
 const h=setup(catalog([]));const r=await h.runtime(writeEvent(payload));assert.equal(r.statusCode,400,r.body);assert.equal(h.calls.filter(c=>c instanceof TransactWriteItemsCommand).length,0);
 }
});
test('active policy cannot be edited and unrelated policies remain identical',async()=>{
 const existing=policy('synthetic-active');const h=setup(catalog([existing]));
 const denied=await h.runtime(writeEvent(draft({operation:'update',expectedPolicyVersion:1,policy:{...draft().policy,id:existing.id}})));assert.equal(denied.statusCode,409);
 const saved=await h.runtime(writeEvent(draft(),{requestId:'another-synthetic'}));assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(body(saved).catalog.policies[0],existing);
});
test('transaction failure stores neither catalog nor audit nor mutation',async()=>{const h=setup(catalog([]),{fails:true});const r=await h.runtime(writeEvent());assert.equal(r.statusCode,503);assert.equal(h.stored.size,1);assert.equal(JSON.parse(JSON.parse(h.stored.values().next().value).document.S).revision,1)});

test('atomic revision race rejects without audit or mutation artifacts',async()=>{const h=setup(catalog([]),{race:true});const r=await h.runtime(writeEvent());assert.equal(r.statusCode,409,r.body);assert.equal(h.stored.size,1);assert.equal(JSON.parse(JSON.parse(h.stored.values().next().value).document.S).revision,1)});
test('canonical request retry tolerates key ordering but never different payload',async()=>{const h=setup(catalog([]));assert.equal((await h.runtime(writeEvent())).statusCode,200);const p=draft(),reordered={...p,policy:{scope:p.policy.scope,mode:p.policy.mode,toolMatch:p.policy.toolMatch,name:p.policy.name,id:p.policy.id}};const r=await h.runtime(writeEvent(reordered));assert.equal(r.statusCode,200,r.body);assert.equal(body(r).replayed,true)});
test('request ID and body allowlist reject malformed writes before storage',async()=>{for(const mutate of [e=>delete e.headers['x-request-id'],e=>e.body=JSON.stringify({...draft(),domainId:'operations'}),e=>e.headers['x-demo-role']='admin']){const h=setup(catalog([]));const e=writeEvent(draft(),{groups:['domain-builder','domain-operations'],domain:'operations'});mutate(e);const r=await h.runtime(e);assert.ok([400,403].includes(r.statusCode),r.body);assert.equal(h.calls.length,0)}});

test('malformed policy schema never reaches transaction, including activation-shaped nested scope',async()=>{for(const policy of [{...draft().policy,toolMatch:[]},{...draft().policy,mode:'activate'},{...draft().policy,scope:{kind:'domain',enabled:true}},{...draft().policy,id:'../foreign'},{...draft().policy,name:'x'.repeat(201)}]){const h=setup(catalog([]));const r=await h.runtime(writeEvent(draft({policy})));assert.equal(r.statusCode,400,r.body);assert.equal(h.calls.some(c=>c instanceof TransactWriteItemsCommand),false)}});
