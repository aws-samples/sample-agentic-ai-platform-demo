import assert from "node:assert/strict";
import test from "node:test";
import {
  platformMonitoringKpis,
  platformMonitoringGrouped,
  platformMonitoringHtml,
} from "./public/platform-monitoring-view.mjs";

const window = { startTime: "2026-09-10T00:00:00.000Z", endTime: "2026-09-11T00:00:00.000Z" };

function page(items, scope = { type: "projects" }, cursor = null) {
  return { ok: true, resource: "operations", scope, window, items, cursor };
}

function projectRow(overrides = {}) {
  return {
    scopeType: "project",
    domainId: "support",
    projectId: "case-assist",
    invocationCount: 100,
    errorCount: 2,
    averageLatencyMs: 50,
    p95LatencyMs: 120,
    runtimeCount: 4,
    healthyRuntimeCount: 4,
    ...overrides,
  };
}

function platformRow(overrides = {}) {
  return {
    scopeType: "platform",
    domainId: null,
    projectId: null,
    invocationCount: 500,
    errorCount: 10,
    averageLatencyMs: 80,
    p95LatencyMs: 200,
    runtimeCount: 10,
    healthyRuntimeCount: 9,
    ...overrides,
  };
}

// --- KPI math tests --------------------------------------------------------

test("platform aggregate row: KPI fields lifted directly", () => {
  const kpis = platformMonitoringKpis(page([platformRow()], { type: "platform" }));
  assert.equal(kpis.totalInvocations, 500);
  assert.equal(kpis.totalErrors, 10);
  assert.ok(Math.abs(kpis.errorRatePct - 2) < 1e-9);
  assert.equal(kpis.avgLatencyMs, 80);
  assert.equal(kpis.maxP95LatencyMs, 200);
  assert.equal(kpis.healthyRuntimeCount, 9);
  assert.equal(kpis.totalRuntimeCount, 10);
});

test("zero invocations yields 0% error rate, not null", () => {
  const kpis = platformMonitoringKpis(page([projectRow({ invocationCount: 0, errorCount: 0 })]));
  assert.equal(kpis.errorRatePct, 0);
  assert.equal(kpis.totalInvocations, 0);
});

test("null invocations when errorCount present keeps errorRatePct null", () => {
  const kpis = platformMonitoringKpis(page([projectRow({ invocationCount: null, errorCount: 5 })]));
  assert.equal(kpis.totalInvocations, null);
  assert.equal(kpis.errorRatePct, null);
});

test("weighted average latency across two project rows", () => {
  // row A: 100 invocations @ 50ms, row B: 100 invocations @ 150ms → weighted avg 100ms
  const rows = [
    projectRow({ domainId: "a", projectId: "p1", invocationCount: 100, averageLatencyMs: 50 }),
    projectRow({ domainId: "a", projectId: "p2", invocationCount: 100, averageLatencyMs: 150 }),
  ];
  const kpis = platformMonitoringKpis(page(rows));
  assert.equal(kpis.avgLatencyMs, 100);
});

test("max p95 latency is the highest across all rows", () => {
  const rows = [
    projectRow({ domainId: "a", projectId: "p1", p95LatencyMs: 100 }),
    projectRow({ domainId: "a", projectId: "p2", p95LatencyMs: 300 }),
    projectRow({ domainId: "b", projectId: "p3", p95LatencyMs: 200 }),
  ];
  const kpis = platformMonitoringKpis(page(rows));
  assert.equal(kpis.maxP95LatencyMs, 300);
});

test("invocations and errors summed across all project rows", () => {
  const rows = [
    projectRow({ domainId: "a", projectId: "p1", invocationCount: 50, errorCount: 1 }),
    projectRow({ domainId: "b", projectId: "p2", invocationCount: 200, errorCount: 8 }),
  ];
  const kpis = platformMonitoringKpis(page(rows));
  assert.equal(kpis.totalInvocations, 250);
  assert.equal(kpis.totalErrors, 9);
  assert.ok(Math.abs(kpis.errorRatePct - 3.6) < 1e-9);
});

test("empty page returns all-null KPIs", () => {
  const kpis = platformMonitoringKpis(page([]));
  assert.equal(kpis.totalInvocations, null);
  assert.equal(kpis.errorRatePct, null);
  assert.equal(kpis.avgLatencyMs, null);
  assert.equal(kpis.maxP95LatencyMs, null);
  assert.equal(kpis.healthyRuntimeCount, null);
  assert.equal(kpis.totalRuntimeCount, null);
});

