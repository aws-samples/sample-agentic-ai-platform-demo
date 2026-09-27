// Synthetic regressions: execute actual app functions; no login, network or business writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {projectAllowsResource} from './public/project-resource-policy.mjs';
import {collectPagedItems} from './public/main-ui-compat.mjs';
import {readFileSync} from 'node:fs';
const source=readFileSync(process.env.ORDINARY_REPAIR_SOURCE||new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function extract(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.notEqual(start,-1,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const alpha={domainId:'domain_a',id:'alpha',name:'Alpha',status:'ACTIVE'};
const beta={...alpha,id:'beta',name:'Beta'};
function setup(){
  const box={innerHTML:''}; const controls=new Map(); const calls=[];
  const ctx=vm.createContext({projectAllowsResource,S:{hostedBuildProjects:[alpha,beta],hostedAccessProjects:[alpha,beta],hostedAccessDomains:[{id:'domain_a'}]},SESSION:{role:'lead'},activeDomain:()=> 'domain_a',
    document:{getElementById:id=>controls.get(id)||null,querySelectorAll:()=>[]},
    esc:v=>String(v??''),hostedResourceKey:a=>a?`${a.domainId}/${a.projectId}/${a.id}`:'',
    hostedBuildGovernedResources:()=>[],normalizeHostedBuildSelections:()=>({toolIds:[],mcpServerIds:[],skillIds:[],blueprintIds:[]}),hostedBuildOptions:()=>({}),hostedGuardrailChain:()=>[],
    hostedActionEnabled:()=>true,hostedCaps:()=>[],hostedAccessMemberRows:()=>'',
  });
  for(const n of ['hostedAccessDomainId','hostedAccessDomainProjects','hostedAccessSelectedProject','hostedAccessProjectPanel','hostedMembershipInput','hostedBuildModelsForDomain','hostedBuildForm'])vm.runInContext(extract(n),ctx);
  return {ctx,controls,box,calls};
}
test('BA-01 fresh Build inherits exact authorized Workspace selection',()=>{const {ctx}=setup();ctx.S.workspaceDomain='domain_a';ctx.S.workspaceProject='beta';assert.equal(ctx.hostedBuildForm().projectKey,'domain_a/beta');});
test('BA-01 removed Beta preserves draft identity without resolving Alpha',()=>{const {ctx}=setup();ctx.S.hostedBuildForm={projectKey:'domain_a/beta',name:'Beta draft'};ctx.S.hostedBuildProjects=[alpha];const form=ctx.hostedBuildForm();assert.equal(form.projectKey,'domain_a/beta');assert.equal(form.projectId,'');assert.equal(form.name,'Beta draft');});
test('BA-01 no history: zero and multiple require choice, single may default',()=>{const {ctx}=setup();assert.equal(ctx.hostedBuildForm().projectId,'');ctx.S.hostedBuildProjects=[];assert.equal(ctx.hostedBuildForm().projectId,'');ctx.S.hostedBuildProjects=[alpha];assert.equal(ctx.hostedBuildForm().projectId,'alpha');});
test('UA-01 removed project never retargets, selector remains and mutation input rejects',()=>{const {ctx,controls}=setup();ctx.S.hostedAccessProjectKey='domain_a/beta';ctx.S.hostedAccessProjects=[alpha];controls.set('haccessprojectusername',{value:'synthetic-user'});controls.set('haccessprojectreason',{value:'synthetic reason'});assert.equal(ctx.hostedAccessSelectedProject(),null);assert.match(ctx.hostedAccessProjectPanel(),/id="haccessproject"/);assert.equal(ctx.hostedMembershipInput('project'),null);});
test('UA-01 no history only defaults single exact-domain project',()=>{const {ctx}=setup();assert.equal(ctx.hostedAccessSelectedProject(),null);ctx.S.hostedAccessProjects=[alpha,{...alpha,domainId:'domain_b'}];assert.equal(ctx.hostedAccessSelectedProject().id,'alpha');});
function buildHarness(){
  const h=setup(),{ctx,controls,box,calls}=h;
  controls.set('hostedbuild',box);
  Object.assign(ctx,{wireHostedBuild:()=>{},applyDemoAssistToHostedView:()=>{},hostedBuildRegistryPublication:()=>null,hostedBuildPublicationCanSubmit:()=>false,hostedBuildResourcePicker:()=>'',hostedGuardrailChainHtml:()=>'',hostedStatus:v=>v,hostedDeliveryCard:()=>'',hostedNullableNumber:v=>v===''?null:Number(v),hostedReadGuardrailChain:()=>[],hostedIdList:v=>v,hostedCsv:v=>v?v.split(','):[],api:async(path,body)=>{calls.push({path,body});return {ok:false};},apiErrorMessage:()=> 'Synthetic rejection',createRequestId:()=> 'synthetic-request'});
  ctx.S.hostedBuildLoaded=true;ctx.S.hostedBuildJourney='blueprint';
  ctx.S.hostedBuildModels=[{id:'synthetic-model',access:{status:'ALLOWED',usable:true}}];ctx.S.hostedBuildCatalogModelIds=['synthetic-model'];
  for(const n of ['renderHostedBuild','readHostedBuildForm','hostedBuildPayload','runHostedBuildAction'])vm.runInContext(extract(n),ctx);
  for(const [id,value] of Object.entries({hbproject:'domain_a/beta',hbid:'synthetic-agent',hbname:'Beta draft',hbmodel:'synthetic-model',hbblueprint:'synthetic-blueprint',hbinstructions:'Synthetic instructions'}))controls.set(id,{value});
  return h;
}
test('BA-01 actual renderer disables removed draft; payload rejects until explicit new choice',async()=>{
  const {ctx,box,controls,calls}=buildHarness();
  ctx.S.hostedBuildForm={projectKey:'domain_a/beta',name:'Beta draft'};ctx.S.hostedBuildProjects=[alpha];
  ctx.renderHostedBuild();assert.match(box.innerHTML,/value="domain_a\/beta" selected/);assert.match(box.innerHTML,/id="hbcreate" disabled/);assert.match(box.innerHTML,/value="Beta draft"/);
  await ctx.runHostedBuildAction('createAgent');assert.equal(calls.length,0);assert.equal(ctx.S.hostedBuildForm.projectKey,'domain_a/beta');
  controls.get('hbproject').value='domain_a/alpha';await ctx.runHostedBuildAction('createAgent');assert.equal(calls.length,1);assert.equal(calls[0].body.domainId,'domain_a');assert.equal(calls[0].body.projectId,'alpha');assert.equal(calls[0].body.name,'Beta draft');
});
test('BA-01 foreign same-slug cannot resolve removed draft identity',()=>{const {ctx}=setup();ctx.S.hostedBuildForm={projectKey:'domain_a/beta',name:'Beta draft'};ctx.S.hostedBuildProjects=[{...beta,domainId:'domain_b'}];assert.equal(ctx.hostedBuildForm().projectId,'');});
function accessHarness(){
 const h=setup(),{ctx,box,controls,calls}=h;controls.set('hostedaccessadmin',box);
 Object.assign(ctx,{collectPagedItems,sessionEpoch:0,sessionEpochIsCurrent:e=>ctx.sessionEpoch===e,CANCELED_REQUEST:Symbol('cancel'),wireHostedAccessAdmin:()=>{},applyDemoAssistToHostedView:()=>{},apiErrorMessage:(r,f)=>r?.message||f,loadWorkspaceProjectPages:async()=>[alpha,beta],rawApi:()=>{},hostedRetryState:()=>{box.innerHTML='Inventory unavailable';}});
 ctx.S.hostedAccessProjectKey='domain_a/beta';ctx.S.hostedAccessTab='project';
 ctx.api=async path=>{calls.push(path);if(path==='/domains')return {ok:true,domains:[{id:'domain_a'}]};return {ok:true,domainId:'domain_a',...(path.includes('project-members')?{projectId:ctx.hostedAccessSelectedProject()?.id}:{}),items:[],cursor:null};};
 for(const n of ['hostedAccessMemberRows','hostedAccessDomainPanel','renderHostedAccessAdmin','loadHostedMemberPage','loadHostedMemberships','loadHostedAccessAdmin'])vm.runInContext(extract(n),ctx);
 if(source.includes('function hostedAccessMemberState('))vm.runInContext(extract('hostedAccessMemberState'),ctx);
 return h;
}
const member=name=>({username:name,subject:name,userStatus:'CONFIRMED',enabled:true});
test('UA-02 project failure keeps selector and successful domain data without unauthorized old project rows',async()=>{const {ctx,box}=accessHarness();ctx.S.hostedAccessProjectMembers=[member('old-private')];ctx.api=async path=>path.includes('project-members')?{ok:false,message:'Synthetic project denied'}:{ok:true,domainId:'domain_a',items:[member('healthy-domain')],cursor:null};await ctx.loadHostedMemberships();assert.match(box.innerHTML,/id="haccessproject"/);assert.match(box.innerHTML,/Synthetic project denied/);assert.doesNotMatch(box.innerHTML,/old-private/);assert.equal(ctx.S.hostedAccessProjectMembers.length,0);ctx.S.hostedAccessTab='domain';ctx.renderHostedAccessAdmin();assert.match(box.innerHTML,/healthy-domain/);assert.doesNotMatch(box.innerHTML,/Synthetic project denied/);});
test('UA-02 domain failure does not erase successful project data',async()=>{const {ctx,box}=accessHarness();ctx.api=async path=>path.includes('project-members')?{ok:true,domainId:'domain_a',projectId:'beta',items:[member('healthy-project')],cursor:null}:{ok:false,message:'Synthetic domain denied'};await ctx.loadHostedMemberships();assert.match(box.innerHTML,/healthy-project/);ctx.S.hostedAccessTab='domain';ctx.renderHostedAccessAdmin();assert.match(box.innerHTML,/Synthetic domain denied/);assert.doesNotMatch(box.innerHTML,/healthy-project/);});
test('UA-02 selector usable while project request pending; independent domain completes early',async()=>{const {ctx,box}=accessHarness();let release;ctx.api=async path=>path.includes('project-members')?await new Promise(r=>release=r):{ok:true,domainId:'domain_a',items:[member('healthy-domain')],cursor:null};const pending=ctx.loadHostedMemberships();await new Promise(r=>setImmediate(r));assert.match(box.innerHTML,/id="haccessproject"/);ctx.S.hostedAccessTab='domain';ctx.renderHostedAccessAdmin();assert.match(box.innerHTML,/healthy-domain/);release({ok:true,domainId:'domain_a',projectId:'beta',items:[],cursor:null});await pending;});
test('UA-03 Users & Access excludes the duplicate domain selector and agent entitlements',async()=>{const {ctx,box,calls}=accessHarness();ctx.S.hostedAccessTab='entitlement';await ctx.loadHostedAccessAdmin();assert.match(box.innerHTML,/Domain members/);assert.match(box.innerHTML,/Project members/);assert.doesNotMatch(box.innerHTML,/id="haccessdomain"|Agent entitlements|data-agent-entitlement/);assert.equal(calls.some(path=>path.includes('agent-entitlements')),false);});
test('UA-02 old project read cannot overwrite new successful choice',async()=>{const {ctx}=accessHarness();let release;const original=ctx.api;ctx.api=async path=>path.includes('project-members')&&path.includes('projectId=beta')?await new Promise(r=>release=r):original(path);const old=ctx.loadHostedMemberships();ctx.S.hostedAccessProjectKey='domain_a/alpha';await ctx.loadHostedMemberships();release({ok:true,domainId:'domain_a',projectId:'beta',items:[member('old-private')],cursor:null});await old;assert.equal(ctx.S.hostedAccessProjectMembers.length,0);assert.equal(ctx.S.hostedAccessProjectMembersScope,'domain_a/alpha');});
test('UA-01 repeated inventory refresh retains unavailable project identity',async()=>{const {ctx,box}=accessHarness();ctx.loadWorkspaceProjectPages=async()=>[alpha];await ctx.loadHostedAccessAdmin();await ctx.loadHostedAccessAdmin();assert.equal(ctx.S.hostedAccessProjectKey,'domain_a/beta');assert.equal(ctx.hostedAccessSelectedProject(),null);assert.match(box.innerHTML,/selected project is unavailable/);});
test('UA-01 actual project onchange honors dirty Cancel, retains target and draft, sends no requests',async()=>{
 const {ctx,controls,box,calls}=accessHarness();let prompts=0,clears=0;
 Object.assign(ctx,{businessForms:{clear:()=>clears++,isDirty:()=>true},domainBootstrapDirty:()=>false,projectBudgetDirty:()=>false,wizardDirty:{isDirty:()=>false},composeDirty:{isDirty:()=>false},composeDraft:()=>({}),confirm:()=>{prompts++;return false;},sessionTaskHandler:f=>f,runSessionTask:f=>f()});
 box.querySelectorAll=()=>[];box.querySelector=()=>null;controls.set('haccessproject',{value:'domain_a/alpha'});ctx.S.hostedAccessDraft='retained';
 for(const n of ['hasUnsavedContextChanges','confirmContextChange','wireHostedAccessAdmin'])vm.runInContext(extract(n),ctx);
 ctx.wireHostedAccessAdmin();await controls.get('haccessproject').onchange();assert.equal(prompts,1);assert.equal(clears,0);assert.equal(ctx.S.hostedAccessProjectKey,'domain_a/beta');assert.equal(controls.get('haccessproject').value,'domain_a/beta');assert.equal(ctx.S.hostedAccessDraft,'retained');assert.equal(calls.length,0);
});
test('UA-02 a domain Load more cannot cancel pending project success',async()=>{
 const {ctx}=accessHarness();let release;
 ctx.api=async path=>path.includes('project-members')?await new Promise(r=>release=r):{ok:true,domainId:'domain_a',items:[member(path.includes('cursor=')?'domain-next':'domain-first')],cursor:path.includes('cursor=')?null:'next'};
 const pending=ctx.loadHostedMemberships();await new Promise(r=>setImmediate(r));await ctx.loadHostedMemberships({more:'domain'});release({ok:true,domainId:'domain_a',projectId:'beta',items:[member('project-success')],cursor:null});await pending;
 assert.deepEqual(Array.from(ctx.S.hostedAccessDomainMembers,m=>m.username),['domain-first','domain-next']);assert.equal(ctx.S.hostedAccessProjectMembers[0].username,'project-success');
});
test('UA-02 single default project renders successful members without requiring stored key',async()=>{const {ctx,box}=accessHarness();ctx.S.hostedAccessProjectKey='';ctx.S.hostedAccessProjects=[alpha];ctx.api=async path=>({ok:true,domainId:'domain_a',...(path.includes('project-members')?{projectId:'alpha'}:{}),items:[member('single-success')],cursor:null});await ctx.loadHostedMemberships();assert.match(box.innerHTML,/single-success/);});
test('BA-01 rendered single default is bound before inventory changes',()=>{const {ctx}=buildHarness();ctx.S.hostedBuildProjects=[beta];ctx.renderHostedBuild();ctx.S.hostedBuildProjects=[alpha];assert.equal(ctx.hostedBuildForm().projectKey,'domain_a/beta');assert.equal(ctx.hostedBuildForm().projectId,'');});
test('BA-01 unavailable form read preserves hidden draft resource configuration',()=>{const {ctx}=buildHarness();ctx.S.hostedBuildProjects=[alpha];ctx.S.hostedBuildForm={projectKey:'domain_a/beta',modelId:'saved-model',toolIds:['saved-tool'],blueprintIds:['saved-blueprint'],buildOptions:{framework:'saved'},guardrailChain:[{id:'saved'}]};const form=ctx.readHostedBuildForm();assert.equal(form.projectId,'');assert.equal(form.modelId,'saved-model');assert.equal(form.toolIds[0],'saved-tool');assert.equal(form.blueprintIds[0],'saved-blueprint');assert.equal(form.guardrailChain[0].id,'saved');});
