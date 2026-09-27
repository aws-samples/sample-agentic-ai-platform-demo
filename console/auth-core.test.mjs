import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  buildAuthorizeUrl,
  codeChallenge,
  decodeJwtPayload,
  randomUrlSafe,
  tokenIsUsable,
} from "./public/auth-core.mjs";

test("PKCE S256 challenge matches RFC 7636 Appendix B", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  assert.equal(
    await codeChallenge(verifier),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("randomUrlSafe returns cryptographically generated URL-safe values", () => {
  const first = randomUrlSafe(32);
  const second = randomUrlSafe(32);

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test("buildAuthorizeUrl creates the configured authorization-code request", () => {
  const url = new URL(buildAuthorizeUrl({
    domain: "https://example.auth.us-west-2.amazoncognito.com",
    clientId: "client-123",
    redirectUri: "https://d111.cloudfront.net/console",
    scopes: ["openid", "email", "profile"],
  }, {
    state: "state-123",
    challenge: "challenge-123",
  }));

  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://d111.cloudfront.net/console");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-123");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("decodeJwtPayload decodes a base64url payload without checking its signature", () => {
  const payload = Buffer.from(JSON.stringify({
    sub: "user-123",
    name: "Test Üser",
    exp: 2_000,
  })).toString("base64url");

  assert.deepEqual(decodeJwtPayload(`header.${payload}.untrusted-signature`), {
    sub: "user-123",
    name: "Test Üser",
    exp: 2_000,
  });
});

test("decodeJwtPayload fails closed for malformed tokens", () => {
  for (const token of [
    null,
    "",
    "not-a-jwt",
    "header.%%%.signature",
    "header.bm90LWpzb24.signature",
    "header..signature",
  ]) {
    assert.deepEqual(decodeJwtPayload(token), {});
  }
});

test("tokenIsUsable requires an access token with more than 30 seconds remaining", () => {
  const now = 100_000;

  assert.equal(tokenIsUsable({ accessToken: "access", expiresAt: now + 30_001 }, now), true);
  assert.equal(tokenIsUsable({ accessToken: "access", expiresAt: now + 30_000 }, now), false);
  assert.equal(tokenIsUsable({ accessToken: "", expiresAt: now + 60_000 }, now), false);
  assert.equal(tokenIsUsable({ accessToken: "   ", expiresAt: now + 60_000 }, now), false);
  assert.equal(tokenIsUsable({ accessToken: { value: "access" }, expiresAt: now + 60_000 }, now), false);
  assert.equal(tokenIsUsable(null, now), false);
});

class MemoryStorage {
  constructor(entries = {}, failures = {}) {
    this.values = new Map(Object.entries(entries));
    this.failures = failures;
    this.removedKeys = [];
  }

  getItem(key) {
    if (this.failures.get === true || this.failures.get?.has(key)) {
      throw new Error("storage get failed");
    }
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failures.set === true || this.failures.set?.has(key)) {
      throw new Error("storage set failed");
    }
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.removedKeys.push(key);
    if (this.failures.remove === true || this.failures.remove?.has(key)) {
      throw new Error("storage remove failed");
    }
    this.values.delete(key);
  }
}

const COGNITO_RUNTIME = {
  authMode: "cognito",
  apiBaseUrl: "/api",
  cognito: {
    domain: "https://example.auth.us-west-2.amazoncognito.com",
    clientId: "client-123",
    redirectUri: "https://app.example/console",
    logoutUri: "https://app.example/signed-out",
    scopes: ["openid", "email", "profile"],
  },
};

function installBrowser({
  runtime = COGNITO_RUNTIME,
  href = "https://app.example/console",
  sessionEntries,
  storageFailures,
} = {}) {
  const globalKeys = [
    "window",
    "document",
    "sessionStorage",
    "localStorage",
    "fetch",
  ];
  const previousGlobals = new Map(
    globalKeys.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  browserGlobalSnapshots.push(previousGlobals);

  let assignedUrl = null;
  let replacedUrl = null;
  const session = new MemoryStorage(sessionEntries, storageFailures);
  const local = {
    getItem() {
      throw new Error("localStorage must not be read");
    },
    setItem() {
      throw new Error("localStorage must not be written");
    },
    removeItem() {
      throw new Error("localStorage must not be cleared");
    },
  };
  const location = {
    href,
    assign(url) {
      assignedUrl = String(url);
    },
  };
  const history = {
    state: { preserved: true },
    replaceState(state, title, url) {
      replacedUrl = { state, title, url: String(url) };
    },
  };

  globalThis.window = { location, history };
  if (runtime !== undefined) window.__RUNTIME_CONFIG__ = runtime;
  globalThis.document = { title: "Agentic AI Platform" };
  globalThis.sessionStorage = session;
  globalThis.localStorage = local;

  return {
    session,
    get assignedUrl() {
      return assignedUrl;
    },
    get replacedUrl() {
      return replacedUrl;
    },
  };
}

const browserGlobalSnapshots = [];

function restoreBrowser() {
  const previousGlobals = browserGlobalSnapshots.pop();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete globalThis[key];
    }
  }
}

async function loadAuthClient() {
  return import("./public/auth-client.mjs");
}

test("browser fixture restores previous global property descriptors", () => {
  const keys = [
    "window",
    "document",
    "sessionStorage",
    "localStorage",
    "fetch",
  ];
  const before = new Map(
    keys.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );

  installBrowser();
  globalThis.fetch = async () => ({ ok: true });
  restoreBrowser();

  for (const [key, descriptor] of before) {
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis, key),
      descriptor,
    );
  }
});

