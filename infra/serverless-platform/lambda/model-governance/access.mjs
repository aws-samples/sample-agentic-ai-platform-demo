const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_POLICY_DOMAINS = 100;
const MAX_REVISION = 1_000_000_000;
const LIMIT_MAXIMUMS = Object.freeze({
  requestsPerMinute: 1_000_000,
  tokensPerMinute: 1_000_000_000,
  connectionsPerSecond: 10_000,
});
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
const GRANT_KEYS = new Set([
  "domainId",
  "resourceType",
  "resourceId",
  "status",
  "grantedBySubject",
  "grantedAt",
  "revokedBySubject",
  "revokedAt",
]);

export class ModelAccessUnavailableError extends Error {
  constructor(cause) {
    super("Model access dependencies are unavailable.", { cause });
    this.name = "ModelAccessUnavailableError";
    this.code = "MODEL_ACCESS_UNAVAILABLE";
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

function hasExactKeys(value, keys) {
  return (
    isPlainObject(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key))
  );
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validStringList(value, pattern, maxLength) {
  return (
    Array.isArray(value)
    && value.every((entry) =>
      typeof entry === "string"
      && entry.length <= maxLength
      && pattern.test(entry))
    && new Set(value).size === value.length
  );
}

function validNullableLimit(value, maximum) {
  return value === null
    || (
      Number.isSafeInteger(value)
      && value >= 1
      && value <= maximum
    );
}

function validLimits(value) {
  return (
    hasExactKeys(value, LIMIT_KEYS)
    && Object.entries(LIMIT_MAXIMUMS).every(
      ([field, maximum]) => validNullableLimit(value[field], maximum),
    )
    && Object.values(value).some((limit) => limit !== null)
  );
}

function validRateLimit(value) {
  return (
    hasExactKeys(value, RATE_LIMIT_KEYS)
    && typeof value.id === "string"
    && EVIDENCE_ID_PATTERN.test(value.id)
    && value.status === "ACTIVE"
    && value.reason === null
    && validTimestamp(value.reconciledAt)
  );
}

export function validPolicy(value, modelId) {
  if (
    !hasExactKeys(value, POLICY_KEYS)
    || value.modelId !== modelId
    || !validStringList(value.allowedDomains, DOMAIN_PATTERN, 64)
    || !validStringList(value.requestableDomains, DOMAIN_PATTERN, 64)
    || value.allowedDomains.length + value.requestableDomains.length
      > MAX_POLICY_DOMAINS
    || value.allowedDomains.some((domainId) =>
      value.requestableDomains.includes(domainId))
    || !validLimits(value.limits)
    || !Number.isSafeInteger(value.revision)
    || value.revision < 1
    || value.revision > MAX_REVISION
    || value.applicationStatus !== "ACTIVE"
    || typeof value.updatedBySubject !== "string"
    || !SUBJECT_PATTERN.test(value.updatedBySubject)
    || !validTimestamp(value.updatedAt)
  ) {
    return false;
  }
  return validRateLimit(value.rateLimit);
}

function validActiveGrant(value, domainId, modelId) {
  return (
    hasExactKeys(value, GRANT_KEYS)
    && value.domainId === domainId
    && value.resourceType === "MODEL"
    && value.resourceId === modelId
    && value.status === "ACTIVE"
    && typeof value.grantedBySubject === "string"
    && SUBJECT_PATTERN.test(value.grantedBySubject)
    && validTimestamp(value.grantedAt)
    && value.revokedBySubject === null
    && value.revokedAt === null
  );
}

export function createModelAccessResolver({
  modelPolicyState,
  workspaceState,
} = {}) {
  if (
    !modelPolicyState
    || typeof modelPolicyState.getModelPolicy !== "function"
    || !workspaceState
    || typeof workspaceState.getResourceGrant !== "function"
  ) {
    throw new TypeError("Model access resolver configuration is invalid.");
  }

  return async function resolveModelAccess({ domainId, modelId } = {}) {
    if (
      typeof domainId !== "string"
      || domainId.length > 64
      || !DOMAIN_PATTERN.test(domainId)
      || typeof modelId !== "string"
      || !MODEL_ID_PATTERN.test(modelId)
    ) {
      return false;
    }
    if (domainId === "platform") return true;

    let policy;
    try {
      const catalog = await workspaceState.getDomainResourcePolicy?.({ domainId });
      if (catalog && (catalog.status !== "ACTIVE"
        || !catalog.resources.some(ref => ref.type === "Model" && ref.id === modelId))) return false;
      policy = await modelPolicyState.getModelPolicy({ modelId });
    } catch (error) {
      throw new ModelAccessUnavailableError(error);
    }
    if (!validPolicy(policy, modelId)) return false;
    if (policy.allowedDomains.includes(domainId)) return true;
    if (!policy.requestableDomains.includes(domainId)) return false;

    let grant;
    try {
      grant = await workspaceState.getResourceGrant({
        domainId,
        resourceType: "MODEL",
        resourceId: modelId,
      });
    } catch (error) {
      throw new ModelAccessUnavailableError(error);
    }
    return validActiveGrant(grant, domainId, modelId);
  };
}

// Draft configuration and repository export use catalog selection permission.
// Invocation and deployment continue to use createModelAccessResolver.
export function createModelSelectionResolver({ modelAccessResolver, workspaceState }) {
  return async ({ domainId, modelId }) => {
    if (!DOMAIN_PATTERN.test(domainId || "") || !MODEL_ID_PATTERN.test(modelId || "")) return false;
    try {
      const catalog = await workspaceState.getDomainResourcePolicy?.({ domainId });
      if (!catalog) return modelAccessResolver({ domainId, modelId });
      return catalog.status === "ACTIVE"
        && catalog.resources.some(ref => ref.type === "Model" && ref.id === modelId);
    } catch (error) { throw new ModelAccessUnavailableError(error); }
  };
}
