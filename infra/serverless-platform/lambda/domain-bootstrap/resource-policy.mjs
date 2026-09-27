import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { selectableCatalogVersion } from "../../../../console/public/domain-foundation-catalog.mjs";

export const resourcePolicyKey = domainId => ({
  pk: { S: `GRANT#${domainId}` }, sk: { S: "CATALOG#POLICY" },
});

export function validateResourcePolicy(policy, domainId) {
  if (!policy || policy.schemaVersion !== 1 || policy.domainId !== domainId
      || !["INITIALIZING", "ACTIVE"].includes(policy.status)
      || typeof policy.operationId !== "string" || !Array.isArray(policy.resources)
      || policy.resources.length > 150 || policy.resources.some(ref =>
        !["Blueprint", "Model", "Skill", "MCPServer"].includes(ref.type)
        || typeof ref.id !== "string" || !ref.id
        || !(ref.registryId === null || typeof ref.registryId === "string")
        || (ref.registryName != null && (typeof ref.registryName !== "string" || !ref.registryName)))) {
    throw new Error("Domain resource policy is malformed.");
  }
  return policy;
}

export async function readResourcePolicy(dynamo, tableName, domainId, options) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(domainId || "")) throw new Error("Domain is invalid.");
  const response = await dynamo.send(new GetItemCommand({
    TableName: tableName, Key: resourcePolicyKey(domainId), ConsistentRead: true,
  }), options);
  if (!response || typeof response !== "object") throw new Error("Domain resource policy read failed.");
  if (!response.Item) return null; // Existing domains keep their established policy.
  return validateResourcePolicy(JSON.parse(response.Item.document?.S), domainId);
}

export function filterDomainResourceEntries(entries, policy) {
  if (!policy) return entries;
  return entries.flatMap(entry => {
    // Domain-owned resources retain their own governance. Shared Agents remain
    // subject to their existing discovery/entitlement contract.
    if (entry.domain === policy.domainId || !["Blueprint", "Model", "Skill", "MCPServer"].includes(entry.type)) return [entry];
    if (policy.status !== "ACTIVE") return [];
    // Display aliases can be qualified only in the all-domain catalog when
    // names collide. Registry/name is stable across scopes and new versions.
    const matches = policy.resources.filter(ref => ref.type === entry.type
      && (ref.registryName ? ref.registryName === entry._registryName
        : ref.id === entry.id || ref.id === `${entry._registryId}/${entry._registryName}`)
      && (entry.versions || []).some(version => version.semver === entry.defaultVersion
        && selectableCatalogVersion(entry, version)
        && (version._aws?.registryId || null) === ref.registryId));
    // Keep the granted ID in every consumer, including model policy lookups.
    return matches.length === 1 ? [{ ...entry, id: matches[0].id }] : [];
  });
}

export function resourceGrantType(entry) {
  if (entry.ref.type === "Blueprint") return "BLUEPRINT";
  if (entry.ref.type === "MCPServer") return "MCP_SERVER";
  if (entry.ref.type === "Skill") return entry.content.toolType ? "TOOL" : "SKILL";
  throw new Error("Resource grant type is unsupported.");
}
