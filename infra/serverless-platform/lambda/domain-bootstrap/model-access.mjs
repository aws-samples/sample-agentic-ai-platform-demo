import { resolveConfiguration } from "./service.mjs";
import { validPolicy } from "../model-governance/access.mjs";

// Domain catalog access is stored in CATALOG#POLICY by the bootstrap workflow.
// Selecting a registered model does not create or alter a global runtime policy.
export function createBootstrapModelGrant({ models, registry }) {
  return async operation => {
    resolveConfiguration(operation.configuration, await registry(operation.actor));
    const results = [];
    for (const model of operation.applied.models) {
      const modelId = model.ref.id;
      const policy = await models.getModelPolicy({ modelId });
      const ready = validPolicy(policy, modelId) && policy.allowedDomains.includes(operation.domainId);
      results.push({ modelId, status: "CATALOG_ENABLED",
        runtimeStatus: ready ? "READY" : "CONFIGURATION_REQUIRED" });
    }
    return { modelAccess: { status: results.length ? "CATALOG_ENABLED" : "NONE_ENABLED", models: results } };
  };
}
