import assert from "node:assert/strict";
import test from "node:test";
import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createExperienceInvocationStore,
} from "../lambda/experience/invocation-store.mjs";

const NOW = "2026-08-25T08:00:00.000Z";
const LATER = "2026-08-25T08:00:01.000Z";

function input(overrides = {}) {
  return {
    actor: "user-sub-123",
    requestId: "invoke-request-123",
    payloadFingerprint: "a".repeat(64),
    sessionId: "session-0123456789abcdef-abcdef0123456789",
    domainId: "customer_support",
    projectId: "case-assist",
    agentId: "triage-agent",
    baselineFingerprint: null,
    ...overrides,
  };
}

function fakeDynamo(handler) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      return handler(command, commands.length);
    },
  };
}

test("invocation store durably journals the immutable request before Runtime", async () => {
  const dynamo = fakeDynamo(async () => ({}));
  const store = createExperienceInvocationStore({
    tableName: "PlatformState",
    dynamo,
    now: () => new Date(NOW),
  });

  const result = await store.start(input());

  assert.equal(result.phase, "STARTED");
  assert.equal(result.runtimeStatus, null);
  assert.equal(result.output, null);
  assert.equal(result.invocationId, null);
  assert.equal(dynamo.commands.length, 1);
  const command = dynamo.commands[0];
  assert.ok(command instanceof PutItemCommand);
  assert.equal(
    command.input.ConditionExpression,
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );
  assert.equal(
    command.input.Item.pk.S,
    "EXPERIENCE_INVOCATION#user-sub-123",
  );
  assert.equal(command.input.Item.sk.S, "REQUEST#invoke-request-123");
  assert.equal(command.input.Item.phase.S, "STARTED");
  assert.equal(command.input.Item.createdAt.S, NOW);
  assert.equal(Object.hasOwn(command.input.Item, "expiresAt"), false);
});

test("invocation store records and reads the exact successful Runtime outcome", async () => {
  let stored;
  const dynamo = fakeDynamo(async (command) => {
    if (command instanceof PutItemCommand) {
      stored = command.input.Item;
      return {};
    }
    if (command instanceof UpdateItemCommand) {
      stored = {
        ...stored,
        phase: { S: "COMPLETED" },
        runtimeStatus: { S: "SUCCEEDED" },
        output: { S: "Original output." },
        invocationId: { S: "runtime-original" },
        completedAt: { S: LATER },
      };
      return { Attributes: stored };
    }
    assert.ok(command instanceof GetItemCommand);
    return { Item: stored };
  });
  let tick = 0;
  const store = createExperienceInvocationStore({
    tableName: "PlatformState",
    dynamo,
    now: () => new Date(tick++ === 0 ? NOW : LATER),
  });
  await store.start(input());

  const completed = await store.complete({
    ...input(),
    runtimeStatus: "SUCCEEDED",
    output: "Original output.",
    invocationId: "runtime-original",
  });
  const replay = await store.get({
    actor: input().actor,
    requestId: input().requestId,
    payloadFingerprint: input().payloadFingerprint,
  });

  assert.deepEqual(completed, replay);
  assert.equal(replay.phase, "COMPLETED");
  assert.equal(replay.runtimeStatus, "SUCCEEDED");
  assert.equal(replay.output, "Original output.");
  assert.equal(replay.invocationId, "runtime-original");
  assert.ok(dynamo.commands[1] instanceof UpdateItemCommand);
  assert.match(
    dynamo.commands[1].input.ConditionExpression,
    /payloadFingerprint/,
  );
  assert.equal(dynamo.commands[2].input.ConsistentRead, true);
});

test("invocation store keeps a started request indeterminate when completion is unavailable", async () => {
  let stored;
  const dynamo = fakeDynamo(async (command) => {
    if (command instanceof PutItemCommand) {
      stored = command.input.Item;
      return {};
    }
    if (command instanceof UpdateItemCommand) {
      throw new Error("transport failed after Runtime");
    }
    return { Item: stored };
  });
  const store = createExperienceInvocationStore({
    tableName: "PlatformState",
    dynamo,
    now: () => new Date(NOW),
  });
  await store.start(input());

  await assert.rejects(
    store.complete({
      ...input(),
      runtimeStatus: "SUCCEEDED",
      output: "May have side effects.",
      invocationId: "runtime-indeterminate",
    }),
    /invocation journal unavailable/i,
  );

  assert.equal((await store.get({
    actor: input().actor,
    requestId: input().requestId,
    payloadFingerprint: input().payloadFingerprint,
  })).phase, "STARTED");
});

test("invocation store rejects request rebinding and malformed outcomes", async () => {
  const dynamo = fakeDynamo(async (command) => {
    if (command instanceof GetItemCommand) {
      return {
        Item: {
          pk: { S: "EXPERIENCE_INVOCATION#user-sub-123" },
          sk: { S: "REQUEST#invoke-request-123" },
          entityType: { S: "EXPERIENCE_INVOCATION" },
          actor: { S: "user-sub-123" },
          requestId: { S: "invoke-request-123" },
          payloadFingerprint: { S: "b".repeat(64) },
          sessionId: {
            S: "session-0123456789abcdef-abcdef0123456789",
          },
          domainId: { S: "customer_support" },
          projectId: { S: "case-assist" },
          agentId: { S: "triage-agent" },
          baselineFingerprint: { S: "NONE" },
          phase: { S: "STARTED" },
          createdAt: { S: NOW },
        },
      };
    }
    return {};
  });
  const store = createExperienceInvocationStore({
    tableName: "PlatformState",
    dynamo,
    now: () => new Date(NOW),
  });

  await assert.rejects(
    store.get({
      actor: input().actor,
      requestId: input().requestId,
      payloadFingerprint: input().payloadFingerprint,
    }),
    /invocation journal conflict/i,
  );
  await assert.rejects(
    store.complete({
      ...input(),
      runtimeStatus: "SUCCEEDED",
      output: "x".repeat(65_537),
      invocationId: "runtime-invalid",
    }),
    /invocation journal input is invalid/i,
  );
});
