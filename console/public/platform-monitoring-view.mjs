// Platform-admin monitoring rollup: per-domain/project invocation counts, latency, and error rates.
//
// Consumes the GET /api/operations?window=&limit= page the hosted monitoring path uses.
// Admin scope returns a single platform-level aggregate (scope.type === 'platform') or, in
// some configurations, per-project rows (scope.type === 'projects').  This module handles
// either shape, computing platform KPIs and grouping rows by domain for the table view.
//
// Deliberately out of scope: per-agent traces.  Those belong to the project-level workspace
// (Observability tab) where content-level access is grant-gated and audited.  No trace API
// calls are made here.
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]))

const num = value => typeof value === "number" && Number.isFinite(value) && value >= 0

// --- KPI computation -------------------------------------------------------

// Compute platform-level KPIs from a fully-loaded (cursor===null) operations page.
// When the page has only a platform-aggregate row we lift numbers from that row directly.
// When it has per-project rows we roll them up ourselves so every number is traceable.
//
// Returns: { totalInvocations, totalErrors, errorRatePct, avgLatencyMs, maxP95LatencyMs,
//            healthyRuntimeCount, totalRuntimeCount }
// Any field that cannot be computed from available data is null.
export function platformMonitoringKpis(page) {
  if (page?.ok !== true || !Array.isArray(page.items) || page.cursor !== null) {
    throw new Error("A complete operations page is required (cursor must be null).")
  }

  const rows = page.items
  if (!rows.length) {
    return {
      totalInvocations: null,
      totalErrors: null,
      errorRatePct: null,
      avgLatencyMs: null,
      maxP95LatencyMs: null,
      healthyRuntimeCount: null,
      totalRuntimeCount: null,
    }
  }

  // If there is a single platform-scope row, use it directly.
  if (rows.length === 1 && rows[0].scopeType === "platform") {
    const r = rows[0]
    const inv = num(r.invocationCount) ? r.invocationCount : null
    const err = num(r.errorCount) ? r.errorCount : null
    const errPct = inv !== null && err !== null && inv > 0 ? (err / inv) * 100
      : inv !== null && err !== null && inv === 0 ? 0 : null
    return {
      totalInvocations: inv,
      totalErrors: err,
      errorRatePct: errPct,
      avgLatencyMs: num(r.averageLatencyMs) ? r.averageLatencyMs : null,
      maxP95LatencyMs: num(r.p95LatencyMs) ? r.p95LatencyMs : null,
      healthyRuntimeCount: num(r.healthyRuntimeCount) ? r.healthyRuntimeCount : null,
      totalRuntimeCount: num(r.runtimeCount) ? r.runtimeCount : null,
    }
  }

  // Multi-row: roll up. Weighted average latency by invocation count; max p95.
  let totalInv = 0, totalErr = 0, weightedLatency = 0, coveredLatency = 0
  let maxP95 = null, healthyRT = 0, totalRT = 0
  let anyInv = false, anyErr = false, anyRT = false
  for (const r of rows) {
    if (num(r.invocationCount)) { totalInv += r.invocationCount; anyInv = true }
    if (num(r.errorCount)) { totalErr += r.errorCount; anyErr = true }
    if (num(r.invocationCount) && num(r.averageLatencyMs)) {
      weightedLatency += r.invocationCount * r.averageLatencyMs
      coveredLatency += r.invocationCount
    }
    if (num(r.p95LatencyMs)) maxP95 = maxP95 === null ? r.p95LatencyMs : Math.max(maxP95, r.p95LatencyMs)
    if (num(r.runtimeCount)) { totalRT += r.runtimeCount; anyRT = true }
    if (num(r.healthyRuntimeCount)) healthyRT += r.healthyRuntimeCount
  }

  const inv = anyInv ? totalInv : null
  const err = anyErr ? totalErr : null
  const errPct = inv !== null && err !== null && inv > 0 ? (err / inv) * 100
    : inv !== null && err !== null && inv === 0 ? 0 : null
  const avgLat = coveredLatency > 0 ? weightedLatency / coveredLatency : null

  return {
    totalInvocations: inv,
    totalErrors: err,
    errorRatePct: errPct,
    avgLatencyMs: avgLat,
    maxP95LatencyMs: maxP95,
    healthyRuntimeCount: anyRT ? healthyRT : null,
    totalRuntimeCount: anyRT ? totalRT : null,
  }
}

// --- Domain/project grouping -----------------------------------------------

