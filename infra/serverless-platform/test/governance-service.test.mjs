import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  GovernanceServiceError,
  createGovernanceService,
} from "../lambda/governance/service.mjs";
import {
  createGovernanceAuthorizer,
} from "../lambda/governance/runtime.mjs";

const START = Date.parse("2026-08-25T08:00:00.000Z");
const REGISTRIES = Object.freeze({
  customer_support: "CustReg123456",
  operations: "OpsReg1234567",
  platform: "PlatReg123456",
});

function identity(role = "builder", actor = "builder-sub", domain = "customer_support") {
  return {
    actor,
    role,
    activeDomain: domain,
    domainIds: role === "admin"
      ? Object.keys(REGISTRIES)
      : role === "user"
        ? []
        : [domain],
  };
}

function domain(id) {
  return {
    id,
    registryId: REGISTRIES[id],
    registryArn:
      `arn:aws:agent-registry:us-west-2:111122223333:registry/${REGISTRIES[id]}`,
    status: "ACTIVE",
  };
}

function resourceDescriptor({
  domainId = "customer_support",
  ownerSubject = "builder-sub",
  resourceId = "case-triage",
  resourceType = "TOOL",
  shared = true,
} = {}) {
  return {
    schemaVersion: 1,
    resourceKind: resourceType.toLowerCase(),
    specification: {
      entrypoint: "https://example.invalid/resource",
    },
    "x-platform": {
      domainId,
      ownerSubject,
      resourceId,
      resourceType,
      shared,
    },
  };
}

function record({
  domainId = "customer_support",
  recordId = "Rec123456789",
  resourceId = "case-triage",
  resourceType = "TOOL",
  ownerSubject = "builder-sub",
  shared = true,
  status = "DRAFT",
} = {}) {
  const registryId = REGISTRIES[domainId];
  return {
    registryArn:
      `arn:aws:agent-registry:us-west-2:111122223333:registry/${registryId}`,
    recordArn:
      `arn:aws:agent-registry:us-west-2:111122223333:registry/${registryId}/record/${recordId}`,
    recordId,
    name: `${domainId}-${resourceId}`,
    displayName: "Case Triage",
    description: "Routes cases to an approved queue.",
    recordType: "CUSTOM",
    descriptors: {
      custom: {
        data: JSON.stringify(resourceDescriptor({
          domainId,
          ownerSubject,
          resourceId,
          resourceType,
          shared,
        })),
      },
    },
    recordVersion: "1.0.0+platform-descriptor.1",
    status,
    createdAt: new Date(START),
    updatedAt: new Date(START),
  };
}

function legacyRecord({
  domainId = "operations",
  recordId = "RecLegacy123",
  resourceId = "legacy-skill",
  status = "APPROVED",
} = {}) {
  const value = record({
    domainId,
    recordId,
    resourceId,
    resourceType: "SKILL",
    status,
  });
  return {
    ...value,
    recordType: "SKILL",
    recordVersion: "1.0.0",
    descriptors: {
      agentSkillsDefinition: {
        data: JSON.stringify({
          id: resourceId,
          name: "Legacy Skill",
          "x-platform": {
            id: resourceId,
            domain: domainId,
            governanceMode: "owned",
          },
        }),
      },
    },
  };
}

