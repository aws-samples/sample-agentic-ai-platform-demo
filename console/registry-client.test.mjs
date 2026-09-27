// Unit tests for the AWS Agent Registry mapper (record → legacy ai-registry
// entry shape) and the injectable backend, on RECORDED fixtures captured from
// the real seeded registries (console/registry-client-fixture.json, account id
// redacted) — no live AWS calls anywhere in this file.
// Run: node --test console/registry-client.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  legacyStatus, recordToVersion, recordsToEntries, gatewayTargetToMcpEntry,
  buildDescriptors, sanitizeRecordName, createRegistryBackend,
} from "./registry-client.mjs"

const FIX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "registry-client-fixture.json"), "utf8"))

test("legacyStatus maps wire statuses to the frontend lifecycle names", () => {
  assert.equal(legacyStatus("PENDING_APPROVAL"), "IN_REVIEW")
  assert.equal(legacyStatus("APPROVED"), "APPROVED")
  assert.equal(legacyStatus("REJECTED"), "REJECTED")
  assert.equal(legacyStatus("CREATING"), "DRAFT")
  assert.equal(legacyStatus("SOMETHING_NEW"), "DRAFT")
})

test("AGENT record maps to an A2AAgent entry with card content and x-platform metadata", () => {
  const { entry, version } = recordToVersion(FIX.AGENT)
  assert.equal(entry.type, "A2AAgent")
  assert.equal(entry.id, "expense-auditor")            // x-platform id, not the record name
  assert.equal(entry.domain, "shared")
  assert.equal(entry.domainOwner, "Finance domain team")
  assert.equal(version.status, "APPROVED")
  assert.equal(version.semver, "1.0.0")
  assert.equal(version.content.baseUrl, "https://agents.finance.example/expense-auditor")
  assert.equal(version.content.card.name, "Expense Auditor")
  assert.deepEqual(version.content.access, ["admin", "builder"])
  assert.equal(version._aws.recordId, "fQjuycvUNRL1")  // write path needs registryId+recordId
  assert.equal(version._aws.registryId, "Kg5Lpvu8XJorSs6D")
})

test("SKILL record maps to a Skill entry with toolType split intact", () => {
  const { entry, version } = recordToVersion(FIX.SKILL)
  assert.equal(entry.type, "Skill")
  assert.equal(entry.id, "code_interpreter")
  assert.equal(version.content.toolType, "agentcore_code_interpreter") // wizard splits skills vs typed tools on this
  assert.equal(version.status, "APPROVED")
})

test("CUSTOM blueprint record maps to a Blueprint entry with template content", () => {
  const { entry, version } = recordToVersion(FIX.CUSTOM)
  assert.equal(entry.type, "Blueprint")
  assert.equal(entry.id, "action-agent")
  assert.equal(entry.domain, "shared")
  assert.equal(entry.defaultVersion, "1.0.0")
  assert.equal(version.content.template.framework, "Strands")
  assert.ok(version.content.compat["Claude Agent SDK"])
})

test("non-blueprint CUSTOM and unknown record types are skipped, not crashed", () => {
  const other = { ...FIX.CUSTOM, descriptors: { custom: { data: JSON.stringify({ resourceKind: "something-else" }) } } }
  assert.equal(recordToVersion(other), null)
  assert.throws(() => recordToVersion({ ...FIX.AGENT, recordType: "MCP" }), /MCP descriptor is malformed/)
  assert.equal(recordToVersion({ ...FIX.AGENT, recordType: "UNKNOWN" }), null)
  const malformed = { ...FIX.SKILL, descriptors: { agentSkillsDefinition: { data: "{not json" } } }
  assert.ok(recordToVersion(malformed)) // unparseable data degrades to empty content, never throws
})

test("DRAFT control-plane record keeps DRAFT status and no decided fields", () => {
  const { version } = recordToVersion(FIX.CONTROL_DRAFT)
  assert.equal(version.status, "DRAFT")
  assert.equal(version.decidedBy, null)
  assert.equal(version.decidedAt, null)
})