// Group per-project rows by domainId, sorted by total invocations descending.
// Returns an array of { domainId, totalInvocations, totalErrors, avgLatencyMs, maxP95LatencyMs,
//                       healthyRuntimeCount, totalRuntimeCount, rows: [...] }
// where each row carries the original ops row fields.
export function platformMonitoringGrouped(page) {
  if (page?.ok !== true || !Array.isArray(page.items) || page.cursor !== null) {
    throw new Error("A complete operations page is required (cursor must be null).")
  }

  const domains = new Map()
  for (const r of page.items) {
    const domainKey = r.domainId ?? "(platform)"
    if (!domains.has(domainKey)) {
      domains.set(domainKey, {
        domainId: domainKey,
        totalInvocations: 0,
        totalErrors: 0,
        weightedLatency: 0,
        coveredLatency: 0,
        maxP95LatencyMs: null,
        healthyRuntimeCount: 0,
        totalRuntimeCount: 0,
        hasInv: false, hasErr: false, hasRT: false,
        rows: [],
      })
    }
    const d = domains.get(domainKey)
    d.rows.push(r)
    if (num(r.invocationCount)) { d.totalInvocations += r.invocationCount; d.hasInv = true }
    if (num(r.errorCount)) { d.totalErrors += r.errorCount; d.hasErr = true }
    if (num(r.invocationCount) && num(r.averageLatencyMs)) {
      d.weightedLatency += r.invocationCount * r.averageLatencyMs
      d.coveredLatency += r.invocationCount
    }
    if (num(r.p95LatencyMs)) d.maxP95LatencyMs = d.maxP95LatencyMs === null ? r.p95LatencyMs : Math.max(d.maxP95LatencyMs, r.p95LatencyMs)
    if (num(r.runtimeCount)) { d.totalRuntimeCount += r.runtimeCount; d.hasRT = true }
    if (num(r.healthyRuntimeCount)) d.healthyRuntimeCount += r.healthyRuntimeCount
  }

  const list = [...domains.values()].map(d => ({
    domainId: d.domainId,
    totalInvocations: d.hasInv ? d.totalInvocations : null,
    totalErrors: d.hasErr ? d.totalErrors : null,
    avgLatencyMs: d.coveredLatency > 0 ? d.weightedLatency / d.coveredLatency : null,
    maxP95LatencyMs: d.maxP95LatencyMs,
    healthyRuntimeCount: d.hasRT ? d.healthyRuntimeCount : null,
    totalRuntimeCount: d.hasRT ? d.totalRuntimeCount : null,
    rows: d.rows,
  }))
  list.sort((a, b) => (b.totalInvocations ?? -1) - (a.totalInvocations ?? -1) || a.domainId.localeCompare(b.domainId))
  return list
}

// --- Formatting helpers (internal) -----------------------------------------

function fmtCount(n) {
  return n === null ? "—" : n.toLocaleString("en")
}

function fmtLatency(ms) {
  return ms === null ? "—" : ms < 10 ? ms.toFixed(1) + " ms" : Math.round(ms) + " ms"
}

function fmtPct(pct) {
  if (pct === null) return "—"
  return pct === 0 ? "0%" : pct < 0.1 ? pct.toFixed(2) + "%" : pct.toFixed(1) + "%"
}

function errorRateBadge(totalInv, totalErr) {
  if (totalInv === null || totalErr === null) return `<span class="cv-sub">unknown</span>`
  const pct = totalInv > 0 ? (totalErr / totalInv) * 100 : 0
  const state = pct >= 5 ? "error" : pct >= 1 ? "warn" : "ok"
  const label = totalInv === 0 ? "no traffic" : fmtPct(pct)
  const colors = { ok: "var(--ok)", warn: "var(--warn,#ed6c02)", error: "var(--err)" }
  return `<span class="chip" style="color:${colors[state]};border-color:${colors[state]};font-size:.72rem">${esc(label)}</span>`
}

// --- HTML rendering --------------------------------------------------------

