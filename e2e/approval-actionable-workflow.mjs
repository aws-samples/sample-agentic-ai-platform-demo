// Local Chromium, actual app and handler/service/workspace adapters; synthetic SDK IO only.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fixture, signIn, navigate, poll, profile, errors, unexpected } from './approved-ui-integration.mjs';
import { workflowFixture, REGISTRY, RECORD } from '../infra/serverless-platform/test/support/approval-workflow-fixture.mjs';
import { recordsToEntries } from '../console/registry-shape.mjs';
const decision=process.argv[3]||'APPROVE';assert.ok(['APPROVE','REJECT'].includes(decision));
const expectedStatus=decision==='APPROVE'?'APPROVED':'REJECTED';
const out=path.resolve(process.argv[2]); await mkdir(out,{recursive:true});
const width=Number(process.env.APPROVAL_VIEWPORT_WIDTH||1440);assert.ok([390,1440].includes(width));
const result={boundary:'Local Chromium, synthetic SDK data, actual application/router/service/persistence adapter. No cloud writes.',width,sourceHashes:{},metrics:[],checks:[],errors:[]};
for(const name of ['modules/app.mjs','pending-work.mjs','publication-submission.mjs'])result.sourceHashes[name]=createHash('sha256').update(await readFile(path.resolve('console/public',name))).digest('hex');
const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
let backend=workflowFixture();
await backend.draft({actor:'synthetic-operator',role:'lead'});
backend.records.get(`${REGISTRY}/${RECORD}`).status='PENDING_APPROVAL';
async function session(actor, role='lead') {
 const f=await fixture(role,{viewport:{width,height:1000}},browser,path.resolve('console/public'));f.state.canSwitch=false;
 await f.context.route('https://console.test/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),resource=url.pathname.slice(5);
  const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(resource==='me')return json({...profile(role,'domain_a',false),user:actor,name:actor});
  if(resource==='registry')return json({ok:true,source:'aws',entries:recordsToEntries([...backend.records.values()].map(r=>({...r,registryId:REGISTRY})),()=> 'domain_a')});
  if(resource==='approvals'){const page=await backend.state.listApprovals({domainId:'domain_a',limit:50});return json({ok:true,resource:'approvals',items:page.items,cursor:null});}
  if(resource.startsWith('governance/publication')){
   const response=await backend.call(url.pathname+url.search,{actor,role,domain:'domain_a',...(req.method()==='POST'?{body:req.postDataJSON()}:{}),requestId:req.headers()['x-request-id']||'synthetic-read'});
   const status=typeof response.status==='number'?response.status:200;return json(response,status);
  }
  return route.fallback();
 });
 await signIn(f);if(role==='builder'){await navigate(f.page,'registry');return f;}await navigate(f.page,'governance');await poll(async()=>await f.page.locator('#govqueue [data-pending-count]').count()===1,'queue loaded');return f;
}
async function shot(f,name){const metrics=await f.page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));result.metrics.push({name,...metrics});assert.ok(metrics.documentWidth<=metrics.width,JSON.stringify({name,...metrics}));await f.page.screenshot({path:path.join(out,name+'.png'),fullPage:true});await writeFile(path.join(out,name+'.txt'),await f.page.locator('#govqueue').innerText());}
try {
 const outsider=await session('synthetic-reviewer');
 await outsider.page.getByText('Resource details',{exact:true}).click();
 await outsider.page.getByRole('button',{name:'Check submission eligibility',exact:true}).click();
 await poll(async()=>/Only the resource owner/.test(await outsider.page.locator('#govqueue').innerText()),'non-owner blocked');
 assert.equal(await outsider.page.getByRole('button',{name:'Submit for review',exact:true}).count(),0);
 await shot(outsider,'non-owner-blocked');await outsider.context.close();
 result.checks.push('Non-owner clicks eligibility: owner-required result, no submit action');
 const raw=backend.records.get(`${REGISTRY}/${RECORD}`),saved=structuredClone(raw);
 raw.recordVersion='1.0.0';raw.descriptors.mcpServer={data:JSON.stringify({name:'synthetic-mcp',description:'Synthetic unmanaged MCP',version:'1.0.0'}),dataSchemaVersion:'2025-12-11'};
 const unmanaged=await session('synthetic-operator');
 await unmanaged.page.getByText('Resource details',{exact:true}).click();
 await unmanaged.page.getByRole('button',{name:'Check submission eligibility',exact:true}).click();
 await poll(async()=>/verified governance ownership/.test(await unmanaged.page.locator('#govqueue').innerText()),'unmanaged blocked');
 assert.equal(await unmanaged.page.getByRole('button',{name:'Submit for review',exact:true}).count(),0);
 await shot(unmanaged,'unmanaged-blocked');await unmanaged.context.close();
 backend.records.set(`${REGISTRY}/${RECORD}`,saved);
 result.checks.push('Unmanaged native resource stays visible; eligibility blocked, no fabricated submit action or request');
 const owner=await session('synthetic-operator');
 await shot(owner,'before-submission');
 assert.match(await owner.page.locator('#govqueue').innerText(),/Resource review status \(1\)/);
 assert.equal(await owner.page.locator('#govqueue [data-pending-count]').getAttribute('data-pending-count'),'0');
 await owner.page.getByText('Resource details',{exact:true}).click();
 await owner.page.getByRole('button',{name:'Check submission eligibility',exact:true}).click();
 await owner.page.getByRole('button',{name:'Submit for review',exact:true}).waitFor();
 await shot(owner,'owner-eligible');
 await owner.page.getByRole('button',{name:'Submit for review',exact:true}).click();
 await poll(async()=>await owner.page.locator('#govqueue .approval-details').count()===1,'request created');
 await owner.page.getByText('Request details',{exact:true}).click();
 assert.equal(await owner.page.locator('.hostedapproval').count(),0);
 assert.match(await owner.page.locator('#govqueue').innerText(),/synthetic-operator/);
 await shot(owner,'owner-submitted');result.checks.push('Owner clicks eligibility and submit; formal request persisted; requester sees details but cannot self-approve');
 // Every visible domain Governance tab is actually clicked.
 for(const id of ['requests','queue']){await owner.page.locator(`[data-tab="${id}"]`).click();assert.equal(await owner.page.locator(`[data-tab="${id}"]`).getAttribute('aria-selected'),'true');}
 result.checks.push('Domain Governance tabs Requests and Approval queue clicked');
 await owner.context.close();
 const reviewer=await session('synthetic-reviewer');
 await reviewer.page.getByText('Request details',{exact:true}).click();
 assert.match(await reviewer.page.locator('#govqueue').innerText(),/Applicant[\s\S]*synthetic-operator[\s\S]*Domain lead/);
 await reviewer.page.locator('.approval-reason').fill('Synthetic evidence reviewed and accepted');
 await shot(reviewer,'reviewer-details');
 await reviewer.page.getByRole('button',{name:decision==='APPROVE'?'Approve':'Reject',exact:true}).click();
 await poll(async()=> (await backend.state.listApprovals({domainId:'domain_a'})).items[0]?.status===expectedStatus,'approval persisted');
 assert.equal(backend.records.get(`${REGISTRY}/${RECORD}`).status,expectedStatus);
 await poll(async()=>await reviewer.page.locator('.hostedapproval').count()===0,'completed request removed from pending');
 await shot(reviewer,'after-approval');result.checks.push(`Reviewer opens exact formal details, enters reason, clicks ${decision}; both approval and resource persisted ${expectedStatus}`);
 await reviewer.context.close();
 backend=workflowFixture();await backend.draft({actor:'synthetic-builder',role:'builder'});
 backend.records.get(`${REGISTRY}/${RECORD}`).status='PENDING_APPROVAL';
 const builder=await session('synthetic-builder','builder');
 await builder.page.locator('[data-regtype="MCPServer"]').click();
 await poll(async()=>await builder.page.locator('.regrow').count()===1,'builder MCP visible');
 await builder.page.locator('.regrow').first().click();
 await builder.page.locator('#regdrawerwrap').getByRole('button',{name:'Check submission eligibility',exact:true}).click();
 await builder.page.locator('#regdrawerwrap').getByRole('button',{name:'Submit for review',exact:true}).click();
 await poll(async()=>(await backend.state.listApprovals({domainId:'domain_a'})).items.length===1,'builder submit persisted');
 await builder.page.screenshot({path:path.join(out,'builder-registry-submit.png'),fullPage:true});
 assert.equal((await backend.state.listApprovals({domainId:'domain_a'})).items[0].requesterSubject,'synthetic-builder');
 await builder.context.close();result.checks.push('Builder owner opens Registry MCP details and submits existing resource through actual backend; no Governance navigation required');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 result.checks.push('No page errors or unexpected network calls');
} catch(error){result.errors.push(error.stack);process.exitCode=1;console.error(error)} finally {await browser.close();await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
