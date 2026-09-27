// Offline integration: actual API/workspace/projectors and verbatim frontend functions.
// Synthetic boundaries: authorizer claims (NOT verified JWT), DOM, auth token storage,
// Dynamo directory and empty inventory. Not live Cognito/browser/membership acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createApiHandler} from '../infra/serverless-platform/lambda/api/index.mjs';
import {createWorkspaceHandler} from '../infra/serverless-platform/lambda/workspace/index.mjs';
import {createProductionIdentityProjector} from '../infra/serverless-platform/lambda/workspace/runtime.mjs';
const source=fs.readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function extract(name){const a=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));const b=source.indexOf('\n}',a)+2;assert.ok(a>=0&&b>a,name);return source.slice(a,b);}
function span(a,b){const start=source.indexOf(a);const end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end);}
const claimsFor=(role,ids)=>({sub:'synthetic-'+role,token_use:'access','cognito:groups':['domain-'+role,...ids.map(id=>'domain-'+id)]});
const records=ids=>ids.map(id=>({id,name:'Synthetic '+id,status:'ACTIVE'}));
const event=(claims,headers={},path='/api/me')=>({headers:JSON.parse(JSON.stringify(headers)),requestContext:{http:{method:'GET',path},requestId:'synthetic',authorizer:{jwt:{claims}}}});
const noIO=()=>{throw Error('Unexpected privileged IO');};
function harness(role,ids=['alpha','beta']){
 let claims=claimsFor(role,ids),directory=records(['alpha','beta','foreign']),directoryError=false;
 let token=true,clears=0,dirty=true,consent=true,draftClears=0,ensureCalls=0;
 const calls=[],inventory=[];
 const apiHandler=createApiHandler({demoOperatorVerifier:noIO,domainState:{listDomains:async()=>{if(directoryError)throw Error('synthetic unavailable');return directory;}}});
 const ws=createWorkspaceHandler({identityProjector:createProductionIdentityProjector(),identityVerifier:noIO,domainDirectory:{listActiveDomains:async()=>directory.filter(d=>d.status==='ACTIVE').map(({id})=>({id}))},workspaceState:Object.fromEntries(['listProjects','listAgents','listDeployments','listApprovals'].map(n=>[n,async input=>{inventory.push(input.domainId);return {items:[],cursor:null};}])),authorizer:async()=>({ok:true})});
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',style:{},value:'',querySelectorAll:()=>[]});return nodes.get(id);};
 const ctx=vm.createContext({SESSION:null,S:{},sessionEpoch:0,cognitoLoginStatus:'',cognitoBootstrapError:'',ordinaryDomainSwitching:false,mockLoginAttempt:null,scratchPrevTimer:null,
  hostedRegistryReadCache:null,pendingHostedApprovalDecisions:new Map(),activeSessionRequests:new Set(),activeSessionTimeouts:new Set(),activeSessionIntervals:new Set(),AbortController,clearTimeout,clearInterval,
  CANCELED_REQUEST:Symbol('canceled'),authMode:()=> 'cognito',getAccessToken:()=>token?'synthetic-not-a-jwt':null,
  getDemoContext:()=>null,demoContextHeaders:()=>({}),completeSignIn:async()=>false,readHostedGitHubCallback:()=>null,
  clearAuthentication:()=>{token=false;clears++;},clearDemoContext:()=>{},clearDemoAssist:()=>{},clearActiveDemoJourney:()=>{},
  clearBusinessDrafts:()=>{draftClears++;dirty=false;},createUserState:()=>({}),mainHomeView:()=> 'workspace',
  document:{getElementById:node},esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
  render:()=>{},renderTopbar:()=>{},renderCognitoHydration:()=>{},signOutCurrentSession:()=>{},
  sessionTaskHandler:fn=>fn,domainBootstrapDirty:()=>false,projectBudgetDirty:()=>dirty,businessForms:{isDirty:()=>false},wizardDirty:{isDirty:()=>false},composeDirty:{isDirty:()=>false},composeDraft:()=>({}),approvalReasonDrafts:{isDirty:()=>false},approvalReasonScope:()=>({}),confirm:()=>consent,
  alert:()=>{},queueMicrotask:()=>{},apiUrl:p=>p,disposeLanding:null,disposeDomains:null,vLogin:()=>{node('main').innerHTML='SIGN_IN';},ensure:async()=>{ensureCalls++;},
  fetch:async(path,options)=>{
   const r=await (path==='/me'?apiHandler:ws)(event(claims,options.headers,'/api'+path));
   calls.push({path,headers:{...options.headers,authorization:'SYNTHETIC_ONLY'},status:r.statusCode});
   return {status:r.statusCode,ok:r.statusCode===200,text:async()=>r.body};
  },
 });
 vm.runInContext("const SESSION_KEY='unused';const activeDomain=()=>SESSION?.domain||null;",ctx);
 for(const n of ['setSession','replaceSession','resetSignedOutState','handleUnauthorized','cognitoErrorMessage','usableCognitoProfile','usableOrdinaryBootstrap','sameAuthenticatedIdentity','demoContextWasRejected','hydrateCognitoSession','renderOrdinaryDomainControl','wireOrdinaryDomainControl','renderOrdinaryBootstrap','recoverOrdinaryScope','switchOrdinaryDomain','hasUnsavedContextChanges','confirmContextChange','beginSessionRequest','invalidateSessionWork','clearHostedRegistryReadCache','renderSession','mainCompatApi'])vm.runInContext(extract(n),ctx);
 vm.runInContext(span('const usableDomainId =','function usableCognitoProfile'),ctx);
 vm.runInContext(span('const sessionRequestIsCurrent =','function sessionTimeout'),ctx);
 vm.runInContext(span('const authHeaders = ()=>{','const apiBaseUrl'),ctx);
 vm.runInContext(span('const rawApi = async','function clearHostedRegistryReadCache'),ctx);
 vm.runInContext('const api=(p,b,o)=>p==="/me"?mainCompatApi(p,b,o):rawApi(p,b,o);globalThis.request=api;globalThis.headers=authHeaders;',ctx);
 return {ctx,calls,nodes,inventory,apiHandler,ws,setClaims:ids=>{claims=claimsFor(role,ids);},setDirectory:items=>{directory=items;},failDirectory:()=>{directoryError=true;},setDirty:(d,c)=>{dirty=d;consent=c;},stats:()=>({token,clears,dirty,draftClears,ensureCalls})};
}
for(const role of ['lead','builder']){
 test(`${role}: first login and refresh retain auth, explicit chooser, unscoped business blocked`,async()=>{
  const h=harness(role);await h.ctx.hydrateCognitoSession();
  assert.equal(h.ctx.SESSION.profileType,'authenticated-unscoped');assert.equal(h.ctx.SESSION.scopeStatus,'selection-required');
  assert.deepEqual(Array.from(h.ctx.SESSION.domains),['alpha','beta']);assert.equal(h.stats().clears,0);
  assert.match(h.ctx.renderOrdinaryDomainControl(),/Choose a domain/);assert.doesNotMatch(h.ctx.renderOrdinaryDomainControl(),/foreign/);
  await h.ctx.renderSession();assert.equal(h.stats().ensureCalls,0);assert.match(h.nodes.get('main').innerHTML,/Choose your working domain/);
  await assert.rejects(h.ctx.request('/projects'),e=>e===h.ctx.CANCELED_REQUEST);assert.equal(h.inventory.length,0);
  await h.ctx.switchOrdinaryDomain('beta');assert.equal(h.ctx.SESSION.domain,'beta');
  assert.equal(h.calls.at(-1).headers['x-active-domain'],'beta');assert.equal(h.calls.at(-1).headers['x-demo-role'],undefined);
  await h.ctx.hydrateCognitoSession();assert.equal(h.ctx.SESSION.domain,null);assert.equal(h.ctx.SESSION.scopeStatus,'selection-required');assert.equal(h.stats().clears,0);
 });
 test(`${role}: successful switch invalidates caches and late response; Cancel preserves drafts`,async()=>{
  const h=harness(role);await h.ctx.hydrateCognitoSession();await h.ctx.switchOrdinaryDomain('alpha');
  h.setDirty(true,false);const before=h.calls.length,epoch=h.ctx.sessionEpoch,clears=h.stats().draftClears;
  await h.ctx.switchOrdinaryDomain('beta');assert.equal(h.calls.length,before);assert.equal(h.ctx.sessionEpoch,epoch);assert.equal(h.stats().draftClears,clears);assert.equal(h.stats().dirty,true);assert.equal(h.ctx.SESSION.domain,'alpha');
  h.setDirty(true,true);const original=h.ctx.fetch;let finish;h.ctx.fetch=(p,o)=>p==='/projects'?new Promise(r=>{finish=r;}):original(p,o);
  const late=h.ctx.request('/projects');const rejection=assert.rejects(late,e=>e===h.ctx.CANCELED_REQUEST);
  h.ctx.S.oldRows=['alpha-private'];h.ctx.hostedRegistryReadCache={stale:true};
  await h.ctx.switchOrdinaryDomain('beta');finish({status:200,ok:true,text:async()=>JSON.stringify({items:['alpha-private']})});await rejection;
  assert.equal(h.ctx.SESSION.domain,'beta');assert.equal(h.ctx.S.oldRows,undefined);assert.equal(h.ctx.hostedRegistryReadCache,null);assert.equal(h.stats().dirty,false);
 });
 test(`${role}: revoked scope recovers without token loss or automatic domain substitution`,async()=>{
  const h=harness(role);await h.ctx.hydrateCognitoSession();await h.ctx.switchOrdinaryDomain('alpha');h.ctx.S.oldRows=['private'];h.setClaims(['beta']);
  await assert.rejects(h.ctx.request('/projects'),e=>e===h.ctx.CANCELED_REQUEST);
  assert.equal(h.ctx.SESSION.domain,null);assert.equal(h.ctx.SESSION.scopeStatus,'selection-required');assert.deepEqual(Array.from(h.ctx.SESSION.domains),['beta']);assert.equal(h.stats().clears,0);assert.equal(h.ctx.S.oldRows,undefined);assert.equal(h.inventory.length,0);
  await h.ctx.switchOrdinaryDomain('beta');assert.equal(h.ctx.SESSION.domain,'beta');
 });
 test(`${role}: zero/inactive domains are no-access, legitimate single domain enters directly`,async()=>{
  for(const ids of [[],['alpha']]){
   const h=harness(role,ids);h.setDirectory(records(['beta']));await h.ctx.hydrateCognitoSession();assert.equal(h.ctx.SESSION.scopeStatus,'no-access');assert.equal(h.ctx.SESSION.domain,null);assert.equal(h.stats().clears,0);await h.ctx.renderSession();assert.match(h.nodes.get('main').innerHTML,/No domain access/);
  }
  const single=harness(role,['beta']);await single.ctx.hydrateCognitoSession();assert.equal(single.ctx.SESSION.domain,'beta');assert.equal(single.ctx.SESSION.scopeStatus,'ready');
 });
 test(`${role}: foreign/inactive/forged role denied; operational ambiguity stays strict`,async()=>{
  const h=harness(role);const claims=claimsFor(role,['alpha','beta']);
  for(const headers of [{'x-active-domain':'foreign'},{'x-demo-role':'admin'},{'x-active-domain':'../alpha'},{'x-active-domain':'alpha','X-Active-Domain':'beta'}]){
   assert.equal((await h.apiHandler(event(claims,headers))).statusCode,403);
  }
  h.setDirectory(records(['beta']));assert.equal((await h.apiHandler(event(claims,{'x-active-domain':'alpha'}))).statusCode,403);
  for(const headers of [{},{'x-active-domain':'foreign'},{'x-active-domain':'alpha'}])assert.equal((await h.ws(event(claims,headers,'/api/projects'))).statusCode,403);
  assert.equal(h.inventory.length,0);
 });
 test(`${role}: directory failure is retryable error not empty or auth failure; unrelated 403 doesn't reset session`,async()=>{
  const h=harness(role);h.failDirectory();const r=await h.apiHandler(event(claimsFor(role,['alpha'])));assert.equal(r.statusCode,503);assert.equal(JSON.parse(r.body).code,'DOMAIN_DIRECTORY_UNAVAILABLE');
  await h.ctx.hydrateCognitoSession();assert.equal(h.ctx.SESSION,null);assert.equal(h.stats().clears,0);await h.ctx.renderSession();assert.match(h.nodes.get('main').innerHTML,/Domains unavailable/);assert.doesNotMatch(h.nodes.get('main').innerHTML,/No domain access/);
  const good=harness(role,['alpha']);await good.ctx.hydrateCognitoSession();const profile=good.ctx.SESSION;
  good.ctx.fetch=async()=>({status:403,ok:false,text:async()=>JSON.stringify({ok:false,code:'ACCESS_DENIED'})});
  assert.equal((await good.ctx.request('/projects')).code,'ACCESS_DENIED');assert.equal(good.ctx.SESSION,profile);assert.equal(good.stats().clears,0);
  good.ctx.fetch=async()=>({status:401,ok:false,text:async()=>''});await assert.rejects(good.ctx.request('/projects'),e=>e===good.ctx.CANCELED_REQUEST);assert.equal(good.stats().clears,1);assert.equal(good.ctx.SESSION,null);
 });
}
test('bootstrap cannot masquerade as scoped profile or grant capabilities',async()=>{
 const h=harness('lead');await h.ctx.hydrateCognitoSession();const p=JSON.parse(JSON.stringify(h.ctx.SESSION));
 for(const patch of [{capabilities:['admin']},{profileType:undefined},{domain:'alpha'},{canSwitchDemoRole:true},{scopeStatus:'ready'},{availableDomains:[{id:'foreign',name:'Foreign'}]}])assert.equal(h.ctx.usableCognitoProfile({...p,...patch}),false);
});
test('concurrent selections are serialized; selector uses the ordinary server-validation action',async()=>{
 const h=harness('builder');await h.ctx.hydrateCognitoSession();const original=h.ctx.fetch;let release;
 h.ctx.fetch=async(p,o)=>{await new Promise(r=>{release=r;});return original(p,o);};
 h.ctx.wireOrdinaryDomainControl();h.nodes.get('ordinarydomain').value='alpha';
 const first=h.nodes.get('ordinarydomain').onchange();await h.ctx.switchOrdinaryDomain('beta');
 assert.equal(h.ctx.ordinaryDomainSwitching,true);release();await first;
 assert.equal(h.ctx.SESSION.domain,'alpha');assert.equal(h.calls.filter(c=>c.headers['x-active-domain']).length,1);
});
test('directory labels are authoritative, inactive/foreign records excluded, errors never become no-access',async()=>{
 const h=harness('lead');h.setDirectory([{id:'alpha',name:'Server Alpha',status:'ACTIVE'},{id:'beta',name:'Hidden inactive',status:'INACTIVE'},{id:'foreign',name:'Hidden foreign',status:'ACTIVE'}]);
 await h.ctx.hydrateCognitoSession();assert.equal(h.ctx.SESSION.domain,'alpha');assert.deepEqual(Array.from(h.ctx.SESSION.availableDomains,d=>({...d})),[{id:'alpha',name:'Server Alpha'}]);
 h.setDirectory([{id:'alpha',name:'',status:'ACTIVE'}]);const r=await h.apiHandler(event(claimsFor('lead',['alpha'])));
 assert.equal(r.statusCode,503);assert.equal(JSON.parse(r.body).code,'DOMAIN_DIRECTORY_UNAVAILABLE');
});
test('failed selection retains drafts and valid current scope without elevating; server profile must match identity',async()=>{
 const h=harness('lead');await h.ctx.hydrateCognitoSession();await h.ctx.switchOrdinaryDomain('alpha');h.setDirty(true,true);
 const current=h.ctx.SESSION;const clearCount=h.stats().draftClears;
 h.ctx.fetch=async()=>({status:200,ok:true,text:async()=>JSON.stringify({...current,user:'synthetic-other',domain:'beta'})});
 await h.ctx.switchOrdinaryDomain('beta');assert.equal(h.ctx.SESSION,current);assert.equal(h.stats().draftClears,clearCount);assert.equal(h.stats().clears,0);
});

