import {
  BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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
} from "../model-governance/access.mjs";
import {
  createModelPolicyState,
} from "../model-governance/state.mjs";
import {
  createWorkspaceState,
} from "../workspace/state.mjs";
import {
  createDeploymentHandler,
} from "./index.mjs";
import {
  AgentCoreRuntimeControl,
} from "./runtime-control.mjs";
import {
  createDeploymentService,
} from "./service.mjs";

const DOMAIN_PATTERN = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
const SLUG_PATTERN = "[a-z][a-z0-9-]{0,63}";
const AGENT_REF = new RegExp(
  `^agent:(${DOMAIN_PATTERN})/(${SLUG_PATTERN})/(${SLUG_PATTERN})$`,
);
const DEPLOYMENT_REF = new RegExp(
  `^deployment:(${DOMAIN_PATTERN})/(${SLUG_PATTERN})/(${SLUG_PATTERN})$`,
);
const APPROVAL_REF = new RegExp(
  `^approval:(${DOMAIN_PATTERN})/(${SLUG_PATTERN})$`,
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

function parseResourceRef(value) {
  if (typeof value !== "string") {
    throw new Error("Deployment authorization reference is invalid.");
  }
  const agent = AGENT_REF.exec(value);
  if (agent) {
    return {
      type: "AGENT",
      domainId: agent[1],
      projectId: agent[2],
      id: agent[3],
    };
  }
  const deployment = DEPLOYMENT_REF.exec(value);
  if (deployment) {
    return {
      type: "DEPLOYMENT",
      domainId: deployment[1],
      projectId: deployment[2],
      id: deployment[3],
    };
  }
  throw new Error("Deployment authorization reference is invalid.");
}

function parseApprovalRef(value) {
  if (typeof value !== "string") {
    throw new Error("Approval authorization reference is invalid.");
  }
  const approval = APPROVAL_REF.exec(value);
  if (!approval) {
    throw new Error("Approval authorization reference is invalid.");
  }
  return {
    domainId: approval[1],
    id: approval[2],
  };
}

function numericClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

async function projectFor(workspaceState, ref) {
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
    throw new Error("Deployment project state is malformed.");
  }
  return project;
}

