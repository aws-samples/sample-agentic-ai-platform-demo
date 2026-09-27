import { projectAllowsAgent } from "../../../../console/public/project-resource-policy.mjs";
import { converseModelTarget } from "../agent-runtime/bedrock-inference.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  BedrockAgentCoreClient,
} from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import {
  createActiveDomainDirectory,
} from "../api/domain-directory.mjs";
import {
  projectEffectiveIdentity,
  projectIdentity,
  verifyCurrentDemoOperator,
} from "../api/identity.mjs";
import {
  createControlPlaneService,
} from "../control-plane/service.mjs";
import {
  createModelAccessResolver,
} from "../model-governance/access.mjs";
import {
  createModelPolicyState,
} from "../model-governance/state.mjs";
import {
  createPlatformState,
} from "../platform-admin/state.mjs";
import {
  createGatewayCredentialsProvider,
} from "../workspace/gateway-credentials.mjs";
import {
  createRuntimeProofSecretProvider,
} from "../agent-runtime/proof-secret.mjs";
import {
  createAgentRuntimeAdapter,
} from "../experience/runtime-adapter.mjs";
import {
  createWorkspaceState,
} from "../workspace/state.mjs";
import {
  createGitHubClient,
  probeGitHubIdentity,
} from "./github.mjs";
import {
  createGitHubAuthorizationUrl,
  createGitHubOAuth,
} from "./github-oauth.mjs";
import {
  createJourneyHandler,
} from "./index.mjs";
import {
  createJourneyService,
} from "./service.mjs";
import {
  createJourneyState,
} from "./state.mjs";
import {
  createPortableResourceBinding,
} from "./resource-binding.mjs";
import {
  defaultGuardrailChain,
} from "../../../../console/public/guardrail-chain.mjs";

const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,255}$/;
const RUNTIME_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/[A-Za-z0-9_-]{1,48}$/;
const RUNTIME_ENDPOINT_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/[A-Za-z0-9_-]{1,48}\/runtime-endpoint\/[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const ENDPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const JOURNEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const PLATFORM_ASSISTANT = Object.freeze({
  domainId: "platform",
  projectId: "platform-foundation",
  id: "agent-design-assistant",
});
const BLUEPRINT_TEMPLATE_IDS = new Map([
  ["chat-assistant", "chatagent"],
  ["workflow-orchestrator", "workflowagent"],
]);
const RESOURCE_SELECTIONS = Object.freeze([
  ["TOOL", "toolIds"],
  ["MCP_SERVER", "mcpServerIds"],
  ["SKILL", "skillIds"],
  ["MEMORY", "memoryIds"],
  ["KNOWLEDGE_BASE", "knowledgeBaseIds"],
]);
const PROFILE_SYSTEM_PROMPT = [
  "Extract one agent inception profile from the conversation.",
  "Return only a JSON object. Do not add markdown.",
  "Allowed fields: name, summary, targetUsers, userTypes, channels,",
  "capabilities, dataSources, compliance, deployment, performsActions,",
  "failureHandling, openQuestions.",
].join(" ");
const PROFILE_REQUEST = [
  "Extract the agent inception profile now using the known facts.",
  "Put unresolved details in openQuestions.",
].join(" ");
const REPLY_SYSTEM_PROMPT = [
  "You are running a concise agent-design inception.",
  "Ask one useful follow-up question at a time.",
  "Do not generate application code.",
].join(" ");
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

function validText(value, maxBytes = 8_000) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value) <= maxBytes
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validateTranscript(value) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 40
    || value.some((turn) =>
      !plain(turn)
      || Object.keys(turn).sort().join(",") !== "role,text"
      || !new Set(["user", "assistant"]).has(turn.role)
      || !validText(turn.text))
  ) {
    throw new TypeError("Agent Design Assistant request is invalid.");
  }
  return value.map(({ role, text }) => ({ role, text }));
}

function responseText(value) {
  const text = typeof value?.output === "string"
    ? value.output.trim()
    : "";
  if (!validText(text)) {
    throw new Error("Agent Design Assistant response is invalid.");
  }
  return text;
}

