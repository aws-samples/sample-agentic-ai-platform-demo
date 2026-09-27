import { Buffer } from "node:buffer";
import {
  fromInstanceMetadata,
} from "@smithy/credential-provider-imds";

const CONTAINER_CREDENTIALS_ORIGIN = "http://169.254.170.2";
const MAX_CREDENTIAL_RESPONSE_BYTES = 16 * 1024;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const RELATIVE_URI_PATTERN =
  /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,2047}$/;

function configuredString(value, maxLength) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function invalidConfiguration() {
  return new TypeError("IAM credential configuration is invalid.");
}

function unavailable() {
  return new Error("IAM credentials are unavailable.");
}

function staticCredentials(env) {
  const present = [
    env.AWS_ACCESS_KEY_ID,
    env.AWS_SECRET_ACCESS_KEY,
    env.AWS_SESSION_TOKEN,
  ].some((value) => value !== undefined);
  if (!present) return null;
  if (
    !configuredString(env.AWS_ACCESS_KEY_ID, 256)
    || !configuredString(env.AWS_SECRET_ACCESS_KEY, 4_096)
    || (
      env.AWS_SESSION_TOKEN !== undefined
      && !configuredString(env.AWS_SESSION_TOKEN, 16_384)
    )
  ) {
    throw invalidConfiguration();
  }
  return Object.freeze({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    ...(env.AWS_SESSION_TOKEN === undefined
      ? {}
      : { sessionToken: env.AWS_SESSION_TOKEN }),
  });
}

function metadataUrl(env) {
  const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (relative !== undefined && full !== undefined) {
    throw invalidConfiguration();
  }
  if (relative !== undefined) {
    if (
      !configuredString(relative, 2_048)
      || !RELATIVE_URI_PATTERN.test(relative)
      || relative.includes("//")
      || relative.split("/").includes("..")
    ) {
      throw invalidConfiguration();
    }
    return `${CONTAINER_CREDENTIALS_ORIGIN}${relative}`;
  }
  if (full === undefined) return null;
  if (!configuredString(full, 2_048)) {
    throw invalidConfiguration();
  }
  let url;
  try {
    url = new URL(full);
  } catch {
    throw invalidConfiguration();
  }
  if (
    url.origin !== CONTAINER_CREDENTIALS_ORIGIN
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !RELATIVE_URI_PATTERN.test(url.pathname)
    || url.pathname.includes("//")
    || url.pathname.split("/").includes("..")
    || url.href !== full
  ) {
    throw invalidConfiguration();
  }
  return full;
}

async function boundedResponseText(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (
    contentLength !== null
    && contentLength !== undefined
    && (
      !/^(?:0|[1-9][0-9]*)$/.test(contentLength)
      || Number(contentLength) > MAX_CREDENTIAL_RESPONSE_BYTES
    )
  ) {
    throw unavailable();
  }
  if (typeof response.body?.getReader !== "function") {
    const text = await response.text();
    if (
      typeof text !== "string"
      || Buffer.byteLength(text, "utf8")
        > MAX_CREDENTIAL_RESPONSE_BYTES
    ) {
      throw unavailable();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (!part || typeof part.done !== "boolean") {
        throw unavailable();
      }
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw unavailable();
      }
      totalBytes += part.value.byteLength;
      if (totalBytes > MAX_CREDENTIAL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw unavailable();
      }
      chunks.push(Buffer.from(
        part.value.buffer,
        part.value.byteOffset,
        part.value.byteLength,
      ));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, totalBytes),
    );
  } catch {
    throw unavailable();
  }
}

function parseCredentialResponse(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw unavailable();
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !configuredString(value.AccessKeyId, 256)
    || !configuredString(value.SecretAccessKey, 4_096)
    || !configuredString(value.Token, 16_384)
    || !configuredString(value.Expiration, 128)
  ) {
    throw unavailable();
  }
  const expiration = new Date(value.Expiration);
  if (Number.isNaN(expiration.getTime())) {
    throw unavailable();
  }
  return Object.freeze({
    accessKeyId: value.AccessKeyId,
    secretAccessKey: value.SecretAccessKey,
    sessionToken: value.Token,
    expiration,
  });
}

export function createIamCredentialsProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  instanceMetadataProviderFactory = fromInstanceMetadata,
} = {}) {
  if (
    !env
    || typeof env !== "object"
    || typeof fetchImpl !== "function"
    || typeof clock !== "function"
    || typeof instanceMetadataProviderFactory !== "function"
  ) {
    throw invalidConfiguration();
  }
  const fixedCredentials = staticCredentials(env);
  const url = metadataUrl(env);
  if (fixedCredentials !== null && url !== null) {
    throw invalidConfiguration();
  }
  const authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  if (
    authorization !== undefined
    && !configuredString(authorization, 4_096)
  ) {
    throw invalidConfiguration();
  }

  if (fixedCredentials !== null) {
    return async function provideStaticCredentials() {
      return fixedCredentials;
    };
  }

  if (url === null) {
    let instanceMetadataProvider;
    try {
      instanceMetadataProvider = instanceMetadataProviderFactory({
        ec2MetadataV1Disabled: true,
        maxRetries: 1,
        timeout: 1_000,
      });
    } catch {
      throw invalidConfiguration();
    }
    if (typeof instanceMetadataProvider !== "function") {
      throw invalidConfiguration();
    }
    return async function provideInstanceMetadataCredentials(options = {}) {
      try {
        return await instanceMetadataProvider(options);
      } catch {
        throw unavailable();
      }
    };
  }

  let cached = null;
  return async function provideContainerCredentials({
    abortSignal,
  } = {}) {
    const nowValue = clock();
    const now = nowValue instanceof Date
      ? nowValue
      : new Date(nowValue);
    if (Number.isNaN(now.getTime())) throw unavailable();
    if (
      cached
      && cached.expiration.getTime() - now.getTime()
        > REFRESH_WINDOW_MS
    ) {
      return cached;
    }

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          ...(authorization === undefined
            ? {}
            : { authorization }),
          accept: "application/json",
        },
        ...(abortSignal === undefined
          ? {}
          : { signal: abortSignal }),
      });
    } catch {
      throw unavailable();
    }
    if (!response?.ok) throw unavailable();
    cached = parseCredentialResponse(
      await boundedResponseText(response),
    );
    if (cached.expiration.getTime() <= now.getTime()) {
      cached = null;
      throw unavailable();
    }
    return cached;
  };
}
