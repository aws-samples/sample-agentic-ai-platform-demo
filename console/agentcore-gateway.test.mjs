// Run: node --test console/agentcore-gateway.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import {
  classifyGateway,
  extractChatText,
  extractAnthropicText,
  extractModelIds,
  gatewayHost,
  gatewayInferenceUrl,
  isAnthropicMessagesModel,
  signAwsRequest,
} from "./agentcore-gateway.mjs"

test("builds AgentCore Gateway inference URLs", () => {
  assert.equal(
    gatewayHost("my-gateway-abc123def0", "us-west-2"),
    "my-gateway-abc123def0.gateway.bedrock-agentcore.us-west-2.amazonaws.com",
  )
  assert.equal(
    gatewayInferenceUrl("my-gateway-abc123def0", "us-west-2", "/v1/models"),
    "https://my-gateway-abc123def0.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1/models",
  )
})

test("classifies likely inference gateways from target names", () => {
  const gateway = { gatewayId: "gw-abcdefghij", name: "platform-ai", region: "us-west-2" }
  const withInference = classifyGateway(gateway, [{ name: "bedrock-mantle" }, { name: "openai" }])
  assert.equal(withInference.inference.likelyConfigured, true)
  assert.equal(withInference.targetCount, 2)

  const mcpOnly = classifyGateway(gateway, [{ name: "tickets" }, { name: "search_docs" }])
  assert.equal(mcpOnly.inference.likelyConfigured, false)
})

test("signs a gateway request with SigV4 headers", () => {
  const signed = signAwsRequest({
    method: "GET",
    url: "https://my-gateway-abc123def0.gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1/models",
    region: "us-west-2",
    credentials: {
      AccessKeyId: "AKIDEXAMPLE",
      SecretAccessKey: "unit-test-signing-key",
      SessionToken: "token",
    },
    now: new Date("2026-08-04T00:00:00.000Z"),
  })
  assert.equal(signed.headers["x-amz-date"], "20260804T000000Z")
  assert.equal(signed.headers["x-amz-security-token"], "token")
  assert.match(signed.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260804\/us-west-2\/bedrock-agentcore\/aws4_request/)
  assert.match(signed.headers.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token/)
  assert.match(signed.canonicalRequest, /\/inference\/v1\/models/)
})

test("extracts OpenAI-compatible model list and chat text", () => {
  assert.deepEqual(extractModelIds({
    data: [
      { id: "bedrock-mantle/anthropic.claude-opus-4-7", owned_by: "system" },
      { id: "openai/gpt-5.5", owned_by: "openai" },
      { object: "ignored" },
    ],
  }), [
    { id: "bedrock-mantle/anthropic.claude-opus-4-7", object: "model", owned_by: "system" },
    { id: "openai/gpt-5.5", object: "model", owned_by: "openai" },
  ])

  assert.equal(extractChatText({
    choices: [{ message: { content: "hello from gateway" } }],
  }), "hello from gateway")
})

test("detects Claude models and extracts Anthropic Messages text", () => {
  assert.equal(isAnthropicMessagesModel("bedrock-claude/anthropic.claude-sonnet-5"), true)
  assert.equal(isAnthropicMessagesModel("anthropic.claude-fable-5"), true)
  assert.equal(isAnthropicMessagesModel("bedrock-mantle/openai.gpt-oss-120b"), false)
  assert.equal(extractAnthropicText({
    content: [{ type: "text", text: "hello " }, { type: "text", text: "claude" }],
  }), "hello claude")
})
