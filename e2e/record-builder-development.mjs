// Record real local commands and GitHub check reads in a browser terminal.
// This is the development/CI segment, not evidence of a production deployment.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const cwd = process.env.TEST_REPO_DIR;
const out = process.env.EVIDENCE_DIR;
const repository = process.env.TEST_GITHUB_REPOSITORY;
assert.ok(cwd?.startsWith("/") && out?.startsWith("/"));
assert.match(repository || "", /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
await mkdir(out, {recursive: true});
const browser = await chromium.launch({headless: true});
const context = await browser.newContext({
  viewport: {width: 1600, height: 1000},
  recordVideo: {dir: out + "/video", size: {width: 1600, height: 1000}},
});
const page = await context.newPage();
const commands = process.env.RECORDING_COMMANDS_FILE
  ? JSON.parse(await readFile(process.env.RECORDING_COMMANDS_FILE, "utf8"))
  : [
  ["Inspect the exported repository", "git", ["log", "--oneline", "-2"]],
  ["Review the local development change", "git", ["show", "--stat", "--oneline", "HEAD"]],
  ["Run Foundation conformance", "node", ["gates/check-guardrails.mjs"]],
  ["Run tests and recorded-response evaluation", ".venv/bin/python", ["-m", "pytest", "-q"]],
  ["Verify the real GitHub PR checks", "gh", ["pr", "checks", "1", "--repo", repository]],
];
assert.ok(Array.isArray(commands) && commands.length > 0);
for (const row of commands) assert.ok(Array.isArray(row) && row.length === 3 &&
  typeof row[0] === "string" && typeof row[1] === "string" &&
  Array.isArray(row[2]) && row[2].every(arg => typeof arg === "string"));
const evidence = {repository, startedAt: new Date().toISOString(), commands: []};
try {
  await page.setContent(`<style>
    *{box-sizing:border-box}body{margin:0;background:#101820;color:#eef3f8;font:20px system-ui}
    header{padding:34px 48px;border-bottom:1px solid #40536a}small{color:#91b7dd}
    h1{font-size:30px;margin:10px 0}main{padding:32px 48px}
    #command{color:#7edcbb;white-space:pre-wrap;font-size:15px}pre{font:17px/1.5 ui-monospace,monospace;white-space:pre-wrap}
    footer{position:fixed;bottom:0;background:#1c2b3a;width:100%;padding:20px 48px;font-size:18px}
    #terminal{height:660px;overflow:auto}
    </style><header><small>BUILDER JOURNEY · LOCAL DEVELOPMENT → GITHUB CI</small>
    <h1></h1><div id="repository"></div></header><main><div id="command"></div>
    <pre id="terminal"></pre></main><footer>Actual command output · No production deployment or approval in this segment</footer>`);
  await page.locator("#repository").evaluate((el, text) => {el.textContent = text;}, repository);
  if (process.env.RECORDING_CHAPTER) await page.locator("header small").evaluate(
    (el, text) => {el.textContent = text;}, process.env.RECORDING_CHAPTER);
  if (process.env.RECORDING_FOOTER) await page.locator("footer").evaluate(
    (el, text) => {el.textContent = text;}, process.env.RECORDING_FOOTER);
  for (const [title, command, args] of commands) {
    const row = {title, command: [command, ...args].join(" "), output: "", exitCode: null};
    evidence.commands.push(row);
    await page.locator("h1").evaluate((el, text) => {el.textContent = text;}, title);
    await page.locator("#command").evaluate((el, text) => {el.textContent = "$ " + text;}, row.command);
    await page.locator("#terminal").evaluate(el => {el.textContent = "";});
    await page.waitForTimeout(1500);
    let updates = Promise.resolve();
    row.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {cwd, env: {...process.env, NO_COLOR: "1", GH_PAGER: "cat"}});
      const append = chunk => {
        const text = chunk.toString();
        row.output += text;
        updates = updates.then(() => page.locator("#terminal").evaluate((el, value) => {
          el.textContent += value; el.scrollTop = el.scrollHeight;
        }, text));
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", reject);
      child.on("close", resolve);
    });
    await updates;
    assert.equal(row.exitCode, 0, row.title);
    await page.waitForTimeout(5000);
  }
  evidence.finishedAt = new Date().toISOString();
  await page.screenshot({path: out + "/ci-verified.png"});
} finally {
  await context.close();
  await browser.close();
  await writeFile(out + "/commands.json", JSON.stringify(evidence, null, 2));
}
