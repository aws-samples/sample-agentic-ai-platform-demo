// Registry projections are the only source of foundation content. This module
// deliberately contains no blueprint, model, skill, tool, or default inventory.
const TYPES = new Set(["Blueprint", "Model", "Skill", "MCPServer"]);
// Gateway model discovery is a catalog registration, not a runtime grant.
// Native submitted resources still require their normal Registry approval.
export function selectableCatalogVersion(entry, version) {
  // Governed catalog: only platform-onboarded (APPROVED) records are
  // selectable. Gateway discovery alone is NOT membership — an IN_REVIEW
  // gateway model has no platform decision behind it, so it must not appear
  // in domain initialization, project palettes, or the builder.
  if (!version || ["DEPRECATED", "REJECTED", "DRAFT"].includes(version.status)) return false;
  if (entry?.type === "Model" && version.content?.source === "agentcore-gateway"
      && version.content.gatewayModelId !== entry.id) return false;
  return version.status === "APPROVED";
}
export function resourceKey(ref) {
  return JSON.stringify([ref.type, ref.id, ref.registryId || "", ref.recordId || "", ref.version]);
}

export function foundationCatalog(registry, { displayOnly = false } = {}) {
  const incomplete = registry?.incomplete === true || registry?.completeness === "incomplete";
  if (registry?.ok !== true || !Array.isArray(registry.entries)
      || (incomplete && !displayOnly)) {
    throw new Error("AI Registry is incomplete or unavailable. Refresh before configuring a domain.");
  }
  const entries = [];
  const identities = new Set();
  for (const entry of registry.entries) {
    if (!TYPES.has(entry.type) || entry.domain !== "shared") continue;
    const versions = entry.versions?.filter(version => version.semver === entry.defaultVersion);
    if (versions?.length !== 1 || !selectableCatalogVersion(entry, versions[0])) continue;
    const version = versions[0];
    const ref = {
      type: entry.type, id: entry.id, version: version.semver,
      registryId: version._aws?.registryId || null,
      recordId: version._aws?.recordId || null,
    };
    if (typeof ref.id !== "string" || !ref.id || identities.has(resourceKey(ref))) {
      throw new Error("AI Registry contains ambiguous resource identities.");
    }
    identities.add(resourceKey(ref));
    entries.push({ ref, name: entry.name || entry.id, description: entry.description || "",
      registryName: entry._registryName || null, content: version.content || {} });
  }
  const blueprints = entries.filter(entry => entry.ref.type === "Blueprint")
    .sort((a, b) => Number(b.content.recommended === true) - Number(a.content.recommended === true)
      || a.name.localeCompare(b.name));
  const discoveredModels = registry.entries.filter(entry => entry.type === "Model" && entry.domain === "shared");
  const modelAvailability = {
    discovered: discoveredModels.length,
    selectable: entries.filter(entry => entry.ref.type === "Model").length,
    runtimePolicyConfigured: discoveredModels.filter(entry =>
      entry.versions?.some(version => version.semver === entry.defaultVersion
        && version.content?.platformApproval?.status === "APPROVED")).length,
    policyRequired: discoveredModels.filter(entry =>
      entry.versions?.some(version => version.semver === entry.defaultVersion
        && version.content?.platformApproval?.status === "POLICY_REQUIRED")).length,
  };
  return {
    incomplete,
    errors: Array.isArray(registry.errors) ? registry.errors.filter(error => typeof error === "string") : [],
    blueprints,
    modelAvailability,
    models: entries.filter(entry => entry.ref.type === "Model"),
    resources: entries.filter(entry => ["Skill", "MCPServer"].includes(entry.ref.type)),
  };
}
