import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  JourneyServiceError,
  createJourneyService,
} from "../lambda/journeys/service.mjs";
import {
  composeJourneyManifest,
} from "../lambda/journeys/manifest.mjs";

const NOW = "2026-08-27T05:00:00.000Z";
const DOMAIN = "customer_support";
const ACTOR = "builder-sub-123";
const SPEC_INSTRUCTIONS = [
  "Triage support cases.",
  "Required capabilities:\n- Classify a support case",
  "The Agent must remain read-only.",
  "Compliance requirements:\n- PII",
].join("\n\n");

function identity(overrides = {}) {
  return {
    actor: ACTOR,
    role: "builder",
    activeDomain: DOMAIN,
    domainIds: [DOMAIN],
    ...overrides,
  };
}

function testedAgent(overrides = {}) {
  return {
    domainId: DOMAIN,
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    description: "Routes support cases.",
    ownerSubject: ACTOR,
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: ["chat-assistant"],
    memoryIds: [],
    knowledgeBaseIds: [],
    buildConfig: {
      instructions: "Route support cases without changing customer data.",
      modelParameters: { temperature: 0.2, maxTokens: 1024 },
      buildOptions: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "shortTerm",
        streaming: true,
        identity: true,
        guardrails: true,
      },
    },
    status: "TESTED",
    createdBySubject: ACTOR,
    createdAt: NOW,
    updatedAt: NOW,
    lastTestStatus: "SUCCEEDED",
    lastTestedAt: NOW,
    lastTestedBySubject: ACTOR,
    lastTestModelId: "bedrock-claude/anthropic.claude-sonnet-5",
    lastTestInputTokens: 12,
    lastTestOutputTokens: 8,
    lastTestRequestId: "gateway-test-1",
    lastTestEvidenceHash: "b".repeat(64),
    lastTestOutput: "A tested response.",
    ...overrides,
  };
}

function specAgent(overrides = {}) {
  return testedAgent({
    status: "READY_FOR_TEST",
    buildConfig: {
      ...testedAgent().buildConfig,
      instructions: SPEC_INSTRUCTIONS,
    },
    ...overrides,
  });
}

function fullSnapshot(agent = testedAgent()) {
  return {
    snapshotVersion: 1,
    agent: {
      domainId: agent.domainId,
      projectId: agent.projectId,
      id: agent.id,
      name: agent.name,
      instructions: agent.buildConfig.instructions,
      modelId: agent.modelId,
      runtimeModelId: "global.anthropic.claude-sonnet-5",
      modelParameters: agent.buildConfig.modelParameters,
      buildOptions: agent.buildConfig.buildOptions,
      testEvidenceHash: agent.lastTestEvidenceHash,
    },
    blueprint: {
      registryId: "SharedReg123456",
      recordId: "blueprint_chat-assistant",
      version: "1.0.0",
      blueprintId: "chat-assistant",
      templateId: "chatagent",
      scope: "shared",
      template: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "shortTerm",
        streaming: true,
        identity: true,
        guardrails: true,
      },
    },
    resources: [],
  };
}

function fakeManifest({ preset, repositoryName, source }) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ preset, repositoryName, source }))
    .digest("hex");
  return {
    version: 1,
    preset,
    repositoryName,
    entries: [
      { path: "README.md", content: preset, mode: "100644" },
      {
        path: "gates/platform-gates.json",
        content: JSON.stringify({ preset }),
        mode: "100644",
      },
    ],
    workflows: [],
    summary: { fileCount: 2, workflowCount: 0 },
    fingerprint,
  };
}

function githubHarness(owner = "ExampleOwner", {
  defaultBranch = "main",
} = {}) {
  const calls = [];
  const repositoryBase = {
    id: 12345,
    nodeId: "R_example",
    name: "support-agent",
    fullName: `${owner}/support-agent`,
    private: true,
    description: "",
    url: `https://github.com/${owner}/support-agent`,
    defaultBranch,
    owner,
    ownerId: 67890,
  };
  const branches = new Map([[defaultBranch, "a".repeat(40)]]);
  const commits = new Map();
  const trees = new Map();
  const commitFiles = new Map([
    ["a".repeat(40), new Map([["README.md", "# support-agent\n"]])],
  ]);
  let repository = null;
  let pullRequest = null;
  return {
    calls,
    client: {
      async preflight() {
        calls.push(["preflight"]);
        return {
          configured: true,
          connected: true,
          owner,
          authenticatedLogin: owner,
          authenticatedUserId: repositoryBase.ownerId,
          canCreatePrivateRepositories: true,
        };
      },
      async createPrivateRepository(input) {
        calls.push(["createPrivateRepository", structuredClone(input)]);
        repository = {
          ...repositoryBase,
          name: input.name,
          fullName: `${owner}/${input.name}`,
          url: `https://github.com/${owner}/${input.name}`,
          description: input.description,
        };
        return structuredClone(repository);
      },
      async getRepository(input) {
        calls.push(["getRepository", structuredClone(input)]);
        return repository?.name === input.name
          ? structuredClone(repository)
          : null;
      },
      async getBranch(input) {
        calls.push(["getBranch", structuredClone(input)]);
        const sha = branches.get(input.branch);
        return sha ? { name: input.branch, sha } : null;
      },
      async renameBranch(input) {
        calls.push(["renameBranch", structuredClone(input)]);
        const sha = branches.get(input.branch);
        if (!sha) throw new Error("branch missing");
        branches.delete(input.branch);
        branches.set(input.newName, sha);
        repository.defaultBranch = input.newName;
        return { name: input.newName, sha };
      },
      async createBranch(input) {
        calls.push(["createBranch", structuredClone(input)]);
        branches.set(input.branch, input.sha);
        return { ref: `refs/heads/${input.branch}`, sha: input.sha };
      },
      async commitFiles(input) {
        calls.push(["commitFiles", structuredClone(input)]);
        const files = new Map(
          commitFiles.get(branches.get(input.branch)) || [],
        );
        for (const file of input.files) files.set(file.path, file.content);
        const oid = input.branch === "main"
          ? "b".repeat(40)
          : "c".repeat(40);
        const treeSha = input.branch === "main"
          ? "d".repeat(40)
          : "e".repeat(40);
        branches.set(input.branch, oid);
        commitFiles.set(oid, files);
        trees.set(treeSha, new Map(files));
        commits.set(oid, {
          sha: oid,
          message: input.message,
          treeSha,
          url: `https://github.com/${owner}/${input.repository}/commit/${oid}`,
        });
        return {
          oid,
          treeOid: treeSha,
          url: `https://github.com/${owner}/${input.repository}/commit/${oid}`,
        };
      },
      async getCommit(input) {
        calls.push(["getCommit", structuredClone(input)]);
        return structuredClone(commits.get(input.sha) || null);
      },
      async getCommitTree(input) {
        calls.push(["getCommitTree", structuredClone(input)]);
        const files = trees.get(input.treeSha);
        if (!files) return null;
        return [...files.entries()]
          .map(([path, content]) => {
            const bytes = Buffer.from(content);
            return {
              path,
              sha: createHash("sha1")
                .update(`blob ${bytes.length}\0`)
                .update(bytes)
                .digest("hex"),
              size: bytes.length,
            };
          })
          .sort((left, right) => left.path.localeCompare(right.path));
      },
      async createPullRequest(input) {
        calls.push(["createPullRequest", structuredClone(input)]);
        pullRequest = {
          id: 1122,
          nodeId: "PR_example",
          number: 7,
          state: "open",
          url: `https://github.com/${owner}/${input.repository}/pull/7`,
          head: input.head,
          base: input.base,
        };
        return structuredClone(pullRequest);
      },
      async findOpenPullRequest(input) {
        calls.push(["findOpenPullRequest", structuredClone(input)]);
        return pullRequest?.head === input.head
          && pullRequest?.base === input.base
          ? structuredClone(pullRequest)
          : null;
      },
      async getPullRequest(input) {
        calls.push(["getPullRequest", structuredClone(input)]);
        return structuredClone(pullRequest);
      },
    },
    tamperTree(treeSha, path, content) {
      trees.get(treeSha)?.set(path, content);
    },
  };
}

