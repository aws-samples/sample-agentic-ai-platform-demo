import { projectAllowsAgent } from "../../../../console/public/project-resource-policy.mjs";
import { createHash } from "node:crypto";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/;
const ARN_PATTERN =
  /^arn:[A-Za-z0-9-]+:[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]*:.+$/;
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const AGENT_REF_KEYS = new Set(["domainId", "projectId", "agentId"]);
const DEPLOYMENT_REF_KEYS = new Set([
  "domainId",
  "projectId",
  "deploymentId",
]);
const RUNTIME_KEYS = new Set([
  "runtimeId",
  "runtimeArn",
  "runtimeStatus",
  "endpointName",
  "endpointArn",
  "runtimeVersion",
]);
const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: {
    statusCode: 400,
    message: "The deployment request is invalid.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested deployment action is not allowed.",
    retryable: false,
  },
  REQUESTER_CANNOT_APPROVE: {
    statusCode: 403,
    message: "The requester cannot approve this deployment.",
    retryable: false,
  },
  NOT_FOUND: {
    statusCode: 404,
    message: "Resource not found.",
    retryable: false,
  },
  CONFLICT: {
    statusCode: 409,
    message: "The resource state does not permit this deployment action.",
    retryable: false,
  },
  RUNTIME_UNAVAILABLE: {
    statusCode: 503,
    message: "The governed AgentCore Runtime is not ready.",
    retryable: true,
  },
  WORKSPACE_UNAVAILABLE: {
    statusCode: 503,
    message: "The deployment workspace is temporarily unavailable.",
    retryable: true,
  },
});

export class DeploymentServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) {
      throw new TypeError("Deployment service error code is invalid.");
    }
    super(detail.message);
    this.name = "DeploymentServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.retryable;
  }
}

