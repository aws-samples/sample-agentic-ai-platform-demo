import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {defaultGuardrailChain,validateGuardrailChain} from './public/guardrail-chain.mjs';
import {normalizeSelectedResourceIds,resolveBuildModelId} from './public/main-ui-compat.mjs';
import {activeBuildProjects,createMainUiBuildActions} from './public/main-ui-build.mjs';
import {validateAgentBuildConfig} from '../infra/serverless-platform/lambda/workspace/state.mjs';
const source=readFileSync(new URL('./public/modules/app.mjs',import.meta.url),'utf8');
function inputFor(prompt){
 const project={domainId:'platform',id:'existing-project',name:'Existing project',description:'Workspace'};
 const ctx=vm.createContext({S:{project:'Contract reviewer',persona:prompt,bp:'chat-assistant',door:'blueprint',blueprints:[{id:'chat-assistant',template:{}}],tools:new Set(),skills:new Set(),mcp:new Set()},SESSION:{role:'admin'},authMode:()=> 'cognito',activeDomain:()=> 'platform',currentMainBuildProject:()=>project,mainProjectCatalog:()=>({models:[{id:'model-a'}]}),defaultGuardrailChain,validateGuardrailChain,normalizeSelectedResourceIds,resolveBuildModelId});
 for(const name of ['mainBuildSlug','mainBuildDomainId','mainBuildOptions','mainBuildGuardrailChain','mainBuildAgentInput']){
  const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}\n',start)+2;assert.ok(start>=0);vm.runInContext(source.slice(start,end),ctx);
 }
 return JSON.parse(JSON.stringify(ctx.mainBuildAgentInput()));
}
test('actual Compose input keeps multiline instructions out of single-line metadata',()=>{
 const prompt='Review the contract.\n\nCheck:\n\t- Missing dates\r\n\t- Ambiguous terms';
 const input=inputFor(prompt);
 assert.equal(input.agent.buildConfig.instructions,prompt);
 assert.doesNotMatch(input.agent.description,/[\u0000-\u001f\u007f]/);
 assert.equal(input.agent.description,'Review the contract. Check: - Missing dates - Ambiguous terms');
 assert.equal(input.agent.projectId,'existing-project');
 assert.equal(validateAgentBuildConfig(input.agent.buildConfig).instructions,prompt);
});
for(const prompt of ['', '  ', 'x'.repeat(16385), 'Invalid\u0000prompt']) test(`invalid Compose prompt is explained before any mutation (${prompt.length} chars)`,async()=>{
 let requests=0;
 const actions=createMainUiBuildActions({request:async()=>{requests++;throw Error('must not call API');},requestId:()=> 'unused'});
 const response=await actions.prepareAgent(inputFor(prompt));
 assert.equal(response.code,'INVALID_BUILD_INPUT');assert.match(response.message,/prompt/);assert.equal(requests,0);
});

test('actual Compose picker and restored selection reject archived projects',()=>{
 const ctx=vm.createContext({
  S:{mainBuildProjectId:'data-analyst',mainBuildProjects:[
   {id:'data-analyst',name:'Archived analyst',domainId:'platform',status:'ARCHIVED'},
   {id:'it-helpdesk',name:'IT Helpdesk',domainId:'platform',status:'ACTIVE'},
   {id:'case-assist',name:'Foreign project',domainId:'customer_support',status:'ACTIVE'},
  ]},
  authMode:()=> 'cognito',mainBuildDomainId:()=> 'platform',activeBuildProjects,esc:String,
 });
 for(const name of ['currentMainBuildProject','mainProjectPicker']){
  const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}\n',start)+2;
  assert.ok(start>=0);vm.runInContext(source.slice(start,end),ctx);
 }
 assert.equal(ctx.currentMainBuildProject(),null);
 const html=ctx.mainProjectPicker();
 assert.match(html,/IT Helpdesk/);
 assert.doesNotMatch(html,/Archived analyst|Foreign project|value="data-analyst"/);
 ctx.S.mainBuildProjectId='it-helpdesk';
 assert.equal(ctx.currentMainBuildProject().id,'it-helpdesk');
});
