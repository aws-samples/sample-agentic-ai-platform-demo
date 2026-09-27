// Synthetic inputs; executes production projection and actual queue renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {mountPublicationSubmission} from './public/publication-submission.mjs';
import {projectPendingWork} from './public/pending-work.mjs';
const resource={id:'test-mcp',name:'Test MCP',type:'MCPServer',domain:'operations',_source:'agentcore-registry',versions:[{semver:'1.0.0',status:'IN_REVIEW',_aws:{registryId:'SyntheticReg1',recordId:'SyntheticRec',awsStatus:'PENDING_APPROVAL'}}]};
const registry={ok:true,source:'aws',entries:[resource]};
const approvals={ok:true,resource:'approvals',items:[],cursor:null};
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.notEqual(start,-1);return source.slice(start,source.indexOf('\n}',start)+2);}
async function render(projection){
 const mounted=[];
 const element=()=>({innerHTML:'',isConnected:true,querySelectorAll:()=>[],append(child){this.innerHTML+=child.innerHTML;}});
 const box=element();
 const ctx=vm.createContext({projectPendingWork,sessionEpoch:0,SESSION:{actor:'qa',role:'admin'},authMode:()=>'cognito',hostedModelReadContext:()=>'',sessionEpochIsCurrent:()=>true,document:{getElementById:id=>id==='govqueue'?box:null,createElement:element},readGovPendingWork:async()=>({reg:registry,projection}),hasCap:()=>false,registryDecisionAllowed:()=>false,esc:x=>String(x??''),regStatusBadge:()=>'',mountPublicationSubmission:(root,options)=>{const button={disabled:false,hidden:false},status={textContent:''};root.querySelector=s=>s==='[data-publication-check]'?button:status;mountPublicationSubmission(root,options);mounted.push({button,status});},api:()=>{},readHostedCollection:()=>{},activeDomain:()=>'platform',hostedCaps:()=>[],createRequestId:()=>'',hostedCollectionItems:()=>'',wireHostedApprovalActions:()=>{},runSessionTask:()=>{},loadGovMemBacklog:()=>{}});
 vm.runInContext(fn('pendingWorkSummaryHtml')+'\n'+fn('loadGovQueue'),ctx);
 await ctx.loadGovQueue();return {html:box.innerHTML,mounted};
}
for(const [name,bad] of [['failed',{ok:false}],['partial',{...approvals,partial:true}],['unfinished',{...approvals,cursor:'next'}],['invalid row',{...approvals,items:[null]}]]){
 test(`${name} approval source retains resource with unknown linkage and no submission entry`,async()=>{
  const p=projectPendingWork({registry,approvals:bad});
  assert.equal(p.sources.approvals.complete,false);
  assert.equal(p.sources.registry.complete,true);
  assert.equal(p.rows[0].requestLinkage,'unknown');
  const {html,mounted}=await render(p);
  assert.match(html,/Request status unavailable/);
  assert.doesNotMatch(html,/no matching request|No matching approval request|data-publication-check|No formal approval requests/i);
  assert.match(html,/Test MCP/);
  assert.equal(mounted.length,0);
 });
}
test('complete approvals can establish absence independently of Registry failure',async()=>{
 const p=projectPendingWork({registry:{...registry,partial:true},approvals});
 assert.equal(p.complete,false);
 assert.equal(p.sources.approvals.complete,true);
 assert.equal(p.sources.registry.complete,false);
 assert.equal(p.rows[0].requestLinkage,'absent');
 const {html,mounted}=await render(p);
 // Queue status is rendered separately; production mount enforces this
 // native admin initiation path. It exposes independent review initiation,
 // not owner submission or approval; server authorization remains authoritative.
 assert.match(html,/Pending in Registry · review request not yet filed/);
 assert.equal(mounted.length,1);
 assert.equal(mounted[0].button.textContent,'Initiate review');
 assert.equal(mounted[0].button.hidden,false);
 assert.equal(mounted[0].button.disabled,false);
 assert.equal(typeof mounted[0].button.onclick,'function');
 assert.equal(mounted[0].status.textContent,'');
 assert.doesNotMatch(html,/>Approve<|>Reject</);
 assert.match(html,/No formal approval requests in this scope/);
});
