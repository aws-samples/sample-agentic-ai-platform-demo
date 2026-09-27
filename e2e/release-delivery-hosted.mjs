// Real hosted verification; optional explicitly labeled local frontend preview.
// Never submits a production decision.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {chromium} from 'playwright';

const base = process.env.BASE_URL;
const out = process.env.EVIDENCE_DIR;
const preview = process.env.LOCAL_UI_PREVIEW === 'true';
assert.ok(base?.startsWith('https://') && out && process.env.LOGIN_FILE);
const [user] = JSON.parse(await readFile(process.env.LOGIN_FILE, 'utf8'));
const publicDir = resolve(new URL('../console/public/', import.meta.url).pathname);
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({
  viewport:{width:1600,height:1000},
  recordVideo:{dir:out+'/video',size:{width:1600,height:1000}},
});
const report = {mode:preview?'local-frontend-preview-hosted-api':'hosted-console',webDeployed:!preview,
  approvalSubmissions:0,errors:[],startedAt:new Date().toISOString()};
if (preview) await context.route(base+'/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() === 'GET' && (path === '/' || ['.mjs','.css'].includes(extname(path)))) {
    const file = resolve(publicDir, '.'+(path === '/' ? '/index.html' : path));
    if (file.startsWith(publicDir+'/')) {
      try {
        const body = await readFile(file);
        return route.fulfill({status:200,body,contentType:path==='/'?'text/html':path.endsWith('.css')?'text/css':'text/javascript'});
      } catch {}
    }
  }
  return route.continue();
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
page.on('pageerror', error => report.errors.push(error.message));
page.on('request', request => {
  if (request.method() === 'POST' && request.url().endsWith('/api/release-decisions')) report.approvalSubmissions++;
});
try {
  await page.goto(base);
  await page.locator('#cognitosignin').click();
  await page.locator('input[name=username]:visible').fill(user.username);
  await page.locator('input[name=password]:visible').fill(user.password);
  await page.locator('input[name=signInSubmitButton]:visible,button[type=submit]:visible').first().click();
  await page.waitForURL(base+'/**');
  await page.locator('[data-shellnav="governance"]').click();
  await page.locator('[data-queue-section="agent-releases"]').click();
  await page.locator('#governed-release-delivery').getByRole('heading',{name:'contract-review-agent-20260919'}).waitFor();
  if (preview) await page.evaluate(() => {
    const note = document.createElement('aside');
    note.textContent = 'LOCAL UI PREVIEW · Real hosted API · Web deployment pending';
    Object.assign(note.style,{position:'fixed',top:'0',right:'0',zIndex:'99999',
      padding:'12px 22px',background:'#fff0cc',color:'#3b2c08',font:'bold 15px system-ui'});
    document.body.append(note);
  });
  await page.locator('#governed-release-delivery').scrollIntoViewIfNeeded();
  await page.locator('#governed-release-delivery summary').first().click();
  assert.equal(await page.getByRole('button',{name:'Approve production',exact:true}).count(),0);
  await page.waitForTimeout(3000);
  await page.screenshot({path:out+'/governed-releases.png',fullPage:true});
  report.visibleText = await page.locator('#governed-release-delivery').innerText();
  if (process.env.VERIFY_WEB_PAGES === 'true') {
    report.pages = [];
    for (const nav of ['registry', 'bwbuild', 'bwfleet', 'bwmemorykb']) {
      await page.locator(`[data-shellnav="${nav}"]`).click();
      await page.locator(`[data-shellnav="${nav}"][aria-current="page"]`).waitFor();
      if (nav === 'registry') {
        await page.waitForFunction(() => {
          const box = document.querySelector('#regbox');
          return box && !box.textContent.includes('Loading…') && box.textContent.trim().length > 80;
        });
      } else if (nav === 'bwfleet') {
        await page.locator('[data-workspace-pick="platform-foundation"]').click();
        await page.waitForFunction(() => {
          const box = document.querySelector('#wsroot');
          return box && !box.textContent.includes('loading') && box.querySelector('h1');
        });
      } else if (nav === 'bwmemorykb') {
        await page.locator('[data-memorykb-section="memory"]').waitFor();
        await page.locator('#wscontextswitchbtn').click();
        const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/project-memories'
          && new URL(r.url()).searchParams.get('project') === 'it-helpdesk');
        await page.locator('.wsswitchitem[data-project="it-helpdesk"]').click();
        const result = await response;
        assert.equal(result.status(),200);
        const resources = await result.json();
        assert.ok(resources.memories.length && resources.knowledgeBases.length);
        await page.getByText(resources.memories[0].name,{exact:true}).waitFor();
        report.liveProjectResources = resources;
      }
      await page.waitForTimeout(2000);
      const content = await page.locator('#main').innerText();
      assert.ok(content.trim().length > 80, `${nav} must render page content`);
      assert.doesNotMatch(content, /TypeError|ReferenceError|Failed to fetch/);
      await page.screenshot({path:`${out}/${nav}.png`,fullPage:true});
      report.pages.push({nav,content});
    }
  }
  assert.equal(report.approvalSubmissions,0);
  assert.deepEqual(report.errors,[]);
  report.finishedAt = new Date().toISOString();
} finally {
  await context.close();
  await browser.close();
  await writeFile(out+'/report.json',JSON.stringify(report,null,2));
}
