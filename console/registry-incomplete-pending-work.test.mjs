import test from "node:test"
import assert from "node:assert/strict"
import { projectPendingWork } from "./public/pending-work.mjs"

// Requirement (c): when the registry catalog is incomplete (one or more
// records dropped by single-record fault isolation), any "no pending work /
// queue empty / nothing to approve" determination must be SUPPRESSED. The
// pending-work projector must report complete=false and count=null (unknown)
// instead of a misleading 0/"all clear".

// An incomplete registry response as emitted by the fault-isolating
// control-plane read (stableRegistryResponse with faults): ok:true, source
// aws, entries present, plus the explicit incomplete/degraded signal.
const INCOMPLETE_REGISTRY = {
  ok: true,
  source: "aws",
  store: "aws",
  entries: [],
  types: [],
  statuses: [],
  incomplete: true,
  completeness: "incomplete",
  failedRecordCount: 1,
  errors: ["SharedReg12345/synthetic-bad1"],
}

const EMPTY_APPROVALS = {
  ok: true,
  resource: "approvals",
  cursor: null,
  items: [],
}

test("an incomplete registry suppresses the empty/all-clear state", () => {
  const projection = projectPendingWork({
    registry: INCOMPLETE_REGISTRY,
    approvals: EMPTY_APPROVALS,
    hosted: true,
    now: Date.parse("2026-09-13T00:00:00.000Z"),
  })
  // The catalog is incomplete, so completeness is false and the exact pending
  // total is unknown (null) rather than a misleading 0.
  assert.equal(projection.complete, false)
  assert.equal(projection.count, null)
  assert.ok(
    projection.problems.some((problem) => /Registry/.test(problem)),
    "expected a Registry incompleteness problem to be recorded",
  )
})

test("a complete empty registry still reports a definitive zero (not suppressed)", () => {
  const projection = projectPendingWork({
    registry: {
      ok: true,
      source: "aws",
      store: "aws",
      entries: [],
      types: [],
      statuses: [],
    },
    approvals: EMPTY_APPROVALS,
    hosted: true,
    now: Date.parse("2026-09-13T00:00:00.000Z"),
  })
  // Fully complete + genuinely empty -> a real 0 is allowed (not suppressed).
  assert.equal(projection.complete, true)
  assert.equal(projection.count, 0)
})
