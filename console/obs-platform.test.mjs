import test from "node:test"
import assert from "node:assert/strict"
import { canonicalSeriesFromMock, obsResponseFromMock, parseObsRequest } from "./obs-platform.mjs"

const mock = {
  windowDays: 7,
  series: {
    invocations: { points: [10, 12, 14, 16, 18, 20, 22] },
    totalTokens: { points: [100, 120, 140, 160, 180, 200, 220] },
    requestMs: { points: [90, 91, 92, 93, 94, 95, 96] },
    ttftMs: { points: [300, 301, 302, 303, 304, 305, 306] },
    errorRate: { points: [0, 10, 0, 0, 5, 0, 0] },
    reasoningCycles: { points: [70, 77, 84, 91, 98, 105, 112] },
  },
  domains: [{ id: "customer-support", costUsd: 12 }],
}

test("parseObsRequest accepts canonical names and aliases scopeId", () => {
  const req = parseObsRequest(new URLSearchParams("scope=agent&id=supportdesk&metrics=invocations,tokens.total,nope&window=7d"))
  assert.equal(req.scope, "agent")
  assert.equal(req.scopeId, "supportdesk")
  assert.deepEqual(req.metricIds, ["invocations", "tokens.total"])
  assert.equal(req.days, 7)
})

test("canonicalSeriesFromMock maps legacy demo metrics to canonical schema", () => {
  const series = canonicalSeriesFromMock(mock, ["invocations", "tokens.input", "tokens.output", "errors"], {
    now: new Date("2026-08-13T00:00:00Z"),
  })
  assert.equal(series.invocations.total, 112)
  assert.equal(series["tokens.input"].total, 694)
  assert.equal(series["tokens.output"].total, 426)
  assert.deepEqual(series.errors.points.map(p => p.v), [0, 1, 0, 0, 1, 0, 0])
  assert.match(series.invocations.points[0].t, /^2026-08-07/)
})

test("obsResponseFromMock is honestly labeled as fallback data", () => {
  const request = parseObsRequest(new URLSearchParams("scope=domain&scopeId=customer-support&window=7d"))
  const res = obsResponseFromMock({ mock, request, backend: "cloudwatch", fallbackReason: "No CloudWatch metrics yet." })
  assert.equal(res.ok, true)
  assert.equal(res.source, "mock")
  assert.equal(res.backend, "cloudwatch")
  assert.equal(res.fallbackReason, "No CloudWatch metrics yet.")
  assert.equal(res.namespace, "AgenticPlatform/Agents")
  assert.ok(res.series.latency)
})
