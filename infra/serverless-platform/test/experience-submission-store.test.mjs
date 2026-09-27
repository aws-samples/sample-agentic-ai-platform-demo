import assert from "node:assert/strict";
import test from "node:test";
import {
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createExperienceSubmissionStore,
} from "../lambda/experience/submission-store.mjs";

const NOW = "2026-08-25T08:00:00.000Z";

function string(value) {
  return { S: value };
}

function number(value) {
  return { N: String(value) };
}

function feedbackInput(overrides = {}) {
  return {
    actor: "user-sub-123",
    effectiveRole: "user",
    requestId: "feedback-request-123",
    route: "POST /api/experience/feedback",
    payloadFingerprint: "a".repeat(64),
    agent: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    sessionId: "session-0123456789abcdef-abcdef0123456789",
    rating: 4,
    comment: "Useful response.",
    ...overrides,
  };
}

function issueInput(overrides = {}) {
  return {
    actor: "user-sub-123",
    effectiveRole: "user",
    requestId: "issue-request-123",
    route: "POST /api/experience/issues",
    payloadFingerprint: "b".repeat(64),
    agent: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
    sessionId: "session-0123456789abcdef-abcdef0123456789",
    description: "The answer omitted the escalation path.",
    ...overrides,
  };
}

function accessInput(overrides = {}) {
  return {
    actor: "user-sub-123",
    effectiveRole: "user",
    requestId: "access-request-123",
    route: "POST /api/experience/access-requests",
    payloadFingerprint: "c".repeat(64),
    publicAgentId: "agent-0123456789abcdef0123456789abcdef",
    reason: "Required for customer support duties.",
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

test("submission store persists bounded actor-owned records with conditional writes", async () => {
  const dynamo = fakeDynamo(async () => ({}));
  const store = createExperienceSubmissionStore({
    tableName: "PlatformState",
    dynamo,
    now: () => new Date(NOW),
  });

  const feedback = await store.submitFeedback(feedbackInput());
  const issue = await store.reportIssue(issueInput());
  const access = await store.requestAccess(accessInput());

  assert.match(feedback.id, /^feedback-[a-f0-9]{32}$/);
  assert.deepEqual(feedback, { id: feedback.id, status: "RECORDED" });
  assert.match(issue.id, /^issue-[a-f0-9]{32}$/);
  assert.deepEqual(issue, { id: issue.id, status: "RECORDED" });
  assert.match(access.id, /^access-[a-f0-9]{32}$/);
  assert.deepEqual(access, { id: access.id, status: "PENDING" });
  assert.equal(dynamo.commands.length, 3);
  for (const command of dynamo.commands) {
    assert.ok(command instanceof PutItemCommand);
    assert.equal(command.input.TableName, "PlatformState");
    assert.equal(
      command.input.ConditionExpression,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    assert.deepEqual(
      command.input.Item.pk,
      string("SUBMISSION#user-sub-123"),
    );
    assert.equal(command.input.Item.createdAt.S, NOW);
    assert.equal(command.input.Item.actor.S, "user-sub-123");
    assert.equal(command.input.Item.effectiveRole.S, "user");
    assert.equal(
      command.input.Item.payloadFingerprint.S.length,
      64,
    );
  }
  assert.deepEqual(dynamo.commands[0].input.Item.rating, number(4));
  assert.equal(
    dynamo.commands[0].input.Item.domainId.S,
    "customer_support",
  );
  assert.equal(
    dynamo.commands[2].input.Item.publicAgentId.S,
    "agent-0123456789abcdef0123456789abcdef",
  );
});

test("an exact conditional-write replay returns the durable result", async () => {
  let stored;
  const dynamo = fakeDynamo(async (command) => {
    if (command instanceof PutItemCommand) {
      stored = command.input.Item;
      const error = new Error("already exists");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    assert.ok(command instanceof GetItemCommand);
    return { Item: stored };
  });
  const store = createExperienceSubmissionStore({
    tableName: "PlatformState",
    dynamo,
    now: () => new Date(NOW),
  });

  const result = await store.submitFeedback(feedbackInput());

  assert.match(result.id, /^feedback-/);
  assert.equal(result.status, "RECORDED");
  assert.equal(dynamo.commands.length, 2);
  assert.equal(dynamo.commands[1].input.ConsistentRead, true);
  assert.deepEqual(dynamo.commands[1].input.Key, {
    pk: stored.pk,
    sk: stored.sk,
  });
});

test("a conflicting or malformed replay fails closed", async () => {
  for (const item of [
    undefined,
    {
      pk: string("SUBMISSION#user-sub-123"),
      sk: string("FEEDBACK#feedback-bad"),
    },
  ]) {
    const dynamo = fakeDynamo(async (command) => {
      if (command instanceof PutItemCommand) {
        const error = new Error("already exists");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      return item === undefined ? {} : { Item: item };
    });
    const store = createExperienceSubmissionStore({
      tableName: "PlatformState",
      dynamo,
      now: () => new Date(NOW),
    });
    await assert.rejects(
      store.submitFeedback(feedbackInput()),
      /submission conflict/i,
    );
  }
});

test("submission validation rejects forged scope and unbounded content before DynamoDB", async () => {
  const dynamo = fakeDynamo(async () => ({}));
  const store = createExperienceSubmissionStore({
    tableName: "PlatformState",
    dynamo,
    now: () => new Date(NOW),
  });

  const invalid = [
    ["submitFeedback", feedbackInput({ effectiveRole: "admin" })],
    ["submitFeedback", feedbackInput({ rating: 6 })],
    ["submitFeedback", feedbackInput({ comment: "x".repeat(2_049) })],
    ["reportIssue", issueInput({ description: "x".repeat(4_097) })],
    ["requestAccess", accessInput({ publicAgentId: "triage-agent" })],
    ["requestAccess", accessInput({ reason: "x".repeat(2_049) })],
    ["requestAccess", { ...accessInput(), unexpected: true }],
  ];
  for (const [method, value] of invalid) {
    await assert.rejects(
      store[method](value),
      /submission input is invalid/i,
    );
  }
  assert.equal(dynamo.commands.length, 0);
});

test("DynamoDB transport errors are sanitized without fallback records", async () => {
  const store = createExperienceSubmissionStore({
    tableName: "PlatformState",
    dynamo: fakeDynamo(async () => {
      throw new Error("secret table detail");
    }),
    now: () => new Date(NOW),
  });

  await assert.rejects(
    store.requestAccess(accessInput()),
    (error) => {
      assert.equal(error.message, "Submission storage failed.");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
});
