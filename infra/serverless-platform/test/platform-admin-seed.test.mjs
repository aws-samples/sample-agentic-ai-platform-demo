import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  handleBaselineSeed,
  reconcileBaselineDomains,
  sendCloudFormationResponse,
} from "../lambda/platform-admin/seed.mjs";

const NOW = "2026-08-23T01:02:03.000Z";
const TABLE_NAME = "AgenticPlatform-Web-PlatformStateTable-EXAMPLE";

function baselineDomains() {
  return [
    {
      id: "platform",
      name: "Platform",
      owner: "Platform team",
      ownerGroup: "domain-platform",
      description: "Platform-owned agents and shared platform capabilities.",
      tokenBudget: null,
      registryId: "PlatformReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/PlatformReg1234",
      createdBy: "deployment:baseline",
    },
    {
      id: "customer_support",
      name: "Customer Support",
      owner: "Customer Support team",
      ownerGroup: "domain-customer-support",
      description: "Customer-facing support agents.",
      tokenBudget: 24000,
      registryId: "CustomerReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/CustomerReg1234",
      createdBy: "deployment:baseline",
    },
    {
      id: "operations",
      name: "Operations",
      owner: "Operations team",
      ownerGroup: "domain-operations",
      description: "Internal operations and workflow automation agents.",
      tokenBudget: null,
      registryId: "OperatioReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/OperatioReg1234",
      createdBy: "deployment:baseline",
    },
  ];
}

function event(requestType = "Create", overrides = {}) {
  return {
    RequestType: requestType,
    RequestId: "cloudformation-request-1234",
    ResourceProperties: {
      TableName: TABLE_NAME,
      Domains: baselineDomains(),
    },
    ...overrides,
  };
}

function responseEvent(overrides = {}) {
  return event("Create", {
    LogicalResourceId: "PlatformBaselineDomains",
    ResponseURL:
      "https://response.example.test/upload"
      + "?X-Amz-Signature=do-not-expose",
    StackId: "stack-response",
    ...overrides,
  });
}

function responseUploadHarness() {
  let responseCallback;
  let timerCallback;
  const clearedTimers = [];
  const request = new EventEmitter();
  request.destroyCalls = 0;
  request.end = () => {};
  request.destroy = () => {
    request.destroyCalls += 1;
  };
  const timerToken = { timer: true };

  return {
    clearTimer(token) {
      clearedTimers.push(token);
    },
    clearedTimers,
    fireTimeout() {
      timerCallback();
    },
    request,
    requestTransport: (_options, callback) => {
      responseCallback = callback;
      return request;
    },
    respond(statusCode) {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.resume = () => {};
      responseCallback(response);
      return response;
    },
    setTimer(callback) {
      timerCallback = callback;
      return timerToken;
    },
    timerToken,
  };
}

