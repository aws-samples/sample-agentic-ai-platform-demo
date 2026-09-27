import {mountDraftActivity} from './public/draft-activity.mjs';
import {validAlertCatalogResponse,alertCatalogHtml,alertRaciHtml} from './public/alert-drafts.mjs';
import {approvalCatalogView,guardrailCatalogView} from './public/governance-policy-view.mjs';
import {mountGuardrailExceptions} from './public/guardrail-exceptions-view.mjs';
import {GUARDRAIL_CATALOG} from './public/guardrail-chain.mjs';
// OFFLINE synthetic inputs; execute actual owned app renderers, not substitute renderers.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {collectPagedItems,adaptBlueprints} from './public/main-ui-compat.mjs';
import * as workspaceTabs from './public/workspace-tabs-view.mjs';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));return start<0?'':source.slice(start,source.indexOf('\n}',start)+2);}
function harness(result={ok:false,status:404},hosted=true){
 const ids=['guardrailsettings','hitlpolicies','alertpolicies','alertraci','reqinbox','apxlist','bpsublist','wsbody'];
 const boxes=Object.fromEntries(ids.map(id=>[id,{innerHTML:'',isConnected:true,querySelectorAll:()=>[],querySelector:s=>s==='[data-alert-refresh]'?{}:null}]));
 const calls=[];const ctx=vm.createContext({mountGuardrailExceptions,GUARDRAIL_CATALOG,guardrailCatalogView,createRequestId:()=> 'synthetic-request',mountDraftActivity,validAlertCatalogResponse,alertCatalogHtml,alertRaciHtml,confirmContextChange:()=>true,hostedModelReadContext:()=>String(ctx.sessionEpoch)+'/platform',approvalCatalogView,S:{wsTab:'memorykb'},SESSION:{},sessionEpoch:0,CANCELED_REQUEST:Symbol('cancel'),Set,URLSearchParams,
  authMode:()=>hosted?'cognito':'local',sessionEpochIsCurrent:e=>e===ctx.sessionEpoch,activeDomain:()=> 'platform',
  document:{getElementById:id=>boxes[id]||null},esc:x=>String(x??''),hasCap:()=>false,
  api:async path=>{calls.push(path);return typeof result==='function'?result(path):result},
  fetch:async url=>{calls.push(url);const r=typeof result==='function'?await result(url):result;return {ok:r.status? r.status<400:r.ok!==false,status:r.status||200,json:async()=>r,text:async()=>JSON.stringify(url.startsWith('/hitl')&&r.ok===true&&Array.isArray(r.policies)?{schemaVersion:1,revision:1,domainId:'platform',updatedAt:'2026-09-12T08:00:00.000Z',source:'workspace-hitl-policy-catalog',enforcement:'NOT_CONFIGURED',cursor:null,...r,policies:r.policies.map(p=>p&&({version:1,scope:{kind:'domain'},...p}))}
   :url.startsWith('/alerts')&&r.ok===true&&Array.isArray(r.policies)?{schemaVersion:1,revision:r.policies.length?1:0,domainId:'platform',updatedAt:r.policies.length?'2026-09-12T08:00:00.000Z':null,source:'workspace-alert-policy-catalog',configured:r.policies.length>0,evaluation:'NOT_CONFIGURED',delivery:'NOT_CONFIGURED',cursor:null,...r,policies:r.policies.map(p=>p&&({version:1,createdAt:'2026-09-12T08:00:00.000Z',raci:{responsible:'',accountable:'',consulted:'',informed:''},...p}))}:r)}},
  apiUrl:p=>p,authHeaders:()=>({}),beginSessionRequest:()=>({controller:{signal:null}}),sessionRequestIsCurrent:()=>true,finishSessionRequest:()=>{},handleUnauthorized:()=>{},
  runSessionTask:()=>{},sessionTaskHandler:f=>f,loadHitlAudit:()=>{},srcBadge:()=>'',SHIELD_IC:'',BOOK_IC:'',MEM_IC:'',ICONS:{},ic2:()=>'',sevBadge:()=>'',
  hostedCollectionItems:(_,rows)=>rows.map(r=>`<article>${r.id} ${r.resourceType}</article>`).join(''),wireHostedApprovalActions:()=>{},
  collectPagedItems,adaptBlueprints,
  ...workspaceTabs,
 });
 for(const name of ['adminRead','adminReadState','adminReadHtml','adminReadStart','adminReadFailure','loadAdminApprovalQueue','govPoliciesTab','readHostedHitlPolicies','loadHitl','loadGovGuardrails','loadGovAlerts','loadRequests','loadApprovals','loadBlueprintSubmissions','loadWorkspaceTab']){const code=fn(name);if(code)vm.runInContext(code,ctx);}
 return {ctx,boxes,calls};
}
test('P1-A hosted hides illustrative interrupt/promote/statistics, retains policy entry',()=>{const {ctx}=harness();const html=ctx.govPoliciesTab();assert.doesNotMatch(html,/of last 1,000|Promote to enforce|Demo an interrupt|id="hifire"/);assert.doesNotMatch(html,/Create a policy|hpcreate/);assert.match(html,/Policy scope: platform/);});
test('P1-A local shows real Cedar engines card not fixture demo',()=>{const {ctx}=harness({},false);const html=ctx.govPoliciesTab();assert.doesNotMatch(html,/of last 1,000|Demo an interrupt|id="hifire"|Promote to enforce/);assert.match(html,/Cedar Policy Engines/);assert.match(html,/govpolicyengines/);});
for(const [label,result,state] of [['404',{ok:false,status:404},'error'],['403',{ok:false,status:403,code:'FORBIDDEN'},'forbidden'],['unconfigured',{ok:false,status:503,code:'NOT_CONFIGURED'},'unconfigured'],['malformed',{ok:true,policies:{},memories:{},docs:{}},'error'],['malformed-row',{ok:true,policies:[null],memories:[null],docs:[null]},'error']]){
 for(const [name,id] of [['loadHitl','hitlpolicies'],['loadGovAlerts','alertpolicies']])test(`P1-C ${name} ${label} actual renderer`,async()=>{const {ctx,boxes}=harness(result);await ctx[name]({id:'test-project',agents:[]});assert.match(boxes[id].innerHTML,new RegExp(`data-read-state="${state}"`));assert.doesNotMatch(boxes[id].innerHTML,/No policies yet|0 alert policies/);});
}
for(const [name,id,field] of [['loadRequests','reqinbox','requests'],['loadApprovals','apxlist','exemptions'],['loadBlueprintSubmissions','bpsublist','submissions']])test(`P1-B ${name} malformed local response is not empty`,async()=>{const {ctx,boxes}=harness({ok:true,[field]:{}},false);await ctx[name]();assert.match(boxes[id].innerHTML,/data-read-state="error"/);});
const approval=(id,kind,resourceType)=>({id,kind,resourceType,resourceId:'test-resource',domainId:'platform',projectId:null,status:'PENDING',requesterSubject:'test-person',requestedAt:'2026-09-01T00:00:00Z'});
for(const [name,id,want] of [['loadRequests','reqinbox','test-access'],['loadBlueprintSubmissions','bpsublist','test-blueprint']])test(`P1-B ${name} uses existing hosted approvals without fabricated fields`,async()=>{const rows=[approval('test-access','RESOURCE_ACCESS','MEMORY'),approval('test-blueprint','RESOURCE_PUBLICATION','BLUEPRINT'),approval('test-other','RESOURCE_PUBLICATION','SKILL')];const {ctx,boxes,calls}=harness({ok:true,resource:'approvals',items:rows,cursor:null});await ctx[name]();assert.deepEqual(calls,['/approvals?limit=50']);assert.match(boxes[id].innerHTML,new RegExp(want));assert.doesNotMatch(boxes[id].innerHTML,/test-other/);});
test('P1-C memorykb agents api network error shows unavailable message',async()=>{const {ctx,boxes}=harness(()=>{throw new Error('synthetic network error')});await ctx.loadWorkspaceTab({id:'test-project',domain:'platform',name:'Test Project'});assert.match(boxes.wsbody.innerHTML,/Memory data unavailable/);assert.doesNotMatch(boxes.wsbody.innerHTML,/data-read-state="error"/);});
test('P1-C project memories API empty resources shows configured empty state',async()=>{const {ctx,boxes}=harness({ok:true,resource:'project-memories',memories:[],knowledgeBases:[]});await ctx.loadWorkspaceTab({id:'test-project',domain:'platform',name:'Test Project'});assert.match(boxes.wsbody.innerHTML,/data-mem-empty/);assert.match(boxes.wsbody.innerHTML,/data-kb-empty/);assert.doesNotMatch(boxes.wsbody.innerHTML,/data-read-state="error"/);});
test('P1-C true local empty is preserved including legacy successful no-ok envelopes',async()=>{const {ctx,boxes}=harness({policies:[],memories:[],docs:[]},false);await ctx.loadHitl();await ctx.loadGovAlerts();assert.match(boxes.hitlpolicies.innerHTML,/No policies yet/);assert.match(boxes.alertpolicies.innerHTML,/0 alert policies/);});
for(const [name,id] of [['loadHitl','hitlpolicies'],['loadGovAlerts','alertpolicies'],['loadRequests','reqinbox'],['loadApprovals','apxlist'],['loadBlueprintSubmissions','bpsublist']])test(`P1-B/C ${name} network failure is visible and not empty`,async()=>{const {ctx,boxes}=harness(()=>{throw Error('synthetic offline')});await ctx[name]();assert.match(boxes[id].innerHTML,/data-read-state="error"/);});
test('P1-C HTTP failure cannot be overridden by JSON ok:true',async()=>{const {ctx,boxes}=harness({ok:true,status:403,policies:[]});await ctx.loadHitl();assert.match(boxes.hitlpolicies.innerHTML,/forbidden/);});
test('P1-C loading and latest-request-wins',async()=>{let resolve;const {ctx,boxes}=harness(()=>new Promise(r=>resolve=r));const old=ctx.loadGovAlerts();assert.match(boxes.alertpolicies.innerHTML,/data-read-state="loading"/);await Promise.resolve();const stale=resolve;ctx.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true,schemaVersion:1,revision:0,domainId:'platform',updatedAt:null,source:'workspace-alert-policy-catalog',configured:false,evaluation:'NOT_CONFIGURED',delivery:'NOT_CONFIGURED',cursor:null,policies:[]})});await ctx.loadGovAlerts();stale({ok:false,status:404});await old;assert.match(boxes.alertpolicies.innerHTML,/No saved alert drafts/);assert.doesNotMatch(boxes.alertpolicies.innerHTML,/data-read-state="error"/);});
test('P1-C identity change discards pending read',async()=>{let resolve;const {ctx,boxes}=harness(()=>new Promise(r=>resolve=r));const pending=ctx.loadGovAlerts();await Promise.resolve();ctx.sessionEpoch++;resolve({ok:true,policies:[]});await pending;assert.doesNotMatch(boxes.alertpolicies.innerHTML,/0 alert policies/);});
test('P1-C retry from an old session does not issue another request',()=>{const {ctx,boxes}=harness();let retried=0;const button={isConnected:true,disabled:false};boxes.alertpolicies.querySelectorAll=()=>[button];ctx.adminReadFailure(boxes.alertpolicies,{ok:false},['policies'],'/api/alerts',()=>retried++);ctx.sessionEpoch++;button.onclick();assert.equal(retried,0);});
test('P1-C missing policy enabled is malformed, not disabled or zero',async()=>{const {ctx,boxes}=harness({ok:true,policies:[{id:'test',name:'Test'}]});await ctx.loadGovAlerts();assert.match(boxes.alertpolicies.innerHTML,/data-read-state="error"/);});
test('P1-A hosted policy write entry declares missing contract and cannot simulate execution',()=>{const {ctx}=harness();assert.doesNotMatch(ctx.govPoliciesTab(),/id="hpcreate"/);});
for(const name of ['loadRequests','loadBlueprintSubmissions'])test(`P1-B ${name} missing pagination cursor fails closed`,async()=>{const {ctx,boxes}=harness({ok:true,resource:'approvals',items:[]});await ctx[name]();assert.match(boxes[name==='loadRequests'?'reqinbox':'bpsublist'].innerHTML,/data-read-state="error"/);});

