import { isDeepStrictEqual } from "node:util";
import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";

const CONFIG_KEYS = new Set(["tableName", "dynamo", "now"]);
const POLICY_KEYS = new Set([
  "modelId",
  "allowedDomains",
  "requestableDomains",
  "limits",
  "revision",
  "applicationStatus",
  "rateLimit",
  "updatedBySubject",
  "updatedAt",
]);
const LIMIT_KEYS = new Set([
  "requestsPerMinute",
  "tokensPerMinute",
  "connectionsPerSecond",
]);
const RATE_LIMIT_KEYS = new Set([
  "id",
  "status",
  "reason",
  "reconciledAt",
]);
const MUTATION_KEYS = new Set([
  "actor",
  "effectiveRole",
  "route",
  "requestId",
  "payloadFingerprint",
  "resourceKey",
  "operation",
  "decision",
  "reason",
  "timestamp",
]);
const POLICY_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...POLICY_KEYS,
]);
const MUTATION_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...MUTATION_KEYS,
  "result",
]);
const PUT_KEYS = new Set([
  "record",
  "expectedRevision",
  "mutation",
  "transaction",
]);
const FINALIZE_KEYS = new Set([
  "record",
  "expectedStatus",
  "mutation",
  "transaction",
]);
const GET_KEYS = new Set(["modelId", "abortSignal"]);
const LIST_KEYS = new Set(["limit", "cursor", "abortSignal"]);
const MUTATION_LOOKUP_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "abortSignal",
]);
const CURSOR_KEYS = new Set(["pk", "sk"]);

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const POLICY_ROUTE = "POST /api/ai-gateway/model-policies";
const APPLICATION_ROUTE = "POST /internal/model-policies/application";
const POLICY_PARTITION = "MODEL_POLICY";
const POLICY_SORT_PREFIX = "MODEL#";
const MAX_POLICY_DOMAINS = 100;
const MAX_REVISION = 1_000_000_000;
const MAX_PAGE_SIZE = 100;
const LIMIT_MAXIMUMS = Object.freeze({
  requestsPerMinute: 1_000_000,
  tokensPerMinute: 1_000_000_000,
  connectionsPerSecond: 10_000,
});

export class ModelPolicyStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelPolicyStateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ModelPolicyStateError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return (
    isPlainObject(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

function validatePattern(value, pattern, maximum, code, message) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || !pattern.test(value)
  ) {
    fail(code, message);
  }
  return value;
}

function validateTimestamp(value, code, message) {
  if (typeof value !== "string" || value.length > 32) {
    fail(code, message);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(code, message);
  }
  return value;
}

function transactionTimestamp(now) {
  let value;
  try {
    value = now();
  } catch {
    fail(
      "INVALID_MODEL_POLICY_MUTATION",
      "Model policy transaction clock is malformed.",
    );
  }
  return validateTimestamp(
    value,
    "INVALID_MODEL_POLICY_MUTATION",
    "Model policy transaction clock is malformed.",
  );
}

function validateModelId(value, code) {
  return validatePattern(
    value,
    MODEL_ID_PATTERN,
    256,
    code,
    "Model ID is malformed.",
  );
}

function validateSubject(value, code) {
  return validatePattern(
    value,
    SUBJECT_PATTERN,
    256,
    code,
    "Model policy subject is malformed.",
  );
}

function validateDomains(value, code) {
  if (!Array.isArray(value)) {
    fail(code, "Model policy domains are malformed.");
  }
  const domains = value.map((domainId) =>
    validatePattern(
      domainId,
      DOMAIN_ID_PATTERN,
      64,
      code,
      "Model policy domains are malformed.",
    ));
  if (new Set(domains).size !== domains.length) {
    fail(code, "Model policy domains are malformed.");
  }
  return domains;
}

function validateNullableLimit(value, field, code) {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > LIMIT_MAXIMUMS[field]
  ) {
    fail(code, "Model policy limits are malformed.");
  }
  return value;
}

