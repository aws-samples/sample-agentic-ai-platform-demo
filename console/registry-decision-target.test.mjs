import test from 'node:test'
import assert from 'node:assert/strict'
import { registryDecisionTarget, registryDecisionAllowed, sameRegistryDecisionRecord } from './public/registry-decision-target.mjs'
const entry={id:'example-skill',type:'Skill',domain:'platform',_source:'agentcore-registry',_registryId:'SyntheticReg1'}
const version={semver:'1.0.0',status:'IN_REVIEW',_aws:{registryId:'SyntheticReg1',recordId:'SyntheticRec',awsStatus:'PENDING_APPROVAL'}}
const options={hosted:true,canDecide:true,actor:'reviewer'}
test('Gateway Model and MCP projections never route to native approval even with forged native metadata',()=>{
  for(const type of ['Model','MCPServer']) {
    const row={...entry,type,_source:'gateway'}
    assert.equal(registryDecisionTarget(row,version,true),type==='Model'?'model-policy':'tool-policy')
    assert.equal(registryDecisionAllowed(row,version,options),false)
  }
  // Gateway Model can never masquerade as a native record; MCPServer is decided
  // only on the genuine agentcore-registry native path (covered below).
  assert.equal(registryDecisionTarget({...entry,type:'Model',_source:'agentcore-registry'},version,true),null)
})
test('legitimate native pending platform/shared records allow only authorized decisions',()=>{
  for(const type of ['Skill','Blueprint','A2AAgent','MCPServer'])for(const domain of ['platform','shared']){
    const row={...entry,type,domain}
    assert.equal(registryDecisionTarget(row,version,true),'registry')
    assert.equal(registryDecisionAllowed(row,version,options),true)
    assert.equal(registryDecisionAllowed(row,version,{...options,canDecide:false}),false)
  }
})
test('native MCPServer stays fail-closed outside platform/shared domains',()=>{
  const row={...entry,type:'MCPServer',domain:'domain_a'}
  assert.equal(registryDecisionTarget(row,version,true),null)
  assert.equal(registryDecisionAllowed(row,version,options),false)
})
for(const [label,e,v] of [
 ['no ID',entry,{...version,_aws:{...version._aws,recordId:''}}],
 ['fabricated routing ID',entry,{...version,_aws:{...version._aws,recordId:'model/anything'}}],
 ['foreign registry',{...entry,_registryId:'DifferentReg'},version],
 ['unknown provenance',{...entry,_source:'user-supplied'},version],
 ['missing provenance',{...entry,_source:null},version],
 ['native approved',entry,{...version,_aws:{...version._aws,awsStatus:'APPROVED'}}],
 ['stale display',entry,{...version,status:'APPROVED'}],
 ['foreign domain',{...entry,domain:'domain_a'},version],
 ['bad semver',entry,{...version,semver:'../1'}],
])test(`fail closed: ${label}`,()=>assert.equal(registryDecisionAllowed(e,v,options),false))
test('publication binds exact native record, pending approval and independent actor',()=>{
  const e={...entry,type:'Agent',domain:'domain_a'}
  const approval={id:'approval-one',resourceId:'SyntheticReg1/SyntheticRec',kind:'RESOURCE_PUBLICATION',resourceType:'AGENT',status:'PENDING',requesterSubject:'requester'}
  const v={...version,_approval:approval},o={...options,approvalId:approval.id}
  assert.equal(registryDecisionAllowed(e,v,o),true)
  for(const patch of [{actor:'requester'},{actor:''},{approvalId:'different'},{canDecide:false}]) assert.equal(registryDecisionAllowed(e,v,{...o,...patch}),false)
  for(const patch of [{resourceId:'SyntheticReg1/OtherRecord1'},{status:'APPROVED'},{requesterSubject:''},{kind:'MODEL_ACCESS'}]) assert.equal(registryDecisionAllowed(e,{...v,_approval:{...approval,...patch}},o),false)
})
test('fresh revalidation rejects record replacement, status and provenance swaps',()=>{
 assert.equal(sameRegistryDecisionRecord(entry,version,structuredClone(entry),structuredClone(version),true),true)
 for(const v of [{...version,_aws:{...version._aws,recordId:'OtherRecord1'}},{...version,status:'APPROVED'}])assert.equal(sameRegistryDecisionRecord(entry,version,entry,v,true),false)
 assert.equal(sameRegistryDecisionRecord(entry,version,{...entry,_source:'gateway'},version,true),false)
})
test('offline compatibility does not widen hosted writer',()=>assert.equal(registryDecisionTarget({type:'Model'},{status:'IN_REVIEW'},false),'registry'))
