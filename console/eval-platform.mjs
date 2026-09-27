import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

export const EVAL_PACKS = {
  smoke: {
    id: "smoke",
    label: "Smoke",
    description: "Zero-cost deterministic assertions against cached or replayed agent outputs.",
    backend: "local",
  },
  standard: {
    id: "standard",
    label: "Standard",
    description: "Smoke plus AgentCore built-in evaluators when the AgentCore evaluation backend is configured.",
    backend: "agentcore",
  },
  advanced: {
    id: "advanced",
    label: "Advanced",
    description: "Standard plus custom LLM-as-judge rubrics through the governed LLM gateway.",
    backend: "agentcore+gateway",
  },
  continuous: {
    id: "continuous",
    label: "Continuous",
    description: "Online evaluation config and A/B experiment workflow for production agents.",
    backend: "agentcore-online",
  },
}

export const BUILT_IN_EVALUATORS = [
  { id: "deterministic.expected_behavior", type: "deterministic", gate_role: "hard_gate", threshold: 1.0, label: "Expected behavior" },
  { id: "deterministic.output_contains", type: "deterministic", gate_role: "hard_gate", threshold: 1.0, label: "Required output" },
  { id: "deterministic.forbidden_output", type: "deterministic", gate_role: "hard_gate", threshold: 1.0, label: "Forbidden output" },
  { id: "deterministic.must_have_facts", type: "deterministic", gate_role: "hard_gate", threshold: 1.0, label: "Must-have facts" },
  { id: "Builtin.GoalSuccessRate", type: "agentcore_builtin", gate_role: "soft_gate", threshold: 0.7, label: "Goal success" },
  { id: "Builtin.Correctness", type: "agentcore_builtin", gate_role: "soft_gate", threshold: 0.7, label: "Correctness" },
  { id: "Builtin.Helpfulness", type: "agentcore_builtin", gate_role: "soft_gate", threshold: 0.65, label: "Helpfulness" },
]

export function emptyEvalStore() {
  return {
    version: 1,
    datasets: [],
    runs: [],
    evaluators: BUILT_IN_EVALUATORS,
    onlineConfigs: [],
    experiments: [],
  }
}

export function loadEvalStore(path) {
  if (!existsSync(path)) return emptyEvalStore()
  try {
    return { ...emptyEvalStore(), ...JSON.parse(readFileSync(path, "utf8")) }
  } catch {
    return emptyEvalStore()
  }
}

export function saveEvalStore(path, store) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2))
}

function slug(s, fallback = "dataset") {
  const out = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)
  return out || fallback
}

export function normalizeEvalCase(raw, index = 0) {
  const firstTurn = Array.isArray(raw.turns) && raw.turns.length ? raw.turns[0] : {}
  const input = raw.input ?? raw.prompt ?? firstTurn.input ?? ""
  const contains = raw.expected_output_contains ?? raw.contains ?? []
  const notContains = raw.expected_output_not_contains ?? raw.not_contains ?? []
  const assertions = raw.assertions ?? []
  return {
    id: String(raw.id || raw.scenario_id || `TC-${String(index + 1).padStart(3, "0")}`),
    category: String(raw.category || raw.slice || "general"),
    input: String(input),
    expected_behavior: raw.expected_behavior || "allow",
    ground_truth: raw.ground_truth ?? firstTurn.expectedResponse ?? raw.expected ?? "",
    expected_output_contains: Array.isArray(contains) ? contains.map(String) : [String(contains)].filter(Boolean),
    expected_output_not_contains: Array.isArray(notContains) ? notContains.map(String) : [String(notContains)].filter(Boolean),
    expected_tool: raw.expected_tool || null,
    expected_tool_parameters: raw.expected_tool_parameters || {},
    must_have_facts: Array.isArray(raw.must_have_facts) ? raw.must_have_facts.map(String) : [],
    assertions: Array.isArray(assertions) ? assertions.map(String) : [],
    difficulty: raw.difficulty || "medium",
    role: raw.role || null,
    replay_output: raw.replay_output ?? raw.actual_output ?? raw.output ?? null,
    replay_tools: Array.isArray(raw.replay_tools) ? raw.replay_tools : [],
    metadata: raw.metadata || {},
    generated: raw.generated === true,
    status: raw.status || "active",
  }
}

