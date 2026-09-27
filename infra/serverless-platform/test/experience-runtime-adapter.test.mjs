import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  createAgentRuntimeAdapter,
  DEFAULT_RUNTIME_TIMEOUT_MS,
} from "../lambda/experience/runtime-adapter.mjs";
import {
  createRuntimeInvocationProof,
} from "../lambda/agent-runtime/invocation-proof.mjs";

const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567";
const RUNTIME_AUDIENCE =
  `${RUNTIME_ARN}/runtime-endpoint/Production`;
const PROOF_SECRET =
  "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PROOF_NOW = Date.parse("2026-08-25T01:02:03.000Z");

function proofConfigProvider(overrides = {}) {
  return async () => ({
    hmacKey: PROOF_SECRET,
    previousHmacKey: null,
    allowedEndpointArn: RUNTIME_AUDIENCE,
    keyId: "runtime-proof-v1",
    ...overrides,
  });
}

function input(overrides = {}) {
  return {
    actor: "user-sub-123",
    requestId: "invoke-request-123",
    sessionId: "session-0123456789abcdef-abcdef0123456789",
    prompt: "Classify this customer request.",
    agent: {
      domainId: "customer_support",
      projectId: "case-assist",
      id: "triage-agent",
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
      status: "PRODUCTION_DEPLOYED",
    },
    deployment: {
      environment: "PRODUCTION",
      status: "DEPLOYED",
      runtimeStatus: "READY",
      runtimeArn: RUNTIME_ARN,
      endpointName: "Production",
      endpointArn: RUNTIME_AUDIENCE,
    },
    ...overrides,
  };
}

function responseBody(overrides = {}) {
  return {
    agentId: "triage-agent",
    sessionId: "session-0123456789abcdef-abcdef0123456789",
    output: "This is an account-access request.",
    upstreamRequestId: "gateway-request-123",
    usage: {
      inputTokens: 10,
      outputTokens: 7,
      totalTokens: 17,
    },
    ...overrides,
  };
}

function sdkResponse(overrides = {}) {
  const body = JSON.stringify(responseBody());
  return {
    statusCode: 200,
    contentType: "application/json; charset=utf-8",
    runtimeSessionId:
      "session-0123456789abcdef-abcdef0123456789",
    traceId: "1-66cc1234-0123456789abcdef01234567",
    response: {
      async transformToByteArray() {
        return Buffer.from(body);
      },
    },
    ...overrides,
  };
}

test("the default invocation timeout fits inside the hosted API window", () => {
  assert.equal(DEFAULT_RUNTIME_TIMEOUT_MS, 25_000);
});

test("adapter marks durable dispatch after proof preparation and fails closed if the marker fails", async () => {
  const calls = [];
  const adapter = createAgentRuntimeAdapter({
    proofConfigProvider: async () => {
      calls.push("proof");
      return proofConfigProvider()();
    },
    client: { async send() { calls.push("send"); return sdkResponse(); } },
  });
  await adapter.invoke(input({ onDispatch: async ({ region }) => {
    assert.equal(region, "us-west-2");
    calls.push("durable-start");
  } }));
  assert.deepEqual(calls, ["proof", "durable-start", "send"]);
  calls.length = 0;
  await assert.rejects(adapter.invoke(input({ onDispatch: async () => { throw new Error("journal unavailable"); } })));
  assert.deepEqual(calls, ["proof"]);
  let dispatched = false;
  const brokenProof = createAgentRuntimeAdapter({
    proofConfigProvider: async () => { throw new Error("proof unavailable"); },
    client: { async send() { throw new Error("must not dispatch"); } },
  });
  await assert.rejects(brokenProof.invoke(input({ onDispatch: async () => { dispatched = true; } })));
  assert.equal(dispatched, false);
});

