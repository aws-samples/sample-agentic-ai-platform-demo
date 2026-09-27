import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parseYamlSubset, normalizeAgentConfig } from "./agent-config.mjs"

const SAMPLE = new URL("./samples/agent-config.retail-insights.yaml", import.meta.url).pathname
const OPTS = {
  approvedModelIds: ["global.anthropic.claude-haiku-4-5-20251001-v1:0", "global.anthropic.claude-sonnet-5"],
  knownGuardrailIds: ["pii-filter", "security-scan-gate", "pii-strict", "prompt-injection", "tone-review", "topic-restriction"],
  lockedGuardrailIds: ["pii-filter", "security-scan-gate", "tone-review"],
}

describe("agent-config", () => {
  describe("parseYamlSubset", () => {
    it("parses nested maps, lists and typed scalars", () => {
      const out = parseYamlSubset(`name: retail-insights
rag:
  datasource: retail-product-reviews
  retrieval:
    top_k: 6
    rerank: true
guardrails:
  - pii-filter
  - pii-strict
eval:
  threshold: 0.8
  golden_dataset: null
`)
      assert.deepEqual(out, {
        name: "retail-insights",
        rag: { datasource: "retail-product-reviews", retrieval: { top_k: 6, rerank: true } },
        guardrails: ["pii-filter", "pii-strict"],
        eval: { threshold: 0.8, golden_dataset: null },
      })
    })

    it("strips comments but keeps # inside quoted scalars", () => {
      const out = parseYamlSubset(`# leading comment\nname: retail   # trailing\nindex: "reviews#v3"\n`)
      assert.deepEqual(out, { name: "retail", index: "reviews#v3" })
    })

    it("dedents back to a shallower key after a nested block", () => {
      const out = parseYamlSubset(`rag:\n  index: a\nmemory:\n  scope: per-user\n`)
      assert.deepEqual(out, { rag: { index: "a" }, memory: { scope: "per-user" } })
    })

    it("rejects the constructs it does not implement, with a line number", () => {
      const bad = {
        "name: a\nrag:\n\tindex: b\n": /line 3: tabs/,
        "name: a\nguardrails: [pii-filter]\n": /line 2: flow collections/,
        "name: a\nsystem_prompt: |\n  You are helpful.\n": /line 2: block scalars/,
        "name: a\n  oops: b\n": /line 2/,
        "- pii-filter\n": /line 1: list item/,
      }
      for (const [src, re] of Object.entries(bad)) assert.throws(() => parseYamlSubset(src), re, src)
    })
  })

  describe("normalizeAgentConfig", () => {
    const base = () => ({
      name: "retail-insights",
      model: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      system_prompt: "app/chat_agent/instructions.md",
      rag: { datasource: "retail-product-reviews", index: "retail-reviews-v3", retrieval: { top_k: 6 } },
      memory: { retention_days: 30, scope: "per-user" },
      guardrails: ["pii-filter", "pii-strict", "prompt-injection"],
      eval: { golden_dataset: "eval/golden/retail-insights.jsonl", threshold: 0.8 },
    })

    it("normalizes a valid config to the wizard/harness shape", () => {
      const { ok, errors, config } = normalizeAgentConfig(base(), OPTS)
      assert.deepEqual(errors, [])
      assert.equal(ok, true)
      assert.equal(config.systemPromptFile, "app/chat_agent/instructions.md")
      assert.equal(config.rag.retrieval.topK, 6)
      assert.equal(config.memory.retentionDays, 30)
      assert.equal(config.eval.threshold, 0.8)
    })

    it("adds platform-enforced guardrails the file omits instead of honoring the omission", () => {
      const { config, warnings } = normalizeAgentConfig(base(), OPTS)
      assert.deepEqual(config.guardrails, ["pii-filter", "pii-strict", "prompt-injection"])
      assert.deepEqual(config.effectiveGuardrails, ["pii-filter", "security-scan-gate", "tone-review", "pii-strict", "prompt-injection"])
      assert.match(warnings.join(" "), /security-scan-gate, tone-review/)
    })

    it("rejects a model that is not APPROVED for the domain", () => {
      const raw = { ...base(), model: "openai.gpt-4o" }
      const { ok, errors } = normalizeAgentConfig(raw, OPTS)
      assert.equal(ok, false)
      assert.match(errors.join(" "), /not on the approved list/)
    })

    it("rejects an unknown guardrail id", () => {
      const { ok, errors } = normalizeAgentConfig({ ...base(), guardrails: ["pii-filter", "make-it-nice"] }, OPTS)
      assert.equal(ok, false)
      assert.match(errors.join(" "), /Unknown guardrail id "make-it-nice"/)
    })

    it("accepts a sequence written at its key's own indent", () => {
      const out = parseYamlSubset("guardrails:\n- pii-strict\n- prompt-injection\neval:\n  threshold: 0.8\n")
      assert.deepEqual(out, { guardrails: ["pii-strict", "prompt-injection"], eval: { threshold: 0.8 } })
    })

    it("rejects inline instructions, out-of-repo paths and bad numbers", () => {
      const cases = [
        [{ system_prompt: "You are a helpful retail analyst." }, /must be a relative file reference/],
        [{ system_prompt: "../../etc/passwd.md" }, /must be a relative file reference/],
        [{ memory: { retention_days: 900, scope: "per-user" } }, /between 1 and 365/],
        [{ memory: { retention_days: 30, scope: "per-tenant" } }, /memory.scope/],
        [{ rag: { datasource: "x", retrieval: { top_k: 0 } } }, /top_k/],
        [{ eval: { threshold: 80 } }, /write 0.8, not 80/],
        [{ name: "Retail Insights" }, /lowercase letters, digits and dashes/],
      ]
      for (const [patch, re] of cases) {
        const { ok, errors } = normalizeAgentConfig({ ...base(), ...patch }, OPTS)
        assert.equal(ok, false, JSON.stringify(patch))
        assert.match(errors.join(" "), re)
      }
    })

    it("warns about unknown top-level keys rather than failing", () => {
      const { ok, warnings } = normalizeAgentConfig({ ...base(), deploy_target: "lambda" }, OPTS)
      assert.equal(ok, true)
      assert.match(warnings.join(" "), /Ignored unknown key "deploy_target"/)
    })
  })

  // The file the recording actually imports has to survive the real pipeline.
  it("the shipped retail-insights sample parses and validates", () => {
    const { ok, errors, config } = normalizeAgentConfig(parseYamlSubset(readFileSync(SAMPLE, "utf8")), OPTS)
    assert.deepEqual(errors, [])
    assert.equal(ok, true)
    assert.equal(config.name, "retail-insights")
    assert.equal(config.systemPromptFile, "app/chat_agent/instructions.md")
    assert.equal(config.memory.scope, "per-user")
    assert.equal(config.memory.retentionDays, 30)
    assert.equal(config.eval.threshold, 0.8)
  })
})