function harness({
  repositoryDeliveryMode = "pull-request",
  reply = async () => "Which systems should the agent use?",
  extractProfile = async () => ({
    name: "support-triage",
    summary: "Triage support cases.",
    targetUsers: "Support staff",
    userTypes: ["internal"],
    channels: ["web"],
    capabilities: ["Classify a support case"],
    dataSources: ["Case API"],
    compliance: ["PII"],
    deployment: "AgentCore",
    performsActions: false,
    failureHandling: "Explain when the Case API is unavailable.",
    openQuestions: [],
  }),
  getAgent = async () => testedAgent(),
  getProject = async () => ({
    domainId: DOMAIN,
    id: "case-assist",
    ownerSubject: ACTOR,
    memberSubjects: [],
    status: "ACTIVE",
  }),
  resolveFullBuildSnapshot = async ({ agent }) => fullSnapshot(agent),
  revalidateFullBuildSnapshot = async () => {},
  githubOwner = null,
  github = null,
  githubConfigured = github !== null,
  exchange = async () => ({ token: "github-oauth-token" }),
  revoke = async () => {},
  probeGitHubIdentity = async () => ({
    login: githubOwner,
    userId: 67890,
    canCreatePrivateRepositories: true,
    canManageWorkflows: true,
  }),
  checkpointFailureStatus = null,
  checkpointDeliveryOverride = null,
  composeManifest = fakeManifest,
  logSecurityEvent = () => {},
  remainingTimeInMillis = () => 120_000,
  now = NOW,
} = {}) {
  const journeys = new Map();
  const deliveries = new Map();
  const authorizations = new Map();
  const mutations = new Map();
  const calls = [];
  let sequence = 0;
  let checkpointFailed = false;
  const journeyState = {
    async claimMutation(input) {
      calls.push(["claimMutation", structuredClone(input)]);
      const key = `${input.actor}/${input.operation}/${input.requestId}`;
      const current = mutations.get(key);
      if (current) {
        const binding = {
          ...input,
          proposedResourceId: current.claim.resourceId,
        };
        if (
          current.claim.domainId !== input.domainId
          || current.claim.effectiveRole !== input.effectiveRole
          || current.claim.payloadFingerprint !== input.payloadFingerprint
          || current.claim.resourceType !== input.resourceType
        ) {
          throw Object.assign(new Error("conflict"), {
            code: "MUTATION_CONFLICT",
          });
        }
        return current.result
          ? { status: "SUCCEEDED", result: structuredClone(current.result) }
          : {
              status: "CLAIMED",
              claim: structuredClone({
                ...binding,
                resourceId: current.claim.resourceId,
                leaseToken: current.claim.leaseToken,
              }),
            };
      }
      const claim = {
        actor: input.actor,
        domainId: input.domainId,
        effectiveRole: input.effectiveRole,
        operation: input.operation,
        requestId: input.requestId,
        payloadFingerprint: input.payloadFingerprint,
        resourceType: input.resourceType,
        resourceId: input.proposedResourceId,
        leaseToken: `00000000-0000-4000-8000-${String(
          mutations.size + 1,
        ).padStart(12, "0")}`,
      };
      mutations.set(key, { claim, result: null });
      return { status: "CLAIMED", claim: structuredClone(claim) };
    },
    async completeMutation({ claim, result }) {
      calls.push([
        "completeMutation",
        { claim: structuredClone(claim), result: structuredClone(result) },
      ]);
      const key = `${claim.actor}/${claim.operation}/${claim.requestId}`;
      mutations.get(key).result = structuredClone(result);
      return structuredClone(result);
    },
    async getJourney({ actor, domainId, journeyId }) {
      calls.push(["getJourney", { actor, domainId, journeyId }]);
      return structuredClone(journeys.get(`${actor}/${journeyId}`) || null);
    },
    async putJourney({ record, mutation, claim }) {
      calls.push([
        "putJourney",
        { record: structuredClone(record), mutation: structuredClone(mutation) },
      ]);
      journeys.set(`${record.actor}/${record.id}`, structuredClone(record));
      if (claim) {
        const key = `${claim.actor}/${claim.operation}/${claim.requestId}`;
        mutations.get(key).result = {
          resourceType: "JOURNEY",
          resourceId: record.id,
        };
      }
      return structuredClone(record);
    },
    async getDelivery({ actor, domainId, deliveryId }) {
      calls.push(["getDelivery", { actor, domainId, deliveryId }]);
      return structuredClone(deliveries.get(`${actor}/${deliveryId}`) || null);
    },
    async putDeliveryIntent({ record, mutation, claim }) {
      calls.push([
        "putDeliveryIntent",
        { record: structuredClone(record), mutation: structuredClone(mutation) },
      ]);
      deliveries.set(`${record.actor}/${record.id}`, structuredClone(record));
      if (claim) {
        const key = `${claim.actor}/${claim.operation}/${claim.requestId}`;
        mutations.get(key).result = {
          resourceType: "DELIVERY",
          resourceId: record.id,
        };
      }
      return structuredClone(record);
    },
    async checkpointDelivery({
      actor,
      domainId,
      role,
      deliveryId,
      expectedStatus,
      checkpoint,
    }) {
      calls.push([
        "checkpointDelivery",
        {
          actor,
          domainId,
          role,
          deliveryId,
          expectedStatus,
          checkpoint: structuredClone(checkpoint),
        },
      ]);
      if (checkpointDeliveryOverride) {
        return checkpointDeliveryOverride({
          actor,
          domainId,
          role,
          deliveryId,
          expectedStatus,
          checkpoint,
        });
      }
      if (
        checkpoint.status === checkpointFailureStatus
        && checkpointFailed === false
      ) {
        checkpointFailed = true;
        throw new Error("simulated checkpoint failure");
      }
      const key = `${actor}/${deliveryId}`;
      const current = deliveries.get(key);
      assert.equal(current.domainId, domainId);
      assert.equal(current.role, role);
      assert.equal(current.status, expectedStatus);
      const updated = {
        ...current,
        status: checkpoint.status,
        updatedAt: checkpoint.at,
        checkpoints: [...current.checkpoints, structuredClone(checkpoint)],
      };
      deliveries.set(key, updated);
      return structuredClone(updated);
    },
    async putGitHubAuthorizationIntent({ record }) {
      calls.push([
        "putGitHubAuthorizationIntent",
        { record: structuredClone(record) },
      ]);
      const current = authorizations.get(record.state);
      if (current) {
        const keys = [
          "actor",
          "domainId",
          "role",
          "state",
          "deliveryId",
          "manifestFingerprint",
          "repositoryName",
          "visibility",
          "requestId",
        ];
        if (
          keys.every((key) => current[key] === record[key])
          && current.consumedAt === null
          && Date.parse(current.expiresAt) > Date.parse(now)
        ) {
          return structuredClone(current);
        }
        throw Object.assign(new Error("authorization conflict"), {
          code: "GITHUB_AUTHORIZATION_CONFLICT",
        });
      }
      authorizations.set(record.state, structuredClone(record));
      return structuredClone(record);
    },
    async consumeGitHubAuthorizationIntent({ state }) {
      calls.push([
        "consumeGitHubAuthorizationIntent",
        { state },
      ]);
      const current = authorizations.get(state);
      if (
        !current
        || current.consumedAt !== null
        || Date.parse(current.expiresAt) <= Date.parse(now)
      ) {
        throw Object.assign(new Error("authorization conflict"), {
          code: "GITHUB_AUTHORIZATION_CONFLICT",
        });
      }
      const consumed = { ...current, consumedAt: now };
      authorizations.set(state, consumed);
      return structuredClone(consumed);
    },
  };
  const githubOAuth = {
    configured: () => githubConfigured,
    authorizationState(binding) {
      return `gho_${createHash("sha256")
        .update(JSON.stringify(binding))
        .digest("hex")}`;
    },
    authorizationUrl({ state }) {
      return `https://github.com/login/oauth/authorize?state=${state}`;
    },
    async exchange(input) {
      calls.push(["exchange", structuredClone(input)]);
      return exchange(input);
    },
    async revoke(input) {
      calls.push(["revoke", structuredClone(input)]);
      return revoke(input);
    },
  };
  const service = createJourneyService({
    repositoryDeliveryMode,
    journeyState,
    workspaceState: {
      async getProject(input) {
        calls.push(["getProject", structuredClone(input)]);
        return getProject(input);
      },
      async getAgent(input) {
        calls.push(["getAgent", structuredClone(input)]);
        return getAgent(input);
      },
    },
    inception: {
      async reply(input) {
        calls.push(["reply", structuredClone(input)]);
        return reply(input);
      },
      async extractProfile(input) {
        calls.push(["extractProfile", structuredClone(input)]);
        return extractProfile(input);
      },
    },
    resolveFullBuildSnapshot: async (input) => {
      calls.push(["resolveFullBuildSnapshot", structuredClone(input)]);
      return resolveFullBuildSnapshot(input);
    },
    revalidateFullBuildSnapshot: async (input) => {
      calls.push(["revalidateFullBuildSnapshot", structuredClone(input)]);
      return revalidateFullBuildSnapshot(input);
    },
    githubOAuth,
    probeGitHubIdentity: async (input) => {
      calls.push(["probeGitHubIdentity", structuredClone(input)]);
      return probeGitHubIdentity(input);
    },
    githubClientFactory: ({ owner, token, signal }) => {
      calls.push(["githubClientFactory", { owner, token, signal }]);
      return github;
    },
    composeManifest,
    logSecurityEvent,
    remainingTimeInMillis,
    clock: () => new Date(now),
    idGenerator: (kind) => `${kind}-${++sequence}`,
  });
  return { authorizations, calls, deliveries, journeys, service };
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof JourneyServiceError
      && error.code === code,
  );
}

