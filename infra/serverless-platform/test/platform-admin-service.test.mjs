import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  CreateRegistryCommand,
  DeleteRegistryCommand,
  GetRegistryCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  ResourceNotFoundException,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  BatchGetDiscoverableRegistryRecordCommand,
} from "@aws-sdk/client-agent-registry";
import {
  createRegistryInventoryService,
} from "../lambda/control-plane/service.mjs";
import {
  createRegistryDecisionFinalizer,
} from "../lambda/platform-admin/finalizer.mjs";
import {
  createPlatformState,
} from "../lambda/platform-admin/state.mjs";

const NOW = "2026-08-23T01:02:03.000Z";
const REGION = "us-west-2";
const ACCOUNT = "111122223333";
const ROUTE = "POST /api/domain-create";
const TAGS = {
  "auto-delete": "no",
  project: "agentic-ai-platform-demo",
  managedBy: "cdk",
};
const HOSTED_ACCEPTANCE_TAGS = {
  ...TAGS,
  managedBy: "hosted-acceptance",
};
const REGISTRY_ID = "FinanceReg1234";
const REGISTRY_ARN =
  `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/${REGISTRY_ID}`;
const NOW_EPOCH = Math.floor(Date.parse(NOW) / 1000);
const CLAIM_TTL_SECONDS = 300;
const CLEANUP_LEASE_SECONDS = 90;
const CLEANUP_EXECUTION_TOKEN =
  "11111111-1111-4111-8111-111111111111";
const DECIDE_ROUTE = "POST /api/registry-decide";
const DECISION_KIND = "REGISTRY_DECISION";
const ENTRY_ID = "customer-support-blueprint";
const SEMVER = "1.0.0";
const AUTHORITATIVE_REGISTRY_ID = "SharedReg12345";
const AUTHORITATIVE_RECORD_ID = "Rec123456789";
const APPROVE_REASON = "Approved by platform administrator.";
const APPROVE_REASON_HASH = createHash("sha256")
  .update(APPROVE_REASON)
  .digest("hex");
const FINANCE_REGISTRY_CLIENT_TOKEN = createHash("sha256")
  .update("admin-sub-123\nrequest-123\nfinance")
  .digest("hex");
const FINANCE_GROUP_OPERATION_TOKEN = createHash("sha256")
  .update(`cognito-domain-group:v2\n${FINANCE_REGISTRY_CLIENT_TOKEN}`)
  .digest("hex");
const OPERATIONS_GROUP_OPERATION_TOKEN = createHash("sha256")
  .update(
    "cognito-domain-group:v2\n"
      + createHash("sha256")
        .update("admin-sub-123\nrequest-123\noperations")
        .digest("hex"),
  )
  .digest("hex");
const OTHER_REQUEST_FINANCE_GROUP_OPERATION_TOKEN = createHash("sha256")
  .update(
    "cognito-domain-group:v2\n"
      + createHash("sha256")
        .update("admin-sub-123\nrequest-456\nfinance")
        .digest("hex"),
  )
  .digest("hex");

async function loadServiceModule() {
  return import("../lambda/platform-admin/service.mjs");
}

function adminScope(overrides = {}) {
  return {
    actor: "admin-sub-123",
    username: "platform-admin",
    requestId: "request-123",
    role: "admin",
    allowedDomains: ["platform"],
    capabilities: ["approveRegistryVersion"],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    name: "Finance",
    ...overrides,
  };
}

function requestResult(result, overrides = {}) {
  return {
    actor: "admin-sub-123",
    route: ROUTE,
    requestId: "request-123",
    result,
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
    ...overrides,
  };
}

function successResult(overrides = {}) {
  return {
    ok: true,
    domain: {
      id: "finance",
      name: "Finance",
      owner: "Finance domain team",
      ownerGroup: "domain-finance",
      description: "Finance domain agents.",
      tokenBudget: null,
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: "ACTIVE",
      createdBy: "admin-sub-123",
      createdAt: NOW,
      ...overrides,
    },
  };
}

function normalizedPayload(overrides = {}) {
  return {
    id: "finance",
    name: "Finance",
    owner: "Finance domain team",
    ownerGroup: "domain-finance",
    description: "Finance domain agents.",
    tokenBudget: null,
    ...overrides,
  };
}

function fingerprint(payload = normalizedPayload()) {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function storedSuccess(domain = successResult().domain, overrides = {}) {
  return {
    kind: "DOMAIN_CREATE",
    status: "SUCCEEDED",
    payloadFingerprint: fingerprint({
      id: domain.id,
      name: domain.name,
      owner: domain.owner,
      ownerGroup: domain.ownerGroup,
      description: domain.description,
      tokenBudget: domain.tokenBudget,
    }),
    domain,
    ...overrides,
  };
}

function storedClaim(status, overrides = {}) {
  return {
    kind: "DOMAIN_CREATE",
    status,
    payloadFingerprint: fingerprint(),
    ...(status === "IN_PROGRESS"
      ? {
          ownerToken: "owner-token",
          claimExpiresAt: NOW_EPOCH + CLAIM_TTL_SECONDS,
        }
      : {}),
    ...overrides,
  };
}

function storedFinalConflict(overrides = {}) {
  return {
    kind: "DOMAIN_CREATE",
    status: "FAILED_FINAL",
    payloadFingerprint: fingerprint(),
    code: "DOMAIN_CONFLICT",
    cleanup: {
      status: "COMPLETE",
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
    },
    ...overrides,
  };
}

function storedPendingConflict(overrides = {}) {
  return storedFinalConflict({
    cleanup: {
      status: "PENDING",
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
    },
    ...overrides,
  });
}

function storedPendingProvisioningCleanup(overrides = {}) {
  return storedPendingConflict({
    code: "DOMAIN_PROVISIONING_FAILED",
    ...overrides,
  });
}

function storedPendingCommitCleanup(overrides = {}) {
  return storedPendingConflict({
    code: "DOMAIN_COMMIT_FAILED",
    cleanup: ownedCleanup(),
    ...overrides,
  });
}

function ownedCleanup(status = "PENDING", overrides = {}) {
  return {
    status,
    registryId: REGISTRY_ID,
    registryArn: REGISTRY_ARN,
    ownerGroup: {
      name: "domain-finance",
      operationToken: FINANCE_GROUP_OPERATION_TOKEN,
    },
    ...overrides,
  };
}

function cleaningOwnedCleanup(overrides = {}) {
  return ownedCleanup("CLEANING", {
    cleanupExecutionToken: CLEANUP_EXECUTION_TOKEN,
    cleanupClaimExpiresAt: NOW_EPOCH + CLEANUP_LEASE_SECONDS,
    ...overrides,
  });
}

function permanentRequestResult(result, overrides = {}) {
  return {
    actor: "admin-sub-123",
    route: ROUTE,
    requestId: "request-123",
    result,
    createdAt: NOW,
    ...overrides,
  };
}

function nativeResultValue(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "boolean") return { BOOL: value };
  if (typeof value === "number") return { N: String(value) };
  if (Array.isArray(value)) {
    return { L: value.map(nativeResultValue) };
  }
  return {
    M: Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        nativeResultValue(child),
      ]),
    ),
  };
}

function permanentDomainRequestItem(result) {
  return {
    pk: { S: "REQUEST#admin-sub-123" },
    sk: { S: `REQUEST#${ROUTE}#request-123` },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: "admin-sub-123" },
    route: { S: ROUTE },
    requestId: { S: "request-123" },
    result: nativeResultValue(result),
    createdAt: { S: NOW },
  };
}

