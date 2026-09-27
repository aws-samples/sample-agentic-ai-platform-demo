import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { capabilitiesForRole } from
  "../infra/serverless-platform/lambda/authz/capabilities.mjs";
import {
  createAwsCognitoAdapter,
  createPlaywrightBrowserAdapter,
  createPrivateArtifactDirectory,
  runHostedAcceptance,
} from "./hosted-control-plane-acceptance.mjs";
import * as hostedAcceptance from "./hosted-control-plane-acceptance.mjs";

const APPLICATION_URL = "https://example.cloudfront.net";
const ACCOUNT_ID = "111122223333";
const CLIENT_ID = "7exampleclientid123456789";
const REGION = "us-west-2";
const PLATFORM_STATE_TABLE_NAME = "AgenticPlatform-Web-PlatformState";
const STARTER_BUILDER_MODEL_ID =
  "bedrock-claude/anthropic.claude-haiku-4-5";
const USER_POOL_ID = "us-west-2_Example123";
const VERIFIER_RUN_ID = "123456789";
const VERIFIER_RUN_ATTEMPT = "2";
const ADMIN_USERNAME =
  `hosted-acceptance-admin-${VERIFIER_RUN_ID}-${VERIFIER_RUN_ATTEMPT}`;
const ISOLATION_USERNAME =
  `hosted-acceptance-isolation-${VERIFIER_RUN_ID}-${VERIFIER_RUN_ATTEMPT}`;
const ADMIN_PASSWORD = "Admin-Acceptance-1!secret";
const ISOLATION_PASSWORD = "Isolation-Acceptance-2!secret";
const ADMIN_ACCESS_TOKEN = "admin-access-token-secret";
const ADMIN_ID_TOKEN = "admin-id-token-secret";
const ISOLATION_ACCESS_TOKEN = "isolation-access-token-secret";
const ISOLATION_ID_TOKEN = "isolation-id-token-secret";
const REGISTRY_STORE = "AWS Agent Registry + AgentCore Gateway";
const REGISTRY_TYPES = [
  "Skill",
  "MCPServer",
  "A2AAgent",
  "Agent",
  "Model",
  "Blueprint",
];
const REGISTRY_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "DEPRECATED",
];
const TOOLS_GATEWAY_ID = "platform-tools-gw-example123";
const LLM_GATEWAY_ID = "agentic-demo-llm-gateway-example123";
const FIXTURE_REGISTRY_ID = "SharedReg12345";
const FIXTURE_RECORD_ID = "Rec123456789";
const BROKER_FUNCTION_ARN =
  `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
  + "function:AgenticPlatform-Web-HostedAcceptanceBroker";

const REGISTRY_ENTRIES = [
  {
    id: "blueprint-1",
    name: "Hosted Blueprint",
    type: "Blueprint",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      _aws: {
        registryId: FIXTURE_REGISTRY_ID,
        recordId: "Base12345678",
        awsStatus: "APPROVED",
      },
    }],
    _aws: { registryId: FIXTURE_REGISTRY_ID },
  },
  { id: "skill-1", name: "Hosted Skill", type: "Skill" },
  { id: "model-1", name: "Hosted Model", type: "Model" },
  { id: "mcp-1", name: "Hosted MCP Server", type: "MCPServer" },
];
const GATEWAY_REGISTRY_ENTRIES = REGISTRY_ENTRIES.map((entry) =>
  ["Model", "MCPServer"].includes(entry.type)
    ? {
        ...entry,
        _source: "gateway",
        _gateway: entry.type === "Model"
          ? LLM_GATEWAY_ID
          : TOOLS_GATEWAY_ID,
      }
    : entry
);
const GATEWAY_REPRESENTATIVE_ENTRIES = GATEWAY_REGISTRY_ENTRIES.map(
  ({ _gateway, _source, id, name, type }) => ({
    id,
    name,
    type,
    ...(_source === "gateway"
      ? { gateway: _gateway, source: "gateway" }
      : {}),
  }),
);
const GATEWAY_MODELS = [
  {
    id: "bedrock-mantle/example.model-v1",
    name: "Hosted Model",
    type: "Model",
    defaultVersion: "1.0.0",
    versions: [{
      semver: "1.0.0",
      content: {
        gatewayId: LLM_GATEWAY_ID,
        gatewayModelId: "bedrock-mantle/example.model-v1",
      },
    }],
  },
];
const GATEWAY_TARGETS = [
  {
    endpoint: "https://tools.example.test/mcp",
    gatewayIdentifier: TOOLS_GATEWAY_ID,
    name: "Hosted MCP",
    status: "READY",
    targetId: "target-1",
  },
];

const ACCEPTANCE_OWNERSHIP = hostedAcceptance.createAcceptanceOwnership({
  verifierRunId: VERIFIER_RUN_ID,
  verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
});
const REJECTION_VERIFIER_RUN_ID = "42839534186500667626";
const REJECTION_OWNERSHIP = hostedAcceptance.createAcceptanceOwnership({
  verifierRunId: REJECTION_VERIFIER_RUN_ID,
  verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
});
const TEMP_DOMAIN_REGISTRY_ID = "DomainReg1234";
const TEMP_DOMAIN_REGISTRY_ARN =
  `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
  + `registry/${TEMP_DOMAIN_REGISTRY_ID}`;
const TEMP_DOMAIN = {
  id: ACCEPTANCE_OWNERSHIP.domainId,
  name: ACCEPTANCE_OWNERSHIP.domainName,
  owner: `${ACCEPTANCE_OWNERSHIP.domainName} domain team`,
  ownerGroup: ACCEPTANCE_OWNERSHIP.ownerGroup,
  description: `${ACCEPTANCE_OWNERSHIP.domainName} domain agents.`,
  tokenBudget: null,
  registryId: TEMP_DOMAIN_REGISTRY_ID,
  registryArn: TEMP_DOMAIN_REGISTRY_ARN,
  status: "ACTIVE",
  createdBy: "example-subject",
  createdAt: "2026-08-23T00:00:00.000Z",
};
const TEMP_DOMAIN_PAYLOAD = {
  name: ACCEPTANCE_OWNERSHIP.domainName,
  owner: `${ACCEPTANCE_OWNERSHIP.domainName} domain team`,
  ownerGroup: ACCEPTANCE_OWNERSHIP.ownerGroup,
  tokenBudget: "",
  description: `${ACCEPTANCE_OWNERSHIP.domainName} domain agents.`,
};

function canonicalAdminMeBody(overrides = {}) {
  return {
    actor: TEMP_DOMAIN.createdBy,
    assumedRole: null,
    authenticatedRole: "admin",
    availableDemoDomains: [{
      id: TEMP_DOMAIN.id,
      name: TEMP_DOMAIN.name,
    }],
    availableDemoRoles: ["admin", "lead", "builder", "user"],
    canSwitchDemoRole: true,
    capabilities: [...capabilitiesForRole("admin")],
    demoRoleActive: false,
    domain: null,
    domains: ["platform", TEMP_DOMAIN.id],
    email: null,
    groups: [
      "platform-admin",
      "demo-operator",
      "domain-platform",
      TEMP_DOMAIN.ownerGroup,
    ],
    identityProvider: "cognito",
    name: "Hosted acceptance administrator",
    ok: true,
    role: "admin",
    user: TEMP_DOMAIN.createdBy,
    username: ADMIN_USERNAME,
    ...overrides,
  };
}

const TEMP_REGISTRY_FIXTURE = {
  entryId: ACCEPTANCE_OWNERSHIP.registryEntryId,
  name: ACCEPTANCE_OWNERSHIP.registryRecordName,
  recordArn:
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
    + `registry/${FIXTURE_REGISTRY_ID}/record/${FIXTURE_RECORD_ID}`,
  recordId: FIXTURE_RECORD_ID,
  registryId: FIXTURE_REGISTRY_ID,
  semver: ACCEPTANCE_OWNERSHIP.registryVersion,
  status: "PENDING_APPROVAL",
  type: "Blueprint",
};
const REJECTION_RECORD_ID = "Rej123456789";
const TEMP_REJECTION_REGISTRY_FIXTURE = {
  entryId: REJECTION_OWNERSHIP.registryEntryId,
  name: REJECTION_OWNERSHIP.registryRecordName,
  recordArn:
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
    + `registry/${FIXTURE_REGISTRY_ID}/record/${REJECTION_RECORD_ID}`,
  recordId: REJECTION_RECORD_ID,
  registryId: FIXTURE_REGISTRY_ID,
  semver: REJECTION_OWNERSHIP.registryVersion,
  status: "PENDING_APPROVAL",
  type: "Blueprint",
};
const TEMP_REGISTRY_DECISION_PAYLOAD = {
  id: ACCEPTANCE_OWNERSHIP.registryEntryId,
  semver: ACCEPTANCE_OWNERSHIP.registryVersion,
  decision: "approve",
  reason: "",
};
const TEMP_REGISTRY_REJECTION_PAYLOAD = {
  id: REJECTION_OWNERSHIP.registryEntryId,
  semver: REJECTION_OWNERSHIP.registryVersion,
  decision: "reject",
  reason: "Hosted acceptance rejection path.",
};
const TEMP_REGISTRY_DECISION_RESULT = {
  ok: true,
  version: {
    id: ACCEPTANCE_OWNERSHIP.registryEntryId,
    semver: ACCEPTANCE_OWNERSHIP.registryVersion,
    status: "APPROVED",
    statusReason: "Approved by platform administrator.",
    _aws: {
      registryId: FIXTURE_REGISTRY_ID,
      recordId: FIXTURE_RECORD_ID,
    },
  },
};
const TEMP_REGISTRY_REJECTION_RESULT = {
  ok: true,
  version: {
    id: REJECTION_OWNERSHIP.registryEntryId,
    semver: REJECTION_OWNERSHIP.registryVersion,
    status: "REJECTED",
    statusReason: TEMP_REGISTRY_REJECTION_PAYLOAD.reason,
    _aws: {
      registryId: FIXTURE_REGISTRY_ID,
      recordId: REJECTION_RECORD_ID,
    },
  },
};
const APPROVED_REGISTRY_FIXTURE = {
  ...TEMP_REGISTRY_FIXTURE,
  status: "APPROVED",
};
const REJECTED_REGISTRY_FIXTURE = {
  ...TEMP_REJECTION_REGISTRY_FIXTURE,
  status: "REJECTED",
};
const TEMP_BROWSER_INTERNAL_RESULT = {
  domain: TEMP_DOMAIN,
  mutations: {
    domain: {
      payload: TEMP_DOMAIN_PAYLOAD,
      requestId: ACCEPTANCE_OWNERSHIP.requestIds.domain,
      result: { ok: true, domain: TEMP_DOMAIN },
    },
    registry: {
      payload: TEMP_REGISTRY_DECISION_PAYLOAD,
      requestId: ACCEPTANCE_OWNERSHIP.requestIds.registry,
      result: TEMP_REGISTRY_DECISION_RESULT,
    },
    registryRejection: {
      payload: TEMP_REGISTRY_REJECTION_PAYLOAD,
      requestId: REJECTION_OWNERSHIP.requestIds.registry,
      result: TEMP_REGISTRY_REJECTION_RESULT,
    },
  },
};
const TEMP_BROWSER_RESULT = {
  domain: {
    createdBy: TEMP_DOMAIN.createdBy,
    id: TEMP_DOMAIN.id,
    name: TEMP_DOMAIN.name,
    ownerGroup: TEMP_DOMAIN.ownerGroup,
    registryArn: TEMP_DOMAIN.registryArn,
    registryId: TEMP_DOMAIN.registryId,
    status: TEMP_DOMAIN.status,
  },
  domainRequestId: ACCEPTANCE_OWNERSHIP.requestIds.domain,
  registry: {
    entryId: ACCEPTANCE_OWNERSHIP.registryEntryId,
    recordId: FIXTURE_RECORD_ID,
    registryId: FIXTURE_REGISTRY_ID,
    semver: ACCEPTANCE_OWNERSHIP.registryVersion,
    status: "APPROVED",
  },
  registryRequestId: ACCEPTANCE_OWNERSHIP.requestIds.registry,
  rejectedRegistry: {
    entryId: REJECTION_OWNERSHIP.registryEntryId,
    recordId: REJECTION_RECORD_ID,
    registryId: FIXTURE_REGISTRY_ID,
    semver: REJECTION_OWNERSHIP.registryVersion,
    status: "REJECTED",
  },
  rejectedRegistryRequestId: REJECTION_OWNERSHIP.requestIds.registry,
};

const BROWSER_SOURCE_ENVIRONMENT = Object.freeze({
  PATH: "/safe/bin",
  HOME: "/safe/home",
  TMPDIR: "/safe/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  DISPLAY: ":99",
  XDG_RUNTIME_DIR: "/safe/xdg-runtime",
  PLAYWRIGHT_BROWSERS_PATH: "/safe/playwright-browsers",
  AWS_ACCESS_KEY_ID: "sentinel-aws-access-key",
  AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret-key",
  AWS_SESSION_TOKEN: "sentinel-aws-session-token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "sentinel-actions-oidc-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test/sentinel",
  GITHUB_TOKEN: "sentinel-github-token",
  ARBITRARY_SECRET: "sentinel-arbitrary-secret",
});
const EXPECTED_BROWSER_ENVIRONMENT = Object.freeze({
  PATH: "/safe/bin",
  HOME: "/safe/home",
  TMPDIR: "/safe/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  DISPLAY: ":99",
  XDG_RUNTIME_DIR: "/safe/xdg-runtime",
  PLAYWRIGHT_BROWSERS_PATH: "/safe/playwright-browsers",
});

function jsonResponse(status, body) {
  return jsonTextResponse(status, body);
}

function jsonTextResponse(status, body, {
  contentType = "application/json; charset=utf-8",
} = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? contentType : null;
      },
    },
    async text() {
      return text;
    },
  };
}

