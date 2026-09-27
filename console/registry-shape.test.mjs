import test from "node:test"
import assert from "node:assert/strict"

test("legacy native governed MCP descriptors remain readable without changing approval or ownership", () => {
  const record = { recordType: "MCP", name: "legacy-mcp", recordId: "legacy-record",
    recordVersion: "1.0.0-platform-descriptor.1", status: "PENDING_APPROVAL",
    descriptors: { mcpServer: { dataSchemaVersion: "2025-12-11", data: JSON.stringify({
      name: "example/legacy-mcp", description: "Legacy registered MCP", version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://example.invalid/mcp" }],
      schemaVersion: 1, resourceKind: "mcp_server", specification: { _source: "agentcore-registry" },
      "x-platform": { domainId: "platform", ownerSubject: "owner-subject",
        resourceId: "legacy-mcp", resourceType: "MCP_SERVER", shared: false },
    }) } } };
  const projected = recordToVersion(record);
  assert.equal(projected.entry.id, "legacy-mcp");
  assert.equal(projected.version.status, "IN_REVIEW");
  assert.equal(projected.governed.domainId, "platform");
  assert.equal(projected.version.content.endpoint, "https://example.invalid/mcp");
  const invalid = JSON.parse(record.descriptors.mcpServer.data);
  invalid.specification = { _source: "agentcore-registry", name: "incomplete nested specification" };
  record.descriptors.mcpServer.data = JSON.stringify(invalid);
  assert.throws(() => recordToVersion(record), /MCP descriptor is malformed/);
});
import {
  gatewayTargetToMcpEntry,
  recordToVersion,
  recordsToEntries,
} from "./registry-shape.mjs"

const BLUEPRINT_RECORD = {
  registryId: "shared-id",
  recordId: "record-1",
  recordArn: "arn:aws:agent-registry:us-west-2:111122223333:registry/shared-id/record/record-1",
  name: "blueprint_customer_support",
  recordVersion: "1.0.0",
  recordType: "CUSTOM",
  status: "APPROVED",
  descriptors: {
    custom: {
      data: JSON.stringify({
        resourceKind: "blueprint",
        blueprintId: "customer-support",
        displayName: "Customer Support",
        defaultVersion: "1.0.0",
      }),
    },
  },
}

const AGENT_RECORD = {
  registryId: "shared-id",
  recordId: "agent-record-1",
  name: "shared-logical-name",
  recordVersion: "1.0.0",
  recordType: "AGENT",
  status: "PENDING_APPROVAL",
  descriptors: {
    a2aAgentCard: {
      data: JSON.stringify({
        name: "Shared Agent",
        url: "https://example.invalid/agent",
        "x-platform": {
          id: "shared-agent",
          domain: "platform",
          governanceMode: "owned",
          domainOwner: "domain-platform",
        },
      }),
    },
  },
}

const SKILL_RECORD = {
  registryId: "shared-id",
  recordId: "skill-record-1",
  name: "shared-logical-name",
  recordVersion: "2.0.0",
  recordType: "SKILL",
  status: "PENDING_APPROVAL",
  descriptors: {
    agentSkillsDefinition: {
      data: JSON.stringify({
        id: "shared-skill",
        displayName: "Shared Skill",
        "x-platform": {
          domain: "platform",
          governanceMode: "owned",
          domainOwner: "domain-platform",
        },
      }),
    },
  },
}

const GOVERNED_SKILL_RECORD = {
  ...SKILL_RECORD,
  recordId: "governed-skill-1",
  recordVersion: "2.0.0+platform-descriptor.1",
  descriptors: {
    agentSkillsDefinition: {
      data: JSON.stringify({
        schemaVersion: 1,
        id: "shared-skill",
        displayName: "Shared Skill",
        "x-platform": {
          domainId: "shared",
          ownerSubject: "platform-bootstrap",
          resourceId: "shared-skill",
          resourceType: "SKILL",
          shared: true,
        },
        "x-platform-metadata": {
          domain: "shared",
          governanceMode: "owned",
          domainOwner: "Platform CoE",
          createdBy: "platform-bootstrap",
          changelog: "Migrated to governed descriptor v1.",
          tools: ["knowledge_base"],
          toolType: null,
          gateway: null,
          auth: null,
          access: ["admin", "builder"],
        },
      }),
    },
  },
}

