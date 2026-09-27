import { createHash } from "node:crypto";

const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The model governance request is invalid.",
  }),
  FORBIDDEN: Object.freeze({
    statusCode: 403,
    message: "The requested model governance action is not allowed.",
  }),
  NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested model resource was not found.",
  }),
  CONFLICT: Object.freeze({
    statusCode: 409,
    message: "The requested model governance action conflicts with current state.",
  }),
  MODEL_GOVERNANCE_UNAVAILABLE: Object.freeze({
    statusCode: 503,
    message: "Model governance is temporarily unavailable.",
  }),
});

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const APPROVAL_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const LIMIT_FIELDS = Object.freeze([
  "requestsPerMinute",
  "tokensPerMinute",
  "connectionsPerSecond",
]);
const LIMIT_KEYS = new Set(LIMIT_FIELDS);
const LIMIT_MAXIMUMS = Object.freeze({
  requestsPerMinute: 1_000_000,
  tokensPerMinute: 1_000_000_000,
  connectionsPerSecond: 10_000,
});

export class ModelGovernanceServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) throw new TypeError("Model governance error code is invalid.");
    super(detail.message);
    this.name = "ModelGovernanceServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.statusCode === 503;
  }
}

function fail(code) {
  throw new ModelGovernanceServiceError(code);
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

function exactKeys(value, keys) {
  return (
    isPlainObject(value)
    && Reflect.ownKeys(value).length === keys.size
    && Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && keys.has(key),
    )
  );
}

function validateIdentity(identity) {
  if (
    !exactKeys(
      identity,
      new Set(["actor", "role", "activeDomain", "domainIds"]),
    )
    || !SUBJECT_PATTERN.test(identity.actor)
    || !ROLES.has(identity.role)
    || !Array.isArray(identity.domainIds)
    || identity.domainIds.length > PAGE_LIMIT
    || identity.domainIds.some((domainId) => !DOMAIN_PATTERN.test(domainId))
    || new Set(identity.domainIds).size !== identity.domainIds.length
  ) {
    fail("INVALID_REQUEST");
  }
  if (
    identity.role === "lead"
    || identity.role === "builder"
  ) {
    if (
      !DOMAIN_PATTERN.test(identity.activeDomain)
      || identity.domainIds.length !== 1
      || identity.domainIds[0] !== identity.activeDomain
    ) {
      fail("INVALID_REQUEST");
    }
  } else if (identity.activeDomain !== null) {
    if (
      identity.role !== "admin"
      || !identity.domainIds.includes(identity.activeDomain)
    ) {
      fail("INVALID_REQUEST");
    }
  }
  if (
    identity.role === "user"
    && (identity.activeDomain !== null || identity.domainIds.length !== 0)
  ) {
    fail("INVALID_REQUEST");
  }
  return Object.freeze({
    actor: identity.actor,
    role: identity.role,
    activeDomain: identity.activeDomain,
    domainIds: Object.freeze([...identity.domainIds]),
  });
}

function authorizationResource(domainId, lifecycleState = "ACTIVE") {
  return Object.freeze({
    id: `model-catalog:${domainId}`,
    domainId,
    lifecycleState,
  });
}

async function authorize(authorizer, identity, action, resource, approvalId) {
  try {
    const result = await authorizer({
      identity,
      action,
      resource,
      ...(approvalId === undefined ? {} : { approvalId }),
    });
    if (result !== true && result?.ok !== true) fail("FORBIDDEN");
  } catch (error) {
    if (error instanceof ModelGovernanceServiceError) throw error;
    fail("FORBIDDEN");
  }
}

function validateDomains(value) {
  if (!Array.isArray(value) || value.length > PAGE_LIMIT) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  const ids = [];
  for (const item of value) {
    if (!isPlainObject(item) || !DOMAIN_PATTERN.test(item.id)) {
      fail("MODEL_GOVERNANCE_UNAVAILABLE");
    }
    ids.push(item.id);
  }
  if (new Set(ids).size !== ids.length) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  return ids;
}

