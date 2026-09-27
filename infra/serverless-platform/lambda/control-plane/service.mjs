import { createRecordDisplayCache } from './record-cache.mjs';
import { diagnosticStage, errorDiagnostic, safeDiagnostic, deadlineDiagnostic } from './diagnostics.mjs';
import { createHash, createHmac } from "node:crypto";
import { filterDomainResourceEntries } from "../domain-bootstrap/resource-policy.mjs";
import { validPolicy as activeModelPolicy } from "../model-governance/access.mjs";
import {
  AgentRegistryControlClient,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  AgentRegistryClient,
  BatchGetDiscoverableRegistryRecordCommand,
} from "@aws-sdk/client-agent-registry";
import {
  BedrockAgentCoreControlClient,
  GetGatewayTargetCommand,
  ListGatewayTargetsCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  descriptorTypeOf,
  gatewayTargetToMcpEntry,
  recordToVersion,
  recordsToEntries,
} from "../../../../console/registry-shape.mjs";

const TYPES = [
  "Skill",
  "MCPServer",
  "A2AAgent",
  "Agent",
  "Model",
  "Blueprint",
];
const STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "DEPRECATED",
];
const END_USER_TYPES = ["Agent"];
const END_USER_STATUSES = ["APPROVED"];
const STORE = "AWS Agent Registry + AgentCore Gateway";
const UNAVAILABLE_MESSAGE =
  "Control plane inventory is temporarily unavailable.";
const MAX_RESULTS = 50;
const MAX_PAGINATION_TOKEN_LENGTH = 4096;
const DEFAULT_OPERATION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_DETAIL_CONCURRENCY = 2;
const DEFAULT_MAX_REGISTRY_LIST_CONCURRENCY = 2;
// Account-wide End User reads are bounded independently; admin and
// domain-scoped inventory retain their existing behavior.
const END_USER_MAX_ACTIVE_REGISTRIES = 16;
const END_USER_MAX_PAGES_PER_REGISTRY = 4;
const END_USER_MAX_RECORD_SUMMARIES = 200;
const END_USER_MAX_ENTRIES = 100;
const END_USER_REGISTRY_READ_LIMITS = Object.freeze({
  cacheKey: "end-user",
  maxActiveRegistries: END_USER_MAX_ACTIVE_REGISTRIES,
  maxPagesPerRegistry: END_USER_MAX_PAGES_PER_REGISTRY,
  maxRecordSummaries: END_USER_MAX_RECORD_SUMMARIES,
});
const DEFAULT_DEADLINE_TIMERS = Object.freeze({
  setTimeout,
  clearTimeout,
});
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9]{12,16}$/;
const REGISTRY_RECORD_TYPES = new Set([
  "MCP",
  "AGENT",
  "CUSTOM",
  "SKILL",
]);
const REGISTRY_RECORD_STATUSES = new Set([
  "APPROVED",
  "CREATE_FAILED",
  "CREATING",
  "DEPRECATED",
  "DRAFT",
  "PENDING_APPROVAL",
  "REJECTED",
  "UPDATE_FAILED",
  "UPDATING",
]);
const GATEWAY_TARGET_STATUSES = new Set([
  "CREATE_PENDING_AUTH",
  "CREATING",
  "DELETING",
  "FAILED",
  "READY",
  "SYNCHRONIZE_PENDING_AUTH",
  "SYNCHRONIZE_UNSUCCESSFUL",
  "SYNCHRONIZING",
  "UPDATE_PENDING_AUTH",
  "UPDATE_UNSUCCESSFUL",
  "UPDATING",
]);
const FAILURE_COMPONENTS = new Set([
  "domain-state",
  "model-gateway",
  "registry",
  "tools-gateway",
]);

const VENDOR_BY_PROVIDER = new Map([
  ["anthropic", "Anthropic"],
  ["google", "Google"],
  ["meta", "Meta"],
  ["openai", "OpenAI"],
]);

export class ControlPlaneServiceError extends Error {
  constructor(message, {
    code,
    component,
    statusCode,
    retryable = false,
    diagnostic,
  }) {
    super(message);
    this.name = "ControlPlaneServiceError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    if (diagnostic) this.diagnostic = safeDiagnostic(diagnostic);
    if (FAILURE_COMPONENTS.has(component)) {
      this.component = component;
    }
  }
}

class ControlPlaneScopeError extends ControlPlaneServiceError {}
class ControlPlaneComponentError extends ControlPlaneServiceError {}

function scopeError(code, message) {
  return new ControlPlaneScopeError(message, {
    code,
    statusCode: 403,
  });
}

function unavailableError(component, error) {
  const ErrorClass = FAILURE_COMPONENTS.has(component)
    ? ControlPlaneComponentError
    : ControlPlaneServiceError;
  return new ErrorClass(UNAVAILABLE_MESSAGE, {
    code: "CONTROL_PLANE_UNAVAILABLE",
    component,
    diagnostic: errorDiagnostic(error),
    statusCode: 503,
    retryable: true,
  });
}

function requireString(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function registryNextToken(response) {
  const continuationValue = response?.nextToken;
  if (continuationValue === undefined) {
    return undefined;
  }
  if (
    typeof continuationValue !== "string"
    || continuationValue.length === 0
    || continuationValue.length > MAX_PAGINATION_TOKEN_LENGTH
    || !continuationValue.trim()
  ) {
    throw new Error("Registry pagination token is malformed.");
  }
  return continuationValue;
}

function positiveIntegerOption(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function detailConcurrencyOption(value) {
  const concurrency = positiveIntegerOption(
    value,
    "maxDetailConcurrency",
  );
  if (concurrency > DEFAULT_MAX_DETAIL_CONCURRENCY) {
    throw new TypeError("maxDetailConcurrency must not exceed 2.");
  }
  return concurrency;
}

function registryListConcurrencyOption(value) {
  const concurrency = positiveIntegerOption(
    value,
    "maxRegistryListConcurrency",
  );
  if (concurrency > DEFAULT_MAX_REGISTRY_LIST_CONCURRENCY) {
    throw new TypeError(
      "maxRegistryListConcurrency must not exceed 2.",
    );
  }
  return concurrency;
}

function isObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value),
  );
}

function parseObjectJson(value) {
  const text = requireString(value);
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function registryIdFromArn(value) {
  const arn = requireString(value);
  return arn?.match(/:registry\/([^/]+)$/)?.[1] || null;
}

function gatewayIdFromArn(value) {
  const arn = requireString(value);
  return arn?.match(/:gateway\/([^/]+)$/)?.[1] || null;
}

function gatewayIdentityMatches(detail, expectedGatewayId) {
  let exposed = false;
  for (const field of ["gatewayIdentifier", "gatewayId"]) {
    if (Object.hasOwn(detail, field)) {
      exposed = true;
      if (requireString(detail[field]) !== expectedGatewayId) {
        return false;
      }
    }
  }
  if (Object.hasOwn(detail, "gatewayArn")) {
    exposed = true;
    if (gatewayIdFromArn(detail.gatewayArn) !== expectedGatewayId) {
      return false;
    }
  }
  return exposed;
}

function mcpEndpoint(detail) {
  const endpoint = requireString(
    detail?.targetConfiguration?.mcp?.mcpServer?.endpoint,
  );
  if (!endpoint) {
    return null;
  }
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && url.hostname
      ? endpoint
      : null;
  } catch {
    return null;
  }
}

function validateGatewayDetail(detail, {
  gatewayId,
  targetId,
}) {
  const endpoint = mcpEndpoint(detail);
  if (
    !isObject(detail)
    || !gatewayIdentityMatches(detail, gatewayId)
    || requireString(detail.targetId) !== targetId
    || !requireString(detail.name)
    || !GATEWAY_TARGET_STATUSES.has(detail.status)
    || !endpoint
  ) {
    throw new Error("Gateway target response is malformed.");
  }
  return {
    ...detail,
    endpoint,
  };
}

