import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const PROOF_VERSION = "v2";
const ENVELOPE_KEYS = Object.freeze([
  "version",
  "audience",
  "issuedAt",
  "expiresAt",
  "nonce",
  "signature",
]);
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 1_024;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_AUDIENCE_BYTES = 1_024;
const MAX_DEPTH = 6;
const MAX_PROPERTIES = 64;
const NONCE_BYTES = 32;
const MAX_PROOF_TTL_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_REPLAY_CACHE_ENTRIES = 100_000;

export const DEFAULT_RUNTIME_PROOF_TTL_MS = 60_000;
export const DEFAULT_RUNTIME_PROOF_FUTURE_SKEW_MS = 5_000;
export const DEFAULT_RUNTIME_PROOF_REPLAY_CACHE_ENTRIES = 4_096;

function invalidConfiguration() {
  return new TypeError("Runtime invocation proof configuration is invalid.");
}

function invalidPayload() {
  return new TypeError("Runtime invocation proof payload is invalid.");
}

function secretBytes(secret) {
  if (
    typeof secret !== "string"
    || /[\u0000-\u001f\u007f]/.test(secret)
  ) {
    throw invalidConfiguration();
  }
  const bytes = Buffer.from(secret, "utf8");
  if (
    bytes.byteLength < MIN_SECRET_BYTES
    || bytes.byteLength > MAX_SECRET_BYTES
  ) {
    throw invalidConfiguration();
  }
  return bytes;
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, state, depth) {
  if (depth > MAX_DEPTH) throw invalidPayload();
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
      throw invalidPayload();
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw invalidPayload();
    return String(value);
  }
  if (!isPlainObject(value)) throw invalidPayload();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_PROPERTIES
    || keys.some((key) => typeof key !== "string")
    || keys.some((key) => (
      !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
  ) {
    throw invalidPayload();
  }

  const entries = [];
  for (const key of [...keys].sort()) {
    const encodedKey = JSON.stringify(key);
    const encodedValue = canonicalValue(
      descriptors[key].value,
      state,
      depth + 1,
    );
    entries.push(`${encodedKey}:${encodedValue}`);
    state.properties += 1;
    if (state.properties > MAX_PROPERTIES) throw invalidPayload();
  }
  return `{${entries.join(",")}}`;
}

function canonicalPayload(payload) {
  const encoded = canonicalValue(payload, { properties: 0 }, 0);
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) throw invalidPayload();
  return bytes;
}

function digest(key, value) {
  return createHmac("sha256", key)
    .update(canonicalPayload(value))
    .digest();
}

function validAudience(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= MAX_AUDIENCE_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function clockTime(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
  ) {
    throw invalidConfiguration();
  }
  return milliseconds;
}

function nonceText(nonce) {
  const value = nonce();
  if (
    !Buffer.isBuffer(value)
    && !(value instanceof Uint8Array)
  ) {
    throw invalidConfiguration();
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== NONCE_BYTES) {
    throw invalidConfiguration();
  }
  return bytes.toString("base64url");
}

function exactEnvelope(value) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== ENVELOPE_KEYS.length
    || keys.some((key) => (
      typeof key !== "string"
      || !ENVELOPE_KEYS.includes(key)
      || !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
  ) {
    return null;
  }
  return Object.fromEntries(
    ENVELOPE_KEYS.map((key) => [key, descriptors[key].value]),
  );
}

function signedEnvelopeValue(payload, envelope) {
  return {
    version: envelope.version,
    audience: envelope.audience,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    payload,
  };
}

function decodeDigest(value) {
  if (
    typeof value !== "string"
    || !BASE64URL_32_BYTES_PATTERN.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.byteLength !== 32
    || bytes.toString("base64url") !== value
  ) {
    return null;
  }
  return bytes;
}

