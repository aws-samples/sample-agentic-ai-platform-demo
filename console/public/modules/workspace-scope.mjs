// Hosted Operations exposes aggregate metrics only; no trace or per-agent API.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const metric = value => numeric(value) ? value.toLocaleString('en') : 'Unavailable'

// UI preference only. Revalidate against the current server-authorized inventory.
export function workspaceSelectionKey(profile) {
  const actor = profile?.actor || profile?.user
  const domain = profile?.role === 'admin' ? 'platform' : profile?.domain
  if (!actor || !domain || !['admin', 'lead', 'builder'].includes(profile?.role)) return null
  return 'console.workspace-selection:' + JSON.stringify([actor, profile.role, domain])
}
export function rememberWorkspaceSelection(storage, profile, project) {
  const key = workspaceSelectionKey(profile)
  if (!key) return
  try {
    if (!project) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify({domain: project.domain, id: project.id}))
  } catch { /* Storage is optional; selection still works for the current page. */ }
}
export function restoreWorkspaceSelection(storage, profile, projects) {
  const key = workspaceSelectionKey(profile)
  if (!key) return {project: null, stale: false}
  try {
    const raw = storage.getItem(key)
    if (!raw) return {project: null, stale: false}
    const saved = JSON.parse(raw)
    const domain = profile.role === 'admin' ? 'platform' : profile.domain
    const project = projects.find(p => p.domain === domain && p.domain === saved?.domain && p.id === saved?.id)
    if (project) return {project, stale: false}
    storage.removeItem(key)
    return {project: null, stale: true}
  } catch {
    try { storage.removeItem(key) } catch {}
    return {project: null, stale: true}
  }
}

// Only explicit denial invalidates a preference; HTTP 5xx is never loss of access.
export class WorkspaceProjectReadError extends Error {
  constructor(page) {
    const status = Number.isInteger(page?.status) ? page.status : null
    const code = typeof page?.code === 'string' ? page.code : null
    const denied = status === 403 || ((status === null || status < 400)
      && ['FORBIDDEN', 'NOT_AUTHORIZED', 'DEMO_ROLE_NOT_ALLOWED', 'DEMO_DOMAIN_REQUIRED', 'DEMO_DOMAIN_NOT_ALLOWED'].includes(code))
    super(denied ? 'Project access denied for this working context.'
      : 'Project list is unavailable. Retry when the service is available.')
    this.name = 'WorkspaceProjectReadError'
    this.status = status
    this.code = code
    this.accessDenied = denied
  }
}

// Read the raw project contract: compatibility adapters may discard schema errors.
export async function loadWorkspaceProjectPages(request) {
  const items = [], cursors = new Set(), identities = new Set()
  let cursor = null
  do {
    const page = await request('/projects?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    if (page?.ok !== true) {
      throw new WorkspaceProjectReadError(page)
    }
    if (page.resource !== 'projects' || !Array.isArray(page.items)) throw new Error('Project list response is invalid.')
    for (const project of page.items) {
      if (!project || typeof project.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(project.id)
        || typeof project.domainId !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(project.domainId)
        || typeof project.name !== 'string' || !project.name.trim()
        || !['ACTIVE', 'ARCHIVED'].includes(project.status)) throw new Error('Project list response is invalid.')
      const key = JSON.stringify([project.domainId, project.id])
      if (identities.has(key)) throw new Error('Project list contains duplicate identities.')
      identities.add(key)
      items.push(project)
    }
    cursor = page.cursor
    if (cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)
      || cursors.has(cursor) || cursors.size >= 100)) throw new Error('Project list pagination is invalid.')
    cursors.add(cursor)
  } while (cursor !== null)
  return items
}

export function projectAgents(response, { domainId, projectId }) {
  if (response?.ok !== true || !Array.isArray(response.items) || response.cursor !== null) {
    throw new Error('Project agents are unavailable.')
  }
  return response.items.filter(agent => agent.domainId === domainId && agent.projectId === projectId)
}

