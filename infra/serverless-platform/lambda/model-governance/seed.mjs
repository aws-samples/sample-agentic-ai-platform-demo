import { createHash } from "node:crypto";
import {
  sendCloudFormationResponse,
} from "../platform-admin/seed.mjs";

const BASELINE_DOMAINS = Object.freeze([
  "customer_support",
  "operations",
  "platform",
]);
const RESOURCE_PROPERTY_KEYS = new Set([
  "ServiceToken",
  "ServiceTimeout",
  "TableName",
  "ModelId",
  "ModelIds",
  "AllowedDomains",
  "Limits",
]);
const LIMIT_KEYS = new Set([
  "requestsPerMinute",
  "tokensPerMinute",
  "connectionsPerSecond",
]);
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const LIMIT_MAXIMUMS = Object.freeze({
  requestsPerMinute: 1_000_000,
  tokensPerMinute: 1_000_000_000,
  connectionsPerSecond: 10_000,
});
const DEPLOYMENT_IDENTITY = Object.freeze({
  actor: "deployment:baseline",
  role: "admin",
  activeDomain: null,
  domainIds: BASELINE_DOMAINS,
});
const OPERATION_FAILED_REASON =
  "Baseline model policy seed operation failed.";
const OPERATION_SUCCEEDED_REASON =
  "Baseline model policy seed operation completed.";
const RESPONSE_FAILED_REASON =
  "Baseline model policy seed response delivery failed.";

function fail(code, message) {
  const error = new Error(message);
  error.name = "BaselineModelPolicySeedError";
  error.code = code;
  throw error;
}

function invalidSeed() {
  fail(
    "INVALID_BASELINE_MODEL_POLICY_SEED",
    "Baseline model policy seed properties are malformed.",
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

function exactKeys(value, expected) {
  return (
    isPlainObject(value)
    && Reflect.ownKeys(value).length === expected.size
    && Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && expected.has(key),
    )
  );
}

function normalizeLimit(value, field) {
  const limit = typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > LIMIT_MAXIMUMS[field]
  ) {
    invalidSeed();
  }
  return limit;
}

function validateProperties(properties) {
  if (
    !isPlainObject(properties)
    || Reflect.ownKeys(properties).some(
      (key) =>
        typeof key !== "string"
        || !RESOURCE_PROPERTY_KEYS.has(key),
    )
    || typeof properties.TableName !== "string"
    || !TABLE_NAME_PATTERN.test(properties.TableName)
    || typeof properties.ModelId !== "string"
    || !MODEL_ID_PATTERN.test(properties.ModelId)
    || (
      properties.ModelIds !== undefined
      && (
        !Array.isArray(properties.ModelIds)
        || properties.ModelIds.length > 32
        || properties.ModelIds.some(
          (id) => typeof id !== "string" || !MODEL_ID_PATTERN.test(id),
        )
        || new Set(properties.ModelIds).size !== properties.ModelIds.length
      )
    )
    || !Array.isArray(properties.AllowedDomains)
    || properties.AllowedDomains.length !== BASELINE_DOMAINS.length
    || !BASELINE_DOMAINS.every(
      (domainId, index) => properties.AllowedDomains[index] === domainId,
    )
    || !exactKeys(properties.Limits, LIMIT_KEYS)
  ) {
    invalidSeed();
  }
  return {
    tableName: properties.TableName,
    modelId: properties.ModelId,
    // The curated baseline catalog (launch-window models). The starter model
    // is always first so its failure remains a hard deploy failure.
    modelIds: [...new Set([
      properties.ModelId,
      ...(properties.ModelIds ?? []),
    ])],
    allowedDomains: [...BASELINE_DOMAINS],
    limits: Object.fromEntries(
      [...LIMIT_KEYS].map((field) => [
        field,
        normalizeLimit(properties.Limits[field], field),
      ]),
    ),
  };
}

function physicalResourceId(tableName) {
  return `platform-baseline-model-policy:${tableName}`;
}

function validPhysicalResourceId(value) {
  const prefix = "platform-baseline-model-policy:";
  if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  const tableName = value.slice(prefix.length);
  return TABLE_NAME_PATTERN.test(tableName)
    && value === physicalResourceId(tableName);
}

