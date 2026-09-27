import test from 'node:test';
import assert from 'node:assert/strict';
import {readDraftActivity, draftActivityHtml, mountDraftActivity} from './public/draft-activity.mjs';
const resource='hitl-policy/platform/synthetic-draft';
const event=(patch={})=>({resource,domainId:'platform',timestamp:'2026-09-14T00:00:00Z',actor:'synthetic-actor',action:'hitl_policy.create',reason:'Synthetic reason',...patch});
const page=(items,cursor=null)=>({ok:true,resource:'audit',items,cursor});
const options=read=>({read,resourceKey:resource,domainId:'platform',current:()=>true});
test('exact resource AND domain isolation after complete authorized pagination',async()=>{
 const calls=[];const r=await readDraftActivity(options(async p=>{calls.push(p);return p.includes('cursor=')?page([event({action:'hitl_policy.update'}),event({resource:resource+'-other'}),event({domainId:'other'})]):page([event(),event({resource:'alert-policy/platform/synthetic-draft'})],'next /');}));
 assert.equal(r.events.length,2);assert.deepEqual(r.events.map(e=>e.action),['hitl_policy.create','hitl_policy.update']);assert.deepEqual(calls,['/operations/audit?limit=50','/operations/audit?limit=50&cursor=next%20%2F']);
});
for(const fault of [{ok:false,code:'FORBIDDEN'}, {ok:false,status:403}, {...page([]),partial:true}, {...page([]),incomplete:true}, {...page([]),complete:false}, {...page([]),errors:['synthetic']}, page([],''), page([],'repeat')])test(`later-page fault gives no partial history ${JSON.stringify(fault)}`,async()=>{
 let n=0;const r=await readDraftActivity(options(async()=>++n===1?page([event()],'repeat'):fault));assert.equal(r.ok,false);assert.equal(r.events,undefined);
});
test('missing metadata is Unknown, not inferred from alternate fields or fabricated results',async()=>{
 const r=await readDraftActivity(options(async()=>page([{resource,domainId:'platform',createdAt:'fake',requesterSubject:'fake',status:'SUCCEEDED'}])));
 const html=draftActivityHtml(r.events);assert.equal((html.match(/<td>Unknown<\/td>/g)||[]).length,4);assert.doesNotMatch(html,/fake|SUCCEEDED|snapshot|before|after/i);
 assert.doesNotMatch(draftActivityHtml([event({actor:'<img src=x>',reason:'<script>x</script>'})]),/<img|<script/);
});
test('empty complete history explicitly limited to available audit records',()=>{assert.match(draftActivityHtml([]),/No activity records available/);assert.match(draftActivityHtml([]),/not proof/)});
for(const context of ['identity','domain','epoch','detached'])test(`changed ${context} cancels between pages`,async()=>{
 let current=true,calls=0;const r=await readDraftActivity({...options(async()=>{calls++;current=false;return page([event()],'next')}),current:()=>current});assert.equal(r.canceled,true);assert.equal(calls,1);assert.equal(r.events,undefined);
});
class Node {
 constructor(){this.children=[];this.dataset={};this.isConnected=true;this.disabled=false;this.hidden=false;this.textContent='';this.nodes={};}
 append(n){this.children.push(n)}
 set innerHTML(s){this.html=s;this.nodes={};if(s.includes('data-activity-toggle')){this.nodes['[data-activity-toggle]']=new Node();this.nodes['[data-activity-panel]']=new Node();}if(s.includes('data-activity-retry'))this.nodes['[data-activity-retry]']=new Node();}
 get innerHTML(){return this.html||''}
 querySelector(s){return this.nodes[s]||null}
 querySelectorAll(s){return this.children.filter(n=>s==='[data-policy]'?n.dataset.policy:s==='[data-alertpol]'?n.dataset.alertpol:false)}
 setAttribute(k,v){this[k]=v}
}
globalThis.document={createElement:()=>new Node()};
function mount(read,{kind='policy',enabled=false,domain='platform'}={}){
 const root=new Node(),card=new Node();card.dataset[kind==='policy'?'policy':'alertpol']='synthetic-draft';root.append(card);let identity='a/platform',valid=true;
 mountDraftActivity(root,{catalog:{domainId:domain,policies:[{id:'synthetic-draft',enabled}]},kind,read,current:()=>valid,identity:()=>identity});
 const container=card.children[0];return {root,card,container,button:container?.querySelector('[data-activity-toggle]'),panel:container?.querySelector('[data-activity-panel]'),identity:v=>identity=v,valid:v=>valid=v};
}
test('actual Activity click loads exact key; Retry starts from first page after failure',async()=>{
 let good=false,calls=0;const h=mount(async()=>{calls++;return good?page([event()]):{ok:false,code:'FORBIDDEN'}});
 await h.button.onclick();assert.match(h.panel.innerHTML,/do not have access/);assert.doesNotMatch(h.panel.innerHTML,/synthetic-actor/);good=true;await h.panel.querySelector('[data-activity-retry]').onclick();assert.equal(calls,2);assert.match(h.panel.innerHTML,/synthetic-actor/);
});
test('later page exception clears history and supports retry',async()=>{
 let n=0;const h=mount(async()=>{if(++n===2)throw Error('private error');return page([event()],n===1?'next':null)});
 await h.button.onclick();assert.match(h.panel.innerHTML,/unavailable/);assert.doesNotMatch(h.panel.innerHTML,/synthetic-actor|private error/);await h.panel.querySelector('[data-activity-retry]').onclick();assert.match(h.panel.innerHTML,/synthetic-actor/);
});
for(const change of ['identity','domain','epoch','detached','close'])test(`actual late response not rendered after ${change}`,async()=>{
 let finish;const h=mount(()=>new Promise(r=>finish=r));const pending=h.button.onclick();
 if(change==='identity')h.identity('b/platform');else if(change==='domain')h.identity('a/other');else if(change==='epoch')h.valid(false);else if(change==='detached')h.root.isConnected=false;else await h.button.onclick();
 finish(page([event()]));await pending;assert.doesNotMatch(h.panel.innerHTML,/synthetic-actor/);
});
test('alert key differs, no cross-kind display',async()=>{
 const h=mount(async()=>page([event(),event({resource:'alert-policy/platform/synthetic-draft',actor:'alert-actor'})]),{kind:'alert'});await h.button.onclick();assert.match(h.panel.innerHTML,/alert-actor/);assert.doesNotMatch(h.panel.innerHTML,/synthetic-actor/);
});
test('enabled and nonplatform records do not gain Activity draft entry',()=>{assert.equal(mount(async()=>page([]),{enabled:true}).container,undefined);assert.equal(mount(async()=>page([]),{domain:'other'}).container,undefined)});