test("recordsToEntries groups name+version records into one entry with sorted versions", () => {
  const v2 = { ...FIX.AGENT, recordId: "otherRecordId", recordVersion: "2.0.0", status: "DRAFT" }
  const entries = recordsToEntries([v2, FIX.AGENT, FIX.SKILL])
  assert.equal(entries.length, 2)
  const agent = entries.find(e => e.type === "A2AAgent")
  assert.deepEqual(agent.versions.map(v => v.semver), ["1.0.0", "2.0.0"]) // semver-sorted
  assert.equal(agent.defaultVersion, "1.0.0")          // highest APPROVED, not highest overall
  assert.equal(agent.name, "Expense Auditor")          // displayName, not the sanitized record name
})

test("recordsToEntries falls back to the registry-derived domain when x-platform lacks one", () => {
  const bare = { ...FIX.AGENT, descriptors: { a2aAgentCard: { data: JSON.stringify({ name: "n", url: "https://x" }) } } }
  const entries = recordsToEntries([bare], () => "operations")
  assert.equal(entries[0].domain, "operations")
})

test("READY gateway target maps to an APPROVED MCPServer entry (D9: gateway read, not registry)", () => {
  const e = gatewayTargetToMcpEntry(FIX.GATEWAY_TARGET_READY, {
    gatewayId: "platform-tools-gw-example123",
    name: "platform-tools-gw",
  })
  assert.equal(e.type, "MCPServer")
  assert.equal(
    e.id,
    `platform-tools-gw-example123/${FIX.GATEWAY_TARGET_READY.targetId}`,
  )
  assert.equal(e.source, "tools-gateway")
  assert.equal(e.versions[0].status, "APPROVED")
  assert.equal(e.versions[0].content.url, "https://knowledge-mcp.global.api.aws")
  assert.equal(e.versions[0].content.gatewayTargetStatus, "READY")
})

test("FAILED gateway target surfaces as DRAFT (not APPROVED, not hidden)", () => {
  const e = gatewayTargetToMcpEntry(FIX.GATEWAY_TARGET_FAILED, {
    gatewayId: "platform-tools-gw-example123",
    name: "platform-tools-gw",
  })
  assert.equal(e.versions[0].status, "DRAFT")
  assert.equal(e.versions[0].content.gatewayTargetStatus, "FAILED")
})

test("buildDescriptors round-trips through recordToVersion for each write-path type", () => {
  for (const [type, id] of [["A2AAgent", "my-agent"], ["Skill", "my_skill"], ["Blueprint", "my-bp"]]) {
    const built = buildDescriptors(type, {
      id,
      name: "My Thing",
      description: "desc",
      domain: "operations",
      content: {
        domain: "untrusted-content-domain",
        baseUrl: "https://x",
        template: { framework: "Strands" },
        createdBy: "builder-sub",
      },
      semver: "1.0.0",
    })
    assert.ok(built.recordType, `${type} builds a recordType`)
    const descriptor = JSON.parse(
      built.descriptors[
        built.recordType === "AGENT"
          ? "a2aAgentCard"
          : built.recordType === "SKILL"
            ? "agentSkillsDefinition"
            : "custom"
      ].data,
    )
    assert.equal(descriptor.schemaVersion, 1)
    assert.deepEqual(descriptor["x-platform"], {
      domainId: "operations",
      ownerSubject: "builder-sub",
      resourceId: id,
      resourceType:
        type === "A2AAgent"
          ? "AGENT"
          : type === "Skill"
            ? "SKILL"
            : "BLUEPRINT",
      shared: false,
    })
    assert.equal(built.recordVersion, "1.0.0-platform-descriptor.1")
    const back = recordToVersion({ recordType: built.recordType, descriptors: built.descriptors, recordVersion: built.recordVersion, status: "DRAFT", name: id, registryId: "r", recordId: "x" })
    assert.ok(back, `${type} descriptor maps back`)
    assert.equal(back.entry.id, id)
    assert.equal(back.entry.domain, null)
    assert.equal(
      back.version.semver,
      "1.0.0-platform-descriptor.1",
    )
    assert.equal(back.version.createdBy, "builder-sub")
  }
  assert.equal(buildDescriptors("Model", { id: "m" }), null) // D8: models never become records
})

