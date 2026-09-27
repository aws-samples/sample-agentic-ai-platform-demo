import test from 'node:test';
import assert from 'node:assert/strict';
import {builderModelCatalog} from './public/builder-model-catalog.mjs';
import {projectAllowsResource} from './public/project-resource-policy.mjs';
const entry=id=>({id,name:id,domain:'shared',type:'Model',defaultVersion:'1',versions:[{semver:'1',status:'APPROVED',content:{}}]});
const model=(id,domain='support')=>({id,accessByDomain:{[domain]:{status:'ALLOWED',usable:true}}});
test('builder uses registered + exact domain access + project subset, never Gateway inventory alone',()=>{
 const registry={ok:true,entries:[entry('one'),entry('two'),entry('foreign'),entry('unconfigured')]};
 const gateway={ok:true,models:[model('one'),model('two'),model('foreign','operations'),model('not-registered')]};
 const options=builderModelCatalog(registry,gateway,'support');assert.deepEqual(options.map(m=>m.id),['one','two']);
 const project={resourcePolicy:{resources:[{type:'Model',id:'two',registryId:null}]}};
 assert.deepEqual(options.filter(m=>projectAllowsResource(project,'Model',m.id)).map(m=>m.id),['two']);
});
for(const problem of ['outage','wrong-domain','duplicate','denied','pending','unusable','missing-scope'])test(`model access ${problem} cannot populate Generate options`,()=>{
 const registry={ok:true,entries:[entry('one')]},gateway={ok:true,domainId:'support',models:[{id:'one',access:{status:'ALLOWED',usable:true}}]};
 if(problem==='outage')gateway.ok=false;
 if(problem==='wrong-domain')gateway.domainId='operations';
 if(problem==='duplicate')gateway.models.push(structuredClone(gateway.models[0]));
 if(problem==='denied')gateway.models[0].access.status='DENIED';
 if(problem==='pending')gateway.models[0].access.status='PENDING';
 if(problem==='unusable')gateway.models[0].access.usable=false;
 if(problem==='missing-scope')delete gateway.domainId;
 assert.deepEqual(builderModelCatalog(registry,gateway,'support'),[]);
});
test('retired/unapproved Registry records cannot be admitted by a runtime grant',()=>{
 const registry={ok:true,entries:[entry('one')]};registry.entries[0].versions[0].status='REJECTED';
 assert.deepEqual(builderModelCatalog(registry,{ok:true,models:[model('one')]},'support'),[]);
});
