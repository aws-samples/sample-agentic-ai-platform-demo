// Routing only: the caller and server still enforce identity, scope and reviewer.
const nativeAccessTypes = new Set(['AGENT', 'TOOL', 'MCP_SERVER', 'SKILL', 'BLUEPRINT']);
export function hostedApprovalRequest(data, decision, reason) {
  if (!['APPROVE', 'REJECT'].includes(decision) || typeof reason !== 'string' || !reason.trim()
    || typeof data?.approval !== 'string' || !data.approval) return null;
  const body = { approvalId: data.approval, decision, reason };
  if (data.kind === 'PRODUCTION_DEPLOYMENT') {
    if (data.resourceType !== 'DEPLOYMENT' || !data.domain || !data.project || !data.resource) return null;
    return { path: '/deployment-decisions', body: {
      domainId: data.domain, projectId: data.project, deploymentId: data.resource, ...body,
    } };
  }
  if (data.kind === 'RESOURCE_PUBLICATION') return nativeAccessTypes.has(data.resourceType)
    ? { path: '/governance/publication-decisions', body } : null;
  if (data.kind !== 'RESOURCE_ACCESS') return null;
  if (data.resourceType === 'MODEL') return { path: '/ai-gateway/model-access-decisions', body };
  return nativeAccessTypes.has(data.resourceType) ? { path: '/governance/access-decisions', body } : null;
}
