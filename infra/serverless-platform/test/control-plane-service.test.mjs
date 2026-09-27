import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ControlPlaneServiceError,
  createControlPlaneService,
} from "../lambda/control-plane/service.mjs";
import * as controlPlaneServiceModule from
  "../lambda/control-plane/service.mjs";
import { createPlatformState } from
  "../lambda/platform-admin/state.mjs";

const FIXED_NOW = new Date("2026-08-22T01:02:03.000Z");
const CREDENTIALS = {
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret",
  sessionToken: "token",
};
const OMIT_CREDENTIALS = Symbol("omit-credentials");
const CONFIG = {
  accountId: "111122223333",
  region: "us-west-2",
  sharedRegistryId: "SharedReg12345",
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
const ADMIN_SCOPE = {
  role: "admin",
  allowedDomains: [],
  activeDomain: null,
};
const OPERATIONS_SCOPE = {
  role: "builder",
  allowedDomains: ["operations"],
  activeDomain: "operations",
};
const END_USER_SCOPE = {
  actor: "operator-sub",
  username: "operator-user",
  requestId: "end-user-registry",
  role: "user",
  allowedDomains: [],
  activeDomain: null,
  capabilities: [],
  authenticatedRole: "admin",
  assumedRole: "user",
};

function jsonResponse(body, {
  ok = true,
  status = ok ? 200 : 503,
  statusText = ok ? "OK" : "Service Unavailable",
} = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => JSON.stringify(body),
  };
}

function registryRecord({
  registryId,
  recordId,
  name,
  recordType,
  recordVersion = "1.0.0",
  status = "APPROVED",
  description = `${name} description`,
  descriptors,
}) {
  return {
    registryId,
    registryArn: `arn:aws:agent-registry:us-west-2:111122223333:registry/${registryId}`,
    recordId,
    recordArn:
      `arn:aws:agent-registry:us-west-2:111122223333:`
      + `registry/${registryId}/record/${recordId}`,
    name,
    displayName: name,
    description,
    recordType,
    recordVersion,
    status,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    descriptors,
  };
}

function skillRecord(registryId, recordId, {
  name = `skill_${recordId}`,
  domain,
  recordVersion = "1.0.0",
} = {}) {
  return registryRecord({
    registryId,
    recordId,
    name,
    recordType: "SKILL",
    recordVersion,
    descriptors: {
      agentSkillsDefinition: {
        data: JSON.stringify({
          id: name,
          displayName: `Skill ${recordId}`,
          "x-platform": {
            id: name,
            displayName: `Skill ${recordId}`,
            domain,
            tools: ["lookup"],
          },
        }),
      },
    },
  });
}

function blueprintRecord(registryId, recordId) {
  return registryRecord({
    registryId,
    recordId,
    name: `blueprint_${recordId}`,
    recordType: "CUSTOM",
    descriptors: {
      custom: {
        data: JSON.stringify({
          resourceKind: "blueprint",
          blueprintId: recordId,
          displayName: `Blueprint ${recordId}`,
          defaultVersion: "1.0.0",
          template: { framework: "Strands" },
        }),
      },
    },
  });
}

function agentRecord(registryId, recordId, domain, {
  cardDescription,
  cardExtra = {},
  cardName = `Agent ${recordId}`,
  description,
  displayName = `Agent ${recordId}`,
  entryId = `agent-${recordId}`,
  platformExtra = {},
  recordName = `agent_${recordId}`,
  recordVersion = "1.0.0",
  status = "PENDING_APPROVAL",
} = {}) {
  return registryRecord({
    registryId,
    recordId,
    name: recordName,
    recordType: "AGENT",
    recordVersion,
    status,
    description,
    descriptors: {
      a2aAgentCard: {
        data: JSON.stringify({
          ...cardExtra,
          name: cardName,
          ...(cardDescription === undefined
            ? {}
            : { description: cardDescription }),
          url: `https://agents.example/${recordId}`,
          "x-platform": {
            ...platformExtra,
            id: entryId,
            displayName,
            domain,
          },
        }),
      },
    },
  });
}

function summaryOf(record) {
  const { descriptors, registryId, ...summary } = record;
  return summary;
}

function gatewayTargetDetail(summary, endpoint) {
  return {
    ...summary,
    gatewayIdentifier: CONFIG.toolsGatewayId,
    gatewayArn:
      `arn:aws:bedrock-agentcore:${CONFIG.region}:111122223333:`
      + `gateway/${CONFIG.toolsGatewayId}`,
    targetConfiguration: {
      mcp: {
        mcpServer: {
          endpoint,
        },
      },
    },
  };
}

function createHarness({
  config = CONFIG,
  domainState,
  registrySend,
  registryDiscoverySend,
  gatewaySend,
  fetchImpl,
  credentials = CREDENTIALS,
  catalogMetadata,
  modelPolicyState,
  clock = () => FIXED_NOW,
  maxDetailConcurrency,
  maxRegistryListConcurrency,
  operationTimeoutMs,
  deadlineTimers,
} = {}) {
  const calls = {
    registry: [],
    registryOptions: [],
    registryDiscovery: [],
    registryDiscoveryOptions: [],
    gateway: [],
    gatewayOptions: [],
    fetch: [],
    credentials: 0,
  };
  const registryClient = {
    config: {
      credentials: async () => {
        calls.credentials += 1;
        return CREDENTIALS;
      },
    },
    send: async (command, options) => {
      calls.registry.push(command);
      calls.registryOptions.push(options);
      if (registrySend) {
        return registrySend(command, calls, options);
      }
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return { registryRecords: [] };
      }
      throw new Error(`Unexpected Registry command ${command.constructor.name}`);
    },
  };
  const gatewayClient = {
    send: async (command, options) => {
      calls.gateway.push(command);
      calls.gatewayOptions.push(options);
      if (gatewaySend) {
        return gatewaySend(command, calls, options);
      }
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return { items: [] };
      }
      throw new Error(`Unexpected Gateway command ${command.constructor.name}`);
    },
  };
  const registryDiscoveryClient = {
    send: async (command, options) => {
      calls.registryDiscovery.push(command);
      calls.registryDiscoveryOptions.push(options);
      if (registryDiscoverySend) {
        return registryDiscoverySend(command, calls, options);
      }
      if (
        command.constructor.name
        === "BatchGetDiscoverableRegistryRecordCommand"
      ) {
        const [entry] = command.input.entries;
        return {
          registryRecords: [],
          errors: entry.recordIds.map((recordId) => ({
            registryId: entry.registryId,
            recordId,
            errorCode: "RESOURCE_NOT_FOUND",
          })),
        };
      }
      throw new Error(
        `Unexpected Registry discovery command ${command.constructor.name}`,
      );
    },
  };
  const recordedFetch = async (...args) => {
    calls.fetch.push(args);
    return fetchImpl
      ? fetchImpl(...args)
      : jsonResponse({ data: [] });
  };
  const serviceOptions = {
    config,
    registryClient,
    registryDiscoveryClient,
    gatewayClient,
    fetchImpl: recordedFetch,
    clock,
    catalogMetadata,
    modelPolicyState,
    maxDetailConcurrency,
    maxRegistryListConcurrency,
    operationTimeoutMs,
    deadlineTimers,
    domainState,
  };
  if (credentials !== OMIT_CREDENTIALS) {
    serviceOptions.credentials = credentials;
  }
  const service = createControlPlaneService(serviceOptions);
  return {
    calls,
    gatewayClient,
    registryClient,
    registryDiscoveryClient,
    service,
  };
}

function commandInputs(commands, commandName) {
  return commands
    .filter((command) => command.constructor.name === commandName)
    .map((command) => command.input);
}

async function assertUnavailable(
  promise,
  _secretMarker,
  expectedComponent,
) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "CONTROL_PLANE_UNAVAILABLE");
    if (expectedComponent !== undefined) {
      assert.equal(error.component, expectedComponent);
    }
    assert.equal(error.statusCode, 503);
    assert.equal(error.retryable, true);
    assert.equal(
      error.message,
      "Control plane inventory is temporarily unavailable.",
    );
    assert.doesNotMatch(String(error), /TOP-SECRET/);
    return true;
  });
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  assert.fail(message);
}

function releaseInReverseBatches(releases, completed, total) {
  return (async () => {
    while (completed() < total) {
      await waitFor(
        () => releases.length > 0,
        "Expected another bounded detail-read batch.",
      );
      const batch = releases.splice(0);
      for (const release of batch.reverse()) {
        release();
      }
    }
  })();
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function settleWithSignal(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(new Error("Test backend was aborted."));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle(value);
    };
    const onAbort = () => {
      finish(reject, new Error("Test backend was aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function registryListConcurrencyFixture(domainCount = 20) {
  const domains = Array.from({ length: domainCount }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return {
      id: `tenant_${suffix}`,
      registryId: `TenantReg${suffix}00`,
      status: "ACTIVE",
    };
  });
  const registries = [
    {
      domain: "shared",
      registryId: CONFIG.sharedRegistryId,
    },
    ...domains.map(({ id, registryId }) => ({
      domain: id,
      registryId,
    })),
  ];
  const records = registries.map(({ domain, registryId }, index) =>
    skillRecord(registryId, `list-order-${String(index).padStart(2, "0")}`, {
      domain,
      name: `skill_order_${String(index).padStart(2, "0")}`,
    }));
  const recordByRegistryId = new Map(
    records.map((record) => [record.registryId, record]),
  );
  const releases = [];
  let active = 0;
  let completed = 0;
  let maxActive = 0;

  return {
    domainState: {
      listDomains: async () => domains,
      getDomain: async () => null,
    },
    expectedEntryIds: records.map((record) => record.name),
    maxActive: () => maxActive,
    registryDiscoverySend: async (command) => {
      const details = command.input.entries.flatMap(
        ({ registryId, recordIds }) =>
          recordIds.map((recordId) => {
            const record = recordByRegistryId.get(registryId);
            assert.equal(record?.recordId, recordId);
            return record;
          }),
      );
      return {
        registryRecords: details,
        errors: [],
      };
    },
    registrySend: async (command) => {
      assert.equal(
        command.constructor.name,
        "ListRegistryRecordsCommand",
      );
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          completed += 1;
          resolve({
            registryRecords: [
              summaryOf(recordByRegistryId.get(command.input.registryId)),
            ],
          });
        });
      });
    },
    releaseAll: () => releaseInReverseBatches(
      releases,
      () => completed,
      registries.length,
    ),
  };
}

test("End User Registry projection exposes only the current approved Agent version", () => {
  assert.equal(
    typeof controlPlaneServiceModule.projectEndUserRegistry,
    "function",
  );
  const approvedCurrent = {
    id: "approved-agent",
    type: "Agent",
    name: "Untrusted aggregate name",
    description: "Untrusted aggregate description",
    domain: "operations",
    governanceMode: "federated",
    domainOwner: null,
    defaultVersion: "2.0.0",
    unknownEntryField: "TOP-SECRET",
    versions: [
      { semver: "1.0.0", status: "REJECTED" },
      {
        semver: "2.0.0",
        status: "APPROVED",
        content: {
          card: {
            name: "Approved card name",
            description: "Approved card description",
            "x-platform": {
              displayName: "Approved display name",
            },
          },
        },
        createdAt: "2026-08-21T00:00:00.000Z",
        createdBy: "internal-builder",
        decidedAt: "2026-08-22T00:00:00.000Z",
        decidedBy: "registry",
        statusReason: "internal decision",
        _aws: { recordId: "TOP-SECRET" },
        unknownVersionField: "TOP-SECRET",
      },
      { semver: "3.0.0", status: "DRAFT" },
    ],
  };
  const approvedCanonical = {
    id: "approved-a2a",
    type: "A2AAgent",
    defaultVersion: "1.0.0",
    versions: [{ semver: "1.0.0", status: "APPROVED" }],
  };
  const inventory = {
    ok: true,
    entries: [
      approvedCurrent,
      {
        id: "rejected-agent",
        type: "Agent",
        defaultVersion: "1.0.0",
        versions: [{ semver: "1.0.0", status: "REJECTED" }],
      },
      approvedCanonical,
      {
        id: "ambiguous-agent",
        type: "Agent",
        defaultVersion: "1.0.0",
        versions: [
          { semver: "1.0.0", status: "APPROVED" },
          { semver: "1.0.0", status: "APPROVED" },
        ],
      },
      {
        id: "malformed-type",
        type: ["A2AAgent"],
        defaultVersion: "1.0.0",
        versions: [{ semver: "1.0.0", status: "APPROVED" }],
      },
      {
        id: "approved-gateway",
        type: "MCPServer",
        defaultVersion: "1.0.0",
        versions: [{ semver: "1.0.0", status: "APPROVED" }],
      },
      {
        id: "approved-model",
        type: "Model",
        defaultVersion: "1.0.0",
        versions: [{ semver: "1.0.0", status: "APPROVED" }],
      },
    ],
    types: ["Agent", "A2AAgent"],
    statuses: ["DRAFT", "APPROVED", "REJECTED"],
    store: "AWS Agent Registry + AgentCore Gateway",
    source: "aws",
  };

  assert.deepEqual(
    controlPlaneServiceModule.projectEndUserRegistry(inventory),
    {
      ok: true,
      entries: [{
        id: "approved-agent",
        type: "Agent",
        name: "Approved display name",
        description: "Approved card description",
        domain: "operations",
        governanceMode: "federated",
        domainOwner: null,
        defaultVersion: "2.0.0",
        versions: [{ semver: "2.0.0", status: "APPROVED" }],
      }, {
        id: "approved-a2a",
        type: "Agent",
        defaultVersion: "1.0.0",
        versions: [{ semver: "1.0.0", status: "APPROVED" }],
      }],
      types: ["Agent"],
      statuses: ["APPROVED"],
      store: "AWS Agent Registry + AgentCore Gateway",
      source: "aws",
    },
  );
  assert.equal(approvedCurrent.versions.length, 3);
  assert.equal(approvedCanonical.type, "A2AAgent");
});

