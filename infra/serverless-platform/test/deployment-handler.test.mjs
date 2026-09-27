import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeploymentHandler,
} from "../lambda/deployment/index.mjs";

const CLAIMS = {
  sub: "operator-sub",
  token_use: "access",
  "cognito:groups": "[\"platform-admin\",\"demo-operator\"]",
};

function event(routeKey, path, body, {
  role = "builder",
  domain = "customer_support",
  requestId = "deployment-request",
} = {}) {
  return {
    routeKey,
    requestContext: {
      requestId: "api-request",
      http: {
        method: routeKey.split(" ")[0],
        path,
      },
      authorizer: {
        jwt: { claims: CLAIMS },
      },
    },
    headers: {
      "content-type": "application/json",
      "x-demo-role": role,
      "x-active-domain": domain,
      "x-request-id": requestId,
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function handlerWith(calls = []) {
  return createDeploymentHandler({
    identityProjector: {
      projectAuthenticated() {
        return {
          actor: "operator-sub",
          role: "admin",
        };
      },
      projectEffective(_claims, headers) {
        return {
          actor: "operator-sub",
          role: headers["x-demo-role"],
          domain: headers["x-active-domain"],
        };
      },
    },
    async identityVerifier() {
      return true;
    },
    domainDirectory: {
      async listActiveDomains() {
        return [
          { id: "customer_support" },
          { id: "operations" },
        ];
      },
    },
    deploymentService: {
      async deploySandbox(input) {
        calls.push(["sandbox", input]);
        return {
          deployment: { id: input.deploymentId, status: "DEPLOYED" },
          agent: { id: input.agentRef.agentId, status: "SANDBOX_DEPLOYED" },
        };
      },
      async submitProduction(input) {
        calls.push(["submit", input]);
        return {
          deployment: { id: input.deploymentId, status: "REQUESTED" },
          approval: { id: input.approvalId, status: "PENDING" },
          agent: { id: input.agentRef.agentId, status: "PRODUCTION_PENDING" },
        };
      },
      async decideProduction(input) {
        calls.push(["decision", input]);
        return {
          deployment: { id: input.deploymentRef.deploymentId, status: "DEPLOYED" },
          approval: { id: input.approvalId, status: "APPROVED" },
          agent: { id: "triage-agent", status: "PRODUCTION_DEPLOYED" },
        };
      },
    },
  });
}

test("sandbox route projects the selected builder role and domain", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const response = await handler(event(
    "POST /api/deployments/sandbox",
    "/api/deployments/sandbox",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      deploymentId: "triage-sandbox",
    },
  ));

  assert.equal(response.statusCode, 201);
  assert.equal(calls[0][0], "sandbox");
  assert.deepEqual(calls[0][1].identity, {
    actor: "operator-sub",
    role: "builder",
    activeDomain: "customer_support",
    domainIds: ["customer_support"],
  });
  assert.equal(calls[0][1].requestId, "deployment-request");
});

test("production submission and lead decision use distinct governed actions", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const submit = await handler(event(
    "POST /api/deployments/production",
    "/api/deployments/production",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      deploymentId: "triage-production",
      approvalId: "triage-production-approval",
    },
  ));
  const decide = await handler(event(
    "POST /api/deployment-decisions",
    "/api/deployment-decisions",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      deploymentId: "triage-production",
      approvalId: "triage-production-approval",
      decision: "APPROVE",
      reason: "Approved after domain review.",
    },
    { role: "lead", requestId: "approval-request" },
  ));

  assert.equal(submit.statusCode, 201);
  assert.equal(decide.statusCode, 200);
  assert.deepEqual(calls.map(([operation]) => operation), [
    "submit",
    "decision",
  ]);
  assert.equal(calls[1][1].identity.role, "lead");
  assert.equal(calls[1][1].decision, "APPROVE");
});

test("end user and malformed requests are denied before service calls", async () => {
  const calls = [];
  const handler = handlerWith(calls);
  const denied = await handler(event(
    "POST /api/deployments/sandbox",
    "/api/deployments/sandbox",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      deploymentId: "triage-sandbox",
    },
    { role: "user", domain: "" },
  ));
  const malformed = await handler(event(
    "POST /api/deployments/sandbox",
    "/api/deployments/sandbox",
    { unexpected: true },
  ));

  assert.equal(denied.statusCode, 403);
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("role switching requires the current token subject to remain demo operator", async () => {
  const handler = createDeploymentHandler({
    identityProjector: {
      projectAuthenticated() {
        return { actor: "operator-sub", role: "admin" };
      },
      projectEffective() {
        throw new Error("must not project");
      },
    },
    async identityVerifier() {
      return false;
    },
    domainDirectory: {
      async listActiveDomains() {
        return [{ id: "customer_support" }];
      },
    },
    deploymentService: {
      async deploySandbox() {
        throw new Error("must not call");
      },
      async submitProduction() {
        throw new Error("must not call");
      },
      async decideProduction() {
        throw new Error("must not call");
      },
    },
  });

  const response = await handler(event(
    "POST /api/deployments/sandbox",
    "/api/deployments/sandbox",
    {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "triage-agent",
      deploymentId: "triage-sandbox",
    },
  ));
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, "DEMO_ROLE_NOT_ALLOWED");
});