test("buildDescriptors uses shared config and rejects untrusted owner subjects", () => {
  const built = buildDescriptors("Skill", {
    id: "shared-skill",
    name: "Shared Skill",
    description: "desc",
    domain: "shared",
    content: {
      domain: "operations",
      createdBy: "Person With Spaces",
    },
    semver: "2.0.0",
  })
  const descriptor = JSON.parse(
    built.descriptors.agentSkillsDefinition.data,
  )

  assert.deepEqual(descriptor["x-platform"], {
    domainId: "shared",
    ownerSubject: "platform-bootstrap",
    resourceId: "shared-skill",
    resourceType: "SKILL",
    shared: true,
  })
})

test("sanitizeRecordName enforces the registry name charset", () => {
  assert.equal(sanitizeRecordName("skill_code-interpreter"), "skill_code_interpreter")
  assert.equal(sanitizeRecordName("9lives"), "x_9lives")
})

// ---- backend on a stub client (no AWS) -----------------------------------------

const CONFIG = {
  region: "us-west-2",
  registries: {
    shared: { name: "platform_shared", registryId: "Kg5Lpvu8XJorSs6D", registryArn: "arn:shared" },
    domains: { operations: { name: "domain_operations", registryId: "yjSLeCoKg7C4yE8a", registryArn: "arn:ops" } },
  },
  toolsGateway: { name: "platform-tools-gw", gatewayId: "gw-1", gatewayUrl: "https://gw/mcp" },
}

function stubClients(calls) {
  const control = {
    send: async cmd => {
      calls.push(cmd)
      const n = cmd.constructor.name
      if (n === "ListRegistryRecordsCommand") {
        const recs = cmd.input.registryId === "Kg5Lpvu8XJorSs6D" ? [FIX.SKILL, FIX.CUSTOM] : [FIX.CONTROL_DRAFT]
        return { registryRecords: recs.map(r => ({ ...r, descriptors: undefined })) }
      }
      if (n === "GetRegistryRecordCommand") {
        const all = [FIX.SKILL, FIX.CUSTOM, FIX.CONTROL_DRAFT]
        return all.find(r => r.recordId === cmd.input.recordId)
      }
      if (n === "UpdateRegistryRecordStatusCommand") return {}
      if (n === "CreateRegistryRecordCommand") return { recordArn: "arn:x/record/newRec123", status: "CREATING" }
      if (n === "TagResourceCommand") return {}
      if (n === "SubmitRegistryRecordForApprovalCommand") return {}
      throw new Error(`unexpected control command ${n}`)
    },
  }
  const data = {
    send: async cmd => {
      calls.push(cmd)
      if (cmd.constructor.name === "SearchDiscoverableRegistryRecordsCommand") {
        assert.equal(cmd.input.registryIds.length, 1) // API constraint: one registry per call
        return { registryRecords: cmd.input.registryIds[0] === "arn:shared" ? [FIX.SEARCH_SAMPLE] : [] }
      }
      throw new Error("unexpected data command")
    },
  }
  const listGatewayTargets = async () => ({ items: [FIX.GATEWAY_TARGET_READY, FIX.GATEWAY_TARGET_FAILED] })
  return { control, data, listGatewayTargets }
}

test("backend.entries merges control-plane records with gateway MCP targets", async () => {
  const calls = []
  const backend = createRegistryBackend(CONFIG, stubClients(calls))
  const entries = await backend.entries()
  const types = entries.map(e => e.type).sort()
  assert.deepEqual(types, ["A2AAgent", "Blueprint", "MCPServer", "MCPServer", "Skill"])
  const draft = entries.find(e => e.type === "A2AAgent")
  assert.equal(draft.versions[0].status, "DRAFT")     // owner view includes DRAFT (D6)
  assert.equal(draft.domain, "operations")
  // cached on the second read — no extra AWS round trips
  const before = calls.length
  await backend.entries()
  assert.equal(calls.length, before)
})

