import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { STSClient } from "@aws-sdk/client-sts";
import {
  createAuthorizer,
  createWorkspaceBreakGlassResolver,
} from "../authz/authorize.mjs";
import {
  createActiveDomainDirectory,
} from "../api/domain-directory.mjs";
import {
  projectEffectiveIdentity,
  projectIdentity,
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
import {
  createPlatformState,
} from "../platform-admin/state.mjs";
import {
  createModelAccessResolver,
  createModelSelectionResolver,
} from "../model-governance/access.mjs";
import {
  createModelPolicyState,
} from "../model-governance/state.mjs";
import {
  createControlPlaneService,
} from "../control-plane/service.mjs";
import { createConfiguredBedrockInference } from "../agent-runtime/bedrock-inference.mjs";
import {
  createGatewayCredentialsProvider,
} from "../workspace/gateway-credentials.mjs";
import {
  createWorkspaceState,
} from "../workspace/state.mjs";
import {
  createBuilderHandler,
} from "./index.mjs";
import {
  createBuilderResourceAccessResolver,
} from "./resource-access.mjs";
import {
  createBuilderService,
} from "./service.mjs";

const DOMAIN_PATTERN = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
const SLUG_PATTERN = "[a-z][a-z0-9-]{0,63}";
const PROJECT_REF = new RegExp(
  `^project:(${DOMAIN_PATTERN})/(${SLUG_PATTERN})$`,
);
const AGENT_REF = new RegExp(
  `^agent:(${DOMAIN_PATTERN})/(${SLUG_PATTERN})/(${SLUG_PATTERN})$`,
);

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

function parseResourceRef(value) {
  if (typeof value !== "string") {
    throw new Error("Builder authorization reference is invalid.");
  }
  const project = PROJECT_REF.exec(value);
  if (project) {
    return {
      type: "PROJECT",
      domainId: project[1],
      projectId: project[2],
      agentId: null,
    };
  }
  const agent = AGENT_REF.exec(value);
  if (agent) {
    return {
      type: "AGENT",
      domainId: agent[1],
      projectId: agent[2],
      agentId: agent[3],
    };
  }
  throw new Error("Builder authorization reference is invalid.");
}

async function authoritativeProject(workspaceState, ref) {
  const project = await workspaceState.getProject({
    domainId: ref.domainId,
    projectId: ref.projectId,
  });
  if (project === null) return null;
  if (
    !isPlainObject(project)
    || project.domainId !== ref.domainId
    || project.id !== ref.projectId
    || typeof project.ownerSubject !== "string"
    || !Array.isArray(project.memberSubjects)
    || project.memberSubjects.some((subject) =>
      typeof subject !== "string")
    || typeof project.status !== "string"
  ) {
    throw new Error("Builder project state is malformed.");
  }
  return project;
}

function numericClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

function authenticatedProjector() {
  return {
    projectAuthenticated(claims) {
      const identity = projectIdentity(claims);
      return {
        ...identity,
        actor: identity.user,
      };
    },
    projectEffective: projectEffectiveIdentity,
  };
}

function builderAuthorizer({ workspaceState, clock }) {
  const resolveWorkspaceBreakGlass = createWorkspaceBreakGlassResolver({
    workspaceState,
  });
  async function resolveBreakGlass(input) {
    if (input.action !== "model:use") {
      return resolveWorkspaceBreakGlass(input);
    }
    const builderAction = input.requestContext?.builderAction;
    const builderResourceRef =
      input.requestContext?.builderResourceRef;
    const ref = parseResourceRef(builderResourceRef);
    const current = parseResourceRef(input.resource.id);
    if (
      !new Set(["agent:create", "agent:update", "agent:test"])
        .has(builderAction)
      || ref.domainId !== current.domainId
      || ref.projectId !== current.projectId
      || (
        builderAction === "agent:create"
        && ref.type !== "PROJECT"
      )
      || (
        builderAction !== "agent:create"
        && ref.type !== "AGENT"
      )
    ) {
      throw new Error("Builder model-use authorization is invalid.");
    }
    const grant = await resolveWorkspaceBreakGlass({
      ...input,
      action: builderAction,
      resource: {
        ...input.resource,
        id: builderResourceRef,
      },
    });
    return grant === null
      ? null
      : {
          ...grant,
          action: "model:use",
          resourceId: input.resource.id,
        };
  }
  return createAuthorizer({
    async resolvePrincipal({ requestContext, resourceRef }) {
      const ref = parseResourceRef(resourceRef);
      const project = await authoritativeProject(workspaceState, ref);
      const assigned = project !== null
        && (
          project.ownerSubject === requestContext.subject
          || project.memberSubjects.includes(requestContext.subject)
        );
      return {
        id: requestContext.subject,
        role: requestContext.role,
        activeDomain: requestContext.activeDomain,
        domainIds: [...requestContext.domainIds],
        projectIds: assigned ? [ref.projectId] : [],
      };
    },
    async resolveResource({ resourceRef }) {
      const ref = parseResourceRef(resourceRef);
      const project = await authoritativeProject(workspaceState, ref);
      if (project === null) return null;
      if (ref.type === "PROJECT") {
        return {
          id: resourceRef,
          domainId: ref.domainId,
          projectId: ref.projectId,
          ownerId: project.ownerSubject,
          assigneeIds: [...project.memberSubjects],
          lifecycleState: project.status,
        };
      }
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
        || typeof agent.ownerSubject !== "string"
        || typeof agent.status !== "string"
      ) {
        throw new Error("Builder agent state is malformed.");
      }
      return {
        id: resourceRef,
        domainId: ref.domainId,
        projectId: ref.projectId,
        ownerId: agent.ownerSubject,
        assigneeIds: [...project.memberSubjects],
        lifecycleState: agent.status,
      };
    },
    async resolvePolicy({ resourceRef }) {
      parseResourceRef(resourceRef);
      return { allowed: true };
    },
    resolveBreakGlass,
    clock: () => numericClock(clock),
  });
}

