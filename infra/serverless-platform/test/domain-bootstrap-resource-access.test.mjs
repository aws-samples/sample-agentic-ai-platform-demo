import test from "node:test";
import assert from "node:assert/strict";
import { createBootstrapResourceGrants } from "../lambda/domain-bootstrap/resource-access.mjs";
import { filterDomainResourceEntries, readResourcePolicy } from "../lambda/domain-bootstrap/resource-policy.mjs";
import { createWorkspaceState } from "../lambda/workspace/state.mjs";
import { foundationCatalog } from "../../../console/public/domain-foundation-catalog.mjs";
import { createBuilderResourceAccessResolver } from "../lambda/builder/resource-access.mjs";

const inventory = { ok: true, incomplete: true, entries: [
  { id: "agent-template", type: "Blueprint", domain: "shared", defaultVersion: "1.0.0",
    versions: [{ semver: "1.0.0", status: "APPROVED", content: { template: {} },
      _aws: { registryId: "shared-registry", recordId: "record-a" } }] },
  { id: "tool-a", type: "Skill", domain: "shared", defaultVersion: "1.0.0",
    versions: [{ semver: "1.0.0", status: "APPROVED", content: { toolType: "lambda" },
      _aws: { registryId: "shared-registry", recordId: "record-b" } }] },
] };
const catalog = foundationCatalog(inventory, { displayOnly: true });
const operation = { domainId: "finance", actor: { subject: "administrator" },
  configuration: { blueprints: catalog.blueprints.map(e => e.ref), models: [],
    resources: catalog.resources.map(e => e.ref) },
  applied: { blueprints: catalog.blueprints, models: [], resources: catalog.resources } };

test("selected templates and tools create valid audited grants without a project or agent", async () => {
  const commands = [];
  const workspace = createWorkspaceState({ tableName: "state-table",
    now: () => new Date("2026-09-15T00:00:00.000Z"),
    dynamo: { async send(command) { commands.push(command); return {}; } } });
  const result = await createBootstrapResourceGrants({ workspace, registry: async () => inventory })(operation);
  assert.deepEqual(result.resourceGrants.map(g => g.resourceType), ["BLUEPRINT", "TOOL"]);
  const transactions = commands.filter(c => c.constructor.name === "TransactWriteItemsCommand");
  assert.equal(transactions.length, 2);
  const items = transactions.flatMap(c => c.input.TransactItems.map(t => t.Put?.Item).filter(Boolean));
  assert.ok(items.some(item => item.pk.S === "GRANT#finance"));
  assert.ok(items.some(item => item.pk.S.startsWith("AUDIT#grant/finance/")));
  assert.ok(items.every(item => !item.pk.S.startsWith("PROJECT#") && !item.pk.S.startsWith("AGENT#")));
});

test("a revoked grant is not restored by initialization retry", async () => {
  let writes = 0;
  const grant = createBootstrapResourceGrants({ registry: async () => inventory,
    workspace: { getResourceGrant: async () => ({ status: "REVOKED" }), putResourceGrant: async () => writes++ } });
  await assert.rejects(grant(operation), { code: "RESOURCE_GRANT_REVOKED" });
  assert.equal(writes, 0);
});

test("domain resource selection follows approved versions and excludes other shared resources", () => {
  const entries = [...inventory.entries, { id: "owned", domain: "finance", type: "Skill" }];
  const policy = { domainId: "finance", status: "ACTIVE", resources: [
    { type: "Blueprint", id: "agent-template", registryId: "shared-registry" },
  ] };
  assert.deepEqual(filterDomainResourceEntries(entries, policy).map(e => e.id), ["agent-template", "owned"]);
  const newer = structuredClone(entries);
  newer[0].defaultVersion = "2.0.0"; newer[0].versions[0].semver = "2.0.0";
  newer[0].versions[0]._aws.recordId = "new-version-record";
  assert.equal(filterDomainResourceEntries(newer, policy)[0].defaultVersion, "2.0.0");
  newer[0].versions[0].status = "DEPRECATED";
  assert.deepEqual(filterDomainResourceEntries(newer, policy).map(e => e.id), ["owned"]);
  assert.deepEqual(filterDomainResourceEntries(entries, { ...policy, status: "INITIALIZING" }).map(e => e.id), ["owned"]);
  assert.equal(filterDomainResourceEntries(entries, null), entries);
});

test("policy reads are consistent and malformed state fails closed", async () => {
  let command;
  assert.equal(await readResourcePolicy({ send: async c => { command = c; return {}; } }, "table", "finance"), null);
  assert.equal(command.input.ConsistentRead, true);
  assert.equal(command.input.Key.sk.S, "CATALOG#POLICY");
  await assert.rejects(readResourcePolicy({ send: async () => ({ Item: { document: { S: "{}" } } }) }, "table", "finance"));
});

test("domain views preserve grants when platform aliases are qualified by cross-domain collisions", async () => {
  const scoped = { ...inventory.entries[0], id: "agent-template",
    _registryId: "shared-registry", _registryName: "blueprint_agent-template" };
  const grantId = "shared-registry/blueprint_agent-template";
  const policy = { domainId: "finance", status: "ACTIVE", resources: [
    { type: "Blueprint", id: grantId, registryId: "shared-registry" },
  ] };
  const filtered = filterDomainResourceEntries([scoped], policy);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, grantId);
  const resolver = createBuilderResourceAccessResolver({ inventoryProvider: async () =>
    ({ registry: { entries: filtered, domainResourcePolicyApplied: true } }) });
  assert.deepEqual(await resolver({ identity: { role: "builder", activeDomain: "finance" },
    payload: { domainId: "finance", blueprintIds: [grantId],
      toolIds: [], mcpServerIds: [], skillIds: [], memoryIds: [], knowledgeBaseIds: [] } }),
  [{ resourceType: "BLUEPRINT", resourceId: grantId }]);
  assert.deepEqual(filterDomainResourceEntries([{ ...scoped,
    versions: [{ ...scoped.versions[0], _aws: { registryId: "another-registry" } }] }], policy), []);
});

test("record names preserve resource access after alias collisions and version changes", () => {
  const policy = { domainId: "finance", status: "ACTIVE", resources: [
    { type: "Blueprint", id: "agent-template", registryId: "shared-registry", registryName: "blueprint_agent-template" },
  ] };
  const changed = { ...inventory.entries[0], id: "shared-registry/blueprint_agent-template",
    _registryName: "blueprint_agent-template", defaultVersion: "2.0.0",
    versions: [{ semver: "2.0.0", status: "APPROVED", _aws: { registryId: "shared-registry", recordId: "new-record" } }] };
  const filtered = filterDomainResourceEntries([changed], policy);
  assert.equal(filtered[0].id, "agent-template");
  assert.deepEqual(filterDomainResourceEntries([{ ...changed, _registryName: "different-resource" }], policy), []);
});

test("builder canonical record aliases use stable grants for managed domain catalogs", async () => {
  const resolver = createBuilderResourceAccessResolver({ inventoryProvider: async () =>
    ({ registry: { ...inventory, domainResourcePolicyApplied: true }, aiGateway: { tools: [] } }) });
  const result = await resolver({ identity: { role: "builder", activeDomain: "finance" },
    payload: { domainId: "finance", blueprintIds: ["shared-registry/record-a"],
      toolIds: [], mcpServerIds: [], skillIds: [], memoryIds: [], knowledgeBaseIds: [] } });
  assert.deepEqual(result, [{ resourceType: "BLUEPRINT", resourceId: "agent-template" }]);
});
