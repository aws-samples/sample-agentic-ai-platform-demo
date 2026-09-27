// workspace-tabs-view.mjs — pure rendering helpers for the four Build Workspace tabs.
// Each function returns an HTML string or a descriptor object; no DOM, no fetch.
// Import into app.mjs for call-site use; import into test file for unit tests.

const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ---------------------------------------------------------------------------
// Fleet tab
// ---------------------------------------------------------------------------

/**
 * Better empty-state for the Fleet tab when a project has no agents yet.
 * @param {string} projectName  Display name of the project.
 * @returns {string} HTML snippet (no outer wrapper — caller injects into body).
 */
export function fleetEmptyHtml(projectName) {
  return `<div class="empty" id="fleetonboard" style="text-align:center;padding:40px 20px" data-fleet-empty>
    <h3 style="margin:0 0 6px">No agents yet</h3>
    <p class="d" style="color:var(--dim);margin:0 auto 14px;max-width:360px">
      <b>${esc(projectName)}</b> has no agents. Use <em>Build Agent +</em> to create your first agent for this project.
    </p>
    <button class="primary" id="wsnewagent2">Build Agent +</button>
  </div>`
}

// ---------------------------------------------------------------------------
// Memory & KB tab
// ---------------------------------------------------------------------------

/**
 * Derives a human-friendly lifecycle label from an agent status value.
 * @param {string} status  Value from AGENT_STATUSES.
 * @returns {string}
 */
export function agentStatusLabel(status) {
  const labels = {
    DRAFT: 'Draft',
    READY_FOR_TEST: 'Ready for test',
    TEST_FAILED: 'Test failed',
    TESTED: 'Tested',
    SANDBOX_DEPLOYED: 'Sandbox deployed',
    PRODUCTION_PENDING: 'Pending production approval',
    PRODUCTION_APPROVED: 'Production approved',
    PRODUCTION_DEPLOYED: 'Production deployed',
    REJECTED: 'Rejected',
    RETIRED: 'Retired',
  }
  return labels[status] || esc(status || 'Unknown')
}

/**
 * Renders the Memory & KB tab for a project.
 *
 * Accepts two call shapes:
 *  1. New (preferred): data = {memories:[{name,strategies,live}], knowledgeBases:[{name,live}]}
 *     from /api/project-memories.  Detected when data is a plain object (not an array).
 *  2. Legacy: data = agents[]  from /api/agents (kept for backward compat).
 *
 * @param {Array|object} data
 * @param {string} projectName
 * @returns {string} HTML fragment.
 */
