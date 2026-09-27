import { createAlertCatalogReader, validateAlertCatalog, buildAlertCatalogItem } from './alert-policies.mjs';
import { createHitlCatalogReader, validateHitlCatalog, buildHitlCatalogItem } from "./hitl-policies.mjs";
import { createHash } from "node:crypto";
import { validateProjectResourcePolicy } from "../../../../console/public/project-resource-policy.mjs";
import { readResourcePolicy } from "../domain-bootstrap/resource-policy.mjs";
import { isDeepStrictEqual } from "node:util";
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  validateGuardrailChain,
} from "../../../../console/public/guardrail-chain.mjs";

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const COGNITO_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ROUTE_PATTERN =
  /^(?:GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9._~!$&'()*+,;=:@%/{}-]{1,255}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;
const DECISION_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]{0,12}:.{1,1024}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_PAGE_SIZE = 100;
const PROJECT_MEMBER_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/;
const RESERVED_DOMAIN_IDS = new Set([
  "admin",
  "platform_admin",
  "lead",
  "domain_lead",
  "builder",
  "domain_builder",
  "user",
  "end_user",
  "demo_operator",
]);
const BUILD_CONFIG_KEYS = new Set([
  "instructions",
  "modelParameters",
  "buildOptions",
  "guardrailChain",
]);
const LEGACY_BUILD_CONFIG_KEYS = new Set([
  "instructions",
  "modelParameters",
  "buildOptions",
]);
const MODEL_PARAMETER_KEYS = new Set(["temperature", "maxTokens"]);
const BUILD_OPTION_KEYS = new Set([
  "framework",
  "deployTarget",
  "memory",
  "streaming",
  "identity",
  "guardrails",
]);
const MEMORY_OPTIONS = new Set([
  "none",
  "shortTerm",
  "longAndShortTerm",
]);

const PROJECT_KEYS = new Set([
  "domainId",
  "id",
  "name",
  "description",
  "ownerSubject",
  "memberSubjects",
  "status",
  "createdBySubject",
  "createdAt",
]);
const AGENT_KEYS = new Set([
  "domainId",
  "projectId",
  "id",
  "name",
  "description",
  "ownerSubject",
  "modelId",
  "toolIds",
  "mcpServerIds",
  "skillIds",
  "blueprintIds",
  "memoryIds",
  "knowledgeBaseIds",
  "buildConfig",
  "status",
  "createdBySubject",
  "createdAt",
  "updatedAt",
  "lastTestStatus",
  "lastTestedAt",
  "lastTestedBySubject",
  "lastTestModelId",
  "lastTestInputTokens",
  "lastTestOutputTokens",
  "lastTestRequestId",
  "lastTestEvidenceHash",
  "lastTestOutput",
]);
const DEPLOYMENT_KEYS = new Set([
  "domainId",
  "projectId",
  "id",
  "agentId",
  "environment",
  "status",
  "requesterSubject",
  "approverSubject",
  "decisionReason",
  "requestedAt",
  "decidedAt",
  "runtimeId",
  "runtimeArn",
  "runtimeStatus",
  "endpointName",
  "endpointArn",
  "runtimeVersion",
  "updatedAt",
]);
const APPROVAL_KEYS = new Set([
  "domainId",
  "id",
  "kind",
  "resourceType",
  "resourceId",
  "projectId",
  "status",
  "requesterSubject",
  "approverSubject",
  "reason",
  "requestedAt",
  "decidedAt",
]);
const PUBLICATION_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PUBLICATION_BINDING_KEYS = ["ownerSubject", "recordVersion", "initiationReason"];
const RESOURCE_GRANT_KEYS = new Set([
  "domainId",
  "resourceType",
  "resourceId",
  "status",
  "grantedBySubject",
  "grantedAt",
  "revokedBySubject",
  "revokedAt",
]);
const ENTITLEMENT_KEYS = new Set([
  "subject",
  "agentId",
  "domainId",
  "projectId",
  "status",
  "grantedBySubject",
  "grantedAt",
  "revokedBySubject",
  "revokedAt",
]);
const TYPED_ENTITLEMENT_KEYS = new Set([
  ...ENTITLEMENT_KEYS,
  "subjectType",
  "expiresAt",
]);
const SESSION_KEYS = new Set([
  "actor",
  "id",
  "agentId",
  "domainId",
  "projectId",
  "status",
  "lastInvocationStatus",
  "createdAt",
  "updatedAt",
]);
const INCIDENT_KEYS = new Set([
  "domainId",
  "projectId",
  "id",
  "title",
  "description",
  "severity",
  "status",
  "ownerSubject",
  "reporterSubject",
  "acknowledgedBySubject",
  "acknowledgedAt",
  "resolvedBySubject",
  "resolvedAt",
  "reopenedBySubject",
  "reopenedAt",
  "lastActionReason",
  "createdAt",
  "updatedAt",
]);
const BREAK_GLASS_KEYS = new Set([
  "id",
  "domainId",
  "projectId",
  "resource",
  "action",
  "status",
  "requesterSubject",
  "reason",
  "requestedAt",
  "expiresAt",
  "approverSubject",
  "decisionReason",
  "decidedAt",
  "activatedBySubject",
  "activationReason",
  "activatedAt",
  "revokedBySubject",
  "revocationReason",
  "revokedAt",
]);
const AUDIT_KEYS = new Set([
  "resource",
  "timestamp",
  "requestId",
  "actor",
  "requesterSubject",
  "effectiveRole",
  "action",
  "decision",
  "reason",
  "domainId",
  "projectId",
]);
const AUDIT_WITH_AUTHORIZATION_EVIDENCE_KEYS = new Set([
  ...AUDIT_KEYS,
  "authorizationEvidenceId",
]);
const MUTATION_KEYS = new Set([
  "actor",
  "requesterSubject",
  "effectiveRole",
  "domainId",
  "projectId",
  "route",
  "requestId",
  "payloadFingerprint",
  "result",
  "decision",
  "reason",
  "timestamp",
  "createdAt",
]);
const MUTATION_WITH_AUTHORIZATION_EVIDENCE_KEYS = new Set([
  ...MUTATION_KEYS,
  "authorizationEvidenceId",
]);
const MUTATION_RESULT_KEYS = new Set([
  "entityType",
  "resourceKey",
  "operation",
  "status",
]);
const ACCESS_ADMIN_MUTATION_RESULT_KEYS = new Set([
  "username",
  "subject",
  "membershipStatus",
  "changed",
]);
const MUTATION_RESULT_WITH_ACCESS_ADMIN_KEYS = new Set([
  ...MUTATION_RESULT_KEYS,
  "accessAdmin",
]);
const MUTATION_CLAIM_KEYS = new Set([
  "actor",
  "requesterSubject",
  "effectiveRole",
  "domainId",
  "projectId",
  "route",
  "requestId",
  "payloadFingerprint",
  "resourceKey",
  "operation",
]);
const MUTATION_CLAIM_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...MUTATION_CLAIM_KEYS,
  "createdAt",
]);
const LEGACY_MUTATION_CLAIM_ITEM_KEYS = new Set([
  ...MUTATION_CLAIM_ITEM_KEYS,
  "expiresAt",
]);
const WRITE_KEYS = new Set(["record", "mutation", "expectedStatus"]);
const TRANSACTIONAL_WRITE_KEYS = new Set([
  "record",
  "mutation",
  "expectedStatus",
  "transaction",
]);
const ENTITLEMENT_RENEWAL_WRITE_KEYS = new Set([
  ...WRITE_KEYS,
  "expectedRecord",
]);
const TRANSACTIONAL_ENTITLEMENT_RENEWAL_WRITE_KEYS = new Set([
  ...TRANSACTIONAL_WRITE_KEYS,
  "expectedRecord",
]);
const NO_KEYS = new Set();
const ACCESS_DECISION_GRANT_KEYS = new Set([
  "approval",
  "grant",
  "transaction",
]);
const ACCESS_DECISION_ENTITLEMENT_KEYS = new Set([
  "approval",
  "entitlement",
  "transaction",
]);
const AUDIT_WRITE_KEYS = new Set(["record", "mutation"]);
const TRANSACTIONAL_AUDIT_WRITE_KEYS = new Set([
  ...AUDIT_WRITE_KEYS,
  "transaction",
]);
const ABORT_WRITE_KEYS = new Set(["mutation"]);
const TRANSACTIONAL_ABORT_WRITE_KEYS = new Set([
  "mutation",
  "transaction",
]);
const CURSOR_KEYS = new Set(["pk", "sk"]);
const PROJECT_MEMBER_CURSOR_KEYS = new Set([
  "v",
  "domainId",
  "projectId",
  "offset",
  "fingerprint",
]);
const PROJECT_MEMBER_GET_KEYS = new Set([
  "domainId",
  "projectId",
  "abortSignal",
]);
const PROJECT_MEMBER_REQUIRED_KEYS = new Set([
  "domainId",
  "projectId",
]);
const PROJECT_MEMBER_LIST_KEYS = new Set([
  "domainId",
  "projectId",
  "limit",
  "cursor",
  "abortSignal",
]);
const PROJECT_MEMBER_MUTATION_KEYS = new Set([
  "domainId",
  "projectId",
  "subject",
  "abortSignal",
]);

const PROJECT_STATUSES = new Set(["ACTIVE", "ARCHIVED"]);
const AGENT_STATUSES = new Set([
  "DRAFT",
  "READY_FOR_TEST",
  "TEST_FAILED",
  "TESTED",
  "SANDBOX_DEPLOYED",
  "PRODUCTION_PENDING",
  "PRODUCTION_APPROVED",
  "PRODUCTION_DEPLOYED",
  "REJECTED",
  "RETIRED",
]);
const DEPLOYMENT_STATUSES = new Set([
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "DEPLOYING",
  "DEPLOYED",
  "FAILED",
  "SUSPENDED",
  "CANCELLED",
  "RETIRED",
]);
const APPROVAL_STATUSES = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);
const GRANT_STATUSES = new Set(["ACTIVE", "REVOKED"]);
const ENTITLEMENT_STATUSES = new Set(["ACTIVE", "REVOKED"]);
const SESSION_STATUSES = new Set([
  "ACTIVE",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
const INCIDENT_STATUSES = new Set([
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
]);
const INCIDENT_SEVERITIES = new Set([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
]);
const BREAK_GLASS_STATUSES = new Set([
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "ACTIVE",
  "REVOKED",
]);
const INVOCATION_STATUSES = new Set(["SUCCEEDED", "FAILED"]);
const EFFECTIVE_ROLES = new Set(["admin", "lead", "builder", "user"]);
const DEPLOYMENT_ENVIRONMENTS = new Set(["SANDBOX", "PRODUCTION"]);
const APPROVAL_KINDS = new Set([
  "PRODUCTION_DEPLOYMENT",
  "RESOURCE_PUBLICATION",
  "RESOURCE_ACCESS",
]);
const APPROVAL_RESOURCE_TYPES = {
  PRODUCTION_DEPLOYMENT: new Set(["DEPLOYMENT"]),
  RESOURCE_PUBLICATION: new Set([
    "AGENT",
    "TOOL",
    "MCP_SERVER",
    "SKILL",
    "BLUEPRINT",
    "MEMORY",
    "KNOWLEDGE_BASE",
  ]),
  RESOURCE_ACCESS: new Set([
    "AGENT",
    "MODEL",
    "TOOL",
    "MCP_SERVER",
    "SKILL",
    "BLUEPRINT",
    "MEMORY",
    "KNOWLEDGE_BASE",
  ]),
};
const RESOURCE_TYPES = new Set([
  "AGENT",
  "MODEL",
  "TOOL",
  "MCP_SERVER",
  "SKILL",
  "BLUEPRINT",
  "MEMORY",
  "KNOWLEDGE_BASE",
  "DEPLOYMENT",
]);
const ENTITLEMENT_SUBJECT_TYPES = new Set(["USER", "GROUP", "DOMAIN"]);

const PROJECT_TRANSITIONS = {
  ACTIVE: new Set(["ACTIVE", "ARCHIVED"]),
  ARCHIVED: new Set(),
};
const AGENT_TRANSITIONS = {
  DRAFT: new Set(["DRAFT", "READY_FOR_TEST", "RETIRED"]),
  READY_FOR_TEST: new Set([
    "READY_FOR_TEST",
    "DRAFT",
    "TEST_FAILED",
    "TESTED",
    "RETIRED",
  ]),
  TEST_FAILED: new Set([
    "DRAFT",
    "READY_FOR_TEST",
    "TEST_FAILED",
    "TESTED",
    "RETIRED",
  ]),
  TESTED: new Set([
    "DRAFT",
    "TESTED",
    "TEST_FAILED",
    "SANDBOX_DEPLOYED",
    "PRODUCTION_PENDING",
    "RETIRED",
  ]),
  SANDBOX_DEPLOYED: new Set(["PRODUCTION_PENDING", "RETIRED"]),
  PRODUCTION_PENDING: new Set([
    "PRODUCTION_APPROVED",
    "REJECTED",
    "RETIRED",
  ]),
  PRODUCTION_APPROVED: new Set([
    "PRODUCTION_DEPLOYED",
    "REJECTED",
    "RETIRED",
  ]),
  PRODUCTION_DEPLOYED: new Set(["RETIRED"]),
  REJECTED: new Set(["DRAFT", "PRODUCTION_PENDING", "RETIRED"]),
  RETIRED: new Set(),
};
const DEPLOYMENT_TRANSITIONS = {
  REQUESTED: new Set(["APPROVED", "REJECTED", "CANCELLED"]),
  APPROVED: new Set(["DEPLOYING", "CANCELLED"]),
  REJECTED: new Set(),
  DEPLOYING: new Set(["DEPLOYED", "FAILED", "CANCELLED"]),
  DEPLOYED: new Set(["SUSPENDED", "RETIRED"]),
  FAILED: new Set(["DEPLOYING", "CANCELLED"]),
  SUSPENDED: new Set(["DEPLOYED", "RETIRED"]),
  CANCELLED: new Set(),
  RETIRED: new Set(),
};
const APPROVAL_TRANSITIONS = {
  PENDING: new Set(["APPROVED", "REJECTED", "CANCELLED"]),
  APPROVED: new Set(),
  REJECTED: new Set(),
  CANCELLED: new Set(),
};
const GRANT_TRANSITIONS = {
  ACTIVE: new Set(["REVOKED"]),
  REVOKED: new Set(),
};
const ENTITLEMENT_TRANSITIONS = {
  ACTIVE: new Set(["ACTIVE", "REVOKED"]),
  REVOKED: new Set(["ACTIVE"]),
};
const SESSION_TRANSITIONS = {
  ACTIVE: new Set(["ACTIVE", "COMPLETED", "FAILED", "CANCELLED"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
};
const INCIDENT_TRANSITIONS = {
  OPEN: new Set(["ACKNOWLEDGED"]),
  ACKNOWLEDGED: new Set(["RESOLVED"]),
  RESOLVED: new Set(["OPEN"]),
};
const BREAK_GLASS_TRANSITIONS = {
  REQUESTED: new Set(["APPROVED", "REJECTED"]),
  APPROVED: new Set(["ACTIVE"]),
  REJECTED: new Set(),
  ACTIVE: new Set(["REVOKED"]),
  REVOKED: new Set(),
};

const PROJECT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...PROJECT_KEYS,
]);
const AGENT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...AGENT_KEYS,
]);
const LEGACY_AGENT_ITEM_KEYS = new Set(
  [...AGENT_ITEM_KEYS].filter((key) => key !== "buildConfig"),
);
const DEPLOYMENT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...DEPLOYMENT_KEYS,
]);
const APPROVAL_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...APPROVAL_KEYS,
]);
const RESOURCE_GRANT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...RESOURCE_GRANT_KEYS,
]);
const ENTITLEMENT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...ENTITLEMENT_KEYS,
]);
const TYPED_ENTITLEMENT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...TYPED_ENTITLEMENT_KEYS,
]);
const SESSION_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...SESSION_KEYS,
]);
const INCIDENT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...INCIDENT_KEYS,
]);
const BREAK_GLASS_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...BREAK_GLASS_KEYS,
]);
const AUDIT_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...AUDIT_KEYS,
]);
const AUDIT_WITH_AUTHORIZATION_EVIDENCE_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...AUDIT_WITH_AUTHORIZATION_EVIDENCE_KEYS,
]);
const MUTATION_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...MUTATION_KEYS,
]);
const MUTATION_WITH_AUTHORIZATION_EVIDENCE_ITEM_KEYS = new Set([
  "pk",
  "sk",
  "entityType",
  ...MUTATION_WITH_AUTHORIZATION_EVIDENCE_KEYS,
]);

export class WorkspaceStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WorkspaceStateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceStateError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function requireExactKeys(value, keys, code, message) {
  if (!hasExactKeys(value, keys)) fail(code, message);
}

function validatePattern(value, pattern, maxLength, code, message) {
  if (
    typeof value !== "string"
    || value.length > maxLength
    || !pattern.test(value)
  ) {
    fail(code, message);
  }
  return value;
}

function validateText(value, maxLength, code, message, { empty = false } = {}) {
  if (
    typeof value !== "string"
    || value.length > maxLength
    || (!empty && value.length === 0)
    || value.trim() !== value
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    fail(code, message);
  }
  return value;
}

function validateNullableText(value, maxLength, code, message) {
  if (value === null) return null;
  return validateText(value, maxLength, code, message);
}

function validateNullableInvocationOutput(value, maxLength, code, message) {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim().length === 0
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    fail(code, message);
  }
  return value;
}

function validateMultilineText(value, maxLength, code, message) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    fail(code, message);
  }
  return value;
}

function validateDomainId(value, code) {
  const domainId = validatePattern(
    value,
    DOMAIN_ID_PATTERN,
    64,
    code,
    "Domain scope is malformed.",
  );
  if (RESERVED_DOMAIN_IDS.has(domainId)) {
    fail(code, "Domain scope is malformed.");
  }
  return domainId;
}

function validateSlug(value, code, label) {
  return validatePattern(
    value,
    SLUG_PATTERN,
    64,
    code,
    `${label} is malformed.`,
  );
}

function validateSubject(value, code) {
  return validatePattern(
    value,
    SUBJECT_PATTERN,
    256,
    code,
    "Subject is malformed.",
  );
}

function validateEntitlementSubject(subjectType, value, code) {
  if (subjectType === "DOMAIN") return validateDomainId(value, code);
  if (subjectType === "GROUP") {
    return validatePattern(
      value,
      COGNITO_GROUP_PATTERN,
      128,
      code,
      "Entitlement group subject is malformed.",
    );
  }
  return validateSubject(value, code);
}

function entitlementPartitionKey(subjectType, subject) {
  return subjectType === "USER"
    ? `ENTITLEMENT#${subject}`
    : `ENTITLEMENT#${subjectType}#${subject}`;
}

function validateResourceId(value, code) {
  return validatePattern(
    value,
    RESOURCE_ID_PATTERN,
    256,
    code,
    "Resource ID is malformed.",
  );
}

function validateTimestamp(value, code, message = "Timestamp is malformed.") {
  if (typeof value !== "string" || value.length > 32) {
    fail(code, message);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(code, message);
  }
  return value;
}

function compareTimestamps(left, right, code, message) {
  if (Date.parse(left) > Date.parse(right)) fail(code, message);
}

function validateNullableTimestamp(value, code) {
  return value === null ? null : validateTimestamp(value, code);
}

function validateEnum(value, allowed, code, message) {
  if (!allowed.has(value)) fail(code, message);
  return value;
}

function validateNullableArn(value, code) {
  if (value === null) return null;
  return validatePattern(
    value,
    ARN_PATTERN,
    2048,
    code,
    "Runtime ARN is malformed.",
  );
}

function validateMemberSubjects(value, code) {
  if (!Array.isArray(value) || value.length > 100) {
    fail(code, "Project member assignments are malformed.");
  }
  const members = value.map((subject) => validateSubject(subject, code));
  if (new Set(members).size !== members.length) {
    fail(code, "Project member assignments are malformed.");
  }
  return members;
}

function validateResourceIds(value, code, label) {
  if (!Array.isArray(value) || value.length > 20) {
    fail(code, `${label} are malformed.`);
  }
  const resources = value.map((resourceId) =>
    validateResourceId(resourceId, code));
  if (new Set(resources).size !== resources.length) {
    fail(code, `${label} are malformed.`);
  }
  return resources;
}

function validateNullableSubject(value, code) {
  return value === null ? null : validateSubject(value, code);
}

function validateNullableResourceId(value, code) {
  return value === null ? null : validateResourceId(value, code);
}

function validateNullablePattern(value, pattern, maxLength, code, message) {
  return value === null
    ? null
    : validatePattern(value, pattern, maxLength, code, message);
}

function validateNullableNonNegativeInteger(value, code, message) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(code, message);
  return value;
}

export function validateAgentBuildConfig(input) {
  const code = "INVALID_AGENT";
  if (
    !hasExactKeys(input, BUILD_CONFIG_KEYS)
    && !hasExactKeys(input, LEGACY_BUILD_CONFIG_KEYS)
  ) {
    fail(code, "Agent builder configuration is malformed.");
  }
  requireExactKeys(
    input.modelParameters,
    MODEL_PARAMETER_KEYS,
    code,
    "Agent builder configuration is malformed.",
  );
  requireExactKeys(
    input.buildOptions,
    BUILD_OPTION_KEYS,
    code,
    "Agent builder configuration is malformed.",
  );
  const { temperature, maxTokens } = input.modelParameters;
  const options = input.buildOptions;
  if (
    (
      temperature !== null
      && (
        !Number.isFinite(temperature)
        || temperature < 0
        || temperature > 1
      )
    )
    || (
      maxTokens !== null
      && (
        !Number.isSafeInteger(maxTokens)
        || maxTokens < 1
        || maxTokens > 4096
      )
    )
    || !MEMORY_OPTIONS.has(options.memory)
    || ["streaming", "identity", "guardrails"].some(
      (key) => typeof options[key] !== "boolean",
    )
  ) {
    fail(code, "Agent builder configuration is malformed.");
  }
  if (
    Object.hasOwn(input, "guardrailChain")
    && options.guardrails !== true
  ) {
    fail(code, "Agent builder configuration is malformed.");
  }
  const result = {
    instructions: validateMultilineText(
      input.instructions,
      16_384,
      code,
      "Agent builder configuration is malformed.",
    ),
    modelParameters: { temperature, maxTokens },
    buildOptions: {
      framework: validateText(
        options.framework,
        128,
        code,
        "Agent builder configuration is malformed.",
      ),
      deployTarget: validateText(
        options.deployTarget,
        128,
        code,
        "Agent builder configuration is malformed.",
      ),
      memory: options.memory,
      streaming: options.streaming,
      identity: options.identity,
      guardrails: options.guardrails,
    },
  };
  if (Object.hasOwn(input, "guardrailChain")) {
    try {
      result.guardrailChain = validateGuardrailChain(input.guardrailChain);
    } catch {
      fail(code, "Agent builder configuration is malformed.");
    }
  }
  return result;
}

