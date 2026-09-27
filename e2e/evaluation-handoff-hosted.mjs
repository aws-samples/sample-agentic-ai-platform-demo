// Actual hosted Compose from Catalog acceptance. Uses temporary operator-created
// credentials; stores only synthetic inputs and response metadata, never tokens.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const base=process.env.BASE_URL,out=process.env.EVIDENCE_DIR,domainId=process.env.TEST_DOMAIN||'platform';
const restricted=false;
const manualLogin=process.env.MANUAL_LOGIN==='true';
assert.ok(base?.startsWith('https://')&&out&&(manualLogin||process.env.LOGIN_FILE));
const user=manualLogin?null:JSON.parse(await readFile(process.env.LOGIN_FILE,'utf8'))[0];
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:!manualLogin});
const context=await browser.newContext({viewport:{width:1600,height:1000},...(process.env.TEST_DOMAIN?{extraHTTPHeaders:{'x-demo-role':'lead','x-active-domain':domainId}}:{}),recordVideo:{dir:out+'/video',size:{width:1600,height:1000}}});
const page=await context.newPage();page.setDefaultTimeout(60000);
let preparedPayload;
const report={projectCreates:0,startedAt:new Date().toISOString(),mode:'acceptance',domainId,restrictedProject:restricted,requests:[],errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
page.on('request',r=>{if(new URL(r.url()).pathname==='/api/projects'&&r.method()==='POST')report.projectCreates++;});
page.on('dialog',d=>d.accept());
page.on('response',async r=>{if(/\/api\/agents(?:\/[^/]+)?(?:\/test)?$/.test(new URL(r.url()).pathname)&&['POST','PUT'].includes(r.request().method())){const body=await r.json().catch(()=>({}));const p=r.request().postDataJSON();if(r.request().method()==='POST'&&r.status()===201)preparedPayload=p;report.requests.push({path:new URL(r.url()).pathname,method:r.request().method(),status:r.status(),code:body.code,description:p.description,instructions:p.buildConfig?.instructions,agentStatus:body.agent?.status});}});
async function api(path,body){return page.evaluate(async({path,body,id})=>{const {accessToken}=JSON.parse(sessionStorage.getItem('console.cognito.tokens'));const r=await fetch('/api'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+accessToken,...(body?{'content-type':'application/json','x-request-id':id}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};},{path,body,id:randomUUID()});}
try{
 await page.goto(base);await page.locator('#cognitosignin').click({timeout:90000});
 if(user){
  await page.locator('input[name=username]:visible').fill(user.username);await page.locator('input[name=password]:visible').fill(user.password);
  await page.locator('input[name=signInSubmitButton]:visible,button[type=submit]:visible').first().click();
 }
 await page.waitForURL(base+'/**',{timeout:manualLogin?3_600_000:90000});await page.locator('[data-shellnav]').first().waitFor({timeout:90000});
 const gateway=await api('/ai-gateway'),registry=await api('/registry');
 assert.equal(gateway.status,200);assert.equal(registry.status,200);
 report.registryModelIds=registry.body.entries.filter(e=>e.type==='Model').map(e=>e.id);
 report.allowedModelIds=gateway.body.models.filter(m=>(m.accessByDomain?.[domainId]??m.access)?.usable===true).map(m=>m.id);
 const id=process.env.TEST_PROJECT_ID;
 assert.ok(id,'Set TEST_PROJECT_ID to an existing authorized workspace; acceptance must not create projects.');report.projectId=id;
 const permittedModel=report.allowedModelIds.find(id=>id.includes('haiku-4-5'));assert.ok(permittedModel);
 const blueprint=registry.body.entries.find(e=>e.id==='chat-assistant');assert.ok(blueprint);
 await page.locator('[data-shellnav="bwbuild"]').click();await page.locator('[data-door="blueprint"]').click({timeout:90000});
 await page.locator('#buildproject option[value="'+id+'"]').waitFor({state:'attached',timeout:90000});await page.locator('#buildproject').selectOption(id);
 await page.locator('[data-bp]').filter({hasText:'Chat'}).first().click({timeout:90000});await page.locator('#n1').click();
 await page.locator('#model option').first().waitFor({state:'attached',timeout:90000});
 report.modelChoices=await page.locator('#model option').evaluateAll(nodes=>nodes.map(n=>n.value));
 const model=report.modelChoices.find(id=>id.includes('haiku-4-5'));assert.ok(model);await page.locator('#model').selectOption(model);
 assert.deepEqual([...report.modelChoices].sort(),restricted?[permittedModel]:report.registryModelIds.filter(id=>report.allowedModelIds.includes(id)).sort());assert.ok(report.registryModelIds.includes(permittedModel));report.projectRestrictionVerified=restricted;
  await page.locator('#persona').fill('');await page.locator('#gen').click();await page.locator('#gs').filter({hasText:'Enter a persona / system prompt'}).waitFor();assert.equal(report.requests.length,0);report.emptyPromptValidatedBeforeMutation=true;
 await page.locator('#pname').fill(process.env.TEST_AGENT_NAME||'Builder handoff verification');
 const multiline='You are a contract review assistant.\nSummarize the request clearly.\nAsk for missing details; never invent contract terms.';
 await page.locator('#persona').fill(multiline);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:out+'/compose-configured.png',fullPage:true});await page.locator('#gen').click();
 await page.locator('#eval-dataset').waitFor({timeout:120000});
 report.reachedStep3=true;
 assert.equal(report.requests[0].status,201);assert.equal(report.requests[0].instructions,multiline);assert.equal(report.requests[0].description,multiline.replaceAll('\n',' '));
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:out+'/generated-step3.png',fullPage:true});

 assert.equal(await page.locator('#val').count(),0,'No misleading Agent test at handoff');
 async function preview(){
  const waiting=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/delivery/previews'&&r.request().method()==='POST',{timeout:120000});
  await page.locator('#exp').click();const response=await waiting;const payload=await response.json();
  assert.equal(response.status(),201,JSON.stringify(payload));
  await page.locator('[data-delivery-card]').waitFor();
  const files=page.locator('#expprev > details');await files.click();
  const configFile=page.locator('#expprev details').filter({has:page.locator('summary code').filter({hasText:'evaluation/config.json'})}).last();
  await configFile.locator('summary').click();assert.match(await configFile.locator('pre').innerText(),/NOT_RUN/);
  await files.locator(':scope > summary').click();
  return payload.delivery.manifest;
 }
 const deferred=await preview();
 if(process.env.EXPECT_REPOSITORY_NAME)assert.equal(await page.locator('#ghrepo').inputValue(),process.env.EXPECT_REPOSITORY_NAME,'Repository defaults to the Agent build name');
 await page.locator('[data-delivery-token]').waitFor();
 await page.locator('[data-delivery-approve]').waitFor();
 report.directGitHubExportAvailable=true;
 assert.ok(deferred.entries.some(f=>f.path==='evaluation/test_evaluation.py'));
 assert.ok(!deferred.entries.some(f=>f.path==='evaluation/dataset.jsonl'));
 report.deferredExport=true;
 await page.screenshot({path:out+'/deferred-export.png',fullPage:true});
 await page.getByText('Alternative: download a copy',{exact:true}).click();
 const downloading=page.waitForEvent('download');await page.locator('[data-delivery-download]').click();
 const archive=await downloading;await archive.saveAs(out+'/deferred-construct.zip');report.downloaded=true;
 await page.locator('#eval-dataset').selectOption('upload');
 const dataset=JSON.stringify({id:'business-case',input:'A synthetic task',expected:'Synthetic answer'})+'\n';
 await page.locator('#eval-upload').setInputFiles({name:'business.jsonl',mimeType:'application/json',buffer:Buffer.from(dataset)});
 await page.getByText('1 cases loaded. Dataset contents will be included in GitHub.').waitFor();
 await page.locator('#eval-evaluator').selectOption('python');
 const code='def evaluate(case, result):\n    return {"score": 0.0, "reason": "Implement business rubric locally"}\n';
 await page.locator('#eval-code').fill(code);
 assert.equal(await page.locator('[data-delivery-approve]').count(),0,'Old preview invalidated after editing');
 const custom=await preview();
 assert.equal(custom.entries.find(f=>f.path==='evaluation/dataset.jsonl').content,dataset);
 assert.equal(custom.entries.find(f=>f.path==='evaluation/evaluator.py').content,code);
 assert.notEqual(custom.fingerprint,deferred.fingerprint);
 report.customExport=true;
 await page.screenshot({path:out+'/custom-evaluation-export.png',fullPage:true});
 await page.locator('#eval-dataset').selectOption('reference');
 await page.locator('#eval-reference').fill('s3://builder-evaluation-example/private-cases.jsonl');
 await page.locator('#eval-evaluator').selectOption('agentcore');
 await page.locator('#eval-agentcore-id').fill('Builtin.Helpfulness');
 const agentcore=await preview();
 assert.ok(!agentcore.entries.some(f=>f.path==='evaluation/dataset.jsonl'));
 assert.match(agentcore.entries.find(f=>f.path==='evaluation/evaluator.py').content,/sessionSpans/);
 report.agentcoreAdapterExport=true;
 report.modelTests=report.requests.filter(r=>r.path.endsWith('/test')).length;
 assert.equal(report.modelTests,0);
 assert.deepEqual(report.errors,[]);
 assert.equal(report.projectCreates,0,'Builder journey must not create project records');
 if(manualLogin&&process.env.OBSERVE_HUMAN_RELEASE==='true'){
  report.builderVerifiedAt=new Date().toISOString();
  await writeFile(out+'/builder-report.json',JSON.stringify(report,null,2));
  await page.locator('[data-shellnav="governance"]').click();
  await page.locator('[data-queue-section="agent-releases"]').click();
  await page.locator('#governed-release-delivery').waitFor();
  await page.screenshot({path:out+'/release-queue.png',fullPage:true});
  // The owner reviews and submits the decision. Observe only; never fill a
  // reason, click a decision control, or make the decision request in code.
  report.automationSubmittedDecision=false;
  const response=await page.waitForResponse(r=>r.request().method()==='POST'
   &&new URL(r.url()).pathname==='/api/release-decisions'&&r.ok(),{timeout:3_600_000});
  const payload=response.request().postDataJSON();
  report.humanDecision=Object.fromEntries(
   ['pipelineId','executionId','commitSha','artifactSha256','accountId','region','environment','decision']
    .map(key=>[key,payload[key]]));
  report.decisionHttpStatus=response.status();
  await page.waitForTimeout(5000);
  await page.screenshot({path:out+'/human-decision-result.png',fullPage:true});
 }
 report.finishedAt=new Date().toISOString();
}finally{await context.close();await browser.close();await writeFile(out+'/report.json',JSON.stringify(report,null,2));}
