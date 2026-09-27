import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {guardrailPolicyView,validGuardrailPolicy} from './public/guardrails-view.mjs';

// The shipped document is the single source both the Governance › Guardrails
// tab renders and the console server enforces from. It must always validate:
// a deployment with a broken document would ship an empty governance surface.
const shipped=JSON.parse(readFileSync(new URL('./public/guardrails-policy.json',import.meta.url),'utf8'));

test('the shipped guardrails-policy.json is valid and renders every section',()=>{
  assert.equal(validGuardrailPolicy(shipped),true);
  const html=guardrailPolicyView(shipped);
  for(const text of ['Org default pack','Domain additions','Configurable runtime controls','Exemptions','Locked on','Strengthen-only'])assert.ok(html.includes(text),text);
  for(const g of shipped.guardrails)assert.ok(html.includes(g.name),g.name);
  for(const g of shipped.domainOptions)assert.ok(html.includes(g.name),g.name);
  for(const g of shipped.catalog)assert.ok(html.includes(g.name),g.name);
});

test('validation fails closed on structural damage',()=>{
  assert.equal(validGuardrailPolicy(null),false);
  assert.equal(validGuardrailPolicy({}),false);
  assert.equal(validGuardrailPolicy({...shipped,schemaVersion:2}),false);
  assert.equal(validGuardrailPolicy({...shipped,guardrails:[]}),false);
  assert.equal(validGuardrailPolicy({...shipped,defaultPackId:'missing-pack'}),false);
  // A pack referencing an undefined guardrail id is invalid — enforcement
  // would silently lose a control.
  assert.equal(validGuardrailPolicy({...shipped,packs:[{id:shipped.defaultPackId,name:'x',guardrails:['ghost']}]}),false);
  assert.equal(validGuardrailPolicy({...shipped,enforcement:null}),false);
  assert.throws(()=>guardrailPolicyView({}),/invalid/);
});

test('rendered HTML escapes injected content and never invents runtime claims',()=>{
  const doc={schemaVersion:1,defaultPackId:'p',guardrails:[{id:'g',name:'<script>x</script>',description:'<img onerror=1>'}],packs:[{id:'p',name:'Pack',guardrails:['g']}],domainOptions:[],catalog:[],enforcement:{orgDefaults:'a',domainAdditions:'b',projectConfiguration:'c',exemptions:'d'}};
  const html=guardrailPolicyView(doc);
  assert.doesNotMatch(html,/<script>x<\/script>|<img onerror/);
  assert.match(html,/&lt;script&gt;/);
  // Policy truth, not runtime verification: no fabricated Bedrock binding.
  assert.doesNotMatch(html,/verified runtime|guardrail binding active/i);
});