export function createBuilderRuntime({
  workspaceState,
  modelPolicyState,
  domainDirectory,
  gateway,
  resourceAccessResolver,
  identityVerifier,
  clock,
} = {}) {
  if (
    !workspaceState
    || ![
      "getProject",
      "getAgent",
      "getResourceGrant",
      "listBreakGlass",
      "getMutationResult",
      "claimMutation",
      "beginTransaction",
      "putAgent",
      "abortMutation",
    ]
      .every((method) => typeof workspaceState[method] === "function")
    || !modelPolicyState
    || typeof modelPolicyState.getModelPolicy !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !gateway
    || typeof gateway.invoke !== "function"
    || typeof resourceAccessResolver !== "function"
    || typeof identityVerifier !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError("Builder runtime configuration is invalid.");
  }

  const authorizer = builderAuthorizer({ workspaceState, clock });
  return createBuilderHandler({
    identityProjector: authenticatedProjector(),
    identityVerifier,
    domainDirectory,
    builderService: createBuilderService({
      workspaceState,
      authorizer,
      modelAccessResolver: createModelAccessResolver({
        modelPolicyState,
        workspaceState,
      }),
      modelSelectionResolver: createModelSelectionResolver({
        modelAccessResolver: createModelAccessResolver({ modelPolicyState, workspaceState }), workspaceState,
      }),
      resourceAccessResolver,
      gateway,
      clock,
    }),
  });
}

function configuredHandler() {
  if (productionHandler) return productionHandler;

  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const serialized = process.env.CONTROL_PLANE_CONFIG;
  const gatewayBaseUrl = process.env.LLM_GATEWAY_URL;
  const region = process.env.LLM_GATEWAY_REGION;
  if (
    typeof tableName !== "string"
    || !tableName.trim()
    || typeof gatewayBaseUrl !== "string"
    || !gatewayBaseUrl.trim()
    || typeof region !== "string"
    || !region.trim()
    || typeof serialized !== "string"
    || !serialized.trim()
  ) {
    throw new Error("Builder runtime configuration is unavailable.");
  }

  const clock = () => new Date();
  const config = JSON.parse(serialized);
  const dynamo = new DynamoDBClient({});
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
  const modelPolicyState = createModelPolicyState({
    tableName: tableName.trim(),
    dynamo,
    now: () => clock().toISOString(),
  });
  const credentialsProvider = createGatewayCredentialsProvider({
    stsClient: new STSClient({
      region: region.trim(),
      credentials: dynamo.config.credentials,
    }),
    roleArn: process.env.GATEWAY_INVOKER_ROLE_ARN,
    clock,
  });
  // Bounded Converse is opt-in per deployment. Build it on first use so agent
  // authoring stays available when hosted inference is not configured; only the
  // draft-test action depends on it.
  let inference;
  const gateway = {
    invoke: (input) => {
      inference ??= createConfiguredBedrockInference({
        env: process.env,
        credentialsProvider: dynamo.config.credentials,
      });
      return inference.invoke(input);
    },
  };

  productionHandler = createBuilderRuntime({
    workspaceState,
    modelPolicyState,
    gateway,
    resourceAccessResolver: createBuilderResourceAccessResolver({
      inventoryProvider: async (scope) =>
        createControlPlaneService({
          config,
          domainState,
          credentials: ({ abortSignal }) => credentialsProvider({
            sourceIdentity: `domain_${scope.activeDomain}`,
            abortSignal,
          }),
          clock,
        }).resourceInventory(scope),
    }),
    identityVerifier: verifyCurrentDemoOperator,
    clock,
    domainDirectory: createActiveDomainDirectory(domainState),
  });
  return productionHandler;
}

export async function handler(event, context) {
  return configuredHandler()(event, context);
}
