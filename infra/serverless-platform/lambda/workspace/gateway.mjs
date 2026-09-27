import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { gatewayMetering, validUsage } from "../agent-runtime/usage.mjs";

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_GATEWAY_REQUEST: Object.freeze({
    message: "The Gateway invocation request is invalid.",
    statusCode: 400,
    retryable: false,
  }),
  GATEWAY_CREDENTIALS_UNAVAILABLE: Object.freeze({
    message: "Gateway credentials are temporarily unavailable.",
    statusCode: 503,
    retryable: true,
  }),
  GATEWAY_INVOCATION_FAILED: Object.freeze({
    message: "The Gateway invocation failed.",
    statusCode: 502,
    retryable: true,
  }),
  GATEWAY_INVOCATION_REJECTED: Object.freeze({
    message: "The Gateway rejected the invocation.",
    statusCode: 502,
    retryable: false,
  }),
  MALFORMED_GATEWAY_RESPONSE: Object.freeze({
    message: "The Gateway returned a malformed response.",
    statusCode: 502,
    retryable: false,
  }),
  GATEWAY_RESPONSE_TOO_LARGE: Object.freeze({
    message: "The Gateway response exceeded the allowed size.",
    statusCode: 502,
    retryable: false,
  }),
  GATEWAY_ABORTED: Object.freeze({
    message: "The Gateway invocation was aborted.",
    statusCode: 499,
    retryable: false,
  }),
  GATEWAY_TIMEOUT: Object.freeze({
    message: "The Gateway invocation timed out.",
    statusCode: 504,
    retryable: true,
  }),
});

const MAX_MODEL_ID_LENGTH = 512;
const MAX_PROMPT_LENGTH = 16_384;
const MAX_TOKENS = 8_192;
const MAX_REQUEST_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const INVOCATION_KEYS = new Set([
  "modelId",
  "prompt",
  "maxTokens",
  "sourceIdentity",
  "abortSignal",
  "onUsage",
]);
const SOURCE_IDENTITY_PATTERN =
  /^(?:platform|domain_[a-z][a-z0-9]*(?:_[a-z0-9]+)*)$/;
const CREDENTIAL_KEYS = new Set([
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "expiration",
]);

