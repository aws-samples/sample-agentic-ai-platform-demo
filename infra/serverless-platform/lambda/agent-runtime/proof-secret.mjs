import {
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  createRuntimeInvocationProof,
} from "./invocation-proof.mjs";

const SECRET_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;
const RUNTIME_ENDPOINT_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/[A-Za-z0-9_-]{1,48}\/runtime-endpoint\/[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONFIG_KEYS = Object.freeze([
  "hmacKey",
  "previousHmacKey",
  "allowedEndpointArn",
  "keyId",
]);
const DEFAULT_CACHE_TTL_MS = 30_000;
const MAX_CACHE_TTL_MS = 5 * 60_000;

function configurationError() {
  return new TypeError(
    "Runtime invocation proof secret configuration is invalid.",
  );
}

function unavailableError() {
  return new Error("Runtime invocation proof secret is unavailable.");
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function exactConfiguration(value) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CONFIG_KEYS.length
    || keys.some((key) => (
      typeof key !== "string"
      || !CONFIG_KEYS.includes(key)
      || !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
  ) {
    return null;
  }
  return Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, descriptors[key].value]),
  );
}

function validHmacKey(value) {
  try {
    createRuntimeInvocationProof({ secret: value });
    return true;
  } catch {
    return false;
  }
}

function validSecretResponse(value, secretArn) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.ARN !== secretArn
    || typeof value.SecretString !== "string"
    || value.SecretBinary !== undefined
    || !Array.isArray(value.VersionStages)
    || !value.VersionStages.includes("AWSCURRENT")
  ) {
    return null;
  }
  let parsed;
  try {
    parsed = exactConfiguration(JSON.parse(value.SecretString));
  } catch {
    return null;
  }
  if (
    parsed === null
    || !validHmacKey(parsed.hmacKey)
    || (
      parsed.previousHmacKey !== null
      && (
        !validHmacKey(parsed.previousHmacKey)
        || parsed.previousHmacKey === parsed.hmacKey
      )
    )
    || typeof parsed.allowedEndpointArn !== "string"
    || !RUNTIME_ENDPOINT_ARN_PATTERN.test(parsed.allowedEndpointArn)
    || typeof parsed.keyId !== "string"
    || !KEY_ID_PATTERN.test(parsed.keyId)
  ) {
    return null;
  }
  return Object.freeze({ ...parsed });
}

function clockTime(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
  ) {
    throw configurationError();
  }
  return milliseconds;
}

export function createRuntimeProofSecretProvider({
  client,
  secretArn,
  clock = Date.now,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  if (
    !client
    || typeof client.send !== "function"
    || typeof secretArn !== "string"
    || !SECRET_ARN_PATTERN.test(secretArn)
    || typeof clock !== "function"
    || !Number.isSafeInteger(cacheTtlMs)
    || cacheTtlMs < 1
    || cacheTtlMs > MAX_CACHE_TTL_MS
  ) {
    throw configurationError();
  }

  let cached = null;
  let cachedUntil = 0;
  let inFlight;
  return async function runtimeProofConfiguration() {
    const now = clockTime(clock);
    if (cached !== null && now < cachedUntil) return cached;
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      const response = await client.send(
        new GetSecretValueCommand({
          SecretId: secretArn,
          VersionStage: "AWSCURRENT",
        }),
      );
      const configuration = validSecretResponse(response, secretArn);
      if (configuration === null) throw unavailableError();
      cached = configuration;
      cachedUntil = now + cacheTtlMs;
      return configuration;
    })();
    try {
      return await inFlight;
    } catch {
      throw unavailableError();
    } finally {
      inFlight = undefined;
    }
  };
}
