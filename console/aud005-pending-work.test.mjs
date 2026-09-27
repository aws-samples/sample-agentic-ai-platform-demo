// OFFLINE ONLY: actual app functions, production projection and backend-shaped fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { inventory, stamp } from './test-support/model-status-harness.mjs';
import { registryDecisionAllowed } from './public/registry-decision-target.mjs';
import { hostedApprovalRequest } from './public/hosted-approval-request.mjs';
import { collectPagedItems } from './public/main-ui-compat.mjs';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
let projection={};
try { projection=await import('./public/pending-work.mjs'); } catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND')throw e; }
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.notEqual(start,-1,name);return source.slice(start,source.indexOf('\n}',start)+2);}
const native=(recordId='SyntheticRec',semver='1.0.0')=>({id:'test-skill',type:'Skill',name:'TEST native',domain:'platform',_source:'agentcore-registry',_registryId:'SyntheticReg1',versions:[{semver,status:'IN_REVIEW',createdAt:stamp,_aws:{registryId:'SyntheticReg1',recordId,awsStatus:'PENDING_APPROVAL'}}]});
const approval=(id='test-access',extra={})=>({id,domainId:'platform',projectId:null,kind:'RESOURCE_ACCESS',resourceType:'MODEL',resourceId:'test-gateway/model-0',status:'PENDING',requesterSubject:'test-requester',requestedAt:stamp,...extra});
const reg=entries=>({ok:true,source:'aws',entries});
const page=items=>({ok:true,resource:'approvals',items,cursor:null});
function harness(registry=reg([]),approvals=page([])){
 const element=()=>({innerHTML:'',className:'',append(child){this.innerHTML+=child.innerHTML}});
 const boxes=Object.fromEntries(['govqueue','gcompliance'].map(id=>[id,{innerHTML:'',isConnected:true,querySelectorAll:()=>[],append(child){this.innerHTML+=child.innerHTML}}]));
 const ctx=vm.createContext({ ...projection, registryDecisionAllowed, hostedApprovalRequest, collectPagedItems,
  sessionEpoch:0,context:'actor-a/platform',SESSION:{actor:'test-reviewer'},S:{},CANCELED_REQUEST:Symbol('cancel'),Date,
  authMode:()=> 'cognito',hasCap:()=>false,hostedModelReadContext:()=>ctx.context,sessionEpochIsCurrent:e=>e===ctx.sessionEpoch,
  document:{getElementById:id=>boxes[id]||null,createElement:element},
  mountPublicationSubmission:()=>{},createRequestId:()=>'synthetic-id',hostedCaps:()=>[],activeDomain:()=>'platform',
  api:async path=>path==='/registry'?registry:path==='/fleet'?{ok:true,agents:[]}:{ok:true,submissions:[],pending:[]},
  readHostedCollection:async()=>typeof approvals==='function'?approvals():approvals,
  usableDomainId:x=>typeof x==='string'&&!!x,esc:x=>String(x??''),REG_TYPE_ICON:{},ICONS:{},ic2:()=>'',regStatusBadge:()=>'',HG_IC:'',SHIELD_IC:'',FOLDER_IC:'',HAND_IC:'',
  hostedCollectionItems:(_,items)=>items.map(a=>`<article data-approval="${a.id}">${a.id}</article>`).join(''),
  wireHostedApprovalActions:()=>{},runSessionTask:()=>{},loadGovMemBacklog:()=>{},clearHostedRegistryReadCache:()=>{},
 });
 for(const name of ['readGovPendingWork','pendingWorkSummaryHtml','loadGovQueue','loadGovCompliance'])if(source.includes('function '+name+'('))vm.runInContext(fn(name),ctx);
 return {ctx,boxes};
}
test('discovery-only actual queue/count/oldest contain no pending work',async()=>{
 const {ctx,boxes}=harness(reg(inventory()));await ctx.loadGovQueue();await ctx.loadGovCompliance();
 assert.doesNotMatch(boxes.govqueue.innerHTML,/data-queue="reg-/);
 assert.match(boxes.govqueue.innerHTML,/data-pending-count="0"/);
 assert.match(boxes.gcompliance.innerHTML,/data-pending-count="0"/);
 assert.match(boxes.gcompliance.innerHTML,/Nothing is waiting/);
 assert.doesNotMatch(boxes.gcompliance.innerHTML,/TEST DATA model|SLA breach/);
});
test('MODEL access is retained and uses existing model routing, different requests remain distinct',async()=>{
 const a=approval(),b=approval('test-access-two');const {ctx,boxes}=harness(reg(inventory()),page([a,b]));await ctx.loadGovQueue();
 assert.match(boxes.govqueue.innerHTML,/test-access-two/);assert.match(boxes.govqueue.innerHTML,/data-pending-count="2"/);
 assert.equal(hostedApprovalRequest({approval:a.id,kind:a.kind,resourceType:a.resourceType},'APPROVE','test only').path,'/ai-gateway/model-access-decisions');
});
test('canonical Registry/version plus explicit publication resource reference dedup, never name/alias',async()=>{
 const a=approval('test-publication',{kind:'RESOURCE_PUBLICATION',resourceType:'SKILL',resourceId:'SyntheticReg1/SyntheticRec'});
 const e=native();const other=native('SyntheticRe2','2.0.0');other.id='other-skill';
 const {ctx,boxes}=harness(reg([e,structuredClone(e),other]),page([a,approval()]));await ctx.loadGovQueue();await ctx.loadGovCompliance();
 assert.match(boxes.govqueue.innerHTML,/data-pending-count="2"/);assert.match(boxes.gcompliance.innerHTML,/data-pending-count="2"/);
 assert.match(boxes.govqueue.innerHTML,/Awaiting review initiation \(1\)/);
 assert.match(boxes.govqueue.innerHTML,/test-publication/);
});
for(const [label,registry,approvals] of [
 ['missing Registry',{ok:true},page([])],['wrong source',{ok:true,source:'file-fallback',entries:[]},page([])],
 ['error',{ok:false},page([])],['malformed row',reg([null]),page([])],
 ['missing approvals',reg([]),{ok:true}],['pagination unfinished',reg([]),{...page([]),cursor:'next'}],
 ['pagination error',reg([]),{ok:false,code:'PAGINATION_INVALID'}],['partial flag',{...reg([]),partial:true},page([])],
 ['missing cursor',reg([]),{ok:true,resource:'approvals',items:[]}],
])test(`${label}: actual consumers say incomplete/unknown, not zero or clear`,async()=>{
 const {ctx,boxes}=harness(registry,approvals);await ctx.loadGovQueue();await ctx.loadGovCompliance();
 for(const box of Object.values(boxes)){assert.match(box.innerHTML,/incomplete|unknown|unavailable/i);assert.doesNotMatch(box.innerHTML,/data-pending-count="0"|queue is clear|Nothing is waiting/);}
});
test('malformed siblings retain validated real requests but make count incomplete',async()=>{
 const {ctx,boxes}=harness(reg([]),page([approval(),null]));await ctx.loadGovQueue();
 assert.match(boxes.govqueue.innerHTML,/test-access/);assert.match(boxes.govqueue.innerHTML,/incomplete/i);assert.doesNotMatch(boxes.govqueue.innerHTML,/data-pending-count="1"/);
});
test('invalid dates are separately unknown, never discovered dates or a fake SLA',async()=>{
 const {ctx,boxes}=harness(reg(inventory()),page([approval('no-date',{requestedAt:null}),approval('valid-date')]));await ctx.loadGovQueue();await ctx.loadGovCompliance();
 assert.match(boxes.gcompliance.innerHTML,/valid-date/);assert.match(boxes.gcompliance.innerHTML,/1.*submission date.*unknown/i);assert.doesNotMatch(boxes.gcompliance.innerHTML,/NaN|within 7d/);
});
for(const consumer of ['loadGovQueue','loadGovCompliance'])for(const change of ['actor','domain','session','navigation','newer-read'])test(`${consumer}: stale ${change} response cannot render`,async()=>{
 let release;const {ctx,boxes}=harness(reg([]),()=>new Promise(r=>release=r));const pending=ctx[consumer]();
 if(change==='session')ctx.sessionEpoch++;else if(change==='navigation')Object.values(boxes).forEach(b=>b.isConnected=false);else if(change==='newer-read'){ctx.readHostedCollection=async()=>page([approval('new-current')]);await ctx[consumer]();}else ctx.context=change==='actor'?'actor-b/platform':'actor-a/operations';
 release(page([approval('stale-old')]));await pending;
 for(const box of Object.values(boxes))assert.doesNotMatch(box.innerHTML,/stale-old/);
});
test('actual paginated reader rejects missing cursor and repeated continuation',async()=>{
 const ctx=vm.createContext({collectPagedItems,rawApi:async()=>({...page([]),cursor:'loop'})});vm.runInContext(fn('readHostedCollection'),ctx);assert.equal((await ctx.readHostedCollection('approvals')).ok,false);
 ctx.rawApi=async()=>({ok:true,resource:'approvals',items:[]});assert.equal((await ctx.readHostedCollection('approvals')).ok,false);
});
test('native creation/discovery dates never substitute for a missing submission date',()=>{
 const p=projection.projectPendingWork({registry:reg([native()]),approvals:page([])});
 assert.equal(p.count,0);assert.equal(p.resourceReviewCount,1);assert.equal(p.oldest,null);assert.equal(p.unknownDates,0);
});
test('different domain requests and publications with no explicit canonical linkage stay separate',()=>{
 const p=projection.projectPendingWork({registry:reg([native()]),approvals:page([
  approval('same-id'),approval('same-id',{domainId:'operations'}),
  approval('unlinked',{kind:'RESOURCE_PUBLICATION',resourceType:'SKILL',resourceId:'test-skill'}),
  approval('foreign',{kind:'RESOURCE_PUBLICATION',resourceType:'SKILL',resourceId:'SyntheticReg1/SyntheticRec',domainId:'operations'}),
 ])});assert.equal(p.count,4);assert.equal(p.rows.length,5);
});
test('first/second projection is idempotent; inputs and business state untouched; upgrade dates remain unknown',()=>{
 const input={registry:reg([native()]),approvals:page([approval()]),now:Date.parse('2026-09-12T00:00:00Z')};
 const before=structuredClone(input),one=projection.projectPendingWork(input),two=projection.projectPendingWork(input);
 assert.deepEqual(one,two);assert.deepEqual(input,before);assert.equal(one.unknownDates,0);assert.equal(one.resourceReviewCount,1);
});
test('invalid calendar dates, future dates and date-only values do not create SLA claims',()=>{
 const p=projection.projectPendingWork({registry:reg([]),approvals:page([
  approval('bad-day',{requestedAt:'2026-02-30T00:00:00Z'}),approval('future',{requestedAt:'2999-01-01T00:00:00Z'}),approval('date-only',{requestedAt:'2026-09-01'}),
 ])});assert.equal(p.unknownDates,3);assert.equal(p.oldest,null);
});
test('source error metadata is incomplete even with a superficially empty success envelope',()=>{
 for(const patch of [{errors:['test failure']},{errors:{registry:'unavailable'}},{complete:false},{completeness:'partial'},{nextToken:'continuation'}]){
  const p=projection.projectPendingWork({registry:{...reg([]),...patch},approvals:page([])});assert.equal(p.complete,false);assert.equal(p.count,null);
 }
});
test('blueprint submissions source failure cannot render fake zero approved/rejected counts',async()=>{
 const {ctx,boxes}=harness(reg([]),page([]));const base=ctx.api;
 ctx.readHostedCollection=async()=>({ok:false});
 await ctx.loadGovCompliance();
 assert.match(boxes.gcompliance.innerHTML,/Platform blueprint submissions/);
 assert.match(boxes.gcompliance.innerHTML,/>Unknown</);
 assert.doesNotMatch(boxes.gcompliance.innerHTML,/0 approved · 0 rejected/);
 assert.match(boxes.gcompliance.innerHTML,/unknown approved · unknown rejected/i);
});
test('successful empty blueprint submissions list keeps real zero approved/rejected counts',async()=>{
 const {ctx,boxes}=harness(reg([]),page([]));const base=ctx.api;
 ctx.api=async path=>path==='/blueprint-submissions'?{ok:true,submissions:[]}:base(path);
 await ctx.loadGovCompliance();
 assert.match(boxes.gcompliance.innerHTML,/0 approved · 0 rejected/);
 assert.doesNotMatch(boxes.gcompliance.innerHTML,/unknown approved/i);
});
test('footer: registry read failure cannot render fake "0 registry entries"',async()=>{
 const {ctx,boxes}=harness({ok:false},page([]));
 await ctx.loadGovCompliance();
 assert.doesNotMatch(boxes.gcompliance.innerHTML,/0 registry entr/);
 assert.match(boxes.gcompliance.innerHTML,/registry entries unknown/i);
 assert.match(boxes.gcompliance.innerHTML,/0 blueprint submissions/);
});
test('footer: blueprint submissions read failure cannot render fake "0 blueprint submissions"',async()=>{
 const {ctx,boxes}=harness(reg([]),page([]));const base=ctx.api;
 ctx.readHostedCollection=async()=>({ok:false});
 await ctx.loadGovCompliance();
 assert.doesNotMatch(boxes.gcompliance.innerHTML,/0 blueprint submission/);
 assert.match(boxes.gcompliance.innerHTML,/blueprint submissions unknown/i);
 assert.match(boxes.gcompliance.innerHTML,/0 registry entries/);
});
test('footer: genuine empty success still renders real zeros',async()=>{
 const {ctx,boxes}=harness(reg([]),page([]));
 await ctx.loadGovCompliance();
 assert.match(boxes.gcompliance.innerHTML,/0 registry entries · 0 blueprint submissions/);
 assert.doesNotMatch(boxes.gcompliance.innerHTML,/entries unknown|submissions unknown/i);
});
test('unrelated Compliance source failures cannot hide successfully read pending work',async()=>{
 const {ctx,boxes}=harness(reg([]),page([approval()]));const read=ctx.api;ctx.api=async path=>path==='/registry'?read(path):Promise.reject(Error('test source unavailable'));
 await ctx.loadGovCompliance();assert.match(boxes.gcompliance.innerHTML,/data-pending-count="1"/);assert.match(boxes.gcompliance.innerHTML,/test-access/);assert.match(boxes.gcompliance.innerHTML,/Not verified/);
});

test('project membership never becomes guardrail execution evidence',async()=>{const {ctx,boxes}=harness(reg([]),page([]));const base=ctx.api;ctx.api=async p=>p==='/fleet'?{ok:true,agents:[{project:'synthetic'}]}:base(p);await ctx.loadGovCompliance();assert.match(boxes.gcompliance.innerHTML,/Runtime guardrail evidence/);assert.doesNotMatch(boxes.gcompliance.innerHTML,/100%|guardrails pre-wired/);});

test('Compliance old submission age is factual, never invented seven-day SLA',async()=>{const {ctx,boxes}=harness(reg([]),page([approval('old',{requestedAt:'2020-01-01T00:00:00.000Z'})]));await ctx.loadGovCompliance();assert.match(boxes.gcompliance.innerHTML,/d elapsed/);assert.match(boxes.gcompliance.innerHTML,/No review SLA is configured/);assert.doesNotMatch(boxes.gcompliance.innerHTML,/SLA breach|within 7d|&gt; 7d/);assert.match(boxes.gcompliance.innerHTML,/not a compliance certification/)});
test('Compliance exposes refresh and exact platform approval navigation without fleet read',async()=>{const {ctx,boxes}=harness(reg([]),page([]));const handlers={},buttons={};ctx.document.getElementById=id=>boxes[id]||(buttons[id]??={isConnected:true,disabled:false,addEventListener:(_,fn)=>handlers[id]=fn});ctx.confirmContextChange=()=>true;ctx.render=()=>{};const read=ctx.api;const paths=[];ctx.api=async p=>{paths.push(p);return read(p)};await ctx.loadGovCompliance();assert.ok(!paths.includes('/fleet'));assert.equal(typeof handlers.gcomprefresh,'function');handlers.gcomp2platform();assert.equal(ctx.S.govTab,'exemptions');handlers.gcomp2audit();assert.equal(ctx.S.govTab,'audit');await handlers.gcomprefresh();assert.match(boxes.gcompliance.innerHTML,/Refresh governance snapshot/)});

test('Compliance lists every known pending request even if Registry is unavailable',async()=>{
 const {ctx,boxes}=harness({ok:false,code:'CONTROL_PLANE_UNAVAILABLE'},page([approval('request-one'),approval('request-two',{kind:'RESOURCE_PUBLICATION',resourceType:'SKILL',resourceId:'SyntheticReg1/SyntheticRec'})]));
 await ctx.loadGovCompliance();
 assert.match(boxes.gcompliance.innerHTML,/data-compliance-request="request-one"/);
 assert.match(boxes.gcompliance.innerHTML,/data-compliance-request="request-two"/);
 assert.match(boxes.gcompliance.innerHTML,/RESOURCE_ACCESS|Resource access/);
 assert.match(boxes.gcompliance.innerHTML,/test-gateway\/model-0/);
 assert.match(boxes.gcompliance.innerHTML,/incomplete|unknown/i);
});
test('Compliance preserves readable native lifecycle rows when a sibling is malformed',async()=>{
 const {ctx,boxes}=harness(reg([native(),null]),page([]));await ctx.loadGovCompliance();
 assert.match(boxes.gcompliance.innerHTML,/data-comp="Skill"/);
 assert.match(boxes.gcompliance.innerHTML,/Readable.*only|readable.*partial/i);
 assert.doesNotMatch(boxes.gcompliance.innerHTML,/data-pending-count="0"/);
});
