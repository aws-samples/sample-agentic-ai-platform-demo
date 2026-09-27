import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { createExperienceInvocationStore } from "../lambda/experience/invocation-store.mjs";
import { createAgentRuntimeAdapter } from "../lambda/experience/runtime-adapter.mjs";
import { createAgentRuntimeService } from "../lambda/agent-runtime/service.mjs";
import { createAgentRuntimeMetrics } from "../lambda/agent-runtime/metrics.mjs";
import { AgentCoreGatewayClient } from "../lambda/workspace/gateway.mjs";
import { gatewayMetering } from "../lambda/agent-runtime/usage.mjs";

const NOW = new Date("2026-09-11T00:00:00.000Z");
const runtimeArn = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/TestRuntime-ABC1234567";
const endpointArn = `${runtimeArn}/runtime-endpoint/Production`;
const proofConfigProvider = async () => ({
  hmacKey: "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  previousHmacKey: null, allowedEndpointArn: endpointArn, keyId: "test-key",
});
const binding = requestId => ({
  actor: "test-user", requestId, payloadFingerprint: createHash("sha256").update(requestId).digest("hex"),
  sessionId: "session-0123456789abcdef-abcdef0123456789",
  domainId: "customer_support", projectId: "case-assist", agentId: "test-agent",
  baselineFingerprint: null,
});

function journalHarness() {
  const items = new Map();
  let writes = 0;
  const conflict = () => { const error = new Error("conditional"); error.name = "ConditionalCheckFailedException"; throw error; };
  const store = createExperienceInvocationStore({
    compatibility: { writerVersion: "cost-v1", readerVersion: "cost-v1" },
    tableName: "PlatformState", now: () => NOW,
    dynamo: {
      async send(command) {
        const input = command.input;
        const key = (input.Key ?? input.Item).sk.S;
        if (command instanceof GetItemCommand) return { Item: items.get(key) };
        if (command instanceof PutItemCommand) {
          if (items.has(key)) conflict();
          assert.match(input.ConditionExpression, /attribute_not_exists/);
          items.set(key, structuredClone(input.Item));
          return {};
        }
        assert.ok(command instanceof UpdateItemCommand);
        assert.match(input.ConditionExpression, /#phase = :started/);
        const item = items.get(key);
        if (item.phase.S !== "STARTED") conflict();
        for (const assignment of input.UpdateExpression.replace(/^SET /, "").split(", ")) {
          const [name, value] = assignment.split(" = ");
          item[input.ExpressionAttributeNames[name]] = structuredClone(input.ExpressionAttributeValues[value]);
        }
        writes += 1;
        return { Attributes: structuredClone(item) };
      },
    },
  });
  return { store, items, writes: () => writes };
}

test("provider usage survives Gateway, Runtime, adapter and conditional journal replay", async () => {
  const logs = [];
  let providerCalls = 0;
  const gateway = new AgentCoreGatewayClient({
    gatewayBaseUrl: "https://test-gateway-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1",
    region: "us-west-2", clock: () => NOW, logger: { error() {} },
    credentialsProvider: async () => ({
      accessKeyId: "AKIAEXAMPLE", secretAccessKey: "unit-test-secret", sessionToken: "unit-test-session",
    }),
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({
        model: "claude-test",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 16 } },
      }), { status: 200, headers: { "x-amzn-requestid": `provider-${providerCalls}` } });
    },
  });
  const nonces = new Set();
  const runtime = createAgentRuntimeService({
    gateway, clock: () => NOW.getTime(), proofConfigProvider,
    proofReplayLedger: { async consume({ nonce }) {
      if (nonces.has(nonce)) return false;
      nonces.add(nonce); return true;
    } },
    metrics: createAgentRuntimeMetrics({ write: line => logs.push(JSON.parse(line)), clock: () => NOW }),
  });
  const adapter = createAgentRuntimeAdapter({
    proofConfigProvider, proofClock: () => NOW.getTime(),
    client: { async send(command) {
      const payload = JSON.parse(Buffer.from(command.input.payload).toString());
      const result = await runtime.invoke(payload);
      return {
        statusCode: 200, contentType: "application/json", runtimeSessionId: payload.session.sessionId,
        response: { async transformToByteArray() { return Buffer.from(JSON.stringify(result)); } },
      };
    } },
  });
  const { store, items, writes } = journalHarness();
  async function invoke(requestId) {
    const input = binding(requestId);
    await store.start(input);
    const result = await adapter.invoke({
      actor: input.actor, requestId, sessionId: input.sessionId, prompt: "Synthetic test.",
      agent: { id: input.agentId, domainId: input.domainId, projectId: input.projectId,
        modelId: "anthropic.claude-test", status: "PRODUCTION_DEPLOYED" },
      deployment: { environment: "PRODUCTION", status: "DEPLOYED", runtimeStatus: "READY",
        runtimeArn, endpointName: "Production", endpointArn },
      onDispatch: ({ region }) => store.markDispatched({ ...input, region }),
    });
    const complete = { ...input, runtimeStatus: "SUCCEEDED", ...result };
    const stored = await store.complete(complete);
    assert.deepEqual(await store.complete(complete), stored);
    return stored;
  }
  const first = await invoke("request-1");
  assert.equal(writes(), 2);
  assert.equal(first.lifecycle.startedAt, NOW.toISOString());
  assert.equal(first.lifecycle.region, "us-west-2");
  assert.equal(first.accounting.usage.inputTokens, 5);
  assert.equal(first.accounting.metering.cacheWrite1hInputTokens, 16);
  assert.equal(first.accounting.metering.modelId, "claude-test");
  assert.equal(first.accounting.modelId, "anthropic.claude-test");
  assert.equal(first.accounting.traceId, null);
  assert.equal(first.accounting.providerRequestId, "provider-1");
  assert.equal(first.accounting.execution.startedAt, NOW.toISOString());
  assert.equal(first.accounting.estimatedCostUsd, null);
  const second = await invoke("request-2");
  assert.notEqual(first.accounting.runId, second.accounting.runId);
  assert.equal(providerCalls, 2);
  assert.equal(writes(), 4);
  assert.equal(items.size, 2);
  assert.equal(logs.length, 6);
  await assert.rejects(store.complete({
    ...binding("request-1"), runtimeStatus: "SUCCEEDED", output: "ok",
    invocationId: "provider-1",
    accounting: { ...first.accounting, usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 } },
  }), /conflict/);
});

