import assert from "node:assert/strict";
import test from "node:test";
import { createProjectBudgetController, mountProjectBudget, projectBudgetHtml, validateBudgetInput } from "./public/modules/project-budget.mjs";

const scope = { domainId: "support", projectId: "case-assist" };
const budget = (version = 1, monthlyLimitUsd = 10) => ({ ...scope, version, monthlyLimitUsd,
  thresholdPercent: 80, currency: "USD", period: "CALENDAR_MONTH_UTC", updatedAt: "2026-09-11T12:00:00.000Z" });
const view = (value = null, canEdit = true) => ({ ok: true, resource: "project-budget", scope: { ...scope },
  project: { ...scope, name: "Case Assist", ownerSubject: "owner-sub", status: "ACTIVE" },
  access: { canEdit, role: canEdit ? "lead" : "builder" }, budget: value, evaluation: null });
const input = { monthlyLimitUsd: "10", thresholdPercent: "80" };

test("budget controller protects edits, failed saves, and unconfirmed acknowledgements until persisted read-back", async () => {
  let persisted = null, mode = "fail";
  const controller = createProjectBudgetController({ scope, request: async (path, body) => {
    if (body) {
      if (mode === "fail") return { ok: false, code: "OPERATIONS_UNAVAILABLE" };
      persisted = budget(); return { ok: true, budget: persisted };
    }
    if (mode === "unconfirmed") throw new Error("read unavailable");
    return view(persisted);
  } });
  await controller.load();
  assert.equal(controller.state.dirty, false);
  controller.edit(input);
  assert.equal(controller.state.dirty, true);
  await controller.save(input);
  assert.equal(controller.state.dirty, true);
  mode = "unconfirmed";
  await controller.save(input);
  assert.equal(controller.state.phase, "unconfirmed");
  assert.equal(controller.state.dirty, true);
  mode = "ok";
  await controller.load();
  assert.equal(controller.state.phase, "saved");
  assert.equal(controller.state.dirty, false);
  controller.edit({ ...input, monthlyLimitUsd: "20" });
  assert.equal(controller.state.dirty, true);
  controller.edit(input);
  assert.equal(controller.state.dirty, false);
});

test("mounted budget exposes a live dirty guard without rerendering on input and confirms refresh discard", async () => {
  let markup = "", renders = 0, gets = 0, permitDiscard = false;
  const form = { elements: { monthlyLimitUsd: { value: "" }, thresholdPercent: { value: "80" } } };
  const refresh = {};
  const root = { isConnected: true, querySelector: selector => selector === "[data-budget-form]" ? form : refresh,
    set innerHTML(value) { markup = value; renders++; }, get innerHTML() { return markup; } };
  let guard;
  const controller = await mountProjectBudget(root, { scope,
    registerDirtyGuard: value => { guard = value; },
    confirmDiscard: () => permitDiscard,
    request: async () => { gets++; return view(); },
  });
  assert.equal(typeof guard, "function");
  assert.equal(guard(), false);
  const before = renders;
  form.elements.monthlyLimitUsd.value = "25";
  form.oninput();
  assert.equal(guard(), true);
  assert.equal(renders, before);
  await refresh.onclick();
  assert.equal(gets, 1);
  assert.equal(controller.state.draft.monthlyLimitUsd, "25");
  permitDiscard = true;
  await refresh.onclick();
  assert.equal(gets, 2);
  assert.equal(guard(), false);
  form.elements.monthlyLimitUsd.value = "26";
  form.oninput();
  assert.equal(guard(), true);
  root.isConnected = false;
  assert.equal(guard(), false);
});

test("validates positive finite USD and integer threshold, never token fields", () => {
  assert.deepEqual(validateBudgetInput(input), { monthlyLimitUsd: 10, thresholdPercent: 80 });
  for (const values of [
    { monthlyLimitUsd: "", thresholdPercent: 80 }, { monthlyLimitUsd: 0, thresholdPercent: 80 },
    { monthlyLimitUsd: -1, thresholdPercent: 80 }, { monthlyLimitUsd: Infinity, thresholdPercent: 80 },
    { monthlyLimitUsd: 1e9 + 1, thresholdPercent: 80 }, { monthlyLimitUsd: 5, thresholdPercent: 80.5 },
    { monthlyLimitUsd: 5, thresholdPercent: 0 }, { monthlyLimitUsd: 5, thresholdPercent: 101 },
    { tokenBudget: 10, thresholdPercent: 80 },
  ]) assert.throws(() => validateBudgetInput(values));
});

