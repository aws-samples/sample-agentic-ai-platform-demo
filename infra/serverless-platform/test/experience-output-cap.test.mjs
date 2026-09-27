import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { createConfiguredExperienceHandler, createExperienceRuntime } from "../lambda/experience/runtime.mjs";
import { createAgentRuntimeAdapter } from "../lambda/experience/runtime-adapter.mjs";
import { createExperienceInvocationStore } from "../lambda/experience/invocation-store.mjs";
import { createWorkspaceState } from "../lambda/workspace/state.mjs";
import { createAgentRuntimeService } from "../lambda/agent-runtime/service.mjs";
import { createRuntimeInvocationProof } from "../lambda/agent-runtime/invocation-proof.mjs";
import { createExecutionWriter } from "../lambda/agent-runtime/execution-journal.mjs";
import { AgentCoreGatewayClient } from "../lambda/workspace/gateway.mjs";
import { createConfiguredAgentRuntime } from "../lambda/agent-runtime/server.mjs";

const ACTOR = "synthetic-user";
const SCOPE = { domainId: "support", projectId: "case-assist", agentId: "triage" };
const AUDIENCE = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/TestRuntime-123/runtime-endpoint/Production";
const SECRET_ARN = "arn:aws:secretsmanager:us-west-2:111122223333:secret:synthetic-proof";
const PROOF_CONFIG = {
  hmacKey: "synthetic-output-cap-proof-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  previousHmacKey: null, allowedEndpointArn: AUDIENCE, keyId: "synthetic-v1",
};
const clock = () => new Date();
const publicId = ({ domainId, projectId, agentId }) => `agent-${createHash("sha256")
  .update(`${domainId}\0${projectId}\0${agentId}`).digest("hex").slice(0, 32)}`;
const capEntry = (maxTokens = 512, scope = SCOPE) => ({ ...scope, maxTokens });
const buildConfig = maxTokens => ({
  instructions: "Synthetic instructions.",
  modelParameters: { temperature: null, maxTokens },
  buildOptions: { framework: "strands", deployTarget: "agentcore", memory: "none",
    streaming: false, identity: true, guardrails: true },
});

function agent(scope = SCOPE, target = 128, modelId = "synthetic-route/synthetic-model") {
  const now = clock().toISOString();
  return {
    domainId: scope.domainId, projectId: scope.projectId, id: scope.agentId,
    name: "Synthetic bounded agent", description: "Local fixture.", ownerSubject: "synthetic-builder",
    modelId, toolIds: [], mcpServerIds: [], skillIds: [], blueprintIds: [], memoryIds: [],
    knowledgeBaseIds: [], buildConfig: buildConfig(target), status: "PRODUCTION_DEPLOYED",
    createdBySubject: "synthetic-builder", createdAt: now, updatedAt: now,
    lastTestStatus: "SUCCEEDED", lastTestedAt: now, lastTestedBySubject: "synthetic-builder", lastTestModelId: modelId,
    lastTestInputTokens: 2, lastTestOutputTokens: 1, lastTestRequestId: "synthetic-test",
    lastTestEvidenceHash: "a".repeat(64), lastTestOutput: "Synthetic test.",
  };
}

function attribute(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  return { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, attribute(item)])) };
}

