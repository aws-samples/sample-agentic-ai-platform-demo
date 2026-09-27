import test from "node:test"
import assert from "node:assert/strict"
import { recordsToEntries } from "./registry-shape.mjs"

// Per-record fault isolation for the control-plane catalog projection.
// A single malformed/incompatible registry record must not throw out of the
// whole projection (which would 503 the entire /api/registry catalog and
// blank the approval/governance page). Good records must still project; the
// bad record must be reported and dropped (non-actionable, fail-closed).

const GOOD_AGENT = {
  registryId: "shared-registry1",
  recordId: "good-record-1",
  recordArn:
    "arn:aws:agent-registry:us-west-2:111122223333:registry/shared-registry1/record/good-record-1",
  name: "good_agent",
  displayName: "Good Agent",
  recordVersion: "1.0.0",
  recordType: "AGENT",
  status: "PENDING_APPROVAL",
  descriptors: {
    a2aAgentCard: {
      data: JSON.stringify({
        name: "Good Agent",
        url: "https://agents.example/good",
        "x-platform": { id: "good-agent", domain: "shared" },
      }),
    },
  },
}

const SECOND_GOOD_SKILL = {
  registryId: "shared-registry1",
  recordId: "good-record-2",
  recordArn:
    "arn:aws:agent-registry:us-west-2:111122223333:registry/shared-registry1/record/good-record-2",
  name: "good_skill",
  displayName: "Good Skill",
  recordVersion: "1.0.0",
  recordType: "SKILL",
  status: "APPROVED",
  descriptors: {
    agentSkillsDefinition: {
      data: JSON.stringify({
        id: "good_skill",
        displayName: "Good Skill",
        "x-platform": { id: "good_skill", domain: "shared", tools: ["lookup"] },
      }),
    },
  },
}

// A synthetic malformed MCP record: descriptor.data is not valid JSON, which
// makes recordToVersion throw "Registry MCP descriptor is malformed." This is
// a SYNTHETIC bad record — no real customer data.
const SYNTHETIC_BAD_MCP = {
  registryId: "shared-registry1",
  recordId: "bad-record-x",
  recordArn:
    "arn:aws:agent-registry:us-west-2:111122223333:registry/shared-registry1/record/bad-record-x",
  name: "synthetic_bad_mcp",
  displayName: "Synthetic Bad MCP",
  recordVersion: "1.0.0",
  recordType: "MCP",
  status: "APPROVED",
  descriptors: {
    mcpServer: { data: "{ this is not valid json" },
  },
}

test("resilient projection returns valid entries and reports one bad record", () => {
  const faults = []
  const entries = recordsToEntries(
    [GOOD_AGENT, SYNTHETIC_BAD_MCP, SECOND_GOOD_SKILL],
    () => "shared",
    (recordId) => faults.push(recordId),
  )
  // Both good records project; the bad one is dropped, not thrown.
  const ids = entries.map((entry) => entry.id).sort()
  assert.deepEqual(ids, ["good-agent", "good_skill"])
  // The bad record is reported by (registryId/recordId) identity.
  assert.deepEqual(faults, ["shared-registry1/bad-record-x"])
})

test("a dropped bad record contributes no versions (non-actionable / fail-closed)", () => {
  const faults = []
  const entries = recordsToEntries(
    [GOOD_AGENT, SYNTHETIC_BAD_MCP],
    () => "shared",
    (recordId) => faults.push(recordId),
  )
  // No projected entry corresponds to the bad record, so there is no version
  // an approver could decide/authorize on — the bad record is not decidable.
  for (const entry of entries) {
    assert.notEqual(entry.id, "synthetic_bad_mcp")
    assert.notEqual(entry._registryName, "synthetic_bad_mcp")
  }
  assert.equal(entries.length, 1)
  assert.equal(faults.length, 1)
})

test("without a fault callback the historical throw-on-fault contract is preserved", () => {
  assert.throws(
    () => recordsToEntries([GOOD_AGENT, SYNTHETIC_BAD_MCP], () => "shared"),
    /Registry MCP descriptor is malformed\./,
  )
})

test("a faulted record does not corrupt identity de-duplication of good records", () => {
  // Bad record shares no identity with good records; a later good record with
  // a distinct identity must still project after the bad one is rolled back.
  const faults = []
  const entries = recordsToEntries(
    [SYNTHETIC_BAD_MCP, GOOD_AGENT],
    () => "shared",
    (recordId) => faults.push(recordId),
  )
  assert.deepEqual(entries.map((entry) => entry.id), ["good-agent"])
  assert.deepEqual(faults, ["shared-registry1/bad-record-x"])
})

test("a fully valid catalog reports no faults", () => {
  const faults = []
  const entries = recordsToEntries(
    [GOOD_AGENT, SECOND_GOOD_SKILL],
    () => "shared",
    (recordId) => faults.push(recordId),
  )
  assert.equal(entries.length, 2)
  assert.equal(faults.length, 0)
})

test("display never downgrades duplicate record identity or duplicate version", () => {
  for (const second of [GOOD_AGENT, {...GOOD_AGENT, recordId: "another-record"}]) {
    assert.throws(() => recordsToEntries([GOOD_AGENT, second], () => "shared", () => {}), /duplicated/)
  }
})
