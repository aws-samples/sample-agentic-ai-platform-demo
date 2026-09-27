import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  AgentCoreGatewayClient,
  AgentCoreGatewayError,
} from "../lambda/workspace/gateway.mjs";

const GATEWAY_BASE_URL =
  "https://agentic-demo-llm-gateway-abcdefghij."
  + "gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1";
const NOW = new Date("2026-08-25T01:02:03.000Z");
const SOURCE_IDENTITY = "domain_customer_support";
const CREDENTIALS = Object.freeze({
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "unit-test-secret",
  sessionToken: "unit-test-session-token",
});

function hashHex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function expectedAuthorization({ body, extraHeaders = {}, url }) {
  const parsedUrl = new URL(url);
  const amzDate = "20260825T010203Z";
  const dateStamp = "20260825";
  const payloadHash = hashHex(body);
  const headers = {
    ...extraHeaders,
    "content-type": "application/json",
    host: parsedUrl.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": CREDENTIALS.sessionToken,
  };
  const canonicalHeaders = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = canonicalHeaders.map(([key]) => key).join(";");
  const canonicalRequest = [
    "POST",
    parsedUrl.pathname,
    "",
    canonicalHeaders.map(([key, value]) => `${key}:${value}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = "20260825/us-west-2/bedrock-agentcore/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hashHex(canonicalRequest),
  ].join("\n");
  const dateKey = hmac(
    `AWS4${CREDENTIALS.secretAccessKey}`,
    dateStamp,
  );
  const regionKey = hmac(dateKey, "us-west-2");
  const serviceKey = hmac(regionKey, "bedrock-agentcore");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  return (
    "AWS4-HMAC-SHA256 "
    + `Credential=${CREDENTIALS.accessKeyId}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

function clientWith(fetchImpl, overrides = {}) {
  return new AgentCoreGatewayClient({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    region: "us-west-2",
    credentialsProvider: async () => CREDENTIALS,
    fetchImpl,
    clock: () => NOW,
    timeoutMs: 1_000,
    logger: { error() {} },
    ...overrides,
  });
}

test("constructor accepts only the exact configured AgentCore inference URL", () => {
  const invalidUrls = [
    GATEWAY_BASE_URL.replace("https:", "http:"),
    `${GATEWAY_BASE_URL}/`,
    `${GATEWAY_BASE_URL}/models`,
    `${GATEWAY_BASE_URL}?target=other`,
    `${GATEWAY_BASE_URL}#fragment`,
    GATEWAY_BASE_URL.replace("us-west-2", "us-east-1"),
    GATEWAY_BASE_URL.replace(
      ".amazonaws.com",
      ".amazonaws.com.attacker.example",
    ),
    GATEWAY_BASE_URL.replace(
      "agentic-demo-llm-gateway-abcdefghij",
      "agentic--demo-llm-gateway-abcdefghij",
    ),
    GATEWAY_BASE_URL.replace(
      "agentic-demo-llm-gateway-abcdefghij",
      "agentic-demo-llm-gateway-abcdefghi",
    ),
    GATEWAY_BASE_URL.replace(
      "https://",
      "https://user:password@",
    ),
  ];

  for (const gatewayBaseUrl of invalidUrls) {
    assert.throws(
      () => clientWith(async () => {
        throw new Error("fetch must not be called");
      }, { gatewayBaseUrl }),
      /configured HTTPS AgentCore Gateway inference URL/,
      gatewayBaseUrl,
    );
  }
});

test("caller input cannot override URLs, headers, or property semantics", async () => {
  let credentialCalls = 0;
  let fetchCalls = 0;
  const client = new AgentCoreGatewayClient({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    region: "us-west-2",
    credentialsProvider: async () => {
      credentialCalls += 1;
      return CREDENTIALS;
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    },
    clock: () => NOW,
    timeoutMs: 1_000,
  });
  const hiddenUrl = {
    modelId: "bedrock-mantle/openai.gpt-oss-120b",
    prompt: "Reply briefly.",
    maxTokens: 64,
    sourceIdentity: SOURCE_IDENTITY,
  };
  Object.defineProperty(hiddenUrl, "url", {
    value: "https://attacker.example/inference/v1/chat/completions",
  });
  const accessorPrompt = {
    modelId: "bedrock-mantle/openai.gpt-oss-120b",
    maxTokens: 64,
    sourceIdentity: SOURCE_IDENTITY,
    get prompt() {
      throw new Error("TOP-SECRET accessor executed");
    },
  };
  const symbolHeader = {
    modelId: "bedrock-mantle/openai.gpt-oss-120b",
    prompt: "Reply briefly.",
    maxTokens: 64,
    sourceIdentity: SOURCE_IDENTITY,
    [Symbol("headers")]: {
      authorization: "Bearer attacker",
    },
  };
  const invalidInputs = [
    {
      modelId: "bedrock-mantle/openai.gpt-oss-120b",
      prompt: "Reply briefly.",
      maxTokens: 64,
      sourceIdentity: SOURCE_IDENTITY,
      url: "https://attacker.example/inference/v1/chat/completions",
    },
    {
      modelId: "bedrock-mantle/openai.gpt-oss-120b",
      prompt: "Reply briefly.",
      maxTokens: 64,
      sourceIdentity: SOURCE_IDENTITY,
      headers: {
        authorization: "Bearer attacker",
      },
    },
    hiddenUrl,
    accessorPrompt,
    symbolHeader,
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      client.invoke(input),
      (error) => (
        error instanceof AgentCoreGatewayError
        && error.code === "INVALID_GATEWAY_REQUEST"
        && error.statusCode === 400
        && error.retryable === false
        && !String(error).includes("TOP-SECRET")
      ),
    );
  }
  assert.equal(credentialCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("requires canonical source identity and passes only it and abortSignal to credentials", async () => {
  const credentialCalls = [];
  const client = clientWith(async () => new Response(JSON.stringify({
    choices: [{ message: { content: "ok" } }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }), { status: 200 }), {
    credentialsProvider: async (input) => {
      credentialCalls.push(input);
      return CREDENTIALS;
    },
  });

  for (const sourceIdentity of [
    undefined,
    "a",
    "Customer_Support",
    "customer-support",
    "aws:customer_support",
    "customer_support",
    `a${"b".repeat(64)}`,
  ]) {
    await assert.rejects(
      client.invoke({
        modelId: "provider/model",
        prompt: "valid",
        maxTokens: 1,
        ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
      }),
      (error) => (
        error instanceof AgentCoreGatewayError
        && error.code === "INVALID_GATEWAY_REQUEST"
      ),
    );
  }

  const controller = new AbortController();
  await client.invoke({
    modelId: "provider/model",
    prompt: "valid",
    maxTokens: 1,
    sourceIdentity: SOURCE_IDENTITY,
    abortSignal: controller.signal,
  });

  assert.equal(credentialCalls.length, 1);
  assert.deepEqual(Object.keys(credentialCalls[0]), [
    "sourceIdentity",
    "abortSignal",
  ]);
  assert.equal(
    credentialCalls[0].sourceIdentity,
    SOURCE_IDENTITY,
  );
  assert.ok(credentialCalls[0].abortSignal instanceof AbortSignal);
});

test("configured Gateway dependencies cannot be mutated after construction", async () => {
  let requestedUrl;
  const client = clientWith(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }), { status: 200 });
  });
  client.gatewayBaseUrl =
    "https://attacker-gateway-abcdefghij."
    + "gateway.bedrock-agentcore.us-west-2.amazonaws.com/inference/v1";

  await client.invoke({
    modelId: "provider/model",
    prompt: "valid",
    maxTokens: 1,
    sourceIdentity: SOURCE_IDENTITY,
  });

  assert.equal(
    requestedUrl,
    `${GATEWAY_BASE_URL}/chat/completions`,
  );
});

test("OpenAI invocation signs the exact body and chat-completions path", async () => {
  let request;
  const client = clientWith(async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Gateway response.",
        },
      }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 5,
        total_tokens: 12,
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-amzn-requestid": "gateway-openai-request",
      },
    });
  });

  const result = await client.invoke({
    modelId: "bedrock-mantle/openai.gpt-oss-120b",
    prompt: "Reply briefly.",
    maxTokens: 64,
    sourceIdentity: SOURCE_IDENTITY,
  });

  const expectedUrl = `${GATEWAY_BASE_URL}/chat/completions`;
  const expectedBody = JSON.stringify({
    model: "bedrock-mantle/openai.gpt-oss-120b",
    messages: [{ role: "user", content: "Reply briefly." }],
    max_tokens: 64,
    stream: false,
  });
  assert.equal(request.url, expectedUrl);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, expectedBody);
  assert.equal(request.init.signal.aborted, false);
  assert.equal(request.init.headers.host, new URL(expectedUrl).host);
  assert.equal(request.init.headers["content-type"], "application/json");
  assert.equal(request.init.headers["x-amz-date"], "20260825T010203Z");
  assert.equal(
    request.init.headers["x-amz-content-sha256"],
    hashHex(expectedBody),
  );
  assert.equal(
    request.init.headers["x-amz-security-token"],
    CREDENTIALS.sessionToken,
  );
  assert.equal(
    request.init.headers.Authorization,
    expectedAuthorization({
      body: expectedBody,
      url: expectedUrl,
    }),
  );
  assert.notEqual(
    request.init.headers.Authorization,
    expectedAuthorization({
      body: `${expectedBody} `,
      url: expectedUrl,
    }),
  );
  assert.notEqual(
    request.init.headers.Authorization,
    expectedAuthorization({
      body: expectedBody,
      url: `${GATEWAY_BASE_URL}/messages`,
    }),
  );
  assert.equal("anthropic-version" in request.init.headers, false);
  assert.deepEqual(result, {
    output: "Gateway response.",
    requestId: "gateway-openai-request",
    metering: {
      version: 1, source: "provider", modelId: null,
      inputTokenBasis: "includes-cache", cacheReadInputTokens: null,
      cacheWriteInputTokens: null, cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: null,
    },
    usage: {
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
    },
  });
});

