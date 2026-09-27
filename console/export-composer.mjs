import {evaluationAssets} from './evaluation-assets.mjs'
// Export composer — ONE implementation, three presets (J-T2).
// The Build tab's three doors exit through the same gate: what differs per
// journey is only WHAT gets packaged, expressed here as preset section lists.
//   FULL    (Blueprint door): project code + CLAUDE.md + CI gates
//   SPEC    (Plato door):     spec contract + TDD skeleton + CI gates, NO app code
//   MINIMAL (scratch door):   CI gates + gate-rules README only
// Section builders: sections without a generator are reported under `pending`,
// never silently claimed. All sections are first-party since J-T10.

import { cp, rm, writeFile, mkdir } from "node:fs/promises"
import { readdirSync, existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { specSection, tddSection } from "./inception.mjs"
import { codeLocationFor, testIdentityPy, testMemoryLocalPy, testMultiturnPy } from "./tdd-app-tests.mjs"
import {
  platformGateContract,
  starterGoldenDataset,
} from "./export-contract.mjs"
import {
  defaultGuardrailChain,
  validateGuardrailChain,
} from "./public/guardrail-chain.mjs"

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "ci-templates")
const GUARDRAIL_CONTRACT = join(
  dirname(fileURLToPath(import.meta.url)),
  "public",
  "guardrail-chain.mjs",
)

export const PRESETS = {
  FULL:    { door: "blueprint", sections: ["code", "claudemd", "tddApp", "gates", "gatesDoc"] },
  SPEC:    { door: "plato",     sections: ["spec", "tdd", "gates", "gatesDoc"] },
  MINIMAL: { door: "scratch",   sections: ["gates", "gateReadme"] },
}

// Same exclusion set the export has always used: no caches, venvs, deps,
// build artifacts, local env files or nested git state in the exported repo.
const EXCLUDE = /\/(\.cache|\.venv|node_modules|\.cli|__pycache__|cdk\.out|dist|\.git)(\/|$)|\.pyc$|\.env\.local$|uv\.lock$/

function fullGuardrailChain(ctx) {
  return ctx.harness?.guardrailChain == null
    ? defaultGuardrailChain()
    : validateGuardrailChain(ctx.harness.guardrailChain)
}

function exportedHarness(ctx) {
  return `${JSON.stringify({
    ...(ctx.harness || {}),
    guardrailChain: fullGuardrailChain(ctx),
  }, null, 2)}\n`
}

function walkProject(dir, rel = "") {
  const out = []
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    const abs = join(dir, relPath)
    if (EXCLUDE.test(abs)) continue
    if (entry.isDirectory()) out.push(...walkProject(dir, relPath))
    else out.push({ path: relPath, kind: "copy", from: abs })
  }
  return out
}

