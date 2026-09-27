import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION_ID_PATTERN =
  /^session-[a-f0-9]{16}-[a-f0-9]{16}$/;
const PUBLIC_AGENT_ID_PATTERN = /^agent-[a-f0-9]{32}$/;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

function ownDataValue(value, key) {
  if (!isPlainObject(value)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  ) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

function exactValues(value, keys) {
  if (!isPlainObject(value)) return null;
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const result = {};
  for (const key of keys) {
    const property = ownDataValue(value, key);
    if (!property.present) return null;
    result[key] = property.value;
  }
  return result;
}

function validText(
  value,
  maxLength,
  { allowEmpty = false } = {},
) {
  return (
    typeof value === "string"
    && value.length <= maxLength
    && (
      allowEmpty
        ? value.length === 0 || value.trim().length > 0
        : value.length > 0 && value.trim().length > 0
    )
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function string(value) {
  return { S: value };
}

function number(value) {
  return { N: String(value) };
}

function nativeString(item, key) {
  const property = ownDataValue(item, key);
  if (
    !property.present
    || !isPlainObject(property.value)
    || Reflect.ownKeys(property.value).length !== 1
    || typeof property.value.S !== "string"
  ) {
    return null;
  }
  return property.value.S;
}

function nativeNumber(item, key) {
  const property = ownDataValue(item, key);
  if (
    !property.present
    || !isPlainObject(property.value)
    || Reflect.ownKeys(property.value).length !== 1
    || typeof property.value.N !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(property.value.N)
  ) {
    return null;
  }
  return Number(property.value.N);
}

function validateAgentRef(value) {
  const agent = exactValues(
    value,
    ["domainId", "projectId", "agentId"],
  );
  if (
    agent === null
    || !DOMAIN_ID_PATTERN.test(agent.domainId)
    || !SLUG_PATTERN.test(agent.projectId)
    || !SLUG_PATTERN.test(agent.agentId)
  ) {
    return null;
  }
  return agent;
}

function validateCommon(input, route, extraKeys) {
  const values = exactValues(input, [
    "actor",
    "effectiveRole",
    "requestId",
    "route",
    "payloadFingerprint",
    ...extraKeys,
  ]);
  if (
    values === null
    || !SUBJECT_PATTERN.test(values.actor)
    || values.effectiveRole !== "user"
    || !REQUEST_ID_PATTERN.test(values.requestId)
    || values.route !== route
    || !FINGERPRINT_PATTERN.test(values.payloadFingerprint)
  ) {
    return null;
  }
  return values;
}

function stableId(type, input) {
  const digest = createHash("sha256")
    .update(
      `${type}\0${input.actor}\0${input.route}\0`
      + `${input.requestId}\0${input.payloadFingerprint}`,
    )
    .digest("hex")
    .slice(0, 32);
  return `${type.toLowerCase()}-${digest}`;
}

function commonRecord(type, status, input, createdAt) {
  const id = stableId(type, input);
  return {
    pk: string(`SUBMISSION#${input.actor}`),
    sk: string(`${type}#${id}`),
    entityType: string("EXPERIENCE_SUBMISSION"),
    submissionType: string(type),
    id: string(id),
    status: string(status),
    actor: string(input.actor),
    effectiveRole: string("user"),
    route: string(input.route),
    requestId: string(input.requestId),
    payloadFingerprint: string(input.payloadFingerprint),
    createdAt: string(createdAt),
  };
}

function feedbackRecord(input, createdAt) {
  const values = validateCommon(
    input,
    "POST /api/experience/feedback",
    ["agent", "sessionId", "rating", "comment"],
  );
  const agent = values && validateAgentRef(values.agent);
  if (
    values === null
    || agent === null
    || !SESSION_ID_PATTERN.test(values.sessionId)
    || !Number.isSafeInteger(values.rating)
    || values.rating < 1
    || values.rating > 5
    || !validText(values.comment, 2_048, { allowEmpty: true })
  ) {
    return null;
  }
  return {
    ...commonRecord("FEEDBACK", "RECORDED", values, createdAt),
    domainId: string(agent.domainId),
    projectId: string(agent.projectId),
    agentId: string(agent.agentId),
    sessionId: string(values.sessionId),
    rating: number(values.rating),
    comment: string(values.comment),
  };
}

function issueRecord(input, createdAt) {
  const values = validateCommon(
    input,
    "POST /api/experience/issues",
    ["agent", "sessionId", "description"],
  );
  const agent = values && validateAgentRef(values.agent);
  if (
    values === null
    || agent === null
    || !SESSION_ID_PATTERN.test(values.sessionId)
    || !validText(values.description, 4_096)
  ) {
    return null;
  }
  return {
    ...commonRecord("ISSUE", "RECORDED", values, createdAt),
    domainId: string(agent.domainId),
    projectId: string(agent.projectId),
    agentId: string(agent.agentId),
    sessionId: string(values.sessionId),
    description: string(values.description),
  };
}

function accessRecord(input, createdAt) {
  const values = validateCommon(
    input,
    "POST /api/experience/access-requests",
    ["publicAgentId", "reason"],
  );
  if (
    values === null
    || !PUBLIC_AGENT_ID_PATTERN.test(values.publicAgentId)
    || !validText(values.reason, 2_048)
  ) {
    return null;
  }
  return {
    ...commonRecord("ACCESS", "PENDING", values, createdAt),
    publicAgentId: string(values.publicAgentId),
    reason: string(values.reason),
  };
}

function validDynamoResponse(value) {
  return isPlainObject(value);
}

function replayResult(item, expected) {
  if (!isPlainObject(item)) {
    throw new Error("Submission conflict.");
  }
  const expectedKeys = Reflect.ownKeys(expected);
  if (
    Reflect.ownKeys(item).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(item, key))
  ) {
    throw new Error("Submission conflict.");
  }
  const storedCreatedAt = nativeString(item, "createdAt");
  if (
    storedCreatedAt === null
    || !ISO_PATTERN.test(storedCreatedAt)
    || Number.isNaN(Date.parse(storedCreatedAt))
  ) {
    throw new Error("Submission conflict.");
  }
  const comparableItem = { ...item, createdAt: expected.createdAt };
  if (!isDeepStrictEqual(comparableItem, expected)) {
    throw new Error("Submission conflict.");
  }
  const id = nativeString(item, "id");
  const status = nativeString(item, "status");
  if (id === null || status === null) {
    throw new Error("Submission conflict.");
  }
  return { id, status };
}

async function writeSubmission({
  tableName,
  dynamo,
  record,
}) {
  if (record === null) {
    throw new TypeError("Submission input is invalid.");
  }
  try {
    const response = await dynamo.send(new PutItemCommand({
      TableName: tableName,
      Item: record,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    }));
    if (!validDynamoResponse(response)) {
      throw new Error("Submission storage failed.");
    }
    return {
      id: nativeString(record, "id"),
      status: nativeString(record, "status"),
    };
  } catch (error) {
    if (error?.name !== "ConditionalCheckFailedException") {
      if (error?.message === "Submission storage failed.") throw error;
      throw new Error("Submission storage failed.");
    }
  }

  let response;
  try {
    response = await dynamo.send(new GetItemCommand({
      TableName: tableName,
      Key: { pk: record.pk, sk: record.sk },
      ConsistentRead: true,
    }));
  } catch {
    throw new Error("Submission storage failed.");
  }
  if (!validDynamoResponse(response)) {
    throw new Error("Submission storage failed.");
  }
  return replayResult(response.Item, record);
}

export function createExperienceSubmissionStore({
  tableName,
  dynamo,
  now,
} = {}) {
  if (
    typeof tableName !== "string"
    || tableName.length === 0
    || tableName.length > 255
    || !dynamo
    || typeof dynamo.send !== "function"
    || typeof now !== "function"
  ) {
    throw new TypeError("Submission store configuration is invalid.");
  }

  function timestamp() {
    const value = now();
    if (
      !(value instanceof Date)
      || Number.isNaN(value.getTime())
    ) {
      throw new Error("Submission storage failed.");
    }
    return value.toISOString();
  }

  return Object.freeze({
    async submitFeedback(input) {
      return writeSubmission({
        tableName,
        dynamo,
        record: feedbackRecord(input, timestamp()),
      });
    },
    async reportIssue(input) {
      return writeSubmission({
        tableName,
        dynamo,
        record: issueRecord(input, timestamp()),
      });
    },
    async requestAccess(input) {
      return writeSubmission({
        tableName,
        dynamo,
        record: accessRecord(input, timestamp()),
      });
    },
  });
}