function approval(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "publish-case-triage",
    kind: "RESOURCE_PUBLICATION",
    resourceType: "TOOL",
    resourceId: "CustReg123456/Rec123456789",
    projectId: null,
    status: "PENDING",
    requesterSubject: "builder-sub",
    approverSubject: null,
    reason: null,
    requestedAt: "2026-08-25T08:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

function accessRequest(overrides = {}) {
  return {
    identity: identity(),
    requestId: "access-request",
    approvalId: "request-ops-triage",
    sourceDomainId: "operations",
    registryId: REGISTRIES.operations,
    recordId: "Rec987654321",
    ...overrides,
  };
}

function grant(overrides = {}) {
  return {
    domainId: "operations",
    resourceType: "TOOL",
    resourceId: "CustReg123456/Rec123456789",
    status: "ACTIVE",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T08:00:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function entitlement(overrides = {}) {
  return {
    subject: "user-sub",
    domainId: "operations",
    projectId: "case-assist",
    agentId: "triage-agent",
    status: "ACTIVE",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T08:00:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function typedEntitlement(overrides = {}) {
  return {
    subjectType: "USER",
    subject: "user-sub",
    domainId: "operations",
    projectId: "case-assist",
    agentId: "triage-agent",
    status: "ACTIVE",
    expiresAt: "2026-08-25T09:00:00.000Z",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T08:00:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function entitlementGrant(overrides = {}) {
  return {
    identity: identity("lead", "lead-sub", "operations"),
    requestId: "direct-entitlement-grant",
    domainId: "operations",
    projectId: "case-assist",
    agentId: "triage-agent",
    subjectType: "USER",
    subject: "user-sub",
    expiresAt: "2026-08-25T09:00:00.000Z",
    reason: "Grant the approved subject production access.",
    ...overrides,
  };
}

function testedAgent(overrides = {}) {
  return {
    domainId: "customer_support",
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Routes incoming support cases.",
    ownerSubject: "builder-sub",
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    toolIds: ["case-search"],
    mcpServerIds: ["support-mcp"],
    skillIds: ["case-triage"],
    blueprintIds: ["support-blueprint"],
    memoryIds: ["support-memory"],
    knowledgeBaseIds: ["support-kb"],
    buildConfig: {
      instructions: "Route incoming support cases to the right queue.",
      modelParameters: {
        temperature: 0.2,
        maxTokens: 1024,
      },
      buildOptions: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "shortTerm",
        streaming: true,
        identity: true,
        guardrails: true,
      },
      guardrailChain: [],
    },
    status: "TESTED",
    createdBySubject: "builder-sub",
    createdAt: "2026-08-25T07:00:00.000Z",
    updatedAt: "2026-08-25T08:00:00.000Z",
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: "2026-08-25T08:00:00.000Z",
    lastTestedBySubject: "builder-sub",
    lastTestModelId: "bedrock-claude/anthropic.claude-sonnet-5",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 7,
    lastTestRequestId: "gateway-request",
    lastTestEvidenceHash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    lastTestOutput: "Test response.",
    ...overrides,
  };
}

function memoryState({
  currentApproval = null,
  currentGrant = null,
  currentEntitlement = null,
  entitlementPage = { items: [], cursor: null },
  currentProject = {
    domainId: "customer_support",
    id: "case-assist",
    name: "Case Assist",
    description: "Support workspace.",
    ownerSubject: "builder-sub",
    memberSubjects: ["builder-sub"],
    status: "ACTIVE",
    createdBySubject: "lead-sub",
    createdAt: "2026-08-25T07:00:00.000Z",
  },
  currentAgent,
  events = [],
} = {}) {
  let sequence = 0;
  const records = {
    approval: currentApproval,
    grant: currentGrant,
    entitlement: currentEntitlement,
  };
  const claims = new Map();
  const mutations = new Map();
  const reservations = new Map();
  const writes = [];
  const mutationKey = ({ actor, route, requestId }) =>
    `${actor}\u0000${route}\u0000${requestId}`;
  return {
    claims,
    mutations,
    records,
    writes,
    beginTransaction() {
      const timestamp = new Date(START + sequence * 1000).toISOString();
      sequence += 1;
      return {
        timestamp,
        epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
      };
    },
    async getApproval() {
      return records.approval;
    },
    async getResourceGrant() {
      return records.grant;
    },
    async getEntitlement() {
      return records.entitlement;
    },
    async listAgentEntitlements(input) {
      events.push(["listAgentEntitlements", structuredClone(input)]);
      return structuredClone(entitlementPage);
    },
    async getProject() {
      return currentProject === null
        ? null
        : structuredClone(currentProject);
    },
    async getAgent(input) {
      if (currentAgent !== undefined) {
        return currentAgent === null ? null : structuredClone(currentAgent);
      }
      return {
        domainId: input.domainId,
        projectId: input.projectId,
        id: input.agentId,
        status: "PRODUCTION_DEPLOYED",
      };
    },
    async listDeployments(input) {
      return {
        items: [{
          domainId: input.domainId,
          projectId: input.projectId,
          agentId: "triage-agent",
          environment: "PRODUCTION",
          status: "DEPLOYED",
          runtimeStatus: "READY",
        }],
        cursor: null,
      };
    },
    async reserveApprovalDecision(input) {
      const key = `${input.domainId}/${input.approvalId}`;
      const old = reservations.get(key);
      if (old && !isDeepStrictEqual(old, input)) throw Object.assign(Error("conflict"), { code: "MUTATION_CONFLICT" });
      reservations.set(key, structuredClone(input)); return true;
    },
    async putApproval(input) {
      events.push("putApproval");
      writes.push(["approval", input]);
      records.approval = input.record;
      mutations.set(mutationKey(input.mutation), structuredClone(input.mutation));
      return input.record;
    },
    async putResourceGrant(input) {
      writes.push(["grant", input]);
      records.grant = input.record;
      return input.record;
    },
    async putEntitlement(input) {
      writes.push(["entitlement", input]);
      records.entitlement = input.record;
      mutations.set(mutationKey(input.mutation), structuredClone(input.mutation));
      return input.record;
    },
    async putAccessDecision(input) {
      events.push("putAccessDecision");
      writes.push(["approval", input.approval]);
      records.approval = input.approval.record;
      mutations.set(
        mutationKey(input.approval.mutation),
        structuredClone(input.approval.mutation),
      );
      if (input.grant) {
        writes.push(["grant", input.grant]);
        records.grant = input.grant.record;
        mutations.set(
          mutationKey(input.grant.mutation),
          structuredClone(input.grant.mutation),
        );
        return {
          approval: input.approval.record,
          grant: input.grant.record,
        };
      }
      writes.push(["entitlement", input.entitlement]);
      records.entitlement = input.entitlement.record;
      mutations.set(
        mutationKey(input.entitlement.mutation),
        structuredClone(input.entitlement.mutation),
      );
      return {
        approval: input.approval.record,
        entitlement: input.entitlement.record,
      };
    },
    async getMutationResult(input) {
      events.push("getMutationResult");
      return mutations.get(mutationKey(input)) ?? null;
    },
    async getMutationClaim(input) {
      events.push("getMutationClaim");
      const value = claims.get(mutationKey(input));
      return value === undefined ? null : structuredClone(value);
    },
    async claimMutation(input) {
      events.push("claimMutation");
      const key = mutationKey(input);
      const current = claims.get(key);
      if (current !== undefined) {
        throw Object.assign(new Error("mutation claim exists"), {
          code: isDeepStrictEqual(current, input)
            ? "MUTATION_IN_PROGRESS"
            : "MUTATION_CONFLICT",
        });
      }
      claims.set(key, structuredClone(input));
      return true;
    },
    async appendAudit(input) {
      events.push("appendAudit");
      writes.push(["audit", input]);
      mutations.set(mutationKey(input.mutation), structuredClone(input.mutation));
      return input.record;
    },
  };
}

function registryHarness(initial = {}) {
  const events = initial.events ?? [];
  const listRegistryRecords = initial.listRegistryRecords ?? null;
  const calls = [];
  const records = new Map();
  for (const value of initial.records ?? []) {
    records.set(`${value.registryArn.split("/").at(-1)}/${value.recordId}`, value);
  }
  return {
    calls,
    records,
    client: {
      async send(command) {
        calls.push(command);
        events.push(command.constructor.name);
        if (command instanceof CreateRegistryRecordCommand) {
          const recordId = "Rec123456789";
          const registryId = command.input.registryId;
          const created = {
            registryArn:
              `arn:aws:agent-registry:us-west-2:111122223333:registry/${registryId}`,
            recordArn:
              `arn:aws:agent-registry:us-west-2:111122223333:registry/${registryId}/record/${recordId}`,
            recordId,
            name: command.input.name,
            displayName: command.input.displayName,
            description: command.input.description,
            recordType: command.input.recordType,
            descriptors: command.input.descriptors,
            recordVersion: command.input.recordVersion,
            status: "DRAFT",
            createdAt: new Date(START),
            updatedAt: new Date(START),
          };
          records.set(`${registryId}/${recordId}`, created);
          return {
            recordArn: created.recordArn,
            status: "CREATING",
          };
        }
        if (command instanceof GetRegistryRecordCommand) {
          const value = records.get(
            `${command.input.registryId}/${command.input.recordId}`,
          );
          if (!value) {
            const error = new Error("not found");
            error.name = "ResourceNotFoundException";
            throw error;
          }
          return value;
        }
        if (command instanceof SubmitRegistryRecordForApprovalCommand) {
          const key = `${command.input.registryId}/${command.input.recordId}`;
          const value = records.get(key);
          value.status = "PENDING_APPROVAL";
          value.updatedAt = new Date(START + 1000);
          return {
            registryArn: value.registryArn,
            recordArn: value.recordArn,
            recordId: value.recordId,
            status: value.status,
            updatedAt: value.updatedAt,
          };
        }
        if (command instanceof UpdateRegistryRecordStatusCommand) {
          const key = `${command.input.registryId}/${command.input.recordId}`;
          const value = records.get(key);
          value.status = command.input.status;
          value.statusReason = command.input.statusReason;
          value.updatedAt = new Date(START + 2000);
          return {
            registryArn: value.registryArn,
            recordArn: value.recordArn,
            recordId: value.recordId,
            status: value.status,
            updatedAt: value.updatedAt,
          };
        }
        if (command instanceof ListRegistryRecordsCommand) {
          if (listRegistryRecords !== null) {
            return listRegistryRecords(command.input);
          }
          const matching = [...records.values()]
            .filter((value) =>
              value.registryArn.endsWith(`/${command.input.registryId}`))
            .map((value) => ({
              registryArn: value.registryArn,
              recordArn: value.recordArn,
              registryId: command.input.registryId,
              recordId: value.recordId,
              name: value.name,
              displayName: value.displayName,
              description: value.description,
              recordType: value.recordType,
              recordVersion: value.recordVersion,
              status: value.status,
              createdAt: value.createdAt,
              updatedAt: value.updatedAt,
            }));
          return { registryRecords: matching };
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      },
    },
  };
}

function serviceWith({
  state = memoryState(),
  registry = registryHarness(),
  deniedActions = [],
  authorizationResult = true,
  sleep,
} = {}) {
  const authorizeCalls = [];
  const service = createGovernanceService({
    workspaceState: state,
    ...(sleep ? { sleep } : {}),
    domainDirectory: {
      async getDomain(id) {
        return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
      },
      async listActiveDomains() {
        return Object.keys(REGISTRIES).map(domain);
      },
    },
    registryClient: registry.client,
    async authorizer(input) {
      authorizeCalls.push(input);
      if (deniedActions.includes(input.action)) {
        const error = new Error("denied");
        error.decision = "FORBIDDEN";
        throw error;
      }
      return authorizationResult;
    },
    mutationClaimResolver: state.getMutationClaim.bind(state),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "agentic-platform",
      project: "agentic-ai-platform-demo",
    },
  });
  return { service, state, registry, authorizeCalls };
}

function serviceWithProductionAuthorizer({
  state = memoryState(),
  registry = registryHarness(),
} = {}) {
  return {
    service: createGovernanceService({
      workspaceState: state,
      domainDirectory: {
        async getDomain(id) {
          return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
        },
        async listActiveDomains() {
          return Object.keys(REGISTRIES).map(domain);
        },
      },
      registryClient: registry.client,
      authorizer: createGovernanceAuthorizer({
        workspaceState: state,
        clock: () => new Date(START),
      }),
      mutationClaimResolver: state.getMutationClaim.bind(state),
      mandatoryTags: {
        "auto-delete": "no",
        managedBy: "agentic-platform",
        project: "agentic-ai-platform-demo",
      },
    }),
    state,
    registry,
  };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof GovernanceServiceError);
    assert.equal(error.code, code);
    return true;
  };
}

test("governance service requires state, directory, Registry, authorization, and tags", () => {
  assert.throws(
    () => createGovernanceService(),
    /configuration is invalid/i,
  );
});

test("asynchronous draft creation outlasts the old polling window and remains retryable", async () => {
  for (const staysPending of [false, true]) {
    const registry = registryHarness();
    const original = registry.client.send.bind(registry.client);
    let reads = 0;
    const delays = [];
    registry.client.send = async command => {
      const result = await original(command);
      if (command instanceof GetRegistryRecordCommand && (staysPending || ++reads <= 6)) {
        return { ...result, status: "CREATING" };
      }
      return result;
    };
    const { service } = serviceWith({ registry, sleep: async ms => delays.push(ms) });
    const pending = service.registerDraft({
      identity: identity(), requestId: "slow-draft",
      resource: {
        domainId: "customer_support", resourceType: "TOOL",
        resourceId: "slow-draft", displayName: "Slow draft",
        description: "Asynchronous native creation.", version: "1.0.0",
        shared: true, specification: { entrypoint: "https://example.invalid/resource" },
      },
    });
    if (staysPending) {
      await assert.rejects(pending, expectCode("REGISTRY_UNAVAILABLE"));
    } else {
      assert.equal((await pending).status, "DRAFT");
    }
    assert.ok(delays.length >= 6);
    assert.ok(delays.reduce((total, ms) => total + ms, 0) <= 5750);
    assert.equal(registry.calls.filter(c => c instanceof CreateRegistryRecordCommand).length, 1);
  }
});

test("builder registers a tagged draft in the selected domain Registry", async () => {
  const { service, registry, authorizeCalls } = serviceWith();
  const result = await service.registerDraft({
    identity: identity(),
    requestId: "draft-request",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "case-triage",
      displayName: "Case Triage",
      description: "Routes cases to an approved queue.",
      version: "1.0.0",
      shared: true,
      specification: {
        entrypoint: "https://example.invalid/resource",
      },
    },
  });

  assert.equal(result.status, "DRAFT");
  assert.equal(result.registryId, REGISTRIES.customer_support);
  assert.equal(result.recordId, "Rec123456789");
  assert.equal(authorizeCalls[0].action, "resource:draft-register");

  const create = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.equal(create.input.registryId, REGISTRIES.customer_support);
  assert.equal(
    create.input.recordVersion,
    "1.0.0-platform-descriptor.1",
  );
  assert.deepEqual(create.input.tags, {
    "auto-delete": "no",
    managedBy: "agentic-platform",
    project: "agentic-ai-platform-demo",
  });
  const descriptor = JSON.parse(create.input.descriptors.custom.data);
  assert.deepEqual(descriptor["x-platform"], {
    domainId: "customer_support",
    ownerSubject: "builder-sub",
    resourceId: "case-triage",
    resourceType: "TOOL",
    shared: true,
  });
});

test("builder publishes a tested owned Agent to the real domain Registry", async () => {
  const state = memoryState({ currentAgent: testedAgent() });
  const { service, registry, authorizeCalls } = serviceWith({ state });

  const result = await service.publishAgent({
    identity: identity(),
    requestId: "publish-agent-request",
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
  });

  assert.equal(result.record.status, "PENDING_APPROVAL");
  assert.equal(result.record.resourceType, "AGENT");
  assert.equal(result.record.resourceId, "case-assist/triage-agent");
  assert.equal(result.record.domainId, "customer_support");
  assert.equal(result.approval.status, "PENDING");
  assert.equal(result.approval.projectId, "case-assist");
  assert.equal(result.approval.kind, "RESOURCE_PUBLICATION");
  assert.equal(result.approval.resourceType, "AGENT");

  const create = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.ok(create);
  assert.equal(create.input.registryId, REGISTRIES.customer_support);
  assert.equal(create.input.recordType, "AGENT");
  assert.deepEqual(create.input.tags, {
    "auto-delete": "no",
    managedBy: "agentic-platform",
    project: "agentic-ai-platform-demo",
  });
  const descriptor = JSON.parse(
    create.input.descriptors.custom.data,
  );
  assert.equal(create.input.descriptors.a2aAgentCard, undefined);
  assert.equal(descriptor.resourceKind, "agent");
  assert.equal(descriptor["x-platform"].domainId, "customer_support");
  assert.equal(
    descriptor["x-platform"].resourceId,
    "case-assist/triage-agent",
  );
  assert.equal(descriptor.specification.projectId, "case-assist");
  assert.equal(descriptor.specification.agentId, "triage-agent");
  assert.equal(
    descriptor.specification.testEvidence.evidenceHash,
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assert.deepEqual(
    authorizeCalls.map(({ action }) => action),
    ["resource:draft-register", "resource:publication-submit"],
  );
  assert.equal(state.records.approval.projectId, "case-assist");
});

test("Platform Admin publishes a tested platform Agent", async () => {
  const state = memoryState({
    currentProject: {
      domainId: "platform",
      id: "platform-foundation",
      name: "Platform Foundation",
      description: "Platform-owned Agent workspace.",
      ownerSubject: "admin-sub",
      memberSubjects: ["admin-sub"],
      status: "ACTIVE",
      createdBySubject: "admin-sub",
      createdAt: "2026-08-25T07:00:00.000Z",
    },
    currentAgent: testedAgent({
      domainId: "platform",
      projectId: "platform-foundation",
      id: "design-assistant",
      name: "Agent Design Assistant",
      description: "Creates governed Agent specifications.",
      ownerSubject: "admin-sub",
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
      toolIds: [],
      mcpServerIds: [],
      skillIds: [],
      blueprintIds: ["chat-assistant"],
      memoryIds: [],
      knowledgeBaseIds: [],
      buildConfig: null,
      status: "TESTED",
      createdBySubject: "admin-sub",
      createdAt: "2026-08-25T07:00:00.000Z",
      updatedAt: "2026-08-25T08:00:00.000Z",
      lastTestStatus: "SUCCEEDED",
      lastTestedAt: "2026-08-25T08:00:00.000Z",
      lastTestedBySubject: "admin-sub",
      lastTestModelId: "bedrock-claude/anthropic.claude-sonnet-5",
      lastTestInputTokens: 12,
      lastTestOutputTokens: 7,
      lastTestRequestId: "platform-gateway-request",
      lastTestEvidenceHash:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      lastTestOutput: "Test response.",
    }),
  });
  const { service } = serviceWith({ state });

  const result = await service.publishAgent({
    identity: identity("admin", "admin-sub", null),
    requestId: "publish-platform-agent",
    domainId: "platform",
    projectId: "platform-foundation",
    agentId: "design-assistant",
  });

  assert.equal(result.record.domainId, "platform");
  assert.equal(result.record.status, "PENDING_APPROVAL");
  assert.equal(result.approval.projectId, "platform-foundation");
});

test("Agent publication rejects untested and unowned Builder Agents", async () => {
  const untested = serviceWith({
    state: memoryState({
      currentAgent: testedAgent({
        status: "READY_FOR_TEST",
        lastTestStatus: null,
        lastTestedAt: null,
        lastTestedBySubject: null,
        lastTestModelId: null,
        lastTestInputTokens: null,
        lastTestOutputTokens: null,
        lastTestRequestId: null,
        lastTestEvidenceHash: null,
        lastTestOutput: null,
      }),
    }),
  });
  await assert.rejects(
    untested.service.publishAgent({
      identity: identity(),
      requestId: "publish-untested-agent",
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(
    untested.registry.calls.some(
      (command) => command instanceof CreateRegistryRecordCommand,
    ),
    false,
  );

  const unowned = serviceWith({
    state: memoryState({
      currentAgent: testedAgent(),
      currentProject: {
        domainId: "customer_support",
        id: "case-assist",
        name: "Case Assist",
        description: "Support workspace.",
        ownerSubject: "other-sub",
        memberSubjects: ["other-sub"],
        status: "ACTIVE",
        createdBySubject: "lead-sub",
        createdAt: "2026-08-25T07:00:00.000Z",
      },
    }),
  });
  await assert.rejects(
    unowned.service.publishAgent({
      identity: identity(),
      requestId: "publish-unowned-agent",
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    }),
    expectCode("NOT_FOUND"),
  );
});

test("Agent publication retry does not create or submit a second record", async () => {
  const currentAgent = testedAgent();
  const fixture = serviceWith({
    state: memoryState({ currentAgent }),
  });
  const request = {
    identity: identity(),
    requestId: "publish-agent-retry",
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
  };

  const first = await fixture.service.publishAgent(request);
  currentAgent.status = "SANDBOX_DEPLOYED";
  const replay = await fixture.service.publishAgent(request);

  assert.deepEqual(replay, first);
  assert.equal(
    fixture.registry.calls.filter(
      (command) => command instanceof CreateRegistryRecordCommand,
    ).length,
    1,
  );
  assert.equal(
    fixture.registry.calls.filter(
      (command) =>
        command instanceof SubmitRegistryRecordForApprovalCommand,
    ).length,
    1,
  );
});

test("project-scoped Agent publication can be approved by a different Domain Lead", async () => {
  const state = memoryState({ currentAgent: testedAgent() });
  const registry = registryHarness();
  const { service } = serviceWith({ state, registry });

  const submitted = await service.publishAgent({
    identity: identity(),
    requestId: "publish-agent-before-approval",
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
  });
  const decided = await service.decidePublication({
    identity: identity("lead", "lead-sub"),
    requestId: "approve-published-agent",
    approvalId: submitted.approval.id,
    decision: "APPROVE",
    reason: "Approved after domain review.",
  });

  assert.equal(decided.record.status, "APPROVED");
  assert.equal(decided.approval.status, "APPROVED");
  assert.equal(decided.approval.projectId, "case-assist");
  assert.equal(decided.approval.approverSubject, "lead-sub");
});

test("governed draft versioning does not mistake prerelease text for build metadata", async () => {
  const { service, registry } = serviceWith();

  await service.registerDraft({
    identity: identity(),
    requestId: "prerelease-draft-request",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "prerelease-tool",
      displayName: "Prerelease Tool",
      description: "Verifies governed build metadata.",
      version: "1.0.0-rc.platform-descriptor.1",
      shared: false,
      specification: {
        entrypoint: "https://example.invalid/prerelease",
      },
    },
  });

  const create = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.equal(
    create.input.recordVersion,
    "1.0.0-rc.platform-descriptor.1",
  );
});

test("governed draft versions enforce strict SemVer prerelease identifiers", async () => {
  const { service } = serviceWith();

  await assert.rejects(
    service.registerDraft({
      identity: identity(),
      requestId: "invalid-prerelease-draft-request",
      resource: {
        domainId: "customer_support",
        resourceType: "TOOL",
        resourceId: "invalid-prerelease-tool",
        displayName: "Invalid Prerelease Tool",
        description: "Rejects invalid SemVer numeric prerelease identifiers.",
        version: "1.0.0-01",
        shared: false,
        specification: {
          entrypoint: "https://example.invalid/prerelease",
        },
      },
    }),
    expectCode("INVALID_REQUEST"),
  );
});

test("governed draft versioning rejects build metadata that folds into an illegal prerelease", async () => {
  // Poison samples: each is valid SemVer on input, but stripping `+` and
  // folding the build content into the prerelease segment yields a
  // leading-zero numeric identifier — illegal SemVer that the registry
  // service pattern ([a-zA-Z0-9.-]+) would still accept, creating a record
  // this service can never read back.
  const poisonVersions = ["1.0.0+01", "1.0.0+00.7", "1.0.0-rc.1+05"];
  for (const [index, version] of poisonVersions.entries()) {
    const { service, registry } = serviceWith();
    await assert.rejects(
      service.registerDraft({
        identity: identity(),
        requestId: `poison-build-draft-${index}`,
        resource: {
          domainId: "customer_support",
          resourceType: "TOOL",
          resourceId: "poison-build-tool",
          displayName: "Poison Build Tool",
          description: "Rejects build metadata folding into bad prerelease.",
          version,
          shared: false,
          specification: {
            entrypoint: "https://example.invalid/poison",
          },
        },
      }),
      expectCode("INVALID_REQUEST"),
      `expected INVALID_REQUEST for version ${version}`,
    );
    const create = registry.calls.find(
      (command) => command instanceof CreateRegistryRecordCommand,
    );
    assert.equal(
      create,
      undefined,
      `no CreateRegistryRecord may be sent for version ${version}`,
    );
  }
});

test("governed draft versioning still accepts build metadata that folds into a legal prerelease", async () => {
  // 1.2.3+abc folds into 1.2.3-abc.platform-descriptor.1 — legal SemVer.
  // The exit re-check must not reject it alongside the poison samples.
  const { service, registry } = serviceWith();
  await service.registerDraft({
    identity: identity(),
    requestId: "legal-build-draft-request",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "legal-build-tool",
      displayName: "Legal Build Tool",
      description: "Accepts build metadata folding into legal prerelease.",
      version: "1.2.3+abc",
      shared: false,
      specification: {
        entrypoint: "https://example.invalid/legal-build",
      },
    },
  });
  const create = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.equal(
    create.input.recordVersion,
    "1.2.3-abc.platform-descriptor.1",
  );
});

test("draft version length is capped so the governed suffix fits the registry limit", async () => {
  // Server-side RegistryRecordVersion max is 255; governedRecordVersion
  // appends separator + "platform-descriptor.1" (22 chars), so the input
  // cap is 233. At exactly 233 the governed version is exactly 255.
  const longestVersion = `1.0.0-${"a".repeat(233 - "1.0.0-".length)}`;
  assert.equal(longestVersion.length, 233);

  const { service, registry } = serviceWith();
  await service.registerDraft({
    identity: identity(),
    requestId: "longest-version-draft-request",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "longest-version-tool",
      displayName: "Longest Version Tool",
      description: "Accepts the longest version the governed suffix allows.",
      version: longestVersion,
      shared: false,
      specification: {
        entrypoint: "https://example.invalid/longest-version",
      },
    },
  });
  const create = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.equal(
    create.input.recordVersion,
    `${longestVersion}.platform-descriptor.1`,
  );
  assert.equal(create.input.recordVersion.length, 255);
});

test("draft version one character over the cap is rejected as INVALID_REQUEST", async () => {
  // Poison sample: 234 chars is still valid SemVer, but the governed
  // version would be 256 > the 255 server max. Before the cap the server
  // rejected it and the error surfaced as REGISTRY_UNAVAILABLE — the
  // assertion on the code pins the corrected INVALID_REQUEST semantics.
  const overlongVersion = `1.0.0-${"a".repeat(234 - "1.0.0-".length)}`;
  assert.equal(overlongVersion.length, 234);

  const { service, registry } = serviceWith();
  await assert.rejects(
    service.registerDraft({
      identity: identity(),
      requestId: "overlong-version-draft-request",
      resource: {
        domainId: "customer_support",
        resourceType: "TOOL",
        resourceId: "overlong-version-tool",
        displayName: "Overlong Version Tool",
        description: "Rejects versions that overflow the registry limit.",
        version: overlongVersion,
        shared: false,
        specification: {
          entrypoint: "https://example.invalid/overlong-version",
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof GovernanceServiceError);
      assert.equal(error.code, "INVALID_REQUEST");
      assert.notEqual(error.code, "REGISTRY_UNAVAILABLE");
      return true;
    },
  );
  const create = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.equal(create, undefined);
});

test("governed draft versioning keeps the plain release positive path", async () => {
  const { service, registry } = serviceWith();
  await service.registerDraft({
    identity: identity(),
    requestId: "plain-release-draft-request",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "plain-release-tool",
      displayName: "Plain Release Tool",
      description: "Keeps the plain release version positive path.",
      version: "1.0.0",
      shared: false,
      specification: {
        entrypoint: "https://example.invalid/plain-release",
      },
    },
  });
  const create = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.equal(
    create.input.recordVersion,
    "1.0.0-platform-descriptor.1",
  );
});

test("draft registration binds before Registry and permanently rejects request-ID payload changes", async () => {
  const events = [];
  const state = memoryState({ events });
  const registry = registryHarness({ events });
  const { service } = serviceWith({ state, registry });
  const request = {
    identity: identity(),
    requestId: "durable-draft-request",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "case-triage",
      displayName: "Case Triage",
      description: "Routes cases to an approved queue.",
      version: "1.0.0",
      shared: true,
      specification: {
        entrypoint: "https://example.invalid/resource",
      },
    },
  };

  await service.registerDraft(request);

  assert.ok(
    events.indexOf("claimMutation")
      < events.indexOf("CreateRegistryRecordCommand"),
  );
  assert.ok(
    events.indexOf("CreateRegistryRecordCommand")
      < events.indexOf("appendAudit"),
  );
  assert.equal(state.claims.size, 1);
  assert.equal(state.mutations.size, 1);

  const createsAfterSuccess = registry.calls.filter(
    (command) => command instanceof CreateRegistryRecordCommand,
  ).length;
  await service.registerDraft(request);
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof CreateRegistryRecordCommand,
    ).length,
    createsAfterSuccess,
  );

  await assert.rejects(
    service.registerDraft({
      ...request,
      resource: {
        ...request.resource,
        displayName: "Changed Case Triage",
      },
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof CreateRegistryRecordCommand,
    ).length,
    createsAfterSuccess,
  );
});

test("draft retry reconciles AgentCore after terminal evidence persistence fails", async () => {
  const events = [];
  const state = memoryState({ events });
  const appendAudit = state.appendAudit.bind(state);
  let completionAttempts = 0;
  state.appendAudit = async (input) => {
    completionAttempts += 1;
    events.push("appendAudit");
    if (completionAttempts === 1) {
      throw Object.assign(new Error("state unavailable"), {
        code: "STATE_UNAVAILABLE",
      });
    }
    return appendAudit(input);
  };
  const registry = registryHarness({ events });
  const { service } = serviceWith({ state, registry });
  const request = {
    identity: identity(),
    requestId: "failed-draft-completion",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "case-triage",
      displayName: "Case Triage",
      description: "Routes cases to an approved queue.",
      version: "1.0.0",
      shared: true,
      specification: {},
    },
  };

  await assert.rejects(
    service.registerDraft(request),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
  const firstCreate = registry.calls.find(
    (command) => command instanceof CreateRegistryRecordCommand,
  );

  const recovered = await service.registerDraft(request);
  assert.equal(recovered.status, "DRAFT");
  const creates = registry.calls.filter(
    (command) => command instanceof CreateRegistryRecordCommand,
  );
  assert.equal(creates.length, 2);
  assert.equal(creates[1].input.clientToken, firstCreate.input.clientToken);
  assert.equal(registry.records.size, 1);
  assert.equal(state.mutations.size, 1);

  await assert.rejects(
    service.registerDraft({
      ...request,
      resource: {
        ...request.resource,
        description: "A changed payload cannot reuse this request ID.",
      },
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof CreateRegistryRecordCommand,
    ).length,
    creates.length,
  );
});

test("draft completion retries a transient audit clock mismatch without recreating the Registry record", async () => {
  const events = [];
  const state = memoryState({ events });
  const appendAudit = state.appendAudit.bind(state);
  let appendAttempts = 0;
  state.appendAudit = async (input) => {
    appendAttempts += 1;
    if (appendAttempts === 1) {
      throw Object.assign(new Error("clock advanced"), {
        code: "INVALID_AUDIT",
      });
    }
    return appendAudit(input);
  };
  const registry = registryHarness({ events });
  const { service } = serviceWith({ state, registry });

  const result = await service.registerDraft({
    identity: identity(),
    requestId: "draft-clock-retry",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "case-triage",
      displayName: "Case Triage",
      description: "Routes cases to an approved queue.",
      version: "1.0.0",
      shared: true,
      specification: {},
    },
  });

  assert.equal(result.status, "DRAFT");
  assert.equal(appendAttempts, 2);
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof CreateRegistryRecordCommand,
    ).length,
    1,
  );
});

test("draft completion passes the original transaction clock to durable audit state", async () => {
  const state = memoryState();
  const appendAudit = state.appendAudit.bind(state);
  state.appendAudit = async (input) => {
    assert.ok(input.transaction);
    assert.equal(input.transaction.timestamp, input.record.timestamp);
    return appendAudit(input);
  };
  const registry = registryHarness();
  const { service } = serviceWith({ state, registry });

  const result = await service.registerDraft({
    identity: identity(),
    requestId: "draft-transaction-clock",
    resource: {
      domainId: "customer_support",
      resourceType: "TOOL",
      resourceId: "case-triage",
      displayName: "Case Triage",
      description: "Routes cases to an approved queue.",
      version: "1.0.0",
      shared: true,
      specification: {},
    },
  });

  assert.equal(result.status, "DRAFT");
});

test("builder submission advances the real Registry record and creates domain approval", async () => {
  const registry = registryHarness({
    records: [record()],
  });
  const { service, state, authorizeCalls } = serviceWith({ registry });
  const result = await service.submitPublication({
    identity: identity(),
    requestId: "submit-request",
    approvalId: "publish-case-triage",
    registryId: REGISTRIES.customer_support,
    recordId: "Rec123456789",
  });

  assert.equal(result.record.status, "PENDING_APPROVAL");
  assert.equal(result.approval.status, "PENDING");
  assert.equal(result.approval.kind, "RESOURCE_PUBLICATION");
  assert.equal(authorizeCalls[0].action, "resource:publication-submit");
  assert.ok(
    registry.calls.some(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ),
  );
  assert.equal(state.writes[0][0], "approval");
  assert.equal(
    state.writes[0][1].mutation.result.resourceKey,
    "approval/customer_support/publish-case-triage",
  );
});

test("publication submission binds before Registry and permanently rejects request-ID payload changes", async () => {
  const events = [];
  const state = memoryState({ events });
  const registry = registryHarness({
    events,
    records: [record()],
  });
  const { service } = serviceWith({ state, registry });
  const request = {
    identity: identity(),
    requestId: "durable-submit-request",
    approvalId: "publish-case-triage",
    registryId: REGISTRIES.customer_support,
    recordId: "Rec123456789",
  };

  await service.submitPublication(request);

  assert.ok(
    events.indexOf("claimMutation")
      < events.indexOf("SubmitRegistryRecordForApprovalCommand"),
  );
  assert.ok(
    events.indexOf("SubmitRegistryRecordForApprovalCommand")
      < events.indexOf("putApproval"),
  );
  assert.equal(state.claims.size, 1);
  assert.equal(state.mutations.size, 1);

  const submissionsAfterSuccess = registry.calls.filter(
    (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
  ).length;
  await service.submitPublication(request);
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ).length,
    submissionsAfterSuccess,
  );

  await assert.rejects(
    service.submitPublication({
      ...request,
      approvalId: "publish-case-triage-changed",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ).length,
    submissionsAfterSuccess,
  );
});

test("publication retry reconciles pending AgentCore state after local persistence fails", async () => {
  const events = [];
  const state = memoryState({ events });
  const putApproval = state.putApproval.bind(state);
  let completionAttempts = 0;
  state.putApproval = async (input) => {
    completionAttempts += 1;
    events.push("putApproval");
    if (completionAttempts === 1) {
      throw Object.assign(new Error("state unavailable"), {
        code: "STATE_UNAVAILABLE",
      });
    }
    return putApproval(input);
  };
  const registry = registryHarness({
    events,
    records: [record()],
  });
  const { service } = serviceWith({ state, registry });
  const request = {
    identity: identity(),
    requestId: "failed-submit-completion",
    approvalId: "publish-case-triage",
    registryId: REGISTRIES.customer_support,
    recordId: "Rec123456789",
  };

  await assert.rejects(
    service.submitPublication(request),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
  const submissionsAfterFailure = registry.calls.filter(
    (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
  ).length;

  const recovered = await service.submitPublication(request);
  assert.equal(recovered.record.status, "PENDING_APPROVAL");
  assert.equal(recovered.approval.status, "PENDING");
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ).length,
    submissionsAfterFailure,
  );

  await assert.rejects(
    service.submitPublication({
      ...request,
      approvalId: "changed-publication-request",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ).length,
    submissionsAfterFailure,
  );
});

test("publication submission recovers when Registry is already pending approval", async () => {
  const registry = registryHarness({
    records: [record({ status: "PENDING_APPROVAL" })],
  });
  const state = memoryState();
  const authorizeCalls = [];
  const service = createGovernanceService({
    workspaceState: state,
    domainDirectory: {
      async getDomain(id) {
        return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
      },
      async listActiveDomains() {
        return Object.keys(REGISTRIES).map(domain);
      },
    },
    registryClient: registry.client,
    async authorizer(input) {
      authorizeCalls.push(input);
      const descriptor = JSON.parse(
        Buffer.from(
          input.resourceRef.slice("governance:".length),
          "base64url",
        ).toString("utf8"),
      );
      assert.equal(descriptor.lifecycleState, "DRAFT");
      return { ok: true };
    },
    mutationClaimResolver: state.getMutationClaim.bind(state),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  });

  const result = await service.submitPublication({
    identity: identity(),
    requestId: "recover-submit-request",
    approvalId: "publish-case-triage",
    registryId: REGISTRIES.customer_support,
    recordId: "Rec123456789",
  });

  assert.equal(result.record.status, "PENDING_APPROVAL");
  assert.equal(result.approval.status, "PENDING");
  assert.equal(authorizeCalls.length, 1);
  assert.equal(
    registry.calls.some(
      (command) =>
        command instanceof SubmitRegistryRecordForApprovalCommand,
    ),
    false,
  );
});

test("platform admin initiates a publication on the owner's behalf across domains", async () => {
  const registry = registryHarness({
    records: [record({ domainId: "operations", ownerSubject: "builder-sub" })],
  });
  const { service, state, authorizeCalls } = serviceWith({ registry });
  const result = await service.initiatePublication({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "initiate-request",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    reason: "Discovered in-review; opening it for a platform decision.",
  });

  assert.equal(result.record.status, "PENDING_APPROVAL");
  assert.equal(result.approval.status, "PENDING");
  assert.equal(result.approval.kind, "RESOURCE_PUBLICATION");
  assert.equal(result.approval.domainId, "operations");
  // The TRUE initiator/requester is the authenticated admin (identity.actor),
  // NOT the resource owner. This is what the requester != approver guard
  // compares against, so the initiating admin cannot also decide.
  assert.equal(result.approval.requesterSubject, "admin-sub");
  // The resource owner is retained separately in the mutation audit payload.
  assert.equal(state.writes[0][1].mutation.payloadFingerprint.length > 0, true);
  assert.equal(authorizeCalls[0].action, "resource:publication-initiate");
  assert.ok(
    registry.calls.some(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ),
  );
  assert.equal(state.writes[0][0], "approval");
  assert.equal(
    state.writes[0][1].mutation.result.resourceKey.startsWith(
      "approval/operations/publish-",
    ),
    true,
  );
});

test("admin-initiate reconciles when the record is already pending approval", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "operations",
      ownerSubject: "builder-sub",
      status: "PENDING_APPROVAL",
    })],
  });
  const { service, authorizeCalls } = serviceWith({ registry });
  const result = await service.initiatePublication({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "initiate-pending",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    reason: "Already pending; record the formal request.",
  });
  assert.equal(result.record.status, "PENDING_APPROVAL");
  assert.equal(result.approval.status, "PENDING");
  assert.equal(authorizeCalls.length, 1);
  // A record already pending approval must not be re-submitted.
  assert.equal(
    registry.calls.some(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ),
    false,
  );
});

