import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { createAgentRuntimeService } from "../lambda/agent-runtime/service.mjs";
import { createRuntimeInvocationProof } from "../lambda/agent-runtime/invocation-proof.mjs";
import { isDeepStrictEqual } from "node:util";
import { createExecutionWriter, createNativeExecutionJournal, nativeExecutionEnabled } from "../lambda/agent-runtime/execution-journal.mjs";
import { createExperienceInvocationStore } from "../lambda/experience/invocation-store.mjs";
import { createAgentRuntimeAdapter } from "../lambda/experience/runtime-adapter.mjs";
import { AgentCoreGatewayClient } from "../lambda/workspace/gateway.mjs";
import { createConfiguredBedrockInference } from "../lambda/agent-runtime/bedrock-inference.mjs";
import { createJournalUsageProvider } from "../lambda/operations/journal-usage.mjs";
import { createModelPriceBook } from "../lambda/operations/model-prices.mjs";
import { createOperationsService } from "../lambda/operations/service.mjs";
import { createOperationsRuntime } from "../lambda/operations/handler-runtime.mjs";
import { costSummary, hostedCostHtml } from "../../../console/public/cost-view.mjs";

const NOW = "2026-09-10T12:00:00.000Z";
const secret = "synthetic-native-proof-secret-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const audience = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/TestRuntime-123/runtime-endpoint/Production";
const hash = value => createHash("sha256").update(value).digest("hex");
const payload = () => ({
  agentConfig: { agentId: "triage", modelId: "test-route/test-model" },
  prompt: "Synthetic request", maxTokens: 32,
  session: { sessionId: "session-0123456789abcdef-abcdef0123456789",
    metadata: { actor: "test-user", requestId: "one", domainId: "support", projectId: "case-assist" } },
  accounting: { version: 1, runId: hash("test-user\0one"), payloadFingerprint: hash("request"),
    attemptId: "gateway-1", environment: "PRODUCTION", purpose: "user" },
});
const sign = (value, nonce = 1) => ({ ...value, proof: createRuntimeInvocationProof({
  secret, clock: () => Date.parse(NOW), nonce: () => Buffer.alloc(32, nonce),
}).sign(value, audience) });
function serviceHarness({ startFailure = false, gatewayFailure = false } = {}) {
  const calls = [];
  const consumed = new Set();
  const service = createAgentRuntimeService({
    clock: () => Date.parse(NOW), metrics: { recordInvocation() {} },
    proofConfigProvider: async () => ({
      hmacKey: secret, previousHmacKey: null, allowedEndpointArn: audience, keyId: "test-v1",
    }),
    proofReplayLedger: { async consume({ nonce }) {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce);
      calls.push("nonce");
      return true;
    } },
    executionWriter: {
      async start() { calls.push("start"); if (startFailure) throw new Error("durability"); },
      async recordUsage() { calls.push("usage"); },
      async finish(_request, value) { calls.push(value.status); },
    },
    gateway: { async invoke(input) {
      calls.push("gateway");
      if (gatewayFailure) throw Object.assign(new Error("transport"), { code: "GATEWAY_TIMEOUT" });
      await input.onUsage?.({
        protocol: "openai-v1", providerRequestId: "provider-one",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, metering: null,
      });
      return { output: "ok", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
    } },
  });
  return { service, calls };
}

test("native start is durable after nonce consumption and before Gateway, followed by usage and terminal", async () => {
  const h = serviceHarness();
  assert.equal((await h.service.invoke(sign(payload()))).output, "ok");
  assert.deepEqual(h.calls, ["nonce", "start", "gateway", "usage", "SUCCEEDED"]);
  await assert.rejects(h.service.invoke(sign(payload())));
  assert.equal(h.calls.filter(value => value === "gateway").length, 1);
});

test("native durable-start write failure prevents Gateway execution", async () => {
  const h = serviceHarness({ startFailure: true });
  await assert.rejects(h.service.invoke(sign(payload())), { code: "EXECUTION_JOURNAL_UNAVAILABLE" });
  assert.deepEqual(h.calls, ["nonce", "start"]);
});

test("post-start transport error leaves a terminal unknown run, never a pre-start denial", async () => {
  const h = serviceHarness({ gatewayFailure: true });
  await assert.rejects(h.service.invoke(sign(payload())));
  assert.deepEqual(h.calls, ["nonce", "start", "gateway", "UNKNOWN"]);
});

test("proof tampering and mismatched run identity cannot write a native start", async () => {
  const h = serviceHarness();
  const forged = sign(payload());
  forged.session.metadata.domainId = "finance";
  await assert.rejects(h.service.invoke(forged));
  const wrongRun = payload();
  wrongRun.accounting.runId = hash("other-user\0one");
  await assert.rejects(h.service.invoke(sign(wrongRun)));
  assert.deepEqual(h.calls, []);
});