test("maps standalone Agent Registry records without local storage", () => {
  const mapped = recordToVersion(BLUEPRINT_RECORD)
  const entries = recordsToEntries([BLUEPRINT_RECORD], () => "shared")

  assert.equal(mapped.entry.type, "Blueprint")
  assert.equal(entries.length, 1)
  assert.equal(entries[0].type, "Blueprint")
  assert.equal(entries[0]._source, "agentcore-registry")
})

test("maps a non-A2A AgentCore Runtime custom descriptor as an Agent", () => {
  const runtimeAgent = structuredClone(AGENT_RECORD)
  runtimeAgent.recordVersion = "1.0.0-platform-descriptor.1"
  runtimeAgent.descriptors = {
    custom: {
      data: JSON.stringify({
        schemaVersion: 1,
        name: "Shared Agent",
        url: "https://example.invalid/agent",
        "x-platform": {
          domainId: "platform",
          ownerSubject: "platform-bootstrap",
          resourceId: "shared-agent",
          resourceType: "AGENT",
          shared: false,
        },
        "x-platform-metadata": {
          displayName: "Shared Agent",
          domain: "platform",
          governanceMode: "owned",
          domainOwner: "Platform",
          access: ["admin"],
          createdBy: "platform-bootstrap",
        },
      }),
    },
  }

  const mapped = recordToVersion(runtimeAgent)

  assert.equal(mapped.entry.id, "shared-agent")
  assert.equal(mapped.entry.type, "Agent")
  assert.equal(mapped.entry.name, "Shared Agent")
  assert.equal(mapped.version.content.baseUrl, "https://example.invalid/agent")
})

test("maps governed descriptor v1 without changing legacy consumer fields", () => {
  const { entry, version } = recordToVersion(GOVERNED_SKILL_RECORD)

  assert.equal(entry.id, "shared-skill")
  assert.equal(entry.domain, null)
  assert.equal(entry.governanceMode, "owned")
  assert.equal(entry.domainOwner, "Platform CoE")
  assert.equal(version.semver, "2.0.0+platform-descriptor.1")
  assert.equal(version.createdBy, "platform-bootstrap")
  assert.equal(version.changelog, "Migrated to governed descriptor v1.")
  assert.deepEqual(version.content.tools, ["knowledge_base"])
})

test("keeps legacy console domain keys stable across governed migration", () => {
  const legacy = structuredClone(SKILL_RECORD)
  legacy.recordVersion = "1.0.0"
  const legacyDescriptor = JSON.parse(
    legacy.descriptors.agentSkillsDefinition.data,
  )
  legacyDescriptor["x-platform"].domain = "customer-support"
  legacy.descriptors.agentSkillsDefinition.data =
    JSON.stringify(legacyDescriptor)

  const governed = structuredClone(GOVERNED_SKILL_RECORD)
  governed.recordId = "skill-record-2"
  governed.name = legacy.name
  const governedDescriptor = JSON.parse(
    governed.descriptors.agentSkillsDefinition.data,
  )
  governedDescriptor["x-platform"].domainId = "customer_support"
  governedDescriptor["x-platform-metadata"].domain = "customer-support"
  governedDescriptor["x-platform-metadata"].domainOwner =
    legacyDescriptor["x-platform"].domainOwner
  governed.descriptors.agentSkillsDefinition.data =
    JSON.stringify(governedDescriptor)

  const [entry] = recordsToEntries(
    [legacy, governed],
    () => "customer_support",
  )

  assert.equal(entry.domain, "customer_support")
  assert.deepEqual(
    entry.versions.map(version => version.semver),
    ["1.0.0", "2.0.0+platform-descriptor.1"],
  )
})