// Section builders. Each returns manifest entries:
//   { path, kind: "copy", from }          — file taken from the project dir
//   { path, kind: "generate", content }   — file the composer writes
const builders = {
  code(ctx) {
    const entries = walkProject(ctx.dir)
    const harnessPath = "domain-harness.json"
    const harness = {
      path: harnessPath,
      kind: "generate",
      content: exportedHarness(ctx),
    }
    const harnessIndex = entries.findIndex(entry => entry.path === harnessPath)
    if (harnessIndex >= 0) entries[harnessIndex] = harness
    else entries.push(harness)
    // Exported repo starts with no AWS deploy targets of ours.
    if (existsSync(join(ctx.dir, "agentcore"))) {
      const p = "agentcore/aws-targets.json"
      const i = entries.findIndex(e => e.path === p)
      const reset = { path: p, kind: "generate", content: "[]\n" }
      if (i >= 0) entries[i] = reset
      else entries.push(reset)
    }
    return entries
  },
  claudemd(ctx) {
    return [{ path: "CLAUDE.md", kind: "generate", content: claudeMd(ctx.project, ctx.harness) }]
  },
  // The FULL door ships an app, so it should not start from a zero-test
  // baseline either — the SPEC door's TDD skeleton already
  // covers spec-only exports; FULL gets real, runnable unit tests for the
  // three Foundation Harness capabilities that were previously silent no-ops
  // (identity headers, memory local fallback, multi-turn context).
  tddApp(ctx) {
    const codeLocation = codeLocationFor(ctx)
    if (!codeLocation) return []
    const base = `${codeLocation}/tests`
    return [
      { path: `${base}/test_identity.py`, kind: "generate", content: testIdentityPy() },
      { path: `${base}/test_memory_local.py`, kind: "generate", content: testMemoryLocalPy() },
      { path: `${base}/test_multiturn.py`, kind: "generate", content: testMultiturnPy() },
    ]
  },
  // The shared CI gate (J-T3): identical across all three presets. Workflows +
  // runner scripts are copied from console/ci-templates; the per-repo contract
  // (threshold, judge model, protected files, guardrail controls) is generated.
  gates(ctx) {
    const entries = []
    for (const wf of ["eval.yml", "tests.yml", "compliance.yml"])
      entries.push({ path: `.github/workflows/${wf}`, kind: "copy", from: join(TEMPLATES, wf) })
    // CD workflows + the transcript recorder ship with the FULL preset only:
    // SPEC/MINIMAL have no deployable app code yet, so `agentcore dev` has
    // nothing to record against and a deploy workflow would just fail on push
    // (also keeps the MINIMAL door's single-digit file-count invariant intact).
    if (ctx.preset === "FULL") for (const wf of ["deploy-dev.yml", "promote.yml", "report-telemetry.yml"])
      entries.push({ path: `.github/workflows/${wf}`, kind: "copy", from: join(TEMPLATES, wf) })
    const runners = ["run-eval.mjs", "run-tests.mjs", "check-guardrails.mjs"]
    if (ctx.preset === "FULL") {
      runners.push("check-resource-bindings.mjs", "record-transcripts.mjs", "report-run.mjs")
    }
    for (const runner of runners)
      entries.push({ path: `gates/${runner}`, kind: "copy", from: join(TEMPLATES, "gates", runner) })
    if (ctx.preset === "FULL") {
      entries.push({
        path: "gates/guardrail-chain.mjs",
        kind: "copy",
        from: GUARDRAIL_CONTRACT,
      })
    }
    entries.push({ path: "gates/platform-gates.json", kind: "generate", content: platformGates(ctx) })
    // The eval gate needs a golden dataset in every preset: carry the
    // project's if it has one, otherwise seed smoke placeholders to fill.
    // Inception-born exports (Plato door) have no project dir at all.
    const golden = ctx.dir && join(ctx.dir, "agentcore", "datasets", "golden.jsonl")
    entries.push(golden && existsSync(golden)
      ? { path: "agentcore/datasets/golden.jsonl", kind: "copy", from: golden }
      : { path: "agentcore/datasets/golden.jsonl", kind: "generate", content: starterGoldenDataset() })
    return entries
  },
  // J-T8: spec-first contract (CLAUDE.md v2 three-zone + SPEC.md) and the
  // deliberately-red TDD acceptance skeleton, generated from the inception
  // contract in ctx.inception (or derived from the harness when absent).
  spec: specSection,
  tdd: tddSection,
  // Gate rules doc next to the runners (FULL/SPEC). MINIMAL keeps its file
  // count single-digit: its top-level README (gateReadme) IS the gate rules.
  gatesDoc(ctx) {
    return [{ path: "gates/README.md", kind: "generate", content: gatesReadme(ctx.project) }]
  },
  // J-T10: from-scratch journey — the org-mandated minimum has no code and no
  // spec, so the repo's own README is the one-page gate rules.
  gateReadme(ctx) {
    return [{ path: "README.md", kind: "generate", content: scratchReadme(ctx) }]
  },
}

// Pure manifest: which files a preset packages for this project context.
export function composeManifest(preset, ctx) {
  const def = PRESETS[preset]
  if (!def) throw new Error(`Unknown export preset: ${preset}`)
  ctx = { ...ctx, preset }
  const entries = []
  const pending = []
  const seen = new Set()
  for (const s of def.sections) {
    if (!builders[s]) { pending.push(s); continue }
    // First section to claim a path wins (e.g. FULL's code section already
    // carries the golden dataset; the gates section must not duplicate it).
    for (const e of builders[s](ctx)) {
      if (seen.has(e.path)) continue
      seen.add(e.path)
      entries.push(e)
    }
  }
  if(preset === "FULL" && ctx.evaluation){
    for(const file of evaluationAssets(ctx.evaluation,{starterDataset:ctx.harness?.evaluationDataset})){
      const index=entries.findIndex(e=>e.path===file.path);
      const entry={...file,kind:"generate"};
      if(file.path==="AGENTS.md"&&index>=0){const prior=entries[index];entry.content=(prior.content??readFileSync(prior.from,"utf8"))+"\n"+entry.content;}
      if(index>=0)entries[index]=entry;else entries.push(entry);
    }
  }
  return { preset, entries, pending }
}

