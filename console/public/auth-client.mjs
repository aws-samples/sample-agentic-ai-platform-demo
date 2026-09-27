import {
  buildAuthorizeUrl,
  codeChallenge,
  randomUrlSafe,
  tokenIsUsable,
} from "./auth-core.mjs";

const TOKENS_KEY = "console.cognito.tokens";
const FLOW_KEY = "console.cognito.flow";
const DEMO_CONTEXT_KEY = "console.demo-context";
const STORAGE_ERROR_MESSAGE = "Browser session storage is unavailable.";
const OAUTH_QUERY_PARAMETERS = [
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
];

function runtime() {
  return window.__RUNTIME_CONFIG__ || {
    authMode: "mock",
    apiBaseUrl: "/api",
  };
}

function readJson(key) {
  let value;
  try {
    value = sessionStorage.getItem(key);
  } catch {
    throw new Error(STORAGE_ERROR_MESSAGE);
  }
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    if (value == null) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error(STORAGE_ERROR_MESSAGE);
  }
}

function removeSessionKeys(keys) {
  let failed = false;
  for (const key of keys) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error(STORAGE_ERROR_MESSAGE);
}

function validateHttpsUrl(value, field) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(`Cognito configuration has an invalid ${field}.`);
  }
}

function requiredCognitoConfig(fields) {
  if (authMode() !== "cognito") {
    throw new Error("Cognito authentication is not configured.");
  }

  const config = runtime().cognito || {};
  for (const field of fields) {
    const value = config[field];
    const missing = field === "scopes"
      ? !Array.isArray(value)
        || value.length === 0
        || value.some((scope) => typeof scope !== "string" || !scope.trim())
      : typeof value !== "string" || !value.trim();
    if (missing) {
      throw new Error(`Cognito configuration is missing ${field}.`);
    }
  }

  for (const field of ["domain", "redirectUri", "logoutUri"]) {
    if (fields.includes(field)) {
      validateHttpsUrl(config[field], field);
    }
  }

  return config;
}

function cleanOAuthQuery(url) {
  for (const parameter of OAUTH_QUERY_PARAMETERS) {
    url.searchParams.delete(parameter);
  }
  const search = url.searchParams.toString();
  const nextUrl = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
  window.history.replaceState(
    window.history.state,
    document.title,
    nextUrl,
  );
}

export function authMode() {
  return runtime().authMode === "cognito" ? "cognito" : "mock";
}

export function getAccessToken() {
  if (authMode() !== "cognito") return null;
  const tokens = readJson(TOKENS_KEY);
  if (!tokenIsUsable(tokens)) {
    removeSessionKeys([TOKENS_KEY, DEMO_CONTEXT_KEY]);
    return null;
  }
  writeJson(TOKENS_KEY, {
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
    expiresAt: tokens.expiresAt,
  });
  return tokens.accessToken;
}

export async function beginSignIn() {
  const config = requiredCognitoConfig([
    "domain",
    "clientId",
    "redirectUri",
    "scopes",
  ]);
  const verifier = randomUrlSafe(48);
  const state = randomUrlSafe(24);
  const challenge = await codeChallenge(verifier);

  writeJson(FLOW_KEY, { verifier, state });
  window.location.assign(buildAuthorizeUrl(config, { state, challenge }));
}

export async function completeSignIn() {
  if (authMode() !== "cognito") return false;

  const url = new URL(window.location.href);
  const oauthError = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (!oauthError && !code) return false;

  let completed = false;
  let failure;
  try {
    const state = url.searchParams.get("state");
    const flow = readJson(FLOW_KEY);
    if (
      !flow
      || typeof flow.verifier !== "string"
      || !flow.verifier
      || typeof flow.state !== "string"
      || !state
      || state !== flow.state
    ) {
      writeJson(FLOW_KEY, null);
      throw new Error("Cognito sign-in state did not match.");
    }

    const verifier = flow.verifier;
    writeJson(FLOW_KEY, null);
    if (oauthError) {
      throw new Error("Cognito authorization failed.");
    }

    const config = requiredCognitoConfig([
      "domain",
      "clientId",
      "redirectUri",
    ]);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    });

    let response;
    try {
      response = await fetch(new URL("/oauth2/token", config.domain), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch {
      throw new Error("Cognito token exchange failed.");
    }
    if (!response.ok) {
      throw new Error("Cognito token exchange failed.");
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Cognito token response was invalid.");
    }
    const expiresIn = Number(result?.expires_in);
    if (
      !result
      || typeof result.access_token !== "string"
      || !result.access_token.trim()
      || typeof result.id_token !== "string"
      || !result.id_token.trim()
      || !Number.isFinite(expiresIn)
      || expiresIn <= 0
    ) {
      throw new Error("Cognito token response was invalid.");
    }

    writeJson(TOKENS_KEY, {
      accessToken: result.access_token,
      idToken: result.id_token,
      expiresAt: Date.now() + expiresIn * 1_000,
    });
    completed = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      cleanOAuthQuery(url);
    } catch (error) {
      if (!failure) failure = error;
    }
  }

  if (failure) throw failure;
  return completed;
}

export function clearAuthentication() {
  removeSessionKeys([TOKENS_KEY, FLOW_KEY, DEMO_CONTEXT_KEY]);
}

export function signOut() {
  let logoutUrl;
  let configurationError;
  try {
    const config = requiredCognitoConfig([
      "domain",
      "clientId",
      "logoutUri",
    ]);

    const url = new URL("/logout", config.domain);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      logout_uri: config.logoutUri,
    }).toString();
    logoutUrl = url.toString();
  } catch (error) {
    configurationError = error;
  }

  let cleanupError;
  try {
    clearAuthentication();
  } catch {
    cleanupError = new Error(STORAGE_ERROR_MESSAGE);
  }

  if (logoutUrl) window.location.assign(logoutUrl);
  if (configurationError) throw configurationError;
  if (cleanupError) throw cleanupError;
}