function validateLimits(value, code) {
  if (!hasExactKeys(value, LIMIT_KEYS)) {
    fail(code, "Model policy limits are malformed.");
  }
  const limits = {
    requestsPerMinute:
      validateNullableLimit(value.requestsPerMinute, "requestsPerMinute", code),
    tokensPerMinute:
      validateNullableLimit(value.tokensPerMinute, "tokensPerMinute", code),
    connectionsPerSecond:
      validateNullableLimit(
        value.connectionsPerSecond,
        "connectionsPerSecond",
        code,
      ),
  };
  if (Object.values(limits).every((limit) => limit === null)) {
    fail(code, "Model policy limits are malformed.");
  }
  return limits;
}

function validateReason(value, code, message) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 2048
    || value.trim() !== value
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    fail(code, message);
  }
  return value;
}

function validateNullableReason(value, code) {
  if (value === null) return null;
  return validateReason(
    value,
    code,
    "Model policy application reason is malformed.",
  );
}

function validateNullableEvidenceId(value, code) {
  if (value === null) return null;
  return validatePattern(
    value,
    EVIDENCE_ID_PATTERN,
    256,
    code,
    "Model policy application evidence is malformed.",
  );
}

function validateRateLimit(value, applicationStatus, code) {
  if (value === null) {
    if (applicationStatus !== "PENDING") {
      fail(code, "Model policy rate-limit evidence is malformed.");
    }
    return null;
  }
  if (!hasExactKeys(value, RATE_LIMIT_KEYS)) {
    fail(code, "Model policy rate-limit evidence is malformed.");
  }
  const rateLimit = {
    id: validateNullableEvidenceId(value.id, code),
    status: value.status,
    reason: validateNullableReason(value.reason, code),
    reconciledAt: validateTimestamp(
      value.reconciledAt,
      code,
      "Model policy rate-limit timestamp is malformed.",
    ),
  };
  if (
    applicationStatus === "PENDING"
    || rateLimit.status !== applicationStatus
    || (
      applicationStatus === "ACTIVE"
      && (rateLimit.id === null || rateLimit.reason !== null)
    )
    || (
      applicationStatus === "RECONCILIATION_FAILED"
      && (rateLimit.id !== null || rateLimit.reason === null)
    )
  ) {
    fail(code, "Model policy rate-limit evidence is malformed.");
  }
  return rateLimit;
}

function validatePolicy(input) {
  const code = "INVALID_MODEL_POLICY";
  if (!hasExactKeys(input, POLICY_KEYS)) {
    fail(code, "Model policy is malformed.");
  }
  const allowedDomains = validateDomains(input.allowedDomains, code);
  const requestableDomains = validateDomains(
    input.requestableDomains,
    code,
  );
  if (
    allowedDomains.length + requestableDomains.length
      > MAX_POLICY_DOMAINS
    || allowedDomains.some((domainId) =>
      requestableDomains.includes(domainId))
  ) {
    fail(code, "Model policy domains are malformed.");
  }
  if (
    !Number.isSafeInteger(input.revision)
    || input.revision < 1
    || input.revision > MAX_REVISION
  ) {
    fail(code, "Model policy revision is malformed.");
  }
  const limits = validateLimits(input.limits, code);
  if (
    !new Set([
      "PENDING",
      "ACTIVE",
      "RECONCILIATION_FAILED",
    ]).has(input.applicationStatus)
  ) {
    fail(code, "Model policy application status is malformed.");
  }
  return {
    modelId: validateModelId(input.modelId, code),
    allowedDomains,
    requestableDomains,
    limits,
    revision: input.revision,
    applicationStatus: input.applicationStatus,
    rateLimit: validateRateLimit(
      input.rateLimit,
      input.applicationStatus,
      code,
    ),
    updatedBySubject: validateSubject(input.updatedBySubject, code),
    updatedAt: validateTimestamp(
      input.updatedAt,
      code,
      "Model policy timestamp is malformed.",
    ),
  };
}