test("save sends expectedVersion and USD; only persisted GET can confirm success", async () => {
  const calls = [];
  let persisted = null;
  const request = async (path, body, options) => {
    calls.push({ path, body, options });
    if (body) { persisted = budget(body.expectedVersion + 1, body.monthlyLimitUsd); return { ok: true, budget: persisted }; }
    return view(persisted);
  };
  const controller = createProjectBudgetController({ scope, request, requestId: () => "synthetic-1" });
  await controller.load();
  await controller.save(input);
  assert.equal(controller.state.phase, "saved");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].body, { ...scope, expectedVersion: 0, currency: "USD",
    period: "CALENDAR_MONTH_UTC", monthlyLimitUsd: 10, thresholdPercent: 80 });
  assert.equal(calls[1].options.requestId, "synthetic-1");
  assert.match(calls[2].path, /project-budgets\?domainId=support&projectId=case-assist/);
  assert.equal(calls[2].body, undefined);
  const refreshed = createProjectBudgetController({ scope, request });
  await refreshed.load();
  assert.equal(refreshed.state.view.budget.monthlyLimitUsd, 10);
  assert.equal(refreshed.state.view.budget.version, 1);
});

test("authoritative Builder read is read-only even when caller wants to save", async () => {
  const calls = [];
  const controller = createProjectBudgetController({ scope, request: async (...args) => {
    calls.push(args); return view(budget(), false);
  } });
  await controller.load();
  await controller.save(input);
  assert.equal(calls.length, 1);
  const html = projectBudgetHtml(controller.state);
  assert.match(html, /authorized.*admin.*lead/i);
  assert.doesNotMatch(html, /type="submit"|Request approval|localStorage/);
  assert.match(html, /owner-sub/);
});

test("failed POST preserves draft and retries identical mutation with same request ID", async () => {
  const ids = [];
  let attempts = 0;
  const controller = createProjectBudgetController({ scope, requestId: () => "stable-request",
    request: async (path, body, options) => {
      if (!body) return view();
      ids.push(options.requestId); attempts++;
      if (attempts === 1) throw new Error("offline");
      return { ok: false, code: "OPERATIONS_UNAVAILABLE" };
    } });
  await controller.load();
  await controller.save(input);
  assert.equal(controller.state.phase, "save-error");
  assert.match(projectBudgetHtml(controller.state, { postCreate: true }), /Project created.*budget setup.*incomplete/s);
  await controller.save(input);
  assert.deepEqual(ids, ["stable-request", "stable-request"]);
  assert.equal(controller.state.view.budget, null);
  assert.doesNotMatch(projectBudgetHtml(controller.state), /Saved and verified/);
});

test("POST acknowledgement with failed GET is unconfirmed; refresh verifies without another POST", async () => {
  let gets = 0, posts = 0;
  const controller = createProjectBudgetController({ scope, request: async (path, body) => {
    if (body) { posts++; return { ok: true, budget: budget() }; }
    if (++gets === 2) return { ok: false, code: "OPERATIONS_UNAVAILABLE" };
    return view(gets === 1 ? null : budget());
  } });
  await controller.load();
  await controller.save(input);
  assert.equal(controller.state.phase, "unconfirmed");
  assert.match(projectBudgetHtml(controller.state), /read-back.*unconfirmed/i);
  await controller.load();
  assert.equal(controller.state.phase, "saved");
  assert.equal(posts, 1);
});

