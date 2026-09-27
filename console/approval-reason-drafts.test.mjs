import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalReasonDrafts, wireApprovalReasonInputs } from './public/approval-reason-drafts.mjs'

const scope = (actor, domain, approvalId) => ({ actor, domain, approvalId })

test('drafts are isolated by actor+domain+approvalId', () => {
  const drafts = createApprovalReasonDrafts()
  drafts.save(scope('alice', 'domA', 'ap1'), 'looks compliant')
  assert.equal(drafts.read(scope('alice', 'domA', 'ap1')), 'looks compliant')
  // Different actor, domain, or approval must never see the draft.
  assert.equal(drafts.read(scope('bob', 'domA', 'ap1')), '')
  assert.equal(drafts.read(scope('alice', 'domB', 'ap1')), '')
  assert.equal(drafts.read(scope('alice', 'domA', 'ap2')), '')
})

test('row-level discard leaves other rows intact; scope discard only hits actor+domain', () => {
  const drafts = createApprovalReasonDrafts()
  drafts.save(scope('alice', 'domA', 'ap1'), 'reason one')
  drafts.save(scope('alice', 'domA', 'ap2'), 'reason two')
  drafts.save(scope('bob', 'domA', 'ap1'), 'bob reason')
  drafts.discard(scope('alice', 'domA', 'ap1'))
  assert.equal(drafts.read(scope('alice', 'domA', 'ap1')), '')
  assert.equal(drafts.read(scope('alice', 'domA', 'ap2')), 'reason two')
  assert.equal(drafts.read(scope('bob', 'domA', 'ap1')), 'bob reason')
  // actor+domain discard (confirmed draft discard) drops only that actor+domain's drafts.
  drafts.discard({ actor: 'alice', domain: 'domA' })
  assert.equal(drafts.read(scope('alice', 'domA', 'ap2')), '')
  assert.equal(drafts.read(scope('bob', 'domA', 'ap1')), 'bob reason')
})

test('isDirty reflects only non-empty drafts in the given actor+domain scope', () => {
  const drafts = createApprovalReasonDrafts()
  assert.equal(drafts.isDirty({ actor: 'alice', domain: 'domA' }), false)
  drafts.save(scope('alice', 'domA', 'ap1'), '  ')
  assert.equal(drafts.isDirty({ actor: 'alice', domain: 'domA' }), false, 'whitespace-only is not a draft')
  drafts.save(scope('alice', 'domA', 'ap1'), 'real reason')
  assert.equal(drafts.isDirty({ actor: 'alice', domain: 'domA' }), true)
  assert.equal(drafts.isDirty({ actor: 'alice', domain: 'domB' }), false)
  assert.equal(drafts.isDirty({ actor: 'bob', domain: 'domA' }), false)
  drafts.save(scope('alice', 'domA', 'ap1'), '')
  assert.equal(drafts.isDirty({ actor: 'alice', domain: 'domA' }), false, 'clearing the input clears the draft')
})

const fakeInput = approvalId => {
  const listeners = {}
  return {
    value: '',
    dataset: { reasonFor: approvalId },
    isConnected: true,
    addEventListener(name, fn) { listeners[name] = fn },
    fire(name) { listeners[name]?.() },
    reasonDraftBound: undefined,
  }
}
const fakeBox = inputs => ({ querySelectorAll: sel => (sel === '[data-reason-for]' ? inputs : []) })

test('wire restores per-row drafts into empty inputs and saves on input', () => {
  const drafts = createApprovalReasonDrafts()
  drafts.save(scope('alice', 'domA', 'ap1'), 'saved earlier')
  const one = fakeInput('ap1'), two = fakeInput('ap2')
  wireApprovalReasonInputs(drafts, fakeBox([one, two]), { actor: 'alice', domain: 'domA' })
  assert.equal(one.value, 'saved earlier', 'existing draft restored after rerender')
  assert.equal(two.value, '', 'row without draft untouched')
  two.value = 'typing new reason'
  two.fire('input')
  assert.equal(drafts.read(scope('alice', 'domA', 'ap2')), 'typing new reason')
  assert.equal(drafts.read(scope('alice', 'domA', 'ap1')), 'saved earlier', 'other row draft not overwritten')
})

test('wire never overwrites text the user already typed into a rerendered input', () => {
  const drafts = createApprovalReasonDrafts()
  drafts.save(scope('alice', 'domA', 'ap1'), 'old draft')
  const one = fakeInput('ap1')
  one.value = 'fresh text already present'
  wireApprovalReasonInputs(drafts, fakeBox([one]), { actor: 'alice', domain: 'domA' })
  assert.equal(one.value, 'fresh text already present')
  assert.equal(drafts.read(scope('alice', 'domA', 'ap1')), 'fresh text already present', 'live value becomes the draft')
})

test('wire under a different actor/domain neither restores nor leaks drafts', () => {
  const drafts = createApprovalReasonDrafts()
  drafts.save(scope('alice', 'domA', 'ap1'), 'alice draft')
  const one = fakeInput('ap1')
  wireApprovalReasonInputs(drafts, fakeBox([one]), { actor: 'bob', domain: 'domA' })
  assert.equal(one.value, '', 'no cross-actor restore')
  one.value = 'bob writes'
  one.fire('input')
  assert.equal(drafts.read(scope('alice', 'domA', 'ap1')), 'alice draft', 'alice draft untouched')
  assert.equal(drafts.read(scope('bob', 'domA', 'ap1')), 'bob writes')
})
