import {validateEvaluation} from '../../../../console/public/evaluation-config.mjs';
import { isDeepStrictEqual } from "node:util";
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import {
  validPortableResourceBinding,
} from "./resource-binding.mjs";
import {
  validateGuardrailChain,
} from "../../../../console/public/guardrail-chain.mjs";

const CONFIG_KEYS = ["tableName", "dynamo", "now"];
const JOURNEY_INPUT_KEYS = ["record", "mutation"];
const TRANSACTIONAL_JOURNEY_INPUT_KEYS = ["record", "mutation", "claim"];
const GITHUB_AUTHORIZATION_PUT_KEYS = ["record"];
const GITHUB_AUTHORIZATION_CONSUME_KEYS = ["state"];
const GET_JOURNEY_KEYS = ["actor", "domainId", "journeyId"];
const GET_DELIVERY_KEYS = ["actor", "domainId", "deliveryId"];
const CHECKPOINT_INPUT_KEYS = [
  "actor",
  "domainId",
  "role",
  "deliveryId",
  "expectedStatus",
  "checkpoint",
];
const MUTATION_KEYS = [
  "actor",
  "domainId",
  "requestId",
  "payloadFingerprint",
  "expectedUpdatedAt",
];
const MINIMAL_JOURNEY_KEYS = [
  "version",
  "actor",
  "id",
  "domainId",
  "preset",
  "repositoryName",
  "status",
  "createdAt",
  "updatedAt",
];
const SPEC_JOURNEY_KEYS = [
  "version",
  "actor",
  "id",
  "domainId",
  "preset",
  "repositoryName",
  "status",
  "transcript",
  "inception",
  "createdAt",
  "updatedAt",
];
const DELIVERY_KEYS = [
  "version",
  "actor",
  "id",
  "domainId",
  "role",
  "preset",
  "repositoryName",
  "visibility",
  "source",
  "manifest",
  "status",
  "previewExpiresAt",
  "checkpoints",
  "createdAt",
  "updatedAt",
];
const GITHUB_AUTHORIZATION_INTENT_KEYS = [
  "version",
  "actor",
  "domainId",
  "role",
  "state",
  "deliveryId",
  "manifestFingerprint",
  "repositoryName",
  "visibility",
  "requestId",
  "expiresAt",
  "createdAt",
  "consumedAt",
];
const FULL_SNAPSHOT_KEYS = [
  "snapshotVersion",
  "agent",
  "blueprint",
  "resources",
];
const FULL_AGENT_KEYS = [
  "domainId",
  "projectId",
  "id",
  "name",
  "instructions",
  "modelId",
  "runtimeModelId",
  "modelParameters",
  "buildOptions",
  "guardrailChain",
  "testEvidenceHash",
];
const LEGACY_FULL_AGENT_KEYS = FULL_AGENT_KEYS.filter(
  (key) => key !== "guardrailChain",
);
const FULL_BLUEPRINT_KEYS = [
  "registryId",
  "recordId",
  "version",
  "blueprintId",
  "templateId",
  "scope",
  "template",
];
const FULL_RESOURCE_KEYS = [
  "type",
  "registryId",
  "recordId",
  "version",
  "id",
  "binding",
];
const SPEC_AGENT_KEYS = [
  "domainId",
  "projectId",
  "agentId",
  "status",
  "contractFingerprint",
  "configurationFingerprint",
];
const MODEL_PARAMETER_KEYS = ["temperature", "maxTokens"];
const BUILD_OPTION_KEYS = [
  "framework",
  "deployTarget",
  "memory",
  "streaming",
  "identity",
  "guardrails",
];
const MANIFEST_KEYS = ["summary", "fingerprint"];
const SUMMARY_KEYS = ["fileCount", "workflowCount"];
const TRANSCRIPT_KEYS = ["role", "text"];
const CHECKPOINT_KEYS = ["status", "at", "github"];
const JOURNEY_ITEM_KEYS = [
  "pk",
  "sk",
  "entityType",
  "actor",
  "id",
  "domainId",
  "preset",
  "status",
  "createdAt",
  "updatedAt",
  "record",
  "mutation",
  "expiresAt",
];
const DELIVERY_ITEM_KEYS = [
  ...JOURNEY_ITEM_KEYS,
  "role",
  "previewExpiresAt",
  "manifestFingerprint",
];
const GITHUB_AUTHORIZATION_ITEM_KEYS = [
  "pk",
  "sk",
  "entityType",
  "actor",
  "domainId",
  "role",
  "state",
  "deliveryId",
  "manifestFingerprint",
  "repositoryName",
  "visibility",
  "requestId",
  "createdAt",
  "consumedAt",
  "expiresAt",
  "record",
];

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const GITHUB_AUTHORIZATION_STATE_PATTERN = /^gho_[A-Za-z0-9_-]{32,128}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SECRET_PATTERNS = [
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bASIA[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const CHECKPOINT_ORDER = [
  "APPROVED",
  "REPOSITORY_CREATING",
  "REPOSITORY_CREATED",
  "MAIN_BOOTSTRAPPED",
  "BRANCH_CREATED",
  "SOURCE_COMMITTED",
  "PULL_REQUEST_OPENED",
  "COMPLETED",
];
const PREVIOUS_STATUS = new Map(
  CHECKPOINT_ORDER.map((status, index) => [
    status,
    index === 0 ? "PREVIEWED" : CHECKPOINT_ORDER[index - 1],
  ]),
);
const MAIN_EXPORT_ORDER = [
  "APPROVED", "REPOSITORY_CREATING", "REPOSITORY_CREATED",
  "INITIAL_SOURCE_COMMITTED", "COMPLETED",
];
const MAX_PREVIEW_MS = 15 * 60_000;
const GITHUB_AUTHORIZATION_TTL_MS = 10 * 60_000;
const MAX_TRANSCRIPT_TURNS = 40;
const MAX_TRANSCRIPT_TEXT_BYTES = 8_000;
const MAX_TRANSCRIPT_BYTES = 64_000;
const MAX_JSON_BYTES = 256_000;
const MAX_DELIVERY_RECORD_BYTES = 320_000;
const MAX_JSON_DEPTH = 32;
const MAX_ENCODED_DELIVERY_ITEM_BYTES = 380_000;
const MUTATION_LEASE_MS = 45_000;
const RETENTION_SECONDS = 365 * 24 * 60 * 60;
const MUTATION_OPERATIONS = new Set([
  "CREATE_JOURNEY",
  "ADD_MESSAGE",
  "CREATE_CONTRACT",
  "CREATE_PREVIEW",
  "CREATE_REPOSITORY",
]);
const MUTATION_RESOURCE_TYPES = new Set(["JOURNEY", "DELIVERY"]);
const MUTATION_CLAIM_KEYS = [
  "actor",
  "domainId",
  "effectiveRole",
  "operation",
  "requestId",
  "payloadFingerprint",
  "resourceType",
  "resourceId",
  "leaseToken",
];
const MUTATION_ITEM_KEYS = [
  "pk",
  "sk",
  "entityType",
  "actor",
  "domainId",
  "effectiveRole",
  "operation",
  "requestId",
  "payloadFingerprint",
  "resourceType",
  "resourceId",
  "status",
  "leaseToken",
  "leaseExpiresAt",
  "result",
  "createdAt",
  "updatedAt",
  "expiresAt",
];

export class JourneyStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JourneyStateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new JourneyStateError(code, message);
}

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys) {
  return plain(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validString(value, pattern, maxBytes = 1024) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value) <= maxBytes
    && !CONTROL_PATTERN.test(value)
    && pattern.test(value);
}