test("backend.entries rejects a final Registry and Gateway ID collision", async () => {
  const collisionId =
    `${CONFIG.toolsGateway.gatewayId}/${FIX.GATEWAY_TARGET_READY.targetId}`
  const collidingSkill = structuredClone(FIX.SKILL)
  const descriptor = JSON.parse(
    collidingSkill.descriptors.agentSkillsDefinition.data,
  )
  descriptor["x-platform"].id = collisionId
  collidingSkill.descriptors.agentSkillsDefinition.data =
    JSON.stringify(descriptor)

  const clients = stubClients([])
  clients.control.send = async cmd => {
    const name = cmd.constructor.name
    if (name === "ListRegistryRecordsCommand") {
      return cmd.input.registryId === CONFIG.registries.shared.registryId
        ? {
            registryRecords: [
              { ...collidingSkill, descriptors: undefined },
            ],
          }
        : { registryRecords: [] }
    }
    if (name === "GetRegistryRecordCommand") return collidingSkill
    throw new Error(`unexpected control command ${name}`)
  }

  const backend = createRegistryBackend(CONFIG, clients)
  await assert.rejects(
    backend.entries(),
    /Registry entry ID/,
  )
})

test("backend.search filters real control-plane records locally", async () => {
  const backend = createRegistryBackend(CONFIG, stubClients([]))
  const hits = await backend.search("blueprint")
  assert.equal(hits.length, 1)
  assert.equal(hits[0].type, "Blueprint")
  assert.equal(hits[0].id, "action-agent")
})

test("backend.search domain scoping returns shared records but not foreign domains", async () => {
  const backend = createRegistryBackend(CONFIG, stubClients([]))
  const hits = await backend.search("code", { domains: ["customer-support"] })
  assert.deepEqual(hits.map(h => h.domain), ["shared"])
})

test("backend.decide sends UpdateRegistryRecordStatus with a statusReason", async () => {
  const calls = []
  const backend = createRegistryBackend(CONFIG, stubClients(calls))
  await backend.decide({ registryId: "r1", recordId: "rec1", decision: "reject", reason: "missing auth scheme", decidedBy: "admin" })
  const cmd = calls.find(c => c.constructor.name === "UpdateRegistryRecordStatusCommand")
  assert.equal(cmd.input.status, "REJECTED")
  assert.equal(cmd.input.statusReason, "missing auth scheme")
})

test("backend.createRecord targets the domain registry and returns ids for submit", async () => {
  const calls = []
  const backend = createRegistryBackend(CONFIG, stubClients(calls))
  const r = await backend.createRecord({ type: "Skill", id: "new_skill", name: "New Skill", description: "d", content: {}, semver: "1.0.0", domain: "operations" })
  const cmd = calls.find(c => c.constructor.name === "CreateRegistryRecordCommand")
  assert.equal(cmd.input.registryId, "yjSLeCoKg7C4yE8a") // operations registry, not shared
  assert.equal(cmd.input.name, "skill_new_skill")
  assert.equal(cmd.input.recordVersion, "1.0.0-platform-descriptor.1")
  const descriptor = JSON.parse(
    cmd.input.descriptors.agentSkillsDefinition.data,
  )
  assert.equal(descriptor["x-platform"].domainId, "operations")
  assert.equal(r.recordId, "newRec123")
})

test("backend.createRecord rejects a domain that has no configured Registry", async () => {
  const calls = []
  const backend = createRegistryBackend(CONFIG, stubClients(calls))

  await assert.rejects(
    backend.createRecord({
      type: "Skill",
      id: "fallback_skill",
      name: "Fallback Skill",
      description: "d",
      content: { domain: "content-domain" },
      semver: "1.0.0",
      domain: "unconfigured-domain",
    }),
    /domain is not configured/i,
  )
  assert.equal(
    calls.some((call) =>
      call.constructor.name === "CreateRegistryRecordCommand"),
    false,
  )
})