function validateModelEntry(value) {
  if (
    !isPlainObject(value)
    || !MODEL_ID_PATTERN.test(value.id)
    || value.type !== "Model"
    || typeof value.name !== "string"
    || value.name.length === 0
    || value.name.length > 256
    || typeof value.description !== "string"
    || value.description.length > 4096
    || !Array.isArray(value.versions)
    || value.versions.length !== 1
  ) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  const version = value.versions[0];
  if (
    !isPlainObject(version)
    || !isPlainObject(version.content)
    || version.content.gatewayModelId !== value.id
    || version.content.source !== "agentcore-gateway"
  ) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  return {
    entry: value,
    id: value.id,
    name: value.name,
    description: value.description,
    provider:
      typeof version.content.ownedBy === "string"
      && version.content.ownedBy.length > 0
        ? version.content.ownedBy
        : "unknown",
  };
}

function validateInventory(value) {
  if (
    !isPlainObject(value)
    || value.ok !== true
    || value.source !== "aws"
    || !isPlainObject(value.llmGateway)
    || !Array.isArray(value.models)
    || value.models.length > PAGE_LIMIT
  ) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  const models = value.models.map(validateModelEntry);
  if (new Set(models.map(({ id }) => id)).size !== models.length) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  return {
    region: value.region,
    toolsGateway: value.toolsGateway,
    llmGateway: value.llmGateway,
    models,
  };
}

function validStoredLimits(value) {
  return (
    exactKeys(value, LIMIT_KEYS)
    && LIMIT_FIELDS.every((field) =>
      value[field] === null
      || (
        Number.isSafeInteger(value[field])
        && value[field] > 0
        && value[field] <= LIMIT_MAXIMUMS[field]
      ))
    && LIMIT_FIELDS.some((field) => value[field] !== null)
  );
}

function validPolicy(value) {
  return (
    isPlainObject(value)
    && MODEL_ID_PATTERN.test(value.modelId)
    && Array.isArray(value.allowedDomains)
    && Array.isArray(value.requestableDomains)
    && value.allowedDomains.every((domainId) => DOMAIN_PATTERN.test(domainId))
    && value.requestableDomains.every(
      (domainId) => DOMAIN_PATTERN.test(domainId),
    )
    && validStoredLimits(value.limits)
    && ["PENDING", "ACTIVE", "RECONCILIATION_FAILED"].includes(
      value.applicationStatus,
    )
  );
}

function validatePolicyPage(page) {
  if (
    !isPlainObject(page)
    || !Array.isArray(page.items)
    || page.items.length > PAGE_LIMIT
    || (
      page.cursor !== null
      && !isPlainObject(page.cursor)
    )
  ) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  for (const item of page.items) {
    if (!validPolicy(item)) fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  return page;
}

function validateWorkflowPage(page) {
  if (
    !isPlainObject(page)
    || !Array.isArray(page.items)
    || page.items.length > PAGE_LIMIT
    || (
      page.cursor !== null
      && !isPlainObject(page.cursor)
    )
  ) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  return page;
}

async function collectPages(readPage, validatePage) {
  const items = [];
  let cursor;
  const seen = new Set();
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = validatePage(await readPage(cursor));
    items.push(...page.items);
    if (items.length > PAGE_LIMIT * MAX_PAGES) {
      fail("MODEL_GOVERNANCE_UNAVAILABLE");
    }
    if (page.cursor === null) return items;
    const encoded = JSON.stringify(page.cursor);
    if (seen.has(encoded)) fail("MODEL_GOVERNANCE_UNAVAILABLE");
    seen.add(encoded);
    cursor = page.cursor;
  }
  fail("MODEL_GOVERNANCE_UNAVAILABLE");
}

function latestRequest(approvals, modelId) {
  const candidates = approvals.filter(
    (item) =>
      isPlainObject(item)
      && item.kind === "RESOURCE_ACCESS"
      && item.resourceType === "MODEL"
      && item.resourceId === modelId
      && typeof item.requestedAt === "string",
  );
  candidates.sort((left, right) =>
    right.requestedAt.localeCompare(left.requestedAt));
  return candidates[0] ?? null;
}

function activeGrant(grants, modelId) {
  return grants.find(
    (item) =>
      isPlainObject(item)
      && item.resourceType === "MODEL"
      && item.resourceId === modelId
      && item.status === "ACTIVE",
  ) ?? null;
}