function createHarness({
  existingDomain = null,
  priorRequestResult = null,
  registryResponse = { registryArn: REGISTRY_ARN },
} = {}) {
  const calls = [];
  const domains = [];
  const results = [];
  let storedDomain = existingDomain;
  let storedRequest = priorRequestResult;
  const state = {
    async getRequestResult(identity) {
      calls.push(["getRequestResult", structuredClone(identity)]);
      return storedRequest === null ? null : structuredClone(storedRequest);
    },
    async getDomain(id) {
      calls.push(["getDomain", id]);
      return storedDomain === null ? null : structuredClone(storedDomain);
    },
    async claimDomainRequest(claim) {
      calls.push(["claimDomainRequest", structuredClone(claim)]);
      const current = storedRequest?.result;
      const claimable =
        storedRequest === null
        || storedRequest.expiresAt <= NOW_EPOCH
        || (
          current?.kind === "DOMAIN_CREATE"
          && current.payloadFingerprint === claim.payloadFingerprint
          && (
            current.status === "FAILED_RETRYABLE"
            || (
              current.status === "IN_PROGRESS"
              && current.claimExpiresAt <= NOW_EPOCH
            )
          )
        );
      if (!claimable) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = requestResult({
        kind: "DOMAIN_CREATE",
        status: "IN_PROGRESS",
        payloadFingerprint: claim.payloadFingerprint,
        ownerToken: claim.ownerToken,
        claimExpiresAt: claim.claimExpiresAt,
        ...(claim.registry === undefined
          ? {}
          : { registry: structuredClone(claim.registry) }),
      }, {
        actor: claim.actor,
        route: claim.route,
        requestId: claim.requestId,
        expiresAt: claim.expiresAt,
        createdAt: claim.createdAt,
      });
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async markDomainRequestRetryable(claim) {
      calls.push([
        "markDomainRequestRetryable",
        structuredClone(claim),
      ]);
      const current = storedRequest?.result;
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "IN_PROGRESS"
        || current.payloadFingerprint !== claim.payloadFingerprint
        || current.ownerToken !== claim.ownerToken
      ) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = requestResult({
        kind: "DOMAIN_CREATE",
        status: "FAILED_RETRYABLE",
        payloadFingerprint: claim.payloadFingerprint,
        ...(claim.registry === undefined
          ? {}
          : { registry: structuredClone(claim.registry) }),
      }, {
        actor: claim.actor,
        route: claim.route,
        requestId: claim.requestId,
        expiresAt: claim.expiresAt,
        createdAt: claim.createdAt,
      });
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async markDomainRequestConflict(claim) {
      calls.push([
        "markDomainRequestConflict",
        structuredClone(claim),
      ]);
      const current = storedRequest?.result;
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "IN_PROGRESS"
        || current.payloadFingerprint !== claim.payloadFingerprint
        || current.ownerToken !== claim.ownerToken
      ) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = permanentRequestResult(storedPendingConflict({
        cleanup: {
          status: "PENDING",
          ...structuredClone(claim.cleanup),
        },
      }), {
        actor: claim.actor,
        route: claim.route,
        requestId: claim.requestId,
        createdAt: claim.createdAt,
      });
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async markDomainRequestProvisioningCleanupPending(claim) {
      calls.push([
        "markDomainRequestProvisioningCleanupPending",
        structuredClone(claim),
      ]);
      const current = storedRequest?.result;
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "IN_PROGRESS"
        || current.payloadFingerprint !== claim.payloadFingerprint
        || current.ownerToken !== claim.ownerToken
      ) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = permanentRequestResult(
        storedPendingProvisioningCleanup({
          cleanup: {
            status: "PENDING",
            ...structuredClone(claim.cleanup),
          },
        }),
        {
          actor: claim.actor,
          route: claim.route,
          requestId: claim.requestId,
          createdAt: claim.createdAt,
        },
      );
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async markDomainRequestCommitCleanupPending(claim) {
      calls.push([
        "markDomainRequestCommitCleanupPending",
        structuredClone(claim),
      ]);
      const current = storedRequest?.result;
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "IN_PROGRESS"
        || current.payloadFingerprint !== claim.payloadFingerprint
        || current.ownerToken !== claim.ownerToken
      ) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = permanentRequestResult(
        storedPendingCommitCleanup({
          cleanup: {
            status: "PENDING",
            ...structuredClone(claim.cleanup),
          },
        }),
        {
          actor: claim.actor,
          route: claim.route,
          requestId: claim.requestId,
          createdAt: claim.createdAt,
        },
      );
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async claimDomainRequestCleanup(transition) {
      calls.push([
        "claimDomainRequestCleanup",
        structuredClone(transition),
      ]);
      const current = storedRequest?.result;
      const cleanup = current?.cleanup;
      const claimable =
        cleanup?.status === "PENDING"
        || (
          cleanup?.status === "CLEANING"
          && cleanup.cleanupClaimExpiresAt <= NOW_EPOCH
        );
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "FAILED_FINAL"
        || current.payloadFingerprint !== transition.payloadFingerprint
        || current.code !== transition.reason
        || !claimable
        || !isDeepStrictEqual(cleanup, transition.cleanup)
        || storedRequest.actor !== transition.actor
        || storedRequest.route !== transition.route
        || storedRequest.requestId !== transition.requestId
        || storedRequest.createdAt !== transition.createdAt
        || Object.hasOwn(storedRequest, "expiresAt")
      ) {
        throw Object.assign(new Error("cleanup conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = permanentRequestResult({
        ...current,
        cleanup: {
          status: "CLEANING",
          registryId: cleanup.registryId,
          registryArn: cleanup.registryArn,
          ...(cleanup.ownerGroup === undefined
            ? {}
            : { ownerGroup: structuredClone(cleanup.ownerGroup) }),
          cleanupExecutionToken: transition.cleanupExecutionToken,
          cleanupClaimExpiresAt: NOW_EPOCH + CLEANUP_LEASE_SECONDS,
        },
      }, {
        actor: transition.actor,
        route: transition.route,
        requestId: transition.requestId,
        createdAt: transition.createdAt,
      });
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async releaseDomainRequestCleanup(transition) {
      calls.push([
        "releaseDomainRequestCleanup",
        structuredClone(transition),
      ]);
      const current = storedRequest?.result;
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "FAILED_FINAL"
        || current.payloadFingerprint !== transition.payloadFingerprint
        || current.code !== transition.reason
        || !isDeepStrictEqual(current.cleanup, transition.cleanup)
      ) {
        throw Object.assign(new Error("cleanup conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = permanentRequestResult({
        ...current,
        cleanup: {
          status: "PENDING",
          registryId: transition.cleanup.registryId,
          registryArn: transition.cleanup.registryArn,
          ...(transition.cleanup.ownerGroup === undefined
            ? {}
            : {
                ownerGroup: structuredClone(
                  transition.cleanup.ownerGroup,
                ),
              }),
        },
      }, {
        actor: transition.actor,
        route: transition.route,
        requestId: transition.requestId,
        createdAt: transition.createdAt,
      });
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async markDomainRequestCleanupComplete(transition) {
      calls.push([
        "markDomainRequestCleanupComplete",
        structuredClone(transition),
      ]);
      const current = storedRequest?.result;
      const reason = transition.reason ?? "DOMAIN_CONFLICT";
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "FAILED_FINAL"
        || current.payloadFingerprint !== transition.payloadFingerprint
        || current.code !== reason
        || !isDeepStrictEqual(current.cleanup, transition.cleanup)
        || current.cleanup.status !== "CLEANING"
        || storedRequest.actor !== transition.actor
        || storedRequest.route !== transition.route
        || storedRequest.requestId !== transition.requestId
        || storedRequest.createdAt !== transition.createdAt
        || Object.hasOwn(storedRequest, "expiresAt")
      ) {
        throw Object.assign(new Error("cleanup conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      storedRequest = reason === "DOMAIN_CONFLICT"
        ? requestResult(storedFinalConflict({
            payloadFingerprint: transition.payloadFingerprint,
            cleanup: {
              status: "COMPLETE",
              registryId: transition.cleanup.registryId,
              registryArn: transition.cleanup.registryArn,
              ...(transition.cleanup.ownerGroup === undefined
                ? {}
                : {
                    ownerGroup: structuredClone(
                      transition.cleanup.ownerGroup,
                    ),
                  }),
            },
          }), {
            actor: transition.actor,
            route: transition.route,
            requestId: transition.requestId,
            expiresAt: transition.expiresAt,
            createdAt: transition.createdAt,
          })
        : requestResult(storedClaim("FAILED_RETRYABLE", {
            payloadFingerprint: transition.payloadFingerprint,
          }), {
            actor: transition.actor,
            route: transition.route,
            requestId: transition.requestId,
            expiresAt: transition.expiresAt,
            createdAt: transition.createdAt,
          });
      results.push(structuredClone(storedRequest));
      return structuredClone(storedRequest);
    },
    async putDomainWithRequestResult(value) {
      calls.push([
        "putDomainWithRequestResult",
        structuredClone(value),
      ]);
      const current = storedRequest?.result;
      if (
        current?.kind !== "DOMAIN_CREATE"
        || current.status !== "IN_PROGRESS"
        || current.payloadFingerprint !== value.claim.payloadFingerprint
        || current.ownerToken !== value.claim.ownerToken
      ) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      if (storedDomain !== null) {
        throw Object.assign(new Error("domain exists"), {
          code: "DOMAIN_CONFLICT",
        });
      }
      storedDomain = structuredClone(value.domain);
      storedRequest = structuredClone(value.requestResult);
      domains.push(structuredClone(value.domain));
      results.push(structuredClone(value.requestResult));
      return structuredClone(value);
    },
    async listDomains() {
      calls.push(["listDomains"]);
      return domains.map(structuredClone);
    },
  };
  const registry = {
    async send(command) {
      calls.push(["registry", command]);
      if (registryResponse instanceof Error) throw registryResponse;
      if (command instanceof GetRegistryCommand) {
        const registryArn = registryResponse?.registryArn ?? REGISTRY_ARN;
        return {
          registryId: registryArn.split("/").at(-1),
          registryArn,
          status: "READY",
        };
      }
      return registryResponse;
    },
  };
  const domainDirectory = {
    async ensureGroup(ownerGroup, operationToken) {
      calls.push([
        "domainDirectory.ensureGroup",
        ownerGroup,
        operationToken,
      ]);
      return { ownerGroup, operationToken };
    },
    async deleteGroupExact(ownerGroup, operationToken) {
      calls.push([
        "domainDirectory.deleteGroupExact",
        ownerGroup,
        operationToken,
      ]);
      return { ownerGroup, operationToken };
    },
  };
  return {
    calls,
    domainDirectory,
    domains,
    registry,
    results,
    state,
    storedRequest: () =>
      storedRequest === null ? null : structuredClone(storedRequest),
  };
}

async function serviceFor(harness, overrides = {}) {
  const { createPlatformAdminService } = await loadServiceModule();
  return createPlatformAdminService({
    state: harness.state,
    registry: harness.registry,
    domainDirectory: harness.domainDirectory ?? {
      async ensureGroup() {},
      async deleteGroupExact() {},
    },
    region: REGION,
    account: ACCOUNT,
    tags: TAGS,
    now: () => new Date(NOW),
    registryInventory: {
      async registryOnly() {
        return {
          ok: true,
          entries: [],
          source: "aws",
        };
      },
    },
    ...overrides,
  });
}

function decisionInput(overrides = {}) {
  return {
    id: ENTRY_ID,
    semver: SEMVER,
    decision: "approve",
    reason: "",
    ...overrides,
  };
}

function authoritativeInventory({
  domain = "platform",
  type = "Blueprint",
  status = "IN_REVIEW",
  awsStatus = status === "IN_REVIEW" ? "PENDING_APPROVAL" : status,
  registryId = AUTHORITATIVE_REGISTRY_ID,
  recordId = AUTHORITATIVE_RECORD_ID,
  semver = SEMVER,
  source = type === "Model" ? "gateway" : "agentcore-registry",
} = {}) {
  return {
    ok: true,
    entries: [{
      id: ENTRY_ID,
      type,
      name: "Customer Support Blueprint",
      domain,
      versions: [{
        semver,
        status,
        statusReason: null,
        _aws: {
          registryId,
          recordId,
          awsStatus,
        },
      }],
      _source: source,
    }],
    source: "aws",
  };
}

function authoritativeRecord(status, statusReason) {
  return {
    registryId: AUTHORITATIVE_REGISTRY_ID,
    registryArn:
      `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
      + `registry/${AUTHORITATIVE_REGISTRY_ID}`,
    recordId: AUTHORITATIVE_RECORD_ID,
    recordArn:
      `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
      + `registry/${AUTHORITATIVE_REGISTRY_ID}`
      + `/record/${AUTHORITATIVE_RECORD_ID}`,
    recordVersion: SEMVER,
    status,
    statusReason,
  };
}

function decisionFingerprint(value = decisionInput({
  reason: APPROVE_REASON,
})) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function decisionRequestResult(result, overrides = {}) {
  return {
    actor: "admin-sub-123",
    route: DECIDE_ROUTE,
    requestId: "request-123",
    result,
    createdAt: NOW,
    ...overrides,
  };
}

function persistedDecisionTarget(overrides = {}) {
  return {
    registryId: AUTHORITATIVE_REGISTRY_ID,
    recordId: AUTHORITATIVE_RECORD_ID,
    semver: SEMVER,
    targetStatus: "APPROVED",
    statusReasonHash: APPROVE_REASON_HASH,
    ...overrides,
  };
}

function persistedDecisionPhase(phase, overrides = {}) {
  return decisionRequestResult({
    kind: DECISION_KIND,
    status: "IN_PROGRESS",
    phase,
    payloadFingerprint: decisionFingerprint(),
    ownerToken: "persisted-owner-token",
    claimExpiresAt: NOW_EPOCH + CLAIM_TTL_SECONDS,
    attemptCount: phase === "TARGET_BOUND" ? 0 : 1,
    retryAfter: phase === "RETRYABLE" ? NOW_EPOCH - 1 : 0,
    target: persistedDecisionTarget(),
    ...overrides,
  });
}

function registryDecisionHarness({
  inventory = authoritativeInventory(),
  priorRequestResult = null,
  reread = authoritativeRecord("APPROVED", APPROVE_REASON),
  updateResponse = {
    status: "REJECTED",
    statusReason: "Untrusted update response.",
  },
} = {}) {
  const calls = [];
  const audits = [];
  const requests = new Map();
  const resourceClaims = new Map();
  const requestKey = ({ actor, route, requestId }) =>
    `${actor}\n${route}\n${requestId}`;
  const resourceKey = ({ registryId, recordId, semver }) =>
    `${registryId}\n${recordId}\n${semver}`;
  const conflict = (code) => Object.assign(
    new Error(`${code.toLowerCase()} conflict`),
    { code },
  );
  const storedFor = (identity) => requests.get(requestKey(identity)) ?? null;
  const storeRequest = (request) => {
    requests.set(requestKey(request), structuredClone(request));
  };
  const requestFromClaim = (claim, phase) => ({
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
    result: {
      kind: claim.kind,
      status: "IN_PROGRESS",
      phase,
      payloadFingerprint: claim.payloadFingerprint,
      ownerToken: claim.ownerToken,
      claimExpiresAt: claim.claimExpiresAt,
      attemptCount: claim.attemptCount,
      retryAfter: claim.retryAfter,
      target: structuredClone(claim.target),
    },
    createdAt: claim.createdAt,
  });
  const resourceFromClaim = (claim, phase) => ({
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
    kind: claim.kind,
    payloadFingerprint: claim.payloadFingerprint,
    ownerToken: claim.ownerToken,
    target: structuredClone(claim.target),
    phase,
    attemptCount: claim.attemptCount,
    retryAfter: claim.retryAfter,
    createdAt: claim.createdAt,
  });
  const matchingOwnership = (current, claim, phase) =>
    current?.phase === phase
    && current.actor === claim.actor
    && current.route === claim.route
    && current.requestId === claim.requestId
    && current.kind === claim.kind
    && current.payloadFingerprint === claim.payloadFingerprint
    && current.ownerToken === claim.ownerToken
    && current.attemptCount === claim.attemptCount
    && current.retryAfter === claim.retryAfter
    && isDeepStrictEqual(current.target, claim.target);
  if (priorRequestResult !== null) {
    storeRequest(priorRequestResult);
    const result = priorRequestResult.result;
    if (
      result?.status === "IN_PROGRESS"
      && ["TARGET_BOUND", "MUTATION_ATTEMPTED", "RETRYABLE"].includes(
        result.phase,
      )
      && result.target
    ) {
      resourceClaims.set(
        resourceKey(result.target),
        resourceFromClaim({
          actor: priorRequestResult.actor,
          route: priorRequestResult.route,
          requestId: priorRequestResult.requestId,
          kind: result.kind,
          payloadFingerprint: result.payloadFingerprint,
          ownerToken: result.ownerToken,
          phase: result.phase,
          attemptCount: result.attemptCount,
          retryAfter: result.retryAfter,
          target: result.target,
          createdAt: priorRequestResult.createdAt,
        }, result.phase),
      );
    }
  }
  const state = {
    async getDomain() {
      throw new Error("Registry decisions must not read domain metadata.");
    },
    async listDomains() {
      return [];
    },
    async getRequestResult(identity) {
      calls.push(["getRequestResult", structuredClone(identity)]);
      const stored = storedFor(identity);
      return stored === null ? null : structuredClone(stored);
    },
    async claimDomainRequest() {
      throw new Error("Unexpected domain claim.");
    },
    async markDomainRequestRetryable() {
      throw new Error("Unexpected domain retry.");
    },
    async markDomainRequestConflict() {
      throw new Error("Unexpected domain conflict fence.");
    },
    async markDomainRequestProvisioningCleanupPending() {
      throw new Error("Unexpected domain provisioning cleanup fence.");
    },
    async markDomainRequestCommitCleanupPending() {
      throw new Error("Unexpected domain commit cleanup fence.");
    },
    async claimDomainRequestCleanup() {
      throw new Error("Unexpected domain cleanup claim.");
    },
    async releaseDomainRequestCleanup() {
      throw new Error("Unexpected domain cleanup release.");
    },
    async markDomainRequestCleanupComplete() {
      throw new Error("Unexpected domain cleanup completion.");
    },
    async putDomainWithRequestResult() {
      throw new Error("Unexpected domain transaction.");
    },
    async claimRequest(claim) {
      calls.push(["claimRequest", structuredClone(claim)]);
      const storedRequest = storedFor(claim);
      const current = storedRequest?.result;
      const claimable =
        storedRequest === null
        || storedRequest.expiresAt <= NOW_EPOCH
        || (
          current?.kind === claim.kind
          && current.payloadFingerprint === claim.payloadFingerprint
          && (
            current.status === "FAILED_RETRYABLE"
            || (
              current.status === "IN_PROGRESS"
              && current.claimExpiresAt <= NOW_EPOCH
            )
          )
        );
      if (!claimable) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      const request = {
        actor: claim.actor,
        route: claim.route,
        requestId: claim.requestId,
        result: {
          kind: claim.kind,
          status: "IN_PROGRESS",
          payloadFingerprint: claim.payloadFingerprint,
          ownerToken: claim.ownerToken,
          claimExpiresAt: claim.claimExpiresAt,
        },
        expiresAt: claim.expiresAt,
        createdAt: claim.createdAt,
      };
      storeRequest(request);
      return structuredClone(request);
    },
    async markRequestRetryable(claim) {
      calls.push(["markRequestRetryable", structuredClone(claim)]);
      const storedRequest = storedFor(claim);
      const current = storedRequest?.result;
      if (
        current?.kind !== claim.kind
        || current.status !== "IN_PROGRESS"
        || current.payloadFingerprint !== claim.payloadFingerprint
        || current.ownerToken !== claim.ownerToken
      ) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      const request = {
        actor: claim.actor,
        route: claim.route,
        requestId: claim.requestId,
        result: {
          kind: claim.kind,
          status: "FAILED_RETRYABLE",
          payloadFingerprint: claim.payloadFingerprint,
        },
        expiresAt: claim.expiresAt,
        createdAt: claim.createdAt,
      };
      storeRequest(request);
      return structuredClone(request);
    },
    async claimRegistryDecisionTarget(claim) {
      calls.push([
        "claimRegistryDecisionTarget",
        structuredClone(claim),
      ]);
      const current = storedFor(claim);
      if (current !== null) {
        throw conflict("REQUEST_CLAIM_CONFLICT");
      }
      const key = resourceKey(claim.target);
      if (resourceClaims.has(key)) {
        throw conflict("REGISTRY_RESOURCE_CONFLICT");
      }
      const request = requestFromClaim(claim, "TARGET_BOUND");
      storeRequest(request);
      resourceClaims.set(
        key,
        resourceFromClaim(claim, "TARGET_BOUND"),
      );
      return structuredClone(request);
    },
    async markRegistryDecisionMutationAttempted(claim) {
      calls.push([
        "markRegistryDecisionMutationAttempted",
        structuredClone(claim),
      ]);
      const request = storedFor(claim);
      const current = request?.result;
      if (
        current?.status !== "IN_PROGRESS"
        || !["TARGET_BOUND", "RETRYABLE"].includes(current.phase)
        || current.kind !== claim.kind
        || current.payloadFingerprint !== claim.payloadFingerprint
        || current.ownerToken !== claim.ownerToken
        || !isDeepStrictEqual(current.target, claim.target)
      ) {
        throw conflict("REQUEST_CLAIM_CONFLICT");
      }
      const key = resourceKey(claim.target);
      const resource = resourceClaims.get(key);
      if (!matchingOwnership(resource, claim, current.phase)) {
        throw conflict("REGISTRY_RESOURCE_CONFLICT");
      }
      const attemptedClaim = {
        ...claim,
        phase: "MUTATION_ATTEMPTED",
        attemptCount: claim.attemptCount + 1,
        retryAfter: 0,
      };
      const attempted = requestFromClaim(
        attemptedClaim,
        "MUTATION_ATTEMPTED",
      );
      storeRequest(attempted);
      resourceClaims.set(
        key,
        resourceFromClaim(attemptedClaim, "MUTATION_ATTEMPTED"),
      );
      return structuredClone(attempted);
    },
    async markRegistryDecisionRetryable(claim) {
      calls.push([
        "markRegistryDecisionRetryable",
        structuredClone(claim),
      ]);
      const current = storedFor(claim)?.result;
      const key = resourceKey(claim.target);
      if (
        current?.phase !== "MUTATION_ATTEMPTED"
        || current.attemptCount !== claim.attemptCount
        || !matchingOwnership(
          resourceClaims.get(key),
          { ...claim, retryAfter: 0 },
          "MUTATION_ATTEMPTED",
        )
      ) {
        throw conflict("REQUEST_CLAIM_CONFLICT");
      }
      const retryableClaim = {
        ...claim,
        phase: "RETRYABLE",
        attemptCount: claim.attemptCount === 3
          ? 0
          : claim.attemptCount,
      };
      const retryable = requestFromClaim(retryableClaim, "RETRYABLE");
      storeRequest(retryable);
      resourceClaims.set(
        key,
        resourceFromClaim(retryableClaim, "RETRYABLE"),
      );
      return structuredClone(retryable);
    },
    async putAuditWithRequestResult(value) {
      calls.push(["putAuditWithRequestResult", structuredClone(value)]);
      const storedRequest = storedFor(value.requestResult);
      const current = storedRequest?.result;
      if (
        current?.kind !== value.claim.kind
        || current.status !== "IN_PROGRESS"
        || current.payloadFingerprint !== value.claim.payloadFingerprint
        || current.ownerToken !== value.claim.ownerToken
      ) {
        throw Object.assign(new Error("claim conflict"), {
          code: "REQUEST_CLAIM_CONFLICT",
        });
      }
      audits.push(structuredClone(value.audit));
      storeRequest(value.requestResult);
      return structuredClone(value);
    },
    async putRegistryDecisionAuditWithRequestResult(value) {
      calls.push([
        "putRegistryDecisionAuditWithRequestResult",
        structuredClone(value),
      ]);
      const request = storedFor(value.requestResult);
      const current = request?.result;
      if (
        current?.status !== "IN_PROGRESS"
        || current.phase !== "MUTATION_ATTEMPTED"
        || current.kind !== value.claim.kind
        || current.payloadFingerprint !== value.claim.payloadFingerprint
        || current.ownerToken !== value.claim.ownerToken
        || !isDeepStrictEqual(current.target, value.claim.target)
      ) {
        throw conflict("REQUEST_CLAIM_CONFLICT");
      }
      const key = resourceKey(value.claim.target);
      const resource = resourceClaims.get(key);
      const ownership = {
        actor: value.requestResult.actor,
        route: value.requestResult.route,
        requestId: value.requestResult.requestId,
        createdAt: value.requestResult.createdAt,
        retryAfter: 0,
        ...value.claim,
      };
      if (!matchingOwnership(
        resource,
        ownership,
        "MUTATION_ATTEMPTED",
      )) {
        throw conflict("REGISTRY_RESOURCE_CONFLICT");
      }
      audits.push(structuredClone(value.audit));
      storeRequest(value.requestResult);
      resourceClaims.set(
        key,
        resourceFromClaim(ownership, "SUCCEEDED"),
      );
      return structuredClone(value);
    },
    async getAudit(identity) {
      calls.push(["getAudit", structuredClone(identity)]);
      return null;
    },
    async putRequestResultForAuditReplay(value) {
      calls.push([
        "putRequestResultForAuditReplay",
        structuredClone(value),
      ]);
      storeRequest(value.requestResult);
      return structuredClone(value.requestResult);
    },
    async putRegistryDecisionResultForAuditReplay(value) {
      calls.push([
        "putRegistryDecisionResultForAuditReplay",
        structuredClone(value),
      ]);
      const request = storedFor(value.requestResult);
      const current = request?.result;
      if (
        current?.phase !== "MUTATION_ATTEMPTED"
        || current.ownerToken !== value.claim.ownerToken
        || !isDeepStrictEqual(current.target, value.claim.target)
      ) {
        throw conflict("REQUEST_CLAIM_CONFLICT");
      }
      const ownership = {
        actor: value.requestResult.actor,
        route: value.requestResult.route,
        requestId: value.requestResult.requestId,
        createdAt: value.requestResult.createdAt,
        retryAfter: 0,
        ...value.claim,
      };
      const key = resourceKey(value.claim.target);
      if (!matchingOwnership(
        resourceClaims.get(key),
        ownership,
        "MUTATION_ATTEMPTED",
      )) {
        throw conflict("REGISTRY_RESOURCE_CONFLICT");
      }
      storeRequest(value.requestResult);
      resourceClaims.set(
        key,
        resourceFromClaim(ownership, "SUCCEEDED"),
      );
      return structuredClone(value.requestResult);
    },
  };
  const registryInventory = {
    async registryOnly(scope) {
      calls.push(["registryOnly", structuredClone(scope)]);
      return structuredClone(
        typeof inventory === "function" ? inventory(scope) : inventory,
      );
    },
  };
  const registry = {
    async send(command) {
      calls.push(["registry", command]);
      if (command instanceof UpdateRegistryRecordStatusCommand) {
        if (updateResponse instanceof Error) throw updateResponse;
        return structuredClone(updateResponse);
      }
      if (command instanceof GetRegistryRecordCommand) {
        if (Array.isArray(reread)) {
          return structuredClone(reread.shift());
        }
        return structuredClone(
          typeof reread === "function" ? reread(command) : reread,
        );
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    },
  };
  return {
    audits,
    calls,
    registry,
    registryInventory,
    state,
    storedRequest: (identity = adminScope()) => {
      const stored = storedFor({
        actor: identity.actor,
        route: DECIDE_ROUTE,
        requestId: identity.requestId,
      });
      return stored === null ? null : structuredClone(stored);
    },
    resourceClaims,
  };
}

async function decisionServiceFor(harness, overrides = {}) {
  const decisionFinalizer = overrides.decisionFinalizer ?? {
    finalize(value) {
      return harness.state.putRegistryDecisionAuditWithRequestResult(
        value,
      );
    },
  };
  return serviceFor(harness, {
    registryInventory: harness.registryInventory,
    decisionFinalizer,
    ...overrides,
  });
}

test("decideRegistryVersion approves the exact live Registry record and atomically audits the authoritative re-read", async () => {
  const harness = registryDecisionHarness();
  const service = await decisionServiceFor(harness);

  assert.deepEqual(
    await service.decideRegistryVersion(adminScope(), decisionInput()),
    {
      ok: true,
      version: {
        id: ENTRY_ID,
        semver: SEMVER,
        status: "APPROVED",
        statusReason: APPROVE_REASON,
        _aws: {
          registryId: AUTHORITATIVE_REGISTRY_ID,
          recordId: AUTHORITATIVE_RECORD_ID,
        },
      },
    },
  );

  const fingerprint = decisionFingerprint();
  assert.deepEqual(harness.calls[0], [
    "getRequestResult",
    {
      actor: "admin-sub-123",
      route: DECIDE_ROUTE,
      requestId: "request-123",
    },
  ]);
  assert.deepEqual(harness.calls[1], [
    "registryOnly",
    {
      role: "admin",
      allowedDomains: ["platform"],
      capabilities: ["approveRegistryVersion"],
    },
  ]);
  assert.equal(harness.calls[2][0], "claimRegistryDecisionTarget");
  assert.deepEqual(harness.calls[2][1], {
    actor: "admin-sub-123",
    route: DECIDE_ROUTE,
    requestId: "request-123",
    kind: DECISION_KIND,
    payloadFingerprint: fingerprint,
    ownerToken: harness.calls[2][1].ownerToken,
    claimExpiresAt: NOW_EPOCH + CLAIM_TTL_SECONDS,
    phase: "TARGET_BOUND",
    attemptCount: 0,
    retryAfter: 0,
    createdAt: NOW,
    target: persistedDecisionTarget(),
  });
  assert.match(harness.calls[2][1].ownerToken, /^[a-f0-9-]{36}$/);
  assert.equal(
    harness.calls[3][0],
    "markRegistryDecisionMutationAttempted",
  );
  assert.ok(harness.calls[4][1] instanceof UpdateRegistryRecordStatusCommand);
  assert.deepEqual(harness.calls[4][1].input, {
    registryId: AUTHORITATIVE_REGISTRY_ID,
    recordId: AUTHORITATIVE_RECORD_ID,
    status: "APPROVED",
    statusReason: APPROVE_REASON,
  });
  assert.ok(harness.calls[5][1] instanceof GetRegistryRecordCommand);
  assert.deepEqual(harness.calls[5][1].input, {
    registryId: AUTHORITATIVE_REGISTRY_ID,
    recordId: AUTHORITATIVE_RECORD_ID,
  });
  assert.equal(
    harness.calls[6][0],
    "putRegistryDecisionAuditWithRequestResult",
  );
  assert.deepEqual(harness.calls[6][1].audit, {
    actor: "admin-sub-123",
    action: "registry.version.decide",
    resource:
      `registry/${AUTHORITATIVE_REGISTRY_ID}`
      + `/record/${AUTHORITATIVE_RECORD_ID}`
      + `/version/${SEMVER}`,
    decision: "approve",
    reason: APPROVE_REASON,
    requestId: "request-123",
    timestamp: NOW,
  });
  assert.deepEqual(harness.calls[6][1].requestResult, {
    actor: "admin-sub-123",
    route: DECIDE_ROUTE,
    requestId: "request-123",
    result: {
      kind: DECISION_KIND,
      status: "SUCCEEDED",
      payloadFingerprint: fingerprint,
      resource:
        `registry/${AUTHORITATIVE_REGISTRY_ID}`
        + `/record/${AUTHORITATIVE_RECORD_ID}`
        + `/version/${SEMVER}`,
      decision: "approve",
      reason: APPROVE_REASON,
      version: {
        id: ENTRY_ID,
        semver: SEMVER,
        status: "APPROVED",
        statusReason: APPROVE_REASON,
        _aws: {
          registryId: AUTHORITATIVE_REGISTRY_ID,
          recordId: AUTHORITATIVE_RECORD_ID,
        },
      },
    },
    createdAt: NOW,
  });
  assert.deepEqual(harness.calls[6][1].claim, {
    kind: DECISION_KIND,
    payloadFingerprint: fingerprint,
    ownerToken: harness.calls[2][1].ownerToken,
    attemptCount: 1,
    target: persistedDecisionTarget(),
  });
  assert.equal(harness.calls.length, 7);
  assert.equal(harness.audits.length, 1);
});

test("Registry decisions select an authoritative target from a large multipage Registry-only inventory", async () => {
  const harness = registryDecisionHarness();
  const inventoryCalls = [];
  const fillerCount = 120;
  const registryArn =
    `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
    + `registry/${AUTHORITATIVE_REGISTRY_ID}`;
  const summaries = Array.from({ length: fillerCount }, (_, index) => {
    const recordId = `R${String(index).padStart(11, "0")}`;
    return {
      recordId,
      recordArn: `${registryArn}/record/${recordId}`,
      registryArn,
      status: "APPROVED",
    };
  });
  summaries.push({
    recordId: AUTHORITATIVE_RECORD_ID,
    recordArn: `${registryArn}/record/${AUTHORITATIVE_RECORD_ID}`,
    registryArn,
    status: "PENDING_APPROVAL",
  });
  const detail = (registryId, recordId) => {
    const isTarget = recordId === AUTHORITATIVE_RECORD_ID;
    const id = isTarget ? ENTRY_ID : `blueprint-${recordId}`;
    const name = isTarget ? "customer_support_blueprint" : `blueprint_${recordId}`;
    return {
      registryId,
      registryArn:
        `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/${registryId}`,
      recordId,
      recordArn:
        `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/${registryId}`
        + `/record/${recordId}`,
      name,
      displayName: name,
      description: `${name} description`,
      recordType: "CUSTOM",
      recordVersion: SEMVER,
      status: isTarget ? "PENDING_APPROVAL" : "APPROVED",
      createdAt: new Date("2026-08-22T00:00:00.000Z"),
      updatedAt: new Date("2026-08-22T01:00:00.000Z"),
      descriptors: {
        custom: {
          data: JSON.stringify({
            resourceKind: "blueprint",
            blueprintId: id,
            displayName: isTarget
              ? "Customer Support Blueprint"
              : `Blueprint ${recordId}`,
            defaultVersion: SEMVER,
          }),
        },
      },
    };
  };
  const inventoryRegistry = {
    async send(command) {
      inventoryCalls.push(command);
      if (command instanceof GetRegistryRecordCommand) {
        return detail(command.input.registryId, command.input.recordId);
      }
      assert.ok(command instanceof ListRegistryRecordsCommand);
      if (command.input.registryId !== AUTHORITATIVE_REGISTRY_ID) {
        return { registryRecords: [] };
      }
      const page = command.input.nextToken === undefined
        ? 0
        : Number(command.input.nextToken.replace("page-", ""));
      const start = page * 50;
      const registryRecords = summaries.slice(start, start + 50);
      return {
        registryRecords,
        ...(start + 50 < summaries.length
          ? { nextToken: `page-${page + 1}` }
          : {}),
      };
    },
  };
  const inventoryRegistryDiscovery = {
    async send(command) {
      inventoryCalls.push(command);
      assert.ok(
        command instanceof BatchGetDiscoverableRegistryRecordCommand,
      );
      const [{ registryId, recordIds }] = command.input.entries;
      return {
        registryRecords: recordIds
          .filter((recordId) => recordId !== AUTHORITATIVE_RECORD_ID)
          .map((recordId) => detail(registryId, recordId)),
        errors: recordIds.includes(AUTHORITATIVE_RECORD_ID)
          ? [{
            registryId,
            recordId: AUTHORITATIVE_RECORD_ID,
            errorCode: "RESOURCE_NOT_FOUND",
          }]
          : [],
      };
    },
  };
  const registryInventory = createRegistryInventoryService({
    config: {
      accountId: ACCOUNT,
      region: REGION,
      sharedRegistryId: AUTHORITATIVE_REGISTRY_ID,
      domainRegistryIds: {
        platform: "PlatformReg123",
        customer_support: "SupportReg1234",
        operations: "OperationsReg1",
      },
    },
    registryClient: inventoryRegistry,
    registryDiscoveryClient: inventoryRegistryDiscovery,
    maxDetailConcurrency: 2,
  });

  const result = await (await decisionServiceFor(harness, {
    registryInventory,
  })).decideRegistryVersion(adminScope(), decisionInput());

  assert.equal(result.version.status, "APPROVED");
  assert.equal(result.version._aws.recordId, AUTHORITATIVE_RECORD_ID);
  assert.equal(
    inventoryCalls.filter(
      (command) => command instanceof ListRegistryRecordsCommand,
    ).length,
    6,
  );
  assert.equal(
    inventoryCalls.filter(
      (command) => command instanceof GetRegistryRecordCommand,
    ).length,
    1,
  );
  assert.equal(
    inventoryCalls.filter(
      (command) =>
        command instanceof BatchGetDiscoverableRegistryRecordCommand
    ).length,
    3,
  );
  assert.deepEqual(
    harness.calls.find(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    )[1].input,
    {
      registryId: AUTHORITATIVE_REGISTRY_ID,
      recordId: AUTHORITATIVE_RECORD_ID,
      status: "APPROVED",
      statusReason: APPROVE_REASON,
    },
  );
});

test("Registry decisions reject malformed pagination tokens before any mutation", async () => {
  const targetDetail = {
    registryId: AUTHORITATIVE_REGISTRY_ID,
    registryArn:
      `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
      + `registry/${AUTHORITATIVE_REGISTRY_ID}`,
    recordId: AUTHORITATIVE_RECORD_ID,
    recordArn:
      `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
      + `registry/${AUTHORITATIVE_REGISTRY_ID}`
      + `/record/${AUTHORITATIVE_RECORD_ID}`,
    name: "customer_support_blueprint",
    displayName: "Customer Support Blueprint",
    description: "Customer Support Blueprint description",
    recordType: "CUSTOM",
    recordVersion: SEMVER,
    status: "PENDING_APPROVAL",
    descriptors: {
      custom: {
        data: JSON.stringify({
          resourceKind: "blueprint",
          blueprintId: ENTRY_ID,
          displayName: "Customer Support Blueprint",
          defaultVersion: SEMVER,
        }),
      },
    },
  };
  const cases = [
    ["numeric", 42, false, 1],
    ["object", { token: "next" }, false, 1],
    ["blank", "   ", false, 1],
    ["overlong", "x".repeat(4097), false, 1],
    ["repeated", "repeat-token", true, 2],
  ];

  for (const [label, token, repeated, expectedListCalls] of cases) {
    const harness = registryDecisionHarness();
    const inventoryCalls = [];
    const registryInventory = createRegistryInventoryService({
      config: {
        accountId: ACCOUNT,
        region: REGION,
        sharedRegistryId: AUTHORITATIVE_REGISTRY_ID,
        domainRegistryIds: {
          platform: "PlatformReg123",
          customer_support: "SupportReg1234",
          operations: "OperationsReg1",
        },
      },
      registryClient: {
        async send(command) {
          inventoryCalls.push(command);
          if (command instanceof GetRegistryRecordCommand) {
            return targetDetail;
          }
          assert.ok(command instanceof ListRegistryRecordsCommand);
          if (command.input.registryId !== AUTHORITATIVE_REGISTRY_ID) {
            return { registryRecords: [] };
          }
          if (command.input.nextToken === undefined) {
            return {
              registryRecords: [{ recordId: AUTHORITATIVE_RECORD_ID }],
              nextToken: token,
            };
          }
          return repeated
            ? { registryRecords: [], nextToken: token }
            : { registryRecords: [] };
        },
      },
    });

    await assert.rejects(
      (await decisionServiceFor(harness, {
        registryInventory,
      })).decideRegistryVersion(adminScope(), decisionInput()),
      (error) =>
        error?.code === "REGISTRY_DECISION_FAILED"
        && error?.statusCode === 503,
      label,
    );
    assert.equal(
      inventoryCalls.filter(
        (command) => command instanceof ListRegistryRecordsCommand,
      ).length,
      expectedListCalls + 3,
      label,
    );
    assert.equal(
      inventoryCalls.filter(
        (command) => command instanceof GetRegistryRecordCommand,
      ).length,
      0,
      label,
    );
    assert.equal(
      harness.calls.filter(
        ([method, command]) =>
          method === "registry"
          && command instanceof UpdateRegistryRecordStatusCommand,
      ).length,
      0,
      label,
    );
    assert.equal(harness.storedRequest(), null, label);
  }
});

test("Registry decisions delegate immutable audit finalization outside the admin state client", async () => {
  const harness = registryDecisionHarness();
  const write =
    harness.state.putRegistryDecisionAuditWithRequestResult.bind(
      harness.state,
    );
  delete harness.state.putRegistryDecisionAuditWithRequestResult;
  delete harness.state.getAudit;
  delete harness.state.putRegistryDecisionResultForAuditReplay;
  const finalizer = {
    async finalize(value) {
      harness.calls.push(["decisionFinalizer", structuredClone(value)]);
      return write(value);
    },
  };

  const result = await (await decisionServiceFor(harness, {
    decisionFinalizer: finalizer,
  })).decideRegistryVersion(adminScope(), decisionInput());

  assert.equal(result.version.status, "APPROVED");
  assert.equal(
    harness.calls.filter(
      ([method]) =>
        method === "putRegistryDecisionAuditWithRequestResult",
    ).length,
    1,
  );
  assert.equal(
    harness.calls.filter(
      ([method]) => method === "decisionFinalizer",
    ).length,
    1,
  );
});

test("decideRegistryVersion requires trusted admin capability and exact decision input", async () => {
  const invalidCases = [
    [adminScope({ role: "builder" }), decisionInput(), "FORBIDDEN", 403],
    [adminScope({ capabilities: [] }), decisionInput(), "FORBIDDEN", 403],
    [adminScope(), decisionInput({ requestId: "body-control" }), "INVALID_REGISTRY_DECISION", 400],
    [adminScope(), decisionInput({ role: "admin" }), "INVALID_REGISTRY_DECISION", 400],
    [adminScope(), decisionInput({ id: " bad " }), "INVALID_REGISTRY_DECISION", 400],
    [adminScope(), decisionInput({ semver: "1.0" }), "INVALID_REGISTRY_DECISION", 400],
    [adminScope(), decisionInput({ decision: "allow" }), "INVALID_REGISTRY_DECISION", 400],
    [adminScope(), decisionInput({ reason: " reason " }), "INVALID_REGISTRY_DECISION", 400],
    [adminScope(), decisionInput({ decision: "reject", reason: "" }), "INVALID_REGISTRY_DECISION", 400],
  ];

  for (const [scope, input, code, statusCode] of invalidCases) {
    const harness = registryDecisionHarness();
    await assert.rejects(
      (await decisionServiceFor(harness)).decideRegistryVersion(scope, input),
      (error) => error?.code === code && error?.statusCode === statusCode,
    );
    assert.deepEqual(harness.calls, []);
  }
});

test("Platform Admin cannot decide domain-owned Registry versions", async () => {
  const harness = registryDecisionHarness({
    inventory: authoritativeInventory({
      domain: "customer_support",
    }),
  });

  await assert.rejects(
    (await decisionServiceFor(harness)).decideRegistryVersion(
      adminScope(),
      decisionInput(),
    ),
    (error) =>
      error?.code === "REGISTRY_DECISION_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.deepEqual(
    harness.calls.map(([method]) => method),
    ["getRequestResult", "registryOnly"],
  );
});

test("Registry decision AWS inputs are bounded before the mutation phase", async () => {
  const cases = [
    ["short record ID", authoritativeInventory({ recordId: "A".repeat(11) })],
    ["long record ID", authoritativeInventory({ recordId: "A".repeat(13) })],
    ["non-alphanumeric record ID",
      authoritativeInventory({ recordId: "Rec12345678-" })],
    ["overlong semver",
      authoritativeInventory({ semver: `1.0.0-${"a".repeat(128)}` })],
  ];
  for (const [label, inventory] of cases) {
    const harness = registryDecisionHarness({ inventory });
    await assert.rejects(
      (await decisionServiceFor(harness)).decideRegistryVersion(
        adminScope(),
        decisionInput(),
      ),
      (error) =>
        error?.code === "REGISTRY_DECISION_FAILED"
        && error?.statusCode === 503,
      label,
    );
    assert.equal(
      harness.calls.some(
        ([method]) => method === "markRegistryDecisionMutationAttempted",
      ),
      false,
      label,
    );
  }

  const harness = registryDecisionHarness();
  await assert.rejects(
    (await decisionServiceFor(harness)).decideRegistryVersion(
      adminScope(),
      decisionInput({ reason: "r".repeat(256) }),
    ),
    (error) =>
      error?.code === "INVALID_REGISTRY_DECISION"
      && error?.statusCode === 400,
  );
  assert.equal(harness.calls.length, 0);
});

test("decideRegistryVersion rejects with the exact bounded reason and AWS status", async () => {
  const reason = "Security review evidence is incomplete.";
  const harness = registryDecisionHarness({
    reread: authoritativeRecord("REJECTED", reason),
  });
  const service = await decisionServiceFor(harness);

  const result = await service.decideRegistryVersion(
    adminScope(),
    decisionInput({ decision: "reject", reason }),
  );

  assert.equal(result.version.status, "REJECTED");
  assert.equal(result.version.statusReason, reason);
  const update = harness.calls.find(
    ([method, command]) =>
      method === "registry"
      && command instanceof UpdateRegistryRecordStatusCommand,
  );
  assert.deepEqual(update[1].input, {
    registryId: AUTHORITATIVE_REGISTRY_ID,
    recordId: AUTHORITATIVE_RECORD_ID,
    status: "REJECTED",
    statusReason: reason,
  });
  assert.deepEqual(harness.audits[0], {
    actor: "admin-sub-123",
    action: "registry.version.decide",
    resource:
      `registry/${AUTHORITATIVE_REGISTRY_ID}`
      + `/record/${AUTHORITATIVE_RECORD_ID}`
      + `/version/${SEMVER}`,
    decision: "reject",
    reason,
    requestId: "request-123",
    timestamp: NOW,
  });
});

test("decideRegistryVersion accepts an authoritative re-read with no optional status reason", async () => {
  const reread = authoritativeRecord("APPROVED", APPROVE_REASON);
  delete reread.statusReason;
  const harness = registryDecisionHarness({ reread });

  assert.deepEqual(
    await (await decisionServiceFor(harness)).decideRegistryVersion(
      adminScope(),
      decisionInput(),
    ),
    {
      ok: true,
      version: {
        id: ENTRY_ID,
        semver: SEMVER,
        status: "APPROVED",
        statusReason: APPROVE_REASON,
        _aws: {
          registryId: AUTHORITATIVE_REGISTRY_ID,
          recordId: AUTHORITATIVE_RECORD_ID,
        },
      },
    },
  );
});

test("decideRegistryVersion accepts only authoritative PENDING_APPROVAL Registry records", async () => {
  const cases = [
    [
      "draft",
      authoritativeInventory({ status: "DRAFT", awsStatus: "DRAFT" }),
      "REGISTRY_DECISION_CONFLICT",
      409,
    ],
    [
      "already approved",
      authoritativeInventory({
        status: "APPROVED",
        awsStatus: "APPROVED",
      }),
      "REGISTRY_DECISION_CONFLICT",
      409,
    ],
    [
      "normalized status mismatch",
      authoritativeInventory({
        status: "IN_REVIEW",
        awsStatus: "APPROVED",
      }),
      "REGISTRY_DECISION_CONFLICT",
      409,
    ],
    [
      "model",
      authoritativeInventory({ type: "Model" }),
      "REGISTRY_DECISION_CONFLICT",
      409,
    ],
    [
      "gateway-sourced MCP server",
      authoritativeInventory({ type: "MCPServer", source: "gateway" }),
      "REGISTRY_DECISION_CONFLICT",
      409,
    ],
    [
      "missing registry ID",
      authoritativeInventory({ registryId: "" }),
      "REGISTRY_DECISION_FAILED",
      503,
    ],
    [
      "missing record ID",
      authoritativeInventory({ recordId: "" }),
      "REGISTRY_DECISION_FAILED",
      503,
    ],
    [
      "non-AWS source",
      {
        ...authoritativeInventory(),
        source: "local",
      },
      "REGISTRY_DECISION_FAILED",
      503,
    ],
    [
      "duplicate entry",
      {
        ...authoritativeInventory(),
        entries: [
          ...authoritativeInventory().entries,
          ...authoritativeInventory().entries,
        ],
      },
      "REGISTRY_DECISION_FAILED",
      503,
    ],
  ];

  for (const [label, inventory, code, statusCode] of cases) {
    const harness = registryDecisionHarness({ inventory });
    await assert.rejects(
      (await decisionServiceFor(harness)).decideRegistryVersion(
        adminScope(),
        decisionInput(),
      ),
      (error) => error?.code === code && error?.statusCode === statusCode,
      label,
    );
    assert.equal(
      harness.calls.some(
        ([method, command]) =>
          method === "registry"
          && command instanceof UpdateRegistryRecordStatusCommand,
      ),
      false,
      label,
    );
    assert.equal(harness.audits.length, 0, label);
  }
});

test("decideRegistryVersion approves an authoritative agentcore-registry MCPServer in a platform/shared domain", async () => {
  for (const domain of ["platform", "shared"]) {
    const harness = registryDecisionHarness({
      inventory: authoritativeInventory({ type: "MCPServer", domain }),
      reread: authoritativeRecord("APPROVED", APPROVE_REASON),
    });
    harness.registryInventory.registryTarget = async () => authoritativeInventory({type:"MCPServer",domain});
    const result = await (await decisionServiceFor(harness)).decideRegistryVersion(
      adminScope(),
      {...decisionInput(),registryId:AUTHORITATIVE_REGISTRY_ID,recordId:AUTHORITATIVE_RECORD_ID},
    );
    assert.equal(result.ok, true, domain);
    assert.equal(result.version.status, "APPROVED", domain);
    assert.equal(
      harness.calls.some(
        ([method, command]) =>
          method === "registry"
          && command instanceof UpdateRegistryRecordStatusCommand,
      ),
      true,
      domain,
    );
    assert.equal(harness.audits.length, 1, domain);
  }
});

test("decideRegistryVersion keeps a domain-owned agentcore-registry MCPServer fail-closed for platform decide", async () => {
  const harness = registryDecisionHarness({
    inventory: authoritativeInventory({ type: "MCPServer", domain: "domain_a" }),
  });
  await assert.rejects(
    (await decisionServiceFor(harness)).decideRegistryVersion(
      adminScope(),
      decisionInput(),
    ),
    (error) =>
      error?.code === "REGISTRY_DECISION_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.equal(
    harness.calls.some(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ),
    false,
  );
  assert.equal(harness.audits.length, 0);
});

test("decideRegistryVersion fails closed when the authoritative re-read is malformed or disagrees", async () => {
  const valid = authoritativeRecord("APPROVED", APPROVE_REASON);
  const cases = [
    null,
    {},
    { ...valid, registryId: "OtherReg12345" },
    { ...valid, registryArn: "arn:aws:agent-registry:us-west-2:111122223333:registry/OtherReg12345" },
    { ...valid, recordId: "Oth123456789" },
    { ...valid, recordArn: `${valid.registryArn}/record/Oth123456789` },
    { ...valid, recordVersion: "2.0.0" },
    { ...valid, statusReason: "Different reason." },
  ];

  for (const reread of cases) {
    const harness = registryDecisionHarness({ reread });
    await assert.rejects(
      (await decisionServiceFor(harness)).decideRegistryVersion(
        adminScope(),
        decisionInput(),
      ),
      (error) =>
        error?.code === "REGISTRY_DECISION_FAILED"
        && error?.statusCode === 503
        && error?.retryable === true,
      JSON.stringify(reread),
    );
    assert.equal(
      harness.calls.filter(
        ([method, command]) =>
          method === "registry"
          && command instanceof UpdateRegistryRecordStatusCommand,
      ).length,
      1,
    );
    assert.equal(harness.storedRequest().result.phase, "MUTATION_ATTEMPTED");
    assert.equal(harness.audits.length, 0);
  }
});

test("decideRegistryVersion replays one stored success and rejects a different payload without live reads", async () => {
  const harness = registryDecisionHarness();
  const service = await decisionServiceFor(harness);
  const first = await service.decideRegistryVersion(
    adminScope(),
    decisionInput(),
  );
  const callsAfterFirst = harness.calls.length;

  assert.deepEqual(
    await service.decideRegistryVersion(adminScope(), decisionInput()),
    first,
  );
  assert.equal(harness.calls.length, callsAfterFirst + 1);
  assert.equal(harness.calls.at(-1)[0], "getRequestResult");
  await assert.rejects(
    service.decideRegistryVersion(
      adminScope(),
      decisionInput({ reason: "Different approval reason." }),
    ),
    (error) =>
      error?.code === "IDEMPOTENCY_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.equal(harness.calls.length, callsAfterFirst + 2);
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
  assert.equal(harness.audits.length, 1);
});

test("concurrent Registry decisions have one claim owner and one AWS mutation", async () => {
  const harness = registryDecisionHarness();
  const send = harness.registry.send.bind(harness.registry);
  let releaseUpdate;
  let updateEntered;
  let updates = 0;
  const entered = new Promise((resolve) => {
    updateEntered = resolve;
  });
  const release = new Promise((resolve) => {
    releaseUpdate = resolve;
  });
  harness.registry.send = async (command) => {
    if (command instanceof UpdateRegistryRecordStatusCommand) {
      updates += 1;
      updateEntered();
      await release;
    }
    return send(command);
  };
  const service = await decisionServiceFor(harness);
  const first = service.decideRegistryVersion(
    adminScope(),
    decisionInput(),
  );
  await entered;

  assert.equal(
    (await service.decideRegistryVersion(
      adminScope(),
      decisionInput(),
    )).version.status,
    "APPROVED",
  );
  assert.equal(updates, 1);

  releaseUpdate();
  assert.equal((await first).version.status, "APPROVED");
  assert.equal(updates, 1);
  assert.equal(harness.audits.length, 1);
});

test("a post-mutation finalization failure recovers from authoritative target status without a second update", async () => {
  let liveStatus = "IN_REVIEW";
  let liveAwsStatus = "PENDING_APPROVAL";
  const harness = registryDecisionHarness({
    inventory: () => authoritativeInventory({
      status: liveStatus,
      awsStatus: liveAwsStatus,
    }),
    reread: () => authoritativeRecord("APPROVED", APPROVE_REASON),
  });
  const send = harness.registry.send.bind(harness.registry);
  harness.registry.send = async (command) => {
    if (command instanceof UpdateRegistryRecordStatusCommand) {
      liveStatus = "APPROVED";
      liveAwsStatus = "APPROVED";
    }
    return send(command);
  };
  const finalize = harness.state
    .putRegistryDecisionAuditWithRequestResult
    .bind(harness.state);
  let finalizations = 0;
  harness.state.putRegistryDecisionAuditWithRequestResult =
    async (value) => {
    finalizations += 1;
    if (finalizations === 1) {
      throw new Error("TOP-SECRET DynamoDB response loss");
    }
    return finalize(value);
    };
  const service = await decisionServiceFor(harness);

  await assert.rejects(
    service.decideRegistryVersion(adminScope(), decisionInput()),
    (error) =>
      error?.code === "REGISTRY_DECISION_FAILED"
      && error?.statusCode === 503,
  );
  assert.equal(
    harness.storedRequest().result.phase,
    "MUTATION_ATTEMPTED",
  );

  assert.deepEqual(
    await service.decideRegistryVersion(adminScope(), decisionInput()),
    {
      ok: true,
      version: {
        id: ENTRY_ID,
        semver: SEMVER,
        status: "APPROVED",
        statusReason: APPROVE_REASON,
        _aws: {
          registryId: AUTHORITATIVE_REGISTRY_ID,
          recordId: AUTHORITATIVE_RECORD_ID,
        },
      },
    },
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
  assert.equal(harness.audits.length, 1);
});

test("an ambiguous Update error finalizes when bounded authoritative polling reaches the target", async () => {
  const harness = registryDecisionHarness({
    updateResponse: new Error("transport outcome unknown"),
    reread: [
      authoritativeRecord("UPDATING", APPROVE_REASON),
      authoritativeRecord("APPROVED", APPROVE_REASON),
    ],
  });
  const service = await decisionServiceFor(harness, {
    decisionPollAttempts: 3,
    decisionPollDelayMs: 1,
    sleep: async () => {},
  });

  assert.equal(
    (await service.decideRegistryVersion(
      adminScope(),
      decisionInput(),
    )).version.status,
    "APPROVED",
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
});

test("a pre-send Update failure becomes same-owner retryable after bounded pending polling", async () => {
  const error = Object.assign(new Error("request was not sent"), {
    $metadata: { attempts: 0 },
  });
  const harness = registryDecisionHarness({
    updateResponse: error,
    reread: Array.from(
      { length: 3 },
      () => authoritativeRecord("PENDING_APPROVAL", APPROVE_REASON),
    ),
  });
  const service = await decisionServiceFor(harness, {
    decisionPollAttempts: 3,
    decisionPollDelayMs: 1,
    decisionRetryBackoffSeconds: 1,
    sleep: async () => {},
  });

  await assert.rejects(
    service.decideRegistryVersion(adminScope(), decisionInput()),
    (caught) =>
      caught?.code === "REGISTRY_DECISION_UNCERTAIN"
      && caught?.statusCode === 503
      && caught?.retryable === true,
  );
  assert.equal(harness.storedRequest().result.phase, "RETRYABLE");
  assert.equal(harness.storedRequest().result.attemptCount, 1);
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
});

test("the same exact-target owner can retry once backoff elapses without inventory remapping", async () => {
  const prior = persistedDecisionPhase("RETRYABLE", {
    attemptCount: 1,
    retryAfter: NOW_EPOCH - 1,
  });
  const harness = registryDecisionHarness({
    priorRequestResult: prior,
    inventory: authoritativeInventory({
      registryId: "OtherReg12345",
      recordId: "Mov123456789",
    }),
    reread: authoritativeRecord("APPROVED", APPROVE_REASON),
  });

  assert.equal(
    (await (await decisionServiceFor(harness)).decideRegistryVersion(
      adminScope(),
      decisionInput(),
    )).version.status,
    "APPROVED",
  );
  assert.equal(
    harness.calls.some(([method]) => method === "registryOnly"),
    false,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
});

test("exhausted mutation windows enter durable cooldown and later allow only the same request to progress", async () => {
  const prior = persistedDecisionPhase("MUTATION_ATTEMPTED", {
    attemptCount: 3,
  });
  let currentTime = new Date(NOW);
  const harness = registryDecisionHarness({
    priorRequestResult: prior,
    reread: [
      ...Array.from(
        { length: 3 },
        () => authoritativeRecord("PENDING_APPROVAL", APPROVE_REASON),
      ),
      authoritativeRecord("APPROVED", APPROVE_REASON),
    ],
  });
  const service = await decisionServiceFor(harness, {
    decisionPollAttempts: 3,
    decisionPollDelayMs: 1,
    decisionRecoveryCooldownSeconds: 60,
    now: () => currentTime,
    sleep: async () => {},
  });

  await assert.rejects(
    service.decideRegistryVersion(adminScope(), decisionInput()),
    (error) =>
      error?.code === "REGISTRY_DECISION_UNCERTAIN"
      && error?.statusCode === 503
      && error?.retryable === true,
  );
  assert.equal(harness.storedRequest().result.phase, "RETRYABLE");
  assert.equal(harness.storedRequest().result.attemptCount, 0);
  assert.equal(
    harness.storedRequest().result.retryAfter,
    NOW_EPOCH + 60,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    0,
  );

  await assert.rejects(
    service.decideRegistryVersion(adminScope(), decisionInput()),
    (error) =>
      error?.code === "REGISTRY_DECISION_FAILED"
      && error?.statusCode === 503,
  );
  await assert.rejects(
    service.decideRegistryVersion(
      adminScope({ requestId: "other-request-456" }),
      decisionInput(),
    ),
    (error) =>
      error?.code === "REGISTRY_DECISION_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    0,
  );

  currentTime = new Date((NOW_EPOCH + 61) * 1000);
  assert.equal(
    (await service.decideRegistryVersion(
      adminScope(),
      decisionInput(),
    )).version.status,
    "APPROVED",
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
});

test("a mutation-attempt retry ignores remapped inventory and reconciles only the persisted AWS target", async () => {
  const harness = registryDecisionHarness({
    priorRequestResult: persistedDecisionPhase("MUTATION_ATTEMPTED"),
    inventory: authoritativeInventory({
      registryId: "OtherReg12345",
      recordId: "Mov123456789",
    }),
    reread: authoritativeRecord("APPROVED", APPROVE_REASON),
  });
  const service = await decisionServiceFor(harness);

  assert.equal(
    (await service.decideRegistryVersion(
      adminScope(),
      decisionInput(),
    )).version.status,
    "APPROVED",
  );
  assert.equal(
    harness.calls.some(([method]) => method === "registryOnly"),
    false,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    0,
  );
  const read = harness.calls.find(
    ([method, command]) =>
      method === "registry"
      && command instanceof GetRegistryRecordCommand,
  );
  assert.deepEqual(read[1].input, {
    registryId: AUTHORITATIVE_REGISTRY_ID,
    recordId: AUTHORITATIVE_RECORD_ID,
  });
  assert.equal(
    harness.audits[0].resource,
    `registry/${AUTHORITATIVE_REGISTRY_ID}`
      + `/record/${AUTHORITATIVE_RECORD_ID}`
      + `/version/${SEMVER}`,
  );
});

test("a Registry decision retry beyond 24 hours remains bound to the permanent original target", async () => {
  const prior = persistedDecisionPhase("MUTATION_ATTEMPTED");
  prior.createdAt = "2026-08-21T01:02:03.000Z";
  prior.result.claimExpiresAt =
    Math.floor(Date.parse(prior.createdAt) / 1000) + CLAIM_TTL_SECONDS;
  const harness = registryDecisionHarness({
    priorRequestResult: prior,
    inventory: authoritativeInventory({
      registryId: "OtherReg12345",
      recordId: "Mov123456789",
    }),
    reread: authoritativeRecord("APPROVED", APPROVE_REASON),
  });
  const service = await decisionServiceFor(harness);

  assert.equal(
    (await service.decideRegistryVersion(
      adminScope(),
      decisionInput(),
    )).version.status,
    "APPROVED",
  );
  assert.equal(
    harness.calls.some(([method]) => method === "registryOnly"),
    false,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    0,
  );
  assert.deepEqual(
    harness.calls.find(
      ([method, command]) =>
        method === "registry"
        && command instanceof GetRegistryRecordCommand,
    )[1].input,
    {
      registryId: AUTHORITATIVE_REGISTRY_ID,
      recordId: AUTHORITATIVE_RECORD_ID,
    },
  );
  assert.equal(
    Object.hasOwn(harness.storedRequest(), "expiresAt"),
    false,
  );
});

test("a recorded mutation attempt that is still pending fails uncertain without a second update", async () => {
  const harness = registryDecisionHarness({
    priorRequestResult: persistedDecisionPhase("MUTATION_ATTEMPTED"),
    reread: authoritativeRecord(
      "PENDING_APPROVAL",
      APPROVE_REASON,
    ),
  });
  const service = await decisionServiceFor(harness);

  await assert.rejects(
    service.decideRegistryVersion(adminScope(), decisionInput()),
    (error) =>
      error?.code === "REGISTRY_DECISION_UNCERTAIN"
      && error?.statusCode === 503
      && error?.retryable === true,
  );
  assert.equal(
    harness.calls.some(([method]) => method === "registryOnly"),
    false,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    0,
  );
});

test("mutation-attempt recovery exhaustively classifies authoritative AWS Registry statuses", async () => {
  const cases = [
    ["CREATING", "REGISTRY_DECISION_CONFLICT", 409, false],
    ["CREATE_FAILED", "REGISTRY_DECISION_CONFLICT", 409, false],
    ["DRAFT", "REGISTRY_DECISION_CONFLICT", 409, false],
    ["PENDING_APPROVAL", "REGISTRY_DECISION_UNCERTAIN", 503, true],
    ["APPROVED", null, 200, false],
    ["REJECTED", "REGISTRY_DECISION_CONFLICT", 409, false],
    ["UPDATING", "REGISTRY_DECISION_FAILED", 503, true],
    ["UPDATE_FAILED", "REGISTRY_DECISION_CONFLICT", 409, false],
    ["DEPRECATED", "REGISTRY_DECISION_CONFLICT", 409, false],
    ["UNKNOWN_STATUS", "REGISTRY_DECISION_FAILED", 503, true],
    [null, "REGISTRY_DECISION_FAILED", 503, true],
    [42, "REGISTRY_DECISION_FAILED", 503, true],
  ];

  for (const [status, code, statusCode, retryable] of cases) {
    const harness = registryDecisionHarness({
      priorRequestResult: persistedDecisionPhase("MUTATION_ATTEMPTED"),
      reread: authoritativeRecord(status, APPROVE_REASON),
    });
    const service = await decisionServiceFor(harness);

    if (code === null) {
      assert.equal(
        (await service.decideRegistryVersion(
          adminScope(),
          decisionInput(),
        )).version.status,
        "APPROVED",
        String(status),
      );
      assert.equal(harness.audits.length, 1, String(status));
    } else {
      await assert.rejects(
        service.decideRegistryVersion(adminScope(), decisionInput()),
        (error) =>
          error?.code === code
          && error?.statusCode === statusCode
          && error?.retryable === retryable
          && !error.message.includes(String(status)),
        String(status),
      );
      assert.equal(harness.audits.length, 0, String(status));
    }
    assert.equal(
      harness.calls.some(([method]) => method === "registryOnly"),
      false,
      String(status),
    );
    assert.equal(
      harness.calls.filter(
        ([method, command]) =>
          method === "registry"
          && command instanceof UpdateRegistryRecordStatusCommand,
      ).length,
      0,
      String(status),
    );
  }
});

test("malformed or mismatched persisted decision targets fail closed before inventory or AWS", async () => {
  const cases = [
    { registryId: "bad" },
    { recordId: "" },
    { targetStatus: "REJECTED" },
    { statusReasonHash: "b".repeat(64) },
  ];
  for (const targetOverride of cases) {
    const prior = persistedDecisionPhase("MUTATION_ATTEMPTED");
    prior.result.target = persistedDecisionTarget(targetOverride);
    const harness = registryDecisionHarness({
      priorRequestResult: prior,
    });

    await assert.rejects(
      (await decisionServiceFor(harness)).decideRegistryVersion(
        adminScope(),
        decisionInput(),
      ),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
    );
    assert.equal(
      harness.calls.some(
        ([method]) => method === "registryOnly" || method === "registry",
      ),
      false,
    );
  }
});

test("a post-update finalization outage leaves the attempted phase and retry never updates again", async () => {
  const harness = registryDecisionHarness();
  const finalize = harness.state
    .putRegistryDecisionAuditWithRequestResult
    .bind(harness.state);
  let finalizations = 0;
  harness.state.putRegistryDecisionAuditWithRequestResult =
    async (value) => {
      finalizations += 1;
      if (finalizations === 1) {
        throw new Error("TOP-SECRET DynamoDB response loss");
      }
      return finalize(value);
    };
  const service = await decisionServiceFor(harness);

  await assert.rejects(
    service.decideRegistryVersion(adminScope(), decisionInput()),
    (error) =>
      error?.code === "REGISTRY_DECISION_FAILED"
      && error?.statusCode === 503,
  );
  assert.equal(
    harness.storedRequest().result.phase,
    "MUTATION_ATTEMPTED",
  );

  assert.equal(
    (await service.decideRegistryVersion(
      adminScope(),
      decisionInput(),
    )).version.status,
    "APPROVED",
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
  assert.equal(
    harness.calls.filter(
      ([method]) => method === "registryOnly",
    ).length,
    1,
  );
});

test("two actors with unique request IDs cannot both mutate one stale pending Registry record", async () => {
  const harness = registryDecisionHarness();
  const send = harness.registry.send.bind(harness.registry);
  let releaseUpdate;
  let updateEntered;
  let updates = 0;
  const entered = new Promise((resolve) => {
    updateEntered = resolve;
  });
  const release = new Promise((resolve) => {
    releaseUpdate = resolve;
  });
  harness.registry.send = async (command) => {
    if (command instanceof UpdateRegistryRecordStatusCommand) {
      updates += 1;
      if (updates === 1) {
        updateEntered();
        await release;
      }
    }
    return send(command);
  };
  const service = await decisionServiceFor(harness);
  const firstScope = adminScope({
    actor: "admin-one",
    requestId: "request-one",
  });
  const secondScope = adminScope({
    actor: "admin-two",
    requestId: "request-two",
  });
  const first = service.decideRegistryVersion(
    firstScope,
    decisionInput(),
  );
  await entered;

  await assert.rejects(
    service.decideRegistryVersion(secondScope, decisionInput()),
    (error) =>
      error?.code === "REGISTRY_DECISION_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.equal(updates, 1);

  releaseUpdate();
  assert.equal((await first).version.status, "APPROVED");
  assert.equal(updates, 1);
});

test("a resource-scoped claim conflict returns stable conflict before AWS mutation", async () => {
  const harness = registryDecisionHarness();
  harness.state.claimRegistryDecisionTarget = async (claim) => {
    harness.calls.push([
      "claimRegistryDecisionTarget",
      structuredClone(claim),
    ]);
    throw Object.assign(new Error("record owned"), {
      code: "REGISTRY_RESOURCE_CONFLICT",
    });
  };

  await assert.rejects(
    (await decisionServiceFor(harness)).decideRegistryVersion(
      adminScope(),
      decisionInput(),
    ),
    (error) =>
      error?.code === "REGISTRY_DECISION_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.equal(
    harness.calls.some(([method]) => method === "registry"),
    false,
  );
});

test("an audit conflict is replayed only after the same immutable evidence is read", async () => {
  const harness = registryDecisionHarness();
  const write = harness.state
    .putRegistryDecisionAuditWithRequestResult
    .bind(harness.state);
  let attempted;
  harness.state.putRegistryDecisionAuditWithRequestResult =
    async (value) => {
    attempted = structuredClone(value);
    throw Object.assign(new Error("audit exists"), {
      code: "AUDIT_CONFLICT",
    });
  };
  harness.state.getAudit = async (identity) => {
    harness.calls.push(["getAudit", structuredClone(identity)]);
    return structuredClone(attempted.audit);
  };
  const service = await decisionServiceFor(harness, {
    decisionFinalizer: createRegistryDecisionFinalizer({
      state: harness.state,
    }),
  });

  const result = await service.decideRegistryVersion(
    adminScope(),
    decisionInput(),
  );

  assert.equal(result.version.status, "APPROVED");
  assert.deepEqual(
    harness.calls.find(([method]) => method === "getAudit")[1],
    {
      actor: "admin-sub-123",
      timestamp: NOW,
      requestId: "request-123",
    },
  );
  assert.equal(
    harness.calls.some(
      ([method]) =>
        method === "putRegistryDecisionResultForAuditReplay",
    ),
    true,
  );

  harness.state.putRegistryDecisionAuditWithRequestResult = write;
});

test("a finalizer immutable-evidence mismatch returns a stable idempotency conflict", async () => {
  const harness = registryDecisionHarness();
  const service = await decisionServiceFor(harness, {
    decisionFinalizer: {
      async finalize() {
        throw Object.assign(new Error("evidence mismatch"), {
          code: "IDEMPOTENCY_CONFLICT",
        });
      },
    },
  });

  await assert.rejects(
    service.decideRegistryVersion(adminScope(), decisionInput()),
    (error) =>
      error?.code === "IDEMPOTENCY_CONFLICT"
      && error?.statusCode === 409
      && error?.retryable === false,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof UpdateRegistryRecordStatusCommand,
    ).length,
    1,
  );
  assert.equal(harness.audits.length, 0);
});

test("createDomain provisions the exact Registry and persists a durable ACTIVE domain", async () => {
  const harness = createHarness();
  const service = await serviceFor(harness);

  const result = await service.createDomain(adminScope(), input({
    name: "  Finance Operations  ",
    owner: "",
    ownerGroup: "",
    description: " ",
    tokenBudget: "24000",
  }));

  const registryId = "FinanceReg1234";
  const registryArn =
    `arn:aws:agent-registry:${REGION}:${ACCOUNT}:registry/${registryId}`;
  const expected = successResult({
    id: "finance_operations",
    name: "Finance Operations",
    owner: "Finance Operations domain team",
    ownerGroup: "domain-finance-operations",
    description: "Finance Operations domain agents.",
    tokenBudget: 24000,
    registryId,
    registryArn,
  });
  const expectedFingerprint = fingerprint(normalizedPayload({
    id: "finance_operations",
    name: "Finance Operations",
    owner: "Finance Operations domain team",
    ownerGroup: "domain-finance-operations",
    description: "Finance Operations domain agents.",
    tokenBudget: 24000,
  }));
  assert.deepEqual(result, expected);
  assert.equal(harness.calls[0][0], "getRequestResult");
  assert.deepEqual(harness.calls[0][1], {
    actor: "admin-sub-123",
    route: ROUTE,
    requestId: "request-123",
  });
  assert.deepEqual(harness.calls[1], ["getDomain", "finance_operations"]);
  assert.equal(harness.calls[2][0], "claimDomainRequest");
  assert.deepEqual(harness.calls[2][1], {
    actor: "admin-sub-123",
    route: ROUTE,
    requestId: "request-123",
    payloadFingerprint: expectedFingerprint,
    ownerToken: harness.calls[2][1].ownerToken,
    claimExpiresAt: NOW_EPOCH + CLAIM_TTL_SECONDS,
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
  });
  assert.match(harness.calls[2][1].ownerToken, /^[a-f0-9-]{36}$/);
  assert.equal(harness.calls[3][0], "registry");
  assert.ok(harness.calls[3][1] instanceof CreateRegistryCommand);
  const expectedToken = createHash("sha256")
    .update("admin-sub-123\nrequest-123\nfinance_operations")
    .digest("hex");
  const expectedGroupToken = createHash("sha256")
    .update(`cognito-domain-group:v2\n${expectedToken}`)
    .digest("hex");
  assert.deepEqual(harness.calls[3][1].input, {
    name: "domain_finance_operations",
    description: "Finance Operations domain registry",
    clientToken: expectedToken,
    tags: TAGS,
  });
  assert.equal(harness.calls[4][0], "registry");
  assert.ok(harness.calls[4][1] instanceof GetRegistryCommand);
  assert.deepEqual(harness.calls[4][1].input, {
    registryId,
  });
  assert.deepEqual(harness.calls[5], [
    "domainDirectory.ensureGroup",
    "domain-finance-operations",
    expectedGroupToken,
  ]);
  assert.deepEqual(harness.calls[6], [
    "putDomainWithRequestResult",
    {
      domain: expected.domain,
      requestResult: requestResult({
        kind: "DOMAIN_CREATE",
        status: "SUCCEEDED",
        payloadFingerprint: expectedFingerprint,
        domain: expected.domain,
      }),
      claim: {
        payloadFingerprint: expectedFingerprint,
        ownerToken: harness.calls[2][1].ownerToken,
      },
    },
  ]);
  assert.equal(harness.calls.length, 7);
});

test("domainGroupOperationToken is deterministic and domain-separated from the Registry token", async () => {
  const { domainGroupOperationToken } = await loadServiceModule();
  const identity = {
    actor: "admin-sub-123",
    requestId: "request-123",
  };
  const registryToken = createHash("sha256")
    .update("admin-sub-123\nrequest-123\nfinance")
    .digest("hex");
  const expected = createHash("sha256")
    .update(`cognito-domain-group:v2\n${registryToken}`)
    .digest("hex");

  assert.equal(
    domainGroupOperationToken(identity, "finance"),
    expected,
  );
  assert.equal(
    domainGroupOperationToken(identity, "finance"),
    expected,
  );
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.notEqual(expected, registryToken);
  assert.notEqual(
    domainGroupOperationToken({
      actor: identity.actor,
      requestId: "request-456",
    }, "finance"),
    expected,
  );
  assert.notEqual(
    domainGroupOperationToken(identity, "finance_operations"),
    expected,
  );
});

test("createDomain fails closed and compensates only its Registry when the owner group is foreign", async () => {
  const harness = createHarness();
  harness.domainDirectory.ensureGroup = async (
    ownerGroup,
    operationToken,
  ) => {
    harness.calls.push([
      "domainDirectory.ensureGroup",
      ownerGroup,
      operationToken,
    ]);
    throw Object.assign(new Error("foreign group"), {
      code: "DOMAIN_GROUP_CONFLICT",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_CONFLICT"
      && error?.statusCode === 409
      && error?.retryable === false,
  );

  const fence = harness.calls.find(
    ([method]) => method === "markDomainRequestConflict",
  );
  assert.deepEqual(fence?.[1].cleanup, {
    registryId: REGISTRY_ID,
    registryArn: REGISTRY_ARN,
  });
  assert.equal(
    harness.calls.some(
      ([method]) => method === "domainDirectory.deleteGroupExact",
    ),
    false,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    1,
  );
  assert.equal(harness.domains.length, 0);
});

test("a same-domain different-request group collision cannot delete the winner group", async () => {
  const harness = createHarness();
  const loserScope = adminScope({ requestId: "request-456" });
  const loserRegistryToken = createHash("sha256")
    .update("admin-sub-123\nrequest-456\nfinance")
    .digest("hex");
  const loserToken = createHash("sha256")
    .update(`cognito-domain-group:v2\n${loserRegistryToken}`)
    .digest("hex");
  harness.domainDirectory.ensureGroup = async (
    ownerGroup,
    operationToken,
  ) => {
    harness.calls.push([
      "domainDirectory.ensureGroup",
      ownerGroup,
      operationToken,
    ]);
    assert.equal(ownerGroup, "domain-finance");
    assert.equal(operationToken, loserToken);
    assert.notEqual(operationToken, FINANCE_GROUP_OPERATION_TOKEN);
    throw Object.assign(new Error("winner owns group"), {
      code: "DOMAIN_GROUP_CONFLICT",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(loserScope, input()),
    (error) => error?.code === "DOMAIN_CONFLICT",
  );

  assert.equal(
    harness.calls.some(
      ([method]) => method === "domainDirectory.deleteGroupExact",
    ),
    false,
  );
  assert.deepEqual(
    harness.calls.find(
      ([method]) => method === "markDomainRequestConflict",
    )?.[1].cleanup,
    {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
    },
  );
});

test("createDomain keeps a ready Registry retryable when Cognito group provisioning is unavailable", async () => {
  const harness = createHarness();
  harness.domainDirectory.ensureGroup = async (
    ownerGroup,
    operationToken,
  ) => {
    harness.calls.push([
      "domainDirectory.ensureGroup",
      ownerGroup,
      operationToken,
    ]);
    throw new Error("TOP-SECRET Cognito failure");
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );

  assert.deepEqual(
    harness.storedRequest(),
    requestResult(storedClaim("FAILED_RETRYABLE", {
      registry: {
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
      },
    })),
  );
  assert.equal(
    harness.calls.some(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ),
    false,
  );
  assert.equal(harness.domains.length, 0);
});

test("domain conflict compensation deletes the exact managed owner group before the Registry", async () => {
  const harness = createHarness();
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "putDomainWithRequestResult",
      structuredClone(value),
    ]);
    throw Object.assign(new Error("domain exists"), {
      code: "DOMAIN_CONFLICT",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) => error?.code === "DOMAIN_CONFLICT",
  );

  const fence = harness.calls.find(
    ([method]) => method === "markDomainRequestConflict",
  );
  assert.deepEqual(fence?.[1].cleanup, {
    registryId: REGISTRY_ID,
    registryArn: REGISTRY_ARN,
    ownerGroup: {
      name: "domain-finance",
      operationToken: FINANCE_GROUP_OPERATION_TOKEN,
    },
  });
  const deleteGroupIndex = harness.calls.findIndex(
    ([method]) => method === "domainDirectory.deleteGroupExact",
  );
  const deleteRegistryIndex = harness.calls.findIndex(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  assert.notEqual(deleteGroupIndex, -1);
  assert.ok(deleteGroupIndex < deleteRegistryIndex);
  assert.deepEqual(harness.calls[deleteGroupIndex], [
    "domainDirectory.deleteGroupExact",
    "domain-finance",
    FINANCE_GROUP_OPERATION_TOKEN,
  ]);
});

test("pending domain cleanup removes an exact managed owner group before its Registry", async () => {
  const cleanup = ownedCleanup();
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(storedPendingConflict({
      cleanup,
    })),
  });

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) => error?.code === "DOMAIN_CONFLICT",
  );

  assert.equal(harness.calls[0][0], "getRequestResult");
  assert.equal(harness.calls[1][0], "claimDomainRequestCleanup");
  assert.deepEqual(harness.calls[2], [
    "domainDirectory.deleteGroupExact",
    "domain-finance",
    FINANCE_GROUP_OPERATION_TOKEN,
  ]);
  assert.equal(harness.calls[3][0], "registry");
  assert.ok(harness.calls[3][1] instanceof DeleteRegistryCommand);
  assert.equal(harness.calls[4][0], "markDomainRequestCleanupComplete");
});

test("pending cleanup rejects well-formed ownership from another domain or request", async () => {
  const foreignOwnership = [
    {
      name: "domain-operations",
      operationToken: OPERATIONS_GROUP_OPERATION_TOKEN,
    },
    {
      name: "domain-finance",
      operationToken: OTHER_REQUEST_FINANCE_GROUP_OPERATION_TOKEN,
    },
  ];

  for (const ownerGroup of foreignOwnership) {
    const harness = createHarness({
      priorRequestResult: permanentRequestResult(storedPendingConflict({
        cleanup: ownedCleanup("PENDING", { ownerGroup }),
      })),
    });

    await assert.rejects(
      (await serviceFor(harness)).createDomain(adminScope(), input()),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
    );
    assert.deepEqual(
      harness.calls.map(([method]) => method),
      ["getRequestResult"],
    );
  }
});

test("an unexpired CLEANING lease performs no destructive call", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(storedPendingConflict({
      cleanup: cleaningOwnedCleanup(),
    })),
  });

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true,
  );
  assert.deepEqual(
    harness.calls.map(([method]) => method),
    ["getRequestResult"],
  );
});

test("an expired CLEANING lease is taken over before exact deletion", async () => {
  const expiredCleanup = cleaningOwnedCleanup({
    cleanupClaimExpiresAt: NOW_EPOCH - 1,
  });
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(storedPendingConflict({
      cleanup: expiredCleanup,
    })),
  });

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) => error?.code === "DOMAIN_CONFLICT",
  );
  assert.equal(harness.calls[1][0], "claimDomainRequestCleanup");
  assert.deepEqual(harness.calls[1][1].cleanup, expiredCleanup);
  assert.deepEqual(harness.calls[2], [
    "domainDirectory.deleteGroupExact",
    "domain-finance",
    FINANCE_GROUP_OPERATION_TOKEN,
  ]);
});

test("provisioning cleanup rejects an otherwise-valid owned group target", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(
      storedPendingProvisioningCleanup({
        cleanup: ownedCleanup(),
      }),
    ),
  });

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "IDEMPOTENCY_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.deepEqual(
    harness.calls.map(([method]) => method),
    ["getRequestResult"],
  );
});

test("createDomain persists ACTIVE only after the exact Registry is READY", async () => {
  const harness = createHarness();
  const registryStatuses = ["CREATING", "READY"];
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    assert.ok(command instanceof GetRegistryCommand);
    return {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: registryStatuses.shift(),
    };
  };

  const result = await (await serviceFor(harness, {
    domainPollAttempts: 2,
    domainPollDelayMs: 0,
  })).createDomain(adminScope(), input());

  assert.deepEqual(result, successResult());
  assert.deepEqual(registryStatuses, []);
  assert.deepEqual(
    harness.calls
      .filter(([method]) => method === "registry")
      .map(([, command]) => command.constructor.name),
    [
      "CreateRegistryCommand",
      "GetRegistryCommand",
      "GetRegistryCommand",
    ],
  );
  const readyIndex = harness.calls.findLastIndex(
    ([method, command]) =>
      method === "registry"
      && command instanceof GetRegistryCommand,
  );
  const persistIndex = harness.calls.findIndex(
    ([method]) => method === "putDomainWithRequestResult",
  );
  assert.ok(readyIndex < persistIndex);
});

test("createDomain default readiness window accepts an eleventh-poll READY Registry", async () => {
  const harness = createHarness();
  let readinessPolls = 0;
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    if (command instanceof DeleteRegistryCommand) return {};
    assert.ok(command instanceof GetRegistryCommand);
    readinessPolls += 1;
    return {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: readinessPolls === 11 ? "READY" : "CREATING",
    };
  };

  const result = await (await serviceFor(harness, {
    sleep: async () => {},
  })).createDomain(
    adminScope(),
    input(),
  );

  assert.deepEqual(result, successResult());
  assert.equal(readinessPolls, 11);
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    0,
  );
});

const registryReadinessFailureCases = [
  {
    name: "a mismatched registryId",
    outcome: {
      registryId: "OtherReg12345",
      registryArn: REGISTRY_ARN,
      status: "READY",
    },
  },
  {
    name: "a mismatched registryArn",
    outcome: {
      registryId: REGISTRY_ID,
      registryArn:
        `arn:aws:agent-registry:${REGION}:999922223333:`
        + `registry/${REGISTRY_ID}`,
      status: "READY",
    },
  },
  {
    name: "missing required identity fields",
    outcome: {
      status: "READY",
    },
  },
  {
    name: "an unknown status",
    outcome: {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: "UNKNOWN",
    },
  },
  {
    name: "an SDK rejection",
    outcome: new Error("TOP-SECRET Registry Get failure"),
  },
];

for (const scenario of registryReadinessFailureCases) {
  test(`createDomain GetRegistry polling fails closed for ${scenario.name}`, async () => {
    const harness = createHarness();
    harness.registry.send = async (command) => {
      harness.calls.push(["registry", command]);
      if (command instanceof CreateRegistryCommand) {
        return { registryArn: REGISTRY_ARN };
      }
      if (command instanceof DeleteRegistryCommand) return {};
      assert.ok(command instanceof GetRegistryCommand);
      if (scenario.outcome instanceof Error) throw scenario.outcome;
      return structuredClone(scenario.outcome);
    };

    await assert.rejects(
      (await serviceFor(harness, {
        domainPollAttempts: 3,
        domainPollDelayMs: 0,
      })).createDomain(adminScope(), input()),
      (error) => {
        assert.deepEqual(
          {
            code: error?.code,
            message: error?.message,
            retryable: error?.retryable,
            statusCode: error?.statusCode,
          },
          {
            code: "DOMAIN_PROVISIONING_FAILED",
            message: "Domain provisioning is temporarily unavailable.",
            retryable: true,
            statusCode: 503,
          },
        );
        return true;
      },
    );

    assert.equal(harness.domains.length, 0);
    assert.deepEqual(
      harness.storedRequest(),
      requestResult(storedClaim("FAILED_RETRYABLE")),
    );
    assert.equal(
      harness.calls.filter(
        ([method, command]) =>
          method === "registry"
          && command instanceof GetRegistryCommand,
      ).length,
      1,
    );
    assert.equal(
      harness.calls.some(
        ([method]) => method === "putDomainWithRequestResult",
      ),
      false,
    );
    assert.equal(
      harness.calls.filter(
        ([method, command]) =>
          method === "registry"
          && command instanceof DeleteRegistryCommand,
      ).length,
      1,
    );
  });
}

test("createDomain returns a retryable failure when Registry remains CREATING", async () => {
  const harness = createHarness();
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    if (command instanceof DeleteRegistryCommand) return {};
    assert.ok(command instanceof GetRegistryCommand);
    return {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: "CREATING",
    };
  };

  await assert.rejects(
    (await serviceFor(harness, {
      domainPollAttempts: 3,
      domainPollDelayMs: 0,
    })).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true,
  );

  assert.equal(harness.domains.length, 0);
  assert.deepEqual(
    harness.storedRequest(),
    requestResult(storedClaim("FAILED_RETRYABLE", {
      registry: {
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
      },
    })),
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof GetRegistryCommand,
    ).length,
    3,
  );
  assert.equal(
    harness.calls.some(
      ([method]) => method === "putDomainWithRequestResult",
    ),
    false,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    0,
  );
});

test("createDomain resumes an exact retryable Registry without creating another", async () => {
  const harness = createHarness();
  let readinessPolls = 0;
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    assert.ok(command instanceof GetRegistryCommand);
    readinessPolls += 1;
    return {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: readinessPolls > 2 ? "READY" : "CREATING",
    };
  };
  const service = await serviceFor(harness, {
    domainPollAttempts: 2,
    domainPollDelayMs: 0,
  });

  await assert.rejects(
    service.createDomain(adminScope(), input()),
    (error) => error?.code === "DOMAIN_PROVISIONING_FAILED",
  );
  assert.deepEqual(
    await service.createDomain(adminScope(), input()),
    successResult(),
  );
  assert.equal(
    harness.calls.filter(([, command]) =>
      command instanceof CreateRegistryCommand
    ).length,
    1,
  );
  assert.equal(
    harness.calls.filter(([, command]) =>
      command instanceof DeleteRegistryCommand
    ).length,
    0,
  );
  const resumedClaim = harness.calls.filter(
    ([method]) => method === "claimDomainRequest",
  ).at(-1)[1];
  assert.deepEqual(resumedClaim.registry, {
    registryId: REGISTRY_ID,
    registryArn: REGISTRY_ARN,
  });
});

test("createDomain resumes an expired in-progress Registry target", async () => {
  const harness = createHarness({
    priorRequestResult: requestResult(storedClaim("IN_PROGRESS", {
      claimExpiresAt: NOW_EPOCH - 1,
      registry: {
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
      },
    })),
  });
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    assert.ok(command instanceof GetRegistryCommand);
    return {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: "READY",
    };
  };

  assert.deepEqual(
    await (await serviceFor(harness, {
      domainPollAttempts: 1,
      domainPollDelayMs: 0,
    })).createDomain(adminScope(), input()),
    successResult(),
  );
  assert.equal(
    harness.calls.some(([, command]) =>
      command instanceof CreateRegistryCommand
    ),
    false,
  );
  assert.deepEqual(
    harness.calls.find(
      ([method]) => method === "claimDomainRequest",
    )[1].registry,
    {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
    },
  );
});

test("createDomain returns a retryable failure when Registry reports CREATE_FAILED", async () => {
  const harness = createHarness();
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    if (command instanceof DeleteRegistryCommand) return {};
    assert.ok(command instanceof GetRegistryCommand);
    return {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: "CREATE_FAILED",
    };
  };

  await assert.rejects(
    (await serviceFor(harness, {
      domainPollAttempts: 3,
      domainPollDelayMs: 0,
    })).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true,
  );

  assert.equal(harness.domains.length, 0);
  assert.deepEqual(
    harness.storedRequest(),
    requestResult(storedClaim("FAILED_RETRYABLE")),
  );
  const fenceIndex = harness.calls.findIndex(
    ([method]) =>
      method === "markDomainRequestProvisioningCleanupPending",
  );
  const deleteIndex = harness.calls.findIndex(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  assert.notEqual(fenceIndex, -1);
  assert.ok(fenceIndex < deleteIndex);
  assert.deepEqual(
    harness.calls[fenceIndex][1].cleanup,
    {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
    },
  );
  assert.deepEqual(
    harness.calls[deleteIndex][1].input,
    { registryId: REGISTRY_ID },
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof GetRegistryCommand,
    ).length,
    1,
  );
  assert.equal(
    harness.calls.some(
      ([method]) => method === "putDomainWithRequestResult",
    ),
    false,
  );
});

test("pending provisioning cleanup deletes only the exact target before a later retry provisions again", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(
      storedPendingProvisioningCleanup(),
    ),
  });
  const service = await serviceFor(harness);

  await assert.rejects(
    service.createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true,
  );
  assert.deepEqual(
    harness.calls.map(([method, command]) => [
      method,
      command?.constructor?.name,
    ]),
    [
      ["getRequestResult", "Object"],
      ["claimDomainRequestCleanup", "Object"],
      ["registry", "DeleteRegistryCommand"],
      ["markDomainRequestCleanupComplete", "Object"],
    ],
  );
  assert.deepEqual(
    harness.calls[2][1].input,
    { registryId: REGISTRY_ID },
  );
  assert.deepEqual(
    harness.storedRequest(),
    requestResult(storedClaim("FAILED_RETRYABLE")),
  );

  assert.deepEqual(
    await service.createDomain(adminScope(), input()),
    successResult(),
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    1,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof CreateRegistryCommand,
    ).length,
    1,
  );
});

test("provisioning cleanup delete failure leaves the exact pending fence without leaking details", async () => {
  const harness = createHarness();
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    if (command instanceof GetRegistryCommand) {
      return {
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
        status: "CREATE_FAILED",
      };
    }
    throw new Error("TOP-SECRET provisioning cleanup delete failure");
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );
  assert.deepEqual(
    harness.storedRequest(),
    permanentRequestResult(storedPendingProvisioningCleanup()),
  );
  assert.equal(
    harness.calls.some(
      ([method]) => method === "markDomainRequestCleanupComplete",
    ),
    false,
  );
});

test("provisioning cleanup completion failure leaves the exact CLEANING lease", async () => {
  const harness = createHarness();
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    if (command instanceof GetRegistryCommand) {
      return {
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
        status: "CREATE_FAILED",
      };
    }
    return {};
  };
  harness.state.markDomainRequestCleanupComplete = async (transition) => {
    harness.calls.push([
      "markDomainRequestCleanupComplete",
      structuredClone(transition),
    ]);
    throw new Error("TOP-SECRET provisioning completion failure");
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );
  const stored = harness.storedRequest();
  assert.equal(stored?.result?.cleanup?.status, "CLEANING");
  assert.match(
    stored?.result?.cleanup?.cleanupExecutionToken,
    /^[a-f0-9-]{36}$/,
  );
  assert.equal(
    stored?.result?.cleanup?.cleanupClaimExpiresAt,
    NOW_EPOCH + CLEANUP_LEASE_SECONDS,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    1,
  );
});

test("malformed pending provisioning cleanup fails closed without Registry deletion", async () => {
  const corruptResults = [
    storedPendingProvisioningCleanup({
      cleanup: {
        ...storedPendingProvisioningCleanup().cleanup,
        registryId: "ChangedReg1234",
      },
    }),
    storedPendingProvisioningCleanup({
      cleanup: {
        ...storedPendingProvisioningCleanup().cleanup,
        extra: "unsafe",
      },
    }),
    storedPendingProvisioningCleanup({ code: "OTHER_FAILURE" }),
  ];

  for (const corrupt of corruptResults) {
    const harness = createHarness({
      priorRequestResult: permanentRequestResult(corrupt),
    });
    await assert.rejects(
      (await serviceFor(harness)).createDomain(adminScope(), input()),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }
});

test("createDomain replays only a valid success bound to the same payload", async () => {
  const success = successResult();
  const successHarness = createHarness({
    priorRequestResult: requestResult(storedSuccess(success.domain)),
  });
  assert.deepEqual(
    await (await serviceFor(successHarness)).createDomain(
      adminScope(),
      input(),
    ),
    success,
  );
  assert.deepEqual(
    successHarness.calls.map(([method]) => method),
    ["getRequestResult"],
  );

  const conflictHarness = createHarness({
    priorRequestResult: requestResult(storedSuccess(success.domain)),
  });
  await assert.rejects(
    (await serviceFor(conflictHarness)).createDomain(
      adminScope(),
      input({ owner: "Different team" }),
    ),
    (error) =>
      error?.code === "IDEMPOTENCY_CONFLICT"
      && error?.statusCode === 409,
  );
  assert.deepEqual(
    conflictHarness.calls.map(([method]) => method),
    ["getRequestResult"],
  );
});

test("createDomain replays only the exact terminal domain conflict shape", async () => {
  const terminalHarness = createHarness({
    priorRequestResult: requestResult(storedFinalConflict()),
  });
  await assert.rejects(
    (await serviceFor(terminalHarness)).createDomain(
      adminScope(),
      input(),
    ),
    (error) =>
      error?.code === "DOMAIN_CONFLICT"
      && error?.statusCode === 409
      && error?.retryable === false,
  );
  assert.deepEqual(
    terminalHarness.calls.map(([method]) => method),
    ["getRequestResult"],
  );

  for (const corrupt of [
    storedFinalConflict({ code: "OTHER_CONFLICT" }),
    storedFinalConflict({ extra: "unsafe" }),
    {
      kind: "DOMAIN_CREATE",
      status: "FAILED_FINAL",
      payloadFingerprint: fingerprint(),
    },
  ]) {
    const corruptHarness = createHarness({
      priorRequestResult: requestResult(corrupt),
    });
    await assert.rejects(
      (await serviceFor(corruptHarness)).createDomain(
        adminScope(),
        input(),
      ),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
    );
    assert.deepEqual(
      corruptHarness.calls.map(([method]) => method),
      ["getRequestResult"],
    );
  }
});

test("createDomain retries only an exact pending cleanup target before any new provisioning", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(storedPendingConflict()),
  });
  const service = await serviceFor(harness);

  await assert.rejects(
    service.createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_CONFLICT"
      && error?.statusCode === 409
      && error?.retryable === false,
  );
  assert.deepEqual(
    harness.calls.map(([method, command]) => [
      method,
      command?.constructor?.name,
    ]),
    [
      ["getRequestResult", "Object"],
      ["claimDomainRequestCleanup", "Object"],
      ["registry", "DeleteRegistryCommand"],
      ["markDomainRequestCleanupComplete", "Object"],
    ],
  );
  assert.deepEqual(
    harness.storedRequest(),
    requestResult(storedFinalConflict()),
  );

  await assert.rejects(
    service.createDomain(adminScope(), input()),
    (error) => error?.code === "DOMAIN_CONFLICT",
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    1,
  );
});

test("an exact Registry ResourceNotFound response completes pending cleanup", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(storedPendingConflict()),
  });
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    throw new ResourceNotFoundException({
      $metadata: {},
      message: "Registry is already absent.",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) => error?.code === "DOMAIN_CONFLICT",
  );
  assert.equal(
    harness.storedRequest().result.cleanup.status,
    "COMPLETE",
  );
});

test("a ResourceNotFound lookalike does not complete pending cleanup", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(storedPendingConflict()),
  });
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    throw Object.assign(new Error("TOP-SECRET missing response"), {
      name: "ResourceNotFoundException",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );
  assert.equal(
    harness.storedRequest().result.cleanup.status,
    "PENDING",
  );
  assert.equal(
    harness.calls.some(
      ([method]) => method === "markDomainRequestCleanupComplete",
    ),
    false,
  );
});

test("malformed pending cleanup state fails closed without Registry deletion", async () => {
  const corruptResults = [
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        extra: "unsafe",
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        status: "UNKNOWN",
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        registryArn:
          `arn:aws:agent-registry:us-east-1:${ACCOUNT}:`
          + `registry/${REGISTRY_ID}`,
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        registryArn:
          `arn:aws:agent-registry:${REGION}:999922223333:`
          + `registry/${REGISTRY_ID}`,
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        registryId: "ChangedReg1234",
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        ownerGroup: "domain-finance",
      },
    }),
    storedPendingConflict({
      cleanup: ownedCleanup("PENDING", {
        ownerGroup: {
          name: "domain-finance",
          operationToken: "A".repeat(64),
        },
      }),
    }),
    storedPendingConflict({
      cleanup: ownedCleanup("PENDING", {
        ownerGroup: {
          name: "domain-finance",
          operationToken: FINANCE_GROUP_OPERATION_TOKEN,
          actor: "admin-sub-123",
        },
      }),
    }),
    storedPendingConflict({
      cleanup: ownedCleanup("PENDING", {
        ownerGroup: {
          name: "platform-admin",
          operationToken: FINANCE_GROUP_OPERATION_TOKEN,
        },
      }),
    }),
    storedPendingConflict({ extra: "unsafe" }),
  ];

  for (const corrupt of corruptResults) {
    const harness = createHarness({
      priorRequestResult: permanentRequestResult(corrupt),
    });
    await assert.rejects(
      (await serviceFor(harness)).createDomain(adminScope(), input()),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }
});

test("real state decoding maps corrupt persisted cleanup requests to idempotency conflict without Registry calls", async () => {
  const corruptResults = [
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        extra: "unsafe",
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        registryArn:
          `arn:aws:agent-registry:us-east-1:${ACCOUNT}:`
          + `registry/${REGISTRY_ID}`,
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        registryArn:
          `arn:aws:agent-registry:${REGION}:999922223333:`
          + `registry/${REGISTRY_ID}`,
      },
    }),
    storedPendingConflict({
      cleanup: {
        ...storedPendingConflict().cleanup,
        status: "UNKNOWN",
      },
    }),
    storedPendingConflict({
      cleanup: {
        status: "PENDING",
        registryId: REGISTRY_ID,
      },
    }),
  ];

  for (const result of corruptResults) {
    const registryCalls = [];
    const dynamo = {
      async send() {
        return { Item: permanentDomainRequestItem(result) };
      },
    };
    const state = createPlatformState({
      tableName: "PlatformState",
      dynamo,
      now: () => NOW,
    });
    const registry = {
      async send(command) {
        registryCalls.push(command);
        throw new Error("Registry must not be called.");
      },
    };

    await assert.rejects(
      (await serviceFor({ state, registry })).createDomain(
        adminScope(),
        input(),
      ),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409
        && error?.retryable === false,
    );
    assert.equal(registryCalls.length, 0);
  }
});

test("real state operational and domain-table failures remain non-idempotency errors without Registry calls", async () => {
  const transportFailure = Object.assign(
    new Error("TOP-SECRET DynamoDB transport failure"),
    {
      name: "MalformedRequestResultItemError",
      code: "MALFORMED_REQUEST_RESULT_ITEM",
    },
  );
  const transportRegistryCalls = [];
  const transportState = createPlatformState({
    tableName: "PlatformState",
    dynamo: {
      async send() {
        throw transportFailure;
      },
    },
    now: () => NOW,
  });
  await assert.rejects(
    (await serviceFor({
      state: transportState,
      registry: {
        async send(command) {
          transportRegistryCalls.push(command);
          return {};
        },
      },
    })).createDomain(adminScope(), input()),
    (error) => error === transportFailure,
  );
  assert.equal(transportRegistryCalls.length, 0);

  let reads = 0;
  const domainRegistryCalls = [];
  const malformedDomainState = createPlatformState({
    tableName: "PlatformState",
    dynamo: {
      async send() {
        reads += 1;
        if (reads === 1) return {};
        return {
          Item: {
            pk: { S: "DOMAIN" },
            sk: { S: "DOMAIN#finance" },
          },
        };
      },
    },
    now: () => NOW,
  });
  await assert.rejects(
    (await serviceFor({
      state: malformedDomainState,
      registry: {
        async send(command) {
          domainRegistryCalls.push(command);
          return {};
        },
      },
    })).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "MALFORMED_DYNAMODB_RESPONSE"
      && error?.code !== "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(domainRegistryCalls.length, 0);
});

test("pending cleanup requires the same request identity and payload fingerprint", async () => {
  const cases = [
    permanentRequestResult(storedPendingConflict(), {
      actor: "different-admin",
    }),
    permanentRequestResult(storedPendingConflict(), {
      route: "POST /api/other",
    }),
    permanentRequestResult(storedPendingConflict(), {
      requestId: "different-request",
    }),
    permanentRequestResult(storedPendingConflict({
      payloadFingerprint: fingerprint({
        ...normalizedPayload(),
        owner: "Different domain team",
      }),
    })),
    requestResult(storedPendingConflict()),
  ];

  for (const priorRequestResult of cases) {
    const harness = createHarness({ priorRequestResult });
    await assert.rejects(
      (await serviceFor(harness)).createDomain(adminScope(), input()),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }
});

test("createDomain selects hosted acceptance tags only from exact trusted verifier identity", async () => {
  const hostedHarness = createHarness({
    registryResponse: {
      registryArn:
        `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
        + "registry/HostedReg1234",
    },
  });
  await (await serviceFor(hostedHarness)).createDomain(
    adminScope({
      username: "hosted-acceptance-admin-12345-2",
      requestId: "01f7f12b-a9eb-4cf9-95a5-9cfa252958e1",
    }),
    input({ name: "Hosted Acceptance 12345 2" }),
  );
  const hostedCreate = hostedHarness.calls.find(
    ([method]) => method === "registry",
  )[1];
  assert.deepEqual(hostedCreate.input.tags, HOSTED_ACCEPTANCE_TAGS);
  assert.equal(
    hostedCreate.input.name,
    "domain_hosted_acceptance_12345_2",
  );

  const roleSwitchingHarness = createHarness({
    registryResponse: {
      registryArn:
        `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
        + "registry/RoleSwitch1234",
    },
  });
  await (await serviceFor(roleSwitchingHarness)).createDomain(
    adminScope({
      username: "hosted-role-switching-admin-12345-2",
      requestId: "01f7f12b-a9eb-4cf9-95a5-9cfa252958e1",
    }),
    input({ name: "Hosted Acceptance 12345 2" }),
  );
  const roleSwitchingCreate = roleSwitchingHarness.calls.find(
    ([method]) => method === "registry",
  )[1];
  assert.deepEqual(
    roleSwitchingCreate.input.tags,
    HOSTED_ACCEPTANCE_TAGS,
  );

  const normalHarness = createHarness({
    registryResponse: {
      registryArn:
        `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
        + "registry/NormalReg1234",
    },
  });
  await (await serviceFor(normalHarness)).createDomain(
    adminScope({ username: "ordinary-platform-admin" }),
    input({ name: "Hosted Acceptance 12345 2" }),
  );
  const normalCreate = normalHarness.calls.find(
    ([method]) => method === "registry",
  )[1];
  assert.deepEqual(normalCreate.input.tags, TAGS);
});

test("createDomain fails closed for partial hosted verifier classification", async () => {
  for (const [scope, body] of [
    [
      adminScope({
        username: "hosted-acceptance-admin-12345-2",
        requestId: "wrong-request-id",
      }),
      input({ name: "Hosted Acceptance 12345 2" }),
    ],
    [
      adminScope({
        username: "hosted-acceptance-admin-12345-2",
        requestId: "01f7f12b-a9eb-4cf9-95a5-9cfa252958e1",
      }),
      input({ name: "Hosted Acceptance 12345 3" }),
    ],
    [
      adminScope({
        username: "hosted-role-switching-admin-12345-2",
        requestId: "wrong-request-id",
      }),
      input({ name: "Hosted Acceptance 12345 2" }),
    ],
  ]) {
    const harness = createHarness();
    await assert.rejects(
      (await serviceFor(harness)).createDomain(scope, body),
      (error) =>
        error?.code === "INVALID_DOMAIN"
        && error?.statusCode === 400,
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }
});

test("createDomain rejects untrusted scope, body control fields, and existing domains before Registry mutation", async () => {
  const invalidCases = [
    [adminScope({ role: "builder" }), input(), "FORBIDDEN", 403],
    [adminScope({ actor: "" }), input(), "INVALID_REQUEST", 400],
    [adminScope({ requestId: " request " }), input(), "INVALID_REQUEST", 400],
    [adminScope(), input({ role: "admin" }), "INVALID_DOMAIN", 400],
    [adminScope(), input({ domain: "platform" }), "INVALID_DOMAIN", 400],
    [adminScope(), input({ capability: "createDomain" }), "INVALID_DOMAIN", 400],
  ];

  for (const [scope, body, code, statusCode] of invalidCases) {
    const harness = createHarness();
    await assert.rejects(
      (await serviceFor(harness)).createDomain(scope, body),
      (error) => error?.code === code && error?.statusCode === statusCode,
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }

  const existing = successResult().domain;
  const existingHarness = createHarness({ existingDomain: existing });
  await assert.rejects(
    (await serviceFor(existingHarness)).createDomain(
      adminScope(),
      input(),
    ),
    (error) =>
      error?.code === "DOMAIN_CONFLICT" && error?.statusCode === 409,
  );
  assert.deepEqual(
    existingHarness.calls.map(([method]) => method),
    ["getRequestResult", "getDomain"],
  );
});

test("createDomain validates names, owner metadata, descriptions, and token budgets", async () => {
  const invalidInputs = [
    {},
    { name: "" },
    { name: "A" },
    { name: "123 Finance" },
    { name: "Fínance" },
    { name: "Finance/Operations" },
    { name: "a".repeat(129) },
    { name: "a ".repeat(40) + "a".repeat(30) },
    { name: "Finance", owner: null },
    { name: "Finance", owner: " owner " },
    { name: "Finance", owner: "x".repeat(257) },
    { name: "Finance", ownerGroup: null },
    { name: "Finance", ownerGroup: "domain-other" },
    { name: "Finance", ownerGroup: "Domain-Finance" },
    { name: "Finance", description: null },
    { name: "Finance", description: " description " },
    { name: "Finance", description: "x".repeat(2049) },
    { name: "Finance", tokenBudget: 0 },
    { name: "Finance", tokenBudget: -1 },
    { name: "Finance", tokenBudget: 1.5 },
    { name: "Finance", tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
    { name: "Finance", tokenBudget: "0" },
    { name: "Finance", tokenBudget: "01" },
    { name: "Finance", tokenBudget: "1.0" },
    { name: "Finance", tokenBudget: "1e3" },
    { name: "Finance", tokenBudget: " 100 " },
    { name: "Builder" },
    { name: "Lead" },
    { name: "Platform Admin" },
    { name: "Domain Builder" },
    { name: "End User" },
    { name: "Demo Operator" },
  ];

  for (const invalidInput of invalidInputs) {
    const harness = createHarness();
    await assert.rejects(
      (await serviceFor(harness)).createDomain(
        adminScope(),
        invalidInput,
      ),
      (error) =>
        error?.code === "INVALID_DOMAIN" && error?.statusCode === 400,
      JSON.stringify(invalidInput),
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }

  for (const tokenBudget of [undefined, null, "", 1, "9007199254740991"]) {
    const harness = createHarness();
    const value = input({ tokenBudget });
    const result = await (await serviceFor(harness)).createDomain(
      adminScope(),
      value,
    );
    assert.equal(
      result.domain.tokenBudget,
      tokenBudget === undefined || tokenBudget === null || tokenBudget === ""
        ? null
        : Number(tokenBudget),
    );
  }
});

test("createDomain enforces the final 64-character Registry name boundary", async () => {
  const acceptedName = `A${"a".repeat(56)}`;
  const acceptedHarness = createHarness();
  const accepted = await (await serviceFor(acceptedHarness)).createDomain(
    adminScope(),
    input({ name: acceptedName }),
  );
  assert.equal(accepted.domain.id.length, 57);
  const registryCall = acceptedHarness.calls.find(
    ([method]) => method === "registry",
  );
  assert.equal(registryCall[1].input.name.length, 64);
  assert.equal(registryCall[1].input.name, `domain_${accepted.domain.id}`);

  const rejectedHarness = createHarness();
  await assert.rejects(
    (await serviceFor(rejectedHarness)).createDomain(
      adminScope(),
      input({ name: `A${"a".repeat(57)}` }),
    ),
    (error) =>
      error?.code === "INVALID_DOMAIN"
      && error?.statusCode === 400,
  );
  assert.equal(
    rejectedHarness.calls.some(([method]) => method === "registry"),
    false,
  );
});

test("createDomain requires the exact trusted deployment tags", async () => {
  for (const tags of [
    {},
    { ...TAGS, extra: "unsafe" },
    { ...TAGS, "auto-delete": "yes" },
    { ...TAGS, project: "other" },
    { ...TAGS, managedBy: "manual" },
  ]) {
    const harness = createHarness();
    await assert.rejects(
      async () => serviceFor(harness, { tags }),
      /mandatory deployment tags/i,
    );
  }
});

test("service configuration requires the atomic domain conflict fence", async () => {
  const harness = createHarness();
  delete harness.state.markDomainRequestConflict;

  await assert.rejects(
    serviceFor(harness),
    /Platform admin service dependencies are invalid/,
  );
});

test("service configuration requires the provisioning cleanup fence", async () => {
  const harness = createHarness();
  delete harness.state.markDomainRequestProvisioningCleanupPending;

  await assert.rejects(
    serviceFor(harness),
    /Platform admin service dependencies are invalid/,
  );
});

test("service configuration requires the exact cleanup completion transition", async () => {
  const harness = createHarness();
  delete harness.state.markDomainRequestCleanupComplete;

  await assert.rejects(
    serviceFor(harness),
    /Platform admin service dependencies are invalid/,
  );
});

test("service configuration requires commit fencing and cleanup lease transitions", async () => {
  for (const method of [
    "markDomainRequestCommitCleanupPending",
    "claimDomainRequestCleanup",
    "releaseDomainRequestCleanup",
  ]) {
    const harness = createHarness();
    delete harness.state[method];
    await assert.rejects(
      serviceFor(harness),
      /Platform admin service dependencies are invalid/,
    );
  }
});

test("service configuration accepts only commercial AWS regions", async () => {
  for (const region of [
    "cn-north-1",
    "us-gov-west-1",
    "us-iso-east-1",
    "us-isob-east-1",
    "eu-isoe-west-1",
    "us-isof-south-1",
    "eusc-de-east-1",
  ]) {
    const harness = createHarness();
    await assert.rejects(
      serviceFor(harness, { region }),
      /Platform region is invalid/,
      region,
    );
  }
});

test("Registry failures transition the owned claim to retryable state", async () => {
  const { PlatformAdminServiceError } = await loadServiceModule();
  const cases = [
    new Error("TOP-SECRET AWS failure"),
    null,
    {},
    { registryArn: "arn:aws:agent-registry:us-east-1:111122223333:registry/FinanceReg1234" },
    { registryArn: "arn:aws:agent-registry:us-west-2:999922223333:registry/FinanceReg1234" },
    { registryArn: "arn:aws-us-gov:agent-registry:us-west-2:111122223333:registry/FinanceReg1234" },
    { registryArn: "arn:aws:agent-registry:us-west-2:111122223333:registry/short" },
  ];

  for (const registryResponse of cases) {
    const harness = createHarness({ registryResponse });
    await assert.rejects(
      (await serviceFor(harness)).createDomain(adminScope(), input()),
      (error) =>
        error instanceof PlatformAdminServiceError
        && error.code === "DOMAIN_PROVISIONING_FAILED"
        && error.statusCode === 503
        && error.retryable === true
        && !error.message.includes("TOP-SECRET"),
    );
    assert.equal(harness.domains.length, 0);
    assert.equal(harness.results.length, 2);
    assert.equal(
      harness.results[0].result.status,
      "IN_PROGRESS",
    );
    assert.deepEqual(harness.results[1].result, {
      kind: "DOMAIN_CREATE",
      status: "FAILED_RETRYABLE",
      payloadFingerprint: fingerprint(),
    });
    assert.equal(
      harness.calls.filter(([method]) => method === "registry").length,
      1,
    );
  }
});

test("retryable transition is best effort and never leaks state errors", async () => {
  const harness = createHarness({
    registryResponse: new Error("TOP-SECRET AWS failure"),
  });
  harness.state.markDomainRequestRetryable = async (claim) => {
    harness.calls.push([
      "markDomainRequestRetryable",
      structuredClone(claim),
    ]);
    throw new Error("TOP-SECRET DynamoDB failure");
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && !error.message.includes("TOP-SECRET"),
  );
  assert.equal(harness.domains.length, 0);
});

test("a generic commit failure cleans its exact target and reuses the same group operation token", async () => {
  const { PlatformAdminServiceError } = await loadServiceModule();
  const harness = createHarness();
  const persist = harness.state.putDomainWithRequestResult.bind(harness.state);
  let writes = 0;
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "failedPutDomainWithRequestResult",
      structuredClone(value),
    ]);
    writes += 1;
    if (writes === 1) {
      throw new Error("TOP-SECRET DynamoDB failure");
    }
    return persist(value);
  };
  const service = await serviceFor(harness);

  await assert.rejects(
    service.createDomain(adminScope(), input()),
    (error) =>
      error instanceof PlatformAdminServiceError
      && error.code === "DOMAIN_PROVISIONING_FAILED"
      && error.statusCode === 503
      && error.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );
  assert.equal(harness.domains.length, 0);
  assert.equal(harness.results.at(-1).result.status, "FAILED_RETRYABLE");
  assert.equal(
    Object.hasOwn(harness.results.at(-1).result, "registry"),
    false,
  );

  assert.deepEqual(
    await service.createDomain(adminScope(), input()),
    successResult(),
  );
  const registryCalls = harness.calls.filter(
    ([method, command]) =>
      method === "registry"
      && command instanceof CreateRegistryCommand,
  );
  assert.equal(registryCalls.length, 2);
  const ensureCalls = harness.calls.filter(
    ([method]) => method === "domainDirectory.ensureGroup",
  );
  assert.deepEqual(ensureCalls, [
    [
      "domainDirectory.ensureGroup",
      "domain-finance",
      FINANCE_GROUP_OPERATION_TOKEN,
    ],
    [
      "domainDirectory.ensureGroup",
      "domain-finance",
      FINANCE_GROUP_OPERATION_TOKEN,
    ],
  ]);
  const deleteCalls = harness.calls.filter(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  assert.equal(deleteCalls.length, 1);
  assert.equal(harness.domains.length, 1);
});

test("a generic post-commit persistence error returns the durable winner without deleting its Registry", async () => {
  const harness = createHarness();
  const persist = harness.state.putDomainWithRequestResult.bind(harness.state);
  harness.state.putDomainWithRequestResult = async (value) => {
    await persist(value);
    throw new Error("TOP-SECRET DynamoDB timeout");
  };

  assert.deepEqual(
    await (await serviceFor(harness)).createDomain(adminScope(), input()),
    successResult(),
  );
  assert.equal(harness.domains.length, 1);
  assert.equal(
    harness.calls.some(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ),
    false,
  );
});

test("a generic post-commit persistence error survives a transient reconciliation read without deleting its Registry", async () => {
  const harness = createHarness();
  const persist = harness.state.putDomainWithRequestResult.bind(harness.state);
  const readStored = harness.state.getRequestResult.bind(harness.state);
  let committed = false;
  let reconciliationReads = 0;
  harness.state.getRequestResult = async (identity) => {
    if (committed) {
      reconciliationReads += 1;
      if (reconciliationReads === 1) {
        harness.calls.push([
          "getRequestResult",
          structuredClone(identity),
        ]);
        throw new Error("TOP-SECRET DynamoDB read timeout");
      }
    }
    return readStored(identity);
  };
  harness.state.putDomainWithRequestResult = async (value) => {
    await persist(value);
    committed = true;
    throw new Error("TOP-SECRET DynamoDB write timeout");
  };

  assert.deepEqual(
    await (await serviceFor(harness)).createDomain(adminScope(), input()),
    successResult(),
  );
  assert.equal(reconciliationReads, 2);
  assert.equal(
    harness.calls.some(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ),
    false,
  );
});

for (const [conflictCode, expectedCode, expectedStatus] of [
  ["DOMAIN_CONFLICT", "DOMAIN_CONFLICT", 409],
  ["REQUEST_CLAIM_CONFLICT", "DOMAIN_PROVISIONING_FAILED", 503],
]) {
  test(`${conflictCode} with a transient reconciliation failure never deletes a later durable winner`, async () => {
    const harness = createHarness();
    const persist =
      harness.state.putDomainWithRequestResult.bind(harness.state);
    const readStored = harness.state.getRequestResult.bind(harness.state);
    let committed = false;
    let reconciliationReads = 0;
    harness.state.getRequestResult = async (identity) => {
      if (committed) {
        reconciliationReads += 1;
        if (reconciliationReads === 1) {
          harness.calls.push([
            "getRequestResult",
            structuredClone(identity),
          ]);
          throw new Error("TOP-SECRET DynamoDB read timeout");
        }
      }
      return readStored(identity);
    };
    harness.state.putDomainWithRequestResult = async (value) => {
      await persist(value);
      committed = true;
      throw Object.assign(new Error("persistence conflict"), {
        code: conflictCode,
      });
    };
    const service = await serviceFor(harness);

    if (conflictCode === "DOMAIN_CONFLICT") {
      assert.deepEqual(
        await service.createDomain(adminScope(), input()),
        successResult(),
      );
    } else {
      await assert.rejects(
        service.createDomain(adminScope(), input()),
        (error) =>
          error?.code === expectedCode
          && error?.statusCode === expectedStatus,
      );
      assert.deepEqual(
        await service.createDomain(adminScope(), input()),
        successResult(),
      );
    }
    assert.equal(reconciliationReads, 2);
    assert.equal(
      harness.calls.some(
        ([method, command]) =>
          method === "registry"
          && command instanceof DeleteRegistryCommand,
      ),
      false,
    );
  });
}

test("an unresolved post-group commit failure fences exact permanent ownership before cleanup", async () => {
  const { PlatformAdminServiceError } = await loadServiceModule();
  const harness = createHarness();
  harness.domainDirectory.deleteGroupExact = async (
    ownerGroup,
    operationToken,
  ) => {
    harness.calls.push([
      "domainDirectory.deleteGroupExact",
      ownerGroup,
      operationToken,
    ]);
    throw new Error("TOP-SECRET Cognito delete failure");
  };
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "failedPutDomainWithRequestResult",
      structuredClone(value),
    ]);
    throw new Error("TOP-SECRET DynamoDB failure");
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error instanceof PlatformAdminServiceError
      && error.code === "DOMAIN_PROVISIONING_FAILED"
      && error.statusCode === 503
      && error.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );

  const deleteCalls = harness.calls.filter(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  const fenceIndex = harness.calls.findIndex(
    ([method]) => method === "markDomainRequestCommitCleanupPending",
  );
  const claimIndex = harness.calls.findIndex(
    ([method]) => method === "claimDomainRequestCleanup",
  );
  const groupDeleteIndex = harness.calls.findIndex(
    ([method]) => method === "domainDirectory.deleteGroupExact",
  );
  const releaseIndex = harness.calls.findIndex(
    ([method]) => method === "releaseDomainRequestCleanup",
  );
  assert.equal(deleteCalls.length, 0);
  assert.ok(fenceIndex < claimIndex);
  assert.ok(claimIndex < groupDeleteIndex);
  assert.ok(groupDeleteIndex < releaseIndex);
  assert.deepEqual(
    harness.calls[fenceIndex][1].cleanup,
    {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      ownerGroup: {
        name: "domain-finance",
        operationToken: FINANCE_GROUP_OPERATION_TOKEN,
      },
    },
  );
  assert.deepEqual(
    harness.storedRequest(),
    permanentRequestResult(storedPendingCommitCleanup()),
  );
});

test("pending commit cleanup deletes the exact group before Registry and becomes retryable", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(
      storedPendingCommitCleanup(),
    ),
  });

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true,
  );

  const claimIndex = harness.calls.findIndex(
    ([method]) => method === "claimDomainRequestCleanup",
  );
  const groupDeleteIndex = harness.calls.findIndex(
    ([method]) => method === "domainDirectory.deleteGroupExact",
  );
  const registryDeleteIndex = harness.calls.findIndex(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  const completionIndex = harness.calls.findIndex(
    ([method]) => method === "markDomainRequestCleanupComplete",
  );
  assert.ok(claimIndex < groupDeleteIndex);
  assert.ok(groupDeleteIndex < registryDeleteIndex);
  assert.ok(registryDeleteIndex < completionIndex);
  assert.equal(
    harness.storedRequest()?.result?.status,
    "FAILED_RETRYABLE",
  );
});

