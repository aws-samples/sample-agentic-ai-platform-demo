// TEST MOCKS NOT LIVE. Serves the actual public application through interception.
// No application API, authentication provider, deployment or model call is live.
// Node22: node e2e/ui-regression-recovery.mjs <new-evidence-directory>
// Optional baseline inventory: RECOVERY_BASELINE_PUBLIC=<before-public-directory>
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, signIn, navigate, ready, poll, project, costRow, navs, requests, loaded, unexpected, errors } from './approved-ui-integration.mjs';
assert.match(process.version, /^v22\./);
const output = path.resolve(process.argv[2] || '/private/tmp/ui-regression-recovery-browser');
await mkdir(output, { recursive: true });
const checks = [], contentInventory = [], screenshots = [], failures = [];
let browser;
const titles = { home:/Platform Console/, dashboard:/Dashboard/, domains:/Domains/, blueprints:/Blueprint/, registry:/Registry/,
  governance:/Governance/, monitoring:/Platform Monitoring/, bwfleet:/Fleet/, bwbuild:/Build an Agent/, bwmemorykb:/Memory & KB/,
  bwcost:/Cost & Budget/, bwobs:/Observability/, bwregistry:/Registry/, build:/Build an Agent/, memorykb:/Memory & KB/,
  obs:/Observability/, overview:/Agentic AI Platform/, projects:/Projects/, users:/Users & Access/ };