function registryIdentityMatches(
  detail,
  expectedRegistryId,
  expectedRegistryArn,
) {
  let exposed = false;
  if (Object.hasOwn(detail, "registryId")) {
    exposed = true;
    if (requireString(detail.registryId) !== expectedRegistryId) {
      return false;
    }
  }
  if (Object.hasOwn(detail, "registryArn")) {
    exposed = true;
    if (requireString(detail.registryArn) !== expectedRegistryArn) {
      return false;
    }
  }
  return exposed;
}

function registryArnFromSummary(summary, {
  accountId,
  region,
  registryId,
}) {
  const registryArn = requireString(summary?.registryArn);
  const match = registryArn?.match(
    /^arn:aws:agent-registry:([^:]+):([0-9]{12}):registry\/([^/]+)$/,
  );
  if (
    !match
    || match[1] !== region
    || match[2] !== accountId
    || match[3] !== registryId
  ) {
    throw new Error("Registry record summary is malformed.");
  }
  return registryArn;
}

function registryDescriptor(detail) {
  const descriptors = detail.descriptors;
  if (!isObject(descriptors)) {
    return null;
  }
  if (detail.recordType === "AGENT") {
    return parseObjectJson(
      descriptors.a2aAgentCard?.data
      || descriptors.a2a?.agentCard?.inlineContent
      || descriptors.custom?.data
      || descriptors.custom?.inlineContent,
    );
  }
  if (detail.recordType === "MCP") {
    return parseObjectJson(descriptors.mcpServer?.data);
  }
  if (detail.recordType === "SKILL") {
    return parseObjectJson(
      descriptors.agentSkillsDefinition?.data
      || descriptors.agentSkills?.skillDefinition?.inlineContent,
    );
  }
  if (detail.recordType === "CUSTOM") {
    const descriptor = parseObjectJson(
      descriptors.custom?.data
      || descriptors.custom?.inlineContent,
    );
    // Governed publications ride CUSTOM for blueprints AND tools.
    return descriptor?.resourceKind === "blueprint"
      || descriptor?.resourceKind === "tool"
      ? descriptor
      : null;
  }
  return null;
}

function validateRegistryDetail(detail, {
  expectedStatus,
  recordId,
  registryArn,
  registryId,
  onProjectionFault = null,
}) {
  // Identity/field integrity is always fail-closed for the whole request: a
  // record that claims a mismatched registry/record ARN or an invalid
  // status/type is a backend-contract or integrity anomaly, never a benign
  // "one incompatible record" to silently drop.
  if (
    !isObject(detail)
    || !registryIdentityMatches(detail, registryId, registryArn)
    || requireString(detail.recordId) !== recordId
    || requireString(detail.recordArn)
      !== `${registryArn}/record/${recordId}`
    || !requireString(detail.name)
    || !requireString(detail.recordVersion)
    || !REGISTRY_RECORD_TYPES.has(detail.recordType)
    || !REGISTRY_RECORD_STATUSES.has(detail.status)
    || (expectedStatus && detail.status !== expectedStatus)
  ) {
    throw new Error("Registry record response is malformed.");
  }
  // Record-type consistency (recordType vs descriptorType) is an integrity
  // check, not benign descriptor drift: a disagreeing record is a backend
  // anomaly and must fail-closed for the whole request, never be silently
  // dropped. descriptorTypeOf throws when the two disagree.
  try {
    descriptorTypeOf(detail);
  } catch {
    throw new Error("Registry record response is malformed.");
  }
  // Descriptor-content projection is the surface a single malformed/
  // incompatible record actually breaks. When a projection-fault sink is
  // supplied, isolate that record (report + skip) instead of failing the
  // whole catalog read; otherwise preserve the historical hard-fail.
  let projected;
  try {
    if (!registryDescriptor(detail)) throw new Error("Registry descriptor is malformed.");
    projected = recordToVersion(detail);
  } catch (error) {
    if (typeof onProjectionFault === "function") {
      onProjectionFault(`${registryId}/${recordId}`, error);
      return null;
    }
    throw new Error("Registry record response is malformed.");
  }
  if (projected === null) {
    // Unknown/unsupported record type: historically treated as malformed for
    // the whole request. Isolate it as a non-actionable dropped record when a
    // sink is available.
    if (typeof onProjectionFault === "function") {
      onProjectionFault(
        `${registryId}/${recordId}`,
        new Error("Registry record is not a supported resource."),
      );
      return null;
    }
    throw new Error("Registry record response is malformed.");
  }
  return {
    ...detail,
    registryId,
  };
}

async function readRegistryRecordDetails({
  abortSignal,
  detailConcurrency,
  registryClient,
  registryDiscoveryClient,
  accountId,
  region,
  summaries,
  onRecordFault = null,
  displayCache,
}) {
  const resilient = typeof onRecordFault === "function";
  // Per-record content-projection fault isolation. A single record whose
  // stored descriptor fails to parse/project (or is an unsupported resource)
  // is reported and skipped instead of throwing out of the whole catalog
  // read. Identity/field integrity and structural/protocol errors (malformed
  // batch envelope, summary identity, incomplete batch) are NOT isolated:
  // they indicate a broken backend contract and remain fail-closed.
  const validateDetail = (record, context) =>
    validateRegistryDetail(record, {
      ...context,
      onProjectionFault: resilient ? onRecordFault : null,
    });
  const identities = new Set();
  const grouped = new Map();
  for (const summary of summaries) {
    const registryId = requireString(summary?.registryId);
    const recordId = requireString(summary?.recordId);
    const identity = `${registryId}/${recordId}`;
    if (!registryId || !recordId || identities.has(identity)) {
      throw new Error("Registry record summary is malformed.");
    }
    const registryArn = registryArnFromSummary(summary, {
      accountId,
      region,
      registryId,
    });
    const recordArn = requireString(summary?.recordArn);
    if (recordArn !== `${registryArn}/record/${recordId}`) {
      throw new Error("Registry record summary is malformed.");
    }
    identities.add(identity);
    const group = grouped.get(registryId) ?? [];
    group.push({ ...summary, recordArn, registryArn });
    grouped.set(registryId, group);
  }

  const recordGroups = await mapWithConcurrency(
    [...grouped.entries()],
    detailConcurrency,
    async ([registryId, registrySummaries]) => {
      const recordsById = new Map();
      const approvedSummaries = [];
      const controlPlaneSummaries = [];
      for (const summary of registrySummaries) {
        const expectedStatus = requireString(summary.status);
        if (!REGISTRY_RECORD_STATUSES.has(expectedStatus)) {
          throw new Error("Registry record summary is malformed.");
        }
        if (expectedStatus === "APPROVED") {
          approvedSummaries.push(summary);
        } else {
          controlPlaneSummaries.push(summary);
        }
      }

      for (
        let offset = 0;
        offset < approvedSummaries.length;
        offset += MAX_RESULTS
      ) {
        const batch = approvedSummaries.slice(offset, offset + MAX_RESULTS);
        const expectedById = new Map(
          batch.map((summary) => [summary.recordId, summary]),
        );
        const response = await diagnosticStage('registry-batch', () => registryDiscoveryClient.send(
          new BatchGetDiscoverableRegistryRecordCommand({
            entries: [{
              registryId,
              recordIds: batch.map((summary) => summary.recordId),
            }],
          }),
          { abortSignal },
        ));
        if (
          !Array.isArray(response?.registryRecords)
          || !Array.isArray(response?.errors)
        ) {
          throw new Error("Registry batch response is malformed.");
        }

        const accountedRecordIds = new Set();
        for (const record of response.registryRecords) {
          const recordId = requireString(record?.recordId);
          const expectedSummary = expectedById.get(recordId);
          const expectedStatus = requireString(expectedSummary?.status);
          if (
            !recordId
            || !expectedSummary
            || accountedRecordIds.has(recordId)
            || expectedStatus !== "APPROVED"
          ) {
            throw new Error("Registry batch response is malformed.");
          }
          accountedRecordIds.add(recordId);
          const validated = validateDetail(record, {
            expectedStatus,
            recordId,
            registryArn: expectedSummary.registryArn,
            registryId,
          });
          // A faulted record is accounted (so batch-completeness accounting
          // stays correct) but is not stored, so it is dropped downstream.
          if (validated !== null) {
            recordsById.set(recordId, validated);
          }
        }

        if (
          response.errors.length > 0
          || accountedRecordIds.size !== batch.length
        ) {
          throw new Error("Registry batch response is incomplete.");
        }
      }

      for (const summary of controlPlaneSummaries) {
        const loadValidated = async () => {
          const record = await diagnosticStage('registry-detail', () => registryClient.send(
            new GetRegistryRecordCommand({registryId, recordId: summary.recordId}),
            { abortSignal },
          ));
          return validateDetail(record, {
            expectedStatus: summary.status,
            recordId: summary.recordId,
            registryArn: summary.registryArn,
            registryId,
          });
        };
        const validated = resilient && displayCache
          ? await displayCache(summary, loadValidated)
          : await loadValidated();
        if (validated !== null) {
          recordsById.set(summary.recordId, validated);
        }
      }
      return registrySummaries
        .map((summary) => {
          const record = recordsById.get(summary.recordId);
          if (!record) {
            // Missing because it faulted (resilient) or because the backend
            // returned an incomplete batch (structural). Resilient reads drop
            // the faulted record; non-resilient reads fail closed.
            if (resilient) {
              return null;
            }
            throw new Error("Registry batch response is incomplete.");
          }
          return record;
        })
        .filter((record) => record !== null);
    },
  );
  return recordGroups.flat();
}

