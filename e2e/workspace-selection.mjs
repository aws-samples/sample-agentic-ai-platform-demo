// SYNTHETIC ONLY: actual renderer + production server identity projector; no live requests.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { projectEffectiveIdentity } from '../infra/serverless-platform/lambda/api/identity.mjs';
import { fixture, signIn, navigate, ready, poll, project, requests, errors, unexpected, loaded } from './approved-ui-integration.mjs';
const output = pathToFileURL(path.resolve(process.argv[2] || '/private/tmp/workspace-selection-evidence') + '/');
await mkdir(output, {recursive:true});
const results=[], coverage=[];
const browser = await chromium.launch({headless:true, chromiumSandbox:true});
async function check(name, work) {try {await work(); results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.message});console.log('FAIL',name,e.message);}}
async function setup(role,count=1,mode='ok') {
 const f=await fixture(role,{},browser); f.state.canSwitch=false;
 const domain=role==='admin'?'platform':'domain_a';f.state.domain=domain;f.state.projectsMode=mode;f.identitySubject='synthetic-'+role;
 f.state.projects=[project(domain),{...project(domain),id:'second',name:'Synthetic second project'}].slice(0,count);
 // Defense-in-depth: actual renderer must exclude a foreign pair even if test inventory contains it.
 f.state.projects.push({...project('domain_b'),name:'Synthetic foreign project'});
 await f.context.route('https://console.test/api/me',async route=>{
   const claims={sub:f.identitySubject,name:'Synthetic '+role,'cognito:groups':[({admin:'platform-admin',lead:'domain-lead',builder:'domain-builder',user:'end-user'})[role],'domain-'+f.state.domain.replaceAll('_','-')]};
   const profile=projectEffectiveIdentity(claims,route.request().headers(),{demoOperatorAuthorized:false});
   await route.fulfill({contentType:'application/json',body:JSON.stringify({...profile,availableDemoDomains:[]})});
 });
 await signIn(f);return f;
}
try {
 for(const role of ['admin','lead','builder','user']) {
  const f=await setup(role);
  try {
   await check(role+' server-derived identity and ordinary navigation',async()=>{
    assert.equal(await f.page.locator('#tbrole,#tbdomain').count(),0);
    const nav=await f.page.locator('[data-shellnav]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.shellnav,label:n.textContent.trim()})));
    for(const item of nav)coverage.push({role,...item,status:'UNREVIEWED',tabs:[],scope:'navigation inventory only'});
    assert.ok(nav.length);
   });
   for(const row of coverage.filter(r=>r.role===role)) {
    await check(role+' page '+row.id,async()=>{
     await navigate(f.page,row.id);
     row.heading=await f.page.locator('#main h1').allTextContents();
     row.tabs=await f.page.locator('#main [role=tab],#main [data-workspace-obs-tab],#main [data-govtab],#main [data-regtab],#main [data-access-tab]').evaluateAll(nodes=>nodes.map(n=>({label:n.textContent.trim(),status:'UNREVIEWED'})));
     row.status='RENDER_CHECKED';row.scope='Actual renderer navigation only; actions/data/visual/live not accepted';
     row.text=(await f.page.locator('#main').innerText()).slice(0,1800);
    });
   }
  }finally{await f.context.close();}
 }
 for(const role of ['admin','lead','builder'])for(const count of [0,1,2]) {
  const f=await setup(role,count);
  try {
   await navigate(f.page,role==='builder'?'cost':'bwcost');
   await check(`${role} ${count} project default`,async()=>{
    if(count===0)assert.equal(await f.page.locator('[data-workspace-state="empty"]').count(),1);
    if(count===1)assert.equal(await f.page.locator('#wsswitchbtn').count(),1);
    if(count===2)assert.equal(await f.page.locator('[data-workspace-state="choose"]').count(),1,'Multiple authorized projects must require an explicit choice, not silently load first');
    assert.doesNotMatch(await f.page.locator('#main').innerText(),/Synthetic foreign project/);
    assert.equal(f.state.projectPosts,0);
   });
   if(count===2) {
    await f.page.screenshot({path:new URL(`synthetic-${role}-multiple-before.png`,output).pathname,fullPage:true});
    {
     if(await f.page.locator('[data-workspace-pick="second"]').count())await f.page.locator('[data-workspace-pick="second"]').click();
     else {await f.page.locator('#wsswitchbtn').click();await f.page.locator('.wsswitchitem[data-project="second"]').click();}
     await poll(async()=>/Synthetic second project/.test(await f.page.locator('h1').innerText()),'Second selection finishes rendering');
     await check(role+' explicit second selection',async()=>assert.match(await f.page.locator('h1').innerText(),/Synthetic second project/));
     await f.page.reload();await ready(f.page,'#tbprofile');await navigate(f.page,role==='builder'?'cost':'bwcost');
     await check(role+' refresh preserves legal explicit project',async()=>assert.match(await f.page.locator('h1').innerText(),/Synthetic second project/));
    }
   }
  }finally{await f.context.close();}
 }
 for(const mode of ['expired','denied','error','identity','domain']) {
  const f=await setup('lead',2);
  try {
   await navigate(f.page,'bwcost');await f.page.locator('[data-workspace-pick="second"]').click();
   await poll(async()=>/Synthetic second project/.test(await f.page.locator('h1').innerText()),'second selected');
   if(mode==='expired')f.state.projects=f.state.projects.filter(p=>p.id!=='second');
   if(mode==='denied'||mode==='error')f.state.projectsMode=mode;
   if(mode==='identity')f.identitySubject='synthetic-new-lead';
   if(mode==='domain') {f.state.domain='domain_b';f.state.projects.push({...project('domain_b'),id:'second',name:'Synthetic domain B second'});}
   await f.page.reload();await ready(f.page,'#tbprofile');await navigate(f.page,'bwcost');
   await check('refresh '+mode+' never restores old project data',async()=>{
    assert.equal(await f.page.locator('#wsbody').count(),0);
    if(mode==='denied'||mode==='error')assert.equal(await f.page.locator('[data-workspace-state="error"]').count(),1);
    else assert.equal(await f.page.locator('[data-workspace-state="choose"]').count(),1);
    assert.equal(f.state.projectPosts,0);
   });
   if(mode==='expired') {
    await navigate(f.page,'bwobs');
    assert.equal(await f.page.locator('[data-workspace-state="choose"]').count(),1,'Expired selection still requires an explicit choice on another page');
    await navigate(f.page,'bwcost');
   }
   if(mode==='denied'||mode==='error') {
    f.state.projectsMode='ok';await f.page.locator('[data-workspace-retry]').click();
    await poll(async()=>!!await f.page.locator('[data-workspace-state="choose"]').count(),'retry chooses without restoring denied data');
   }
  } finally {await f.context.close();}
 }
 await check('Lead save, persisted refresh, project-switch dirty Cancel',async()=>{
  const f=await setup('lead',2);
  try {
   await navigate(f.page,'bwcost');await f.page.locator('[data-workspace-pick="sample"]').click();
   await ready(f.page,'[name="monthlyLimitUsd"]');
   await f.page.locator('[name="monthlyLimitUsd"]').fill('125');
   await f.page.getByRole('button',{name:'Save USD budget',exact:true}).click();
   await poll(async()=>/Saved and verified/.test(await f.page.locator('[data-project-budget]').innerText()),'save readback');
   assert.equal(f.state.budgets.get('domain_a').monthlyLimitUsd,125);
   await f.page.locator('[data-budget-refresh]').click();
   await poll(async()=>await f.page.locator('[name="monthlyLimitUsd"]').inputValue()==='125','saved refresh');
   await f.page.locator('[name="monthlyLimitUsd"]').fill('150');
   await f.page.locator('#wsswitchbtn').click();await f.page.locator('.wsswitchitem[data-project="second"]').click();
   await poll(()=>f.state.dialogs.length>0,'dirty prompt');
   assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').inputValue(),'150');
   assert.match(await f.page.locator('h1').innerText(),/Synthetic domain_a project/);
   assert.equal(f.state.budgets.get('domain_a').monthlyLimitUsd,125);
   await f.page.screenshot({path:new URL('synthetic-lead-dirty-cancel.png',output).pathname,fullPage:true});
  }finally {await f.context.close();}
 });
 await check('390px project chooser keeps explicit keyboard-operable choices',async()=>{
  const f=await setup('lead',2);
  try {
   await f.page.setViewportSize({width:390,height:844});await navigate(f.page,'bwcost');
   const option=f.page.locator('[data-workspace-pick="second"]');
   await option.focus();await f.page.keyboard.press('Enter');
   await poll(async()=>/Synthetic second project/.test(await f.page.locator('h1').innerText()),'keyboard selection');
   await f.page.screenshot({path:new URL('synthetic-lead-mobile-selected.png',output).pathname,fullPage:true});
  }finally {await f.context.close();}
 });
 await check('Builder budget stays read-only and forged write receives 403',async()=>{
  const f=await setup('builder');
  try {
   await navigate(f.page,'cost');await ready(f.page,'[data-project-budget]');
   assert.equal(await f.page.locator('[name="monthlyLimitUsd"]').count(),0);
   const status=await f.page.evaluate(async()=>{const r=await fetch('/api/operations/project-budgets',{method:'POST',headers:{authorization:'Bearer synthetic-access','content-type':'application/json'},body:JSON.stringify({domainId:'domain_a',projectId:'sample',monthlyLimitUsd:125})});return r.status});
   assert.equal(status,403);
  }finally {await f.context.close();}
 });
 for(const mode of ['denied','error','malformed']) {
  const f=await setup('builder',1,mode);
  try {await navigate(f.page,'cost');await check('project list '+mode+' fails closed',async()=>{
   assert.equal(await f.page.locator('[data-workspace-state="error"]').count(),1);
   assert.equal(await f.page.locator('#wsbody').count(),0);assert.equal(f.state.projectPosts,0);
  });}finally{await f.context.close();}
 }
}finally{
 await browser.close();
 await writeFile(new URL('coverage.json',output),JSON.stringify(coverage,null,2));
 await writeFile(new URL('reproduction.json',output),JSON.stringify({syntheticOnly:true,results,errors,unexpected,requests,loadedSourceSha256:Object.fromEntries(loaded)},null,2));
 console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length}));
 process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
}
