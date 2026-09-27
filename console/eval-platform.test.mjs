import test from "node:test"
import assert from "node:assert/strict"
import {
  appendCases,
  computeGate,
  createDataset,
  emptyEvalStore,
  publishDataset,
  scoreSmokeCase,
  startEvalRun,
  validateDataset,
} from "./eval-platform.mjs"

test("dataset CRUD normalizes agent-agnostic case records", () => {
  const store = emptyEvalStore()
  const ds = createDataset(store, {
    name: "Support release gate",
    project: "supportdesk",
    domain: "customer-support",
    cases: [{ scenario_id: "return-window", turns: [{ input: "Can I return this?" }], assertions: ["mentions policy"] }],
  })
  appendCases(ds, [{ id: "refund", input: "I want refund", expected_output_contains: ["refund"], replay_output: "I can help with a refund." }])
  assert.equal(store.datasets.length, 1)
  assert.equal(ds.cases.length, 2)
  assert.equal(ds.cases[0].id, "return-window")
  assert.equal(ds.cases[0].input, "Can I return this?")
  assert.equal(validateDataset(ds).ok, true)
})

test("smoke scoring uses replay outputs and deterministic assertions", () => {
  const result = scoreSmokeCase({
    id: "TC-1",
    input: "Can I return opened electronics?",
    expected_behavior: "allow",
    expected_output_contains: ["14 days", "restocking"],
    expected_output_not_contains: ["full refund guaranteed"],
    must_have_facts: ["opened electronics"],
  }, {
    replayOutputs: {
      "TC-1": "Opened electronics can be returned within 14 days; a restocking fee may apply.",
    },
  })
  assert.equal(result.status, "passed")
  assert.equal(result.score, 1)
  assert.equal(result.checks.find(c => c.expected === "opened electronics").passed, true)
})

test("smoke run persists aggregate scores and gate decision", () => {
  const store = emptyEvalStore()
  const ds = createDataset(store, {
    name: "Smoke",
    project: "supportdesk",
    cases: [
      { id: "TC-1", input: "SLA?", expected_output_contains: ["2 hours"], replay_output: "Critical SLA is 2 hours." },
      { id: "TC-2", input: "Password?", expected_output_not_contains: ["share your password"], replay_output: "Use self-service reset; never share your password." },
    ],
  })
  const started = startEvalRun(store, { datasetId: ds.id, pack: "smoke", agentRuntimeId: "supportdesk" })
  assert.equal(started.ok, true)
  assert.equal(started.run.status, "completed")
  assert.equal(started.run.aggregate["deterministic.output_contains"], 1)
  assert.equal(started.run.aggregate["deterministic.forbidden_output"], 0)
  assert.equal(started.run.gate.decision, "FAIL")
})

test("standard pack is explicit when AgentCore eval backend is not configured", () => {
  const store = emptyEvalStore()
  const ds = createDataset(store, {
    name: "Standard",
    project: "supportdesk",
    cases: [{ id: "TC-1", input: "Hello", replay_output: "Hello, how can I help?", expected_output_contains: ["help"] }],
  })
  const r = startEvalRun(store, { datasetId: ds.id, pack: "standard" })
  assert.equal(r.ok, true)
  assert.equal(r.run.status, "not_configured")
  assert.match(r.run.backend.detail, /requires AgentCore evaluation APIs/)
})

test("publishDataset validates locally without inventing an AgentCore ARN", () => {
  const store = emptyEvalStore()
  const ds = createDataset(store, {
    name: "Publish me",
    project: "supportdesk",
    cases: [{ id: "TC-1", input: "Hello", replay_output: "Hello" }],
  })
  const res = publishDataset(ds, { backend: "local" })
  assert.equal(res.ok, true)
  assert.equal(res.published, false)
  assert.equal(ds.publication.status, "not_configured")
  assert.equal(ds.publication.managedDatasetArn, undefined)
})

test("computeGate returns INVESTIGATE when cases could not run", () => {
  const gate = computeGate({ aggregate: { "deterministic.output_contains": 1 }, results: [{ status: "not_run" }] })
  assert.equal(gate.decision, "INVESTIGATE")
  assert.equal(gate.notRun, 1)
})