function validateMutation(input, timestamp) {
  const code = "INVALID_MODEL_POLICY_MUTATION";
  if (!hasExactKeys(input, MUTATION_KEYS)) {
    fail(code, "Model policy mutation is malformed.");
  }
  const mutation = {
    actor: validateSubject(input.actor, code),
    effectiveRole: input.effectiveRole,
    route: input.route,
    requestId: validatePattern(
      input.requestId,
      REQUEST_ID_PATTERN,
      128,
      code,
      "Model policy mutation request ID is malformed.",
    ),
    payloadFingerprint: validatePattern(
      input.payloadFingerprint,
      FINGERPRINT_PATTERN,
      64,
      code,
      "Model policy mutation fingerprint is malformed.",
    ),
    resourceKey: input.resourceKey,
    operation: input.operation,
    decision: input.decision,
    reason: validateReason(
      input.reason,
      code,
      "Model policy mutation reason is malformed.",
    ),
    timestamp: validateTimestamp(
      input.timestamp,
      code,
      "Model policy mutation timestamp is malformed.",
    ),
  };
  const isUpsert = (
    mutation.route === POLICY_ROUTE
    && mutation.operation === "UPSERT"
    && mutation.decision === "upsert"
  );
  const isFinalization = (
    mutation.route === APPLICATION_ROUTE
    && mutation.operation === "FINALIZE"
    && new Set(["activate", "fail"]).has(mutation.decision)
  );
  if (
    mutation.effectiveRole !== "admin"
    || typeof mutation.resourceKey !== "string"
    || mutation.resourceKey.length === 0
    || mutation.resourceKey.length > 512
    || CONTROL_CHARACTER_PATTERN.test(mutation.resourceKey)
    || mutation.timestamp !== timestamp
    || (!isUpsert && !isFinalization)
  ) {
    fail(code, "Model policy mutation is malformed.");
  }
  return mutation;
}

function validateResourceBinding(record, mutation) {
  if (mutation.resourceKey !== `model-policy/${record.modelId}`) {
    fail(
      "INVALID_MODEL_POLICY_MUTATION",
      "Model policy mutation resource is malformed.",
    );
  }
  if (record.updatedBySubject !== mutation.actor) {
    fail(
      "MODEL_POLICY_MUTATION_MISMATCH",
      "Model policy mutation does not match the resource.",
    );
  }
}

function validateUpsertBinding(record, mutation) {
  validateResourceBinding(record, mutation);
  if (
    mutation.operation !== "UPSERT"
    || record.applicationStatus !== "PENDING"
    || record.updatedAt !== mutation.timestamp
  ) {
    fail(
      "MODEL_POLICY_MUTATION_MISMATCH",
      "Model policy mutation does not match the resource.",
    );
  }
}

function validateFinalizationBinding(record, mutation) {
  validateResourceBinding(record, mutation);
  const expectedDecision = record.applicationStatus === "ACTIVE"
    ? "activate"
    : record.applicationStatus === "RECONCILIATION_FAILED"
      ? "fail"
      : null;
  if (
    mutation.operation !== "FINALIZE"
    || expectedDecision === null
    || mutation.decision !== expectedDecision
    || record.rateLimit?.reconciledAt !== mutation.timestamp
    || (
      record.applicationStatus === "RECONCILIATION_FAILED"
      && record.rateLimit?.reason !== mutation.reason
    )
  ) {
    fail(
      "MODEL_POLICY_MUTATION_MISMATCH",
      "Model policy application mutation does not match the resource.",
    );
  }
}

function validateExpectedRevision(record, expectedRevision) {
  if (expectedRevision === null) {
    if (record.revision !== 1) {
      fail("INVALID_MODEL_POLICY", "Model policy revision is malformed.");
    }
    return;
  }
  if (
    !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 1
    || expectedRevision >= MAX_REVISION
    || record.revision !== expectedRevision + 1
  ) {
    fail("INVALID_MODEL_POLICY", "Model policy revision is malformed.");
  }
}

function stringAttribute(value) {
  return { S: value };
}

function numberAttribute(value) {
  return { N: String(value) };
}