// In-process storage for factory composition, not a DynamoDB concurrency emulator.
// Existing journal tests separately exercise conditional writes and failure semantics.
function memoryDynamo(agents) {
  const rows = new Map();
  const commands = [];
  const keyOf = value => `${value.pk.S}\0${value.sk.S}`;
  const put = item => rows.set(keyOf(item), structuredClone(item));
  for (const record of agents) {
    const scope = { domainId: record.domainId, projectId: record.projectId, agentId: record.id };
    const now = record.createdAt;
    for (const item of [
      { ...record, pk: `AGENT#${scope.domainId}#${scope.projectId}`, sk: `AGENT#${scope.agentId}`, entityType: "AGENT" },
      { ...scope, subject: ACTOR, status: "ACTIVE", grantedBySubject: "synthetic-lead", grantedAt: now,
        revokedBySubject: null, revokedAt: null, pk: `ENTITLEMENT#${ACTOR}`,
        sk: `AGENT#${scope.domainId}#${scope.projectId}#${scope.agentId}`, entityType: "ENTITLEMENT" },
      { ...scope, id: `${scope.agentId}-prod`, environment: "PRODUCTION", status: "DEPLOYED",
        requesterSubject: "synthetic-builder", approverSubject: "synthetic-lead", decisionReason: "Synthetic.",
        requestedAt: now, decidedAt: now, runtimeId: "TestRuntime-123",
        runtimeArn: AUDIENCE.split("/runtime-endpoint/")[0], runtimeStatus: "READY",
        endpointName: "Production", endpointArn: AUDIENCE, runtimeVersion: "1", updatedAt: now,
        pk: `DEPLOYMENT#${scope.domainId}#${scope.projectId}`, sk: `DEPLOYMENT#${scope.agentId}-prod`,
        entityType: "DEPLOYMENT" },
    ]) put(attribute(item).M);
  }
  function update(input) {
    const item = rows.get(keyOf(input.Key));
    assert.ok(item, "update must target a retained synthetic row");
    for (const assignment of input.UpdateExpression.replace(/^SET /, "").split(", ")) {
      const [name, value] = assignment.split(" = ");
      item[input.ExpressionAttributeNames?.[name] ?? name] = structuredClone(input.ExpressionAttributeValues[value]);
    }
    return { Attributes: structuredClone(item) };
  }
  const dynamo = { async send(command) {
    commands.push(command);
    const input = command.input;
    switch (command.constructor.name) {
      case "QueryCommand": return { Items: [...rows.values()]
        .filter(item => item.pk.S === input.ExpressionAttributeValues[":pk"].S).map(item => structuredClone(item)) };
      case "GetItemCommand": return { Item: structuredClone(rows.get(keyOf(input.Key))) };
      case "PutItemCommand": put(input.Item); return {};
      case "UpdateItemCommand": return update(input);
      case "TransactWriteItemsCommand":
        for (const entry of input.TransactItems) {
          if (entry.Put) put(entry.Put.Item);
          else if (entry.Update) update(entry.Update);
          else assert.fail("Unexpected synthetic transaction");
        }
        return {};
      default: assert.fail(`Unexpected synthetic SDK command: ${command.constructor.name}`);
    }
  } };
  return { dynamo, rows, commands };
}

