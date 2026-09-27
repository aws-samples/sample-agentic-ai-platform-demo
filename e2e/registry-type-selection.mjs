// Actual console UI with intercepted synthetic APIs; no live identity or writes.
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {fixture,signIn,navigate,ready,poll,errors} from './approved-ui-integration.mjs';
const output=process.argv[2]||'/private/tmp/registry-type-selection';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,chromiumSandbox:true});
try{
 for(const role of ['admin','lead','builder']){
  const f=await fixture(role,{},browser);
  await f.context.route('**/api/registry',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,source:'aws',entries:['Agent','A2AAgent','MCPServer','Skill','Blueprint'].map(type=>({id:'synthetic-'+type.toLowerCase(),name:'Synthetic '+type,type,domain:'shared',defaultVersion:'1.0.0',resolved:{status:'APPROVED'},versions:[{semver:'1.0.0',status:'APPROVED',content:{}}]}))})}));
  try{
   await signIn(f);await navigate(f.page,role==='lead'?'bwregistry':'registry');
   await ready(f.page,'#regsearch');await poll(async()=>!/^Loading/.test(await f.page.locator('#regbox').innerText()),'Initial Registry load');
   for(const type of ['Agent','A2AAgent','MCPServer','Skill','Model','Blueprint','All']){
    await f.page.locator(`[data-regtype="${type}"]`).click();
    await poll(async()=>!/^Loading/.test(await f.page.locator('#regbox').innerText()),'Registry finishes loading');
    assert.deepEqual(await f.page.locator('#regchips .type').evaluateAll(es=>es.map(e=>e.dataset.regtype)),[type],'Selected resource filter follows loaded content');
    assert.equal(await f.page.locator(`[data-regtype="${type}"]`).getAttribute('aria-pressed'),'true');
    assert.equal(await f.page.locator('#regchips [aria-pressed="true"]').count(),1);
    if(['Agent','A2AAgent','MCPServer','Skill','Blueprint'].includes(type))assert.deepEqual(await f.page.locator('#regbox [data-regid]').evaluateAll(es=>es.map(e=>e.dataset.regid)),['synthetic-'+type.toLowerCase()]);
   }
   await f.page.locator('[data-regtype="Skill"]').focus();await f.page.keyboard.press('Enter');
   await poll(async()=>await f.page.locator('[data-regtype="Skill"]').getAttribute('aria-pressed')==='true','Keyboard resource selection');
   await f.page.locator('#regsearch').fill('Synthetic');
   await poll(async()=>!/^Loading/.test(await f.page.locator('#regbox').innerText()),'Search refresh finishes');
   assert.equal(await f.page.locator('[data-regtype="Skill"]').getAttribute('aria-pressed'),'true');
   await f.page.screenshot({path:`${output}/${role}.png`,fullPage:true});
   console.log(`PASS ${role}: type selection, search refresh and keyboard`);
  }finally{await f.context.close();}
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
