// Display only. Call with a catalog accepted by validHostedGatewayCatalog and
// bound to the current read context. Native lifecycle/approval routing is separate.
export function isRegistryModelProjection(entry) {
  return entry?.type === 'Model' && entry._source === 'gateway'
}

export function registryModelIdentity(entry, entries = [entry]) {
  if (!isRegistryModelProjection(entry)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(entry.id || '')
    || entries.filter(row => row.id === entry.id).length !== 1) return null
  const versions = entry.versions || []
  const current = versions.filter(version => version.semver === entry.defaultVersion)
  // The inspected adapter uses entry.id == gatewayModelId. A runtime alias is
  // informational; never strip prefixes, use a display name, or guess a mapping.
  if (current.length !== 1 || !versions.every(version =>
    version.content?.gatewayModelId === entry.id
    && version.content?.source === 'agentcore-gateway')) return null
  const runtimeModelId = current[0].content.runtimeModelId
  if (typeof runtimeModelId !== 'string' || !runtimeModelId.trim()
    || runtimeModelId.trim() !== runtimeModelId) return null
  if (entry.resolved && (entry.resolved.content?.gatewayModelId !== entry.id
    || entry.resolved.content?.runtimeModelId !== runtimeModelId
    || entry.resolved.content?.source !== 'agentcore-gateway')) return null
  return { gatewayModelId: entry.id, runtimeModelId }
}

export function registryModelStatus(entry, { entries = [entry], catalog = null, domainId = null, role = '', state = 'unverified' } = {}) {
  if (!isRegistryModelProjection(entry)) return null
  const identity = registryModelIdentity(entry, entries)
  const matches = identity && catalog?.models?.filter(model => model.id === identity.gatewayModelId)
  const model = matches?.length === 1 ? matches[0] : null
  // accessByDomain is an explicit server projection, not catalog metadata or a
  // locally reconstructed allowedDomains policy. Public Lead/Builder data is redacted.
  const access = !domainId ? null
    : catalog?.domainId === domainId && ['lead', 'builder'].includes(role)
      ? model?.access || null
      : role === 'admin' && !Object.hasOwn(catalog || {}, 'domainId')
        ? model?.accessByDomain?.[domainId] || null
        : null
  const request = access?.latestRequest || null
  // AUD-003: a platform admin viewing "All inventory" (no domain selected)
  // must not have a model's platform-admission state (has PlatformAdmin ever
  // approved this model for any domain, and where) collapsed into the same
  // "Access unverified" bucket as "nobody has looked at this yet". This is a
  // separate, additive read of the same admin catalog projection already
  // fetched by the console (model.policy / model.accessByDomain) — it never
  // substitutes for a real scoped access decision and is only ever computed
  // from the exact-matched identity, the same identity gate `access` uses.
  const platformAdmission = !identity || role !== 'admin' || domainId || !catalog || state !== 'ready'
    || Object.hasOwn(catalog, 'domainId')
    ? null
    : (() => {
      const adminMatches = catalog?.models?.filter(row => row.id === identity.gatewayModelId)
      const adminModel = adminMatches?.length === 1 ? adminMatches[0] : null
      if (!adminModel || !Object.hasOwn(adminModel, 'accessByDomain')) return null
      const byDomain = adminModel.accessByDomain && typeof adminModel.accessByDomain === 'object'
        ? adminModel.accessByDomain : {}
      // AUD-003 follow-up: distinguish a confirmed "no policy at all"
      // (policy === null, the real DENIED-shape contract) from every other
      // unrecognized/missing applicationStatus, which must render as
      // Unknown rather than being silently treated as no policy. Evidence
      // for the PENDING / RECONCILIATION_FAILED applicationStatus values:
      // infra/serverless-platform model-governance-service contract tests.
      return {
        applicationStatus: adminModel.policy?.applicationStatus || null,
        policyConfirmedNull: Object.hasOwn(adminModel, 'policy') && adminModel.policy === null,
        grantedDomains: Object.keys(byDomain).filter(d => byDomain[d]?.status === 'ALLOWED'),
        requestableDomains: Object.keys(byDomain).filter(d => byDomain[d]?.status === 'REQUESTABLE'),
      }
    })()
  return {
    inventory: 'DISCOVERED',
    identity,
    access,
    platformAdmission,
    available: access?.usable === true,
    pending: request?.status === 'PENDING' && !!request.id && !!request.requestedAt,
    applicationStatus: access ? model?.policy?.applicationStatus || null : null,
    message: access ? ''
      : !identity ? 'Access unverified: model identity is ambiguous or incomplete.'
        : state === 'loading' ? 'Access unverified: checking current domain.'
          : state === 'unavailable' ? 'Access unverified: AI Gateway access data unavailable.'
            : !domainId ? 'Access unverified: no current domain selected.'
              : 'Access unverified: no access data returned for this model and domain.',
  }
}