function validText(value, maxBytes) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value) <= maxBytes
    && !CONTROL_PATTERN.test(value);
}

function validMultilineText(value, maxBytes) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value) <= maxBytes
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function clockTimestamp(now) {
  const value = now();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!validTimestamp(timestamp)) {
    throw new TypeError("Journey state clock is invalid.");
  }
  return timestamp;
}

function containsSecret(value) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function validJson(value, seen = new Set(), depth = 0) {
  if (
    value === null
    || typeof value === "boolean"
    || (
      typeof value === "number"
      && Number.isFinite(value)
    )
  ) {
    return true;
  }
  if (typeof value === "string") {
    return (
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
      && !containsSecret(value)
    );
  }
  if (
    typeof value !== "object"
    || seen.has(value)
    || depth >= MAX_JSON_DEPTH
  ) {
    return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => validJson(item, seen, depth + 1))
    : plain(value)
      && Reflect.ownKeys(value).every(
        (key) => typeof key === "string"
          && !CONTROL_PATTERN.test(key)
          && validJson(value[key], seen, depth + 1),
      );
  seen.delete(value);
  return valid;
}

function boundedJson(value, maxBytes = MAX_JSON_BYTES) {
  if (!validJson(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= maxBytes;
  } catch {
    return false;
  }
}

function validMutation(value, record) {
  return exact(value, MUTATION_KEYS)
    && value.actor === record.actor
    && value.domainId === record.domainId
    && validString(value.actor, SUBJECT_PATTERN, 256)
    && DOMAIN_PATTERN.test(value.domainId)
    && validString(value.requestId, REQUEST_ID_PATTERN, 128)
    && FINGERPRINT_PATTERN.test(value.payloadFingerprint)
    && (
      value.expectedUpdatedAt === null
      || validTimestamp(value.expectedUpdatedAt)
    );
}

function validTranscript(value) {
  if (!Array.isArray(value) || value.length > MAX_TRANSCRIPT_TURNS) {
    return false;
  }
  let bytes = 0;
  for (const turn of value) {
    if (
      !exact(turn, TRANSCRIPT_KEYS)
      || !["user", "assistant"].includes(turn.role)
      || !validMultilineText(turn.text, MAX_TRANSCRIPT_TEXT_BYTES)
      || containsSecret(turn.text)
    ) {
      return false;
    }
    bytes += Buffer.byteLength(turn.text);
  }
  return bytes <= MAX_TRANSCRIPT_BYTES;
}

function validateJourney(record) {
  const keys = record?.preset === "MINIMAL"
    ? MINIMAL_JOURNEY_KEYS
    : record?.preset === "SPEC"
      ? SPEC_JOURNEY_KEYS
      : null;
  if (
    keys === null
    || !exact(record, keys)
    || record.version !== 1
    || !validString(record.actor, SUBJECT_PATTERN, 256)
    || !ID_PATTERN.test(record.id)
    || !DOMAIN_PATTERN.test(record.domainId)
    || !REPOSITORY_PATTERN.test(record.repositoryName)
    || !["DRAFT", "CONTRACT_READY"].includes(record.status)
    || !validTimestamp(record.createdAt)
    || !validTimestamp(record.updatedAt)
    || record.createdAt > record.updatedAt
    || (
      record.preset === "MINIMAL"
      && record.status !== "DRAFT"
    )
    || (
      record.preset === "SPEC"
      && (
        !validTranscript(record.transcript)
        || (
          record.inception !== null
          && (
            !plain(record.inception)
            || !boundedJson(record.inception)
          )
        )
        || (
          record.status === "CONTRACT_READY"
          && record.inception === null
        )
      )
    )
  ) {
    fail("INVALID_JOURNEY", "Journey record is invalid.");
  }
  return structuredClone(record);
}

function validFullSnapshot(snapshot) {
  if (
    !exact(snapshot, [...FULL_SNAPSHOT_KEYS, ...(Object.hasOwn(snapshot||{},"evaluation")?["evaluation"]:[])])
    || snapshot.snapshotVersion !== 1
    || (
      !exact(snapshot.agent, FULL_AGENT_KEYS)
      && !exact(snapshot.agent, LEGACY_FULL_AGENT_KEYS)
    )
    || !exact(snapshot.blueprint, FULL_BLUEPRINT_KEYS)
    || !Array.isArray(snapshot.resources)
    || snapshot.resources.length > 100
  ) {
    return false;
  }
  if (Object.hasOwn(snapshot,"evaluation")) { try { validateEvaluation(snapshot.evaluation); } catch { return false; } }
  const { agent, blueprint, resources } = snapshot;
  if (Object.hasOwn(agent, "guardrailChain")) {
    try {
      validateGuardrailChain(agent.guardrailChain);
    } catch {
      return false;
    }
  }
  if (
    !DOMAIN_PATTERN.test(agent.domainId)
    || !ID_PATTERN.test(agent.projectId)
    || !ID_PATTERN.test(agent.id)
    || !validText(agent.name, 128)
    || !validMultilineText(agent.instructions, 16_384)
    || !validText(agent.modelId, 512)
    || !validText(agent.runtimeModelId, 512)
    || !exact(agent.modelParameters, MODEL_PARAMETER_KEYS)
    || (
      agent.modelParameters.temperature !== null
      && (
        typeof agent.modelParameters.temperature !== "number"
        || !Number.isFinite(agent.modelParameters.temperature)
        || agent.modelParameters.temperature < 0
        || agent.modelParameters.temperature > 1
      )
    )
    || (
      agent.modelParameters.maxTokens !== null
      && (
        !Number.isSafeInteger(agent.modelParameters.maxTokens)
        || agent.modelParameters.maxTokens < 1
        || agent.modelParameters.maxTokens > 4096
      )
    )
    || !exact(agent.buildOptions, BUILD_OPTION_KEYS)
    || !validText(agent.buildOptions.framework, 128)
    || !validText(agent.buildOptions.deployTarget, 128)
    || !["none", "shortTerm", "longAndShortTerm"].includes(
      agent.buildOptions.memory,
    )
    || typeof agent.buildOptions.streaming !== "boolean"
    || typeof agent.buildOptions.identity !== "boolean"
    || typeof agent.buildOptions.guardrails !== "boolean"
    || (agent.testEvidenceHash !== null && !FINGERPRINT_PATTERN.test(agent.testEvidenceHash))
    || !validString(blueprint.registryId, RESOURCE_ID_PATTERN, 256)
    || !validString(blueprint.recordId, RESOURCE_ID_PATTERN, 256)
    || !validText(blueprint.version, 128)
    || !validString(blueprint.blueprintId, RESOURCE_ID_PATTERN, 256)
    || !["chatagent", "workflowagent"].includes(blueprint.templateId)
    || !["shared", "domain"].includes(blueprint.scope)
    || !plain(blueprint.template)
    || !boundedJson(blueprint.template)
  ) {
    return false;
  }
  return resources.every((resource) =>
    exact(resource, FULL_RESOURCE_KEYS)
    && validString(resource.type, /^[A-Z][A-Z0-9_]{0,63}$/, 64)
    && validString(resource.registryId, RESOURCE_ID_PATTERN, 256)
    && validString(resource.recordId, RESOURCE_ID_PATTERN, 256)
    && validText(resource.version, 128)
    && validString(resource.id, RESOURCE_ID_PATTERN, 256)
    && validPortableResourceBinding(resource.type, resource.binding));
}

function validSource(preset, source, domainId) {
  if (preset === "FULL") {
    return exact(source, ["snapshot"])
      && validFullSnapshot(source.snapshot)
      && source.snapshot.agent.domainId === domainId;
  }
  if (preset === "MINIMAL") {
    return (
      exact(source, ["domainId"])
      || (
        exact(source, ["domainId", "journeyId"])
        && ID_PATTERN.test(source.journeyId)
      )
    ) && source.domainId === domainId;
  }
  return preset === "SPEC"
    && exact(source, ["journeyId", "inception", "agent"])
    && ID_PATTERN.test(source.journeyId)
    && plain(source.inception)
    && boundedJson(source.inception)
    && exact(source.agent, SPEC_AGENT_KEYS)
    && source.agent.domainId === domainId
    && validString(source.agent.domainId, DOMAIN_PATTERN, 64)
    && validString(source.agent.projectId, ID_PATTERN, 64)
    && validString(source.agent.agentId, ID_PATTERN, 64)
    && source.agent.status === "READY_FOR_TEST"
    && FINGERPRINT_PATTERN.test(source.agent.contractFingerprint)
    && FINGERPRINT_PATTERN.test(source.agent.configurationFingerprint);
}

function validateManifest(value) {
  return exact(value, MANIFEST_KEYS)
    && exact(value.summary, SUMMARY_KEYS)
    && Number.isSafeInteger(value.summary.fileCount)
    && value.summary.fileCount > 0
    && Number.isSafeInteger(value.summary.workflowCount)
    && value.summary.workflowCount >= 0
    && FINGERPRINT_PATTERN.test(value.fingerprint);
}

function validateDelivery(record, now, { enforceExpiry = false } = {}) {
  if (
    !exact(record, DELIVERY_KEYS)
    || record.version !== 1
    || !validString(record.actor, SUBJECT_PATTERN, 256)
    || !ID_PATTERN.test(record.id)
    || !DOMAIN_PATTERN.test(record.domainId)
    || !["admin", "lead", "builder"].includes(record.role)
    || !["FULL", "MINIMAL", "SPEC"].includes(record.preset)
    || !REPOSITORY_PATTERN.test(record.repositoryName)
    || record.visibility !== "private"
    || !validSource(record.preset, record.source, record.domainId)
    || !validateManifest(record.manifest)
    || !["PREVIEWED", ...CHECKPOINT_ORDER, "INITIAL_SOURCE_COMMITTED"].includes(record.status)
    || !validTimestamp(record.previewExpiresAt)
    || !Array.isArray(record.checkpoints)
    || record.checkpoints.length > CHECKPOINT_ORDER.length
    || !validTimestamp(record.createdAt)
    || !validTimestamp(record.updatedAt)
    || record.createdAt > record.updatedAt
    || !boundedJson(record, MAX_DELIVERY_RECORD_BYTES)
  ) {
    fail("INVALID_DELIVERY", "Delivery record is invalid.");
  }
  const validatedCheckpoints = validateCheckpointHistory(record.checkpoints);
  const expectedStatus = validatedCheckpoints.length === 0
    ? "PREVIEWED"
    : validatedCheckpoints.at(-1).status;
  if (record.status !== expectedStatus) {
    fail("INVALID_DELIVERY", "Delivery record is invalid.");
  }
  if (enforceExpiry) {
    const nowMs = Date.parse(now);
    const expiryMs = Date.parse(record.previewExpiresAt);
    if (expiryMs <= nowMs || expiryMs - nowMs > MAX_PREVIEW_MS) {
      fail("INVALID_DELIVERY", "Delivery record is invalid.");
    }
  }
  return structuredClone(record);
}

function validateGitHubAuthorizationIntent(
  record,
  now,
  { requireUnconsumed = false } = {},
) {
  const createdAtMs = Date.parse(record?.createdAt);
  const expiresAtMs = Date.parse(record?.expiresAt);
  if (
    !exact(record, GITHUB_AUTHORIZATION_INTENT_KEYS)
    || record.version !== 1
    || !validString(record.actor, SUBJECT_PATTERN, 256)
    || !DOMAIN_PATTERN.test(record.domainId)
    || !["admin", "lead", "builder"].includes(record.role)
    || !GITHUB_AUTHORIZATION_STATE_PATTERN.test(record.state)
    || !ID_PATTERN.test(record.deliveryId)
    || !FINGERPRINT_PATTERN.test(record.manifestFingerprint)
    || !REPOSITORY_PATTERN.test(record.repositoryName)
    || record.visibility !== "private"
    || !validString(record.requestId, REQUEST_ID_PATTERN, 128)
    || !validTimestamp(record.expiresAt)
    || !validTimestamp(record.createdAt)
    || (
      record.consumedAt !== null
      && !validTimestamp(record.consumedAt)
    )
    || expiresAtMs - createdAtMs !== GITHUB_AUTHORIZATION_TTL_MS
    || (
      record.consumedAt !== null
      && (
        Date.parse(record.consumedAt) < createdAtMs
        || Date.parse(record.consumedAt) > expiresAtMs
      )
    )
    || [
      record.actor,
      record.domainId,
      record.deliveryId,
      record.repositoryName,
      record.requestId,
    ].some(containsSecret)
    || (
      requireUnconsumed
      && (
        record.createdAt !== now
        || record.consumedAt !== null
        || expiresAtMs <= Date.parse(now)
      )
    )
  ) {
    fail(
      "INVALID_GITHUB_AUTHORIZATION",
      "GitHub authorization intent is invalid.",
    );
  }
  return structuredClone(record);
}

function sameGitHubAuthorizationBinding(left, right) {
  return [
    "actor",
    "domainId",
    "role",
    "state",
    "deliveryId",
    "manifestFingerprint",
    "repositoryName",
    "visibility",
    "requestId",
  ].every((key) => left[key] === right[key]);
}

function validGitHubUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

function validGithubFor(status, value) {
  if (status === "COMPLETED") return value === null;
  if (!plain(value) || !boundedJson(value)) return false;
  if (status === "APPROVED") {
    return exact(value, ["owner", "repository", "visibility"])
      && validString(value.owner, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 39)
      && REPOSITORY_PATTERN.test(value.repository)
      && value.visibility === "private";
  }
  if (status === "REPOSITORY_CREATING") {
    return exact(value, ["owner", "repository", "visibility"])
      && validString(value.owner, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 39)
      && REPOSITORY_PATTERN.test(value.repository)
      && value.visibility === "private";
  }
  if (status === "REPOSITORY_CREATED") {
    return exact(
      value,
      ["repositoryId", "repositoryNodeId", "htmlUrl"],
    )
      && Number.isSafeInteger(value.repositoryId)
      && value.repositoryId > 0
      && validText(value.repositoryNodeId, 256)
      && validGitHubUrl(value.htmlUrl);
  }
  if (status === "MAIN_BOOTSTRAPPED") {
    return exact(value, ["commitSha"]) && SHA_PATTERN.test(value.commitSha);
  }
  if (status === "BRANCH_CREATED") {
    return exact(value, ["branchName", "baseSha"])
      && validText(value.branchName, 255)
      && !value.branchName.includes("..")
      && !value.branchName.startsWith("/")
      && !value.branchName.endsWith("/")
      && SHA_PATTERN.test(value.baseSha);
  }
  if (status === "SOURCE_COMMITTED" || status === "INITIAL_SOURCE_COMMITTED") {
    return exact(value, ["commitSha", "treeSha"])
      && SHA_PATTERN.test(value.commitSha)
      && SHA_PATTERN.test(value.treeSha);
  }
  return status === "PULL_REQUEST_OPENED"
    && exact(
      value,
      ["pullRequestNumber", "pullRequestNodeId", "htmlUrl"],
    )
    && Number.isSafeInteger(value.pullRequestNumber)
    && value.pullRequestNumber > 0
    && validText(value.pullRequestNodeId, 256)
    && validGitHubUrl(value.htmlUrl);
}

function validateCheckpoint(value) {
  if (
    !exact(value, CHECKPOINT_KEYS)
    || ![...CHECKPOINT_ORDER, "INITIAL_SOURCE_COMMITTED"].includes(value.status)
    || !validTimestamp(value.at)
    || !validGithubFor(value.status, value.github)
  ) {
    fail(
      "INVALID_DELIVERY_CHECKPOINT",
      "Delivery checkpoint is invalid.",
    );
  }
  return structuredClone(value);
}

function validateCheckpointHistory(value) {
  const checkpoints = value.map(validateCheckpoint);
  const order = checkpoints.some(item => item.status === "INITIAL_SOURCE_COMMITTED")
    ? MAIN_EXPORT_ORDER : CHECKPOINT_ORDER;
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (checkpoints[index].status !== order[index]) {
      fail("INVALID_DELIVERY", "Delivery record is invalid.");
    }
  }
  return checkpoints;
}

