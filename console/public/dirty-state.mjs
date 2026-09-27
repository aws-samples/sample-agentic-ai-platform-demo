// dirty-state.mjs — explicit business-form dirty tracking.
//
// Root cause fixed (app.mjs:1192 hasUnsavedContextChanges): the previous
// implementation (a) treated `S.wiz` truthiness alone as "dirty" even for a
// freshly opened, unedited wizard, and (b) scanned every `#main input,
// textarea, select` and compared live value to the *rendered* DOM
// defaultValue/defaultSelected/defaultChecked. Any control not explicitly
// opted out (search boxes, filter inputs, domain/role selects used for
// browsing) tripped the same "Discard unsaved changes…" confirm() as a real
// half-filled form, and a rerender that changes the DOM's notion of
// "default" (e.g. after a search re-render) could flip the check with zero
// user edits.
//
// This module replaces that implicit DOM scan with an explicit, per-scope
// baseline comparison: nothing is dirty until a caller calls setBaseline()
// for a named business-form scope (e.g. "wizard", "domainPolicy",
// "agentBuild") with the values as loaded/rendered. isDirty() then compares
// the *current* values object to that baseline by JSON-equivalent deep
// comparison. Scopes that never call setBaseline() (search/filter controls,
// plain nav) can never report dirty — no implicit DOM scanning happens at
// all. markSaved() re-baselines on a successful save (dirty clears);
// callers must NOT call it on a failed save, so the edit stays dirty until
// it truly persists. clear() drops a scope's tracking entirely, used when a
// context switch away from a scope has been confirmed (or was never dirty)
// so a subsequent context starts clean.

function isEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => isEqual(v, b[i]))
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => Object.hasOwn(b, k) && isEqual(a[k], b[k]))
}

export function createDirtyTracker() {
  const baselines = new Map()

  return {
    // Capture (or replace) the "clean" reference values for `scope`. Call
    // this right after data is loaded/rendered for a business form — never
    // for search/filter fields, which should simply never call this.
    setBaseline(scope, values) {
      baselines.set(scope, structuredClone(values))
    },

    // True only if `scope` has a baseline AND `values` differs from it.
    // Untracked scopes (no setBaseline call yet) are always false.
    isDirty(scope, values) {
      if (!baselines.has(scope)) return false
      return !isEqual(baselines.get(scope), values)
    },

    // Call on a successful save: re-baselines to the just-saved values, so
    // isDirty() becomes false again. Do NOT call this on a failed save —
    // the edit must remain dirty until it actually persists.
    markSaved(scope, values) {
      baselines.set(scope, structuredClone(values))
    },

    // Drop tracking for `scope` entirely (e.g. after a confirmed context
    // leave, or when navigating away from a view that never got dirty).
    clear(scope) {
      baselines.delete(scope)
    },

    // Convenience for guarding a single navigation/context-switch action
    // against multiple tracked scopes at once, e.g.:
    //   tracker.hasAnyDirty([{scope:'wizard',values:readWizardForm()}, ...])
    hasAnyDirty(entries) {
      return entries.some(({ scope, values }) => this.isDirty(scope, values))
    },
  }
}