test("a valid idempotent winner after persistence conflict is returned without deleting its Registry", async () => {
  const harness = createHarness();
  const readStored = harness.state.getRequestResult.bind(harness.state);
  let winnerPersisted = false;
  harness.state.getRequestResult = async (identity) => {
    if (winnerPersisted) {
      harness.calls.push([
        "getRequestResult",
        structuredClone(identity),
      ]);
      return requestResult(storedSuccess());
    }
    return readStored(identity);
  };
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "putDomainWithRequestResult",
      structuredClone(value),
    ]);
    winnerPersisted = true;
    throw Object.assign(new Error("claim conflict"), {
      code: "REQUEST_CLAIM_CONFLICT",
    });
  };

  assert.deepEqual(
    await (await serviceFor(harness)).createDomain(adminScope(), input()),
    successResult(),
  );
  assert.equal(
    harness.calls.some(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ),
    false,
  );
});

test("REQUEST_CLAIM_CONFLICT never deletes after a successful CLAIM reconciliation", async () => {
  const harness = createHarness();
  const readStored = harness.state.getRequestResult.bind(harness.state);
  let persistenceFailed = false;
  harness.state.getRequestResult = async (identity) => {
    if (persistenceFailed) {
      harness.calls.push([
        "getRequestResult",
        structuredClone(identity),
      ]);
      return null;
    }
    return readStored(identity);
  };
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "putDomainWithRequestResult",
      structuredClone(value),
    ]);
    persistenceFailed = true;
    throw Object.assign(new Error("claim conflict"), {
      code: "REQUEST_CLAIM_CONFLICT",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true,
  );
  const deleteCalls = harness.calls.filter(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  assert.equal(deleteCalls.length, 0);
});

