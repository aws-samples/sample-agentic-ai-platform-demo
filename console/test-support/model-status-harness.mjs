// TEST DATA only. Reuse the existing actual-app extractor/transport harness.
// Minimal DOM boundary executes rendered controls; not browser/visual evidence.
import vm from 'node:vm';
import { appHarness, fn, source, catalog, deferred } from './model-approval-harness.mjs';
export { deferred };
export const stamp = '2026-09-01T00:00:00.000Z';
export function inventory(count = 47) {
  return Array.from({ length: count }, (_, i) => ({
    id: `test-gateway/model-${i}`, type: 'Model', name: `TEST DATA model ${i}`, description: 'Synthetic inventory',
    governanceMode: 'federated', domain: 'shared', domainOwner: null, defaultVersion: '1.0.0', _source: 'gateway',
    _gateway: 'test-gateway', _catalogMatch: i === 0,
    versions: [{ semver: '1.0.0', status: i === 0 ? 'APPROVED' : 'IN_REVIEW',
      content: { gatewayModelId: `test-gateway/model-${i}`, runtimeModelId: `test-runtime.model-${i}`, source: 'agentcore-gateway' },
      createdBy: 'gateway', createdAt: stamp, decidedBy: i === 0 ? 'gateway' : null, decidedAt: i === 0 ? stamp : null,
      changelog: 'TEST DATA discovery', autoChecks: [] }],
  }));
}
export function domainCatalog(id = 'test-gateway/model-0', domainId = 'operations') {
  const result = catalog(); result.domainId = domainId; result.models[0].id = id;
  Object.assign(result.models[0].access, { status: 'ALLOWED', usable: true, requestable: false, latestRequest: null });
  return result;
}
function node(id = '', dataset = {}) {
  let html = '', children = [];
  return { id, dataset, classes: [], isConnected: true, value: '', disabled: false,
    get innerHTML() { return html; },
    set innerHTML(value) {
      children.forEach(child => { child.isConnected = false; }); html = value; children = [];
      for (const match of value.matchAll(/<(?:tr|div|button|input|select|span)\b([^>]*)>/g)) {
        const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] || '']));
        if (!attrs.id && !attrs.class && !Object.keys(attrs).some(k => k.startsWith('data-'))) continue;
        const data = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k,v]) => [k.slice(5).replace(/-([a-z])/g, (_,c) => c.toUpperCase()), v]));
        const child = node(attrs.id, data); child.classes = (attrs.class || '').split(' '); child.value = attrs.value || ''; children.push(child);
      }
    },
    querySelectorAll(selector) { return children.flatMap(child => [
      ...(selector.split(',').some(s => s.startsWith('.') ? child.classes.includes(s.slice(1)) : s.startsWith('#') ? child.id === s.slice(1) : s.startsWith('[data-') ? Object.hasOwn(child.dataset, s.slice(6,-1).replace(/-([a-z])/g, (_,c) => c.toUpperCase())) : false) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    append(child) { children.push(child); html += child.innerHTML; },
    contains(child) { return children.includes(child); },
  };
}
export async function statusHarness() {
  const h = appHarness();
  const roots = Object.fromEntries(['regbox','regstore','regdrawerwrap','regsearch','regmodelview','hostedgateway'].map(id => [id,node(id)]));
  const find = id => roots[id] || Object.values(roots).map(root => root.querySelector('#'+id)).find(Boolean) || null;
  h.ctx.document = { createElement: () => node(), getElementById: find, querySelectorAll: selector => Object.values(roots).flatMap(root => root.querySelectorAll(selector)) };
  // Execute the real submission mount, not a success stub. These model tests
  // inspect native controls only; end-to-end eligibility is covered in Chromium.
  h.ctx.mountPublicationSubmission = (await import('../public/publication-submission.mjs')).mountPublicationSubmission;
  h.ctx.hostedCaps = () => h.ctx.caps || [];
  h.ctx.readHostedCollection = async () => ({ ok: true, resource: 'approvals', items: [], cursor: null });
  h.ctx.S = { view: 'registry', registryFilterType: 'Model', registryEntries: [], registryDrawerId: null };
  Object.assign(h.ctx, { demoContextHeaders: () => ({}), registryModelLoadGeneration: 0, hostedGatewayLoadGeneration: 0,
    REG_TYPE_ICON: { Model: '', Skill: '', Agent: '' }, REG_PAGE_SIZE: 50, REG_USE_SET: {}, AGENT_IC: '',
    confirmContextChange: () => true, hasCap: () => false, domChip: value => value, govModeBadge: value => value,
    storyLine: () => '', scopeNote: () => '', render: () => {},
    hostedRetryState: box => { box.innerHTML = 'AI Gateway unavailable'; },
    renderHostedGateway: () => { h.effects.push('render'); },
  });
  // Default to mixed inventory to exercise scoped /ai-gateway projection.
  // Dedicated Model-view tests explicitly select the Model tab.
  h.ctx.S.registryFilterType = 'All';
  const { mountRecentModelCatalog } = await import('../public/recent-model-catalog.mjs');
  h.ctx.mountRecentModelCatalog = options => mountRecentModelCatalog({...options, document:h.ctx.document, ...(h.store.recentCatalog?{catalog:h.store.recentCatalog}:{})});
  // Use production escaping and lifecycle vocabulary, not test equivalents.
  vm.runInContext(source.slice(source.indexOf('const esc ='), source.indexOf('\n', source.indexOf('const esc ='))), h.ctx);
  vm.runInContext(source.slice(source.indexOf('const REG_STATUS_BADGE ='), source.indexOf('// Who signed off')), h.ctx);
  const helperUrl = new URL('../public/registry-model-status.mjs', import.meta.url);
  try { Object.assign(h.ctx, await import(helperUrl)); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
  Object.assign(h.ctx, await import('../public/model-provider-facts.mjs'));
  for (const name of ['openRecentModelAccess','registryModelGroupsHtml','hostedModelReadContext','registryModelView','registryModelStatusHtml','regApprover','regUseButton','registrySourceTitle',
    'registryModelMetadata','registryModelDetailsHtml','renderRegistryUnavailable','loadRegistry','modelAccessHtml','modelLfmHtml','modelLineageHtml','domainListHtml','renderRegistryDrawer',
    'vRegistry','wireRegistry','wireRegistryControls','openRegistryCreatePanel','loadHostedGateway','hostedGatewayLimits','diffHtml','lineDiff']) {
    if (source.includes('function '+name+'(')) vm.runInContext(fn(name), h.ctx);
  }
  h.store.registry = { ok: true, source: 'aws', entries: inventory() };
  h.store.catalog = domainCatalog();
  h.store.rows = [];
  h.ctx.fetch = async (path, options) => {
    if (options.method !== 'GET') throw Error('TEST boundary prohibits writes');
    h.reads.push({ path, headers: options.headers });
    // Capture request's response before holding it, like a late old-domain read.
    const result = path.startsWith('/api/registry') ? h.store.registry
      : path === '/api/ai-gateway' ? h.store.catalog
      : path.startsWith('/api/approvals?') ? { ok: true, resource: 'approvals', items: [], cursor: null }
      : (() => { throw Error('Unexpected TEST API path '+path); })();
    await h.store.hook(path, options);
    if (result instanceof Error) throw result;
    const status = path === '/api/ai-gateway' ? h.store.httpStatus || 200 : 200;
    return { status, ok: status < 400, text: async () => typeof result === 'string' ? result : JSON.stringify(result) };
  };
  return { ...h, roots, find };
}

export function adminCatalog(domainId = 'operations', status = 'ALLOWED') {
  const e = inventory(1)[0], llmGateway = { gatewayId: 'testGateway', name: 'test-gateway', region: 'us-east-1', gatewayUrl: 'https://test.invalid/inference/v1', modelCount: 1 };
  Object.assign(e.versions[0].content, { gateway: llmGateway.name, gatewayId: llmGateway.gatewayId, gatewayUrl: llmGateway.gatewayUrl,
    region: llmGateway.region, ownedBy: 'test-provider', object: 'model', pricing: null });
  const limits = { requestsPerMinute: 60, tokensPerMinute: null, connectionsPerSecond: null };
  const rateLimit = { id: 'test-rate-limit', status: 'ACTIVE', reason: null, reconciledAt: stamp };
  e.policy = status === 'DENIED' ? null : { modelId: e.id, allowedDomains: status === 'ALLOWED' ? [domainId] : [],
    requestableDomains: status === 'REQUESTABLE' ? [domainId] : [], limits, applicationStatus: 'ACTIVE', rateLimit,
    updatedBySubject: 'test-admin', updatedAt: stamp, revision: 1 };
  e.accessByDomain = { [domainId]: { status, usable: status === 'ALLOWED', requestable: status === 'REQUESTABLE',
    latestRequest: null, grant: null, limits: e.policy?.limits || null, rateLimit: e.policy?.rateLimit || null } };
  return { ok: true, source: 'aws', llmGateway, models: [e] };
}
