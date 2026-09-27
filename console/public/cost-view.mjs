// Ported from the fixed f043d4a cost contract; no client-side price inference.
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0
const count = value => Number.isSafeInteger(value) && value >= 0
const esc = value => String(value ?? "N/A").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]))
const metadata = value => esc(typeof value === "object" && value !== null ? JSON.stringify(value) : value)
const usd = value => number(value) ? `$${value > 0 && value < .000001 ? value.toPrecision(3) : value.toFixed(value >= .01 || value === 0 ? 2 : 6)}` : "N/A"
export const sumCostValues = (items, key, valid = number) => {
  if (!items.length || !items.every(item => valid(item[key]))) return null
  const total = items.reduce((value, item) => value + item[key], 0)
  return valid(total) ? total : null
}

export function validateCostRows(page) {
  if (page?.ok !== true || page.resource !== "costs" || !Array.isArray(page.items)
    || !["platform", "domain", "projects", "project"].includes(page.scope?.type)
    || typeof page.window?.startTime !== "string" || typeof page.window?.endTime !== "string"
    || !Number.isFinite(Date.parse(page.window.startTime)) || !Number.isFinite(Date.parse(page.window.endTime))
    || Date.parse(page.window.startTime) >= Date.parse(page.window.endTime)) {
    throw new Error("Cost scope or time window is unavailable.")
  }
  const type = page.scope.type === "projects" ? "project" : page.scope.type
  const seen = new Set()
  for (const item of page.items) {
    if (!item || item.scopeType !== type
      || (type !== "platform" && (typeof item.domainId !== "string" || !item.domainId))
      || (type === "project" && (typeof item.projectId !== "string" || !item.projectId))
      || (type === "platform" && (item.domainId != null || item.projectId != null))
      || (type === "domain" && item.projectId != null)
      || (page.scope.domainId && item.domainId !== page.scope.domainId)
      || (page.scope.projectId && item.projectId !== page.scope.projectId)) {
      throw new Error("Overlapping or mismatched cost scopes.")
    }
    const key = JSON.stringify([item.scopeType, item.domainId, item.projectId])
    if (seen.has(key)) throw new Error("Duplicate cost scope.")
    seen.add(key)
  }
  if (page.items.length > 500) throw new Error("Cost result exceeds the supported scope.")
  return page.items
}

export async function loadHostedCostPages(first, loadNext) {
  const items = []
  const cursors = new Set()
  let page = first
  while (true) {
    validateCostRows(page)
    if (JSON.stringify(page.scope) !== JSON.stringify(first.scope)
      || JSON.stringify(page.window) !== JSON.stringify(first.window)) {
      throw new Error("Cost scope or time window changed while loading.")
    }
    items.push(...page.items)
    validateCostRows({ ...first, items })
    if (page.cursor === null) return { ...first, items, cursor: null }
    if (typeof page.cursor !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(page.cursor)
      || cursors.has(page.cursor) || cursors.size >= 50) throw new Error("Invalid cost pagination.")
    cursors.add(page.cursor)
    page = await loadNext(page.cursor)
  }
}

export function costSummary(page) {
  const items = page?.items ?? []
  let complete = page?.ok === true && page.cursor === null
  try { validateCostRows(page) } catch { complete = false }
  const dollars = items.every(item => item.contractVersion === 1 && item.currency === "USD" && item.basis === "estimate")
  const native = items.length > 0 && items.every(item => item.contractVersion === 1
    && !(item.legacyRecordCount > 0) && item.source === "experience-invocation-journal"
    && item.environment === "PRODUCTION" && item.runBoundary === "runtime-durable-start"
    && item.windowBasis === "usage-occurrence-and-execution-start" && item.runCountUnavailableReason === null)
  const cost = complete && dollars && items.every(item => item.source !== "experience-invocation-journal" || item.modelCoverage === "complete")
    ? sumCostValues(items, "estimatedCostUsd") : null
  const runs = complete && native ? sumCostValues(items, "runCount", count) : null
  const ratio = runs > 0 && cost !== null ? cost / runs : null
  return {
    totalCostUsd: cost,
    runCount: runs,
    costPerRunUsd: number(ratio) ? ratio : null,
    acceptedDispatchCount: complete ? sumCostValues(items, "acceptedDispatchCount", count) : null,
  }
}