test("DOMAIN_CONFLICT deletes only after the atomic conflict fence succeeds", async () => {
  const harness = createHarness();
  const readStored = harness.state.getRequestResult.bind(harness.state);
  let persistenceFailed = false;
  harness.state.getRequestResult = async (identity) => {
    if (persistenceFailed) {
      harness.calls.push([
        "getRequestResult",
        structuredClone(identity),
      ]);
      return null;
    }
    return readStored(identity);
  };
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "putDomainWithRequestResult",
      structuredClone(value),
    ]);
    persistenceFailed = true;
    throw Object.assign(new Error("domain exists"), {
      code: "DOMAIN_CONFLICT",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_CONFLICT"
      && error?.statusCode === 409,
  );
  const deleteCalls = harness.calls.filter(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  const fenceIndex = harness.calls.findIndex(
    ([method]) => method === "markDomainRequestConflict",
  );
  const deleteIndex = harness.calls.findIndex(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  assert.notEqual(fenceIndex, -1);
  assert.ok(fenceIndex < deleteIndex);
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0][1].input, {
    registryId: REGISTRY_ID,
  });
  assert.deepEqual(
    harness.calls[fenceIndex][1].cleanup,
    {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      ownerGroup: {
        name: "domain-finance",
        operationToken: FINANCE_GROUP_OPERATION_TOKEN,
      },
    },
  );
  const deleteGroupIndex = harness.calls.findIndex(
    ([method]) => method === "domainDirectory.deleteGroupExact",
  );
  assert.notEqual(deleteGroupIndex, -1);
  assert.ok(deleteGroupIndex < deleteIndex);
  assert.deepEqual(harness.calls[deleteGroupIndex], [
    "domainDirectory.deleteGroupExact",
    "domain-finance",
    FINANCE_GROUP_OPERATION_TOKEN,
  ]);
  assert.deepEqual(
    harness.results.at(-1).result,
    storedFinalConflict({
      cleanup: {
        status: "COMPLETE",
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
        ownerGroup: {
          name: "domain-finance",
          operationToken: FINANCE_GROUP_OPERATION_TOKEN,
        },
      },
    }),
  );
});