test("latency skipped when invocationCount is null (cannot weight)", () => {
  const rows = [
    projectRow({ invocationCount: null, averageLatencyMs: 999 }),
    projectRow({ domainId: "a", projectId: "p2", invocationCount: 50, averageLatencyMs: 40 }),
  ];
  const kpis = platformMonitoringKpis(page(rows));
  // Only p2 contributes to weighted latency
  assert.equal(kpis.avgLatencyMs, 40);
});

test("fail-closed: incomplete page (cursor not null) throws", () => {
  assert.throws(() => platformMonitoringKpis(page([], { type: "platform" }, "next")), /cursor must be null/);
  assert.throws(() => platformMonitoringKpis({ ok: false }), /cursor must be null/);
  assert.throws(() => platformMonitoringKpis(null), /cursor must be null/);
});

// --- Grouping tests ---------------------------------------------------------

test("grouping aggregates project rows under their domain", () => {
  const rows = [
    projectRow({ domainId: "finance", projectId: "billing", invocationCount: 300 }),
    projectRow({ domainId: "support", projectId: "triage", invocationCount: 100 }),
    projectRow({ domainId: "support", projectId: "escalation", invocationCount: 50 }),
  ];
  const grouped = platformMonitoringGrouped(page(rows));
  assert.equal(grouped.length, 2);
  // finance has more invocations, should sort first
  assert.equal(grouped[0].domainId, "finance");
  assert.equal(grouped[0].totalInvocations, 300);
  assert.equal(grouped[1].domainId, "support");
  assert.equal(grouped[1].totalInvocations, 150);
  assert.equal(grouped[1].rows.length, 2);
});

test("grouping: domains with equal invocations sorted alphabetically", () => {
  const rows = [
    projectRow({ domainId: "zebra", projectId: "p", invocationCount: 10 }),
    projectRow({ domainId: "alpha", projectId: "p", invocationCount: 10 }),
  ];
  const grouped = platformMonitoringGrouped(page(rows));
  assert.equal(grouped[0].domainId, "alpha");
  assert.equal(grouped[1].domainId, "zebra");
});

test("grouping fail-closed: incomplete page throws", () => {
  assert.throws(() => platformMonitoringGrouped(page([], { type: "platform" }, "cursor")), /cursor must be null/);
});

// --- HTML rendering tests --------------------------------------------------

test("empty state shows honest message, no fabricated numbers", () => {
  const html = platformMonitoringHtml(page([]));
  assert.match(html, /No invocations recorded in this window/);
  assert.doesNotMatch(html, /\d+ invocations|\d+%/);
  assert.match(html, /data-platform-monitoring/);
});

test("platform aggregate page renders KPI row with real numbers", () => {
  const html = platformMonitoringHtml(page([platformRow()], { type: "platform" }));
  assert.match(html, /Total invocations: <b>500<\/b>/);
  assert.match(html, /Error rate: <b>2\.0%<\/b>/);
  assert.match(html, /Avg latency: <b>80 ms<\/b>/);
  assert.match(html, /p95 latency: <b>200 ms<\/b>/);
  assert.match(html, /Healthy runtimes: <b>9 \/ 10<\/b>/);
  // Single aggregate: no domain table
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /platform aggregate/);
});

test("per-project page renders domain table with rows", () => {
  const rows = [
    projectRow({ domainId: "finance", projectId: "billing", invocationCount: 200, errorCount: 1 }),
    projectRow({ domainId: "support", projectId: "triage", invocationCount: 100, errorCount: 6 }),
  ];
  const html = platformMonitoringHtml(page(rows));
  assert.match(html, /<table/);
  assert.match(html, /finance/);
  assert.match(html, /support/);
  assert.match(html, /billing/);
  assert.match(html, /triage/);
  // error rate badges present
  assert.match(html, /error rate|chip/i);
});

test("window selector label rendered in UTC", () => {
  const html = platformMonitoringHtml(page([platformRow()], { type: "platform" }));
  assert.match(html, /10 Sep 2026/);
  assert.match(html, /11 Sep 2026/);
});

