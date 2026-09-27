// Targeted regression for the MCP_SERVER dedup gap confirmed in ao-brain
// commit c0a948db (Correction 4). Fixture-only, offline, no writes.
// resourceTypes map in pending-work.mjs must dedupe a native MCPServer
// registry row against its own matching RESOURCE_PUBLICATION approval,
// the same way it already does for Agent/Skill/Blueprint.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as projection from './public/pending-work.mjs';

const stamp = '2026-09-01T00:00:00.000Z';
const reg = entries => ({ ok: true, source: 'aws', entries });
const page = items => ({ ok: true, resource: 'approvals', items, cursor: null });

function mcp({ id = 'test-mcp-server', registryId = 'SyntheticReg1', recordId = 'SynthMcpRec1', domain = 'platform' } = {}) {
  return {
    id, type: 'MCPServer', name: 'TEST native MCP', domain,
    _source: 'agentcore-registry', _registryId: registryId,
    versions: [{ semver: '1.0.0', status: 'IN_REVIEW', createdAt: stamp, submittedAt: stamp,
      _aws: { registryId, recordId, awsStatus: 'PENDING_APPROVAL' } }],
  };
}
function publicationApproval({ domainId = 'platform', resourceId = 'SyntheticReg1/SynthMcpRec1', requesterSubject = 'builder-1', resourceType = 'MCP_SERVER', kind = 'RESOURCE_PUBLICATION' } = {}) {
  return { id: 'appr-1', kind, domainId, resourceType, resourceId, requesterSubject, status: 'PENDING', requestedAt: stamp };
}

test('GREEN: matching MCP_SERVER RESOURCE_PUBLICATION approval dedupes the native row to exactly one actionable row', () => {
  const p = projection.projectPendingWork({ registry: reg([mcp()]), approvals: page([publicationApproval()]) });
  assert.equal(p.rows.filter(r => r.kind === 'registry').length, 0, 'the raw native row must be absorbed, not duplicated');
  assert.equal(p.rows.filter(r => r.kind === 'approval').length, 1, 'exactly one real approval row remains');
  assert.equal(p.count, 1);
});

test('unchanged: no approval at all still leaves exactly one read-only native row', () => {
  const p = projection.projectPendingWork({ registry: reg([mcp()]), approvals: page([]) });
  assert.equal(p.rows.filter(r => r.kind === 'registry').length, 1);
  assert.equal(p.rows.filter(r => r.kind === 'approval').length, 0);
});

test('unchanged: wrong domain on the approval must NOT dedupe (native row stays, approval also stays)', () => {
  const p = projection.projectPendingWork({ registry: reg([mcp({ domain: 'platform' })]), approvals: page([publicationApproval({ domainId: 'otherdomain' })]) });
  assert.equal(p.rows.filter(r => r.kind === 'registry').length, 1, 'cross-domain approval must not silently absorb this domain\'s native row');
  assert.equal(p.rows.filter(r => r.kind === 'approval').length, 1);
});

test('unchanged: wrong resourceId (different record) must NOT dedupe', () => {
  const p = projection.projectPendingWork({ registry: reg([mcp({ recordId: 'DiffRecId001' })]), approvals: page([publicationApproval({ resourceId: 'SyntheticReg1/SynthMcpRec1' })]) });
  assert.equal(p.rows.filter(r => r.kind === 'registry').length, 1);
  assert.equal(p.rows.filter(r => r.kind === 'approval').length, 1);
});

test('unchanged: RESOURCE_ACCESS kind (not RESOURCE_PUBLICATION) must NOT dedupe a registry row', () => {
  const p = projection.projectPendingWork({ registry: reg([mcp()]), approvals: page([publicationApproval({ kind: 'RESOURCE_ACCESS' })]) });
  assert.equal(p.rows.filter(r => r.kind === 'registry').length, 1);
  assert.equal(p.rows.filter(r => r.kind === 'approval').length, 1);
});

test('unchanged: Agent dedup behavior (pre-existing, must still pass) stays correct alongside the new MCPServer entry', () => {
  const agent = {
    id: 'test-agent', type: 'Agent', name: 'TEST agent', domain: 'platform',
    _source: 'agentcore-registry', _registryId: 'SyntheticReg2',
    versions: [{ semver: '1.0.0', status: 'IN_REVIEW', createdAt: stamp, submittedAt: stamp,
      _aws: { registryId: 'SyntheticReg2', recordId: 'SynthAgentRec1', awsStatus: 'PENDING_APPROVAL' } }],
  };
  const approval = { id: 'appr-2', kind: 'RESOURCE_PUBLICATION', domainId: 'platform', resourceType: 'AGENT', resourceId: 'SyntheticReg2/SynthAgentRec1', requesterSubject: 'builder-1', status: 'PENDING', requestedAt: stamp };
  const p = projection.projectPendingWork({ registry: reg([agent]), approvals: page([approval]) });
  assert.equal(p.rows.filter(r => r.kind === 'registry').length, 0);
  assert.equal(p.rows.filter(r => r.kind === 'approval').length, 1);
});