for(const change of ['epoch','actor','domain','request','detached','none'])test(`P1-C Retry guard ${change}`,async()=>{
 const {ctx,boxes}=harness();let retries=0;const button={isConnected:true,disabled:false};boxes.alertpolicies.querySelectorAll=()=>[button];
 ctx.adminReadStart(boxes.alertpolicies,'/api/alerts');ctx.adminReadFailure(boxes.alertpolicies,{ok:false},['policies'],'/api/alerts',async()=>{retries++});
 if(change==='epoch')ctx.sessionEpoch++;if(change==='actor')ctx.SESSION.actor='another-synthetic-actor';if(change==='domain')ctx.activeDomain=()=> 'other-synthetic-domain';if(change==='request')ctx.adminReadStart(boxes.alertpolicies,'/api/alerts');if(change==='detached')boxes.alertpolicies.isConnected=false;
 await button.onclick();await button.onclick();assert.equal(retries,change==='none'?1:0);
});
const validPolicies={loadHitl:{id:'synthetic-policy',name:'Synthetic',enabled:true,toolMatch:['synthetic_*'],mode:'require_approval',agentScope:'all'},loadGovAlerts:{id:'synthetic-alert',name:'Synthetic',enabled:true,metric:'Synthetic metric',threshold:'>1',severity:'SEV2',owner:'Synthetic owner',runbook:'synthetic.md'}};
for(const [name,row] of Object.entries(validPolicies)){
 test(`P1-C ${name} complete policy remains readable`,async()=>{const {ctx,boxes}=harness({ok:true,policies:[row]});await ctx[name]();assert.doesNotMatch(boxes[name==='loadHitl'?'hitlpolicies':'alertpolicies'].innerHTML,/data-read-state="error"/);});
 for(const field of Object.keys(row).filter(k=>!['id','name'].includes(k)))test(`P1-C ${name} missing ${field} fails closed`,async()=>{const invalid={...row};delete invalid[field];const {ctx,boxes}=harness({ok:true,policies:[invalid]});await ctx[name]();assert.match(boxes[name==='loadHitl'?'hitlpolicies':'alertpolicies'].innerHTML,/data-read-state="error"/);});
}

