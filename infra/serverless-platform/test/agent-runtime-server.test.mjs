import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeInvocationProof,
} from "../lambda/agent-runtime/invocation-proof.mjs";
import {
  createConfiguredAgentRuntime,
  resolveRuntimePort,
  startAgentRuntime,
} from "../lambda/agent-runtime/server.mjs";

const MODEL_ID = "bedrock-claude/anthropic.claude-haiku-4-5";
const runtimeEnv = () => ({
  AWS_REGION: "us-west-2", MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1",
  BEDROCK_RUNTIME_REGION: "us-west-2",
  BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{ modelId: MODEL_ID, domains: ["platform", "customer_support"] }]),
});
const providerResponse = () => new Response(JSON.stringify({
  output: { message: { role: "assistant", content: [{ text: "ok" }] } },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  stopReason: "end_turn", metrics: { latencyMs: 1 },
}), { headers: { "x-amzn-requestid": "synthetic-request" } });
const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567";
const RUNTIME_AUDIENCE =
  `${RUNTIME_ARN}/runtime-endpoint/Production`;
const PROOF_SECRET =
  "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const PROOF_NOW = Date.parse("2026-08-25T01:02:03.000Z");

function proofDependencies() {
  const consumed = new Set();
  return {
    proofConfigProvider: async () => ({
      hmacKey: PROOF_SECRET,
      previousHmacKey: null,
      allowedEndpointArn: RUNTIME_AUDIENCE,
      keyId: "runtime-proof-v1",
    }),
    proofReplayLedger: {
      async consume({ audience, nonce }) {
        const key = `${audience}\0${nonce}`;
        if (consumed.has(key)) return false;
        consumed.add(key);
        return true;
      },
    },
  };
}

function invocation({
  domainId = "platform",
  projectId = "portable-agent",
} = {}) {
  const payload = {
    agentConfig: {
      agentId: "portable-agent",
      modelId: MODEL_ID,
    },
    prompt: "Reply.",
    maxTokens: 8,
    session: {
      sessionId: "session-1",
      metadata: {
        actor: "user-sub-123",
        requestId: "invoke-request-123",
        domainId,
        projectId,
      },
    },
  };
  return {
    ...payload,
    proof: createRuntimeInvocationProof({
      secret: PROOF_SECRET,
      clock: () => PROOF_NOW,
    }).sign(payload, RUNTIME_AUDIENCE),
  };
}

