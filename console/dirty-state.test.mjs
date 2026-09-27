// dirty-state.test.mjs — RED-first tests for the explicit business-form
// dirty tracker that replaces app.mjs's blanket "#main input/textarea/select
// vs DOM defaultValue" scan (root cause of the frequent false-positive
// "Discard unsaved changes and leave this working context?" popup).
//
// Business rule under test: a scope (e.g. "wizard", "domainPolicy",
// "agentBuild") is dirty ONLY when a baseline was captured after loading
// data AND the current values differ from that baseline. Scopes that never
// call setBaseline() (search boxes, filters, plain navigation controls)
// can never be reported dirty — this is what fixes the search/filter and
// bare S.wiz-presence false positives.
import assert from "node:assert/strict"
import test from "node:test"

import {
  createDirtyTracker,
} from "./public/dirty-state.mjs"

test("baseline snapshots nested mutable form data instead of retaining its reference", () => {
  const tracker = createDirtyTracker()
  const draft = { policy: { allowed: ["a"] }, name: "original" }
  tracker.setBaseline("wizard", draft)
  draft.policy.allowed.push("b")
  assert.equal(tracker.isDirty("wizard", draft), true)
  draft.policy.allowed.pop()
  assert.equal(tracker.isDirty("wizard", draft), false)
})

test("successful save snapshots mutable values for later edits", () => {
  const tracker = createDirtyTracker()
  const draft = { allowed: ["a"] }
  tracker.markSaved("policy", draft)
  draft.allowed.push("b")
  assert.equal(tracker.isDirty("policy", draft), true)
})

test("different own keys with undefined values are still a change", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("policy", { original: undefined })
  assert.equal(tracker.isDirty("policy", { replacement: undefined }), true)
})

test("a scope with no baseline is never dirty (search/filter fields are never tracked)", () => {
  const tracker = createDirtyTracker()
  assert.equal(tracker.isDirty("regsearch", { q: "anything" }), false)
  assert.equal(tracker.isDirty("wsswitchsearch", {}), false)
})

test("unchanged values vs baseline are not dirty (loading a form is not editing it)", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("agentBuild", { name: "a", temperature: 0.2 })
  assert.equal(tracker.isDirty("agentBuild", { name: "a", temperature: 0.2 }), false)
})

test("changed values vs baseline are dirty (a real unsaved edit)", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("agentBuild", { name: "a", temperature: 0.2 })
  assert.equal(tracker.isDirty("agentBuild", { name: "a", temperature: 0.9 }), true)
})

test("markSaved(scope, values) resets the baseline to the saved values — dirty clears", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("domainPolicy", { enforced: ["a"] })
  assert.equal(tracker.isDirty("domainPolicy", { enforced: ["a", "b"] }), true)
  tracker.markSaved("domainPolicy", { enforced: ["a", "b"] })
  assert.equal(tracker.isDirty("domainPolicy", { enforced: ["a", "b"] }), false)
})

test("a failed save keeps the old baseline — the edit stays dirty until it actually saves", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("domainPolicy", { enforced: ["a"] })
  const current = { enforced: ["a", "b"] }
  assert.equal(tracker.isDirty("domainPolicy", current), true)
  // save failed: caller does NOT call markSaved — baseline is untouched
  assert.equal(tracker.isDirty("domainPolicy", current), true)
})

test("clear(scope) removes tracking entirely (leaving a view / normal navigation)", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("wizard", { step: 1, name: "" })
  tracker.isDirty("wizard", { step: 1, name: "x" })
  tracker.clear("wizard")
  assert.equal(tracker.isDirty("wizard", { step: 1, name: "x" }), false)
})

test("opening a wizard and never editing any field is NOT dirty (fixes bare S.wiz===true bug)", () => {
  const tracker = createDirtyTracker()
  // Wizard opened: baseline captured from its initial (empty/default) values,
  // exactly as rendered — no user edits yet.
  tracker.setBaseline("wizard", { step: 1, name: "", blueprintIds: [] })
  assert.equal(tracker.isDirty("wizard", { step: 1, name: "", blueprintIds: [] }), false)
})

test("editing one field of a tracked wizard makes it dirty", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("wizard", { step: 1, name: "", blueprintIds: [] })
  assert.equal(tracker.isDirty("wizard", { step: 1, name: "my-agent", blueprintIds: [] }), true)
})

test("hasAnyDirty(scopes) is true if any one of several tracked scopes is dirty", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("agentBuild", { name: "a" })
  tracker.setBaseline("domainPolicy", { enforced: [] })
  assert.equal(
    tracker.hasAnyDirty([
      { scope: "agentBuild", values: { name: "a" } },
      { scope: "domainPolicy", values: { enforced: ["x"] } },
    ]),
    true,
  )
})

test("hasAnyDirty(scopes) is false when every tracked scope matches its baseline", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("agentBuild", { name: "a" })
  tracker.setBaseline("domainPolicy", { enforced: [] })
  assert.equal(
    tracker.hasAnyDirty([
      { scope: "agentBuild", values: { name: "a" } },
      { scope: "domainPolicy", values: { enforced: [] } },
    ]),
    false,
  )
})

test("hasAnyDirty ignores scopes with no baseline (untracked navigation/search controls)", () => {
  const tracker = createDirtyTracker()
  assert.equal(
    tracker.hasAnyDirty([
      { scope: "regsearch", values: { q: "typed something" } },
      { scope: "wsswitchsearch", values: { q: "typed too" } },
    ]),
    false,
  )
})

test("switching projects/roles: clearing the old scope after a confirmed leave drops its dirty state", () => {
  const tracker = createDirtyTracker()
  tracker.setBaseline("agentBuild", { name: "a" })
  tracker.isDirty("agentBuild", { name: "b" }) // dirty, user confirmed discard
  tracker.clear("agentBuild")
  // new project/role context starts clean until its own baseline is set
  assert.equal(tracker.isDirty("agentBuild", { name: "b" }), false)
})
