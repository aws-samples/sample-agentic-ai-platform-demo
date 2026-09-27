import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, TransactWriteItemsCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { createWorkspaceState } from '../lambda/workspace/state.mjs';
import { createGovernanceRuntime, createGovernanceMutationClaimResolver } from '../lambda/governance/runtime.mjs';
import { buildAlertCatalogItem } from '../lambda/workspace/alert-policies.mjs';
const at = '2026-09-12T08:00:00.000Z';
const policy=(id='synthetic-alert')=>({id,name:'Synthetic alert',metric:'Synthetic count',threshold:'Above synthetic threshold',severity:'SEV3',owner:'',runbook:'',raci:{responsible:'',accountable:'',consulted:'',informed:''},version:1,enabled:false,createdAt:at});
const catalog = (policies = [policy()]) => ({ schemaVersion: 1, revision: 1, domainId: 'platform', updatedAt: at, policies });
function setup(document, { fails = false, raw, race = false } = {}) {
  // Persisted AttributeValue bytes at the Dynamo transport seam, not a service stub.
  const stored = new Map();
  if (document) stored.set('ALERT_POLICY#platform/CATALOG', JSON.stringify(buildAlertCatalogItem(document)));
  if (raw) stored.set('ALERT_POLICY#platform/CATALOG', JSON.stringify(raw));
  const calls = [];
  const dynamo = { async send(command) {
    calls.push(command);
    if(command instanceof TransactWriteItemsCommand){
      const tx=command.input.TransactItems;
      assert.equal(tx.length,3);assert.equal(tx[0].Put.Item.pk.S,'ALERT_POLICY#platform');
      const existing=stored.has('ALERT_POLICY#platform/CATALOG')?JSON.parse(stored.get('ALERT_POLICY#platform/CATALOG')):null;
      const conflict=race||(tx[0].Put.ExpressionAttributeValues?existing?.document.S!==tx[0].Put.ExpressionAttributeValues[':expected'].S:existing!==null)||tx.slice(1).some(x=>stored.has(x.Put.Item.pk.S+'/'+x.Put.Item.sk.S));
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
  return { routeKey: 'GET /api/alerts', headers: { 'x-active-domain': domain },
    ...(query ? { queryStringParameters: query, rawQueryString: new URLSearchParams(query).toString() } : {}),
    requestContext: { requestId: 'synthetic-read', http: { method: 'GET', path: '/api/alerts' },
      ...(authenticated ? { authorizer: { jwt: { claims: { sub: 'synthetic-reader', token_use: 'access', 'cognito:groups': groups } } } } : {}) } };
}
const body = r => JSON.parse(r.body);

const draft=(patch={})=>({operation:'create',expectedRevision:0,expectedPolicyVersion:null,policy:Object.fromEntries(Object.entries(policy()).filter(([k])=>!['version','enabled','createdAt'].includes(k))),reason:'Synthetic QA disabled alert draft.',...patch});
function writeEvent(payload=draft(),options={}){const e=event(options);e.routeKey='POST /api/governance/alert-drafts';e.requestContext.http={method:'POST',path:'/api/governance/alert-drafts'};e.headers['x-request-id']=options.requestId||'synthetic-draft-request';e.body=JSON.stringify(payload);return e;}

test('unconfigured read does not seed; explicit create atomically initializes disabled alert and audit',async()=>{const h=setup();const before=body(await h.runtime(event()));assert.equal(before.configured,false);assert.equal(before.revision,0);assert.equal(h.stored.size,0);const r=await h.runtime(writeEvent());assert.equal(r.statusCode,200,r.body);assert.equal(body(r).catalog.revision,1);assert.equal(body(r).catalog.policies[0].enabled,false);assert.equal(body(r).delivery,'NOT_CONFIGURED');const read=body(await h.runtime(event()));assert.equal(read.configured,true);assert.equal(read.policies[0].raci.responsible,'');assert.equal(h.stored.size,3)});
test('edit RACI increments revision/version; stale write rejects; replay does not duplicate audit',async()=>{const h=setup();assert.equal((await h.runtime(writeEvent())).statusCode,200);const d=draft({operation:'update',expectedRevision:1,expectedPolicyVersion:1,policy:{...draft().policy,raci:{responsible:'QA synthetic responder',accountable:'',consulted:'',informed:''}}});const r=await h.runtime(writeEvent(d,{requestId:'synthetic-update'}));assert.equal(r.statusCode,200,r.body);assert.equal(body(r).catalog.revision,2);assert.equal(body(r).catalog.policies[0].version,2);const conflict=await h.runtime(writeEvent(d,{requestId:'synthetic-stale'}));assert.equal(conflict.statusCode,409);const replay=await h.runtime(writeEvent(d,{requestId:'synthetic-update'}));assert.equal(body(replay).replayed,true);const audits=[...h.stored.values()].map(JSON.parse).filter(x=>x.entityType.S==='WORKSPACE_AUDIT');assert.equal(audits.length,2);assert.deepEqual(audits.map(x=>x.action.S).sort(),['alert_policy.create','alert_policy.update'])});
for(const [label,options] of [['anonymous',{authenticated:false}],['lead',{groups:['domain-lead','domain-operations'],domain:'operations'}],['builder',{groups:['domain-builder','domain-operations'],domain:'operations'}],['user',{groups:[]}],['foreign',{domain:'operations'}]])test(`alert read/write denies ${label} before storage`,async()=>{const h=setup();for(const e of [event(options),writeEvent(draft(),options)]){const r=await h.runtime(e);assert.ok([401,403].includes(r.statusCode),r.body)}assert.equal(h.calls.length,0)});
test('invalid alerts, activation, recipient extra fields and missing reason do not write',async()=>{for(const d of [draft({enabled:true}),draft({policy:{...draft().policy,enabled:true}}),draft({policy:{...draft().policy,severity:'PAGE_NOW'}}),draft({policy:{...draft().policy,raci:{...draft().policy.raci,email:'synthetic@example.invalid'}}}),draft({reason:''}),draft({policy:{...draft().policy,metric:''}})]){const h=setup();const r=await h.runtime(writeEvent(d));assert.equal(r.statusCode,400,r.body);assert.equal(h.stored.size,0)}});
test('first-write race fails atomic transaction, no initialized catalog or audit',async()=>{const h=setup(undefined,{race:true});const r=await h.runtime(writeEvent());assert.equal(r.statusCode,409,r.body);assert.equal(h.stored.size,0)});
test('failed transaction does not initialize catalog; enabled existing alert is immutable here',async()=>{const h=setup(undefined,{fails:true});assert.equal((await h.runtime(writeEvent())).statusCode,503);assert.equal(h.stored.size,0);const active=setup(catalog([{...policy(),enabled:true}]));const r=await active.runtime(writeEvent(draft({operation:'update',expectedRevision:1,expectedPolicyVersion:1})));assert.equal(r.statusCode,409)});
