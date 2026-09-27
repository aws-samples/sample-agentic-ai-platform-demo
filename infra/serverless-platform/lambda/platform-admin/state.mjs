import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readResourcePolicy } from "../domain-bootstrap/resource-policy.mjs";
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  domainGroupOwnership,
  domainIdFromOwnerGroupName,
  domainOwnerGroupName,
} from "./domain-group-operation.mjs";

const DOMAIN_INPUT_KEYS = new Set([
  "id",
  "name",
  "owner",
  "ownerGroup",
  "description",
  "tokenBudget",
  "registryId",
  "registryArn",
  "createdBy",
  "status",
  "createdAt",
]);
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const DOMAIN_READ_OPTION_KEYS = new Set(["abortSignal"]);
const OWNER_GROUP_PATTERN = /^domain-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9]{12,16}$/;
const REGISTRY_RECORD_ID_PATTERN = /^[A-Za-z0-9]{12}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REGISTRY_ARN_PATTERN =
  /^arn:aws:agent-registry:(?!cn-|us-gov-|us-iso-|us-isob-|eu-isoe-|us-isof-|eusc-)[a-z]{2}(?:-[a-z0-9]+)+-\d:[0-9]{12}:registry\/([A-Za-z0-9]{12,16})$/;
const DOMAIN_STATUSES = new Set(["ACTIVE"]);
const DOMAIN_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  "id",
  "name",
  "owner",
  "ownerGroup",
  "description",
  "tokenBudget",
  "registryId",
  "registryArn",
  "createdBy",
  "status",
  "createdAt",
]);
const REQUEST_RESULT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  "actor",
  "route",
  "requestId",
  "result",
  "expiresAt",
  "createdAt",
]);
const PERMANENT_REQUEST_RESULT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  "actor",
  "route",
  "requestId",
  "result",
  "createdAt",
]);
const REQUEST_RESULT_INPUT_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "result",
  "expiresAt",
  "createdAt",
]);
const REQUEST_RESULT_REQUIRED_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "result",
  "expiresAt",
]);
const REQUEST_LOOKUP_KEYS = new Set([
  "actor",
  "route",
  "requestId",
]);
const AUDIT_LOOKUP_KEYS = new Set([
  "actor",
  "timestamp",
  "requestId",
]);
const DOMAIN_REQUEST_CLAIM_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "payloadFingerprint",
  "ownerToken",
  "claimExpiresAt",
  "expiresAt",
  "createdAt",
]);
const DOMAIN_RETRYABLE_CLAIM_KEYS = new Set([
  ...DOMAIN_REQUEST_CLAIM_KEYS,
  "registry",
]);
const DOMAIN_CLEANUP_FENCE_KEYS = new Set([
  ...DOMAIN_REQUEST_CLAIM_KEYS,
  "cleanup",
]);
const DOMAIN_CLEANUP_COMPLETION_REQUIRED_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "payloadFingerprint",
  "cleanup",
  "expiresAt",
  "createdAt",
]);
const DOMAIN_CLEANUP_COMPLETION_KEYS = new Set([
  ...DOMAIN_CLEANUP_COMPLETION_REQUIRED_KEYS,
  "reason",
]);
const DOMAIN_CLEANUP_CLAIM_REQUIRED_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "payloadFingerprint",
  "cleanup",
  "cleanupExecutionToken",
  "createdAt",
]);
const DOMAIN_CLEANUP_CLAIM_KEYS = new Set([
  ...DOMAIN_CLEANUP_CLAIM_REQUIRED_KEYS,
  "reason",
]);
const DOMAIN_CLEANUP_RELEASE_REQUIRED_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "payloadFingerprint",
  "cleanup",
  "createdAt",
]);
const DOMAIN_CLEANUP_RELEASE_KEYS = new Set([
  ...DOMAIN_CLEANUP_RELEASE_REQUIRED_KEYS,
  "reason",
]);
const REQUEST_CLAIM_KEYS = new Set([
  ...DOMAIN_REQUEST_CLAIM_KEYS,
  "kind",
]);
const REGISTRY_TARGET_KEYS = new Set([
  "registryId",
  "recordId",
  "semver",
  "targetStatus",
  "statusReasonHash",
]);
const REGISTRY_TARGET_CLAIM_KEYS = new Set([
  "actor",
  "route",
  "requestId",
  "kind",
  "payloadFingerprint",
  "ownerToken",
  "claimExpiresAt",
  "createdAt",
  "phase",
  "attemptCount",
  "retryAfter",
  "target",
]);
const DOMAIN_TRANSACTION_KEYS = new Set([
  "domain",
  "requestResult",
  "claim",
]);
const DOMAIN_TRANSACTION_CLAIM_KEYS = new Set([
  "payloadFingerprint",
  "ownerToken",
]);
const AUDIT_REQUEST_TRANSACTION_KEYS = new Set([
  "audit",
  "requestResult",
  "claim",
]);
const AUDIT_REQUEST_TRANSACTION_CLAIM_KEYS = new Set([
  "kind",
  "payloadFingerprint",
  "ownerToken",
]);
const REGISTRY_TRANSACTION_CLAIM_KEYS = new Set([
  ...AUDIT_REQUEST_TRANSACTION_CLAIM_KEYS,
  "attemptCount",
  "target",
]);
const DOMAIN_SUCCESS_RESULT_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
  "domain",
]);
const DOMAIN_CLEANUP_RESULT_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
  "code",
  "cleanup",
]);
const DOMAIN_CLEANUP_KEYS = new Set([
  "status",
  "registryId",
  "registryArn",
]);
const DOMAIN_CLEANUP_WITH_GROUP_KEYS = new Set([
  ...DOMAIN_CLEANUP_KEYS,
  "ownerGroup",
]);
const DOMAIN_CLEANING_KEYS = new Set([
  ...DOMAIN_CLEANUP_KEYS,
  "cleanupExecutionToken",
  "cleanupClaimExpiresAt",
]);
const DOMAIN_CLEANING_WITH_GROUP_KEYS = new Set([
  ...DOMAIN_CLEANING_KEYS,
  "ownerGroup",
]);
const DOMAIN_CLEANUP_OWNER_GROUP_KEYS = new Set([
  "name",
  "operationToken",
]);
const DOMAIN_CLEANUP_TARGET_KEYS = new Set([
  "registryId",
  "registryArn",
]);
const DOMAIN_CLEANUP_TARGET_WITH_GROUP_KEYS = new Set([
  ...DOMAIN_CLEANUP_TARGET_KEYS,
  "ownerGroup",
]);
const DOMAIN_CLEANUP_REASONS = new Set([
  "DOMAIN_CONFLICT",
  "DOMAIN_PROVISIONING_FAILED",
  "DOMAIN_COMMIT_FAILED",
]);
const REGISTRY_SUCCESS_RESULT_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
  "resource",
  "decision",
  "reason",
  "version",
]);
const REGISTRY_SUCCESS_VERSION_KEYS = new Set([
  "id",
  "semver",
  "status",
  "statusReason",
  "_aws",
]);
const REGISTRY_SUCCESS_AWS_KEYS = new Set([
  "registryId",
  "recordId",
]);
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PAYLOAD_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const GROUP_OPERATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const CLEANUP_EXECUTION_TOKEN_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CLEANUP_LEASE_SECONDS = 90;
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const REQUEST_KIND_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROUTE_PATTERN =
  /^(?:GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9._~!$&'()*+,;=:@%/{}-]{1,255}$/;
const RESULT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const UNSAFE_RESULT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_REQUEST_RESULT_ITEM_BYTES = 256 * 1024;
const AUDIT_INPUT_KEYS = new Set([
  "actor",
  "action",
  "resource",
  "decision",
  "reason",
  "requestId",
  "timestamp",
]);
const AUDIT_REQUIRED_KEYS = new Set([
  "actor",
  "action",
  "resource",
  "decision",
  "reason",
  "requestId",
]);
const AUDIT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  "actor",
  "action",
  "resource",
  "decision",
  "reason",
  "requestId",
  "timestamp",
]);
const AUDIT_REPLAY_KEYS = new Set([
  "requestResult",
  "claim",
]);
const REGISTRY_AUDIT_REPLAY_KEYS = new Set([
  "requestResult",
  "claim",
]);
const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const AUDIT_DECISION_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const REGISTRY_DECISION_KIND = "REGISTRY_DECISION";
const REGISTRY_TARGET_STATUSES = new Set(["APPROVED", "REJECTED"]);

class PlatformStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PlatformStateError";
    this.code = code;
  }
}

export class RequestResultCorruptionError extends PlatformStateError {
  constructor() {
    super(
      "Stored request result is malformed.",
      "MALFORMED_REQUEST_RESULT_ITEM",
    );
    this.name = "MalformedRequestResultItemError";
  }
}

function invalidDomain(message = "Domain is malformed.") {
  throw new PlatformStateError(message, "INVALID_DOMAIN");
}

function validateDomainId(value) {
  if (
    typeof value !== "string"
    || value.length > 64
    || !DOMAIN_ID_PATTERN.test(value)
  ) {
    throw new PlatformStateError(
      "Domain ID is malformed.",
      "INVALID_DOMAIN_ID",
    );
  }
  return value;
}

function malformedResponse() {
  throw new PlatformStateError(
    "DynamoDB returned a malformed response.",
    "MALFORMED_DYNAMODB_RESPONSE",
  );
}

function malformedRequestResultItem() {
  throw new RequestResultCorruptionError();
}

function invalidRequestResult(message = "Request result is malformed.") {
  throw new PlatformStateError(message, "INVALID_REQUEST_RESULT");
}

function invalidAudit(message = "Audit evidence is malformed.") {
  throw new PlatformStateError(message, "INVALID_AUDIT");
}