export function platformMonitoringHtml(page, breakdownPage = null) {
  if (page?.ok !== true || !Array.isArray(page.items) || page.cursor !== null) {
    return `<div class="empty">Platform monitoring data is unavailable.</div>`
  }

  // Admin passes two real pages: the platform aggregate (headline KPIs) and
  // a groupBy=project page (one row per ACTIVE project across every domain).
  // The breakdown drives the table so the domain/project structure is always
  // visible — rows without traffic render as "no traffic", never omitted.
  const breakdown = breakdownPage?.ok === true
    && Array.isArray(breakdownPage.items) && breakdownPage.cursor === null
    && breakdownPage.items.length > 0
    ? breakdownPage : null
  if (breakdown) {
    return renderBreakdown(page, breakdown)
  }

  const kpis = platformMonitoringKpis(page)
  const isPlatformAggregate = page.scope?.type === "platform"
  const anyRows = page.items.length > 0
  const anyInvocations = kpis.totalInvocations !== null && kpis.totalInvocations > 0

  const windowLabel = page.window
    ? `${esc(new Date(page.window.startTime).toUTCString().slice(5, 22))} – ${esc(new Date(page.window.endTime).toUTCString().slice(5, 22))} UTC`
    : ""

  // KPI strip
  const kpiRow = `<div class="cv-kpis">
    <p>Total invocations: <b>${fmtCount(kpis.totalInvocations)}</b></p>
    <p>Error rate: <b>${fmtPct(kpis.errorRatePct)}</b></p>
    <p>Avg latency: <b>${fmtLatency(kpis.avgLatencyMs)}</b></p>
    <p>p95 latency: <b>${fmtLatency(kpis.maxP95LatencyMs)}</b></p>
    <p>Healthy runtimes: <b>${kpis.healthyRuntimeCount !== null ? fmtCount(kpis.healthyRuntimeCount) + " / " + fmtCount(kpis.totalRuntimeCount) : "—"}</b></p>
  </div>`

  if (!anyRows) {
    return `<section class="card" data-platform-monitoring>
      <h2>Platform health</h2>
      ${windowLabel ? `<p class="cv-sub">${windowLabel}</p>` : ""}
      ${kpiRow}
      <p role="status">No invocations recorded in this window. Metrics will appear here automatically once agents are invoked.</p>
    </section>`
  }

  // For a single platform-aggregate row we show the KPI strip and a note that
  // per-domain breakdown is unavailable (the service returns a single aggregate).
  if (isPlatformAggregate) {
    return `<section class="card" data-platform-monitoring>
      <h2>Platform health</h2>
      ${windowLabel ? `<p class="cv-sub">${windowLabel}</p>` : ""}
      ${kpiRow}
      ${!anyInvocations ? `<p role="status">No invocations recorded in this window.</p>` : ""}
      <p class="cv-sub">The operations service returns a single platform aggregate for this role.
        Per-domain and per-project breakdowns are unavailable here — use the project Observability
        workspace for project-scoped metrics. Per-agent traces are explicitly out of scope on this view.</p>
    </section>`
  }

  // Per-project rows: group by domain and render the table.
  const grouped = platformMonitoringGrouped(page)

  const tableRows = grouped.map(d => {
    const domainInvStr = fmtCount(d.totalInvocations)
    const domainAvgStr = fmtLatency(d.avgLatencyMs)
    const domainP95Str = fmtLatency(d.maxP95LatencyMs)
    const domainRtStr = d.healthyRuntimeCount !== null
      ? fmtCount(d.healthyRuntimeCount) + " / " + fmtCount(d.totalRuntimeCount)
      : "—"
    const domainBadge = errorRateBadge(d.totalInvocations, d.totalErrors)

    const projectRows = d.rows.map(r => {
      const pInv = num(r.invocationCount) ? r.invocationCount : null
      const pErr = num(r.errorCount) ? r.errorCount : null
      const pAvg = num(r.averageLatencyMs) ? r.averageLatencyMs : null
      const pP95 = num(r.p95LatencyMs) ? r.p95LatencyMs : null
      const pHrt = num(r.healthyRuntimeCount) ? r.healthyRuntimeCount : null
      const pRt = num(r.runtimeCount) ? r.runtimeCount : null
      return `<tr class="mon-project">
        <td style="padding-left:2em">${esc(r.projectId ?? "—")}</td>
        <td>${fmtCount(pInv)}</td>
        <td>${errorRateBadge(pInv, pErr)}</td>
        <td>${fmtLatency(pAvg)}</td>
        <td>${fmtLatency(pP95)}</td>
        <td>${pHrt !== null ? fmtCount(pHrt) + " / " + fmtCount(pRt) : "—"}</td>
      </tr>`
    }).join("")

    return `<tr class="mon-domain">
      <td><b>${esc(d.domainId)}</b><span class="cv-sub">${d.rows.length} project${d.rows.length === 1 ? "" : "s"}</span></td>
      <td>${domainInvStr}</td>
      <td>${domainBadge}</td>
      <td>${domainAvgStr}</td>
      <td>${domainP95Str}</td>
      <td>${domainRtStr}</td>
    </tr>${projectRows}`
  }).join("")

  return `<section class="card" data-platform-monitoring>
    <style>
      [data-platform-monitoring] td,[data-platform-monitoring] th{vertical-align:middle}
      .mon-domain>td{font-weight:600;background:rgba(0,0,0,.03)}
      .mon-project>td:first-child{font-size:.9em}
    </style>
    <h2>Platform health by domain &amp; project</h2>
    ${windowLabel ? `<p class="cv-sub">${windowLabel}</p>` : ""}
    ${kpiRow}
    ${!anyInvocations ? `<p role="status">No invocations recorded in this window. The table below shows runtime counts even when there is no traffic.</p>` : ""}
    <div class="cv-scroll" tabindex="0" role="region" aria-label="Domain and project health">
    <table class="cv-table"><thead><tr>
      <th>Domain / project</th><th>Invocations</th><th>Error rate</th><th>Avg latency</th><th>p95 latency</th><th>Healthy runtimes</th>
    </tr></thead><tbody>
    ${tableRows}
    </tbody></table></div>
    <p class="cv-note">Aggregate telemetry only — per-agent traces stay in the owning project workspace and are not loaded here.</p>
  </section>`
}