// Materialize a preset's manifest into a clean staging directory.
export async function composeInto(stage, preset, ctx) {
  const manifest = composeManifest(preset, ctx)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  for (const e of manifest.entries) {
    const dest = join(stage, e.path)
    await mkdir(dirname(dest), { recursive: true })
    if (e.kind === "copy") await cp(e.from, dest)
    else await writeFile(dest, e.content)
  }
  return manifest
}

// Per-repo gate contract, consumed by the gate runners and verified intact by
// check-guardrails.mjs. Guardrail controls come from the blueprint template
// when known; the org baseline (all on) otherwise.
function platformGates(ctx) {
  const t = (ctx.harness || {}).template || {}
  return platformGateContract({
    project: ctx.project,
    preset: ctx.preset,
    template: t,
    guardrailChain: ctx.preset === "FULL"
      ? fullGuardrailChain(ctx)
      : undefined,
  })
}

// The one-page gate rules, shared by both README shapes: what blocks a PR,
// how to run the gates locally, how to extend the dataset.
function gateRules() {
  return `Three GitHub Actions workflows gate every PR — the same gate for every
repo exported from the platform:

| Workflow | What it checks | Blocks merge when |
| --- | --- | --- |
| \`eval.yml\` | Scores \`gates/transcripts/<scenario_id>.txt\` against the golden dataset (\`agentcore/datasets/golden.jsonl\`) | score < threshold in \`gates/platform-gates.json\` |
| \`tests.yml\` | Your unit/TDD test suite | any test fails |
| \`compliance.yml\` | Gate config intact + guardrail controls enabled + secret scan (gitleaks) | config weakened, control disabled, or a secret found |

## Run the gates locally

\`\`\`bash
node gates/run-tests.mjs
node gates/check-guardrails.mjs
node gates/run-eval.mjs --mode assert     # deterministic checks, no AWS creds
node gates/run-eval.mjs --mode judge      # + LLM judge (needs Bedrock creds)
\`\`\`

## Gate philosophy

Each gate fails closed, on purpose, in its own way:

- **tests** — zero detected tests FAILS (not a warning). Add tests, or add
  \`"allowNoTests": true\` to \`gates/platform-gates.json\` to exempt explicitly —
  the exemption is visible in the gate contract, never a silent default.
- **eval** — zero scoreable units (no transcripts, no checks) FAILS. See below.
- **compliance** — anti-tamper: a weakened gate contract or disabled guardrail
  control fails the gate, same as a real secret leak. For runnable repositories,
  the canonical guardrail chain must pass configuration conformance and match
  both \`platform-gates.json\` and \`domain-harness.json\`. Runtime attachment
  remains an explicit deployment concern.

The eval gate scores committed transcripts. For each scenario in the golden
dataset, put the agent's reply in \`gates/transcripts/<scenario_id>.txt\`.
Missing transcripts score 0 — the gate never passes vacuously.

## Recording transcripts locally

\`\`\`bash
agentcore dev --logs                      # terminal 1: start the local runtime
node gates/record-transcripts.mjs         # terminal 2: replay golden.jsonl, write gates/transcripts/
\`\`\`

Record transcripts, commit them, then push — the eval gate reads whatever is
committed under \`gates/transcripts/\`; it does not invoke the agent itself.
The recorder replays every turn of a scenario in one session (multi-turn
scenarios are genuinely executed) and writes a \`.meta.json\` provenance
sidecar per transcript; the scorecard marks transcripts without provenance as
UNVERIFIED, so hand-written replies are visible for what they are.

Heads-up: some AgentCore CLI commands have been observed to exit 0 on
failure — verify command output, not just exit codes, when scripting around
the CLI (the CD workflows in this repo already do).

## Judge mode in CI

\`eval.yml\` assumes an OIDC role (\`evalRoleArn\` in \`gates/platform-gates.json\`,
overridable via the repo variable \`AWS_EVAL_ROLE_ARN\`) for LLM-judge scoring.
Without it the run degrades to assertion-only checks — still a real gate; the
scorecard states which mode ran. Judge capability is a credentials question,
not an environment one: with Bedrock credentials configured, a local
\`--mode judge\` run performs the exact same scoring as the CI gate.

## Extending the quality bar

Add scenarios to \`agentcore/datasets/golden.jsonl\` (one JSON object per line:
\`scenario_id\`, \`turns\`, deterministic \`checks\`, natural-language
\`assertions\`). Raising \`threshold\` is allowed; lowering it below the org floor
(0.5) or editing the protected workflow/runner files fails the compliance gate.

## Deploying (FULL preset only)

Single AWS account, one agent name, environment = name suffix: \`<agent>-dev\`,
\`<agent>-staging\`, \`<agent>-prod\`. \`.github/workflows/deploy-dev.yml\` deploys
\`-dev\` automatically on every push to \`main\`. \`.github/workflows/promote.yml\`
(manual, \`workflow_dispatch\`) redeploys the same code as \`-staging\` or
\`-prod\`, gated by the \`staging\`/\`prod\` GitHub Environments' required
reviewers — promotion is an approved suffix deploy, not a separate pipeline
or account.
`
}