function displayDomain(domainId) {
  return domainId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inceptionPrompt({ transcript, domainId, profile }) {
  const system = profile ? PROFILE_SYSTEM_PROMPT : REPLY_SYSTEM_PROMPT;
  const turns = transcript
    .map(({ role, text }) => `${role.toUpperCase()}: ${text}`)
    .join("\n\n");
  return [
    `System: ${system}`,
    `Builder domain: ${displayDomain(domainId)}`,
    "Conversation:",
    turns,
    ...(profile ? [`USER: ${PROFILE_REQUEST}`] : []),
  ].join("\n\n");
}

function runtimeSessionId(journeyId, profile, transcript) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ journeyId, profile, transcript }))
    .digest("hex");
  return `session-${digest.slice(0, 16)}-${digest.slice(16, 32)}`;
}

export function createPlatformAgentInception({
  runtime,
  modelId,
  runtimeArn,
  endpointArn,
  endpointName,
} = {}) {
  if (
    !runtime
    || typeof runtime.invoke !== "function"
    || typeof modelId !== "string"
    || !RESOURCE_ID_PATTERN.test(modelId)
    || !RUNTIME_ARN_PATTERN.test(runtimeArn)
    || !RUNTIME_ENDPOINT_ARN_PATTERN.test(endpointArn)
    || !ENDPOINT_PATTERN.test(endpointName)
    || endpointArn
      !== `${runtimeArn}/runtime-endpoint/${endpointName}`
  ) {
    throw new TypeError(
      "Agent Design Assistant configuration is invalid.",
    );
  }

  async function converse({
    transcript,
    domainId,
    actor,
    requestId,
    journeyId,
    profile,
  }) {
    if (
      !DOMAIN_PATTERN.test(domainId)
      || !SUBJECT_PATTERN.test(actor)
      || !REQUEST_ID_PATTERN.test(requestId)
      || !JOURNEY_ID_PATTERN.test(journeyId)
    ) {
      throw new TypeError("Agent Design Assistant request is invalid.");
    }
    const validatedTranscript = validateTranscript(transcript);
    const response = await runtime.invoke({
      actor,
      requestId,
      sessionId: runtimeSessionId(
        journeyId,
        profile,
        validatedTranscript,
      ),
      prompt: inceptionPrompt({
        transcript: validatedTranscript,
        domainId,
        profile,
      }),
      agent: {
        ...PLATFORM_ASSISTANT,
        modelId,
        status: "PRODUCTION_DEPLOYED",
      },
      deployment: {
        environment: "PRODUCTION",
        status: "DEPLOYED",
        runtimeStatus: "READY",
        runtimeArn,
        endpointName,
        endpointArn,
      },
    });
    return responseText(response);
  }

  return Object.freeze({
    reply(input) {
      return converse({ ...input, profile: false });
    },
    async extractProfile(input) {
      const text = await converse({ ...input, profile: true });
      const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
      let parsed;
      try {
        parsed = JSON.parse(fenced?.[1] ?? text);
      } catch {
        throw new Error("Agent Design Assistant response is invalid.");
      }
      if (!plain(parsed)) {
        throw new Error("Agent Design Assistant response is invalid.");
      }
      return parsed;
    },
  });
}

export function createSecretsBackedGitHubOAuth({
  clientId,
  clientSecretArn,
  callbackUrl,
  secrets,
  commandFactory,
  fetch,
} = {}) {
  if (
    !validText(clientId, 256)
    || typeof clientSecretArn !== "string"
    || !clientSecretArn.startsWith("arn:")
    || !validText(callbackUrl)
    || !secrets
    || typeof secrets.send !== "function"
    || typeof commandFactory !== "function"
    || typeof fetch !== "function"
  ) {
    throw new TypeError("GitHub OAuth configuration is invalid.");
  }
  let oauth;
  async function client() {
    if (oauth) return oauth;
    const response = await secrets.send(commandFactory({
      SecretId: clientSecretArn,
    }));
    let value;
    try {
      value = JSON.parse(response?.SecretString);
    } catch {
      throw new Error("GitHub credential secret is invalid.");
    }
    if (
      !plain(value)
      || Object.keys(value).length !== 1
      || !validText(value.clientSecret, 2_048)
    ) {
      throw new Error("GitHub OAuth client secret is invalid.");
    }
    oauth = createGitHubOAuth({
      clientId,
      clientSecret: value.clientSecret,
      callbackUrl,
      fetch,
    });
    return oauth;
  }
  return Object.freeze({
    configured() {
      return true;
    },
    async authorizationState(input) {
      return (await client()).authorizationState(input);
    },
    authorizationUrl({ state } = {}) {
      return createGitHubAuthorizationUrl({
        clientId,
        callbackUrl,
        state,
      });
    },
    async exchange(input) {
      return (await client()).exchange(input);
    },
    async revoke(input) {
      return (await client()).revoke(input);
    },
  });
}

