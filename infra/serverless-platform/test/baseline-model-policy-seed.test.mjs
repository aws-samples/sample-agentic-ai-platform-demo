import assert from "node:assert/strict";
import test from "node:test";
import {
  handleBaselineModelPolicySeed,
  reconcileBaselineModelPolicy,
} from "../lambda/model-governance/seed.mjs";

const TABLE_NAME = "AgenticPlatform-Web-PlatformStateTable-EXAMPLE";
const ALLOWED_DOMAINS = ["customer_support", "operations", "platform"];
const STARTER_MODEL_ID =
  "bedrock-mantle/anthropic.claude-haiku-4-5";
const LIMITS = Object.freeze({
  requestsPerMinute: 60,
  tokensPerMinute: 120000,
  connectionsPerSecond: 4,
});

function event(requestType = "Create", overrides = {}) {
  return {
    RequestType: requestType,
    RequestId: "cloudformation-request-1234",
    ResourceProperties: {
      ServiceToken:
        "arn:aws:lambda:us-west-2:111122223333:function:model-policy",
      ServiceTimeout: "180",
      TableName: TABLE_NAME,
      ModelId: STARTER_MODEL_ID,
      AllowedDomains: ALLOWED_DOMAINS,
      Limits: LIMITS,
    },
    ...overrides,
  };
}

function model(id, policy = null) {
  return { id, policy };
}

function activePolicy(modelId, allowedDomains = ALLOWED_DOMAINS) {
  return {
    modelId,
    allowedDomains,
    requestableDomains: [],
    limits: { ...LIMITS },
    applicationStatus: "ACTIVE",
    rateLimit: {
      id: "platform-model-domain-limits",
      status: "ACTIVE",
      reason: null,
      reconciledAt: "2026-08-26T01:00:00.000Z",
    },
    updatedBySubject: "deployment:baseline",
    updatedAt: "2026-08-26T01:00:00.000Z",
    revision: 1,
  };
}

function harness({
  models = [
    model("bedrock-mantle/openai.gpt-oss-120b"),
    model(STARTER_MODEL_ID),
  ],
  putResult,
} = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async readCatalog(input) {
        calls.push(["readCatalog", input]);
        return {
          ok: true,
          source: "aws",
          llmGateway: {
            gatewayId: "agentic-demo-llm-gateway-abcdefghij",
          },
          models,
        };
      },
      async putPolicy(input) {
        calls.push(["putPolicy", input]);
        return putResult ?? activePolicy(input.modelId);
      },
    },
  };
}

test("Create validates and applies the exact configured live starter model", async () => {
  const { calls, service } = harness();

  const result = await reconcileBaselineModelPolicy(event(), { service });

  assert.equal(
    result.PhysicalResourceId,
    `platform-baseline-model-policy:${TABLE_NAME}`,
  );
  assert.deepEqual(result.Data, {
    Changed: true,
    ModelId: STARTER_MODEL_ID,
    AppliedModelIds: STARTER_MODEL_ID,
    RetainedModelIds: "",
    SkippedModelIds: "",
  });
  assert.deepEqual(calls[0], [
    "readCatalog",
    {
      identity: {
        actor: "deployment:baseline",
        role: "admin",
        activeDomain: null,
        domainIds: ALLOWED_DOMAINS,
      },
    },
  ]);
  assert.deepEqual(calls[1][1], {
    identity: {
      actor: "deployment:baseline",
      role: "admin",
      activeDomain: null,
      domainIds: ALLOWED_DOMAINS,
    },
    requestId:
      "deployment-baseline-model-policy-"
      + "d636ed1904fd437aeab4afa8",
    modelId: STARTER_MODEL_ID,
    allowedDomains: ALLOWED_DOMAINS,
    requestableDomains: [],
    limits: LIMITS,
  });
});