test("admin-initiate is idempotent per request ID and rejects a second submit", async () => {
  const registry = registryHarness({
    records: [record({ domainId: "operations", ownerSubject: "builder-sub" })],
  });
  const { service } = serviceWith({ registry });
  const request = {
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "initiate-durable",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    reason: "Opening this in-review resource for decision.",
  };
  await service.initiatePublication(request);
  const submitsAfterFirst = registry.calls.filter(
    (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
  ).length;
  const repeated = await service.initiatePublication(request);
  assert.equal(repeated.approval.status, "PENDING");
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ).length,
    submitsAfterFirst,
  );
});

test("admin-initiate fails closed for a non-admin caller", async () => {
  const registry = registryHarness({
    records: [record({ domainId: "operations", ownerSubject: "builder-sub" })],
  });
  const { service, registry: reg } = serviceWith({ registry });
  for (const role of ["lead", "builder"]) {
    await assert.rejects(
      service.initiatePublication({
        identity: identity(role, `${role}-sub`, "operations"),
        requestId: `initiate-${role}`,
        registryId: REGISTRIES.operations,
        recordId: "Rec123456789",
        reason: "Attempted non-admin initiate.",
      }),
      expectCode("FORBIDDEN"),
    );
  }
  assert.equal(
    reg.calls.some(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ),
    false,
  );
});

test("admin-initiate is denied when the authorizer refuses the initiate action", async () => {
  const registry = registryHarness({
    records: [record({ domainId: "operations", ownerSubject: "builder-sub" })],
  });
  const { service } = serviceWith({
    registry,
    deniedActions: ["resource:publication-initiate"],
  });
  await assert.rejects(
    service.initiatePublication({
      identity: identity("admin", "admin-sub", "platform"),
      requestId: "initiate-denied",
      registryId: REGISTRIES.operations,
      recordId: "Rec123456789",
      reason: "Should be blocked by policy.",
    }),
    expectCode("FORBIDDEN"),
  );
  assert.equal(
    registry.calls.some(
      (command) => command instanceof SubmitRegistryRecordForApprovalCommand,
    ),
    false,
  );
});

test("admin-initiate refuses a self-owned resource and a missing reason", async () => {
  const registry = registryHarness({
    records: [record({ domainId: "operations", ownerSubject: "admin-sub" })],
  });
  const { service } = serviceWith({ registry });
  // Self-owned: an admin cannot initiate then decide their own resource.
  await assert.rejects(
    service.initiatePublication({
      identity: identity("admin", "admin-sub", "platform"),
      requestId: "initiate-self",
      registryId: REGISTRIES.operations,
      recordId: "Rec123456789",
      reason: "Owner is the admin.",
    }),
    expectCode("CONFLICT"),
  );
  // Missing reason fails validation before any write.
  await assert.rejects(
    service.initiatePublication({
      identity: identity("admin", "admin-sub", "platform"),
      requestId: "initiate-noreason",
      registryId: REGISTRIES.operations,
      recordId: "Rec123456789",
      reason: "",
    }),
    expectCode("INVALID_REQUEST"),
  );
});