test("End User Registry derives metadata from a draft-first approved AWS Agent", async () => {
  const common = {
    domain: "operations",
    entryId: "approved-catalog-agent",
    recordName: "catalog_agent",
  };
  const draft = agentRecord(
    CONFIG.domainRegistryIds.operations,
    "catalog-agent-draft",
    common.domain,
    {
      ...common,
      cardDescription: "TOP-SECRET draft description",
      cardExtra: {
        draftOnlyCardField: "TOP-SECRET",
      },
      cardName: "TOP-SECRET draft card name",
      description: "TOP-SECRET draft record description",
      displayName: "TOP-SECRET draft display name",
      platformExtra: {
        draftOnlyPlatformField: "TOP-SECRET",
      },
      recordVersion: "1.0.0",
      status: "DRAFT",
    },
  );
  const approved = agentRecord(
    CONFIG.domainRegistryIds.operations,
    "catalog-agent-approved",
    common.domain,
    {
      ...common,
      cardDescription: "Approved catalog description",
      cardExtra: {
        approvedUnknownCardField: "must-not-be-serialized",
      },
      cardName: "Approved card name",
      description: "Approved record description",
      displayName: "Approved catalog name",
      platformExtra: {
        approvedUnknownPlatformField: "must-not-be-serialized",
      },
      recordVersion: "2.0.0",
      status: "APPROVED",
    },
  );
  const { calls, service } = createHarness({
    domainState: {
      async listDomains() {
        return [{
          id: "operations",
          registryId: CONFIG.domainRegistryIds.operations,
          status: "ACTIVE",
        }];
      },
      async getDomain() {
        assert.fail("End User inventory must not select one domain.");
      },
    },
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === approved.registryId
          ? {
              registryRecords: [
                summaryOf(draft),
                summaryOf(approved),
              ],
            }
          : { registryRecords: [] };
      }
      assert.equal(command.constructor.name, "GetRegistryRecordCommand");
      assert.equal(command.input.recordId, draft.recordId);
      return draft;
    },
    registryDiscoverySend: async () => ({
      registryRecords: [approved],
      errors: [],
    }),
    gatewaySend: async () => {
      assert.fail("End User inventory must not read Gateway targets.");
    },
    fetchImpl: async () => {
      assert.fail("End User inventory must not read Gateway models.");
    },
  });

  const result = await service.registry(END_USER_SCOPE);

  assert.deepEqual(result.entries, [{
    id: "approved-catalog-agent",
    type: "Agent",
    name: "Approved catalog name",
    description: "Approved catalog description",
    domain: "operations",
    governanceMode: "federated",
    domainOwner: null,
    defaultVersion: "2.0.0",
    versions: [{
      semver: "2.0.0",
      status: "APPROVED",
    }],
  }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /TOP-SECRET|_aws|decidedBy|decidedAt|createdBy|statusReason|Unknown/,
  );
  assert.deepEqual(result.types, ["Agent"]);
  assert.deepEqual(result.statuses, ["APPROVED"]);
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
});

test("End User Registry maps authoritative approved AGENT records to Agent", async () => {
  const approvedAgent = agentRecord(
    CONFIG.domainRegistryIds.operations,
    "approved-operations-agent",
    "operations",
    { status: "APPROVED" },
  );
  const { calls, service } = createHarness({
    domainState: {
      async listDomains() {
        return [{
          id: "operations",
          registryId: CONFIG.domainRegistryIds.operations,
          status: "ACTIVE",
        }];
      },
      async getDomain() {
        assert.fail("End User inventory must not select one domain.");
      },
    },
    registrySend: async (command) => {
      assert.equal(command.constructor.name, "ListRegistryRecordsCommand");
      return command.input.registryId === approvedAgent.registryId
        ? { registryRecords: [summaryOf(approvedAgent)] }
        : { registryRecords: [] };
    },
    registryDiscoverySend: async (command) => {
      assert.deepEqual(command.input.entries, [{
        registryId: approvedAgent.registryId,
        recordIds: [approvedAgent.recordId],
      }]);
      return {
        registryRecords: [approvedAgent],
        errors: [],
      };
    },
    gatewaySend: async () => {
      assert.fail("End User inventory must not read Gateway targets.");
    },
    fetchImpl: async () => {
      assert.fail("End User inventory must not read Gateway models.");
    },
  });

  const result = await service.registry(END_USER_SCOPE);

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, "agent-approved-operations-agent");
  assert.equal(result.entries[0].type, "Agent");
  assert.deepEqual(
    result.entries[0].versions.map(({ semver, status }) => ({
      semver,
      status,
    })),
    [{ semver: "1.0.0", status: "APPROVED" }],
  );
  assert.deepEqual(result.types, ["Agent"]);
  assert.deepEqual(result.statuses, ["APPROVED"]);
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
});

test("End User Registry reads all active Registries without Gateway or model access", async () => {
  const stateCalls = [];
  const { calls, service } = createHarness({
    domainState: {
      async listDomains() {
        stateCalls.push("listDomains");
        return [
          {
            id: "customer_support",
            registryId: CONFIG.domainRegistryIds.customer_support,
            status: "ACTIVE",
          },
          {
            id: "operations",
            registryId: CONFIG.domainRegistryIds.operations,
            status: "ACTIVE",
          },
          {
            id: "retired",
            registryId: "RetiredReg1234",
            status: "DECOMMISSIONED",
          },
        ];
      },
      async getDomain() {
        assert.fail("End User inventory must not select one domain.");
      },
    },
    gatewaySend: async () => {
      assert.fail("End User inventory must not read Gateway targets.");
    },
    fetchImpl: async () => {
      assert.fail("End User inventory must not read Gateway models.");
    },
  });

  const result = await service.registry(END_USER_SCOPE);

  assert.deepEqual(stateCalls, ["listDomains"]);
  assert.deepEqual(
    commandInputs(calls.registry, "ListRegistryRecordsCommand")
      .map(({ registryId }) => registryId),
    [
      CONFIG.sharedRegistryId,
      CONFIG.domainRegistryIds.customer_support,
      CONFIG.domainRegistryIds.operations,
    ],
  );
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
  assert.deepEqual(result.types, ["Agent"]);
  assert.deepEqual(result.statuses, ["APPROVED"]);
  assert.deepEqual(result.entries, []);
});

test("End User Registry rejects more than sixteen active Registries before list reads", async () => {
  const activeDomains = Array.from({ length: 16 }, (_, index) => ({
    id: `tenant_${String(index).padStart(2, "0")}`,
    registryId: `TenantReg${String(index).padStart(4, "0")}`,
    status: "ACTIVE",
  }));
  const { calls, service } = createHarness({
    domainState: {
      async listDomains() {
        return activeDomains;
      },
      async getDomain() {
        assert.fail("End User inventory must not select one domain.");
      },
    },
  });

  await assertUnavailable(service.registry(END_USER_SCOPE), "", "registry");
  assert.deepEqual(calls.registry, []);
  assert.deepEqual(calls.registryDiscovery, []);
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
});

test("End User Registry rejects a fifth page before requesting it", async () => {
  const { calls, service } = createHarness({
    domainState: {
      async listDomains() {
        return [];
      },
      async getDomain() {
        assert.fail("End User inventory must not select one domain.");
      },
    },
    registrySend: async (command) => {
      assert.equal(command.constructor.name, "ListRegistryRecordsCommand");
      const page = command.input.nextToken === undefined
        ? 1
        : Number(command.input.nextToken.slice("page-".length));
      return {
        registryRecords: [],
        ...(page < 5 ? { nextToken: `page-${page + 1}` } : {}),
      };
    },
  });

  await assertUnavailable(service.registry(END_USER_SCOPE), "", "registry");
  assert.equal(
    commandInputs(calls.registry, "ListRegistryRecordsCommand").length,
    4,
  );
  assert.deepEqual(calls.registryDiscovery, []);
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
});

test("End User Registry rejects more than two hundred summaries before detail reads", async () => {
  const activeDomains = Array.from({ length: 4 }, (_, index) => ({
    id: `tenant_${String(index).padStart(2, "0")}`,
    registryId: `TenantReg${String(index).padStart(4, "0")}`,
    status: "ACTIVE",
  }));
  const { calls, service } = createHarness({
    domainState: {
      async listDomains() {
        return activeDomains;
      },
      async getDomain() {
        assert.fail("End User inventory must not select one domain.");
      },
    },
    registrySend: async (command) => ({
      registryRecords: Array.from({ length: 41 }, (_, index) =>
        summaryOf(agentRecord(
          command.input.registryId,
          `${command.input.registryId}-${String(index).padStart(2, "0")}`,
          "shared",
          { status: "APPROVED" },
        ))),
    }),
    registryDiscoverySend: async () => {
      assert.fail("Excessive summaries must fail before detail reads.");
    },
  });

  await assertUnavailable(service.registry(END_USER_SCOPE), "", "registry");
  assert.equal(
    commandInputs(calls.registry, "ListRegistryRecordsCommand").length,
    5,
  );
  assert.deepEqual(calls.registryDiscovery, []);
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
});

test("End User Registry rejects more than one hundred projected entries", async () => {
  const records = Array.from({ length: 101 }, (_, index) =>
    agentRecord(
      CONFIG.sharedRegistryId,
      `bounded-agent-${String(index).padStart(3, "0")}`,
      "shared",
      { status: "APPROVED" },
    ));
  const recordsById = new Map(
    records.map((record) => [record.recordId, record]),
  );
  const { calls, service } = createHarness({
    domainState: {
      async listDomains() {
        return [];
      },
      async getDomain() {
        assert.fail("End User inventory must not select one domain.");
      },
    },
    registrySend: async (command) => {
      assert.equal(command.constructor.name, "ListRegistryRecordsCommand");
      const offset = command.input.nextToken === undefined
        ? 0
        : Number(command.input.nextToken);
      const page = records.slice(offset, offset + 50);
      const nextOffset = offset + page.length;
      return {
        registryRecords: page.map(summaryOf),
        ...(nextOffset < records.length
          ? { nextToken: String(nextOffset) }
          : {}),
      };
    },
    registryDiscoverySend: async (command) => {
      const recordIds = command.input.entries[0].recordIds;
      return {
        registryRecords: recordIds.map((recordId) =>
          recordsById.get(recordId)),
        errors: [],
      };
    },
  });

  await assertUnavailable(service.registry(END_USER_SCOPE), "", "registry");
  assert.deepEqual(
    commandInputs(calls.registry, "ListRegistryRecordsCommand")
      .map(({ nextToken }) => nextToken),
    [undefined, "50", "100"],
  );
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
});

