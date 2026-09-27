import assert from "node:assert/strict";
import test from "node:test";
import {
  validateVisibilityCatalog,
  buildVisibilityCatalogItem,
  createVisibilityCatalogReader,
  createVisibilityCatalogWriter,
  domainMayDiscover,
} from "../lambda/workspace/catalog-visibility.mjs";

const AT = "2026-09-16T00:00:00.000Z";
const entry = (overrides = {}) => ({
  resourceId: "SharedReg123456/Rec123456789",
  mode: "restricted",
  allowedDomainIds: ["customer_support"],
  decidedBySubject: "admin-sub",
  decidedAt: AT,
  ...overrides,
});
const catalog = (entries = [entry()]) => ({
  schemaVersion: 1,
  revision: 1,
  updatedAt: AT,
  entries,
});

test("visibility document validates modes, domains, and uniqueness fail-closed", () => {
  assert.deepEqual(validateVisibilityCatalog(catalog()), catalog());
  assert.deepEqual(
    validateVisibilityCatalog(
      catalog([entry({ mode: "open", allowedDomainIds: [] })]),
    ).entries[0].mode,
    "open",
  );
  for (const broken of [
    catalog([entry({ mode: "open" })]),                       // open with allowlist
    catalog([entry({ allowedDomainIds: [] })]),               // restricted to nobody
    catalog([entry({ allowedDomainIds: ["Bad-Domain"] })]),   // invalid domain id
    catalog([entry({ resourceId: "not-a-reference" })]),      // malformed reference
    catalog([entry(), entry()]),                              // duplicate resource
    { ...catalog(), schemaVersion: 2 },
    { ...catalog(), revision: 0 },
  ]) {
    assert.throws(() => validateVisibilityCatalog(broken), /Invalid catalog visibility/);
  }
});

test("reader and writer round-trip through DynamoDB item encoding with revision guard", async () => {
  const table = new Map();
  const dynamo = {
    async send(command) {
      const name = command.constructor.name;
      if (name === "GetItemCommand") {
        const item = table.get("doc");
        return item === undefined ? {} : { Item: item };
      }
      if (name === "PutItemCommand") {
        const existing = table.get("doc");
        if (command.input.ConditionExpression === "attribute_not_exists(pk)") {
          if (existing) {
            const error = new Error("exists");
            error.name = "ConditionalCheckFailedException";
            throw error;
          }
        } else if (!existing
          || !existing.document.S.includes(
            command.input.ExpressionAttributeValues[":rev"].S)) {
          const error = new Error("revision moved");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        table.set("doc", command.input.Item);
        return {};
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const read = createVisibilityCatalogReader({ tableName: "T", dynamo });
  const write = createVisibilityCatalogWriter({ tableName: "T", dynamo });
  assert.equal(await read(), null);
  await write(catalog(), null);
  assert.deepEqual(await read(), catalog());
  const next = { ...catalog(), revision: 2, entries: [entry({ mode: "open", allowedDomainIds: [] })] };
  await write(next, 1);
  assert.equal((await read()).entries[0].mode, "open");
  // Stale revision loses cleanly.
  await assert.rejects(
    () => write({ ...catalog(), revision: 2 }, 1),
    (error) => error.name === "ConditionalCheckFailedException",
  );
});

test("discovery rule: default-deny, publisher always sees, legacy shared preserved", () => {
  const restricted = entry();
  // Publisher domain always sees its own record.
  assert.equal(domainMayDiscover({
    viewerDomainId: "legal", publisherDomainId: "legal", entry: undefined,
  }), true);
  // No decision => hidden cross-domain unless the legacy shared flag was set.
  assert.equal(domainMayDiscover({
    viewerDomainId: "operations", publisherDomainId: "legal", entry: undefined,
  }), false);
  assert.equal(domainMayDiscover({
    viewerDomainId: "operations", publisherDomainId: "legal",
    entry: undefined, legacyShared: true,
  }), true);
  // Restricted => only the allowlist.
  assert.equal(domainMayDiscover({
    viewerDomainId: "customer_support", publisherDomainId: "legal", entry: restricted,
  }), true);
  assert.equal(domainMayDiscover({
    viewerDomainId: "operations", publisherDomainId: "legal", entry: restricted,
  }), false);
  // A restricted decision OVERRIDES the legacy shared flag — the platform
  // team's explicit decision wins.
  assert.equal(domainMayDiscover({
    viewerDomainId: "operations", publisherDomainId: "legal",
    entry: restricted, legacyShared: true,
  }), false);
  // Open => everyone.
  assert.equal(domainMayDiscover({
    viewerDomainId: "operations", publisherDomainId: "legal",
    entry: entry({ mode: "open", allowedDomainIds: [] }),
  }), true);
});

test("stored item shape is the platform-partition catalog document", () => {
  const item = buildVisibilityCatalogItem(catalog());
  assert.equal(item.pk.S, "CATALOG_VISIBILITY#platform");
  assert.equal(item.sk.S, "CATALOG");
  assert.equal(item.entityType.S, "CATALOG_VISIBILITY_CATALOG");
  assert.deepEqual(JSON.parse(item.document.S), catalog());
});
