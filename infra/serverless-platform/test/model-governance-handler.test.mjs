import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelGovernanceHandler,
} from "../lambda/model-governance/index.mjs";
import {
  ModelGovernanceServiceError,
} from "../lambda/model-governance/service.mjs";

const claims = Object.freeze({
  sub: "operator-sub",
  token_use: "access",
  "cognito:groups": ["platform-admin", "demo-operator"],
});

function event({
  path = "/api/ai-gateway",
  method = "GET",
  headers,
  body,
  requestClaims = claims,
  requestId = "model-governance-request",
} = {}) {
  return {
    version: "2.0",
    headers,
    body,
    requestContext: {
      http: { method, path },
      requestId,
      authorizer: { jwt: { claims: requestClaims } },
    },
  };
}

function projector() {
  return {
    projectAuthenticated(requestClaims) {
      return {
        actor: requestClaims.sub,
        role: "admin",
      };
    },
    projectEffective(requestClaims, headers, { availableDomains }) {
      const role = headers?.["x-demo-role"] || "admin";
      const domain = headers?.["x-active-domain"] || null;
      if (
        (role === "lead" || role === "builder")
        && !availableDomains.some(({ id }) => id === domain)
      ) {
        const error = new Error("domain not available");
        error.code = domain
          ? "DEMO_DOMAIN_NOT_ALLOWED"
          : "DEMO_DOMAIN_REQUIRED";
        error.statusCode = 403;
        throw error;
      }
      return {
        actor: requestClaims.sub,
        role,
        domain,
        domains: domain ? [domain] : role === "admin"
          ? availableDomains.map(({ id }) => id)
          : [],
      };
    },
  };
}

function harness({ serviceOverrides = {} } = {}) {
  const calls = [];
  const service = {
    async readCatalog(input) {
      calls.push(["readCatalog", input]);
      return {
        ok: true,
        source: "aws",
        domainId: input.identity.activeDomain,
        models: [],
      };
    },
    async putPolicy(input) {
      calls.push(["putPolicy", input]);
      return { modelId: input.modelId, applicationStatus: "ACTIVE" };
    },
    async requestAccess(input) {
      calls.push(["requestAccess", input]);
      return { id: input.approvalId, status: "PENDING" };
    },
    async decideAccess(input) {
      calls.push(["decideAccess", input]);
      return {
        approval: { id: input.approvalId, status: "APPROVED" },
        grant: { status: "ACTIVE" },
      };
    },
    ...serviceOverrides,
  };
  const handler = createModelGovernanceHandler({
    identityProjector: projector(),
    identityVerifier: async () => true,
    domainDirectory: {
      async listActiveDomains() {
        calls.push(["domains"]);
        return [
          { id: "platform" },
          { id: "customer_support" },
        ];
      },
    },
    service,
  });
  return { handler, calls };
}

function responseBody(response) {
  return JSON.parse(response.body);
}

test("GET /api/ai-gateway dispatches the selected Lead domain identity", async () => {
  const { handler, calls } = harness();

  const response = await handler(event({
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
    },
  }));

  assert.equal(response.statusCode, 200);
  const call = calls.find(([name]) => name === "readCatalog");
  assert.deepEqual(call[1].identity, {
    actor: "operator-sub",
    role: "lead",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  });
});

test("GET /api/ai-gateway gives Builder the selected domain model catalog", async () => {
  const { handler, calls } = harness();

  const response = await handler(event({
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
    },
  }));

  assert.equal(response.statusCode, 200);
  const call = calls.find(([name]) => name === "readCatalog");
  assert.deepEqual(call[1].identity, {
    actor: "operator-sub",
    role: "builder",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  });
});

test("POST model policy requires a single request ID and exact body", async () => {
  const { handler, calls } = harness();
  const response = await handler(event({
    path: "/api/ai-gateway/model-policies",
    method: "POST",
    headers: { "x-request-id": "policy-001" },
    body: JSON.stringify({
      modelId: "bedrock-mantle/meta.llama-4-405b",
      allowedDomains: ["operations"],
      requestableDomains: ["customer_support"],
      limits: {
        requestsPerMinute: 45,
        tokensPerMinute: 90000,
        connectionsPerSecond: 3,
      },
    }),
  }));

  assert.equal(response.statusCode, 200);
  const call = calls.find(([name]) => name === "putPolicy");
  assert.equal(call[1].requestId, "policy-001");
  assert.equal(call[1].identity.role, "admin");
  assert.equal(
    responseBody(response).policy.applicationStatus,
    "ACTIVE",
  );
});

test("model access request and decision routes preserve effective domain identity", async () => {
  const { handler, calls } = harness();
  const requestResponse = await handler(event({
    path: "/api/ai-gateway/model-access-requests",
    method: "POST",
    headers: {
      "x-demo-role": "builder",
      "x-active-domain": "customer_support",
      "x-request-id": "request-model-001",
    },
    body: JSON.stringify({
      approvalId: "model-access-001",
      modelId: "bedrock-mantle/meta.llama-4-405b",
    }),
  }));
  const decisionResponse = await handler(event({
    path: "/api/ai-gateway/model-access-decisions",
    method: "POST",
    headers: {
      "x-demo-role": "lead",
      "x-active-domain": "customer_support",
      "x-request-id": "decide-model-001",
    },
    body: JSON.stringify({
      approvalId: "model-access-001",
      decision: "APPROVE",
      reason: "Approved for the domain.",
    }),
  }));

  assert.equal(requestResponse.statusCode, 201);
  assert.equal(decisionResponse.statusCode, 200);
  assert.equal(
    calls.find(([name]) => name === "requestAccess")[1]
      .identity.activeDomain,
    "customer_support",
  );
  assert.equal(
    calls.find(([name]) => name === "decideAccess")[1].identity.role,
    "lead",
  );
});

test("service denials remain stable and do not leak backend detail", async () => {
  const { handler } = harness({
    serviceOverrides: {
      async readCatalog() {
        throw new ModelGovernanceServiceError("FORBIDDEN");
      },
    },
  });

  const response = await handler(event({
    headers: { "x-demo-role": "user" },
  }));

  assert.equal(response.statusCode, 403);
  assert.deepEqual(responseBody(response), {
    ok: false,
    code: "FORBIDDEN",
    message: "The requested model governance action is not allowed.",
    requestId: "model-governance-request",
    retryable: false,
  });
});

test("invalid routes, bodies, and request IDs never dispatch to the service", async () => {
  for (const invalid of [
    event({ path: "/api/ai-gateway/unknown" }),
    event({
      path: "/api/ai-gateway/model-access-requests",
      method: "POST",
      body: "{}",
    }),
    event({
      path: "/api/ai-gateway/model-access-requests",
      method: "POST",
      headers: { "x-request-id": "bad id" },
      body: JSON.stringify({
        approvalId: "model-access-001",
        modelId: "bedrock-mantle/meta.llama-4-405b",
      }),
    }),
  ]) {
    const { handler, calls } = harness();
    const response = await handler(invalid);
    assert.equal(response.statusCode >= 400, true);
    assert.equal(
      calls.some(([name]) =>
        [
          "readCatalog",
          "putPolicy",
          "requestAccess",
          "decideAccess",
        ].includes(name)),
      false,
    );
  }
});