test("service exposes only authoritative active domains for identity projection", async () => {
  const { service } = createHarness({
    domainState: {
      async listDomains() {
        return [
          {
            id: "operations",
            name: "Operations",
            registryId: CONFIG.domainRegistryIds.operations,
            status: "ACTIVE",
          },
          {
            id: "retired",
            name: "Retired",
            registryId: "RetiredReg1234",
            status: "DECOMMISSIONED",
          },
        ];
      },
      async getDomain() {
        return null;
      },
    },
  });

  assert.deepEqual(await service.listActiveDomains(), [{
    id: "operations",
    name: "Operations",
    status: "ACTIVE",
  }]);
});

test("AI Gateway rejects non-admin service scopes before backend reads", async () => {
  const { calls, service } = createHarness();

  await assert.rejects(
    service.aiGateway(OPERATIONS_SCOPE),
    (error) =>
      error.code === "FORBIDDEN"
      && error.statusCode === 403,
  );
  assert.deepEqual(calls.registry, []);
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
});

test("registry paginates each authorized Registry and gets full descriptors", async () => {
  const sharedSkill = skillRecord(
    CONFIG.sharedRegistryId,
    "shared-skill",
    { domain: "shared" },
  );
  const sharedBlueprint = blueprintRecord(
    CONFIG.sharedRegistryId,
    "shared-blueprint",
  );
  const operationsAgent = agentRecord(
    CONFIG.domainRegistryIds.operations,
    "operations-agent",
    "operations",
  );
  const operationsSkill = skillRecord(
    CONFIG.domainRegistryIds.operations,
    "operations-skill",
    { domain: "operations" },
  );
  const fullRecords = new Map([
    [sharedSkill.recordId, sharedSkill],
    [sharedBlueprint.recordId, sharedBlueprint],
    [operationsAgent.recordId, operationsAgent],
    [operationsSkill.recordId, operationsSkill],
  ]);
  const { calls, service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "GetRegistryRecordCommand") {
        return fullRecords.get(command.input.recordId);
      }
      const { registryId, nextToken } = command.input;
      if (registryId === CONFIG.sharedRegistryId) {
        return nextToken
          ? { registryRecords: [summaryOf(sharedBlueprint)] }
          : {
              registryRecords: [summaryOf(sharedSkill)],
              nextToken: "shared-next",
            };
      }
      if (registryId === CONFIG.domainRegistryIds.operations) {
        return nextToken
          ? { registryRecords: [summaryOf(operationsSkill)] }
          : {
              registryRecords: [summaryOf(operationsAgent)],
              nextToken: "operations-next",
            };
      }
      throw new Error("unexpected registry");
    },
    registryDiscoverySend: async (command) => {
      const [{ registryId, recordIds }] = command.input.entries;
      return {
        registryRecords: recordIds
          .map((recordId) => fullRecords.get(recordId))
          .filter((record) => record.status === "APPROVED"),
        errors: recordIds
          .map((recordId) => fullRecords.get(recordId))
          .filter((record) => record.status !== "APPROVED")
          .map((record) => ({
            registryId,
            recordId: record.recordId,
            errorCode: "RESOURCE_NOT_FOUND",
          })),
      };
    },
  });

  const result = await service.registry(OPERATIONS_SCOPE);

  const listInputs = commandInputs(
    calls.registry,
    "ListRegistryRecordsCommand",
  );
  assert.deepEqual(
    listInputs.map(({ registryId, nextToken }) => ({
      registryId,
      nextToken,
    })),
    [
      { registryId: CONFIG.sharedRegistryId, nextToken: undefined },
      {
        registryId: CONFIG.domainRegistryIds.operations,
        nextToken: undefined,
      },
      { registryId: CONFIG.sharedRegistryId, nextToken: "shared-next" },
      {
        registryId: CONFIG.domainRegistryIds.operations,
        nextToken: "operations-next",
      },
    ],
  );
  assert.equal(
    commandInputs(calls.registry, "GetRegistryRecordCommand").length,
    1,
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.type).sort(),
    ["A2AAgent", "Blueprint", "Skill", "Skill"],
  );
  assert.equal(
    result.entries.find((entry) => entry.type === "A2AAgent")
      .versions[0].status,
    "IN_REVIEW",
  );
  assert.deepEqual(result.types, [
    "Skill",
    "MCPServer",
    "A2AAgent",
    "Agent",
    "Model",
    "Blueprint",
  ]);
  assert.deepEqual(result.statuses, [
    "DRAFT",
    "IN_REVIEW",
    "APPROVED",
    "REJECTED",
    "DEPRECATED",
  ]);
  assert.equal(
    result.store,
    "AWS Agent Registry + AgentCore Gateway",
  );
  assert.equal(result.ok, true);
  assert.equal(result.source, "aws");
});

test("hosted Registry pagination rejects malformed continuation tokens", async () => {
  const malformedTokens = [
    7,
    { token: "object" },
    "",
    "   ",
    "x".repeat(4097),
  ];

  for (const nextToken of malformedTokens) {
    const { service } = createHarness({
      registrySend: async (command) => {
        if (
          command.constructor.name === "ListRegistryRecordsCommand"
          && command.input.registryId === CONFIG.sharedRegistryId
          && command.input.nextToken === undefined
        ) {
          return { registryRecords: [], nextToken };
        }
        return { registryRecords: [] };
      },
    });

    await assertUnavailable(
      service.registry(OPERATIONS_SCOPE),
      JSON.stringify(nextToken),
    );
  }
});

test("registry reads use only Agent Registry and never force Gateway or model inventory", async () => {
  const { calls, service } = createHarness({
    gatewaySend: async () => {
      throw new Error("Gateway inventory must not be read.");
    },
    fetchImpl: async () => {
      throw new Error("Model inventory must not be read.");
    },
  });

  assert.deepEqual(await service.registryOnly(ADMIN_SCOPE), {
    ok: true,
    entries: [],
    types: [
      "Skill",
      "MCPServer",
      "A2AAgent",
      "Agent",
      "Model",
      "Blueprint",
    ],
    statuses: [
      "DRAFT",
      "IN_REVIEW",
      "APPROVED",
      "REJECTED",
      "DEPRECATED",
    ],
    store: "AWS Agent Registry + AgentCore Gateway",
    source: "aws",
  });
  assert.equal(calls.registry.length, 4);
  assert.deepEqual(calls.gateway, []);
  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.credentials, 0);
});

test("dedicated Registry inventory construction requires no Gateway or model configuration", async () => {
  assert.equal(
    typeof controlPlaneServiceModule.createRegistryInventoryService,
    "function",
  );
  const calls = [];
  const service = controlPlaneServiceModule.createRegistryInventoryService({
    config: {
      accountId: CONFIG.accountId,
      region: "us-west-2",
      sharedRegistryId: CONFIG.sharedRegistryId,
      domainRegistryIds: CONFIG.domainRegistryIds,
    },
    registryClient: {
      async send(command) {
        calls.push(command);
        return { registryRecords: [] };
      },
    },
  });

  assert.equal((await service.registryOnly(ADMIN_SCOPE)).ok, true);
  assert.equal(calls.length, 4);
});

test("dedicated registryOnly bounds dynamic Registry list concurrency and preserves order", async () => {
  const fixture = registryListConcurrencyFixture();
  const service = controlPlaneServiceModule.createRegistryInventoryService({
    config: {
      accountId: CONFIG.accountId,
      region: CONFIG.region,
      sharedRegistryId: CONFIG.sharedRegistryId,
      domainRegistryIds: CONFIG.domainRegistryIds,
    },
    domainState: fixture.domainState,
    registryClient: {
      send: fixture.registrySend,
    },
    registryDiscoveryClient: {
      send: fixture.registryDiscoverySend,
    },
  });

  const request = service.registryOnly(ADMIN_SCOPE);
  await fixture.releaseAll();
  const result = await request;

  assert.equal(fixture.maxActive(), 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    fixture.expectedEntryIds,
  );
});

test("full inventory bounds dynamic Registry list concurrency and preserves order", async () => {
  const fixture = registryListConcurrencyFixture();
  const { service } = createHarness({
    domainState: fixture.domainState,
    registrySend: fixture.registrySend,
    registryDiscoverySend: fixture.registryDiscoverySend,
  });

  const request = service.inventory(ADMIN_SCOPE);
  await fixture.releaseAll();
  const result = await request;

  assert.equal(fixture.maxActive(), 2);
  assert.deepEqual(
    result.registry.entries
      .filter((entry) => entry.type === "Skill")
      .map((entry) => entry.id),
    fixture.expectedEntryIds,
  );
});

test("Registry-only loading rejects conflicting authoritative record and descriptor types", async () => {
  const cases = [
    {
      ...skillRecord(CONFIG.sharedRegistryId, "conflict-skill-agent", {
        domain: "shared",
      }),
      descriptorType: "AGENT",
    },
    {
      ...agentRecord(
        CONFIG.sharedRegistryId,
        "conflict-agent-skill",
        "shared",
      ),
      descriptorType: "SKILL",
    },
    {
      ...blueprintRecord(
        CONFIG.sharedRegistryId,
        "conflict-custom-agent",
      ),
      descriptorType: "AGENT",
    },
  ];

  for (const detail of cases) {
    const service =
      controlPlaneServiceModule.createRegistryInventoryService({
        config: {
          accountId: CONFIG.accountId,
          region: CONFIG.region,
          sharedRegistryId: CONFIG.sharedRegistryId,
          domainRegistryIds: CONFIG.domainRegistryIds,
        },
        registryClient: {
          async send(command) {
            if (command.constructor.name === "ListRegistryRecordsCommand") {
              return command.input.registryId === CONFIG.sharedRegistryId
                ? { registryRecords: [summaryOf(detail)] }
                : { registryRecords: [] };
            }
            return detail;
          },
        },
      });

    await assertUnavailable(
      service.registryOnly(ADMIN_SCOPE),
      `${detail.recordType}/${detail.descriptorType}`,
    );
  }
});

test("Registry details reject mismatched or malformed authoritative fields", async () => {
  const valid = skillRecord(
    CONFIG.sharedRegistryId,
    "validated-skill",
    { domain: "shared" },
  );
  const cases = [
    [
      "mismatched registryId",
      { ...valid, registryId: CONFIG.domainRegistryIds.operations },
    ],
    [
      "mismatched registryArn without registryId",
      {
        ...valid,
        registryId: undefined,
        registryArn:
          "arn:aws:agent-registry:us-west-2:111122223333:"
          + `registry/${CONFIG.domainRegistryIds.operations}`,
      },
    ],
    ["mismatched recordId", { ...valid, recordId: "other-record" }],
    ["blank name", { ...valid, name: "   " }],
    ["blank version", { ...valid, recordVersion: "" }],
    ["unsupported type", { ...valid, recordType: "MCP" }],
    ["invalid status", { ...valid, status: "NOT_A_STATUS" }],
    ["missing descriptor", { ...valid, descriptors: {} }],
    [
      "unsupported custom descriptor",
      {
        ...valid,
        recordType: "CUSTOM",
        descriptors: {
          custom: {
            data: JSON.stringify({ resourceKind: "other" }),
          },
        },
      },
    ],
  ];

  for (const [label, detail] of cases) {
    const { service } = createHarness({
      registrySend: async (command) => {
        if (command.constructor.name === "ListRegistryRecordsCommand") {
          return command.input.registryId === CONFIG.sharedRegistryId
            ? { registryRecords: [summaryOf(valid)] }
            : { registryRecords: [] };
        }
        return detail;
      },
    });

    await assertUnavailable(
      service.registry(ADMIN_SCOPE),
      label,
    );
  }
});

test("mixed valid and malformed Registry details return no partial inventory", async () => {
  const good = skillRecord(
    CONFIG.sharedRegistryId,
    "good-skill",
    { domain: "shared" },
  );
  const malformed = skillRecord(
    CONFIG.sharedRegistryId,
    "malformed-skill",
    { domain: "shared" },
  );
  malformed.descriptors = {};
  const details = new Map([
    [good.recordId, good],
    [malformed.recordId, malformed],
  ]);
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? {
              registryRecords: [
                summaryOf(good),
                summaryOf(malformed),
              ],
            }
          : { registryRecords: [] };
      }
      return details.get(command.input.recordId);
    },
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
});

