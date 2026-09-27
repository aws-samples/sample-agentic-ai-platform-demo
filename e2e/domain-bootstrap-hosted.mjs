// Hosted acceptance; read-only unless DOMAIN_BOOTSTRAP_SUBMIT=true explicitly
// enables domain provisioning. Credentials come from a private temporary file;
// provisioning and deleting test users remain explicit operator actions.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const url = process.env.DOMAIN_BOOTSTRAP_APP_URL;
const identities = JSON.parse(await readFile(process.env.DOMAIN_BOOTSTRAP_IDENTITIES_FILE, "utf8"));
const evidence = process.env.DOMAIN_BOOTSTRAP_EVIDENCE_DIR;
assert.ok(url?.startsWith("https://") && evidence);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(tokens => sessionStorage.setItem("console.cognito.tokens", JSON.stringify(tokens)), identities.admin.tokens);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-shellnav="domains"]').click({ timeout: 60_000 });
  await page.getByRole("button", { name: "Create domain", exact: true }).waitFor();
  await page.getByRole("columnheader", { name: "Projects", exact: true }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${evidence}/hosted-domains.png`, fullPage: true });
  await page.getByRole("button", { name: "Create domain", exact: true }).click();
  // Reproduce the owner's setup: no pre-created Domain Lead. The signed-in
  // Platform Admin must be available and preselected from the actual directory.
  assert.equal(await page.getByLabel("Domain administrator").inputValue(), identities.admin.username);
  const userOptions = await page.getByLabel("Domain administrator").locator("option").allTextContents();
  assert.ok(userOptions.length > 2, "The existing directory users must be visible");
  if (process.env.DOMAIN_BOOTSTRAP_EXPECT_USER) {
    assert.equal(await page.getByLabel("Domain administrator").locator(`option[value="${process.env.DOMAIN_BOOTSTRAP_EXPECT_USER}"]`).isEnabled(), true);
    await page.getByLabel("Domain administrator").selectOption(process.env.DOMAIN_BOOTSTRAP_EXPECT_USER);
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Enter a domain name.", { exact: true }).waitFor();
  await page.getByLabel("Domain name", { exact: true }).fill((process.env.DOMAIN_BOOTSTRAP_TEST_DOMAIN || "Bootstrap Acceptance"));
  await page.getByRole("button", { name: "Refresh users", exact: true }).click();
  await page.getByText("Users refreshed. Your draft is preserved.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Domain name", { exact: true }).inputValue(), (process.env.DOMAIN_BOOTSTRAP_TEST_DOMAIN || "Bootstrap Acceptance"));
  if (process.env.DOMAIN_BOOTSTRAP_EXPECT_USER) assert.equal(await page.getByLabel("Domain administrator").inputValue(), process.env.DOMAIN_BOOTSTRAP_EXPECT_USER);
  assert.equal(await page.getByLabel(/Project name/).count(), 0);
  await page.screenshot({ path: `${evidence}/hosted-page-1-users.png`, fullPage: true });
  console.log("Page 1: real users, current administrator default, name-only continuation and directory refresh verified.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("group", { name: "Available agent blueprints", exact: true }).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  assert.ok(await page.getByLabel("Business owner (optional)", { exact: true }).inputValue());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const blueprintGroup = page.getByRole("group", { name: "Available agent blueprints", exact: true });
  const choices = await blueprintGroup.locator("label").allTextContents();
  assert.ok(choices.length > 1, "Live Registry must supply blueprint choices");
  await blueprintGroup.getByRole("checkbox").nth(0).check();
  await blueprintGroup.getByRole("checkbox").nth(1).check();
  const selectAll = process.env.DOMAIN_BOOTSTRAP_SELECT_ALL === "true";
  let registeredModelCount;
  if (selectAll) {
    const response = await page.request.get(`${url.replace(/\/$/, "")}/api/registry`, {
      headers: { authorization: `Bearer ${identities.admin.tokens.accessToken}` },
    });
    assert.equal(response.status(), 200);
    const registry = await response.json();
    const modelIds = registry.entries.filter(entry => entry.type === "Model").map(entry => entry.id).sort();
    registeredModelCount = modelIds.length;
    const models = page.getByRole("group", { name: "Allowed models", exact: true });
    const visibleIds = await models.locator("[data-selection]").evaluateAll(inputs =>
      inputs.map(input => JSON.parse(input.dataset.ref)[1]).sort());
    assert.deepEqual(visibleIds, modelIds, "Every AI Registry model must appear in domain selection");
    await blueprintGroup.getByRole("button", { name: "Select all", exact: true }).click();
    await models.getByRole("button", { name: "Select all", exact: true }).click();
    assert.ok(registeredModelCount > 1, "Exercise multiple registered models, including runtime-pending models");
  }
  const expectedModel = process.env.DOMAIN_BOOTSTRAP_EXPECT_MODEL;
  if (expectedModel) {
    const models = page.getByRole("group", { name: "Allowed models", exact: true });
    const modelChoice = models.getByRole("checkbox", { name: new RegExp(expectedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    assert.equal(await modelChoice.count(), 1, "The expected approved model must be selectable");
    await modelChoice.check();
    assert.equal(await blueprintGroup.getByText(/Recommended · Strands \+ AgentCore/).count(), 2);
  }
  await page.getByRole("button", { name: "Refresh Registry", exact: true }).click();
  await page.getByText("Registry refreshed. Review your selections.", { exact: true }).waitFor();
  await page.screenshot({ path: `${evidence}/hosted-registry-selection.png`, fullPage: true });
  const notices = await page.locator(".df-notice").allTextContents();
  const selectedBlueprints = await page.locator('[data-selection="blueprints"]:checked').count();
  const selectedModels = await page.locator('[data-selection="models"]:checked').count();
  if (selectAll) assert.equal(selectedModels, registeredModelCount, "All model selections survive refresh");
  else if (expectedModel) assert.equal(selectedModels, 1, "Model selection survives Registry refresh");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.reload();
  await page.locator('[data-shellnav="domains"]').click({ timeout: 60_000 });
  await page.getByRole("button", { name: "Create domain", exact: true }).click();
  assert.equal(await page.getByLabel("Domain name", { exact: true }).inputValue(), (process.env.DOMAIN_BOOTSTRAP_TEST_DOMAIN || "Bootstrap Acceptance"));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal(await page.locator('[data-selection="blueprints"]:checked').count(), selectedBlueprints);
  assert.equal(await page.locator('[data-selection="models"]:checked').count(), selectedModels);
  console.log("Page 2: Registry selection, refresh, back navigation and saved-draft reload verified.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal(await page.getByLabel("Connected AWS account").inputValue(), process.env.AWS_ACCOUNT_ID);
  await page.getByRole("checkbox", { name: "PREPROD", exact: true }).check();
  await page.getByRole("checkbox", { name: "PROD", exact: true }).check();
  await page.screenshot({ path: `${evidence}/hosted-page-3-environments.png`, fullPage: true });
  console.log("Page 3: connected account, region and dev/preprod/prod selections verified.");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Readiness checks", exact: true }).waitFor({ timeout: 30_000 });
  const blocked = await page.getByRole("button", { name: "Bootstrap domain", exact: true }).isDisabled();
  assert.equal(blocked, false, "Valid resource selections must reach executable initialization review");
  if (expectedModel) {
    const reviewModels = page.locator("dt").filter({ hasText: /^Allowed models$/ }).locator("xpath=following-sibling::dd[1]");
    assert.match(await reviewModels.innerText(), new RegExp(expectedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  await page.getByRole("button", { name: "Back", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: "PROD", exact: true }).isChecked(), true);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Readiness checks", exact: true }).waitFor();
  await page.screenshot({ path: `${evidence}/hosted-page-4-review.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidence}/hosted-page-4-mobile.png`, fullPage: true });
  console.log("Page 4: executable review, back navigation and retained environments verified; no bootstrap submitted yet.");
  let initializedDomain = null;
  if (process.env.DOMAIN_BOOTSTRAP_SUBMIT === "true") {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole("button", { name: "Bootstrap domain", exact: true }).click();
    await page.getByRole("heading", { name: "Bootstrap progress", exact: true }).waitFor({ timeout: 30_000 });
    if (await page.getByRole("button", { name: "Retry bootstrap", exact: true }).count()) {
      const retried = page.waitForResponse(response => response.url().endsWith("/api/domain-bootstrap/retry")
        && response.request().method() === "POST");
      await page.getByRole("button", { name: "Retry bootstrap", exact: true }).click();
      assert.equal((await retried).status(), 200);
      console.log("Resuming the existing validation operation after the provisioning fix.");
    }
    await page.screenshot({ path: `${evidence}/hosted-initializing.png`, fullPage: true });
    const configuredName = process.env.DOMAIN_BOOTSTRAP_TEST_DOMAIN || "Bootstrap Acceptance";
    initializedDomain = configuredName.toLowerCase().replace(/[ _-]+/g, "_");
    const until = Date.now() + 12 * 60_000;
    let last;
    while (Date.now() < until) {
      const response = await page.request.get(`${url.replace(/\/$/, "")}/api/domain-bootstrap?domainId=${initializedDomain}`, {
        headers: { authorization: `Bearer ${identities.admin.tokens.accessToken}` },
      });
      assert.equal(response.status(), 200);
      last = (await response.json()).operation;
      if (last.status === "FAILED") throw new Error(`Initialization failed: ${last.error}`);
      if (last.status === "SUCCEEDED") break;
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    assert.equal(last?.status, "SUCCEEDED", "All initialization steps must complete");
    assert.equal(last.steps.filter(step => step.status === "SUCCEEDED").length, 6);
    assert.equal(last.configuration.blueprints.length, selectedBlueprints);
    assert.equal(last.configuration.models.length, selectedModels, "Only the explicitly selected models are enabled");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText("Foundation verified.", { exact: false }).waitFor();
    await page.getByText("No projects yet.", { exact: false }).waitFor();
    await page.screenshot({ path: `${evidence}/hosted-initialized.png`, fullPage: true });
    await page.reload();
    await page.locator('[data-shellnav="domains"]').click({ timeout: 60_000 });
    await page.getByText("Foundation verified.", { exact: false }).waitFor();
    await writeFile(`${evidence}/completed-operation.json`, JSON.stringify(last, null, 2));
    console.log("All six live initialization steps succeeded; zero projects; reload verified.");
  }
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/hosted-result.json`, JSON.stringify({
    checkedAt: new Date().toISOString(), url, passed: true, mode: "live-four-page-validation",
    userOptions, blueprintChoices: choices, selectedModels, expectedModel, notices, browserErrors: errors, provisioningBlocked: blocked,
    completeBootstrapVerified: Boolean(initializedDomain), resourcesCreatedByBrowser: Boolean(initializedDomain), initializedDomain,
  }, null, 2));
  console.log(initializedDomain ? `Initialized ${initializedDomain}.` : "All four hosted creation pages verified; no domain provisioned.");
} finally {
  await browser.close();
}
