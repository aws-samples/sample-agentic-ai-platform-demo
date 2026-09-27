import https from "node:https";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  createPlatformState,
  validateDomainRecord,
} from "./state.mjs";

const BASELINE_DOMAIN_IDS = [
  "platform",
  "customer_support",
  "operations",
];
const BASELINE_DOMAIN_ID_SET = new Set(BASELINE_DOMAIN_IDS);
const RESOURCE_PROPERTY_KEYS = new Set([
  "ServiceToken",
  "ServiceTimeout",
  "TableName",
  "Domains",
]);
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const OPERATION_FAILED_REASON =
  "Baseline domain seed operation failed.";
const RESPONSE_FAILED_REASON =
  "Baseline domain seed response delivery failed.";
const DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_SUCCESS_RESPONSE_ATTEMPTS = 3;
const DEFAULT_RESPONSE_RETRY_DELAY_MS = 250;
const DEFAULT_ACCESS_RETRY_ATTEMPTS = 12;
const DEFAULT_ACCESS_RETRY_DELAY_MS = 5_000;
const OPERATION_FAILURE_DIAGNOSTICS = new Map([
  ["AccessDeniedException", "AWS_ACCESS_DENIED"],
  ["ResourceNotFoundException", "AWS_RESOURCE_NOT_FOUND"],
  ["ValidationException", "AWS_VALIDATION_ERROR"],
  ["INVALID_BASELINE_SEED", "INVALID_BASELINE_SEED"],
  ["BASELINE_IDENTITY_CONFLICT", "BASELINE_IDENTITY_CONFLICT"],
  ["DOMAIN_CONFLICT", "DOMAIN_CONFLICT"],
  ["INVALID_DOMAIN", "INVALID_DOMAIN"],
  ["INVALID_DOMAIN_ID", "INVALID_DOMAIN_ID"],
  ["MALFORMED_DYNAMODB_RESPONSE", "MALFORMED_DYNAMODB_RESPONSE"],
]);

function invalidSeed(message = "Baseline domain seed properties are malformed.") {
  const error = new Error(message);
  error.name = "BaselineSeedValidationError";
  error.code = "INVALID_BASELINE_SEED";
  throw error;
}

function identityConflict() {
  const error = new Error(
    "Existing baseline domain registry identity does not match deployment.",
  );
  error.name = "BaselineIdentityConflictError";
  error.code = "BASELINE_IDENTITY_CONFLICT";
  throw error;
}

function verifyRegistryIdentity(existing, desired) {
  if (
    existing.registryId !== desired.registryId
    || existing.registryArn !== desired.registryArn
  ) {
    identityConflict();
  }
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

function normalizeSeedDomain(domain) {
  if (!isPlainObject(domain)) return domain;
  if (!Object.hasOwn(domain, "tokenBudget")) {
    return { ...domain, tokenBudget: null };
  }
  if (
    typeof domain.tokenBudget === "string"
    && /^[1-9][0-9]*$/.test(domain.tokenBudget)
  ) {
    const tokenBudget = Number(domain.tokenBudget);
    if (Number.isSafeInteger(tokenBudget)) {
      return { ...domain, tokenBudget };
    }
  }
  return domain;
}

function physicalResourceId(tableName) {
  return `platform-baseline-domains:${tableName}`;
}

function validatedPhysicalResourceId(value) {
  const prefix = "platform-baseline-domains:";
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    return null;
  }
  const tableName = value.slice(prefix.length);
  return TABLE_NAME_PATTERN.test(tableName)
    && value === physicalResourceId(tableName)
      ? value
      : null;
}

