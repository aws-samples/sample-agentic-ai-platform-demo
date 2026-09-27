import { createHmac } from "node:crypto";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_URL = "https://api.github.com";
const MAX_TEXT_BYTES = 2048;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REVOKE_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;
const STATE_PATTERN = /^gho_[A-Za-z0-9_-]{32,128}$/;
const AUTHORIZATION_STATE_KEYS = Object.freeze([
  "actor",
  "domainId",
  "role",
  "requestId",
  "deliveryId",
  "manifestFingerprint",
  "repositoryName",
]);
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export class GitHubOAuthError extends Error {
  constructor(code) {
    super("GitHub OAuth operation failed.");
    this.name = "GitHubOAuthError";
    this.code = code;
  }
}

function fail(code) {
  throw new GitHubOAuthError(code);
}

function text(value, maxBytes = MAX_TEXT_BYTES) {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && Buffer.byteLength(value) <= maxBytes
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validCallbackUrl(value) {
  if (!text(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function createGitHubAuthorizationUrl({
  clientId,
  callbackUrl,
  state,
} = {}) {
  if (
    !text(clientId, 256)
    || !validCallbackUrl(callbackUrl)
  ) {
    throw new TypeError("GitHub OAuth configuration is invalid.");
  }
  if (!STATE_PATTERN.test(state)) fail("INVALID_REQUEST");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: "repo workflow",
    state,
  });
  return `${AUTHORIZE_URL}?${query}`;
}

function plain(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

async function json(response) {
  const declaredLength = response.headers?.get?.("content-length");
  if (
    declaredLength !== null
    && declaredLength !== undefined
    && (
      !/^(?:0|[1-9][0-9]*)$/.test(declaredLength)
      || Number(declaredLength) > MAX_RESPONSE_BYTES
    )
  ) {
    fail("INVALID_RESPONSE");
  }
  let body;
  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) fail("INVALID_RESPONSE");
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) fail("INVALID_RESPONSE");
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof GitHubOAuthError) throw error;
      fail("INVALID_RESPONSE");
    }
    body = Buffer.concat(chunks, size).toString("utf8");
  } else {
    body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      fail("INVALID_RESPONSE");
    }
  }
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    fail("INVALID_RESPONSE");
  }
}

function exchangeError(response) {
  if (response.status === 429) return "RATE_LIMITED";
  if (response.status >= 500) return "UNAVAILABLE";
  return "AUTHORIZATION_FAILED";
}

export function createGitHubOAuth({
  clientId,
  clientSecret,
  callbackUrl: configuredCallbackUrl,
  fetch: fetchImpl,
} = {}) {
  if (
    !text(clientId, 256)
    || !text(clientSecret)
    || !validCallbackUrl(configuredCallbackUrl)
    || typeof fetchImpl !== "function"
  ) {
    throw new TypeError("GitHub OAuth configuration is invalid.");
  }

  return Object.freeze({
    configured() {
      return true;
    },

    authorizationState(binding) {
      if (
        !plain(binding)
        || Object.keys(binding).sort().join(",")
          !== [...AUTHORIZATION_STATE_KEYS].sort().join(",")
        || !text(binding.actor, 256)
        || !SUBJECT_PATTERN.test(binding.actor)
        || !DOMAIN_PATTERN.test(binding.domainId)
        || !new Set(["admin", "lead", "builder"]).has(binding.role)
        || !text(binding.requestId, 128)
        || !REQUEST_ID_PATTERN.test(binding.requestId)
        || !ID_PATTERN.test(binding.deliveryId)
        || !FINGERPRINT_PATTERN.test(binding.manifestFingerprint)
        || !REPOSITORY_PATTERN.test(binding.repositoryName)
      ) {
        fail("INVALID_REQUEST");
      }
      const payload = JSON.stringify(
        AUTHORIZATION_STATE_KEYS.map((key) => binding[key]),
      );
      return `gho_${createHmac("sha256", clientSecret)
        .update(payload)
        .digest("hex")}`;
    },

    authorizationUrl({ state } = {}) {
      return createGitHubAuthorizationUrl({
        clientId,
        callbackUrl: configuredCallbackUrl,
        state,
      });
    },

    async exchange({ code, state } = {}) {
      if (!text(code) || !STATE_PATTERN.test(state)) fail("INVALID_REQUEST");
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: configuredCallbackUrl,
      });
      let response;
      try {
        response = await fetchImpl(TOKEN_URL, {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "user-agent": "agentic-platform-journey-delivery",
          },
          body: body.toString(),
        });
      } catch {
        fail("UNAVAILABLE");
      }
      if (!response || typeof response.status !== "number"
        || typeof response.text !== "function") {
        fail("INVALID_RESPONSE");
      }
      const value = await json(response);
      if (response.status < 200 || response.status >= 300) {
        fail(exchangeError(response));
      }
      if (
        !plain(value)
        || !text(value.access_token)
        || typeof value.token_type !== "string"
        || value.token_type.toLowerCase() !== "bearer"
        || typeof value.scope !== "string"
        || Buffer.byteLength(value.scope) > 512
        || /[\u0000-\u001f\u007f]/.test(value.scope)
      ) {
        fail("INVALID_RESPONSE");
      }
      const scopes = new Set(
        value.scope.split(",").map((scope) => scope.trim()).filter(Boolean),
      );
      if (!scopes.has("repo") || !scopes.has("workflow")) {
        fail("AUTHORIZATION_FAILED");
      }
      return { token: value.access_token };
    },

    async revoke({ token } = {}) {
      if (!text(token)) fail("INVALID_REQUEST");
      const authorization = `Basic ${Buffer.from(
        `${clientId}:${clientSecret}`,
      ).toString("base64")}`;
      for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt += 1) {
        let response;
        try {
          response = await fetchImpl(
            `${API_URL}/applications/${encodeURIComponent(clientId)}/token`,
            {
              method: "DELETE",
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              headers: {
                accept: "application/vnd.github+json",
                authorization,
                "content-type": "application/json",
                "user-agent": "agentic-platform-journey-delivery",
              },
              body: JSON.stringify({ access_token: token }),
            },
          );
        } catch {
          if (attempt + 1 === REVOKE_ATTEMPTS) fail("REVOCATION_FAILED");
          continue;
        }
        if (!response || typeof response.status !== "number"
          || typeof response.text !== "function") {
          if (attempt + 1 === REVOKE_ATTEMPTS) fail("REVOCATION_FAILED");
          continue;
        }
        await json(response);
        if (response.status >= 200 && response.status < 300) return;
        if (
          (response.status === 429 || response.status >= 500)
          && attempt + 1 < REVOKE_ATTEMPTS
        ) {
          continue;
        }
        fail("REVOCATION_FAILED");
      }
    },
  });
}
