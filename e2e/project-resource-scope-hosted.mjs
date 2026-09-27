// Creates two clearly named validation projects and one non-invoked agent draft.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const base=process.env.DOMAIN_BOOTSTRAP_APP_URL?.replace(/\/$/,'');
const domainId=process.env.DOMAIN_BOOTSTRAP_DOMAIN_ID;
const evidence=process.env.DOMAIN_BOOTSTRAP_EVIDENCE_DIR;
const identities=JSON.parse(await readFile(process.env.DOMAIN_BOOTSTRAP_IDENTITIES_FILE,'utf8'));
assert.ok(base?.startsWith('https://')&&domainId&&evidence&&identities.lead?.tokens);
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true});
let activePage;
try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 await context.addInitScript(tokens=>sessionStorage.setItem('console.cognito.tokens',JSON.stringify(tokens)),identities.lead.tokens);
 const headers={authorization:`Bearer ${identities.lead.tokens.accessToken}`,'x-active-domain':domainId};
 const checks=[];
 async function request(path,{data,method='GET',status=200}={}){
  const response=await context.request.fetch(base+path,{method,data,headers:{...headers,'x-request-id':`scope-check-${Date.now()}-${checks.length}`}});
  const body=await response.json();checks.push({path,method,status:response.status(),code:body.code});
  assert.equal(response.status(),status,`${method} ${path}: ${JSON.stringify(body)}`);return body;
 }
 const registry=await request('/api/registry');assert.equal(registry.domainResourcePolicyApplied,true);
 const operation=(await request(`/api/domain-bootstrap?domainId=${domainId}`)).operation;
 assert.equal(operation.status,'SUCCEEDED');
 const handoffUser=process.env.DOMAIN_BOOTSTRAP_HANDOFF_USER||operation.configuration.administrator;
 assert.ok(handoffUser&&!Object.values(identities).some(identity=>identity.username===handoffUser),
  'Validation workspaces must be handed to a persistent administrator, not a temporary verifier.');
 const models=registry.entries.filter(e=>e.type==='Model');assert.ok(models.length>1);
 assert.deepEqual(models.map(e=>e.id).sort(),operation.configuration.models.map(ref=>ref.id).sort());
 const modelA=models.find(e=>e.id.includes('haiku'))||models[0];const modelB=models.find(e=>e.id!==modelA.id);
 const chat=registry.entries.find(e=>e.type==='Blueprint'&&e.name==='Chat Assistant');
 const workflow=registry.entries.find(e=>e.type==='Blueprint'&&e.name==='Workflow Orchestrator');assert.ok(chat&&workflow);
 const page=await context.newPage();activePage=page;const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
 page.on('dialog',dialog=>dialog.accept());
 await page.goto(base,{waitUntil:'domcontentloaded'});
 const created=[];
 const previous=(await request('/api/projects?limit=50')).items;
 for(const [id,model,blueprint] of [['scope-validation-a',modelA,chat],['scope-validation-b',modelB,workflow]]){
  const existing=previous.find(project=>project.id===id&&project.domainId===domainId);
  if(existing){
   assert.deepEqual(existing.resourcePolicy.resources.map(ref=>ref.id).sort(),[model.id,blueprint.id].sort());
   created.push(existing);continue;
  }
  await page.locator('[data-shellnav="projects"]').click({timeout:60_000});
  await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.locator('[data-wtpl="blank"]').click({timeout:30_000});
  await page.locator('#wnext').click();
  await page.getByLabel('Project ID',{exact:true}).fill(id);await page.getByLabel('Project name',{exact:true}).fill(id);
  await page.locator('#wnext').click();
  const modelGroup=page.getByRole('group',{name:'Project models',exact:true});
  assert.equal(await modelGroup.getByRole('checkbox').count(),models.length,'Project starts from the full domain model palette');
  await page.getByRole('button',{name:'Clear selection',exact:true}).click();
  await modelGroup.getByRole('checkbox',{name:model.name,exact:true}).check();
  await page.getByRole('group',{name:'Project blueprints',exact:true}).getByRole('checkbox',{name:blueprint.name,exact:true}).check();
  await page.screenshot({path:`${evidence}/${id}-resources.png`,fullPage:true});
  await page.locator('#wnext').click();await page.locator('#wreviewbudget').uncheck();
  await page.locator('#wnext').click();await page.locator('#wnext').click();
  assert.ok((await page.locator('#wizreview').innerText()).includes(model.name));
  await page.screenshot({path:`${evidence}/${id}-review.png`,fullPage:true});
  const response=page.waitForResponse(r=>r.url().endsWith('/api/projects')&&r.request().method()==='POST');
  await page.locator('#wcreate').click();const result=await response;assert.equal(result.status(),201);
  const project=(await result.json()).project;assert.deepEqual(project.resourcePolicy.resources.map(r=>r.id).sort(),[model.id,blueprint.id].sort());created.push(project);
  await page.getByRole('heading',{name:'Project created',exact:true}).waitFor();
  console.log(`Created and verified ${id}.`);
 }
 const projects=(await request('/api/projects?limit=50')).items;
 for(const project of created)assert.deepEqual(projects.find(p=>p.id===project.id)?.resourcePolicy,project.resourcePolicy);
 await request('/api/projects',{method:'POST',status:403,data:{id:'scope-forbidden-project',name:'Forbidden scope probe',description:'Must not be created',resourcePolicy:{resources:[{type:'Model',id:'gateway/not-registered',registryId:null}]}}});
 await page.locator('[data-shellnav="bwbuild"]').click({timeout:60_000});
 await page.locator('[data-door="blueprint"]').click({timeout:60_000});
 await page.locator('#buildproject').waitFor({timeout:60_000});
 for(const [project,model,blueprint] of [[created[0],modelA,chat],[created[1],modelB,workflow]]){
  await page.locator('#buildproject').selectOption(project.id);
  await page.locator(`[data-bp="${blueprint.id}"]`).waitFor({timeout:60_000});
  assert.deepEqual(await page.locator('[data-bp]').evaluateAll(options=>options.map(o=>o.dataset.bp)),[blueprint.id]);
  await page.locator(`[data-bp="${blueprint.id}"]`).click();
  await page.locator('#n1').click();
  await page.locator('#model').waitFor({timeout:60_000});
  assert.deepEqual(await page.locator('#model option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean)),[model.id]);
  await page.screenshot({path:`${evidence}/${project.id}-builder.png`,fullPage:true});
 }
 const payload={domainId,projectId:created[0].id,id:'scope-validation-agent',name:'Scope validation agent',description:'Non-invoked scope verification draft',
  modelId:modelA.id,toolIds:[],mcpServerIds:[],skillIds:[],blueprintIds:[chat.id],memoryIds:[],knowledgeBaseIds:[],
  buildConfig:{instructions:'Validate project resource selection without model invocation.',
   modelParameters:{temperature:null,maxTokens:1},
   buildOptions:{framework:'Strands',deployTarget:'AgentCore Runtime',memory:'none',streaming:true,identity:true,guardrails:true}}};
 await request('/api/agents',{method:'POST',status:201,data:payload});
 await request('/api/agents',{method:'POST',status:403,data:{...payload,id:'scope-forbidden-model',modelId:modelB.id}});
 await request('/api/agents',{method:'POST',status:403,data:{...payload,id:'scope-forbidden-template',blueprintIds:[workflow.id]}});
 const agentId=payload.id;
 await request(`/api/agents/${agentId}`,{method:'PUT',data:payload});
 await request(`/api/agents/${agentId}/test`,{method:'POST',status:403,data:{
  domainId,projectId:payload.projectId,prompt:'Verify runtime policy enforcement.',maxTokens:1,
 }});
 // Verify access for the persistent owner, not only for the temporary creator.
 for(const project of created){
  await request('/api/access/project-memberships',{method:'POST',status:201,data:{
   domainId,projectId:project.id,username:handoffUser,
   reason:'Hand over the validation workspace to its persistent domain administrator for deployed Builder verification.',
  }});
  const roster=await request(`/api/access/project-members?domainId=${encodeURIComponent(domainId)}&projectId=${encodeURIComponent(project.id)}&limit=50`);
  assert.ok(roster.items?.some(member=>member.username===handoffUser),
   `The persistent administrator must be listed as a member of ${project.id}.`);
 }
 assert.deepEqual(browserErrors,[]);
 await writeFile(`${evidence}/project-resource-scope-result.json`,JSON.stringify({passed:true,domainId,handoffUser,registeredModels:models.length,projects:created,checks,browserErrors},null,2));
 console.log('Hosted domain catalog, two project subsets, persisted selection, builder filtering and API scope denials verified. No model invoked.');
}catch(error){
 if(activePage){
  await activePage.screenshot({path:`${evidence}/project-scope-failure.png`,fullPage:true});
  await writeFile(`${evidence}/project-scope-failure.txt`,await activePage.locator('body').innerText());
 }
 throw error;
}finally{await browser.close();}