function nullableStringAttribute(value) {
  return value === null ? { NULL: true } : stringAttribute(value);
}

function nullableNumberAttribute(value) {
  return value === null ? { NULL: true } : numberAttribute(value);
}

function stringListAttribute(values) {
  return { L: values.map(stringAttribute) };
}

function policyToItem(record) {
  return {
    pk: stringAttribute(POLICY_PARTITION),
    sk: stringAttribute(`${POLICY_SORT_PREFIX}${record.modelId}`),
    entityType: stringAttribute("MODEL_POLICY"),
    modelId: stringAttribute(record.modelId),
    allowedDomains: stringListAttribute(record.allowedDomains),
    requestableDomains: stringListAttribute(record.requestableDomains),
    limits: {
      M: {
        requestsPerMinute:
          nullableNumberAttribute(record.limits.requestsPerMinute),
        tokensPerMinute:
          nullableNumberAttribute(record.limits.tokensPerMinute),
        connectionsPerSecond:
          nullableNumberAttribute(record.limits.connectionsPerSecond),
      },
    },
    revision: numberAttribute(record.revision),
    applicationStatus: stringAttribute(record.applicationStatus),
    rateLimit: record.rateLimit === null
      ? { NULL: true }
      : {
          M: {
            id: nullableStringAttribute(record.rateLimit.id),
            status: stringAttribute(record.rateLimit.status),
            reason: nullableStringAttribute(record.rateLimit.reason),
            reconciledAt:
              stringAttribute(record.rateLimit.reconciledAt),
          },
        },
    updatedBySubject: stringAttribute(record.updatedBySubject),
    updatedAt: stringAttribute(record.updatedAt),
  };
}

function auditToItem(record, mutation) {
  return {
    pk: stringAttribute(`MODEL_POLICY_AUDIT#${record.modelId}`),
    sk: stringAttribute(
      `${mutation.timestamp}#${mutation.requestId}`,
    ),
    entityType: stringAttribute("MODEL_POLICY_AUDIT"),
    actor: stringAttribute(mutation.actor),
    action: stringAttribute(
      mutation.operation === "UPSERT"
        ? "model_policy.upsert"
        : "model_policy.application",
    ),
    resource: stringAttribute(mutation.resourceKey),
    decision: stringAttribute(mutation.decision),
    reason: stringAttribute(mutation.reason),
    requestId: stringAttribute(mutation.requestId),
    payloadFingerprint:
      stringAttribute(mutation.payloadFingerprint),
    timestamp: stringAttribute(mutation.timestamp),
  };
}

function mutationToItem(record, mutation) {
  return {
    pk: stringAttribute(`MUTATION#${mutation.actor}`),
    sk: stringAttribute(
      `MUTATION#${mutation.route}#${mutation.requestId}`,
    ),
    entityType: stringAttribute("MODEL_POLICY_MUTATION"),
    actor: stringAttribute(mutation.actor),
    effectiveRole: stringAttribute(mutation.effectiveRole),
    route: stringAttribute(mutation.route),
    requestId: stringAttribute(mutation.requestId),
    payloadFingerprint:
      stringAttribute(mutation.payloadFingerprint),
    resourceKey: stringAttribute(mutation.resourceKey),
    operation: stringAttribute(mutation.operation),
    decision: stringAttribute(mutation.decision),
    reason: stringAttribute(mutation.reason),
    timestamp: stringAttribute(mutation.timestamp),
    result: {
      M: policyToItem(record),
    },
  };
}

function nativeString(item, key) {
  const value = item?.[key];
  if (
    !hasExactKeys(value, new Set(["S"]))
    || typeof value.S !== "string"
  ) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  return value.S;
}

function nativeNumber(item, key) {
  const value = item?.[key];
  if (
    !hasExactKeys(value, new Set(["N"]))
    || typeof value.N !== "string"
  ) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  const parsed = Number(value.N);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value.N) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  return parsed;
}