test("admin-initiated publication is decidable end-to-end by a DIFFERENT reviewer (POS acceptance)", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "operations",
      ownerSubject: "ops-builder",
      status: "DRAFT",
    })],
  });
  const { service, state } = serviceWithProductionAuthorizer({ registry });
  const initiated = await service.initiatePublication({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "initiate-e2e",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    reason: "Admin opens the in-review resource for a domain decision.",
  });
  assert.equal(initiated.approval.status, "PENDING");
  // TRUE initiator is the authenticated admin, not the owner.
  assert.equal(initiated.approval.requesterSubject, "admin-sub");
  assert.equal(initiated.record.status, "PENDING_APPROVAL");
  // Initiate audit retains the true initiator (admin) as requesterSubject.
  const initiateAudit = state.writes.find(
    ([kind]) => kind === "approval",
  )[1].mutation;
  assert.equal(initiateAudit.actor, "admin-sub");
  assert.equal(initiateAudit.requesterSubject, "admin-sub");

  const approvalId = initiated.approval.id;
  const decided = await service.decidePublication({
    identity: identity("lead", "ops-lead", "operations"),
    requestId: "decide-e2e",
    approvalId,
    decision: "APPROVE",
    reason: "Approved after domain review of the admin-initiated request.",
  });
  assert.equal(decided.approval.status, "APPROVED");
  assert.equal(decided.approval.approverSubject, "ops-lead");
  assert.equal(decided.record.status, "APPROVED");
  assert.equal(state.records.approval.status, "APPROVED");

  // Read back the persisted approval: status flipped and the true initiator is
  // still recorded as requesterSubject while the decider is the approver.
  const persisted = await state.getApproval({
    domainId: "operations",
    approvalId,
  });
  assert.equal(persisted.status, "APPROVED");
  assert.equal(persisted.requesterSubject, "admin-sub");
  assert.equal(persisted.approverSubject, "ops-lead");

  // The decision audit retains BOTH the true initiator identity (requester =
  // admin) AND the decider identity (actor = ops-lead) plus the reason.
  const decisionAudit = state.writes
    .filter(([kind]) => kind === "approval")
    .at(-1)[1].mutation;
  assert.equal(decisionAudit.actor, "ops-lead");
  assert.equal(decisionAudit.requesterSubject, "admin-sub");
  assert.equal(decisionAudit.decision, "approve");
  assert.equal(
    decisionAudit.reason,
    "Approved after domain review of the admin-initiated request.",
  );
});

test("admin who initiated a publication cannot also decide it (NEG self-approval acceptance)", async () => {
  // Platform-domain resource owned by someone else. Admin governance actions
  // run in the 'platform' domain, so an admin who initiates a platform-domain
  // publication could reach decidePublication for that same approval -- this is
  // exactly the self-approval path that must be blocked by the true-initiator
  // guard.
  const registry = registryHarness({
    records: [record({
      domainId: "platform",
      ownerSubject: "plat-builder",
      status: "DRAFT",
    })],
  });
  const { service, state } = serviceWithProductionAuthorizer({ registry });
  const initiated = await service.initiatePublication({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "initiate-selfapprove",
    registryId: REGISTRIES.platform,
    recordId: "Rec123456789",
    reason: "Admin opens the in-review resource for a decision.",
  });
  const approvalId = initiated.approval.id;
  // TRUE initiator persisted is the authenticated admin, not the owner.
  assert.equal(initiated.approval.requesterSubject, "admin-sub");
  assert.equal(state.records.approval.status, "PENDING");
  const writesBefore = state.writes.length;

  // The SAME admin (the true initiator) attempts to decide the SAME request.
  await assert.rejects(
    service.decidePublication({
      identity: identity("admin", "admin-sub", "platform"),
      requestId: "decide-selfapprove",
      approvalId,
      decision: "APPROVE",
      reason: "Initiator attempts to self-approve their own request.",
    }),
    (error) =>
      error instanceof GovernanceServiceError
      && error.code === "REQUESTER_CANNOT_APPROVE",
  );

  // Fail-closed: approval status is UNCHANGED and no decision audit was written.
  const persisted = await state.getApproval({
    domainId: "platform",
    approvalId,
  });
  assert.equal(persisted.status, "PENDING");
  assert.equal(persisted.approverSubject, null);
  assert.equal(persisted.requesterSubject, "admin-sub");
  assert.equal(state.records.approval.status, "PENDING");
  assert.equal(state.writes.length, writesBefore);
  // No UpdateRegistryRecordStatusCommand (the record was not decided).
  assert.equal(
    registry.calls.some(
      (command) => command instanceof UpdateRegistryRecordStatusCommand,
    ),
    false,
  );
});

test("admin-initiated publication: owner cannot self-approve their own request either", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "operations",
      ownerSubject: "ops-builder",
      status: "DRAFT",
    })],
  });
  const { service } = serviceWithProductionAuthorizer({ registry });
  const initiated = await service.initiatePublication({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "initiate-owner-guard",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    reason: "Admin opens the in-review resource for a decision.",
  });
  const approvalId = initiated.approval.id;

  // Ownership must block even an otherwise authorized reviewer.
  await assert.rejects(
    service.decidePublication({
      identity: identity("lead", "ops-builder", "operations"),
      requestId: "decide-owner-guard",
      approvalId,
      decision: "APPROVE",
      reason: "Owner attempts to decide their own resource.",
    }),
    (error) =>
      error instanceof GovernanceServiceError
      && (error.code === "FORBIDDEN"
        || error.code === "REQUESTER_CANNOT_APPROVE"),
  );
});

test("different Domain Lead approves publication and requester cannot self-approve", async () => {
  const registry = registryHarness({
    records: [record({ status: "PENDING_APPROVAL" })],
  });
  const state = memoryState({
    currentApproval: approval(),
  });
  const { service } = serviceWith({ registry, state });

  const result = await service.decidePublication({
    identity: identity("lead", "lead-sub"),
    requestId: "decision-request",
    approvalId: "publish-case-triage",
    decision: "APPROVE",
    reason: "Approved after domain review.",
  });
  assert.equal(result.record.status, "APPROVED");
  assert.equal(result.approval.status, "APPROVED");
  assert.equal(result.approval.approverSubject, "lead-sub");

  const selfState = memoryState({
    currentApproval: approval({ requesterSubject: "lead-sub" }),
  });
  const self = serviceWith({ registry, state: selfState }).service;
  await assert.rejects(
    self.decidePublication({
      identity: identity("lead", "lead-sub"),
      requestId: "self-decision",
      approvalId: "publish-case-triage",
      decision: "APPROVE",
      reason: "I approve my own resource.",
    }),
    expectCode("REQUESTER_CANNOT_APPROVE"),
  );
});

