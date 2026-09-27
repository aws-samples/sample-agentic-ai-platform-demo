import { handleHitlCatalogSeed } from "./hitl-seed.mjs";
import { isDeepStrictEqual } from "node:util";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  sendCloudFormationResponse,
} from "../platform-admin/seed.mjs";
import {
  createWorkspaceState,
  validateAgentRecord,
  validateProjectRecord,
} from "./state.mjs";

const RESOURCE_PROPERTY_KEYS = new Set([
  "ServiceToken",
  "ServiceTimeout",
  "TableName",
  "Project",
  "Agent",
]);
const PROJECT_PROPERTY_KEYS = new Set([
  "domainId",
  "id",
  "name",
  "description",
  "ownerSubject",
  "memberSubjects",
  "status",
  "createdBySubject",
]);
const AGENT_PROPERTY_KEYS = new Set([
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
const NULLABLE_AGENT_PROPERTY_DEFAULTS = Object.freeze({
  buildConfig: null,
  lastTestStatus: null,
  lastTestedAt: null,
  lastTestedBySubject: null,
  lastTestModelId: null,
  lastTestInputTokens: null,
  lastTestOutputTokens: null,
  lastTestRequestId: null,
  lastTestEvidenceHash: null,
  lastTestOutput: null,
});
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
// Fixed allowlist: the seed only ever writes these exact demo identities.
const BASELINE_PROJECT_LIST = Object.freeze([
  Object.freeze({ domainId: "platform", id: "it-helpdesk" }),
  Object.freeze({ domainId: "customer_support", id: "case-assist" }),
  Object.freeze({ domainId: "customer_support", id: "concierge" }),
  Object.freeze({ domainId: "customer_support", id: "supportdesk" }),
  Object.freeze({ domainId: "operations", id: "incident-triage" }),
  Object.freeze({ domainId: "operations", id: "report-runner" }),
]);
const BASELINE_AGENT_LIST = Object.freeze([
  Object.freeze({
    domainId: "platform",
    projectId: "it-helpdesk",
    id: "it-helpdesk-agent",
  }),
  Object.freeze({
    domainId: "customer_support",
    projectId: "case-assist",
    id: "case-resolution-agent",
  }),
  Object.freeze({
    domainId: "customer_support",
    projectId: "concierge",
    id: "customer-concierge-agent",
  }),
  Object.freeze({
    domainId: "customer_support",
    projectId: "supportdesk",
    id: "support-desk-agent",
  }),
  Object.freeze({
    domainId: "operations",
    projectId: "incident-triage",
    id: "incident-triage-agent",
  }),
  Object.freeze({
    domainId: "operations",
    projectId: "report-runner",
    id: "operations-report-agent",
  }),
]);
const BASELINE_PROJECT = Object.freeze({
  ownerSubject: "deployment:baseline",
  status: "ACTIVE",
  createdBySubject: "deployment:baseline",
});
const baselineIdentity = (project) =>
  BASELINE_PROJECT_LIST.find(
    (entry) =>
      entry.domainId === project.domainId && entry.id === project.id,
  );
const baselineAgentIdentity = (agent) =>
  BASELINE_AGENT_LIST.find(
    (entry) =>
      entry.domainId === agent.domainId
      && entry.projectId === agent.projectId
      && entry.id === agent.id,
  );
const DEFAULT_ACCESS_RETRY_ATTEMPTS = 12;
const DEFAULT_ACCESS_RETRY_DELAY_MS = 5_000;
const DEFAULT_RESPONSE_ATTEMPTS = 3;
const DEFAULT_RESPONSE_RETRY_DELAY_MS = 250;
const DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_SAFETY_MARGIN_MS = 1_000;
const OPERATION_FAILED_REASON =
  "Baseline platform project seed operation failed.";
const RESPONSE_FAILED_REASON =
  "Baseline platform project seed response delivery failed.";

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

function fail(code, message) {
  const error = new Error(message);
  error.name = code === "INVALID_BASELINE_PROJECT"
    ? "BaselineProjectValidationError"
    : "BaselineProjectConflictError";
  error.code = code;
  throw error;
}

function invalidProject() {
  fail(
    "INVALID_BASELINE_PROJECT",
    "Baseline platform project seed properties are malformed.",
  );
}

function physicalResourceId(tableName, project) {
  return `platform-baseline-project:${tableName}:`
    + `${project.domainId}:${project.id}`;
}

function validateProperties(properties, generatedAt) {
  if (
    !isPlainObject(properties)
    || Object.keys(properties).some(
      (key) => !RESOURCE_PROPERTY_KEYS.has(key),
    )
    || typeof properties.TableName !== "string"
    || !TABLE_NAME_PATTERN.test(properties.TableName)
    || !isPlainObject(properties.Project)
    || Object.keys(properties.Project).length !== PROJECT_PROPERTY_KEYS.size
    || Object.keys(properties.Project).some(
      (key) => !PROJECT_PROPERTY_KEYS.has(key),
    )
  ) {
    invalidProject();
  }
  let project;
  let agent = null;
  try {
    project = validateProjectRecord({
      ...properties.Project,
      createdAt: generatedAt,
    });
    if (properties.Agent !== undefined) {
      if (
        !isPlainObject(properties.Agent)
        || Object.keys(properties.Agent).some(
          (key) => !AGENT_PROPERTY_KEYS.has(key),
        )
      ) {
        invalidProject();
      }
      agent = validateAgentRecord({
        ...NULLABLE_AGENT_PROPERTY_DEFAULTS,
        ...properties.Agent,
        createdAt: generatedAt,
        updatedAt: generatedAt,
      });
    }
  } catch {
    invalidProject();
  }
  if (
    !baselineIdentity(project)
    || project.ownerSubject !== BASELINE_PROJECT.ownerSubject
    || project.createdBySubject !== BASELINE_PROJECT.createdBySubject
    || project.status !== BASELINE_PROJECT.status
    || project.memberSubjects.length !== 0
  ) {
    invalidProject();
  }
  if (agent !== null) {
    const identity = baselineAgentIdentity(agent);
    if (
      !identity
      || agent.domainId !== project.domainId
      || agent.projectId !== project.id
      || agent.ownerSubject !== BASELINE_PROJECT.ownerSubject
      || agent.createdBySubject !== BASELINE_PROJECT.createdBySubject
      || agent.status !== "DRAFT"
      || agent.buildConfig !== null
      || agent.toolIds.length !== 0
      || agent.mcpServerIds.length !== 0
      || agent.skillIds.length !== 0
      || agent.blueprintIds.length !== 0
    ) {
      invalidProject();
    }
  }
  return {
    tableName: properties.TableName,
    project,
    agent,
  };
}

function verifyExistingProject(existing) {
  if (
    !baselineIdentity(existing)
    || existing.ownerSubject !== BASELINE_PROJECT.ownerSubject
    || existing.createdBySubject !== BASELINE_PROJECT.createdBySubject
    || existing.status !== BASELINE_PROJECT.status
  ) {
    fail(
      "BASELINE_PROJECT_CONFLICT",
      "Existing platform starter project identity conflicts with deployment.",
    );
  }
}

function verifyExistingAgent(existing) {
  if (
    !baselineAgentIdentity(existing)
    || existing.ownerSubject !== BASELINE_PROJECT.ownerSubject
    || existing.createdBySubject !== BASELINE_PROJECT.createdBySubject
  ) {
    fail(
      "BASELINE_PROJECT_CONFLICT",
      "Existing starter agent identity conflicts with deployment.",
    );
  }
}

function stringAttribute(value) {
  return { S: value };
}

function projectItem(project) {
  return {
    pk: stringAttribute(`PROJECT#${project.domainId}`),
    sk: stringAttribute(`PROJECT#${project.id}`),
    entityType: stringAttribute("PROJECT"),
    domainId: stringAttribute(project.domainId),
    id: stringAttribute(project.id),
    name: stringAttribute(project.name),
    description: stringAttribute(project.description),
    ownerSubject: stringAttribute(project.ownerSubject),
    memberSubjects: {
      L: project.memberSubjects.map(stringAttribute),
    },
    status: stringAttribute(project.status),
    createdBySubject: stringAttribute(project.createdBySubject),
    createdAt: stringAttribute(project.createdAt),
  };
}

function nullableAttribute(value) {
  return value === null ? { NULL: true } : stringAttribute(value);
}

function nullableIntegerAttribute(value) {
  return value === null ? { NULL: true } : { N: String(value) };
}

function stringListAttribute(values) {
  return { L: values.map(stringAttribute) };
}

function agentItem(agent) {
  return {
    pk: stringAttribute(`AGENT#${agent.domainId}#${agent.projectId}`),
    sk: stringAttribute(`AGENT#${agent.id}`),
    entityType: stringAttribute("AGENT"),
    domainId: stringAttribute(agent.domainId),
    projectId: stringAttribute(agent.projectId),
    id: stringAttribute(agent.id),
    name: stringAttribute(agent.name),
    description: stringAttribute(agent.description),
    ownerSubject: stringAttribute(agent.ownerSubject),
    modelId: stringAttribute(agent.modelId),
    toolIds: stringListAttribute(agent.toolIds),
    mcpServerIds: stringListAttribute(agent.mcpServerIds),
    skillIds: stringListAttribute(agent.skillIds),
    blueprintIds: stringListAttribute(agent.blueprintIds),
    memoryIds: stringListAttribute(agent.memoryIds),
    knowledgeBaseIds: stringListAttribute(agent.knowledgeBaseIds),
    buildConfig: { NULL: true },
    status: stringAttribute(agent.status),
    createdBySubject: stringAttribute(agent.createdBySubject),
    createdAt: stringAttribute(agent.createdAt),
    updatedAt: stringAttribute(agent.updatedAt),
    lastTestStatus: nullableAttribute(agent.lastTestStatus),
    lastTestedAt: nullableAttribute(agent.lastTestedAt),
    lastTestedBySubject: nullableAttribute(agent.lastTestedBySubject),
    lastTestModelId: nullableAttribute(agent.lastTestModelId),
    lastTestInputTokens:
      nullableIntegerAttribute(agent.lastTestInputTokens),
    lastTestOutputTokens:
      nullableIntegerAttribute(agent.lastTestOutputTokens),
    lastTestRequestId: nullableAttribute(agent.lastTestRequestId),
    lastTestEvidenceHash: nullableAttribute(agent.lastTestEvidenceHash),
    lastTestOutput: nullableAttribute(agent.lastTestOutput),
  };
}

function operationDeadlineExceeded() {
  const error = new Error(OPERATION_FAILED_REASON);
  error.name = "BaselineProjectOperationDeadlineError";
  error.code = "OPERATION_DEADLINE_EXCEEDED";
  return error;
}

function invalidRuntimeBudget() {
  const error = new Error(OPERATION_FAILED_REASON);
  error.name = "BaselineProjectRuntimeBudgetError";
  error.code = "INVALID_RUNTIME_BUDGET";
  return error;
}

function createExecutionBudget(
  context,
  {
    clearTimer,
    clock,
    setTimer,
  },
) {
  let startedAtMs;
  let remainingTimeMs;
  try {
    startedAtMs = clock();
    remainingTimeMs = context?.getRemainingTimeInMillis?.();
  } catch {
    throw invalidRuntimeBudget();
  }
  const absoluteDeadlineMs = startedAtMs + remainingTimeMs;
  if (
    typeof clock !== "function"
    || typeof clearTimer !== "function"
    || typeof setTimer !== "function"
    || typeof context?.getRemainingTimeInMillis !== "function"
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(remainingTimeMs)
    || remainingTimeMs
      < DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS
        + DEFAULT_DEADLINE_SAFETY_MARGIN_MS
    || !Number.isFinite(absoluteDeadlineMs)
  ) {
    throw invalidRuntimeBudget();
  }
  const terminalDeadlineMs =
    absoluteDeadlineMs - DEFAULT_DEADLINE_SAFETY_MARGIN_MS;
  const operationDeadlineMs =
    terminalDeadlineMs - DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS;

  function currentTimeMs() {
    let value;
    try {
      value = clock();
    } catch {
      throw invalidRuntimeBudget();
    }
    if (!Number.isFinite(value)) throw invalidRuntimeBudget();
    return value;
  }

  return {
    canUseOperationTime(delayMs = 0) {
      return currentTimeMs() + delayMs < operationDeadlineMs;
    },
    canStartResponse(terminal, delayMs = 0) {
      const responseDeadlineMs = terminal
        ? terminalDeadlineMs
        : operationDeadlineMs;
      return currentTimeMs()
        + delayMs
        + DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS
        <= responseDeadlineMs;
    },
    startOperationAttempt() {
      const remainingTimeMs = operationDeadlineMs - currentTimeMs();
      if (remainingTimeMs <= 0) throw operationDeadlineExceeded();
      const controller = new AbortController();
      let timer;
      try {
        timer = setTimer(
          () => controller.abort(),
          remainingTimeMs,
        );
      } catch {
        throw invalidRuntimeBudget();
      }
      return {
        signal: controller.signal,
        clear() {
          try {
            clearTimer(timer);
          } catch {
            // Timer cleanup cannot replace the controlled operation result.
          }
        },
      };
    },
  };
}

function accessRetryingDynamo(
  dynamo,
  {
    attempts,
    canUseOperationTime = () => true,
    delayMs,
    sleep,
    startOperationAttempt,
  },
) {
  return {
    async send(command) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!canUseOperationTime()) throw operationDeadlineExceeded();
        const operationAttempt = startOperationAttempt?.();
        let error;
        try {
          return await dynamo.send(
            command,
            operationAttempt
              ? { abortSignal: operationAttempt.signal }
              : undefined,
          );
        } catch (caught) {
          error = caught;
        } finally {
          operationAttempt?.clear();
        }
        if (operationAttempt?.signal.aborted) {
          throw operationDeadlineExceeded();
        }
        const accessDenied = error?.name === "AccessDeniedException"
          || error?.code === "AccessDeniedException";
        if (!accessDenied || attempt + 1 >= attempts) throw error;
        if (!canUseOperationTime(delayMs)) {
          throw operationDeadlineExceeded();
        }
        await sleep(delayMs);
      }
      throw new Error("DynamoDB retry attempts were exhausted.");
    },
  };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function reconcileBaselineProject(
  event,
  {
    accessRetryAttempts = DEFAULT_ACCESS_RETRY_ATTEMPTS,
    accessRetryDelayMs = DEFAULT_ACCESS_RETRY_DELAY_MS,
    canUseOperationTime,
    dynamo,
    now = () => new Date().toISOString(),
    sleep = defaultSleep,
    startOperationAttempt,
  },
) {
  if (!isPlainObject(event)) invalidProject();
  if (event.RequestType === "Delete") {
    return {
      PhysicalResourceId:
        typeof event.PhysicalResourceId === "string"
        && event.PhysicalResourceId.length > 0
          ? event.PhysicalResourceId
          : "platform-baseline-project:retained",
    };
  }
  if (event.RequestType !== "Create" && event.RequestType !== "Update") {
    invalidProject();
  }
  if (
    event.RequestType === "Create"
    && event.PhysicalResourceId !== undefined
  ) {
    invalidProject();
  }
  const generatedAt = now();
  let oldSeed = null;
  if (event.RequestType === "Update") {
    oldSeed = validateProperties(
      event.OldResourceProperties,
      generatedAt,
    );
    if (
      typeof event.PhysicalResourceId !== "string"
      || event.PhysicalResourceId
        !== physicalResourceId(oldSeed.tableName, oldSeed.project)
    ) {
      invalidProject();
    }
  }
  const { tableName, project, agent } = validateProperties(
    event.ResourceProperties,
    generatedAt,
  );
  const client = accessRetryingDynamo(dynamo, {
    attempts: accessRetryAttempts,
    canUseOperationTime,
    delayMs: accessRetryDelayMs,
    sleep,
    startOperationAttempt,
  });
  const state = createWorkspaceState({
    tableName,
    dynamo: client,
    now: () => generatedAt,
  });
  const readProject = () => state.getProject({
    domainId: project.domainId,
    projectId: project.id,
  });
  let createdCount = 0;
  let existingCount = 0;
  const existing = await readProject();
  if (existing !== null) {
    verifyExistingProject(existing);
    existingCount += 1;
  } else {
    try {
      await client.send(new PutItemCommand({
        TableName: tableName,
        Item: projectItem(project),
        ConditionExpression:
          "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
        },
      }));
      createdCount += 1;
    } catch (error) {
      if (error?.name !== "ConditionalCheckFailedException") throw error;
      const concurrent = await readProject();
      if (concurrent === null) throw error;
      verifyExistingProject(concurrent);
      existingCount += 1;
    }
  }
  if (agent !== null) {
    const readAgent = () => state.getAgent({
      domainId: agent.domainId,
      projectId: agent.projectId,
      agentId: agent.id,
    });
    const existingAgent = await readAgent();
    if (existingAgent !== null) {
      verifyExistingAgent(existingAgent);
      // Reconcile only deployment-owned, untouched draft bindings. A builder's
      // configuration or resource edits must survive later stack updates.
      if (
        oldSeed?.tableName === tableName
        && oldSeed.agent?.id === agent.id
        && oldSeed.agent?.domainId === agent.domainId
        && oldSeed.agent?.projectId === agent.projectId
        && existingAgent.status === "DRAFT"
        && existingAgent.buildConfig === null
        && ["memoryIds", "knowledgeBaseIds"].every(
          (key) => isDeepStrictEqual(existingAgent[key], oldSeed.agent[key]),
        )
        && ["memoryIds", "knowledgeBaseIds"].some(
          (key) => !isDeepStrictEqual(existingAgent[key], agent[key]),
        )
      ) {
        const before = agentItem(existingAgent);
        const entries = Object.entries(before);
        // Compare every observed field to avoid overwriting concurrent edits.
        await client.send(new PutItemCommand({
          TableName: tableName,
          Item: agentItem({
            ...existingAgent,
            memoryIds: agent.memoryIds,
            knowledgeBaseIds: agent.knowledgeBaseIds,
            updatedAt: generatedAt,
          }),
          ConditionExpression: entries.map((_, i) => `#f${i} = :v${i}`).join(" AND "),
          ExpressionAttributeNames: Object.fromEntries(
            entries.map(([key], i) => [`#f${i}`, key]),
          ),
          ExpressionAttributeValues: Object.fromEntries(
            entries.map(([, value], i) => [`:v${i}`, value]),
          ),
        }));
      }
      existingCount += 1;
    } else {
      try {
        await client.send(new PutItemCommand({
          TableName: tableName,
          Item: agentItem(agent),
          ConditionExpression:
            "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
          ExpressionAttributeNames: {
            "#pk": "pk",
            "#sk": "sk",
          },
        }));
        createdCount += 1;
      } catch (error) {
        if (error?.name !== "ConditionalCheckFailedException") throw error;
        const concurrent = await readAgent();
        if (concurrent === null) throw error;
        verifyExistingAgent(concurrent);
        existingCount += 1;
      }
    }
  }
  return {
    PhysicalResourceId: physicalResourceId(tableName, project),
    Data: {
      CreatedCount: createdCount,
      ExistingCount: existingCount,
    },
  };
}

