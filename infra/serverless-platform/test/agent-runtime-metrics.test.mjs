import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentRuntimeMetrics,
} from "../lambda/agent-runtime/metrics.mjs";

function invocation(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    succeeded: true,
    latencyMs: 125,
    inputTokens: 21,
    outputTokens: 8,
    ...overrides,
  };
}

test("emits bounded platform, domain, and project CloudWatch aggregates", () => {
  const lines = [];
  const metrics = createAgentRuntimeMetrics({
    write(line) {
      lines.push(line);
    },
    clock: () => new Date("2026-08-25T00:00:00.000Z"),
  });

  metrics.recordInvocation(invocation());

  assert.equal(lines.length, 3);
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map(({ ScopeType, DomainId, ProjectId }) => ({
      ScopeType,
      DomainId: DomainId ?? null,
      ProjectId: ProjectId ?? null,
    })),
    [
      { ScopeType: "platform", DomainId: null, ProjectId: null },
      {
        ScopeType: "domain",
        DomainId: "customer_support",
        ProjectId: null,
      },
      {
        ScopeType: "project",
        DomainId: "customer_support",
        ProjectId: "case-assist",
      },
    ],
  );
  for (const record of records) {
    assert.equal(record.RuntimeCount, 1);
    assert.equal(record.HealthyRuntimeCount, 1);
    assert.equal(record.InvocationCount, 1);
    assert.equal(record.ErrorCount, 0);
    assert.equal(record.Latency, 125);
    assert.equal(record.InputTokens, 21);
    assert.equal(record.OutputTokens, 8);
    assert.equal(record._aws.Timestamp, Date.parse("2026-08-25T00:00:00.000Z"));
    assert.equal(
      record._aws.CloudWatchMetrics[0].Namespace,
      "bedrock-agentcore",
    );
    assert.deepEqual(
      record._aws.CloudWatchMetrics[0].Metrics,
      [
        { Name: "RuntimeCount", Unit: "Count" },
        { Name: "HealthyRuntimeCount", Unit: "Count" },
        { Name: "InvocationCount", Unit: "Count" },
        { Name: "ErrorCount", Unit: "Count" },
        { Name: "Latency", Unit: "Milliseconds" },
        { Name: "InputTokens", Unit: "Count" },
        { Name: "OutputTokens", Unit: "Count" },
      ],
    );
  }
  assert.deepEqual(
    records.map((record) =>
      record._aws.CloudWatchMetrics[0].Dimensions),
    [
      [["ScopeType"]],
      [["ScopeType", "DomainId"]],
      [["ScopeType", "DomainId", "ProjectId"]],
    ],
  );
  for (const record of records) {
    for (const key of [
      "actor",
      "subject",
      "requestId",
      "prompt",
      "output",
      "sessionId",
    ]) {
      assert.equal(Object.hasOwn(record, key), false);
    }
  }
});

test("failed invocations emit errors without invented token usage", () => {
  const lines = [];
  const metrics = createAgentRuntimeMetrics({
    write(line) {
      lines.push(line);
    },
    clock: () => new Date("2026-08-25T00:00:00.000Z"),
  });

  metrics.recordInvocation(invocation({
    succeeded: false,
    latencyMs: 750,
    inputTokens: 0,
    outputTokens: 0,
  }));

  for (const record of lines.map((line) => JSON.parse(line))) {
    assert.equal(record.HealthyRuntimeCount, 0);
    assert.equal(record.InvocationCount, 1);
    assert.equal(record.ErrorCount, 1);
    assert.equal(record.Latency, 750);
    assert.equal(record.InputTokens, 0);
    assert.equal(record.OutputTokens, 0);
  }
});

test("rejects malformed scope, values, configuration, and accessors", () => {
  assert.throws(
    () => createAgentRuntimeMetrics(),
    /metrics configuration is invalid/i,
  );
  const metrics = createAgentRuntimeMetrics({
    write() {},
    clock: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  const accessor = {
    domainId: "customer_support",
    projectId: "case-assist",
    succeeded: true,
    inputTokens: 1,
    outputTokens: 1,
    get latencyMs() {
      throw new Error("secret accessor");
    },
  };
  for (const value of [
    invocation({ domainId: "../other" }),
    invocation({ projectId: "Not A Slug" }),
    invocation({ succeeded: "yes" }),
    invocation({ latencyMs: -1 }),
    invocation({ inputTokens: 1.5 }),
    invocation({ outputTokens: -1 }),
    { ...invocation(), actor: "must-not-be-a-metric" },
    accessor,
  ]) {
    assert.throws(
      () => metrics.recordInvocation(value),
      (error) => (
        /metrics input is invalid/i.test(error.message)
        && !error.message.includes("secret")
      ),
    );
  }
});

test("rejects invalid clocks and namespace configuration", () => {
  const invalidClock = createAgentRuntimeMetrics({
    write() {},
    clock: () => new Date("invalid"),
  });
  assert.throws(
    () => invalidClock.recordInvocation(invocation()),
    /metrics clock is invalid/i,
  );

  assert.throws(
    () => createAgentRuntimeMetrics({
      write() {},
      clock: () => new Date("2026-08-25T00:00:00.000Z"),
      namespace: "x".repeat(256),
    }),
    /metrics configuration is invalid/i,
  );
});
