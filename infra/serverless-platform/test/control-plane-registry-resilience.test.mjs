import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlPlaneService,
  createRegistryInventoryService,
} from "../lambda/control-plane/service.mjs";

// Single-record fault isolation for the /api/registry control-plane read path.
// A single malformed/incompatible registry record must NOT 503 the whole
// catalog (which blanks the approval/governance page). Good records still
// return; the bad record is dropped (non-actionable, fail-closed) and the
// response carries an explicit incomplete/degraded flag so complete-catalog
// consumers ("nothing to approve"/"queue empty") suppress a misleading
// all-clear state. Verified with a SYNTHETIC bad record only.

const REGION = "us-west-2";
const ACCOUNT = "111122223333";
const SHARED = "SharedReg12345";
const CONFIG = {
  accountId: ACCOUNT,
  region: REGION,
  sharedRegistryId: SHARED,
  domainRegistryIds: {
    platform: "PlatformReg123",
    customer_support: "SupportReg1234",
    operations: "OperationsReg1",
  },
  llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  llmGatewayName: "agentic-demo-llm-gateway",
  llmGatewayRegion: "us-east-1",
  llmGatewayUrl:
    "https://agentic-demo-llm-gateway-abcdefghij.gateway."
    + "bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
  toolsGatewayId: "platform-tools-gw-klmnopqrst",
  toolsGatewayName: "platform-tools-gw",
  toolsGatewayUrl:
    "https://platform-tools-gw-klmnopqrst.gateway."
    + "bedrock-agentcore.us-west-2.amazonaws.com/mcp",
};
const ADMIN_SCOPE = { role: "admin", allowedDomains: [], activeDomain: null };

