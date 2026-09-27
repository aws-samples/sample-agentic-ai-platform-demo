import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createPlatformAgentInception,
  createFullBuildSnapshotRevalidator,
  createFullBuildSnapshotResolver,
  createJourneyRuntime,
  createSecretsBackedGitHubOAuth,
  resolveApplicationRootUrl,
  resolveGitHubOAuthRuntimeConfig,
} from "../lambda/journeys/runtime.mjs";
import {
  defaultGuardrailChain,
} from "../../../console/public/guardrail-chain.mjs";

const DOMAIN = "customer_support";
const MODEL_ID = "bedrock-claude/anthropic.claude-sonnet-5";
const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567";
const ENDPOINT_ARN =
  `${RUNTIME_ARN}/runtime-endpoint/Production`;

test("platform Agent Design Assistant drives Builder discovery through AgentCore Runtime", async () => {
  const invocations = [];
  const responses = [
    { output: "Which data sources should the agent use?" },
    { output: [
      "```json",
      JSON.stringify({
        name: "support-triage",
        capabilities: ["Triage cases"],
      }),
      "```",
    ].join("\n") },
  ];
  const inception = createPlatformAgentInception({
    runtime: {
      async invoke(input) {
        invocations.push(input);
        return responses.shift();
      },
    },
    modelId: MODEL_ID,
    runtimeArn: RUNTIME_ARN,
    endpointArn: ENDPOINT_ARN,
    endpointName: "Production",
  });

  assert.equal(
    await inception.reply({
      transcript: [{ role: "user", text: "Build a support agent." }],
      domainId: DOMAIN,
      actor: "builder-sub-123",
      requestId: "journey-message-123",
      journeyId: "journey-support-agent",
    }),
    "Which data sources should the agent use?",
  );
  assert.deepEqual(
    await inception.extractProfile({
      transcript: [
        { role: "user", text: "Build a support agent." },
        { role: "assistant", text: "Which data sources?" },
        { role: "user", text: "Use the Case API." },
      ],
      domainId: DOMAIN,
      actor: "builder-sub-123",
      requestId: "journey-contract-123",
      journeyId: "journey-support-agent",
    }),
    {
      name: "support-triage",
      capabilities: ["Triage cases"],
    },
  );
  assert.equal(invocations.length, 2);
  assert.deepEqual(
    invocations.map(({ actor, requestId, agent, deployment }) => ({
      actor,
      requestId,
      agent,
      deployment,
    })),
    [
      {
        actor: "builder-sub-123",
        requestId: "journey-message-123",
        agent: {
          domainId: "platform",
          projectId: "platform-foundation",
          id: "agent-design-assistant",
          modelId: MODEL_ID,
          status: "PRODUCTION_DEPLOYED",
        },
        deployment: {
          environment: "PRODUCTION",
          status: "DEPLOYED",
          runtimeStatus: "READY",
          runtimeArn: RUNTIME_ARN,
          endpointName: "Production",
          endpointArn: ENDPOINT_ARN,
        },
      },
      {
        actor: "builder-sub-123",
        requestId: "journey-contract-123",
        agent: {
          domainId: "platform",
          projectId: "platform-foundation",
          id: "agent-design-assistant",
          modelId: MODEL_ID,
          status: "PRODUCTION_DEPLOYED",
        },
        deployment: {
          environment: "PRODUCTION",
          status: "DEPLOYED",
          runtimeStatus: "READY",
          runtimeArn: RUNTIME_ARN,
          endpointName: "Production",
          endpointArn: ENDPOINT_ARN,
        },
      },
    ],
  );
  assert.match(invocations[0].prompt, /concise agent-design inception/i);
  assert.match(invocations[0].prompt, /Build a support agent\./);
  assert.match(invocations[0].prompt, /Customer Support/i);
  assert.match(invocations[1].prompt, /Return only a JSON object/i);
  assert.match(
    invocations[1].prompt,
    /Extract the agent inception profile now/i,
  );
  for (const invocation of invocations) {
    assert.match(
      invocation.sessionId,
      /^session-[a-f0-9]{16}-[a-f0-9]{16}$/,
    );
  }
});

