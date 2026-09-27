// Read scope and exercise denied creation against an already-existing project ID.
// No project fixture is created by this acceptance test.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const base=process.env.BASE_URL,out=process.env.EVIDENCE_DIR;
assert.ok(base?.startsWith('https://')&&out&&process.env.LOGIN_FILE);
const [user]=JSON.parse(await readFile(process.env.LOGIN_FILE,'utf8'));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1600,height:1000}});
page.on('dialog',d=>d.accept());
const report={at:new Date().toISOString(),errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
try{
 await page.goto(base);await page.locator('#cognitosignin').click();await page.locator('input[name=username]:visible').fill(user.username);await page.locator('input[name=password]:visible').fill(user.password);await page.locator('input[name=signInSubmitButton]:visible,button[type=submit]:visible').first().click();await page.waitForURL(base+'/**',{timeout:90000});await page.locator('[data-shellnav]').first().waitFor({timeout:90000});
 const api=(path,body,headers={})=>page.evaluate(async({path,body,headers,id})=>{const {accessToken}=JSON.parse(sessionStorage.getItem('console.cognito.tokens'));const r=await fetch('/api'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+accessToken,...headers,...(body?{'content-type':'application/json','x-request-id':id}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};},{path,body,headers,id:randomUUID()});
 const projects=await api('/projects?limit=50');assert.equal(projects.status,200);const existing=projects.body.items.find(p=>p.domainId==='platform'&&p.id===process.env.TEST_PROJECT_ID);assert.ok(existing,'Use an existing platform project');
 const builderHeaders={'x-demo-role':'builder','x-active-domain':'customer_support'};
 const me=await api('/me',undefined,builderHeaders);assert.equal(me.status,200,me.body.code);assert.ok(!JSON.stringify(me.body.capabilities||me.body.profile?.capabilities||[]).includes('createDomainProject'));
 const denied=await api('/projects',{id:'support',name:'Customer Support',description:''},builderHeaders);assert.equal(denied.status,403);assert.equal(denied.body.code,'FORBIDDEN');report.builderProjectCreateStatus=denied.status;
 await page.locator('[data-shellnav="bwbuild"]').click();await page.locator('[data-door="plato"]').click({timeout:60000});await page.locator('#buildproject').selectOption('');await page.locator('#pgen').click();await page.getByText('Choose an existing project workspace before generating the specification.').waitFor();report.specRequiresProject=true;
 await page.locator('#buildproject').selectOption(existing.id);report.specProjectOptions=await page.locator('#buildproject option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean));assert.equal(report.specProjectOptions.length,projects.body.items.filter(p=>p.domainId==='platform').length);await page.screenshot({path:out+'/spec-project-scope.png',fullPage:true});
 const after=await api('/projects?limit=50');assert.deepEqual(after.body.items,projects.body.items);report.projectsUnchanged=true;assert.deepEqual(report.errors,[]);
}finally{await browser.close();await writeFile(out+'/report.json',JSON.stringify(report,null,2));}