function validateProject(input) {
  const code = "INVALID_PROJECT";
  requireExactKeys(input, new Set([...PROJECT_KEYS, ...(Object.hasOwn(input || {}, "resourcePolicy") ? ["resourcePolicy"] : [])]), code, "Project is malformed.");
  const project = {
    domainId: validateDomainId(input.domainId, code),
    id: validateSlug(input.id, code, "Project ID"),
    name: validateText(input.name, 128, code, "Project name is malformed."),
    description: validateText(
      input.description,
      4096,
      code,
      "Project description is malformed.",
      { empty: true },
    ),
    ownerSubject: validateSubject(input.ownerSubject, code),
    memberSubjects: validateMemberSubjects(input.memberSubjects, code),
    status: validateEnum(
      input.status,
      PROJECT_STATUSES,
      code,
      "Project status is malformed.",
    ),
    createdBySubject: validateSubject(input.createdBySubject, code),
    createdAt: validateTimestamp(input.createdAt, code),
  };
  if (Object.hasOwn(input, "resourcePolicy")) {
    try { project.resourcePolicy = validateProjectResourcePolicy(input.resourcePolicy); }
    catch { fail(code, "Project resource selection is malformed."); }
  }
  return project;
}

export function validateProjectRecord(input) {
  return validateProject(input);
}

function validateAgent(input) {
  const code = "INVALID_AGENT";
  requireExactKeys(input, AGENT_KEYS, code, "Agent is malformed.");
  const createdAt = validateTimestamp(input.createdAt, code);
  const updatedAt = validateTimestamp(input.updatedAt, code);
  compareTimestamps(
    createdAt,
    updatedAt,
    code,
    "Agent timestamps are malformed.",
  );
  const status = validateEnum(
    input.status,
    AGENT_STATUSES,
    code,
    "Agent status is malformed.",
  );
  const lastTestStatus = input.lastTestStatus === null
    ? null
    : validateEnum(
      input.lastTestStatus,
      INVOCATION_STATUSES,
      code,
      "Agent test status is malformed.",
    );
  const lastTestedAt = validateNullableTimestamp(
    input.lastTestedAt,
    code,
  );
  const lastTestedBySubject = validateNullableSubject(
    input.lastTestedBySubject,
    code,
  );
  const lastTestModelId = validateNullableResourceId(
    input.lastTestModelId,
    code,
  );
  const lastTestInputTokens = validateNullableNonNegativeInteger(
    input.lastTestInputTokens,
    code,
    "Agent test token usage is malformed.",
  );
  const lastTestOutputTokens = validateNullableNonNegativeInteger(
    input.lastTestOutputTokens,
    code,
    "Agent test token usage is malformed.",
  );
  const lastTestRequestId = validateNullablePattern(
    input.lastTestRequestId,
    REQUEST_ID_PATTERN,
    128,
    code,
    "Agent test request ID is malformed.",
  );
  const lastTestEvidenceHash = validateNullablePattern(
    input.lastTestEvidenceHash,
    FINGERPRINT_PATTERN,
    64,
    code,
    "Agent test evidence is malformed.",
  );
  const lastTestOutput = validateNullableInvocationOutput(
    input.lastTestOutput,
    65_536,
    code,
    "Agent test output is malformed.",
  );
  const coreEvidence = [
    lastTestStatus,
    lastTestedAt,
    lastTestedBySubject,
    lastTestModelId,
    lastTestInputTokens,
    lastTestOutputTokens,
    lastTestRequestId,
    lastTestEvidenceHash,
  ];
  const evidenceIsEmpty = coreEvidence.every((value) => value === null);
  const evidenceIsComplete = coreEvidence.every((value) => value !== null);
  const successfulTestStates = new Set([
    "TESTED",
    "SANDBOX_DEPLOYED",
    "PRODUCTION_PENDING",
    "PRODUCTION_APPROVED",
    "PRODUCTION_DEPLOYED",
    "REJECTED",
  ]);
  if (
    (!evidenceIsEmpty && !evidenceIsComplete)
    || (
      successfulTestStates.has(status)
      && (
        !evidenceIsComplete
        || lastTestStatus !== "SUCCEEDED"
        || lastTestOutput === null
      )
    )
    || (
      status === "TEST_FAILED"
      && (
        !evidenceIsComplete
        || lastTestStatus !== "FAILED"
        || lastTestOutput !== null
      )
    )
    || (
      !successfulTestStates.has(status)
      && status !== "TEST_FAILED"
      && (!evidenceIsEmpty || lastTestOutput !== null)
    )
  ) {
    fail(code, "Agent test evidence is malformed.");
  }
  if (
    lastTestedAt !== null
    && (
      Date.parse(lastTestedAt) < Date.parse(createdAt)
      || Date.parse(lastTestedAt) > Date.parse(updatedAt)
    )
  ) {
    fail(code, "Agent test evidence is malformed.");
  }
  return {
    domainId: validateDomainId(input.domainId, code),
    projectId: validateSlug(input.projectId, code, "Project ID"),
    id: validateSlug(input.id, code, "Agent ID"),
    name: validateText(input.name, 128, code, "Agent name is malformed."),
    description: validateText(
      input.description,
      4096,
      code,
      "Agent description is malformed.",
      { empty: true },
    ),
    ownerSubject: validateSubject(input.ownerSubject, code),
    modelId: validateResourceId(input.modelId, code),
    toolIds: validateResourceIds(input.toolIds, code, "Agent tools"),
    mcpServerIds: validateResourceIds(
      input.mcpServerIds,
      code,
      "Agent MCP servers",
    ),
    skillIds: validateResourceIds(input.skillIds, code, "Agent skills"),
    blueprintIds: validateResourceIds(
      input.blueprintIds,
      code,
      "Agent blueprints",
    ),
    memoryIds: validateResourceIds(
      input.memoryIds,
      code,
      "Agent memory resources",
    ),
    knowledgeBaseIds: validateResourceIds(
      input.knowledgeBaseIds,
      code,
      "Agent knowledge bases",
    ),
    buildConfig: input.buildConfig === null
      ? null
      : validateAgentBuildConfig(input.buildConfig),
    status,
    createdBySubject: validateSubject(input.createdBySubject, code),
    createdAt,
    updatedAt,
    lastTestStatus,
    lastTestedAt,
    lastTestedBySubject,
    lastTestModelId,
    lastTestInputTokens,
    lastTestOutputTokens,
    lastTestRequestId,
    lastTestEvidenceHash,
    lastTestOutput,
  };
}

export function validateAgentRecord(input) {
  return validateAgent(input);
}

function validateDeployment(input) {
  const code = "INVALID_DEPLOYMENT";
  requireExactKeys(
    input,
    DEPLOYMENT_KEYS,
    code,
    "Deployment is malformed.",
  );
  const environment = validateEnum(
    input.environment,
    DEPLOYMENT_ENVIRONMENTS,
    code,
    "Deployment environment is malformed.",
  );
  const status = validateEnum(
    input.status,
    DEPLOYMENT_STATUSES,
    code,
    "Deployment status is malformed.",
  );
  const requesterSubject = validateSubject(input.requesterSubject, code);
  const approverSubject = input.approverSubject === null
    ? null
    : validateSubject(input.approverSubject, code);
  const decisionReason = validateNullableText(
    input.decisionReason,
    1024,
    code,
    "Deployment decision reason is malformed.",
  );
  const requestedAt = validateTimestamp(input.requestedAt, code);
  const decidedAt = validateNullableTimestamp(input.decidedAt, code);
  const updatedAt = validateTimestamp(input.updatedAt, code);
  compareTimestamps(
    requestedAt,
    updatedAt,
    code,
    "Deployment timestamps are malformed.",
  );
  if (decidedAt !== null) {
    compareTimestamps(
      requestedAt,
      decidedAt,
      code,
      "Deployment timestamps are malformed.",
    );
    compareTimestamps(
      decidedAt,
      updatedAt,
      code,
      "Deployment timestamps are malformed.",
    );
  }
  if (environment === "SANDBOX") {
    if (
      !new Set([
        "DEPLOYING",
        "DEPLOYED",
        "FAILED",
        "SUSPENDED",
        "CANCELLED",
        "RETIRED",
      ]).has(status)
      || approverSubject !== null
      || decisionReason !== null
      || decidedAt !== null
    ) {
      fail(code, "Sandbox deployment state is malformed.");
    }
  } else if (status === "REQUESTED") {
    if (
      approverSubject !== null
      || decisionReason !== null
      || decidedAt !== null
    ) {
      fail(code, "Pending deployment state is malformed.");
    }
  } else if (status === "CANCELLED" && approverSubject === null) {
    if (decidedAt === null || decisionReason === null) {
      fail(code, "Cancelled deployment state is malformed.");
    }
  } else {
    if (
      approverSubject === null
      || decisionReason === null
      || decidedAt === null
    ) {
      fail(code, "Deployment decision state is malformed.");
    }
    if (approverSubject === requesterSubject) {
      fail(
        "REQUESTER_CANNOT_APPROVE",
        "Requester cannot approve this resource.",
      );
    }
  }
  const runtimeId = input.runtimeId === null
    ? null
    : validateResourceId(input.runtimeId, code);
  const runtimeArn = validateNullableArn(input.runtimeArn, code);
  const runtimeStatus = input.runtimeStatus === null
    ? null
    : validateEnum(
      input.runtimeStatus,
      new Set(["READY"]),
      code,
      "Runtime status is malformed.",
    );
  const endpointName = input.endpointName === null
    ? null
    : validatePattern(
      input.endpointName,
      /^[A-Za-z][A-Za-z0-9_]{0,47}$/,
      48,
      code,
      "Runtime endpoint name is malformed.",
    );
  const endpointArn = validateNullableArn(input.endpointArn, code);
  const runtimeVersion = input.runtimeVersion === null
    ? null
    : validatePattern(
      input.runtimeVersion,
      /^[1-9][0-9]{0,4}$/,
      5,
      code,
      "Runtime version is malformed.",
    );
  const runtimeIdentity = [
    runtimeId,
    runtimeArn,
    runtimeStatus,
    endpointName,
    endpointArn,
    runtimeVersion,
  ];
  const runtimeIdentityIsEmpty = runtimeIdentity.every(
    (value) => value === null,
  );
  const runtimeIdentityIsComplete = runtimeIdentity.every(
    (value) => value !== null,
  );
  if (
    (!runtimeIdentityIsEmpty && !runtimeIdentityIsComplete)
    || (
      new Set(["DEPLOYED", "SUSPENDED", "RETIRED"]).has(status)
      && !runtimeIdentityIsComplete
    )
    || (
      !new Set(["DEPLOYED", "SUSPENDED", "RETIRED"]).has(status)
      && !runtimeIdentityIsEmpty
    )
  ) {
    fail(code, "Deployed runtime identity is malformed.");
  }
  return {
    domainId: validateDomainId(input.domainId, code),
    projectId: validateSlug(input.projectId, code, "Project ID"),
    id: validateSlug(input.id, code, "Deployment ID"),
    agentId: validateSlug(input.agentId, code, "Agent ID"),
    environment,
    status,
    requesterSubject,
    approverSubject,
    decisionReason,
    requestedAt,
    decidedAt,
    runtimeId,
    runtimeArn,
    runtimeStatus,
    endpointName,
    endpointArn,
    runtimeVersion,
    updatedAt,
  };
}

function validateApproval(input) {
  const code = "INVALID_APPROVAL";
  const hasBinding = PUBLICATION_BINDING_KEYS.some(key => Object.hasOwn(input, key));
  requireExactKeys(input, hasBinding ? new Set([...APPROVAL_KEYS, ...PUBLICATION_BINDING_KEYS]) : APPROVAL_KEYS, code, "Approval is malformed.");
  let publicationBinding = {};
  if (hasBinding) {
    if (input.kind !== "RESOURCE_PUBLICATION"
      || typeof input.recordVersion !== "string"
      || !PUBLICATION_VERSION_PATTERN.test(input.recordVersion)
      || typeof input.initiationReason !== "string" || input.initiationReason.trim().length < 10
      || input.initiationReason.length > 2000) fail(code, "Publication binding is malformed.");
    publicationBinding = { ownerSubject: validateSubject(input.ownerSubject, code),
      recordVersion: input.recordVersion, initiationReason: input.initiationReason };
  }
  const status = validateEnum(
    input.status,
    APPROVAL_STATUSES,
    code,
    "Approval status is malformed.",
  );
  const requesterSubject = validateSubject(input.requesterSubject, code);
  const approverSubject = input.approverSubject === null
    ? null
    : validateSubject(input.approverSubject, code);
  const reason = validateNullableText(
    input.reason,
    1024,
    code,
    "Approval reason is malformed.",
  );
  const requestedAt = validateTimestamp(input.requestedAt, code);
  const decidedAt = validateNullableTimestamp(input.decidedAt, code);
  const kind = validateEnum(
    input.kind,
    APPROVAL_KINDS,
    code,
    "Approval kind is malformed.",
  );
  const resourceType = validateEnum(
    input.resourceType,
    RESOURCE_TYPES,
    code,
    "Approval resource type is malformed.",
  );
  const resourceId = validateResourceId(input.resourceId, code);
  const projectId = input.projectId === null
    ? null
    : validateSlug(input.projectId, code, "Project ID");
  if (
    !APPROVAL_RESOURCE_TYPES[kind].has(resourceType)
    || (
      kind === "PRODUCTION_DEPLOYMENT"
      && (
        projectId === null
        || !SLUG_PATTERN.test(resourceId)
      )
    )
  ) {
    fail(code, "Approval resource is incompatible with its kind.");
  }
  if (decidedAt !== null) {
    compareTimestamps(
      requestedAt,
      decidedAt,
      code,
      "Approval timestamps are malformed.",
    );
  }
  if (status === "PENDING") {
    if (approverSubject !== null || reason !== null || decidedAt !== null) {
      fail(code, "Pending approval state is malformed.");
    }
  } else if (status === "CANCELLED") {
    if (approverSubject !== null || reason === null || decidedAt === null) {
      fail(code, "Cancelled approval state is malformed.");
    }
  } else {
    if (approverSubject === null || reason === null || decidedAt === null) {
      fail(code, "Approval decision state is malformed.");
    }
    if (approverSubject === requesterSubject || approverSubject === publicationBinding.ownerSubject) {
      fail(
        "REQUESTER_CANNOT_APPROVE",
        "Requester cannot approve this resource.",
      );
    }
  }
  return {
    domainId: validateDomainId(input.domainId, code),
    id: validateSlug(input.id, code, "Approval ID"),
    kind,
    resourceType,
    resourceId,
    projectId,
    status,
    requesterSubject,
    approverSubject,
    reason,
    requestedAt,
    decidedAt,
    ...publicationBinding,
  };
}

function validateResourceGrant(input) {
  const code = "INVALID_RESOURCE_GRANT";
  requireExactKeys(
    input,
    RESOURCE_GRANT_KEYS,
    code,
    "Resource grant is malformed.",
  );
  const status = validateEnum(
    input.status,
    GRANT_STATUSES,
    code,
    "Resource grant status is malformed.",
  );
  const revokedBySubject = input.revokedBySubject === null
    ? null
    : validateSubject(input.revokedBySubject, code);
  const grantedAt = validateTimestamp(input.grantedAt, code);
  const revokedAt = validateNullableTimestamp(input.revokedAt, code);
  if (status === "ACTIVE") {
    if (revokedBySubject !== null || revokedAt !== null) {
      fail(code, "Active resource grant is malformed.");
    }
  } else if (revokedBySubject === null || revokedAt === null) {
    fail(code, "Revoked resource grant is malformed.");
  } else {
    compareTimestamps(
      grantedAt,
      revokedAt,
      code,
      "Resource grant timestamps are malformed.",
    );
  }
  return {
    domainId: validateDomainId(input.domainId, code),
    resourceType: validateEnum(
      input.resourceType,
      RESOURCE_TYPES,
      code,
      "Resource grant type is malformed.",
    ),
    resourceId: validateResourceId(input.resourceId, code),
    status,
    grantedBySubject: validateSubject(input.grantedBySubject, code),
    grantedAt,
    revokedBySubject,
    revokedAt,
  };
}

function validateEntitlement(input) {
  const code = "INVALID_ENTITLEMENT";
  const typed = hasExactKeys(input, TYPED_ENTITLEMENT_KEYS);
  if (!typed && !hasExactKeys(input, ENTITLEMENT_KEYS)) {
    fail(code, "Entitlement is malformed.");
  }
  const subjectType = typed
    ? validateEnum(
        input.subjectType,
        ENTITLEMENT_SUBJECT_TYPES,
        code,
        "Entitlement subject type is malformed.",
      )
    : "USER";
  const status = validateEnum(
    input.status,
    ENTITLEMENT_STATUSES,
    code,
    "Entitlement status is malformed.",
  );
  const revokedBySubject = input.revokedBySubject === null
    ? null
    : validateSubject(input.revokedBySubject, code);
  const grantedAt = validateTimestamp(input.grantedAt, code);
  const revokedAt = validateNullableTimestamp(input.revokedAt, code);
  const expiresAt = typed
    ? validateNullableTimestamp(input.expiresAt, code)
    : null;
  if (
    expiresAt !== null
    && Date.parse(expiresAt) <= Date.parse(grantedAt)
  ) {
    fail(code, "Entitlement expiry is malformed.");
  }
  if (status === "ACTIVE") {
    if (revokedBySubject !== null || revokedAt !== null) {
      fail(code, "Active entitlement is malformed.");
    }
  } else if (revokedBySubject === null || revokedAt === null) {
    fail(code, "Revoked entitlement is malformed.");
  } else {
    compareTimestamps(
      grantedAt,
      revokedAt,
      code,
      "Entitlement timestamps are malformed.",
    );
  }
  const record = {
    subject: validateEntitlementSubject(subjectType, input.subject, code),
    agentId: validateSlug(input.agentId, code, "Agent ID"),
    domainId: validateDomainId(input.domainId, code),
    projectId: validateSlug(input.projectId, code, "Project ID"),
    status,
    grantedBySubject: validateSubject(input.grantedBySubject, code),
    grantedAt,
    revokedBySubject,
    revokedAt,
  };
  return typed
    ? {
        ...record,
        subjectType,
        expiresAt,
      }
    : record;
}

function validateSession(input) {
  const code = "INVALID_SESSION";
  requireExactKeys(input, SESSION_KEYS, code, "Session is malformed.");
  const createdAt = validateTimestamp(input.createdAt, code);
  const updatedAt = validateTimestamp(input.updatedAt, code);
  compareTimestamps(
    createdAt,
    updatedAt,
    code,
    "Session timestamps are malformed.",
  );
  const lastInvocationStatus = input.lastInvocationStatus === null
    ? null
    : validateEnum(
        input.lastInvocationStatus,
        INVOCATION_STATUSES,
        code,
        "Invocation status is malformed.",
      );
  return {
    actor: validateSubject(input.actor, code),
    id: validateSlug(input.id, code, "Session ID"),
    agentId: validateSlug(input.agentId, code, "Agent ID"),
    domainId: validateDomainId(input.domainId, code),
    projectId: validateSlug(input.projectId, code, "Project ID"),
    status: validateEnum(
      input.status,
      SESSION_STATUSES,
      code,
      "Session status is malformed.",
    ),
    lastInvocationStatus,
    createdAt,
    updatedAt,
  };
}

function validateIncident(input) {
  const code = "INVALID_INCIDENT";
  requireExactKeys(input, INCIDENT_KEYS, code, "Incident is malformed.");
  const createdAt = validateTimestamp(input.createdAt, code);
  const updatedAt = validateTimestamp(input.updatedAt, code);
  compareTimestamps(
    createdAt,
    updatedAt,
    code,
    "Incident timestamps are malformed.",
  );
  const status = validateEnum(
    input.status,
    INCIDENT_STATUSES,
    code,
    "Incident status is malformed.",
  );
  const acknowledgedBySubject = validateNullableSubject(
    input.acknowledgedBySubject,
    code,
  );
  const acknowledgedAt = validateNullableTimestamp(
    input.acknowledgedAt,
    code,
  );
  const resolvedBySubject = validateNullableSubject(
    input.resolvedBySubject,
    code,
  );
  const resolvedAt = validateNullableTimestamp(input.resolvedAt, code);
  const reopenedBySubject = validateNullableSubject(
    input.reopenedBySubject,
    code,
  );
  const reopenedAt = validateNullableTimestamp(input.reopenedAt, code);
  const paired = (left, right) =>
    (left === null && right === null)
    || (left !== null && right !== null);
  if (
    !paired(acknowledgedBySubject, acknowledgedAt)
    || !paired(resolvedBySubject, resolvedAt)
    || !paired(reopenedBySubject, reopenedAt)
    || (
      status === "OPEN"
      && (
        acknowledgedBySubject !== null
        || resolvedBySubject !== null
      )
    )
    || (
      status === "ACKNOWLEDGED"
      && (
        acknowledgedBySubject === null
        || resolvedBySubject !== null
      )
    )
    || (
      status === "RESOLVED"
      && (
        acknowledgedBySubject === null
        || resolvedBySubject === null
      )
    )
  ) {
    fail(code, "Incident action evidence is malformed.");
  }
  for (const timestamp of [
    acknowledgedAt,
    resolvedAt,
    reopenedAt,
  ]) {
    if (
      timestamp !== null
      && (
        Date.parse(timestamp) < Date.parse(createdAt)
        || Date.parse(timestamp) > Date.parse(updatedAt)
      )
    ) {
      fail(code, "Incident timestamps are malformed.");
    }
  }
  if (
    acknowledgedAt !== null
    && resolvedAt !== null
    && Date.parse(acknowledgedAt) > Date.parse(resolvedAt)
  ) {
    fail(code, "Incident timestamps are malformed.");
  }
  return {
    domainId: validateDomainId(input.domainId, code),
    projectId: validateSlug(input.projectId, code, "Project ID"),
    id: validateSlug(input.id, code, "Incident ID"),
    title: validateText(
      input.title,
      160,
      code,
      "Incident title is malformed.",
    ),
    description: validateText(
      input.description,
      4096,
      code,
      "Incident description is malformed.",
    ),
    severity: validateEnum(
      input.severity,
      INCIDENT_SEVERITIES,
      code,
      "Incident severity is malformed.",
    ),
    status,
    ownerSubject: validateSubject(input.ownerSubject, code),
    reporterSubject: validateSubject(input.reporterSubject, code),
    acknowledgedBySubject,
    acknowledgedAt,
    resolvedBySubject,
    resolvedAt,
    reopenedBySubject,
    reopenedAt,
    lastActionReason: validateText(
      input.lastActionReason,
      1024,
      code,
      "Incident action reason is malformed.",
    ),
    createdAt,
    updatedAt,
  };
}

