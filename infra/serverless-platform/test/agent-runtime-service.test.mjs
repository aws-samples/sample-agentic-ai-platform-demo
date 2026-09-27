import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRuntimeError,
  createAgentRuntimeService,
} from "../lambda/agent-runtime/service.mjs";
import {
  createRuntimeInvocationProof,
} from "../lambda/agent-runtime/invocation-proof.mjs";

const PROOF_SECRET =
  "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NEXT_PROOF_SECRET =
  "next-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RUNTIME_AUDIENCE =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567/"
  + "runtime-endpoint/Production";
const PROOF_NOW = Date.parse("2026-08-25T01:02:03.000Z");
let proofNonce = 0;

function runtimeProofDependencies({
  configuration = {},
  proofReplayLedger,
} = {}) {
  const consumed = new Set();
  return {
    proofConfigProvider: async () => ({
      hmacKey: PROOF_SECRET,
      previousHmacKey: null,
      allowedEndpointArn: RUNTIME_AUDIENCE,
      keyId: "runtime-proof-v1",
      ...configuration,
    }),
    proofReplayLedger: proofReplayLedger ?? {
      async consume({ audience, nonce }) {
        const key = `${audience}\0${nonce}`;
        if (consumed.has(key)) return false;
        consumed.add(key);
        return true;
      },
    },
  };
}

function requestPayload(overrides = {}) {
  return {
    agentConfig: {
      agentId: "triage-agent",
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
      instructions: "Classify the request and explain the result.",
    },
    prompt: "A customer cannot access their account.",
    maxTokens: 256,
    session: {
      sessionId: "session-20260825-01",
      metadata: {
        channel: "web",
        locale: "en-NZ",
        actor: "user-sub-123",
        requestId: "invoke-request-123",
        domainId: "customer_support",
        projectId: "case-assist",
      },
    },
    ...overrides,
  };
}

function validRequest(overrides = {}) {
  return requestSignedWith(PROOF_SECRET, overrides);
}

function requestSignedWith(secret, overrides = {}) {
  const request = requestPayload(overrides);
  return {
    ...request,
    proof: createRuntimeInvocationProof({
      secret,
      clock: () => PROOF_NOW,
      nonce: () => Buffer.alloc(32, proofNonce += 1),
    }).sign(request, RUNTIME_AUDIENCE),
  };
}

function serviceHarness(result = {
  output: "This is an account-access request.",
  requestId: "gateway-request-01",
  usage: {
    inputTokens: 23,
    outputTokens: 8,
    totalTokens: 31,
  },
}) {
  const calls = [];
  const metricCalls = [];
  let now = PROOF_NOW;
  return {
    calls,
    metricCalls,
    service: createAgentRuntimeService({
      gateway: {
        async invoke(input) {
          calls.push(structuredClone(input));
          return result;
        },
      },
      metrics: {
        recordInvocation(input) {
          metricCalls.push(structuredClone(input));
        },
      },
      clock() {
        const value = now;
        now += 125;
        return value;
      },
      ...runtimeProofDependencies(),
    }),
  };
}

test("invokes the configured Gateway and records scoped successful usage", async () => {
  const { calls, metricCalls, service } = serviceHarness();

  const result = await service.invoke(validRequest());

  assert.deepEqual(calls, [{
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    prompt:
      "Agent instructions:\n"
      + "Classify the request and explain the result.\n\n"
      + "User request:\n"
      + "A customer cannot access their account.",
    maxTokens: 256,
    sourceIdentity: "domain_customer_support",
  }]);
  assert.deepEqual(result, {
    agentId: "triage-agent",
    sessionId: "session-20260825-01",
    output: "This is an account-access request.",
    upstreamRequestId: "gateway-request-01",
    execution: {
      startedAt: "2026-08-25T01:02:03.125Z",
      completedAt: "2026-08-25T01:02:03.250Z",
    },
    usage: {
      inputTokens: 23,
      outputTokens: 8,
      totalTokens: 31,
    },
  });
  assert.deepEqual(metricCalls, [{
    domainId: "customer_support",
    projectId: "case-assist",
    succeeded: true,
    latencyMs: 125,
    inputTokens: 23,
    outputTokens: 8,
  }]);
});

