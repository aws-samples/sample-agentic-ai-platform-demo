import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPublicationSubmission } from './public/publication-submission.mjs';

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
  const root = { isConnected: true, querySelector: s => (s === '[data-publication-check]' ? button : box) };
  const calls = { contextGets: 0, posts: 0, postOptions: [] };
  const api = async (path, body, options) => {
    if (path.startsWith('/governance/publication-context')) {
      calls.contextGets++;
      const value = typeof context === 'function' ? context() : context;
      if (value instanceof Error) throw value;
      return value;
    }
    if (path === '/governance/publications') {
      calls.posts++; calls.postOptions.push(options);
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

test('found result is structured and surfaces the real existing request id', async () => {
  const h = harness({ approvals: goodApprovals([goodItem()]), context: goodContext() });
  await h.button.onclick();
  assert.equal(h.calls.contextGets, 0);
  assert.equal(h.calls.posts, 0);
  assert.match(h.box.textContent, /already exists/i);
  assert.ok(h.box.textContent.includes('ap-existing'), 'found message must carry the real request id');
});

for (const governed of [undefined, false, 0, 1, 'true', 'yes', null]) {
  test(`initial eligibility GET requires governed===true (got ${JSON.stringify(governed)})`, async () => {
    const h = harness({ approvals: goodApprovals([]), context: { ...goodContext(), governed } });
    await h.button.onclick();
    assert.equal(h.calls.posts, 0);
    assert.ok(!h.submitButton(), 'no submit affordance without verified governance');
    assert.ok(h.box.textContent.length > 0);
  });
}

for (const [field, value] of [['recordVersion', undefined], ['recordVersion', 7], ['ownerSubject', undefined], ['ownerSubject', ''], ['status', undefined], ['status', 9], ['domainId', 'other'], ['approvalId', undefined]]) {
  test(`initial eligibility GET fails closed on invalid ${field}=${JSON.stringify(value)}`, async () => {
    const h = harness({ approvals: goodApprovals([]), context: { ...goodContext(), [field]: value } });
    await h.button.onclick();
    assert.equal(h.calls.posts, 0);
    assert.ok(!h.submitButton());
  });
}

test('second eligibility GET rejects governed flipping away from true; no POST; stale submit handler is retired', async () => {
  let gets = 0;
  const h = harness({ approvals: goodApprovals([]), context: () => (++gets === 1 ? goodContext() : { ...goodContext(), governed: 'yes' }) });
  await h.button.onclick();
  const submit = h.submitButton();
  assert.ok(submit);
  const saved = submit.onclick;
  await saved();
  assert.equal(h.calls.posts, 0, 'ungoverned recheck must never POST');
  assert.equal(submit.disabled, true, 'stale submit stays disabled');
  assert.equal(submit.onclick, null, 'stale submit handler must be invalidated');
  await saved?.();
  assert.equal(h.calls.posts, 0, 'retained handler reference cannot write after retirement');
});

for (const [field, value] of [['recordVersion', 'v8'], ['ownerSubject', 'other@example.com'], ['domainId', 'other'], ['status', 'ARCHIVED']]) {
  test(`second eligibility GET mismatch on ${field} fails closed with no POST and a dead handler`, async () => {
    let gets = 0;
    const h = harness({ approvals: goodApprovals([]), context: () => (++gets === 1 ? goodContext() : { ...goodContext(), [field]: value }) });
    await h.button.onclick();
    const submit = h.submitButton();
    const saved = submit.onclick;
    await saved();
    assert.equal(h.calls.posts, 0);
    assert.equal(submit.disabled, true);
    assert.equal(submit.onclick, null);
    await saved?.();
    assert.equal(h.calls.posts, 0);
  });
}

test('recheck found at submit time: read-only outcome, submit retired, message carries the real id', async () => {
  let reads = 0;
  const h = harness({ approvals: () => (++reads === 1 ? goodApprovals([]) : goodApprovals([goodItem()])), context: goodContext() });
  await h.button.onclick();
  const submit = h.submitButton();
  await submit.onclick();
  assert.equal(h.calls.posts, 0);
  assert.equal(h.calls.contextGets, 1, 'no second context GET once a pending request is found');
  assert.match(h.box.textContent, /already exists/i);
  assert.ok(h.box.textContent.includes('ap-existing'));
  assert.equal(submit.onclick, null);
});

test('recheck unknown at submit time: reads only, zero writes, retry stays possible via reads', async () => {
  let reads = 0;
  const h = harness({ approvals: () => (++reads === 1 ? goodApprovals([]) : { ...goodApprovals([]), cursor: 'next' }), context: goodContext() });
  await h.button.onclick();
  const submit = h.submitButton();
  await submit.onclick();
  assert.equal(h.calls.posts, 0);
  assert.match(h.box.textContent, /verify|could not|refresh/i);
  await submit.onclick();
  assert.equal(h.calls.posts, 0, 'retry after unknown keeps reading, never writes blindly');
});
