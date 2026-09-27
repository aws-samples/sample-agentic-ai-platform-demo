import assert from "node:assert/strict";
import test from "node:test";
import { costSummary, hostedCostHtml, loadHostedCostPages, attributedCostSummary, costFreshness } from "./public/cost-view.mjs";

function page(items, cursor = null) {
  return {
    ok: true, resource: "costs", scope: { type: "projects" },
    window: { startTime: "2026-09-10T00:00:00.000Z", endTime: "2026-09-11T00:00:00.000Z" },
    items: items.map((item, i) => ({
      contractVersion: 1, currency: "USD", basis: "estimate",
      scopeType: "project", domainId: "support", projectId: `project-${i}`, ...item,
    })), cursor,
  };
}

test("missing dollars and zero runs display N/A; USD budgets are never token budgets", () => {
  const value = page([{ monthlyBudgetUsd: 100, runCount: 0 }]);
  assert.deepEqual(costSummary(value), {
    totalCostUsd: null, runCount: null, costPerRunUsd: null, acceptedDispatchCount: null,
  });
  const html = hostedCostHtml(value);
  assert.match(html, /N\/A/);
  assert.match(html, /Monthly budget USD/);
  assert.match(html, /\$100.00/);
  assert.doesNotMatch(html, /tokenBudget|4%|Monthly spend/);
});

test("cost totals remain summed while unproven run counts cannot supply an agent KPI", () => {
  assert.deepEqual(costSummary(page([
    { estimatedCostUsd: 9, runCount: 1, acceptedDispatchCount: 1 },
    { estimatedCostUsd: 1, runCount: 9, acceptedDispatchCount: 9 },
  ])), { totalCostUsd: 10, runCount: null, costPerRunUsd: null, acceptedDispatchCount: 10 });
  assert.equal(costSummary(page([{ estimatedCostUsd: 0, runCount: 0 }])).costPerRunUsd, null);
  assert.equal(costSummary(page([{ estimatedCostUsd: 1, runCount: 1 }], "next")).totalCostUsd, null);
  assert.equal(costSummary(page([
    { estimatedCostUsd: Number.MAX_VALUE, runCount: 1 },
    { estimatedCostUsd: Number.MAX_VALUE, runCount: 1 },
  ])).totalCostUsd, null);
});

test("pagination preserves scope/window/source and refuses incomplete or overlapping totals", async () => {
  const first = page([{ source: "provider", estimatedCostUsd: 1, runCount: 1 }], "next");
  const result = await loadHostedCostPages(first, async cursor => {
    assert.equal(cursor, "next");
    return page([{ projectId: "second", estimatedCostUsd: 2, runCount: 1 }]);
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].source, "provider");
  assert.deepEqual(result.window, first.window);
  assert.equal(costSummary(result).totalCostUsd, 3);
  assert.equal(costSummary(result).costPerRunUsd, null);
  await assert.rejects(loadHostedCostPages(first, async () => page([{}])), /Duplicate/);
  await assert.rejects(loadHostedCostPages(first, async () => ({
    ...page([]), window: { startTime: "other" },
  })), /scope or time window/);
  await assert.rejects(loadHostedCostPages(first, async () => ({ ok: false })));
});

test("hosted costs escape server text and retain tiny nonzero estimates", () => {
  const html = hostedCostHtml(page([{
    projectId: "<img onerror=alert(1)>", estimatedCostUsd: .0001, runCount: 1,
  }]));
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /\$0.000100/);
});

test("journal cost presentation labels cohort, unknown attempts and retained subtotal", () => {
  const html = hostedCostHtml(page([{
    source: "experience-invocation-journal", estimatedCostUsd: null, knownEstimatedCostUsd: .25,
    runCount: null, acceptedDispatchCount: 2, modelCoverage: "partial",
    pricingVersion: "test-only", updatedAt: "2026-09-11T00:00:00.000Z",
  }]));
  assert.match(html, /Dispatch-start/);
  assert.match(html, /eventually consistent/);
  assert.match(html, /Known subtotal: \$0.25/);
  assert.match(html, /unobserved attempts are excluded/);
  assert.match(html, /Price version:<\/dt> <dd>test-only/);
  assert.match(html, /Cost per run: <b>N\/A/);
});

test("priceable accepted dispatches and older journal responses never display an agent-run KPI", () => {
  for (const runCount of [null, 2]) {
    const value = page([{
      source: "experience-invocation-journal", estimatedCostUsd: 10, knownEstimatedCostUsd: 10,
      acceptedDispatchCount: 2, runCount, costPerRunUsd: 5, modelCoverage: "complete",
    }]);
    assert.equal(costSummary(value).totalCostUsd, 10);
    assert.equal(costSummary(value).runCount, null);
    assert.equal(costSummary(value).costPerRunUsd, null);
    const html = hostedCostHtml(value);
    assert.match(html, /Started agent runs: <b>N\/A/);
    assert.match(html, /Cost per run: <b>N\/A/);
    assert.match(html, /Accepted dispatches \(diagnostic\): <b>2/);
    assert.match(html, /Actual agent execution-start evidence is unavailable/);
    assert.doesNotMatch(html, /count as runs/);
  }
});

