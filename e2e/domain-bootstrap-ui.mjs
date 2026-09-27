import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../console/public");
const ref = (type, id) => ({ type, id, version: "1.0.0", registryId: "registry-a", recordId: id });
const blueprint = { ref: ref("Blueprint", "foundation"), name: "Chat agent",
  content: { template: { framework: "Strands", deployTarget: "AgentCore Runtime",
    defaultModel: "model-a", tools: ["skill-a"], identity: true, guardrails: true,
    observability: "CloudWatch + OTEL" } } };
const model = { ref: ref("Model", "model-a"), name: "Approved model", content: {} };
const skill = { ref: ref("Skill", "skill-a"), name: "Enterprise skill", description: "Registry-owned integration", content: {} };
const catalog = { ok: true, blueprints: [blueprint, { ...blueprint, ref: ref("Blueprint", "workflow"), name: "Workflow agent" }], models: [model, { ...model, ref: ref("Model", "model-b"), name: "Second approved model" }], resources: [skill],
  administrators: [{ username: "alice", name: "Alice", enabled: true, eligible: true, role: "platform-admin" },
    { username: "consumer", name: "Consumer", enabled: true, eligible: false, role: "end-user" }],
  defaultAdministrator: "alice",
  target: { accountId: "123456789012", region: "us-west-2" } };

