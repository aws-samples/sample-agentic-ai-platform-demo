import {
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  ACTION_CONTRACTS,
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
  createAccessAdminCognitoDirectory,
} from "./cognito-directory.mjs";
import {
  createAccessAdminHandler,
} from "./index.mjs";
import {
  createAccessAdminService,
} from "./service.mjs";

const ACCESS_ACTIONS = Object.freeze([
  "access.domain-members.read",
  "access.domain-members.grant",
  "access.domain-members.revoke",
  "access.project-members.read",
  "access.project-members.grant",
  "access.project-members.revoke",
]);
const PROJECT_MEMBERSHIP_METHODS = Object.freeze([
  "listProjects",
  "getProject",
  "listProjectMemberSubjects",
  "addProjectMember",
  "removeProjectMember",
]);
const GROUP_DIRECTORY_METHODS = Object.freeze([
  "listDomainMembers",
  "getUser",
  "getUserBySubject",
  "isDomainMember",
  "addDomainMember",
  "removeDomainMember",
]);
const ACCESS_REPLAY_RULES = Object.freeze({
  "POST /api/access/domain-memberships": Object.freeze({
    grant: Object.freeze({
      operation: "CREATE",
      projectScoped: false,
      status: "ACTIVE",
    }),
  }),
  "POST /api/access/domain-membership-revocations": Object.freeze({
    revoke: Object.freeze({
      operation: "DELETE",
      projectScoped: false,
      status: "REVOKED",
    }),
  }),
  "POST /api/access/project-memberships": Object.freeze({
    grant: Object.freeze({
      operation: "UPDATE",
      projectScoped: true,
      status: "ACTIVE",
    }),
  }),
  "POST /api/access/project-membership-revocations": Object.freeze({
    revoke: Object.freeze({
      operation: "UPDATE",
      projectScoped: true,
      status: "REVOKED",
    }),
  }),
});
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_RESOURCE_REF_BYTES = 8 * 1024;

let productionHandler;

export class AccessAdminWorkspaceCompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessAdminWorkspaceCompatibilityError";
    this.code = "ACCESS_ADMIN_WORKSPACE_INCOMPATIBLE";
  }
}

function compatibilityError(message) {
  return new AccessAdminWorkspaceCompatibilityError(message);
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validText(value, maximum = 1024) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseResourceRef(value) {
  if (typeof value !== "string" || !value.startsWith("access:")) {
    throw new Error("Access authorization reference is invalid.");
  }
  const encoded = value.slice("access:".length);
  let resource;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (
      encoded.length === 0
      || bytes.byteLength > MAX_RESOURCE_REF_BYTES
      || bytes.toString("base64url") !== encoded
    ) {
      throw new Error();
    }
    resource = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("Access authorization reference is invalid.");
  }
  if (
    !isPlainObject(resource)
    || resource.v !== 1
    || !validText(resource.id, 512)
    || !DOMAIN_PATTERN.test(resource.domainId)
    || !validText(resource.lifecycleState, 64)
    || (
      Object.hasOwn(resource, "projectId")
      && !SLUG_PATTERN.test(resource.projectId)
    )
    || (
      Object.hasOwn(resource, "ownerId")
      && !SUBJECT_PATTERN.test(resource.ownerId)
    )
    || (
      Object.hasOwn(resource, "assigneeIds")
      && (
        !Array.isArray(resource.assigneeIds)
        || resource.assigneeIds.length > 100
        || resource.assigneeIds.some(
          (subject) => !SUBJECT_PATTERN.test(subject),
        )
        || new Set(resource.assigneeIds).size
          !== resource.assigneeIds.length
      )
    )
  ) {
    throw new Error("Access authorization reference is invalid.");
  }
  return Object.freeze({
    id: resource.id,
    domainId: resource.domainId,
    lifecycleState: resource.lifecycleState,
    ...(Object.hasOwn(resource, "projectId")
      ? { projectId: resource.projectId }
      : {}),
    ...(Object.hasOwn(resource, "ownerId")
      ? { ownerId: resource.ownerId }
      : {}),
    ...(Object.hasOwn(resource, "assigneeIds")
      ? { assigneeIds: Object.freeze([...resource.assigneeIds]) }
      : {}),
  });
}

