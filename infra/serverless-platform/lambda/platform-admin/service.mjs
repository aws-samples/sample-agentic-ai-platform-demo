import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CreateRegistryCommand,
  DeleteRegistryCommand,
  GetRegistryCommand,
  GetRegistryRecordCommand,
  ResourceNotFoundException,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  RESERVED_DOMAIN_IDS,
} from "../authz/capabilities.mjs";
import {
  domainGroupOperationToken,
  domainGroupOwnership,
  domainOwnerGroupName,
  domainRegistryClientToken,
} from "./domain-group-operation.mjs";
import { RequestResultCorruptionError } from "./state.mjs";

export { domainGroupOperationToken };

const CREATE_ROUTE = "POST /api/domain-create";
const DECIDE_ROUTE = "POST /api/registry-decide";
const DECISION_KIND = "REGISTRY_DECISION";
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const CLAIM_TTL_SECONDS = 5 * 60;
const DEFAULT_DECISION_POLL_ATTEMPTS = 3;
const DEFAULT_DECISION_POLL_DELAY_MS = 50;
const DEFAULT_DOMAIN_POLL_ATTEMPTS = 12;
const DEFAULT_DOMAIN_POLL_DELAY_MS = 2_000;
const DEFAULT_DECISION_RETRY_BACKOFF_SECONDS = 5;
const DEFAULT_DECISION_RECOVERY_COOLDOWN_SECONDS = 60;
const MAX_DECISION_ATTEMPTS = 3;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const REGISTRY_ENTRY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9]{12,16}$/;
const REGISTRY_RECORD_ID_PATTERN = /^[A-Za-z0-9]{12}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMMERCIAL_AWS_REGION_PATTERN =
  /^(?!cn-|us-gov-|us-iso-|us-isob-|eu-isoe-|us-isof-|eusc-)[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const OWNER_GROUP_PATTERN = /^domain-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INPUT_KEYS = new Set([
  "name",
  "owner",
  "ownerGroup",
  "description",
  "tokenBudget",
]);
const DECISION_INPUT_KEYS = new Set([
  "id",
  "semver",
  "decision",
  "reason",
]);
const STORED_RESULT_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
  "domain",
]);
const STORED_FINAL_FAILURE_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
  "code",
  "cleanup",
]);
const STORED_DOMAIN_CLEANUP_KEYS = new Set([
  "status",
  "registryId",
  "registryArn",
]);
const STORED_DOMAIN_CLEANUP_WITH_GROUP_KEYS = new Set([
  ...STORED_DOMAIN_CLEANUP_KEYS,
  "ownerGroup",
]);
const STORED_DOMAIN_CLEANING_KEYS = new Set([
  ...STORED_DOMAIN_CLEANUP_KEYS,
  "cleanupExecutionToken",
  "cleanupClaimExpiresAt",
]);
const STORED_DOMAIN_CLEANING_WITH_GROUP_KEYS = new Set([
  ...STORED_DOMAIN_CLEANING_KEYS,
  "ownerGroup",
]);
const STORED_DOMAIN_CLEANUP_OWNER_GROUP_KEYS = new Set([
  "name",
  "operationToken",
]);
const STORED_RETRYABLE_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
]);
const STORED_RETRYABLE_WITH_REGISTRY_KEYS = new Set([
  ...STORED_RETRYABLE_KEYS,
  "registry",
]);
const STORED_IN_PROGRESS_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
  "ownerToken",
  "claimExpiresAt",
]);
const STORED_IN_PROGRESS_WITH_REGISTRY_KEYS = new Set([
  ...STORED_IN_PROGRESS_KEYS,
  "registry",
]);
const STORED_RETRYABLE_REGISTRY_KEYS = new Set([
  "registryId",
  "registryArn",
]);
const STORED_DOMAIN_CLEANUP_REASONS = new Set([
  "DOMAIN_CONFLICT",
  "DOMAIN_PROVISIONING_FAILED",
  "DOMAIN_COMMIT_FAILED",
]);
const STORED_DOMAIN_KEYS = new Set([
  "id",
  "name",
  "owner",
  "ownerGroup",
  "description",
  "tokenBudget",
  "registryId",
  "registryArn",
  "status",
  "createdBy",
  "createdAt",
]);
const PAYLOAD_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const CLEANUP_EXECUTION_TOKEN_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DECISION_RESULT_KEYS = new Set([
  "kind",
  "status",
  "payloadFingerprint",
  "resource",
  "decision",
  "reason",
  "version",
]);
const DECISION_VERSION_KEYS = new Set([
  "id",
  "semver",
  "status",
  "statusReason",
  "_aws",
]);
const DECISION_AWS_KEYS = new Set([
  "registryId",
  "recordId",
]);
const DECISION_TARGET_KEYS = new Set([
  "registryId",
  "recordId",
  "semver",
  "targetStatus",
  "statusReasonHash",
]);
const DECISION_IN_PROGRESS_KEYS = new Set([
  "kind",
  "status",
  "phase",
  "payloadFingerprint",
  "ownerToken",
  "claimExpiresAt",
  "attemptCount",
  "retryAfter",
  "target",
]);
const REGISTRY_TYPES = new Set([
  "A2AAgent",
  "Agent",
  "Blueprint",
  "MCPServer",
  "Skill",
]);
const REGISTRY_RECORD_STATUSES = new Set([
  "CREATING",
  "CREATE_FAILED",
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "UPDATING",
  "UPDATE_FAILED",
  "DEPRECATED",
]);
const APPROVE_REASON = "Approved by platform administrator.";
const REQUIRED_TAGS = Object.freeze({
  "auto-delete": "no",
  project: "agentic-ai-platform-demo",
  managedBy: "cdk",
});
const HOSTED_ACCEPTANCE_TAGS = Object.freeze({
  ...REQUIRED_TAGS,
  managedBy: "hosted-acceptance",
});
const HOSTED_ACCEPTANCE_USERNAME =
  /^hosted-(?:acceptance|role-switching)-admin-([1-9][0-9]{0,19})-([1-9][0-9]{0,5})$/;
const PROVISIONING_FAILURE = Object.freeze({
  ok: false,
  code: "DOMAIN_PROVISIONING_FAILED",
  message: "Domain provisioning is temporarily unavailable.",
  statusCode: 503,
  retryable: true,
});

export class PlatformAdminServiceError extends Error {
  constructor(message, {
    code,
    statusCode,
    retryable = false,
  }) {
    super(message);
    this.name = "PlatformAdminServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function serviceError(code, message, statusCode, retryable = false) {
  return new PlatformAdminServiceError(message, {
    code,
    statusCode,
    retryable,
  });
}

function invalidDomain(message = "Domain details are invalid.") {
  return serviceError("INVALID_DOMAIN", message, 400);
}

function invalidRegistryDecision(
  message = "Registry decision details are invalid.",
) {
  return serviceError("INVALID_REGISTRY_DECISION", message, 400);
}

function registryDecisionConflict(
  message = "The Registry version cannot be decided.",
) {
  return serviceError("REGISTRY_DECISION_CONFLICT", message, 409);
}

function registryDecisionFailure() {
  return serviceError(
    "REGISTRY_DECISION_FAILED",
    "Registry decision is temporarily unavailable.",
    503,
    true,
  );
}

function registryDecisionUncertain() {
  return serviceError(
    "REGISTRY_DECISION_UNCERTAIN",
    "Registry decision outcome is not yet authoritative.",
    503,
    true,
  );
}

function domainConflict() {
  return serviceError(
    "DOMAIN_CONFLICT",
    "A domain with this ID already exists.",
    409,
  );
}

function idempotencyConflict() {
  return serviceError(
    "IDEMPOTENCY_CONFLICT",
    "The request result could not be reconciled.",
    409,
  );
}

function provisioningFailure() {
  return serviceError(
    PROVISIONING_FAILURE.code,
    PROVISIONING_FAILURE.message,
    PROVISIONING_FAILURE.statusCode,
    PROVISIONING_FAILURE.retryable,
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

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function boundedString(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeName(value) {
  if (typeof value !== "string") throw invalidDomain();
  const normalized = value.trim().replace(/[ _-]+/g, " ");
  if (
    normalized.length === 0
    || normalized.length > 128
    || !/^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z0-9]+)*$/.test(normalized)
  ) {
    throw invalidDomain("Domain name is invalid.");
  }
  const id = normalized
    .toLowerCase()
    .split(" ")
    .join("_");
  if (
    id.length < 2
    || id.length > 57
    || !DOMAIN_ID_PATTERN.test(id)
    || RESERVED_DOMAIN_IDS.includes(id)
  ) {
    throw invalidDomain("Domain name cannot produce a valid domain ID.");
  }
  return { id, name: normalized };
}

function normalizedOptionalString(value, maximum, fallback, fieldName) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw invalidDomain(`${fieldName} is invalid.`);
  }
  if (value.trim().length === 0) return fallback;
  if (!boundedString(value, maximum)) {
    throw invalidDomain(`${fieldName} is invalid.`);
  }
  return value;
}

