import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ConditionalCheckFailedException,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  RuntimeProofReplayLedgerError,
  createRuntimeProofReplayLedger,
} from "../lambda/agent-runtime/replay-ledger.mjs";

const NOW = 1_777_777_777_123;
const AUDIENCE =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:"
  + "runtime-endpoint/runtime-123/endpoint/production";
const NONCE = Buffer.alloc(32, 7).toString("base64url");
const EXPIRES_AT = NOW + 60_000;

function fakeDynamo(handler = async () => ({})) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      return handler(command, commands.length);
    },
  };
}

function ledger(dynamo = fakeDynamo()) {
  return {
    dynamo,
    value: createRuntimeProofReplayLedger({
      tableName: "PlatformState",
      dynamo,
      clock: () => NOW,
    }),
  };
}

function proof(overrides = {}) {
  return {
    audience: AUDIENCE,
    nonce: NONCE,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

test("atomically consumes one audience-bound nonce with a bounded TTL", async () => {
  const { dynamo, value } = ledger();

  assert.equal(await value.consume(proof()), true);
  assert.equal(dynamo.commands.length, 1);

  const command = dynamo.commands[0];
  assert.ok(command instanceof PutItemCommand);
  assert.equal(command.input.TableName, "PlatformState");
  assert.equal(
    command.input.ConditionExpression,
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );
  assert.deepEqual(command.input.Item, {
    pk: {
      S: `RUNTIME_PROOF#${
        createHash("sha256").update(AUDIENCE, "utf8").digest("hex")
      }`,
    },
    sk: { S: `NONCE#${NONCE}` },
    entityType: { S: "RUNTIME_PROOF_REPLAY" },
    expiresAt: { N: String(Math.ceil(EXPIRES_AT / 1_000)) },
  });
});

test("the conditional write rejects a replay across independent ledgers", async () => {
  const keys = new Set();
  const dynamo = fakeDynamo(async (command) => {
    const key = `${command.input.Item.pk.S}\0${command.input.Item.sk.S}`;
    if (keys.has(key)) {
      throw new ConditionalCheckFailedException({
        $metadata: {},
        message: "sensitive duplicate detail",
      });
    }
    keys.add(key);
    return {};
  });
  const first = createRuntimeProofReplayLedger({
    tableName: "PlatformState",
    dynamo,
    clock: () => NOW,
  });
  const second = createRuntimeProofReplayLedger({
    tableName: "PlatformState",
    dynamo,
    clock: () => NOW,
  });

  assert.equal(await first.consume(proof()), true);
  assert.equal(await second.consume(proof()), false);
  assert.equal(dynamo.commands.length, 2);
});

test("different audiences do not share a nonce partition", async () => {
  const { dynamo, value } = ledger();
  const otherAudience = `${AUDIENCE}-other`;

  assert.equal(await value.consume(proof()), true);
  assert.equal(
    await value.consume(proof({ audience: otherAudience })),
    true,
  );
  assert.notEqual(
    dynamo.commands[0].input.Item.pk.S,
    dynamo.commands[1].input.Item.pk.S,
  );
  assert.equal(
    dynamo.commands[0].input.Item.sk.S,
    dynamo.commands[1].input.Item.sk.S,
  );
});

test("strict proof validation rejects malformed or unbounded inputs before DynamoDB", async () => {
  const { dynamo, value } = ledger();
  const invalid = [
    null,
    {},
    { ...proof(), unexpected: true },
    proof({ audience: "" }),
    proof({ audience: " leading-space" }),
    proof({ audience: "a".repeat(1_025) }),
    proof({ audience: "bad\nvalue" }),
    proof({ nonce: "*".repeat(43) }),
    proof({ nonce: Buffer.alloc(31).toString("base64url") }),
    proof({ expiresAt: NOW }),
    proof({ expiresAt: NOW + 300_001 }),
    proof({ expiresAt: NOW + 0.5 }),
  ];
  const accessor = {};
  Object.defineProperties(accessor, {
    audience: { enumerable: true, get: () => AUDIENCE },
    nonce: { enumerable: true, value: NONCE },
    expiresAt: { enumerable: true, value: EXPIRES_AT },
  });
  invalid.push(accessor);

  for (const candidate of invalid) {
    await assert.rejects(
      value.consume(candidate),
      (error) => {
        assert.equal(error.name, "TypeError");
        assert.equal(
          error.message,
          "Runtime proof replay input is invalid.",
        );
        return true;
      },
    );
  }
  assert.equal(dynamo.commands.length, 0);
});

test("strict configuration validation rejects invalid clients, tables, clocks, and options", () => {
  const valid = {
    tableName: "PlatformState",
    dynamo: fakeDynamo(),
    clock: () => NOW,
  };
  const invalid = [
    undefined,
    {},
    { ...valid, tableName: "x" },
    { ...valid, tableName: " leading" },
    { ...valid, tableName: "a".repeat(256) },
    { ...valid, dynamo: null },
    { ...valid, dynamo: {} },
    { ...valid, clock: 1 },
    { ...valid, unexpected: true },
  ];

  for (const candidate of invalid) {
    assert.throws(
      () => createRuntimeProofReplayLedger(candidate),
      (error) => {
        assert.equal(error.name, "TypeError");
        assert.equal(
          error.message,
          "Runtime proof replay ledger configuration is invalid.",
        );
        return true;
      },
    );
  }
});

test("invalid clock results fail closed before DynamoDB", async () => {
  for (const now of [
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    new Date("invalid"),
    "2026-08-25T00:00:00.000Z",
  ]) {
    const dynamo = fakeDynamo();
    const value = createRuntimeProofReplayLedger({
      tableName: "PlatformState",
      dynamo,
      clock: () => now,
    });
    await assert.rejects(
      value.consume(proof()),
      /ledger configuration is invalid/i,
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("DynamoDB failures are sanitized and never treated as successful consumption", async () => {
  const { value } = ledger(fakeDynamo(async () => {
    throw new Error(
      "TOP-SECRET table PlatformState in account 123456789012 failed",
    );
  }));

  await assert.rejects(
    value.consume(proof()),
    (error) => {
      assert.ok(error instanceof RuntimeProofReplayLedgerError);
      assert.equal(error.code, "RUNTIME_PROOF_REPLAY_UNAVAILABLE");
      assert.equal(error.message, "Runtime proof replay ledger unavailable.");
      assert.equal(error.message.includes("TOP-SECRET"), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
