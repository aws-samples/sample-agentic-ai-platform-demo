// Platform-admin cost rollup: domains at the top, projects under each.
//
// Consumes the same GET /api/costs?groupBy=project page the detailed table
// uses — one item per ACTIVE project with journal-attributed model cost and
// the project's monthly budget — and presents it the way a platform team
// reads it: which domain is spending, against what budget, drill to the
// projects. Numbers come straight from the page; when usage is unknown the
// rollup shows $0.00 with an explicit "no recorded usage" note instead of
// spraying "unknown" through every cell.
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]))
const money = value => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? `$${value >= 100 ? value.toFixed(2) : value.toFixed(value >= 0.01 || value === 0 ? 2 : 4)}` : "—"
const count = value => Number.isSafeInteger(value) && value >= 0

function projectRow(item) {
  const cost = typeof item.estimatedCostUsd === "number" && Number.isFinite(item.estimatedCostUsd)
    ? item.estimatedCostUsd : 0
  const budget = item.projectBudget && typeof item.projectBudget.monthlyLimitUsd === "number"
    ? item.projectBudget.monthlyLimitUsd : null
  return {
    domainId: item.domainId,
    projectId: item.projectId,
    costUsd: cost,
    hasUsage: cost > 0 || count(item.runCount) && item.runCount > 0
      || count(item.inputTokens) && item.inputTokens > 0,
    runs: count(item.runCount) ? item.runCount : null,
    tokensIn: count(item.inputTokens) ? item.inputTokens : null,
    tokensOut: count(item.outputTokens) ? item.outputTokens : null,
    budgetUsd: budget,
    thresholdPercent: item.projectBudget?.thresholdPercent ?? null,
  }
}

// page: a validated, complete (cursor === null) /api/costs groupBy=project page.
export function platformCostRollup(page) {
  if (page?.ok !== true || !Array.isArray(page.items) || page.cursor !== null) {
    throw new Error("A complete project cost page is required.")
  }
  const projects = page.items
    .filter(item => item.scopeType === "project")
    .map(projectRow)
  const domains = new Map()
  for (const project of projects) {
    if (!domains.has(project.domainId)) {
      domains.set(project.domainId, {
        domainId: project.domainId, projects: [], costUsd: 0, budgetUsd: 0, budgetedProjects: 0,
      })
    }
    const domain = domains.get(project.domainId)
    domain.projects.push(project)
    domain.costUsd += project.costUsd
    if (project.budgetUsd !== null) {
      domain.budgetUsd += project.budgetUsd
      domain.budgetedProjects += 1
    }
  }
  const list = [...domains.values()].sort((a, b) => b.costUsd - a.costUsd || a.domainId.localeCompare(b.domainId))
  for (const domain of list) {
    domain.projects.sort((a, b) => b.costUsd - a.costUsd || a.projectId.localeCompare(b.projectId))
  }
  return {
    window: page.window,
    totalCostUsd: projects.reduce((sum, project) => sum + project.costUsd, 0),
    totalBudgetUsd: list.reduce((sum, domain) => sum + domain.budgetUsd, 0),
    domains: list,
  }
}

function utilizationBar(costUsd, budgetUsd) {
  if (budgetUsd === null || budgetUsd <= 0) return `<span class="cv-sub">no budget set</span>`
  const percent = Math.min(100, (costUsd / budgetUsd) * 100)
  const state = percent >= 100 ? "over" : percent >= 80 ? "warn" : "ok"
  return `<div class="cost-bar" data-state="${state}" title="${percent.toFixed(1)}% of monthly budget">
    <div class="cost-bar-fill" style="width:${percent.toFixed(1)}%"></div>
  </div><span class="cv-sub">${percent.toFixed(1)}% of ${money(budgetUsd)}</span>`
}

export function platformCostRollupHtml(rollup) {
  const anyUsage = rollup.domains.some(domain => domain.projects.some(project => project.hasUsage))
  return `<section class="card cv-summary" data-cost-rollup>
    <style>
      .cost-bar{height:8px;border-radius:4px;background:rgba(128,128,128,.25);overflow:hidden;min-width:120px}
      .cost-bar-fill{height:100%;border-radius:4px;background:#2e7d32}
      .cost-bar[data-state=warn] .cost-bar-fill{background:#ed6c02}
      .cost-bar[data-state=over] .cost-bar-fill{background:#d32f2f}
      [data-cost-rollup] td,[data-cost-rollup] th{vertical-align:middle}
      .rollup-domain>td{font-weight:600}
      .rollup-project>td:first-child{padding-left:2em}
    </style>
    <h2>Cost by domain &amp; project</h2>
    <p>Model usage attributed to each team from the invocation journal (window:
      ${esc(new Date(rollup.window.startTime).toUTCString().slice(5, 22))} – ${esc(new Date(rollup.window.endTime).toUTCString().slice(5, 22))} UTC),
      with each domain's budget rolled up from its project budgets.</p>
    <div class="cv-kpis">
      <p>Attributed model spend: <b>${money(rollup.totalCostUsd)}</b></p>
      <p>Monthly budgets (all projects): <b>${money(rollup.totalBudgetUsd)}</b></p>
      <p>Domains: <b>${rollup.domains.length}</b> · Projects: <b>${rollup.domains.reduce((sum, domain) => sum + domain.projects.length, 0)}</b></p>
    </div>
    ${anyUsage ? "" : `<p role="status">No agent runs recorded in this window yet — every project shows $0.00.
      Costs appear here automatically as soon as agents are invoked.</p>`}
    <div class="cv-scroll" tabindex="0" role="region" aria-label="Domain and project costs">
    <table class="cv-table"><thead><tr>
      <th>Domain / project</th><th>Model spend</th><th>Runs</th><th>Tokens in / out</th><th>Monthly budget</th><th>Budget used</th>
    </tr></thead><tbody>
    ${rollup.domains.map(domain => `
      <tr class="rollup-domain"><td>${esc(domain.domainId)}<span class="cv-sub">${domain.projects.length} project${domain.projects.length === 1 ? "" : "s"}</span></td>
        <td>${money(domain.costUsd)}</td><td></td><td></td>
        <td>${domain.budgetedProjects ? money(domain.budgetUsd) : `<span class="cv-sub">none set</span>`}</td>
        <td>${utilizationBar(domain.costUsd, domain.budgetedProjects ? domain.budgetUsd : null)}</td></tr>
      ${domain.projects.map(project => `
      <tr class="rollup-project"><td>${esc(project.projectId)}${project.hasUsage ? "" : `<span class="cv-sub">no recorded usage</span>`}</td>
        <td>${money(project.costUsd)}</td>
        <td>${project.runs ?? "—"}</td>
        <td>${project.tokensIn ?? "—"} / ${project.tokensOut ?? "—"}</td>
        <td>${project.budgetUsd === null ? `<span class="cv-sub">not set</span>` : money(project.budgetUsd)}${project.thresholdPercent ? `<span class="cv-sub">alert at ${project.thresholdPercent}%</span>` : ""}</td>
        <td>${utilizationBar(project.costUsd, project.budgetUsd)}
          <button type="button" class="ghost" data-project-budget-open data-domain="${esc(project.domainId)}" data-project="${esc(project.projectId)}">Details</button></td></tr>`).join("")}
    `).join("")}
    </tbody></table></div>
    ${rollup.domains.length ? "" : "<p>No active projects found.</p>"}
    <p class="cv-note">Model inference only — shared runtime, memory and infrastructure costs are in the
      platform bill above and cannot be attributed per team. Budgets alert at their threshold; they do not
      hard-stop spending.</p>
  </section>`
}
