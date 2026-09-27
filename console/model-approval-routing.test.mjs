// Isolated synthetic boundary tests: never sends a real approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness, approval } from './test-support/model-approval-harness.mjs';
function harness(resourceType, decision='APPROVE') {
  const h=appHarness({row:approval({resourceType}),decision});
  return {...h,get calls(){return h.writes.map(({path,body})=>({path:path.slice(4),body}));}};
}
test('MODEL access from the unified approvals queue uses the model-governance writer, not native Registry governance',async()=>{
  const h=harness('MODEL'); await h.button.onclick();
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].path,'/ai-gateway/model-access-decisions');
  assert.equal(h.calls[0].body.approvalId,'qa-model-access');
});
for (const type of ['AGENT','TOOL','MCP_SERVER','SKILL','BLUEPRINT']) {
  test(`${type} retains the native governance access writer`,async()=>{
    const h=harness(type); await h.button.onclick();
    assert.equal(h.calls[0].path,'/governance/access-decisions');
  });
}
for (const type of [undefined,'','FUTURE_TYPE']) {
  test(`unknown resource type ${String(type)} cannot issue a decision`,async()=>{
    const h=harness(type); await h.button.onclick(); assert.equal(h.calls.length,0);
  });
}
test('model rejection uses exact body and does not alter a model policy',async()=>{
  const h=harness('MODEL','REJECT');await h.button.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[{path:'/ai-gateway/model-access-decisions',body:{approvalId:'qa-model-access',decision:'REJECT',reason:'QA rejection'}}]);
});
test('MODEL decision cannot continue across a session change',async()=>{
  const h=harness('MODEL'); h.ctx.sessionEpoch++; await h.button.onclick(); assert.equal(h.calls.length,0);
});
test('model row carries resource type to the decision handler and hides own requests',()=>{
  const {ctx}=appHarness();
  const row=approval({id:'qa-model',resourceId:'bedrock/model'});
  const html=ctx.hostedCollectionItems('approvals',[row],{approvalActions:true});
  assert.equal((html.match(/data-resource-type="MODEL"/g)||[]).length,2);
  assert.doesNotMatch(ctx.hostedCollectionItems('approvals',[{...row,requesterSubject:'reviewer'}],{approvalActions:true}),/class="ghost hostedapproval"/);
});