function validateSeedProperties(properties, generatedAt) {
  if (
    !isPlainObject(properties)
    || Object.keys(properties).some((key) => !RESOURCE_PROPERTY_KEYS.has(key))
    || typeof properties.TableName !== "string"
    || !TABLE_NAME_PATTERN.test(properties.TableName)
    || !Array.isArray(properties.Domains)
    || properties.Domains.length !== BASELINE_DOMAIN_IDS.length
  ) {
    invalidSeed();
  }
  const domains = properties.Domains.map((domain) => {
    try {
      const normalizedDomain = normalizeSeedDomain(domain);
      return validateDomainRecord(normalizedDomain, generatedAt);
    } catch {
      invalidSeed();
    }
  });
  const ids = domains.map(({ id }) => id);
  if (
    new Set(ids).size !== ids.length
    || ids.some((id) => !BASELINE_DOMAIN_ID_SET.has(id))
    || BASELINE_DOMAIN_IDS.some((id) => !ids.includes(id))
  ) {
    invalidSeed("Baseline domain IDs are malformed.");
  }
  return {
    tableName: properties.TableName,
    domains: BASELINE_DOMAIN_IDS.map(
      (id) => domains.find((domain) => domain.id === id),
    ),
  };
}

function accessRetryingDynamo(
  dynamo,
  {
    attempts,
    delayMs,
    sleep,
  },
) {
  return {
    async send(command) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return await dynamo.send(command);
        } catch (error) {
          const accessDenied = error?.name === "AccessDeniedException"
            || error?.code === "AccessDeniedException";
          if (!accessDenied || attempt + 1 >= attempts) throw error;
          await sleep(delayMs);
        }
      }
      throw new Error("DynamoDB retry attempts were exhausted.");
    },
  };
}

export async function reconcileBaselineDomains(
  event,
  {
    accessRetryAttempts = DEFAULT_ACCESS_RETRY_ATTEMPTS,
    accessRetryDelayMs = DEFAULT_ACCESS_RETRY_DELAY_MS,
    dynamo,
    now = () => new Date().toISOString(),
    sleep = defaultSleep,
  },
) {
  if (!isPlainObject(event)) invalidSeed();
  if (event.RequestType === "Delete") {
    return {
      PhysicalResourceId:
        typeof event.PhysicalResourceId === "string"
        && event.PhysicalResourceId.length > 0
          ? event.PhysicalResourceId
          : "platform-baseline-domains:retained",
    };
  }
  if (event.RequestType !== "Create" && event.RequestType !== "Update") {
    invalidSeed("Unsupported custom resource request type.");
  }
  if (event.RequestType === "Create") {
    if (event.PhysicalResourceId !== undefined) {
      invalidSeed("Create must not include a physical resource ID.");
    }
  }
  const generatedAt = now();
  if (event.RequestType === "Update") {
    const oldSeed = validateSeedProperties(
      event.OldResourceProperties,
      generatedAt,
    );
    if (
      typeof event.PhysicalResourceId !== "string"
      || event.PhysicalResourceId
        !== physicalResourceId(oldSeed.tableName)
    ) {
      invalidSeed(
        "Update physical resource ID does not match the old table.",
      );
    }
  }
  const { tableName, domains } = validateSeedProperties(
    event.ResourceProperties,
    generatedAt,
  );
  const state = createPlatformState({
    tableName,
    dynamo: accessRetryingDynamo(dynamo, {
      attempts: accessRetryAttempts,
      delayMs: accessRetryDelayMs,
      sleep,
    }),
    now: () => generatedAt,
  });
  let createdCount = 0;
  let existingCount = 0;

  for (const domain of domains) {
    const existing = await state.getDomain(domain.id);
    if (existing) {
      verifyRegistryIdentity(existing, domain);
      existingCount += 1;
      continue;
    }
    try {
      await state.putDomain(domain);
      createdCount += 1;
    } catch (error) {
      if (error?.code !== "DOMAIN_CONFLICT") throw error;
      const concurrent = await state.getDomain(domain.id);
      if (!concurrent) throw error;
      verifyRegistryIdentity(concurrent, domain);
      existingCount += 1;
    }
  }

  return {
    PhysicalResourceId: physicalResourceId(tableName),
    Data: {
      CreatedCount: createdCount,
      ExistingCount: existingCount,
    },
  };
}