export function createDataset(store, input) {
  const now = new Date().toISOString()
  const id = input.id || `ds-${slug(input.name || input.project || "dataset")}-${randomUUID().slice(0, 8)}`
  const cases = (input.cases || []).map(normalizeEvalCase)
  const ds = {
    id,
    name: String(input.name || id),
    description: String(input.description || ""),
    project: input.project || input.agentRuntimeId || null,
    domain: input.domain || null,
    agentRuntimeId: input.agentRuntimeId || input.project || null,
    schemaType: input.schemaType || "AGENTCORE_EVALUATION_PREDEFINED_V1",
    status: "draft",
    source: input.source || "api",
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy || "unknown",
    cases,
    publication: null,
  }
  store.datasets.push(ds)
  return ds
}

export function listDatasets(store, filters = {}) {
  return store.datasets
    .filter(d => !filters.project || d.project === filters.project || d.agentRuntimeId === filters.project)
    .filter(d => !filters.domain || d.domain === filters.domain)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function getDataset(store, datasetId) {
  return store.datasets.find(d => d.id === datasetId) || null
}

export function replaceCases(dataset, cases) {
  dataset.cases = (cases || []).map(normalizeEvalCase)
  dataset.updatedAt = new Date().toISOString()
  return dataset
}

export function appendCases(dataset, cases) {
  const start = dataset.cases.length
  dataset.cases.push(...(cases || []).map((c, i) => normalizeEvalCase(c, start + i)))
  dataset.updatedAt = new Date().toISOString()
  return dataset
}

export function deleteCase(dataset, caseId) {
  const before = dataset.cases.length
  dataset.cases = dataset.cases.filter(c => c.id !== caseId)
  dataset.updatedAt = new Date().toISOString()
  return before !== dataset.cases.length
}

export function validateDataset(dataset) {
  const errors = []
  const warnings = []
  if (!dataset.name) errors.push("Dataset name is required.")
  if (!dataset.agentRuntimeId) warnings.push("No agentRuntimeId is attached yet; runs must provide one.")
  if (!dataset.cases.length) errors.push("At least one test case is required.")
  const ids = new Set()
  const coverage = { cases: dataset.cases.length, categories: {}, difficulties: {}, deterministicChecks: 0, replayOutputs: 0 }
  for (const c of dataset.cases) {
    if (ids.has(c.id)) errors.push(`Duplicate test case id: ${c.id}`)
    ids.add(c.id)
    if (!c.input) errors.push(`Case ${c.id} is missing input.`)
    coverage.categories[c.category] = (coverage.categories[c.category] || 0) + 1
    coverage.difficulties[c.difficulty] = (coverage.difficulties[c.difficulty] || 0) + 1
    const deterministicCount = [
      c.expected_behavior,
      ...(c.expected_output_contains || []),
      ...(c.expected_output_not_contains || []),
      ...(c.must_have_facts || []),
      c.expected_tool,
    ].filter(Boolean).length
    if (deterministicCount) coverage.deterministicChecks += deterministicCount
    if (c.replay_output) coverage.replayOutputs++
  }
  if (!coverage.replayOutputs) {
    warnings.push("Smoke runs need cached/replayed outputs. Without replay_output or options.replayOutputs, cases are marked not_run.")
  }
  return { ok: errors.length === 0, errors, warnings, coverage }
}

export function publishDataset(dataset, { backend = process.env.AGENTCORE_EVAL_BACKEND || "local" } = {}) {
  const validation = validateDataset(dataset)
  if (!validation.ok) return { ok: false, validation }
  dataset.updatedAt = new Date().toISOString()
  if (backend !== "agentcore") {
    dataset.status = "validated"
    dataset.publication = {
      status: "not_configured",
      backend,
      reason: "AgentCore managed dataset publication is not configured in this local console. Set AGENTCORE_EVAL_BACKEND=agentcore and wire the DatasetClient to publish.",
      checkedAt: dataset.updatedAt,
    }
    return { ok: true, published: false, dataset, validation }
  }
  dataset.status = "publish_pending"
  dataset.publication = {
    status: "pending_agentcore_integration",
    backend,
    reason: "AgentCore DatasetClient integration point reached; no fake managed dataset ARN was generated.",
    checkedAt: dataset.updatedAt,
  }
  return { ok: true, published: false, dataset, validation }
}

function includesText(output, needle) {
  return String(output || "").toLowerCase().includes(String(needle || "").toLowerCase())
}

function behaviorPassed(expected, output) {
  const out = String(output || "").toLowerCase()
  if (expected === "deny") return /(cannot|can't|unable|not allowed|not authorized|declin|escalat|policy|human)/i.test(out)
  if (expected === "allow") return !/(not allowed|not authorized|forbidden|policy prevents)/i.test(out)
  return true
}

export function scoreSmokeCase(testCase, { replayOutputs = {}, replayTools = {}, useGroundTruthAsReplay = false } = {}) {
  const output = replayOutputs[testCase.id] ?? testCase.replay_output ?? (useGroundTruthAsReplay ? testCase.ground_truth : null)
  const tools = replayTools[testCase.id] ?? testCase.replay_tools ?? []
  const checks = []
  if (output == null || output === "") {
    return {
      caseId: testCase.id,
      status: "not_run",
      score: null,
      outputSource: "missing_replay_output",
      checks: [],
      reason: "No cached or replayed output was supplied for deterministic Smoke scoring.",
    }
  }
  if (testCase.expected_behavior) {
    checks.push({ id: "deterministic.expected_behavior", passed: behaviorPassed(testCase.expected_behavior, output), expected: testCase.expected_behavior })
  }
  for (const value of testCase.expected_output_contains || []) {
    checks.push({ id: "deterministic.output_contains", passed: includesText(output, value), expected: value })
  }
  for (const value of testCase.expected_output_not_contains || []) {
    checks.push({ id: "deterministic.forbidden_output", passed: !includesText(output, value), expected: value })
  }
  for (const value of testCase.must_have_facts || []) {
    checks.push({ id: "deterministic.must_have_facts", passed: includesText(output, value), expected: value })
  }
  if (testCase.expected_tool) {
    checks.push({ id: "deterministic.expected_tool", passed: tools.includes(testCase.expected_tool), expected: testCase.expected_tool })
  }
  if (!checks.length) {
    checks.push({ id: "deterministic.has_output", passed: String(output).trim().length > 0, expected: "non-empty output" })
  }
  const passed = checks.filter(c => c.passed).length
  return {
    caseId: testCase.id,
    status: passed === checks.length ? "passed" : "failed",
    score: Number((passed / checks.length).toFixed(2)),
    outputSource: replayOutputs[testCase.id] ? "request.replayOutputs" : testCase.replay_output ? "dataset.replay_output" : "ground_truth_replay",
    checks,
  }
}

export function computeGate(run, evaluators = BUILT_IN_EVALUATORS) {
  const byId = new Map(evaluators.map(e => [e.id, e]))
  const hardFailures = []
  const softWarnings = []
  for (const [id, score] of Object.entries(run.aggregate || {})) {
    const ev = byId.get(id) || { gate_role: id.startsWith("deterministic.") ? "hard_gate" : "soft_gate", threshold: id.startsWith("deterministic.") ? 1 : 0.7 }
    if (typeof score !== "number") continue
    if (ev.gate_role === "hard_gate" && score < ev.threshold) hardFailures.push({ evaluator: id, score, threshold: ev.threshold })
    if (ev.gate_role === "soft_gate" && score < ev.threshold) softWarnings.push({ evaluator: id, score, threshold: ev.threshold })
  }
  const notRun = (run.results || []).filter(r => r.status === "not_run").length
  return {
    decision: hardFailures.length ? "FAIL" : softWarnings.length || notRun ? "INVESTIGATE" : "PASS",
    hardFailures,
    softWarnings,
    notRun,
  }
}

function aggregateSmoke(results) {
  const groups = {}
  for (const r of results) {
    for (const c of r.checks || []) {
      ;(groups[c.id] ||= []).push(c.passed ? 1 : 0)
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([k, vals]) => [k, Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2))]))
}

