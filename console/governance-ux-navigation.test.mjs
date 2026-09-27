// OFFLINE ONLY: targeted RED/GREEN coverage for the Governance UX complaint
// (blank page identity, tab switch with no current-page marker, generic
// scope note, three giant hosted "unavailable" inventory cards). Structural
// assertions read the actual shipped app.mjs source (not a re-implementation)
// plus vm-executed pure helpers extracted from that same source, matching the
// harness pattern used by governance-builder-recovery.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./public/modules/app.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('./public/styles/app.css', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker for: ${startMarker}`);
  return source.slice(start, end);
}
// vm.runInContext does not attach top-level `const`/`let` bindings to the
// context object (only `var`/function declarations do) — rewrite the leading
// declarator so the extracted real source is reachable as ctx.<name> in tests.
function sliceVar(startMarker, endMarker) {
  return slice(startMarker, endMarker).replace(/^const /, 'var ');
}

// ---------- 1. Tab identity: current sub-page must be visible + real ARIA ----------
test('vGovernance h1 includes the active sub-tab label, not a fixed "Governance"', () => {
  const block = slice('function vGovernance(){', '\nfunction govPoliciesTab(){');
  assert.match(block, /<h1>Governance <span[^>]*>\/ \$\{esc\(govTabLabel\(tab\)\)\}<\/span><\/h1>/);
});
test('govTabLabel resolves every visible tab id to its real GOV_TABS label, and only those', () => {
  const govTabsBlock = sliceVar('const GOV_TABS = [', '\n// Domain reviewers');
  const labelFn = sliceVar('const govTabLabel = id =>', '\nfunction vGovernance');
  const ctx = vm.createContext({});
  vm.runInContext(govTabsBlock + '\n' + labelFn, ctx);
  assert.equal(ctx.govTabLabel('queue'), 'Approval requests');
  assert.equal(ctx.govTabLabel('guardrails'), 'Guardrails');
  assert.equal(ctx.govTabLabel('nope'), '');
});
test('tab buttons carry role=tab, aria-selected reflecting the active tab, and roving tabindex', () => {
  const block = slice('const tabBtn=', '\n  return `<span class="roletag');
  assert.match(block, /role="tab"/);
  assert.match(block, /aria-selected="\$\{tab===id\}"/);
  assert.match(block, /tabindex="\$\{tab===id\?'0':'-1'\}"/);
  assert.match(block, /aria-controls="govtabpanel"/);
});
test('the tab bar is an ARIA tablist and the content region is a labelled tabpanel', () => {
  const block = slice('function vGovernance(){', '\nfunction govPoliciesTab(){');
  assert.match(block, /role="tablist" aria-label="Governance sections"/);
  assert.match(block, /<div id="govtabpanel" role="tabpanel" aria-labelledby="govtab-\$\{tab\}" tabindex="0">/);
  // and the panel we open is actually closed before the function ends.
  const opens = (block.match(/<div id="govtabpanel"/g) || []).length;
  assert.equal(opens, 1);
});
test('wireGovernance supports ArrowLeft/ArrowRight/Home/End roving focus, focusing only the fresh post-render tab node', () => {
  const block = slice('function wireGovernance(){', '\n// SIEM export');
  assert.match(block, /ArrowRight/);
  assert.match(block, /ArrowLeft/);
  assert.match(block, /await render\(\)/);
  assert.match(block, /document\.getElementById\(`govtab-\$\{id\}`\)\?\.focus\(\)/);
});

