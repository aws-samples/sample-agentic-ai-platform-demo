import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  ListTagsForResourceCommand,
  SubmitRegistryRecordForApprovalCommand,
  TagResourceCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  createPlatformAgentRegistrySeeder,
} from "../lambda/platform-agent-registry/seed.mjs";

const REGION = "us-west-2";
const ACCOUNT_ID = "111122223333";
const REGISTRY_ID = "PlatformReg1234";
const REGISTRY_ARN =
  `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/${REGISTRY_ID}`;
const RUNTIME_ARN =
  `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
  + "runtime/AgenticPlatformRuntime-ABC1234567";
const ENDPOINT_NAME = "Production";
const ENDPOINT_ARN = `${RUNTIME_ARN}/runtime-endpoint/${ENDPOINT_NAME}`;
const MODEL_ID = "bedrock-claude/anthropic.claude-sonnet-5";
const RECORD_ID = "AgentDesignAssistant123";
const RECORD_ARN = `${REGISTRY_ARN}/record/${RECORD_ID}`;

function properties(overrides = {}) {
  return {
    PlatformRegistryId: REGISTRY_ID,
    PlatformRegistryArn: REGISTRY_ARN,
    Region: REGION,
    AccountId: ACCOUNT_ID,
    RuntimeArn: RUNTIME_ARN,
    ProductionEndpointArn: ENDPOINT_ARN,
    ProductionEndpointName: ENDPOINT_NAME,
    GatewayModelId: MODEL_ID,
    ...overrides,
  };
}

function event(requestType = "Create", overrides = {}) {
  return {
    RequestType: requestType,
    ResourceProperties: properties(),
    ...overrides,
  };
}

function expectedDescriptor() {
  const invocationUrl =
    `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/`
    + `${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=`
    + encodeURIComponent(ENDPOINT_NAME);
  return {
    schemaVersion: 1,
    resourceKind: "agent",
    name: "Agent Design Assistant",
    description:
      "Deployment-owned platform AgentCore Runtime assistant for Agent design discovery.",
    url: invocationUrl,
    version: "1.0.0",
    specification: {
      runtimeArn: RUNTIME_ARN,
      endpointArn: ENDPOINT_ARN,
      endpointName: ENDPOINT_NAME,
      modelId: MODEL_ID,
      projectId: "platform-foundation",
      invocationUrl,
    },
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
  };
}

function fullRecord(status = "APPROVED", overrides = {}) {
  return {
    registryArn: REGISTRY_ARN,
    recordArn: RECORD_ARN,
    recordId: RECORD_ID,
    name: "agent_design_assistant",
    displayName: "Agent Design Assistant",
    description:
      "Deployment-owned platform AgentCore Runtime assistant for Agent design discovery.",
    recordType: "AGENT",
    descriptors: {
      custom: {
        data: JSON.stringify(expectedDescriptor()),
      },
    },
    recordVersion: "1.0.0-platform-descriptor.1",
    status,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    ...overrides,
  };
}

function summary(overrides = {}) {
  const record = fullRecord();
  return {
    registryArn: record.registryArn,
    recordArn: record.recordArn,
    recordId: record.recordId,
    name: record.name,
    displayName: record.displayName,
    description: record.description,
    recordType: record.recordType,
    recordVersion: record.recordVersion,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...overrides,
  };
}

function commandInputs(calls, Command) {
  return calls
    .filter((command) => command instanceof Command)
    .map((command) => command.input);
}

test("creates one governed platform Agent Design Assistant and reconciles it to APPROVED", async () => {
  const calls = [];
  const sleeps = [];
  const statuses = [
    fullRecord("CREATING"),
    fullRecord("DRAFT"),
    fullRecord("PENDING_APPROVAL"),
    fullRecord("APPROVED"),
  ];
  const registryClient = {
    async send(command) {
      calls.push(command);
      if (command instanceof ListRegistryRecordsCommand) {
        return { registryRecords: [] };
      }
      if (command instanceof CreateRegistryRecordCommand) {
        return { recordArn: RECORD_ARN, status: "CREATING" };
      }
      if (command instanceof GetRegistryRecordCommand) {
        return statuses.shift();
      }
      if (command instanceof SubmitRegistryRecordForApprovalCommand) return {};
      if (command instanceof UpdateRegistryRecordStatusCommand) return {};
      if (command instanceof ListTagsForResourceCommand) return { tags: {} };
      if (command instanceof TagResourceCommand) return {};
      throw new Error(`Unexpected ${command.constructor.name}.`);
    },
  };
  const seeder = createPlatformAgentRegistrySeeder({
    registryClient,
    pollDelayMs: 7,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  const result = await seeder.reconcile(event());

  assert.deepEqual(result, {
    PhysicalResourceId: `platform-agent-design-assistant:${REGISTRY_ID}`,
    Data: {
      RecordArn: RECORD_ARN,
      RecordId: RECORD_ID,
      Status: "APPROVED",
    },
  });
  assert.deepEqual(commandInputs(calls, ListRegistryRecordsCommand), [{
    registryId: REGISTRY_ID,
    maxResults: 10,
    filters: [{ name: "name", values: ["agent_design_assistant"] }],
  }]);
  const [create] = commandInputs(calls, CreateRegistryRecordCommand);
  assert.equal(create.registryId, REGISTRY_ID);
  assert.equal(create.name, "agent_design_assistant");
  assert.equal(create.displayName, "Agent Design Assistant");
  assert.equal(create.recordType, "AGENT");
  assert.equal(create.recordVersion, "1.0.0-platform-descriptor.1");
  assert.deepEqual(create.tags, {
    "auto-delete": "no",
    project: "agentic-ai-platform-demo",
    managedBy: "cdk",
  });
  assert.deepEqual(
    JSON.parse(create.descriptors.custom.data),
    expectedDescriptor(),
  );
  assert.equal(create.descriptors.a2aAgentCard, undefined);
  assert.deepEqual(commandInputs(calls, SubmitRegistryRecordForApprovalCommand), [{
    registryId: REGISTRY_ID,
    recordId: RECORD_ID,
  }]);
  assert.deepEqual(commandInputs(calls, UpdateRegistryRecordStatusCommand), [{
    registryId: REGISTRY_ID,
    recordId: RECORD_ID,
    status: "APPROVED",
    statusReason:
      "Approved by deployment-owned platform Agent Design Assistant seeder.",
  }]);
  assert.deepEqual(commandInputs(calls, TagResourceCommand), [{
    resourceArn: RECORD_ARN,
    tags: {
      "auto-delete": "no",
      project: "agentic-ai-platform-demo",
      managedBy: "cdk",
    },
  }]);
  assert.deepEqual(sleeps, [7, 7, 7]);
});

test("accepts only an exact existing approved record and reconciles missing required tags", async () => {
  const calls = [];
  const registryClient = {
    async send(command) {
      calls.push(command);
      if (command instanceof ListRegistryRecordsCommand) {
        return { registryRecords: [summary()] };
      }
      if (command instanceof GetRegistryRecordCommand) return fullRecord();
      if (command instanceof ListTagsForResourceCommand) {
        return { tags: { project: "other-project", unrelated: "kept" } };
      }
      if (command instanceof TagResourceCommand) return {};
      throw new Error(`Unexpected ${command.constructor.name}.`);
    },
  };

  const result = await createPlatformAgentRegistrySeeder({
    registryClient,
  }).reconcile(event("Update", {
    PhysicalResourceId: `platform-agent-design-assistant:${REGISTRY_ID}`,
    OldResourceProperties: properties(),
  }));

  assert.equal(result.Data.Status, "APPROVED");
  assert.equal(commandInputs(calls, CreateRegistryRecordCommand).length, 0);
  assert.equal(
    commandInputs(calls, SubmitRegistryRecordForApprovalCommand).length,
    0,
  );
  assert.equal(
    commandInputs(calls, UpdateRegistryRecordStatusCommand).length,
    0,
  );
  assert.deepEqual(commandInputs(calls, TagResourceCommand), [{
    resourceArn: RECORD_ARN,
    tags: {
      "auto-delete": "no",
      project: "agentic-ai-platform-demo",
      managedBy: "cdk",
    },
  }]);
});

test("fails closed when an existing immutable governed descriptor differs", async () => {
  const registryClient = {
    async send(command) {
      if (command instanceof ListRegistryRecordsCommand) {
        return { registryRecords: [summary()] };
      }
      if (command instanceof GetRegistryRecordCommand) {
        const descriptor = expectedDescriptor();
        descriptor.specification.modelId = "other-model";
        return fullRecord("APPROVED", {
          descriptors: {
            a2aAgentCard: { data: JSON.stringify(descriptor) },
          },
        });
      }
      throw new Error(`Unexpected ${command.constructor.name}.`);
    },
  };

  await assert.rejects(
    createPlatformAgentRegistrySeeder({ registryClient }).reconcile(event()),
    /immutable.*descriptor/i,
  );
});

test("fails closed on malformed binding properties before Registry access", async () => {
  let calls = 0;
  const registryClient = {
    async send() {
      calls += 1;
      throw new Error("Registry must not be called.");
    },
  };
  const seeder = createPlatformAgentRegistrySeeder({ registryClient });

  for (const invalidProperties of [
    properties({ PlatformRegistryArn: `${REGISTRY_ARN}-other` }),
    properties({ ProductionEndpointArn: `${RUNTIME_ARN}/runtime-endpoint/Sandbox` }),
    properties({ GatewayModelId: "https://example.invalid/model" }),
  ]) {
    await assert.rejects(
      seeder.reconcile(event("Create", { ResourceProperties: invalidProperties })),
      /properties are invalid/i,
    );
  }
  assert.equal(calls, 0);
});

test("retains the approved platform record on Delete without Registry access", async () => {
  let calls = 0;
  const result = await createPlatformAgentRegistrySeeder({
    registryClient: {
      async send() {
        calls += 1;
        throw new Error("Registry must not be called.");
      },
    },
  }).reconcile(event("Delete", {
    PhysicalResourceId: `platform-agent-design-assistant:${REGISTRY_ID}`,
    ResourceProperties: { malformed: "ignored on delete" },
  }));

  assert.deepEqual(result, {
    PhysicalResourceId: `platform-agent-design-assistant:${REGISTRY_ID}`,
    Data: {
      Retained: true,
    },
  });
  assert.equal(calls, 0);
});

test("fails closed when registry listing or polling exceeds its bounded limits", async () => {
  const listed = [];
  const listSeeder = createPlatformAgentRegistrySeeder({
    maxListPages: 2,
    registryClient: {
      async send(command) {
        listed.push(command);
        assert.ok(command instanceof ListRegistryRecordsCommand);
        return {
          registryRecords: [],
          nextToken: `page-${listed.length}`,
        };
      },
    },
  });
  await assert.rejects(
    listSeeder.reconcile(event()),
    /listing exceeded its bounded limit/i,
  );

  const polled = [];
  const pollSeeder = createPlatformAgentRegistrySeeder({
    maxPollAttempts: 2,
    sleep: async () => {},
    registryClient: {
      async send(command) {
        polled.push(command);
        if (command instanceof ListRegistryRecordsCommand) {
          return { registryRecords: [] };
        }
        if (command instanceof CreateRegistryRecordCommand) {
          return { recordArn: RECORD_ARN, status: "CREATING" };
        }
        if (command instanceof GetRegistryRecordCommand) {
          return fullRecord("CREATING");
        }
        throw new Error(`Unexpected ${command.constructor.name}.`);
      },
    },
  });
  await assert.rejects(
    pollSeeder.reconcile(event()),
    /did not reach the expected state/i,
  );
  assert.equal(
    commandInputs(polled, GetRegistryRecordCommand).length,
    2,
  );
});