test("requires authoritative canonical domain and project scope", async () => {
  const { calls, metricCalls, service } = serviceHarness();
  const invalidRequests = [
    {
      agentConfig: {
        agentId: "plain-agent",
        modelId: "provider/model",
      },
      prompt: "Reply briefly.",
      maxTokens: 16,
    },
    validRequest({
      session: {
        sessionId: "session-1",
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: {
          projectId: "case-assist",
        },
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: {
          domainId: "Customer_Support",
          projectId: "case-assist",
        },
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: {
          domainId: "a",
          projectId: "case-assist",
        },
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: {
          domainId: "a".repeat(65),
          projectId: "case-assist",
        },
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: {
          domainId: "customer_support",
          projectId: "Not A Slug",
        },
      },
    }),
  ];

  for (const request of invalidRequests) {
    await assert.rejects(
      service.invoke(request),
      (error) => (
        error instanceof AgentRuntimeError
        && error.code === "INVALID_REQUEST"
      ),
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(metricCalls, []);
});

test("rejects missing, malformed, or forged invocation proofs before trust", async () => {
  const { calls, metricCalls, service } = serviceHarness();
  const signed = validRequest();
  const forgedRequests = [
    requestPayload(),
    { ...requestPayload(), proof: "v1.invalid" },
    { ...signed, prompt: "A changed prompt." },
    {
      ...signed,
      agentConfig: {
        ...signed.agentConfig,
        agentId: "other-agent",
      },
    },
    {
      ...signed,
      agentConfig: {
        ...signed.agentConfig,
        modelId: "provider/other-model",
      },
    },
    {
      ...signed,
      session: {
        ...signed.session,
        sessionId: "session-other",
      },
    },
    {
      ...signed,
      session: {
        ...signed.session,
        metadata: {
          ...signed.session.metadata,
          actor: "other-sub",
        },
      },
    },
    {
      ...signed,
      session: {
        ...signed.session,
        metadata: {
          ...signed.session.metadata,
          requestId: "other-request",
        },
      },
    },
    {
      ...signed,
      session: {
        ...signed.session,
        metadata: {
          ...signed.session.metadata,
          domainId: "operations",
        },
      },
    },
    {
      ...signed,
      session: {
        ...signed.session,
        metadata: {
          ...signed.session.metadata,
          projectId: "foreign-project",
        },
      },
    },
  ];

  for (const request of forgedRequests) {
    await assert.rejects(
      service.invoke(request),
      (error) => (
        error instanceof AgentRuntimeError
        && error.code === "INVALID_REQUEST"
        && error.statusCode === 400
        && !String(error).includes(PROOF_SECRET)
      ),
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(metricCalls, []);
});

test("rejects immediate replay before a second Gateway invocation", async () => {
  const { calls, metricCalls, service } = serviceHarness();
  const request = validRequest();

  await service.invoke(request);
  await assert.rejects(
    service.invoke(request),
    (error) => (
      error instanceof AgentRuntimeError
      && error.code === "INVALID_REQUEST"
      && error.statusCode === 400
    ),
  );

  assert.equal(calls.length, 1);
  assert.equal(metricCalls.length, 1);
});

test("rejects replay across independent Runtime services sharing the ledger", async () => {
  const consumed = new Set();
  const proofReplayLedger = {
    async consume({ audience, nonce }) {
      const key = `${audience}\0${nonce}`;
      if (consumed.has(key)) return false;
      consumed.add(key);
      return true;
    },
  };
  const request = validRequest();
  const dependencies = runtimeProofDependencies({ proofReplayLedger });
  const serviceFor = () => createAgentRuntimeService({
    gateway: {
      async invoke() {
        return {
          output: "ok",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        };
      },
    },
    metrics: { recordInvocation() {} },
    clock: () => PROOF_NOW,
    ...dependencies,
  });

  await serviceFor().invoke(request);
  await assert.rejects(
    serviceFor().invoke(request),
    (error) => (
      error instanceof AgentRuntimeError
      && error.code === "INVALID_REQUEST"
    ),
  );
});

test("rejects unknown keys before invoking the Gateway", async () => {
  const { calls, service } = serviceHarness();
  const invalidRequests = [
    validRequest({ url: "https://attacker.example" }),
    validRequest({ credentials: { accessKeyId: "attacker" } }),
    validRequest({
      agentConfig: {
        agentId: "triage-agent",
        modelId: "provider/model",
        gatewayUrl: "https://attacker.example",
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: {},
        headers: { authorization: "Bearer attacker" },
      },
    }),
  ];

  for (const request of invalidRequests) {
    await assert.rejects(
      service.invoke(request),
      (error) => (
        error instanceof AgentRuntimeError
        && error.code === "INVALID_REQUEST"
        && error.statusCode === 400
      ),
    );
  }
  assert.equal(calls.length, 0);
});

test("rejects malformed, accessor-backed, and out-of-bounds input", async () => {
  const { calls, service } = serviceHarness();
  const accessor = {
    agentConfig: {
      agentId: "triage-agent",
      modelId: "provider/model",
    },
    maxTokens: 16,
    proof: `v1.${"a".repeat(43)}`,
    get prompt() {
      throw new Error("secret accessor executed");
    },
  };
  const invalidRequests = [
    null,
    [],
    accessor,
    validRequest({ prompt: "" }),
    {
      ...requestPayload({ prompt: "x".repeat(16_385) }),
      proof: `v1.${"a".repeat(43)}`,
    },
    validRequest({ maxTokens: 0 }),
    validRequest({ maxTokens: 8_193 }),
    validRequest({
      agentConfig: {
        agentId: "Not A Slug",
        modelId: "provider/model",
      },
    }),
    validRequest({
      agentConfig: {
        agentId: "triage-agent",
        modelId: "https://attacker.example/model",
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`key${index}`, "value"]),
        ),
      },
    }),
    validRequest({
      session: {
        sessionId: "session-1",
        metadata: { locale: { nested: "not allowed" } },
      },
    }),
  ];
  const hiddenDomain = validRequest();
  Object.defineProperty(hiddenDomain.session.metadata, "hidden", {
    value: "attacker",
  });
  invalidRequests.push(hiddenDomain);
  const symbolMetadata = validRequest();
  symbolMetadata.session.metadata[Symbol("sourceIdentity")] =
    "operations";
  invalidRequests.push(symbolMetadata);

  for (const request of invalidRequests) {
    await assert.rejects(
      service.invoke(request),
      (error) => (
        error instanceof AgentRuntimeError
        && error.code === "INVALID_REQUEST"
        && !String(error).includes("secret accessor")
      ),
    );
  }
  assert.equal(calls.length, 0);
});

test("rejects malformed or oversized Gateway results with a bounded error", async () => {
  const accessorResult = {
    requestId: "gateway-request",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
    get output() {
      throw new Error("secret Gateway accessor executed");
    },
  };
  const results = [
    {
      output: "x".repeat(128 * 1024 + 1),
      requestId: "gateway-request",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    },
    {
      output: "ok",
      requestId: "invalid request id with spaces",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
    },
    {
      output: "ok",
      requestId: "gateway-request",
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 2,
      },
    },
    {
      output: "ok",
      requestId: "gateway-request",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      },
      credentials: "unexpected",
    },
    accessorResult,
  ];

  for (const result of results) {
    const { service } = serviceHarness(result);
    await assert.rejects(
      service.invoke(validRequest()),
      (error) => (
        error instanceof AgentRuntimeError
        && error.code === "INVALID_GATEWAY_RESPONSE"
        && error.statusCode === 502
        && error.message.length < 128
        && !String(error).includes("secret Gateway accessor")
      ),
    );
  }
});