test("publication decision binds before Registry and permanently rejects request-ID payload changes", async () => {
  const events = [];
  const state = memoryState({
    currentApproval: approval(),
    events,
  });
  const registry = registryHarness({
    events,
    records: [record({ status: "PENDING_APPROVAL" })],
  });
  const { service } = serviceWith({ state, registry });
  const request = {
    identity: identity("lead", "lead-sub"),
    requestId: "durable-decision-request",
    approvalId: "publish-case-triage",
    decision: "APPROVE",
    reason: "Approved after domain review.",
  };

  await service.decidePublication(request);

  assert.ok(
    events.indexOf("claimMutation")
      < events.indexOf("UpdateRegistryRecordStatusCommand"),
  );
  assert.ok(
    events.indexOf("UpdateRegistryRecordStatusCommand")
      < events.indexOf("putApproval"),
  );
  assert.equal(state.claims.size, 1);
  assert.equal(state.mutations.size, 1);

  const decisionsAfterSuccess = registry.calls.filter(
    (command) => command instanceof UpdateRegistryRecordStatusCommand,
  ).length;
  await service.decidePublication(request);
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    decisionsAfterSuccess,
  );

  await assert.rejects(
    service.decidePublication({
      ...request,
      decision: "REJECT",
      reason: "Changed decision for the same request.",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    decisionsAfterSuccess,
  );
});

test("decision retry reconciles moderated AgentCore state after local persistence fails", async () => {
  const events = [];
  const state = memoryState({
    currentApproval: approval(),
    events,
  });
  const putApproval = state.putApproval.bind(state);
  let completionAttempts = 0;
  state.putApproval = async (input) => {
    completionAttempts += 1;
    events.push("putApproval");
    if (completionAttempts === 1) {
      throw Object.assign(new Error("state unavailable"), {
        code: "STATE_UNAVAILABLE",
      });
    }
    return putApproval(input);
  };
  const registry = registryHarness({
    events,
    records: [record({ status: "PENDING_APPROVAL" })],
  });
  const { service } = serviceWith({ state, registry });
  const request = {
    identity: identity("lead", "lead-sub"),
    requestId: "failed-decision-completion",
    approvalId: "publish-case-triage",
    decision: "APPROVE",
    reason: "Approved after domain review.",
  };

  await assert.rejects(
    service.decidePublication(request),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
  const decisionsAfterFailure = registry.calls.filter(
    (command) => command instanceof UpdateRegistryRecordStatusCommand,
  ).length;

  const recovered = await service.decidePublication(request);
  assert.equal(recovered.record.status, "APPROVED");
  assert.equal(recovered.approval.status, "APPROVED");
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    decisionsAfterFailure,
  );

  await assert.rejects(
    service.decidePublication({
      ...request,
      decision: "REJECT",
      reason: "Changed decision for the same request.",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    decisionsAfterFailure,
  );
});

test("production authorizer permits an identical publication approval retry after completion", async () => {
  const events = [];
  const state = memoryState({
    currentApproval: approval(),
    events,
  });
  const registry = registryHarness({
    events,
    records: [record({ status: "PENDING_APPROVAL" })],
  });
  const { service } = serviceWithProductionAuthorizer({
    state,
    registry,
  });
  const request = {
    identity: identity("lead", "lead-sub"),
    requestId: "production-publication-approval-retry",
    approvalId: "publish-case-triage",
    decision: "APPROVE",
    reason: "Approved after domain review.",
  };

  const approved = await service.decidePublication(request);
  const registryDecisions = registry.calls.filter(
    (command) => command instanceof UpdateRegistryRecordStatusCommand,
  ).length;
  const replayed = await service.decidePublication(request);

  assert.deepEqual(replayed, approved);
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    registryDecisions,
  );
});

test("Registry-terminal publication recovery requires the original exact mutation claim", async () => {
  const events = [];
  const state = memoryState({
    currentApproval: approval(),
    events,
  });
  const putApproval = state.putApproval.bind(state);
  let completionAttempts = 0;
  state.putApproval = async (input) => {
    completionAttempts += 1;
    events.push("putApproval");
    if (completionAttempts === 1) {
      throw Object.assign(new Error("state unavailable"), {
        code: "STATE_UNAVAILABLE",
      });
    }
    return putApproval(input);
  };
  const registry = registryHarness({
    events,
    records: [record({ status: "PENDING_APPROVAL" })],
  });
  const { service } = serviceWithProductionAuthorizer({
    state,
    registry,
  });
  const original = {
    identity: identity("lead", "lead-sub"),
    requestId: "claimed-publication-recovery",
    approvalId: "publish-case-triage",
    decision: "APPROVE",
    reason: "Approved after domain review.",
  };

  await assert.rejects(
    service.decidePublication(original),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
  assert.equal(state.records.approval.status, "PENDING");
  assert.equal(state.claims.size, 1);

  await assert.rejects(
    service.decidePublication({
      ...original,
      identity: identity("lead", "other-lead-sub"),
      requestId: "adopt-publication-recovery",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(state.records.approval.status, "PENDING");
  assert.equal(state.claims.size, 1);

  const recovered = await service.decidePublication(original);
  assert.equal(recovered.record.status, "APPROVED");
  assert.equal(recovered.approval.status, "APPROVED");
  assert.equal(recovered.approval.approverSubject, "lead-sub");
});

test("Platform Admin approves platform publication through the production authorizer", async () => {
  const state = memoryState({
    currentApproval: approval({
      domainId: "platform",
      resourceId: "PlatReg123456/Rec123456789",
    }),
  });
  const registry = registryHarness({
    records: [record({
      domainId: "platform",
      status: "PENDING_APPROVAL",
    })],
  });
  const { service } = serviceWithProductionAuthorizer({
    state,
    registry,
  });

  const result = await service.decidePublication({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "platform-publication-approval",
    approvalId: "publish-case-triage",
    decision: "APPROVE",
    reason: "Approved by a peer platform administrator.",
  });

  assert.equal(result.record.status, "APPROVED");
  assert.equal(result.approval.status, "APPROVED");
  assert.equal(result.approval.approverSubject, "admin-sub");
});

test("production authorizer does not let another approver or decision adopt a completed publication approval", async () => {
  const reason = "Approved after domain review.";
  const state = memoryState({
    currentApproval: approval({
      status: "APPROVED",
      approverSubject: "lead-sub",
      reason,
      decidedAt: "2026-08-25T08:01:00.000Z",
    }),
  });
  const registry = registryHarness({
    records: [record({ status: "APPROVED" })],
  });
  const { service } = serviceWithProductionAuthorizer({
    state,
    registry,
  });
  const request = {
    identity: identity("lead", "lead-sub"),
    requestId: "completed-publication-approval",
    approvalId: "publish-case-triage",
    decision: "APPROVE",
    reason,
  };

  await assert.rejects(
    service.decidePublication({
      ...request,
      identity: identity("lead", "other-lead-sub"),
    }),
    expectCode("FORBIDDEN"),
  );
  await assert.rejects(
    service.decidePublication({
      ...request,
      decision: "REJECT",
      reason: "Changed after the approval completed.",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(state.writes.length, 0);
});

test("shared discovery returns only approved foreign shared records", async () => {
  const registry = registryHarness({
    records: [
      record({ status: "APPROVED", shared: true }),
      record({
        domainId: "operations",
        recordId: "Rec987654321",
        resourceId: "ops-triage",
        status: "APPROVED",
        shared: true,
      }),
      record({
        domainId: "platform",
        recordId: "Rec222222222",
        resourceId: "private-tool",
        status: "APPROVED",
        shared: false,
      }),
      record({
        domainId: "platform",
        recordId: "Rec333333333",
        resourceId: "draft-tool",
        status: "DRAFT",
        shared: true,
      }),
    ],
  });
  const { service } = serviceWith({ registry });
  const result = await service.discoverShared({
    identity: identity(),
    limit: 20,
  });

  assert.deepEqual(
    result.items.map((item) => [item.domainId, item.resourceId]),
    [["operations", "ops-triage"]],
  );
  assert.equal(result.items[0].granted, false);
  assert.equal(Object.hasOwn(result.items[0], "specification"), false);
});

test("shared discovery ignores legacy records that cannot prove governed sharing", async () => {
  const registry = registryHarness({
    records: [
      legacyRecord(),
      record({
        domainId: "operations",
        recordId: "Rec987654321",
        resourceId: "ops-triage",
        status: "APPROVED",
        shared: true,
      }),
    ],
  });
  const { service } = serviceWith({ registry });

  const result = await service.discoverShared({
    identity: identity(),
    limit: 20,
  });

  assert.deepEqual(
    result.items.map((item) => [item.domainId, item.resourceId]),
    [["operations", "ops-triage"]],
  );
});

test("governance rejects malformed governed descriptors without fallback", async () => {
  const malformed = record({
    domainId: "operations",
    recordId: "RecBadSchema",
    resourceId: "malformed-skill",
    resourceType: "SKILL",
    status: "APPROVED",
    shared: true,
  });
  const descriptor = JSON.parse(
    malformed.descriptors.custom.data,
  );
  delete descriptor.schemaVersion;
  malformed.descriptors.custom.data = JSON.stringify(descriptor);
  const registry = registryHarness({ records: [malformed] });
  const { service } = serviceWith({ registry });

  await assert.rejects(
    service.discoverShared({
      identity: identity(),
      limit: 10,
    }),
    expectCode("REGISTRY_UNAVAILABLE"),
  );

  await assert.rejects(
    service.requestAccess(accessRequest({
      recordId: malformed.recordId,
    })),
    expectCode("REGISTRY_UNAVAILABLE"),
  );
});

test("governance rejects governed records without the governed version marker", async () => {
  const malformed = record({
    domainId: "operations",
    recordId: "RecNoVers001",
    resourceId: "unsuffixed-skill",
    resourceType: "SKILL",
    status: "APPROVED",
    shared: true,
  });
  malformed.recordVersion = "1.0.0";
  const registry = registryHarness({ records: [malformed] });
  const { service } = serviceWith({ registry });

  await assert.rejects(
    service.discoverShared({
      identity: identity(),
      limit: 10,
    }),
    expectCode("REGISTRY_UNAVAILABLE"),
  );
  await assert.rejects(
    service.requestAccess(accessRequest({
      recordId: malformed.recordId,
    })),
    expectCode("REGISTRY_UNAVAILABLE"),
  );
});

test("governance binds governed resource type to the AWS record type", async () => {
  const malformed = record({
    domainId: "operations",
    recordId: "RecWrongType",
    resourceId: "wrong-type",
    resourceType: "AGENT",
    status: "APPROVED",
    shared: true,
  });
  const descriptor = JSON.parse(malformed.descriptors.custom.data);
  malformed.recordType = "SKILL";
  malformed.descriptors = {
    agentSkillsDefinition: {
      data: JSON.stringify(descriptor),
    },
  };
  const registry = registryHarness({ records: [malformed] });
  const { service } = serviceWith({ registry });

  await assert.rejects(
    service.discoverShared({
      identity: identity(),
      limit: 10,
    }),
    expectCode("REGISTRY_UNAVAILABLE"),
  );
  await assert.rejects(
    service.requestAccess(accessRequest({
      recordId: malformed.recordId,
    })),
    expectCode("REGISTRY_UNAVAILABLE"),
  );
});

test("shared discovery rejects duplicate record and logical resource identities", async (t) => {
  await t.test("duplicate record across pages", async () => {
    const shared = record({
      domainId: "operations",
      recordId: "RecDuplicate",
      resourceId: "duplicate-tool",
      status: "APPROVED",
      shared: true,
    });
    const registry = registryHarness({
      records: [shared],
      listRegistryRecords(input) {
        return {
          registryRecords: [{
            recordId: shared.recordId,
            status: "APPROVED",
          }],
          ...(input.nextToken === undefined
            ? { nextToken: "second-page" }
            : {}),
        };
      },
    });
    const { service } = serviceWith({ registry });

    await assert.rejects(
      service.discoverShared({
        identity: identity(),
        limit: 10,
      }),
      expectCode("REGISTRY_UNAVAILABLE"),
    );
  });

  await t.test("duplicate logical resource", async () => {
    const registry = registryHarness({
      records: [
        record({
          domainId: "operations",
          recordId: "RecLogical01",
          resourceId: "same-tool",
          status: "APPROVED",
          shared: false,
        }),
        record({
          domainId: "operations",
          recordId: "RecLogical02",
          resourceId: "same-tool",
          status: "APPROVED",
          shared: true,
        }),
      ],
    });
    const { service } = serviceWith({ registry });

    await assert.rejects(
      service.discoverShared({
        identity: identity(),
        limit: 10,
      }),
      expectCode("REGISTRY_UNAVAILABLE"),
    );
  });

  await t.test("duplicate after the requested result limit", async () => {
    const registry = registryHarness({
      records: [
        record({
          domainId: "operations",
          recordId: "RecLimit0001",
          resourceId: "first-tool",
          status: "APPROVED",
          shared: true,
        }),
        record({
          domainId: "operations",
          recordId: "RecLimit0002",
          resourceId: "duplicate-after-limit",
          status: "APPROVED",
          shared: true,
        }),
        record({
          domainId: "operations",
          recordId: "RecLimit0003",
          resourceId: "duplicate-after-limit",
          status: "APPROVED",
          shared: true,
        }),
      ],
    });
    const { service } = serviceWith({ registry });

    await assert.rejects(
      service.discoverShared({
        identity: identity(),
        limit: 1,
      }),
      expectCode("REGISTRY_UNAVAILABLE"),
    );
  });
});

test("shared discovery returns the requested limit while validating its bounded scan", async () => {
  const registry = registryHarness({
    records: [
      record({
        domainId: "operations",
        recordId: "Rec987654321",
        resourceId: "private-ops-tool",
        status: "APPROVED",
        shared: false,
      }),
      record({
        domainId: "operations",
        recordId: "Rec876543210",
        resourceId: "shared-ops-tool",
        status: "APPROVED",
        shared: true,
      }),
      record({
        domainId: "platform",
        recordId: "Rec765432109",
        resourceId: "unused-platform-tool",
        status: "APPROVED",
        shared: true,
      }),
    ],
    listRegistryRecords(input) {
      if (
        input.registryId === REGISTRIES.operations
        && input.nextToken === undefined
      ) {
        return {
          registryRecords: [{
            recordId: "Rec987654321",
            status: "APPROVED",
          }],
          nextToken: "operations-page-2",
        };
      }
      if (
        input.registryId === REGISTRIES.operations
        && input.nextToken === "operations-page-2"
      ) {
        return {
          registryRecords: [{
            recordId: "Rec876543210",
            status: "APPROVED",
          }],
          nextToken: "unused-operations-page-3",
        };
      }
      if (
        input.registryId === REGISTRIES.operations
        && input.nextToken === "unused-operations-page-3"
      ) {
        return { registryRecords: [] };
      }
      if (
        input.registryId === REGISTRIES.platform
        && input.nextToken === undefined
      ) {
        return { registryRecords: [] };
      }
      throw new Error("Discovery escaped its bounded scan.");
    },
  });
  const { service } = serviceWith({ registry });

  const result = await service.discoverShared({
    identity: identity(),
    limit: 1,
  });

  assert.deepEqual(
    result.items.map((item) => [item.domainId, item.resourceId]),
    [["operations", "shared-ops-tool"]],
  );
  const listCalls = registry.calls.filter(
    (command) => command instanceof ListRegistryRecordsCommand,
  );
  assert.deepEqual(
    listCalls.map(({ input }) => [input.registryId, input.nextToken]),
    [
      [REGISTRIES.operations, undefined],
      [REGISTRIES.operations, "operations-page-2"],
      [REGISTRIES.operations, "unused-operations-page-3"],
      [REGISTRIES.platform, undefined],
    ],
  );
});

test("shared discovery keeps continuation tokens isolated per source domain", async () => {
  const registry = registryHarness({
    records: [
      record({
        domainId: "operations",
        recordId: "Rec987654321",
        resourceId: "shared-ops-tool",
        status: "APPROVED",
        shared: true,
      }),
      record({
        domainId: "platform",
        recordId: "Rec765432109",
        resourceId: "shared-platform-tool",
        status: "APPROVED",
        shared: true,
      }),
    ],
    listRegistryRecords(input) {
      if (input.nextToken === undefined) {
        return {
          registryRecords: [],
          nextToken: "page-2",
        };
      }
      if (
        input.registryId === REGISTRIES.operations
        && input.nextToken === "page-2"
      ) {
        return {
          registryRecords: [{
            recordId: "Rec987654321",
            status: "APPROVED",
          }],
        };
      }
      if (
        input.registryId === REGISTRIES.platform
        && input.nextToken === "page-2"
      ) {
        return {
          registryRecords: [{
            recordId: "Rec765432109",
            status: "APPROVED",
          }],
        };
      }
      throw new Error("Unexpected Registry page.");
    },
  });
  const { service } = serviceWith({ registry });

  const result = await service.discoverShared({
    identity: identity(),
    limit: 2,
  });

  assert.deepEqual(
    new Set(result.items.map((item) => item.domainId)),
    new Set(["operations", "platform"]),
  );
  assert.deepEqual(
    registry.calls
      .filter((command) => command instanceof ListRegistryRecordsCommand)
      .map(({ input }) => [input.registryId, input.nextToken]),
    [
      [REGISTRIES.operations, undefined],
      [REGISTRIES.operations, "page-2"],
      [REGISTRIES.platform, undefined],
      [REGISTRIES.platform, "page-2"],
    ],
  );
});

test("shared discovery rejects malformed and cyclic Registry pagination", async (t) => {
  await t.test("malformed token", async () => {
    const registry = registryHarness({
      listRegistryRecords() {
        return {
          registryRecords: [],
          nextToken: { token: "not-opaque" },
        };
      },
    });
    const { service } = serviceWith({ registry });

    await assert.rejects(
      service.discoverShared({
        identity: identity(),
        limit: 1,
      }),
      expectCode("REGISTRY_UNAVAILABLE"),
    );
    assert.equal(
      registry.calls.filter(
        (command) => command instanceof ListRegistryRecordsCommand,
      ).length,
      1,
    );
  });

  await t.test("cyclic token", async () => {
    const registry = registryHarness({
      listRegistryRecords(input) {
        const nextTokens = new Map([
          [undefined, "page-a"],
          ["page-a", "page-b"],
          ["page-b", "page-a"],
        ]);
        return {
          registryRecords: [],
          nextToken: nextTokens.get(input.nextToken),
        };
      },
    });
    const { service } = serviceWith({ registry });

    await assert.rejects(
      service.discoverShared({
        identity: identity(),
        limit: 1,
      }),
      expectCode("REGISTRY_UNAVAILABLE"),
    );
    assert.equal(
      registry.calls.filter(
        (command) => command instanceof ListRegistryRecordsCommand,
      ).length,
      3,
    );
  });
});

test("shared discovery fails closed at the per-source pagination bound", async () => {
  let page = 0;
  const registry = registryHarness({
    listRegistryRecords() {
      page += 1;
      return {
        registryRecords: [],
        nextToken: `page-${page + 1}`,
      };
    },
  });
  const { service } = serviceWith({ registry });

  await assert.rejects(
    service.discoverShared({
      identity: identity(),
      limit: 1,
    }),
    expectCode("REGISTRY_UNAVAILABLE"),
  );
  assert.equal(
    registry.calls.filter(
      (command) => command instanceof ListRegistryRecordsCommand,
    ).length,
    4,
  );
});

test("requesting access creates approval but does not create a grant", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "operations",
      recordId: "Rec987654321",
      resourceId: "ops-triage",
      status: "APPROVED",
      shared: true,
    })],
  });
  const { service, state } = serviceWith({ registry });
  const result = await service.requestAccess(accessRequest());

  assert.equal(result.status, "PENDING");
  assert.equal(result.kind, "RESOURCE_ACCESS");
  assert.equal(result.domainId, "customer_support");
  assert.deepEqual(state.writes.map(([type]) => type), ["approval"]);
});

test("access-request approval collisions do not disclose another requester", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "operations",
      recordId: "Rec987654321",
      resourceId: "ops-triage",
      status: "APPROVED",
      shared: true,
    })],
  });
  const { service, state } = serviceWith({ registry });
  const created = await service.requestAccess(accessRequest());
  const registryCallsAfterCreate = registry.calls.length;

  await assert.rejects(
    service.requestAccess(accessRequest({
      identity: identity("builder", "other-builder-sub"),
      recordId: "Rec000000000",
    })),
    (error) => {
      assert.ok(expectCode("CONFLICT")(error));
      assert.equal(Object.hasOwn(error, "approval"), false);
      assert.equal(Object.hasOwn(error, "requesterSubject"), false);
      assert.equal(Object.hasOwn(error, "resourceId"), false);
      return true;
    },
  );
  assert.equal(state.writes.length, 1);
  assert.equal(state.records.approval, created);
  assert.equal(registry.calls.length, registryCallsAfterCreate);
});

test("access-request collisions preserve authorization before any Registry probe", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "operations",
      recordId: "Rec987654321",
      resourceId: "ops-triage",
      status: "APPROVED",
      shared: true,
    })],
  });
  const state = memoryState();
  await serviceWith({ registry, state }).service.requestAccess(
    accessRequest(),
  );
  const registryCallsAfterCreate = registry.calls.length;
  const denied = serviceWith({
    deniedActions: ["resource:access-request"],
    registry,
    state,
  });

  await assert.rejects(
    denied.service.requestAccess(accessRequest({
      identity: identity("builder", "other-builder-sub"),
      recordId: "Rec000000000",
    })),
    expectCode("FORBIDDEN"),
  );

  assert.equal(denied.authorizeCalls.length, 1);
  assert.equal(
    denied.authorizeCalls[0].action,
    "resource:access-request",
  );
  assert.equal(registry.calls.length, registryCallsAfterCreate);
});

test("access-request binding collisions fail locally after authorization", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "operations",
      recordId: "Rec987654321",
      resourceId: "ops-triage",
      status: "APPROVED",
      shared: true,
    })],
  });
  const value = serviceWith({ registry });
  await value.service.requestAccess(accessRequest());
  const registryCallsAfterCreate = registry.calls.length;
  const authorizationCallsAfterCreate = value.authorizeCalls.length;

  await assert.rejects(
    value.service.requestAccess(accessRequest({
      recordId: "Rec000000000",
    })),
    expectCode("CONFLICT"),
  );

  assert.equal(
    value.authorizeCalls.length,
    authorizationCallsAfterCreate + 1,
  );
  assert.equal(registry.calls.length, registryCallsAfterCreate);
});

test("access-request replay requires the same normalized payload", async () => {
  const registry = registryHarness({
    records: [
      record({
        domainId: "operations",
        recordId: "Rec987654321",
        resourceId: "ops-triage",
        status: "APPROVED",
        shared: true,
      }),
      record({
        domainId: "operations",
        recordId: "Rec876543210",
        resourceId: "ops-escalation",
        status: "APPROVED",
        shared: true,
      }),
    ],
  });
  const { service, state } = serviceWith({ registry });
  const created = await service.requestAccess(accessRequest());

  const replayed = await service.requestAccess(accessRequest());
  assert.deepEqual(replayed, created);
  assert.equal(state.writes.length, 1);
  const registryCallsAfterReplay = registry.calls.length;

  await assert.rejects(
    service.requestAccess(accessRequest({
      recordId: "Rec876543210",
    })),
    expectCode("CONFLICT"),
  );
  await assert.rejects(
    service.requestAccess(accessRequest({
      recordId: "Rec000000000",
    })),
    expectCode("CONFLICT"),
  );
  await assert.rejects(
    service.requestAccess(accessRequest({
      requestId: "different-idempotency-request",
    })),
    expectCode("CONFLICT"),
  );
  assert.equal(state.writes.length, 1);
  assert.equal(registry.calls.length, registryCallsAfterReplay);
});

test("access-request replay fails closed on missing or altered completion metadata", async (t) => {
  async function fixture() {
    const registry = registryHarness({
      records: [record({
        domainId: "operations",
        recordId: "Rec987654321",
        resourceId: "ops-triage",
        status: "APPROVED",
        shared: true,
      })],
    });
    const value = serviceWith({ registry });
    await value.service.requestAccess(accessRequest());
    return value;
  }

  await t.test("missing completion", async () => {
    const { service, state } = await fixture();
    state.mutations.clear();

    await assert.rejects(
      service.requestAccess(accessRequest()),
      expectCode("CONFLICT"),
    );
    assert.equal(state.writes.length, 1);
  });

  await t.test("altered completion", async () => {
    const { service, state } = await fixture();
    const [completion] = state.mutations.values();
    completion.payloadFingerprint = "0".repeat(64);

    await assert.rejects(
      service.requestAccess(accessRequest()),
      expectCode("CONFLICT"),
    );
    assert.equal(state.writes.length, 1);
  });
});

