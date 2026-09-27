import { createAlertDraftWriter, createAlertCatalogRead } from './alert-drafts.mjs';
import { createPolicyDraftWriter } from './policy-drafts.mjs';
import { createGuardrailOperations } from './guardrail-exceptions.mjs';
import { validateHitlCatalog } from "../workspace/hitl-policies.mjs";
import {
  domainMayDiscover,
  validateVisibilityCatalog,
} from "../workspace/catalog-visibility.mjs";
import { createHash } from "node:crypto";
import { capabilitiesForRole } from "../authz/capabilities.mjs";
import {
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
// Namespace import + fallback: tsx transpiles the cross-package .ts to CJS,
// where named-export detection fails and the exports land on `default`;
// esbuild (Lambda bundling) exposes them as named exports directly.
import * as governedDescriptorModule
  from "../../../platform-registry/lib/governed-descriptor.ts";
const { REGISTRY_RECORD_VERSION_PATTERN } =
  governedDescriptorModule.REGISTRY_RECORD_VERSION_PATTERN
    ? governedDescriptorModule
    : governedDescriptorModule.default;

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9]{12,16}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9]{12}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const RESOURCE_TYPES = new Set([
  "AGENT",
  "TOOL",
  "MCP_SERVER",
  "SKILL",
  "BLUEPRINT",
]);
const REGISTRY_STATUSES = new Set([
  "CREATING",
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "DEPRECATED",
  "CREATE_FAILED",
  "UPDATING",
  "UPDATE_FAILED",
]);
const DECISIONS = new Set(["APPROVE", "REJECT"]);
const ENTITLEMENT_SUBJECT_TYPES = new Set(["USER", "GROUP", "DOMAIN"]);
const MAX_DESCRIPTOR_BYTES = 48 * 1024;
const MAX_DOMAINS = 100;
const MAX_DISCOVERY_ITEMS = 50;
const MAX_DISCOVERY_SCANNED_RECORDS = 500;
const MAX_DISCOVERY_PAGES_PER_DOMAIN = 4;
const MAX_PAGINATION_TOKEN_LENGTH = 4096;
const MAX_ENTITLEMENT_LIST_ITEMS = 50;
const MAX_ENTITLEMENT_CURSOR_LENGTH = 4096;
const MAX_DEPLOYMENT_READINESS_PAGES = 100;
const MAX_DEPLOYMENTS_SCANNED = 10_000;
const REQUIRED_TAGS = new Set(["auto-delete", "managedBy", "project"]);
const REGISTER_DRAFT_ROUTE = "POST /api/governance/registry-drafts";
const SUBMIT_PUBLICATION_ROUTE = "POST /api/governance/publications";
const INITIATE_PUBLICATION_ROUTE =
  "POST /api/governance/publication-initiations";
const DECIDE_PUBLICATION_ROUTE =
  "POST /api/governance/publication-decisions";
const REQUEST_ACCESS_ROUTE = "POST /api/governance/access-requests";
const DECIDE_ACCESS_ROUTE = "POST /api/governance/access-decisions";
const GRANT_ENTITLEMENT_ROUTE =
  "POST /api/governance/agent-entitlements";
const REVOKE_ENTITLEMENT_ROUTE =
  "POST /api/governance/agent-entitlement-revocations";
const DRAFT_REGISTERED_REASON = "Registry draft registered.";
const PUBLICATION_REQUESTED_REASON =
  "Domain resource publication requested.";
const PUBLICATION_INITIATED_REASON =
  "Domain resource publication initiated by platform admin.";
const ACCESS_REQUESTED_REASON = "Shared resource access requested.";
const MAX_AUDIT_CLOCK_ATTEMPTS = 4;
const GOVERNED_RECORD_VERSION_BUILD = "platform-descriptor.1";
// Server-side RegistryRecordVersion max is 255 (source:
// @aws-sdk/client-agent-registry-control shape RegistryRecordVersion).
// governedRecordVersion grows the input by at most one separator
// ("-" or ".") plus GOVERNED_RECORD_VERSION_BUILD, so the draft version
// input cap is 255 - (1 + "platform-descriptor.1".length) = 255 - 22 = 233.
const MAX_DRAFT_VERSION_LENGTH =
  255 - (1 + GOVERNED_RECORD_VERSION_BUILD.length);
const GOVERNED_RESOURCE_TYPES_BY_RECORD_TYPE = Object.freeze({
  AGENT: new Set(["AGENT"]),
  SKILL: new Set(["SKILL"]),
  MCP: new Set(["MCP_SERVER"]),
  CUSTOM: new Set(["TOOL", "BLUEPRINT"]),
});

const ERROR_DETAILS = Object.freeze({
  HITL_POLICY_NOT_CONFIGURED: {
    statusCode: 503,
    message: "No hosted tool-interrupt policy catalog is initialized for this domain.",
    retryable: false,
  },
  INVALID_REQUEST: {
    statusCode: 400,
    message: "The governance request is invalid.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested governance action is not allowed.",
    retryable: false,
  },
  REQUESTER_CANNOT_APPROVE: {
    statusCode: 403,
    message: "The requester cannot approve this resource.",
    retryable: false,
  },
  NOT_FOUND: {
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  },
  CONFLICT: {
    statusCode: 409,
    message: "The resource state does not permit this action.",
    retryable: false,
  },
  REGISTRY_UNAVAILABLE: {
    statusCode: 503,
    message: "The Agent Registry is temporarily unavailable.",
    retryable: true,
  },
  WORKSPACE_UNAVAILABLE: {
    statusCode: 503,
    message: "Governance state is temporarily unavailable.",
    retryable: true,
  },
});

export class GovernanceServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) throw new TypeError("Governance error code is invalid.");
    super(detail.message);
    this.name = "GovernanceServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.retryable;
  }
}

function fail(code) {
  throw new GovernanceServiceError(code);
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

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.size
    && keys.every((key) => typeof key === "string" && expected.has(key))
  );
}

function nonEmptyString(value, maximum) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateIdentity(value) {
  if (
    !exactKeys(
      value,
      new Set(["actor", "role", "activeDomain", "domainIds"]),
    )
    || typeof value.actor !== "string"
    || !SUBJECT_PATTERN.test(value.actor)
    || !ROLES.has(value.role)
    || !Array.isArray(value.domainIds)
    || value.domainIds.length > MAX_DOMAINS
    || value.domainIds.some(
      (item) => typeof item !== "string" || !DOMAIN_PATTERN.test(item),
    )
    || new Set(value.domainIds).size !== value.domainIds.length
  ) {
    fail("INVALID_REQUEST");
  }
  if (value.role === "user") fail("FORBIDDEN");
  if (
    (value.role === "lead" || value.role === "builder")
    && (
      typeof value.activeDomain !== "string"
      || !DOMAIN_PATTERN.test(value.activeDomain)
      || value.domainIds.length !== 1
      || value.domainIds[0] !== value.activeDomain
    )
  ) {
    fail("FORBIDDEN");
  }
  if (
    value.role === "admin"
    && value.activeDomain !== null
    && !value.domainIds.includes(value.activeDomain)
  ) {
    fail("FORBIDDEN");
  }
  return {
    actor: value.actor,
    role: value.role,
    activeDomain: value.activeDomain,
    domainIds: [...value.domainIds],
  };
}