function optionalEnvironmentText(environment, name) {
  const value = environment?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveGitHubOAuthRuntimeConfig(environment = process.env) {
  const clientId = optionalEnvironmentText(
    environment,
    "GITHUB_OAUTH_CLIENT_ID",
  );
  const clientSecretArn = optionalEnvironmentText(
    environment,
    "GITHUB_OAUTH_CLIENT_SECRET_ARN",
  );
  const callbackUrl = optionalEnvironmentText(
    environment,
    "GITHUB_OAUTH_CALLBACK_URL",
  );
  if (clientId === null && clientSecretArn === null && callbackUrl === null) {
    return null;
  }
  if (clientId === null || clientSecretArn === null || callbackUrl === null) {
    throw new Error("Journey runtime configuration is unavailable.");
  }
  return { clientId, clientSecretArn, callbackUrl };
}

export function resolveApplicationRootUrl(environment = process.env) {
  const value = optionalEnvironmentText(environment, "APPLICATION_ROOT_URL");
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error("Journey runtime configuration is unavailable.");
  }
}

function defaultVersionFor(entry) {
  if (
    !plain(entry)
    || typeof entry.defaultVersion !== "string"
    || !Array.isArray(entry.versions)
  ) {
    return null;
  }
  const versions = entry.versions.filter(
    (version) => version?.semver === entry.defaultVersion,
  );
  return versions.length === 1 && plain(versions[0].content)
      ? versions[0]
      : null;
}

function versionFor(entry) {
  const version = defaultVersionFor(entry);
  return version?.status === "APPROVED" ? version : null;
}

function recordIdentity(entry, version, selectedId) {
  const registryId = version?._aws?.registryId;
  const recordId = version?._aws?.recordId;
  if (
    typeof registryId === "string"
    && RESOURCE_ID_PATTERN.test(registryId)
    && typeof recordId === "string"
    && RESOURCE_ID_PATTERN.test(recordId)
  ) {
    return { registryId, recordId };
  }
  const parts = selectedId.split("/");
  if (
    parts.length === 2
    && parts.every((part) => RESOURCE_ID_PATTERN.test(part))
  ) {
    return { registryId: parts[0], recordId: parts[1] };
  }
  return null;
}

function selectedEntry(entries, selectedId, resourceType) {
  const matches = entries.filter((entry) => {
    const version = versionFor(entry);
    const identity = version && recordIdentity(entry, version, selectedId);
    const reference = identity
      ? `${identity.registryId}/${identity.recordId}`
      : null;
    if (entry.id !== selectedId && reference !== selectedId) return false;
    if (resourceType === "MCP_SERVER") return entry.type === "MCPServer";
    if (resourceType === "BLUEPRINT") return entry.type === "Blueprint";
    if (resourceType === "SKILL") {
      return entry.type === "Skill" && !version.content.toolType;
    }
    if (resourceType === "TOOL") {
      return entry.type === "Tool"
        || (entry.type === "Skill" && Boolean(version.content.toolType));
    }
    if (resourceType === "MEMORY") return entry.type === "Memory";
    if (resourceType === "KNOWLEDGE_BASE") {
      return entry.type === "KnowledgeBase";
    }
    return entry.type?.toUpperCase() === resourceType;
  });
  if (matches.length !== 1) return null;
  const version = versionFor(matches[0]);
  const identity = recordIdentity(matches[0], version, selectedId);
  return version && identity
    ? { entry: matches[0], identity, version }
    : null;
}

function activeGrant(value, domainId, resourceType, resourceId) {
  return plain(value)
    && value.domainId === domainId
    && value.resourceType === resourceType
    && value.resourceId === resourceId
    && value.status === "ACTIVE"
    && value.revokedBySubject === null
    && value.revokedAt === null;
}

function sameOptions(selected, template) {
  return plain(selected)
    && plain(template)
    && Object.entries(selected).every(([key, value]) =>
      template[key] === value);
}