async function startRepositoryAuthorization(service, input) {
  const repositoryName = input.payload.confirmation.includes("/")
    ? input.payload.confirmation.split("/").at(-1)
    : input.payload.confirmation;
  const authorization = await service.startGitHubAuthorization({
    ...input,
    payload: {
      ...input.payload,
      confirmation: repositoryName,
    },
  });
  return {
    ...authorization,
    state: new URL(authorization.url).searchParams.get("state"),
  };
}

async function createRepository(service, input) {
  const authorization = await startRepositoryAuthorization(service, input);
  return service.completeGitHubAuthorization({
    payload: {
      code: "github-authorization-code",
      state: authorization.state,
    },
  });
}

test("service requires complete hosted dependencies", () => {
  assert.throws(
    () => createJourneyService(),
    /Journey service configuration is invalid/,
  );
});

test("admin, lead, and builder can create domain-scoped MINIMAL and SPEC drafts", async () => {
  for (const role of ["admin", "lead", "builder"]) {
    const { calls, service } = harness();
    const result = await service.createJourney({
      identity: identity({ role }),
      requestId: `create-${role}`,
      payload: {
        preset: role === "admin" ? "MINIMAL" : "SPEC",
        repositoryName: `support-${role}`,
      },
    });

    assert.equal(result.actor, ACTOR);
    assert.equal(result.domainId, DOMAIN);
    assert.equal(result.status, "DRAFT");
    assert.equal(
      result.transcript?.[0]?.role,
      role === "admin" ? undefined : "assistant",
    );
    assert.equal(calls.some(([name]) => name === "putJourney"), true);
    assert.equal(calls.some(([name]) => name === "getAgent"), false);
  }
});

test("lead and builder journeys accept an authorized selected domain from a multi-domain identity", async () => {
  for (const role of ["lead", "builder"]) {
    const { service } = harness();
    const result = await service.createJourney({
      identity: identity({
        role,
        domainIds: [DOMAIN, "operations"],
      }),
      requestId: `create-multi-domain-${role}`,
      payload: {
        preset: "MINIMAL",
        repositoryName: `support-${role}`,
      },
    });

    assert.equal(result.domainId, DOMAIN);
    assert.equal(result.preset, "MINIMAL");
  }
});

test("journey operations deny users and identities without an authorized selected domain", async () => {
  const { service } = harness();
  for (const unauthorized of [
    identity({ role: "user", activeDomain: null, domainIds: [] }),
    identity({ role: "admin", activeDomain: null }),
    identity({ activeDomain: "finance", domainIds: [DOMAIN] }),
  ]) {
    await expectCode(
      service.createJourney({
        identity: unauthorized,
        requestId: "create-denied",
        payload: {
          preset: "MINIMAL",
          repositoryName: "support-foundation",
        },
      }),
      "FORBIDDEN",
    );
  }
});

test("SPEC messages persist user and assistant turns only after Bedrock succeeds", async () => {
  const { calls, service } = harness();
  const created = await service.createJourney({
    identity: identity(),
    requestId: "create-spec",
    payload: { preset: "SPEC", repositoryName: "support-spec" },
  });
  const updated = await service.addMessage({
    identity: identity(),
    requestId: "message-1",
    journeyId: created.id,
    payload: { text: "The agent should triage cases for support staff." },
  });

  assert.deepEqual(updated.transcript, [
    {
      role: "assistant",
      text:
        "What outcome should this agent deliver, who will use it, "
        + "and what must it never do?",
    },
    {
      role: "user",
      text: "The agent should triage cases for support staff.",
    },
    {
      role: "assistant",
      text: "Which systems should the agent use?",
    },
  ]);
  assert.equal(calls.filter(([name]) => name === "putJourney").length, 2);

  const failing = harness({
    reply: async () => {
      throw new Error("Bedrock unavailable");
    },
  });
  const draft = await failing.service.createJourney({
    identity: identity(),
    requestId: "create-failing-spec",
    payload: { preset: "SPEC", repositoryName: "failing-spec" },
  });
  await expectCode(
    failing.service.addMessage({
      identity: identity(),
      requestId: "message-fails",
      journeyId: draft.id,
      payload: { text: "This turn must not be persisted." },
    }),
    "INCEPTION_UNAVAILABLE",
  );
  assert.equal(
    failing.calls.filter(([name]) => name === "putJourney").length,
    1,
  );
  assert.deepEqual(
    (await failing.service.getJourney({
      identity: identity(),
      journeyId: draft.id,
    })).transcript,
    [{
      role: "assistant",
      text:
        "What outcome should this agent deliver, who will use it, "
        + "and what must it never do?",
    }],
  );
});

test("mutation request IDs replay results without repeating Bedrock or creating resources", async () => {
  const { calls, service } = harness();
  const created = await service.createJourney({
    identity: identity(),
    requestId: "spec-once",
    payload: {
      preset: "SPEC",
      repositoryName: "support-spec",
    },
  });
  assert.deepEqual(
    await service.createJourney({
      identity: identity(),
      requestId: "spec-once",
      payload: {
        preset: "SPEC",
        repositoryName: "support-spec",
      },
    }),
    created,
  );

  const firstMessage = await service.addMessage({
    identity: identity(),
    requestId: "message-once",
    journeyId: created.id,
    payload: { text: "Build a support triage agent." },
  });
  assert.deepEqual(
    await service.addMessage({
      identity: identity(),
      requestId: "message-once",
      journeyId: created.id,
      payload: { text: "Build a support triage agent." },
    }),
    firstMessage,
  );
  assert.equal(calls.filter(([name]) => name === "reply").length, 1);
  assert.equal(
    calls.filter(([name]) => name === "putJourney").length,
    2,
  );

  await expectCode(
    service.addMessage({
      identity: identity(),
      requestId: "message-once",
      journeyId: created.id,
      payload: { text: "Use a different request." },
    }),
    "CONFLICT",
  );
});

test("SPEC contract requires two user turns and persists deterministic inception", async () => {
  const { calls, service } = harness();
  const draft = await service.createJourney({
    identity: identity(),
    requestId: "create-spec",
    payload: { preset: "SPEC", repositoryName: "support-spec" },
  });
  await service.addMessage({
    identity: identity(),
    requestId: "message-1",
    journeyId: draft.id,
    payload: { text: "Triage support cases." },
  });
  await expectCode(
    service.createContract({
      identity: identity(),
      requestId: "contract-too-early",
      journeyId: draft.id,
      payload: {},
    }),
    "CONFLICT",
  );
  await service.addMessage({
    identity: identity(),
    requestId: "message-2",
    journeyId: draft.id,
    payload: { text: "Use the Case API and remain read-only." },
  });
  const contract = await service.createContract({
    identity: identity(),
    requestId: "contract-ready",
    journeyId: draft.id,
    payload: {},
  });

  assert.equal(contract.status, "CONTRACT_READY");
  assert.equal(contract.inception.profile.owner, "authenticated builder");
  assert.equal(contract.inception.profile.domain, DOMAIN);
  assert.equal(contract.inception.recommendations.hosting.choice, "AgentCore Runtime");
  assert.ok(contract.inception.acceptance.length > 0);
  assert.deepEqual(
    calls.filter(([name]) => name === "reply")
      .map(([, input]) => ({
        actor: input.actor,
        requestId: input.requestId,
        journeyId: input.journeyId,
        domainId: input.domainId,
      })),
    [
      {
        actor: ACTOR,
        requestId: "message-1",
        journeyId: draft.id,
        domainId: DOMAIN,
      },
      {
        actor: ACTOR,
        requestId: "message-2",
        journeyId: draft.id,
        domainId: DOMAIN,
      },
    ],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "extractProfile")
      .map(([, input]) => ({
        actor: input.actor,
        requestId: input.requestId,
        journeyId: input.journeyId,
        domainId: input.domainId,
      })),
    [{
      actor: ACTOR,
      requestId: "contract-ready",
      journeyId: draft.id,
      domainId: DOMAIN,
    }],
  );
});