function accessProjection({
  domainId,
  modelId,
  policy,
  approvals,
  grants,
}) {
  const request = latestRequest(approvals, modelId);
  const grant = activeGrant(grants, modelId);
  const platformAllowed = domainId === "platform";
  const directlyAllowed = Boolean(
    platformAllowed
    || (
      policy
      && policy.applicationStatus === "ACTIVE"
      && policy.allowedDomains.includes(domainId)
    ),
  );
  const requestable = Boolean(
    policy
    && policy.applicationStatus === "ACTIVE"
    && policy.requestableDomains.includes(domainId),
  );
  const usable = directlyAllowed || grant !== null;
  const status = directlyAllowed
    ? "ALLOWED"
    : grant !== null
      ? "GRANTED"
      : request?.status === "PENDING"
        ? "PENDING"
        : requestable
          ? request?.status === "REJECTED"
            ? "REJECTED"
            : "REQUESTABLE"
          : "DENIED";
  return {
    status,
    usable,
    requestable,
    latestRequest: request,
    grant,
    limits: policy?.limits ?? null,
    rateLimit: policy?.rateLimit ?? null,
  };
}

function publicModel(model, access) {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    provider: model.provider,
    access: {
      status: access.status,
      usable: access.usable,
      requestable: access.requestable,
      latestRequest: access.latestRequest === null
        ? null
        : {
            id: access.latestRequest.id,
            status: access.latestRequest.status,
            requestedAt: access.latestRequest.requestedAt,
          },
      grant: access.grant === null
        ? null
        : {
            status: access.grant.status,
            grantedAt: access.grant.grantedAt,
          },
      limits: access.limits === null
        ? null
        : {
            requestsPerMinute: access.limits.requestsPerMinute,
            tokensPerMinute: access.limits.tokensPerMinute,
            connectionsPerSecond: access.limits.connectionsPerSecond,
          },
      rateLimit: access.rateLimit === null
        ? null
        : {
            status: access.rateLimit.status,
            reason: access.rateLimit.reason,
            reconciledAt: access.rateLimit.reconciledAt,
          },
    },
  };
}

function validateRequestId(value) {
  if (!REQUEST_ID_PATTERN.test(value)) fail("INVALID_REQUEST");
  return value;
}

function validateApprovalId(value) {
  if (!APPROVAL_ID_PATTERN.test(value)) fail("INVALID_REQUEST");
  return value;
}

