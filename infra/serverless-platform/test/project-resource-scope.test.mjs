import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceState } from '../lambda/workspace/state.mjs';
import { createWorkspaceService } from '../lambda/workspace/service.mjs';
import { createProjectResourceValidator } from '../lambda/workspace/project-resources.mjs';
import { createModelAccessResolver, createModelSelectionResolver } from '../lambda/model-governance/access.mjs';
import { validateProjectResourcePolicy, projectAllowsAgent } from '../../../console/public/project-resource-policy.mjs';
const identity={actor:'lead-sub',role:'lead',activeDomain:'finance',domainIds:['finance']};
const a={type:'Model',id:'gateway/model-a',registryId:null};
const b={type:'Model',id:'gateway/model-b',registryId:null};
function setup({legacy=false,catalogProvider}={}){
 const items=new Map();let writes=0;
 let domain={schemaVersion:1,domainId:'finance',operationId:'domain-finance',status:'ACTIVE',resources:[a,b]};
 const key=k=>JSON.stringify([k.pk.S,k.sk.S]);
 const dynamo={async send(command){
   const input=command.input;
   if(command.constructor.name==='GetItemCommand'){
     if(input.Key.pk.S==='GRANT#finance')return legacy?{}:{Item:{document:{S:JSON.stringify(domain)}}};
     const Item=items.get(key(input.Key));return Item?{Item}:{};
   }
   if(command.constructor.name==='TransactWriteItemsCommand'){
     writes++;for(const op of input.TransactItems)if(op.Put)items.set(key(op.Put.Item),structuredClone(op.Put.Item));return {};
   }
   if(command.constructor.name==='QueryCommand')return {Items:[]};
   throw new Error('Unexpected command '+command.constructor.name);
 }};
 const state=createWorkspaceState({dynamo,tableName:'platform-table',now:()=>new Date('2026-09-16T00:00:00.000Z')});
 const validator=createProjectResourceValidator({dynamo,tableName:'platform-table',catalogProvider});
 const service=createWorkspaceService({workspaceState:state,authorizer:async()=>true,projectResourceValidator:validator});
 return {service,state,validator,get domain(){return domain;},get writes(){return writes;}};
}
const request=(id,resources)=>({identity,requestId:'create-'+id,payload:{id,name:id,description:'Scope verification',resourcePolicy:{resources}}});
test('two hosted projects persist independent subsets of the same domain palette',async()=>{
 const f=setup();await f.service.createProject(request('project-a',[a]));await f.service.createProject(request('project-b',[b]));
 const pa=await f.state.getProject({domainId:'finance',projectId:'project-a'});
 const pb=await f.state.getProject({domainId:'finance',projectId:'project-b'});
 assert.deepEqual(pa.resourcePolicy,{resources:[a]});assert.deepEqual(pb.resourcePolicy,{resources:[b]});
 assert.equal(projectAllowsAgent(pa,{modelId:a.id}),true);assert.equal(projectAllowsAgent(pa,{modelId:b.id}),false);
 assert.equal(projectAllowsAgent(pb,{modelId:b.id}),true);assert.equal(projectAllowsAgent(pb,{modelId:a.id}),false);
});
test('project creation rejects resources outside the authoritative domain scope before any write',async()=>{
 for(const ref of [{...a,id:'gateway/not-allowed'},{...a,registryId:'different-registry'}]){
  const f=setup();await assert.rejects(f.service.createProject(request('forged',[ref])),{code:'FORBIDDEN'});assert.equal(f.writes,0);
 }
 const f=setup();f.domain.status='INITIALIZING';await assert.rejects(f.service.createProject(request('blocked',[a])),{code:'FORBIDDEN'});
});
test('project creation retry revalidates parent revocation',async()=>{
 const f=setup();const input=request('retry',[a]);await f.service.createProject(input);
 f.domain.resources=[b];await assert.rejects(f.service.createProject(input),{code:'FORBIDDEN'});assert.equal(f.writes,1);
});
test('catalog authorization permits draft selection without granting runtime access, and follows revocation',async()=>{
 const f=setup();const runtime=createModelAccessResolver({workspaceState:f.state,modelPolicyState:{getModelPolicy:async()=>null}});
 const selection=createModelSelectionResolver({workspaceState:f.state,modelAccessResolver:runtime});
 for(const modelId of [a.id,b.id]){assert.equal(await selection({domainId:'finance',modelId}),true);assert.equal(await runtime({domainId:'finance',modelId}),false);}
 f.domain.resources=[b];assert.equal(await selection({domainId:'finance',modelId:a.id}),false);
 assert.equal(await selection({domainId:'finance',modelId:b.id}),true);
});
test('project resource schemas reject duplicate, unknown and forged reference fields',()=>{
 assert.throws(()=>validateProjectResourcePolicy({resources:[a,a]}));
 assert.throws(()=>validateProjectResourcePolicy({resources:[{...a,approved:true}]}));
 assert.throws(()=>validateProjectResourcePolicy({resources:[{...a,type:'Admin'}]}));
 assert.throws(()=>validateProjectResourcePolicy({resources:[{...a,id:'bad\nvalue'}]}));
});

