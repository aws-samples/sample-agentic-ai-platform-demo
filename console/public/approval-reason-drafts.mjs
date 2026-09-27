// Approval review-reason drafts, isolated by actor+domain+approvalId.
// One draft per approval row; row-level operations never touch other rows,
// and actor/domain scoping prevents cross-identity or cross-domain leakage.
// Whitespace-only values count as "no draft" so accidental spaces never block
// navigation or spuriously mark the console dirty.

const rowKey = ({ actor, domain, approvalId }) =>
  JSON.stringify([actor ?? '', domain ?? '', approvalId ?? ''])
const scopeKey = ({ actor, domain }) => JSON.stringify([actor ?? '', domain ?? ''])

const validScope = scope =>
  !!scope && typeof scope.actor === 'string' && scope.actor.length > 0
  && typeof scope.domain === 'string'

export function createApprovalReasonDrafts() {
  const drafts = new Map()
  return {
    save(scope, value) {
      if (!validScope(scope) || typeof scope.approvalId !== 'string' || !scope.approvalId) return
      if (typeof value !== 'string' || !value.trim()) drafts.delete(rowKey(scope))
      else drafts.set(rowKey(scope), value)
    },
    read(scope) {
      if (!validScope(scope) || typeof scope.approvalId !== 'string' || !scope.approvalId) return ''
      return drafts.get(rowKey(scope)) ?? ''
    },
    // Row scope ({actor,domain,approvalId}) drops that one draft; actor+domain
    // scope ({actor,domain}) drops every draft for that identity+domain only.
    discard(scope) {
      if (scope?.actor && scope.domain === undefined) {
        for (const key of [...drafts.keys()]) if (JSON.parse(key)[0] === scope.actor) drafts.delete(key)
        return
      }
      if (!validScope(scope)) return
      if (typeof scope.approvalId === 'string' && scope.approvalId) { drafts.delete(rowKey(scope)); return }
      const prefix = scopeKey(scope)
      for (const key of [...drafts.keys()]) {
        const [actor, domain] = JSON.parse(key)
        if (JSON.stringify([actor, domain]) === prefix) drafts.delete(key)
      }
    },
    isDirty(scope) {
      if (scope?.actor && scope.domain === undefined) return [...drafts].some(([key,value]) => JSON.parse(key)[0] === scope.actor && !!value.trim())
      if (!validScope(scope)) return false
      const prefix = scopeKey(scope)
      for (const [key, value] of drafts) {
        const [actor, domain] = JSON.parse(key)
        if (JSON.stringify([actor, domain]) === prefix && value.trim()) return true
      }
      return false
    },
  }
}

// Wire [data-reason-for] inputs inside a rendered approvals box.
// - Restores an existing draft only into an untouched (empty) input, so a
//   value the user just typed on a live control is never overwritten.
// - A live non-empty value becomes the draft (rerender race: user text wins).
// - Saves on input/change per row; other rows' drafts are never rewritten.
export function wireApprovalReasonInputs(drafts, box, { actor, domain }) {
  if (typeof actor !== 'string' || !actor) return
  for (const input of box.querySelectorAll('[data-reason-for]')) {
    const approvalId = input.dataset.reasonFor
    if (typeof approvalId !== 'string' || !approvalId) continue
    const scope = { actor, domain: input.dataset.reasonDomain || domain, approvalId }
    const bindingKey = rowKey(scope)
    const previous = input.reasonDraftBinding
    if (previous && previous.key !== bindingKey) {
      input.removeEventListener('input', previous.update)
      input.removeEventListener('change', previous.update)
      input.value = ''
      input.reasonDraftBinding = null
    }
    if (input.value) drafts.save(scope, input.value)
    else {
      const existing = drafts.read(scope)
      if (existing) input.value = existing
    }
    if (!input.reasonDraftBinding) {
      const update = () => drafts.save(scope, input.value)
      input.reasonDraftBinding = { key: bindingKey, update }
      input.addEventListener('input', update)
      input.addEventListener('change', update)
    }
  }
}