test("MINIMAL and SPEC previews use persisted authorized journey sources", async () => {
  for (const preset of ["MINIMAL", "SPEC"]) {
    const { service } = harness({
      ...(preset === "SPEC" ? { getAgent: async () => specAgent() } : {}),
    });
    const draft = await service.createJourney({
      identity: identity(),
      requestId: `create-${preset}`,
      payload: {
        preset,
        repositoryName: `support-${preset.toLowerCase()}`,
      },
    });
    if (preset === "SPEC") {
      await service.addMessage({
        identity: identity(),
        requestId: "message-1",
        journeyId: draft.id,
        payload: { text: "Triage support cases." },
      });
      await service.addMessage({
        identity: identity(),
        requestId: "message-2",
        journeyId: draft.id,
        payload: { text: "Use the Case API." },
      });
      await service.createContract({
        identity: identity(),
        requestId: "contract-1",
        journeyId: draft.id,
        payload: {},
      });
    }
    const preview = await service.createPreview({
      identity: identity(),
      requestId: `preview-${preset}`,
      payload: {
        preset,
        repositoryName: draft.repositoryName,
        journeyId: draft.id,
        ...(preset === "SPEC"
          ? {
              projectId: "case-assist",
              agentId: "triage-agent",
            }
          : {}),
      },
    });

    assert.equal(preview.preset, preset);
    assert.equal(preview.source.snapshot, undefined);
    if (preset === "MINIMAL") {
      assert.deepEqual(preview.source, {
        domainId: DOMAIN,
        journeyId: draft.id,
      });
    } else {
      assert.equal(preview.source.journeyId, draft.id);
      assert.deepEqual(preview.source.agent, {
        domainId: DOMAIN,
        projectId: "case-assist",
        agentId: "triage-agent",
        status: "READY_FOR_TEST",
        contractFingerprint: preview.source.agent.contractFingerprint,
        configurationFingerprint:
          preview.source.agent.configurationFingerprint,
      });
      assert.match(
        preview.source.agent.contractFingerprint,
        /^[a-f0-9]{64}$/,
      );
      assert.match(
        preview.source.agent.configurationFingerprint,
        /^[a-f0-9]{64}$/,
      );
    }
    assert.equal(
      preview.previewExpiresAt,
      "2026-08-27T05:15:00.000Z",
    );
    assert.equal(preview.manifest.fingerprint.length, 64);
  }
});

test("SPEC preview requires an authorized configured Agent", async () => {
  const basePayload = {
    preset: "SPEC",
    repositoryName: "support-spec",
    journeyId: "journey-1",
    projectId: "case-assist",
    agentId: "triage-agent",
  };
  for (const payload of [
    { ...basePayload, projectId: undefined },
    { ...basePayload, agentId: undefined },
    { ...basePayload, unexpected: true },
  ]) {
    await expectCode(
      harness().service.createPreview({
        identity: identity(),
        requestId: "preview-invalid-spec-shape",
        payload,
      }),
      "INVALID_REQUEST",
    );
  }

  const denied = harness({
    getProject: async () => ({
      domainId: DOMAIN,
      id: "case-assist",
      ownerSubject: "other-owner",
      memberSubjects: [],
      status: "ACTIVE",
    }),
  });
  await expectCode(
    denied.service.createPreview({
      identity: identity(),
      requestId: "preview-unassigned-spec-project",
      payload: basePayload,
    }),
    "NOT_FOUND",
  );
  assert.equal(
    denied.calls.some(([name]) => name === "getAgent"),
    false,
  );
});

test("SPEC preview rejects unrelated, non-ready, and unconfigured Agents", async () => {
  for (const [agent, code] of [
    [null, "NOT_FOUND"],
    [testedAgent({ status: "DRAFT" }), "CONFLICT"],
    [specAgent({ status: "TEST_FAILED" }), "CONFLICT"],
    [specAgent({ status: "TESTED" }), "CONFLICT"],
    [specAgent({ status: "REJECTED" }), "CONFLICT"],
    [specAgent({ buildConfig: null }), "CONFLICT"],
    [specAgent({ projectId: "other-project" }), "CONFLICT"],
    [specAgent({
      buildConfig: {
        ...specAgent().buildConfig,
        instructions: "Instructions from another specification.",
      },
    }), "CONFLICT"],
  ]) {
    const { service } = harness({ getAgent: async () => agent });
    const journey = await service.createJourney({
      identity: identity(),
      requestId: `create-spec-${code}-${agent?.status || "missing"}`,
      payload: { preset: "SPEC", repositoryName: "support-spec" },
    });
    await service.addMessage({
      identity: identity(),
      requestId: `message-1-${code}-${agent?.status || "missing"}`,
      journeyId: journey.id,
      payload: { text: "Triage support cases." },
    });
    await service.addMessage({
      identity: identity(),
      requestId: `message-2-${code}-${agent?.status || "missing"}`,
      journeyId: journey.id,
      payload: { text: "Use the Case API." },
    });
    await service.createContract({
      identity: identity(),
      requestId: `contract-${code}-${agent?.status || "missing"}`,
      journeyId: journey.id,
      payload: {},
    });

    await expectCode(
      service.createPreview({
        identity: identity(),
        requestId: `preview-${code}-${agent?.status || "missing"}`,
        payload: {
          preset: "SPEC",
          repositoryName: "support-spec",
          journeyId: journey.id,
          projectId: "case-assist",
          agentId: "triage-agent",
        },
      }),
      code,
    );
  }
});

test("FULL preview accepts configured constructs and delegates snapshot revalidation", async () => {
  const { calls, service } = harness();
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "preview-full",
    payload: {
      preset: "FULL",
      repositoryName: "support-triage",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });

  assert.equal(preview.source.snapshot.snapshotVersion, 1);
  assert.deepEqual(
    calls.find(([name]) => name === "getAgent")[1],
    {
      domainId: DOMAIN,
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  );
  const resolveCall = calls.find(
    ([name]) => name === "resolveFullBuildSnapshot",
  )[1];
  assert.equal(resolveCall.identity.actor, ACTOR);
  assert.equal(resolveCall.agent.status, "TESTED");

  for (const agent of [
    null,
    testedAgent({ status: "DRAFT" }),
    testedAgent({ buildConfig: null }),
    testedAgent({ lastTestEvidenceHash: "malformed" }),
  ]) {
    const invalid = harness({ getAgent: async () => agent });
    await expectCode(
      invalid.service.createPreview({
        identity: identity(),
        requestId: "preview-invalid",
        payload: {
          preset: "FULL",
          repositoryName: "support-triage",
          projectId: "case-assist",
          agentId: "triage-agent",
        },
      }),
      agent === null ? "NOT_FOUND" : "CONFLICT",
    );
    assert.equal(
      invalid.calls.some(
        ([name]) => name === "resolveFullBuildSnapshot",
      ),
      false,
    );
  }
});

test("FULL preview enforces project ownership or membership for builders", async () => {
  const denied = harness({
    getProject: async () => ({
      domainId: DOMAIN,
      id: "case-assist",
      ownerSubject: "other-owner",
      memberSubjects: ["other-member"],
      status: "ACTIVE",
    }),
  });

  await expectCode(
    denied.service.createPreview({
      identity: identity(),
      requestId: "preview-unassigned-project",
      payload: {
        preset: "FULL",
        repositoryName: "support-triage",
        projectId: "case-assist",
        agentId: "triage-agent",
      },
    }),
    "NOT_FOUND",
  );
  assert.equal(
    denied.calls.some(([name]) => name === "getAgent"),
    false,
  );

  for (const role of ["admin", "lead"]) {
    const allowed = harness({
      getProject: async () => ({
        domainId: DOMAIN,
        id: "case-assist",
        ownerSubject: "other-owner",
        memberSubjects: [],
        status: "ACTIVE",
      }),
    });
    const preview = await allowed.service.createPreview({
      identity: identity({ role }),
      requestId: `preview-domain-role-${role}`,
      payload: {
        preset: "FULL",
        repositoryName: `support-${role}`,
        projectId: "case-assist",
        agentId: "triage-agent",
      },
    });
    assert.equal(preview.preset, "FULL");
  }
});

