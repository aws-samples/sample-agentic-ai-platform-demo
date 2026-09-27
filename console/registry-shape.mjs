// Registry statuses -> the legacy lifecycle statuses the frontend renders.
// PENDING_APPROVAL is the wire name for the legacy IN_REVIEW state.
const STATUS_TO_LEGACY = {
  CREATING: "DRAFT", DRAFT: "DRAFT", PENDING_APPROVAL: "IN_REVIEW",
  APPROVED: "APPROVED", REJECTED: "REJECTED", DEPRECATED: "DEPRECATED",
  CREATE_FAILED: "DRAFT", UPDATE_FAILED: "DRAFT", UPDATING: "DRAFT",
}
export const legacyStatus = s => STATUS_TO_LEGACY[s] || "DRAFT"

const GOVERNED_RECORD_VERSION_BUILD = "platform-descriptor.1"
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const AWS_RECORD_TYPES = new Set(["AGENT", "SKILL", "MCP", "CUSTOM"])
const governedVersionMarker = value => {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) return false
  const build = value.split("+", 2)[1]
  if (
    typeof build === "string"
    && build.split(".").slice(-2).join(".")
      === GOVERNED_RECORD_VERSION_BUILD
  ) {
    return true
  }
  const versionWithoutBuild = value.split("+", 1)[0]
  const prereleaseStart = versionWithoutBuild.indexOf("-")
  const prerelease = prereleaseStart === -1
    ? undefined
    : versionWithoutBuild.slice(prereleaseStart + 1)
  return typeof prerelease === "string"
    && prerelease.split(".").slice(-2).join(".")
      === GOVERNED_RECORD_VERSION_BUILD
}
const parseData = (raw, governedVersion) => {
  try {
    return JSON.parse(raw || "{}")
  } catch {
    if (governedVersion) governedDescriptorError()
    return {}
  }
}
const iso = d => (d instanceof Date ? d.toISOString() : d || null)
const normalizeRecordType = value => ({
  AGENT: "A2A",
  A2A: "A2A",
  SKILL: "AGENT_SKILLS",
  AGENT_SKILLS: "AGENT_SKILLS",
  CUSTOM: "CUSTOM",
}[value] || value)
export const descriptorTypeOf = record => {
  const hasRecordType =
    Object.hasOwn(record, "recordType")
    && record.recordType !== undefined
  const recordType = hasRecordType
    ? normalizeRecordType(record.recordType)
    : undefined
  if (
    Object.hasOwn(record, "descriptorType")
    && record.descriptorType !== undefined
  ) {
    const descriptorType = normalizeRecordType(record.descriptorType)
    if (hasRecordType && descriptorType !== recordType) {
      throw new Error("Registry record type is inconsistent.")
    }
    return descriptorType
  }
  return recordType
}
const descriptorJson = (...values) => values.find(v => typeof v === "string" && v.trim()) || "{}"
const identityPart = value => typeof value === "string" ? value.trim() : ""
const GOVERNED_X_PLATFORM_KEYS = [
  "domainId",
  "ownerSubject",
  "resourceId",
  "resourceType",
  "shared",
]
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const OWNER_SUBJECT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/
const RESOURCE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,255}$/

function governedDescriptorError() {
  throw new Error("Registry governed descriptor is malformed.")
}

const governedDescriptorParts = (
  value,
  expectedResourceType,
  governedVersion,
) => {
  const platform = value?.["x-platform"]
  const hasGovernedKey = platform
    && typeof platform === "object"
    && !Array.isArray(platform)
    && GOVERNED_X_PLATFORM_KEYS.some((key) =>
      Object.hasOwn(platform, key))
  if (!Object.hasOwn(value || {}, "schemaVersion")) {
    if (hasGovernedKey || governedVersion) governedDescriptorError()
    return {
      governed: false,
      platform: platform || {},
      metadata: platform || {},
    }
  }
  if (
    !governedVersion
    || value.schemaVersion !== 1
    || !platform
    || typeof platform !== "object"
    || Array.isArray(platform)
    || Object.keys(platform).sort().join("\u0000")
      !== [...GOVERNED_X_PLATFORM_KEYS].sort().join("\u0000")
    || !DOMAIN_ID_PATTERN.test(platform.domainId)
    || !OWNER_SUBJECT_PATTERN.test(platform.ownerSubject)
    || !RESOURCE_ID_PATTERN.test(platform.resourceId)
    || platform.resourceType !== expectedResourceType
    || typeof platform.shared !== "boolean"
  ) {
    governedDescriptorError()
  }
  const metadata = value["x-platform-metadata"]
  return {
    governed: true,
    platform,
    metadata:
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata
        : {},
  }
}