test("maps governed platform AGENT records as Agents, not external A2A agents", () => {
  const governedAgent = {
    ...AGENT_RECORD,
    recordId: "platform-agent-record",
    name: "agent_design_assistant",
    recordVersion: "1.0.0-platform-descriptor.1",
    status: "APPROVED",
    descriptors: {
      custom: {
        data: JSON.stringify({
          schemaVersion: 1,
          resourceKind: "agent",
          name: "Agent Design Assistant",
          description: "Platform design assistant.",
          url: "https://example.invalid/runtime",
          version: "1.0.0",
          specification: {},
          "x-platform": {
            domainId: "platform",
            ownerSubject: "platform-bootstrap",
            resourceId: "agent-design-assistant",
            resourceType: "AGENT",
            shared: false,
          },
          "x-platform-metadata": {
            displayName: "Agent Design Assistant",
            domain: "platform",
            governanceMode: "owned",
            domainOwner: "Platform",
            access: ["admin"],
            createdBy: "platform-bootstrap",
            changelog: "Deployment-owned platform design assistant.",
          },
        }),
      },
    },
  }

  const [entry] = recordsToEntries([governedAgent], () => "platform")

  assert.equal(entry.id, "agent-design-assistant")
  assert.equal(entry.type, "Agent")
  assert.equal(entry.domain, "platform")
})

test("keeps governed A2A agent cards classified as external A2A agents", () => {
  const governedA2aAgent = structuredClone(AGENT_RECORD)
  governedA2aAgent.recordId = "governed-a2a-agent-record"
  governedA2aAgent.recordVersion = "1.0.0-platform-descriptor.1"
  governedA2aAgent.descriptors = {
    a2aAgentCard: {
      data: JSON.stringify({
        schemaVersion: 1,
        name: "Partner Agent",
        url: "https://example.invalid/a2a",
        "x-platform": {
          domainId: "shared",
          ownerSubject: "partner-owner",
          resourceId: "partner-agent",
          resourceType: "AGENT",
          shared: true,
        },
        "x-platform-metadata": {
          displayName: "Partner Agent",
          domain: "shared",
          governanceMode: "federated",
          domainOwner: "Partner",
          access: ["admin", "builder"],
          createdBy: "partner-owner",
        },
      }),
    },
  }

  const [entry] = recordsToEntries([governedA2aAgent], () => "shared")

  assert.equal(entry.id, "partner-agent")
  assert.equal(entry.type, "A2AAgent")
  assert.equal(entry.domain, "shared")
})

test("governed record scope comes from its Registry and must match descriptor metadata", () => {
  const governed = structuredClone(GOVERNED_SKILL_RECORD)
  const [entry] = recordsToEntries([governed], () => "shared")

  assert.equal(entry.domain, "shared")
  assert.throws(
    () => recordsToEntries([governed], () => "operations"),
    /Registry governed domain/,
  )
})

test("legacy and governed migration versions remain uniquely addressable", () => {
  const legacy = structuredClone(SKILL_RECORD)
  legacy.recordVersion = "2.0.0"
  legacy.recordId = "legacy-skill-1"
  legacy.name = GOVERNED_SKILL_RECORD.name
  const legacyDescriptor = JSON.parse(
    legacy.descriptors.agentSkillsDefinition.data,
  )
  legacyDescriptor["x-platform"].domain = "shared"
  legacyDescriptor["x-platform"].domainOwner = "Platform CoE"
  legacy.descriptors.agentSkillsDefinition.data =
    JSON.stringify(legacyDescriptor)

  const [entry] = recordsToEntries(
    [legacy, GOVERNED_SKILL_RECORD],
    () => "shared",
  )

  assert.deepEqual(
    entry.versions.map((version) => version.semver),
    ["2.0.0", "2.0.0+platform-descriptor.1"],
  )
  assert.equal(
    new Set(entry.versions.map((version) => version.semver)).size,
    2,
  )
})

