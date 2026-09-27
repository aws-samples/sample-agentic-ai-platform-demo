import assert from "node:assert/strict";
import test from "node:test";
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  handleBaselineProjectSeed,
  reconcileBaselineProject,
} from "../lambda/workspace/seed.mjs";

const NOW = "2026-08-26T16:45:00.000Z";
const TABLE_NAME = "AgenticPlatform-Web-PlatformStateTable-EXAMPLE";

function baselineProject() {
  return {
    domainId: "platform",
    id: "it-helpdesk",
    name: "IT Helpdesk",
    description:
      "Platform-owned workspace for IT helpdesk agent and real deployed runtime.",
    ownerSubject: "deployment:baseline",
    memberSubjects: [],
    status: "ACTIVE",
    createdBySubject: "deployment:baseline",
  };
}

function baselineAgent() {
  return {
    domainId: "platform",
    projectId: "it-helpdesk",
    id: "it-helpdesk-agent",
    name: "IT Helpdesk Agent",
    description: "Answers internal IT questions.",
    ownerSubject: "deployment:baseline",
    modelId: "bedrock-mantle/anthropic.claude-haiku-4-5",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: [],
    memoryIds: ["ithelpdesk_ithelpdeskMemory-G5maQ4GNK4"],
    knowledgeBaseIds: ["QMBGUOZPGL"],
    buildConfig: null,
    status: "DRAFT",
    createdBySubject: "deployment:baseline",
    lastTestStatus: null,
    lastTestedAt: null,
    lastTestedBySubject: null,
    lastTestModelId: null,
    lastTestInputTokens: null,
    lastTestOutputTokens: null,
    lastTestRequestId: null,
    lastTestEvidenceHash: null,
    lastTestOutput: null,
  };
}

function cloudFormationAgent() {
  return Object.fromEntries(
    Object.entries(baselineAgent()).filter(([, value]) => value !== null),
  );
}

function event(requestType = "Create", overrides = {}) {
  return {
    RequestType: requestType,
    RequestId: "cloudformation-request-1234",
    ResourceType: "Custom::PlatformBaselineProject",
    ResourceProperties: {
      TableName: TABLE_NAME,
      Project: baselineProject(),
    },
    ...overrides,
  };
}

function eventWithAgent(requestType = "Create", overrides = {}) {
  return event(requestType, {
    ResourceProperties: {
      TableName: TABLE_NAME,
      Project: baselineProject(),
      Agent: cloudFormationAgent(),
    },
    ...overrides,
  });
}

function lambdaContext(remainingTimeInMillis = 120_000) {
  let remainingTimeReads = 0;
  return {
    logStreamName: "seed-log-stream",
    get remainingTimeReads() {
      return remainingTimeReads;
    },
    getRemainingTimeInMillis() {
      remainingTimeReads += 1;
      return remainingTimeInMillis;
    },
  };
}

function recordingDynamo(responses) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      if (responses.length === 0) {
        throw new Error("Unexpected DynamoDB command.");
      }
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function projectItem(overrides = {}) {
  const project = {
    ...baselineProject(),
    createdAt: NOW,
    ...overrides,
  };
  return {
    pk: { S: `PROJECT#${project.domainId}` },
    sk: { S: `PROJECT#${project.id}` },
    entityType: { S: "PROJECT" },
    domainId: { S: project.domainId },
    id: { S: project.id },
    name: { S: project.name },
    description: { S: project.description },
    ownerSubject: { S: project.ownerSubject },
    memberSubjects: {
      L: project.memberSubjects.map((subject) => ({ S: subject })),
    },
    status: { S: project.status },
    createdBySubject: { S: project.createdBySubject },
    createdAt: { S: project.createdAt },
  };
}

