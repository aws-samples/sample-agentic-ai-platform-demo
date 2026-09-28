import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { validAccounting } from "../agent-runtime/usage.mjs";
import { costJournalEnabled } from "./journal-compatibility.mjs";
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION_ID_PATTERN =
  /^session-[a-f0-9]{16}-[a-f0-9]{16}$/;
const RESULT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_OUTPUT_BYTES = 64 * 1024;
const NONE = "NONE";
const pendingLifecycle = () => ({
  version: 1, environment: "PRODUCTION", purpose: "user", startedAt: null, region: null,
});

export function validInvocationLifecycle(value) {
  const values = exactValues(value, ["version", "environment", "purpose", "startedAt", "region"]);
  return values !== null && values.version === 1
    && values.environment === "PRODUCTION" && values.purpose === "user"
    && ((values.startedAt === null && values.region === null)
      || (validTimestamp(values.startedAt) && typeof values.region === "string"
        && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(values.region)));
}

class InvocationJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InvocationJournalError";
    this.code = code;
  }
}

function conflict() {
  throw new InvocationJournalError(
    "INVOCATION_JOURNAL_CONFLICT",
    "Invocation journal conflict.",
  );
}

function unavailable() {
  throw new InvocationJournalError(
    "INVOCATION_JOURNAL_UNAVAILABLE",
    "Invocation journal unavailable.",
  );
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
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

function validTimestamp(value) {
  return (
    typeof value === "string"
    && ISO_PATTERN.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
  );
}

function validOutput(value) {
  return (
    typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function validateBinding(input, keys) {
  const values = exactValues(input, keys);
  if (
    values === null
    || !SUBJECT_PATTERN.test(values.actor)
    || !REQUEST_ID_PATTERN.test(values.requestId)
    || !FINGERPRINT_PATTERN.test(values.payloadFingerprint)
  ) {
    return null;
  }
  return values;
}

function validateStart(input) {
  const values = validateBinding(input, [
    "actor",
    "requestId",
    "payloadFingerprint",
    "sessionId",
    "domainId",
    "projectId",
    "agentId",
    "baselineFingerprint",
  ]);
  if (
    values === null
    || !SESSION_ID_PATTERN.test(values.sessionId)
    || !DOMAIN_ID_PATTERN.test(values.domainId)
    || !SLUG_PATTERN.test(values.projectId)
    || !SLUG_PATTERN.test(values.agentId)
    || !(
      values.baselineFingerprint === null
      || FINGERPRINT_PATTERN.test(values.baselineFingerprint)
    )
  ) {
    return null;
  }
  return values;
}

function validateGet(input) {
  return validateBinding(input, [
    "actor",
    "requestId",
    "payloadFingerprint",
  ]);
}

function validateComplete(input) {
  const values = validateBinding(input, [
    "actor",
    "requestId",
    "payloadFingerprint",
    "sessionId",
    "domainId",
    "projectId",
    "agentId",
    "baselineFingerprint",
    "runtimeStatus",
    "output",
    "invocationId",
    ...(isPlainObject(input) && Object.hasOwn(input, "accounting") ? ["accounting"] : []),
  ]);
  if (
    values === null
    || !SESSION_ID_PATTERN.test(values.sessionId)
    || !DOMAIN_ID_PATTERN.test(values.domainId)
    || !SLUG_PATTERN.test(values.projectId)
    || !SLUG_PATTERN.test(values.agentId)
    || !(
      values.baselineFingerprint === null
      || FINGERPRINT_PATTERN.test(values.baselineFingerprint)
    )
    || (values.accounting !== undefined && (
      !validAccounting(values.accounting)
      || values.runtimeStatus !== "SUCCEEDED"
      || values.accounting.runId !== createHash("sha256")
        .update(`${values.actor}\0${values.requestId}`).digest("hex")
    ))
    || !(
      (
        values.runtimeStatus === "SUCCEEDED"
        && validOutput(values.output)
        && RESULT_ID_PATTERN.test(values.invocationId)
      )
      || (
        values.runtimeStatus === "FAILED"
        && values.output === null
        && values.invocationId === null
      )
    )
  ) {
    return null;
  }
  return values;
}

function string(value) {
  return { S: value };
}

function nullableString(value) {
  return value === null ? { NULL: true } : string(value);
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

function nativeNullableString(item, key) {
  const property = ownDataValue(item, key);
  if (!property.present || !isPlainObject(property.value)) {
    return { valid: false, value: undefined };
  }
  const keys = Reflect.ownKeys(property.value);
  if (keys.length !== 1) return { valid: false, value: undefined };
  if (property.value.NULL === true) return { valid: true, value: null };
  if (typeof property.value.S === "string") {
    return { valid: true, value: property.value.S };
  }
  return { valid: false, value: undefined };
}

function key(input) {
  return {
    pk: string(`EXPERIENCE_INVOCATION#${input.actor}`),
    sk: string(`REQUEST#${input.requestId}`),
  };
}

function projection(record) {
  return {
    actor: record.actor,
    requestId: record.requestId,
    payloadFingerprint: record.payloadFingerprint,
    sessionId: record.sessionId,
    domainId: record.domainId,
    projectId: record.projectId,
    agentId: record.agentId,
    baselineFingerprint: record.baselineFingerprint,
    phase: record.phase,
    runtimeStatus: record.runtimeStatus,
    output: record.output,
    invocationId: record.invocationId,
    ...(record.accounting === undefined ? {} : { accounting: record.accounting }),
    ...(record.lifecycle === undefined ? {} : { lifecycle: record.lifecycle }),
  };
}

function startedRecord(input, createdAt, costWritesEnabled) {
  return {
    ...input,
    phase: "STARTED",
    runtimeStatus: null,
    output: null,
    invocationId: null,
    createdAt,
    completedAt: null,
    ...(costWritesEnabled ? { lifecycle: pendingLifecycle() } : {}),
  };
}

function toItem(record) {
  return {
    ...key(record),
    entityType: string("EXPERIENCE_INVOCATION"),
    actor: string(record.actor),
    requestId: string(record.requestId),
    payloadFingerprint: string(record.payloadFingerprint),
    sessionId: string(record.sessionId),
    domainId: string(record.domainId),
    projectId: string(record.projectId),
    agentId: string(record.agentId),
    baselineFingerprint: string(
      record.baselineFingerprint === null
        ? NONE
        : record.baselineFingerprint,
    ),
    phase: string(record.phase),
    createdAt: string(record.createdAt),
    ...(record.lifecycle === undefined ? {} : { lifecycle: string(JSON.stringify(record.lifecycle)) }),
    ...(record.phase === "COMPLETED"
      ? {
        runtimeStatus: string(record.runtimeStatus),
        output: nullableString(record.output),
        invocationId: nullableString(record.invocationId),
        completedAt: string(record.completedAt),
      }
      : {}),
  };
}

function fromItem(item) {
  if (!isPlainObject(item)) conflict();
  const phase = nativeString(item, "phase");
  const expectedKeys = phase === "COMPLETED"
    ? [
      "pk",
      "sk",
      "entityType",
      "actor",
      "requestId",
      "payloadFingerprint",
      "sessionId",
      "domainId",
      "projectId",
      "agentId",
      "baselineFingerprint",
      "phase",
      "createdAt",
      "runtimeStatus",
      "output",
      "invocationId",
      "completedAt",
    ]
    : [
      "pk",
      "sk",
      "entityType",
      "actor",
      "requestId",
      "payloadFingerprint",
      "sessionId",
      "domainId",
      "projectId",
      "agentId",
      "baselineFingerprint",
      "phase",
      "createdAt",
    ];
  if (phase === "COMPLETED" && Object.hasOwn(item, "accounting")) expectedKeys.push("accounting");
  if (Object.hasOwn(item, "lifecycle")) expectedKeys.push("lifecycle");
  if (
    Reflect.ownKeys(item).length !== expectedKeys.length
    || expectedKeys.some((name) => !Object.hasOwn(item, name))
    || nativeString(item, "entityType") !== "EXPERIENCE_INVOCATION"
  ) {
    conflict();
  }
  const baseline = nativeString(item, "baselineFingerprint");
  const record = {
    actor: nativeString(item, "actor"),
    requestId: nativeString(item, "requestId"),
    payloadFingerprint: nativeString(item, "payloadFingerprint"),
    sessionId: nativeString(item, "sessionId"),
    domainId: nativeString(item, "domainId"),
    projectId: nativeString(item, "projectId"),
    agentId: nativeString(item, "agentId"),
    baselineFingerprint: baseline === NONE ? null : baseline,
    phase,
    runtimeStatus: null,
    output: null,
    invocationId: null,
    createdAt: nativeString(item, "createdAt"),
    completedAt: null,
  };
  if (
    validateStart({
      actor: record.actor,
      requestId: record.requestId,
      payloadFingerprint: record.payloadFingerprint,
      sessionId: record.sessionId,
      domainId: record.domainId,
      projectId: record.projectId,
      agentId: record.agentId,
      baselineFingerprint: record.baselineFingerprint,
    }) === null
    || !validTimestamp(record.createdAt)
    || !isDeepStrictEqual(key(record), {
      pk: item.pk,
      sk: item.sk,
    })
  ) {
    conflict();
  }
  if (Object.hasOwn(item, "lifecycle")) {
    try {
      record.lifecycle = JSON.parse(nativeString(item, "lifecycle"));
    } catch {
      conflict();
    }
    if (!validInvocationLifecycle(record.lifecycle)
      || (record.lifecycle.startedAt !== null && record.lifecycle.startedAt < record.createdAt)) conflict();
  }
  if (phase === "STARTED") return record;
  if (phase !== "COMPLETED") conflict();
  const output = nativeNullableString(item, "output");
  const invocationId = nativeNullableString(item, "invocationId");
  record.runtimeStatus = nativeString(item, "runtimeStatus");
  record.output = output.value;
  record.invocationId = invocationId.value;
  record.completedAt = nativeString(item, "completedAt");
  if (Object.hasOwn(item, "accounting")) {
    try {
      record.accounting = JSON.parse(nativeString(item, "accounting"));
    } catch {
      conflict();
    }
  }
  if (
    !output.valid
    || !invocationId.valid
    || validateComplete({
      actor: record.actor,
      requestId: record.requestId,
      payloadFingerprint: record.payloadFingerprint,
      sessionId: record.sessionId,
      domainId: record.domainId,
      projectId: record.projectId,
      agentId: record.agentId,
      baselineFingerprint: record.baselineFingerprint,
      runtimeStatus: record.runtimeStatus,
      output: record.output,
      invocationId: record.invocationId,
      ...(record.accounting === undefined ? {} : { accounting: record.accounting }),
    }) === null
    || !validTimestamp(record.completedAt)
    || record.completedAt < record.createdAt
    || (record.lifecycle?.startedAt != null && record.completedAt < record.lifecycle.startedAt)
  ) {
    conflict();
  }
  return record;
}

function sameBinding(record, input) {
  return (
    record.actor === input.actor
    && record.requestId === input.requestId
    && record.payloadFingerprint === input.payloadFingerprint
    && record.sessionId === input.sessionId
    && record.domainId === input.domainId
    && record.projectId === input.projectId
    && record.agentId === input.agentId
    && record.baselineFingerprint === input.baselineFingerprint
  );
}

function validateDynamoResponse(value) {
  if (!isPlainObject(value)) unavailable();
}

// Offline preflight contract. The caller must establish a complete inventory
// after disabling/draining ALL writers; a scoped/eventual GSI query is not proof.
export function assertInvocationJournalRollbackSafe({
  items, readerVersion, writerVersion, writersDrained, inventoryComplete,
} = {}) {
  const unsafe = () => {
    throw new InvocationJournalError("UNSAFE_INVOCATION_JOURNAL_ROLLBACK",
      "Disable and drain writers, prove a complete inventory, and retain compatible readers or require a reviewed migration.");
  };
  if (writerVersion !== "legacy" || writersDrained !== true || inventoryComplete !== true
    || !["legacy", "accounting-v1", "cost-v1"].includes(readerVersion)
    || !Array.isArray(items)) unsafe();
  for (const item of items) {
    let record;
    try { record = fromItem(item); } catch { unsafe(); }
    if ((record.lifecycle !== undefined && readerVersion !== "cost-v1")
      || (record.accounting !== undefined && readerVersion === "legacy")) unsafe();
  }
  return true;
}

export function createExperienceInvocationStore({
  tableName,
  dynamo,
  now,
  compatibility,
} = {}) {
  const costWritesEnabled = costJournalEnabled(compatibility);
  if (
    typeof tableName !== "string"
    || tableName.length === 0
    || tableName.length > 255
    || !dynamo
    || typeof dynamo.send !== "function"
    || typeof now !== "function"
  ) {
    throw new TypeError("Invocation journal configuration is invalid.");
  }

  function timestamp() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      unavailable();
    }
    return value.toISOString();
  }

  async function read(input) {
    let response;
    try {
      response = await dynamo.send(new GetItemCommand({
        TableName: tableName,
        Key: key(input),
        ConsistentRead: true,
      }));
      validateDynamoResponse(response);
    } catch (error) {
      if (error instanceof InvocationJournalError) throw error;
      unavailable();
    }
    if (response.Item === undefined) return null;
    const record = fromItem(response.Item);
    if (
      record.actor !== input.actor
      || record.requestId !== input.requestId
      || record.payloadFingerprint !== input.payloadFingerprint
    ) {
      conflict();
    }
    return record;
  }

  return Object.freeze({
    // Internal reader: callers resolve authorized domain/project pairs first.
    // The existing GSI is eventually consistent and ordered by request, not time.
    async listByProject(input) {
      if (exactValues(input, ["domainId", "projectId",
        ...(isPlainObject(input) && Object.hasOwn(input, "cursor") ? ["cursor"] : []),
        ...(isPlainObject(input) && Object.hasOwn(input, "abortSignal") ? ["abortSignal"] : [])]) === null
        || typeof input.domainId !== "string" || !DOMAIN_ID_PATTERN.test(input.domainId)
        || typeof input.projectId !== "string" || !SLUG_PATTERN.test(input.projectId)) {
        throw new TypeError("Invocation journal scope is invalid.");
      }
      function validateCursor(cursor) {
        if (exactValues(cursor, ["pk", "sk", "entityType"]) === null
          || nativeString(cursor, "entityType") !== "EXPERIENCE_INVOCATION"
          || !nativeString(cursor, "pk")?.startsWith("EXPERIENCE_INVOCATION#")
          || !SUBJECT_PATTERN.test(nativeString(cursor, "pk").slice("EXPERIENCE_INVOCATION#".length))
          || !nativeString(cursor, "sk")?.startsWith("REQUEST#")
          || !REQUEST_ID_PATTERN.test(nativeString(cursor, "sk").slice("REQUEST#".length))) conflict();
        return cursor;
      }
      if (input.abortSignal?.aborted) throw Object.assign(new Error("Journal read aborted."), { name: "AbortError" });
      const response = await dynamo.send(new QueryCommand({
        TableName: tableName,
        IndexName: "EntityTypeIndex",
        KeyConditionExpression: "#entityType = :entityType",
        FilterExpression: "#domainId = :domainId AND #projectId = :projectId",
        ExpressionAttributeNames: {
          "#entityType": "entityType", "#domainId": "domainId", "#projectId": "projectId",
        },
        ExpressionAttributeValues: {
          ":entityType": string("EXPERIENCE_INVOCATION"),
          ":domainId": string(input.domainId), ":projectId": string(input.projectId),
        },
        Limit: 100,
        ...(input.cursor === undefined ? {} : { ExclusiveStartKey: validateCursor(input.cursor) }),
      }), input.abortSignal ? { abortSignal: input.abortSignal } : undefined);
      validateDynamoResponse(response);
      if (response.Items !== undefined && (!Array.isArray(response.Items) || response.Items.length > 100)) conflict();
      const items = (response.Items ?? []).map(item => {
        const record = fromItem(item);
        if (record.domainId !== input.domainId || record.projectId !== input.projectId) conflict();
        return {
          runId: createHash("sha256").update(`${record.actor}\0${record.requestId}`).digest("hex"),
          domainId: record.domainId, projectId: record.projectId,
          phase: record.phase, runtimeStatus: record.runtimeStatus,
          createdAt: record.createdAt, completedAt: record.completedAt,
          lifecycle: record.lifecycle ?? null, accounting: record.accounting ?? null,
        };
      });
      return { items, cursor: response.LastEvaluatedKey === undefined
        ? null : validateCursor(response.LastEvaluatedKey) };
    },

    ...(costWritesEnabled ? { async markDispatched(input) {
      const fields = exactValues(input, ["actor", "requestId", "payloadFingerprint", "sessionId",
        "domainId", "projectId", "agentId", "baselineFingerprint", "region"]);
      const { region, ...start } = fields ?? {};
      const values = validateStart(start);
      const lifecycle = { ...pendingLifecycle(), startedAt: timestamp(), region };
      if (values === null || !validInvocationLifecycle(lifecycle)) {
        throw new TypeError("Invocation journal dispatch is invalid.");
      }
      const stored = await read(values);
      if (!stored || stored.phase !== "STARTED" || !sameBinding(stored, values) || !stored.lifecycle) conflict();
      if (stored.lifecycle.startedAt !== null) {
        if (stored.lifecycle.region !== input.region) conflict();
        return projection(stored);
      }
      try {
        const response = await dynamo.send(new UpdateItemCommand({
          TableName: tableName, Key: key(values),
          UpdateExpression: "SET #lifecycle = :lifecycle",
          ConditionExpression: "#phase = :started AND #lifecycle = :pending AND #payloadFingerprint = :fingerprint",
          ExpressionAttributeNames: {
            "#phase": "phase", "#lifecycle": "lifecycle", "#payloadFingerprint": "payloadFingerprint",
          },
          ExpressionAttributeValues: {
            ":started": string("STARTED"), ":pending": string(JSON.stringify(pendingLifecycle())),
            ":lifecycle": string(JSON.stringify(lifecycle)), ":fingerprint": string(values.payloadFingerprint),
          },
          ReturnValues: "ALL_NEW",
        }));
        validateDynamoResponse(response);
        const record = fromItem(response.Attributes);
        if (!sameBinding(record, values) || !isDeepStrictEqual(record.lifecycle, lifecycle)) conflict();
        return projection(record);
      } catch (error) {
        // An ambiguous marker write must never proceed to Runtime dispatch.
        if (error instanceof InvocationJournalError) throw error;
        unavailable();
      }
    } } : {}),

    async get(input) {
      const values = validateGet(input);
      if (values === null) {
        throw new TypeError("Invocation journal input is invalid.");
      }
      const record = await read(values);
      return record === null ? null : projection(record);
    },

    async start(input) {
      const values = validateStart(input);
      if (values === null) {
        throw new TypeError("Invocation journal input is invalid.");
      }
      const record = startedRecord(values, timestamp(), costWritesEnabled);
      try {
        const response = await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: toItem(record),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }));
        validateDynamoResponse(response);
        return projection(record);
      } catch (error) {
        if (error?.name !== "ConditionalCheckFailedException") {
          if (error instanceof InvocationJournalError) throw error;
          unavailable();
        }
      }
      const stored = await read(values);
      if (
        stored === null
        || stored.phase !== "STARTED"
        || !sameBinding(stored, values)
      ) {
        conflict();
      }
      return projection(stored);
    },

    async complete(input) {
      const values = validateComplete(input);
      if (values === null) {
        throw new TypeError("Invocation journal input is invalid.");
      }
      // Runtime may already return accounting during the reader-first rollout.
      // Omit it from new writes without mutating input or existing stored rows.
      const suppliedAccounting = values.accounting;
      if (!costWritesEnabled) delete values.accounting;
      const completedAt = timestamp();
      const names = {
        "#actor": "actor",
        "#requestId": "requestId",
        "#payloadFingerprint": "payloadFingerprint",
        "#sessionId": "sessionId",
        "#domainId": "domainId",
        "#projectId": "projectId",
        "#agentId": "agentId",
        "#baselineFingerprint": "baselineFingerprint",
        "#phase": "phase",
        "#runtimeStatus": "runtimeStatus",
        "#output": "output",
        "#invocationId": "invocationId",
        "#completedAt": "completedAt",
      };
      const expressionValues = {
        ":actor": string(values.actor),
        ":requestId": string(values.requestId),
        ":payloadFingerprint": string(values.payloadFingerprint),
        ":sessionId": string(values.sessionId),
        ":domainId": string(values.domainId),
        ":projectId": string(values.projectId),
        ":agentId": string(values.agentId),
        ":baselineFingerprint": string(
          values.baselineFingerprint === null
            ? NONE
            : values.baselineFingerprint,
        ),
        ":started": string("STARTED"),
        ":completed": string("COMPLETED"),
        ":runtimeStatus": string(values.runtimeStatus),
        ":output": nullableString(values.output),
        ":invocationId": nullableString(values.invocationId),
        ":completedAt": string(completedAt),
      };
      if (values.accounting !== undefined) {
        names["#accounting"] = "accounting";
        expressionValues[":accounting"] = string(JSON.stringify(values.accounting));
      }
      let response;
      try {
        response = await dynamo.send(new UpdateItemCommand({
          TableName: tableName,
          Key: key(values),
          UpdateExpression:
            "SET #phase = :completed, "
            + "#runtimeStatus = :runtimeStatus, #output = :output, "
            + "#invocationId = :invocationId, "
            + "#completedAt = :completedAt"
            + (values.accounting === undefined ? "" : ", #accounting = :accounting"),
          ConditionExpression:
            "#actor = :actor AND #requestId = :requestId "
            + "AND #payloadFingerprint = :payloadFingerprint "
            + "AND #sessionId = :sessionId "
            + "AND #domainId = :domainId "
            + "AND #projectId = :projectId "
            + "AND #agentId = :agentId "
            + "AND #baselineFingerprint = :baselineFingerprint "
            + "AND #phase = :started",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: expressionValues,
          ReturnValues: "ALL_NEW",
        }));
        validateDynamoResponse(response);
        if (response.Attributes === undefined) unavailable();
        const stored = fromItem(response.Attributes);
        if (
          stored.phase !== "COMPLETED"
          || !sameBinding(stored, values)
          || stored.runtimeStatus !== values.runtimeStatus
          || stored.output !== values.output
          || stored.invocationId !== values.invocationId
          || !isDeepStrictEqual(stored.accounting, values.accounting)
        ) {
          conflict();
        }
        return projection(stored);
      } catch (error) {
        if (error?.name !== "ConditionalCheckFailedException") {
          if (error instanceof InvocationJournalError) throw error;
          unavailable();
        }
      }
      const stored = await read(values);
      if (
        stored === null
        || stored.phase !== "COMPLETED"
        || !sameBinding(stored, values)
        || stored.runtimeStatus !== values.runtimeStatus
        || stored.output !== values.output
        || stored.invocationId !== values.invocationId
        || !isDeepStrictEqual(stored.accounting,
          !costWritesEnabled && stored.accounting !== undefined ? suppliedAccounting : values.accounting)
      ) {
        conflict();
      }
      return projection(stored);
    },
  });
}
