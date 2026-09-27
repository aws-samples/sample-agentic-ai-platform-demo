import {
  BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  createAuthorizer,
} from "../authz/authorize.mjs";
import {
  createActiveDomainDirectory,
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
  createRuntimeProofSecretProvider,
} from "../agent-runtime/proof-secret.mjs";
import {
  createExperienceHandler,
} from "./index.mjs";
import {
  createAgentRuntimeAdapter,
} from "./runtime-adapter.mjs";
import {
  createCognitoGroupDirectory,
} from "./group-directory.mjs";
import {
  createExperienceInvocationStore,
} from "./invocation-store.mjs";
import { createNativeExecutionJournal, nativeExecutionEnabled } from "../agent-runtime/execution-journal.mjs";
import { journalCompatibilityFromEnv } from "./journal-compatibility.mjs";
import {
  createExperienceService,
} from "./service.mjs";
import {
  createExperienceSubmissionStore,
} from "./submission-store.mjs";

const DOMAIN_PATTERN = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
const SLUG_PATTERN = "[a-z][a-z0-9-]{0,63}";
const AGENT_REF = new RegExp(
  `^agent:(${DOMAIN_PATTERN})/(${SLUG_PATTERN})/(${SLUG_PATTERN})$`,
);
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MAX_AUTHENTICATED_GROUPS = 32;

let productionHandlerPromise;

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

function parseAgentRef(value) {
  if (typeof value !== "string") {
    throw new Error("Experience authorization reference is invalid.");
  }
  const match = AGENT_REF.exec(value);
  if (!match) {
    throw new Error("Experience authorization reference is invalid.");
  }
  return {
    domainId: match[1],
    projectId: match[2],
    agentId: match[3],
  };
}

function numericClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Experience authorization clock is invalid.");
  }
  return timestamp;
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

function snapshotStrings(value, pattern) {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    length === undefined
    || !Object.hasOwn(length, "value")
    || !Number.isSafeInteger(length.value)
    || length.value < 0
    || length.value > MAX_AUTHENTICATED_GROUPS
  ) {
    return null;
  }
  const values = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
      || !pattern.test(descriptor.value)
    ) {
      return null;
    }
    values.push(descriptor.value);
  }
  return new Set(values).size === values.length ? values : null;
}

function entitlementAuthorizationContext(requestContext) {
  const groups = snapshotStrings(
    ownData(requestContext, "authenticatedGroups").value,
    GROUP_PATTERN,
  );
  const domains = snapshotStrings(
    ownData(requestContext, "authenticatedDomains").value,
    DOMAIN_ID_PATTERN,
  );
  const rawSubject = ownData(requestContext, "entitlementSubject");
  if (groups === null || domains === null || !rawSubject.present) {
    throw new Error("Experience authorization context is invalid.");
  }
  if (rawSubject.value === null) {
    return { groups, domains, entitlementSubject: null };
  }
  if (
    !isPlainObject(rawSubject.value)
    || Reflect.ownKeys(rawSubject.value).length !== 2
  ) {
    throw new Error("Experience authorization context is invalid.");
  }
  const subjectType = ownData(rawSubject.value, "subjectType");
  const subject = ownData(rawSubject.value, "subject");
  if (
    !subjectType.present
    || !subject.present
    || !new Set(["USER", "GROUP", "DOMAIN"]).has(subjectType.value)
    || typeof subject.value !== "string"
    || !SUBJECT_PATTERN.test(subject.value)
  ) {
    throw new Error("Experience authorization context is invalid.");
  }
  const authorized = (
    subjectType.value === "USER"
      ? subject.value === requestContext.subject
      : subjectType.value === "GROUP"
        ? groups.includes(subject.value)
        : domains.includes(subject.value)
  );
  if (!authorized) {
    throw new Error("Experience authorization context is invalid.");
  }
  return {
    groups,
    domains,
    entitlementSubject: {
      subjectType: subjectType.value,
      subject: subject.value,
    },
  };
}