function agentItem(overrides = {}) {
  const agent = {
    ...baselineAgent(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  const nullable = (value) =>
    value === null ? { NULL: true } : { S: value };
  const nullableInteger = (value) =>
    value === null ? { NULL: true } : { N: String(value) };
  const stringList = (values) => ({
    L: values.map((value) => ({ S: value })),
  });
  return {
    pk: { S: `AGENT#${agent.domainId}#${agent.projectId}` },
    sk: { S: `AGENT#${agent.id}` },
    entityType: { S: "AGENT" },
    domainId: { S: agent.domainId },
    projectId: { S: agent.projectId },
    id: { S: agent.id },
    name: { S: agent.name },
    description: { S: agent.description },
    ownerSubject: { S: agent.ownerSubject },
    modelId: { S: agent.modelId },
    toolIds: stringList(agent.toolIds),
    mcpServerIds: stringList(agent.mcpServerIds),
    skillIds: stringList(agent.skillIds),
    blueprintIds: stringList(agent.blueprintIds),
    memoryIds: stringList(agent.memoryIds),
    knowledgeBaseIds: stringList(agent.knowledgeBaseIds),
    buildConfig: { NULL: true },
    status: { S: agent.status },
    createdBySubject: { S: agent.createdBySubject },
    createdAt: { S: agent.createdAt },
    updatedAt: { S: agent.updatedAt },
    lastTestStatus: nullable(agent.lastTestStatus),
    lastTestedAt: nullable(agent.lastTestedAt),
    lastTestedBySubject: nullable(agent.lastTestedBySubject),
    lastTestModelId: nullable(agent.lastTestModelId),
    lastTestInputTokens: nullableInteger(agent.lastTestInputTokens),
    lastTestOutputTokens: nullableInteger(agent.lastTestOutputTokens),
    lastTestRequestId: nullable(agent.lastTestRequestId),
    lastTestEvidenceHash: nullable(agent.lastTestEvidenceHash),
    lastTestOutput: nullable(agent.lastTestOutput),
  };
}

test("Create conditionally seeds the generic platform starter project", async () => {
  const dynamo = recordingDynamo([{}, {}]);

  const result = await reconcileBaselineProject(
    event(),
    { dynamo, now: () => NOW },
  );

  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
    Data: {
      CreatedCount: 1,
      ExistingCount: 0,
    },
  });
  assert.deepEqual(
    dynamo.commands.map((command) => command.constructor),
    [GetItemCommand, PutItemCommand],
  );
  assert.deepEqual(dynamo.commands[1].input.Item, projectItem());
  assert.equal(
    dynamo.commands[1].input.ConditionExpression,
    "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
  );
});

test("Create conditionally seeds the starter project and its draft agent", async () => {
  const dynamo = recordingDynamo([{}, {}, {}, {}]);

  const result = await reconcileBaselineProject(
    eventWithAgent(),
    { dynamo, now: () => NOW },
  );

  assert.deepEqual(result.Data, {
    CreatedCount: 2,
    ExistingCount: 0,
  });
  assert.deepEqual(
    dynamo.commands.map((command) => command.constructor),
    [GetItemCommand, PutItemCommand, GetItemCommand, PutItemCommand],
  );
  assert.deepEqual(dynamo.commands[3].input.Item, agentItem());
});

function bindingUpdate() {
  return eventWithAgent("Update", {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
    OldResourceProperties: {
      TableName: TABLE_NAME,
      Project: baselineProject(),
      Agent: { ...cloudFormationAgent(), memoryIds: [], knowledgeBaseIds: [] },
    },
  });
}

test("Update binds existing untouched draft resources with a conditional write", async () => {
  const before = agentItem({
    name: "Operator label",
    memoryIds: [],
    knowledgeBaseIds: [],
  });
  const dynamo = recordingDynamo([{ Item: projectItem() }, { Item: before }, {}]);
  await reconcileBaselineProject(bindingUpdate(), { dynamo, now: () => NOW });
  const write = dynamo.commands[2];
  assert.ok(write instanceof PutItemCommand);
  assert.deepEqual(write.input.Item.memoryIds, agentItem().memoryIds);
  assert.deepEqual(write.input.Item.knowledgeBaseIds, agentItem().knowledgeBaseIds);
  assert.equal(write.input.Item.name.S, "Operator label");
  for (const [key, value] of Object.entries(before)) {
    const alias = Object.entries(write.input.ExpressionAttributeNames)
      .find(([, name]) => name === key)[0];
    const index = alias.slice(2);
    assert.deepEqual(write.input.ExpressionAttributeValues[`:v${index}`], value);
    assert.ok(write.input.ConditionExpression.includes(`${alias} = :v${index}`));
  }
});

