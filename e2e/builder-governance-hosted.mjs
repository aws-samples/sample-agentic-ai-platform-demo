// Real hosted acceptance. Uses private temporary Cognito fixtures created by the
// operator; no tokens, passwords or user prompts are written into the report.
// Creates a clearly named project and agent. Never approves a production release.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const base=process.env.BASE_URL,out=process.env.EVIDENCE_DIR;
assert.ok(base?.startsWith('https://')&&out&&process.env.LOGIN_FILE);
const [author,reviewer]=JSON.parse(await readFile(process.env.LOGIN_FILE,'utf8'));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const report={url:base,startedAt:new Date().toISOString(),checks:[],browserErrors:[]};
const contexts=[];
async function login(user,record=false){
 const recordingStartedAt=new Date().toISOString();
 const context=await browser.newContext({viewport:{width:1600,height:900},...(record?{recordVideo:{dir:out+'/raw',size:{width:1600,height:900}}}:{})});contexts.push(context);
 const page=await context.newPage();if(record){report.videos??=[];report.videos.push({role:user.role,startedAt:recordingStartedAt,path:await page.video().path()});}page.on('pageerror',e=>report.browserErrors.push(e.message));page.on('dialog',d=>d.accept());page.on('response',async r=>{if(r.url().includes('/api/')&&r.status()>=400){const data=await r.json().catch(()=>({}));report.apiFailures??=[];report.apiFailures.push({path:new URL(r.url()).pathname,status:r.status(),code:data.code});}});
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.locator('#cognitosignin').click({timeout:90000});
 await page.locator('input[name=username]:visible').fill(user.username);await page.locator('input[name=password]:visible').fill(user.password);
 await page.locator('input[name=signInSubmitButton]:visible,button[type=submit]:visible').first().click();await page.waitForURL(base+'/**',{timeout:90000});await page.locator('[data-shellnav]').first().waitFor({timeout:90000});return page;
}
async function api(page,path,body,extra={}){return page.evaluate(async({path,body,extra,requestId})=>{
 const tokens=JSON.parse(sessionStorage.getItem('console.cognito.tokens'));
 const r=await fetch('/api'+path,{signal:AbortSignal.timeout(60000),method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokens.accessToken,...(body?{'content-type':'application/json','x-request-id':requestId}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};
},{path,body,extra,requestId:randomUUID()});}
let page;
async function shot(name){const focus=name.startsWith('03')?'[data-build-test-result]':/^0[45]/.test(name)?'[data-delivery-download]':name.startsWith('07')?'[data-exception-form]':/^0[89]/.test(name)?'[data-exception-detail]':null;if(focus)await page.locator(focus).scrollIntoViewIfNeeded();if(name.startsWith('06'))await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:out+'/'+name+'.png',fullPage:true});await page.screenshot({path:out+'/'+name+'-viewport.png'});report.checks.push({name,at:new Date().toISOString()});await page.waitForTimeout(1800);await writeFile(out+'/report.json',JSON.stringify(report,null,2));}
try{
 page=await login(author,true);
 if(process.env.RESUME_REPORT){const prior=JSON.parse(await readFile(process.env.RESUME_REPORT,'utf8'));for(const key of ['projectId','domainId','agentId','modelId'])report[key]=prior[key];}
 if(!process.env.RESUME_REPORT){
 const models=await api(page,'/ai-gateway');assert.equal(models.status,200,JSON.stringify(models.body));assert.ok(models.body.models?.length||models.body.aiGateway?.models?.length);
 const id=process.env.PROJECT_ID||'builder-validation-'+Date.now();report.projectId=id;
 const project=process.env.PROJECT_ID?{status:201,body:{project:{domainId:process.env.DOMAIN_ID||'platform'}}}:await api(page,'/projects',{id,name:'Customer care workspace',description:'Synthetic builder and governance acceptance workspace.'});assert.equal(project.status,201,JSON.stringify(project.body));report.domainId=project.body.project.domainId;
 await page.locator('[data-shellnav="bwbuild"]').click();await page.locator('[data-door="blueprint"]').click({timeout:90000});
 await page.locator('#buildproject option[value="'+id+'"]').waitFor({state:'attached',timeout:90000});await page.locator('#buildproject').selectOption(id);
 await page.locator('[data-bp]').first().waitFor({timeout:90000});await page.locator('[data-bp]').filter({hasText:'Chat'}).first().click();await shot('01-blueprint');await page.locator('#n1').click();
 await page.locator('#model option').first().waitFor({state:'attached'});assert.equal(await page.locator('#model').isEnabled(),true);
 const choices=await page.locator('#model option').evaluateAll(nodes=>nodes.map(n=>({id:n.value,label:n.textContent})));
 const selected=choices.find(m=>m.id.includes('haiku-4-5'));assert.ok(selected,'Haiku starter model available');report.modelId=selected.id;report.modelChoices=choices.length;
 await page.locator('#model').selectOption(selected.id);await page.locator('#pname').fill('Customer Care Assistant');
 await page.locator('#persona').fill('You are a helpful customer care assistant. Be concise. Ask for an order reference before discussing an order. Never invent customer records.');
 await page.getByText('Model parameters and template settings',{exact:true}).click();await page.locator('#mp-temp').fill('0.3');await page.getByText('Model parameters and template settings',{exact:true}).click();assert.doesNotMatch(await page.locator('label[for=model]').innerText(),/registry/i);await shot('02-configure');
 const configured=page.waitForResponse(r=>/\/api\/agents\/[^/]+$/.test(new URL(r.url()).pathname)&&r.request().method()==='PUT',{timeout:120000});
 await page.locator('#gen').click();const response=await configured;assert.equal(response.status(),200);report.agentId=(await response.json()).agent.id;
 await page.locator('#eval-dataset').waitFor({timeout:120000});assert.equal(await page.locator('#val').count(),0);await shot('03-review-construct');
 await page.locator('#ghrepo').fill(id);await page.locator('#exp').click();await page.locator('[data-delivery-download]').waitFor({timeout:120000});await shot('04-repository-preview');
 const downloadEvent=page.waitForEvent('download',{timeout:90000});await page.locator('[data-delivery-download]').click();const download=await downloadEvent;await download.saveAs(out+'/generated-project.zip');report.download=download.suggestedFilename();await shot('05-repository-downloaded');
 }
 if(!process.env.BUILD_ONLY){
 const id=report.projectId;
 await page.locator('[data-shellnav="governance"]').click();await page.getByRole('tab',{name:'Guardrails',exact:true}).click();await page.locator('[data-guardrail-refresh]').waitFor({timeout:90000});
 const guardText=await page.locator('#guardrailsettings').innerText();assert.match(guardText,/PII Detection/);assert.doesNotMatch(guardText,/Blueprint details/);await shot('06-guardrails');
 await page.getByRole('tab',{name:'Approval requests',exact:true}).click();await page.locator('[data-queue-section="exception-requests"]').click();await page.locator('[data-exception-new]').waitFor({timeout:90000});await page.locator('[data-exception-new]').click();
 await page.locator('#exception-project').waitFor();await page.locator('#exception-project').selectOption(report.domainId+'/'+id);await page.locator('#exception-reason').fill('Evaluate a temporary optional control setting in this synthetic workspace.');await page.locator('#exception-compensation').fill('Limit testing to synthetic inputs, retain logs and require independent review.');
 await page.locator('#exception-expiry').fill(new Date(Date.now()+86400000).toISOString().slice(0,16));await shot('07-exception-request');
 const exceptionResponse=page.waitForResponse(r=>r.url().endsWith('/api/policy-exemption-request')&&r.request().method()==='POST');await page.locator('[data-exception-form] [type=submit]').click();const er=await exceptionResponse;const eb=await er.json();assert.equal(er.status(),200,JSON.stringify(eb));report.exceptionId=eb.exception?.id;assert.ok(report.exceptionId,JSON.stringify(eb));
 await page.locator('[data-queue-section="exception-requests"]').click();await page.locator('[data-exception-open="'+report.exceptionId+'"]').click();assert.equal(await page.locator('[data-exception-decision]').count(),0);await shot('08-exception-pending');
 const self=await api(page,'/policy-exemption-decide',{domainId:report.domainId,id:report.exceptionId,decision:'approve',reason:'Synthetic self-approval must be denied.'});assert.equal(self.status,403);report.selfApprovalDenied=true;
 const other=await login(reviewer,true);
 await other.locator('[data-shellnav="governance"]').click();await other.getByRole('tab',{name:'Approval requests',exact:true}).click();await other.locator('[data-queue-section="exception-requests"]').click();await other.locator('[data-exception-open="'+report.exceptionId+'"]').click({timeout:90000});
 await other.locator('#exception-decision-reason').fill('Independent review of the synthetic testing scope and compensating controls.');await other.locator('#exception-decision-reason').scrollIntoViewIfNeeded();await other.screenshot({path:out+'/reviewer-exception-form.png'});report.checks.push({name:'reviewer-exception-form',at:new Date().toISOString()});await other.waitForTimeout(4500);
 const deciding=other.waitForResponse(r=>r.url().endsWith('/api/policy-exemption-decide')&&r.request().method()==='POST');await other.locator('[data-exception-decision="approve"]').click();const dr=await deciding;const db=await dr.json();assert.equal(dr.status(),200,JSON.stringify(db));report.exceptionDecision=db;
 await other.screenshot({path:out+'/reviewer-exception.png',fullPage:true});report.checks.push({name:'reviewer-exception-approved',at:new Date().toISOString()});await other.waitForTimeout(3500);
 await page.reload();await page.locator('[data-shellnav="governance"]').click({timeout:90000});await page.getByRole('tab',{name:'Approval requests',exact:true}).click();await page.locator('[data-queue-section="exception-requests"]').click();await page.locator('[data-exception-open="'+report.exceptionId+'"]').click({timeout:90000});await shot('09-independent-review');
 const revoke=await api(other,'/policy-exemption-decide',{domainId:report.domainId,id:report.exceptionId,decision:'revoke',reason:'Synthetic acceptance completed; remove temporary exception approval.'});assert.equal(revoke.status,200,JSON.stringify(revoke.body));report.exceptionRevoked=true;
 const blueprintId='validation-blueprint-'+Date.now();
 await page.locator('[data-shellnav="blueprints"]').click();await page.locator('#bsid').fill(blueprintId);await page.locator('#bsname').fill('Customer care review template');await page.locator('#bsusecase').fill('Synthetic blueprint publication acceptance; no runtime provisioned.');
 await page.locator('#bsfw').selectOption('Strands');await page.locator('#bsdt').selectOption('AgentCore Runtime');await page.locator('#bsproto').selectOption('HTTP');await page.locator('#bsmem').selectOption('shortTerm');assert.equal(await page.locator('#bsjson').inputValue(),'');await page.locator('#bssubmit').scrollIntoViewIfNeeded();await shot('11a-blueprint-form');
 let sb;
 for(let attempt=0;attempt<3;attempt++){
  const observed=[];const capture=r=>{if(r.request().method()==='POST'&&/\/api\/governance\/(resources|publications)$/.test(r.url()))observed.push(r.json().then(body=>({path:new URL(r.url()).pathname,status:r.status(),body})));};page.on('response',capture);
  try{
   await page.locator('#bssubmit').click();await page.waitForFunction(()=>!document.querySelector('#bssubmit')?.disabled&&document.querySelector('#bsmsg')?.textContent.trim(),{},{timeout:120000});
   const responses=await Promise.all(observed);report.blueprintAttempts??=[];report.blueprintAttempts.push(responses.map(r=>({path:r.path,status:r.status,code:r.body.code})));
   const submitted=responses.find(r=>r.path.endsWith('/publications')&&r.status===201);
   if(submitted){sb=submitted.body;break;}
   const last=responses.at(-1);assert.ok(last?.body?.retryable===true&&attempt<2,'Blueprint submission failed: '+await page.locator('#bsmsg').innerText());await page.waitForTimeout(3000);
  }finally{page.off('response',capture);}
 }
 assert.ok(sb?.approval?.id);report.blueprintApprovalId=sb.approval.id;await shot('11-blueprint-submitted');
 const selfBlueprint=await api(page,'/governance/publication-decisions',{approvalId:report.blueprintApprovalId,decision:'APPROVE',reason:'Synthetic self-review must be denied.'});assert.equal(selfBlueprint.status,403);
 await other.reload();await other.locator('[data-shellnav="governance"]').click({timeout:90000});await other.getByRole('tab',{name:'Approval requests',exact:true}).click();
 await other.locator('[data-queue-section="blueprint-requests"]').click();const queue=other.locator('#bpsublist');await queue.locator('article').filter({has:other.locator('[data-approval="'+report.blueprintApprovalId+'"]')}).locator('.approval-review>summary').click();await queue.locator('[data-reason-for="'+report.blueprintApprovalId+'"]').fill('Independent review confirms this synthetic template declares its intended controls.');await queue.locator('[data-reason-for="'+report.blueprintApprovalId+'"]').scrollIntoViewIfNeeded();await other.screenshot({path:out+'/reviewer-blueprint-form.png'});report.checks.push({name:'reviewer-blueprint-form',at:new Date().toISOString()});await other.waitForTimeout(4500);
 const reviewing=other.waitForResponse(r=>r.url().endsWith('/api/governance/publication-decisions')&&r.request().method()==='POST',{timeout:120000});await queue.locator('[data-approval="'+report.blueprintApprovalId+'"][data-decision="APPROVE"]').click();const br=await reviewing;const bb=await br.json();assert.equal(br.status(),200,JSON.stringify(bb));report.blueprintDecision=bb.approval?.status||bb.record?.status;await other.screenshot({path:out+'/12-blueprint-approved.png',fullPage:true});await other.screenshot({path:out+'/12-blueprint-approved-viewport.png'});report.checks.push({name:'reviewer-blueprint-approved',at:new Date().toISOString()});await other.waitForTimeout(3500);
 await page.reload();await page.locator('[data-shellnav="blueprints"]').click({timeout:90000});const published=page.locator('[data-bpdetail="'+blueprintId+'"]');await published.waitFor({timeout:90000});const card=published.locator('..');assert.match(await card.innerText(),/Strands/);assert.match(await card.innerText(),/AgentCore Runtime/);assert.doesNotMatch(await card.innerText(),/Not specified/);await published.locator('summary').click();await card.scrollIntoViewIfNeeded();await shot('13-published-template');report.publishedTemplateVisible=true;
 await page.locator('[data-shellnav="governance"]').click();
 await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'Guardrails',exact:true}).click();await page.locator('[data-guardrail-refresh]').waitFor();await shot('10-mobile-guardrails');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal document overflow');}
 assert.deepEqual(report.browserErrors,[]);report.scope=process.env.BUILD_ONLY?'builder':process.env.RESUME_REPORT?'governance':'builder-and-governance';report.passed=true;
}catch(e){report.passed=false;report.error=e.stack;console.error(e.message);if(page)await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{for(const c of contexts)await c.close();await browser.close();report.finishedAt=new Date().toISOString();await writeFile(out+'/report.json',JSON.stringify(report,null,2));}