export function startEvalRun(store, request) {
  const dataset = getDataset(store, request.datasetId)
  if (!dataset) return { ok: false, error: "dataset not found" }
  const pack = EVAL_PACKS[request.pack || "smoke"] ? request.pack || "smoke" : "smoke"
  const run = {
    id: `eval-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`,
    datasetId: dataset.id,
    datasetName: dataset.name,
    project: dataset.project,
    domain: dataset.domain,
    agentRuntimeId: request.agentRuntimeId || dataset.agentRuntimeId,
    pack,
    requestedEvaluators: request.evaluators || {},
    options: request.options || {},
    status: "running",
    source: "platform_eval_api",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
    aggregate: {},
    backend: { status: "local", detail: "Smoke pack is deterministic and runs in-process." },
  }
  if (pack === "smoke") {
    run.results = dataset.cases.map(c => scoreSmokeCase(c, run.options))
    run.aggregate = aggregateSmoke(run.results)
    run.status = "completed"
  } else {
    run.results = dataset.cases.map(c => scoreSmokeCase(c, run.options))
    run.aggregate = aggregateSmoke(run.results)
    run.status = "not_configured"
    run.backend = {
      status: "not_configured",
      detail: `${EVAL_PACKS[pack].label} requires AgentCore evaluation APIs that are not configured in this local console. Smoke assertions were still evaluated locally where replay outputs were available.`,
    }
  }
  run.finishedAt = new Date().toISOString()
  run.gate = computeGate(run, store.evaluators)
  store.runs.unshift(run)
  return { ok: true, run }
}