test("malformed governed descriptors are rejected instead of treated as legacy", () => {
  const cases = [
    (descriptor) => { descriptor.schemaVersion = 2 },
    (descriptor) => { descriptor["x-platform"].extra = true },
    (descriptor) => { descriptor["x-platform"].domainId = "Bad Domain" },
    (descriptor) => { descriptor["x-platform"].ownerSubject = "bad subject" },
    (descriptor) => { descriptor["x-platform"].resourceId = "" },
    (descriptor) => { descriptor["x-platform"].resourceType = "AGENT" },
    (descriptor) => { descriptor["x-platform"].shared = "true" },
  ]

  for (const mutate of cases) {
    const malformed = structuredClone(GOVERNED_SKILL_RECORD)
    const descriptor = JSON.parse(
      malformed.descriptors.agentSkillsDefinition.data,
    )
    mutate(descriptor)
    malformed.descriptors.agentSkillsDefinition.data =
      JSON.stringify(descriptor)
    assert.throws(
      () => recordToVersion(malformed),
      /governed descriptor/i,
    )
  }
})

test("governed version markers fail closed on invalid or non-governed descriptor content", () => {
  const invalidJson = structuredClone(GOVERNED_SKILL_RECORD)
  invalidJson.descriptors.agentSkillsDefinition.data = "{not json"
  assert.throws(
    () => recordToVersion(invalidJson),
    /governed descriptor/i,
  )

  const missingSchema = structuredClone(GOVERNED_SKILL_RECORD)
  const missingSchemaDescriptor = JSON.parse(
    missingSchema.descriptors.agentSkillsDefinition.data,
  )
  delete missingSchemaDescriptor.schemaVersion
  delete missingSchemaDescriptor["x-platform"]
  missingSchema.descriptors.agentSkillsDefinition.data =
    JSON.stringify(missingSchemaDescriptor)
  assert.throws(
    () => recordToVersion(missingSchema),
    /governed descriptor/i,
  )

  const nonBlueprint = {
    ...BLUEPRINT_RECORD,
    recordVersion: "1.0.0+platform-descriptor.1",
    descriptors: {
      custom: {
        data: JSON.stringify({
          schemaVersion: 1,
          resourceKind: "tool",
          "x-platform": {
            domainId: "shared",
            ownerSubject: "platform-bootstrap",
            resourceId: "not-a-blueprint",
            resourceType: "BLUEPRINT",
            shared: true,
          },
        }),
      },
    },
  }
  assert.throws(
    () => recordToVersion(nonBlueprint),
    /governed descriptor/i,
  )
})

test("governed descriptors require the governed AWS record-version marker", () => {
  assert.throws(
    () => recordToVersion({
      ...GOVERNED_SKILL_RECORD,
      recordVersion: "2.0.0",
    }),
    /governed descriptor/i,
  )
  assert.throws(
    () => recordToVersion({
      ...GOVERNED_SKILL_RECORD,
      recordVersion: "not-semver+platform-descriptor.1",
    }),
    /governed descriptor/i,
  )
})

test("rejects conflicting recordType and descriptorType projections", () => {
  for (const record of [
    { ...SKILL_RECORD, descriptorType: "AGENT" },
    { ...AGENT_RECORD, descriptorType: "SKILL" },
    { ...BLUEPRINT_RECORD, descriptorType: "AGENT" },
  ]) {
    assert.throws(
      () => recordToVersion(record),
      /Registry record type/,
    )
  }
  assert.equal(
    recordToVersion({
      ...SKILL_RECORD,
      descriptorType: "AGENT_SKILLS",
    }).entry.type,
    "Skill",
  )
  assert.equal(
    recordToVersion({
      ...AGENT_RECORD,
      descriptorType: "A2A",
    }).entry.type,
    "A2AAgent",
  )
})

