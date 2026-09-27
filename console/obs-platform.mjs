import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const OBS_NAMESPACE = "AgenticPlatform/Agents"

export const OBS_METRIC_CATALOG = {
  invocations: {
    cloudwatchName: "agent.invocations",
    mockId: "invocations",
    label: "Invocations",
    unit: "count",
    stat: "Sum",
    kind: "volume",
  },
  "tokens.input": {
    cloudwatchName: "agent.tokens.input",
    mockId: "totalTokens",
    label: "Input tokens",
    unit: "tokens",
    stat: "Sum",
    kind: "volume",
  },
  "tokens.output": {
    cloudwatchName: "agent.tokens.output",
    mockId: "totalTokens",
    label: "Output tokens",
    unit: "tokens",
    stat: "Sum",
    kind: "volume",
  },
  "tokens.total": {
    cloudwatchName: "agent.tokens.total",
    mockId: "totalTokens",
    label: "Total tokens",
    unit: "tokens",
    stat: "Sum",
    kind: "volume",
  },
  latency: {
    cloudwatchName: "agent.latency",
    mockId: "requestMs",
    label: "Latency",
    unit: "ms",
    stat: "Average",
    kind: "latency",
  },
  ttft: {
    cloudwatchName: "agent.ttft",
    mockId: "ttftMs",
    label: "TTFT",
    unit: "ms",
    stat: "Average",
    kind: "latency",
  },
  errors: {
    cloudwatchName: "agent.errors",
    mockId: "errorRate",
    label: "Errors",
    unit: "count",
    stat: "Sum",
    kind: "volume",
  },
  "tool.invocations": {
    cloudwatchName: "agent.tool.invocations",
    mockId: "reasoningCycles",
    label: "Tool invocations",
    unit: "count",
    stat: "Sum",
    kind: "volume",
  },
  "tool.errors": {
    cloudwatchName: "agent.tool.errors",
    mockId: "errorRate",
    label: "Tool errors",
    unit: "count",
    stat: "Sum",
    kind: "volume",
  },
  "reasoning.cycles": {
    cloudwatchName: "agent.reasoning.cycles",
    mockId: "reasoningCycles",
    label: "Reasoning cycles",
    unit: "count",
    stat: "Average",
    kind: "volume",
  },
  "cost.usd": {
    cloudwatchName: "agent.cost.usd",
    mockId: "costUsd",
    label: "Cost",
    unit: "USD",
    stat: "Sum",
    kind: "volume",
  },
}

const DEFAULT_METRICS = [
  "invocations",
  "tokens.total",
  "latency",
  "ttft",
  "errors",
  "tool.invocations",
  "reasoning.cycles",
]

export function parseObsRequest(searchParams) {
  const scope = searchParams.get("scope") || "fleet"
  const scopeId = searchParams.get("scopeId") || searchParams.get("id") || (scope === "fleet" ? "all" : "")
  const metricIds = (searchParams.get("metrics") || DEFAULT_METRICS.join(","))
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(id => OBS_METRIC_CATALOG[id])
  const window = searchParams.get("window") || `${Math.min(30, Math.max(1, parseInt(searchParams.get("days") || "14", 10) || 14))}d`
  const days = window === "1d" ? 1 : window === "7d" ? 7 : window === "30d" ? 30 : Math.min(30, Math.max(1, parseInt(window, 10) || 14))
  const granularity = searchParams.get("granularity") || (days <= 1 ? "1h" : "1d")
  return {
    scope: ["fleet", "domain", "agent"].includes(scope) ? scope : "fleet",
    scopeId,
    metricIds: metricIds.length ? metricIds : DEFAULT_METRICS,
    window,
    days,
    granularity: ["1h", "1d"].includes(granularity) ? granularity : "1d",
  }
}

export function obsTimestamps(days, granularity = "1d", now = new Date()) {
  const stepMs = granularity === "1h" ? 3600000 : 86400000
  const count = granularity === "1h" ? Math.max(1, days * 24) : days
  const end = new Date(now)
  end.setUTCMinutes(0, 0, 0)
  if (granularity === "1d") end.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: count }, (_, i) => new Date(end.getTime() - (count - 1 - i) * stepMs).toISOString())
}