test("Claude invocation uses signed Messages headers and parses usage", async () => {
  let request;
  const client = clientWith(async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      content: [
        { type: "text", text: "Claude " },
        { type: "tool_use", id: "ignored" },
        { type: "text", text: "response." },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 5,
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-amz-request-id": "gateway-claude-request",
      },
    });
  });

  const result = await client.invoke({
    modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    prompt: "Reply briefly.",
    maxTokens: 64,
    sourceIdentity: SOURCE_IDENTITY,
  });

  const expectedUrl = `${GATEWAY_BASE_URL}/messages`;
  const expectedBody = JSON.stringify({
    model: "bedrock-claude/anthropic.claude-sonnet-5",
    messages: [{ role: "user", content: "Reply briefly." }],
    max_tokens: 64,
    stream: false,
  });
  assert.equal(request.url, expectedUrl);
  assert.equal(request.init.body, expectedBody);
  assert.equal(
    request.init.headers["anthropic-version"],
    "2023-06-01",
  );
  assert.match(
    request.init.headers.Authorization,
    /SignedHeaders=anthropic-version;content-type;host;/,
  );
  assert.equal(
    request.init.headers.Authorization,
    expectedAuthorization({
      body: expectedBody,
      extraHeaders: {
        "anthropic-version": "2023-06-01",
      },
      url: expectedUrl,
    }),
  );
  assert.deepEqual(result, {
    output: "Claude response.",
    requestId: "gateway-claude-request",
    metering: {
      version: 1, source: "provider", modelId: null,
      inputTokenBasis: "uncached", cacheReadInputTokens: null,
      cacheWriteInputTokens: null, cacheWrite5mInputTokens: null, cacheWrite1hInputTokens: null,
    },
    usage: {
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
    },
  });
});