function nativeNullableString(item, key) {
  const value = item?.[key];
  if (hasExactKeys(value, new Set(["NULL"])) && value.NULL === true) {
    return null;
  }
  return nativeString(item, key);
}

function nativeNullableNumber(item, key) {
  const value = item?.[key];
  if (hasExactKeys(value, new Set(["NULL"])) && value.NULL === true) {
    return null;
  }
  return nativeNumber(item, key);
}

function nativeStringList(item, key) {
  const value = item?.[key];
  if (!hasExactKeys(value, new Set(["L"])) || !Array.isArray(value.L)) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  return value.L.map((entry) =>
    nativeString({ entry }, "entry"));
}

function rateLimitFromItem(item) {
  const value = item.rateLimit;
  if (hasExactKeys(value, new Set(["NULL"])) && value.NULL === true) {
    return null;
  }
  if (
    !hasExactKeys(value, new Set(["M"]))
    || !hasExactKeys(value.M, RATE_LIMIT_KEYS)
  ) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  return {
    id: nativeNullableString(value.M, "id"),
    status: nativeString(value.M, "status"),
    reason: nativeNullableString(value.M, "reason"),
    reconciledAt: nativeString(value.M, "reconciledAt"),
  };
}

function policyFromItem(item) {
  if (!hasExactKeys(item, POLICY_ITEM_KEYS)) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  const modelId = nativeString(item, "modelId");
  if (
    nativeString(item, "pk") !== POLICY_PARTITION
    || nativeString(item, "sk") !== `${POLICY_SORT_PREFIX}${modelId}`
    || nativeString(item, "entityType") !== "MODEL_POLICY"
  ) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  const limits = item.limits;
  if (
    !hasExactKeys(limits, new Set(["M"]))
    || !hasExactKeys(limits.M, LIMIT_KEYS)
  ) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
  try {
    return validatePolicy({
      modelId,
      allowedDomains: nativeStringList(item, "allowedDomains"),
      requestableDomains:
        nativeStringList(item, "requestableDomains"),
      limits: {
        requestsPerMinute:
          nativeNullableNumber(limits.M, "requestsPerMinute"),
        tokensPerMinute:
          nativeNullableNumber(limits.M, "tokensPerMinute"),
        connectionsPerSecond:
          nativeNullableNumber(limits.M, "connectionsPerSecond"),
      },
      revision: nativeNumber(item, "revision"),
      applicationStatus: nativeString(item, "applicationStatus"),
      rateLimit: rateLimitFromItem(item),
      updatedBySubject: nativeString(item, "updatedBySubject"),
      updatedAt: nativeString(item, "updatedAt"),
    });
  } catch (error) {
    if (
      error instanceof ModelPolicyStateError
      && error.code === "MALFORMED_DYNAMODB_RESPONSE"
    ) {
      throw error;
    }
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy item is malformed.",
    );
  }
}

function mutationFromItem(item) {
  if (!hasExactKeys(item, MUTATION_ITEM_KEYS)) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy mutation is malformed.",
    );
  }
  const actor = nativeString(item, "actor");
  const route = nativeString(item, "route");
  const requestId = nativeString(item, "requestId");
  if (
    nativeString(item, "pk") !== `MUTATION#${actor}`
    || nativeString(item, "sk")
      !== `MUTATION#${route}#${requestId}`
    || nativeString(item, "entityType") !== "MODEL_POLICY_MUTATION"
    || !hasExactKeys(item.result, new Set(["M"]))
  ) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy mutation is malformed.",
    );
  }
  const timestamp = nativeString(item, "timestamp");
  let mutation;
  let record;
  try {
    mutation = validateMutation({
      actor,
      effectiveRole: nativeString(item, "effectiveRole"),
      route,
      requestId,
      payloadFingerprint:
        nativeString(item, "payloadFingerprint"),
      resourceKey: nativeString(item, "resourceKey"),
      operation: nativeString(item, "operation"),
      decision: nativeString(item, "decision"),
      reason: nativeString(item, "reason"),
      timestamp,
    }, timestamp);
    record = policyFromItem(item.result.M);
    if (mutation.operation === "UPSERT") {
      validateUpsertBinding(record, mutation);
    } else {
      validateFinalizationBinding(record, mutation);
    }
  } catch {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored model policy mutation is malformed.",
    );
  }
  return { record, mutation };
}