function fail(code) {
  throw new DeploymentServiceError(code);
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

function validateIdentity(value) {
  if (
    !hasExactKeys(
      value,
      new Set(["actor", "role", "activeDomain", "domainIds"]),
    )
    || !SUBJECT_PATTERN.test(value.actor)
    || !ROLES.has(value.role)
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

function validateSlug(value) {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateAgentRef(value) {
  if (
    !hasExactKeys(value, AGENT_REF_KEYS)
    || !DOMAIN_PATTERN.test(value.domainId)
    || !SLUG_PATTERN.test(value.projectId)
    || !SLUG_PATTERN.test(value.agentId)
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function validateDeploymentRef(value) {
  if (
    !hasExactKeys(value, DEPLOYMENT_REF_KEYS)
    || !DOMAIN_PATTERN.test(value.domainId)
    || !SLUG_PATTERN.test(value.projectId)
    || !SLUG_PATTERN.test(value.deploymentId)
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function validateReason(value) {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 1024
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateRuntime(value) {
  if (
    !hasExactKeys(value, RUNTIME_KEYS)
    || typeof value.runtimeId !== "string"
    || value.runtimeId.length === 0
    || value.runtimeId.length > 256
    || !ARN_PATTERN.test(value.runtimeArn)
    || value.runtimeStatus !== "READY"
    || typeof value.endpointName !== "string"
    || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value.endpointName)
    || !ARN_PATTERN.test(value.endpointArn)
    || typeof value.runtimeVersion !== "string"
    || !/^[1-9][0-9]{0,4}$/.test(value.runtimeVersion)
  ) {
    fail("RUNTIME_UNAVAILABLE");
  }
  return { ...value };
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

function beginTransaction(state) {
  let transaction;
  try {
    transaction = state.beginTransaction();
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  const parsed = typeof transaction?.timestamp === "string"
    ? Date.parse(transaction.timestamp)
    : Number.NaN;
  if (
    !isPlainObject(transaction)
    || Object.keys(transaction).sort().join(",")
      !== "epochSeconds,timestamp"
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== transaction.timestamp
    || !Number.isSafeInteger(transaction.epochSeconds)
    || transaction.epochSeconds !== Math.floor(parsed / 1000)
  ) {
    fail("WORKSPACE_UNAVAILABLE");
  }
  return transaction;
}

function derivedRequestId(requestId, suffix) {
  return `${requestId}.${suffix}`;
}

function mutation({
  identity,
  requesterSubject = identity.actor,
  requestId,
  route,
  entityType,
  resourceKey,
  operation,
  domainId,
  projectId,
  decision,
  reason,
  transaction,
  payload,
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
    timestamp: transaction.timestamp,
    createdAt: transaction.timestamp,
  };
}

function agentResourceKey(ref) {
  return `agent/${ref.domainId}/${ref.projectId}/${ref.agentId}`;
}

function deploymentResourceKey(record) {
  return (
    `deployment/${record.domainId}/${record.projectId}/${record.id}`
  );
}

function approvalResourceKey(record) {
  return `approval/${record.domainId}/${record.id}`;
}

async function readState(state, method, input) {
  try {
    return await state[method](input);
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
}

async function persist(state, method, input) {
  try {
    return await state[method](input);
  } catch (error) {
    if (error instanceof DeploymentServiceError) throw error;
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

async function authorize(authorizer, identity, action, resourceRef, approvalRef) {
  let result;
  try {
    result = await authorizer({
      requestContext: Object.freeze({
        source: "deployment-service",
        subject: identity.actor,
        role: identity.role,
        activeDomain: identity.activeDomain,
        domainIds: Object.freeze([...identity.domainIds]),
      }),
      action,
      resourceRef,
      ...(approvalRef ? { approvalRef } : {}),
    });
  } catch (error) {
    if (error?.decision === "NOT_FOUND") fail("NOT_FOUND");
    if (error?.decision === "CONFLICT") fail("CONFLICT");
    fail("FORBIDDEN");
  }
  if (result !== true && result?.ok !== true) fail("FORBIDDEN");
}

function validateScope(identity, domainId) {
  if (
    identity.role !== "admin"
    && identity.activeDomain !== domainId
  ) {
    fail("NOT_FOUND");
  }
}

async function requireProject(state, ref) {
  const value = await readState(state, "getProject", {
    domainId: ref.domainId,
    projectId: ref.projectId,
  });
  if (value === null) fail("NOT_FOUND");
  if (
    !isPlainObject(value)
    || value.domainId !== ref.domainId
    || value.id !== ref.projectId
    || value.status !== "ACTIVE"
  ) {
    fail("CONFLICT");
  }
  return value;
}

async function requireAgent(state, ref) {
  const value = await readState(state, "getAgent", {
    domainId: ref.domainId,
    projectId: ref.projectId,
    agentId: ref.agentId,
  });
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

async function requireModelAccess(workspaceState, modelAccessResolver, agentRecord) {
  const project = await requireProject(workspaceState, agentRecord);
  if (!projectAllowsAgent(project, agentRecord)) fail("CONFLICT");
  let allowed;
  try {
    allowed = await modelAccessResolver({
      domainId: agentRecord.domainId,
      modelId: agentRecord.modelId,
    });
  } catch {
    fail("WORKSPACE_UNAVAILABLE");
  }
  if (allowed !== true) fail("CONFLICT");
}

function emptyRuntimeIdentity() {
  return {
    runtimeId: null,
    runtimeArn: null,
    runtimeStatus: null,
    endpointName: null,
    endpointArn: null,
    runtimeVersion: null,
  };
}

async function resolveRuntime(runtimeControl, environment) {
  try {
    return validateRuntime(
      await runtimeControl.resolveEndpoint(environment),
    );
  } catch (error) {
    if (error instanceof DeploymentServiceError) throw error;
    fail("RUNTIME_UNAVAILABLE");
  }
}

function assertDeploymentIdentity(record, {
  ref,
  deploymentId,
  environment,
  requesterSubject,
}) {
  if (
    !isPlainObject(record)
    || record.domainId !== ref.domainId
    || record.projectId !== ref.projectId
    || record.id !== deploymentId
    || record.agentId !== ref.agentId
    || record.environment !== environment
    || record.requesterSubject !== requesterSubject
  ) {
    fail("CONFLICT");
  }
  return record;
}

function assertApprovalIdentity(record, {
  ref,
  approvalId,
  deploymentId,
  requesterSubject,
}) {
  if (
    !isPlainObject(record)
    || record.domainId !== ref.domainId
    || record.id !== approvalId
    || record.kind !== "PRODUCTION_DEPLOYMENT"
    || record.resourceType !== "DEPLOYMENT"
    || record.resourceId !== deploymentId
    || record.projectId !== ref.projectId
    || record.requesterSubject !== requesterSubject
  ) {
    fail("CONFLICT");
  }
  return record;
}

async function writeDeployment(state, {
  identity,
  requesterSubject,
  requestId,
  route,
  record,
  expectedStatus,
  decision,
  reason,
  payload,
}) {
  const transaction = beginTransaction(state);
  const timestamped = {
    ...record,
    ...(expectedStatus === "REQUESTED"
      ? { decidedAt: transaction.timestamp }
      : {}),
    updatedAt: transaction.timestamp,
  };
  return persist(state, "putDeployment", {
    record: timestamped,
    expectedStatus,
    mutation: mutation({
      identity,
      requesterSubject,
      requestId,
      route,
      entityType: "DEPLOYMENT",
      resourceKey: deploymentResourceKey(timestamped),
      operation: expectedStatus === null ? "CREATE" : "UPDATE",
      domainId: timestamped.domainId,
      projectId: timestamped.projectId,
      decision,
      reason,
      transaction,
      payload,
    }),
    transaction,
  });
}

async function writeApproval(state, {
  identity,
  requesterSubject,
  requestId,
  route,
  record,
  expectedStatus,
  decision,
  reason,
  payload,
}) {
  const transaction = beginTransaction(state);
  const timestamped = {
    ...record,
    ...(record.status === "PENDING"
      ? { requestedAt: transaction.timestamp }
      : { decidedAt: transaction.timestamp }),
  };
  return persist(state, "putApproval", {
    record: timestamped,
    expectedStatus,
    mutation: mutation({
      identity,
      requesterSubject,
      requestId,
      route,
      entityType: "APPROVAL",
      resourceKey: approvalResourceKey(timestamped),
      operation: expectedStatus === null ? "CREATE" : "UPDATE",
      domainId: timestamped.domainId,
      projectId: timestamped.projectId,
      decision,
      reason,
      transaction,
      payload,
    }),
    transaction,
  });
}

async function writeAgent(state, {
  identity,
  requestId,
  route,
  record,
  expectedStatus,
  payload,
}) {
  const transaction = beginTransaction(state);
  const timestamped = {
    ...record,
    updatedAt: transaction.timestamp,
  };
  return persist(state, "putAgent", {
    record: timestamped,
    expectedStatus,
    mutation: mutation({
      identity,
      requestId,
      route,
      entityType: "AGENT",
      resourceKey: agentResourceKey({
        domainId: timestamped.domainId,
        projectId: timestamped.projectId,
        agentId: timestamped.id,
      }),
      operation: "UPDATE",
      domainId: timestamped.domainId,
      projectId: timestamped.projectId,
      decision: "update",
      reason: `Agent lifecycle advanced to ${timestamped.status}.`,
      transaction,
      payload,
    }),
    transaction,
  });
}

export function createDeploymentService({
  workspaceState,
  authorizer,
  runtimeControl,
  modelAccessResolver,
} = {}) {
  if (
    !workspaceState
    || ![
      "beginTransaction",
      "getProject",
      "getAgent",
      "getDeployment",
      "getApproval",
      "putAgent",
      "putDeployment",
      "putApproval",
    ].every((method) => typeof workspaceState[method] === "function")
    || typeof authorizer !== "function"
    || !runtimeControl
    || typeof runtimeControl.resolveEndpoint !== "function"
    || typeof modelAccessResolver !== "function"
  ) {
    throw new TypeError("Deployment service configuration is invalid.");
  }

  return {
    async deploySandbox(input) {
      if (
        !hasExactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "deploymentId",
            "agentRef",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const deploymentId = validateSlug(input.deploymentId);
      const ref = validateAgentRef(input.agentRef);
      validateScope(identity, ref.domainId);
      await requireProject(workspaceState, ref);
      let currentAgent = await requireAgent(workspaceState, ref);
      if (
        currentAgent.status !== "TESTED"
        && currentAgent.status !== "SANDBOX_DEPLOYED"
      ) {
        fail("CONFLICT");
      }
      await requireModelAccess(workspaceState, modelAccessResolver, currentAgent);
      await authorize(
        authorizer,
        identity,
        "agent:sandbox-deploy",
        `agent:${ref.domainId}/${ref.projectId}/${ref.agentId}`,
      );

      let currentDeployment = await readState(
        workspaceState,
        "getDeployment",
        {
          domainId: ref.domainId,
          projectId: ref.projectId,
          deploymentId,
        },
      );
      if (currentDeployment === null) {
        const transaction = beginTransaction(workspaceState);
        currentDeployment = await persist(
          workspaceState,
          "putDeployment",
          {
            record: {
              domainId: ref.domainId,
              projectId: ref.projectId,
              id: deploymentId,
              agentId: ref.agentId,
              environment: "SANDBOX",
              status: "DEPLOYING",
              requesterSubject: identity.actor,
              approverSubject: null,
              decisionReason: null,
              requestedAt: transaction.timestamp,
              decidedAt: null,
              ...emptyRuntimeIdentity(),
              updatedAt: transaction.timestamp,
            },
            expectedStatus: null,
            mutation: mutation({
              identity,
              requestId: derivedRequestId(requestId, "sandbox-start"),
              route: "POST /api/deployments/sandbox",
              entityType: "DEPLOYMENT",
              resourceKey:
                `deployment/${ref.domainId}/${ref.projectId}/${deploymentId}`,
              operation: "CREATE",
              domainId: ref.domainId,
              projectId: ref.projectId,
              decision: "create",
              reason: "Sandbox deployment started.",
              transaction,
              payload: input,
            }),
            transaction,
          },
        );
      }
      assertDeploymentIdentity(currentDeployment, {
        ref,
        deploymentId,
        environment: "SANDBOX",
        requesterSubject: identity.actor,
      });
      if (
        currentDeployment.status !== "DEPLOYING"
        && currentDeployment.status !== "DEPLOYED"
      ) {
        fail("CONFLICT");
      }

      if (currentDeployment.status === "DEPLOYING") {
        const runtime = await resolveRuntime(runtimeControl, "SANDBOX");
        currentDeployment = await writeDeployment(workspaceState, {
          identity,
          requesterSubject: identity.actor,
          requestId: derivedRequestId(requestId, "sandbox-ready"),
          route: "POST /api/deployments/sandbox",
          record: {
            ...currentDeployment,
            status: "DEPLOYED",
            ...runtime,
          },
          expectedStatus: "DEPLOYING",
          decision: "update",
          reason: "Sandbox deployment reached the governed Runtime endpoint.",
          payload: { ...input, runtime },
        });
      }

      if (currentAgent.status === "TESTED") {
        currentAgent = await writeAgent(workspaceState, {
          identity,
          requestId: derivedRequestId(requestId, "sandbox-agent"),
          route: "POST /api/deployments/sandbox",
          record: {
            ...currentAgent,
            status: "SANDBOX_DEPLOYED",
          },
          expectedStatus: "TESTED",
          payload: input,
        });
      }
      return {
        deployment: currentDeployment,
        agent: currentAgent,
      };
    },

    async submitProduction(input) {
      if (
        !hasExactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "deploymentId",
            "approvalId",
            "agentRef",
          ]),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const requestId = validateRequestId(input.requestId);
      const deploymentId = validateSlug(input.deploymentId);
      const approvalId = validateSlug(input.approvalId);
      const ref = validateAgentRef(input.agentRef);
      validateScope(identity, ref.domainId);
      await requireProject(workspaceState, ref);
      let currentAgent = await requireAgent(workspaceState, ref);
      if (
        !new Set([
          "TESTED",
          "SANDBOX_DEPLOYED",
          "PRODUCTION_PENDING",
        ]).has(currentAgent.status)
      ) {
        fail("CONFLICT");
      }
      await requireModelAccess(workspaceState, modelAccessResolver, currentAgent);
      await authorize(
        authorizer,
        identity,
        "agent:production-submit",
        `agent:${ref.domainId}/${ref.projectId}/${ref.agentId}`,
      );

      let currentDeployment = await readState(
        workspaceState,
        "getDeployment",
        {
          domainId: ref.domainId,
          projectId: ref.projectId,
          deploymentId,
        },
      );
      if (currentDeployment === null) {
        const transaction = beginTransaction(workspaceState);
        currentDeployment = await persist(
          workspaceState,
          "putDeployment",
          {
            record: {
              domainId: ref.domainId,
              projectId: ref.projectId,
              id: deploymentId,
              agentId: ref.agentId,
              environment: "PRODUCTION",
              status: "REQUESTED",
              requesterSubject: identity.actor,
              approverSubject: null,
              decisionReason: null,
              requestedAt: transaction.timestamp,
              decidedAt: null,
              ...emptyRuntimeIdentity(),
              updatedAt: transaction.timestamp,
            },
            expectedStatus: null,
            mutation: mutation({
              identity,
              requestId: derivedRequestId(requestId, "production-request"),
              route: "POST /api/deployments/production",
              entityType: "DEPLOYMENT",
              resourceKey:
                `deployment/${ref.domainId}/${ref.projectId}/${deploymentId}`,
              operation: "CREATE",
              domainId: ref.domainId,
              projectId: ref.projectId,
              decision: "create",
              reason: "Production deployment requested.",
              transaction,
              payload: input,
            }),
            transaction,
          },
        );
      }
      assertDeploymentIdentity(currentDeployment, {
        ref,
        deploymentId,
        environment: "PRODUCTION",
        requesterSubject: identity.actor,
      });

      let currentApproval = await readState(
        workspaceState,
        "getApproval",
        {
          domainId: ref.domainId,
          approvalId,
        },
      );
      if (currentApproval === null) {
        const transaction = beginTransaction(workspaceState);
        currentApproval = await persist(workspaceState, "putApproval", {
          record: {
            domainId: ref.domainId,
            id: approvalId,
            kind: "PRODUCTION_DEPLOYMENT",
            resourceType: "DEPLOYMENT",
            resourceId: deploymentId,
            projectId: ref.projectId,
            status: "PENDING",
            requesterSubject: identity.actor,
            approverSubject: null,
            reason: null,
            requestedAt: transaction.timestamp,
            decidedAt: null,
          },
          expectedStatus: null,
          mutation: mutation({
            identity,
            requestId: derivedRequestId(requestId, "production-approval"),
            route: "POST /api/deployments/production",
            entityType: "APPROVAL",
            resourceKey: `approval/${ref.domainId}/${approvalId}`,
            operation: "CREATE",
            domainId: ref.domainId,
            projectId: ref.projectId,
            decision: "create",
            reason: "Domain approval requested.",
            transaction,
            payload: input,
          }),
          transaction,
        });
      }
      assertApprovalIdentity(currentApproval, {
        ref,
        approvalId,
        deploymentId,
        requesterSubject: identity.actor,
      });
      if (
        !new Set([
          "PENDING",
          "APPROVED",
          "REJECTED",
        ]).has(currentApproval.status)
      ) {
        fail("CONFLICT");
      }

      if (
        currentAgent.status === "TESTED"
        || currentAgent.status === "SANDBOX_DEPLOYED"
      ) {
        currentAgent = await writeAgent(workspaceState, {
          identity,
          requestId: derivedRequestId(requestId, "production-agent"),
          route: "POST /api/deployments/production",
          record: {
            ...currentAgent,
            status: "PRODUCTION_PENDING",
          },
          expectedStatus: currentAgent.status,
          payload: input,
        });
      }
      return {
        deployment: currentDeployment,
        approval: currentApproval,
        agent: currentAgent,
      };
    },

    async decideProduction(input) {
      if (
        !hasExactKeys(
          input,
          new Set([
            "identity",
            "requestId",
            "deploymentRef",
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
      const ref = validateDeploymentRef(input.deploymentRef);
      const approvalId = validateSlug(input.approvalId);
      const reason = validateReason(input.reason);
      if (!new Set(["APPROVE", "REJECT"]).has(input.decision)) {
        fail("INVALID_REQUEST");
      }
      validateScope(identity, ref.domainId);
      const currentDeployment = await readState(
        workspaceState,
        "getDeployment",
        {
          domainId: ref.domainId,
          projectId: ref.projectId,
          deploymentId: ref.deploymentId,
        },
      );
      if (currentDeployment === null) fail("NOT_FOUND");
      const currentApproval = await readState(
        workspaceState,
        "getApproval",
        {
          domainId: ref.domainId,
          approvalId,
        },
      );
      if (currentApproval === null) fail("NOT_FOUND");
      const agentRef = {
        domainId: ref.domainId,
        projectId: ref.projectId,
        agentId: currentDeployment.agentId,
      };
      assertDeploymentIdentity(currentDeployment, {
        ref: agentRef,
        deploymentId: ref.deploymentId,
        environment: "PRODUCTION",
        requesterSubject: currentDeployment.requesterSubject,
      });
      assertApprovalIdentity(currentApproval, {
        ref: agentRef,
        approvalId,
        deploymentId: ref.deploymentId,
        requesterSubject: currentDeployment.requesterSubject,
      });
      if (identity.actor === currentDeployment.requesterSubject) {
        fail("REQUESTER_CANNOT_APPROVE");
      }
      await authorize(
        authorizer,
        identity,
        "deployment:approve",
        `deployment:${ref.domainId}/${ref.projectId}/${ref.deploymentId}`,
        `approval:${ref.domainId}/${approvalId}`,
      );
      let agentRecord = await requireAgent(workspaceState, agentRef);
      let approvalRecord = currentApproval;
      let deploymentRecord = currentDeployment;

      if (input.decision === "REJECT") {
        if (approvalRecord.status === "PENDING") {
          approvalRecord = await writeApproval(workspaceState, {
            identity,
            requesterSubject: approvalRecord.requesterSubject,
            requestId: derivedRequestId(requestId, "approval-reject"),
            route: "POST /api/deployment-decisions",
            record: {
              ...approvalRecord,
              status: "REJECTED",
              approverSubject: identity.actor,
              reason,
            },
            expectedStatus: "PENDING",
            decision: "reject",
            reason,
            payload: input,
          });
        } else if (
          approvalRecord.status !== "REJECTED"
          || approvalRecord.approverSubject !== identity.actor
          || approvalRecord.reason !== reason
        ) {
          fail("CONFLICT");
        }
        if (deploymentRecord.status === "REQUESTED") {
          deploymentRecord = await writeDeployment(workspaceState, {
            identity,
            requesterSubject: deploymentRecord.requesterSubject,
            requestId: derivedRequestId(requestId, "deployment-reject"),
            route: "POST /api/deployment-decisions",
            record: {
              ...deploymentRecord,
              status: "REJECTED",
              approverSubject: identity.actor,
              decisionReason: reason,
              decidedAt: approvalRecord.decidedAt,
            },
            expectedStatus: "REQUESTED",
            decision: "reject",
            reason,
            payload: input,
          });
        } else if (
          deploymentRecord.status !== "REJECTED"
          || deploymentRecord.approverSubject !== identity.actor
          || deploymentRecord.decisionReason !== reason
        ) {
          fail("CONFLICT");
        }
        if (agentRecord.status === "PRODUCTION_PENDING") {
          agentRecord = await writeAgent(workspaceState, {
            identity,
            requestId: derivedRequestId(requestId, "agent-reject"),
            route: "POST /api/deployment-decisions",
            record: { ...agentRecord, status: "REJECTED" },
            expectedStatus: "PRODUCTION_PENDING",
            payload: input,
          });
        } else if (agentRecord.status !== "REJECTED") {
          fail("CONFLICT");
        }
        return {
          deployment: deploymentRecord,
          approval: approvalRecord,
          agent: agentRecord,
        };
      }

      await requireModelAccess(workspaceState, modelAccessResolver, agentRecord);
      if (approvalRecord.status === "PENDING") {
        approvalRecord = await writeApproval(workspaceState, {
          identity,
          requesterSubject: approvalRecord.requesterSubject,
          requestId: derivedRequestId(requestId, "approval-approve"),
          route: "POST /api/deployment-decisions",
          record: {
            ...approvalRecord,
            status: "APPROVED",
            approverSubject: identity.actor,
            reason,
          },
          expectedStatus: "PENDING",
          decision: "approve",
          reason,
          payload: input,
        });
      } else if (
        approvalRecord.status !== "APPROVED"
        || approvalRecord.approverSubject !== identity.actor
        || approvalRecord.reason !== reason
      ) {
        fail("CONFLICT");
      }
      if (deploymentRecord.status === "REQUESTED") {
        deploymentRecord = await writeDeployment(workspaceState, {
          identity,
          requesterSubject: deploymentRecord.requesterSubject,
          requestId: derivedRequestId(requestId, "deployment-approve"),
          route: "POST /api/deployment-decisions",
          record: {
            ...deploymentRecord,
            status: "APPROVED",
            approverSubject: identity.actor,
            decisionReason: reason,
            decidedAt: approvalRecord.decidedAt,
          },
          expectedStatus: "REQUESTED",
          decision: "approve",
          reason,
          payload: input,
        });
      }
      if (deploymentRecord.status === "APPROVED") {
        deploymentRecord = await writeDeployment(workspaceState, {
          identity,
          requesterSubject: deploymentRecord.requesterSubject,
          requestId: derivedRequestId(requestId, "production-start"),
          route: "POST /api/deployment-decisions",
          record: {
            ...deploymentRecord,
            status: "DEPLOYING",
          },
          expectedStatus: "APPROVED",
          decision: "update",
          reason: "Approved production deployment started.",
          payload: input,
        });
      }
      if (deploymentRecord.status === "DEPLOYING") {
        const runtime = await resolveRuntime(runtimeControl, "PRODUCTION");
        deploymentRecord = await writeDeployment(workspaceState, {
          identity,
          requesterSubject: deploymentRecord.requesterSubject,
          requestId: derivedRequestId(requestId, "production-ready"),
          route: "POST /api/deployment-decisions",
          record: {
            ...deploymentRecord,
            status: "DEPLOYED",
            ...runtime,
          },
          expectedStatus: "DEPLOYING",
          decision: "update",
          reason: "Production reached the governed Runtime endpoint.",
          payload: { ...input, runtime },
        });
      } else if (deploymentRecord.status !== "DEPLOYED") {
        fail("CONFLICT");
      }
      if (agentRecord.status === "PRODUCTION_PENDING") {
        agentRecord = await writeAgent(workspaceState, {
          identity,
          requestId: derivedRequestId(requestId, "agent-approved"),
          route: "POST /api/deployment-decisions",
          record: { ...agentRecord, status: "PRODUCTION_APPROVED" },
          expectedStatus: "PRODUCTION_PENDING",
          payload: input,
        });
      }
      if (agentRecord.status === "PRODUCTION_APPROVED") {
        agentRecord = await writeAgent(workspaceState, {
          identity,
          requestId: derivedRequestId(requestId, "agent-deployed"),
          route: "POST /api/deployment-decisions",
          record: { ...agentRecord, status: "PRODUCTION_DEPLOYED" },
          expectedStatus: "PRODUCTION_APPROVED",
          payload: input,
        });
      } else if (agentRecord.status !== "PRODUCTION_DEPLOYED") {
        fail("CONFLICT");
      }
      return {
        deployment: deploymentRecord,
        approval: approvalRecord,
        agent: agentRecord,
      };
    },
  };
}