async function startRegistryPage(rows, {
  gatewayBadges = false,
  hiddenBadge = false,
  hiddenGatewayId,
  hiddenRowId,
  hiddenTypeId,
  wideTable = false,
} = {}) {
  const rowMarkup = rows.map(
    ({ _gateway, _source, gateway, id, name, source, type }) => {
      const renderedGateway = gateway ?? _gateway;
      const renderedSource = source ?? _source;
      return `<tr class="regrow" data-regid="${id}"${
      id === hiddenRowId ? ' style="visibility:hidden"' : ""
    }>`
      + `<td>${name} <span>${id}</span></td>`
      + `<td><span class="chip type"${
        id === hiddenTypeId ? ' style="visibility:hidden"' : ""
      }>${type}</span></td>`
      + `<td>${
        gatewayBadges && renderedSource === "gateway"
          ? `<span class="chip gateway-source" title="Discovered from AgentCore Gateway: ${renderedGateway}"${
              id === hiddenGatewayId ? ' style="visibility:hidden"' : ""
            }>gateway</span>`
          : ""
      }</td>`
      + "</tr>"
    },
  ).join("");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            * { box-sizing: border-box; }
            body { margin: 0; }
            main { width: 100%; padding: 12px; }
            #regbox { max-width: 100%; overflow-x: auto; }
            table {
              width: 100%;
              ${wideTable ? "min-width: 900px;" : ""}
            }
          </style>
        </head>
        <body>
          <main id="main">
            <button class="nav" data-shellnav="registry">AI Registry</button>
            <div id="regstore">Registry backing store:
              <span class="chip"${
                hiddenBadge ? ' style="visibility:hidden"' : ""
              }>live AWS</span>
            </div>
            <div id="regbox"><table><tbody>${rowMarkup}</tbody></table></div>
          </main>
        </body>
      </html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    applicationUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startHostedConsolePage({
  approvalChangelog = "",
  hiddenRegistryDecisionControl,
  initialRegistryStatus = "IN_REVIEW",
  initialRejectionRegistryStatus = "IN_REVIEW",
  registryPrefixEntries = [],
  rejectionChangelog = "",
} = {}) {
  const publicDirectory = fileURLToPath(
    new URL("../console/public/", import.meta.url),
  );
  const files = new Map([
    ["/", {
      body: readFileSync(join(publicDirectory, "index.html")),
      contentType: "text/html; charset=utf-8",
    }],
    ["/index.html", {
      body: readFileSync(join(publicDirectory, "index.html")),
      contentType: "text/html; charset=utf-8",
    }],
    ["/auth-client.mjs", {
      body: readFileSync(join(publicDirectory, "auth-client.mjs")),
      contentType: "text/javascript; charset=utf-8",
    }],
    ["/auth-core.mjs", {
      body: readFileSync(join(publicDirectory, "auth-core.mjs")),
      contentType: "text/javascript; charset=utf-8",
    }],
    ["/demo-context.mjs", {
      body: readFileSync(join(publicDirectory, "demo-context.mjs")),
      contentType: "text/javascript; charset=utf-8",
    }],
    ["/demo-assist.mjs", {
      body: readFileSync(join(publicDirectory, "demo-assist.mjs")),
      contentType: "text/javascript; charset=utf-8",
    }],
    ["/hosted-persona.mjs", {
      body: readFileSync(join(publicDirectory, "hosted-persona.mjs")),
      contentType: "text/javascript; charset=utf-8",
    }],
  ]);
  let domain;
  let domainReads = 0;
  let registryReads = 0;
  let registryStatus = initialRegistryStatus;
  let rejectionRegistryStatus = initialRejectionRegistryStatus;
  const mutations = [];

  const readRequestBody = async (request) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    return JSON.parse(body);
  };
  const sendJson = (response, status, body) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(body));
  };
  const registryEntries = () => [
    ...registryPrefixEntries,
    ...GATEWAY_REGISTRY_ENTRIES,
    {
      id: TEMP_REGISTRY_FIXTURE.entryId,
      name: TEMP_REGISTRY_FIXTURE.name,
      type: TEMP_REGISTRY_FIXTURE.type,
      defaultVersion: null,
      versions: [{
        semver: TEMP_REGISTRY_FIXTURE.semver,
        status: registryStatus,
        changelog: approvalChangelog,
        createdBy: "hosted-acceptance",
        _aws: {
          awsStatus: registryStatus === "IN_REVIEW"
            ? "PENDING_APPROVAL"
            : registryStatus,
          recordId: TEMP_REGISTRY_FIXTURE.recordId,
          registryId: TEMP_REGISTRY_FIXTURE.registryId,
        },
      }],
      _source: "agentcore-registry",
      _aws: { registryId: TEMP_REGISTRY_FIXTURE.registryId },
    },
    {
      id: TEMP_REJECTION_REGISTRY_FIXTURE.entryId,
      name: TEMP_REJECTION_REGISTRY_FIXTURE.name,
      type: TEMP_REJECTION_REGISTRY_FIXTURE.type,
      defaultVersion: null,
      versions: [{
        semver: TEMP_REJECTION_REGISTRY_FIXTURE.semver,
        status: rejectionRegistryStatus,
        changelog: rejectionChangelog,
        createdBy: "hosted-acceptance",
        _aws: {
          awsStatus: rejectionRegistryStatus === "IN_REVIEW"
            ? "PENDING_APPROVAL"
            : rejectionRegistryStatus,
          recordId: TEMP_REJECTION_REGISTRY_FIXTURE.recordId,
          registryId: TEMP_REJECTION_REGISTRY_FIXTURE.registryId,
        },
      }],
      _source: "agentcore-registry",
      _aws: { registryId: TEMP_REJECTION_REGISTRY_FIXTURE.registryId },
    },
  ];

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/runtime-config.js") {
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(`window.__RUNTIME_CONFIG__=${JSON.stringify({
        apiBaseUrl: "/api",
        authMode: "cognito",
        cognito: {
          clientId: CLIENT_ID,
          domain: "https://auth.example.test",
          logoutUri: "https://console.example.test",
          redirectUri: "https://console.example.test",
          scopes: ["openid"],
        },
      })};`);
      return;
    }
    if (url.pathname.startsWith("/fonts/")) {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end("");
      return;
    }
    if (files.has(url.pathname)) {
      const file = files.get(url.pathname);
      response.writeHead(200, { "content-type": file.contentType });
      const hiddenDecisionSelector = hiddenRegistryDecisionControl === "approve"
        ? ".regapprove"
        : hiddenRegistryDecisionControl === "reject"
          ? ".regreject"
          : undefined;
      const body = hiddenDecisionSelector
        && file.contentType.startsWith("text/html")
        ? file.body.toString().replace(
          "</head>",
          `<style>${hiddenDecisionSelector}{display:none!important}</style>`
            + "</head>",
        )
        : file.body;
      response.end(body);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (
      request.headers.authorization !== `Bearer ${ADMIN_ACCESS_TOKEN}`
    ) {
      sendJson(response, 401, { ok: false, code: "UNAUTHORIZED" });
      return;
    }
    if (url.pathname === "/api/me") {
      sendJson(response, 200, canonicalAdminMeBody());
      return;
    }
    if (url.pathname === "/api/domains" && request.method === "GET") {
      domainReads += 1;
      sendJson(response, 200, {
        ok: true,
        domains: domain ? [domain] : [],
      });
      return;
    }
    if (
      url.pathname === "/api/domain-create"
      && request.method === "POST"
    ) {
      const payload = await readRequestBody(request);
      mutations.push({
        path: url.pathname,
        payload,
        requestId: request.headers["x-request-id"],
      });
      domain = structuredClone(TEMP_DOMAIN);
      sendJson(response, 200, { ok: true, domain });
      return;
    }
    if (url.pathname === "/api/registry" && request.method === "GET") {
      registryReads += 1;
      sendJson(response, 200, {
        entries: registryEntries(),
        ok: true,
        source: "aws",
        statuses: REGISTRY_STATUSES,
        store: REGISTRY_STORE,
        types: REGISTRY_TYPES,
      });
      return;
    }
    if (
      url.pathname === "/api/registry-decide"
      && request.method === "POST"
    ) {
      const payload = await readRequestBody(request);
      mutations.push({
        path: url.pathname,
        payload,
        requestId: request.headers["x-request-id"],
      });
      if (
        payload.id === TEMP_REGISTRY_FIXTURE.entryId
        && payload.decision === "approve"
      ) {
        registryStatus = "APPROVED";
        sendJson(response, 200, TEMP_REGISTRY_DECISION_RESULT);
        return;
      }
      if (
        payload.id === TEMP_REJECTION_REGISTRY_FIXTURE.entryId
        && payload.decision === "reject"
      ) {
        rejectionRegistryStatus = "REJECTED";
        sendJson(response, 200, TEMP_REGISTRY_REJECTION_RESULT);
        return;
      }
      sendJson(response, 400, { ok: false, code: "INVALID_DECISION" });
      return;
    }
    sendJson(response, 200, { ok: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    applicationUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    get domainReads() {
      return domainReads;
    },
    get mutations() {
      return structuredClone(mutations);
    },
    get registryReads() {
      return registryReads;
    },
  };
}

async function verifyRegistryPage(
  rows,
  representativeEntries,
  fixtureOptions,
) {
  const fixture = await startRegistryPage(rows, fixtureOptions);
  const artifactDirectory = mkdtempSync(
    join(tmpdir(), "hosted-acceptance-browser-test-"),
  );
  try {
    await createPlaywrightBrowserAdapter({ chromium }).verifyRegistry({
      applicationUrl: fixture.applicationUrl,
      artifactDirectory,
      representativeEntries,
      tokens: {
        accessToken: ADMIN_ACCESS_TOKEN,
        idToken: ADMIN_ID_TOKEN,
        expiresAt: Date.now() + 60_000,
      },
    });
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
    await fixture.close();
  }
}

function diagnosticText(value) {
  if (value === undefined) return "";
  const properties = value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).filter(([, entry]) =>
          typeof entry !== "function"
        ),
      )
    : value;
  return [
    value?.message,
    value?.stack,
    JSON.stringify(properties),
  ].filter((entry) => typeof entry === "string").join("\n");
}

function assertCredentialFree(value) {
  const diagnostic = diagnosticText(value);
  for (const secret of [
    ADMIN_PASSWORD,
    ISOLATION_PASSWORD,
    ADMIN_ACCESS_TOKEN,
    ADMIN_ID_TOKEN,
    ISOLATION_ACCESS_TOKEN,
    ISOLATION_ID_TOKEN,
  ]) {
    assert.equal(
      diagnostic.includes(secret),
      false,
      `diagnostic exposed credential ${secret}`,
    );
  }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

function immediateDeadlineTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeout(callback, timeoutMs) {
      const handle = { timeoutMs };
      scheduled.push(handle);
      queueMicrotask(callback);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  };
}

function controlledDeadlineTimers() {
  const handles = [];
  return {
    setTimeout(callback, timeoutMs) {
      const handle = { active: true, callback, timeoutMs };
      handles.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.active = false;
    },
    triggerNext() {
      const handle = handles.find((candidate) => candidate.active);
      assert.ok(handle, "Expected an active browser worker deadline.");
      handle.active = false;
      handle.callback();
      return handle.timeoutMs;
    },
  };
}

function createFakeBrowserWorkerSpawner(outcomes) {
  const records = [];
  const groupChecks = [];
  const groupKills = [];
  let active = 0;
  let maxActive = 0;

  function closeChild(child, code, signal) {
    if (child.closed) return;
    child.closed = true;
    active -= 1;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", code, signal));
  }

  const spawnProcess = (command, args, options) => {
    const outcome = outcomes[records.length] || outcomes.at(-1);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.closed = false;
    child.groupAlive = true;
    child.remainingGroupChecks =
      outcome.confirmationChecksBeforeAbsent ?? 0;
    child.pid = 40_000 + records.length;
    child.killSignals = [];
    child.unrefCount = 0;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const record = {
      args,
      child,
      command,
      input: "",
      options,
      outcome,
    };
    records.push(record);
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        record.input += chunk.toString();
        callback();
      },
      final(callback) {
        callback();
        if (outcome.type === "success") {
          queueMicrotask(() => {
            child.stdout.write(JSON.stringify({
              ok: true,
              ...(outcome.result === undefined
                ? {}
                : { result: outcome.result }),
            }));
            closeChild(child, 0, null);
          });
        } else if (outcome.type === "failure") {
          queueMicrotask(() => {
            child.stdout.write(JSON.stringify({
              cleanupCode: outcome.cleanupCode,
              code: "HOSTED_BROWSER_FAILED",
              ok: false,
            }));
            child.stderr.write(
              `${ADMIN_PASSWORD} ${ADMIN_ACCESS_TOKEN}`,
            );
            closeChild(child, 1, null);
          });
        }
      },
    });
    child.kill = (signal) => {
      child.killSignals.push(signal);
      if (outcome.type !== "termination-hang") {
        closeChild(child, null, signal);
      }
      return true;
    };
    child.unref = () => {
      child.unrefCount += 1;
    };
    return child;
  };

  const killProcess = (pid, signal) => {
    const record = records.find(({ child }) => child.pid === Math.abs(pid));
    if (signal === 0) {
      groupChecks.push({ pid, signal });
      if (
        record?.outcome.groupStaysAlive === true
        || record?.child.remainingGroupChecks > 0
      ) {
        if (record.child.remainingGroupChecks > 0) {
          record.child.remainingGroupChecks -= 1;
        }
        return;
      }
      if (!record?.child.groupAlive) {
        const error = new Error("process group absent");
        error.code = "ESRCH";
        throw error;
      }
      return;
    }
    groupKills.push({ pid, signal });
    if (record?.outcome.groupKillFails === true) {
      throw new Error("injected process-group kill failure");
    }
    if (record?.outcome.groupStaysAlive !== true && record) {
      record.child.groupAlive = false;
    }
    if (record?.outcome.type === "termination-hang") {
      if (!record.child.processExited) {
        record.child.processExited = true;
        active -= 1;
        queueMicrotask(() => record.child.emit("exit", null, signal));
      }
    } else if (record) {
      closeChild(record.child, null, signal);
    }
  };

  return {
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    groupChecks,
    groupKills,
    killProcess,
    records,
    spawnProcess,
  };
}

function createHarness({
  failAt,
  authResponse,
  browserResult = TEMP_BROWSER_RESULT,
  cleanupFailures = new Set(),
  gatewayModels = GATEWAY_MODELS,
  gatewayTargets = GATEWAY_TARGETS,
  gatewayBody,
  meBody,
  preBrowserRegistryStatuses = [],
  registryBody,
  registryEntries = GATEWAY_REGISTRY_ENTRIES,
} = {}) {
  const calls = [];
  let createCount = 0;
  let setPasswordCount = 0;
  let addGroupCount = 0;
  let authCount = 0;
  let artifactDirectory;
  let browserInvoked = false;
  let preBrowserRegistryReads = 0;

  function fail(stage) {
    if (failAt === stage) {
      throw new Error(
        `backend failed with ${ADMIN_PASSWORD} ${ADMIN_ACCESS_TOKEN}`,
      );
    }
  }

  const cognito = {
    async adminCreateUser(input) {
      createCount += 1;
      calls.push({ operation: "create", input });
      fail(`create-${createCount}`);
      return {};
    },
    async adminSetUserPassword(input) {
      setPasswordCount += 1;
      calls.push({ operation: "set-password", input });
      fail(`set-password-${setPasswordCount}`);
      return {};
    },
    async adminAddUserToGroup(input) {
      addGroupCount += 1;
      calls.push({ operation: "add-group", input });
      fail(`add-group-${addGroupCount}`);
      return {};
    },
    async adminInitiateAuth(input) {
      authCount += 1;
      calls.push({ operation: "authenticate", input });
      fail(`authenticate-${authCount}`);
      if (authCount === 1 && authResponse !== undefined) {
        return authResponse;
      }
      return {
        AuthenticationResult: {
          AccessToken: authCount === 1
            ? ADMIN_ACCESS_TOKEN
            : ISOLATION_ACCESS_TOKEN,
          IdToken: authCount === 1
            ? ADMIN_ID_TOKEN
            : ISOLATION_ID_TOKEN,
          ExpiresIn: 3600,
        },
      };
    },
    async adminDeleteUser(input) {
      calls.push({ operation: "delete", input });
      if (cleanupFailures.has(input.username)) {
        throw new Error(
          `cleanup failed with ${ISOLATION_PASSWORD} `
            + ISOLATION_ACCESS_TOKEN,
        );
      }
      return {};
    },
    isUserNotFound(error) {
      return error?.code === "USER_NOT_FOUND";
    },
  };

  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const authorization = options?.headers?.authorization;
    const token = authorization?.replace(/^Bearer /, "");
    const method = options?.method ?? "GET";
    const requestId = options?.headers?.["x-request-id"];
    const requestBody = options?.body === undefined
      ? undefined
      : JSON.parse(options.body);
    calls.push({
      operation: "fetch",
      path: parsed.pathname,
      authorization,
      method,
      requestId,
      requestBody,
    });
    const stage = parsed.pathname === "/api/me"
      ? "api-me"
      : parsed.pathname === "/api/ai-gateway"
        ? "api-gateway"
        : parsed.pathname === "/api/domains"
          ? "api-domains"
          : parsed.pathname === "/api/domain-create"
            ? token === ISOLATION_ACCESS_TOKEN
              ? "api-domain-isolation"
              : "api-domain-replay"
            : parsed.pathname === "/api/registry-decide"
              ? requestBody?.decision === "reject"
                ? "api-registry-reject-replay"
                : "api-registry-approve-replay"
              : token === ISOLATION_ACCESS_TOKEN
                ? "api-isolation"
                : browserInvoked
                  ? "api-registry-status"
                  : "api-registry";
    fail(stage);

    if (parsed.pathname === "/api/me") {
      return jsonResponse(200, meBody ?? canonicalAdminMeBody());
    }
    if (
      parsed.pathname === "/api/registry"
      && token === ISOLATION_ACCESS_TOKEN
    ) {
      return jsonResponse(403, {
        ok: false,
        code: "FORBIDDEN",
      });
    }
    if (parsed.pathname === "/api/registry") {
      const status = browserInvoked
        ? 200
        : preBrowserRegistryStatuses[preBrowserRegistryReads] ?? 200;
      if (!browserInvoked) preBrowserRegistryReads += 1;
      const entries = browserInvoked
        ? [
            ...registryEntries,
            {
              id: ACCEPTANCE_OWNERSHIP.registryEntryId,
              name: ACCEPTANCE_OWNERSHIP.registryDisplayName,
              type: "Blueprint",
              versions: [TEMP_REGISTRY_DECISION_RESULT.version],
              _source: "agentcore-registry",
              _aws: { registryId: FIXTURE_REGISTRY_ID },
            },
            {
              id: REJECTION_OWNERSHIP.registryEntryId,
              name: REJECTION_OWNERSHIP.registryDisplayName,
              type: "Blueprint",
              versions: [TEMP_REGISTRY_REJECTION_RESULT.version],
              _source: "agentcore-registry",
              _aws: { registryId: FIXTURE_REGISTRY_ID },
            },
          ]
        : registryEntries;
      return jsonResponse(status, registryBody ?? {
        entries,
        ok: true,
        source: "aws",
        statuses: REGISTRY_STATUSES,
        store: REGISTRY_STORE,
        types: REGISTRY_TYPES,
      });
    }
    if (parsed.pathname === "/api/ai-gateway") {
      return jsonResponse(200, gatewayBody ?? {
        llmGateway: {
          gatewayId: LLM_GATEWAY_ID,
          gatewayUrl: "https://models.example.test/inference/v1",
          modelCount: gatewayModels.length,
          name: "agentic-demo-llm-gateway",
        },
        ok: true,
        region: REGION,
        source: "aws",
        models: gatewayModels,
        toolsGateway: {
          gatewayId: TOOLS_GATEWAY_ID,
          gatewayUrl: "https://tools.example.test/mcp",
          name: "platform-tools-gw",
          targetCount: gatewayTargets.length,
          targets: gatewayTargets,
        },
      });
    }
    if (parsed.pathname === "/api/domains") {
      return jsonResponse(200, {
        ok: true,
        domains: [TEMP_DOMAIN],
      });
    }
    if (
      parsed.pathname === "/api/domain-create"
      && token === ISOLATION_ACCESS_TOKEN
    ) {
      return jsonResponse(403, {
        ok: false,
        code: "FORBIDDEN",
        message: "Platform administrator access is required.",
      });
    }
    if (parsed.pathname === "/api/domain-create") {
      return jsonResponse(200, { ok: true, domain: TEMP_DOMAIN });
    }
    if (parsed.pathname === "/api/registry-decide") {
      return jsonResponse(
        200,
        requestBody?.decision === "reject"
          ? TEMP_REGISTRY_REJECTION_RESULT
          : TEMP_REGISTRY_DECISION_RESULT,
      );
    }
    return jsonResponse(404, { ok: false });
  };

  const browser = {
    async verifyRegistry(input) {
      browserInvoked = true;
      calls.push({ operation: "browser", input });
      artifactDirectory = input.artifactDirectory;
      assert.equal(statSync(artifactDirectory).mode & 0o777, 0o700);
      writeFileSync(join(artifactDirectory, "acceptance.png"), "private");
      fail("browser");
      return structuredClone(browserResult);
    },
  };

  const resources = {
    async persistActorMapping(input) {
      calls.push({ operation: "actor-map", input });
      fail("actor-map");
      return { ok: true };
    },
    async recoverActorMapping(input) {
      calls.push({ operation: "actor-recover", input });
      fail("actor-recover");
      return TEMP_DOMAIN.createdBy;
    },
    async createRegistryFixture(input) {
      calls.push({ operation: "fixture-create", input });
      fail("fixture-create");
      return structuredClone(
        input.ownership.registryEntryId
            === REJECTION_OWNERSHIP.registryEntryId
          ? TEMP_REJECTION_REGISTRY_FIXTURE
          : TEMP_REGISTRY_FIXTURE,
      );
    },
    async recoverDomain(input) {
      calls.push({ operation: "domain-recover", input });
      fail("domain-recover");
      return structuredClone(TEMP_DOMAIN);
    },
    async recoverRegistryFixture(input) {
      calls.push({ operation: "fixture-recover", input });
      fail("fixture-recover");
      const fixture = structuredClone(
        input.ownership.registryEntryId
            === REJECTION_OWNERSHIP.registryEntryId
          ? TEMP_REJECTION_REGISTRY_FIXTURE
          : TEMP_REGISTRY_FIXTURE,
      );
      if (browserInvoked) {
        fixture.status = input.ownership.registryEntryId
            === REJECTION_OWNERSHIP.registryEntryId
          ? "REJECTED"
          : "APPROVED";
      }
      return fixture;
    },
    async cleanupExactResources(input) {
      calls.push({ operation: "resource-cleanup", input });
      if (cleanupFailures.has("resources")) {
        throw new Error(
          `resource cleanup failed ${ADMIN_ACCESS_TOKEN}`,
        );
      }
      return { ok: true };
    },
  };

  return {
    calls,
    cognito,
    browser,
    fetchImpl,
    resources,
    get artifactDirectory() {
      return artifactDirectory;
    },
    randomPassword(label) {
      return label === "administrator"
        ? ADMIN_PASSWORD
        : ISOLATION_PASSWORD;
    },
  };
}

