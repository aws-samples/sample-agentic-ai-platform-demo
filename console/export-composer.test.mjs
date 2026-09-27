// Unit tests for the export composer (J-T2): manifest per preset.
// Run: node --test console/export-composer.test.mjs
import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { composeManifest, composeInto, PRESETS } from "./export-composer.mjs"
import { buildInception } from "./inception.mjs"

// A tiny fake project dir: source files + junk the export must exclude.
function fakeProject() {
  const dir = mkdtempSync(join(tmpdir(), "composer-test-"))
  mkdirSync(join(dir, "app", "agent"), { recursive: true })
  writeFileSync(join(dir, "app", "agent", "main.py"), "print('hi')\n")
  mkdirSync(join(dir, "agentcore"), { recursive: true })
  writeFileSync(join(dir, "agentcore", "agentcore.json"), "{}\n")
  writeFileSync(join(dir, "agentcore", "aws-targets.json"), '[{"leaked":"target"}]\n')
  mkdirSync(join(dir, "node_modules", "junk"), { recursive: true })
  writeFileSync(join(dir, "node_modules", "junk", "x.js"), "")
  mkdirSync(join(dir, ".venv"), { recursive: true })
  writeFileSync(join(dir, ".venv", "pyvenv.cfg"), "")
  writeFileSync(join(dir, ".env.local"), "SECRET=nope\n")
  return dir
}

const ctx = () => ({ dir: fakeProject(), project: "testproj", harness: { model: "m1", skills: [], tools: [] } })

test("FULL manifest: project code + CLAUDE.md, excludes junk, resets aws-targets", () => {
  const m = composeManifest("FULL", ctx())
  const paths = m.entries.map(e => e.path)
  assert.ok(paths.includes("app/agent/main.py"), "carries app code")
  assert.ok(paths.includes("CLAUDE.md"), "carries CLAUDE.md")
  assert.ok(!paths.some(p => p.includes("node_modules") || p.includes(".venv") || p === ".env.local"),
    "excludes caches/venv/env files")
  const targets = m.entries.find(e => e.path === "agentcore/aws-targets.json")
  assert.equal(targets.kind, "generate")
  assert.equal(targets.content, "[]\n", "aws-targets reset — no deploy targets leak into the export")
  assert.ok(paths.includes("gates/check-resource-bindings.mjs"),
    "FULL exports fail closed on unresolved governed resources")
  assert.deepEqual(m.pending, [], "all FULL sections are buildable since J-T3")
})

test("FULL export carries one canonical guardrail chain and passes its own checker", async () => {
  const c = ctx()
  const stage = mkdtempSync(join(tmpdir(), "composer-guardrail-"))
  try {
    await composeInto(stage, "FULL", c)
    const harness = JSON.parse(
      readFileSync(join(stage, "domain-harness.json"), "utf8"),
    )
    const gates = JSON.parse(
      readFileSync(join(stage, "gates", "platform-gates.json"), "utf8"),
    )

    assert.equal(harness.guardrailChain.length, 5)
    assert.deepEqual(gates.guardrailChain, harness.guardrailChain)
    assert.doesNotThrow(() =>
      execFileSync(
        process.execPath,
        ["gates/check-guardrails.mjs"],
        { cwd: stage, stdio: "pipe" },
      ),
    )
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(c.dir, { recursive: true, force: true })
  }
})

test("SPEC manifest: no app code; contract + TDD skeleton + gates, nothing pending", () => {
  const m = composeManifest("SPEC", ctx())
  assert.ok(!m.entries.some(e => e.path.startsWith("app/")), "SPEC preset carries NO app code")
  const paths = m.entries.map(e => e.path)
  for (const f of ["CLAUDE.md", "SPEC.md", "tests/test_acceptance.py"])
    assert.ok(paths.includes(f), `SPEC carries ${f}`)
  assert.deepEqual(m.pending, [], "spec/tdd sections are buildable since J-T8")
})

// J-T8: the spec contract is deterministic — same inception, same files.
const INCEPTION_PROFILE = {
  name: "billing-copilot", summary: "Read-only billing Q&A for support reps.",
  targetUsers: "internal support reps", userTypes: ["internal"],
  channels: ["web console"], capabilities: ["invoice lookup", "charge explanation"],
  dataSources: ["billing API"], compliance: ["PII audit logging"],
  deployment: "AgentCore", performsActions: false,
  failureHandling: "say the API is down, suggest retry", openQuestions: ["audit log destination"],
}

