// Actual shipped app, local Chromium, synthetic read-only API. No cloud/inference.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture,signIn,navigate,poll,errors,unexpected,loaded} from './approved-ui-integration.mjs';
const out=path.resolve(process.argv[2]);await mkdir(out,{recursive:true});
const result={boundary:'LOCAL Chromium synthetic IO, NOT live',checks:[],errors:[],metrics:[]};
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 for(const role of ['admin','lead','builder'])for(const width of [390,1440]){
  const f=await fixture(role,{viewport:{width,height:1000}},browser);f.state.canSwitch=false;
  await signIn(f);await navigate(f.page,role==='lead'?'bwregistry':'registry');await f.page.locator('[data-regtype="Model"]').click();
  await poll(async()=>await f.page.locator('[data-recent-model]').count()===11,'eleven recent verified models');
  assert.equal(await f.page.locator('.model-provider-group').count(),3);assert.equal(await f.page.locator('h1').innerText(),'Amazon Bedrock models');
  const body=await f.page.locator('#regbox').innerText();assert.doesNotMatch(body,/Unidentified provider|Haiku 4\.5|47 total|latest/i);assert.match(body,/2026-03-12.*2026-09-12/);
  await f.page.locator('#regprovider').selectOption('OpenAI');assert.equal(await f.page.locator('[data-recent-model]').count(),4);
  await f.page.locator('#regsearch').fill('Astra');await poll(async()=>await f.page.locator('[data-recent-model]').count()===1,'search Astra');
  await f.page.getByRole('button',{name:'View details for GPT-6 Astra',exact:true}).click();
  const drawer=await f.page.locator('#regdrawerwrap').innerText();assert.match(drawer,/2026-09-03/);assert.match(drawer,/2026-09-08/);assert.match(drawer,/Not verified for this workspace/);
  await f.page.getByText('Technical details',{exact:true}).click();assert.match(await f.page.locator('#regdrawerwrap').innerText(),/global\.openai\.gpt-6-astra/);
  assert.equal(await f.page.locator('#regdrawerwrap button').count(),2,'close and real access check only, no invoke/approve');
  await f.page.getByRole('button',{name:'Check workspace access',exact:true}).click();await poll(async()=>/no verified workspace connection|Could not load workspace access/.test(await f.page.locator('#regdrawerwrap').innerText()),'unconfigured model cannot fabricate management/request target');
  const metric=await f.page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert.ok(metric.scrollWidth<=width,JSON.stringify(metric));result.metrics.push({role,...metric});
  await f.page.screenshot({path:path.join(out,`${role}-${width}-details.png`),fullPage:true});
  await f.page.getByRole('button',{name:'Close details',exact:true}).click();await f.page.locator('#regclear').click();assert.equal(await f.page.locator('[data-recent-model]').count(),11);
  for(const tier of ['Terra','Luna']){
   await f.page.locator('#regprovider').selectOption('OpenAI');
   await f.page.locator('#regsearch').fill(tier);await poll(async()=>await f.page.locator('[data-recent-model]').count()===1,'search '+tier);
   assert.match(await f.page.locator('#regbox [role="status"]').innerText(),/11 models · 1 matching/);
   await f.page.getByRole('button',{name:`View details for GPT-5.6 ${tier}`,exact:true}).click();
   const panel=f.page.locator('#regdrawerwrap');assert.match(await panel.innerText(),/2026-07-09/);assert.match(await panel.innerText(),/2026-07-13/);
   await f.page.getByText('Technical details',{exact:true}).click();assert.ok((await panel.innerText()).includes(`global.openai.gpt-5.6-${tier.toLowerCase()}`));
   assert.match(await panel.innerText(),/Responses, Chat Completions, Converse/);assert.match(await panel.innerText(),/Not verified for this workspace/);
   assert.equal(await panel.locator('a').count(),2);assert.equal(await panel.locator('button').count(),2);
   await f.page.getByRole('button',{name:'Check workspace access',exact:true}).click();await poll(async()=>/no verified workspace connection|Could not load workspace access/.test(await panel.innerText()),'no fabricated '+tier+' route');
   await f.page.screenshot({path:path.join(out,`${role}-${width}-${tier.toLowerCase()}.png`),fullPage:true});
   await f.page.locator('#regprovider').selectOption('Anthropic');assert.equal(await panel.innerText(),'','filtering selected model out closes details');
   await f.page.locator('#regclear').click();assert.equal(await f.page.locator('[data-recent-model]').count(),11);
  }
  await f.page.locator('#regprovider').selectOption('Anthropic');assert.equal(await f.page.locator('[data-recent-model]').count(),6);
  await f.page.locator('#regprovider').selectOption('xAI');assert.equal(await f.page.locator('[data-recent-model]').count(),1);
  await f.page.locator('[data-regtype="Skill"]').click();await poll(async()=>await f.page.locator('[data-recent-model]').count()===0,'native view replaces recent catalog');
  result.checks.push(`${role}/${width}: 11 models, 3 providers, counts/search/details/dates/no callable actions/no overflow/native tab preserved`);await f.context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);result.loadedSourceSha256=Object.fromEntries(loaded);result.status='PASS';
}catch(e){result.errors.push(e.stack);process.exitCode=1;console.error(e)}finally{
 await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 const timeout=setTimeout(()=>{console.error('Local Chromium cleanup timed out after results were saved');process.exit(1)},15000);
 await browser.close();clearTimeout(timeout);
}