test("zero, unknown and incomplete dispatch totals do not establish zero agent runs or a KPI", () => {
  for (const value of [
    page([]),
    page([{ estimatedCostUsd: 0, acceptedDispatchCount: 0, runCount: 0 }]),
    page([{ estimatedCostUsd: null, acceptedDispatchCount: null, runCount: null }]),
    page([{ estimatedCostUsd: 1, acceptedDispatchCount: 1, runCount: 1 }], "next"),
    page([{ acceptedDispatchCount: 1 }, { acceptedDispatchCount: null }]),
  ]) {
    const summary = costSummary(value);
    assert.equal(summary.runCount, null);
    assert.equal(summary.costPerRunUsd, null);
    if (value.cursor !== null || value.items.some(item => item.acceptedDispatchCount === null)) {
      assert.equal(summary.acceptedDispatchCount, null);
    }
    if (value.cursor !== null) {
      assert.throws(() => hostedCostHtml(value), /incomplete/);
    } else {
      assert.match(hostedCostHtml(value), /Started agent runs: <b>N\/A/);
      assert.match(hostedCostHtml(value), /Cost per run: <b>N\/A/);
    }
  }
});

test("three-level cost summary counts each project once and keeps shared/full totals unknown", () => {
  const value = page([
    { estimatedCostUsd: 8 }, { estimatedCostUsd: 2 },
    { domainId: "finance", estimatedCostUsd: 3 },
  ]);
  const result = attributedCostSummary(value);
  assert.equal(result.attributedModelCostUsd, 13);
  assert.deepEqual(result.domains, [
    { domainId: "support", modelCostUsd: 10, projectCount: 2 },
    { domainId: "finance", modelCostUsd: 3, projectCount: 1 },
  ]);
  assert.equal(result.unallocatedSharedPlatformCostUsd, null);
  assert.equal(result.fullPlatformCostUsd, null);
  value.items[1].estimatedCostUsd = null;
  assert.equal(attributedCostSummary(value).attributedModelCostUsd, null);
  assert.equal(attributedCostSummary(value).domains[0].modelCostUsd, null);
  assert.equal(attributedCostSummary(value).domains[1].modelCostUsd, 3);
  assert.throws(() => attributedCostSummary({ ...value, items: [...value.items, value.items[0]] }), /Duplicate/);
  assert.throws(() => attributedCostSummary({ ...value, cursor: "next" }), /complete/);
  assert.match(hostedCostHtml(value), /Account-wide Cost Explorer.*separate Admin context/);
});

test("freshness discloses stale or missing usage without inventing recent ingestion", () => {
  const value = page([{ estimatedCostUsd: null, updatedAt: "2026-09-01T00:00:00.000Z" }]);
  assert.equal(costFreshness(value.items[0], value.window), "stale usage snapshot");
  assert.match(hostedCostHtml(value), /stale usage snapshot/);
  for (const updatedAt of [null, "invalid", "2027-01-01T00:00:00.000Z"]) {
    assert.equal(costFreshness({ updatedAt }, value.window), "unknown");
  }
});

test("compact cost display retains real budget bindings and keeps technical details collapsed", () => {
  const value = page([{ estimatedCostUsd: 1234.56, knownEstimatedCostUsd: 1234.56,
    monthlyBudgetUsd: 2000, projectBudget: { version: 3, thresholdPercent: 80 },
    pricingVersion: "synthetic-price", coverage: { excluded: ["shared"] } }]);
  const html = hostedCostHtml(value);
  assert.match(html, /\$1234\.56<\/b>/);
  assert.match(html, /<details class="cv-provenance"><summary>Provenance/);
  assert.match(html, /<details class="cv-method"><summary>Measurement/);
  assert.match(html, /data-project-budget-open data-domain="support" data-project="project-0"/);
  assert.match(html, /Version 3 · threshold 80%/);
  assert.match(html, /Remaining: unknown \(partial coverage\)/);
  assert.match(html, /Token allowances are separate from USD budgets/);
  assert.match(html, /Sep 10, 2026/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test("empty, missing and sub-micro costs never become fabricated zero or full totals", () => {
  assert.doesNotMatch(hostedCostHtml(page([])), /\$0/);
  assert.doesNotMatch(hostedCostHtml(page([{}])), /\$0/);
  const tiny = hostedCostHtml(page([{ estimatedCostUsd: 1e-7, knownEstimatedCostUsd: 1e-7 }]));
  assert.match(tiny, /\$1\.00e-7/);
  assert.match(tiny, /Full platform total: <b>N\/A/);
  // Zero cost shows as $0.00 (not $0.000000 — six-decimal display reserved for sub-cent non-zero amounts).
  assert.match(hostedCostHtml(page([{ estimatedCostUsd: 0 }])), /\$0\.00/);
  assert.doesNotMatch(hostedCostHtml(page([{ estimatedCostUsd: 0 }])), /\$0\.000000/);
});

test("project view refuses incomplete identity and mismatched declared project scope", async () => {
  const { scopedCostPage, projectCostHtml } = await import("./public/cost-view.mjs");
  const value = page([{ estimatedCostUsd: 2 }]);
  assert.throws(() => scopedCostPage(value, { projectId: "project-0" }), /domainId/);
  assert.throws(() => projectCostHtml(value), /exact project/);
  assert.throws(() => scopedCostPage({ ...value, scope: { type: "project", domainId: "support", projectId: "different" } }, { domainId: "support", projectId: "project-0" }), /mismatched/);
  const html = projectCostHtml(scopedCostPage(value, { domainId: "support", projectId: "project-0" }));
  assert.match(html, /data-project-cost|Project usage/);
  assert.doesNotMatch(html, /Domain cost summary|Account-wide Cost Explorer|Unallocated shared\/platform/);
});