test("committed runtime config contains only local mock defaults", () => {
  const source = readFileSync(
    new URL("./public/runtime-config.js", import.meta.url),
    "utf8",
  );
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);

  assert.deepEqual(
    JSON.parse(JSON.stringify(sandbox.window.__RUNTIME_CONFIG__)),
    { authMode: "mock", apiBaseUrl: "/api" },
  );
  assert.doesNotMatch(
    source,
    /account|amazoncognito|client.?id|token|password|secret/i,
  );
});

test("authMode defaults to mock and mock mode never returns a Cognito token", async (t) => {
  installBrowser({
    runtime: null,
    sessionEntries: {
      "console.cognito.tokens": JSON.stringify({
        accessToken: "must-not-be-returned",
        expiresAt: Date.now() + 60_000,
      }),
    },
  });
  t.after(restoreBrowser);
  const { authMode, getAccessToken } = await loadAuthClient();

  assert.equal(authMode(), "mock");
  assert.equal(getAccessToken(), null);
});

test("getAccessToken reads usable Cognito tokens from sessionStorage only", async (t) => {
  const browser = installBrowser({
    sessionEntries: {
      "console.cognito.tokens": JSON.stringify({
        accessToken: "session-access-token",
        expiresAt: Date.now() + 60_000,
      }),
      "console.demo-context": JSON.stringify({
        role: "builder",
        domain: "operations",
      }),
    },
  });
  t.after(restoreBrowser);
  const { getAccessToken } = await loadAuthClient();

  assert.equal(getAccessToken(), "session-access-token");
  assert.deepEqual(
    JSON.parse(browser.session.getItem("console.demo-context")),
    { role: "builder", domain: "operations" },
  );
  browser.session.setItem("console.cognito.tokens", JSON.stringify({
    accessToken: "expired-token",
    idToken: "expired-id-token",
    refreshToken: "stale-refresh-token",
    expiresAt: Date.now() + 30_000,
  }));
  assert.equal(getAccessToken(), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  browser.session.setItem("console.demo-context", JSON.stringify({
    role: "lead",
    domain: "customer_support",
  }));
  browser.session.setItem("console.cognito.tokens", "{not-json");
  assert.equal(getAccessToken(), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  browser.session.setItem("console.demo-context", JSON.stringify({
    role: "admin",
    domain: null,
  }));
  browser.session.setItem("console.cognito.tokens", JSON.stringify({
    accessToken: "   ",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(getAccessToken(), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  browser.session.setItem("console.demo-context", JSON.stringify({
    role: "user",
    domain: null,
  }));
  browser.session.setItem("console.cognito.tokens", JSON.stringify({
    accessToken: { value: "access" },
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(getAccessToken(), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  browser.session.setItem("console.cognito.tokens", JSON.stringify({
    accessToken: "legacy-access-token",
    idToken: "legacy-id-token",
    refreshToken: "stale-refresh-token",
    expiresAt: Date.now() + 60_000,
  }));
  assert.equal(getAccessToken(), "legacy-access-token");
  assert.deepEqual(
    JSON.parse(browser.session.getItem("console.cognito.tokens")),
    {
      accessToken: "legacy-access-token",
      idToken: "legacy-id-token",
      expiresAt: JSON.parse(
        browser.session.getItem("console.cognito.tokens"),
      ).expiresAt,
    },
  );
  browser.session.removeItem("console.cognito.tokens");
  browser.session.setItem("console.demo-context", JSON.stringify({
    role: "builder",
    domain: "operations",
  }));
  browser.session.removedKeys.length = 0;
  assert.equal(getAccessToken(), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  assert.deepEqual(
    browser.session.removedKeys,
    ["console.cognito.tokens", "console.demo-context"],
  );
});

test("getAccessToken reports sessionStorage read failures with a stable error", async (t) => {
  installBrowser({
    storageFailures: {
      get: new Set(["console.cognito.tokens"]),
    },
  });
  t.after(restoreBrowser);
  const { getAccessToken } = await loadAuthClient();

  assert.throws(
    () => getAccessToken(),
    new Error("Browser session storage is unavailable."),
  );
});

test("beginSignIn stores only verifier and state before redirecting with PKCE", async (t) => {
  const browser = installBrowser();
  t.after(restoreBrowser);
  const { beginSignIn } = await loadAuthClient();

  await beginSignIn();

  const flow = JSON.parse(browser.session.getItem("console.cognito.flow"));
  assert.deepEqual(Object.keys(flow).sort(), ["state", "verifier"]);
  assert.match(flow.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(flow.state, /^[A-Za-z0-9_-]+$/);

  const redirect = new URL(browser.assignedUrl);
  assert.equal(redirect.pathname, "/oauth2/authorize");
  assert.equal(redirect.searchParams.get("state"), flow.state);
  assert.equal(
    redirect.searchParams.get("code_challenge"),
    await codeChallenge(flow.verifier),
  );
  assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
});

test("beginSignIn validates required Cognito configuration before storing flow state", async (t) => {
  const runtime = structuredClone(COGNITO_RUNTIME);
  delete runtime.cognito.clientId;
  const browser = installBrowser({ runtime });
  t.after(restoreBrowser);
  const { beginSignIn } = await loadAuthClient();

  await assert.rejects(
    beginSignIn(),
    new Error("Cognito configuration is missing clientId."),
  );
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.equal(browser.assignedUrl, null);
});

test("beginSignIn requires an absolute HTTPS redirect URI", async (t) => {
  const { beginSignIn } = await loadAuthClient();
  for (const redirectUri of ["/callback", "http://app.example/callback"]) {
    await t.test(redirectUri, async () => {
      const runtime = structuredClone(COGNITO_RUNTIME);
      runtime.cognito.redirectUri = redirectUri;
      const browser = installBrowser({ runtime });
      try {
        await assert.rejects(
          beginSignIn(),
          new Error("Cognito configuration has an invalid redirectUri."),
        );
        assert.equal(browser.session.getItem("console.cognito.flow"), null);
        assert.equal(browser.assignedUrl, null);
      } finally {
        restoreBrowser();
      }
    });
  }
});

test("beginSignIn reports sessionStorage write failures with a stable error", async (t) => {
  const browser = installBrowser({
    storageFailures: {
      set: new Set(["console.cognito.flow"]),
    },
  });
  t.after(restoreBrowser);
  const { beginSignIn } = await loadAuthClient();

  await assert.rejects(
    beginSignIn(),
    new Error("Browser session storage is unavailable."),
  );
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.equal(browser.assignedUrl, null);
});

test("completeSignIn rejects an OAuth error response and cleans its query parameters", async (t) => {
  const browser = installBrowser({
    href: "https://app.example/console?keep=1&error=access_denied&error_description=nope&state=state-123#details",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
    },
  });
  globalThis.fetch = async () => {
    throw new Error("OAuth errors must not exchange a token");
  };
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  await assert.rejects(
    completeSignIn(),
    new Error("Cognito authorization failed."),
  );
  assert.equal(browser.replacedUrl.url, "/console?keep=1#details");
});

test("completeSignIn requires exact state for OAuth error callbacks", async (t) => {
  installBrowser({
    href: "https://app.example/console?error=access_denied&state=wrong-state",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "expected-state",
      }),
    },
  });
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  await assert.rejects(
    completeSignIn(),
    new Error("Cognito sign-in state did not match."),
  );
});

test("completeSignIn requires an exact stored state match before token exchange", async (t) => {
  const browser = installBrowser({
    href: "https://app.example/console?code=authorization-code&state=wrong-state",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "expected-state",
      }),
    },
  });
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("state mismatch must not exchange a token");
  };
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  await assert.rejects(
    completeSignIn(),
    new Error("Cognito sign-in state did not match."),
  );
  assert.equal(fetchCalled, false);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
});

test("completeSignIn exchanges the code without a client secret and preserves unrelated URL parts", async (t) => {
  const browser = installBrowser({
    href: "https://app.example/console?keep=1&code=authorization-code&state=state-123#details",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
    },
  });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      async json() {
        return {
          access_token: "access-token",
          id_token: "id-token",
          refresh_token: "refresh-token",
          expires_in: 900,
        };
      },
    };
  };
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();
  const before = Date.now();

  assert.equal(await completeSignIn(), true);

  assert.equal(
    request.url,
    "https://example.auth.us-west-2.amazoncognito.com/oauth2/token",
  );
  assert.equal(request.options.method, "POST");
  assert.equal(
    request.options.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  const body = new URLSearchParams(String(request.options.body));
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("client_id"), "client-123");
  assert.equal(body.get("code"), "authorization-code");
  assert.equal(body.get("redirect_uri"), "https://app.example/console");
  assert.equal(body.get("code_verifier"), "verifier-123");
  assert.equal(body.has("client_secret"), false);

  const tokens = JSON.parse(browser.session.getItem("console.cognito.tokens"));
  assert.deepEqual(Object.keys(tokens).sort(), [
    "accessToken",
    "expiresAt",
    "idToken",
  ]);
  assert.equal(tokens.accessToken, "access-token");
  assert.equal(tokens.idToken, "id-token");
  assert.ok(tokens.expiresAt >= before + 900_000);
  assert.ok(tokens.expiresAt <= Date.now() + 900_000);
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.deepEqual(browser.replacedUrl, {
    state: { preserved: true },
    title: "Agentic AI Platform",
    url: "/console?keep=1#details",
  });
});

test("completeSignIn consumes matched flow before awaiting the token exchange", async (t) => {
  const browser = installBrowser({
    href: "https://app.example/console?code=authorization-code&state=state-123",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
    },
  });
  let releaseFetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Promise((resolve) => {
      releaseFetch = () => resolve({
        ok: true,
        async json() {
          return {
            access_token: "access-token",
            id_token: "id-token",
            expires_in: 900,
          };
        },
      });
    });
  };
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  const firstCompletion = completeSignIn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  await assert.rejects(
    completeSignIn(),
    new Error("Cognito sign-in state did not match."),
  );
  assert.equal(fetchCalls, 1);

  releaseFetch();
  assert.equal(await firstCompletion, true);
});