function attribute(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  return {
    M: Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, attribute(item)]),
    ),
  };
}

function native(value) {
  if (!plain(value)) fail("CORRUPT_JOURNEY_STATE", "Stored state is invalid.");
  if (Object.hasOwn(value, "NULL")) return null;
  if (Object.hasOwn(value, "S") && typeof value.S === "string") return value.S;
  if (Object.hasOwn(value, "N") && typeof value.N === "string") {
    const number = Number(value.N);
    if (Number.isFinite(number)) return number;
  }
  if (Object.hasOwn(value, "BOOL") && typeof value.BOOL === "boolean") {
    return value.BOOL;
  }
  if (Object.hasOwn(value, "L") && Array.isArray(value.L)) {
    return value.L.map(native);
  }
  if (Object.hasOwn(value, "M") && plain(value.M)) {
    return Object.fromEntries(
      Object.entries(value.M).map(([key, item]) => [key, native(item)]),
    );
  }
  fail("CORRUPT_JOURNEY_STATE", "Stored state is invalid.");
}

function stringAttribute(value) {
  return { S: value };
}

function expiryEpoch(timestamp) {
  return Math.floor(Date.parse(timestamp) / 1000) + RETENTION_SECONDS;
}

function expiryAttribute(timestamp) {
  return { N: String(expiryEpoch(timestamp)) };
}