export function listRuns(store, filters = {}) {
  return store.runs
    .filter(r => !filters.project || r.project === filters.project || r.agentRuntimeId === filters.project)
    .filter(r => !filters.datasetId || r.datasetId === filters.datasetId)
    .slice(0, 100)
}

export function registerEvaluator(store, input) {
  const id = String(input.id || "").trim()
  if (!id) return { ok: false, error: "id is required" }
  const row = {
    id,
    type: input.type || "custom_llm_judge",
    gate_role: input.gate_role || "soft_gate",
    threshold: Number(input.threshold ?? 0.8),
    judge_model: input.judge_model || "platform-llm-gw/anthropic.claude-sonnet-5",
    rubric: input.rubric || "",
    scoring: input.scoring || "0.0-1.0",
    createdAt: new Date().toISOString(),
  }
  const idx = store.evaluators.findIndex(e => e.id === id)
  if (idx >= 0) store.evaluators[idx] = row
  else store.evaluators.push(row)
  return { ok: true, evaluator: row }
}

export function enableOnlineEval(store, input) {
  const agentRuntimeId = input.agentRuntimeId || input.project
  if (!agentRuntimeId) return { ok: false, error: "agentRuntimeId is required" }
  const row = {
    id: `online-${slug(agentRuntimeId)}-${randomUUID().slice(0, 6)}`,
    agentRuntimeId,
    project: input.project || agentRuntimeId,
    domain: input.domain || null,
    evaluators: input.evaluators || ["Builtin.GoalSuccessRate", "Builtin.Helpfulness"],
    sampleRate: Number(input.sampleRate ?? 0.1),
    status: process.env.AGENTCORE_EVAL_BACKEND === "agentcore" ? "pending_agentcore_integration" : "not_configured",
    reason: process.env.AGENTCORE_EVAL_BACKEND === "agentcore"
      ? "AgentCore online evaluation integration point reached; no fake config ARN was generated."
      : "Set AGENTCORE_EVAL_BACKEND=agentcore and wire create-online-evaluation-config to activate live online scoring.",
    updatedAt: new Date().toISOString(),
  }
  store.onlineConfigs = store.onlineConfigs.filter(c => c.agentRuntimeId !== agentRuntimeId)
  store.onlineConfigs.unshift(row)
  return { ok: true, config: row }
}

export function disableOnlineEval(store, agentRuntimeId) {
  const before = store.onlineConfigs.length
  store.onlineConfigs = store.onlineConfigs.filter(c => c.agentRuntimeId !== agentRuntimeId)
  return { ok: true, removed: before - store.onlineConfigs.length }
}

export function onlineScores(store, filters = {}) {
  const configs = store.onlineConfigs.filter(c => !filters.agentRuntimeId || c.agentRuntimeId === filters.agentRuntimeId)
  return { ok: true, source: configs.some(c => c.status !== "not_configured") ? "agentcore" : "not_configured", configs, scores: [] }
}
