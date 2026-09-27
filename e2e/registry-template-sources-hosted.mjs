// Read-only content acceptance of the hosted template catalog.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.env.DOMAIN_BOOTSTRAP_APP_URL;
const identities = JSON.parse(await readFile(process.env.DOMAIN_BOOTSTRAP_IDENTITIES_FILE, "utf8"));
const evidence = process.env.DOMAIN_BOOTSTRAP_EVIDENCE_DIR;
assert.ok(url?.startsWith("https://") && evidence);
await mkdir(evidence, { recursive: true });
const expected = {
  "chat-assistant": { source: "blueprints/chatagent", recommended: true },
  "workflow-orchestrator": { source: "blueprints/workflowagent", recommended: true },
  "rag-knowledge": { source: "illustrative" },
  "claude-cos": { source: "https://github.com/anthropics/claude-agent-sdk-python" },
  "langgraph-multiagent": { source: "https://github.com/langchain-ai/langgraph" },
  "mcp-tool-server": { source: "illustrative" },
  "action-agent": { source: "illustrative" },
  "edge-classifier": { source: "illustrative" },
  "adk-data-agent": { source: "https://github.com/google/adk-samples" },
  "openai-ops-agent": { source: "https://github.com/openai/openai-agents-python" },
};
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(tokens => sessionStorage.setItem("console.cognito.tokens", JSON.stringify(tokens)), identities.admin.tokens);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-shellnav="blueprints"]').click({ timeout: 60_000 });
  await page.getByRole("heading", { name: "Foundation Harness Blueprints", exact: true }).waitFor();
  const observed = {};
  for (const [id, contract] of Object.entries(expected)) {
    // A shared and a domain-owned resource may have the same logical slug;
    // the API correctly qualifies both IDs to preserve separate identities.
    const detail = page.locator(`[data-bpdetail="${id}"], [data-bpdetail$="/blueprint_${id}"]`);
    await detail.locator("summary").click();
    const text = await detail.innerText();
    assert.ok(text.includes(contract.source), `${id} must show its declared source`);
    assert.ok(!text.includes("record predates source tracking"), `${id} must no longer be unknown`);
    const card = detail.locator("..");
    assert.match(await card.innerText(), /1\.3\.0-platform-descriptor\.1/);
    if (contract.recommended) {
      assert.match(await card.innerText(), /Recommended · Strands \+ AgentCore/);
      assert.match(text, /framework: Strands/);
      assert.match(text, /deployTarget: AgentCore Runtime/);
      assert.match(text, /Choose from this domain’s allowed models/);
      await card.screenshot({ path: `${evidence}/template-${id}.png` });
    }
    observed[id] = text;
  }
  const details = page.locator("[data-bpdetail]");
  for (const detail of await details.all()) {
    await detail.evaluate(element => { element.open = true; });
    assert.ok(!(await detail.innerText()).includes("record predates source tracking"),
      "Every visible baseline, including existing platform copies, must declare its source");
  }
  await page.screenshot({ path: `${evidence}/template-sources-all.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/template-sources-result.json`, JSON.stringify({
    checkedAt: new Date().toISOString(), url, passed: true, observed, browserErrors: errors,
  }, null, 2));
  console.log("All ten hosted template sources and both recommended Strands + AgentCore contracts verified.");
} finally {
  await browser.close();
}