function assertSanitizedDeliveryError(error, pattern) {
  assert.ok(error instanceof Error);
  assert.match(error.message, pattern);
  assert.doesNotMatch(
    error.message,
    /response\.example\.test|X-Amz-Signature|AKIA|super-secret/i,
  );
  return true;
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

function domainItem(domain, overrides = {}) {
  const value = {
    ...domain,
    status: "ACTIVE",
    createdAt: NOW,
    ...overrides,
  };
  return {
    pk: { S: "DOMAIN" },
    sk: { S: `DOMAIN#${value.id}` },
    entityType: { S: "DOMAIN" },
    id: { S: value.id },
    name: { S: value.name },
    owner: { S: value.owner },
    ownerGroup: { S: value.ownerGroup },
    description: { S: value.description },
    tokenBudget: value.tokenBudget === null
      ? { NULL: true }
      : { N: String(value.tokenBudget) },
    registryId: { S: value.registryId },
    registryArn: { S: value.registryArn },
    createdBy: { S: value.createdBy },
    status: { S: value.status },
    createdAt: { S: value.createdAt },
  };
}

test("Create validates and conditionally seeds all missing baseline domains", async () => {
  const dynamo = recordingDynamo([{}, {}, {}, {}, {}, {}]);

  const result = await reconcileBaselineDomains(
    event(),
    { dynamo, now: () => NOW },
  );

  assert.deepEqual(result, {
    PhysicalResourceId:
      `platform-baseline-domains:${TABLE_NAME}`,
    Data: {
      CreatedCount: 3,
      ExistingCount: 0,
    },
  });
  assert.deepEqual(
    dynamo.commands.map((command) => command.constructor),
    [
      GetItemCommand,
      PutItemCommand,
      GetItemCommand,
      PutItemCommand,
      GetItemCommand,
      PutItemCommand,
    ],
  );
  const writes = dynamo.commands.filter(
    (command) => command instanceof PutItemCommand,
  );
  assert.deepEqual(
    writes.map((command) => command.input.Item.id.S),
    ["platform", "customer_support", "operations"],
  );
  assert.deepEqual(
    writes.map((command) => command.input.Item.ownerGroup.S),
    [
      "domain-platform",
      "domain-customer-support",
      "domain-operations",
    ],
  );
  assert.deepEqual(
    writes.map((command) => command.input.Item.tokenBudget),
    [{ NULL: true }, { N: "24000" }, { NULL: true }],
  );
  assert.deepEqual(
    writes.map((command) => command.input.Item.status),
    [{ S: "ACTIVE" }, { S: "ACTIVE" }, { S: "ACTIVE" }],
  );
});

test("Create accepts CloudFormation reserved custom-resource properties", async () => {
  const dynamo = recordingDynamo([{}, {}, {}, {}, {}, {}]);

  const result = await reconcileBaselineDomains(
    event("Create", {
      ResourceProperties: {
        ServiceToken:
          "arn:aws:lambda:us-west-2:111122223333:function:baseline-seed",
        ServiceTimeout: "180",
        TableName: TABLE_NAME,
        Domains: baselineDomains(),
      },
    }),
    { dynamo, now: () => NOW },
  );

  assert.deepEqual(result.Data, {
    CreatedCount: 3,
    ExistingCount: 0,
  });
});

test("Create accepts a CloudFormation-stringified nested token budget", async () => {
  const domains = baselineDomains();
  domains[1] = {
    ...domains[1],
    tokenBudget: "24000",
  };
  const dynamo = recordingDynamo([{}, {}, {}, {}, {}, {}]);

  const result = await reconcileBaselineDomains(
    event("Create", {
      ResourceProperties: {
        ServiceToken:
          "arn:aws:lambda:us-west-2:111122223333:function:baseline-seed",
        ServiceTimeout: "180",
        TableName: TABLE_NAME,
        Domains: domains,
      },
    }),
    { dynamo, now: () => NOW },
  );

  assert.deepEqual(result.Data, {
    CreatedCount: 3,
    ExistingCount: 0,
  });
  assert.deepEqual(
    dynamo.commands
      .filter((command) => command instanceof PutItemCommand)
      .map((command) => command.input.Item.tokenBudget),
    [{ NULL: true }, { N: "24000" }, { NULL: true }],
  );
});

test("Create retries a temporary IAM propagation denial", async () => {
  const accessDenied = new Error("not authorized yet");
  accessDenied.name = "AccessDeniedException";
  const delays = [];
  const dynamo = recordingDynamo([
    accessDenied,
    {},
    {},
    {},
    {},
    {},
    {},
  ]);

  const result = await reconcileBaselineDomains(
    event(),
    {
      accessRetryAttempts: 2,
      accessRetryDelayMs: 25,
      dynamo,
      now: () => NOW,
      sleep: async (milliseconds) => delays.push(milliseconds),
    },
  );

  assert.deepEqual(result.Data, {
    CreatedCount: 3,
    ExistingCount: 0,
  });
  assert.deepEqual(delays, [25]);
  assert.deepEqual(
    dynamo.commands.slice(0, 2).map((command) => command.constructor),
    [GetItemCommand, GetItemCommand],
  );
});

test("seed normalizes omitted token budgets to DynamoDB NULL", async () => {
  const domains = baselineDomains().map((domain) => {
    if (domain.tokenBudget !== null) return domain;
    const { tokenBudget: _tokenBudget, ...unboundedDomain } = domain;
    return unboundedDomain;
  });
  const dynamo = recordingDynamo([{}, {}, {}, {}, {}, {}]);

  await reconcileBaselineDomains(
    event("Create", {
      ResourceProperties: {
        TableName: TABLE_NAME,
        Domains: domains,
      },
    }),
    { dynamo, now: () => NOW },
  );

  const writes = dynamo.commands.filter(
    (command) => command instanceof PutItemCommand,
  );
  assert.deepEqual(
    writes.map((command) => command.input.Item.tokenBudget),
    [{ NULL: true }, { N: "24000" }, { NULL: true }],
  );
});

test("seed normalizes a Date clock once for every generated domain timestamp", async () => {
  let clockCalls = 0;
  const dynamo = recordingDynamo([{}, {}, {}, {}, {}, {}]);

  await reconcileBaselineDomains(
    event(),
    {
      dynamo,
      now: () => {
        clockCalls += 1;
        return new Date(NOW);
      },
    },
  );

  const writes = dynamo.commands.filter(
    (command) => command instanceof PutItemCommand,
  );
  assert.equal(clockCalls, 1);
  assert.equal(writes.length, 3);
  assert.deepEqual(
    writes.map((command) => command.input.Item.createdAt),
    [{ S: NOW }, { S: NOW }, { S: NOW }],
  );
});

test("existing domains preserve mutable metadata but enforce derived identity", async () => {
  const domains = baselineDomains();
  const matchingDynamo = recordingDynamo(domains.map((domain, index) => ({
    Item: domainItem(domain, {
      owner: `Operator owner ${index}`,
      description: `Operator description ${index}`,
      tokenBudget: index === 1 ? 99999 : null,
    }),
  })));

  assert.deepEqual(
    await reconcileBaselineDomains(
      event(),
      { dynamo: matchingDynamo, now: () => NOW },
    ),
    {
      PhysicalResourceId:
        `platform-baseline-domains:${TABLE_NAME}`,
      Data: {
        CreatedCount: 0,
        ExistingCount: 3,
      },
    },
  );
  assert.equal(matchingDynamo.commands.length, 3);
  assert.ok(
    matchingDynamo.commands.every(
      (command) => command instanceof GetItemCommand,
    ),
  );

  const groupMismatch = structuredClone(domains[0]);
  groupMismatch.ownerGroup = "domain-operator";
  const groupMismatchDynamo = recordingDynamo([
    { Item: domainItem(groupMismatch) },
  ]);
  await assert.rejects(
    reconcileBaselineDomains(
      event(),
      { dynamo: groupMismatchDynamo, now: () => NOW },
    ),
    (error) => error?.code === "MALFORMED_DYNAMODB_RESPONSE",
  );
  assert.equal(groupMismatchDynamo.commands.length, 1);
  assert.ok(groupMismatchDynamo.commands[0] instanceof GetItemCommand);

  const identityMismatch = structuredClone(domains[0]);
  identityMismatch.registryId = "CustomerReg1234";
  identityMismatch.registryArn =
    "arn:aws:agent-registry:us-west-2:111122223333:"
    + "registry/CustomerReg1234";
  const mismatchDynamo = recordingDynamo([
    { Item: domainItem(identityMismatch) },
  ]);
  await assert.rejects(
    reconcileBaselineDomains(
      event(),
      { dynamo: mismatchDynamo, now: () => NOW },
    ),
    (error) => error?.code === "BASELINE_IDENTITY_CONFLICT",
  );
  assert.equal(mismatchDynamo.commands.length, 1);
  assert.ok(mismatchDynamo.commands[0] instanceof GetItemCommand);
});

test("Update validates ownership, creates only missing records, and Delete is a no-op", async () => {
  const wrongPhysicalDynamo = recordingDynamo([]);
  await assert.rejects(
    reconcileBaselineDomains(
      event("Update", {
        PhysicalResourceId: "platform-baseline-domains:other-table",
        OldResourceProperties: {
          TableName: TABLE_NAME,
          Domains: baselineDomains(),
        },
      }),
      { dynamo: wrongPhysicalDynamo, now: () => NOW },
    ),
    (error) => error?.code === "INVALID_BASELINE_SEED",
  );
  assert.equal(wrongPhysicalDynamo.commands.length, 0);

  const domains = baselineDomains();
  const updateDynamo = recordingDynamo([
    { Item: domainItem(domains[0], { owner: "Operator platform owner" }) },
    {},
    {},
    { Item: domainItem(domains[2], { tokenBudget: 50000 }) },
  ]);
  const updateResult = await reconcileBaselineDomains(
    event("Update", {
      PhysicalResourceId: `platform-baseline-domains:${TABLE_NAME}`,
      OldResourceProperties: {
        TableName: TABLE_NAME,
        Domains: baselineDomains(),
      },
    }),
    { dynamo: updateDynamo, now: () => NOW },
  );
  assert.deepEqual(updateResult, {
    PhysicalResourceId:
      `platform-baseline-domains:${TABLE_NAME}`,
    Data: {
      CreatedCount: 1,
      ExistingCount: 2,
    },
  });
  assert.deepEqual(
    updateDynamo.commands.map((command) => command.constructor),
    [GetItemCommand, GetItemCommand, PutItemCommand, GetItemCommand],
  );
  assert.equal(updateDynamo.commands[2].input.Item.id.S, "customer_support");

  for (const malformedProperties of [
    {
      TableName: TABLE_NAME,
      Domains: [
        baselineDomains()[0],
        baselineDomains()[0],
        baselineDomains()[2],
      ],
    },
    {
      TableName: TABLE_NAME,
      Domains: baselineDomains().map((domain, index) =>
        index === 1 ? { ...domain, tokenBudget: 0 } : domain
      ),
    },
  ]) {
    const malformedDynamo = recordingDynamo([]);
    await assert.rejects(
      reconcileBaselineDomains(
        event("Create", { ResourceProperties: malformedProperties }),
        { dynamo: malformedDynamo, now: () => NOW },
      ),
      (error) => error?.code === "INVALID_BASELINE_SEED",
    );
    assert.equal(malformedDynamo.commands.length, 0);
  }

  const deleteDynamo = recordingDynamo([]);
  assert.deepEqual(
    await reconcileBaselineDomains(
      event("Delete", {
        PhysicalResourceId:
          `platform-baseline-domains:${TABLE_NAME}`,
        ResourceProperties: { malformed: "ignored on delete" },
      }),
      { dynamo: deleteDynamo, now: () => NOW },
    ),
    {
      PhysicalResourceId:
        `platform-baseline-domains:${TABLE_NAME}`,
    },
  );
  assert.equal(deleteDynamo.commands.length, 0);
});

test("a concurrent matching create converges without overwriting", async () => {
  const domains = baselineDomains();
  const conditional = new ConditionalCheckFailedException({
    $metadata: {},
    message: "already exists",
  });
  const dynamo = recordingDynamo([
    {},
    conditional,
    { Item: domainItem(domains[0]) },
    { Item: domainItem(domains[1]) },
    { Item: domainItem(domains[2]) },
  ]);

  assert.deepEqual(
    await reconcileBaselineDomains(
      event(),
      { dynamo, now: () => NOW },
    ),
    {
      PhysicalResourceId:
        `platform-baseline-domains:${TABLE_NAME}`,
      Data: {
        CreatedCount: 0,
        ExistingCount: 3,
      },
    },
  );
  assert.deepEqual(
    dynamo.commands.map((command) => command.constructor),
    [
      GetItemCommand,
      PutItemCommand,
      GetItemCommand,
      GetItemCommand,
      GetItemCommand,
    ],
  );
});

test("CloudFormation response resolves on 2xx end and cleans up listeners and timer", async () => {
  const harness = responseUploadHarness();
  const upload = sendCloudFormationResponse(
    responseEvent(),
    { logStreamName: "seed-log-stream" },
    "SUCCESS",
    { PhysicalResourceId: `platform-baseline-domains:${TABLE_NAME}` },
    "Baseline domain seed operation completed.",
    harness,
  );
  const response = harness.respond(204);

  response.emit("end");
  await upload;

  assert.deepEqual(harness.clearedTimers, [harness.timerToken]);
  assert.equal(harness.request.listenerCount("error"), 0);
  assert.equal(response.listenerCount("error"), 0);
  assert.equal(response.listenerCount("end"), 0);
  assert.equal(harness.request.destroyCalls, 0);
});

test("CloudFormation response rejects non-2xx and request errors generically", async () => {
  for (const failure of ["status", "request"]) {
    const harness = responseUploadHarness();
    const upload = sendCloudFormationResponse(
      responseEvent(),
      { logStreamName: "seed-log-stream" },
      "SUCCESS",
      { PhysicalResourceId: `platform-baseline-domains:${TABLE_NAME}` },
      "Baseline domain seed operation completed.",
      harness,
    );
    if (failure === "status") {
      const response = harness.respond(403);
      response.emit("end");
    } else {
      harness.request.emit(
        "error",
        new Error(
          "https://response.example.test/?X-Amz-Signature=super-secret",
        ),
      );
    }

    await assert.rejects(
      upload,
      (error) => assertSanitizedDeliveryError(error, /upload|status/i),
    );
    assert.deepEqual(harness.clearedTimers, [harness.timerToken]);
    assert.equal(harness.request.listenerCount("error"), 0);
  }
});

test("CloudFormation response times out, destroys the request, and clears the timer", async () => {
  const harness = responseUploadHarness();
  const upload = sendCloudFormationResponse(
    responseEvent(),
    { logStreamName: "seed-log-stream" },
    "SUCCESS",
    { PhysicalResourceId: `platform-baseline-domains:${TABLE_NAME}` },
    "Baseline domain seed operation completed.",
    {
      ...harness,
      timeoutMs: 1_000,
    },
  );

  harness.fireTimeout();

  await assert.rejects(
    upload,
    (error) => assertSanitizedDeliveryError(error, /timed out/i),
  );
  assert.equal(harness.request.destroyCalls, 1);
  assert.deepEqual(harness.clearedTimers, [harness.timerToken]);
  assert.equal(harness.request.listenerCount("error"), 0);
});

test("successful seed retries response delivery without replaying mutation", async () => {
  const responses = [];
  const sleeps = [];
  let dynamoCalls = 0;
  const dynamo = {
    async send(command) {
      dynamoCalls += 1;
      if (command instanceof GetItemCommand) return {};
      if (command instanceof PutItemCommand) return {};
      throw new Error("Unexpected DynamoDB command.");
    },
  };

  const result = await handleBaselineSeed(
    responseEvent(),
    { logStreamName: "seed-log-stream" },
    dynamo,
    {
      now: () => NOW,
      responseRetryDelayMs: 17,
      sendResponse: async (...args) => {
        responses.push(args);
        if (responses.length < 3) {
          throw new Error(
            "https://response.example.test/?X-Amz-Signature=secret",
          );
        }
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    },
  );

  assert.equal(dynamoCalls, 6);
  assert.equal(responses.length, 3);
  assert.deepEqual(responses.map((call) => call[2]), [
    "SUCCESS",
    "SUCCESS",
    "SUCCESS",
  ]);
  assert.deepEqual(sleeps, [17, 17]);
  assert.equal(
    result.PhysicalResourceId,
    `platform-baseline-domains:${TABLE_NAME}`,
  );
});

test("Update operation failure retains the existing physical ID", async () => {
  const oldTableName = "AgenticPlatform-Web-OldStateTable";
  const newTableName = "AgenticPlatform-Web-NewStateTable";
  const oldPhysicalId = `platform-baseline-domains:${oldTableName}`;
  const responses = [];

  const result = await handleBaselineSeed(
    responseEvent({
      RequestType: "Update",
      PhysicalResourceId: oldPhysicalId,
      OldResourceProperties: {
        TableName: oldTableName,
        Domains: baselineDomains(),
      },
      ResourceProperties: {
        TableName: newTableName,
        Domains: baselineDomains(),
      },
    }),
    { logStreamName: "seed-log-stream" },
    recordingDynamo([
      new Error("AKIAABCDEFGHIJKLMNOP raw operation failure"),
    ]),
    {
      now: () => NOW,
      sendResponse: async (...args) => {
        responses.push(args);
      },
      logError: () => {},
    },
  );

  assert.deepEqual(result, { PhysicalResourceId: oldPhysicalId });
  assert.equal(responses.length, 1);
  assert.equal(responses[0][2], "FAILED");
  assert.deepEqual(responses[0][3], {
    PhysicalResourceId: oldPhysicalId,
  });
});

test("exhausted SUCCESS delivery sends one sanitized terminal FAILED response", async () => {
  const responses = [];
  const result = await handleBaselineSeed(
    responseEvent({
      RequestType: "Delete",
      PhysicalResourceId: `platform-baseline-domains:${TABLE_NAME}`,
    }),
    { logStreamName: "seed-log-stream" },
    recordingDynamo([]),
    {
      responseRetryDelayMs: 0,
      sendResponse: async (...args) => {
        responses.push(args);
        if (args[2] === "SUCCESS") {
          throw new Error(
            "https://response.example.test/?X-Amz-Signature=secret",
          );
        }
      },
      sleep: async () => {},
    },
  );

  assert.deepEqual(responses.map((call) => call[2]), [
    "SUCCESS",
    "SUCCESS",
    "SUCCESS",
    "FAILED",
  ]);
  assert.equal(
    responses[3][4],
    "Baseline domain seed response delivery failed.",
  );
  assert.equal(
    result.PhysicalResourceId,
    `platform-baseline-domains:${TABLE_NAME}`,
  );
});

test("terminal response failure throws sanitized without replay or raw leakage", async () => {
  let dynamoCalls = 0;
  const responses = [];
  const logs = [];
  const dynamo = {
    async send(command) {
      dynamoCalls += 1;
      if (command instanceof GetItemCommand) return {};
      if (command instanceof PutItemCommand) return {};
      throw new Error("Unexpected DynamoDB command.");
    },
  };

  await assert.rejects(
    handleBaselineSeed(
      responseEvent(),
      { logStreamName: "seed-log-stream" },
      dynamo,
      {
        now: () => NOW,
        responseRetryDelayMs: 0,
        sendResponse: async (...args) => {
          responses.push(args);
          throw new Error(
            "AKIAABCDEFGHIJKLMNOP "
            + "https://response.example.test/?X-Amz-Signature=secret",
          );
        },
        sleep: async () => {},
        logError: (message) => logs.push(message),
      },
    ),
    (error) => assertSanitizedDeliveryError(
      error,
      /response delivery failed/i,
    ),
  );

  assert.equal(dynamoCalls, 6);
  assert.deepEqual(responses.map((call) => call[2]), [
    "SUCCESS",
    "SUCCESS",
    "SUCCESS",
    "FAILED",
  ]);
  assert.deepEqual(logs, [
    "Baseline domain seed response delivery failed.",
  ]);
  assert.doesNotMatch(
    JSON.stringify({ responses: responses.map((call) => call.slice(2, 5)), logs }),
    /AKIA|super-secret|X-Amz-Signature/,
  );
});

test("Update terminal response failure retains the existing physical ID", async () => {
  const oldTableName = "AgenticPlatform-Web-OldStateTable";
  const newTableName = "AgenticPlatform-Web-NewStateTable";
  const oldPhysicalId = `platform-baseline-domains:${oldTableName}`;
  const newPhysicalId = `platform-baseline-domains:${newTableName}`;
  const responses = [];

  await assert.rejects(
    handleBaselineSeed(
      responseEvent({
        RequestType: "Update",
        PhysicalResourceId: oldPhysicalId,
        OldResourceProperties: {
          TableName: oldTableName,
          Domains: baselineDomains(),
        },
        ResourceProperties: {
          TableName: newTableName,
          Domains: baselineDomains(),
        },
      }),
      { logStreamName: "seed-log-stream" },
      recordingDynamo([{}, {}, {}, {}, {}, {}]),
      {
        now: () => NOW,
        responseRetryDelayMs: 0,
        sendResponse: async (...args) => {
          responses.push(args);
          throw new Error(
            "https://response.example.test/?X-Amz-Signature=secret",
          );
        },
        sleep: async () => {},
        logError: () => {},
      },
    ),
    (error) => assertSanitizedDeliveryError(
      error,
      /response delivery failed/i,
    ),
  );

  assert.deepEqual(responses.map((call) => call[2]), [
    "SUCCESS",
    "SUCCESS",
    "SUCCESS",
    "FAILED",
  ]);
  assert.deepEqual(
    responses.slice(0, 3).map((call) => call[3].PhysicalResourceId),
    [newPhysicalId, newPhysicalId, newPhysicalId],
  );
  assert.equal(responses[3][3].PhysicalResourceId, oldPhysicalId);
});

test("operation and FAILED delivery failure throws one sanitized terminal error", async () => {
  const logs = [];
  await assert.rejects(
    handleBaselineSeed(
      responseEvent(),
      { logStreamName: "seed-log-stream" },
      recordingDynamo([
        new Error("AKIAABCDEFGHIJKLMNOP raw operation failure"),
      ]),
      {
        sendResponse: async () => {
          throw new Error(
            "https://response.example.test/?X-Amz-Signature=secret",
          );
        },
        logError: (message) => logs.push(message),
      },
    ),
    (error) => assertSanitizedDeliveryError(
      error,
      /response delivery failed/i,
    ),
  );
  assert.deepEqual(logs, [
    "Baseline domain seed operation failed.",
    "Baseline domain seed response delivery failed.",
  ]);
});

test("operation failures log only a stable diagnostic code", async () => {
  const logs = [];
  const validationError = new Error(
    "Request contained account-secret diagnostic material.",
  );
  validationError.name = "ValidationException";

  await handleBaselineSeed(
    responseEvent(),
    { logStreamName: "seed-log-stream" },
    recordingDynamo([validationError]),
    {
      logError: (...args) => logs.push(args),
      sendResponse: async () => {},
    },
  );

  assert.deepEqual(logs, [[
    "Baseline domain seed operation failed.",
    "AWS_VALIDATION_ERROR",
  ]]);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /account-secret|diagnostic material/i,
  );
});

test("invalid seed diagnostics expose only the expected contract shape", async () => {
  const logs = [];

  await handleBaselineSeed(
    responseEvent({
      ResourceProperties: {
        ServiceToken:
          "arn:aws:lambda:us-west-2:111122223333:function:baseline-seed",
        ServiceTimeout: "180",
        TableName: TABLE_NAME,
        Domains: "AKIAABCDEFGHIJKLMNOP super-secret-domain-payload",
      },
    }),
    { logStreamName: "seed-log-stream" },
    recordingDynamo([]),
    {
      logError: (...args) => logs.push(args),
      sendResponse: async () => {},
    },
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "Baseline domain seed operation failed.");
  assert.equal(logs[0][1], "INVALID_BASELINE_SEED");
  const shape = JSON.parse(logs[0][2]);
  assert.deepEqual(shape, {
    domains: "string",
    domainsLength: null,
    event: "object",
    properties: "object",
    serviceTimeout: "string",
    serviceToken: "string",
    tableName: "string",
  });
  assert.doesNotMatch(
    JSON.stringify(logs),
    /AKIA|super-secret|domain-payload/i,
  );
});

test("invalid domain diagnostics expose field shapes without field values", async () => {
  const logs = [];
  const domains = baselineDomains();
  domains[1] = {
    ...domains[1],
    tokenBudget: "AKIAABCDEFGHIJKLMNOP super-secret-budget",
  };

  await handleBaselineSeed(
    responseEvent({
      ResourceProperties: {
        ServiceToken:
          "arn:aws:lambda:us-west-2:111122223333:function:baseline-seed",
        ServiceTimeout: "180",
        TableName: TABLE_NAME,
        Domains: domains,
      },
    }),
    { logStreamName: "seed-log-stream" },
    recordingDynamo([]),
    {
      logError: (...args) => logs.push(args),
      sendResponse: async () => {},
    },
  );

  assert.equal(logs.length, 1);
  const shape = JSON.parse(logs[0][2]);
  assert.equal(shape.domainShapes.length, 3);
  assert.deepEqual(shape.domainShapes[1], {
    index: 1,
    type: "object",
    keys: [
      "createdBy",
      "description",
      "id",
      "name",
      "owner",
      "ownerGroup",
      "registryArn",
      "registryId",
      "tokenBudget",
    ],
    fields: {
      createdBy: "string",
      description: "string",
      id: "string",
      name: "string",
      owner: "string",
      ownerGroup: "string",
      registryArn: "string",
      registryId: "string",
      tokenBudget: "string",
    },
  });
  assert.doesNotMatch(
    JSON.stringify(logs),
    /AKIA|super-secret|secret-budget/i,
  );
});

test("custom resource responses and logs do not expose raw failures", async () => {
  const responses = [];
  const logs = [];
  const sendResponse = async (...args) => {
    responses.push(args);
  };
  const context = { logStreamName: "seed-log-stream" };

  const deleteEvent = event("Delete", {
    PhysicalResourceId: `platform-baseline-domains:${TABLE_NAME}`,
  });
  assert.deepEqual(
    await handleBaselineSeed(
      deleteEvent,
      context,
      recordingDynamo([]),
      {
        sendResponse,
        logError: (message) => logs.push(message),
      },
    ),
    {
      PhysicalResourceId:
        `platform-baseline-domains:${TABLE_NAME}`,
    },
  );
  assert.equal(responses[0][2], "SUCCESS");
  assert.deepEqual(responses[0][3], {
    PhysicalResourceId:
      `platform-baseline-domains:${TABLE_NAME}`,
  });

  const secret =
    "AKIAABCDEFGHIJKLMNOP password=super-secret raw-sdk-message";
  const failureResult = await handleBaselineSeed(
    event(),
    context,
    recordingDynamo([new Error(secret)]),
    {
      sendResponse,
      logError: (message) => logs.push(message),
    },
  );
  assert.deepEqual(failureResult, {
    PhysicalResourceId:
      `platform-baseline-domains:${TABLE_NAME}`,
  });
  assert.equal(responses[1][2], "FAILED");
  assert.deepEqual(responses[1][3], failureResult);
  assert.equal(
    responses[1][4],
    "Baseline domain seed operation failed.",
  );
  assert.deepEqual(logs, ["Baseline domain seed operation failed."]);
  assert.doesNotMatch(
    JSON.stringify({ responses, logs, failureResult }),
    /AKIA|super-secret|raw-sdk-message/,
  );
});