test("duplicate authoritative Registry record IDs fail closed", async () => {
  const record = skillRecord(
    CONFIG.sharedRegistryId,
    "duplicate-record",
    { domain: "shared" },
  );
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? { registryRecords: [summaryOf(record), summaryOf(record)] }
          : { registryRecords: [] };
      }
      return record;
    },
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
});

test("admin scope reads shared plus every configured domain Registry", async () => {
  const { calls, service } = createHarness();

  await service.registry(ADMIN_SCOPE);

  assert.deepEqual(
    new Set(
      commandInputs(calls.registry, "ListRegistryRecordsCommand")
        .map(({ registryId }) => registryId),
    ),
    new Set([
      CONFIG.sharedRegistryId,
      ...Object.values(CONFIG.domainRegistryIds),
    ]),
  );
});

test("admin scope resolves active durable domain Registries at request time", async () => {
  let listCalls = 0;
  const { calls, service } = createHarness({
    domainState: {
      listDomains: async () => {
        listCalls += 1;
        return [
          {
            id: "finance",
            registryId: "FinanceReg1234",
            status: "ACTIVE",
          },
          {
            id: "retired",
            registryId: "RetiredReg1234",
            status: "DECOMMISSIONED",
          },
        ];
      },
      getDomain: async () => null,
    },
  });

  await service.registry(ADMIN_SCOPE);

  assert.equal(listCalls, 1);
  assert.deepEqual(
    new Set(
      commandInputs(calls.registry, "ListRegistryRecordsCommand")
        .map(({ registryId }) => registryId),
    ),
    new Set([
      CONFIG.sharedRegistryId,
      "FinanceReg1234",
    ]),
  );
});

test("admin all-domain inventory queries each active Registry only once", async () => {
  const { calls, service } = createHarness({
    domainState: {
      listDomains: async () => [
        {
          id: "finance",
          registryId: "FinanceReg1234",
          status: "ACTIVE",
        },
        {
          id: "finance_ops",
          registryId: "FinanceReg1234",
          status: "ACTIVE",
        },
      ],
      getDomain: async () => null,
    },
  });

  await service.registry(ADMIN_SCOPE);

  assert.deepEqual(
    commandInputs(calls.registry, "ListRegistryRecordsCommand")
      .map(({ registryId }) => registryId),
    [
      CONFIG.sharedRegistryId,
      "FinanceReg1234",
    ],
  );
});

test("selected admin durable domain reads only shared plus that Registry", async () => {
  const stateCalls = [];
  let selectedSignal;
  const { calls, service } = createHarness({
    domainState: {
      listDomains: async () => {
        stateCalls.push({ method: "listDomains" });
        return [];
      },
      getDomain: async (domainId, options) => {
        stateCalls.push({ method: "getDomain", domainId });
        selectedSignal = options?.abortSignal;
        return {
          id: domainId,
          registryId: "FinanceReg1234",
          status: "ACTIVE",
        };
      },
    },
  });

  await service.registry({
    role: "admin",
    allowedDomains: [],
    activeDomain: "finance",
  });

  assert.deepEqual(stateCalls, [{
    method: "getDomain",
    domainId: "finance",
  }]);
  assert.ok(selectedSignal);
  assert.equal(selectedSignal.aborted, false);
  const listInputs = commandInputs(
    calls.registry,
    "ListRegistryRecordsCommand",
  );
  assert.equal(listInputs.length, 2);
  assert.deepEqual(
    new Set(
      listInputs.map(({ registryId }) => registryId),
    ),
    new Set([
      CONFIG.sharedRegistryId,
      "FinanceReg1234",
    ]),
  );
});

test("invalid selected admin durable domains fail before backend calls", async () => {
  for (const domain of [
    null,
    {
      id: "finance",
      registryId: "FinanceReg1234",
      status: "DECOMMISSIONED",
    },
    {
      id: "operations",
      registryId: "FinanceReg1234",
      status: "ACTIVE",
    },
    {
      id: "finance",
      registryId: "not-a-registry",
      status: "ACTIVE",
    },
  ]) {
    let listCalls = 0;
    let getCalls = 0;
    const { calls, service } = createHarness({
      domainState: {
        listDomains: async () => {
          listCalls += 1;
          return [];
        },
        getDomain: async () => {
          getCalls += 1;
          return domain;
        },
      },
    });

    await assert.rejects(
      service.registry({
        role: "admin",
        allowedDomains: [],
        activeDomain: "finance",
      }),
      (error) =>
        error.code === "DOMAIN_NOT_ALLOWED"
        && error.statusCode === 403
        && error.message === "The active domain is not allowed.",
    );
    assert.equal(listCalls, 0);
    assert.equal(getCalls, 1);
    assert.equal(calls.registry.length, 0);
    assert.equal(calls.gateway.length, 0);
    assert.equal(calls.fetch.length, 0);
  }
});