async function harness({
  agents = [agent()], outputCaps = [capEntry()], configured = true,
  adapterMaxTokens, rawAgent, tamper, omitOutputCaps = false, native = false,
  runtimeOnly = false,
} = {}) {
  const db = memoryDynamo(agents);
  const calls = { wire: [], provider: [], nonce: [], proof: 0, runtimeErrors: [] };
  const gateway = new AgentCoreGatewayClient({
    gatewayBaseUrl: "https://test-gateway-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1",
    region: "us-west-2", clock, logger: { error() {} },
    credentialsProvider: async () => ({ accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-only" }),
    fetchImpl: async (url, input) => {
      const body = JSON.parse(input.body);
      calls.provider.push({ url, body });
      return new Response(JSON.stringify(url.endsWith("/messages")
        ? { model: "synthetic-model", content: [{ type: "text", text: "Synthetic answer." }],
            usage: { input_tokens: 2, output_tokens: 1 } }
        : { model: "synthetic-model", choices: [{ message: { content: "Synthetic answer." } }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
      { headers: { "x-amzn-requestid": "synthetic-provider" } });
    },
  });
  const runtimeOptions = {
    gateway, clock, metrics: { recordInvocation() {} },
    ...(native ? { executionWriter: createExecutionWriter({ tableName: "Synthetic", dynamo: db.dynamo, now: clock,
      ...(runtimeOnly ? { converseReaderVersion: "converse-v2" } : {}) }) } : {}),
    proofConfigProvider: async () => PROOF_CONFIG,
    proofReplayLedger: { async consume({ nonce }) {
      if (calls.nonce.includes(nonce)) return false;
      calls.nonce.push(nonce); return true;
    } },
  };
  const runtime = runtimeOnly ? createConfiguredAgentRuntime({
    ...runtimeOptions, metricWriter() {},
    env: { MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1", BEDROCK_RUNTIME_REGION: "us-west-2",
      BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([
        { modelId: "bedrock-claude/anthropic.claude-haiku-4-5", domains: ["support"] },
        { modelId: "global.openai.gpt-6-astra", domains: ["support"] },
      ]) },
    credentialsProvider: async () => ({ accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-only" }),
    fetchImpl: async (url, input) => {
      calls.provider.push({ url, body: JSON.parse(input.body) });
      return new Response(JSON.stringify({
        output: { message: { role: "assistant", content: [{ text: "Synthetic answer." }] } },
        stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3,
          cacheReadInputTokens: 0, cacheWriteInputTokens: 0, cacheDetails: [] },
        metrics: { latencyMs: 1 },
      }), { headers: { "x-amzn-requestid": "synthetic-provider" } });
    },
  }).service : createAgentRuntimeService(runtimeOptions);
  const client = new BedrockAgentCoreClient({
    region: "us-west-2", maxAttempts: 1,
    credentials: { accessKeyId: "AKIASYNTHETIC", secretAccessKey: "synthetic-only" },
    requestHandler: { async handle(request) {
      const sent = JSON.parse(Buffer.from(request.body).toString());
      calls.wire.push(structuredClone(sent));
      assert.equal(request.query.qualifier, "Production");
      assert.equal(request.headers["x-amzn-bedrock-agentcore-runtime-user-id"], ACTOR);
      tamper?.(sent);
      let response;
      try { response = await runtime.invoke(sent); }
      catch (error) { calls.runtimeErrors.push(error.code); throw error; }
      return { response: { statusCode: 200, headers: {
        "content-type": "application/json",
        "x-amzn-bedrock-agentcore-runtime-session-id": sent.session.sessionId,
      }, body: Readable.from([JSON.stringify(response)]) } };
    } },
  });
  const cognito = { async send(command) {
    if (command.constructor.name === "AdminGetUserCommand") return {
      Username: ACTOR, Enabled: true, UserAttributes: [{ Name: "sub", Value: ACTOR }],
    };
    assert.equal(command.constructor.name, "AdminListGroupsForUserCommand");
    return { Groups: [{ GroupName: "end-user" }] };
  } };
  let handler;
  if (configured) {
    handler = await createConfiguredExperienceHandler({
      env: { PLATFORM_STATE_TABLE_NAME: "Synthetic", RUNTIME_INVOCATION_PROOF_SECRET_ARN: SECRET_ARN,
        COGNITO_USER_POOL_ID: "us-west-2_synthetic",
        ...(native ? { EXPERIENCE_NATIVE_EXECUTION_VERSION: "native-v1" } : {}),
        ...(omitOutputCaps ? {} : { EXPERIENCE_OUTPUT_CAPS_JSON: JSON.stringify(outputCaps) }) },
      dynamo: db.dynamo, agentRuntimeClient: client, cognito, clock, identityVerifier: async () => false,
      secretsClient: { async send() {
        calls.proof += 1;
        return { ARN: SECRET_ARN, SecretString: JSON.stringify(PROOF_CONFIG), VersionStages: ["AWSCURRENT"] };
      } },
    });
  } else {
    const workspaceState = createWorkspaceState({ tableName: "Synthetic", dynamo: db.dynamo, now: clock });
    handler = createExperienceRuntime({
      workspaceState: rawAgent ? { ...workspaceState, async getAgent() { return rawAgent; } } : workspaceState,
      domainDirectory: { async listActiveDomains() { return []; } },
      runtimeAdapter: createAgentRuntimeAdapter({
        client, outputCaps, ...(adapterMaxTokens === undefined ? {} : { maxTokens: adapterMaxTokens }),
        proofConfigProvider: async () => { calls.proof += 1; return PROOF_CONFIG; },
      }),
      invocationStore: createExperienceInvocationStore({ tableName: "Synthetic", dynamo: db.dynamo, now: clock }),
      submissionStore: { async submitFeedback() {}, async reportIssue() {} },
      identityVerifier: async () => false,
      groupDirectory: { async resolveCurrentGroups() { return ["end-user"]; } }, clock,
    });
  }
  let sequence = 0;
  return { ...db, calls, runtime, close: () => client.destroy(),
    async invoke(body = {}, { scope = SCOPE, actor = ACTOR } = {}) {
      const requestId = `synthetic-${++sequence}`;
      return handler({
        version: "2.0", routeKey: "POST /api/experience/invocations",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ agentId: publicId(scope), prompt: "Synthetic request.", ...body }),
        requestContext: { requestId, http: { method: "POST", path: "/api/experience/invocations" },
          authorizer: { jwt: { claims: { sub: actor, username: actor, token_use: "access",
            "cognito:groups": ["end-user"] } } } },
      });
    },
  };
}

async function assertCap(h, expected, scope = SCOPE) {
  const response = await h.invoke({}, { scope });
  assert.equal(response.statusCode, 200, response.body);
  const providerBody = h.calls.provider.at(-1)?.body;
  assert.equal(providerBody.inferenceConfig?.maxTokens ?? providerBody.max_tokens, expected);
  const { proof, ...signed } = h.calls.wire.at(-1);
  assert.equal(signed.maxTokens, expected);
  assert.equal(createRuntimeInvocationProof({ secret: PROOF_CONFIG.hmacKey })
    .verify(signed, proof, AUDIENCE), true);
  assert.deepEqual(signed.session.metadata.domainId, scope.domainId);
  assert.deepEqual(signed.session.metadata.projectId, scope.projectId);
  assert.equal(signed.agentConfig.agentId, scope.agentId);
  return response;
}

test("configured Experience -> SDK -> verified Runtime -> Gateway sends exact128", async t => {
  const h = await harness();
  t.after(h.close);
  await assertCap(h, 128);
});

test("no scoped opt-in preserves the legacy 2048 provider limit", async t => {
  const h = await harness({ outputCaps: [] });
  t.after(h.close);
  await assertCap(h, 2048);
});

for (const modelId of ["synthetic-route/synthetic-model", "bedrock-claude/anthropic.claude-synthetic"]) {
  for (const target of [1, 128, 512, 513, 4096]) {
    test(`configured factory carries target ${target} to ${modelId} within ceiling512`, async t => {
      const h = await harness({ agents: [agent(SCOPE, target, modelId)] });
      t.after(h.close);
      await assertCap(h, Math.min(target, 512));
      assert.equal(h.calls.wire.length, 1);
      assert.equal(h.calls.provider.length, 1);
      assert.equal(h.calls.provider[0].url.endsWith(modelId.startsWith("bedrock-claude/") ? "/messages" : "/chat/completions"), true);
    });
  }
}

for (const [target, adapterMaxTokens, ceiling, expected] of [
  [512, 8192, 512, 512], [512, 256, 512, 256], [128, 256, 512, 128],
  [512, 2048, 128, 128], [128, 64, 512, 64], [128, 2048, 1, 1],
]) {
  test(`precedence: min(target=${target}, adapter=${adapterMaxTokens}, ceiling=${ceiling})=${expected}`, async t => {
    const h = await harness({ configured: false, agents: [agent(SCOPE, target)], adapterMaxTokens,
      outputCaps: [capEntry(ceiling)] });
    t.after(h.close);
    await assertCap(h, expected);
  });
}

test("absent server opt-in and legacy missing/null buildConfig preserve2048; explicit adapter default still applies", async t => {
  for (const shape of ["missing", "null", "null-target", "target128"]) {
    const record = agent();
    if (shape === "missing") delete record.buildConfig;
    if (shape === "null") record.buildConfig = null;
    if (shape === "null-target") record.buildConfig.modelParameters.maxTokens = null;
    const h = await harness({ agents: [record], omitOutputCaps: true });
    t.after(h.close);
    await assertCap(h, 2048);
  }
  const h = await harness({ configured: false, outputCaps: [], adapterMaxTokens: 1024 });
  t.after(h.close);
  await assertCap(h, 1024);
});

const invalidTokens = [
  ["zero", 0], ["negative", -1], ["fraction", 1.5], ["string", "128"], ["null", null],
  ["undefined", undefined], ["unsafe", Number.MAX_SAFE_INTEGER + 1], ["NaN", NaN],
  ["infinity", Infinity], ["object", {}], ["array", [128]], ["boolean", true],
];

for (const [label, target] of [...invalidTokens, ["above-builder-range", 4097]]) {
  test(`opted-in invalid persisted target ${label} stops before proof/SDK/provider`, async t => {
    const rawAgent = agent();
    rawAgent.buildConfig.modelParameters.maxTokens = target;
    const h = await harness({ configured: false, rawAgent });
    t.after(h.close);
    const result = await h.invoke();
    assert.equal(result.statusCode, 503, result.body);
    assert.equal(JSON.parse(result.body).code, "RUNTIME_UNAVAILABLE");
    assert.equal(h.calls.proof, 0);
    assert.equal(h.calls.wire.length, 0);
    assert.equal(h.calls.nonce.length, 0);
    assert.equal(h.calls.provider.length, 0);
  });
}

for (const shape of ["missing-build", "null-build", "missing-parameters", "null-parameters", "missing-target"]) {
  test(`configured factory opted-in ${shape} fails closed without proof or dispatch`, async t => {
    const record = agent();
    if (shape === "missing-build") delete record.buildConfig;
    if (shape === "null-build") record.buildConfig = null;
    if (shape === "missing-parameters") delete record.buildConfig.modelParameters;
    if (shape === "null-parameters") record.buildConfig.modelParameters = null;
    if (shape === "missing-target") delete record.buildConfig.modelParameters.maxTokens;
    const h = await harness({ agents: [record] });
    t.after(h.close);
    const result = await h.invoke();
    assert.equal(result.statusCode, 503, result.body);
    assert.equal(h.calls.proof, 0);
    assert.equal(h.calls.wire.length, 0);
    assert.equal(h.calls.provider.length, 0);
  });
}

test("inherited/accessor targets are not trusted and accessors are never evaluated", async t => {
  let getterCalls = 0;
  for (const parameters of [
    Object.create({ maxTokens: 128 }),
    Object.defineProperty({}, "maxTokens", { enumerable: true, get() { getterCalls += 1; return 128; } }),
  ]) {
    const rawAgent = agent();
    rawAgent.buildConfig.modelParameters = parameters;
    const h = await harness({ configured: false, rawAgent });
    t.after(h.close);
    assert.equal((await h.invoke()).statusCode, 503);
    assert.equal(h.calls.proof, 0);
    assert.equal(h.calls.provider.length, 0);
  }
  assert.equal(getterCalls, 0);
});

test("server caps are snapshotted and a persisted candidate mutation cannot raise the ceiling", async t => {
  const outputCaps = [capEntry()];
  const h = await harness({ configured: false, outputCaps });
  t.after(h.close);
  await assertCap(h, 128);
  outputCaps[0].maxTokens = 4096;
  outputCaps.length = 0;
  const stored = [...h.rows.values()].find(item => item.entityType?.S === "AGENT");
  stored.buildConfig.M.modelParameters.M.maxTokens = { N: "4096" };
  await assertCap(h, 512);
  stored.buildConfig.M.modelParameters.M.maxTokens = { NULL: true };
  assert.equal((await h.invoke()).statusCode, 503);
  assert.equal(h.calls.provider.length, 2);
});

test("exact domain/project/agent opt-in does not clamp another authorized scope", async t => {
  const scopes = [
    SCOPE, { ...SCOPE, projectId: "other-project" }, { ...SCOPE, domainId: "finance" },
    { ...SCOPE, agentId: "planner" },
  ];
  const h = await harness({ agents: scopes.map(scope => agent(scope)) });
  t.after(h.close);
  const first = await assertCap(h, 128);
  for (const scope of scopes.slice(1)) await assertCap(h, 2048, scope);
  const crossSession = await h.invoke({ sessionId: JSON.parse(first.body).sessionId }, { scope: scopes[1] });
  assert.equal(crossSession.statusCode, 404, crossSession.body);
  assert.equal(h.calls.provider.length, 4);
});

test("absent or revoked exact entitlement prevents dispatch despite a server cap", async t => {
  for (const change of ["remove", "revoke"]) {
    const h = await harness();
    t.after(h.close);
    const [key, row] = [...h.rows].find(([, item]) => item.entityType?.S === "ENTITLEMENT");
    if (change === "remove") h.rows.delete(key);
    else {
      row.status = { S: "REVOKED" };
      row.revokedBySubject = { S: "synthetic-lead" };
      row.revokedAt = { S: clock().toISOString() };
    }
    assert.equal((await h.invoke()).statusCode, 404);
    assert.equal(h.calls.proof, 0);
    assert.equal(h.calls.provider.length, 0);
  }
});

test("a cap cannot authorize another principal or an ungranted project", async t => {
  const h = await harness({ configured: false });
  t.after(h.close);
  assert.equal((await h.invoke({}, { actor: "another-user" })).statusCode, 404);
  assert.equal((await h.invoke({}, { scope: { ...SCOPE, projectId: "ungranted" } })).statusCode, 404);
  assert.equal(h.calls.proof, 0);
  assert.equal(h.calls.wire.length, 0);
  assert.equal(h.calls.provider.length, 0);
});

test("public client output-cap/scope/config overrides are rejected before dispatch", async t => {
  const h = await harness();
  t.after(h.close);
  for (const extra of [
    { maxTokens: 4096 }, { maxTokens: null }, { buildConfig: buildConfig(4096) },
    { outputCaps: [capEntry(4096)] }, { agent: agent() }, { projectId: "other-project" },
  ]) {
    const result = await h.invoke(extra);
    assert.equal(result.statusCode, 400, result.body);
  }
  assert.equal(h.calls.proof, 0);
  assert.equal(h.calls.wire.length, 0);
  assert.equal(h.calls.provider.length, 0);
  await assertCap(h, 128);
});

for (const [label, value] of [["valid-escalation", 512], ["legacy-escalation", 2048], ...invalidTokens]) {
  test(`signed cap tampering ${label} is rejected before nonce and provider`, async t => {
    const h = await harness({ tamper: sent => { sent.maxTokens = value; } });
    t.after(h.close);
    assert.equal((await h.invoke()).statusCode, 503);
    assert.equal(h.calls.wire[0].maxTokens, 128);
    assert.deepEqual(h.calls.runtimeErrors, ["INVALID_REQUEST"]);
    assert.equal(h.calls.nonce.length, 0);
    assert.equal(h.calls.provider.length, 0);
  });
}

test("configured native journaling retains the signed128 cap and measured usage", async t => {
  const h = await harness({ native: true });
  t.after(h.close);
  await assertCap(h, 128);
  assert.equal(h.calls.wire[0].accounting.attemptId, "gateway-1");
  const events = [...h.rows.values()].filter(item => item.pk.S.startsWith("NATIVE_EXECUTION_EVENT#"));
  assert.equal(events.length, 1);
  assert.ok(events[0].startedAt.S);
  assert.equal(JSON.parse(events[0].terminal.S).status, "SUCCEEDED");
  assert.equal(JSON.parse(events[0].usage.S).observation.usage.outputTokens, 1);
});

test("native missing target or signed scope/cap tampering cannot create a Runtime start", async t => {
  for (const options of [
    { agents: [agent(SCOPE, null)] },
    { tamper: sent => { sent.maxTokens = 512; } },
    { tamper: sent => { sent.session.metadata.projectId = "other-project"; } },
  ]) {
    const h = await harness({ native: true, ...options });
    t.after(h.close);
    assert.equal((await h.invoke()).statusCode, 503);
    assert.equal(h.calls.nonce.length, 0);
    assert.equal(h.calls.provider.length, 0);
    const events = [...h.rows.values()].filter(item => item.pk.S.startsWith("NATIVE_EXECUTION_EVENT#"));
    assert.equal(events.length, options.tamper ? 1 : 0);
    for (const event of events) assert.equal(event.startedAt, undefined);
  }
});

test("invalid server policies fail factory construction without SDK calls", async () => {
  const unavailable = { async send() { assert.fail("Configuration errors must not call any SDK"); } };
  const badPolicies = [
    null, {}, "", [capEntry(), capEntry()], [null],
    [{ ...capEntry(), extra: true }], [{ ...capEntry(), projectId: "*" }],
    [{ ...capEntry(), domainId: "Support" }], [{ ...capEntry(), agentId: "../triage" }],
    [{ domainId: SCOPE.domainId, projectId: SCOPE.projectId, agentId: SCOPE.agentId }],
    ...[...invalidTokens, ["above-demo-ceiling", 513]].map(([, value]) => [{ ...SCOPE, maxTokens: value }]),
  ];
  for (const raw of ["", "{", "undefined", ...badPolicies.map(value => JSON.stringify(value)), 128]) {
    await assert.rejects(createConfiguredExperienceHandler({
      env: { PLATFORM_STATE_TABLE_NAME: "Synthetic", RUNTIME_INVOCATION_PROOF_SECRET_ARN: SECRET_ARN,
        COGNITO_USER_POOL_ID: "us-west-2_synthetic", EXPERIENCE_OUTPUT_CAPS_JSON: raw },
      dynamo: unavailable, agentRuntimeClient: unavailable, cognito: unavailable, secretsClient: unavailable,
      identityVerifier: async () => false, clock,
    }), /output cap configuration is invalid/, `raw policy: ${String(raw)}`);
  }
});

test("invalid explicit adapter limits cannot silently fall back even with an opt-in", () => {
  for (const [, maxTokens] of [...invalidTokens.filter(([label]) => label !== "undefined"), ["above-adapter-range", 8193]]) {
    assert.throws(() => createAgentRuntimeAdapter({
      client: { async send() { assert.fail("invalid configuration"); } },
      proofConfigProvider: async () => PROOF_CONFIG, outputCaps: [capEntry()], maxTokens,
    }), /adapter configuration is invalid/);
  }
});

for (const modelId of ["bedrock-claude/anthropic.claude-haiku-4-5", "global.openai.gpt-6-astra"]) {
  test(`configured Experience -> signed Runtime factory -> SDK Converse sends final128: ${modelId}`, async t => {
    const h = await harness({ runtimeOnly: true, native: true, agents: [agent(SCOPE, 128, modelId)] });
    t.after(h.close);
    await assertCap(h, 128);
    assert.equal(h.calls.provider.length, 1);
    assert.match(h.calls.provider[0].url, /^https:\/\/bedrock-runtime\.us-west-2\.amazonaws\.com\/model\/.*\/converse$/);
    const row = [...h.rows.values()].find(item => item.pk.S.startsWith("NATIVE_EXECUTION_EVENT#"));
    assert.equal(JSON.parse(row.usage.S).version, 3);
    assert.equal(JSON.parse(row.usage.S).route, null);
  });
}

test("Runtime-only factory rejects forbidden models and signed model/domain/project/cap tampering before start", async t => {
  const modelId = "bedrock-claude/anthropic.claude-haiku-4-5";
  for (const options of [
    { agents: [agent(SCOPE, 128, "openai/gpt-5.5")] },
    { agents: [agent(SCOPE, 512, modelId)] },
    { tamper: sent => { sent.agentConfig.modelId = "global.openai.gpt-6-astra"; } },
    { tamper: sent => { sent.session.metadata.domainId = "finance"; } },
    { tamper: sent => { sent.session.metadata.projectId = "other"; } },
    { tamper: sent => { sent.maxTokens = 129; } },
  ]) {
    const h = await harness({ agents: [agent(SCOPE, 128, modelId)], runtimeOnly: true, native: true, ...options });
    t.after(h.close);
    assert.equal((await h.invoke()).statusCode, 503);
    assert.equal(h.calls.provider.length, 0);
    assert.equal(h.calls.nonce.length, 0);
    for (const row of h.rows.values()) if (row.pk.S.startsWith("NATIVE_EXECUTION_EVENT#")) assert.equal(row.startedAt, undefined);
  }
});
