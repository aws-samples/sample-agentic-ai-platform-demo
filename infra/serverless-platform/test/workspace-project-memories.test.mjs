import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceHandler,
} from "../lambda/workspace/index.mjs";
import {
  createProductionIdentityProjector,
  createWorkspaceInventoryAuthorizer,
} from "../lambda/workspace/runtime.mjs";

const adminClaims = Object.freeze({
  sub: "admin-sub",
  token_use: "access",
  "cognito:username": "melanie",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

const platformLeadClaims = Object.freeze({
  sub: "plead-sub",
  token_use: "access",
  "cognito:username": "platform-lead",
  "cognito:groups": ["platform-lead"],
});

const customerSupportLeadClaims = Object.freeze({
  sub: "cslead-sub",
  token_use: "access",
  "cognito:username": "cs-lead",
  "cognito:groups": ["customer-support-lead"],
});

function event({
  path = "/api/project-memories",
  method = "GET",
  requestClaims = adminClaims,
  headers,
  queryStringParameters,
  rawQueryString,
  body,
  requestId = "mem-request",
} = {}) {
  return {
    version: "2.0",
    body,
    headers,
    queryStringParameters,
    rawQueryString,
    requestContext: {
      http: { method, path },
      requestId,
      authorizer: {
        jwt: { claims: requestClaims },
      },
    },
  };
}

function identityProjector() {
  return {
    projectAuthenticated(requestClaims) {
      const groups = requestClaims["cognito:groups"] ?? [];
      const role = groups.includes("end-user")
        ? "user"
        : "admin";
      return {
        actor: requestClaims.sub,
        role,
      };
    },
    projectEffective(requestClaims, headers, { availableDomains }) {
      const groups = requestClaims["cognito:groups"] ?? [];
      const role = headers?.["x-demo-role"] || (
        groups.includes("end-user") ? "user" : "admin"
      );
      const domain = headers?.["x-active-domain"] || null;
      if (
        (role === "lead" || role === "builder")
        && domain
        && !availableDomains.some(({ id }) => id === domain)
      ) {
        const error = new Error("domain not allowed");
        error.code = "DEMO_DOMAIN_NOT_ALLOWED";
        error.statusCode = 403;
        throw error;
      }
      return {
        actor: requestClaims.sub,
        role,
        domain,
        domains: domain ? [domain] : [],
      };
    },
  };
}

function project(overrides = {}) {
  return {
    domainId: "platform",
    id: "it-helpdesk",
    name: "IT Helpdesk",
    description: "Project workspace.",
    ownerSubject: "admin-sub",
    memberSubjects: ["admin-sub"],
    status: "ACTIVE",
    createdBySubject: "admin-sub",
    createdAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

const defaultProjects = Object.freeze([
  project(),
  project({ id: "data-analyst", name: "Data Analyst" }),
  project({
    domainId: "customer_support",
    id: "concierge",
    name: "Concierge",
  }),
  project({
    domainId: "customer_support",
    id: "supportdesk",
    name: "Support Desk",
  }),
]);

function agent(overrides = {}) {
  return {
    domainId: "platform",
    projectId: "agent-lab",
    id: "research-agent",
    name: "Research Agent",
    description: "Researches governed sources.",
    ownerSubject: "admin-sub",
    modelId: "model-1",
    toolIds: [],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: [],
    memoryIds: ["research-memory"],
    knowledgeBaseIds: ["research-kb"],
    buildConfig: null,
    status: "DRAFT",
    createdBySubject: "admin-sub",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    lastTestStatus: null,
    lastTestedAt: null,
    lastTestedBySubject: null,
    lastTestModelId: null,
    lastTestInputTokens: null,
    lastTestOutputTokens: null,
    lastTestRequestId: null,
    lastTestEvidenceHash: null,
    lastTestOutput: null,
    ...overrides,
  };
}

function handlerWith({
  authorizer = async () => ({ ok: true }),
  deadlineTimers,
  domainDirectory,
  identityVerifier = async () => true,
  projector = identityProjector(),
  timeoutMs,
  workspaceState,
  // Pass a stub for the live AWS calls so unit tests don't hit real AWS
  projectMemoriesProvider,
} = {}) {
  const state = {
    async listProjects(input) {
      return {
        items: defaultProjects.filter(
          (projectRecord) => projectRecord.domainId === input.domainId,
        ),
        cursor: null,
      };
    },
    async listAgents(input) {
      return { items: [], cursor: null };
    },
    async listDeployments(input) {
      return { items: [], cursor: null };
    },
    async listApprovals(input) {
      return { items: [], cursor: null };
    },
    beginTransaction() {
      return {
        timestamp: "2026-09-18T00:00:00.000Z",
        epochSeconds: Math.floor(Date.parse("2026-09-18T00:00:00.000Z") / 1000),
      };
    },
    async getMutationResult() { return null; },
    async getProject() { return null; },
    async putProject(input) { return input.record; },
    ...workspaceState,
  };
  const directory = domainDirectory || {
    async listActiveDomains() {
      return [
        { id: "platform" },
        { id: "customer_support" },
        { id: "operations" },
      ];
    },
  };
  return createWorkspaceHandler({
    authorizer,
    deadlineTimers,
    domainDirectory: directory,
    identityProjector: projector,
    identityVerifier,
    timeoutMs,
    workspaceState: state,
    projectMemoriesProvider: projectMemoriesProvider
      ?? (async ({ agents, domainId, projectId }) => {
        const scoped = agents.filter(
          (item) =>
            item.domainId === domainId
            && item.projectId === projectId,
        );
        return {
          memories: [...new Set(
            scoped.flatMap((item) => item.memoryIds),
          )].map((memoryId) => ({
            name: memoryId,
            memoryId,
            strategies: [],
            status: null,
          })),
          knowledgeBases: [...new Set(
            scoped.flatMap((item) => item.knowledgeBaseIds),
          )].map((knowledgeBaseId) => ({
            name: knowledgeBaseId,
            knowledgeBaseId,
            status: null,
          })),
        };
      }),
    region: "us-west-2",
  });
}

function body(response) {
  return JSON.parse(response.body);
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler route tests
// ──────────────────────────────────────────────────────────────────────────────

test("GET /api/project-memories with missing project param returns 400", async () => {
  const handler = handlerWith();
  const response = await handler(event({
    queryStringParameters: {},
  }));
  assert.equal(response.statusCode, 400, JSON.stringify(body(response)));
  assert.equal(body(response).code, "INVALID_QUERY");
});

test("GET /api/project-memories with unknown project returns 404", async () => {
  const handler = handlerWith();
  const response = await handler(event({
    queryStringParameters: { project: "does-not-exist" },
  }));
  assert.equal(response.statusCode, 404, JSON.stringify(body(response)));
  assert.equal(body(response).code, "NOT_FOUND");
});

test("GET /api/project-memories admin can read platform project", async () => {
  const handler = handlerWith();
  const response = await handler(event({
    requestClaims: adminClaims,
    queryStringParameters: { project: "it-helpdesk" },
  }));
  assert.equal(response.statusCode, 200, JSON.stringify(body(response)));
});

test("GET /api/project-memories domain lead can read own domain project", async () => {
  const handler = handlerWith({
    identityVerifier: async () => true,
  });
  const response = await handler(event({
    requestClaims: adminClaims,
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
    queryStringParameters: { project: "concierge" },
  }));
  assert.equal(response.statusCode, 200, JSON.stringify(body(response)));
});

test("GET /api/project-memories domain lead is forbidden from other domain project", async () => {
  const handler = handlerWith({
    identityVerifier: async () => true,
  });
  // Customer support lead trying to read a platform project
  const response = await handler(event({
    requestClaims: adminClaims,
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
    queryStringParameters: { project: "it-helpdesk" },
  }));
  assert.equal(response.statusCode, 404, "foreign projects must be concealed");
  assert.equal(body(response).code, "NOT_FOUND");
});

test("GET /api/project-memories derives resources for an authorized non-demo project", async () => {
  const customProject = project({
    id: "agent-lab",
    name: "Agent Lab",
  });
  const customAgent = agent();
  const handler = handlerWith({
    workspaceState: {
      async listProjects({ domainId }) {
        return {
          items: domainId === "platform" ? [customProject] : [],
          cursor: null,
        };
      },
      async listAgents({ domainId, projectId }) {
        return {
          items:
            domainId === customAgent.domainId
            && projectId === customAgent.projectId
              ? [customAgent]
              : [],
          cursor: null,
        };
      },
    },
  });
  const response = await handler(event({
    queryStringParameters: { project: "agent-lab" },
  }));

  assert.equal(response.statusCode, 200, JSON.stringify(body(response)));
  assert.deepEqual(body(response).memories, [{
    name: "research-memory",
    memoryId: "research-memory",
    strategies: [],
    status: null,
  }]);
  assert.deepEqual(body(response).knowledgeBases, [{
    name: "research-kb",
    knowledgeBaseId: "research-kb",
    status: null,
  }]);
});

test("GET /api/project-memories unauthenticated request returns 401", async () => {
  const handler = handlerWith();
  const response = await handler(event({
    requestClaims: { sub: "", token_use: "access" },
    queryStringParameters: { project: "it-helpdesk" },
  }));
  assert.equal(response.statusCode, 401);
  assert.equal(body(response).code, "NOT_AUTHENTICATED");
});