for(const [name,id,want] of [['loadRequests','reqinbox','page-two-access'],['loadBlueprintSubmissions','bpsublist','page-two-blueprint']])test(`integration ${name} follows real encoded pagination and filters kind/type`,async()=>{
 const {ctx,boxes,calls}=harness(path=>({ok:true,resource:'approvals',items:path.includes('cursor=')?[approval('page-two-access','RESOURCE_ACCESS','AGENT'),approval('page-two-blueprint','RESOURCE_PUBLICATION','BLUEPRINT'),approval('wrong-kind','RESOURCE_PUBLICATION','SKILL')]:[],cursor:path.includes('cursor=')?null:'synthetic/+ cursor'}));
 await ctx[name]();assert.deepEqual(calls,['/approvals?limit=50','/approvals?limit=50&cursor=synthetic%2F%2B%20cursor']);assert.match(boxes[id].innerHTML,new RegExp(want));assert.doesNotMatch(boxes[id].innerHTML,/wrong-kind/);
});
for(const flag of [{partial:true},{complete:false},{completeness:'partial'},{error:'synthetic incomplete'},{code:'SYNTHETIC_PARTIAL'}])test(`integration rejects later-page flags ${JSON.stringify(flag)}`,async()=>{
 const {ctx,boxes}=harness(path=>({ok:true,resource:'approvals',items:[approval('must-not-render','RESOURCE_ACCESS','AGENT')],cursor:path.includes('cursor=')?null:'next',...(path.includes('cursor=')?flag:{})}));
 await ctx.loadRequests();assert.match(boxes.reqinbox.innerHTML,/data-read-state="error"/);assert.doesNotMatch(boxes.reqinbox.innerHTML,/must-not-render/);
});
test('integration looping cursor fails closed without a partial success list',async()=>{const {ctx,boxes,calls}=harness({ok:true,resource:'approvals',items:[],cursor:'loop'});await ctx.loadRequests();assert.equal(calls.length,2);assert.match(boxes.reqinbox.innerHTML,/data-read-state="error"/);});
test('integration exemption reads never substitute generic approvals',async()=>{const {ctx,boxes,calls}=harness({ok:false,status:404});await ctx.loadApprovals();assert.deepEqual(calls,['/policy-exemptions?limit=50']);assert.match(boxes.apxlist.innerHTML,/data-read-state="error"/);});
test('integration access queue preserves explicit type/status/domain filters',async()=>{
 const rows=[approval('keep','RESOURCE_ACCESS','AGENT'),{...approval('other-domain','RESOURCE_ACCESS','AGENT'),domainId:'other'},approval('other-type','RESOURCE_ACCESS','SKILL'),{...approval('other-status','RESOURCE_ACCESS','AGENT'),status:'APPROVED'}];
 const {ctx,boxes}=harness({ok:true,resource:'approvals',items:rows,cursor:null});Object.assign(ctx.S,{reqFType:'AGENT',reqFStatus:'PENDING',reqFDomain:'platform'});await ctx.loadRequests();assert.match(boxes.reqinbox.innerHTML,/keep/);assert.doesNotMatch(boxes.reqinbox.innerHTML,/other-domain|other-type|other-status/);
});

