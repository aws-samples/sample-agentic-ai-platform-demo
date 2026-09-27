// SYNTHETIC OFFLINE PREVIEW. Fresh Chromium context; actual app assets.
// All requests intercepted. No dev tabs, real identity or business writes.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {projectEffectiveIdentity} from '../infra/serverless-platform/lambda/api/identity.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture,signIn,navigate,poll,unexpected,errors} from './approved-ui-integration.mjs';
const output=path.resolve(process.argv[2]);await mkdir(output,{recursive:true});
const checks=[],reads=[],writes=[];let mode='404';
const row=(id,kind,resourceType)=>({id,kind,resourceType,resourceId:'test-resource',domainId:'platform',projectId:null,status:'PENDING',requesterSubject:'different-synthetic-reviewer',requestedAt:'2026-09-01T00:00:00Z',approverSubject:null,reason:null,decidedAt:null});
const browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.P1_CHROMIUM_EXECUTABLE?{executablePath:process.env.P1_CHROMIUM_EXECUTABLE}:{})});
try{
 const width=Number(process.env.P1_VIEWPORT_WIDTH||1440);assert.ok([390,1440].includes(width));
 const f=await fixture('admin',{viewport:{width,height:1000}},browser);f.state.canSwitch=false;
 await f.context.route('https://console.test/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  if(req.method()!=='GET'){writes.push(p);return route.abort();}
  reads.push(p+url.search);
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(p==='/api/me')return json({...projectEffectiveIdentity({sub:'synthetic-operator',name:'Synthetic Operator','cognito:groups':['platform-admin']},{},{demoOperatorAuthorized:false}),availableDemoDomains:[]});
  if(p==='/api/approvals')return json({ok:true,resource:'approvals',items:[row('synthetic-access','RESOURCE_ACCESS','MEMORY'),row('synthetic-blueprint','RESOURCE_PUBLICATION','BLUEPRINT')],cursor:null});
  if(['/api/hitl','/api/alerts','/api/memories','/api/kb-docs','/api/policy-exemptions'].includes(p)){
   if(mode==='empty')return json(p==='/api/hitl'?{ok:true,schemaVersion:1,revision:1,domainId:'platform',updatedAt:'2026-09-12T08:00:00.000Z',source:'workspace-hitl-policy-catalog',enforcement:'NOT_CONFIGURED',policies:[],cursor:null}:{ok:true,policies:[],memories:[],docs:[],exemptions:[]});
   if(mode==='malformed')return json({ok:true,policies:{},memories:{},docs:{},exemptions:{}});
   if(mode==='403')return json({ok:false,code:'FORBIDDEN'},403);
   if(mode==='unconfigured')return json({ok:false,code:'NOT_CONFIGURED'},503);
   return json({message:'Not Found'},404);
  }
  return route.fallback();
 });
 async function tab(name){await f.page.locator(`[data-tab="${name}"]`).click();}
 async function state(selector,value){await poll(async()=>!!await f.page.locator(`${selector} [data-read-state="${value}"]`).count(),`${selector} ${value}`);}
 async function shot(name){assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no document overflow: '+name);await f.page.screenshot({path:path.join(output,name+'.png'),fullPage:true});await writeFile(path.join(output,name+'.txt'),'SYNTHETIC OFFLINE PREVIEW, NOT LIVE\n'+await f.page.locator('#main').innerText());}
 await signIn(f);await navigate(f.page,'governance');await tab('policies');await state('#hitlpolicies','error');
 assert.equal(await f.page.locator('#hifire,.drpromote').count(),0);assert.equal(await f.page.locator('#hpcreate').isDisabled(),true);assert.doesNotMatch(await f.page.locator('#govtabpanel').innerText(),/of last 1,000|Promote to enforce|Demo an interrupt/);await shot('policies-404');checks.push('P1-A actual hosted render: no demo counts, no promotion/interrupt, honest missing contract');
 mode='empty';await f.page.locator('#hitlpolicies [data-admin-retry]').click();await poll(async()=>/No approval policies returned by the configured source/.test(await f.page.locator('#hitlpolicies').innerText()),'retry reaches true empty');checks.push('P1-C user retry GET reaches authoritative empty');
 await f.page.locator('#hitlpolicies button').click();await poll(async()=>/No approval policies returned by the configured source/.test(await f.page.locator('#hitlpolicies').innerText()),'refresh preserves authoritative empty');checks.push('Configured-empty policy read refresh preserves provenance');
 for(const [m,s] of [['404','error'],['403','forbidden'],['unconfigured','unconfigured'],['malformed','error']]){
  mode=m;await tab('alerts');await state('#alertpolicies',s);await state('#alertraci',s);assert.doesNotMatch(await f.page.locator('#alertpolicies').innerText(),/0 alert policies/);await shot('alerts-'+m);await tab('policies');
 }
 checks.push('P1-C Alerts and RACI: 404, 403, unconfigured and malformed inputs never zero');
 mode='404';await tab('requests');await poll(async()=>/synthetic-access/.test(await f.page.locator('#reqinbox').innerText()),'native access records');assert.doesNotMatch(await f.page.locator('#reqinbox').innerText(),/synthetic-blueprint/);await shot('access-requests');
 await tab('exemptions');await state('#apxlist','error');await poll(async()=>/synthetic-blueprint/.test(await f.page.locator('#bpsublist').innerText()),'native blueprint records');await shot('platform-approvals');checks.push('P1-B existing approval rows render separately; policy exemption 404 stays error');
 await tab('rbac');assert.match(await f.page.locator('#govtabpanel').innerText(),/Roles and permissions/i);assert.match(await f.page.locator('#govtabpanel').innerText(),/Platform Admin is not a domain-wide override/);assert.doesNotMatch(await f.page.locator('#govtabpanel').innerText(),/Author approval \(HITL\) policies/);await shot('rbac');checks.push('RBAC actual tab has scoped task summary, no false policy authoring or admin override');
 await f.page.reload();await poll(async()=>await f.page.locator('#main').count()===1,'read-only page reload');await navigate(f.page,'governance');await tab('rbac');assert.match(await f.page.locator('#govtabpanel').innerText(),/Roles and permissions/i);checks.push('Browser refresh preserves usable authenticated synthetic navigation');
 if(width===390)await f.page.locator('.gov-site-nav-toggle').click();
 await navigate(f.page,'bwmemorykb');await state('#wsbody','error');assert.doesNotMatch(await f.page.locator('#wsbody').innerText(),/No memory stores|No KB documents/);await shot('memory-kb-404');checks.push('P1-C actual project Memory/KB renderer shows independent source errors');
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 assert.equal(reads.some(p=>p.startsWith('/api/grant-requests')),false);
 await writeFile(path.join(output,'browser-result.json'),JSON.stringify({status:'PASS',evidence:'SYNTHETIC OFFLINE PREVIEW NOT LIVE',runtime:process.version,browser:browser.version(),viewport:{width,height:1000},checks,reads,writes,errors,unexpected},null,2));console.log(JSON.stringify({status:'PASS',checks,writes,errors}));
 await f.context.close();
}finally{await browser.close();}
