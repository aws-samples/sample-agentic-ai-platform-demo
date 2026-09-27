import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPublicationSubmission } from './public/publication-submission.mjs';

// Minimal DOM stand-ins for the submit flow.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      textContent: '', className: '', disabled: false, isConnected: true,
      attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
    }),
  };
}

const goodItem = () => ({
  kind: 'RESOURCE_PUBLICATION', domainId: 'operations', resourceId: 'res-1',
  resourceType: 'MCP_SERVER', status: 'PENDING', id: 'ap-existing', requesterSubject: 'synthetic-owner',
});
const goodApprovals = (items = []) => ({ ok: true, resource: 'approvals', items, cursor: null, complete: true, partial: false });
const goodContext = () => ({
  ok: true, governed: true, canSubmit: true, registryId: 'R1', recordId: 'C1', domainId: 'operations',
  recordVersion: 'v7', approvalId: 'ap-1', ownerSubject: 'owner@example.com', reviewerRole: 'governance-lead', status: 'ACTIVE',
});

function harness({ approvals, context, post } = {}) {
  const children = [];
  const button = { disabled: false, hidden: false, isConnected: true };
  const box = {
    textContent: '',
    replaceChildren(...kids) { children.length = 0; children.push(...kids); },
    append(...kids) { children.push(...kids); },
  };
  const root = {
    isConnected: true,
    querySelector: s => (s === '[data-publication-check]' ? button : box),
  };
  const calls = { contextGets: 0, posts: 0, postOptions: [] };
  const api = async (path, body, options) => {
    if (path.startsWith('/governance/publication-context')) {
      calls.contextGets++;
      const value = typeof context === 'function' ? context() : context;
      if (value instanceof Error) throw value;
      return value;
    }
    if (path === '/governance/publications') {
      calls.posts++;
      calls.postOptions.push(options);
      const value = typeof post === 'function' ? post() : post;
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`unexpected api path ${path}`);
  };
  const readApprovals = async () => {
    const value = typeof approvals === 'function' ? approvals() : approvals;
    if (value instanceof Error) throw value;
    return value;
  };
  mountPublicationSubmission(root, {
    row: { identity: 'res-1', entry: { domain: 'operations', type: 'MCPServer' }, version: { _aws: { registryId: 'R1', recordId: 'C1' } } },
    api, readApprovals, current: () => true, identity: () => 'user-1', requestId: () => 'ignored',
    reload: async () => { calls.reloaded = true; },
  });
  const submitButton = () => children.find(c => c.textContent === 'Submit for review');
  return { button, box, calls, children, submitButton };
}

const unknownCases = {
  'pagination incomplete (non-null cursor)': { ...goodApprovals([goodItem()]), cursor: 'next-page' },
  'pagination incomplete (complete=false)': { ...goodApprovals([goodItem()]), complete: false },
  'partial read': { ...goodApprovals([]), partial: true },
  'invalid payload (wrong resource)': { ...goodApprovals([]), resource: 'other' },
  'invalid payload (items not array)': { ...goodApprovals([]), items: 'nope' },
  'read rejection': new Error('read denied'),
  'conflicting matching rows': goodApprovals([goodItem(), { ...goodItem(), approvalId: 'ap-other' }]),
  'invalid matching row (missing status)': goodApprovals([{ ...goodItem(), status: undefined }]),
};

for (const [name, approvals] of Object.entries(unknownCases)) {
  test(`matching unknown — ${name}: no context GET, no POST, recoverable message`, async () => {
    const h = harness({ approvals, context: goodContext() });
    await h.button.onclick();
    assert.equal(h.calls.contextGets, 0, 'must not send context GET when matching is unknown');
    assert.equal(h.calls.posts, 0, 'must not POST when matching is unknown');
    assert.ok(h.box.textContent.length > 0);
    assert.doesNotMatch(h.box.textContent, /already exists/i, 'unknown must not be reported as a found request');
    assert.match(h.box.textContent, /(verif|could not|check).*?(refresh|try again)/is);
  });
}

test('matching found: existing PENDING request preserved, no context GET', async () => {
  const h = harness({ approvals: goodApprovals([goodItem()]), context: goodContext() });
  await h.button.onclick();
  assert.equal(h.calls.contextGets, 0);
  assert.match(h.box.textContent, /already exists/i);
});

