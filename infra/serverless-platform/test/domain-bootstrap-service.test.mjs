import test from "node:test";
import assert from "node:assert/strict";
import { createBootstrapService, resolveConfiguration, fingerprint, STEPS, BootstrapError, environmentRequestToken } from "../lambda/domain-bootstrap/service.mjs";
import { foundationCatalog } from "../../../console/public/domain-foundation-catalog.mjs";

const actor = { subject: "admin-subject", username: "admin", role: "admin", activeDomain: null, domainIds: [] };
const target = { accountId: "123456789012", region: "us-west-2" };
function fixture() {
  const inventory = { ok: true, entries: [
    { id: "foundation", type: "Blueprint", domain: "shared", name: "Enterprise foundation", defaultVersion: "1.2.0",
      versions: [{ semver: "1.2.0", status: "APPROVED", _aws: { registryId: "shared-registry", recordId: "blueprint-record" },
        content: { template: { deployTarget: "AgentCore Runtime", defaultModel: "model-a", tools: ["tool-a"], observability: "Registry telemetry", domainDefault: true } } }] },
    { id: "model-a", type: "Model", domain: "shared", name: "Model A", defaultVersion: "1.0.0",
      versions: [{ semver: "1.0.0", status: "APPROVED", content: { gatewayModelId: "model-a" } }] },
    { id: "tool-a", type: "Skill", domain: "shared", name: "Tool A", defaultVersion: "1.0.0",
      versions: [{ semver: "1.0.0", status: "APPROVED", _aws: { registryId: "shared-registry", recordId: "tool-record" }, content: {} }] },
  ] };
  const catalog = foundationCatalog(inventory);
  const config = { name: "Finance", description: "Finance agents", owner: "Finance team", administrator: "alice",
    ...target, environments: ["dev"], blueprints: [catalog.blueprints[0].ref],
    models: [catalog.models[0].ref], resources: catalog.resources.map(entry => entry.ref) };
  let operation = null, starts = 0, calls = [];
  const store = {
    async get() { return structuredClone(operation); },
    async create(next) { assert.equal(operation, null); operation = structuredClone(next); },
    async replace(next, previous) {
      assert.equal(fingerprint(operation), fingerprint(previous), "conditional state update");
      operation = structuredClone(next);
    },
  };
  const actions = Object.fromEntries(STEPS.slice(1).map(([step]) => [step, async () => { calls.push(step); return { [step]: true }; }]));
  actions.verifyActor = async () => {};
  actions.preflight = async () => {};
  const admins = [{ username: "alice", subject: "alice-subject", enabled: true, eligible: true, role: "domain-lead" },
    { username: "admin", subject: "admin-subject", enabled: true, eligible: true, role: "platform-admin" }];
  const service = createBootstrapService({ store, target, actions,
    registry: async () => structuredClone(inventory),
    administrators: async () => structuredClone(admins),
    workflows: { async start() { starts++; } } });
  return { service, config, inventory, admins, actions, store, calls, get starts() { return starts; } };
}
test("current Platform Admin is selectable without an existing Domain Lead role", async () => {
  const f = fixture();
  f.admins.splice(0, 1);
  const catalog = await f.service.catalog(actor);
  assert.equal(catalog.defaultAdministrator, "admin");
  const result = await f.service.preview(actor, { ...f.config, administrator: "admin" });
  assert.deepEqual(result.resolved.administrator, { username: "admin", subject: "admin-subject" });
});
test("review remains reachable for failed prerequisites while submission stays blocked", async () => {
  const f = fixture();
  f.inventory.entries[0].versions[0].status = "DRAFT";
  const review = await f.service.review(actor, f.config);
  assert.equal(review.ready, false);
  assert.equal(review.config.name, "Finance");
  assert.equal(review.blockers[0].code, "REGISTRY_CHANGED");
  assert.equal(Object.hasOwn(review, "previewHash"), false);
  await assert.rejects(f.service.start(actor, { configuration: f.config, previewHash: "forged" }), { code: "REGISTRY_CHANGED" });
  assert.equal(await f.store.get(), null);
  f.inventory.entries[0].versions[0].status = "APPROVED";
  assert.equal((await f.service.review(actor, f.config)).ready, true);
});
test("disabled, conflicting-role and replaced identities cannot receive ownership", async () => {
  const f = fixture();
  const reviewed = await f.service.preview(actor, f.config);
  f.admins[0].eligible = false;
  await assert.rejects(f.service.preview(actor, f.config), { code: "ADMINISTRATOR_UNAVAILABLE" });
  f.admins[0].eligible = true;
  f.admins[0].enabled = false;
  await assert.rejects(f.service.preview(actor, f.config), { code: "ADMINISTRATOR_UNAVAILABLE" });
  f.admins[0].enabled = true;
  f.admins[0].subject = "recreated-user";
  await assert.rejects(f.service.start(actor, { configuration: f.config, previewHash: reviewed.previewHash }), { code: "REGISTRY_CHANGED" });
});
test("defaults are resolved entirely from approved Registry content", () => {
  const f = fixture(); const catalog = foundationCatalog(f.inventory);
  assert.equal(catalog.blueprints[0].ref.id, "foundation");
  assert.equal(Object.hasOwn(catalog, "defaultBlueprint"), false);
  f.inventory.entries[0].versions[0].content.template.observability = "New Registry telemetry";
  assert.equal(foundationCatalog(f.inventory).blueprints[0].content.template.observability, "New Registry telemetry");
  f.inventory.entries[0].versions[0].status = "DRAFT";
  assert.equal(foundationCatalog(f.inventory).blueprints.length, 0);
});
test("incomplete inventory, ambiguous versions and foreign scopes never become defaults", () => {
  const f = fixture();
  assert.throws(() => foundationCatalog({ ...f.inventory, incomplete: true }));
  f.inventory.entries[0].versions.push(structuredClone(f.inventory.entries[0].versions[0]));
  assert.equal(foundationCatalog(f.inventory).blueprints.length, 0);
  f.inventory.entries[1].domain = "other";
  assert.equal(foundationCatalog(f.inventory).models.length, 0);
});
test("unrelated unreadable records do not block environment initialization or valid selections", async () => {
  const f = fixture();
  f.inventory.incomplete = true;
  assert.equal((await f.service.catalog(actor)).incomplete, true);
  assert.equal((await f.service.preview(actor, f.config)).warnings[0].code, "REGISTRY_PARTIAL");
  const empty = { ...f.config, blueprints: [], models: [], resources: [] };
  assert.equal((await f.service.review(actor, empty)).ready, true);
  f.inventory.entries[0].versions[0].status = "DEPRECATED";
  await assert.rejects(f.service.preview(actor, f.config), { code: "REGISTRY_CHANGED" });
});
test("preview contains no projects and rejects unconnected AWS targets or unassigned administrators", async () => {
  const { service, config } = fixture();
  const preview = await service.preview(actor, config);
  assert.equal(preview.config.domainId, "finance");
  assert.equal(Object.hasOwn(preview.config, "projects"), false);
  await assert.rejects(service.preview(actor, { ...config, accountId: "999999999999" }), { code: "TARGET_NOT_CONNECTED" });
  await assert.rejects(service.preview(actor, { ...config, administrator: "unknown" }), { code: "ADMINISTRATOR_UNAVAILABLE" });
  await assert.rejects(service.preview({ ...actor, role: "lead" }, config), { code: "FORBIDDEN" });
});
test("domain initialization does not require an agent blueprint or its model/tool/hosting contract", async () => {
  const f = fixture();
  f.inventory.entries[0].versions[0].content.template = { deployTarget: "EKS" };
  assert.equal((await f.service.review(actor, { ...f.config, models: [], resources: [] })).ready, true);
  const second = structuredClone(f.inventory.entries[0]);
  second.id = "another-blueprint";
  second.versions[0]._aws.recordId = "second-record";
  f.inventory.entries.push(second);
  const model = structuredClone(f.inventory.entries[1]); model.id = "model-b";
  f.inventory.entries.push(model);
  const catalog = foundationCatalog(f.inventory);
  const result = await f.service.preview(actor, { ...f.config,
    blueprints: catalog.blueprints.map(e => e.ref), models: catalog.models.map(e => e.ref) });
  assert.equal(result.resolved.blueprints.length, 2);
  assert.equal(result.resolved.models.length, 2);
  await assert.rejects(f.service.preview(actor, { ...f.config, models: [f.config.models[0], f.config.models[0]] }), { code: "INVALID_CONFIGURATION" });
});
test("content changes between preview and submission require a new review", async () => {
  const f = fixture(); const preview = await f.service.preview(actor, f.config);
  f.inventory.entries[0].versions[0].content.template.observability = "Changed baseline";
  await assert.rejects(f.service.start(actor, { configuration: f.config, previewHash: preview.previewHash }), { code: "REGISTRY_CHANGED" });
  assert.equal(await f.store.get(), null);
});
test("repeated submission preserves operation identity and completed steps are not replayed", async () => {
  const f = fixture(); const preview = await f.service.preview(actor, f.config);
  const input = { configuration: f.config, previewHash: preview.previewHash };
  await f.service.start(actor, input); await f.service.start(actor, input);
  for (const [step] of STEPS) await f.service.execute("finance", step, 1);
  const { operation } = await f.service.read(actor, "finance");
  assert.equal(operation.status, "SUCCEEDED");
  assert.equal(operation.steps.filter(step => step.status === "SUCCEEDED").length, 6);
  assert.equal(Object.hasOwn(operation, "actor"), false);
  await f.service.start(actor, input);
  assert.deepEqual(f.calls, ["domain", "identity", "model", "environments", "verify"]);
});
test("out-of-order steps and foreign domain reads are rejected", async () => {
  const f = fixture(); const p = await f.service.preview(actor, f.config);
  await f.service.start(actor, { configuration: f.config, previewHash: p.previewHash });
  await assert.rejects(f.service.execute("finance", "model", 1), { code: "OUT_OF_ORDER" });
  await assert.rejects(f.service.read({ ...actor, role: "lead", activeDomain: "other", domainIds: ["other"] }, "finance"), { code: "NOT_FOUND" });
  assert.equal((await f.service.read({ ...actor, role: "lead", activeDomain: "finance", domainIds: ["finance"] }, "finance")).operation.status, "QUEUED");
});
test("failed operations retain completed work and resume only the same reviewed Registry definitions", async () => {
  const f = fixture(); const p = await f.service.preview(actor, f.config);
  await f.service.start(actor, { configuration: f.config, previewHash: p.previewHash });
  await f.service.execute("finance", "registry", 1);
  await f.service.execute("finance", "domain", 1);
  await f.service.failure("finance", 1, new Error("private internal error"));
  assert.doesNotMatch((await f.store.get()).error, /private internal/);
  const retried = await f.service.retry(actor, "finance");
  assert.equal(retried.operation.attempt, 2);
  assert.equal(retried.operation.steps[1].status, "SUCCEEDED");
  for (const [step] of STEPS) await f.service.execute("finance", step, 2);
  assert.equal(f.calls.filter(step => step === "domain").length, 1);
});
test("Registry revocation prevents execution and later retries", async () => {
  const f = fixture(); const p = await f.service.preview(actor, f.config);
  await f.service.start(actor, { configuration: f.config, previewHash: p.previewHash });
  f.inventory.entries[0].versions[0].status = "DEPRECATED";
  await assert.rejects(f.service.execute("finance", "registry", 1), { code: "REGISTRY_CHANGED" });
  await f.service.failure("finance", 1, new Error());
  await assert.rejects(f.service.retry(actor, "finance"), { code: "REGISTRY_CHANGED" });
});
test("AWS Registry still provisioning remains resumable within the same workflow attempt", async () => {
  const f = fixture(); const p = await f.service.preview(actor, f.config);
  await f.service.start(actor, { configuration: f.config, previewHash: p.previewHash });
  await f.service.execute("finance", "registry", 1);
  f.actions.domain = async () => { throw new BootstrapError("DOMAIN_PROVISIONING_FAILED", "Registry is still creating.", 503); };
  await assert.rejects(f.service.execute("finance", "domain", 1), { name: "FoundationInProgress" });
  assert.equal((await f.store.get()).status, "RUNNING");
  f.actions.domain = async () => ({ domain: { id: "finance" } });
  await f.service.execute("finance", "domain", 1);
  assert.equal((await f.store.get()).steps[1].status, "SUCCEEDED");
});
test("CloudFormation request tokens accept multiword domain IDs and separate retry attempts", () => {
  const operation = { domainId: "customer_support", attempt: 1 };
  const token = environmentRequestToken(operation);
  assert.match(token, /^[a-zA-Z0-9][-a-zA-Z0-9]*$/);
  assert.ok(token.length <= 128);
  assert.equal(environmentRequestToken(operation), token);
  assert.notEqual(environmentRequestToken({ ...operation, attempt: 2 }), token);
  assert.notEqual(environmentRequestToken({ ...operation, domainId: "finance" }), token);
});
