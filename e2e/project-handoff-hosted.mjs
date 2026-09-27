// Verify Builder access as an assigned member whose subject differs from the creator.
// The operator fixture needs demo-operator, domain membership and project membership.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const base=process.env.DOMAIN_BOOTSTRAP_APP_URL?.replace(/\/$/,'');
const domainId=process.env.DOMAIN_BOOTSTRAP_DOMAIN_ID;
const evidence=process.env.DOMAIN_BOOTSTRAP_EVIDENCE_DIR;
const identity=JSON.parse(await readFile(process.env.DOMAIN_BOOTSTRAP_OPERATOR_FILE,'utf8'));
assert.ok(base?.startsWith('https://')&&domainId&&evidence&&identity.tokens);
await mkdir(evidence,{recursive:true});
const subject=JSON.parse(Buffer.from(identity.tokens.accessToken.split('.')[1],'base64url')).sub;
const browser=await chromium.launch({headless:true});
let page;
try{
 const context=await browser.newContext({viewport:{width:1440,height:1100}});
 await context.addInitScript(({tokens,domain})=>{
  sessionStorage.setItem('console.cognito.tokens',JSON.stringify(tokens));
  sessionStorage.setItem('console.demo-context',JSON.stringify({role:'builder',domain}));
 },{tokens:identity.tokens,domain:domainId});
 const headers={authorization:`Bearer ${identity.tokens.accessToken}`,'x-demo-role':'builder','x-active-domain':domainId};
 const response=await context.request.get(`${base}/api/projects?limit=50`,{headers});assert.equal(response.status(),200);
 const projects=(await response.json()).items.filter(p=>p.domainId===domainId&&['scope-validation-a','scope-validation-b'].includes(p.id));
 assert.equal(projects.length,2);
 assert.ok(projects.every(p=>p.ownerSubject!==subject&&p.memberSubjects.includes(subject)),'Exercise the assigned-member path, not creator ownership.');
 page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.locator('[data-workspace-pick="scope-validation-a"], .projcard[data-project="scope-validation-a"]').waitFor({timeout:60_000});
 await page.screenshot({path:`${evidence}/builder-assigned-projects.png`,fullPage:true});
 await page.locator('[data-workspace-pick="scope-validation-a"], .projcard[data-project="scope-validation-a"]').click();
 await page.locator('#wscontext').waitFor({timeout:60_000});
 await page.locator('[data-shellnav="build"]').click();
 await page.locator('[data-door="blueprint"]').click({timeout:60_000});
 await page.locator('#buildproject').selectOption('scope-validation-a',{timeout:60_000});
 await page.locator('[data-bp="chat-assistant"]').click({timeout:60_000});
 await page.locator('#n1').click();
 await page.locator('#model').waitFor({timeout:60_000});
 assert.deepEqual(await page.locator('#model option').evaluateAll(items=>items.map(item=>item.value)),['bedrock-mantle/anthropic.claude-haiku-4-5']);
 await page.screenshot({path:`${evidence}/builder-assigned-model.png`,fullPage:true});
 assert.deepEqual(errors,[]);
 await writeFile(`${evidence}/builder-handoff-result.json`,JSON.stringify({passed:true,domainId,projects:projects.map(p=>p.id),verifiedAsNonOwner:true,browserErrors:errors},null,2));
 console.log('Assigned non-owner Builder can see both projects, enter the workspace and select its allowed model.');
}catch(error){
 if(page){await page.screenshot({path:`${evidence}/builder-handoff-error.png`,fullPage:true});await writeFile(`${evidence}/builder-handoff-error.txt`,await page.locator('body').innerText());}
 throw error;
}finally{await browser.close();}
