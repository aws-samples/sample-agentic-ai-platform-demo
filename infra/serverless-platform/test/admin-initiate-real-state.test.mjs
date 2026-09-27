// INTEGRATION test for the admin-initiate publication flow wired against the
// REAL createWorkspaceState workspace-state layer (via workflowFixture), NOT the
// in-memory fake putApproval used by governance-service.test.mjs.
//
// This is the coverage gap that let the MUTATION_DECISION_MISMATCH bug ship:
// initiatePublication persisted its CREATE approval with decision:"initiate",
// but the real state layer's expectedMutationDecision returns {decision:"create"}
// for ANY CREATE, so validateMutationBinding threw MUTATION_DECISION_MISMATCH ->
// WORKSPACE_UNAVAILABLE (503). The fake state never enforced that binding, so
// 91/91 governance unit tests passed while the live path 503'd.
//
// The resource is seeded in the PLATFORM domain (owner != admin) so the full
// admin-initiate -> same-admin self-reject -> independent-admin approve chain
// is coherent (admin decide is pinned to the platform active domain).
//
//   - PRE-FIX: admin-initiate returns 503 (WORKSPACE_UNAVAILABLE) and strands
//     the record in PENDING_APPROVAL with no approval.
//   - POST-FIX: admin-initiate succeeds (approval persisted, record flipped),
//     same-admin self-decide is blocked (REQUESTER_CANNOT_APPROVE, status
//     unchanged), and an independent admin reviewer can APPROVE (persists,
//     audit retains initiator + decider).
import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowFixture, PLATFORM_REGISTRY, RECORD } from './support/approval-workflow-fixture.mjs';

const INITIATE = '/api/governance/publication-initiations';
const DECIDE = '/api/governance/publication-decisions';

// Seed a genuinely-pending platform resource owned by someone OTHER than the
// initiating admin. The owner drafts it; nobody has filed the formal
// publication request yet (the dead-end this feature closes).
async function pendingPlatformResource() {
  const f = workflowFixture();
  const draft = await f.draftPlatform();
  assert.equal(draft.status, 'DRAFT', JSON.stringify(draft));
  return f;
}

function initiateBody() {
  return { registryId: PLATFORM_REGISTRY, recordId: RECORD, reason: 'Admin-initiated independent review' };
}

test('admin-initiate wires the REAL workspace-state mutation binding: initiate SUCCEEDS (no 503), approval persists, record flips', async () => {
  const f = await pendingPlatformResource();
  const result = await f.call(INITIATE, {
    actor: 'synthetic-admin', role: 'admin', domain: 'platform',
    body: initiateBody(), requestId: 'initiate-real-state-1',
  });
  // Pre-fix this is 503 WORKSPACE_UNAVAILABLE (MUTATION_DECISION_MISMATCH).
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.approval.status, 'PENDING', JSON.stringify(result.approval));
  // Self-approval invariant: requester is the AUTHENTICATED admin (initiator),
  // NOT the resource owner.
  assert.equal(result.approval.requesterSubject, 'synthetic-admin');
  assert.equal(result.approval.approverSubject, null);
  // Record was flipped to PENDING_APPROVAL.
  assert.equal(result.record.status, 'PENDING_APPROVAL');
  assert.equal(f.records.get(`${PLATFORM_REGISTRY}/${RECORD}`).status, 'PENDING_APPROVAL');
  // Actually readable back from real state (not just returned).
  const read = await f.state.listApprovals({ domainId: 'platform', limit: 50 });
  const persisted = read.items.find(a => a.requesterSubject === 'synthetic-admin');
  assert.ok(persisted, `approval not persisted in real state: ${JSON.stringify(read)}`);
  assert.equal(persisted.status, 'PENDING');
});