function authorizationExpiryAttribute(timestamp) {
  return { N: String(Math.floor(Date.parse(timestamp) / 1000)) };
}

function validExpiryAttribute(value, updatedAt) {
  if (
    !exact(value, ["N"])
    || typeof value.N !== "string"
    || !/^[1-9][0-9]*$/.test(value.N)
  ) {
    return false;
  }
  const expiry = Number(value.N);
  return Number.isSafeInteger(expiry)
    && expiry === expiryEpoch(updatedAt);
}

function validAuthorizationExpiryAttribute(value, expiresAt) {
  return exact(value, ["N"])
    && typeof value.N === "string"
    && /^[1-9][0-9]*$/.test(value.N)
    && Number(value.N) === Math.floor(Date.parse(expiresAt) / 1000);
}

function itemFor(type, record, mutation) {
  const item = {
    pk: stringAttribute(`${type}#${record.actor}#${record.id}`),
    sk: stringAttribute(type),
    entityType: stringAttribute(type),
    actor: stringAttribute(record.actor),
    id: stringAttribute(record.id),
    domainId: stringAttribute(record.domainId),
    preset: stringAttribute(record.preset),
    status: stringAttribute(record.status),
    createdAt: stringAttribute(record.createdAt),
    updatedAt: stringAttribute(record.updatedAt),
    record: attribute(record),
    mutation: attribute(mutation),
    expiresAt: expiryAttribute(record.updatedAt),
  };
  if (type === "DELIVERY") {
    item.role = stringAttribute(record.role);
    item.previewExpiresAt = stringAttribute(record.previewExpiresAt);
    item.manifestFingerprint =
      stringAttribute(record.manifest.fingerprint);
  }
  return item;
}

function githubAuthorizationKey(state) {
  return {
    pk: stringAttribute(`GITHUB_AUTHORIZATION#${state}`),
    sk: stringAttribute("GITHUB_AUTHORIZATION"),
  };
}

function githubAuthorizationIntentItem(record) {
  return {
    ...githubAuthorizationKey(record.state),
    entityType: stringAttribute("GITHUB_AUTHORIZATION"),
    actor: stringAttribute(record.actor),
    domainId: stringAttribute(record.domainId),
    role: stringAttribute(record.role),
    state: stringAttribute(record.state),
    deliveryId: stringAttribute(record.deliveryId),
    manifestFingerprint: stringAttribute(record.manifestFingerprint),
    repositoryName: stringAttribute(record.repositoryName),
    visibility: stringAttribute(record.visibility),
    requestId: stringAttribute(record.requestId),
    createdAt: stringAttribute(record.createdAt),
    consumedAt: { NULL: true },
    expiresAt: authorizationExpiryAttribute(record.expiresAt),
    record: attribute(record),
  };
}