test('matching absent: proceeds to context GET and shows owner details', async () => {
  const h = harness({ approvals: goodApprovals([]), context: goodContext() });
  await h.button.onclick();
  assert.equal(h.calls.contextGets, 1);
  assert.ok(h.children.some(c => /Owner: owner@example\.com/.test(c.textContent)));
});

const contextFailures = [
  [{ ok: false, status: 403 }, /permission/i],
  [{ ok: false, status: 404 }, /not found/i],
  [{ ok: false, status: 503 }, /unavailable/i],
  [Object.assign(new Error('fetch failed'), { network: true }), /network/i],
];
test('context failures get distinct short messages, not all blamed on the owner', async () => {
  const seen = [];
  for (const [context, pattern] of contextFailures) {
    const h = harness({ approvals: goodApprovals([]), context });
    await h.button.onclick();
    assert.match(h.box.textContent, pattern);
    assert.doesNotMatch(h.box.textContent, /contact the resource owner/i, 'must not route every context failure to the owner');
    seen.push(h.box.textContent);
  }
  assert.equal(new Set(seen).size, contextFailures.length, '403/404/503/network wording must differ');
});

test('submission timeout: outcome reported unknown with stable requestId, never a definite "not submitted"', async () => {
  const h = harness({ approvals: goodApprovals([]), context: goodContext, post: () => Object.assign(new Error('timeout'), { timeout: true }) });
  await h.button.onclick();
  const submit = h.submitButton();
  assert.ok(submit, 'submit button rendered');
  await submit.onclick();
  assert.equal(h.calls.posts, 1);
  const status = h.children[h.children.length - 1];
  assert.match(status.textContent, /(unknown|may have)/i, 'timeout outcome must be reported as unknown');
  assert.doesNotMatch(status.textContent, /was not completed|not sent|could not be completed/i);
  await submit.onclick();
  assert.equal(h.calls.posts, 2);
  assert.equal(h.calls.postOptions[0].requestId, 'submit-ap-1');
  assert.equal(h.calls.postOptions[1].requestId, h.calls.postOptions[0].requestId, 'requestId must stay stable across retries');
});

test('definitive permission rejection is identified without guessing generic failure outcome', async () => {
  const h = harness({ approvals: goodApprovals([]), context: goodContext, post: { ok: false, code: 'FORBIDDEN' } });
  await h.button.onclick();
  const submit = h.submitButton();
  await submit.onclick();
  const status = h.children[h.children.length - 1];
  assert.match(status.textContent, /permission/i);
});

for (const bad of [null, {...goodItem(),status:'BROKEN'}, {...goodItem(),id:undefined}]) {
 test('invalid approval row must not establish absence',async()=>{
  const h=harness({approvals:goodApprovals([bad]),context:goodContext()});
  await h.button.onclick();assert.equal(h.calls.contextGets,0);assert.equal(h.calls.posts,0);
 });
}
for (const extra of [{errors:['read failed']},{code:'PAGINATION_INVALID'},{nextToken:'next'},{completeness:'partial'}]) {
 test('all completeness indicators block eligibility',async()=>{
  const h=harness({approvals:{...goodApprovals(),...extra},context:goodContext()});
  await h.button.onclick();assert.equal(h.calls.contextGets,0);
 });
}
test('actual code-only API rejection retains permission classification',async()=>{
 const h=harness({approvals:goodApprovals(),context:{ok:false,code:'FORBIDDEN'}});
 await h.button.onclick();assert.match(h.box.textContent,/permission/i);
});
for (const result of [{ok:false},{ok:false,status:503},{ok:false,code:'CONTROL_PLANE_UNAVAILABLE'}]) {
 test('returned write failure is not proof of no mutation',async()=>{
  const h=harness({approvals:goodApprovals(),context:goodContext,post:result});
  await h.button.onclick();await h.submitButton().onclick();
  assert.match(h.children.at(-1).textContent,/unknown|not.*confirmed/i);
  assert.doesNotMatch(h.children.at(-1).textContent,/was not completed|retrying is safe/i);
 });
}
