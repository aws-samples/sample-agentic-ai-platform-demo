import { createDirtyTracker } from './dirty-state.mjs'

// Explicit business-form scopes only. Bind after a renderer/read-back has installed
// controls; retain drafts across error rerenders, never infer dirt from DOM defaults.
export function createFormDirtyGuard() {
  const tracker = createDirtyTracker(), scopes = new Map()
  const read = node => node.type === 'checkbox' || node.type === 'radio' ? node.checked
    : node.multiple ? [...node.selectedOptions].map(option => option.value) : node.value
  const write = (node, value) => {
    if (node.type === 'checkbox' || node.type === 'radio') node.checked = value
    else if (node.multiple) for (const option of node.options) option.selected = value.includes(option.value)
    else node.value = value
  }
  return {
    bind(scope, controls) {
      let state = scopes.get(scope)
      if (!state) { state = new Map(); scopes.set(scope, state) }
      for (const [key, node] of controls) {
        if (node.disabled || node.matches?.(':disabled')) continue
        const id = JSON.stringify([scope, key]), prior = state.get(key)
        if (!prior) {
          tracker.setBaseline(id, read(node))
          state.set(key, { node, value: read(node) })
        } else {
          if (prior.node !== node) {
            if (tracker.isDirty(id, prior.value)) write(node, prior.value)
            else tracker.setBaseline(id, read(node))
          }
          prior.node = node; prior.value = read(node)
        }
        if (!node.dirtyGuardBound) {
          node.dirtyGuardBound = true
          const update = () => { const entry = scopes.get(scope)?.get(key); if (entry?.node === node) entry.value = read(node) }
          node.addEventListener('input', update); node.addEventListener('change', update)
        }
      }
    },
    isDirty(scope) {
      const entries = scope === undefined ? scopes : [[scope, scopes.get(scope)]]
      for (const [name, state] of entries) for (const [key, entry] of state || []) {
        // Read live controls as well: programmatic integrations must not evade guard.
        if (entry.node.isConnected) entry.value = read(entry.node)
        if (tracker.isDirty(JSON.stringify([name, key]), entry.value)) return true
      }
      return false
    },
    clear(scope) {
      for (const [name, state] of scopes) if (scope === undefined || name === scope) {
        for (const key of state.keys()) tracker.clear(JSON.stringify([name, key]))
        scopes.delete(name)
      }
    },
  }
}
