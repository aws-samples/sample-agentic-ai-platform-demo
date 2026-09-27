import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createPlaywrightRoleSwitchingBrowserProcessAdapter,
  createPlaywrightRoleSwitchingBrowserAdapter,
  demoRoleHeaders,
  roleSwitchingRequestIds,
  roleSwitchingUsernames,
  runBrowserStage,
  runCli,
  runHostedRoleSwitchingAcceptance,
} from "./hosted-role-switching-acceptance.mjs";
import * as hostedRoleSwitchingAcceptance
  from "./hosted-role-switching-acceptance.mjs";
import {
  createAcceptanceOwnership,
  createAwsBrokerResourceAdapter,
} from "./hosted-control-plane-acceptance.mjs";

const requireServerlessDependency = createRequire(
  new URL(
    "../infra/serverless-platform/package.json",
    import.meta.url,
  ),
);
const {
  ResourceNotFoundException,
} = requireServerlessDependency(
  "@aws-sdk/client-cognito-identity-provider",
);

const APPLICATION_URL = "https://example.cloudfront.net";
const CLIENT_ID = "7exampleclientid123456789";
const REGION = "us-west-2";
const USER_POOL_ID = "us-west-2_Example123";
const ACCOUNT_ID = "111122223333";
const BROKER_FUNCTION_ARN =
  `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
  + "function:AgenticPlatform-Web-HostedAcceptanceBroker";
const FIXTURE_REGISTRY_ID = "SharedReg12345";
const STARTER_BUILDER_MODEL_ID =
  "bedrock-claude/anthropic.claude-haiku-4-5";
const RUN_ID = "123456789";
const RUN_ATTEMPT = "2";
const OWNERSHIP = createAcceptanceOwnership({
  verifierRunId: RUN_ID,
  verifierRunAttempt: RUN_ATTEMPT,
});
const EXISTING_DOMAIN = {
  id: "operations",
  name: "Operations",
};
const JOURNEY_DOMAIN = EXISTING_DOMAIN;
const DOMAIN = {
  id: OWNERSHIP.domainId,
  name: OWNERSHIP.domainName,
};
const DOMAIN_RECORD = {
  ...DOMAIN,
  owner: `${OWNERSHIP.domainName} domain team`,
  ownerGroup: OWNERSHIP.ownerGroup,
  tokenBudget: "",
  description: `${OWNERSHIP.domainName} domain agents.`,
  registryId: "DomainReg12345",
  registryArn:
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
      + "registry/DomainReg12345",
  status: "ACTIVE",
  createdBy: "temporary-admin-subject",
  createdAt: "2026-08-26T01:00:00.000Z",
};
const DOMAIN_CLEANUP_RECORD = {
  createdBy: DOMAIN_RECORD.createdBy,
  id: DOMAIN_RECORD.id,
  name: DOMAIN_RECORD.name,
  ownerGroup: DOMAIN_RECORD.ownerGroup,
  registryArn: DOMAIN_RECORD.registryArn,
  registryId: DOMAIN_RECORD.registryId,
  status: DOMAIN_RECORD.status,
};
const EXPERIENCE_PROJECT_ID = `ha-project-${RUN_ID}-${RUN_ATTEMPT}`;
const PERSONA_AGENT_ID = `acceptance-agent-${RUN_ID}-${RUN_ATTEMPT}`;
const PERSONA_DEPLOYMENT_ID =
  `acceptance-production-${RUN_ID}-${RUN_ATTEMPT}`;
const PERSONA_APPROVAL_ID =
  `acceptance-production-approval-${RUN_ID}-${RUN_ATTEMPT}`;
const PERSONA_PUBLIC_AGENT_ID = expectedPublicAgentId(
  JOURNEY_DOMAIN.id,
  EXPERIENCE_PROJECT_ID,
  PERSONA_AGENT_ID,
);
const PERSONA_SESSION_ID =
  "session-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb";
const OPTIONAL_OPERATORS = [
  "existing-demo-operator-a",
  "existing-demo-operator-b",
];
const ACCEPTANCE_SOURCE = readFileSync(
  new URL("./hosted-role-switching-acceptance.mjs", import.meta.url),
  "utf8",
);
const PLATFORM_ADMIN_SERVICE_SOURCE = readFileSync(
  new URL(
    "../infra/serverless-platform/lambda/platform-admin/service.mjs",
    import.meta.url,
  ),
  "utf8",
);

function expectedPublicAgentId(domainId, projectId, agentId) {
  return `agent-${
    createHash("sha256")
      .update(`${domainId}\0${projectId}\0${agentId}`)
      .digest("hex")
      .slice(0, 32)
  }`;
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return source.slice(startIndex, endIndex);
}

function roleJourneyInput() {
  const expiresAt = Date.now() + 60_000;
  return {
    applicationUrl: APPLICATION_URL,
    artifactDirectory: "/tmp/role-switching-artifacts",
    domain: DOMAIN,
    ordinaryTokens: {
      accessToken: "private-ordinary-access-token",
      expiresAt,
      idToken: "private-ordinary-id-token",
    },
    tokens: {
      accessToken: "private-access-token",
      expiresAt,
      idToken: "private-id-token",
    },
  };
}

test("default API deadline exceeds the bounded Registry readiness poll", () => {
  const operationTimeout = Number(
    /DEFAULT_OPERATION_TIMEOUT_MS = ([0-9_]+);/
      .exec(ACCEPTANCE_SOURCE)?.[1].replaceAll("_", ""),
  );
  const pollAttempts = Number(
    /DEFAULT_DOMAIN_POLL_ATTEMPTS = ([0-9_]+);/
      .exec(PLATFORM_ADMIN_SERVICE_SOURCE)?.[1].replaceAll("_", ""),
  );
  const pollDelay = Number(
    /DEFAULT_DOMAIN_POLL_DELAY_MS = ([0-9_]+);/
      .exec(PLATFORM_ADMIN_SERVICE_SOURCE)?.[1].replaceAll("_", ""),
  );
  assert.ok(
    operationTimeout > ((pollAttempts - 1) * pollDelay) + 5_000,
  );
});

test("builder model selection honors the deployed governed starter model", () => {
  const selectBuilderModel =
    hostedRoleSwitchingAcceptance.selectBuilderModel;
  assert.equal(typeof selectBuilderModel, "function");
  if (typeof selectBuilderModel !== "function") return;
  const models = [
    { id: "model-first", access: { usable: true } },
    {
      id: STARTER_BUILDER_MODEL_ID,
      access: { usable: true },
    },
  ];
  assert.deepEqual(
    selectBuilderModel(models, STARTER_BUILDER_MODEL_ID),
    models[1],
  );
  assert.equal(
    selectBuilderModel(models, "model-not-granted"),
    null,
  );
});

test("builder acceptance normalizes Blueprint metadata to the API contract", () => {
  const normalizeBuilderBuildOptions =
    hostedRoleSwitchingAcceptance.normalizeBuilderBuildOptions;
  assert.equal(typeof normalizeBuilderBuildOptions, "function");
  if (typeof normalizeBuilderBuildOptions !== "function") return;
  assert.deepEqual(
    normalizeBuilderBuildOptions({
      framework: "Strands",
      deployTarget: "AgentCore Runtime",
      build: "CodeZip",
      protocol: "HTTP",
      memory: "longAndShortTerm",
      streaming: true,
      identity: true,
      guardrails: true,
    }),
    {
      framework: "Strands",
      deployTarget: "AgentCore Runtime",
      memory: "longAndShortTerm",
      streaming: true,
      identity: true,
      guardrails: true,
    },
  );
  assert.equal(
    normalizeBuilderBuildOptions({
      framework: "Strands",
      deployTarget: "AgentCore Runtime",
    }),
    null,
  );
});

function response(status, body) {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type"
          ? "application/json"
          : null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function headersObject(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
}

function adminProfile(overrides = {}) {
  return {
    ok: true,
    user: "temporary-admin-subject",
    actor: "temporary-admin-subject",
    username: "temporary-admin",
    name: "Hosted role-switching administrator",
    identityProvider: "cognito",
    authenticatedRole: "admin",
    role: "admin",
    domain: null,
    domains: ["platform", EXISTING_DOMAIN.id],
    groups: ["platform-admin", "demo-operator"],
    capabilities: [
      "viewAllDomains",
      "manageRegistryEntries",
      "approveRegistryVersion",
    ],
    canSwitchDemoRole: true,
    demoRoleActive: false,
    availableDemoRoles: ["admin", "lead", "builder", "user"],
    availableDemoDomains: [EXISTING_DOMAIN],
    ...overrides,
  };
}

function roleProfile(role, domain = null, overrides = {}) {
  return adminProfile({
    role,
    domain,
    domains: domain ? [domain] : [],
    demoRoleActive: true,
    ...overrides,
  });
}

function ordinaryProfile() {
  return {
    ok: true,
    user: "temporary-ordinary-subject",
    actor: "temporary-ordinary-subject",
    username: "temporary-ordinary",
    name: "Hosted role-switching end user",
    identityProvider: "cognito",
    authenticatedRole: "user",
    role: "user",
    domain: null,
    domains: [],
    groups: ["end-user"],
    capabilities: [],
    canSwitchDemoRole: false,
    demoRoleActive: false,
    availableDemoRoles: [],
    availableDemoDomains: [],
  };
}

function createHarness({
  apiFailure,
  browserError,
  createMaterializesAfterAbortMs = 0,
  createMaterializesAfterTimeoutMs = 0,
  createNeverSettles = false,
  domainCreateRetryOnce = false,
  domainCreateRetryCount = domainCreateRetryOnce ? 1 : 0,
  emptyUserCatalog = false,
  experienceProvisionResult,
  omitScopedDomain = false,
  operatorUsernames = OPTIONAL_OPERATORS,
  postPreflightCollision = false,
  preexistingVerifierManaged = false,
  preexistingVerifierUsername,
  unexpectedEntitledCatalogItem = false,
} = {}) {
  const calls = {
    browser: [],
    cognito: [],
    fetch: [],
    resources: [],
    timeline: [],
  };
  const experienceFixture = {
    domainId: JOURNEY_DOMAIN.id,
    projectId: EXPERIENCE_PROJECT_ID,
    agentId: `ha-agent-${RUN_ID}-${RUN_ATTEMPT}`,
    deploymentId: `ha-deployment-${RUN_ID}-${RUN_ATTEMPT}`,
  };
  let provisionedExperienceFixture = null;
  let mappedActor = null;
  let createdDomain = null;
  let domainCreateAttempts = 0;
  let personaFixture = null;
  let personaAgentStatus = null;
  let personaEntitled = false;
  let personaMembership = false;
  let personaSession = null;
  let specTranscript = [];
  const users = new Map(
    preexistingVerifierUsername === undefined
      ? []
      : [[preexistingVerifierUsername, {
          Username: preexistingVerifierUsername,
          Enabled: true,
          UserStatus: "CONFIRMED",
          UserAttributes: [
            {
              Name: "sub",
              Value: "preexisting-subject",
            },
            ...(preexistingVerifierManaged
              ? [
                  {
                    Name: "name",
                    Value:
                      `Hosted role-switching administrator ${RUN_ID}-${RUN_ATTEMPT}`,
                  },
                  {
                    Name: "custom:managed_by",
                    Value: "agentic-ai-platform-demo",
                  },
                ]
              : []),
          ],
          groups: [],
        }]],
  );
  const operatorRecords = new Map(operatorUsernames.map((username, index) => [
    username,
    {
      Username: username,
      Enabled: true,
      UserStatus: "CONFIRMED",
      UserAttributes: [{
        Name: "sub",
        Value: `existing-operator-subject-${index}`,
      }],
    },
  ]));
  const cognito = {
    async adminCreateUser(input, { abortSignal } = {}) {
      calls.cognito.push(["create", structuredClone(input)]);
      const materializeCreatedUser = () => {
        users.set(input.username, {
          Username: input.username,
          Enabled: true,
          UserStatus: "FORCE_CHANGE_PASSWORD",
          UserAttributes: [
            {
              Name: "sub",
              Value: `subject-${input.username}`,
            },
            ...input.userAttributes.map(({ name, value }) => ({
              Name: name,
              Value: value,
            })),
          ],
          groups: [],
        });
      };
      if (
        postPreflightCollision
        && input.username.includes("-admin-")
      ) {
        users.set(input.username, {
          Username: input.username,
          Enabled: true,
          UserStatus: "CONFIRMED",
          UserAttributes: [
            {
              Name: "sub",
              Value: "concurrent-managed-subject",
            },
            ...input.userAttributes.map(({ name, value }) => ({
              Name: name,
              Value: value,
            })),
          ],
          groups: [],
        });
        const error = new Error("already exists");
        error.code = "UsernameExistsException";
        throw error;
      }
      if (users.has(input.username)) {
        const error = new Error("already exists");
        error.code = "UsernameExistsException";
        throw error;
      }
      if (
        (
          createNeverSettles
          || createMaterializesAfterAbortMs > 0
        )
        && input.username.includes("-admin-")
      ) {
        if (createNeverSettles) {
          return new Promise(() => {});
        }
        return new Promise((_, reject) => {
          const abort = () => {
            if (createMaterializesAfterAbortMs > 0) {
              setTimeout(
                materializeCreatedUser,
                createMaterializesAfterAbortMs,
              );
            }
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (abortSignal?.aborted) {
            abort();
          } else {
            abortSignal?.addEventListener("abort", abort, { once: true });
          }
        });
      }
      if (
        createMaterializesAfterTimeoutMs > 0
        && input.username.includes("-admin-")
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, createMaterializesAfterTimeoutMs)
        );
      }
      materializeCreatedUser();
      return structuredClone(users.get(input.username));
    },
    async adminSetUserPassword(input) {
      calls.cognito.push(["password", {
        ...structuredClone(input),
        password: "[redacted]",
      }]);
      users.get(input.username).UserStatus = "CONFIRMED";
    },
    async adminAddUserToGroup(input) {
      calls.cognito.push(["group", structuredClone(input)]);
      users.get(input.username).groups.push(input.groupName);
    },
    async adminInitiateAuth(input) {
      calls.cognito.push(["authenticate", {
        ...structuredClone(input),
        password: "[redacted]",
      }]);
      const reviewer = input.username.includes("-reviewer-");
      const ordinary = input.username.includes("-ordinary-");
      return {
        AuthenticationResult: {
          AccessToken: reviewer
            ? "reviewer-access-token"
            : ordinary
              ? "ordinary-access-token"
              : "administrator-access-token",
          IdToken: reviewer
            ? "reviewer-id-token"
            : ordinary
              ? "ordinary-id-token"
              : "administrator-id-token",
          ExpiresIn: 3600,
        },
      };
    },
    async adminGetUser(input) {
      calls.cognito.push(["get", structuredClone(input)]);
      if (operatorRecords.has(input.username)) {
        return structuredClone(operatorRecords.get(input.username));
      }
      const user = users.get(input.username);
      if (user) return structuredClone(user);
      const error = new Error("not found");
      error.code = "UserNotFoundException";
      throw error;
    },
    async adminListGroupsForUser(input) {
      calls.cognito.push(["list-groups", structuredClone(input)]);
      if (!operatorRecords.has(input.username)) {
        const error = new Error("not found");
        error.code = "UserNotFoundException";
        throw error;
      }
      return {
        Groups: [
          { GroupName: "platform-admin" },
          { GroupName: "demo-operator" },
        ],
      };
    },
    async adminDeleteUser(input) {
      calls.cognito.push(["delete", structuredClone(input)]);
      calls.timeline.push(["delete-user", input.username]);
      if (!users.delete(input.username)) {
        const error = new Error("not found");
        error.code = "UserNotFoundException";
        throw error;
      }
    },
    async getGroup(input) {
      calls.cognito.push(["get-group", structuredClone(input)]);
      calls.timeline.push(["get-group", input.groupName]);
      throw new ResourceNotFoundException({
        $metadata: {},
        message: "missing",
      });
    },
    isGroupNotFound(error) {
      return error instanceof ResourceNotFoundException;
    },
    isUserNotFound(error) {
      return error?.code === "UserNotFoundException";
    },
  };
  const resources = {
    async persistActorMapping(input) {
      calls.resources.push([
        "persist-actor",
        structuredClone(input),
      ]);
      mappedActor = input.actor;
      return { ok: true };
    },
    async persistPersonaJourneyFixture(input) {
      calls.resources.push([
        "persist-persona",
        structuredClone(input),
      ]);
      personaFixture = structuredClone(input);
      return { ok: true };
    },
    async cleanupPersonaJourneyFixture(input) {
      calls.resources.push([
        "cleanup-persona",
        structuredClone(input),
      ]);
      personaFixture = null;
      return { ok: true };
    },
    async cleanupAgentBuildingJourneyFixtures(input) {
      calls.resources.push([
        "cleanup-agent-building-journeys",
        structuredClone(input),
      ]);
      return { ok: true };
    },
    async provisionExperienceFixture(input) {
      calls.resources.push([
        "provision-experience",
        structuredClone(input),
      ]);
      provisionedExperienceFixture = structuredClone(experienceFixture);
      return structuredClone(
        experienceProvisionResult === undefined
          ? experienceFixture
          : experienceProvisionResult,
      );
    },
    async recoverExperienceFixture(input) {
      calls.resources.push([
        "recover-experience",
        structuredClone(input),
      ]);
      return structuredClone(provisionedExperienceFixture);
    },
    async cleanupExperienceFixture(input) {
      calls.resources.push([
        "cleanup-experience",
        structuredClone(input),
      ]);
      assert.deepEqual(input.fixture, experienceFixture);
      provisionedExperienceFixture = null;
      return { ok: true };
    },
    async cleanupExactResources(input) {
      calls.resources.push(["cleanup", structuredClone(input)]);
      calls.timeline.push(["cleanup-resources"]);
      mappedActor = null;
      createdDomain = null;
      return { ok: true };
    },
    async recoverActorMapping(input) {
      calls.resources.push(["actor", structuredClone(input)]);
      return mappedActor;
    },
    async recoverDomain(input) {
      calls.resources.push(["domain", structuredClone(input)]);
      return createdDomain === null
        ? null
        : structuredClone(DOMAIN_CLEANUP_RECORD);
    },
    async recoverRegistryFixture(input) {
      calls.resources.push(["registry", structuredClone(input)]);
      return null;
    },
  };
  const browser = {
    async verifyRoleJourney(input) {
      calls.browser.push({
        applicationUrl: input.applicationUrl,
        artifactDirectory: input.artifactDirectory,
        domain: structuredClone(input.domain),
        ordinaryTokens: "[redacted]",
        tokens: "[redacted]",
      });
      if (browserError) throw browserError;
      return {
        domainId: input.domain.id,
        roles: [
          "admin",
          "lead",
          "builder",
          "user",
          "user-reload",
          "admin",
        ],
        screenshots: [
          "admin-desktop.png",
          "lead-desktop.png",
          "builder-desktop.png",
          "user-desktop.png",
          "user-reload-desktop.png",
          "admin-mobile.png",
          "lead-mobile.png",
          "builder-mobile.png",
          "user-mobile.png",
          "user-reload-mobile.png",
        ],
      };
    },
  };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const headers = headersObject(options.headers);
    const method = options.method ?? "GET";
    const entry = {
      body: options.body ? JSON.parse(options.body) : undefined,
      headers,
      method,
      path: `${parsed.pathname}${parsed.search}`,
    };
    calls.fetch.push(entry);

    if (apiFailure?.(entry)) {
      return response(503, {
        ok: false,
        code: "TEMPORARY_FAILURE",
      });
    }

    const ordinary = headers.authorization === "Bearer ordinary-access-token";
    const reviewer = headers.authorization === "Bearer reviewer-access-token";
    const role = headers["x-demo-role"];
    const domain = headers["x-active-domain"] ?? null;
    if (ordinary && role) {
      return response(403, {
        ok: false,
        code: "DEMO_ROLE_NOT_ALLOWED",
      });
    }
    if (parsed.pathname === "/api/me") {
      if (ordinary && !role) return response(200, ordinaryProfile());
      if (!role) return response(200, adminProfile({
        user: reviewer
          ? "temporary-reviewer-subject"
          : "temporary-admin-subject",
      }));
      return response(200, roleProfile(role, domain, {
        user: reviewer
          ? "temporary-reviewer-subject"
          : "temporary-admin-subject",
      }));
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/domain-create"
      && !role
      && !ordinary
      && !reviewer
    ) {
      domainCreateAttempts += 1;
      if (domainCreateAttempts <= domainCreateRetryCount) {
        createdDomain = structuredClone(DOMAIN_RECORD);
        return response(503, {
          ok: false,
          code: "DOMAIN_PROVISIONING_FAILED",
          message: "Domain provisioning is temporarily unavailable.",
          retryable: true,
        });
      }
      createdDomain = structuredClone(DOMAIN_RECORD);
      return response(200, {
        ok: true,
        domain: structuredClone(createdDomain),
      });
    }
    if (parsed.pathname === "/api/domains") {
      if (role === "user") return response(200, { ok: true, domains: [] });
      if (role === "lead" || role === "builder") {
        return response(200, { ok: true, domains: [JOURNEY_DOMAIN] });
      }
      return response(200, {
        ok: true,
        domains: [
          { id: "platform", name: "Platform" },
          EXISTING_DOMAIN,
          ...(createdDomain ? [structuredClone(createdDomain)] : []),
        ],
      });
    }
    if (parsed.pathname === "/api/ai-gateway") {
      return role === "user"
        ? response(403, { ok: false, code: "FORBIDDEN" })
        : response(200, {
            ok: true,
            source: "aws",
            models: [{
              id: "model-1",
              access: { usable: true },
            }],
          });
    }
    if (method === "POST" && parsed.pathname === "/api/journeys") {
      return response(201, {
        ok: true,
        journey: {
          version: 1,
          actor: "temporary-admin-subject",
          id: entry.body.preset === "MINIMAL"
            ? "journey-minimal"
            : "journey-spec",
          domainId: JOURNEY_DOMAIN.id,
          preset: entry.body.preset,
          repositoryName: entry.body.repositoryName,
          status: "DRAFT",
          ...(entry.body.preset === "SPEC"
            ? { transcript: [], inception: null }
            : {}),
        },
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/journeys/journey-spec/messages"
    ) {
      specTranscript = [
        ...specTranscript,
        { role: "user", text: entry.body.text },
        { role: "assistant", text: "What should this agent do next?" },
      ];
      return response(200, {
        ok: true,
        journey: {
          version: 1,
          actor: "temporary-admin-subject",
          id: "journey-spec",
          domainId: JOURNEY_DOMAIN.id,
          preset: "SPEC",
          repositoryName:
            `acceptance-spec-${RUN_ID}-${RUN_ATTEMPT}`,
          status: "DRAFT",
          transcript: structuredClone(specTranscript),
          inception: null,
        },
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/journeys/journey-spec/contract"
    ) {
      return response(200, {
        ok: true,
        journey: {
          version: 1,
          actor: "temporary-admin-subject",
          id: "journey-spec",
          domainId: JOURNEY_DOMAIN.id,
          preset: "SPEC",
          repositoryName:
            `acceptance-spec-${RUN_ID}-${RUN_ATTEMPT}`,
          status: "CONTRACT_READY",
          transcript: structuredClone(specTranscript),
          inception: {
            name: "support-triage",
            acceptance: [],
            profile: {
              name: "Support Triage",
              summary: "Triage support cases and explain missing evidence.",
              capabilities: [
                "Triage support cases",
                "Explain when evidence is missing",
              ],
              performsActions: false,
              compliance: ["Use the approved case system"],
            },
          },
        },
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/delivery/previews"
    ) {
      const paths = entry.body.preset === "FULL"
        ? [
            "README.md",
            "agentcore/agentcore.json",
            "gates/check-resource-bindings.mjs",
            ".github/workflows/deploy-dev.yml",
          ]
        : entry.body.preset === "SPEC"
          ? [
              "README.md",
              "agent-binding.json",
              "SPEC.md",
              "tests/test_acceptance.py",
              "gates/platform-gates.json",
            ]
          : ["README.md", "gates/platform-gates.json"];
      return response(201, {
        ok: true,
        delivery: {
          version: 1,
          actor: "temporary-admin-subject",
          id: `delivery-${entry.body.preset.toLowerCase()}`,
          domainId: JOURNEY_DOMAIN.id,
          role: "builder",
          preset: entry.body.preset,
          repositoryName: entry.body.repositoryName,
          visibility: "private",
          source: entry.body.preset === "FULL"
            ? { snapshot: { agent: { id: PERSONA_AGENT_ID } } }
            : entry.body.preset === "SPEC"
              ? {
                  agent: {
                    domainId: JOURNEY_DOMAIN.id,
                    projectId: entry.body.projectId,
                    agentId: entry.body.agentId,
                    status: "READY_FOR_TEST",
                  },
                }
              : {},
          manifest: {
            entries: paths.map((path) => ({ path, content: "" })),
            fingerprint: "a".repeat(64),
            summary: {
              fileCount: paths.length,
              workflowCount: paths.filter((path) =>
                path.startsWith(".github/workflows/")).length,
            },
          },
          status: "PREVIEWED",
        },
      });
    }
    if (parsed.pathname === "/api/delivery/github") {
      return response(200, {
        ok: true,
        github: {
          configured: true,
          connected: false,
          owner: null,
        },
      });
    }
    if (method === "POST" && parsed.pathname === "/api/agents") {
      personaAgentStatus = "DRAFT";
      return response(201, {
        ok: true,
        agent: {
          ...entry.body,
          status: personaAgentStatus,
        },
      });
    }
    if (
      method === "PUT"
      && parsed.pathname === `/api/agents/${PERSONA_AGENT_ID}`
    ) {
      personaAgentStatus = "READY_FOR_TEST";
      return response(200, {
        ok: true,
        agent: {
          ...entry.body,
          status: personaAgentStatus,
        },
      });
    }
    if (
      method === "POST"
      && parsed.pathname === `/api/agents/${PERSONA_AGENT_ID}/test`
    ) {
      personaAgentStatus = "TESTED";
      return response(200, {
        ok: true,
        agent: {
          domainId: JOURNEY_DOMAIN.id,
          projectId: EXPERIENCE_PROJECT_ID,
          id: PERSONA_AGENT_ID,
          status: personaAgentStatus,
        },
        test: {
          output: "Hosted acceptance test response.",
          requestId: "gateway-request",
          usage: { inputTokens: 4, outputTokens: 3 },
        },
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/deployments/production"
    ) {
      personaAgentStatus = "PRODUCTION_PENDING";
      return response(201, {
        ok: true,
        agent: {
          domainId: JOURNEY_DOMAIN.id,
          projectId: EXPERIENCE_PROJECT_ID,
          id: PERSONA_AGENT_ID,
          status: personaAgentStatus,
        },
        deployment: {
          id: PERSONA_DEPLOYMENT_ID,
          status: "REQUESTED",
        },
        approval: {
          id: PERSONA_APPROVAL_ID,
          status: "PENDING",
        },
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/deployment-decisions"
    ) {
      personaAgentStatus = "PRODUCTION_DEPLOYED";
      return response(200, {
        ok: true,
        agent: {
          domainId: JOURNEY_DOMAIN.id,
          projectId: EXPERIENCE_PROJECT_ID,
          id: PERSONA_AGENT_ID,
          status: personaAgentStatus,
        },
        deployment: {
          id: PERSONA_DEPLOYMENT_ID,
          status: "DEPLOYED",
        },
        approval: {
          id: PERSONA_APPROVAL_ID,
          status: "APPROVED",
        },
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/access/domain-memberships"
    ) {
      personaMembership = true;
      return response(201, {
        ok: true,
        domainId: JOURNEY_DOMAIN.id,
        username:
          `hosted-role-switching-ordinary-${RUN_ID}-${RUN_ATTEMPT}`,
        subject:
          `subject-hosted-role-switching-ordinary-${RUN_ID}-${RUN_ATTEMPT}`,
        status: "ACTIVE",
        changed: true,
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/governance/agent-entitlements"
    ) {
      personaEntitled = true;
      return response(201, {
        ok: true,
        subjectType: "USER",
        subject: "temporary-admin-subject",
        domainId: JOURNEY_DOMAIN.id,
        projectId: EXPERIENCE_PROJECT_ID,
        agentId: PERSONA_AGENT_ID,
        status: "ACTIVE",
        expiresAt: null,
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/experience/invocations"
    ) {
      personaSession = {
        id: PERSONA_SESSION_ID,
        agentId: PERSONA_PUBLIC_AGENT_ID,
        status: "ACTIVE",
        lastInvocationStatus: "SUCCEEDED",
        createdAt: "2026-08-26T01:00:00.000Z",
        updatedAt: "2026-08-26T01:00:01.000Z",
      };
      return response(200, {
        ok: true,
        sessionId: PERSONA_SESSION_ID,
        status: "SUCCEEDED",
        output: "Hosted acceptance invocation response.",
        invocationId: "runtime-invocation-123",
        replayed: false,
      });
    }
    if (
      method === "POST"
      && parsed.pathname === "/api/experience/feedback"
    ) {
      return response(201, {
        ok: true,
        id: "feedback-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "RECORDED",
      });
    }
    if (
      ["/api/projects", "/api/agents", "/api/deployments", "/api/approvals"]
        .includes(parsed.pathname)
    ) {
      const resource = parsed.pathname.slice("/api/".length);
      const personaItems = resource === "agents" && personaAgentStatus
        ? [{
            id: PERSONA_AGENT_ID,
            domainId: JOURNEY_DOMAIN.id,
            projectId: EXPERIENCE_PROJECT_ID,
            status: personaAgentStatus,
          }]
        : [];
      return response(200, {
        ok: true,
        resource,
        items: [{
          id: `${resource}-record`,
          domainId: JOURNEY_DOMAIN.id,
        }, ...personaItems],
      });
    }
    if (parsed.pathname === "/api/governance/agent-entitlements") {
      if (role === "builder" || role === "user") {
        return response(403, { ok: false, code: "FORBIDDEN" });
      }
      return response(200, {
        ok: true,
        items: [{
          subjectType: "USER",
          subject: "temporary-admin-subject",
          domainId: JOURNEY_DOMAIN.id,
          projectId: experienceFixture.projectId,
          agentId: experienceFixture.agentId,
          status: "ACTIVE",
          expiresAt: null,
          grantedAt: "2026-08-26T01:00:00.000Z",
          revokedAt: null,
        }, ...(personaEntitled ? [{
          subjectType: "USER",
          subject: "temporary-admin-subject",
          domainId: JOURNEY_DOMAIN.id,
          projectId: EXPERIENCE_PROJECT_ID,
          agentId: PERSONA_AGENT_ID,
          status: "ACTIVE",
          expiresAt: null,
          grantedAt: "2026-08-26T01:00:02.000Z",
          revokedAt: null,
        }] : [])],
        cursor: null,
      });
    }
    if (
      parsed.pathname === "/api/access/domain-members"
      || parsed.pathname === "/api/access/project-members"
    ) {
      if (role === "builder" || role === "user") {
        return response(403, { ok: false, code: "FORBIDDEN" });
      }
      const projectScoped =
        parsed.pathname === "/api/access/project-members";
      return response(200, {
        ok: true,
        domainId: JOURNEY_DOMAIN.id,
        ...(projectScoped
          ? { projectId: parsed.searchParams.get("projectId") }
          : {}),
        items: [{
          username: "temporary-admin",
          subject: "temporary-admin-subject",
          enabled: true,
          userStatus: "CONFIRMED",
        }, ...(personaMembership && !projectScoped ? [{
          username:
            `hosted-role-switching-ordinary-${RUN_ID}-${RUN_ATTEMPT}`,
          subject:
            `subject-hosted-role-switching-ordinary-${RUN_ID}-${RUN_ATTEMPT}`,
          enabled: true,
          userStatus: "CONFIRMED",
        }] : [])],
        cursor: null,
      });
    }
    if (parsed.pathname === "/api/experience/agents") {
      const experiencePublicAgentId = expectedPublicAgentId(
        JOURNEY_DOMAIN.id,
        experienceFixture.projectId,
        experienceFixture.agentId,
      );
      return role === "user"
        ? response(200, {
            ok: true,
            items: emptyUserCatalog
              ? []
              : [{
                  id: experiencePublicAgentId,
                  name: "Approved Agent",
                  description: "Approved for the hosted experience.",
                }, ...(personaEntitled ? [{
                  id: PERSONA_PUBLIC_AGENT_ID,
                  name: "Hosted Acceptance Agent",
                  description: "Approved positive persona journey.",
                }] : []), ...(unexpectedEntitledCatalogItem ? [{
                  id: "agent-0123456789abcdef0123456789abcdef",
                  name: "Unexpected Agent",
                  description: "Not backed by this acceptance run.",
                }] : [])],
            requestableItems: [{
              id: "agent-fedcba9876543210fedcba9876543210",
              domainId: JOURNEY_DOMAIN.id,
              name: "Requestable Agent",
              description: "Approved and available through domain approval.",
            }],
          })
        : response(403, { ok: false, code: "FORBIDDEN" });
    }
    if (
      ["/api/experience/sessions", "/api/experience/access-requests"]
        .includes(parsed.pathname)
    ) {
      return role === "user"
        ? response(200, {
            ok: true,
            items:
              parsed.pathname === "/api/experience/sessions"
              && personaSession
                ? [personaSession]
                : [],
          })
        : response(403, { ok: false, code: "FORBIDDEN" });
    }
    if (parsed.pathname === "/api/registry") {
      if (role === "user") {
        return response(403, { ok: false, code: "FORBIDDEN" });
      }
      return response(200, {
        ok: true,
        source: "aws",
        entries: [{
          id: "domain-agent",
          type: "Agent",
          ...(omitScopedDomain ? {} : { domain: JOURNEY_DOMAIN.id }),
          versions: [{ semver: "1.0.0", status: "APPROVED" }],
        }, {
          id: "shared-skill",
          type: "Skill",
          domain: "shared",
          versions: [{ semver: "1.0.0", status: "APPROVED" }],
        }, {
          id: "chat-assistant",
          type: "Blueprint",
          domain: "shared",
          defaultVersion: "1.0.0",
          versions: [{
            semver: "1.0.0",
            status: "APPROVED",
            content: {
              template: {
                framework: "Strands",
                deployTarget: "AgentCore Runtime",
                memory: "longAndShortTerm",
                streaming: true,
                identity: true,
                guardrails: true,
              },
            },
          }],
        }],
      });
    }
    if (
      method === "POST"
      && ["/api/domain-create", "/api/registry-decide"]
        .includes(parsed.pathname)
    ) {
      return response(403, { ok: false, code: "FORBIDDEN" });
    }
    return response(404, { ok: false, code: "NOT_FOUND" });
  };
  return {
    browser,
    calls,
    cognito,
    fetchImpl,
    resources,
    get createdDomain() {
      return structuredClone(createdDomain);
    },
    get personaFixture() {
      return structuredClone(personaFixture);
    },
    users,
  };
}

test("role headers fail closed and use only the two accepted headers", () => {
  assert.deepEqual(demoRoleHeaders("admin"), {
    "x-demo-role": "admin",
  });
  assert.deepEqual(demoRoleHeaders("admin", DOMAIN.id), {
    "x-demo-role": "admin",
    "x-active-domain": DOMAIN.id,
  });
  assert.deepEqual(demoRoleHeaders("admin", "platform"), {
    "x-demo-role": "admin",
    "x-active-domain": "platform",
  });
  assert.deepEqual(demoRoleHeaders("lead", DOMAIN.id), {
    "x-demo-role": "lead",
    "x-active-domain": DOMAIN.id,
  });
  assert.deepEqual(demoRoleHeaders("builder", DOMAIN.id), {
    "x-demo-role": "builder",
    "x-active-domain": DOMAIN.id,
  });
  assert.deepEqual(demoRoleHeaders("user"), {
    "x-demo-role": "user",
  });
  for (const input of [
    ["owner"],
    ["lead"],
    ["builder", "platform"],
    ["user", DOMAIN.id],
    ["admin", "shared"],
  ]) {
    assert.throws(
      () => demoRoleHeaders(...input),
      (error) =>
        error?.code === "HOSTED_ROLE_SWITCHING_CONFIGURATION_INVALID"
        && !JSON.stringify(error).includes(DOMAIN.id),
    );
  }
});

test("temporary usernames and mutation request IDs are deterministic and generic", () => {
  const usernames = roleSwitchingUsernames({
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  assert.deepEqual(usernames, {
    administrator:
      `hosted-role-switching-admin-${RUN_ID}-${RUN_ATTEMPT}`,
    reviewer:
      `hosted-role-switching-reviewer-${RUN_ID}-${RUN_ATTEMPT}`,
    ordinary:
      `hosted-role-switching-ordinary-${RUN_ID}-${RUN_ATTEMPT}`,
  });
  assert.doesNotMatch(
    JSON.stringify(usernames),
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );

  const first = roleSwitchingRequestIds({
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  const second = roleSwitchingRequestIds({
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), [
    "adminDomain",
    "builderConfigureAgent",
    "builderCreateAgent",
    "builderDomain",
    "builderProduction",
    "builderRegistry",
    "builderTestAgent",
    "journeyFullPreview",
    "journeyMinimalCreate",
    "journeyMinimalPreview",
    "journeySpecContract",
    "journeySpecCreate",
    "journeySpecMessageOne",
    "journeySpecMessageTwo",
    "journeySpecPreview",
    "leadAccessGrant",
    "leadApproval",
    "leadDomain",
    "leadEntitlementGrant",
    "userDomain",
    "userFeedback",
    "userInvoke",
  ]);
  assert.equal(
    first.adminDomain,
    OWNERSHIP.requestIds.domain,
  );
  assert.equal(new Set(Object.values(first)).size, Object.keys(first).length);
  for (const requestId of Object.values(first)) {
    assert.match(
      requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
});

test("hosted acceptance proves every role, every configured operator, Demo Assist, and exact cleanup", async () => {
  const harness = createHarness();
  const artifactRoot = mkdtempSync(
    join(tmpdir(), "hosted-role-switching-test-"),
  );
  try {
    const result = await runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      createArtifactDirectory: () => {
        const directory = join(artifactRoot, "private");
        return directory;
      },
      ensureArtifactDirectory: () => {
        const directory = join(artifactRoot, "private");
        return directory;
      },
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      operatorUsernames: OPTIONAL_OPERATORS,
      randomPassword: (label) =>
        label === "administrator"
          ? "Administrator-Acceptance-1!"
          : "Ordinary-Acceptance-2!",
      region: REGION,
      removeArtifactDirectory: () => {},
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    });

    assert.deepEqual(result, {
      domain: JOURNEY_DOMAIN,
      ok: true,
    });
    assert.equal(harness.calls.browser.length, 1);
    assert.deepEqual(harness.calls.browser[0].domain, JOURNEY_DOMAIN);
    assert.equal(harness.calls.browser[0].tokens, "[redacted]");
    assert.equal(harness.calls.browser[0].ordinaryTokens, "[redacted]");

    const groupCalls = harness.calls.cognito.filter(([name]) =>
      name === "group"
    ).map(([, input]) => [
      input.username.includes("-ordinary-")
        ? "ordinary"
        : input.username.includes("-reviewer-")
          ? "reviewer"
          : "administrator",
      input.groupName,
    ]);
    assert.deepEqual(groupCalls, [
      ["administrator", "platform-admin"],
      ["administrator", "demo-operator"],
      ["reviewer", "platform-admin"],
      ["reviewer", "demo-operator"],
      ["ordinary", "end-user"],
    ]);

    const sequence = harness.calls.fetch.map(({ headers, method, path }) => [
      method,
      path,
      headers["x-demo-role"] ?? "base-admin",
      headers["x-active-domain"] ?? null,
      headers.authorization === "Bearer ordinary-access-token"
        ? "ordinary"
        : headers.authorization === "Bearer reviewer-access-token"
          ? "reviewer"
          : "administrator",
    ]);
    assert.deepEqual(sequence.slice(0, 4), [
      ["GET", "/api/me", "base-admin", null, "administrator"],
      ["POST", "/api/domain-create", "base-admin", null, "administrator"],
      ["GET", "/api/me", "lead", JOURNEY_DOMAIN.id, "reviewer"],
      ["GET", "/api/me", "base-admin", null, "ordinary"],
    ]);
    for (const role of ["lead", "builder", "user", "admin"]) {
      assert.ok(sequence.some((entry) => entry[2] === role), role);
    }
    assert.ok(sequence.some((entry) =>
      entry[1] === "/api/ai-gateway"
      && entry[2] === "admin"
      && entry[4] === "ordinary"
    ));

    const mutationRequestIds = harness.calls.fetch
      .filter(({ headers }) => headers["x-request-id"] !== undefined)
      .map(({ headers }) => headers["x-request-id"]);
    assert.ok(mutationRequestIds.length >= 13);
    assert.equal(new Set(mutationRequestIds).size, mutationRequestIds.length);
    for (const requestId of mutationRequestIds) {
      assert.match(
        requestId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }

    assert.equal(harness.users.size, 0);
    const deleted = harness.calls.cognito
      .filter(([name]) => name === "delete")
      .map(([, input]) => input.username)
      .sort();
    assert.deepEqual(
      deleted,
      Object.values(roleSwitchingUsernames({
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      })).sort(),
    );
    assert.ok(
      harness.calls.resources.some(([name]) => name === "cleanup"),
    );
    const lastVerifierDeleteIndex = harness.calls.timeline
      .findLastIndex(([operation]) => operation === "delete-user");
    const exactCleanupIndex = harness.calls.timeline
      .findIndex(([operation]) => operation === "cleanup-resources");
    assert.ok(
      lastVerifierDeleteIndex >= 0
      && lastVerifierDeleteIndex < exactCleanupIndex,
    );
    const provisionExperience = harness.calls.resources.find(
      ([name]) => name === "provision-experience",
    );
    assert.deepEqual(provisionExperience?.[1], {
      actor: "temporary-admin-subject",
      domainId: EXISTING_DOMAIN.id,
      ownership: createAcceptanceOwnership({
        verifierRunId: RUN_ID,
        verifierRunAttempt: RUN_ATTEMPT,
      }),
    });
    assert.notEqual(provisionExperience?.[1]?.domainId, DOMAIN.id);
    const persistedActor = harness.calls.resources.find(
      ([name]) => name === "persist-actor",
    );
    assert.deepEqual(persistedActor?.[1], {
      actor: "temporary-admin-subject",
      ownership: OWNERSHIP,
    });
    const cleanup = harness.calls.resources.find(
      ([name]) => name === "cleanup",
    );
    assert.deepEqual(cleanup?.[1]?.domain, DOMAIN_CLEANUP_RECORD);
    assert.deepEqual(cleanup?.[1]?.requestIds, [{
      route: "POST /api/domain-create",
      requestId: roleSwitchingRequestIds({
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }).adminDomain,
    }]);
    const cleanupExperience = harness.calls.resources.find(
      ([name]) => name === "cleanup-experience",
    );
    assert.deepEqual(cleanupExperience?.[1], {
      actor: "temporary-admin-subject",
      domainId: EXISTING_DOMAIN.id,
      fixture: {
        domainId: EXISTING_DOMAIN.id,
        projectId: `ha-project-${RUN_ID}-${RUN_ATTEMPT}`,
        agentId: `ha-agent-${RUN_ID}-${RUN_ATTEMPT}`,
        deploymentId: `ha-deployment-${RUN_ID}-${RUN_ATTEMPT}`,
      },
      ownership: createAcceptanceOwnership({
        verifierRunId: RUN_ID,
        verifierRunAttempt: RUN_ATTEMPT,
      }),
    });
    assert.ok(
      harness.calls.resources.some(
        ([name]) => name === "recover-experience",
      ),
    );
    assert.ok(
      harness.calls.resources.some(([name]) => name === "actor"),
    );
    assert.ok(
      harness.calls.resources.some(([name]) => name === "domain"),
    );
    assert.ok(
      harness.calls.resources.some(([name]) => name === "registry"),
    );

    const operatorMutations = harness.calls.cognito.filter(
      ([name, input]) =>
        OPTIONAL_OPERATORS.includes(input?.username)
        && !["get", "list-groups"].includes(name),
    );
    assert.deepEqual(operatorMutations, []);
    for (const username of OPTIONAL_OPERATORS) {
      assert.equal(
        harness.calls.cognito.filter(
          ([name, input]) => name === "get" && input.username === username,
        ).length,
        2,
      );
      assert.equal(
        harness.calls.cognito.filter(
          ([name, input]) =>
            name === "list-groups" && input.username === username,
        ).length,
        2,
      );
    }
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("hosted acceptance completes positive Builder, Lead, and End User API journeys", async () => {
  const harness = createHarness();
  let failure;
  try {
    await runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Reviewer-Or-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    });
  } catch (error) {
    failure = error;
  }

  const specPreviewCall = harness.calls.fetch.find(({ body, method, path }) =>
    method === "POST"
    && path === "/api/delivery/previews"
    && body?.preset === "SPEC"
  );
  assert.deepEqual(specPreviewCall?.body, {
    preset: "SPEC",
    repositoryName: `acceptance-spec-${RUN_ID}-${RUN_ATTEMPT}`,
    journeyId: "journey-spec",
    projectId: EXPERIENCE_PROJECT_ID,
    agentId: PERSONA_AGENT_ID,
  });
  const specAgentCalls = harness.calls.fetch.filter(({ body, method, path }) =>
    body?.id === PERSONA_AGENT_ID
    || path.startsWith(`/api/agents/${PERSONA_AGENT_ID}`)
  );
  assert.deepEqual(
    specAgentCalls.map(({ method, path }) => `${method} ${path}`),
    [
      "POST /api/agents",
      `PUT /api/agents/${PERSONA_AGENT_ID}`,
      `POST /api/agents/${PERSONA_AGENT_ID}/test`,
    ],
  );
  assert.equal(
    specAgentCalls[1]?.body?.buildConfig?.instructions,
    [
      "Triage support cases and explain missing evidence.",
      "Required capabilities:\n"
        + "- Triage support cases\n"
        + "- Explain when evidence is missing",
      "The Agent must remain read-only.",
      "Compliance requirements:\n- Use the approved case system",
    ].join("\n\n"),
  );

  const positiveRoutes = harness.calls.fetch
    .filter(({ method, path }) =>
      ["POST", "PUT"].includes(method)
      && (
        path.startsWith("/api/agents")
        || path.startsWith("/api/journeys")
        || path === "/api/delivery/previews"
        || path === "/api/deployments/production"
        || path === "/api/deployment-decisions"
        || path === "/api/access/domain-memberships"
        || path === "/api/governance/agent-entitlements"
        || path === "/api/experience/invocations"
        || path === "/api/experience/feedback"
      ))
    .map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(positiveRoutes, [
    "POST /api/journeys",
    "POST /api/delivery/previews",
    "POST /api/journeys",
    "POST /api/journeys/journey-spec/messages",
    "POST /api/journeys/journey-spec/messages",
    "POST /api/journeys/journey-spec/contract",
    "POST /api/agents",
    `PUT /api/agents/${PERSONA_AGENT_ID}`,
    "POST /api/delivery/previews",
    `POST /api/agents/${PERSONA_AGENT_ID}/test`,
    "POST /api/delivery/previews",
    "POST /api/deployments/production",
    "POST /api/deployment-decisions",
    "POST /api/access/domain-memberships",
    "POST /api/governance/agent-entitlements",
    "POST /api/experience/invocations",
    "POST /api/experience/feedback",
  ]);
  assert.ok(
    harness.calls.resources.some(([name]) => name === "persist-persona"),
  );
  assert.ok(
    harness.calls.resources.some(([name]) => name === "cleanup-persona"),
  );
  assert.ok(
    harness.calls.resources.some(
      ([name]) => name === "cleanup-agent-building-journeys",
    ),
  );
  assert.equal(harness.personaFixture, null);
  assert.equal(failure, undefined);
});

test("hosted acceptance retries retryable domain provisioning with the same request", async () => {
  const harness = createHarness({ domainCreateRetryOnce: true });

  await runHostedRoleSwitchingAcceptance({
    applicationUrl: APPLICATION_URL,
    browser: harness.browser,
    clientId: CLIENT_ID,
    cognito: harness.cognito,
    fetchImpl: harness.fetchImpl,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    randomPassword: (label) =>
      label === "administrator"
        ? "Temporary-Administrator-1!"
        : "Temporary-Reviewer-Or-Ordinary-2!",
    region: REGION,
    resources: harness.resources,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
    userPoolId: USER_POOL_ID,
  });

  const requests = harness.calls.fetch.filter(({ method, path }) =>
    method === "POST" && path === "/api/domain-create"
  ).slice(0, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ body, headers }) => ({
      body,
      requestId: headers["x-request-id"],
    })),
    [
      {
        body: requests[0].body,
        requestId: OWNERSHIP.requestIds.domain,
      },
      {
        body: requests[0].body,
        requestId: OWNERSHIP.requestIds.domain,
      },
    ],
  );
});

test("hosted acceptance recovers the pending Registry before exhausted-retry cleanup", async () => {
  const harness = createHarness({ domainCreateRetryCount: 3 });

  await assert.rejects(
    runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Reviewer-Or-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => error?.code === "HOSTED_ROLE_SWITCHING_FAILED",
  );

  const requests = harness.calls.fetch.filter(({ method, path }) =>
    method === "POST" && path === "/api/domain-create"
  );
  assert.equal(requests.length, 3);
  assert.equal(
    new Set(requests.map(({ headers }) => headers["x-request-id"])).size,
    1,
  );
  assert.equal(
    new Set(requests.map(({ body }) => JSON.stringify(body))).size,
    1,
  );
  const recoverIndex = harness.calls.resources.findIndex(
    ([name]) => name === "domain",
  );
  const cleanupIndex = harness.calls.resources.findIndex(
    ([name]) => name === "cleanup",
  );
  assert.ok(recoverIndex >= 0 && recoverIndex < cleanupIndex);
  assert.deepEqual(
    harness.calls.resources[cleanupIndex][1].domain,
    DOMAIN_CLEANUP_RECORD,
  );
  assert.equal(harness.createdDomain, null);
});

test("failure remains generic while finally removes users, artifacts, and residue", async () => {
  const secret = "must-not-leak-secret";
  const harness = createHarness({
    browserError: new Error(secret),
  });
  const removed = [];

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      createArtifactDirectory: () => "/tmp/private-role-artifacts",
      ensureArtifactDirectory: () => "/tmp/private-role-artifacts",
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      removeArtifactDirectory(path) {
        removed.push(path);
      },
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(
        error?.message,
        "Hosted role-switching acceptance failed.",
      );
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      assert.doesNotMatch(
        JSON.stringify(error),
        /access-token|id-token|Temporary-(?:Administrator|Ordinary)/i,
      );
      return true;
    },
  );

  assert.equal(harness.users.size, 0);
  assert.deepEqual(removed, ["/tmp/private-role-artifacts"]);
  assert.ok(
    harness.calls.resources.some(([name]) => name === "cleanup"),
  );
  assert.ok(
    harness.calls.resources.some(
      ([name]) => name === "cleanup-experience",
    ),
  );
  assert.ok(
    harness.calls.resources.some(
      ([name]) => name === "recover-experience",
    ),
  );
  assert.ok(
    harness.calls.resources.some(([name]) => name === "actor"),
  );
  assert.ok(
    harness.calls.resources.some(([name]) => name === "registry"),
  );
});

test("cleanup refuses to delete an unmanaged user at a deterministic verifier username", async () => {
  const administrator =
    roleSwitchingUsernames({
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    }).administrator;
  const harness = createHarness({
    preexistingVerifierUsername: administrator,
  });

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(error?.cleanupCode, undefined);
      return true;
    },
  );

  assert.equal(harness.users.has(administrator), true);
  assert.equal(
    harness.calls.cognito.some(
      ([operation, input]) =>
        operation === "delete"
        && input.username === administrator,
    ),
    false,
  );
});

test("a create collision never deletes a pre-existing managed verifier", async () => {
  const administrator =
    roleSwitchingUsernames({
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    }).administrator;
  const harness = createHarness({
    preexistingVerifierManaged: true,
    preexistingVerifierUsername: administrator,
  });

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      return true;
    },
  );

  assert.equal(harness.users.has(administrator), true);
  assert.equal(
    harness.calls.cognito.some(
      ([operation, input]) =>
        operation === "delete"
        && input.username === administrator,
    ),
    false,
  );
});

test("a create that succeeds after the old reconciliation window is cleaned before return", async () => {
  const administrator =
    roleSwitchingUsernames({
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    }).administrator;
  const harness = createHarness({
    createMaterializesAfterTimeoutMs: 180,
  });

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      operationTimeoutMs: 5,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => error?.code === "HOSTED_ROLE_SWITCHING_FAILED",
  );

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(harness.users.has(administrator), false);
  assert.equal(
    harness.calls.cognito.some(
      ([operation, input]) =>
        operation === "delete"
        && input.username === administrator,
    ),
    true,
  );
});

test("an abort rejection followed by delayed materialization is reconciled and deleted", async () => {
  const administrator =
    roleSwitchingUsernames({
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    }).administrator;
  const harness = createHarness({
    createMaterializesAfterAbortMs: 35,
  });

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      operationTimeoutMs: 5,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(error?.cleanupCode, undefined);
      return true;
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(harness.users.has(administrator), false);
  assert.equal(
    harness.calls.cognito.some(
      ([operation, input]) =>
        operation === "delete"
        && input.username === administrator,
    ),
    true,
  );
});

test("a create timeout with no materialized user reports unresolved cleanup", async () => {
  const administrator =
    roleSwitchingUsernames({
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    }).administrator;
  const harness = createHarness({
    createNeverSettles: true,
  });
  const startedAt = Date.now();

  await assert.rejects(
    () => Promise.race([
      runHostedRoleSwitchingAcceptance({
        applicationUrl: APPLICATION_URL,
        browser: harness.browser,
        clientId: CLIENT_ID,
        cognito: harness.cognito,
        fetchImpl: harness.fetchImpl,
        fixtureRegistryId: FIXTURE_REGISTRY_ID,
        operationTimeoutMs: 5,
        randomPassword: (label) =>
          label === "administrator"
            ? "Temporary-Administrator-1!"
            : "Temporary-Ordinary-2!",
        region: REGION,
        resources: harness.resources,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        userPoolId: USER_POOL_ID,
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("create settlement was not bounded")),
          750,
        );
      }),
    ]),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(
        error?.cleanupCode,
        "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED",
      );
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(harness.users.has(administrator), false);
  assert.equal(
    harness.calls.cognito.some(
      ([operation, input]) =>
        operation === "delete"
        && input.username === administrator,
    ),
    false,
  );
});

test("a post-preflight UsernameExists race preserves the concurrent managed user", async () => {
  const administrator =
    roleSwitchingUsernames({
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    }).administrator;
  const harness = createHarness({
    postPreflightCollision: true,
  });

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => error?.code === "HOSTED_ROLE_SWITCHING_FAILED",
  );

  assert.equal(harness.users.has(administrator), true);
  assert.equal(
    harness.users.get(administrator)?.UserAttributes
      .find(({ Name }) => Name === "sub")?.Value,
    "concurrent-managed-subject",
  );
  assert.equal(
    harness.calls.cognito.some(
      ([operation, input]) =>
        operation === "delete"
        && input.username === administrator,
    ),
    false,
  );
});

test("the production Cognito adapter forwards the create abort signal to the AWS SDK", async () => {
  const calls = [];
  const adapter =
    hostedRoleSwitchingAcceptance.createRoleSwitchingCognitoAdapter({
      region: REGION,
      cognitoClient: {
        async send(command, options) {
          calls.push([command, options]);
          return {
            User: {
              Username: "temporary-user",
              Enabled: true,
              UserStatus: "FORCE_CHANGE_PASSWORD",
              Attributes: [{
                Name: "sub",
                Value: "temporary-subject",
              }],
            },
          };
        },
      },
    });
  const controller = new AbortController();

  assert.deepEqual(await adapter.adminCreateUser({
    userPoolId: USER_POOL_ID,
    username: "temporary-user",
    messageAction: "SUPPRESS",
    userAttributes: [{
      name: "custom:managed_by",
      value: "agentic-ai-platform-demo",
    }],
  }, {
    abortSignal: controller.signal,
  }), {
    Username: "temporary-user",
    Enabled: true,
    UserStatus: "FORCE_CHANGE_PASSWORD",
    UserAttributes: [{
      Name: "sub",
      Value: "temporary-subject",
    }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0]?.constructor?.name, "AdminCreateUserCommand");
  assert.equal(calls[0][1]?.abortSignal, controller.signal);
});

test("the production Cognito adapter forwards exact group lookup aborts and classifies only SDK not-found errors", async () => {
  const calls = [];
  const adapter =
    hostedRoleSwitchingAcceptance.createRoleSwitchingCognitoAdapter({
      region: REGION,
      cognitoClient: {
        async send(command, options) {
          calls.push([command, options]);
          return {
            Group: {
              GroupName: OWNERSHIP.ownerGroup,
              UserPoolId: USER_POOL_ID,
            },
          };
        },
      },
    });
  const controller = new AbortController();

  assert.deepEqual(await adapter.getGroup({
    userPoolId: USER_POOL_ID,
    groupName: OWNERSHIP.ownerGroup,
  }, {
    abortSignal: controller.signal,
  }), {
    Group: {
      GroupName: OWNERSHIP.ownerGroup,
      UserPoolId: USER_POOL_ID,
    },
  });
  assert.equal(calls[0][0]?.constructor?.name, "GetGroupCommand");
  assert.equal(calls[0][1]?.abortSignal, controller.signal);
  assert.equal(
    adapter.isGroupNotFound(new ResourceNotFoundException({
      $metadata: {},
      message: "missing",
    })),
    true,
  );
  assert.equal(
    adapter.isGroupNotFound({
      name: "ResourceNotFoundException",
      code: "ResourceNotFoundException",
    }),
    false,
  );
});

test("a mismatched successful fixture response is cleaned through authoritative recovery", async () => {
  const harness = createHarness({
    experienceProvisionResult: {
      domainId: JOURNEY_DOMAIN.id,
      projectId: "incorrect-project",
      agentId: "incorrect-agent",
      deploymentId: "incorrect-deployment",
    },
  });

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) =>
      error?.code === "HOSTED_ROLE_SWITCHING_FAILED",
  );

  const cleanupExperience = harness.calls.resources.find(
    ([name]) => name === "cleanup-experience",
  );
  assert.deepEqual(cleanupExperience?.[1]?.fixture, {
    domainId: JOURNEY_DOMAIN.id,
    projectId: `ha-project-${RUN_ID}-${RUN_ATTEMPT}`,
    agentId: `ha-agent-${RUN_ID}-${RUN_ATTEMPT}`,
    deploymentId: `ha-deployment-${RUN_ID}-${RUN_ATTEMPT}`,
  });
  assert.equal(harness.users.size, 0);
});

test("deadline-owning browser cleanup failure remains visible after hosted cleanup", async () => {
  const browserFailure = new Error("private browser cleanup detail");
  browserFailure.code = "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED";
  browserFailure.stage = "cleanup";
  const harness = createHarness({ browserError: browserFailure });
  harness.browser.managesOwnDeadline = true;

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      createArtifactDirectory: () => "/tmp/private-role-artifacts",
      ensureArtifactDirectory: () => "/tmp/private-role-artifacts",
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      removeArtifactDirectory: () => {},
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(
        error?.cleanupCode,
        "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED",
      );
      assert.equal(error?.stage, "cleanup");
      assert.doesNotMatch(JSON.stringify(error), /private browser cleanup/i);
      return true;
    },
  );
  assert.equal(harness.users.size, 0);
});

test("deadline-owning browser preserves an allowlisted inner stage", async () => {
  const browserFailure = new Error("private browser detail");
  browserFailure.code = "HOSTED_ROLE_SWITCHING_FAILED";
  browserFailure.stage = "builder-navigation";
  const harness = createHarness({ browserError: browserFailure });
  harness.browser.managesOwnDeadline = true;

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      createArtifactDirectory: () => "/tmp/private-role-artifacts",
      ensureArtifactDirectory: () => "/tmp/private-role-artifacts",
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      removeArtifactDirectory: () => {},
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(error?.stage, "builder-navigation");
      assert.doesNotMatch(JSON.stringify(error), /private browser detail/i);
      return true;
    },
  );
  assert.equal(harness.users.size, 0);
});

test("an API failure after identity projection still cleans the exact actor request state", async () => {
  const harness = createHarness({
    apiFailure: ({ headers, path }) =>
      headers["x-demo-role"] === "builder"
      && path === "/api/registry?type=Agent",
  });

  await assert.rejects(
    () => runHostedRoleSwitchingAcceptance({
      applicationUrl: APPLICATION_URL,
      browser: harness.browser,
      clientId: CLIENT_ID,
      cognito: harness.cognito,
      fetchImpl: harness.fetchImpl,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      randomPassword: (label) =>
        label === "administrator"
          ? "Temporary-Administrator-1!"
          : "Temporary-Ordinary-2!",
      region: REGION,
      resources: harness.resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(error?.stage, "api-contract");
      return true;
    },
  );

  const cleanup = harness.calls.resources.find(([name]) => name === "cleanup");
  assert.equal(cleanup?.[1]?.actor, "temporary-admin-subject");
  assert.deepEqual(cleanup?.[1]?.requestIds, [{
    route: "POST /api/domain-create",
    requestId: roleSwitchingRequestIds({
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    }).adminDomain,
  }]);
  assert.equal(harness.users.size, 0);
});

test("acceptance rejects unscoped domains and invalid End User catalogs", async (t) => {
  for (const [name, harness] of [
    ["unscoped domain record", createHarness({ omitScopedDomain: true })],
    ["empty End User catalog", createHarness({ emptyUserCatalog: true })],
    [
      "unexpected entitled catalog item",
      createHarness({ unexpectedEntitledCatalogItem: true }),
    ],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => runHostedRoleSwitchingAcceptance({
          applicationUrl: APPLICATION_URL,
          browser: harness.browser,
          clientId: CLIENT_ID,
          cognito: harness.cognito,
          fetchImpl: harness.fetchImpl,
          fixtureRegistryId: FIXTURE_REGISTRY_ID,
          randomPassword: (label) =>
            label === "administrator"
              ? "Temporary-Administrator-1!"
              : "Temporary-Ordinary-2!",
          region: REGION,
          resources: harness.resources,
          runAttempt: RUN_ATTEMPT,
          runId: RUN_ID,
          userPoolId: USER_POOL_ID,
        }),
        (error) => error?.code === "HOSTED_ROLE_SWITCHING_FAILED",
      );
      assert.equal(harness.calls.browser.length, 0);
      assert.equal(harness.users.size, 0);
    });
  }
});

test("configuration rejects unsafe origins, identifiers, usernames, and bounds before adapters", async () => {
  const harness = createHarness();
  const base = {
    applicationUrl: APPLICATION_URL,
    browser: harness.browser,
    clientId: CLIENT_ID,
    cognito: harness.cognito,
    fetchImpl: harness.fetchImpl,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    randomPassword: (label) =>
      label === "administrator"
        ? "Temporary-Administrator-1!"
        : "Temporary-Ordinary-2!",
    region: REGION,
    resources: harness.resources,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
    userPoolId: USER_POOL_ID,
  };
  for (const override of [
    { applicationUrl: "http://example.test" },
    { applicationUrl: "https://user:pass@127.0.0.1" },
    { clientId: "../client" },
    { fixtureRegistryId: "registry/id" },
    { operatorUsernames: [" leading-space"] },
    { operatorUsernames: ["duplicate", "duplicate"] },
    { operationTimeoutMs: 0 },
    { runAttempt: "0" },
    { runId: "not-numeric" },
    { userPoolId: "eu-west-1_Example123" },
  ]) {
    await assert.rejects(
      () => runHostedRoleSwitchingAcceptance({
        ...base,
        ...override,
      }),
      (error) =>
        error?.code === "HOSTED_ROLE_SWITCHING_CONFIGURATION_INVALID",
    );
  }
  assert.deepEqual(harness.calls.cognito, []);
  assert.deepEqual(harness.calls.fetch, []);
  assert.deepEqual(harness.calls.browser, []);
});

test("production browser adapter statically proves role controls, reload, temporary screenshots, and sanitized launch", () => {
  const adapter = createPlaywrightRoleSwitchingBrowserAdapter({
    chromium: { launch() {} },
  });
  assert.equal(adapter.managesOwnDeadline, true);
  const source = readFileSync(
    new URL("./hosted-role-switching-acceptance.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /createBrowserEnvironment/);
  assert.match(source, /sessionStorage\.setItem\(\s*"console\.cognito\.tokens"/);
  assert.match(source, /#tbrole/);
  assert.match(source, /\.tb-role/);
  assert.match(source, /Domain Builder/);
  assert.match(source, /#tbdomain/);
  const roleWaits = [...source.matchAll(
    /await waitForRole\(\{\s*domain: (null|"platform"|domain\.id),[\s\S]*?role: "(admin|lead|builder|user)",\s*timeoutMs,\s*\}\);/g,
  )].map((match) => ({
    domain: match[1],
    role: match[2],
  }));
  assert.deepEqual(
    roleWaits
      .filter(({ role }) => role === "admin")
      .map(({ domain }) => domain),
    ["null", "null", "null"],
  );
  assert.match(source, /data-shellnav/);
  assert.match(source, /selectOption\("lead"\)/);
  assert.match(source, /selectOption\("builder"\)/);
  assert.match(source, /selectOption\("user"\)/);
  assert.match(
    source,
    /expectedNavigation:\s*\[\s*"overview",\s*"approvedagents",\s*"sessions",\s*"accessrequests",\s*\]/,
  );
  assert.match(source, /data-shellnav="overview"/);
  assert.match(source, /data-shellnav="approvedagents"/);
  assert.match(source, /data-shellnav="gateway"/);
  assert.match(source, /data-shellnav="domainaccess"/);
  assert.match(source, /data-shellnav="build"/);
  assert.match(source, /data-hosted-journey="blueprint"/);
  assert.match(source, /\["scratch", "#hminimalpreview"\]/);
  assert.match(source, /\["plato", "#hspecstart"\]/);
  assert.match(source, /data-hosted-journey="\$\{journeyId\}"/);
  assert.match(source, /#hbcreate/);
  assert.match(source, /#hminimalpreview/);
  assert.match(source, /#hspecstart/);
  assert.match(source, /#tbdemoassist/);
  assert.match(source, /data-demo-assist-controls/);
  assert.match(source, /ordinaryTokens/);
  assert.match(source, /#hostedgateway \.gateway-model/);
  assert.match(source, /#hostedaccessadmin \[data-access-agent\]/);
  assert.match(source, /#hostedoverview \.item/);
  assert.match(source, /#approvedagents \.approvedagent/);
  assert.match(source, /#hostedaccessrequests/);
  assert.match(source, /#regbox \.regrow/);
  assert.match(source, /#regdrawerwrap \.card/);
  assert.match(source, /#regwizopen,\s*\.regapprove,\s*\.regreject,\s*#regpropose,\s*#regsubmit/);
  assert.match(source, /approved-agent-mobile-layout/);
  assert.match(source, /context\.newPage\(\)[\s\S]*per-tab-isolation/);
  assert.match(source, /page\.route\([\s\S]*\/api\/me[\s\S]*rollback-failure/);
  assert.match(source, /page\.reload/);
  assert.match(source, /user-reload/);
  assert.match(source, /page\.screenshot/);
  assert.match(source, /fullPage:\s*false/);
  assert.match(source, /artifactDirectory/);
  assert.doesNotMatch(
    source,
    /screenshots?\/|visual-check|docs\/diagrams|Desktop\/Screenshot/i,
  );
  assert.doesNotMatch(source, /console\.(?:log|dir|table)\([^)]*(?:token|password|username)/i);
  assert.doesNotMatch(
    source,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );
  assert.doesNotMatch(
    source,
    /locator\("#tbdomain"\)\.selectOption/,
    "the role switch already selects its domain; repeating it races the Registry navigation",
  );
  assert.match(
    source,
    /getByText\("Build Workspace",\s*\{\s*exact:\s*true\s*\}\)/,
    "the Builder journey title must not collide with repeated section headings",
  );
  assert.match(
    source,
    /const approvedAgentSummary = page\.locator\("#hostedoverview \.item"\)\.first\(\);[\s\S]*approvedAgentSummary\.waitFor/,
    "the End User overview must select one deterministic summary card",
  );
  assert.doesNotMatch(
    source,
    /failure\.cause\s*=/,
    "raw browser failures must not be retained by the sanitized worker boundary",
  );
  const workerSource = readFileSync(
    new URL("./hosted-role-switching-browser-worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    workerSource,
    /error\?\.code\s*===\s*"HOSTED_ROLE_SWITCHING_CLEANUP_FAILED"/,
  );
  assert.match(workerSource, /stage:\s*error\?\.stage/);
});

test("browser stage boundaries sanitize raw failures and preserve an inner accepted stage", async () => {
  await assert.rejects(
    runBrowserStage("administrator-gateway", async () => {
      throw new Error("private selector detail");
    }),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(error?.stage, "administrator-gateway");
      assert.doesNotMatch(
        JSON.stringify(error),
        /private selector detail/,
      );
      return true;
    },
  );

  await assert.rejects(
    runBrowserStage("administrator-gateway", () =>
      runBrowserStage("lead-navigation", async () => {
        throw new Error("private lead detail");
      })),
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(error?.stage, "lead-navigation");
      assert.doesNotMatch(
        JSON.stringify(error),
        /private lead detail/,
      );
      return true;
    },
  );
});

test("production role-switching browser runs in a killable isolated process", () => {
  const adapter = createPlaywrightRoleSwitchingBrowserProcessAdapter({
    spawnProcess() {
      throw new Error("not started");
    },
  });
  assert.equal(adapter.managesOwnDeadline, true);
  assert.equal(typeof adapter.verifyRoleJourney, "function");

  const source = readFileSync(
    new URL("./hosted-role-switching-acceptance.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /hosted-role-switching-browser-worker\.mjs/);
  assert.match(source, /detached:\s*true/);
  assert.match(source, /killProcess\(-child\.pid,\s*"SIGKILL"\)/);
  assert.match(source, /processTerminationTimeoutMs/);
  assert.match(
    source,
    /browser\s*=\s*createPlaywrightRoleSwitchingBrowserProcessAdapter/,
  );
  assert.doesNotMatch(
    sourceBetween(
      source,
      "export async function runCli(",
      "\nconst isExecutable",
    ),
    /await import\("playwright"\)/,
  );
});

test("role-switching browser timeout kills the detached process group", async () => {
  const timers = [];
  const killed = [];
  let privateInput = "";
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdin.on("data", (chunk) => {
    privateInput += chunk.toString();
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.unref = () => {};

  const adapter = createPlaywrightRoleSwitchingBrowserProcessAdapter({
    deadlineTimers: {
      clearTimeout(timer) {
        timer.cleared = true;
      },
      setTimeout(callback, milliseconds) {
        const timer = { callback, cleared: false, milliseconds };
        timers.push(timer);
        return timer;
      },
    },
    killProcess(pid, signal) {
      killed.push({ pid, signal });
    },
    journeyTimeoutMs: 50,
    operationTimeoutMs: 13,
    processTerminationTimeoutMs: 25,
    spawnProcess() {
      return child;
    },
  });

  const verification = adapter.verifyRoleJourney(roleJourneyInput());
  assert.equal(timers[0].milliseconds, 50);
  assert.equal(JSON.parse(privateInput).operationTimeoutMs, 13);
  timers[0].callback();
  assert.deepEqual(killed, [{ pid: -4242, signal: "SIGKILL" }]);
  child.emit("close", null);
  await assert.rejects(
    verification,
    (error) => error?.code === "HOSTED_ROLE_SWITCHING_FAILED",
  );
});

test("role-switching browser cleanup-error exit kills the detached process group", async () => {
  const killed = [];
  const child = new EventEmitter();
  child.pid = 4343;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};

  const adapter = createPlaywrightRoleSwitchingBrowserProcessAdapter({
    killProcess(pid, signal) {
      killed.push({ pid, signal });
    },
    operationTimeoutMs: 5_000,
    processTerminationTimeoutMs: 25,
    spawnProcess() {
      return child;
    },
  });

  const verification = adapter.verifyRoleJourney(roleJourneyInput());
  child.stdout.emit("data", Buffer.from(JSON.stringify({
    cleanupCode: "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED",
    ok: false,
    stage: "cleanup",
  })));
  child.emit("close", 1);

  await assert.rejects(
    verification,
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(
        error?.cleanupCode,
        "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED",
      );
      assert.equal(error?.stage, "cleanup");
      return true;
    },
  );
  assert.deepEqual(killed, [{ pid: -4343, signal: "SIGKILL" }]);
});

test("role-switching browser rejects arbitrary worker stages", async () => {
  const child = new EventEmitter();
  child.pid = 4444;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};

  const adapter = createPlaywrightRoleSwitchingBrowserProcessAdapter({
    killProcess() {},
    operationTimeoutMs: 5_000,
    processTerminationTimeoutMs: 25,
    spawnProcess() {
      return child;
    },
  });

  const verification = adapter.verifyRoleJourney(roleJourneyInput());
  child.stdout.emit("data", Buffer.from(JSON.stringify({
    ok: false,
    stage: "private-selector-and-page-detail",
  })));
  child.emit("close", 1);

  await assert.rejects(
    verification,
    (error) => {
      assert.equal(error?.code, "HOSTED_ROLE_SWITCHING_FAILED");
      assert.equal(error?.stage, "browser-process");
      assert.doesNotMatch(
        JSON.stringify(error),
        /private-selector-and-page-detail/,
      );
      return true;
    },
  );
});

test("README documents secure hosted role-switching acceptance", () => {
  const readme = readFileSync(
    new URL(
      "../infra/serverless-platform/README.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    readme,
    /^### Hosted role-switching acceptance$/m,
  );
  for (const name of [
    "HOSTED_ROLE_SWITCHING_ACCEPTANCE",
    "HOSTED_ROLE_SWITCHING_RUN_ID",
    "HOSTED_ROLE_SWITCHING_RUN_ATTEMPT",
    "HOSTED_ROLE_SWITCHING_OPERATORS_FILE",
  ]) {
    assert.match(readme, new RegExp(name));
  }
  assert.match(
    readme,
    /requires[\s\S]*private exact operator set[\s\S]*read-only\s+postcondition/i,
  );
  assert.match(readme, /trap[\s\S]*PRIVATE_DEMO_OPERATOR_FILE/);
  assert.match(readme, /rm -f -- "\$PRIVATE_DEMO_OPERATOR_FILE"/);
  assert.match(
    readme,
    /temporary[\s\S]*administrator[\s\S]*ordinary user[\s\S]*cleanup/i,
  );
  assert.match(
    readme,
    /screenshots[\s\S]*private[\s\S]*temporary directory/i,
  );
  assert.match(
    readme,
    /node e2e\/hosted-role-switching-acceptance\.mjs/,
  );
  assert.match(
    readme,
    /node e2e\/hosted-role-switching-acceptance\.mjs --cleanup-only/,
  );
  assert.match(
    readme,
    /same[\s\S]*HOSTED_ROLE_SWITCHING_RUN_ID[\s\S]*HOSTED_ROLE_SWITCHING_RUN_ATTEMPT/i,
  );
  assert.match(
    readme,
    /managed verifier[\s\S]*actor-bound[\s\S]*ENTITLEMENT/i,
  );
  assert.doesNotMatch(
    readme,
    /role-switching[\s\S]{0,1200}writes a durable actor mapping/i,
  );
});

test("run-all keeps hosted AWS acceptance strictly opt-in", () => {
  const source = readFileSync(
    new URL("./run-all.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /HOSTED_ROLE_SWITCHING_ACCEPTANCE\s*===\s*['"]1['"]/,
  );
  assert.match(
    source,
    /TESTS\.push\(['"]hosted-role-switching-acceptance\.mjs['"]\)/,
  );
  const testArray = source.match(/const TESTS = \[([\s\S]*?)\n\]/)?.[1] ?? "";
  assert.doesNotMatch(
    testArray,
    /hosted-role-switching-acceptance\.mjs/,
  );
});

test("cleanup-only recovers an interrupted role-switching run and is idempotent", async () => {
  const cleanupRun =
    hostedRoleSwitchingAcceptance.cleanupHostedRoleSwitchingRun;
  assert.equal(typeof cleanupRun, "function");
  if (typeof cleanupRun !== "function") return;

  const ownership = createAcceptanceOwnership({
    verifierRunId: RUN_ID,
    verifierRunAttempt: RUN_ATTEMPT,
  });
  const usernames = roleSwitchingUsernames({
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  const actor = "temporary-admin-subject";
  const experienceFixture = {
    domainId: DOMAIN.id,
    projectId: `hosted-project-${RUN_ID}-${RUN_ATTEMPT}`,
    agentId: `hosted-agent-${RUN_ID}-${RUN_ATTEMPT}`,
    deploymentId: `hosted-production-${RUN_ID}-${RUN_ATTEMPT}`,
  };
  const calls = [];
  const users = new Map([
    [usernames.administrator, {
      Username: usernames.administrator,
      UserAttributes: [
        { Name: "sub", Value: actor },
        {
          Name: "name",
          Value:
            `Hosted role-switching administrator ${RUN_ID}-${RUN_ATTEMPT}`,
        },
        {
          Name: "custom:managed_by",
          Value: "agentic-ai-platform-demo",
        },
      ],
    }],
    [usernames.ordinary, {
      Username: usernames.ordinary,
      UserAttributes: [
        { Name: "sub", Value: "ordinary-subject" },
        {
          Name: "name",
          Value:
            `Hosted role-switching ordinary user ${RUN_ID}-${RUN_ATTEMPT}`,
        },
        {
          Name: "custom:managed_by",
          Value: "agentic-ai-platform-demo",
        },
      ],
    }],
  ]);
  let mappedActor = actor;
  let fixture = structuredClone(experienceFixture);
  const cognito = {
    async adminDeleteUser(input) {
      calls.push(["delete-user", structuredClone(input)]);
      if (!users.delete(input.username)) {
        const error = new Error("absent");
        error.code = "UserNotFoundException";
        throw error;
      }
    },
    async adminGetUser(input) {
      calls.push(["get-user", structuredClone(input)]);
      const user = users.get(input.username);
      if (user) return structuredClone(user);
      const error = new Error("absent");
      error.code = "UserNotFoundException";
      throw error;
    },
    async getGroup(input) {
      calls.push(["get-group", structuredClone(input)]);
      throw new ResourceNotFoundException({
        $metadata: {},
        message: "absent",
      });
    },
    isGroupNotFound(error) {
      return error instanceof ResourceNotFoundException;
    },
    isUserNotFound(error) {
      return error?.code === "UserNotFoundException";
    },
  };
  const resources = {
    async cleanupAgentBuildingJourneyFixtures(input) {
      calls.push(["cleanup-agent-building-journeys", structuredClone(input)]);
      assert.deepEqual(input, {
        actor,
        domainId: DOMAIN.id,
        ownership,
      });
      return { ok: true };
    },
    async cleanupPersonaJourneyFixture(input) {
      calls.push(["cleanup-persona", structuredClone(input)]);
      return { ok: true };
    },
    async recoverActorMapping(input) {
      calls.push(["recover-actor", structuredClone(input)]);
      return mappedActor;
    },
    async recoverExperienceFixture(input) {
      calls.push(["recover-experience", structuredClone(input)]);
      return fixture === null ? null : structuredClone(fixture);
    },
    async cleanupExperienceFixture(input) {
      calls.push(["cleanup-experience", structuredClone(input)]);
      assert.deepEqual(input, {
        actor,
        domainId: DOMAIN.id,
        fixture: experienceFixture,
        ownership,
      });
      fixture = null;
      return { ok: true };
    },
    async recoverDomain(input) {
      calls.push(["recover-domain", structuredClone(input)]);
      return null;
    },
    async recoverRegistryFixture(input) {
      calls.push(["recover-registry", structuredClone(input)]);
      return null;
    },
    async cleanupExactResources(input) {
      calls.push(["cleanup-resources", structuredClone(input)]);
      assert.deepEqual(input, {
        actor,
        domain: null,
        ownership,
        registryRecord: null,
        requestIds: [{
          route: "POST /api/domain-create",
          requestId: roleSwitchingRequestIds({
            runId: RUN_ID,
            runAttempt: RUN_ATTEMPT,
          }).adminDomain,
        }],
      });
      mappedActor = null;
      return { ok: true };
    },
  };

  assert.deepEqual(await cleanupRun({
    cognito,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    resources,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
    userPoolId: USER_POOL_ID,
  }), { ok: true });
  assert.equal(users.size, 0);
  assert.equal(fixture, null);
  assert.equal(mappedActor, null);
  assert.deepEqual(await cleanupRun({
    cognito,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    resources,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
    userPoolId: USER_POOL_ID,
  }), { ok: true });
  assert.equal(
    calls.filter(([operation]) => operation === "cleanup-experience").length,
    1,
  );
  assert.equal(
    calls.filter(([operation]) => operation === "delete-user").length,
    2,
  );
  assert.ok(
    calls.findLastIndex(([operation]) => operation === "delete-user")
      < calls.findIndex(([operation]) => operation === "cleanup-resources"),
  );
});

test("cleanup-only fails when the exact owner group remains", async () => {
  const cleanupRun =
    hostedRoleSwitchingAcceptance.cleanupHostedRoleSwitchingRun;
  const resources = {
    async cleanupAgentBuildingJourneyFixtures() {
      return { ok: true };
    },
    async cleanupPersonaJourneyFixture() {
      return { ok: true };
    },
    async cleanupExperienceFixture() {
      return { ok: true };
    },
    async cleanupExactResources() {
      return { ok: true };
    },
    async recoverActorMapping() {
      return null;
    },
    async recoverDomain() {
      return null;
    },
    async recoverExperienceFixture() {
      return null;
    },
    async recoverRegistryFixture() {
      return null;
    },
  };
  const cognito = {
    async adminDeleteUser() {},
    async adminGetUser() {
      const error = new Error("absent");
      error.code = "UserNotFoundException";
      throw error;
    },
    async getGroup() {
      return {
        Group: {
          GroupName: OWNERSHIP.ownerGroup,
          UserPoolId: USER_POOL_ID,
        },
      };
    },
    isGroupNotFound(error) {
      return error instanceof ResourceNotFoundException;
    },
    isUserNotFound(error) {
      return error?.code === "UserNotFoundException";
    },
  };

  await assert.rejects(
    cleanupRun({
      cognito,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) =>
      error?.code === "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED",
  );
});

test("cleanup-only attempts every verifier after one ownership failure", async () => {
  const cleanupRun =
    hostedRoleSwitchingAcceptance.cleanupHostedRoleSwitchingRun;
  const usernames = roleSwitchingUsernames({
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
  const users = new Map([
    [usernames.administrator, {
      Username: usernames.administrator,
      UserAttributes: [{
        Name: "sub",
        Value: "unmanaged-administrator-subject",
      }],
    }],
    [usernames.ordinary, {
      Username: usernames.ordinary,
      UserAttributes: [
        {
          Name: "sub",
          Value: "ordinary-subject",
        },
        {
          Name: "name",
          Value: `Hosted role-switching ordinary user ${RUN_ID}-${RUN_ATTEMPT}`,
        },
        {
          Name: "custom:managed_by",
          Value: "agentic-ai-platform-demo",
        },
      ],
    }],
  ]);
  const deleted = [];
  const cognito = {
    async adminDeleteUser({ username }) {
      deleted.push(username);
      users.delete(username);
    },
    async adminGetUser({ username }) {
      const user = users.get(username);
      if (user) return structuredClone(user);
      const error = new Error("absent");
      error.code = "UserNotFoundException";
      throw error;
    },
    async getGroup() {
      throw new ResourceNotFoundException({
        $metadata: {},
        message: "absent",
      });
    },
    isGroupNotFound(error) {
      return error instanceof ResourceNotFoundException;
    },
    isUserNotFound(error) {
      return error?.code === "UserNotFoundException";
    },
  };
  const resources = {
    async cleanupAgentBuildingJourneyFixtures() {
      return { ok: true };
    },
    async cleanupPersonaJourneyFixture() {
      return { ok: true };
    },
    async cleanupExperienceFixture() {
      return { ok: true };
    },
    async cleanupExactResources() {
      return { ok: true };
    },
    async recoverActorMapping() {
      return null;
    },
    async recoverDomain() {
      return null;
    },
    async recoverExperienceFixture() {
      return null;
    },
    async recoverRegistryFixture() {
      return null;
    },
  };

  await assert.rejects(
    () => cleanupRun({
      cognito,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      resources,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }),
    (error) => {
      assert.equal(
        error?.code,
        "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED",
      );
      return true;
    },
  );

  assert.equal(users.has(usernames.administrator), true);
  assert.equal(users.has(usernames.ordinary), false);
  assert.deepEqual(deleted, [usernames.ordinary]);
});

test("cleanup-only CLI never creates a browser or starts acceptance", async () => {
  const calls = [];
  const env = {
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_REGION: REGION,
    HOSTED_ROLE_SWITCHING_OPERATORS_FILE: "/missing/operators.json",
    HOSTED_ROLE_SWITCHING_RUN_ATTEMPT: RUN_ATTEMPT,
    HOSTED_ROLE_SWITCHING_RUN_ID: RUN_ID,
  };
  const result = await runCli({
    argv: ["--cleanup-only"],
    dependencies: {
      createBrowserAdapter() {
        assert.fail("cleanup-only must not create a browser");
      },
      createCognitoAdapter(input) {
        calls.push(["cognito-adapter", input]);
        return { adapter: "cognito" };
      },
      createLambdaClient(input) {
        calls.push(["lambda-client", input]);
        return { client: "lambda" };
      },
      createResourceAdapter(input) {
        calls.push(["resource-adapter", input]);
        return { adapter: "resources" };
      },
      readStackOutputs() {
        calls.push(["outputs"]);
        return {
          applicationUrl: APPLICATION_URL,
          brokerFunctionArn: BROKER_FUNCTION_ARN,
          clientId: CLIENT_ID,
          fixtureRegistryId: FIXTURE_REGISTRY_ID,
          starterBuilderModelId: STARTER_BUILDER_MODEL_ID,
          userPoolId: USER_POOL_ID,
        };
      },
      readPrivateOperatorUsernames() {
        assert.fail("cleanup-only must not read the operator file");
      },
      async cleanupRun(input) {
        calls.push(["cleanup", input]);
      },
      async runAcceptance() {
        assert.fail("cleanup-only must not run acceptance");
      },
    },
    env,
  });

  assert.equal(result, "cleanup");
  assert.deepEqual(calls, [
    ["outputs"],
    ["cognito-adapter", { region: REGION }],
    ["lambda-client", { region: REGION }],
    ["resource-adapter", {
      accountId: ACCOUNT_ID,
      brokerFunctionArn: BROKER_FUNCTION_ARN,
      lambdaClient: { client: "lambda" },
      region: REGION,
    }],
    ["cleanup", {
      cognito: { adapter: "cognito" },
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      resources: { adapter: "resources" },
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }],
  ]);
  for (const argv of [
    ["--cleanup-only", "extra"],
    ["--unknown"],
    ["cleanup-only"],
  ]) {
    await assert.rejects(
      runCli({ argv, dependencies: {}, env }),
      (error) =>
        error?.code === "HOSTED_ROLE_SWITCHING_CONFIGURATION_INVALID",
    );
  }
});

test("acceptance CLI requires a private exact operator file", async () => {
  await assert.rejects(
    runCli({
      dependencies: {
        readStackOutputs() {
          return {
            applicationUrl: APPLICATION_URL,
            brokerFunctionArn: BROKER_FUNCTION_ARN,
            clientId: CLIENT_ID,
            fixtureRegistryId: FIXTURE_REGISTRY_ID,
            starterBuilderModelId: STARTER_BUILDER_MODEL_ID,
            userPoolId: USER_POOL_ID,
          };
        },
      },
      env: {
        AWS_ACCOUNT_ID: ACCOUNT_ID,
        AWS_REGION: REGION,
        HOSTED_ROLE_SWITCHING_RUN_ATTEMPT: RUN_ATTEMPT,
        HOSTED_ROLE_SWITCHING_RUN_ID: RUN_ID,
      },
    }),
    (error) =>
      error?.code === "HOSTED_ROLE_SWITCHING_CONFIGURATION_INVALID",
  );
});

test("production broker adapter accepts actor-only exact experience recovery", async () => {
  const ownership = createAcceptanceOwnership({
    verifierRunId: RUN_ID,
    verifierRunAttempt: RUN_ATTEMPT,
  });
  const fixture = {
    domainId: DOMAIN.id,
    projectId: `hosted-project-${RUN_ID}-${RUN_ATTEMPT}`,
    agentId: `hosted-agent-${RUN_ID}-${RUN_ATTEMPT}`,
    deploymentId: `hosted-production-${RUN_ID}-${RUN_ATTEMPT}`,
  };
  const adapter = createAwsBrokerResourceAdapter({
    accountId: ACCOUNT_ID,
    brokerFunctionArn: BROKER_FUNCTION_ARN,
    lambdaClient: {
      async send() {
        return {
          Payload: Buffer.from(JSON.stringify({
            ok: true,
            result: fixture,
          })),
          StatusCode: 200,
        };
      },
    },
    region: REGION,
  });

  assert.deepEqual(
    await adapter.recoverExperienceFixture({
      actor: "temporary-admin-subject",
      ownership,
    }),
    fixture,
  );
});

test("CLI reads the private exact operator set and keeps every operator read-only", async () => {
  const calls = [];
  const env = {
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_REGION: REGION,
    HOSTED_ROLE_SWITCHING_OPERATORS_FILE: "/private/operators.json",
    HOSTED_ROLE_SWITCHING_RUN_ATTEMPT: RUN_ATTEMPT,
    HOSTED_ROLE_SWITCHING_RUN_ID: RUN_ID,
  };
  const result = await runCli({
    dependencies: {
      createBrowserAdapter(input) {
        calls.push(["browser-adapter", input]);
        return { verifyRoleJourney() {} };
      },
      createCognitoAdapter(input) {
        calls.push(["cognito-adapter", input]);
        return {};
      },
      createLambdaClient(input) {
        calls.push(["lambda-client", input]);
        return {};
      },
      createResourceAdapter(input) {
        calls.push(["resource-adapter", input]);
        return {};
      },
      readStackOutputs() {
        calls.push(["outputs"]);
        return {
          applicationUrl: APPLICATION_URL,
          brokerFunctionArn: BROKER_FUNCTION_ARN,
          clientId: CLIENT_ID,
          fixtureRegistryId: FIXTURE_REGISTRY_ID,
          starterBuilderModelId: STARTER_BUILDER_MODEL_ID,
          userPoolId: USER_POOL_ID,
        };
      },
      readPrivateOperatorUsernames(path) {
        calls.push(["operator-file", path]);
        return [...OPTIONAL_OPERATORS];
      },
      async runAcceptance(input) {
        calls.push(["acceptance", {
          ...input,
          browser: "[adapter]",
          cognito: "[adapter]",
          resources: "[adapter]",
        }]);
      },
    },
    env,
  });

  assert.equal(result, "acceptance");
  assert.deepEqual(calls, [
    ["outputs"],
    ["cognito-adapter", { region: REGION }],
    ["lambda-client", { region: REGION }],
    ["resource-adapter", {
      accountId: ACCOUNT_ID,
      brokerFunctionArn: BROKER_FUNCTION_ARN,
      lambdaClient: {},
      region: REGION,
    }],
    ["operator-file", "/private/operators.json"],
    ["browser-adapter", { environment: env }],
    ["acceptance", {
      applicationUrl: APPLICATION_URL,
      browser: "[adapter]",
      clientId: CLIENT_ID,
      cognito: "[adapter]",
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      operatorUsernames: OPTIONAL_OPERATORS,
      preferredBuilderModelId: STARTER_BUILDER_MODEL_ID,
      region: REGION,
      resources: "[adapter]",
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      userPoolId: USER_POOL_ID,
    }],
  ]);
});
