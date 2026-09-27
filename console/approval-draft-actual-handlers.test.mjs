import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createApprovalReasonDrafts,wireApprovalReasonInputs} from './public/approval-reason-drafts.mjs';
test('all-domain Admin detects and clears own record-domain drafts without clearing another actor',()=>{
 const d=createApprovalReasonDrafts();d.save({actor:'admin',domain:'platform',approvalId:'a'},'reason');d.save({actor:'other',domain:'platform',approvalId:'a'},'other');
 assert.equal(d.isDirty({actor:'admin'}),true);d.discard({actor:'admin'});assert.equal(d.isDirty({actor:'admin'}),false);assert.equal(d.isDirty({actor:'other'}),true);
});
test('same request id in separate record domains keeps separate exact reasons',()=>{
 const drafts=createApprovalReasonDrafts();
 const make=domain=>({dataset:{reasonFor:'same',reasonDomain:domain},value:'',addEventListener(k,f){this[k]=f;}});
 const a=make('operations'),b=make('platform'),box={querySelectorAll:()=>[a,b]};
 wireApprovalReasonInputs(drafts,box,{actor:'reviewer',domain:'platform'});
 a.value='operations reason';a.input();b.value='platform reason';b.input();
 assert.equal(drafts.read({actor:'reviewer',domain:'operations',approvalId:'same'}),'operations reason');
 assert.equal(drafts.read({actor:'reviewer',domain:'platform',approvalId:'same'}),'platform reason');
});
test('rebind same DOM to another actor never copies previous actor text or listeners',()=>{
 const drafts=createApprovalReasonDrafts();
 const input={dataset:{reasonFor:'a',reasonDomain:'platform'},value:'',listeners:{},addEventListener(k,f){this.listeners[k]=f;},removeEventListener(k,f){if(this.listeners[k]===f)delete this.listeners[k];}};
 const box={querySelectorAll:()=>[input]};
 wireApprovalReasonInputs(drafts,box,{actor:'first',domain:'platform'});input.value='private first';input.listeners.input();
 wireApprovalReasonInputs(drafts,box,{actor:'second',domain:'platform'});
 assert.equal(input.value,'');input.value='second only';input.listeners.input();
 assert.equal(drafts.read({actor:'first',domain:'platform',approvalId:'a'}),'private first');
 assert.equal(drafts.read({actor:'second',domain:'platform',approvalId:'a'}),'second only');
});
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function fn(name){let i=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.notEqual(i,-1);return source.slice(i,source.indexOf('\n}',i)+2);}
for(const [id,key] of [['reqftype','reqFType'],['reqfstatus','reqFStatus'],['reqfdomain','reqFDomain']])test(`${id} actual onchange Cancel restores and Confirm discards`,()=>{
 const drafts=createApprovalReasonDrafts(),scope={actor:'reviewer',domain:'platform',approvalId:'a'};drafts.save(scope,'exact reason');
 const el={value:'new'},S={[key]:'old'};let accept=false,reloads=0;
 const ctx=vm.createContext({approvalReasonDrafts:drafts,approvalReasonScope:()=>scope,confirm:()=>accept,document:{getElementById:x=>x===id?el:null},S,runSessionTask:()=>reloads++,loadRequests:()=>{}});
 vm.runInContext(fn('confirmApprovalReasonDiscard')+'\n'+fn('wireRequests'),ctx);ctx.wireRequests();el.onchange();
 assert.equal(el.value,'old');assert.equal(S[key],'old');assert.equal(reloads,0);assert.equal(drafts.read(scope),'exact reason');
 accept=true;el.value='new';el.onchange();assert.equal(S[key],'new');assert.equal(reloads,1);assert.equal(drafts.read(scope),'');
});
test('actual unavailable decision keeps sibling row and draft while retiring both row actions',async()=>{
 const record={id:'a',domainId:'platform',kind:'RESOURCE_PUBLICATION',resourceType:'SKILL',resourceId:'r',projectId:null};
 const notice={innerHTML:'',querySelector:()=>retry};const retry={disabled:false};
 const row={querySelector:()=>notice,append:()=>{}};
 const buttons=['APPROVE','REJECT'].map(decision=>({dataset:{approval:'a',domain:'platform',kind:record.kind,resourceType:'SKILL',resource:'r',project:'',decision},isConnected:true,disabled:false,closest:()=>row}));
 const box={innerHTML:'SIBLING ROW AND DRAFT',isConnected:true,contains:()=>true,querySelectorAll:s=>s==='.hostedapproval'?buttons:[],querySelector:s=>s.includes('reason')?{value:'review reason'}:retry};
 const ctx=vm.createContext({sessionEpoch:0,SESSION:{actor:'reviewer',role:'admin'},activeDomain:()=>'platform',sessionEpochIsCurrent:()=>true,hostedApprovalRecordAllowed:()=>true,sessionTaskHandler:f=>f,CSS:{escape:x=>x},pendingHostedApprovalDecisions:new Map(),revalidateHostedApproval:async()=>({state:'unavailable'}),CANCELED_REQUEST:Symbol(),alert:()=>{},document:{createElement:()=>notice}});
 vm.runInContext(fn('wireHostedApprovalActions'),ctx);ctx.wireHostedApprovalActions(box,async()=>{},[record]);await buttons[0].onclick();
 assert.equal(box.innerHTML,'SIBLING ROW AND DRAFT');assert.match(notice.innerHTML,/unknown|confirm/i);
 assert.ok(buttons.every(b=>b.disabled&&b.approvalReadOnly&&b.onclick===null));
});