test("Update preserves user resource edits and non-draft agents", async () => {
  for (const overrides of [
    { memoryIds: ["operator-memory"], knowledgeBaseIds: [] },
    { memoryIds: [], knowledgeBaseIds: ["OPERATOR01"] },
    { memoryIds: [], knowledgeBaseIds: [], status: "READY_FOR_TEST" },
    // A repeated CloudFormation event has already converged.
    {},
  ]) {
    const dynamo = recordingDynamo([
      { Item: projectItem() }, { Item: agentItem(overrides) },
    ]);
    await reconcileBaselineProject(bindingUpdate(), { dynamo, now: () => NOW });
    assert.equal(dynamo.commands.length, 2);
  }
});

test("Update refuses to overwrite a concurrent agent edit", async () => {
  const conflict = new ConditionalCheckFailedException({
    $metadata: {}, message: "concurrent edit",
  });
  const dynamo = recordingDynamo([
    { Item: projectItem() },
    { Item: agentItem({ memoryIds: [], knowledgeBaseIds: [] }) },
    conflict,
  ]);
  await assert.rejects(
    reconcileBaselineProject(bindingUpdate(), { dynamo, now: () => NOW }),
    (error) => error === conflict,
  );
});

test("Create preserves an existing deployment-owned starter project", async () => {
  const dynamo = recordingDynamo([{
    Item: projectItem({
      name: "Operator label",
      description: "Operator description",
      memberSubjects: ["operator-subject"],
    }),
  }]);

  const result = await reconcileBaselineProject(
    event(),
    { dynamo, now: () => NOW },
  );

  assert.deepEqual(result.Data, {
    CreatedCount: 0,
    ExistingCount: 1,
  });
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof GetItemCommand);
});

test("a concurrent matching create converges without overwriting", async () => {
  const conditional = new ConditionalCheckFailedException({
    $metadata: {},
    message: "already exists",
  });
  const dynamo = recordingDynamo([
    {},
    conditional,
    { Item: projectItem() },
  ]);

  const result = await reconcileBaselineProject(
    event(),
    { dynamo, now: () => NOW },
  );

  assert.deepEqual(result.Data, {
    CreatedCount: 0,
    ExistingCount: 1,
  });
  assert.deepEqual(
    dynamo.commands.map((command) => command.constructor),
    [GetItemCommand, PutItemCommand, GetItemCommand],
  );
});

