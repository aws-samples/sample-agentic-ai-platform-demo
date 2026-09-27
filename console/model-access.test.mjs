import test from "node:test"
import assert from "node:assert/strict"
import {
  resolveModelPolicy,
  evaluateModelAccess,
  buildRateLimitPlan,
} from "./model-access.mjs"

const config = {
  version: 1,
  identityDimension: "$.context.jwt.team",
  policies: [
    {
      id: "opus",
      modelPattern: "*opus*",
      allowedDomains: ["platform"],
      requestableDomains: ["operations"],
      rateLimitProfile: { requestsPerMinute: 10, tokensPerMinute: 10000, connectionsPerSecond: 2 },
    },
    {
      id: "sonnet",
      modelPattern: "*sonnet*",
      allowedDomains: ["customer-support", "operations", "platform"],
      requestableDomains: ["*"],
      rateLimitProfile: { requestsPerMinute: 80, tokensPerMinute: 250000, connectionsPerSecond: 20 },
    },
    {
      id: "default",
      modelPattern: "*",
      allowedDomains: ["platform"],
      requestableDomains: [],
      rateLimitProfile: { requestsPerMinute: 50, tokensPerMinute: 120000, connectionsPerSecond: 12 },
    },
  ],
}

const domains = [{ id: "platform" }, { id: "customer-support" }, { id: "operations" }]

test("resolveModelPolicy picks the most specific matching pattern", () => {
  assert.equal(resolveModelPolicy("bedrock-claude/anthropic.claude-opus-4-8", config).id, "opus")
  assert.equal(resolveModelPolicy("bedrock-claude/anthropic.claude-sonnet-5", config).id, "sonnet")
  assert.equal(resolveModelPolicy("vendor/other-model", config).id, "default")
})

test("allowed domains can use a model; requestable domains can see but not use it", () => {
  const allowed = evaluateModelAccess({
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    domain: "customer-support",
    domains,
    config,
  })
  assert.equal(allowed.visible, true)
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.status, "allowed")

  const requestable = evaluateModelAccess({
    modelId: "bedrock-claude/anthropic.claude-opus-4-8",
    domain: "operations",
    domains,
    config,
  })
  assert.equal(requestable.visible, true)
  assert.equal(requestable.allowed, false)
  assert.equal(requestable.requestable, true)
  assert.equal(requestable.status, "requestable")
})

test("approved domain grant temporarily allows a restricted model", () => {
  const access = evaluateModelAccess({
    modelId: "bedrock-claude/anthropic.claude-opus-4-8",
    domain: "operations",
    activeDomainGrant: { id: "grant-1", status: "approved", expiresAt: "2099-01-01T00:00:00.000Z" },
    domains,
    config,
  })
  assert.equal(access.allowed, true)
  assert.equal(access.status, "grant-approved")
})

test("rate limit plan expands allowed domains into AgentCore Gateway dimensions", () => {
  const plan = buildRateLimitPlan({
    model: { id: "bedrock-claude/anthropic.claude-sonnet-5" },
    policy: resolveModelPolicy("bedrock-claude/anthropic.claude-sonnet-5", config),
    domains,
    identityDimension: config.identityDimension,
  })
  assert.deepEqual(plan.entries[0].dimensionKeys, ["qualifiedModelId", "$.context.jwt.team"])
  assert.equal(plan.entries[0].requestLimit.rate, 80)
  assert.equal(plan.entries[0].tokenLimit.rate, 250000)
  assert.ok(plan.entries[0].dimensions.some(d => d["$.context.jwt.team"] === "customer-support"))
  assert.equal(plan.entries[1].connectionLimit.rate, 20)
})