function validateDynamoResponse(response) {
  if (!isPlainObject(response)) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "DynamoDB response is malformed.",
    );
  }
}

function mutationConflict() {
  fail("MUTATION_CONFLICT", "Model policy mutation conflicted.");
}

function isConditionalTransactionConflict(error) {
  return (
    error instanceof TransactionCanceledException
    && Array.isArray(error.CancellationReasons)
    && error.CancellationReasons.length === 3
    && error.CancellationReasons.every(
      ({ Code }) =>
        Code === "None" || Code === "ConditionalCheckFailed",
    )
    && error.CancellationReasons.some(
      ({ Code }) => Code === "ConditionalCheckFailed",
    )
  );
}

function validateAbortSignal(value, code) {
  if (value === undefined) return undefined;
  if (
    value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
  ) {
    return value;
  }
  fail(code, "Model policy read options are malformed.");
}

function sendOptions(abortSignal) {
  return abortSignal ? { abortSignal } : undefined;
}

function parseCursor(input, code) {
  if (input === undefined) return undefined;
  if (
    !hasExactKeys(input, CURSOR_KEYS)
    || input.pk !== POLICY_PARTITION
    || typeof input.sk !== "string"
    || !input.sk.startsWith(POLICY_SORT_PREFIX)
  ) {
    fail(code, "Model policy read cursor is malformed.");
  }
  validateModelId(input.sk.slice(POLICY_SORT_PREFIX.length), code);
  return {
    pk: stringAttribute(input.pk),
    sk: stringAttribute(input.sk),
  };
}

function parseLastKey(value) {
  if (value === undefined) return null;
  if (
    !hasExactKeys(value, CURSOR_KEYS)
    || nativeString(value, "pk") !== POLICY_PARTITION
  ) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "DynamoDB cursor is malformed.",
    );
  }
  const sk = nativeString(value, "sk");
  if (!sk.startsWith(POLICY_SORT_PREFIX)) {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "DynamoDB cursor is malformed.",
    );
  }
  try {
    validateModelId(
      sk.slice(POLICY_SORT_PREFIX.length),
      "MALFORMED_DYNAMODB_RESPONSE",
    );
  } catch {
    fail(
      "MALFORMED_DYNAMODB_RESPONSE",
      "DynamoDB cursor is malformed.",
    );
  }
  return {
    pk: POLICY_PARTITION,
    sk,
  };
}

function createCondition(expectedRevision) {
  if (expectedRevision === null) {
    return {
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    };
  }
  return {
    ConditionExpression:
      "#entityType = :entityType AND #revision = :expectedRevision",
    ExpressionAttributeNames: {
      "#entityType": "entityType",
      "#revision": "revision",
    },
    ExpressionAttributeValues: {
      ":entityType": stringAttribute("MODEL_POLICY"),
      ":expectedRevision": numberAttribute(expectedRevision),
    },
  };
}

function finalizeCondition(record, expectedStatus) {
  return {
    ConditionExpression:
      "#entityType = :entityType AND #revision = :revision "
      + "AND #applicationStatus = :expectedStatus "
      + "AND #updatedBySubject = :updatedBySubject "
      + "AND #updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#applicationStatus": "applicationStatus",
      "#entityType": "entityType",
      "#revision": "revision",
      "#updatedAt": "updatedAt",
      "#updatedBySubject": "updatedBySubject",
    },
    ExpressionAttributeValues: {
      ":entityType": stringAttribute("MODEL_POLICY"),
      ":revision": numberAttribute(record.revision),
      ":expectedStatus": stringAttribute(expectedStatus),
      ":updatedBySubject": stringAttribute(record.updatedBySubject),
      ":updatedAt": stringAttribute(record.updatedAt),
    },
  };
}

