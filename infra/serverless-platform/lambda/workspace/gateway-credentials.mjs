import { createHash } from "node:crypto";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";

const PROVIDER_INPUT_KEYS = new Set([
  "sourceIdentity",
  "abortSignal",
]);
const STS_CREDENTIAL_KEYS = new Set([
  "AccessKeyId",
  "SecretAccessKey",
  "SessionToken",
  "Expiration",
]);
const SOURCE_IDENTITY_PATTERN =
  /^(?:platform|domain_[a-z][a-z0-9]*(?:_[a-z0-9]+)*)$/;
const ROLE_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):iam::[0-9]{12}:role\/([A-Za-z0-9+=,.@_-]+(?:\/[A-Za-z0-9+=,.@_-]+)*)$/;
const DEFAULT_DURATION_SECONDS = 900;
const DEFAULT_MAX_CACHE_ENTRIES = 64;
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export class GatewayCredentialsError extends Error {
  constructor(code) {
    const messages = {
      INVALID_GATEWAY_CREDENTIAL_REQUEST:
        "The Gateway credential request is invalid.",
      GATEWAY_CREDENTIALS_UNAVAILABLE:
        "Gateway credentials are temporarily unavailable.",
    };
    if (!Object.hasOwn(messages, code)) {
      throw new TypeError("Gateway credential error code is invalid.");
    }
    super(messages[code]);
    this.name = "GatewayCredentialsError";
    this.code = code;
  }
}

function invalidConfiguration() {
  return new TypeError("Gateway credential configuration is invalid.");
}

function unavailable() {
  return new GatewayCredentialsError(
    "GATEWAY_CREDENTIALS_UNAVAILABLE",
  );
}

function isPlainObject(value) {
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

function strictValues(value, allowedKeys, requiredKeys, errorFactory) {
  if (!isPlainObject(value)) throw errorFactory();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
    || keys.some((key) => (
      !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
    || requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw errorFactory();
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  );
}

function configuredString(value, maxLength) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validRoleArn(value) {
  if (!configuredString(value, 600)) return false;
  const match = ROLE_ARN_PATTERN.exec(value);
  if (!match || match[1].length > 512) return false;
  const roleName = match[1].split("/").at(-1);
  return roleName.length <= 64;
}

function validSourceIdentity(value) {
  return (
    typeof value === "string"
    && value.length >= 2
    && value.length <= 64
    && SOURCE_IDENTITY_PATTERN.test(value)
  );
}

function validAbortSignal(value) {
  return value === undefined || value instanceof AbortSignal;
}

function readNow(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw unavailable();
  }
  const now = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(now.getTime())) throw unavailable();
  return now.getTime();
}

function roleSessionName(sourceIdentity) {
  const digest = createHash("sha256")
    .update(sourceIdentity)
    .digest("hex")
    .slice(0, 32);
  return `agentic-gateway-${digest}`;
}

function normalizeCredentials(output, nowMs, refreshWindowMs) {
  let credentials;
  try {
    if (!isPlainObject(output)) throw unavailable();
    const descriptor = Object.getOwnPropertyDescriptor(
      output,
      "Credentials",
    );
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      throw unavailable();
    }
    credentials = strictValues(
      descriptor.value,
      STS_CREDENTIAL_KEYS,
      [...STS_CREDENTIAL_KEYS],
      unavailable,
    );
  } catch (error) {
    if (error instanceof GatewayCredentialsError) throw error;
    throw unavailable();
  }
  if (
    !configuredString(credentials.AccessKeyId, 256)
    || !configuredString(credentials.SecretAccessKey, 4_096)
    || !configuredString(credentials.SessionToken, 16_384)
    || !(credentials.Expiration instanceof Date)
    || Number.isNaN(credentials.Expiration.getTime())
    || credentials.Expiration.getTime() - nowMs
      <= refreshWindowMs
  ) {
    throw unavailable();
  }
  return Object.freeze({
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expirationMs: credentials.Expiration.getTime(),
  });
}

function externalCredentials(cached) {
  return Object.freeze({
    accessKeyId: cached.accessKeyId,
    secretAccessKey: cached.secretAccessKey,
    sessionToken: cached.sessionToken,
    expiration: new Date(cached.expirationMs),
  });
}

export function createGatewayCredentialsProvider({
  stsClient,
  roleArn,
  durationSeconds = DEFAULT_DURATION_SECONDS,
  clock = () => new Date(),
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
  refreshWindowMs = DEFAULT_REFRESH_WINDOW_MS,
} = {}) {
  if (
    !stsClient
    || typeof stsClient.send !== "function"
    || !validRoleArn(roleArn)
    || !Number.isInteger(durationSeconds)
    || durationSeconds < 900
    || durationSeconds > 3_600
    || typeof clock !== "function"
    || !Number.isInteger(maxCacheEntries)
    || maxCacheEntries < 1
    || maxCacheEntries > 256
    || !Number.isInteger(refreshWindowMs)
    || refreshWindowMs < 1_000
    || refreshWindowMs >= durationSeconds * 1_000
  ) {
    throw invalidConfiguration();
  }

  const cache = new Map();
  return async function provideGatewayCredentials(input) {
    let values;
    try {
      values = strictValues(
        input,
        PROVIDER_INPUT_KEYS,
        ["sourceIdentity"],
        () => new GatewayCredentialsError(
          "INVALID_GATEWAY_CREDENTIAL_REQUEST",
        ),
      );
    } catch (error) {
      if (error instanceof GatewayCredentialsError) throw error;
      throw new GatewayCredentialsError(
        "INVALID_GATEWAY_CREDENTIAL_REQUEST",
      );
    }
    if (
      !validSourceIdentity(values.sourceIdentity)
      || !validAbortSignal(values.abortSignal)
    ) {
      throw new GatewayCredentialsError(
        "INVALID_GATEWAY_CREDENTIAL_REQUEST",
      );
    }

    const nowMs = readNow(clock);
    const cached = cache.get(values.sourceIdentity);
    if (
      cached
      && cached.expirationMs - nowMs > refreshWindowMs
    ) {
      return externalCredentials(cached);
    }
    cache.delete(values.sourceIdentity);

    let output;
    try {
      output = await stsClient.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: roleSessionName(values.sourceIdentity),
          DurationSeconds: durationSeconds,
          SourceIdentity: values.sourceIdentity,
        }),
        values.abortSignal === undefined
          ? {}
          : { abortSignal: values.abortSignal },
      );
    } catch {
      throw unavailable();
    }
    const next = normalizeCredentials(
      output,
      readNow(clock),
      refreshWindowMs,
    );
    while (cache.size >= maxCacheEntries) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(values.sourceIdentity, next);
    return externalCredentials(next);
  };
}