function normalizedTokenBudget(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidDomain("Domain token budget is invalid.");
    }
    return value;
  }
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]*$/.test(value)
  ) {
    throw invalidDomain("Domain token budget is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) {
    throw invalidDomain("Domain token budget is invalid.");
  }
  return parsed;
}

function normalizeDomainInput(input) {
  if (
    !isPlainObject(input)
    || Object.keys(input).some((key) => !INPUT_KEYS.has(key))
  ) {
    throw invalidDomain("Domain details contain unsupported fields.");
  }
  const { id, name } = normalizeName(input.name);
  const ownerGroup = domainOwnerGroupName(id);
  const suppliedOwnerGroup = normalizedOptionalString(
    input.ownerGroup,
    128,
    ownerGroup,
    "Domain owner group",
  );
  if (
    suppliedOwnerGroup !== ownerGroup
    || !OWNER_GROUP_PATTERN.test(suppliedOwnerGroup)
  ) {
    throw invalidDomain("Domain owner group is invalid.");
  }
  return {
    id,
    name,
    owner: normalizedOptionalString(
      input.owner,
      256,
      `${name} domain team`,
      "Domain owner",
    ),
    ownerGroup,
    description: normalizedOptionalString(
      input.description,
      2048,
      `${name} domain agents.`,
      "Domain description",
    ),
    tokenBudget: normalizedTokenBudget(input.tokenBudget),
  };
}

function normalizeRegistryDecision(input) {
  const exactTarget = Object.hasOwn(input || {}, "registryId") || Object.hasOwn(input || {}, "recordId");
  const keys = exactTarget ? new Set([...DECISION_INPUT_KEYS, "registryId", "recordId"]) : DECISION_INPUT_KEYS;
  if (!hasExactKeys(input, keys)) {
    throw invalidRegistryDecision(
      "Registry decision details contain unsupported fields.",
    );
  }
  if (
    !boundedString(input.id, 256)
    || !REGISTRY_ENTRY_ID_PATTERN.test(input.id)
    || !boundedString(input.semver, 128)
    || !SEMVER_PATTERN.test(input.semver)
    || !["approve", "reject"].includes(input.decision)
    || typeof input.reason !== "string"
    || (exactTarget && (!REGISTRY_ID_PATTERN.test(input.registryId) || !REGISTRY_RECORD_ID_PATTERN.test(input.recordId)))
  ) {
    throw invalidRegistryDecision();
  }
  const reason = input.reason === "" && input.decision === "approve"
    ? APPROVE_REASON
    : input.reason;
  if (
    !boundedString(reason, 255)
    || (input.decision === "reject" && input.reason === "")
  ) {
    throw invalidRegistryDecision("Registry decision reason is invalid.");
  }
  return {
    id: input.id,
    semver: input.semver,
    decision: input.decision,
    reason,
    ...(exactTarget ? { registryId: input.registryId, recordId: input.recordId } : {}),
  };
}

function validateTags(tags) {
  if (
    !isPlainObject(tags)
    || Object.keys(tags).length !== Object.keys(REQUIRED_TAGS).length
    || Object.entries(REQUIRED_TAGS).some(
      ([key, value]) => tags[key] !== value,
    )
  ) {
    throw new TypeError(
      "Platform admin service requires the exact mandatory deployment tags.",
    );
  }
  return { ...REQUIRED_TAGS };
}

function requireConfigurationString(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

export function isCommercialAwsRegion(value) {
  return typeof value === "string"
    && COMMERCIAL_AWS_REGION_PATTERN.test(value);
}

function validateScope(scope) {
  if (!isPlainObject(scope) || scope.role !== "admin") {
    throw serviceError(
      "FORBIDDEN",
      "Platform administrator access is required.",
      403,
    );
  }
  if (
    typeof scope.actor !== "string"
    || !ACTOR_PATTERN.test(scope.actor)
    || typeof scope.username !== "string"
    || !ACTOR_PATTERN.test(scope.username)
    || typeof scope.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(scope.requestId)
  ) {
    throw serviceError(
      "INVALID_REQUEST",
      "Request identity is invalid.",
      400,
    );
  }
  return {
    actor: scope.actor,
    username: scope.username,
    requestId: scope.requestId,
  };
}

function validateDecisionScope(scope) {
  const identity = validateScope(scope);
  if (
    !Array.isArray(scope.capabilities)
    || !scope.capabilities.every(
      (capability) => boundedString(capability, 128),
    )
    || !scope.capabilities.includes("approveRegistryVersion")
  ) {
    throw serviceError(
      "FORBIDDEN",
      "Registry approval capability is required.",
      403,
    );
  }
  return {
    identity,
    inventoryScope: {
      role: "admin",
      allowedDomains: Array.isArray(scope.allowedDomains)
        ? [...scope.allowedDomains]
        : [],
      capabilities: [...scope.capabilities],
    },
  };
}

function clockSnapshot(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError("Platform admin service clock is invalid.");
  }
  return {
    createdAt: date.toISOString(),
    epochSeconds: Math.floor(date.valueOf() / 1000),
    claimExpiresAt:
      Math.floor(date.valueOf() / 1000) + CLAIM_TTL_SECONDS,
    expiresAt:
      Math.floor(date.valueOf() / 1000) + IDEMPOTENCY_TTL_SECONDS,
  };
}

function requestIdentity({ actor, requestId }) {
  return {
    actor,
    route: CREATE_ROUTE,
    requestId,
  };
}

function decisionRequestIdentity({ actor, requestId }) {
  return {
    actor,
    route: DECIDE_ROUTE,
    requestId,
  };
}

function resultRecord(identity, result, clock) {
  return {
    ...requestIdentity(identity),
    result,
    expiresAt: clock.expiresAt,
    createdAt: clock.createdAt,
  };
}

function normalizedPayload(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    owner: candidate.owner,
    ownerGroup: candidate.ownerGroup,
    description: candidate.description,
    tokenBudget: candidate.tokenBudget,
  };
}

function payloadFingerprint(candidate) {
  return createHash("sha256")
    .update(JSON.stringify(normalizedPayload(candidate)))
    .digest("hex");
}

function decisionPayloadFingerprint(candidate) {
  return createHash("sha256")
    .update(JSON.stringify(candidate))
    .digest("hex");
}

