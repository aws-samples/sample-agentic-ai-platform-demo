import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPublicationSubmission} from './public/publication-submission.mjs';
function mount(role,domain,active='platform',caps=['submitDomainResourcePublication']){
 const button={disabled:false,hidden:false},box={textContent:''};let reads=0;
 const root={isConnected:true,querySelector:s=>s==='[data-publication-check]'?button:box};
 mountPublicationSubmission(root,{row:{entry:{domain},version:{_aws:{registryId:'SyntheticReg1',recordId:'SyntheticRec'}}},api:async()=>{reads++;return {ok:false}},readApprovals:async()=>{reads++;return {ok:false}},current:()=>true,identity:()=>'',requestId:()=>'',reload:()=>{},access:{role,resourceDomain:domain,activeDomain:active,capabilities:caps}});
 return {button,box,reads:()=>reads};
}
for(const [role,domain,active,caps] of [['admin','operations','platform',['submitDomainResourcePublication']],['lead','operations','customer_support',['submitDomainResourcePublication']],['user','platform','platform',[]]]){
 test(`${role} outside allowed submission scope has no executable entry`,async()=>{
  const x=mount(role,domain,active,caps);assert.equal(x.button.hidden,true);assert.equal(x.button.disabled,true);
  await x.button.onclick?.();assert.equal(x.reads(),0);assert.ok(x.box.textContent.length>0);
 });
}
test('platform admin and same-domain builder retain GET eligibility rather than client owner approval',()=>{
 for(const x of [mount('admin','platform'),mount('builder','operations','operations')]){
  assert.equal(x.button.hidden,false);assert.equal(typeof x.button.onclick,'function');assert.equal(x.reads(),0);
 }
});