function experienceAuthorizer({ workspaceState, clock }) {
  const authorize = createAuthorizer({
    async resolvePrincipal({ requestContext, resourceRef }) {
      parseAgentRef(resourceRef);
      const entitlementContext = entitlementAuthorizationContext(
        requestContext,
      );
      if (
        !isPlainObject(requestContext)
        || requestContext.source !== "experience-service"
        || requestContext.role !== "user"
        || typeof requestContext.subject !== "string"
        || requestContext.subject.length === 0
        || requestContext.activeDomain !== null
        || !Array.isArray(requestContext.domainIds)
        || requestContext.domainIds.length !== 0
        || entitlementContext.groups.length > MAX_AUTHENTICATED_GROUPS
      ) {
        throw new Error("Experience authorization context is invalid.");
      }
      return {
        id: requestContext.subject,
        role: "user",
        domainIds: [],
        projectIds: [],
      };
    },
    async resolveResource({ resourceRef }) {
      const ref = parseAgentRef(resourceRef);
      const agent = await workspaceState.getAgent({
        domainId: ref.domainId,
        projectId: ref.projectId,
        agentId: ref.agentId,
      });
      if (agent === null) return null;
      if (
        !isPlainObject(agent)
        || agent.domainId !== ref.domainId
        || agent.projectId !== ref.projectId
        || agent.id !== ref.agentId
        || agent.status !== "PRODUCTION_DEPLOYED"
      ) {
        throw new Error("Experience agent state is invalid.");
      }
      return {
        id: resourceRef,
        domainId: ref.domainId,
        projectId: ref.projectId,
        lifecycleState: "ACTIVE",
      };
    },
    async resolveEntitlement({ requestContext, resourceRef }) {
      const ref = parseAgentRef(resourceRef);
      const { entitlementSubject } =
        entitlementAuthorizationContext(requestContext);
      if (entitlementSubject === null) return { granted: false };
      const entitlement = await workspaceState.getEntitlement({
        ...(entitlementSubject.subjectType === "USER"
          ? {}
          : { subjectType: entitlementSubject.subjectType }),
        subject: entitlementSubject.subject,
        domainId: ref.domainId,
        projectId: ref.projectId,
        agentId: ref.agentId,
      });
      if (entitlement === null) return { granted: false };
      if (
        !isPlainObject(entitlement)
        || (entitlement.subjectType ?? "USER")
          !== entitlementSubject.subjectType
        || entitlement.subject !== entitlementSubject.subject
        || entitlement.domainId !== ref.domainId
        || entitlement.projectId !== ref.projectId
        || entitlement.agentId !== ref.agentId
      ) {
        throw new Error("Experience entitlement state is invalid.");
      }
      const expiresAt = entitlement.expiresAt;
      if (
        expiresAt !== undefined
        && expiresAt !== null
        && (
          typeof expiresAt !== "string"
          || !Number.isFinite(Date.parse(expiresAt))
        )
      ) {
        throw new Error("Experience entitlement state is invalid.");
      }
      return {
        granted:
          entitlement.status === "ACTIVE"
          && (
            expiresAt === undefined
            || expiresAt === null
            || Date.parse(expiresAt) > numericClock(clock)
          ),
      };
    },
    async resolvePolicy({ resourceRef }) {
      parseAgentRef(resourceRef);
      return { allowed: true };
    },
    clock: () => numericClock(clock),
  });

  return async function authorizeExperience(input) {
    const decision = await authorize(input);
    if (!isPlainObject(decision) || decision.ok !== true) {
      throw new Error("Experience authorization decision is invalid.");
    }
    return { ok: true };
  };
}

