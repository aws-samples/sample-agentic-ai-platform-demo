import test from 'node:test';import assert from 'node:assert/strict';
import {approvalCatalogView} from './public/governance-policy-view.mjs';
import {guardrailCatalogView} from './public/governance-policy-view.mjs';
import {GUARDRAIL_CATALOG} from './public/guardrail-chain.mjs';
test('Guardrails resource page shows controls and never substitutes blueprint rows',()=>{
 const html=guardrailCatalogView(GUARDRAIL_CATALOG);
 for(const text of ['PII Detection','Harmful Content','Prompt Injection','Mandatory','Default action','Execution stage','Not permitted'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/Blueprint|Framework|Deployment target/);
 assert.match(html,/Runtime attachment must be verified/);
});
test('policy metadata distinguishes scope, snapshot revision, policy version and enforcement',()=>{const html=approvalCatalogView({domainId:'platform',revision:3,updatedAt:'2026-09-14',policies:[{id:'synthetic',name:'<script>',version:2,enabled:false,mode:'require_approval',scope:{kind:'domain'},createdAt:'2026-09-14',toolMatch:['delete_*']}]});assert.ok(html.includes('Configuration disabled'));assert.ok(html.includes('Catalog v3'));assert.ok(html.includes('Policy version'));assert.ok(html.includes('Not configured'));assert.ok(html.includes('&lt;script&gt;'));assert.doesNotMatch(html,/Create policy|data-en=/);});
test('native Gateway policy view distinguishes absent, observe and enforce configuration from draft intent',async()=>{
 const {runtimePolicyView}=await import('./public/governance-policy-view.mjs');
 const base={ok:true,schemaVersion:1,source:'agentcore-policy',scope:'shared-platform-gateways',checkedAt:'2026-09-17',complete:true};
 const g={id:'tools',label:'Tools',arn:'synthetic',status:'READY',authorizerType:'AWS_IAM',policies:[],complete:true,error:null};
 const absent=runtimePolicyView({...base,gateways:[{...g,binding:'NOT_ATTACHED'}]});assert.match(absent,/No Policy Engine attached/);assert.doesNotMatch(absent,/badge-green/);
 const observe=runtimePolicyView({...base,gateways:[{...g,binding:'ATTACHED',mode:'LOG_ONLY',engine:{id:'test',arn:'synthetic',status:'ACTIVE'}}]});assert.match(observe,/Observe · LOG_ONLY/);assert.doesNotMatch(observe,/badge-green/);
 const enforced=runtimePolicyView({...base,gateways:[{...g,binding:'ATTACHED',mode:'ENFORCE',engine:{id:'test',arn:'synthetic',status:'ACTIVE'}}]});assert.match(enforced,/ENFORCE defaults to deny/);
 const partial=runtimePolicyView({...base,complete:false,gateways:[{...g,complete:false,binding:'UNKNOWN',error:'THROTTLED'}]});assert.match(partial,/unavailable/);assert.doesNotMatch(partial,/No Policy Engine attached/);
});
test('native policy definitions are escaped and engine failure cannot look enforced',async()=>{
 const {runtimePolicyView}=await import('./public/governance-policy-view.mjs');const html=runtimePolicyView({ok:true,schemaVersion:1,source:'agentcore-policy',scope:'shared-platform-gateways',checkedAt:'now',complete:true,gateways:[{id:'tools',label:'Tools',binding:'ATTACHED',mode:'ENFORCE',status:'READY',complete:true,engine:{id:'test',status:'CREATE_FAILED'},policies:[{name:'<script>bad</script>',status:'ACTIVE',statement:'<img src=x onerror=alert(1)>'}]}]});assert.doesNotMatch(html,/<script>|<img |badge-green/);assert.match(html,/&lt;script&gt;/);
});