function validCreatedAt(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function validatedStoredRegistryTarget(value, region, account) {
  if (
    !hasExactKeys(value, STORED_RETRYABLE_REGISTRY_KEYS)
    || !REGISTRY_ID_PATTERN.test(value.registryId)
  ) {
    throw new Error("Stored Registry target is malformed.");
  }
  const registry = registryIdentity(
    { registryArn: value.registryArn },
    region,
    account,
  );
  if (registry.registryId !== value.registryId) {
    throw new Error("Stored Registry target is malformed.");
  }
  return registry;
}

function replayStored({
  account,
  actor,
  candidate,
  clock,
  expectedOwnerGroup,
  fingerprint,
  identity,
  region,
  stored,
}) {
  const result = stored?.result;
  if (
    !isPlainObject(result)
    || result.kind !== "DOMAIN_CREATE"
    || typeof result.payloadFingerprint !== "string"
    || !PAYLOAD_FINGERPRINT_PATTERN.test(result.payloadFingerprint)
  ) {
    throw idempotencyConflict();
  }
  if (result.payloadFingerprint !== fingerprint) {
    throw idempotencyConflict();
  }
  if (result.status === "FAILED_FINAL") {
    const cleanupHasOwnerGroup = isPlainObject(result.cleanup)
      && Object.hasOwn(result.cleanup, "ownerGroup");
    const cleanupIsCleaning = result.cleanup?.status === "CLEANING";
    if (
      !hasExactKeys(result, STORED_FINAL_FAILURE_KEYS)
      || !STORED_DOMAIN_CLEANUP_REASONS.has(result.code)
      || !hasExactKeys(
        result.cleanup,
        cleanupIsCleaning
          ? cleanupHasOwnerGroup
            ? STORED_DOMAIN_CLEANING_WITH_GROUP_KEYS
            : STORED_DOMAIN_CLEANING_KEYS
          : cleanupHasOwnerGroup
            ? STORED_DOMAIN_CLEANUP_WITH_GROUP_KEYS
            : STORED_DOMAIN_CLEANUP_KEYS,
      )
      || !["PENDING", "CLEANING", "COMPLETE"].includes(
        result.cleanup.status,
      )
      || (
        result.code === "DOMAIN_PROVISIONING_FAILED"
        && (
          result.cleanup.status === "COMPLETE"
          || cleanupHasOwnerGroup
        )
      )
      || (
        result.code === "DOMAIN_COMMIT_FAILED"
        && (
          result.cleanup.status === "COMPLETE"
          || !cleanupHasOwnerGroup
        )
      )
      || !REGISTRY_ID_PATTERN.test(result.cleanup.registryId)
      || (
        cleanupIsCleaning
        && (
          typeof result.cleanup.cleanupExecutionToken !== "string"
          || !CLEANUP_EXECUTION_TOKEN_PATTERN.test(
            result.cleanup.cleanupExecutionToken,
          )
          || !Number.isSafeInteger(
            result.cleanup.cleanupClaimExpiresAt,
          )
          || result.cleanup.cleanupClaimExpiresAt <= 0
        )
      )
      || (
        cleanupHasOwnerGroup
        && (
          result.code === "DOMAIN_PROVISIONING_FAILED"
          || !hasExactKeys(
            result.cleanup.ownerGroup,
            STORED_DOMAIN_CLEANUP_OWNER_GROUP_KEYS,
          )
          || !isDeepStrictEqual(
            result.cleanup.ownerGroup,
            expectedOwnerGroup,
          )
        )
      )
      || stored.actor !== identity.actor
      || stored.route !== CREATE_ROUTE
      || stored.requestId !== identity.requestId
      || !validCreatedAt(stored.createdAt)
    ) {
      throw idempotencyConflict();
    }
    try {
      const cleanupIdentity = registryIdentity(
        { registryArn: result.cleanup.registryArn },
        region,
        account,
      );
      if (cleanupIdentity.registryId !== result.cleanup.registryId) {
        throw new Error("Stored cleanup target is malformed.");
      }
    } catch {
      throw idempotencyConflict();
    }
    if (
      result.cleanup.status === "PENDING"
      || result.cleanup.status === "CLEANING"
    ) {
      if (Object.hasOwn(stored, "expiresAt")) {
        throw idempotencyConflict();
      }
      if (
        result.cleanup.status === "CLEANING"
        && result.cleanup.cleanupClaimExpiresAt > clock.epochSeconds
      ) {
        return {
          action: "WAIT",
          cleanup: structuredClone(result.cleanup),
          createdAt: stored.createdAt,
          reason: result.code,
        };
      }
      return {
        action: "CLEANUP",
        cleanup: structuredClone(result.cleanup),
        createdAt: stored.createdAt,
        reason: result.code,
      };
    }
    if (
      !Number.isSafeInteger(stored.expiresAt)
      || stored.expiresAt <= clock.epochSeconds
    ) {
      throw idempotencyConflict();
    }
    throw domainConflict();
  }
  if (result.status === "FAILED_RETRYABLE") {
    if (hasExactKeys(result, STORED_RETRYABLE_KEYS)) {
      return { action: "CLAIM" };
    }
    if (
      !hasExactKeys(result, STORED_RETRYABLE_WITH_REGISTRY_KEYS)
    ) {
      throw idempotencyConflict();
    }
    try {
      const registry = validatedStoredRegistryTarget(
        result.registry,
        region,
        account,
      );
      return { action: "CLAIM", registry };
    } catch {
      throw idempotencyConflict();
    }
  }
  if (result.status === "IN_PROGRESS") {
    const hasRegistry = hasExactKeys(
      result,
      STORED_IN_PROGRESS_WITH_REGISTRY_KEYS,
    );
    if (
      (!hasRegistry && !hasExactKeys(result, STORED_IN_PROGRESS_KEYS))
      || typeof result.ownerToken !== "string"
      || !REQUEST_ID_PATTERN.test(result.ownerToken)
      || !Number.isSafeInteger(result.claimExpiresAt)
    ) {
      throw idempotencyConflict();
    }
    let registry;
    if (hasRegistry) {
      try {
        registry = validatedStoredRegistryTarget(
          result.registry,
          region,
          account,
        );
      } catch {
        throw idempotencyConflict();
      }
    }
    return result.claimExpiresAt <= clock.epochSeconds
      ? {
          action: "CLAIM",
          ...(registry === undefined ? {} : { registry }),
        }
      : { action: "WAIT" };
  }
  if (
    result.status !== "SUCCEEDED"
    || !hasExactKeys(result, STORED_RESULT_KEYS)
    || !hasExactKeys(result.domain, STORED_DOMAIN_KEYS)
  ) {
    throw idempotencyConflict();
  }
  const domain = result.domain;
  let storedCandidate;
  try {
    storedCandidate = normalizeDomainInput({
      name: domain.name,
      owner: domain.owner,
      ownerGroup: domain.ownerGroup,
      description: domain.description,
      tokenBudget: domain.tokenBudget,
    });
    const registry = registryIdentity(
      { registryArn: domain.registryArn },
      region,
      account,
    );
    if (
      !isDeepStrictEqual(storedCandidate, normalizedPayload(domain))
      || !isDeepStrictEqual(storedCandidate, candidate)
      || payloadFingerprint(storedCandidate) !== fingerprint
      || registry.registryId !== domain.registryId
      || domain.status !== "ACTIVE"
      || domain.createdBy !== actor
      || !validCreatedAt(domain.createdAt)
    ) {
      throw new Error("Stored domain is malformed.");
    }
  } catch {
    throw idempotencyConflict();
  }
  return { action: "RETURN", value: { ok: true, domain: { ...domain } } };
}

async function getStoredRequestResult(state, identity) {
  try {
    return await state.getRequestResult(identity);
  } catch (error) {
    if (error instanceof RequestResultCorruptionError) {
      throw idempotencyConflict();
    }
    throw error;
  }
}

async function inspectStored(state, options) {
  const stored = await getStoredRequestResult(
    state,
    requestIdentity(options.identity),
  );
  return stored
    ? replayStored({ ...options, stored })
    : { action: "CLAIM" };
}

function replayStoredDecision({
  candidate,
  fingerprint,
  identity,
  stored,
}) {
  const result = stored?.result;
  if (
    !isPlainObject(result)
    || result.kind !== DECISION_KIND
    || typeof result.payloadFingerprint !== "string"
    || !PAYLOAD_FINGERPRINT_PATTERN.test(result.payloadFingerprint)
    || result.payloadFingerprint !== fingerprint
  ) {
    throw idempotencyConflict();
  }
  if (result.status === "IN_PROGRESS") {
    if (
      !hasExactKeys(result, DECISION_IN_PROGRESS_KEYS)
      || !["TARGET_BOUND", "MUTATION_ATTEMPTED", "RETRYABLE"].includes(
        result.phase,
      )
      || typeof result.ownerToken !== "string"
      || !REQUEST_ID_PATTERN.test(result.ownerToken)
      || !Number.isSafeInteger(result.claimExpiresAt)
      || !Number.isSafeInteger(result.attemptCount)
      || result.attemptCount < 0
      || result.attemptCount > MAX_DECISION_ATTEMPTS
      || !Number.isSafeInteger(result.retryAfter)
      || result.retryAfter < 0
      || !hasExactKeys(result.target, DECISION_TARGET_KEYS)
      || !REGISTRY_ID_PATTERN.test(result.target.registryId)
      || !REGISTRY_RECORD_ID_PATTERN.test(result.target.recordId)
      || result.target.semver !== candidate.semver
      || result.target.targetStatus
        !== (candidate.decision === "approve" ? "APPROVED" : "REJECTED")
      || result.target.statusReasonHash
        !== createHash("sha256").update(candidate.reason).digest("hex")
      || stored.actor !== identity.actor
      || stored.route !== DECIDE_ROUTE
      || stored.requestId !== identity.requestId
      || !validCreatedAt(stored.createdAt)
      || Object.hasOwn(stored, "expiresAt")
    ) {
      throw idempotencyConflict();
    }
    return {
      action: result.phase,
      claim: {
        actor: stored.actor,
        route: stored.route,
        requestId: stored.requestId,
        kind: result.kind,
        payloadFingerprint: result.payloadFingerprint,
        ownerToken: result.ownerToken,
        claimExpiresAt: result.claimExpiresAt,
        phase: result.phase,
        attemptCount: result.attemptCount,
        retryAfter: result.retryAfter,
        createdAt: stored.createdAt,
        target: structuredClone(result.target),
      },
    };
  }
  if (
    result.status !== "SUCCEEDED"
    || !hasExactKeys(result, DECISION_RESULT_KEYS)
    || result.decision !== candidate.decision
    || result.reason !== candidate.reason
    || !hasExactKeys(result.version, DECISION_VERSION_KEYS)
    || !hasExactKeys(result.version._aws, DECISION_AWS_KEYS)
    || result.version.id !== candidate.id
    || result.version.semver !== candidate.semver
    || result.version.status
      !== (candidate.decision === "approve" ? "APPROVED" : "REJECTED")
    || result.version.statusReason !== candidate.reason
    || !REGISTRY_ID_PATTERN.test(result.version._aws.registryId)
    || !REGISTRY_RECORD_ID_PATTERN.test(result.version._aws.recordId)
    || result.resource
      !== `registry/${result.version._aws.registryId}`
        + `/record/${result.version._aws.recordId}`
        + `/version/${result.version.semver}`
  ) {
    throw idempotencyConflict();
  }
  return {
    action: "RETURN",
    value: {
      ok: true,
      version: structuredClone(result.version),
    },
  };
}

async function inspectStoredDecision(state, options) {
  const stored = await state.getRequestResult(
    decisionRequestIdentity(options.identity),
  );
  return stored
    ? replayStoredDecision({ ...options, stored })
    : { action: "BIND" };
}

function claimRecord(
  identity,
  fingerprint,
  ownerToken,
  clock,
  registry,
) {
  return {
    ...requestIdentity(identity),
    payloadFingerprint: fingerprint,
    ownerToken,
    claimExpiresAt: clock.claimExpiresAt,
    expiresAt: clock.expiresAt,
    createdAt: clock.createdAt,
    ...(registry === undefined
      ? {}
      : { registry: structuredClone(registry) }),
  };
}

function decisionClaimRecord(
  identity,
  fingerprint,
  ownerToken,
  clock,
  target,
) {
  return {
    ...decisionRequestIdentity(identity),
    kind: DECISION_KIND,
    payloadFingerprint: fingerprint,
    ownerToken,
    claimExpiresAt: clock.claimExpiresAt,
    phase: "TARGET_BOUND",
    attemptCount: 0,
    retryAfter: 0,
    createdAt: clock.createdAt,
    target,
  };
}

async function markRetryable(state, claim, replayOptions) {
  try {
    await state.markDomainRequestRetryable(claim);
  } catch {
    try {
      const reconciled = await inspectStored(state, replayOptions);
      if (reconciled.action === "RETURN") return reconciled.value;
    } catch {
      // The stable provisioning error must not expose state failures.
    }
  }
  return null;
}

async function deleteRegistryExact(registry, registryId) {
  try {
    await registry.send(new DeleteRegistryCommand({ registryId }));
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
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

async function reconcileCompletedDomainCleanup({
  account,
  candidate,
  cleanup,
  clock,
  createdAt,
  expectedOwnerGroup,
  fingerprint,
  identity,
  reason,
  region,
  state,
}) {
  const stored = await getStoredRequestResult(
    state,
    requestIdentity(identity),
  );
  if (!stored) return false;
  let replay;
  try {
    replay = replayStored({
      account,
      actor: identity.actor,
      candidate,
      clock,
      expectedOwnerGroup,
      fingerprint,
      identity,
      region,
      stored,
    });
  } catch (error) {
    if (
      error instanceof PlatformAdminServiceError
      && error.code === "DOMAIN_CONFLICT"
      && reason === "DOMAIN_CONFLICT"
    ) {
      if (
        stored.createdAt !== createdAt
        || !isDeepStrictEqual(stored.result?.cleanup, {
          status: "COMPLETE",
          ...cleanupTarget(cleanup),
        })
      ) {
        throw idempotencyConflict();
      }
      return true;
    }
    throw error;
  }
  if (
    reason !== "DOMAIN_CONFLICT"
    && replay.action === "CLAIM"
    && stored.actor === identity.actor
    && stored.route === CREATE_ROUTE
    && stored.requestId === identity.requestId
    && stored.createdAt === createdAt
    && Number.isSafeInteger(stored.expiresAt)
    && stored.expiresAt > clock.epochSeconds
    && stored.result?.status === "FAILED_RETRYABLE"
  ) {
    return true;
  }
  return false;
}

async function completePendingDomainCleanup({
  account,
  candidate,
  cleanup,
  clock,
  createdAt,
  domainDirectory,
  expectedOwnerGroup,
  fingerprint,
  identity,
  reason,
  region,
  registry,
  state,
}) {
  const cleanupExecutionToken = randomUUID();
  let cleaning;
  try {
    const claimed = await state.claimDomainRequestCleanup({
      ...requestIdentity(identity),
      payloadFingerprint: fingerprint,
      reason,
      cleanup: structuredClone(cleanup),
      cleanupExecutionToken,
      createdAt,
    });
    const replay = replayStored({
      account,
      actor: identity.actor,
      candidate,
      clock,
      expectedOwnerGroup,
      fingerprint,
      identity,
      region,
      stored: claimed,
    });
    if (
      replay.action !== "WAIT"
      || replay.reason !== reason
      || replay.createdAt !== createdAt
      || replay.cleanup.cleanupExecutionToken !== cleanupExecutionToken
      || !isDeepStrictEqual(
        cleanupTarget(replay.cleanup),
        cleanupTarget(cleanup),
      )
    ) {
      throw idempotencyConflict();
    }
    cleaning = replay.cleanup;
  } catch (error) {
    if (
      error instanceof PlatformAdminServiceError
      && error.code === "IDEMPOTENCY_CONFLICT"
    ) {
      throw error;
    }
    if (error?.code === "REQUEST_CLAIM_CONFLICT") {
      try {
        const reconciled = await inspectStored(state, {
          account,
          actor: identity.actor,
          candidate,
          clock,
          expectedOwnerGroup,
          fingerprint,
          identity,
          region,
        });
        if (reconciled.action === "RETURN") return reconciled.value;
      } catch (reconciliationError) {
        if (
          reconciliationError instanceof PlatformAdminServiceError
          && (
            reconciliationError.code === "IDEMPOTENCY_CONFLICT"
            || reconciliationError.code === "DOMAIN_CONFLICT"
          )
        ) {
          throw reconciliationError;
        }
      }
    }
    throw provisioningFailure();
  }
  try {
    if (cleaning.ownerGroup !== undefined) {
      await domainDirectory.deleteGroupExact(
        cleaning.ownerGroup.name,
        cleaning.ownerGroup.operationToken,
      );
    }
    await deleteRegistryExact(registry, cleaning.registryId);
  } catch {
    try {
      await state.releaseDomainRequestCleanup({
        ...requestIdentity(identity),
        payloadFingerprint: fingerprint,
        reason,
        cleanup: structuredClone(cleaning),
        createdAt,
      });
    } catch {
      // A later retry reconciles the exact CLEANING lease or its winner.
    }
    throw provisioningFailure();
  }
  try {
    await state.markDomainRequestCleanupComplete({
      ...requestIdentity(identity),
      payloadFingerprint: fingerprint,
      reason,
      cleanup: structuredClone(cleaning),
      expiresAt: clock.expiresAt,
      createdAt,
    });
  } catch (error) {
    if (error?.code === "REQUEST_CLAIM_CONFLICT") {
      let completed = false;
      try {
        completed = await reconcileCompletedDomainCleanup({
          account,
          candidate,
          cleanup,
          clock,
          createdAt,
          expectedOwnerGroup,
          fingerprint,
          identity,
          reason,
          region,
          state,
        });
      } catch (reconciliationError) {
        if (
          reconciliationError instanceof PlatformAdminServiceError
          && reconciliationError.code === "IDEMPOTENCY_CONFLICT"
        ) {
          throw reconciliationError;
        }
        throw provisioningFailure();
      }
      if (completed && reason === "DOMAIN_CONFLICT") {
        throw domainConflict();
      }
      if (completed) throw provisioningFailure();
    }
    throw provisioningFailure();
  }
  if (reason === "DOMAIN_CONFLICT") throw domainConflict();
  throw provisioningFailure();
}

function deterministicUuid(namespace) {
  const bytes = createHash("sha256").update(namespace).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function tagsForDomain(identity, candidate, mandatoryTags) {
  const match = HOSTED_ACCEPTANCE_USERNAME.exec(identity.username);
  if (!match) {
    if (
      identity.username.startsWith("hosted-acceptance-admin-")
      || identity.username.startsWith("hosted-role-switching-admin-")
    ) {
      throw invalidDomain("Hosted acceptance identity is invalid.");
    }
    return mandatoryTags;
  }
  const [, runId, runAttempt] = match;
  const expectedName = `Hosted Acceptance ${runId} ${runAttempt}`;
  const expectedId = `hosted_acceptance_${runId}_${runAttempt}`;
  const expectedOwnerGroup =
    `domain-hosted-acceptance-${runId}-${runAttempt}`;
  const expectedRequestId = deterministicUuid(
    `hosted-acceptance:domain:${runId}:${runAttempt}`,
  );
  if (
    candidate.name !== expectedName
    || candidate.id !== expectedId
    || candidate.ownerGroup !== expectedOwnerGroup
    || identity.requestId !== expectedRequestId
  ) {
    throw invalidDomain("Hosted acceptance domain identity is invalid.");
  }
  return HOSTED_ACCEPTANCE_TAGS;
}

function registryIdentity(response, region, account) {
  if (!isPlainObject(response) || typeof response.registryArn !== "string") {
    throw new Error("Registry response is malformed.");
  }
  const pattern = new RegExp(
    `^arn:aws:agent-registry:${region}:${account}:`
      + "registry/([A-Za-z0-9]{12,16})$",
  );
  const match = pattern.exec(response.registryArn);
  if (!match) throw new Error("Registry response is malformed.");
  return {
    registryArn: response.registryArn,
    registryId: match[1],
  };
}

function registryReadiness(response, expected, region, account) {
  const identity = registryIdentity(response, region, account);
  if (
    response.registryId !== expected.registryId
    || identity.registryId !== expected.registryId
    || identity.registryArn !== expected.registryArn
  ) {
    throw new Error("Registry response is malformed.");
  }
  if (response.status === "READY") return true;
  if (response.status === "CREATING") return false;
  throw new Error("Registry provisioning failed.");
}

async function waitForRegistryReady({
  account,
  attempts,
  delayMs,
  identity,
  region,
  registry,
  sleep,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await registry.send(new GetRegistryCommand({
      registryId: identity.registryId,
    }));
    if (registryReadiness(response, identity, region, account)) return true;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return false;
}

function selectRegistryVersion(inventory, candidate) {
  if (
    !isPlainObject(inventory)
    || inventory.ok !== true
    || inventory.source !== "aws"
    || !Array.isArray(inventory.entries)
    || inventory.incomplete === true || inventory.partial === true || inventory.complete === false
    || (inventory.completeness && inventory.completeness !== "complete")
    || (inventory.errors && (!Array.isArray(inventory.errors) || inventory.errors.length))
  ) {
    throw new Error("Registry inventory is malformed.");
  }
  const entries = inventory.entries.filter(
    (entry) => entry?.id === candidate.id,
  );
  if (entries.length === 0) {
    throw registryDecisionConflict("Registry entry was not found.");
  }
  if (entries.length !== 1 || !isPlainObject(entries[0])) {
    throw new Error("Registry inventory is malformed.");
  }
  const entry = entries[0];
  if (
    typeof entry.domain !== "string"
    || !DOMAIN_ID_PATTERN.test(entry.domain)
  ) {
    throw new Error("Registry inventory is malformed.");
  }
  if (!["platform", "shared"].includes(entry.domain)) {
    throw registryDecisionConflict(
      "Domain-owned Registry versions require Domain Lead approval.",
    );
  }
  if (
    entry.type === "Model"
    || (entry.type === "MCPServer" && entry._source !== "agentcore-registry")
  ) {
    throw registryDecisionConflict(
      "This resource is governed by Gateway or Policy, not Registry approval.",
    );
  }
  if (
    !REGISTRY_TYPES.has(entry.type)
    || entry._source !== "agentcore-registry"
    || !Array.isArray(entry.versions)
    || entry.versions.some(
      (version) =>
        !isPlainObject(version)
        || !boundedString(version.semver, 128)
        || !SEMVER_PATTERN.test(version.semver)
        || !isPlainObject(version._aws)
        || !REGISTRY_ID_PATTERN.test(version._aws.registryId)
        || !REGISTRY_RECORD_ID_PATTERN.test(version._aws.recordId),
    )
  ) {
    throw new Error("Registry inventory is malformed.");
  }
  const versions = entry.versions.filter(
    (version) => version?.semver === candidate.semver,
  );
  if (versions.length === 0) {
    throw registryDecisionConflict("Registry version was not found.");
  }
  if (versions.length !== 1 || !isPlainObject(versions[0])) {
    throw new Error("Registry inventory is malformed.");
  }
  const version = versions[0];
  if (entry.type === "MCPServer" && !candidate.registryId) throw registryDecisionConflict("Native MCP decisions require an exact record identity.");
  if (version._governed === true) throw registryDecisionConflict("Governed resources require a publication decision.");
  if (candidate.registryId && (version._aws.registryId !== candidate.registryId || version._aws.recordId !== candidate.recordId)) {
    throw registryDecisionConflict("Registry target identity changed.");
  }
  if (
    version.status === "IN_REVIEW"
    && version._aws.awsStatus === "PENDING_APPROVAL"
  ) {
    return version;
  }
  throw registryDecisionConflict(
    "Only an IN_REVIEW Registry version can be decided.",
  );
}

function authoritativeDecisionState(
  record,
  {
    candidate,
    registryId,
    recordId,
    targetStatus,
    region,
    account,
  },
) {
  if (!isPlainObject(record)) {
    throw new Error("Registry record response is malformed.");
  }
  const expectedRegistryArn =
    `arn:aws:agent-registry:${region}:${account}:registry/${registryId}`;
  const expectedRecordArn = `${expectedRegistryArn}/record/${recordId}`;
  let registryIdentityExposed = false;
  let recordIdentityExposed = false;
  if (Object.hasOwn(record, "registryId")) {
    registryIdentityExposed = true;
    if (record.registryId !== registryId) {
      throw new Error("Registry record response is malformed.");
    }
  }
  if (Object.hasOwn(record, "registryArn")) {
    registryIdentityExposed = true;
    if (record.registryArn !== expectedRegistryArn) {
      throw new Error("Registry record response is malformed.");
    }
  }
  if (Object.hasOwn(record, "recordId")) {
    recordIdentityExposed = true;
    if (record.recordId !== recordId) {
      throw new Error("Registry record response is malformed.");
    }
  }
  if (Object.hasOwn(record, "recordArn")) {
    recordIdentityExposed = true;
    if (record.recordArn !== expectedRecordArn) {
      throw new Error("Registry record response is malformed.");
    }
  }
  if (
    !registryIdentityExposed
    || !recordIdentityExposed
    || record.recordVersion !== candidate.semver
    || !REGISTRY_RECORD_STATUSES.has(record.status)
    || (
      record.status === targetStatus
      &&
      record.statusReason !== undefined
      && record.statusReason !== candidate.reason
    )
  ) {
    throw new Error("Registry record response is malformed.");
  }
  if (record.status === targetStatus) return "TARGET";
  if (record.status === "PENDING_APPROVAL") return "PENDING";
  if (record.status === "UPDATING") return "UPDATING";
  return "OTHER";
}

export function createPlatformAdminService({
  state,
  registry,
  domainDirectory,
  registryInventory,
  decisionFinalizer,
  region,
  account,
  tags,
  now = () => new Date(),
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  domainPollAttempts = DEFAULT_DOMAIN_POLL_ATTEMPTS,
  domainPollDelayMs = DEFAULT_DOMAIN_POLL_DELAY_MS,
  decisionPollAttempts = DEFAULT_DECISION_POLL_ATTEMPTS,
  decisionPollDelayMs = DEFAULT_DECISION_POLL_DELAY_MS,
  decisionRetryBackoffSeconds =
    DEFAULT_DECISION_RETRY_BACKOFF_SECONDS,
  decisionRecoveryCooldownSeconds =
    DEFAULT_DECISION_RECOVERY_COOLDOWN_SECONDS,
}) {
  if (
    !state
    || typeof state.getDomain !== "function"
    || typeof state.listDomains !== "function"
    || typeof state.getRequestResult !== "function"
    || typeof state.claimDomainRequest !== "function"
    || typeof state.markDomainRequestRetryable !== "function"
    || typeof state.markDomainRequestConflict !== "function"
    || typeof state.markDomainRequestProvisioningCleanupPending
      !== "function"
    || typeof state.markDomainRequestCommitCleanupPending !== "function"
    || typeof state.claimDomainRequestCleanup !== "function"
    || typeof state.releaseDomainRequestCleanup !== "function"
    || typeof state.markDomainRequestCleanupComplete !== "function"
    || typeof state.putDomainWithRequestResult !== "function"
    || !registry
    || typeof registry.send !== "function"
    || !domainDirectory
    || typeof domainDirectory.ensureGroup !== "function"
    || typeof domainDirectory.deleteGroupExact !== "function"
    || !registryInventory
    || typeof registryInventory.registryOnly !== "function"
    || typeof now !== "function"
    || typeof sleep !== "function"
    || !Number.isSafeInteger(domainPollAttempts)
    || domainPollAttempts < 1
    || domainPollAttempts > 12
    || !Number.isSafeInteger(domainPollDelayMs)
    || domainPollDelayMs < 0
    || domainPollDelayMs > 5_000
    || !Number.isSafeInteger(decisionPollAttempts)
    || decisionPollAttempts < 1
    || decisionPollAttempts > 10
    || !Number.isSafeInteger(decisionPollDelayMs)
    || decisionPollDelayMs < 0
    || decisionPollDelayMs > 5_000
    || !Number.isSafeInteger(decisionRetryBackoffSeconds)
    || decisionRetryBackoffSeconds < 1
    || decisionRetryBackoffSeconds > 300
    || !Number.isSafeInteger(decisionRecoveryCooldownSeconds)
    || decisionRecoveryCooldownSeconds
      <= decisionRetryBackoffSeconds * (MAX_DECISION_ATTEMPTS - 1)
    || decisionRecoveryCooldownSeconds > 86_400
  ) {
    throw new TypeError("Platform admin service dependencies are invalid.");
  }
  if (!isCommercialAwsRegion(region)) {
    throw new TypeError("Platform region is invalid.");
  }
  const configuredRegion = region;
  const configuredAccount = requireConfigurationString(
    account,
    /^[0-9]{12}$/,
    "Platform account",
  );
  const mandatoryTags = validateTags(tags);

  return {
    async decideRegistryVersion(scope, input) {
      const { identity, inventoryScope } = validateDecisionScope(scope);
      const candidate = normalizeRegistryDecision(input);
      const fingerprint = decisionPayloadFingerprint(candidate);
      const clock = clockSnapshot(now);
      const replayOptions = {
        candidate,
        fingerprint,
        identity,
      };
      if (
        typeof state.claimRegistryDecisionTarget !== "function"
        || typeof state.markRegistryDecisionMutationAttempted
          !== "function"
        || typeof state.markRegistryDecisionRetryable !== "function"
        || !decisionFinalizer
        || typeof decisionFinalizer.finalize !== "function"
      ) {
        throw new TypeError(
          "Platform admin Registry decision state is invalid.",
        );
      }
      const targetStatus = candidate.decision === "approve"
        ? "APPROVED"
        : "REJECTED";
      let prior = await inspectStoredDecision(state, replayOptions);
      if (prior.action === "RETURN") return prior.value;
      let claim = prior.claim;
      let phase = prior.action;

      if (phase === "BIND") {
        let version;
        try {
          version = selectRegistryVersion(
            candidate.registryId
              ? await registryInventory.registryTarget(inventoryScope, candidate)
              : await registryInventory.registryOnly(inventoryScope),
            candidate,
          );
        } catch (error) {
          if (error instanceof PlatformAdminServiceError) throw error;
          throw registryDecisionFailure();
        }
        const target = {
          registryId: version._aws.registryId,
          recordId: version._aws.recordId,
          semver: candidate.semver,
          targetStatus,
          statusReasonHash: createHash("sha256")
            .update(candidate.reason)
            .digest("hex"),
        };
        claim = decisionClaimRecord(
          identity,
          fingerprint,
          randomUUID(),
          clock,
          target,
        );
        try {
          await state.claimRegistryDecisionTarget(claim);
          phase = "TARGET_BOUND";
        } catch (error) {
          if (error?.code === "REGISTRY_RESOURCE_CONFLICT") {
            throw registryDecisionConflict(
              "This Registry record already has a decision in progress.",
            );
          }
          if (error?.code !== "REQUEST_CLAIM_CONFLICT") throw error;
          prior = await inspectStoredDecision(state, replayOptions);
          if (prior.action === "RETURN") return prior.value;
          if (
            prior.action !== "TARGET_BOUND"
            && prior.action !== "MUTATION_ATTEMPTED"
            && prior.action !== "RETRYABLE"
          ) {
            throw registryDecisionFailure();
          }
          claim = prior.claim;
          phase = prior.action;
        }
      }

      if (phase === "TARGET_BOUND" || phase === "RETRYABLE") {
        if (
          claim.attemptCount >= MAX_DECISION_ATTEMPTS
          || (
            phase === "RETRYABLE"
            && claim.retryAfter > clock.epochSeconds
          )
        ) {
          throw phase === "RETRYABLE"
            ? registryDecisionFailure()
            : registryDecisionConflict(
              "The Registry decision retry budget is exhausted.",
            );
        }
        let shouldMutate = false;
        try {
          await state.markRegistryDecisionMutationAttempted(claim);
          phase = "MUTATION_ATTEMPTED";
          claim = {
            ...claim,
            phase,
            attemptCount: claim.attemptCount + 1,
            retryAfter: 0,
          };
          shouldMutate = true;
        } catch (error) {
          if (
            error?.code !== "REQUEST_CLAIM_CONFLICT"
            && error?.code !== "REGISTRY_RESOURCE_CONFLICT"
          ) {
            throw error;
          }
          prior = await inspectStoredDecision(state, replayOptions);
          if (prior.action === "RETURN") return prior.value;
          if (prior.action !== "MUTATION_ATTEMPTED") {
            throw registryDecisionFailure();
          }
          claim = prior.claim;
          phase = prior.action;
        }
        if (shouldMutate) {
          try {
            await registry.send(new UpdateRegistryRecordStatusCommand({
              registryId: claim.target.registryId,
              recordId: claim.target.recordId,
              status: claim.target.targetStatus,
              statusReason: candidate.reason,
            }));
          } catch {
            // The request may have failed before send or after AWS accepted it.
            // Reconciliation below is authoritative for both outcomes.
          }
        }
      }

      let decisionState;
      for (let attempt = 0; attempt < decisionPollAttempts; attempt += 1) {
        try {
          const authoritative = await registry.send(
            new GetRegistryRecordCommand({
              registryId: claim.target.registryId,
              recordId: claim.target.recordId,
            }),
          );
          decisionState = authoritativeDecisionState(authoritative, {
            candidate,
            registryId: claim.target.registryId,
            recordId: claim.target.recordId,
            targetStatus: claim.target.targetStatus,
            region: configuredRegion,
            account: configuredAccount,
          });
        } catch {
          throw registryDecisionFailure();
        }
        if (decisionState === "TARGET" || decisionState === "OTHER") {
          break;
        }
        if (attempt + 1 < decisionPollAttempts) {
          await sleep(decisionPollDelayMs);
        }
      }
      if (decisionState === "PENDING") {
        const cooldownSeconds =
          claim.attemptCount >= MAX_DECISION_ATTEMPTS
            ? decisionRecoveryCooldownSeconds
            : decisionRetryBackoffSeconds * claim.attemptCount;
        const retryableClaim = {
          ...claim,
          retryAfter: clock.epochSeconds + cooldownSeconds,
        };
        try {
          await state.markRegistryDecisionRetryable(retryableClaim);
        } catch (error) {
          if (
            error?.code === "REQUEST_CLAIM_CONFLICT"
            || error?.code === "REGISTRY_RESOURCE_CONFLICT"
          ) {
            const winner = await inspectStoredDecision(
              state,
              replayOptions,
            );
            if (winner.action === "RETURN") return winner.value;
          }
          throw registryDecisionFailure();
        }
        throw registryDecisionUncertain();
      }
      if (decisionState === "UPDATING") {
        throw registryDecisionFailure();
      }
      if (decisionState !== "TARGET") {
        throw registryDecisionConflict(
          "The Registry record no longer matches the requested decision.",
        );
      }

      const version = {
        id: candidate.id,
        semver: candidate.semver,
        status: claim.target.targetStatus,
        statusReason: candidate.reason,
        _aws: {
          registryId: claim.target.registryId,
          recordId: claim.target.recordId,
        },
      };
      const resource =
        `registry/${claim.target.registryId}`
        + `/record/${claim.target.recordId}`
        + `/version/${claim.target.semver}`;
      const success = { ok: true, version };
      const requestResult = {
        ...decisionRequestIdentity(identity),
        result: {
          kind: DECISION_KIND,
          status: "SUCCEEDED",
          payloadFingerprint: fingerprint,
          resource,
          decision: candidate.decision,
          reason: candidate.reason,
          version,
        },
        createdAt: claim.createdAt,
      };
      const audit = {
        actor: identity.actor,
        action: "registry.version.decide",
        resource,
        decision: candidate.decision,
        reason: candidate.reason,
        requestId: identity.requestId,
        timestamp: claim.createdAt,
      };
      const transactionClaim = {
        kind: DECISION_KIND,
        payloadFingerprint: fingerprint,
        ownerToken: claim.ownerToken,
        attemptCount: claim.attemptCount,
        target: structuredClone(claim.target),
      };
      try {
        await decisionFinalizer.finalize({
          audit,
          requestResult,
          claim: transactionClaim,
        });
        return success;
      } catch (error) {
        if (error?.code === "IDEMPOTENCY_CONFLICT") {
          throw idempotencyConflict();
        }
        if (
          error?.code === "REQUEST_CLAIM_CONFLICT"
          || error?.code === "REGISTRY_RESOURCE_CONFLICT"
        ) {
          const winner = await inspectStoredDecision(
            state,
            replayOptions,
          );
          if (winner.action === "RETURN") return winner.value;
        }
        throw registryDecisionFailure();
      }
    },

    async createDomain(scope, input) {
      const identity = validateScope(scope);
      const candidate = normalizeDomainInput(input);
      const registryTags = tagsForDomain(
        identity,
        candidate,
        mandatoryTags,
      );
      const fingerprint = payloadFingerprint(candidate);
      const expectedOwnerGroup = domainGroupOwnership(
        identity,
        candidate.id,
      );
      const groupOperationToken = expectedOwnerGroup.operationToken;
      const clock = clockSnapshot(now);
      const replayOptions = {
        account: configuredAccount,
        actor: identity.actor,
        candidate,
        clock,
        expectedOwnerGroup,
        fingerprint,
        identity,
        region: configuredRegion,
      };
      const prior = await inspectStored(state, replayOptions);
      if (prior.action === "RETURN") return prior.value;
      if (prior.action === "CLEANUP") {
        return completePendingDomainCleanup({
          account: configuredAccount,
          candidate,
          cleanup: prior.cleanup,
          clock,
          createdAt: prior.createdAt,
          domainDirectory,
          expectedOwnerGroup,
          fingerprint,
          identity,
          reason: prior.reason,
          region: configuredRegion,
          registry,
          state,
        });
      }
      if (prior.action === "WAIT") throw provisioningFailure();
      if (await state.getDomain(candidate.id)) {
        throw domainConflict();
      }

      const claim = claimRecord(
        identity,
        fingerprint,
        randomUUID(),
        clock,
        prior.registry,
      );
      try {
        await state.claimDomainRequest(claim);
      } catch (error) {
        if (error?.code !== "REQUEST_CLAIM_CONFLICT") throw error;
        const winner = await inspectStored(state, replayOptions);
        if (winner.action === "RETURN") return winner.value;
        throw provisioningFailure();
      }

      let registryRecord = prior.registry;
      if (registryRecord === undefined) {
        try {
          const response = await registry.send(new CreateRegistryCommand({
            name: `domain_${candidate.id}`,
            description: `${candidate.name} domain registry`,
            clientToken: domainRegistryClientToken(
              identity,
              candidate.id,
            ),
            tags: registryTags,
          }));
          registryRecord = registryIdentity(
            response,
            configuredRegion,
            configuredAccount,
          );
        } catch {
          const recovered = await markRetryable(
            state,
            claim,
            replayOptions,
          );
          if (recovered) return recovered;
          throw provisioningFailure();
        }
      }
      let registryReady;
      try {
        registryReady = await waitForRegistryReady({
          account: configuredAccount,
          attempts: domainPollAttempts,
          delayMs: domainPollDelayMs,
          identity: registryRecord,
          region: configuredRegion,
          registry,
          sleep,
        });
      } catch {
        let fenced;
        try {
          fenced = await state.markDomainRequestProvisioningCleanupPending({
            ...claim,
            cleanup: {
              registryId: registryRecord.registryId,
              registryArn: registryRecord.registryArn,
            },
          });
        } catch {
          try {
            const winner = await inspectStored(state, replayOptions);
            if (winner.action === "RETURN") return winner.value;
            if (winner.action === "CLEANUP") {
              if (
                winner.reason !== "DOMAIN_PROVISIONING_FAILED"
                || winner.cleanup.registryId !== registryRecord.registryId
                || winner.cleanup.registryArn !== registryRecord.registryArn
              ) {
                throw idempotencyConflict();
              }
              throw provisioningFailure();
            }
          } catch (reconciliationError) {
            if (
              reconciliationError instanceof PlatformAdminServiceError
            ) {
              throw reconciliationError;
            }
            // Fence reconciliation must not expose state details.
          }
          throw provisioningFailure();
        }
        const pending = replayStored({
          ...replayOptions,
          stored: fenced,
        });
        if (
          pending.action !== "CLEANUP"
          || pending.reason !== "DOMAIN_PROVISIONING_FAILED"
          || pending.cleanup.registryId !== registryRecord.registryId
          || pending.cleanup.registryArn !== registryRecord.registryArn
        ) {
          throw idempotencyConflict();
        }
        return completePendingDomainCleanup({
          account: configuredAccount,
          candidate,
          cleanup: pending.cleanup,
          clock,
          createdAt: pending.createdAt,
          domainDirectory,
          expectedOwnerGroup,
          fingerprint,
          identity,
          reason: pending.reason,
          region: configuredRegion,
          registry,
          state,
        });
      }
      if (!registryReady) {
        const recovered = await markRetryable(
          state,
          {
            ...claim,
            registry: registryRecord,
          },
          replayOptions,
        );
        if (recovered) return recovered;
        throw provisioningFailure();
      }

      try {
        await domainDirectory.ensureGroup(
          expectedOwnerGroup.name,
          groupOperationToken,
        );
      } catch (error) {
        if (error?.code !== "DOMAIN_GROUP_CONFLICT") {
          const recovered = await markRetryable(
            state,
            {
              ...claim,
              registry: registryRecord,
            },
            replayOptions,
          );
          if (recovered) return recovered;
          throw provisioningFailure();
        }
        let fenced;
        try {
          fenced = await state.markDomainRequestConflict({
            ...claim,
            cleanup: {
              registryId: registryRecord.registryId,
              registryArn: registryRecord.registryArn,
            },
          });
        } catch {
          try {
            const winner = await inspectStored(state, replayOptions);
            if (winner.action === "RETURN") return winner.value;
            if (winner.action === "CLEANUP") {
              throw provisioningFailure();
            }
          } catch (reconciliationError) {
            if (
              reconciliationError instanceof PlatformAdminServiceError
            ) {
              throw reconciliationError;
            }
          }
          throw provisioningFailure();
        }
        const pending = replayStored({
          ...replayOptions,
          stored: fenced,
        });
        if (
          pending.action !== "CLEANUP"
          || pending.reason !== "DOMAIN_CONFLICT"
          || pending.cleanup.registryId !== registryRecord.registryId
          || pending.cleanup.registryArn !== registryRecord.registryArn
          || pending.cleanup.ownerGroup !== undefined
        ) {
          throw idempotencyConflict();
        }
        return completePendingDomainCleanup({
          account: configuredAccount,
          candidate,
          cleanup: pending.cleanup,
          clock,
          createdAt: pending.createdAt,
          domainDirectory,
          expectedOwnerGroup,
          fingerprint,
          identity,
          reason: pending.reason,
          region: configuredRegion,
          registry,
          state,
        });
      }

      const domain = {
        ...candidate,
        ...registryRecord,
        status: "ACTIVE",
        createdBy: identity.actor,
        createdAt: clock.createdAt,
      };
      const success = { ok: true, domain };
      try {
        await state.putDomainWithRequestResult({
          domain,
          requestResult: resultRecord(identity, {
            kind: "DOMAIN_CREATE",
            status: "SUCCEEDED",
            payloadFingerprint: fingerprint,
            domain,
          }, clock),
          claim: {
            payloadFingerprint: fingerprint,
            ownerToken: claim.ownerToken,
          },
        });
        return success;
      } catch (error) {
        try {
          const winner = await inspectStored(state, replayOptions);
          if (winner.action === "RETURN") {
            return winner.value;
          }
        } catch (reconciliationError) {
          if (
            reconciliationError instanceof PlatformAdminServiceError
            && (
              reconciliationError.code === "IDEMPOTENCY_CONFLICT"
              || reconciliationError.code === "DOMAIN_CONFLICT"
            )
          ) {
            throw reconciliationError;
          }
          // Reconciliation failures must not expose state details.
        }
        if (error?.code === "REQUEST_CLAIM_CONFLICT") {
          throw provisioningFailure();
        }
        const cleanupReason = error?.code === "DOMAIN_CONFLICT"
          ? "DOMAIN_CONFLICT"
          : "DOMAIN_COMMIT_FAILED";
        let fenced;
        try {
          const fence = cleanupReason === "DOMAIN_CONFLICT"
            ? state.markDomainRequestConflict.bind(state)
            : state.markDomainRequestCommitCleanupPending.bind(state);
          fenced = await fence({
            ...claim,
            cleanup: {
              registryId: registryRecord.registryId,
              registryArn: registryRecord.registryArn,
              ownerGroup: structuredClone(expectedOwnerGroup),
            },
          });
        } catch {
          try {
            const winner = await inspectStored(state, replayOptions);
            if (winner.action === "RETURN") return winner.value;
            if (
              winner.action === "CLEANUP"
              || winner.action === "WAIT"
            ) {
              throw provisioningFailure();
            }
          } catch (reconciliationError) {
            if (
              reconciliationError instanceof PlatformAdminServiceError
            ) {
              throw reconciliationError;
            }
            // Fence reconciliation must not expose state details.
          }
          throw provisioningFailure();
        }
        const pending = replayStored({
          ...replayOptions,
          stored: fenced,
        });
        if (
          pending.action !== "CLEANUP"
          || pending.reason !== cleanupReason
          || pending.cleanup.registryId !== registryRecord.registryId
          || pending.cleanup.registryArn !== registryRecord.registryArn
          || !isDeepStrictEqual(
            pending.cleanup.ownerGroup,
            expectedOwnerGroup,
          )
        ) {
          throw idempotencyConflict();
        }
        return completePendingDomainCleanup({
          account: configuredAccount,
          candidate,
          cleanup: pending.cleanup,
          clock,
          createdAt: pending.createdAt,
          domainDirectory,
          expectedOwnerGroup,
          fingerprint,
          identity,
          reason: pending.reason,
          region: configuredRegion,
          registry,
          state,
        });
      }
    },

    async listDomains(scope) {
      const domains = (await state.listDomains())
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id));
      if (scope?.role === "admin") {
        return { ok: true, domains };
      }
      const trustedClaims = Array.isArray(scope?.allowedDomains)
        && scope.allowedDomains.every(
          (id) =>
            typeof id === "string"
            && id.length <= 64
            && DOMAIN_ID_PATTERN.test(id),
        );
      const allowed = trustedClaims
        ? new Set(scope.allowedDomains)
        : new Set();
      return {
        ok: true,
        domains: domains.filter(({ id }) => allowed.has(id)),
      };
    },
  };
}
