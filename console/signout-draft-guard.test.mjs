// Isolated actual-handler test. Not real Cognito/browser acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(process.env.APP_SOURCE || new URL('./public/modules/app.mjs',import.meta.url),'utf8');
const start=app.indexOf('async function signOutCurrentSession(){');
const end=app.indexOf('// Per-page story strip',start);
assert.ok(start>=0 && end>start);
function harness(mode, proceed){
 const calls=[];
 const context={authMode:()=>mode,confirmContextChange:()=>{calls.push('confirm');return proceed},
 clearDemoAssist:()=>calls.push('clearAssist'),resetSignedOutState:()=>calls.push('reset'),
 render:()=>calls.push('render'),cognitoSignOut:()=>calls.push('cognitoLogout'),
 apiUrl:path=>path,authHeaders:()=>({}),fetch:async()=>{calls.push('localLogout')},
 cognitoErrorMessage:()=>'',cognitoLoginStatus:''};
 vm.createContext(context);vm.runInContext(app.slice(start,end),context);
 return {calls,run:()=>context.signOutCurrentSession()};
}
for(const mode of ['cognito','local']){
 test(`${mode}: cancelling explicit sign-out/user switch retains draft and session`,async()=>{
  const h=harness(mode,false);await h.run();assert.deepEqual(h.calls,['confirm']);
 });
 test(`${mode}: accepted discard or clean form signs out exactly once`,async()=>{
  const h=harness(mode,true);await h.run();
  assert.equal(h.calls[0],'confirm');assert.equal(h.calls.filter(x=>x==='reset').length,1);
  assert.equal(h.calls.filter(x=>x===(mode==='cognito'?'cognitoLogout':'localLogout')).length,1);
 });
}
test('both explicit profile actions use the guarded handler',()=>{
 for(const id of ['tbswitchuser','tbsignout'])assert.ok(app.includes(`document.getElementById('${id}').onclick=signOutCurrentSession`));
});