test("Domain Lead approval creates a domain grant and revoke removes use", async () => {
  const registry = registryHarness({
    records: [record({
      domainId: "customer_support",
      status: "APPROVED",
    })],
  });
  const accessApproval = approval({
    domainId: "operations",
    id: "request-case-triage",
    kind: "RESOURCE_ACCESS",
    requesterSubject: "builder-sub",
  });
  const state = memoryState({ currentApproval: accessApproval });
  const { service } = serviceWith({ registry, state });
  const approved = await service.decideAccess({
    identity: identity("lead", "lead-sub", "operations"),
    requestId: "grant-request",
    approvalId: "request-case-triage",
    decision: "APPROVE",
    reason: "Approved for the operations domain.",
  });

  assert.equal(approved.approval.status, "APPROVED");
  assert.equal(approved.grant.status, "ACTIVE");
  assert.equal(approved.grant.domainId, "operations");

  const revoked = await service.revokeAccess({
    identity: identity("lead", "lead-sub", "operations"),
    requestId: "revoke-request",
    resourceType: "TOOL",
    resourceId: "CustReg123456/Rec123456789",
    reason: "The shared dependency is no longer required.",
  });
  assert.equal(revoked.status, "REVOKED");
  assert.equal(revoked.revokedBySubject, "lead-sub");
});

test("Domain Lead approval creates an End User entitlement for a production agent", async () => {
  const state = memoryState({
    currentApproval: approval({
      domainId: "operations",
      id: "request-triage-agent",
      kind: "RESOURCE_ACCESS",
      resourceType: "AGENT",
      resourceId: "triage-agent",
      projectId: "case-assist",
      requesterSubject: "user-sub",
    }),
  });
  const { service } = serviceWith({ state });
  const result = await service.decideAccess({
    identity: identity("lead", "lead-sub", "operations"),
    requestId: "grant-agent-request",
    approvalId: "request-triage-agent",
    decision: "APPROVE",
    reason: "Approved for the user role.",
  });

  assert.equal(result.approval.status, "APPROVED");
  assert.deepEqual(result.entitlement, entitlement({
    grantedAt: "2026-08-25T08:00:00.000Z",
  }));
  assert.deepEqual(
    state.writes.map(([type]) => type),
    ["approval", "entitlement"],
  );
});

test("Platform Admin lists safe typed entitlements across all domains with a scope-bound cursor", async () => {
  const rawCursor = {
    pk: "ENTITLEMENT#GROUP#operations-users",
    sk: "AGENT#operations#case-assist#triage-agent",
  };
  const events = [];
  const state = memoryState({
    events,
    entitlementPage: {
      items: [
        typedEntitlement({
          subjectType: "GROUP",
          subject: "operations-users",
          grantedBySubject: "sensitive-granting-subject",
        }),
        entitlement({
          subject: "legacy-user-sub",
          grantedBySubject: "sensitive-legacy-granting-subject",
        }),
      ],
      cursor: rawCursor,
    },
  });
  const { service } = serviceWith({ state });

  const page = await service.listAgentEntitlements({
    identity: identity("admin", "admin-sub", null),
    limit: 2,
  });

  assert.deepEqual(events[0], [
    "listAgentEntitlements",
    { limit: 2 },
  ]);
  assert.deepEqual(page.items, [
    {
      subjectType: "GROUP",
      subject: "operations-users",
      domainId: "operations",
      projectId: "case-assist",
      agentId: "triage-agent",
      status: "ACTIVE",
      expiresAt: "2026-08-25T09:00:00.000Z",
      grantedAt: "2026-08-25T08:00:00.000Z",
      revokedAt: null,
    },
    {
      subjectType: "USER",
      subject: "legacy-user-sub",
      domainId: "operations",
      projectId: "case-assist",
      agentId: "triage-agent",
      status: "ACTIVE",
      expiresAt: null,
      grantedAt: "2026-08-25T08:00:00.000Z",
      revokedAt: null,
    },
  ]);
  assert.equal(typeof page.cursor, "string");
  assert.ok(page.cursor.length > 0);

  state.listAgentEntitlements = async (input) => {
    events.push(["listAgentEntitlements", structuredClone(input)]);
    return { items: [], cursor: null };
  };
  assert.deepEqual(
    await service.listAgentEntitlements({
      identity: identity("admin", "admin-sub", null),
      limit: 2,
      cursor: page.cursor,
    }),
    { items: [], cursor: null },
  );
  assert.deepEqual(events[1], [
    "listAgentEntitlements",
    { limit: 2, cursor: rawCursor },
  ]);
});

test("Domain Lead entitlement listing is fixed to the selected assigned domain", async () => {
  const events = [];
  const state = memoryState({
    events,
    entitlementPage: {
      items: [typedEntitlement({
        subjectType: "DOMAIN",
        subject: "operations",
      })],
      cursor: null,
    },
  });
  const { service } = serviceWith({ state });

  const page = await service.listAgentEntitlements({
    identity: identity("lead", "lead-sub", "operations"),
    limit: 25,
  });

  assert.deepEqual(events[0], [
    "listAgentEntitlements",
    { domainId: "operations", limit: 25 },
  ]);
  assert.equal(page.items[0].domainId, "operations");

  for (const role of ["builder", "user"]) {
    await assert.rejects(
      service.listAgentEntitlements({
        identity: identity(role, `${role}-sub`, "operations"),
        limit: 25,
      }),
      expectCode("FORBIDDEN"),
    );
  }
});

test("entitlement listing rejects oversized pages, cross-scope cursors, and malformed state", async () => {
  const adminState = memoryState({
    entitlementPage: {
      items: [],
      cursor: {
        pk: "ENTITLEMENT#DOMAIN#operations",
        sk: "AGENT#operations#case-assist#triage-agent",
      },
    },
  });
  const { service: admin } = serviceWith({ state: adminState });
  const adminPage = await admin.listAgentEntitlements({
    identity: identity("admin", "admin-sub", null),
    limit: 1,
  });
  const { service: lead } = serviceWith();
  await assert.rejects(
    lead.listAgentEntitlements({
      identity: identity("lead", "lead-sub", "operations"),
      limit: 1,
      cursor: adminPage.cursor,
    }),
    expectCode("INVALID_REQUEST"),
  );
  for (const limit of [0, 51, 1.5]) {
    await assert.rejects(
      admin.listAgentEntitlements({
        identity: identity("admin", "admin-sub", null),
        limit,
      }),
      expectCode("INVALID_REQUEST"),
    );
  }

  const malformedState = memoryState({
    entitlementPage: {
      items: [{
        ...typedEntitlement(),
        internalConfiguration: "must-not-pass-through",
      }],
      cursor: null,
    },
  });
  const { service: malformed } = serviceWith({ state: malformedState });
  await assert.rejects(
    malformed.listAgentEntitlements({
      identity: identity("admin", "admin-sub", null),
      limit: 20,
    }),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
});

for (const [subjectType, subject] of [
  ["USER", "user-sub"],
  ["GROUP", "domain-operations-users"],
  ["DOMAIN", "operations"],
]) {
  test(`Domain Lead directly grants a typed ${subjectType} entitlement with durable evidence`, async () => {
    const { service, state, authorizeCalls } = serviceWith();
    const result = await service.grantAgentEntitlement(entitlementGrant({
      requestId: `grant-${subjectType.toLowerCase()}-entitlement`,
      subjectType,
      subject,
    }));

    assert.deepEqual(result, typedEntitlement({ subjectType, subject }));
    assert.equal(authorizeCalls.length, 1);
    assert.equal(authorizeCalls[0].action, "agent:entitlement-grant");
    assert.deepEqual(authorizeCalls[0].requestContext, {
      source: "governance-service",
      subject: "lead-sub",
      role: "lead",
      activeDomain: "operations",
      domainIds: ["operations"],
    });
    assert.equal(state.writes.length, 1);
    const [, write] = state.writes[0];
    assert.equal(write.expectedStatus, null);
    assert.equal(write.mutation.actor, "lead-sub");
    assert.equal(write.mutation.requesterSubject, "lead-sub");
    assert.equal(
      write.mutation.route,
      "POST /api/governance/agent-entitlements",
    );
    assert.equal(write.mutation.result.entityType, "ENTITLEMENT");
    assert.equal(write.mutation.result.operation, "CREATE");
    assert.match(write.mutation.payloadFingerprint, /^[a-f0-9]{64}$/);
  });
}

test("direct entitlement grant is idempotent and rejects request-ID payload changes", async () => {
  const deniedActions = [];
  const { service, state, authorizeCalls } = serviceWith({
    deniedActions,
  });
  const request = entitlementGrant();
  const granted = await service.grantAgentEntitlement(request);
  state.getAgent = async () => {
    throw new Error("readiness changed after the committed grant");
  };
  state.listDeployments = async () => {
    throw new Error("readiness changed after the committed grant");
  };
  const replayed = await service.grantAgentEntitlement(request);

  assert.deepEqual(replayed, granted);
  assert.equal(state.writes.length, 1);
  assert.equal(authorizeCalls.length, 2);
  await assert.rejects(
    service.grantAgentEntitlement({
      ...request,
      subject: "another-user-sub",
    }),
    expectCode("CONFLICT"),
  );
  deniedActions.push("agent:entitlement-grant");
  await assert.rejects(
    service.grantAgentEntitlement(request),
    expectCode("FORBIDDEN"),
  );
  assert.equal(state.writes.length, 1);
});

test("direct entitlement grant renews an expired typed entitlement conditionally and replays safely", async () => {
  const state = memoryState({
    currentEntitlement: typedEntitlement({
      expiresAt: "2026-08-25T07:00:00.000Z",
      grantedBySubject: "prior-lead-sub",
      grantedAt: "2026-08-25T06:00:00.000Z",
    }),
  });
  const { service, authorizeCalls } = serviceWith({ state });
  const request = entitlementGrant({
    requestId: "renew-expired-entitlement",
    expiresAt: "2026-08-25T10:00:00.000Z",
  });
  const renewed = await service.grantAgentEntitlement(request);

  assert.deepEqual(renewed, typedEntitlement({
    expiresAt: "2026-08-25T10:00:00.000Z",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T08:00:00.000Z",
  }));
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0][1].expectedStatus, "ACTIVE");
  assert.deepEqual(
    state.writes[0][1].expectedRecord,
    typedEntitlement({
      expiresAt: "2026-08-25T07:00:00.000Z",
      grantedBySubject: "prior-lead-sub",
      grantedAt: "2026-08-25T06:00:00.000Z",
    }),
  );
  assert.equal(state.writes[0][1].mutation.actor, "lead-sub");
  assert.equal(state.writes[0][1].mutation.result.operation, "UPDATE");

  state.getAgent = async () => {
    throw new Error("readiness changed after the committed renewal");
  };
  state.listDeployments = async () => {
    throw new Error("readiness changed after the committed renewal");
  };
  assert.deepEqual(
    await service.grantAgentEntitlement(request),
    renewed,
  );
  assert.equal(state.writes.length, 1);
  assert.equal(authorizeCalls.length, 2);
});

test("direct entitlement grant renews a revoked typed entitlement conditionally", async () => {
  const state = memoryState({
    currentEntitlement: typedEntitlement({
      status: "REVOKED",
      expiresAt: "2026-08-25T07:00:00.000Z",
      grantedBySubject: "prior-lead-sub",
      grantedAt: "2026-08-25T06:00:00.000Z",
      revokedBySubject: "prior-lead-sub",
      revokedAt: "2026-08-25T07:30:00.000Z",
    }),
  });
  const { service } = serviceWith({ state });
  const renewed = await service.grantAgentEntitlement(entitlementGrant({
    requestId: "renew-revoked-entitlement",
    expiresAt: "2026-08-25T10:00:00.000Z",
  }));

  assert.deepEqual(renewed, typedEntitlement({
    expiresAt: "2026-08-25T10:00:00.000Z",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T08:00:00.000Z",
  }));
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0][1].expectedStatus, "REVOKED");
  assert.equal(state.writes[0][1].expectedRecord.status, "REVOKED");
  assert.equal(state.writes[0][1].mutation.actor, "lead-sub");
  assert.equal(state.writes[0][1].mutation.result.operation, "UPDATE");
});

test("stale entitlement renewal fails closed instead of overwriting a newer cycle", async () => {
  const prior = typedEntitlement({
    expiresAt: "2026-08-25T07:00:00.000Z",
    grantedBySubject: "prior-lead-sub",
    grantedAt: "2026-08-25T06:00:00.000Z",
  });
  const state = memoryState({ currentEntitlement: prior });
  state.putEntitlement = async (input) => {
    assert.deepEqual(input.expectedRecord, prior);
    state.records.entitlement = typedEntitlement({
      expiresAt: "2026-08-25T11:00:00.000Z",
      grantedBySubject: "newer-lead-sub",
      grantedAt: "2026-08-25T08:30:00.000Z",
    });
    throw Object.assign(new Error("stale conditional write"), {
      code: "MUTATION_CONFLICT",
    });
  };
  const { service } = serviceWith({ state });

  await assert.rejects(
    service.grantAgentEntitlement(entitlementGrant({
      requestId: "stale-renewal",
      expiresAt: "2026-08-25T10:00:00.000Z",
    })),
    expectCode("CONFLICT"),
  );
  assert.equal(state.writes.length, 0);
});

test("grant readiness paginates bounded deployment state and rejects repeated cursors", async () => {
  const firstCursor = {
    pk: "DEPLOYMENT#operations#case-assist",
    sk: "DEPLOYMENT#page-100",
  };
  const state = memoryState();
  const calls = [];
  state.listDeployments = async (input) => {
    calls.push(structuredClone(input));
    if (input.cursor === undefined) {
      return {
        items: Array.from({ length: 100 }, (_, index) => ({
          domainId: "operations",
          projectId: "case-assist",
          id: `other-${String(index).padStart(3, "0")}`,
          agentId: "other-agent",
          environment: "PRODUCTION",
          status: "DEPLOYED",
          runtimeStatus: "READY",
        })),
        cursor: firstCursor,
      };
    }
    return {
      items: [{
        domainId: "operations",
        projectId: "case-assist",
        id: "triage-agent-production",
        agentId: "triage-agent",
        environment: "PRODUCTION",
        status: "DEPLOYED",
        runtimeStatus: "READY",
      }],
      cursor: null,
    };
  };
  const { service } = serviceWith({ state });

  assert.equal(
    (await service.grantAgentEntitlement(entitlementGrant({
      requestId: "paginated-readiness",
    }))).status,
    "ACTIVE",
  );
  assert.deepEqual(calls, [
    {
      domainId: "operations",
      projectId: "case-assist",
      limit: 100,
    },
    {
      domainId: "operations",
      projectId: "case-assist",
      limit: 100,
      cursor: firstCursor,
    },
  ]);

  const cyclicState = memoryState();
  cyclicState.listDeployments = async () => ({
    items: [],
    cursor: firstCursor,
  });
  const { service: cyclic } = serviceWith({ state: cyclicState });
  await assert.rejects(
    cyclic.grantAgentEntitlement(entitlementGrant({
      requestId: "cyclic-readiness",
    })),
    expectCode("WORKSPACE_UNAVAILABLE"),
  );
});