function validateRequestId(value) {
  if (!nonEmptyString(value, 128) || !REQUEST_ID_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateResourceType(value) {
  if (!RESOURCE_TYPES.has(value)) fail("INVALID_REQUEST");
  return value;
}

function validateResourceId(value) {
  if (!nonEmptyString(value, 256) || !RESOURCE_ID_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateRegistryId(value) {
  if (typeof value !== "string" || !REGISTRY_ID_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateRecordId(value) {
  if (typeof value !== "string" || !RECORD_ID_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateSlug(value) {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateReason(value) {
  if (!nonEmptyString(value, 1024) || value.length < 3) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateEntitlementSubject(subjectType, subject) {
  if (!ENTITLEMENT_SUBJECT_TYPES.has(subjectType)) {
    fail("INVALID_REQUEST");
  }
  if (typeof subject !== "string") fail("INVALID_REQUEST");
  const valid = subjectType === "DOMAIN"
    ? DOMAIN_PATTERN.test(subject)
    : subjectType === "GROUP"
      ? GROUP_PATTERN.test(subject)
      : SUBJECT_PATTERN.test(subject);
  if (!valid) fail("INVALID_REQUEST");
  return { subjectType, subject };
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateNullableTimestamp(value) {
  if (value === null) return null;
  if (!isCanonicalTimestamp(value)) fail("INVALID_REQUEST");
  return value;
}

function validateDecision(value) {
  if (!DECISIONS.has(value)) fail("INVALID_REQUEST");
  return value;
}

function validateJson(value, depth = 0) {
  if (depth > 12) fail("INVALID_REQUEST");
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (
      typeof value === "number"
      && Number.isFinite(value)
    )
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) fail("INVALID_REQUEST");
    return value.map((item) => validateJson(item, depth + 1));
  }
  if (!isPlainObject(value)) fail("INVALID_REQUEST");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 200
    || keys.some(
      (key) =>
        typeof key !== "string"
        || key.length === 0
        || key.length > 256
        || /[\u0000-\u001f\u007f]/.test(key),
    )
  ) {
    fail("INVALID_REQUEST");
  }
  const result = Object.create(null);
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      fail("INVALID_REQUEST");
    }
    result[key] = validateJson(descriptor.value, depth + 1);
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function governedRecordVersion(version) {
  if (!SEMVER_PATTERN.test(version)) fail("INVALID_REQUEST");
  const [withoutBuild, build = ""] = version.split("+", 2);
  const governedSuffix = `.${GOVERNED_RECORD_VERSION_BUILD}`;
  let governed;
  if (
    withoutBuild.endsWith(`-${GOVERNED_RECORD_VERSION_BUILD}`)
    || withoutBuild.endsWith(governedSuffix)
  ) {
    governed = withoutBuild;
  } else {
    const retainedBuild = build === GOVERNED_RECORD_VERSION_BUILD
      || build.endsWith(governedSuffix)
      ? build.slice(0, -governedSuffix.length)
      : build;
    const separator = withoutBuild.includes("-") ? "." : "-";
    governed = `${withoutBuild}${separator}${[
      retainedBuild,
      GOVERNED_RECORD_VERSION_BUILD,
    ].filter(Boolean).join(".")}`;
  }
  // Exit re-check, aligned with platform-registry/lib/governed-descriptor.ts.
  // Merging `+` build metadata into the prerelease segment can produce
  // identifiers that are illegal SemVer (e.g. leading-zero "01") yet still
  // pass the server-side RegistryRecordVersion pattern — such a record would
  // be written but never read back (validateRecord rejects it).
  if (
    !hasGovernedRecordVersion(governed)
    || !REGISTRY_RECORD_VERSION_PATTERN.test(governed)
  ) {
    fail("INVALID_REQUEST");
  }
  return governed;
}

function hasGovernedRecordVersion(value) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) return false;
  const build = value.split("+", 2)[1];
  if (
    typeof build === "string"
    && build.split(".").slice(-2).join(".")
      === GOVERNED_RECORD_VERSION_BUILD
  ) {
    return true;
  }
  const versionWithoutBuild = value.split("+", 1)[0];
  const prereleaseStart = versionWithoutBuild.indexOf("-");
  const prerelease = prereleaseStart === -1
    ? undefined
    : versionWithoutBuild.slice(prereleaseStart + 1);
  return typeof prerelease === "string"
    && prerelease.split(".").slice(-2).join(".")
      === GOVERNED_RECORD_VERSION_BUILD;
}

function descriptorFor(resource, actor) {
  const ownerSubject = resource.ownerSubject ?? actor;
  const payload = {
    schemaVersion: 1,
    resourceKind: resource.resourceType.toLowerCase(),
    specification: resource.specification,
    "x-platform": {
      domainId: resource.domainId,
      ownerSubject,
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      shared: resource.shared,
    },
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DESCRIPTOR_BYTES) {
    fail("INVALID_REQUEST");
  }
  if (resource.resourceType === "AGENT") {
    return {
      recordType: "AGENT",
      descriptors: {
        custom: { data: serialized },
      },
    };
  }
  if (resource.resourceType === "SKILL") {
    return {
      recordType: "SKILL",
      descriptors: {
        agentSkillsDefinition: { data: serialized },
      },
    };
  }
  if (resource.resourceType === "MCP_SERVER") {
    return {
      recordType: "MCP",
      descriptors: {
        mcpServer: { data: serialized },
      },
    };
  }
  return {
    recordType: "CUSTOM",
    descriptors: {
      custom: { data: serialized },
    },
  };
}

function descriptorData(record, { allowUnmanaged = false } = {}) {
  const governedVersion = hasGovernedRecordVersion(record.recordVersion);
  const candidates = {
    AGENT:
      record.descriptors?.a2aAgentCard?.data
      || record.descriptors?.custom?.data,
    SKILL: record.descriptors?.agentSkillsDefinition?.data,
    MCP: record.descriptors?.mcpServer?.data,
    CUSTOM: record.descriptors?.custom?.data,
  };
  const raw = candidates[record.recordType];
  if (typeof raw !== "string" || raw.length === 0) {
    if (allowUnmanaged && !governedVersion) return null;
    fail("REGISTRY_UNAVAILABLE");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    if (allowUnmanaged && !governedVersion) return null;
    fail("REGISTRY_UNAVAILABLE");
  }
  const hasSchemaVersion = isPlainObject(value)
    && Object.hasOwn(value, "schemaVersion");
  const hasGovernedMetadata = isPlainObject(value?.["x-platform"])
    && [
      "domainId",
      "ownerSubject",
      "resourceId",
      "resourceType",
      "shared",
    ].some((key) => Object.hasOwn(value["x-platform"], key));
  if (
    !isPlainObject(value)
    || !governedVersion
    || value.schemaVersion !== 1
    || !isPlainObject(value["x-platform"])
  ) {
    if (
      allowUnmanaged
      && !governedVersion
      && !hasSchemaVersion
      && !hasGovernedMetadata
    ) {
      return null;
    }
    fail("REGISTRY_UNAVAILABLE");
  }
  const metadata = value["x-platform"];
  if (
    !exactKeys(
      metadata,
      new Set([
        "domainId",
        "ownerSubject",
        "resourceId",
        "resourceType",
        "shared",
      ]),
    )
    || !DOMAIN_PATTERN.test(metadata.domainId)
    || !SUBJECT_PATTERN.test(metadata.ownerSubject)
    || !RESOURCE_ID_PATTERN.test(metadata.resourceId)
    || !RESOURCE_TYPES.has(metadata.resourceType)
    || !GOVERNED_RESOURCE_TYPES_BY_RECORD_TYPE[
      record.recordType
    ]?.has(metadata.resourceType)
    || typeof metadata.shared !== "boolean"
  ) {
    fail("REGISTRY_UNAVAILABLE");
  }
  return {
    metadata: { ...metadata },
    specification: value.specification,
  };
}

function validateRecord(
  value,
  registryId,
  recordId,
  { allowUnmanaged = false } = {},
) {
  if (
    !isPlainObject(value)
    || value.recordId !== recordId
    || typeof value.recordArn !== "string"
    || !value.recordArn.endsWith(`:registry/${registryId}/record/${recordId}`)
    || typeof value.registryArn !== "string"
    || !value.registryArn.endsWith(`:registry/${registryId}`)
    || !nonEmptyString(value.name, 256)
    || !nonEmptyString(value.displayName, 256)
    || !nonEmptyString(value.description, 2048)
    || !["AGENT", "SKILL", "MCP", "CUSTOM"].includes(value.recordType)
    || !SEMVER_PATTERN.test(value.recordVersion)
    || !REGISTRY_STATUSES.has(value.status)
  ) {
    fail("REGISTRY_UNAVAILABLE");
  }
  const descriptor = descriptorData(value, { allowUnmanaged });
  if (descriptor === null) return null;
  return {
    registryId,
    registryArn: value.registryArn,
    recordId,
    recordArn: value.recordArn,
    name: value.name,
    displayName: value.displayName,
    description: value.description,
    recordType: value.recordType,
    recordVersion: value.recordVersion,
    status: value.status,
    ...descriptor,
  };
}

function recordIdFromArn(value, registryId) {
  if (typeof value !== "string") fail("REGISTRY_UNAVAILABLE");
  const suffix = `:registry/${registryId}/record/`;
  const offset = value.indexOf(suffix);
  if (offset < 0) fail("REGISTRY_UNAVAILABLE");
  return validateRecordId(value.slice(offset + suffix.length));
}

function registryNextToken(page) {
  const value = page?.nextToken;
  if (value === undefined) return undefined;
  if (!nonEmptyString(value, MAX_PAGINATION_TOKEN_LENGTH)) {
    fail("REGISTRY_UNAVAILABLE");
  }
  return value;
}

function validateDomain(value, expectedId) {
  if (
    !isPlainObject(value)
    || value.id !== expectedId
    || value.status !== "ACTIVE"
    || typeof value.registryId !== "string"
    || !REGISTRY_ID_PATTERN.test(value.registryId)
    || typeof value.registryArn !== "string"
    || !value.registryArn.endsWith(`:registry/${value.registryId}`)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return {
    id: value.id,
    registryId: value.registryId,
    registryArn: value.registryArn,
  };
}

function validateTags(value) {
  if (
    !isPlainObject(value)
    || ![...REQUIRED_TAGS].every(
      (key) => nonEmptyString(value[key], 256),
    )
    || value["auto-delete"] !== "no"
  ) {
    throw new TypeError("Governance service configuration is invalid.");
  }
  return Object.freeze(Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, value[key]]),
  ));
}

function entitlementListScope(identity) {
  if (identity.role === "admin") return "*";
  if (
    identity.role === "lead"
    && typeof identity.activeDomain === "string"
    && identity.domainIds.length === 1
    && identity.domainIds[0] === identity.activeDomain
  ) {
    return identity.activeDomain;
  }
  fail("FORBIDDEN");
}

function validateEntitlementListLimit(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_ENTITLEMENT_LIST_ITEMS
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateEntitlementCursorKeys(value, scope) {
  if (
    !isPlainObject(value)
    || !exactKeys(value, new Set(["pk", "sk"]))
    || typeof value.pk !== "string"
    || value.pk.length === 0
    || value.pk.length > 1024
    || typeof value.sk !== "string"
    || value.sk.length === 0
    || value.sk.length > 1024
    || !value.pk.startsWith("ENTITLEMENT#")
  ) {
    fail("INVALID_REQUEST");
  }
  const partitionSuffix = value.pk.slice("ENTITLEMENT#".length);
  const separator = partitionSuffix.indexOf("#");
  const possibleType = separator < 0
    ? null
    : partitionSuffix.slice(0, separator);
  const subjectType = ENTITLEMENT_SUBJECT_TYPES.has(possibleType)
    ? possibleType
    : "USER";
  const subject = subjectType === "USER" && possibleType === null
    ? partitionSuffix
    : partitionSuffix.slice(separator + 1);
  validateEntitlementSubject(subjectType, subject);
  const expectedPartition = subjectType === "USER" && possibleType === null
    ? `ENTITLEMENT#${subject}`
    : `ENTITLEMENT#${subjectType}#${subject}`;
  const sortKey =
    /^AGENT#([a-z][a-z0-9]*(?:_[a-z0-9]+)*)#([a-z][a-z0-9-]{0,63})#([a-z][a-z0-9-]{0,63})$/
      .exec(value.sk);
  if (
    value.pk !== expectedPartition
    || !sortKey
    || (scope !== "*" && sortKey[1] !== scope)
  ) {
    fail("INVALID_REQUEST");
  }
  return { pk: value.pk, sk: value.sk };
}

function encodeEntitlementCursor(scope, cursor) {
  if (cursor === null) return null;
  const value = validateEntitlementCursorKeys(cursor, scope);
  return Buffer.from(JSON.stringify({
    v: 1,
    scope,
    pk: value.pk,
    sk: value.sk,
  })).toString("base64url");
}

function decodeEntitlementCursor(scope, value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ENTITLEMENT_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
  let decoded;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    fail("INVALID_REQUEST");
  }
  if (
    !exactKeys(decoded, new Set(["v", "scope", "pk", "sk"]))
    || decoded.v !== 1
    || decoded.scope !== scope
  ) {
    fail("INVALID_REQUEST");
  }
  return validateEntitlementCursorKeys(
    { pk: decoded.pk, sk: decoded.sk },
    scope,
  );
}

function activeDomain(identity, requested) {
  const domainId = requested ?? identity.activeDomain
    ?? (identity.role === "admin" ? "platform" : null);
  if (
    typeof domainId !== "string"
    || !DOMAIN_PATTERN.test(domainId)
    || (
      identity.role !== "admin"
      && identity.activeDomain !== domainId
    )
  ) {
    fail("NOT_FOUND");
  }
  if (
    identity.role === "admin"
    && domainId !== "platform"
  ) {
    fail("FORBIDDEN");
  }
  return domainId;
}

function entitlementDomain(identity, requested) {
  if (typeof requested !== "string" || !DOMAIN_PATTERN.test(requested)) {
    fail("INVALID_REQUEST");
  }
  const domainId = requested;
  if (
    (
      identity.role !== "admin"
      && identity.activeDomain !== domainId
    )
    || !identity.domainIds.includes(domainId)
  ) {
    fail("NOT_FOUND");
  }
  return domainId;
}

async function readState(state, method, input) {
  try {
    return await state[method](input);
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
}

async function writeState(state, method, input) {
  try {
    return await state[method](input);
  } catch (error) {
    if (error?.code === "REQUESTER_CANNOT_APPROVE") {
      fail("REQUESTER_CANNOT_APPROVE");
    }
    if (
      typeof error?.code === "string"
      && (
        error.code.includes("CONFLICT")
        || error.code.includes("TRANSITION")
      )
    ) {
      fail("CONFLICT");
    }
    fail("WORKSPACE_UNAVAILABLE");
  }
}

function transaction(state) {
  let value;
  try {
    value = state.beginTransaction();
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  const parsed = Date.parse(value?.timestamp);
  if (
    !isPlainObject(value)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value.timestamp
    || !Number.isSafeInteger(value.epochSeconds)
    || value.epochSeconds !== Math.floor(parsed / 1000)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return value;
}

function mutation({
  identity,
  requestId,
  route,
  entityType,
  resourceKey,
  operation,
  domainId,
  decision,
  reason,
  clock,
  payload,
  requesterSubject = identity.actor,
  projectId = null,
  authorizationEvidenceId = null,
}) {
  return {
    actor: identity.actor,
    requesterSubject,
    effectiveRole: identity.role,
    domainId,
    projectId,
    route,
    requestId,
    payloadFingerprint: fingerprint(payload),
    result: {
      entityType,
      resourceKey,
      operation,
      status: "SUCCEEDED",
    },
    decision,
    reason,
    timestamp: clock.timestamp,
    createdAt: clock.timestamp,
    ...(authorizationEvidenceId === null
      ? {}
      : { authorizationEvidenceId }),
  };
}

async function completedMutation(state, {
  identity,
  route,
  requestId,
}) {
  try {
    return await state.getMutationResult({
      actor: identity.actor,
      route,
      requestId,
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
}

async function existingMutationClaim(resolver, expected) {
  let value;
  try {
    value = await resolver({
      actor: expected.actor,
      route: expected.route,
      requestId: expected.requestId,
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (value === null) return null;
  if (
    !isPlainObject(value)
    || value.actor !== expected.actor
    || value.requesterSubject !== expected.requesterSubject
    || value.effectiveRole !== expected.effectiveRole
    || value.domainId !== expected.domainId
    || value.projectId !== expected.projectId
    || value.route !== expected.route
    || value.requestId !== expected.requestId
    || value.payloadFingerprint !== expected.payloadFingerprint
    || value.resourceKey !== expected.resourceKey
    || value.operation !== expected.operation
  ) {
    fail("CONFLICT");
  }
  return value;
}

function validateCompletedMutation(value, {
  identity,
  requesterSubject,
  domainId,
  projectId = null,
  route,
  requestId,
  payloadFingerprint,
  entityType,
  resourceKey,
  operation,
  decision,
  reason,
}) {
  if (value === null) return null;
  const result = value?.result;
  if (
    !isPlainObject(value)
    || !isPlainObject(result)
    || value.actor !== identity.actor
    || value.requesterSubject !== requesterSubject
    || value.effectiveRole !== identity.role
    || value.domainId !== domainId
    || value.projectId !== projectId
    || value.route !== route
    || value.requestId !== requestId
    || value.payloadFingerprint !== payloadFingerprint
    || result.entityType !== entityType
    || result.resourceKey !== resourceKey
    || result.operation !== operation
    || result.status !== "SUCCEEDED"
    || value.decision !== decision
    || value.reason !== reason
  ) {
    fail("CONFLICT");
  }
  return value;
}

function draftRecordIdFromCompletedMutation(value, {
  identity,
  domainId,
  registryId,
  requestId,
  payloadFingerprint,
}) {
  if (value === null) return null;
  const result = value?.result;
  const prefix = `audit/registry-draft/${registryId}/`;
  if (
    !isPlainObject(value)
    || !isPlainObject(result)
    || value.actor !== identity.actor
    || value.requesterSubject !== identity.actor
    || value.effectiveRole !== identity.role
    || value.domainId !== domainId
    || value.projectId !== null
    || value.route !== REGISTER_DRAFT_ROUTE
    || value.requestId !== requestId
    || value.payloadFingerprint !== payloadFingerprint
    || result.entityType !== "WORKSPACE_AUDIT"
    || typeof result.resourceKey !== "string"
    || !result.resourceKey.startsWith(prefix)
    || result.operation !== "APPEND"
    || result.status !== "SUCCEEDED"
    || value.decision !== "register"
    || value.reason !== DRAFT_REGISTERED_REASON
  ) {
    fail("CONFLICT");
  }
  const recordId = result.resourceKey.slice(prefix.length).split("/", 1)[0];
  if (!RECORD_ID_PATTERN.test(recordId)) fail("CONFLICT");
  return recordId;
}

async function claimRegistryMutation(state, claim) {
  try {
    if (await state.claimMutation(claim) !== true) {
      fail("WORKSPACE_UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof GovernanceServiceError) throw error;
    if (error?.code === "MUTATION_IN_PROGRESS") return false;
    if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
    fail("WORKSPACE_UNAVAILABLE");
  }
  return true;
}

async function appendDraftCompletion(state, {
  identity,
  domainId,
  registryId,
  recordId,
  requestId,
  payloadFingerprint,
}) {
  for (let attempt = 0; attempt < MAX_AUDIT_CLOCK_ATTEMPTS; attempt += 1) {
    const clock = transaction(state);
    const resource = `registry-draft/${registryId}/${recordId}`;
    const audit = {
      resource,
      timestamp: clock.timestamp,
      requestId,
      actor: identity.actor,
      requesterSubject: identity.actor,
      effectiveRole: identity.role,
      action: "registry.draft.register",
      decision: "register",
      reason: DRAFT_REGISTERED_REASON,
      domainId,
      projectId: null,
    };
    const completion = {
      actor: identity.actor,
      requesterSubject: identity.actor,
      effectiveRole: identity.role,
      domainId,
      projectId: null,
      route: REGISTER_DRAFT_ROUTE,
      requestId,
      payloadFingerprint,
      result: {
        entityType: "WORKSPACE_AUDIT",
        resourceKey:
          `audit/${resource}/${clock.timestamp}/${requestId}`,
        operation: "APPEND",
        status: "SUCCEEDED",
      },
      decision: "register",
      reason: DRAFT_REGISTERED_REASON,
      timestamp: clock.timestamp,
      createdAt: clock.timestamp,
    };
    try {
      return await state.appendAudit({
        record: audit,
        mutation: completion,
        transaction: clock,
      });
    } catch (error) {
      if (
        (
          error?.code === "INVALID_AUDIT"
          || error?.code === "INVALID_MUTATION"
        )
        && attempt + 1 < MAX_AUDIT_CLOCK_ATTEMPTS
      ) {
        continue;
      }
      if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
      fail("WORKSPACE_UNAVAILABLE");
    }
  }
  fail("WORKSPACE_UNAVAILABLE");
}

const SET_VISIBILITY_ROUTE = "POST /api/governance/catalog-visibility";

// Same audit-trail contract as appendDraftCompletion: a WORKSPACE_AUDIT row
// plus the completed-mutation record, retried across clock ticks.
async function appendVisibilityAudit(state, {
  identity,
  requestId,
  reference,
  mode,
  reason,
}) {
  const payloadFingerprint = fingerprint({ reference, mode, reason });
  for (let attempt = 0; attempt < MAX_AUDIT_CLOCK_ATTEMPTS; attempt += 1) {
    const clock = transaction(state);
    const resource = `catalog-visibility/${reference}`;
    const audit = {
      resource,
      timestamp: clock.timestamp,
      requestId,
      actor: identity.actor,
      requesterSubject: identity.actor,
      effectiveRole: identity.role,
      action: "catalog.visibility.set",
      decision: mode,
      reason,
      domainId: "platform",
      projectId: null,
    };
    const completion = {
      actor: identity.actor,
      requesterSubject: identity.actor,
      effectiveRole: identity.role,
      domainId: "platform",
      projectId: null,
      route: SET_VISIBILITY_ROUTE,
      requestId,
      payloadFingerprint,
      result: {
        entityType: "WORKSPACE_AUDIT",
        resourceKey:
          `audit/${resource}/${clock.timestamp}/${requestId}`,
        operation: "APPEND",
        status: "SUCCEEDED",
      },
      decision: mode,
      reason,
      timestamp: clock.timestamp,
      createdAt: clock.timestamp,
    };
    try {
      return await state.appendAudit({
        record: audit,
        mutation: completion,
        transaction: clock,
      });
    } catch (error) {
      if (
        (
          error?.code === "INVALID_AUDIT"
          || error?.code === "INVALID_MUTATION"
        )
        && attempt + 1 < MAX_AUDIT_CLOCK_ATTEMPTS
      ) {
        continue;
      }
      if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
      fail("WORKSPACE_UNAVAILABLE");
    }
  }
  fail("WORKSPACE_UNAVAILABLE");
}

async function authorize(authorizer, identity, action, resource, approvalId) {
  const reference = Buffer.from(
    JSON.stringify({
      v: 1,
      ...resource,
    }),
    "utf8",
  ).toString("base64url");
  try {
    const result = await authorizer({
      requestContext: Object.freeze({
        source: "governance-service",
        subject: identity.actor,
        role: identity.role,
        activeDomain: identity.activeDomain,
        domainIds: Object.freeze([...identity.domainIds]),
      }),
      action,
      resourceRef: `governance:${reference}`,
      ...(approvalId
        ? { approvalRef: `approval:${resource.domainId}/${approvalId}` }
        : {}),
    });
    if (result !== true && result?.ok !== true) fail("FORBIDDEN");
    if (result?.usedBreakGlass === true) {
      if (
        typeof result.authorizationEvidenceId !== "string"
        || !SLUG_PATTERN.test(result.authorizationEvidenceId)
      ) {
        fail("FORBIDDEN");
      }
      return result.authorizationEvidenceId;
    }
    return null;
  } catch (error) {
    if (error instanceof GovernanceServiceError) throw error;
    if (error?.decision === "NOT_FOUND") fail("NOT_FOUND");
    if (error?.reason === "REQUESTER_IS_APPROVER") {
      fail("REQUESTER_CANNOT_APPROVE");
    }
    fail("FORBIDDEN");
  }
}

async function registrySend(client, command) {
  try {
    return await client.send(command);
  } catch {
    fail("REGISTRY_UNAVAILABLE");
  }
}

async function getRecord(
  client,
  registryId,
  recordId,
  { allowUnmanaged = false } = {},
) {
  const value = await registrySend(
    client,
    new GetRegistryRecordCommand({ registryId, recordId }),
  );
  return validateRecord(
    value,
    registryId,
    recordId,
    { allowUnmanaged },
  );
}

async function pollRecord(client, registryId, recordId, statuses, sleep) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = await getRecord(client, registryId, recordId);
    if (statuses.has(value.status)) return value;
    if (
      !new Set(["CREATING", "UPDATING"]).has(value.status)
    ) {
      fail("CONFLICT");
    }
    // Native Registry creation is asynchronous. A still-transitional record
    // is retryable, not a conflicting user request. Replays retain clientToken.
    if (attempt < 7) await sleep(Math.min(250 * 2 ** attempt, 1000));
  }
  fail("REGISTRY_UNAVAILABLE");
}

// Recoverable two-service workflow, not an atomic Registry/DynamoDB transaction.
// Re-read the exact target before and after Submit, binding owner, version and
// domain to the approval snapshot; concurrent drift must never look successful.
async function ensureRecordPendingApproval(client, registryId, recordId, authoritative, sleep) {
  const matches = value => value.registryArn === authoritative.registryArn
    && value.recordArn === authoritative.recordArn
    && value.recordVersion === authoritative.recordVersion
    && value.metadata.ownerSubject === authoritative.metadata.ownerSubject
    && value.metadata.domainId === authoritative.metadata.domainId
    && value.metadata.resourceId === authoritative.metadata.resourceId
    && value.metadata.resourceType === authoritative.metadata.resourceType;
  const current = await getRecord(client, registryId, recordId);
  if (!matches(current)) fail("CONFLICT");
  if (current.status === "PENDING_APPROVAL") return current;
  if (!["DRAFT", "REJECTED"].includes(current.status)) fail("CONFLICT");
  await registrySend(client, new SubmitRegistryRecordForApprovalCommand({ registryId, recordId }));
  const pending = await pollRecord(client, registryId, recordId, new Set(["PENDING_APPROVAL"]), sleep);
  if (!matches(pending)) fail("CONFLICT");
  return pending;
}

function assertRecordDomain(record, domain) {
  if (
    record.registryId !== domain.registryId
    || record.registryArn !== domain.registryArn
    || record.recordArn !== `${domain.registryArn}/record/${record.recordId}`
    || record.metadata.domainId !== domain.id
  ) {
    fail("NOT_FOUND");
  }
}

function assertRecordIdentity(record, expected) {
  if (
    record.metadata.resourceType !== expected.resourceType
  ) {
    fail("CONFLICT");
  }
}

function validateApprovalRecord(
  value,
  expected,
  { mismatchCode = "WORKSPACE_UNAVAILABLE" } = {},
) {
  if (value === null) return null;
  const expectsProjectId = Object.hasOwn(expected, "projectId");
  if (
    !isPlainObject(value)
    || (
      value.projectId !== null
      && (
        typeof value.projectId !== "string"
        || !SLUG_PATTERN.test(value.projectId)
      )
    )
    || !["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(value.status)
    || !SUBJECT_PATTERN.test(value.requesterSubject)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (
    value.domainId !== expected.domainId
    || (
      expectsProjectId
      && value.projectId !== expected.projectId
    )
    || value.id !== expected.id
    || value.kind !== expected.kind
    || (
      expected.resourceType !== undefined
      && value.resourceType !== expected.resourceType
    )
    || (
      expected.resourceId !== undefined
      && value.resourceId !== expected.resourceId
    )
  ) {
    fail(mismatchCode);
  }
  return value;
}

function recordReference(registryId, recordId) {
  return `${registryId}/${recordId}`;
}

function draftResult(authoritative) {
  return {
    registryId: authoritative.registryId,
    recordId: authoritative.recordId,
    recordArn: authoritative.recordArn,
    resourceType: authoritative.metadata.resourceType,
    resourceId: authoritative.metadata.resourceId,
    domainId: authoritative.metadata.domainId,
    displayName: authoritative.displayName,
    version: authoritative.recordVersion,
    shared: authoritative.metadata.shared,
    status: authoritative.status,
  };
}

function splitRecordReference(value) {
  if (typeof value !== "string") fail("WORKSPACE_UNAVAILABLE");
  const parts = value.split("/");
  if (
    parts.length !== 2
    || !REGISTRY_ID_PATTERN.test(parts[0])
    || !RECORD_ID_PATTERN.test(parts[1])
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return { registryId: parts[0], recordId: parts[1] };
}

function validateDraftInput(value) {
  const hasOwnerSubject = Object.hasOwn(value, "ownerSubject");
  if (
    !exactKeys(
      value,
      new Set([
        "domainId",
        "resourceType",
        "resourceId",
        "displayName",
        "description",
        "version",
        "shared",
        "specification",
        ...(hasOwnerSubject ? ["ownerSubject"] : []),
      ]),
    )
    || !DOMAIN_PATTERN.test(value.domainId)
    || !nonEmptyString(value.displayName, 256)
    || !nonEmptyString(value.description, 2048)
    || !nonEmptyString(value.version, MAX_DRAFT_VERSION_LENGTH)
    || !SEMVER_PATTERN.test(value.version)
    || typeof value.shared !== "boolean"
    || (
      hasOwnerSubject
      && (
        typeof value.ownerSubject !== "string"
        || !SUBJECT_PATTERN.test(value.ownerSubject)
      )
    )
  ) {
    fail("INVALID_REQUEST");
  }
  return {
    domainId: value.domainId,
    resourceType: validateResourceType(value.resourceType),
    resourceId: validateResourceId(value.resourceId),
    displayName: value.displayName,
    description: value.description,
    version: value.version,
    shared: value.shared,
    specification: validateJson(value.specification),
    ...(hasOwnerSubject
      ? { ownerSubject: value.ownerSubject }
      : {}),
  };
}

function validateAgentPublicationInput(value) {
  if (
    !exactKeys(
      value,
      new Set([
        "identity",
        "requestId",
        "domainId",
        "projectId",
        "agentId",
      ]),
    )
    || typeof value.domainId !== "string"
    || !DOMAIN_PATTERN.test(value.domainId)
  ) {
    fail("INVALID_REQUEST");
  }
  return {
    identity: validateIdentity(value.identity),
    requestId: validateRequestId(value.requestId),
    domainId: value.domainId,
    projectId: validateSlug(value.projectId),
    agentId: validateSlug(value.agentId),
  };
}

function validatePublicationProject(value, expected) {
  if (
    !isPlainObject(value)
    || value.domainId !== expected.domainId
    || value.id !== expected.projectId
    || !nonEmptyString(value.name, 128)
    || !SUBJECT_PATTERN.test(value.ownerSubject)
    || !Array.isArray(value.memberSubjects)
    || value.memberSubjects.some(
      (subject) =>
        typeof subject !== "string"
        || !SUBJECT_PATTERN.test(subject),
    )
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (value.status !== "ACTIVE") fail("CONFLICT");
  return value;
}

function validatePublicationAgent(value, expected) {
  const publishableStatuses = new Set([
    "TESTED",
    "SANDBOX_DEPLOYED",
    "PRODUCTION_PENDING",
    "PRODUCTION_APPROVED",
    "PRODUCTION_DEPLOYED",
    "REJECTED",
  ]);
  if (
    !isPlainObject(value)
    || value.domainId !== expected.domainId
    || value.projectId !== expected.projectId
    || value.id !== expected.agentId
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (!publishableStatuses.has(value.status)) fail("CONFLICT");
  if (
    !nonEmptyString(value.name, 128)
    || typeof value.description !== "string"
    || !SUBJECT_PATTERN.test(value.ownerSubject)
    || !nonEmptyString(value.modelId, 256)
    || value.lastTestStatus !== "SUCCEEDED"
    || !isCanonicalTimestamp(value.lastTestedAt)
    || !nonEmptyString(value.lastTestRequestId, 128)
    || !/^[a-f0-9]{64}$/.test(value.lastTestEvidenceHash)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  for (const field of [
    "toolIds",
    "mcpServerIds",
    "skillIds",
    "blueprintIds",
    "memoryIds",
    "knowledgeBaseIds",
  ]) {
    if (
      !Array.isArray(value[field])
      || value[field].some(
        (item) => typeof item !== "string" || item.length === 0,
      )
    ) {
      fail("WORKSPACE_UNAVAILABLE");
    }
  }
  return value;
}

function agentPublicationResource(agent, project) {
  return {
    domainId: agent.domainId,
    resourceType: "AGENT",
    resourceId: `${project.id}/${agent.id}`,
    displayName: agent.name,
    description: agent.description
      || `${agent.name} from ${project.name}.`,
    version: "1.0.0",
    shared: false,
    ownerSubject: agent.ownerSubject,
    specification: {
      projectId: project.id,
      agentId: agent.id,
      modelId: agent.modelId,
      toolIds: [...agent.toolIds],
      mcpServerIds: [...agent.mcpServerIds],
      skillIds: [...agent.skillIds],
      blueprintIds: [...agent.blueprintIds],
      memoryIds: [...agent.memoryIds],
      knowledgeBaseIds: [...agent.knowledgeBaseIds],
      buildConfig: agent.buildConfig,
      testEvidence: {
        status: agent.lastTestStatus,
        testedAt: agent.lastTestedAt,
        modelId: agent.lastTestModelId,
        inputTokens: agent.lastTestInputTokens,
        outputTokens: agent.lastTestOutputTokens,
        requestId: agent.lastTestRequestId,
        evidenceHash: agent.lastTestEvidenceHash,
      },
    },
  };
}

function registryName(domainId, resourceId) {
  const normalized = `${domainId}-${resourceId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  if (!SLUG_PATTERN.test(normalized)) fail("INVALID_REQUEST");
  return normalized;
}

async function putApproval(state, {
  identity,
  requestId,
  route,
  record,
  expectedStatus,
  decision,
  reason,
  payload,
}) {
  const clock = transaction(state);
  const timestamped = {
    ...record,
    ...(record.status === "PENDING"
      ? { requestedAt: clock.timestamp }
      : { decidedAt: clock.timestamp }),
  };
  return writeState(state, "putApproval", {
    record: timestamped,
    expectedStatus,
    mutation: mutation({
      identity,
      requesterSubject: timestamped.requesterSubject,
      requestId,
      route,
      entityType: "APPROVAL",
      resourceKey: `approval/${timestamped.domainId}/${timestamped.id}`,
      operation: expectedStatus === null ? "CREATE" : "UPDATE",
      domainId: timestamped.domainId,
      projectId: timestamped.projectId,
      decision,
      reason,
      clock,
      payload,
    }),
    transaction: clock,
  });
}

async function putGrant(state, {
  identity,
  requestId,
  route,
  record,
  expectedStatus,
  decision,
  reason,
  payload,
}) {
  const clock = transaction(state);
  const timestamped = {
    ...record,
    ...(record.status === "ACTIVE"
      ? { grantedAt: clock.timestamp }
      : { revokedAt: clock.timestamp }),
  };
  return writeState(state, "putResourceGrant", {
    record: timestamped,
    expectedStatus,
    mutation: mutation({
      identity,
      requestId,
      route,
      entityType: "RESOURCE_GRANT",
      resourceKey:
        `grant/${timestamped.domainId}/${timestamped.resourceType}/`
        + timestamped.resourceId,
      operation: expectedStatus === null ? "CREATE" : "UPDATE",
      domainId: timestamped.domainId,
      decision,
      reason,
      clock,
      payload,
    }),
    transaction: clock,
  });
}

async function putEntitlement(state, {
  identity,
  requestId,
  route,
  record,
  expectedStatus,
  decision,
  reason,
  payload,
  clock = transaction(state),
  expectedRecord,
  authorizationEvidenceId = null,
}) {
  const timestamped = {
    ...record,
    ...(record.status === "ACTIVE"
      ? { grantedAt: clock.timestamp }
      : { revokedAt: clock.timestamp }),
  };
  return writeState(state, "putEntitlement", {
    record: timestamped,
    expectedStatus,
    mutation: mutation({
      identity,
      requestId,
      route,
      entityType: "ENTITLEMENT",
      resourceKey:
        "entitlement/"
        + (
          timestamped.subjectType === undefined
            ? `${timestamped.subject}`
            : `${timestamped.subjectType}/${timestamped.subject}`
        )
        + `/${timestamped.domainId}/`
        + `${timestamped.projectId}/${timestamped.agentId}`,
      operation: expectedStatus === null ? "CREATE" : "UPDATE",
      domainId: timestamped.domainId,
      projectId: timestamped.projectId,
      decision,
      reason,
      clock,
      payload,
      authorizationEvidenceId,
    }),
    transaction: clock,
    ...(expectedRecord === undefined ? {} : { expectedRecord }),
  });
}

async function putApprovedAccess(state, {
  identity,
  requestId,
  approval,
  reason,
  payload,
  grant = null,
  entitlement = null,
}) {
  if ((grant === null) === (entitlement === null)) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  const clock = transaction(state);
  const approved = {
    ...approval,
    status: "APPROVED",
    approverSubject: identity.actor,
    reason,
    decidedAt: clock.timestamp,
  };
  const approvalWrite = {
    record: approved,
    expectedStatus: "PENDING",
    mutation: mutation({
      identity,
      requesterSubject: approved.requesterSubject,
      requestId: `${requestId}.approval`,
      route: DECIDE_ACCESS_ROUTE,
      entityType: "APPROVAL",
      resourceKey: `approval/${approved.domainId}/${approved.id}`,
      operation: "UPDATE",
      domainId: approved.domainId,
      decision: "approve",
      reason,
      clock,
      payload,
    }),
  };
  const accessWrite = grant === null
    ? {
        record: {
          ...entitlement,
          grantedAt: clock.timestamp,
        },
        expectedStatus: null,
        mutation: mutation({
          identity,
          requesterSubject: entitlement.subject,
          requestId: `${requestId}.entitlement`,
          route: DECIDE_ACCESS_ROUTE,
          entityType: "ENTITLEMENT",
          resourceKey:
            `entitlement/${entitlement.subject}/${entitlement.domainId}/`
            + `${entitlement.projectId}/${entitlement.agentId}`,
          operation: "CREATE",
          domainId: entitlement.domainId,
          projectId: entitlement.projectId,
          decision: "grant",
          reason,
          clock,
          payload,
        }),
      }
    : {
        record: {
          ...grant,
          grantedAt: clock.timestamp,
        },
        expectedStatus: null,
        mutation: mutation({
          identity,
          requestId: `${requestId}.grant`,
          route: DECIDE_ACCESS_ROUTE,
          entityType: "RESOURCE_GRANT",
          resourceKey:
            `grant/${grant.domainId}/${grant.resourceType}/`
            + grant.resourceId,
          operation: "CREATE",
          domainId: grant.domainId,
          decision: "grant",
          reason,
          clock,
          payload,
        }),
      };
  return writeState(state, "putAccessDecision", {
    approval: approvalWrite,
    ...(grant === null
      ? { entitlement: accessWrite }
      : { grant: accessWrite }),
    transaction: clock,
  });
}

export function createGovernanceService({
  workspaceState,
  domainDirectory,
  registryClient,
  authorizer,
  mutationClaimResolver,
  mandatoryTags,
  // The shared registry holds platform-curated cross-domain records but has no
  // DOMAIN row in workspace state, so domainForRegistry() dead-ended every
  // review of a shared record with NOT_FOUND. When configured, it joins domain
  // resolution as the virtual "shared" domain; approvals persist under
  // APPROVAL#shared and follow the same 4-eyes publication workflow.
  sharedRegistry = null,
  // Catalog visibility document accessors (workspace/catalog-visibility.mjs).
  // Optional: deployments without them keep the legacy shared-flag behavior.
  visibilityCatalog = null,
  exceptionStore = null,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (
    !workspaceState
    || ![
      "beginTransaction",
      "getApproval",
      "getResourceGrant",
      "getEntitlement",
      "listAgentEntitlements",
      "getProject",
      "getAgent",
      "listDeployments",
      "getMutationResult",
      "claimMutation",
      "appendAudit",
      "putApproval",
      "putResourceGrant",
      "putEntitlement",
      "putAccessDecision",
    ].every((method) => typeof workspaceState[method] === "function")
    || !domainDirectory
    || typeof domainDirectory.getDomain !== "function"
    || typeof domainDirectory.listActiveDomains !== "function"
    || !registryClient
    || typeof registryClient.send !== "function"
    || typeof authorizer !== "function"
    || typeof mutationClaimResolver !== "function"
    || typeof sleep !== "function"
  ) {
    throw new TypeError("Governance service configuration is invalid.");
  }
  const tags = validateTags(mandatoryTags);
  const sharedDomain = sharedRegistry === null
    ? null
    : validateDomain(
        {
          id: "shared",
          status: "ACTIVE",
          registryId: sharedRegistry.registryId,
          registryArn: sharedRegistry.registryArn,
        },
        "shared",
      );

  async function domainById(id) {
    if (sharedDomain !== null && id === "shared") return sharedDomain;
    let value;
    try {
      value = await domainDirectory.getDomain(id);
    } catch {
      fail("WORKSPACE_UNAVAILABLE");
    }
    if (value === null) fail("NOT_FOUND");
    return validateDomain(value, id);
  }

  async function activeDomains() {
    let values;
    try {
      values = await domainDirectory.listActiveDomains();
    } catch {
      fail("WORKSPACE_UNAVAILABLE");
    }
    if (
      !Array.isArray(values)
      || values.length > MAX_DOMAINS
    ) {
      fail("WORKSPACE_UNAVAILABLE");
    }
    const result = values.map((value) => validateDomain(value, value?.id));
    if (new Set(result.map((value) => value.id)).size !== result.length) {
      fail("WORKSPACE_UNAVAILABLE");
    }
    return result;
  }

  async function domainForRegistry(registryId) {
    if (sharedDomain !== null && registryId === sharedDomain.registryId) {
      return sharedDomain;
    }
    const matches = (await activeDomains()).filter(
      (domain) => domain.registryId === registryId,
    );
    if (matches.length !== 1) fail("NOT_FOUND");
    return matches[0];
  }

  async function productionAgent(domainId, projectId, agentId) {
    const agent = await readState(workspaceState, "getAgent", {
      domainId,
      projectId,
      agentId,
    });
    if (
      !isPlainObject(agent)
      || agent.domainId !== domainId
      || agent.projectId !== projectId
      || agent.id !== agentId
      || agent.status !== "PRODUCTION_DEPLOYED"
    ) {
      fail("CONFLICT");
    }
    let cursor;
    let scanned = 0;
    let ready = 0;
    const seenCursors = new Set();
    for (
      let pageNumber = 0;
      pageNumber < MAX_DEPLOYMENT_READINESS_PAGES;
      pageNumber += 1
    ) {
      const deploymentPage = await readState(
        workspaceState,
        "listDeployments",
        {
          domainId,
          projectId,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      if (
        !exactKeys(deploymentPage, new Set(["items", "cursor"]))
        || !Array.isArray(deploymentPage.items)
        || deploymentPage.items.length > 100
        || (
          deploymentPage.cursor !== null
          && (
            !exactKeys(
              deploymentPage.cursor,
              new Set(["pk", "sk"]),
            )
            || deploymentPage.cursor.pk
              !== `DEPLOYMENT#${domainId}#${projectId}`
            || typeof deploymentPage.cursor.sk !== "string"
            || !deploymentPage.cursor.sk.startsWith("DEPLOYMENT#")
          )
        )
        || deploymentPage.items.some(
          (deployment) =>
            !isPlainObject(deployment)
            || deployment.domainId !== domainId
            || deployment.projectId !== projectId
            || typeof deployment.agentId !== "string"
            || !SLUG_PATTERN.test(deployment.agentId)
            || typeof deployment.environment !== "string"
            || typeof deployment.status !== "string"
            || (
              deployment.runtimeStatus !== null
              && typeof deployment.runtimeStatus !== "string"
            ),
        )
      ) {
        fail("WORKSPACE_UNAVAILABLE");
      }
      scanned += deploymentPage.items.length;
      if (scanned > MAX_DEPLOYMENTS_SCANNED) {
        fail("WORKSPACE_UNAVAILABLE");
      }
      ready += deploymentPage.items.filter(
        (deployment) =>
          deployment.agentId === agentId
          && deployment.environment === "PRODUCTION"
          && deployment.status === "DEPLOYED"
          && deployment.runtimeStatus === "READY",
      ).length;
      if (ready > 1) fail("CONFLICT");
      if (deploymentPage.cursor === null) {
        if (ready !== 1) fail("CONFLICT");
        return agent;
      }
      const cursorKey =
        `${deploymentPage.cursor.pk}\u0000${deploymentPage.cursor.sk}`;
      if (seenCursors.has(cursorKey)) fail("WORKSPACE_UNAVAILABLE");
      seenCursors.add(cursorKey);
      cursor = deploymentPage.cursor;
    }
    fail("WORKSPACE_UNAVAILABLE");
  }

  function validateStoredTypedEntitlement(value, expected) {
    if (value === null) return null;
    const typed = exactKeys(
      value,
      new Set([
        "subjectType",
        "subject",
        "domainId",
        "projectId",
        "agentId",
        "status",
        "expiresAt",
        "grantedBySubject",
        "grantedAt",
        "revokedBySubject",
        "revokedAt",
      ]),
    );
    const legacyUser = expected.subjectType === "USER" && exactKeys(
      value,
      new Set([
        "subject",
        "domainId",
        "projectId",
        "agentId",
        "status",
        "grantedBySubject",
        "grantedAt",
        "revokedBySubject",
        "revokedAt",
      ]),
    );
    const normalized = legacyUser
      ? {
          ...value,
          subjectType: "USER",
          expiresAt: null,
        }
      : value;
    if (
      (!typed && !legacyUser)
      || !ENTITLEMENT_SUBJECT_TYPES.has(normalized.subjectType)
      || normalized.subjectType !== expected.subjectType
      || normalized.subject !== expected.subject
      || normalized.domainId !== expected.domainId
      || normalized.projectId !== expected.projectId
      || normalized.agentId !== expected.agentId
      || !new Set(["ACTIVE", "REVOKED"]).has(normalized.status)
      || typeof normalized.grantedBySubject !== "string"
      || !SUBJECT_PATTERN.test(normalized.grantedBySubject)
      || (
        normalized.expiresAt !== null
        && !isCanonicalTimestamp(normalized.expiresAt)
      )
      || !isCanonicalTimestamp(normalized.grantedAt)
      || (
        normalized.expiresAt !== null
        && Date.parse(normalized.expiresAt)
          <= Date.parse(normalized.grantedAt)
      )
      || (
        normalized.status === "ACTIVE"
        && (
          normalized.revokedBySubject !== null
          || normalized.revokedAt !== null
        )
      )
      || (
        normalized.status === "REVOKED"
        && (
          typeof normalized.revokedBySubject !== "string"
          || !SUBJECT_PATTERN.test(normalized.revokedBySubject)
          || !isCanonicalTimestamp(normalized.revokedAt)
          || Date.parse(normalized.revokedAt)
            < Date.parse(normalized.grantedAt)
        )
      )
    ) {
      fail("CONFLICT");
    }
    return normalized;
  }

  const operations = {
    ...createGuardrailOperations({ store: exceptionStore, workspaceState, domainDirectory, validateIdentity, fail }),
    saveAlertDraft: createAlertDraftWriter({state:workspaceState,validateIdentity,fail}),
    readAlertPolicies: createAlertCatalogRead({state:workspaceState,validateIdentity,fail}),
    savePolicyDraft: createPolicyDraftWriter({state:workspaceState,validateIdentity,fail}),
    async readHitlPolicies(input) {
      if (!isPlainObject(input) || !exactKeys(input, new Set([
        "identity", "limit", ...(Object.hasOwn(input, "cursor") ? ["cursor"] : []),
      ]))) fail("INVALID_REQUEST");
      const identity = validateIdentity(input.identity);
      if (!capabilitiesForRole(identity.role).includes("manageApprovalPolicies")) fail("FORBIDDEN");
      // The platform catalog is the default for an unscoped platform admin.
      // Explicit domain context selects only that domain's catalog, never a scan.
      const domainId = identity.activeDomain ?? "platform";
      if (!identity.domainIds.includes(domainId)) fail("FORBIDDEN");
      const limit = input.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("INVALID_REQUEST");
      let cursor;
      if (Object.hasOwn(input, "cursor")) {
        try {
          if (typeof input.cursor !== "string" || input.cursor.length > 1024
            || !/^[A-Za-z0-9_-]+$/.test(input.cursor)
            || Buffer.from(input.cursor, "base64url").toString("base64url") !== input.cursor) fail("INVALID_REQUEST");
          cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
          if (!exactKeys(cursor, new Set(["schemaVersion", "domainId", "revision", "offset"]))
            || cursor.schemaVersion !== 1 || cursor.domainId !== domainId
            || !Number.isSafeInteger(cursor.revision) || cursor.revision < 1
            || !Number.isInteger(cursor.offset) || cursor.offset < 1 || cursor.offset >= 200) fail("INVALID_REQUEST");
        } catch { fail("INVALID_REQUEST"); }
      }
      let catalog;
      try {
        if (typeof workspaceState.readHitlPolicyCatalog !== "function") fail("WORKSPACE_UNAVAILABLE");
        catalog = await workspaceState.readHitlPolicyCatalog({ domainId });
        if (catalog !== null) catalog = validateHitlCatalog(catalog, domainId);
      } catch { fail("WORKSPACE_UNAVAILABLE"); }
      if (catalog === null) fail("HITL_POLICY_NOT_CONFIGURED");
      if (cursor && cursor.revision !== catalog.revision) fail("CONFLICT");
      if (cursor && cursor.offset >= catalog.policies.length) fail("INVALID_REQUEST");
      const offset = cursor?.offset ?? 0;
      const next = offset + limit;
      return {
        schemaVersion: 1, revision: catalog.revision, domainId, updatedAt: catalog.updatedAt,
        source: "workspace-hitl-policy-catalog",
        enforcement: "NOT_CONFIGURED",
        policies: catalog.policies.slice(offset, next).map(p => ({ ...p,
          agentScope: p.scope.kind === "domain" ? "all" : p.scope.projectId,
        })),
        cursor: next < catalog.policies.length ? Buffer.from(JSON.stringify({
          schemaVersion: 1, domainId, revision: catalog.revision, offset: next,
        })).toString("base64url") : null,
      };
    },

    async publishAgent(input) {
      const request = validateAgentPublicationInput(input);
      const domainId = activeDomain(
        request.identity,
        request.domainId,
      );
      const domain = await domainById(domainId);
      const expected = {
        domainId,
        projectId: request.projectId,
        agentId: request.agentId,
      };
      const project = validatePublicationProject(
        await readState(workspaceState, "getProject", {
          domainId,
          projectId: request.projectId,
        }),
        expected,
      );
      const agent = validatePublicationAgent(
        await readState(workspaceState, "getAgent", expected),
        expected,
      );
      if (
        request.identity.role === "builder"
        && (
          agent.ownerSubject !== request.identity.actor
          || (
            project.ownerSubject !== request.identity.actor
            && !project.memberSubjects.includes(request.identity.actor)
          )
        )
      ) {
        fail("NOT_FOUND");
      }

      const resource = agentPublicationResource(agent, project);
      const payloadFingerprint = fingerprint(resource);
      const stableReference = {
        actor: request.identity.actor,
        domainId,
        projectId: request.projectId,
        agentId: request.agentId,
        evidenceHash: agent.lastTestEvidenceHash,
      };
      const draftRequestId =
        `agent-draft-${fingerprint(stableReference).slice(0, 48)}`;
      const publicationRequestId =
        `agent-publish-${fingerprint(stableReference).slice(0, 46)}`;
      const approvalId =
        `publish-agent-${fingerprint({
          domainId,
          projectId: request.projectId,
          agentId: request.agentId,
        }).slice(0, 24)}`;

      const completedDraft = await completedMutation(workspaceState, {
        identity: request.identity,
        route: REGISTER_DRAFT_ROUTE,
        requestId: draftRequestId,
      });
      const completedRecordId = draftRecordIdFromCompletedMutation(
        completedDraft,
        {
          identity: request.identity,
          domainId,
          registryId: domain.registryId,
          requestId: draftRequestId,
          payloadFingerprint,
        },
      );
      let draft;
      if (completedRecordId === null) {
        draft = await operations.registerDraft({
          identity: request.identity,
          requestId: draftRequestId,
          resource,
        });
      } else {
        await authorize(
          authorizer,
          request.identity,
          "resource:draft-register",
          {
            id: resource.resourceId,
            domainId,
            lifecycleState: "ACTIVE",
          },
        );
        const authoritative = await getRecord(
          registryClient,
          domain.registryId,
          completedRecordId,
        );
        assertRecordDomain(authoritative, domain);
        assertRecordIdentity(authoritative, resource);
        if (
          !new Set([
            "DRAFT",
            "REJECTED",
            "PENDING_APPROVAL",
            "APPROVED",
          ]).has(authoritative.status)
        ) {
          fail("CONFLICT");
        }
        draft = draftResult(authoritative);
      }

      const currentApproval = validateApprovalRecord(
        await readState(workspaceState, "getApproval", {
          domainId,
          approvalId,
        }),
        {
          domainId,
          projectId: request.projectId,
          id: approvalId,
          kind: "RESOURCE_PUBLICATION",
          resourceType: "AGENT",
          resourceId: recordReference(
            draft.registryId,
            draft.recordId,
          ),
        },
        { mismatchCode: "CONFLICT" },
      );
      if (
        currentApproval !== null
        && currentApproval.status !== "PENDING"
      ) {
        const authoritative = await getRecord(
          registryClient,
          draft.registryId,
          draft.recordId,
        );
        assertRecordDomain(authoritative, domain);
        return {
          record: draftResult(authoritative),
          approval: currentApproval,
        };
      }

      const submitted = await operations.submitPublication({
        identity: {
          ...request.identity,
          activeDomain: domainId,
        },
        requestId: publicationRequestId,
        approvalId,
        registryId: draft.registryId,
        recordId: draft.recordId,
        projectId: request.projectId,
      });
      return {
        record: draftResult(submitted.record),
        approval: submitted.approval,
      };
    },

    async registerDraft(input) {
      if (
        !exactKeys(
          input,
          new Set(["identity", "requestId", "resource"]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const resource = validateDraftInput(input.resource);
      const domainId = activeDomain(identity, resource.domainId);
      const domain = await domainById(domainId);
      await authorize(authorizer, identity, "resource:draft-register", {
        id: resource.resourceId,
        domainId,
        lifecycleState: "ACTIVE",
      });

      const payloadFingerprint = fingerprint(resource);
      const completed = await completedMutation(workspaceState, {
        identity,
        route: REGISTER_DRAFT_ROUTE,
        requestId,
      });
      const completedRecordId = draftRecordIdFromCompletedMutation(
        completed,
        {
          identity,
          domainId,
          registryId: domain.registryId,
          requestId,
          payloadFingerprint,
        },
      );
      if (completedRecordId !== null) {
        const authoritative = await getRecord(
          registryClient,
          domain.registryId,
          completedRecordId,
        );
        assertRecordDomain(authoritative, domain);
        assertRecordIdentity(authoritative, resource);
        if (authoritative.status !== "DRAFT") fail("CONFLICT");
        return draftResult(authoritative);
      }

      await claimRegistryMutation(workspaceState, {
        actor: identity.actor,
        requesterSubject: identity.actor,
        effectiveRole: identity.role,
        domainId,
        projectId: null,
        route: REGISTER_DRAFT_ROUTE,
        requestId,
        payloadFingerprint,
        resourceKey:
          `registry-draft/${domain.registryId}/${resource.resourceId}`,
        operation: "CREATE",
      });
      const descriptor = descriptorFor(resource, identity.actor);
      const response = await registrySend(
        registryClient,
        new CreateRegistryRecordCommand({
          registryId: domain.registryId,
          name: registryName(domainId, resource.resourceId),
          displayName: resource.displayName,
          description: resource.description,
          recordType: descriptor.recordType,
          descriptors: descriptor.descriptors,
          recordVersion: governedRecordVersion(resource.version),
          clientToken: fingerprint({
            actor: identity.actor,
            route: REGISTER_DRAFT_ROUTE,
            requestId,
          }),
          tags,
        }),
      );
      const recordId = recordIdFromArn(response?.recordArn, domain.registryId);
      const authoritative = await pollRecord(
        registryClient,
        domain.registryId,
        recordId,
        new Set(["DRAFT"]),
        sleep,
      );
      assertRecordDomain(authoritative, domain);
      assertRecordIdentity(authoritative, resource);
      await appendDraftCompletion(workspaceState, {
        identity,
        domainId,
        registryId: domain.registryId,
        recordId,
        requestId,
        payloadFingerprint,
      });
      return draftResult(authoritative);
    },

    async listAgentEntitlements(input) {
      if (
        !isPlainObject(input)
        || !exactKeys(
          input,
          new Set([
            "identity",
            "limit",
            ...(Object.hasOwn(input, "cursor") ? ["cursor"] : []),
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const scope = entitlementListScope(identity);
      const limit = validateEntitlementListLimit(input.limit);
      const cursor = Object.hasOwn(input, "cursor")
        ? decodeEntitlementCursor(scope, input.cursor)
        : undefined;
      const page = await readState(
        workspaceState,
        "listAgentEntitlements",
        {
          ...(scope === "*" ? {} : { domainId: scope }),
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      if (
        !exactKeys(page, new Set(["items", "cursor"]))
        || !Array.isArray(page.items)
        || page.items.length > limit
        || (page.cursor !== null && !isPlainObject(page.cursor))
      ) {
        fail("WORKSPACE_UNAVAILABLE");
      }
      const items = page.items.map((value) => {
        if (!isPlainObject(value)) fail("WORKSPACE_UNAVAILABLE");
        const subjectType = Object.hasOwn(value, "subjectType")
          ? value.subjectType
          : "USER";
        let normalized;
        try {
          normalized = validateStoredTypedEntitlement(value, {
            subjectType,
            subject: value.subject,
            domainId: value.domainId,
            projectId: value.projectId,
            agentId: value.agentId,
          });
        } catch {
          fail("WORKSPACE_UNAVAILABLE");
        }
        if (
          normalized === null
          || (scope !== "*" && normalized.domainId !== scope)
        ) {
          fail("WORKSPACE_UNAVAILABLE");
        }
        return {
          subjectType: normalized.subjectType,
          subject: normalized.subject,
          domainId: normalized.domainId,
          projectId: normalized.projectId,
          agentId: normalized.agentId,
          status: normalized.status,
          grantedAt: normalized.grantedAt,
          expiresAt: normalized.expiresAt,
          revokedAt: normalized.revokedAt,
        };
      });
      let encodedCursor;
      try {
        encodedCursor = encodeEntitlementCursor(scope, page.cursor);
      } catch {
        fail("WORKSPACE_UNAVAILABLE");
      }
      return { items, cursor: encodedCursor };
    },

    // Read only. Never returns descriptors, endpoints, or credentials.
    async readPublicationContext(input) {
      if (!exactKeys(input, new Set(["identity", "registryId", "recordId"]))) fail("INVALID_REQUEST");
      const identity = validateIdentity(input.identity);
      const domainId = activeDomain(identity);
      if (!capabilitiesForRole(identity.role).includes("submitDomainResourcePublication")) fail("FORBIDDEN");
      const domain = await domainById(domainId);
      const registryId = validateRegistryId(input.registryId);
      const recordId = validateRecordId(input.recordId);
      if (registryId !== domain.registryId) fail("NOT_FOUND");
      const record = await getRecord(registryClient, registryId, recordId, { allowUnmanaged: true });
      if (record === null) return { governed: false, canSubmit: false, blocker: "GOVERNANCE_METADATA_REQUIRED" };
      assertRecordDomain(record, domain);
      const result = { governed: true, canSubmit: false, registryId, recordId,
        domainId, ownerSubject: record.metadata.ownerSubject,
        resourceType: record.metadata.resourceType, resourceId: record.metadata.resourceId,
        recordVersion: record.recordVersion, status: record.status,
        reviewerRole: domainId === "platform" ? "Platform administrator" : "Domain lead" };
      if (record.metadata.ownerSubject !== identity.actor) return { ...result, blocker: "OWNER_REQUIRED" };
      if (!["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(record.status)) return { ...result, blocker: "RESOURCE_NOT_SUBMITTABLE" };
      try {
        await authorize(authorizer, identity, "resource:publication-submit", {
          id: recordReference(registryId, recordId), domainId,
          ownerId: record.metadata.ownerSubject, assigneeIds: [],
          lifecycleState: record.status === "PENDING_APPROVAL" ? "DRAFT" : record.status,
        });
      } catch (error) {
        if (error instanceof GovernanceServiceError && error.statusCode === 403) return { ...result, blocker: "SUBMISSION_NOT_ALLOWED" };
        throw error;
      }
      return { ...result, canSubmit: true, blocker: null,
        approvalId: `publish-${fingerprint({ domainId, registryId, recordId, recordVersion: record.recordVersion }).slice(0, 40)}` };
    },

    async submitPublication(input) {
      const hasProjectId = Object.hasOwn(input, "projectId");
      const hasExpectedVersion = Object.hasOwn(input, "expectedRecordVersion");
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "approvalId",
            "registryId",
            "recordId",
            ...(hasProjectId ? ["projectId"] : []),
            ...(hasExpectedVersion ? ["expectedRecordVersion"] : []),
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const approvalId = validateSlug(input.approvalId);
      const registryId = validateRegistryId(input.registryId);
      const recordId = validateRecordId(input.recordId);
      const projectId = hasProjectId
        ? validateSlug(input.projectId)
        : null;
      const domainId = activeDomain(identity);
      const domain = await domainById(domainId);
      if (registryId !== domain.registryId) fail("NOT_FOUND");
      let authoritative = await getRecord(registryClient, registryId, recordId);
      assertRecordDomain(authoritative, domain);
      if (hasExpectedVersion && input.expectedRecordVersion !== authoritative.recordVersion) fail("CONFLICT");
      if (hasExpectedVersion) {
        // Existing-resource entry is owner-only and uses one canonical request
        // identity across tabs/retries; legacy registration clients are unchanged.
        if (authoritative.metadata.ownerSubject !== identity.actor) fail("FORBIDDEN");
        const expectedApprovalId = `publish-${fingerprint({ domainId, registryId, recordId, recordVersion: authoritative.recordVersion }).slice(0, 40)}`;
        if (approvalId !== expectedApprovalId || requestId !== `submit-${approvalId}`) fail("INVALID_REQUEST");
      }
      if (
        authoritative.metadata.ownerSubject !== identity.actor
        && identity.role === "builder"
      ) {
        fail("NOT_FOUND");
      }
      if (
        !new Set(["DRAFT", "REJECTED", "PENDING_APPROVAL"]).has(
          authoritative.status,
        )
      ) {
        fail("CONFLICT");
      }
      await authorize(authorizer, identity, "resource:publication-submit", {
        id: recordReference(registryId, recordId),
        domainId,
        ownerId: authoritative.metadata.ownerSubject,
        assigneeIds: [],
        lifecycleState: authoritative.status === "PENDING_APPROVAL"
          ? "DRAFT"
          : authoritative.status,
      });
      const route = SUBMIT_PUBLICATION_ROUTE;
      const payloadFingerprint = fingerprint({
        approvalId,
        registryId,
        recordId,
        ...(projectId === null ? {} : { projectId }),
      });
      const expected = {
        domainId,
        projectId,
        id: approvalId,
        kind: "RESOURCE_PUBLICATION",
        resourceType: authoritative.metadata.resourceType,
        resourceId: recordReference(registryId, recordId),
      };
      const completed = validateCompletedMutation(
        await completedMutation(workspaceState, {
          identity,
          route,
          requestId,
        }),
        {
          identity,
          requesterSubject: identity.actor,
          domainId,
          projectId,
          route,
          requestId,
          payloadFingerprint,
          entityType: "APPROVAL",
          resourceKey: `approval/${domainId}/${approvalId}`,
          operation: "CREATE",
          decision: "create",
          reason: PUBLICATION_REQUESTED_REASON,
        },
      );
      let current = validateApprovalRecord(
        await readState(workspaceState, "getApproval", {
          domainId,
          approvalId,
        }),
        expected,
      );
      if (
        current !== null
        && current.requesterSubject !== identity.actor
      ) {
        fail("CONFLICT");
      }
      if (completed !== null) {
        if (
          current === null
          || current.status !== "PENDING"
          || authoritative.status !== "PENDING_APPROVAL"
        ) {
          fail("CONFLICT");
        }
        return { record: authoritative, approval: current };
      }
      const claimed = await claimRegistryMutation(workspaceState, {
        actor: identity.actor,
        requesterSubject: identity.actor,
        effectiveRole: identity.role,
        domainId,
        projectId,
        route,
        requestId,
        payloadFingerprint,
        resourceKey: `approval/${domainId}/${approvalId}`,
        operation: "CREATE",
      });
      if (!claimed && authoritative.status !== "PENDING_APPROVAL") {
        fail("CONFLICT");
      }
      if (authoritative.status !== "PENDING_APPROVAL") {
        await registrySend(
          registryClient,
          new SubmitRegistryRecordForApprovalCommand({
            registryId,
            recordId,
          }),
        );
        authoritative = await pollRecord(
          registryClient,
          registryId,
          recordId,
          new Set(["PENDING_APPROVAL"]),
          sleep,
        );
      }
      if (current === null) {
        current = await putApproval(workspaceState, {
          identity,
          requestId,
          route,
          record: {
            ...expected,
            status: "PENDING",
            requesterSubject: identity.actor,
            approverSubject: null,
            reason: null,
            requestedAt: transaction(workspaceState).timestamp,
            decidedAt: null,
          },
          expectedStatus: null,
          decision: "create",
          reason: PUBLICATION_REQUESTED_REASON,
          payload: {
            approvalId,
            registryId,
            recordId,
            ...(projectId === null ? {} : { projectId }),
          },
        });
      }
      return { record: authoritative, approval: current };
    },

    async initiatePublication(input) {
      // Admin-initiate: a platform admin files the formal RESOURCE_PUBLICATION
      // request for a genuinely-pending resource in ANY domain, closing the
      // dead-end where an admin-discovered in-review resource had no actionable
      // path. All writes remain server-authorized and fail-closed.
      //
      // SELF-APPROVAL INVARIANT: the TRUE initiator/requester of the request is
      // the AUTHENTICATED admin who calls this operation (identity.actor), NOT
      // the resource owner and NOT any client-supplied field. It is persisted
      // as the approval's requesterSubject so the requester != approver guard
      // in decidePublication (and the state-layer approverSubject !=
      // requesterSubject check) blocks the same admin from later deciding it.
      // The resource OWNER is captured as a SEPARATE field (ownerSubject) so a
      // read-back shows who owns the resource vs. who initiated the request.
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "registryId",
            "recordId",
            "reason",
            ...(Object.hasOwn(input, "expectedRecordVersion") ? ["expectedRecordVersion"] : []),
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const registryId = validateRegistryId(input.registryId);
      const recordId = validateRecordId(input.recordId);
      const reason = validateReason(input.reason);
      // Strictly platform-admin. Domain leads/builders use the owner submit path.
      if (identity.role !== "admin") fail("FORBIDDEN");
      if (
        !capabilitiesForRole(identity.role)
          .includes("initiateDomainResourcePublication")
      ) {
        fail("FORBIDDEN");
      }
      // Resolve the owning domain from the registry id itself: an admin is not
      // scoped into the owner's domain, so activeDomain() (which pins admins to
      // 'platform') cannot be used here.
      const domain = await domainForRegistry(registryId);
      const domainId = domain.id;
      let authoritative = await getRecord(registryClient, registryId, recordId);
      assertRecordDomain(authoritative, domain);
      if (Object.hasOwn(input, "expectedRecordVersion") && input.expectedRecordVersion !== authoritative.recordVersion) fail("CONFLICT");
      const ownerSubject = authoritative.metadata.ownerSubject;
      if (typeof ownerSubject !== "string" || !SUBJECT_PATTERN.test(ownerSubject)) {
        fail("CONFLICT");
      }
      // The TRUE initiator/requester is the authenticated admin. If the admin
      // is also the resource owner, initiating then deciding would still be a
      // self-approval AND the owner submit path already covers self-owned
      // resources, so reject fail-closed.
      const initiatorSubject = identity.actor;
      if (ownerSubject === initiatorSubject) fail("CONFLICT");
      if (
        !new Set(["DRAFT", "REJECTED", "PENDING_APPROVAL"]).has(
          authoritative.status,
        )
      ) {
        fail("CONFLICT");
      }
      await authorize(authorizer, identity, "resource:publication-initiate", {
        id: recordReference(registryId, recordId),
        domainId,
        ownerId: ownerSubject,
        assigneeIds: [],
        lifecycleState: authoritative.status,
      });
      const approvalId = `publish-${fingerprint({ domainId, registryId, recordId, recordVersion: authoritative.recordVersion }).slice(0, 40)}`;
      const route = INITIATE_PUBLICATION_ROUTE;
      // The claim fingerprint and the persisted approval payload MUST fingerprint
      // the same object so idempotent retries reconcile (putApproval derives the
      // mutation fingerprint from this exact payload).
      const payload = {
        approvalId,
        registryId,
        recordId,
        initiatedBySubject: initiatorSubject,
        ownerSubject,
        initiationReason: reason,
      };
      const payloadFingerprint = fingerprint(payload);
      const expected = {
        domainId,
        projectId: null,
        id: approvalId,
        kind: "RESOURCE_PUBLICATION",
        resourceType: authoritative.metadata.resourceType,
        resourceId: recordReference(registryId, recordId),
      };
      // Idempotency + fail-closed reconciliation mirror submitPublication. The
      // request identity persisted as requesterSubject is the authenticated
      // INITIATOR (the admin), NOT the owner; this is what the requester !=
      // approver self-approval guard compares against, so the initiating admin
      // cannot also decide. The owner is retained separately in the mutation
      // payload (ownerSubject) and on the authoritative registry record.
      const completed = validateCompletedMutation(
        await completedMutation(workspaceState, {
          identity,
          route,
          requestId,
        }),
        {
          identity,
          requesterSubject: initiatorSubject,
          domainId,
          projectId: null,
          route,
          requestId,
          payloadFingerprint,
          entityType: "APPROVAL",
          resourceKey: `approval/${domainId}/${approvalId}`,
          operation: "CREATE",
          decision: "create",
          reason: PUBLICATION_INITIATED_REASON,
        },
      );
      let current = validateApprovalRecord(
        await readState(workspaceState, "getApproval", {
          domainId,
          approvalId,
        }),
        expected,
      );
      if (
        current !== null
        && (current.requesterSubject !== initiatorSubject
          || current.ownerSubject !== ownerSubject
          || current.recordVersion !== authoritative.recordVersion
          || current.initiationReason !== reason)
      ) {
        fail("CONFLICT");
      }
      if (completed !== null) {
        // Idempotent replay: the approval mutation already persisted. Require
        // the approval to exist and be PENDING, then ensure the registry status
        // is flipped (a prior attempt may have died between persisting the
        // approval and flipping the record). Do NOT hard-CONFLICT on an un-
        // flipped record here — finish the flip so nothing is stranded.
        if (current === null || current.status !== "PENDING") {
          fail("CONFLICT");
        }
        authoritative = await ensureRecordPendingApproval(
          registryClient,
          registryId,
          recordId,
          authoritative,
          sleep,
        );
        return { record: authoritative, approval: current };
      }
      await claimRegistryMutation(workspaceState, {
        actor: identity.actor,
        requesterSubject: initiatorSubject,
        effectiveRole: identity.role,
        domainId,
        projectId: null,
        route,
        requestId,
        payloadFingerprint,
        resourceKey: `approval/${domainId}/${approvalId}`,
        operation: "CREATE",
      });
      // An identical durable claim may be retried after a failed approval
      // write. claimRegistryMutation already rejects a different fingerprint.
      // RECOVERABLE ORDERING: persist the approval FIRST, then flip
      // the registry record to PENDING_APPROVAL. Previously the record was
      // flipped before the approval write, so a failed putApproval stranded the
      // record in PENDING_APPROVAL with no actionable approval. Creating the
      // approval first means a failed persist leaves the record status
      // untouched; a failed flip after persist is reconciled by the idempotent
      // retry branch above, which finishes the flip.
      if (current === null) {
        current = await putApproval(workspaceState, {
          identity,
          requestId,
          route,
          record: {
            ...expected,
            ownerSubject,
            recordVersion: authoritative.recordVersion,
            initiationReason: reason,
            status: "PENDING",
            requesterSubject: initiatorSubject,
            approverSubject: null,
            reason: null,
            requestedAt: transaction(workspaceState).timestamp,
            decidedAt: null,
          },
          expectedStatus: null,
          decision: "create",
          reason: PUBLICATION_INITIATED_REASON,
          payload,
        });
      }
      authoritative = await ensureRecordPendingApproval(
        registryClient,
        registryId,
        recordId,
        authoritative,
        sleep,
      );
      return { record: authoritative, approval: current };
    },

    async decidePublication(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "approvalId",
            "decision",
            "reason",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const approvalId = validateSlug(input.approvalId);
      const decision = validateDecision(input.decision);
      const reason = validateReason(input.reason);
      let domainId = activeDomain(identity, identity.role === "admin" && identity.activeDomain === null ? "platform" : undefined);
      if (!new Set(["admin", "lead"]).has(identity.role)) {
        fail("FORBIDDEN");
      }
      let domain = await domainById(domainId);
      // Shared-registry publications persist under APPROVAL#shared, which no
      // role is ever scoped into. Only an admin may look there, and only when
      // the platform partition has no record with this id; every subsequent
      // record/domain assertion still runs against the shared registry — this
      // widens lookup, not authorization.
      let stored = await readState(workspaceState, "getApproval", {
        domainId,
        approvalId,
      });
      if (
        identity.role === "admin"
        && sharedDomain !== null
        && domainId === "platform"
        && (stored === null || (isPlainObject(stored) && stored.domainId === "shared"))
      ) {
        domainId = sharedDomain.id;
        domain = sharedDomain;
        stored = await readState(workspaceState, "getApproval", {
          domainId,
          approvalId,
        });
      }
      let approval = validateApprovalRecord(
        stored,
        {
          domainId,
          id: approvalId,
          kind: "RESOURCE_PUBLICATION",
          resourceType: undefined,
          resourceId: undefined,
        },
      );
      if (approval === null) fail("NOT_FOUND");
      if (approval.kind !== "RESOURCE_PUBLICATION") fail("NOT_FOUND");
      if (approval.requesterSubject === identity.actor) {
        fail("REQUESTER_CANNOT_APPROVE");
      }
      const ref = splitRecordReference(approval.resourceId);
      if (ref.registryId !== domain.registryId) fail("NOT_FOUND");
      let authoritative = await getRecord(
        registryClient,
        ref.registryId,
        ref.recordId,
      );
      assertRecordDomain(authoritative, domain);
      assertRecordIdentity(authoritative, approval);
      if (Object.hasOwn(approval, "recordVersion") && (
        authoritative.recordVersion !== approval.recordVersion
        || authoritative.metadata.ownerSubject !== approval.ownerSubject
        || approval.id !== `publish-${fingerprint({ domainId, registryId: ref.registryId, recordId: ref.recordId, recordVersion: authoritative.recordVersion }).slice(0, 40)}`
      )) fail("CONFLICT");
      if (authoritative.metadata.ownerSubject === identity.actor) {
        fail("REQUESTER_CANNOT_APPROVE");
      }
      await authorize(
        authorizer,
        identity,
        "resource:publication-approve",
        {
          id: approval.resourceId,
          domainId,
          lifecycleState: authoritative.status,
        },
        approvalId,
      );
      const target = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      const route = DECIDE_PUBLICATION_ROUTE;
      const payloadFingerprint = fingerprint({
        approvalId,
        decision,
        reason,
      });
      const completed = validateCompletedMutation(
        await completedMutation(workspaceState, {
          identity,
          route,
          requestId,
        }),
        {
          identity,
          requesterSubject: approval.requesterSubject,
          domainId,
          projectId: approval.projectId,
          route,
          requestId,
          payloadFingerprint,
          entityType: "APPROVAL",
          resourceKey: `approval/${domainId}/${approvalId}`,
          operation: "UPDATE",
          decision: decision.toLowerCase(),
          reason,
        },
      );
      if (completed !== null) {
        if (
          approval.status !== target
          || approval.approverSubject !== identity.actor
          || approval.reason !== reason
          || authoritative.status !== target
        ) {
          fail("CONFLICT");
        }
        return { record: authoritative, approval };
      }
      if (approval.status !== "PENDING") fail("CONFLICT");
      await writeState(workspaceState, "reserveApprovalDecision", {
        domainId, approvalId, actor: identity.actor, requestId, fingerprint: payloadFingerprint,
      });
      const claim = {
        actor: identity.actor,
        requesterSubject: approval.requesterSubject,
        effectiveRole: identity.role,
        domainId,
        projectId: approval.projectId,
        route,
        requestId,
        payloadFingerprint,
        resourceKey: `approval/${domainId}/${approvalId}`,
        operation: "UPDATE",
      };
      let claimed;
      if (authoritative.status === target) {
        if (
          await existingMutationClaim(
            mutationClaimResolver,
            claim,
          ) === null
        ) {
          fail("CONFLICT");
        }
        claimed = false;
      } else {
        if (authoritative.status !== "PENDING_APPROVAL") fail("CONFLICT");
        claimed = await claimRegistryMutation(workspaceState, claim);
      }
      // The permanent approval reservation binds actor/request/fingerprint.
      // An identical claim can resume after a failed Registry write while the
      // exact target remains pending; other requests cannot take this slot.
      if (authoritative.status !== target) {
        await registrySend(
          registryClient,
          new UpdateRegistryRecordStatusCommand({
            registryId: ref.registryId,
            recordId: ref.recordId,
            status: target,
            statusReason: reason,
          }),
        );
        authoritative = await pollRecord(
          registryClient,
          ref.registryId,
          ref.recordId,
          new Set([target]),
          sleep,
        );
      }
      approval = await putApproval(workspaceState, {
        identity,
        requestId,
        route,
        record: {
          ...approval,
          status: target,
          approverSubject: identity.actor,
          reason,
          decidedAt: transaction(workspaceState).timestamp,
        },
        expectedStatus: "PENDING",
        decision: decision.toLowerCase(),
        reason,
        payload: {
          approvalId,
          decision,
          reason,
        },
      });
      return { record: authoritative, approval };
    },

    async discoverShared(input) {
      if (
        !exactKeys(input, new Set(["identity", "limit"]))
        || !Number.isSafeInteger(input.limit)
        || input.limit < 1
        || input.limit > MAX_DISCOVERY_ITEMS
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      await authorize(authorizer, identity, "shared-resource:discover", {
        id: "shared-catalog",
        lifecycleState: "APPROVED",
      });
      const targetDomain = identity.activeDomain;
      // Platform-team visibility decisions gate cross-domain discovery. The
      // legacy shared flag remains the fallback for records with no decision,
      // and for deployments that have not configured the visibility catalog.
      const visibilityEntries = new Map();
      if (visibilityCatalog !== null) {
        let document;
        try {
          document = await visibilityCatalog.read();
        } catch {
          fail("WORKSPACE_UNAVAILABLE");
        }
        for (const entry of document?.entries ?? []) {
          visibilityEntries.set(entry.resourceId, entry);
        }
      }
      const items = [];
      const recordIdentities = new Set();
      const versionIdentities = new Set();
      const resourceIdentities = new Set();
      let scannedRecords = 0;
      // The org catalog (virtual "shared" domain) is a discovery source like
      // any publisher domain: its records answer to the same visibility
      // decisions, and its publisher id ("shared") never matches a viewer, so
      // undecided records fall back to their legacy shared flag.
      const sourceDomains = [
        ...(sharedDomain === null ? [] : [sharedDomain]),
        ...(await activeDomains()),
      ];
      for (const sourceDomain of sourceDomains) {
        if (sourceDomain.id === targetDomain) continue;
        const seenTokens = new Set();
        let nextToken;
        for (
          let pageNumber = 0;
          pageNumber < MAX_DISCOVERY_PAGES_PER_DOMAIN;
          pageNumber += 1
        ) {
          const page = await registrySend(
            registryClient,
            new ListRegistryRecordsCommand({
              registryId: sourceDomain.registryId,
              maxResults: MAX_DISCOVERY_ITEMS,
              filters: [{
                name: "status",
                values: ["APPROVED"],
              }],
              ...(nextToken === undefined ? {} : { nextToken }),
            }),
          );
          if (
            !Array.isArray(page?.registryRecords)
            || page.registryRecords.length > MAX_DISCOVERY_ITEMS
          ) {
            fail("REGISTRY_UNAVAILABLE");
          }
          scannedRecords += page.registryRecords.length;
          if (scannedRecords > MAX_DISCOVERY_SCANNED_RECORDS) {
            fail("REGISTRY_UNAVAILABLE");
          }
          const continuation = registryNextToken(page);
          if (
            continuation !== undefined
            && seenTokens.has(continuation)
          ) {
            fail("REGISTRY_UNAVAILABLE");
          }
          if (continuation !== undefined) seenTokens.add(continuation);
          for (const summary of page.registryRecords) {
            if (
              summary?.status !== "APPROVED"
              || !RECORD_ID_PATTERN.test(summary.recordId)
            ) {
              continue;
            }
            const recordIdentity =
              `${sourceDomain.registryId}/${summary.recordId}`;
            if (recordIdentities.has(recordIdentity)) {
              fail("REGISTRY_UNAVAILABLE");
            }
            recordIdentities.add(recordIdentity);
            const detailed = await getRecord(
              registryClient,
              sourceDomain.registryId,
              summary.recordId,
              { allowUnmanaged: true },
            );
            if (detailed === null) continue;
            assertRecordDomain(detailed, sourceDomain);
            if (detailed.status !== "APPROVED") continue;
            const versionIdentity = [
              detailed.registryId,
              detailed.name,
              detailed.recordVersion,
            ].join("/");
            const resourceIdentity = [
              detailed.metadata.domainId,
              detailed.metadata.resourceType,
              detailed.metadata.resourceId,
            ].join("/");
            if (
              versionIdentities.has(versionIdentity)
              || resourceIdentities.has(resourceIdentity)
            ) {
              fail("REGISTRY_UNAVAILABLE");
            }
            versionIdentities.add(versionIdentity);
            resourceIdentities.add(resourceIdentity);
            const recordReference_ = recordReference(
              detailed.registryId,
              detailed.recordId,
            );
            // The platform team's visibility decision wins over the record's
            // own shared flag; the flag stays only as the legacy fallback for
            // records nobody has decided on yet.
            if (
              !domainMayDiscover({
                viewerDomainId: targetDomain,
                publisherDomainId: detailed.metadata.domainId,
                entry: visibilityEntries.get(recordReference_),
                legacyShared: detailed.metadata.shared === true,
              })
              || items.length >= input.limit
            ) {
              continue;
            }
            let granted = null;
            if (targetDomain !== null) {
              const current = await readState(
                workspaceState,
                "getResourceGrant",
                {
                  domainId: targetDomain,
                  resourceType: detailed.metadata.resourceType,
                  resourceId: recordReference(
                    detailed.registryId,
                    detailed.recordId,
                  ),
                },
              );
              granted = current?.status === "ACTIVE";
            }
            items.push({
              domainId: detailed.metadata.domainId,
              registryId: detailed.registryId,
              recordId: detailed.recordId,
              resourceType: detailed.metadata.resourceType,
              resourceId: detailed.metadata.resourceId,
              displayName: detailed.displayName,
              description: detailed.description,
              version: detailed.recordVersion,
              status: detailed.status,
              granted,
            });
          }
          if (continuation === undefined) break;
          if (pageNumber + 1 >= MAX_DISCOVERY_PAGES_PER_DOMAIN) {
            fail("REGISTRY_UNAVAILABLE");
          }
          nextToken = continuation;
        }
      }
      return {
        items: items.sort((left, right) =>
          left.displayName.localeCompare(right.displayName)),
      };
    },

    // The platform team's post-approval visibility decision: which domains may
    // discover an approved registry record. Platform-admin only, audited via
    // the mutation journal, optimistic-revision protected. This is the step
    // the deep-dive flow calls "admin confirms who can see the new record".
    async setCatalogVisibility(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "registryId",
            "recordId",
            "mode",
            "allowedDomainIds",
            "reason",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      if (visibilityCatalog === null) fail("NOT_FOUND");
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const registryId = validateRegistryId(input.registryId);
      const recordId = validateRecordId(input.recordId);
      const reason = validateReason(input.reason);
      if (identity.role !== "admin") fail("FORBIDDEN");
      if (
        !["open", "restricted"].includes(input.mode)
        || !Array.isArray(input.allowedDomainIds)
      ) {
        fail("INVALID_REQUEST");
      }
      // Restricted lists must name real active domains — a typo must not
      // silently grant nobody (or worse, a future domain) visibility.
      const domains = await activeDomains();
      const activeIds = new Set(domains.map((domain) => domain.id));
      for (const domainId of input.allowedDomainIds) {
        if (!activeIds.has(domainId)) fail("INVALID_REQUEST");
      }
      // The record must exist, be APPROVED, and live in a registry this
      // platform governs (domain registry or the shared registry).
      const domain = await domainForRegistry(registryId);
      const authoritative = await getRecord(
        registryClient,
        registryId,
        recordId,
      );
      assertRecordDomain(authoritative, domain);
      if (authoritative.status !== "APPROVED") fail("CONFLICT");
      await authorize(authorizer, identity, "resource:visibility-set", {
        id: recordReference(registryId, recordId),
        domainId: "platform",
        lifecycleState: "APPROVED",
      });
      const reference = recordReference(registryId, recordId);
      const clock = transaction(workspaceState);
      let current;
      try {
        current = await visibilityCatalog.read();
      } catch {
        fail("WORKSPACE_UNAVAILABLE");
      }
      const decidedEntry = {
        resourceId: reference,
        mode: input.mode,
        allowedDomainIds: input.mode === "open"
          ? []
          : [...input.allowedDomainIds],
        decidedBySubject: identity.actor,
        decidedAt: clock.timestamp,
      };
      const next = validateVisibilityCatalog({
        schemaVersion: 1,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: clock.timestamp,
        entries: [
          ...(current?.entries ?? []).filter(
            (entry) => entry.resourceId !== reference,
          ),
          decidedEntry,
        ],
      });
      try {
        await visibilityCatalog.write(next, current?.revision ?? null);
      } catch (error) {
        if (error?.name === "ConditionalCheckFailedException") {
          fail("CONFLICT");
        }
        fail("WORKSPACE_UNAVAILABLE");
      }
      // Audit the decision on the same trail every other governance action
      // uses; the visibility write above is idempotent per revision so a
      // failed audit retry cannot double-apply the decision.
      await appendVisibilityAudit(workspaceState, {
        identity,
        requestId,
        reference,
        mode: input.mode,
        reason,
      });
      return {
        ok: true,
        visibility: decidedEntry,
        revision: next.revision,
      };
    },

    // Read the full visibility document (platform admins: to manage it;
    // leads: to see which of their publications are visible where).
    async readCatalogVisibility(input) {
      if (!exactKeys(input, new Set(["identity"]))) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      if (!["admin", "lead"].includes(identity.role)) fail("FORBIDDEN");
      if (visibilityCatalog === null) {
        return { ok: true, revision: 0, entries: [] };
      }
      let document;
      try {
        document = await visibilityCatalog.read();
      } catch {
        fail("WORKSPACE_UNAVAILABLE");
      }
      return {
        ok: true,
        revision: document?.revision ?? 0,
        entries: document?.entries ?? [],
      };
    },

    async requestAccess(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "approvalId",
            "sourceDomainId",
            "registryId",
            "recordId",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const approvalId = validateSlug(input.approvalId);
      const sourceDomainId = input.sourceDomainId;
      if (!DOMAIN_PATTERN.test(sourceDomainId)) fail("INVALID_REQUEST");
      const registryId = validateRegistryId(input.registryId);
      const recordId = validateRecordId(input.recordId);
      const targetDomainId = activeDomain(identity);
      const reference = recordReference(registryId, recordId);
      const payload = {
        approvalId,
        sourceDomainId,
        registryId,
        recordId,
      };
      await authorize(authorizer, identity, "resource:access-request", {
        id: reference,
        domainId: targetDomainId,
        lifecycleState: "APPROVED",
      });
      let current = validateApprovalRecord(
        await readState(workspaceState, "getApproval", {
          domainId: targetDomainId,
          approvalId,
        }),
        {
          domainId: targetDomainId,
          projectId: null,
          id: approvalId,
          kind: "RESOURCE_ACCESS",
          resourceId: reference,
        },
        { mismatchCode: "CONFLICT" },
      );
      if (current !== null) {
        if (current.requesterSubject !== identity.actor) fail("CONFLICT");
        const completed = validateCompletedMutation(
          await completedMutation(workspaceState, {
            identity,
            route: REQUEST_ACCESS_ROUTE,
            requestId,
          }),
          {
            identity,
            requesterSubject: identity.actor,
            domainId: targetDomainId,
            route: REQUEST_ACCESS_ROUTE,
            requestId,
            payloadFingerprint: fingerprint(payload),
            entityType: "APPROVAL",
            resourceKey: `approval/${targetDomainId}/${approvalId}`,
            operation: "CREATE",
            decision: "create",
            reason: ACCESS_REQUESTED_REASON,
          },
        );
        if (completed === null) fail("CONFLICT");
      }
      const sourceDomain = await domainById(sourceDomainId);
      if (
        sourceDomain.id === targetDomainId
        || sourceDomain.registryId !== registryId
      ) {
        fail("NOT_FOUND");
      }
      const detailed = await getRecord(registryClient, registryId, recordId);
      assertRecordDomain(detailed, sourceDomain);
      if (
        detailed.status !== "APPROVED"
        || detailed.metadata.shared !== true
      ) {
        fail("NOT_FOUND");
      }
      const activeGrant = await readState(
        workspaceState,
        "getResourceGrant",
        {
          domainId: targetDomainId,
          resourceType: detailed.metadata.resourceType,
          resourceId: reference,
        },
      );
      if (activeGrant?.status === "ACTIVE") fail("CONFLICT");
      const expected = {
        domainId: targetDomainId,
        projectId: null,
        id: approvalId,
        kind: "RESOURCE_ACCESS",
        resourceType: detailed.metadata.resourceType,
        resourceId: reference,
      };
      current = validateApprovalRecord(
        current,
        expected,
        { mismatchCode: "CONFLICT" },
      );
      if (current !== null) return current;
      current = await putApproval(workspaceState, {
        identity,
        requestId,
        route: REQUEST_ACCESS_ROUTE,
        record: {
          ...expected,
          projectId: null,
          status: "PENDING",
          requesterSubject: identity.actor,
          approverSubject: null,
          reason: null,
          requestedAt: transaction(workspaceState).timestamp,
          decidedAt: null,
        },
        expectedStatus: null,
        decision: "create",
        reason: ACCESS_REQUESTED_REASON,
        payload,
      });
      return current;
    },

    async decideAccess(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "approvalId",
            "decision",
            "reason",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const approvalId = validateSlug(input.approvalId);
      const decision = validateDecision(input.decision);
      const reason = validateReason(input.reason);
      const domainId = activeDomain(identity);
      if (identity.role !== "lead") fail("FORBIDDEN");
      let approval = await readState(workspaceState, "getApproval", {
        domainId,
        approvalId,
      });
      if (approval === null) fail("NOT_FOUND");
      if (
        approval.kind !== "RESOURCE_ACCESS"
        || approval.domainId !== domainId
        || approval.id !== approvalId
      ) {
        fail("NOT_FOUND");
      }
      if (approval.requesterSubject === identity.actor) {
        fail("REQUESTER_CANNOT_APPROVE");
      }
      if (
        approval.projectId !== null
        && approval.resourceType !== "AGENT"
      ) {
        fail("CONFLICT");
      }
      if (
        approval.resourceType === "AGENT"
        && approval.projectId !== null
      ) {
        const agent = await readState(workspaceState, "getAgent", {
          domainId,
          projectId: approval.projectId,
          agentId: approval.resourceId,
        });
        if (
          !isPlainObject(agent)
          || agent.domainId !== domainId
          || agent.projectId !== approval.projectId
          || agent.id !== approval.resourceId
          || agent.status !== "PRODUCTION_DEPLOYED"
        ) {
          fail("CONFLICT");
        }
        const deploymentPage = await readState(
          workspaceState,
          "listDeployments",
          {
            domainId,
            projectId: approval.projectId,
            limit: 100,
          },
        );
        if (
          !isPlainObject(deploymentPage)
          || !Array.isArray(deploymentPage.items)
          || deploymentPage.cursor !== null
        ) {
          fail("WORKSPACE_UNAVAILABLE");
        }
        const activeDeployments = deploymentPage.items.filter(
          (deployment) =>
            isPlainObject(deployment)
            && deployment.domainId === domainId
            && deployment.projectId === approval.projectId
            && deployment.agentId === approval.resourceId
            && deployment.environment === "PRODUCTION"
            && deployment.status === "DEPLOYED"
            && deployment.runtimeStatus === "READY",
        );
        if (activeDeployments.length !== 1) fail("CONFLICT");
        await authorize(
          authorizer,
          identity,
          "agent:entitlement-decide",
          {
            id: approval.resourceId,
            domainId,
            lifecycleState: "PENDING_APPROVAL",
          },
          approvalId,
        );
        const targetStatus =
          decision === "APPROVE" ? "APPROVED" : "REJECTED";
        const approvalCompletion = validateCompletedMutation(
          await completedMutation(workspaceState, {
            identity,
            route: DECIDE_ACCESS_ROUTE,
            requestId: `${requestId}.approval`,
          }),
          {
            identity,
            requesterSubject: approval.requesterSubject,
            domainId,
            route: DECIDE_ACCESS_ROUTE,
            requestId: `${requestId}.approval`,
            payloadFingerprint: fingerprint(input),
            entityType: "APPROVAL",
            resourceKey: `approval/${domainId}/${approvalId}`,
            operation: "UPDATE",
            decision: decision.toLowerCase(),
            reason,
          },
        );
        if (approvalCompletion !== null) {
          if (
            approval.status !== targetStatus
            || approval.approverSubject !== identity.actor
            || approval.reason !== reason
          ) {
            fail("CONFLICT");
          }
          if (decision === "REJECT") {
            return { approval, entitlement: null };
          }
          const currentEntitlement = await readState(
            workspaceState,
            "getEntitlement",
            {
              subject: approval.requesterSubject,
              domainId,
              projectId: approval.projectId,
              agentId: approval.resourceId,
            },
          );
          const entitlementCompletion = validateCompletedMutation(
            await completedMutation(workspaceState, {
              identity,
              route: DECIDE_ACCESS_ROUTE,
              requestId: `${requestId}.entitlement`,
            }),
            {
              identity,
              requesterSubject: approval.requesterSubject,
              domainId,
              projectId: approval.projectId,
              route: DECIDE_ACCESS_ROUTE,
              requestId: `${requestId}.entitlement`,
              payloadFingerprint: fingerprint(input),
              entityType: "ENTITLEMENT",
              resourceKey:
                `entitlement/${approval.requesterSubject}/${domainId}/`
                + `${approval.projectId}/${approval.resourceId}`,
              operation: "CREATE",
              decision: "grant",
              reason,
            },
          );
          if (
            entitlementCompletion === null
            || currentEntitlement === null
            || currentEntitlement.status !== "ACTIVE"
          ) {
            fail("CONFLICT");
          }
          return { approval, entitlement: currentEntitlement };
        }
        if (approval.status !== "PENDING") fail("CONFLICT");
        if (decision === "REJECT") {
          approval = await putApproval(workspaceState, {
            identity,
            requestId: `${requestId}.approval`,
            route: DECIDE_ACCESS_ROUTE,
            record: {
              ...approval,
              status: targetStatus,
              approverSubject: identity.actor,
              reason,
              decidedAt: transaction(workspaceState).timestamp,
            },
            expectedStatus: "PENDING",
            decision: decision.toLowerCase(),
            reason,
            payload: input,
          });
          return { approval, entitlement: null };
        }
        const currentEntitlement = await readState(
          workspaceState,
          "getEntitlement",
          {
            subject: approval.requesterSubject,
            domainId,
            projectId: approval.projectId,
            agentId: approval.resourceId,
          },
        );
        if (currentEntitlement !== null) fail("CONFLICT");
        return putApprovedAccess(workspaceState, {
          identity,
          requestId,
          approval,
          reason,
          payload: input,
          entitlement: {
            subject: approval.requesterSubject,
            domainId,
            projectId: approval.projectId,
            agentId: approval.resourceId,
            status: "ACTIVE",
            grantedBySubject: identity.actor,
            revokedBySubject: null,
            revokedAt: null,
          },
        });
      }
      const ref = splitRecordReference(approval.resourceId);
      const sourceDomain = await domainForRegistry(ref.registryId);
      const detailed = await getRecord(
        registryClient,
        ref.registryId,
        ref.recordId,
      );
      assertRecordDomain(detailed, sourceDomain);
      assertRecordIdentity(detailed, approval);
      if (
        detailed.status !== "APPROVED"
        || detailed.metadata.shared !== true
      ) {
        fail("CONFLICT");
      }
      await authorize(
        authorizer,
        identity,
        "resource:access-decide",
        {
          id: approval.resourceId,
          domainId,
          lifecycleState: "PENDING_APPROVAL",
        },
        approvalId,
      );
      const targetStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";
      const approvalCompletion = validateCompletedMutation(
        await completedMutation(workspaceState, {
          identity,
          route: DECIDE_ACCESS_ROUTE,
          requestId: `${requestId}.approval`,
        }),
        {
          identity,
          requesterSubject: approval.requesterSubject,
          domainId,
          route: DECIDE_ACCESS_ROUTE,
          requestId: `${requestId}.approval`,
          payloadFingerprint: fingerprint(input),
          entityType: "APPROVAL",
          resourceKey: `approval/${domainId}/${approvalId}`,
          operation: "UPDATE",
          decision: decision.toLowerCase(),
          reason,
        },
      );
      if (approvalCompletion !== null) {
        if (
          approval.status !== targetStatus
          || approval.approverSubject !== identity.actor
          || approval.reason !== reason
        ) {
          fail("CONFLICT");
        }
        if (decision === "REJECT") return { approval, grant: null };
        const currentGrant = await readState(
          workspaceState,
          "getResourceGrant",
          {
            domainId,
            resourceType: approval.resourceType,
            resourceId: approval.resourceId,
          },
        );
        const grantCompletion = validateCompletedMutation(
          await completedMutation(workspaceState, {
            identity,
            route: DECIDE_ACCESS_ROUTE,
            requestId: `${requestId}.grant`,
          }),
          {
            identity,
            requesterSubject: identity.actor,
            domainId,
            route: DECIDE_ACCESS_ROUTE,
            requestId: `${requestId}.grant`,
            payloadFingerprint: fingerprint(input),
            entityType: "RESOURCE_GRANT",
            resourceKey:
              `grant/${domainId}/${approval.resourceType}/`
              + approval.resourceId,
            operation: "CREATE",
            decision: "grant",
            reason,
          },
        );
        if (
          grantCompletion === null
          || currentGrant === null
          || currentGrant.status !== "ACTIVE"
        ) {
          fail("CONFLICT");
        }
        return { approval, grant: currentGrant };
      }
      if (approval.status !== "PENDING") fail("CONFLICT");
      if (decision === "REJECT") {
        approval = await putApproval(workspaceState, {
          identity,
          requestId: `${requestId}.approval`,
          route: DECIDE_ACCESS_ROUTE,
          record: {
            ...approval,
            status: targetStatus,
            approverSubject: identity.actor,
            reason,
            decidedAt: transaction(workspaceState).timestamp,
          },
          expectedStatus: "PENDING",
          decision: decision.toLowerCase(),
          reason,
          payload: input,
        });
        return { approval, grant: null };
      }
      const currentGrant = await readState(
        workspaceState,
        "getResourceGrant",
        {
          domainId,
          resourceType: approval.resourceType,
          resourceId: approval.resourceId,
        },
      );
      if (currentGrant !== null) fail("CONFLICT");
      return putApprovedAccess(workspaceState, {
        identity,
        requestId,
        approval,
        reason,
        payload: input,
        grant: {
          domainId,
          resourceType: approval.resourceType,
          resourceId: approval.resourceId,
          status: "ACTIVE",
          grantedBySubject: identity.actor,
          revokedBySubject: null,
          revokedAt: null,
        },
      });
    },

    async revokeAccess(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "resourceType",
            "resourceId",
            "reason",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const resourceType = validateResourceType(input.resourceType);
      const resourceId = validateResourceId(input.resourceId);
      const reason = validateReason(input.reason);
      const domainId = activeDomain(identity);
      if (identity.role !== "lead") fail("FORBIDDEN");
      const current = await readState(
        workspaceState,
        "getResourceGrant",
        { domainId, resourceType, resourceId },
      );
      if (current === null) fail("NOT_FOUND");
      if (
        current.domainId !== domainId
        || current.resourceType !== resourceType
        || current.resourceId !== resourceId
        || current.status !== "ACTIVE"
      ) {
        fail("CONFLICT");
      }
      await authorize(authorizer, identity, "resource:access-revoke", {
        id: resourceId,
        domainId,
        lifecycleState: "ACTIVE",
      });
      return putGrant(workspaceState, {
        identity,
        requestId,
        route: "POST /api/governance/access-revocations",
        record: {
          ...current,
          status: "REVOKED",
          revokedBySubject: identity.actor,
          revokedAt: transaction(workspaceState).timestamp,
        },
        expectedStatus: "ACTIVE",
        decision: "revoke",
        reason,
        payload: input,
      });
    },

    async grantAgentEntitlement(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "domainId",
            "projectId",
            "agentId",
            "subjectType",
            "subject",
            "expiresAt",
            "reason",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      if (!new Set(["admin", "lead"]).has(identity.role)) fail("FORBIDDEN");
      const requestId = validateRequestId(input.requestId);
      const domainId = entitlementDomain(identity, input.domainId);
      const projectId = validateSlug(input.projectId);
      const agentId = validateSlug(input.agentId);
      const { subjectType, subject } = validateEntitlementSubject(
        input.subjectType,
        input.subject,
      );
      const expiresAt = validateNullableTimestamp(input.expiresAt);
      const reason = validateReason(input.reason);
      await domainById(domainId);
      const authorizationEvidenceId = await authorize(
        authorizer,
        identity,
        "agent:entitlement-grant",
        {
          id: `${projectId}/${agentId}`,
          domainId,
          projectId,
          lifecycleState: "PRODUCTION_DEPLOYED",
        },
      );
      const payload = {
        domainId,
        projectId,
        agentId,
        subjectType,
        subject,
        expiresAt,
        reason,
      };
      const resourceKey =
        `entitlement/${subjectType}/${subject}/${domainId}/`
        + `${projectId}/${agentId}`;
      const completed = await completedMutation(workspaceState, {
        identity,
        route: GRANT_ENTITLEMENT_ROUTE,
        requestId,
      });
      const completion = validateCompletedMutation(
        completed,
        {
          identity,
          requesterSubject: identity.actor,
          domainId,
          projectId,
          route: GRANT_ENTITLEMENT_ROUTE,
          requestId,
          payloadFingerprint: fingerprint(payload),
          entityType: "ENTITLEMENT",
          resourceKey,
          operation: completed?.result?.operation === "UPDATE"
            ? "UPDATE"
            : "CREATE",
          decision: "grant",
          reason,
        },
      );
      const current = validateStoredTypedEntitlement(
        await readState(workspaceState, "getEntitlement", {
          subjectType,
          subject,
          domainId,
          projectId,
          agentId,
        }),
        { subjectType, subject, domainId, projectId, agentId },
      );
      if (completion !== null) {
        if (
          current === null
          || current.status !== "ACTIVE"
          || current.grantedBySubject !== identity.actor
          || current.grantedAt !== completion.timestamp
          || current.expiresAt !== expiresAt
        ) {
          fail("CONFLICT");
        }
        return current;
      }
      const clock = transaction(workspaceState);
      if (
        expiresAt !== null
        && Date.parse(expiresAt) <= Date.parse(clock.timestamp)
      ) {
        fail("INVALID_REQUEST");
      }
      let expectedStatus = null;
      if (current !== null) {
        if (
          current.status === "ACTIVE"
          && (
            current.expiresAt === null
            || Date.parse(current.expiresAt) > Date.parse(clock.timestamp)
          )
        ) {
          fail("CONFLICT");
        }
        expectedStatus = current.status;
      }
      await productionAgent(domainId, projectId, agentId);
      return putEntitlement(workspaceState, {
        identity,
        requestId,
        route: GRANT_ENTITLEMENT_ROUTE,
        record: {
          subjectType,
          subject,
          domainId,
          projectId,
          agentId,
          status: "ACTIVE",
          expiresAt,
          grantedBySubject: identity.actor,
          grantedAt: clock.timestamp,
          revokedBySubject: null,
          revokedAt: null,
        },
        expectedStatus,
        expectedRecord: current ?? undefined,
        decision: "grant",
        reason,
        payload,
        clock,
        authorizationEvidenceId,
      });
    },

    async revokeAgentEntitlement(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "domainId",
            "projectId",
            "agentId",
            "subjectType",
            "subject",
            "reason",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      if (!new Set(["admin", "lead"]).has(identity.role)) fail("FORBIDDEN");
      const requestId = validateRequestId(input.requestId);
      const domainId = entitlementDomain(identity, input.domainId);
      const projectId = validateSlug(input.projectId);
      const agentId = validateSlug(input.agentId);
      const { subjectType, subject } = validateEntitlementSubject(
        input.subjectType,
        input.subject,
      );
      const reason = validateReason(input.reason);
      await domainById(domainId);
      const authorizationEvidenceId = await authorize(
        authorizer,
        identity,
        "agent:entitlement-revoke",
        {
          id: `${projectId}/${agentId}`,
          domainId,
          projectId,
          lifecycleState: "ACTIVE",
        },
      );
      const payload = {
        domainId,
        projectId,
        agentId,
        subjectType,
        subject,
        reason,
      };
      const resourceKey =
        `entitlement/${subjectType}/${subject}/${domainId}/`
        + `${projectId}/${agentId}`;
      const completion = validateCompletedMutation(
        await completedMutation(workspaceState, {
          identity,
          route: REVOKE_ENTITLEMENT_ROUTE,
          requestId,
        }),
        {
          identity,
          requesterSubject: identity.actor,
          domainId,
          projectId,
          route: REVOKE_ENTITLEMENT_ROUTE,
          requestId,
          payloadFingerprint: fingerprint(payload),
          entityType: "ENTITLEMENT",
          resourceKey,
          operation: "UPDATE",
          decision: "revoke",
          reason,
        },
      );
      const current = validateStoredTypedEntitlement(
        await readState(workspaceState, "getEntitlement", {
          subjectType,
          subject,
          domainId,
          projectId,
          agentId,
        }),
        { subjectType, subject, domainId, projectId, agentId },
      );
      if (completion !== null) {
        if (
          current === null
          || current.status !== "REVOKED"
          || current.revokedBySubject !== identity.actor
          || current.revokedAt !== completion.timestamp
        ) {
          fail("CONFLICT");
        }
        return current;
      }
      if (current === null) fail("NOT_FOUND");
      if (current.status !== "ACTIVE") fail("CONFLICT");
      const clock = transaction(workspaceState);
      if (
        current.expiresAt !== null
        && Date.parse(current.expiresAt) <= Date.parse(clock.timestamp)
      ) {
        fail("CONFLICT");
      }
      return putEntitlement(workspaceState, {
        identity,
        requestId,
        route: REVOKE_ENTITLEMENT_ROUTE,
        record: {
          ...current,
          status: "REVOKED",
          revokedBySubject: identity.actor,
          revokedAt: clock.timestamp,
        },
        expectedStatus: "ACTIVE",
        decision: "revoke",
        reason,
        payload,
        clock,
        authorizationEvidenceId,
      });
    },
  };
  return Object.freeze(operations);
}
