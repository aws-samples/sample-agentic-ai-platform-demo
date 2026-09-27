import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {fn} from './test-support/model-approval-harness.mjs';
import {collectPagedItems,adaptAudit} from './public/main-ui-compat.mjs';
const event=(id,actor)=>({resource:`approval/platform/${id}`,timestamp:'2026-09-14T00:00:00Z',requestId:id,actor,requesterSubject:'synthetic-requester',action:'approval.update',domainId:'platform',reason:'Synthetic review'});
function harness(read){const calls=[];const ctx=vm.createContext({collectPagedItems,adaptAudit,URLSearchParams,activeDomain:()=>null,rawApi:async p=>{calls.push(p);return read(p);}});vm.runInContext(fn('mainCompatApi'),ctx);return {ctx,calls};}
test('audit export uses all authorized pages and real actor/resource with zero mutation',async()=>{const h=harness(p=>({ok:true,resource:'audit',items:[event(p.includes('cursor')?'second':'first','synthetic-decider')],cursor:p.includes('cursor')?null:'next'}));const r=await h.ctx.mainCompatApi('/integrations-audit-export');assert.equal(r.ok,true);assert.equal(r.count,2);assert.equal(r.events[0].who,'synthetic-decider');assert.equal(r.events[0].subject,'approval/platform/first');assert.deepEqual(h.calls,['/operations/audit?limit=50','/operations/audit?limit=50&cursor=next']);});
test('later-page audit failure never exports an apparently complete subset',async()=>{for(const fault of [{ok:false,status:403},{ok:true,resource:'audit',items:[],cursor:null,partial:true}]){const h=harness(p=>p.includes('cursor')?fault:{ok:true,resource:'audit',items:[event('first','a')],cursor:'next'});const r=await h.ctx.mainCompatApi('/integrations-audit-export');assert.equal(r.ok,false);assert.equal(r.events,undefined);}});
test('audit filtering preserves actual actor identity',async()=>{const h=harness(()=>({ok:true,resource:'audit',items:[event('first','a'),{...event('second','b'),action:'approval.create'}],cursor:null}));const r=await h.ctx.mainCompatApi('/audit-trail?type=approval.update&domain=platform');assert.equal(r.events.length,1);assert.equal(r.events[0].who,'a');});


test('export applies type and domain filters after all authorized pages, including encoded values',async()=>{
 const h=harness(p=>({ok:true,resource:'audit',items:p.includes('cursor')?[{...event('selected','decider'),action:'approval & update',domainId:'synthetic domain'},event('wrong-domain','other')]:[event('wrong-type','other')],cursor:p.includes('cursor')?null:'next'}));
 const r=await h.ctx.mainCompatApi('/integrations-audit-export?type=approval%20%26%20update&domain=synthetic%20domain');
 assert.equal(r.ok,true);assert.equal(r.count,1);assert.equal(r.events[0].who,'decider');assert.equal(r.events[0].subject,'approval/platform/selected');assert.equal(h.calls.length,2);
});
function clickHarness(read){
 const calls=[],downloads=[],revoked=[],nodes={siemexport:{disabled:false,isConnected:true},siemstatus:{innerHTML:'',isConnected:true},audexportscope:{textContent:''},audftype:{value:''},audfdomain:{value:''}};
 const ctx=vm.createContext({S:{audFType:'approval.update',audFDomain:'synthetic domain'},URLSearchParams,sessionEpoch:1,sessionEpochIsCurrent:e=>e===ctx.sessionEpoch,hostedModelReadContext:()=>ctx.identity,identity:'actor-a/domain-a',sessionTaskHandler:f=>f,api:async(p,b)=>{calls.push([p,b]);return read(p)},CANCELED_REQUEST:Symbol('cancel'),esc:s=>String(s),Blob:class{constructor(parts){this.parts=parts}},URL:{createObjectURL:b=>{downloads.push(JSON.parse(b.parts[0]));return 'blob:synthetic'},revokeObjectURL:u=>revoked.push(u)},document:{getElementById:id=>nodes[id],createElement:()=>({click(){}})},runSessionTask:()=>{},loadAudit:()=>{}});
 for(const name of ['auditFilterQuery','auditExportScopeLabel','syncAuditExportScope','wireAudit','wireGovSiemExport'])vm.runInContext(fn(name),ctx);
 ctx.wireAudit();ctx.wireGovSiemExport();return {ctx,nodes,calls,downloads,revoked};
}
const response={ok:true,count:1,events:[{type:'approval.update',domain:'synthetic domain',who:'synthetic-decider',subject:'synthetic-resource'}]};
test('actual click captures both filters and labels scope, downloading only returned metadata',async()=>{
 const h=clickHarness(async()=>response);assert.match(h.nodes.audexportscope.textContent,/approval.update/);assert.match(h.nodes.audexportscope.textContent,/synthetic domain/);
 await h.nodes.siemexport.onclick();assert.deepEqual(h.calls,[['/integrations-audit-export?type=approval.update&domain=synthetic+domain',undefined]]);assert.deepEqual(h.downloads,[response.events]);assert.equal(h.revoked.length,1);assert.equal(h.nodes.siemexport.disabled,false);assert.match(h.nodes.siemstatus.innerHTML,/synthetic domain/);
});
for(const change of ['type','domain','away-and-back','identity','epoch','detached','replaced'])test(`actual export never downloads stale data after ${change}`,async()=>{
 let finish;const h=clickHarness(()=>new Promise(r=>finish=r));const task=h.nodes.siemexport.onclick();
 if(change==='type'||change==='domain'||change==='away-and-back'){
  const key=change==='domain'?'audfdomain':'audftype';const old=h.ctx.S[change==='domain'?'audFDomain':'audFType'];h.nodes[key].value='changed';h.nodes[key].onchange();
  if(change==='away-and-back'){h.nodes[key].value=old;h.nodes[key].onchange();}
 }else if(change==='identity')h.ctx.identity='actor-b/domain-b';else if(change==='epoch')h.ctx.sessionEpoch++;
 else if(change==='detached')h.nodes.siemstatus.isConnected=false;else h.nodes.siemstatus={innerHTML:'new page',isConnected:true};
 finish(response);await task;assert.equal(h.downloads.length,0);
});
for(const fault of ['reject','partial'])test(`actual handler ${fault} produces no file and permits retry`,async()=>{
 const h=clickHarness(async()=>{if(fault==='reject')throw Error('synthetic failure');return {ok:false,error:'Audit incomplete'}});await h.nodes.siemexport.onclick();assert.equal(h.downloads.length,0);assert.equal(h.nodes.siemexport.disabled,false);assert.match(h.nodes.siemstatus.innerHTML,/failed|incomplete/);
});

test('actual handler defaults to all authorized metadata and filters wider fallback responses',async()=>{
 const h=clickHarness(async()=>({...response,events:[...response.events,{...response.events[0],type:'other'}]}));
 await h.nodes.siemexport.onclick();assert.equal(h.downloads[0].length,1);
 h.ctx.S.audFType='';h.ctx.S.audFDomain='';await h.nodes.siemexport.onclick();assert.equal(h.calls[1][0],'/integrations-audit-export');assert.equal(h.downloads[1].length,2);
});
test('late rejected export cannot overwrite replacement status or download',async()=>{
 let reject;const h=clickHarness(()=>new Promise((_,r)=>reject=r));const task=h.nodes.siemexport.onclick();h.nodes.siemstatus={innerHTML:'new page',isConnected:true};reject(Error('old error'));await task;assert.equal(h.nodes.siemstatus.innerHTML,'new page');assert.equal(h.downloads.length,0);
});