export function memoryKbTabHtml(data, projectName) {
  // New shape: plain object with memories/knowledgeBases arrays (or any non-array object)
  if (data && !Array.isArray(data)) {
    const { memories = [], knowledgeBases = [] } = data

    function statusBadge(live, resourceId) {
      // Local server nests live status ({live:{status}}); the hosted workspace
      // lambda returns it flat ({status}) — accept both.
      const status = live && typeof live === 'object' ? live.status : typeof live === 'string' ? live : null
      if (!status) return `<span class="chip" style="color:var(--muted);border-color:var(--muted);font-size:.72rem">${resourceId?'Status unavailable':'declared · not provisioned'}</span>`
      const ok = status === 'ACTIVE' || status === 'READY'
      return `<span class="chip" style="color:var(--${ok?'ok':'warn'});border-color:var(--${ok?'ok-bd':'warn'});font-size:.72rem">${esc(status)}</span>`
    }

    function strategyChips(strategies) {
      if (!strategies || !strategies.length) return ''
      return strategies.map(s => `<span class="chip" style="font-size:.72rem">${esc(s)}</span>`).join(' ')
    }

    const memSection = `<div class="sec-h" style="margin-top:0">Memory stores</div>` + (
      memories.length === 0
        ? `<div class="empty" data-mem-empty>No memory stores declared in this project's kit.</div>`
        : `<table><thead><tr><th>Name</th><th>Strategies</th><th>Status</th></tr></thead><tbody>
            ${memories.map(m => `<tr>
              <td><code style="font-size:.8rem">${esc(m.name)}</code></td>
              <td>${strategyChips(m.strategies)}</td>
              <td>${statusBadge(m.live ?? m.status, m.memoryId)}</td>
            </tr>`).join('')}
          </tbody></table>`
    )

    const kbSection = `<div class="sec-h">Knowledge bases</div>` + (
      knowledgeBases.length === 0
        ? `<div class="empty" data-kb-empty>No knowledge bases declared in this project's kit.</div>`
        : `<table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody>
            ${knowledgeBases.map(kb => `<tr>
              <td><code style="font-size:.8rem">${esc(kb.name)}</code></td>
              <td>${statusBadge(kb.live ?? kb.status, kb.knowledgeBaseId)}</td>
            </tr>`).join('')}
          </tbody></table>`
    )

    return `<div class="card">${memSection}${kbSection}</div>`
  }

  // Legacy shape: agents array from /api/agents
  const agents = Array.isArray(data) ? data : []
  const agentsWithMemory = agents.filter(a =>
    Array.isArray(a.memoryIds) && a.memoryIds.length > 0)
  const agentsWithKb = agents.filter(a =>
    Array.isArray(a.knowledgeBaseIds) && a.knowledgeBaseIds.length > 0)

  const allMemoryIds = [...new Set(agentsWithMemory.flatMap(a => a.memoryIds))]
  const allKbIds = [...new Set(agentsWithKb.flatMap(a => a.knowledgeBaseIds))]

  const noAgents = agents.length === 0

  // Memory section
  const memorySection = `<div class="card" data-memorykb-section="memory">
    <div class="sec-h" style="margin-top:0">Memory stores
      <span class="chip" style="color:var(--lock);border-color:var(--lock-bd)">content grant-gated · PII risk</span>
    </div>
    <p class="d" style="font-size:.82rem;color:var(--dim);margin:0 0 10px">
      Memory stores hold conversation context and facts that agents retain across sessions.
      Content access is grant-gated and audited.
    </p>
    ${noAgents
      ? '<div class="empty" data-mem-empty>No agents in this project — memory stores appear here once an agent is built.</div>'
      : allMemoryIds.length === 0
        ? `<div class="empty" data-mem-empty>No memory stores are configured for ${esc(projectName)}'s agents yet.
            Configure memory in the agent build form.</div>`
        : `<div class="d" style="font-size:.8rem;color:var(--muted);margin-bottom:8px">
            ${allMemoryIds.length} configured store ID${allMemoryIds.length === 1 ? '' : 's'} across
            ${agentsWithMemory.length} agent${agentsWithMemory.length === 1 ? '' : 's'} —
            store content is unavailable (grant required).
           </div>
           <table data-mem-table><thead><tr><th>Agent</th><th>Status</th><th>Memory store IDs</th></tr></thead>
           <tbody>${agentsWithMemory.map(a => `<tr>
             <td><b>${esc(a.name || a.id)}</b></td>
             <td><span class="chip">${agentStatusLabel(a.status)}</span></td>
             <td style="font-size:.76rem">${a.memoryIds.map(id =>
               `<code class="chip">${esc(id)}</code>`).join(' ')}</td>
           </tr>`).join('')}</tbody></table>`}
  </div>`

  // Knowledge Base section
  const kbSection = `<div class="card" data-memorykb-section="kb">
    <div class="sec-h" style="margin-top:0">Knowledge bases
      <span class="chip" style="color:var(--ok);border-color:var(--ok-bd)">visible to project members</span>
    </div>
    <p class="d" style="font-size:.82rem;color:var(--dim);margin:0 0 10px">
      Knowledge bases provide documents and structured data that agents query at runtime.
      Contents are pre-reviewed and visible to project team members.
    </p>
    ${noAgents
      ? '<div class="empty" data-kb-empty>No agents in this project — knowledge base connections appear here once an agent is built.</div>'
      : allKbIds.length === 0
        ? `<div class="empty" data-kb-empty>No knowledge bases are configured for ${esc(projectName)}'s agents yet.
            Configure a knowledge base in the agent build form.</div>`
        : `<div class="d" style="font-size:.8rem;color:var(--muted);margin-bottom:8px">
            ${allKbIds.length} configured KB ID${allKbIds.length === 1 ? '' : 's'} across
            ${agentsWithKb.length} agent${agentsWithKb.length === 1 ? '' : 's'}.
           </div>
           <table data-kb-table><thead><tr><th>Agent</th><th>Status</th><th>Knowledge base IDs</th></tr></thead>
           <tbody>${agentsWithKb.map(a => `<tr>
             <td><b>${esc(a.name || a.id)}</b></td>
             <td><span class="chip">${agentStatusLabel(a.status)}</span></td>
             <td style="font-size:.76rem">${a.knowledgeBaseIds.map(id =>
               `<code class="chip">${esc(id)}</code>`).join(' ')}</td>
           </tr>`).join('')}</tbody></table>`}
  </div>`

  const noDataNote = (noAgents || (allMemoryIds.length === 0 && allKbIds.length === 0))
    ? ''
    : `<p class="d" style="color:var(--muted);font-size:.72rem;margin-top:4px">
         Store and document content (names, sizes, record counts) are not exposed
         by the current API. IDs shown are from agent build configuration.
       </p>`

  return memorySection + kbSection + noDataNote
}

