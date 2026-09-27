import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Actual wireHostedApprovalActions handler body (not regex-only): missing/blank/short
// reason must never default to "Approved after governance review", never prompt a
// fallback reason dialog, and must produce zero revalidate/API traffic.
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function fn(name){const i=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.notEqual(i,-1,name);return source.slice(i,source.indexOf('\n}',i)+2);}

const record={id:'ap-1',domainId:'platform',kind:'RESOURCE_PUBLICATION',resourceType:'SKILL',resourceId:'res-1',projectId:null,status:'PENDING',requesterSubject:'someone-else'};
function harness({reasonValue,decision='APPROVE'}={}){
 const counters={revalidates:0,apis:0,prompts:0,alerts:[]};
 const rowNotices=[];
 const row={isConnected:true,nodes:rowNotices,
  querySelector:sel=>sel==='[data-approval-reason-status]'?rowNotices.find(n=>'approvalReasonStatus' in n.dataset)||null
   :sel==='[data-approval-read-status]'?rowNotices.find(n=>'approvalReadStatus' in n.dataset)||null:null,
  append:(...kids)=>rowNotices.push(...kids)};
 const button={dataset:{approval:record.id,domain:record.domainId,kind:record.kind,resourceType:record.resourceType,resource:record.resourceId,project:'',decision},
  isConnected:true,disabled:false,closest:sel=>sel==='article'?row:null};
 const box={isConnected:true,
  contains:node=>node===button||node===row,
  querySelectorAll:sel=>sel==='.hostedapproval'?[button]:[],
  querySelector:sel=>sel.includes('data-reason-for')?(reasonValue===undefined?null:{value:reasonValue}):null};
 const ctx=vm.createContext({
  sessionEpoch:0,SESSION:{actor:'reviewer',role:'admin'},activeDomain:()=>'platform',
  sessionEpochIsCurrent:e=>e===0,hostedApprovalRecordAllowed:()=>true,
  sessionTaskHandler:f=>f,CSS:{escape:x=>x},CANCELED_REQUEST:Symbol('cancel'),
  pendingHostedApprovalDecisions:new Map(),
  revalidateHostedApproval:async(expected)=>{counters.revalidates++;return {state:'ready',record:expected};},
  hostedApprovalRequest:(t,d,reason)=>({path:'/governance/publication-decisions',body:{approvalId:t.approval,decision:d,reason}}),
  api:async(path,body)=>{counters.apis++;counters.lastBody=body;return {ok:true};},
  createRequestId:()=>'req-1',crypto:globalThis.crypto,TextEncoder,JSON,
  requestDemoChoice:async()=>{counters.prompts++;return 'Fallback prompt reason';},
  alert:m=>counters.alerts.push(m),apiErrorMessage:(r,f)=>f,
  document:{createElement:()=>({dataset:{},innerHTML:'',querySelector:()=>null})},
 });
 vm.runInContext(fn('wireHostedApprovalActions'),ctx);
 let reloads=0;
 ctx.wireHostedApprovalActions(box,async()=>reloads++,[record]);
 return {counters,button,row,rowNotices,box,reloads:()=>reloads};
}

for(const [name,reasonValue] of [['missing reason input',undefined],['blank reason','   '],['short reason','no']]){
 for(const decision of ['APPROVE','REJECT']){
  test(`${name} (${decision}): inline notice, zero revalidate/API, no default or fallback prompt`,async()=>{
   const h=harness({reasonValue,decision});
   await h.button.onclick();
   assert.equal(h.counters.revalidates,0,'must not revalidate without a valid reason');
   assert.equal(h.counters.apis,0,'must not call the API without a valid reason');
   assert.equal(h.counters.prompts,0,'must never open the fallback reason prompt');
   assert.equal(h.counters.lastBody,undefined,'no decision body may be built');
   const notice=h.rowNotices.find(n=>'approvalReasonStatus' in n.dataset);
   assert.ok(notice,'inline reason notice rendered in the row');
   assert.match(notice.innerHTML,/reason/i);
   assert.match(notice.innerHTML,/role="status"/);
   assert.equal(h.button.disabled,false,'row stays actionable after the inline hint');
   assert.equal(h.reloads(),0,'no reload while the reason is invalid');
  });
 }
}

test('valid reason proceeds through revalidate to exactly one API decision with the trimmed reason',async()=>{
 const h=harness({reasonValue:'  Reviewed evidence attached  '});
 await h.button.onclick();
 assert.equal(h.counters.revalidates,1);
 assert.equal(h.counters.apis,1);
 assert.equal(h.counters.prompts,0);
 assert.equal(h.counters.lastBody.reason,'Reviewed evidence attached');
 assert.equal(h.counters.lastBody.decision,'APPROVE');
});

test('handler source contains no default approval reason literal and no reason prompt fallback',()=>{
 const body=source.slice(source.indexOf('function wireHostedApprovalActions'),source.indexOf('function validHostedGatewayCatalog'));
 assert.doesNotMatch(body,/Approved after governance review/);
 assert.doesNotMatch(body,/requestDemoChoice/);
});