test("XSS escaping: malicious domainId and projectId cannot inject HTML", () => {
  const attack = '<img src=x onerror=alert(1)>';
  const rows = [
    projectRow({ domainId: attack, projectId: attack, invocationCount: 5, errorCount: 0 }),
  ];
  const html = platformMonitoringHtml(page(rows));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("error rate badge state: ok <1%, warn 1-5%, error >=5%", () => {
  const makeRow = (inv, err, pid) => projectRow({ domainId: "d", projectId: pid, invocationCount: inv, errorCount: err });
  const okHtml = platformMonitoringHtml(page([makeRow(1000, 9, "ok")]));      // 0.9% → ok
  const warnHtml = platformMonitoringHtml(page([makeRow(1000, 20, "warn")])); // 2% → warn
  const errHtml = platformMonitoringHtml(page([makeRow(1000, 60, "err")]));   // 6% → error

  // ok state
  assert.match(okHtml, /color:var\(--ok\)/);
  // warn state
  assert.match(warnHtml, /color:var\(--warn/);
  // error state
  assert.match(errHtml, /color:var\(--err\)/);
});

test("no-traffic badge when invocations are zero", () => {
  const html = platformMonitoringHtml(page([
    projectRow({ invocationCount: 0, errorCount: 0 }),
  ]));
  assert.match(html, /no traffic/);
});

test("unavailable HTML when page is malformed or incomplete", () => {
  for (const bad of [null, { ok: false }, { ok: true, items: [], cursor: "next" }]) {
    const html = platformMonitoringHtml(bad);
    assert.match(html, /unavailable/i);
    assert.doesNotMatch(html, /data-platform-monitoring/);
  }
});

test("per-agent traces are never mentioned as available in the output", () => {
  const html = platformMonitoringHtml(page([platformRow()], { type: "platform" }));
  assert.doesNotMatch(html, /tracebox|lfbox|data-traces/);
  assert.match(html, /traces stay in the owning|out of scope/i);
});

test("null latency fields render as dash, not zero", () => {
  const html = platformMonitoringHtml(page([
    projectRow({ averageLatencyMs: null, p95LatencyMs: null }),
  ]));
  // Should not see "0 ms" from null latencies
  assert.doesNotMatch(html, /Avg latency: <b>0 ms/);
  assert.doesNotMatch(html, /p95 latency: <b>0 ms/);
});

test("admin breakdown page drives the domain/project table with the aggregate KPIs on top", () => {
  const aggregate = page([platformRow({ invocationCount: 40, errorCount: 2, averageLatencyMs: 900, p95LatencyMs: 2100, runtimeCount: 2, healthyRuntimeCount: 2 })], { type: "platform" });
  const breakdown = page([
    projectRow({ domainId: "support", projectId: "case-assist", invocationCount: 30, errorCount: 2, averageLatencyMs: 1000, p95LatencyMs: 2100 }),
    projectRow({ domainId: "operations", projectId: "ops-bot", invocationCount: 10, errorCount: 0, averageLatencyMs: 600, p95LatencyMs: 900 }),
  ], { type: "projects" });
  const html = platformMonitoringHtml(aggregate, breakdown);
  assert.match(html, /Platform health by domain/);
  assert.match(html, /Total invocations: <b>40</);
  assert.match(html, /support<\/b>/);
  assert.match(html, /operations<\/b>/);
  assert.match(html, /case-assist/);
  assert.match(html, /ops-bot/);
});

test("admin breakdown with zero traffic still lists every domain and project", () => {
  const aggregate = page([platformRow({ invocationCount: null, errorCount: null, averageLatencyMs: null, p95LatencyMs: null, runtimeCount: null, healthyRuntimeCount: null })], { type: "platform" });
  const breakdown = page([
    projectRow({ domainId: "support", projectId: "case-assist", invocationCount: null, errorCount: null, averageLatencyMs: null, p95LatencyMs: null, runtimeCount: null, healthyRuntimeCount: null }),
    projectRow({ domainId: "platform", projectId: "platform-foundation", invocationCount: null, errorCount: null, averageLatencyMs: null, p95LatencyMs: null, runtimeCount: null, healthyRuntimeCount: null }),
  ], { type: "projects" });
  const html = platformMonitoringHtml(aggregate, breakdown);
  assert.match(html, /case-assist/);
  assert.match(html, /platform-foundation/);
  assert.match(html, /no traffic in window/);
  assert.match(html, /structure below lists/);
  assert.doesNotMatch(html, /single platform aggregate for this role/);
});

test("a failed breakdown fetch falls back to the aggregate-only view", () => {
  const aggregate = page([platformRow({ invocationCount: 5, errorCount: 0 })], { type: "platform" });
  const html = platformMonitoringHtml(aggregate, null);
  assert.match(html, /Total invocations: <b>5</);
});