test("conflicting identity, malformed input, and deletion fail closed", async () => {
  const conflictDynamo = recordingDynamo([{
    Item: projectItem({ ownerSubject: "another-owner" }),
  }]);
  await assert.rejects(
    reconcileBaselineProject(
      event(),
      { dynamo: conflictDynamo, now: () => NOW },
    ),
    (error) => error?.code === "BASELINE_PROJECT_CONFLICT",
  );

  for (const malformed of [
    { ...baselineProject(), domainId: "operations" },
    { ...baselineProject(), id: "invalid project" },
    { ...baselineProject(), ownerSubject: "person-specific-owner" },
    { ...baselineProject(), memberSubjects: ["unexpected-member"] },
  ]) {
    const dynamo = recordingDynamo([]);
    await assert.rejects(
      reconcileBaselineProject(
        event("Create", {
          ResourceProperties: {
            TableName: TABLE_NAME,
            Project: malformed,
          },
        }),
        { dynamo, now: () => NOW },
      ),
      (error) => error?.code === "INVALID_BASELINE_PROJECT",
    );
    assert.equal(dynamo.commands.length, 0);
  }

  for (const malformedAgent of [
    { ...baselineAgent(), projectId: "other-project" },
    { ...baselineAgent(), ownerSubject: "person-specific-owner" },
    { ...baselineAgent(), status: "READY_FOR_TEST" },
  ]) {
    const dynamo = recordingDynamo([]);
    await assert.rejects(
      reconcileBaselineProject(
        eventWithAgent("Create", {
          ResourceProperties: {
            TableName: TABLE_NAME,
            Project: baselineProject(),
            Agent: malformedAgent,
          },
        }),
        { dynamo, now: () => NOW },
      ),
      (error) => error?.code === "INVALID_BASELINE_PROJECT",
    );
    assert.equal(dynamo.commands.length, 0);
  }

  const deleteDynamo = recordingDynamo([]);
  assert.deepEqual(
    await reconcileBaselineProject(
      event("Delete", {
        PhysicalResourceId:
          `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
        ResourceProperties: { malformed: "ignored on delete" },
      }),
      { dynamo: deleteDynamo, now: () => NOW },
    ),
    {
      PhysicalResourceId:
        `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
    },
  );
  assert.equal(deleteDynamo.commands.length, 0);
});

test("successful handler retries response delivery without replaying the seed", async () => {
  const dynamo = recordingDynamo([{}, {}]);
  const responses = [];
  const sleeps = [];

  const result = await handleBaselineProjectSeed(
    event(),
    lambdaContext(),
    dynamo,
    {
      now: () => NOW,
      responseRetryDelayMs: 17,
      sendResponse: async (...args) => {
        responses.push(args);
        if (responses.length === 1) {
          throw new Error("transient response upload failure");
        }
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  assert.deepEqual(result.Data, {
    CreatedCount: 1,
    ExistingCount: 0,
  });
  assert.deepEqual(
    dynamo.commands.map((command) => command.constructor),
    [GetItemCommand, PutItemCommand],
  );
  assert.equal(responses.length, 2);
  assert.equal(responses[0][2], "SUCCESS");
  assert.equal(responses[1][2], "SUCCESS");
  assert.deepEqual(sleeps, [17]);
});

test("operation failure returns a sanitized FAILED response", async () => {
  const responses = [];
  const logs = [];

  const result = await handleBaselineProjectSeed(
    event("Create", {
      ResourceProperties: {
        TableName: TABLE_NAME,
        Project: {
          ...baselineProject(),
          ownerSubject: "unexpected-owner",
        },
      },
    }),
    lambdaContext(),
    recordingDynamo([]),
    {
      logError: (message) => logs.push(message),
      now: () => NOW,
      sendResponse: async (...args) => responses.push(args),
    },
  );

  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0][2], "FAILED");
  assert.equal(
    responses[0][4],
    "Baseline platform project seed operation failed.",
  );
  assert.deepEqual(logs, [
    "Baseline platform project seed operation failed.",
  ]);
});

test("handler fails closed when CloudFormation cannot receive the result", async () => {
  const responses = [];
  await assert.rejects(
    handleBaselineProjectSeed(
      event(),
      lambdaContext(),
      recordingDynamo([{}, {}]),
      {
        now: () => NOW,
        responseAttempts: 2,
        logError: () => {},
        sendResponse: async (...args) => {
          responses.push(args);
          throw new Error("response upload failed");
        },
        sleep: async () => {},
      },
    ),
    /Baseline platform project seed response delivery failed\./,
  );
  assert.deepEqual(responses.map((call) => call[2]), [
    "SUCCESS",
    "SUCCESS",
    "FAILED",
    "FAILED",
  ]);
});

test("exhausted SUCCESS delivery sends a sanitized terminal FAILED response", async () => {
  const responses = [];

  const result = await handleBaselineProjectSeed(
    event(),
    lambdaContext(),
    recordingDynamo([{}, {}]),
    {
      now: () => NOW,
      responseAttempts: 2,
      sendResponse: async (...args) => {
        responses.push(args);
        if (args[2] === "SUCCESS") {
          throw new Error("response upload failed");
        }
      },
      sleep: async () => {},
    },
  );

  assert.deepEqual(responses.map((call) => call[2]), [
    "SUCCESS",
    "SUCCESS",
    "FAILED",
  ]);
  assert.equal(
    responses[2][4],
    "Baseline platform project seed response delivery failed.",
  );
  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
  });
});

test("operation failure retries FAILED delivery without replaying DynamoDB", async () => {
  const rawFailure = new Error("raw operation failure");
  const dynamo = recordingDynamo([rawFailure]);
  const responses = [];

  const result = await handleBaselineProjectSeed(
    event(),
    lambdaContext(),
    dynamo,
    {
      now: () => NOW,
      responseAttempts: 3,
      sendResponse: async (...args) => {
        responses.push(args);
        if (responses.length < 3) {
          throw new Error("response upload failed");
        }
      },
      sleep: async () => {},
      logError: () => {},
    },
  );

  assert.equal(dynamo.commands.length, 1);
  assert.deepEqual(responses.map((call) => call[2]), [
    "FAILED",
    "FAILED",
    "FAILED",
  ]);
  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
  });
});