export function createExperienceRuntime({
  workspaceState,
  domainDirectory,
  runtimeAdapter,
  invocationStore,
  submissionStore,
  identityVerifier,
  groupDirectory,
  clock,
} = {}) {
  if (
    !workspaceState
    || ![
      "beginTransaction",
      "listEntitlements",
      "listProjects",
      "listAgents",
      "getEntitlement",
      "getAgent",
      "listDeployments",
      "getSession",
      "listSessions",
      "listAccessRequests",
      "getMutationResult",
      "claimMutation",
      "putApproval",
      "putSession",
    ].every((method) => typeof workspaceState[method] === "function")
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !runtimeAdapter
    || typeof runtimeAdapter.invoke !== "function"
    || !invocationStore
    || ![
      "get",
      "start",
      "complete",
    ].every((method) => typeof invocationStore[method] === "function")
    || !submissionStore
    || ![
      "submitFeedback",
      "reportIssue",
    ].every((method) => typeof submissionStore[method] === "function")
    || typeof identityVerifier !== "function"
    || !groupDirectory
    || typeof groupDirectory.resolveCurrentGroups !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError("Experience runtime configuration is invalid.");
  }

  return createExperienceHandler({
    identityProjector: createProductionIdentityProjector(),
    identityVerifier,
    groupDirectory,
    domainDirectory,
    experienceService: createExperienceService({
      workspaceState,
      domainDirectory,
      authorizer: experienceAuthorizer({ workspaceState, clock }),
      runtimeAdapter,
      invocationStore,
      submissionStore,
      clock,
    }),
  });
}

export async function createConfiguredExperienceHandler({
  env = process.env,
  dynamo = new DynamoDBClient({}),
  agentRuntimeClient = new BedrockAgentCoreClient({ maxAttempts: 1 }),
  secretsClient = new SecretsManagerClient({}),
  cognito = new CognitoIdentityProviderClient({}),
  identityVerifier = verifyCurrentDemoOperator,
  clock = () => new Date(),
} = {}) {
  const tableName = env.PLATFORM_STATE_TABLE_NAME;
  if (typeof tableName !== "string" || !tableName.trim()) {
    throw new Error("Experience runtime configuration is unavailable.");
  }
  const compatibility = journalCompatibilityFromEnv(env);
  let outputCaps;
  if (env.EXPERIENCE_OUTPUT_CAPS_JSON !== undefined) {
    try {
      if (typeof env.EXPERIENCE_OUTPUT_CAPS_JSON !== "string") throw new TypeError();
      outputCaps = JSON.parse(env.EXPERIENCE_OUTPUT_CAPS_JSON);
    } catch {
      throw new TypeError("Experience output cap configuration is invalid.");
    }
  }

  const proofConfigProvider = createRuntimeProofSecretProvider({
    client: secretsClient,
    secretArn: env.RUNTIME_INVOCATION_PROOF_SECRET_ARN,
  });
  const workspaceState = createWorkspaceState({
    tableName: tableName.trim(),
    dynamo,
    now: clock,
  });
  const domainState = createPlatformState({
    tableName: tableName.trim(),
    dynamo,
    now: clock,
  });
  return createExperienceRuntime({
    workspaceState,
    runtimeAdapter: createAgentRuntimeAdapter({
      client: agentRuntimeClient,
      proofConfigProvider,
      outputCaps,
    }),
    invocationStore: createExperienceInvocationStore({
      tableName: tableName.trim(),
      dynamo,
      now: clock,
      compatibility,
      ...(nativeExecutionEnabled(env.EXPERIENCE_NATIVE_EXECUTION_VERSION) ? {
        nativeJournal: createNativeExecutionJournal({ tableName: tableName.trim(), dynamo, now: clock }),
      } : {}),
    }),
    submissionStore: createExperienceSubmissionStore({
      tableName: tableName.trim(),
      dynamo,
      now: clock,
    }),
    identityVerifier,
    groupDirectory: createCognitoGroupDirectory({
      client: cognito,
      userPoolId: env.COGNITO_USER_POOL_ID,
    }),
    clock,
    domainDirectory: createActiveDomainDirectory(domainState),
  });
}

function configuredHandler() {
  if (!productionHandlerPromise) {
    productionHandlerPromise = createConfiguredExperienceHandler()
      .catch((error) => {
        productionHandlerPromise = undefined;
        throw error;
      });
  }
  return productionHandlerPromise;
}

export async function handler(event, context) {
  const configured = await configuredHandler();
  return configured(event, context);
}
