import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { adaptCosts, adaptProjects, adaptFleet } from "./public/main-ui-compat.mjs";
import { mountProjectBudget } from "./public/modules/project-budget.mjs";

const window = { startTime: "2026-09-10T00:00:00.000Z", endTime: "2026-09-11T00:00:00.000Z" };
const row = (overrides = {}) => ({
  scopeType: "project", domainId: "domain_a", projectId: "sample",
  contractVersion: 1, currency: "USD", basis: "estimate",
  source: "experience-invocation-journal", environment: "PRODUCTION",
  consistency: "eventual", windowBasis: "usage-occurrence-and-execution-start",
  runBoundary: "runtime-durable-start", dispatchBoundary: "accepted-runtime-dispatch",
  runCountUnavailableReason: null, runCount: 2, knownRunCount: 2,
  acceptedDispatchCount: 3, invocationCount: null, inputTokens: 12, outputTokens: 4,
  estimatedCostUsd: 0.000003, knownEstimatedCostUsd: 0.000003,
  completeness: "partial", modelCoverage: "complete", monthlyBudgetUsd: 100,
  coverage: { included: ["retained-provider-usage-including-failures"], excluded: ["runtime", "shared"] },
  pricingVersion: "synthetic-price", pricingRevision: "a".repeat(64), pricingRevisions: ["b".repeat(64)],
  priceSources: [{ id: "synthetic-price", url: "https://example.invalid/rates", retrievedAt: window.startTime, effectiveFrom: window.startTime, effectiveTo: window.endTime }],
  updatedAt: window.endTime, ...overrides,
});
const page = (items = [row()], overrides = {}) => ({ ok: true, resource: "costs", scope: { type: "projects", projectIds: items.map(r => `${r.domainId}/${r.projectId}`) }, window, items, cursor: null, ...overrides });
const source = readFileSync(new URL("./public/modules/app.mjs", import.meta.url), "utf8");
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
async function ui(responses, state = {}) {
  const helper = await import("./public/cost-view.mjs");
  function element() {
    let html = "";
    const children = new Map();
    return { isConnected: true,
      get innerHTML() { return html + [...children.values()].map(child => child.innerHTML).join(""); },
      set innerHTML(value) { html = value; children.clear(); },
      querySelectorAll: () => [],
      querySelector(selector) {
        if (selector === "[data-budget-form]" && !html.includes("data-budget-form")) return null;
        if (!children.has(selector)) children.set(selector, element());
        return children.get(selector);
      },
    };
  }
  const elements = new Map(["hostedcost", "wsbody", "dcbody", "domaincost", "costbox", "costtotals", "costcomponents", "costdomains", "costmodelbox", "costpricing"].map(id => [id, element()]));
  const calls = [];
  const request = async (path, body, options) => {
    calls.push({ path, options });
    if (path.startsWith("/operations/project-budgets?")) {
      const scope = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
      return { ok: true, resource: "project-budget", scope,
        project: { ...scope, name: "Synthetic project", ownerSubject: "synthetic-owner", status: "ACTIVE" },
        access: { canEdit: false, role: "builder" }, budget: null, evaluation: null };
    }
    if (path === "/agents") return { ok: true, items: [{ id: "agent-one", projectId: "sample", domainId: "domain_a", status: "DRAFT" }] };
    if (path === "/projects") return { ok: true, items: [{ id: "sample", domainId: "domain_a", name: "Synthetic project", status: "ACTIVE" }] };
    if (path === "/deployments" || path === "/approvals") return { ok: true, items: [] };
    const response = responses.shift(); if (response instanceof Error) throw response; return response;
  };
  const context = vm.createContext({
    ...helper, adaptCosts, adaptProjects, adaptFleet, mountProjectBudget, S: { domains: [], ...state }, URLSearchParams, encodeURIComponent,
    sessionEpoch: 0, sessionEpochIsCurrent: epoch => epoch === 0, createRequestId: () => "synthetic-request",
    sessionTaskHandler: fn => fn,
    authMode: () => "cognito", activeDomain: () => "domain_a",
    document: { getElementById: id => elements.get(id) || null },
    rawApi: request, readHostedCollection: resource => request("/" + resource),
    CANCELED_REQUEST: Symbol("cancel"), runSessionTask: fn => fn(),
    scopeNote: () => "", hostedWindowControl: () => "", loadDomainPromotions: () => {},
    pluralize: (n, noun) => `${n} ${noun}`, SHIELD_IC: "", BELL_IC: "",
    usd: v => String(v), esc: v => String(v),
    // Admin-only platform additions: these suites exercise the non-admin
    // ("builder") paths, so the billing/rollup panels are inert stubs here.
    SHELL: () => "builder",
    loadPlatformBilling: () => {}, wirePlatformCostCsv: () => {},
    platformCostRollup: () => { throw new Error("not under test") },
    platformCostRollupHtml: () => "",
  });
  for (const name of ["mainCompatApi", "hostedRetryState", "workspaceSelectionStorage", "loadScopedHostedCost", "wireHostedCostBudgets", "loadHostedProjectBudget", "vHostedCost", "loadHostedCost", "vCost", "loadCost", "loadWorkspaceTab", "loadHostedPromotionRecords", "loadHostedDomainDashboard", "loadDomainConsole", "provisioningCardHtml"]) {
    vm.runInContext(functionSource(name), context);
  }
  vm.runInContext("const api=(...args)=>mainCompatApi(...args)", context);
  return { context, elements, calls };
}