test("selected admin without durable state fails before backend calls", async () => {
  const { calls, service } = createHarness();

  await assert.rejects(
    service.registry({
      role: "admin",
      allowedDomains: [],
      activeDomain: "finance",
    }),
    (error) =>
      error.code === "DOMAIN_NOT_ALLOWED"
      && error.statusCode === 403
      && error.message === "The active domain is not allowed.",
  );
  assert.equal(calls.registry.length, 0);
  assert.equal(calls.gateway.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("selected admin durable domain lookup uses the request deadline", {
  timeout: 500,
}, async () => {
  let dynamoSignal;
  const domainState = createPlatformState({
    tableName: "PlatformState",
    dynamo: {
      async send(_command, options) {
        dynamoSignal = options?.abortSignal;
        return new Promise(() => {});
      },
    },
    now: () => FIXED_NOW.toISOString(),
  });
  const { calls, service } = createHarness({
    domainState,
    operationTimeoutMs: 10,
  });

  await assertUnavailable(service.registry({
    role: "admin",
    allowedDomains: [],
    activeDomain: "finance",
  }));

  assert.ok(dynamoSignal);
  assert.equal(dynamoSignal.aborted, true);
  assert.equal(calls.registry.length, 0);
  assert.equal(calls.gateway.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("domain scope reads only shared plus its allowed active domain", async () => {
  const { calls, service } = createHarness();

  await service.registry({
    role: "builder",
    allowedDomains: ["platform", "operations"],
    activeDomain: "operations",
  });

  assert.deepEqual(
    new Set(
      commandInputs(calls.registry, "ListRegistryRecordsCommand")
        .map(({ registryId }) => registryId),
    ),
    new Set([
      CONFIG.sharedRegistryId,
      CONFIG.domainRegistryIds.operations,
    ]),
  );
});

test("Platform Admin sees the platform Agent Design Assistant while Domain Builder cannot enumerate it", async () => {
  const platformAssistant = agentRecord(
    CONFIG.domainRegistryIds.platform,
    "assistant-record",
    "platform",
    {
      entryId: "agent-design-assistant",
      recordName: "agent_design_assistant",
      displayName: "Agent Design Assistant",
      status: "APPROVED",
    },
  );
  platformAssistant.descriptors = {
    custom: {
      data: platformAssistant.descriptors.a2aAgentCard.data,
    },
  };
  const domainAgent = agentRecord(
    CONFIG.domainRegistryIds.operations,
    "operations-agent-record",
    "operations",
    {
      entryId: "operations-agent",
      recordName: "operations_agent",
      status: "APPROVED",
    },
  );
  const records = [platformAssistant, domainAgent];
  const options = {
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return {
          registryRecords: records
            .filter((record) =>
              record.registryId === command.input.registryId)
            .map(summaryOf),
        };
      }
      throw new Error(`Unexpected ${command.constructor.name}`);
    },
    registryDiscoverySend: async (command) => ({
      registryRecords: command.input.entries.flatMap(
        ({ registryId, recordIds }) =>
          records.filter((record) =>
            record.registryId === registryId
            && recordIds.includes(record.recordId)),
      ),
      errors: [],
    }),
  };

  const admin = await createHarness(options).service.registry(ADMIN_SCOPE);
  assert.equal(
    admin.entries.some((entry) =>
      entry.id === "agent-design-assistant"
      && entry.domain === "platform"),
    true,
  );

  const builder = await createHarness(options).service.registry({
    role: "builder",
    allowedDomains: ["operations"],
    activeDomain: "operations",
  });
  assert.equal(
    builder.entries.some((entry) =>
      entry.id === "agent-design-assistant"
      || entry.domain === "platform"),
    false,
  );
  assert.equal(
    builder.entries.some((entry) =>
      entry.id === "operations-agent"
      && entry.domain === "operations"),
    true,
  );
});

test("domain scope resolves an allowed durable domain Registry at request time", async () => {
  const { calls, service } = createHarness({
    domainState: {
      listDomains: async () => [],
      getDomain: async (domainId) => ({
        id: domainId,
        registryId: "FinanceReg1234",
        status: "ACTIVE",
      }),
    },
  });

  await service.registry({
    role: "builder",
    allowedDomains: ["finance"],
    activeDomain: "finance",
  });

  const listInputs = commandInputs(
    calls.registry,
    "ListRegistryRecordsCommand",
  );
  assert.equal(listInputs.length, 2);
  assert.deepEqual(
    new Set(
      listInputs.map(({ registryId }) => registryId),
    ),
    new Set([
      CONFIG.sharedRegistryId,
      "FinanceReg1234",
    ]),
  );
});

test("missing durable active domain fails before Registry calls", async () => {
  const { calls, service } = createHarness({
    domainState: {
      listDomains: async () => [],
      getDomain: async () => null,
    },
  });

  await assert.rejects(
    service.registry({
      role: "builder",
      allowedDomains: ["finance"],
      activeDomain: "finance",
    }),
    (error) => error.code === "DOMAIN_NOT_ALLOWED" && error.statusCode === 403,
  );
  assert.equal(calls.registry.length, 0);
  assert.equal(calls.gateway.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("non-admin without an active allowed domain fails before backend calls", async () => {
  const { calls, service } = createHarness();

  await assert.rejects(
    service.registry({
      role: "builder",
      allowedDomains: [],
      activeDomain: null,
    }),
    (error) => error.code === "DOMAIN_REQUIRED" && error.statusCode === 403,
  );
  assert.equal(calls.registry.length, 0);
  assert.equal(calls.gateway.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("inventory scope failures remain asynchronous and call no backends", async () => {
  const { calls, service } = createHarness();

  await assert.rejects(
    service.inventory({
      role: "builder",
      allowedDomains: [],
      activeDomain: null,
    }),
    (error) => error.code === "DOMAIN_REQUIRED" && error.statusCode === 403,
  );
  assert.equal(calls.registry.length, 0);
  assert.equal(calls.gateway.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test("invalid active domain fails before backend calls", async () => {
  for (const scope of [
    {
      role: "builder",
      allowedDomains: ["operations"],
      activeDomain: "platform",
    },
    {
      role: "builder",
      allowedDomains: ["not_configured"],
      activeDomain: "not_configured",
    },
  ]) {
    const { calls, service } = createHarness();
    await assert.rejects(
      service.registry(scope),
      (error) =>
        error.code === "DOMAIN_NOT_ALLOWED" && error.statusCode === 403,
    );
    assert.equal(calls.registry.length, 0);
    assert.equal(calls.gateway.length, 0);
    assert.equal(calls.fetch.length, 0);
  }
});

test("tools targets paginate, load details, and map normalized endpoints", async () => {
  const targetSummaries = [
    {
      targetId: "target-1",
      name: "aws-docs",
      status: "READY",
      description: "AWS documentation",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
      updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    },
    {
      targetId: "target-2",
      name: "github",
      status: "FAILED",
      description: "GitHub",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
      updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    },
  ];
  const endpoints = {
    "target-1": "https://knowledge-mcp.global.api.aws",
    "target-2": "https://mcp.example/github",
  };
  const { calls, service } = createHarness({
    gatewaySend: async (command) => {
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return command.input.nextToken
          ? { items: [targetSummaries[1]] }
          : { items: [targetSummaries[0]], nextToken: "target-next" };
      }
      if (command.constructor.name === "GetGatewayTargetCommand") {
        const summary = targetSummaries.find(
          ({ targetId }) => targetId === command.input.targetId,
        );
        return gatewayTargetDetail(
          summary,
          endpoints[summary.targetId],
        );
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  });

  const result = await service.registry(ADMIN_SCOPE);
  const mcpEntries = result.entries.filter(
    (entry) => entry.type === "MCPServer",
  );

  assert.deepEqual(
    commandInputs(calls.gateway, "ListGatewayTargetsCommand"),
    [
      {
        gatewayIdentifier: CONFIG.toolsGatewayId,
        maxResults: 50,
        nextToken: undefined,
      },
      {
        gatewayIdentifier: CONFIG.toolsGatewayId,
        maxResults: 50,
        nextToken: "target-next",
      },
    ],
  );
  assert.equal(
    commandInputs(calls.gateway, "GetGatewayTargetCommand").length,
    2,
  );
  assert.deepEqual(
    mcpEntries.map((entry) => entry.versions[0].content.url),
    [
      "https://knowledge-mcp.global.api.aws",
      "https://mcp.example/github",
    ],
  );
  assert.deepEqual(
    mcpEntries.map((entry) => entry.versions[0].status),
    ["APPROVED", "DRAFT"],
  );
  assert.deepEqual(
    mcpEntries.map((entry) => entry.id),
    [
      `${CONFIG.toolsGatewayId}/target-1`,
      `${CONFIG.toolsGatewayId}/target-2`,
    ],
  );
});

test("AI Gateway tool targets carry the configured Gateway identifier", async () => {
  const summaries = [
    {
      targetId: "canonical-target-1",
      name: "canonical-mcp-1",
      status: "READY",
    },
    {
      targetId: "canonical-target-2",
      name: "canonical-mcp-2",
      status: "READY",
    },
  ];
  const detailsByTargetId = new Map(
    summaries.map((summary) => {
      const {
        gatewayIdentifier: _omittedGatewayIdentifier,
        ...detail
      } = {
        ...gatewayTargetDetail(
          summary,
          `https://mcp.example/${summary.targetId}`,
        ),
        statusReasons: [`${summary.targetId} is synchronized.`],
        credentialProviderConfigurations: [
          {
            credentialProviderType: "GATEWAY_IAM_ROLE",
          },
        ],
        $metadata: {
          httpStatusCode: 200,
          requestId: `request-${summary.targetId}`,
          attempts: 1,
          totalRetryDelay: 0,
        },
      };
      return [summary.targetId, detail];
    }),
  );
  const { service } = createHarness({
    gatewaySend: async (command) => {
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return { items: summaries };
      }
      return detailsByTargetId.get(command.input.targetId);
    },
  });

  const result = await service.aiGateway(ADMIN_SCOPE);

  assert.ok(result.toolsGateway.targets.length > 0);
  for (const target of result.toolsGateway.targets) {
    const detail = detailsByTargetId.get(target.targetId);
    assert.ok(detail);
    assert.equal(
      target.gatewayIdentifier,
      CONFIG.toolsGatewayId,
    );
    assert.equal(target.gatewayArn, detail.gatewayArn);
    assert.deepEqual(
      target.targetConfiguration,
      detail.targetConfiguration,
    );
    assert.deepEqual(target.statusReasons, detail.statusReasons);
    assert.deepEqual(
      target.credentialProviderConfigurations,
      detail.credentialProviderConfigurations,
    );
    assert.deepEqual(target.$metadata, detail.$metadata);
    assert.equal(
      target.endpoint,
      detail.targetConfiguration.mcp.mcpServer.endpoint,
    );
  }
});

test("same-name Gateway targets retain distinct authoritative IDs", async () => {
  const summaries = [
    {
      targetId: "duplicate-name-1",
      name: "shared-display-name",
      status: "READY",
    },
    {
      targetId: "duplicate-name-2",
      name: "shared-display-name",
      status: "READY",
    },
  ];
  const { service } = createHarness({
    gatewaySend: async (command) => {
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return { items: summaries };
      }
      const summary = summaries.find(
        ({ targetId }) => targetId === command.input.targetId,
      );
      return gatewayTargetDetail(
        summary,
        `https://mcp.example/${summary.targetId}`,
      );
    },
  });

  const result = await service.registry(ADMIN_SCOPE);

  assert.deepEqual(
    result.entries
      .filter((entry) => entry.type === "MCPServer")
      .map((entry) => entry.id),
    [
      `${CONFIG.toolsGatewayId}/duplicate-name-1`,
      `${CONFIG.toolsGatewayId}/duplicate-name-2`,
    ],
  );
});

test("duplicate authoritative Gateway target IDs fail closed", async () => {
  const summary = {
    targetId: "duplicate-target",
    name: "duplicate-target",
    status: "READY",
  };
  const { service } = createHarness({
    gatewaySend: async (command) => {
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return { items: [summary, summary] };
      }
      return gatewayTargetDetail(
        summary,
        "https://mcp.example/duplicate-target",
      );
    },
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
});

test("Gateway target details reject mismatched or malformed fields", async () => {
  const summary = {
    targetId: "validated-target",
    name: "validated-mcp",
    status: "READY",
    description: "Validated target",
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
  };
  const valid = gatewayTargetDetail(
    summary,
    "https://mcp.example/validated",
  );
  const {
    gatewayIdentifier: _omittedGatewayIdentifier,
    ...validWithoutGatewayIdentifier
  } = valid;
  const mismatchedGatewayArnWithoutIdentifier = {
    ...validWithoutGatewayIdentifier,
    gatewayArn:
      `arn:aws:bedrock-agentcore:${CONFIG.region}:111122223333:`
      + `gateway/${CONFIG.llmGatewayId}`,
  };
  assert.equal(
    Object.hasOwn(
      mismatchedGatewayArnWithoutIdentifier,
      "gatewayIdentifier",
    ),
    false,
  );
  const cases = [
    [
      "mismatched gatewayIdentifier",
      {
        ...valid,
        gatewayIdentifier: CONFIG.llmGatewayId,
      },
    ],
    [
      "mismatched gatewayArn without identifier",
      mismatchedGatewayArnWithoutIdentifier,
    ],
    ["mismatched targetId", { ...valid, targetId: "other-target" }],
    ["blank name", { ...valid, name: " " }],
    ["invalid status", { ...valid, status: "NOT_A_STATUS" }],
    [
      "missing target configuration",
      {
        ...valid,
        endpoint: CONFIG.toolsGatewayUrl,
        targetConfiguration: undefined,
      },
    ],
    [
      "missing MCP endpoint",
      {
        ...valid,
        endpoint: CONFIG.toolsGatewayUrl,
        targetConfiguration: { mcp: { mcpServer: {} } },
      },
    ],
    [
      "invalid MCP endpoint",
      gatewayTargetDetail(summary, "not-a-url"),
    ],
    [
      "non-HTTPS MCP endpoint",
      gatewayTargetDetail(summary, "http://mcp.example/insecure"),
    ],
  ];

  for (const [label, detail] of cases) {
    const { service } = createHarness({
      gatewaySend: async (command) => {
        if (command.constructor.name === "ListGatewayTargetsCommand") {
          return { items: [summary] };
        }
        return detail;
      },
    });

    await assertUnavailable(
      service.registry(ADMIN_SCOPE),
      label,
    );
  }
});

test("mixed valid and malformed Gateway details return no partial inventory", async () => {
  const summaries = [
    {
      targetId: "good-target",
      name: "good-mcp",
      status: "READY",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
      updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    },
    {
      targetId: "malformed-target",
      name: "malformed-mcp",
      status: "READY",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
      updatedAt: new Date("2026-08-21T00:00:00.000Z"),
    },
  ];
  const details = new Map([
    [
      summaries[0].targetId,
      gatewayTargetDetail(
        summaries[0],
        "https://mcp.example/good",
      ),
    ],
    [
      summaries[1].targetId,
      {
        ...gatewayTargetDetail(
          summaries[1],
          "https://mcp.example/malformed",
        ),
        targetConfiguration: {},
      },
    ],
  ]);
  const { service } = createHarness({
    gatewaySend: async (command) => {
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return { items: summaries };
      }
      return details.get(command.input.targetId);
    },
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
});

test("model discovery signs the exact models URL and maps legacy entries", async () => {
  let request;
  const { service } = createHarness({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        data: [
          {
            id: "bedrock-mantle/meta.llama-4-405b",
            object: "model",
            owned_by: "meta",
          },
        ],
      });
    },
  });

  const result = await service.aiGateway(ADMIN_SCOPE);

  assert.equal(request.url, `${CONFIG.llmGatewayUrl}/models`);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.host, new URL(CONFIG.llmGatewayUrl).host);
  assert.equal(request.init.headers["x-amz-date"], "20260822T010203Z");
  assert.equal(
    request.init.headers["x-amz-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb924"
      + "27ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    request.init.headers["x-amz-security-token"],
    CREDENTIALS.sessionToken,
  );
  assert.match(
    request.init.headers.Authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//,
  );
  assert.match(
    request.init.headers.Authorization,
    /\/us-east-1\/bedrock-agentcore\/aws4_request,/,
  );
  assert.deepEqual(
    result.models.map((entry) => entry.id),
    ["bedrock-mantle/meta.llama-4-405b"],
  );
  assert.equal(result.models[0].name, "Llama 4 405B");
  assert.equal(result.models[0].type, "Model");
  assert.equal(result.models[0].versions[0].status, "IN_REVIEW");
  assert.deepEqual(
    result.models[0].versions[0].content,
    {
      gateway: CONFIG.llmGatewayName,
      gatewayId: CONFIG.llmGatewayId,
      gatewayUrl: CONFIG.llmGatewayUrl,
      gatewayModelId: "bedrock-mantle/meta.llama-4-405b",
      region: CONFIG.llmGatewayRegion,
      runtimeModelId: "bedrock-mantle/meta.llama-4-405b",
      source: "agentcore-gateway",
      ownedBy: "meta",
      object: "model",
      pricing: null,
    },
  );
});

test("catalog metadata enriches only models discovered from the Gateway", async () => {
  const { service } = createHarness({
    catalogMetadata: {
      models: [
        {
          id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
          label: "Claude Haiku 4.5",
          vendor: "Anthropic",
          tier: "fast",
          approved: true,
          noTemperature: true,
          pricing: { inputPer1k: 0.0008, outputPer1k: 0.004 },
        },
        {
          id: "catalog-only-model",
          label: "Must Not Appear",
          approved: true,
        },
      ],
    },
    fetchImpl: async () => jsonResponse({
      data: [
        {
          id: "bedrock-claude/anthropic.claude-haiku-4-5",
          owned_by: "anthropic",
        },
        {
          id: "bedrock-mantle/openai.gpt-oss-120b",
          owned_by: "openai",
        },
      ],
    }),
  });

  const result = await service.registry(ADMIN_SCOPE);
  const models = result.entries.filter((entry) => entry.type === "Model");

  // Governed catalog: the Registry response carries ONLY approved models.
  // The undecided discovered model (gpt-oss-120b, no catalog approval) stays
  // on the AI Gateway inventory, where admins onboard models — never here.
  assert.deepEqual(
    models.map((model) => model.id),
    ["bedrock-claude/anthropic.claude-haiku-4-5"],
  );
  assert.equal(models[0].name, "Claude Haiku 4.5");
  assert.equal(models[0].description, "Anthropic fast");
  assert.equal(models[0].versions[0].status, "APPROVED");
  assert.equal(
    models[0].versions[0].content.runtimeModelId,
    "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  );
  assert.deepEqual(
    models[0].versions[0].content.pricing,
    { inputPer1k: 0.0008, outputPer1k: 0.004 },
  );
  assert.equal(models[0]._catalogMatch, true);
  assert.equal(
    result.entries.some((entry) => entry.id === "catalog-only-model"),
    false,
  );
  const gateway = await service.aiGateway(ADMIN_SCOPE);
  assert.deepEqual(
    gateway.models.map((model) => model.id).sort(),
    [
      "bedrock-claude/anthropic.claude-haiku-4-5",
      "bedrock-mantle/openai.gpt-oss-120b",
    ],
  );
});

test("duplicate authoritative model IDs fail closed", async () => {
  const { service } = createHarness({
    fetchImpl: async () => jsonResponse({
      data: [
        { id: "duplicate-model", owned_by: "example" },
        { id: "duplicate-model", owned_by: "example" },
      ],
    }),
  });

  await assertUnavailable(service.aiGateway(ADMIN_SCOPE));
});

test("duplicate final Registry entry IDs fail closed", async () => {
  const record = skillRecord(
    CONFIG.sharedRegistryId,
    "shared-entry-id",
    { domain: "shared", name: "shared-entry-id" },
  );
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? { registryRecords: [summaryOf(record)] }
          : { registryRecords: [] };
      }
      return record;
    },
    fetchImpl: async () => jsonResponse({
      data: [{ id: "shared-entry-id", owned_by: "example" }],
    }),
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
});

test("model signing resolves credentials from the injected SDK client", async () => {
  const { calls, service } = createHarness({
    credentials: OMIT_CREDENTIALS,
  });

  await service.aiGateway(ADMIN_SCOPE);

  assert.equal(calls.credentials, 1);
  assert.match(
    calls.fetch[0][1].headers.Authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//,
  );
});

test("service validates deadline and concurrency options", () => {
  for (const [option, value] of [
    ["operationTimeoutMs", 0],
    ["operationTimeoutMs", Number.POSITIVE_INFINITY],
    ["operationTimeoutMs", 1.5],
    ["maxDetailConcurrency", 0],
    ["maxDetailConcurrency", Number.POSITIVE_INFINITY],
    ["maxDetailConcurrency", 1.5],
    ["maxRegistryListConcurrency", 0],
    ["maxRegistryListConcurrency", Number.POSITIVE_INFINITY],
    ["maxRegistryListConcurrency", 1.5],
  ]) {
    assert.throws(
      () => createHarness({ [option]: value }),
      new RegExp(option),
    );
    if (option === "maxRegistryListConcurrency") {
      assert.throws(
        () => controlPlaneServiceModule.createRegistryInventoryService({
          config: {
            accountId: CONFIG.accountId,
            region: CONFIG.region,
            sharedRegistryId: CONFIG.sharedRegistryId,
            domainRegistryIds: CONFIG.domainRegistryIds,
          },
          [option]: value,
        }),
        new RegExp(option),
      );
    }
  }
});

test("Registry service configuration requires a 12-digit account ID", () => {
  const invalidAccountIds = [
    undefined,
    "",
    "123",
    "11112222333x",
    "1111222233334",
  ];

  for (const accountId of invalidAccountIds) {
    const config = { ...CONFIG, accountId };
    if (accountId === undefined) {
      delete config.accountId;
    }
    assert.throws(
      () => createHarness({ config }),
      /account/i,
    );
    assert.throws(
      () => controlPlaneServiceModule.createRegistryInventoryService({
        config: {
          accountId,
          region: CONFIG.region,
          sharedRegistryId: CONFIG.sharedRegistryId,
          domainRegistryIds: CONFIG.domainRegistryIds,
        },
      }),
      /account/i,
    );
  }
});

test("detail concurrency cannot exceed two operations", () => {
  assert.throws(
    () => createHarness({ maxDetailConcurrency: 3 }),
    /maxDetailConcurrency/,
  );
  assert.throws(
    () => controlPlaneServiceModule.createRegistryInventoryService({
      config: {
        accountId: CONFIG.accountId,
        region: CONFIG.region,
        sharedRegistryId: CONFIG.sharedRegistryId,
        domainRegistryIds: CONFIG.domainRegistryIds,
      },
      maxDetailConcurrency: 3,
    }),
    /maxDetailConcurrency/,
  );
});

test("Registry list concurrency cannot exceed two operations", () => {
  assert.throws(
    () => createHarness({ maxRegistryListConcurrency: 3 }),
    /maxRegistryListConcurrency/,
  );
  assert.throws(
    () => controlPlaneServiceModule.createRegistryInventoryService({
      config: {
        accountId: CONFIG.accountId,
        region: CONFIG.region,
        sharedRegistryId: CONFIG.sharedRegistryId,
        domainRegistryIds: CONFIG.domainRegistryIds,
      },
      maxRegistryListConcurrency: 3,
    }),
    /maxRegistryListConcurrency/,
  );
});

test("inventory shares one live abort signal and one deadline timer", async () => {
  let credentialSignal;
  const scheduled = [];
  const cleared = [];
  const deadlineTimers = {
    setTimeout(callback, timeoutMs) {
      const handle = { callback, timeoutMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };
  const { calls, service } = createHarness({
    credentials: async (options) => {
      credentialSignal = options?.abortSignal;
      return CREDENTIALS;
    },
    deadlineTimers,
  });

  await service.inventory(ADMIN_SCOPE);

  const registrySignals = calls.registryOptions
    .map((options) => options?.abortSignal);
  const gatewaySignals = calls.gatewayOptions
    .map((options) => options?.abortSignal);
  const modelSignal = calls.fetch[0][1].signal;
  const signals = [
    ...registrySignals,
    ...gatewaySignals,
    credentialSignal,
    modelSignal,
  ];
  assert.ok(signals.every(Boolean));
  assert.equal(new Set(signals).size, 1);
  assert.ok(signals.every((signal) => signal.aborted === false));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].timeoutMs, 20_000);
  assert.deepEqual(cleared, scheduled);
});

test("a never-resolving Registry SDK call aborts at the shared deadline", {
  timeout: 500,
}, async () => {
  let sendOptions;
  const { service } = createHarness({
    operationTimeoutMs: 10,
    registrySend: async (_command, _calls, options) => {
      sendOptions = options;
      return new Promise(() => {});
    },
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));

  assert.ok(sendOptions?.abortSignal);
  assert.equal(sendOptions.abortSignal.aborted, true);
});

test("a never-resolving Gateway SDK call aborts at the shared deadline", {
  timeout: 500,
}, async () => {
  let sendOptions;
  const { service } = createHarness({
    operationTimeoutMs: 10,
    gatewaySend: async (_command, _calls, options) => {
      sendOptions = options;
      return new Promise(() => {});
    },
  });

  await assertUnavailable(service.aiGateway(ADMIN_SCOPE));

  assert.ok(sendOptions?.abortSignal);
  assert.equal(sendOptions.abortSignal.aborted, true);
});

test("a never-resolving model fetch aborts at the shared deadline", {
  timeout: 500,
}, async () => {
  let fetchOptions;
  const { service } = createHarness({
    operationTimeoutMs: 10,
    fetchImpl: async (_url, options) => {
      fetchOptions = options;
      return new Promise(() => {});
    },
  });

  await assertUnavailable(service.aiGateway(ADMIN_SCOPE));

  assert.ok(fetchOptions?.signal);
  assert.equal(fetchOptions.signal.aborted, true);
});

test("a never-resolving credential provider is bounded by the deadline", {
  timeout: 500,
}, async () => {
  let providerCalls = 0;
  const { calls, service } = createHarness({
    credentials: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? new Promise(() => {})
        : CREDENTIALS;
    },
    operationTimeoutMs: 20,
  });

  await assertUnavailable(service.aiGateway(ADMIN_SCOPE));
  const result = await service.aiGateway(ADMIN_SCOPE);

  assert.equal(providerCalls, 2);
  assert.equal(calls.fetch.length, 1);
  assert.deepEqual(result.models, []);
});

test("Registry batch detail reads default to two concurrent calls and preserve order", async () => {
  const registryIds = [
    CONFIG.sharedRegistryId,
    CONFIG.domainRegistryIds.platform,
    CONFIG.domainRegistryIds.customer_support,
    CONFIG.domainRegistryIds.operations,
  ];
  const records = registryIds.map((registryId, index) =>
    skillRecord(registryId, `ordered-skill-${index}`, {
      domain: index === 0 ? "shared" : Object.entries(
        CONFIG.domainRegistryIds,
      ).find(([, id]) => id === registryId)?.[0],
    }));
  const releases = [];
  let active = 0;
  let completed = 0;
  let maxActive = 0;
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return {
          registryRecords: records
            .filter((record) => record.registryId === command.input.registryId)
            .map(summaryOf),
        };
      }
      throw new Error(`Unexpected Registry command ${command.constructor.name}`);
    },
    registryDiscoverySend: async (command) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          completed += 1;
          const [entry] = command.input.entries;
          resolve({
            registryRecords: records.filter(
              (record) => record.registryId === entry.registryId,
            ),
            errors: [],
          });
        });
      });
    },
  });

  const request = service.registry(ADMIN_SCOPE);
  await releaseInReverseBatches(
    releases,
    () => completed,
    registryIds.length,
  );
  const result = await request;

  assert.equal(maxActive, 2);
  assert.deepEqual(
    result.entries
      .filter((entry) => entry.type === "Skill")
      .map((entry) => entry.id),
    records.map((record) => record.name),
  );
});

