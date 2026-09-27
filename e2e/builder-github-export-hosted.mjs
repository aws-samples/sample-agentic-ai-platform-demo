// Actual hosted Compose from Catalog acceptance. Uses temporary operator-created
// credentials; stores only synthetic inputs and response metadata, never tokens.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const base=process.env.BASE_URL,out=process.env.EVIDENCE_DIR,domainId=process.env.TEST_DOMAIN||'platform';
const restricted=false;
assert.ok(process.env.TEST_REPOSITORY_NAME&&process.env.TEST_GITHUB_OWNER,'Explicit private GitHub destination required');
assert.ok(base?.startsWith('https://')&&out&&process.env.LOGIN_FILE);
const [user]=JSON.parse(await readFile(process.env.LOGIN_FILE,'utf8'));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
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
 await page.locator('input[name=username]:visible').fill(user.username);await page.locator('input[name=password]:visible').fill(user.password);
 await page.locator('input[name=signInSubmitButton]:visible,button[type=submit]:visible').first().click();await page.waitForURL(base+'/**',{timeout:90000});await page.locator('[data-shellnav]').first().waitFor({timeout:90000});
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
 await writeFile(out+'/reviewed-manifest.json',JSON.stringify(deferred,null,2));
 assert.equal(await page.locator('#ghrepo').inputValue(),process.env.TEST_REPOSITORY_NAME,'Repository defaults to the Agent build name');
 const {execFileSync}=await import('node:child_process');
 const token=execFileSync('gh',['auth','token'],{encoding:'utf8'}).trim();
 await page.locator('[data-delivery-token]').fill(token);
 await page.locator('[data-delivery-confirmation]').fill(process.env.TEST_REPOSITORY_NAME);
 await page.locator('[data-delivery-private-ack]').check();
 const exported=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/delivery/github/authorizations'&&r.request().method()==='POST',{timeout:120000});
 await page.locator('[data-delivery-approve]').click();
 const response=await exported;const payload=await response.json();
 assert.equal(response.status(),201,payload.code||'Export failed');
 assert.ok(!JSON.stringify(payload).includes(token),'Credential must never be returned');
 const delivery=payload.authorization?.delivery;assert.equal(delivery?.status,'COMPLETED');
 report.repositoryUrl=delivery.checkpoints.find(c=>c.status==='REPOSITORY_CREATED').github.htmlUrl;
 report.commit=delivery.checkpoints.find(c=>c.status==='INITIAL_SOURCE_COMMITTED').github.commitSha;
 const {createGitHubClient}=await import('../infra/serverless-platform/lambda/journeys/github.mjs');
 const {createHash}=await import('node:crypto');
 const github=createGitHubClient({owner:process.env.TEST_GITHUB_OWNER,token,fetch});
 const repository=await github.getRepository({name:process.env.TEST_REPOSITORY_NAME});assert.equal(repository.private,true);
 const main=await github.getBranch({repository:repository.name,branch:'main'});assert.equal(main.sha,report.commit);
 const commit=await github.getCommit({repository:repository.name,sha:main.sha});
 const tree=await github.getCommitTree({repository:repository.name,treeSha:commit.treeSha});
 for(const file of deferred.entries){const bytes=Buffer.from(file.content);const hash=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');assert.equal(tree.find(f=>f.path===file.path)?.sha,hash,file.path);}
 assert.equal(tree.length,deferred.entries.length);report.verifiedFiles=tree.length;
 await page.getByRole('link',{name:'Open repository',exact:true}).waitFor();
 await page.locator('#expprev summary').filter({hasText:`Browse ${deferred.entries.length} repository files`}).waitFor();
 assert.doesNotMatch(await page.locator('#evalprev').innerText(),/^0 CI/);
 assert.ok((await page.locator('[data-delivery-card]').innerText()).includes('git clone -- '+report.repositoryUrl+'.git'));
 await page.screenshot({path:out+'/github-export-complete.png',fullPage:true});
 report.projectCreates=report.projectCreates||0;assert.equal(report.projectCreates,0);report.modelTests=report.requests.filter(r=>r.path.endsWith('/test')).length;assert.equal(report.modelTests,0);assert.deepEqual(report.errors,[]);report.finishedAt=new Date().toISOString();
}finally{await context.close();await browser.close();await writeFile(out+'/report.json',JSON.stringify(report,null,2));}