async function execute(harness, overrides = {}) {
  return runHostedAcceptance({
    applicationUrl: APPLICATION_URL,
    clientId: CLIENT_ID,
    region: REGION,
    userPoolId: USER_POOL_ID,
    cognito: harness.cognito,
    browser: harness.browser,
    fetchImpl: harness.fetchImpl,
    resources: harness.resources,
    randomPassword: harness.randomPassword,
    verifierRunId: VERIFIER_RUN_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
    ...overrides,
  });
}

test("hosted acceptance proves admin APIs, end-user isolation, browser rendering, and cleanup", async () => {
  const harness = createHarness();

  const result = await execute(harness);

  assert.deepEqual(result, { ok: true });
  assertCredentialFree(result);

  const creates = harness.calls.filter(({ operation }) =>
    operation === "create"
  );
  assert.equal(creates.length, 2);
  assert.deepEqual(
    creates.map(({ input }) => input.username),
    [ADMIN_USERNAME, ISOLATION_USERNAME],
  );
  for (const { input } of creates) {
    assert.equal(input.userPoolId, USER_POOL_ID);
    assert.equal(input.messageAction, "SUPPRESS");
    assert.equal(Object.hasOwn(input, "password"), false);
    assert.deepEqual(
      input.userAttributes.map(({ name }) => name),
      ["name", "custom:managed_by"],
    );
    assert.equal(
      input.userAttributes[1].value,
      "agentic-ai-platform-demo",
    );
  }

  const passwords = harness.calls.filter(({ operation }) =>
    operation === "set-password"
  );
  assert.deepEqual(
    passwords.map(({ input }) => ({
      password: input.password,
      permanent: input.permanent,
    })),
    [
      { password: ADMIN_PASSWORD, permanent: true },
      { password: ISOLATION_PASSWORD, permanent: true },
    ],
  );
  assert.deepEqual(
    harness.calls
      .filter(({ operation }) => operation === "add-group")
      .map(({ input }) => input.groupName),
    ["platform-admin", "end-user"],
  );
  assert.deepEqual(
    harness.calls
      .filter(({ operation }) => operation === "authenticate")
      .map(({ input }) => input.authFlow),
    ["ADMIN_USER_PASSWORD_AUTH", "ADMIN_USER_PASSWORD_AUTH"],
  );

  const browserCallIndex = harness.calls.findIndex(
    ({ operation }) => operation === "browser",
  );
  assert.notEqual(browserCallIndex, -1);
  const authenticatedRegistryReads = harness.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call, index }) =>
      index < browserCallIndex
      && call.operation === "fetch"
      && call.path === "/api/registry"
      && call.authorization === `Bearer ${ADMIN_ACCESS_TOKEN}`
      && call.method === "GET"
    );
  assert.equal(
    authenticatedRegistryReads.length,
    6,
  );
  assert.deepEqual(
    authenticatedRegistryReads.map(({ index }) => index),
    Array.from(
      { length: 6 },
      (_, offset) => authenticatedRegistryReads[0].index + offset,
    ),
  );

  const browserCall = harness.calls.find(({ operation }) =>
    operation === "browser"
  );
  assert.ok(browserCall);
  assert.equal(browserCall.input.applicationUrl, APPLICATION_URL);
  assert.equal(browserCall.input.tokens.accessToken, ADMIN_ACCESS_TOKEN);
  assert.equal(browserCall.input.tokens.idToken, ADMIN_ID_TOKEN);
  assert.ok(browserCall.input.tokens.expiresAt > Date.now());
  assert.deepEqual(
    browserCall.input.representativeEntries.map(({ type }) => type),
    ["Blueprint", "Skill", "Model", "MCPServer"],
  );
  assert.deepEqual(
    browserCall.input.representativeEntries
      .filter(({ type }) => ["Model", "MCPServer"].includes(type))
      .map(({ gateway, source, type }) => ({ gateway, source, type })),
    [
      {
        gateway: LLM_GATEWAY_ID,
        source: "gateway",
        type: "Model",
      },
      {
        gateway: TOOLS_GATEWAY_ID,
        source: "gateway",
        type: "MCPServer",
      },
    ],
  );
  assert.deepEqual(browserCall.input.ownership, ACCEPTANCE_OWNERSHIP);
  assert.deepEqual(
    browserCall.input.rejectionOwnership,
    REJECTION_OWNERSHIP,
  );
  assert.deepEqual(
    browserCall.input.registryFixture,
    TEMP_REGISTRY_FIXTURE,
  );
  assert.deepEqual(
    browserCall.input.rejectionRegistryFixture,
    TEMP_REJECTION_REGISTRY_FIXTURE,
  );

  const fixtureCreates = harness.calls.filter(({ operation }) =>
    operation === "fixture-create"
  );
  assert.deepEqual(
    fixtureCreates.map(({ input }) => input),
    [
      {
        ownership: ACCEPTANCE_OWNERSHIP,
        registryId: FIXTURE_REGISTRY_ID,
      },
      {
        ownership: REJECTION_OWNERSHIP,
        registryId: FIXTURE_REGISTRY_ID,
      },
    ],
  );
  const actorMap = harness.calls.find(({ operation }) =>
    operation === "actor-map"
  );
  assert.deepEqual(actorMap.input, {
    actor: TEMP_DOMAIN.createdBy,
    ownership: ACCEPTANCE_OWNERSHIP,
  });
  assert.ok(
    harness.calls.indexOf(actorMap) < harness.calls.indexOf(fixtureCreates[0]),
    "the durable actor mapping must precede fixture and browser mutations",
  );

  const fetchCalls = harness.calls.filter(({ operation }) =>
    operation === "fetch"
  );
  assert.deepEqual(
    fetchCalls.map(({ path, authorization, method, requestId }) => [
      method,
      path,
      authorization,
      requestId,
    ]),
    [
      ["GET", "/api/me", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/registry", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/registry", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/registry", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/registry", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/registry", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/registry", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/ai-gateway", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/registry", `Bearer ${ISOLATION_ACCESS_TOKEN}`, undefined],
      ["GET", "/api/domains", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
      [
        "POST",
        "/api/domain-create",
        `Bearer ${ADMIN_ACCESS_TOKEN}`,
        ACCEPTANCE_OWNERSHIP.requestIds.domain,
      ],
      [
        "POST",
        "/api/domain-create",
        `Bearer ${ISOLATION_ACCESS_TOKEN}`,
        ACCEPTANCE_OWNERSHIP.requestIds.isolation,
      ],
      [
        "POST",
        "/api/registry-decide",
        `Bearer ${ADMIN_ACCESS_TOKEN}`,
        ACCEPTANCE_OWNERSHIP.requestIds.registry,
      ],
      [
        "POST",
        "/api/registry-decide",
        `Bearer ${ADMIN_ACCESS_TOKEN}`,
        REJECTION_OWNERSHIP.requestIds.registry,
      ],
      ["GET", "/api/registry", `Bearer ${ADMIN_ACCESS_TOKEN}`, undefined],
    ],
  );
  assert.deepEqual(fetchCalls[10].requestBody, TEMP_DOMAIN_PAYLOAD);
  assert.deepEqual(fetchCalls[11].requestBody, TEMP_DOMAIN_PAYLOAD);
  assert.deepEqual(
    fetchCalls[12].requestBody,
    TEMP_REGISTRY_DECISION_PAYLOAD,
  );
  assert.deepEqual(
    fetchCalls[13].requestBody,
    TEMP_REGISTRY_REJECTION_PAYLOAD,
  );

  const resourceCleanups = harness.calls.filter(({ operation }) =>
    operation === "resource-cleanup"
  );
  assert.deepEqual(
    resourceCleanups.map(({ input }) => input),
    [
      {
        actor: "example-subject",
        domain: undefined,
        ownership: REJECTION_OWNERSHIP,
        registryRecord: REJECTED_REGISTRY_FIXTURE,
        requestIds: [],
      },
      {
        actor: "example-subject",
        domain: TEMP_BROWSER_RESULT.domain,
        ownership: ACCEPTANCE_OWNERSHIP,
        registryRecord: APPROVED_REGISTRY_FIXTURE,
        requestIds: [
          {
            requestId: ACCEPTANCE_OWNERSHIP.requestIds.domain,
            route: "POST /api/domain-create",
          },
        ],
      },
    ],
  );

  const createdUsernames = creates.map(({ input }) => input.username).sort();
  const deletedUsernames = harness.calls
    .filter(({ operation }) => operation === "delete")
    .map(({ input }) => input.username)
    .sort();
  assert.deepEqual(deletedUsernames, createdUsernames);
  assert.equal(existsSync(harness.artifactDirectory), false);
});

test("post-browser Registry status failure injection preserves the reliability loop", async () => {
  const harness = createHarness({ failAt: "api-registry-status" });

  await assert.rejects(execute(harness), (error) => {
    assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
    assert.equal(error.stage, "api-registry-status");
    assertCredentialFree(error);
    return true;
  });

  const browserCallIndex = harness.calls.findIndex(
    ({ operation }) => operation === "browser",
  );
  assert.notEqual(browserCallIndex, -1);
  const registryCallIndexes = harness.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) =>
      call.operation === "fetch"
      && call.path === "/api/registry"
      && call.authorization === `Bearer ${ADMIN_ACCESS_TOKEN}`
      && call.method === "GET"
    )
    .map(({ index }) => index);
  assert.equal(registryCallIndexes.length, 7);
  assert.equal(
    registryCallIndexes.filter((index) => index < browserCallIndex).length,
    6,
  );
  assert.ok(registryCallIndexes[6] > browserCallIndex);
  assert.equal(
    harness.calls.filter(({ operation }) => operation === "delete").length,
    2,
  );
  assert.equal(existsSync(harness.artifactDirectory), false);
});

test("each pre-browser Registry HTTP failure aborts before browser and cleans up", async (t) => {
  for (let requestNumber = 1; requestNumber <= 6; requestNumber += 1) {
    await t.test(`request ${requestNumber}`, async () => {
      const preBrowserRegistryStatuses = Array(6).fill(200);
      preBrowserRegistryStatuses[requestNumber - 1] = 503;
      const harness = createHarness({ preBrowserRegistryStatuses });

      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assert.equal(error.stage, "api-registry");
        assertCredentialFree(error);
        return true;
      });

      assert.equal(
        harness.calls.filter(({ operation, path, authorization, method }) =>
          operation === "fetch"
          && path === "/api/registry"
          && authorization === `Bearer ${ADMIN_ACCESS_TOKEN}`
          && method === "GET"
        ).length,
        requestNumber,
      );
      assert.equal(
        harness.calls.filter(({ operation }) => operation === "browser").length,
        0,
      );
      const deletedUsernames = harness.calls
        .filter(({ operation }) => operation === "delete")
        .map(({ input }) => input.username)
        .sort();
      assert.deepEqual(
        deletedUsernames,
        [ADMIN_USERNAME, ISOLATION_USERNAME].sort(),
      );
      assert.equal(new Set(deletedUsernames).size, 2);
      assert.equal(
        harness.calls.filter(({ operation }) =>
          operation === "resource-cleanup"
        ).length,
        0,
      );
      assert.equal(harness.artifactDirectory, undefined);
    });
  }
});

test("pre-browser Registry reliability requests each use the interactive deadline", async () => {
  const harness = createHarness();
  const observed = [];

  await execute(harness, {
    operationTimeoutMs: 20_000,
    resourceOperationTimeoutMs: 150_000,
    async runWithDeadline(operation, options) {
      const before = harness.calls.length;
      const result = await operation(new AbortController().signal);
      observed.push({
        calls: harness.calls.slice(before),
        timeoutMs: options.timeoutMs,
      });
      return result;
    },
  });

  const browserCallIndex = harness.calls.findIndex(
    ({ operation }) => operation === "browser",
  );
  assert.notEqual(browserCallIndex, -1);
  const registryDeadlines = observed.filter(({ calls }) =>
    calls.some((call) => {
      const callIndex = harness.calls.indexOf(call);
      return callIndex >= 0
        && callIndex < browserCallIndex
        && call.operation === "fetch"
        && call.path === "/api/registry"
        && call.authorization === `Bearer ${ADMIN_ACCESS_TOKEN}`
        && call.method === "GET";
    })
  );
  assert.equal(registryDeadlines.length, 6);
  assert.deepEqual(
    registryDeadlines.map(({ timeoutMs }) => timeoutMs),
    Array(6).fill(20_000),
  );
  const registryCallIndexes = registryDeadlines.map(({ calls }) => {
    const registryCalls = calls.filter(({ operation, path, authorization }) =>
      operation === "fetch"
      && path === "/api/registry"
      && authorization === `Bearer ${ADMIN_ACCESS_TOKEN}`
    );
    assert.equal(registryCalls.length, 1);
    return harness.calls.indexOf(registryCalls[0]);
  });
  assert.deepEqual(
    registryCallIndexes,
    Array.from(
      { length: 6 },
      (_, offset) => registryCallIndexes[0] + offset,
    ),
  );
  assert.ok(registryCallIndexes.every((index) => index < browserCallIndex));
});

test("hosted acceptance gives broker resources a longer deadline without inflating interactive operations", async () => {
  const harness = createHarness();
  const observed = [];

  await execute(harness, {
    operationTimeoutMs: 20_000,
    resourceOperationTimeoutMs: 150_000,
    async runWithDeadline(operation, options) {
      const before = harness.calls.length;
      const result = await operation(new AbortController().signal);
      observed.push({
        operations: harness.calls
          .slice(before)
          .map(({ operation: name }) => name),
        timeoutMs: options.timeoutMs,
      });
      return result;
    },
  });

  const resourceOperations = new Set([
    "actor-map",
    "fixture-create",
    "fixture-recover",
    "domain-recover",
    "resource-cleanup",
  ]);
  const resourceDeadlines = observed.filter(({ operations }) =>
    operations.some((operation) => resourceOperations.has(operation))
  );
  assert.ok(resourceDeadlines.length >= 3);
  assert.deepEqual(
    new Set(resourceDeadlines.map(({ timeoutMs }) => timeoutMs)),
    new Set([150_000]),
  );

  const interactiveDeadlines = observed.filter(({ operations }) =>
    operations.length > 0
    && operations.every((operation) => !resourceOperations.has(operation))
  );
  assert.ok(interactiveDeadlines.length > 0);
  assert.deepEqual(
    new Set(interactiveDeadlines.map(({ timeoutMs }) => timeoutMs)),
    new Set([20_000]),
  );
  assert.ok(150_000 > 120_000);
});

test("apiRequest sends strict bounded JSON GET and POST requests without leaking payloads", async () => {
  const request = hostedAcceptance.apiRequest;
  assert.equal(typeof request, "function");
  if (typeof request !== "function") return;

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonTextResponse(200, { ok: true, value: "accepted" });
  };
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  const payload = { name: "Hosted Acceptance 123 2" };

  const getResult = await request({
    applicationUrl: APPLICATION_URL,
    fetchImpl,
    method: "GET",
    path: "/api/domains",
    token: ADMIN_ACCESS_TOKEN,
  });
  const postResult = await request({
    applicationUrl: APPLICATION_URL,
    body: payload,
    fetchImpl,
    method: "POST",
    path: "/api/domain-create",
    requestId,
    token: ADMIN_ACCESS_TOKEN,
  });

  assert.deepEqual(getResult.body, { ok: true, value: "accepted" });
  assert.deepEqual(postResult.body, { ok: true, value: "accepted" });
  assert.deepEqual(calls.map(({ options }) => options.method), ["GET", "POST"]);
  assert.equal(calls[0].options.body, undefined);
  assert.deepEqual(calls[0].options.headers, {
    accept: "application/json",
    authorization: `Bearer ${ADMIN_ACCESS_TOKEN}`,
  });
  assert.equal(calls[1].options.body, JSON.stringify(payload));
  assert.deepEqual(calls[1].options.headers, {
    accept: "application/json",
    authorization: `Bearer ${ADMIN_ACCESS_TOKEN}`,
    "content-type": "application/json",
    "x-request-id": requestId,
  });
  assertCredentialFree(getResult);
  assertCredentialFree(postResult);
});

test("apiRequest rejects invalid methods, IDs, content types, and oversized bodies with stable errors", async () => {
  const request = hostedAcceptance.apiRequest;
  assert.equal(typeof request, "function");
  if (typeof request !== "function") return;

  const cases = [
    {
      input: {
        method: "PATCH",
        fetchImpl: async () => jsonTextResponse(200, { ok: true }),
      },
    },
    {
      input: {
        method: "POST",
        requestId: "not-a-uuid",
        body: {},
        fetchImpl: async () => jsonTextResponse(200, { ok: true }),
      },
    },
    {
      input: {
        method: "GET",
        fetchImpl: async () =>
          jsonTextResponse(200, { ok: true }, { contentType: "text/plain" }),
      },
    },
    {
      input: {
        method: "GET",
        maxResponseBytes: 8,
        fetchImpl: async () =>
          jsonTextResponse(200, { secret: ADMIN_ACCESS_TOKEN }),
      },
    },
  ];

  for (const { input } of cases) {
    await assert.rejects(
      request({
        applicationUrl: APPLICATION_URL,
        path: "/api/test",
        token: ADMIN_ACCESS_TOKEN,
        ...input,
      }),
      (error) => {
        assert.equal(error.code, "HOSTED_API_REQUEST_INVALID");
        assert.equal(error.message, "Hosted API request failed.");
        assertCredentialFree(error);
        return true;
      },
    );
  }
});

