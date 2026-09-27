import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootstrapModelGrant } from '../lambda/domain-bootstrap/model-access.mjs';
import { foundationCatalog } from '../../../console/public/domain-foundation-catalog.mjs';

function setup() {
  const inventory = {ok:true,entries:['gateway/model-a','gateway/model-b'].map(id=>({
    id,type:'Model',domain:'shared',defaultVersion:'1.0.0',versions:[{semver:'1.0.0',status:'APPROVED',
      content:{source:'agentcore-gateway',gatewayModelId:id}}]}))};
  const catalog=foundationCatalog(inventory);
  const operation={domainId:'finance',actor:{subject:'admin'},configuration:{blueprints:[],models:catalog.models.map(e=>e.ref),resources:[]},applied:{models:catalog.models}};
  const models={getModelPolicy:async()=>null};
  const grant=createBootstrapModelGrant({models,registry:async()=>inventory});
  return {inventory,operation,models,grant};
}
test('approved registered models can initialize catalog access with no runtime policies and no policy writes',async()=>{
  const f=setup();const result=await f.grant(f.operation);
  assert.equal(result.modelAccess.status,'CATALOG_ENABLED');
  assert.deepEqual(result.modelAccess.models.map(m=>m.modelId),['gateway/model-a','gateway/model-b']);
  assert.ok(result.modelAccess.models.every(m=>m.runtimeStatus==='CONFIGURATION_REQUIRED'));
  assert.deepEqual(await f.grant(f.operation),result);
});
test('discovered models awaiting platform approval cannot initialize catalog access',async()=>{
  const f=setup();
  f.inventory.entries.forEach(entry=>entry.versions[0].status='IN_REVIEW');
  assert.deepEqual(foundationCatalog(f.inventory).models,[]);
  await assert.rejects(f.grant(f.operation),{code:'REGISTRY_CHANGED'});
});
test('removed or explicitly revoked catalog models block initialization',async()=>{
  for(const revoke of [f=>f.inventory.entries.pop(),f=>f.inventory.entries[0].versions[0].status='DEPRECATED']){
    const f=setup();revoke(f);await assert.rejects(f.grant(f.operation),{code:'REGISTRY_CHANGED'});
  }
});
test('a discovered model must retain its authoritative Gateway identity',()=>{
  const f=setup();f.inventory.entries[0].versions[0].content.gatewayModelId='forged';
  assert.equal(foundationCatalog(f.inventory).models.length,1);
});
test('runtime readiness is only reported when the existing policy authorizes this domain',async()=>{
  const f=setup();f.models.getModelPolicy=async({modelId})=>({modelId,allowedDomains:['finance'],requestableDomains:[],
    limits:{requestsPerMinute:60,tokensPerMinute:10000,connectionsPerSecond:4},revision:1,applicationStatus:'ACTIVE',
    rateLimit:{id:'existing',status:'ACTIVE',reason:null,reconciledAt:'2026-09-16T00:00:00.000Z'},
    updatedBySubject:'admin',updatedAt:'2026-09-16T00:00:00.000Z'});
  assert.ok((await f.grant(f.operation)).modelAccess.models.every(m=>m.runtimeStatus==='READY'));
});
