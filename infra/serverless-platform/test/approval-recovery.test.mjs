// Targeted recovery regression adapted from the fixed aff11e6 audit A1–A5.
// Actual app functions and service/state adapters; synthetic DOM/SDK/transport only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {capabilitiesForRole} from '../lambda/authz/capabilities.mjs';
import {hostedActionEnabled,hostedApprovalActionEnabled} from '../../../console/public/hosted-persona.mjs';
import {hostedApprovalRequest} from '../../../console/public/hosted-approval-request.mjs';
import {collectPagedItems} from '../../../console/public/main-ui-compat.mjs';
import {projectPendingWork} from '../../../console/public/pending-work.mjs';
import {registryDecisionAllowed} from '../../../console/public/registry-decision-target.mjs';
import {workflowFixture,REGISTRY,RECORD} from './support/approval-workflow-fixture.mjs';
const source=readFileSync(new URL('../../../console/public/modules/app.mjs',import.meta.url),'utf8');
const extracted=[];
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0,name);const end=source.indexOf('\n}',start)+2;extracted.push({name,line:source.slice(0,start).split('\n').length});return source.slice(start,end);}
// Minimal DOM I/O implementation: parse actual emitted buttons, discard old nodes on render.
const dataKey=sel=>sel.slice(6,-1).replace(/-([a-z])/g,(_,x)=>x.toUpperCase());
const parseButtons=(html,closest)=>[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m=>{const attrs=m[1],dataset={};for(const a of attrs.matchAll(/data-([\w-]+)(?:="([^"]*)")?/g))dataset[a[1].replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=a[2]||'';return {dataset,disabled:/\bdisabled\b/.test(attrs),isConnected:true,classes:(attrs.match(/class="([^"]*)"/)||[])[1]||'',text:m[2],closest};});
const selectFrom=(nodes,sel)=>sel.startsWith('.')?nodes.filter(n=>n.classes.split(' ').includes(sel.slice(1))):sel.startsWith('[data-')?nodes.filter(n=>Object.hasOwn(n.dataset,dataKey(sel))):[];
// Row-scoped notice created by the actual renderer via document.createElement and appended to the row article.
function element(){const el={dataset:{},buttons:[],_html:'',get innerHTML(){return el._html;},set innerHTML(html){el._html=html;el.buttons=parseButtons(html,()=>null);},querySelector:sel=>selectFrom(el.buttons,sel)[0]||null};return el;}
class Box {
 constructor(){this.isConnected=true;this.nodes=[];this.reason={value:'Synthetic reviewed evidence'};this._html='';const row={isConnected:true,notices:[],querySelector:sel=>row.notices.filter(n=>Object.hasOwn(n.dataset,dataKey(sel)))[0]||null,append:(...nodes)=>{row.notices.push(...nodes);}};this.row=row;}
 set innerHTML(html){for(const n of this.nodes)n.isConnected=false;this._html=html;this.row.notices=[];this.nodes=parseButtons(html,sel=>sel==='article'?this.row:null);}
 get innerHTML(){return this._html+this.row.notices.map(n=>n.innerHTML).join('');}
 noticeButtons(){return this.row.notices.flatMap(n=>n.buttons);}
 contains(n){return n===this.row||this.nodes.includes(n)||this.noticeButtons().includes(n);}
 querySelectorAll(sel){return selectFrom([...this.nodes,...this.noticeButtons()],sel);}
 querySelector(sel){if(sel.startsWith('[data-reason-for='))return this.reason;return this.querySelectorAll(sel)[0]||null;}
}
const names=['hostedCollectionRow','hostedStatus','hostedCollectionItems','hostedApprovalRecordAllowed','hostedApprovalReadOnlyReason','sameHostedApprovalRecord','revalidateHostedApproval','wireHostedApprovalActions','readHostedCollection','adminRead','adminReadState','adminReadHtml','adminReadStart','adminReadFailure','loadAdminApprovalQueue','loadRequests','loadBlueprintSubmissions','readGovPendingWork','loadGovMemBacklog','pendingWorkSummaryHtml','loadGovQueue','readHostedHitlPolicies','loadHitl','handleUnauthorized','runSessionTask','beginSessionRequest','clearHostedRegistryReadCache','invalidateSessionWork','clearBusinessDrafts','setSession','createUserState','replaceSession','resetSignedOutState','apiErrorMessage','govPoliciesTab'];
function ui({role='admin',domain='platform',transport}={}){
 const boxes=Object.fromEntries(['govqueue','reqinbox','bpsublist','hitlpolicies'].map(id=>[id,new Box()]));const calls=[],alerts=[];let seq=0;
 const ctx=vm.createContext({crypto:webcrypto,TextEncoder,AbortController,activeSessionRequests:new Set(),activeSessionTimeouts:new Set(),activeSessionIntervals:new Set(),clearTimeout,clearInterval,hostedRegistryReadCache:null,cognitoBootstrapError:'',mockLoginAttempt:null,scratchPrevTimer:null,businessForms:{clear:()=>{}},wizardDirty:{clear:()=>{}},composeDirty:{clear:()=>{}},projectBudgetDirty:()=>false,approvalReasonDrafts:{isDirty:()=>false,discard:()=>{}},approvalReasonScope:()=>({}),S:{},SESSION:{actor:'synthetic-reviewer',user:'synthetic-reviewer',role},domain,sessionEpoch:0,CANCELED_REQUEST:Symbol('cancel'),Set,URLSearchParams,JSON,CSS:{escape:x=>x},document:{getElementById:id=>boxes[id]||null,createElement:()=>element()},esc:x=>String(x??''),authMode:()=> 'cognito',hostedActionEnabled,hostedApprovalActionEnabled,hostedApprovalRequest,collectPagedItems,projectPendingWork,registryDecisionAllowed,apiErrorMessage:(r,f)=>r?.message||r?.code||f,sessionTaskHandler:f=>f,runSessionTask:f=>f(),createRequestId:()=>`synthetic-request-${++seq}`,alert:x=>alerts.push(x),requestDemoChoice:async()=> 'Synthetic reviewed evidence',SHIELD_IC:'',REG_TYPE_ICON:{},ICONS:{registry:''},ic2:()=>'',srcBadge:()=>'',REGISTRY:'',hostedEmpty:()=>'',HOSTED_COLLECTION_META:{approvals:{title:'Approvals'}},clearAuthentication:()=>{},clearDemoAssist:()=>{},queueMicrotask:f=>f(),render:()=>{for(const b of Object.values(boxes)){b.innerHTML='';b.isConnected=false;}}});
 ctx.activeDomain=()=>ctx.domain;ctx.hostedCaps=()=>capabilitiesForRole(ctx.SESSION?.role);ctx.hasCap=c=>ctx.hostedCaps().includes(c);ctx.sessionEpochIsCurrent=e=>e===ctx.sessionEpoch;ctx.hostedModelReadContext=()=>JSON.stringify([ctx.SESSION,ctx.domain]);
 ctx.resetSignedOutState=()=>{ctx.sessionEpoch++;ctx.SESSION=null;ctx.S={};};
 ctx.beginSessionRequest=()=>({epoch:ctx.sessionEpoch,controller:{signal:null}});ctx.sessionRequestIsCurrent=r=>r.epoch===ctx.sessionEpoch;ctx.finishSessionRequest=()=>{};ctx.apiUrl=p=>p;ctx.authHeaders=()=>({});
 ctx.fetch=async(path,options)=>{const body=options.body?JSON.parse(options.body):undefined;const requestId=options.headers['x-request-id'];calls.push({method:options.method,path,body,options:{requestId}});const r=await transport(path,body,{requestId});const status=typeof r.status==='number'?r.status:200;return {status,ok:status<400,text:async()=>JSON.stringify(r)};};
 // The bundle's reload-retry store (createApprovalDecisionRetries, 745615b) is Map-compatible; a Map keeps these
 // same-session semantics observable (values/clear), as in console/test-support/model-approval-harness.mjs.
 vm.runInContext('globalThis.pendingHostedApprovalDecisions=new Map()',ctx);
 for(const n of names)vm.runInContext(fn(n),ctx);
 vm.runInContext(source.slice(source.indexOf('const rawApi = async'),source.indexOf('\n}',source.indexOf('const rawApi = async'))+2)+'\nglobalThis.rawApi=rawApi;globalThis.api=rawApi;',ctx);
 vm.runInContext('globalThis.sessionTaskHandler=task=>(...args)=>runSessionTask(()=>task(...args));globalThis.finishSessionRequest=request=>activeSessionRequests.delete(request);',ctx);
 // Hosted Approval policies is a read-only catalog card (6337b74): no create control, no local policy writers.
 const shell=ctx.govPoliciesTab();assert.match(shell,/id="hitlpolicies"/);assert.doesNotMatch(shell,/hpcreate|Create a policy|class="[^"]*(?:htoggle|hpdel)/);
 return {ctx,boxes,calls,alerts};
}
async function check(id,label,task){await test(`${id}: ${label}`,task);}
const buttons=b=>b.querySelectorAll('.hostedapproval');
async function approvalEnv(){
 const f=workflowFixture();await f.draft();const c=await f.context();const submitted=await f.call('/api/governance/publications',{body:{registryId:REGISTRY,recordId:RECORD,approvalId:c.approvalId,expectedRecordVersion:c.recordVersion},requestId:`submit-${c.approvalId}`});assert.equal(submitted.ok,true,JSON.stringify(submitted));
 const rows=async()=>({ok:true,resource:'approvals',cursor:null,items:(await f.state.listApprovals({domainId:'domain_a'})).items});
 return {f,rows};
}
await check('A1','Lost failure response: same-view retry keeps ID and button recovers; actual service readback',async()=>{
 const {f,rows}=await approvalEnv();let fail=true;const h=ui({role:'lead',domain:'domain_a',transport:async(p,b,o)=>{if(!b)return p==='/registry'?{ok:true,source:'aws',entries:[]}:rows();if(fail){fail=false;throw Error('Synthetic transport loss before delivery');}return f.call('/api'+p,{actor:'synthetic-reviewer',role:'lead',body:b,requestId:o.requestId});}});
 await h.ctx.loadGovQueue();const b=buttons(h.boxes.govqueue)[0];assert.ok(b);await b.onclick();assert.equal(b.disabled,false);const first=h.calls.find(x=>x.method==='POST').options.requestId;await b.onclick();assert.equal(h.calls.filter(x=>x.method==='POST')[1].options.requestId,first);const actual=(await rows()).items[0].status;assert.equal(actual,'APPROVED');assert.equal(buttons(h.boxes.govqueue).length,0);return {id:first,persisted:actual,posts:2};
});
await check('A2','Refresh after uncertain failure must retain original decision request ID',async()=>{
 const {f,rows}=await approvalEnv();const send=f.registryClient.send.bind(f.registryClient);f.registryClient.send=async command=>{if(command.constructor.name==='UpdateRegistryRecordStatusCommand')throw Error('Synthetic Registry response loss after reservation');return send(command);};const backend=[];const h=ui({role:'lead',domain:'domain_a',transport:async(p,b,o)=>{if(!b)return p==='/registry'?{ok:true,source:'aws',entries:[]}:rows();const r=await f.call('/api'+p,{actor:'synthetic-reviewer',role:'lead',body:b,requestId:o.requestId});backend.push(r);return r;}});
 await h.ctx.loadGovQueue();await buttons(h.boxes.govqueue)[0].onclick();const first=h.calls.find(x=>x.method==='POST').options.requestId;await h.ctx.loadGovQueue();await buttons(h.boxes.govqueue)[0].onclick();const second=h.calls.filter(x=>x.method==='POST')[1].options.requestId;console.log('OBSERVED A2',JSON.stringify({first,second,backend,alerts:h.alerts}));assert.equal(second,first,'Refresh recreated button and lost the original request ID');assert.equal(backend[0].status,503);assert.equal(backend[1].status,503,'Identical claim resumes after a failed Registry write; the Registry is still unavailable, so the retry stays retryable');assert.equal(f.commands.filter(c=>c==='UpdateRegistryRecordStatusCommand').length,0);return {first,second};
});
await check('A3','Backend committed but response lost: retry reads terminal state and does not POST again',async()=>{
 const {f,rows}=await approvalEnv();const h=ui({role:'lead',domain:'domain_a',transport:async(p,b,o)=>{if(!b)return p==='/registry'?{ok:true,source:'aws',entries:[]}:rows();const r=await f.call('/api'+p,{actor:'synthetic-reviewer',role:'lead',body:b,requestId:o.requestId});assert.equal(r.ok,true);throw Error('Synthetic response lost after commit');}});
 await h.ctx.loadGovQueue();const b=buttons(h.boxes.govqueue)[0];await b.onclick();await b.onclick();assert.equal(h.calls.filter(x=>x.method==='POST').length,1);const staleActions=buttons(h.boxes.govqueue).filter(b=>!b.disabled).length;console.log('OBSERVED A3',JSON.stringify({persisted:(await rows()).items[0].status,staleActions,alerts:h.alerts}));assert.equal(staleActions,0,'Terminal readback detected, but stale Approve/Reject remain enabled');
});
await check('A4','Failed Access request action followed by role/domain switch never resends old action',async()=>{
 const row={id:'synthetic-access',kind:'RESOURCE_ACCESS',resourceType:'AGENT',resourceId:'synthetic-agent',projectId:null,domainId:'domain_a',requesterSubject:'synthetic-applicant',requestedAt:'2026-09-12T10:00:00Z',status:'PENDING'};
 const h=ui({role:'lead',domain:'domain_a',transport:async(p,b)=>b?{ok:false,status:503,code:'WORKSPACE_UNAVAILABLE'}:{ok:true,resource:'approvals',items:[row],cursor:null}});await h.ctx.loadRequests();const b=buttons(h.boxes.reqinbox)[0];await b.onclick();assert.equal(b.disabled,false);h.ctx.SESSION.role='builder';await b.onclick();h.ctx.SESSION.role='lead';h.ctx.domain='domain_b';await b.onclick();assert.equal(h.calls.filter(x=>x.method==='POST').length,1);return {posts:1,oldRoleAndDomainClickBlocked:true};
});
await check('A5','Platform approvals refreshed to terminal/self/unsupported records exposes no decision buttons',async()=>{
 let items=[{id:'synthetic-blueprint',kind:'RESOURCE_PUBLICATION',resourceType:'BLUEPRINT',resourceId:'synthetic-resource',domainId:'platform',projectId:null,requesterSubject:'synthetic-applicant',status:'PENDING'}];
 const h=ui({transport:async(p,b)=>b?{ok:false,status:503}:{ok:true,resource:'approvals',items,cursor:null}});await h.ctx.loadBlueprintSubmissions();await buttons(h.boxes.bpsublist)[0].onclick();items=[{...items[0],status:'APPROVED'},{...items[0],id:'synthetic-self',requesterSubject:'synthetic-reviewer'}];await h.ctx.loadBlueprintSubmissions();assert.equal(buttons(h.boxes.bpsublist).length,0);const html=h.ctx.hostedCollectionItems('approvals',[{...items[0],status:'PENDING',resourceType:'MEMORY'}],{approvalActions:true});assert.doesNotMatch(html,/class="ghost hostedapproval"/);return {visibleRecords:2,decisionButtons:0};
});
// New boundaries deliberately use the same actual app/adapter chain as A1–A3.
const posts=h=>h.calls.filter(x=>x.method==='POST');
const pendingEntries=h=>vm.runInContext('Array.from(pendingHostedApprovalDecisions.values())',h.ctx);
async function failedDecision(){
 const env=await approvalEnv();
 const h=ui({role:'lead',domain:'domain_a',transport:async(p,b,o)=>{
  if(!b)return p==='/registry'?{ok:true,entries:[]}:env.rows();
  throw Error('Synthetic uncertain transport');
 }});
 await h.ctx.loadGovQueue();await buttons(h.boxes.govqueue)[0].onclick();
 return {...env,h};
}
await check('R1','Refresh alone never replays; exact payload deliberately retried uses original ID; Map contains no raw reason/token',async()=>{
 const {h}=await failedDecision();const first=posts(h)[0].options.requestId;
 await h.ctx.loadGovQueue();assert.equal(posts(h).length,1);
 const values=pendingEntries(h);assert.equal(values.length,1);assert.deepEqual(Object.keys(values[0]).sort(),['fingerprint','inFlight','requestId']);assert.match(values[0].fingerprint,/^[0-9a-f]{64}$/);assert.doesNotMatch(JSON.stringify(values),/Synthetic reviewed evidence|token/i);
 await buttons(h.boxes.govqueue)[0].onclick();assert.equal(posts(h)[1].options.requestId,first);
});
for(const change of ['reason','opposite'])await check(`R2-${change}`,'Unresolved decision rejects replacement payload without new POST/ID',async()=>{
 const {h}=await failedDecision();await h.ctx.loadGovQueue();
 if(change==='reason')h.boxes.govqueue.reason.value='Different synthetic reason';
 await buttons(h.boxes.govqueue)[change==='opposite'?1:0].onclick();assert.equal(posts(h).length,1);assert.equal(pendingEntries(h).length,1);assert.match(h.alerts.at(-1),/unresolved/);
});
for(const change of ['actor','role','domain'])await check(`R3-${change}`,'Stale handler cannot retry after scope mutation',async()=>{
 const {h}=await failedDecision();const click=buttons(h.boxes.govqueue)[0].onclick;
 if(change==='domain')h.ctx.domain='domain_b';else h.ctx.SESSION[change]=change==='role'?'builder':'synthetic-other';
 await click();assert.equal(posts(h).length,1);
});
await check('R4','Actual logout/session replacement clears metadata; retained handler performs no replay',async()=>{
 const {h}=await failedDecision();const click=buttons(h.boxes.govqueue)[0].onclick;
 h.ctx.resetSignedOutState();assert.equal(h.ctx.SESSION,null);assert.equal(pendingEntries(h).length,0);await click();assert.equal(posts(h).length,1);
 h.ctx.replaceSession({actor:'synthetic-other',role:'lead'});assert.equal(pendingEntries(h).length,0);await click();assert.equal(posts(h).length,1);
});
for(const mode of ['terminal','ineligible','read-error','read-throw','success'])await check(`R5-${mode}`,'Retire both actions before failing reload; read-only Retry cannot write',async()=>{
 const {f,rows}=await approvalEnv();let reads=0;
 const h=ui({role:'lead',domain:'domain_a',transport:async(p,b,o)=>{
  if(b){const result=await f.call('/api'+p,{actor:'synthetic-reviewer',role:'lead',body:b,requestId:o.requestId});assert.equal(result.ok,true);if(mode==='success')return result;throw Error('Synthetic lost response after commit');}
  if(p==='/registry')return {ok:true,entries:[]};
  reads++;
  if(reads>1&&mode==='read-error')return {ok:false,status:503};
  if(reads>1&&mode==='read-throw')throw Error('Synthetic read failure');
  const r=await rows();if(reads>1&&mode==='ineligible')r.items[0].requesterSubject='synthetic-reviewer';return r;
 }});
 const initial=(await rows()).items;const box=h.boxes.govqueue;box.innerHTML=h.ctx.hostedCollectionItems('approvals',initial,{approvalActions:true});let reloads=0;
 h.ctx.wireHostedApprovalActions(box,async()=>{reloads++;assert.equal(buttons(box).filter(b=>!b.disabled).length,0);assert.ok(buttons(box).every(b=>b.onclick===null));throw Error('Synthetic reload failure');},initial);
 const old=buttons(box),clicks=old.map(b=>b.onclick);await clicks[0]();if(mode!=='success')await clicks[0]();
 assert.equal(posts(h).length,1);assert.equal(f.commands.filter(c=>c==='UpdateRegistryRecordStatusCommand').length,1);
 assert.ok(old.every(b=>b.disabled));assert.equal(buttons(box).filter(b=>!b.disabled).length,0);assert.match(box.innerHTML,/could not confirm this request.s status\. Decisions are read-only/);
 for(const click of clicks)await click();assert.equal(posts(h).length,1);
 const retry=box.querySelector('[data-approval-retry]');assert.ok(retry);await retry.onclick();assert.equal(posts(h).length,1);assert.equal(retry.disabled,false);assert.ok(reloads>0);
});
await check('R6','Registry applied then 503 after reservation; same-session refresh exact retry reconciles once',async()=>{
 const {f,rows}=await approvalEnv();const send=f.registryClient.send.bind(f.registryClient);let fail=true;
 f.registryClient.send=async command=>{const response=await send(command);if(command.constructor.name==='UpdateRegistryRecordStatusCommand'&&fail){fail=false;throw Error('Synthetic Registry success response lost');}return response;};
 const backend=[];const h=ui({role:'lead',domain:'domain_a',transport:async(p,b,o)=>{if(!b)return p==='/registry'?{ok:true,entries:[]}:rows();const r=await f.call('/api'+p,{actor:'synthetic-reviewer',role:'lead',body:b,requestId:o.requestId});backend.push(r);return r;}});
 await h.ctx.loadGovQueue();await buttons(h.boxes.govqueue)[0].onclick();assert.equal(backend[0].status,503);await h.ctx.loadGovQueue();assert.equal(posts(h).length,1);await buttons(h.boxes.govqueue)[0].onclick();assert.equal(posts(h)[0].options.requestId,posts(h)[1].options.requestId);assert.equal(backend[1].ok,true,JSON.stringify(backend));assert.equal((await rows()).items[0].status,'APPROVED');assert.equal(f.commands.filter(c=>c==='UpdateRegistryRecordStatusCommand').length,1);assert.equal(pendingEntries(h).length,0);
 console.log('OBSERVED R6',JSON.stringify({statuses:backend.map(r=>r.status),requestIds:posts(h).map(p=>p.options.requestId),registryWrites:1}));
});
await check('R7','Fresh different actor never inherits pending ID; server reservation refuses second reviewer',async()=>{
 const {f,rows}=await approvalEnv();const send=f.registryClient.send.bind(f.registryClient);f.registryClient.send=async c=>{if(c.constructor.name==='UpdateRegistryRecordStatusCommand')throw Error('Synthetic pre-write failure');return send(c);};const backend=[];
 const h=ui({role:'lead',domain:'domain_a',transport:async(p,b,o)=>{if(!b)return p==='/registry'?{ok:true,entries:[]}:rows();const r=await f.call('/api'+p,{actor:h.ctx.SESSION.actor,role:'lead',body:b,requestId:o.requestId});backend.push(r);return r;}});
 await h.ctx.loadGovQueue();await buttons(h.boxes.govqueue)[0].onclick();h.ctx.replaceSession({actor:'synthetic-other',role:'lead'});assert.equal(pendingEntries(h).length,0);assert.equal(posts(h).length,1);await h.ctx.loadGovQueue();await buttons(h.boxes.govqueue)[0].onclick();assert.notEqual(posts(h)[0].options.requestId,posts(h)[1].options.requestId);assert.equal(backend[1].status,409);assert.equal(f.commands.filter(c=>c==='UpdateRegistryRecordStatusCommand').length,0);
});
await check('R8','Refresh during in-flight write cannot issue simultaneous deliberate duplicate',async()=>{
 const {rows}=await approvalEnv();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const h=ui({role:'lead',domain:'domain_a',transport:async(p,b)=>{if(!b)return p==='/registry'?{ok:true,entries:[]}:rows();entered();await gate;return {ok:false,status:503};}});
 await h.ctx.loadGovQueue();const task=buttons(h.boxes.govqueue)[0].onclick();await started;await h.ctx.loadGovQueue();await buttons(h.boxes.govqueue)[0].onclick();assert.equal(posts(h).length,1);release();await task;await buttons(h.boxes.govqueue)[0].onclick();assert.equal(posts(h).length,2);assert.equal(posts(h)[0].options.requestId,posts(h)[1].options.requestId);
});
await check('R9','Read-only retry retained across domain/session change sends zero reads or writes',async()=>{
 const {h}=await failedDecision();h.ctx.revalidateHostedApproval=async()=>({state:'unavailable'});await buttons(h.boxes.govqueue)[0].onclick();const retry=h.boxes.govqueue.querySelector('[data-approval-retry]');const before=h.calls.length;h.ctx.domain='domain_b';await retry.onclick();h.ctx.replaceSession({actor:'synthetic-other',role:'lead'});await retry.onclick();assert.equal(h.calls.length,before);
});
await check('R10','Shared revalidation retains record/null default contract for model drawer',async()=>{
 const {appHarness}=await import('../../../console/test-support/model-approval-harness.mjs');
 const h=appHarness({surface:'drawer'});
 // Existing fixed-baseline harness omits this bootstrap global (baseline fails
 // before any read). Supply that environment seam, not a product guard override.
 h.ctx.cognitoBootstrapError='';
 const record=await h.ctx.revalidateHostedApproval(h.row,()=>true);assert.equal(record.id,h.row.id);assert.equal(record.state,undefined);
 await h.button.onclick();assert.equal(h.writes.length,1);assert.equal(h.writes[0].path,'/api/ai-gateway/model-access-decisions');
 h.store.rows[0].status='APPROVED';assert.equal(await h.ctx.revalidateHostedApproval(h.row,()=>true),null);
});