export function createFullBuildSnapshotResolver({
  inventoryProvider,
  modelAccessResolver,
  workspaceState,
} = {}) {
  if (
    typeof inventoryProvider !== "function"
    || typeof modelAccessResolver !== "function"
    || !workspaceState
    || typeof workspaceState.getResourceGrant !== "function"
  ) {
    throw new TypeError("FULL snapshot resolver configuration is invalid.");
  }

  return async function resolveFullBuildSnapshot({ identity, agent } = {}) {
    if (
      !plain(identity)
      || !plain(agent)
      || identity.activeDomain !== agent.domainId
      || !DOMAIN_PATTERN.test(agent.domainId)
      || !plain(agent.buildConfig)
      || !Array.isArray(agent.blueprintIds)
      || agent.blueprintIds.length !== 1
    ) {
      throw new Error("FULL requires one approved blueprint.");
    }
    if (
      await modelAccessResolver({
        domainId: agent.domainId,
        modelId: agent.modelId,
      }) !== true
    ) {
      throw new Error("The selected model is not granted.");
    }
    if (workspaceState.getProject) {
      const project = await workspaceState.getProject({ domainId: agent.domainId, projectId: agent.projectId });
      if (!project || !projectAllowsAgent(project, agent)) throw new Error("Project resource selection does not allow this export.");
    }
    const inventory = await inventoryProvider({
      role: identity.role,
      activeDomain: agent.domainId,
      allowedDomains: [agent.domainId],
    });
    const entries = [
      ...(Array.isArray(inventory?.registry?.entries)
        ? inventory.registry.entries
        : []),
      ...(Array.isArray(inventory?.aiGateway?.models)
        ? inventory.aiGateway.models
        : []),
      ...(Array.isArray(inventory?.aiGateway?.tools)
        ? inventory.aiGateway.tools
        : []),
    ];
    const modelEntry = entries.find((entry) => entry?.id === agent.modelId);
    const modelVersion = defaultVersionFor(modelEntry);
    const runtimeModelId = converseModelTarget(agent.modelId)
      || modelVersion?.content?.runtimeModelId
      || modelEntry?.runtimeModelId;
    if (
      typeof runtimeModelId !== "string"
      || !RESOURCE_ID_PATTERN.test(runtimeModelId)
    ) {
      throw new Error("The selected model is unavailable.");
    }

    const blueprintId = agent.blueprintIds[0];
    const blueprint = selectedEntry(entries, blueprintId, "BLUEPRINT");
    const templateId = BLUEPRINT_TEMPLATE_IDS.get(blueprint?.entry?.id);
    if (
      !blueprint
      || !templateId
      || !sameOptions(
        agent.buildConfig.buildOptions,
        blueprint.version.content.template,
      )
    ) {
      throw new Error("The selected blueprint options do not match.");
    }

    const selectedResources = [];
    for (const [resourceType, field] of RESOURCE_SELECTIONS) {
      if (!Array.isArray(agent[field])) {
        throw new Error("FULL selected resources are invalid.");
      }
      for (const selectedId of agent[field]) {
        const resolved = selectedEntry(entries, selectedId, resourceType);
        if (!resolved) {
          throw new Error("A selected resource is unavailable.");
        }
        if (resolved.entry.domain !== agent.domainId) {
          const grant = await workspaceState.getResourceGrant({
            domainId: agent.domainId,
            resourceType,
            resourceId: selectedId,
          });
          if (!activeGrant(grant, agent.domainId, resourceType, selectedId)) {
            throw new Error("A selected resource is not granted.");
          }
        }
        selectedResources.push({
          type: resourceType,
          registryId: resolved.identity.registryId,
          recordId: resolved.identity.recordId,
          version: resolved.version.semver,
          id: selectedId,
          binding: createPortableResourceBinding(
            resourceType,
            resolved.version.content,
          ),
        });
      }
    }
    return {
      snapshotVersion: 1,
      agent: {
        domainId: agent.domainId,
        projectId: agent.projectId,
        id: agent.id,
        name: agent.name,
        instructions: agent.buildConfig.instructions,
        modelId: agent.modelId,
        runtimeModelId,
        modelParameters:
          structuredClone(agent.buildConfig.modelParameters),
        buildOptions: structuredClone(agent.buildConfig.buildOptions),
        guardrailChain: structuredClone(
          agent.buildConfig.guardrailChain || defaultGuardrailChain(),
        ),
        testEvidenceHash: agent.lastTestEvidenceHash ?? null,
      },
      blueprint: {
        registryId: blueprint.identity.registryId,
        recordId: blueprint.identity.recordId,
        version: blueprint.version.semver,
        blueprintId: blueprint.entry.id,
        templateId,
        scope: blueprint.entry.domain === "shared" ? "shared" : "domain",
        template: structuredClone(blueprint.version.content.template),
      },
      resources: selectedResources,
    };
  };
}

