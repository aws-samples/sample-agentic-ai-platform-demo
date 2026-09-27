import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { AGENT_CONFIG_SCHEMA, schemaKeywordGaps, validateAgentConfigYaml, formatIssue } from "./agent-config-schema.mjs"
import { parseYamlWithLines } from "./agent-config.mjs"

const SAMPLE = new URL("./samples/agent-config.retail-insights.yaml", import.meta.url).pathname
// The org + domain enforced set the console passes in at import time.
const LOCKED = ["pii-filter", "security-scan-gate", "tone-review"]
const check = text => validateAgentConfigYaml(text, { lockedGuardrailIds: LOCKED })

// Every fixture asserts the PATH and the LINE, not just that something failed —
// a validator that says "invalid" without pointing at the field is the thing
// this module exists to replace.
const at = (result, path) => {
  const hit = result.issues.find(i => i.path === path)
  assert.ok(hit, `no issue for path "${path}" — got ${JSON.stringify(result.issues)}`)
  return hit
}

describe("agent-config schema", () => {
  it("uses only keywords the validator implements", () => {
    // Guards against adding a constraint to the schema file that would then be
    // silently unchecked.
    assert.deepEqual(schemaKeywordGaps(), [])
  })

  it("is the committed source of truth for the keys the import parses", () => {
    assert.equal(AGENT_CONFIG_SCHEMA.additionalProperties, false)
    assert.deepEqual(Object.keys(AGENT_CONFIG_SCHEMA.properties), ["name", "model", "system_prompt", "rag", "memory", "guardrails", "eval", "output"])
    assert.deepEqual(AGENT_CONFIG_SCHEMA.required, ["name"])
  })

  it("accepts the shipped retail-insights sample", () => {
    const r = check(readFileSync(SAMPLE, "utf8"))
    assert.deepEqual(r.issues, [])
    assert.equal(r.ok, true)
    // and the parse the wizard consumes is the same one that was validated
    assert.equal(r.value.name, "retail-insights")
    assert.equal(r.value.rag.retrieval.top_k, 6)
    assert.equal(r.lines["rag.retrieval.top_k"], 21)
  })

  it("accepts a minimal config and the optional output contract", () => {
    const r = check("name: retail-insights\noutput:\n  schema: app/chat_agent/response.schema.json\n")
    assert.deepEqual(r.issues, [])
    assert.equal(r.ok, true)
  })

  // --- the invalid fixtures ------------------------------------------------

  it("wrong type: reports the path and line of the offending scalar", () => {
    const r = check(`name: retail-insights
model: global.anthropic.claude-haiku-4-5-20251001-v1:0
rag:
  datasource: retail-product-reviews
  retrieval:
    top_k: many
`)
    assert.equal(r.ok, false)
    const i = at(r, "rag.retrieval.top_k")
    assert.equal(i.line, 6)
    assert.match(i.message, /must be a whole number, got string/)
  })

  it("missing required: a top-level omission lands on line 1, a nested one on its block", () => {
    const top = check("model: global.anthropic.claude-haiku-4-5-20251001-v1:0\n")
    assert.equal(top.ok, false)
    assert.deepEqual(at(top, "name"), { path: "name", line: 1, message: "is required." })

    const nested = check("name: retail-insights\nrag:\n  index: retail-reviews-v3\n")
    assert.equal(nested.ok, false)
    // No line of its own, so it is reported against the `rag:` block that
    // should have carried it.
    assert.deepEqual(at(nested, "rag.datasource"), { path: "rag.datasource", line: 2, message: "is required." })
  })

  it("unknown field: rejected at the top level and inside a nested block", () => {
    const top = check("name: retail-insights\ndeploy_target: lambda\n")
    assert.equal(top.ok, false)
    const i = at(top, "deploy_target")
    assert.equal(i.line, 2)
    assert.match(i.message, /is not a field an agent config carries here/)

    const nested = check("name: retail-insights\nrag:\n  datasource: retail-product-reviews\n  retrieval:\n    topk: 6\n")
    assert.equal(nested.ok, false)
    assert.equal(at(nested, "rag.retrieval.topk").line, 5)
    assert.match(at(nested, "rag.retrieval.topk").message, /allowed: top_k, rerank/)
  })

  it("locked-baseline override: a reserved platform key is rejected, not ignored", () => {
    const r = check("name: retail-insights\nidentity:\n  role: platform-admin\n")
    assert.equal(r.ok, false)
    const i = at(r, "identity")
    assert.equal(i.line, 2)
    assert.match(i.message, /platform-enforced baseline field/)
    assert.match(i.message, /may not set or override it/)
  })

  it("locked-baseline override: disabling an enforced guardrail is rejected per guardrail", () => {
    const r = check(`name: retail-insights
guardrails:
  pii-filter: false
  tone-review: false
`)
    assert.equal(r.ok, false)
    assert.equal(r.issues.length, 2, "one issue per enforced guardrail, and nothing else")
    assert.equal(at(r, "guardrails.pii-filter").line, 3)
    assert.equal(at(r, "guardrails.tone-review").line, 4)
    assert.match(at(r, "guardrails.pii-filter").message, /platform-enforced guardrail baseline/)
    assert.match(at(r, "guardrails.pii-filter").message, /List the guardrails you are ADDING/)
  })

  it("a guardrail block that names no enforced guardrail is just the wrong shape", () => {
    // The baseline message is reserved for the privilege violation; a plain
    // mis-written list still gets the ordinary type error.
    const r = check("name: retail-insights\nguardrails:\n  pii-strict: false\n")
    assert.equal(r.ok, false)
    const i = at(r, "guardrails")
    assert.equal(i.line, 2)
    assert.match(i.message, /must be a list, got a block/)
  })

  it("malformed YAML: reported on its line in the same issue shape", () => {
    const r = check("name: retail-insights\nrag:\n\tindex: retail-reviews-v3\n")
    assert.equal(r.ok, false)
    assert.equal(r.issues.length, 1)
    assert.equal(r.issues[0].line, 3)
    assert.match(r.issues[0].message, /tabs are not valid YAML indentation/)
    // and the "line N:" prefix is not duplicated inside the message
    assert.doesNotMatch(r.issues[0].message, /^line \d+:/)
  })

  it("malformed YAML: the constructs the subset does not implement each carry a line", () => {
    const cases = [
      ["name: retail-insights\nguardrails: [pii-strict]\n", 2, /flow collections/],
      ["name: retail-insights\nsystem_prompt: |\n  You are a retail analyst.\n", 2, /block scalars/],
      ["name: retail-insights\n---\nname: other\n", 2, /multi-document/],
    ]
    for (const [src, line, re] of cases) {
      const r = check(src)
      assert.equal(r.ok, false, src)
      assert.equal(r.issues[0].line, line, src)
      assert.match(r.issues[0].message, re)
    }
  })

  it("out-of-range and bad-format scalars: threshold, slug, prompt reference", () => {
    const cases = [
      ["name: retail-insights\neval:\n  threshold: 80\n", "eval.threshold", 3, /must be at most 1 \(got 80\)/],
      ["name: retail-insights\neval:\n  threshold: 0\n", "eval.threshold", 3, /must be greater than 0/],
      ["name: retail-insights\nmemory:\n  retention_days: 900\n", "memory.retention_days", 3, /at most 365/],
      ["name: retail-insights\nmemory:\n  scope: per-tenant\n", "memory.scope", 3, /must be one of per-user, per-session, shared/],
      ["name: Retail Insights\n", "name", 1, /lowercase letters, digits and dashes/],
      ["name: retail-insights\nsystem_prompt: You are a retail analyst.\n", "system_prompt", 2, /relative .md/],
      ["name: retail-insights\nsystem_prompt: ../../etc/passwd.md\n", "system_prompt", 2, /relative .md/],
    ]
    for (const [src, path, line, re] of cases) {
      const r = check(src)
      assert.equal(r.ok, false, src)
      assert.equal(at(r, path).line, line, src)
      assert.match(at(r, path).message, re, src)
    }
  })

  it("a duplicated guardrail is reported on the repeated line, not the list", () => {
    const r = check("name: retail-insights\nguardrails:\n  - pii-strict\n  - prompt-injection\n  - pii-strict\n")
    assert.equal(r.ok, false)
    assert.equal(at(r, "guardrails[2]").line, 5)
  })

  it("reports every independent problem in one pass", () => {
    const r = check(`name: retail-insights
deploy_target: lambda
rag:
  retrieval:
    top_k: 99
`)
    assert.equal(r.ok, false)
    assert.deepEqual(r.issues.map(i => `${i.path}@${i.line}`).sort(), ["deploy_target@2", "rag.datasource@3", "rag.retrieval.top_k@5"])
  })

  it("formatIssue puts the line in front of a flat error string", () => {
    const r = check("name: retail-insights\neval:\n  threshold: 80\n")
    assert.equal(formatIssue(r.issues[0]), "line 3 · eval.threshold — must be at most 1 (got 80).")
  })
})

describe("parseYamlWithLines", () => {
  it("maps nested keys and list items to their 1-based lines", () => {
    const { value, lines } = parseYamlWithLines(`name: retail-insights

rag:
  datasource: retail-product-reviews
  retrieval:
    top_k: 6
guardrails:
  - pii-strict
  - prompt-injection
`)
    assert.equal(value.rag.retrieval.top_k, 6)
    assert.deepEqual(lines, {
      name: 1,
      rag: 3,
      "rag.datasource": 4,
      "rag.retrieval": 5,
      "rag.retrieval.top_k": 6,
      guardrails: 7,
      "guardrails[0]": 8,
      "guardrails[1]": 9,
    })
  })

  it("attaches the line, and the enclosing block, to a syntax error", () => {
    assert.throws(() => parseYamlWithLines("rag:\n  datasource: d\n  - oops\n"), e => {
      assert.equal(e.line, 3)
      assert.equal(e.path, "rag")
      return true
    })
  })
})