test("Create preserves an existing active policy that already covers every baseline domain", async () => {
  const existing = activePolicy(
    STARTER_MODEL_ID,
    ["operations", "customer_support", "platform", "future_domain"],
  );
  const { calls, service } = harness({
    models: [
      model("bedrock-mantle/openai.gpt-oss-120b"),
      model(STARTER_MODEL_ID, existing),
    ],
  });

  const result = await reconcileBaselineModelPolicy(event(), { service });

  assert.deepEqual(result.Data, {
    Changed: false,
    ModelId: STARTER_MODEL_ID,
    AppliedModelIds: "",
    RetainedModelIds: STARTER_MODEL_ID,
    SkippedModelIds: "",
  });
  assert.deepEqual(calls.map(([name]) => name), ["readCatalog"]);
});

test("Create fails closed instead of overwriting configured policies", async () => {
  const { service } = harness({
    models: [
      model(
        STARTER_MODEL_ID,
        activePolicy(
          STARTER_MODEL_ID,
          ["operations"],
        ),
      ),
      model(
        "bedrock-mantle/openai.gpt-oss-120b",
        activePolicy(
          "bedrock-mantle/openai.gpt-oss-120b",
          ["customer_support"],
        ),
      ),
    ],
  });

  await assert.rejects(
    reconcileBaselineModelPolicy(event(), { service }),
    (error) => error?.code === "BASELINE_MODEL_POLICY_CONFLICT",
  );
});

test("upgrade adds Platform only to an unchanged deployment-owned baseline", async () => {
  const old=activePolicy(STARTER_MODEL_ID,["customer_support","operations"]);
  const {service,calls}=harness({models:[model(STARTER_MODEL_ID,old)]});
  const result=await reconcileBaselineModelPolicy(event(),{service});
  assert.equal(result.Data.Changed,true);
  assert.deepEqual(calls.find(([method])=>method==="putPolicy")[1].allowedDomains,ALLOWED_DOMAINS);
  for(const changed of [{...old,updatedBySubject:"administrator"}, {...old,limits:{...old.limits,requestsPerMinute:20}}]){
    const h=harness({models:[model(STARTER_MODEL_ID,changed)]});
    await assert.rejects(reconcileBaselineModelPolicy(event(),{service:h.service}),{code:"BASELINE_MODEL_POLICY_CONFLICT"});
  }
});

test("Create fails closed when the configured starter model is absent from the live catalog", async () => {
  const { calls, service } = harness({
    models: [
      model("bedrock-mantle/openai.gpt-oss-120b"),
    ],
  });

  await assert.rejects(
    reconcileBaselineModelPolicy(event(), { service }),
    (error) => error?.code === "BASELINE_MODEL_POLICY_UNAVAILABLE",
  );
  assert.deepEqual(calls.map(([name]) => name), ["readCatalog"]);
});

test("Delete retains the policy without reading or mutating live state", async () => {
  const { calls, service } = harness();

  const result = await reconcileBaselineModelPolicy(
    event("Delete", {
      PhysicalResourceId:
        `platform-baseline-model-policy:${TABLE_NAME}`,
    }),
    { service },
  );

  assert.equal(
    result.PhysicalResourceId,
    `platform-baseline-model-policy:${TABLE_NAME}`,
  );
  assert.deepEqual(calls, []);
});

test("malformed seed properties are rejected before service access", async () => {
  const { calls, service } = harness();

  await assert.rejects(
    reconcileBaselineModelPolicy(
      event("Create", {
        ResourceProperties: {
          ...event().ResourceProperties,
          AllowedDomains: ["platform", "customer_support"],
        },
      }),
      { service },
    ),
    (error) => error?.code === "INVALID_BASELINE_MODEL_POLICY_SEED",
  );
  assert.deepEqual(calls, []);
});

test("handler returns a sanitized CloudFormation success response", async () => {
  const { service } = harness();
  const responses = [];

  const result = await handleBaselineModelPolicySeed(
    event(),
    { logStreamName: "private-log-stream" },
    service,
    {
      async sendResponse(...input) {
        responses.push(input);
      },
    },
  );

  assert.equal(result.Data.Changed, true);
  assert.equal(responses.length, 1);
  assert.equal(responses[0][2], "SUCCESS");
  assert.equal(
    responses[0][4],
    "Baseline model policy seed operation completed.",
  );
});