test("multiline prompts are preserved in the signed request body", async () => {
  let requestBody;
  const client = clientWith(async (_url, init) => {
    requestBody = init.body;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
      },
    }), { status: 200 });
  });
  const prompt = "First line.\nSecond line.";

  const result = await client.invoke({
    modelId: "bedrock-mantle/openai.gpt-oss-120b",
    prompt,
    maxTokens: 1,
    sourceIdentity: SOURCE_IDENTITY,
  });

  assert.equal(JSON.parse(requestBody).messages[0].content, prompt);
  assert.equal(result.output, "ok");
});

test("request fields and serialized bodies are strictly bounded", async () => {
  let credentialCalls = 0;
  let fetchCalls = 0;
  const client = clientWith(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "must not be returned" } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }), { status: 200 });
  }, {
    credentialsProvider: async () => {
      credentialCalls += 1;
      return CREDENTIALS;
    },
  });
  const invalidRequests = [
    {
      modelId: "https://attacker.example/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    },
    {
      modelId: `m${"x".repeat(512)}`,
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    },
    {
      modelId: "provider/model",
      prompt: " \n\t ",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    },
    {
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 8_193,
      sourceIdentity: SOURCE_IDENTITY,
    },
    {
      modelId: "provider/model",
      prompt: "\u20ac".repeat(11_000),
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    },
  ];

  for (const request of invalidRequests) {
    await assert.rejects(
      client.invoke(request),
      (error) => (
        error instanceof AgentCoreGatewayError
        && error.code === "INVALID_GATEWAY_REQUEST"
      ),
    );
  }
  assert.equal(credentialCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("declared oversized responses are rejected before body parsing", async () => {
  let textCalls = 0;
  const client = clientWith(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      "content-length": String((256 * 1024) + 1),
    }),
    async text() {
      textCalls += 1;
      return "{}";
    },
  }));

  await assert.rejects(
    client.invoke({
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_RESPONSE_TOO_LARGE"
      && error.statusCode === 502
      && error.retryable === false
    ),
  );
  assert.equal(textCalls, 0);
});