export function canonicalSeriesFromMock(mock, metricIds, { granularity = "1d", now = new Date() } = {}) {
  const stamps = obsTimestamps(mock.windowDays || 14, granularity, now)
  const out = {}
  for (const id of metricIds) {
    const spec = OBS_METRIC_CATALOG[id]
    const legacy = mock.series?.[spec.mockId]
    if (!legacy) continue
    let values = legacy.points || []
    if (id === "tokens.input") values = values.map(v => Math.round(v * 0.62))
    if (id === "tokens.output") values = values.map(v => Math.round(v * 0.38))
    if (id === "errors") {
      const invocations = mock.series?.invocations?.points || []
      values = values.map((rate, i) => Math.max(0, Math.round((invocations[i] || 0) * Number(rate || 0) / 100)))
    }
    if (id === "tool.errors") {
      const invocations = mock.series?.invocations?.points || []
      values = values.map((rate, i) => Math.max(0, Math.round((invocations[i] || 0) * Number(rate || 0) / 100 * 0.35)))
    }
    if (id === "tool.invocations") values = values.map(v => Math.max(0, Math.round(v * 0.18)))
    if (id === "reasoning.cycles") values = values.map(v => Math.max(0, Math.round(v / Math.max(1, mock.windowDays || 14))))
    out[id] = summarizeSeries(id, spec, stamps, values)
  }
  return out
}

export function obsResponseFromMock({ mock, request, fallbackReason = null, backend = "mock" }) {
  return {
    ok: true,
    source: "mock",
    backend,
    fallbackReason,
    scope: request.scope,
    scopeId: request.scopeId,
    window: request.window,
    windowDays: mock.windowDays,
    granularity: request.granularity,
    namespace: OBS_NAMESPACE,
    series: canonicalSeriesFromMock(mock, request.metricIds, { granularity: request.granularity }),
    domains: mock.domains || [],
  }
}

export function summarizeSeries(id, spec, timestamps, values) {
  const nums = values.map(v => Number.isFinite(Number(v)) ? Number(v) : 0)
  const total = nums.reduce((s, v) => s + v, 0)
  const avg = nums.length ? total / nums.length : 0
  const dp = spec.kind === "latency" ? 0 : 2
  const round = v => Number(v.toFixed(dp))
  return {
    metricId: id,
    cloudwatchName: spec.cloudwatchName,
    label: spec.label,
    unit: spec.unit,
    kind: spec.kind,
    points: timestamps.map((t, i) => ({ t, v: round(nums[i] || 0) })),
    total: round(total),
    avg: round(avg),
    last: round(nums.at(-1) || 0),
  }
}

function cloudWatchDimensions(scope, scopeId) {
  if (scope === "domain") return [{ Name: "domain", Value: scopeId }]
  if (scope === "agent") return [{ Name: "agent_runtime_id", Value: scopeId }]
  return []
}

function metricDataQuery(metricId, spec, index, scope, scopeId, period) {
  return {
    Id: `m${index}`,
    Label: metricId,
    MetricStat: {
      Metric: {
        Namespace: OBS_NAMESPACE,
        MetricName: spec.cloudwatchName,
        Dimensions: cloudWatchDimensions(scope, scopeId),
      },
      Period: period,
      Stat: spec.stat,
      Unit: spec.unit === "ms" ? "Milliseconds" : spec.unit === "tokens" ? "Count" : "Count",
    },
    ReturnData: true,
  }
}

export async function cloudWatchObsMetrics({ request, region = process.env.AWS_DEFAULT_REGION || "us-west-2", now = new Date() }) {
  const period = request.granularity === "1h" ? 3600 : 86400
  const end = new Date(now)
  const start = new Date(end.getTime() - request.days * 86400000)
  const queries = request.metricIds.map((id, i) => metricDataQuery(id, OBS_METRIC_CATALOG[id], i, request.scope, request.scopeId, period))
  const input = {
    StartTime: start.toISOString(),
    EndTime: end.toISOString(),
    ScanBy: "TimestampAscending",
    MetricDataQueries: queries,
  }
  const { stdout } = await execFileAsync("aws", [
    "cloudwatch", "get-metric-data",
    "--region", region,
    "--cli-input-json", JSON.stringify(input),
    "--output", "json",
  ], { maxBuffer: 1024 * 1024 * 5, timeout: 30000 })
  const parsed = JSON.parse(stdout)
  const series = {}
  for (const result of parsed.MetricDataResults || []) {
    const metricId = result.Label
    const spec = OBS_METRIC_CATALOG[metricId]
    if (!spec) continue
    const points = (result.Timestamps || []).map((t, i) => ({ t, v: Number(result.Values?.[i] || 0) }))
    if (!points.length) continue
    series[metricId] = summarizeSeries(metricId, spec, points.map(p => p.t), points.map(p => p.v))
  }
  if (!Object.keys(series).length) {
    return { ok: false, error: "No CloudWatch metric data found for the requested AgenticPlatform/Agents scope." }
  }
  return {
    ok: true,
    source: "cloudwatch",
    backend: "cloudwatch",
    scope: request.scope,
    scopeId: request.scopeId,
    window: request.window,
    windowDays: request.days,
    granularity: request.granularity,
    namespace: OBS_NAMESPACE,
    series,
  }
}
