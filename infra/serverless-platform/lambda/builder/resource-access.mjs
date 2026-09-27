const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,255}$/;
const PLATFORM_BLUEPRINT_IDS = new Set([
  "chat-assistant",
  "workflow-orchestrator",
]);
const SELECTIONS = Object.freeze([
  ["TOOL", "toolIds"],
  ["MCP_SERVER", "mcpServerIds"],
  ["SKILL", "skillIds"],
  ["BLUEPRINT", "blueprintIds"],
  ["MEMORY", "memoryIds"],
  ["KNOWLEDGE_BASE", "knowledgeBaseIds"],
]);

function plain(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function approvedVersion(entry) {
  if (
    !plain(entry)
    || typeof entry.defaultVersion !== "string"
    || !Array.isArray(entry.versions)
  ) {
    return null;
  }
  const matches = entry.versions.filter((version) =>
    version?.semver === entry.defaultVersion
    && version?.status === "APPROVED"
    && plain(version.content));
  return matches.length === 1 ? matches[0] : null;
}

function identity(version, selectedId) {
  const registryId = version?._aws?.registryId;
  const recordId = version?._aws?.recordId;
  if (
    typeof registryId === "string"
    && RESOURCE_ID_PATTERN.test(registryId)
    && typeof recordId === "string"
    && RESOURCE_ID_PATTERN.test(recordId)
  ) {
    return { registryId, recordId };
  }
  const parts = selectedId.split("/");
  return parts.length === 2
    && parts.every((part) => RESOURCE_ID_PATTERN.test(part))
    ? { registryId: parts[0], recordId: parts[1] }
    : null;
}

function matchesType(entry, version, resourceType) {
  if (resourceType === "MCP_SERVER") return entry.type === "MCPServer";
  if (resourceType === "BLUEPRINT") return entry.type === "Blueprint";
  if (resourceType === "SKILL") {
    return entry.type === "Skill" && !version.content.toolType;
  }
  if (resourceType === "TOOL") {
    return entry.type === "Tool"
      || (entry.type === "Skill" && Boolean(version.content.toolType));
  }
  if (resourceType === "MEMORY") return entry.type === "Memory";
  if (resourceType === "KNOWLEDGE_BASE") {
    return entry.type === "KnowledgeBase";
  }
  return false;
}

function selectedEntry(entries, selectedId, resourceType) {
  const matches = entries.filter((entry) => {
    const version = approvedVersion(entry);
    if (!version || !matchesType(entry, version, resourceType)) return false;
    const record = identity(version, selectedId);
    const canonical = record
      ? `${record.registryId}/${record.recordId}`
      : null;
    return entry.id === selectedId || canonical === selectedId;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function createBuilderResourceAccessResolver({
  inventoryProvider,
} = {}) {
  if (typeof inventoryProvider !== "function") {
    throw new TypeError("Builder resource access configuration is invalid.");
  }
  return async function resolveBuilderResourceAccess({
    identity: requester,
    payload,
  } = {}) {
    const domainAllowed =
      requester?.role === "admin"
        ? Array.isArray(requester.domainIds)
          && requester.domainIds.includes(payload?.domainId)
        : requester?.activeDomain === payload?.domainId;
    if (
      !plain(requester)
      || !plain(payload)
      || !domainAllowed
    ) {
      throw new Error("Builder resource access request is invalid.");
    }
    const inventory = await inventoryProvider({
      role: requester.role,
      activeDomain: payload.domainId,
      allowedDomains: [payload.domainId],
    });
    const entries = [
      ...(Array.isArray(inventory?.registry?.entries)
        ? inventory.registry.entries
        : []),
      ...(Array.isArray(inventory?.aiGateway?.tools)
        ? inventory.aiGateway.tools
        : []),
    ];
    const grants = [];
    for (const [resourceType, field] of SELECTIONS) {
      if (!Array.isArray(payload[field])) {
        throw new Error("The selected resource is unavailable.");
      }
      for (const resourceId of payload[field]) {
        const selected = selectedEntry(entries, resourceId, resourceType);
        if (!selected) {
          throw new Error("The selected resource is unavailable.");
        }
        const platformBlueprint =
          resourceType === "BLUEPRINT"
          && selected.domain === "shared"
          && PLATFORM_BLUEPRINT_IDS.has(selected.id);
        if (selected.domain !== payload.domainId && !platformBlueprint) {
          // Registry entry identity survives default-version changes. A caller
          // may select a canonical record alias, but grants use the stable ID.
          grants.push({ resourceType, resourceId: inventory.registry?.domainResourcePolicyApplied ? selected.id : resourceId });
        }
      }
    }
    return grants;
  };
}
