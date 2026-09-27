import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildSeedRecords } from "../bin/app";
import {
  REGISTRY_RECORD_VERSION_PATTERN,
} from "../lib/governed-descriptor";

const consoleDir = path.resolve(__dirname, "..", "..", "..", "console");
const seed = JSON.parse(
  fs.readFileSync(path.join(consoleDir, "registry-seed.json"), "utf8"),
);
const catalog = JSON.parse(
  fs.readFileSync(path.join(consoleDir, "catalog.json"), "utf8"),
);

function descriptorPayload(record: ReturnType<typeof buildSeedRecords>[number]) {
  const descriptor = record.recordType === "AGENT"
    ? record.descriptors.a2aAgentCard
    : record.recordType === "SKILL"
      ? record.descriptors.agentSkillsDefinition
      : record.descriptors.custom;
  return JSON.parse(descriptor.data);
}

test("the app builds all 23 real records with AWS-valid status targets", () => {
  const records = buildSeedRecords(seed, catalog);

  assert.equal(records.length, 23);
  assert.deepEqual(
    new Set(records.map((record) => record.status)),
    new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED"]),
  );
  const contractReview = records.find(
    (record) => record.name === "a2a_contract_review",
  );
  assert.equal(contractReview?.status, "PENDING_APPROVAL");
});

test("every seed recordVersion satisfies the registry service pattern", () => {
  const records = buildSeedRecords(seed, catalog);

  for (const record of records) {
    assert.match(record.version, REGISTRY_RECORD_VERSION_PATTERN);
    assert.ok(
      !record.version.includes("+"),
      `${record.name} version carries rejected + build metadata: `
        + record.version,
    );
  }
});

test("every platform seed carries the exact governed descriptor v1 metadata", () => {
  const records = buildSeedRecords(seed, catalog);

  for (const record of records) {
    const payload = descriptorPayload(record);
    assert.equal(payload.schemaVersion, 1);
    assert.deepEqual(
      Object.keys(payload["x-platform"]).sort(),
      [
        "domainId",
        "ownerSubject",
        "resourceId",
        "resourceType",
        "shared",
      ],
    );
    assert.equal(
      payload["x-platform"].domainId,
      record.registryRef.replaceAll("-", "_"),
    );
    assert.equal(
      payload["x-platform"].ownerSubject,
      "platform-bootstrap",
    );
    assert.equal(
      payload["x-platform"].resourceType,
      record.recordType === "AGENT"
        ? "AGENT"
        : record.recordType === "SKILL"
          ? "SKILL"
          : "BLUEPRINT",
    );
    assert.equal(
      payload["x-platform"].shared,
      record.registryRef === "shared",
    );
    // Blueprints republish on template-contract changes (1.1.0 added
    // model/tools/observability; 1.2.0 added the harness source pointer).
    // Registry versions are immutable, so a bump is the only way existing
    // accounts receive the new contract.
    assert.equal(
      record.version,
      record.name.startsWith("blueprint_")
        ? "1.3.0-platform-descriptor.1"
        : "1.0.0-platform-descriptor.1",
    );
  }

  const agent = records.find((record) =>
    record.name === "a2a_expense_auditor"
  );
  const skill = records.find((record) =>
    record.name === "skill_customer_support"
  );
  const blueprint = records.find((record) =>
    record.name === "blueprint_chat_assistant"
  );

  assert.equal(
    descriptorPayload(agent!)["x-platform"].resourceId,
    "expense-auditor",
  );
  assert.equal(
    descriptorPayload(skill!)["x-platform"].resourceId,
    "customer-support",
  );
  assert.equal(
    descriptorPayload(blueprint!)["x-platform"].resourceId,
    "chat-assistant",
  );
});