export function createFullBuildSnapshotRevalidator({
  modelAccessResolver,
  workspaceState,
} = {}) {
  if (
    typeof modelAccessResolver !== "function"
    || !workspaceState
    || typeof workspaceState.getResourceGrant !== "function"
  ) {
    throw new TypeError(
      "FULL snapshot revalidator configuration is invalid.",
    );
  }

  return async function revalidateFullBuildSnapshot({
    identity,
    snapshot,
  } = {}) {
    if (
      !plain(identity)
      || !plain(snapshot)
      || identity.activeDomain !== snapshot.agent?.domainId
    ) {
      throw new Error("The frozen FULL snapshot is invalid.");
    }
    const domainId = snapshot.agent.domainId;
    if (workspaceState.getProject) {
      const project = await workspaceState.getProject({ domainId, projectId: snapshot.agent.projectId });
      const selections = { ...snapshot.agent, blueprintIds: [snapshot.blueprint.blueprintId],
        toolIds: [], skillIds: [], mcpServerIds: [] };
      for (const resource of snapshot.resources || []) {
        const field = { TOOL: "toolIds", SKILL: "skillIds", MCP_SERVER: "mcpServerIds" }[resource.type];
        if (field) selections[field].push(resource.id);
      }
      if (!project || !projectAllowsAgent(project, selections)) throw new Error("Project resource selection changed before export.");
    }
    if (
      await modelAccessResolver({
        domainId,
        modelId: snapshot.agent.modelId,
      }) !== true
    ) {
      throw new Error("The selected model is not granted.");
    }
    const grants = [
      ...(Array.isArray(snapshot.resources)
        ? snapshot.resources
          .filter(({ id }) => id.includes("/"))
          .map(({ type, id }) => ({
            resourceType: type,
            resourceId: id,
          }))
        : []),
    ];
    for (const { resourceType, resourceId } of grants) {
      const grant = await workspaceState.getResourceGrant({
        domainId,
        resourceType,
        resourceId,
      });
      if (!activeGrant(grant, domainId, resourceType, resourceId)) {
        throw new Error("A frozen FULL resource is not granted.");
      }
    }
  };
}

const AUTHENTICATED_PROJECTOR = Object.freeze({
    projectAuthenticated(claims) {
      const identity = projectIdentity(claims);
      return {
        ...identity,
        actor: identity.user,
      };
    },
    projectEffective: projectEffectiveIdentity,
});

export function createJourneyRuntime({
  journeyState,
  workspaceState,
  domainDirectory,
  identityVerifier,
  inception,
  resolveFullBuildSnapshot,
  revalidateFullBuildSnapshot,
  githubOAuth = null,
  probeGitHubIdentity: probeIdentity = null,
  githubClientFactory = null,
  applicationRootUrl,
  remainingTimeInMillis = () => 120_000,
  clock,
  idGenerator,
} = {}) {
  if (
    !workspaceState
    || typeof workspaceState.getProject !== "function"
    || typeof workspaceState.getAgent !== "function"
    || !domainDirectory
    || typeof domainDirectory.listActiveDomains !== "function"
    || typeof identityVerifier !== "function"
    || typeof remainingTimeInMillis !== "function"
    || typeof clock !== "function"
  ) {
    throw new TypeError("Journey runtime configuration is invalid.");
  }
  return createJourneyHandler({
    identityProjector: AUTHENTICATED_PROJECTOR,
    identityVerifier,
    applicationRootUrl,
    domainDirectory,
    journeyService: createJourneyService({
      journeyState,
      workspaceState,
      inception,
      resolveFullBuildSnapshot,
      revalidateFullBuildSnapshot,
      githubOAuth,
      probeGitHubIdentity: probeIdentity,
      githubClientFactory,
      remainingTimeInMillis,
      clock,
      ...(idGenerator ? { idGenerator } : {}),
    }),
  });
}

let productionHandler;
const requestClock = new AsyncLocalStorage();
const requestContext = new AsyncLocalStorage();