test("legacy descriptorType-only records remain readable", () => {
  const legacy = structuredClone(SKILL_RECORD)
  delete legacy.recordType
  legacy.descriptorType = "AGENT_SKILLS"

  assert.equal(recordToVersion(legacy).entry.type, "Skill")
})

test("governed records require the authoritative AWS recordType", () => {
  const governed = structuredClone(GOVERNED_SKILL_RECORD)
  delete governed.recordType
  governed.descriptorType = "AGENT_SKILLS"

  assert.throws(
    () => recordToVersion(governed),
    /governed descriptor/i,
  )
  for (const recordType of ["AGENT_SKILLS", "A2A"]) {
    assert.throws(
      () => recordToVersion({
        ...GOVERNED_SKILL_RECORD,
        recordType,
      }),
      /governed descriptor/i,
    )
  }
})

test("governed records require strict SemVer prerelease identifiers", () => {
  assert.throws(
    () => recordToVersion({
      ...GOVERNED_SKILL_RECORD,
      recordVersion: "2.0.0-01+platform-descriptor.1",
    }),
    /governed descriptor/i,
  )
})

test("rejects same-name Registry versions projected under conflicting Agent or Skill identity", () => {
  const cases = [
    [AGENT_RECORD, { ...AGENT_RECORD, recordId: "agent-record-2",
      descriptors: { a2aAgentCard: { data: JSON.stringify({
        name: "Shared Agent",
        url: "https://example.invalid/agent",
        "x-platform": {
          id: "different-agent",
          domain: "platform",
          governanceMode: "owned",
          domainOwner: "domain-platform",
        },
      }) } } }],
    [SKILL_RECORD, { ...SKILL_RECORD, recordId: "skill-record-2",
      descriptors: { agentSkillsDefinition: { data: JSON.stringify({
        id: "shared-skill",
        displayName: "Shared Skill",
        "x-platform": {
          domain: "operations",
          governanceMode: "federated",
          domainOwner: "domain-operations",
        },
      }) } } }],
  ]

  for (const records of cases) {
    assert.throws(
      () => recordsToEntries(records, () => "shared"),
      /Registry entry identity/,
    )
  }
})

test("rejects same-name Blueprint versions confused with Agent or Skill records", () => {
  const blueprint = {
    ...BLUEPRINT_RECORD,
    name: "shared-logical-name",
    recordId: "blueprint-record-1",
  }
  for (const other of [AGENT_RECORD, SKILL_RECORD]) {
    assert.throws(
      () => recordsToEntries([blueprint, other], () => "shared"),
      /Registry entry identity/,
    )
  }
})

test("rejects missing or duplicate authoritative Registry record IDs", () => {
  assert.throws(
    () => recordsToEntries([{ ...BLUEPRINT_RECORD, recordId: " " }]),
    /Registry record identity/,
  )
  assert.throws(
    () => recordsToEntries([
      BLUEPRINT_RECORD,
      { ...BLUEPRINT_RECORD, name: "other-blueprint" },
    ]),
    /Registry record identity/,
  )
})

test("qualifies duplicate application aliases using Registry record-group identity", () => {
  const entries = recordsToEntries([
    BLUEPRINT_RECORD,
    { ...BLUEPRINT_RECORD, recordId: "record-2", name: "other-blueprint" },
  ])
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map(entry => entry.id), [
    `${BLUEPRINT_RECORD.registryId}/${BLUEPRINT_RECORD.name}`,
    `${BLUEPRINT_RECORD.registryId}/other-blueprint`,
  ])
  assert.equal(entries[1].versions[0]._aws.recordId, 'record-2')
})

