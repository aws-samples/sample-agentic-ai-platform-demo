// Read-only hosted acceptance. LOGIN_FILE is a private JSON {username,password}.
// No approvals, policies, users or Registry records are mutated by this script.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const base=process.env.BASE_URL;
const out=process.env.EVIDENCE_DIR;
assert.ok(base?.startsWith('https://')&&out&&process.env.LOGIN_FILE,'Set BASE_URL, EVIDENCE_DIR and LOGIN_FILE');
const login=JSON.parse(await readFile(process.env.LOGIN_FILE,'utf8'));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
const errors=[],registryResponses=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(new URL(r.url()).pathname==='/api/registry')registryResponses.push(r.status())});
const report={url:base};
async function api(path,extra={}){
 return page.evaluate(async({path,extra})=>{
  const tokens=JSON.parse(sessionStorage.getItem('console.cognito.tokens'));
  const r=await fetch(path,{headers:{Authorization:'Bearer '+tokens.accessToken,...extra}});
  return {status:r.status,body:await r.json()};
 },{path,extra});
}
async function screenshot(name){await page.screenshot({path:out+'/'+name+'.png',fullPage:true})}
async function auditReady(){
 await page.waitForFunction(()=>!!document.querySelector('#gcompliance [data-pending-count]'),{},{timeout:90000});
}
try{
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.locator('#cognitosignin').click({timeout:60000});
 await page.locator('input[name="username"]:visible').fill(login.username);
 await page.locator('input[name="password"]:visible').fill(login.password);
 await page.locator('input[name="signInSubmitButton"]:visible,button[type="submit"]:visible').first().click();
 await page.waitForURL(base+'/**',{timeout:60000});
 await page.locator('[data-shellnav="governance"]').click({timeout:60000});
 const models=await api('/api/ai-gateway');
 assert.equal(models.status,200);assert.equal(models.body.ok,true);assert.ok(models.body.models.length>0);
 report.modelCount=models.body.models.length;
 await page.getByRole('tab',{name:'Policies',exact:true}).click();
 await page.locator('[data-policy-gateway]').first().waitFor({timeout:60000});
 const native=await api('/api/governance/runtime-policies');
 assert.equal(native.status,200);assert.equal(native.body.complete,true);
 assert.equal(await page.locator('[data-policy-gateway]').count(),native.body.gateways.length);
 for(const g of native.body.gateways){
  const text=await page.locator(`[data-policy-gateway="${g.id}"]`).innerText();
  assert.ok(text.includes(g.id));
  assert.ok(text.includes(g.binding==='NOT_ATTACHED'?'No Policy Engine attached':g.mode));
 }
 assert.equal(await page.locator('.policy-drafts').getAttribute('open'),null);
 assert.equal(await page.locator('.policy-layers .card').count(),3);
 report.gatewayBindings=native.body.gateways.map(g=>({id:g.id,binding:g.binding,mode:g.mode,complete:g.complete}));
 await screenshot('policies-after');
 await page.locator('.policy-drafts>summary').click();
 await page.locator('[data-hp-refresh]').waitFor({timeout:60000});
 assert.match(await page.locator('#hitlpolicies').innerText(),/drafts are not Gateway policies/);
 await screenshot('approval-drafts-after');
 await page.locator('[data-policy-nav="governance"][data-policy-tab="guardrails"]').click();
 await page.locator('#govtab-guardrails[aria-selected="true"]').waitFor({timeout:60000});
 await page.locator("#guardrailsettings tbody tr").first().waitFor({timeout:60000});
 const controls=await api("/api/governance/guardrails");assert.equal(controls.status,200);
 assert.equal(await page.locator("#guardrailsettings tbody tr").count(),controls.body.controls.length);
 report.mainGuardrailsPreserved=true;await screenshot("guardrails-after");
 await page.getByRole('tab',{name:'Audit',exact:true}).click();await auditReady();
 const initialText=await page.locator('#gcompliance').innerText();
 await writeFile(out+'/compliance-after.txt',initialText);
 assert.doesNotMatch(initialText,/Registry pending work is unavailable|Pending total unknown/);
 const approvals=[];let cursor=null;const cursors=new Set();
 do{
  const r=await api('/api/approvals?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.ok(Array.isArray(r.body.items));
  approvals.push(...r.body.items);cursor=r.body.cursor;
  assert.ok(cursor===null||typeof cursor==='string');
  if(cursor){assert.ok(!cursors.has(cursor));cursors.add(cursor);assert.ok(cursors.size<20)}
 }while(cursor);
 const expected=approvals.filter(a=>a.status==='PENDING').map(a=>a.id).sort();
 const rows=()=>page.locator('[data-compliance-request]').evaluateAll(nodes=>nodes.map(n=>n.dataset.complianceRequest).sort());
 assert.deepEqual(await rows(),expected);
 assert.equal(await page.locator('#gcompliance [data-pending-count]').getAttribute('data-pending-count'),String(expected.length));
 assert.ok(await page.locator('[data-comp]').count()>0);
 report.pendingApprovals=expected.length;report.completeRegistry=true;
 await screenshot('compliance-after');
 report.normalRegistryResponses=registryResponses.slice();
 assert.ok(report.normalRegistryResponses.every(status=>status===200));
 // Simulate source failure only in this browser; readable approval details survive.
 const intercept=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,code:'CONTROL_PLANE_UNAVAILABLE'})});
 await page.route('**/api/registry',intercept);
 await page.locator('#gcomprefresh').click();
 await page.waitForFunction(()=>document.querySelector('#gcompliance [data-pending-count]')?.dataset.pendingCount==='unknown',{},{timeout:90000});
 assert.deepEqual(await rows(),expected);
 await screenshot('compliance-partial-source');
 report.partialSourceRetainsDetails=true;report.faultInjectionWasBrowserOnly=true;
 await page.unroute('**/api/registry',intercept);
 await page.locator('#gcomprefresh').click();
 await page.waitForFunction(()=>{const n=document.querySelector('#gcompliance [data-pending-count]')?.dataset.pendingCount;return n&&n!=='unknown'},{},{timeout:90000});
 assert.deepEqual(await rows(),expected);report.refreshRecovered=true;
 const rejected=await api('/api/governance/runtime-policies?gateway=foreign');assert.equal(rejected.status,400);
 const builder=await api('/api/governance/runtime-policies',{'x-demo-role':'builder','x-active-domain':'platform'});assert.equal(builder.status,403);
 report.rejectedQuery=400;report.rejectedBuilder=403;
 report.registryResponses=registryResponses;report.browserErrors=errors;assert.deepEqual(errors,[]);
 report.passed=true;await writeFile(out+'/governance-result.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}catch(error){await screenshot('governance-error');await writeFile(out+'/governance-error.txt',await page.locator('body').innerText());throw error}
finally{await browser.close()}