function validateBreakGlass(input) {
  const code = "INVALID_BREAK_GLASS";
  requireExactKeys(
    input,
    BREAK_GLASS_KEYS,
    code,
    "Break-glass grant is malformed.",
  );
  const status = validateEnum(
    input.status,
    BREAK_GLASS_STATUSES,
    code,
    "Break-glass status is malformed.",
  );
  const requestedAt = validateTimestamp(input.requestedAt, code);
  const expiresAt = validateTimestamp(input.expiresAt, code);
  const duration = Date.parse(expiresAt) - Date.parse(requestedAt);
  if (
    !Number.isSafeInteger(duration)
    || duration < 60_000
    || duration > 60 * 60 * 1000
  ) {
    fail(code, "Break-glass expiration is malformed.");
  }
  const approverSubject = validateNullableSubject(
    input.approverSubject,
    code,
  );
  const decisionReason = validateNullableText(
    input.decisionReason,
    1024,
    code,
    "Break-glass decision reason is malformed.",
  );
  const decidedAt = validateNullableTimestamp(input.decidedAt, code);
  const activatedBySubject = validateNullableSubject(
    input.activatedBySubject,
    code,
  );
  const activationReason = validateNullableText(
    input.activationReason,
    1024,
    code,
    "Break-glass activation reason is malformed.",
  );
  const activatedAt = validateNullableTimestamp(input.activatedAt, code);
  const revokedBySubject = validateNullableSubject(
    input.revokedBySubject,
    code,
  );
  const revocationReason = validateNullableText(
    input.revocationReason,
    1024,
    code,
    "Break-glass revocation reason is malformed.",
  );
  const revokedAt = validateNullableTimestamp(input.revokedAt, code);
  const requesterSubject = validateSubject(
    input.requesterSubject,
    code,
  );
  const decisionComplete = [
    approverSubject,
    decisionReason,
    decidedAt,
  ].every((value) => value !== null);
  const activationComplete = [
    activatedBySubject,
    activationReason,
    activatedAt,
  ].every((value) => value !== null);
  const revocationComplete = [
    revokedBySubject,
    revocationReason,
    revokedAt,
  ].every((value) => value !== null);
  const decisionEmpty = [
    approverSubject,
    decisionReason,
    decidedAt,
  ].every((value) => value === null);
  const activationEmpty = [
    activatedBySubject,
    activationReason,
    activatedAt,
  ].every((value) => value === null);
  const revocationEmpty = [
    revokedBySubject,
    revocationReason,
    revokedAt,
  ].every((value) => value === null);
  if (
    (!decisionEmpty && !decisionComplete)
    || (!activationEmpty && !activationComplete)
    || (!revocationEmpty && !revocationComplete)
    ||
    (
      status === "REQUESTED"
      && (!decisionEmpty || !activationEmpty || !revocationEmpty)
    )
    || (
      new Set(["APPROVED", "REJECTED"]).has(status)
      && (
        !decisionComplete
        || !activationEmpty
        || !revocationEmpty
      )
    )
    || (
      status === "ACTIVE"
      && (
        !decisionComplete
        || !activationComplete
        || !revocationEmpty
      )
    )
    || (
      status === "REVOKED"
      && (
        !decisionComplete
        || !activationComplete
        || !revocationComplete
      )
    )
  ) {
    fail(code, "Break-glass lifecycle evidence is malformed.");
  }
  if (
    approverSubject !== null
    && approverSubject === requesterSubject
  ) {
    fail(
      "REQUESTER_CANNOT_APPROVE",
      "Requester cannot approve this resource.",
    );
  }
  if (
    activatedBySubject !== null
    && activatedBySubject !== requesterSubject
  ) {
    fail(code, "Break-glass activation actor is malformed.");
  }
  const ordered = [decidedAt, activatedAt, revokedAt]
    .filter((value) => value !== null);
  let previous = Date.parse(requestedAt);
  for (const timestamp of ordered) {
    const current = Date.parse(timestamp);
    if (current < previous || current >= Date.parse(expiresAt)) {
      fail(code, "Break-glass timestamps are malformed.");
    }
    previous = current;
  }
  return {
    id: validateSlug(input.id, code, "Break-glass ID"),
    domainId: validateDomainId(input.domainId, code),
    projectId: input.projectId === null
      ? null
      : validateSlug(input.projectId, code, "Project ID"),
    resource: validateText(
      input.resource,
      512,
      code,
      "Break-glass resource is malformed.",
    ),
    action: validatePattern(
      input.action,
      ACTION_PATTERN,
      128,
      code,
      "Break-glass action is malformed.",
    ),
    status,
    requesterSubject,
    reason: validateText(
      input.reason,
      1024,
      code,
      "Break-glass reason is malformed.",
    ),
    requestedAt,
    expiresAt,
    approverSubject,
    decisionReason,
    decidedAt,
    activatedBySubject,
    activationReason,
    activatedAt,
    revokedBySubject,
    revocationReason,
    revokedAt,
  };
}

function validateAudit(input) {
  const code = "INVALID_AUDIT";
  const hasAuthorizationEvidence =
    isPlainObject(input)
    && Object.hasOwn(input, "authorizationEvidenceId");
  requireExactKeys(
    input,
    hasAuthorizationEvidence
      ? AUDIT_WITH_AUTHORIZATION_EVIDENCE_KEYS
      : AUDIT_KEYS,
    code,
    "Audit evidence is malformed.",
  );
  return {
    resource: validateText(
      input.resource,
      512,
      code,
      "Audit resource is malformed.",
    ),
    timestamp: validateTimestamp(input.timestamp, code),
    requestId: validatePattern(
      input.requestId,
      REQUEST_ID_PATTERN,
      128,
      code,
      "Audit request ID is malformed.",
    ),
    actor: validateSubject(input.actor, code),
    requesterSubject: validateSubject(input.requesterSubject, code),
    effectiveRole: validateEnum(
      input.effectiveRole,
      EFFECTIVE_ROLES,
      code,
      "Audit effective role is malformed.",
    ),
    action: validatePattern(
      input.action,
      ACTION_PATTERN,
      128,
      code,
      "Audit action is malformed.",
    ),
    decision: validatePattern(
      input.decision,
      DECISION_PATTERN,
      32,
      code,
      "Audit decision is malformed.",
    ),
    reason: validateText(
      input.reason,
      1024,
      code,
      "Audit reason is malformed.",
    ),
    domainId: validateDomainId(input.domainId, code),
    projectId: input.projectId === null
      ? null
      : validateSlug(input.projectId, code, "Project ID"),
    ...(hasAuthorizationEvidence
      ? {
          authorizationEvidenceId: validateSlug(
            input.authorizationEvidenceId,
            code,
            "Authorization evidence ID",
          ),
        }
      : {}),
  };
}

function clockSnapshot(now) {
  let value;
  try {
    value = now();
  } catch {
    fail("INVALID_CLOCK", "Clock is malformed.");
  }
  const timestamp = value instanceof Date ? value.toISOString() : value;
  validateTimestamp(timestamp, "INVALID_CLOCK", "Clock is malformed.");
  return {
    timestamp,
    epochSeconds: Math.floor(Date.parse(timestamp) / 1000),
  };
}

function validateAccessAdminMutationResult(input, code) {
  requireExactKeys(
    input,
    ACCESS_ADMIN_MUTATION_RESULT_KEYS,
    code,
    "Access administration mutation result is malformed.",
  );
  return {
    username: validatePattern(
      input.username,
      /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/,
      128,
      code,
      "Access administration username is malformed.",
    ),
    subject: validateSubject(input.subject, code),
    membershipStatus: validateEnum(
      input.membershipStatus,
      new Set(["ACTIVE", "REVOKED"]),
      code,
      "Access administration membership status is malformed.",
    ),
    changed: (() => {
      if (typeof input.changed !== "boolean") {
        fail(
          code,
          "Access administration changed flag is malformed.",
        );
      }
      return input.changed;
    })(),
  };
}

function validateMutation(
  input,
  clock,
  {
    entityType,
    resourceKey,
    operation,
    resultStatus,
    anchorToClock = true,
  } = {},
) {
  const code = "INVALID_MUTATION";
  const hasAuthorizationEvidence =
    isPlainObject(input)
    && Object.hasOwn(input, "authorizationEvidenceId");
  requireExactKeys(
    input,
    hasAuthorizationEvidence
      ? MUTATION_WITH_AUTHORIZATION_EVIDENCE_KEYS
      : MUTATION_KEYS,
    code,
    "Mutation is malformed.",
  );
  requireExactKeys(
    input.result,
    isPlainObject(input.result)
      && Object.hasOwn(input.result, "accessAdmin")
      ? MUTATION_RESULT_WITH_ACCESS_ADMIN_KEYS
      : MUTATION_RESULT_KEYS,
    code,
    "Mutation result is malformed.",
  );
  const createdAt = validateTimestamp(input.createdAt, code);
  const timestamp = validateTimestamp(input.timestamp, code);
  if (
    timestamp !== createdAt
    || (
      anchorToClock
      && (
        createdAt !== clock.timestamp
        || timestamp !== clock.timestamp
      )
    )
  ) {
    fail(code, "Mutation expiration is malformed.");
  }
  const result = {
    entityType: validatePattern(
      input.result.entityType,
      /^[A-Z][A-Z0-9_]{0,63}$/,
      64,
      code,
      "Mutation entity type is malformed.",
    ),
    resourceKey: validateText(
      input.result.resourceKey,
      512,
      code,
      "Mutation resource key is malformed.",
    ),
    operation: validateEnum(
      input.result.operation,
      new Set(["CREATE", "UPDATE", "APPEND"]),
      code,
      "Mutation operation is malformed.",
    ),
    status: validateEnum(
      input.result.status,
      new Set(["SUCCEEDED", "FAILED"]),
      code,
      "Mutation status is malformed.",
    ),
    ...(Object.hasOwn(input.result, "accessAdmin")
      ? {
          accessAdmin: validateAccessAdminMutationResult(
            input.result.accessAdmin,
            code,
          ),
        }
      : {}),
  };
  if (
    (entityType !== undefined && result.entityType !== entityType)
    || (resourceKey !== undefined && result.resourceKey !== resourceKey)
    || (operation !== undefined && result.operation !== operation)
    || (resultStatus !== undefined && result.status !== resultStatus)
  ) {
    fail(code, "Mutation result does not match the resource.");
  }
  if (
    result.accessAdmin !== undefined
    && (
      result.entityType !== "WORKSPACE_AUDIT"
      || result.operation !== "APPEND"
      || result.status !== "SUCCEEDED"
    )
  ) {
    fail(code, "Mutation result does not match the resource.");
  }
  const requesterSubject = validateSubject(input.requesterSubject, code);
  if (
    result.accessAdmin !== undefined
    && requesterSubject !== result.accessAdmin.subject
  ) {
    fail(code, "Mutation requester does not match the result.");
  }
  return {
    actor: validateSubject(input.actor, code),
    requesterSubject,
    effectiveRole: validateEnum(
      input.effectiveRole,
      EFFECTIVE_ROLES,
      code,
      "Mutation effective role is malformed.",
    ),
    domainId: validateDomainId(input.domainId, code),
    projectId: input.projectId === null
      ? null
      : validateSlug(input.projectId, code, "Project ID"),
    route: validatePattern(
      input.route,
      ROUTE_PATTERN,
      263,
      code,
      "Mutation route is malformed.",
    ),
    requestId: validatePattern(
      input.requestId,
      REQUEST_ID_PATTERN,
      128,
      code,
      "Mutation request ID is malformed.",
    ),
    payloadFingerprint: validatePattern(
      input.payloadFingerprint,
      FINGERPRINT_PATTERN,
      64,
      code,
      "Mutation fingerprint is malformed.",
    ),
    result,
    decision: validatePattern(
      input.decision,
      DECISION_PATTERN,
      32,
      code,
      "Mutation decision is malformed.",
    ),
    reason: validateText(
      input.reason,
      1024,
      code,
      "Mutation reason is malformed.",
    ),
    timestamp,
    createdAt,
    ...(hasAuthorizationEvidence
      ? {
          authorizationEvidenceId: validateSlug(
            input.authorizationEvidenceId,
            code,
            "Authorization evidence ID",
          ),
        }
      : {}),
  };
}

function validateMutationClaim(input, clock) {
  const code = "INVALID_MUTATION";
  requireExactKeys(
    input,
    MUTATION_CLAIM_KEYS,
    code,
    "Mutation claim is malformed.",
  );
  return {
    actor: validateSubject(input.actor, code),
    requesterSubject: validateSubject(input.requesterSubject, code),
    effectiveRole: validateEnum(
      input.effectiveRole,
      EFFECTIVE_ROLES,
      code,
      "Mutation claim role is malformed.",
    ),
    domainId: validateDomainId(input.domainId, code),
    projectId: input.projectId === null
      ? null
      : validateSlug(input.projectId, code, "Project ID"),
    route: validatePattern(
      input.route,
      ROUTE_PATTERN,
      263,
      code,
      "Mutation route is malformed.",
    ),
    requestId: validatePattern(
      input.requestId,
      REQUEST_ID_PATTERN,
      128,
      code,
      "Mutation request ID is malformed.",
    ),
    payloadFingerprint: validatePattern(
      input.payloadFingerprint,
      FINGERPRINT_PATTERN,
      64,
      code,
      "Mutation fingerprint is malformed.",
    ),
    resourceKey: validateText(
      input.resourceKey,
      512,
      code,
      "Mutation resource key is malformed.",
    ),
    operation: validateEnum(
      input.operation,
      new Set(["CREATE", "UPDATE", "APPEND"]),
      code,
      "Mutation operation is malformed.",
    ),
    createdAt: clock.timestamp,
  };
}

function stringAttribute(value) {
  return { S: value };
}

function nullableStringAttribute(value) {
  return value === null ? { NULL: true } : stringAttribute(value);
}

function nullableIntegerAttribute(value) {
  return value === null ? { NULL: true } : { N: String(value) };
}

function buildConfigAttribute(value) {
  if (value === null) return { NULL: true };
  return {
    M: {
      instructions: stringAttribute(value.instructions),
      modelParameters: {
        M: {
          temperature: nullableIntegerAttribute(
            value.modelParameters.temperature,
          ),
          maxTokens: nullableIntegerAttribute(
            value.modelParameters.maxTokens,
          ),
        },
      },
      buildOptions: {
        M: {
          framework: stringAttribute(value.buildOptions.framework),
          deployTarget: stringAttribute(value.buildOptions.deployTarget),
          memory: stringAttribute(value.buildOptions.memory),
          streaming: { BOOL: value.buildOptions.streaming },
          identity: { BOOL: value.buildOptions.identity },
          guardrails: { BOOL: value.buildOptions.guardrails },
        },
      },
      ...(Object.hasOwn(value, "guardrailChain")
        ? {
            guardrailChain: {
              L: value.guardrailChain.map((entry) => ({
                M: {
                  id: stringAttribute(entry.id),
                  enabled: { BOOL: entry.enabled },
                  action: stringAttribute(entry.action),
                  runMode: stringAttribute(entry.runMode),
                  message: stringAttribute(entry.message),
                  priority: { N: String(entry.priority) },
                },
              })),
            },
          }
        : {}),
    },
  };
}

function stringListAttribute(values) {
  return { L: values.map(stringAttribute) };
}

function projectToItem(record) {
  return {
    pk: stringAttribute(`PROJECT#${record.domainId}`),
    sk: stringAttribute(`PROJECT#${record.id}`),
    entityType: stringAttribute("PROJECT"),
    domainId: stringAttribute(record.domainId),
    id: stringAttribute(record.id),
    name: stringAttribute(record.name),
    description: stringAttribute(record.description),
    ownerSubject: stringAttribute(record.ownerSubject),
    memberSubjects: stringListAttribute(record.memberSubjects),
    ...(Object.hasOwn(record, "resourcePolicy")
      ? { resourcePolicy: stringAttribute(JSON.stringify(record.resourcePolicy)) } : {}),
    status: stringAttribute(record.status),
    createdBySubject: stringAttribute(record.createdBySubject),
    createdAt: stringAttribute(record.createdAt),
  };
}

function agentToItem(record) {
  return {
    pk: stringAttribute(`AGENT#${record.domainId}#${record.projectId}`),
    sk: stringAttribute(`AGENT#${record.id}`),
    entityType: stringAttribute("AGENT"),
    domainId: stringAttribute(record.domainId),
    projectId: stringAttribute(record.projectId),
    id: stringAttribute(record.id),
    name: stringAttribute(record.name),
    description: stringAttribute(record.description),
    ownerSubject: stringAttribute(record.ownerSubject),
    modelId: stringAttribute(record.modelId),
    toolIds: stringListAttribute(record.toolIds),
    mcpServerIds: stringListAttribute(record.mcpServerIds),
    skillIds: stringListAttribute(record.skillIds),
    blueprintIds: stringListAttribute(record.blueprintIds),
    memoryIds: stringListAttribute(record.memoryIds),
    knowledgeBaseIds: stringListAttribute(record.knowledgeBaseIds),
    buildConfig: buildConfigAttribute(record.buildConfig),
    status: stringAttribute(record.status),
    createdBySubject: stringAttribute(record.createdBySubject),
    createdAt: stringAttribute(record.createdAt),
    updatedAt: stringAttribute(record.updatedAt),
    lastTestStatus: nullableStringAttribute(record.lastTestStatus),
    lastTestedAt: nullableStringAttribute(record.lastTestedAt),
    lastTestedBySubject:
      nullableStringAttribute(record.lastTestedBySubject),
    lastTestModelId: nullableStringAttribute(record.lastTestModelId),
    lastTestInputTokens:
      nullableIntegerAttribute(record.lastTestInputTokens),
    lastTestOutputTokens:
      nullableIntegerAttribute(record.lastTestOutputTokens),
    lastTestRequestId: nullableStringAttribute(record.lastTestRequestId),
    lastTestEvidenceHash:
      nullableStringAttribute(record.lastTestEvidenceHash),
    lastTestOutput: nullableStringAttribute(record.lastTestOutput),
  };
}

function deploymentToItem(record) {
  return {
    pk: stringAttribute(
      `DEPLOYMENT#${record.domainId}#${record.projectId}`,
    ),
    sk: stringAttribute(`DEPLOYMENT#${record.id}`),
    entityType: stringAttribute("DEPLOYMENT"),
    domainId: stringAttribute(record.domainId),
    projectId: stringAttribute(record.projectId),
    id: stringAttribute(record.id),
    agentId: stringAttribute(record.agentId),
    environment: stringAttribute(record.environment),
    status: stringAttribute(record.status),
    requesterSubject: stringAttribute(record.requesterSubject),
    approverSubject: nullableStringAttribute(record.approverSubject),
    decisionReason: nullableStringAttribute(record.decisionReason),
    requestedAt: stringAttribute(record.requestedAt),
    decidedAt: nullableStringAttribute(record.decidedAt),
    runtimeId: nullableStringAttribute(record.runtimeId),
    runtimeArn: nullableStringAttribute(record.runtimeArn),
    runtimeStatus: nullableStringAttribute(record.runtimeStatus),
    endpointName: nullableStringAttribute(record.endpointName),
    endpointArn: nullableStringAttribute(record.endpointArn),
    runtimeVersion: nullableStringAttribute(record.runtimeVersion),
    updatedAt: stringAttribute(record.updatedAt),
  };
}

function approvalToItem(record) {
  return {
    pk: stringAttribute(`APPROVAL#${record.domainId}`),
    sk: stringAttribute(`APPROVAL#${record.id}`),
    entityType: stringAttribute("APPROVAL"),
    domainId: stringAttribute(record.domainId),
    id: stringAttribute(record.id),
    kind: stringAttribute(record.kind),
    resourceType: stringAttribute(record.resourceType),
    resourceId: stringAttribute(record.resourceId),
    projectId: nullableStringAttribute(record.projectId),
    status: stringAttribute(record.status),
    requesterSubject: stringAttribute(record.requesterSubject),
    approverSubject: nullableStringAttribute(record.approverSubject),
    reason: nullableStringAttribute(record.reason),
    requestedAt: stringAttribute(record.requestedAt),
    decidedAt: nullableStringAttribute(record.decidedAt),
    ...(Object.hasOwn(record, "recordVersion") ? Object.fromEntries(
      PUBLICATION_BINDING_KEYS.map(key => [key, stringAttribute(record[key])]),
    ) : {}),
  };
}

function resourceGrantToItem(record) {
  return {
    pk: stringAttribute(`GRANT#${record.domainId}`),
    sk: stringAttribute(
      `GRANT#${record.resourceType}#${record.resourceId}`,
    ),
    entityType: stringAttribute("RESOURCE_GRANT"),
    domainId: stringAttribute(record.domainId),
    resourceType: stringAttribute(record.resourceType),
    resourceId: stringAttribute(record.resourceId),
    status: stringAttribute(record.status),
    grantedBySubject: stringAttribute(record.grantedBySubject),
    grantedAt: stringAttribute(record.grantedAt),
    revokedBySubject: nullableStringAttribute(record.revokedBySubject),
    revokedAt: nullableStringAttribute(record.revokedAt),
  };
}

function entitlementToItem(record) {
  const subjectType = record.subjectType ?? "USER";
  const item = {
    pk: stringAttribute(
      entitlementPartitionKey(subjectType, record.subject),
    ),
    sk: stringAttribute(
      `AGENT#${record.domainId}#${record.projectId}#${record.agentId}`,
    ),
    entityType: stringAttribute("ENTITLEMENT"),
    subject: stringAttribute(record.subject),
    agentId: stringAttribute(record.agentId),
    domainId: stringAttribute(record.domainId),
    projectId: stringAttribute(record.projectId),
    status: stringAttribute(record.status),
    grantedBySubject: stringAttribute(record.grantedBySubject),
    grantedAt: stringAttribute(record.grantedAt),
    revokedBySubject: nullableStringAttribute(record.revokedBySubject),
    revokedAt: nullableStringAttribute(record.revokedAt),
  };
  if (record.subjectType !== undefined) {
    item.subjectType = stringAttribute(record.subjectType);
    item.expiresAt = nullableStringAttribute(record.expiresAt);
  }
  return item;
}

function sessionToItem(record) {
  return {
    pk: stringAttribute(`SESSION#${record.actor}`),
    sk: stringAttribute(`SESSION#${record.id}`),
    entityType: stringAttribute("SESSION"),
    actor: stringAttribute(record.actor),
    id: stringAttribute(record.id),
    agentId: stringAttribute(record.agentId),
    domainId: stringAttribute(record.domainId),
    projectId: stringAttribute(record.projectId),
    status: stringAttribute(record.status),
    lastInvocationStatus:
      nullableStringAttribute(record.lastInvocationStatus),
    createdAt: stringAttribute(record.createdAt),
    updatedAt: stringAttribute(record.updatedAt),
  };
}

