import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { enrichModelsWithCatalog } from "./gateway-models.mjs"

describe("gateway-models", () => {
  describe("enrichModelsWithCatalog", () => {
    const catalogModels = [
      { id: "global.anthropic.claude-sonnet-5", label: "Claude Sonnet 5", vendor: "Anthropic", tier: "balanced", approved: true, noTemperature: true, pricing: { inputPer1k: 0.003, outputPer1k: 0.015 } },
      { id: "global.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Claude Haiku 4.5", vendor: "Anthropic", tier: "fast", approved: true, pricing: { inputPer1k: 0.0008, outputPer1k: 0.004 } },
    ]

    it("matches gateway model to catalog by stripping prefix", () => {
      const gatewayModels = [
        { id: "bedrock-claude/anthropic.claude-sonnet-5", owned_by: "anthropic", gateway: "llm-gw-claude", gatewayId: "gw-1", region: "us-east-1", api: "messages" },
      ]
      const enriched = enrichModelsWithCatalog(gatewayModels, catalogModels)
      assert.equal(enriched.length, 1)
      assert.equal(enriched[0].label, "Claude Sonnet 5")
      assert.equal(enriched[0].vendor, "Anthropic")
      assert.equal(enriched[0].tier, "balanced")
      assert.equal(enriched[0].pricing.inputPer1k, 0.003)
      assert.equal(enriched[0].runtimeModelId, "global.anthropic.claude-sonnet-5")
      assert.equal(enriched[0].catalogMatch, true)
      assert.equal(enriched[0].source, "gateway")
    })

    it("matches shorter gateway Claude IDs to dated Bedrock catalog IDs", () => {
      const gatewayModels = [
        { id: "bedrock-claude/anthropic.claude-haiku-4-5", owned_by: "system", gateway: "llm-gw-claude", gatewayId: "gw-1", region: "us-east-1", api: "messages" },
      ]
      const enriched = enrichModelsWithCatalog(gatewayModels, catalogModels)
      assert.equal(enriched[0].label, "Claude Haiku 4.5")
      assert.equal(enriched[0].vendor, "Anthropic")
      assert.equal(enriched[0].tier, "fast")
      assert.equal(enriched[0].runtimeModelId, "global.anthropic.claude-haiku-4-5-20251001-v1:0")
      assert.equal(enriched[0].catalogMatch, true)
    })

    it("generates label for models not in catalog", () => {
      const gatewayModels = [
        { id: "bedrock-mantle/openai.gpt-oss-120b", owned_by: "system", gateway: "llm-gw", gatewayId: "gw-2", region: "us-west-2", api: "chat-completions" },
      ]
      const enriched = enrichModelsWithCatalog(gatewayModels, catalogModels)
      assert.equal(enriched.length, 1)
      assert.equal(enriched[0].catalogMatch, false)
      assert.equal(enriched[0].vendor, "OpenAI")
      assert.equal(enriched[0].label, "GPT OSS 120B")
      assert.equal(enriched[0].runtimeModelId, "bedrock-mantle/openai.gpt-oss-120b")
      assert.equal(enriched[0].approved, false) // no catalog match = pending a catalog decision
    })

    it("handles empty catalog gracefully", () => {
      const gatewayModels = [
        { id: "bedrock-mantle/meta.llama-4-405b", owned_by: "meta", gateway: "llm-gw", gatewayId: "gw-3", region: "us-west-2", api: "chat-completions" },
      ]
      const enriched = enrichModelsWithCatalog(gatewayModels, [])
      assert.equal(enriched.length, 1)
      assert.equal(enriched[0].approved, false)
      assert.equal(enriched[0].pricing, null)
    })

    it("preserves gateway routing info", () => {
      const gatewayModels = [
        { id: "bedrock-claude/anthropic.claude-sonnet-5", owned_by: "anthropic", gateway: "claude-gw", gatewayId: "gw-claude", region: "us-east-1", api: "messages" },
      ]
      const enriched = enrichModelsWithCatalog(gatewayModels, catalogModels)
      assert.equal(enriched[0].gateway, "claude-gw")
      assert.equal(enriched[0].gatewayId, "gw-claude")
      assert.equal(enriched[0].region, "us-east-1")
      assert.equal(enriched[0].api, "messages")
    })
  })
})