test("a failed exact Registry delete leaves durable pending cleanup and returns only the retryable failure", async () => {
  const harness = createHarness();
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      return { registryArn: REGISTRY_ARN };
    }
    if (command instanceof GetRegistryCommand) {
      return {
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
        status: "READY",
      };
    }
    throw new Error("TOP-SECRET AWS delete failure");
  };
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "putDomainWithRequestResult",
      structuredClone(value),
    ]);
    throw Object.assign(new Error("domain exists"), {
      code: "DOMAIN_CONFLICT",
    });
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );
  assert.deepEqual(
    harness.storedRequest(),
    permanentRequestResult(storedPendingConflict({
      cleanup: {
        status: "PENDING",
        registryId: REGISTRY_ID,
        registryArn: REGISTRY_ARN,
        ownerGroup: {
          name: "domain-finance",
          operationToken: FINANCE_GROUP_OPERATION_TOKEN,
        },
      },
    })),
  );
  assert.equal(
    harness.calls.some(
      ([method]) => method === "markDomainRequestCleanupComplete",
    ),
    false,
  );
});

test("a failed completion write after delete leaves the exact CLEANING lease", async () => {
  const harness = createHarness();
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "putDomainWithRequestResult",
      structuredClone(value),
    ]);
    throw Object.assign(new Error("domain exists"), {
      code: "DOMAIN_CONFLICT",
    });
  };
  harness.state.markDomainRequestCleanupComplete = async (transition) => {
    harness.calls.push([
      "markDomainRequestCleanupComplete",
      structuredClone(transition),
    ]);
    throw new Error("TOP-SECRET DynamoDB completion failure");
  };

  await assert.rejects(
    (await serviceFor(harness)).createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true
      && !error.message.includes("TOP-SECRET"),
  );
  const stored = harness.storedRequest();
  assert.equal(stored?.result?.cleanup?.status, "CLEANING");
  assert.deepEqual(stored?.result?.cleanup?.ownerGroup, {
    name: "domain-finance",
    operationToken: FINANCE_GROUP_OPERATION_TOKEN,
  });
  assert.match(
    stored?.result?.cleanup?.cleanupExecutionToken,
    /^[a-f0-9-]{36}$/,
  );
  assert.equal(
    stored?.result?.cleanup?.cleanupClaimExpiresAt,
    NOW_EPOCH + CLEANUP_LEASE_SECONDS,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    1,
  );
});