test('SIDE-EFFECT (recoverable ordering): a failed approval persist does NOT strand the record in PENDING_APPROVAL', async () => {
  const f = await pendingPlatformResource();
  // Force the approval persist to fail AFTER the claim. With the atomic
  // ordering fix (persist approval FIRST, then flip registry status), a failed
  // putApproval must leave the record untouched (DRAFT) with NO registry flip.
  // Pre-fix (flip-then-persist) this stranded the record in PENDING_APPROVAL.
  const realPut = f.state.putApproval.bind(f.state);
  f.state.putApproval = async () => {
    const err = new Error('synthetic approval-persist failure');
    err.code = 'WORKSPACE_UNAVAILABLE';
    throw err;
  };
  const failed = await f.call(INITIATE, {
    actor: 'synthetic-admin', role: 'admin', domain: 'platform',
    body: initiateBody(), requestId: 'initiate-persist-fail',
  });
  assert.notEqual(failed.status, 201, JSON.stringify(failed));
  // Record NOT stranded: still DRAFT, and the registry flip command was never
  // emitted (approval-first ordering means the flip only runs after persist).
  assert.equal(f.records.get(`${PLATFORM_REGISTRY}/${RECORD}`).status, 'DRAFT');
  assert.equal(f.commands.filter(c => c === 'SubmitRegistryRecordForApprovalCommand').length, 0);
  // Restore and confirm a subsequent clean initiate then succeeds + flips once.
  f.state.putApproval = realPut;
  const ok = await f.call(INITIATE, {
    actor: 'synthetic-admin', role: 'admin', domain: 'platform',
    body: initiateBody(), requestId: 'initiate-persist-fail',
  });
  assert.equal(ok.status, 201, JSON.stringify(ok));
  assert.equal(f.records.get(`${PLATFORM_REGISTRY}/${RECORD}`).status, 'PENDING_APPROVAL');
});

test('admin-initiate is idempotent against real state (retry same requestId flips registry once)', async () => {
  const f = await pendingPlatformResource();
  const body = initiateBody();
  const first = await f.call(INITIATE, { actor: 'synthetic-admin', role: 'admin', domain: 'platform', body, requestId: 'initiate-idem' });
  const second = await f.call(INITIATE, { actor: 'synthetic-admin', role: 'admin', domain: 'platform', body, requestId: 'initiate-idem' });
  assert.equal(first.status, 201, JSON.stringify(first));
  assert.equal(second.status, 201, JSON.stringify(second));
  assert.equal(f.commands.filter(c => c === 'SubmitRegistryRecordForApprovalCommand').length, 1);
});

test('NEG self-approval: the initiating admin cannot decide their own initiated request; status unchanged', async () => {
  const f = await pendingPlatformResource();
  const initiate = await f.call(INITIATE, {
    actor: 'synthetic-admin', role: 'admin', domain: 'platform',
    body: initiateBody(), requestId: 'initiate-neg',
  });
  assert.equal(initiate.status, 201, JSON.stringify(initiate));
  const approvalId = initiate.approval.id;
  // Same admin attempts to decide -> blocked by requester != approver guard.
  const selfDecide = await f.call(DECIDE, {
    actor: 'synthetic-admin', role: 'admin', domain: 'platform',
    body: { approvalId, decision: 'APPROVE', reason: 'Trying to self-approve' },
    requestId: 'self-decide-neg',
  });
  assert.equal(selfDecide.status, 403, JSON.stringify(selfDecide));
  assert.equal(selfDecide.code, 'REQUESTER_CANNOT_APPROVE', JSON.stringify(selfDecide));
  // Status unchanged: approval still PENDING, record still PENDING_APPROVAL.
  const read = await f.state.listApprovals({ domainId: 'platform', limit: 50 });
  const persisted = read.items.find(a => a.id === approvalId);
  assert.equal(persisted.status, 'PENDING', JSON.stringify(persisted));
  assert.equal(f.records.get(`${PLATFORM_REGISTRY}/${RECORD}`).status, 'PENDING_APPROVAL');
  assert.equal(f.commands.filter(c => c === 'UpdateRegistryRecordStatusCommand').length, 0);
});

test('POS independent reviewer: a different admin APPROVES the admin-initiated request; audit retains initiator + decider', async () => {
  const f = await pendingPlatformResource();
  const initiate = await f.call(INITIATE, {
    actor: 'synthetic-admin', role: 'admin', domain: 'platform',
    body: initiateBody(), requestId: 'initiate-pos',
  });
  assert.equal(initiate.status, 201, JSON.stringify(initiate));
  const approvalId = initiate.approval.id;
  // Independent admin reviewer (different subject) approves.
  const decide = await f.call(DECIDE, {
    actor: 'synthetic-admin-2', role: 'admin', domain: 'platform',
    body: { approvalId, decision: 'APPROVE', reason: 'Independent review approved' },
    requestId: 'reviewer-approve-pos',
  });
  assert.equal(decide.status, 200, JSON.stringify(decide));
  assert.equal(decide.ok, true, JSON.stringify(decide));
  assert.equal(decide.approval.status, 'APPROVED');
  // Audit retains BOTH the initiator (requester) and the independent decider.
  assert.equal(decide.approval.requesterSubject, 'synthetic-admin');
  assert.equal(decide.approval.approverSubject, 'synthetic-admin-2');
  assert.equal(decide.record.status, 'APPROVED');
  // Persisted read-back confirms it stuck.
  const read = await f.state.listApprovals({ domainId: 'platform', limit: 50 });
  const persisted = read.items.find(a => a.id === approvalId);
  assert.equal(persisted.status, 'APPROVED', JSON.stringify(persisted));
  assert.equal(persisted.requesterSubject, 'synthetic-admin');
  assert.equal(persisted.approverSubject, 'synthetic-admin-2');
});