test("preview source and manifest are deterministic while delivery expiry stays bounded", async () => {
  const first = harness();
  const second = harness();
  const input = {
    identity: identity(),
    requestId: "preview-full",
    payload: {
      preset: "FULL",
      repositoryName: "support-triage",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  };
  const left = await first.service.createPreview(input);
  const right = await second.service.createPreview(input);

  assert.deepEqual(left.source, right.source);
  assert.deepEqual(left.manifest, right.manifest);
  assert.equal(
    Date.parse(left.previewExpiresAt) - Date.parse(left.createdAt),
    15 * 60_000,
  );
});

test("GitHub connection is honest when delivery is not configured", async () => {
  const { service } = harness();
  assert.deepEqual(
    await service.getGitHubConnection({ identity: identity() }),
    {
      configured: false,
      tokenSupported: true,
      connected: false,
      owner: null,
    },
  );
  await expectCode(
    service.startGitHubAuthorization({
      identity: identity(),
      requestId: "authorization-unconfigured",
      payload: {
        previewId: "delivery-1",
        fingerprint: "a".repeat(64),
        confirmation: "support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "GITHUB_NOT_CONFIGURED",
  );
});

test("GitHub connection reports only OAuth App configuration", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  assert.deepEqual(
    await service.getGitHubConnection({ identity: identity() }),
    {
      configured: true,
      tokenSupported: true,
      connected: false,
      owner: null,
    },
  );
  assert.equal(
    calls.some(([name]) => name === "probeGitHubIdentity"),
    false,
  );
});

test("authorization start binds the exact preview for ten minutes", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "authorization-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "authorization-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const authorization = await service.startGitHubAuthorization({
    identity: identity(),
    requestId: "authorization-start",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "support-agent",
      acknowledgePrivateRepository: true,
    },
  });
  const state = new URL(authorization.url).searchParams.get("state");
  assert.match(state, /^gho_[a-f0-9]{64}$/);
  assert.equal(authorization.expiresAt, "2026-08-27T05:10:00.000Z");
  assert.deepEqual(
    calls.find(([name]) => name === "putGitHubAuthorizationIntent")[1].record,
    {
      version: 1,
      actor: ACTOR,
      domainId: DOMAIN,
      role: "builder",
      state,
      deliveryId: preview.id,
      manifestFingerprint: preview.manifest.fingerprint,
      repositoryName: "support-agent",
      visibility: "private",
      requestId: "authorization-start",
      expiresAt: "2026-08-27T05:10:00.000Z",
      createdAt: NOW,
      consumedAt: null,
    },
  );

  for (const payload of [
    {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
    {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "other-agent",
      acknowledgePrivateRepository: true,
    },
  ]) {
    await expectCode(
      service.startGitHubAuthorization({
        identity: identity(),
        requestId: "authorization-invalid",
        payload,
      }),
      "INVALID_REQUEST",
    );
  }
});

test("authorization start replays one state for the same request binding", async () => {
  const github = githubHarness();
  const { authorizations, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "authorization-replay-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "authorization-replay-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const request = {
    identity: identity(),
    requestId: "authorization-replay-start",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "support-agent",
      acknowledgePrivateRepository: true,
    },
  };

  const first = await service.startGitHubAuthorization(request);
  const second = await service.startGitHubAuthorization(request);

  assert.deepEqual(second, first);
  assert.equal(authorizations.size, 1);
});

test("cancelling GitHub consumes the one-time state before redirecting", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "authorization-cancel-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "authorization-cancel-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const authorization = await startRepositoryAuthorization(service, {
    identity: identity(),
    requestId: "authorization-cancel-start",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "support-agent",
      acknowledgePrivateRepository: true,
    },
  });

  await service.cancelGitHubAuthorization({
    payload: { state: authorization.state },
  });
  await expectCode(
    service.completeGitHubAuthorization({
      payload: {
        code: "github-authorization-code",
        state: authorization.state,
      },
    }),
    "CONFLICT",
  );
  assert.equal(calls.filter(([name]) => name === "exchange").length, 0);
});

test("callback derives actor, domain, and role only from the consumed one-time state", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-binding-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-binding-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const authorization = await startRepositoryAuthorization(service, {
    identity: identity(),
    requestId: "callback-binding-start",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "support-agent",
      acknowledgePrivateRepository: true,
    },
  });

  assert.equal(
    (await service.completeGitHubAuthorization({
      payload: {
        code: "github-authorization-code",
        state: authorization.state,
      },
    })).status,
    "COMPLETED",
  );
  assert.deepEqual(
    calls.find(([name]) => name === "consumeGitHubAuthorizationIntent")[1],
    { state: authorization.state },
  );
  const approved = calls.find(
    ([name, input]) =>
      name === "checkpointDelivery"
      && input.checkpoint.status === "APPROVED",
  )[1];
  assert.equal(approved.actor, ACTOR);
  assert.equal(approved.domainId, DOMAIN);
  assert.equal(approved.role, "builder");
});

test("callback rejects consumed state without exchanging another token", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-replay-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-replay-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const authorization = await startRepositoryAuthorization(service, {
    identity: identity(),
    requestId: "callback-replay-start",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "support-agent",
      acknowledgePrivateRepository: true,
    },
  });
  const callback = {
    payload: {
      code: "github-authorization-code",
      state: authorization.state,
    },
  };

  assert.equal(
    (await service.completeGitHubAuthorization(callback)).status,
    "COMPLETED",
  );
  await expectCode(
    service.completeGitHubAuthorization(callback),
    "CONFLICT",
  );
  assert.equal(calls.filter(([name]) => name === "exchange").length, 1);
});

