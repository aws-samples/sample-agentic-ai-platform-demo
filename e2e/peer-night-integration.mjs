// TEST MOCKS NOT LIVE: actual application, offline HTTP interception only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, signIn, navigate, ready, poll, errors, unexpected } from './approved-ui-integration.mjs';
assert.match(process.version,/^v22\./);
const output=path.resolve(process.argv[2]);await mkdir(output,{recursive:true});
const checks=[],failures=[],shots=[];
const browser=await chromium.launch({headless:true,chromiumSandbox:true});
const native={id:'native-skill',name:'Synthetic native skill',type:'Skill',domain:'platform',_source:'agentcore-registry',_registryId:'SyntheticReg1',defaultVersion:'1.0.0',versions:[{semver:'1.0.0',status:'IN_REVIEW',createdAt:'2026-09-11T00:00:00.000Z',_aws:{registryId:'SyntheticReg1',recordId:'SyntheticRec',awsStatus:'PENDING_APPROVAL'}}]};
const model={id:'synthetic-model',name:'Synthetic Gateway model',type:'Model',domain:'shared',_source:'gateway',defaultVersion:'1.0.0',versions:[{semver:'1.0.0',status:'IN_REVIEW',content:{},createdAt:'2026-09-11T00:00:00.000Z'}]};
async function shot(f,name){
 await f.page.evaluate(()=>{let marker=document.querySelector('[data-night-label]');if(!marker){marker=document.createElement('p');marker.dataset.nightLabel='';marker.textContent='TEST MOCKS NOT LIVE';marker.style.cssText='display:block;position:relative;padding:12px;background:#fff4cc;color:#111;pointer-events:none';document.body.append(marker)}});
 await f.page.screenshot({path:path.join(output,name+'.png'),fullPage:true});shots.push(name+'.png');
 await writeFile(path.join(output,name+'.txt'),'TEST MOCKS NOT LIVE\n'+await f.page.locator('#main').innerText());
}
async function check(name,work){try{await work();checks.push(name);console.log('PASS',name)}catch(e){failures.push({name,error:e.stack});console.error('FAIL',name,e.message)}}
async function setup(role='admin',canDecide=true,initial={}){
 const f=await fixture(role,{},browser);f.entries=structuredClone([model,native]);f.writes=[];f.approvals=[];f.gatewayRequests=0;Object.assign(f,initial);
 await f.context.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),resource=url.pathname.slice(5);
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(resource==='me'){
   const active=req.headers()['x-demo-role']||role,domain=req.headers()['x-active-domain']||'domain_a';
   return json({ok:true,user:'synthetic-operator',name:'Synthetic Operator',authenticatedRole:'admin',role:active,domain:active==='admin'?null:domain,domains:active==='admin'?['platform','domain_a','domain_b']:[domain],capabilities:[...(active==='admin'?['viewPlatformInventory','viewPlatformCost','viewPlatformOperations','usePlatformBuilderWorkspace','approvePlatformPublication']:['viewDomainInventory','viewDomainRegistry','viewAssignedProjects','createDomainProject','createAgent','requestModelAccess','approveDomainPublication']),...(canDecide?['approveRegistryVersion']:[])],demoRoleActive:true,canSwitchDemoRole:true,availableDemoRoles:['admin','lead','builder','user'],availableDemoDomains:[{id:'domain_a',name:'Synthetic A'},{id:'domain_b',name:'Synthetic B'}]});
  }
  if(resource==='registry')return json({ok:true,source:'aws',entries:f.entries});
  if(resource==='approvals')return json({ok:true,resource:'approvals',items:f.approvals,cursor:null});
  if(resource==='registry-decide'){
   const body=JSON.parse(req.postData());f.writes.push({resource,body});
   const entry=f.entries.find(e=>e.id===body.id),v=entry.versions.find(v=>v.semver===body.semver);v.status=body.decision==='approve'?'APPROVED':'REJECTED';v._aws.awsStatus=v.status;
   return json({ok:true,version:{id:body.id,semver:body.semver,status:v.status,_aws:v._aws}});
  }
  if(resource==='governance/publication-decisions'){f.writes.push({resource,body:JSON.parse(req.postData())});return json({ok:true})}
  if(resource==='ai-gateway')return json({ok:true,source:'aws',domainId:'domain_a',models:[{id:f.gatewayOther?'other-model':model.id,name:'Synthetic Gateway model',description:'Synthetic requestable model',provider:'Synthetic provider',access:{status:f.gatewayRequests?'PENDING':'REQUESTABLE',usable:false,requestable:true,latestRequest:f.gatewayRequests?{id:'model-request',status:'PENDING',requestedAt:'2026-09-11T00:00:00.000Z'}:null,grant:null,limits:null,rateLimit:null}}]});
  if(resource==='ai-gateway/model-access-requests'){f.gatewayRequests++;f.writes.push({resource,body:JSON.parse(req.postData())});return json({ok:true})}
  return route.fallback();
 });
 await signIn(f);return f;
}
try{
 await check('Registry search and project filter browsing cause zero discard prompts',async()=>{
  const f=await setup();await navigate(f.page,'registry');await ready(f.page,'.regrow');
  await f.page.locator('#regsearch').fill('Synthetic');await poll(async()=>await f.page.locator('.regrow').count()===2,'search results');
  await navigate(f.page,'cost');assert.equal(f.state.dialogs.filter(d=>d.type==='confirm').length,0);
  await shot(f,'normal-browsing');await f.context.close();
 });
 await check('Gateway projection drawer and queue are read-only; missing identity cannot approve',async()=>{
  const f=await setup();f.entries.push({...structuredClone(native),id:'missing-id',name:'Missing identity',versions:[{...native.versions[0],_aws:null}]});
  await navigate(f.page,'registry');await f.page.locator('[data-regid="synthetic-model"]').click();
  assert.equal(await f.page.locator('.regapprove,.regreject').count(),0);assert.match(await f.page.locator('#regdrawerwrap').innerText(),/Discovery is not/);
  await shot(f,'gateway-read-only');await navigate(f.page,'governance');await ready(f.page,'#govqueue');
  assert.equal(await f.page.locator('[data-queue="reg-synthetic-model-1.0.0"] .qreg').count(),0);
  assert.equal(await f.page.locator('[data-queue="reg-missing-id-1.0.0"] .qreg').count(),0);
  assert.equal(await f.page.locator('[data-queue="reg-native-skill-1.0.0"] .qreg').count(),2);
  assert.equal(f.writes.length,0);await shot(f,'mixed-queue');await f.context.close();
 });
 await check('native pending drawer positive approval and stale record replacement negative',async()=>{
  const f=await setup();await navigate(f.page,'registry');await f.page.locator('[data-regid="native-skill"]').click();await f.page.locator('.regapprove').click();
  await poll(()=>f.writes.length===1,'native decision written');assert.equal(f.writes[0].resource,'registry-decide');
  assert.deepEqual(Object.keys(f.writes[0].body).sort(),['decision','id','reason','semver']);
  await f.context.close();
  const stale=await setup();await navigate(stale.page,'registry');await stale.page.locator('[data-regid="native-skill"]').click();
  stale.entries[1].versions[0]._aws.recordId='OtherRecord1';await stale.page.locator('.regapprove').click();
  await poll(()=>stale.state.dialogs.some(d=>d.type==='alert'),'stale warning');assert.equal(stale.writes.length,0);await shot(stale,'stale-record');await stale.context.close();
 });
 await check('negative capability and forged provenance never enable approval',async()=>{
  const f=await setup('builder',false);f.entries[1]._source='gateway';
  await navigate(f.page,'registry');await f.page.locator('[data-regid="native-skill"]').click();assert.equal(await f.page.locator('.regapprove').count(),0);
  await f.page.locator('[data-regid="native-skill"]').click();assert.equal(await f.page.locator('.regapprove').count(),0);assert.equal(f.writes.length,0);await f.context.close();
 });
 await check('legitimate Gateway request uses exact model identity, never Registry writer',async()=>{
  const f=await setup('builder',false);await navigate(f.page,'registry');await f.page.locator('[data-regid="synthetic-model"]').click();await f.page.locator('#registrygatewayopen').click();
  await ready(f.page,'#hostedgatewayrequest');await f.page.locator('#hostedgatewayrequest').click();await poll(()=>f.gatewayRequests===1,'request written');
  assert.equal(f.writes[0].resource,'ai-gateway/model-access-requests');assert.equal(f.writes[0].body.modelId,model.id);await shot(f,'gateway-request');await f.context.close();
  const missing=await setup('builder',false);missing.gatewayOther=true;await navigate(missing.page,'registry');await missing.page.locator('[data-regid="synthetic-model"]').click();await missing.page.locator('#registrygatewayopen').click();
  await poll(async()=>/not present/.test(await missing.page.locator('#registrygatewaypanel').innerText()),'identity absence visible');assert.equal(await missing.page.locator('#hostedgatewayrequest').count(),0);assert.equal(missing.writes.length,0);await missing.context.close();
 });
 await check('native publication uses exact pending approval and independent reviewer, not Registry writer',async()=>{
  for(const own of [false,true]){
   const approval={id:'publication-one',kind:'RESOURCE_PUBLICATION',resourceType:'AGENT',resourceId:'SyntheticReg1/SyntheticRec',domainId:'platform',status:'PENDING',requesterSubject:own?'synthetic-operator':'different-subject'};
   const f=await setup('admin',false,{entries:[{...structuredClone(native),type:'Agent',id:'native-agent'}],approvals:[approval]});
   await navigate(f.page,'cost');await navigate(f.page,'registry');await f.page.locator('[data-regid="native-agent"]').click();
   assert.equal(await f.page.locator('.regapprove').count(),own?0:1);
   if(!own){await f.page.locator('.regapprove').click();await poll(()=>f.writes.length===1,'publication decision');assert.equal(f.writes[0].resource,'governance/publication-decisions');assert.equal(f.writes[0].body.approvalId,approval.id)}
   else assert.equal(f.writes.length,0);
   await f.context.close();
  }
 });
 await check('async membership form baseline, failed save retains reason, successful save clears dirty',async()=>{
  const f=await fixture('lead',{},browser);await signIn(f);await navigate(f.page,'users');await ready(f.page,'#haccessdomainusername');
  const dialogs=f.state.dialogs.length;await navigate(f.page,'bwfleet');assert.equal(f.state.dialogs.length,dialogs);
  await navigate(f.page,'users');await ready(f.page,'#haccessdomainusername');await f.page.locator('#haccessdomainusername').fill('new-member');await f.page.locator('#haccessdomainreason').fill('Manual business reason');
  let fail=true;
  await f.context.route('**/api/access/domain-memberships',async route=>{
    const body=JSON.parse(route.request().postData());
    if(!fail)f.state.domainMembers.push({username:body.username,subject:'synthetic-member',userStatus:'CONFIRMED',enabled:true});
    await route.fulfill({status:fail?403:201,contentType:'application/json',body:JSON.stringify(fail?{ok:false,code:'FORBIDDEN'}:{ok:true,...body,status:'ACTIVE',subject:'synthetic-member'})});
  });
  await f.page.locator('#haccessdomaingrant').click();await poll(async()=>/FORBIDDEN/.test(await f.page.locator('#hostedaccessadmin').innerText()),'failed membership visible');
  assert.equal(await f.page.locator('#haccessdomainreason').inputValue(),'Manual business reason');
  await f.page.locator('#tbrole').selectOption('builder');assert.equal(await f.page.locator('#tbrole').inputValue(),'lead');
  fail=false;await f.page.locator('#haccessdomaingrant').click();await ready(f.page,'[data-domain-member="new-member"]');
  const before=f.state.dialogs.length;await navigate(f.page,'bwfleet');assert.equal(f.state.dialogs.length,before);await f.context.close();
 });
 await check('untouched wizard cancels cleanly; manual draft blocks role change and failed create stays protected',async()=>{
  const f=await fixture('lead',{},browser);await signIn(f);await navigate(f.page,'projects');await ready(f.page,'#dcprojgo');await f.page.locator('#dcprojgo').click();await ready(f.page,'#wcancel');
  await f.page.locator('#wcancel').click();assert.equal(f.state.dialogs.length,0);
  await f.page.locator('#dcprojgo').click();await ready(f.page,'[data-wtpl]');await f.page.locator('[data-wtpl]').click();await f.page.locator('#wnext').click();await f.page.locator('#wid').fill('new-project');await f.page.locator('#wname').fill('Manual draft');
  await f.page.locator('#tbrole').selectOption('builder');assert.equal(await f.page.locator('#tbrole').inputValue(),'lead');assert.equal(await f.page.locator('#wname').inputValue(),'Manual draft');
  await f.context.route('**/api/projects',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,code:'UNAVAILABLE'})}):route.fallback());
  for(let i=0;i<4;i++)await f.page.locator('#wnext').click();await f.page.locator('#wcreate').click();await poll(async()=>/UNAVAILABLE/.test(await f.page.locator('#wizstatus').innerText()),'failure visible');
  const n=f.state.dialogs.length;await f.page.locator('#wcancel').click();assert.equal(f.state.dialogs.length,n+1);assert.equal(await f.page.locator('#wcreate').count(),1);await shot(f,'failed-wizard-protected');await f.context.close();
 });
 assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
}catch(e){failures.push({name:'runner',error:e.stack})}
finally{await browser.close();await writeFile(path.join(output,'browser-results.json'),JSON.stringify({offlineOnly:true,node:process.version,checks,passed:checks.length,failures,screenshots:shots,unexpected,errors},null,2));if(failures.length)process.exitCode=1}
