import test from 'node:test';
import assert from 'node:assert/strict';
import {planBlueprintRelease} from './publish-platform-blueprints.mjs';
const payload={resourceKind:'blueprint',blueprintId:'chat-assistant',source:{kind:'repo',templateId:'chatagent'},recommended:true};
const seed={registryRef:'shared',name:'blueprint_chat_assistant',displayName:'Chat Assistant',recordType:'CUSTOM',version:'1.3.0-platform-descriptor.1',descriptors:{custom:{data:JSON.stringify(payload)}}};
const legacy={name:'blueprint_chat-assistant',recordType:'CUSTOM',recordVersion:'1.0.0',status:'APPROVED',descriptors:{custom:{data:JSON.stringify({resourceKind:'blueprint',blueprintId:'chat-assistant'})}}};
test('baseline publication retains the existing Registry/name used by domain grants',()=>{
 const [plan]=planBlueprintRelease([seed],[legacy]); assert.equal(plan.desired.name,legacy.name);assert.equal(plan.action,'CREATE_APPROVED_BASELINE');
});
test('baseline publication is idempotent and refuses immutable conflicts or unrelated pending approval',()=>{
 const current={...legacy,recordId:'r2',recordVersion:seed.version,descriptors:seed.descriptors};
 assert.equal(planBlueprintRelease([seed],[legacy,current])[0].action,'UNCHANGED');
 assert.throws(()=>planBlueprintRelease([seed],[{...current,descriptors:legacy.descriptors}]),/conflict/);
 assert.throws(()=>planBlueprintRelease([seed],[{...current,status:'PENDING_APPROVAL'}]),/original publication workflow/);
 assert.throws(()=>planBlueprintRelease([seed],[legacy,{...legacy,name:'another'}]),/Ambiguous/);
});
test('platform repair only updates recognized existing repository copies and retains their scope',()=>{
 assert.deepEqual(planBlueprintRelease([seed],[],{scope:'platform'}),[]);
 assert.throws(()=>planBlueprintRelease([seed],[legacy],{scope:'platform'}),/not a recognized/);
 const copy={...legacy,descriptors:{custom:{data:JSON.stringify({...payload,git:{repo:'github.com/aws-samples/sample-agentic-ai-platform-demo',path:'blueprints/chat-assistant'}})}}};
 const [plan]=planBlueprintRelease([seed],[copy],{scope:'platform'});
 assert.equal(plan.desired.name,copy.name);
 assert.deepEqual(JSON.parse(plan.desired.descriptors.custom.data)['x-platform'],{domainId:'platform',shared:false});
});