test("SPEC from an inception: three-zone CLAUDE.md + SPEC.md + red TDD skeleton, deterministic", () => {
  const session = { name: "Alice", domain: "customer-support" }
  const inception = buildInception(INCEPTION_PROFILE, session, {})
  const c = { inception, project: inception.profile.name }
  const m1 = composeManifest("SPEC", c)
  const claude = m1.entries.find(e => e.path === "CLAUDE.md").content
  for (const zone of ["🔒 Foundation", "✅ Composed", "🔨 BUILD THIS"])
    assert.ok(claude.includes(zone), `CLAUDE.md has the ${zone} zone`)
  assert.ok(claude.includes("def handle(message: str") && claude.includes("Acceptance criteria"),
    "BUILD THIS zone carries the interface contract and acceptance criteria")
  const spec = m1.entries.find(e => e.path === "SPEC.md").content
  assert.ok(spec.includes("Acceptance Criteria") && spec.includes("AC-001"), "SPEC.md lists ACs")
  assert.ok(spec.includes("Risk class:"), "SPEC.md states the risk class")
  assert.doesNotMatch(`${claude}\n${spec}`, /Alice/)
  assert.match(`${claude}\n${spec}`, /authenticated builder/)
  const tdd = m1.entries.find(e => e.path === "tests/test_acceptance.py").content
  assert.ok(tdd.includes("DELIBERATELY RED") && tdd.includes("pytest.fail"),
    "TDD skeleton is honestly red until app/main.py exists")
  assert.ok(tdd.includes("test_ac_001") && tdd.includes("system prompt"),
    "one test per testable AC incl. injection resistance")
  // determinism: a second compose from the same inception is byte-identical
  const m2 = composeManifest("SPEC", c)
  assert.deepEqual(m1.entries, m2.entries, "same inception -> same contract")
})

test("SPEC acceptance text remains inert Python data", () => {
  const capability = 'triage safely"""\nimport os\nos.system("echo injected")\n"""'
  const inception = buildInception(
    { ...INCEPTION_PROFILE, capabilities: [capability] },
    { name: "Builder", domain: "customer-support" },
    {},
  )
  const tdd = composeManifest("SPEC", {
    inception,
    project: inception.profile.name,
  }).entries.find(e => e.path === "tests/test_acceptance.py").content

  assert.doesNotMatch(tdd, /\nimport os\n/)
  execFileSync(
    "python3",
    ["-c", "import sys; compile(sys.stdin.read(), '<generated>', 'exec')"],
    { input: tdd },
  )
})

test("inception scoring: complexity + risk are deterministic and reasoned", () => {
  const inc = buildInception(INCEPTION_PROFILE, { name: "Alice", domain: "customer-support" }, {})
  assert.equal(inc.complexity.level, "STANDARD")
  assert.equal(inc.risk.level, "medium")
  assert.ok(inc.risk.factors.some(f => /compliance/.test(f.why)), "risk factors carry the why")
  assert.ok(/PII/.test(inc.recommendations.guardrailProfile.choice), "PII compliance -> masking profile")
  // read-only + internal + no compliance = low risk
  const low = buildInception({ ...INCEPTION_PROFILE, compliance: [] }, { name: "A", domain: null }, {})
  assert.equal(low.risk.level, "low")
})

test("recommendations respect the catalog compatibility matrix", () => {
  const options = {
    framework: ["Strands", "LangGraph"], deployTarget: ["AgentCore Runtime", "AWS Lambda"],
    compatibility: { LangGraph: { "AWS Lambda": "graphs exceed Lambda limits" } },
  }
  const inc = buildInception({ ...INCEPTION_PROFILE, deployment: "AWS Lambda",
    capabilities: ["multi-agent orchestration"] }, { name: "A", domain: null }, options)
  assert.equal(inc.recommendations.framework.choice, "LangGraph", "orchestration -> LangGraph")
  assert.equal(inc.recommendations.hosting.choice, "AgentCore Runtime", "incompatible pairing remapped")
  assert.ok(/incompatible/.test(inc.recommendations.hosting.why), "remap reason stated")
})

