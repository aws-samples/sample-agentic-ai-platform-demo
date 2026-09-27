import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  createAuthorizer,
  createWorkspaceBreakGlassResolver,
} from "../authz/authorize.mjs";
import {
  createActiveDomainRecordDirectory,
} from "../api/domain-directory.mjs";
import {
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
import {
  createPlatformState,
} from "../platform-admin/state.mjs";
import {
  createProductionIdentityProjector,
} from "../workspace/runtime.mjs";
import {
  createWorkspaceState,
} from "../workspace/state.mjs";
import {
  createOperationsHandler,
} from "./index.mjs";
import {
  createCloudWatchRuntimeProvider,
} from "./runtime.mjs";
import {
  createJournalUsageProvider,
} from "./journal-usage.mjs";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { createExperienceInvocationStore } from "../experience/invocation-store.mjs";
import { createPlatformCostsReader } from "./platform-costs.mjs";
import { createNativeExecutionJournal, nativeExecutionEnabled } from "../agent-runtime/execution-journal.mjs";
import { journalCompatibilityFromEnv } from "../experience/journal-compatibility.mjs";
import { createProjectBudgetState } from "./budget-state.mjs";
import { createBudgetSnsPublisher } from "./budget-sns-publisher.mjs";
import { boundedBudgetDynamo } from "./budget-deadline.mjs";

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const RESOURCE_REF =
  /^operations-collection:(operations|costs|platform-costs):([A-Za-z0-9_-]{1,8192})$/;
const WORKFLOW_RESOURCE_REF =
  /^operations-resource:([A-Za-z0-9_-]{1,8192})$/;
const ROLES = new Set(["admin", "lead", "builder"]);

let productionHandler;

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

function ownData(value, key) {
  if (!isPlainObject(value)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  ) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

function exactRecord(value, keys) {
  if (!isPlainObject(value)) return null;
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const result = {};
  for (const key of keys) {
    const property = ownData(value, key);
    if (!property.present) return null;
    result[key] = property.value;
  }
  return result;
}

function decodeCollectionRef(value) {
  if (typeof value !== "string") {
    throw new Error("Operations authorization reference is invalid.");
  }
  const match = RESOURCE_REF.exec(value);
  if (!match) {
    throw new Error("Operations authorization reference is invalid.");
  }
  let descriptor;
  try {
    const bytes = Buffer.from(match[2], "base64url");
    if (
      bytes.byteLength === 0
      || bytes.byteLength > 8 * 1024
      || bytes.toString("base64url") !== match[2]
    ) {
      throw new Error();
    }
    descriptor = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("Operations authorization reference is invalid.");
  }
  const record = exactRecord(descriptor, [
    "v",
    "resource",
    "subject",
    "role",
    "activeDomain",
    "domainIds",
  ]);
  if (
    record === null
    || record.v !== 1
    || record.resource !== match[1]
    || !SUBJECT_PATTERN.test(record.subject)
    || !ROLES.has(record.role)
    || !Array.isArray(record.domainIds)
    || record.domainIds.length > 100
    || record.domainIds.some((domainId) =>
      !DOMAIN_ID_PATTERN.test(domainId))
    || new Set(record.domainIds).size !== record.domainIds.length
    || (
      record.role === "admin"
      && record.activeDomain !== null
      && !record.domainIds.includes(record.activeDomain)
    )
    || (
      record.role !== "admin"
      && (
        !DOMAIN_ID_PATTERN.test(record.activeDomain ?? "")
        || record.domainIds.length !== 1
        || record.domainIds[0] !== record.activeDomain
      )
    )
  ) {
    throw new Error("Operations authorization reference is invalid.");
  }
  return Object.freeze(record);
}

function decodeWorkflowResourceRef(value) {
  if (typeof value !== "string") {
    throw new Error("Operations authorization reference is invalid.");
  }
  const match = WORKFLOW_RESOURCE_REF.exec(value);
  if (!match) {
    throw new Error("Operations authorization reference is invalid.");
  }
  let descriptor;
  try {
    const bytes = Buffer.from(match[1], "base64url");
    if (
      bytes.byteLength === 0
      || bytes.byteLength > 8 * 1024
      || bytes.toString("base64url") !== match[1]
    ) {
      throw new Error();
    }
    descriptor = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("Operations authorization reference is invalid.");
  }
  const record = exactRecord(descriptor, [
    "v",
    "type",
    "id",
    "domainId",
    "projectId",
    "ownerSubject",
    "lifecycleState",
  ]);
  if (
    record === null
    || record.v !== 1
    || typeof record.type !== "string"
    || record.type.length === 0
    || record.type.length > 64
    || typeof record.id !== "string"
    || record.id.length === 0
    || record.id.length > 512
    || !DOMAIN_ID_PATTERN.test(record.domainId)
    || typeof record.projectId !== "string"
    || record.projectId.length === 0
    || record.projectId.length > 64
    || !SUBJECT_PATTERN.test(record.ownerSubject)
    || typeof record.lifecycleState !== "string"
    || record.lifecycleState.length === 0
    || record.lifecycleState.length > 64
  ) {
    throw new Error("Operations authorization reference is invalid.");
  }
  return Object.freeze(record);
}

function validateWorkflowContext(value) {
  const record = exactRecord(value, [
    "source",
    "subject",
    "role",
    "activeDomain",
    "domainIds",
  ]);
  if (
    record === null
    || record.source !== "operations-api"
    || !SUBJECT_PATTERN.test(record.subject)
    || !ROLES.has(record.role)
    || !Array.isArray(record.domainIds)
    || record.domainIds.length > 100
    || record.domainIds.some(
      (domainId) => !DOMAIN_ID_PATTERN.test(domainId),
    )
    || new Set(record.domainIds).size !== record.domainIds.length
    || (
      record.role === "admin"
      && record.activeDomain !== null
      && !record.domainIds.includes(record.activeDomain)
    )
    || (
      record.role !== "admin"
      && (
        !DOMAIN_ID_PATTERN.test(record.activeDomain ?? "")
        || record.domainIds.length !== 1
        || record.domainIds[0] !== record.activeDomain
      )
    )
  ) {
    throw new Error("Operations authorization context is invalid.");
  }
  return Object.freeze(record);
}

function numericClock(clock) {
  const value = clock();
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(result) || result < 0) {
    throw new Error("Operations authorization clock is invalid.");
  }
  return result;
}

function operationsAuthorizer({ clock, workspaceState }) {
  const authorize = createAuthorizer({
    async resolvePrincipal({ requestContext, resourceRef }) {
      if (typeof resourceRef === "string" && RESOURCE_REF.test(resourceRef)) {
        const ref = decodeCollectionRef(resourceRef);
        if (
          !isPlainObject(requestContext)
          || requestContext.source !== "operations-api"
          || requestContext.subject !== ref.subject
          || requestContext.role !== ref.role
          || requestContext.activeDomain !== ref.activeDomain
          || !Array.isArray(requestContext.domainIds)
          || requestContext.domainIds.length !== ref.domainIds.length
          || requestContext.domainIds.some(
            (domainId, index) => domainId !== ref.domainIds[index],
          )
        ) {
          throw new Error("Operations authorization context is invalid.");
        }
        return {
          id: ref.subject,
          role: ref.role,
          domainIds: [...ref.domainIds],
          projectIds: ref.role === "builder" ? ["collection"] : [],
        };
      }
      const context = validateWorkflowContext(requestContext);
      const ref = decodeWorkflowResourceRef(resourceRef);
      let projectIds = context.role === "builder" ? ["collection"] : [];
      if (ref.type === "project" && context.role === "builder") {
        const project = await workspaceState.getProject({ domainId: ref.domainId, projectId: ref.projectId });
        projectIds = project?.status === "ACTIVE" && project.domainId === ref.domainId && project.id === ref.projectId
          && (project.ownerSubject === context.subject || project.memberSubjects?.includes(context.subject))
          ? [project.id] : [];
      }
      return {
        id: context.subject,
        role: context.role,
        domainIds: [...context.domainIds],
        projectIds,
      };
    },
    async resolveResource({ resourceRef }) {
      if (typeof resourceRef === "string" && RESOURCE_REF.test(resourceRef)) {
        const ref = decodeCollectionRef(resourceRef);
        return {
          id: resourceRef,
          domainId: ref.activeDomain ?? ref.domainIds[0] ?? "platform",
          projectId: "collection",
          ownerId: ref.subject,
          assigneeIds: [],
          lifecycleState: "ACTIVE",
        };
      }
      const ref = decodeWorkflowResourceRef(resourceRef);
      if (ref.type === "project") {
        const project = await workspaceState.getProject({ domainId: ref.domainId, projectId: ref.projectId });
        if (!project || project.domainId !== ref.domainId || project.id !== ref.projectId
          || project.status !== "ACTIVE" || !Array.isArray(project.memberSubjects)) {
          throw new Error("Operations project is unavailable.");
        }
        return { id: project.id, domainId: project.domainId, projectId: project.id,
          ownerId: project.ownerSubject, assigneeIds: project.memberSubjects, lifecycleState: project.status };
      }
      return {
        id: ref.id,
        domainId: ref.domainId,
        projectId: ref.projectId,
        ownerId: ref.ownerSubject,
        assigneeIds: [],
        lifecycleState: ref.lifecycleState,
      };
    },
    async resolvePolicy({ resourceRef }) {
      if (typeof resourceRef === "string" && RESOURCE_REF.test(resourceRef)) {
        decodeCollectionRef(resourceRef);
      } else {
        decodeWorkflowResourceRef(resourceRef);
      }
      return { allowed: true };
    },
    resolveBreakGlass: createWorkspaceBreakGlassResolver({
      workspaceState,
    }),
    clock: () => numericClock(clock),
  });

  return async function authorizeOperations(input) {
    const decision = await authorize(input);
    if (!isPlainObject(decision) || decision.ok !== true) {
      throw new Error("Operations authorization decision is invalid.");
    }
    return { ok: true };
  };
}

export function createOperationsRuntime({
  workspaceState,
  domainDirectory,
  cloudWatchProvider,
  usageProvider,
  budgetState,
  budgetDestination = null,
  budgetPublisher = null,
  platformCostsReader = null,
  identityVerifier,
  clock,
  cursorSigningKey,
} = {}) {
  const stateMethods = [
    "beginTransaction",
    "getMutationResult",
    "listProjects",
    "getProject",
    "listIncidents",
    "getIncident",
    "putIncident",
    "listAuditMetadata",
    "listBreakGlass",
    "getBreakGlass",
    "putBreakGlass",
  ];
  if (
    !workspaceState
    || stateMethods.some(
      (method) => typeof workspaceState[method] !== "function",
    )
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !cloudWatchProvider
    || typeof cloudWatchProvider.listRuntimeAggregates !== "function"
    || !usageProvider
    || typeof usageProvider.listInvocationUsageAggregates !== "function"
    || typeof usageProvider.listBudgets !== "function"
    || typeof identityVerifier !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError("Operations runtime configuration is invalid.");
  }
  return createOperationsHandler({
    identityProjector: createProductionIdentityProjector(),
    identityVerifier,
    domainDirectory: {
      async listActiveDomains(options) {
        return (await domainDirectory.listActiveDomains(options))
          .map(({ id }) => ({ id }));
      },
    },
    workspaceState,
    authorizer: operationsAuthorizer({ clock, workspaceState }),
    cloudWatchProvider,
    usageProvider,
    budgetState,
    budgetDestination,
    budgetPublisher,
    platformCostsReader,
    clock,
    cursorSigningKey,
  });
}

function parseJsonObject(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 64 * 1024
  ) {
    throw new Error(`${name} configuration is unavailable.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} configuration is unavailable.`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${name} configuration is unavailable.`);
  }
  return parsed;
}

async function configuredHandler() {
  if (productionHandler) return productionHandler;
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const cursorSigningKey = process.env.OPERATIONS_CURSOR_SIGNING_KEY;
  if (
    typeof tableName !== "string"
    || !tableName.trim()
    || typeof cursorSigningKey !== "string"
    || cursorSigningKey.length < 32
  ) {
    throw new Error("Operations runtime configuration is unavailable.");
  }
  const priceBook = parseJsonObject(
    process.env.OPERATIONS_MODEL_PRICES_JSON,
    "Operations model prices",
    { version: 1, entries: [] },
  );
  const budgets = parseJsonObject(
    process.env.OPERATIONS_BUDGETS_JSON,
    "Operations budgets",
    {},
  );
  const dateClock = () => new Date();
  const numericNow = () => Date.now();
  const dynamo = new DynamoDBClient({});
  const nativeExecution = nativeExecutionEnabled(process.env.OPERATIONS_NATIVE_EXECUTION_VERSION);
  const workspaceState = createWorkspaceState({
    tableName: tableName.trim(),
    dynamo,
    now: dateClock,
  });
  const domainState = createPlatformState({
    tableName: tableName.trim(),
    dynamo,
    now: dateClock,
  });
  const runtimeProvider = createCloudWatchRuntimeProvider({
    client: new CloudWatchClient({}),
    GetMetricDataCommand,
    namespace: "bedrock-agentcore",
    timeoutMs: 1_500,
  });
  productionHandler = createOperationsRuntime({
    workspaceState,
    budgetState: createProjectBudgetState({ tableName: tableName.trim(),
      dynamo: boundedBudgetDynamo(new DynamoDBClient({ maxAttempts: 1 })) }),
    budgetPublisher: await createBudgetSnsPublisher({ destination: process.env.OPERATIONS_BUDGET_SNS_TOPIC_ARN ?? null }),
    budgetDestination: process.env.OPERATIONS_BUDGET_SNS_TOPIC_ARN ?? null,
    domainDirectory: createActiveDomainRecordDirectory(domainState),
    cloudWatchProvider: runtimeProvider,
    usageProvider: createJournalUsageProvider({
      journal: createExperienceInvocationStore({
        tableName: tableName.trim(), dynamo, now: dateClock,
        ...(nativeExecution ? { nativeJournal: createNativeExecutionJournal({
          tableName: tableName.trim(), dynamo, now: dateClock,
        }) } : {}),
      }),
      nativeExecution,
      compatibility: journalCompatibilityFromEnv(process.env),
      priceBook,
      budgets,
    }),
    platformCostsReader: createPlatformCostsReader({
      costExplorer: (() => {
        // Cost Explorer is a us-east-1 global endpoint regardless of the
        // deployment region.
        const client = new CostExplorerClient({ region: "us-east-1" });
        return {
          getCostAndUsage: (params, options) =>
            client.send(new GetCostAndUsageCommand(params), options),
        };
      })(),
      clock: dateClock,
    }),
    identityVerifier: verifyCurrentDemoOperator,
    clock: numericNow,
    cursorSigningKey,
  });
  return productionHandler;
}

export async function handler(event, context) {
  return (await configuredHandler())(event, context);
}
