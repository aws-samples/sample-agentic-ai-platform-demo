import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recentModels, recentModelDetails } from './public/recent-model-catalog.mjs';
import { RECENT_MODEL_CATALOG as catalog } from './public/recent-model-catalog-data.mjs';

test('official verified recent Runtime catalog has 11 models, 3 known providers and separate release dates',()=>{
 const models=recentModels();assert.equal(models.length,11);assert.deepEqual([...new Set(models.map(m=>m.provider))].sort(),['Anthropic','OpenAI','xAI']);
 for(const m of models){assert.ok(m.vendor_first_release_date>='2026-03-12'&&m.vendor_first_release_date<='2026-09-12');assert.equal(m.runtime_supported,true);assert.equal(m.first_runtime_support_date,null);assert.ok(m.releaseSource&&m.aws_source_url);}
 const astra=models.find(m=>m.key==='openai-gpt-6-astra');assert.equal(astra.vendor_first_release_date,'2026-09-03');assert.equal(astra.bedrock_launch_date,'2026-09-08');
 for(const key of ['anthropic-claude-opus-5','anthropic-claude-sonnet-5','xai-grok-4-6'])assert.ok(models.some(m=>m.key===key));
});
test('date window inclusive and unknown/unsupported/unverified candidates fail closed',()=>{
 const base=structuredClone(catalog.models[0]);
 for(const date of ['2026-03-12','2026-09-12'])assert.equal(recentModels({...catalog,models:[{...base,vendor_first_release_date:date}]}).length,1);
 for(const patch of [{vendor_first_release_date:null},{vendor_first_release_date:'2026-03-11'},{vendor_first_release_date:'2026-09-13'},{provider:null},{provider_verified:false},{runtime_supported:false},{default_eligible:false},{releaseSource:null},{lifecycle:'preview'},{aws_source_url:'https://example.invalid'}])assert.equal(recentModels({...catalog,models:[{...base,...patch}]}).length,0,JSON.stringify(patch));
});
test('excluded resources retained in data; old Haiku/Mantle-only GPT5.5/unknown dates not in catalog display',()=>{
 assert.equal(catalog.models.length,19);const keys=recentModels().map(m=>m.key);
 for(const key of ['anthropic-claude-haiku-4-5','openai-gpt-55','google-gemma-4-31b','writer-palmyra-vision-7b'])assert.ok(!keys.includes(key));
});
test('details distinguish official support from workspace admission and expose no fabricated calls/actions',()=>{
 for(const m of recentModels()){
  const html=recentModelDetails(m);assert.match(html,/Not verified for this workspace/);assert.match(html,/does not grant workspace access/);assert.match(html,/Model release/);assert.match(html,/AWS catalog launch/);assert.ok(html.includes(m.runtime_global_profile_id));assert.doesNotMatch(html,/data-regapprove|Submit for review|Invoke model|Use in Build|Available to invoke/);
 }
});
test('hosted Model view reads Registry inventory rather than an independent curated list',()=>{
 const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
 const start=source.indexOf('async function loadRegistry(){'),end=source.indexOf('\nfunction ',start),loader=source.slice(start,end);
 assert.match(loader,/api\('\/registry'\+type\)/);assert.doesNotMatch(loader,/mountRecentModelCatalog/);
 assert.match(loader,/registryModelGroupsHtml\(rows\)/);
});

test('GPT-5.6 smaller tiers preserve exact Runtime identities, modalities and official dates without admitting access',()=>{
 for(const tier of ['terra','luna']){
  const model=recentModels().find(m=>m.key===`openai-gpt-56-${tier}`);assert.ok(model);
  assert.equal(model.display_name,`GPT-5.6 ${tier[0].toUpperCase()+tier.slice(1)}`);assert.equal(model.provider,'OpenAI');
  assert.equal(model.runtime_model_id,`openai.gpt-5.6-${tier}`);assert.equal(model.runtime_global_profile_id,`global.openai.gpt-5.6-${tier}`);
  assert.deepEqual(model.runtime_api_support_confirmed,['Responses','Chat Completions','Converse']);
  assert.deepEqual(model.input_modalities,['image','text']);assert.deepEqual(model.output_modalities,['text']);
  assert.equal(model.vendor_first_release_date,'2026-07-09');assert.equal(model.bedrock_launch_date,'2026-07-13');
  assert.equal(model.releaseSource,'https://openai.com/index/gpt-5-6/');assert.ok(model.aws_source_url.endsWith(`model-card-openai-gpt-56-${tier}.html`));
  assert.match(recentModelDetails(model),/Not verified for this workspace/);
 }
 assert.equal(recentModels().filter(m=>m.provider==='OpenAI').length,4);
 const app=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
 const start=app.indexOf('async function openRecentModelAccess('),end=app.indexOf('async function loadRegistry(',start),access=app.slice(start,end);
 assert.match(access,/sessionEpochIsCurrent\(epoch\)/);assert.match(access,/context!==hostedModelReadContext\(\)/);
 assert.match(access,/matches\.length!==1/);assert.match(access,/v\.content\?\.runtimeModelId===model\.runtime_model_id/);
 assert.doesNotMatch(access,/method:\s*['"]POST|invokeModel|createGatewayTarget/);
});