function conflictError(message, code, name) {
  const error = new PlatformStateError(message, code);
  error.name = name;
  return error;
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

function boundedString(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function optionalReason(value, maximum) {
  return value === ""
    || boundedString(value, maximum);
}

function isDynamoDbNumber(value) {
  if (!Number.isFinite(value)) return false;
  if (value === 0) return true;
  const magnitude = Math.abs(value);
  return magnitude >= 1e-130 && magnitude < 1e126;
}

function nativeItemSize(item) {
  return Buffer.byteLength(JSON.stringify(item));
}

function isIsoTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function normalizeTimestamp(value, fail) {
  if (value instanceof Date) {
    if (Number.isNaN(value.valueOf())) fail();
    return value.toISOString();
  }
  if (!isIsoTimestamp(value)) fail();
  return value;
}

function generatedTimestamp(input, field, now) {
  if (isPlainObject(input) && Object.hasOwn(input, field)) {
    return undefined;
  }
  return now();
}

function clockSnapshot(now, fail) {
  const timestamp = normalizeTimestamp(now(), fail);
  return {
    epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
    timestamp,
  };
}

export function validateDomainRecord(input, generatedAt) {
  if (!isPlainObject(input)) invalidDomain();
  if (Object.keys(input).some((key) => !DOMAIN_INPUT_KEYS.has(key))) {
    invalidDomain("Domain contains unsupported fields.");
  }
  if (
    !boundedString(input.id, 64)
    || !DOMAIN_ID_PATTERN.test(input.id)
    || !boundedString(input.name, 128)
    || !boundedString(input.owner, 256)
    || !boundedString(input.ownerGroup, 128)
    || !OWNER_GROUP_PATTERN.test(input.ownerGroup)
    || input.ownerGroup !== domainOwnerGroupName(input.id)
    || !boundedString(input.description, 2048)
    || !boundedString(input.registryId, 16)
    || !REGISTRY_ID_PATTERN.test(input.registryId)
    || !boundedString(input.registryArn, 512)
    || !boundedString(input.createdBy, 256)
  ) {
    invalidDomain();
  }
  const registryMatch = REGISTRY_ARN_PATTERN.exec(input.registryArn);
  if (!registryMatch || registryMatch[1] !== input.registryId) {
    invalidDomain("Domain registry identity is malformed.");
  }
  if (
    input.tokenBudget !== null
    && (
      !Number.isSafeInteger(input.tokenBudget)
      || input.tokenBudget <= 0
    )
  ) {
    invalidDomain("Domain token budget is malformed.");
  }
  const status = Object.hasOwn(input, "status") ? input.status : "ACTIVE";
  const createdAt = normalizeTimestamp(
    Object.hasOwn(input, "createdAt") ? input.createdAt : generatedAt,
    invalidDomain,
  );
  if (!DOMAIN_STATUSES.has(status)) {
    invalidDomain();
  }
  return {
    id: input.id,
    name: input.name,
    owner: input.owner,
    ownerGroup: input.ownerGroup,
    description: input.description,
    tokenBudget: input.tokenBudget,
    registryId: input.registryId,
    registryArn: input.registryArn,
    createdBy: input.createdBy,
    status,
    createdAt,
  };
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.size
    && keys.every((key) => expectedKeys.has(key));
}

function validateDomainReadOptions(options) {
  if (options === undefined) return undefined;
  if (
    !hasExactKeys(options, DOMAIN_READ_OPTION_KEYS)
    || typeof AbortSignal !== "function"
    || !(options.abortSignal instanceof AbortSignal)
  ) {
    throw new PlatformStateError(
      "Domain read options are malformed.",
      "INVALID_DOMAIN_READ_OPTIONS",
    );
  }
  return { abortSignal: options.abortSignal };
}

function nativeString(item, key) {
  const attribute = item[key];
  if (
    !isPlainObject(attribute)
    || Object.keys(attribute).length !== 1
    || typeof attribute.S !== "string"
  ) {
    malformedResponse();
  }
  return attribute.S;
}

function nativeTokenBudget(item) {
  const attribute = item.tokenBudget;
  if (!isPlainObject(attribute) || Object.keys(attribute).length !== 1) {
    malformedResponse();
  }
  if (attribute.NULL === true) return null;
  if (
    typeof attribute.N !== "string"
    || !/^[1-9][0-9]*$/.test(attribute.N)
  ) {
    malformedResponse();
  }
  const value = Number(attribute.N);
  if (!Number.isSafeInteger(value) || String(value) !== attribute.N) {
    malformedResponse();
  }
  return value;
}

function domainFromItem(item) {
  if (!hasExactKeys(item, DOMAIN_ITEM_KEYS)) malformedResponse();
  const id = nativeString(item, "id");
  if (
    nativeString(item, "pk") !== "DOMAIN"
    || nativeString(item, "sk") !== `DOMAIN#${id}`
    || nativeString(item, "entityType") !== "DOMAIN"
  ) {
    malformedResponse();
  }
  try {
    return validateDomainRecord({
      id,
      name: nativeString(item, "name"),
      owner: nativeString(item, "owner"),
      ownerGroup: nativeString(item, "ownerGroup"),
      description: nativeString(item, "description"),
      tokenBudget: nativeTokenBudget(item),
      registryId: nativeString(item, "registryId"),
      registryArn: nativeString(item, "registryArn"),
      createdBy: nativeString(item, "createdBy"),
      status: nativeString(item, "status"),
      createdAt: nativeString(item, "createdAt"),
    });
  } catch (error) {
    if (error instanceof PlatformStateError) malformedResponse();
    throw error;
  }
}

function validateDomainPage(response) {
  if (!isPlainObject(response)) malformedResponse();
  const items = response.Items ?? [];
  if (!Array.isArray(items)) malformedResponse();
  const lastKey = response.LastEvaluatedKey;
  if (lastKey === undefined) return { items };
  const keyNames = new Set(["pk", "sk"]);
  if (!hasExactKeys(lastKey, keyNames)) malformedResponse();
  const pk = nativeString(lastKey, "pk");
  const sk = nativeString(lastKey, "sk");
  if (
    pk !== "DOMAIN"
    || !sk.startsWith("DOMAIN#")
    || !DOMAIN_ID_PATTERN.test(sk.slice("DOMAIN#".length))
  ) {
    malformedResponse();
  }
  return { items, lastKey };
}

function validateRequestIdentity(
  input,
  allowedKeys,
  requiredKeys = allowedKeys,
) {
  if (
    !isPlainObject(input)
    || Object.keys(input).some((key) => !allowedKeys.has(key))
    || [...requiredKeys].some((key) => !Object.hasOwn(input, key))
  ) {
    invalidRequestResult();
  }
  if (
    typeof input.actor !== "string"
    || !ACTOR_PATTERN.test(input.actor)
    || typeof input.route !== "string"
    || !ROUTE_PATTERN.test(input.route)
    || typeof input.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(input.requestId)
  ) {
    invalidRequestResult("Request identity is malformed.");
  }
  return {
    actor: input.actor,
    route: input.route,
    requestId: input.requestId,
  };
}

function validateResultTree(
  value,
  fail,
  depth = 0,
  seen = new WeakSet(),
  counter = { value: 0 },
) {
  counter.value += 1;
  if (counter.value > 512 || depth > 8) fail();
  if (
    value === null
    || typeof value === "boolean"
    || (
      typeof value === "string"
      && value.length <= 32768
    )
    || (
      typeof value === "number"
      && isDynamoDbNumber(value)
    )
  ) {
    return;
  }
  if (typeof value !== "object") fail();
  if (seen.has(value)) fail();
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 256) fail();
    for (const child of value) {
      validateResultTree(child, fail, depth + 1, seen, counter);
    }
    return;
  }
  if (!isPlainObject(value)) fail();
  for (const [key, child] of Object.entries(value)) {
    if (!RESULT_KEY_PATTERN.test(key) || UNSAFE_RESULT_KEYS.has(key)) fail();
    validateResultTree(child, fail, depth + 1, seen, counter);
  }
}

function validateRequestResult(input, generatedAt) {
  const identity = validateRequestIdentity(
    input,
    REQUEST_RESULT_INPUT_KEYS,
    REQUEST_RESULT_REQUIRED_KEYS,
  );
  const createdAt = normalizeTimestamp(
    Object.hasOwn(input, "createdAt") ? input.createdAt : generatedAt,
    invalidRequestResult,
  );
  if (
    !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= Math.floor(Date.parse(createdAt) / 1000)
    || identity.route === "POST /api/registry-decide"
    || input.result?.kind === REGISTRY_DECISION_KIND
  ) {
    invalidRequestResult("Request result expiration is malformed.");
  }
  if (!isPlainObject(input.result)) invalidRequestResult();
  validateResultTree(input.result, invalidRequestResult);
  return {
    ...identity,
    result: input.result,
    expiresAt: input.expiresAt,
    createdAt,
  };
}

function validatePermanentRegistryRequest(input, generatedAt) {
  const allowedKeys = new Set([
    "actor",
    "route",
    "requestId",
    "result",
    "createdAt",
  ]);
  const requiredKeys = new Set([
    "actor",
    "route",
    "requestId",
    "result",
  ]);
  const identity = validateRequestIdentity(
    input,
    allowedKeys,
    requiredKeys,
  );
  const createdAt = normalizeTimestamp(
    Object.hasOwn(input, "createdAt") ? input.createdAt : generatedAt,
    invalidRequestResult,
  );
  if (
    identity.route !== "POST /api/registry-decide"
    || !isPlainObject(input.result)
    || input.result.kind !== REGISTRY_DECISION_KIND
  ) {
    invalidRequestResult(
      "Permanent Registry decision request is malformed.",
    );
  }
  validateResultTree(input.result, invalidRequestResult);
  return {
    ...identity,
    result: input.result,
    createdAt,
  };
}

function validateDomainCleanup(input, {
  expectedStatus,
  identity,
  reason,
  targetOnly = false,
} = {}) {
  const hasOwnerGroup = isPlainObject(input)
    && Object.hasOwn(input, "ownerGroup");
  const cleaning = !targetOnly && input?.status === "CLEANING";
  const expectedKeys = targetOnly
    ? hasOwnerGroup
      ? DOMAIN_CLEANUP_TARGET_WITH_GROUP_KEYS
      : DOMAIN_CLEANUP_TARGET_KEYS
    : cleaning
      ? hasOwnerGroup
        ? DOMAIN_CLEANING_WITH_GROUP_KEYS
        : DOMAIN_CLEANING_KEYS
      : hasOwnerGroup
        ? DOMAIN_CLEANUP_WITH_GROUP_KEYS
        : DOMAIN_CLEANUP_KEYS;
  if (
    !hasExactKeys(input, expectedKeys)
    || typeof input.registryId !== "string"
    || !REGISTRY_ID_PATTERN.test(input.registryId)
    || typeof input.registryArn !== "string"
    || (
      hasOwnerGroup
      && (
        !hasExactKeys(
          input.ownerGroup,
          DOMAIN_CLEANUP_OWNER_GROUP_KEYS,
        )
        || typeof input.ownerGroup.name !== "string"
        || !OWNER_GROUP_PATTERN.test(input.ownerGroup.name)
        || typeof input.ownerGroup.operationToken !== "string"
        || !GROUP_OPERATION_TOKEN_PATTERN.test(
          input.ownerGroup.operationToken,
        )
      )
    )
    || (
      cleaning
      && (
        typeof input.cleanupExecutionToken !== "string"
        || !CLEANUP_EXECUTION_TOKEN_PATTERN.test(
          input.cleanupExecutionToken,
        )
        || !Number.isSafeInteger(input.cleanupClaimExpiresAt)
        || input.cleanupClaimExpiresAt <= 0
      )
    )
  ) {
    invalidRequestResult("Domain cleanup target is malformed.");
  }
  const registryMatch = REGISTRY_ARN_PATTERN.exec(input.registryArn);
  if (
    !registryMatch
    || registryMatch[1] !== input.registryId
    || (
      !targetOnly
      && (
        expectedStatus instanceof Set
          ? !expectedStatus.has(input.status)
          : input.status !== expectedStatus
      )
    )
    || (
      !targetOnly
      && !["PENDING", "CLEANING", "COMPLETE"].includes(input.status)
    )
  ) {
    invalidRequestResult("Domain cleanup target is malformed.");
  }
  let ownerGroup;
  if (hasOwnerGroup) {
    try {
      const domainId = domainIdFromOwnerGroupName(
        input.ownerGroup.name,
      );
      const expectedOwnerGroup = domainGroupOwnership(
        identity,
        domainId,
      );
      if (
        reason === "DOMAIN_PROVISIONING_FAILED"
        || !isDeepStrictEqual(input.ownerGroup, expectedOwnerGroup)
      ) {
        invalidRequestResult("Domain cleanup target is malformed.");
      }
      ownerGroup = expectedOwnerGroup;
    } catch (error) {
      if (error instanceof PlatformStateError) throw error;
      invalidRequestResult("Domain cleanup target is malformed.");
    }
  }
  if (
    reason === "DOMAIN_COMMIT_FAILED"
    && !hasOwnerGroup
  ) {
    invalidRequestResult("Domain cleanup target is malformed.");
  }
  return {
    ...(targetOnly ? {} : { status: input.status }),
    registryId: input.registryId,
    registryArn: input.registryArn,
    ...(hasOwnerGroup
      ? {
          ownerGroup: {
            name: ownerGroup.name,
            operationToken: ownerGroup.operationToken,
          },
        }
      : {}),
    ...(cleaning
      ? {
          cleanupExecutionToken: input.cleanupExecutionToken,
          cleanupClaimExpiresAt: input.cleanupClaimExpiresAt,
        }
      : {}),
  };
}

