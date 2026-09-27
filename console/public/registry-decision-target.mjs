// Routing is not authorization. Match the native writer's allowlist and
// identity shapes; discovery projections must never target that writer.
// MCPServer is decidable only on the agentcore-registry native path (below);
// gateway-sourced MCP/Model remain policy-governed and are never native.
const nativeTypes = new Set(['A2AAgent', 'Agent', 'Blueprint', 'MCPServer', 'Skill'])
export function nativeRegistryIdentity(entry, version) {
  const aws = version?._aws
  if (entry?._source !== 'agentcore-registry' || !nativeTypes.has(entry.type)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(entry.id || '')
    || !/^[A-Za-z0-9]{12,16}$/.test(aws?.registryId || '')
    || !/^[A-Za-z0-9]{12}$/.test(aws?.recordId || '')
    || (entry._registryId && entry._registryId !== aws.registryId)
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version.semver || '')) return null
  return `${aws.registryId}/${aws.recordId}`
}
export function registryDecisionTarget(entry, version, hosted) {
  if (version?.status !== 'IN_REVIEW') return null
  if (!hosted) return 'registry'
  if (entry?._source === 'gateway') {
    if (entry.type === 'Model') return 'model-policy'
    if (entry.type === 'MCPServer') return 'tool-policy'
    return null
  }
  if (!nativeRegistryIdentity(entry, version) || version._aws.awsStatus !== 'PENDING_APPROVAL') return null
  if (entry.type === 'Agent' || version._governed === true) return 'publication'
  // Native Skill/Blueprint/A2AAgent and agentcore-registry MCPServer records in
  // platform/shared domains are decidable in-queue by a capability-holding
  // platform/shared-domain admin (server re-authorizes every decision).
  return ['platform', 'shared'].includes(entry.domain) ? 'registry' : null
}
export function registryDecisionAllowed(entry, version, { hosted, canDecide, actor, approvalId = '' } = {}) {
  if (!canDecide) return false
  const target = registryDecisionTarget(entry, version, hosted)
  if (target === 'registry') return !approvalId
  const approval = version?._approval
  return target === 'publication' && typeof actor === 'string' && !!actor
    && typeof approval?.requesterSubject === 'string' && !!approval.requesterSubject
    && approval.requesterSubject !== actor && approval.status === 'PENDING'
    && approval.kind === 'RESOURCE_PUBLICATION' && approval.resourceType === ({Agent:'AGENT',A2AAgent:'AGENT',Skill:'SKILL',MCPServer:'MCP_SERVER',Blueprint:'BLUEPRINT'})[entry.type]
    && typeof approval.id === 'string' && !!approval.id && approval.id === approvalId
    && approval.resourceId === nativeRegistryIdentity(entry, version)
}
export function sameRegistryDecisionRecord(entry, version, currentEntry, currentVersion, hosted) {
  return entry?.id === currentEntry?.id && entry?.type === currentEntry?.type
    && entry?._source === currentEntry?._source && version?.semver === currentVersion?.semver
    && registryDecisionTarget(entry, version, hosted) === registryDecisionTarget(currentEntry, currentVersion, hosted)
    && (!hosted || (!!nativeRegistryIdentity(entry, version)
      && nativeRegistryIdentity(entry, version) === nativeRegistryIdentity(currentEntry, currentVersion)))
}