export function createDeploymentAuthorizer({
  workspaceState,
  clock,
}) {
  const resolveBreakGlass = createWorkspaceBreakGlassResolver({
    workspaceState,
  });
  return createAuthorizer({
    async resolvePrincipal({ requestContext, resourceRef }) {
      const ref = parseResourceRef(resourceRef);
      const project = await projectFor(workspaceState, ref);
      const assigned = project !== null
        && (
          project.ownerSubject === requestContext.subject
          || project.memberSubjects.includes(requestContext.subject)
        );
      return {
        id: requestContext.subject,
        role: requestContext.role,
        domainIds: [...requestContext.domainIds],
        projectIds: assigned ? [ref.projectId] : [],
      };
    },
    async resolveResource({ resourceRef }) {
      const ref = parseResourceRef(resourceRef);
      const project = await projectFor(workspaceState, ref);
      if (project === null) return null;
      if (ref.type === "AGENT") {
        const agent = await workspaceState.getAgent({
          domainId: ref.domainId,
          projectId: ref.projectId,
          agentId: ref.id,
        });
        if (agent === null) return null;
        if (
          !isPlainObject(agent)
          || agent.domainId !== ref.domainId
          || agent.projectId !== ref.projectId
          || agent.id !== ref.id
          || typeof agent.ownerSubject !== "string"
          || typeof agent.status !== "string"
        ) {
          throw new Error("Deployment agent state is malformed.");
        }
        return {
          id: resourceRef,
          domainId: ref.domainId,
          projectId: ref.projectId,
          ownerId: agent.ownerSubject,
          assigneeIds: [...project.memberSubjects],
          lifecycleState: agent.status,
        };
      }
      const deployment = await workspaceState.getDeployment({
        domainId: ref.domainId,
        projectId: ref.projectId,
        deploymentId: ref.id,
      });
      if (deployment === null) return null;
      if (
        !isPlainObject(deployment)
        || deployment.domainId !== ref.domainId
        || deployment.projectId !== ref.projectId
        || deployment.id !== ref.id
        || typeof deployment.status !== "string"
      ) {
        throw new Error("Deployment state is malformed.");
      }
      return {
        id: deployment.id,
        domainId: ref.domainId,
        projectId: ref.projectId,
        ownerId: deployment.requesterSubject,
        assigneeIds: [...project.memberSubjects],
        lifecycleState: deployment.status === "REQUESTED"
          ? "PENDING_APPROVAL"
          : deployment.status,
      };
    },
    async resolveApproval({ approvalRef, principal }) {
      const ref = parseApprovalRef(approvalRef);
      const approval = await workspaceState.getApproval({
        domainId: ref.domainId,
        approvalId: ref.id,
      });
      if (approval === null) return null;
      if (
        !isPlainObject(approval)
        || approval.domainId !== ref.domainId
        || approval.id !== ref.id
        || approval.kind !== "PRODUCTION_DEPLOYMENT"
        || approval.resourceType !== "DEPLOYMENT"
        || !["PENDING", "APPROVED", "REJECTED"].includes(
          approval.status,
        )
        || (
          approval.status !== "PENDING"
          && approval.approverSubject !== principal.id
        )
      ) {
        throw new Error("Deployment approval state is malformed.");
      }
      return {
        requesterId: approval.requesterSubject,
        resourceId: approval.resourceId,
        action: "deployment:approve",
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

export function createDeploymentRuntime({
  workspaceState,
  modelPolicyState,
  domainDirectory,
  runtimeControl,
  identityVerifier,
  clock,
} = {}) {
  if (
    !workspaceState
    || ![
      "beginTransaction",
      "getProject",
      "getAgent",
      "getDeployment",
      "getApproval",
      "getResourceGrant",
      "listBreakGlass",
      "putAgent",
      "putDeployment",
      "putApproval",
    ].every((method) => typeof workspaceState[method] === "function")
    || !modelPolicyState
    || typeof modelPolicyState.getModelPolicy !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || !runtimeControl
    || typeof runtimeControl.resolveEndpoint !== "function"
    || typeof identityVerifier !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError("Deployment runtime configuration is invalid.");
  }
  return createDeploymentHandler({
    identityProjector: authenticatedProjector(),
    identityVerifier,
    domainDirectory,
    deploymentService: createDeploymentService({
      workspaceState,
      authorizer: createDeploymentAuthorizer({ workspaceState, clock }),
      runtimeControl,
      modelAccessResolver: createModelAccessResolver({
        modelPolicyState,
        workspaceState,
      }),
    }),
  });
}

function configuredHandler() {
  if (productionHandler) return productionHandler;
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const runtimeId = process.env.AGENT_RUNTIME_ID;
  const sandboxEndpointName = process.env.SANDBOX_ENDPOINT_NAME;
  const productionEndpointName = process.env.PRODUCTION_ENDPOINT_NAME;
  if (
    typeof tableName !== "string"
    || !tableName.trim()
    || typeof runtimeId !== "string"
    || !runtimeId.trim()
    || typeof sandboxEndpointName !== "string"
    || !sandboxEndpointName.trim()
    || typeof productionEndpointName !== "string"
    || !productionEndpointName.trim()
  ) {
    throw new Error("Deployment runtime configuration is unavailable.");
  }
  const clock = () => new Date();
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
  const runtimeControl = new AgentCoreRuntimeControl({
    client: new BedrockAgentCoreControlClient({}),
    runtimeId: runtimeId.trim(),
    sandboxEndpointName: sandboxEndpointName.trim(),
    productionEndpointName: productionEndpointName.trim(),
  });
  productionHandler = createDeploymentRuntime({
    workspaceState,
    modelPolicyState,
    runtimeControl,
    identityVerifier: verifyCurrentDemoOperator,
    clock,
    domainDirectory: createActiveDomainDirectory(domainState),
  });
  return productionHandler;
}

export async function handler(event, context) {
  return configuredHandler()(event, context);
}