test('actual app mounts Activity on both hosted draft catalogs without modifying writers',async()=>{
 const {fn}=await import('./test-support/model-approval-harness.mjs');
 const vm=await import('node:vm');
 for(const [loader,id,kind] of [['loadHitl','hitlpolicies','policy'],['loadGovAlerts','alertpolicies','alert']]){
  const box={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>({})},mounted=[];
  const catalog={ok:true,domainId:'platform',policies:[]};
  const ctx=vm.createContext({document:{getElementById:key=>key===id?box:null},adminReadStart:()=>()=>true,adminRead:async()=>catalog,readHostedHitlPolicies:async()=>catalog,adminReadFailure:()=>false,authMode:()=> 'cognito',approvalCatalogView:()=>'',alertCatalogHtml:()=>'',alertRaciHtml:()=>'',validAlertCatalogResponse:()=>true,SESSION:{role:'reader'},hasCap:()=>false,sessionTaskHandler:f=>f,hostedModelReadContext:()=> 'synthetic/platform',rawApi:async p=>p,mountDraftActivity:(root,options)=>mounted.push([root,options])});
  vm.runInContext(fn(loader),ctx);await ctx[loader]();assert.equal(mounted.length,1);assert.equal(mounted[0][0],box);assert.equal(mounted[0][1].kind,kind);assert.equal(await mounted[0][1].read('/operations/audit?limit=50'),'/operations/audit?limit=50');
 }
});