function validateDomainCleanupResult(
  result,
  expectedCleanupStatus,
  expectedReason,
  identity,
) {
  if (
    !hasExactKeys(result, DOMAIN_CLEANUP_RESULT_KEYS)
    || result.kind !== "DOMAIN_CREATE"
    || result.status !== "FAILED_FINAL"
    || typeof result.payloadFingerprint !== "string"
    || !PAYLOAD_FINGERPRINT_PATTERN.test(result.payloadFingerprint)
    || !DOMAIN_CLEANUP_REASONS.has(result.code)
    || (expectedReason !== undefined && result.code !== expectedReason)
  ) {
    invalidRequestResult("Domain cleanup result is malformed.");
  }
  return {
    kind: result.kind,
    status: result.status,
    payloadFingerprint: result.payloadFingerprint,
    code: result.code,
    cleanup: validateDomainCleanup(result.cleanup, {
      expectedStatus: expectedCleanupStatus,
      identity,
      reason: result.code,
    }),
  };
}

function validatePermanentDomainCleanupRequest(
  input,
  generatedAt,
  expectedReason,
) {
  const allowedKeys = new Set([
    "actor",
    "route",
    "requestId",
    "result",
    "createdAt",
  ]);
  const requiredKeys = new Set([
    "actor",
    "route",
    "requestId",
    "result",
  ]);
  const identity = validateRequestIdentity(
    input,
    allowedKeys,
    requiredKeys,
  );
  const createdAt = normalizeTimestamp(
    Object.hasOwn(input, "createdAt") ? input.createdAt : generatedAt,
    invalidRequestResult,
  );
  if (identity.route !== "POST /api/domain-create") {
    invalidRequestResult("Permanent domain cleanup request is malformed.");
  }
  const result = validateDomainCleanupResult(
    input.result,
    new Set(["PENDING", "CLEANING"]),
    expectedReason,
    identity,
  );
  return {
    ...identity,
    result,
    createdAt,
  };
}

function toNativeValue(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "boolean") return { BOOL: value };
  if (typeof value === "number") return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(toNativeValue) };
  return {
    M: Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        toNativeValue(child),
      ]),
    ),
  };
}

function fromNativeValue(attribute) {
  if (!isPlainObject(attribute) || Object.keys(attribute).length !== 1) {
    malformedResponse();
  }
  if (attribute.NULL === true) return null;
  if (typeof attribute.S === "string" && attribute.S.length <= 32768) {
    return attribute.S;
  }
  if (typeof attribute.BOOL === "boolean") return attribute.BOOL;
  if (
    typeof attribute.N === "string"
    && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/.test(
      attribute.N,
    )
  ) {
    const value = Number(attribute.N);
    if (isDynamoDbNumber(value) && String(value) === attribute.N) {
      return value;
    }
  }
  if (Array.isArray(attribute.L) && attribute.L.length <= 256) {
    return attribute.L.map(fromNativeValue);
  }
  if (isPlainObject(attribute.M)) {
    for (const key of Object.keys(attribute.M)) {
      if (!RESULT_KEY_PATTERN.test(key) || UNSAFE_RESULT_KEYS.has(key)) {
        malformedResponse();
      }
    }
    return Object.fromEntries(
      Object.entries(attribute.M).map(([key, child]) => [
        key,
        fromNativeValue(child),
      ]),
    );
  }
  malformedResponse();
}

function nativePositiveInteger(item, key) {
  const attribute = item[key];
  if (
    !isPlainObject(attribute)
    || Object.keys(attribute).length !== 1
    || typeof attribute.N !== "string"
    || !/^[1-9][0-9]*$/.test(attribute.N)
  ) {
    malformedResponse();
  }
  const value = Number(attribute.N);
  if (!Number.isSafeInteger(value) || String(value) !== attribute.N) {
    malformedResponse();
  }
  return value;
}

function requestResultFromItem(item) {
  if (nativeItemSize(item) > MAX_REQUEST_RESULT_ITEM_BYTES) {
    malformedResponse();
  }
  const permanent = hasExactKeys(
    item,
    PERMANENT_REQUEST_RESULT_ITEM_KEYS,
  );
  if (!permanent && !hasExactKeys(item, REQUEST_RESULT_ITEM_KEYS)) {
    malformedResponse();
  }
  const actor = nativeString(item, "actor");
  const route = nativeString(item, "route");
  const requestId = nativeString(item, "requestId");
  if (
    nativeString(item, "pk") !== `REQUEST#${actor}`
    || nativeString(item, "sk") !== `REQUEST#${route}#${requestId}`
    || nativeString(item, "entityType") !== "REQUEST_RESULT"
  ) {
    malformedResponse();
  }
  if (
    !isPlainObject(item.result)
    || Object.keys(item.result).length !== 1
    || !isPlainObject(item.result.M)
  ) {
    malformedResponse();
  }
  try {
    const result = fromNativeValue(item.result);
    if (permanent) {
      if (
        route === "POST /api/domain-create"
        && result?.kind === "DOMAIN_CREATE"
      ) {
        return validatePermanentDomainCleanupRequest({
          actor,
          route,
          requestId,
          result,
          createdAt: nativeString(item, "createdAt"),
        });
      }
      return validatePermanentRegistryRequest({
        actor,
        route,
        requestId,
        result,
        createdAt: nativeString(item, "createdAt"),
      });
    }
    if (
      route === "POST /api/registry-decide"
      || result?.kind === REGISTRY_DECISION_KIND
    ) {
      malformedResponse();
    }
    return validateRequestResult({
      actor,
      route,
      requestId,
      result,
      expiresAt: nativePositiveInteger(item, "expiresAt"),
      createdAt: nativeString(item, "createdAt"),
    });
  } catch (error) {
    if (error instanceof PlatformStateError) malformedResponse();
    throw error;
  }
}

function validateAudit(input, generatedAt) {
  if (
    !isPlainObject(input)
    || Object.keys(input).some((key) => !AUDIT_INPUT_KEYS.has(key))
    || [...AUDIT_REQUIRED_KEYS].some((key) => !Object.hasOwn(input, key))
    || typeof input.actor !== "string"
    || !ACTOR_PATTERN.test(input.actor)
    || typeof input.action !== "string"
    || !AUDIT_ACTION_PATTERN.test(input.action)
    || !boundedString(input.resource, 512)
    || typeof input.decision !== "string"
    || !AUDIT_DECISION_PATTERN.test(input.decision)
    || !optionalReason(input.reason, 2048)
    || typeof input.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(input.requestId)
  ) {
    invalidAudit();
  }
  const timestamp = normalizeTimestamp(
    Object.hasOwn(input, "timestamp") ? input.timestamp : generatedAt,
    invalidAudit,
  );
  return {
    actor: input.actor,
    action: input.action,
    resource: input.resource,
    decision: input.decision,
    reason: input.reason,
    requestId: input.requestId,
    timestamp,
  };
}

function auditToItem(audit) {
  const actorHash = createHash("sha256").update(audit.actor).digest("hex");
  return {
    pk: { S: `AUDIT#${audit.timestamp.slice(0, 7)}` },
    sk: { S: `${audit.timestamp}#${actorHash}#${audit.requestId}` },
    entityType: { S: "AUDIT" },
    actor: { S: audit.actor },
    action: { S: audit.action },
    resource: { S: audit.resource },
    decision: { S: audit.decision },
    reason: { S: audit.reason },
    requestId: { S: audit.requestId },
    timestamp: { S: audit.timestamp },
  };
}

function auditFromItem(item) {
  if (!hasExactKeys(item, AUDIT_ITEM_KEYS)) malformedResponse();
  const timestamp = nativeString(item, "timestamp");
  const requestId = nativeString(item, "requestId");
  const actor = nativeString(item, "actor");
  const actorHash = createHash("sha256").update(actor).digest("hex");
  if (
    nativeString(item, "pk") !== `AUDIT#${timestamp.slice(0, 7)}`
    || nativeString(item, "sk")
      !== `${timestamp}#${actorHash}#${requestId}`
    || nativeString(item, "entityType") !== "AUDIT"
  ) {
    malformedResponse();
  }
  try {
    return validateAudit({
      actor,
      action: nativeString(item, "action"),
      resource: nativeString(item, "resource"),
      decision: nativeString(item, "decision"),
      reason: nativeString(item, "reason"),
      requestId,
      timestamp,
    });
  } catch (error) {
    if (error instanceof PlatformStateError) malformedResponse();
    throw error;
  }
}

function domainToItem(domain) {
  return {
    pk: { S: "DOMAIN" },
    sk: { S: `DOMAIN#${domain.id}` },
    entityType: { S: "DOMAIN" },
    id: { S: domain.id },
    name: { S: domain.name },
    owner: { S: domain.owner },
    ownerGroup: { S: domain.ownerGroup },
    description: { S: domain.description },
    tokenBudget: domain.tokenBudget === null
      ? { NULL: true }
      : { N: String(domain.tokenBudget) },
    registryId: { S: domain.registryId },
    registryArn: { S: domain.registryArn },
    createdBy: { S: domain.createdBy },
    status: { S: domain.status },
    createdAt: { S: domain.createdAt },
  };
}