function failurePhysicalResourceId(event) {
  if (
    typeof event?.PhysicalResourceId === "string"
    && event.PhysicalResourceId.startsWith("platform-baseline-project:")
  ) {
    return event.PhysicalResourceId;
  }
  const tableName = event?.ResourceProperties?.TableName;
  const requested = event?.ResourceProperties?.Project;
  const identity = isPlainObject(requested) ? baselineIdentity(requested) : null;
  return typeof tableName === "string"
    && TABLE_NAME_PATTERN.test(tableName)
    && identity
    ? physicalResourceId(tableName, identity)
    : "platform-baseline-project:failed";
}

export async function handleBaselineProjectSeed(
  event,
  context,
  dynamoClient,
  {
    clearTimer = clearTimeout,
    clock = Date.now,
    logError = console.error,
    now = () => new Date().toISOString(),
    responseAttempts = DEFAULT_RESPONSE_ATTEMPTS,
    responseRetryDelayMs = DEFAULT_RESPONSE_RETRY_DELAY_MS,
    sendResponse = sendCloudFormationResponse,
    setTimer = setTimeout,
    sleep = defaultSleep,
  } = {},
) {
  let executionBudget;
  try {
    executionBudget = createExecutionBudget(context, {
      clearTimer,
      clock,
      setTimer,
    });
  } catch {
    executionBudget = null;
  }

  async function deliverResponse(
    status,
    result,
    reason,
    {
      attempts = responseAttempts,
      terminal = false,
    } = {},
  ) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (
          executionBudget
          && !executionBudget.canStartResponse(terminal)
        ) {
          return false;
        }
      } catch {
        return false;
      }
      try {
        await sendResponse(
          event,
          context,
          status,
          result,
          reason,
        );
        return true;
      } catch {
        if (attempt + 1 < attempts) {
          try {
            if (
              executionBudget
              && !executionBudget.canStartResponse(
                terminal,
                responseRetryDelayMs,
              )
            ) {
              return false;
            }
          } catch {
            return false;
          }
          try {
            await sleep(responseRetryDelayMs);
          } catch {
            // Response retries must not replay the completed seed operation.
          }
        }
      }
    }
    return false;
  }

  function logControlledResponseFailure() {
    try {
      logError(RESPONSE_FAILED_REASON);
    } catch {
      // Logging cannot replace the controlled failure.
    }
  }

  if (executionBudget === null) {
    const result = {
      PhysicalResourceId: failurePhysicalResourceId(event),
    };
    try {
      logError(OPERATION_FAILED_REASON);
    } catch {
      // Logging cannot replace the controlled failure response.
    }
    if (!await deliverResponse(
      "FAILED",
      result,
      OPERATION_FAILED_REASON,
      {
        attempts: 1,
        terminal: true,
      },
    )) {
      logControlledResponseFailure();
      throw new Error(RESPONSE_FAILED_REASON);
    }
    return result;
  }

  let result;
  try {
    result = await reconcileBaselineProject(event, {
      canUseOperationTime: executionBudget.canUseOperationTime,
      dynamo: dynamoClient,
      now,
      sleep,
      startOperationAttempt: executionBudget.startOperationAttempt,
    });
  } catch {
    result = { PhysicalResourceId: failurePhysicalResourceId(event) };
    try {
      logError(OPERATION_FAILED_REASON);
    } catch {
      // Logging cannot replace the controlled failure response.
    }
    if (!await deliverResponse(
      "FAILED",
      result,
      OPERATION_FAILED_REASON,
      { terminal: true },
    )) {
      logControlledResponseFailure();
      throw new Error(RESPONSE_FAILED_REASON);
    }
    return result;
  }

  if (await deliverResponse(
    "SUCCESS",
    result,
    "Baseline platform project seed operation completed.",
  )) {
    return result;
  }

  const terminalFailureResult = {
    PhysicalResourceId: failurePhysicalResourceId(event),
  };
  if (await deliverResponse(
    "FAILED",
    terminalFailureResult,
    RESPONSE_FAILED_REASON,
    { terminal: true },
  )) {
    return terminalFailureResult;
  }

  logControlledResponseFailure();
  throw new Error(RESPONSE_FAILED_REASON);
}

const dynamo = new DynamoDBClient({});

export async function handler(event, context) {
  if (event.ResourceType === "Custom::PlatformHitlCatalog") return handleHitlCatalogSeed(event, context, dynamo);
  return handleBaselineProjectSeed(event, context, dynamo);
}