test("Registry discovery splits 51 records into one 50-record batch and one 1-record batch", async () => {
  const records = Array.from(
    { length: 51 },
    (_, index) =>
      skillRecord(
        CONFIG.sharedRegistryId,
        `batch-${String(index).padStart(2, "0")}`,
        { domain: "shared" },
      ),
  );
  const batches = [];
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? { registryRecords: records.map(summaryOf) }
          : { registryRecords: [] };
      }
      throw new Error(`Unexpected Registry command ${command.constructor.name}`);
    },
    registryDiscoverySend: async (command) => {
      const [{ recordIds }] = command.input.entries;
      batches.push([...recordIds]);
      return {
        registryRecords: records.filter((record) =>
          recordIds.includes(record.recordId)
        ),
        errors: [],
      };
    },
  });

  await service.registry(ADMIN_SCOPE);

  assert.deepEqual(batches.map((recordIds) => recordIds.length), [50, 1]);
  assert.deepEqual(
    batches.flat(),
    records.map(({ recordId }) => recordId),
  );
});

test("Registry batch reads return approved records without per-record control-plane gets", async () => {
  const approved = [
    skillRecord(CONFIG.sharedRegistryId, "approved-skill", {
      domain: "shared",
    }),
    blueprintRecord(CONFIG.sharedRegistryId, "approved-blueprint"),
  ];
  const { calls, service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? { registryRecords: approved.map(summaryOf) }
          : { registryRecords: [] };
      }
      throw new Error(`Unexpected Registry command ${command.constructor.name}`);
    },
    registryDiscoverySend: async (command) => {
      assert.deepEqual(command.input, {
        entries: [{
          registryId: CONFIG.sharedRegistryId,
          recordIds: approved.map((record) => record.recordId),
        }],
      });
      return { registryRecords: approved, errors: [] };
    },
  });

  const result = await service.registry(ADMIN_SCOPE);

  assert.deepEqual(
    commandInputs(
      calls.registryDiscovery,
      "BatchGetDiscoverableRegistryRecordCommand",
    ),
    [{
      entries: [{
        registryId: CONFIG.sharedRegistryId,
        recordIds: approved.map((record) => record.recordId),
      }],
    }],
  );
  assert.deepEqual(
    commandInputs(calls.registry, "GetRegistryRecordCommand"),
    [],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["skill_approved-skill", "approved-blueprint"],
  );
});

test("successful Registry batch records require approved matching summary status", async () => {
  const cases = [
    ["DRAFT", "DRAFT"],
    ["PENDING_APPROVAL", "PENDING_APPROVAL"],
    ["REJECTED", "REJECTED"],
    ["APPROVED", "DRAFT"],
  ];

  for (const [summaryStatus, detailStatus] of cases) {
    const approved = skillRecord(
      CONFIG.sharedRegistryId,
      `batch-status-${summaryStatus.toLowerCase()}`,
      { domain: "shared" },
    );
    const summary = { ...approved, status: summaryStatus };
    const detail = { ...approved, status: detailStatus };
    const { service } = createHarness({
      registrySend: async (command) => {
        if (command.constructor.name === "ListRegistryRecordsCommand") {
          return command.input.registryId === CONFIG.sharedRegistryId
            ? { registryRecords: [summaryOf(summary)] }
            : { registryRecords: [] };
        }
        throw new Error(
          `Unexpected Registry command ${command.constructor.name}`,
        );
      },
      registryDiscoverySend: async () => ({
        registryRecords: [detail],
        errors: [],
      }),
    });

    await assertUnavailable(
      service.registry(ADMIN_SCOPE),
      `${summaryStatus}/${detailStatus}`,
    );
  }

  const approved = skillRecord(
    CONFIG.sharedRegistryId,
    "approved-missing-skill",
    { domain: "shared" },
  );
  let getCalls = 0;
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? { registryRecords: [summaryOf(approved)] }
          : { registryRecords: [] };
      }
      getCalls += 1;
      return approved;
    },
    registryDiscoverySend: async () => ({
      registryRecords: [],
      errors: [{
        registryId: approved.registryId,
        recordId: approved.recordId,
        errorCode: "RESOURCE_NOT_FOUND",
      }],
    }),
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
  assert.equal(getCalls, 0);
});