test("chunked oversized responses are cancelled at the byte limit", async () => {
  let reads = 0;
  let cancelled = false;
  const client = clientWith(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (reads === 1) {
              return {
                done: false,
                value: new Uint8Array(200 * 1024),
              };
            }
            return {
              done: false,
              value: new Uint8Array((56 * 1024) + 1),
            };
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    },
  }));

  await assert.rejects(
    client.invoke({
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_RESPONSE_TOO_LARGE"
    ),
  );
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test("a hanging stream cancellation remains bounded by the timeout", async () => {
  const client = clientWith(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            return {
              done: false,
              value: new Uint8Array((256 * 1024) + 1),
            };
          },
          async cancel() {
            return new Promise(() => {});
          },
          releaseLock() {},
        };
      },
    },
  }), { timeoutMs: 10 });
  let guard;
  const guardFailure = new Promise((_, reject) => {
    guard = setTimeout(
      () => reject(new Error("stream cancellation was not bounded")),
      100,
    );
  });

  try {
    await assert.rejects(
      Promise.race([
        client.invoke({
          modelId: "provider/model",
          prompt: "valid",
          maxTokens: 1,
          sourceIdentity: SOURCE_IDENTITY,
        }),
        guardFailure,
      ]),
      (error) => error?.code === "GATEWAY_RESPONSE_TOO_LARGE",
    );
  } finally {
    clearTimeout(guard);
  }
});