test("completeSignIn consumes flow and cleans the callback when config is invalid", async (t) => {
  const runtime = structuredClone(COGNITO_RUNTIME);
  delete runtime.cognito.clientId;
  const browser = installBrowser({
    runtime,
    href: "https://app.example/nested/console?keep=1&code=authorization-code&state=state-123#details",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
    },
  });
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  await assert.rejects(
    completeSignIn(),
    new Error("Cognito configuration is missing clientId."),
  );
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.deepEqual(browser.replacedUrl, {
    state: { preserved: true },
    title: "Agentic AI Platform",
    url: "/nested/console?keep=1#details",
  });
});

test("completeSignIn rejects an invalid redirect URI after consuming the callback", async (t) => {
  const runtime = structuredClone(COGNITO_RUNTIME);
  runtime.cognito.redirectUri = "/callback";
  const browser = installBrowser({
    runtime,
    href: "https://app.example/nested/console?keep=1&code=authorization-code&state=state-123#details",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
    },
  });
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("invalid redirect URI must not reach token exchange");
  };
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  await assert.rejects(
    completeSignIn(),
    new Error("Cognito configuration has an invalid redirectUri."),
  );
  assert.equal(fetchCalled, false);
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.deepEqual(browser.replacedUrl, {
    state: { preserved: true },
    title: "Agentic AI Platform",
    url: "/nested/console?keep=1#details",
  });
});