test("actual adapter preserves metadata and never converts unknowns or USD budgets to tokens", () => {
  const input = page([row({ estimatedCostUsd: null, modelCoverage: "partial", runCount: null, runCountUnavailableReason: "actual-execution-start-unavailable", inputTokens: null })]);
  const result = adaptCosts(input);
  assert.equal(result.totalCostUsd, null);
  assert.equal(result.runCount, null);
  assert.equal(result.totalTokens, null);
  assert.equal(result.sharedAllocatedUsd, null);
  assert.equal(result.domains[0].tokenBudget, null);
  assert.equal(result.domains[0].monthlyBudgetUsd, 100);
  assert.deepEqual(result.items, input.items);
  assert.deepEqual(result.scope, input.scope);
  assert.deepEqual(result.window, input.window);
  assert.deepEqual(result.perAgent[0].priceSources, input.items[0].priceSources);
});

test("actual adapter trusts only native starts and complete pages, never supplied ratios", () => {
  for (const overrides of [{ runBoundary: "accepted-runtime-dispatch" }, { windowBasis: "dispatch-start-cohort" }, { source: "cloudwatch-runtime-metrics" }, { runCountUnavailableReason: "actual-execution-start-unavailable" }, { runCount: 1.5 }, { runCount: null }]) {
    const result = adaptCosts(page([row({ ...overrides, costPerRunUsd: 999 })]));
    assert.equal(result.runCount, null);
    assert.equal(result.costPerRunUsd, null);
  }
  const result = adaptCosts(page([row(), row({ domainId: "domain_b", runCount: 1, estimatedCostUsd: 0.000006 })]));
  assert.equal(result.runCount, 3);
  assert.ok(Math.abs(result.costPerRunUsd - 0.000003) < 1e-18);
  assert.equal(result.perAgent.length, 2);
  assert.equal(adaptCosts(page([row()], { cursor: "next" })).totalCostUsd, null);
  assert.equal(adaptCosts(page([row({ runCount: 0, estimatedCostUsd: 0 })])).costPerRunUsd, null);
  assert.equal(adaptCosts(page([row({ runCount: 0, estimatedCostUsd: 0 })])).totalCostUsd, 0);
});