test("maps Gateway failures to a sanitized runtime error", async () => {
  const metricCalls = [];
  let now = PROOF_NOW;
  const service = createAgentRuntimeService({
    gateway: {
      async invoke() {
        const error = new Error("credential and upstream details");
        error.code = "GATEWAY_TIMEOUT";
        error.statusCode = 504;
        error.retryable = true;
        throw error;
      },
    },
    metrics: {
      recordInvocation(input) {
        metricCalls.push(structuredClone(input));
      },
    },
    clock() {
      const value = now;
      now += 750;
      return value;
    },
    ...runtimeProofDependencies(),
  });

  await assert.rejects(
    service.invoke(validRequest()),
    (error) => (
      error instanceof AgentRuntimeError
      && error.code === "GATEWAY_UNAVAILABLE"
      && error.statusCode === 504
      && error.retryable === true
      && !String(error).includes("credential")
    ),
  );
  assert.deepEqual(metricCalls, [{
    domainId: "customer_support",
    projectId: "case-assist",
    succeeded: false,
    latencyMs: 750,
    inputTokens: null,
    outputTokens: null,
  }]);
});

test("metrics failures never alter or disclose the invocation result", async () => {
  const service = createAgentRuntimeService({
    gateway: {
      async invoke() {
        return {
          output: "ok",
          requestId: "gateway-request",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        };
      },
    },
    metrics: {
      recordInvocation() {
        throw new Error("secret metrics transport detail");
      },
    },
    clock: () => PROOF_NOW,
    ...runtimeProofDependencies(),
  });

  assert.deepEqual(await service.invoke(validRequest()), {
    agentId: "triage-agent",
    sessionId: "session-20260825-01",
    output: "ok",
    upstreamRequestId: "gateway-request",
    execution: {
      startedAt: new Date(PROOF_NOW).toISOString(),
      completedAt: new Date(PROOF_NOW).toISOString(),
    },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  });
});