function arnFor(recordId) {
  return (
    `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
    + `registry/${SHARED}/record/${recordId}`
  );
}

function baseRecord({ recordId, name, recordType, status, descriptors }) {
  return {
    registryId: SHARED,
    registryArn: `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/${SHARED}`,
    recordId,
    recordArn: arnFor(recordId),
    name,
    displayName: name,
    description: `${name} description`,
    recordType,
    recordVersion: "1.0.0",
    status,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    descriptors,
  };
}

const GOOD_SKILL = baseRecord({
  recordId: "good-skill-01",
  name: "good_skill",
  recordType: "SKILL",
  status: "APPROVED",
  descriptors: {
    agentSkillsDefinition: {
      data: JSON.stringify({
        id: "good_skill",
        displayName: "Good Skill",
        "x-platform": {
          id: "good_skill",
          domain: "shared",
          tools: ["lookup"],
        },
      }),
    },
  },
});

const GOOD_BLUEPRINT = baseRecord({
  recordId: "good-blueprint1",
  name: "blueprint_good",
  recordType: "CUSTOM",
  status: "APPROVED",
  descriptors: {
    custom: {
      data: JSON.stringify({
        resourceKind: "blueprint",
        blueprintId: "good",
        displayName: "Good Blueprint",
        defaultVersion: "1.0.0",
        template: { framework: "Strands" },
      }),
    },
  },
});

// SYNTHETIC bad record: an APPROVED MCP record whose descriptor is valid JSON
// (so it passes identity/field integrity + descriptor presence) but is an
// incompatible/incomplete MCP server object missing required string fields.
// recordToVersion throws "Registry MCP descriptor is malformed." during
// content projection — the exact single-record fault the fix isolates. No
// real customer data; identity/ARN are well-formed.
const SYNTHETIC_BAD = baseRecord({
  recordId: "synthetic-bad1",
  name: "synthetic_bad_mcp",
  recordType: "MCP",
  status: "APPROVED",
  descriptors: {
    mcpServer: {
      data: JSON.stringify({ name: "synthetic-bad" }),
      dataSchemaVersion: "2025-03-26",
    },
  },
});

function harness(records) {
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const summaryOf = (record) => {
    const { descriptors, registryId, ...summary } = record;
    return summary;
  };
  const registryClient = {
    config: { credentials: async () => ({ accessKeyId: "AK", secretAccessKey: "s" }) },
    async send(command) {
      const name = command.constructor.name;
      if (name === "ListRegistryRecordsCommand") {
        return command.input.registryId === SHARED
          ? { registryRecords: records.map(summaryOf) }
          : { registryRecords: [] };
      }
      if (name === "GetRegistryRecordCommand") {
        return byId.get(command.input.recordId);
      }
      throw new Error(`Unexpected registry command ${name}`);
    },
  };
  const registryDiscoveryClient = {
    async send(command) {
      const [{ registryId, recordIds }] = command.input.entries;
      const found = recordIds
        .map((recordId) => byId.get(recordId))
        .filter((record) => record && record.status === "APPROVED");
      return {
        registryRecords: found,
        errors: recordIds
          .filter((recordId) => !byId.get(recordId)
            || byId.get(recordId).status !== "APPROVED")
          .map((recordId) => ({
            registryId,
            recordId,
            errorCode: "RESOURCE_NOT_FOUND",
          })),
      };
    },
  };
  const gatewayClient = {
    async send(command) {
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return { items: [] };
      }
      throw new Error(`Unexpected gateway command ${command.constructor.name}`);
    },
  };
  return createControlPlaneService({
    config: CONFIG,
    registryClient,
    registryDiscoveryClient,
    gatewayClient,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ data: [] }),
    }),
    credentials: { accessKeyId: "AK", secretAccessKey: "s" },
    clock: () => new Date("2026-09-13T00:00:00.000Z"),
  });
}

// (a) synthetic malformed record alongside valid ones -> valid ones returned +
// incomplete flag, no 500/503.
test("registry read returns valid records plus incomplete flag when one record is malformed", async () => {
  const service = harness([GOOD_SKILL, SYNTHETIC_BAD, GOOD_BLUEPRINT]);
  const result = await service.registry(ADMIN_SCOPE); // must not throw / 503
  assert.equal(result.ok, true);
  const ids = result.entries.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["good", "good_skill"]);
  assert.equal(result.incomplete, true);
  assert.equal(result.completeness, "incomplete");
  assert.equal(result.failedRecordCount, 1);
  assert.ok(Array.isArray(result.errors));
  assert.deepEqual(result.errors, [`${SHARED}/synthetic-bad1`]);
});

// (b) the bad record is non-actionable: it yields no entry and therefore no
// version an approver could decide/authorize on.
test("the malformed record is not projected and is therefore non-actionable", async () => {
  const service = harness([GOOD_SKILL, SYNTHETIC_BAD]);
  const result = await service.registry(ADMIN_SCOPE);
  for (const entry of result.entries) {
    assert.notEqual(entry._registryName, "synthetic_bad_mcp");
    assert.notEqual(entry.id, "synthetic_bad_mcp");
    // No entry carries a version tied to the bad record id.
    for (const version of entry.versions || []) {
      assert.notEqual(version?._aws?.recordId, "synthetic-bad1");
    }
  }
  assert.equal(result.entries.length, 1);
  assert.equal(result.incomplete, true);
});

// (c) empty-state / "no pending" logic must be suppressed when incomplete:
// the response exposes the incompleteness signal the pending-work projector
// (unfinished()) recognizes, so it reports complete=false / count=null.
test("an incomplete catalog exposes the signal that suppresses empty-state", async () => {
  const service = harness([SYNTHETIC_BAD, GOOD_SKILL]);
  const result = await service.registry(ADMIN_SCOPE);
  // The exact fields pending-work.mjs unfinished() keys off of.
  const unfinished =
    result.incomplete === true
    || result.completeness === "incomplete"
    || (Array.isArray(result.errors) && result.errors.length > 0);
  assert.equal(unfinished, true);
});

// (d) a fully-valid catalog behaves normally and is NOT falsely flagged.
test("a fully valid catalog is not flagged incomplete", async () => {
  const service = harness([GOOD_SKILL, GOOD_BLUEPRINT]);
  const result = await service.registry(ADMIN_SCOPE);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.incomplete, undefined);
  assert.equal(result.completeness, undefined);
  assert.equal(result.errors, undefined);
});

// Display and authorization readers must never share a resilient in-flight load.
for (const order of [true, false]) test(`strict/display concurrent isolation ${order}`, async () => {
  const service = harness([GOOD_SKILL, SYNTHETIC_BAD]);
  const strict = () => assert.rejects(service.registryOnly(ADMIN_SCOPE));
  const display = async () => assert.equal((await service.registry(ADMIN_SCOPE)).incomplete, true);
  await Promise.all(order ? [display(), strict()] : [strict(), display()]);
});
for (const mutation of [
  r => { r.recordArn += "wrong"; },
  r => { r.registryArn = r.registryArn.replace(ACCOUNT, "9988" + "77665544"); },
  r => { r.descriptorType = "AGENT"; },
  r => { r.status = "UNKNOWN"; },
]) test(`display does not downgrade identity/type/status corruption ${mutation}`, async () => {
  const bad = structuredClone(SYNTHETIC_BAD); mutation(bad);
  await assert.rejects(harness([GOOD_SKILL, bad]).registry(ADMIN_SCOPE));
});
test("missing descriptor is a display fault but fails strict reads", async () => {
  const bad = structuredClone(SYNTHETIC_BAD); delete bad.descriptors;
  const service = harness([GOOD_SKILL, bad]);
  assert.equal((await service.registry(ADMIN_SCOPE)).failedRecordCount, 1);
  await assert.rejects(service.registryOnly(ADMIN_SCOPE));
});

function targetHarness(mutate = () => {}) {
  const registryId = "SharedReg12345", recordId = "SyntheticRec";
  const record = baseRecord({recordId, name:"native_mcp", recordType:"MCP", status:"PENDING_APPROVAL",
    descriptors:{mcpServer:{data:JSON.stringify({name:"synthetic-mcp", description:"Synthetic MCP", version:"1.0.0"}),dataSchemaVersion:"2025-03-26"}}});
  mutate(record);
  const calls = [];
  const service = createRegistryInventoryService({config:CONFIG,registryClient:{async send(command){
    calls.push(command.constructor.name);
    assert.equal(command.constructor.name,"GetRegistryRecordCommand");
    assert.deepEqual(command.input,{registryId,recordId});return record;
  }}});
  return {service,calls,target:{registryId,recordId,id:"native_mcp",semver:"1.0.0"}};
}
test("authoritative native target read never scans unrelated broken descriptors",async()=>{
  const {service,calls,target}=targetHarness();
  const result=await service.registryTarget(ADMIN_SCOPE,target);
  assert.equal(result.entries[0].type,"MCPServer");assert.equal(result.entries[0].versions[0]._aws.recordId,target.recordId);
  assert.deepEqual(calls,["GetRegistryRecordCommand"]);
});
for (const patch of [
  r=>{r.descriptors.mcpServer.data='{"_source":"synthetic"}';},
  r=>{r.registryArn+='wrong';}, r=>{r.recordArn+='wrong';},
  r=>{r.recordVersion="2.0.0";}, r=>{r.recordType="SKILL";},
]) test(`exact target fails closed ${patch}`,async()=>{
  const {service,target}=targetHarness(patch);await assert.rejects(service.registryTarget(ADMIN_SCOPE,target));
});
test("target scope and out-of-scope registry fail before Get",async()=>{
 const {service,target,calls}=targetHarness();
 await assert.rejects(service.registryTarget({...ADMIN_SCOPE,role:"builder"},target));
 await assert.rejects(service.registryTarget(ADMIN_SCOPE,{...target,registryId:CONFIG.domainRegistryIds.operations}));
 assert.equal(calls.length,0);
});

test("resource-use inventories stay strict even after a display read",async()=>{
 const service=harness([GOOD_SKILL,SYNTHETIC_BAD]);await service.registry(ADMIN_SCOPE);
 await assert.rejects(service.inventory(ADMIN_SCOPE));await assert.rejects(service.resourceInventory(ADMIN_SCOPE));
});