function numericClock(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Access administration clock is invalid.");
  }
  return timestamp;
}

export function createAccessAdminRequestClock({
  now = () => new Date(),
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError(
      "Access administration request clock is invalid.",
    );
  }
  let activeTimestamp = null;

  function currentTimestamp() {
    if (activeTimestamp === null) {
      throw new Error(
        "Access administration clock was read outside an active request.",
      );
    }
    return activeTimestamp;
  }

  return Object.freeze({
    async run(work) {
      if (typeof work !== "function" || activeTimestamp !== null) {
        throw new Error(
          "Access administration request clock is already active.",
        );
      }
      const value = now();
      const timestamp = (
        value instanceof Date ? value : new Date(value)
      ).getTime();
      if (!Number.isFinite(timestamp)) {
        throw new Error(
          "Access administration request clock is invalid.",
        );
      }
      activeTimestamp = timestamp;
      try {
        return await work();
      } finally {
        activeTimestamp = null;
      }
    },
    date() {
      return new Date(currentTimestamp());
    },
    milliseconds() {
      return currentTimestamp();
    },
  });
}

export function createAccessAdminAuthorizer({
  workspaceState,
  clock,
} = {}) {
  if (
    !workspaceState
    || typeof workspaceState.listBreakGlass !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError(
      "Access administration authorizer configuration is invalid.",
    );
  }
  const missing = ACCESS_ACTIONS.filter(
    (action) => !Object.hasOwn(ACTION_CONTRACTS, action),
  );
  if (missing.length > 0) {
    throw compatibilityError(
      "Canonical access administration action contracts are unavailable.",
    );
  }
  return createAuthorizer({
    async resolvePrincipal({ requestContext, resourceRef }) {
      const resource = parseResourceRef(resourceRef);
      if (
        !isPlainObject(requestContext)
        || requestContext.source !== "access-admin-service"
        || !SUBJECT_PATTERN.test(requestContext.subject)
        || !["admin", "lead"].includes(requestContext.role)
        || !Array.isArray(requestContext.domainIds)
        || requestContext.domainIds.length > 100
        || requestContext.domainIds.some(
          (domainId) => !DOMAIN_PATTERN.test(domainId),
        )
      ) {
        throw new Error(
          "Access administration authorization context is invalid.",
        );
      }
      return {
        id: requestContext.subject,
        role: requestContext.role,
        domainIds: [...requestContext.domainIds],
        projectIds: resource.projectId === undefined
          ? []
          : [resource.projectId],
      };
    },
    async resolveResource({ resourceRef }) {
      return parseResourceRef(resourceRef);
    },
    async resolvePolicy({ resourceRef }) {
      parseResourceRef(resourceRef);
      return { allowed: true };
    },
    resolveBreakGlass: createWorkspaceBreakGlassResolver({
      workspaceState,
    }),
    clock: () => numericClock(clock),
  });
}

export function createAccessAdminAuditAdapter({
  workspaceState,
} = {}) {
  if (
    !workspaceState
    || typeof workspaceState.appendAudit !== "function"
  ) {
    throw new TypeError(
      "Access administration audit state is invalid.",
    );
  }
  return Object.freeze({
    async append({ record, completion }) {
      await workspaceState.appendAudit({
        record,
        mutation: {
          actor: completion.actor,
          requesterSubject: completion.requesterSubject,
          effectiveRole: completion.effectiveRole,
          domainId: completion.domainId,
          projectId: completion.projectId,
          route: completion.route,
          requestId: completion.requestId,
          payloadFingerprint: completion.payloadFingerprint,
          result: {
            entityType: "WORKSPACE_AUDIT",
            resourceKey:
              `audit/${record.resource}/${record.timestamp}/`
              + record.requestId,
            operation: "APPEND",
            status: "SUCCEEDED",
            accessAdmin: {
              username: completion.result.username,
              subject: completion.result.subject,
              membershipStatus: completion.result.status,
              changed: completion.result.changed,
            },
          },
          decision: completion.decision,
          reason: completion.reason,
          timestamp: record.timestamp,
          createdAt: record.timestamp,
        },
      });
      return true;
    },
  });
}