test("actual adapter rejects duplicate and mixed aggregate scopes", () => {
  for (const items of [[row(), row()], [row(), row({ scopeType: "platform", domainId: null, projectId: null })]]) {
    const result = adaptCosts(page(items));
    assert.equal(result.ok, false);
    assert.equal(result.totalCostUsd, undefined);
  }
});

test("actual API adapter consumes all pages and passes original options and cursor", async () => {
  const first = page([row()], { cursor: "next", scope: { type: "projects" } });
  const second = page([row({ domainId: "domain_b" })], { scope: first.scope });
  const { context, calls } = await ui([first, second]);
  const result = await context.mainCompatApi("/costs?window=7d&limit=50", undefined, { marker: "same-options" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, "/costs?window=7d&limit=50&cursor=next");
  assert.equal(calls[1].options.marker, "same-options");
  assert.equal(result.totalCostUsd, 0.000006);
  assert.equal(result.items.length, 2);
});

test("actual API and views fail closed on pagination errors without showing partial totals", async () => {
  const first = page([], { cursor: "next", scope: { type: "projects" } });
  for (const next of [page([], { cursor: "next", scope: first.scope }), page([row()], { window: { ...window, endTime: "changed" }, scope: first.scope }), { ok: false, code: "OPERATIONS_UNAVAILABLE" }, new Error("offline failure")]) {
    const { context, elements } = await ui([first, next]);
    await context.loadCost();
    assert.match(elements.get("hostedcost").innerHTML, /Cost is temporarily unavailable/);
    assert.doesNotMatch(elements.get("hostedcost").innerHTML, /\$0/);
  }
});

test("actual Admin cost entry renders micro USD, provenance, scope, window and partial coverage", async () => {
  const input = page([row({ scopeType: "platform", domainId: null, projectId: null })], { scope: { type: "platform" } });
  const { context, elements } = await ui([input]);
  const shell = context.vCost();
  assert.match(shell, /hostedcost/);
  assert.doesNotMatch(shell, /4%|optimization|projected monthly/);
  await context.loadCost();
  const html = elements.get("hostedcost").innerHTML;
  for (const text of ["$0.000003", "$0.000002", "synthetic-price", "example.invalid/rates", window.startTime, window.endTime, "platform", "partial", "runtime-durable-start", "PRODUCTION", "user", "Known subtotal", "Monthly budget USD"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /4%|this month|Monthly spend/);
});

test("actual Project cost tab selects domain plus project, not agent IDs or slug alone", async () => {
  const { context, elements, calls } = await ui([page([row(), row({ domainId: "domain_b", estimatedCostUsd: 987 })])], { wsTab: "cost" });
  await context.loadWorkspaceTab({ id: "sample", domain: "domain_a", agents: ["unrelated-agent"] });
  const html = elements.get("wsbody").innerHTML;
  assert.match(html, /domain_a \/ sample/);
  assert.match(html, /\$0\.000003/);
  assert.doesNotMatch(html, /domain_b|987\.000000/);
  assert.match(html, /Monthly budget/);
  assert.match(html, /synthetic-owner/);
  assert.match(html, /agent-one/);
  assert.ok(calls.some(call => call.path.includes("groupBy=project")));
  assert.ok(calls.some(call => call.path === "/operations/project-budgets?domainId=domain_a&projectId=sample"));
});

test("actual Project cost tab refuses platform aggregates and unavailable APIs", async () => {
  for (const response of [page([row({ scopeType: "platform", domainId: null, projectId: null })], { scope: { type: "platform" } }), { ok: false, code: "OPERATIONS_UNAVAILABLE" }]) {
    const { context, elements } = await ui([response], { wsTab: "cost" });
    await context.loadWorkspaceTab({ id: "sample", domain: "domain_a" });
    assert.match(elements.get("wsbody").innerHTML, /unavailable/i);
    assert.doesNotMatch(elements.get("wsbody").innerHTML, /\$0/);
  }
});

test("actual Domain dashboard loads scoped inventory, approvals and domain cost without local-only routes", async () => {
  const { context, elements, calls } = await ui([page([row({ scopeType: "domain", projectId: null })], { scope: { type: "domain", domainId: "domain_a" } })], { dcTab: "dashboard" });
  await context.loadDomainConsole();
  assert.match(elements.get("dcbody").innerHTML, /Agent records/);
  assert.match(elements.get("dcbody").innerHTML, /Production approvals/);
  assert.match(elements.get("dcbody").querySelector("#domaincost").innerHTML, /domain_a/);
  assert.match(elements.get("dcbody").querySelector("#domaincost").innerHTML, /\$0\.000003/);
  assert.ok(!calls.some(({path}) => /^\/(?:domain-health|hitl-promotions)/.test(path)));
});

test("actual view escapes all metadata; missing pricing leaves unknown total and visible subtotal", async () => {
  const attack = '<img src=x onerror="bad()">';
  const { context, elements } = await ui([page([row({ estimatedCostUsd: null, modelCoverage: "partial", pricingVersion: attack, priceSources: [{ url: attack, id: attack }], coverage: { included: [attack], excluded: [attack] }, updatedAt: attack })])]);
  await context.loadCost();
  const html = elements.get("hostedcost").innerHTML;
  assert.match(html, /Estimate: <b>N\/A/);
  assert.match(html, /Known subtotal: \$0\.000003/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|href=/);
  assert.match(html, /Cost per run: <b>N\/A/);
});

test("native failed/unresolved starts count, mixed legacy and dispatch rows never enable the KPI", async () => {
  for (const overrides of [
    { runCount: 3, knownRunCount: 3, succeededRunCount: 1, failedRunCount: 1, unresolvedRunCount: 1, estimatedCostUsd: null, modelCoverage: "partial" },
    { runCount: null, knownRunCount: 1, legacyRecordCount: 1, runCountUnavailableReason: "actual-execution-start-unavailable", estimatedCostUsd: null, modelCoverage: "partial" },
    { runCount: 20, costPerRunUsd: 88, runBoundary: undefined, windowBasis: "dispatch-start-cohort", acceptedDispatchCount: 20 },
  ]) {
    const input = page([row(overrides)]);
    const result = adaptCosts(input);
    assert.equal(result.costPerRunUsd, null);
    assert.equal(result.runCount, overrides.runCount === 3 ? 3 : null);
    const { context, elements } = await ui([input]);
    await context.loadCost();
    assert.match(elements.get("hostedcost").innerHTML, /Cost per run: <b>N\/A/);
    assert.match(elements.get("hostedcost").innerHTML, /Accepted dispatches \(diagnostic\)/);
  }
});

test("zero native starts with positive usage cost is not zero cost or a ratio", () => {
  const result = adaptCosts(page([row({ runCount: 0, knownRunCount: 0 })]));
  assert.equal(result.runCount, 0);
  assert.equal(result.totalCostUsd, 0.000003);
  assert.equal(result.costPerRunUsd, null);
  assert.equal(adaptCosts(page([])).totalCostUsd, null);
  assert.equal(adaptCosts(page([row({ currency: "TOKENS" })])).totalCostUsd, null);
  assert.equal(adaptCosts(page([row({ currency: "TOKENS" })])).domains[0].monthlyBudgetUsd, null);
  assert.equal(adaptCosts(page([row({ estimatedCostUsd: Number.MAX_VALUE }), row({ projectId: "second", estimatedCostUsd: Number.MAX_VALUE })])).totalCostUsd, null);
});

test("actual paginated adapter rejects duplicate items, mixed levels, changed scopes and malformed cursors", async () => {
  const first = page([row()], { cursor: "next", scope: { type: "projects" } });
  for (const second of [page([row()], { scope: first.scope }), page([row({ scopeType: "domain", projectId: null })], { scope: first.scope }), page([], { scope: { type: "domain", domainId: "domain_a" } }), page([], { cursor: "bad/cursor", scope: first.scope })]) {
    const { context } = await ui([first, second]);
    assert.equal((await context.mainCompatApi("/costs", undefined, {})).ok, false);
  }
});

test("actual cost loader renders no numeric subtotal while the second page is pending", async () => {
  let resolveNext;
  const waiting = new Promise(resolve => { resolveNext = resolve; });
  const first = page([row()], { cursor: "next", scope: { type: "projects" } });
  const { context, elements } = await ui([first, waiting]);
  const loading = context.loadCost();
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotMatch(elements.get("hostedcost").innerHTML, /Estimate|\$/);
  resolveNext(page([row({ projectId: "second" })], { scope: first.scope }));
  await loading;
  assert.match(elements.get("hostedcost").innerHTML, /\$0\.000006/);
});

test("actual cost loader retains retry control on unavailable first response and retry succeeds", async () => {
  const { context, elements } = await ui([{ ok: false, code: "OPERATIONS_UNAVAILABLE" }, page()]);
  const button = {};
  elements.get("hostedcost").querySelector = () => button;
  await context.loadCost();
  assert.match(elements.get("hostedcost").innerHTML, /Cost is temporarily unavailable/);
  assert.equal(typeof button.onclick, "function");
  button.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get("hostedcost").innerHTML, /\$0\.000003/);
});

test("sub-micro USD stays nonzero and metadata cannot inject HTML through the actual adapter/view", async () => {
  const input = page([row({ estimatedCostUsd: 0.0000001, knownEstimatedCostUsd: 0.0000001, projectId: '<script>bad()</script>', source: '<img src=x>', windowBasis: '<svg onload="bad()">' })]);
  const { context, elements } = await ui([input]);
  await context.loadCost();
  const html = elements.get("hostedcost").innerHTML;
  assert.match(html, /\$1\.00e-7/);
  assert.doesNotMatch(html, /<script|<svg|<img/);
  assert.match(html, /Started agent runs: <b>N\/A/);
});

test("actual project provisioning distinguishes unknown token usage from zero and USD", async () => {
  const { context } = await ui([]);
  const project = { tokenBudget: 100 };
  const unknown = context.provisioningCardHtml(project, [{ inputTokens: null, outputTokens: 4, monthlyBudgetUsd: 500 }]);
  assert.match(unknown, /Token usage unavailable/);
  assert.doesNotMatch(unknown, /width:0%|0 tokens used/);
  assert.match(context.provisioningCardHtml(project, [{ inputTokens: 0, outputTokens: 0 }]), /0 tokens used \(0%\)/);
  const known = context.provisioningCardHtml(project, [{ inputTokens: 12, outputTokens: 4, monthlyBudgetUsd: 500 }]);
  assert.match(known, /16 tokens used \(16%\)/);
  assert.doesNotMatch(known, /500/);
});

test("real hosted wizard create opens budget editor without saving a budget or claiming read success", async () => {
  const fields = new Map(["wcreate", "wback", "wizstatus", "hostedbudgetdetail"].map(id => [id, { innerHTML: "" }]));
  const root = { isConnected: true, innerHTML: "", querySelector: () => ({}) };
  const requests = [], opened = [];
  const context = vm.createContext({
    S: { view: "domainconsole", wiz: { hosted: true, step: 6, domainId: "support", data: { id: "case-assist", projectName: "Case Assist", description: "Manual", reviewBudget: true } } },
    SHELL: () => "builder", activeDomain: () => "support", sessionEpoch: 0, sessionEpochIsCurrent: n => n === 0,
    hostedProjectCreateAllowed: () => true, validateHostedProjectWizard: () => "",
    businessForms: {clear(){}}, wizardDirty:{clear(){}},
    document: { getElementById: id => fields.get(id) }, createRequestId: () => "project-create-1", esc: v => String(v),
    apiErrorMessage: (r, text) => text,
    api: async (path, body, options) => {
      requests.push({ path, body, options });
      return { ok: true, resource: "project", project: { domainId: "support", id: "case-assist", status: "ACTIVE" } };
    },
    loadHostedCollection: async () => {},
    loadHostedProjectBudget: async (box, scope) => {
      opened.push(scope);
      const { createProjectBudgetController, projectBudgetHtml } = await import("./public/modules/project-budget.mjs");
      const controller = createProjectBudgetController({ scope, request: async () => ({ ok: false, code: "OPERATIONS_UNAVAILABLE" }) });
      await controller.load();
      box.innerHTML = projectBudgetHtml(controller.state);
    },
  });
  vm.runInContext(functionSource("createHostedWizardProject"), context);
  await context.createHostedWizardProject(root);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/projects");
  assert.equal(requests[0].body.monthlyLimitUsd, undefined);
  assert.equal(opened[0].domainId, "support");
  assert.equal(opened[0].projectId, "case-assist");
  assert.match(root.innerHTML, /Budget setup is pending/);
  assert.match(fields.get("hostedbudgetdetail").innerHTML, /unavailable/i);
  assert.match(fields.get("hostedbudgetdetail").innerHTML, /data-budget-refresh/);
});

test("empty workspace keeps function; Lead Projects opens the list, with creation only by explicit action", async () => {
  for (const entry of ["loadWorkspace", "loadDomainConsole"]) {
    const button = {};
    const box = { innerHTML: "", querySelectorAll: () => [], querySelector: selector => selector === '[data-project-setup]' ? button : null };
    const opened = [];
    const context = vm.createContext({
      S: { dcTab: "projects", wsTab: "cost" }, sessionEpoch: 0, sessionEpochIsCurrent: epoch => epoch === 0,
      document: { getElementById: id => id === "domain-foundation-summary" ? null : box }, authMode: () => "cognito", esc: v => String(v),
      activeDomain: () => "support", domainLabel: value => value, ensureWorkspaceProjects: async () => [], sessionTaskHandler: fn => fn,
      loadHostedProjectSetup: async root => { opened.push(root); },
      SESSION: {}, rememberWorkspaceSelection: () => {}, SHELL: () => "lead",
    });
    for (const name of ["workspaceSelectionStorage", "groupProjectsByDomain", "workspaceFunction", "workspaceScopeText", "workspaceProjectState", entry]) vm.runInContext(functionSource(name), context);
    await context[entry]();
    assert.deepEqual(opened, entry === "loadWorkspace" ? [] : [box], entry);
    if (entry === "loadWorkspace") {
      assert.match(box.innerHTML, /<h1>Cost & Budget/);
      assert.match(box.innerHTML, /data-project-setup/);
      assert.equal(context.S.wsTab, "cost");
    }
  }
});

test("accepted main project detail resolves authoritative domain+project before loading budget panel", async () => {
  const box = { innerHTML: "" };
  const opened = [];
  const context = vm.createContext({
    S: { projectDetail: "case-assist", projectDetailDomain: "support" },
    document: { getElementById: () => box }, authMode: () => "cognito",
    activeDomain: () => "finance",
    readHostedCollection: async () => ({ ok: true, items: [
      { id: "case-assist", domainId: "finance" }, { id: "case-assist", domainId: "support" },
    ] }),
    loadHostedProjectBudget: async (root, scope) => { opened.push({ root, ...scope }); },
  });
  vm.runInContext(functionSource("loadProjectDetail"), context);
  await context.loadProjectDetail();
  assert.equal(opened.length, 1);
  assert.equal(opened[0].domainId, "support");
  assert.equal(opened[0].projectId, "case-assist");
  context.S.projectDetailDomain = "absent";
  await context.loadProjectDetail();
  assert.equal(opened.length, 1);
  assert.match(box.innerHTML, /Project scope is unavailable/);
});