test("Update preserves or replaces physical identity only after validation", async () => {
  const oldTableName = "AgenticPlatform-Web-OldStateTable";
  const newTableName = "AgenticPlatform-Web-NewStateTable";
  const oldPhysicalId =
    `platform-baseline-project:${oldTableName}:platform:it-helpdesk`;
  const oldProperties = {
    TableName: oldTableName,
    Project: baselineProject(),
  };

  const sameTable = recordingDynamo([{ Item: projectItem() }]);
  assert.equal(
    (
      await reconcileBaselineProject(
        event("Update", {
          PhysicalResourceId:
            `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
          OldResourceProperties: {
            TableName: TABLE_NAME,
            Project: baselineProject(),
          },
        }),
        { dynamo: sameTable, now: () => NOW },
      )
    ).PhysicalResourceId,
    `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
  );

  const replacement = recordingDynamo([{}, {}]);
  const replacementResult = await reconcileBaselineProject(
    event("Update", {
      PhysicalResourceId: oldPhysicalId,
      OldResourceProperties: oldProperties,
      ResourceProperties: {
        TableName: newTableName,
        Project: baselineProject(),
      },
    }),
    { dynamo: replacement, now: () => NOW },
  );
  assert.equal(
    replacementResult.PhysicalResourceId,
    `platform-baseline-project:${newTableName}:platform:it-helpdesk`,
  );
  assert.deepEqual(
    replacement.commands.map((command) => command.input.TableName),
    [newTableName, newTableName],
  );

  const malformed = recordingDynamo([]);
  await assert.rejects(
    reconcileBaselineProject(
      event("Update", {
        PhysicalResourceId:
          "platform-baseline-project:wrong-table:platform:it-helpdesk",
        OldResourceProperties: oldProperties,
        ResourceProperties: {
          TableName: newTableName,
          Project: baselineProject(),
        },
      }),
      { dynamo: malformed, now: () => NOW },
    ),
    (error) => error?.code === "INVALID_BASELINE_PROJECT",
  );
  assert.equal(malformed.commands.length, 0);
});

test("Update operation failure reports the original physical identity", async () => {
  const oldTableName = "AgenticPlatform-Web-OldStateTable";
  const newTableName = "AgenticPlatform-Web-NewStateTable";
  const oldPhysicalId =
    `platform-baseline-project:${oldTableName}:platform:it-helpdesk`;
  const responses = [];

  const result = await handleBaselineProjectSeed(
    event("Update", {
      PhysicalResourceId: oldPhysicalId,
      OldResourceProperties: {
        TableName: oldTableName,
        Project: baselineProject(),
      },
      ResourceProperties: {
        TableName: newTableName,
        Project: baselineProject(),
      },
    }),
    lambdaContext(),
    recordingDynamo([new Error("raw operation failure")]),
    {
      now: () => NOW,
      sendResponse: async (...args) => responses.push(args),
      logError: () => {},
    },
  );

  assert.deepEqual(result, { PhysicalResourceId: oldPhysicalId });
  assert.deepEqual(responses.map((call) => call[2]), ["FAILED"]);
  assert.equal(responses[0][3].PhysicalResourceId, oldPhysicalId);
});

test("access retries preserve the terminal response reserve", async () => {
  let currentTimeMs = 1_000;
  const context = lambdaContext(31_000);
  const denied = () => Object.assign(
    new Error("not yet authorized"),
    { name: "AccessDeniedException" },
  );
  const dynamo = recordingDynamo(Array.from(
    { length: 12 },
    denied,
  ));
  const responses = [];
  const sleeps = [];

  const result = await handleBaselineProjectSeed(
    event(),
    context,
    dynamo,
    {
      clock: () => currentTimeMs,
      logError: () => {},
      now: () => NOW,
      sendResponse: async (...args) => {
        responses.push({
          args,
          attemptedAtMs: currentTimeMs,
        });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        currentTimeMs += milliseconds;
      },
    },
  );

  assert.equal(context.remainingTimeReads, 1);
  assert.equal(dynamo.commands.length, 4);
  assert.deepEqual(sleeps, [5_000, 5_000, 5_000]);
  assert.deepEqual(responses.map(({ args }) => args[2]), ["FAILED"]);
  assert.equal(responses[0].attemptedAtMs, 16_000);
  assert.ok(32_000 - responses[0].attemptedAtMs >= 11_000);
  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
  });
});

test("Update replacement terminal failure keeps the original physical identity", async () => {
  const oldTableName = "AgenticPlatform-Web-OldStateTable";
  const newTableName = "AgenticPlatform-Web-NewStateTable";
  const oldPhysicalId =
    `platform-baseline-project:${oldTableName}:platform:it-helpdesk`;
  let currentTimeMs = 2_000;
  const context = lambdaContext(45_000);
  const dynamo = recordingDynamo([{}, {}]);
  const responses = [];

  const result = await handleBaselineProjectSeed(
    event("Update", {
      PhysicalResourceId: oldPhysicalId,
      OldResourceProperties: {
        TableName: oldTableName,
        Project: baselineProject(),
      },
      ResourceProperties: {
        TableName: newTableName,
        Project: baselineProject(),
      },
    }),
    context,
    dynamo,
    {
      clock: () => currentTimeMs,
      logError: () => {},
      now: () => NOW,
      sendResponse: async (...args) => {
        responses.push(args);
        if (args[2] === "SUCCESS") {
          currentTimeMs += 10_000;
          throw new Error("response upload failed");
        }
      },
      sleep: async (milliseconds) => {
        currentTimeMs += milliseconds;
      },
    },
  );

  assert.equal(context.remainingTimeReads, 1);
  assert.deepEqual(
    dynamo.commands.map((command) => command.constructor),
    [GetItemCommand, PutItemCommand],
  );
  assert.deepEqual(
    dynamo.commands.map((command) => command.input.TableName),
    [newTableName, newTableName],
  );
  assert.deepEqual(responses.map((call) => call[2]), [
    "SUCCESS",
    "SUCCESS",
    "SUCCESS",
    "FAILED",
  ]);
  assert.equal(responses[3][3].PhysicalResourceId, oldPhysicalId);
  assert.deepEqual(result, { PhysicalResourceId: oldPhysicalId });
});

test("malformed runtime budget fails closed before reconciliation", async () => {
  const dynamo = recordingDynamo([]);
  const responses = [];

  const result = await handleBaselineProjectSeed(
    event(),
    {
      logStreamName: "seed-log-stream",
      getRemainingTimeInMillis: () => Number.NaN,
    },
    dynamo,
    {
      logError: () => {},
      now: () => NOW,
      sendResponse: async (...args) => responses.push(args),
    },
  );

  assert.equal(dynamo.commands.length, 0);
  assert.deepEqual(responses.map((call) => call[2]), ["FAILED"]);
  assert.equal(
    responses[0][4],
    "Baseline platform project seed operation failed.",
  );
  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
  });
});