// J-T10: the from-scratch pack — org-mandated minimum, nothing else.
test("MINIMAL manifest: gates + top-level gate-rules README only, single-digit file count", () => {
  const m = composeManifest("MINIMAL", ctx())
  const paths = m.entries.map(e => e.path)
  assert.ok(!paths.some(p => p.startsWith("app/") || p === "CLAUDE.md" || p === "SPEC.md"),
    "no app code, no spec contract")
  assert.deepEqual(m.pending, [], "all MINIMAL sections are buildable since J-T10")
  assert.ok(paths.includes("README.md"), "top-level README is the one-page gate rules")
  assert.ok(!paths.includes("gates/README.md"), "no duplicate gate doc — the top-level README IS it")
  assert.ok(m.entries.length <= 9, `single-digit file count (got ${m.entries.length})`)
  const readme = m.entries.find(e => e.path === "README.md").content
  for (const s of ["eval.yml", "tests.yml", "compliance.yml", "org-mandated minimum",
    "gates/transcripts/", "golden.jsonl", "threshold", "Placeholders"])
    assert.ok(readme.includes(s), `scratch README mentions ${s}`)
})

test("MINIMAL scratch README is honest about a carried (non-seeded) dataset", () => {
  const c = ctx()
  mkdirSync(join(c.dir, "agentcore", "datasets"), { recursive: true })
  writeFileSync(join(c.dir, "agentcore", "datasets", "golden.jsonl"),
    '{"scenario_id":"real","turns":[{"input":"hi"}],"assertions":["greets"]}\n')
  const readme = composeManifest("MINIMAL", c).entries.find(e => e.path === "README.md").content
  assert.ok(readme.includes("carried as-is") && !readme.includes("Placeholders"),
    "README must not call a real dataset a placeholder")
})

// J-T3: the CI gate is ONE shared section, identical enforcement set in all presets.
const GATE_FILES = [
  ".github/workflows/eval.yml", ".github/workflows/tests.yml", ".github/workflows/compliance.yml",
  "gates/run-eval.mjs", "gates/run-tests.mjs", "gates/check-guardrails.mjs",
  "gates/platform-gates.json",
]

test("gates section: same gate files in every preset", () => {
  const c = ctx()
  for (const preset of Object.keys(PRESETS)) {
    const paths = composeManifest(preset, c).entries.map(e => e.path)
    for (const f of GATE_FILES) assert.ok(paths.includes(f), `${preset} carries ${f}`)
    assert.equal(
      paths.includes("gates/guardrail-chain.mjs"),
      preset === "FULL",
      `${preset} carries the runtime guardrail contract only when it exports an Agent`,
    )
    assert.ok(paths.includes("agentcore/datasets/golden.jsonl"), `${preset} carries a golden dataset`)
    // gate rules doc: next to the runners in FULL/SPEC, as the repo README in MINIMAL
    assert.ok(paths.includes(preset === "MINIMAL" ? "README.md" : "gates/README.md"),
      `${preset} carries the gate rules doc`)
  }
})

test("gates: platform-gates.json declares threshold, protected files and enabled controls", () => {
  const m = composeManifest("MINIMAL", ctx())
  const cfg = JSON.parse(m.entries.find(e => e.path === "gates/platform-gates.json").content)
  assert.ok(cfg.threshold >= 0.5 && cfg.threshold <= 1)
  // READMEs are docs (teams may extend them); the enforcement files are protected.
  for (const f of GATE_FILES.filter(f => f !== "gates/platform-gates.json"))
    assert.ok(cfg.protectedFiles.includes(f), `protects ${f}`)
  assert.ok(Object.values(cfg.guardrails).every(g => g.enabled === true), "org baseline controls all on")
  assert.equal(cfg.evalRoleArn, null, "deployment-specific eval role is not exported")
  assert.equal(cfg.protectedFiles.includes("gates/platform-gates.json"), false)
  assert.doesNotMatch(JSON.stringify(cfg), /\b[0-9]{12}\b/)
})

test("non-runtime presets declare only repository controls", () => {
  const inception = buildInception(
    INCEPTION_PROFILE,
    { name: "ignored", domain: "customer-support" },
    {},
  )
  for (const [preset, input] of [
    ["MINIMAL", { project: "foundation-only" }],
    ["SPEC", { project: inception.profile.name, inception }],
  ]) {
    const manifest = composeManifest(preset, input)
    const gate = manifest.entries.find(e => e.path === "gates/platform-gates.json")
    const cfg = JSON.parse(gate.content)
    assert.equal(Object.hasOwn(cfg.guardrails, "content-guardrails"), false)
    assert.equal(cfg.allowNoTests, preset === "MINIMAL")
  }
})

