import test from 'node:test'
import assert from 'node:assert/strict'
import { createFormDirtyGuard } from './public/form-dirty-guard.mjs'
const control = (value, type='text') => ({ value, type, checked:false, isConnected:true, disabled:false,
  handlers:{}, addEventListener(event, fn){this.handlers[event]=fn}, matches(){return false},
  edit(value){this.value=value;this.handlers.input?.()},
})
test('explicit async loaded baseline; search controls never registered; revert and persist', () => {
  const guard=createFormDirtyGuard(), field=control('loaded'), search=control('')
  search.edit('browse'); assert.equal(guard.isDirty(),false)
  guard.bind('policy',[['name',field]]);assert.equal(guard.isDirty(),false)
  field.edit('draft');assert.equal(guard.isDirty(),true)
  field.edit('loaded');assert.equal(guard.isDirty(),false)
  field.edit('saved');guard.clear('policy');guard.bind('policy',[['name',field]])
  assert.equal(guard.isDirty(),false)
})
test('failed rerender retains real draft and remains dirty; clean async readback rebaselines',()=>{
  const guard=createFormDirtyGuard(), first=control('one')
  guard.bind('build',[['name',first]]);first.edit('draft');first.isConnected=false
  const failed=control('one');guard.bind('build',[['name',failed]])
  assert.equal(failed.value,'draft');assert.equal(guard.isDirty(),true)
  guard.clear('build');guard.bind('build',[['name',failed]]);failed.isConnected=false
  const readback=control('authoritative');guard.bind('build',[['name',readback]])
  assert.equal(readback.value,'authoritative');assert.equal(guard.isDirty(),false)
})
test('detached drafts remain protected until actual cancel, navigation or persist',()=>{
  const guard=createFormDirtyGuard(), field=control('old')
  guard.bind('access',[['reason',field]]);field.edit('new');field.isConnected=false
  assert.equal(guard.isDirty(),true);guard.clear();assert.equal(guard.isDirty(),false)
})
test('live programmatic edits and checked state cannot bypass protection',()=>{
  const guard=createFormDirtyGuard(), field=control(''), checkbox=control('', 'checkbox')
  guard.bind('policy',[['name',field],['flag',checkbox]])
  checkbox.checked=true;assert.equal(guard.isDirty(),true)
  checkbox.checked=false;assert.equal(guard.isDirty(),false)
  field.value='programmatic';assert.equal(guard.isDirty(),true)
})