// Admin two-page render: headline KPIs from the platform aggregate row,
// domain/project table from the groupBy=project breakdown.
function renderBreakdown(aggregatePage, breakdownPage) {
  const kpis = platformMonitoringKpis(aggregatePage)
  const grouped = platformMonitoringGrouped(breakdownPage)
  const anyInvocations = (kpis.totalInvocations ?? 0) > 0
    || grouped.some(d => (d.totalInvocations ?? 0) > 0)

  const windowLabel = aggregatePage.window
    ? `${esc(new Date(aggregatePage.window.startTime).toUTCString().slice(5, 22))} – ${esc(new Date(aggregatePage.window.endTime).toUTCString().slice(5, 22))} UTC`
    : ""

  const kpiRow = `<div class="cv-kpis">
    <p>Total invocations: <b>${fmtCount(kpis.totalInvocations)}</b></p>
    <p>Error rate: <b>${fmtPct(kpis.errorRatePct)}</b></p>
    <p>Avg latency: <b>${fmtLatency(kpis.avgLatencyMs)}</b></p>
    <p>p95 latency: <b>${fmtLatency(kpis.maxP95LatencyMs)}</b></p>
    <p>Healthy runtimes: <b>${kpis.healthyRuntimeCount !== null ? fmtCount(kpis.healthyRuntimeCount) + " / " + fmtCount(kpis.totalRuntimeCount) : "—"}</b></p>
  </div>`

  const tableRows = grouped.map(d => {
    const domainRtStr = d.healthyRuntimeCount !== null
      ? fmtCount(d.healthyRuntimeCount) + " / " + fmtCount(d.totalRuntimeCount) : "—"
    const projectRows = d.rows.map(r => {
      const pInv = num(r.invocationCount) ? r.invocationCount : null
      const pErr = num(r.errorCount) ? r.errorCount : null
      const pHrt = num(r.healthyRuntimeCount) ? r.healthyRuntimeCount : null
      const pRt = num(r.runtimeCount) ? r.runtimeCount : null
      const quiet = (pInv ?? 0) === 0
      return `<tr class="mon-project">
        <td style="padding-left:2em">${esc(r.projectId ?? "—")}${quiet ? `<span class="cv-sub">no traffic in window</span>` : ""}</td>
        <td>${fmtCount(pInv)}</td>
        <td>${errorRateBadge(pInv, pErr)}</td>
        <td>${fmtLatency(num(r.averageLatencyMs) ? r.averageLatencyMs : null)}</td>
        <td>${fmtLatency(num(r.p95LatencyMs) ? r.p95LatencyMs : null)}</td>
        <td>${pHrt !== null ? fmtCount(pHrt) + " / " + fmtCount(pRt) : "—"}</td>
      </tr>`
    }).join("")
    return `<tr class="mon-domain">
      <td><b>${esc(d.domainId)}</b><span class="cv-sub">${d.rows.length} project${d.rows.length === 1 ? "" : "s"}</span></td>
      <td>${fmtCount(d.totalInvocations)}</td>
      <td>${errorRateBadge(d.totalInvocations, d.totalErrors)}</td>
      <td>${fmtLatency(d.avgLatencyMs)}</td>
      <td>${fmtLatency(d.maxP95LatencyMs)}</td>
      <td>${domainRtStr}</td>
    </tr>${projectRows}`
  }).join("")

  return `<section class="card" data-platform-monitoring>
    <style>
      [data-platform-monitoring] td,[data-platform-monitoring] th{vertical-align:middle}
      .mon-domain>td{font-weight:600;background:rgba(0,0,0,.03)}
      .mon-project>td:first-child{font-size:.9em}
    </style>
    <h2>Platform health by domain &amp; project</h2>
    ${windowLabel ? `<p class="cv-sub">${windowLabel}</p>` : ""}
    ${kpiRow}
    ${anyInvocations ? "" : `<p role="status">No invocations recorded in this window — the structure below lists
      every domain and active project so you can see coverage; metrics fill in as agents run.</p>`}
    <div class="cv-scroll" tabindex="0" role="region" aria-label="Domain and project health">
    <table class="cv-table"><thead><tr>
      <th>Domain / project</th><th>Invocations</th><th>Error rate</th><th>Avg latency</th><th>p95 latency</th><th>Healthy runtimes</th>
    </tr></thead><tbody>
    ${tableRows}
    </tbody></table></div>
    <p class="cv-note">Aggregate telemetry only — per-agent traces stay in the owning project workspace and are not loaded here.</p>
  </section>`
}