function normalizeConfig(config) {
  const accountId = requireString(config?.accountId);
  const region = requireString(config?.region);
  const sharedRegistryId = requireString(config?.sharedRegistryId);
  const domainRegistryIds = config?.domainRegistryIds;
  const llmGatewayId = requireString(config?.llmGatewayId);
  const llmGatewayRegion = requireString(config?.llmGatewayRegion);
  const llmGatewayUrl = requireString(config?.llmGatewayUrl);
  const toolsGatewayId = requireString(config?.toolsGatewayId);
  const toolsGatewayUrl = requireString(config?.toolsGatewayUrl);

  if (!/^[0-9]{12}$/.test(accountId || "")) {
    throw new TypeError("Control plane account ID is invalid.");
  }
  if (
    !region
    || !sharedRegistryId
    || !domainRegistryIds
    || typeof domainRegistryIds !== "object"
    || Array.isArray(domainRegistryIds)
    || !llmGatewayId
    || !llmGatewayRegion
    || !llmGatewayUrl
    || !toolsGatewayId
    || !toolsGatewayUrl
  ) {
    throw new TypeError("Control plane configuration is incomplete.");
  }

  const normalizedDomains = Object.fromEntries(
    Object.entries(domainRegistryIds)
      .map(([domain, registryId]) => [
        domain,
        requireString(registryId),
      ])
      .filter(([, registryId]) => registryId),
  );
  if (Object.keys(normalizedDomains).length === 0) {
    throw new TypeError("Control plane domain configuration is incomplete.");
  }

  return {
    accountId,
    region,
    sharedRegistryId,
    domainRegistryIds: normalizedDomains,
    llmGatewayId,
    llmGatewayRegion,
    llmGatewayName:
      requireString(config.llmGatewayName) || llmGatewayId,
    llmGatewayUrl: llmGatewayUrl.replace(/\/+$/, ""),
    toolsGatewayId,
    toolsGatewayName:
      requireString(config.toolsGatewayName) || toolsGatewayId,
    toolsGatewayUrl: toolsGatewayUrl.replace(/\/+$/, ""),
  };
}

function normalizeRegistryConfig(config) {
  const accountId = requireString(config?.accountId);
  const region = requireString(config?.region);
  const sharedRegistryId = requireString(config?.sharedRegistryId);
  const domainRegistryIds = config?.domainRegistryIds;
  if (!/^[0-9]{12}$/.test(accountId || "")) {
    throw new TypeError("Registry inventory account ID is invalid.");
  }
  if (
    !region
    || !sharedRegistryId
    || !domainRegistryIds
    || typeof domainRegistryIds !== "object"
    || Array.isArray(domainRegistryIds)
  ) {
    throw new TypeError("Registry inventory configuration is incomplete.");
  }
  const normalizedDomains = Object.fromEntries(
    Object.entries(domainRegistryIds)
      .map(([domain, registryId]) => [domain, requireString(registryId)])
      .filter(([, registryId]) => registryId),
  );
  if (Object.keys(normalizedDomains).length === 0) {
    throw new TypeError("Registry inventory domain configuration is incomplete.");
  }
  return {
    accountId,
    region,
    sharedRegistryId,
    domainRegistryIds: normalizedDomains,
  };
}

function normalizedDomainState(domainState) {
  if (domainState === undefined || domainState === null) {
    return null;
  }
  if (
    typeof domainState !== "object"
    || typeof domainState.listDomains !== "function"
    || typeof domainState.getDomain !== "function"
  ) {
    throw new TypeError(
      "Domain state must provide listDomains and getDomain.",
    );
  }
  return domainState;
}

function selectedDomainRegistry(domain, expectedDomain) {
  if (
    !domain
    || typeof domain !== "object"
    || Array.isArray(domain)
    || requireString(domain.id) !== expectedDomain
    || !REGISTRY_ID_PATTERN.test(requireString(domain.registryId) || "")
    || domain.status !== "ACTIVE"
  ) {
    return null;
  }
  return {
    domain: expectedDomain,
    registryId: domain.registryId.trim(),
  };
}

function durableDomainRegistry(
  domainState,
  activeDomain,
  abortSignal,
) {
  return waitForPromise(
    Promise.resolve().then(() =>
      domainState.getDomain(activeDomain, { abortSignal })),
    abortSignal,
  ).then((domain) => {
    const registry = selectedDomainRegistry(domain, activeDomain);
    if (!registry) {
      throw scopeError(
        "DOMAIN_NOT_ALLOWED",
        "The active domain is not allowed.",
      );
    }
    return registry;
  });
}

function selectedRegistries(
  config,
  scope = {},
  domainState,
  abortSignal,
) {
  const shared = {
    domain: "shared",
    registryId: config.sharedRegistryId,
  };
  const resolvedDomainState = normalizedDomainState(domainState);
  if (scope.role === "admin" || scope.role === "user") {
    const activeDomain = requireString(scope.activeDomain);
    if (
      scope.role === "user"
      && (
        activeDomain
        || (
          Array.isArray(scope.allowedDomains)
          && scope.allowedDomains.length > 0
        )
      )
    ) {
      throw scopeError(
        "DOMAIN_NOT_ALLOWED",
        "The active domain is not allowed.",
      );
    }
    if (resolvedDomainState) {
      if (activeDomain) {
        return durableDomainRegistry(
          resolvedDomainState,
          activeDomain,
          abortSignal,
        ).then((registry) => [shared, registry]);
      }
      return waitForPromise(
        Promise.resolve().then(() =>
          resolvedDomainState.listDomains({ abortSignal })),
        abortSignal,
      ).then((domains) => {
        if (!Array.isArray(domains)) {
          throw new Error("Domain state response is malformed.");
        }
        const selected = [];
        const domainIds = new Set();
        const registryIds = new Set([config.sharedRegistryId]);
        for (const domain of domains) {
          if (domain?.status !== "ACTIVE") continue;
          const domainId = requireString(domain?.id);
          const registry = domainId
            ? selectedDomainRegistry(domain, domainId)
            : null;
          if (
            !registry
            || domainIds.has(registry.domain)
          ) {
            throw new Error("Domain state response is malformed.");
          }
          domainIds.add(registry.domain);
          if (registryIds.has(registry.registryId)) {
            continue;
          }
          registryIds.add(registry.registryId);
          selected.push(registry);
        }
        return [shared, ...selected];
      });
    }
    if (activeDomain) {
      throw scopeError(
        "DOMAIN_NOT_ALLOWED",
        "The active domain is not allowed.",
      );
    }
    return [
      shared,
      ...Object.entries(config.domainRegistryIds)
        .map(([domain, registryId]) => ({ domain, registryId })),
    ];
  }

  const activeDomain = requireString(scope.activeDomain);
  if (!activeDomain) {
    throw scopeError(
      "DOMAIN_REQUIRED",
      "An allowed active domain is required.",
    );
  }
  const allowedDomains = Array.isArray(scope.allowedDomains)
    ? scope.allowedDomains
    : [];
  if (
    !allowedDomains.includes(activeDomain)
  ) {
    throw scopeError(
      "DOMAIN_NOT_ALLOWED",
      "The active domain is not allowed.",
    );
  }

  if (resolvedDomainState) {
    return durableDomainRegistry(
      resolvedDomainState,
      activeDomain,
      abortSignal,
    ).then((registry) => [shared, registry]);
  }
  if (!Object.hasOwn(config.domainRegistryIds, activeDomain)) {
    throw scopeError(
      "DOMAIN_NOT_ALLOWED",
      "The active domain is not allowed.",
    );
  }
  return [
    shared,
    {
      domain: activeDomain,
      registryId: config.domainRegistryIds[activeDomain],
    },
  ];
}

