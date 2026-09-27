// Real hosted acceptance: normal Cognito UI login, no session/token injection.
// Requires a temporary Domain Lead; cleanup is performed by the owning runner.
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const evidence=process.env.PROJECT_SELECTION_EVIDENCE||'/private/tmp/project-selection-evidence';
const identity=JSON.parse(await readFile(process.env.PROJECT_SELECTION_IDENTITY_FILE||`${evidence}/verifier-private.json`,'utf8'));
const base=process.env.PROJECT_SELECTION_URL||'https://d2s9ypdbjcdxm7.cloudfront.net';
const projectId=process.env.PROJECT_SELECTION_ID||'selection-verification-'+Date.now();
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
const resume=process.env.PROJECT_SELECTION_RESUME==='1';
const report=resume?JSON.parse(await readFile(`${evidence}/hosted-created-result.json`,'utf8')):{projectId,domainId:'customer_support',browserErrors:[],projectWrites:0};
if(resume){assert.equal(report.projectId,projectId);assert.equal(report.createStatus,201);delete report.error;report.resumedReadVerification=true;}
page.on('pageerror',e=>report.browserErrors.push(e.message));
page.on('request',r=>{if(new URL(r.url()).pathname==='/api/projects'&&r.method()==='POST')report.projectWrites++;});
try{
 await page.goto(base);await page.locator('#cognitosignin').click({timeout:60000});
 await page.locator('input[name="username"]:visible').first().fill(identity.username);
 await page.locator('input[name="password"]:visible').first().fill(identity.password);
 await page.locator('input[name="signInSubmitButton"]:visible,button[type="submit"]:visible').first().click();
 await page.locator('#tbprofile').waitFor({timeout:60000});
 await page.locator('[data-shellnav="projects"]').click();
 if(!resume){
 await page.locator('#hostedcollection [data-project-open]').first().waitFor({timeout:60000});
 await page.locator('#dcprojgo').click();await page.locator('[data-wtpl="blank"]').click({timeout:60000});
 await page.locator('#wnext').click();await page.locator('#wid').fill(projectId);await page.locator('#wname').fill('Project selection verification');
 await page.locator('#wdesc').fill('Temporary verification; removed after testing.');await page.locator('#wnext').click();
 const controls=page.locator('[data-project-resource]');report.options=await controls.count();assert.ok(report.options>2);
 for(let i=0;i<report.options;i++)assert.equal(await controls.nth(i).isDisabled(),false,'Legacy domain options must be selectable');
 await page.locator('[data-project-clear-all]').click();
 await page.getByRole('group',{name:'Project blueprints',exact:true}).getByLabel('Chat Assistant',{exact:true}).check();
 await page.getByRole('group',{name:'Project models',exact:true}).getByLabel('Claude Haiku 4.5',{exact:true}).check();
 assert.equal(await page.locator('[data-project-resource]:checked').count(),2);
 await page.screenshot({path:`${evidence}/hosted-selection.png`,fullPage:true});
 for(let i=0;i<3;i++)await page.locator('#wnext').click();
 await page.locator('#wizreview').waitFor();await page.screenshot({path:`${evidence}/hosted-review.png`,fullPage:true});
 const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/projects'&&r.request().method()==='POST',{timeout:90000});
 await page.locator('#wcreate').click();const response=await responsePromise;report.createStatus=response.status();
 const result=await response.json();report.project=result.project;report.errorCode=result.code;
 assert.equal(response.status(),201,JSON.stringify({code:result.code,message:result.message}));
 assert.equal(result.project.domainId,'customer_support');assert.equal(result.project.resourcePolicy.resources.length,2);
 }
 await page.reload();await page.locator('[data-shellnav="projects"]').click({timeout:60000});
 await page.locator(`[data-project-open="${projectId}"]`).waitFor({timeout:60000});
 await page.locator('[data-shellnav="bwbuild"]').click();
 await page.locator('#buildproject').selectOption(projectId,{timeout:60000});
 await page.locator('[data-door="blueprint"]').click();
 await page.locator('[data-bp="chat-assistant"]').waitFor({timeout:60000});
 report.builderBlueprints=await page.locator('[data-bp]').evaluateAll(nodes=>nodes.map(n=>n.dataset.bp));
 assert.deepEqual(report.builderBlueprints,['chat-assistant']);
 await page.locator('[data-bp="chat-assistant"]').click();await page.locator('#n1').click();
 await page.locator('#model').waitFor({timeout:60000});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('#model option')).some(n=>n.value),{},{timeout:60000});
 report.builderModels=await page.locator('#model option').evaluateAll(nodes=>nodes.filter(n=>n.value).map(n=>n.textContent.trim()));
 assert.deepEqual(report.builderModels,['Claude Haiku 4.5']);
 await page.screenshot({path:`${evidence}/hosted-builder-subset.png`,fullPage:true});
 assert.equal(report.projectWrites,1);assert.deepEqual(report.browserErrors,[]);report.passed=true;
}catch(error){report.error=error.message;await page.screenshot({path:`${evidence}/hosted-failure.png`,fullPage:true});process.exitCode=1;}
finally{await writeFile(`${evidence}/hosted-result.json`,JSON.stringify(report,null,2));await browser.close();console.log(JSON.stringify({passed:report.passed||false,error:report.error,createStatus:report.createStatus,projectId}));}