test("platform Agent Design Assistant rejects malformed Runtime responses and profile envelopes", async () => {
  for (const output of [
    undefined,
    "",
    "not json",
    "[]",
  ]) {
    const inception = createPlatformAgentInception({
      runtime: { async invoke() { return { output }; } },
      modelId: MODEL_ID,
      runtimeArn: RUNTIME_ARN,
      endpointArn: ENDPOINT_ARN,
      endpointName: "Production",
    });
    await assert.rejects(
      inception.extractProfile({
        transcript: [
          { role: "user", text: "First turn." },
          { role: "user", text: "Second turn." },
        ],
        domainId: DOMAIN,
        actor: "builder-sub-123",
        requestId: "journey-contract-123",
        journeyId: "journey-support-agent",
      }),
      /Agent Design Assistant response is invalid/,
    );
  }
});

test("GitHub OAuth configuration supports off, rejects partial, and trims complete values", () => {
  assert.equal(resolveGitHubOAuthRuntimeConfig({}), null);
  for (const environment of [
    { GITHUB_OAUTH_CLIENT_ID: "client-id" },
    { GITHUB_OAUTH_CLIENT_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:github/oauth" },
    { GITHUB_OAUTH_CALLBACK_URL: "https://platform.example/" },
    {
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET_ARN:
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:github/oauth",
    },
  ]) {
    assert.throws(
      () => resolveGitHubOAuthRuntimeConfig(environment),
      /Journey runtime configuration is unavailable/,
    );
  }
  assert.deepEqual(
    resolveGitHubOAuthRuntimeConfig({
      GITHUB_OAUTH_CLIENT_ID: " client-id ",
      GITHUB_OAUTH_CLIENT_SECRET_ARN:
        " arn:aws:secretsmanager:us-west-2:123456789012:secret:github/oauth ",
      GITHUB_OAUTH_CALLBACK_URL: " https://platform.example/ ",
    }),
    {
      clientId: "client-id",
      clientSecretArn:
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:github/oauth",
      callbackUrl: "https://platform.example/",
    },
  );
});

test("Journey callback redirect configuration requires one HTTPS application root", () => {
  assert.equal(
    resolveApplicationRootUrl({
      APPLICATION_ROOT_URL: " https://platform.example/ ",
    }),
    "https://platform.example/",
  );
  for (const environment of [
    {},
    { APPLICATION_ROOT_URL: "http://platform.example/" },
    { APPLICATION_ROOT_URL: "https://platform.example/path" },
    { APPLICATION_ROOT_URL: "https://platform.example/?unsafe=true" },
  ]) {
    assert.throws(
      () => resolveApplicationRootUrl(environment),
      /Journey runtime configuration is unavailable/,
    );
  }
});

test("GitHub OAuth client secret loads lazily from one exact Secrets Manager document", async () => {
  const commands = [];
  const requests = [];
  const oauth = createSecretsBackedGitHubOAuth({
    clientId: "client-id",
    clientSecretArn:
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:github/example",
    callbackUrl: "https://platform.example/",
    secrets: {
      async send(command) {
        commands.push(command);
        return {
          SecretString: JSON.stringify({ clientSecret: "test-client-secret" }),
        };
      },
    },
    commandFactory: (input) => ({ input }),
    async fetch(url, options) {
      requests.push({ url, options });
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({
          access_token: "test-token-value",
          token_type: "bearer",
          scope: "repo,workflow",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(oauth.configured(), true);
  assert.match(
    oauth.authorizationUrl({ state: `gho_${"a".repeat(32)}` }),
    /client_id=client-id/,
  );
  assert.equal(commands.length, 0);
  assert.deepEqual(
    await oauth.exchange({
      code: "github-code",
      state: `gho_${"a".repeat(32)}`,
    }),
    { token: "test-token-value" },
  );
  await oauth.revoke({ token: "test-token-value" });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].input, {
    SecretId:
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:github/example",
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].options.headers["content-type"],
    "application/x-www-form-urlencoded;charset=UTF-8",
  );

  const malformed = createSecretsBackedGitHubOAuth({
    clientId: "client-id",
    clientSecretArn:
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:github/example",
    callbackUrl: "https://platform.example/",
    secrets: {
      async send() {
        return {
          SecretString: JSON.stringify({
            clientSecret: "test-client-secret",
            unexpected: true,
          }),
        };
      },
    },
    commandFactory: (input) => ({ input }),
    fetch: globalThis.fetch,
  });
  await assert.rejects(
    malformed.exchange({
      code: "github-code",
      state: `gho_${"a".repeat(32)}`,
    }),
    /GitHub OAuth client secret is invalid/,
  );
});

function approvedVersion({
  semver = "1.0.0",
  content = {},
} = {}) {
  return {
    semver,
    status: "APPROVED",
    content,
    _aws: {
      registryId: "SharedReg123456",
      recordId: "record-123",
    },
  };
}

function entry({
  id,
  type,
  content,
  domain = null,
  recordId = `${type.toLowerCase()}-${id}`,
}) {
  return {
    id,
    type,
    domain,
    defaultVersion: "1.0.0",
    versions: [{
      ...approvedVersion({ content }),
      _aws: {
        registryId: "SharedReg123456",
        recordId,
      },
    }],
  };
}

function agent(overrides = {}) {
  return {
    domainId: DOMAIN,
    projectId: "case-assist",
    id: "triage-agent",
    name: "Triage Agent",
    modelId: MODEL_ID,
    toolIds: ["case-search"],
    mcpServerIds: ["gateway-1/target-1"],
    skillIds: ["case-triage"],
    blueprintIds: ["SharedReg123456/blueprint-chat"],
    memoryIds: ["support-memory"],
    knowledgeBaseIds: ["support-kb"],
    buildConfig: {
      instructions: "Triage cases.",
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
    lastTestEvidenceHash: "b".repeat(64),
    ...overrides,
  };
}

function inventory() {
  return {
    registry: {
      entries: [
        entry({
          id: "chat-assistant",
          type: "Blueprint",
          domain: "shared",
          recordId: "blueprint-chat",
          content: {
            template: {
              framework: "Strands",
              deployTarget: "AgentCore Runtime",
              memory: "shortTerm",
              streaming: true,
              identity: true,
              guardrails: true,
            },
            templateId: "chatagent",
          },
        }),
        entry({
          id: "case-search",
          type: "Tool",
          content: {
            toolType: "agentcore_gateway",
            gateway: "customer-service",
            auth: "awsIam",
            gatewayArn:
              "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
              + "gateway/customer-service",
            ownerEmail: "operator@example.com",
            clientSecret: "must-not-export",
          },
        }),
        entry({
          id: "case-triage",
          type: "Skill",
          content: {
            description: "Classifies cases.",
            ownerEmail: "operator@example.com",
          },
        }),
        entry({
          id: "support-memory",
          type: "Memory",
          content: {
            memoryArn:
              "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
              + "memory/support-memory",
          },
        }),
        entry({
          id: "support-kb",
          type: "KnowledgeBase",
          content: {
            bucketArn: "arn:aws:s3:::customer-private-knowledge",
          },
        }),
      ],
    },
    aiGateway: {
      models: [entry({
        id: MODEL_ID,
        type: "Model",
        content: {
          runtimeModelId: "global.anthropic.claude-sonnet-5",
        },
      })],
      tools: [{
        id: "gateway-1/target-1",
        type: "MCPServer",
        defaultVersion: "1.0.0",
        versions: [{
          semver: "1.0.0",
          status: "APPROVED",
          content: {
            url:
              "https://operator:must-not-export@gateway.example/mcp"
              + "?token=must-not-export",
          },
        }],
      }],
    },
  };
}

test("FULL resolver revalidates the shared Blueprint and every selected domain resource grant", async () => {
  const calls = [];
  const resolver = createFullBuildSnapshotResolver({
    inventoryProvider: async (scope) => {
      calls.push(["inventory", structuredClone(scope)]);
      return inventory();
    },
    modelAccessResolver: async (input) => {
      calls.push(["model", structuredClone(input)]);
      return true;
    },
    workspaceState: {
      async getResourceGrant(input) {
        calls.push(["grant", structuredClone(input)]);
        return {
          ...input,
          status: "ACTIVE",
          grantedBySubject: "lead-sub",
          grantedAt: "2026-08-27T04:00:00.000Z",
          revokedBySubject: null,
          revokedAt: null,
        };
      },
    },
  });
  const sourceAgent = agent();
  const snapshot = await resolver({
    identity: {
      actor: "builder-sub",
      role: "builder",
      activeDomain: DOMAIN,
      domainIds: [DOMAIN],
    },
    agent: sourceAgent,
  });

  assert.equal(snapshot.snapshotVersion, 1);
  assert.equal(
    snapshot.agent.runtimeModelId,
    "global.anthropic.claude-sonnet-5",
  );
  assert.deepEqual(
    snapshot.agent.guardrailChain,
    defaultGuardrailChain(),
  );
  assert.equal(snapshot.blueprint.templateId, "chatagent");
  assert.equal(snapshot.blueprint.blueprintId, "chat-assistant");
  assert.equal(snapshot.blueprint.scope, "shared");
  assert.deepEqual(
    snapshot.resources.map(({ type, id, binding }) => [type, id, binding]),
    [
      [
        "TOOL",
        "case-search",
        {
          adapter: "agentcore_gateway",
          status: "DEPLOYMENT_REQUIRED",
        },
      ],
      [
        "MCP_SERVER",
        "gateway-1/target-1",
        {
          adapter: "remote_mcp",
          status: "DEPLOYMENT_REQUIRED",
        },
      ],
      [
        "SKILL",
        "case-triage",
        {
          adapter: "skill",
          status: "DEPLOYMENT_REQUIRED",
        },
      ],
      [
        "MEMORY",
        "support-memory",
        {
          adapter: "memory",
          status: "DEPLOYMENT_REQUIRED",
        },
      ],
      [
        "KNOWLEDGE_BASE",
        "support-kb",
        {
          adapter: "knowledge_base",
          status: "DEPLOYMENT_REQUIRED",
        },
      ],
    ],
  );
  const serialized = JSON.stringify(snapshot.resources);
  for (const forbidden of [
    "111122223333",
    "arn:aws",
    "operator@example.com",
    "must-not-export",
    "gateway.example",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(
    snapshot.resources.some((resource) =>
      Object.hasOwn(resource, "content")),
    false,
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "grant").map(([, value]) => [
      value.resourceType,
      value.resourceId,
    ]),
    [
      ["TOOL", "case-search"],
      ["MCP_SERVER", "gateway-1/target-1"],
      ["SKILL", "case-triage"],
      ["MEMORY", "support-memory"],
      ["KNOWLEDGE_BASE", "support-kb"],
    ],
  );
});

test("FULL approval revalidates the model without duplicate same-domain grants", async () => {
  const calls = [];
  const revalidate = createFullBuildSnapshotRevalidator({
    modelAccessResolver: async (input) => {
      calls.push(["model", structuredClone(input)]);
      return true;
    },
    workspaceState: {
      async getResourceGrant(input) {
        calls.push(["grant", structuredClone(input)]);
        return {
          ...input,
          status: "ACTIVE",
          grantedBySubject: "lead-sub",
          grantedAt: "2026-08-27T04:00:00.000Z",
          revokedBySubject: null,
          revokedAt: null,
        };
      },
    },
  });
  const snapshot = {
    snapshotVersion: 1,
    agent: {
      domainId: DOMAIN,
      projectId: "case-assist",
      id: "triage-agent",
      name: "Triage Agent",
      instructions: "Triage cases.",
      modelId: MODEL_ID,
      runtimeModelId: "global.anthropic.claude-sonnet-5",
      modelParameters: { temperature: 0.2, maxTokens: 1024 },
      buildOptions: agent().buildConfig.buildOptions,
      testEvidenceHash: "b".repeat(64),
    },
    blueprint: {
      registryId: "SharedReg123456",
      recordId: "blueprint-chat",
      version: "1.0.0",
      blueprintId: "chat-assistant",
      templateId: "chatagent",
      scope: "domain",
      template: agent().buildConfig.buildOptions,
    },
    resources: [{
      type: "TOOL",
      registryId: "SharedReg123456",
      recordId: "tool-case-search",
      version: "1.0.0",
      id: "case-search",
      binding: {
        adapter: "browser",
        status: "MATERIALIZED",
      },
    }],
  };

  await revalidate({
    identity: {
      actor: "builder-sub",
      role: "builder",
      activeDomain: DOMAIN,
      domainIds: [DOMAIN],
    },
    snapshot,
  });

  assert.deepEqual(calls, [
    ["model", { domainId: DOMAIN, modelId: MODEL_ID }],
  ]);

  await assert.rejects(
    createFullBuildSnapshotRevalidator({
      modelAccessResolver: async () => false,
      workspaceState: {
        async getResourceGrant() {
          throw new Error("not called");
        },
      },
    })({
      identity: {
        actor: "builder-sub",
        role: "builder",
        activeDomain: DOMAIN,
        domainIds: [DOMAIN],
      },
      snapshot: {
        ...snapshot,
        blueprint: { ...snapshot.blueprint, scope: "shared" },
      },
    }),
    /model is not granted/,
  );
});

test("FULL resolver accepts a discovered model after access and test checks", async () => {
  const liveInventory = inventory();
  liveInventory.aiGateway.models[0].versions[0].status = "IN_REVIEW";
  const resolver = createFullBuildSnapshotResolver({
    inventoryProvider: async () => liveInventory,
    modelAccessResolver: async () => true,
    workspaceState: {
      async getResourceGrant() {
        return null;
      },
    },
  });

  const snapshot = await resolver({
    identity: {
      actor: "builder-sub",
      role: "builder",
      activeDomain: DOMAIN,
      domainIds: [DOMAIN],
    },
    agent: agent({
      toolIds: [],
      mcpServerIds: [],
      skillIds: [],
      memoryIds: [],
      knowledgeBaseIds: [],
    }),
  });

  assert.equal(
    snapshot.agent.runtimeModelId,
    "global.anthropic.claude-sonnet-5",
  );
});

test("FULL resolver accepts a domain-owned approved Blueprint without a duplicate grant", async () => {
  const scopedInventory = inventory();
  scopedInventory.registry.entries[0].domain = DOMAIN;
  const resolver = createFullBuildSnapshotResolver({
    inventoryProvider: async () => scopedInventory,
    modelAccessResolver: async () => true,
    workspaceState: {
      async getResourceGrant(input) {
        if (input.resourceType === "BLUEPRINT") return null;
        return {
          ...input,
          status: "ACTIVE",
          grantedBySubject: "lead-sub",
          grantedAt: "2026-08-27T04:00:00.000Z",
          revokedBySubject: null,
          revokedAt: null,
        };
      },
    },
  });

  const snapshot = await resolver({
    identity: {
      actor: "builder-sub",
      role: "builder",
      activeDomain: DOMAIN,
      domainIds: [DOMAIN],
    },
    agent: agent(),
  });
  assert.equal(snapshot.blueprint.scope, "domain");
});

test("FULL resolver fails closed for model, grant, blueprint, and version mismatches", async () => {
  const base = {
    inventoryProvider: async () => inventory(),
    modelAccessResolver: async () => true,
    workspaceState: {
      async getResourceGrant(input) {
        return {
          ...input,
          status: "ACTIVE",
          grantedBySubject: "lead-sub",
          grantedAt: "2026-08-27T04:00:00.000Z",
          revokedBySubject: null,
          revokedAt: null,
        };
      },
    },
  };
  const input = {
    identity: {
      actor: "builder-sub",
      role: "builder",
      activeDomain: DOMAIN,
      domainIds: [DOMAIN],
    },
    agent: agent(),
  };
  await assert.rejects(
    createFullBuildSnapshotResolver({
      ...base,
      modelAccessResolver: async () => false,
    })(input),
    /not granted/,
  );
  await assert.rejects(
    createFullBuildSnapshotResolver({
      ...base,
      workspaceState: {
        async getResourceGrant() {
          return null;
        },
      },
    })(input),
    /not granted/,
  );
  await assert.rejects(
    createFullBuildSnapshotResolver(base)({
      ...input,
      agent: agent({ blueprintIds: [] }),
    }),
    /one approved blueprint/,
  );
  await assert.rejects(
    createFullBuildSnapshotResolver(base)({
      ...input,
      agent: agent({
        buildConfig: {
          ...agent().buildConfig,
          buildOptions: {
            ...agent().buildConfig.buildOptions,
            identity: false,
          },
        },
      }),
    }),
    /blueprint options/,
  );
});

test("runtime composes the hosted handler from injected AWS-backed dependencies", async () => {
  const input = {
    journeyState: {
      claimMutation: async () => {
        throw new Error("not called");
      },
      completeMutation: async () => {
        throw new Error("not called");
      },
      getJourney: async () => null,
      putJourney: async ({ record }) => record,
      getDelivery: async () => null,
      putDeliveryIntent: async ({ record }) => record,
      putGitHubAuthorizationIntent: async ({ record }) => record,
      consumeGitHubAuthorizationIntent: async () => null,
      checkpointDelivery: async () => {
        throw new Error("not called");
      },
    },
    workspaceState: {
      getProject: async () => null,
      getAgent: async () => null,
      getResourceGrant: async () => null,
    },
    domainDirectory: {
      async listActiveDomains() {
        return [{ id: DOMAIN }];
      },
    },
    identityVerifier: async () => true,
    inception: {
      reply: async () => "Reply",
      extractProfile: async () => ({}),
    },
    resolveFullBuildSnapshot: async () => ({}),
    revalidateFullBuildSnapshot: async () => {},
    applicationRootUrl: "https://platform.example/",
    clock: () => new Date("2026-08-27T05:00:00.000Z"),
    idGenerator: () => "generated-id",
  };
  const runtime = createJourneyRuntime(input);
  assert.equal(typeof runtime, "function");

  assert.throws(
    () => createJourneyRuntime({
      ...input,
      githubOAuth: {
        configured: () => true,
        authorizationUrl: () => "https://github.com/login/oauth/authorize",
        exchange: async () => ({ token: "token" }),
        revoke: async () => {},
      },
    }),
    /Journey service configuration is invalid/,
  );

  const configured = createJourneyRuntime({
    ...input,
    githubOAuth: {
      configured: () => true,
      authorizationState: () => `gho_${"a".repeat(64)}`,
      authorizationUrl: () => "https://github.com/login/oauth/authorize",
      exchange: async () => ({ token: "token" }),
      revoke: async () => {},
    },
    probeGitHubIdentity: async () => ({
      login: "ExampleOwner",
      canCreatePrivateRepositories: true,
      canManageWorkflows: true,
    }),
    githubClientFactory: () => ({}),
  });
  assert.equal(typeof configured, "function");
});

test("hosted Journey inventory assumes the Gateway role for its domain", async () => {
  const source = await readFile(
    new URL("../lambda/journeys/runtime.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /sourceIdentity:\s*`domain_\$\{scope\.activeDomain\}`/,
  );
  assert.match(source, /event:\s*"journey_inventory_unavailable"/);
  assert.match(source, /component:\s*error\?\.component/);
});

test("FULL exports translate the selected gateway Haiku alias into a portable Bedrock inference profile", async () => {
 const modelId="bedrock-mantle/anthropic.claude-haiku-4-5";
 const data=inventory(); data.aiGateway.models=[entry({id:modelId,type:"Model",content:{runtimeModelId:"anthropic.claude-haiku-4-5"}})];
 const resolver=createFullBuildSnapshotResolver({inventoryProvider:async()=>data,modelAccessResolver:async()=>true,workspaceState:{getResourceGrant:async input=>({...input,status:"ACTIVE",grantedBySubject:"lead-sub",grantedAt:"2026-08-27T04:00:00.000Z",revokedBySubject:null,revokedAt:null})}});
 const snapshot=await resolver({identity:{actor:"builder-sub",role:"builder",activeDomain:DOMAIN,domainIds:[DOMAIN]},agent:agent({modelId})});
 assert.equal(snapshot.agent.runtimeModelId,"global.anthropic.claude-haiku-4-5-20251001-v1:0");
});