function failurePhysicalResourceId(event) {
  const existingPhysicalResourceId = validatedPhysicalResourceId(
    event?.PhysicalResourceId,
  );
  if (existingPhysicalResourceId !== null) {
    return existingPhysicalResourceId;
  }
  const tableName = event?.ResourceProperties?.TableName;
  if (
    event?.RequestType === "Create"
    && typeof tableName === "string"
    && TABLE_NAME_PATTERN.test(tableName)
  ) {
    return physicalResourceId(tableName);
  }
  return "platform-baseline-domains:failed";
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function sendCloudFormationResponse(
  event,
  context,
  status,
  result,
  reason,
  {
    requestTransport = https.request,
    timeoutMs = DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let responseUrl;
  try {
    responseUrl = new URL(event.ResponseURL);
  } catch {
    return Promise.reject(
      new Error("CloudFormation response upload URL is invalid."),
    );
  }
  if (
    typeof requestTransport !== "function"
    || typeof setTimer !== "function"
    || typeof clearTimer !== "function"
    || typeof timeoutMs !== "number"
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
  ) {
    return Promise.reject(
      new Error("CloudFormation response upload configuration is invalid."),
    );
  }
  const body = JSON.stringify({
    Status: status,
    Reason: reason,
    PhysicalResourceId:
      result?.PhysicalResourceId
      ?? failurePhysicalResourceId(event),
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: result?.Data ?? {},
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let request;
    let response;
    let onResponseEnd;
    let onResponseError;
    let onRequestError;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimer(timer);
      }
      request?.removeListener?.("error", onRequestError);
      response?.removeListener?.("error", onResponseError);
      response?.removeListener?.("end", onResponseEnd);
    };
    const settle = (operation, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation(value);
    };
    const rejectUpload = (message) => {
      settle(reject, new Error(message));
    };

    try {
      request = requestTransport(
        {
          hostname: responseUrl.hostname,
          path: `${responseUrl.pathname}${responseUrl.search}`,
          method: "PUT",
          headers: {
            "content-length": Buffer.byteLength(body),
            "content-type": "",
          },
        },
        (incomingResponse) => {
          response = incomingResponse;
          if (settled) {
            response.resume();
            return;
          }
          onResponseError = () => {
            rejectUpload("CloudFormation response upload failed.");
          };
          onResponseEnd = () => {
            if (
              Number.isInteger(response.statusCode)
              && response.statusCode >= 200
              && response.statusCode < 300
            ) {
              settle(resolve);
              return;
            }
            rejectUpload(
              "CloudFormation response upload returned a non-2xx status.",
            );
          };
          response.once("error", onResponseError);
          response.once("end", onResponseEnd);
          response.resume();
        },
      );
      if (
        !request
        || typeof request.once !== "function"
        || typeof request.end !== "function"
        || typeof request.destroy !== "function"
      ) {
        throw new Error("Invalid request transport.");
      }
      if (settled) return;
      onRequestError = () => {
        rejectUpload("CloudFormation response upload failed.");
      };
      request.once("error", onRequestError);
      timer = setTimer(() => {
        rejectUpload("CloudFormation response upload timed out.");
        try {
          request.destroy();
        } catch {
          // The sanitized timeout result is authoritative.
        }
      }, timeoutMs);
      request.end(body);
    } catch {
      try {
        request?.destroy();
      } catch {
        // The sanitized upload failure below is authoritative.
      }
      rejectUpload("CloudFormation response upload failed.");
    }
  });
}

function operationFailureDiagnostic(error) {
  return OPERATION_FAILURE_DIAGNOSTICS.get(error?.code)
    ?? OPERATION_FAILURE_DIAGNOSTICS.get(error?.name)
    ?? "UNEXPECTED_ERROR";
}