test("Registry batch details require the exact expected record ARN", async () => {
  const approved = skillRecord(
    CONFIG.sharedRegistryId,
    "record-arn-skill",
    { domain: "shared" },
  );
  const invalidRecordArns = [
    undefined,
    "",
    `${approved.registryArn}/record/other-record`,
  ];

  for (const recordArn of invalidRecordArns) {
    const { service } = createHarness({
      registrySend: async (command) => {
        if (command.constructor.name === "ListRegistryRecordsCommand") {
          return command.input.registryId === CONFIG.sharedRegistryId
            ? { registryRecords: [summaryOf(approved)] }
            : { registryRecords: [] };
        }
        throw new Error(
          `Unexpected Registry command ${command.constructor.name}`,
        );
      },
      registryDiscoverySend: async () => ({
        registryRecords: [{ ...approved, recordArn }],
        errors: [],
      }),
    });

    await assertUnavailable(
      service.registry(ADMIN_SCOPE),
      String(recordArn),
    );
  }
});

test("Registry list summaries require the exact expected record ARN", async () => {
  const approved = skillRecord(
    CONFIG.sharedRegistryId,
    "summary-record-arn-skill",
    { domain: "shared" },
  );
  const invalidRecordArns = [
    undefined,
    "",
    `${approved.registryArn}/record/other-record`,
  ];

  for (const recordArn of invalidRecordArns) {
    const { service } = createHarness({
      registrySend: async (command) => {
        if (command.constructor.name === "ListRegistryRecordsCommand") {
          return command.input.registryId === CONFIG.sharedRegistryId
            ? {
                registryRecords: [{
                  ...summaryOf(approved),
                  recordArn,
                }],
              }
            : { registryRecords: [] };
        }
        throw new Error(
          `Unexpected Registry command ${command.constructor.name}`,
        );
      },
      registryDiscoverySend: async () => ({
        registryRecords: [approved],
        errors: [],
      }),
    });

    await assertUnavailable(
      service.registry(ADMIN_SCOPE),
      String(recordArn),
    );
  }
});

test("Registry summary ARNs must match the configured deployment account", async () => {
  const approved = skillRecord(
    CONFIG.sharedRegistryId,
    "summary-account-skill",
    { domain: "shared" },
  );
  const otherAccountArn = approved.registryArn.replace(
    CONFIG.accountId,
    "999922223333",
  );
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? {
              registryRecords: [{
                ...summaryOf(approved),
                registryArn: otherAccountArn,
                recordArn:
                  `${otherAccountArn}/record/${approved.recordId}`,
              }],
            }
          : { registryRecords: [] };
      }
      throw new Error(
        `Unexpected Registry command ${command.constructor.name}`,
      );
    },
    registryDiscoverySend: async () => ({
      registryRecords: [{
        ...approved,
        registryArn: otherAccountArn,
        recordArn: `${otherAccountArn}/record/${approved.recordId}`,
      }],
      errors: [],
    }),
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
});

test("Registry detail reads bypass discovery for non-approved records", async () => {
  const approved = skillRecord(
    CONFIG.domainRegistryIds.operations,
    "approved-skill",
    { domain: "operations" },
  );
  const draft = agentRecord(
    CONFIG.domainRegistryIds.operations,
    "draft-agent",
    "operations",
  );
  const records = [approved, draft];
  const { calls, service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId
          === CONFIG.domainRegistryIds.operations
          ? { registryRecords: records.map(summaryOf) }
          : { registryRecords: [] };
      }
      assert.equal(command.constructor.name, "GetRegistryRecordCommand");
      assert.equal(command.input.recordId, draft.recordId);
      return draft;
    },
    registryDiscoverySend: async (command) => {
      assert.deepEqual(command.input, {
        entries: [{
          registryId: approved.registryId,
          recordIds: [approved.recordId],
        }],
      });
      return {
        registryRecords: [approved],
        errors: [],
      };
    },
  });

  const result = await service.registry(ADMIN_SCOPE);

  assert.deepEqual(
    commandInputs(calls.registry, "GetRegistryRecordCommand"),
    [{
      registryId: draft.registryId,
      recordId: draft.recordId,
    }],
  );
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["skill_approved-skill", "agent-draft-agent"],
  );
});

test("Registry control-plane details must match the listed status", async () => {
  const draft = {
    ...skillRecord(
      CONFIG.domainRegistryIds.operations,
      "draft-status-skill",
      { domain: "operations" },
    ),
    status: "DRAFT",
  };
  const { calls, service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId
          === CONFIG.domainRegistryIds.operations
          ? { registryRecords: [summaryOf(draft)] }
          : { registryRecords: [] };
      }
      assert.equal(command.constructor.name, "GetRegistryRecordCommand");
      return { ...draft, status: "APPROVED" };
    },
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
  assert.deepEqual(
    commandInputs(calls.registry, "GetRegistryRecordCommand"),
    [{
      registryId: draft.registryId,
      recordId: draft.recordId,
    }],
  );
});

test("Registry batch errors other than non-discoverable records fail closed", async () => {
  const record = skillRecord(CONFIG.sharedRegistryId, "denied-skill", {
    domain: "shared",
  });
  const { service } = createHarness({
    registrySend: async (command) => {
      if (command.constructor.name === "ListRegistryRecordsCommand") {
        return command.input.registryId === CONFIG.sharedRegistryId
          ? { registryRecords: [summaryOf(record)] }
          : { registryRecords: [] };
      }
      throw new Error(`Unexpected Registry command ${command.constructor.name}`);
    },
    registryDiscoverySend: async () => ({
      registryRecords: [],
      errors: [{
        registryId: record.registryId,
        recordId: record.recordId,
        errorCode: "ACCESS_DENIED",
      }],
    }),
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE));
});

test("Gateway detail reads default to two concurrent calls and preserve order", async () => {
  const total = 25;
  const summaries = Array.from({ length: total }, (_, index) => ({
    targetId: `ordered-target-${String(index).padStart(2, "0")}`,
    name: `ordered-mcp-${String(index).padStart(2, "0")}`,
    status: "READY",
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-21T00:00:00.000Z"),
  }));
  const summariesById = new Map(
    summaries.map((summary) => [summary.targetId, summary]),
  );
  const releases = [];
  let active = 0;
  let completed = 0;
  let maxActive = 0;
  const { service } = createHarness({
    gatewaySend: async (command) => {
      if (command.constructor.name === "ListGatewayTargetsCommand") {
        return { items: summaries };
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          completed += 1;
          resolve(gatewayTargetDetail(
            summariesById.get(command.input.targetId),
            `https://mcp.example/${command.input.targetId}`,
          ));
        });
      });
    },
  });

  const request = service.aiGateway(ADMIN_SCOPE);
  await releaseInReverseBatches(
    releases,
    () => completed,
    total,
  );
  const result = await request;

  assert.equal(maxActive, 2);
  assert.deepEqual(
    result.toolsGateway.targets.map((target) => target.name),
    summaries.map((summary) => summary.name),
  );
});

test("an aborted shared model load is evicted so the next request retries", {
  timeout: 500,
}, async () => {
  let fetchCalls = 0;
  const { service } = createHarness({
    operationTimeoutMs: 10,
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Promise(() => {})
        : jsonResponse({ data: [] });
    },
  });

  await assertUnavailable(service.aiGateway(ADMIN_SCOPE));
  const result = await service.aiGateway(ADMIN_SCOPE);

  assert.equal(fetchCalls, 2);
  assert.deepEqual(result.models, []);
});

test("a failed request aborts and evicts a hanging sibling shared load", {
  timeout: 500,
}, async () => {
  let firstGatewaySignal;
  let gatewayCalls = 0;
  const { service } = createHarness({
    gatewaySend: async (command, _calls, options) => {
      if (command.constructor.name !== "ListGatewayTargetsCommand") {
        assert.fail(`Unexpected Gateway command ${command.constructor.name}`);
      }
      gatewayCalls += 1;
      if (gatewayCalls === 1) {
        firstGatewaySignal = options.abortSignal;
        return new Promise(() => {});
      }
      return { items: [] };
    },
    operationTimeoutMs: 10,
    registrySend: async () => {
      throw new Error("TOP-SECRET Registry failure");
    },
  });

  await assertUnavailable(service.inventory(ADMIN_SCOPE));
  const result = await service.aiGateway(ADMIN_SCOPE);

  assert.equal(firstGatewaySignal.aborted, true);
  assert.equal(gatewayCalls, 2);
  assert.deepEqual(result.models, []);
});

test("a later waiter survives the first waiter's staggered deadline", {
  timeout: 1_000,
}, async () => {
  const gatewayResponse = deferred();
  const modelResponse = deferred();
  let gatewaySignal;
  let modelSignal;
  const { calls, service } = createHarness({
    fetchImpl: async (_url, options) => {
      modelSignal = options.signal;
      return settleWithSignal(modelResponse.promise, modelSignal);
    },
    gatewaySend: async (command, _calls, options) => {
      assert.equal(
        command.constructor.name,
        "ListGatewayTargetsCommand",
      );
      gatewaySignal = options.abortSignal;
      return settleWithSignal(gatewayResponse.promise, gatewaySignal);
    },
    operationTimeoutMs: 120,
  });

  const first = service.aiGateway(ADMIN_SCOPE);
  await waitFor(
    () => Boolean(gatewaySignal && modelSignal),
    "Expected the first shared Gateway and model loads.",
  );
  await delay(40);
  const secondOutcome = service.aiGateway(ADMIN_SCOPE).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

  await assertUnavailable(first);
  assert.equal(gatewaySignal.aborted, false);
  assert.equal(modelSignal.aborted, false);
  gatewayResponse.resolve({ items: [] });
  modelResponse.resolve(jsonResponse({ data: [] }));
  const second = await secondOutcome;

  assert.equal(second.error, undefined);
  assert.deepEqual(second.value.models, []);
  assert.equal(
    commandInputs(calls.gateway, "ListGatewayTargetsCommand").length,
    1,
  );
  assert.equal(calls.fetch.length, 1);
});

test("an unrelated inventory failure does not abort a concurrent AI Gateway waiter", {
  timeout: 1_000,
}, async () => {
  const gatewayResponse = deferred();
  const modelResponse = deferred();
  const registryFailure = deferred();
  let gatewaySignal;
  let modelSignal;
  const { calls, service } = createHarness({
    fetchImpl: async (_url, options) => {
      modelSignal = options.signal;
      return settleWithSignal(modelResponse.promise, modelSignal);
    },
    gatewaySend: async (command, _calls, options) => {
      assert.equal(
        command.constructor.name,
        "ListGatewayTargetsCommand",
      );
      gatewaySignal = options.abortSignal;
      return settleWithSignal(gatewayResponse.promise, gatewaySignal);
    },
    operationTimeoutMs: 500,
    registrySend: async (_command, _calls, options) =>
      settleWithSignal(registryFailure.promise, options.abortSignal),
  });

  const inventory = service.inventory(ADMIN_SCOPE);
  await waitFor(
    () => Boolean(gatewaySignal && modelSignal && calls.registry.length),
    "Expected the inventory backend loads to start.",
  );
  const gatewayOutcome = service.aiGateway(ADMIN_SCOPE).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await Promise.resolve();
  await Promise.resolve();
  registryFailure.reject(new Error("TOP-SECRET Registry failure"));

  await assertUnavailable(inventory);
  assert.equal(gatewaySignal.aborted, false);
  assert.equal(modelSignal.aborted, false);
  gatewayResponse.resolve({ items: [] });
  modelResponse.resolve(jsonResponse({ data: [] }));
  const gateway = await gatewayOutcome;

  assert.equal(gateway.error, undefined);
  assert.deepEqual(gateway.value.models, []);
  assert.equal(
    commandInputs(calls.gateway, "ListGatewayTargetsCommand").length,
    1,
  );
  assert.equal(calls.fetch.length, 1);
});

