// Offline tests execute verbatim app.mjs validators, not a reimplementation.
// Synthetic profiles only; no browser, JWT verification or live authorization claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
const start=source.indexOf('const usableDomainId =');
const end=source.indexOf('\nfunction renderOrdinaryDomainControl(',start);
assert.ok(start>=0&&end>start);
const validators=vm.createContext({});
vm.runInContext(source.slice(start,end),validators);
const choices=[{id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'}];
function profile(role,scoped,patch={}){
 return {ok:true,user:'synthetic-person',name:'Synthetic Person',identityProvider:'cognito',
  role,authenticatedRole:role,profileType:scoped?'scoped':'authenticated-unscoped',
  scopeStatus:scoped?'ready':'selection-required',domain:scoped?'alpha':null,
  domains:['alpha','beta'],availableDomains:choices,capabilities:[],
  demoRoleActive:false,canSwitchDemoRole:false,availableDemoRoles:[],availableDemoDomains:[],...patch};
}
for(const role of ['lead','builder'])for(const scoped of [false,true]){
 const label=`${role} ${scoped?'scoped':'unscoped'}`;
 const check=(patch,expected)=>{
  const p=profile(role,scoped,patch);
  assert.equal(validators.usableCognitoProfile(p),expected,'usableCognitoProfile');
  if(!scoped)assert.equal(validators.usableOrdinaryBootstrap(p),expected,'usableOrdinaryBootstrap');
 };
 for(const [name,patch] of [
  ['duplicate domains (reported counterexample)',{domains:['alpha','alpha']}],
  ['duplicate choices',{availableDomains:[choices[0],choices[0]]}],
  ['missing domain',{domains:['alpha']}],
  ['extra domain',{domains:['alpha','beta','gamma']}],
  ['missing choice',{availableDomains:[choices[0]]}],
  ['extra choice',{availableDomains:[...choices,{id:'gamma',name:'Gamma'}]}],
  ['equal length but different set',{domains:['alpha','gamma']}],
 ])test(`${label}: rejects ${name}`,()=>check(patch,false));
 test(`${label}: same set in different order is valid`,()=>check({domains:['beta','alpha']},true));
 test(`${label}: normal multi-domain is valid`,()=>check({},true));
 test(`${label}: normal single-domain is valid`,()=>check({domains:['alpha'],availableDomains:[choices[0]]},true));
 for(const [name,patch] of [
  ['role escalation',{authenticatedRole:'user'}],
  ['demo role flag',{demoRoleActive:true}],
  ['demo switch flag',{canSwitchDemoRole:true}],
  ['invalid domain id',{domains:['alpha','../beta']}],
  ['invalid choice label',{availableDomains:[choices[0],{id:'beta',name:''}]}],
 ])test(`${label}: existing guard rejects ${name}`,()=>check(patch,false));
 if(scoped)test(`${label}: selected domain outside set is rejected`,()=>check({domain:'gamma'},false));
 else{
  test(`${label}: no-access is valid`,()=>check({scopeStatus:'no-access',domains:[],availableDomains:[]},true));
  for(const patch of [{capabilities:['admin']},{availableDemoRoles:['admin']},{availableDemoDomains:[choices[0]]},{identityProvider:'mock'},{domain:'alpha'},{scopeStatus:'ready'}]){
   test(`${label}: bootstrap restrictions ${JSON.stringify(patch)}`,()=>check(patch,false));
  }
 }
}
for(const role of ['lead','builder']){
 test(`${role}: direct bootstrap rejects duplicate domains`,()=>{
  assert.equal(validators.usableOrdinaryBootstrap(profile(role,false,{domains:['alpha','alpha']})),false);
 });
 for(const field of ['domains','capabilities','availableDemoRoles','availableDemoDomains','availableDomains']){
  for(const [kind,value] of [['missing',undefined],['null',null],['object',{}],['string','']]){
   test(`${role}: direct bootstrap rejects ${field} ${kind} without throwing`,()=>{
    const p=profile(role,false,{[field]:value});
    assert.equal(validators.usableOrdinaryBootstrap(p),false);
    assert.equal(validators.usableCognitoProfile(p),false);
   });
  }
 }
}
test('direct bootstrap rejects absent profile without throwing',()=>{
 for(const p of [undefined,null,{}])assert.equal(validators.usableOrdinaryBootstrap(p),false);
});
