import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubOAuthError,
  createGitHubAuthorizationUrl,
  createGitHubOAuth,
} from "../lambda/journeys/github-oauth.mjs";

const CLIENT_ID = "Iv1.1234567890abcdef";
const CLIENT_SECRET = "github-oauth-client-secret";
const CALLBACK_URL = "https://d111111abcdef8.cloudfront.net/";
const STATE = "gho_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const CODE = "github-authorization-code";
const TOKEN = "gho_github-access-token";

function response(status, body, headers = {}) {
  return new Response(
    body === null ? null : JSON.stringify(body),
    {
      status,
      headers: {
        ...(body === null ? {} : { "content-type": "application/json" }),
        ...headers,
      },
    },
  );
}

function expectCode(code, secrets = []) {
  return (error) => {
    assert.ok(error instanceof GitHubOAuthError);
    assert.equal(error.code, code);
    for (const secret of secrets) {
      assert.equal(error.message.includes(secret), false);
    }
    return true;
  };
}

function harness(replies) {
  const calls = [];
  const queue = [...replies];
  const oauth = createGitHubOAuth({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUrl: CALLBACK_URL,
    async fetch(url, options) {
      calls.push({
        url,
        options: {
          ...options,
          headers: { ...options.headers },
        },
      });
      if (queue.length === 0) {
        throw new Error("Unexpected GitHub OAuth request.");
      }
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { calls, oauth };
}

test("GitHub OAuth requires bounded HTTPS application configuration", () => {
  for (const input of [
    {},
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      callbackUrl: CALLBACK_URL,
    },
    {
      clientId: CLIENT_ID,
      clientSecret: "",
      callbackUrl: CALLBACK_URL,
      fetch: globalThis.fetch,
    },
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      callbackUrl: "http://localhost:4000/",
      fetch: globalThis.fetch,
    },
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      callbackUrl: `${CALLBACK_URL}?code=unsafe`,
      fetch: globalThis.fetch,
    },
  ]) {
    assert.throws(
      () => createGitHubOAuth(input),
      /GitHub OAuth configuration is invalid/,
    );
  }
});

test("authorization URL binds the OAuth App, callback, scopes, and one-time state", () => {
  const { oauth } = harness([]);
  assert.equal(oauth.configured(), true);
  const expected = "https://github.com/login/oauth/authorize"
    + `?client_id=${CLIENT_ID}`
    + `&redirect_uri=${encodeURIComponent(CALLBACK_URL)}`
    + "&scope=repo+workflow"
    + `&state=${STATE}`;
  assert.equal(oauth.authorizationUrl({ state: STATE }), expected);
  assert.equal(createGitHubAuthorizationUrl({
    clientId: CLIENT_ID,
    callbackUrl: CALLBACK_URL,
    state: STATE,
  }), expected);
  assert.throws(
    () => oauth.authorizationUrl({ state: "not-a-github-state" }),
    expectCode("INVALID_REQUEST"),
  );
});

test("authorization state is deterministic for one request and bound to its immutable delivery", () => {
  const { oauth } = harness([]);
  const binding = {
    actor: "builder-sub",
    domainId: "customer_support",
    role: "builder",
    requestId: "authorization-start",
    deliveryId: "delivery-1",
    manifestFingerprint: "a".repeat(64),
    repositoryName: "support-agent",
  };
  const first = oauth.authorizationState(binding);
  const second = oauth.authorizationState(structuredClone(binding));

  assert.equal(first, second);
  assert.match(first, /^gho_[a-f0-9]{64}$/);
  assert.notEqual(
    oauth.authorizationState({
      ...binding,
      repositoryName: "other-agent",
    }),
    first,
  );
  assert.doesNotMatch(first, /builder-sub|support-agent/);
});

test("code exchange returns only the short-lived token and redacts authorization code failures", async () => {
  const { calls, oauth } = harness([
    response(200, {
      access_token: TOKEN,
      token_type: "bearer",
      scope: "repo,workflow",
      expires_in: 28_800,
      refresh_token: "unused-refresh-token",
      refresh_token_expires_in: 15_897_600,
    }),
    response(401, {
      error: "bad_verification_code",
      error_description: `Rejected ${CODE}`,
    }),
  ]);

  const exchange = await oauth.exchange({ code: CODE, state: STATE });
  assert.deepEqual(exchange, { token: TOKEN });
  assert.equal(JSON.stringify(exchange).includes(CODE), false);
  assert.equal(calls[0].url, "https://github.com/login/oauth/access_token");
  assert.equal(calls[0].options.method, "POST");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(
    calls[0].options.headers["content-type"],
    "application/x-www-form-urlencoded;charset=UTF-8",
  );
  assert.equal(
    calls[0].options.body,
    `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
      + `&code=${CODE}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}`,
  );
  await assert.rejects(
    oauth.exchange({ code: CODE, state: STATE }),
    expectCode("AUTHORIZATION_FAILED", [CODE, CLIENT_SECRET]),
  );
});

test("OAuth JSON rejects an oversized declared response before buffering it", async () => {
  let textRead = false;
  const oversized = {
    status: 200,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length"
          ? String(1024 * 1024 + 1)
          : null;
      },
    },
    body: null,
    async text() {
      textRead = true;
      return "{}";
    },
  };
  const { oauth } = harness([oversized]);

  await assert.rejects(
    oauth.exchange({ code: CODE, state: STATE }),
    expectCode("INVALID_RESPONSE"),
  );
  assert.equal(textRead, false);
});

test("code exchange fails closed unless GitHub grants both repository and workflow scopes", async () => {
  for (const scope of ["", "repo", "workflow", "repo,read:user"]) {
    const { oauth } = harness([
      response(200, {
        access_token: TOKEN,
        token_type: "bearer",
        scope,
      }),
    ]);
    await assert.rejects(
      oauth.exchange({ code: CODE, state: STATE }),
      expectCode("AUTHORIZATION_FAILED", [TOKEN, CODE, CLIENT_SECRET]),
    );
  }
});

test("revocation retries only the exchanged token so concurrent deliveries remain independent", async () => {
  const { calls, oauth } = harness([
    response(503, { message: "try again" }),
    response(204, null),
  ]);

  assert.equal(await oauth.revoke({ token: TOKEN }), undefined);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(
      call.url,
      `https://api.github.com/applications/${CLIENT_ID}/token`,
    );
    assert.equal(call.options.method, "DELETE");
    assert.equal(
      call.options.headers.authorization,
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    assert.equal(
      call.options.body,
      JSON.stringify({ access_token: TOKEN }),
    );
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});