test("a cleanup claim loser never deletes a replacement group after the winner completes", async () => {
  const harness = createHarness({
    priorRequestResult: permanentRequestResult(storedPendingConflict({
      cleanup: ownedCleanup(),
    })),
  });
  const read = harness.state.getRequestResult.bind(harness.state);
  let pendingReads = 0;
  let releaseReads;
  const bothReadPending = new Promise((resolve) => {
    releaseReads = resolve;
  });
  harness.state.getRequestResult = async (identity) => {
    const result = await read(identity);
    if (result?.result?.cleanup?.status === "PENDING") {
      pendingReads += 1;
      if (pendingReads === 2) releaseReads();
      await bothReadPending;
    }
    return result;
  };
  const claim = harness.state.claimDomainRequestCleanup.bind(harness.state);
  let claimAttempts = 0;
  let releaseLoser;
  const winnerCompleted = new Promise((resolve) => {
    releaseLoser = resolve;
  });
  harness.state.claimDomainRequestCleanup = async (transition) => {
    claimAttempts += 1;
    if (claimAttempts === 2) await winnerCompleted;
    return claim(transition);
  };
  const complete =
    harness.state.markDomainRequestCleanupComplete.bind(harness.state);
  let replacementCreated = false;
  harness.state.markDomainRequestCleanupComplete = async (transition) => {
    const result = await complete(transition);
    replacementCreated = true;
    releaseLoser();
    return result;
  };
  let groupDeletes = 0;
  harness.domainDirectory.deleteGroupExact = async (
    ownerGroup,
    operationToken,
  ) => {
    harness.calls.push([
      "domainDirectory.deleteGroupExact",
      ownerGroup,
      operationToken,
    ]);
    assert.equal(replacementCreated, false);
    groupDeletes += 1;
  };
  const service = await serviceFor(harness);

  const outcomes = await Promise.allSettled([
    service.createDomain(adminScope(), input()),
    service.createDomain(adminScope(), input()),
  ]);

  assert.deepEqual(
    outcomes.map((outcome) => {
      assert.equal(outcome.status, "rejected");
      return {
        code: outcome.reason?.code,
        statusCode: outcome.reason?.statusCode,
        retryable: outcome.reason?.retryable,
      };
    }),
    [
      { code: "DOMAIN_CONFLICT", statusCode: 409, retryable: false },
      { code: "DOMAIN_CONFLICT", statusCode: 409, retryable: false },
    ],
  );
  assert.equal(replacementCreated, true);
  assert.equal(groupDeletes, 1);
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof CreateRegistryCommand,
    ).length,
    0,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ).length,
    1,
  );
});

