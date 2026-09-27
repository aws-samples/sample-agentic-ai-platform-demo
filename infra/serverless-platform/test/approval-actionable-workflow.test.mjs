import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFixture, REGISTRY, RECORD } from './support/approval-workflow-fixture.mjs';
async function submitted() {
  const f = workflowFixture();
  const draft = await f.draft(); assert.equal(draft.status, 'DRAFT', JSON.stringify(draft));
  const context = await f.context(); assert.equal(context.canSubmit, true, JSON.stringify(context));
  const input = { registryId: REGISTRY, recordId: RECORD, approvalId: context.approvalId, expectedRecordVersion: context.recordVersion };
  const result = await f.call('/api/governance/publications', { body: input, requestId: `submit-${context.approvalId}` });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { ...f, contextData: context, input, result };
}
for (const decision of ['APPROVE', 'REJECT']) test(`actual router/service/Dynamo adapter: owner submits, reviewer ${decision}, applicant reads persisted state`, async () => {
  const f = await submitted();
  const body = { approvalId: f.input.approvalId, decision, reason: 'Synthetic reviewed evidence' };
  const options = { actor: 'synthetic-reviewer', role: 'lead', body, requestId: 'decision-stable' };
  const result = await f.call('/api/governance/publication-decisions', options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const expected = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  assert.equal(result.approval.status, expected); assert.equal(result.record.status, expected);
  assert.equal(result.approval.requesterSubject, 'synthetic-owner');
  assert.equal(result.approval.approverSubject, 'synthetic-reviewer');
  const read = await f.state.listApprovals({ domainId: 'domain_a', limit: 50 });
  assert.equal(read.items[0].status, expected); assert.equal(read.items[0].reason, body.reason);
  const replay = await f.call('/api/governance/publication-decisions', options);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(f.commands.filter(c => c === 'UpdateRegistryRecordStatusCommand').length, 1);
  assert.ok(f.commands.includes('TransactWriteItemsCommand'));
});
test('self review is 403; foreign identity scope is 403; spoofed old identity never submits', async () => {
  const f = await submitted(); const body = { approvalId: f.input.approvalId, decision: 'APPROVE', reason: 'Synthetic reason' };
  const self = await f.call('/api/governance/publication-decisions', { role: 'lead', body }); assert.equal(self.status, 403, JSON.stringify(self));
  const foreign = await f.call('/api/governance/publication-decisions', { actor: 'synthetic-reviewer', role: 'lead', domain: 'domain_a', groups: ['domain-lead','domain-domain-b'], body }); assert.equal(foreign.status, 403, JSON.stringify(foreign));
  const forged = await f.call('/api/governance/publication-decisions', { role: 'builder', headers: { 'x-demo-role': 'lead' }, body }); assert.equal(forged.status, 403);
  assert.equal(f.commands.filter(c => c === 'UpdateRegistryRecordStatusCommand').length, 0);
});
test('missing formal request has legal owner entry; non-owner and unmanaged record cannot submit here', async () => {
  const f = workflowFixture(); await f.draft();
  assert.equal((await f.state.listApprovals({ domainId: 'domain_a' })).items.length, 0);
  assert.equal((await f.context()).canSubmit, true);
  assert.equal((await f.context({ actor: 'synthetic-reviewer', role: 'lead' })).blocker, 'OWNER_REQUIRED');
  const raw = f.records.get(`${REGISTRY}/${RECORD}`); raw.recordVersion = '1.0.0'; raw.descriptors.mcpServer.data = JSON.stringify({ name: 'unmanaged', version: '1.0.0' });
  const context = await f.context(); assert.equal(context.governed, false, JSON.stringify(context)); assert.equal(context.canSubmit, false);
  assert.equal(f.commands.filter(c => c === 'SubmitRegistryRecordForApprovalCommand').length, 0);
});
test('old resource version fails before any publication write; idempotent submission writes once', async () => {
  const f = workflowFixture(); await f.draft(); const ctx = await f.context();
  const body = { registryId: REGISTRY, recordId: RECORD, approvalId: ctx.approvalId, expectedRecordVersion: '0.0.1' };
  const stale = await f.call('/api/governance/publications', { body }); assert.equal(stale.status, 409, JSON.stringify(stale));
  assert.equal(f.commands.filter(c => c === 'SubmitRegistryRecordForApprovalCommand').length, 0);
  body.expectedRecordVersion = ctx.recordVersion;
  for (let i=0;i<2;i++) assert.equal((await f.call('/api/governance/publications', { body, requestId: `submit-${ctx.approvalId}` })).ok, true);
  assert.equal(f.commands.filter(c => c === 'SubmitRegistryRecordForApprovalCommand').length, 1);
});
test('opposite decision after completed review is rejected, preserving original state', async () => {
  const f = await submitted(); const body = { approvalId: f.input.approvalId, decision: 'APPROVE', reason: 'Synthetic approved' };
  assert.equal((await f.call('/api/governance/publication-decisions', { actor: 'synthetic-reviewer', role: 'lead', body })).ok, true);
  const late = await f.call('/api/governance/publication-decisions', { actor: 'synthetic-reviewer', role: 'lead', body: { ...body, decision: 'REJECT' } });
  assert.equal(late.status, 409, JSON.stringify(late));
  assert.equal(f.records.get(`${REGISTRY}/${RECORD}`).status, 'APPROVED');
});
test('simultaneous opposite reviewers are serialized before the external Registry mutation', async () => {
  const f = await submitted();
  const results = await Promise.all(['APPROVE','REJECT'].map((decision,i) => f.call('/api/governance/publication-decisions', { actor: `synthetic-reviewer-${i}`, role: 'lead', body: { approvalId: f.input.approvalId, decision, reason: 'Concurrent synthetic evidence' } })));
  assert.deepEqual(results.map(r=>r.status).sort(), [200,409]);
  assert.equal(f.commands.filter(c=>c==='UpdateRegistryRecordStatusCommand').length, 1);
  const persisted = (await f.state.listApprovals({domainId:'domain_a'})).items[0];
  assert.equal(persisted.status, f.records.get(`${REGISTRY}/${RECORD}`).status);
});
