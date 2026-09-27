import { createHash } from "node:crypto";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";

const CONFIG_KEYS = Object.freeze(["tableName", "dynamo", "clock"]);
const INPUT_KEYS = Object.freeze(["audience", "nonce", "expiresAt"]);
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_AUDIENCE_BYTES = 1_024;
const MAX_PROOF_TTL_MS = 5 * 60_000;

export class RuntimeProofReplayLedgerError extends Error {
  constructor() {
    super("Runtime proof replay ledger unavailable.");
    this.name = "RuntimeProofReplayLedgerError";
    this.code = "RUNTIME_PROOF_REPLAY_UNAVAILABLE";
  }
}

function invalidConfiguration() {
  return new TypeError(
    "Runtime proof replay ledger configuration is invalid.",
  );
}

function invalidInput() {
  return new TypeError("Runtime proof replay input is invalid.");
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataValues(value, keys) {
  if (!isPlainObject(value)) return null;
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== keys.length
    || actualKeys.some(
      (key) => typeof key !== "string" || !keys.includes(key),
    )
  ) {
    return null;
  }

  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      return null;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function clockTime(clock) {
  const result = clock();
  const milliseconds = result instanceof Date
    ? result.getTime()
    : result;
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
  ) {
    throw invalidConfiguration();
  }
  return milliseconds;
}

function validAudience(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= MAX_AUDIENCE_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validNonce(value) {
  if (
    typeof value !== "string"
    || !NONCE_PATTERN.test(value)
  ) {
    return false;
  }
  const bytes = Buffer.from(value, "base64url");
  return (
    bytes.byteLength === 32
    && bytes.toString("base64url") === value
  );
}

function validateInput(input, now) {
  const values = exactDataValues(input, INPUT_KEYS);
  if (
    values === null
    || !validAudience(values.audience)
    || !validNonce(values.nonce)
    || !Number.isSafeInteger(values.expiresAt)
    || values.expiresAt <= now
    || values.expiresAt - now > MAX_PROOF_TTL_MS
  ) {
    throw invalidInput();
  }
  return values;
}

function string(value) {
  return { S: value };
}

function number(value) {
  return { N: String(value) };
}

function isConditionalConflict(error) {
  return (
    error !== null
    && typeof error === "object"
    && error.name === "ConditionalCheckFailedException"
  );
}

export function createRuntimeProofReplayLedger(configuration) {
  const values = exactDataValues(configuration, CONFIG_KEYS);
  if (
    values === null
    || typeof values.tableName !== "string"
    || !TABLE_NAME_PATTERN.test(values.tableName)
    || values.tableName !== values.tableName.trim()
    || values.dynamo === null
    || typeof values.dynamo !== "object"
    || typeof values.dynamo.send !== "function"
    || typeof values.clock !== "function"
  ) {
    throw invalidConfiguration();
  }

  const {
    tableName,
    dynamo,
    clock,
  } = values;

  return Object.freeze({
    async consume(input) {
      const now = clockTime(clock);
      const proof = validateInput(input, now);
      const audienceHash = createHash("sha256")
        .update(proof.audience, "utf8")
        .digest("hex");

      try {
        await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: {
            pk: string(`RUNTIME_PROOF#${audienceHash}`),
            sk: string(`NONCE#${proof.nonce}`),
            entityType: string("RUNTIME_PROOF_REPLAY"),
            expiresAt: number(Math.ceil(proof.expiresAt / 1_000)),
          },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }));
        return true;
      } catch (error) {
        if (isConditionalConflict(error)) return false;
        throw new RuntimeProofReplayLedgerError();
      }
    },
  });
}