export class AgentCoreGatewayError extends Error {
  constructor(code, { upstreamStatusCode } = {}) {
    const definition = ERROR_DEFINITIONS[code];
    if (!definition) {
      throw new TypeError("Gateway error code is invalid.");
    }
    super(definition.message);
    this.name = "AgentCoreGatewayError";
    this.code = code;
    this.statusCode = definition.statusCode;
    this.retryable = definition.retryable;
    if (
      Number.isInteger(upstreamStatusCode)
      && upstreamStatusCode >= 100
      && upstreamStatusCode <= 599
    ) {
      this.upstreamStatusCode = upstreamStatusCode;
    }
  }
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

function hashHex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function nonEmptyString(value, maxLength) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validModelId(value) {
  return (
    typeof value === "string"
    && value.length <= MAX_MODEL_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    && !value.includes("://")
  );
}

function validPrompt(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PROMPT_LENGTH
    && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function validGatewayBaseUrl(value, region) {
  if (typeof value !== "string" || !value) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostSuffix =
    `.gateway.bedrock-agentcore.${region}.amazonaws.com`;
  const gatewayId = url.hostname.endsWith(hostSuffix)
    ? url.hostname.slice(0, -hostSuffix.length)
    : "";
  const gatewayMatch =
    /^([a-z0-9]+(?:-[a-z0-9]+)*)-([a-z0-9]{10})$/.exec(
      gatewayId,
    );
  return (
    url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && url.port === ""
    && gatewayMatch !== null
    && gatewayMatch[1].length <= 100
    && url.pathname === "/inference/v1"
    && url.search === ""
    && url.hash === ""
    && url.href === value
  );
}

function validateInvocation(input) {
  if (!isPlainObject(input)) {
    throw new AgentCoreGatewayError("INVALID_GATEWAY_REQUEST");
  }
  const ownKeys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    ownKeys.some(
      (key) => typeof key !== "string" || !INVOCATION_KEYS.has(key),
    )
    || ownKeys.some((key) => (
      !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
    || !Object.hasOwn(descriptors, "modelId")
    || !Object.hasOwn(descriptors, "prompt")
    || !Object.hasOwn(descriptors, "maxTokens")
    || !Object.hasOwn(descriptors, "sourceIdentity")
  ) {
    throw new AgentCoreGatewayError("INVALID_GATEWAY_REQUEST");
  }
  const modelId = descriptors.modelId.value;
  const prompt = descriptors.prompt.value;
  const maxTokens = descriptors.maxTokens.value;
  const sourceIdentity = descriptors.sourceIdentity.value;
  const abortSignal = descriptors.abortSignal?.value;
  const onUsage = descriptors.onUsage?.value;
  if (
    !validModelId(modelId)
    || !validPrompt(prompt)
    || !Number.isInteger(maxTokens)
    || maxTokens < 1
    || maxTokens > MAX_TOKENS
    || typeof sourceIdentity !== "string"
    || sourceIdentity.length < 2
    || sourceIdentity.length > 64
    || !SOURCE_IDENTITY_PATTERN.test(sourceIdentity)
    || (onUsage !== undefined && typeof onUsage !== "function")
    || (
      abortSignal !== undefined
      && !(abortSignal instanceof AbortSignal)
    )
  ) {
    throw new AgentCoreGatewayError("INVALID_GATEWAY_REQUEST");
  }
  return {
    modelId,
    prompt,
    maxTokens,
    sourceIdentity,
    abortSignal,
    onUsage,
  };
}

function normalizeCredentials(credentials) {
  if (!isPlainObject(credentials)) {
    throw new AgentCoreGatewayError(
      "GATEWAY_CREDENTIALS_UNAVAILABLE",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(credentials);
  const keys = Reflect.ownKeys(credentials);
  if (
    keys.some(
      (key) => typeof key !== "string" || !CREDENTIAL_KEYS.has(key),
    )
    || keys.some((key) => (
      !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
    || !Object.hasOwn(descriptors, "accessKeyId")
    || !Object.hasOwn(descriptors, "secretAccessKey")
  ) {
    throw new AgentCoreGatewayError(
      "GATEWAY_CREDENTIALS_UNAVAILABLE",
    );
  }
  const accessKeyId = descriptors.accessKeyId.value;
  const secretAccessKey = descriptors.secretAccessKey.value;
  const sessionToken = descriptors.sessionToken?.value;
  const expiration = descriptors.expiration?.value;
  if (
    !nonEmptyString(accessKeyId, 256)
    || !nonEmptyString(secretAccessKey, 4096)
    || (
      sessionToken !== undefined
      && !nonEmptyString(sessionToken, 16_384)
    )
    || (
      expiration !== undefined
      && (
        !(expiration instanceof Date)
        || Number.isNaN(expiration.getTime())
      )
    )
  ) {
    throw new AgentCoreGatewayError(
      "GATEWAY_CREDENTIALS_UNAVAILABLE",
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
  };
}

function signRequest({
  body,
  credentials,
  extraHeaders = {},
  now,
  region,
  url,
}) {
  const parsedUrl = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex(body);
  const baseHeaders = {
    ...extraHeaders,
    "content-type": "application/json",
    host: parsedUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) {
    baseHeaders["x-amz-security-token"] = credentials.sessionToken;
  }
  const canonicalHeaders = Object.entries(baseHeaders)
    .map(([key, value]) => [
      key.toLowerCase(),
      String(value).trim().replace(/\s+/g, " "),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = canonicalHeaders
    .map(([key]) => key)
    .join(";");
  const canonicalRequest = [
    "POST",
    parsedUrl.pathname,
    "",
    canonicalHeaders
      .map(([key, value]) => `${key}:${value}\n`)
      .join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const service = "bedrock-agentcore";
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hashHex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(
    `AWS4${credentials.secretAccessKey}`,
    dateStamp,
  );
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");

  return {
    ...baseHeaders,
    Authorization:
      "AWS4-HMAC-SHA256 "
      + `Credential=${credentials.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function isClaudeModel(modelId) {
  return (
    /(^|\/)anthropic\.claude-|(^|\/)claude-/i.test(modelId)
    || /claude-(?:opus|sonnet|haiku|fable)/i.test(modelId)
  );
}

function responseRequestId(response) {
  const headers = response?.headers;
  if (!headers || typeof headers.get !== "function") return null;
  for (const name of ["x-amzn-requestid", "x-amz-request-id"]) {
    let value;
    try {
      value = headers.get(name);
    } catch {
      throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
    }
    if (typeof value === "string" && REQUEST_ID_PATTERN.test(value)) {
      return value;
    }
  }
  return null;
}

function logGatewayFailure(logger, error) {
  if (!(error instanceof AgentCoreGatewayError)) return;
  try {
    logger.error({
      event: "agentcore_gateway_invocation_failed",
      code: error.code,
      retryable: error.retryable,
      ...(Number.isInteger(error.upstreamStatusCode)
        ? { upstreamStatusCode: error.upstreamStatusCode }
        : {}),
    });
  } catch {
    // Diagnostics must never replace the stable Gateway error.
  }
}

function parseOpenAiResponse(payload, requestId) {
  const output = payload?.choices?.[0]?.message?.content;
  const usage = payload?.usage;
  if (
    typeof output !== "string"
    || !isPlainObject(usage)
    || !Number.isSafeInteger(usage.prompt_tokens)
    || usage.prompt_tokens < 0
    || !Number.isSafeInteger(usage.completion_tokens)
    || usage.completion_tokens < 0
    || !Number.isSafeInteger(usage.total_tokens)
    || usage.total_tokens < 0
  ) {
    throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
  }
  return {
    output,
    metering: providerMetering(payload, "openai"),
    ...(requestId === null ? {} : { requestId }),
    usage: {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    },
  };
}

function parseAnthropicResponse(payload, requestId) {
  const usage = payload?.usage;
  if (
    !Array.isArray(payload?.content)
    || !isPlainObject(usage)
    || !Number.isSafeInteger(usage.input_tokens)
    || usage.input_tokens < 0
    || !Number.isSafeInteger(usage.output_tokens)
    || usage.output_tokens < 0
  ) {
    throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
  }
  const text = [];
  for (const block of payload.content) {
    if (
      isPlainObject(block)
      && block.type === "text"
      && typeof block.text === "string"
    ) {
      text.push(block.text);
    }
  }
  if (text.length === 0) {
    throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
  }
  return {
    output: text.join(""),
    metering: providerMetering(payload, "anthropic"),
    ...(requestId === null ? {} : { requestId }),
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    },
  };
}

function providerMetering(payload, protocol) {
  try {
    return gatewayMetering(payload, protocol);
  } catch {
    throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
  }
}

function createInvocationScope(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let abortError = null;
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const abortWith = (code) => {
    if (abortError) return;
    abortError = new AgentCoreGatewayError(code);
    controller.abort();
    rejectAbort(abortError);
  };
  const onExternalAbort = () => abortWith("GATEWAY_ABORTED");
  externalSignal?.addEventListener(
    "abort",
    onExternalAbort,
    { once: true },
  );
  const timer = setTimeout(
    () => abortWith("GATEWAY_TIMEOUT"),
    timeoutMs,
  );

  return {
    signal: controller.signal,
    async run(operation) {
      if (abortError) throw abortError;
      return Promise.race([
        Promise.resolve().then(operation),
        aborted,
      ]);
    },
    close() {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.(
        "abort",
        onExternalAbort,
      );
    },
  };
}

async function readResponseText(response, run) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
    }
    if (Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new AgentCoreGatewayError("GATEWAY_RESPONSE_TOO_LARGE");
    }
  }

  if (typeof response.body?.getReader === "function") {
    const reader = response.body.getReader();
    if (
      !reader
      || typeof reader.read !== "function"
      || typeof reader.releaseLock !== "function"
    ) {
      throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
    }
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const part = await run(() => reader.read());
        if (!part || typeof part.done !== "boolean") {
          throw new AgentCoreGatewayError(
            "MALFORMED_GATEWAY_RESPONSE",
          );
        }
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) {
          throw new AgentCoreGatewayError(
            "MALFORMED_GATEWAY_RESPONSE",
          );
        }
        totalBytes += part.value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          try {
            await run(() => reader.cancel?.());
          } catch {
            // Preserve the bounded public error if stream cancellation fails.
          }
          throw new AgentCoreGatewayError(
            "GATEWAY_RESPONSE_TOO_LARGE",
          );
        }
        chunks.push(Buffer.from(
          part.value.buffer,
          part.value.byteOffset,
          part.value.byteLength,
        ));
      }
    } catch (error) {
      if (
        error instanceof AgentCoreGatewayError
        && (
          error.code === "GATEWAY_ABORTED"
          || error.code === "GATEWAY_TIMEOUT"
        )
      ) {
        try {
          Promise.resolve(reader.cancel?.()).catch(() => {});
        } catch {
          // The invocation error remains authoritative.
        }
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, totalBytes),
      );
    } catch {
      throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
    }
  }

  if (typeof response.text !== "function") {
    throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
  }
  const text = await run(() => response.text());
  if (typeof text !== "string") {
    throw new AgentCoreGatewayError("MALFORMED_GATEWAY_RESPONSE");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new AgentCoreGatewayError("GATEWAY_RESPONSE_TOO_LARGE");
  }
  return text;
}

export class AgentCoreGatewayClient {
  #gatewayBaseUrl;
  #region;
  #credentialsProvider;
  #fetchImpl;
  #clock;
  #timeoutMs;
  #logger;

  constructor({
    gatewayBaseUrl,
    region,
    credentialsProvider,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
    timeoutMs = 10_000,
    logger = console,
  } = {}) {
    if (
      typeof region !== "string"
      || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region)
      || !validGatewayBaseUrl(gatewayBaseUrl, region)
    ) {
      throw new TypeError(
        "gatewayBaseUrl must be the configured HTTPS AgentCore Gateway "
        + "inference URL for the supplied region.",
      );
    }
    if (typeof credentialsProvider !== "function") {
      throw new TypeError("A credentials provider is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("A fetch implementation is required.");
    }
    if (!logger || typeof logger.error !== "function") {
      throw new TypeError("A Gateway diagnostic logger is required.");
    }
    if (
      typeof clock !== "function"
      && typeof clock?.now !== "function"
    ) {
      throw new TypeError("A clock is required.");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      throw new TypeError("timeoutMs must be between 1 and 60000.");
    }

    this.#gatewayBaseUrl = gatewayBaseUrl;
    this.#region = region;
    this.#credentialsProvider = credentialsProvider;
    this.#fetchImpl = fetchImpl;
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
    this.#logger = logger;
  }

  async invoke(input) {
    const request = validateInvocation(input);
    const claude = isClaudeModel(request.modelId);
    const url = claude
      ? `${this.#gatewayBaseUrl}/messages`
      : `${this.#gatewayBaseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: request.modelId,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.maxTokens,
      stream: false,
    });
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      throw new AgentCoreGatewayError("INVALID_GATEWAY_REQUEST");
    }
    if (request.abortSignal?.aborted) {
      throw new AgentCoreGatewayError("GATEWAY_ABORTED");
    }
    const scope = createInvocationScope(
      request.abortSignal,
      this.#timeoutMs,
    );
    try {
      let credentials;
      try {
        credentials = normalizeCredentials(
          await scope.run(() => this.#credentialsProvider({
            sourceIdentity: request.sourceIdentity,
            abortSignal: scope.signal,
          })),
        );
      } catch (error) {
        if (error instanceof AgentCoreGatewayError) throw error;
        throw new AgentCoreGatewayError(
          "GATEWAY_CREDENTIALS_UNAVAILABLE",
        );
      }
      let value;
      try {
        value = typeof this.#clock === "function"
          ? this.#clock()
          : this.#clock.now();
      } catch {
        throw new AgentCoreGatewayError("GATEWAY_INVOCATION_FAILED");
      }
      const now = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(now.getTime())) {
        throw new AgentCoreGatewayError("GATEWAY_INVOCATION_FAILED");
      }
      const headers = signRequest({
        body,
        credentials,
        extraHeaders: claude
          ? { "anthropic-version": "2023-06-01" }
          : {},
        now,
        region: this.#region,
        url,
      });
      let response;
      try {
        response = await scope.run(() => this.#fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: scope.signal,
        }));
      } catch (error) {
        if (error instanceof AgentCoreGatewayError) throw error;
        throw new AgentCoreGatewayError("GATEWAY_INVOCATION_FAILED");
      }
      if (!response?.ok) {
        const upstreamStatusCode = response?.status;
        if (
          !Number.isInteger(upstreamStatusCode)
          || upstreamStatusCode < 100
          || upstreamStatusCode > 599
        ) {
          throw new AgentCoreGatewayError(
            "MALFORMED_GATEWAY_RESPONSE",
          );
        }
        const retryable = (
          upstreamStatusCode >= 500
          || [408, 425, 429].includes(upstreamStatusCode)
        );
        throw new AgentCoreGatewayError(
          retryable
            ? "GATEWAY_INVOCATION_FAILED"
            : "GATEWAY_INVOCATION_REJECTED",
          { upstreamStatusCode },
        );
      }
      let text;
      try {
        text = await readResponseText(response, scope.run);
      } catch (error) {
        if (error instanceof AgentCoreGatewayError) throw error;
        throw new AgentCoreGatewayError("GATEWAY_INVOCATION_FAILED");
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new AgentCoreGatewayError(
          "MALFORMED_GATEWAY_RESPONSE",
        );
      }
      const requestId = responseRequestId(response);
      if (request.onUsage) {
        // Capture final provider counters before output parsing/validation can
        // fail. No response text, prompt or arbitrary metadata is journaled.
        const usage = claude ? {
          inputTokens: payload?.usage?.input_tokens, outputTokens: payload?.usage?.output_tokens,
          totalTokens: payload?.usage?.input_tokens + payload?.usage?.output_tokens,
        } : {
          inputTokens: payload?.usage?.prompt_tokens, outputTokens: payload?.usage?.completion_tokens,
          totalTokens: payload?.usage?.total_tokens,
        };
        if (validUsage(usage)) await request.onUsage({
          protocol: claude ? "anthropic-v1" : "openai-v1",
          providerRequestId: requestId, usage,
          metering: providerMetering(payload, claude ? "anthropic" : "openai"),
        });
      }
      return claude
        ? parseAnthropicResponse(payload, requestId)
        : parseOpenAiResponse(payload, requestId);
    } catch (error) {
      logGatewayFailure(this.#logger, error);
      throw error;
    } finally {
      scope.close();
    }
  }
}