// ---------- 2. CSS root cause: .ghost declared after .primary silently wins ----------
test('the .primary/.ghost same-specificity conflict is documented and fixed with a higher-specificity selector', () => {
  const primaryIdx = css.indexOf('.primary{background:var(--accent)');
  const ghostIdx = css.indexOf('.ghost{background:var(--surface)');
  assert.ok(primaryIdx > -1 && ghostIdx > primaryIdx, '.ghost must be declared after .primary (the actual bug precondition)');
  const selectedIdx = css.indexOf('.govtab[aria-selected="true"]{');
  assert.ok(selectedIdx > ghostIdx, 'fix must use an attribute selector (higher specificity than .ghost/.primary)');
  assert.match(css.slice(selectedIdx, selectedIdx + 200), /background:var\(--accent\);color:#fff/);
});
test('rendered governance tab buttons no longer rely on a fragile combined ghost+primary class', () => {
  const block = slice('const tabBtn=', '\n  return `<span class="roletag');
  assert.doesNotMatch(block, /\$\{tab===id\?'primary':''\}/);
  assert.match(block, /class="ghost govtab"/);
});

// ---------- 3. Real scope, no fabricated project/domain ----------
function scopeNoteHarness(caps, domainScope, domain) {
  const block = sliceVar('const scopeNote = () => hasDomainScope()', '\nconst defaultObsScope');
  const ctx = vm.createContext({
    hasDomainScope: () => domainScope, hasCap: c => caps.includes(c),
    activeDomain: () => domain, domainLabel: id => id, esc: s => s,
  });
  vm.runInContext(block, ctx);
  return ctx.scopeNote();
}
test('platform admin with no active domain scope sees an explicit "all domains" note, never blank', () => {
  const html = scopeNoteHarness(['viewAllDomains'], false, null);
  assert.match(html, /all domains/);
  assert.notEqual(html, '');
});
test('a plain user with no scope and no platform capability gets nothing fabricated', () => {
  const html = scopeNoteHarness([], false, null);
  assert.equal(html, '');
});
test('a domain-scoped session still shows its real domain, unchanged behavior', () => {
  const html = scopeNoteHarness(['viewAllDomains'], true, 'finance');
  assert.match(html, /finance/);
  assert.doesNotMatch(html, /all domains/);
});

// ---------- 4. Hosted queue: no more three giant unavailable inventory cards ----------
test('hosted (cognito) queue tab renders a compact Registry/Fleet link, not three big placeholder cards', () => {
  const block = slice("tab==='queue'?`", "\n  :tab==='policies'");
  const hostedBranch = block.slice(block.indexOf("authMode()==='cognito'?`"));
  assert.match(hostedBranch, /Open AI Registry/);
  assert.match(hostedBranch, /Open Agent Fleet/);
  assert.doesNotMatch(hostedBranch.slice(0, hostedBranch.indexOf(':`')), /id="govagents"/);
  assert.doesNotMatch(hostedBranch.slice(0, hostedBranch.indexOf(':`')), /id="govmcp"/);
  assert.doesNotMatch(hostedBranch.slice(0, hostedBranch.indexOf(':`')), /id="gova2a"/);
});
test('local (non-hosted) queue tab keeps the real Deployed agents / MCP / A2A cards', () => {
  const block = slice("tab==='queue'?`", "\n  :tab==='policies'");
  const localBranch = block.slice(block.indexOf(':`'));
  assert.match(localBranch, /id="govagents"/);
  assert.match(localBranch, /id="govmcp"/);
  assert.match(localBranch, /id="gova2a"/);
});
test('loadGovernance only fetches the local resource inventory (loadGovResources) outside hosted mode', () => {
  const block = slice('async function loadGovernance(){', '\n  else if(');
  assert.match(block, /if\(authMode\(\)!=='cognito'\)runSessionTask\(loadGovResources\)/);
});

// ---------- 5. wireGovernance keyboard nav against a real (behavioral) fake
// DOM: exercises the actual async control flow, not just source regex. This
// is a minimal hand-built DOM stub (matching the object-stub style already
// used by governance-builder-recovery.test.mjs), not a full browser/jsdom —
// no such dependency exists in this repo. It reproduces the exact bug the
// reviewer flagged: goTab() is async because render() -> renderSession()
// awaits ensure() before touching the DOM, so a synchronous
// `tabs[next].focus()` right after calling goTab() would focus a node that
// is about to be detached when the DOM is later replaced. The fix must only
// focus after render() resolves, and must re-query the DOM by id.
function fakeGovDom({ cancel = false } = {}) {
  const calls = { focused: [], rendered: 0, clearedDrafts: 0 };
  let renderGate; // resolves the in-flight render() to simulate the async gap
  const tabButtons = ['queue', 'requests', 'exemptions'].map(id => ({
    dataset: { tab: id }, onclick: null, onkeydown: null,
    getAttribute(name) { return name === 'aria-selected' ? String(id === 'queue') : null; },
    focus() { calls.focused.push({ where: 'selected-button', id }); },
  }));
  const byId = new Map();
  const registerActiveTab = id => {
    const el = { id: `govtab-${id}`, focus() { calls.focused.push({ where: 'live-node', id }); } };
    byId.set(`govtab-${id}`, el);
    return el;
  };
  ['queue', 'requests', 'exemptions'].forEach(registerActiveTab);
  const storyLinks = [{ tabIndex: undefined, role: undefined, onkeydown: null, clicked: 0, click() { this.clicked++; }, setAttribute(k, v) { this[k === 'role' ? 'role' : k] = v; } }];
  const ctx = vm.createContext({
    document: {
      querySelectorAll: sel => sel === '.govtab' ? tabButtons
        : sel === '#govtabpanel > .story > a.storynext[data-goview]' ? storyLinks : [],
      getElementById: id => byId.get(id) || null,
    },
    confirmContextChange: () => !cancel,
    clearBusinessDrafts: () => { calls.clearedDrafts++; },
    S: { govTab: 'queue' },
    render: () => new Promise(resolve => { renderGate = resolve; calls.rendered++; }),
  });
  vm.runInContext(slice('function wireGovernance(){', '\n// SIEM export'), ctx);
  ctx.wireGovernance();
  return { tabButtons, storyLinks, calls, resolveRender: () => renderGate?.() };
}
test('ArrowRight focuses the freshly re-queried live tab node only after render() resolves, never the stale pre-render button', async () => {
  const { tabButtons, calls, resolveRender } = fakeGovDom();
  tabButtons[0].onkeydown({ key: 'ArrowRight', preventDefault() {} }); // queue -> requests
  assert.equal(calls.rendered, 1, 'render must be invoked');
  assert.deepEqual(calls.focused, [], 'must not focus anything before render() resolves');
  resolveRender();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.focused, [{ where: 'live-node', id: 'requests' }]);
});
 test('cancelling context change preserves render/drafts and restores the selected tab focus', async () => {
  const { tabButtons, calls } = fakeGovDom({ cancel: true });
  const before = calls.rendered;
  tabButtons[0].onkeydown({ key: 'ArrowRight', preventDefault() {} });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.rendered, before, 'render() must never be called when the user cancels');
  assert.equal(calls.clearedDrafts, 0);
  assert.deepEqual(calls.focused, [{ where: 'selected-button', id: 'queue' }]);
});
 test('click on a tab restores focus to its fresh post-render node', async () => {
  const { tabButtons, calls, resolveRender } = fakeGovDom();
  const pending=tabButtons[1].onclick();
  assert.deepEqual(calls.focused, [], 'no pre-render focus');
  resolveRender();await pending;
  assert.deepEqual(calls.focused, [{ where: 'live-node', id: 'requests' }]);
});
 test('the compact hosted Registry/Fleet story links become keyboard-reachable and Enter/Space trigger the existing click wiring', () => {
  const { storyLinks } = fakeGovDom();
  const [a] = storyLinks;
  assert.equal(a.tabIndex, 0);
  assert.equal(a.role, 'link');
  a.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.equal(a.clicked, 1);
  a.onkeydown({ key: ' ', preventDefault() {} });
  assert.equal(a.clicked, 2);
  a.onkeydown({ key: 'Tab', preventDefault() {} });
  assert.equal(a.clicked, 2, 'non-activation keys must not trigger a click');
});
