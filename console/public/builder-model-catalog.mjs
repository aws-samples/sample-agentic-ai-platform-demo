import { foundationCatalog } from "./domain-foundation-catalog.mjs";

// Selection is the intersection of Registry membership and the exact domain's
// current access. Project policy is applied by the caller to these identities.
export function builderModelCatalog(registry, gateway, domainId) {
  if (!domainId || gateway?.ok !== true || !Array.isArray(gateway.models)) return [];
  if (gateway.domainId !== undefined && gateway.domainId !== domainId) return [];
  const registered = foundationCatalog(registry, { displayOnly: true }).models;
  return registered.flatMap(entry => {
    const matches = gateway.models.filter(model => model.id === entry.ref.id);
    if (matches.length !== 1) return [];
    const model = matches[0];
    const access = model.accessByDomain && typeof model.accessByDomain === "object"
      ? model.accessByDomain[domainId]
      : gateway.domainId === domainId ? model.access : null;
    if (access?.usable !== true || !["ALLOWED", "GRANTED"].includes(access.status)) return [];
    return [{ ...model, name: entry.name, runtimeReady: true }];
  });
}
