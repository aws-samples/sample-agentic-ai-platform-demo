// Synthetic HTTP contract regression using the real hosted console renderer.
// Live acceptance is still required after deployment.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fixture,signIn,navigate,poll,errors} from './approved-ui-integration.mjs';
const browser=await chromium.launch({headless:true});
try {
 for(const role of ['admin','lead','builder']) {
  const f=await fixture(role,{},browser), legacy=[];
  f.page.on('request',r=>{if(/\/api\/(domain-health|hitl-promotions|memories)(?:\?|$)/.test(r.url()))legacy.push(r.url());});
  try {
   await signIn(f);
   if(role==='admin'){
    await navigate(f.page,'governance');
    await poll(async()=>!(await f.page.locator('#main').innerText()).includes('loading'),'Governance settled');
   }
   if(role==='lead'){
    await navigate(f.page,'dashboard');
    await poll(async()=>!(await f.page.locator('#dcbody').innerText()).includes('loading'),'Dashboard settled');
   }
   await navigate(f.page,role==='builder'?'fleet':'bwfleet');
   const picker=f.page.locator('[data-workspace-pick="sample"]');
   if(await picker.count())await picker.first().click();
   await poll(async()=>!(await f.page.locator('#main').innerText()).includes('loading'),'Workspace settled');
   assert.deepEqual(legacy,[],`${role} must use hosted inventory and approval APIs`);
   console.log(`PASS ${role}: no local-only health or promotion routes`);
  } finally {await f.context.close();}
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
