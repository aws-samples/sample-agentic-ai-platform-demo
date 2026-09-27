import assert from "node:assert/strict";
import test from "node:test";
import {
  PlatformAdminServiceError,
} from "../lambda/platform-admin/service.mjs";
import {
  projectEffectiveIdentity,
} from "../lambda/api/identity.mjs";

const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const ACTIVE_DOMAINS = [
  {
    id: "platform",
    name: "Platform",
    registryId: "PlatformReg1234",
    status: "ACTIVE",
  },
  {
    id: "customer_support",
    name: "Customer Support",
    registryId: "SupportReg1234",
    status: "ACTIVE",
  },
  {
    id: "operations",
    name: "Operations",
    registryId: "OperationsReg1",
    status: "ACTIVE",
  },
];

function accessClaims(groups, overrides = {}) {
  return {
    sub: "admin-sub-123",
    token_use: "access",
    "cognito:groups": groups,
    ...overrides,
  };
}

function request(method, path, {
  body,
  claims,
  headers,
  requestId = "gateway-request-123",
} = {}) {
  const resolvedHeaders = headers === undefined && method === "POST"
    ? { "x-request-id": requestId }
    : headers;
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    body,
    headers: resolvedHeaders,
    requestContext: {
      http: { method, path },
      requestId,
      ...(claims === undefined
        ? {}
        : { authorizer: { jwt: { claims } } }),
    },
  };
}

const MOCK_CREATED_ENTRY = {
  id: "test-a2a-agent",
  type: "A2AAgent",
  name: "test-a2a-agent",
  description: "Test agent",
  domain: "shared",
  defaultVersion: null,
  versions: [{
    semver: "1.0.0",
    status: "DRAFT",
    content: {},
    changelog: "Initial version.",
    createdBy: "admin-sub-123",
    createdAt: "2026-09-14T00:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    _aws: { registryId: "PlatformReg1234", recordId: "rec-abc123" },
  }],
};

async function harness({
  activeDomains = ACTIVE_DOMAINS,
  registryCreateResult = { ok: true, entry: MOCK_CREATED_ENTRY, approved: false },
  serviceError,
} = {}) {
  const module = await import("../lambda/platform-admin/index.mjs");
  assert.equal(typeof module.createPlatformAdminHandler, "function");
  const calls = [];
  const logs = [];
  const service = {
    async listActiveDomains() {
      calls.push({ method: "listActiveDomains" });
      return activeDomains;
    },
    async createDomain(scope, input) {
      calls.push({ method: "createDomain", scope: structuredClone(scope), input: structuredClone(input) });
      return { ok: true, domain: { id: "new-domain", name: "New Domain", status: "ACTIVE" } };
    },
    async listDomains(scope) {
      calls.push({ method: "listDomains", scope: structuredClone(scope) });
      return { ok: true, domains: [] };
    },
    async decideRegistryVersion(scope, input) {
      calls.push({ method: "decideRegistryVersion", scope: structuredClone(scope), input: structuredClone(input) });
      return { ok: true, version: { id: "v1", semver: "1.0.0", status: "APPROVED" } };
    },
    async createRegistryRecord(scope, input) {
      calls.push({ method: "createRegistryRecord", scope: structuredClone(scope), input: structuredClone(input) });
      if (serviceError) throw serviceError;
      return registryCreateResult;
    },
  };
  return {
    calls,
    handler: module.createPlatformAdminHandler({
      correlationIdFactory: () => "test-correlation-id",
      demoOperatorVerifier: async () => true,
      logger: { error(entry) { logs.push(entry); } },
      service,
    }),
    logs,
  };
}

const VALID_A2A_CARD = JSON.stringify({
  name: "test-a2a-agent",
  url: "https://example.com/a2a",
  description: "A test A2A agent",
});

const VALID_MCP_ENDPOINT = "https://mcp.example.com/server";

test("POST /api/registry-create: admin creates A2A agent draft", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-a2a-agent",
    displayName: "Test A2A Agent",
    description: "A test A2A agent",
    content: VALID_A2A_CARD,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, RESPONSE_HEADERS);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.approved, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "createRegistryRecord");
  assert.equal(calls[0].input.type, "A2AAgent");
  assert.equal(calls[0].input.name, "test-a2a-agent");
  assert.equal(calls[0].input.andApprove, false);
  assert.equal(calls[0].scope.role, "admin");
});

test("POST /api/registry-create: admin creates A2A agent with andApprove=true", async () => {
  const approvedEntry = {
    ...MOCK_CREATED_ENTRY,
    defaultVersion: "1.0.0",
    versions: [{ ...MOCK_CREATED_ENTRY.versions[0], status: "APPROVED" }],
  };
  const { calls, handler } = await harness({
    registryCreateResult: { ok: true, entry: approvedEntry, approved: true },
  });
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-a2a-agent",
    displayName: "Test A2A Agent",
    description: "A test A2A agent",
    content: VALID_A2A_CARD,
    andApprove: true,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.approved, true);
  assert.equal(calls[0].input.andApprove, true);
});

