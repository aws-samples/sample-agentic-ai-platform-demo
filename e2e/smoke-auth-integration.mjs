import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

const html = readFileSync(
  new URL("../console/public/index.html", import.meta.url),
  "utf8",
);
// Follow the real external entry point and its transitive imports. The console
// no longer embeds its application module in index.html.
const publicRoot = new URL("../console/public/", import.meta.url);
const hostedStaticModules = new Map();
function relativeModulePaths(source, parent = "/") {
  return [...source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g,
  )].map(match => new URL(match[1], "http://fixture.test" + parent).pathname);
}
const entryModules = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)]
  .map(match => match[1]);
function includeModule(path) {
  if (hostedStaticModules.has(path)) return;
  const source = readFileSync(new URL(path.slice(1), publicRoot), "utf8");
  hostedStaticModules.set(path, source);
  for (const dependency of relativeModulePaths(source, path)) includeModule(dependency);
}
for (const path of entryModules) includeModule(path);
const hostedModulePaths = [...hostedStaticModules.keys()].sort();
const hostedStyles = new Map([...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"/g)]
  .filter(match => !match[1].startsWith("/fonts/"))
  .map(match => [match[1], readFileSync(new URL(match[1].slice(1), publicRoot), "utf8")]));

const profiles = {
  alice: {
    ok: true,
    token: "token-alice",
    user: "alice",
    name: "Alice Chen",
    role: "builder",
    domain: "customer-support",
    domains: ["customer-support", "operations"],
    capabilities: ["useBuilderSurfaces"],
  },
  bob: {
    ok: true,
    token: "token-bob",
    user: "bob",
    name: "Bob Martinez",
    role: "builder",
    domain: "operations",
    domains: ["operations"],
    capabilities: ["useBuilderSurfaces"],
  },
  cognito: {
    ok: true,
    user: "cognito-user",
    name: "Cognito User",
    role: "user",
    authenticatedRole: "user",
    domain: null,
    domains: [],
    capabilities: [
      "discoverEntitledAgents",
      "invokeEntitledAgent",
      "viewOwnSessions",
      "submitAgentFeedback",
      "requestAgentAccess",
    ],
    demoRoleActive: false,
    canSwitchDemoRole: false,
    availableDemoRoles: [],
    availableDemoDomains: [],
  },
  cognitoAdmin: {
    ok: true,
    user: "cognito-admin",
    name: "Cognito Admin",
    role: "admin",
    authenticatedRole: "admin",
    domain: null,
    domains: ["platform", "customer_support", "operations"],
    capabilities: ["viewPlatformInventory"],
    demoRoleActive: false,
    canSwitchDemoRole: true,
    availableDemoRoles: ["admin", "lead", "builder", "user"],
    availableDemoDomains: [
      { id: "customer_support", name: "Customer Support" },
      { id: "operations", name: "Operations" },
    ],
  },
};

const demoCapabilities = {
  admin: ["viewPlatformInventory"],
  lead: ["viewDomainRegistry"],
  builder: ["viewDomainRegistry"],
  user: [
    "discoverEntitledAgents",
    "invokeEntitledAgent",
    "viewOwnSessions",
    "submitAgentFeedback",
    "requestAgentAccess",
  ],
};

function projectedCognitoProfile(req, profile) {
  const requestedRole = String(req.headers["x-demo-role"] || "");
  if (
    !profile?.canSwitchDemoRole
    || !profile.availableDemoRoles.includes(requestedRole)
  ) {
    return profile;
  }

  const requestedDomain = String(req.headers["x-active-domain"] || "");
  const domain = ["lead", "builder"].includes(requestedRole)
    ? requestedDomain
    : null;
  if (
    domain
    && !profile.availableDemoDomains.some(({ id }) => id === domain)
  ) {
    return { ok: false, code: "DEMO_DOMAIN_NOT_ALLOWED" };
  }

  return {
    ...profile,
    role: requestedRole,
    domain,
    domains: domain ? [domain] : requestedRole === "user" ? [] : profile.domains,
    capabilities: demoCapabilities[requestedRole],
    demoRoleActive: true,
  };
}

const mockDomains = [
  { id: "customer-support", name: "Customer Support", agents: [] },
  { id: "operations", name: "Operations", agents: [] },
];
const cognitoDomains = [
  { id: "platform", name: "Platform", agents: [] },
  { id: "customer_support", name: "Customer Support", agents: [] },
  { id: "operations", name: "Operations", agents: [] },
];

function json(res, status, body) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function authFixtureModule() {
  return `
export const authMode = () => window.__AUTH_TEST__?.mode || window.__RUNTIME_CONFIG__?.authMode || "mock";
export const beginSignIn = async () => window.__AUTH_TEST__?.beginSignIn?.();
export const clearAuthentication = () => window.__AUTH_TEST__?.clearAuthentication?.();
export const completeSignIn = async () => window.__AUTH_TEST__?.completeSignIn?.() || false;
export const getAccessToken = () => window.__AUTH_TEST__?.getAccessToken?.() || null;
export const signOut = () => window.__AUTH_TEST__?.signOut?.();
`;
}

function bearerUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  return token === profiles.alice.token
    ? "alice"
    : token === profiles.bob.token
      ? "bob"
      : token === "cognito-access"
        ? "cognito"
        : null;
}

async function readJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