function decodeItem(type, item, now) {
  const keys = type === "JOURNEY" ? JOURNEY_ITEM_KEYS : DELIVERY_ITEM_KEYS;
  if (!exact(item, keys)) {
    fail("CORRUPT_JOURNEY_STATE", "Stored state is invalid.");
  }
  const record = native(item.record);
  const mutation = native(item.mutation);
  const validated = type === "JOURNEY"
    ? validateJourney(record)
    : validateDelivery(record, now);
  const expectedPk = `${type}#${validated.actor}#${validated.id}`;
  if (
    native(item.pk) !== expectedPk
    || native(item.sk) !== type
    || native(item.entityType) !== type
    || native(item.actor) !== validated.actor
    || native(item.id) !== validated.id
    || native(item.domainId) !== validated.domainId
    || native(item.preset) !== validated.preset
    || native(item.status) !== validated.status
    || native(item.createdAt) !== validated.createdAt
    || native(item.updatedAt) !== validated.updatedAt
    || !validExpiryAttribute(item.expiresAt, validated.updatedAt)
    || !validMutation(mutation, validated)
    || (
      type === "DELIVERY"
      && (
        native(item.role) !== validated.role
        || native(item.previewExpiresAt) !== validated.previewExpiresAt
        || native(item.manifestFingerprint)
          !== validated.manifest.fingerprint
      )
    )
  ) {
    fail("CORRUPT_JOURNEY_STATE", "Stored state is invalid.");
  }
  return { record: validated, mutation };
}

function decodeGitHubAuthorizationIntentItem(item, now) {
  if (!exact(item, GITHUB_AUTHORIZATION_ITEM_KEYS)) {
    fail(
      "CORRUPT_GITHUB_AUTHORIZATION",
      "Stored GitHub authorization intent is invalid.",
    );
  }
  const record = validateGitHubAuthorizationIntent(native(item.record), now);
  const consumedAt = native(item.consumedAt);
  if (
    native(item.pk) !== `GITHUB_AUTHORIZATION#${record.state}`
    || native(item.sk) !== "GITHUB_AUTHORIZATION"
    || native(item.entityType) !== "GITHUB_AUTHORIZATION"
    || native(item.actor) !== record.actor
    || native(item.domainId) !== record.domainId
    || native(item.role) !== record.role
    || native(item.state) !== record.state
    || native(item.deliveryId) !== record.deliveryId
    || native(item.manifestFingerprint) !== record.manifestFingerprint
    || native(item.repositoryName) !== record.repositoryName
    || native(item.visibility) !== record.visibility
    || native(item.requestId) !== record.requestId
    || native(item.createdAt) !== record.createdAt
    || consumedAt !== record.consumedAt
    || !validAuthorizationExpiryAttribute(item.expiresAt, record.expiresAt)
  ) {
    fail(
      "CORRUPT_GITHUB_AUTHORIZATION",
      "Stored GitHub authorization intent is invalid.",
    );
  }
  return record;
}

function validateResponse(response) {
  if (!plain(response)) {
    fail("JOURNEY_STATE_UNAVAILABLE", "Journey state is unavailable.");
  }
}

function validateMutationBinding(value, {
  requireLease = true,
  proposed = false,
} = {}) {
  const expected = proposed
    ? [
        "actor",
        "domainId",
        "effectiveRole",
        "operation",
        "requestId",
        "payloadFingerprint",
        "resourceType",
        "proposedResourceId",
      ]
    : MUTATION_CLAIM_KEYS;
  const resourceId = proposed ? value?.proposedResourceId : value?.resourceId;
  if (
    !exact(value, expected)
    || !validString(value.actor, SUBJECT_PATTERN, 256)
    || !DOMAIN_PATTERN.test(value.domainId)
    || !["admin", "lead", "builder"].includes(value.effectiveRole)
    || !MUTATION_OPERATIONS.has(value.operation)
    || !validString(value.requestId, REQUEST_ID_PATTERN, 128)
    || !FINGERPRINT_PATTERN.test(value.payloadFingerprint)
    || !MUTATION_RESOURCE_TYPES.has(value.resourceType)
    || !ID_PATTERN.test(resourceId)
    || (
      requireLease
      && !validString(value.leaseToken, /^[a-f0-9-]{36}$/, 36)
    )
  ) {
    fail("INVALID_MUTATION", "Mutation request is invalid.");
  }
  return {
    actor: value.actor,
    domainId: value.domainId,
    effectiveRole: value.effectiveRole,
    operation: value.operation,
    requestId: value.requestId,
    payloadFingerprint: value.payloadFingerprint,
    resourceType: value.resourceType,
    resourceId,
    ...(requireLease ? { leaseToken: value.leaseToken } : {}),
  };
}

function mutationKey(value) {
  return {
    pk: stringAttribute(`MUTATION#${value.actor}`),
    sk: stringAttribute(
      `JOURNEY#${value.operation}#${value.requestId}`,
    ),
  };
}

function mutationItem(value, timestamp, leaseToken) {
  const binding = validateMutationBinding(value, {
    requireLease: false,
    proposed: true,
  });
  return {
    ...mutationKey(binding),
    entityType: stringAttribute("JOURNEY_MUTATION"),
    actor: stringAttribute(binding.actor),
    domainId: stringAttribute(binding.domainId),
    effectiveRole: stringAttribute(binding.effectiveRole),
    operation: stringAttribute(binding.operation),
    requestId: stringAttribute(binding.requestId),
    payloadFingerprint: stringAttribute(binding.payloadFingerprint),
    resourceType: stringAttribute(binding.resourceType),
    resourceId: stringAttribute(binding.resourceId),
    status: stringAttribute("IN_PROGRESS"),
    leaseToken: stringAttribute(leaseToken),
    leaseExpiresAt: stringAttribute(
      new Date(Date.parse(timestamp) + MUTATION_LEASE_MS).toISOString(),
    ),
    result: { NULL: true },
    createdAt: stringAttribute(timestamp),
    updatedAt: stringAttribute(timestamp),
    expiresAt: expiryAttribute(timestamp),
  };
}

function decodeMutationItem(item) {
  if (!exact(item, MUTATION_ITEM_KEYS)) {
    fail("CORRUPT_MUTATION_STATE", "Stored mutation is invalid.");
  }
  const binding = validateMutationBinding({
    actor: native(item.actor),
    domainId: native(item.domainId),
    effectiveRole: native(item.effectiveRole),
    operation: native(item.operation),
    requestId: native(item.requestId),
    payloadFingerprint: native(item.payloadFingerprint),
    resourceType: native(item.resourceType),
    resourceId: native(item.resourceId),
    leaseToken: native(item.leaseToken),
  });
  const status = native(item.status);
  const result = native(item.result);
  const updatedAt = native(item.updatedAt);
  if (
    native(item.pk) !== `MUTATION#${binding.actor}`
    || native(item.sk)
      !== `JOURNEY#${binding.operation}#${binding.requestId}`
    || native(item.entityType) !== "JOURNEY_MUTATION"
    || !["IN_PROGRESS", "SUCCEEDED"].includes(status)
    || !validTimestamp(native(item.leaseExpiresAt))
    || !validTimestamp(native(item.createdAt))
    || !validTimestamp(updatedAt)
    || !validExpiryAttribute(item.expiresAt, updatedAt)
    || (
      status === "IN_PROGRESS"
      ? result !== null
      : !exact(result, ["resourceType", "resourceId"])
        || result.resourceType !== binding.resourceType
        || result.resourceId !== binding.resourceId
    )
  ) {
    fail("CORRUPT_MUTATION_STATE", "Stored mutation is invalid.");
  }
  return {
    ...binding,
    status,
    leaseExpiresAt: native(item.leaseExpiresAt),
    result,
  };
}