// Source-only HITL read hardening. Positive records are synthetic UI contracts,
// not evidence that hosted policy storage or runtime enforcement exists.
test('HITL hosted ready list exposes no mutation controls or audit read',async()=>{
 const {ctx,boxes,calls}=harness({ok:true,policies:[validPolicies.loadHitl]});
 let auditReads=0;ctx.runSessionTask=()=>auditReads++;
 await ctx.loadHitl();
 assert.match(boxes.hitlpolicies.innerHTML,/synthetic-policy/);
 assert.doesNotMatch(boxes.hitlpolicies.innerHTML,/htoggle|hpdel/);
 assert.equal(auditReads,0);assert.deepEqual(calls,['/hitl']);
});
test('HITL hosted true empty is read-only, never suggests creating a policy',async()=>{
 const {ctx,boxes}=harness({ok:true,policies:[]});await ctx.loadHitl();
 assert.match(boxes.hitlpolicies.innerHTML,/No approval policies in this scope/);
 assert.doesNotMatch(boxes.hitlpolicies.innerHTML,/create one below/i);
});
test('HITL hosted does not claim tool calls are paused',()=>{
 const {ctx}=harness();assert.doesNotMatch(ctx.govPoliciesTab(),/Matching tool calls pause/);
 assert.match(ctx.govPoliciesTab(),/enforcement.*not.*active/i);
});
test('HITL explicit missing contract is not successful empty',async()=>{
 const {ctx,boxes}=harness({ok:false,status:503,code:'HITL_POLICY_NOT_CONFIGURED'});
 await ctx.loadHitl();assert.match(boxes.hitlpolicies.innerHTML,/data-read-state="unconfigured"/);
 assert.doesNotMatch(boxes.hitlpolicies.innerHTML,/No approval policies in this scope/);
});
test('HITL local ready list retains local mutation controls',async()=>{
 const {ctx,boxes}=harness({policies:[validPolicies.loadHitl]},false);await ctx.loadHitl();
 assert.match(boxes.hitlpolicies.innerHTML,/htoggle/);assert.match(boxes.hitlpolicies.innerHTML,/hpdel/);
});
test('HITL unauthenticated response cannot render a policy list',async()=>{
 const {ctx,boxes}=harness({ok:false,status:401,code:'NOT_AUTHENTICATED',policies:[validPolicies.loadHitl]});
 await assert.rejects(ctx.loadHitl(),error=>error===ctx.CANCELED_REQUEST);
 assert.doesNotMatch(boxes.hitlpolicies.innerHTML,/synthetic-policy|htoggle|hpdel/);
});
const hitlPage=(policies=[],cursor=null,revision=1)=>({ok:true,schemaVersion:1,revision,domainId:'platform',updatedAt:'2026-09-12T08:00:00.000Z',source:'workspace-hitl-policy-catalog',enforcement:'NOT_CONFIGURED',policies,cursor});
test('HITL versioned read collects real API pages before rendering',async()=>{
 const {ctx,boxes,calls}=harness(path=>path.includes('cursor=')?hitlPage([{...validPolicies.loadHitl,id:'second'}]):hitlPage([validPolicies.loadHitl],'next'));
 await ctx.loadHitl();assert.match(boxes.hitlpolicies.innerHTML,/second/);assert.equal(calls.length,2);
});
test('HITL later-page revision mismatch never exposes partial policy rows',async()=>{
 const {ctx,boxes}=harness(path=>path.includes('cursor=')?hitlPage([],null,2):hitlPage([validPolicies.loadHitl],'next'));
 await ctx.loadHitl();assert.match(boxes.hitlpolicies.innerHTML,/data-read-state="error"/);assert.doesNotMatch(boxes.hitlpolicies.innerHTML,/synthetic-policy/);
});
for(const [label,override] of [['no version',{schemaVersion:undefined}],['foreign domain',{domainId:'operations'}],['no policy version',{policies:[validPolicies.loadHitl]}],['wrong source',{source:'model-policy'}],['no initialized cursor',{cursor:undefined}]])test(`HITL raw hosted schema rejects ${label}`,async()=>{
 const {ctx,boxes}=harness();ctx.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify({...hitlPage([{...validPolicies.loadHitl,version:1,scope:{kind:'domain'}}]),...override})});
 await ctx.loadHitl();assert.match(boxes.hitlpolicies.innerHTML,/data-read-state="error"/);assert.doesNotMatch(boxes.hitlpolicies.innerHTML,/synthetic-policy/);
});