async function startAuthFixture() {
  const state = {
    authMode: "mock",
    streamMode: "complete",
    streamClosed: false,
    streamStarted: null,
    resolveStreamStarted: null,
    heldStream: null,
    holdBobChat: false,
    heldBobChat: null,
    holdPlatoChatUser: null,
    platoChatClosed: false,
    platoChatStarted: null,
    resolvePlatoChatStarted: null,
    heldPlatoChat: null,
    meUnauthorized: false,
    scratchManifestRequests: [],
    holdScratchManifest: false,
    scratchManifestClosed: false,
    scratchManifestStarted: null,
    resolveScratchManifestStarted: null,
    heldScratchManifest: null,
    datasetInfoRequests: 0,
    datasetSaveBodies: [],
    holdDatasetSave: false,
    datasetSaveClosed: false,
    datasetSaveStarted: null,
    resolveDatasetSaveStarted: null,
    heldDatasetSave: null,
    holdMockLogins: false,
    mockLoginRequests: [],
    mockLoginStarted: null,
    resolveMockLoginStarted: null,
    heldMockLogins: [],
    cognitoProfile: profiles.cognito,
    registryMode: "local",
    registryEntries: [],
    registryRequests: [],
    sessionDomainRequests: [],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url.pathname === "/runtime-config.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(`window.__RUNTIME_CONFIG__=${JSON.stringify({
        authMode: state.authMode,
        apiBaseUrl: "/api",
      })}`);
      return;
    }
    const moduleBody = url.pathname === "/auth-client.mjs"
      ? authFixtureModule()
      : hostedStaticModules.get(url.pathname);
    if (moduleBody !== undefined) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
      });
      res.end(moduleBody);
      return;
    }
    if (hostedStyles.has(url.pathname)) {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(hostedStyles.get(url.pathname));
      return;
    }
    if (url.pathname.startsWith("/fonts/")) {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("");
      return;
    }
    if (url.pathname === "/api/login-users") {
      json(res, 200, {
        users: [
          { id: "alice", name: profiles.alice.name, title: "Builder" },
          { id: "bob", name: profiles.bob.name, title: "Builder" },
        ],
      });
      return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const { user } = body;
      state.mockLoginRequests.push(body);
      if (state.holdMockLogins) {
        const held = { user, body, res, closed: false };
        state.heldMockLogins.push(held);
        state.resolveMockLoginStarted?.();
        res.on("close", () => {
          held.closed = true;
        });
        return;
      }
      json(res, profiles[user] ? 200 : 400, profiles[user] || {
        ok: false,
        error: "unknown user",
      });
      return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/me") {
      if (state.meUnauthorized) {
        json(res, 401, { ok: false, error: "Not signed in." });
        return;
      }
      const profile = bearerUser(req) === "cognito"
        ? projectedCognitoProfile(req, state.cognitoProfile)
        : null;
      json(res, profile ? 200 : 401, profile || { ok: false });
      return;
    }
    if (url.pathname === "/api/session-domain" && req.method === "POST") {
      const body = await readJsonBody(req);
      state.sessionDomainRequests.push({
        mode: state.authMode,
        domain: body.domain ?? null,
      });
      const profile = bearerUser(req) === "alice"
        ? profiles.alice
        : state.cognitoProfile;
      json(res, 200, { ...profile, domain: body.domain ?? null });
      return;
    }
    if (url.pathname === "/api/registry") {
      state.registryRequests.push({
        authorization: req.headers.authorization || null,
        activeDomain: req.headers["x-active-domain"] || null,
      });
      if (state.registryMode === "reject") {
        res.destroy();
        return;
      }
      if (state.registryMode === "unavailable") {
        json(res, 503, {
          ok: false,
          code: "CONTROL_PLANE_UNAVAILABLE",
          message: "Control plane inventory is temporarily unavailable.",
          retryable: true,
        });
        return;
      }
      if (state.registryMode === "aws") {
        json(res, 200, {
          entries: state.registryEntries,
          source: "aws",
          statuses: [],
          store: "AWS Agent Registry + AgentCore Gateway",
          types: [],
        });
        return;
      }
      json(res, 200, {
        entries: [],
        source: "file",
        statuses: [],
        store: "console/ai-registry.json (console-local store)",
        types: [],
      });
      return;
    }
    if (url.pathname === "/api/blueprints") {
      json(res, 200, []);
      return;
    }
    if (url.pathname === "/api/catalog") {
      json(res, 200, {
        ok: true,
        models: [],
        githubOrgs: [],
        blueprintOptions: {},
      });
      return;
    }
    if (url.pathname === "/api/domains") {
      const domainRows = state.authMode === "cognito"
        ? cognitoDomains
        : mockDomains;
      json(res, 200, {
        ok: true,
        domains: domainRows,
        directory: domainRows,
      });
      return;
    }
    if (url.pathname === "/api/my-projects") {
      const user = bearerUser(req);
      const domain = user === "bob" ? "operations" : "customer-support";
      const project = {
        id: `${user || "user"}-project`,
        name: `${user || "User"} Project`,
        domain,
        agents: [`${user || "user"}-project`],
        members: [],
      };
      json(res, 200, {
        ok: true,
        projects: [project],
        lastProject: project.id,
      });
      return;
    }
    if (url.pathname === "/api/fleet") {
      const user = bearerUser(req);
      const domain = user === "bob" ? "operations" : "customer-support";
      json(res, 200, {
        ok: true,
        agents: user ? [{
          project: `${user}-project`,
          name: `${user} agent`,
          domain,
          status: "READY",
          approval: "APPROVED",
          health: "healthy",
          errorRate: 0,
          lastDeploy: "2026-08-21T00:00:00.000Z",
          ownerTeam: "Domain team",
        }] : [],
        region: "test",
      });
      return;
    }
    if (url.pathname === "/api/costs") {
      json(res, 200, { ok: true, perAgent: [], perDomain: [] });
      return;
    }
    if (url.pathname === "/api/guardrail-catalog") {
      json(res, 200, { ok: true, catalog: [] });
      return;
    }
    if (url.pathname === "/api/scratch-manifest") {
      state.scratchManifestRequests.push(url.searchParams.get("name"));
      if (state.holdScratchManifest) {
        state.heldScratchManifest = res;
        state.resolveScratchManifestStarted?.();
        res.on("close", () => {
          state.scratchManifestClosed = true;
        });
        return;
      }
      json(res, 200, { ok: true, pending: false, files: [] });
      return;
    }
    if (url.pathname === "/api/plato-chat" && req.method === "GET") {
      const user = bearerUser(req);
      if (
        (user === "bob" && state.holdBobChat)
        || user === state.holdPlatoChatUser
      ) {
        if (user === "bob" && state.holdBobChat) state.heldBobChat = res;
        else state.heldPlatoChat = res;
        state.resolvePlatoChatStarted?.();
        res.on("close", () => {
          state.platoChatClosed = true;
        });
        return;
      }
      json(res, 200, { ok: true, transcript: [] });
      return;
    }
    if (url.pathname === "/api/eval-dataset" && req.method === "GET") {
      state.datasetInfoRequests += 1;
      json(res, 200, {
        ok: true,
        dataset: null,
        scenarios: [],
        metrics: [],
        presets: [{ key: "generic", label: "Generic starter" }],
      });
      return;
    }
    if (url.pathname === "/api/eval-dataset-save" && req.method === "POST") {
      state.datasetSaveBodies.push(await readJsonBody(req));
      if (state.holdDatasetSave) {
        state.heldDatasetSave = res;
        state.resolveDatasetSaveStarted?.();
        res.on("close", () => {
          state.datasetSaveClosed = true;
        });
        return;
      }
      json(res, 200, { ok: true, count: 1 });
      return;
    }
    if (url.pathname === "/api/plato-chat-stream" && req.method === "POST") {
      if (state.streamMode === "unauthorized") {
        json(res, 401, { ok: false, error: "Not signed in." });
        return;
      }
      res.writeHead(200, {
        "cache-control": "no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      res.write(`event: chunk\ndata: ${JSON.stringify("first-user-reply")}\n\n`);
      state.resolveStreamStarted?.();
      if (state.streamMode === "hold") {
        state.heldStream = res;
        res.on("close", () => {
          state.streamClosed = true;
        });
        return;
      }
      res.end("event: done\ndata: {\"handoff\":false}\n\n");
      return;
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      res.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      });
      res.end(`Unknown static path: ${url.pathname}`);
      return;
    }
    json(res, 200, { ok: true });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    state,
  };
}

test("auth fixture contract enumerates the hosted module dependency graph", () => {
  assert.deepEqual(entryModules, ["/modules/app.mjs"]);
  for (const required of ["/modules/app.mjs", "/auth-client.mjs", "/auth-core.mjs",
    "/main-ui-build.mjs", "/modules/workspace-scope.mjs"]) {
    assert.ok(hostedModulePaths.includes(required), required);
  }
  for (const [path, source] of hostedStaticModules) {
    for (const dependency of relativeModulePaths(source, path)) {
      assert.ok(hostedStaticModules.has(dependency), `${path} imports ${dependency}`);
    }
  }
});

test("auth fixture serves hosted modules as JavaScript and rejects unknown static paths", async () => {
  const fixture = await startAuthFixture();

  try {
    for (const modulePath of hostedModulePaths) {
      const response = await fetch(`${fixture.baseUrl}${modulePath}`);
      assert.equal(response.status, 200, modulePath);
      assert.match(
        response.headers.get("content-type") || "",
        /^text\/javascript(?:;|$)/i,
        modulePath,
      );
    }

    const missing = await fetch(`${fixture.baseUrl}/missing-auth-module.mjs`);
    assert.equal(missing.status, 404);
    assert.match(
      missing.headers.get("content-type") || "",
      /^text\/plain(?:;|$)/i,
    );
    assert.match(await missing.text(), /unknown static path/i);
  } finally {
    await fixture.close();
  }
});

async function mockLogin(page, baseUrl, user) {
  await page.goto(baseUrl);
  await page.locator('.idptile[data-idp="okta"]').click();
  await page.locator(`.usertile[data-loginuser="${user}"]`).click();
  await page.waitForSelector("#tbprofile");
  await page.waitForSelector('.nav[data-shellnav="build"]');
}

async function openBuildDoor(page, door) {
  await page.locator('.nav[data-shellnav="build"]').click();
  await page.waitForSelector(`[data-door="${door}"]`);
  await page.locator(`[data-door="${door}"]`).click();
}

async function signOutThroughTopbar(page) {
  await page.locator("#tbprofile").click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#tbsignout").click();
  await page.waitForSelector("#cognitosignin, .idptile");
}

async function openDatasetUploader(page) {
  await page.locator('.nav[data-shellnav="fleet"]').click();
  await page.waitForSelector(".wsopenagent");
  await page.locator(".wsopenagent").click();
  await page.waitForSelector("#gestarter");
}

test("browser authentication and cross-user isolation behaviors", async (t) => {
  const fixture = await startAuthFixture();
  const browser = await chromium.launch({ headless: true });

  t.beforeEach(() => { fixture.state.meUnauthorized = false; });
  try {
    await t.test("Cognito hydration paints an accessible loading status before callback completion", async () => {
      fixture.state.authMode = "cognito";
      const page = await browser.newPage();
      await page.addInitScript(() => {
        let accessToken = null;
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: () => new Promise((resolve) => {
            window.__finishCognitoHydration = () => {
              accessToken = "cognito-access";
              resolve(true);
            };
          }),
          getAccessToken: () => accessToken,
          clearAuthentication: () => {
            accessToken = null;
          },
          signOut: () => {},
        };
      });

      await page.goto(fixture.baseUrl, { waitUntil: "commit" });
      const status = page.locator('[role="status"][aria-live="polite"]');
      await status.waitFor({ timeout: 3_000 });
      assert.match(await status.textContent(), /signing in|authenticating/i);
      await page.evaluate(() => window.__finishCognitoHydration());
      await page.waitForSelector("#tbprofile");
      await page.close();
    });

    await t.test("a Cognito /api/me 401 completes hydration with usable sign-in", async () => {
      fixture.state.meUnauthorized = true;
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: async () => true,
          getAccessToken: () => "cognito-access",
          clearAuthentication: () => {},
          signOut: () => {},
        };
      });

      await page.goto(fixture.baseUrl, {
        waitUntil: "load",
        timeout: 3_000,
      });
      await page.waitForSelector("#cognitosignin");
      assert.equal(await page.locator("#cognitosignin").isEnabled(), true);
      assert.equal(await page.locator("#tbprofile").count(), 0);
      fixture.state.meUnauthorized = false;
      await page.close();
    });

    await t.test("mock domain selection stays server-backed and reaches the Registry", async () => {
      fixture.state.authMode = "mock";
      fixture.state.registryMode = "local";
      fixture.state.registryRequests = [];
      fixture.state.sessionDomainRequests = [];
      const page = await browser.newPage();

      await mockLogin(page, fixture.baseUrl, "alice");
      await page.waitForSelector("#domainselect");
      await page.selectOption("#domainselect", "operations");
      await page.waitForFunction(() =>
        document.querySelector("#domainselect")?.value === "operations"
      );
      assert.deepEqual(fixture.state.sessionDomainRequests, [{
        mode: "mock",
        domain: "operations",
      }]);
      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForFunction(() => document.querySelector("#regbox")?.textContent && !document.querySelector("#regbox").textContent.includes("Loading…"));

      assert.deepEqual(fixture.state.registryRequests.at(-1), {
        authorization: "Bearer token-alice",
        activeDomain: "operations",
      });
      assert.doesNotMatch(await page.locator("#regbox").textContent(), /live AWS/i);
      await page.close();
    });

    await t.test("Cognito demo domain selection stays local and reaches the next Registry request", async () => {
      fixture.state.authMode = "cognito";
      fixture.state.cognitoProfile = profiles.cognitoAdmin;
      fixture.state.registryMode = "aws";
      fixture.state.registryRequests = [];
      fixture.state.sessionDomainRequests = [];
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: async () => true,
          getAccessToken: () => "cognito-access",
          clearAuthentication: () => {},
          signOut: () => {},
        };
      });

      await page.goto(fixture.baseUrl);
      await page.waitForSelector("#tbrole");
      await page.selectOption("#tbrole", "builder");
      await page.waitForSelector("#tbdomain");
      await page.waitForFunction(() =>
        document.querySelector("#tbdomain")?.value === "customer_support"
      );
      await page.selectOption("#tbdomain", "operations");
      await page.waitForFunction(() =>
        document.querySelector("#tbdomain")?.value === "operations"
      );
      assert.deepEqual(fixture.state.sessionDomainRequests, []);

      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#regbox")?.textContent && !document.querySelector("#regbox").textContent.includes("Loading…")
      );
      assert.deepEqual(fixture.state.registryRequests.at(-1), {
        authorization: "Bearer cognito-access",
        activeDomain: "operations",
      });
      await page.close();
    });

    await t.test("Cognito demo operators can return to Platform Admin without a session POST", async () => {
      fixture.state.authMode = "cognito";
      fixture.state.cognitoProfile = profiles.cognitoAdmin;
      fixture.state.registryMode = "aws";
      fixture.state.registryRequests = [];
      fixture.state.sessionDomainRequests = [];
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: async () => true,
          getAccessToken: () => "cognito-access",
          clearAuthentication: () => {},
          signOut: () => {},
        };
      });

      await page.goto(fixture.baseUrl);
      await page.waitForSelector("#tbrole");
      await page.selectOption("#tbrole", "builder");
      await page.waitForSelector("#tbdomain");
      await page.waitForFunction(() =>
        document.querySelector("#tbdomain")?.value === "customer_support"
      );
      await page.selectOption("#tbrole", "admin");
      await page.waitForFunction(() =>
        document.querySelector("#tbrole")?.value === "admin"
          && !document.querySelector("#tbdomain")
      );
      assert.deepEqual(fixture.state.sessionDomainRequests, []);

      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#regbox")?.textContent && !document.querySelector("#regbox").textContent.includes("Loading…")
      );
      assert.deepEqual(fixture.state.registryRequests.at(-1), {
        authorization: "Bearer cognito-access",
        activeDomain: null,
      });
      await page.close();
    });

    await t.test("Cognito Registry 503 renders AWS unavailable without a local fallback label", async () => {
      fixture.state.authMode = "cognito";
      fixture.state.cognitoProfile = profiles.cognitoAdmin;
      fixture.state.registryMode = "unavailable";
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: async () => true,
          getAccessToken: () => "cognito-access",
          clearAuthentication: () => {},
          signOut: () => {},
        };
      });

      await page.goto(fixture.baseUrl);
      await page.waitForSelector('.nav[data-shellnav="registry"]');
      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#regstore")?.textContent.includes(
          "Registry is unavailable. No local data was substituted.",
        )
      );

      const mainText = await page.locator("main").textContent();
      assert.match(
        mainText,
        /Registry is unavailable. No local data was substituted/i,
      );
      assert.doesNotMatch(mainText, /local file store/i);
      await page.close();
    });

    await t.test("Cognito Registry network rejection clears stale AWS entries", async () => {
      fixture.state.authMode = "cognito";
      fixture.state.cognitoProfile = profiles.cognitoAdmin;
      fixture.state.registryMode = "aws";
      fixture.state.registryEntries = [{
        id: "stale-registry-entry",
        name: "Stale Registry Entry",
        type: "Skill",
        domain: "shared",
        ownerTeam: "Platform team",
        governanceMode: "owned",
        defaultVersion: "1.0.0",
        resolved: { status: "APPROVED" },
        versions: [{ semver: "1.0.0", status: "APPROVED" }],
      }];
      const page = await browser.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.addInitScript(() => {
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: async () => true,
          getAccessToken: () => "cognito-access",
          clearAuthentication: () => {},
          signOut: () => {},
        };
      });

      await page.goto(fixture.baseUrl);
      await page.waitForSelector('.nav[data-shellnav="registry"]');
      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#regbox")?.textContent.includes(
          "Stale Registry Entry",
        )
      );

      fixture.state.registryMode = "reject";
      // The hosted reader coalesces successful inventory reads for five seconds.
      await page.waitForTimeout(5100);
      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#regstore")?.textContent.includes(
          "Registry is unavailable. No local data was substituted.",
        )
      );

      const mainText = await page.locator("main").textContent();
      assert.doesNotMatch(mainText, /Stale Registry Entry/i);
      assert.doesNotMatch(mainText, /local file store/i);
      assert.match(
        mainText,
        /Registry is unavailable. No local data was substituted/i,
      );
      fixture.state.registryEntries = [];
      assert.deepEqual(pageErrors, []);
      await page.close();
    });

    await t.test("mock Registry network rejection is not relabeled as live AWS", async () => {
      fixture.state.authMode = "mock";
      fixture.state.registryMode = "local";
      const page = await browser.newPage();
      page.on("pageerror", () => {});
      await mockLogin(page, fixture.baseUrl, "alice");

      fixture.state.registryMode = "reject";
      // The hosted reader coalesces successful inventory reads for five seconds.
      await page.waitForTimeout(5100);
      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForTimeout(200);

      const mainText = await page.locator("main").textContent();
      assert.doesNotMatch(mainText, /live AWS/i);
      assert.doesNotMatch(mainText, /AWS backend unavailable/i);
      assert.doesNotMatch(
        mainText,
        /Registry is unavailable. No local data was substituted/i,
      );
      await page.close();
    });

    await t.test("Cognito Registry source aws renders its inventory without local fallback", async () => {
      fixture.state.authMode = "cognito";
      fixture.state.cognitoProfile = profiles.cognitoAdmin;
      fixture.state.registryMode = "aws";
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: async () => true,
          getAccessToken: () => "cognito-access",
          clearAuthentication: () => {},
          signOut: () => {},
        };
      });

      await page.goto(fixture.baseUrl);
      await page.waitForSelector('.nav[data-shellnav="registry"]');
      await page.locator('.nav[data-shellnav="registry"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#regbox")?.textContent && !document.querySelector("#regbox").textContent.includes("Loading…")
      );

      const storeText = await page.locator("#regstore").textContent();
      assert.ok(fixture.state.registryRequests.length > 0);
      assert.doesNotMatch(storeText, /local file store/i);
      await page.close();
    });

    await t.test("mobile Registry keeps navigation usable and contains wide tables", async () => {
      fixture.state.authMode = "cognito";
      fixture.state.cognitoProfile = profiles.cognitoAdmin;
      fixture.state.registryMode = "aws";
      fixture.state.registryEntries = [
        {
          id: "blueprint/mobile:example",
          name: "Mobile Blueprint",
          type: "Blueprint",
          domain: "shared",
          ownerTeam: "Platform team",
          governanceMode: "owned",
          defaultVersion: "1.0.0",
          resolved: { status: "APPROVED" },
          versions: [{ semver: "1.0.0", status: "APPROVED" }],
        },
      ];
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.addInitScript(() => {
        window.__AUTH_TEST__ = {
          mode: "cognito",
          completeSignIn: async () => true,
          getAccessToken: () => "cognito-access",
          clearAuthentication: () => {},
          signOut: () => {},
        };
      });

      try {
        await page.goto(fixture.baseUrl);
        const registryControl = page.locator(
          '.nav[data-shellnav="registry"]',
        );
        await registryControl.waitFor({ state: "visible" });
        await registryControl.click();
        await page.waitForSelector('.regrow[data-regid="blueprint/mobile:example"]');

        const layout = await page.evaluate(() => {
          const rectangle = (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return {
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              width: rect.width,
            };
          };
          const documentElement = document.documentElement;
          const registryBox = document.querySelector("#regbox");
          return {
            bodyScrollWidth: document.body.scrollWidth,
            clientWidth: documentElement.clientWidth,
            documentScrollWidth: documentElement.scrollWidth,
            main: rectangle("#main"),
            registryBox: rectangle("#regbox"),
            registryBoxClientWidth: registryBox.clientWidth,
            registryBoxOverflowX: getComputedStyle(registryBox).overflowX,
            registryBoxScrollWidth: registryBox.scrollWidth,
            registryStore: rectangle("#regstore"),
            side: rectangle("#side"),
            table: rectangle("#regbox table"),
            topbar: rectangle("#topbar"),
            viewportWidth: window.innerWidth,
          };
        });
        const evidence = JSON.stringify(layout);

        assert.equal(layout.viewportWidth, 390, evidence);
        assert.equal(layout.clientWidth, 390, evidence);
        assert.ok(
          layout.documentScrollWidth <= layout.clientWidth,
          evidence,
        );
        assert.ok(layout.bodyScrollWidth <= layout.clientWidth, evidence);
        assert.ok(layout.topbar.bottom <= layout.side.top + 1, evidence);
        assert.ok(layout.side.bottom <= layout.main.top + 1, evidence);
        assert.ok(layout.main.left >= -1, evidence);
        assert.ok(layout.main.right <= layout.clientWidth + 1, evidence);
        assert.ok(layout.registryBox.left >= layout.main.left - 1, evidence);
        assert.ok(layout.registryBox.right <= layout.main.right + 1, evidence);
        assert.ok(layout.registryStore.right <= layout.main.right + 1, evidence);
        assert.match(layout.registryBoxOverflowX, /auto|scroll/);
        assert.ok(
          layout.registryBoxScrollWidth > layout.registryBoxClientWidth,
          evidence,
        );
        assert.ok(
          layout.table.width > layout.registryBoxClientWidth,
          evidence,
        );
      } finally {
        fixture.state.registryEntries = [];
        await page.close();
      }
    });

    await t.test("tablet Registry contains long IDs with intentional table scrolling", async () => {
      fixture.state.authMode = "cognito";
      fixture.state.cognitoProfile = profiles.cognitoAdmin;
      fixture.state.registryMode = "aws";
      const longId = [
        "blueprint",
        "shared",
        "customer-support",
        "production",
        "version-2026-08-22",
        "x".repeat(180),
      ].join("/");
      fixture.state.registryEntries = [
        {
          id: longId,
          name: "Long tablet containment blueprint",
          type: "Blueprint",
          domain: "shared",
          ownerTeam: "Platform team",
          governanceMode: "owned",
          defaultVersion: "1.0.0",
          resolved: { status: "APPROVED" },
          versions: [{ semver: "1.0.0", status: "APPROVED" }],
        },
      ];

      try {
        for (const width of [701, 768, 1024]) {
          const page = await browser.newPage({
            viewport: { width, height: 900 },
          });
          await page.addInitScript(() => {
            window.__AUTH_TEST__ = {
              mode: "cognito",
              completeSignIn: async () => true,
              getAccessToken: () => "cognito-access",
              clearAuthentication: () => {},
              signOut: () => {},
            };
          });

          try {
            await page.goto(fixture.baseUrl);
            const registryControl = page.locator(
              '.nav[data-shellnav="registry"]',
            );
            await registryControl.waitFor({ state: "visible" });
            await registryControl.click();
            await page.waitForFunction(
              (expectedId) => [...document.querySelectorAll(".regrow")]
                .some((row) => row.dataset.regid === expectedId),
              longId,
            );

            const layout = await page.evaluate(() => {
              const rectangle = (selector) => {
                const rect = document
                  .querySelector(selector)
                  .getBoundingClientRect();
                return {
                  bottom: rect.bottom,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  width: rect.width,
                };
              };
              const documentElement = document.documentElement;
              const registryBox = document.querySelector("#regbox");
              return {
                bodyScrollWidth: document.body.scrollWidth,
                clientWidth: documentElement.clientWidth,
                documentScrollWidth: documentElement.scrollWidth,
                main: rectangle("#main"),
                registryBox: rectangle("#regbox"),
                registryBoxClientWidth: registryBox.clientWidth,
                registryBoxOverflowX: getComputedStyle(registryBox).overflowX,
                registryBoxScrollWidth: registryBox.scrollWidth,
                side: rectangle("#side"),
                table: rectangle("#regbox table"),
                topbar: rectangle("#topbar"),
                viewportWidth: window.innerWidth,
              };
            });
            const evidence = JSON.stringify({ width, ...layout });

            assert.equal(layout.viewportWidth, width, evidence);
            assert.equal(layout.clientWidth, width, evidence);
            assert.ok(
              layout.documentScrollWidth <= layout.clientWidth,
              evidence,
            );
            assert.ok(layout.bodyScrollWidth <= layout.clientWidth, evidence);
            assert.ok(layout.topbar.bottom <= layout.main.top + 1, evidence);
            assert.ok(layout.side.right <= layout.main.left + 1, evidence);
            assert.ok(layout.main.right <= layout.clientWidth + 1, evidence);
            assert.ok(
              layout.registryBox.left >= layout.main.left - 1,
              evidence,
            );
            assert.ok(
              layout.registryBox.right <= layout.main.right + 1,
              evidence,
            );
            assert.match(layout.registryBoxOverflowX, /auto|scroll/);
            assert.ok(
              layout.registryBoxScrollWidth
                > layout.registryBoxClientWidth,
              evidence,
            );
            assert.ok(
              layout.table.width > layout.registryBoxClientWidth,
              evidence,
            );
          } finally {
            await page.close();
          }
        }
      } finally {
        fixture.state.registryEntries = [];
      }
    });

    await t.test("mock login remains first-click-wins across an IdP rerender", async () => {
      fixture.state.authMode = "mock";
      fixture.state.holdMockLogins = true;
      fixture.state.mockLoginRequests = [];
      fixture.state.heldMockLogins = [];
      fixture.state.mockLoginStarted = new Promise((resolve) => {
        fixture.state.resolveMockLoginStarted = resolve;
      });
      const errors = [];
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__unhandledRejections = [];
        window.addEventListener("unhandledrejection", (event) => {
          window.__unhandledRejections.push(String(event.reason));
        });
      });
      page.on("pageerror", (error) => errors.push(error.message));

      try {
        await page.goto(fixture.baseUrl);
        await page.locator('.idptile[data-idp="okta"]').click();
        await page.waitForSelector('.usertile[data-loginuser="alice"]');
        await page.locator('.usertile[data-loginuser="alice"]').click();
        await fixture.state.mockLoginStarted;
        await page.locator('.idptile[data-idp="entra"]').click();
        await page.waitForSelector('.idptile[data-idp="entra"].sel');
        const bobAriaDisabled = await page
          .locator('.usertile[data-loginuser="bob"]')
          .getAttribute("aria-disabled");
        await page.evaluate(() => {
          document.querySelector('.usertile[data-loginuser="bob"]').click();
        });
        await page.waitForTimeout(100);
        const heldAlice = fixture.state.heldMockLogins.find(
          ({ user }) => user === "alice",
        );
        assert.ok(heldAlice, "expected Alice login request");
        json(heldAlice.res, 200, profiles.alice);
        await page.waitForSelector("#tbprofile");
        await page.waitForTimeout(50);

        const session = await page.evaluate(() => {
          const raw = localStorage.getItem("console.session");
          return raw ? JSON.parse(raw) : null;
        });
        assert.deepEqual(
          {
            errors,
            unhandledRejections: await page.evaluate(
              () => window.__unhandledRejections,
            ),
            requests: fixture.state.mockLoginRequests,
            bobAriaDisabled,
            sessionUser: session?.user,
            signedInAsAlice: /Alice Chen/.test(
              await page.locator("#tbprofile").textContent(),
            ),
          },
          {
            errors: [],
            unhandledRejections: [],
            requests: [{ user: "alice", idp: "okta" }],
            bobAriaDisabled: "true",
            sessionUser: "alice",
            signedInAsAlice: true,
          },
        );
      } finally {
        fixture.state.holdMockLogins = false;
        for (const held of fixture.state.heldMockLogins) {
          if (!held.closed) held.res.destroy();
        }
        fixture.state.heldMockLogins = [];
        await page.close();
      }
    });

    await t.test("streaming 401 clears the session and renders a usable sign-in view", async () => {
      fixture.state.authMode = "mock";
      fixture.state.streamMode = "unauthorized";
      const page = await browser.newPage();
      await mockLogin(page, fixture.baseUrl, "alice");
      await openBuildDoor(page, "plato");
      await page.locator("#pmsg").fill("alice-unauthorized-message");
      await page.locator("#psend").click();
      await page.waitForSelector(".idptile");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("console.session")),
        null,
      );
      assert.doesNotMatch(
        await page.locator("main").textContent(),
        /alice-unauthorized-message/,
      );
      await page.close();
    });

    await t.test("logout during streaming aborts the SSE request and ignores late callbacks", async () => {
      fixture.state.streamMode = "hold";
      fixture.state.streamClosed = false;
      fixture.state.streamStarted = new Promise((resolve) => {
        fixture.state.resolveStreamStarted = resolve;
      });
      const page = await browser.newPage();
      await mockLogin(page, fixture.baseUrl, "alice");
      await openBuildDoor(page, "plato");
      await page.locator("#pmsg").fill("alice-stream-secret");
      await page.locator("#psend").click();
      await fixture.state.streamStarted;
      await signOutThroughTopbar(page);
      for (let attempt = 0; attempt < 50 && !fixture.state.streamClosed; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(fixture.state.streamClosed, true);
      fixture.state.heldStream?.end(
        'event: chunk\ndata: "late-secret"\n\nevent: done\ndata: {"handoff":false}\n\n',
      );
      await page.waitForTimeout(50);
      assert.doesNotMatch(
        await page.locator("main").textContent(),
        /alice-stream-secret|late-secret/,
      );
      await page.close();
    });

    await t.test("logout settles an in-flight normal request without a browser error", async () => {
      fixture.state.holdScratchManifest = true;
      fixture.state.scratchManifestClosed = false;
      fixture.state.scratchManifestStarted = new Promise((resolve) => {
        fixture.state.resolveScratchManifestStarted = resolve;
      });
      const errors = [];
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__unhandledRejections = [];
        window.addEventListener("unhandledrejection", (event) => {
          window.__unhandledRejections.push(String(event.reason));
        });
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await mockLogin(page, fixture.baseUrl, "alice");
      await openBuildDoor(page, "scratch");
      await page.locator("#scname").fill("alice-held-preview");
      await fixture.state.scratchManifestStarted;
      await signOutThroughTopbar(page);
      for (
        let attempt = 0;
        attempt < 50 && !fixture.state.scratchManifestClosed;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(fixture.state.scratchManifestClosed, true);
      await page.waitForTimeout(50);
      assert.deepEqual(errors, []);
      assert.deepEqual(
        await page.evaluate(() => window.__unhandledRejections),
        [],
      );
      fixture.state.holdScratchManifest = false;
      await page.close();
    });

    await t.test("logout settles a pending Plato chat load without stale state or rejection", async () => {
      fixture.state.holdPlatoChatUser = "alice";
      fixture.state.platoChatClosed = false;
      fixture.state.platoChatStarted = new Promise((resolve) => {
        fixture.state.resolvePlatoChatStarted = resolve;
      });
      const errors = [];
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__unhandledRejections = [];
        window.addEventListener("unhandledrejection", (event) => {
          window.__unhandledRejections.push(String(event.reason));
        });
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await mockLogin(page, fixture.baseUrl, "alice");
      await openBuildDoor(page, "plato");
      await fixture.state.platoChatStarted;
      await signOutThroughTopbar(page);
      for (
        let attempt = 0;
        attempt < 50 && !fixture.state.platoChatClosed;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(fixture.state.platoChatClosed, true);
      fixture.state.heldPlatoChat?.end(JSON.stringify({
        ok: true,
        transcript: [{ role: "assistant", text: "late-plato-secret" }],
      }));
      await page.waitForTimeout(50);
      assert.deepEqual(errors, []);
      assert.deepEqual(
        await page.evaluate(() => window.__unhandledRejections),
        [],
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("console.session")),
        null,
      );
      await page.waitForSelector(".idptile");
      assert.doesNotMatch(
        await page.locator("main").textContent(),
        /late-plato-secret/,
      );
      fixture.state.holdPlatoChatUser = null;
      await page.close();
    });

    await t.test("logout settles a pending dataset save without stale mutation or rejection", async () => {
      fixture.state.holdDatasetSave = true;
      fixture.state.datasetSaveClosed = false;
      fixture.state.datasetInfoRequests = 0;
      fixture.state.datasetSaveBodies = [];
      fixture.state.datasetSaveStarted = new Promise((resolve) => {
        fixture.state.resolveDatasetSaveStarted = resolve;
      });
      const errors = [];
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.__unhandledRejections = [];
        window.addEventListener("unhandledrejection", (event) => {
          window.__unhandledRejections.push(String(event.reason));
        });
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await mockLogin(page, fixture.baseUrl, "alice");
      await openDatasetUploader(page);
      const datasetReadsBeforeSave = fixture.state.datasetInfoRequests;
      const privateDataset = JSON.stringify({
        scenario_id: "alice-private-dataset",
        turns: [{ input: "alice secret dataset input" }],
        assertions: ["keeps tenant data isolated"],
      });
      await page.locator("#gepaste").fill(privateDataset);
      await page.locator("#gesavepaste").click();
      await fixture.state.datasetSaveStarted;
      assert.equal(fixture.state.datasetSaveBodies[0]?.text, privateDataset);
      await signOutThroughTopbar(page);
      for (
        let attempt = 0;
        attempt < 50 && !fixture.state.datasetSaveClosed;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(fixture.state.datasetSaveClosed, true);
      fixture.state.heldDatasetSave?.end(JSON.stringify({
        ok: true,
        count: 1,
      }));
      await page.waitForTimeout(50);
      assert.deepEqual(errors, []);
      assert.deepEqual(
        await page.evaluate(() => window.__unhandledRejections),
        [],
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem("console.session")),
        null,
      );
      assert.equal(fixture.state.datasetInfoRequests, datasetReadsBeforeSave);
      await page.waitForSelector(".idptile");
      assert.doesNotMatch(
        await page.locator("main").textContent(),
        /alice-private-dataset|alice secret dataset input|saving/i,
      );
      fixture.state.holdDatasetSave = false;
      await page.close();
    });

    await t.test("a second user receives fresh compose and chat state", async () => {
      fixture.state.streamMode = "complete";
      fixture.state.holdBobChat = false;
      fixture.state.scratchManifestRequests = [];
      const page = await browser.newPage();
      await mockLogin(page, fixture.baseUrl, "alice");
      await openBuildDoor(page, "plato");
      await page.locator("#pmsg").fill("alice-private-chat");
      await page.locator("#psend").click();
      await page.waitForFunction(() =>
        document.querySelector("#pchat")?.textContent.includes("first-user-reply"),
      );
      await page.locator("#doorback").click();
      await page.locator('[data-door="scratch"]').click();
      await page.locator("#scname").fill("alice-private-project");
      await page.waitForTimeout(100);
      await signOutThroughTopbar(page);
      await page.waitForTimeout(400);
      assert.deepEqual(fixture.state.scratchManifestRequests, []);
      assert.doesNotMatch(
        await page.locator("main").textContent(),
        /alice-private-project/,
      );

      await page.locator('.idptile[data-idp="okta"]').click();
      await page.locator('.usertile[data-loginuser="bob"]').click();
      await page.waitForSelector('.nav[data-shellnav="build"]');
      await page.locator('.nav[data-shellnav="build"]').click();
      await page.waitForSelector('[data-door="scratch"]', { timeout: 3_000 });
      await page.locator('[data-door="scratch"]').click();
      assert.equal(await page.locator("#scname").inputValue(), "");

      await page.locator("#doorback").click();
      fixture.state.holdBobChat = true;
      await page.locator('[data-door="plato"]').click();
      await page.locator("#pmsg").fill("bob-message");
      await page.locator("#psend").click();
      await page.waitForFunction(() =>
        document.querySelector("#pchat")?.textContent.includes("bob-message"),
      );
      assert.doesNotMatch(
        await page.locator("#pchat").textContent(),
        /alice-private-chat|alice-private-project/,
      );
      json(fixture.state.heldBobChat, 200, { ok: true, transcript: [] });
      await page.close();
    });
  } finally {
    await browser.close();
    fixture.state.heldStream?.destroy();
    fixture.state.heldBobChat?.destroy();
    fixture.state.heldPlatoChat?.destroy();
    fixture.state.heldScratchManifest?.destroy();
    fixture.state.heldDatasetSave?.destroy();
    for (const held of fixture.state.heldMockLogins) held.res.destroy();
    await fixture.close();
  }
});