function sameMutationBinding(left, right) {
  return [
    "actor",
    "domainId",
    "effectiveRole",
    "operation",
    "requestId",
    "payloadFingerprint",
    "resourceType",
  ].every((key) => left[key] === right[key]);
}

function validateScope(input, keys, idKey) {
  if (
    !exact(input, keys)
    || !validString(input.actor, SUBJECT_PATTERN, 256)
    || !DOMAIN_PATTERN.test(input.domainId)
    || !ID_PATTERN.test(input[idKey])
  ) {
    throw new TypeError("Journey state read scope is invalid.");
  }
  return input;
}

function validatePut(input, type, now) {
  const transactional = exact(input, TRANSACTIONAL_JOURNEY_INPUT_KEYS);
  if (!transactional && !exact(input, JOURNEY_INPUT_KEYS)) {
    fail(
      type === "JOURNEY" ? "INVALID_JOURNEY" : "INVALID_DELIVERY",
      `${type === "JOURNEY" ? "Journey" : "Delivery"} write is invalid.`,
    );
  }
  const record = type === "JOURNEY"
    ? validateJourney(input.record)
    : validateDelivery(input.record, now, { enforceExpiry: true });
  if (
    !validMutation(input.mutation, record)
    || record.updatedAt !== now
    || (
      input.mutation.expectedUpdatedAt === null
      && record.createdAt !== now
    )
    || (
      type === "DELIVERY"
      && (
        input.mutation.expectedUpdatedAt !== null
        || record.status !== "PREVIEWED"
        || record.checkpoints.length !== 0
      )
    )
    || (
      input.mutation.expectedUpdatedAt !== null
      && (
        input.mutation.expectedUpdatedAt >= now
        || record.createdAt > input.mutation.expectedUpdatedAt
      )
    )
  ) {
    fail(
      type === "JOURNEY" ? "INVALID_JOURNEY" : "INVALID_DELIVERY",
      `${type === "JOURNEY" ? "Journey" : "Delivery"} write is invalid.`,
    );
  }
  const claim = transactional
    ? validateMutationBinding(input.claim)
    : null;
  if (
    claim !== null
    && (
      claim.actor !== record.actor
      || claim.domainId !== record.domainId
      || claim.resourceType !== type
      || claim.resourceId !== record.id
    )
  ) {
    fail("INVALID_MUTATION", "Mutation request is invalid.");
  }
  return {
    record,
    mutation: structuredClone(input.mutation),
    claim,
  };
}

