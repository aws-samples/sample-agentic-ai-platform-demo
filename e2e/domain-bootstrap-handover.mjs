// Read-only handover verification for an initialized, empty validation domain.
// The supplied user must have only Domain Lead membership for that domain.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.DOMAIN_BOOTSTRAP_APP_URL?.replace(/\/$/, "");
const domainId = process.env.DOMAIN_BOOTSTRAP_DOMAIN_ID;
const evidence = process.env.DOMAIN_BOOTSTRAP_EVIDENCE_DIR;
const identity = JSON.parse(await readFile(process.env.DOMAIN_BOOTSTRAP_IDENTITIES_FILE, "utf8")).lead;
assert.ok(base?.startsWith("https://") && domainId && evidence && identity?.tokens);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(tokens =>
    sessionStorage.setItem("console.cognito.tokens", JSON.stringify(tokens)), identity.tokens);
  const headers = { authorization: `Bearer ${identity.tokens.accessToken}`, "x-active-domain": domainId };
  const checks = [];
  async function get(path, status = 200, extra = {}) {
    const response = await context.request.get(`${base}${path}`, { headers: { ...headers, ...extra } });
    assert.equal(response.status(), status, path);
    checks.push({ path, status });
    return response.json();
  }
  const operation = (await get(`/api/domain-bootstrap?domainId=${domainId}`)).operation;
  assert.equal(operation.status, "SUCCEEDED");
  const registry = await get("/api/registry");
  assert.equal(registry.domainResourcePolicyApplied, true);
  const controlled = registry.entries.filter(entry =>
    entry.domain === "shared" && ["Blueprint", "Model", "Skill", "MCPServer"].includes(entry.type));
  const expected = [...operation.configuration.blueprints, ...operation.configuration.models,
    ...operation.configuration.resources].map(ref => `${ref.type}:${ref.id}`).sort();
  assert.deepEqual(controlled.map(entry => `${entry.type}:${entry.id}`).sort(), expected);
  assert.deepEqual((await get("/api/projects?limit=50")).items, []);
  await get("/api/domain-bootstrap/catalog", 403);
  if (process.env.DOMAIN_BOOTSTRAP_OTHER_DOMAIN) {
    const other = process.env.DOMAIN_BOOTSTRAP_OTHER_DOMAIN;
    await get("/api/registry", 403, { "x-active-domain": other });
    await get(`/api/domain-bootstrap?domainId=${other}`, 404);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator('[data-shellnav="dashboard"]').click({ timeout: 60_000 });
  await page.getByRole("heading", { name: "Domain foundation", exact: true }).waitFor({ timeout: 60_000 });
  const foundation = page.locator("#domain-foundation-summary");
  await foundation.getByText("Ready for projects", { exact: true }).waitFor();
  for (const env of operation.configuration.environments) {
    await foundation.getByText(`${env}: foundation ready`, { exact: true }).waitFor();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${evidence}/domain-admin-foundation.png`, fullPage: true });
  await page.locator('[data-shellnav="projects"]').click();
  await page.getByRole("button", { name: "Create project", exact: true }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${evidence}/domain-admin-projects.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/domain-admin-verification.json`, JSON.stringify({
    passed: true, domainId, allowedResources: controlled.map(({ type, id, name }) => ({ type, id, name })),
    zeroProjects: true, checks, browserErrors: errors,
  }, null, 2));
  console.log("Domain Admin handover verified: exact resource set, empty projects, foundation dashboard, scope denials.");
} finally {
  await browser.close();
}
