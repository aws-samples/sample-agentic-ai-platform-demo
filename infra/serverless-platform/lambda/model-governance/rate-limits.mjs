import { createHash } from "node:crypto";

import {
  BatchPutGatewayRateLimitsCommand,
  ListGatewayRateLimitsCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  domainGatewaySourceIdentity,
} from "../workspace/gateway-source-identity.mjs";

const RATE_LIMIT_ID = "platform-model-domain-limits";
const DESCRIPTION = "Platform-managed model and domain traffic limits.";
const DIMENSION_KEYS = Object.freeze([
  "qualifiedModelId",
  "$.context.iam.sourceIdentity",
]);
const LIMIT_FIELDS = Object.freeze([
  "requestsPerMinute",
  "tokensPerMinute",
  "connectionsPerSecond",
]);
const LIMIT_MAXIMUMS = Object.freeze({
  requestsPerMinute: 1_000_000,
  tokensPerMinute: 1_000_000_000,
  connectionsPerSecond: 10_000,
});
const STATUS_VALUES = new Set([
  "ACTIVE",
  "CREATING",
  "UPDATING",
  "DELETING",
]);

const MAX_GATEWAY_RATE_LIMITS = 50;
const MAX_RATE_LIMIT_ENTRIES = 1000;
const MAX_DIMENSION_KEYS = 5;
const MAX_RATE_CONFIGS = 5;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_NEXT_TOKEN_LENGTH = 2048;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_DOMAIN_ID_LENGTH = 64;

const GATEWAY_IDENTIFIER_PATTERN = /^([0-9a-z]-?){1,100}-[0-9a-z]{10}$/;
const RATE_LIMIT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const DOMAIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function reconciliationError(code, message) {
  const error = new Error(message);
  error.name = "GatewayRateLimitReconciliationError";
  error.code = code;
  return error;
}

function invalidPolicy(message) {
  throw reconciliationError("INVALID_GATEWAY_RATE_LIMIT_POLICY", message);
}