for(const policies of [[],[validPolicies.loadHitl]])test(`HITL successful catalog retains source domain revision and guarded refresh (${policies.length})`,async()=>{
 const {ctx,boxes,calls}=harness({ok:true,policies});const button={isConnected:true,disabled:false};
 boxes.hitlpolicies.querySelectorAll=selector=>selector==='[data-hp-refresh]'?[button]:[];
 await ctx.loadHitl();const html=boxes.hitlpolicies.innerHTML;
 assert.doesNotMatch(html,/Source:|workspace-hitl-policy-catalog/);assert.match(html,/Policy scope:.*platform/);
 assert.match(html,/Catalog v1/);assert.match(html,/2026-09-12T08:00:00.000Z/);assert.match(html,/data-hp-refresh/);
 await button.onclick();assert.equal(calls.length,2);ctx.sessionEpoch++;await button.onclick();assert.equal(calls.length,2);
});

for(const result of [{ok:false,status:403},{ok:false,status:503},{ok:true,entries:null}])test(`guardrail read fails closed ${JSON.stringify(result)}`,async()=>{const {ctx,boxes}=harness(result);await ctx.loadGovGuardrails();assert.match(boxes.guardrailsettings.innerHTML,/data-read-state="(forbidden|error)"/);assert.doesNotMatch(boxes.guardrailsettings.innerHTML,/No blueprints/);});
test('guardrail current GET renders controls and refresh is session-bound',async()=>{const {ctx,boxes,calls}=harness({ok:true,controls:GUARDRAIL_CATALOG});const button={disabled:false,isConnected:true};boxes.guardrailsettings.querySelectorAll=()=>[button];await ctx.loadGovGuardrails();assert.match(boxes.guardrailsettings.innerHTML,/PII Detection/);assert.doesNotMatch(boxes.guardrailsettings.innerHTML,/Blueprint/);await button.onclick();assert.deepEqual(calls,['/governance/guardrails','/governance/guardrails']);ctx.sessionEpoch++;await button.onclick();assert.equal(calls.length,2);});

test('hosted Alerts success cannot expose local policy writers',async()=>{const {ctx,boxes}=harness({ok:true,policies:[validPolicies.loadGovAlerts]});await ctx.loadGovAlerts();assert.doesNotMatch(boxes.alertpolicies.innerHTML,/aptoggle|apdel/);});
test('RACI Retry issues same real GET and invalidates both loading states',async()=>{const {ctx,boxes,calls}=harness({ok:false,status:404});const button={disabled:false,isConnected:true};boxes.alertraci.querySelectorAll=()=>[button];await ctx.loadGovAlerts();await button.onclick();assert.equal(calls.length,2);assert.match(boxes.alertraci.innerHTML,/data-read-state="error"/);assert.match(boxes.alertpolicies.innerHTML,/data-read-state="error"/);});