test("completeSignIn reports flow-consume failures without masking URL cleanup", async (t) => {
  const browser = installBrowser({
    href: "https://app.example/nested/console?keep=1&code=authorization-code&state=state-123#details",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
    },
    storageFailures: {
      remove: new Set(["console.cognito.flow"]),
    },
  });
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
  };
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  await assert.rejects(
    completeSignIn(),
    new Error("Browser session storage is unavailable."),
  );
  assert.equal(fetchCalled, false);
  assert.deepEqual(browser.replacedUrl, {
    state: { preserved: true },
    title: "Agentic AI Platform",
    url: "/nested/console?keep=1#details",
  });
});

test("completeSignIn reports token-store failures without masking URL cleanup", async (t) => {
  const browser = installBrowser({
    href: "https://app.example/nested/console?keep=1&code=authorization-code&state=state-123#details",
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
    },
    storageFailures: {
      set: new Set(["console.cognito.tokens"]),
    },
  });
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        access_token: "access-token",
        id_token: "id-token",
        expires_in: 900,
      };
    },
  });
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  await assert.rejects(
    completeSignIn(),
    new Error("Browser session storage is unavailable."),
  );
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.deepEqual(browser.replacedUrl, {
    state: { preserved: true },
    title: "Agentic AI Platform",
    url: "/nested/console?keep=1#details",
  });
});