export function createModelPolicyState(input) {
  if (
    !hasExactKeys(input, CONFIG_KEYS)
    || typeof input.tableName !== "string"
    || input.tableName.length === 0
    || input.tableName.length > 255
    || !input.dynamo
    || typeof input.dynamo.send !== "function"
    || typeof input.now !== "function"
  ) {
    throw new TypeError("Model policy state configuration is malformed.");
  }
  const { tableName, dynamo, now } = input;
  const transactionClocks = new WeakMap();

  function beginTransaction() {
    const timestamp = transactionTimestamp(now);
    const transaction = Object.freeze({
      timestamp,
      epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
    });
    transactionClocks.set(transaction, timestamp);
    return transaction;
  }

  function consumeTransaction(transaction) {
    if (
      transaction === null
      || typeof transaction !== "object"
      || !transactionClocks.has(transaction)
    ) {
      fail("INVALID_TRANSACTION", "Transaction clock is invalid.");
    }
    const timestamp = transactionClocks.get(transaction);
    transactionClocks.delete(transaction);
    return timestamp;
  }

  async function getStoredMutation(
    { actor, route, requestId },
    abortSignal,
  ) {
    const response = await dynamo.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          pk: stringAttribute(`MUTATION#${actor}`),
          sk: stringAttribute(`MUTATION#${route}#${requestId}`),
        },
        ConsistentRead: true,
      }),
      sendOptions(abortSignal),
    );
    validateDynamoResponse(response);
    if (response.Item === undefined) return null;
    const result = mutationFromItem(response.Item);
    if (
      result.mutation.actor !== actor
      || result.mutation.route !== route
      || result.mutation.requestId !== requestId
    ) {
      fail(
        "MALFORMED_DYNAMODB_RESPONSE",
        "Stored model policy mutation is malformed.",
      );
    }
    return result;
  }

  async function replayMutation(record, mutation) {
    try {
      const stored = await getStoredMutation(mutation);
      if (
        stored === null
        || !isDeepStrictEqual(stored.mutation, mutation)
        || !isDeepStrictEqual(stored.record, record)
      ) {
        mutationConflict();
      }
      return stored.record;
    } catch (error) {
      if (error instanceof ModelPolicyStateError) mutationConflict();
      throw error;
    }
  }

  async function transact(record, mutation, entityCondition) {
    try {
      const response = await dynamo.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: policyToItem(record),
                ...entityCondition,
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: auditToItem(record, mutation),
                ConditionExpression:
                  "attribute_not_exists(pk) "
                  + "AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: mutationToItem(record, mutation),
                ConditionExpression:
                  "attribute_not_exists(pk) "
                  + "AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      validateDynamoResponse(response);
    } catch (error) {
      if (isConditionalTransactionConflict(error)) {
        return replayMutation(record, mutation);
      }
      throw error;
    }
    return record;
  }

  return {
    beginTransaction,

    async putModelPolicy(write) {
      if (!hasExactKeys(write, PUT_KEYS)) {
        fail(
          "INVALID_MODEL_POLICY",
          "Model policy write is malformed.",
        );
      }
      const timestamp = consumeTransaction(write.transaction);
      const record = validatePolicy(write.record);
      validateExpectedRevision(record, write.expectedRevision);
      const mutation = validateMutation(write.mutation, timestamp);
      validateUpsertBinding(record, mutation);
      return transact(
        record,
        mutation,
        createCondition(write.expectedRevision),
      );
    },

    async finalizeModelPolicyApplication(write) {
      if (!hasExactKeys(write, FINALIZE_KEYS)) {
        fail(
          "INVALID_MODEL_POLICY",
          "Model policy application write is malformed.",
        );
      }
      const timestamp = consumeTransaction(write.transaction);
      const record = validatePolicy(write.record);
      if (
        write.expectedStatus !== "PENDING"
        || record.applicationStatus === "PENDING"
      ) {
        fail(
          "INVALID_MODEL_POLICY",
          "Model policy application transition is malformed.",
        );
      }
      const mutation = validateMutation(write.mutation, timestamp);
      validateFinalizationBinding(record, mutation);
      return transact(
        record,
        mutation,
        finalizeCondition(record, write.expectedStatus),
      );
    },

    async getModelPolicy(read) {
      const code = "INVALID_MODEL_POLICY_READ";
      if (
        !isPlainObject(read)
        || Object.keys(read).some((key) => !GET_KEYS.has(key))
        || !Object.hasOwn(read, "modelId")
      ) {
        fail(code, "Model policy read scope is malformed.");
      }
      const modelId = validateModelId(read.modelId, code);
      const abortSignal = validateAbortSignal(read.abortSignal, code);
      const response = await dynamo.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            pk: stringAttribute(POLICY_PARTITION),
            sk: stringAttribute(`${POLICY_SORT_PREFIX}${modelId}`),
          },
          ConsistentRead: true,
        }),
        sendOptions(abortSignal),
      );
      validateDynamoResponse(response);
      if (response.Item === undefined) return null;
      const record = policyFromItem(response.Item);
      if (record.modelId !== modelId) {
        fail(
          "MALFORMED_DYNAMODB_RESPONSE",
          "Stored model policy item is malformed.",
        );
      }
      return record;
    },

    async listModelPolicies(read = {}) {
      const code = "INVALID_MODEL_POLICY_READ";
      if (
        !isPlainObject(read)
        || Object.keys(read).some((key) => !LIST_KEYS.has(key))
      ) {
        fail(code, "Model policy read scope is malformed.");
      }
      const limit = read.limit === undefined ? 50 : read.limit;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAX_PAGE_SIZE
      ) {
        fail(code, "Model policy read limit is malformed.");
      }
      const exclusiveStartKey = parseCursor(read.cursor, code);
      const abortSignal = validateAbortSignal(read.abortSignal, code);
      const response = await dynamo.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression:
            "#pk = :pk AND begins_with(#sk, :skPrefix)",
          ExpressionAttributeNames: {
            "#pk": "pk",
            "#sk": "sk",
          },
          ExpressionAttributeValues: {
            ":pk": stringAttribute(POLICY_PARTITION),
            ":skPrefix": stringAttribute(POLICY_SORT_PREFIX),
          },
          ConsistentRead: true,
          ScanIndexForward: true,
          Limit: limit,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
        sendOptions(abortSignal),
      );
      validateDynamoResponse(response);
      if (
        response.Items !== undefined
        && !Array.isArray(response.Items)
      ) {
        fail(
          "MALFORMED_DYNAMODB_RESPONSE",
          "DynamoDB page is malformed.",
        );
      }
      const items = (response.Items ?? []).map(policyFromItem);
      if (items.length > limit) {
        fail(
          "MALFORMED_DYNAMODB_RESPONSE",
          "DynamoDB page is malformed.",
        );
      }
      return {
        items,
        cursor: parseLastKey(response.LastEvaluatedKey),
      };
    },

    async getMutationResult(read) {
      const code = "INVALID_MODEL_POLICY_READ";
      if (
        !isPlainObject(read)
        || Object.keys(read).some(
          (key) => !MUTATION_LOOKUP_KEYS.has(key),
        )
        || !Object.hasOwn(read, "actor")
        || !Object.hasOwn(read, "route")
        || !Object.hasOwn(read, "requestId")
      ) {
        fail(code, "Model policy mutation lookup is malformed.");
      }
      const actor = validateSubject(read.actor, code);
      if (
        read.route !== POLICY_ROUTE
        && read.route !== APPLICATION_ROUTE
      ) {
        fail(code, "Model policy mutation lookup is malformed.");
      }
      const requestId = validatePattern(
        read.requestId,
        REQUEST_ID_PATTERN,
        128,
        code,
        "Model policy mutation lookup is malformed.",
      );
      const abortSignal = validateAbortSignal(read.abortSignal, code);
      return getStoredMutation(
        { actor, route: read.route, requestId },
        abortSignal,
      );
    },
  };
}