export function createJourneyState(configuration) {
  if (
    !exact(configuration, CONFIG_KEYS)
    || typeof configuration.tableName !== "string"
    || !/^[A-Za-z0-9_.-]{3,255}$/.test(configuration.tableName)
    || !configuration.dynamo
    || typeof configuration.dynamo.send !== "function"
    || typeof configuration.now !== "function"
  ) {
    throw new TypeError("Journey state configuration is invalid.");
  }
  const { tableName, dynamo, now } = configuration;

  async function read(type, input, keys, idKey, scopeCode) {
    const scope = validateScope(input, keys, idKey);
    const timestamp = clockTimestamp(now);
    const response = await dynamo.send(new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: stringAttribute(`${type}#${scope.actor}#${scope[idKey]}`),
        sk: stringAttribute(type),
      },
      ConsistentRead: true,
    }));
    validateResponse(response);
    if (response.Item === undefined) return null;
    const stored = decodeItem(type, response.Item, timestamp).record;
    if (
      stored.actor !== scope.actor
      || stored.domainId !== scope.domainId
      || stored.id !== scope[idKey]
    ) {
      fail(scopeCode, "Stored state is outside the authorized scope.");
    }
    return stored;
  }

  async function replay(type, record, mutation, conflictCode) {
    const response = await dynamo.send(new GetItemCommand({
      TableName: tableName,
      Key: {
        pk: stringAttribute(`${type}#${record.actor}#${record.id}`),
        sk: stringAttribute(type),
      },
      ConsistentRead: true,
    }));
    validateResponse(response);
    if (response.Item === undefined) {
      fail(conflictCode, `${type} write conflicted.`);
    }
    const stored = decodeItem(type, response.Item, clockTimestamp(now));
    if (
      !isDeepStrictEqual(stored.record, record)
      || !isDeepStrictEqual(stored.mutation, mutation)
    ) {
      fail(conflictCode, `${type} write conflicted.`);
    }
    return stored.record;
  }

  async function put(type, input, conflictCode) {
    const timestamp = clockTimestamp(now);
    const { record, mutation, claim } = validatePut(input, type, timestamp);
    const item = itemFor(type, record, mutation);
    if (
      type === "DELIVERY"
      && Buffer.byteLength(JSON.stringify(item))
        > MAX_ENCODED_DELIVERY_ITEM_BYTES
    ) {
      fail("INVALID_DELIVERY", "Delivery record is invalid.");
    }
    const create = mutation.expectedUpdatedAt === null;
    const condition = create
      ? {
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }
      : {
          ConditionExpression:
            "#entityType = :entityType"
            + " AND #actor = :actor"
            + " AND #domainId = :domainId"
            + " AND #preset = :preset"
            + " AND #createdAt = :createdAt"
            + " AND #updatedAt = :expectedUpdatedAt",
          ExpressionAttributeNames: {
            "#entityType": "entityType",
            "#actor": "actor",
            "#domainId": "domainId",
            "#preset": "preset",
            "#createdAt": "createdAt",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":entityType": stringAttribute(type),
            ":actor": stringAttribute(record.actor),
            ":domainId": stringAttribute(record.domainId),
            ":preset": stringAttribute(record.preset),
            ":createdAt": stringAttribute(record.createdAt),
            ":expectedUpdatedAt":
              stringAttribute(mutation.expectedUpdatedAt),
          },
        };
    try {
      if (claim !== null) {
        const response = await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: item,
                ...condition,
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: mutationKey(claim),
                UpdateExpression:
                  "SET #status = :succeeded,"
                  + " #result = :result,"
                  + " #updatedAt = :updatedAt,"
                  + " #expiresAt = :expiresAt",
                ConditionExpression:
                  "#entityType = :mutationType"
                  + " AND #status = :inProgress"
                  + " AND #leaseToken = :leaseToken",
                ExpressionAttributeNames: {
                  "#entityType": "entityType",
                  "#status": "status",
                  "#leaseToken": "leaseToken",
                  "#result": "result",
                  "#updatedAt": "updatedAt",
                  "#expiresAt": "expiresAt",
                },
                ExpressionAttributeValues: {
                  ":mutationType": stringAttribute("JOURNEY_MUTATION"),
                  ":inProgress": stringAttribute("IN_PROGRESS"),
                  ":succeeded": stringAttribute("SUCCEEDED"),
                  ":leaseToken": stringAttribute(claim.leaseToken),
                  ":result": attribute({
                    resourceType: type,
                    resourceId: record.id,
                  }),
                  ":updatedAt": stringAttribute(timestamp),
                  ":expiresAt": expiryAttribute(timestamp),
                },
              },
            },
          ],
        }));
        validateResponse(response);
        return record;
      }
      const response = await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: item,
        ...condition,
      }));
      validateResponse(response);
      return record;
    } catch (error) {
      if (
        !(error instanceof ConditionalCheckFailedException)
        && error?.name !== "TransactionCanceledException"
      ) {
        throw error;
      }
      return replay(type, record, mutation, conflictCode);
    }
  }

  return Object.freeze({
    async claimMutation(input) {
      const binding = validateMutationBinding(input, {
        requireLease: false,
        proposed: true,
      });
      const timestamp = clockTimestamp(now);
      const leaseToken = randomUUID();
      const item = mutationItem(input, timestamp, leaseToken);
      try {
        const response = await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }));
        validateResponse(response);
        return {
          status: "CLAIMED",
          claim: {
            ...binding,
            leaseToken,
          },
        };
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
      const response = await dynamo.send(new GetItemCommand({
        TableName: tableName,
        Key: mutationKey(binding),
        ConsistentRead: true,
      }));
      validateResponse(response);
      if (response.Item === undefined) {
        fail("MUTATION_CONFLICT", "Mutation request conflicted.");
      }
      const stored = decodeMutationItem(response.Item);
      if (!sameMutationBinding(stored, binding)) {
        fail("MUTATION_CONFLICT", "Mutation request conflicted.");
      }
      if (stored.status === "SUCCEEDED") {
        return { status: "SUCCEEDED", result: stored.result };
      }
      if (Date.parse(stored.leaseExpiresAt) > Date.parse(timestamp)) {
        fail("MUTATION_IN_PROGRESS", "Mutation request is in progress.");
      }
      try {
        const updated = await dynamo.send(new UpdateItemCommand({
          TableName: tableName,
          Key: mutationKey(binding),
          UpdateExpression:
            "SET #leaseToken = :leaseToken,"
            + " #leaseExpiresAt = :leaseExpiresAt,"
            + " #updatedAt = :updatedAt,"
            + " #expiresAt = :expiresAt",
          ConditionExpression:
            "#status = :inProgress"
            + " AND #leaseExpiresAt = :previousLeaseExpiresAt",
          ExpressionAttributeNames: {
            "#status": "status",
            "#leaseToken": "leaseToken",
            "#leaseExpiresAt": "leaseExpiresAt",
            "#updatedAt": "updatedAt",
            "#expiresAt": "expiresAt",
          },
          ExpressionAttributeValues: {
            ":inProgress": stringAttribute("IN_PROGRESS"),
            ":leaseToken": stringAttribute(leaseToken),
            ":leaseExpiresAt": stringAttribute(
              new Date(
                Date.parse(timestamp) + MUTATION_LEASE_MS,
              ).toISOString(),
            ),
            ":previousLeaseExpiresAt":
              stringAttribute(stored.leaseExpiresAt),
            ":updatedAt": stringAttribute(timestamp),
            ":expiresAt": expiryAttribute(timestamp),
          },
        }));
        validateResponse(updated);
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          fail("MUTATION_IN_PROGRESS", "Mutation request is in progress.");
        }
        throw error;
      }
      return {
        status: "CLAIMED",
        claim: {
          ...binding,
          resourceId: stored.resourceId,
          leaseToken,
        },
      };
    },

    async completeMutation(input) {
      if (
        !exact(input, ["claim", "result"])
        || !exact(input.result, ["resourceType", "resourceId"])
      ) {
        fail("INVALID_MUTATION", "Mutation request is invalid.");
      }
      const claim = validateMutationBinding(input.claim);
      if (
        input.result.resourceType !== claim.resourceType
        || input.result.resourceId !== claim.resourceId
      ) {
        fail("INVALID_MUTATION", "Mutation request is invalid.");
      }
      const timestamp = clockTimestamp(now);
      const response = await dynamo.send(new UpdateItemCommand({
        TableName: tableName,
        Key: mutationKey(claim),
        UpdateExpression:
          "SET #status = :succeeded,"
          + " #result = :result,"
          + " #updatedAt = :updatedAt,"
          + " #expiresAt = :expiresAt",
        ConditionExpression:
          "#entityType = :mutationType"
          + " AND #status = :inProgress"
          + " AND #leaseToken = :leaseToken",
        ExpressionAttributeNames: {
          "#entityType": "entityType",
          "#status": "status",
          "#leaseToken": "leaseToken",
          "#result": "result",
          "#updatedAt": "updatedAt",
          "#expiresAt": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":mutationType": stringAttribute("JOURNEY_MUTATION"),
          ":inProgress": stringAttribute("IN_PROGRESS"),
          ":succeeded": stringAttribute("SUCCEEDED"),
          ":leaseToken": stringAttribute(claim.leaseToken),
          ":result": attribute(input.result),
          ":updatedAt": stringAttribute(timestamp),
          ":expiresAt": expiryAttribute(timestamp),
        },
      }));
      validateResponse(response);
      return structuredClone(input.result);
    },

    async putGitHubAuthorizationIntent(input) {
      if (!exact(input, GITHUB_AUTHORIZATION_PUT_KEYS)) {
        fail(
          "INVALID_GITHUB_AUTHORIZATION",
          "GitHub authorization intent is invalid.",
        );
      }
      const timestamp = clockTimestamp(now);
      const record = validateGitHubAuthorizationIntent(
        input.record,
        timestamp,
        { requireUnconsumed: true },
      );
      try {
        const response = await dynamo.send(new PutItemCommand({
          TableName: tableName,
          Item: githubAuthorizationIntentItem(record),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }));
        validateResponse(response);
        return record;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          const response = await dynamo.send(new GetItemCommand({
            TableName: tableName,
            Key: githubAuthorizationKey(record.state),
            ConsistentRead: true,
          }));
          validateResponse(response);
          if (response.Item !== undefined) {
            const stored = decodeGitHubAuthorizationIntentItem(
              response.Item,
              timestamp,
            );
            if (
              sameGitHubAuthorizationBinding(stored, record)
              && stored.consumedAt === null
              && Date.parse(stored.expiresAt) > Date.parse(timestamp)
            ) {
              return stored;
            }
          }
          fail(
            "GITHUB_AUTHORIZATION_CONFLICT",
            "GitHub authorization intent conflicted.",
          );
        }
        throw error;
      }
    },

    async consumeGitHubAuthorizationIntent(input) {
      if (
        !exact(input, GITHUB_AUTHORIZATION_CONSUME_KEYS)
        || !GITHUB_AUTHORIZATION_STATE_PATTERN.test(input.state)
      ) {
        fail(
          "INVALID_GITHUB_AUTHORIZATION",
          "GitHub authorization intent is invalid.",
        );
      }
      const timestamp = clockTimestamp(now);
      try {
        const response = await dynamo.send(new UpdateItemCommand({
          TableName: tableName,
          Key: githubAuthorizationKey(input.state),
          UpdateExpression:
            "SET #consumedAt = :consumedAt,"
            + " #record.#consumedAt = :consumedAt",
          ConditionExpression:
            "#entityType = :entityType"
            + " AND #state = :state"
            + " AND #consumedAt = :unconsumed"
            + " AND #expiresAt > :now",
          ExpressionAttributeNames: {
            "#entityType": "entityType",
            "#state": "state",
            "#consumedAt": "consumedAt",
            "#record": "record",
            "#expiresAt": "expiresAt",
          },
          ExpressionAttributeValues: {
            ":entityType": stringAttribute("GITHUB_AUTHORIZATION"),
            ":state": stringAttribute(input.state),
            ":unconsumed": { NULL: true },
            ":consumedAt": stringAttribute(timestamp),
            ":now": authorizationExpiryAttribute(timestamp),
          },
          ReturnValues: "ALL_NEW",
        }));
        validateResponse(response);
        if (response.Attributes === undefined) {
          fail(
            "JOURNEY_STATE_UNAVAILABLE",
            "Journey state is unavailable.",
          );
        }
        const record = decodeGitHubAuthorizationIntentItem(
          response.Attributes,
          timestamp,
        );
        if (
          record.state !== input.state
          || record.consumedAt !== timestamp
        ) {
          fail(
            "GITHUB_AUTHORIZATION_CONFLICT",
            "GitHub authorization intent conflicted.",
          );
        }
        return record;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          fail(
            "GITHUB_AUTHORIZATION_CONFLICT",
            "GitHub authorization intent conflicted.",
          );
        }
        throw error;
      }
    },

    getJourney(input) {
      return read(
        "JOURNEY",
        input,
        GET_JOURNEY_KEYS,
        "journeyId",
        "JOURNEY_SCOPE_MISMATCH",
      );
    },

    putJourney(input) {
      return put("JOURNEY", input, "JOURNEY_CONFLICT");
    },

    getDelivery(input) {
      return read(
        "DELIVERY",
        input,
        GET_DELIVERY_KEYS,
        "deliveryId",
        "DELIVERY_SCOPE_MISMATCH",
      );
    },

    putDeliveryIntent(input) {
      return put("DELIVERY", input, "DELIVERY_CONFLICT");
    },

    async checkpointDelivery(input) {
      if (!exact(input, CHECKPOINT_INPUT_KEYS)) {
        fail(
          "INVALID_DELIVERY_CHECKPOINT",
          "Delivery checkpoint is invalid.",
        );
      }
      const timestamp = clockTimestamp(now);
      const checkpoint = validateCheckpoint(input.checkpoint);
      if (
        !validString(input.actor, SUBJECT_PATTERN, 256)
        || !DOMAIN_PATTERN.test(input.domainId)
        || !["admin", "lead", "builder"].includes(input.role)
        || !ID_PATTERN.test(input.deliveryId)
        || !(PREVIOUS_STATUS.get(checkpoint.status) === input.expectedStatus
          || (checkpoint.status === "INITIAL_SOURCE_COMMITTED" && input.expectedStatus === "REPOSITORY_CREATED")
          || (checkpoint.status === "COMPLETED" && input.expectedStatus === "INITIAL_SOURCE_COMMITTED"))
        || checkpoint.at !== timestamp
      ) {
        fail(
          "INVALID_DELIVERY_CHECKPOINT",
          "Delivery checkpoint is invalid.",
        );
      }
      const expressionAttributeNames = {
        "#entityType": "entityType",
        "#actor": "actor",
        "#domainId": "domainId",
        "#role": "role",
        "#status": "status",
        "#updatedAt": "updatedAt",
        "#record": "record",
        "#checkpoints": "checkpoints",
        "#manifestFingerprint": "manifestFingerprint",
        "#expiresAt": "expiresAt",
      };
      const expressionAttributeValues = {
        ":entityType": stringAttribute("DELIVERY"),
        ":actor": stringAttribute(input.actor),
        ":domainId": stringAttribute(input.domainId),
        ":role": stringAttribute(input.role),
        ":expectedStatus": stringAttribute(input.expectedStatus),
        ":nextStatus": stringAttribute(checkpoint.status),
        ":updatedAt": stringAttribute(checkpoint.at),
        ":checkpoint": { L: [attribute(checkpoint)] },
        ":expiresAt": expiryAttribute(checkpoint.at),
      };
      let condition = "#entityType = :entityType"
        + " AND #actor = :actor"
        + " AND #domainId = :domainId"
        + " AND #role = :role"
        + " AND #status = :expectedStatus"
        + " AND attribute_exists(#manifestFingerprint)";
      if (checkpoint.status === "APPROVED") {
        expressionAttributeNames["#previewExpiresAt"] = "previewExpiresAt";
        expressionAttributeValues[":now"] = stringAttribute(timestamp);
        condition += " AND #previewExpiresAt > :now";
      }
      try {
        const response = await dynamo.send(new UpdateItemCommand({
          TableName: tableName,
          Key: {
            pk: stringAttribute(
              `DELIVERY#${input.actor}#${input.deliveryId}`,
            ),
            sk: stringAttribute("DELIVERY"),
          },
          UpdateExpression:
            "SET #status = :nextStatus,"
            + " #updatedAt = :updatedAt,"
            + " #expiresAt = :expiresAt,"
            + " #record.#status = :nextStatus,"
            + " #record.#updatedAt = :updatedAt,"
            + " #record.#checkpoints ="
            + " list_append(#record.#checkpoints, :checkpoint)",
          ConditionExpression: condition,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: "ALL_NEW",
        }));
        validateResponse(response);
        if (response.Attributes === undefined) {
          fail(
            "JOURNEY_STATE_UNAVAILABLE",
            "Journey state is unavailable.",
          );
        }
        const stored = decodeItem(
          "DELIVERY",
          response.Attributes,
          timestamp,
        ).record;
        if (
          stored.actor !== input.actor
          || stored.domainId !== input.domainId
          || stored.id !== input.deliveryId
          || !isDeepStrictEqual(stored.checkpoints.at(-1), checkpoint)
        ) {
          fail("DELIVERY_CONFLICT", "DELIVERY write conflicted.");
        }
        return stored;
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        const response = await dynamo.send(new GetItemCommand({
          TableName: tableName,
          Key: {
            pk: stringAttribute(
              `DELIVERY#${input.actor}#${input.deliveryId}`,
            ),
            sk: stringAttribute("DELIVERY"),
          },
          ConsistentRead: true,
        }));
        validateResponse(response);
        if (response.Item === undefined) {
          fail("DELIVERY_CONFLICT", "DELIVERY write conflicted.");
        }
        const stored = decodeItem("DELIVERY", response.Item, timestamp).record;
        if (
          stored.actor !== input.actor
          || stored.domainId !== input.domainId
          || stored.id !== input.deliveryId
          || stored.status !== checkpoint.status
          || stored.checkpoints.at(-1)?.status !== checkpoint.status
          || !isDeepStrictEqual(
            stored.checkpoints.at(-1)?.github,
            checkpoint.github,
          )
        ) {
          fail("DELIVERY_CONFLICT", "DELIVERY write conflicted.");
        }
        return stored;
      }
    },
  });
}
