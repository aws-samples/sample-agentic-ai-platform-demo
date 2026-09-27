// Platform-level AWS billing panel (admin Cost Management page).
//
// Renders GET /api/platform-costs — the Cost Explorer view of the account.
// The bill is split into two groups: services the agent platform actually
// runs on (model inference, runtime, state, delivery, identity, telemetry)
// and everything else in the account, which is collapsed by default so the
// platform picture is not buried under unrelated workloads. Grouping is a
// display concern only — totals always cover the whole account so nothing
// is silently hidden.
const esc = value => String(value ?? "N/A").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]))
const money = value => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? `$${value.toFixed(2)}` : "N/A"

// What each service does FOR THE PLATFORM, so the bill reads as an agent
// platform report instead of a raw AWS service list.
const PLATFORM_SERVICES = [
  { match: /bedrock/i, label: "Model inference & AgentCore runtime (agents, memory, gateways)" },
  { match: /dynamodb/i, label: "Platform state (projects, agents, budgets, invocation journal)" },
  { match: /lambda/i, label: "Platform APIs (governance, workspace, operations, cost)" },
  { match: /cloudfront/i, label: "Console delivery (this web app)" },
  { match: /simple storage|^s3$/i, label: "Console assets & deployment artifacts" },
  { match: /cognito/i, label: "Sign-in & user management" },
  { match: /api gateway/i, label: "API routing & authorization" },
  { match: /cloudwatch/i, label: "Monitoring, alarms & logs" },
  { match: /secrets manager/i, label: "Runtime credentials" },
  { match: /x-ray/i, label: "Request tracing" },
  { match: /container registry|ecr/i, label: "Agent container images" },
  { match: /key management/i, label: "Encryption keys" },
  { match: /cost explorer/i, label: "This cost report" },
]

function platformRole(service) {
  return PLATFORM_SERVICES.find(entry => entry.match.test(service))?.label ?? null
}

function validWindow(window) {
  return window && typeof window === "object"
    && typeof window.startDate === "string" && typeof window.endDate === "string"
    && typeof window.totalUsd === "number" && Number.isFinite(window.totalUsd)
    && typeof window.otherUsd === "number" && Number.isFinite(window.otherUsd)
    && typeof window.estimated === "boolean"
    && Array.isArray(window.services) && window.services.length <= 25
    && window.services.every(entry => entry && typeof entry.service === "string"
      && entry.service.length > 0 && entry.service.length <= 200
      && typeof entry.amountUsd === "number" && Number.isFinite(entry.amountUsd))
}

export function validatePlatformBilling(response) {
  const billing = response?.billing
  if (response?.ok !== true || response.resource !== "platform-costs"
    || !billing || billing.source !== "aws-cost-explorer"
    || billing.currency !== "USD" || billing.granularity !== "service"
    || !validWindow(billing.monthToDate) || !validWindow(billing.previousMonth)) {
    throw new Error("Platform billing data is unavailable.")
  }
  return billing
}

function splitRows(current, previous) {
  const previousByService = new Map(previous.services.map(entry => [entry.service, entry.amountUsd]))
  const platform = []
  const unrelated = []
  for (const entry of current.services) {
    const role = platformRole(entry.service)
    const row = {
      service: entry.service,
      role,
      currentUsd: entry.amountUsd,
      previousUsd: previousByService.get(entry.service) ?? null,
    }
    ;(role ? platform : unrelated).push(row)
  }
  // Previous-month platform services with no spend yet this month still
  // belong in the platform group (e.g. Bedrock idle so far this month).
  for (const entry of previous.services) {
    if (current.services.some(row => row.service === entry.service)) continue
    const role = platformRole(entry.service)
    if (role) platform.push({ service: entry.service, role, currentUsd: 0, previousUsd: entry.amountUsd })
  }
  if (current.otherUsd > 0) {
    unrelated.push({ service: "Other services", role: null, currentUsd: current.otherUsd,
      previousUsd: previous.otherUsd > 0 ? previous.otherUsd : null })
  }
  return { platform, unrelated }
}

