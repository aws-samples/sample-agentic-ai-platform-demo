// Actual app + actual Chromium. Public IDs observed in live DOM; all identities/access are synthetic.
// No cloud writes or inference. Baseline uses the byte-matched deployed aa2ed87 static tree.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture,signIn,navigate,poll,profile,unexpected,errors,loaded} from './approved-ui-integration.mjs';
import {inventory,adminCatalog,domainCatalog} from '../console/test-support/model-status-harness.mjs';
const ids=JSON.parse(await readFile(new URL('../console/test-support/model-catalog-public-ids.json',import.meta.url)));
const out=path.resolve(process.argv[2]),baseline=process.argv[3]==='baseline';await mkdir(out,{recursive:true});
const root=baseline?path.resolve('../governance-mobile-layout-20260912/console/public'):path.resolve('console/public');
const results={boundary:'LOCAL Chromium / synthetic read-only API / observed public IDs / NOT DEV',baseline,checks:[],metrics:[],writes:[],errors:[],runtime:process.version};
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
results.browser=browser.version();
async function shot(page,name){await page.evaluate(()=>{let el=document.getElementById('local-evidence');if(!el){el=document.createElement('div');el.id='local-evidence';el.textContent='LOCAL PREVIEW • PUBLIC MODEL IDs • SYNTHETIC ACCESS • NOT DEV';el.style.cssText='position:fixed;bottom:0;left:0;z-index:9999;background:#fff4cc;color:#111;padding:4px;font:11px sans-serif;pointer-events:none';document.body.append(el)}});await page.screenshot({path:path.join(out,name+'.png'),fullPage:false})}
try{
 for(const role of ['admin','lead','builder','user'])for(const width of role==='admin'?[1440,390]:[1440]){
  const f=await fixture(role,{viewport:{width,height:1000}},browser,root),domain=role==='admin'?'platform':'domain_a';f.state.domain=domain;f.state.canSwitch=false;
  const entries=inventory().map((e,i)=>({...e,id:ids[i],name:ids[i].split('/')[1],_gateway:'Synthetic legacy connection',versions:e.versions.map(v=>({...v,content:{source:'agentcore-gateway',gatewayModelId:ids[i],runtimeModelId:ids[i].split('/')[1]}}))}));
  const catalog=role==='admin'?adminCatalog(domain):domainCatalog(ids[0],domain);catalog.models[0].id=ids[0];
  if(role==='admin'){catalog.models[0].policy.modelId=ids[0];catalog.models[0].versions[0].content.gatewayModelId=ids[0];catalog.models[0].versions[0].content.runtimeModelId=ids[0].split('/')[1];}
  let mode='normal';
  await f.context.route('https://console.test/api/**',async route=>{
   const req=route.request(),r=new URL(req.url()).pathname.slice(5),json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(req.method()!=='GET'){results.writes.push(r);return route.abort()}
   if(r==='me')return json(profile(role,domain,false));
   if(r==='registry')return json({ok:true,source:'aws',entries});
   if(r==='ai-gateway')return mode==='error'?json({ok:false,code:'FORBIDDEN'},403):json(catalog);
   return route.fallback();
  });
  try{
   await signIn(f);
   if(role==='user'){assert.equal(await f.page.locator('[data-nav="registry"],[data-nav="bwregistry"]').count(),0);results.checks.push('End User has no Registry navigation');continue}
   await navigate(f.page,role==='lead'?'bwregistry':'registry');await f.page.locator('[data-regtype="Model"]').click();
   await poll(async()=>await f.page.locator('.regrow').count()===47,'47 observed public IDs');
   await f.page.evaluate(()=>scrollTo(0,0));await shot(f.page,`${role}-${width}-catalog`);
   const box=f.page.locator('#regbox');
   await box.scrollIntoViewIfNeeded();await shot(f.page,`${role}-${width}-groups`);
   await writeFile(path.join(out,`${role}-${width}-catalog.txt`),await box.innerText());
   if(!baseline){
    assert.equal(await f.page.locator('.model-provider-group').count(),13); // 12 known manufacturers plus unknown
    assert.equal(await f.page.locator('.model-provider-group tbody .chip,.model-provider-group tbody .badge').count(),0);
    assert.doesNotMatch(await f.page.locator('.model-provider-group').allInnerTexts().then(t=>t.join('')),/Policy active|Granted in|DISCOVERED|Select a domain/);
    assert.doesNotMatch(await f.page.locator('body').innerText(),/Configured Runtime|0 verified|Runtime.ready|Connection inventory|legacy Mantle|Legacy connection|Counts cover|access summary|Provider and capabilities use/);assert.equal(await f.page.locator('h1').innerText(),'Amazon Bedrock models');assert.equal(await f.page.locator('#regmodelview').count(),0);
    const metrics=await f.page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,tableWidths:[...document.querySelectorAll('.model-provider-group table')].map(x=>({client:x.clientWidth,scroll:x.scrollWidth})),groupCount:document.querySelectorAll('.model-provider-group').length}));results.metrics.push({role,...metrics});assert.ok(metrics.documentWidth<=width,JSON.stringify(metrics));
    await f.page.locator('#regprovider').selectOption('OpenAI');await poll(async()=>await f.page.locator('.regrow').count()===7,'7 exact OpenAI matches');assert.match(await box.innerText(),/47 total models · 7 matching models/);
    await shot(f.page,`${role}-${width}-openai`);
    await f.page.locator('#regclear').click();await poll(async()=>await f.page.locator('.regrow').count()===47,'clear restores total');
    await f.page.locator('#regsearch').fill('Gemma');await poll(async()=>await f.page.locator('.regrow').count()===6,'six Gemma matches');assert.match(await box.innerText(),/47 total models · 6 matching models/);
    await f.page.locator('#regclear').click();await poll(async()=>await f.page.locator('.regrow').count()===47,'clear search');
    await f.page.locator('#regprovider').selectOption('__missing__');await poll(async()=>await f.page.locator('.regrow').count()===2,'two unmatched IDs');await shot(f.page,`${role}-${width}-unidentified`);
    await f.page.locator('#regclear').click();await poll(async()=>await f.page.locator('.regrow').count()===47,'restore');
    results.checks.push(`${role}/${width}: exact grouping, compact rows, search/provider counts, unknown source, no overflow`);
   }
   await f.page.locator('.regrow').first().locator('button').click();const drawer=f.page.locator('#regdrawerwrap');await drawer.scrollIntoViewIfNeeded();
   const detailMetrics=await f.page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,closeFocus:document.activeElement.id==='regdrawerclose'}));results.metrics.push({role,details:true,...detailMetrics});if(!baseline){assert.ok(detailMetrics.documentWidth<=width,JSON.stringify(detailMetrics));assert.ok(detailMetrics.closeFocus);}
   await writeFile(path.join(out,`${role}-${width}-details.txt`),await drawer.innerText());await shot(f.page,`${role}-${width}-details`);
   assert.equal(await drawer.locator('.regapprove,.regreject').count(),0);
   if(!baseline){assert.match(await drawer.innerText(),/AWS model card: exact ID match/);if(role==='admin'){assert.match(await drawer.innerText(),/Current platform policy/);assert.match(await drawer.innerText(),/Application: ACTIVE/);assert.doesNotMatch(await drawer.innerText(),/Approved/);}if(role!=='admin')assert.doesNotMatch(await drawer.innerText(),/Current platform policy|Allowed domains:|Requestable domains:/);await drawer.locator('summary').filter({hasText:'Technical details'}).click();assert.match(await drawer.innerText(),/bedrock-mantle\//);assert.doesNotMatch(await drawer.innerText(),/not migrated|not verified|Runtime-only requirement/);results.checks.push(`${role}/${width}: details provenance, role-safe policy, no native approval, accurate technical ID`);}
   await f.page.locator('#regdrawerclose').click();
   if(!baseline){mode='error';await f.page.locator('#regprovider').selectOption('Anthropic');await poll(async()=>await f.page.locator('.regrow').count()===1,'inventory survives failed access');await f.page.locator('.regrow button').click();assert.match(await drawer.innerText(),/Could not load access/);results.checks.push(`${role}/${width}: failed access stays unknown in details`)}
  }finally{await f.context.close()}
 }
 assert.deepEqual(results.writes,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);
 results.checks.push('No unexpected network requests, page errors, business writes or inference');
}catch(error){results.errors.push(error.stack);process.exitCode=1;console.error(error)}finally{await browser.close();results.loadedSourceSha256=Object.fromEntries(loaded);await writeFile(path.join(out,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({checks:results.checks,errors:results.errors}));}