test("an already-aborted caller signal stops before credentials or fetch", async () => {
  let credentialCalls = 0;
  let fetchCalls = 0;
  const client = clientWith(async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called");
  }, {
    credentialsProvider: async () => {
      credentialCalls += 1;
      return CREDENTIALS;
    },
  });
  const controller = new AbortController();
  controller.abort("TOP-SECRET caller reason");

  await assert.rejects(
    client.invoke({
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
      abortSignal: controller.signal,
    }),
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_ABORTED"
      && error.statusCode === 499
      && error.retryable === false
      && !String(error).includes("TOP-SECRET")
    ),
  );
  assert.equal(credentialCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("caller abort cancels an in-flight invocation", async () => {
  let fetchSignal;
  let notifyFetch;
  const fetchStarted = new Promise((resolve) => {
    notifyFetch = resolve;
  });
  const client = clientWith(async (_url, init) => {
    fetchSignal = init.signal;
    notifyFetch();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(JSON.stringify({
      choices: [{ message: { content: "too late" } }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
    }), { status: 200 });
  });
  const controller = new AbortController();
  const invocation = client.invoke({
    modelId: "provider/model",
    prompt: "valid",
    maxTokens: 1,
    sourceIdentity: SOURCE_IDENTITY,
    abortSignal: controller.signal,
  });
  await fetchStarted;

  controller.abort("TOP-SECRET caller reason");

  await assert.rejects(
    invocation,
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_ABORTED"
      && !String(error).includes("TOP-SECRET")
    ),
  );
  assert.equal(fetchSignal.aborted, true);
});

test("signal-aware fetch rejection preserves the caller abort error", async () => {
  let notifyFetch;
  const fetchStarted = new Promise((resolve) => {
    notifyFetch = resolve;
  });
  const client = clientWith(async (_url, init) => {
    notifyFetch();
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new Error("TOP-SECRET fetch abort detail"));
      }, { once: true });
    });
  });
  const controller = new AbortController();
  const invocation = client.invoke({
    modelId: "provider/model",
    prompt: "valid",
    maxTokens: 1,
    sourceIdentity: SOURCE_IDENTITY,
    abortSignal: controller.signal,
  });
  await fetchStarted;

  controller.abort();

  await assert.rejects(
    invocation,
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_ABORTED"
      && !String(error).includes("TOP-SECRET")
    ),
  );
});

test("non-2xx responses return stable errors without reading secret bodies", async () => {
  const cases = [
    [400, "GATEWAY_INVOCATION_REJECTED", false],
    [429, "GATEWAY_INVOCATION_FAILED", true],
    [503, "GATEWAY_INVOCATION_FAILED", true],
  ];

  for (const [upstreamStatusCode, code, retryable] of cases) {
    let textCalls = 0;
    const client = clientWith(async () => ({
      ok: false,
      status: upstreamStatusCode,
      statusText: "TOP-SECRET provider status",
      headers: new Headers(),
      async text() {
        textCalls += 1;
        return JSON.stringify({
          error: CREDENTIALS.secretAccessKey,
          token: CREDENTIALS.sessionToken,
        });
      },
    }));

    let caught;
    try {
      await client.invoke({
        modelId: "provider/model",
        prompt: "valid",
        maxTokens: 1,
        sourceIdentity: SOURCE_IDENTITY,
      });
      assert.fail("Expected Gateway invocation to fail.");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AgentCoreGatewayError);
    assert.equal(caught.code, code);
    assert.equal(caught.statusCode, 502);
    assert.equal(caught.retryable, retryable);
    assert.equal(caught.upstreamStatusCode, upstreamStatusCode);
    assert.equal(textCalls, 0);
    const publicError = JSON.stringify({
      name: caught.name,
      message: caught.message,
      code: caught.code,
      statusCode: caught.statusCode,
      retryable: caught.retryable,
      upstreamStatusCode: caught.upstreamStatusCode,
      stack: caught.stack,
    });
    assert.equal(publicError.includes("TOP-SECRET"), false);
    assert.equal(
      publicError.includes(CREDENTIALS.secretAccessKey),
      false,
    );
    assert.equal(
      publicError.includes(CREDENTIALS.sessionToken),
      false,
    );
  }
});