test("completeSignIn cleans callback state for every token exchange failure", async (t) => {
  const { completeSignIn } = await loadAuthClient();
  const cases = [
    {
      name: "fetch rejection",
      fetch: async () => {
        throw new Error("network unavailable");
      },
      error: "Cognito token exchange failed.",
    },
    {
      name: "non-OK response",
      fetch: async () => ({ ok: false, status: 400 }),
      error: "Cognito token exchange failed.",
    },
    {
      name: "malformed JSON",
      fetch: async () => ({
        ok: true,
        async json() {
          throw new SyntaxError("invalid JSON");
        },
      }),
      error: "Cognito token response was invalid.",
    },
    {
      name: "invalid token payload",
      fetch: async () => ({
        ok: true,
        async json() {
          return { access_token: "access-token", expires_in: "not-a-number" };
        },
      }),
      error: "Cognito token response was invalid.",
    },
  ];

  for (const failure of cases) {
    await t.test(failure.name, async () => {
      const browser = installBrowser({
        href: "https://app.example/nested/console?keep=1&code=authorization-code&state=state-123#details",
        sessionEntries: {
          "console.cognito.flow": JSON.stringify({
            verifier: "verifier-123",
            state: "state-123",
          }),
        },
      });
      globalThis.fetch = failure.fetch;
      try {
        await assert.rejects(
          completeSignIn(),
          new Error(failure.error),
        );
        assert.equal(browser.session.getItem("console.cognito.flow"), null);
        assert.equal(browser.session.getItem("console.cognito.tokens"), null);
        assert.deepEqual(browser.replacedUrl, {
          state: { preserved: true },
          title: "Agentic AI Platform",
          url: "/nested/console?keep=1#details",
        });
      } finally {
        restoreBrowser();
      }
    });
  }
});

test("completeSignIn returns false when Cognito did not return a code", async (t) => {
  installBrowser({ href: "https://app.example/console?keep=1#details" });
  t.after(restoreBrowser);
  const { completeSignIn } = await loadAuthClient();

  assert.equal(await completeSignIn(), false);
});

test("signOut clears session authentication and redirects to Cognito logout", async (t) => {
  const browser = installBrowser({
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
      "console.cognito.tokens": JSON.stringify({
        accessToken: "access-token",
        expiresAt: Date.now() + 60_000,
      }),
      "console.demo-context": JSON.stringify({
        role: "builder",
        domain: "operations",
      }),
    },
  });
  t.after(restoreBrowser);
  const { signOut } = await loadAuthClient();

  signOut();

  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  const logout = new URL(browser.assignedUrl);
  assert.equal(logout.pathname, "/logout");
  assert.equal(logout.searchParams.get("client_id"), "client-123");
  assert.equal(logout.searchParams.get("logout_uri"), "https://app.example/signed-out");
});

