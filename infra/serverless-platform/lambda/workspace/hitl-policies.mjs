import { GetItemCommand } from "@aws-sdk/client-dynamodb";

const DOMAIN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BYTES = 256 * 1024;
const MAX_POLICIES = 200;
function invalid() { throw new TypeError("Invalid HITL policy catalog."); }
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function text(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}
function version(value) { return Number.isSafeInteger(value) && value > 0; }

// The legacy agentScope matches PROJECT, not agent ID. V1 deliberately supports
// domain-all and one project only; it does not invent an agent execution binding.
export function validateHitlCatalog(value, expectedDomain = value?.domainId) {
  if (!exact(value, ["schemaVersion", "revision", "domainId", "updatedAt", "policies"])
    || value.schemaVersion !== 1 || !version(value.revision)
    || typeof value.domainId !== "string" || !DOMAIN.test(value.domainId)
    || value.domainId !== expectedDomain || !timestamp(value.updatedAt)
    || !Array.isArray(value.policies) || value.policies.length > MAX_POLICIES) invalid();
  const ids = new Set();
  for (const p of value.policies) {
    if (!exact(p, ["id", "version", "name", "toolMatch", "mode", "scope", "enabled", "createdAt"])
      || typeof p.id !== "string" || !SLUG.test(p.id) || ids.has(p.id)
      || !version(p.version) || !text(p.name, 200)
      || !Array.isArray(p.toolMatch) || p.toolMatch.length < 1 || p.toolMatch.length > 50
      || p.toolMatch.some(pattern => !text(pattern, 200))
      || !["require_approval", "notify_only"].includes(p.mode)
      || typeof p.enabled !== "boolean" || !timestamp(p.createdAt)
      || Date.parse(p.createdAt) > Date.parse(value.updatedAt)
      || !(exact(p.scope, ["kind"]) && p.scope.kind === "domain"
        || exact(p.scope, ["kind", "projectId"]) && p.scope.kind === "project"
          && typeof p.scope.projectId === "string" && SLUG.test(p.scope.projectId))) invalid();
    ids.add(p.id);
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) invalid();
  return JSON.parse(encoded);
}

// One atomic, bounded versioned snapshot per domain. Array order is retained,
// matching the legacy first-enabled-match ordering. No scans, GSI or partial rows.
export function buildHitlCatalogItem(catalog) {
  const checked = validateHitlCatalog(catalog);
  return {
    pk: { S: `HITL_POLICY#${checked.domainId}` }, sk: { S: "CATALOG" },
    entityType: { S: "HITL_POLICY_CATALOG" }, document: { S: JSON.stringify(checked) },
  };
}

// Offline initialization contract ONLY: returns a reviewed PutItem input; never
// sends it. An explicit empty snapshot is configured-empty, absence is not.
// No policy seed, cloud/custom-resource handler or HTTP write API is provided.
export function buildHitlCatalogInitialization({ tableName, catalog }) {
  if (typeof tableName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)
    || catalog?.revision !== 1) invalid();
  return { TableName: tableName, Item: buildHitlCatalogItem(catalog),
    ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" };
}

export function createHitlCatalogReader({ tableName, dynamo }) {
  return async function readHitlPolicyCatalog({ domainId }) {
    if (typeof domainId !== "string" || !DOMAIN.test(domainId)) invalid();
    const result = await dynamo.send(new GetItemCommand({
      TableName: tableName,
      Key: { pk: { S: `HITL_POLICY#${domainId}` }, sk: { S: "CATALOG" } },
      ConsistentRead: true,
    }));
    if (!result || typeof result !== "object" || Array.isArray(result)) invalid();
    if (result.Item === undefined) return null;
    const item = result.Item;
    if (!exact(item, ["pk", "sk", "entityType", "document"])
      || !exact(item.pk, ["S"]) || item.pk.S !== `HITL_POLICY#${domainId}`
      || !exact(item.sk, ["S"]) || item.sk.S !== "CATALOG"
      || !exact(item.entityType, ["S"]) || item.entityType.S !== "HITL_POLICY_CATALOG"
      || !exact(item.document, ["S"]) || typeof item.document.S !== "string"
      || Buffer.byteLength(item.document.S, "utf8") > MAX_BYTES) invalid();
    return validateHitlCatalog(JSON.parse(item.document.S), domainId);
  };
}
