import { projectAllowsAgent } from "../../../../console/public/project-resource-policy.mjs";
import { createHash } from "node:crypto";
import {
  domainGatewaySourceIdentity,
} from "../workspace/gateway-source-identity.mjs";
import {
  validateAgentBuildConfig,
} from "../workspace/state.mjs";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RESOURCE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,255}$/;
const RESOURCE_LIST_LIMIT = 20;
const INPUT_ROLES = new Set(["admin", "lead", "builder", "user"]);
const SUCCESSFUL_TEST_EVIDENCE_STATUSES = new Set([
  "TESTED",
  "SANDBOX_DEPLOYED",
  "PRODUCTION_PENDING",
  "PRODUCTION_APPROVED",
  "PRODUCTION_DEPLOYED",
  "REJECTED",
]);
const CREATE_KEYS = new Set([
  "domainId",
  "projectId",
  "id",
  "name",
  "description",
  "modelId",
  "toolIds",
  "mcpServerIds",
  "skillIds",
  "blueprintIds",
  "memoryIds",
  "knowledgeBaseIds",
  "buildConfig",
]);
const REF_KEYS = new Set(["domainId", "projectId", "agentId"]);
const GRANT_SELECTIONS = Object.freeze([
  ["TOOL", "toolIds", true],
  ["MCP_SERVER", "mcpServerIds", true],
  ["SKILL", "skillIds", true],
  ["BLUEPRINT", "blueprintIds", true],
  ["MEMORY", "memoryIds", true],
  ["KNOWLEDGE_BASE", "knowledgeBaseIds", true],
]);
const PLATFORM_BLUEPRINT_IDS = new Set([
  "chat-assistant",
  "workflow-orchestrator",
]);
const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: {
    statusCode: 400,
    message: "The builder request is invalid.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested operation is not allowed.",
    retryable: false,
  },
  RESOURCE_NOT_GRANTED: {
    statusCode: 403,
    message: "A selected resource is not granted to the active domain.",
    retryable: false,
  },
  NOT_FOUND: {
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  },
  CONFLICT: {
    statusCode: 409,
    message: "The resource state does not permit the requested operation.",
    retryable: false,
  },
  REQUEST_IN_PROGRESS: {
    statusCode: 409,
    message:
      "The request ID is already reserved. Start interrupted work with a new request ID.",
    retryable: false,
  },
  GATEWAY_UNAVAILABLE: {
    statusCode: 503,
    message: "The model test is temporarily unavailable.",
    retryable: true,
  },
  GATEWAY_REJECTED: {
    statusCode: 502,
    message: "The model test was rejected.",
    retryable: false,
  },
  WORKSPACE_UNAVAILABLE: {
    statusCode: 503,
    message: "The builder workspace is temporarily unavailable.",
    retryable: true,
  },
});

export class BuilderServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) throw new TypeError("Builder service error code is invalid.");
    super(detail.message);
    this.name = "BuilderServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.retryable;
  }
}

function fail(code) {
  throw new BuilderServiceError(code);
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

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === expected.size
    && keys.every((key) => expected.has(key))
  );
}