test('actual topbar renders named ordinary choices and wires selection without demo controls',async()=>{
 const h=harness('builder');await h.ctx.hydrateCognitoSession();
 Object.assign(h.ctx,{BRAND_MARK:'',PERSONAS:{},renderDemoControls:()=>'',signOutCurrentSession:()=>{}});
 vm.runInContext(extract('renderTopbar'),h.ctx);h.ctx.renderTopbar();
 assert.match(h.nodes.get('topbar').innerHTML,/ordinarydomain/);assert.match(h.nodes.get('topbar').innerHTML,/Synthetic alpha/);assert.doesNotMatch(h.nodes.get('topbar').innerHTML,/Synthetic foreign/);
 h.nodes.get('ordinarydomain').value='beta';await h.nodes.get('ordinarydomain').onchange();assert.equal(h.ctx.SESSION.domain,'beta');
});
test('renderSession awaiting ensure cannot render a superseded scope',async()=>{
 const h=harness('builder',['alpha']);await h.ctx.hydrateCognitoSession();let release;
 h.ctx.ensure=()=>new Promise(r=>{release=r;});
 const old=h.ctx.renderSession();h.ctx.replaceSession(null);h.ctx.cognitoBootstrapError='Your domains could not be loaded. Try again.';h.ctx.renderOrdinaryBootstrap();
 const recovery=h.nodes.get('main').innerHTML;release();await old;
 assert.equal(h.nodes.get('main').innerHTML,recovery);assert.match(recovery,/Domains unavailable/);
});
test('scope recovery directory failure clears old state and cannot reuse business identity',async()=>{
 const h=harness('builder');await h.ctx.hydrateCognitoSession();await h.ctx.switchOrdinaryDomain('alpha');h.ctx.S.oldPrivate='alpha';h.failDirectory();
 const original=h.ctx.fetch;h.ctx.fetch=(p,o)=>p==='/projects'?Promise.resolve({status:403,ok:false,text:async()=>JSON.stringify({ok:false,code:'DOMAIN_NOT_ALLOWED'})}):original(p,o);
 await assert.rejects(h.ctx.request('/projects'),e=>e===h.ctx.CANCELED_REQUEST);
 assert.equal(h.ctx.SESSION,null);assert.equal(h.ctx.S.oldPrivate,undefined);assert.equal(h.stats().clears,0);assert.ok(h.ctx.cognitoBootstrapError);
 const calls=h.calls.length;await assert.rejects(h.ctx.request('/agents'),e=>e===h.ctx.CANCELED_REQUEST);assert.equal(h.calls.length,calls);
});