function replayComplete(value) {
  return (
    isPlainObject(value)
    && isPlainObject(value.result)
    && isPlainObject(value.result.accessAdmin)
    && typeof value.result.resourceKey === "string"
    && typeof value.result.operation === "string"
    && typeof value.result.accessAdmin.username === "string"
    && typeof value.result.accessAdmin.subject === "string"
    && typeof value.result.accessAdmin.membershipStatus === "string"
    && typeof value.result.accessAdmin.changed === "boolean"
  );
}

function accessAdminResourceKey(value) {
  const subject = value.result.accessAdmin.subject;
  return value.projectId === null
    ? `domain-membership/${value.domainId}/${subject}`
    : `project-membership/${value.domainId}/${value.projectId}/${subject}`;
}

function accessAdminReplayRule(value) {
  const routeRules = ACCESS_REPLAY_RULES[value.route];
  if (routeRules === undefined) {
    throw compatibilityError(
      "Access administration replay route is not recognized.",
    );
  }
  const rule = routeRules[value.decision];
  if (rule === undefined) {
    throw compatibilityError(
      "Access administration replay decision is not recognized.",
    );
  }
  if (
    (rule.projectScoped && value.projectId === null)
    || (!rule.projectScoped && value.projectId !== null)
    || value.result.accessAdmin.membershipStatus !== rule.status
  ) {
    throw compatibilityError(
      "Workspace mutation results are not safely bound for "
      + "access administration.",
    );
  }
  return rule;
}

function accessAdminReplayResult(value) {
  const accessAdmin = value.result.accessAdmin;
  const rule = accessAdminReplayRule(value);
  return Object.freeze({
    actor: value.actor,
    requesterSubject: accessAdmin.subject,
    effectiveRole: value.effectiveRole,
    domainId: value.domainId,
    projectId: value.projectId,
    route: value.route,
    requestId: value.requestId,
    payloadFingerprint: value.payloadFingerprint,
    resourceKey: accessAdminResourceKey(value),
    operation: rule.operation,
    decision: value.decision,
    reason: value.reason,
    username: accessAdmin.username,
    status: accessAdmin.membershipStatus,
    result: Object.freeze({
      domainId: value.domainId,
      ...(value.projectId === null ? {} : { projectId: value.projectId }),
      username: accessAdmin.username,
      subject: accessAdmin.subject,
      status: accessAdmin.membershipStatus,
      changed: accessAdmin.changed,
    }),
  });
}

function replayBindingsMatch(value) {
  return (
    value.requesterSubject === value.result.accessAdmin.subject
    && value.result.status === "SUCCEEDED"
    && value.result.entityType === "WORKSPACE_AUDIT"
    && value.result.resourceKey
      === `audit/${accessAdminResourceKey(value)}/${value.timestamp}/`
        + value.requestId
  );
}

export function createAccessAdminIdempotencyAdapter({
  workspaceState,
} = {}) {
  if (
    !workspaceState
    || typeof workspaceState.getMutationResult !== "function"
    || typeof workspaceState.claimMutation !== "function"
  ) {
    throw new TypeError(
      "Access administration idempotency state is invalid.",
    );
  }
  return Object.freeze({
    async getResult(input) {
      const result = await workspaceState.getMutationResult(input);
      if (result === null) return null;
      if (!replayComplete(result)) {
        throw compatibilityError(
          "Workspace mutation results are not replay-complete for "
          + "access administration.",
        );
      }
      if (!replayBindingsMatch(result)) {
        throw compatibilityError(
          "Workspace mutation results are not safely bound for "
          + "access administration.",
        );
      }
      return accessAdminReplayResult(result);
    },
    async claim(input) {
      try {
        return await workspaceState.claimMutation({
          actor: input.actor,
          requesterSubject: input.requesterSubject,
          effectiveRole: input.effectiveRole,
          domainId: input.domainId,
          projectId: input.projectId,
          route: input.route,
          requestId: input.requestId,
          payloadFingerprint: input.payloadFingerprint,
          resourceKey: input.resourceKey,
          operation: input.operation === "DELETE"
            ? "UPDATE"
            : input.operation,
        });
      } catch (error) {
        if (error?.code === "MUTATION_IN_PROGRESS") {
          return Object.freeze({ ...input });
        }
        throw error;
      }
    },
  });
}