function gatesReadme(project) {
  return `# Platform CI gate — ${project}

This repo was exported from the platform console. Whatever else changes:
${gateRules()}`
}

// J-T10: the from-scratch pack's front page. MINIMAL carries no code and no
// spec, so the repo's own README is the one-page gate rules (decision 3).
function scratchReadme(ctx) {
  const seeded = !(ctx.dir && existsSync(join(ctx.dir, "agentcore", "datasets", "golden.jsonl")))
  return `# ${ctx.project} — from-scratch agent repo

Exported from the platform console${ctx.domain ? ` for the **${ctx.domain}** domain team` : ""}.
This is the org-mandated minimum — no blueprint, no spec, no application code.
You bring the agent; the platform brings the gate.

## What's in the box

- \`.github/workflows/\` — the three gate workflows (below)
- \`gates/\` — the gate runners + \`platform-gates.json\` (the gate contract: threshold, protected files, guardrail controls)
- \`agentcore/datasets/golden.jsonl\` — ${seeded
    ? "3 baseline smoke scenarios (scope, honesty, prompt-injection). **Placeholders — replace them with your domain's real golden examples.**"
    : "your project's golden dataset, carried as-is. Extend it as your quality bar grows."}

## Gate rules

${gateRules()}`
}

function claudeMd(project, harness) {
  const h = harness || {}
  const skills = (h.skills || []).map(s => `- \`${s.id}\` — ${s.name}`).join("\n") || "- (none yet)"
  const tools = (h.tools || []).map(t => `- \`${t.id}\` (${t.type})${t.gateway ? ` via gateway \`${t.gateway}\`` : ""}`).join("\n") || "- (none yet)"
  return `# ${project} — Agent Project (CLAUDE.md)

This repository was generated from a **platform Foundation Harness blueprint**.
The platform team pre-wired the hard parts. You (the domain team) build your
domain logic on top. Read this before you change anything.

## 🔒 Foundation Harness — platform-owned, DO NOT rebuild

These are already wired in this repo and provisioned on deploy. Do not
re-implement them; do not edit their config.

| Capability | How it's wired | Where |
| --- | --- | --- |
| **Identity** | Cognito CUSTOM_JWT authorizer; the caller's Cognito profile (sub/name/email) arrives as allowlisted runtime headers — \`sub\` scopes memory per-user, \`name\` lets the agent greet the user | \`agentcore/agentcore.json\` (runtimes[].authorizerType + requestHeaderAllowlist), \`app/*/identity/profile.py\` |
| **Memory** | AgentCore Memory (semantic/summary/user-pref/episodic), namespaced per user | \`app/*/memory/session.py\` |
| **Observability** | OpenTelemetry auto-instrumentation (\`aws-opentelemetry-distro\`) → CloudWatch traces & metrics, zero code | \`app/*/pyproject.toml\` + AgentCore Runtime |
| **Runtime** | Managed microVM sessions | \`agentcore/agentcore.json\` |

> Golden rule: **\`agentcore.json\` is the source of truth.** Never edit the
> generated CDK in \`agentcore/cdk/\`. Do not touch \`runtimes\`, \`memories\`, or
> the authorizer — that's the platform's locked foundation.

## ⛩ Platform CI gate — runs on every PR

Three workflows (\`.github/workflows/eval.yml\`, \`tests.yml\`, \`compliance.yml\`)
gate every PR: eval against the golden dataset in
\`agentcore/datasets/golden.jsonl\`, your test suite, and a compliance check
(gate config intact + secret scan). The workflow and runner files under
\`gates/\` are protected — weakening them fails the compliance gate. Rules and
local run commands: \`gates/README.md\`.

## ✏️ Domain Harness — this is YOUR job

Composed so far (from the platform catalog):

**Model:** \`${h.model || "(blueprint default)"}\`

**Skills:**
${skills}

**Tools:**
${tools}

### How to extend
1. **Persona / instructions** — edit \`app/*/instructions.md\` (the editable runtime system prompt) and redeploy. No code change needed.
2. **Add a catalog skill** — \`agentcore add skill --harness <name> --git <repo>\` or \`--aws-skills\`.
3. **Add a tool** — \`agentcore add tool --harness <name> --type agentcore_gateway|remote_mcp|agentcore_code_interpreter|inline_function\`. The tools listed above are currently stubs — wire them to your real gateway/MCP endpoints.
4. **Domain eval** — \`agentcore add evaluator\` + a golden dataset for your quality bar.

## Run it

\`\`\`bash
cd agentcore/cdk && npm install && cd ../..   # restore CDK build deps
agentcore validate
\`\`\`

Local dev runtime, two terminals:

\`\`\`bash
agentcore dev --logs                                              # terminal 1
curl -X POST localhost:8080/invocations -d '{"prompt":"hello"}'  # terminal 2
\`\`\`

Deploy to AWS (foundation comes with it):

\`\`\`bash
agentcore deploy -y
\`\`\`

## Verify locally before you push

Run the whole local verification chain before opening a PR — catch what CI
would catch, minutes earlier:

\`\`\`bash
agentcore validate                                 # 1. config is well-formed
agentcore dev --logs                               # 2. start the local runtime (separate terminal)
curl -X POST localhost:8080/invocations -d '{"prompt":"hello"}'  # 3. smoke test
node gates/record-transcripts.mjs                  # 4. replay golden.jsonl into gates/transcripts/
node gates/run-tests.mjs                           # 5. tests gate (fail-closed — no tests = fail)
node gates/check-guardrails.mjs                    # 6. compliance gate
node gates/run-eval.mjs --mode assert              # 7. eval gate (deterministic checks; add --mode judge with AWS creds)
\`\`\`

All seven green locally → push with confidence; CI runs the same gates.

## Testing identity locally

\`agentcore dev\` does not run the CUSTOM_JWT authorizer, so inject the caller
identity yourself with the three headers the runtime allowlists (see
\`identity/profile.py\`):

\`\`\`bash
curl -X POST localhost:8080/invocations \\
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Custom-user-id: user-123" \\
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Custom-user-name: Ada Lovelace" \\
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Custom-user-email: ada@example.com" \\
  -d '{"prompt":"who am I talking to?"}'
\`\`\`

Omit the headers to exercise the anonymous fallback (\`user_id="anonymous"\`,
no personalization). \`app/*/tests/test_identity.py\` covers both paths.

## Testing multi-turn locally

Reuse the same session id header across two calls to exercise the memory
session manager and \`SlidingWindowConversationManager\` together:

\`\`\`bash
curl -X POST localhost:8080/invocations \\
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: demo-session-1" \\
  -d '{"prompt":"My favorite color is teal. Remember that."}'

curl -X POST localhost:8080/invocations \\
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: demo-session-1" \\
  -d '{"prompt":"What is my favorite color?"}'
\`\`\`

The second reply should reference "teal" — if it doesn't, check
\`MEMORY_*_ID\` is set (local dev without it is a documented no-op; see the
warning logged by \`memory/session.py\`) and that \`main.py\` still uses
\`SlidingWindowConversationManager\`, not \`NullConversationManager\`.

See \`AGENTS.md\` for the full AgentCore CLI reference.

---
_Generated by the Agentic AI Platform self-service console. Foundation is locked; differentiate in the domain layer._
`
}
