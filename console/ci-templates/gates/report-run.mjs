// platform-telemetry: v1 — CI-self-reported run telemetry (observability, NOT attestation).
// Builds run-report.json for one workflow run: aggregates the gate results for
// the run's commit via the GitHub API (GITHUB_TOKEN, read-only) and the
// deployment events via the Deployments API. The upload to the platform's S3
// telemetry prefix happens in the workflow step that follows — this script
// never needs AWS credentials, and the credential-less gates (tests,
// compliance) never self-report: their results are read from here.
// Trust boundary: everything in this report is what CI says about itself,
// anchored only by the OIDC role→repo binding used at upload time.
import { readFileSync, writeFileSync } from "node:fs"

const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY
if (!token || !repo) fail("GITHUB_TOKEN and GITHUB_REPOSITORY are required")

const api = async (path, raw = false) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json" },
  })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return raw ? res.text() : res.json()
}

// Resolve the run being reported: workflow_run event payload, or an explicit
// run id (workflow_dispatch re-report).
let run
if (process.env.TRIGGER_RUN_ID) {
  run = await api(`/repos/${repo}/actions/runs/${process.env.TRIGGER_RUN_ID}`)
} else {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
  run = event.workflow_run
  if (!run) fail("No workflow_run in the event payload and no TRIGGER_RUN_ID set")
}
const sha = run.head_sha

// Latest run of each workflow for this commit — the gate picture as of now.
const runsForSha = (await api(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)).workflow_runs || []
const latest = {}
for (const r of runsForSha) {
  if (!latest[r.name] || new Date(r.run_started_at) > new Date(latest[r.name].run_started_at)) latest[r.name] = r
}

const gateFrom = (r) => r ? {
  pass: r.status === "completed" ? r.conclusion === "success" : null,
  run_url: r.html_url,
  completed_at: r.status === "completed" ? r.updated_at : null,
} : { pass: null }

// guardrails run as a step inside the compliance workflow — read the step
// conclusion so a gitleaks failure doesn't misreport the guardrail check.
const gates = {
  eval: gateFrom(latest["eval-gate"]),
  tests: gateFrom(latest["tests"]),
  compliance: gateFrom(latest["compliance"]),
  guardrails: gateFrom(latest["compliance"]),
}
if (latest["compliance"]) {
  try {
    const jobs = (await api(`/repos/${repo}/actions/runs/${latest["compliance"].id}/jobs`)).jobs || []
    const step = jobs.flatMap(j => j.steps || []).find(s => /guardrail/i.test(s.name))
    if (step?.status === "completed") gates.guardrails.pass = step.conclusion === "success"
  } catch { /* keep the workflow-level conclusion */ }
}

// Eval score: parsed from the eval job's log (run-eval.mjs prints the
// scorecard: `Score: **NN%** (p/t)`). Absent log or parse miss -> score null,
// pass/fail from the run conclusion still stands.
if (latest["eval-gate"]?.status === "completed") {
  try {
    const jobs = (await api(`/repos/${repo}/actions/runs/${latest["eval-gate"].id}/jobs`)).jobs || []
    for (const job of jobs) {
      const log = await api(`/repos/${repo}/actions/jobs/${job.id}/logs`, true)
      const m = log.match(/Score: \*\*(\d+)%\*\* \((\d+)\/(\d+)\)/)
      if (m) { gates.eval.score = Number(m[1]) / 100; gates.eval.passed = Number(m[2]); gates.eval.total = Number(m[3]); break }
    }
  } catch { /* score stays absent — honest gap, not a fabricated number */ }
}
if (gates.eval.score === undefined) gates.eval.score = null

// Deployment events for this commit (deploy-dev / promote jobs carry a GitHub
// Environment, so each deploy shows up in the Deployments API).
const deployments = []
try {
  for (const d of await api(`/repos/${repo}/deployments?sha=${sha}&per_page=10`)) {
    const statuses = await api(`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`)
    deployments.push({ environment: d.environment, status: statuses[0]?.state || "unknown", at: statuses[0]?.created_at || d.created_at })
  }
} catch { /* deployments stay empty — the gates section is still valid */ }

// Skip contract (deploy-dev/promote templates): with no deploy target
// configured the "Deploy …" step is skipped via `if:` — but the job still
// succeeds and its GitHub Environment records a green deployment, so the
// Deployments API alone misreports a skip as a success. Cross-check the
// deploy run's step conclusions (native `skipped`, deterministic — no log
// parsing) and downgrade honestly.
const deployWorkflowFor = { dev: "deploy-dev", staging: "promote", prod: "promote" }
for (const d of deployments) {
  if (d.status !== "success") continue
  const wf = latest[deployWorkflowFor[d.environment]]
  if (!wf) continue
  try {
    const jobs = (await api(`/repos/${repo}/actions/runs/${wf.id}/jobs`)).jobs || []
    const step = jobs.flatMap(j => j.steps || []).find(s => /^Deploy /.test(s.name))
    if (step?.conclusion === "skipped") { d.status = "skipped"; d.reason = "no deploy target configured" }
  } catch { /* keep the Deployments API status */ }
}

// runtime name is deterministic (agentcore.yaml runtime_name + env suffix);
// the runtime ARN is only known inside the deploy job, so it is not repeated
// here — the console links to the run for the full deploy output.
try {
  const base = readFileSync("deploy/agentcore.yaml", "utf8").match(/^runtime_name:\s*(\S+)/m)?.[1]
  if (base) for (const d of deployments) d.runtime_name = `${base}_${d.environment}`
} catch { /* optional enrichment only */ }

const report = {
  schema_version: 1,
  source: "ci-self-report",
  repo,
  run_id: String(run.id),
  run_name: run.name,
  run_url: run.html_url,
  sha,
  branch: run.head_branch,
  event: run.event,
  started_at: run.run_started_at,
  completed_at: run.updated_at,
  conclusion: run.conclusion,
  gates,
  deployments,
  reported_at: new Date().toISOString(),
}
writeFileSync("run-report.json", JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

function fail(msg) { console.error(`TELEMETRY REPORT FAILED\n${msg}`); process.exit(1) }