test("callback revokes an exchanged token when identity discovery fails", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    probeGitHubIdentity: async () => {
      throw new Error("identity unavailable");
    },
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-probe-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-probe-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  await expectCode(
    createRepository(service, {
      identity: identity(),
      requestId: "callback-probe-start",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "GITHUB_UNAVAILABLE",
  );
  assert.equal(calls.filter(([name]) => name === "revoke").length, 1);
});

test("callback preserves delivery recovery details when delivery and token revocation both fail", async () => {
  const securityEvents = [];
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    probeGitHubIdentity: async () => {
      throw new Error("identity failed with github-oauth-token");
    },
    revoke: async () => {
      throw new Error("revoke failed with github-oauth-token");
    },
    logSecurityEvent(event) {
      securityEvents.push(structuredClone(event));
    },
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-revoke-log-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-revoke-log-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  let failure;
  try {
    await createRepository(service, {
      identity: identity(),
      requestId: "callback-revoke-log-start",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "support-agent",
        acknowledgePrivateRepository: true,
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof JourneyServiceError);
  assert.equal(failure.code, "GITHUB_UNAVAILABLE");
  assert.equal(failure.deliveryId, preview.id);
  assert.equal(failure.revocationFailed, true);
  assert.deepEqual(securityEvents, [{
    event: "github_oauth_revocation_failed",
    code: "REVOCATION_FAILED",
  }]);
  assert.doesNotMatch(
    JSON.stringify(securityEvents),
    /github-oauth-token|github-authorization-code/,
  );
});

test("successful delivery remains recoverable and records a sanitized event when revocation fails", async () => {
  const securityEvents = [];
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    revoke: async () => {
      throw new Error("revoke failed with github-oauth-token");
    },
    logSecurityEvent(event) {
      securityEvents.push(structuredClone(event));
    },
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-revoke-success-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-revoke-success-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  const delivery = await createRepository(service, {
    identity: identity(),
    requestId: "callback-revoke-success-start",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "support-agent",
      acknowledgePrivateRepository: true,
    },
  });
  assert.equal(delivery.status, "COMPLETED");
  assert.equal(delivery.warning, "GITHUB_REVOCATION_FAILED");
  assert.deepEqual(securityEvents, [{
    event: "github_oauth_revocation_failed",
    code: "REVOCATION_FAILED",
  }]);
  assert.doesNotMatch(JSON.stringify(securityEvents), /github-oauth-token/);
});

test("callback refuses token exchange without enough time for exchange and revocation", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    remainingTimeInMillis: () => 22_000,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-exchange-deadline-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-exchange-deadline-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  await expectCode(
    createRepository(service, {
      identity: identity(),
      requestId: "callback-exchange-deadline-start",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "GITHUB_UNAVAILABLE",
  );
  assert.equal(calls.filter(([name]) => name === "exchange").length, 0);
  assert.equal(calls.filter(([name]) => name === "revoke").length, 0);
});

test("callback rechecks the exchange reserve after consuming one-time state", async () => {
  const github = githubHarness();
  const remaining = [30_000, 22_000];
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    remainingTimeInMillis: () => remaining.shift() ?? 22_000,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-state-deadline-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-state-deadline-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  await expectCode(
    createRepository(service, {
      identity: identity(),
      requestId: "callback-state-deadline-start",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "GITHUB_UNAVAILABLE",
  );
  assert.equal(calls.filter(([name]) => name === "exchange").length, 0);
  assert.equal(calls.filter(([name]) => name === "revoke").length, 0);
});

test("callback aborts delivery after exchange to reserve OAuth grant revocation time", async () => {
  const github = githubHarness();
  const remaining = [30_000, 30_000, 16_000];
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    remainingTimeInMillis: () => remaining.shift() ?? 16_000,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-delivery-deadline-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-delivery-deadline-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  await expectCode(
    createRepository(service, {
      identity: identity(),
      requestId: "callback-delivery-deadline-start",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "GITHUB_UNAVAILABLE",
  );
  assert.equal(calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(
    calls.filter(([name]) => name === "githubClientFactory").length,
    0,
  );
  assert.equal(calls.filter(([name]) => name === "revoke").length, 1);
});

test("callback aborts a stalled checkpoint and revokes the exchanged token", async () => {
  const github = githubHarness();
  const remaining = [30_000, 30_000, 17_010];
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    checkpointDeliveryOverride: async () => new Promise(() => {}),
    remainingTimeInMillis: () => remaining.shift() ?? 17_010,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "callback-checkpoint-deadline-journey",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "callback-checkpoint-deadline-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  await expectCode(
    Promise.race([
      createRepository(service, {
        identity: identity(),
        requestId: "callback-checkpoint-deadline-start",
        payload: {
          previewId: preview.id,
          fingerprint: preview.manifest.fingerprint,
          confirmation: "support-agent",
          acknowledgePrivateRepository: true,
        },
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("callback did not abort")), 250);
      }),
    ]),
    "GITHUB_UNAVAILABLE",
  );
  assert.equal(calls.filter(([name]) => name === "exchange").length, 1);
  assert.equal(calls.filter(([name]) => name === "revoke").length, 1);
});

test("explicit approval creates a private repository through durable checkpoints", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "minimal-1",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "preview-1",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const delivered = await createRepository(service, {
    identity: identity(),
    requestId: "deliver-1",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  });

  assert.equal(delivered.status, "COMPLETED");
  assert.match(
    github.calls.find(([name]) => name === "createPrivateRepository")[1]
      .description,
    new RegExp(`delivery ${preview.id} [a-f0-9]{16}$`),
  );
  assert.deepEqual(
    delivered.checkpoints.map(({ status }) => status),
    [
      "APPROVED",
      "REPOSITORY_CREATING",
      "REPOSITORY_CREATED",
      "MAIN_BOOTSTRAPPED",
      "BRANCH_CREATED",
      "SOURCE_COMMITTED",
      "PULL_REQUEST_OPENED",
      "COMPLETED",
    ],
  );
  const commits = github.calls.filter(([name]) => name === "commitFiles");
  assert.deepEqual(
    commits[0][1].files.map(({ path }) => path),
    ["gates/platform-gates.json"],
  );
  assert.equal(
    commits[1][1].files.some(
      ({ path }) => path === "gates/platform-gates.json",
    ),
    false,
  );
  assert.equal(
    calls.filter(([name]) => name === "checkpointDelivery").length,
    8,
  );
  assert.deepEqual(
    calls.find(([name]) => name === "exchange")[1],
    {
      code: "github-authorization-code",
      state: calls.find(
        ([name]) => name === "putGitHubAuthorizationIntent",
      )[1].record.state,
    },
  );
  const factoryInput =
    calls.find(([name]) => name === "githubClientFactory")[1];
  assert.equal(factoryInput.owner, "ExampleOwner");
  assert.equal(factoryInput.token, "github-oauth-token");
  assert.ok(factoryInput.signal instanceof AbortSignal);
  assert.deepEqual(
    calls.find(([name]) => name === "revoke")[1],
    { token: "github-oauth-token" },
  );

  const replayed = await createRepository(service, {
    identity: identity(),
    requestId: "deliver-1-retry",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  });
  assert.equal(replayed.status, "COMPLETED");
  assert.equal(
    github.calls.filter(([name]) =>
      new Set([
        "createPrivateRepository",
        "createBranch",
        "commitFiles",
        "createPullRequest",
      ]).has(name)).length,
    5,
  );
});

test("delivery never adopts a pre-existing repository with a matching marker", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "preexisting-create",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "preexisting-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  await github.client.createPrivateRepository({
    name: "support-agent",
    description:
      `Agentic platform delivery ${preview.id} `
      + preview.manifest.fingerprint.slice(0, 16),
  });

  await expectCode(
    createRepository(service, {
      identity: identity(),
      requestId: "preexisting-delivery",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "ExampleOwner/support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "GITHUB_CONFLICT",
  );
  assert.equal(
    github.calls.filter(([name]) => name === "commitFiles").length,
    0,
  );
  assert.equal(calls.filter(([name]) => name === "revoke").length, 1);
});

test("FULL authorization is revalidated on every retry after approval", async () => {
  let allowed = true;
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    checkpointFailureStatus: "REPOSITORY_CREATED",
    revalidateFullBuildSnapshot: async () => {
      if (!allowed) throw new Error("revoked");
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "preview-revalidate-retry",
    payload: {
      preset: "FULL",
      repositoryName: "support-agent",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });
  const request = {
    identity: identity(),
    requestId: "deliver-revalidate-retry",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  };

  await assert.rejects(
    createRepository(service, request),
    /simulated checkpoint failure/,
  );
  allowed = false;
  await expectCode(createRepository(service, request), "CONFLICT");
  assert.equal(
    github.calls.filter(([name]) => name === "getRepository").length,
    1,
  );
});

test("FULL delivery revalidates current project membership", async () => {
  let assigned = true;
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    getProject: async () => ({
      domainId: DOMAIN,
      id: "case-assist",
      ownerSubject: assigned ? ACTOR : "other-owner",
      memberSubjects: [],
      status: "ACTIVE",
    }),
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "preview-project-revalidation",
    payload: {
      preset: "FULL",
      repositoryName: "support-agent",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });
  assigned = false;

  await expectCode(
    createRepository(service, {
      identity: identity(),
      requestId: "deliver-project-revalidation",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "ExampleOwner/support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "NOT_FOUND",
  );
  assert.equal(github.calls.length, 0);
});

test("approval stays bound to the preview role and frozen FULL snapshot", async () => {
  const github = githubHarness();
  const { calls, service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "preview-full-role",
    payload: {
      preset: "FULL",
      repositoryName: "support-agent",
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });

  await expectCode(
    createRepository(service, {
      identity: identity({ role: "lead" }),
      requestId: "deliver-wrong-role",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "ExampleOwner/support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "FORBIDDEN",
  );
  assert.equal(github.calls.length, 0);

  const delivered = await createRepository(service, {
    identity: identity(),
    requestId: "deliver-frozen",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  });
  assert.equal(delivered.status, "COMPLETED");
  assert.equal(
    calls.filter(([name]) => name === "resolveFullBuildSnapshot").length,
    1,
  );
  assert.equal(
    calls.filter(([name]) => name === "revalidateFullBuildSnapshot").length,
    1,
  );
  assert.deepEqual(
    calls.find(([name]) => name === "revalidateFullBuildSnapshot")[1].snapshot,
    preview.source.snapshot,
  );
});

test("GitHub delivery reconciles external success after a checkpoint failure", async () => {
  for (const failedStatus of [
    "MAIN_BOOTSTRAPPED",
    "BRANCH_CREATED",
    "SOURCE_COMMITTED",
    "PULL_REQUEST_OPENED",
  ]) {
    const github = githubHarness();
    const { service } = harness({
      githubOwner: "ExampleOwner",
      github: github.client,
      checkpointFailureStatus: failedStatus,
    });
    const journey = await service.createJourney({
      identity: identity(),
      requestId: `minimal-${failedStatus}`,
      payload: {
        preset: "MINIMAL",
        repositoryName: "support-agent",
      },
    });
    const preview = await service.createPreview({
      identity: identity(),
      requestId: `preview-${failedStatus}`,
      payload: {
        preset: "MINIMAL",
        repositoryName: "support-agent",
        journeyId: journey.id,
      },
    });
    const request = {
      identity: identity(),
      requestId: `deliver-${failedStatus}`,
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "ExampleOwner/support-agent",
        acknowledgePrivateRepository: true,
      },
    };
    await assert.rejects(
      createRepository(service, request),
      /simulated checkpoint failure/,
    );
    assert.equal(
      (await createRepository(service, {
        ...request,
        requestId: `${request.requestId}-retry`,
      })).status,
      "COMPLETED",
    );
    for (const operation of [
      "createPrivateRepository",
      "createBranch",
      "createPullRequest",
    ]) {
      assert.equal(
        github.calls.filter(([name]) => name === operation).length,
        1,
        `${failedStatus} repeated ${operation}`,
      );
    }
    assert.equal(
      github.calls.filter(([name]) => name === "commitFiles").length,
      2,
      `${failedStatus} repeated a commit`,
    );
  }
});

test("repository creation checkpoint failure resumes the exact platform-created repository", async () => {
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    checkpointFailureStatus: "REPOSITORY_CREATED",
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "checkpoint-gap-create",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "checkpoint-gap-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const request = {
    identity: identity(),
    requestId: "checkpoint-gap-deliver",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  };

  await assert.rejects(
    createRepository(service, request),
    /simulated checkpoint failure/,
  );
  assert.equal(
    (await createRepository(service, {
      ...request,
      requestId: `${request.requestId}-retry`,
    })).status,
    "COMPLETED",
  );
  assert.equal(
    github.calls.filter(([name]) => name === "createPrivateRepository").length,
    1,
  );
  assert.equal(
    github.calls.filter(([name]) => name === "commitFiles").length,
    2,
  );
});

test("repository delivery normalizes a non-main GitHub default branch", async () => {
  const github = githubHarness("ExampleOwner", { defaultBranch: "master" });
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "default-branch-create",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "default-branch-preview",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });

  const delivered = await createRepository(service, {
    identity: identity(),
    requestId: "default-branch-deliver",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  });

  assert.equal(delivered.status, "COMPLETED");
  assert.deepEqual(
    github.calls.filter(([name]) => name === "renameBranch"),
    [[
      "renameBranch",
      {
        repository: "support-agent",
        branch: "master",
        newName: "main",
      },
    ]],
  );
});

test("SPEC delivery reconciles a source commit after checkpoint failure", async () => {
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    checkpointFailureStatus: "SOURCE_COMMITTED",
    composeManifest: composeJourneyManifest,
    getAgent: async () => specAgent(),
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "spec-recovery-create",
    payload: {
      preset: "SPEC",
      repositoryName: "support-agent",
    },
  });
  await service.addMessage({
    identity: identity(),
    requestId: "spec-recovery-message-1",
    journeyId: journey.id,
    payload: { text: "Support staff need a read-only triage assistant." },
  });
  await service.addMessage({
    identity: identity(),
    requestId: "spec-recovery-message-2",
    journeyId: journey.id,
    payload: { text: "It should use the Case API and explain missing evidence." },
  });
  await service.createContract({
    identity: identity(),
    requestId: "spec-recovery-contract",
    journeyId: journey.id,
    payload: {},
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "spec-recovery-preview",
    payload: {
      preset: "SPEC",
      repositoryName: "support-agent",
      journeyId: journey.id,
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });
  const request = {
    identity: identity(),
    requestId: "spec-recovery-deliver",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  };

  await assert.rejects(
    createRepository(service, request),
    /simulated checkpoint failure/,
  );
  assert.equal(
    (await createRepository(service, {
      ...request,
      requestId: `${request.requestId}-retry`,
    })).status,
    "COMPLETED",
  );
  assert.equal(
    github.calls.filter(([name]) => name === "commitFiles").length,
    2,
  );
});

test("SPEC delivery revalidates the exact linked Agent configuration before GitHub mutation", async () => {
  let currentAgent = specAgent();
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    getAgent: async () => currentAgent,
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "spec-agent-revalidation-create",
    payload: { preset: "SPEC", repositoryName: "support-agent" },
  });
  await service.addMessage({
    identity: identity(),
    requestId: "spec-agent-revalidation-message-1",
    journeyId: journey.id,
    payload: { text: "Support staff need a read-only triage assistant." },
  });
  await service.addMessage({
    identity: identity(),
    requestId: "spec-agent-revalidation-message-2",
    journeyId: journey.id,
    payload: { text: "It should use the Case API." },
  });
  await service.createContract({
    identity: identity(),
    requestId: "spec-agent-revalidation-contract",
    journeyId: journey.id,
    payload: {},
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "spec-agent-revalidation-preview",
    payload: {
      preset: "SPEC",
      repositoryName: "support-agent",
      journeyId: journey.id,
      projectId: "case-assist",
      agentId: "triage-agent",
    },
  });
  currentAgent = specAgent({
    modelId: "bedrock-claude/anthropic.claude-haiku-4-5",
  });

  await expectCode(
    createRepository(service, {
      identity: identity(),
      requestId: "spec-agent-revalidation-deliver",
      payload: {
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "ExampleOwner/support-agent",
        acknowledgePrivateRepository: true,
      },
    }),
    "CONFLICT",
  );
  assert.equal(
    github.calls.some(([name]) => name === "createPrivateRepository"),
    false,
  );
});