function incidentToItem(record) {
  return {
    pk: stringAttribute(`INCIDENT#${record.domainId}`),
    sk: stringAttribute(`INCIDENT#${record.id}`),
    entityType: stringAttribute("INCIDENT"),
    domainId: stringAttribute(record.domainId),
    projectId: stringAttribute(record.projectId),
    id: stringAttribute(record.id),
    title: stringAttribute(record.title),
    description: stringAttribute(record.description),
    severity: stringAttribute(record.severity),
    status: stringAttribute(record.status),
    ownerSubject: stringAttribute(record.ownerSubject),
    reporterSubject: stringAttribute(record.reporterSubject),
    acknowledgedBySubject:
      nullableStringAttribute(record.acknowledgedBySubject),
    acknowledgedAt: nullableStringAttribute(record.acknowledgedAt),
    resolvedBySubject: nullableStringAttribute(record.resolvedBySubject),
    resolvedAt: nullableStringAttribute(record.resolvedAt),
    reopenedBySubject: nullableStringAttribute(record.reopenedBySubject),
    reopenedAt: nullableStringAttribute(record.reopenedAt),
    lastActionReason: stringAttribute(record.lastActionReason),
    createdAt: stringAttribute(record.createdAt),
    updatedAt: stringAttribute(record.updatedAt),
  };
}

function breakGlassToItem(record) {
  return {
    pk: stringAttribute("BREAK_GLASS"),
    sk: stringAttribute(`BREAK_GLASS#${record.id}`),
    entityType: stringAttribute("BREAK_GLASS"),
    id: stringAttribute(record.id),
    domainId: stringAttribute(record.domainId),
    projectId: nullableStringAttribute(record.projectId),
    resource: stringAttribute(record.resource),
    action: stringAttribute(record.action),
    status: stringAttribute(record.status),
    requesterSubject: stringAttribute(record.requesterSubject),
    reason: stringAttribute(record.reason),
    requestedAt: stringAttribute(record.requestedAt),
    expiresAt: stringAttribute(record.expiresAt),
    approverSubject: nullableStringAttribute(record.approverSubject),
    decisionReason: nullableStringAttribute(record.decisionReason),
    decidedAt: nullableStringAttribute(record.decidedAt),
    activatedBySubject:
      nullableStringAttribute(record.activatedBySubject),
    activationReason: nullableStringAttribute(record.activationReason),
    activatedAt: nullableStringAttribute(record.activatedAt),
    revokedBySubject: nullableStringAttribute(record.revokedBySubject),
    revocationReason: nullableStringAttribute(record.revocationReason),
    revokedAt: nullableStringAttribute(record.revokedAt),
  };
}

function auditToItem(record) {
  return {
    pk: stringAttribute(`AUDIT#${record.resource}`),
    sk: stringAttribute(`${record.timestamp}#${record.requestId}`),
    entityType: stringAttribute("WORKSPACE_AUDIT"),
    resource: stringAttribute(record.resource),
    timestamp: stringAttribute(record.timestamp),
    requestId: stringAttribute(record.requestId),
    actor: stringAttribute(record.actor),
    requesterSubject: stringAttribute(record.requesterSubject),
    effectiveRole: stringAttribute(record.effectiveRole),
    action: stringAttribute(record.action),
    decision: stringAttribute(record.decision),
    reason: stringAttribute(record.reason),
    domainId: stringAttribute(record.domainId),
    projectId: nullableStringAttribute(record.projectId),
    ...(record.authorizationEvidenceId === undefined
      ? {}
      : {
          authorizationEvidenceId:
            stringAttribute(record.authorizationEvidenceId),
        }),
  };
}

function mutationToItem(value) {
  const result = {
    entityType: stringAttribute(value.result.entityType),
    resourceKey: stringAttribute(value.result.resourceKey),
    operation: stringAttribute(value.result.operation),
    status: stringAttribute(value.result.status),
  };
  if (value.result.accessAdmin !== undefined) {
    result.accessAdmin = {
      M: {
        username: stringAttribute(value.result.accessAdmin.username),
        subject: stringAttribute(value.result.accessAdmin.subject),
        membershipStatus:
          stringAttribute(value.result.accessAdmin.membershipStatus),
        changed: { BOOL: value.result.accessAdmin.changed },
      },
    };
  }
  return {
    pk: stringAttribute(`MUTATION#${value.actor}`),
    sk: stringAttribute(`MUTATION#${value.route}#${value.requestId}`),
    entityType: stringAttribute("MUTATION_RESULT"),
    actor: stringAttribute(value.actor),
    requesterSubject: stringAttribute(value.requesterSubject),
    effectiveRole: stringAttribute(value.effectiveRole),
    domainId: stringAttribute(value.domainId),
    projectId: nullableStringAttribute(value.projectId),
    route: stringAttribute(value.route),
    requestId: stringAttribute(value.requestId),
    payloadFingerprint: stringAttribute(value.payloadFingerprint),
    result: {
      M: result,
    },
    decision: stringAttribute(value.decision),
    reason: stringAttribute(value.reason),
    timestamp: stringAttribute(value.timestamp),
    createdAt: stringAttribute(value.createdAt),
    ...(value.authorizationEvidenceId === undefined
      ? {}
      : {
          authorizationEvidenceId:
            stringAttribute(value.authorizationEvidenceId),
        }),
  };
}

function mutationClaimToItem(value) {
  return {
    pk: stringAttribute(`MUTATION#${value.actor}`),
    sk: stringAttribute(`CLAIM#${value.route}#${value.requestId}`),
    entityType: stringAttribute("MUTATION_CLAIM"),
    actor: stringAttribute(value.actor),
    requesterSubject: stringAttribute(value.requesterSubject),
    effectiveRole: stringAttribute(value.effectiveRole),
    domainId: stringAttribute(value.domainId),
    projectId: nullableStringAttribute(value.projectId),
    route: stringAttribute(value.route),
    requestId: stringAttribute(value.requestId),
    payloadFingerprint: stringAttribute(value.payloadFingerprint),
    resourceKey: stringAttribute(value.resourceKey),
    operation: stringAttribute(value.operation),
    createdAt: stringAttribute(value.createdAt),
  };
}