test("maps a READY Gateway target to an approved MCPServer entry", () => {
  const entry = gatewayTargetToMcpEntry({
    targetId: "target-1",
    name: "aws-docs",
    description: "AWS documentation",
    endpoint: "https://knowledge-mcp.global.api.aws",
    status: "READY",
  }, {
    gatewayId: "gateway-1",
    name: "platform-tools-gw",
  })

  assert.equal(entry.id, "gateway-1/target-1")
  assert.equal(entry.type, "MCPServer")
  assert.equal(entry._source, "gateway")
  assert.equal(entry._gateway, "platform-tools-gw")
  assert.equal(entry.versions[0].status, "APPROVED")
})

test("maps a failed Gateway target to a draft MCPServer entry", () => {
  const entry = gatewayTargetToMcpEntry({
    targetId: "target-2",
    name: "github-mcp",
    status: "FAILED",
  }, {
    gatewayId: "gateway-1",
    name: "platform-tools-gw",
  })

  assert.equal(entry.type, "MCPServer")
  assert.equal(entry.versions[0].status, "DRAFT")
})

test("requires authoritative Gateway and target IDs for MCP entries", () => {
  const target = {
    targetId: "target-1",
    name: "aws-docs",
    status: "READY",
  }
  const gateway = {
    gatewayId: "gateway-1",
    name: "platform-tools-gw",
  }

  assert.throws(
    () => gatewayTargetToMcpEntry(
      { ...target, targetId: " " },
      gateway,
    ),
    /Gateway target identity/,
  )
  assert.throws(
    () => gatewayTargetToMcpEntry(
      target,
      { ...gateway, gatewayId: "" },
    ),
    /Gateway target identity/,
  )
})

test('approved governed blueprint successor supersedes a legacy embedded default regardless of list order', () => {
  const legacy = structuredClone(BLUEPRINT_RECORD);
  const newer = {...structuredClone(legacy), recordId: 'record-2',
    recordArn: legacy.recordArn.replace('record-1','record-2'), recordVersion: '1.3.0-platform-descriptor.1',
    descriptors: {custom: {data: JSON.stringify({schemaVersion: 1, resourceKind: 'blueprint',
      blueprintId: 'customer-support', displayName: 'Customer Support', recommended: true,
      source: {kind: 'repo', templateId: 'chatagent'}, template: {framework: 'Strands', deployTarget: 'AgentCore Runtime'},
      'x-platform': {domainId: 'shared', ownerSubject: 'platform-bootstrap', resourceId: 'customer-support', resourceType: 'BLUEPRINT', shared: true},
    })}}};
  for (const records of [[legacy,newer],[newer,legacy]]) {
    const [entry] = recordsToEntries(records, () => 'shared');
    assert.equal(entry.defaultVersion, newer.recordVersion);
    assert.equal(entry.versions.length, 2);
    assert.deepEqual(entry.versions.at(-1).content.source, {kind:'repo',templateId:'chatagent'});
    assert.equal(entry.versions.at(-1).content.recommended, true);
  }
  const [pending] = recordsToEntries([legacy,{...newer,status:'PENDING_APPROVAL'}], () => 'shared');
  assert.equal(pending.defaultVersion, '1.0.0');
});

test("governed blueprint submissions retain their template and source after publication", () => {
  const specification = {
    template: { framework: "Strands", deployTarget: "AgentCore Runtime", memory: "shortTerm" },
    source: { kind: "illustrative" },
  };
  const record = {
    ...structuredClone(BLUEPRINT_RECORD),
    recordVersion: "1.0.0-platform-descriptor.1",
    descriptors: { custom: { data: JSON.stringify({
      schemaVersion: 1, resourceKind: "blueprint", specification,
      "x-platform": { domainId: "shared", ownerSubject: "submitter", resourceId: "customer-support", resourceType: "BLUEPRINT", shared: true },
    }) } },
  };
  const [entry] = recordsToEntries([record], () => "shared");
  assert.deepEqual(entry.versions[0].content.template, specification.template);
  assert.deepEqual(entry.versions[0].content.source, specification.source);
  assert.equal(entry.versions[0].status, "APPROVED");
});