function authoritativeActiveDomains(domains) {
  if (!Array.isArray(domains)) {
    throw new Error("Domain state response is malformed.");
  }
  const activeDomains = [];
  const domainIds = new Set();
  for (const domain of domains) {
    if (domain?.status !== "ACTIVE") continue;
    const domainId = requireString(domain?.id);
    const registry = domainId
      ? selectedDomainRegistry(domain, domainId)
      : null;
    if (!registry || domainIds.has(domainId)) {
      throw new Error("Domain state response is malformed.");
    }
    domainIds.add(domainId);
    activeDomains.push({
      id: domainId,
      name: requireString(domain?.name) || domainId,
      status: "ACTIVE",
    });
  }
  return activeDomains;
}

function hashHex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function normalizeCredentials(credentials) {
  const keyId = credentials?.accessKeyId
    || credentials?.AccessKeyId;
  const signingKey = credentials?.secretAccessKey
    || credentials?.SecretAccessKey;
  const securityToken = credentials?.sessionToken
    || credentials?.SessionToken;
  if (!keyId || !signingKey) {
    throw new Error("AWS credentials are unavailable.");
  }
  return {
    keyId,
    signingKey,
    securityToken,
  };
}

function signRequest({
  credentials,
  now,
  region,
  url,
}) {
  const parsedUrl = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex("");
  const baseHeaders = {
    host: parsedUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.securityToken) {
    baseHeaders["x-amz-security-token"] = credentials.securityToken;
  }
  const canonicalHeaders = Object.entries(baseHeaders)
    .map(([key, value]) => [
      key.toLowerCase(),
      String(value).trim().replace(/\s+/g, " "),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = canonicalHeaders
    .map(([key]) => key)
    .join(";");
  const canonicalRequest = [
    "GET",
    parsedUrl.pathname || "/",
    "",
    canonicalHeaders
      .map(([key, value]) => `${key}:${value}\n`)
      .join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const service = "bedrock-agentcore";
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hashHex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(
    `AWS4${credentials.signingKey}`,
    dateStamp,
  );
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");

  return {
    ...baseHeaders,
    Authorization:
      "AWS4-HMAC-SHA256 "
      + `Credential=${credentials.keyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function modelMatchKeys(id) {
  const value = String(id || "");
  const bare = value.replace(/^[^/]+\//, "").replace(/^global\./, "");
  const canonical = bare.replace(/-\d{8}-v\d(?::\d+)?$/i, "");
  return [...new Set([
    value,
    bare,
    `global.${bare}`,
    canonical,
    `global.${canonical}`,
  ].filter(Boolean))];
}

function splitProvider(id) {
  const bare = String(id || "")
    .replace(/^[^/]+\//, "")
    .replace(/^global\./, "");
  const match = bare.match(/^([a-z0-9-]+)\.(.+)$/i);
  return match
    ? { provider: match[1].toLowerCase(), model: match[2] }
    : { provider: "", model: bare };
}

function titleToken(token) {
  const lower = String(token || "").toLowerCase();
  if (/^\d+b$/.test(lower)) {
    return lower.toUpperCase();
  }
  const acronyms = new Map([
    ["ai", "AI"],
    ["gpt", "GPT"],
    ["mcp", "MCP"],
    ["oss", "OSS"],
    ["vl", "VL"],
  ]);
  if (acronyms.has(lower)) {
    return acronyms.get(lower);
  }
  return String(token || "").replace(/^\w/, (letter) =>
    letter.toUpperCase());
}

function humanizeModelId(id) {
  const { model } = splitProvider(id);
  const cleaned = model
    .replace(/-\d{8}-v\d(?::\d+)?$/i, "")
    .replace(/[-_]/g, " ")
    .replace(
      /\b(claude (?:opus|sonnet|haiku)) (\d) (\d)\b/ig,
      "$1 $2.$3",
    )
    .replace(/\b(gpt) (\d) (\d)\b/ig, "$1 $2.$3");
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map(titleToken)
    .join(" ")
    .trim();
}

function modelVendor(model, metadata) {
  if (metadata?.vendor) {
    return metadata.vendor;
  }
  const owner = requireString(model.owned_by || model.owner);
  if (owner && !["system", "unknown"].includes(owner.toLowerCase())) {
    return VENDOR_BY_PROVIDER.get(owner.toLowerCase())
      || titleToken(owner);
  }
  return VENDOR_BY_PROVIDER.get(splitProvider(model.id).provider)
    || "Unknown";
}

function catalogModels(catalogMetadata) {
  if (Array.isArray(catalogMetadata)) {
    return catalogMetadata;
  }
  return Array.isArray(catalogMetadata?.models)
    ? catalogMetadata.models
    : [];
}

function catalogIndex(catalogMetadata) {
  const index = new Map();
  for (const model of catalogModels(catalogMetadata)) {
    if (!requireString(model?.id)) {
      continue;
    }
    for (const key of modelMatchKeys(model.id)) {
      index.set(key, model);
    }
  }
  return index;
}

function metadataForModel(modelId, index) {
  return modelMatchKeys(modelId)
    .map((key) => index.get(key))
    .find(Boolean);
}

function modelEntry(model, {
  catalog,
  config,
  now,
  policy,
  policyBacked = false,
}) {
  const metadata = metadataForModel(model.id, catalog);
  const approved = policyBacked
    ? activeModelPolicy(policy, model.id)
    : Boolean(metadata && metadata.approved !== false);
  const vendor = modelVendor(model, metadata);
  const tier = requireString(metadata?.tier);
  const name = requireString(metadata?.label)
    || humanizeModelId(model.id)
    || model.id;
  const createdAt = now.toISOString();

  return {
    id: model.id,
    type: "Model",
    name,
    description:
      [vendor, tier].filter(Boolean).join(" ")
      || `Gateway model (${config.llmGatewayName})`,
    governanceMode: "federated",
    domainOwner: null,
    domain: "shared",
    defaultVersion: "1.0.0",
    versions: [{
      semver: "1.0.0",
      status: approved ? "APPROVED" : "IN_REVIEW",
      content: {
        gateway: config.llmGatewayName,
        gatewayId: config.llmGatewayId,
        gatewayUrl: config.llmGatewayUrl,
        gatewayModelId: model.id,
        region: config.llmGatewayRegion,
        runtimeModelId: metadata?.id || model.id,
        source: "agentcore-gateway",
        ownedBy: model.owned_by || model.owner || "unknown",
        object: model.object || "model",
        pricing: metadata?.pricing || null,
        ...(policyBacked ? {
          platformApproval: {
            status: approved ? "APPROVED" : "POLICY_REQUIRED",
            source: "platform-model-policy",
            revision: policy?.revision ?? null,
          },
          ...(approved ? { limits: { ...policy.limits } } : {}),
        } : {}),
      },
      changelog:
        `Discovered from AgentCore Gateway `
        + `${config.llmGatewayName} (${config.llmGatewayRegion}).`,
      createdBy: "gateway",
      createdAt,
      decidedBy: approved ? (policyBacked ? policy.updatedBySubject : "gateway") : null,
      decidedAt: approved ? (policyBacked ? policy.updatedAt : createdAt) : null,
      autoChecks: [],
    }],
    _source: "gateway",
    _gateway: config.llmGatewayName,
    _catalogMatch: Boolean(metadata),
  };
}

function stableRegistryResponse(entries, faults = []) {
  const entryIds = new Set();
  for (const entry of entries) {
    const entryId = requireString(entry?.id);
    if (!entryId || entryIds.has(entryId)) {
      throw new Error("Registry entry identity is malformed.");
    }
    entryIds.add(entryId);
  }
  const failedRecordIds = Array.isArray(faults)
    ? faults.filter((id) => typeof id === "string" && id.trim())
    : [];
  const incomplete = failedRecordIds.length > 0
    || (Array.isArray(faults) && faults.length > 0);
  const response = {
    ok: true,
    entries,
    types: [...TYPES],
    statuses: [...STATUSES],
    store: STORE,
    source: "aws",
  };
  if (incomplete) {
    // Degraded/incomplete catalog: one or more records could not be
    // projected and were dropped (fail-closed, non-actionable). Surface an
    // explicit incomplete signal so complete-catalog consumers (e.g.
    // "nothing to approve"/"queue empty" determinations) suppress any
    // misleading all-clear/empty state. `completeness`/`errors` are the
    // fields the front-end incompleteness guard already recognizes.
    response.incomplete = true;
    response.completeness = "incomplete";
    response.failedRecordCount = Array.isArray(faults) ? faults.length : 0;
    response.errors = failedRecordIds;
  }
  return response;
}

export function projectEndUserRegistry(inventory) {
  if (!isObject(inventory) || !Array.isArray(inventory.entries)) {
    throw new Error("Registry inventory is malformed.");
  }
  const entries = [];
  for (const entry of inventory.entries) {
    if (
      !isObject(entry)
      || (
        entry.type !== "Agent"
        && entry.type !== "A2AAgent"
      )
      || !Array.isArray(entry.versions)
    ) {
      continue;
    }
    const defaultVersion = requireString(entry.defaultVersion);
    const currentVersions = defaultVersion
      ? entry.versions.filter(
          (version) =>
            isObject(version)
            && requireString(version.semver) === defaultVersion,
        )
      : [];
    if (
      currentVersions.length !== 1
      || currentVersions[0].status !== "APPROVED"
    ) {
      continue;
    }
    const currentVersion = currentVersions[0];
    const card = isObject(currentVersion.content?.card)
      ? currentVersion.content.card
      : null;
    const platform = isObject(card?.["x-platform"])
      ? card["x-platform"]
      : null;
    const projected = {
      id: entry.id,
      type: "Agent",
      defaultVersion,
      versions: [{
        semver: defaultVersion,
        status: "APPROVED",
      }],
    };
    const name = requireString(platform?.displayName)
      || requireString(card?.name);
    if (name) {
      projected.name = name;
    }
    if (typeof card?.description === "string") {
      projected.description = card.description;
    }
    for (const field of ["domain", "governanceMode"]) {
      const value = requireString(entry[field]);
      if (value) {
        projected[field] = value;
      }
    }
    if (
      entry.domainOwner === null
      || requireString(entry.domainOwner)
    ) {
      projected.domainOwner = entry.domainOwner === null
        ? null
        : entry.domainOwner.trim();
    }
    entries.push(projected);
    if (entries.length > END_USER_MAX_ENTRIES) {
      throw new Error("End User Registry inventory is too large.");
    }
  }
  const projected = {
    ...stableRegistryResponse(entries),
    types: [...END_USER_TYPES],
    statuses: [...END_USER_STATUSES],
  };
  // Preserve any upstream incomplete/degraded signal so the end-user catalog
  // never renders a misleading all-clear when records were dropped.
  if (inventory.incomplete === true) {
    projected.incomplete = true;
    projected.completeness = "incomplete";
    if (typeof inventory.failedRecordCount === "number") {
      projected.failedRecordCount = inventory.failedRecordCount;
    }
    if (Array.isArray(inventory.errors)) {
      projected.errors = inventory.errors;
    }
  }
  return projected;
}

function stableEndUserRegistryResponse(inventory) {
  try {
    return projectEndUserRegistry(inventory);
  } catch {
    throw unavailableError("registry");
  }
}

function aiGatewayResponse(config, tools, models) {
  return {
    ok: true,
    source: "aws",
    region: config.region,
    toolsGateway: {
      gatewayId: config.toolsGatewayId,
      name: config.toolsGatewayName,
      gatewayUrl: config.toolsGatewayUrl,
      targetCount: tools.targets.length,
      targets: tools.targets,
    },
    llmGateway: {
      gatewayId: config.llmGatewayId,
      name: config.llmGatewayName,
      region: config.llmGatewayRegion,
      gatewayUrl: config.llmGatewayUrl,
      modelCount: models.entries.length,
    },
    models: models.entries,
  };
}

function abortError() {
  const error = new Error("Control plane operation was aborted.");
  error.name = "AbortError";
  return error;
}

function waitForPromise(promise, abortSignal) {
  if (abortSignal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortOwnedLoadsIfIdle(boundary) {
  if (boundary.controller.signal.aborted) {
    return;
  }
  const ownedLoads = [...boundary.ownedLoads];
  if (
    ownedLoads.length === 0
    || ownedLoads.every((load) =>
      load.settled || load.waiters.size === 0)
  ) {
    boundary.controller.abort();
  }
}

function createRequestBoundary() {
  const controller = new AbortController();
  const cancelListeners = new Set();
  return {
    canceled: false,
    cancel() {
      if (this.canceled) {
        return;
      }
      this.canceled = true;
      for (const listener of [...cancelListeners]) {
        listener();
      }
      abortOwnedLoadsIfIdle(this);
    },
    controller,
    onCancel(listener) {
      cancelListeners.add(listener);
      return () => cancelListeners.delete(listener);
    },
    ownedLoads: new Set(),
    signal: controller.signal,
  };
}

function waitForSharedLoad(load, requestBoundary, onNoWaiters) {
  const stopSharedLoadIfIdle = () => {
    if (!load.settled && load.waiters.size === 0) {
      onNoWaiters();
      abortOwnedLoadsIfIdle(load.ownerBoundary);
    }
  };
  if (requestBoundary.canceled) {
    stopSharedLoadIfIdle();
    return Promise.reject(abortError());
  }

  const waiter = {};
  load.waiters.add(waiter);
  return new Promise((resolve, reject) => {
    let settled = false;
    let removeCancelListener = () => {};
    const finish = (settle, value) => {
      if (settled) {
        return;
      }
      settled = true;
      removeCancelListener();
      load.waiters.delete(waiter);
      stopSharedLoadIfIdle();
      settle(value);
    };
    const onCancel = () => {
      finish(reject, abortError());
    };
    removeCancelListener = requestBoundary.onCancel(onCancel);
    load.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function withOperationDeadline(
  operationTimeoutMs,
  deadlineTimers,
  operation,
) {
  const requestBoundary = createRequestBoundary();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = deadlineTimers.setTimeout(() => {
      requestBoundary.cancel();
      reject(deadlineDiagnostic(new Error("Control plane operation exceeded its deadline.")));
    }, operationTimeoutMs);
  });
  const request = Promise.resolve().then(
    () => operation(requestBoundary),
  );
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    requestBoundary.cancel();
    throw error;
  } finally {
    deadlineTimers.clearTimeout(timer);
  }
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(limit, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await mapper(values[index], index);
        }
      },
    ),
  );
  return results;
}

function inFlightLoader(loader, onIdle = () => {}) {
  let inFlight = null;
  const evict = (load) => {
    if (inFlight === load) {
      inFlight = null;
      onIdle();
    }
  };
  return (requestBoundary) => {
    if (!inFlight) {
      const current = {
        ownerBoundary: requestBoundary,
        promise: null,
        settled: false,
        waiters: new Set(),
      };
      requestBoundary.ownedLoads.add(current);
      current.promise = Promise.resolve().then(
        () => loader(requestBoundary.signal),
      );
      inFlight = current;
      current.promise.then(
        () => {
          current.settled = true;
          current.ownerBoundary.ownedLoads.delete(current);
          evict(current);
          if (current.ownerBoundary.canceled) {
            abortOwnedLoadsIfIdle(current.ownerBoundary);
          }
        },
        () => {
          current.settled = true;
          current.ownerBoundary.ownedLoads.delete(current);
          evict(current);
          if (current.ownerBoundary.canceled) {
            abortOwnedLoadsIfIdle(current.ownerBoundary);
          }
        },
      );
    }
    const current = inFlight;
    return waitForSharedLoad(
      current,
      requestBoundary,
      () => evict(current),
    );
  };
}

async function unavailableBoundary(operation) {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof ControlPlaneScopeError
      || error instanceof ControlPlaneComponentError
    ) {
      throw error;
    }
    throw unavailableError(undefined, error);
  }
}

async function componentBoundary(component, operation) {
  try {
    return await diagnosticStage(component === 'registry' ? 'registry-read' : component === 'domain-state' ? 'domain-selection' : 'unknown', operation);
  } catch (error) {
    if (
      error instanceof ControlPlaneScopeError
      || error instanceof ControlPlaneComponentError
    ) {
      throw error;
    }
    throw unavailableError(component, error);
  }
}

function createRegistryEntryReader({
  accountId,
  region,
  detailConcurrency,
  registryListConcurrency,
  registryClient,
  registryDiscoveryClient,
}) {
  const displayCache = createRecordDisplayCache();
  async function listRegistry(
    registry,
    abortSignal,
    limits,
    recordSummaries,
  ) {
    const records = [];
    const seenTokens = new Set();
    let pageCount = 0;
    let nextToken;
    do {
      const response = await diagnosticStage('registry-list', () => registryClient.send(
        new ListRegistryRecordsCommand({
          registryId: registry.registryId,
          maxResults: MAX_RESULTS,
          nextToken,
        }),
        { abortSignal },
      ));
      if (!Array.isArray(response?.registryRecords)) {
        throw new Error("Registry list response is malformed.");
      }
      pageCount += 1;
      recordSummaries.count += response.registryRecords.length;
      if (
        limits
        && recordSummaries.count > limits.maxRecordSummaries
      ) {
        throw new Error("Registry record inventory is too large.");
      }
      records.push(
        ...response.registryRecords.map((record) => ({
          ...record,
          registryId: registry.registryId,
        })),
      );
      nextToken = registryNextToken(response);
      if (nextToken) {
        if (
          limits
          && pageCount >= limits.maxPagesPerRegistry
        ) {
          throw new Error("Registry pagination exceeds its limit.");
        }
        if (seenTokens.has(nextToken)) {
          throw new Error("Registry pagination repeated a token.");
        }
        seenTokens.add(nextToken);
      }
    } while (nextToken);
    return records;
  }

  return async function readRegistryEntries(
    registries,
    abortSignal,
    limits,
    displayOnly = false,
  ) {
    if (
      limits
      && registries.length > limits.maxActiveRegistries
    ) {
      throw new Error("Registry inventory has too many active Registries.");
    }
    const recordSummaries = { count: 0 };
    const summaries = (
      await mapWithConcurrency(
        registries,
        registryListConcurrency,
        (registry) => listRegistry(
          registry,
          abortSignal,
          limits,
          recordSummaries,
        ),
      )
    ).flat();
    // Per-record fault isolation spans both layers: (1) detail validation
    // (readRegistryRecordDetails) and (2) catalog projection
    // (recordsToEntries). A single record that fails at either layer is
    // collected and skipped instead of failing the whole catalog read.
    const faultIds = new Set();
    const reportFault = (recordId) => {
      if (typeof recordId === "string" && recordId.trim()) {
        faultIds.add(recordId);
      } else {
        faultIds.add(`unknown-record-${faultIds.size + 1}`);
      }
    };
    const records = await readRegistryRecordDetails({
      abortSignal,
      accountId,
      detailConcurrency,
      registryClient,
      registryDiscoveryClient,
      region,
      summaries,
      onRecordFault: displayOnly ? reportFault : null,
      displayCache: displayOnly ? displayCache : undefined,
    });
    const domainByRegistryId = new Map(
      registries.map(({ domain, registryId }) => [registryId, domain]),
    );
    const entries = await diagnosticStage('registry-projection', () => recordsToEntries(
      records,
      (record) => domainByRegistryId.get(record.registryId) || null,
      displayOnly ? reportFault : null,
    ));
    return { entries, faults: [...faultIds] };
  };
}

export function createRegistryInventoryService({
  config: inputConfig,
  domainState,
  registryClient,
  registryDiscoveryClient,
  maxDetailConcurrency = DEFAULT_MAX_DETAIL_CONCURRENCY,
  maxRegistryListConcurrency =
    DEFAULT_MAX_REGISTRY_LIST_CONCURRENCY,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  deadlineTimers = DEFAULT_DEADLINE_TIMERS,
} = {}) {
  const config = normalizeRegistryConfig(inputConfig);
  const detailConcurrency = detailConcurrencyOption(maxDetailConcurrency);
  const registryListConcurrency = registryListConcurrencyOption(
    maxRegistryListConcurrency,
  );
  const timeoutMs = positiveIntegerOption(
    operationTimeoutMs,
    "operationTimeoutMs",
  );
  const resolvedDomainState = normalizedDomainState(domainState);
  const resolvedRegistryClient = registryClient
    || new AgentRegistryControlClient({ region: config.region, retryMode: "adaptive", maxAttempts: 6 });
  const resolvedRegistryDiscoveryClient = registryDiscoveryClient
    || new AgentRegistryClient({ region: config.region });
  const readRegistryEntries = createRegistryEntryReader({
    accountId: config.accountId,
    region: config.region,
    detailConcurrency,
    registryListConcurrency,
    registryClient: resolvedRegistryClient,
    registryDiscoveryClient: resolvedRegistryDiscoveryClient,
  });

  return {
    async registryTarget(scope, target) {
      // Exact immutable AWS identity, never an entry selected from a partial
      // display catalog. Domain state and the target descriptor stay strict.
      if (scope?.role !== "admin"
        || !/^[A-Za-z0-9]{12,16}$/.test(target?.registryId || "")
        || !/^[A-Za-z0-9]{12}$/.test(target?.recordId || "")) {
        throw scopeError("FORBIDDEN", "Registry target is not allowed.");
      }
      return unavailableBoundary(() => withOperationDeadline(
        timeoutMs, deadlineTimers, async ({ signal }) => {
          const registries = await selectedRegistries(config, scope, resolvedDomainState, signal);
          const matches = registries.filter(r => r.registryId === target.registryId);
          if (matches.length !== 1 || !["platform", "shared"].includes(matches[0].domain)) {
            throw new Error("Registry target domain is not allowed.");
          }
          const registryArn = `arn:aws:agent-registry:${config.region}:${config.accountId}:registry/${target.registryId}`;
          const record = validateRegistryDetail(await resolvedRegistryClient.send(
            new GetRegistryRecordCommand({ registryId: target.registryId, recordId: target.recordId }),
            { abortSignal: signal },
          ), { registryId: target.registryId, recordId: target.recordId, registryArn });
          const entries = recordsToEntries([record], () => matches[0].domain);
          const entry = entries[0];
          if (!entry || record.recordVersion !== target.semver
            || (entry.id !== target.id && `${record.registryId}/${record.name}` !== target.id)) {
            throw new Error("Registry target identity or version changed.");
          }
          // Governed resources have an owner and require the formal two-person
          // publication workflow, not the legacy direct Registry status writer.
          if (recordToVersion(record).governed) {
            throw new Error("Governed resources require a publication decision.");
          }
          return stableRegistryResponse([{ ...entry, id: target.id }]);
        },
      ));
    },
    async registryOnly(scope) {
      const limits = scope?.role === "user"
        ? END_USER_REGISTRY_READ_LIMITS
        : undefined;
      if (!resolvedDomainState) {
        const registries = selectedRegistries(config, scope);
        return unavailableBoundary(() =>
          withOperationDeadline(
            timeoutMs,
            deadlineTimers,
            async ({ signal }) => {
              const { entries, faults } =
                await readRegistryEntries(registries, signal, limits);
              return stableRegistryResponse(entries, faults);
            },
          )
        );
      }
      return unavailableBoundary(() =>
        withOperationDeadline(
          timeoutMs,
          deadlineTimers,
          async ({ signal }) => {
            const registries = await selectedRegistries(
              config,
              scope,
              resolvedDomainState,
              signal,
            );
            const { entries, faults } =
              await readRegistryEntries(registries, signal, limits);
            return stableRegistryResponse(entries, faults);
          },
        )
      );
    },
  };
}

export function createControlPlaneService({
  config: inputConfig,
  domainState,
  registryClient,
  registryDiscoveryClient,
  gatewayClient,
  fetchImpl = globalThis.fetch,
  credentials,
  clock = () => new Date(),
  catalogMetadata,
  modelPolicyState,
  maxDetailConcurrency = DEFAULT_MAX_DETAIL_CONCURRENCY,
  maxRegistryListConcurrency =
    DEFAULT_MAX_REGISTRY_LIST_CONCURRENCY,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  deadlineTimers = DEFAULT_DEADLINE_TIMERS,
} = {}) {
  const config = normalizeConfig(inputConfig);
  const detailConcurrency = detailConcurrencyOption(maxDetailConcurrency);
  const registryListConcurrency = registryListConcurrencyOption(
    maxRegistryListConcurrency,
  );
  const timeoutMs = positiveIntegerOption(
    operationTimeoutMs,
    "operationTimeoutMs",
  );
  const resolvedDomainState = normalizedDomainState(domainState);
  const resolvedRegistryClient = registryClient
    || new AgentRegistryControlClient({ region: config.region, retryMode: "adaptive", maxAttempts: 6 });
  const resolvedRegistryDiscoveryClient = registryDiscoveryClient
    || new AgentRegistryClient({ region: config.region });
  const resolvedGatewayClient = gatewayClient
    || new BedrockAgentCoreControlClient({ region: config.region });
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (
    !deadlineTimers
    || typeof deadlineTimers.setTimeout !== "function"
    || typeof deadlineTimers.clearTimeout !== "function"
  ) {
    throw new TypeError("Deadline timers are required.");
  }
  const catalog = catalogIndex(catalogMetadata);
  if (modelPolicyState && typeof modelPolicyState.listModelPolicies !== "function") {
    throw new TypeError("Model policy state must provide listModelPolicies.");
  }
  const readRegistryEntries = createRegistryEntryReader({
    accountId: config.accountId,
    region: config.region,
    detailConcurrency,
    registryListConcurrency,
    registryClient: resolvedRegistryClient,
    registryDiscoveryClient: resolvedRegistryDiscoveryClient,
  });

  function currentDate() {
    const value = typeof clock === "function"
      ? clock()
      : clock?.now?.();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Clock returned an invalid date.");
    }
    return date;
  }

  async function resolveCredentials(abortSignal) {
    let candidate = credentials;
    if (candidate === undefined) {
      candidate = resolvedRegistryClient.config?.credentials
        || resolvedGatewayClient.config?.credentials;
    }
    if (typeof candidate === "function") {
      candidate = await waitForPromise(
        Promise.resolve().then(() => candidate({ abortSignal })),
        abortSignal,
      );
    } else {
      candidate = await waitForPromise(candidate, abortSignal);
    }
    return normalizeCredentials(candidate);
  }

  async function readToolsGateway(abortSignal) {
    const summaries = [];
    const seenTokens = new Set();
    let nextToken;
    do {
      const response = await resolvedGatewayClient.send(
        new ListGatewayTargetsCommand({
          gatewayIdentifier: config.toolsGatewayId,
          maxResults: MAX_RESULTS,
          nextToken,
        }),
        { abortSignal },
      );
      if (!Array.isArray(response?.items)) {
        throw new Error("Gateway target list response is malformed.");
      }
      summaries.push(...response.items);
      nextToken = requireString(response.nextToken) || undefined;
      if (nextToken) {
        if (seenTokens.has(nextToken)) {
          throw new Error("Gateway pagination repeated a token.");
        }
        seenTokens.add(nextToken);
      }
    } while (nextToken);

    const targetIds = new Set();
    for (const summary of summaries) {
      const targetId = requireString(summary?.targetId);
      if (!targetId || targetIds.has(targetId)) {
        throw new Error("Gateway target summary is malformed.");
      }
      targetIds.add(targetId);
    }
    const targets = await mapWithConcurrency(
      summaries,
      detailConcurrency,
      async (summary) => {
        const targetId = requireString(summary?.targetId);
        if (!targetId) {
          throw new Error("Gateway target summary is malformed.");
        }
        const detail = await resolvedGatewayClient.send(
          new GetGatewayTargetCommand({
            gatewayIdentifier: config.toolsGatewayId,
            targetId,
          }),
          { abortSignal },
        );
        if (!detail || typeof detail !== "object") {
          throw new Error("Gateway target response is malformed.");
        }
        return {
          ...summary,
          ...validateGatewayDetail(detail, {
            gatewayId: config.toolsGatewayId,
            targetId,
          }),
          gatewayIdentifier: config.toolsGatewayId,
        };
      },
    );
    const gateway = {
      gatewayId: config.toolsGatewayId,
      gatewayUrl: config.toolsGatewayUrl,
      name: config.toolsGatewayName,
    };
    return {
      targets,
      entries: targets.map((target) =>
        gatewayTargetToMcpEntry(target, gateway)),
    };
  }

  async function readModels(abortSignal) {
    const url = `${config.llmGatewayUrl}/models`;
    const signedHeaders = signRequest({
      credentials: await resolveCredentials(abortSignal),
      now: currentDate(),
      region: config.llmGatewayRegion,
      url,
    });
    const response = await fetchImpl(url, {
      method: "GET",
      headers: signedHeaders,
      signal: abortSignal,
    });
    if (!response?.ok) {
      throw new Error("Model discovery request failed.");
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Model discovery response is malformed.");
    }
    if (!Array.isArray(payload?.data)) {
      throw new Error("Model discovery response is malformed.");
    }
    const models = payload.data.map((model) => {
      if (
        !model
        || typeof model !== "object"
        || !requireString(model.id)
      ) {
        throw new Error("Model discovery response is malformed.");
      }
      return {
        id: model.id.trim(),
        object: requireString(model.object) || "model",
        owned_by:
          requireString(model.owned_by || model.owner)
          || "unknown",
      };
    });
    const modelIds = new Set();
    for (const model of models) {
      if (modelIds.has(model.id)) {
        throw new Error("Model discovery response is malformed.");
      }
      modelIds.add(model.id);
    }
    const now = currentDate();
    const policies = new Map();
    if (modelPolicyState) {
      let cursor;
      const cursors = new Set();
      do {
        const page = await waitForPromise(modelPolicyState.listModelPolicies({
          limit: 100, ...(cursor ? { cursor } : {}), abortSignal,
        }), abortSignal);
        if (!Array.isArray(page?.items)) throw new Error("Model policies are unavailable.");
        for (const policy of page.items) {
          if (!requireString(policy?.modelId) || policies.has(policy.modelId)) {
            throw new Error("Model policy identities are malformed.");
          }
          policies.set(policy.modelId, policy);
        }
        cursor = page.cursor;
        if (cursor && (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 20)) {
          throw new Error("Model policy inventory is incomplete.");
        }
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    return {
      discovered: models,
      entries: models.map((model) =>
        modelEntry(model, {
          catalog,
          config,
          now,
          policy: policies.get(model.id) ?? null,
          policyBacked: Boolean(modelPolicyState),
        })),
    };
  }

  const loadToolsGateway = inFlightLoader(
    (abortSignal) => componentBoundary(
      "tools-gateway",
      () => readToolsGateway(abortSignal),
    ),
  );
  const loadModels = inFlightLoader(
    (abortSignal) => componentBoundary(
      "model-gateway",
      () => readModels(abortSignal),
    ),
  );
  const registryLoads = new Map();

  function loadRegistryEntries(
    registries,
    requestBoundary,
    limits,
    displayOnly = false,
  ) {
    const key = `${displayOnly ? "display" : "strict"}:${limits?.cacheKey || "default"}:`
      + registries
      .map(({ registryId }) => registryId)
      .join(",");
    let load = registryLoads.get(key);
    if (!load) {
      load = inFlightLoader(
        (backendSignal) =>
          componentBoundary(
            "registry",
            () => readRegistryEntries(
              registries,
              backendSignal,
              limits,
              displayOnly,
            ),
          ),
        () => {
          if (registryLoads.get(key) === load) {
            registryLoads.delete(key);
          }
        },
      );
      registryLoads.set(key, load);
    }
    return load(requestBoundary);
  }

  async function scopeDomainInventory(scope, inventory, requestBoundary) {
    if (!scope?.activeDomain || scope.role === "user"
        || typeof resolvedDomainState?.getDomainResourcePolicy !== "function") return inventory;
    const policy = await waitForPromise(resolvedDomainState.getDomainResourcePolicy(
      scope.activeDomain, { abortSignal: requestBoundary.signal }), requestBoundary.signal);
    return { ...inventory,
      registry: { ...inventory.registry, ...(policy ? { domainResourcePolicyApplied: true } : {}),
        entries: filterDomainResourceEntries(inventory.registry.entries, policy) },
      aiGateway: { ...inventory.aiGateway, tools: filterDomainResourceEntries(inventory.aiGateway.tools || [], policy) } };
  }

  async function loadInventory(registries, requestBoundary, displayOnly = false) {
    const [registryEntries, tools, models] = await Promise.all([
      loadRegistryEntries(registries, requestBoundary, undefined, displayOnly),
      loadToolsGateway(requestBoundary),
      loadModels(requestBoundary),
    ]);
    // The AI Registry is the governed catalog: only models a platform
    // decision has approved appear as records. The full discovered inventory
    // (including undecided models) stays on the AI Gateway response — that is
    // the access-management surface where admins onboard models.
    const approvedModels = {
      ...models,
      entries: models.entries.filter((entry) =>
        entry.versions.some((version) => version.status === "APPROVED")),
    };
    return {
      registry: stableRegistryResponse(
        [
          ...registryEntries.entries,
          ...tools.entries,
          ...approvedModels.entries,
        ],
        registryEntries.faults,
      ),
      aiGateway: aiGatewayResponse(config, tools, models),
    };
  }

  async function loadResourceInventory(registries, requestBoundary) {
    const [registryEntries, tools] = await Promise.all([
      loadRegistryEntries(registries, requestBoundary),
      loadToolsGateway(requestBoundary),
    ]);
    return {
      registry: stableRegistryResponse(
        [
          ...registryEntries.entries,
          ...tools.entries,
        ],
        registryEntries.faults,
      ),
      aiGateway: { tools: tools.entries },
    };
  }

  async function runRequest(operation) {
    return unavailableBoundary(
      () => withOperationDeadline(timeoutMs, deadlineTimers, operation),
    );
  }

  function resolveRegistries(scope, requestBoundary) {
    return componentBoundary(
      "domain-state",
      () => selectedRegistries(
        config,
        scope,
        resolvedDomainState,
        requestBoundary.signal,
      ),
    );
  }

  async function registryOnlyResponse(scope, displayOnly = false) {
    const limits = scope?.role === "user"
      ? END_USER_REGISTRY_READ_LIMITS
      : undefined;
    if (!resolvedDomainState) {
      const registries = selectedRegistries(config, scope);
      const { entries, faults } = await runRequest(
        (requestBoundary) =>
          loadRegistryEntries(
            registries,
            requestBoundary,
            limits,
            displayOnly,
          ),
      );
      return stableRegistryResponse(entries, faults);
    }
    return runRequest(async (requestBoundary) => {
      const registries = await resolveRegistries(scope, requestBoundary);
      const { entries, faults } = await loadRegistryEntries(
        registries,
        requestBoundary,
        limits,
        displayOnly,
      );
      return stableRegistryResponse(entries, faults);
    });
  }

  return {
    async listActiveDomains() {
      if (!resolvedDomainState) {
        throw unavailableError("domain-state");
      }
      return runRequest(
        (requestBoundary) => componentBoundary(
          "domain-state",
          async () => authoritativeActiveDomains(
            await waitForPromise(
              Promise.resolve().then(() =>
                resolvedDomainState.listDomains({
                  abortSignal: requestBoundary.signal,
                })),
              requestBoundary.signal,
            ),
          ),
        ),
      );
    },

    async inventory(scope) {
      if (!resolvedDomainState) {
        const registries = selectedRegistries(config, scope);
        return runRequest(
          (requestBoundary) => loadInventory(registries, requestBoundary),
        );
      }
      return runRequest(async (requestBoundary) => {
        const registries = await resolveRegistries(scope, requestBoundary);
        return scopeDomainInventory(scope, await loadInventory(registries, requestBoundary), requestBoundary);
      });
    },

    async resourceInventory(scope) {
      if (!resolvedDomainState) {
        const registries = selectedRegistries(config, scope);
        return runRequest(
          (requestBoundary) =>
            loadResourceInventory(registries, requestBoundary),
        );
      }
      return runRequest(async (requestBoundary) => {
        const registries = await resolveRegistries(scope, requestBoundary);
        return scopeDomainInventory(scope, await loadResourceInventory(registries, requestBoundary), requestBoundary);
      });
    },

    async registry(scope) {
      if (scope?.role === "user") {
        return stableEndUserRegistryResponse(
          await registryOnlyResponse(scope, true),
        );
      }
      if (!resolvedDomainState) {
        const registries = selectedRegistries(config, scope);
        return (
          await runRequest(
            (requestBoundary) =>
              loadInventory(registries, requestBoundary, true),
          )
        ).registry;
      }
      return (
        await runRequest(async (requestBoundary) => {
          const registries = await resolveRegistries(scope, requestBoundary);
          return scopeDomainInventory(scope, await loadInventory(registries, requestBoundary, true), requestBoundary);
        })
      ).registry;
    },

    async registryOnly(scope) {
      const inventory = await registryOnlyResponse(scope);
      return scope?.role === "user"
        ? stableEndUserRegistryResponse(inventory)
        : inventory;
    },

    async aiGateway(scope) {
      if (scope?.role !== "admin") {
        throw scopeError(
          "FORBIDDEN",
          "The requested operation is not allowed.",
        );
      }
      if (!resolvedDomainState) {
        selectedRegistries(config, scope);
        return runRequest(async (requestBoundary) => {
          const [tools, models] = await Promise.all([
            loadToolsGateway(requestBoundary),
            loadModels(requestBoundary),
          ]);
          return aiGatewayResponse(config, tools, models);
        });
      }
      return runRequest(async (requestBoundary) => {
        await resolveRegistries(scope, requestBoundary);
        const [tools, models] = await Promise.all([
          loadToolsGateway(requestBoundary),
          loadModels(requestBoundary),
        ]);
        return aiGatewayResponse(config, tools, models);
      });
    },
  };
}
