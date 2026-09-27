// Synthetic responses only: actual renderer, raw transport and project helper.
// These tests do not certify live ordinary-role authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as scope from './public/modules/workspace-scope.mjs';
import {createDirtyTracker} from './public/dirty-state.mjs';
import {createFormDirtyGuard} from './public/form-dirty-guard.mjs';
import {createApprovalReasonDrafts} from './public/approval-reason-drafts.mjs';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function fn(name){
 const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
 assert.notEqual(start,-1,name);return source.slice(start,source.indexOf('\n}',start)+2);
}
const profile={user:'synthetic-builder',role:'builder',domain:'domain_a'};
const projects=[{id:'first',domainId:'domain_a',name:'First',status:'ACTIVE'},
 {id:'second',domainId:'domain_a',name:'Second',status:'ACTIVE'},
 {id:'second',domainId:'domain_b',name:'Foreign',status:'ACTIVE'}];
const page=(items=projects)=>({ok:true,resource:'projects',items,cursor:null});
function setup(){
 const values=new Map(),calls=[],bodies=[],elements=new Map();
 const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const el=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',style:{},isConnected:true,dataset:{},querySelectorAll:()=>[],querySelector:s=>s==='[data-workspace-retry]'?el('retry'):null,focus(){}});return elements.get(id)};
 const ctx=vm.createContext({...scope,S:{view:'workspace',wsTab:'cost',workspaceProjects:null},SESSION:{...profile},
  globalThis:{sessionStorage:storage},authMode:()=> 'cognito',SHELL:()=>ctx.SESSION.role,activeDomain:()=>ctx.SESSION.domain,
  sessionEpoch:0,sessionEpochIsCurrent:e=>e===ctx.sessionEpoch,CANCELED_REQUEST:Symbol('cancel'),
  document:{getElementById:el,querySelectorAll:()=>[],querySelector:()=>null},esc:v=>String(v),domainLabel:v=>v,ICONS:{},FOLDER_IC:'',pluralize:(n,s)=>`${n} ${s}`,
  confirm:()=>false,composeDirty:createDirtyTracker(),composeDraft:()=>({}),businessForms:createFormDirtyGuard(),wizardDirty:createDirtyTracker(),domainBootstrapDirty:()=>false,projectBudgetDirty:()=>false,approvalReasonDrafts:createApprovalReasonDrafts(),
  clearBusinessDrafts:()=>{ctx.draft=null},draft:'synthetic unsaved draft',invalidateSessionWork:()=>ctx.sessionEpoch++,render:()=>{},
  runSessionTask:f=>f(),sessionTaskHandler:f=>f,loadWorkspaceTab:async p=>bodies.push(p.id),
  api:async()=>{throw Error('Unexpected compatibility/business API')},rawApi:async(path,body,options)=>{calls.push({path,body,options});return page()}});
 for(const name of ['workspaceSelectionStorage','groupProjectsByDomain','approvalReasonScope','hasUnsavedContextChanges','confirmContextChange','workspaceProjectMatches','selectWorkspaceProject','readWorkspaceProjects','ensureWorkspaceProjects','workspaceFunction','workspaceScopeText','workspaceProjectState','loadWorkspace'])vm.runInContext(fn(name),ctx);
 return {ctx,storage,values,el,calls,bodies};
}
function saveSecond(h){
 h.ctx.selectWorkspaceProject({...projects[1],domain:'domain_a'});
 assert.equal(h.ctx.S.workspaceProject,'second');
 assert.deepEqual(JSON.parse(h.storage.getItem(scope.workspaceSelectionKey(profile))),{domain:'domain_a',id:'second'});
}
function assertInactive(h){
 assert.equal(h.ctx.S.workspaceProject,null);assert.equal(h.ctx.S.workspaceDomain,null);
 assert.equal(h.ctx.S.workspaceProjects,null);assert.equal(h.ctx.S.obsScope,null);
 assert.equal(h.ctx.S.fleetSession,null);assert.equal(h.ctx.S.projectDetail,null);
 assert.match(h.el('wsroot').innerHTML,/data-workspace-state="error"/);
 assert.doesNotMatch(h.el('wsroot').innerHTML,/id="wsbody"/);assert.deepEqual(h.bodies,[]);
}
for(const [label,response] of [
 ['network',new TypeError('Synthetic network failure')],
 ['503',{ok:false,status:503,code:'WORKSPACE_UNAVAILABLE'}],
 ['unknown authorization',{ok:false,code:'UNKNOWN'}],
 ['invalid contract',{ok:true,resource:'projects'}],
 ['misleading forbidden text',new Error('403 FORBIDDEN is only untrusted text')],
 ['5xx with conflicting code',{ok:false,status:503,code:'FORBIDDEN'}],
 ['401 uncertain authorization',{ok:false,status:401}],
])test(`second project -> ${label} -> actual Retry restores only after successful directory`,async()=>{
 const h=setup();saveSecond(h);h.ctx.draft='keep during read failure';
 h.ctx.S.fleetSession='stale';h.ctx.S.projectDetail='second';
 const saved=h.storage.getItem(scope.workspaceSelectionKey(profile));
 h.ctx.rawApi=async(path,body)=>{h.calls.push({path,body});if(response instanceof Error)throw response;return response};
 await h.ctx.loadWorkspace();
 assert.equal(h.storage.getItem(scope.workspaceSelectionKey(profile)),saved,'transient/unknown failure preserves minimal preference');
 assertInactive(h);assert.equal(h.ctx.S.workspaceSelectionChecked,false);assert.equal(h.ctx.draft,'keep during read failure');
 h.ctx.rawApi=async(path,body)=>{h.calls.push({path,body});return page()};
 await h.el('retry').onclick();
 assert.equal(h.ctx.S.workspaceProject,'second');assert.equal(h.ctx.S.workspaceDomain,'domain_a');assert.deepEqual(h.bodies,['second']);
 assert.ok(h.calls.every(c=>c.path.startsWith('/projects?')&&c.body===undefined),'read-only, no business writes');
});
for(const response of [{ok:false,status:403},{ok:false,code:'FORBIDDEN'},{ok:false,code:'DEMO_DOMAIN_NOT_ALLOWED'}])test(`explicit loss ${JSON.stringify(response)} clears preference and does not restore on Retry`,async()=>{
 const h=setup();saveSecond(h);h.ctx.rawApi=async()=>response;await h.ctx.loadWorkspace();
 assert.equal(h.storage.getItem(scope.workspaceSelectionKey(profile)),null);assertInactive(h);
 h.ctx.rawApi=async()=>page();await h.el('retry').onclick();
 assert.equal(h.ctx.S.workspaceProject,null);assert.deepEqual(h.bodies,[]);assert.match(h.el('wsroot').innerHTML,/Choose a project/);
});
for(const items of [projects.slice(0,1),[],[projects[0],{...projects[1],status:'ARCHIVED'}]])test(`successful directory removal (${items.length} rows) clears saved second, never silently selects first`,async()=>{
 const h=setup();saveSecond(h);h.ctx.rawApi=async()=>{throw Error('Synthetic offline')};await h.ctx.loadWorkspace();
 h.ctx.rawApi=async()=>page(items);await h.el('retry').onclick();
 assert.equal(h.storage.getItem(scope.workspaceSelectionKey(profile)),null);assert.equal(h.ctx.S.workspaceProject,null);assert.deepEqual(h.bodies,[]);
});
for(const change of [{user:'synthetic-other'},{role:'lead'},{domain:'domain_b'}])test(`transient preference cannot cross context ${JSON.stringify(change)}`,async()=>{
 const h=setup();saveSecond(h);h.ctx.rawApi=async()=>{throw Error('Synthetic offline')};await h.ctx.loadWorkspace();
 h.ctx.SESSION={...profile,...change};h.ctx.S={view:'workspace',wsTab:'cost',workspaceProjects:null};h.ctx.sessionEpoch++;
 h.ctx.rawApi=async()=>page([...projects,{id:'third',domainId:'domain_b',name:'Third',status:'ACTIVE'}]);await h.ctx.loadWorkspace();
 assert.equal(h.ctx.S.workspaceProject,undefined);assert.deepEqual(h.bodies,[]);
 assert.equal(h.storage.getItem(scope.workspaceSelectionKey(profile)),JSON.stringify({domain:'domain_a',id:'second'}),'other namespace is not consumed');
});
test('Cancel uses actual dirty guard and keeps draft, current selection, preference and epoch',()=>{
 const h=setup();saveSecond(h);h.ctx.draft='synthetic unsaved draft';h.ctx.projectBudgetDirty=()=>true;
 const saved=h.storage.getItem(scope.workspaceSelectionKey(profile)),epoch=h.ctx.sessionEpoch;
 h.ctx.selectWorkspaceProject({...projects[0],domain:'domain_a'});
 assert.equal(h.ctx.draft,'synthetic unsaved draft');assert.equal(h.ctx.S.workspaceProject,'second');assert.equal(h.ctx.sessionEpoch,epoch);
 assert.equal(h.storage.getItem(scope.workspaceSelectionKey(profile)),saved);assert.deepEqual(h.calls,[]);
});
function useRawTransport(h,status,text){
 Object.assign(h.ctx,{cognitoBootstrapError:null,beginSessionRequest:()=>({controller:{signal:undefined}}),sessionRequestIsCurrent:()=>true,
  authHeaders:()=>({}),apiUrl:p=>p,finishSessionRequest:()=>{},clearHostedRegistryReadCache:()=>{},fetch:async()=>({ok:status<400,status,text:async()=>text})});
 const start=source.indexOf('const rawApi = async (');const code=source.slice(start,source.indexOf('\n}',start)+2);
 vm.runInContext(code.replace('const rawApi =','rawApi ='),h.ctx);
}
for(const [status,text] of [[403,''],[403,'<html>denied</html>'],[403,'{"ok":true}'],[503,'{"ok":false,"code":"FORBIDDEN"}']])test(`actual transport preserves project HTTP ${status} (${text||'empty'}) for typed classification`,async()=>{
 const h=setup();useRawTransport(h,status,text);
 await assert.rejects(scope.loadWorkspaceProjectPages(h.ctx.rawApi),error=>{
  assert.equal(error.name,'WorkspaceProjectReadError');assert.equal(error.status,status);assert.equal(error.accessDenied,status===403);return true;
 });
});
test('later-page transient error preserves preference without accepting a partial authorized directory',async()=>{
 const h=setup();saveSecond(h);let n=0;
 h.ctx.rawApi=async()=>++n===1?{...page([projects[0]]),cursor:'next'}:{ok:false,status:503};
 await h.ctx.loadWorkspace();assertInactive(h);assert.notEqual(h.storage.getItem(scope.workspaceSelectionKey(profile)),null);
 h.ctx.rawApi=async()=>page();await h.el('retry').onclick();assert.equal(h.ctx.S.workspaceProject,'second');
});
test('old-context failure cannot clear another actor preference or active scope',async()=>{
 const h=setup();saveSecond(h);let release;h.ctx.rawApi=()=>new Promise(resolve=>release=resolve);
 const pending=h.ctx.loadWorkspace();h.ctx.SESSION={...profile,user:'synthetic-other'};h.ctx.sessionEpoch++;
 scope.rememberWorkspaceSelection(h.storage,h.ctx.SESSION,{domain:'domain_a',id:'first'});
 h.ctx.S={workspaceProject:'first',workspaceDomain:'domain_a'};release({ok:false,status:403});await pending;
 assert.equal(h.ctx.S.workspaceProject,'first');assert.notEqual(h.storage.getItem(scope.workspaceSelectionKey(h.ctx.SESSION)),null);
});

for(const status of [403,503])test(`actual transport -> helper -> renderer HTTP ${status} respects preference policy`,async()=>{
 const h=setup();saveSecond(h);useRawTransport(h,status,'<html>Synthetic outage</html>');await h.ctx.loadWorkspace();
 assertInactive(h);assert.equal(h.storage.getItem(scope.workspaceSelectionKey(profile))===null,status===403);
});
test('pending successful retry cannot activate saved project before directory validation',async()=>{
 const h=setup();saveSecond(h);h.ctx.rawApi=async()=>{throw Error('Synthetic offline')};await h.ctx.loadWorkspace();
 let release;h.ctx.rawApi=()=>new Promise(resolve=>release=resolve);const retry=h.el('retry').onclick();
 assertInactive(h);release(page());await retry;assert.equal(h.ctx.S.workspaceProject,'second');assert.deepEqual(h.bodies,['second']);
});