test("an in-flight DynamoDB request is aborted at the operation cutoff", async () => {
  let currentTimeMs = 1_000;
  const context = lambdaContext(31_000);
  const commands = [];
  const timers = [];
  const clearedTimers = [];
  const responses = [];
  const logs = [];
  const dynamo = {
    async send(command, options) {
      commands.push({ command, options });
      const signal = options?.abortSignal;
      if (!signal) throw new Error("missing operation deadline signal");
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(
            new Error("raw DynamoDB request abort"),
            { name: "AbortError" },
          ));
        }, { once: true });
      });
    },
  };

  const result = await handleBaselineProjectSeed(
    event(),
    context,
    dynamo,
    {
      clearTimer: (timer) => clearedTimers.push(timer),
      clock: () => currentTimeMs,
      logError: (message) => logs.push(message),
      now: () => NOW,
      sendResponse: async (...args) => {
        responses.push({
          args,
          attemptedAtMs: currentTimeMs,
        });
      },
      setTimer: (callback, milliseconds) => {
        const timer = { milliseconds };
        timers.push(timer);
        queueMicrotask(() => {
          currentTimeMs += milliseconds;
          callback();
        });
        return timer;
      },
      sleep: async () => assert.fail(
        "an in-flight deadline abort must not replay the operation",
      ),
    },
  );

  assert.equal(context.remainingTimeReads, 1);
  assert.equal(commands.length, 1);
  assert.ok(commands[0].command instanceof GetItemCommand);
  assert.equal(commands[0].options.abortSignal.aborted, true);
  assert.deepEqual(timers.map(({ milliseconds }) => milliseconds), [20_000]);
  assert.deepEqual(clearedTimers, timers);
  assert.deepEqual(responses.map(({ args }) => args[2]), ["FAILED"]);
  assert.equal(responses[0].attemptedAtMs, 21_000);
  assert.ok(32_000 - responses[0].attemptedAtMs >= 11_000);
  assert.deepEqual(logs, [
    "Baseline platform project seed operation failed.",
  ]);
  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-project:${TABLE_NAME}:platform:it-helpdesk`,
  });
});
