import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MODEL_PROVIDER_FACTS as facts} from './public/model-provider-facts.mjs';
import {statusHarness,inventory} from './test-support/model-status-harness.mjs';
const ids=JSON.parse(await readFile(new URL('./test-support/model-catalog-public-ids.json',import.meta.url)));
function entry(id){const e=inventory(1)[0];e.id=id;e.name='Untrusted name: OpenAI';e.versions[0].content.gatewayModelId=id;e.versions[0].content.runtimeModelId='Unverified alias';return e;}
test('exact observed public-ID allowlist has provenance; aliases and unknowns are not guessed',()=>{
 assert.equal(ids.length,47);assert.equal(Object.keys(facts).length,45);
 for(const [id,f] of Object.entries(facts)){
  assert.ok(ids.includes(id));assert.equal(id,'bedrock-mantle/'+f.modelId);
  assert.match(f.url,/^https:\/\/docs\.aws\.amazon\.com\/bedrock\/latest\/userguide\/model-card-[a-z0-9-]+\.html$/);
  assert.ok(f.provider);assert.equal(f.checkedAt,'2026-09-12');
  for(const modality of [...f.input,...f.output])assert.ok(['Text','Image','Audio','Speech','Video','Embedding'].includes(modality));
 }
 assert.equal(facts['bedrock-mantle/openai.gpt-5.4-2026-03-05'],undefined);
 assert.equal(facts['bedrock-mantle/zai.glm-4.6'],undefined);
});
test('actual renderer ignores guessed vendor, owner, case, prefix and unbound source',async()=>{
 const h=await statusHarness();
 for(const id of ['bedrock-mantle/openai.future','bedrock-mantle/openai.gpt-5.4-2026-03-05','BEDROCK-MANTLE/openai.gpt-5.4','other/openai.gpt-5.4']){
  const e=entry(id);e.modelVendor='OpenAI';e.versions[0].content.ownedBy='OpenAI';assert.equal(h.ctx.registryModelMetadata(e).provider,null);
 }
 const e=entry('bedrock-mantle/openai.gpt-5.4');assert.equal(h.ctx.registryModelMetadata(e).provider,'OpenAI');
 e.versions[0].content.gatewayModelId='different';assert.equal(h.ctx.registryModelMetadata(e).provider,null);
});
test('actual grouped view has concise rows; policy, missing values and source stay in details',async()=>{
 const h=await statusHarness();h.store.registry.entries=ids.map(entry);h.ctx.S.registryFilterType='Model';await h.ctx.loadRegistry();
 const html=h.roots.regbox.innerHTML;
 assert.equal((html.match(/class="model-provider-group"/g)||[]).length,13);
 assert.match(html,/47 total models · 47 matching models/);assert.doesNotMatch(html,/Configured Runtime|Runtime.ready|Connection inventory|legacy Mantle|Legacy connection|Counts cover|access summary|Provider and capabilities use/);
 const groups=html.slice(html.indexOf('<section class="model-provider-group"'));
 assert.doesNotMatch(groups,/Policy active|Granted in|DISCOVERED|Select a domain/);
 assert.match(groups,/Input → output/);assert.match(groups,/Unidentified provider/);
 h.ctx.S.registryDrawerId='bedrock-mantle/openai.gpt-5.4-2026-03-05';h.ctx.renderRegistryDrawer();
 assert.match(h.roots.regdrawerwrap.innerHTML,/No exact official model-card match|Not provided/);
 assert.doesNotMatch(h.roots.regdrawerwrap.innerHTML,/AWS model card: exact ID match/);
 assert.equal(h.writes.length,0);
});
test('matching count never replaces total; unavailable query preserves all inventory',async()=>{
 const h=await statusHarness();h.store.registry.entries=ids.map(entry);h.ctx.S.registryFilterType='Model';h.ctx.S.registryProvider='OpenAI';await h.ctx.loadRegistry();
 assert.equal(h.roots.regbox.querySelectorAll('.regrow').length,7);assert.match(h.roots.regbox.innerHTML,/47 total models · 7 matching models/);
 h.ctx.S.registrySearch='no-such-model';await h.ctx.loadRegistry();assert.equal(h.roots.regbox.querySelectorAll('.regrow').length,0);assert.match(h.roots.regbox.innerHTML,/47 total models · 0 matching models/);assert.match(h.roots.regbox.innerHTML,/No matching models/);
});