test("acceptance ownership is deterministic, valid, and unique per run attempt", () => {
  const createOwnership = hostedAcceptance.createAcceptanceOwnership;
  assert.equal(typeof createOwnership, "function");
  if (typeof createOwnership !== "function") return;

  const first = createOwnership({
    verifierRunId: VERIFIER_RUN_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
  });
  const replay = createOwnership({
    verifierRunId: VERIFIER_RUN_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
  });
  const nextAttempt = createOwnership({
    verifierRunId: VERIFIER_RUN_ID,
    verifierRunAttempt: "3",
  });

  assert.deepEqual(first, replay);
  assert.notDeepEqual(first, nextAttempt);
  assert.equal(
    first.domainName,
    `Hosted Acceptance ${VERIFIER_RUN_ID} ${VERIFIER_RUN_ATTEMPT}`,
  );
  assert.equal(
    first.domainId,
    `hosted_acceptance_${VERIFIER_RUN_ID}_${VERIFIER_RUN_ATTEMPT}`,
  );
  assert.equal(
    first.ownerGroup,
    `domain-hosted-acceptance-${VERIFIER_RUN_ID}-${VERIFIER_RUN_ATTEMPT}`,
  );
  assert.equal(
    first.registryEntryId,
    `hosted-acceptance-${VERIFIER_RUN_ID}-${VERIFIER_RUN_ATTEMPT}`,
  );
  assert.equal(
    first.registryRecordName,
    `hosted_acceptance_${VERIFIER_RUN_ID}_${VERIFIER_RUN_ATTEMPT}`,
  );
  for (const requestId of Object.values(first.requestIds)) {
    assert.match(
      requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
});

test("Registry decisions use dedicated deterministic ownership and request IDs", () => {
  const createOwnerships =
    hostedAcceptance.createRegistryDecisionOwnerships;
  assert.equal(typeof createOwnerships, "function");
  if (typeof createOwnerships !== "function") return;

  const ownerships = createOwnerships({
    verifierRunId: VERIFIER_RUN_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
  });
  const replay = createOwnerships({
    verifierRunId: VERIFIER_RUN_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
  });

  assert.deepEqual(ownerships, replay);
  assert.deepEqual(ownerships, {
    approve: ACCEPTANCE_OWNERSHIP,
    reject: REJECTION_OWNERSHIP,
  });
  assert.notEqual(
    ownerships.approve.registryRecordName,
    ownerships.reject.registryRecordName,
  );
  assert.notEqual(
    ownerships.approve.requestIds.registry,
    ownerships.reject.requestIds.registry,
  );
});

test("hosted acceptance rejects unsafe verifier run identities before adapters", async () => {
  for (const [verifierRunId, verifierRunAttempt] of [
    ["", "1"],
    ["run-1", "1"],
    ["123", "0"],
    ["123", "1.5"],
    ["123456789012345678901", "1"],
  ]) {
    const harness = createHarness();
    await assert.rejects(
      execute(harness, { verifierRunId, verifierRunAttempt }),
      (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID");
        assertCredentialFree(error);
        return true;
      },
    );
    assert.deepEqual(harness.calls, []);
  }
});

test("external verifier cleanup is bounded, deterministic, and credential-free", async () => {
  const cleanup = hostedAcceptance.cleanupHostedVerifierUsers;
  assert.equal(typeof cleanup, "function");
  if (typeof cleanup !== "function") return;

  const attempts = [];
  const cognito = {
    async adminDeleteUser(input) {
      attempts.push(input.username);
      if (input.username === ADMIN_USERNAME && attempts.length < 3) {
        throw new Error(`transient ${ADMIN_PASSWORD} ${ADMIN_ACCESS_TOKEN}`);
      }
      if (input.username === ISOLATION_USERNAME) {
        const error = new Error("already absent");
        error.code = "USER_NOT_FOUND";
        throw error;
      }
    },
    isUserNotFound(error) {
      return error?.code === "USER_NOT_FOUND";
    },
  };

  const result = await cleanup({
    userPoolId: USER_POOL_ID,
    cognito,
    cleanupAttempts: 3,
    verifierRunId: VERIFIER_RUN_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
  });

  assert.deepEqual(attempts, [
    ADMIN_USERNAME,
    ADMIN_USERNAME,
    ADMIN_USERNAME,
    ISOLATION_USERNAME,
  ]);
  assert.deepEqual(result, {
    deletedUsernames: [ADMIN_USERNAME, ISOLATION_USERNAME],
    ok: true,
  });
  assertCredentialFree(result);
});

test("external verifier cleanup attempts both users and redacts exhausted failure", async () => {
  const cleanup = hostedAcceptance.cleanupHostedVerifierUsers;
  assert.equal(typeof cleanup, "function");
  if (typeof cleanup !== "function") return;

  const attempts = [];
  await assert.rejects(
    cleanup({
      userPoolId: USER_POOL_ID,
      cleanupAttempts: 2,
      verifierRunId: VERIFIER_RUN_ID,
      verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
      cognito: {
        async adminDeleteUser(input) {
          attempts.push(input.username);
          throw new Error(`${ADMIN_PASSWORD} ${ADMIN_ACCESS_TOKEN}`);
        },
        isUserNotFound() {
          return false;
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "HOSTED_ACCEPTANCE_CLEANUP_FAILED");
      assertCredentialFree(error);
      return true;
    },
  );
  assert.deepEqual(attempts, [
    ADMIN_USERNAME,
    ADMIN_USERNAME,
    ISOLATION_USERNAME,
    ISOLATION_USERNAME,
  ]);
});

test("hosted acceptance stack outputs are parsed without environment secrets", () => {
  const parseOutputs =
    hostedAcceptance.parseHostedAcceptanceStackOutputs;
  assert.equal(typeof parseOutputs, "function");
  if (typeof parseOutputs !== "function") return;

  assert.deepEqual(parseOutputs({
    controlPlaneOutputs: {
      "AgenticPlatform-ControlPlane": {
        SharedRegistryId: FIXTURE_REGISTRY_ID,
      },
    },
    webOutputs: {
      "AgenticPlatform-Web": {
        ApplicationUrl: APPLICATION_URL,
        HostedAcceptanceBrokerFunctionArn: BROKER_FUNCTION_ARN,
        PlatformStateTableName: PLATFORM_STATE_TABLE_NAME,
        StarterBuilderModelId: STARTER_BUILDER_MODEL_ID,
        UserPoolClientId: CLIENT_ID,
        UserPoolId: USER_POOL_ID,
      },
    },
  }), {
    applicationUrl: APPLICATION_URL,
    brokerFunctionArn: BROKER_FUNCTION_ARN,
    clientId: CLIENT_ID,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    starterBuilderModelId: STARTER_BUILDER_MODEL_ID,
    userPoolId: USER_POOL_ID,
  });

  for (const input of [
    {
      controlPlaneOutputs: {},
      webOutputs: {},
    },
    {
      controlPlaneOutputs: {
        One: { SharedRegistryId: FIXTURE_REGISTRY_ID },
        Two: { SharedRegistryId: "AnotherReg123" },
      },
      webOutputs: {
        Web: {
          ApplicationUrl: APPLICATION_URL,
          HostedAcceptanceBrokerFunctionArn: BROKER_FUNCTION_ARN,
          PlatformStateTableName: PLATFORM_STATE_TABLE_NAME,
          StarterBuilderModelId: STARTER_BUILDER_MODEL_ID,
          UserPoolClientId: CLIENT_ID,
          UserPoolId: USER_POOL_ID,
        },
      },
    },
    {
      controlPlaneOutputs: {
        Control: { SharedRegistryId: "bad registry id" },
      },
      webOutputs: {
        Web: {
          ApplicationUrl: "http://not-hosted.example.test",
          HostedAcceptanceBrokerFunctionArn: BROKER_FUNCTION_ARN,
          PlatformStateTableName: PLATFORM_STATE_TABLE_NAME,
          StarterBuilderModelId: STARTER_BUILDER_MODEL_ID,
          UserPoolClientId: CLIENT_ID,
          UserPoolId: USER_POOL_ID,
        },
      },
    },
  ]) {
    assert.throws(
      () => parseOutputs(input),
      (error) => {
        assert.equal(
          error.code,
          "HOSTED_ACCEPTANCE_CONFIGURATION_INVALID",
        );
        assertCredentialFree(error);
        return true;
      },
    );
  }
});

test("Lambda broker adapter invokes the exact private function for every resource operation", async () => {
  const createAdapter =
    hostedAcceptance.createAwsBrokerResourceAdapter;
  assert.equal(typeof createAdapter, "function");
  if (typeof createAdapter !== "function") return;

  const calls = [];
  const experienceFixture = {
    domainId: "operations",
    projectId: `hosted-project-${VERIFIER_RUN_ID}-${VERIFIER_RUN_ATTEMPT}`,
    agentId: `hosted-agent-${VERIFIER_RUN_ID}-${VERIFIER_RUN_ATTEMPT}`,
    deploymentId:
      `hosted-production-${VERIFIER_RUN_ID}-${VERIFIER_RUN_ATTEMPT}`,
  };
  const results = {
    persistActorMapping: { ok: true },
    recoverActorMapping: TEMP_DOMAIN.createdBy,
    createRegistryFixture: TEMP_REGISTRY_FIXTURE,
    recoverRegistryFixture: TEMP_REGISTRY_FIXTURE,
    recoverDomain: TEMP_DOMAIN,
    provisionExperienceFixture: experienceFixture,
    recoverExperienceFixture: experienceFixture,
    cleanupExperienceFixture: { ok: true },
    cleanupExactResources: { ok: true },
  };
  const adapter = createAdapter({
    accountId: ACCOUNT_ID,
    brokerFunctionArn: BROKER_FUNCTION_ARN,
    lambdaClient: {
      async send(command) {
        calls.push(command);
        const request = JSON.parse(
          Buffer.from(command.input.Payload).toString("utf8"),
        );
        return {
          StatusCode: 200,
          Payload: Buffer.from(JSON.stringify({
            ok: true,
            result: results[request.operation],
          })),
        };
      },
    },
    region: REGION,
  });
  const inputs = {
    persistActorMapping: {
      actor: TEMP_DOMAIN.createdBy,
      ownership: ACCEPTANCE_OWNERSHIP,
    },
    recoverActorMapping: { ownership: ACCEPTANCE_OWNERSHIP },
    createRegistryFixture: {
      ownership: ACCEPTANCE_OWNERSHIP,
      registryId: FIXTURE_REGISTRY_ID,
    },
    recoverRegistryFixture: {
      ownership: ACCEPTANCE_OWNERSHIP,
      registryId: FIXTURE_REGISTRY_ID,
    },
    recoverDomain: {
      actor: TEMP_DOMAIN.createdBy,
      ownership: ACCEPTANCE_OWNERSHIP,
    },
    provisionExperienceFixture: {
      actor: TEMP_DOMAIN.createdBy,
      domainId: "operations",
      ownership: ACCEPTANCE_OWNERSHIP,
    },
    recoverExperienceFixture: {
      actor: TEMP_DOMAIN.createdBy,
      domainId: "operations",
      ownership: ACCEPTANCE_OWNERSHIP,
    },
    cleanupExperienceFixture: {
      actor: TEMP_DOMAIN.createdBy,
      domainId: "operations",
      fixture: experienceFixture,
      ownership: ACCEPTANCE_OWNERSHIP,
    },
    cleanupExactResources: {
      actor: TEMP_DOMAIN.createdBy,
      domain: TEMP_DOMAIN,
      ownership: ACCEPTANCE_OWNERSHIP,
      registryRecord: TEMP_REGISTRY_FIXTURE,
      requestIds: [],
    },
  };

  for (const [operation, input] of Object.entries(inputs)) {
    assert.deepEqual(await adapter[operation](input), results[operation]);
  }
  assert.deepEqual(
    calls.map((command) => command.constructor.name),
    Array(calls.length).fill("InvokeCommand"),
  );
  assert.deepEqual(
    calls.map((command) => ({
      functionName: command.input.FunctionName,
      invocationType: command.input.InvocationType,
      logType: command.input.LogType,
      request: JSON.parse(
        Buffer.from(command.input.Payload).toString("utf8"),
      ),
    })),
    Object.entries(inputs).map(([operation, input]) => ({
      functionName: BROKER_FUNCTION_ARN,
      invocationType: "RequestResponse",
      logType: "None",
      request: { operation, input },
    })),
  );
});

test("Lambda broker adapter rejects malformed successful experience fixture results", async () => {
  const createAdapter =
    hostedAcceptance.createAwsBrokerResourceAdapter;
  const input = {
    actor: TEMP_DOMAIN.createdBy,
    domainId: "operations",
    ownership: ACCEPTANCE_OWNERSHIP,
  };
  for (const result of [
    null,
    {
      domainId: "operations",
      projectId: "incorrect-project",
      agentId: "incorrect-agent",
      deploymentId: "incorrect-deployment",
    },
  ]) {
    const adapter = createAdapter({
      accountId: ACCOUNT_ID,
      brokerFunctionArn: BROKER_FUNCTION_ARN,
      lambdaClient: {
        async send() {
          return {
            StatusCode: 200,
            Payload: Buffer.from(JSON.stringify({
              ok: true,
              result,
            })),
          };
        },
      },
      region: REGION,
    });
    await assert.rejects(
      adapter.provisionExperienceFixture(input),
      (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_CLEANUP_FAILED");
        assertCredentialFree(error);
        return true;
      },
    );
  }
});

test("Lambda broker adapter fails closed with bounded redacted errors", async () => {
  const secret = "must-not-escape-broker-payload";
  for (const response of [
    {
      FunctionError: "Unhandled",
      Payload: Buffer.from(JSON.stringify({
        errorMessage: secret,
      })),
      StatusCode: 200,
    },
    {
      Payload: Buffer.from(JSON.stringify({
        ok: false,
        code: secret,
        message: secret,
      })),
      StatusCode: 200,
    },
    {
      Payload: Buffer.alloc(16_385, "x"),
      StatusCode: 200,
    },
  ]) {
    const adapter =
      hostedAcceptance.createAwsBrokerResourceAdapter({
        accountId: ACCOUNT_ID,
        brokerFunctionArn: BROKER_FUNCTION_ARN,
        lambdaClient: { send: async () => response },
        region: REGION,
      });
    await assert.rejects(
      adapter.recoverActorMapping({
        ownership: ACCEPTANCE_OWNERSHIP,
      }),
      (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_CLEANUP_FAILED");
        assertCredentialFree(error);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
        return true;
      },
    );
  }
});

test("cleanup-only recovers exact resources before deleting verifier users", async () => {
  const cleanupRun =
    hostedAcceptance.cleanupHostedAcceptanceRun;
  assert.equal(typeof cleanupRun, "function");
  if (typeof cleanupRun !== "function") return;
  const calls = [];
  const resources = {
    async recoverActorMapping(input) {
      calls.push({ operation: "actor-recover", input });
      return TEMP_DOMAIN.createdBy;
    },
    async recoverRegistryFixture(input) {
      calls.push({ operation: "fixture-recover", input });
      return structuredClone(
        input.ownership.registryEntryId
            === REJECTION_OWNERSHIP.registryEntryId
          ? TEMP_REJECTION_REGISTRY_FIXTURE
          : TEMP_REGISTRY_FIXTURE,
      );
    },
    async recoverDomain(input) {
      calls.push({ operation: "domain-recover", input });
      return structuredClone(TEMP_DOMAIN);
    },
    async cleanupExactResources(input) {
      calls.push({ operation: "resource-cleanup", input });
      return { ok: true };
    },
  };
  const cognito = {
    async adminGetUser(input) {
      calls.push({ operation: "get-user", input });
      return {
        UserAttributes: [{
          Name: "sub",
          Value: TEMP_DOMAIN.createdBy,
        }],
      };
    },
    async adminDeleteUser(input) {
      calls.push({ operation: "delete-user", input });
    },
    isUserNotFound(error) {
      return error?.code === "USER_NOT_FOUND";
    },
  };

  const result = await cleanupRun({
    cognito,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    resources,
    userPoolId: USER_POOL_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
    verifierRunId: VERIFIER_RUN_ID,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    [
      "get-user",
      "actor-recover",
      "fixture-recover",
      "fixture-recover",
      "domain-recover",
      "resource-cleanup",
      "resource-cleanup",
      "delete-user",
      "delete-user",
    ],
  );
  assert.deepEqual(
    calls
      .filter(({ operation }) => operation === "resource-cleanup")
      .map(({ input }) => input),
    [
      {
        actor: TEMP_DOMAIN.createdBy,
        domain: undefined,
        ownership: REJECTION_OWNERSHIP,
        registryRecord: TEMP_REJECTION_REGISTRY_FIXTURE,
        requestIds: [],
      },
      {
        actor: TEMP_DOMAIN.createdBy,
        domain: TEMP_DOMAIN,
        ownership: ACCEPTANCE_OWNERSHIP,
        registryRecord: TEMP_REGISTRY_FIXTURE,
        requestIds: [
          {
            requestId: ACCEPTANCE_OWNERSHIP.requestIds.domain,
            route: "POST /api/domain-create",
          },
        ],
      },
    ],
  );
  assertCredentialFree(result);
});

test("cleanup-only uses the broker deadline only for resource recovery and deletion", async () => {
  const calls = [];
  const observed = [];
  const resources = {
    async recoverActorMapping() {
      calls.push("actor-recover");
      return TEMP_DOMAIN.createdBy;
    },
    async recoverRegistryFixture() {
      calls.push("fixture-recover");
      return structuredClone(TEMP_REGISTRY_FIXTURE);
    },
    async recoverDomain() {
      calls.push("domain-recover");
      return structuredClone(TEMP_DOMAIN);
    },
    async cleanupExactResources() {
      calls.push("resource-cleanup");
      return { ok: true };
    },
  };
  const cognito = {
    async adminGetUser() {
      calls.push("get-user");
      return {
        UserAttributes: [{
          Name: "sub",
          Value: TEMP_DOMAIN.createdBy,
        }],
      };
    },
    async adminDeleteUser() {
      calls.push("delete-user");
    },
    isUserNotFound() {
      return false;
    },
  };

  await hostedAcceptance.cleanupHostedAcceptanceRun({
    cognito,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    operationTimeoutMs: 20_000,
    resourceOperationTimeoutMs: 150_000,
    resources,
    async runWithDeadline(operation, options) {
      const before = calls.length;
      const result = await operation(new AbortController().signal);
      observed.push({
        operations: calls.slice(before),
        timeoutMs: options.timeoutMs,
      });
      return result;
    },
    userPoolId: USER_POOL_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
    verifierRunId: VERIFIER_RUN_ID,
  });

  const resourceNames = new Set([
    "actor-recover",
    "fixture-recover",
    "domain-recover",
    "resource-cleanup",
  ]);
  assert.deepEqual(
    new Set(observed
      .filter(({ operations }) =>
        operations.some((operation) => resourceNames.has(operation))
      )
      .map(({ timeoutMs }) => timeoutMs)),
    new Set([150_000]),
  );
  assert.deepEqual(
    new Set(observed
      .filter(({ operations }) =>
        operations.length > 0
        && operations.every((operation) => !resourceNames.has(operation))
      )
      .map(({ timeoutMs }) => timeoutMs)),
    new Set([20_000]),
  );
});

test("cleanup-only uses the exact actor mapping after browser death and resource loss", async () => {
  const calls = [];
  const resources = {
    async recoverActorMapping(input) {
      calls.push({ operation: "actor-recover", input });
      return TEMP_DOMAIN.createdBy;
    },
    async recoverRegistryFixture(input) {
      calls.push({ operation: "fixture-recover", input });
      return null;
    },
    async recoverDomain(input) {
      calls.push({ operation: "domain-recover", input });
      return null;
    },
    async cleanupExactResources(input) {
      calls.push({ operation: "resource-cleanup", input });
      return { ok: true };
    },
  };
  const cognito = {
    async adminGetUser() {
      const error = new Error("already absent");
      error.code = "USER_NOT_FOUND";
      throw error;
    },
    async adminDeleteUser() {
      const error = new Error("already absent");
      error.code = "USER_NOT_FOUND";
      throw error;
    },
    isUserNotFound(error) {
      return error?.code === "USER_NOT_FOUND";
    },
  };

  assert.deepEqual(
    await hostedAcceptance.cleanupHostedAcceptanceRun({
      cognito,
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      resources,
      userPoolId: USER_POOL_ID,
      verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
      verifierRunId: VERIFIER_RUN_ID,
    }),
    { ok: true },
  );
  assert.deepEqual(
    calls.find(({ operation }) => operation === "resource-cleanup").input,
    {
      actor: TEMP_DOMAIN.createdBy,
      domain: null,
      ownership: ACCEPTANCE_OWNERSHIP,
      registryRecord: null,
      requestIds: [
        {
          requestId: ACCEPTANCE_OWNERSHIP.requestIds.domain,
          route: "POST /api/domain-create",
        },
      ],
    },
  );
});

test("cleanup-only fails closed when actor mapping, Cognito, and domain are unavailable", async () => {
  let cleanupCalled = false;
  const absentUser = () => {
    const error = new Error("already absent");
    error.code = "USER_NOT_FOUND";
    throw error;
  };

  await assert.rejects(
    hostedAcceptance.cleanupHostedAcceptanceRun({
      fixtureRegistryId: FIXTURE_REGISTRY_ID,
      userPoolId: USER_POOL_ID,
      verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
      verifierRunId: VERIFIER_RUN_ID,
      cognito: {
        adminDeleteUser: absentUser,
        adminGetUser: absentUser,
        isUserNotFound(error) {
          return error?.code === "USER_NOT_FOUND";
        },
      },
      resources: {
        async recoverActorMapping() {
          return null;
        },
        async recoverRegistryFixture() {
          return null;
        },
        async recoverDomain() {
          return null;
        },
        async cleanupExactResources() {
          cleanupCalled = true;
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "HOSTED_ACCEPTANCE_CLEANUP_FAILED");
      assertCredentialFree(error);
      return true;
    },
  );
  assert.equal(cleanupCalled, false);
});

test("browser acceptance rejects a duplicate-name row with the wrong exact ID or type", async () => {
  const representativeEntries = [
    {
      id: "blueprints/shared:starter@1.0",
      name: "Shared Label",
      type: "Blueprint",
    },
    {
      id: "skills/shared:starter@1.0[data-x='decoy']",
      name: "Shared Label",
      type: "Skill",
    },
    {
      id: "models/provider:model@1.0",
      name: "Model Label",
      type: "Model",
    },
    {
      id: "mcp/tools:weather@1.0",
      name: "MCP Label",
      type: "MCPServer",
    },
  ];
  const renderedRows = [
    representativeEntries[0],
    {
      ...representativeEntries[1],
      type: "Model",
    },
    {
      id: "skills/decoy:starter@1.0",
      name: representativeEntries[1].name,
      type: representativeEntries[1].type,
    },
    representativeEntries[2],
    representativeEntries[3],
  ];

  await assert.rejects(
    verifyRegistryPage(renderedRows, representativeEntries),
    /exact Registry row identity and type were not visibly rendered/,
  );
});

test("browser acceptance matches punctuated Registry IDs without selector interpolation", async () => {
  const representativeEntries = [
    {
      id: "blueprints/shared:starter@1.0",
      name: "Shared Label",
      type: "Blueprint",
    },
    {
      id: "skills/shared:starter@1.0",
      name: "Shared Label",
      type: "Skill",
    },
    {
      id: "models/provider:model@1.0",
      name: "Model Label",
      type: "Model",
    },
    {
      id: "mcp/tools:weather@1.0",
      name: "MCP Label",
      type: "MCPServer",
    },
  ];

  await verifyRegistryPage(representativeEntries, representativeEntries);
});

test("browser acceptance permits wide Registry rows only inside the scroll container", async () => {
  const representativeEntries = [
    {
      id: "blueprints/shared:starter@1.0",
      name: "Blueprint Label",
      type: "Blueprint",
    },
    {
      id: "skills/shared:starter@1.0",
      name: "Skill Label",
      type: "Skill",
    },
    {
      id: "models/provider:model@1.0",
      name: "Model Label",
      type: "Model",
    },
    {
      id: "mcp/tools:weather@1.0",
      name: "MCP Label",
      type: "MCPServer",
    },
  ];

  await verifyRegistryPage(
    representativeEntries,
    representativeEntries,
    { wideTable: true },
  );
});

test("browser acceptance rejects a hidden live AWS badge", async () => {
  await assert.rejects(
    verifyRegistryPage(
      REGISTRY_ENTRIES,
      REGISTRY_ENTRIES,
      { hiddenBadge: true },
    ),
    /live AWS badge was not visibly rendered/,
  );
});

test("browser acceptance rejects gateway-backed rows without visible AgentCore Gateway source", async () => {
  await assert.rejects(
    verifyRegistryPage(
      GATEWAY_REGISTRY_ENTRIES,
      GATEWAY_REPRESENTATIVE_ENTRIES,
    ),
    /gateway-backed Registry row source was not visibly rendered/,
  );
});

test("browser acceptance accepts visibly gateway-backed Model and MCP rows", async () => {
  await verifyRegistryPage(
    GATEWAY_REGISTRY_ENTRIES,
    GATEWAY_REPRESENTATIVE_ENTRIES,
    { gatewayBadges: true },
  );
});

test("browser acceptance rejects hidden exact rows and type cells", async (t) => {
  for (const [name, fixtureOptions] of [
    ["hidden row", { hiddenRowId: REGISTRY_ENTRIES[1].id }],
    ["hidden type", { hiddenTypeId: REGISTRY_ENTRIES[1].id }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyRegistryPage(
          REGISTRY_ENTRIES,
          REGISTRY_ENTRIES,
          fixtureOptions,
        ),
        /exact Registry row identity and type were not visibly rendered/,
      );
    });
  }
});

test("malformed Cognito authentication responses fail closed and delete both users", async (t) => {
  for (const [name, authResponse] of [
    ["missing result", {}],
    ["missing access token", {
      AuthenticationResult: {
        IdToken: ADMIN_ID_TOKEN,
        ExpiresIn: 3600,
      },
    }],
    ["missing id token", {
      AuthenticationResult: {
        AccessToken: ADMIN_ACCESS_TOKEN,
        ExpiresIn: 3600,
      },
    }],
    ["non-positive expiry", {
      AuthenticationResult: {
        AccessToken: ADMIN_ACCESS_TOKEN,
        IdToken: ADMIN_ID_TOKEN,
        ExpiresIn: 0,
      },
    }],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness({ authResponse });
      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assertCredentialFree(error);
        return true;
      });
      assert.equal(
        harness.calls.filter(({ operation }) => operation === "delete").length,
        2,
      );
    });
  }
});

test("Registry acceptance rejects empty and duplicate record IDs", async (t) => {
  for (const [name, registryEntries] of [
    ["empty ID", REGISTRY_ENTRIES.map((entry, index) =>
      index === 1 ? { ...entry, id: "  " } : entry)],
    ["duplicate ID", REGISTRY_ENTRIES.map((entry, index) =>
      index === 1 ? { ...entry, id: REGISTRY_ENTRIES[0].id } : entry)],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness({ registryEntries });
      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assert.equal(error.stage, "api-registry");
        assertCredentialFree(error);
        return true;
      });
    });
  }
});