async function configuredHandler() {
  if (productionHandler) return productionHandler;
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME?.trim();
  const serialized = process.env.CONTROL_PLANE_CONFIG?.trim();
  const modelId = process.env.INCEPTION_MODEL_ID?.trim();
  const runtimeArn = process.env.AGENT_RUNTIME_ARN?.trim();
  const endpointArn =
    process.env.AGENT_RUNTIME_ENDPOINT_ARN?.trim();
  const endpointName =
    process.env.AGENT_RUNTIME_ENDPOINT_NAME?.trim();
  const proofSecretArn =
    process.env.RUNTIME_INVOCATION_PROOF_SECRET_ARN?.trim();
  const githubOAuthConfig = resolveGitHubOAuthRuntimeConfig();
  const applicationRootUrl = resolveApplicationRootUrl();
  if (
    !tableName
    || !serialized
    || !modelId
    || !runtimeArn
    || !endpointArn
    || !endpointName
    || !proofSecretArn
  ) {
    throw new Error("Journey runtime configuration is unavailable.");
  }
  const config = JSON.parse(serialized);
  const clock = () => requestClock.getStore() || new Date();
  const dynamo = new DynamoDBClient({});
  const secrets = new SecretsManagerClient({ region: config.region });
  const workspaceState = createWorkspaceState({
    tableName,
    dynamo,
    now: clock,
  });
  const domainState = createPlatformState({
    tableName,
    dynamo,
    now: clock,
  });
  const journeyState = createJourneyState({
    tableName,
    dynamo,
    now: clock,
  });
  const modelPolicyState = createModelPolicyState({
    tableName,
    dynamo,
    now: () => clock().toISOString(),
  });
  const credentials = createGatewayCredentialsProvider({
    stsClient: new STSClient({
      region: config.llmGatewayRegion,
      credentials: dynamo.config.credentials,
    }),
    roleArn: process.env.GATEWAY_INVOKER_ROLE_ARN,
    clock,
  });
  const githubOAuth = githubOAuthConfig === null
    ? null
    : createSecretsBackedGitHubOAuth({
        ...githubOAuthConfig,
        secrets,
        commandFactory: (input) => new GetSecretValueCommand(input),
        fetch: globalThis.fetch,
      });
  const runtime = createAgentRuntimeAdapter({
    client: new BedrockAgentCoreClient({ region: config.region }),
    proofConfigProvider: createRuntimeProofSecretProvider({
      client: secrets,
      secretArn: proofSecretArn,
      clock,
    }),
    proofClock: () => clock().getTime(),
    maxTokens: 2_048,
  });
  productionHandler = createJourneyRuntime({
    journeyState,
    workspaceState,
    domainDirectory: createActiveDomainDirectory(domainState),
    identityVerifier: verifyCurrentDemoOperator,
    inception: createPlatformAgentInception({
      runtime,
      modelId,
      runtimeArn,
      endpointArn,
      endpointName,
    }),
    resolveFullBuildSnapshot: createFullBuildSnapshotResolver({
      inventoryProvider: async (scope) => {
        try {
          return await createControlPlaneService({
            config,
            domainState,
            credentials: ({ abortSignal }) => credentials({
              sourceIdentity: `domain_${scope.activeDomain}`,
              abortSignal,
            }),
            clock,
          }).inventory(scope);
        } catch (error) {
          console.error({
            event: "journey_inventory_unavailable",
            code: error?.code,
            component: error?.component,
          });
          throw error;
        }
      },
      modelAccessResolver: createModelAccessResolver({
        modelPolicyState,
        workspaceState,
      }),
      workspaceState,
    }),
    revalidateFullBuildSnapshot: createFullBuildSnapshotRevalidator({
      modelAccessResolver: createModelAccessResolver({
        modelPolicyState,
        workspaceState,
      }),
      workspaceState,
    }),
    githubOAuth,
    probeGitHubIdentity: ({ token, signal }) => probeGitHubIdentity({
          token,
          signal,
          fetch: globalThis.fetch,
        }),
    githubClientFactory: ({ owner, token, signal }) => createGitHubClient({
          owner,
          token,
          signal,
          fetch: globalThis.fetch,
        }),
    applicationRootUrl,
    remainingTimeInMillis: () => {
      const context = requestContext.getStore();
      return typeof context?.getRemainingTimeInMillis === "function"
        ? context.getRemainingTimeInMillis()
        : 0;
    },
    clock,
  });
  return productionHandler;
}

export async function handler(event, context) {
  const configured = await configuredHandler();
  return requestClock.run(
    new Date(),
    () => requestContext.run(
      context,
      () => configured(event, context),
    ),
  );
}