test("adapter invokes only the authoritative production Runtime endpoint", async () => {
  const calls = [];
  const adapter = createAgentRuntimeAdapter({
    client: {
      async send(command, options) {
        calls.push({ command, options });
        return sdkResponse();
      },
    },
    timeoutMs: 5_000,
    maxTokens: 2_048,
    proofConfigProvider: proofConfigProvider(),
    proofClock: () => PROOF_NOW,
    proofNonce: () => Buffer.alloc(32, 4),
  });

  const result = await adapter.invoke(input());

  assert.deepEqual(result, {
    output: "This is an account-access request.",
    invocationId: "1-66cc1234-0123456789abcdef01234567",
    accounting: {
      version: 1,
      runId: createHash("sha256").update("user-sub-123\0invoke-request-123").digest("hex"),
      attemptId: "gateway-1",
      environment: "PRODUCTION",
      purpose: "user",
      modelId: input().agent.modelId,
      providerRequestId: "gateway-request-123",
      traceId: "1-66cc1234-0123456789abcdef01234567",
      usage: responseBody().usage,
      metering: null,
      execution: null,
      pricingVersion: null,
      estimatedCostUsd: null,
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].command instanceof InvokeAgentRuntimeCommand);
  assert.equal(calls[0].command.input.agentRuntimeArn, RUNTIME_ARN);
  assert.equal(calls[0].command.input.qualifier, "Production");
  assert.equal(
    calls[0].command.input.runtimeSessionId,
    "session-0123456789abcdef-abcdef0123456789",
  );
  assert.equal(calls[0].command.input.runtimeUserId, "user-sub-123");
  assert.equal(calls[0].command.input.contentType, "application/json");
  assert.equal(calls[0].command.input.accept, "application/json");
  assert.ok(calls[0].options.abortSignal instanceof AbortSignal);
  const runtimePayload = JSON.parse(
    Buffer.from(calls[0].command.input.payload).toString(),
  );
  const { proof: signature, ...signedPayload } = runtimePayload;
  assert.deepEqual(
    signedPayload,
    {
      agentConfig: {
        agentId: "triage-agent",
        modelId: "bedrock-claude/anthropic.claude-sonnet-5",
      },
      prompt: "Classify this customer request.",
      maxTokens: 2_048,
      session: {
        sessionId: "session-0123456789abcdef-abcdef0123456789",
        metadata: {
          actor: "user-sub-123",
          requestId: "invoke-request-123",
          domainId: "customer_support",
          projectId: "case-assist",
        },
      },
    },
  );
  assert.deepEqual(signature, {
    version: "v2",
    audience: RUNTIME_AUDIENCE,
    issuedAt: PROOF_NOW,
    expiresAt: PROOF_NOW + 60_000,
    nonce: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
    signature: signature.signature,
  });
  assert.equal(
    createRuntimeInvocationProof({
      secret: PROOF_SECRET,
      clock: () => PROOF_NOW,
    }).verify(
      signedPayload,
      signature,
      RUNTIME_AUDIENCE,
    ),
    true,
  );
});

test("adapter rejects non-production or non-ready deployment state before AWS", async () => {
  let sends = 0;
  const adapter = createAgentRuntimeAdapter({
    client: {
      async send() {
        sends += 1;
        return sdkResponse();
      },
    },
    proofConfigProvider: proofConfigProvider(),
  });

  for (const deployment of [
    { ...input().deployment, environment: "SANDBOX" },
    { ...input().deployment, status: "SUSPENDED" },
    { ...input().deployment, runtimeStatus: "FAILED" },
    { ...input().deployment, runtimeArn: "https://attacker.example" },
    { ...input().deployment, endpointName: "../other" },
    {
      ...input().deployment,
      endpointArn:
        `${RUNTIME_ARN}/runtime-endpoint/AttackerControlled`,
    },
  ]) {
    await assert.rejects(
      adapter.invoke(input({ deployment })),
      /invocation input is invalid/i,
    );
  }
  assert.equal(sends, 0);
});

test("adapter fails closed on malformed, oversized, or mismatched Runtime responses", async () => {
  const cases = [
    sdkResponse({ statusCode: 202 }),
    sdkResponse({ contentType: "text/plain" }),
    sdkResponse({ runtimeSessionId: "session-other" }),
    sdkResponse({ response: undefined }),
    sdkResponse({
      response: {
        async transformToByteArray() {
          return Buffer.from("{");
        },
      },
    }),
    sdkResponse({
      response: {
        async transformToByteArray() {
          return Buffer.from(JSON.stringify(
            responseBody({ output: "x".repeat(65 * 1024) }),
          ));
        },
      },
    }),
    sdkResponse({
      response: {
        async transformToByteArray() {
          return Buffer.from(JSON.stringify(
            responseBody({ sessionId: "session-other" }),
          ));
        },
      },
    }),
  ];

  for (const response of cases) {
    const adapter = createAgentRuntimeAdapter({
      client: { async send() { return response; } },
      proofConfigProvider: proofConfigProvider(),
    });
    await assert.rejects(
      adapter.invoke(input()),
      /Runtime response is invalid/i,
    );
  }
});

test("adapter enforces timeout cancellation and sanitizes SDK failures", async () => {
  let aborted = false;
  const adapter = createAgentRuntimeAdapter({
    client: {
      async send(_command, { abortSignal }) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          abortSignal.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error("secret SDK detail"));
          });
        });
        return sdkResponse();
      },
    },
    timeoutMs: 10,
    proofConfigProvider: proofConfigProvider(),
  });

  await assert.rejects(
    adapter.invoke(input()),
    (error) => {
      assert.equal(error.message, "Agent Runtime invocation failed.");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
  assert.equal(aborted, true);
});

test("adapter rejects missing proof configuration and mismatched authorization", async () => {
  const client = { async send() { return sdkResponse(); } };
  for (const proofConfigProviderValue of [
    undefined,
    "",
  ]) {
    assert.throws(
      () => createAgentRuntimeAdapter({
        client,
        proofConfigProvider: proofConfigProviderValue,
      }),
      (error) => (
        /adapter configuration is invalid|adapter configuration/i.test(
          error.message,
        )
      ),
    );
  }
  for (const configuration of [
    { hmacKey: "too-short" },
    {
      allowedEndpointArn:
        `${RUNTIME_ARN}/runtime-endpoint/Other`,
    },
  ]) {
    const adapter = createAgentRuntimeAdapter({
      client,
      proofConfigProvider: proofConfigProvider(configuration),
    });
    await assert.rejects(
      adapter.invoke(input()),
      (error) => (
        error.message === "Agent Runtime invocation failed."
        && !String(error).includes("too-short")
      ),
    );
  }
});

test("adapter retains usage and separates run, provider request and native trace IDs", async () => {
  const adapter = createAgentRuntimeAdapter({
    client: { async send() { return sdkResponse({ traceId: undefined }); } },
    proofConfigProvider: proofConfigProvider(),
  });
  const result = await adapter.invoke(input());
  assert.equal(result.accounting?.providerRequestId, "gateway-request-123");
  assert.equal(result.accounting?.traceId, null);
  assert.equal(result.accounting?.usage.inputTokens, 10);
  assert.equal(result.accounting?.pricingVersion, null);
});