export function createWorkspaceProjectMembershipAdapter(
  workspaceState,
) {
  if (
    !workspaceState
    || PROJECT_MEMBERSHIP_METHODS.some(
      (method) => typeof workspaceState[method] !== "function",
    )
  ) {
    throw compatibilityError(
      "Workspace state does not expose concurrency-safe project "
      + "membership methods.",
    );
  }
  return Object.freeze(
    Object.fromEntries(
      PROJECT_MEMBERSHIP_METHODS.map(
        (method) => [
          method,
          workspaceState[method].bind(workspaceState),
        ],
      ),
    ),
  );
}

export function createAccessAdminRuntime({
  workspaceState,
  domainDirectory,
  groupDirectory,
  projectMemberships,
  identityVerifier,
  clock,
  authorizer,
  audit,
  idempotency,
} = {}) {
  if (
    !domainDirectory
    || typeof domainDirectory.getDomain !== "function"
    || typeof domainDirectory.listActiveDomains !== "function"
    || !groupDirectory
    || GROUP_DIRECTORY_METHODS.some(
      (method) => typeof groupDirectory[method] !== "function",
    )
    || !projectMemberships
    || PROJECT_MEMBERSHIP_METHODS.some(
      (method) => typeof projectMemberships[method] !== "function",
    )
    || typeof identityVerifier !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError(
      !projectMemberships
      || PROJECT_MEMBERSHIP_METHODS.some(
        (method) => typeof projectMemberships?.[method] !== "function",
      )
        ? "Project membership adapter is invalid."
        : "Access administration runtime configuration is invalid.",
    );
  }
  const resolvedAuthorizer = authorizer
    ?? createAccessAdminAuthorizer({ workspaceState, clock });
  const resolvedAudit = audit
    ?? createAccessAdminAuditAdapter({ workspaceState });
  const resolvedIdempotency = idempotency
    ?? createAccessAdminIdempotencyAdapter({ workspaceState });
  if (
    typeof resolvedAuthorizer !== "function"
    || !resolvedAudit
    || typeof resolvedAudit.append !== "function"
    || !resolvedIdempotency
    || typeof resolvedIdempotency.getResult !== "function"
    || typeof resolvedIdempotency.claim !== "function"
  ) {
    throw new TypeError(
      "Access administration runtime adapters are invalid.",
    );
  }
  const service = createAccessAdminService({
    domainDirectory,
    groupDirectory,
    projectMemberships,
    authorizer: resolvedAuthorizer,
    clock,
    audit: resolvedAudit,
    idempotency: resolvedIdempotency,
  });
  return createAccessAdminHandler({
    identityProjector: createProductionIdentityProjector(),
    identityVerifier,
    domainDirectory: {
      async listActiveDomains() {
        return (await domainDirectory.listActiveDomains())
          .map(({ id }) => ({ id }));
      },
    },
    accessAdminService: service,
  });
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
  ) {
    throw new Error(
      "Access administration runtime configuration is unavailable.",
    );
  }
  return value;
}

function configuredHandler() {
  if (productionHandler) return productionHandler;
  const tableName = requiredEnvironment("PLATFORM_STATE_TABLE_NAME");
  const userPoolId = requiredEnvironment("COGNITO_USER_POOL_ID");
  const requestClock = createAccessAdminRequestClock();
  const dynamo = new DynamoDBClient({});
  const workspaceState = createWorkspaceState({
    tableName,
    dynamo,
    now: requestClock.date,
  });
  const domainState = createPlatformState({
    tableName,
    dynamo,
    now: requestClock.date,
  });
  const runtime = createAccessAdminRuntime({
    workspaceState,
    domainDirectory: createActiveDomainRecordDirectory(domainState),
    groupDirectory: createAccessAdminCognitoDirectory({
      client: new CognitoIdentityProviderClient({}),
      userPoolId,
    }),
    projectMemberships:
      createWorkspaceProjectMembershipAdapter(workspaceState),
    identityVerifier: verifyCurrentDemoOperator,
    clock: requestClock.milliseconds,
  });
  productionHandler = (event, context) =>
    requestClock.run(() => runtime(event, context));
  return productionHandler;
}

export async function handler(event, context) {
  return configuredHandler()(event, context);
}