function text(value, maxLength, { empty = false } = {}) {
  return (
    typeof value === "string"
    && value.length <= maxLength
    && value === value.trim()
    && (empty || value.length > 0)
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function resourceList(value) {
  if (
    !Array.isArray(value)
    || value.length > RESOURCE_LIST_LIMIT
    || value.some((entry) =>
      typeof entry !== "string"
      || !RESOURCE_ID_PATTERN.test(entry))
    || new Set(value).size !== value.length
  ) {
    fail("INVALID_REQUEST");
  }
  return [...value];
}

function validateIdentity(value) {
  if (
    !hasExactKeys(
      value,
      new Set(["actor", "role", "activeDomain", "domainIds"]),
    )
    || !SUBJECT_PATTERN.test(value.actor)
    || !INPUT_ROLES.has(value.role)
    || !Array.isArray(value.domainIds)
    || value.domainIds.some((domainId) => !DOMAIN_PATTERN.test(domainId))
    || new Set(value.domainIds).size !== value.domainIds.length
  ) {
    fail("INVALID_REQUEST");
  }
  if (value.role === "user") fail("FORBIDDEN");
  if (
    (value.role === "lead" || value.role === "builder")
    && (
      !DOMAIN_PATTERN.test(value.activeDomain)
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
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateAgentRef(value) {
  if (
    !hasExactKeys(value, REF_KEYS)
    || !DOMAIN_PATTERN.test(value.domainId)
    || !SLUG_PATTERN.test(value.projectId)
    || !SLUG_PATTERN.test(value.agentId)
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function validatePayload(value) {
  if (
    !hasExactKeys(value, CREATE_KEYS)
    || !DOMAIN_PATTERN.test(value.domainId)
    || !SLUG_PATTERN.test(value.projectId)
    || !SLUG_PATTERN.test(value.id)
    || !text(value.name, 128)
    || !text(value.description, 4096, { empty: true })
    || typeof value.modelId !== "string"
    || !RESOURCE_ID_PATTERN.test(value.modelId)
  ) {
    fail("INVALID_REQUEST");
  }
  let buildConfig;
  try {
    buildConfig = validateAgentBuildConfig(value.buildConfig);
  } catch {
    fail("INVALID_REQUEST");
  }
  return {
    domainId: value.domainId,
    projectId: value.projectId,
    id: value.id,
    name: value.name,
    description: value.description,
    modelId: value.modelId,
    toolIds: resourceList(value.toolIds),
    mcpServerIds: resourceList(value.mcpServerIds),
    skillIds: resourceList(value.skillIds),
    blueprintIds: resourceList(value.blueprintIds),
    memoryIds: resourceList(value.memoryIds),
    knowledgeBaseIds: resourceList(value.knowledgeBaseIds),
    buildConfig,
  };
}

function beginTransaction(state) {
  let transaction;
  try {
    transaction = state.beginTransaction();
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  const timestampEpoch = typeof transaction?.timestamp === "string"
    ? Date.parse(transaction.timestamp)
    : Number.NaN;
  if (
    !isPlainObject(transaction)
    || Object.keys(transaction).sort().join(",")
      !== "epochSeconds,timestamp"
    || !text(transaction.timestamp, 32)
    || !Number.isFinite(timestampEpoch)
    || new Date(timestampEpoch).toISOString() !== transaction.timestamp
    || !Number.isSafeInteger(transaction.epochSeconds)
    || transaction.epochSeconds
      !== Math.floor(timestampEpoch / 1000)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return transaction;
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

function mutation({
  identity,
  requestId,
  payloadFingerprint,
  route,
  operation,
  reason,
  timestamp,
  resourceKey,
  decision = operation.toLowerCase(),
  status = "SUCCEEDED",
}) {
  return {
    actor: identity.actor,
    requesterSubject: identity.actor,
    effectiveRole: identity.role,
    domainId: identity.activeDomain || "platform",
    projectId: resourceKey.split("/")[2],
    route,
    requestId,
    payloadFingerprint,
    result: {
      entityType: "AGENT",
      resourceKey,
      operation,
      status,
    },
    decision,
    reason,
    timestamp,
    createdAt: timestamp,
  };
}

function resourceKey({ domainId, projectId, id }) {
  return `agent/${domainId}/${projectId}/${id}`;
}

function projectRef({ domainId, projectId }) {
  return `project:${domainId}/${projectId}`;
}

function agentRef({ domainId, projectId, agentId }) {
  return `agent:${domainId}/${projectId}/${agentId}`;
}

async function authorize(
  authorizer,
  identity,
  action,
  ref,
  builderAuthorization = null,
) {
  let result;
  try {
    result = await authorizer({
      requestContext: Object.freeze({
        source: "builder-service",
        subject: identity.actor,
        role: identity.role,
        activeDomain: identity.activeDomain,
        domainIds: Object.freeze([...identity.domainIds]),
        ...(builderAuthorization === null
          ? {}
          : {
              builderAction: builderAuthorization.action,
              builderResourceRef: builderAuthorization.resourceRef,
            }),
      }),
      action,
      resourceRef: ref,
    });
  } catch (error) {
    if (error?.decision === "NOT_FOUND") fail("NOT_FOUND");
    if (error?.decision === "CONFLICT") fail("CONFLICT");
    fail("FORBIDDEN");
  }
  if (result !== true && result?.ok !== true) fail("FORBIDDEN");
}

async function readProject(state, domainId, projectId) {
  let value;
  try {
    value = await state.getProject({ domainId, projectId });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (value === null) fail("NOT_FOUND");
  if (
    !isPlainObject(value)
    || value.domainId !== domainId
    || value.id !== projectId
    || value.status !== "ACTIVE"
  ) {
    fail("CONFLICT");
  }
  return value;
}

async function readAgent(state, ref) {
  let value;
  try {
    value = await state.getAgent({
      domainId: ref.domainId,
      projectId: ref.projectId,
      agentId: ref.agentId,
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (value === null) fail("NOT_FOUND");
  if (
    !isPlainObject(value)
    || value.domainId !== ref.domainId
    || value.projectId !== ref.projectId
    || value.id !== ref.agentId
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return value;
}

async function validateGrants(
  state,
  resourceAccessResolver,
  identity,
  payload,
) {
  let required;
  try {
    required = await resourceAccessResolver({
      identity: structuredClone(identity),
      payload: structuredClone(payload),
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "builder_resource_access_failed",
      code: error?.code ?? null,
      component: error?.component ?? null,
      name: error?.name ?? "Error",
    }));
    fail("RESOURCE_NOT_GRANTED");
  }
  if (
    !Array.isArray(required)
    || required.some((item) =>
      !isPlainObject(item)
      || !GRANT_SELECTIONS.some(([resourceType]) =>
        resourceType === item.resourceType)
      || typeof item.resourceId !== "string")
  ) {
    fail("RESOURCE_NOT_GRANTED");
  }
  for (const { resourceType, resourceId } of required) {
      let grant;
      try {
        grant = await state.getResourceGrant({
          domainId: payload.domainId,
          resourceType,
          resourceId,
        });
      } catch {
        fail("WORKSPACE_UNAVAILABLE");
      }
      if (
        !isPlainObject(grant)
        || grant.domainId !== payload.domainId
        || grant.resourceType !== resourceType
        || grant.resourceId !== resourceId
        || grant.status !== "ACTIVE"
      ) {
        fail("RESOURCE_NOT_GRANTED");
      }
  }
}

async function validateModelAccess(
  workspaceState,
  authorizer,
  modelAccessResolver,
  identity,
  payload,
  builderAuthorization,
) {
  const project = await readProject(workspaceState, payload.domainId, payload.projectId);
  if (!projectAllowsAgent(project, payload)) fail("RESOURCE_NOT_GRANTED");
  await authorize(
    authorizer,
    identity,
    "model:use",
    projectRef(payload),
    builderAuthorization,
  );
  let allowed;
  try {
    allowed = await modelAccessResolver({
      domainId: payload.domainId,
      modelId: payload.modelId,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "builder_model_access_failed",
      code: error?.code ?? null,
      name: error?.name ?? "Error",
    }));
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (allowed !== true) fail("RESOURCE_NOT_GRANTED");
}

function blankEvidence() {
  return {
    lastTestStatus: null,
    lastTestedAt: null,
    lastTestedBySubject: null,
    lastTestModelId: null,
    lastTestInputTokens: null,
    lastTestOutputTokens: null,
    lastTestRequestId: null,
    lastTestEvidenceHash: null,
    lastTestOutput: null,
  };
}

function configuredRecord(current, payload, identity, timestamp) {
  return {
    ...current,
    name: payload.name,
    description: payload.description,
    modelId: payload.modelId,
    toolIds: [...payload.toolIds],
    mcpServerIds: [...payload.mcpServerIds],
    skillIds: [...payload.skillIds],
    blueprintIds: [...payload.blueprintIds],
    memoryIds: [...payload.memoryIds],
    knowledgeBaseIds: [...payload.knowledgeBaseIds],
    buildConfig: payload.buildConfig,
    ownerSubject: current.ownerSubject || identity.actor,
    updatedAt: timestamp,
  };
}

async function persistAgent(state, input) {
  try {
    return await state.putAgent(input);
  } catch (error) {
    if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
    throw error instanceof BuilderServiceError
      ? error
      : new BuilderServiceError("WORKSPACE_UNAVAILABLE");
  }
}

async function mutationResult(state, input) {
  try {
    return await state.getMutationResult({
      actor: input.identity.actor,
      route: input.route,
      requestId: input.requestId,
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
}

function mutationMatches(stored, expected) {
  const result = stored?.result;
  return (
    isPlainObject(stored)
    && isPlainObject(result)
    && stored.actor === expected.identity.actor
    && stored.requesterSubject === expected.identity.actor
    && stored.effectiveRole === expected.identity.role
    && stored.domainId === expected.domainId
    && stored.projectId === expected.projectId
    && stored.route === expected.route
    && stored.requestId === expected.requestId
    && stored.payloadFingerprint === expected.payloadFingerprint
    && result.entityType === "AGENT"
    && result.resourceKey === expected.resourceKey
    && result.operation === expected.operation
    && (result.status === "SUCCEEDED" || result.status === "FAILED")
  );
}

async function authoritativeReplayAgent(state, ref) {
  let value;
  try {
    value = await state.getAgent({
      domainId: ref.domainId,
      projectId: ref.projectId,
      agentId: ref.agentId,
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (
    !isPlainObject(value)
    || value.domainId !== ref.domainId
    || value.projectId !== ref.projectId
    || value.id !== ref.agentId
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return value;
}

function replayedTest(agent) {
  if (
    !SUCCESSFUL_TEST_EVIDENCE_STATUSES.has(agent.status)
    || agent.lastTestStatus !== "SUCCEEDED"
    || typeof agent.lastTestOutput !== "string"
    || typeof agent.lastTestRequestId !== "string"
    || !REQUEST_ID_PATTERN.test(agent.lastTestRequestId)
    || !Number.isSafeInteger(agent.lastTestInputTokens)
    || agent.lastTestInputTokens < 0
    || !Number.isSafeInteger(agent.lastTestOutputTokens)
    || agent.lastTestOutputTokens < 0
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return {
    agent,
    test: {
      output: agent.lastTestOutput,
      requestId: agent.lastTestRequestId,
      usage: {
        inputTokens: agent.lastTestInputTokens,
        outputTokens: agent.lastTestOutputTokens,
      },
    },
  };
}

async function replayCompletedMutation(state, expected, ref, {
  test = false,
} = {}) {
  const stored = await mutationResult(state, expected);
  if (stored === null) return null;
  if (!mutationMatches(stored, expected)) fail("CONFLICT");
  let replayFailure = null;
  if (stored.result.status === "FAILED") {
    if (
      stored.decision !== "abort"
      || (
        stored.reason !== "Gateway test was rejected."
        && stored.reason
          !== "Gateway test failed with a retryable error."
      )
    ) {
      fail("CONFLICT");
    }
    replayFailure =
      stored.reason === "Gateway test was rejected."
        ? "GATEWAY_REJECTED"
        : "GATEWAY_UNAVAILABLE";
    if (!test) fail(replayFailure);
  }
  if (
    replayFailure === null
    && (
      stored.decision !== expected.operation.toLowerCase()
      || stored.reason !== expected.successReason
    )
  ) {
    fail("CONFLICT");
  }
  const agent = await authoritativeReplayAgent(state, ref);
  if (replayFailure !== null) {
    return { agent, replayFailure };
  }
  return test ? replayedTest(agent) : agent;
}

async function claimSideEffect(state, input) {
  try {
    if (await state.claimMutation(input) !== true) {
      fail("WORKSPACE_UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof BuilderServiceError) throw error;
    if (error?.code === "MUTATION_IN_PROGRESS") {
      fail("REQUEST_IN_PROGRESS");
    }
    if (error?.code === "MUTATION_CONFLICT") fail("CONFLICT");
    fail("WORKSPACE_UNAVAILABLE");
  }
}

export function createBuilderService({
  workspaceState,
  authorizer,
  modelAccessResolver,
  modelSelectionResolver,
  resourceAccessResolver,
  gateway,
} = {}) {
  if (
    !workspaceState
    || ![
      "getProject",
      "getAgent",
      "getResourceGrant",
      "getMutationResult",
      "claimMutation",
      "beginTransaction",
      "putAgent",
    ]
      .every((method) => typeof workspaceState[method] === "function")
    || typeof authorizer !== "function"
    || typeof modelAccessResolver !== "function"
    || typeof resourceAccessResolver !== "function"
    || !gateway
    || typeof gateway.invoke !== "function"
  ) {
    throw new TypeError("Builder service configuration is invalid.");
  }

  return {
    async createAgent(input) {
      if (
        !isPlainObject(input)
        || Object.keys(input).sort().join(",")
          !== "identity,payload,requestId"
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const payload = validatePayload(input.payload);
      if (
        identity.role !== "admin"
        && payload.domainId !== identity.activeDomain
      ) {
        fail("NOT_FOUND");
      }
      const key = resourceKey(payload);
      const payloadFingerprint = fingerprint(payload);
      const replay = await replayCompletedMutation(
        workspaceState,
        {
          identity,
          domainId: payload.domainId,
          projectId: payload.projectId,
          route: "POST /api/agents",
          requestId,
          payloadFingerprint,
          resourceKey: key,
          operation: "CREATE",
          successReason: "Agent draft created.",
        },
        {
          domainId: payload.domainId,
          projectId: payload.projectId,
          agentId: payload.id,
        },
      );
      if (replay !== null) {
        await authorize(
          authorizer,
          identity,
          "agent:create",
          projectRef(payload),
        );
        await validateModelAccess(
          workspaceState,
          authorizer,
          modelSelectionResolver ?? modelAccessResolver,
          identity,
          payload,
          {
            action: "agent:create",
            resourceRef: projectRef(payload),
          },
        );
        return replay;
      }
      await readProject(
        workspaceState,
        payload.domainId,
        payload.projectId,
      );
      await authorize(
        authorizer,
        identity,
        "agent:create",
        projectRef(payload),
      );
      await validateModelAccess(
        workspaceState,
        authorizer,
        modelSelectionResolver ?? modelAccessResolver,
        identity,
        payload,
        {
          action: "agent:create",
          resourceRef: projectRef(payload),
        },
      );
      await validateGrants(
        workspaceState,
        resourceAccessResolver,
        identity,
        payload,
      );
      const transaction = beginTransaction(workspaceState);
      const now = transaction;
      const record = {
        ...payload,
        ownerSubject: identity.actor,
        status: "DRAFT",
        createdBySubject: identity.actor,
        createdAt: now.timestamp,
        updatedAt: now.timestamp,
        ...blankEvidence(),
      };
      return persistAgent(workspaceState, {
        record,
        expectedStatus: null,
        mutation: mutation({
          identity: {
            ...identity,
            activeDomain: payload.domainId,
          },
          requestId,
          payloadFingerprint,
          route: "POST /api/agents",
          operation: "CREATE",
          reason: "Agent draft created.",
          timestamp: now.timestamp,
          resourceKey: key,
        }),
        transaction,
      });
    },

    async configureAgent(input) {
      if (
        !isPlainObject(input)
        || Object.keys(input).sort().join(",")
          !== "agentRef,identity,payload,requestId"
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const ref = validateAgentRef(input.agentRef);
      const payload = validatePayload(input.payload);
      if (
        payload.domainId !== ref.domainId
        || payload.projectId !== ref.projectId
        || payload.id !== ref.agentId
        || (
          identity.role !== "admin"
          && ref.domainId !== identity.activeDomain
        )
      ) {
        fail("NOT_FOUND");
      }
      const key = resourceKey({
        domainId: ref.domainId,
        projectId: ref.projectId,
        id: ref.agentId,
      });
      const payloadFingerprint = fingerprint(payload);
      const replay = await replayCompletedMutation(
        workspaceState,
        {
          identity,
          domainId: ref.domainId,
          projectId: ref.projectId,
          route: "PUT /api/agents/{id}",
          requestId,
          payloadFingerprint,
          resourceKey: key,
          operation: "UPDATE",
          successReason: "Agent configuration completed.",
        },
        ref,
      );
      if (replay !== null) {
        await authorize(
          authorizer,
          identity,
          "agent:update",
          agentRef(ref),
        );
        await validateModelAccess(
          workspaceState,
          authorizer,
          modelSelectionResolver ?? modelAccessResolver,
          identity,
          payload,
          {
            action: "agent:update",
            resourceRef: agentRef(ref),
          },
        );
        return replay;
      }
      await readProject(
        workspaceState,
        ref.domainId,
        ref.projectId,
      );
      const current = await readAgent(workspaceState, ref);
      if (current.status !== "DRAFT") fail("CONFLICT");
      await authorize(
        authorizer,
        identity,
        "agent:update",
        agentRef(ref),
      );
      await validateModelAccess(
        workspaceState,
        authorizer,
        modelSelectionResolver ?? modelAccessResolver,
        identity,
        payload,
        {
          action: "agent:update",
          resourceRef: agentRef(ref),
        },
      );
      await validateGrants(
        workspaceState,
        resourceAccessResolver,
        identity,
        payload,
      );
      const transaction = beginTransaction(workspaceState);
      const now = transaction;
      const record = {
        ...configuredRecord(current, payload, identity, now.timestamp),
        status: "READY_FOR_TEST",
        ...blankEvidence(),
      };
      return persistAgent(workspaceState, {
        record,
        expectedStatus: "DRAFT",
        mutation: mutation({
          identity: {
            ...identity,
            activeDomain: ref.domainId,
          },
          requestId,
          payloadFingerprint,
          route: "PUT /api/agents/{id}",
          operation: "UPDATE",
          reason: "Agent configuration completed.",
          timestamp: now.timestamp,
          resourceKey: key,
        }),
        transaction,
      });
    },

    async testAgent(input) {
      if (
        !isPlainObject(input)
        || Object.keys(input).sort().join(",")
          !== "agentRef,identity,maxTokens,prompt,requestId"
        || !text(input.prompt, 16_384)
        || !Number.isSafeInteger(input.maxTokens)
        || input.maxTokens < 1
        || input.maxTokens > 4096
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const ref = validateAgentRef(input.agentRef);
      if (
        identity.role !== "admin"
        && ref.domainId !== identity.activeDomain
      ) {
        fail("NOT_FOUND");
      }
      const payloadFingerprint = fingerprint({
        agentRef: ref,
        prompt: input.prompt,
        maxTokens: input.maxTokens,
      });
      const key = resourceKey({
        domainId: ref.domainId,
        projectId: ref.projectId,
        id: ref.agentId,
      });
      const replay = await replayCompletedMutation(
        workspaceState,
        {
          identity,
          domainId: ref.domainId,
          projectId: ref.projectId,
          route: "POST /api/agents/{id}/test",
          requestId,
          payloadFingerprint,
          resourceKey: key,
          operation: "UPDATE",
          successReason: "Gateway test succeeded.",
        },
        ref,
        { test: true },
      );
      if (replay !== null) {
        await authorize(
          authorizer,
          identity,
          "agent:test",
          agentRef(ref),
        );
        await validateModelAccess(
          workspaceState,
          authorizer,
          modelAccessResolver,
          identity,
          replay.agent,
          {
            action: "agent:test",
            resourceRef: agentRef(ref),
          },
        );
        if (replay.replayFailure) fail(replay.replayFailure);
        return replay;
      }
      await readProject(
        workspaceState,
        ref.domainId,
        ref.projectId,
      );
      const current = await readAgent(workspaceState, ref);
      if (
        current.status !== "READY_FOR_TEST"
        && current.status !== "TEST_FAILED"
        && current.status !== "TESTED"
      ) {
        fail("CONFLICT");
      }
      await authorize(
        authorizer,
        identity,
        "agent:test",
        agentRef(ref),
      );
      await validateModelAccess(
        workspaceState,
        authorizer,
        modelAccessResolver,
        identity,
        current,
        {
          action: "agent:test",
          resourceRef: agentRef(ref),
        },
      );
      await validateGrants(
        workspaceState,
        resourceAccessResolver,
        identity,
        current,
      );
      await claimSideEffect(workspaceState, {
        actor: identity.actor,
        requesterSubject: identity.actor,
        effectiveRole: identity.role,
        domainId: ref.domainId,
        projectId: ref.projectId,
        route: "POST /api/agents/{id}/test",
        requestId,
        payloadFingerprint,
        resourceKey: key,
        operation: "UPDATE",
      });
      let gatewayResult;
      let gatewayError = null;
      try {
        gatewayResult = await gateway.invoke({
          modelId: current.modelId,
          prompt: input.prompt,
          maxTokens: input.maxTokens,
          sourceIdentity: domainGatewaySourceIdentity(current.domainId),
          ...(current.buildConfig?.instructions ? { systemPrompt: current.buildConfig.instructions } : {}),
          ...(current.buildConfig?.modelParameters?.temperature != null
            ? { temperature: current.buildConfig.modelParameters.temperature } : {}),
        });
        if (!isPlainObject(gatewayResult)
          || typeof gatewayResult.output !== "string"
          || !gatewayResult.output.trim()
          || !Number.isSafeInteger(gatewayResult.usage?.inputTokens)
          || gatewayResult.usage.inputTokens < 0
          || !Number.isSafeInteger(gatewayResult.usage?.outputTokens)
          || gatewayResult.usage.outputTokens <= 0) {
          throw new Error("The model test returned no valid response evidence.");
        }
      } catch (error) {
        gatewayError = error;
      }
      const transaction = beginTransaction(workspaceState);
      const now = transaction;
      const gatewayRequestId =
        typeof gatewayError?.requestId === "string"
        && REQUEST_ID_PATTERN.test(gatewayError.requestId)
          ? gatewayError.requestId
          : requestId;
      const gatewayRejected = gatewayError?.retryable === false;
      const testMutation = {
        identity: {
          ...identity,
          activeDomain: ref.domainId,
        },
        requestId,
        payloadFingerprint,
        route: "POST /api/agents/{id}/test",
        operation: "UPDATE",
        reason: gatewayError
          ? (
            gatewayRejected
              ? "Gateway test was rejected."
              : "Gateway test failed with a retryable error."
          )
          : "Gateway test succeeded.",
        timestamp: now.timestamp,
        resourceKey: resourceKey(current),
      };
      if (gatewayError) {
        const failedEvidence = {
          status: "FAILED",
          modelId: current.modelId,
          inputTokens: 0,
          outputTokens: 0,
          requestId: gatewayRequestId,
          retryable: !gatewayRejected,
        };
        const record = {
          ...current,
          status: "TEST_FAILED",
          updatedAt: now.timestamp,
          lastTestStatus: "FAILED",
          lastTestedAt: now.timestamp,
          lastTestedBySubject: identity.actor,
          lastTestModelId: current.modelId,
          lastTestInputTokens: 0,
          lastTestOutputTokens: 0,
          lastTestRequestId: gatewayRequestId,
          lastTestEvidenceHash: fingerprint(failedEvidence),
          lastTestOutput: null,
        };
        await persistAgent(workspaceState, {
          record,
          expectedStatus: current.status,
          mutation: mutation({
            ...testMutation,
            resourceKey: resourceKey(record),
            decision: "abort",
            status: "FAILED",
          }),
          transaction,
        });
        fail(gatewayRejected ? "GATEWAY_REJECTED" : "GATEWAY_UNAVAILABLE");
      }
      const safeResult = isPlainObject(gatewayResult)
        ? gatewayResult
        : {};
      const usage = isPlainObject(safeResult.usage)
        ? safeResult.usage
        : {};
      const inputTokens = Number.isSafeInteger(usage.inputTokens)
        && usage.inputTokens >= 0
        ? usage.inputTokens
        : 0;
      const outputTokens = Number.isSafeInteger(usage.outputTokens)
        && usage.outputTokens >= 0
        ? usage.outputTokens
        : 0;
      const successfulGatewayRequestId =
        typeof safeResult.requestId === "string"
        && REQUEST_ID_PATTERN.test(safeResult.requestId)
          ? safeResult.requestId
          : requestId;
      const output = typeof safeResult.output === "string"
        ? safeResult.output.slice(0, 65_536)
        : "";
      const evidence = {
        status: "SUCCEEDED",
        modelId: current.modelId,
        inputTokens,
        outputTokens,
        requestId: successfulGatewayRequestId,
        output,
      };
      const record = {
        ...current,
        status: "TESTED",
        updatedAt: now.timestamp,
        lastTestStatus: evidence.status,
        lastTestedAt: now.timestamp,
        lastTestedBySubject: identity.actor,
        lastTestModelId: current.modelId,
        lastTestInputTokens: inputTokens,
        lastTestOutputTokens: outputTokens,
        lastTestRequestId: successfulGatewayRequestId,
        lastTestEvidenceHash: fingerprint(evidence),
        lastTestOutput: output,
      };
      const persisted = await persistAgent(workspaceState, {
        record,
        expectedStatus: current.status,
        mutation: mutation({
          ...testMutation,
          resourceKey: resourceKey(record),
        }),
        transaction,
      });
      return {
        agent: persisted,
        test: {
          output,
          requestId: successfulGatewayRequestId,
          usage: { inputTokens, outputTokens },
        },
      };
    },
  };
}