test("installed SDK serializes native proof payload, Runtime identity headers and endpoint qualifier without network", async () => {
  let wire;
  const client = new BedrockAgentCoreClient({
    region: "us-west-2", maxAttempts: 1,
    credentials: { accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-secret" },
    requestHandler: { async handle(request) {
      wire = request;
      return { response: { statusCode: 200, headers: {
        "content-type": "application/json",
        "x-amzn-bedrock-agentcore-runtime-session-id": payload().session.sessionId,
        "x-amzn-trace-id": "1-synthetic-trace",
      }, body: Readable.from([JSON.stringify({
        agentId: "triage", sessionId: payload().session.sessionId, output: "Synthetic SDK response",
        upstreamRequestId: null, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })]) } };
    } },
  });
  const adapter = createAgentRuntimeAdapter({ client, proofClock: () => Date.parse(NOW),
    proofConfigProvider: async () => ({
      hmacKey: secret, previousHmacKey: null, allowedEndpointArn: audience, keyId: "test-v1",
    }),
  });
  const result = await adapter.invoke({
    actor: "test-user", requestId: "one", sessionId: payload().session.sessionId, prompt: "Synthetic wire test",
    agent: { id: "triage", modelId: "test-route/test-model", domainId: "support",
      projectId: "case-assist", status: "PRODUCTION_DEPLOYED" },
    deployment: { environment: "PRODUCTION", status: "DEPLOYED", runtimeStatus: "READY",
      runtimeArn: audience.split("/runtime-endpoint/")[0], endpointName: "Production", endpointArn: audience },
    nativeExecution: { payloadFingerprint: hash("request"), async prepare() {} },
  });
  assert.equal(await client.config.maxAttempts(), 1);
  assert.equal(wire.method, "POST");
  assert.equal(wire.path, `/runtimes/${encodeURIComponent(audience.split("/runtime-endpoint/")[0])}/invocations`);
  assert.equal(wire.query.qualifier, "Production");
  const headers = Object.fromEntries(Object.entries(wire.headers).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(headers["x-amzn-bedrock-agentcore-runtime-user-id"], "test-user");
  assert.equal(headers["x-amzn-bedrock-agentcore-runtime-session-id"], payload().session.sessionId);
  const { proof, ...signed } = JSON.parse(Buffer.from(wire.body).toString());
  assert.equal(signed.accounting.runId, hash("test-user\0one"));
  assert.equal(createRuntimeInvocationProof({ secret, clock: () => Date.parse(NOW) })
    .verify(signed, proof, audience), true);
  assert.equal(result.accounting.traceId, "1-synthetic-trace");
  client.destroy();
});

const START = "2026-09-10T00:00:00.000Z";
const END = "2026-09-11T00:00:00.000Z";
const compatibility = { writerVersion: "cost-v1", readerVersion: "cost-v1" };
const route = {
  attestationId: "synthetic-route-v1", modelId: "test-route/test-model", providerModelId: "test-model",
  provider: "synthetic", gatewayRegion: "us-west-2", billingRegion: "global",
  inferenceMode: "global", serviceTier: "standard", cacheMode: "explicit-counters",
};
const prices = () => ({ version: 2, entries: [{
  id: "synthetic-v1", modelId: route.modelId, providerModelId: route.providerModelId, region: "us-west-2",
  inputTokenBasis: "includes-cache", currency: "USD", effectiveFrom: START, effectiveTo: END,
  source: { url: "https://example.invalid/synthetic", retrievedAt: START },
  usdPerMillionTokens: { input: 2, output: 4, cacheRead: 1, cacheWrite5m: null, cacheWrite1h: null },
  activation: "active", route,
}] });
const reservation = (requestId = "one", domainId = "support", projectId = "case-assist") => ({
  actor: "test-user", requestId, domainId, projectId, agentId: "triage",
  sessionId: "session-0123456789abcdef-abcdef0123456789", payloadFingerprint: hash(`request-${requestId}`),
  baselineFingerprint: null,
});
const usageBody = (extra = {}) => ({
  model: "test-model", choices: [{ message: { content: "Measured synthetic response" } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } },
  ...extra,
});
const aggregateRequest = () => ({
  scope: { type: "projects", domainIds: ["support"], projectIds: ["support/case-assist"] },
  startTime: START, endTime: END, limit: 20,
});

// This emulator evaluates the emitted conditional expressions and transaction
// all-or-nothing behavior; it does not claim to be DynamoDB/IAM integration.
function memoryDynamo() {
  const rows = new Map();
  const commands = [];
  let fault;
  const keyOf = key => JSON.stringify({ pk: key.pk, sk: key.sk });
  const conditional = () => { throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" }); };
  const matches = (item, input) => input.ConditionExpression.split(" AND ").every(condition => {
    const attr = name => input.ExpressionAttributeNames?.[name] ?? name;
    const absent = /^attribute_not_exists\((.+)\)$/.exec(condition);
    if (absent) return !Object.hasOwn(item ?? {}, attr(absent[1]));
    const exists = /^attribute_exists\((.+)\)$/.exec(condition);
    if (exists) return Object.hasOwn(item ?? {}, attr(exists[1]));
    const [name, value] = condition.split(" = ");
    return isDeepStrictEqual(item?.[attr(name)], input.ExpressionAttributeValues[value]);
  });
  function put(input) {
    const key = keyOf(input.Item);
    if (!matches(rows.get(key), input)) conditional();
    rows.set(key, structuredClone(input.Item));
    return {};
  }
  const dynamo = { async send(command) {
    const input = command.input;
    commands.push(command);
    if (fault) await fault(command, rows);
    switch (command.constructor.name) {
      case "GetItemCommand": return { Item: structuredClone(rows.get(keyOf(input.Key))) };
      case "QueryCommand": return { Items: [...rows.values()].filter(item =>
        item.entityType?.S === "EXPERIENCE_INVOCATION"
        && item.domainId.S === input.ExpressionAttributeValues[":domainId"].S
        && item.projectId.S === input.ExpressionAttributeValues[":projectId"].S).map(item => structuredClone(item)) };
      case "PutItemCommand": return put(input);
      case "TransactWriteItemsCommand": {
        for (const entry of input.TransactItems) {
          const operation = entry.Update ?? entry.Put;
          const key = keyOf(operation.Key ?? operation.Item);
          if (!matches(rows.get(key), operation)) conditional();
        }
        for (const entry of input.TransactItems) {
          if (entry.Put) put(entry.Put);
          if (entry.Update) {
            const input = entry.Update;
            rows.get(keyOf(input.Key)).payloadFingerprint = structuredClone(input.ExpressionAttributeValues[":payloadFingerprint"]);
          }
        }
        return {};
      }
      case "UpdateItemCommand": {
        const key = keyOf(input.Key);
        let item = rows.get(key);
        if (!matches(item, input)) conditional();
        item ??= structuredClone(input.Key);
        for (const assignment of input.UpdateExpression.replace(/^SET /, "").split(", ")) {
          const [name, value] = assignment.split(" = ");
          item[input.ExpressionAttributeNames[name]] = structuredClone(input.ExpressionAttributeValues[value]);
        }
        rows.set(key, item);
        return input.ReturnValues === "ALL_NEW" ? { Attributes: structuredClone(item) } : {};
      }
      default: assert.fail(`Unexpected ${command.constructor.name}`);
    }
  } };
  return { rows, dynamo, commands, fault(fn) { fault = fn; } };
}

function chain({ body = usageBody(), transportFailure = false, configuredRoute = route,
  priceBook = prices(), journalCompatibility = compatibility, onProviderResponse, converse = false,
  writerFactory = createExecutionWriter, providerFactory = createConfiguredBedrockInference,
  converseReaderVersion = "converse-v2" } = {}) {
  const db = memoryDynamo();
  let time = NOW;
  let nonce = 0;
  let sent;
  let providerCalls = 0;
  let holdDispatch = false;
  let dropResponse = false;
  const clock = () => new Date(time);
  const nativeJournal = createNativeExecutionJournal({ tableName: "Synthetic", dynamo: db.dynamo, now: clock });
  const store = createExperienceInvocationStore({
    tableName: "Synthetic", dynamo: db.dynamo, now: clock, compatibility: journalCompatibility, nativeJournal,
  });
  const writer = writerFactory({
    tableName: "Synthetic", dynamo: db.dynamo, now: clock, route: converse ? null : configuredRoute, priceBook,
    ...(converse ? { converseReaderVersion } : {}),
  });
  const proofConfigProvider = async () => ({
    hmacKey: secret, previousHmacKey: null, allowedEndpointArn: audience, keyId: "test-v1",
  });
  const consumed = new Set();
  const modelId = converse ? "global.anthropic.claude-haiku-4-5-20251001-v1:0" : route.modelId;
  const gateway = converse ? providerFactory({
    env: { MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1", BEDROCK_RUNTIME_REGION: "us-west-2",
      BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{ modelId, domains: ["support"] }]) },
    credentialsProvider: async () => ({ accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-secret" }),
    fetchImpl: async (url, input) => {
      providerCalls += 1;
      assert.equal(url, `https://bedrock-runtime.us-west-2.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`);
      assert.equal(JSON.parse(input.body).inferenceConfig.maxTokens, 128);
      if (transportFailure) throw new Error("transport");
      await onProviderResponse?.();
      return new Response(JSON.stringify(body), { headers: { "x-amzn-requestid": `provider-${providerCalls}` } });
    },
  }) : new AgentCoreGatewayClient({
    gatewayBaseUrl: "https://test-gateway-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1",
    region: "us-west-2", clock, logger: { error() {} },
    credentialsProvider: async ({ sourceIdentity }) => {
      assert.match(sourceIdentity, /^domain_(support|finance)$/);
      return { accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-secret", sessionToken: "synthetic-token" };
    },
    fetchImpl: async (url, input) => {
      providerCalls += 1;
      assert.equal(url.endsWith("/chat/completions"), true);
      assert.equal(JSON.parse(input.body).model, route.modelId);
      if (transportFailure) throw new Error("transport");
      await onProviderResponse?.();
      return new Response(JSON.stringify(body), { headers: { "x-amzn-requestid": `provider-${providerCalls}` } });
    },
  });
  const runtime = createAgentRuntimeService({
    gateway, executionWriter: writer, metrics: { recordInvocation() {} }, clock,
    proofConfigProvider, proofReplayLedger: { async consume({ nonce }) {
      if (consumed.has(nonce)) return false;
      consumed.add(nonce); return true;
    } },
  });
  const adapter = createAgentRuntimeAdapter({
    ...(converse ? { maxTokens: 128 } : {}),
    proofConfigProvider, proofClock: () => Date.parse(time), proofNonce: () => Buffer.alloc(32, ++nonce),
    client: { async send(command) {
      sent = JSON.parse(Buffer.from(command.input.payload).toString());
      assert.equal(command.input.qualifier, "Production");
      assert.equal(command.input.runtimeUserId, sent.session.metadata.actor);
      if (holdDispatch) throw new Error("accepted but not sent");
      const response = await runtime.invoke(sent);
      if (dropResponse) throw new Error("outer response lost");
      return { statusCode: 200, contentType: "application/json", runtimeSessionId: sent.session.sessionId,
        traceId: "1-synthetic-trace", response: { async transformToByteArray() { return Buffer.from(JSON.stringify(response)); } } };
    } },
  });
  const provider = createJournalUsageProvider({ journal: store, compatibility, nativeExecution: true, priceBook });
  async function invoke(input = reservation()) {
    await store.start(input);
    try {
      const outcome = await adapter.invoke({
        actor: input.actor, requestId: input.requestId, sessionId: input.sessionId, prompt: "Synthetic request",
        agent: { id: input.agentId, modelId, domainId: input.domainId,
          projectId: input.projectId, status: "PRODUCTION_DEPLOYED" },
        deployment: { environment: "PRODUCTION", status: "DEPLOYED", runtimeStatus: "READY",
          runtimeArn: audience.split("/runtime-endpoint/")[0], endpointName: "Production", endpointArn: audience },
        nativeExecution: { payloadFingerprint: input.payloadFingerprint,
          prepare: signed => store.prepareExecution(input, signed) },
        ...(store.markDispatched ? { onDispatch: ({ region }) => store.markDispatched({ ...input, region }) } : {}),
      });
      await store.complete({ ...input, runtimeStatus: "SUCCEEDED", output: outcome.output,
        invocationId: outcome.invocationId, accounting: outcome.accounting });
      return outcome;
    } catch (error) {
      await store.complete({ ...input, runtimeStatus: "FAILED", output: null, invocationId: null });
      throw error;
    }
  }
  return {
    ...db, store, writer, runtime, nativeJournal, provider, invoke, clock,
    sent: () => sent, providerCalls: () => providerCalls,
    read: (input = reservation()) => nativeJournal.read(input),
    aggregate: async (input = aggregateRequest()) => (await provider.listInvocationUsageAggregates(input)).items[0],
    setTime(value) { time = value; }, holdDispatch() { holdDispatch = true; }, dropResponse() { dropResponse = true; },
  };
}

async function nativeCostHttpPage(h) {
  const noopPage = async () => ({ items: [], cursor: null });
  const handler = createOperationsRuntime({
    workspaceState: {
      beginTransaction() {}, async getMutationResult() { return null; },
      async listProjects() { return { items: [{ id: "case-assist", domainId: "support",
        name: "Synthetic", description: "", ownerSubject: "test-user", memberSubjects: [],
        status: "ACTIVE", createdBySubject: "test-user", createdAt: START }], cursor: null }; },
      async getProject() { return null; }, listIncidents: noopPage, async getIncident() { return null; },
      async putIncident() {}, listAuditMetadata: noopPage, listBreakGlass: noopPage,
      async getBreakGlass() { return null; }, async putBreakGlass() {},
    },
    domainDirectory: { async listActiveDomains() { return [{ id: "support" }]; } },
    cloudWatchProvider: { listRuntimeAggregates: noopPage }, usageProvider: h.provider,
    identityVerifier: async () => true, clock: () => Date.parse(END),
    cursorSigningKey: "synthetic-native-cost-cursor-key-0123456789",
  });
  const response = await handler({
    version: "2.0", headers: { "x-demo-role": "builder", "x-active-domain": "support" },
    queryStringParameters: { window: "24h" },
    requestContext: { requestId: "synthetic-native-cost", http: { method: "GET", path: "/api/costs" },
      authorizer: { jwt: { claims: { sub: "test-user", token_use: "access",
        "cognito:username": "synthetic", "cognito:groups": ["platform-admin", "demo-operator"] } } } },
  });
  assert.equal(response.statusCode, 200, response.body);
  const page = JSON.parse(response.body);
  assert.equal(page.ok, true);
  assert.equal(page.resource, "costs");
  assert.equal(page.scope.type, "projects");
  assert.equal(page.window.startTime, START);
  assert.equal(page.window.endTime, END);
  assert.equal(page.cursor, null);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].contractVersion, 1);
  return page;
}

test("code-backed adapter -> Runtime -> signed Gateway -> durable usage yields an actual-start KPI", async () => {
  const h = chain();
  const result = await h.invoke();
  assert.equal(result.accounting.traceId, "1-synthetic-trace");
  const event = await h.read();
  assert.equal(event.startedAt, NOW);
  assert.equal(event.terminal.status, "SUCCEEDED");
  assert.equal(event.usage.observation.providerRequestId, "provider-1");
  assert.equal(event.usage.price.estimatedCostUsd, .00025); // 70*2 + 20*4 + 30*1 / 1e6
  const aggregate = await h.aggregate();
  assert.equal(aggregate.runCount, 1);
  assert.equal(aggregate.acceptedDispatchCount, 1);
  assert.equal(aggregate.estimatedCostUsd, .00025);
  assert.equal(aggregate.pricedAttemptCount, 1);
  assert.equal(aggregate.modelCoverage, "complete");
  const page = await nativeCostHttpPage(h);
  assert.deepEqual(costSummary(page), { totalCostUsd: .00025, runCount: 1,
    costPerRunUsd: .00025, acceptedDispatchCount: 1 });
  assert.match(hostedCostHtml(page), /Retained provider usage includes failed runs/);
  assert.equal([...h.rows.values()].some(item => JSON.stringify(item).includes("Synthetic request")), false);
});

test("accepted dispatch without Runtime execution and pre-proof denial contribute zero native runs", async () => {
  const h = chain();
  h.holdDispatch();
  await assert.rejects(h.invoke());
  const tampered = structuredClone(h.sent());
  tampered.session.metadata.projectId = "other-project";
  await assert.rejects(h.runtime.invoke(tampered));
  assert.equal((await h.read()).startedAt, null);
  assert.equal(h.providerCalls(), 0);
  const aggregate = await h.aggregate();
  assert.equal(aggregate.acceptedDispatchCount, 1);
  assert.equal(aggregate.runCount, 0);
  assert.equal(aggregate.estimatedCostUsd, 0);
  const page = await nativeCostHttpPage(h);
  assert.equal(costSummary(page).runCount, 0);
  assert.equal(costSummary(page).acceptedDispatchCount, 1);
  assert.equal(costSummary(page).costPerRunUsd, null);
});

test("start write failure is fail-before-execution and a consumed nonce cannot be retried", async () => {
  const h = chain();
  h.fault(command => {
    if (command.input.ExpressionAttributeNames?.["#field"] === "startedAt") throw new Error("durability");
  });
  await assert.rejects(h.invoke());
  h.fault(null);
  await assert.rejects(h.runtime.invoke(h.sent()));
  assert.equal(h.providerCalls(), 0);
  assert.equal((await h.aggregate()).runCount, 0);
});

test("measured usage survives output failure and loss of the entire outer Runtime response", async () => {
  for (const malformed of [false, true]) {
    const h = chain({ body: malformed ? usageBody({ choices: [] }) : usageBody() });
    if (!malformed) h.dropResponse();
    await assert.rejects(h.invoke());
    assert.equal((await h.read()).terminal.status, malformed ? "FAILED" : "SUCCEEDED");
    const value = await h.aggregate();
    assert.equal(value.runCount, 1);
    assert.equal(value.failedDispatchCount, 1);
    assert.equal(value.failedRunCount, malformed ? 1 : 0);
    assert.equal(value.estimatedCostUsd, .00025);
  }
});

test("post-start unknown usage and lost terminal persistence leave counted incomplete runs", async () => {
  const h = chain({ transportFailure: true });
  await assert.rejects(h.invoke());
  assert.equal((await h.read()).terminal.status, "UNKNOWN");
  let result = await h.aggregate();
  assert.equal(result.runCount, 1);
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(result.unresolvedRunCount, 1);
  const crash = chain({ transportFailure: true });
  crash.fault(command => {
    if (command.input.ExpressionAttributeNames?.["#field"] === "terminal") throw new Error("process lost");
  });
  await assert.rejects(crash.invoke());
  crash.fault(null);
  assert.equal((await crash.read()).terminal, null);
  result = await crash.aggregate();
  assert.equal(result.runCount, 1);
  assert.equal(result.estimatedCostUsd, null);
});

test("terminal/usage delivery dedupes, a second billable attempt cannot overwrite, explicit retry is a new run", async () => {
  const h = chain();
  await h.invoke();
  const event = await h.read();
  h.setTime("2026-09-10T12:00:01.000Z");
  await h.writer.recordUsage(h.sent(), event.usage.observation);
  await h.writer.finish(h.sent(), event.terminal);
  assert.equal(await h.writer.start(h.sent(), event.startedAt), false);
  assert.equal((await h.aggregate()).runCount, 1);
  await assert.rejects(h.writer.recordUsage(h.sent(), {
    ...event.usage.observation, providerRequestId: "second-billable-attempt",
  }));
  await assert.rejects(h.runtime.invoke(h.sent()));
  await h.invoke(reservation("explicit-retry"));
  assert.equal(h.providerCalls(), 2);
  assert.equal((await h.aggregate()).runCount, 2);
  assert.equal((await h.aggregate()).estimatedCostUsd, .0005);
});

test("reservation fingerprints, proof capabilities and exact domain/project scope cannot be substituted", async () => {
  const h = chain();
  await h.invoke();
  await assert.rejects(h.nativeJournal.read({ ...reservation(), domainId: "finance" }));
  await assert.rejects(h.nativeJournal.read({ ...reservation(), projectId: "other-project" }));
  await assert.rejects(h.nativeJournal.read({ ...reservation(), payloadFingerprint: hash("wrong") }));
  const foreign = reservation("two", "finance");
  await h.store.start(foreign);
  const signed = h.sent();
  await assert.rejects(h.store.prepareExecution(foreign, { payload: signed, proof: signed.proof }));
  // Even a holder of the shared proof secret cannot invent a prepared event
  // capability for an unreserved run.
  const fabricated = payload();
  fabricated.session.metadata = { ...fabricated.session.metadata, requestId: "invented", domainId: "finance" };
  fabricated.accounting = { ...fabricated.accounting, runId: hash("test-user\0invented") };
  await assert.rejects(h.runtime.invoke(sign(fabricated, 77)), { code: "EXECUTION_JOURNAL_UNAVAILABLE" });
  const relabeled = structuredClone(h.sent());
  delete relabeled.proof;
  relabeled.session.metadata.domainId = "finance";
  await assert.rejects(h.runtime.invoke(sign(relabeled, 78)), { code: "EXECUTION_JOURNAL_UNAVAILABLE" });
  assert.equal(h.providerCalls(), 1);
  const finance = await h.provider.listInvocationUsageAggregates({
    ...aggregateRequest(), scope: { type: "projects", domainIds: ["finance"], projectIds: ["finance/case-assist"] },
  });
  assert.equal(finance.items[0].knownRunCount, 0);
  assert.equal((await h.aggregate()).runCount, 1);
});

test("prepared native rows do not alter invocation format and mixed old writers cannot create a numeric denominator", async () => {
  const h = chain();
  await h.invoke();
  const uninstrumented = createExperienceInvocationStore({
    tableName: "Synthetic", dynamo: h.dynamo, now: h.clock,
  });
  const old = reservation("old");
  await uninstrumented.start(old);
  assert.equal((await h.aggregate()).runCount, null);
  assert.equal((await h.aggregate()).knownRunCount, 1);
  assert.equal((await h.aggregate()).knownEstimatedCostUsd, .00025);
  const oldReader = createExperienceInvocationStore({ tableName: "Synthetic", dynamo: h.dynamo, now: h.clock });
  const oldPage = await oldReader.listByProject({ domainId: "support", projectId: "case-assist" });
  assert.equal(oldPage.items.length, 2);
  assert.equal(Object.hasOwn(oldPage.items[0], "nativeExecution"), false);
  assert.equal(nativeExecutionEnabled(undefined), false);
  assert.throws(() => nativeExecutionEnabled("true"));
});

test("unattested routes/candidates stay unpriced and source changes cannot reprice retained usage", async () => {
  for (const configuredRoute of [null, ...[
    { serviceTier: "priority" }, { billingRegion: "us-west-2" }, { inferenceMode: "regional" },
    { gatewayRegion: "us-east-1" }, { provider: "bedrock" }, { attestationId: "different-route" },
    { providerModelId: "different-model" }, { modelId: "different-alias" },
  ].map(changes => ({ ...route, ...changes }))]) {
    const h = chain({ configuredRoute });
    await h.invoke();
    assert.equal((await h.aggregate()).estimatedCostUsd, null);
    assert.equal((await h.aggregate()).runCount, 1);
  }
  const candidate = prices();
  candidate.entries[0].activation = "candidate";
  const pending = chain({ priceBook: candidate });
  await pending.invoke();
  assert.equal((await pending.aggregate()).estimatedCostUsd, null);
  const invalidBedrock = prices();
  invalidBedrock.entries[0].route = { ...route, provider: "bedrock" };
  invalidBedrock.entries[0].source.url = "https://platform.claude.com/docs/en/about-claude/pricing";
  assert.throws(() => createModelPriceBook(invalidBedrock));
  invalidBedrock.entries[0].activation = "candidate";
  assert.doesNotThrow(() => createModelPriceBook(invalidBedrock));
  const h = chain();
  await h.invoke();
  const changed = prices();
  changed.entries[0].usdPerMillionTokens.input = 999;
  const provider = createJournalUsageProvider({ journal: h.store, compatibility, nativeExecution: true, priceBook: changed });
  assert.equal((await provider.listInvocationUsageAggregates(aggregateRequest())).items[0].estimatedCostUsd, .00025);
  const missingCache = chain({ body: usageBody({ usage: {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  } }) });
  await missingCache.invoke();
  assert.equal((await missingCache.aggregate()).estimatedCostUsd, null);
  assert.equal((await missingCache.aggregate()).inputTokens, 100);
});

test("the concrete candidate config validates but cannot be activated as verified Bedrock pricing", async () => {
  const config = JSON.parse(await readFile(new URL("../../../docs/native-execution-prices.example.json", import.meta.url), "utf8"));
  assert.equal(config.entries[0].activation, "candidate");
  assert.doesNotThrow(() => createModelPriceBook(config));
  config.entries[0].activation = "active";
  assert.throws(() => createModelPriceBook(config));
});

test("usage and starts use their own occurrence in the same half-open UTC window", async () => {
  const h = chain();
  await h.invoke();
  const nextDay = await h.provider.listInvocationUsageAggregates({
    ...aggregateRequest(), startTime: END, endTime: "2026-09-12T00:00:00.000Z",
  });
  assert.equal(nextDay.items[0].runCount, 0);
  assert.equal(nextDay.items[0].estimatedCostUsd, 0);
  h.setTime(END);
  await h.invoke(reservation("next-day"));
  assert.equal((await h.aggregate()).runCount, 1);
  const crossing = chain({ onProviderResponse() { crossing.setTime(NOW); } });
  crossing.setTime("2026-09-09T23:59:59.000Z");
  await crossing.invoke();
  assert.equal((await crossing.aggregate()).runCount, 0);
  assert.equal((await crossing.aggregate()).estimatedCostUsd, .00025);
});

test("a lost acknowledgement after a durable start is counted but never sends Gateway or blindly retries", async () => {
  const h = chain();
  h.fault((command, rows) => {
    if (command.input.ExpressionAttributeNames?.["#field"] === "startedAt") {
      const input = command.input;
      rows.get(JSON.stringify(input.Key)).startedAt = structuredClone(input.ExpressionAttributeValues[":value"]);
      throw new Error("write committed but response lost");
    }
  });
  await assert.rejects(h.invoke());
  h.fault(null);
  assert.equal(h.providerCalls(), 0);
  assert.equal((await h.aggregate()).runCount, 1);
  assert.equal((await h.aggregate()).estimatedCostUsd, null);
  assert.equal((await h.read()).terminal, null);
});

test("usage persistence failure never becomes a successful complete-cost response or repeats the model call", async () => {
  const h = chain();
  h.fault(command => {
    if (command.input.ExpressionAttributeNames?.["#field"] === "usage") throw new Error("lost metering");
  });
  await assert.rejects(h.invoke());
  h.fault(null);
  assert.equal(h.providerCalls(), 1);
  assert.equal((await h.read()).usage, null);
  assert.equal((await h.aggregate()).runCount, 1);
  assert.equal((await h.aggregate()).estimatedCostUsd, null);
  await assert.rejects(h.runtime.invoke(h.sent()));
});

test("Runtime event identity inventions are ignored without an Experience binding and malformed evidence fails closed", async () => {
  const h = chain();
  await h.invoke();
  const key = { pk: { S: `NATIVE_EXECUTION_EVENT#${"a".repeat(64)}` }, sk: { S: "EXECUTION" } };
  h.rows.set(JSON.stringify(key), { ...key, startedAt: { S: NOW }, domainId: { S: "finance" } });
  assert.equal((await h.aggregate()).runCount, 1);
  const actual = [...h.rows.values()].find(item => item.pk.S.startsWith("NATIVE_EXECUTION_EVENT#") && !item.domainId);
  actual.startedAt = { NULL: true };
  await assert.rejects(h.aggregate());
});

test("retained native companion rows remain readable by pinned rollback readers without mutating legacy invocation rows", async () => {
  const h = chain({ journalCompatibility: {} });
  await h.invoke();
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const require = createRequire(import.meta.url);
  const sdk = pathToFileURL(require.resolve("@aws-sdk/client-dynamodb")).href;
  const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  for (const sha of ["38b31309793b6b65bb1e9d4f6a07ea013ae1bc44",
    "1feeae25f786da0a952102f62f18044eb70ce4da", "4e4a5fe916994d4ce8ba4b4ca03df53ffa51484b",
    "e27b8122f914f9ae93dfa76190ea233fc64260f4"]) {
    const show = path => execFileSync("git", ["show", `${sha}:infra/serverless-platform/lambda/${path}`],
      { cwd: root, encoding: "utf8" });
    let source = show("experience/invocation-store.mjs").replaceAll('"@aws-sdk/client-dynamodb"', JSON.stringify(sdk));
    for (const [specifier, path] of [["../agent-runtime/usage.mjs", "agent-runtime/usage.mjs"],
      ["./journal-compatibility.mjs", "experience/journal-compatibility.mjs"]]) {
      if (source.includes(`"${specifier}"`)) source = source.replaceAll(`"${specifier}"`, JSON.stringify(dataUrl(show(path))));
    }
    const old = await import(dataUrl(source));
    const reader = old.createExperienceInvocationStore({ tableName: "Synthetic", dynamo: h.dynamo, now: h.clock });
    const input = reservation();
    assert.equal((await reader.get({ actor: input.actor, requestId: input.requestId,
      payloadFingerprint: input.payloadFingerprint })).runtimeStatus, "SUCCEEDED");
    if (reader.listByProject) assert.equal((await reader.listByProject({
      domainId: input.domainId, projectId: input.projectId,
    })).items.length, 1);
  }
  const invocation = [...h.rows.values()].find(item => item.entityType?.S === "EXPERIENCE_INVOCATION");
  assert.equal(Object.hasOwn(invocation, "accounting"), false);
  assert.equal(Object.hasOwn(invocation, "lifecycle"), false);
  assert.equal((await h.aggregate()).runCount, 1);
});

test("Operations strict validation and authorized project/domain/admin costs expose only authentic-start KPIs", async () => {
  const h = chain();
  await h.invoke();
  const project = { id: "case-assist", domainId: "support", name: "Test", description: "",
    ownerSubject: "builder", memberSubjects: [], status: "ACTIVE", createdBySubject: "builder", createdAt: START };
  const service = createOperationsService({
    workspaceState: {
      ...Object.fromEntries(["beginTransaction", "getMutationResult", "getProject", "listIncidents",
        "getIncident", "putIncident", "listAuditMetadata", "listBreakGlass", "getBreakGlass", "putBreakGlass"]
        .map(name => [name, async () => { throw new Error("unexpected workflow"); }])),
      async listProjects() { return { items: [project], cursor: null }; },
    },
    authorizer: async () => ({ ok: true }), usageProvider: h.provider,
    cloudWatchProvider: { async listRuntimeAggregates() { throw new Error("unexpected metrics"); } },
    clock: () => Date.parse(END), cursorSigningKey: "synthetic-cursor-key-0123456789abcdef",
  });
  for (const role of ["builder", "lead", "admin"]) {
    const page = await service.listCosts({ identity: {
      actor: "builder", role, activeDomain: role === "admin" ? null : "support", domainIds: ["support"],
    } });
    assert.equal(page.items[0].runCount, 1);
    assert.equal(page.items[0].costPerRunUsd, .00025);
    assert.equal(page.items[0].completeness, "partial");
    assert.equal(page.items[0].projectedMonthlyCostUsd, null);
    assert.deepEqual(page.items[0].coverage.included, ["retained-provider-usage-including-failures"]);
  }
});

const converseBody = () => ({
  output: { message: { role: "assistant", content: [{ text: "Synthetic Converse answer" }] } },
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120,
    cacheReadInputTokens: 0, cacheWriteInputTokens: 0, cacheDetails: [] },
  stopReason: "end_turn", metrics: { latencyMs: 1 },
});

const directExample = JSON.parse(await readFile(new URL("../../../docs/bedrock-runtime-prices.example.json", import.meta.url)));
const directPrices = () => {
  const config = structuredClone(directExample);
  config.entries[0].activation = "active";
  config.entries[0].request.modelId = config.entries[0].requestModelId;
  return config;
};
const directRequest = () => ({ ...aggregateRequest(),
  startTime: "2026-09-11T03:00:00.000Z", endTime: "2026-09-12T03:00:00.000Z" });

test("direct Converse usage -> immutable settlement -> Operations -> two-project cost helper", async () => {
  const h = chain({ converse: true, body: converseBody(), priceBook: directPrices() });
  h.setTime("2026-09-11T12:00:00.000Z");
  await h.invoke();
  await h.invoke({ ...reservation("second", "support", "case-review"), agentId: "reviewer" });
  const event = await h.read();
  assert.equal(event.usage.version, 3);
  assert.equal(event.usage.route, null);
  assert.equal(event.usage.price.estimatedCostUsd, .0002);
  assert.equal(event.usage.price.settlement.entry.provenance.catalogVersion, "20260901183649");
  const projects = ["case-assist", "case-review"].map(id => ({ id, domainId: "support", name: id,
    description: "", ownerSubject: "builder", memberSubjects: [], status: "ACTIVE",
    createdBySubject: "builder", createdAt: START }));
  const service = createOperationsService({
    workspaceState: {
      ...Object.fromEntries(["beginTransaction", "getMutationResult", "getProject", "listIncidents",
        "getIncident", "putIncident", "listAuditMetadata", "listBreakGlass", "getBreakGlass", "putBreakGlass"]
        .map(name => [name, async () => { throw new Error("unexpected workflow"); }])),
      async listProjects() { return { items: projects, cursor: null }; },
    },
    authorizer: async () => ({ ok: true }), usageProvider: h.provider,
    cloudWatchProvider: { async listRuntimeAggregates() { throw new Error("Shared Runtime cannot be allocated twice"); } },
    clock: () => Date.parse("2026-09-12T03:00:00.000Z"), cursorSigningKey: "synthetic-cursor-key-0123456789abcdef",
  });
  // The HTTP index wraps successful service results in this existing envelope.
  const builderPage = { ok: true, resource: "costs", ...await service.listCosts({ identity: {
    actor: "builder", role: "builder", activeDomain: "support", domainIds: ["support"],
  }, window: "24h" }) };
  assert.deepEqual(builderPage.items.map(item => [item.projectId, item.runCount, item.estimatedCostUsd]),
    [["case-assist", 1, .0002], ["case-review", 1, .0002]]);
  assert.equal(builderPage.items.every(item => item.completeness === "partial"), true);
  assert.deepEqual(costSummary(builderPage), { totalCostUsd: .0004, runCount: 2,
    costPerRunUsd: .0002, acceptedDispatchCount: 2 });
  assert.match(hostedCostHtml(builderPage), /shared costs are not covered/);
  for (const role of ["lead", "admin"]) {
    const page = { ok: true, resource: "costs", ...await service.listCosts({ identity: {
      actor: "builder", role, activeDomain: role === "admin" ? null : "support", domainIds: ["support"],
    }, window: "24h" }) };
    assert.equal(costSummary(page).totalCostUsd, .0004);
    assert.equal(costSummary(page).runCount, 2);
  }
  // A later delivery and a price configuration removal cannot reprice history.
  h.setTime("2026-09-13T12:00:00.000Z");
  const later = createExecutionWriter({ tableName: "Synthetic", dynamo: h.dynamo, now: h.clock,
    converseReaderVersion: "converse-v2", priceBook: { version: 3, entries: [] } });
  const secondEvent = await h.read({ ...reservation("second", "support", "case-review"), agentId: "reviewer" });
  await later.recordUsage(h.sent(), secondEvent.usage.observation);
  const reader = createJournalUsageProvider({ journal: h.store, compatibility, nativeExecution: true,
    priceBook: { version: 3, entries: [] } });
  assert.equal((await reader.listInvocationUsageAggregates(directRequest())).items[0].estimatedCostUsd, .0002);
  assert.deepEqual((await h.read()).usage, event.usage);
});

test("direct measured failures keep cost; missing evidence stays unknown and scope/windows remain exact", async () => {
  for (const mode of ["output", "outer", "transport", "cache", "usage", "terminal", "billed-over-cap", "base"]) {
    const body = converseBody();
    if (mode === "output") body.output = {};
    if (mode === "cache") delete body.usage.cacheReadInputTokens;
    if (mode === "billed-over-cap") body.usage = { ...body.usage, outputTokens: 200, totalTokens: 300 };
    if (mode === "base") delete body.usage;
    const h = chain({ converse: true, body, priceBook: directPrices(), transportFailure: mode === "transport" });
    h.setTime("2026-09-11T12:00:00.000Z");
    if (mode === "outer") h.dropResponse();
    if (["usage", "terminal"].includes(mode)) h.fault(command => {
      if (command.input.ExpressionAttributeNames?.["#field"] === mode) throw new Error("durability");
    });
    if (mode === "cache") await h.invoke();
    else await assert.rejects(h.invoke());
    h.fault(null);
    const result = await h.aggregate(directRequest());
    assert.equal(result.runCount, 1);
    assert.equal(result.estimatedCostUsd, mode === "billed-over-cap" ? .0011
      : ["output", "outer", "terminal"].includes(mode) ? .0002 : null);
    await assert.rejects(h.runtime.invoke(h.sent()));
    assert.equal(h.providerCalls(), 1);
  }
  const crossing = chain({ converse: true, body: converseBody(), priceBook: directPrices(),
    onProviderResponse() { crossing.setTime("2026-09-11T03:00:00.000Z"); } });
  crossing.setTime("2026-09-11T02:59:59.999Z");
  await crossing.invoke();
  assert.equal((await crossing.aggregate(directRequest())).runCount, 0);
  assert.equal((await crossing.aggregate(directRequest())).estimatedCostUsd, .0002);
  await assert.rejects(crossing.nativeJournal.read({ ...reservation(), projectId: "other" }));
});

test("Converse retained usage is versioned, scoped, unpriced, deduplicated and cannot be relabeled as Gateway", async () => {
  const h = chain({ converse: true, body: converseBody() });
  await h.invoke();
  const event = await h.read();
  assert.equal(event.usage.version, 3);
  assert.equal(event.usage.route, null);
  assert.equal(event.usage.price.estimatedCostUsd, null);
  assert.equal(event.usage.observation.runtime.providerModelId, null);
  assert.equal(event.usage.observation.runtime.requestModelId, h.sent().agentConfig.modelId);
  assert.equal((await h.aggregate()).runCount, 1);
  assert.equal((await h.aggregate()).inputTokens, 100);
  assert.equal((await h.aggregate()).estimatedCostUsd, null);
  await h.writer.recordUsage(h.sent(), event.usage.observation);
  assert.equal((await h.aggregate()).runCount, 1);
  await assert.rejects(h.writer.recordUsage(h.sent(), { ...event.usage.observation, providerRequestId: "other" }));
  await assert.rejects(h.runtime.invoke(h.sent()));
  await assert.rejects(h.nativeJournal.read({ ...reservation(), projectId: "other" }));
  await assert.rejects(h.nativeJournal.read({ ...reservation(), domainId: "finance" }));
  assert.equal(h.providerCalls(), 1);
});

test("Converse failures before/after start retain measured usage or unknown, never a made-up zero", async () => {
  for (const mode of ["start", "start-ack", "transport", "output", "usage", "terminal", "outer", "missing-usage"]) {
    const body = converseBody();
    if (mode === "output") body.output = {};
    if (mode === "missing-usage") delete body.usage;
    const h = chain({ converse: true, body, transportFailure: mode === "transport" });
    if (mode === "outer") h.dropResponse();
    h.fault((command, rows) => {
      const field = command.input.ExpressionAttributeNames?.["#field"];
      if (field === "startedAt" && mode === "start-ack") {
        rows.get(JSON.stringify(command.input.Key)).startedAt = command.input.ExpressionAttributeValues[":value"];
        throw new Error("lost start acknowledgement");
      }
      if (field === (mode === "start" ? "startedAt" : mode)) throw new Error("synthetic write failure");
    });
    await assert.rejects(h.invoke());
    h.fault(null);
    const event = await h.read();
    const aggregate = await h.aggregate();
    assert.equal(aggregate.runCount, mode === "start" ? 0 : 1);
    assert.equal(h.providerCalls(), ["start", "start-ack"].includes(mode) ? 0 : 1);
    if (mode !== "start") assert.equal(aggregate.estimatedCostUsd, null);
    if (["output", "terminal", "outer"].includes(mode)) assert.equal(event.usage.observation.usage.inputTokens, 100);
    else assert.equal(event.usage, null);
    if (mode === "transport") assert.equal(event.terminal.status, "UNKNOWN");
    if (mode === "output") assert.equal(event.terminal.status, "FAILED");
    await assert.rejects(h.runtime.invoke(h.sent()));
  }
});

test("Converse writer requires upgraded-reader attestation; pre-Converse reader rejects retained events with writers off", async () => {
  const h = chain({ converse: true, body: converseBody(), journalCompatibility: {} });
  await h.invoke();
  const event = await h.read();
  const unsafe = createExecutionWriter({ tableName: "Synthetic", dynamo: h.dynamo, now: h.clock });
  await assert.rejects(unsafe.recordUsage(h.sent(), event.usage.observation));
  const legacyRoute = createExecutionWriter({
    tableName: "Synthetic", dynamo: h.dynamo, now: h.clock, route,
    converseReaderVersion: "converse-v1",
  });
  await assert.rejects(legacyRoute.recordUsage(h.sent(), event.usage.observation));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const base = "f043d4a33ee7736b3accaa19b9639b85888e98ea";
  const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const show = path => execFileSync("git", ["show", `${base}:infra/serverless-platform/lambda/${path}`],
    { cwd: root, encoding: "utf8" });
  const usageUrl = dataUrl(show("agent-runtime/usage.mjs"));
  const priceUrl = dataUrl(show("operations/model-prices.mjs").replaceAll('"../agent-runtime/usage.mjs"', JSON.stringify(usageUrl)));
  const sdkUrl = pathToFileURL(createRequire(import.meta.url).resolve("@aws-sdk/client-dynamodb")).href;
  const source = show("agent-runtime/execution-journal.mjs")
    .replaceAll('"./usage.mjs"', JSON.stringify(usageUrl))
    .replaceAll('"../operations/model-prices.mjs"', JSON.stringify(priceUrl))
    .replaceAll('"@aws-sdk/client-dynamodb"', JSON.stringify(sdkUrl));
  const old = await import(dataUrl(source));
  assert.equal(old.nativeExecutionEnabled("disabled"), false);
  const reader = old.createNativeExecutionJournal({ tableName: "Synthetic", dynamo: h.dynamo, now: h.clock });
  await assert.rejects(reader.read(reservation()), { code: "EXECUTION_JOURNAL_UNAVAILABLE" });
  // Old writer/new reader and old writer/old reader remain supported.
  const legacy = chain();
  await legacy.invoke();
  assert.equal((await legacy.read()).usage.version, 1);
  assert.equal((await old.createNativeExecutionJournal({
    tableName: "Synthetic", dynamo: legacy.dynamo, now: legacy.clock,
  }).read(reservation())).usage.version, 1);
  // Legacy invocation row shape remains readable; companions are separate.
  assert.equal((await createExperienceInvocationStore({
    tableName: "Synthetic", dynamo: h.dynamo, now: h.clock,
  }).listByProject({ domainId: "support", projectId: "case-assist" })).items.length, 1);
});

test("actual d2aa8ca v2 writer/new reader retains old usage; its reader rejects v3 even with writes disabled", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const sha = "d2aa8cae631fbe338dffe2c5c8b1b395cb08bba7";
  const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const show = path => execFileSync("git", ["show", `${sha}:infra/serverless-platform/lambda/${path}`],
    { cwd: root, encoding: "utf8" });
  const sdk = name => JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve(name)).href);
  const usageUrl = dataUrl(show("agent-runtime/usage.mjs"));
  const priceUrl = dataUrl(show("operations/model-prices.mjs")
    .replaceAll('"../agent-runtime/usage.mjs"', JSON.stringify(usageUrl)));
  const inferenceUrl = dataUrl(show("agent-runtime/bedrock-inference.mjs")
    .replaceAll('"./usage.mjs"', JSON.stringify(usageUrl))
    .replaceAll('"@aws-sdk/client-bedrock-runtime"', sdk("@aws-sdk/client-bedrock-runtime")));
  const oldProvider = await import(inferenceUrl);
  const old = await import(dataUrl(show("agent-runtime/execution-journal.mjs")
    .replaceAll('"./usage.mjs"', JSON.stringify(usageUrl))
    .replaceAll('"./bedrock-inference.mjs"', JSON.stringify(inferenceUrl))
    .replaceAll('"../operations/model-prices.mjs"', JSON.stringify(priceUrl))
    .replaceAll('"@aws-sdk/client-dynamodb"', sdk("@aws-sdk/client-dynamodb"))));
  const retained = chain({ converse: true, body: converseBody(),
    writerFactory: old.createExecutionWriter, providerFactory: oldProvider.createConfiguredBedrockInference,
    converseReaderVersion: "converse-v1" });
  await retained.invoke();
  const bytes = JSON.stringify([...retained.rows]);
  assert.equal((await retained.read()).usage.version, 2);
  assert.equal((await retained.aggregate()).estimatedCostUsd, null);
  const oldReader = old.createNativeExecutionJournal({ tableName: "Synthetic", dynamo: retained.dynamo, now: retained.clock });
  assert.deepEqual(await oldReader.read(reservation()), await retained.read());
  const changedPrices = createJournalUsageProvider({ journal: retained.store, compatibility,
    nativeExecution: true, priceBook: directPrices() });
  assert.equal((await changedPrices.listInvocationUsageAggregates(aggregateRequest())).items[0].estimatedCostUsd, null);
  assert.equal(JSON.stringify([...retained.rows]), bytes);

  const current = chain({ converse: true, body: converseBody(), priceBook: directPrices() });
  current.setTime("2026-09-11T12:00:00.000Z");
  await current.invoke();
  assert.equal(old.nativeExecutionEnabled("disabled"), false);
  await assert.rejects(old.createNativeExecutionJournal({
    tableName: "Synthetic", dynamo: current.dynamo, now: current.clock,
  }).read(reservation()), { code: "EXECUTION_JOURNAL_UNAVAILABLE" });
  const oldAttestation = createExecutionWriter({ tableName: "Synthetic", dynamo: current.dynamo,
    now: current.clock, converseReaderVersion: "converse-v1", priceBook: directPrices() });
  await assert.rejects(oldAttestation.recordUsage(current.sent(), (await current.read()).usage.observation));

  // The new reader must reject forged quantities, amount, provenance and binding.
  const row = [...current.rows.values()].find(item => item.pk.S.startsWith("NATIVE_EXECUTION_EVENT#"));
  const original = row.usage.S;
  for (const edit of [
    event => { event.price.estimatedCostUsd = 0; },
    event => { event.price.settlement.quantities.output = 1; },
    event => { event.price.settlement.entry.provenance.catalogVersion = "wrong"; },
    event => { event.observation.runtime.request.modelId = "bedrock-claude/anthropic.claude-haiku-4-5"; },
    event => { event.observation.runtime.requestModelId = "global.openai.gpt-6-astra"; },
  ]) {
    const event = JSON.parse(original);
    edit(event);
    row.usage.S = JSON.stringify(event);
    await assert.rejects(current.read(), { code: "EXECUTION_JOURNAL_UNAVAILABLE" });
    row.usage.S = original;
  }
});
