// Actual authHeaders initializer; isolated credentials/network only, not live acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(process.env.APP_SOURCE||new URL('./public/modules/app.mjs',import.meta.url),'utf8');
const start=source.indexOf('const authHeaders = ()=>{');
const end=source.indexOf('\nconst apiBaseUrl',start);
assert.ok(start>=0&&end>start);
function headers({mode='cognito',role='lead',domain='operations',context={},canSwitchDemoRole=false,token='isolated-token',session=true}={}){
 return new Function('authMode','getAccessToken','SESSION','activeDomain','demoContextHeaders',source.slice(start,end)+';return authHeaders()')(
  ()=>mode,()=>token,session?{role,domain,canSwitchDemoRole,token:'local-token'}:null,()=>session?domain:null,()=>context);
}
for(const role of ['lead','builder'])test(`ordinary ${role} sends backend-projected domain without assuming demo role`,()=>{
 const h=headers({role});assert.equal(h['x-active-domain'],'operations');assert.equal(h['x-demo-role'],undefined);
});
test('no token never sends context',()=>assert.deepEqual(headers({token:null}),{}));
test('bootstrap before identity never guesses domain',()=>assert.equal(headers({session:false})['x-active-domain'],undefined));
test('no domain never manufactures a default',()=>assert.equal(headers({domain:null})['x-active-domain'],undefined));
test('global admin and End User never inherit ordinary scope fallback',()=>{
 for(const role of ['admin','user'])assert.equal(headers({role})['x-active-domain'],undefined);
});
test('explicit demo context remains authoritative',()=>{
 const h=headers({canSwitchDemoRole:true,context:{'x-demo-role':'builder','x-active-domain':'research'}});
 assert.equal(h['x-active-domain'],'research');assert.equal(h['x-demo-role'],'builder');
});
test('explicit demo End User context never inherits previous domain',()=>{
 const h=headers({canSwitchDemoRole:true,context:{'x-demo-role':'user'}});assert.equal(h['x-active-domain'],undefined);
});
test('mock mode retains own session domain and ignores demo context',()=>{
 const h=headers({mode:'mock',context:{'x-demo-role':'admin','x-active-domain':'foreign'}});
 assert.equal(h['x-active-domain'],'operations');assert.equal(h['x-demo-role'],undefined);
});

test('ordinary identity discards stale demo headers',()=>{
 const h=headers({context:{'x-demo-role':'admin','x-active-domain':'foreign'}});
 assert.equal(h['x-active-domain'],'operations');assert.equal(h['x-demo-role'],undefined);
});