async function capture(f, name) {
  if(await f.page.locator('[data-budget-cost]').count()){
    await poll(async()=>Boolean((await f.page.locator('[data-budget-cost]').innerText()).trim()),'cost content ready for screenshot');
    await poll(async()=>!/Loading agents/.test(await f.page.locator('[data-budget-agents]').innerText()),'project agent roster ready for screenshot');
  }
  await f.page.evaluate(() => {
    if (document.querySelector('[data-test-watermark]')) return;
    const marker = document.createElement('div'); marker.dataset.testWatermark = '';
    marker.textContent = 'TEST MOCKS NOT LIVE';
    marker.style.cssText = 'position:relative;display:block;clear:both;background:#fff4cc;color:#111;padding:6px 12px;font:14px sans-serif;border:1px solid #111;pointer-events:none';
    document.body.append(marker);
  });
  const text = await f.page.locator('#main').innerText();
  contentInventory.push({ name, text, dialogs: [...f.state.dialogs] });
  await writeFile(path.join(output, name + '.txt'), 'TEST MOCKS NOT LIVE\n' + text);
  await f.page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
  screenshots.push(name + '.png');
}
async function check(name, f, work) {
  const start = f?.state.dialogs.length || 0;
  try { await work(); checks.push({name,status:'pass'}); console.log('PASS', name); }
  catch(error) {
    const dialogs = f?.state.dialogs.slice(start) || [];
    const status = dialogs.some(d=>d.type==='confirm') ? 'guard-blocked' : 'fail';
    const failure = { name, status, error:error.stack||String(error), dialogs };
    failures.push(failure); checks.push(failure); process.exitCode=1; console.error(status.toUpperCase(),name,error.message);
    if(f)try{await capture(f,'failure-'+checks.length)}catch{}
  }
}
async function shell(f) {
  assert.equal(await f.page.locator('#whoami,#tbdemoassist').count(),0);
  assert.equal(await f.page.locator('#tbprofile').count(),1);
  assert.doesNotMatch(await f.page.locator('#topbar').innerText(),/Demo mode/);
  assert.deepEqual(await f.page.locator('[data-shellnav]').evaluateAll(nodes=>nodes.map(n=>n.dataset.shellnav)),navs[f.state.role]);
  assert.equal(await f.page.evaluate(()=>sessionStorage.getItem('console.demo-assist')),null);
}
async function start(role,count=2,sourceRoot) {
  const f=await fixture(role,{},browser,sourceRoot);
  const domain=role==='admin'?'platform':'domain_a';
  f.state.projects=[project(domain),{...project(domain),id:'second',name:'Second project'}].slice(0,count);
  f.state.projects.push({...project('domain_b'),name:'Foreign same slug'});
  f.state.agents=[{id:'own',name:'Own agent',domainId:domain,projectId:'sample',status:'DRAFT'},
    {id:'second-agent',name:'Second agent',domainId:domain,projectId:'second',status:'DRAFT'},
    {id:'foreign',name:'Foreign agent',domainId:'domain_b',projectId:'sample',status:'DRAFT'}];
  f.state.costRows=[costRow(domain),{...costRow(domain),projectId:'second',estimatedCostUsd:20,knownEstimatedCostUsd:20},{...costRow('domain_b'),estimatedCostUsd:90,knownEstimatedCostUsd:90}];
  if(role==='builder')f.state.operationsRows=[{scopeType:'project',domainId:domain,projectId:'sample',runtimeCount:1,healthyRuntimeCount:1,invocationCount:12,errorCount:1,averageLatencyMs:4},
    {scopeType:'project',domainId:domain,projectId:'second',runtimeCount:1,healthyRuntimeCount:1,invocationCount:987,errorCount:0}];
  await f.context.addInitScript(()=>sessionStorage.setItem('console.demo-assist','true'));
  await signIn(f);
  return f;
}
try {
  // Preserve Chromium's process sandbox. Never add unsafe launch flags.
  browser=await chromium.launch({headless:true,chromiumSandbox:true});
  if(process.env.RECOVERY_BASELINE_PUBLIC){
    const f=await start('admin',2,path.resolve(process.env.RECOVERY_BASELINE_PUBLIC));
    for(const id of ['bwcost','bwobs','cost','monitoring'])await check('baseline inventory '+id,f,async()=>{
      await navigate(f.page,id);await capture(f,'before-'+id);
    });
    await f.context.close();
  }
  for(const role of ['admin','lead','builder','user'])for(const count of [0,1,2]){
    const f=await start(role,count);
    for(const id of navs[role])await check(`${role}/${count} projects/menu ${id}`,f,async()=>{
      await navigate(f.page,id); await shell(f);
      const title=await f.page.locator('#main h1').first().innerText();
      assert.match(title,id==='cost'?(role==='admin'?/Platform Cost/:/Cost & Budget/):id==='fleet'?(role==='user'?/Agents/i:/Fleet/):titles[id]);
      if(['bwfleet','bwmemorykb','bwcost','bwobs','memorykb','obs'].includes(id)||(role==='builder'&&['fleet','cost'].includes(id))){
        assert.equal(await f.page.locator('#wstabs').count(),0);
        assert.doesNotMatch(await f.page.locator('#main').innerText(),/Foreign agent|Foreign same slug/);
        if(count===0){
          await ready(f.page,'[data-workspace-state="empty"]');
          assert.equal(await f.page.locator('[data-hosted-project-wizard],#hostedprojectid').count(),0);
          assert.equal(await f.page.locator('[data-project-setup]').count(),1);
        }else{
          await ready(f.page,'#wsswitchbtn');
          assert.equal(await f.page.locator('.wsswitchitem').count(),count);
        }
      }
      if(id==='users'){
        await ready(f.page,'#haccessdomain');
        assert.equal(await f.page.locator('#haccessdomain').isDisabled(),true);
        assert.deepEqual(await f.page.locator('#haccessdomain option').evaluateAll(nodes=>nodes.map(n=>n.value)),['domain_a']);
      }
      if(id==='projects')assert.equal(await f.page.locator('[data-hosted-project-wizard]').count(),0);
      if(['cost','bwcost','obs','bwobs','monitoring'].includes(id))await capture(f,`after-${role}-${count}-${id}`);
    });
    assert.equal(f.state.projectPosts,0,'Navigation cannot create projects');
    await f.context.close();
  }
  for(const mode of ['denied','error','malformed']){
    const f=await start('lead',0);f.state.projectsMode=mode;
    await check('project response '+mode,f,async()=>{
      // Reload through real authentication to invalidate the earlier project cache.
      await f.page.reload();await ready(f.page,'#tbprofile');await navigate(f.page,'bwcost');
      await ready(f.page,'[data-workspace-state="error"]');
      const text=await f.page.locator('#main').innerText();
      assert.match(text,/Cost & Budget/);assert.match(text,mode==='denied'?/denied/i:mode==='malformed'?/invalid/i:/unavailable/i);
      assert.equal(await f.page.locator('[data-workspace-state="empty"]').count(),0);
    });await f.context.close();
  }
  const chooser=await start('builder',2);
  await check('chooser and switch preserve Cost and exact project',chooser,async()=>{
    await navigate(chooser.page,'cost');await ready(chooser.page,'#wsswitchbtn');
    await chooser.page.locator('#wsswitchbtn').click();await chooser.page.locator('.wsswitchitem[data-project="second"]').click();
    await poll(async()=>/20\.00/.test(await chooser.page.locator('[data-budget-cost]').innerText()),'selected second project cost finishes rendering');
    assert.match(await chooser.page.locator('[data-budget-cost]').innerText(),/Project: domain_a \/ second/);
    await chooser.page.locator('#wsswitchbtn').click();await chooser.page.locator('#wsswitchall').click();
    await ready(chooser.page,'[data-project-open="sample"]');await chooser.page.locator('[data-project-open="sample"]').click();
    await poll(async()=>/0\.000003/.test(await chooser.page.locator('[data-budget-cost]').innerText()),'selected sample project cost finishes rendering');assert.match(await chooser.page.locator('h1').innerText(),/Cost/);
    assert.match(await chooser.page.locator('[data-budget-cost]').innerText(),/Project: domain_a \/ sample/);
    assert.doesNotMatch(await chooser.page.locator('#main').innerText(),/90\.00|Foreign/);
  });
  await check('project Observability shows roster and supported exact runtime metrics',chooser,async()=>{
    await navigate(chooser.page,'obs');await ready(chooser.page,'#workspaceobsagent');
    assert.deepEqual(await chooser.page.locator('#workspaceobsagent option').allTextContents(),['All project agents','Own agent']);
    await poll(async()=>/Requests:\s*12/.test(await chooser.page.locator('#workspaceobsdetail').innerText()),'project metrics');
    assert.doesNotMatch(await chooser.page.locator('#workspaceobsdetail').innerText(),/987/);
    await chooser.page.locator('[data-workspace-obs-tab="traces"]').click();
    assert.match(await chooser.page.locator('#workspaceobsdetail').innerText(),/native traces are unavailable/);
  });await chooser.context.close();
  const stale=await start('builder',2);
  await check('late old cost cannot overwrite a newly selected project',stale,async()=>{
    await navigate(stale.page,'fleet');
    let release;
    stale.state.delayedCosts=new Promise(resolve=>{release=resolve});
    await stale.page.locator('[data-shellnav="cost"]').click();await ready(stale.page,'#wsswitchbtn');
    await poll(()=>Promise.resolve(requests.some(r=>r.resource==='costs')),'cost requested');
    stale.state.delayedCosts=null;
    await stale.page.locator('#wsswitchbtn').click();await stale.page.locator('.wsswitchitem[data-project="second"]').click();
    await ready(stale.page,'[data-project-cost]');release();
    await poll(async()=>/20\.00/.test(await stale.page.locator('[data-budget-cost]').innerText()),'second cost remains current');
    assert.match(await stale.page.locator('h1').innerText(),/Second project/);
  });await stale.context.close();
  const switched=await start('lead',2);
  await check('same project slug across authorized domains is revalidated by Cognito context',switched,async()=>{
    await navigate(switched.page,'bwfleet');await switched.page.locator('#tbdomain').selectOption('domain_b');
    await poll(async()=>await switched.page.locator('#tbdomain').inputValue()==='domain_b','domain switch');
    switched.state.domain='domain_b';await navigate(switched.page,'bwfleet');await ready(switched.page,'#wsswitchbtn');
    assert.match(await switched.page.locator('h1').innerText(),/Foreign same slug/);
    assert.doesNotMatch(await switched.page.locator('h1').innerText(),/Synthetic domain_a/);
  });await switched.context.close();
  const wiz=await start('lead',2);
  await check('real six-step wizard, manual fields, explicit writes and partial-result retry',wiz,async()=>{
    await navigate(wiz.page,'projects');await ready(wiz.page,'#dcprojgo');await wiz.page.locator('#dcprojgo').click();
    await ready(wiz.page,'[data-hosted-project-wizard]');
    assert.equal(await wiz.page.locator('.steps .step').count(),6);
    await wiz.page.locator('[data-wtpl="blank"]').click();await wiz.page.locator('#wnext').click();
    assert.equal(await wiz.page.locator('#wname').inputValue(),'');
    await wiz.page.locator('#wid').fill('manual-project');await wiz.page.locator('#wname').fill('Manual Project');await wiz.page.locator('#wdesc').fill('Manually entered description');
    await wiz.page.locator('#wnext').click();await wiz.page.locator('#wback').click();
    assert.equal(await wiz.page.locator('#wname').inputValue(),'Manual Project');
    await wiz.page.locator('#wnext').click();assert.match(await wiz.page.locator('[data-hosted-project-wizard]').innerText(),/does not save an agent blueprint/);
    await wiz.page.locator('#wnext').click();await wiz.page.locator('#wmember').fill('existing-user');await wiz.page.locator('#wmemberreason').fill('Manual business need');
    await wiz.page.locator('#wnext').click();await wiz.page.locator('#wnext').click();
    assert.equal(wiz.state.projectPosts,0);
    assert.match(await wiz.page.locator('#wizreview').innerText(),/Manual Project/);
    wiz.state.failMembership=true;await wiz.page.locator('#wcreate').click();
    await poll(async()=>/member assignment is incomplete/.test(await wiz.page.locator('#wizstatus').innerText()),'partial create');
    wiz.state.failMembership=false;await wiz.page.locator('#wcreate').click();
    await ready(wiz.page,'[data-created-project-open]');assert.equal(wiz.state.projectPosts,1);
    await ready(wiz.page,'[data-project-budget]');assert.equal(wiz.state.posts,0);
    await capture(wiz,'wizard-created-budget-pending');
  });await wiz.context.close();
  const access=await start('lead',2);
  access.state.domainMembers=['first','second'].map(username=>({username,subject:username,userStatus:'CONFIRMED',enabled:true}));access.state.memberPageSize=1;
  await check('Users & Access raw membership paging and manual reason inputs',access,async()=>{
    await navigate(access.page,'users');await ready(access.page,'[data-access-more="domain"]');
    assert.equal(await access.page.locator('#haccessdomainreason').inputValue(),'');
    await access.page.locator('[data-access-more="domain"]').click();
    await ready(access.page,'[data-domain-member="second"]');
    assert.equal(await access.page.locator('[data-domain-member]').count(),2);
    await access.page.locator('[data-access-tab="project"]').click();
    assert.equal(await access.page.locator('#haccessproject option').count(),2);
    await access.page.locator('#haccessprojectreason').fill('My typed reason');
    assert.equal(await access.page.locator('#haccessprojectreason').inputValue(),'My typed reason');
    await capture(access,'access-membership');
  });await access.context.close();
  assert.deepEqual(unexpected,[]);
  assert.equal(requests.filter(r=>/domain-users|wizard-(templates|validate|create)|obs-traces|langfuse-traces/.test(r.resource)).length,0);
  assert.equal(requests.filter(r=>r.method==='POST'&&/invoke|generate|deployment|runtime|test-agent/.test(r.resource)).length,0);
  if(errors.length){failures.push({name:'uncaught browser errors',errors});process.exitCode=1;}
}catch(error){failures.push({name:'browser setup or fixture',error:error.stack||String(error)});process.exitCode=1;console.error(error);}
finally{
  if(browser)await browser.close();
  await writeFile(path.join(output,'browser-results.json'),JSON.stringify({label:'TEST MOCKS NOT LIVE',node:process.version,
    sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),
    trackedDiff:execFileSync('git',['diff','--stat'],{encoding:'utf8'}).trim(),
    passed:checks.filter(c=>c.status==='pass').length,failed:failures.length,checks,failures,requests,unexpected,
    loadedSourceSha256:Object.fromEntries(loaded),screenshots,contentInventory,pixelsInspected:false,liveAcceptance:false},null,2)+'\n');
}