const catalogEntry=(ref,status='APPROVED')=>({type:ref.type,id:ref.id,domain:'shared',defaultVersion:'1.0.0',versions:[{semver:'1.0.0',status,content:{}}]});
test('legacy domain persists selected approved catalog subset and builder excludes omitted resources',async()=>{
 let entries=[catalogEntry(a),catalogEntry(b)];
 const f=setup({legacy:true,catalogProvider:async({domainId})=>{assert.equal(domainId,'finance');return {ok:true,entries};}});
 const input=request('legacy-selected',[a]);await f.service.createProject(input);
 const saved=await f.state.getProject({domainId:'finance',projectId:'legacy-selected'});
 assert.deepEqual(saved.resourcePolicy,{resources:[a]});
 assert.equal(projectAllowsAgent(saved,{modelId:a.id}),true);assert.equal(projectAllowsAgent(saved,{modelId:b.id}),false);
 entries=[catalogEntry(a,'IN_REVIEW'),catalogEntry(b)];
 await assert.rejects(f.service.createProject(input),{code:'FORBIDDEN'});assert.equal(f.writes,1);
});
test('legacy catalog rejects invented IDs, registry substitution, unapproved and foreign resources before writes',async()=>{
 const refs=[{...a,id:'invented'},{...a,registryId:'other'},b];
 for(const ref of refs){const f=setup({legacy:true,catalogProvider:async()=>({ok:true,entries:[catalogEntry(a),catalogEntry(b,'IN_REVIEW')]})});await assert.rejects(f.service.createProject(request('forged',[ref])),{code:'FORBIDDEN'});assert.equal(f.writes,0);}
 const f=setup({legacy:true,catalogProvider:async()=>({ok:true,entries:[{...catalogEntry(a),domain:'other'}]})});await assert.rejects(f.service.createProject(request('foreign',[a])),{code:'FORBIDDEN'});
});
test('legacy catalog failure never grants selection; empty subsets need no catalog access',async()=>{
 const f=setup({legacy:true,catalogProvider:async()=>{throw Error('unavailable')}});
 await assert.rejects(f.service.createProject(request('unavailable',[a])),{code:'WORKSPACE_UNAVAILABLE'});assert.equal(f.writes,0);
 await f.service.createProject(request('empty',[]));assert.equal(f.writes,1);
});

test('preflight authorizes without a duplicate catalog load; actual create revalidates before persistence',async()=>{
 let reads=0;const f=setup({legacy:true,catalogProvider:async()=>{reads++;return {ok:true,entries:[catalogEntry(a)]}}});
 const input=request('single-catalog',[a]);await f.service.preauthorizeProjectCreate(input);assert.equal(reads,0);assert.equal(f.writes,0);
 await f.service.createProject(input);assert.equal(reads,1);assert.equal(f.writes,1);
});