test("GitHub recovery rejects an altered commit tree", async () => {
  const github = githubHarness();
  const { service } = harness({
    githubOwner: "ExampleOwner",
    github: github.client,
    checkpointFailureStatus: "MAIN_BOOTSTRAPPED",
  });
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "minimal-tree-integrity",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
    },
  });
  const preview = await service.createPreview({
    identity: identity(),
    requestId: "preview-tree-integrity",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-agent",
      journeyId: journey.id,
    },
  });
  const request = {
    identity: identity(),
    requestId: "deliver-tree-integrity",
    payload: {
      previewId: preview.id,
      fingerprint: preview.manifest.fingerprint,
      confirmation: "ExampleOwner/support-agent",
      acknowledgePrivateRepository: true,
    },
  };

  await assert.rejects(
    createRepository(service, request),
    /simulated checkpoint failure/,
  );
  github.tamperTree(
    "d".repeat(40),
    "gates/platform-gates.json",
    '{"tampered":true}\n',
  );
  await expectCode(
    createRepository(service, {
      ...request,
      requestId: `${request.requestId}-retry`,
    }),
    "GITHUB_CONFLICT",
  );
  assert.equal(
    github.calls.filter(([name]) => name === "commitFiles").length,
    1,
  );
});

test("delivery rejects stale or changed approval before GitHub mutation", async () => {
  for (const scenario of [
    {
      now: NOW,
      payload: (preview) => ({
        previewId: preview.id,
        fingerprint: "f".repeat(64),
        confirmation: "ExampleOwner/support-agent",
        acknowledgePrivateRepository: true,
      }),
      code: "CONFLICT",
    },
    {
      now: NOW,
      payload: (preview) => ({
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "ExampleOwner/other-agent",
        acknowledgePrivateRepository: true,
      }),
      code: "INVALID_REQUEST",
    },
    {
      now: "2026-08-27T05:16:00.000Z",
      payload: (preview) => ({
        previewId: preview.id,
        fingerprint: preview.manifest.fingerprint,
        confirmation: "ExampleOwner/support-agent",
        acknowledgePrivateRepository: true,
      }),
      code: "DELIVERY_EXPIRED",
    },
  ]) {
    const github = githubHarness();
    const setup = harness({
      githubOwner: "ExampleOwner",
      github: github.client,
    });
    const journey = await setup.service.createJourney({
      identity: identity(),
      requestId: "minimal-1",
      payload: {
        preset: "MINIMAL",
        repositoryName: "support-agent",
      },
    });
    const preview = await setup.service.createPreview({
      identity: identity(),
      requestId: "preview-1",
      payload: {
        preset: "MINIMAL",
        repositoryName: "support-agent",
        journeyId: journey.id,
      },
    });
    const deliveryService = scenario.now === NOW
      ? setup.service
      : createJourneyService({
          journeyState: {
            ...Object.fromEntries([]),
            claimMutation: async () => {
              throw new Error("claim must not run");
            },
            completeMutation: async () => {
              throw new Error("completion must not run");
            },
            getJourney: async (input) =>
              setup.journeys.get(`${input.actor}/${input.journeyId}`) || null,
            putJourney: async ({ record }) => record,
            getDelivery: async (input) =>
              setup.deliveries.get(`${input.actor}/${input.deliveryId}`) || null,
            putDeliveryIntent: async ({ record }) => record,
            checkpointDelivery: async () => {
              throw new Error("checkpoint must not run");
            },
            putGitHubAuthorizationIntent: async () => {
              throw new Error("authorization must not be stored");
            },
            consumeGitHubAuthorizationIntent: async () => {
              throw new Error("authorization must not be consumed");
            },
          },
          workspaceState: {
            getProject: async () => null,
            getAgent: async () => null,
          },
          inception: {
            reply: async () => "",
            extractProfile: async () => ({}),
          },
          resolveFullBuildSnapshot: async () => ({}),
          revalidateFullBuildSnapshot: async () => {},
          githubOAuth: {
            configured: () => true,
            authorizationState: () => `gho_${"a".repeat(64)}`,
            authorizationUrl: () => {
              throw new Error("authorization URL must not be created");
            },
            exchange: async () => {
              throw new Error("code must not be exchanged");
            },
            revoke: async () => {
              throw new Error("token must not be revoked");
            },
          },
          probeGitHubIdentity: async () => {
            throw new Error("identity must not be probed");
          },
          githubClientFactory: () => github.client,
          composeManifest: fakeManifest,
          clock: () => new Date(scenario.now),
        });
    await expectCode(
      createRepository(deliveryService, {
        identity: identity(),
        requestId: "deliver-1",
        payload: scenario.payload(preview),
      }),
      scenario.code,
    );
    assert.equal(github.calls.length, 0);
  }
});

