// OFFLINE synthetic authorization regression. Removing the Governance RBAC
// tab must not change hosted action gates or backend scope/entitlement checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitiesForRole } from '../infra/serverless-platform/lambda/authz/capabilities.mjs';
import { createAuthorizer } from '../infra/serverless-platform/lambda/authz/authorize.mjs';
import { hostedActionEnabled, hostedApprovalActionEnabled } from './public/hosted-persona.mjs';
import { registryDecisionAllowed, registryDecisionTarget } from './public/registry-decision-target.mjs';

test('real hosted action gates remain unchanged without RBAC tab', () => {
  for (const [role, allowed, denied] of [
    ['admin', ['createDomain', 'updateModelPolicy'], ['decideModelAccess', 'decideSharedResourceAccess', 'invokeEntitledAgent']],
    ['lead', ['createAgent', 'decideModelAccess', 'decideSharedResourceAccess'], ['createDomain', 'updateModelPolicy', 'invokeEntitledAgent']],
    ['builder', ['createAgent', 'testAgent', 'deploySandbox', 'submitProductionDeployment', 'requestModelAccess'], ['decideResourcePublication', 'decideProductionDeployment', 'decideModelAccess']],
    ['user', ['invokeEntitledAgent', 'submitAgentFeedback', 'requestAgentAccess'], ['createAgent', 'decideResourcePublication', 'decideModelAccess']],
  ]) {
    for (const action of allowed) assert.equal(hostedActionEnabled(action, capabilitiesForRole(role)), true, `${role}: ${action}`);
    for (const action of denied) assert.equal(hostedActionEnabled(action, capabilitiesForRole(role)), false, `${role}: ${action}`);
  }

});

function authorize({ role, domain = 'synthetic-domain', action = 'resource:publication-approve', self = false, entitlement = true, owner = true, project = true, state = 'PENDING_APPROVAL' }) {
  return createAuthorizer({
    resolvePrincipal: async () => ({ id: 'synthetic-reviewer', role, domainIds: ['synthetic-domain'], projectIds: project ? ['synthetic-project'] : [], activeDomain: 'synthetic-domain' }),
    resolveResource: async () => ({ id: 'synthetic-resource', domainId: domain, projectId: 'synthetic-project', ownerId: owner ? 'synthetic-reviewer' : 'synthetic-other', assigneeIds: [], lifecycleState: state }),
    resolvePolicy: async () => ({ allowed: true }),
    resolveApproval: async () => ({ requesterId: self ? 'synthetic-reviewer' : 'synthetic-requester', resourceId: 'synthetic-resource', action }),
    resolveEntitlement: async () => ({ granted: entitlement }),
    clock: () => Date.parse('2026-09-01T00:00:00Z'),
  })({ requestContext: {}, action, resourceRef: 'synthetic-resource', ...(['resource:publication-approve', 'deployment:approve', 'model-access:decide', 'resource:access-decide'].includes(action) ? { approvalRef: 'synthetic-approval' } : {}) });
}
for (const action of ['resource:publication-approve', 'deployment:approve']) {
  for (const role of ['admin', 'lead', 'builder', 'user']) {
    for (const domain of ['platform', 'synthetic-domain', 'synthetic-foreign']) {
      test(`copy/backend agreement: ${role} ${action} ${domain}`, async () => {
        const allowed = (role === 'admin' && domain === 'platform') || (role === 'lead' && domain === 'synthetic-domain');
        const kind = action === 'deployment:approve' ? 'PRODUCTION_DEPLOYMENT' : 'RESOURCE_PUBLICATION';
        assert.equal(hostedApprovalActionEnabled(kind, capabilitiesForRole(role), { recordDomainId: domain, activeDomainId: 'synthetic-domain' }), allowed);
        if (allowed) assert.equal((await authorize({ role, domain, action })).decision, 'ALLOW');
        else await assert.rejects(authorize({ role, domain, action }), error => ['FORBIDDEN', 'NOT_FOUND'].includes(error.decision));
      });
    }
  }
  for (const [role, domain] of [['admin', 'platform'], ['lead', 'synthetic-domain']]) test(`${role} cannot decide own ${action}`, async () => {
    await assert.rejects(authorize({ role, domain, action, self: true }), error => error.reason === 'REQUESTER_IS_APPROVER');
  });
}
for (const action of ['model-access:decide', 'resource:access-decide']) {
  test(`${action}: domain lead only, own request and foreign domain rejected`, async () => {
    assert.equal((await authorize({ role: 'lead', action })).decision, 'ALLOW');
    for (const role of ['admin', 'builder', 'user']) await assert.rejects(authorize({ role, action }), error => error.reason === 'CAPABILITY');
    await assert.rejects(authorize({ role: 'lead', action, self: true }), error => error.reason === 'REQUESTER_IS_APPROVER');
    await assert.rejects(authorize({ role: 'lead', action, domain: 'synthetic-foreign' }), error => error.reason === 'DOMAIN_SCOPE');
  });
}
test('builder copy preserves project and ownership restrictions', async () => {
  const input = { role: 'builder', action: 'agent:update', state: 'DRAFT' };
  assert.equal((await authorize(input)).decision, 'ALLOW');
  await assert.rejects(authorize({ ...input, owner: false }), error => error.reason === 'OWNER_SCOPE');
  await assert.rejects(authorize({ ...input, project: false }), error => error.reason === 'PROJECT_SCOPE');
});
test('End User approved/active status alone does not grant invocation', async () => {
  const input = { role: 'user', action: 'agent:invoke', state: 'ACTIVE' };
  assert.equal((await authorize(input)).decision, 'ALLOW');
  await assert.rejects(authorize({ ...input, entitlement: false }), error => error.reason === 'ENTITLEMENT');
});

function native(type, domain = 'platform') {
  return [{ id: 'synthetic-entry', type, domain, _source: 'agentcore-registry' },
    { semver: '1.0.0', status: 'IN_REVIEW', _aws: { registryId: 'SyntheticReg', recordId: 'SyntheticRec', awsStatus: 'PENDING_APPROVAL' } }];
}
test('native versions remain distinct from formal publication workflows', () => {
  for (const type of ['Skill', 'Blueprint', 'A2AAgent', 'MCPServer']) {
    for (const domain of ['platform', 'shared']) assert.equal(registryDecisionTarget(...native(type, domain), true), 'registry');
    assert.equal(registryDecisionTarget(...native(type, 'synthetic-domain'), true), null);
  }
  // Model is never a native record; gateway-sourced MCP/Model stay policy-governed.
  assert.equal(registryDecisionTarget(...native('Model'), true), null);
  assert.equal(registryDecisionTarget(...native('Agent'), true), 'publication');
  const [entry, version] = native('Agent');
  const options = { hosted: true, canDecide: true, actor: 'synthetic-reviewer', approvalId: 'synthetic-approval' };
  assert.equal(registryDecisionAllowed(entry, version, options), false);
  version._approval = { id: options.approvalId, kind: 'RESOURCE_PUBLICATION', resourceType: 'AGENT', status: 'PENDING', requesterSubject: 'synthetic-requester', resourceId: 'SyntheticReg/SyntheticRec' };
  assert.equal(registryDecisionAllowed(entry, version, options), true);
  version._approval.requesterSubject = options.actor;
  assert.equal(registryDecisionAllowed(entry, version, options), false);
});