test("configured runtime fixes the Runtime endpoint and uses execution-role credentials without Gateway STS", async () => {
  let requestedUrl;
  const credentialCalls = [];
  const runtime = createConfiguredAgentRuntime({
    env: { ...runtimeEnv(), LLM_GATEWAY_URL: "https://forbidden.invalid", AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://forbidden.invalid" },
    credentialsProvider: async input => {
      credentialCalls.push(input);
      return { accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-secret" };
    },
    fetchImpl: async url => { requestedUrl = url; return providerResponse(); },
    stsClientFactory() { assert.fail("Direct inference must not assume the Gateway role"); },
    clock: () => new Date(PROOF_NOW), metricWriter() {}, ...proofDependencies(),
  });
  const result = await runtime.service.invoke(invocation());
  assert.equal(requestedUrl, "https://bedrock-runtime.us-west-2.amazonaws.com/model/global.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse");
  assert.equal(credentialCalls.length, 1);
  assert.ok(credentialCalls[0].abortSignal instanceof AbortSignal);
  assert.equal(result.upstreamRequestId, "synthetic-request");
});

test("configured runtime uses the Runtime execution role and preserves proof/domain validation", async () => {
  let authorization;
  const runtime = createConfiguredAgentRuntime({
    env: { ...runtimeEnv(), AWS_ACCESS_KEY_ID: "AKIASYNTHETIC", AWS_SECRET_ACCESS_KEY: "synthetic-secret", AWS_SESSION_TOKEN: "synthetic-token" },
    fetchImpl: async (_url, input) => { authorization = input.headers.authorization; return providerResponse(); },
    clock: () => new Date(PROOF_NOW), metricWriter() {}, ...proofDependencies(),
  });
  await runtime.service.invoke(invocation({ domainId: "customer_support", projectId: "case-assist" }));
  assert.match(authorization, /Credential=AKIASYNTHETIC\//);
});

test("configured runtime rejects absent Runtime routing instead of falling back to Gateway", () => {
  for (const env of [{}, { LLM_GATEWAY_REGION: "us-west-2", LLM_GATEWAY_URL: "https://legacy.invalid" },
    { ...runtimeEnv(), BEDROCK_RUNTIME_MODELS_JSON: "[]" },
    { ...runtimeEnv(), MODEL_INFERENCE_ROUTE: "mantle" }]) {
    assert.throws(() => createConfiguredAgentRuntime({ env, credentialsProvider: async () => ({}), ...proofDependencies() }), /Bedrock Runtime configuration is invalid/);
  }
});

test("native Runtime refuses Gateway route attestation and missing upgraded-reader attestation before binding", async () => {
  for (const extra of [{}, { RUNTIME_CONVERSE_READER_VERSION: "converse-v1" },
    { RUNTIME_CONVERSE_READER_VERSION: "converse-v2", RUNTIME_USAGE_ROUTE_JSON: JSON.stringify({ gatewayRegion: "us-west-2" }) }]) {
    await assert.rejects(startAgentRuntime({
      env: { ...runtimeEnv(), RUNTIME_NATIVE_EXECUTION_VERSION: "native-v1", ...extra },
      ...proofDependencies(), createServerImpl() { assert.fail("must fail before binding"); },
    }), /upgraded reader attestation|Gateway usage route/);
  }
});

test("runtime port defaults to 8080 and accepts a bounded PORT override", () => {
  assert.equal(resolveRuntimePort({}), 8080);
  assert.equal(resolveRuntimePort({ PORT: "9000" }), 9000);
  for (const PORT of ["0", "65536", "8080 ", "8.5", "http"]) {
    assert.throws(
      () => resolveRuntimePort({ PORT }),
      /PORT must be an integer between 1 and 65535/,
    );
  }
});

test("startAgentRuntime binds before any proof configuration lookup", async () => {
  const listenCalls = [];
  let secretCalls = 0;
  let receivedHandler;
  const server = {
    listen(...args) {
      listenCalls.push(args);
      return this;
    },
  };

  const result = await startAgentRuntime({
    env: {
      ...runtimeEnv(),
      PORT: "9000",
      PLATFORM_STATE_TABLE_NAME: "PlatformState",
      RUNTIME_INVOCATION_PROOF_SECRET_ARN:
        "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:runtime-proof-AbCdEf",
    },
    credentialsProvider: async () => ({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "test-secret",
    }),
    createServerImpl(handler) {
      receivedHandler = handler;
      return server;
    },
    metricWriter() {},
    async proofConfigProvider() {
      secretCalls += 1;
      return proofDependencies().proofConfigProvider();
    },
    proofReplayLedger: proofDependencies().proofReplayLedger,
  });

  assert.equal(typeof receivedHandler, "function");
  assert.equal(result, server);
  assert.equal(secretCalls, 0);
  assert.deepEqual(listenCalls, [[9000, "0.0.0.0"]]);
});

test("configured runtime rejects missing proof authorization dependencies", () => {
  for (const invalid of [
    {},
    { proofConfigProvider: async () => ({}) },
    { proofReplayLedger: { async consume() { return true; } } },
  ]) {
    assert.throws(
      () => createConfiguredAgentRuntime({
        env: {
          ...runtimeEnv(),
        },
        credentialsProvider: async () => ({
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "test-secret",
        }),
        ...invalid,
      }),
      /runtime service configuration is invalid/i,
    );
  }
});