// ---------------------------------------------------------------------------
// Cost tab — project-scoped heading
// ---------------------------------------------------------------------------

/**
 * Returns the inner HTML for the loadHostedProjectBudget heading area.
 * Makes the heading obviously project-scoped by including the project name.
 *
 * @param {string} projectName  Human-readable project name (e.g. "Case Assist").
 * @param {string} domainId     Domain identifier (e.g. "customer_support").
 * @param {string} projectId    Project slug (e.g. "case-assist").
 * @returns {string} HTML for the heading row only.
 */
export function costTabHeadingHtml(projectName, domainId, projectId) {
  const title = `Project cost · ${esc(projectName)}`
  const sub = `${esc(domainId)} / ${esc(projectId)}`
  return `<div class="bar" style="align-items:flex-start;flex-wrap:wrap;gap:4px 12px;margin-bottom:12px">
    <div>
      <h2 style="margin:0 0 2px" data-cost-project-heading>${title}</h2>
      <p class="d" style="margin:0;font-size:.8rem;color:var(--muted)">${sub}</p>
    </div>
  </div>`
}

// ---------------------------------------------------------------------------
// Observability tab — project-scoped status cards
// ---------------------------------------------------------------------------

/**
 * Renders an informative panel when platform-aggregate operations telemetry is
 * returned but no project-level breakdown is available.  This is the honest
 * state for the current deployment where /api/operations returns scope.type
 * === 'platform' rather than 'projects'.
 *
 * @param {string} domainId    Project's domain.
 * @param {string} projectId   Project slug.
 * @param {string} projectName Human-readable project name.
 * @param {Array}  agents      Agent records for this project (may be empty).
 * @param {string} window      Time window label (e.g. '24h').
 * @returns {string} HTML fragment.
 */
export function obsProjectUnavailableHtml(domainId, projectId, projectName, agents, window) {
  const agentCount = agents.length

  const agentList = agentCount === 0
    ? `<p class="d" style="color:var(--dim);font-size:.82rem">No agents are deployed in this project yet.
        Metrics appear here once agents are running.</p>`
    : `<p class="d" style="font-size:.82rem;color:var(--dim)">
        ${agentCount} agent${agentCount === 1 ? '' : 's'} in this project:
      </p>
      <div class="meta" style="flex-wrap:wrap;gap:6px;margin-top:4px">
        ${agents.map(a => `<span class="chip" data-obs-agent="${esc(a.id)}">${esc(a.name || a.id)}
          <span style="color:var(--muted)"> · ${agentStatusLabel(a.status)}</span>
        </span>`).join('')}
      </div>`

  return `<div class="card" data-obs-unavailable>
    <div class="sec-h" style="margin-top:0">Project operational telemetry</div>
    <p class="d" style="font-size:.85rem;color:var(--dim)">
      Per-project metrics for <b>${esc(projectName)}</b>
      (<code>${esc(domainId)} / ${esc(projectId)}</code>) are not available
      for the selected window (<b>${esc(window)}</b>).
      The telemetry service returns a platform-level aggregate for this scope.
    </p>
    ${agentList}
    <p class="d" style="font-size:.76rem;color:var(--muted);margin-top:12px">
      Per-project request counts, latency, and error rates become available
      once agents are deployed and handling traffic.
      Use the Traces tab to inspect individual agent runs.
    </p>
  </div>`
}