test("POST /api/registry-create: admin creates MCP server", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "MCPServer",
    name: "test-mcp-server",
    displayName: "Test MCP Server",
    description: "A test MCP server",
    endpoint: VALID_MCP_ENDPOINT,
    transport: "streamable_http",
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, true);
  assert.equal(calls[0].input.type, "MCPServer");
  assert.equal(calls[0].input.endpoint, VALID_MCP_ENDPOINT);
});

test("POST /api/registry-create: domain publisher creates DRAFT in own domain", async () => {
  const { calls, handler } = await harness({
    registryCreateResult: {
      ok: true,
      entry: { ...MOCK_CREATED_ENTRY, domain: "customer_support" },
      approved: false,
    },
  });
  // domain-builder role + domain-customer-support (hyphen form, alias to customer_support) gives registerDomainResourceDraft
  const body = JSON.stringify({
    type: "Skill",
    name: "support-skill",
    displayName: "Support Skill",
    description: "A support domain skill",
    content: "## Support Skill\n\nThis skill helps with support tasks.",
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["domain-builder", "domain-customer-support"], {
      sub: "publisher-sub-456",
    }),
  }));
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, true);
  assert.equal(calls[0].method, "createRegistryRecord");
  assert.equal(calls[0].scope.role, "builder");
  // andApprove must be false for publishers
  assert.equal(calls[0].input.andApprove, false);
});

test("POST /api/registry-create: publisher with andApprove=true is rejected", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "Skill",
    name: "support-skill",
    content: "## Support Skill",
    andApprove: true,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["domain-builder", "domain-customer-support"], {
      sub: "publisher-sub-456",
    }),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: end user (no publisher cap) gets 403", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-agent",
    content: VALID_A2A_CARD,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["end-user"]),
  }));
  assert.equal(response.statusCode, 403);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "FORBIDDEN");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: unauthenticated request gets 401", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-agent",
    content: VALID_A2A_CARD,
  });
  const response = await handler(request("POST", "/api/registry-create", { body }));
  assert.equal(response.statusCode, 401);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "NOT_AUTHENTICATED");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: missing x-request-id header returns 400", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-agent",
    content: VALID_A2A_CARD,
  });
  // Explicitly override headers to omit x-request-id
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
    headers: {},
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_REQUEST_ID");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: invalid type returns 400", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "Model",
    name: "test-model",
    content: "{}",
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: invalid name pattern returns 400", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "My Agent Name!",
    content: VALID_A2A_CARD,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: A2A agent with invalid JSON card returns 400", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-agent",
    content: "not-valid-json",
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: A2A agent card missing name field returns 400", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-agent",
    content: JSON.stringify({ url: "https://example.com/a2a" }), // missing name
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: MCPServer without https endpoint returns 400", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "MCPServer",
    name: "test-mcp",
    endpoint: "http://insecure.example.com/mcp", // not https
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: oversized content returns 400", async () => {
  const { calls, handler } = await harness();
  const hugeContent = "x".repeat(65537); // over 65536 byte limit
  const body = JSON.stringify({
    type: "Skill",
    name: "big-skill",
    content: hugeContent,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

test("POST /api/registry-create: service error propagates as 503", async () => {
  const { calls, handler } = await harness({
    serviceError: new Error("AWS registry unavailable"),
  });
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-agent",
    content: VALID_A2A_CARD,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 503);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "PLATFORM_ADMIN_UNAVAILABLE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "createRegistryRecord");
});

test("POST /api/registry-create: unknown body keys return 400", async () => {
  const { calls, handler } = await harness();
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-agent",
    content: VALID_A2A_CARD,
    unknownKey: "not-allowed",
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 400);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_BODY");
  assert.equal(calls.length, 0);
});

// CREATING poll path: service returns approved:false with note when record stays CREATING
test("POST /api/registry-create: andApprove=true with CREATING timeout returns ok with approved:false and note", async () => {
  // Simulate service returning approved:false + note (record still CREATING after poll timeout)
  const creatingEntry = {
    ...MOCK_CREATED_ENTRY,
    defaultVersion: null,
    versions: [{ ...MOCK_CREATED_ENTRY.versions[0], status: "CREATING" }],
  };
  const { calls, handler } = await harness({
    registryCreateResult: {
      ok: true,
      entry: creatingEntry,
      approved: false,
      note: "Record was created but is still processing. Approval was not applied.",
    },
  });
  const body = JSON.stringify({
    type: "A2AAgent",
    name: "test-a2a-agent",
    content: VALID_A2A_CARD,
    andApprove: true,
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
  }));
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.approved, false);
  assert.ok(parsed.note, "response must have note explaining partial state");
  assert.equal(calls[0].input.andApprove, true);
});

// clientToken verification: x-request-id is used in the call input passed to service
test("POST /api/registry-create: requestId is forwarded to service scope", async () => {
  const { calls, handler } = await harness();
  const customRequestId = "my-custom-request-id-for-registry-test-12345";
  const body = JSON.stringify({
    type: "Skill",
    name: "my-skill",
    content: "# My Skill",
  });
  const response = await handler(request("POST", "/api/registry-create", {
    body,
    claims: accessClaims(["platform-admin"]),
    headers: { "x-request-id": customRequestId },
  }));
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].scope.requestId, customRequestId);
});