function requireUniqueIdentity(seen, parts, label) {
  const normalized = parts.map(identityPart)
  if (normalized.some(part => !part)) throw new Error(`${label} is missing.`)
  const key = normalized.join("/")
  if (seen.has(key)) throw new Error(`${label} is duplicated.`)
  seen.add(key)
  return key
}

export function assertUniqueEntryIds(entries) {
  const entryIds = new Set()
  for (const entry of entries) {
    requireUniqueIdentity(
      entryIds,
      [entry?.id],
      "Registry entry ID",
    )
  }
  return entries
}

// One registry record (control-plane Get shape, descriptors included) -> a
// legacy version object + the entry-level fields it implies. Descriptor
// synthesis on seed put platform metadata in an "x-platform" extension.
export function recordToVersion(record) {
  const governedVersion = governedVersionMarker(record.recordVersion)
  if (
    governedVersion
    && (
      !Object.hasOwn(record, "recordType")
      || record.recordType === undefined
      || !AWS_RECORD_TYPES.has(record.recordType)
    )
  ) {
    governedDescriptorError()
  }
  const type = descriptorTypeOf(record)
  const decided = ["APPROVED", "REJECTED"].includes(record.status)
  const base = {
    semver: record.recordVersion,
    status: legacyStatus(record.status),
    changelog: null, createdBy: null,
    createdAt: iso(record.createdAt),
    decidedBy: decided ? "registry" : null,
    decidedAt: decided ? iso(record.updatedAt) : null,
    autoChecks: [],
    statusReason: record.statusReason || null,
    _aws: { registryId: record.registryId, recordId: record.recordId, recordArn: record.recordArn, awsStatus: record.status },
  }
  if (type === "A2A") {
    const a2aDescriptor = descriptorJson(
      record.descriptors?.a2a?.agentCard?.inlineContent,
      record.descriptors?.a2aAgentCard?.data,
    )
    const customDescriptor = descriptorJson(
      record.descriptors?.custom?.inlineContent,
      record.descriptors?.custom?.data,
    )
    const hasA2aDescriptor = a2aDescriptor !== "{}"
    const card = parseData(
      hasA2aDescriptor ? a2aDescriptor : customDescriptor,
      governedVersion,
    )
    const {
      governed,
      platform: xp,
      metadata,
    } = governedDescriptorParts(card, "AGENT", governedVersion)
    return {
      version: { ...base, changelog: metadata.changelog || null, createdBy: metadata.createdBy || null,
        content: { baseUrl: card.url || null, access: metadata.access || ["admin"], card } },
      entry: { id: governed ? xp.resourceId : xp.id || record.name, type: governed && !hasA2aDescriptor ? "Agent" : "A2AAgent", name: metadata.displayName || card.name || null, domain: governed ? null : xp.domain ?? null,
        governanceMode: metadata.governanceMode || "federated", domainOwner: metadata.domainOwner || null },
      governed: governed ? { domainId: xp.domainId } : null,
    }
  }
  if (type === "AGENT_SKILLS") {
    const def = parseData(descriptorJson(
      record.descriptors?.agentSkills?.skillDefinition?.inlineContent,
      record.descriptors?.agentSkillsDefinition?.data,
    ), governedVersion)
    const {
      governed,
      platform: xp,
      metadata,
    } = governedDescriptorParts(def, "SKILL", governedVersion)
    return {
      version: { ...base, changelog: metadata.changelog || null, createdBy: metadata.createdBy || null,
        content: { tools: metadata.tools || [], toolType: metadata.toolType || null, gateway: metadata.gateway || null,
          auth: metadata.auth || null, access: metadata.access || ["admin", "builder"] } },
      entry: { id: governed ? xp.resourceId : xp.id || def.id || record.name, type: "Skill", name: metadata.displayName || def.displayName || null, domain: governed ? null : xp.domain ?? null,
        governanceMode: metadata.governanceMode || "owned", domainOwner: metadata.domainOwner || null },
      governed: governed ? { domainId: xp.domainId } : null,
    }
  }
  if (type === "MCP") {
    // AWS Agent Registry MCP descriptors follow the official MCP server.json
    // schema. Discovery metadata is not a Gateway target or invocation grant.
    const descriptor = record.descriptors?.mcpServer
    let server
    try { server = JSON.parse(descriptor?.data) } catch { throw new Error("Registry MCP descriptor is malformed.") }
    const envelope = server
    const parts = governedDescriptorParts(envelope, "MCP_SERVER", governedVersion)
    // registerDraft persists a governed envelope; native MCP records use the
    // MCP Registry descriptor directly. Validate both, never invent metadata.
    if (parts.governed) {
      // Earlier governed registrations stored native MCP fields at the root
      // and only a provenance marker in specification. Accept that exact
      // legacy shape without weakening governed identity or approval checks.
      const specification = envelope.specification
      const legacyNative = specification
        && Object.keys(specification).length === 1
        && specification._source === "agentcore-registry"
      server = legacyNative
        ? Object.fromEntries(["name", "description", "version", "remotes", "packages"]
          .filter(key => Object.hasOwn(envelope, key)).map(key => [key, envelope[key]]))
        : specification
    }
    if (!server || typeof server !== "object" || Array.isArray(server)
      || ![server.name, server.description, server.version, ...(parts.governed ? [] : [descriptor.dataSchemaVersion])]
        .every(value => typeof value === "string" && value.trim())
      || (server.remotes !== undefined && (!Array.isArray(server.remotes)
        || server.remotes.some(remote => !remote || typeof remote !== "object"
          || !["streamable-http", "sse"].includes(remote.type)
          || typeof remote.url !== "string" || !/^https?:\/\//.test(remote.url))))) {
      throw new Error("Registry MCP descriptor is malformed.")
    }
    const { governed, platform: xp, metadata } = parts
    return {
      version: { ...base, content: { server, endpoint: server.remotes?.[0]?.url ?? null,
        gateway: null, tools: [], auth: null, access: metadata.access || ["admin", "builder"] } },
      entry: { id: governed ? xp.resourceId : xp.id || record.name, type: "MCPServer",
        name: record.displayName || server.name, domain: governed ? null : xp.domain ?? null,
        governanceMode: metadata.governanceMode || "federated", domainOwner: metadata.domainOwner || null },
      governed: governed ? { domainId: xp.domainId } : null,
    }
  }
  if (type === "CUSTOM") {
    const data = parseData(descriptorJson(
      record.descriptors?.custom?.inlineContent,
      record.descriptors?.custom?.data,
    ), governedVersion)
    // Governed publications ride CUSTOM for every non-AGENT/SKILL/MCP resource
    // type — currently blueprints and tools. Project tools as Tool entries.
    if (data?.resourceKind === "tool") {
      const {
        governed,
        platform: xp,
        metadata,
      } = governedDescriptorParts(data, "TOOL", governedVersion)
      return {
        version: { ...base, changelog: metadata.changelog || "Published domain tool (registry CUSTOM record).", createdBy: metadata.createdBy || xp.ownerSubject || "domain",
          content: { specification: data.specification || {}, access: metadata.access || ["admin", "builder"] } },
        entry: { id: governed ? xp.resourceId : data.toolId || record.name, type: "Tool",
          name: metadata.displayName || record.displayName || record.name, domain: governed ? null : xp.domain ?? null,
          governanceMode: metadata.governanceMode || "owned", domainOwner: metadata.domainOwner || null },
        governed: governed ? { domainId: xp.domainId } : null,
      }
    }
    const {
      governed,
      platform: xp,
      metadata,
    } = governedDescriptorParts(data, "BLUEPRINT", governedVersion)
    if (data.resourceKind !== "blueprint") {
      if (governed) governedDescriptorError()
      return null // only blueprints and tools ride CUSTOM in this demo
    }
    // Governed submissions use the same specification envelope as the write
    // API. Bootstrap records predate that envelope and keep fields at the top.
    const blueprint = governed && data.specification
      && typeof data.specification === "object" && !Array.isArray(data.specification)
      ? data.specification : data
    return {
      version: { ...base, changelog: metadata.changelog || "Published platform blueprint (registry CUSTOM record).", createdBy: metadata.createdBy || "platform",
        content: { template: blueprint.template || {}, compat: blueprint.compat || {}, git: blueprint.git || null, source: blueprint.source || null,
          recommended: blueprint.recommended === true } },
      entry: { id: governed ? xp.resourceId : data.blueprintId || record.name, type: "Blueprint", name: metadata.displayName || data.displayName || null, domain: governed ? null : "shared",
        governanceMode: metadata.governanceMode || "owned", domainOwner: metadata.domainOwner || null, defaultVersion: governed ? null : data.defaultVersion || null },
      governed: governed ? { domainId: xp.domainId } : null,
    }
  }
  if (governedVersion) governedDescriptorError()
  return null // Unknown record types are not projected as supported resources.
}

// Group per-version records (name+recordVersion unique) into legacy entries.
// `domainOf(record)` supplies the registry-derived domain fallback.
// `onRecordFault(recordId, error)` (optional) enables per-record fault
// isolation: when supplied, a single record that fails to parse/validate is
// reported and skipped instead of throwing out of the whole projection, so
// the remaining good records still return. A skipped record contributes no
// versions and therefore no Approve/decide/authorize affordance (fail-closed,
// non-actionable). With no callback the historical throw-on-fault contract is
// preserved for existing callers.
export function recordsToEntries(records, domainOf = () => null, onRecordFault = null) {
  const resilient = typeof onRecordFault === "function"
  const byName = new Map()
  const recordIdentities = new Set()
  for (const record of records) {
    requireUniqueIdentity(recordIdentities,
      [record?.registryId, record?.recordId], "Registry record identity")
    let mapped
    try { mapped = recordToVersion(record) }
    catch (error) {
      if (!resilient) throw error
      onRecordFault(`${record.registryId}/${record.recordId}`, error)
      continue
    }
    if (!mapped) continue
      const key = `${record.registryId}/${record.name}`
      const registryDomain = domainOf(record)
      if (
        mapped.governed
        && (
          typeof registryDomain !== "string"
          || registryDomain.replaceAll("-", "_")
            !== mapped.governed.domainId
        )
      ) {
        throw new Error("Registry governed domain is inconsistent.")
      }
      if (mapped.governed) mapped.version._governed = true
      const effectiveEntry = {
        ...mapped.entry,
        domain: typeof registryDomain === "string"
          ? registryDomain
          : mapped.entry.domain,
      }
      const existing = byName.get(key)
      if (
        existing
        && [
          "id",
          "type",
          "domain",
          "governanceMode",
          "domainOwner",
        ].some(field => existing[field] !== effectiveEntry[field])
      ) {
        throw new Error("Registry entry identity is inconsistent.")
      }
      if (
        existing
        && existing.versions.some((version) =>
          version.semver === mapped.version.semver)
      ) {
        throw new Error("Registry record version is duplicated.")
      }
      // All per-record throw points are above; only now do we commit to the
      // shared accumulator so a faulted record never corrupts a good slot.
      let slot = existing
      if (!slot) {
        slot = {
          ...effectiveEntry,
          name: mapped.entry.name || record.displayName || record.name,
          description: record.description || "",
          defaultVersion: mapped.entry.defaultVersion || null,
          _source: "agentcore-registry",
          _registryId: record.registryId,
          _registryName: record.name,
          versions: [],
        }
        byName.set(key, slot)
      }
      slot.versions.push(mapped.version)
  }

  const cmp = (a, b) => {
    const pa = String(a.semver).split(".").map(part => parseInt(part, 10) || 0)
    const pb = String(b.semver).split(".").map(part => parseInt(part, 10) || 0)
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
    return String(a.semver).localeCompare(String(b.semver))
  }
  const out = []
  for (const entry of byName.values()) {
    entry.versions.sort(cmp)
    // The embedded defaultVersion in legacy immutable records cannot pin the
    // catalog to 1.0 forever after a governed, approved successor is published.
    // Explicit version references still resolve to their original record.
    const governedApproved = entry.versions.filter(v => v._governed && v.status === "APPROVED")
    if (governedApproved.length) {
      entry.defaultVersion = governedApproved[governedApproved.length - 1].semver
    } else if (!entry.defaultVersion) {
      const approved = entry.versions.filter(v => v.status === "APPROVED")
      entry.defaultVersion = approved.length ? approved[approved.length - 1].semver : entry.versions[entry.versions.length - 1]?.semver || null
    }
    out.push(entry)
  }
  // Application aliases are not AWS record identities. Qualify aliases that
  // collide across record names/registries; retain the already-validated
  // (registryId, name) group and immutable per-version AWS record identity.
  const aliases = new Map()
  for (const entry of out) aliases.set(entry.id, [...(aliases.get(entry.id) || []), entry])
  for (const entries of aliases.values()) {
    if (entries.length < 2) continue
    for (const entry of entries) entry.id = `${entry._registryId}/${entry._registryName}`
  }
  return assertUniqueEntryIds(out)
}

// Tools-gateway MCP target -> the legacy MCPServer entry shape (D9: the MCP
// list is a direct gateway read, not registry records).
export function gatewayTargetToMcpEntry(target, gateway = {}) {
  const id = requireUniqueIdentity(
    new Set(),
    [gateway.gatewayId, target.targetId],
    "Gateway target identity",
  )
  const ready = target.status === "READY"
  return {
    id, type: "MCPServer", name: target.name,
    description: target.description || "",
    governanceMode: "federated", domainOwner: null, domain: "shared",
    defaultVersion: "1.0.0",
    source: "tools-gateway",
    _source: "gateway",
    _gateway: gateway.name || gateway.gatewayId,
    versions: [{
      semver: "1.0.0", status: ready ? "APPROVED" : "DRAFT",
      content: {
        url: target.endpoint || gateway.gatewayUrl || null,
        transport: "streamable_http", type: "remote_mcp",
        access: ["admin", "builder"], tools: [],
        gatewayTargetStatus: target.status || null,
      },
      changelog: `MCP target on ${gateway.name || "the tools gateway"} (status ${target.status}). Access control = gateway FGAC (Cedar), not registry approval.`,
      createdBy: "tools-gateway", createdAt: iso(target.createdAt),
      decidedBy: ready ? "gateway" : null, decidedAt: ready ? iso(target.updatedAt) : null,
      autoChecks: [],
    }],
  }
}