function validateDecision(value) {
  if (value !== "APPROVE" && value !== "REJECT") {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateReason(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 1024
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateModelId(value) {
  if (!MODEL_ID_PATTERN.test(value)) fail("INVALID_REQUEST");
  return value;
}

function snapshotDomainList(value) {
  if (
    !Array.isArray(value)
    || value.length > PAGE_LIMIT
    || value.some((domainId) => !DOMAIN_PATTERN.test(domainId))
    || new Set(value).size !== value.length
  ) {
    fail("INVALID_REQUEST");
  }
  return [...value].sort();
}

function validateLimits(value) {
  if (!isPlainObject(value)) {
    fail("INVALID_REQUEST");
  }
  const keys = Object.keys(value);
  if (
    keys.length === 0
    || keys.length > LIMIT_FIELDS.length
    || keys.some((key) => !LIMIT_KEYS.has(key))
  ) {
    fail("INVALID_REQUEST");
  }

  const limits = Object.fromEntries(
    LIMIT_FIELDS.map((field) => [field, null]),
  );
  for (const field of keys) {
    const rate = value[field];
    if (rate === null) continue;
    if (
      !Number.isSafeInteger(rate)
      || rate <= 0
      || rate > LIMIT_MAXIMUMS[field]
    ) {
      fail("INVALID_REQUEST");
    }
    limits[field] = rate;
  }
  if (LIMIT_FIELDS.every((field) => limits[field] === null)) {
    fail("INVALID_REQUEST");
  }
  return limits;
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

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function transactionClock(value) {
  if (
    !isPlainObject(value)
    || typeof value.timestamp !== "string"
    || Number.isNaN(Date.parse(value.timestamp))
    || !Number.isSafeInteger(value.epochSeconds)
    || value.epochSeconds !== Math.floor(Date.parse(value.timestamp) / 1000)
  ) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  return value;
}

function validateRateLimitResult(value) {
  if (
    !isPlainObject(value)
    || typeof value.rateLimitId !== "string"
    || value.rateLimitId.length === 0
    || value.rateLimitId.length > 256
    || value.status !== "ACTIVE"
    || typeof value.synchronizedAt !== "string"
    || Number.isNaN(Date.parse(value.synchronizedAt))
  ) {
    fail("MODEL_GOVERNANCE_UNAVAILABLE");
  }
  return {
    rateLimitId: value.rateLimitId,
    status: value.status,
    synchronizedAt: value.synchronizedAt,
  };
}

function ratePolicy(policy) {
  return {
    modelId: policy.modelId,
    allowedDomains: [...policy.allowedDomains],
    requestableDomains: [...policy.requestableDomains],
    limits: { ...policy.limits },
  };
}

function policyUpsertMutation({
  identity,
  requestId,
  payload,
  record,
}) {
  return {
    actor: identity.actor,
    effectiveRole: identity.role,
    route: "POST /api/ai-gateway/model-policies",
    requestId,
    payloadFingerprint: fingerprint(payload),
    resourceKey: `model-policy/${record.modelId}`,
    operation: "UPSERT",
    decision: "upsert",
    reason: "Platform administrator updated model access.",
    timestamp: record.updatedAt,
  };
}

function policyFinalizationMutation({
  identity,
  requestId,
  payload,
  record,
  clock,
}) {
  const active = record.applicationStatus === "ACTIVE";
  return {
    actor: identity.actor,
    effectiveRole: identity.role,
    route: "POST /internal/model-policies/application",
    requestId: `${requestId}:application`,
    payloadFingerprint: fingerprint(payload),
    resourceKey: `model-policy/${record.modelId}`,
    operation: "FINALIZE",
    decision: active ? "activate" : "fail",
    reason: active
      ? "AgentCore Gateway rate limits reconciled."
      : record.rateLimit.reason,
    timestamp: clock.timestamp,
  };
}

function workspaceMutation({
  identity,
  requesterSubject = identity.actor,
  requestId,
  route,
  payload,
  entityType,
  resourceKey,
  operation,
  domainId,
  decision,
  reason,
  clock,
}) {
  return {
    actor: identity.actor,
    requesterSubject,
    effectiveRole: identity.role,
    domainId,
    projectId: null,
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
  };
}

function validateApproval(value, {
  domainId,
  approvalId,
  modelId,
  status,
} = {}) {
  if (
    !isPlainObject(value)
    || value.domainId !== domainId
    || value.id !== approvalId
    || value.kind !== "RESOURCE_ACCESS"
    || value.resourceType !== "MODEL"
    || value.resourceId !== modelId
    || value.projectId !== null
    || (
      status !== undefined
      && value.status !== status
    )
    || !SUBJECT_PATTERN.test(value.requesterSubject)
  ) {
    fail("CONFLICT");
  }
  return value;
}

function validateGrant(value, { domainId, modelId } = {}) {
  if (value === null) return null;
  if (
    !isPlainObject(value)
    || value.domainId !== domainId
    || value.resourceType !== "MODEL"
    || value.resourceId !== modelId
  ) {
    fail("CONFLICT");
  }
  return value;
}

export function createModelGovernanceService({
  modelPolicyState,
  workspaceState,
  domainDirectory,
  inventoryReader,
  rateLimitManager,
  authorizer,
} = {}) {
  if (
    !modelPolicyState
    || ![
      "beginTransaction",
      "getModelPolicy",
      "listModelPolicies",
      "getMutationResult",
      "putModelPolicy",
      "finalizeModelPolicyApplication",
    ].every((method) => typeof modelPolicyState[method] === "function")
    || !workspaceState
    || ![
      "beginTransaction",
      "listApprovals",
      "listResourceGrants",
      "getApproval",
      "getResourceGrant",
      "getMutationResult",
      "putApproval",
      "putAccessDecision",
    ].every((method) => typeof workspaceState[method] === "function")
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || typeof inventoryReader !== "function"
    || !rateLimitManager
    || typeof rateLimitManager.reconcile !== "function"
    || typeof authorizer !== "function"
  ) {
    throw new TypeError("Model governance dependencies are invalid.");
  }

  async function listPolicies() {
    return collectPages(
      (cursor) => modelPolicyState.listModelPolicies({
        limit: PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      validatePolicyPage,
    );
  }

  async function readDomainWorkflow(domainId) {
    const [approvals, grants] = await Promise.all([
      collectPages(
        (cursor) => workspaceState.listApprovals({
          domainId,
          limit: PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        }),
        validateWorkflowPage,
      ),
      collectPages(
        (cursor) => workspaceState.listResourceGrants({
          domainId,
          limit: PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        }),
        validateWorkflowPage,
      ),
    ]);
    return { approvals, grants };
  }

  return {
    async readCatalog(input) {
      if (!exactKeys(input, new Set(["identity"]))) fail("INVALID_REQUEST");
      const identity = validateIdentity(input.identity);
      const authorizationDomain =
        identity.role === "lead" || identity.role === "builder"
          ? identity.activeDomain
          : "platform";
      await authorize(
        authorizer,
        identity,
        "model-catalog:read",
        authorizationResource(authorizationDomain),
      );
      if (!["admin", "lead", "builder"].includes(identity.role)) {
        fail("FORBIDDEN");
      }

      let activeDomains;
      let inventory;
      let policyRecords;
      try {
        [activeDomains, inventory, policyRecords] = await Promise.all([
          domainDirectory.listActiveDomains().then(validateDomains),
          inventoryReader().then(validateInventory),
          listPolicies(),
        ]);
      } catch (error) {
        if (error instanceof ModelGovernanceServiceError) throw error;
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      if (
        (identity.role === "lead" || identity.role === "builder")
        && !activeDomains.includes(identity.activeDomain)
      ) {
        fail("FORBIDDEN");
      }
      const policiesByModel = new Map(
        policyRecords.map((policy) => [policy.modelId, policy]),
      );

      if (identity.role === "admin") {
        const workflows = new Map(
          await Promise.all(
            activeDomains.map(async (domainId) => [
              domainId,
              await readDomainWorkflow(domainId),
            ]),
          ),
        );
        return {
          ok: true,
          source: "aws",
          region: inventory.region,
          toolsGateway: inventory.toolsGateway,
          llmGateway: inventory.llmGateway,
          models: inventory.models.map((model) => {
            const policy = policiesByModel.get(model.id) ?? null;
            const accessByDomain = Object.fromEntries(
              activeDomains.map((domainId) => {
                const workflow = workflows.get(domainId);
                return [
                  domainId,
                  accessProjection({
                    domainId,
                    modelId: model.id,
                    policy,
                    approvals: workflow.approvals,
                    grants: workflow.grants,
                  }),
                ];
              }),
            );
            return {
              ...model.entry,
              policy,
              accessByDomain,
            };
          }),
        };
      }

      const domainId = identity.activeDomain;
      const workflow = await readDomainWorkflow(domainId);
      return {
        ok: true,
        source: "aws",
        domainId,
        models: inventory.models.flatMap((model) => {
          const policy = policiesByModel.get(model.id) ?? null;
          const access = accessProjection({
            domainId,
            modelId: model.id,
            policy,
            approvals: workflow.approvals,
            grants: workflow.grants,
          });
          return access.status === "DENIED"
            ? []
            : [publicModel(model, access)];
        }),
      };
    },

    async putPolicy(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "modelId",
            "allowedDomains",
            "requestableDomains",
            "limits",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const modelId = validateModelId(input.modelId);
      const allowedDomains = snapshotDomainList(input.allowedDomains);
      const requestableDomains = snapshotDomainList(
        input.requestableDomains,
      );
      const limits = validateLimits(input.limits);
      await authorize(
        authorizer,
        identity,
        "model-policy:update",
        {
          id: `model-policy:${modelId}`,
          lifecycleState: "ACTIVE",
        },
      );
      if (identity.role !== "admin") fail("FORBIDDEN");
      if (
        allowedDomains.some((domainId) =>
          requestableDomains.includes(domainId))
      ) {
        fail("INVALID_REQUEST");
      }

      const payload = {
        modelId,
        allowedDomains,
        requestableDomains,
        limits,
      };
      let replay;
      try {
        replay = await modelPolicyState.getMutationResult({
          actor: identity.actor,
          route: "POST /api/ai-gateway/model-policies",
          requestId,
        });
      } catch {
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      if (
        replay !== null
        && (
          !isPlainObject(replay)
          || !validPolicy(replay.record)
          || !isPlainObject(replay.mutation)
          || replay.mutation.actor !== identity.actor
          || replay.mutation.route
            !== "POST /api/ai-gateway/model-policies"
          || replay.mutation.requestId !== requestId
          || replay.mutation.payloadFingerprint !== fingerprint(payload)
          || replay.mutation.resourceKey !== `model-policy/${modelId}`
          || replay.mutation.operation !== "UPSERT"
          || replay.mutation.decision !== "upsert"
          || replay.record.modelId !== modelId
          || replay.record.applicationStatus !== "PENDING"
          || replay.record.rateLimit !== null
        )
      ) {
        fail("CONFLICT");
      }
      let activeDomains;
      let inventory;
      let policyRecords;
      try {
        [activeDomains, inventory, policyRecords] = await Promise.all([
          domainDirectory.listActiveDomains().then(validateDomains),
          inventoryReader().then(validateInventory),
          listPolicies(),
        ]);
      } catch (error) {
        if (error instanceof ModelGovernanceServiceError) throw error;
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      const knownModel = inventory.models.some(
        (model) => model.id === modelId,
      );
      if (
        !knownModel
        || [...allowedDomains, ...requestableDomains].some(
          (domainId) => !activeDomains.includes(domainId),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const previous = policyRecords.find(
        (policy) => policy.modelId === modelId,
      ) ?? null;
      const intended = {
        modelId,
        allowedDomains,
        requestableDomains,
        limits,
      };
      let pending;
      if (replay !== null) {
        const current = previous;
        if (
          current === null
          || current.revision !== replay.record.revision
          || current.modelId !== replay.record.modelId
          || current.updatedBySubject !== replay.record.updatedBySubject
          || current.updatedAt !== replay.record.updatedAt
        ) {
          fail("CONFLICT");
        }
        if (current.applicationStatus === "ACTIVE") return current;
        if (current.applicationStatus === "RECONCILIATION_FAILED") {
          fail("MODEL_GOVERNANCE_UNAVAILABLE");
        }
        if (current.applicationStatus !== "PENDING") fail("CONFLICT");
        pending = current;
      } else {
        if (previous?.applicationStatus === "PENDING") fail("CONFLICT");
        const revision =
          Number.isSafeInteger(previous?.revision)
          && previous.revision >= 1
            ? previous.revision + 1
            : 1;
        let clock;
        try {
          clock = transactionClock(
            await modelPolicyState.beginTransaction(),
          );
        } catch (error) {
          if (error instanceof ModelGovernanceServiceError) throw error;
          fail("MODEL_GOVERNANCE_UNAVAILABLE");
        }
        pending = {
          ...intended,
          applicationStatus: "PENDING",
          rateLimit: null,
          updatedBySubject: identity.actor,
          updatedAt: clock.timestamp,
          revision,
        };
        const mutation = policyUpsertMutation({
          identity,
          requestId,
          payload,
          record: pending,
        });
        try {
          pending = await modelPolicyState.putModelPolicy({
            record: pending,
            expectedRevision: previous?.revision ?? null,
            mutation,
            transaction: clock,
          });
        } catch (error) {
          if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
          fail("MODEL_GOVERNANCE_UNAVAILABLE");
        }
      }
      const completeSet = [
        ...policyRecords.filter(
          (policy) =>
            policy.modelId !== modelId
            && policy.applicationStatus === "ACTIVE",
        ).map(ratePolicy),
        intended,
      ].sort((left, right) => left.modelId.localeCompare(right.modelId));

      let reconciliation;
      let applicationStatus;
      try {
        reconciliation = validateRateLimitResult(
          await rateLimitManager.reconcile({ policies: completeSet }),
        );
        applicationStatus = "ACTIVE";
      } catch {
        applicationStatus = "RECONCILIATION_FAILED";
      }
      let finalClock;
      try {
        finalClock = transactionClock(
          await modelPolicyState.beginTransaction(),
        );
      } catch (error) {
        if (error instanceof ModelGovernanceServiceError) throw error;
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      const record = {
        ...pending,
        applicationStatus,
        rateLimit: applicationStatus === "ACTIVE"
          ? {
              id: reconciliation.rateLimitId,
              status: "ACTIVE",
              reason: null,
              reconciledAt: finalClock.timestamp,
            }
          : {
              id: null,
              status: "RECONCILIATION_FAILED",
              reason:
                "AgentCore Gateway rate-limit reconciliation failed.",
              reconciledAt: finalClock.timestamp,
            },
      };
      const mutation = policyFinalizationMutation({
        identity,
        requestId,
        payload,
        record,
        clock: finalClock,
      });
      try {
        const finalized =
          await modelPolicyState.finalizeModelPolicyApplication({
          record,
          expectedStatus: "PENDING",
          mutation,
          transaction: finalClock,
        });
        if (
          !validPolicy(finalized)
          || finalized.modelId !== record.modelId
          || finalized.revision !== record.revision
          || finalized.applicationStatus !== record.applicationStatus
        ) {
          fail("MODEL_GOVERNANCE_UNAVAILABLE");
        }
      } catch (error) {
        if (error instanceof ModelGovernanceServiceError) throw error;
        if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      if (applicationStatus !== "ACTIVE") {
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      return record;
    },

    async requestAccess(input) {
      if (
        !exactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "approvalId",
            "modelId",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const approvalId = validateApprovalId(input.approvalId);
      const modelId = validateModelId(input.modelId);
      const domainId = identity.activeDomain;
      await authorize(
        authorizer,
        identity,
        "model-access:request",
        {
          id: modelId,
          domainId:
            typeof domainId === "string" ? domainId : "platform",
          lifecycleState: "REQUESTABLE",
        },
      );
      if (!["lead", "builder"].includes(identity.role)) fail("FORBIDDEN");

      let policy;
      let currentApproval;
      let currentGrant;
      let inventory;
      try {
        [policy, currentApproval, currentGrant, inventory] =
          await Promise.all([
            modelPolicyState.getModelPolicy({ modelId }),
            workspaceState.getApproval({ domainId, approvalId }),
            workspaceState.getResourceGrant({
              domainId,
              resourceType: "MODEL",
              resourceId: modelId,
            }),
            inventoryReader().then(validateInventory),
          ]);
      } catch (error) {
        if (error instanceof ModelGovernanceServiceError) throw error;
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      if (currentApproval !== null) fail("CONFLICT");
      currentGrant = validateGrant(currentGrant, { domainId, modelId });
      if (
        currentGrant?.status === "ACTIVE"
        || !validPolicy(policy)
        || policy.applicationStatus !== "ACTIVE"
        || policy.allowedDomains.includes(domainId)
        || !policy.requestableDomains.includes(domainId)
        || !inventory.models.some((model) => model.id === modelId)
      ) {
        fail("CONFLICT");
      }
      let clock;
      try {
        clock = transactionClock(
          await workspaceState.beginTransaction(),
        );
      } catch {
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      const record = {
        domainId,
        id: approvalId,
        kind: "RESOURCE_ACCESS",
        resourceType: "MODEL",
        resourceId: modelId,
        projectId: null,
        status: "PENDING",
        requesterSubject: identity.actor,
        approverSubject: null,
        reason: null,
        requestedAt: clock.timestamp,
        decidedAt: null,
      };
      const payload = { approvalId, modelId };
      const mutation = workspaceMutation({
        identity,
        requestId,
        route: "POST /api/ai-gateway/model-access-requests",
        payload,
        entityType: "APPROVAL",
        resourceKey: `approval/${domainId}/${approvalId}`,
        operation: "CREATE",
        domainId,
        decision: "create",
        reason: "Model access requested.",
        clock,
      });
      try {
        return await workspaceState.putApproval({
          record,
          expectedStatus: null,
          mutation,
          transaction: clock,
        });
      } catch (error) {
        if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
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
      const approvalId = validateApprovalId(input.approvalId);
      const decision = validateDecision(input.decision);
      const reason = validateReason(input.reason);
      const domainId = identity.activeDomain;
      await authorize(
        authorizer,
        identity,
        "model-access:decide",
        {
          id: `model-access:${domainId || "platform"}/${approvalId}`,
          domainId:
            typeof domainId === "string" ? domainId : "platform",
          lifecycleState: "PENDING_APPROVAL",
        },
        approvalId,
      );
      if (identity.role !== "lead") fail("FORBIDDEN");
      let approval;
      try {
        approval = await workspaceState.getApproval({
          domainId,
          approvalId,
        });
      } catch {
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      if (approval === null) fail("NOT_FOUND");
      approval = validateApproval(approval, {
        domainId,
        approvalId,
        modelId: approval.resourceId,
        status: "PENDING",
      });
      if (approval.requesterSubject === identity.actor) fail("FORBIDDEN");
      const modelId = approval.resourceId;
      let policy;
      let currentGrant;
      try {
        [policy, currentGrant] = await Promise.all([
          modelPolicyState.getModelPolicy({ modelId }),
          workspaceState.getResourceGrant({
            domainId,
            resourceType: "MODEL",
            resourceId: modelId,
          }),
        ]);
      } catch {
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      currentGrant = validateGrant(currentGrant, { domainId, modelId });
      if (
        !validPolicy(policy)
        || policy.applicationStatus !== "ACTIVE"
        || !policy.requestableDomains.includes(domainId)
      ) {
        fail("CONFLICT");
      }
      if (decision === "APPROVE" && currentGrant !== null) {
        fail("CONFLICT");
      }
      let clock;
      try {
        clock = transactionClock(
          await workspaceState.beginTransaction(),
        );
      } catch {
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
      const decidedApproval = {
        ...approval,
        status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
        approverSubject: identity.actor,
        reason,
        decidedAt: clock.timestamp,
      };
      const payload = { approvalId, decision, reason };
      const approvalMutation = workspaceMutation({
        identity,
        requesterSubject: approval.requesterSubject,
        requestId: `${requestId}.approval`,
        route: "POST /api/ai-gateway/model-access-decisions",
        payload,
        entityType: "APPROVAL",
        resourceKey: `approval/${domainId}/${approvalId}`,
        operation: "UPDATE",
        domainId,
        decision: decision.toLowerCase(),
        reason,
        clock,
      });
      if (decision === "REJECT") {
        try {
          const result = await workspaceState.putApproval({
            record: decidedApproval,
            expectedStatus: "PENDING",
            mutation: approvalMutation,
            transaction: clock,
          });
          return { approval: result, grant: null };
        } catch (error) {
          if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
          fail("MODEL_GOVERNANCE_UNAVAILABLE");
        }
      }
      const grant = {
        domainId,
        resourceType: "MODEL",
        resourceId: modelId,
        status: "ACTIVE",
        grantedBySubject: identity.actor,
        grantedAt: clock.timestamp,
        revokedBySubject: null,
        revokedAt: null,
      };
      const grantMutation = workspaceMutation({
        identity,
        requestId: `${requestId}.grant`,
        route: "POST /api/ai-gateway/model-access-decisions",
        payload,
        entityType: "RESOURCE_GRANT",
        resourceKey: `grant/${domainId}/MODEL/${modelId}`,
        operation: "CREATE",
        domainId,
        decision: "grant",
        reason,
        clock,
      });
      try {
        return await workspaceState.putAccessDecision({
          approval: {
            record: decidedApproval,
            expectedStatus: "PENDING",
            mutation: approvalMutation,
          },
          grant: {
            record: grant,
            expectedStatus: null,
            mutation: grantMutation,
          },
          transaction: clock,
        });
      } catch (error) {
        if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
        fail("MODEL_GOVERNANCE_UNAVAILABLE");
      }
    },
  };
}