export async function loadOperationsPages(request, window, { groupBy } = {}) {
  const items = [], cursors = new Set(), identities = new Set()
  let first, cursor
  do {
    const page = await request('/operations?window=' + encodeURIComponent(window) + '&limit=50'
      + (groupBy ? '&groupBy=' + encodeURIComponent(groupBy) : '')
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    if (page?.ok !== true || page.resource !== 'operations' || !Array.isArray(page.items)
      || !['platform', 'domain', 'projects'].includes(page.scope?.type)
      || !Number.isFinite(Date.parse(page.window?.startTime))
      || !(Date.parse(page.window?.endTime) > Date.parse(page.window?.startTime))) {
      throw new Error('Operations are unavailable.')
    }
    first ||= page
    if (JSON.stringify(first.scope) !== JSON.stringify(page.scope)
      || JSON.stringify(first.window) !== JSON.stringify(page.window)) throw new Error('Operations scope changed.')
    const type = page.scope.type === 'projects' ? 'project' : page.scope.type
    for (const row of page.items) {
      if (row.scopeType !== type
        || (type === 'platform' && (row.domainId != null || row.projectId != null))
        || (type !== 'platform' && (typeof row.domainId !== 'string' || !row.domainId))
        || (type === 'domain' && (row.domainId !== page.scope.domainId || row.projectId != null))
        || (type === 'project' && (typeof row.projectId !== 'string' || !row.projectId))
        || (page.scope.domainId && row.domainId !== page.scope.domainId)) throw new Error('Operations scope mismatch.')
      const key = JSON.stringify([row.scopeType, row.domainId, row.projectId])
      if (identities.has(key)) throw new Error('Duplicate operations scope.')
      identities.add(key)
      items.push(row)
    }
    cursor = page.cursor
    if (cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)
      || cursors.has(cursor) || cursors.size >= 50)) throw new Error('Invalid operations pagination.')
    if (items.length > 500) throw new Error('Operations limit exceeded.')
    cursors.add(cursor)
  } while (cursor !== null)
  return { ...first, items, cursor: null }
}

export function operationsHtml(page, scope = {}) {
  let rows = page.items
  if (scope.projectId) {
    if (page.scope.type !== 'projects') return '<div class="empty">Project metrics are unavailable: the service returns aggregate telemetry for this role.</div>'
    rows = rows.filter(row => row.domainId === scope.domainId && row.projectId === scope.projectId)
  } else if (scope.domainId) {
    if (page.scope.type === 'platform') return '<div class="empty">Domain metrics are unavailable.</div>'
    rows = rows.filter(row => row.domainId === scope.domainId)
  }
  if (!rows.length) return '<div class="empty">No operational telemetry is available in this scope for the selected window.</div>'
  return `<p class="d">${esc(page.window.startTime)} – ${esc(page.window.endTime)} (UTC)</p>
    <div class="grid2">${rows.map(row => `<article class="card" data-operations-scope>
      <h2>${esc(row.scopeType === 'platform' ? 'Entire platform' : [row.domainId, row.projectId].filter(Boolean).join(' / '))}</h2>
      <div class="cv-kpis"><p>Healthy runtimes: <b>${metric(row.healthyRuntimeCount)} / ${metric(row.runtimeCount)}</b></p>
        <p>Requests: <b>${metric(row.invocationCount)}</b></p><p>Errors: <b>${metric(row.errorCount)}</b></p>
        <p>Average latency: <b>${metric(row.averageLatencyMs)}</b> ms</p><p>p95 latency: <b>${metric(row.p95LatencyMs)}</b> ms</p>
        <p>Input / output tokens: <b>${metric(row.inputTokens)} / ${metric(row.outputTokens)}</b></p></div>
    </article>`).join('')}</div><p class="d">Time-series and evaluation trends are unavailable from this aggregate telemetry service.</p>`
}