function nativeString(item, key) {
  const value = item[key];
  if (!hasExactKeys(value, new Set(["S"])) || typeof value.S !== "string") {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  return value.S;
}

function nativeNullableString(item, key) {
  const value = item[key];
  if (hasExactKeys(value, new Set(["NULL"])) && value.NULL === true) {
    return null;
  }
  return nativeString(item, key);
}

function nativeInteger(item, key) {
  const value = item[key];
  if (!hasExactKeys(value, new Set(["N"])) || typeof value.N !== "string") {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  const parsed = Number(value.N);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value.N) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  return parsed;
}

function nativeBoolean(item, key) {
  const value = item[key];
  if (!hasExactKeys(value, new Set(["BOOL"])) || typeof value.BOOL !== "boolean") {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  return value.BOOL;
}

function nativeNullableInteger(item, key) {
  const value = item[key];
  if (hasExactKeys(value, new Set(["NULL"])) && value.NULL === true) {
    return null;
  }
  return nativeInteger(item, key);
}

function nativeNullableNumber(item, key) {
  const value = item[key];
  if (hasExactKeys(value, new Set(["NULL"])) && value.NULL === true) {
    return null;
  }
  if (!hasExactKeys(value, new Set(["N"])) || typeof value.N !== "string") {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  const parsed = Number(value.N);
  if (!Number.isFinite(parsed) || String(parsed) !== value.N) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  return parsed;
}

function nativeBuildConfig(item) {
  if (!Object.hasOwn(item, "buildConfig")) return null;
  const value = item.buildConfig;
  if (hasExactKeys(value, new Set(["NULL"])) && value.NULL === true) {
    return null;
  }
  if (
    !hasExactKeys(value, new Set(["M"]))
    || (
      !hasExactKeys(value.M, BUILD_CONFIG_KEYS)
      && !hasExactKeys(value.M, LEGACY_BUILD_CONFIG_KEYS)
    )
    || !hasExactKeys(value.M.modelParameters, new Set(["M"]))
    || !hasExactKeys(value.M.modelParameters.M, MODEL_PARAMETER_KEYS)
    || !hasExactKeys(value.M.buildOptions, new Set(["M"]))
    || !hasExactKeys(value.M.buildOptions.M, BUILD_OPTION_KEYS)
  ) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  const parameters = value.M.modelParameters.M;
  const options = value.M.buildOptions.M;
  try {
    const buildConfig = {
      instructions: nativeString(value.M, "instructions"),
      modelParameters: {
        temperature: nativeNullableNumber(parameters, "temperature"),
        maxTokens: nativeNullableInteger(parameters, "maxTokens"),
      },
      buildOptions: {
        framework: nativeString(options, "framework"),
        deployTarget: nativeString(options, "deployTarget"),
        memory: nativeString(options, "memory"),
        streaming: nativeBoolean(options, "streaming"),
        identity: nativeBoolean(options, "identity"),
        guardrails: nativeBoolean(options, "guardrails"),
      },
    };
    if (Object.hasOwn(value.M, "guardrailChain")) {
      const chain = value.M.guardrailChain;
      if (
        !hasExactKeys(chain, new Set(["L"]))
        || !Array.isArray(chain.L)
      ) {
        fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
      }
      buildConfig.guardrailChain = chain.L.map((attribute) => {
        if (
          !hasExactKeys(attribute, new Set(["M"]))
          || !hasExactKeys(attribute.M, new Set([
            "id",
            "enabled",
            "action",
            "runMode",
            "message",
            "priority",
          ]))
        ) {
          fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
        }
        return {
          id: nativeString(attribute.M, "id"),
          enabled: nativeBoolean(attribute.M, "enabled"),
          action: nativeString(attribute.M, "action"),
          runMode: nativeString(attribute.M, "runMode"),
          message: nativeString(attribute.M, "message"),
          priority: nativeInteger(attribute.M, "priority"),
        };
      });
    }
    return validateAgentBuildConfig(buildConfig);
  } catch {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
}

function nativeStringList(item, key) {
  const value = item[key];
  if (!hasExactKeys(value, new Set(["L"])) || !Array.isArray(value.L)) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  const list = value.L;
  if (
    !Number.isSafeInteger(list.length)
    || list.length > MAX_PAGE_SIZE
    || Reflect.ownKeys(list).length !== list.length + 1
  ) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  const result = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(
      list,
      String(index),
    );
    if (!entry || !Object.hasOwn(entry, "value")) {
      fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
    }
    result.push(nativeString({ entry: entry.value }, "entry"));
  }
  return result;
}

function assertStoredIdentity(item, keys, entityType, pk, sk) {
  if (
    !hasExactKeys(item, keys)
    || nativeString(item, "entityType") !== entityType
    || nativeString(item, "pk") !== pk
    || nativeString(item, "sk") !== sk
  ) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
}

function projectFromItem(item) {
  const domainId = nativeString(item, "domainId");
  const id = nativeString(item, "id");
  assertStoredIdentity(
    item,
    new Set([...PROJECT_ITEM_KEYS, ...(Object.hasOwn(item, "resourcePolicy") ? ["resourcePolicy"] : [])]),
    "PROJECT",
    `PROJECT#${domainId}`,
    `PROJECT#${id}`,
  );
  return validateProject({
    domainId,
    id,
    name: nativeString(item, "name"),
    description: nativeString(item, "description"),
    ownerSubject: nativeString(item, "ownerSubject"),
    memberSubjects: nativeStringList(item, "memberSubjects"),
    ...(Object.hasOwn(item, "resourcePolicy")
      ? { resourcePolicy: JSON.parse(nativeString(item, "resourcePolicy")) } : {}),
    status: nativeString(item, "status"),
    createdBySubject: nativeString(item, "createdBySubject"),
    createdAt: nativeString(item, "createdAt"),
  });
}

function agentFromItem(item) {
  const domainId = nativeString(item, "domainId");
  const projectId = nativeString(item, "projectId");
  const id = nativeString(item, "id");
  assertStoredIdentity(
    item,
    Object.hasOwn(item, "buildConfig")
      ? AGENT_ITEM_KEYS
      : LEGACY_AGENT_ITEM_KEYS,
    "AGENT",
    `AGENT#${domainId}#${projectId}`,
    `AGENT#${id}`,
  );
  return validateAgent({
    domainId,
    projectId,
    id,
    name: nativeString(item, "name"),
    description: nativeString(item, "description"),
    ownerSubject: nativeString(item, "ownerSubject"),
    modelId: nativeString(item, "modelId"),
    toolIds: nativeStringList(item, "toolIds"),
    mcpServerIds: nativeStringList(item, "mcpServerIds"),
    skillIds: nativeStringList(item, "skillIds"),
    blueprintIds: nativeStringList(item, "blueprintIds"),
    memoryIds: nativeStringList(item, "memoryIds"),
    knowledgeBaseIds: nativeStringList(item, "knowledgeBaseIds"),
    buildConfig: nativeBuildConfig(item),
    status: nativeString(item, "status"),
    createdBySubject: nativeString(item, "createdBySubject"),
    createdAt: nativeString(item, "createdAt"),
    updatedAt: nativeString(item, "updatedAt"),
    lastTestStatus: nativeNullableString(item, "lastTestStatus"),
    lastTestedAt: nativeNullableString(item, "lastTestedAt"),
    lastTestedBySubject:
      nativeNullableString(item, "lastTestedBySubject"),
    lastTestModelId: nativeNullableString(item, "lastTestModelId"),
    lastTestInputTokens:
      nativeNullableInteger(item, "lastTestInputTokens"),
    lastTestOutputTokens:
      nativeNullableInteger(item, "lastTestOutputTokens"),
    lastTestRequestId: nativeNullableString(item, "lastTestRequestId"),
    lastTestEvidenceHash:
      nativeNullableString(item, "lastTestEvidenceHash"),
    lastTestOutput: nativeNullableString(item, "lastTestOutput"),
  });
}

function mutationClaimFromItem(item) {
  const actor = nativeString(item, "actor");
  const route = nativeString(item, "route");
  const requestId = nativeString(item, "requestId");
  const allowedKeys = Object.hasOwn(item, "expiresAt")
    ? LEGACY_MUTATION_CLAIM_ITEM_KEYS
    : MUTATION_CLAIM_ITEM_KEYS;
  assertStoredIdentity(
    item,
    allowedKeys,
    "MUTATION_CLAIM",
    `MUTATION#${actor}`,
    `CLAIM#${route}#${requestId}`,
  );
  const createdAt = nativeString(item, "createdAt");
  validateTimestamp(
    createdAt,
    "MALFORMED_DYNAMODB_RESPONSE",
    "Stored mutation claim is malformed.",
  );
  if (Object.hasOwn(item, "expiresAt")) {
    const expiresAt = nativeInteger(item, "expiresAt");
    if (expiresAt <= Math.floor(Date.parse(createdAt) / 1000)) {
      fail(
        "MALFORMED_DYNAMODB_RESPONSE",
        "Stored mutation claim is malformed.",
      );
    }
  }
  return {
    actor: validateSubject(actor, "MALFORMED_DYNAMODB_RESPONSE"),
    requesterSubject: validateSubject(
      nativeString(item, "requesterSubject"),
      "MALFORMED_DYNAMODB_RESPONSE",
    ),
    effectiveRole: validateEnum(
      nativeString(item, "effectiveRole"),
      EFFECTIVE_ROLES,
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored mutation claim is malformed.",
    ),
    domainId: validateDomainId(
      nativeString(item, "domainId"),
      "MALFORMED_DYNAMODB_RESPONSE",
    ),
    projectId: (() => {
      const value = nativeNullableString(item, "projectId");
      return value === null
        ? null
        : validateSlug(
          value,
          "MALFORMED_DYNAMODB_RESPONSE",
          "Project ID",
        );
    })(),
    route,
    requestId,
    payloadFingerprint: validatePattern(
      nativeString(item, "payloadFingerprint"),
      FINGERPRINT_PATTERN,
      64,
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored mutation claim is malformed.",
    ),
    resourceKey: validateText(
      nativeString(item, "resourceKey"),
      512,
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored mutation claim is malformed.",
    ),
    operation: validateEnum(
      nativeString(item, "operation"),
      new Set(["CREATE", "UPDATE", "APPEND"]),
      "MALFORMED_DYNAMODB_RESPONSE",
      "Stored mutation claim is malformed.",
    ),
    createdAt,
  };
}

function deploymentFromItem(item) {
  const domainId = nativeString(item, "domainId");
  const projectId = nativeString(item, "projectId");
  const id = nativeString(item, "id");
  assertStoredIdentity(
    item,
    DEPLOYMENT_ITEM_KEYS,
    "DEPLOYMENT",
    `DEPLOYMENT#${domainId}#${projectId}`,
    `DEPLOYMENT#${id}`,
  );
  return validateDeployment({
    domainId,
    projectId,
    id,
    agentId: nativeString(item, "agentId"),
    environment: nativeString(item, "environment"),
    status: nativeString(item, "status"),
    requesterSubject: nativeString(item, "requesterSubject"),
    approverSubject: nativeNullableString(item, "approverSubject"),
    decisionReason: nativeNullableString(item, "decisionReason"),
    requestedAt: nativeString(item, "requestedAt"),
    decidedAt: nativeNullableString(item, "decidedAt"),
    runtimeId: nativeNullableString(item, "runtimeId"),
    runtimeArn: nativeNullableString(item, "runtimeArn"),
    runtimeStatus: nativeNullableString(item, "runtimeStatus"),
    endpointName: nativeNullableString(item, "endpointName"),
    endpointArn: nativeNullableString(item, "endpointArn"),
    runtimeVersion: nativeNullableString(item, "runtimeVersion"),
    updatedAt: nativeString(item, "updatedAt"),
  });
}

function approvalFromItem(item) {
  const domainId = nativeString(item, "domainId");
  const id = nativeString(item, "id");
  assertStoredIdentity(
    item,
    PUBLICATION_BINDING_KEYS.some(key => Object.hasOwn(item, key))
      ? new Set([...APPROVAL_ITEM_KEYS, ...PUBLICATION_BINDING_KEYS]) : APPROVAL_ITEM_KEYS,
    "APPROVAL",
    `APPROVAL#${domainId}`,
    `APPROVAL#${id}`,
  );
  return validateApproval({
    domainId,
    id,
    kind: nativeString(item, "kind"),
    resourceType: nativeString(item, "resourceType"),
    resourceId: nativeString(item, "resourceId"),
    projectId: nativeNullableString(item, "projectId"),
    status: nativeString(item, "status"),
    requesterSubject: nativeString(item, "requesterSubject"),
    approverSubject: nativeNullableString(item, "approverSubject"),
    reason: nativeNullableString(item, "reason"),
    requestedAt: nativeString(item, "requestedAt"),
    decidedAt: nativeNullableString(item, "decidedAt"),
    ...(PUBLICATION_BINDING_KEYS.some(key => Object.hasOwn(item, key)) ? Object.fromEntries(
      PUBLICATION_BINDING_KEYS.map(key => [key, nativeString(item, key)]),
    ) : {}),
  });
}

function resourceGrantFromItem(item) {
  const domainId = nativeString(item, "domainId");
  const resourceType = nativeString(item, "resourceType");
  const resourceId = nativeString(item, "resourceId");
  assertStoredIdentity(
    item,
    RESOURCE_GRANT_ITEM_KEYS,
    "RESOURCE_GRANT",
    `GRANT#${domainId}`,
    `GRANT#${resourceType}#${resourceId}`,
  );
  return validateResourceGrant({
    domainId,
    resourceType,
    resourceId,
    status: nativeString(item, "status"),
    grantedBySubject: nativeString(item, "grantedBySubject"),
    grantedAt: nativeString(item, "grantedAt"),
    revokedBySubject: nativeNullableString(item, "revokedBySubject"),
    revokedAt: nativeNullableString(item, "revokedAt"),
  });
}

function entitlementFromItem(item) {
  const subject = nativeString(item, "subject");
  const agentId = nativeString(item, "agentId");
  const typed = Object.hasOwn(item, "subjectType")
    || Object.hasOwn(item, "expiresAt");
  const subjectType = typed
    ? nativeString(item, "subjectType")
    : "USER";
  assertStoredIdentity(
    item,
    typed ? TYPED_ENTITLEMENT_ITEM_KEYS : ENTITLEMENT_ITEM_KEYS,
    "ENTITLEMENT",
    entitlementPartitionKey(subjectType, subject),
    `AGENT#${nativeString(item, "domainId")}#`
      + `${nativeString(item, "projectId")}#${agentId}`,
  );
  const record = {
    subject,
    agentId,
    domainId: nativeString(item, "domainId"),
    projectId: nativeString(item, "projectId"),
    status: nativeString(item, "status"),
    grantedBySubject: nativeString(item, "grantedBySubject"),
    grantedAt: nativeString(item, "grantedAt"),
    revokedBySubject: nativeNullableString(item, "revokedBySubject"),
    revokedAt: nativeNullableString(item, "revokedAt"),
  };
  return validateEntitlement(
    typed
      ? {
          ...record,
          subjectType,
          expiresAt: nativeNullableString(item, "expiresAt"),
        }
      : record,
  );
}

function sessionFromItem(item) {
  const actor = nativeString(item, "actor");
  const id = nativeString(item, "id");
  assertStoredIdentity(
    item,
    SESSION_ITEM_KEYS,
    "SESSION",
    `SESSION#${actor}`,
    `SESSION#${id}`,
  );
  return validateSession({
    actor,
    id,
    agentId: nativeString(item, "agentId"),
    domainId: nativeString(item, "domainId"),
    projectId: nativeString(item, "projectId"),
    status: nativeString(item, "status"),
    lastInvocationStatus:
      nativeNullableString(item, "lastInvocationStatus"),
    createdAt: nativeString(item, "createdAt"),
    updatedAt: nativeString(item, "updatedAt"),
  });
}

function incidentFromItem(item) {
  const domainId = nativeString(item, "domainId");
  const id = nativeString(item, "id");
  assertStoredIdentity(
    item,
    INCIDENT_ITEM_KEYS,
    "INCIDENT",
    `INCIDENT#${domainId}`,
    `INCIDENT#${id}`,
  );
  return validateIncident({
    domainId,
    projectId: nativeString(item, "projectId"),
    id,
    title: nativeString(item, "title"),
    description: nativeString(item, "description"),
    severity: nativeString(item, "severity"),
    status: nativeString(item, "status"),
    ownerSubject: nativeString(item, "ownerSubject"),
    reporterSubject: nativeString(item, "reporterSubject"),
    acknowledgedBySubject:
      nativeNullableString(item, "acknowledgedBySubject"),
    acknowledgedAt: nativeNullableString(item, "acknowledgedAt"),
    resolvedBySubject:
      nativeNullableString(item, "resolvedBySubject"),
    resolvedAt: nativeNullableString(item, "resolvedAt"),
    reopenedBySubject:
      nativeNullableString(item, "reopenedBySubject"),
    reopenedAt: nativeNullableString(item, "reopenedAt"),
    lastActionReason: nativeString(item, "lastActionReason"),
    createdAt: nativeString(item, "createdAt"),
    updatedAt: nativeString(item, "updatedAt"),
  });
}

function breakGlassFromItem(item) {
  const id = nativeString(item, "id");
  assertStoredIdentity(
    item,
    BREAK_GLASS_ITEM_KEYS,
    "BREAK_GLASS",
    "BREAK_GLASS",
    `BREAK_GLASS#${id}`,
  );
  return validateBreakGlass({
    id,
    domainId: nativeString(item, "domainId"),
    projectId: nativeNullableString(item, "projectId"),
    resource: nativeString(item, "resource"),
    action: nativeString(item, "action"),
    status: nativeString(item, "status"),
    requesterSubject: nativeString(item, "requesterSubject"),
    reason: nativeString(item, "reason"),
    requestedAt: nativeString(item, "requestedAt"),
    expiresAt: nativeString(item, "expiresAt"),
    approverSubject: nativeNullableString(item, "approverSubject"),
    decisionReason: nativeNullableString(item, "decisionReason"),
    decidedAt: nativeNullableString(item, "decidedAt"),
    activatedBySubject:
      nativeNullableString(item, "activatedBySubject"),
    activationReason: nativeNullableString(item, "activationReason"),
    activatedAt: nativeNullableString(item, "activatedAt"),
    revokedBySubject: nativeNullableString(item, "revokedBySubject"),
    revocationReason:
      nativeNullableString(item, "revocationReason"),
    revokedAt: nativeNullableString(item, "revokedAt"),
  });
}

function auditFromItem(item) {
  const resource = nativeString(item, "resource");
  const timestamp = nativeString(item, "timestamp");
  const requestId = nativeString(item, "requestId");
  assertStoredIdentity(
    item,
    isPlainObject(item)
      && Object.hasOwn(item, "authorizationEvidenceId")
      ? AUDIT_WITH_AUTHORIZATION_EVIDENCE_ITEM_KEYS
      : AUDIT_ITEM_KEYS,
    "WORKSPACE_AUDIT",
    `AUDIT#${resource}`,
    `${timestamp}#${requestId}`,
  );
  return validateAudit({
    resource,
    timestamp,
    requestId,
    actor: nativeString(item, "actor"),
    requesterSubject: nativeString(item, "requesterSubject"),
    effectiveRole: nativeString(item, "effectiveRole"),
    action: nativeString(item, "action"),
    decision: nativeString(item, "decision"),
    reason: nativeString(item, "reason"),
    domainId: nativeString(item, "domainId"),
    projectId: nativeNullableString(item, "projectId"),
    ...(isPlainObject(item)
      && Object.hasOwn(item, "authorizationEvidenceId")
      ? {
          authorizationEvidenceId:
            nativeString(item, "authorizationEvidenceId"),
        }
      : {}),
  });
}

function mutationFromItem(item, clock) {
  const actor = nativeString(item, "actor");
  const route = nativeString(item, "route");
  const requestId = nativeString(item, "requestId");
  assertStoredIdentity(
    item,
    isPlainObject(item)
      && Object.hasOwn(item, "authorizationEvidenceId")
      ? MUTATION_WITH_AUTHORIZATION_EVIDENCE_ITEM_KEYS
      : MUTATION_ITEM_KEYS,
    "MUTATION_RESULT",
    `MUTATION#${actor}`,
    `MUTATION#${route}#${requestId}`,
  );
  const resultValue = item.result;
  if (
    !hasExactKeys(resultValue, new Set(["M"]))
    || !hasExactKeys(
      resultValue.M,
      Object.hasOwn(resultValue.M, "accessAdmin")
        ? MUTATION_RESULT_WITH_ACCESS_ADMIN_KEYS
        : MUTATION_RESULT_KEYS,
    )
  ) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
  const accessAdminValue = resultValue.M.accessAdmin;
  return validateMutation({
    actor,
    requesterSubject: nativeString(item, "requesterSubject"),
    effectiveRole: nativeString(item, "effectiveRole"),
    domainId: nativeString(item, "domainId"),
    projectId: nativeNullableString(item, "projectId"),
    route,
    requestId,
    payloadFingerprint: nativeString(item, "payloadFingerprint"),
    result: {
      entityType: nativeString(resultValue.M, "entityType"),
      resourceKey: nativeString(resultValue.M, "resourceKey"),
      operation: nativeString(resultValue.M, "operation"),
      status: nativeString(resultValue.M, "status"),
      ...(accessAdminValue === undefined
        ? {}
        : {
            accessAdmin: (() => {
              if (
                !hasExactKeys(accessAdminValue, new Set(["M"]))
                || !hasExactKeys(
                  accessAdminValue.M,
                  ACCESS_ADMIN_MUTATION_RESULT_KEYS,
                )
              ) {
                fail(
                  "MALFORMED_DYNAMODB_RESPONSE",
                  "Stored item is malformed.",
                );
              }
              return {
                username: nativeString(accessAdminValue.M, "username"),
                subject: nativeString(accessAdminValue.M, "subject"),
                membershipStatus:
                  nativeString(accessAdminValue.M, "membershipStatus"),
                changed: nativeBoolean(accessAdminValue.M, "changed"),
              };
            })(),
          }),
    },
    decision: nativeString(item, "decision"),
    reason: nativeString(item, "reason"),
    timestamp: nativeString(item, "timestamp"),
    createdAt: nativeString(item, "createdAt"),
    ...(isPlainObject(item)
      && Object.hasOwn(item, "authorizationEvidenceId")
      ? {
          authorizationEvidenceId:
            nativeString(item, "authorizationEvidenceId"),
        }
      : {}),
  }, clock, { anchorToClock: false });
}

function parseStored(parser, item) {
  try {
    return parser(item);
  } catch (error) {
    if (
      error instanceof WorkspaceStateError
      && error.code === "MALFORMED_DYNAMODB_RESPONSE"
    ) {
      throw error;
    }
    fail("MALFORMED_DYNAMODB_RESPONSE", "Stored item is malformed.");
  }
}

function projectResourceKey(record) {
  return `project/${record.domainId}/${record.id}`;
}

function agentResourceKey(record) {
  return `agent/${record.domainId}/${record.projectId}/${record.id}`;
}

function deploymentResourceKey(record) {
  return `deployment/${record.domainId}/${record.projectId}/${record.id}`;
}

function approvalResourceKey(record) {
  return `approval/${record.domainId}/${record.id}`;
}

function grantResourceKey(record) {
  return `grant/${record.domainId}/${record.resourceType}/${record.resourceId}`;
}

function entitlementResourceKey(record) {
  const subject = record.subjectType === undefined
    ? record.subject
    : `${record.subjectType}/${record.subject}`;
  return (
    `entitlement/${subject}/${record.domainId}/`
    + `${record.projectId}/${record.agentId}`
  );
}

function sessionResourceKey(record) {
  return `session/${record.actor}/${record.id}`;
}

function incidentResourceKey(record) {
  return `incident/${record.domainId}/${record.projectId}/${record.id}`;
}

function breakGlassResourceKey(record) {
  return `break-glass/${record.id}`;
}

function auditResourceKey(record) {
  return `audit/${record.resource}/${record.timestamp}/${record.requestId}`;
}

function validateExpectedStatus(
  expectedStatus,
  statuses,
  initialStatuses,
  transitions,
  record,
  transitionCode,
) {
  if (expectedStatus === null) {
    const allowed = typeof initialStatuses === "function"
      ? initialStatuses(record)
      : initialStatuses.has(record.status);
    if (!allowed) {
      fail(transitionCode, "Initial lifecycle state is malformed.");
    }
    return "CREATE";
  }
  if (!statuses.has(expectedStatus)) {
    fail(transitionCode, "Expected lifecycle state is malformed.");
  }
  if (!transitions[expectedStatus]?.has(record.status)) {
    fail(transitionCode, "Lifecycle transition is not allowed.");
  }
  return "UPDATE";
}

function actorForMutation(kind, record, operation) {
  if (kind === "PROJECT" && operation === "CREATE") {
    return record.createdBySubject;
  }
  if (kind === "AGENT" && operation === "CREATE") {
    return record.createdBySubject;
  }
  if (kind === "DEPLOYMENT") {
    if (
      operation === "UPDATE"
      && record.environment === "PRODUCTION"
      && record.approverSubject !== null
    ) {
      return record.approverSubject;
    }
    return record.requesterSubject;
  }
  if (kind === "APPROVAL") {
    return operation === "UPDATE" && record.approverSubject !== null
      ? record.approverSubject
      : record.requesterSubject;
  }
  if (kind === "RESOURCE_GRANT") {
    return record.status === "REVOKED"
      ? record.revokedBySubject
      : record.grantedBySubject;
  }
  if (kind === "ENTITLEMENT") {
    return record.status === "REVOKED"
      ? record.revokedBySubject
      : record.grantedBySubject;
  }
  if (kind === "SESSION") return record.actor;
  if (kind === "INCIDENT") {
    if (operation === "CREATE") return record.reporterSubject;
    if (record.status === "ACKNOWLEDGED") {
      return record.acknowledgedBySubject;
    }
    if (record.status === "RESOLVED") return record.resolvedBySubject;
    return record.reopenedBySubject;
  }
  if (kind === "BREAK_GLASS") {
    if (operation === "CREATE") return record.requesterSubject;
    if (
      record.status === "APPROVED"
      || record.status === "REJECTED"
    ) {
      return record.approverSubject;
    }
    if (record.status === "ACTIVE") return record.activatedBySubject;
    return record.revokedBySubject;
  }
  if (kind === "WORKSPACE_AUDIT") return record.actor;
  return null;
}

function requesterForMutation(kind, record, operation, mutation) {
  if (kind === "PROJECT" && operation === "CREATE") {
    return record.createdBySubject;
  }
  if (kind === "AGENT" && operation === "CREATE") {
    return record.createdBySubject;
  }
  if (
    kind === "DEPLOYMENT"
    || kind === "APPROVAL"
    || kind === "INCIDENT"
    || kind === "BREAK_GLASS"
  ) {
    if (kind === "INCIDENT") return record.reporterSubject;
    return record.requesterSubject;
  }
  return mutation.actor;
}

function mutationScopeFor(kind, record) {
  if (kind === "PROJECT") {
    return { domainId: record.domainId, projectId: record.id };
  }
  if (kind === "RESOURCE_GRANT") {
    return { domainId: record.domainId, projectId: null };
  }
  return {
    domainId: record.domainId,
    projectId: record.projectId,
  };
}

function expectedMutationDecision(kind, record, operation) {
  if (kind === "INCIDENT") {
    if (operation === "CREATE") {
      return {
        decision: "report",
        reason: record.lastActionReason,
      };
    }
    return {
      decision: record.status === "ACKNOWLEDGED"
        ? "acknowledge"
        : record.status === "RESOLVED"
          ? "resolve"
          : "reopen",
      reason: record.lastActionReason,
    };
  }
  if (kind === "BREAK_GLASS") {
    if (operation === "CREATE") {
      return { decision: "request", reason: record.reason };
    }
    if (record.status === "APPROVED") {
      return { decision: "approve", reason: record.decisionReason };
    }
    if (record.status === "REJECTED") {
      return { decision: "reject", reason: record.decisionReason };
    }
    if (record.status === "ACTIVE") {
      return { decision: "activate", reason: record.activationReason };
    }
    return { decision: "revoke", reason: record.revocationReason };
  }
  if (kind === "ENTITLEMENT") {
    return {
      decision: record.status === "REVOKED" ? "revoke" : "grant",
      reason: null,
    };
  }
  if (operation === "CREATE") return { decision: "create", reason: null };
  if (
    kind === "AGENT"
    && operation === "UPDATE"
    && record.status === "TEST_FAILED"
  ) {
    return { decision: "abort", reason: null };
  }
  if (kind === "APPROVAL") {
    if (record.status === "APPROVED") {
      return { decision: "approve", reason: record.reason };
    }
    if (record.status === "REJECTED") {
      return { decision: "reject", reason: record.reason };
    }
    if (record.status === "CANCELLED") {
      return { decision: "cancel", reason: record.reason };
    }
  }
  if (kind === "DEPLOYMENT") {
    if (record.status === "APPROVED") {
      return { decision: "approve", reason: record.decisionReason };
    }
    if (record.status === "REJECTED") {
      return { decision: "reject", reason: record.decisionReason };
    }
    if (record.status === "CANCELLED") {
      return {
        decision: "cancel",
        reason: record.approverSubject === null
          ? record.decisionReason
          : null,
      };
    }
  }
  if (
    (kind === "RESOURCE_GRANT" || kind === "ENTITLEMENT")
    && record.status === "REVOKED"
  ) {
    return { decision: "revoke", reason: null };
  }
  return { decision: "update", reason: null };
}

function validateMutationBinding(kind, record, mutation, operation) {
  const scope = mutationScopeFor(kind, record);
  if (
    mutation.domainId !== scope.domainId
    || mutation.projectId !== scope.projectId
  ) {
    fail(
      "MUTATION_SCOPE_MISMATCH",
      "Mutation scope does not match the resource.",
    );
  }
  if (
    mutation.requesterSubject
    !== requesterForMutation(kind, record, operation, mutation)
  ) {
    fail(
      "MUTATION_REQUESTER_MISMATCH",
      "Mutation requester does not match the resource.",
    );
  }
  const expected = expectedMutationDecision(kind, record, operation);
  if (
    mutation.decision !== expected.decision
    || (
      expected.reason !== null
      && mutation.reason !== expected.reason
    )
  ) {
    fail(
      "MUTATION_DECISION_MISMATCH",
      "Mutation decision does not match the resource.",
    );
  }
}

function validateAuditMutationBinding(record, mutation) {
  if (mutation.actor !== record.actor) {
    fail("ACTOR_MISMATCH", "Mutation actor does not match the resource.");
  }
  if (
    mutation.requesterSubject !== record.requesterSubject
    || mutation.effectiveRole !== record.effectiveRole
    || mutation.domainId !== record.domainId
    || mutation.projectId !== record.projectId
    || mutation.requestId !== record.requestId
    || mutation.decision !== record.decision
    || mutation.reason !== record.reason
    || mutation.timestamp !== record.timestamp
    || mutation.authorizationEvidenceId
      !== record.authorizationEvidenceId
  ) {
    fail(
      "MUTATION_AUDIT_MISMATCH",
      "Mutation does not match the audit evidence.",
    );
  }
}

function mutationToAudit(mutation) {
  return validateAudit({
    resource: mutation.result.resourceKey,
    timestamp: mutation.timestamp,
    requestId: mutation.requestId,
    actor: mutation.actor,
    requesterSubject: mutation.requesterSubject,
    effectiveRole: mutation.effectiveRole,
    action:
      `${mutation.result.entityType.toLowerCase()}.`
      + mutation.result.operation.toLowerCase(),
    decision: mutation.decision,
    reason: mutation.reason,
    domainId: mutation.domainId,
    projectId: mutation.projectId,
    ...(mutation.authorizationEvidenceId === undefined
      ? {}
      : {
          authorizationEvidenceId:
            mutation.authorizationEvidenceId,
        }),
  });
}

function transactionTimestampFields(
  kind,
  operation,
  expectedStatus,
  record,
) {
  if (operation === "CREATE") {
    return {
      PROJECT: ["createdAt"],
      AGENT: ["createdAt", "updatedAt"],
      DEPLOYMENT: ["requestedAt", "updatedAt"],
      APPROVAL: ["requestedAt"],
      RESOURCE_GRANT: ["grantedAt"],
      ENTITLEMENT: ["grantedAt"],
      SESSION: ["createdAt", "updatedAt"],
      INCIDENT: ["createdAt", "updatedAt"],
      BREAK_GLASS: ["requestedAt"],
    }[kind] ?? [];
  }
  if (kind === "AGENT" || kind === "SESSION") return ["updatedAt"];
  if (kind === "INCIDENT") {
    return recordActionTimestampFields(expectedStatus);
  }
  if (kind === "BREAK_GLASS") {
    return {
      REQUESTED: ["decidedAt"],
      APPROVED: ["activatedAt"],
      ACTIVE: ["revokedAt"],
    }[expectedStatus] ?? [];
  }
  if (kind === "DEPLOYMENT") {
    return expectedStatus === "REQUESTED"
      ? ["decidedAt", "updatedAt"]
      : ["updatedAt"];
  }
  if (kind === "APPROVAL") return ["decidedAt"];
  if (kind === "ENTITLEMENT") {
    return record.status === "ACTIVE" ? ["grantedAt"] : ["revokedAt"];
  }
  if (kind === "RESOURCE_GRANT" || kind === "ENTITLEMENT") {
    return ["revokedAt"];
  }
  return [];
}

function recordActionTimestampFields(expectedStatus) {
  return {
    OPEN: ["acknowledgedAt", "updatedAt"],
    ACKNOWLEDGED: ["resolvedAt", "updatedAt"],
    RESOLVED: ["reopenedAt", "updatedAt"],
  }[expectedStatus] ?? [];
}

function validateTransactionTimestamps(
  kind,
  record,
  operation,
  expectedStatus,
  clock,
  invalidCode,
) {
  const fields = transactionTimestampFields(
    kind,
    operation,
    expectedStatus,
    record,
  );
  if (fields.some((field) => record[field] !== clock.timestamp)) {
    fail(invalidCode, "Entity timestamps do not match the transaction.");
  }
}

function entityCondition(
  specification,
  record,
  expectedStatus,
  expectedRecord,
) {
  if (expectedStatus === null) {
    return {
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    };
  }
  const names = {
    "#entityType": "entityType",
    "#status": "status",
  };
  const values = {
    ":entityType": stringAttribute(specification.entityType),
    ":expectedStatus": stringAttribute(expectedStatus),
  };
  const immutableFields = new Set([
    ...specification.immutableFields,
    ...(
      specification.immutableFieldsForStatus?.(
        expectedStatus,
        record,
      ) ?? []
    ),
  ]);
  const identities = [...immutableFields].map((field) => {
    names[`#${field}`] = field;
    values[`:${field}`] = nullableStringAttribute(record[field]);
    return `#${field} = :${field}`;
  });
  const conditions = [
    "#entityType = :entityType",
    "#status = :expectedStatus",
    ...identities,
  ];
  if (
    specification.entityType === "ENTITLEMENT"
    && record.status === "ACTIVE"
    && expectedRecord !== undefined
  ) {
    for (const field of [
      "grantedBySubject",
      "grantedAt",
      "expiresAt",
      "revokedBySubject",
      "revokedAt",
    ]) {
      const priorToken =
        `:prior${field[0].toUpperCase()}${field.slice(1)}`;
      names[`#${field}`] = field;
      values[priorToken] = nullableStringAttribute(
        expectedRecord[field],
      );
      conditions.push(`#${field} = ${priorToken}`);
    }
    if (expectedStatus === "ACTIVE") {
      values[":renewalCutoff"] = stringAttribute(record.grantedAt);
      conditions.push("#expiresAt <= :renewalCutoff");
    }
  }
  return {
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

function mutationCondition() {
  return {
    ConditionExpression:
      "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
    },
  };
}

function isConditionalTransactionConflict(error, itemCount) {
  if (
    !(error instanceof TransactionCanceledException)
    || !Array.isArray(error.CancellationReasons)
    || error.CancellationReasons.length !== itemCount
    || error.CancellationReasons.some(
      ({ Code }) => Code !== "None" && Code !== "ConditionalCheckFailed",
    )
  ) {
    return false;
  }
  return error.CancellationReasons.some(
    ({ Code }) => Code === "ConditionalCheckFailed",
  );
}

function validateDynamoResponse(response) {
  if (!isPlainObject(response)) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "DynamoDB response is malformed.");
  }
}

function validateAbortSignal(value) {
  if (
    value === undefined
    || (
      value !== null
      && typeof value === "object"
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function"
    )
  ) {
    return value;
  }
  fail("INVALID_READ_OPTIONS", "Read options are malformed.");
}

function isAuditSortKey(value) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf("#");
  if (
    separator < 1
    || value.indexOf("#", separator + 1) !== -1
  ) {
    return false;
  }
  const timestamp = value.slice(0, separator);
  const requestId = value.slice(separator + 1);
  const epoch = Date.parse(timestamp);
  return (
    timestamp.length <= 32
    && Number.isFinite(epoch)
    && new Date(epoch).toISOString() === timestamp
    && requestId.length <= 128
    && REQUEST_ID_PATTERN.test(requestId)
  );
}

function matchesSortKeyFamily(value, sortKeyPrefix) {
  return typeof sortKeyPrefix === "function"
    ? sortKeyPrefix(value)
    : value.startsWith(sortKeyPrefix);
}

function validateCursor(value, partitionKey, sortKeyPrefix) {
  if (value === undefined) return undefined;
  if (
    !hasExactKeys(value, CURSOR_KEYS)
    || typeof value.pk !== "string"
    || typeof value.sk !== "string"
    || value.pk !== partitionKey
    || value.sk.length === 0
    || value.sk.length > 1024
    || !matchesSortKeyFamily(value.sk, sortKeyPrefix)
  ) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  return {
    pk: stringAttribute(value.pk),
    sk: stringAttribute(value.sk),
  };
}

function validateReadInput(
  input,
  {
    allowedKeys,
    requiredKeys,
    scopeCode,
    partitionKey,
    sortKeyPrefix,
  },
) {
  if (!isPlainObject(input)) fail(scopeCode, "Read scope is malformed.");
  const keys = Object.keys(input);
  if (
    keys.some((key) => !allowedKeys.has(key))
    || [...requiredKeys].some((key) => !Object.hasOwn(input, key))
  ) {
    fail(scopeCode, "Read scope is malformed.");
  }
  const limit = input.limit === undefined ? 50 : input.limit;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_PAGE_SIZE
  ) {
    fail("INVALID_READ_OPTIONS", "Read limit is malformed.");
  }
  return {
    limit,
    exclusiveStartKey: validateCursor(
      input.cursor,
      partitionKey,
      sortKeyPrefix,
    ),
    abortSignal: validateAbortSignal(input.abortSignal),
  };
}

function parseLastKey(value, partitionKey, sortKeyPrefix) {
  if (value === undefined) return null;
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 2
    || nativeString(value, "pk") !== partitionKey
    || !matchesSortKeyFamily(
      nativeString(value, "sk"),
      sortKeyPrefix,
    )
  ) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "DynamoDB cursor is malformed.");
  }
  return {
    pk: nativeString(value, "pk"),
    sk: nativeString(value, "sk"),
  };
}

function parseQueryPage(response, parser, partitionKey, sortKeyPrefix) {
  validateDynamoResponse(response);
  if (response.Items !== undefined && !Array.isArray(response.Items)) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "DynamoDB page is malformed.");
  }
  const items = (response.Items ?? []).map((item) =>
    parseStored(parser, item));
  return {
    items,
    cursor: parseLastKey(
      response.LastEvaluatedKey,
      partitionKey,
      sortKeyPrefix,
    ),
  };
}