test("unknown cache fields are preserved and inconsistent cache counters rejected", () => {
  const result = gatewayMetering({ usage: { prompt_tokens: 12 } }, "openai");
  assert.equal(result.cacheReadInputTokens, null);
  assert.equal(result.modelId, null);
  const partial = gatewayMetering({
    usage: { cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } },
  }, "anthropic");
  assert.equal(partial.cacheWriteInputTokens, null);
  assert.equal(partial.cacheWrite1hInputTokens, 2);
  assert.throws(() => gatewayMetering({
    usage: { prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } },
  }, "openai"), /invalid/);
  assert.throws(() => gatewayMetering({
    usage: { cache_creation_input_tokens: 2,
      cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } },
  }, "anthropic"), /invalid/);
});

test("failed executions emit invocation/error counts without zero-token observations", () => {
  const logs = [];
  const metrics = createAgentRuntimeMetrics({ write: value => logs.push(JSON.parse(value)), clock: () => NOW });
  metrics.recordInvocation({
    domainId: "customer_support", projectId: "case-assist", succeeded: false,
    latencyMs: 20, inputTokens: null, outputTokens: null,
  });
  for (const row of logs) {
    assert.equal(row.InvocationCount, 1);
    assert.equal(row.ErrorCount, 1);
    assert.equal(Object.hasOwn(row, "InputTokens"), false);
    assert.equal(row._aws.CloudWatchMetrics[0].Metrics.some(metric => metric.Name === "InputTokens"), false);
  }
});