test("reads remain bound to immutable actor and selected domain", async () => {
  const { service } = harness();
  const journey = await service.createJourney({
    identity: identity(),
    requestId: "create-minimal",
    payload: {
      preset: "MINIMAL",
      repositoryName: "support-foundation",
    },
  });
  assert.equal(
    (await service.getJourney({
      identity: identity(),
      journeyId: journey.id,
    })).id,
    journey.id,
  );
  await expectCode(
    service.getJourney({
      identity: identity({ actor: "other-subject" }),
      journeyId: journey.id,
    }),
    "NOT_FOUND",
  );

  const delivery = await service.createPreview({
    identity: identity(),
    requestId: "preview-minimal",
    payload: {
      preset: "MINIMAL",
      repositoryName: journey.repositoryName,
      journeyId: journey.id,
    },
  });
  const downloaded = await service.getDelivery({ identity: identity(), deliveryId: delivery.id });
  assert.equal(downloaded.id, delivery.id);
  assert.deepEqual(downloaded.manifest, delivery.manifest, "authorized download returns the exact complete preview manifest");
  assert.ok(downloaded.manifest.entries.length > 0);
  await expectCode(service.getDelivery({identity:identity({actor:"other-subject"}),deliveryId:delivery.id}),"NOT_FOUND");
});

test('FULL export does not require deployment or a model test and freezes optional evaluation', async()=>{
 const untested=testedAgent({status:'READY_FOR_TEST',lastTestEvidenceHash:null});
 const {service,calls}=harness({getAgent:async()=>untested});
 const evaluation={dataset:{source:'upload',content:'{"id":"own","input":"Business task","expected":"answer"}\n'},evaluator:{type:'python',code:'def evaluate(case, result):\n    return {"score": 0, "reason": "implement rubric"}\n'}};
 const preview=await service.createPreview({identity:identity(),requestId:'preview-untested-config',payload:{preset:'FULL',repositoryName:'support-triage',projectId:'case-assist',agentId:'triage-agent',evaluation}});
 assert.deepEqual(preview.source.snapshot.evaluation,evaluation);
 assert.equal(preview.source.snapshot.evaluation.evaluator.code,evaluation.evaluator.code);
 assert.equal(calls.some(([name])=>/testAgent|deploy/i.test(name)),false);
});

async function tokenPreview(h) {
  const journey=await h.service.createJourney({identity:identity(),requestId:'token-journey',payload:{preset:'MINIMAL',repositoryName:'support-agent'}});
  return h.service.createPreview({identity:identity(),requestId:'token-preview',payload:{preset:'MINIMAL',repositoryName:'support-agent',journeyId:journey.id}});
}
const USER_GITHUB_TOKEN='ghp_synthetic_user_token_1234567890';
test('caller-owned GitHub token exports reviewed files without OAuth or credential persistence',async()=>{
 const github=githubHarness();const h=harness({github:github.client,githubConfigured:false,repositoryDeliveryMode:'main'});const preview=await tokenPreview(h);
 const input={identity:identity(),requestId:'token-export',payload:{previewId:preview.id,fingerprint:preview.manifest.fingerprint,confirmation:'support-agent',acknowledgePrivateRepository:true,accessToken:USER_GITHUB_TOKEN}};
 const result=await h.service.startGitHubAuthorization(input);assert.equal(result.delivery.status,'COMPLETED');
 const replay=await h.service.startGitHubAuthorization(input);assert.equal(replay.delivery.id,result.delivery.id);
 assert.equal(github.calls.filter(([name])=>name==='createPrivateRepository').length,1);
 assert.equal(github.calls.filter(([name])=>name==='createPullRequest').length,0);
 assert.deepEqual(result.delivery.checkpoints.map(c=>c.status),['APPROVED','REPOSITORY_CREATING','REPOSITORY_CREATED','INITIAL_SOURCE_COMMITTED','COMPLETED']);
 const commit=github.calls.find(([name])=>name==='commitFiles')[1];
 assert.equal(commit.branch,'main');assert.equal(commit.files.length,preview.manifest.entries.length);
 assert.equal(h.calls.filter(([name])=>['exchange','revoke','putGitHubAuthorizationIntent'].includes(name)).length,0);
 const durableCalls=h.calls.filter(([name])=>!['probeGitHubIdentity','githubClientFactory'].includes(name));
 assert.ok(!JSON.stringify(durableCalls).includes(USER_GITHUB_TOKEN));
 assert.ok(!JSON.stringify([...h.deliveries.values()]).includes(USER_GITHUB_TOKEN));
 assert.ok(!JSON.stringify(result).includes(USER_GITHUB_TOKEN));
});
for(const change of [{fingerprint:'0'.repeat(64)},{confirmation:'wrong-repo'},{acknowledgePrivateRepository:false}])test('token export rejects mismatched review before contacting GitHub '+JSON.stringify(change),async()=>{
 const github=githubHarness();const h=harness({github:github.client,githubConfigured:false});const preview=await tokenPreview(h);
 await assert.rejects(h.service.startGitHubAuthorization({identity:identity(),requestId:'token-invalid',payload:{previewId:preview.id,fingerprint:preview.manifest.fingerprint,confirmation:'support-agent',acknowledgePrivateRepository:true,accessToken:USER_GITHUB_TOKEN,...change}}));
 assert.equal(github.calls.length,0);assert.equal(h.calls.filter(([name])=>name==='probeGitHubIdentity').length,0);
});
test('token export cannot use another builder preview',async()=>{
 const github=githubHarness();const h=harness({github:github.client,githubConfigured:false});const preview=await tokenPreview(h);
 await assert.rejects(h.service.startGitHubAuthorization({identity:identity({actor:'another-builder'}),requestId:'token-foreign',payload:{previewId:preview.id,fingerprint:preview.manifest.fingerprint,confirmation:'support-agent',acknowledgePrivateRepository:true,accessToken:USER_GITHUB_TOKEN}}));
 assert.equal(github.calls.length,0);
});
test('GitHub errors cannot leak caller-owned tokens',async()=>{
 const github=githubHarness();const h=harness({github:github.client,githubConfigured:false,probeGitHubIdentity:async()=>{throw Error(USER_GITHUB_TOKEN)}});const preview=await tokenPreview(h);
 await assert.rejects(h.service.startGitHubAuthorization({identity:identity(),requestId:'token-error',payload:{previewId:preview.id,fingerprint:preview.manifest.fingerprint,confirmation:'support-agent',acknowledgePrivateRepository:true,accessToken:USER_GITHUB_TOKEN}}),error=>error.code==='GITHUB_UNAVAILABLE'&&!error.message.includes(USER_GITHUB_TOKEN));
 assert.equal(github.calls.length,0);
});
