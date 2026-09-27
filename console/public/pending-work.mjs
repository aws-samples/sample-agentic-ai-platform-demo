// Read projection only: inventory is not a request; routing/authorization stays
// in the existing decision handlers. Registry record IDs identify a version.
// registry-decision-target.mjs's nativeRegistryIdentity also gates the native
// writer/decision allowlist (registryDecisionTarget), so it is deliberately
// restricted to the types that allowlist covers. Read-only inventory must
// recognize every valid native record shape, including types the writer never
// handles (e.g. MCPServer). This mirrors the same identity-shape checks
// without adopting the writer's type allowlist, and it is never passed to
// registryDecisionTarget/registryDecisionAllowed.
function nativeReadIdentity(entry, version) {
  const aws = version?._aws
  if (entry?._source !== 'agentcore-registry'
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(entry.id || '')
    || !/^[A-Za-z0-9]{12,16}$/.test(aws?.registryId || '')
    || !/^[A-Za-z0-9]{12}$/.test(aws?.recordId || '')
    || (entry._registryId && entry._registryId !== aws.registryId)
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version.semver || '')) return null
  return `${aws.registryId}/${aws.recordId}`
}
const text = value => typeof value === 'string' && !!value.trim()
const statuses = new Set(['DRAFT','IN_REVIEW','APPROVED','REJECTED','DEPRECATED'])
const approvalStatuses = new Set(['PENDING','APPROVED','REJECTED','CANCELLED'])
const resourceTypes = { Agent:'AGENT', A2AAgent:'AGENT', Skill:'SKILL', Blueprint:'BLUEPRINT', MCPServer:'MCP_SERVER' }
const unfinished = result => result?.incomplete === true || result?.partial === true || result?.complete === false
  || (result?.completeness && result.completeness !== 'complete')
  || !!result?.code || !!result?.error
  || (result?.errors != null && (Array.isArray(result.errors) ? result.errors.length > 0 : true))
  || !!result?.nextToken || !!result?.cursor
function submissionDate(value, now) {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const calendar = new Date(`${value.slice(0,10)}T00:00:00Z`)
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0,10) !== value.slice(0,10)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) && time <= now ? new Date(time).toISOString() : null
}
export function projectPendingWork({ registry, approvals, hitl, hosted = true, now = Date.now() }) {
  const problems = new Set(), native = new Map(), requests = new Map(), entries = []
  const issue = source => problems.add(`${source} pending work is unavailable or incomplete.`)
  const regOK = registry?.ok === true && Array.isArray(registry.entries)
    && (!hosted || registry.source === 'aws')
  if (!regOK || unfinished(registry)) issue('Registry')
  for (const entry of regOK ? registry.entries : []) {
    if (!entry || !text(entry.id) || !text(entry.type) || !Array.isArray(entry.versions)) { issue('Registry'); continue }
    // All Gateway projections are inventory, including non-model targets.
    if (entry._source === 'gateway') continue
    if (hosted && entry._source !== 'agentcore-registry') { issue('Registry'); continue }
    const versions = []
    for (const version of entry.versions) {
      const identity = hosted ? nativeReadIdentity(entry, version) : entry.id
      if (!version || !statuses.has(version.status) || !text(version.semver) || !identity) { issue('Registry'); continue }
      const key = JSON.stringify([identity, version.semver])
      const previous = native.get(key)
      if (previous) {
        if (JSON.stringify(previous.entry) !== JSON.stringify(entry) || JSON.stringify(previous.version) !== JSON.stringify(version)) issue('Registry')
        continue
      }
      if (hosted && version.status === 'IN_REVIEW' && version._aws.awsStatus !== 'PENDING_APPROVAL') { issue('Registry'); continue }
      const row = { kind:'registry', key, identity, entry, version,
        label:`${entry.name || entry.id} v${version.semver}`,
        // Native createdAt is version creation, not proof of submission.
        at:submissionDate(hosted ? version.submittedAt : version.submittedAt || version.createdAt, now) }
      native.set(key, row)
      versions.push(version)
    }
    if (versions.length) entries.push({ ...entry, versions })
  }
  const approvalsOK = approvals?.ok === true && Array.isArray(approvals.items)
    && (!hosted || (approvals.resource === 'approvals' && approvals.cursor === null))
  if (hosted && (!approvalsOK || unfinished(approvals))) issue('Hosted approvals')
  for (const approval of approvalsOK ? approvals.items : []) {
    if (!approval || !text(approval.id) || !text(approval.kind)
      || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(approval.domainId || '')
      || !text(approval.resourceType) || !text(approval.resourceId)
      || !text(approval.requesterSubject) || !approvalStatuses.has(approval.status)) { issue('Hosted approvals'); continue }
    const key = JSON.stringify([approval.domainId, approval.id])
    const prior = requests.get(key)
    if (prior) {
      if (JSON.stringify(prior.approval) !== JSON.stringify(approval)) issue('Hosted approvals')
      continue
    }
    requests.set(key, { kind:'approval', key, approval, label:approval.id, at:submissionDate(approval.requestedAt, now) })
  }
  const pendingApprovals = [...requests.values()].filter(row => row.approval.status === 'PENDING')
  const rows = [...native.values()].filter(row => {
    if (row.version.status !== 'IN_REVIEW') return false
    const sameRecord = [...native.values()].filter(other => other.identity === row.identity)
    if (hosted && sameRecord.length !== 1) { issue('Registry'); return true }
    // Explicit persisted publication linkage only. Access requests never absorb
    // native versions or each other; names/runtime aliases are never identities.
    return !pendingApprovals.some(({ approval }) => approval.kind === 'RESOURCE_PUBLICATION'
      && approval.resourceId === row.identity && approval.domainId === row.entry.domain
      && approval.resourceType === resourceTypes[row.entry.type])
  })
  rows.push(...pendingApprovals)
  if (!hosted) {
    if (hitl?.ok !== true || !Array.isArray(hitl.pending) || unfinished(hitl)) issue('Tool approvals')
    for (const pending of Array.isArray(hitl?.pending) ? hitl.pending : []) {
      if (!text(pending?.requestId) || !text(pending.toolName)) { issue('Tool approvals'); continue }
      rows.push({ kind:'hitl', key:pending.requestId, pending, label:pending.toolName, at:submissionDate(pending.requestedAt, now) })
    }
  }
  rows.sort((a,b) => (a.at || 'z').localeCompare(b.at || 'z') || a.key.localeCompare(b.key))
  const sources = {
    registry: { complete: ![...problems].some(problem => problem.startsWith('Registry ')) },
    approvals: { complete: ![...problems].some(problem => problem.startsWith('Hosted approvals ')) },
  }
  for (const row of rows) if (row.kind === 'registry') {
    row.requestLinkage = sources.approvals.complete ? 'absent' : 'unknown'
  }
  const complete = problems.size === 0
  const decisions = hosted ? rows.filter(row => row.kind !== 'registry') : rows
  return { rows, entries, sources, complete, count:complete ? decisions.length : null, knownCount:decisions.length,
    resourceReviewCount: rows.filter(row => row.kind === 'registry').length,
    oldest:decisions.find(row => row.at) || null, unknownDates:decisions.filter(row => !row.at).length,
    problems:[...problems] }
}