test("passes the caller abort signal with the authoritative source identity", async () => {
  const calls = [];
  const controller = new AbortController();
  const service = createAgentRuntimeService({
    gateway: {
      async invoke(input) {
        calls.push(input);
        return {
          output: "ok",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        };
      },
    },
    metrics: {
      recordInvocation() {},
    },
    clock: () => PROOF_NOW,
    ...runtimeProofDependencies(),
  });

  await service.invoke(validRequest(), {
    abortSignal: controller.signal,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceIdentity, "domain_customer_support");
  assert.equal(calls[0].abortSignal, controller.signal);
});

test("accepts old and new signers throughout a two-phase key rotation", async () => {
  async function invokeWith(configuration, secret) {
    const service = createAgentRuntimeService({
      gateway: {
        async invoke() {
          return {
            output: "ok",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
          };
        },
      },
      metrics: { recordInvocation() {} },
      clock: () => PROOF_NOW,
      ...runtimeProofDependencies({ configuration }),
    });
    return service.invoke(requestSignedWith(secret));
  }

  const phaseOne = {
    hmacKey: PROOF_SECRET,
    previousHmacKey: NEXT_PROOF_SECRET,
    keyId: "runtime-proof-rotation-stage",
  };
  const phaseTwo = {
    hmacKey: NEXT_PROOF_SECRET,
    previousHmacKey: PROOF_SECRET,
    keyId: "runtime-proof-v2",
  };

  for (const configuration of [phaseOne, phaseTwo]) {
    for (const secret of [PROOF_SECRET, NEXT_PROOF_SECRET]) {
      assert.equal(
        (await invokeWith(configuration, secret)).output,
        "ok",
      );
    }
  }
});

test("rejects invalid dependencies and fails closed on bad proof configuration", async () => {
  const gateway = { async invoke() {} };
  assert.throws(
    () => createAgentRuntimeService({ gateway, metrics: {} }),
    /service configuration is invalid/i,
  );
  assert.throws(
    () => createAgentRuntimeService({
      gateway,
      metrics: { recordInvocation() {} },
      clock: "now",
      ...runtimeProofDependencies(),
    }),
    /service configuration is invalid/i,
  );
  assert.throws(
    () => createAgentRuntimeService({
      gateway,
      metrics: { recordInvocation() {} },
      clock: () => PROOF_NOW,
      proofConfigProvider: "not-a-provider",
      proofReplayLedger: { async consume() { return true; } },
    }),
    /service configuration is invalid/i,
  );
  assert.throws(
    () => createAgentRuntimeService({
      gateway,
      metrics: { recordInvocation() {} },
      clock: () => PROOF_NOW,
      proofConfigProvider: async () => ({}),
      proofReplayLedger: {},
    }),
    /service configuration is invalid/i,
  );
  const service = createAgentRuntimeService({
    gateway,
    metrics: { recordInvocation() {} },
    clock: () => PROOF_NOW,
    ...runtimeProofDependencies({
      configuration: { hmacKey: "too-short" },
    }),
  });
  await assert.rejects(
    service.invoke(validRequest()),
    (error) => (
      error instanceof AgentRuntimeError
      && error.code === "RUNTIME_PROOF_UNAVAILABLE"
      && error.statusCode === 503
      && error.retryable === true
      && !String(error).includes("too-short")
    ),
  );
});
