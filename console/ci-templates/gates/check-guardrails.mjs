// platform-gate: v1 — guardrail-config conformance check.
// Verifies the platform gate contract is intact in this repo:
//   1. gates/platform-gates.json parses and declares a sane threshold
//   2. every declared gate workflow + runner still exists and carries the
//      "platform-gate:" marker (lightweight repository conformance)
//   3. every guardrail control the export declared is still enabled — teams
//      extend guardrails, they don't switch the org baseline off
//   4. the golden dataset the eval gate scores against is present
import { readFileSync, existsSync } from "node:fs"

const failures = []
const ok = (cond, msg) => { if (!cond) failures.push(msg) }

let cfg
try { cfg = JSON.parse(readFileSync("gates/platform-gates.json", "utf8")) }
catch (e) { console.error(`GUARDRAIL CHECK FAILED\ngates/platform-gates.json missing or invalid: ${e.message}`); process.exit(1) }

ok(typeof cfg.threshold === "number" && cfg.threshold >= 0.5 && cfg.threshold <= 1,
  `eval threshold must be a number in [0.5, 1], got ${JSON.stringify(cfg.threshold)} — lowering the bar below the org floor is not allowed`)

ok(cfg.gate === "platform-gate v1",
  `gate contract must be "platform-gate v1", got ${JSON.stringify(cfg.gate)}`)

ok(["FULL", "MINIMAL", "SPEC"].includes(cfg.preset),
  `preset must be FULL, MINIMAL, or SPEC, got ${JSON.stringify(cfg.preset)}`)
ok(cfg.allowNoTests === (cfg.preset === "MINIMAL"),
  `allowNoTests must be true only for MINIMAL repositories`)

const hasRuntime = existsSync("agentcore/agentcore.json")
const hasEvaluation = existsSync("gates/run-eval.mjs")
const requiredProtectedFiles = [
  ".github/workflows/compliance.yml",
  ".github/workflows/tests.yml",
  "gates/check-guardrails.mjs",
  "gates/run-tests.mjs",
  ...(hasEvaluation ? [
    ".github/workflows/eval.yml",
    "gates/run-eval.mjs",
  ] : []),
  ...(hasRuntime ? [
    ".github/workflows/deploy-dev.yml",
    ".github/workflows/promote.yml",
    "gates/check-resource-bindings.mjs",
    "gates/guardrail-chain.mjs",
    "gates/record-transcripts.mjs",
  ] : []),
]
const protectedFiles = Array.isArray(cfg.protectedFiles)
  ? cfg.protectedFiles
  : []
ok(Array.isArray(cfg.protectedFiles),
  "protectedFiles must be an array")
for (const f of requiredProtectedFiles) {
  ok(protectedFiles.includes(f),
    `required gate file is missing from the contract: ${f}`)
}
for (const f of protectedFiles) {
  if (!existsSync(f)) { ok(false, `declared gate file missing: ${f}`); continue }
  ok(readFileSync(f, "utf8").includes("platform-gate:"),
    `declared gate file ${f} lost its "platform-gate:" marker`)
}

const controls = cfg.guardrails && typeof cfg.guardrails === "object"
  && !Array.isArray(cfg.guardrails)
  ? cfg.guardrails
  : {}
const requiredControls = hasRuntime
  ? ["content-guardrails", "secret-hygiene"]
  : ["change-governance", "secret-hygiene"]
for (const name of requiredControls) {
  ok(controls[name]?.enabled === true,
    `required guardrail control "${name}" is missing or disabled`)
}
for (const [name, control] of Object.entries(controls)) {
  ok(control.enabled === true, `guardrail control "${name}" is disabled — org baseline controls stay on`)
  if (control.verify?.file) {
    if (!existsSync(control.verify.file)) {
      ok(false, `guardrail "${name}" declares enforcement in ${control.verify.file}, but the file is missing`)
      continue
    }
    const source = readFileSync(control.verify.file, "utf8")
    for (const marker of control.verify.mustContain || []) {
      ok(source.includes(marker),
        `guardrail "${name}" enforcement marker "${marker}" is missing from ${control.verify.file}`)
    }
  }
}

if (hasRuntime) {
  let validateGuardrailChain = null
  try {
    ({ validateGuardrailChain } = await import("./guardrail-chain.mjs"))
  } catch {
    ok(false, "gates/guardrail-chain.mjs is missing or invalid")
  }
  let chain = null
  if (validateGuardrailChain) {
    try { chain = validateGuardrailChain(cfg.guardrailChain) }
    catch (error) {
      ok(false, `guardrailChain is malformed against the canonical guardrail contract: ${error.message}`)
    }
  }
  let harness
  try { harness = JSON.parse(readFileSync("domain-harness.json", "utf8")) }
  catch { ok(false, "domain-harness.json is missing or invalid") }
  if (harness && chain && validateGuardrailChain) {
    let harnessChain = null
    try { harnessChain = validateGuardrailChain(harness.guardrailChain) }
    catch (error) {
      ok(false, `domain-harness.json guardrailChain is malformed against the canonical guardrail contract: ${error.message}`)
    }
    if (harnessChain) {
      const matches = harnessChain.length === chain.length
        && chain.every((entry, index) => {
          const actual = harnessChain[index]
          return actual?.id === entry.id
            && actual?.enabled === entry.enabled
            && actual?.action === entry.action
            && actual?.runMode === entry.runMode
            && actual?.message === entry.message
            && actual?.priority === entry.priority
        })
      ok(matches,
        "domain-harness.json guardrailChain must match gates/platform-gates.json")
    }
  }
}

ok(existsSync("agentcore/datasets/golden.jsonl"),
  "golden dataset agentcore/datasets/golden.jsonl missing — the eval gate has nothing to score against")

if (failures.length) {
  console.error("GUARDRAIL CONFORMANCE FAILED\n" + failures.map(f => ` - ${f}`).join("\n"))
  process.exit(1)
}
console.log(`Guardrail conformance: PASS (${protectedFiles.length} declared gate files, ${Object.keys(controls).length} controls, threshold ${cfg.threshold})`)