const rowsHtml = rows => rows.map(row =>
  `<tr><td>${esc(row.service)}${row.role ? `<span class="cv-sub">${esc(row.role)}</span>` : ""}</td>
   <td>${money(row.currentUsd)}</td><td>${money(row.previousUsd)}</td></tr>`).join("")

export function platformBillingHtml(billing) {
  const { platform, unrelated } = splitRows(billing.monthToDate, billing.previousMonth)
  const platformMtd = platform.reduce((sum, row) => sum + row.currentUsd, 0)
  const unrelatedMtd = billing.monthToDate.totalUsd - platformMtd
  return `<section class="card cv-summary" data-platform-billing>
    <h2>Platform infrastructure bill</h2>
    <p>Real AWS charges for the services this platform runs on — model inference, agent runtime & memory,
      state, APIs, console delivery and identity. Source: AWS Cost Explorer (data is ~24h behind; the
      current month is a running partial total).</p>
    <div class="cv-kpis">
      <p>Platform services, month to date: <b>${money(platformMtd)}</b> <span class="cv-sub">${esc(billing.monthToDate.startDate)} → ${esc(billing.monthToDate.endDate)}</span></p>
      <p>Whole account, month to date: <b>${money(billing.monthToDate.totalUsd)}</b> <span class="cv-sub">previous month ${money(billing.previousMonth.totalUsd)}</span></p>
    </div>
    <div class="cv-scroll" tabindex="0" role="region" aria-label="Platform service costs">
    <table class="cv-table"><thead><tr><th>Service · role in this platform</th><th>Month to date</th><th>Previous month</th></tr></thead>
    <tbody>${rowsHtml(platform)}</tbody>
    </table></div>
    ${platform.length ? "" : "<p>No platform-service charges recorded yet this month.</p>"}
    ${unrelated.length ? `<details class="cv-method"><summary>Other services in this AWS account (${money(unrelatedMtd)} MTD — not part of this platform)</summary>
      <div class="cv-scroll" tabindex="0" role="region" aria-label="Non-platform service costs">
      <table class="cv-table"><thead><tr><th>Service</th><th>Month to date</th><th>Previous month</th></tr></thead>
      <tbody>${rowsHtml(unrelated)}</tbody></table></div>
      <p class="cv-note">This account also hosts workloads unrelated to the agent platform; they are listed
        here so the account total above stays honest, but they are not platform costs.</p></details>` : ""}
    <p class="cv-note">The AWS bill covers shared infrastructure and cannot be split per domain — the runtime
      is one shared deployment. The domain and project breakdown below attributes <i>model usage</i> to teams;
      the two views complement each other and are never summed.</p>
  </section>`
}

// CSV export for platform reporting: one file combining the AWS bill and the
// journal-attributed domain/project estimates, each row labelled by layer.
export function platformCostReportCsv(billing, attributedPage) {
  const lines = [["layer", "scope", "service_or_project", "window", "amount_usd", "basis"]]
  for (const [label, window] of [["month_to_date", billing.monthToDate], ["previous_month", billing.previousMonth]]) {
    for (const entry of window.services) {
      lines.push(["aws-bill", "account", entry.service, label, entry.amountUsd.toFixed(6), "unblended-cost"])
    }
    if (window.otherUsd > 0) lines.push(["aws-bill", "account", "Other services", label, window.otherUsd.toFixed(6), "unblended-cost"])
  }
  if (attributedPage && Array.isArray(attributedPage.items)) {
    const window = `${attributedPage.window.startTime}/${attributedPage.window.endTime}`
    for (const item of attributedPage.items) {
      const scope = item.projectId ? `${item.domainId}/${item.projectId}` : item.domainId ?? "platform"
      const amount = typeof item.estimatedCostUsd === "number" && Number.isFinite(item.estimatedCostUsd)
        ? item.estimatedCostUsd.toFixed(6) : ""
      lines.push(["attributed-model-estimate", item.scopeType, scope, window, amount, "journal-estimate"])
    }
  }
  return lines.map(fields => fields.map(field => {
    const value = String(field)
    return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
  }).join(",")).join("\n") + "\n"
}
