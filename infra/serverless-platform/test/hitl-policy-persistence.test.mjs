import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { createWorkspaceState } from '../lambda/workspace/state.mjs';
import { createGovernanceRuntime, createGovernanceMutationClaimResolver } from '../lambda/governance/runtime.mjs';
import { buildHitlCatalogItem, buildHitlCatalogInitialization } from '../lambda/workspace/hitl-policies.mjs';
const at = '2026-09-12T08:00:00.000Z';
const policy = (id = 'synthetic-write') => ({ id, version: 1, name: 'Synthetic write', toolMatch: ['delete_*'], mode: 'require_approval', scope: { kind: 'domain' }, enabled: true, createdAt: at });
const catalog = (policies = [policy()]) => ({ schemaVersion: 1, revision: 1, domainId: 'platform', updatedAt: at, policies });
function setup(document, { fails = false, raw } = {}) {
  // Persisted AttributeValue bytes at the Dynamo transport seam, not a service stub.
  const stored = new Map();
  if (document) stored.set('HITL_POLICY#platform/CATALOG', JSON.stringify(buildHitlCatalogItem(document)));
  if (raw) stored.set('HITL_POLICY#platform/CATALOG', JSON.stringify(raw));
  const calls = [];
  const dynamo = { async send(command) {
    calls.push(command);
    assert.ok(command instanceof GetItemCommand, 'read path must not write or scan');
    assert.equal(command.input.ConsistentRead, true);
    if (fails) throw Error('synthetic storage unavailable');
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
test('persisted catalog is read by real state/service/handler with no write', async () => {
  const {runtime,calls}=setup(catalog()); const r=await runtime(event());
  assert.equal(r.statusCode,200);assert.equal(body(r).revision,1);assert.equal(body(r).schemaVersion,1);
  assert.equal(body(r).policies[0].id,'synthetic-write');assert.equal(body(r).policies[0].agentScope,'all');
  assert.equal(body(r).enforcement,'NOT_CONFIGURED');assert.equal(body(r).cursor,null);assert.equal(calls.length,1);
});
test('explicit persisted empty succeeds but missing catalog is unconfigured', async () => {
  const empty=await setup(catalog([])).runtime(event()); assert.equal(empty.statusCode,200);assert.deepEqual(body(empty).policies,[]);
  const missing=await setup().runtime(event());assert.equal(missing.statusCode,503);assert.equal(body(missing).code,'HITL_POLICY_NOT_CONFIGURED');assert.equal(Object.hasOwn(body(missing),'policies'),false);
});
test('storage error or malformed persisted bytes fail closed without empty', async () => {
  for(const env of [{fails:true},{raw:{pk:{S:'HITL_POLICY#platform'},sk:{S:'CATALOG'},document:{S:'{}'}}}]) {
    const r=await setup(undefined,env).runtime(event());assert.equal(r.statusCode,503);assert.equal(body(r).code,'WORKSPACE_UNAVAILABLE');assert.equal(Object.hasOwn(body(r),'policies'),false);
  }
});
test('pagination preserves catalog order and revision across actual reads',async()=>{
  const {runtime,calls}=setup(catalog([policy('first'),{...policy('second'),scope:{kind:'project',projectId:'synthetic-project'}}]));
  const first=body(await runtime(event({query:{limit:'1'}})));assert.equal(first.policies[0].id,'first');assert.ok(first.cursor);
  const second=body(await runtime(event({query:{limit:'1',cursor:first.cursor}})));assert.equal(second.policies[0].id,'second');assert.equal(second.policies[0].agentScope,'synthetic-project');assert.equal(second.cursor,null);assert.equal(calls.length,2);
});
test('cursor cannot cross domains or survive a catalog revision change',async()=>{
  const {runtime,stored,calls}=setup(catalog([policy('first'),policy('second')]));
  const first=body(await runtime(event({query:{limit:'1'}})));
  const foreign=await runtime(event({domain:'operations',query:{cursor:first.cursor}}));assert.equal(foreign.statusCode,400);assert.equal(calls.length,1);
  stored.set('HITL_POLICY#platform/CATALOG',JSON.stringify(buildHitlCatalogItem({...catalog([policy('first'),policy('second')]),revision:2})));
  const changed=await runtime(event({query:{cursor:first.cursor}}));assert.equal(changed.statusCode,409);assert.equal(body(changed).code,'CONFLICT');
});
for(const [label,options] of [['anonymous',{authenticated:false}],['builder',{groups:['domain-builder','domain-operations'],domain:'operations'}],['cross-domain',{groups:['domain-builder','domain-operations'],domain:'platform'}],['unknown-domain',{domain:'unknown_domain'}]])test(`authorization before storage: ${label}`,async()=>{
 const {runtime,calls}=setup(catalog());const r=await runtime(event(options));assert.equal(r.statusCode,options.authenticated===false?401:403);assert.equal(calls.length,0);
});
test('domain identity and policy schema violations reject persisted data',async()=>{
 const bads=[{...catalog(),policies:[{...policy(),scope:{kind:'agent',agentId:'invented'}}]},{...catalog(),policies:[policy(),policy()]},{...catalog(),revision:0}];
 for(const bad of bads){assert.throws(()=>buildHitlCatalogItem(bad));}
 const foreign=buildHitlCatalogItem({...catalog(),domainId:'operations'});
 const r=await setup(undefined,{raw:foreign}).runtime(event());assert.equal(r.statusCode,503);
});
test('initialization builds explicit conditional empty catalog artifact, no implicit seed',()=>{
 const request=buildHitlCatalogInitialization({tableName:'synthetic-state',catalog:catalog([])});
 assert.equal(request.ConditionExpression,'attribute_not_exists(pk) AND attribute_not_exists(sk)');
 assert.equal(request.Item.pk.S,'HITL_POLICY#platform');assert.deepEqual(JSON.parse(request.Item.document.S).policies,[]);
 assert.throws(()=>buildHitlCatalogInitialization({tableName:'synthetic-state',catalog:{...catalog([]),revision:2}}));
});
test('catalog validator bounds bytes, count, patterns and canonical timestamps',()=>{
 for(const bad of [
  {...catalog(),policies:Array.from({length:201},(_,i)=>policy('p-'+i))},
  {...catalog(),policies:[{...policy(),toolMatch:[]}]},
  {...catalog(),policies:[{...policy(),enabled:'true'}]},
  {...catalog(),updatedAt:'yesterday'},
  {...catalog(),policies:[{...policy(),mode:'enforce'}]},
  {...catalog(),policies:[{...policy(),scope:{kind:'project',projectId:'../foreign'}}]},
  {...catalog(),policies:[{...policy(),name:'x'.repeat(201)}]},
 ]) assert.throws(()=>buildHitlCatalogItem(bad));
});
test('forged out-of-range cursor cannot manufacture a successful empty page',async()=>{
 const {runtime}=setup(catalog());
 const cursor=Buffer.from(JSON.stringify({schemaVersion:1,domainId:'platform',revision:1,offset:99})).toString('base64url');
 const r=await runtime(event({query:{cursor}}));assert.equal(r.statusCode,400);assert.equal(Object.hasOwn(body(r),'policies'),false);
});

test('explicit initialization artifact survives disk serialization into real reader',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'hitl-catalog-test-'));
 try {
  const artifact=buildHitlCatalogInitialization({tableName:'synthetic-state',catalog:catalog()});
  const file=join(dir,'catalog-item.json');writeFileSync(file,JSON.stringify(artifact.Item));
  const diskItem=JSON.parse(readFileSync(file,'utf8'));
  const {runtime}=setup(undefined,{raw:diskItem});
  const r=await runtime(event());assert.equal(r.statusCode,200);assert.equal(body(r).policies[0].id,'synthetic-write');
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('actual UI consumer paginates actual runtime/service/state responses',async()=>{
 const vm=await import('node:vm');
 const source=readFileSync(new URL('../../../console/public/modules/app.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function readHostedHitlPolicies(){');
 const code=source.slice(start,source.indexOf('\n}',start)+2);
 const {runtime,calls}=setup(catalog(Array.from({length:21},(_,i)=>policy('p-'+i))));
 const context=vm.createContext({Buffer,URLSearchParams,activeDomain:()=> 'platform',adminRead:async path=>{
  const url=new URL(path,'https://synthetic.invalid');
  const query=Object.fromEntries(url.searchParams);
  const r=await runtime(event({query:Object.keys(query).length?query:undefined}));
  return {...body(r),status:r.statusCode};
 }});
 vm.runInContext(code,context);
 const result=await context.readHostedHitlPolicies();
 assert.equal(result.ok,true);assert.equal(result.policies.length,21);assert.equal(result.cursor,null);
 assert.equal(result.policies[20].id,'p-20');assert.equal(calls.length,2);
});
