import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelAccessUnavailableError,
  createModelAccessResolver,
} from "../lambda/model-governance/access.mjs";

const MODEL_ID = "bedrock-claude/anthropic.claude-sonnet-5";

function policy(overrides = {}) {
  return {
    modelId: MODEL_ID,
    allowedDomains: [],
    requestableDomains: [],
    limits: {
      requestsPerMinute: 60,
      tokensPerMinute: null,
      connectionsPerSecond: null,
    },
    revision: 1,
    applicationStatus: "ACTIVE",
    rateLimit: {
      id: "platform-model-domain-limits",
      status: "ACTIVE",
      reason: null,
      reconciledAt: "2026-08-25T03:00:00.000Z",
    },
    updatedBySubject: "admin-sub",
    updatedAt: "2026-08-25T03:00:00.000Z",
    ...overrides,
  };
}

function grant(overrides = {}) {
  return {
    domainId: "customer_support",
    resourceType: "MODEL",
    resourceId: MODEL_ID,
    status: "ACTIVE",
    grantedBySubject: "lead-sub",
    grantedAt: "2026-08-25T03:30:00.000Z",
    revokedBySubject: null,
    revokedAt: null,
    ...overrides,
  };
}

function harness({
  getModelPolicy = async () => policy(),
  getResourceGrant = async () => grant(),
} = {}) {
  const calls = [];
  const resolveModelAccess = createModelAccessResolver({
    modelPolicyState: {
      async getModelPolicy(input) {
        calls.push(["getModelPolicy", structuredClone(input)]);
        return getModelPolicy(input);
      },
    },
    workspaceState: {
      async getResourceGrant(input) {
        calls.push(["getResourceGrant", structuredClone(input)]);
        return getResourceGrant(input);
      },
    },
  });
  return { calls, resolveModelAccess };
}

test("platform domain overrides model policy and grants", async () => {
  const { calls, resolveModelAccess } = harness({
    getModelPolicy: async () => {
      throw new Error("must not read policy");
    },
    getResourceGrant: async () => {
      throw new Error("must not read grants");
    },
  });

  assert.equal(
    await resolveModelAccess({ domainId: "platform", modelId: MODEL_ID }),
    true,
  );
  assert.deepEqual(calls, []);
});

test("an ACTIVE policy directly allowing the domain grants access", async () => {
  const { calls, resolveModelAccess } = harness({
    getModelPolicy: async () =>
      policy({ allowedDomains: ["customer_support"] }),
    getResourceGrant: async () => {
      throw new Error("direct access must not read grants");
    },
  });

  assert.equal(
    await resolveModelAccess({
      domainId: "customer_support",
      modelId: MODEL_ID,
    }),
    true,
  );
  assert.deepEqual(calls, [
    ["getModelPolicy", { modelId: MODEL_ID }],
  ]);
});

test("a requestable domain requires an exact ACTIVE MODEL grant", async () => {
  const { calls, resolveModelAccess } = harness({
    getModelPolicy: async () =>
      policy({ requestableDomains: ["customer_support"] }),
  });

  assert.equal(
    await resolveModelAccess({
      domainId: "customer_support",
      modelId: MODEL_ID,
    }),
    true,
  );
  assert.deepEqual(calls, [
    ["getModelPolicy", { modelId: MODEL_ID }],
    ["getResourceGrant", {
      domainId: "customer_support",
      resourceType: "MODEL",
      resourceId: MODEL_ID,
    }],
  ]);
});

test("an ACTIVE policy with all limits omitted denies access", async () => {
  const { calls, resolveModelAccess } = harness({
    getModelPolicy: async () =>
      policy({
        allowedDomains: ["customer_support"],
        limits: {
          requestsPerMinute: null,
          tokensPerMinute: null,
          connectionsPerSecond: null,
        },
      }),
  });

  assert.equal(
    await resolveModelAccess({
      domainId: "customer_support",
      modelId: MODEL_ID,
    }),
    false,
  );
  assert.deepEqual(calls, [
    ["getModelPolicy", { modelId: MODEL_ID }],
  ]);
});

test("missing, non-ACTIVE, malformed, and foreign policies deny access", async () => {
  for (const storedPolicy of [
    null,
    policy({ applicationStatus: "PENDING" }),
    policy({ modelId: "other-model" }),
    policy({ allowedDomains: ["finance"] }),
    policy({
      allowedDomains: [
        "customer_support",
        ...Array.from({ length: 100 }, (_, index) => `domain_${index}`),
      ],
    }),
    policy({
      allowedDomains: ["customer_support"],
      limits: {
        requestsPerMinute: 1_000_001,
        tokensPerMinute: null,
        connectionsPerSecond: null,
      },
      rateLimit: {
        id: "rate-limit",
        status: "ACTIVE",
        reason: null,
        reconciledAt: "2026-08-25T03:00:00.000Z",
      },
    }),
    policy({
      allowedDomains: ["customer_support"],
      limits: {
        requestsPerMinute: 60,
        tokensPerMinute: null,
        connectionsPerSecond: 10_001,
      },
    }),
    policy({
      allowedDomains: ["customer_support"],
      revision: 1_000_000_001,
    }),
    policy({
      allowedDomains: ["customer_support"],
      rateLimit: {
        id: "invalid rate limit",
        status: "ACTIVE",
        reason: null,
        reconciledAt: "2026-08-25T03:00:00.000Z",
      },
    }),
    { modelId: MODEL_ID, applicationStatus: "ACTIVE" },
  ]) {
    const { calls, resolveModelAccess } = harness({
      getModelPolicy: async () => storedPolicy,
    });

    assert.equal(
      await resolveModelAccess({
        domainId: "customer_support",
        modelId: MODEL_ID,
      }),
      false,
    );
    assert.equal(
      calls.some(([name]) => name === "getResourceGrant"),
      false,
    );
  }
});

test("revoked, missing, malformed, and foreign grants deny access", async () => {
  for (const storedGrant of [
    null,
    grant({
      status: "REVOKED",
      revokedBySubject: "lead-sub",
      revokedAt: "2026-08-25T04:00:00.000Z",
    }),
    grant({ domainId: "finance" }),
    grant({ resourceId: "other-model" }),
    { status: "ACTIVE" },
  ]) {
    const { resolveModelAccess } = harness({
      getModelPolicy: async () =>
        policy({ requestableDomains: ["customer_support"] }),
      getResourceGrant: async () => storedGrant,
    });

    assert.equal(
      await resolveModelAccess({
        domainId: "customer_support",
        modelId: MODEL_ID,
      }),
      false,
    );
  }
});

test("unavailable policy or grant dependencies fail closed", async () => {
  assert.throws(
    () => createModelAccessResolver(),
    /Model access resolver configuration is invalid/,
  );

  for (const options of [
    {
      getModelPolicy: async () => {
        throw new Error("DynamoDB unavailable");
      },
    },
    {
      getModelPolicy: async () =>
        policy({ requestableDomains: ["customer_support"] }),
      getResourceGrant: async () => {
        throw new Error("DynamoDB unavailable");
      },
    },
  ]) {
    const { resolveModelAccess } = harness(options);
    await assert.rejects(
      resolveModelAccess({
        domainId: "customer_support",
        modelId: MODEL_ID,
      }),
      (error) => {
        assert.ok(error instanceof ModelAccessUnavailableError);
        assert.equal(error.code, "MODEL_ACCESS_UNAVAILABLE");
        return true;
      },
    );
  }
});
