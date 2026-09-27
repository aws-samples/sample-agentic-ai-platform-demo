// Synthetic preference tests: server inventory, not storage, grants access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceSelectionKey,rememberWorkspaceSelection,restoreWorkspaceSelection} from './public/modules/workspace-scope.mjs';
const profile={user:'synthetic-lead',role:'lead',domain:'domain_a'};
const projects=[{id:'first',domain:'domain_a'},{id:'second',domain:'domain_a'},{id:'second',domain:'domain_b'}];
function storage(){const values=new Map();return {getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}}
test('explicit authorized pair restores after refresh, not first inventory item',()=>{
 const s=storage();rememberWorkspaceSelection(s,profile,projects[1]);
 assert.equal(restoreWorkspaceSelection(s,profile,projects).project,projects[1]);
});
test('identity, role and domain partition UI preference',()=>{
 const s=storage();rememberWorkspaceSelection(s,profile,projects[1]);
 for(const other of [{...profile,user:'synthetic-other'},{...profile,role:'builder'},{...profile,domain:'domain_b'}])
  assert.deepEqual(restoreWorkspaceSelection(s,other,projects),{project:null,stale:false});
});
test('removed project and foreign-domain tampering are forgotten, never substituted',()=>{
 for(const saved of [projects[1],projects[2]]){
  const s=storage();rememberWorkspaceSelection(s,profile,saved);
  assert.deepEqual(restoreWorkspaceSelection(s,profile,[projects[0]]),{project:null,stale:true});
  assert.equal(s.getItem(workspaceSelectionKey(profile)),null);
 }
});
test('invalid or malformed stored preference fails closed and is removed',()=>{
 for(const raw of ['not JSON','null','[]','{}','{"id":"second"}']){
  const s=storage();s.setItem(workspaceSelectionKey(profile),raw);
  assert.deepEqual(restoreWorkspaceSelection(s,profile,projects),{project:null,stale:true});
  assert.equal(s.getItem(workspaceSelectionKey(profile)),null);
 }
});
test('explicit preference invalidation clears preference',()=>{
 const s=storage();rememberWorkspaceSelection(s,profile,projects[1]);rememberWorkspaceSelection(s,profile,null);
 assert.deepEqual(restoreWorkspaceSelection(s,profile,projects),{project:null,stale:false});
});
test('no domain or EndUser creates no preference namespace',()=>{
 for(const p of [{...profile,domain:null},{...profile,role:'user'},null])assert.equal(workspaceSelectionKey(p),null);
});
test('storage unavailable cannot prevent explicit navigation',()=>{
 const denied={getItem(){throw Error('denied')},setItem(){throw Error('denied')},removeItem(){throw Error('denied')}};
 assert.doesNotThrow(()=>rememberWorkspaceSelection(denied,profile,projects[1]));
 assert.equal(restoreWorkspaceSelection(denied,profile,projects).project,null);
});