test("conflict refreshes current version, preserves unsaved draft and never silently overwrites", async () => {
  let gets = 0, posts = 0;
  const controller = createProjectBudgetController({ scope, request: async (path, body) => {
    if (body) { posts++; return { ok: false, code: "CONFLICT" }; }
    return view(++gets === 1 ? budget() : budget(2, 25));
  } });
  await controller.load();
  await controller.save({ ...input, monthlyLimitUsd: "30" });
  assert.equal(controller.state.phase, "conflict");
  assert.equal(controller.state.view.budget.version, 2);
  assert.equal(controller.state.draft.monthlyLimitUsd, "30");
  assert.equal(posts, 1);
  assert.match(projectBudgetHtml(controller.state), /Review.*version/i);
});

test("invalid/foreign GET cannot enable writes and stale requests cannot overwrite fresh refresh", async () => {
  const bad = view(budget()); bad.scope.domainId = "finance";
  const denied = createProjectBudgetController({ scope, request: async () => bad });
  await denied.load();
  assert.equal(denied.state.phase, "load-error");
  assert.equal(denied.state.view, null);
  let resolveFirst, calls = 0;
  const controller = createProjectBudgetController({ scope, request: () => ++calls === 1
    ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(view(budget(2, 20))) });
  const first = controller.load();
  await controller.load();
  resolveFirst(view(budget()));
  await first;
  assert.equal(controller.state.view.budget.version, 2);
});

test("monthly preview discloses unknown remaining, stale usage, precision and USD/token separation", () => {
  const state = { phase: "ready", draft: input, view: view(budget()), message: "" };
  state.view.project.ownerSubject = '<img src=x onerror="bad()">';
  state.view.evaluation = { status: "INCOMPLETE", knownEstimatedCostUsd: 0.0000001,
    estimatedCostUsd: null, runCount: 2, costPerRunUsd: null, currency: "USD", basis: "estimate",
    window: { startTime: "2026-09-01T00:00:00.000Z", endTime: "2026-10-01T00:00:00.000Z",
      evaluatedThrough: "2026-09-11T12:00:00.000Z" }, reasons: ["stale-usage"], updatedAt: "2026-09-01T01:00:00.000Z" };
  const html = projectBudgetHtml(state);
  assert.match(html, /1\.00e-7/);
  assert.match(html, /Remaining.*unknown/i);
  assert.match(html, /stale-usage/);
  assert.match(html, /Token.*separate/i);
  assert.doesNotMatch(html, /<img|under budget|delivery confirmed/i);
});

test("session/scope invalidation blocks late read and save responses from rendering or confirming", async () => {
  let current = true, finish, changes = 0, requests = 0;
  const controller = createProjectBudgetController({ scope, isCurrent: () => current,
    onChange: () => { changes++; }, request: async (path, body) => {
      requests++;
      if (!body) return view();
      return new Promise(resolve => { finish = resolve; });
    } });
  await controller.load();
  const saving = controller.save(input);
  const before = changes;
  current = false;
  finish({ ok: true, budget: budget() });
  await saving;
  assert.equal(changes, before);
  assert.equal(requests, 2);
  assert.notEqual(controller.state.phase, "saved");
  await controller.save(input);
  assert.equal(requests, 2);
});

test("malformed or stale persisted read-back cannot confirm the POST", async () => {
  for (const bad of [view(null), view(budget(1, 999)), { ...view(budget()), access: { role: "builder", canEdit: true } }]) {
    let gets = 0;
    const controller = createProjectBudgetController({ scope, request: async (path, body) => {
      if (body) return { ok: true, budget: budget() };
      return ++gets === 1 ? view() : bad;
    } });
    await controller.load();
    await controller.save(input);
    assert.equal(controller.state.phase, "unconfirmed");
    assert.doesNotMatch(projectBudgetHtml(controller.state), /Saved and verified|type="submit"/);
  }
});

test("mounted editor notifies cost refresh only after successful persisted read-back", async () => {
  const root = { isConnected: true, innerHTML: "", querySelector: () => ({}) };
  let persisted = null, refreshes = 0;
  const controller = await mountProjectBudget(root, { scope, onSaved: () => { refreshes++; },
    request: async (path, body) => {
      if (body) { persisted = budget(); return { ok: true, budget: persisted }; }
      return view(persisted);
    } });
  assert.equal(refreshes, 0);
  await controller.save(input);
  assert.equal(refreshes, 1);
  assert.match(root.innerHTML, /Saved and verified/);
});