test("cleanup completion conflict reconciliation fails closed unless exact COMPLETE wins", async () => {
  const changedRegistryId = "ChangedReg1234";
  const changedRegistryArn =
    `arn:aws:agent-registry:${REGION}:${ACCOUNT}:`
    + `registry/${changedRegistryId}`;
  const cases = [
    {
      name: "still pending",
      replay: permanentRequestResult(storedPendingConflict()),
      expectedCode: "DOMAIN_PROVISIONING_FAILED",
      expectedStatus: 503,
    },
    {
      name: "absent",
      replay: null,
      expectedCode: "DOMAIN_PROVISIONING_FAILED",
      expectedStatus: 503,
    },
    {
      name: "read failure",
      replay: new Error("TOP-SECRET DynamoDB read failure"),
      expectedCode: "DOMAIN_PROVISIONING_FAILED",
      expectedStatus: 503,
    },
    {
      name: "malformed cleanup",
      replay: requestResult(storedFinalConflict({
        cleanup: {
          ...storedFinalConflict().cleanup,
          extra: "unsafe",
        },
      })),
      expectedCode: "IDEMPOTENCY_CONFLICT",
      expectedStatus: 409,
    },
    {
      name: "different payload",
      replay: requestResult(storedFinalConflict({
        payloadFingerprint: fingerprint({
          ...normalizedPayload(),
          owner: "Different domain team",
        }),
      })),
      expectedCode: "IDEMPOTENCY_CONFLICT",
      expectedStatus: 409,
    },
    {
      name: "different cleanup target",
      replay: requestResult(storedFinalConflict({
        cleanup: {
          status: "COMPLETE",
          registryId: changedRegistryId,
          registryArn: changedRegistryArn,
        },
      })),
      expectedCode: "IDEMPOTENCY_CONFLICT",
      expectedStatus: 409,
    },
  ];

  for (const scenario of cases) {
    const harness = createHarness({
      priorRequestResult: permanentRequestResult(storedPendingConflict()),
    });
    const initialRead =
      harness.state.getRequestResult.bind(harness.state);
    let reads = 0;
    harness.state.getRequestResult = async (identity) => {
      reads += 1;
      if (reads === 1) return initialRead(identity);
      if (scenario.replay instanceof Error) throw scenario.replay;
      return scenario.replay === null
        ? null
        : structuredClone(scenario.replay);
    };
    harness.state.markDomainRequestCleanupComplete = async (transition) => {
      harness.calls.push([
        "markDomainRequestCleanupComplete",
        structuredClone(transition),
      ]);
      throw Object.assign(new Error("cleanup condition failed"), {
        code: "REQUEST_CLAIM_CONFLICT",
      });
    };

    await assert.rejects(
      (await serviceFor(harness)).createDomain(adminScope(), input()),
      (error) =>
        error?.code === scenario.expectedCode
        && error?.statusCode === scenario.expectedStatus,
      scenario.name,
    );
    assert.equal(reads, 2, scenario.name);
    assert.equal(
      harness.calls.filter(
        ([method, command]) =>
          method === "registry"
          && command instanceof CreateRegistryCommand,
      ).length,
      0,
      scenario.name,
    );
    assert.equal(
      harness.calls.filter(
        ([method, command]) =>
          method === "registry"
          && command instanceof DeleteRegistryCommand,
      ).length,
      1,
      scenario.name,
    );
  }
});

