function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

export function randomUrlSafe(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function buildAuthorizeUrl(config, values) {
  const url = new URL("/oauth2/authorize", config.domain);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(" "),
    state: values.state,
    code_challenge: values.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function decodeJwtPayload(token) {
  try {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) return {};

    const payload = parts[1];
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) return {};

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function tokenIsUsable(tokens, now = Date.now()) {
  return Boolean(
    typeof tokens?.accessToken === "string"
      && tokens.accessToken.trim()
      && Number(tokens.expiresAt) > now + 30_000,
  );
}