test("Gateway failures emit only bounded operational diagnostics", async () => {
  const logs = [];
  const logger = {
    error(entry) {
      logs.push(entry);
    },
  };
  const client = clientWith(async () => ({
    ok: false,
    status: 503,
    statusText: "TOP-SECRET provider status",
    headers: new Headers(),
    async text() {
      return JSON.stringify({
        error: CREDENTIALS.secretAccessKey,
        token: CREDENTIALS.sessionToken,
      });
    },
  }), { logger });

  await assert.rejects(
    client.invoke({
      modelId: "bedrock-claude/anthropic.claude-haiku-4-5",
      prompt: "TOP-SECRET prompt",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_INVOCATION_FAILED"
    ),
  );

  assert.deepEqual(logs, [{
    event: "agentcore_gateway_invocation_failed",
    code: "GATEWAY_INVOCATION_FAILED",
    retryable: true,
    upstreamStatusCode: 503,
  }]);
  const serialized = JSON.stringify(logs);
  for (const secret of [
    "TOP-SECRET",
    CREDENTIALS.accessKeyId,
    CREDENTIALS.secretAccessKey,
    CREDENTIALS.sessionToken,
    SOURCE_IDENTITY,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("diagnostic logger failures never replace the stable Gateway error", async () => {
  const client = clientWith(async () => {
    throw new Error("TOP-SECRET fetch detail");
  }, {
    logger: {
      error() {
        throw new Error("TOP-SECRET logger detail");
      },
    },
  });

  await assert.rejects(
    client.invoke({
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_INVOCATION_FAILED"
      && !String(error).includes("TOP-SECRET")
    ),
  );
});

test("the configured timeout bounds credentials, fetch, and response reads", {
  timeout: 1_000,
}, async () => {
  let credentialSignal;
  let fetchCalls = 0;
  const credentialsClient = clientWith(async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called");
  }, {
    credentialsProvider: async ({ abortSignal }) => {
      credentialSignal = abortSignal;
      return new Promise(() => {});
    },
    timeoutMs: 10,
  });

  await assert.rejects(
    credentialsClient.invoke({
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    (error) => (
      error instanceof AgentCoreGatewayError
      && error.code === "GATEWAY_TIMEOUT"
      && error.statusCode === 504
      && error.retryable === true
    ),
  );
  assert.equal(credentialSignal.aborted, true);
  assert.equal(fetchCalls, 0);

  let fetchSignal;
  const fetchClient = clientWith(async (_url, init) => {
    fetchSignal = init.signal;
    return new Promise(() => {});
  }, { timeoutMs: 10 });

  await assert.rejects(
    fetchClient.invoke({
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    (error) => error?.code === "GATEWAY_TIMEOUT",
  );
  assert.equal(fetchSignal.aborted, true);

  let cancelled = false;
  let released = false;
  const responseClient = clientWith(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            return new Promise(() => {});
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {
            released = true;
          },
        };
      },
    },
  }), { timeoutMs: 10 });

  await assert.rejects(
    responseClient.invoke({
      modelId: "provider/model",
      prompt: "valid",
      maxTokens: 1,
      sourceIdentity: SOURCE_IDENTITY,
    }),
    (error) => error?.code === "GATEWAY_TIMEOUT",
  );
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test("credential, network, and malformed-response errors disclose no secrets", async () => {
  const secretText = [
    "TOP-SECRET",
    CREDENTIALS.accessKeyId,
    CREDENTIALS.secretAccessKey,
    CREDENTIALS.sessionToken,
  ].join(":");
  const cases = [
    {
      code: "GATEWAY_CREDENTIALS_UNAVAILABLE",
      client: clientWith(async () => {
        throw new Error("fetch must not be called");
      }, {
        credentialsProvider: async () => {
          throw new Error(secretText);
        },
      }),
    },
    {
      code: "GATEWAY_INVOCATION_FAILED",
      client: clientWith(async () => {
        throw new Error(secretText);
      }),
    },
    {
      code: "MALFORMED_GATEWAY_RESPONSE",
      client: clientWith(async () => new Response(
        `{"secret":${JSON.stringify(secretText)}`,
        { status: 200 },
      )),
    },
    {
      code: "MALFORMED_GATEWAY_RESPONSE",
      client: clientWith(async () => new Response(JSON.stringify({
        choices: [{ message: { content: "missing usage" } }],
        secret: secretText,
      }), { status: 200 })),
    },
    {
      code: "MALFORMED_GATEWAY_RESPONSE",
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
      client: clientWith(async () => new Response(JSON.stringify({
        content: [{ type: "tool_use", input: secretText }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }), { status: 200 })),
    },
  ];

  for (const scenario of cases) {
    let caught;
    try {
      await scenario.client.invoke({
        modelId: scenario.modelId || "provider/model",
        prompt: "valid",
        maxTokens: 1,
        sourceIdentity: SOURCE_IDENTITY,
      });
      assert.fail("Expected Gateway invocation to fail.");
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AgentCoreGatewayError);
    assert.equal(caught.code, scenario.code);
    assert.equal(Object.hasOwn(caught, "cause"), false);
    const publicError = JSON.stringify({
      name: caught.name,
      message: caught.message,
      code: caught.code,
      statusCode: caught.statusCode,
      retryable: caught.retryable,
      upstreamStatusCode: caught.upstreamStatusCode,
      stack: caught.stack,
    });
    for (const secret of [
      "TOP-SECRET",
      CREDENTIALS.accessKeyId,
      CREDENTIALS.secretAccessKey,
      CREDENTIALS.sessionToken,
    ]) {
      assert.equal(publicError.includes(secret), false);
    }
  }
});

test("credential provider output must use exact enumerable data properties", async () => {
  let getterCalls = 0;
  let fetchCalls = 0;
  const accessorCredentials = {};
  Object.defineProperty(accessorCredentials, "accessKeyId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return CREDENTIALS.accessKeyId;
    },
  });
  Object.defineProperty(accessorCredentials, "secretAccessKey", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return CREDENTIALS.secretAccessKey;
    },
  });
  const hiddenCredentials = { ...CREDENTIALS };
  Object.defineProperty(hiddenCredentials, "roleArn", {
    value: "arn:aws:iam::111122223333:role/attacker",
  });
  const symbolCredentials = {
    ...CREDENTIALS,
    [Symbol("credentials")]: "attacker",
  };

  for (const credentials of [
    accessorCredentials,
    hiddenCredentials,
    symbolCredentials,
  ]) {
    const client = clientWith(async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    }, {
      credentialsProvider: async () => credentials,
    });
    await assert.rejects(
      client.invoke({
        modelId: "provider/model",
        prompt: "valid",
        maxTokens: 1,
        sourceIdentity: SOURCE_IDENTITY,
      }),
      (error) => (
        error instanceof AgentCoreGatewayError
        && error.code === "GATEWAY_CREDENTIALS_UNAVAILABLE"
      ),
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("Gateway retains provider cache usage and input-token semantics", async () => {
  const client = clientWith(async () => new Response(JSON.stringify({
    model: "claude-test-model",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 16 } },
  }), { status: 200 }));
  const result = await client.invoke({ modelId: "anthropic.claude-test-model",
    prompt: "test", maxTokens: 10, sourceIdentity: SOURCE_IDENTITY });
  assert.equal(result.metering?.cacheReadInputTokens, 10);
  assert.equal(result.metering?.cacheWrite1hInputTokens, 16);
  assert.equal(result.metering?.inputTokenBasis, "uncached");
  assert.equal(result.metering?.modelId, "claude-test-model");
});