export function scopedCostPage(page, { domainId, projectId } = {}) {
  validateCostRows(page)
  if (page.cursor !== null) throw new Error("Cost pages are incomplete.")
  if (projectId && !domainId) throw new Error("Project cost requires domainId and projectId.")
  if (!domainId && !projectId) return page
  const type = page.scope.type === "projects" ? "project" : page.scope.type
  if (type === "platform" || (projectId && type !== "project")) {
    throw new Error("Cost data is unavailable for this project/domain: the API returned an aggregate scope.")
  }
  const items = page.items.filter(item => item.domainId === domainId && (!projectId || item.projectId === projectId))
  return { ...page, items, displayedScope: { domainId, projectId: projectId ?? null } }
}

export function attributedCostSummary(page) {
  validateCostRows(page)
  if (page.cursor !== null || !["projects", "project"].includes(page.scope.type)) {
    throw new Error("A complete project breakdown is required.")
  }
  const byDomain = new Map()
  for (const row of page.items) {
    if (!byDomain.has(row.domainId)) byDomain.set(row.domainId, [])
    byDomain.get(row.domainId).push(row)
  }
  return {
    attributedModelCostUsd: costSummary(page).totalCostUsd,
    unallocatedSharedPlatformCostUsd: null,
    fullPlatformCostUsd: null,
    domains: [...byDomain].map(([domainId, items]) => ({
      domainId, modelCostUsd: costSummary({ ...page, items }).totalCostUsd, projectCount: items.length,
    })),
  }
}

export function costFreshness(item, window) {
  const at = Date.parse(item.updatedAt)
  const end = Date.parse(window.endTime)
  if (!Number.isFinite(at) || at > end) return "unknown"
  return end - at > 15 * 60_000 ? "stale usage snapshot" : "recent update; completeness unverified"
}

