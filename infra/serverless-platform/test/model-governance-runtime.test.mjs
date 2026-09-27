import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createModelGovernanceAuthorizer,
  createModelGovernanceEntrypoint,
} from "../lambda/model-governance/runtime.mjs";

test("production model inventory assumes the dedicated Gateway invoker role", async () => {
  const source = await readFile(
    new URL("../lambda/model-governance/runtime.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /@aws-sdk\/client-sts/);
  assert.match(source, /createGatewayCredentialsProvider/);
  assert.match(source, /GATEWAY_INVOKER_ROLE_ARN/);
  assert.match(source, /sourceIdentity:\s*"platform"/);
});

test("production entrypoint dispatches CloudFormation seeds separately from HTTP requests", async () => {
  const calls = [];
  const handler = createModelGovernanceEntrypoint({
    apiHandler: async (event) => {
      calls.push(["api", event]);
      return { statusCode: 200 };
    },
    seedHandler: async (event) => {
      calls.push(["seed", event]);
      return { PhysicalResourceId: "baseline-model-policy" };
    },
  });
  const seedEvent = {
    RequestType: "Create",
    ResponseURL: "https://cloudformation.example.test/response",
    StackId: "stack",
    RequestId: "request",
    LogicalResourceId: "BaselineModelPolicy",
    ResourceProperties: {},
  };
  const apiEvent = {
    version: "2.0",
    requestContext: { http: { method: "GET", path: "/api/ai-gateway" } },
  };

  assert.deepEqual(await handler(seedEvent, {}), {
    PhysicalResourceId: "baseline-model-policy",
  });
  assert.deepEqual(await handler(apiEvent, {}), { statusCode: 200 });
  assert.deepEqual(calls.map(([name]) => name), ["seed", "api"]);
});

const admin = Object.freeze({
  actor: "admin-sub",
  role: "admin",
  activeDomain: null,
  domainIds: ["platform", "customer_support"],
});
const lead = Object.freeze({
  actor: "lead-sub",
  role: "lead",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});
const builder = Object.freeze({
  actor: "builder-sub",
  role: "builder",
  activeDomain: "customer_support",
  domainIds: ["customer_support"],
});
const user = Object.freeze({
  actor: "user-sub",
  role: "user",
  activeDomain: null,
  domainIds: [],
});

function approval(overrides = {}) {
  return {
    domainId: "customer_support",
    id: "model-access-001",
    kind: "RESOURCE_ACCESS",
    resourceType: "MODEL",
    resourceId: "bedrock-mantle/meta.llama-4-405b",
    projectId: null,
    status: "PENDING",
    requesterSubject: "builder-sub",
    approverSubject: null,
    reason: null,
    requestedAt: "2026-08-25T06:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

function authorizerWith(record = approval()) {
  return createModelGovernanceAuthorizer({
    workspaceState: {
      async getApproval({ domainId, approvalId }) {
        return (
          record.domainId === domainId
          && record.id === approvalId
        ) ? record : null;
      },
    },
    clock: () => new Date("2026-08-25T07:00:00.000Z"),
  });
}

test("production model authorizer permits the approved Admin, Lead, and Builder actions", async () => {
  const authorize = authorizerWith();
  const cases = [
    [
      admin,
      "model-policy:update",
      {
        id: "model-policy:bedrock-mantle/meta.llama-4-405b",
        lifecycleState: "ACTIVE",
      },
    ],
    [
      lead,
      "model-catalog:read",
      {
        id: "model-catalog:customer_support",
        domainId: "customer_support",
        lifecycleState: "ACTIVE",
      },
    ],
    [
      builder,
      "model-access:request",
      {
        id: "bedrock-mantle/meta.llama-4-405b",
        domainId: "customer_support",
        lifecycleState: "REQUESTABLE",
      },
    ],
    [
      builder,
      "model:use",
      {
        id: "bedrock-mantle/meta.llama-4-405b",
        domainId: "customer_support",
        lifecycleState: "ACTIVE",
      },
    ],
  ];

  for (const [identity, action, resource] of cases) {
    assert.equal(
      (await authorize({ identity, action, resource })).decision,
      "ALLOW",
      action,
    );
  }
});

test("Domain Lead decision is approval-bound and requester cannot self-approve", async () => {
  const authorize = authorizerWith();
  const input = {
    identity: lead,
    action: "model-access:decide",
    resource: {
      id: "model-access:customer_support/model-access-001",
      domainId: "customer_support",
      lifecycleState: "PENDING_APPROVAL",
    },
    approvalId: "model-access-001",
  };

  assert.equal((await authorize(input)).decision, "ALLOW");

  await assert.rejects(
    authorizerWith(approval({ requesterSubject: lead.actor }))(input),
    (error) =>
      error?.decision === "FORBIDDEN"
      && error?.reason === "REQUESTER_IS_APPROVER",
  );
});

test("Builder decisions and End User model inventory fail at canonical capability evaluation", async () => {
  const authorize = authorizerWith();
  await assert.rejects(
    authorize({
      identity: builder,
      action: "model-access:decide",
      resource: {
        id: "model-access:customer_support/model-access-001",
        domainId: "customer_support",
        lifecycleState: "PENDING_APPROVAL",
      },
      approvalId: "model-access-001",
    }),
    (error) =>
      error?.decision === "FORBIDDEN"
      && error?.reason === "CAPABILITY",
  );
  await assert.rejects(
    authorize({
      identity: user,
      action: "model-catalog:read",
      resource: {
        id: "model-catalog:platform",
        domainId: "platform",
        lifecycleState: "ACTIVE",
      },
    }),
    (error) =>
      error?.decision === "FORBIDDEN"
      && error?.reason === "CAPABILITY",
  );
});

test("foreign domain model access remains non-disclosing", async () => {
  const authorize = authorizerWith();
  await assert.rejects(
    authorize({
      identity: builder,
      action: "model:use",
      resource: {
        id: "bedrock-mantle/meta.llama-4-405b",
        domainId: "operations",
        lifecycleState: "ACTIVE",
      },
    }),
    (error) =>
      error?.decision === "NOT_FOUND"
      && error?.reason === "DOMAIN_SCOPE",
  );
});