function failurePhysicalResourceId(event) {
  if (validPhysicalResourceId(event?.PhysicalResourceId)) {
    return event.PhysicalResourceId;
  }
  const tableName = event?.ResourceProperties?.TableName;
  if (
    typeof tableName === "string"
    && TABLE_NAME_PATTERN.test(tableName)
  ) {
    return physicalResourceId(tableName);
  }
  return "platform-baseline-model-policy:failed";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(
      (key) => [key, canonicalize(value[key])],
    ),
  );
}

function requestId(payload) {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex")
    .slice(0, 24);
  return `deployment-baseline-model-policy-${digest}`;
}

function validateCatalog(value) {
  if (
    !isPlainObject(value)
    || value.ok !== true
    || value.source !== "aws"
    || !Array.isArray(value.models)
    || value.models.length === 0
    || value.models.length > 100
  ) {
    fail(
      "BASELINE_MODEL_POLICY_UNAVAILABLE",
      "The live model inventory is unavailable.",
    );
  }
  const models = value.models.map((entry) => {
    if (
      !isPlainObject(entry)
      || !MODEL_ID_PATTERN.test(entry.id)
      || !Object.hasOwn(entry, "policy")
      || (
        entry.policy !== null
        && !isPlainObject(entry.policy)
      )
    ) {
      fail(
        "BASELINE_MODEL_POLICY_UNAVAILABLE",
        "The live model inventory is malformed.",
      );
    }
    return { id: entry.id, policy: entry.policy };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(models.map(({ id }) => id)).size !== models.length) {
    fail(
      "BASELINE_MODEL_POLICY_UNAVAILABLE",
      "The live model inventory contains duplicate models.",
    );
  }
  return models;
}

function policyCoversDomains(policy, allowedDomains) {
  return (
    isPlainObject(policy)
    && policy.applicationStatus === "ACTIVE"
    && Array.isArray(policy.allowedDomains)
    && allowedDomains.every(
      (domainId) => policy.allowedDomains.includes(domainId),
    )
  );
}

function validateAppliedPolicy(policy, intended) {
  if (
    !isPlainObject(policy)
    || policy.modelId !== intended.modelId
    || policy.applicationStatus !== "ACTIVE"
    || !Array.isArray(policy.allowedDomains)
    || policy.allowedDomains.length !== intended.allowedDomains.length
    || intended.allowedDomains.some(
      (domainId, index) => policy.allowedDomains[index] !== domainId,
    )
    || !Array.isArray(policy.requestableDomains)
    || policy.requestableDomains.length !== 0
  ) {
    fail(
      "BASELINE_MODEL_POLICY_UNAVAILABLE",
      "The baseline model policy was not applied.",
    );
  }
}

export async function reconcileBaselineModelPolicy(
  event,
  { service } = {},
) {
  if (
    !isPlainObject(event)
    || !service
    || typeof service.readCatalog !== "function"
    || typeof service.putPolicy !== "function"
  ) {
    invalidSeed();
  }
  if (event.RequestType === "Delete") {
    return {
      PhysicalResourceId:
        validPhysicalResourceId(event.PhysicalResourceId)
          ? event.PhysicalResourceId
          : "platform-baseline-model-policy:retained",
    };
  }
  if (event.RequestType !== "Create" && event.RequestType !== "Update") {
    invalidSeed();
  }
  const properties = validateProperties(event.ResourceProperties);
  if (
    event.RequestType === "Create"
    && event.PhysicalResourceId !== undefined
  ) {
    invalidSeed();
  }
  if (
    event.RequestType === "Update"
    && !validPhysicalResourceId(event.PhysicalResourceId)
  ) {
    invalidSeed();
  }

  let catalog;
  try {
    catalog = validateCatalog(await service.readCatalog({
      identity: DEPLOYMENT_IDENTITY,
    }));
  } catch (error) {
    if (error?.code?.startsWith("BASELINE_MODEL_POLICY_")) throw error;
    fail(
      "BASELINE_MODEL_POLICY_UNAVAILABLE",
      "The live model inventory is unavailable.",
    );
  }
  const starterModel = catalog.find(
    ({ id }) => id === properties.modelId,
  );
  if (!starterModel) {
    fail(
      "BASELINE_MODEL_POLICY_UNAVAILABLE",
      "The configured starter model is not available.",
    );
  }
  // One reconcile per curated model. The starter model's failure fails the
  // deployment (unchanged contract). A curated launch-window model the
  // gateway has not discovered yet is SKIPPED and reported — a brand-new
  // Bedrock launch can precede gateway pickup — and an admin-managed policy
  // on a curated model is left alone (the platform team's explicit decision
  // outranks the deployment default).
  const applied = [];
  const skipped = [];
  const retained = [];
  for (const modelId of properties.modelIds) {
    const configuredModel = catalog.find(({ id }) => id === modelId);
    const starter = modelId === properties.modelId;
    if (!configuredModel) {
      if (starter) {
        fail(
          "BASELINE_MODEL_POLICY_UNAVAILABLE",
          "The configured starter model is not available.",
        );
      }
      skipped.push(modelId);
      continue;
    }
    if (
      policyCoversDomains(
        configuredModel.policy,
        properties.allowedDomains,
      )
    ) {
      retained.push(modelId);
      continue;
    }
    // Upgrade only the exact deployment-owned v1 baseline. Administrator-
    // managed policies and differing quotas still require an explicit
    // policy decision.
    const old = configuredModel.policy;
    const baselineUpgrade = old?.updatedBySubject === "deployment:baseline"
      && old.applicationStatus === "ACTIVE"
      && JSON.stringify(old.allowedDomains) === JSON.stringify(["customer_support", "operations"])
      && Array.isArray(old.requestableDomains) && old.requestableDomains.length === 0
      && [...LIMIT_KEYS].every(field => old.limits?.[field] === properties.limits[field]);
    if (configuredModel.policy !== null && !baselineUpgrade) {
      if (starter) {
        fail(
          "BASELINE_MODEL_POLICY_CONFLICT",
          "The configured starter model policy does not cover every baseline domain.",
        );
      }
      retained.push(modelId);
      continue;
    }
    const intended = {
      modelId: configuredModel.id,
      allowedDomains: properties.allowedDomains,
      requestableDomains: [],
      limits: properties.limits,
    };
    let appliedPolicy;
    try {
      appliedPolicy = await service.putPolicy({
        identity: DEPLOYMENT_IDENTITY,
        requestId: requestId(intended),
        ...intended,
      });
    } catch {
      fail(
        "BASELINE_MODEL_POLICY_UNAVAILABLE",
        "The baseline model policy could not be applied.",
      );
    }
    validateAppliedPolicy(appliedPolicy, intended);
    applied.push(modelId);
  }
  return {
    PhysicalResourceId: physicalResourceId(properties.tableName),
    Data: {
      Changed: applied.length > 0,
      ModelId: properties.modelId,
      AppliedModelIds: applied.join(","),
      RetainedModelIds: retained.join(","),
      SkippedModelIds: skipped.join(","),
    },
  };
}

export async function handleBaselineModelPolicySeed(
  event,
  context,
  service,
  {
    sendResponse = sendCloudFormationResponse,
    logError = console.error,
  } = {},
) {
  let result;
  try {
    result = await reconcileBaselineModelPolicy(event, { service });
  } catch (error) {
    result = {
      PhysicalResourceId: failurePhysicalResourceId(event),
    };
    try {
      logError(
        OPERATION_FAILED_REASON,
        typeof error?.code === "string"
          ? error.code
          : "UNEXPECTED_ERROR",
      );
    } catch {
      // Logging must not expose or replace the controlled response.
    }
    try {
      await sendResponse(
        event,
        context,
        "FAILED",
        result,
        OPERATION_FAILED_REASON,
      );
      return result;
    } catch {
      throw new Error(RESPONSE_FAILED_REASON);
    }
  }

  try {
    await sendResponse(
      event,
      context,
      "SUCCESS",
      result,
      OPERATION_SUCCEEDED_REASON,
    );
    return result;
  } catch {
    const failure = {
      PhysicalResourceId: failurePhysicalResourceId(event),
    };
    try {
      await sendResponse(
        event,
        context,
        "FAILED",
        failure,
        RESPONSE_FAILED_REASON,
      );
      return failure;
    } catch {
      throw new Error(RESPONSE_FAILED_REASON);
    }
  }
}