test("handler reports a sanitized CloudFormation failure without leaking the backend error", async () => {
  const secret = "do-not-leak-backend-detail";
  const responses = [];
  const service = {
    async readCatalog() {
      throw new Error(secret);
    },
    async putPolicy() {
      throw new Error("unexpected");
    },
  };

  const result = await handleBaselineModelPolicySeed(
    event(),
    {},
    service,
    {
      async sendResponse(...input) {
        responses.push(input);
      },
      logError() {},
    },
  );

  assert.equal(
    result.PhysicalResourceId,
    `platform-baseline-model-policy:${TABLE_NAME}`,
  );
  assert.equal(responses[0][2], "FAILED");
  assert.equal(
    responses[0][4],
    "Baseline model policy seed operation failed.",
  );
  assert.doesNotMatch(JSON.stringify(responses), new RegExp(secret));
});

test("Create applies every curated catalog model, skipping ones the gateway has not discovered and retaining admin-managed policies", async () => {
  const adminPolicy = {
    ...activePolicy("bedrock-mantle/zai.glm-5", ["customer_support"]),
    updatedBySubject: "real-admin-subject",
  };
  const { calls, service } = harness({
    models: [
      model(STARTER_MODEL_ID),
      model("bedrock-mantle/moonshotai.kimi-k3"),
      model("bedrock-mantle/zai.glm-5", adminPolicy),
    ],
  });
  const result = await reconcileBaselineModelPolicy(event("Create", {
    ResourceProperties: {
      ...event().ResourceProperties,
      ModelIds: [
        STARTER_MODEL_ID,
        "bedrock-mantle/moonshotai.kimi-k3",
        "bedrock-mantle/zai.glm-5",
        "bedrock-mantle/openai.gpt-6-astra",
      ],
    },
  }), { service });
  assert.deepEqual(result.Data, {
    Changed: true,
    ModelId: STARTER_MODEL_ID,
    AppliedModelIds: [STARTER_MODEL_ID, "bedrock-mantle/moonshotai.kimi-k3"].join(","),
    // Admin-managed policy on a curated model is never overwritten.
    RetainedModelIds: "bedrock-mantle/zai.glm-5",
    // Not yet discovered by the gateway: skipped, not invented, not fatal.
    SkippedModelIds: "bedrock-mantle/openai.gpt-6-astra",
  });
  const puts = calls.filter(([name]) => name === "putPolicy");
  assert.deepEqual(puts.map(([, input]) => input.modelId),
    [STARTER_MODEL_ID, "bedrock-mantle/moonshotai.kimi-k3"]);
});

test("a missing STARTER model stays fatal even in a multi-model catalog", async () => {
  const { service } = harness({ models: [model("bedrock-mantle/moonshotai.kimi-k3")] });
  await assert.rejects(
    () => reconcileBaselineModelPolicy(event("Create", {
      ResourceProperties: {
        ...event().ResourceProperties,
        ModelIds: [STARTER_MODEL_ID, "bedrock-mantle/moonshotai.kimi-k3"],
      },
    }), { service }),
    (error) => error.code === "BASELINE_MODEL_POLICY_UNAVAILABLE",
  );
});

test("duplicate or malformed ModelIds are rejected before service access", async () => {
  const { calls, service } = harness();
  for (const ModelIds of [[STARTER_MODEL_ID, STARTER_MODEL_ID], ["bad id with spaces"], Array.from({length: 33}, (_, i) => `m${i}`)]) {
    await assert.rejects(
      () => reconcileBaselineModelPolicy(event("Create", {
        ResourceProperties: { ...event().ResourceProperties, ModelIds },
      }), { service }),
      (error) => error.code === "INVALID_BASELINE_MODEL_POLICY_SEED",
    );
  }
  assert.equal(calls.length, 0);
});
