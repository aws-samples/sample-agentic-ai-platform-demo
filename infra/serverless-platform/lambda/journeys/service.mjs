import {validateEvaluation} from '../../../../console/public/evaluation-config.mjs';
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildInception,
} from "../../../../console/inception.mjs";
import {
  GitHubClientError,
} from "./github.mjs";
import {
  composeJourneyManifest,
} from "./manifest.mjs";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,255}$/;
const PREVIEW_MS = 15 * 60_000;
const GITHUB_AUTHORIZATION_MS = 10 * 60_000;
const GITHUB_REVOCATION_RESERVE_MS = 17_000;
const GITHUB_EXCHANGE_RESERVE_MS = GITHUB_REVOCATION_RESERVE_MS + 6_000;
const SPEC_OPENING_QUESTION =
  "What outcome should this agent deliver, who will use it, "
  + "and what must it never do?";
const GITHUB_OWNER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_STATE_PATTERN = /^gho_[a-f0-9]{32,64}$/;
const GITHUB_METHODS = [
  "preflight",
  "createPrivateRepository",
  "getRepository",
  "getBranch",
  "renameBranch",
  "createBranch",
  "commitFiles",
  "getCommit",
  "getCommitTree",
  "createPullRequest",
  "findOpenPullRequest",
  "getPullRequest",
];
const DELIVER_REPOSITORY = Symbol("deliverRepository");
const EXPORTABLE_STATES = new Set([
  "READY_FOR_TEST", "TEST_FAILED",
  "TESTED",
  "SANDBOX_DEPLOYED",
  "PRODUCTION_PENDING",
  "PRODUCTION_APPROVED",
  "PRODUCTION_DEPLOYED",
  "REJECTED",
]);
const ROLES = new Set(["admin", "lead", "builder", "user"]);
const FULL_SELECTION_FIELDS = Object.freeze([
  ["TOOL", "toolIds"],
  ["MCP_SERVER", "mcpServerIds"],
  ["SKILL", "skillIds"],
  ["MEMORY", "memoryIds"],
  ["KNOWLEDGE_BASE", "knowledgeBaseIds"],
]);
const ERROR_DETAILS = Object.freeze({
  INVALID_REQUEST: {
    statusCode: 400,
    message: "The journey request is invalid.",
    retryable: false,
  },
  FORBIDDEN: {
    statusCode: 403,
    message: "The requested operation is not allowed.",
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
  DELIVERY_EXPIRED: {
    statusCode: 409,
    message: "The repository preview has expired.",
    retryable: false,
  },
  GITHUB_NOT_CONFIGURED: {
    statusCode: 409,
    message: "GitHub delivery is not configured.",
    retryable: false,
  },
  GITHUB_PERMISSION_DENIED: {
    statusCode: 403,
    message: "GitHub did not authorize this repository operation.",
    retryable: false,
  },
  GITHUB_CONFLICT: {
    statusCode: 409,
    message: "The GitHub repository state conflicts with this delivery.",
    retryable: false,
  },
  GITHUB_UNAVAILABLE: {
    statusCode: 503,
    message: "GitHub delivery is temporarily unavailable.",
    retryable: true,
  },
  GITHUB_REVOCATION_FAILED: {
    statusCode: 503,
    message: "GitHub authorization could not be revoked.",
    retryable: false,
  },
  INCEPTION_UNAVAILABLE: {
    statusCode: 503,
    message: "The inception model is temporarily unavailable.",
    retryable: true,
  },
  JOURNEY_UNAVAILABLE: {
    statusCode: 503,
    message: "The journey service is temporarily unavailable.",
    retryable: true,
  },
});

export class JourneyServiceError extends Error {
  constructor(code) {
    const detail = ERROR_DETAILS[code];
    if (!detail) throw new TypeError("Journey service error code is invalid.");
    super(detail.message);
    this.name = "JourneyServiceError";
    this.code = code;
    this.statusCode = detail.statusCode;
    this.retryable = detail.retryable;
  }
}

function fail(code) {
  throw new JourneyServiceError(code);
}

function plain(value) {
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

function exact(value, keys) {
  return plain(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validText(value, maxBytes) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value) <= maxBytes
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function timestamp(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("JOURNEY_UNAVAILABLE");
  return date.toISOString();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) {
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

function validateIdentity(value) {
  if (
    !exact(value, ["actor", "role", "activeDomain", "domainIds"])
    || !SUBJECT_PATTERN.test(value.actor)
    || !ROLES.has(value.role)
    || !Array.isArray(value.domainIds)
    || value.domainIds.some((domainId) => !DOMAIN_PATTERN.test(domainId))
    || new Set(value.domainIds).size !== value.domainIds.length
  ) {
    fail("INVALID_REQUEST");
  }
  if (
    value.role === "user"
    || !DOMAIN_PATTERN.test(value.activeDomain)
    || !value.domainIds.includes(value.activeDomain)
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

function validateCommon(input) {
  const expected = ["identity", "requestId", "payload"];
  if (!exact(input, expected)) {
    fail("INVALID_REQUEST");
  }
  const identity = validateIdentity(input.identity);
  if (
    (
      typeof input.requestId !== "string"
      || !REQUEST_ID_PATTERN.test(input.requestId)
      || !plain(input.payload)
    )
  ) {
    fail("INVALID_REQUEST");
  }
  return identity;
}

function validateId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function generatedId(idGenerator, kind) {
  return validateId(idGenerator(kind));
}

function mutation({
  identity,
  requestId,
  payload,
  expectedUpdatedAt = null,
}) {
  return {
    actor: identity.actor,
    domainId: identity.activeDomain,
    requestId,
    payloadFingerprint: fingerprint(payload),
    expectedUpdatedAt,
  };
}

function journeyReadInput(identity, journeyId) {
  return {
    actor: identity.actor,
    domainId: identity.activeDomain,
    journeyId: validateId(journeyId),
  };
}

function deliveryReadInput(identity, deliveryId) {
  return {
    actor: identity.actor,
    domainId: identity.activeDomain,
    deliveryId: validateId(deliveryId),
  };
}

function journeyPayload(value) {
  if (
    !exact(value, ["preset", "repositoryName"])
    || !new Set(["MINIMAL", "SPEC"]).has(value.preset)
    || !REPOSITORY_PATTERN.test(value.repositoryName)
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function messagePayload(value) {
  if (!exact(value, ["text"]) || !validText(value.text, 8_000)) {
    fail("INVALID_REQUEST");
  }
  return { text: value.text };
}

function previewPayload(value) {
  if (
    !plain(value)
    || !new Set(["FULL", "MINIMAL", "SPEC"]).has(value.preset)
    || !REPOSITORY_PATTERN.test(value.repositoryName)
  ) {
    fail("INVALID_REQUEST");
  }
  if (value.preset === "FULL") {
    if (
      !exact(
        value,
        ["preset", "repositoryName", "projectId", "agentId", ...(Object.hasOwn(value,"evaluation")?["evaluation"]:[])],
      )
      || typeof value.projectId !== "string"
      || !ID_PATTERN.test(value.projectId)
      || typeof value.agentId !== "string"
      || !ID_PATTERN.test(value.agentId)
    ) {
      fail("INVALID_REQUEST");
    }
  } else if (value.preset === "SPEC") {
    if (
      !exact(
        value,
        ["preset", "repositoryName", "journeyId", "projectId", "agentId"],
      )
      || typeof value.journeyId !== "string"
      || !ID_PATTERN.test(value.journeyId)
      || typeof value.projectId !== "string"
      || !ID_PATTERN.test(value.projectId)
      || typeof value.agentId !== "string"
      || !ID_PATTERN.test(value.agentId)
    ) {
      fail("INVALID_REQUEST");
    }
  } else if (
    !exact(value, ["preset", "repositoryName", "journeyId"])
    || typeof value.journeyId !== "string"
    || !ID_PATTERN.test(value.journeyId)
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function specInstructions(journey) {
  const profile = journey?.inception?.profile;
  if (!plain(profile)) return null;
  const capabilities = Array.isArray(profile.capabilities)
    ? profile.capabilities
    : [];
  const compliance = Array.isArray(profile.compliance)
    ? profile.compliance
    : [];
  return [
    profile.summary
      || `Implement the approved specification for ${journey.repositoryName}.`,
    capabilities.length
      ? `Required capabilities:\n- ${capabilities.join("\n- ")}`
      : "",
    profile.performsActions === false
      ? "The Agent must remain read-only."
      : "",
    compliance.length
      ? `Compliance requirements:\n- ${compliance.join("\n- ")}`
      : "",
  ].filter(Boolean).join("\n\n");
}

function specAgentBinding(journey, agent, payload, domainId) {
  const instructions = specInstructions(journey);
  if (
    !plain(agent)
    || agent.domainId !== domainId
    || agent.projectId !== payload.projectId
    || agent.id !== payload.agentId
    || agent.status !== "READY_FOR_TEST"
    || !plain(agent.buildConfig)
    || agent.buildConfig.instructions !== instructions
  ) {
    return null;
  }
  return {
    domainId: agent.domainId,
    projectId: agent.projectId,
    agentId: agent.id,
    status: agent.status,
    contractFingerprint: fingerprint({
      journeyId: journey.id,
      inception: journey.inception,
    }),
    configurationFingerprint: fingerprint({
      domainId: agent.domainId,
      projectId: agent.projectId,
      agentId: agent.id,
      name: agent.name,
      description: agent.description,
      modelId: agent.modelId,
      toolIds: agent.toolIds,
      mcpServerIds: agent.mcpServerIds,
      skillIds: agent.skillIds,
      blueprintIds: agent.blueprintIds,
      memoryIds: agent.memoryIds,
      knowledgeBaseIds: agent.knowledgeBaseIds,
      buildConfig: agent.buildConfig,
    }),
  };
}

function repositoryPayload(value) {
  if (
    !exact(value, [
      "previewId",
      "fingerprint",
      "confirmation",
      "acknowledgePrivateRepository",
    ])
    || !ID_PATTERN.test(value.previewId)
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !REPOSITORY_PATTERN.test(value.confirmation)
    || value.acknowledgePrivateRepository !== true
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function githubCallbackPayload(value) {
  if (
    !exact(value, ["code", "state"])
    || !validText(value.code, 512)
    || !GITHUB_STATE_PATTERN.test(value.state)
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function githubStatePayload(value) {
  if (
    !exact(value, ["state"])
    || !GITHUB_STATE_PATTERN.test(value.state)
  ) {
    fail("INVALID_REQUEST");
  }
  return { ...value };
}

function validConfiguredExportAgent(agent, payload, domainId) {
  return plain(agent)
    && agent.domainId === domainId
    && agent.projectId === payload.projectId
    && agent.id === payload.agentId
    && EXPORTABLE_STATES.has(agent.status)
    && plain(agent.buildConfig)
    && (agent.lastTestEvidenceHash == null || /^[a-f0-9]{64}$/.test(agent.lastTestEvidenceHash))
    && typeof agent.modelId === "string"
    && RESOURCE_ID_PATTERN.test(agent.modelId);
}

function matchesFrozenAgent(agent, snapshot) {
  if (
    !validConfiguredExportAgent(
      agent,
      {
        projectId: snapshot.agent.projectId,
        agentId: snapshot.agent.id,
      },
      snapshot.agent.domainId,
    )
  ) {
    return false;
  }
  const selected = Object.fromEntries(
    FULL_SELECTION_FIELDS.map(([type, field]) => [
      field,
      snapshot.resources
        .filter((resource) => resource.type === type)
        .map((resource) => resource.id),
    ]),
  );
  return isDeepStrictEqual(
    {
      domainId: agent.domainId,
      projectId: agent.projectId,
      id: agent.id,
      name: agent.name,
      instructions: agent.buildConfig.instructions,
      modelId: agent.modelId,
      modelParameters: agent.buildConfig.modelParameters,
      buildOptions: agent.buildConfig.buildOptions,
      testEvidenceHash: agent.lastTestEvidenceHash ?? null,
      blueprintIds: agent.blueprintIds,
      ...Object.fromEntries(
        FULL_SELECTION_FIELDS.map(([, field]) => [field, agent[field]]),
      ),
    },
    {
      domainId: snapshot.agent.domainId,
      projectId: snapshot.agent.projectId,
      id: snapshot.agent.id,
      name: snapshot.agent.name,
      instructions: snapshot.agent.instructions,
      modelId: snapshot.agent.modelId,
      modelParameters: snapshot.agent.modelParameters,
      buildOptions: snapshot.agent.buildOptions,
      testEvidenceHash: snapshot.agent.testEvidenceHash,
      blueprintIds: [snapshot.blueprint.blueprintId],
      ...selected,
    },
  );
}

function githubError(error) {
  if (!(error instanceof GitHubClientError)) {
    fail("GITHUB_UNAVAILABLE");
  }
  if (
    new Set([
      "AUTHENTICATION_FAILED",
      "OWNER_MISMATCH",
      "PERMISSION_DENIED",
    ]).has(error.code)
  ) {
    fail("GITHUB_PERMISSION_DENIED");
  }
  if (
    new Set([
      "CONFLICT",
      "NOT_FOUND",
      "FOREIGN_RESOURCE",
    ]).has(error.code)
  ) {
    fail("GITHUB_CONFLICT");
  }
  fail("GITHUB_UNAVAILABLE");
}

function checkpoint(record, status) {
  return record.checkpoints.find((entry) => entry.status === status) || null;
}

function deliveryMarker(delivery) {
  return `delivery ${delivery.id} ${
    delivery.manifest.fingerprint.slice(0, 16)
  }`;
}

function callbackFailure(error, deliveryId, revocationFailed) {
  const failure = error instanceof Error
    ? error
    : new JourneyServiceError("GITHUB_UNAVAILABLE");
  Object.defineProperties(failure, {
    deliveryId: {
      configurable: true,
      value: deliveryId,
    },
    revocationFailed: {
      configurable: true,
      value: revocationFailed,
    },
  });
  return failure;
}

function gitBlob(value) {
  const content = Buffer.from(value);
  return {
    sha: createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex"),
    size: content.length,
  };
}

export function createJourneyService({
  journeyState,
  workspaceState,
  inception,
  resolveFullBuildSnapshot,
  revalidateFullBuildSnapshot,
  githubOAuth = null,
  probeGitHubIdentity = null,
  githubClientFactory = null,
  composeManifest = composeJourneyManifest,
  logSecurityEvent = console.error,
  remainingTimeInMillis = () => 120_000,
  repositoryDeliveryMode = "main",
  clock,
  idGenerator = () => randomUUID(),
} = {}) {
  if (
    !journeyState
    || ![
      "claimMutation",
      "completeMutation",
      "getJourney",
      "putJourney",
      "getDelivery",
      "putDeliveryIntent",
      "checkpointDelivery",
      "putGitHubAuthorizationIntent",
      "consumeGitHubAuthorizationIntent",
    ].every((method) => typeof journeyState[method] === "function")
    || !workspaceState
    || typeof workspaceState.getProject !== "function"
    || typeof workspaceState.getAgent !== "function"
    || !inception
    || typeof inception.reply !== "function"
    || typeof inception.extractProfile !== "function"
    || typeof resolveFullBuildSnapshot !== "function"
    || typeof revalidateFullBuildSnapshot !== "function"
    || typeof composeManifest !== "function"
    || typeof logSecurityEvent !== "function"
    || typeof remainingTimeInMillis !== "function"
    || !["main", "pull-request"].includes(repositoryDeliveryMode)
    || typeof clock !== "function"
    || typeof idGenerator !== "function"
    || !(
      (
        githubOAuth === null
        && probeGitHubIdentity === null
        && githubClientFactory === null
      )
      || (
        (githubOAuth === null || (githubOAuth && [
          "configured",
          "authorizationState",
          "authorizationUrl",
          "exchange",
          "revoke",
        ]
          .every((method) => typeof githubOAuth[method] === "function")))
        && typeof probeGitHubIdentity === "function"
        && typeof githubClientFactory === "function"
      )
    )
  ) {
    throw new TypeError("Journey service configuration is invalid.");
  }

  async function requireProjectAccess(identity, projectId) {
    const project = await workspaceState.getProject({
      domainId: identity.activeDomain,
      projectId,
    });
    if (project === null) fail("NOT_FOUND");
    if (
      !plain(project)
      || project.domainId !== identity.activeDomain
      || project.id !== projectId
      || typeof project.ownerSubject !== "string"
      || !Array.isArray(project.memberSubjects)
      || project.memberSubjects.some(
        (subject) => typeof subject !== "string",
      )
      || project.status !== "ACTIVE"
    ) {
      fail("JOURNEY_UNAVAILABLE");
    }
    if (
      identity.role === "builder"
      && project.ownerSubject !== identity.actor
      && !project.memberSubjects.includes(identity.actor)
    ) {
      fail("NOT_FOUND");
    }
  }

  async function scopedJourney(identity, journeyId) {
    const record = await journeyState.getJourney(
      journeyReadInput(identity, journeyId),
    );
    if (record === null) fail("NOT_FOUND");
    return record;
  }

  async function scopedDelivery(identity, deliveryId) {
    const record = await journeyState.getDelivery(
      deliveryReadInput(identity, deliveryId),
    );
    if (record === null) fail("NOT_FOUND");
    return record;
  }

  async function beginMutation(
    identity,
    operation,
    requestId,
    payload,
    resourceType,
    proposedResourceId,
  ) {
    try {
      return await journeyState.claimMutation({
        actor: identity.actor,
        domainId: identity.activeDomain,
        effectiveRole: identity.role,
        operation,
        requestId,
        payloadFingerprint: fingerprint(payload),
        resourceType,
        proposedResourceId,
      });
    } catch (error) {
      if (
        error?.code === "MUTATION_CONFLICT"
        || error?.code === "MUTATION_IN_PROGRESS"
      ) {
        fail("CONFLICT");
      }
      throw error;
    }
  }

  async function manifestForDelivery(identity, delivery, {
    revalidateFull = false,
  } = {}) {
    let source = structuredClone(delivery.source);
    if (delivery.preset === "FULL" && revalidateFull) {
      const frozen = delivery.source.snapshot;
      await requireProjectAccess(identity, frozen.agent.projectId);
      const agent = await workspaceState.getAgent({
        domainId: identity.activeDomain,
        projectId: frozen.agent.projectId,
        agentId: frozen.agent.id,
      });
      if (!matchesFrozenAgent(agent, frozen)) fail("CONFLICT");
      try {
        await revalidateFullBuildSnapshot({
          identity: structuredClone(identity),
          snapshot: structuredClone(frozen),
        });
      } catch {
        fail("CONFLICT");
      }
      source = { snapshot: structuredClone(frozen) };
    }
    if (delivery.preset === "SPEC") {
      const journey = await scopedJourney(
        identity,
        delivery.source.journeyId,
      );
      if (
        journey.preset !== "SPEC"
        || journey.status !== "CONTRACT_READY"
        || !isDeepStrictEqual(journey.inception, delivery.source.inception)
      ) {
        fail("CONFLICT");
      }
      const frozenAgent = delivery.source.agent;
      await requireProjectAccess(identity, frozenAgent.projectId);
      const agent = await workspaceState.getAgent({
        domainId: identity.activeDomain,
        projectId: frozenAgent.projectId,
        agentId: frozenAgent.agentId,
      });
      const currentBinding = specAgentBinding(
        journey,
        agent,
        {
          projectId: frozenAgent.projectId,
          agentId: frozenAgent.agentId,
        },
        identity.activeDomain,
      );
      if (!isDeepStrictEqual(currentBinding, frozenAgent)) {
        fail("CONFLICT");
      }
    }
    let manifest;
    try {
      manifest = composeManifest({
        preset: delivery.preset,
        repositoryName: delivery.repositoryName,
        source,
      });
    } catch {
      fail("CONFLICT");
    }
    if (
      manifest.fingerprint !== delivery.manifest.fingerprint
      || !isDeepStrictEqual(manifest.summary, delivery.manifest.summary)
    ) {
      fail("CONFLICT");
    }
    return manifest;
  }

  async function saveCheckpoint(identity, delivery, status, githubResult) {
    return journeyState.checkpointDelivery({
      actor: identity.actor,
      domainId: identity.activeDomain,
      role: identity.role,
      deliveryId: delivery.id,
      expectedStatus: delivery.status,
      checkpoint: {
        status,
        at: timestamp(clock),
        github: githubResult,
      },
    });
  }

  async function verifyCommitTree(
    github,
    repository,
    treeSha,
    entries,
    allowedUnmanagedPaths = [],
  ) {
    const expected = new Map(entries.map(({ path, content }) => [
      path,
      gitBlob(content),
    ]));
    const allowed = new Set(allowedUnmanagedPaths);
    const actual = await githubCall(github, "getCommitTree", {
      repository,
      treeSha,
    });
    if (
      actual.length !== expected.size + allowed.size
      || new Set(actual.map(({ path }) => path)).size !== actual.length
    ) {
      fail("GITHUB_CONFLICT");
    }
    for (const file of actual) {
      const wanted = expected.get(file.path);
      if (wanted) {
        if (file.sha !== wanted.sha || file.size !== wanted.size) {
          fail("GITHUB_CONFLICT");
        }
      } else if (!allowed.has(file.path)) {
        fail("GITHUB_CONFLICT");
      }
    }
  }

  async function githubCall(github, method, input) {
    try {
      return await github[method](input);
    } catch (error) {
      githubError(error);
    }
  }

  function remainingGitHubTime() {
    let remaining;
    try {
      remaining = remainingTimeInMillis();
    } catch {
      fail("GITHUB_UNAVAILABLE");
    }
    if (!Number.isFinite(remaining)) {
      fail("GITHUB_UNAVAILABLE");
    }
    return remaining;
  }

  function assertGitHubExchangeWindow() {
    if (remainingGitHubTime() <= GITHUB_EXCHANGE_RESERVE_MS) {
      fail("GITHUB_UNAVAILABLE");
    }
  }

  function githubDeliverySignal() {
    const remaining = remainingGitHubTime();
    if (remaining <= GITHUB_REVOCATION_RESERVE_MS) {
      fail("GITHUB_UNAVAILABLE");
    }
    return AbortSignal.timeout(
      Math.floor(remaining - GITHUB_REVOCATION_RESERVE_MS),
    );
  }

  async function waitForGitHubDelivery(operation, signal) {
    if (signal.aborted) fail("GITHUB_UNAVAILABLE");
    let abort;
    const deadline = new Promise((_, reject) => {
      abort = () => reject(new JourneyServiceError("GITHUB_UNAVAILABLE"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  let deliverRepository;
  const service = {
    async createJourney(input) {
      const identity = validateCommon(input);
      const payload = journeyPayload(input.payload);
      const claimed = await beginMutation(
        identity,
        "CREATE_JOURNEY",
        input.requestId,
        payload,
        "JOURNEY",
        generatedId(idGenerator, "journey"),
      );
      if (claimed.status === "SUCCEEDED") {
        return scopedJourney(identity, claimed.result.resourceId);
      }
      const now = timestamp(clock);
      const record = {
        version: 1,
        actor: identity.actor,
        id: claimed.claim.resourceId,
        domainId: identity.activeDomain,
        preset: payload.preset,
        repositoryName: payload.repositoryName,
        status: "DRAFT",
        ...(payload.preset === "SPEC"
          ? {
              transcript: [{
                role: "assistant",
                text: SPEC_OPENING_QUESTION,
              }],
              inception: null,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      };
      return journeyState.putJourney({
        record,
        mutation: mutation({
          identity,
          requestId: input.requestId,
          payload,
        }),
        claim: claimed.claim,
      });
    },

    async getJourney(input) {
      if (
        !exact(input, ["identity", "journeyId"])
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      return scopedJourney(identity, input.journeyId);
    },

    async addMessage(input) {
      if (
        !exact(input, ["identity", "requestId", "journeyId", "payload"])
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      if (!REQUEST_ID_PATTERN.test(input.requestId)) fail("INVALID_REQUEST");
      const payload = messagePayload(input.payload);
      const journeyId = validateId(input.journeyId);
      const claimed = await beginMutation(
        identity,
        "ADD_MESSAGE",
        input.requestId,
        { journeyId, payload },
        "JOURNEY",
        journeyId,
      );
      if (claimed.status === "SUCCEEDED") {
        return scopedJourney(identity, claimed.result.resourceId);
      }
      const current = await scopedJourney(identity, journeyId);
      if (current.preset !== "SPEC" || current.inception !== null) {
        fail("CONFLICT");
      }
      const transcript = [
        ...current.transcript,
        { role: "user", text: payload.text },
      ];
      let assistant;
      try {
        assistant = await inception.reply({
          transcript: structuredClone(transcript),
          domainId: identity.activeDomain,
          actor: identity.actor,
          requestId: input.requestId,
          journeyId,
        });
      } catch {
        fail("INCEPTION_UNAVAILABLE");
      }
      if (!validText(assistant, 8_000)) fail("INCEPTION_UNAVAILABLE");
      const now = timestamp(clock);
      const record = {
        ...current,
        transcript: [
          ...transcript,
          { role: "assistant", text: assistant },
        ],
        updatedAt: now,
      };
      return journeyState.putJourney({
        record,
        mutation: mutation({
          identity,
          requestId: input.requestId,
          payload: { journeyId, payload },
          expectedUpdatedAt: current.updatedAt,
        }),
        claim: claimed.claim,
      });
    },

    async createContract(input) {
      if (
        !exact(input, ["identity", "requestId", "journeyId", "payload"])
        || !exact(input.payload, [])
        || !REQUEST_ID_PATTERN.test(input.requestId)
      ) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const journeyId = validateId(input.journeyId);
      const claimed = await beginMutation(
        identity,
        "CREATE_CONTRACT",
        input.requestId,
        { journeyId },
        "JOURNEY",
        journeyId,
      );
      if (claimed.status === "SUCCEEDED") {
        return scopedJourney(identity, claimed.result.resourceId);
      }
      const current = await scopedJourney(identity, journeyId);
      if (
        current.preset !== "SPEC"
        || current.inception !== null
        || current.transcript.filter(({ role }) => role === "user").length < 2
      ) {
        fail("CONFLICT");
      }
      let rawProfile;
      try {
        rawProfile = await inception.extractProfile({
          transcript: structuredClone(current.transcript),
          domainId: identity.activeDomain,
          actor: identity.actor,
          requestId: input.requestId,
          journeyId,
        });
      } catch {
        fail("INCEPTION_UNAVAILABLE");
      }
      if (!plain(rawProfile)) fail("INCEPTION_UNAVAILABLE");
      const now = timestamp(clock);
      const record = {
        ...current,
        status: "CONTRACT_READY",
        inception: buildInception(
          rawProfile,
          { domain: identity.activeDomain },
          {},
        ),
        updatedAt: now,
      };
      return journeyState.putJourney({
        record,
        mutation: mutation({
          identity,
          requestId: input.requestId,
          payload: {
            journeyId: current.id,
            transcript: current.transcript,
          },
          expectedUpdatedAt: current.updatedAt,
        }),
        claim: claimed.claim,
      });
    },

    async createPreview(input) {
      const identity = validateCommon(input);
      const payload = previewPayload(input.payload);
      if (Object.hasOwn(payload,"evaluation")) {
        try { payload.evaluation=validateEvaluation(payload.evaluation); } catch { fail("INVALID_REQUEST"); }
      }
      const claimed = await beginMutation(
        identity,
        "CREATE_PREVIEW",
        input.requestId,
        payload,
        "DELIVERY",
        generatedId(idGenerator, "delivery"),
      );
      if (claimed.status === "SUCCEEDED") {
        const saved = await scopedDelivery(
          identity,
          claimed.result.resourceId,
        );
        return {
          ...saved,
          manifest: await manifestForDelivery(identity, saved),
        };
      }
      let source;
      if (payload.preset === "FULL") {
        await requireProjectAccess(identity, payload.projectId);
        const agent = await workspaceState.getAgent({
          domainId: identity.activeDomain,
          projectId: payload.projectId,
          agentId: payload.agentId,
        });
        if (agent === null) fail("NOT_FOUND");
        if (!validConfiguredExportAgent(agent, payload, identity.activeDomain)) {
          fail("CONFLICT");
        }
        try {
          source = {
            snapshot: await resolveFullBuildSnapshot({
              identity: structuredClone(identity),
              agent: structuredClone(agent),
            }),
          };
          source.snapshot.evaluation = validateEvaluation(payload.evaluation);
        } catch (error) {
          if (error instanceof JourneyServiceError) throw error;
          if (String(error?.code || "").endsWith("_UNAVAILABLE")) {
            fail("JOURNEY_UNAVAILABLE");
          }
          fail("CONFLICT");
        }
      } else {
        const journey = await scopedJourney(identity, payload.journeyId);
        if (
          journey.preset !== payload.preset
          || journey.repositoryName !== payload.repositoryName
          || (
            payload.preset === "SPEC"
            && (
              journey.status !== "CONTRACT_READY"
              || !plain(journey.inception)
            )
          )
        ) {
          fail("CONFLICT");
        }
        if (payload.preset === "MINIMAL") {
          source = {
            domainId: identity.activeDomain,
            journeyId: journey.id,
          };
        } else {
          await requireProjectAccess(identity, payload.projectId);
          const agent = await workspaceState.getAgent({
            domainId: identity.activeDomain,
            projectId: payload.projectId,
            agentId: payload.agentId,
          });
          if (agent === null) fail("NOT_FOUND");
          const binding = specAgentBinding(
            journey,
            agent,
            payload,
            identity.activeDomain,
          );
          if (binding === null) {
            fail("CONFLICT");
          }
          source = {
            journeyId: journey.id,
            inception: structuredClone(journey.inception),
            agent: binding,
          };
        }
      }
      let manifest;
      try {
        manifest = composeManifest({
          preset: payload.preset,
          repositoryName: payload.repositoryName,
          source,
        });
      } catch {
        fail("CONFLICT");
      }
      if (
        !plain(manifest)
        || !plain(manifest.summary)
        || !/^[a-f0-9]{64}$/.test(manifest.fingerprint)
      ) {
        fail("JOURNEY_UNAVAILABLE");
      }
      const now = timestamp(clock);
      const record = {
        version: 1,
        actor: identity.actor,
        id: claimed.claim.resourceId,
        domainId: identity.activeDomain,
        role: identity.role,
        preset: payload.preset,
        repositoryName: payload.repositoryName,
        visibility: "private",
        source: structuredClone(source),
        manifest: {
          summary: structuredClone(manifest.summary),
          fingerprint: manifest.fingerprint,
        },
        status: "PREVIEWED",
        previewExpiresAt:
          new Date(Date.parse(now) + PREVIEW_MS).toISOString(),
        checkpoints: [],
        createdAt: now,
        updatedAt: now,
      };
      const saved = await journeyState.putDeliveryIntent({
        record,
        mutation: mutation({
          identity,
          requestId: input.requestId,
          payload,
        }),
        claim: claimed.claim,
      });
      return {
        ...saved,
        manifest: structuredClone(manifest),
      };
    },

    async getDelivery(input) {
      if (!exact(input, ["identity", "deliveryId"])) {
        fail("INVALID_REQUEST");
      }
      const identity = validateIdentity(input.identity);
      const delivery = await scopedDelivery(identity, input.deliveryId);
      if (delivery.status !== "PREVIEWED"
        || Date.parse(delivery.previewExpiresAt) <= Date.parse(timestamp(clock))) return delivery;
      return {
        ...delivery,
        manifest: await manifestForDelivery(identity, delivery, { revalidateFull: true }),
      };
    },

    async getGitHubConnection(input) {
      if (!exact(input, ["identity"])) fail("INVALID_REQUEST");
      validateIdentity(input.identity);
      let configured = false;
      try {
        configured = githubOAuth?.configured() === true;
      } catch {
        configured = false;
      }
      return {
        configured,
        tokenSupported: typeof probeGitHubIdentity === "function" && typeof githubClientFactory === "function",
        connected: false,
        owner: null,
      };
    },

    async startGitHubAuthorization(input) {
      const identity = validateCommon(input);
      if (plain(input.payload) && Object.hasOwn(input.payload, "accessToken")) {
        const { accessToken, ...repository } = input.payload;
        const payload = repositoryPayload(repository);
        if (typeof accessToken !== "string" || !/^[\x21-\x7e]{20,2048}$/.test(accessToken)) fail("INVALID_REQUEST");
        if (typeof probeGitHubIdentity !== "function" || typeof githubClientFactory !== "function") fail("GITHUB_NOT_CONFIGURED");
        // Verify scope and the reviewed bytes before using a user credential.
        const preview = await scopedDelivery(identity, payload.previewId);
        if (preview.role !== identity.role) fail("FORBIDDEN");
        if (preview.manifest.fingerprint !== payload.fingerprint
          || preview.repositoryName !== payload.confirmation
          || preview.visibility !== "private") fail("CONFLICT");
        if (preview.status === "PREVIEWED" && Date.parse(preview.previewExpiresAt) <= Date.parse(timestamp(clock))) fail("DELIVERY_EXPIRED");
        await manifestForDelivery(identity, preview, { revalidateFull: true });
        const signal = githubDeliverySignal();
        try {
          const account = await probeGitHubIdentity({ token: accessToken, signal });
          if (!account || !GITHUB_OWNER_PATTERN.test(account.login)
            || account.canCreatePrivateRepositories !== true || account.canManageWorkflows !== true) fail("GITHUB_PERMISSION_DENIED");
          const github = githubClientFactory({ owner: account.login, token: accessToken, signal });
          // Only the non-secret repository payload enters claims/checkpoints.
          // A caller-owned token is not persisted or revoked by this service.
          const completed = await waitForGitHubDelivery(deliverRepository({
            identity, requestId: input.requestId, payload, owner: account.login, github,
          }), signal);
          return { delivery: await service.getDelivery({ identity, deliveryId: completed.id }) };
        } catch (error) {
          if (error instanceof JourneyServiceError) throw error;
          if (error instanceof GitHubClientError) githubError(error);
          fail("GITHUB_UNAVAILABLE");
        }
      }
      if (githubOAuth?.configured() !== true) {
        fail("GITHUB_NOT_CONFIGURED");
      }
      const payload = repositoryPayload(input.payload);
      const delivery = await scopedDelivery(identity, payload.previewId);
      if (delivery.role !== identity.role) fail("FORBIDDEN");
      if (
        payload.fingerprint !== delivery.manifest.fingerprint
        || payload.confirmation !== delivery.repositoryName
        || delivery.visibility !== "private"
      ) {
        fail(
          payload.confirmation !== delivery.repositoryName
            ? "INVALID_REQUEST"
            : "CONFLICT",
        );
      }
      if (
        delivery.status === "PREVIEWED"
        && Date.parse(delivery.previewExpiresAt) <= Date.parse(timestamp(clock))
      ) {
        fail("DELIVERY_EXPIRED");
      }
      await manifestForDelivery(identity, delivery);
      const createdAt = timestamp(clock);
      let state;
      try {
        state = await githubOAuth.authorizationState({
          actor: identity.actor,
          domainId: identity.activeDomain,
          role: identity.role,
          requestId: input.requestId,
          deliveryId: delivery.id,
          manifestFingerprint: delivery.manifest.fingerprint,
          repositoryName: delivery.repositoryName,
        });
      } catch {
        fail("GITHUB_UNAVAILABLE");
      }
      if (!GITHUB_STATE_PATTERN.test(state)) fail("GITHUB_UNAVAILABLE");
      const expiresAt = new Date(
        Date.parse(createdAt) + GITHUB_AUTHORIZATION_MS,
      ).toISOString();
      let persisted;
      try {
        persisted = await journeyState.putGitHubAuthorizationIntent({
          record: {
            version: 1,
            actor: identity.actor,
            domainId: identity.activeDomain,
            role: identity.role,
            state,
            deliveryId: delivery.id,
            manifestFingerprint: delivery.manifest.fingerprint,
            repositoryName: delivery.repositoryName,
            visibility: "private",
            requestId: input.requestId,
            expiresAt,
            createdAt,
            consumedAt: null,
          },
        });
      } catch (error) {
        if (error?.code === "GITHUB_AUTHORIZATION_CONFLICT") {
          fail("CONFLICT");
        }
        throw error;
      }
      let url;
      try {
        url = githubOAuth.authorizationUrl({ state: persisted.state });
      } catch {
        fail("GITHUB_UNAVAILABLE");
      }
      return { url, expiresAt: persisted.expiresAt };
    },

    async cancelGitHubAuthorization(input) {
      if (!exact(input, ["payload"])) fail("INVALID_REQUEST");
      if (githubOAuth?.configured() !== true) {
        fail("GITHUB_NOT_CONFIGURED");
      }
      const payload = githubStatePayload(input.payload);
      try {
        await journeyState.consumeGitHubAuthorizationIntent({
          state: payload.state,
        });
      } catch (error) {
        if (
          error?.code === "GITHUB_AUTHORIZATION_CONFLICT"
          || error?.code === "INVALID_GITHUB_AUTHORIZATION"
        ) {
          fail("CONFLICT");
        }
        throw error;
      }
    },

    async completeGitHubAuthorization(input) {
      if (!exact(input, ["payload"])) {
        fail("INVALID_REQUEST");
      }
      if (githubOAuth?.configured() !== true) {
        fail("GITHUB_NOT_CONFIGURED");
      }
      const payload = githubCallbackPayload(input.payload);
      assertGitHubExchangeWindow();
      let intent;
      try {
        intent = await journeyState.consumeGitHubAuthorizationIntent({
          state: payload.state,
        });
      } catch (error) {
        if (
          error?.code === "GITHUB_AUTHORIZATION_CONFLICT"
          || error?.code === "INVALID_GITHUB_AUTHORIZATION"
        ) {
          fail("CONFLICT");
        }
        throw error;
      }
      const identity = validateIdentity({
        actor: intent.actor,
        role: intent.role,
        activeDomain: intent.domainId,
        domainIds: [intent.domainId],
      });
      let token = null;
      let delivery = null;
      let deliveryError = null;
      let revocationFailed = false;
      try {
        let owner;
        let github;
        let signal;
        try {
          assertGitHubExchangeWindow();
          const exchanged = await githubOAuth.exchange({
            code: payload.code,
            state: payload.state,
          });
          token = exchanged?.token;
          if (!validText(token, 2048)) fail("GITHUB_PERMISSION_DENIED");
          signal = githubDeliverySignal();
          const githubIdentity = await probeGitHubIdentity({
            token,
            signal,
          });
          owner = githubIdentity?.login;
          if (
            typeof owner !== "string"
            || !GITHUB_OWNER_PATTERN.test(owner)
            || githubIdentity.canCreatePrivateRepositories !== true
            || githubIdentity.canManageWorkflows !== true
          ) {
            fail("GITHUB_PERMISSION_DENIED");
          }
          github = githubClientFactory({ owner, token, signal });
          if (
            !github
            || !GITHUB_METHODS.every(
              (method) => typeof github[method] === "function",
            )
          ) {
            fail("GITHUB_UNAVAILABLE");
          }
        } catch (error) {
          if (error instanceof JourneyServiceError) throw error;
          if (error instanceof GitHubClientError) githubError(error);
          fail("GITHUB_UNAVAILABLE");
        }
        try {
          delivery = await waitForGitHubDelivery(
            deliverRepository({
              identity,
              requestId: intent.requestId,
              payload: {
                previewId: intent.deliveryId,
                fingerprint: intent.manifestFingerprint,
                confirmation: intent.repositoryName,
                acknowledgePrivateRepository: true,
              },
              owner,
              github,
            }),
            signal,
          );
        } catch (error) {
          deliveryError = error;
        }
      } catch (error) {
        deliveryError = error;
      } finally {
        if (token !== null) {
          try {
            await githubOAuth.revoke({ token });
          } catch {
            revocationFailed = true;
            try {
              await logSecurityEvent({
                event: "github_oauth_revocation_failed",
                code: "REVOCATION_FAILED",
              });
            } catch {
              // Revocation telemetry must not replace the delivery result.
            }
          }
        }
      }
      if (deliveryError !== null) {
        throw callbackFailure(
          deliveryError,
          intent.deliveryId,
          revocationFailed,
        );
      }
      return revocationFailed
        ? { ...delivery, warning: "GITHUB_REVOCATION_FAILED" }
        : delivery;
    },

    async [DELIVER_REPOSITORY]({
      identity,
      requestId,
      payload,
      owner,
      github,
    }) {
      let delivery = await scopedDelivery(identity, payload.previewId);
      if (delivery.role !== identity.role) fail("FORBIDDEN");
      if (
        payload.fingerprint !== delivery.manifest.fingerprint
        || payload.confirmation !== delivery.repositoryName
        || delivery.visibility !== "private"
      ) {
        fail("CONFLICT");
      }
      const claimed = await beginMutation(
        identity,
        "CREATE_REPOSITORY",
        requestId,
        payload,
        "DELIVERY",
        delivery.id,
      );
      if (claimed.status === "SUCCEEDED") {
        const completed = await scopedDelivery(
          identity,
          claimed.result.resourceId,
        );
        if (completed.status !== "COMPLETED") fail("CONFLICT");
        return completed;
      }
      const manifest = await manifestForDelivery(identity, delivery, {
        revalidateFull: true,
      });
      await githubCall(github, "preflight");

      if (delivery.status === "PREVIEWED") {
        delivery = await saveCheckpoint(identity, delivery, "APPROVED", {
          owner,
          repository: delivery.repositoryName,
          visibility: "private",
        });
      } else {
        const approved = checkpoint(delivery, "APPROVED");
        if (
          !approved
          || !isDeepStrictEqual(approved.github, {
            owner,
            repository: delivery.repositoryName,
            visibility: "private",
          })
        ) {
          fail("GITHUB_CONFLICT");
        }
      }

      let repository;
      const description =
        `Agentic platform ${deliveryMarker(delivery)}`;
      if (delivery.status === "APPROVED") {
        repository = await githubCall(github, "getRepository", {
          name: delivery.repositoryName,
        });
        if (repository !== null) fail("GITHUB_CONFLICT");
        delivery = await saveCheckpoint(
          identity,
          delivery,
          "REPOSITORY_CREATING",
          checkpoint(delivery, "APPROVED").github,
        );
      }
      if (delivery.status === "REPOSITORY_CREATING") {
        if (repository === undefined) {
          repository = await githubCall(github, "getRepository", {
            name: delivery.repositoryName,
          });
        }
        if (repository === null) {
          try {
            repository = await githubCall(github, "createPrivateRepository", {
              name: delivery.repositoryName,
              description,
            });
          } catch (error) {
            repository = await githubCall(github, "getRepository", {
              name: delivery.repositoryName,
            });
            if (repository === null) throw error;
          }
        }
        if (
          repository.description !== description
        ) {
          fail("GITHUB_CONFLICT");
        }
        if (repository.defaultBranch !== "main") {
          await githubCall(github, "renameBranch", {
            repository: delivery.repositoryName,
            branch: repository.defaultBranch,
            newName: "main",
          });
          repository = await githubCall(github, "getRepository", {
            name: delivery.repositoryName,
          });
          if (
            repository === null
            || repository.defaultBranch !== "main"
            || repository.description !== description
          ) {
            fail("GITHUB_CONFLICT");
          }
        }
        delivery = await saveCheckpoint(
          identity,
          delivery,
          "REPOSITORY_CREATED",
          {
            repositoryId: repository.id,
            repositoryNodeId: repository.nodeId,
            htmlUrl: repository.url,
          },
        );
      } else {
        repository = await githubCall(github, "getRepository", {
          name: delivery.repositoryName,
        });
        const created = checkpoint(delivery, "REPOSITORY_CREATED");
        if (
          repository === null
          || repository.defaultBranch !== "main"
          || repository.description !== description
          || repository.id !== created?.github.repositoryId
          || repository.nodeId !== created?.github.repositoryNodeId
          || repository.url !== created?.github.htmlUrl
        ) {
          fail("GITHUB_CONFLICT");
        }
      }

      // A new development repository must be cloneable immediately. Existing
      // PR-based deliveries retain their checkpoint recovery path below.
      if ((repositoryDeliveryMode === "main" && delivery.status === "REPOSITORY_CREATED")
        || delivery.status === "INITIAL_SOURCE_COMMITTED") {
        const message = `chore: export initial Agent source [${deliveryMarker(delivery)}]`;
        const main = await githubCall(github, "getBranch", { repository: delivery.repositoryName, branch: "main" });
        if (!main) fail("GITHUB_CONFLICT");
        let commit = await githubCall(github, "getCommit", { repository: delivery.repositoryName, sha: main.sha });
        if (delivery.status === "REPOSITORY_CREATED") {
          let written;
          if (commit?.message === message) {
            await verifyCommitTree(github, delivery.repositoryName, commit.treeSha, manifest.entries);
            written = { oid: commit.sha, treeOid: commit.treeSha };
          } else {
            written = await githubCall(github, "commitFiles", {
              repository: delivery.repositoryName, branch: "main", expectedHeadOid: main.sha,
              message, files: manifest.entries.map(({path, content}) => ({path, content})),
            });
          }
          delivery = await saveCheckpoint(identity, delivery, "INITIAL_SOURCE_COMMITTED",
            { commitSha: written.oid, treeSha: written.treeOid });
        }
        const saved = checkpoint(delivery, "INITIAL_SOURCE_COMMITTED").github;
        const head = await githubCall(github, "getBranch", { repository: delivery.repositoryName, branch: "main" });
        if (head?.sha !== saved.commitSha) fail("GITHUB_CONFLICT");
        await verifyCommitTree(github, delivery.repositoryName, saved.treeSha, manifest.entries);
        delivery = await saveCheckpoint(identity, delivery, "COMPLETED", null);
        await journeyState.completeMutation({
          claim: claimed.claim, result: { resourceType: "DELIVERY", resourceId: delivery.id },
        });
        return delivery;
      }

      const gate = manifest.entries.filter(
        ({ path }) => path === "gates/platform-gates.json",
      );
      if (gate.length !== 1) fail("CONFLICT");
      let mainCommit;
      const mainMessage =
        `chore: establish platform delivery gate [${deliveryMarker(delivery)}]`;
      if (delivery.status === "REPOSITORY_CREATED") {
        const main = await githubCall(github, "getBranch", {
          repository: delivery.repositoryName,
          branch: "main",
        });
        if (main === null) fail("GITHUB_CONFLICT");
        const existing = await githubCall(github, "getCommit", {
          repository: delivery.repositoryName,
          sha: main.sha,
        });
        if (existing?.message === mainMessage) {
          await verifyCommitTree(
            github,
            delivery.repositoryName,
            existing.treeSha,
            gate,
            ["README.md"],
          );
          mainCommit = {
              oid: existing.sha,
              treeOid: existing.treeSha,
              url: existing.url,
            };
        } else {
          mainCommit = await githubCall(github, "commitFiles", {
              repository: delivery.repositoryName,
              branch: "main",
              expectedHeadOid: main.sha,
              message: mainMessage,
              files: gate.map(({ path, content }) => ({ path, content })),
            });
        }
        delivery = await saveCheckpoint(
          identity,
          delivery,
          "MAIN_BOOTSTRAPPED",
          { commitSha: mainCommit.oid },
        );
      } else {
        const bootstrapped = checkpoint(delivery, "MAIN_BOOTSTRAPPED");
        const main = await githubCall(github, "getBranch", {
          repository: delivery.repositoryName,
          branch: "main",
        });
        if (main?.sha !== bootstrapped?.github.commitSha) {
          fail("GITHUB_CONFLICT");
        }
        mainCommit = { oid: main.sha };
      }

      const branchName =
        `platform/${delivery.preset.toLowerCase()}-`
        + delivery.manifest.fingerprint.slice(0, 8);
      if (delivery.status === "MAIN_BOOTSTRAPPED") {
        const existing = await githubCall(github, "getBranch", {
          repository: delivery.repositoryName,
          branch: branchName,
        });
        if (existing === null) {
          await githubCall(github, "createBranch", {
            repository: delivery.repositoryName,
            branch: branchName,
            sha: mainCommit.oid,
          });
        } else if (existing.sha !== mainCommit.oid) {
          fail("GITHUB_CONFLICT");
        }
        delivery = await saveCheckpoint(
          identity,
          delivery,
          "BRANCH_CREATED",
          { branchName, baseSha: mainCommit.oid },
        );
      } else {
        const created = checkpoint(delivery, "BRANCH_CREATED");
        if (
          created?.github.branchName !== branchName
          || created?.github.baseSha !== mainCommit.oid
        ) {
          fail("GITHUB_CONFLICT");
        }
      }

      const sourceMessage =
        `feat: add ${delivery.preset} platform source [${deliveryMarker(delivery)}]`;
      if (delivery.status === "BRANCH_CREATED") {
        const branch = await githubCall(github, "getBranch", {
          repository: delivery.repositoryName,
          branch: branchName,
        });
        const created = checkpoint(delivery, "BRANCH_CREATED");
        if (branch === null) {
          fail("GITHUB_CONFLICT");
        }
        let sourceCommit;
        if (branch.sha === created.github.baseSha) {
          sourceCommit = await githubCall(github, "commitFiles", {
            repository: delivery.repositoryName,
            branch: branchName,
            expectedHeadOid: branch.sha,
            message: sourceMessage,
            files: manifest.entries
              .filter(({ path }) => path !== "gates/platform-gates.json")
              .map(({ path, content }) => ({ path, content })),
          });
        } else {
          const existing = await githubCall(github, "getCommit", {
            repository: delivery.repositoryName,
            sha: branch.sha,
          });
          if (existing?.message !== sourceMessage) fail("GITHUB_CONFLICT");
          await verifyCommitTree(
            github,
            delivery.repositoryName,
            existing.treeSha,
            manifest.entries,
          );
          sourceCommit = {
            oid: existing.sha,
            treeOid: existing.treeSha,
            url: existing.url,
          };
        }
        delivery = await saveCheckpoint(
          identity,
          delivery,
          "SOURCE_COMMITTED",
          {
            commitSha: sourceCommit.oid,
            treeSha: sourceCommit.treeOid,
          },
        );
      } else {
        const committed = checkpoint(delivery, "SOURCE_COMMITTED");
        const branch = await githubCall(github, "getBranch", {
          repository: delivery.repositoryName,
          branch: branchName,
        });
        if (branch?.sha !== committed?.github.commitSha) {
          fail("GITHUB_CONFLICT");
        }
      }

      let pullRequest;
      if (delivery.status === "SOURCE_COMMITTED") {
        pullRequest = await githubCall(github, "findOpenPullRequest", {
          repository: delivery.repositoryName,
          head: branchName,
          base: "main",
        });
        if (pullRequest === null) {
          pullRequest = await githubCall(github, "createPullRequest", {
            repository: delivery.repositoryName,
            head: branchName,
            base: "main",
            title: `Add ${delivery.preset} agent platform source`,
            body:
              `Manifest fingerprint: ${delivery.manifest.fingerprint}. `
              + "Review and merge after the platform checks pass.",
          });
        }
        delivery = await saveCheckpoint(
          identity,
          delivery,
          "PULL_REQUEST_OPENED",
          {
            pullRequestNumber: pullRequest.number,
            pullRequestNodeId: pullRequest.nodeId,
            htmlUrl: pullRequest.url,
          },
        );
      } else {
        const opened = checkpoint(delivery, "PULL_REQUEST_OPENED");
        pullRequest = await githubCall(github, "getPullRequest", {
          repository: delivery.repositoryName,
          number: opened.github.pullRequestNumber,
          head: branchName,
          base: "main",
        });
        if (
          pullRequest === null
          || pullRequest.nodeId !== opened.github.pullRequestNodeId
          || pullRequest.url !== opened.github.htmlUrl
        ) {
          fail("GITHUB_CONFLICT");
        }
      }

      if (delivery.status === "PULL_REQUEST_OPENED") {
        delivery = await saveCheckpoint(
          identity,
          delivery,
          "COMPLETED",
          null,
        );
      }
      await journeyState.completeMutation({
        claim: claimed.claim,
        result: {
          resourceType: "DELIVERY",
          resourceId: delivery.id,
        },
      });
      return delivery;
    },
  };
  deliverRepository = service[DELIVER_REPOSITORY];
  delete service[DELIVER_REPOSITORY];
  return Object.freeze(service);
}
