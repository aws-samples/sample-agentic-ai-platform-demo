import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFixture, REGISTRY, RECORD } from './support/approval-workflow-fixture.mjs';

async function submitted() {
  const f=workflowFixture(); await f.draft(); const ctx=await f.context();
  const body={registryId:REGISTRY,recordId:RECORD,approvalId:ctx.approvalId,expectedRecordVersion:ctx.recordVersion};
  assert.equal((await f.call('/api/governance/publications',{body,requestId:`submit-${ctx.approvalId}`})).ok,true);
  const decision={actor:'synthetic-reviewer',role:'lead',requestId:'synthetic-reservation-retry',body:{approvalId:ctx.approvalId,decision:'APPROVE',reason:'Synthetic bounded release review'}};
  return {f,ctx,decision};
}
for(const failure of ['external-response-lost','approval-persistence-fails'])test(`real reservation survives ${failure}; exact replay recovers, another reviewer cannot steal`,async()=>{
  const {f,ctx,decision}=await submitted();
  if(failure==='external-response-lost'){
    const send=f.registryClient.send.bind(f.registryClient);let once=true;
    f.registryClient.send=async command=>{const result=await send(command);if(command.constructor.name==='UpdateRegistryRecordStatusCommand'&&once){once=false;throw Error('Synthetic response lost after Registry write');}return result;};
  }else{
    const put=f.state.putApproval.bind(f.state);let once=true;
    f.state.putApproval=async input=>{if(once){once=false;throw Error('Synthetic local persistence failure');}return put(input);};
  }
  const first=await f.call('/api/governance/publication-decisions',decision);assert.notEqual(first.ok,true);
  assert.equal(f.records.get(`${REGISTRY}/${RECORD}`).status,'APPROVED');
  const reservation=f.table.get(`MUTATION#approval-decision/domain_a|DECISION#${ctx.approvalId}`);
  assert.equal(reservation.actor.S,decision.actor);assert.equal(reservation.requestId.S,decision.requestId);
  assert.equal(Object.hasOwn(reservation,'expiresAt'),false);
  assert.equal((await f.call('/api/governance/publication-decisions',{...decision,actor:'synthetic-other-reviewer',requestId:'synthetic-other-request',body:{...decision.body,decision:'REJECT'}})).status,409);
  assert.equal((await f.call('/api/governance/publication-decisions',{...decision,body:{...decision.body,reason:'Changed reason cannot steal reservation'}})).status,409);
  const recovered=await f.call('/api/governance/publication-decisions',decision);assert.equal(recovered.ok,true,JSON.stringify(recovered));
  assert.equal(recovered.approval.status,'APPROVED');assert.equal(recovered.approval.approverSubject,decision.actor);
  assert.equal(f.commands.filter(c=>c==='UpdateRegistryRecordStatusCommand').length,1);
});