test("governed seeds preserve existing display and specification metadata", () => {
  const records = buildSeedRecords(seed, catalog);
  const agent = descriptorPayload(records.find((record) =>
    record.name === "a2a_expense_auditor"
  )!);
  const skill = descriptorPayload(records.find((record) =>
    record.name === "skill_knowledge_base"
  )!);
  const blueprint = descriptorPayload(records.find((record) =>
    record.name === "blueprint_chat_assistant"
  )!);

  assert.equal(agent.name, "Expense Auditor");
  assert.equal(
    agent.url,
    "https://agents.finance.example/expense-auditor",
  );
  assert.equal(
    agent["x-platform-metadata"].createdBy,
    "Finance domain team",
  );
  assert.equal(skill.displayName, "Knowledge Base");
  assert.equal(
    skill["x-platform-metadata"].gateway,
    "it-operations",
  );
  assert.equal(blueprint.displayName, "Chat Assistant");
  assert.equal(
    blueprint.template.framework,
    "Strands",
  );
  assert.equal(blueprint.git, undefined);
  assert.doesNotMatch(JSON.stringify(blueprint), /melanie531/i);
});

// The blueprint template contract: every published blueprint declares which
// model, tools and observability the platform pre-wired, and each reference
// resolves against the same seed data — a dangling reference fails synth.
test("every blueprint publishes resolvable model, tools and observability", () => {
  const records = buildSeedRecords(seed, catalog);
  const approvedModels = new Set(
    catalog.models
      .filter((model: any) => model.approved === true)
      .map((model: any) => model.id),
  );
  const seededResources = new Set(
    seed
      .filter((entry: any) => ["Skill", "MCPServer"].includes(entry.type))
      .map((entry: any) => entry.id),
  );
  const blueprints = records.filter((record) =>
    record.name.startsWith("blueprint_")
  );
  assert.equal(blueprints.length, catalog.blueprints.length);
  for (const record of blueprints) {
    const template = descriptorPayload(record).template;
    assert.ok(
      template.defaultModel === null
        || approvedModels.has(template.defaultModel),
      `${record.name}: defaultModel ${template.defaultModel}`,
    );
    assert.ok(Array.isArray(template.tools), `${record.name}: tools`);
    for (const tool of template.tools) {
      assert.ok(
        seededResources.has(tool),
        `${record.name}: tool ${tool} not seeded`,
      );
    }
    assert.ok(
      typeof template.observability === "string"
        && template.observability.length > 0,
      `${record.name}: observability`,
    );
  }
});

test("a dangling blueprint reference fails the build, not the console", () => {
  const broken = JSON.parse(JSON.stringify(catalog));
  broken.blueprints[0].template.defaultModel = "no-such-model";
  assert.throws(
    () => buildSeedRecords(seed, broken),
    /defaultModel "no-such-model"/,
  );
  const badTool = JSON.parse(JSON.stringify(catalog));
  badTool.blueprints[0].template.tools = ["no-such-tool"];
  assert.throws(() => buildSeedRecords(seed, badTool), /no-such-tool/);
  const noObs = JSON.parse(JSON.stringify(catalog));
  delete noObs.blueprints[0].template.observability;
  assert.throws(() => buildSeedRecords(seed, noObs), /observability/);
});

// Source provenance: repo-kind blueprints must have a real exportable harness
// in this repository; external kinds are shape-checked; a fabricated pointer
// fails synth. The demo cannot claim harness code that does not exist.
test("blueprint sources resolve: repo harnesses exist, external refs are well-formed", () => {
  const records = buildSeedRecords(seed, catalog);
  const byKind: Record<string, number> = {};
  for (const bp of catalog.blueprints) {
    byKind[bp.source.kind] = (byKind[bp.source.kind] || 0) + 1;
  }
  assert.ok(byKind.repo >= 2, "chat + workflow ship real harnesses");
  assert.ok(byKind.illustrative >= 1, "illustrative entries stay honest");
  for (const record of records.filter((r) => r.name.startsWith("blueprint_"))) {
    const source = descriptorPayload(record).source;
    assert.ok(
      ["repo", "github", "s3", "illustrative"].includes(source.kind),
      record.name,
    );
  }
  const fake = JSON.parse(JSON.stringify(catalog));
  fake.blueprints[0].source = { kind: "repo", templateId: "no-such-harness" };
  assert.throws(() => buildSeedRecords(seed, fake), /no-such-harness/);
  const badUrl = JSON.parse(JSON.stringify(catalog));
  badUrl.blueprints[0].source = { kind: "github", url: "http://evil.example" };
  assert.throws(() => buildSeedRecords(seed, badUrl), /github\.com/);
  const noSource = JSON.parse(JSON.stringify(catalog));
  delete noSource.blueprints[0].source;
  assert.throws(() => buildSeedRecords(seed, noSource), /source is required/);
});