function humanDate(value) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC"
}
function scopeLabel(page) {
  const scope = page.displayedScope ?? page.scope
  return scope.projectId ? `Project: ${scope.domainId} / ${scope.projectId}`
    : scope.domainId ? `Domain: ${scope.domainId}`
    : page.scope.type === "platform" ? "Platform" : "Authorized projects"
}
function costHierarchyHtml(page) {
  if (!["projects", "project"].includes(page.scope.type)) return ""
  const summary = attributedCostSummary(page)
  const level = page.displayedScope?.projectId ? "Project" : page.displayedScope?.domainId || page.scope.domainId ? "Domain" : "Platform"
  return `<section class="card cv-summary" data-cost-hierarchy>
    <h2>${level} cost summary</h2><p>${esc(scopeLabel(page))}</p>
    <div class="cv-kpis"><p>Attributed model estimate: <b>${usd(summary.attributedModelCostUsd)}</b> USD <span class="cv-sub">Partial coverage · excludes shared/runtime costs</span></p>
      <p>Unallocated shared/platform cost: <b>N/A</b></p><p>Full ${level.toLowerCase()} total: <b>N/A</b></p></div>
    ${level === "Platform" ? `<div class="cv-scroll" tabindex="0" role="region" aria-label="Domain cost summary"><table><thead><tr><th>Domain</th><th>Projects</th><th>Attributed model estimate USD</th></tr></thead><tbody>
      ${summary.domains.map(domain=>`<tr><td>${esc(domain.domainId)}</td><td>${domain.projectCount}</td><td>${usd(domain.modelCostUsd)}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    <p class="cv-note">Partial model costs only. Shared Runtime costs are excluded and are not added a second time.
      Account-wide Cost Explorer spend and forecast remain separate Admin context.</p>
  </section>`
}
function provenanceDetails(item, window) {
  return `<details class="cv-provenance"><summary>Provenance &amp; coverage</summary><dl>
    ${[
      ["Contract", item.contractVersion], ["Basis", item.basis], ["Currency", item.currency],
      ["Source", item.source], ["Environment", item.environment], ["Completeness", item.completeness],
      ["Window basis", item.windowBasis], ["Run boundary", item.runBoundary], ["Dispatch boundary", item.dispatchBoundary],
      ["Run unavailable reason", item.runCountUnavailableReason], ["Model coverage", item.modelCoverage],
      ["Coverage", item.coverage], ["Consistency", item.consistency],
      ["Price version", item.pricingVersion], ["Price revision", item.pricingRevision], ["Retained revisions", item.pricingRevisions],
      ["Price sources / effective intervals", item.priceSources], ["Last record update", item.updatedAt],
    ].map(([label, value])=>`<div><dt>${label}:</dt> <dd>${metadata(value)}</dd></div>`).join("")}
    <div><dt>Freshness:</dt> <dd>${esc(costFreshness(item, window))}</dd></div>
    <div><dt>Known native starts:</dt> <dd>${count(item.knownRunCount) && item.runBoundary === "runtime-durable-start" ? item.knownRunCount : "N/A"}</dd></div>
  </dl></details>`
}

export function hostedCostHtml(page) {
  validateCostRows(page)
  if (page.cursor !== null) throw new Error("Cost pages are incomplete.")
  const summary = costSummary(page)
  const knownSubtotal = page.items.every(item => item.contractVersion === 1 && item.currency === "USD" && item.basis === "estimate")
    ? sumCostValues(page.items, "knownEstimatedCostUsd") : null
  const journal = page.items.some(item => item.source === "experience-invocation-journal")
  return `${costHierarchyHtml(page)}<div class="card cv-summary" data-hosted-cost>
    <h2>Model inference estimate · partial project coverage</h2>
    <p>${esc(scopeLabel(page))} · ${esc(humanDate(page.window.startTime))} – ${esc(humanDate(page.window.endTime))}</p>
    <div class="cv-kpis"><p>Estimate: <b>${usd(summary.totalCostUsd)}</b></p><p>Started agent runs: <b>${summary.runCount ?? "N/A"}</b></p>
      <p>Cost per run: <b>${usd(summary.costPerRunUsd)}</b></p></div>
    <p class="cv-note">Known subtotal: ${usd(knownSubtotal)} (priced subset, not a full total).</p>
    <p class="cv-note">Runtime, Gateway, memory, tools, evaluation and shared costs are not covered; unobserved attempts are excluded.
      Missing usage and prices remain unknown. Token allowances are separate from USD budgets.</p>
    <details class="cv-method"><summary>Measurement, authorized scope &amp; window</summary>
      <p>${page.displayedScope ? `Displayed scope: ${metadata(page.displayedScope)} · Authorized aggregation: ${metadata(page.scope.type)}` : `Authorized scope: ${metadata(page.scope)}`}.</p>
      <p>${esc(page.window.startTime)} ≤ event time &lt; ${esc(page.window.endTime)} (UTC, half-open window).</p>
      <p>${summary.runCount === null
        ? "Actual agent execution-start evidence is unavailable; agent-run count and cost per run remain N/A."
        : "Agent runs use durable Runtime start evidence. Failures after start count; missing usage or pricing leaves costs incomplete."}</p>
      <p>Monthly budgets use the UTC calendar month. Remaining and monthly alert status require the project preview; no calendar projection is available.</p>
      ${journal ? `<p>Accepted dispatches (diagnostic): <b>${summary.acceptedDispatchCount ?? "N/A"}</b>.
        Dispatch acceptance is not an actual execution start. Production/user scope (purpose: user).
        The journal is eventually consistent, without snapshot isolation; updatedAt is not a completeness watermark.
        Retained provider usage includes failed runs; missing usage or prices leave full cost unknown.
        Native usage is counted at final provider observation time and starts independently in the same UTC window.
        Dispatch-start cohorts include later completions and are not calendar consumption.</p>` : ""}
    </details>
    <div class="cv-scroll" tabindex="0" role="region" aria-label="Cost and budget rows"><table class="cv-table"><thead><tr><th>Scope</th><th>Model estimate USD</th><th>Started runs</th><th>Tokens in / out</th><th>Monthly budget USD</th><th>Budget status</th><th>Action</th></tr></thead>
    <tbody>${page.items.map(item => {
      const itemSummary = costSummary({ ...page, items: [item] })
      const dollar = item.currency === "USD" && item.basis === "estimate" && item.contractVersion === 1
      const budget = item.projectBudget
      return `<tr><td>${esc(item.scopeType === "project" ? `${item.domainId} / ${item.projectId}` : item.domainId ?? "platform")}${provenanceDetails(item, page.window)}</td>
        <td>${usd(itemSummary.totalCostUsd)}<span class="cv-sub">Known subtotal: ${usd(dollar ? item.knownEstimatedCostUsd : null)}</span></td>
        <td>${itemSummary.runCount ?? "N/A"}</td>
        <td>${count(item.inputTokens) ? item.inputTokens : "N/A"} / ${count(item.outputTokens) ? item.outputTokens : "N/A"}</td>
        <td>${usd(dollar ? item.monthlyBudgetUsd : null)}${budget ? `<span class="cv-sub">Version ${esc(budget.version)} · threshold ${esc(budget.thresholdPercent)}%</span>` : ""}</td>
        <td>Remaining: unknown (partial coverage).<span class="cv-sub">${budget ? "Configured; open monthly threshold preview." : "Monthly alert status unavailable."}</span></td>
        <td>${item.scopeType === "project" && !page.displayedScope?.projectId ? `<button type="button" class="ghost" data-project-budget-open data-domain="${esc(item.domainId)}" data-project="${esc(item.projectId)}">Cost &amp; Budget</button>` : ""}</td></tr>`
    }).join("")}</tbody></table></div>
    ${page.items.length ? "" : "<p>No usage data is available for this scope and window; totals remain N/A.</p>"}
  </div><div data-cost-detail></div>`
}

// A project detail has one attributed total; platform/domain breakdowns stay above it.
export function projectCostHtml(page) {
  validateCostRows(page)
  const scope = page.displayedScope
  if (!scope?.domainId || !scope?.projectId || page.cursor !== null
    || !["project", "projects"].includes(page.scope.type)
    || page.items.some(item => item.scopeType !== "project" || item.domainId !== scope.domainId || item.projectId !== scope.projectId)) {
    throw new Error("An exact project cost scope is required.")
  }
  const summary = costSummary(page)
  const subtotal = page.items.every(item => item.contractVersion === 1 && item.currency === "USD" && item.basis === "estimate")
    ? sumCostValues(page.items, "knownEstimatedCostUsd") : null
  return `<section class="card cv-summary" data-hosted-cost data-project-cost>
    <h2>Project usage &amp; cost</h2><p>${esc(scopeLabel(page))}</p>
    <p>${esc(humanDate(page.window.startTime))} – ${esc(humanDate(page.window.endTime))}</p>
    <div class="cv-kpis"><p>Estimate: <b>${usd(summary.totalCostUsd)}</b></p>
      <p>Started agent runs: <b>${summary.runCount ?? "N/A"}</b></p><p>Cost per run: <b>${usd(summary.costPerRunUsd)}</b></p></div>
    <p>Known subtotal: ${usd(subtotal)} (priced subset, not a full project total).</p>
    <p class="cv-note">Partial model inference coverage only. Runtime, Gateway, memory, tools, evaluation and shared costs are unavailable. Missing usage or prices remain unknown.</p>
    ${page.items.map(item => `<p>Input / output tokens: ${count(item.inputTokens) ? item.inputTokens : "N/A"} / ${count(item.outputTokens) ? item.outputTokens : "N/A"}.</p>${provenanceDetails(item, page.window)}`).join("")}
    ${page.items.length ? "" : "<p>No usage data is available for this project and window; totals remain N/A.</p>"}
    <p class="cv-note">Cost per run uses this project's attributed model cost divided by actual durable Runtime starts in the same UTC window. It is unavailable without both measurements. The monthly USD budget below is separate from this reporting window.</p>
  </section>`
}