test("Platform Admin entitlement mutation records exact break-glass evidence", async () => {
  const state = memoryState();
  const { service } = serviceWith({
    state,
    authorizationResult: {
      ok: true,
      usedBreakGlass: true,
      authorizationEvidenceId: "break-glass-001",
    },
  });

  await service.grantAgentEntitlement(entitlementGrant({
    identity: identity("admin", "admin-sub", null),
    requestId: "admin-break-glass-entitlement",
  }));

  assert.equal(
    state.writes[0][1].mutation.authorizationEvidenceId,
    "break-glass-001",
  );
});

test("Domain Lead revokes an active typed entitlement without deleting it and can replay safely", async () => {
  const state = memoryState({
    currentEntitlement: typedEntitlement(),
  });
  const { service, authorizeCalls } = serviceWith({ state });
  const request = {
    identity: identity("lead", "lead-sub", "operations"),
    requestId: "direct-entitlement-revoke",
    domainId: "operations",
    projectId: "case-assist",
    agentId: "triage-agent",
    subjectType: "USER",
    subject: "user-sub",
    reason: "Remove production access after the assignment ended.",
  };
  const revoked = await service.revokeAgentEntitlement(request);

  assert.deepEqual(revoked, typedEntitlement({
    status: "REVOKED",
    revokedBySubject: "lead-sub",
    revokedAt: "2026-08-25T08:00:00.000Z",
  }));
  assert.equal(state.records.entitlement.status, "REVOKED");
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0][1].expectedStatus, "ACTIVE");
  assert.equal(state.writes[0][1].mutation.actor, "lead-sub");
  assert.equal(state.writes[0][1].mutation.result.operation, "UPDATE");
  assert.equal(authorizeCalls[0].action, "agent:entitlement-revoke");

  state.getAgent = async () => {
    throw new Error("readiness changed after the committed revocation");
  };
  state.listDeployments = async () => {
    throw new Error("readiness changed after the committed revocation");
  };
  const replayed = await service.revokeAgentEntitlement(request);
  assert.deepEqual(replayed, revoked);
  assert.equal(state.writes.length, 1);
  assert.equal(authorizeCalls.length, 2);

  state.records.entitlement = {
    ...revoked,
    revokedAt: "2026-08-25T08:00:01.000Z",
  };
  await assert.rejects(
    service.revokeAgentEntitlement(request),
    expectCode("CONFLICT"),
  );
});

test("direct revoke preserves compatibility with legacy USER entitlements from access approval", async () => {
  const state = memoryState({
    currentEntitlement: entitlement({
      domainId: "operations",
    }),
  });
  const { service } = serviceWith({ state });
  const revoked = await service.revokeAgentEntitlement({
    identity: identity("lead", "lead-sub", "operations"),
    requestId: "legacy-user-entitlement-revoke",
    domainId: "operations",
    projectId: "case-assist",
    agentId: "triage-agent",
    subjectType: "USER",
    subject: "user-sub",
    reason: "Remove the legacy user entitlement after migration.",
  });

  assert.deepEqual(revoked, typedEntitlement({
    expiresAt: null,
    status: "REVOKED",
    revokedBySubject: "lead-sub",
    revokedAt: "2026-08-25T08:00:00.000Z",
  }));
  assert.equal(state.writes[0][1].expectedStatus, "ACTIVE");
});

test("direct entitlement management enforces persona and domain boundaries", async () => {
  const builder = serviceWith().service;
  await assert.rejects(
    builder.grantAgentEntitlement(entitlementGrant({
      identity: identity("builder", "builder-sub", "operations"),
    })),
    expectCode("FORBIDDEN"),
  );

  const foreignLead = serviceWith().service;
  await assert.rejects(
    foreignLead.grantAgentEntitlement(entitlementGrant({
      domainId: "customer_support",
    })),
    expectCode("NOT_FOUND"),
  );

  const foreignAdmin = serviceWith({
    deniedActions: ["agent:entitlement-grant"],
  }).service;
  await assert.rejects(
    foreignAdmin.grantAgentEntitlement(entitlementGrant({
      identity: identity("admin", "admin-sub", null),
      domainId: "operations",
    })),
    expectCode("FORBIDDEN"),
  );

  const platformAdmin = serviceWith().service;
  const granted = await platformAdmin.grantAgentEntitlement(
    entitlementGrant({
      identity: identity("admin", "admin-sub", "platform"),
      domainId: "platform",
      subjectType: "DOMAIN",
      subject: "platform",
    }),
  );
  assert.equal(granted.domainId, "platform");
  assert.equal(granted.grantedBySubject, "admin-sub");
});

test("direct entitlement management rejects non-string domain and DOMAIN subject values", async () => {
  const invalidValues = [
    null,
    undefined,
    {},
    { toString: "operations" },
  ];
  for (const value of invalidValues) {
    const { service: invalidDomain, state: domainState } = serviceWith();
    await assert.rejects(
      invalidDomain.grantAgentEntitlement(entitlementGrant({
        domainId: value,
      })),
      expectCode("INVALID_REQUEST"),
    );
    assert.equal(domainState.writes.length, 0);

    const { service: invalidSubject, state: subjectState } = serviceWith();
    await assert.rejects(
      invalidSubject.grantAgentEntitlement(entitlementGrant({
        subjectType: "DOMAIN",
        subject: value,
      })),
      expectCode("INVALID_REQUEST"),
    );
    assert.equal(subjectState.writes.length, 0);
  }
});

test("direct entitlement grant requires exactly one ready production deployment", async (t) => {
  for (const scenario of [
    {
      name: "no deployment",
      page: { items: [], cursor: null },
      code: "CONFLICT",
    },
    {
      name: "multiple deployments",
      page: {
        items: [
          {
            domainId: "operations",
            projectId: "case-assist",
            agentId: "triage-agent",
            environment: "PRODUCTION",
            status: "DEPLOYED",
            runtimeStatus: "READY",
          },
          {
            domainId: "operations",
            projectId: "case-assist",
            agentId: "triage-agent",
            environment: "PRODUCTION",
            status: "DEPLOYED",
            runtimeStatus: "READY",
          },
        ],
        cursor: null,
      },
      code: "CONFLICT",
    },
    {
      name: "malformed page",
      page: { items: [], cursor: { pk: "unexpected" } },
      code: "WORKSPACE_UNAVAILABLE",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const state = memoryState();
      state.listDeployments = async () => scenario.page;
      const { service } = serviceWith({ state });
      await assert.rejects(
        service.grantAgentEntitlement(entitlementGrant()),
        expectCode(scenario.code),
      );
      assert.equal(state.writes.length, 0);
    });
  }
});