function parseEntitlementPartitionKey(value) {
  if (
    typeof value !== "string"
    || !value.startsWith("ENTITLEMENT#")
  ) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  const suffix = value.slice("ENTITLEMENT#".length);
  const separator = suffix.indexOf("#");
  const possibleType = separator < 0
    ? null
    : suffix.slice(0, separator);
  const subjectType = ENTITLEMENT_SUBJECT_TYPES.has(possibleType)
    ? possibleType
    : "USER";
  const subject = subjectType === "USER" && possibleType === null
    ? suffix
    : suffix.slice(separator + 1);
  validateEntitlementSubject(
    subjectType,
    subject,
    "INVALID_READ_OPTIONS",
  );
  if (entitlementPartitionKey(subjectType, subject) !== value) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
}

function validateEntitlementInventoryCursor(value, domainId) {
  if (value === undefined) return undefined;
  if (
    !hasExactKeys(value, CURSOR_KEYS)
    || typeof value.pk !== "string"
    || value.pk.length === 0
    || value.pk.length > 1024
    || typeof value.sk !== "string"
    || value.sk.length === 0
    || value.sk.length > 1024
  ) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  parseEntitlementPartitionKey(value.pk);
  const match =
    /^AGENT#([a-z][a-z0-9]*(?:_[a-z0-9]+)*)#([a-z][a-z0-9-]{0,63})#([a-z][a-z0-9-]{0,63})$/
      .exec(value.sk);
  if (!match || (domainId !== undefined && match[1] !== domainId)) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  return {
    entityType: stringAttribute("ENTITLEMENT"),
    pk: stringAttribute(value.pk),
    sk: stringAttribute(value.sk),
  };
}

function parseEntitlementInventoryLastKey(value, domainId) {
  if (value === undefined) return null;
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 3
    || nativeString(value, "entityType") !== "ENTITLEMENT"
  ) {
    fail("MALFORMED_DYNAMODB_RESPONSE", "DynamoDB cursor is malformed.");
  }
  const cursor = {
    pk: nativeString(value, "pk"),
    sk: nativeString(value, "sk"),
  };
  try {
    validateEntitlementInventoryCursor(cursor, domainId);
  } catch {
    fail("MALFORMED_DYNAMODB_RESPONSE", "DynamoDB cursor is malformed.");
  }
  return cursor;
}

function validateGetInput(input, allowedKeys, requiredKeys, scopeCode) {
  if (!isPlainObject(input)) fail(scopeCode, "Read scope is malformed.");
  const keys = Object.keys(input);
  if (
    keys.some((key) => !allowedKeys.has(key))
    || [...requiredKeys].some((key) => !Object.hasOwn(input, key))
  ) {
    fail(scopeCode, "Read scope is malformed.");
  }
  return validateAbortSignal(input.abortSignal);
}

function projectMemberFingerprint(memberSubjects) {
  return createHash("sha256")
    .update(JSON.stringify(memberSubjects))
    .digest("hex");
}

function projectMemberCursor({
  domainId,
  projectId,
  offset,
  fingerprint,
}) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      domainId,
      projectId,
      offset,
      fingerprint,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeProjectMemberCursor(
  value,
  {
    domainId,
    projectId,
  },
) {
  if (value === undefined) return null;
  if (
    typeof value !== "string"
    || !PROJECT_MEMBER_CURSOR_PATTERN.test(value)
  ) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  let decoded;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
    }
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    if (error instanceof WorkspaceStateError) throw error;
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  if (
    !hasExactKeys(decoded, PROJECT_MEMBER_CURSOR_KEYS)
    || decoded.v !== 1
    || decoded.domainId !== domainId
    || decoded.projectId !== projectId
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset < 1
    || !FINGERPRINT_PATTERN.test(decoded.fingerprint)
  ) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  return decoded;
}

function projectMemberCursorOffset(cursor, memberSubjects) {
  if (cursor === null) return 0;
  if (
    cursor.offset >= memberSubjects.length
    || cursor.fingerprint
      !== projectMemberFingerprint(memberSubjects)
  ) {
    fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
  }
  return cursor.offset;
}

