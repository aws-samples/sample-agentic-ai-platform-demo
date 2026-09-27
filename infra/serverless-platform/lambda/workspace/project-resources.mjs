import { foundationCatalog } from "../../../../console/public/domain-foundation-catalog.mjs";
import { readResourcePolicy } from "../domain-bootstrap/resource-policy.mjs";
import { sameResource, validateProjectResourcePolicy } from "../../../../console/public/project-resource-policy.mjs";

export function createProjectResourceValidator({ dynamo, tableName, catalogProvider }) {
  return async ({ domainId, resourcePolicy, abortSignal }) => {
    const selection = validateProjectResourcePolicy(resourcePolicy);
    const domain = await readResourcePolicy(dynamo, tableName, domainId, { abortSignal });
    if (domain && domain.status !== "ACTIVE") return false;
    if (selection === null) return true;
    if (!domain) {
      if (selection.resources.length === 0) return true;
      if (typeof catalogProvider !== "function") return false;
      // Legacy domains inherit the scoped Registry, not a client-provided list.
      // Resolve it again for every create/retry; missing or revoked entries deny.
      const inventory = await catalogProvider({ domainId, abortSignal });
      const catalog = foundationCatalog(inventory, { displayOnly: true });
      const resources = [...catalog.blueprints, ...catalog.models, ...catalog.resources]
        .map(entry => ({ ...entry.ref, ...(entry.registryName ? { registryName: entry.registryName } : {}) }));
      return selection.resources.every(ref => resources.some(parent => ref.id === parent.id && sameResource(ref, parent)));
    }
    return selection.resources.every(ref => domain.resources.some(parent => sameResource(ref, parent)));
  };
}