test("Registry acceptance requires the canonical live response contract", async (t) => {
  const canonical = {
    entries: REGISTRY_ENTRIES,
    ok: true,
    source: "aws",
    statuses: REGISTRY_STATUSES,
    store: REGISTRY_STORE,
    types: REGISTRY_TYPES,
  };
  for (const [name, registryBody] of [
    ["missing ok", { ...canonical, ok: undefined }],
    ["wrong ok", { ...canonical, ok: false }],
    ["fake AWS store", {
      ...canonical,
      store: "AWS local file cache fallback",
    }],
    ["wrong types", {
      ...canonical,
      types: REGISTRY_TYPES.filter((type) => type !== "Blueprint"),
    }],
    ["wrong statuses", {
      ...canonical,
      statuses: REGISTRY_STATUSES.filter(
        (status) => status !== "APPROVED",
      ),
    }],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness({ registryBody });
      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assert.equal(error.stage, "api-registry");
        assertCredentialFree(error);
        return true;
      });
    });
  }
});

test("administrator identity requires the canonical Cognito admin shape", async (t) => {
  const canonical = canonicalAdminMeBody();
  for (const [name, meBody] of [
    ["missing ok", { ...canonical, ok: undefined }],
    ["wrong identity provider", {
      ...canonical,
      identityProvider: "local",
    }],
    ["missing subject", { ...canonical, user: "" }],
    ["missing username", { ...canonical, username: " " }],
    ["missing name", { ...canonical, name: null }],
    ["missing admin group", { ...canonical, groups: ["end-user"] }],
    ["missing domain capability", {
      ...canonical,
      capabilities: ["manageRegistryEntries", "approveRegistryVersion"],
    }],
    ["missing Registry management capability", {
      ...canonical,
      capabilities: ["viewAllDomains", "approveRegistryVersion"],
    }],
    ["missing Registry approval capability", {
      ...canonical,
      capabilities: ["viewAllDomains", "manageRegistryEntries"],
    }],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness({ meBody });
      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assert.equal(error.stage, "api-me");
        assertCredentialFree(error);
        return true;
      });
    });
  }
});

test("AI Gateway acceptance rejects placeholder model and target objects", async (t) => {
  for (const [name, overrides] of [
    ["empty model", { gatewayModels: [{}] }],
    ["model without a UI identity", {
      gatewayModels: [{ id: "bedrock-mantle/example.model-v1" }],
    }],
    ["empty target", { gatewayTargets: [{}] }],
    ["target without an HTTPS endpoint", {
      gatewayTargets: [{
        name: "Hosted MCP",
        status: "READY",
        targetId: "target-1",
      }],
    }],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness(overrides);
      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assert.equal(error.stage, "api-gateway");
        assertCredentialFree(error);
        return true;
      });
    });
  }
});

test("AI Gateway acceptance requires canonical IDs and count consistency", async (t) => {
  const canonical = {
    llmGateway: {
      gatewayId: LLM_GATEWAY_ID,
      gatewayUrl: "https://models.example.test/inference/v1",
      modelCount: GATEWAY_MODELS.length,
      name: "agentic-demo-llm-gateway",
    },
    models: GATEWAY_MODELS,
    ok: true,
    region: REGION,
    source: "aws",
    toolsGateway: {
      gatewayId: TOOLS_GATEWAY_ID,
      gatewayUrl: "https://tools.example.test/mcp",
      name: "platform-tools-gw",
      targetCount: GATEWAY_TARGETS.length,
      targets: GATEWAY_TARGETS,
    },
  };
  const duplicateModels = [
    GATEWAY_MODELS[0],
    { ...GATEWAY_MODELS[0], id: ` ${GATEWAY_MODELS[0].id} ` },
  ];
  const duplicateTargets = [
    GATEWAY_TARGETS[0],
    { ...GATEWAY_TARGETS[0], targetId: " target-1 " },
  ];
  for (const [name, gatewayBody] of [
    ["missing ok", { ...canonical, ok: undefined }],
    ["wrong region", { ...canonical, region: "eu-west-1" }],
    ["missing LLM Gateway", { ...canonical, llmGateway: undefined }],
    ["same Gateway IDs", {
      ...canonical,
      llmGateway: {
        ...canonical.llmGateway,
        gatewayId: TOOLS_GATEWAY_ID,
      },
    }],
    ["wrong model count", {
      ...canonical,
      llmGateway: {
        ...canonical.llmGateway,
        modelCount: 2,
      },
    }],
    ["wrong target count", {
      ...canonical,
      toolsGateway: {
        ...canonical.toolsGateway,
        targetCount: 2,
      },
    }],
    ["duplicate normalized model IDs", {
      ...canonical,
      llmGateway: {
        ...canonical.llmGateway,
        modelCount: duplicateModels.length,
      },
      models: duplicateModels,
    }],
    ["duplicate normalized target IDs", {
      ...canonical,
      toolsGateway: {
        ...canonical.toolsGateway,
        targetCount: duplicateTargets.length,
        targets: duplicateTargets,
      },
    }],
    ["target belongs to another Gateway", {
      ...canonical,
      toolsGateway: {
        ...canonical.toolsGateway,
        targets: [{
          ...GATEWAY_TARGETS[0],
          gatewayIdentifier: LLM_GATEWAY_ID,
        }],
      },
    }],
    ["model belongs to another Gateway", {
      ...canonical,
      models: [{
        ...GATEWAY_MODELS[0],
        versions: [{
          ...GATEWAY_MODELS[0].versions[0],
          content: {
            ...GATEWAY_MODELS[0].versions[0].content,
            gatewayId: TOOLS_GATEWAY_ID,
          },
        }],
      }],
    }],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness({ gatewayBody });
      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assert.equal(error.stage, "api-gateway");
        assertCredentialFree(error);
        return true;
      });
    });
  }
});

test("every operational failure point attempts both verifier deletions and redacts credentials", async (t) => {
  for (const stage of [
    "create-1",
    "set-password-1",
    "add-group-1",
    "create-2",
    "set-password-2",
    "add-group-2",
    "authenticate-1",
    "authenticate-2",
    "api-me",
    "api-registry",
    "api-gateway",
    "api-isolation",
    "fixture-create",
    "browser",
    "api-domains",
    "api-domain-replay",
    "api-domain-isolation",
    "api-registry-approve-replay",
    "api-registry-reject-replay",
    "api-registry-status",
  ]) {
    await t.test(stage, async () => {
      const harness = createHarness({ failAt: stage });
      await assert.rejects(execute(harness), (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assertCredentialFree(error);
        return true;
      });
      assert.equal(
        harness.calls.filter(({ operation }) => operation === "delete").length,
        2,
      );
      if (harness.artifactDirectory) {
        assert.equal(existsSync(harness.artifactDirectory), false);
      }
    });
  }
});

test("partial fixture creation is recovered by exact name and cleaned", async () => {
  const harness = createHarness({ failAt: "fixture-create" });

  await assert.rejects(execute(harness), (error) => {
    assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
    assert.equal(error.stage, "fixture-create");
    assertCredentialFree(error);
    return true;
  });

  const recoveries = harness.calls.filter(({ operation }) =>
    operation === "fixture-recover"
  );
  assert.deepEqual(
    recoveries.map(({ input }) => input),
    [
      {
        ownership: ACCEPTANCE_OWNERSHIP,
        registryId: FIXTURE_REGISTRY_ID,
      },
      {
        ownership: REJECTION_OWNERSHIP,
        registryId: FIXTURE_REGISTRY_ID,
      },
    ],
  );
  const cleanups = harness.calls.filter(({ operation }) =>
    operation === "resource-cleanup"
  );
  assert.deepEqual(
    cleanups.map(({ input }) => input.registryRecord.recordId),
    [REJECTION_RECORD_ID, FIXTURE_RECORD_ID],
  );
});

test("browser failure recovers the deterministic domain before exact cleanup", async () => {
  const harness = createHarness({ failAt: "browser" });

  await assert.rejects(execute(harness), (error) => {
    assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
    assert.equal(error.stage, "browser");
    assertCredentialFree(error);
    return true;
  });

  const domainRead = harness.calls.find(({ operation, path }) =>
    operation === "fetch" && path === "/api/domains"
  );
  assert.ok(domainRead);
  assert.equal(
    harness.calls.some(({ operation }) => operation === "domain-recover"),
    false,
  );
  assert.deepEqual(
    harness.calls
      .filter(({ operation }) => operation === "fixture-recover")
      .map(({ input }) => input.ownership),
    [ACCEPTANCE_OWNERSHIP, REJECTION_OWNERSHIP],
  );
  const cleanup = harness.calls.find(({ operation, input }) =>
    operation === "resource-cleanup"
    && input.ownership.registryEntryId
      === ACCEPTANCE_OWNERSHIP.registryEntryId
  );
  assert.deepEqual(cleanup.input.domain, TEMP_DOMAIN);
  assert.deepEqual(cleanup.input.registryRecord, APPROVED_REGISTRY_FIXTURE);
});

