// Human-operated approval recording. Automation navigates and observes only.
// Never fills a reason, clicks a decision button, or sends a decision request.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const base = process.env.BASE_URL;
const out = process.env.EVIDENCE_DIR;
assert.ok(base?.startsWith('https://') && out);
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:false});
const context = await browser.newContext({
  viewport:{width:1600,height:1000},
  recordVideo:{dir:out+'/video',size:{width:1600,height:1000}},
});
const page = await context.newPage();
const report = {startedAt:new Date().toISOString(),mode:'human-operated-hosted-console',
  automationSubmittedDecision:false,errors:[]};
page.on('pageerror', error => report.errors.push(error.message));
let complete;
const decision = new Promise(resolve => { complete = resolve; });
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
  report.cancelled = true;
  complete();
  browser.close().catch(() => {});
});
page.on('response', async response => {
  if (response.request().method() !== 'POST'
      || new URL(response.url()).pathname !== '/api/release-decisions') return;
  const payload = response.request().postDataJSON();
  // Record release identity only, never credentials, entered reason or JWTs.
  report.humanDecision = Object.fromEntries(
    ['pipelineId','executionId','commitSha','artifactSha256','accountId','region','environment','decision']
      .map(key => [key,payload[key]]));
  report.decisionHttpStatus = response.status();
  if (response.ok()) complete();
});
try {
  await page.goto(base);
  await page.locator('#cognitosignin').click();
  // The owner enters their own credentials in the visible browser.
  await page.locator('[data-shellnav="governance"]').waitFor({timeout:3_600_000});
  await page.locator('[data-shellnav="governance"]').click();
  await page.locator('[data-queue-section="agent-releases"]').click();
  await page.locator('#governed-release-delivery').waitFor();
  report.signedInAt = new Date().toISOString();
  await writeFile(out+'/progress.json',JSON.stringify(report,null,2));
  await page.screenshot({path:out+'/release-queue.png',fullPage:true});
  await decision;
  await page.waitForTimeout(5000);
  await page.screenshot({path:out+'/human-decision-result.png',fullPage:true});
  report.finishedAt = new Date().toISOString();
} finally {
  await context.close();
  await browser.close();
  await writeFile(out+'/report.json',JSON.stringify(report,null,2));
}