test("gates: README documents the three workflows and local run commands", () => {
  const m = composeManifest("FULL", ctx())
  const readme = m.entries.find(e => e.path === "gates/README.md").content
  for (const s of ["eval.yml", "tests.yml", "compliance.yml", "run-eval.mjs", "gates/transcripts/", "golden.jsonl", "threshold"])
    assert.ok(readme.includes(s), `README mentions ${s}`)
  assert.doesNotMatch(readme, /policy engine backing|verified against actual state/i)
  assert.match(readme, /configuration conformance/i)
})

test("gates: project golden dataset is carried once (copy), seeded when absent", () => {
  const withGolden = ctx()
  mkdirSync(join(withGolden.dir, "agentcore", "datasets"), { recursive: true })
  writeFileSync(join(withGolden.dir, "agentcore", "datasets", "golden.jsonl"),
    '{"scenario_id":"real","turns":[{"input":"hi"}],"assertions":["greets"]}\n')
  const full = composeManifest("FULL", withGolden)
  const goldenEntries = full.entries.filter(e => e.path === "agentcore/datasets/golden.jsonl")
  assert.equal(goldenEntries.length, 1, "no duplicate golden entry between code and gates sections")
  assert.equal(goldenEntries[0].kind, "copy", "project's own dataset wins")

  const minimal = composeManifest("MINIMAL", ctx())
  const seeded = minimal.entries.find(e => e.path === "agentcore/datasets/golden.jsonl")
  assert.equal(seeded.kind, "generate", "no project dataset -> seeded placeholders")
  const scenarios = seeded.content.trim().split("\n").map(l => JSON.parse(l))
  assert.ok(scenarios.length >= 3 && scenarios.length <= 5, "3-5 baseline scenarios")
  assert.ok(scenarios.every(s => s.checks?.length && s.assertions?.length),
    "every seed scenario has deterministic checks (credless mode) and judge assertions")
})

test("FULL export ships telemetry reporting without inheriting an account bucket", () => {
  const m = composeManifest("FULL", ctx())
  const paths = m.entries.map(e => e.path)
  assert.ok(paths.includes(".github/workflows/report-telemetry.yml"), "FULL carries report-telemetry.yml")
  assert.ok(paths.includes("gates/report-run.mjs"), "FULL carries the report-run runner")
  const cfg = JSON.parse(m.entries.find(e => e.path === "gates/platform-gates.json").content)
  assert.equal(cfg.telemetryBucket, null, "exports must not inherit another account’s telemetry bucket")
  for (const preset of ["SPEC", "MINIMAL"]) {
    const mp = composeManifest(preset, ctx())
    assert.ok(!mp.entries.some(e => e.path === ".github/workflows/report-telemetry.yml"),
      `${preset} does not carry the telemetry workflow`)
    const pcfg = JSON.parse(mp.entries.find(e => e.path === "gates/platform-gates.json").content)
    assert.equal(Object.hasOwn(pcfg, "telemetryBucket"), false, `${preset} declares no telemetry bucket`)
  }
})

test("unknown preset throws", () => {
  assert.throws(() => composeManifest("MEGA", ctx()), /Unknown export preset/)
})

test("presets map to the three doors", () => {
  assert.equal(PRESETS.FULL.door, "blueprint")
  assert.equal(PRESETS.SPEC.door, "plato")
  assert.equal(PRESETS.MINIMAL.door, "scratch")
})

test("composeInto materializes the FULL manifest into a clean stage", async () => {
  const c = ctx()
  const stage = mkdtempSync(join(tmpdir(), "composer-stage-"))
  writeFileSync(join(stage, "leftover.txt"), "stale")
  await composeInto(stage, "FULL", c)
  assert.ok(!existsSync(join(stage, "leftover.txt")), "stage is wiped first")
  assert.ok(existsSync(join(stage, "app", "agent", "main.py")))
  assert.equal(readFileSync(join(stage, "agentcore", "aws-targets.json"), "utf8"), "[]\n")
  const claude = readFileSync(join(stage, "CLAUDE.md"), "utf8")
  assert.ok(claude.includes("testproj") && claude.includes("Foundation Harness"))
  assert.ok(claude.includes("Platform CI gate") && claude.includes("gates/README.md"),
    "CLAUDE.md tells the assistant about the CI gate")
  rmSync(stage, { recursive: true, force: true })
  rmSync(c.dir, { recursive: true, force: true })
})
