// Synthetic integration: actual P1 loaders -> existing renderer/action gates -> real transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appHarness,approval,fn} from './test-support/model-approval-harness.mjs';

function setup(row,caps,role='lead') {
  const h=appHarness({row});
  h.ctx.caps=caps;h.ctx.SESSION.role=role;
  h.ctx.document.getElementById=()=>h.box;
  for(const name of ['adminRead','adminReadState','adminReadHtml','adminReadStart','adminReadFailure','loadAdminApprovalQueue','loadRequests','loadBlueprintSubmissions'])vm.runInContext(fn(name),h.ctx);
  return h;
}
for(const [type,kind,loader,cap,path] of [
 ['AGENT','RESOURCE_ACCESS','loadRequests','decideDomainResourceAccess','/api/governance/access-decisions'],
 ['MODEL','RESOURCE_ACCESS','loadRequests','decideDomainResourceAccess','/api/ai-gateway/model-access-decisions'],
 ['BLUEPRINT','RESOURCE_PUBLICATION','loadBlueprintSubmissions','approvePlatformPublication','/api/governance/publication-decisions'],
]) {
 test(`P1 integrated ${type} action retains canonical route, revalidation and domain header`,async()=>{
  const h=setup(approval({resourceType:type,kind,...(type==='BLUEPRINT'?{domainId:'platform'}:{})}),[cap],type==='BLUEPRINT'?'admin':'lead');await h.ctx[loader]();
  assert.match(h.box.innerHTML,/class="ghost hostedapproval"/);
  await h.button.onclick();assert.equal(h.writes.length,1);assert.equal(h.writes[0].path,path);
  assert.equal(h.writes[0].headers['x-active-domain'],type==='BLUEPRINT'?'platform':'operations');assert.equal(h.writes[0].body.approvalId,h.row.id);
  assert.ok(h.reads.filter(r=>r.path.startsWith('/api/approvals?')).length>=2);
 });
 for(const change of ['self','capability','domain','stale-session','unsupported'])test(`P1 integrated ${type} ${change} cannot write`,async()=>{
  const h=setup(approval({resourceType:type,kind,...(type==='BLUEPRINT'?{domainId:'platform'}:{})}),[cap],type==='BLUEPRINT'?'admin':'lead');await h.ctx[loader]();
  if(change==='self')h.ctx.SESSION.actor=h.row.requesterSubject;
  if(change==='capability')h.ctx.caps=[];
  if(change==='domain')h.ctx.domain='foreign-synthetic-domain';
  if(change==='stale-session')h.ctx.sessionEpoch++;
  if(change==='unsupported')h.store.rows[0].resourceType='MEMORY';
  await h.button.onclick();assert.equal(h.writes.length,0);
 });
}
for(const type of ['MEMORY','KNOWLEDGE_BASE'])test(`P1 unsupported ${type} workflow stays read-only, not generic grant`,async()=>{
 const h=setup(approval({resourceType:type}),['decideDomainResourceAccess']);await h.ctx.loadRequests();
 assert.doesNotMatch(h.box.innerHTML,/class="ghost hostedapproval"/);await h.button.onclick();assert.equal(h.writes.length,0);
});