test("a second claimant can persist between observation and a losing atomic fence without Registry deletion", async () => {
  const harness = createHarness();
  const persist = harness.state.putDomainWithRequestResult.bind(harness.state);
  const fence = harness.state.markDomainRequestConflict.bind(harness.state);
  let attempted;
  harness.state.putDomainWithRequestResult = async (value) => {
    harness.calls.push([
      "failedPutDomainWithRequestResult",
      structuredClone(value),
    ]);
    attempted = structuredClone(value);
    throw Object.assign(new Error("domain exists"), {
      code: "DOMAIN_CONFLICT",
    });
  };
  let enterFence;
  let releaseFence;
  const fenceEntered = new Promise((resolve) => {
    enterFence = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFence = resolve;
  });
  harness.state.markDomainRequestConflict = async (claim) => {
    enterFence(structuredClone(claim));
    await release;
    return fence(claim);
  };
  const service = await serviceFor(harness);
  const first = service.createDomain(adminScope(), input());
  const firstPhase = await Promise.race([
    fenceEntered.then((claim) => ({ kind: "FENCE", claim })),
    first.then(
      (value) => ({ kind: "RETURN", value }),
      (error) => ({ kind: "ERROR", error }),
    ),
  ]);

  assert.equal(firstPhase.kind, "FENCE");
  try {
    await harness.state.markDomainRequestRetryable(firstPhase.claim);
    const secondClaim = {
      ...firstPhase.claim,
      ownerToken: "second-owner-token",
    };
    await harness.state.claimDomainRequest(secondClaim);
    await persist({
      domain: attempted.domain,
      requestResult: attempted.requestResult,
      claim: {
        payloadFingerprint: attempted.claim.payloadFingerprint,
        ownerToken: secondClaim.ownerToken,
      },
    });
  } finally {
    releaseFence();
  }

  assert.deepEqual(await first, successResult());
  assert.equal(
    harness.calls.some(
      ([method, command]) =>
        method === "registry"
        && command instanceof DeleteRegistryCommand,
    ),
    false,
  );
});

test("concurrent same-payload calls have one claim owner and one Registry mutation", async () => {
  const harness = createHarness();
  let releaseRegistry;
  let registryEntered;
  const entered = new Promise((resolve) => {
    registryEntered = resolve;
  });
  const release = new Promise((resolve) => {
    releaseRegistry = resolve;
  });
  harness.registry.send = async (command) => {
    harness.calls.push(["registry", command]);
    if (command instanceof CreateRegistryCommand) {
      registryEntered();
      await release;
      return { registryArn: REGISTRY_ARN };
    }
    assert.ok(command instanceof GetRegistryCommand);
    return {
      registryId: REGISTRY_ID,
      registryArn: REGISTRY_ARN,
      status: "READY",
    };
  };
  const service = await serviceFor(harness);
  const first = service.createDomain(adminScope(), input());
  await entered;

  await assert.rejects(
    service.createDomain(adminScope(), input()),
    (error) =>
      error?.code === "DOMAIN_PROVISIONING_FAILED"
      && error?.statusCode === 503
      && error?.retryable === true,
  );
  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof CreateRegistryCommand,
    ).length,
    1,
  );

  releaseRegistry();
  assert.deepEqual(await first, successResult());
});

test("same-payload callers that both read absence still converge at the claim", async () => {
  const harness = createHarness();
  const readStored = harness.state.getRequestResult.bind(harness.state);
  let initialReads = 0;
  let releaseInitialReads;
  const bothInitialReads = new Promise((resolve) => {
    releaseInitialReads = resolve;
  });
  harness.state.getRequestResult = async (identity) => {
    if (initialReads < 2) {
      harness.calls.push([
        "getRequestResult",
        structuredClone(identity),
      ]);
      initialReads += 1;
      if (initialReads === 2) releaseInitialReads();
      await bothInitialReads;
      return null;
    }
    return readStored(identity);
  };
  const service = await serviceFor(harness);

  const outcomes = await Promise.allSettled([
    service.createDomain(adminScope(), input()),
    service.createDomain(adminScope(), input()),
  ]);

  assert.equal(
    harness.calls.filter(
      ([method, command]) =>
        method === "registry"
        && command instanceof CreateRegistryCommand,
    ).length,
    1,
  );
  assert.equal(
    outcomes.some(
      ({ status, value }) =>
        status === "fulfilled"
        && isDeepStrictEqual(value, successResult()),
    ),
    true,
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      assert.equal(outcome.reason?.code, "DOMAIN_PROVISIONING_FAILED");
    }
  }
});

test("same request ID with any different normalized payload fails before Registry", async () => {
  for (const status of ["IN_PROGRESS", "FAILED_RETRYABLE", "SUCCEEDED"]) {
    const result = status === "SUCCEEDED"
      ? storedSuccess()
      : storedClaim(status);
    const harness = createHarness({
      priorRequestResult: requestResult(result),
    });
    await assert.rejects(
      (await serviceFor(harness)).createDomain(
        adminScope(),
        input({ owner: "Different domain team" }),
      ),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
      status,
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }
});

test("stored success replay validates fingerprint and complete domain shape", async () => {
  const valid = storedSuccess();
  const corruptResults = [
    { ...valid, payloadFingerprint: "b".repeat(64) },
    { ...valid, status: "IN_PROGRESS" },
    {
      ...valid,
      domain: { ...valid.domain, registryArn: "arn:aws:agent-registry:bad" },
    },
    {
      ...valid,
      domain: { ...valid.domain, createdBy: "different-actor" },
    },
    { ...valid, extra: "unsafe" },
  ];
  for (const corrupt of corruptResults) {
    const harness = createHarness({
      priorRequestResult: requestResult(corrupt),
    });
    await assert.rejects(
      (await serviceFor(harness)).createDomain(adminScope(), input()),
      (error) =>
        error?.code === "IDEMPOTENCY_CONFLICT"
        && error?.statusCode === 409,
    );
    assert.equal(
      harness.calls.some(([method]) => method === "registry"),
      false,
    );
  }
});

test("DOMAIN_CONFLICT with a WAIT reconciliation deletes only after owning the atomic fence", async () => {
  const differentHarness = createHarness({ existingDomain: null });
  differentHarness.state.putDomainWithRequestResult = async (value) => {
    differentHarness.calls.push([
      "putDomainWithRequestResult",
      structuredClone(value),
    ]);
    throw Object.assign(new Error("domain exists"), {
      code: "DOMAIN_CONFLICT",
    });
  };
  await assert.rejects(
    (await serviceFor(differentHarness)).createDomain(
      adminScope(),
      input(),
    ),
    (error) =>
      error?.code === "DOMAIN_CONFLICT" && error?.statusCode === 409,
  );
  assert.equal(differentHarness.domains.length, 0);
  assert.equal(differentHarness.results[0].result.status, "IN_PROGRESS");
  const deleteCalls = differentHarness.calls.filter(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  const fenceIndex = differentHarness.calls.findIndex(
    ([method]) => method === "markDomainRequestConflict",
  );
  const deleteIndex = differentHarness.calls.findIndex(
    ([method, command]) =>
      method === "registry"
      && command instanceof DeleteRegistryCommand,
  );
  assert.notEqual(fenceIndex, -1);
  assert.ok(fenceIndex < deleteIndex);
  assert.equal(deleteCalls.length, 1);
});

test("listDomains returns durable records only and filters non-admin claims fail closed", async () => {
  const harness = createHarness();
  harness.state.listDomains = async () => {
    harness.calls.push(["listDomains"]);
    return [
      successResult({ id: "operations", name: "Operations" }).domain,
      successResult({ id: "finance", name: "Finance" }).domain,
      successResult({ id: "platform", name: "Platform" }).domain,
    ];
  };
  const service = await serviceFor(harness);

  assert.deepEqual(
    (await service.listDomains({ role: "admin" })).domains
      .map(({ id }) => id),
    ["finance", "operations", "platform"],
  );
  assert.deepEqual(
    (await service.listDomains({
      role: "builder",
      allowedDomains: ["platform", "unknown", "finance"],
    })).domains.map(({ id }) => id),
    ["finance", "platform"],
  );
  for (const scope of [
    {},
    { role: "builder" },
    { role: "builder", allowedDomains: [] },
    { role: "builder", allowedDomains: "platform" },
    { role: "builder", allowedDomains: ["Platform"] },
    { role: "builder", allowedDomains: ["finance", null] },
    { role: "builder", allowedDomains: ["finance", "Platform"] },
  ]) {
    assert.deepEqual(await service.listDomains(scope), {
      ok: true,
      domains: [],
    });
  }
  assert.equal(
    harness.calls.filter(([method]) => method === "listDomains").length,
    9,
  );
});

test("exact target decisions do not consult partial inventory and bind AWS identity", async () => {
 const h = registryDecisionHarness();
 const inventory = await h.registryInventory.registryOnly(adminScope());
 const seen = [];
 const service = await decisionServiceFor(h,{registryInventory:{
   registryOnly(){throw new Error("full inventory must not authorize exact target");},
   async registryTarget(scope,target){seen.push(target);return inventory;},
 }});
 const input = {...decisionInput(),registryId:AUTHORITATIVE_REGISTRY_ID,recordId:AUTHORITATIVE_RECORD_ID};
 const result = await service.decideRegistryVersion(adminScope(),input);
 assert.equal(result.version._aws.recordId,AUTHORITATIVE_RECORD_ID);
 assert.equal(seen.length,1);
});
test("partial target responses and governed legacy targets cannot authorize writes",async()=>{
 for(const patch of [r=>{r.incomplete=true;},r=>{r.entries[0].versions[0]._governed=true;},r=>{r.entries[0].versions[0]._aws.recordId="DifferentRec";}]){
  const h=registryDecisionHarness();const inv=await h.registryInventory.registryOnly(adminScope());patch(inv);
  const service=await decisionServiceFor(h,{registryInventory:{registryOnly:async()=>inv,registryTarget:async()=>inv}});
  await assert.rejects(service.decideRegistryVersion(adminScope(),{...decisionInput(),registryId:AUTHORITATIVE_REGISTRY_ID,recordId:AUTHORITATIVE_RECORD_ID}));
  assert.equal(h.calls.some(([m])=>m==="claimRegistryDecisionTarget"),false);
 }
});