test("a surviving shared waiter completion aborts an idle owned sibling", async () => {
  const gatewayResponse = deferred();
  const modelResponse = deferred();
  const registryResponse = deferred();
  const scheduled = [];
  const deadlineTimers = {
    setTimeout(callback, timeoutMs) {
      const handle = { callback, timeoutMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout() {},
  };
  let registrySignal;
  const { service } = createHarness({
    deadlineTimers,
    fetchImpl: async (_url, options) =>
      settleWithSignal(modelResponse.promise, options.signal),
    gatewaySend: async (command, _calls, options) => {
      assert.equal(
        command.constructor.name,
        "ListGatewayTargetsCommand",
      );
      return settleWithSignal(gatewayResponse.promise, options.abortSignal);
    },
    registrySend: async (_command, _calls, options) => {
      registrySignal = options.abortSignal;
      return settleWithSignal(registryResponse.promise, registrySignal);
    },
  });

  const inventory = service.inventory(ADMIN_SCOPE);
  await waitFor(
    () => Boolean(registrySignal && scheduled.length === 1),
    "Expected the inventory request and shared backend loads to start.",
  );
  const gateway = service.aiGateway(ADMIN_SCOPE);
  await waitFor(
    () => scheduled.length === 2,
    "Expected the later AI Gateway waiter to start.",
  );
  scheduled[0].callback();

  await assertUnavailable(inventory);
  assert.equal(registrySignal.aborted, false);
  gatewayResponse.resolve({ items: [] });
  modelResponse.resolve(jsonResponse({ data: [] }));
  assert.deepEqual((await gateway).models, []);
  await waitFor(
    () => registrySignal.aborted,
    "Expected the idle Registry sibling to abort after the last waiter settled.",
  );
});

test("the last timed-out waiter aborts and evicts shared backend work", {
  timeout: 1_000,
}, async () => {
  const gatewayResponse = deferred();
  const modelResponse = deferred();
  let firstGatewaySignal;
  let firstModelSignal;
  let gatewayCalls = 0;
  let modelCalls = 0;
  const { service } = createHarness({
    fetchImpl: async (_url, options) => {
      modelCalls += 1;
      if (modelCalls === 1) {
        firstModelSignal = options.signal;
        return settleWithSignal(modelResponse.promise, firstModelSignal);
      }
      return jsonResponse({ data: [] });
    },
    gatewaySend: async (command, _calls, options) => {
      assert.equal(
        command.constructor.name,
        "ListGatewayTargetsCommand",
      );
      gatewayCalls += 1;
      if (gatewayCalls === 1) {
        firstGatewaySignal = options.abortSignal;
        return settleWithSignal(
          gatewayResponse.promise,
          firstGatewaySignal,
        );
      }
      return { items: [] };
    },
    operationTimeoutMs: 120,
  });

  const first = service.aiGateway(ADMIN_SCOPE);
  await waitFor(
    () => Boolean(firstGatewaySignal && firstModelSignal),
    "Expected the first shared Gateway and model loads.",
  );
  await delay(40);
  const second = assertUnavailable(service.aiGateway(ADMIN_SCOPE));

  await assertUnavailable(first);
  assert.equal(firstGatewaySignal.aborted, false);
  assert.equal(firstModelSignal.aborted, false);
  await second;
  assert.equal(firstGatewaySignal.aborted, true);
  assert.equal(firstModelSignal.aborted, true);

  const retry = await service.aiGateway(ADMIN_SCOPE);
  assert.deepEqual(retry.models, []);
  assert.equal(gatewayCalls, 2);
  assert.equal(modelCalls, 2);
});

test("concurrent registry and AI Gateway reads share backend work", async () => {
  const { calls, service } = createHarness();

  await Promise.all([
    service.registry(ADMIN_SCOPE),
    service.aiGateway(ADMIN_SCOPE),
  ]);

  assert.equal(
    commandInputs(calls.gateway, "ListGatewayTargetsCommand").length,
    1,
  );
  assert.equal(calls.fetch.length, 1);
});

test("Registry list or detail failure becomes a stable unavailable error", async () => {
  for (const failingCommand of [
    "ListRegistryRecordsCommand",
    "GetRegistryRecordCommand",
  ]) {
    const fullRecord = skillRecord(
      CONFIG.sharedRegistryId,
      "secret-record",
      { domain: "shared" },
    );
    const { service } = createHarness({
      registrySend: async (command) => {
        if (command.constructor.name === failingCommand) {
          throw new Error("TOP-SECRET registry backend detail");
        }
        if (command.constructor.name === "ListRegistryRecordsCommand") {
          return { registryRecords: [summaryOf(fullRecord)] };
        }
        return fullRecord;
      },
    });

    await assertUnavailable(service.registry(ADMIN_SCOPE), undefined, "registry");
  }
});

test("backend-thrown service errors are normalized without secret leakage", async () => {
  const { service } = createHarness({
    registrySend: async () => {
      throw new ControlPlaneServiceError(
        "TOP-SECRET malicious injected detail",
        {
          code: "DOMAIN_NOT_ALLOWED",
          statusCode: 403,
          retryable: false,
        },
      );
    },
  });

  await assertUnavailable(service.registry(ADMIN_SCOPE), undefined, "registry");
});

test("Gateway target failure becomes a stable unavailable error", async () => {
  const { service } = createHarness({
    gatewaySend: async () => {
      throw new Error("TOP-SECRET gateway backend detail");
    },
  });

  await assertUnavailable(
    service.registry(ADMIN_SCOPE),
    undefined,
    "tools-gateway",
  );
});

test("model fetch failure becomes a stable unavailable error", async () => {
  const { service } = createHarness({
    fetchImpl: async () => {
      throw new Error("TOP-SECRET network detail");
    },
  });

  await assertUnavailable(
    service.registry(ADMIN_SCOPE),
    undefined,
    "model-gateway",
  );
});

test("non-2xx model response becomes a stable unavailable error", async () => {
  const { service } = createHarness({
    fetchImpl: async () => jsonResponse(
      { message: "TOP-SECRET upstream detail" },
      { ok: false, status: 502, statusText: "Bad Gateway" },
    ),
  });

  await assertUnavailable(
    service.registry(ADMIN_SCOPE),
    undefined,
    "model-gateway",
  );
});

test("malformed model responses become a stable unavailable error", async () => {
  for (const fetchImpl of [
    async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "{not-json",
    }),
    async () => jsonResponse({ data: "not-an-array" }),
    async () => jsonResponse({ data: [{ owned_by: "missing-id" }] }),
  ]) {
    const { service } = createHarness({ fetchImpl });
    await assertUnavailable(
      service.registry(ADMIN_SCOPE),
      undefined,
      "model-gateway",
    );
  }
});

test("domain state failure identifies only the safe domain-state component", async () => {
  const { service } = createHarness({
    domainState: {
      async listDomains() {
        throw new Error("TOP-SECRET domain state detail");
      },
      async getDomain() {
        return null;
      },
    },
  });

  await assertUnavailable(
    service.registry(ADMIN_SCOPE),
    undefined,
    "domain-state",
  );
});

test("service imports no filesystem, CLI, or fallback inventory modules", async () => {
  const source = await readFile(
    new URL("../lambda/control-plane/service.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /console\/registry-shape\.mjs/);
  for (const mapper of [
    "recordToVersion",
    "recordsToEntries",
    "gatewayTargetToMcpEntry",
  ]) {
    assert.match(source, new RegExp(`\\b${mapper}\\b`));
  }
  for (const forbidden of [
    "node:fs",
    "node:child_process",
    "registry-client.mjs",
    "agentcore-gateway.mjs",
    "gateway-models.mjs",
    "catalog.json",
    "ai-registry.json",
  ]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(".", "\\.")));
  }
});

test("package exposes the focused service command", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["test:control-plane-service"], "tsx --test test/control-plane-service.test.mjs");
});

test('Registry list SDK error retains only allowed stage and code through wrapping',async()=>{
 const {service}=createHarness({registrySend:async()=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE descriptor and credential'),{name:'ThrottlingException',credentials:{secret:'SYNTHETIC_PRIVATE'}})}});
 await assert.rejects(service.registry({role:'admin',allowedDomains:[],activeDomain:null}),error=>{assert.equal(error.code,'CONTROL_PLANE_UNAVAILABLE');assert.equal(error.component,'registry');assert.deepEqual(error.diagnostic,{stage:'registry-list',errorCode:'THROTTLED'});assert.doesNotMatch(JSON.stringify(error),/SYNTHETIC_PRIVATE|credentials/);return true});
});

test('Registry model approval follows active platform policies, not hardcoded metadata', async () => {
  const ids = ['gateway/model-a', 'gateway/model-b', 'gateway/unconfigured', 'gateway/pending'];
  const policy = (modelId, revision = 1) => ({modelId, allowedDomains: ['operations'], requestableDomains: [],
    limits: {requestsPerMinute: 60, tokensPerMinute: 120000, connectionsPerSecond: 4}, revision,
    applicationStatus: 'ACTIVE', rateLimit: {id: 'platform-limits', status: 'ACTIVE', reason: null, reconciledAt: FIXED_NOW.toISOString()},
    updatedBySubject: 'admin-sub', updatedAt: FIXED_NOW.toISOString()});
  let approvedB = true; const cursors = [];
  const {service} = createHarness({
    catalogMetadata: {models: [{id: ids[2], approved: true}]},
    modelPolicyState: {async listModelPolicies({cursor}) {
      cursors.push(cursor);
      return cursor ? {items: approvedB ? [policy(ids[1], 3)] : [], cursor: null}
        : {items: [policy(ids[0]), {...policy(ids[3]), applicationStatus: 'PENDING'}], cursor: 'next'};
    }},
    fetchImpl: async () => jsonResponse({data: ids.map(id => ({id}))}),
  });
  const first = await service.registry(ADMIN_SCOPE);
  const models = first.entries.filter(e => e.type === 'Model');
  // Governed catalog: only policy-approved models reach the Registry.
  // Undecided discovery (unconfigured/pending policies) stays on the Gateway.
  assert.deepEqual(models.map(e => e.id), [ids[0], ids[1]]);
  assert.deepEqual(models.map(e => e.versions[0].status), ['APPROVED','APPROVED']);
  assert.equal(models[1].versions[0].content.platformApproval.revision, 3);
  assert.deepEqual(cursors, [undefined, 'next']);
  const gateway = await service.aiGateway(ADMIN_SCOPE);
  assert.deepEqual(gateway.models.map(m => m.id).sort(), [...ids].sort());
  assert.equal(gateway.models.find(m => m.id === ids[2]).versions[0].content.platformApproval.status, 'POLICY_REQUIRED');
  approvedB = false;
  const refreshed = await service.registry(ADMIN_SCOPE);
  assert.equal(refreshed.entries.some(e => e.id === ids[1]), false);
  const {foundationCatalog} = await import('../../../console/public/domain-foundation-catalog.mjs');
  assert.equal(foundationCatalog(first).models.length, 2);
  assert.deepEqual(foundationCatalog(first).modelAvailability, {discovered: 2, selectable: 2, runtimePolicyConfigured: 2, policyRequired: 0});
});

test('Registry does not present a failed model-policy read as an empty selectable catalog', async () => {
  const {service} = createHarness({modelPolicyState: {async listModelPolicies(){throw new Error('denied');}},
    fetchImpl: async () => jsonResponse({data: [{id: 'gateway/model-a'}]})});
  await assert.rejects(() => service.registry(ADMIN_SCOPE), /temporarily unavailable/);
});

test('display detail reuse still lists fresh state, invalidates changed versions and never serves strict reads', async () => {
  let record = agentRecord(CONFIG.domainRegistryIds.operations, 'cached-agent', 'operations');
  const {service,calls} = createHarness({registrySend: async command => {
    if(command.constructor.name==='ListRegistryRecordsCommand')return {registryRecords:command.input.registryId===record.registryId?[summaryOf(record)]:[]};
    return structuredClone(record);
  }});
  await service.registry(OPERATIONS_SCOPE);
  await service.registry(OPERATIONS_SCOPE);
  assert.equal(commandInputs(calls.registry,'GetRegistryRecordCommand').length,1);
  assert.equal(commandInputs(calls.registry,'ListRegistryRecordsCommand').length,4);
  await service.registryOnly(OPERATIONS_SCOPE);
  assert.equal(commandInputs(calls.registry,'GetRegistryRecordCommand').length,2);
  record={...record,status:'REJECTED',updatedAt:new Date('2026-08-22T00:00:00Z')};
  const changed=await service.registry(OPERATIONS_SCOPE);
  assert.equal(commandInputs(calls.registry,'GetRegistryRecordCommand').length,3);
  assert.equal(changed.entries[0].versions[0].status,'REJECTED');
});