export function createWorkspaceState({ tableName, dynamo, now }) {
  if (
    typeof tableName !== "string"
    || tableName.length === 0
    || tableName.length > 255
    || !dynamo
    || typeof dynamo.send !== "function"
    || typeof now !== "function"
  ) {
    throw new TypeError("Workspace state configuration is malformed.");
  }
  const transactionClocks = new WeakMap();

  function beginTransaction() {
    const clock = Object.freeze(clockSnapshot(now));
    transactionClocks.set(clock, clock);
    return clock;
  }

  function consumeTransaction(input, standardKeys, transactionalKeys, code) {
    if (hasExactKeys(input, standardKeys)) return clockSnapshot(now);
    if (!hasExactKeys(input, transactionalKeys)) {
      fail(code, "Entity write is malformed.");
    }
    const transaction = input.transaction;
    if (
      transaction === null
      || typeof transaction !== "object"
      || !transactionClocks.has(transaction)
    ) {
      fail("INVALID_TRANSACTION", "Transaction clock is invalid.");
    }
    const clock = transactionClocks.get(transaction);
    transactionClocks.delete(transaction);
    return clock;
  }

  function mutationConflict() {
    fail("MUTATION_CONFLICT", "Mutation request conflicted.");
  }

  async function readReplayItem(key, parser) {
    let response;
    try {
      response = await dynamo.send(
        new GetItemCommand({
          TableName: tableName,
          Key: key,
          ConsistentRead: true,
        }),
      );
      validateDynamoResponse(response);
    } catch (error) {
      if (error instanceof WorkspaceStateError) mutationConflict();
      throw error;
    }
    if (response.Item === undefined) mutationConflict();
    try {
      return parseStored(parser, response.Item);
    } catch (error) {
      if (error instanceof WorkspaceStateError) mutationConflict();
      throw error;
    }
  }

  async function replayMutation({
    mutation,
    clock,
    entityItem,
    parser,
    expectedRecord,
  }) {
    const storedMutation = await readReplayItem(
      {
        pk: stringAttribute(`MUTATION#${mutation.actor}`),
        sk: stringAttribute(
          `MUTATION#${mutation.route}#${mutation.requestId}`,
        ),
      },
      (item) => mutationFromItem(item, clock),
    );
    if (!isDeepStrictEqual(storedMutation, mutation)) mutationConflict();
    const authoritative = await readReplayItem(
      {
        pk: entityItem.pk,
        sk: entityItem.sk,
      },
      parser,
    );
    if (
      expectedRecord !== undefined
      && !isDeepStrictEqual(authoritative, expectedRecord)
    ) {
      mutationConflict();
    }
    return authoritative;
  }

  function prepareEntityWrite(input, specification, clock) {
    const hasExpectedRecord =
      isPlainObject(input) && Object.hasOwn(input, "expectedRecord");
    if (
      !hasExactKeys(
        input,
        hasExpectedRecord
          ? ENTITLEMENT_RENEWAL_WRITE_KEYS
          : WRITE_KEYS,
      )
    ) {
      fail(specification.invalidCode, "Entity write is malformed.");
    }
    const record = specification.validate(input.record);
    const operation = validateExpectedStatus(
      input.expectedStatus,
      specification.statuses,
      specification.initialStatuses,
      specification.transitions,
      record,
      specification.transitionCode,
    );
    validateTransactionTimestamps(
      specification.entityType,
      record,
      operation,
      input.expectedStatus,
      clock,
      specification.invalidCode,
    );
    const resourceKey = specification.resourceKey(record);
    const mutation = validateMutation(input.mutation, clock, {
      entityType: specification.entityType,
      resourceKey,
      operation,
      resultStatus: (
        specification.entityType === "AGENT"
        && record.status === "TEST_FAILED"
      )
        ? "FAILED"
        : "SUCCEEDED",
    });
    const requiredActor = actorForMutation(
      specification.entityType,
      record,
      operation,
    );
    if (requiredActor !== null && mutation.actor !== requiredActor) {
      fail("ACTOR_MISMATCH", "Mutation actor does not match the resource.");
    }
    validateMutationBinding(
      specification.entityType,
      record,
      mutation,
      operation,
    );
    const isEntitlementRenewal =
      specification.entityType === "ENTITLEMENT"
      && operation === "UPDATE"
      && record.status === "ACTIVE";
    if (hasExpectedRecord !== isEntitlementRenewal) {
      fail(
        specification.invalidCode,
        "Entitlement renewal evidence is malformed.",
      );
    }
    let expectedRecord;
    if (hasExpectedRecord) {
      expectedRecord = specification.validate(input.expectedRecord);
      if (
        expectedRecord.status !== input.expectedStatus
        || specification.resourceKey(expectedRecord) !== resourceKey
      ) {
        fail(
          specification.invalidCode,
          "Entitlement renewal evidence is malformed.",
        );
      }
    }
    return {
      record,
      mutation,
      audit: mutationToAudit(mutation),
      entityItem: specification.toItem(record),
      parser: specification.fromItem,
      expectedRecord,
    };
  }

  async function putEntity(input, specification) {
    const hasExpectedRecord =
      isPlainObject(input) && Object.hasOwn(input, "expectedRecord");
    const clock = consumeTransaction(
      input,
      hasExpectedRecord
        ? ENTITLEMENT_RENEWAL_WRITE_KEYS
        : WRITE_KEYS,
      hasExpectedRecord
        ? TRANSACTIONAL_ENTITLEMENT_RENEWAL_WRITE_KEYS
        : TRANSACTIONAL_WRITE_KEYS,
      specification.invalidCode,
    );
    const prepared = prepareEntityWrite(
      {
        record: input.record,
        mutation: input.mutation,
        expectedStatus: input.expectedStatus,
        ...(hasExpectedRecord
          ? { expectedRecord: input.expectedRecord }
          : {}),
      },
      specification,
      clock,
    );
    try {
      const response = await dynamo.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: prepared.entityItem,
                ...entityCondition(
                  specification,
                  prepared.record,
                  input.expectedStatus,
                  prepared.expectedRecord,
                ),
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: auditToItem(prepared.audit),
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: mutationToItem(prepared.mutation),
                ...mutationCondition(),
              },
            },
          ],
        }),
      );
      validateDynamoResponse(response);
    } catch (error) {
      if (isConditionalTransactionConflict(error, 3)) {
        return replayMutation({
          mutation: prepared.mutation,
          clock,
          entityItem: prepared.entityItem,
          parser: prepared.parser,
          expectedRecord: prepared.record,
        });
      }
      throw error;
    }
    return prepared.record;
  }

  async function queryPartition({
    input,
    partitionKey,
    parser,
    allowedKeys,
    requiredKeys,
    scopeCode,
    sortKeyPrefix,
    filter,
  }) {
    const options = validateReadInput(input, {
      allowedKeys,
      requiredKeys,
      scopeCode,
      partitionKey,
      sortKeyPrefix,
    });
    const expressionAttributeNames = { "#pk": "pk" };
    const expressionAttributeValues = {
      ":pk": stringAttribute(partitionKey),
    };
    if (sortKeyPrefix) {
      expressionAttributeNames["#sk"] = "sk";
      expressionAttributeValues[":skPrefix"] = stringAttribute(sortKeyPrefix);
    }
    if (filter) {
      expressionAttributeNames[filter.nameToken] = filter.name;
      expressionAttributeValues[filter.valueToken] =
        stringAttribute(filter.value);
    }
    const items = [];
    let exclusiveStartKey = options.exclusiveStartKey;
    let previousCursor = exclusiveStartKey
      ? `${nativeString(exclusiveStartKey, "pk")}\u0000`
        + nativeString(exclusiveStartKey, "sk")
      : null;
    while (true) {
      const response = await dynamo.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: sortKeyPrefix
            ? "#pk = :pk AND begins_with(#sk, :skPrefix)"
            : "#pk = :pk",
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ConsistentRead: true,
          ScanIndexForward: true,
          Limit: options.limit - items.length,
          ...(filter ? { FilterExpression: filter.expression } : {}),
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
        options.abortSignal
          ? { abortSignal: options.abortSignal }
          : undefined,
      );
      const page = parseQueryPage(
        response,
        parser,
        partitionKey,
        sortKeyPrefix,
      );
      if (items.length + page.items.length > options.limit) {
        fail(
          "MALFORMED_DYNAMODB_RESPONSE",
          "DynamoDB page is malformed.",
        );
      }
      items.push(...page.items);
      if (page.cursor !== null) {
        const nextCursor = `${page.cursor.pk}\u0000${page.cursor.sk}`;
        if (nextCursor === previousCursor) {
          fail(
            "MALFORMED_DYNAMODB_RESPONSE",
            "DynamoDB cursor is malformed.",
          );
        }
        previousCursor = nextCursor;
      }
      if (
        filter === undefined
        || page.cursor === null
        || items.length === options.limit
      ) {
        return { items, cursor: page.cursor };
      }
      exclusiveStartKey = {
        pk: stringAttribute(page.cursor.pk),
        sk: stringAttribute(page.cursor.sk),
      };
    }
  }

  async function getItem({
    input,
    pk,
    sk,
    parser,
    allowedKeys,
    requiredKeys,
    scopeCode,
  }) {
    const abortSignal = validateGetInput(
      input,
      allowedKeys,
      requiredKeys,
      scopeCode,
    );
    const response = await dynamo.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          pk: stringAttribute(pk),
          sk: stringAttribute(sk),
        },
        ConsistentRead: true,
      }),
      abortSignal ? { abortSignal } : undefined,
    );
    validateDynamoResponse(response);
    if (response.Item === undefined) return null;
    return parseStored(parser, response.Item);
  }

  async function projectForMembership({
    domainId,
    projectId,
    abortSignal,
  }) {
    const record = await getItem({
      input: {
        domainId,
        projectId,
        ...(abortSignal === undefined ? {} : { abortSignal }),
      },
      pk: `PROJECT#${domainId}`,
      sk: `PROJECT#${projectId}`,
      parser: projectFromItem,
      allowedKeys: PROJECT_MEMBER_GET_KEYS,
      requiredKeys: PROJECT_MEMBER_REQUIRED_KEYS,
      scopeCode: "INVALID_PROJECT_SCOPE",
    });
    if (record === null) {
      fail("NOT_FOUND", "Project was not found.");
    }
    if (record.status !== "ACTIVE") {
      fail(
        "CONFLICT",
        "Project state does not permit membership changes.",
      );
    }
    return record;
  }

  function validateProjectMemberMutation(input) {
    if (
      !isPlainObject(input)
      || Object.keys(input).some(
        (key) => !PROJECT_MEMBER_MUTATION_KEYS.has(key),
      )
      || !Object.hasOwn(input, "domainId")
      || !Object.hasOwn(input, "projectId")
      || !Object.hasOwn(input, "subject")
    ) {
      fail(
        "INVALID_PROJECT_MEMBERSHIP",
        "Project membership mutation is malformed.",
      );
    }
    return {
      domainId: validateDomainId(
        input.domainId,
        "INVALID_PROJECT_MEMBERSHIP",
      ),
      projectId: validateSlug(
        input.projectId,
        "INVALID_PROJECT_MEMBERSHIP",
        "Project ID",
      ),
      subject: validateSubject(
        input.subject,
        "INVALID_PROJECT_MEMBERSHIP",
      ),
      abortSignal: validateAbortSignal(input.abortSignal),
    };
  }

  async function mutateProjectMember(input, operation) {
    const scope = validateProjectMemberMutation(input);
    const record = await projectForMembership(scope);
    const present = record.memberSubjects.includes(scope.subject);
    if (
      (operation === "ADD" && present)
      || (operation === "REMOVE" && !present)
    ) {
      return { changed: false };
    }
    if (
      operation === "ADD"
      && record.memberSubjects.length >= MAX_PAGE_SIZE
    ) {
      fail(
        "CONFLICT",
        "Project membership limit has been reached.",
      );
    }
    const nextMemberSubjects = operation === "ADD"
      ? [...record.memberSubjects, scope.subject].sort()
      : record.memberSubjects.filter(
        (subject) => subject !== scope.subject,
      );
    const names = {
      "#entityType": "entityType",
      "#domainId": "domainId",
      "#id": "id",
      "#status": "status",
      "#ownerSubject": "ownerSubject",
      "#createdBySubject": "createdBySubject",
      "#createdAt": "createdAt",
      "#memberSubjects": "memberSubjects",
    };
    const values = {
      ":entityType": stringAttribute("PROJECT"),
      ":domainId": stringAttribute(record.domainId),
      ":projectId": stringAttribute(record.id),
      ":expectedStatus": stringAttribute(record.status),
      ":ownerSubject": stringAttribute(record.ownerSubject),
      ":createdBySubject": stringAttribute(record.createdBySubject),
      ":createdAt": stringAttribute(record.createdAt),
      ":expectedMemberSubjects":
        stringListAttribute(record.memberSubjects),
      ":nextMemberSubjects": stringListAttribute(nextMemberSubjects),
    };
    try {
      const response = await dynamo.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: {
            pk: stringAttribute(`PROJECT#${record.domainId}`),
            sk: stringAttribute(`PROJECT#${record.id}`),
          },
          UpdateExpression:
            "SET #memberSubjects = :nextMemberSubjects",
          ConditionExpression:
            "#entityType = :entityType "
            + "AND #domainId = :domainId "
            + "AND #id = :projectId "
            + "AND #status = :expectedStatus "
            + "AND #ownerSubject = :ownerSubject "
            + "AND #createdBySubject = :createdBySubject "
            + "AND #createdAt = :createdAt "
            + "AND #memberSubjects = :expectedMemberSubjects",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "NONE",
        }),
        scope.abortSignal
          ? { abortSignal: scope.abortSignal }
          : undefined,
      );
      validateDynamoResponse(response);
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") {
        fail(
          "MUTATION_CONFLICT",
          "Project membership mutation conflicted.",
        );
      }
      throw error;
    }
    return { changed: true };
  }

  const projectSpecification = {
    invalidCode: "INVALID_PROJECT",
    transitionCode: "INVALID_PROJECT_TRANSITION",
    entityType: "PROJECT",
    validate: validateProject,
    toItem: projectToItem,
    fromItem: projectFromItem,
    resourceKey: projectResourceKey,
    statuses: PROJECT_STATUSES,
    initialStatuses: new Set(["ACTIVE"]),
    transitions: PROJECT_TRANSITIONS,
    immutableFields: [
      "domainId",
      "id",
      "ownerSubject",
      "createdBySubject",
      "createdAt",
    ],
  };
  const agentSpecification = {
    invalidCode: "INVALID_AGENT",
    transitionCode: "INVALID_AGENT_TRANSITION",
    entityType: "AGENT",
    validate: validateAgent,
    toItem: agentToItem,
    fromItem: agentFromItem,
    resourceKey: agentResourceKey,
    statuses: AGENT_STATUSES,
    initialStatuses: new Set(["DRAFT"]),
    transitions: AGENT_TRANSITIONS,
    immutableFields: [
      "domainId",
      "projectId",
      "id",
      "ownerSubject",
      "createdBySubject",
      "createdAt",
    ],
  };
  const deploymentSpecification = {
    invalidCode: "INVALID_DEPLOYMENT",
    transitionCode: "INVALID_DEPLOYMENT_TRANSITION",
    entityType: "DEPLOYMENT",
    validate: validateDeployment,
    toItem: deploymentToItem,
    fromItem: deploymentFromItem,
    resourceKey: deploymentResourceKey,
    statuses: DEPLOYMENT_STATUSES,
    initialStatuses: (record) =>
      record.environment === "PRODUCTION"
        ? record.status === "REQUESTED"
        : record.status === "DEPLOYING",
    transitions: DEPLOYMENT_TRANSITIONS,
    immutableFields: [
      "domainId",
      "projectId",
      "id",
      "agentId",
      "environment",
      "requesterSubject",
      "requestedAt",
    ],
    immutableFieldsForStatus: (expectedStatus) =>
      expectedStatus === "REQUESTED"
        ? []
        : ["approverSubject", "decisionReason", "decidedAt"],
  };
  const approvalSpecification = {
    invalidCode: "INVALID_APPROVAL",
    transitionCode: "INVALID_APPROVAL_TRANSITION",
    entityType: "APPROVAL",
    validate: validateApproval,
    toItem: approvalToItem,
    fromItem: approvalFromItem,
    resourceKey: approvalResourceKey,
    statuses: APPROVAL_STATUSES,
    initialStatuses: new Set(["PENDING"]),
    transitions: APPROVAL_TRANSITIONS,
    immutableFields: [
      "domainId",
      "id",
      "kind",
      "resourceType",
      "resourceId",
      "projectId",
      "requesterSubject",
      "requestedAt",
    ],
    immutableFieldsForStatus: (expectedStatus, record) => [
      ...(Object.hasOwn(record, "recordVersion") ? PUBLICATION_BINDING_KEYS : []),
      ...(expectedStatus === "PENDING" ? [] : ["approverSubject", "reason", "decidedAt"]),
    ],
  };
  const grantSpecification = {
    invalidCode: "INVALID_RESOURCE_GRANT",
    transitionCode: "INVALID_RESOURCE_GRANT_TRANSITION",
    entityType: "RESOURCE_GRANT",
    validate: validateResourceGrant,
    toItem: resourceGrantToItem,
    fromItem: resourceGrantFromItem,
    resourceKey: grantResourceKey,
    statuses: GRANT_STATUSES,
    initialStatuses: new Set(["ACTIVE"]),
    transitions: GRANT_TRANSITIONS,
    immutableFields: [
      "domainId",
      "resourceType",
      "resourceId",
      "grantedBySubject",
      "grantedAt",
    ],
  };
  const entitlementSpecification = {
    invalidCode: "INVALID_ENTITLEMENT",
    transitionCode: "INVALID_ENTITLEMENT_TRANSITION",
    entityType: "ENTITLEMENT",
    validate: validateEntitlement,
    toItem: entitlementToItem,
    fromItem: entitlementFromItem,
    resourceKey: entitlementResourceKey,
    statuses: ENTITLEMENT_STATUSES,
    initialStatuses: new Set(["ACTIVE"]),
    transitions: ENTITLEMENT_TRANSITIONS,
    immutableFields: [
      "subject",
      "domainId",
      "projectId",
      "agentId",
    ],
    immutableFieldsForStatus: (_expectedStatus, record) =>
      record.status === "REVOKED"
        ? ["grantedBySubject", "grantedAt"]
        : [],
  };

  async function putAccessDecision(input) {
    const isGrant = hasExactKeys(input, ACCESS_DECISION_GRANT_KEYS);
    const isEntitlement = hasExactKeys(
      input,
      ACCESS_DECISION_ENTITLEMENT_KEYS,
    );
    if (isGrant === isEntitlement) {
      fail("INVALID_APPROVAL", "Access decision write is malformed.");
    }
    const clock = consumeTransaction(
      input,
      NO_KEYS,
      isGrant
        ? ACCESS_DECISION_GRANT_KEYS
        : ACCESS_DECISION_ENTITLEMENT_KEYS,
      "INVALID_APPROVAL",
    );
    const approval = prepareEntityWrite(
      input.approval,
      approvalSpecification,
      clock,
    );
    const accessSpecification = isGrant
      ? grantSpecification
      : entitlementSpecification;
    const access = prepareEntityWrite(
      isGrant ? input.grant : input.entitlement,
      accessSpecification,
      clock,
    );
    const approvalRequestSuffix = ".approval";
    if (!approval.mutation.requestId.endsWith(approvalRequestSuffix)) {
      fail("INVALID_APPROVAL", "Access decision write is malformed.");
    }
    const requestId = approval.mutation.requestId.slice(
      0,
      -approvalRequestSuffix.length,
    );
    const expectedAccessRequestId =
      `${requestId}.${isGrant ? "grant" : "entitlement"}`;
    if (
      approval.record.status !== "APPROVED"
      || approval.record.approverSubject !== access.mutation.actor
      || access.record.status !== "ACTIVE"
      || approval.mutation.actor !== access.mutation.actor
      || approval.mutation.route !== access.mutation.route
      || approval.mutation.domainId !== access.mutation.domainId
      || approval.mutation.payloadFingerprint
        !== access.mutation.payloadFingerprint
      || approval.mutation.decision !== "approve"
      || access.mutation.decision !== "grant"
      || approval.mutation.reason !== access.mutation.reason
      || access.mutation.requestId !== expectedAccessRequestId
    ) {
      fail("INVALID_APPROVAL", "Access decision write is malformed.");
    }
    if (
      isGrant
      && (
        approval.record.domainId !== access.record.domainId
        || approval.record.resourceType !== access.record.resourceType
        || approval.record.resourceId !== access.record.resourceId
      )
    ) {
      fail("INVALID_APPROVAL", "Access decision write is malformed.");
    }
    if (
      isEntitlement
      && (
        approval.record.requesterSubject !== access.record.subject
        || approval.record.domainId !== access.record.domainId
        || approval.record.projectId !== access.record.projectId
        || approval.record.resourceId !== access.record.agentId
      )
    ) {
      fail("INVALID_APPROVAL", "Access decision write is malformed.");
    }
    const writes = [
      [approval, approvalSpecification, input.approval.expectedStatus],
      [
        access,
        accessSpecification,
        isGrant
          ? input.grant.expectedStatus
          : input.entitlement.expectedStatus,
      ],
    ];
    try {
      const response = await dynamo.send(
        new TransactWriteItemsCommand({
          TransactItems: writes.flatMap(
            ([prepared, specification, expectedStatus]) => [
              {
                Put: {
                  TableName: tableName,
                  Item: prepared.entityItem,
                  ...entityCondition(
                    specification,
                    prepared.record,
                    expectedStatus,
                  ),
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: auditToItem(prepared.audit),
                  ConditionExpression:
                    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: mutationToItem(prepared.mutation),
                  ...mutationCondition(),
                },
              },
            ],
          ),
        }),
      );
      validateDynamoResponse(response);
    } catch (error) {
      if (isConditionalTransactionConflict(error, 6)) {
        const [replayedApproval, replayedAccess] = await Promise.all(
          writes.map(([prepared]) =>
            replayMutation({
              mutation: prepared.mutation,
              clock,
              entityItem: prepared.entityItem,
              parser: prepared.parser,
              expectedRecord: prepared.record,
            })),
        );
        return {
          approval: replayedApproval,
          ...(isGrant
            ? { grant: replayedAccess }
            : { entitlement: replayedAccess }),
        };
      }
      throw error;
    }
    return {
      approval: approval.record,
      ...(isGrant
        ? { grant: access.record }
        : { entitlement: access.record }),
    };
  }
  const sessionSpecification = {
    invalidCode: "INVALID_SESSION",
    transitionCode: "INVALID_SESSION_TRANSITION",
    entityType: "SESSION",
    validate: validateSession,
    toItem: sessionToItem,
    fromItem: sessionFromItem,
    resourceKey: sessionResourceKey,
    statuses: SESSION_STATUSES,
    initialStatuses: new Set(["ACTIVE"]),
    transitions: SESSION_TRANSITIONS,
    immutableFields: [
      "actor",
      "id",
      "agentId",
      "domainId",
      "projectId",
      "createdAt",
    ],
  };
  const incidentSpecification = {
    invalidCode: "INVALID_INCIDENT",
    transitionCode: "INVALID_INCIDENT_TRANSITION",
    entityType: "INCIDENT",
    validate: validateIncident,
    toItem: incidentToItem,
    fromItem: incidentFromItem,
    resourceKey: incidentResourceKey,
    statuses: INCIDENT_STATUSES,
    initialStatuses: new Set(["OPEN"]),
    transitions: INCIDENT_TRANSITIONS,
    immutableFields: [
      "domainId",
      "projectId",
      "id",
      "ownerSubject",
      "reporterSubject",
      "createdAt",
    ],
    immutableFieldsForStatus: (expectedStatus) => ({
      OPEN: ["reopenedBySubject", "reopenedAt"],
      ACKNOWLEDGED: [
        "acknowledgedBySubject",
        "acknowledgedAt",
        "reopenedBySubject",
        "reopenedAt",
      ],
    }[expectedStatus] ?? []),
  };
  const breakGlassSpecification = {
    invalidCode: "INVALID_BREAK_GLASS",
    transitionCode: "INVALID_BREAK_GLASS_TRANSITION",
    entityType: "BREAK_GLASS",
    validate: validateBreakGlass,
    toItem: breakGlassToItem,
    fromItem: breakGlassFromItem,
    resourceKey: breakGlassResourceKey,
    statuses: BREAK_GLASS_STATUSES,
    initialStatuses: new Set(["REQUESTED"]),
    transitions: BREAK_GLASS_TRANSITIONS,
    immutableFields: [
      "id",
      "domainId",
      "projectId",
      "resource",
      "action",
      "requesterSubject",
      "reason",
      "requestedAt",
      "expiresAt",
    ],
    immutableFieldsForStatus: (expectedStatus) => ({
      APPROVED: [
        "approverSubject",
        "decisionReason",
        "decidedAt",
      ],
      ACTIVE: [
        "approverSubject",
        "decisionReason",
        "decidedAt",
        "activatedBySubject",
        "activationReason",
        "activatedAt",
      ],
    }[expectedStatus] ?? []),
  };

  return {
    readHitlPolicyCatalog: createHitlCatalogReader({ tableName, dynamo }),
    async replaceHitlPolicyCatalog(input) {
      const keys = new Set(['catalog','expectedCatalog','mutation']);
      const clock = consumeTransaction(input, keys, new Set([...keys,'transaction']), 'INVALID_HITL_POLICY');
      const catalog = validateHitlCatalog(input.catalog, 'platform');
      const expected = validateHitlCatalog(input.expectedCatalog, 'platform');
      if (catalog.revision !== expected.revision + 1 || catalog.updatedAt !== clock.timestamp) mutationConflict();
      const mutation = validateMutation(input.mutation, clock, {entityType:'HITL_POLICY',resultStatus:'SUCCEEDED'});
      if (mutation.effectiveRole !== 'admin' || mutation.domainId !== 'platform' || mutation.projectId !== null
        || mutation.actor !== mutation.requesterSubject || mutation.route !== 'POST /api/governance/policy-drafts'
        || mutation.decision !== 'save_draft') mutationConflict();
      const id = mutation.result.resourceKey.replace(/^hitl-policy\/platform\//,'');
      const before = expected.policies.find(p=>p.id===id), after = catalog.policies.find(p=>p.id===id);
      if (!after || after.enabled !== false || (before && (before.enabled !== false || after.version !== before.version+1 || after.createdAt !== before.createdAt))
        || (!before && (after.version !== 1 || after.createdAt !== clock.timestamp))
        || mutation.result.operation !== (before?'UPDATE':'CREATE')
        || JSON.stringify(expected.policies.filter(p=>p.id!==id)) !== JSON.stringify(catalog.policies.filter(p=>p.id!==id))
        || (before && expected.policies.findIndex(p=>p.id===id)!==catalog.policies.findIndex(p=>p.id===id))
        || (!before && catalog.policies.at(-1)?.id!==id)) mutationConflict();
      const audit = mutationToAudit(mutation);
      try {
        const response = await dynamo.send(new TransactWriteItemsCommand({TransactItems:[
          {Put:{TableName:tableName,Item:buildHitlCatalogItem(catalog),ConditionExpression:'#document = :expected',ExpressionAttributeNames:{'#document':'document'},ExpressionAttributeValues:{':expected':{S:JSON.stringify(expected)}}}},
          {Put:{TableName:tableName,Item:auditToItem(audit),ConditionExpression:'attribute_not_exists(pk) AND attribute_not_exists(sk)'}},
          {Put:{TableName:tableName,Item:mutationToItem(mutation),...mutationCondition()}},
        ]}));
        validateDynamoResponse(response);
      } catch (error) {if(isConditionalTransactionConflict(error,3))mutationConflict();throw error;}
      return catalog;
    },
    readAlertPolicyCatalog: createAlertCatalogReader({tableName,dynamo}),
    async replaceAlertPolicyCatalog(input) {
      const keys = new Set(['catalog','expectedCatalog','mutation']);
      const clock = consumeTransaction(input, keys, new Set([...keys,'transaction']), 'INVALID_ALERT_POLICY');
      const catalog = validateAlertCatalog(input.catalog, 'platform');
      const expected = input.expectedCatalog === null ? null : validateAlertCatalog(input.expectedCatalog);
      if (catalog.revision !== (expected?.revision ?? 0) + 1 || catalog.updatedAt !== clock.timestamp) mutationConflict();
      const mutation = validateMutation(input.mutation, clock, {entityType:'ALERT_POLICY',resultStatus:'SUCCEEDED'});
      if (mutation.effectiveRole !== 'admin' || mutation.domainId !== 'platform' || mutation.projectId !== null
        || mutation.actor !== mutation.requesterSubject || mutation.route !== 'POST /api/governance/alert-drafts'
        || mutation.decision !== 'save_draft') mutationConflict();
      const id = mutation.result.resourceKey.replace(/^alert-policy\/platform\//,'');
      const before = (expected?.policies??[]).find(p=>p.id===id), after = catalog.policies.find(p=>p.id===id);
      if (!after || after.enabled !== false || (before && (before.enabled !== false || after.version !== before.version+1 || after.createdAt !== before.createdAt))
        || (!before && (after.version !== 1 || after.createdAt !== clock.timestamp))
        || mutation.result.operation !== (before?'UPDATE':'CREATE')
        || JSON.stringify((expected?.policies??[]).filter(p=>p.id!==id)) !== JSON.stringify(catalog.policies.filter(p=>p.id!==id))
        || (before && expected.policies.findIndex(p=>p.id===id)!==catalog.policies.findIndex(p=>p.id===id))
        || (!before && catalog.policies.at(-1)?.id!==id)) mutationConflict();
      const audit = mutationToAudit(mutation);
      try {
        const response = await dynamo.send(new TransactWriteItemsCommand({TransactItems:[
          {Put:{TableName:tableName,Item:buildAlertCatalogItem(catalog),...(expected?{ConditionExpression:'#document = :expected',ExpressionAttributeNames:{'#document':'document'},ExpressionAttributeValues:{':expected':{S:JSON.stringify(expected)}}}:{ConditionExpression:'attribute_not_exists(pk) AND attribute_not_exists(sk)'})}},
          {Put:{TableName:tableName,Item:auditToItem(audit),ConditionExpression:'attribute_not_exists(pk) AND attribute_not_exists(sk)'}},
          {Put:{TableName:tableName,Item:mutationToItem(mutation),...mutationCondition()}},
        ]}));
        validateDynamoResponse(response);
      } catch (error) {if(isConditionalTransactionConflict(error,3))mutationConflict();throw error;}
      return catalog;
    },
    beginTransaction,
    async claimMutation(input) {
      const clock = clockSnapshot(now);
      const claim = validateMutationClaim(input, clock);
      const item = mutationClaimToItem(claim);
      try {
        const response = await dynamo.send(
          new PutItemCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression:
              "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
            ExpressionAttributeNames: {
              "#pk": "pk",
              "#sk": "sk",
            },
          }),
        );
        validateDynamoResponse(response);
        return true;
      } catch (error) {
        if (error?.name !== "ConditionalCheckFailedException") throw error;
      }

      const response = await dynamo.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            pk: item.pk,
            sk: item.sk,
          },
          ConsistentRead: true,
        }),
      );
      validateDynamoResponse(response);
      if (response.Item === undefined) mutationConflict();
      const stored = parseStored(mutationClaimFromItem, response.Item);
      const expected = Object.fromEntries(
        [...MUTATION_CLAIM_KEYS].map((key) => [key, claim[key]]),
      );
      const actual = Object.fromEntries(
        [...MUTATION_CLAIM_KEYS].map((key) => [key, stored[key]]),
      );
      if (!isDeepStrictEqual(actual, expected)) {
        mutationConflict();
      }
      fail(
        "MUTATION_IN_PROGRESS",
        "Mutation request is already in progress.",
      );
    },
    async putProject(input) {
      return putEntity(input, projectSpecification);
    },
    async putAgent(input) {
      return putEntity(input, agentSpecification);
    },
    async putDeployment(input) {
      return putEntity(input, deploymentSpecification);
    },
    // Serialize the external Registry decision with the persisted approval.
    // No expiry: an uncertain external write must be retried with the same key,
    // never stolen by another reviewer while reconciliation is outstanding.
    async reserveApprovalDecision(input) {
      if (!isPlainObject(input) || Object.keys(input).sort().join(',') !== 'actor,approvalId,domainId,fingerprint,requestId'
        || !DOMAIN_ID_PATTERN.test(input.domainId) || !SLUG_PATTERN.test(input.approvalId)
        || !SUBJECT_PATTERN.test(input.actor) || !REQUEST_ID_PATTERN.test(input.requestId)
        || !FINGERPRINT_PATTERN.test(input.fingerprint)) fail("MUTATION_CONFLICT", "Invalid approval reservation.");
      const Item = { pk: { S: `MUTATION#approval-decision/${input.domainId}` }, sk: { S: `DECISION#${input.approvalId}` },
        actor: { S: input.actor }, requestId: { S: input.requestId }, fingerprint: { S: input.fingerprint } };
      try {
        validateDynamoResponse(await dynamo.send(new PutItemCommand({ TableName: tableName, Item,
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" })));
        return true;
      } catch (error) { if (error?.name !== "ConditionalCheckFailedException") throw error; }
      const response = await dynamo.send(new GetItemCommand({ TableName: tableName, Key: { pk: Item.pk, sk: Item.sk }, ConsistentRead: true }));
      validateDynamoResponse(response);
      if (!isDeepStrictEqual(response.Item, Item)) fail("MUTATION_CONFLICT", "Another review decision is in progress.");
      return true;
    },
    async putApproval(input) {
      return putEntity(input, approvalSpecification);
    },
    async putResourceGrant(input) {
      return putEntity(input, grantSpecification);
    },
    async putEntitlement(input) {
      return putEntity(input, entitlementSpecification);
    },
    putAccessDecision,
    async putSession(input) {
      return putEntity(input, sessionSpecification);
    },
    async putIncident(input) {
      return putEntity(input, incidentSpecification);
    },
    async putBreakGlass(input) {
      return putEntity(input, breakGlassSpecification);
    },
    async abortMutation(input) {
      const clock = consumeTransaction(
        input,
        ABORT_WRITE_KEYS,
        TRANSACTIONAL_ABORT_WRITE_KEYS,
        "INVALID_MUTATION",
      );
      const mutation = validateMutation(input.mutation, clock, {
        resultStatus: "FAILED",
      });
      if (mutation.decision !== "abort") {
        fail("INVALID_MUTATION", "Mutation abort is malformed.");
      }
      const audit = mutationToAudit(mutation);
      const auditItem = auditToItem(audit);
      try {
        const response = await dynamo.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: auditItem,
                  ConditionExpression:
                    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: mutationToItem(mutation),
                  ...mutationCondition(),
                },
              },
            ],
          }),
        );
        validateDynamoResponse(response);
      } catch (error) {
        if (isConditionalTransactionConflict(error, 2)) {
          await replayMutation({
            mutation,
            clock,
            entityItem: auditItem,
            parser: auditFromItem,
            expectedRecord: audit,
          });
          return mutation;
        }
        throw error;
      }
      return mutation;
    },
    async appendAudit(input) {
      const clock = consumeTransaction(
        input,
        AUDIT_WRITE_KEYS,
        TRANSACTIONAL_AUDIT_WRITE_KEYS,
        "INVALID_AUDIT",
      );
      const record = validateAudit(input.record);
      if (record.timestamp !== clock.timestamp) {
        fail("INVALID_AUDIT", "Audit timestamp does not match the transaction.");
      }
      const mutation = validateMutation(input.mutation, clock, {
        entityType: "WORKSPACE_AUDIT",
        resourceKey: auditResourceKey(record),
        operation: "APPEND",
        resultStatus: "SUCCEEDED",
      });
      validateAuditMutationBinding(record, mutation);
      const auditItem = auditToItem(record);
      try {
        const response = await dynamo.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: auditItem,
                  ConditionExpression:
                    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: mutationToItem(mutation),
                  ...mutationCondition(),
                },
              },
            ],
          }),
        );
        validateDynamoResponse(response);
      } catch (error) {
        if (isConditionalTransactionConflict(error, 2)) {
          return replayMutation({
            mutation,
            clock,
            entityItem: auditItem,
            parser: auditFromItem,
            expectedRecord: record,
          });
        }
        throw error;
      }
      return record;
    },
    async getDomainResourcePolicy({ domainId, abortSignal } = {}) {
      return readResourcePolicy(dynamo, tableName, domainId, { abortSignal });
    },
    async listProjects(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_PROJECT_SCOPE",
      );
      return queryPartition({
        input,
        partitionKey: `PROJECT#${domainId}`,
        sortKeyPrefix: "PROJECT#",
        parser: projectFromItem,
        allowedKeys: new Set([
          "domainId",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId"]),
        scopeCode: "INVALID_PROJECT_SCOPE",
      });
    },
    async listProjectMemberSubjects(input) {
      if (
        !isPlainObject(input)
        || Object.keys(input).some(
          (key) => !PROJECT_MEMBER_LIST_KEYS.has(key),
        )
        || !Object.hasOwn(input, "domainId")
        || !Object.hasOwn(input, "projectId")
      ) {
        fail(
          "INVALID_PROJECT_SCOPE",
          "Project membership scope is malformed.",
        );
      }
      const domainId = validateDomainId(
        input.domainId,
        "INVALID_PROJECT_SCOPE",
      );
      const projectId = validateSlug(
        input.projectId,
        "INVALID_PROJECT_SCOPE",
        "Project ID",
      );
      const limit = input.limit === undefined ? 50 : input.limit;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAX_PAGE_SIZE
      ) {
        fail("INVALID_READ_OPTIONS", "Read limit is malformed.");
      }
      const abortSignal = validateAbortSignal(input.abortSignal);
      const decodedCursor = decodeProjectMemberCursor(input.cursor, {
        domainId,
        projectId,
      });
      const record = await projectForMembership({
        domainId,
        projectId,
        abortSignal,
      });
      const memberSubjects = [...record.memberSubjects].sort();
      const fingerprint = projectMemberFingerprint(memberSubjects);
      const offset = projectMemberCursorOffset(
        decodedCursor,
        memberSubjects,
      );
      const items = memberSubjects.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items,
        cursor: nextOffset < memberSubjects.length
          ? projectMemberCursor({
              domainId,
              projectId,
              offset: nextOffset,
              fingerprint,
            })
          : null,
      };
    },
    async addProjectMember(input) {
      return mutateProjectMember(input, "ADD");
    },
    async removeProjectMember(input) {
      return mutateProjectMember(input, "REMOVE");
    },
    async listAgents(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_AGENT_SCOPE",
      );
      const projectId = validateSlug(
        input?.projectId,
        "INVALID_AGENT_SCOPE",
        "Project ID",
      );
      const ownerSubject = input?.ownerSubject === undefined
        ? undefined
        : validateSubject(input.ownerSubject, "INVALID_AGENT_SCOPE");
      return queryPartition({
        input,
        partitionKey: `AGENT#${domainId}#${projectId}`,
        sortKeyPrefix: "AGENT#",
        parser: agentFromItem,
        allowedKeys: new Set([
          "domainId",
          "projectId",
          "ownerSubject",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId", "projectId"]),
        scopeCode: "INVALID_AGENT_SCOPE",
        filter: ownerSubject === undefined
          ? undefined
          : {
              nameToken: "#ownerSubject",
              name: "ownerSubject",
              valueToken: ":ownerSubject",
              value: ownerSubject,
              expression: "#ownerSubject = :ownerSubject",
            },
      });
    },
    async listDeployments(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_DEPLOYMENT_SCOPE",
      );
      const projectId = validateSlug(
        input?.projectId,
        "INVALID_DEPLOYMENT_SCOPE",
        "Project ID",
      );
      return queryPartition({
        input,
        partitionKey: `DEPLOYMENT#${domainId}#${projectId}`,
        sortKeyPrefix: "DEPLOYMENT#",
        parser: deploymentFromItem,
        allowedKeys: new Set([
          "domainId",
          "projectId",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId", "projectId"]),
        scopeCode: "INVALID_DEPLOYMENT_SCOPE",
      });
    },
    async listApprovals(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_APPROVAL_SCOPE",
      );
      return queryPartition({
        input,
        partitionKey: `APPROVAL#${domainId}`,
        sortKeyPrefix: "APPROVAL#",
        parser: approvalFromItem,
        allowedKeys: new Set([
          "domainId",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId"]),
        scopeCode: "INVALID_APPROVAL_SCOPE",
      });
    },
    async listAccessRequests(input = {}) {
      if (!isPlainObject(input)) {
        fail(
          "INVALID_APPROVAL_SCOPE",
          "Approval scope is malformed.",
        );
      }
      const allowedKeys = new Set([
        "requesterSubject",
        "limit",
        "cursor",
        "abortSignal",
      ]);
      if (
        Object.keys(input).some((key) => !allowedKeys.has(key))
        || !Object.hasOwn(input, "requesterSubject")
      ) {
        fail(
          "INVALID_APPROVAL_SCOPE",
          "Approval scope is malformed.",
        );
      }
      const requesterSubject = validateSubject(
        input.requesterSubject,
        "INVALID_APPROVAL_SCOPE",
      );
      const limit = input.limit === undefined ? 50 : input.limit;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAX_PAGE_SIZE
      ) {
        fail("INVALID_READ_OPTIONS", "Read limit is malformed.");
      }
      let exclusiveStartKey;
      if (input.cursor !== undefined) {
        if (
          !hasExactKeys(input.cursor, CURSOR_KEYS)
          || typeof input.cursor.pk !== "string"
          || input.cursor.pk.length === 0
          || input.cursor.pk.length > 1024
          || typeof input.cursor.sk !== "string"
          || input.cursor.sk.length === 0
          || input.cursor.sk.length > 1024
        ) {
          fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
        }
        exclusiveStartKey = {
          entityType: stringAttribute("APPROVAL"),
          pk: stringAttribute(input.cursor.pk),
          sk: stringAttribute(input.cursor.sk),
        };
      }
      const abortSignal = validateAbortSignal(input.abortSignal);
      const projectionNames = Object.fromEntries(
        [...APPROVAL_ITEM_KEYS].map(
          (key, index) => [`#approval${index}`, key],
        ),
      );
      const projectionExpression = Object.keys(projectionNames).join(", ");
      const expressionAttributeNames = {
        "#entityType": "entityType",
        "#requesterSubject": "requesterSubject",
        "#kind": "kind",
        "#resourceType": "resourceType",
        ...projectionNames,
      };
      const expressionAttributeValues = {
        ":approvalType": stringAttribute("APPROVAL"),
        ":requesterSubject": stringAttribute(requesterSubject),
        ":kind": stringAttribute("RESOURCE_ACCESS"),
        ":resourceType": stringAttribute("AGENT"),
      };
      const items = [];
      let previousCursor = exclusiveStartKey
        ? `${nativeString(exclusiveStartKey, "pk")}\u0000`
          + nativeString(exclusiveStartKey, "sk")
        : null;
      while (true) {
        const response = await dynamo.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "EntityTypeIndex",
            KeyConditionExpression: "#entityType = :approvalType",
            FilterExpression:
              "#requesterSubject = :requesterSubject AND "
              + "#kind = :kind AND #resourceType = :resourceType",
            ProjectionExpression: projectionExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            Limit: limit - items.length,
            ...(exclusiveStartKey
              ? { ExclusiveStartKey: exclusiveStartKey }
              : {}),
          }),
          abortSignal ? { abortSignal } : undefined,
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
        const pageItems = (response.Items ?? []).map((item) =>
          parseStored(approvalFromItem, item));
        if (items.length + pageItems.length > limit) {
          fail(
            "MALFORMED_DYNAMODB_RESPONSE",
            "DynamoDB page is malformed.",
          );
        }
        items.push(...pageItems);
        let cursor = null;
        if (response.LastEvaluatedKey !== undefined) {
          if (
            !isPlainObject(response.LastEvaluatedKey)
            || Object.keys(response.LastEvaluatedKey).length !== 3
            || nativeString(
              response.LastEvaluatedKey,
              "entityType",
            ) !== "APPROVAL"
          ) {
            fail(
              "MALFORMED_DYNAMODB_RESPONSE",
              "DynamoDB cursor is malformed.",
            );
          }
          cursor = {
            pk: nativeString(response.LastEvaluatedKey, "pk"),
            sk: nativeString(response.LastEvaluatedKey, "sk"),
          };
          const nextCursor = `${cursor.pk}\u0000${cursor.sk}`;
          if (nextCursor === previousCursor) {
            fail(
              "MALFORMED_DYNAMODB_RESPONSE",
              "DynamoDB cursor is malformed.",
            );
          }
          previousCursor = nextCursor;
        }
        if (cursor === null || items.length === limit) {
          return { items, cursor };
        }
        exclusiveStartKey = {
          entityType: stringAttribute("APPROVAL"),
          pk: stringAttribute(cursor.pk),
          sk: stringAttribute(cursor.sk),
        };
      }
    },
    async listResourceGrants(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_RESOURCE_GRANT_SCOPE",
      );
      return queryPartition({
        input,
        partitionKey: `GRANT#${domainId}`,
        sortKeyPrefix: "GRANT#",
        parser: resourceGrantFromItem,
        allowedKeys: new Set([
          "domainId",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId"]),
        scopeCode: "INVALID_RESOURCE_GRANT_SCOPE",
      });
    },
    async listEntitlements(input) {
      const subjectType = input?.subjectType === undefined
        ? "USER"
        : validateEnum(
            input.subjectType,
            ENTITLEMENT_SUBJECT_TYPES,
            "INVALID_ENTITLEMENT_SCOPE",
            "Entitlement subject type is malformed.",
          );
      const subject = validateEntitlementSubject(
        subjectType,
        input?.subject,
        "INVALID_ENTITLEMENT_SCOPE",
      );
      return queryPartition({
        input,
        partitionKey: entitlementPartitionKey(subjectType, subject),
        sortKeyPrefix: "AGENT#",
        parser: entitlementFromItem,
        allowedKeys: new Set([
          "subjectType",
          "subject",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["subject"]),
        scopeCode: "INVALID_ENTITLEMENT_SCOPE",
      });
    },
    async listAgentEntitlements(input = {}) {
      if (!isPlainObject(input)) {
        fail(
          "INVALID_ENTITLEMENT_SCOPE",
          "Entitlement scope is malformed.",
        );
      }
      const allowedKeys = new Set([
        "domainId",
        "limit",
        "cursor",
        "abortSignal",
      ]);
      if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
        fail(
          "INVALID_ENTITLEMENT_SCOPE",
          "Entitlement scope is malformed.",
        );
      }
      const domainId = input.domainId === undefined
        ? undefined
        : validateDomainId(
            input.domainId,
            "INVALID_ENTITLEMENT_SCOPE",
          );
      const limit = input.limit === undefined ? 50 : input.limit;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAX_PAGE_SIZE
      ) {
        fail("INVALID_READ_OPTIONS", "Read limit is malformed.");
      }
      const exclusiveStartKey = validateEntitlementInventoryCursor(
        input.cursor,
        domainId,
      );
      const abortSignal = validateAbortSignal(input.abortSignal);
      const projectionNames = Object.fromEntries(
        [...TYPED_ENTITLEMENT_ITEM_KEYS].map(
          (key, index) => [`#entitlement${index}`, key],
        ),
      );
      const response = await dynamo.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "EntityTypeIndex",
          KeyConditionExpression: domainId === undefined
            ? "#entityType = :entityType"
            : "#entityType = :entityType "
              + "AND begins_with(#sk, :domainPrefix)",
          ProjectionExpression: Object.keys(projectionNames).join(", "),
          ExpressionAttributeNames: {
            "#entityType": "entityType",
            ...(domainId === undefined ? {} : { "#sk": "sk" }),
            ...projectionNames,
          },
          ExpressionAttributeValues: {
            ":entityType": stringAttribute("ENTITLEMENT"),
            ...(domainId === undefined
              ? {}
              : {
                  ":domainPrefix":
                    stringAttribute(`AGENT#${domainId}#`),
                }),
          },
          Limit: limit,
          ScanIndexForward: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
        abortSignal ? { abortSignal } : undefined,
      );
      validateDynamoResponse(response);
      if (
        response.Items !== undefined
        && (
          !Array.isArray(response.Items)
          || response.Items.length > limit
        )
      ) {
        fail(
          "MALFORMED_DYNAMODB_RESPONSE",
          "DynamoDB page is malformed.",
        );
      }
      const items = (response.Items ?? []).map((item) =>
        parseStored(entitlementFromItem, item));
      if (
        domainId !== undefined
        && items.some((item) => item.domainId !== domainId)
      ) {
        fail(
          "MALFORMED_DYNAMODB_RESPONSE",
          "DynamoDB page is malformed.",
        );
      }
      return {
        items,
        cursor: parseEntitlementInventoryLastKey(
          response.LastEvaluatedKey,
          domainId,
        ),
      };
    },
    async listSessions(input) {
      const actor = validateSubject(
        input?.actor,
        "INVALID_SESSION_SCOPE",
      );
      return queryPartition({
        input,
        partitionKey: `SESSION#${actor}`,
        sortKeyPrefix: "SESSION#",
        parser: sessionFromItem,
        allowedKeys: new Set([
          "actor",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["actor"]),
        scopeCode: "INVALID_SESSION_SCOPE",
      });
    },
    async listIncidents(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_INCIDENT_SCOPE",
      );
      const ownerSubject = input?.ownerSubject === undefined
        ? undefined
        : validateSubject(
          input.ownerSubject,
          "INVALID_INCIDENT_SCOPE",
        );
      return queryPartition({
        input,
        partitionKey: `INCIDENT#${domainId}`,
        sortKeyPrefix: "INCIDENT#",
        parser: incidentFromItem,
        allowedKeys: new Set([
          "domainId",
          "ownerSubject",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId"]),
        scopeCode: "INVALID_INCIDENT_SCOPE",
        filter: ownerSubject === undefined
          ? undefined
          : {
              nameToken: "#ownerSubject",
              name: "ownerSubject",
              valueToken: ":ownerSubject",
              value: ownerSubject,
              expression: "#ownerSubject = :ownerSubject",
            },
      });
    },
    async listBreakGlass(input = {}) {
      const requesterSubject = input.requesterSubject === undefined
        ? undefined
        : validateSubject(
          input.requesterSubject,
          "INVALID_BREAK_GLASS_SCOPE",
        );
      return queryPartition({
        input,
        partitionKey: "BREAK_GLASS",
        sortKeyPrefix: "BREAK_GLASS#",
        parser: breakGlassFromItem,
        allowedKeys: new Set([
          "requesterSubject",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(),
        scopeCode: "INVALID_BREAK_GLASS_SCOPE",
        filter: requesterSubject === undefined
          ? undefined
          : {
              nameToken: "#requesterSubject",
              name: "requesterSubject",
              valueToken: ":requesterSubject",
              value: requesterSubject,
              expression: "#requesterSubject = :requesterSubject",
            },
      });
    },
    async listAuditMetadata(input = {}) {
      if (!isPlainObject(input)) {
        fail("INVALID_AUDIT_SCOPE", "Audit scope is malformed.");
      }
      const allowedKeys = new Set([
        "domainId",
        "limit",
        "cursor",
        "abortSignal",
      ]);
      if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
        fail("INVALID_AUDIT_SCOPE", "Audit scope is malformed.");
      }
      const domainId = input.domainId === undefined
        ? undefined
        : validateDomainId(input.domainId, "INVALID_AUDIT_SCOPE");
      const limit = input.limit === undefined ? 50 : input.limit;
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > MAX_PAGE_SIZE
      ) {
        fail("INVALID_READ_OPTIONS", "Read limit is malformed.");
      }
      let exclusiveStartKey;
      if (input.cursor !== undefined) {
        if (
          !hasExactKeys(input.cursor, CURSOR_KEYS)
          || typeof input.cursor.pk !== "string"
          || input.cursor.pk.length === 0
          || input.cursor.pk.length > 1024
          || typeof input.cursor.sk !== "string"
          || input.cursor.sk.length === 0
          || input.cursor.sk.length > 1024
        ) {
          fail("INVALID_READ_OPTIONS", "Read cursor is malformed.");
        }
        exclusiveStartKey = {
          entityType: stringAttribute("WORKSPACE_AUDIT"),
          pk: stringAttribute(input.cursor.pk),
          sk: stringAttribute(input.cursor.sk),
        };
      }
      const abortSignal = validateAbortSignal(input.abortSignal);
      const projectionNames = Object.fromEntries(
        [...AUDIT_ITEM_KEYS].map(
          (key, index) => [`#audit${index}`, key],
        ),
      );
      const projectionExpression = Object.keys(projectionNames).join(", ");
      const expressionAttributeNames = {
        "#entityType": "entityType",
        ...projectionNames,
        ...(domainId === undefined ? {} : { "#domainId": "domainId" }),
      };
      const expressionAttributeValues = {
        ":auditType": stringAttribute("WORKSPACE_AUDIT"),
        ...(domainId === undefined
          ? {}
          : { ":domainId": stringAttribute(domainId) }),
      };
      const items = [];
      let previousCursor = exclusiveStartKey
        ? `${nativeString(exclusiveStartKey, "pk")}\u0000`
          + nativeString(exclusiveStartKey, "sk")
        : null;
      while (true) {
        const response = await dynamo.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "EntityTypeIndex",
            KeyConditionExpression: "#entityType = :auditType",
            ...(domainId === undefined
              ? {}
              : { FilterExpression: "#domainId = :domainId" }),
            ProjectionExpression: projectionExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            Limit: limit - items.length,
            ...(exclusiveStartKey
              ? { ExclusiveStartKey: exclusiveStartKey }
              : {}),
          }),
          abortSignal ? { abortSignal } : undefined,
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
        const pageItems = (response.Items ?? []).map((item) =>
          parseStored(auditFromItem, item));
        if (items.length + pageItems.length > limit) {
          fail(
            "MALFORMED_DYNAMODB_RESPONSE",
            "DynamoDB page is malformed.",
          );
        }
        items.push(...pageItems);
        let cursor = null;
        if (response.LastEvaluatedKey !== undefined) {
          if (
            !isPlainObject(response.LastEvaluatedKey)
            || Object.keys(response.LastEvaluatedKey).length !== 3
            || nativeString(
              response.LastEvaluatedKey,
              "entityType",
            ) !== "WORKSPACE_AUDIT"
          ) {
            fail(
              "MALFORMED_DYNAMODB_RESPONSE",
              "DynamoDB cursor is malformed.",
            );
          }
          cursor = {
            pk: nativeString(response.LastEvaluatedKey, "pk"),
            sk: nativeString(response.LastEvaluatedKey, "sk"),
          };
          const nextCursor = `${cursor.pk}\u0000${cursor.sk}`;
          if (nextCursor === previousCursor) {
            fail(
              "MALFORMED_DYNAMODB_RESPONSE",
              "DynamoDB cursor is malformed.",
            );
          }
          previousCursor = nextCursor;
        }
        if (cursor === null || items.length === limit) {
          return { items, cursor };
        }
        exclusiveStartKey = {
          entityType: stringAttribute("WORKSPACE_AUDIT"),
          pk: stringAttribute(cursor.pk),
          sk: stringAttribute(cursor.sk),
        };
      }
    },
    async listAudits(input) {
      const resource = validateText(
        input?.resource,
        512,
        "INVALID_AUDIT_SCOPE",
        "Audit scope is malformed.",
      );
      return queryPartition({
        input,
        partitionKey: `AUDIT#${resource}`,
        sortKeyPrefix: isAuditSortKey,
        parser: auditFromItem,
        allowedKeys: new Set([
          "resource",
          "limit",
          "cursor",
          "abortSignal",
        ]),
        requiredKeys: new Set(["resource"]),
        scopeCode: "INVALID_AUDIT_SCOPE",
      });
    },
    async getProject(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_PROJECT_SCOPE",
      );
      const projectId = validateSlug(
        input?.projectId,
        "INVALID_PROJECT_SCOPE",
        "Project ID",
      );
      return getItem({
        input,
        pk: `PROJECT#${domainId}`,
        sk: `PROJECT#${projectId}`,
        parser: projectFromItem,
        allowedKeys: new Set([
          "domainId",
          "projectId",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId", "projectId"]),
        scopeCode: "INVALID_PROJECT_SCOPE",
      });
    },
    async getAgent(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_AGENT_SCOPE",
      );
      const projectId = validateSlug(
        input?.projectId,
        "INVALID_AGENT_SCOPE",
        "Project ID",
      );
      const agentId = validateSlug(
        input?.agentId,
        "INVALID_AGENT_SCOPE",
        "Agent ID",
      );
      return getItem({
        input,
        pk: `AGENT#${domainId}#${projectId}`,
        sk: `AGENT#${agentId}`,
        parser: agentFromItem,
        allowedKeys: new Set([
          "domainId",
          "projectId",
          "agentId",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId", "projectId", "agentId"]),
        scopeCode: "INVALID_AGENT_SCOPE",
      });
    },
    async getDeployment(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_DEPLOYMENT_SCOPE",
      );
      const projectId = validateSlug(
        input?.projectId,
        "INVALID_DEPLOYMENT_SCOPE",
        "Project ID",
      );
      const deploymentId = validateSlug(
        input?.deploymentId,
        "INVALID_DEPLOYMENT_SCOPE",
        "Deployment ID",
      );
      return getItem({
        input,
        pk: `DEPLOYMENT#${domainId}#${projectId}`,
        sk: `DEPLOYMENT#${deploymentId}`,
        parser: deploymentFromItem,
        allowedKeys: new Set([
          "domainId",
          "projectId",
          "deploymentId",
          "abortSignal",
        ]),
        requiredKeys: new Set([
          "domainId",
          "projectId",
          "deploymentId",
        ]),
        scopeCode: "INVALID_DEPLOYMENT_SCOPE",
      });
    },
    async getApproval(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_APPROVAL_SCOPE",
      );
      const approvalId = validateSlug(
        input?.approvalId,
        "INVALID_APPROVAL_SCOPE",
        "Approval ID",
      );
      return getItem({
        input,
        pk: `APPROVAL#${domainId}`,
        sk: `APPROVAL#${approvalId}`,
        parser: approvalFromItem,
        allowedKeys: new Set([
          "domainId",
          "approvalId",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId", "approvalId"]),
        scopeCode: "INVALID_APPROVAL_SCOPE",
      });
    },
    async getResourceGrant(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_RESOURCE_GRANT_SCOPE",
      );
      const resourceType = validateEnum(
        input?.resourceType,
        RESOURCE_TYPES,
        "INVALID_RESOURCE_GRANT_SCOPE",
        "Resource type is malformed.",
      );
      const resourceId = validateResourceId(
        input?.resourceId,
        "INVALID_RESOURCE_GRANT_SCOPE",
      );
      return getItem({
        input,
        pk: `GRANT#${domainId}`,
        sk: `GRANT#${resourceType}#${resourceId}`,
        parser: resourceGrantFromItem,
        allowedKeys: new Set([
          "domainId",
          "resourceType",
          "resourceId",
          "abortSignal",
        ]),
        requiredKeys: new Set([
          "domainId",
          "resourceType",
          "resourceId",
        ]),
        scopeCode: "INVALID_RESOURCE_GRANT_SCOPE",
      });
    },
    async getEntitlement(input) {
      const subjectType = input?.subjectType === undefined
        ? "USER"
        : validateEnum(
            input.subjectType,
            ENTITLEMENT_SUBJECT_TYPES,
            "INVALID_ENTITLEMENT_SCOPE",
            "Entitlement subject type is malformed.",
          );
      const subject = validateEntitlementSubject(
        subjectType,
        input?.subject,
        "INVALID_ENTITLEMENT_SCOPE",
      );
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_ENTITLEMENT_SCOPE",
      );
      const projectId = validateSlug(
        input?.projectId,
        "INVALID_ENTITLEMENT_SCOPE",
        "Project ID",
      );
      const agentId = validateSlug(
        input?.agentId,
        "INVALID_ENTITLEMENT_SCOPE",
        "Agent ID",
      );
      return getItem({
        input,
        pk: entitlementPartitionKey(subjectType, subject),
        sk: `AGENT#${domainId}#${projectId}#${agentId}`,
        parser: entitlementFromItem,
        allowedKeys: new Set([
          "subjectType",
          "subject",
          "domainId",
          "projectId",
          "agentId",
          "abortSignal",
        ]),
        requiredKeys: new Set([
          "subject",
          "domainId",
          "projectId",
          "agentId",
        ]),
        scopeCode: "INVALID_ENTITLEMENT_SCOPE",
      });
    },
    async getSession(input) {
      const actor = validateSubject(
        input?.actor,
        "INVALID_SESSION_SCOPE",
      );
      const sessionId = validateSlug(
        input?.sessionId,
        "INVALID_SESSION_SCOPE",
        "Session ID",
      );
      return getItem({
        input,
        pk: `SESSION#${actor}`,
        sk: `SESSION#${sessionId}`,
        parser: sessionFromItem,
        allowedKeys: new Set([
          "actor",
          "sessionId",
          "abortSignal",
        ]),
        requiredKeys: new Set(["actor", "sessionId"]),
        scopeCode: "INVALID_SESSION_SCOPE",
      });
    },
    async getIncident(input) {
      const domainId = validateDomainId(
        input?.domainId,
        "INVALID_INCIDENT_SCOPE",
      );
      const incidentId = validateSlug(
        input?.incidentId,
        "INVALID_INCIDENT_SCOPE",
        "Incident ID",
      );
      return getItem({
        input,
        pk: `INCIDENT#${domainId}`,
        sk: `INCIDENT#${incidentId}`,
        parser: incidentFromItem,
        allowedKeys: new Set([
          "domainId",
          "incidentId",
          "abortSignal",
        ]),
        requiredKeys: new Set(["domainId", "incidentId"]),
        scopeCode: "INVALID_INCIDENT_SCOPE",
      });
    },
    async getBreakGlass(input) {
      const breakGlassId = validateSlug(
        input?.breakGlassId,
        "INVALID_BREAK_GLASS_SCOPE",
        "Break-glass ID",
      );
      return getItem({
        input,
        pk: "BREAK_GLASS",
        sk: `BREAK_GLASS#${breakGlassId}`,
        parser: breakGlassFromItem,
        allowedKeys: new Set([
          "breakGlassId",
          "abortSignal",
        ]),
        requiredKeys: new Set(["breakGlassId"]),
        scopeCode: "INVALID_BREAK_GLASS_SCOPE",
      });
    },
    async getMutationResult(input) {
      if (!isPlainObject(input)) {
        fail("INVALID_MUTATION_SCOPE", "Mutation scope is malformed.");
      }
      const actor = validateSubject(
        input.actor,
        "INVALID_MUTATION_SCOPE",
      );
      const route = validatePattern(
        input.route,
        ROUTE_PATTERN,
        263,
        "INVALID_MUTATION_SCOPE",
        "Mutation route is malformed.",
      );
      const requestId = validatePattern(
        input.requestId,
        REQUEST_ID_PATTERN,
        128,
        "INVALID_MUTATION_SCOPE",
        "Mutation request ID is malformed.",
      );
      const abortSignal = validateGetInput(
        input,
        new Set(["actor", "route", "requestId", "abortSignal"]),
        new Set(["actor", "route", "requestId"]),
        "INVALID_MUTATION_SCOPE",
      );
      const response = await dynamo.send(
        new GetItemCommand({
          TableName: tableName,
          Key: {
            pk: stringAttribute(`MUTATION#${actor}`),
            sk: stringAttribute(`MUTATION#${route}#${requestId}`),
          },
          ConsistentRead: true,
        }),
        abortSignal ? { abortSignal } : undefined,
      );
      validateDynamoResponse(response);
      if (response.Item === undefined) return null;
      const stored = parseStored(
        (item) => mutationFromItem(item, clockSnapshot(now)),
        response.Item,
      );
      return stored;
    },
  };
}
