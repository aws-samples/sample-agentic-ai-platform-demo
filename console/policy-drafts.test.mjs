import test from 'node:test';import assert from 'node:assert/strict';
import {mountPolicyDraftEditor} from './public/policy-drafts.mjs';
class Node {
 constructor(){this.children=[];this.nodes={};this.isConnected=true;this.disabled=false;this.dataset={};this.value='';this.textContent='';}
 append(n){this.children.push(n)}
 set innerHTML(s){this.html=s;for(const n of Object.values(this.nodes))n.isConnected=false;this.nodes={};
  if(s.includes('data-draft-new')){this.nodes['[data-draft-new]']=new Node();this.nodes['[data-draft-form]']=new Node();}
  if(s.includes('<form')){const form=new Node();this.nodes.form=form;for(const id of ['hpdid','hpdname','hpdtools','hpdmode','hpdkind','hpdproject','hpdreason']){const n=new Node();n.id=id;const tag=s.match(new RegExp('<(?:input|textarea)[^>]*id="'+id+'"[^>]*>([^<]*)'));n.value=tag?.[0].match(/value="([^"]*)"/)?.[1]||tag?.[1]||'';form.nodes['#'+id]=n;}for(const key of ['[data-draft-status]','[data-draft-save]','[data-draft-cancel]'])form.nodes[key]=new Node();}
 }
 get innerHTML(){return this.html||''}
 querySelector(s){return this.nodes[s]||null}
 querySelectorAll(s){if(s==='input,textarea,select')return Object.entries(this.nodes).filter(([k])=>k.startsWith('#')).map(([,v])=>v);if(s==='[data-policy]')return this.children.filter(n=>n.dataset.policy);if(s==='[data-draft-edit]')return this.children.flatMap(n=>n.children).filter(n=>n.dataset.draftEdit);return []}
}
globalThis.document={createElement:()=>new Node()};
function harness({reply={ok:true,saved:true,enforcement:'NOT_CONFIGURED'},policies=[],domain='platform'}={}){
 const root=new Node(),calls=[],clears=[],bindings=[];let actor='synthetic-a',allowed=true,reloads=0,sequence=0;
 for(const policy of policies){const n=new Node();n.dataset.policy=policy.id;root.append(n)}
 mountPolicyDraftEditor(root,{catalog:{domainId:domain,revision:3,policies},api:async(...args)=>{calls.push(args);return typeof reply==='function'?reply():reply},current:()=>true,identity:()=>actor,requestId:()=>`synthetic-${++sequence}`,dirty:{clear:s=>clears.push(s),bind:(...a)=>bindings.push(a)},confirmChange:()=>allowed,reload:async()=>{reloads++}});
 const controls=()=>root.children.at(-1),open=()=>controls().querySelector('[data-draft-new]').onclick(),form=()=>controls().querySelector('[data-draft-form]').querySelector('form');
 const fill=()=>{for(const [id,v] of Object.entries({hpdid:'synthetic-draft',hpdname:'Synthetic draft',hpdtools:'synthetic_*',hpdreason:'Synthetic configuration rationale.'}))form().querySelector('#'+id).value=v};
 return {root,calls,clears,bindings,open,form,fill,actor:v=>actor=v,allow:v=>allowed=v,submit:()=>form().onsubmit({preventDefault(){}}),reloads:()=>reloads};
}
test('actual form sends disabled-only schema, reason and captured revision; success re-reads',async()=>{const h=harness();h.open();h.fill();await h.submit();assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'/governance/policy-drafts');assert.equal(h.calls[0][1].expectedRevision,3);assert.equal(h.calls[0][1].expectedPolicyVersion,null);assert.equal(Object.hasOwn(h.calls[0][1].policy,'enabled'),false);assert.equal(h.calls[0][2].requestId,'synthetic-1');assert.equal(h.reloads(),1);assert.equal(h.bindings[0][1].length,7)});
test('invalid reason prevents request; cancel dirty guard retains form',async()=>{const h=harness();h.open();h.fill();h.form().querySelector('#hpdreason').value='';await h.submit();assert.equal(h.calls.length,0);const f=h.form();h.allow(false);f.querySelector('[data-draft-cancel]').onclick();assert.equal(h.form(),f)});
test('unknown result locks payload and retries same request id without duplicating draft',async()=>{let n=0;const h=harness({reply:()=>++n===1?{ok:false}:{ok:true,saved:true,enforcement:'NOT_CONFIGURED'}});h.open();h.fill();await h.submit();assert.equal(h.form().querySelector('#hpdname').disabled,true);await h.submit();assert.deepEqual(h.calls[0],h.calls[1]);assert.equal(h.reloads(),1)});
test('revision conflict preserves text and retained submit cannot blindly retry',async()=>{const h=harness({reply:{ok:false,code:'CONFLICT'}});h.open();h.fill();await h.submit();assert.equal(h.form().querySelector('#hpdname').value,'Synthetic draft');await h.submit();assert.equal(h.calls.length,1);assert.equal(h.form().querySelector('[data-draft-save]').disabled,true)});
test('identity change blocks retained submit and late response',async()=>{let finish;const h=harness({reply:()=>new Promise(r=>finish=r)});h.open();h.fill();const task=h.submit();h.actor('synthetic-b');finish({ok:true,saved:true,enforcement:'NOT_CONFIGURED'});await task;assert.equal(h.reloads(),0);await h.submit();assert.equal(h.calls.length,1)});
test('nonplatform catalog has no draft editor; enabled policies have no edit entry',()=>{const foreign=harness({domain:'synthetic-domain'});assert.equal(foreign.root.children.length,0);const h=harness({policies:[{id:'synthetic-active',enabled:true}]});assert.equal(h.root.querySelectorAll('[data-draft-edit]').length,0)});
test('edit disabled draft uses its version and creation cannot overwrite through retained old form',async()=>{const p={id:'synthetic-existing',name:'Existing',toolMatch:['synthetic_*'],scope:{kind:'domain'},mode:'notify_only',version:2,enabled:false};const h=harness({policies:[p]});h.root.querySelectorAll('[data-draft-edit]')[0].onclick();h.form().querySelector('#hpdreason').value='Synthetic draft edited only.';await h.submit();assert.equal(h.calls[0][1].operation,'update');assert.equal(h.calls[0][1].expectedPolicyVersion,2);const retained=h.form();h.open();await retained.onsubmit({preventDefault(){}});assert.equal(h.calls.length,1)});
