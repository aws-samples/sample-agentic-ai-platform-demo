// TEST MOCKS NOT LIVE. Actual app assets, existing transport fixture and backend identity projection.
// No business writes or external requests allowed. Browser sandbox remains enabled.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fixture,signIn,navigate,poll,loaded,unexpected,errors } from './approved-ui-integration.mjs';
import { projectEffectiveIdentity } from '../infra/serverless-platform/lambda/api/identity.mjs';
assert.equal(process.version,'v22.23.2');
const output=path.resolve(process.argv[2]);await mkdir(output,{recursive:true});
const baseline=process.argv[3]&&path.resolve(process.argv[3]);
const publicRoot=path.resolve('console/public');
const stamp='2026-09-01T00:00:00.000Z';
const discovery={id:'test-gateway/model',type:'Model',name:'TEST ONLY discovered model',domain:'shared',_source:'gateway',defaultVersion:'1.0.0',versions:[{semver:'1.0.0',status:'IN_REVIEW',createdAt:stamp,createdBy:'gateway',content:{gatewayModelId:'test-gateway/model',runtimeModelId:'test-runtime',source:'agentcore-gateway'}}]};
const native={id:'test-skill',type:'Skill',name:'TEST ONLY native skill',domain:'platform',_source:'agentcore-registry',_registryId:'SyntheticReg1',versions:[{semver:'1.0.0',status:'IN_REVIEW',createdAt:stamp,_aws:{registryId:'SyntheticReg1',recordId:'SyntheticRec',awsStatus:'PENDING_APPROVAL'}}]};
const access=(id,extra={})=>({id,domainId:'platform',kind:'RESOURCE_ACCESS',resourceType:'MODEL',resourceId:'test-gateway/model',projectId:null,status:'PENDING',requesterSubject:'different-test-person',requestedAt:stamp,...extra});
const checks=[],screenshots=[],writes=[],browser=await chromium.launch({headless:true,chromiumSandbox:true});
async function setup(root,entries,items,mode='ok'){
 const f=await fixture('admin',{},browser,root);
 await f.context.route('https://console.test/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),resource=url.pathname.slice(5);
  const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  if(req.method()!=='GET'){writes.push(resource);return route.abort();}
  if(resource==='me')return json({...projectEffectiveIdentity({sub:'test-admin',name:'Test Admin','cognito:groups':['platform-admin']},{},{demoOperatorAuthorized:false}),availableDemoDomains:[]});
  if(resource==='registry')return json({ok:true,source:'aws',entries});
  if(resource==='approvals')return json(mode==='missing-cursor'?{ok:true,resource:'approvals',items}:mode==='error'?{ok:false,code:'UNAVAILABLE'}:{ok:true,resource:'approvals',items,cursor:null});
  if(resource==='blueprint-submissions')return json({ok:true,submissions:[]});
  return route.fallback();
 });
 await signIn(f);await navigate(f.page,'governance');await poll(async()=>!await f.page.locator('#govqueue .spin').count(),'queue settled');return f;
}
async function shot(f,name){await f.page.screenshot({path:path.join(output,name+'.png'),fullPage:true});await writeFile(path.join(output,name+'.txt'),'TEST MOCKS NOT LIVE\n'+await f.page.locator('#main').innerText());screenshots.push(name+'.png');}
async function compliance(f){await f.page.locator('[data-tab="compliance"]').click();await poll(async()=>!await f.page.locator('#gcompliance .spin').count(),'compliance settled');}
try{
 if(baseline){const f=await setup(baseline,[discovery],[]);try{assert.equal(await f.page.locator('#govqueue [data-queue]').count(),1);await shot(f,'before-discovery-queue');await compliance(f);assert.match(await f.page.locator('#gcompsla').innerText(),/TEST ONLY discovered model/);await shot(f,'before-discovery-oldest');checks.push('baseline actual rendering reproduces false discovery row and oldest');}finally{await f.context.close();}}
 for(const [name,entries,items,count,mode] of [
  ['discovery',[discovery],[],0],
  ['model-access',[discovery],[access('test-model-access'),access('test-second-access')],2],
  ['linked',[discovery,native],[access('test-publication',{kind:'RESOURCE_PUBLICATION',resourceType:'SKILL',resourceId:'SyntheticReg1/SyntheticRec'}),access('test-model-access')],2],
  ['unknown-date',[discovery],[access('test-no-date',{requestedAt:null})],1],
  ['incomplete',[discovery],[],null,'missing-cursor'],
 ]){
  const f=await setup(publicRoot,entries,items,mode);
  try{
   assert.equal(await f.page.locator('#govqueue [data-pending-count]').getAttribute('data-pending-count'),count===null?'unknown':String(count));
   assert.equal(await f.page.locator('#govqueue [data-queue^="reg-"]').count(),0);
   if(name==='model-access'){const queue=await f.page.locator('#govqueue').innerText();assert.match(queue,/test-model-access/);assert.match(queue,/test-second-access/);assert.match(queue,/RESOURCE_ACCESS/);assert.match(queue,/MODEL/);assert.equal(await f.page.locator('#govqueue .qreg').count(),0); /* Admin does not gain the domain model-access capability. Existing actual-app route tests exercise an eligible reviewer. */}
   await shot(f,'after-'+name+'-queue');await compliance(f);
   assert.equal(await f.page.locator('#gcompliance [data-pending-count]').getAttribute('data-pending-count'),count===null?'unknown':String(count));
   const text=await f.page.locator('#gcompsla').innerText();
   assert.doesNotMatch(text,/TEST ONLY discovered model|NaN/);
   if(count===0)assert.match(text,/Nothing is waiting/);
   if(count===null)assert.match(text,/unknown|incomplete/i);
   if(name==='unknown-date')assert.match(text,/1 pending submission date\(s\) unknown/);
   await shot(f,'after-'+name+'-oldest');checks.push(name+': actual queue/count/oldest agree');
  }finally{await f.context.close();}
 }
 assert.deepEqual(writes,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 const hashes={};for(const file of ['modules/app.mjs','pending-work.mjs'])hashes[file]=createHash('sha256').update(await readFile(path.join(publicRoot,file))).digest('hex');
 await writeFile(path.join(output,'browser-result.json'),JSON.stringify({status:'PASS',evidence:'TEST MOCKS NOT LIVE',runtime:process.version,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['write-tree'],{encoding:'utf8'}).trim(),sourceHashes:hashes,checks,screenshots,writes,errors,unexpected,loaded:[...loaded]},null,2));
 console.log(JSON.stringify({status:'PASS',checks,screenshots:screenshots.length,writes:writes.length,errors:errors.length}));
}finally{await browser.close();}
