import assert from "node:assert/strict";
import test from "node:test";
import { createOperationsService } from "../lambda/operations/service.mjs";
import { createCloudWatchRuntimeProvider } from "../lambda/operations/runtime.mjs";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WINDOWS = { "1h": 60 * MINUTE, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
const NOW = Date.parse("2026-09-11T21:07:59.194Z");
const ADMIN = { actor: "synthetic-admin", role: "admin", activeDomain: null, domainIds: ["operations"] };
const PLATFORM = { type: "platform", domainIds: ["operations"], projectIds: [] };
const METRIC_KEYS = ["runtimeCount", "healthyRuntimeCount", "invocationCount", "errorCount", "averageLatencyMs", "p95LatencyMs", "inputTokens", "outputTokens"];

// Model the documented request-age rule independently of the requested Period.
// Supported fresh service windows never enter the >63-day retention tier.
function roundedStart(start, receivedAt) {
  const age = receivedAt - start;
  const resolution = age < 15 * DAY ? MINUTE : age < 63 * DAY ? 5 * MINUTE : 60 * MINUTE;
  return Math.floor(start / resolution) * resolution;
}

function harness({ now = NOW, mutate = () => {}, authorize = async () => ({ ok: true }) } = {}) {
  const calls = [];
  const usageCalls = [];
  const provider = createCloudWatchRuntimeProvider({
    GetMetricDataCommand: class { constructor(input) { this.input = input; } },
    client: { async send({ input }) {
      calls.push(input);
      const timestamp = new Date(roundedStart(input.StartTime.getTime(), now));
      const response = {
        $metadata: { httpStatusCode: 200 },
        MetricDataResults: input.MetricDataQueries.map(query => ({
          Id: query.Id, Label: query.Label, StatusCode: "Complete", Timestamps: [timestamp], Values: [1],
        })),
      };
      mutate(response, input);
      return response;
    } },
  });
  const service = createOperationsService({
    workspaceState: {
      ...Object.fromEntries(["beginTransaction", "getMutationResult", "getProject", "listIncidents", "getIncident", "putIncident", "listAuditMetadata", "listBreakGlass", "getBreakGlass", "putBreakGlass"].map(name => [name, () => { throw new Error(`Unexpected workflow: ${name}`); }])),
      async listProjects() { return { items: [], cursor: null }; },
    },
    authorizer: authorize,
    cloudWatchProvider: provider,
    usageProvider: {
      async listInvocationUsageAggregates(input) { usageCalls.push(input); return { items: [], cursor: null }; },
      async listBudgets() { return []; },
    },
    clock: () => now,
    cursorSigningKey: "synthetic-window-review-signing-material-only",
  });
  return { service, provider, calls, usageCalls };
}

for (const [window, duration] of Object.entries(WINDOWS)) {
  for (const instant of [NOW, Date.parse("2026-10-04T00:00:00.001Z"), Date.parse("2026-01-01T00:00:00.000Z")]) {
    test(`${window} keeps duration and declared UTC half-open bounds at ${new Date(instant).toISOString()}`, async () => {
      const { service, calls } = harness({ now: instant });
      const result = await service.listOperations({ identity: ADMIN, window, limit: 50 });
      const resolution = duration < 15 * DAY ? MINUTE : 5 * MINUTE;
      const end = Math.floor(instant / resolution) * resolution;
      assert.deepEqual(result.window, { startTime: new Date(end - duration).toISOString(), endTime: new Date(end).toISOString() });
      assert.equal(calls.length, 1);
      const request = calls[0];
      assert.equal(request.StartTime.getTime(), end - duration);
      assert.equal(request.EndTime.getTime(), end);
      assert.ok(end <= instant && instant - end < resolution);
      assert.equal(roundedStart(request.StartTime.getTime(), instant), request.StartTime.getTime());
      assert.equal(request.MetricDataQueries.length, 8);
      assert.equal(request.MaxDatapoints, 8);
      for (const query of request.MetricDataQueries) {
        assert.equal(query.MetricStat.Period, duration / 1000);
        assert.equal(query.MetricStat.Period % (duration < 15 * DAY ? 60 : 300), 0);
        assert.equal(query.MetricStat.Metric.Namespace, "bedrock-agentcore");
        assert.deepEqual(query.MetricStat.Metric.Dimensions, [{ Name: "ScopeType", Value: "platform" }]);
        assert.equal(Object.hasOwn(query, "AccountId"), false);
      }
      assert.equal(result.items[0].invocationCount, 1);
    });
  }
  test(`${window} journal cost bounds are exact and not shifted with Operations`, async () => {
    const { service, usageCalls, calls } = harness();
    const result = await service.listCosts({ identity: ADMIN, window, limit: 50 });
    assert.deepEqual(result.window, { startTime: new Date(NOW - duration).toISOString(), endTime: new Date(NOW).toISOString() });
    assert.equal(usageCalls[0].startTime, result.window.startTime);
    assert.equal(usageCalls[0].endTime, result.window.endTime);
    assert.deepEqual(result.items, []);
    assert.equal(calls.length, 0);
  });
}

const hostileResponses = {
  "one millisecond before aligned start": (r, q) => { r.MetricDataResults[0].Timestamps = [new Date(q.StartTime.getTime() - 1)]; },
  "arbitrary old point": (r, q) => { r.MetricDataResults[0].Timestamps = [new Date(q.StartTime.getTime() - DAY)]; },
  "exclusive end point": (r, q) => { r.MetricDataResults[0].Timestamps = [q.EndTime]; },
  "future point": r => { r.MetricDataResults[0].Timestamps = [new Date(NOW + DAY)]; },
  "invalid timestamp": r => { r.MetricDataResults[0].Timestamps = [new Date(NaN)]; },
  "non-Date timestamp": r => { r.MetricDataResults[0].Timestamps = ["2026-09-11T00:00:00.000Z"]; },
  "duplicate datapoints": r => { const p = r.MetricDataResults[0]; p.Timestamps.push(p.Timestamps[0]); p.Values.push(1); },
  "duplicate result ID": r => { r.MetricDataResults[1] = r.MetricDataResults[0]; },
  "wrong result ID": r => { r.MetricDataResults[0].Id = "other_scope"; },
  "wrong project label": r => { r.MetricDataResults[0].Label = "other/project|RuntimeCount|Maximum"; },
  "unexpected account metadata": r => { r.MetricDataResults[0].AccountId = "synthetic-other-account"; },
  "unexpected dimensions": r => { r.MetricDataResults[0].Dimensions = [{ Name: "ProjectId", Value: "other" }]; },
  "NaN": r => { r.MetricDataResults[0].Values = [NaN]; },
  "Infinity": r => { r.MetricDataResults[0].Values = [Infinity]; },
  "negative metric": r => { r.MetricDataResults[0].Values = [-1]; },
  "fractional counter": r => { r.MetricDataResults[0].Values = [1.5]; },
  "partial results": r => { r.MetricDataResults[0].StatusCode = "PartialData"; },
  "unconsumed pagination": r => { r.NextToken = "synthetic-next"; },
};
for (const [name, mutate] of Object.entries(hostileResponses)) {
  test(`aligned Operations still fails closed for ${name}`, async () => {
    const { service } = harness({ mutate });
    await assert.rejects(service.listOperations({ identity: ADMIN, window: "30d", limit: 50 }), { code: "OPERATIONS_UNAVAILABLE" });
  });
}

test("last millisecond before end is valid and unordered result IDs are matched", async () => {
  const { service } = harness({ mutate(r, q) {
    for (const point of r.MetricDataResults) point.Timestamps = [new Date(q.EndTime.getTime() - 1)];
    r.MetricDataResults.reverse();
  } });
  const result = await service.listOperations({ identity: ADMIN, window: "1h", limit: 50 });
  assert.equal(result.items[0].invocationCount, 1);
});

test("no CloudWatch datapoints keeps every metric unknown, not zero", async () => {
  const { service } = harness({ mutate(r) {
    for (const point of r.MetricDataResults) { point.Timestamps = []; point.Values = []; }
  } });
  const result = await service.listOperations({ identity: ADMIN, window: "24h", limit: 50 });
  for (const key of METRIC_KEYS) assert.equal(result.items[0][key], null, key);
});

test("project queries retain exact namespace and authorized dimensions without cross-account override", async () => {
  const { provider, calls } = harness();
  const scope = { type: "projects", domainIds: ["operations"], projectIds: ["operations/synthetic-project"] };
  const result = await provider.listRuntimeAggregates({ scope, startTime: "2026-09-10T21:07:00.000Z", endTime: "2026-09-11T21:07:00.000Z", limit: 50 });
  for (const q of calls[0].MetricDataQueries) {
    assert.deepEqual(q.MetricStat.Metric.Dimensions, [
      { Name: "ScopeType", Value: "project" }, { Name: "DomainId", Value: "operations" }, { Name: "ProjectId", Value: "synthetic-project" },
    ]);
    assert.equal(Object.hasOwn(q, "AccountId"), false);
  }
  assert.equal(result.items[0].projectId, "synthetic-project");
  assert.equal(result.items[0].domainId, "operations");
});

test("wrong-domain project and injected account request fail before CloudWatch", async () => {
  const { provider, calls } = harness();
  const request = { scope: PLATFORM, startTime: "2026-09-10T21:07:00.000Z", endTime: "2026-09-11T21:07:00.000Z", limit: 50 };
  await assert.rejects(provider.listRuntimeAggregates({ ...request, scope: { type: "projects", domainIds: ["operations"], projectIds: ["other/synthetic-project"] } }), { code: "INVALID_REQUEST" });
  await assert.rejects(provider.listRuntimeAggregates({ ...request, accountId: "synthetic-other-account" }), { code: "INVALID_REQUEST" });
  assert.equal(calls.length, 0);
});

test("window repair does not bypass service authorization", async () => {
  const { service, calls } = harness({ authorize: async () => ({ ok: false }) });
  await assert.rejects(service.listOperations({ identity: ADMIN, window: "24h", limit: 50 }), { code: "FORBIDDEN" });
  assert.equal(calls.length, 0);
});