test("verification failure keeps its stage when exact resource cleanup fails", async () => {
  const harness = createHarness({
    cleanupFailures: new Set(["resources"]),
    failAt: "api-registry-approve-replay",
  });

  await assert.rejects(
    execute(harness, { cleanupAttempts: 2 }),
    (error) => {
      assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
      assert.equal(error.stage, "api-registry-approve-replay");
      assert.equal(
        error.cleanupCode,
        "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      );
      assertCredentialFree(error);
      return true;
    },
  );
  assert.equal(
    harness.calls.filter(({ operation }) =>
      operation === "resource-cleanup"
    ).length,
    4,
  );
  assert.equal(
    harness.calls.filter(({ operation }) => operation === "delete").length,
    2,
  );
});

test("partial creation treats a missing second verifier as absent while deleting both usernames", async () => {
  const harness = createHarness({ failAt: "create-2" });
  const originalDelete = harness.cognito.adminDeleteUser;
  let deleteCount = 0;
  harness.cognito.adminDeleteUser = async (input) => {
    deleteCount += 1;
    if (deleteCount === 2) {
      const error = new Error("absent");
      error.code = "USER_NOT_FOUND";
      throw error;
    }
    return originalDelete(input);
  };

  await assert.rejects(execute(harness), (error) => {
    assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
    assertCredentialFree(error);
    return true;
  });
  assert.equal(deleteCount, 2);
});

test("cleanup failures still attempt both deletes and return only a stable redacted error", async () => {
  const harness = createHarness();
  const originalDelete = harness.cognito.adminDeleteUser;
  const attempted = [];
  harness.cognito.adminDeleteUser = async (input) => {
    attempted.push(input.username);
    await originalDelete(input);
    throw new Error(
      `cleanup exposed ${ADMIN_PASSWORD} ${ISOLATION_ACCESS_TOKEN}`,
    );
  };

  await assert.rejects(execute(harness, { cleanupAttempts: 2 }), (error) => {
    assert.equal(error.code, "HOSTED_ACCEPTANCE_CLEANUP_FAILED");
    assert.equal(error.stage, "cleanup");
    assertCredentialFree(error);
    return true;
  });
  assert.equal(attempted.length, 4);
  assert.deepEqual(
    [...new Set(attempted)].sort(),
    attempted.filter((username, index) =>
      attempted.indexOf(username) === index
    ).sort(),
  );
  for (const username of new Set(attempted)) {
    assert.equal(
      attempted.filter((candidate) => candidate === username).length,
      2,
    );
  }
});

test("final artifact cleanup failure still attempts both deletes and stays redacted", async () => {
  const harness = createHarness();
  let removalAttempts = 0;

  try {
    await assert.rejects(
      execute(harness, {
        cleanupAttempts: 2,
        removeArtifactDirectory() {
          removalAttempts += 1;
          throw new Error(
            `artifact cleanup exposed ${ADMIN_PASSWORD} ${ADMIN_ACCESS_TOKEN}`,
          );
        },
      }),
      (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_CLEANUP_FAILED");
        assertCredentialFree(error);
        return true;
      },
    );
    assert.equal(removalAttempts, 2);
    assert.equal(
      harness.calls.filter(({ operation }) => operation === "browser").length,
      1,
    );
    assert.equal(
      harness.calls.filter(({ operation }) => operation === "delete").length,
      2,
    );
  } finally {
    if (harness.artifactDirectory) {
      rmSync(harness.artifactDirectory, { recursive: true, force: true });
    }
  }
});

test("primary failure stage survives bounded cleanup failures without credentials", async () => {
  const harness = createHarness({ failAt: "browser" });
  let removalAttempts = 0;
  let deleteAttempts = 0;
  harness.cognito.adminDeleteUser = async () => {
    deleteAttempts += 1;
    throw new Error(
      `delete exposed ${ADMIN_PASSWORD} ${ISOLATION_ACCESS_TOKEN}`,
    );
  };

  try {
    await assert.rejects(
      execute(harness, {
        cleanupAttempts: 2,
        removeArtifactDirectory() {
          removalAttempts += 1;
          throw new Error(
            `remove exposed ${ISOLATION_PASSWORD} ${ADMIN_ID_TOKEN}`,
          );
        },
      }),
      (error) => {
        assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
        assert.equal(error.stage, "browser");
        assert.equal(
          error.cleanupCode,
          "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
        );
        assertCredentialFree(error);
        return true;
      },
    );
    assert.equal(removalAttempts, 2);
    assert.equal(deleteAttempts, 4);
  } finally {
    if (harness.artifactDirectory) {
      rmSync(harness.artifactDirectory, { recursive: true, force: true });
    }
  }
});

test("never-resolving API fetch is aborted by the injected deadline", async () => {
  const harness = createHarness();
  const timers = immediateDeadlineTimers();
  let aborted = false;
  const fetchImpl = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error(`fetch exposed ${ADMIN_ACCESS_TOKEN}`));
      }, { once: true });
    });

  await assert.rejects(
    execute(harness, {
      fetchImpl,
      operationTimeoutMs: 123,
      deadlineTimers: timers,
    }),
    (error) => {
      assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
      assert.equal(error.stage, "api-me");
      assertCredentialFree(error);
      return true;
    },
  );
  assert.equal(aborted, true);
  assert.equal(timers.scheduled[0]?.timeoutMs, 123);
  assert.deepEqual(timers.cleared, timers.scheduled);
});

test("Playwright browser operations use the injected bounded deadline", async () => {
  let deadlineCalls = 0;
  let launchOptions;
  const runWithDeadline = async (operation, options) => {
    deadlineCalls += 1;
    assert.equal(options.timeoutMs, 321);
    return operation();
  };
  const adapter = createPlaywrightBrowserAdapter({
    chromium: {
      async launch(options) {
        launchOptions = options;
        throw new Error(`launch exposed ${ADMIN_ACCESS_TOKEN}`);
      },
    },
    environment: BROWSER_SOURCE_ENVIRONMENT,
    operationTimeoutMs: 321,
    runWithDeadline,
  });

  await assert.rejects(
    adapter.verifyRegistry({
      applicationUrl: APPLICATION_URL,
      artifactDirectory: tmpdir(),
      representativeEntries: REGISTRY_ENTRIES,
      tokens: {
        accessToken: ADMIN_ACCESS_TOKEN,
        idToken: ADMIN_ID_TOKEN,
        expiresAt: Date.now() + 60_000,
      },
    }),
  );
  assert.ok(deadlineCalls > 0);
  assert.deepEqual(launchOptions, {
    env: EXPECTED_BROWSER_ENVIRONMENT,
    headless: true,
    timeout: 321,
  });
});

test("Playwright browser performs the hosted domain and Registry mutation journey", async () => {
  const fixture = await startHostedConsolePage();
  const artifactDirectory = mkdtempSync(
    join(tmpdir(), "hosted-acceptance-browser-journey-"),
  );
  try {
    const result = await createPlaywrightBrowserAdapter({
      chromium,
    }).verifyRegistry({
      applicationUrl: fixture.applicationUrl,
      artifactDirectory,
      ownership: ACCEPTANCE_OWNERSHIP,
      rejectionOwnership: REJECTION_OWNERSHIP,
      registryFixture: TEMP_REGISTRY_FIXTURE,
      rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
      representativeEntries: GATEWAY_REPRESENTATIVE_ENTRIES,
      tokens: {
        accessToken: ADMIN_ACCESS_TOKEN,
        idToken: ADMIN_ID_TOKEN,
        expiresAt: Date.now() + 60_000,
      },
    });

    assert.deepEqual(result, TEMP_BROWSER_RESULT);
    assert.deepEqual(fixture.mutations, [
      {
        path: "/api/domain-create",
        payload: TEMP_DOMAIN_PAYLOAD,
        requestId: ACCEPTANCE_OWNERSHIP.requestIds.domain,
      },
      {
        path: "/api/registry-decide",
        payload: TEMP_REGISTRY_DECISION_PAYLOAD,
        requestId: ACCEPTANCE_OWNERSHIP.requestIds.registry,
      },
      {
        path: "/api/registry-decide",
        payload: TEMP_REGISTRY_REJECTION_PAYLOAD,
        requestId: REJECTION_OWNERSHIP.requestIds.registry,
      },
    ]);
    assert.ok(fixture.domainReads >= 2);
    assert.ok(fixture.registryReads >= 2);
    assert.equal(
      existsSync(join(artifactDirectory, "registry-desktop.png")),
      true,
    );
    assert.equal(
      existsSync(join(artifactDirectory, "registry-mobile.png")),
      true,
    );
    assert.equal(
      existsSync(join(artifactDirectory, "gateway-desktop.png")),
      true,
    );
    assert.equal(
      existsSync(join(artifactDirectory, "gateway-mobile.png")),
      true,
    );
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
    await fixture.close();
  }
});

test("Playwright browser locates hosted Registry fixtures beyond the first page", async () => {
  const registryPrefixEntries = Array.from({ length: 55 }, (_, index) => ({
    id: `prefixed-blueprint-${String(index).padStart(2, "0")}`,
    name: `Prefixed Blueprint ${index}`,
    type: "Blueprint",
    defaultVersion: "1.0.0",
    versions: [{
      semver: "1.0.0",
      status: "APPROVED",
      content: {},
    }],
  }));
  const fixture = await startHostedConsolePage({
    registryPrefixEntries,
  });
  const artifactDirectory = mkdtempSync(
    join(tmpdir(), "hosted-acceptance-browser-pagination-"),
  );
  try {
    const result = await createPlaywrightBrowserAdapter({
      chromium,
      operationTimeoutMs: 5_000,
    }).verifyRegistry({
      applicationUrl: fixture.applicationUrl,
      artifactDirectory,
      ownership: ACCEPTANCE_OWNERSHIP,
      rejectionOwnership: REJECTION_OWNERSHIP,
      registryFixture: TEMP_REGISTRY_FIXTURE,
      rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
      representativeEntries: GATEWAY_REPRESENTATIVE_ENTRIES,
      tokens: {
        accessToken: ADMIN_ACCESS_TOKEN,
        idToken: ADMIN_ID_TOKEN,
        expiresAt: Date.now() + 60_000,
      },
    });

    assert.deepEqual(result, TEMP_BROWSER_RESULT);
    assert.deepEqual(
      fixture.mutations
        .filter(({ path }) => path === "/api/registry-decide")
        .map(({ payload }) => payload.id),
      [
        ACCEPTANCE_OWNERSHIP.registryEntryId,
        REJECTION_OWNERSHIP.registryEntryId,
      ],
    );
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
    await fixture.close();
  }
});

test("Playwright browser recovers an already-decided Registry action with the stable request ID", async () => {
  const fixture = await startHostedConsolePage({
    initialRegistryStatus: "APPROVED",
    initialRejectionRegistryStatus: "REJECTED",
  });
  const artifactDirectory = mkdtempSync(
    join(tmpdir(), "hosted-acceptance-browser-retry-"),
  );
  try {
    const result = await createPlaywrightBrowserAdapter({
      chromium,
      operationTimeoutMs: 1_000,
    }).verifyRegistry({
      applicationUrl: fixture.applicationUrl,
      artifactDirectory,
      ownership: ACCEPTANCE_OWNERSHIP,
      rejectionOwnership: REJECTION_OWNERSHIP,
      registryFixture: TEMP_REGISTRY_FIXTURE,
      rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
      representativeEntries: REGISTRY_ENTRIES,
      tokens: {
        accessToken: ADMIN_ACCESS_TOKEN,
        idToken: ADMIN_ID_TOKEN,
        expiresAt: Date.now() + 60_000,
      },
    });

    assert.deepEqual(result, TEMP_BROWSER_RESULT);
    assert.deepEqual(fixture.mutations, [
      {
        path: "/api/domain-create",
        payload: TEMP_DOMAIN_PAYLOAD,
        requestId: ACCEPTANCE_OWNERSHIP.requestIds.domain,
      },
      {
        path: "/api/registry-decide",
        payload: TEMP_REGISTRY_DECISION_PAYLOAD,
        requestId: ACCEPTANCE_OWNERSHIP.requestIds.registry,
      },
      {
        path: "/api/registry-decide",
        payload: TEMP_REGISTRY_REJECTION_PAYLOAD,
        requestId: REJECTION_OWNERSHIP.requestIds.registry,
      },
    ]);
    assert.ok(fixture.registryReads >= 2);
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
    await fixture.close();
  }
});

test("Playwright browser rejects a missing control for each fresh IN_REVIEW decision", async (t) => {
  for (const {
    decision,
    fixtureOptions,
    forbiddenEntryId,
  } of [
    {
      decision: "approve",
      fixtureOptions: {
        approvalChangelog: "Previously APPROVED by another workflow.",
        hiddenRegistryDecisionControl: "approve",
      },
      forbiddenEntryId: ACCEPTANCE_OWNERSHIP.registryEntryId,
    },
    {
      decision: "reject",
      fixtureOptions: {
        hiddenRegistryDecisionControl: "reject",
        rejectionChangelog: "Previously REJECTED by another workflow.",
      },
      forbiddenEntryId: REJECTION_OWNERSHIP.registryEntryId,
    },
  ]) {
    await t.test(decision, async () => {
      const fixture = await startHostedConsolePage(fixtureOptions);
      const artifactDirectory = mkdtempSync(
        join(
          tmpdir(),
          `hosted-acceptance-browser-missing-${decision}-`,
        ),
      );
      try {
        await assert.rejects(
          createPlaywrightBrowserAdapter({
            chromium,
            operationTimeoutMs: 1_000,
          }).verifyRegistry({
            applicationUrl: fixture.applicationUrl,
            artifactDirectory,
            ownership: ACCEPTANCE_OWNERSHIP,
            rejectionOwnership: REJECTION_OWNERSHIP,
            registryFixture: TEMP_REGISTRY_FIXTURE,
            rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
            representativeEntries: REGISTRY_ENTRIES,
            tokens: {
              accessToken: ADMIN_ACCESS_TOKEN,
              idToken: ADMIN_ID_TOKEN,
              expiresAt: Date.now() + 60_000,
            },
          }),
          /Hosted Registry decision control is unavailable/,
        );
        assert.equal(
          fixture.mutations.some(({ path, payload }) =>
            path === "/api/registry-decide"
            && payload.id === forbiddenEntryId
          ),
          false,
        );
      } finally {
        rmSync(artifactDirectory, { recursive: true, force: true });
        await fixture.close();
      }
    });
  }
});

test("Playwright browser close retries are bounded", async () => {
  let closeAttempts = 0;
  const adapter = createPlaywrightBrowserAdapter({
    chromium: {
      async launch() {
        return {
          async newContext() {
            throw new Error("browser operation failed");
          },
          async close() {
            closeAttempts += 1;
            if (closeAttempts === 1) {
              throw new Error(`close exposed ${ADMIN_ID_TOKEN}`);
            }
          },
        };
      },
    },
    cleanupAttempts: 2,
  });

  await assert.rejects(
    adapter.verifyRegistry({
      applicationUrl: APPLICATION_URL,
      artifactDirectory: tmpdir(),
      representativeEntries: REGISTRY_ENTRIES,
      tokens: {
        accessToken: ADMIN_ACCESS_TOKEN,
        idToken: ADMIN_ID_TOKEN,
        expiresAt: Date.now() + 60_000,
      },
    }),
    /browser operation failed/,
  );
  assert.equal(closeAttempts, 2);
});

test("primary browser failure retains its stage when browser cleanup is exhausted", async () => {
  const harness = createHarness();
  let closeAttempts = 0;
  const browser = createPlaywrightBrowserAdapter({
    chromium: {
      async launch() {
        return {
          async newContext() {
            throw new Error(`browser exposed ${ADMIN_ACCESS_TOKEN}`);
          },
          async close() {
            closeAttempts += 1;
            throw new Error(`close exposed ${ADMIN_ID_TOKEN}`);
          },
        };
      },
    },
    cleanupAttempts: 2,
  });

  await assert.rejects(
    execute(harness, { browser }),
    (error) => {
      assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
      assert.equal(error.stage, "browser");
      assert.equal(
        error.cleanupCode,
        "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      );
      assertCredentialFree(error);
      return true;
    },
  );
  assert.equal(closeAttempts, 2);
  assert.equal(
    harness.calls.filter(({ operation }) => operation === "delete").length,
    2,
  );
});

test("production browser worker receives credentials only through private stdin", async () => {
  const createProcessAdapter =
    hostedAcceptance.createPlaywrightBrowserProcessAdapter;
  assert.equal(typeof createProcessAdapter, "function");
  if (typeof createProcessAdapter !== "function") return;
  const processHarness = createFakeBrowserWorkerSpawner([
    { type: "success" },
  ]);
  const adapter = createProcessAdapter({
    environment: BROWSER_SOURCE_ENVIRONMENT,
    spawnProcess: processHarness.spawnProcess,
  });
  assert.equal(adapter.managesOwnDeadline, true);
  const input = {
    applicationUrl: APPLICATION_URL,
    artifactDirectory: tmpdir(),
    representativeEntries: REGISTRY_ENTRIES,
    tokens: {
      accessToken: ADMIN_ACCESS_TOKEN,
      idToken: ADMIN_ID_TOKEN,
      expiresAt: Date.now() + 60_000,
    },
  };

  await adapter.verifyRegistry(input);

  assert.equal(processHarness.records.length, 1);
  const [{ args, command, input: stdin, options }] =
    processHarness.records;
  const publicLaunchSurface = JSON.stringify({
    args,
    command,
    env: options.env,
  });
  assert.doesNotMatch(publicLaunchSurface, /admin-access-token-secret/);
  assert.doesNotMatch(publicLaunchSurface, /admin-id-token-secret/);
  assert.match(stdin, /admin-access-token-secret/);
  assert.match(stdin, /admin-id-token-secret/);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.detached, true);
  assert.deepEqual(options.env, EXPECTED_BROWSER_ENVIRONMENT);
  for (const secret of [
    "sentinel-aws-access-key",
    "sentinel-aws-secret-key",
    "sentinel-aws-session-token",
    "sentinel-actions-oidc-token",
    "oidc.example.test/sentinel",
    "sentinel-github-token",
    "sentinel-arbitrary-secret",
  ]) {
    assert.doesNotMatch(JSON.stringify(options.env), new RegExp(secret));
  }
  assert.equal(processHarness.active, 0);
});

test("production browser worker returns bounded mutation evidence through private stdout", async () => {
  const createProcessAdapter =
    hostedAcceptance.createPlaywrightBrowserProcessAdapter;
  assert.equal(typeof createProcessAdapter, "function");
  if (typeof createProcessAdapter !== "function") return;
  const processHarness = createFakeBrowserWorkerSpawner([
    { result: TEMP_BROWSER_RESULT, type: "success" },
  ]);
  const adapter = createProcessAdapter({
    environment: BROWSER_SOURCE_ENVIRONMENT,
    spawnProcess: processHarness.spawnProcess,
  });

  const result = await adapter.verifyRegistry({
    applicationUrl: APPLICATION_URL,
    artifactDirectory: tmpdir(),
    ownership: ACCEPTANCE_OWNERSHIP,
    rejectionOwnership: REJECTION_OWNERSHIP,
    registryFixture: TEMP_REGISTRY_FIXTURE,
    rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
    representativeEntries: REGISTRY_ENTRIES,
    tokens: {
      accessToken: ADMIN_ACCESS_TOKEN,
      idToken: ADMIN_ID_TOKEN,
      expiresAt: Date.now() + 60_000,
    },
  });

  assert.deepEqual(result, TEMP_BROWSER_RESULT);
  assertCredentialFree({
    args: processHarness.records[0].args,
    command: processHarness.records[0].command,
    environment: processHarness.records[0].options.env,
  });
});

test("browser evidence projection exposes only cleanup and verification identities", () => {
  const project = hostedAcceptance.projectBrowserWorkerEvidence;
  assert.equal(typeof project, "function");
  if (typeof project !== "function") return;
  const internal = structuredClone(TEMP_BROWSER_INTERNAL_RESULT);
  internal.domain.backendDebug = ADMIN_PASSWORD;
  internal.mutations.domain.payload.secret = ADMIN_ACCESS_TOKEN;
  internal.mutations.domain.result.trace = {
    token: ADMIN_ID_TOKEN,
  };
  internal.mutations.registry.result.version.statusReason =
    `Approved with ${ADMIN_PASSWORD}`;
  internal.arbitraryResponse = {
    authorization: `Bearer ${ADMIN_ACCESS_TOKEN}`,
  };

  const projected = project(internal);

  assert.deepEqual(projected, TEMP_BROWSER_RESULT);
  assertCredentialFree(projected);
  assert.doesNotMatch(
    JSON.stringify(projected),
    /payload|result|statusReason|backendDebug|arbitraryResponse|trace/,
  );
});

