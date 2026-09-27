// AUD-003: platform-admin "no domain selected" must not collapse into the
// same undifferentiated state as "not admitted anywhere" / "denied". This
// exercises the pure helper directly (no app.mjs, no server) so it stays
// isolated from the shared frontend owned by the parallel Governance UX work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registryModelStatus } from './public/registry-model-status.mjs';

function gatewayEntry(id, defaultVersion = '1.0.0') {
  return {
    id,
    type: 'Model',
    _source: 'gateway',
    defaultVersion,
    versions: [{
      semver: defaultVersion,
      content: { gatewayModelId: id, source: 'agentcore-gateway', runtimeModelId: `runtime.${id}` },
    }],
  };
}

function adminModel(id, { policy = null, accessByDomain = {} } = {}) {
  return { id, policy, accessByDomain };
}

test('admin, no domain selected, model never admitted anywhere: platformAdmission is explicit, not just "unverified"', () => {
  const entry = gatewayEntry('bedrock-mantle/anthropic.claude-haiku-4-5');
  const catalog = {
    ok: true,
    source: 'aws',
    models: [adminModel(entry.id, { policy: null, accessByDomain: { operations: { status: 'REQUESTABLE' } } })],
  };
  const view = registryModelStatus(entry, { catalog, domainId: null, role: 'admin', state: 'ready' });
  assert.equal(view.access, null);
  assert.match(view.message, /no current domain selected/);
  assert.ok(view.platformAdmission);
  assert.equal(view.platformAdmission.applicationStatus, null);
  assert.deepEqual(view.platformAdmission.grantedDomains, []);
});

test('admin, no domain selected, model admitted and already granted in another domain: platformAdmission surfaces it', () => {
  const entry = gatewayEntry('bedrock-mantle/deepseek.v3.1');
  const catalog = {
    ok: true,
    source: 'aws',
    models: [adminModel(entry.id, {
      policy: { applicationStatus: 'ACTIVE' },
      accessByDomain: {
        operations: { status: 'ALLOWED' },
        research: { status: 'REQUESTABLE' },
      },
    })],
  };
  const view = registryModelStatus(entry, { catalog, domainId: null, role: 'admin', state: 'ready' });
  assert.equal(view.access, null, 'no domain selected still means no scoped access decision');
  assert.match(view.message, /no current domain selected/, 'unresolved-view wording is unchanged for compatibility');
  assert.ok(view.platformAdmission, 'must not conflate "not selected" with "not admitted"');
  assert.equal(view.platformAdmission.applicationStatus, 'ACTIVE');
  assert.deepEqual(view.platformAdmission.grantedDomains, ['operations']);
  assert.deepEqual(view.platformAdmission.requestableDomains, ['research']);
});

test('non-admin role never receives platformAdmission (scoped users only see their own domain access)', () => {
  const entry = gatewayEntry('bedrock-mantle/google.gemma-3-12b-it');
  const catalog = { domainId: 'operations', models: [{ id: entry.id, access: { status: 'ALLOWED', usable: true } }] };
  const view = registryModelStatus(entry, { catalog, domainId: 'operations', role: 'lead' });
  assert.equal(view.platformAdmission, null);
});

test('no catalog yet (loading/unavailable): platformAdmission stays null, never a guessed default', () => {
  const entry = gatewayEntry('bedrock-mantle/google.gemma-3-27b-it');
  const loading = registryModelStatus(entry, { catalog: null, domainId: null, role: 'admin', state: 'loading' });
  assert.equal(loading.platformAdmission, null);
  const unavailable = registryModelStatus(entry, { catalog: null, domainId: null, role: 'admin', state: 'unavailable' });
  assert.equal(unavailable.platformAdmission, null);
});

test('stale catalog held from a prior ready read must not leak platformAdmission while state is loading', () => {
  const entry = gatewayEntry('bedrock-mantle/deepseek.v3.2');
  const staleReadyCatalog = {
    ok: true,
    source: 'aws',
    models: [adminModel(entry.id, { policy: { applicationStatus: 'ACTIVE' }, accessByDomain: { operations: { status: 'ALLOWED' } } })],
  };
  const view = registryModelStatus(entry, { catalog: staleReadyCatalog, domainId: null, role: 'admin', state: 'loading' });
  assert.equal(view.platformAdmission, null, 'a domain switch/refresh in flight must not show the previous read\'s admission state');
});

test('stale catalog held after the live read became unavailable must not leak platformAdmission', () => {
  const entry = gatewayEntry('bedrock-mantle/deepseek.v3.2');
  const staleReadyCatalog = {
    ok: true,
    source: 'aws',
    models: [adminModel(entry.id, { policy: { applicationStatus: 'ACTIVE' }, accessByDomain: { operations: { status: 'ALLOWED' } } })],
  };
  const view = registryModelStatus(entry, { catalog: staleReadyCatalog, domainId: null, role: 'admin', state: 'unavailable' });
  assert.equal(view.platformAdmission, null, 'an unavailable current read must not fall back to a stale successful read\'s admission state');
});

test('a domain-scoped admin catalog (has domainId key) is a Lead/Builder-shaped contract, not the platform admission source', () => {
  const entry = gatewayEntry('bedrock-mantle/anthropic.claude-haiku-4-5');
  const catalog = { domainId: 'operations', models: [adminModel(entry.id, { policy: { applicationStatus: 'ACTIVE' } })] };
  const view = registryModelStatus(entry, { catalog, domainId: null, role: 'admin', state: 'ready' });
  assert.equal(view.platformAdmission, null);
});

test('ambiguous/unresolved model identity never reports a platform admission state', () => {
  const entries = [gatewayEntry('dup'), gatewayEntry('dup')];
  const catalog = { ok: true, models: [adminModel('dup', { policy: { applicationStatus: 'ACTIVE' } })] };
  const view = registryModelStatus(entries[0], { entries, catalog, domainId: null, role: 'admin', state: 'ready' });
  assert.equal(view.access, null);
  assert.equal(view.platformAdmission, null);
});
