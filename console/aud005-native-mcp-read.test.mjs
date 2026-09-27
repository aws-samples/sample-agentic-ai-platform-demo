// OFFLINE ONLY, synthetic fixtures. Proves: legitimate native MCPServer records
// are read as valid registry inventory (approved and IN_REVIEW alike), and that
// a genuine agentcore-registry native MCPServer in a platform/shared domain is a
// decidable target for a capability-holding admin (registryDecisionTarget/
// registryDecisionAllowed in registry-decision-target.mjs), while gateway MCP and
// non-privileged callers stay fail-closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as projection from './public/pending-work.mjs';
import { registryDecisionTarget, registryDecisionAllowed } from './public/registry-decision-target.mjs';

const stamp = '2026-09-01T00:00:00.000Z';
const reg = entries => ({ ok: true, source: 'aws', entries });
const page = items => ({ ok: true, resource: 'approvals', items, cursor: null });

function mcp(status = 'APPROVED', awsStatus = 'APPROVED', recordId = 'SynthMcpRec1') {
  return {
    id: 'test-mcp-server', type: 'MCPServer', name: 'TEST native MCP', domain: 'platform',
    _source: 'agentcore-registry', _registryId: 'SyntheticReg1',
    versions: [{ semver: '1.0.0', status, createdAt: stamp,
      submittedAt: status === 'IN_REVIEW' ? stamp : undefined,
      _aws: { registryId: 'SyntheticReg1', recordId, awsStatus } }],
  };
}

test('RED (pre-fix): approved native MCPServer must not poison Registry as incomplete', () => {
  const p = projection.projectPendingWork({ registry: reg([mcp()]), approvals: page([]) });
  assert.equal(p.complete, true, `expected complete registry read, got problems=${JSON.stringify(p.problems)}`);
  assert.deepEqual(p.problems, []);
});

test('RED (pre-fix): IN_REVIEW native MCPServer renders as a real read-only pending row, not an incomplete source', () => {
  const p = projection.projectPendingWork({ registry: reg([mcp('IN_REVIEW', 'PENDING_APPROVAL')]), approvals: page([]) });
  assert.equal(p.complete, true, `expected complete registry read, got problems=${JSON.stringify(p.problems)}`);
  assert.equal(p.count, 0);
  assert.equal(p.resourceReviewCount, 1);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].kind, 'registry');
  assert.equal(p.rows[0].entry.type, 'MCPServer');
});

test('native MCPServer decision route: platform/shared native MCP is decidable only by a capability holder; gateway MCP and non-privileged stay fail-closed', () => {
  const entry = mcp('IN_REVIEW', 'PENDING_APPROVAL');
  const version = entry.versions[0];
  // Genuine agentcore-registry native MCPServer in a platform domain is now an
  // in-queue decision target, gated on the decide capability (server re-authorizes).
  assert.equal(registryDecisionTarget(entry, version, true), 'registry');
  assert.equal(registryDecisionAllowed(entry, version, { hosted: true, canDecide: true, actor: 'test-actor' }), true);
  assert.equal(registryDecisionAllowed(entry, version, { hosted: true, canDecide: false, actor: 'test-actor' }), false);
  // Domain-owned native MCP still requires domain-lead handling, not platform decide.
  const domainMcp = { ...entry, domain: 'domain_a' };
  assert.equal(registryDecisionTarget(domainMcp, version, true), null);
  assert.equal(registryDecisionAllowed(domainMcp, version, { hosted: true, canDecide: true, actor: 'test-actor' }), false);
  // Gateway-sourced MCP is policy-governed and never a native decision target.
  const gatewayMcp = { ...entry, _source: 'gateway' };
  assert.equal(registryDecisionTarget(gatewayMcp, version, true), 'tool-policy');
  assert.equal(registryDecisionAllowed(gatewayMcp, version, { hosted: true, canDecide: true, actor: 'test-actor' }), false);
});

test('malformed native MCPServer (bad ids/version) still reported as incomplete, not silently valid', () => {
  const bad = mcp('IN_REVIEW', 'PENDING_APPROVAL', 'short');
  const p = projection.projectPendingWork({ registry: reg([bad]), approvals: page([]) });
  assert.equal(p.complete, false);
  assert.match(p.problems.join(' '), /Registry/);
});