function malformedResponse(message) {
  throw reconciliationError(
    "MALFORMED_GATEWAY_RATE_LIMIT_RESPONSE",
    message,
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validString(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum;
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateClient(client) {
  if (!isRecord(client) || typeof client.send !== "function") {
    throw reconciliationError(
      "INVALID_GATEWAY_RATE_LIMIT_CONFIG",
      "A Bedrock AgentCore Control client is required.",
    );
  }
}

function validateGatewayIdentifier(gatewayIdentifier) {
  if (
    !validString(gatewayIdentifier, 211)
    || !GATEWAY_IDENTIFIER_PATTERN.test(gatewayIdentifier)
  ) {
    throw reconciliationError(
      "INVALID_GATEWAY_RATE_LIMIT_CONFIG",
      "The Gateway identifier is invalid.",
    );
  }
}

function validateDomainArray(value, fieldName) {
  if (!Array.isArray(value)) {
    invalidPolicy(`${fieldName} must be an array.`);
  }
  if (value.length > MAX_RATE_LIMIT_ENTRIES) {
    throw reconciliationError(
      "RATE_LIMIT_ENTRY_LIMIT_EXCEEDED",
      "The native Gateway rate limit supports at most 1000 entries.",
    );
  }

  const domains = [];
  const seen = new Set();
  for (const domainId of value) {
    if (
      !validString(domainId, MAX_DOMAIN_ID_LENGTH)
      || !DOMAIN_ID_PATTERN.test(domainId)
    ) {
      invalidPolicy(`${fieldName} contains an invalid canonical domain ID.`);
    }
    if (seen.has(domainId)) {
      invalidPolicy(`${fieldName} contains a duplicate domain.`);
    }
    seen.add(domainId);
    domains.push(domainId);
  }
  return domains;
}

function validateLimits(value) {
  if (!isRecord(value)) {
    invalidPolicy("Missing model traffic limits.");
  }

  const keys = Object.keys(value);
  if (
    keys.length === 0
    || keys.length > LIMIT_FIELDS.length
    || keys.some((key) => !LIMIT_FIELDS.includes(key))
  ) {
    invalidPolicy("Unsupported model traffic limit.");
  }

  const limits = {};
  for (const field of keys) {
    const rate = value[field];
    if (rate === null) {
      continue;
    }
    if (
      !Number.isSafeInteger(rate)
      || rate <= 0
      || rate > LIMIT_MAXIMUMS[field]
    ) {
      invalidPolicy(`Unsafe ${field} rate value.`);
    }
    limits[field] = rate;
  }
  if (Object.keys(limits).length === 0) {
    invalidPolicy("Missing model traffic limits.");
  }
  return limits;
}

function rateConfigs(limits) {
  const translated = {};
  if (limits.requestsPerMinute !== undefined) {
    translated.requests = [{
      rate: limits.requestsPerMinute,
      period: "minute",
    }];
  }
  if (limits.tokensPerMinute !== undefined) {
    translated.tokens = [{
      rate: limits.tokensPerMinute,
      period: "minute",
    }];
  }
  if (limits.connectionsPerSecond !== undefined) {
    translated.connections = [{
      rate: limits.connectionsPerSecond,
      period: "second",
    }];
  }
  return translated;
}

function buildDesiredRateLimits(policies) {
  if (!Array.isArray(policies)) {
    invalidPolicy("Policies must be an array.");
  }
  if (policies.length > MAX_RATE_LIMIT_ENTRIES) {
    throw reconciliationError(
      "RATE_LIMIT_ENTRY_LIMIT_EXCEEDED",
      "The native Gateway rate limit supports at most 1000 entries.",
    );
  }

  const entries = [];
  const entryKeys = new Set();
  for (const policy of policies) {
    if (!isRecord(policy)) {
      invalidPolicy("Each model policy must be an object.");
    }
    if (
      !validString(policy.modelId, MAX_MODEL_ID_LENGTH)
      || /\s/.test(policy.modelId)
      || policy.modelId.includes("*")
    ) {
      invalidPolicy("Each model policy requires a valid model ID.");
    }

    const allowedDomains = validateDomainArray(
      policy.allowedDomains,
      "allowedDomains",
    );
    const requestableDomains = validateDomainArray(
      policy.requestableDomains,
      "requestableDomains",
    );
    const allowedSet = new Set(allowedDomains);
    if (requestableDomains.some((domainId) => allowedSet.has(domainId))) {
      invalidPolicy("Overlapping allowed and requestable domains are invalid.");
    }
    const limits = validateLimits(policy.limits);

    const domains = [...allowedDomains, ...requestableDomains].sort();
    for (const domainId of domains) {
      const entryKey = `${policy.modelId}\u0000${domainId}`;
      if (entryKeys.has(entryKey)) {
        invalidPolicy("Duplicate model-domain entries are invalid.");
      }
      entryKeys.add(entryKey);
      entries.push({
        dimensions: {
          [DIMENSION_KEYS[0]]: policy.modelId,
          [DIMENSION_KEYS[1]]: domainGatewaySourceIdentity(domainId),
        },
        ...rateConfigs(limits),
      });
      if (entries.length > MAX_RATE_LIMIT_ENTRIES) {
        throw reconciliationError(
          "RATE_LIMIT_ENTRY_LIMIT_EXCEEDED",
          "The native Gateway rate limit supports at most 1000 entries.",
        );
      }
    }
  }

  entries.sort((left, right) => {
    const modelOrder = compareStrings(
      left.dimensions[DIMENSION_KEYS[0]],
      right.dimensions[DIMENSION_KEYS[0]],
    );
    if (modelOrder !== 0) {
      return modelOrder;
    }
    return compareStrings(
      left.dimensions[DIMENSION_KEYS[1]],
      right.dimensions[DIMENSION_KEYS[1]],
    );
  });

  if (entries.length === 0) return [];
  return [{
    rateLimitId: RATE_LIMIT_ID,
    description: DESCRIPTION,
    dimensionKeys: [...DIMENSION_KEYS],
    entries,
  }];
}

function validateRateConfigArray(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_RATE_CONFIGS
  ) {
    malformedResponse(`${fieldName} rate configurations are malformed.`);
  }
  return value.map((config) => {
    if (
      !isRecord(config)
      || typeof config.rate !== "number"
      || !Number.isFinite(config.rate)
      || config.rate <= 0
      || !["second", "minute"].includes(config.period)
    ) {
      malformedResponse(`${fieldName} rate configurations are malformed.`);
    }
    return {
      rate: config.rate,
      period: config.period,
    };
  });
}

function canonicalizeEntry(entry, dimensionKeys) {
  if (!isRecord(entry) || !isRecord(entry.dimensions)) {
    malformedResponse("A Gateway rate-limit entry is malformed.");
  }

  const dimensionNames = Object.keys(entry.dimensions);
  if (
    dimensionNames.length !== dimensionKeys.length
    || dimensionKeys.some((key) => !own(entry.dimensions, key))
  ) {
    malformedResponse("A Gateway rate-limit entry has invalid dimensions.");
  }

  const dimensions = {};
  for (const key of dimensionKeys) {
    const value = entry.dimensions[key];
    if (!validString(value, MAX_MODEL_ID_LENGTH)) {
      malformedResponse("A Gateway rate-limit dimension value is malformed.");
    }
    dimensions[key] = value;
  }

  const requests = validateRateConfigArray(entry.requests, "Request");
  const tokens = validateRateConfigArray(entry.tokens, "Token");
  const connections = validateRateConfigArray(entry.connections, "Connection");
  if (
    requests === undefined
    && tokens === undefined
    && connections === undefined
  ) {
    malformedResponse("A Gateway rate-limit entry has no traffic limits.");
  }

  return {
    dimensions,
    ...(requests === undefined ? {} : { requests }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(connections === undefined ? {} : { connections }),
  };
}

function canonicalizeDetail(value, gatewayIdentifier) {
  if (!isRecord(value)) {
    malformedResponse("A Gateway rate-limit detail is malformed.");
  }
  if (
    !validString(value.rateLimitId, 100)
    || !RATE_LIMIT_ID_PATTERN.test(value.rateLimitId)
    || value.gatewayIdentifier !== gatewayIdentifier
    || (
      value.description !== undefined
      && (
        typeof value.description !== "string"
        || value.description.length > MAX_DESCRIPTION_LENGTH
      )
    )
    || !Array.isArray(value.dimensionKeys)
    || value.dimensionKeys.length === 0
    || value.dimensionKeys.length > MAX_DIMENSION_KEYS
    || new Set(value.dimensionKeys).size !== value.dimensionKeys.length
    || value.dimensionKeys.some((key) => !validString(key, 512))
    || !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > MAX_RATE_LIMIT_ENTRIES
    || !STATUS_VALUES.has(value.status)
    || !(value.createdAt instanceof Date)
    || Number.isNaN(value.createdAt.getTime())
    || !(value.updatedAt instanceof Date)
    || Number.isNaN(value.updatedAt.getTime())
  ) {
    malformedResponse("A Gateway rate-limit detail is malformed.");
  }

  const entries = value.entries
    .map((entry) => canonicalizeEntry(entry, value.dimensionKeys))
    .sort((left, right) => {
      for (const dimensionKey of value.dimensionKeys) {
        const order = compareStrings(
          left.dimensions[dimensionKey],
          right.dimensions[dimensionKey],
        );
        if (order !== 0) {
          return order;
        }
      }
      return 0;
    });

  return {
    rateLimitId: value.rateLimitId,
    gatewayIdentifier: value.gatewayIdentifier,
    description: value.description,
    dimensionKeys: [...value.dimensionKeys],
    entries,
    status: value.status,
  };
}

function desiredConfiguration(gatewayIdentifier, desired) {
  return {
    rateLimitId: desired.rateLimitId,
    gatewayIdentifier,
    description: desired.description,
    dimensionKeys: desired.dimensionKeys,
    entries: desired.entries,
  };
}

function detailConfiguration(detail) {
  return {
    rateLimitId: detail.rateLimitId,
    gatewayIdentifier: detail.gatewayIdentifier,
    description: detail.description,
    dimensionKeys: detail.dimensionKeys,
    entries: detail.entries,
  };
}

function sameConfiguration(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clientToken(gatewayIdentifier, desired) {
  return createHash("sha256")
    .update(JSON.stringify({
      gatewayIdentifier,
      rateLimits: desired,
    }))
    .digest("hex");
}

function validateNextToken(value) {
  if (
    value !== undefined
    && !validString(value, MAX_NEXT_TOKEN_LENGTH)
  ) {
    malformedResponse("The Gateway rate-limit pagination token is malformed.");
  }
}

async function listCurrentRateLimits(client, gatewayIdentifier) {
  const details = [];
  const rateLimitIds = new Set();
  const paginationTokens = new Set();
  let nextToken;

  do {
    const input = {
      gatewayIdentifier,
      maxResults: MAX_GATEWAY_RATE_LIMITS,
      ...(nextToken === undefined ? {} : { nextToken }),
    };
    const response = await client.send(
      new ListGatewayRateLimitsCommand(input),
    );
    if (!isRecord(response) || !Array.isArray(response.rateLimits)) {
      malformedResponse("ListGatewayRateLimits returned a malformed response.");
    }

    for (const value of response.rateLimits) {
      const detail = canonicalizeDetail(value, gatewayIdentifier);
      if (rateLimitIds.has(detail.rateLimitId)) {
        malformedResponse("ListGatewayRateLimits returned a duplicate rate limit.");
      }
      rateLimitIds.add(detail.rateLimitId);
      details.push(detail);
      if (details.length > MAX_GATEWAY_RATE_LIMITS) {
        malformedResponse("ListGatewayRateLimits exceeded the native maximum.");
      }
    }

    validateNextToken(response.nextToken);
    nextToken = response.nextToken;
    if (nextToken !== undefined) {
      if (paginationTokens.has(nextToken)) {
        malformedResponse("ListGatewayRateLimits repeated a pagination token.");
      }
      paginationTokens.add(nextToken);
    }
  } while (nextToken !== undefined);

  return details;
}

function resultFor({
  changed,
  gatewayIdentifier,
  rateLimitId,
  status,
  entryCount,
  token,
  synchronizedAt,
}) {
  return {
    changed,
    gatewayIdentifier,
    rateLimitId,
    status,
    entryCount,
    clientToken: token,
    synchronizedAt,
  };
}

function synchronizationTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw reconciliationError(
      "INVALID_GATEWAY_RATE_LIMIT_CONFIG",
      "The reconciliation clock returned an invalid timestamp.",
    );
  }
  return value.toISOString();
}

export function createGatewayRateLimitReconciler({
  client,
  gatewayIdentifier,
  now = () => new Date(),
} = {}) {
  validateClient(client);
  validateGatewayIdentifier(gatewayIdentifier);
  if (typeof now !== "function") {
    throw reconciliationError(
      "INVALID_GATEWAY_RATE_LIMIT_CONFIG",
      "A reconciliation clock is required.",
    );
  }

  return Object.freeze({
    async reconcile({ policies } = {}) {
      const desired = buildDesiredRateLimits(policies);
      const desiredDetails = desired.map((rateLimit) =>
        desiredConfiguration(gatewayIdentifier, rateLimit));
      const entryCount = desired.reduce(
        (total, rateLimit) => total + rateLimit.entries.length,
        0,
      );
      const token = clientToken(gatewayIdentifier, desired);
      const synchronizedAt = synchronizationTimestamp(now);
      const current = await listCurrentRateLimits(client, gatewayIdentifier);
      const currentDetails = current.map(detailConfiguration);

      if (
        current.every((detail) => detail.status === "ACTIVE")
        && sameConfiguration(currentDetails, desiredDetails)
      ) {
        return resultFor({
          changed: false,
          gatewayIdentifier,
          rateLimitId: current[0]?.rateLimitId ?? RATE_LIMIT_ID,
          status: "ACTIVE",
          entryCount,
          token,
          synchronizedAt,
        });
      }

      const response = await client.send(
        new BatchPutGatewayRateLimitsCommand({
          gatewayIdentifier,
          clientToken: token,
          rateLimits: desired,
        }),
      );
      if (
        !isRecord(response)
        || !Array.isArray(response.rateLimits)
        || response.rateLimits.length !== desired.length
      ) {
        malformedResponse("BatchPutGatewayRateLimits returned a partial response.");
      }
      const details = response.rateLimits.map((rateLimit) =>
        canonicalizeDetail(rateLimit, gatewayIdentifier));
      if (
        !sameConfiguration(details.map(detailConfiguration), desiredDetails)
      ) {
        malformedResponse(
          "BatchPutGatewayRateLimits did not return the requested complete set.",
        );
      }
      if (details.some((detail) => detail.status !== "ACTIVE")) {
        throw reconciliationError(
          "GATEWAY_RATE_LIMIT_NOT_ACTIVE",
          "The Gateway rate limit is not active.",
        );
      }

      return resultFor({
        changed: true,
        gatewayIdentifier,
        rateLimitId: details[0]?.rateLimitId ?? RATE_LIMIT_ID,
        status: "ACTIVE",
        entryCount,
        token,
        synchronizedAt,
      });
    },
  });
}