for (const mode of ['submit-outage','owner-drift','version-drift']) test(`recoverable initiation: ${mode} after approval persistence`,async()=>{
 const f=await pendingPlatformResource();
 const send=f.registryClient.send.bind(f.registryClient);
 let failed=false;
 f.registryClient.send=async command=>{
  if(mode==='submit-outage'&&!failed&&command.constructor.name==='SubmitRegistryRecordForApprovalCommand'){
   failed=true;throw Error('Synthetic Registry outage');
  }
  return send(command);
 };
 if(mode!=='submit-outage'){
  const put=f.state.putApproval.bind(f.state);
  f.state.putApproval=async input=>{
   const result=await put(input);const r=f.records.get(`${PLATFORM_REGISTRY}/${RECORD}`);
   if(mode==='owner-drift'){
    const descriptor=JSON.parse(r.descriptors.mcpServer.data);descriptor['x-platform'].ownerSubject='changed-owner';r.descriptors.mcpServer.data=JSON.stringify(descriptor);
   }else r.recordVersion='2.0.0-platform-descriptor.1';
   return result;
  };
 }
 const request={actor:'synthetic-admin',role:'admin',domain:'platform',body:initiateBody(),requestId:`recover-${mode}`};
 const first=await f.call(INITIATE,request);assert.notEqual(first.status,201);
 assert.equal(f.records.get(`${PLATFORM_REGISTRY}/${RECORD}`).status,'DRAFT');
 if(mode==='submit-outage'){
  const retry=await f.call(INITIATE,request);assert.equal(retry.status,201,JSON.stringify(retry));
  assert.equal(retry.record.status,'PENDING_APPROVAL');
 }else assert.equal(f.commands.filter(c=>c==='SubmitRegistryRecordForApprovalCommand').length,0);
});
test('terminal approval replay never resubmits an approved record',async()=>{
 const f=await pendingPlatformResource();const request={actor:'synthetic-admin',role:'admin',domain:'platform',body:initiateBody(),requestId:'terminal-init'};
 const init=await f.call(INITIATE,request);
 const result=await f.call(DECIDE,{actor:'synthetic-admin-2',role:'admin',domain:'platform',body:{approvalId:init.approval.id,decision:'APPROVE',reason:'Independent review complete'},requestId:'terminal-decision'});
 assert.equal(result.status,200);const before=f.commands.filter(c=>c==='SubmitRegistryRecordForApprovalCommand').length;
 assert.equal((await f.call(INITIATE,request)).status,409);
 assert.equal(f.commands.filter(c=>c==='SubmitRegistryRecordForApprovalCommand').length,before);
});

test('same reserved reviewer can recover a failed status write, never a different request',async()=>{
 const f=await pendingPlatformResource();const init=await f.call(INITIATE,{actor:'synthetic-admin',role:'admin',domain:'platform',body:initiateBody(),requestId:'write-retry-init'});
 const send=f.registryClient.send.bind(f.registryClient);let failed=false;
 f.registryClient.send=async c=>{if(!failed&&c.constructor.name==='UpdateRegistryRecordStatusCommand'){failed=true;throw Error('Synthetic AccessDenied before write');}return send(c);};
 const request={actor:'synthetic-admin-2',role:'admin',domain:'platform',body:{approvalId:init.approval.id,decision:'APPROVE',reason:'Independent reviewer retry'},requestId:'reserved-status-write'};
 assert.equal((await f.call(DECIDE,request)).status,503);
 assert.equal((await f.call(DECIDE,{...request,requestId:'different-request'})).status,409);
 const retry=await f.call(DECIDE,request);assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.approval.status,'APPROVED');
});