function requestResultToItem(request) {
  return {
    pk: { S: `REQUEST#${request.actor}` },
    sk: {
      S: `REQUEST#${request.route}#${request.requestId}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: request.actor },
    route: { S: request.route },
    requestId: { S: request.requestId },
    result: toNativeValue(request.result),
    expiresAt: { N: String(request.expiresAt) },
    createdAt: { S: request.createdAt },
  };
}

function permanentRequestResultToItem(request) {
  return {
    pk: { S: `REQUEST#${request.actor}` },
    sk: {
      S: `REQUEST#${request.route}#${request.requestId}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: request.actor },
    route: { S: request.route },
    requestId: { S: request.requestId },
    result: toNativeValue(request.result),
    createdAt: { S: request.createdAt },
  };
}

function transactionConflictCode(error) {
  if (!(error instanceof TransactionCanceledException)) return null;
  const reasons = error.CancellationReasons;
  if (
    !Array.isArray(reasons)
    || reasons.length !== 2
    || reasons.some(
      ({ Code }) => Code !== "None" && Code !== "ConditionalCheckFailed",
    )
  ) {
    return null;
  }
  if (reasons[0].Code === "ConditionalCheckFailed") {
    return "DOMAIN_CONFLICT";
  }
  return reasons[1].Code === "ConditionalCheckFailed"
    ? "REQUEST_CLAIM_CONFLICT"
    : null;
}

function validateClaimIdentity(input, clock, {
  allowedKeys = DOMAIN_REQUEST_CLAIM_KEYS,
  requiredKeys = allowedKeys,
  allowExpiredClaim = false,
  expectedKind = "DOMAIN_CREATE",
} = {}) {
  const identity = validateRequestIdentity(
    input,
    allowedKeys,
    requiredKeys,
  );
  const kind = Object.hasOwn(input, "kind") ? input.kind : expectedKind;
  const createdAt = normalizeTimestamp(
    input.createdAt,
    invalidRequestResult,
  );
  if (
    typeof kind !== "string"
    || !REQUEST_KIND_PATTERN.test(kind)
    ||
    typeof input.payloadFingerprint !== "string"
    || !PAYLOAD_FINGERPRINT_PATTERN.test(input.payloadFingerprint)
    || typeof input.ownerToken !== "string"
    || !OWNER_TOKEN_PATTERN.test(input.ownerToken)
    || !Number.isSafeInteger(input.claimExpiresAt)
    || (!allowExpiredClaim && input.claimExpiresAt <= clock.epochSeconds)
    || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= clock.epochSeconds
    || input.expiresAt <= input.claimExpiresAt
  ) {
    invalidRequestResult("Domain request claim is malformed.");
  }
  return {
    ...identity,
    kind,
    payloadFingerprint: input.payloadFingerprint,
    ownerToken: input.ownerToken,
    claimExpiresAt: input.claimExpiresAt,
    expiresAt: input.expiresAt,
    createdAt,
  };
}

function claimCondition(kind) {
  return {
    ConditionExpression:
      "(attribute_not_exists(#pk) AND attribute_not_exists(#sk)) "
      + "OR #expiresAt <= :now "
      + "OR (#result.#kind = :kind "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND (#result.#status = :failedRetryable "
      + "OR (#result.#status = :inProgress "
      + "AND #result.#claimExpiresAt <= :now)))",
    ExpressionAttributeNames: {
      "#claimExpiresAt": "claimExpiresAt",
      "#expiresAt": "expiresAt",
      "#kind": "kind",
      "#payloadFingerprint": "payloadFingerprint",
      "#pk": "pk",
      "#result": "result",
      "#sk": "sk",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":failedRetryable": { S: "FAILED_RETRYABLE" },
      ":inProgress": { S: "IN_PROGRESS" },
      ":kind": { S: kind },
      ":payloadFingerprint": undefined,
      ":now": undefined,
    },
  };
}

function matchingClaimCondition(claim, { bindCreatedAt = false } = {}) {
  return {
    ConditionExpression:
      (bindCreatedAt ? "#createdAt = :createdAt AND " : "")
      + "#result.#kind = :kind "
      + "AND #result.#status = :inProgress "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND #result.#ownerToken = :ownerToken",
    ExpressionAttributeNames: {
      ...(bindCreatedAt ? { "#createdAt": "createdAt" } : {}),
      "#kind": "kind",
      "#ownerToken": "ownerToken",
      "#payloadFingerprint": "payloadFingerprint",
      "#result": "result",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ...(bindCreatedAt
        ? { ":createdAt": { S: claim.createdAt } }
        : {}),
      ":inProgress": { S: "IN_PROGRESS" },
      ":kind": { S: claim.kind || "DOMAIN_CREATE" },
      ":ownerToken": { S: claim.ownerToken },
      ":payloadFingerprint": { S: claim.payloadFingerprint },
    },
  };
}

function validateTransactionClaim(input) {
  if (
    !hasExactKeys(input, AUDIT_REQUEST_TRANSACTION_CLAIM_KEYS)
    || typeof input.kind !== "string"
    || !REQUEST_KIND_PATTERN.test(input.kind)
    || typeof input.payloadFingerprint !== "string"
    || !PAYLOAD_FINGERPRINT_PATTERN.test(input.payloadFingerprint)
    || typeof input.ownerToken !== "string"
    || !OWNER_TOKEN_PATTERN.test(input.ownerToken)
  ) {
    invalidRequestResult("Request transaction claim is malformed.");
  }
  return {
    kind: input.kind,
    payloadFingerprint: input.payloadFingerprint,
    ownerToken: input.ownerToken,
  };
}

function validateRegistryDecisionTarget(input) {
  if (
    !hasExactKeys(input, REGISTRY_TARGET_KEYS)
    || typeof input.registryId !== "string"
    || !REGISTRY_ID_PATTERN.test(input.registryId)
    || typeof input.recordId !== "string"
    || !REGISTRY_RECORD_ID_PATTERN.test(input.recordId)
    || typeof input.semver !== "string"
    || input.semver.length > 128
    || !SEMVER_PATTERN.test(input.semver)
    || !REGISTRY_TARGET_STATUSES.has(input.targetStatus)
    || typeof input.statusReasonHash !== "string"
    || !PAYLOAD_FINGERPRINT_PATTERN.test(input.statusReasonHash)
  ) {
    invalidRequestResult("Registry decision target is malformed.");
  }
  return {
    registryId: input.registryId,
    recordId: input.recordId,
    semver: input.semver,
    targetStatus: input.targetStatus,
    statusReasonHash: input.statusReasonHash,
  };
}

function validateRegistryTargetClaim(
  input,
  clock,
  { allowExpiredClaim = false } = {},
) {
  const identity = validateRequestIdentity(
    input,
    REGISTRY_TARGET_CLAIM_KEYS,
    REGISTRY_TARGET_CLAIM_KEYS,
  );
  const createdAt = normalizeTimestamp(
    input.createdAt,
    invalidRequestResult,
  );
  if (
    identity.route !== "POST /api/registry-decide"
    || input.kind !== REGISTRY_DECISION_KIND
    || typeof input.payloadFingerprint !== "string"
    || !PAYLOAD_FINGERPRINT_PATTERN.test(input.payloadFingerprint)
    || typeof input.ownerToken !== "string"
    || !OWNER_TOKEN_PATTERN.test(input.ownerToken)
    || !Number.isSafeInteger(input.claimExpiresAt)
    || (!allowExpiredClaim && input.claimExpiresAt <= clock.epochSeconds)
    || !["TARGET_BOUND", "MUTATION_ATTEMPTED", "RETRYABLE"].includes(
      input.phase,
    )
    || !Number.isSafeInteger(input.attemptCount)
    || input.attemptCount < 0
    || input.attemptCount > 3
    || !Number.isSafeInteger(input.retryAfter)
    || input.retryAfter < 0
  ) {
    invalidRequestResult("Registry decision target claim is malformed.");
  }
  return {
    ...identity,
    kind: input.kind,
    payloadFingerprint: input.payloadFingerprint,
    ownerToken: input.ownerToken,
    claimExpiresAt: input.claimExpiresAt,
    createdAt,
    phase: input.phase,
    attemptCount: input.attemptCount,
    retryAfter: input.retryAfter,
    target: validateRegistryDecisionTarget(input.target),
  };
}

function validateRegistryTransactionClaim(input) {
  if (
    !hasExactKeys(input, REGISTRY_TRANSACTION_CLAIM_KEYS)
    || !Number.isSafeInteger(input.attemptCount)
    || input.attemptCount < 1
    || input.attemptCount > 3
  ) {
    invalidRequestResult(
      "Registry decision transaction claim is malformed.",
    );
  }
  return {
    ...validateTransactionClaim({
      kind: input.kind,
      payloadFingerprint: input.payloadFingerprint,
      ownerToken: input.ownerToken,
    }),
    attemptCount: input.attemptCount,
    target: validateRegistryDecisionTarget(input.target),
  };
}

function validateRegistryDecisionFinalization({
  audit,
  request,
  claim,
  clock,
}) {
  const result = request.result;
  const version = result?.version;
  const aws = version?._aws;
  const expectedResource =
    `registry/${claim.target.registryId}`
    + `/record/${claim.target.recordId}`
    + `/version/${claim.target.semver}`;
  const expectedDecision = claim.target.targetStatus === "APPROVED"
    ? "approve"
    : "reject";
  const reasonHash = createHash("sha256")
    .update(audit.reason)
    .digest("hex");
  if (
    request.actor !== audit.actor
    || request.route !== "POST /api/registry-decide"
    || request.requestId !== audit.requestId
    || request.createdAt !== audit.timestamp
    || audit.action !== "registry.version.decide"
    || audit.resource !== expectedResource
    || audit.decision !== expectedDecision
    || reasonHash !== claim.target.statusReasonHash
    || !hasExactKeys(result, REGISTRY_SUCCESS_RESULT_KEYS)
    || result.kind !== claim.kind
    || result.status !== "SUCCEEDED"
    || result.payloadFingerprint !== claim.payloadFingerprint
    || result.resource !== expectedResource
    || result.decision !== audit.decision
    || result.reason !== audit.reason
    || !hasExactKeys(version, REGISTRY_SUCCESS_VERSION_KEYS)
    || !boundedString(version.id, 256)
    || !boundedString(version.semver, 128)
    || version.semver !== claim.target.semver
    || version.status !== claim.target.targetStatus
    || version.statusReason !== audit.reason
    || !hasExactKeys(aws, REGISTRY_SUCCESS_AWS_KEYS)
    || aws.registryId !== claim.target.registryId
    || aws.recordId !== claim.target.recordId
  ) {
    invalidRequestResult(
      "Registry decision audit transaction is malformed.",
    );
  }
}

function registryResourceClaimToItem(claim, phase) {
  return {
    pk: { S: `REGISTRY_RECORD#${claim.target.registryId}` },
    sk: {
      S: `RECORD#${claim.target.recordId}#VERSION#${claim.target.semver}`,
    },
    entityType: { S: "REGISTRY_DECISION_CLAIM" },
    registryId: { S: claim.target.registryId },
    recordId: { S: claim.target.recordId },
    semver: { S: claim.target.semver },
    actor: { S: claim.actor },
    route: { S: claim.route },
    requestId: { S: claim.requestId },
    kind: { S: claim.kind },
    payloadFingerprint: { S: claim.payloadFingerprint },
    ownerToken: { S: claim.ownerToken },
    targetStatus: { S: claim.target.targetStatus },
    statusReasonHash: { S: claim.target.statusReasonHash },
    phase: { S: phase },
    attemptCount: { N: String(claim.attemptCount) },
    retryAfter: { N: String(claim.retryAfter) },
    createdAt: { S: claim.createdAt },
  };
}

function registryRequestForPhase(claim, phase) {
  return validatePermanentRegistryRequest({
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
    result: {
      kind: claim.kind,
      status: "IN_PROGRESS",
      phase,
      payloadFingerprint: claim.payloadFingerprint,
      ownerToken: claim.ownerToken,
      claimExpiresAt: claim.claimExpiresAt,
      attemptCount: claim.attemptCount,
      retryAfter: claim.retryAfter,
      target: claim.target,
    },
    createdAt: claim.createdAt,
  });
}

function matchingRegistryRequestCondition(claim, expectedPhase) {
  return {
    ConditionExpression:
      "#result.#kind = :kind "
      + "AND #result.#status = :inProgress "
      + "AND #result.#phase = :expectedPhase "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND #result.#ownerToken = :ownerToken "
      + "AND #result.#attemptCount = :attemptCount "
      + "AND #result.#retryAfter = :retryAfter "
      + "AND #result.#target.#registryId = :registryId "
      + "AND #result.#target.#recordId = :recordId "
      + "AND #result.#target.#semver = :semver "
      + "AND #result.#target.#targetStatus = :targetStatus "
      + "AND #result.#target.#statusReasonHash = :statusReasonHash",
    ExpressionAttributeNames: {
      "#kind": "kind",
      "#attemptCount": "attemptCount",
      "#ownerToken": "ownerToken",
      "#payloadFingerprint": "payloadFingerprint",
      "#phase": "phase",
      "#recordId": "recordId",
      "#registryId": "registryId",
      "#result": "result",
      "#retryAfter": "retryAfter",
      "#semver": "semver",
      "#status": "status",
      "#statusReasonHash": "statusReasonHash",
      "#target": "target",
      "#targetStatus": "targetStatus",
    },
    ExpressionAttributeValues: {
      ":expectedPhase": { S: expectedPhase },
      ":inProgress": { S: "IN_PROGRESS" },
      ":kind": { S: claim.kind },
      ":attemptCount": { N: String(claim.attemptCount) },
      ":ownerToken": { S: claim.ownerToken },
      ":payloadFingerprint": { S: claim.payloadFingerprint },
      ":recordId": { S: claim.target.recordId },
      ":registryId": { S: claim.target.registryId },
      ":retryAfter": { N: String(claim.retryAfter) },
      ":semver": { S: claim.target.semver },
      ":statusReasonHash": { S: claim.target.statusReasonHash },
      ":targetStatus": { S: claim.target.targetStatus },
    },
  };
}

function matchingRegistryResourceCondition(claim, expectedPhase) {
  return {
    ConditionExpression:
      "#entityType = :entityType "
      + "AND #actor = :actor "
      + "AND #route = :route "
      + "AND #requestId = :requestId "
      + "AND #kind = :kind "
      + "AND #payloadFingerprint = :payloadFingerprint "
      + "AND #ownerToken = :ownerToken "
      + "AND #attemptCount = :attemptCount "
      + "AND #retryAfter = :retryAfter "
      + "AND #registryId = :registryId "
      + "AND #recordId = :recordId "
      + "AND #semver = :semver "
      + "AND #targetStatus = :targetStatus "
      + "AND #statusReasonHash = :statusReasonHash "
      + "AND #phase = :expectedPhase",
    ExpressionAttributeNames: {
      "#actor": "actor",
      "#attemptCount": "attemptCount",
      "#entityType": "entityType",
      "#kind": "kind",
      "#ownerToken": "ownerToken",
      "#payloadFingerprint": "payloadFingerprint",
      "#phase": "phase",
      "#recordId": "recordId",
      "#registryId": "registryId",
      "#requestId": "requestId",
      "#route": "route",
      "#retryAfter": "retryAfter",
      "#semver": "semver",
      "#statusReasonHash": "statusReasonHash",
      "#targetStatus": "targetStatus",
    },
    ExpressionAttributeValues: {
      ":actor": { S: claim.actor },
      ":attemptCount": { N: String(claim.attemptCount) },
      ":entityType": { S: "REGISTRY_DECISION_CLAIM" },
      ":expectedPhase": { S: expectedPhase },
      ":kind": { S: claim.kind },
      ":ownerToken": { S: claim.ownerToken },
      ":payloadFingerprint": { S: claim.payloadFingerprint },
      ":recordId": { S: claim.target.recordId },
      ":registryId": { S: claim.target.registryId },
      ":requestId": { S: claim.requestId },
      ":route": { S: claim.route },
      ":retryAfter": { N: String(claim.retryAfter) },
      ":semver": { S: claim.target.semver },
      ":statusReasonHash": { S: claim.target.statusReasonHash },
      ":targetStatus": { S: claim.target.targetStatus },
    },
  };
}

function requestCreateCondition(clock) {
  return {
    ConditionExpression:
      "(attribute_not_exists(#pk) AND attribute_not_exists(#sk)) "
      + "OR #expiresAt <= :now",
    ExpressionAttributeNames: {
      "#expiresAt": "expiresAt",
      "#pk": "pk",
      "#sk": "sk",
    },
    ExpressionAttributeValues: {
      ":now": { N: String(clock.epochSeconds) },
    },
  };
}

function registryTargetBindingConflictCode(error) {
  if (
    !(error instanceof TransactionCanceledException)
    || !Array.isArray(error.CancellationReasons)
    || error.CancellationReasons.length !== 2
    || error.CancellationReasons.some(
      ({ Code }) => Code !== "None" && Code !== "ConditionalCheckFailed",
    )
  ) {
    return null;
  }
  if (error.CancellationReasons[0].Code === "ConditionalCheckFailed") {
    return "REQUEST_CLAIM_CONFLICT";
  }
  return error.CancellationReasons[1].Code === "ConditionalCheckFailed"
    ? "REGISTRY_RESOURCE_CONFLICT"
    : null;
}

function registryFinalizationConflictCode(error) {
  if (
    !(error instanceof TransactionCanceledException)
    || !Array.isArray(error.CancellationReasons)
    || error.CancellationReasons.length !== 3
    || error.CancellationReasons.some(
      ({ Code }) => Code !== "None" && Code !== "ConditionalCheckFailed",
    )
  ) {
    return null;
  }
  const conflictIndex = error.CancellationReasons.findIndex(
    ({ Code }) => Code === "ConditionalCheckFailed",
  );
  return [
    "AUDIT_CONFLICT",
    "REQUEST_CLAIM_CONFLICT",
    "REGISTRY_RESOURCE_CONFLICT",
  ][conflictIndex] ?? null;
}

export function createPlatformState({ tableName, dynamo, now }) {
  async function claimRequest(input, options = {}) {
    const {
      allowRegistryTarget = false,
      ...claimOptions
    } = options;
    const clock = clockSnapshot(now, invalidRequestResult);
    const claim = validateClaimIdentity(input, clock, claimOptions);
    const registry = allowRegistryTarget
      && Object.hasOwn(input, "registry")
      ? validateDomainCleanup(input.registry, { targetOnly: true })
      : undefined;
    const request = validateRequestResult({
      actor: claim.actor,
      route: claim.route,
      requestId: claim.requestId,
      result: {
        kind: claim.kind,
        status: "IN_PROGRESS",
        payloadFingerprint: claim.payloadFingerprint,
        ownerToken: claim.ownerToken,
        claimExpiresAt: claim.claimExpiresAt,
        ...(registry === undefined ? {} : { registry }),
      },
      expiresAt: claim.expiresAt,
      createdAt: claim.createdAt,
    });
    const condition = claimCondition(claim.kind);
    condition.ExpressionAttributeValues[":now"] = {
      N: String(clock.epochSeconds),
    };
    condition.ExpressionAttributeValues[":payloadFingerprint"] = {
      S: claim.payloadFingerprint,
    };
    try {
      const response = await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: requestResultToItem(request),
        ...condition,
      }));
      if (!isPlainObject(response)) malformedResponse();
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw conflictError(
          "Request claim conflicted.",
          "REQUEST_CLAIM_CONFLICT",
          "RequestClaimConflictError",
        );
      }
      throw error;
    }
    return request;
  }

  async function markRequestRetryable(input, options = {}) {
    const {
      allowRegistryTarget = false,
      ...claimOptions
    } = options;
    const clock = clockSnapshot(now, invalidRequestResult);
    const claim = validateClaimIdentity(input, clock, claimOptions);
    const registry = allowRegistryTarget
      && Object.hasOwn(input, "registry")
      ? validateDomainCleanup(input.registry, { targetOnly: true })
      : undefined;
    const request = validateRequestResult({
      actor: claim.actor,
      route: claim.route,
      requestId: claim.requestId,
      result: {
        kind: claim.kind,
        status: "FAILED_RETRYABLE",
        payloadFingerprint: claim.payloadFingerprint,
        ...(registry === undefined ? {} : { registry }),
      },
      expiresAt: claim.expiresAt,
      createdAt: claim.createdAt,
    });
    try {
      const response = await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: requestResultToItem(request),
        ...matchingClaimCondition(claim),
      }));
      if (!isPlainObject(response)) malformedResponse();
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw conflictError(
          "Request claim conflicted.",
          "REQUEST_CLAIM_CONFLICT",
          "RequestClaimConflictError",
        );
      }
      throw error;
    }
    return request;
  }

  async function markDomainRequestCleanupPending(input, reason) {
    const clock = clockSnapshot(now, invalidRequestResult);
    const claim = validateClaimIdentity(input, clock, {
      allowedKeys: DOMAIN_CLEANUP_FENCE_KEYS,
    });
    const cleanup = validateDomainCleanup(input.cleanup, {
      identity: claim,
      reason,
      targetOnly: true,
    });
    const request = validatePermanentDomainCleanupRequest({
      actor: claim.actor,
      route: claim.route,
      requestId: claim.requestId,
      result: {
        kind: "DOMAIN_CREATE",
        status: "FAILED_FINAL",
        payloadFingerprint: claim.payloadFingerprint,
        code: reason,
        cleanup: {
          status: "PENDING",
          ...cleanup,
        },
      },
      createdAt: claim.createdAt,
    }, reason);
    try {
      const response = await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: permanentRequestResultToItem(request),
        ...matchingClaimCondition(claim, { bindCreatedAt: true }),
      }));
      if (!isPlainObject(response)) malformedResponse();
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw conflictError(
          "Request claim conflicted.",
          "REQUEST_CLAIM_CONFLICT",
          "RequestClaimConflictError",
        );
      }
      throw error;
    }
    return request;
  }

  async function markDomainRequestConflict(input) {
    return markDomainRequestCleanupPending(input, "DOMAIN_CONFLICT");
  }

  async function markDomainRequestProvisioningCleanupPending(input) {
    return markDomainRequestCleanupPending(
      input,
      "DOMAIN_PROVISIONING_FAILED",
    );
  }

  async function markDomainRequestCommitCleanupPending(input) {
    return markDomainRequestCleanupPending(
      input,
      "DOMAIN_COMMIT_FAILED",
    );
  }

  function cleanupReason(input, message) {
    const reason = Object.hasOwn(input, "reason")
      ? input.reason
      : "DOMAIN_CONFLICT";
    if (!DOMAIN_CLEANUP_REASONS.has(reason)) {
      invalidRequestResult(message);
    }
    return reason;
  }

  function cleanupTarget(cleanup) {
    return {
      registryId: cleanup.registryId,
      registryArn: cleanup.registryArn,
      ...(cleanup.ownerGroup === undefined
        ? {}
        : { ownerGroup: structuredClone(cleanup.ownerGroup) }),
    };
  }

  function matchingPermanentCleanupCondition({
    cleanup,
    createdAt,
    identity,
    nowEpoch,
    payloadFingerprint,
    reason,
    takeover = false,
  }) {
    const cleaning = cleanup.status === "CLEANING";
    const statusValue = cleaning ? ":cleaning" : ":pending";
    const condition = {
      ConditionExpression:
        "#entityType = :entityType "
        + "AND #actor = :actor "
        + "AND #route = :route "
        + "AND #requestId = :requestId "
        + "AND #createdAt = :createdAt "
        + "AND attribute_not_exists(#expiresAt) "
        + "AND size(#result) = :resultSize "
        + "AND #result.#kind = :kind "
        + "AND #result.#status = :failedFinal "
        + "AND #result.#payloadFingerprint = :payloadFingerprint "
        + "AND #result.#code = :code "
        + "AND size(#result.#cleanup) = :cleanupSize "
        + `AND #result.#cleanup.#cleanupStatus = ${statusValue} `
        + "AND #result.#cleanup.#registryId = :registryId "
        + "AND #result.#cleanup.#registryArn = :registryArn"
        + (cleanup.ownerGroup === undefined
          ? ""
          : " AND attribute_type("
            + "#result.#cleanup.#ownerGroup, :ownerGroupType) "
            + "AND size(#result.#cleanup.#ownerGroup) = :ownerGroupSize "
            + "AND #result.#cleanup.#ownerGroup.#ownerGroupName "
            + "= :ownerGroupName "
            + "AND #result.#cleanup.#ownerGroup.#operationToken "
            + "= :operationToken")
        + (!cleaning
          ? ""
          : " AND #result.#cleanup.#cleanupExecutionToken "
            + "= :expectedCleanupExecutionToken "
            + "AND #result.#cleanup.#cleanupClaimExpiresAt "
            + "= :expectedCleanupClaimExpiresAt")
        + (takeover
          ? " AND #result.#cleanup.#cleanupClaimExpiresAt <= :now"
          : ""),
      ExpressionAttributeNames: {
        "#actor": "actor",
        "#cleanup": "cleanup",
        ...(cleaning
          ? {
              "#cleanupClaimExpiresAt": "cleanupClaimExpiresAt",
              "#cleanupExecutionToken": "cleanupExecutionToken",
            }
          : {}),
        "#cleanupStatus": "status",
        "#code": "code",
        "#createdAt": "createdAt",
        "#entityType": "entityType",
        "#expiresAt": "expiresAt",
        "#kind": "kind",
        ...(cleanup.ownerGroup === undefined
          ? {}
          : {
              "#operationToken": "operationToken",
              "#ownerGroup": "ownerGroup",
              "#ownerGroupName": "name",
            }),
        "#payloadFingerprint": "payloadFingerprint",
        "#registryArn": "registryArn",
        "#registryId": "registryId",
        "#requestId": "requestId",
        "#result": "result",
        "#route": "route",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":actor": { S: identity.actor },
        ":cleanupSize": {
          N: String(
            (cleanup.ownerGroup === undefined ? 3 : 4)
              + (cleaning ? 2 : 0),
          ),
        },
        ...(cleaning
          ? {
              ":cleaning": { S: "CLEANING" },
              ":expectedCleanupClaimExpiresAt": {
                N: String(cleanup.cleanupClaimExpiresAt),
              },
              ":expectedCleanupExecutionToken": {
                S: cleanup.cleanupExecutionToken,
              },
            }
          : { ":pending": { S: "PENDING" } }),
        ":code": { S: reason },
        ":createdAt": { S: createdAt },
        ":entityType": { S: "REQUEST_RESULT" },
        ":failedFinal": { S: "FAILED_FINAL" },
        ":kind": { S: "DOMAIN_CREATE" },
        ...(takeover ? { ":now": { N: String(nowEpoch) } } : {}),
        ":payloadFingerprint": { S: payloadFingerprint },
        ":registryArn": { S: cleanup.registryArn },
        ":registryId": { S: cleanup.registryId },
        ...(cleanup.ownerGroup === undefined
          ? {}
          : {
              ":operationToken": {
                S: cleanup.ownerGroup.operationToken,
              },
              ":ownerGroupName": { S: cleanup.ownerGroup.name },
              ":ownerGroupSize": { N: "2" },
              ":ownerGroupType": { S: "M" },
            }),
        ":requestId": { S: identity.requestId },
        ":resultSize": { N: "5" },
        ":route": { S: identity.route },
      },
    };
    return condition;
  }

  async function putCleanupTransition(request, condition) {
    try {
      const response = await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: Object.hasOwn(request, "expiresAt")
          ? requestResultToItem(request)
          : permanentRequestResultToItem(request),
        ...condition,
      }));
      if (!isPlainObject(response)) malformedResponse();
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw conflictError(
          "Domain cleanup conflicted.",
          "REQUEST_CLAIM_CONFLICT",
          "RequestClaimConflictError",
        );
      }
      throw error;
    }
    return request;
  }

  async function claimDomainRequestCleanup(input) {
    const clock = clockSnapshot(now, invalidRequestResult);
    const identity = validateRequestIdentity(
      input,
      DOMAIN_CLEANUP_CLAIM_KEYS,
      DOMAIN_CLEANUP_CLAIM_REQUIRED_KEYS,
    );
    const createdAt = normalizeTimestamp(
      input.createdAt,
      invalidRequestResult,
    );
    const reason = cleanupReason(
      input,
      "Domain cleanup claim is malformed.",
    );
    if (
      identity.route !== "POST /api/domain-create"
      || typeof input.payloadFingerprint !== "string"
      || !PAYLOAD_FINGERPRINT_PATTERN.test(input.payloadFingerprint)
      || typeof input.cleanupExecutionToken !== "string"
      || !CLEANUP_EXECUTION_TOKEN_PATTERN.test(
        input.cleanupExecutionToken,
      )
    ) {
      invalidRequestResult("Domain cleanup claim is malformed.");
    }
    const cleanup = validateDomainCleanup(input.cleanup, {
      expectedStatus: new Set(["PENDING", "CLEANING"]),
      identity,
      reason,
    });
    if (
      cleanup.status === "CLEANING"
      && cleanup.cleanupClaimExpiresAt > clock.epochSeconds
    ) {
      invalidRequestResult("Domain cleanup claim is malformed.");
    }
    const claimedCleanup = {
      status: "CLEANING",
      ...cleanupTarget(cleanup),
      cleanupExecutionToken: input.cleanupExecutionToken,
      cleanupClaimExpiresAt:
        clock.epochSeconds + CLEANUP_LEASE_SECONDS,
    };
    const request = validatePermanentDomainCleanupRequest({
      ...identity,
      result: {
        kind: "DOMAIN_CREATE",
        status: "FAILED_FINAL",
        payloadFingerprint: input.payloadFingerprint,
        code: reason,
        cleanup: claimedCleanup,
      },
      createdAt,
    }, reason);
    return putCleanupTransition(
      request,
      matchingPermanentCleanupCondition({
        cleanup,
        createdAt,
        identity,
        nowEpoch: clock.epochSeconds,
        payloadFingerprint: input.payloadFingerprint,
        reason,
        takeover: cleanup.status === "CLEANING",
      }),
    );
  }

  async function releaseDomainRequestCleanup(input) {
    const identity = validateRequestIdentity(
      input,
      DOMAIN_CLEANUP_RELEASE_KEYS,
      DOMAIN_CLEANUP_RELEASE_REQUIRED_KEYS,
    );
    const createdAt = normalizeTimestamp(
      input.createdAt,
      invalidRequestResult,
    );
    if (
      identity.route !== "POST /api/domain-create"
      || typeof input.payloadFingerprint !== "string"
      || !PAYLOAD_FINGERPRINT_PATTERN.test(input.payloadFingerprint)
    ) {
      invalidRequestResult("Domain cleanup release is malformed.");
    }
    const reason = cleanupReason(
      input,
      "Domain cleanup release is malformed.",
    );
    const cleanup = validateDomainCleanup(input.cleanup, {
      expectedStatus: "CLEANING",
      identity,
      reason,
    });
    const request = validatePermanentDomainCleanupRequest({
      ...identity,
      result: {
        kind: "DOMAIN_CREATE",
        status: "FAILED_FINAL",
        payloadFingerprint: input.payloadFingerprint,
        code: reason,
        cleanup: {
          status: "PENDING",
          ...cleanupTarget(cleanup),
        },
      },
      createdAt,
    }, reason);
    return putCleanupTransition(
      request,
      matchingPermanentCleanupCondition({
        cleanup,
        createdAt,
        identity,
        payloadFingerprint: input.payloadFingerprint,
        reason,
      }),
    );
  }

  async function markDomainRequestCleanupComplete(input) {
    const clock = clockSnapshot(now, invalidRequestResult);
    const identity = validateRequestIdentity(
      input,
      DOMAIN_CLEANUP_COMPLETION_KEYS,
      DOMAIN_CLEANUP_COMPLETION_REQUIRED_KEYS,
    );
    const createdAt = normalizeTimestamp(
      input.createdAt,
      invalidRequestResult,
    );
    if (
      identity.route !== "POST /api/domain-create"
      || typeof input.payloadFingerprint !== "string"
      || !PAYLOAD_FINGERPRINT_PATTERN.test(input.payloadFingerprint)
      || !Number.isSafeInteger(input.expiresAt)
      || input.expiresAt <= clock.epochSeconds
      || input.expiresAt <= Math.floor(Date.parse(createdAt) / 1000)
    ) {
      invalidRequestResult("Domain cleanup completion is malformed.");
    }
    const reason = cleanupReason(
      input,
      "Domain cleanup completion is malformed.",
    );
    const cleanup = validateDomainCleanup(input.cleanup, {
      expectedStatus: "CLEANING",
      identity,
      reason,
    });
    const request = validateRequestResult({
      ...identity,
      result: reason === "DOMAIN_CONFLICT"
        ? {
            kind: "DOMAIN_CREATE",
            status: "FAILED_FINAL",
            payloadFingerprint: input.payloadFingerprint,
            code: reason,
            cleanup: {
              status: "COMPLETE",
              ...cleanupTarget(cleanup),
            },
          }
        : {
            kind: "DOMAIN_CREATE",
            status: "FAILED_RETRYABLE",
            payloadFingerprint: input.payloadFingerprint,
          },
      expiresAt: input.expiresAt,
      createdAt,
    });
    return putCleanupTransition(
      request,
      matchingPermanentCleanupCondition({
        cleanup,
        createdAt,
        identity,
        payloadFingerprint: input.payloadFingerprint,
        reason,
      }),
    );
  }

  return {
    async putDomain(input) {
      const domain = validateDomainRecord(
        input,
        generatedTimestamp(input, "createdAt", now),
      );
      let response;
      try {
        response = await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: domainToItem(domain),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw conflictError(
            "Domain already exists.",
            "DOMAIN_CONFLICT",
            "DomainConflictError",
          );
        }
        throw error;
      }
      if (!response || typeof response !== "object" || Array.isArray(response)) {
        malformedResponse();
      }
      return domain;
    },
    async claimDomainRequest(input) {
      return claimRequest(input, {
        allowedKeys: DOMAIN_RETRYABLE_CLAIM_KEYS,
        requiredKeys: DOMAIN_REQUEST_CLAIM_KEYS,
        allowRegistryTarget: true,
      });
    },
    async claimRequest(input) {
      return claimRequest(input, {
        allowedKeys: REQUEST_CLAIM_KEYS,
        expectedKind: null,
      });
    },
    async claimRegistryDecisionTarget(input) {
      const clock = clockSnapshot(now, invalidRequestResult);
      const claim = validateRegistryTargetClaim(input, clock);
      const request = validatePermanentRegistryRequest({
        actor: claim.actor,
        route: claim.route,
        requestId: claim.requestId,
        result: {
          kind: claim.kind,
          status: "IN_PROGRESS",
          phase: claim.phase,
          payloadFingerprint: claim.payloadFingerprint,
          ownerToken: claim.ownerToken,
          claimExpiresAt: claim.claimExpiresAt,
          attemptCount: claim.attemptCount,
          retryAfter: claim.retryAfter,
          target: claim.target,
        },
        createdAt: claim.createdAt,
      });
      try {
        const response = await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: permanentRequestResultToItem(request),
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: registryResourceClaimToItem(
                  claim,
                  claim.phase,
                ),
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }));
        if (!isPlainObject(response)) malformedResponse();
      } catch (error) {
        const code = registryTargetBindingConflictCode(error);
        if (code) {
          throw conflictError(
            code === "REQUEST_CLAIM_CONFLICT"
              ? "Request claim conflicted."
              : "Registry record claim conflicted.",
            code,
            "RegistryTargetBindingConflictError",
          );
        }
        throw error;
      }
      return request;
    },
    async markRegistryDecisionMutationAttempted(input) {
      const clock = clockSnapshot(now, invalidRequestResult);
      const claim = validateRegistryTargetClaim(input, clock, {
        allowExpiredClaim: true,
      });
      if (
        !["TARGET_BOUND", "RETRYABLE"].includes(claim.phase)
        || claim.attemptCount >= 3
        || (
          claim.phase === "RETRYABLE"
          && claim.retryAfter > clock.epochSeconds
        )
      ) {
        invalidRequestResult("Registry mutation phase is malformed.");
      }
      const attemptedClaim = {
        ...claim,
        phase: "MUTATION_ATTEMPTED",
        attemptCount: claim.attemptCount + 1,
        retryAfter: 0,
      };
      const request = registryRequestForPhase(
        attemptedClaim,
        "MUTATION_ATTEMPTED",
      );
      try {
        const response = await dynamo.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: permanentRequestResultToItem(request),
                  ...matchingRegistryRequestCondition(
                    claim,
                    claim.phase,
                  ),
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: registryResourceClaimToItem(
                    attemptedClaim,
                    "MUTATION_ATTEMPTED",
                  ),
                  ...matchingRegistryResourceCondition(
                    claim,
                    claim.phase,
                  ),
                },
              },
            ],
          }),
        );
        if (!isPlainObject(response)) malformedResponse();
      } catch (error) {
        const code = registryTargetBindingConflictCode(error);
        if (code) {
          throw conflictError(
            code === "REQUEST_CLAIM_CONFLICT"
              ? "Request claim conflicted."
              : "Registry record claim conflicted.",
            code,
            "RegistryMutationPhaseConflictError",
          );
        }
        throw error;
      }
      return request;
    },
    async markRegistryDecisionRetryable(input) {
      const clock = clockSnapshot(now, invalidRequestResult);
      const claim = validateRegistryTargetClaim(input, clock, {
        allowExpiredClaim: true,
      });
      if (
        claim.phase !== "MUTATION_ATTEMPTED"
        || claim.attemptCount < 1
        || claim.attemptCount > 3
        || claim.retryAfter <= clock.epochSeconds
      ) {
        invalidRequestResult("Registry retry phase is malformed.");
      }
      const retryableClaim = {
        ...claim,
        phase: "RETRYABLE",
        attemptCount: claim.attemptCount === 3
          ? 0
          : claim.attemptCount,
      };
      const attemptedClaim = { ...claim, retryAfter: 0 };
      const request = registryRequestForPhase(
        retryableClaim,
        "RETRYABLE",
      );
      try {
        const response = await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: permanentRequestResultToItem(request),
                ...matchingRegistryRequestCondition(
                  attemptedClaim,
                  "MUTATION_ATTEMPTED",
                ),
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: registryResourceClaimToItem(
                  retryableClaim,
                  "RETRYABLE",
                ),
                ...matchingRegistryResourceCondition(
                  attemptedClaim,
                  "MUTATION_ATTEMPTED",
                ),
              },
            },
          ],
        }));
        if (!isPlainObject(response)) malformedResponse();
      } catch (error) {
        const code = registryTargetBindingConflictCode(error);
        if (code) {
          throw conflictError(
            code === "REQUEST_CLAIM_CONFLICT"
              ? "Request claim conflicted."
              : "Registry record claim conflicted.",
            code,
            "RegistryRetryPhaseConflictError",
          );
        }
        throw error;
      }
      return request;
    },
    async putRegistryDecisionAuditWithRequestResult(input) {
      if (!hasExactKeys(input, AUDIT_REQUEST_TRANSACTION_KEYS)) {
        invalidRequestResult(
          "Registry decision audit transaction is malformed.",
        );
      }
      const clock = clockSnapshot(now, invalidRequestResult);
      const audit = validateAudit(input.audit, clock.timestamp);
      const request = validatePermanentRegistryRequest(
        input.requestResult,
        clock.timestamp,
      );
      const claim = validateRegistryTransactionClaim(input.claim);
      validateRegistryDecisionFinalization({
        audit,
        request,
        claim,
        clock,
      });
      const resourceClaim = {
        actor: request.actor,
        route: request.route,
        requestId: request.requestId,
        createdAt: request.createdAt,
        phase: "MUTATION_ATTEMPTED",
        retryAfter: 0,
        ...claim,
      };
      const requestItem = permanentRequestResultToItem(request);
      if (nativeItemSize(requestItem) > MAX_REQUEST_RESULT_ITEM_BYTES) {
        invalidRequestResult("Request result is too large.");
      }
      try {
        const response = await dynamo.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: auditToItem(audit),
                  ConditionExpression:
                    "attribute_not_exists(pk) "
                    + "AND attribute_not_exists(sk)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: requestItem,
                  ...matchingRegistryRequestCondition(
                    resourceClaim,
                    "MUTATION_ATTEMPTED",
                  ),
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: registryResourceClaimToItem(
                    resourceClaim,
                    "SUCCEEDED",
                  ),
                  ...matchingRegistryResourceCondition(
                    resourceClaim,
                    "MUTATION_ATTEMPTED",
                  ),
                },
              },
            ],
          }),
        );
        if (!isPlainObject(response)) malformedResponse();
      } catch (error) {
        const code = registryFinalizationConflictCode(error);
        if (code) {
          throw conflictError(
            code === "AUDIT_CONFLICT"
              ? "Audit evidence already exists."
              : code === "REQUEST_CLAIM_CONFLICT"
                ? "Request claim conflicted."
                : "Registry record claim conflicted.",
            code,
            "RegistryDecisionFinalizationConflictError",
          );
        }
        throw error;
      }
      return { audit, requestResult: request };
    },
    async putRegistryDecisionResultForAuditReplay(input) {
      if (!hasExactKeys(input, REGISTRY_AUDIT_REPLAY_KEYS)) {
        invalidRequestResult(
          "Registry decision audit replay is malformed.",
        );
      }
      const clock = clockSnapshot(now, invalidRequestResult);
      const request = validatePermanentRegistryRequest(
        input.requestResult,
        clock.timestamp,
      );
      const claim = validateRegistryTransactionClaim(input.claim);
      const audit = validateAudit({
        actor: request.actor,
        action: "registry.version.decide",
        resource: request.result.resource,
        decision: request.result.decision,
        reason: request.result.reason,
        requestId: request.requestId,
        timestamp: request.createdAt,
      }, clock.timestamp);
      validateRegistryDecisionFinalization({
        audit,
        request,
        claim,
        clock,
      });
      const resourceClaim = {
        actor: request.actor,
        route: request.route,
        requestId: request.requestId,
        createdAt: request.createdAt,
        phase: "MUTATION_ATTEMPTED",
        retryAfter: 0,
        ...claim,
      };
      const requestItem = permanentRequestResultToItem(request);
      if (nativeItemSize(requestItem) > MAX_REQUEST_RESULT_ITEM_BYTES) {
        invalidRequestResult("Request result is too large.");
      }
      try {
        const response = await dynamo.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: requestItem,
                  ...matchingRegistryRequestCondition(
                    resourceClaim,
                    "MUTATION_ATTEMPTED",
                  ),
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: registryResourceClaimToItem(
                    resourceClaim,
                    "SUCCEEDED",
                  ),
                  ...matchingRegistryResourceCondition(
                    resourceClaim,
                    "MUTATION_ATTEMPTED",
                  ),
                },
              },
            ],
          }),
        );
        if (!isPlainObject(response)) malformedResponse();
      } catch (error) {
        const code = registryTargetBindingConflictCode(error);
        if (code) {
          throw conflictError(
            code === "REQUEST_CLAIM_CONFLICT"
              ? "Request claim conflicted."
              : "Registry record claim conflicted.",
            code,
            "RegistryDecisionReplayConflictError",
          );
        }
        throw error;
      }
      return request;
    },
    async markDomainRequestRetryable(input) {
      return markRequestRetryable(input, {
        allowedKeys: DOMAIN_RETRYABLE_CLAIM_KEYS,
        requiredKeys: DOMAIN_REQUEST_CLAIM_KEYS,
        allowRegistryTarget: true,
      });
    },
    async markDomainRequestConflict(input) {
      return markDomainRequestConflict(input);
    },
    async markDomainRequestProvisioningCleanupPending(input) {
      return markDomainRequestProvisioningCleanupPending(input);
    },
    async markDomainRequestCommitCleanupPending(input) {
      return markDomainRequestCommitCleanupPending(input);
    },
    async claimDomainRequestCleanup(input) {
      return claimDomainRequestCleanup(input);
    },
    async releaseDomainRequestCleanup(input) {
      return releaseDomainRequestCleanup(input);
    },
    async markDomainRequestCleanupComplete(input) {
      return markDomainRequestCleanupComplete(input);
    },
    async markRequestRetryable(input) {
      return markRequestRetryable(input, {
        allowedKeys: REQUEST_CLAIM_KEYS,
        expectedKind: null,
      });
    },
    async putDomainWithRequestResult(input) {
      if (!hasExactKeys(input, DOMAIN_TRANSACTION_KEYS)) {
        invalidRequestResult("Domain transaction is malformed.");
      }
      const clock = clockSnapshot(now, invalidRequestResult);
      const domain = validateDomainRecord(
        input.domain,
        clock.timestamp,
      );
      const request = validateRequestResult(
        input.requestResult,
        clock.timestamp,
      );
      if (
        !hasExactKeys(input.claim, DOMAIN_TRANSACTION_CLAIM_KEYS)
        || typeof input.claim.payloadFingerprint !== "string"
        || !PAYLOAD_FINGERPRINT_PATTERN.test(
          input.claim.payloadFingerprint,
        )
        || typeof input.claim.ownerToken !== "string"
        || !OWNER_TOKEN_PATTERN.test(input.claim.ownerToken)
      ) {
        invalidRequestResult("Domain transaction claim is malformed.");
      }
      if (
        request.expiresAt <= clock.epochSeconds
        || !hasExactKeys(request.result, DOMAIN_SUCCESS_RESULT_KEYS)
        || request.result.kind !== "DOMAIN_CREATE"
        || request.result.status !== "SUCCEEDED"
        || request.result.payloadFingerprint
          !== input.claim.payloadFingerprint
        || !isPlainObject(request.result.domain)
        || !isDeepStrictEqual(request.result.domain, domain)
      ) {
        invalidRequestResult("Domain transaction is malformed.");
      }
      const requestItem = requestResultToItem(request);
      if (nativeItemSize(requestItem) > MAX_REQUEST_RESULT_ITEM_BYTES) {
        invalidRequestResult("Request result is too large.");
      }
      let response;
      try {
        response = await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: domainToItem(domain),
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: requestItem,
                ...matchingClaimCondition(input.claim),
              },
            },
          ],
        }));
      } catch (error) {
        const conflictCode = transactionConflictCode(error);
        if (conflictCode) {
          throw conflictError(
            conflictCode === "DOMAIN_CONFLICT"
              ? "Domain already exists."
              : "Domain request claim conflicted.",
            conflictCode,
            "DomainTransactionConflictError",
          );
        }
        throw error;
      }
      if (!isPlainObject(response)) malformedResponse();
      return { domain, requestResult: request };
    },
    async putAuditWithRequestResult(input) {
      if (!hasExactKeys(input, AUDIT_REQUEST_TRANSACTION_KEYS)) {
        invalidRequestResult("Audit request transaction is malformed.");
      }
      const clock = clockSnapshot(now, invalidRequestResult);
      const audit = validateAudit(input.audit, clock.timestamp);
      const request = validateRequestResult(
        input.requestResult,
        clock.timestamp,
      );
      const claim = validateTransactionClaim(input.claim);
      if (
        request.expiresAt <= clock.epochSeconds
        || request.actor !== audit.actor
        || request.requestId !== audit.requestId
        || request.createdAt !== audit.timestamp
        || request.result.kind !== claim.kind
        || request.result.status !== "SUCCEEDED"
        || request.result.payloadFingerprint
          !== claim.payloadFingerprint
        || request.result.resource !== audit.resource
        || request.result.decision !== audit.decision
        || request.result.reason !== audit.reason
      ) {
        invalidRequestResult("Audit request transaction is malformed.");
      }
      const requestItem = requestResultToItem(request);
      if (nativeItemSize(requestItem) > MAX_REQUEST_RESULT_ITEM_BYTES) {
        invalidRequestResult("Request result is too large.");
      }
      let response;
      try {
        response = await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: auditToItem(audit),
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: requestItem,
                ...matchingClaimCondition(claim),
              },
            },
          ],
        }));
      } catch (error) {
        if (
          error instanceof TransactionCanceledException
          && Array.isArray(error.CancellationReasons)
          && error.CancellationReasons.length === 2
          && error.CancellationReasons.every(
            ({ Code }) =>
              Code === "None" || Code === "ConditionalCheckFailed",
          )
        ) {
          const code = error.CancellationReasons[0].Code
            === "ConditionalCheckFailed"
            ? "AUDIT_CONFLICT"
            : error.CancellationReasons[1].Code
                === "ConditionalCheckFailed"
              ? "REQUEST_CLAIM_CONFLICT"
              : null;
          if (code) {
            throw conflictError(
              code === "AUDIT_CONFLICT"
                ? "Audit evidence already exists."
                : "Request claim conflicted.",
              code,
              "AuditRequestTransactionConflictError",
            );
          }
        }
        throw error;
      }
      if (!isPlainObject(response)) malformedResponse();
      return { audit, requestResult: request };
    },
    async putRequestResultForAuditReplay(input) {
      if (!hasExactKeys(input, AUDIT_REPLAY_KEYS)) {
        invalidRequestResult("Audit replay is malformed.");
      }
      const clock = clockSnapshot(now, invalidRequestResult);
      const request = validateRequestResult(
        input.requestResult,
        clock.timestamp,
      );
      const claim = validateTransactionClaim(input.claim);
      if (
        request.expiresAt <= clock.epochSeconds
        || request.result.kind !== claim.kind
        || request.result.status !== "SUCCEEDED"
        || request.result.payloadFingerprint !== claim.payloadFingerprint
      ) {
        invalidRequestResult("Audit replay is malformed.");
      }
      const item = requestResultToItem(request);
      if (nativeItemSize(item) > MAX_REQUEST_RESULT_ITEM_BYTES) {
        invalidRequestResult("Request result is too large.");
      }
      try {
        const response = await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: item,
          ...matchingClaimCondition(claim),
        }));
        if (!isPlainObject(response)) malformedResponse();
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw conflictError(
            "Request claim conflicted.",
            "REQUEST_CLAIM_CONFLICT",
            "RequestClaimConflictError",
          );
        }
        throw error;
      }
      return request;
    },
    async listDomains(options) {
      const sendOptions = validateDomainReadOptions(options);
      const domains = [];
      const seenDomainIds = new Set();
      const seenPageKeys = new Set();
      let exclusiveStartKey;
      do {
        const response = await dynamo.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "#pk = :pk",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: { ":pk": { S: "DOMAIN" } },
            ConsistentRead: true,
            ScanIndexForward: true,
            ...(exclusiveStartKey
              ? { ExclusiveStartKey: exclusiveStartKey }
              : {}),
          }),
          sendOptions,
        );
        const page = validateDomainPage(response);
        for (const item of page.items) {
          const domain = domainFromItem(item);
          if (seenDomainIds.has(domain.id)) malformedResponse();
          seenDomainIds.add(domain.id);
          domains.push(domain);
        }
        exclusiveStartKey = page.lastKey;
        if (exclusiveStartKey) {
          const serializedKey = JSON.stringify(exclusiveStartKey);
          if (seenPageKeys.has(serializedKey)) malformedResponse();
          seenPageKeys.add(serializedKey);
        }
      } while (exclusiveStartKey);
      return domains.sort((left, right) => left.id.localeCompare(right.id));
    },
    async getDomain(value, options) {
      const id = validateDomainId(value);
      const sendOptions = validateDomainReadOptions(options);
      const response = await dynamo.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            pk: { S: "DOMAIN" },
            sk: { S: `DOMAIN#${id}` },
          },
          ConsistentRead: true,
        }),
        sendOptions,
      );
      if (!isPlainObject(response)) malformedResponse();
      if (response.Item === undefined) return null;
      return domainFromItem(response.Item);
    },
    async getDomainResourcePolicy(value, options) {
      return readResourcePolicy(dynamo, tableName, validateDomainId(value), validateDomainReadOptions(options));
    },
    async putRequestResult(input) {
      const clock = clockSnapshot(now, invalidRequestResult);
      const request = validateRequestResult(
        input,
        clock.timestamp,
      );
      if (request.expiresAt <= clock.epochSeconds) {
        invalidRequestResult("Request result expiration is malformed.");
      }
      const item = requestResultToItem(request);
      if (nativeItemSize(item) > MAX_REQUEST_RESULT_ITEM_BYTES) {
        invalidRequestResult("Request result is too large.");
      }
      let response;
      try {
        response = await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression:
            "(attribute_not_exists(#pk) AND attribute_not_exists(#sk)) "
            + "OR #expiresAt <= :now",
          ExpressionAttributeNames: {
            "#expiresAt": "expiresAt",
            "#pk": "pk",
            "#sk": "sk",
          },
          ExpressionAttributeValues: {
            ":now": { N: String(clock.epochSeconds) },
          },
        }));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw conflictError(
            "Request result already exists.",
            "REQUEST_CONFLICT",
            "RequestConflictError",
          );
        }
        throw error;
      }
      if (!isPlainObject(response)) malformedResponse();
      return request;
    },
    async getRequestResult(input) {
      const request = validateRequestIdentity(input, REQUEST_LOOKUP_KEYS);
      const clock = request.route === "POST /api/registry-decide"
        ? null
        : clockSnapshot(now, invalidRequestResult);
      const response = await dynamo.send(new GetItemCommand({
        TableName: tableName,
        Key: {
          pk: { S: `REQUEST#${request.actor}` },
          sk: { S: `REQUEST#${request.route}#${request.requestId}` },
        },
        ConsistentRead: true,
      }));
      if (!isPlainObject(response)) malformedResponse();
      if (response.Item === undefined) return null;
      let stored;
      try {
        stored = requestResultFromItem(response.Item);
      } catch (error) {
        if (error instanceof PlatformStateError) {
          malformedRequestResultItem();
        }
        throw error;
      }
      return Object.hasOwn(stored, "expiresAt")
        && stored.expiresAt <= clock.epochSeconds
        ? null
        : stored;
    },
    async getAudit(input) {
      if (!hasExactKeys(input, AUDIT_LOOKUP_KEYS)) invalidAudit();
      const timestamp = normalizeTimestamp(input.timestamp, invalidAudit);
      if (
        typeof input.actor !== "string"
        || !ACTOR_PATTERN.test(input.actor)
        ||
        typeof input.requestId !== "string"
        || !REQUEST_ID_PATTERN.test(input.requestId)
      ) {
        invalidAudit();
      }
      const actorHash = createHash("sha256")
        .update(input.actor)
        .digest("hex");
      const response = await dynamo.send(new GetItemCommand({
        TableName: tableName,
        Key: {
          pk: { S: `AUDIT#${timestamp.slice(0, 7)}` },
          sk: { S: `${timestamp}#${actorHash}#${input.requestId}` },
        },
        ConsistentRead: true,
      }));
      if (!isPlainObject(response)) malformedResponse();
      if (response.Item === undefined) return null;
      return auditFromItem(response.Item);
    },
    async appendAudit(input) {
      const audit = validateAudit(
        input,
        generatedTimestamp(input, "timestamp", now),
      );
      let response;
      try {
        response = await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: auditToItem(audit),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw conflictError(
            "Audit evidence already exists.",
            "AUDIT_CONFLICT",
            "AuditConflictError",
          );
        }
        throw error;
      }
      if (!isPlainObject(response)) malformedResponse();
      return audit;
    },
  };
}