test("domain creation selects live Registry references, hands over with zero projects, and survives reload", async () => {
  let operation = null, submitted = null, catalogReads = 0, prerequisitesReady = false;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const send = data => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path.startsWith("/api/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = body ? JSON.parse(body) : null;
      if (path === "/api/domains") return send({ ok: true, domains: operation ? [{ id: "finance", name: "Finance", owner: "Finance owner", ownerGroup: "domain-finance" }] : [] });
      if (path === "/api/projects") {
        assert.equal(new URL(req.url, "http://localhost").searchParams.get("limit"), "50", "Hosted workspace page limit");
        return send({ ok: true, items: [], cursor: null });
      }
      if (path === "/api/domain-bootstrap/catalog") { catalogReads++; return send(catalog); }
      if (path === "/api/domain-bootstrap/preview") return send(prerequisitesReady
        ? { ok: true, ready: true, blockers: [], config: { ...input, domainId: "finance" },
          resolved: { blueprints: catalog.blueprints, models: catalog.models, resources: [skill] }, previewHash: "reviewed-version" }
        : { ok: true, ready: false, config: { ...input, domainId: "finance" },
          blockers: [{ code: "REGISTRY_INCOMPLETE", message: "AI Registry needs attention before provisioning." }] });
      if (path === "/api/domain-bootstrap" && req.method === "POST") {
        submitted = input;
        operation = { domainId: "finance", status: "SUCCEEDED", configuration: input.configuration,
          applied: { blueprints: catalog.blueprints, models: catalog.models, resources: [skill] }, steps: [
            { id: "domain", label: "Create domain and Registry", status: "SUCCEEDED" },
            { id: "identity", label: "Assign domain administrator", status: "SUCCEEDED" },
          ], outputs: { environments: [{ name: "dev", status: "READY_FOR_PROJECTS" }] } };
      }
      if (path === "/api/domain-bootstrap") return send({ ok: true, operation });
      if (path === "/api/registry") return send({ ok: true, entries: [blueprint, model, skill].map(entry => ({
        id: entry.ref.id, type: entry.ref.type, name: entry.name, domain: "shared", defaultVersion: entry.ref.version,
        versions: [{ semver: entry.ref.version, status: "APPROVED", content: entry.content,
          _aws: { registryId: entry.ref.registryId, recordId: entry.ref.recordId } }],
      })) });
      res.writeHead(404); return res.end();
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/styles/app.css"><style>body{padding:30px;max-width:1150px;margin:auto;display:block;height:auto;overflow:auto}button{cursor:pointer}</style></head>
        <body><main id="domain-root"></main><script type="module">
        import { mountDomains } from '/domain-bootstrap-view.mjs';
        mountDomains(document.querySelector('main'), { actor:'test-admin', request:async(path,body)=>{
          const res=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
          return res.json();
        }});</script></body></html>`);
    }
    try {
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(root + "/")) throw new Error();
      const content = await readFile(file);
      res.writeHead(200, { "content-type": extname(file) === ".mjs" ? "text/javascript" : "text/css" }); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button", { name: "Create domain", exact: true }).click();
    assert.equal(await page.getByLabel("Domain administrator").inputValue(), "alice");
    assert.equal(await page.getByLabel("Domain administrator").locator('option[value="consumer"]').isDisabled(), true);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText("Enter a domain name.", { exact: true }).waitFor();
    await page.getByLabel("Domain name", { exact: true }).fill("Finance");
    await page.getByRole("button", { name: "Refresh users", exact: true }).click();
    await page.getByText("Users refreshed. Your draft is preserved.", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Domain name", { exact: true }).inputValue(), "Finance");
    assert.equal(await page.getByLabel(/Project name/).count(), 0);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("group", { name: "Available agent blueprints", exact: true }).waitFor();
    assert.equal(await page.locator("#df-blueprint").count(), 0);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await page.getByLabel("Business owner (optional)", { exact: true }).inputValue(), "Alice");
    await page.getByLabel("Business owner (optional)", { exact: true }).fill("Finance owner");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("checkbox", { name: /Chat agent/ }).check();
    await page.getByRole("checkbox", { name: /Workflow agent/ }).check();
    await page.getByRole("checkbox", { name: /^Approved model/ }).check();
    await page.getByRole("checkbox", { name: /Second approved model/ }).check();
    assert.equal(await page.getByRole("checkbox", { name: /Enterprise skill/ }).isChecked(), false);
    await page.getByRole("checkbox", { name: /Enterprise skill/ }).check();
    await page.getByRole("button", { name: "Refresh Registry", exact: true }).click();
    assert.equal(catalogReads, 3);
    await mkdir("/private/tmp/domain-bootstrap-evidence", { recursive: true });
    await page.screenshot({ path: "/private/tmp/domain-bootstrap-evidence/registry-selection-desktop.png", fullPage: true });
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Create domain", exact: true }).click();
    assert.equal(await page.getByLabel("Domain name", { exact: true }).inputValue(), "Finance");
    assert.equal(await page.getByLabel("Business owner (optional)", { exact: true }).inputValue(), "Finance owner");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { name: /Chat agent/ }).isChecked(), true);
    assert.equal(await page.getByRole("checkbox", { name: /Workflow agent/ }).isChecked(), true);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("checkbox", { name: "PREPROD", exact: true }).check();
    await page.getByRole("checkbox", { name: "PROD", exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Readiness checks", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Bootstrap domain", exact: true }).isDisabled(), true);
    assert.equal(submitted, null);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { name: "PREPROD", exact: true }).isChecked(), true);
    assert.equal(await page.getByRole("checkbox", { name: "PROD", exact: true }).isChecked(), true);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    prerequisitesReady = true;
    await page.getByRole("button", { name: "Check again", exact: true }).click();
    await page.getByText("Current identity, Registry selections and target checks passed.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Bootstrap domain", exact: true }).click();
    await page.getByText("Foundation verified.", { exact: false }).waitFor();
    assert.equal(submitted.previewHash, "reviewed-version");
    assert.equal(Object.hasOwn(submitted.configuration, "projects"), false);
    assert.deepEqual(submitted.configuration.resources, [skill.ref]);
    assert.equal(submitted.configuration.blueprints.length, 2);
    assert.equal(submitted.configuration.models.length, 2);
    assert.equal(Object.hasOwn(submitted.configuration, "blueprint"), false);
    await page.reload();
    await page.getByText("Foundation verified.", { exact: false }).waitFor();
    await page.screenshot({ path: "/private/tmp/domain-bootstrap-evidence/domain-ready-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/private/tmp/domain-bootstrap-evidence/domain-ready-mobile.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