export function createRuntimeProofReplayCache({
  maxEntries = DEFAULT_RUNTIME_PROOF_REPLAY_CACHE_ENTRIES,
} = {}) {
  if (
    !Number.isSafeInteger(maxEntries)
    || maxEntries < 1
    || maxEntries > MAX_REPLAY_CACHE_ENTRIES
  ) {
    throw invalidConfiguration();
  }
  const entries = new Map();
  return Object.freeze({
    consume(key, expiresAt, now) {
      if (
        typeof key !== "string"
        || !Number.isSafeInteger(expiresAt)
        || !Number.isSafeInteger(now)
        || expiresAt <= now
      ) {
        return false;
      }
      // Process-local only: concurrent Runtime instances cannot share nonces.
      for (const [candidate, expiry] of entries) {
        if (expiry <= now) entries.delete(candidate);
      }
      if (entries.has(key) || entries.size >= maxEntries) {
        return false;
      }
      entries.set(key, expiresAt);
      return true;
    },
  });
}

export function createRuntimeInvocationProof({
  secret,
  clock = Date.now,
  nonce = () => randomBytes(NONCE_BYTES),
  proofTtlMs = DEFAULT_RUNTIME_PROOF_TTL_MS,
  maxFutureSkewMs = DEFAULT_RUNTIME_PROOF_FUTURE_SKEW_MS,
  replayCache,
  replayCacheMaxEntries = DEFAULT_RUNTIME_PROOF_REPLAY_CACHE_ENTRIES,
} = {}) {
  if (
    typeof clock !== "function"
    || typeof nonce !== "function"
    || !Number.isSafeInteger(proofTtlMs)
    || proofTtlMs < 1
    || proofTtlMs > MAX_PROOF_TTL_MS
    || !Number.isSafeInteger(maxFutureSkewMs)
    || maxFutureSkewMs < 0
    || maxFutureSkewMs > MAX_FUTURE_SKEW_MS
    || (
      replayCache !== undefined
      && (
        replayCache === null
        || typeof replayCache.consume !== "function"
      )
    )
  ) {
    throw invalidConfiguration();
  }
  const key = Buffer.from(secretBytes(secret));
  const consumedNonces = replayCache ?? createRuntimeProofReplayCache({
    maxEntries: replayCacheMaxEntries,
  });

  return Object.freeze({
    sign(payload, audience) {
      if (!validAudience(audience)) throw invalidPayload();
      const issuedAt = clockTime(clock);
      const envelope = {
        version: PROOF_VERSION,
        audience,
        issuedAt,
        expiresAt: issuedAt + proofTtlMs,
        nonce: nonceText(nonce),
      };
      if (!Number.isSafeInteger(envelope.expiresAt)) {
        throw invalidConfiguration();
      }
      return Object.freeze({
        ...envelope,
        signature: digest(
          key,
          signedEnvelopeValue(payload, envelope),
        ).toString("base64url"),
      });
    },

    verify(payload, proof, audience) {
      try {
        if (!validAudience(audience)) return false;
        const envelope = exactEnvelope(proof);
        if (
          envelope === null
          || envelope.version !== PROOF_VERSION
          || envelope.audience !== audience
          || !Number.isSafeInteger(envelope.issuedAt)
          || envelope.issuedAt < 0
          || !Number.isSafeInteger(envelope.expiresAt)
          || envelope.expiresAt - envelope.issuedAt !== proofTtlMs
          || typeof envelope.nonce !== "string"
          || !BASE64URL_32_BYTES_PATTERN.test(envelope.nonce)
          || Buffer.from(
            envelope.nonce,
            "base64url",
          ).toString("base64url") !== envelope.nonce
        ) {
          return false;
        }
        const now = clockTime(clock);
        if (
          envelope.expiresAt <= now
          || envelope.issuedAt > now + maxFutureSkewMs
        ) {
          return false;
        }
        const supplied = decodeDigest(envelope.signature);
        if (supplied === null) return false;
        const expected = digest(
          key,
          signedEnvelopeValue(payload, envelope),
        );
        if (!timingSafeEqual(expected, supplied)) return false;
        return consumedNonces.consume(
          envelope.nonce,
          envelope.expiresAt,
          now,
        ) === true;
      } catch {
        return false;
      }
    },
  });
}