test("signOut still redirects and reports a stable error when local cleanup fails", async (t) => {
  const browser = installBrowser({
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
      "console.cognito.tokens": JSON.stringify({
        accessToken: "access-token",
        expiresAt: Date.now() + 60_000,
      }),
      "console.demo-context": JSON.stringify({
        role: "builder",
        domain: "operations",
      }),
    },
    storageFailures: {
      remove: new Set(["console.cognito.tokens"]),
    },
  });
  t.after(restoreBrowser);
  const { signOut } = await loadAuthClient();

  assert.throws(
    () => signOut(),
    new Error("Browser session storage is unavailable."),
  );

  const logout = new URL(browser.assignedUrl);
  assert.equal(logout.pathname, "/logout");
  assert.equal(logout.searchParams.get("client_id"), "client-123");
  assert.equal(logout.searchParams.get("logout_uri"), "https://app.example/signed-out");
  assert.deepEqual(browser.session.removedKeys, [
    "console.cognito.tokens",
    "console.cognito.flow",
    "console.demo-context",
  ]);
});

test("signOut clears local authentication even when Cognito config is invalid", async (t) => {
  const runtime = structuredClone(COGNITO_RUNTIME);
  delete runtime.cognito.logoutUri;
  const flow = JSON.stringify({
    verifier: "verifier-123",
    state: "state-123",
  });
  const tokens = JSON.stringify({
    accessToken: "access-token",
    expiresAt: Date.now() + 60_000,
  });
  const browser = installBrowser({
    runtime,
    sessionEntries: {
      "console.cognito.flow": flow,
      "console.cognito.tokens": tokens,
      "console.demo-context": JSON.stringify({
        role: "lead",
        domain: "operations",
      }),
    },
  });
  t.after(restoreBrowser);
  const { signOut } = await loadAuthClient();

  assert.throws(
    () => signOut(),
    new Error("Cognito configuration is missing logoutUri."),
  );
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  assert.equal(browser.assignedUrl, null);
});

test("signOut requires an absolute HTTPS logout URI and still clears local auth", async (t) => {
  const runtime = structuredClone(COGNITO_RUNTIME);
  runtime.cognito.logoutUri = "http://app.example/signed-out";
  const browser = installBrowser({
    runtime,
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
      "console.cognito.tokens": JSON.stringify({
        accessToken: "access-token",
        expiresAt: Date.now() + 60_000,
      }),
      "console.demo-context": JSON.stringify({
        role: "user",
        domain: null,
      }),
    },
  });
  t.after(restoreBrowser);
  const { signOut } = await loadAuthClient();

  assert.throws(
    () => signOut(),
    new Error("Cognito configuration has an invalid logoutUri."),
  );
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.equal(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
  assert.equal(browser.assignedUrl, null);
});

test("clearAuthentication attempts token, flow, and demo-context removals", async (t) => {
  const browser = installBrowser({
    sessionEntries: {
      "console.cognito.flow": JSON.stringify({
        verifier: "verifier-123",
        state: "state-123",
      }),
      "console.cognito.tokens": JSON.stringify({
        accessToken: "access-token",
        expiresAt: Date.now() + 60_000,
      }),
      "console.demo-context": JSON.stringify({
        role: "builder",
        domain: "operations",
      }),
    },
    storageFailures: {
      remove: new Set(["console.cognito.tokens"]),
    },
  });
  t.after(restoreBrowser);
  const { clearAuthentication } = await loadAuthClient();

  assert.throws(
    () => clearAuthentication(),
    new Error("Browser session storage is unavailable."),
  );
  assert.deepEqual(browser.session.removedKeys, [
    "console.cognito.tokens",
    "console.cognito.flow",
    "console.demo-context",
  ]);
  assert.notEqual(browser.session.getItem("console.cognito.tokens"), null);
  assert.equal(browser.session.getItem("console.cognito.flow"), null);
  assert.equal(browser.session.getItem("console.demo-context"), null);
});