test("browser worker serializes only projected allowlisted evidence", () => {
  const source = readFileSync(
    new URL("./hosted-control-plane-browser-worker.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /projectBrowserWorkerEvidence/,
  );
  assert.match(
    source,
    /const rawResult = await browser\.verifyRegistry\(input\)/,
  );
  assert.match(
    source,
    /result = projectBrowserWorkerEvidence\(rawResult\)/,
  );
  assert.doesNotMatch(source, /console\.(?:log|error|warn)\(/);
});

test("browser process controller rejects extra worker evidence fields", async (t) => {
  for (const [name, result] of [
    [
      "root",
      {
        ...TEMP_BROWSER_RESULT,
        requestPayload: TEMP_DOMAIN_PAYLOAD,
      },
    ],
    [
      "nested",
      {
        ...TEMP_BROWSER_RESULT,
        domain: {
          ...TEMP_BROWSER_RESULT.domain,
          backendResponse: {
            authorization: `Bearer ${ADMIN_ACCESS_TOKEN}`,
          },
        },
      },
    ],
  ]) {
    await t.test(name, async () => {
      const processHarness = createFakeBrowserWorkerSpawner([
        { result, type: "success" },
      ]);
      const adapter =
        hostedAcceptance.createPlaywrightBrowserProcessAdapter({
          environment: BROWSER_SOURCE_ENVIRONMENT,
          spawnProcess: processHarness.spawnProcess,
        });

      await assert.rejects(
        adapter.verifyRegistry({
          applicationUrl: APPLICATION_URL,
          artifactDirectory: tmpdir(),
          ownership: ACCEPTANCE_OWNERSHIP,
          rejectionOwnership: REJECTION_OWNERSHIP,
          registryFixture: TEMP_REGISTRY_FIXTURE,
          rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
          representativeEntries: REGISTRY_ENTRIES,
          tokens: {
            accessToken: ADMIN_ACCESS_TOKEN,
            idToken: ADMIN_ID_TOKEN,
            expiresAt: Date.now() + 60_000,
          },
        }),
        (error) => {
          assert.equal(error.code, "HOSTED_BROWSER_FAILED");
          assertCredentialFree(error);
          return true;
        },
      );
    });
  }
});

test("browser worker retry reuses the same deterministic mutation request IDs", async () => {
  const processHarness = createFakeBrowserWorkerSpawner([
    {
      cleanupCode: "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      type: "failure",
    },
    {
      result: TEMP_BROWSER_RESULT,
      type: "success",
    },
  ]);
  const adapter = hostedAcceptance.createPlaywrightBrowserProcessAdapter({
    cleanupAttempts: 2,
    environment: BROWSER_SOURCE_ENVIRONMENT,
    killProcess: processHarness.killProcess,
    spawnProcess: processHarness.spawnProcess,
  });
  const input = {
    applicationUrl: APPLICATION_URL,
    artifactDirectory: tmpdir(),
    ownership: ACCEPTANCE_OWNERSHIP,
    rejectionOwnership: REJECTION_OWNERSHIP,
    registryFixture: TEMP_REGISTRY_FIXTURE,
    rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
    representativeEntries: REGISTRY_ENTRIES,
    tokens: {
      accessToken: ADMIN_ACCESS_TOKEN,
      idToken: ADMIN_ID_TOKEN,
      expiresAt: Date.now() + 60_000,
    },
  };

  assert.deepEqual(await adapter.verifyRegistry(input), TEMP_BROWSER_RESULT);
  assert.equal(processHarness.records.length, 2);
  assert.deepEqual(processHarness.groupKills, [{
    pid: -processHarness.records[0].child.pid,
    signal: "SIGKILL",
  }]);
  assert.deepEqual(processHarness.groupChecks, [{
    pid: -processHarness.records[0].child.pid,
    signal: 0,
  }]);
  assert.deepEqual(
    processHarness.records.map(({ input: stdin }) => {
      const parsed = JSON.parse(stdin);
      return {
        ownership: parsed.ownership,
        rejectionOwnership: parsed.rejectionOwnership,
        registryFixture: parsed.registryFixture,
        rejectionRegistryFixture: parsed.rejectionRegistryFixture,
      };
    }),
    [
      {
        ownership: ACCEPTANCE_OWNERSHIP,
        rejectionOwnership: REJECTION_OWNERSHIP,
        registryFixture: TEMP_REGISTRY_FIXTURE,
        rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
      },
      {
        ownership: ACCEPTANCE_OWNERSHIP,
        rejectionOwnership: REJECTION_OWNERSHIP,
        registryFixture: TEMP_REGISTRY_FIXTURE,
        rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
      },
    ],
  );
});

test("browser cleanup retry waits for confirmed process-group absence", async () => {
  const timers = controlledDeadlineTimers();
  const processHarness = createFakeBrowserWorkerSpawner([
    {
      cleanupCode: "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      confirmationChecksBeforeAbsent: 1,
      type: "failure",
    },
    {
      result: TEMP_BROWSER_RESULT,
      type: "success",
    },
  ]);
  const adapter = hostedAcceptance.createPlaywrightBrowserProcessAdapter({
    cleanupAttempts: 2,
    deadlineTimers: timers,
    environment: BROWSER_SOURCE_ENVIRONMENT,
    killProcess: processHarness.killProcess,
    processTerminationTimeoutMs: 45,
    spawnProcess: processHarness.spawnProcess,
  });
  const verification = adapter.verifyRegistry({
    applicationUrl: APPLICATION_URL,
    artifactDirectory: tmpdir(),
    ownership: ACCEPTANCE_OWNERSHIP,
    rejectionOwnership: REJECTION_OWNERSHIP,
    registryFixture: TEMP_REGISTRY_FIXTURE,
    rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
    representativeEntries: REGISTRY_ENTRIES,
    tokens: {
      accessToken: ADMIN_ACCESS_TOKEN,
      idToken: ADMIN_ID_TOKEN,
      expiresAt: Date.now() + 60_000,
    },
  });

  await waitFor(
    () => processHarness.groupChecks.length === 1,
    "Expected an initial process-group absence check.",
  );
  assert.equal(
    processHarness.records.length,
    1,
    "retry must wait while the process group can still be signalled",
  );
  assert.equal(timers.triggerNext(), 45);
  assert.deepEqual(await verification, TEMP_BROWSER_RESULT);
  assert.equal(processHarness.records.length, 2);
  assert.equal(processHarness.groupChecks.length, 2);
});

test("browser cleanup failure is not retried when process-group kill fails", async () => {
  const processHarness = createFakeBrowserWorkerSpawner([
    {
      cleanupCode: "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      groupKillFails: true,
      type: "failure",
    },
    {
      result: TEMP_BROWSER_RESULT,
      type: "success",
    },
  ]);
  const adapter = hostedAcceptance.createPlaywrightBrowserProcessAdapter({
    cleanupAttempts: 2,
    environment: BROWSER_SOURCE_ENVIRONMENT,
    killProcess: processHarness.killProcess,
    spawnProcess: processHarness.spawnProcess,
  });

  await assert.rejects(
    adapter.verifyRegistry({
      applicationUrl: APPLICATION_URL,
      artifactDirectory: tmpdir(),
      ownership: ACCEPTANCE_OWNERSHIP,
      rejectionOwnership: REJECTION_OWNERSHIP,
      registryFixture: TEMP_REGISTRY_FIXTURE,
      rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
      representativeEntries: REGISTRY_ENTRIES,
      tokens: {
        accessToken: ADMIN_ACCESS_TOKEN,
        idToken: ADMIN_ID_TOKEN,
        expiresAt: Date.now() + 60_000,
      },
    }),
    (error) => {
      assert.equal(error.code, "HOSTED_BROWSER_FAILED");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(processHarness.records.length, 1);
  assert.equal(processHarness.groupChecks.length, 0);
});

test("browser cleanup failure is not retried while its process group remains", async () => {
  const timers = controlledDeadlineTimers();
  const processHarness = createFakeBrowserWorkerSpawner([
    {
      cleanupCode: "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      groupStaysAlive: true,
      type: "failure",
    },
    {
      result: TEMP_BROWSER_RESULT,
      type: "success",
    },
  ]);
  const adapter = hostedAcceptance.createPlaywrightBrowserProcessAdapter({
    cleanupAttempts: 2,
    deadlineTimers: timers,
    environment: BROWSER_SOURCE_ENVIRONMENT,
    killProcess: processHarness.killProcess,
    processTerminationTimeoutMs: 45,
    spawnProcess: processHarness.spawnProcess,
  });
  const verification = adapter.verifyRegistry({
    applicationUrl: APPLICATION_URL,
    artifactDirectory: tmpdir(),
    ownership: ACCEPTANCE_OWNERSHIP,
    rejectionOwnership: REJECTION_OWNERSHIP,
    registryFixture: TEMP_REGISTRY_FIXTURE,
    rejectionRegistryFixture: TEMP_REJECTION_REGISTRY_FIXTURE,
    representativeEntries: REGISTRY_ENTRIES,
    tokens: {
      accessToken: ADMIN_ACCESS_TOKEN,
      idToken: ADMIN_ID_TOKEN,
      expiresAt: Date.now() + 60_000,
    },
  });

  await waitFor(
    () => processHarness.groupChecks.length === 1,
    "Expected an initial process-group absence check.",
  );
  assert.equal(timers.triggerNext(), 45);
  await assert.rejects(verification, (error) => {
    assert.equal(error.code, "HOSTED_BROWSER_FAILED");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(processHarness.records.length, 1);
  assert.equal(processHarness.groupChecks.length, 2);
});

test("browser worker hangs are killed and awaited before bounded retry", async (t) => {
  const createProcessAdapter =
    hostedAcceptance.createPlaywrightBrowserProcessAdapter;
  assert.equal(typeof createProcessAdapter, "function");
  if (typeof createProcessAdapter !== "function") return;
  for (const stage of ["launch", "context", "page", "close"]) {
    await t.test(stage, async () => {
      const timers = controlledDeadlineTimers();
      const processHarness = createFakeBrowserWorkerSpawner([
        { stage, type: "hang" },
        { stage, type: "hang" },
      ]);
      const adapter = createProcessAdapter({
        cleanupAttempts: 2,
        deadlineTimers: timers,
        killProcess: processHarness.killProcess,
        operationTimeoutMs: 321,
        processTerminationTimeoutMs: 45,
        spawnProcess: processHarness.spawnProcess,
      });
      const verification = adapter.verifyRegistry({
        applicationUrl: APPLICATION_URL,
        artifactDirectory: tmpdir(),
        representativeEntries: REGISTRY_ENTRIES,
        tokens: {
          accessToken: ADMIN_ACCESS_TOKEN,
          idToken: ADMIN_ID_TOKEN,
          expiresAt: Date.now() + 60_000,
        },
      });

      await waitFor(
        () => processHarness.records.length === 1,
        `Expected ${stage} worker to start.`,
      );
      assert.equal(timers.triggerNext(), 321);
      await waitFor(
        () => processHarness.records.length === 2,
        `Expected ${stage} worker retry after termination.`,
      );
      assert.equal(processHarness.active, 1);
      assert.equal(timers.triggerNext(), 321);

      await assert.rejects(verification, (error) => {
        assertCredentialFree(error);
        return true;
      });
      assert.equal(processHarness.maxActive, 1);
      assert.equal(processHarness.active, 0);
      assert.deepEqual(
        processHarness.records.map(({ child }) => child.killSignals),
        [[], []],
      );
      assert.deepEqual(
        processHarness.records.map(({ child }) => child.unrefCount),
        [0, 0],
      );
      assert.deepEqual(
        processHarness.groupKills,
        processHarness.records.map(({ child }) => ({
          pid: -child.pid,
          signal: "SIGKILL",
        })),
      );
    });
  }
});

test("browser worker termination has a secondary deadline when close never arrives", async () => {
  const createProcessAdapter =
    hostedAcceptance.createPlaywrightBrowserProcessAdapter;
  assert.equal(typeof createProcessAdapter, "function");
  if (typeof createProcessAdapter !== "function") return;
  const timers = controlledDeadlineTimers();
  const processHarness = createFakeBrowserWorkerSpawner([
    { type: "termination-hang" },
  ]);
  const adapter = createProcessAdapter({
    cleanupAttempts: 2,
    deadlineTimers: timers,
    killProcess: processHarness.killProcess,
    operationTimeoutMs: 321,
    processTerminationTimeoutMs: 45,
    spawnProcess: processHarness.spawnProcess,
  });
  const verification = adapter.verifyRegistry({
    applicationUrl: APPLICATION_URL,
    artifactDirectory: tmpdir(),
    representativeEntries: REGISTRY_ENTRIES,
    tokens: {
      accessToken: ADMIN_ACCESS_TOKEN,
      idToken: ADMIN_ID_TOKEN,
      expiresAt: Date.now() + 60_000,
    },
  });
  const rejection = assert.rejects(verification, (error) => {
    assert.equal(error.code, "HOSTED_BROWSER_FAILED");
    assertCredentialFree(error);
    return true;
  });

  await waitFor(
    () => processHarness.records.length === 1,
    "Expected hosted browser worker to start.",
  );
  assert.equal(timers.triggerNext(), 321);
  assert.equal(timers.triggerNext(), 45);
  await new Promise((resolve) => setImmediate(resolve));
  if (processHarness.records.length > 1) {
    assert.equal(timers.triggerNext(), 321);
    assert.equal(timers.triggerNext(), 45);
  }
  await rejection;
  assert.equal(
    processHarness.records.length,
    1,
    "an unconfirmed worker exit cannot be retried",
  );
  const [{ child }] = processHarness.records;
  assert.deepEqual(processHarness.groupKills, [
    { pid: -child.pid, signal: "SIGKILL" },
    { pid: -child.pid, signal: "SIGKILL" },
  ]);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
  assert.equal(child.unrefCount, 1);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("unconfirmed browser worker exit unrefs the real child without retry", {
  timeout: 15_000,
}, async () => {
  const directoryPath = mkdtempSync(
    join(tmpdir(), "hosted-browser-unref-controller-"),
  );
  const attemptLogPath = join(directoryPath, "attempts.jsonl");
  const grandchildPidPath = join(directoryPath, "grandchild.pid");
  const grandchildScriptPath = join(directoryPath, "grandchild.sh");
  const outcomePath = join(directoryPath, "controller-outcome.json");
  const controllerPath = fileURLToPath(new URL(
    "./hosted-control-plane-unref-controller.mjs",
    import.meta.url,
  ));
  const workerPath = fileURLToPath(new URL(
    "./hosted-control-plane-process-tree-fixture.mjs",
    import.meta.url,
  ));
  const wallClockLimitMs = 8_000;
  let controller;

  const processExists = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  const attemptRecords = () => {
    if (!existsSync(attemptLogPath)) return [];
    return readFileSync(attemptLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const waitUntil = async (predicate, timeoutMs, message) => {
    const expiresAt = Date.now() + timeoutMs;
    while (Date.now() < expiresAt) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(message);
  };
  const killFixtureProcesses = () => {
    for (const record of attemptRecords().reverse()) {
      try {
        process.kill(-record.workerPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
  };

  writeFileSync(
    grandchildScriptPath,
    [
      "trap '' TERM",
      "printf '%s' \"$$\" > \"$1\"",
      "exec /usr/bin/tail -f /dev/null",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );

  try {
    const startedAt = Date.now();
    controller = spawn(
      process.execPath,
      [
        controllerPath,
        "fail-group-and-direct",
        workerPath,
        attemptLogPath,
        grandchildPidPath,
        grandchildScriptPath,
        outcomePath,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const controllerOutcome = new Promise((resolve) => {
      controller.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    let watchdog;
    const outcome = await Promise.race([
      controllerOutcome,
      new Promise((resolve) => {
        watchdog = setTimeout(
          () => resolve({ wallClockTimeout: true }),
          wallClockLimitMs,
        );
      }),
    ]);
    clearTimeout(watchdog);

    assert.equal(
      outcome.wallClockTimeout,
      undefined,
      "controller remained referenced by the unconfirmed detached child",
    );
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.ok(Date.now() - startedAt < wallClockLimitMs);
    assert.equal(existsSync(outcomePath), true);
    const controllerRecord = JSON.parse(readFileSync(outcomePath, "utf8"));
    assert.equal(controllerRecord.code, "HOSTED_BROWSER_FAILED");
    assert.equal(controllerRecord.spawnCount, 1);
    assert.ok(controllerRecord.elapsedMs < wallClockLimitMs);

    const records = attemptRecords();
    assert.equal(records.length, 1, "unconfirmed workers must not be retried");
    assert.equal(records[0].workerPid, controllerRecord.workerPid);
    assert.equal(existsSync(grandchildPidPath), true);
    assert.equal(
      Number(readFileSync(grandchildPidPath, "utf8")),
      records[0].grandchildPid,
    );
    assert.equal(processExists(records[0].workerPid), true);
    assert.equal(processExists(records[0].grandchildPid), true);

    killFixtureProcesses();
    await waitUntil(
      () =>
        !processExists(records[0].workerPid)
        && !processExists(records[0].grandchildPid),
      3_000,
      "deliberate orphan fixture processes were not removed",
    );
  } finally {
    killFixtureProcesses();
    if (controller && processExists(controller.pid)) {
      try {
        controller.kill("SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    rmSync(directoryPath, { recursive: true, force: true });
  }
});

test("failed process-group kill with direct worker close is not retried", {
  timeout: 15_000,
}, async () => {
  const directoryPath = mkdtempSync(
    join(tmpdir(), "hosted-browser-direct-kill-controller-"),
  );
  const attemptLogPath = join(directoryPath, "attempts.jsonl");
  const grandchildPidPath = join(directoryPath, "grandchild.pid");
  const grandchildScriptPath = join(directoryPath, "grandchild.sh");
  const outcomePath = join(directoryPath, "controller-outcome.json");
  const controllerPath = fileURLToPath(new URL(
    "./hosted-control-plane-unref-controller.mjs",
    import.meta.url,
  ));
  const workerPath = fileURLToPath(new URL(
    "./hosted-control-plane-process-tree-fixture.mjs",
    import.meta.url,
  ));
  const wallClockLimitMs = 8_000;
  let controller;

  const processExists = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  const attemptRecords = () => {
    if (!existsSync(attemptLogPath)) return [];
    return readFileSync(attemptLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const waitUntil = async (predicate, timeoutMs, message) => {
    const expiresAt = Date.now() + timeoutMs;
    while (Date.now() < expiresAt) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(message);
  };
  const terminateRecordedProcesses = () => {
    for (const record of attemptRecords().reverse()) {
      for (const pid of [record.grandchildPid, record.workerPid]) {
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
  };

  writeFileSync(
    grandchildScriptPath,
    [
      "trap '' TERM",
      "printf '%s' \"$$\" > \"$1\"",
      "exec /usr/bin/tail -f /dev/null",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );

  try {
    const startedAt = Date.now();
    controller = spawn(
      process.execPath,
      [
        controllerPath,
        "fail-group-only",
        workerPath,
        attemptLogPath,
        grandchildPidPath,
        grandchildScriptPath,
        outcomePath,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const controllerOutcome = new Promise((resolve) => {
      controller.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });
    let watchdog;
    const outcome = await Promise.race([
      controllerOutcome,
      new Promise((resolve) => {
        watchdog = setTimeout(
          () => resolve({ wallClockTimeout: true }),
          wallClockLimitMs,
        );
      }),
    ]);
    clearTimeout(watchdog);

    assert.equal(
      outcome.wallClockTimeout,
      undefined,
      "direct worker termination exceeded its wall-clock bound",
    );
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.ok(Date.now() - startedAt < wallClockLimitMs);
    assert.equal(existsSync(outcomePath), true);
    const controllerRecord = JSON.parse(readFileSync(outcomePath, "utf8"));
    assert.equal(controllerRecord.code, "HOSTED_BROWSER_FAILED");
    assert.equal(
      controllerRecord.spawnCount,
      1,
      "failed process-group delivery cannot permit a browser retry",
    );
    assert.ok(controllerRecord.elapsedMs < wallClockLimitMs);

    const records = attemptRecords();
    assert.equal(records.length, 1, "orphaned descendants cannot overlap a retry");
    assert.equal(records[0].workerPid, controllerRecord.workerPid);
    assert.equal(processExists(records[0].workerPid), false);
    assert.equal(processExists(records[0].grandchildPid), true);

    terminateRecordedProcesses();
    await waitUntil(
      () => records.every(({ grandchildPid, workerPid }) =>
        !processExists(grandchildPid) && !processExists(workerPid)
      ),
      3_000,
      "direct-kill process-tree fixture was not removed",
    );
  } finally {
    terminateRecordedProcesses();
    if (controller && processExists(controller.pid)) {
      try {
        controller.kill("SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    rmSync(directoryPath, { recursive: true, force: true });
  }
});

test("real browser worker timeout kills its pipe-holding grandchild without retry", {
  timeout: 15_000,
}, async () => {
  const createProcessAdapter =
    hostedAcceptance.createPlaywrightBrowserProcessAdapter;
  assert.equal(typeof createProcessAdapter, "function");
  if (typeof createProcessAdapter !== "function") return;
  const directoryPath = mkdtempSync(
    join(tmpdir(), "hosted-browser-process-tree-"),
  );
  const attemptLogPath = join(directoryPath, "attempts.jsonl");
  const grandchildPidPath = join(directoryPath, "grandchild.pid");
  const grandchildScriptPath = join(directoryPath, "grandchild.sh");
  const wallClockLimitMs = 10_000;
  let verification;

  const attemptRecords = () => {
    if (!existsSync(attemptLogPath)) return [];
    return readFileSync(attemptLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const processExists = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  const terminateRecordedProcesses = () => {
    for (const record of attemptRecords().reverse()) {
      for (const pid of [record.grandchildPid, record.workerPid]) {
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      }
    }
  };

  writeFileSync(
    grandchildScriptPath,
    [
      "trap '' TERM",
      "printf '%s' \"$$\" > \"$1\"",
      "exec /usr/bin/tail -f /dev/null",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  try {
    const adapter = createProcessAdapter({
      cleanupAttempts: 1,
      environment: BROWSER_SOURCE_ENVIRONMENT,
      operationTimeoutMs: 4_000,
      processTerminationTimeoutMs: 1_000,
      workerUrl: new URL(
        "./hosted-control-plane-process-tree-fixture.mjs",
        import.meta.url,
      ),
    });
    const startedAt = Date.now();
    verification = adapter.verifyRegistry({
      attemptLogPath,
      grandchildPidPath,
      grandchildScriptPath,
    });
    let watchdog;
    const outcome = await Promise.race([
      verification.then(
        () => ({ resolved: true }),
        (error) => ({ error }),
      ),
      new Promise((resolve) => {
        watchdog = setTimeout(
          () => resolve({ wallClockTimeout: true }),
          wallClockLimitMs,
        );
      }),
    ]);
    clearTimeout(watchdog);

    if (outcome.wallClockTimeout) {
      terminateRecordedProcesses();
      await Promise.race([
        verification.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }

    assert.equal(
      outcome.wallClockTimeout,
      undefined,
      "browser process-tree termination exceeded its wall-clock bound",
    );
    assert.equal(outcome.resolved, undefined);
    assert.equal(outcome.error?.code, "HOSTED_BROWSER_FAILED");
    assertCredentialFree(outcome.error);
    assert.ok(Date.now() - startedAt < wallClockLimitMs);
    const records = attemptRecords();
    assert.equal(records.length, 1, "orphaned workers must not be retried");
    assert.equal(existsSync(grandchildPidPath), true);
    assert.equal(
      Number(readFileSync(grandchildPidPath, "utf8")),
      records[0].grandchildPid,
    );
    for (const pid of [
      records[0].workerPid,
      records[0].grandchildPid,
    ]) {
      assert.equal(processExists(pid), false, `process ${pid} remains alive`);
    }
  } finally {
    terminateRecordedProcesses();
    rmSync(directoryPath, { recursive: true, force: true });
  }
});

test("worker cleanup failure preserves the safe browser stage and removes artifacts", async () => {
  const createProcessAdapter =
    hostedAcceptance.createPlaywrightBrowserProcessAdapter;
  assert.equal(typeof createProcessAdapter, "function");
  if (typeof createProcessAdapter !== "function") return;
  const timers = controlledDeadlineTimers();
  const processHarness = createFakeBrowserWorkerSpawner([
    {
      cleanupCode: "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      type: "failure",
    },
    {
      cleanupCode: "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      type: "failure",
    },
  ]);
  const harness = createHarness();
  const browser = createProcessAdapter({
    cleanupAttempts: 2,
    deadlineTimers: timers,
    spawnProcess: processHarness.spawnProcess,
  });

  await assert.rejects(
    execute(harness, { browser }),
    (error) => {
      assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
      assert.equal(error.stage, "browser");
      assert.equal(
        error.cleanupCode,
        "HOSTED_ACCEPTANCE_CLEANUP_FAILED",
      );
      assertCredentialFree(error);
      return true;
    },
  );
  assert.equal(processHarness.maxActive, 1);
  assert.equal(processHarness.active, 0);
  assert.equal(existsSync(harness.artifactDirectory), false);
});

test("timed-out browser worker is terminated before artifact cleanup", async () => {
  const createProcessAdapter =
    hostedAcceptance.createPlaywrightBrowserProcessAdapter;
  assert.equal(typeof createProcessAdapter, "function");
  if (typeof createProcessAdapter !== "function") return;
  const timers = controlledDeadlineTimers();
  const processHarness = createFakeBrowserWorkerSpawner([
    { stage: "page", type: "hang" },
  ]);
  const harness = createHarness();
  const browser = createProcessAdapter({
    cleanupAttempts: 1,
    deadlineTimers: timers,
    killProcess: processHarness.killProcess,
    operationTimeoutMs: 321,
    processTerminationTimeoutMs: 45,
    spawnProcess: processHarness.spawnProcess,
  });
  const acceptance = execute(harness, { browser });

  await waitFor(
    () => processHarness.records.length === 1,
    "Expected hosted browser worker to start.",
  );
  assert.equal(timers.triggerNext(), 321);
  await assert.rejects(acceptance, (error) => {
    assert.equal(error.code, "HOSTED_ACCEPTANCE_FAILED");
    assert.equal(error.stage, "browser");
    assertCredentialFree(error);
    return true;
  });
  assert.equal(processHarness.active, 0);
  assert.deepEqual(
    processHarness.records[0].child.killSignals,
    [],
  );
  assert.deepEqual(
    processHarness.groupKills,
    [{
      pid: -processHarness.records[0].child.pid,
      signal: "SIGKILL",
    }],
  );
  assert.equal(existsSync(harness.artifactDirectory), false);
});

test("production CLI selects the killable browser process adapter", () => {
  const source = readFileSync(
    new URL("./hosted-control-plane-acceptance.mjs", import.meta.url),
    "utf8",
  );
  const runCliSource = source.slice(source.indexOf("export async function runCli"));

  assert.match(
    runCliSource,
    /\?\? createPlaywrightBrowserProcessAdapter/,
  );
  assert.doesNotMatch(runCliSource, /import\("playwright"\)/);
  assert.match(
    source,
    /platform-registry\/control-plane-outputs\.json/,
  );
});

test("production CLI composes only the Lambda broker from ignored stack outputs", async () => {
  const calls = [];
  const stackOutputs = {
    applicationUrl: APPLICATION_URL,
    brokerFunctionArn: BROKER_FUNCTION_ARN,
    clientId: CLIENT_ID,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    userPoolId: USER_POOL_ID,
  };
  const cognito = { adapter: "cognito" };
  const browser = { adapter: "browser" };
  const lambdaClient = { client: "lambda" };
  const resources = { adapter: "resources" };
  const dependencies = {
    readStackOutputs(input) {
      calls.push({ operation: "read-outputs", input });
      return stackOutputs;
    },
    createCognitoAdapter(input) {
      calls.push({ operation: "create-cognito", input });
      return cognito;
    },
    createRegistryClient() {
      assert.fail("production CLI must not create a Registry client");
    },
    createDynamoClient() {
      assert.fail("production CLI must not create a DynamoDB client");
    },
    createLambdaClient(input) {
      calls.push({ operation: "create-lambda-client", input });
      return lambdaClient;
    },
    createResourceAdapter(input) {
      calls.push({ operation: "create-resources", input });
      return resources;
    },
    createBrowserAdapter(input) {
      calls.push({ operation: "create-browser", input });
      return browser;
    },
    async runAcceptance(input) {
      calls.push({ operation: "acceptance", input });
      return { ok: true };
    },
    async cleanupRun(input) {
      calls.push({ operation: "cleanup", input });
      return { ok: true };
    },
  };
  const env = {
    ARBITRARY_SECRET: "must-not-enter-command-arguments",
    AWS_ACCOUNT_ID: ACCOUNT_ID,
    AWS_REGION: REGION,
    HOSTED_ACCEPTANCE_CONTROL_PLANE_OUTPUTS_FILE:
      "/private/control-plane-outputs.json",
    HOSTED_ACCEPTANCE_RUN_ATTEMPT: VERIFIER_RUN_ATTEMPT,
    HOSTED_ACCEPTANCE_RUN_ID: VERIFIER_RUN_ID,
    HOSTED_ACCEPTANCE_WEB_OUTPUTS_FILE: "/private/web-outputs.json",
  };

  assert.equal(await hostedAcceptance.runCli({
    argv: [],
    dependencies,
    env,
  }), "acceptance");
  assert.equal(await hostedAcceptance.runCli({
    argv: ["--cleanup-only"],
    dependencies,
    env,
  }), "cleanup");

  const acceptance = calls.find(({ operation }) =>
    operation === "acceptance"
  ).input;
  assert.deepEqual(acceptance, {
    applicationUrl: APPLICATION_URL,
    browser,
    clientId: CLIENT_ID,
    cognito,
    region: REGION,
    operationTimeoutMs: 20_000,
    resourceOperationTimeoutMs: 150_000,
    resources,
    userPoolId: USER_POOL_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
    verifierRunId: VERIFIER_RUN_ID,
  });
  const cleanup = calls.find(({ operation }) =>
    operation === "cleanup"
  ).input;
  assert.deepEqual(cleanup, {
    cognito,
    fixtureRegistryId: FIXTURE_REGISTRY_ID,
    operationTimeoutMs: 20_000,
    resourceOperationTimeoutMs: 150_000,
    resources,
    userPoolId: USER_POOL_ID,
    verifierRunAttempt: VERIFIER_RUN_ATTEMPT,
    verifierRunId: VERIFIER_RUN_ID,
  });
  for (const resourceCall of calls.filter(({ operation }) =>
    operation === "create-resources"
  )) {
    assert.deepEqual(resourceCall.input, {
      accountId: ACCOUNT_ID,
      brokerFunctionArn: BROKER_FUNCTION_ARN,
      lambdaClient,
      region: REGION,
    });
  }
  assert.deepEqual(
    calls.filter(({ operation }) => operation === "create-browser")
      .map(({ input }) => input),
    [{
      environment: env,
      operationTimeoutMs: 20_000,
    }],
  );
  assert.deepEqual(
    calls.filter(({ operation }) => operation === "read-outputs")
      .map(({ input }) => input),
    [
      {
        controlPlaneOutputsPath: "/private/control-plane-outputs.json",
        webOutputsPath: "/private/web-outputs.json",
      },
      {
        controlPlaneOutputsPath: "/private/control-plane-outputs.json",
        webOutputsPath: "/private/web-outputs.json",
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(calls.filter(({ operation }) =>
      operation !== "create-browser"
    )),
    /must-not-enter-command-arguments/,
  );
});

test("production acceptance source has no direct Registry or DynamoDB resource client", () => {
  const source = readFileSync(
    new URL("./hosted-control-plane-acceptance.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /LambdaClient/);
  assert.match(source, /InvokeCommand/);
  assert.doesNotMatch(source, /AgentRegistryControlClient/);
  assert.doesNotMatch(source, /DynamoDBClient/);
  assert.doesNotMatch(source, /createAwsExactResourceAdapter/);
  assert.doesNotMatch(source, /TagResourceCommand/);
});

test("AWS adapter uses its explicit region and keeps passwords out of argv", async () => {
  const calls = [];
  const adapter = createAwsCognitoAdapter({
    region: "ap-southeast-2",
    operationTimeoutMs: 19_000,
    runAws: async (args, options) => {
      calls.push({ args, options });
      return args[1] === "admin-initiate-auth"
        ? {
            stdout: JSON.stringify({
              AuthenticationResult: {
                AccessToken: ADMIN_ACCESS_TOKEN,
                IdToken: ADMIN_ID_TOKEN,
                ExpiresIn: 3600,
              },
            }),
          }
        : args[1] === "admin-create-user"
          ? {
              stdout: JSON.stringify({
                User: {
                  Username: common.username,
                  Enabled: true,
                  UserStatus: "FORCE_CHANGE_PASSWORD",
                  Attributes: [
                    {
                      Name: "sub",
                      Value: TEMP_DOMAIN.createdBy,
                    },
                    {
                      Name: "name",
                      Value: "Hosted verifier",
                    },
                    {
                      Name: "custom:managed_by",
                      Value: "agentic-ai-platform-demo",
                    },
                  ],
                },
              }),
            }
        : args[1] === "admin-get-user"
          ? {
              stdout: JSON.stringify({
                UserAttributes: [{
                  Name: "sub",
                  Value: TEMP_DOMAIN.createdBy,
                }],
              }),
            }
        : { stdout: "" };
    },
  });
  const common = {
    userPoolId: "ap-southeast-2_Example123",
    username: "hosted-acceptance-admin-example",
  };

  assert.deepEqual(await adapter.adminCreateUser({
    ...common,
    messageAction: "SUPPRESS",
    userAttributes: [
      { name: "name", value: "Hosted verifier" },
      { name: "custom:managed_by", value: "agentic-ai-platform-demo" },
    ],
  }), {
    Username: common.username,
    Enabled: true,
    UserStatus: "FORCE_CHANGE_PASSWORD",
    UserAttributes: [
      {
        Name: "sub",
        Value: TEMP_DOMAIN.createdBy,
      },
      {
        Name: "name",
        Value: "Hosted verifier",
      },
      {
        Name: "custom:managed_by",
        Value: "agentic-ai-platform-demo",
      },
    ],
  });
  await adapter.adminSetUserPassword({
    ...common,
    password: ADMIN_PASSWORD,
    permanent: true,
  });
  await adapter.adminAddUserToGroup({
    ...common,
    groupName: "platform-admin",
  });
  assert.deepEqual(await adapter.adminGetUser(common), {
    UserAttributes: [{
      Name: "sub",
      Value: TEMP_DOMAIN.createdBy,
    }],
  });
  await adapter.adminInitiateAuth({
    ...common,
    authFlow: "ADMIN_USER_PASSWORD_AUTH",
    clientId: CLIENT_ID,
    password: ADMIN_PASSWORD,
  });
  await adapter.adminDeleteUser(common);

  assert.equal(calls.length, 6);
  for (const { args } of calls) {
    const regionIndex = args.indexOf("--region");
    assert.notEqual(regionIndex, -1);
    assert.equal(args[regionIndex + 1], "ap-southeast-2");
    assert.equal(args.includes(ADMIN_PASSWORD), false);
  }
  for (const { options } of calls) {
    assert.equal(options.timeoutMs, 19_000);
  }
  for (const operation of ["admin-set-user-password", "admin-initiate-auth"]) {
    const call = calls.find(({ args }) => args[1] === operation);
    assert.ok(call);
    assert.deepEqual(
      call.args.slice(2, 4),
      ["--cli-input-json", "file:///dev/stdin"],
    );
    assert.match(call.options.input, new RegExp(ADMIN_PASSWORD));
  }
});

test("private artifact setup removes its directory when permission setup fails", () => {
  const calls = [];

  assert.throws(
    () => createPrivateArtifactDirectory({
      makeDirectory(prefix) {
        calls.push(["make", prefix]);
        return "/private/hosted-acceptance";
      },
      setMode(path, mode) {
        calls.push(["mode", path, mode]);
        throw new Error("chmod failed");
      },
      removeDirectory(path, options) {
        calls.push(["remove", path, options]);
      },
      temporaryRoot: "/private",
    }),
    /chmod failed/,
  );

  assert.deepEqual(calls, [
    ["make", "/private/agentic-platform-hosted-acceptance-"],
    ["mode", "/private/hosted-acceptance", 0o700],
    [
      "remove",
      "/private/hosted-acceptance",
      { recursive: true, force: true },
    ],
  ]);
});

test("private artifact setup fails closed when rollback cannot remove the directory", () => {
  const calls = [];

  assert.throws(
    () => createPrivateArtifactDirectory({
      makeDirectory(prefix) {
        calls.push(["make", prefix]);
        return "/private/hosted-acceptance";
      },
      setMode(path, mode) {
        calls.push(["mode", path, mode]);
        throw new Error(`chmod failed with ${ADMIN_PASSWORD}`);
      },
      removeDirectory(path, options) {
        calls.push(["remove", path, options]);
        throw new Error(`remove failed with ${ADMIN_ACCESS_TOKEN}`);
      },
      temporaryRoot: "/private",
    }),
    (error) => {
      assert.equal(error.code, "HOSTED_ACCEPTANCE_CLEANUP_FAILED");
      assertCredentialFree(error);
      return true;
    },
  );

  assert.deepEqual(calls, [
    ["make", "/private/agentic-platform-hosted-acceptance-"],
    ["mode", "/private/hosted-acceptance", 0o700],
    [
      "remove",
      "/private/hosted-acceptance",
      { recursive: true, force: true },
    ],
  ]);
});
