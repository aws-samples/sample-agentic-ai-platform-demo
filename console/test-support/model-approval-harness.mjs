// Synthetic boundaries only. Execute actual app bodies, validator and transport;
// this VM is not DOM/browser or live acceptance evidence.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { projectPendingWork } from '../public/pending-work.mjs';
import * as helpers from '../public/hosted-approval-request.mjs';
import { hostedActionEnabled, hostedApprovalActionEnabled } from '../public/hosted-persona.mjs';
import { collectPagedItems } from '../public/main-ui-compat.mjs';
import { registryDecisionAllowed, sameRegistryDecisionRecord } from '../public/registry-decision-target.mjs';

export const source = readFileSync(new URL('../public/modules/app.mjs', import.meta.url), 'utf8');
export function fn(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
export const approval = (patch = {}) => ({
  id: 'qa-model-access', domainId: 'operations', kind: 'RESOURCE_ACCESS', resourceType: 'MODEL',
  resourceId: 'bedrock/model-alias', projectId: null, status: 'PENDING', requesterSubject: 'requester',
  approverSubject: null, reason: null, requestedAt: '2026-09-01T00:00:00.000Z', decidedAt: null, ...patch,
});
export function catalog(row = approval()) {
  return { ok: true, source: 'aws', domainId: row.domainId, models: [{
    id: row.resourceId, name: 'Synthetic model', description: 'TEST API only', provider: 'Synthetic',
    access: { status: 'PENDING', usable: false, requestable: true,
      latestRequest: { id: row.id, status: row.status, requestedAt: row.requestedAt }, grant: null,
      limits: { requestsPerMinute: 60, tokensPerMinute: null, connectionsPerSecond: null },
      rateLimit: { status: 'ACTIVE', reason: null, reconciledAt: row.requestedAt } },
  }] };
}
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
export function appHarness({ surface = 'queue', row = approval(), decision = 'APPROVE' } = {}) {
  const reads = [], writes = [], alerts = [], effects = [];
  const store = { rows: [structuredClone(row)], catalog: catalog(row), post: { ok: true }, hook: async () => {} };
  const button = { isConnected: true, disabled: false, closest:()=>null, dataset: { kind: row.kind, resourceType: row.resourceType,
    decision, domain: row.domainId, project: row.projectId || '', resource: row.resourceId, approval: row.id,
    model: row.resourceId } };
  const reason = { value: 'QA rejection' };
  const box = { isConnected: true, innerHTML: '', contains: b => b === button,
    querySelectorAll: selector => selector === (surface === 'queue' ? '.hostedapproval' : '.hostedgatewaydecision') ? [button] : [],
    querySelector: selector => selector.includes('data-reason-for') ? reason : null,
  };
  const ctx = vm.createContext({ ...helpers, CSS: {escape: value => String(value)}, URL, TextEncoder, AbortController, cognitoBootstrapError:null, pendingHostedApprovalDecisions:new Map(), crypto: webcrypto, collectPagedItems,
    projectPendingWork, registryDecisionAllowed, sameRegistryDecisionRecord, hostedActionEnabled, hostedApprovalActionEnabled,
    SESSION: { actor: 'reviewer', role: 'lead' }, sessionEpoch: 1, CANCELED_REQUEST: Symbol('cancelled'),
    caps: ['decideDomainResourceAccess'], domain: row.domainId,
    S: { hostedGatewayCatalog: structuredClone(store.catalog), hostedGatewaySelectedModelId: row.resourceId },
    activeSessionRequests: new Set(), hostedRegistryReadCache: null,
    authMode: () => 'cognito', demoContextHeaders: () => ({}), authHeaders: () => ({ 'x-active-domain': ctx.domain }), apiUrl: p => '/api' + p,
    sessionRequestIsCurrent: request => request.epoch === ctx.sessionEpoch,
    finishSessionRequest: request => ctx.activeSessionRequests.delete(request),
    sessionEpochIsCurrent: epoch => epoch === ctx.sessionEpoch,
    clearHostedRegistryReadCache: () => {}, handleUnauthorized: () => assert.fail('unexpected unauthorized transport'),
    sessionTaskHandler: task => task, hostedCaps: () => ctx.caps, activeDomain: () => ctx.domain,
    requestDemoChoice: async () => 'QA rejection', alert: message => alerts.push(message),
    esc: value => String(value ?? ''), hostedEmpty: () => 'empty', HOSTED_COLLECTION_META: { approvals: { title: 'Approvals' } },
    businessForms: { clear: () => effects.push('clear') }, renderHostedGateway: () => effects.push('render'),
    loadHostedGateway: async () => effects.push('reload'),
    document: { getElementById: id => ['hostedgateway', 'hostedcollection', 'govqueue'].includes(id) ? box : id === 'hostedgatewayreason' ? reason : null },
    fetch: async (path, options) => {
      const entry = { path, body: options.body === undefined ? undefined : JSON.parse(options.body), headers: options.headers };
      (options.method === 'GET' ? reads : writes).push(entry);
      await store.hook(path, options);
      let result;
      if (options.method !== 'GET') {
        if (store.post instanceof Error) throw store.post;
        result = store.post;
      } else if (path.startsWith('/api/approvals?')) result = store.approvalsResponse || { ok: true, resource: 'approvals', items: store.rows, cursor: null };
      else if (path === '/api/ai-gateway') result = store.catalog;
      else if (path === '/api/registry') result = store.registry || { ok: true, source: 'aws', entries: [] };
      else assert.fail('Unexpected offline API path: ' + path);
      if (result instanceof Error) throw result;
      return { status: result?.ok === false ? 503 : 200, ok: result?.ok !== false, text: async () => JSON.stringify(result) };
    },
  });
  for (const name of ['hostedModelReadContext', 'readHostedRegistry', 'clearHostedRegistryReadCache', 'beginSessionRequest', 'createRequestId', 'apiErrorMessage', 'readHostedCollection', 'hostedCollectionRequest',
    'hostedCollectionRow', 'hostedStatus', 'validHostedGatewayCatalog', 'hostedGatewayAccess', 'hostedGatewaySelectedModel',
    'hostedCollectionItems', 'wireHostedApprovalActions', 'hostedGatewayAccessActions', 'wireHostedGateway', 'loadHostedCollection',
    'readGovPendingWork', 'pendingWorkSummaryHtml', 'loadGovQueue', 'revalidateRegistryDecision', 'canDecideRegistryRecord']) vm.runInContext(fn(name), ctx);
  // During red tests these guards do not yet exist; existing action bodies still run.
  for (const name of ['hostedApprovalRecordAllowed', 'hostedApprovalReadOnlyReason', 'sameHostedApprovalRecord', 'revalidateHostedApproval']) {
    if (source.includes('function ' + name + '(')) vm.runInContext(fn(name), ctx);
  }
  const raw = source.slice(source.indexOf('const rawApi ='), source.indexOf('\nfunction clearHostedRegistryReadCache'));
  vm.runInContext(raw + '\n' + fn('mainCompatApi') + '\n' + source.slice(source.indexOf('const api=(p,'), source.indexOf("let cognitoLoginStatus=")), ctx);
  const bind = () => surface === 'queue'
    ? ctx.wireHostedApprovalActions(box, async () => effects.push('reload'), [row])
    : ctx.wireHostedGateway();
  bind();
  return { ctx, row, store, box, button, reason, reads, writes, alerts, effects, bind };
}