function safeType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function domainShapeDiagnostic(domains) {
  if (!Array.isArray(domains)) return undefined;
  return domains.map((domain, index) => {
    if (!isPlainObject(domain)) {
      return {
        index,
        type: safeType(domain),
      };
    }
    const keys = Object.keys(domain).sort();
    return {
      index,
      type: "object",
      keys,
      fields: Object.fromEntries(
        keys.map((key) => [key, safeType(domain[key])]),
      ),
    };
  });
}

function seedShapeDiagnostic(event) {
  const properties = isPlainObject(event)
    ? event.ResourceProperties
    : undefined;
  const domains = isPlainObject(properties)
    ? properties.Domains
    : undefined;
  return JSON.stringify({
    domains: safeType(domains),
    domainsLength: Array.isArray(domains) ? domains.length : null,
    event: safeType(event),
    properties: safeType(properties),
    serviceTimeout: safeType(
      isPlainObject(properties) ? properties.ServiceTimeout : undefined,
    ),
    serviceToken: safeType(
      isPlainObject(properties) ? properties.ServiceToken : undefined,
    ),
    tableName: safeType(
      isPlainObject(properties) ? properties.TableName : undefined,
    ),
    ...(Array.isArray(domains)
      ? { domainShapes: domainShapeDiagnostic(domains) }
      : {}),
  });
}

function logControlledFailure(logError, message, diagnostic, context) {
  try {
    if (diagnostic && context) {
      logError(message, diagnostic, context);
    } else if (diagnostic) {
      logError(message, diagnostic);
    } else {
      logError(message);
    }
  } catch {
    // Logging must not expose or replace the controlled failure.
  }
}

export async function handleBaselineSeed(
  event,
  context,
  dynamoClient,
  {
    sendResponse = sendCloudFormationResponse,
    logError = console.error,
    now = () => new Date().toISOString(),
    responseRetryDelayMs = DEFAULT_RESPONSE_RETRY_DELAY_MS,
    sleep = defaultSleep,
    successResponseAttempts = DEFAULT_SUCCESS_RESPONSE_ATTEMPTS,
  } = {},
) {
  let result;
  try {
    result = await reconcileBaselineDomains(event, {
      dynamo: dynamoClient,
      now,
    });
  } catch (error) {
    result = {
      PhysicalResourceId: failurePhysicalResourceId(event),
    };
    const diagnostic = operationFailureDiagnostic(error);
    logControlledFailure(
      logError,
      OPERATION_FAILED_REASON,
      diagnostic,
      diagnostic === "INVALID_BASELINE_SEED"
        ? seedShapeDiagnostic(event)
        : undefined,
    );
    try {
      await sendResponse(
        event,
        context,
        "FAILED",
        result,
        OPERATION_FAILED_REASON,
      );
    } catch {
      logControlledFailure(logError, RESPONSE_FAILED_REASON);
      throw new Error(RESPONSE_FAILED_REASON);
    }
    return result;
  }

  for (let attempt = 0; attempt < successResponseAttempts; attempt += 1) {
    try {
      await sendResponse(
        event,
        context,
        "SUCCESS",
        result,
        "Baseline domain seed operation completed.",
      );
      return result;
    } catch {
      if (attempt + 1 < successResponseAttempts) {
        try {
          await sleep(responseRetryDelayMs);
        } catch {
          // A failed backoff must not replay the completed seed operation.
        }
      }
    }
  }

  const terminalFailureResult = {
    PhysicalResourceId: failurePhysicalResourceId(event),
  };
  try {
    await sendResponse(
      event,
      context,
      "FAILED",
      terminalFailureResult,
      RESPONSE_FAILED_REASON,
    );
    return terminalFailureResult;
  } catch {
    logControlledFailure(logError, RESPONSE_FAILED_REASON);
    throw new Error(RESPONSE_FAILED_REASON);
  }
}

const dynamo = new DynamoDBClient({});

export async function handler(event, context) {
  return handleBaselineSeed(event, context, dynamo);
}