test("direct entitlement management rejects malformed expiry and foreign or stale entitlement state", async () => {
  const { service: invalidExpiry } = serviceWith();
  await assert.rejects(
    invalidExpiry.grantAgentEntitlement(entitlementGrant({
      expiresAt: "2026-08-25T07:59:59.000Z",
    })),
    expectCode("INVALID_REQUEST"),
  );

  const state = memoryState({
    currentEntitlement: typedEntitlement({
      domainId: "customer_support",
    }),
  });
  const { service } = serviceWith({ state });
  await assert.rejects(
    service.revokeAgentEntitlement({
      identity: identity("lead", "lead-sub", "operations"),
      requestId: "foreign-entitlement-revoke",
      domainId: "operations",
      projectId: "case-assist",
      agentId: "triage-agent",
      subjectType: "USER",
      subject: "user-sub",
      reason: "Remove a stale foreign entitlement safely.",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(state.writes.length, 0);

  const malformedState = memoryState({
    currentEntitlement: typedEntitlement({
      grantedAt: "not-a-timestamp",
    }),
  });
  const { service: malformed } = serviceWith({ state: malformedState });
  await assert.rejects(
    malformed.revokeAgentEntitlement({
      identity: identity("lead", "lead-sub", "operations"),
      requestId: "malformed-entitlement-revoke",
      domainId: "operations",
      projectId: "case-assist",
      agentId: "triage-agent",
      subjectType: "USER",
      subject: "user-sub",
      reason: "Reject malformed stored entitlement evidence.",
    }),
    expectCode("CONFLICT"),
  );
  assert.equal(malformedState.writes.length, 0);
});

for (const scenario of [
  {
    name: "resource grant",
    approval: approval({
      domainId: "operations",
      id: "request-case-triage",
      kind: "RESOURCE_ACCESS",
      requesterSubject: "builder-sub",
    }),
    expectedKey: "grant",
  },
  {
    name: "agent entitlement",
    approval: approval({
      domainId: "operations",
      id: "request-triage-agent",
      kind: "RESOURCE_ACCESS",
      resourceType: "AGENT",
      resourceId: "triage-agent",
      projectId: "case-assist",
      requesterSubject: "user-sub",
    }),
    expectedKey: "entitlement",
  },
]) {
  test(`${scenario.name} approval retries atomically without an approved access gap`, async () => {
    const state = memoryState({ currentApproval: scenario.approval });
    const putAccessDecision = state.putAccessDecision.bind(state);
    let atomicAttempts = 0;
    state.putAccessDecision = async (input) => {
      atomicAttempts += 1;
      if (atomicAttempts === 1) {
        throw Object.assign(new Error("state unavailable"), {
          code: "STATE_UNAVAILABLE",
        });
      }
      return putAccessDecision(input);
    };
    state.putResourceGrant = async () => {
      throw Object.assign(new Error("state unavailable"), {
        code: "STATE_UNAVAILABLE",
      });
    };
    state.putEntitlement = async () => {
      throw Object.assign(new Error("state unavailable"), {
        code: "STATE_UNAVAILABLE",
      });
    };
    const registry = registryHarness({
      records: [record({
        domainId: "customer_support",
        status: "APPROVED",
      })],
    });
    const { service } = serviceWith({ registry, state });
    const request = {
      identity: identity("lead", "lead-sub", "operations"),
      requestId: `atomic-${scenario.expectedKey}-request`,
      approvalId: scenario.approval.id,
      decision: "APPROVE",
      reason: "Approved after domain review.",
    };

    await assert.rejects(
      service.decideAccess(request),
      expectCode("WORKSPACE_UNAVAILABLE"),
    );
    assert.equal(state.records.approval.status, "PENDING");
    assert.equal(state.records[scenario.expectedKey], null);

    const recovered = await service.decideAccess(request);
    assert.equal(recovered.approval.status, "APPROVED");
    assert.equal(recovered[scenario.expectedKey].status, "ACTIVE");
    assert.equal(atomicAttempts, 2);

    const replayed = await service.decideAccess(request);
    assert.deepEqual(replayed, recovered);
    assert.equal(atomicAttempts, 2);
    assert.equal(
      state.writes.filter(([type]) => type === scenario.expectedKey).length,
      1,
    );

    await assert.rejects(
      service.decideAccess({
        ...request,
        reason: "A changed payload cannot reuse this request ID.",
      }),
      expectCode("CONFLICT"),
    );
    assert.equal(atomicAttempts, 2);
  });
}

test("authorization and Registry failures fail closed without mock fallback", async () => {
  const denied = serviceWith({
    deniedActions: ["resource:draft-register"],
  }).service;
  await assert.rejects(
    denied.registerDraft({
      identity: identity(),
      requestId: "denied-request",
      resource: {
        domainId: "customer_support",
        resourceType: "TOOL",
        resourceId: "case-triage",
        displayName: "Case Triage",
        description: "Routes cases to an approved queue.",
        version: "1.0.0",
        shared: true,
        specification: {},
      },
    }),
    expectCode("FORBIDDEN"),
  );

  const unavailable = createGovernanceService({
    workspaceState: memoryState(),
    domainDirectory: {
      async getDomain(id) {
        return domain(id);
      },
      async listActiveDomains() {
        return [domain("customer_support")];
      },
    },
    registryClient: {
      async send() {
        throw new Error("registry unavailable");
      },
    },
    async authorizer() {
      return true;
    },
    mutationClaimResolver: async () => null,
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "agentic-platform",
      project: "agentic-ai-platform-demo",
    },
  });
  await assert.rejects(
    unavailable.registerDraft({
      identity: identity(),
      requestId: "registry-failure",
      resource: {
        domainId: "customer_support",
        resourceType: "TOOL",
        resourceId: "case-triage",
        displayName: "Case Triage",
        description: "Routes cases to an approved queue.",
        version: "1.0.0",
        shared: true,
        specification: {},
      },
    }),
    expectCode("REGISTRY_UNAVAILABLE"),
  );
});

for (const [label, actor, code] of [
  ['admin missing source', identity('admin', 'synthetic-reader', null), 'HITL_POLICY_NOT_CONFIGURED'],
  ['builder denied', identity('builder', 'synthetic-reader'), 'FORBIDDEN'],
  ['lead denied', identity('lead', 'synthetic-reader'), 'FORBIDDEN'],
  ['foreign active domain denied', { ...identity('admin', 'synthetic-reader'), activeDomain: 'unknown_domain' }, 'FORBIDDEN'],
]) test(`HITL service ${label}`, async () => {
  const { service, authorizeCalls } = serviceWith({ state: { ...memoryState(), readHitlPolicyCatalog: async () => null } });
  await assert.rejects(service.readHitlPolicies({ identity: actor, limit: 20 }), expectCode(code));
  assert.deepEqual(authorizeCalls, []);
});

// Run the actual workspace state validator/serializer/transaction producer.
// Only DynamoDB I/O and Registry I/O are synthetic, not the state contract.
test("admin initiation and independent decision cross the real workspace state adapter", async () => {
  const { createWorkspaceState } = await import("../lambda/workspace/state.mjs");
  const items = new Map(), commands = [];
  let failApprovalCreate = true;
  const key = item => `${item.pk.S}/${item.sk.S}`;
  const dynamo = { async send(command) {
    commands.push(command);
    const input = command.input;
    if (command.constructor.name === "GetItemCommand") return {Item:items.get(key(input.Key))};
    if (command.constructor.name === "PutItemCommand") { items.set(key(input.Item), structuredClone(input.Item)); return {}; }
    if (command.constructor.name === "TransactWriteItemsCommand") {
      if (failApprovalCreate && input.TransactItems[0]?.Put?.Item?.entityType?.S === "APPROVAL") {
        failApprovalCreate = false; throw new Error("Synthetic write outage before commit");
      }
      for (const action of input.TransactItems) {
        if (action.Put) items.set(key(action.Put.Item), structuredClone(action.Put.Item));
        else if (action.Update || action.ConditionCheck) { /* conditional semantics separately covered by workspace-state tests */ }
        else assert.fail("unexpected transaction action");
      }
      return {};
    }
    assert.fail(command.constructor.name);
  }};
  const actual = createWorkspaceState({tableName:"SyntheticState",dynamo,now:()=>new Date(START).toISOString()});
  const state = memoryState();
  // All persistence relevant to this workflow uses the real adapter, including
  // claim, mutation completion, audit and strong-consistent approval readback.
  for (const method of ["beginTransaction","getApproval","getMutationResult","claimMutation","putApproval","appendAudit","reserveApprovalDecision"])
    state[method] = actual[method].bind(actual);
  const registry = registryHarness({records:[{...record({domainId:"platform",ownerSubject:"owner-reviewer",resourceType:"AGENT"}),recordType:"AGENT"}]});
  const {service} = serviceWith({state,registry});
  const input = {identity:identity("admin","initiator","platform"),requestId:"real-state-initiate",
    registryId:REGISTRIES.platform,recordId:"Rec123456789",reason:"Independent review of a synthetic resource."};
  await assert.rejects(service.initiatePublication(input), e=>e.code==="WORKSPACE_UNAVAILABLE");
  assert.equal(await actual.getApproval({domainId:"platform",approvalId:"absent"}),null);
  const result = await service.initiatePublication(input);
  assert.equal(registry.calls.filter(c=>c instanceof SubmitRegistryRecordForApprovalCommand).length,1);
  const replay = await service.initiatePublication(input);
  assert.deepEqual(replay.approval,result.approval);
  assert.equal(result.approval.requesterSubject,"initiator");
  assert.equal(result.approval.ownerSubject,"owner-reviewer");
  assert.equal(result.approval.recordVersion,result.record.recordVersion);
  const saved = await actual.getApproval({domainId:"platform",approvalId:result.approval.id});
  assert.deepEqual(saved,result.approval);
  for (const actor of ["initiator","owner-reviewer"]) await assert.rejects(service.decidePublication({
    identity:identity("admin",actor,null),requestId:`deny-${actor}`,approvalId:result.approval.id,
    decision:"APPROVE",reason:"Self review must be denied."}), e=>e.code==="REQUESTER_CANNOT_APPROVE");
  const targetRecord=registry.records.get(`${REGISTRIES.platform}/Rec123456789`);
  const originalVersion=targetRecord.recordVersion;
  targetRecord.recordVersion="2.0.0+platform-descriptor.1";
  await assert.rejects(service.decidePublication({identity:identity("admin","independent-reviewer",null),
    requestId:"drift-deny",approvalId:result.approval.id,decision:"APPROVE",reason:"Version drift must not pass."}),e=>e.code==="CONFLICT");
  targetRecord.recordVersion=originalVersion;
  const decided = await service.decidePublication({identity:identity("admin","independent-reviewer",null),
    requestId:"real-state-decide",approvalId:result.approval.id,decision:"APPROVE",reason:"Independent synthetic review passed."});
  assert.equal(decided.approval.status,"APPROVED");
  assert.equal((await actual.getApproval({domainId:"platform",approvalId:result.approval.id})).approverSubject,"independent-reviewer");
  const audits=[...items.values()].filter(item=>item.entityType?.S==="WORKSPACE_AUDIT");
  assert.ok(audits.some(a=>a.actor.S==="initiator"&&a.decision.S==="create"));
  assert.ok(audits.some(a=>a.actor.S==="independent-reviewer"&&a.decision.S==="approve"));
});

// The shared registry has no DOMAIN row, so review of any shared-catalog
// record dead-ended in NOT_FOUND. With sharedRegistry configured it joins
// domain resolution as the virtual "shared" domain; the full 4-eyes chain
// (initiate → independent decide) runs against APPROVAL#shared, an admin
// still cannot decide their own initiation, and an unconfigured service
// keeps the old fail-closed behavior.
test("shared-registry records complete the 4-eyes review via the virtual shared domain", async () => {
  const SHARED_ID = "SharedReg1234";
  const sharedArn = `arn:aws:agent-registry:us-west-2:111122223333:registry/${SHARED_ID}`;
  const sharedRecord = {
    ...record({ ownerSubject: "platform-bootstrap", status: "PENDING_APPROVAL" }),
    registryArn: sharedArn,
    recordArn: `${sharedArn}/record/Rec123456789`,
    descriptors: { custom: { data: JSON.stringify(resourceDescriptor({
      domainId: "shared", ownerSubject: "platform-bootstrap",
      resourceId: "contract-review", resourceType: "TOOL", shared: true,
    })) } },
  };
  const registry = registryHarness({ records: [] });
  registry.records.set(`${SHARED_ID}/Rec123456789`, sharedRecord);

  const state = memoryState();
  const authorizeCalls = [];
  const service = createGovernanceService({
    workspaceState: state,
    domainDirectory: {
      async getDomain(id) {
        return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
      },
      async listActiveDomains() {
        return Object.keys(REGISTRIES).map(domain);
      },
    },
    registryClient: registry.client,
    async authorizer(input) { authorizeCalls.push(input); return true; },
    mutationClaimResolver: state.getMutationClaim.bind(state),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "agentic-platform",
      project: "agentic-ai-platform-demo",
    },
    sharedRegistry: { registryId: SHARED_ID, registryArn: sharedArn },
  });

  const result = await service.initiatePublication({
    identity: identity("admin", "admin-initiator", "platform"),
    requestId: "shared-initiate",
    registryId: SHARED_ID,
    recordId: "Rec123456789",
    reason: "Shared catalog record needs a formal platform review.",
  });
  assert.equal(result.approval.status, "PENDING");
  assert.equal(result.approval.domainId, "shared");
  assert.equal(result.approval.requesterSubject, "admin-initiator");

  await assert.rejects(
    service.decidePublication({
      identity: identity("admin", "admin-initiator", null),
      requestId: "shared-self-decide",
      approvalId: result.approval.id,
      decision: "APPROVE",
      reason: "Initiator must not decide their own request.",
    }),
    (error) => error.code === "REQUESTER_CANNOT_APPROVE",
  );

  const decided = await service.decidePublication({
    identity: identity("admin", "independent-admin", null),
    requestId: "shared-decide",
    approvalId: result.approval.id,
    decision: "APPROVE",
    reason: "Independent review of the shared catalog record passed.",
  });
  assert.equal(decided.approval.status, "APPROVED");
  assert.equal(decided.approval.approverSubject, "independent-admin");
  assert.equal(decided.record.status, "APPROVED");
});

test("shared-registry review stays fail-closed when sharedRegistry is not configured", async () => {
  const SHARED_ID = "SharedReg1234";
  const sharedArn = `arn:aws:agent-registry:us-west-2:111122223333:registry/${SHARED_ID}`;
  const registry = registryHarness({ records: [] });
  registry.records.set(`${SHARED_ID}/Rec123456789`, {
    ...record({ ownerSubject: "platform-bootstrap", status: "PENDING_APPROVAL" }),
    registryArn: sharedArn,
    recordArn: `${sharedArn}/record/Rec123456789`,
  });
  const { service } = serviceWith({ registry });
  await assert.rejects(
    service.initiatePublication({
      identity: identity("admin", "admin-initiator", "platform"),
      requestId: "shared-unconfigured",
      registryId: SHARED_ID,
      recordId: "Rec123456789",
      reason: "Unconfigured deployments must not route shared reviews.",
    }),
    (error) => error.code === "NOT_FOUND",
  );
});

// Catalog visibility: the platform team's post-approval decision. Pin the full
// contract — admin sets visibility on an APPROVED record, discovery honors it
// (restricted overrides the legacy shared flag), non-admins are FORBIDDEN,
// and stale revisions lose cleanly.
function visibilityHarness(records) {
  let document = null;
  return {
    catalog: {
      async read() { return document; },
      async write(next, expectedRevision) {
        if ((document?.revision ?? null) !== expectedRevision) {
          const error = new Error("revision moved");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        document = next;
        return next;
      },
    },
    registry: registryHarness({ records }),
  };
}

test("platform admin sets visibility on an approved record and discovery honors it", async () => {
  const approvedRecord = record({
    domainId: "operations",
    ownerSubject: "builder-sub",
    status: "APPROVED",
    shared: true,
  });
  const { catalog, registry } = visibilityHarness([approvedRecord]);
  const state = memoryState();
  const service = createGovernanceService({
    workspaceState: state,
    domainDirectory: {
      async getDomain(id) {
        return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
      },
      async listActiveDomains() {
        return Object.keys(REGISTRIES).map(domain);
      },
    },
    registryClient: registry.client,
    async authorizer() { return true; },
    mutationClaimResolver: state.getMutationClaim.bind(state),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "agentic-platform",
      project: "agentic-ai-platform-demo",
    },
    visibilityCatalog: catalog,
  });

  const set = await service.setCatalogVisibility({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "vis-set-1",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    mode: "restricted",
    allowedDomainIds: ["customer_support"],
    reason: "Only customer support may use this until legal review completes.",
  });
  assert.equal(set.ok, true);
  assert.equal(set.visibility.mode, "restricted");
  assert.deepEqual(set.visibility.allowedDomainIds, ["customer_support"]);
  assert.equal(set.revision, 1);

  // Discovery from customer_support sees it; operations is the publisher
  // (skipped as own domain); a third domain would not see it despite the
  // record's own shared=true flag — the explicit decision wins.
  const visible = await service.discoverShared({
    identity: identity("lead", "cs-lead", "customer_support"),
    limit: 20,
  });
  assert.equal(
    visible.items.some((item) => item.recordId === "Rec123456789"),
    true,
  );
  const hidden = await service.discoverShared({
    identity: identity("lead", "plat-lead", "platform"),
    limit: 20,
  });
  assert.equal(
    hidden.items.some((item) => item.recordId === "Rec123456789"),
    false,
  );

  // Read-back exposes the document to admins and leads.
  const readBack = await service.readCatalogVisibility({
    identity: identity("admin", "admin-sub", "platform"),
  });
  assert.equal(readBack.revision, 1);
  assert.equal(readBack.entries.length, 1);

  // Flipping to open makes it visible everywhere.
  const opened = await service.setCatalogVisibility({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "vis-set-2",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    mode: "open",
    allowedDomainIds: [],
    reason: "Legal review complete; open to every domain.",
  });
  assert.equal(opened.revision, 2);
  const nowVisible = await service.discoverShared({
    identity: identity("lead", "plat-lead", "platform"),
    limit: 20,
  });
  assert.equal(
    nowVisible.items.some((item) => item.recordId === "Rec123456789"),
    true,
  );
});

test("visibility writes are admin-only, need real domains, and an approved record", async () => {
  const { catalog, registry } = visibilityHarness([
    record({ domainId: "operations", status: "DRAFT" }),
  ]);
  const state = memoryState();
  const service = createGovernanceService({
    workspaceState: state,
    domainDirectory: {
      async getDomain(id) {
        return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
      },
      async listActiveDomains() {
        return Object.keys(REGISTRIES).map(domain);
      },
    },
    registryClient: registry.client,
    async authorizer() { return true; },
    mutationClaimResolver: state.getMutationClaim.bind(state),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "agentic-platform",
      project: "agentic-ai-platform-demo",
    },
    visibilityCatalog: catalog,
  });
  const base = {
    requestId: "vis-deny",
    registryId: REGISTRIES.operations,
    recordId: "Rec123456789",
    mode: "open",
    allowedDomainIds: [],
    reason: "Attempted write that must be denied by the service contract.",
  };
  await assert.rejects(
    service.setCatalogVisibility({
      ...base,
      identity: identity("lead", "lead-sub", "customer_support"),
    }),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    service.setCatalogVisibility({
      ...base,
      identity: identity("admin", "admin-sub", "platform"),
      mode: "restricted",
      allowedDomainIds: ["no_such_domain"],
    }),
    (error) => error.code === "INVALID_REQUEST",
  );
  // DRAFT record: visibility decisions only apply to APPROVED records.
  await assert.rejects(
    service.setCatalogVisibility({
      ...base,
      identity: identity("admin", "admin-sub", "platform"),
    }),
    (error) => error.code === "CONFLICT",
  );
  // Builders cannot even read the visibility document.
  await assert.rejects(
    service.readCatalogVisibility({
      identity: identity("builder", "builder-sub", "customer_support"),
    }),
    (error) => error.code === "FORBIDDEN",
  );
});

// The org catalog (virtual "shared" domain) must be a discovery source:
// approved shared-registry records appear in cross-domain discovery, and the
// platform team's visibility decision gates them exactly like domain records —
// a restricted decision overrides the record's own shared=true flag.
test("discovery scans the shared registry and honors visibility decisions", async () => {
  const SHARED_ID = "SharedReg1234";
  const sharedArn = `arn:aws:agent-registry:us-west-2:111122223333:registry/${SHARED_ID}`;
  const sharedRecord = {
    ...record({ ownerSubject: "platform-bootstrap", status: "APPROVED" }),
    registryArn: sharedArn,
    recordArn: `${sharedArn}/record/Rec123456789`,
    descriptors: { custom: { data: JSON.stringify(resourceDescriptor({
      domainId: "shared", ownerSubject: "platform-bootstrap",
      resourceId: "kb-retrieval", resourceType: "TOOL", shared: true,
    })) } },
  };
  const { catalog } = visibilityHarness([]);
  const registry = registryHarness({ records: [] });
  registry.records.set(`${SHARED_ID}/Rec123456789`, sharedRecord);

  const state = memoryState();
  const service = createGovernanceService({
    workspaceState: state,
    domainDirectory: {
      async getDomain(id) {
        return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
      },
      async listActiveDomains() {
        return Object.keys(REGISTRIES).map(domain);
      },
    },
    registryClient: registry.client,
    async authorizer() { return true; },
    mutationClaimResolver: state.getMutationClaim.bind(state),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "agentic-platform",
      project: "agentic-ai-platform-demo",
    },
    sharedRegistry: { registryId: SHARED_ID, registryArn: sharedArn },
    visibilityCatalog: catalog,
  });

  // No decision yet: legacy shared=true keeps the record visible everywhere.
  const before = await service.discoverShared({
    identity: identity("builder", "cs-builder", "customer_support"),
    limit: 20,
  });
  assert.equal(
    before.items.some((item) => item.recordId === "Rec123456789"),
    true,
  );

  // A restricted decision to operations hides it from customer_support.
  await service.setCatalogVisibility({
    identity: identity("admin", "admin-sub", "platform"),
    requestId: "vis-shared-1",
    registryId: SHARED_ID,
    recordId: "Rec123456789",
    mode: "restricted",
    allowedDomainIds: ["operations"],
    reason: "Pilot the KB retrieval tool with operations first.",
  });
  const hidden = await service.discoverShared({
    identity: identity("builder", "cs-builder", "customer_support"),
    limit: 20,
  });
  assert.equal(
    hidden.items.some((item) => item.recordId === "Rec123456789"),
    false,
  );
  const allowed = await service.discoverShared({
    identity: identity("builder", "ops-builder", "operations"),
    limit: 20,
  });
  assert.equal(
    allowed.items.some((item) => item.recordId === "Rec123456789"),
    true,
  );

  // Without sharedRegistry configured the source list is unchanged (legacy).
  const legacyService = createGovernanceService({
    workspaceState: memoryState(),
    domainDirectory: {
      async getDomain(id) {
        return Object.hasOwn(REGISTRIES, id) ? domain(id) : null;
      },
      async listActiveDomains() {
        return Object.keys(REGISTRIES).map(domain);
      },
    },
    registryClient: registry.client,
    async authorizer() { return true; },
    mutationClaimResolver: memoryState().getMutationClaim.bind(memoryState()),
    mandatoryTags: {
      "auto-delete": "no",
      managedBy: "agentic-platform",
      project: "agentic-ai-platform-demo",
    },
  });
  const legacy = await legacyService.discoverShared({
    identity: identity("builder", "cs-builder", "customer_support"),
    limit: 20,
  });
  assert.equal(
    legacy.items.some((item) => item.recordId === "Rec123456789"),
    false,
  );
});

test("an administrator in all-domains navigation can submit an owned platform blueprint", async () => {
 const registry=registryHarness({records:[record({domainId:"platform",resourceType:"BLUEPRINT",ownerSubject:"admin-sub"})]});
 const {service}=serviceWith({registry});
 const result=await service.submitPublication({identity:{...identity("admin","admin-sub","platform"),activeDomain:null},requestId:"submit-platform-blueprint",approvalId:"publish-platform-blueprint",registryId:REGISTRIES.platform,recordId:"Rec123456789"});
 assert.equal(result.approval.domainId,"platform");assert.equal(result.approval.requesterSubject,"admin-sub");assert.equal(result.approval.status,"PENDING");
});
