// Catalog visibility: the platform team's post-approval decision about which
// domains may DISCOVER an approved shared-catalog registry record.
//
//   mode "open"       — every active domain sees the record
//   mode "restricted" — only allowedDomainIds see it
//   no entry          — publisher-domain only (default-deny for new records)
//
// Visibility is distinct from RESOURCE_GRANT: visibility controls whether a
// record appears in another domain's catalog at all; a grant authorizes that
// domain to USE it. A record must be visible before its grants are even
// requestable. One platform-owned document (same storage pattern as the alert
// and HITL catalogs) holds every decision; writes go through the platform
// governance surface only.
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";

const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const time = v => typeof v === "string" && Number.isFinite(Date.parse(v))
  && new Date(v).toISOString() === v;
const DOMAIN_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
// registryId/recordId reference, matching recordReference() in governance.
const RESOURCE_REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[A-Za-z0-9]{12}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_ENTRIES = 500;
const MAX_DOMAINS_PER_ENTRY = 100;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const KEY = { pk: { S: "CATALOG_VISIBILITY#platform" }, sk: { S: "CATALOG" } };
const ENTITY_TYPE = "CATALOG_VISIBILITY_CATALOG";

export function validateVisibilityCatalog(v) {
  const bad = () => { throw new TypeError("Invalid catalog visibility document"); };
  if (
    !exact(v, ["schemaVersion", "revision", "updatedAt", "entries"])
    || v.schemaVersion !== 1
    || !Number.isSafeInteger(v.revision) || v.revision < 1
    || !time(v.updatedAt)
    || !Array.isArray(v.entries) || v.entries.length > MAX_ENTRIES
  ) bad();
  const seen = new Set();
  for (const e of v.entries) {
    if (
      !exact(e, ["resourceId", "mode", "allowedDomainIds", "decidedBySubject", "decidedAt"])
      || !RESOURCE_REF.test(e.resourceId) || seen.has(e.resourceId)
      || !["open", "restricted"].includes(e.mode)
      || !Array.isArray(e.allowedDomainIds)
      || e.allowedDomainIds.length > MAX_DOMAINS_PER_ENTRY
      || new Set(e.allowedDomainIds).size !== e.allowedDomainIds.length
      || e.allowedDomainIds.some(d => !DOMAIN_ID.test(d))
      // Open carries no allowlist; restricted must name at least one domain —
      // "restricted to nobody" must be expressed by not publishing, not here.
      || (e.mode === "open" && e.allowedDomainIds.length !== 0)
      || (e.mode === "restricted" && e.allowedDomainIds.length === 0)
      || !SUBJECT.test(e.decidedBySubject)
      || !time(e.decidedAt) || e.decidedAt > v.updatedAt
    ) bad();
    seen.add(e.resourceId);
  }
  const encoded = JSON.stringify(v);
  if (Buffer.byteLength(encoded) > MAX_DOCUMENT_BYTES) bad();
  return JSON.parse(encoded);
}

export function buildVisibilityCatalogItem(v) {
  const c = validateVisibilityCatalog(v);
  return {
    ...KEY,
    entityType: { S: ENTITY_TYPE },
    document: { S: JSON.stringify(c) },
  };
}

export function createVisibilityCatalogReader({ tableName, dynamo }) {
  return async ({ abortSignal } = {}) => {
    const r = await dynamo.send(new GetItemCommand({
      TableName: tableName, Key: KEY, ConsistentRead: true,
    }), abortSignal ? { abortSignal } : undefined);
    if (!r || typeof r !== "object" || Array.isArray(r)) throw Error("Invalid visibility read");
    if (r.Item === undefined) return null;
    const i = r.Item;
    if (
      !exact(i, ["pk", "sk", "entityType", "document"])
      || !["pk", "sk", "entityType", "document"].every(k => exact(i[k], ["S"]))
      || i.pk?.S !== KEY.pk.S || i.sk?.S !== KEY.sk.S
      || i.entityType?.S !== ENTITY_TYPE
      || typeof i.document?.S !== "string"
      || Buffer.byteLength(i.document.S) > MAX_DOCUMENT_BYTES
    ) throw Error("Invalid stored visibility catalog");
    return validateVisibilityCatalog(JSON.parse(i.document.S));
  };
}

// Optimistic-concurrency writer: the caller supplies the expected current
// revision; a concurrent decision loses cleanly instead of overwriting.
export function createVisibilityCatalogWriter({ tableName, dynamo }) {
  return async (catalog, expectedRevision) => {
    if (
      !(expectedRevision === null
        || (Number.isSafeInteger(expectedRevision) && expectedRevision >= 1))
    ) throw new TypeError("Invalid expected revision");
    const item = buildVisibilityCatalogItem(catalog);
    const expectedDocumentRevision = expectedRevision === null
      ? null
      : catalog.revision;
    if (
      expectedRevision !== null
      && expectedDocumentRevision !== expectedRevision + 1
    ) throw new TypeError("Revision must advance by exactly one");
    if (expectedRevision === null && catalog.revision !== 1) {
      throw new TypeError("Initial visibility catalog must be revision 1");
    }
    await dynamo.send(new PutItemCommand({
      TableName: tableName,
      Item: item,
      ...(expectedRevision === null
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : {
            ConditionExpression:
              "attribute_exists(pk) AND contains(#d, :rev)",
            ExpressionAttributeNames: { "#d": "document" },
            ExpressionAttributeValues: {
              ":rev": { S: `"revision":${expectedRevision},` },
            },
          }),
    }));
    return validateVisibilityCatalog(JSON.parse(item.document.S));
  };
}

// The one visibility question every catalog read path asks. `publisherDomainId`
// comes from the record's own x-platform metadata; `entry` is the catalog
// entry for the record (or undefined). Fail-closed: an approved record with
// no decision is visible only where it was published. `legacyShared` preserves
// the pre-visibility contract for records seeded before this feature — their
// descriptor's `shared: true` was the platform's (coarse) publication-time
// decision and must not silently disappear from consuming domains.
export function domainMayDiscover({
  viewerDomainId,
  publisherDomainId,
  entry,
  legacyShared = false,
}) {
  if (viewerDomainId === publisherDomainId) return true;
  if (entry === undefined || entry === null) return legacyShared === true;
  if (entry.mode === "open") return true;
  return entry.allowedDomainIds.includes(viewerDomainId);
}
