import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createAgentRuntimeHttpHandler,
} from "../lambda/agent-runtime/http.mjs";

function request({
  method = "POST",
  url = "/invocations",
  headers = { "content-type": "application/json" },
  chunks = [],
} = {}) {
  const value = Readable.from(chunks);
  value.method = method;
  value.url = url;
  value.headers = headers;
  value.aborted = false;
  return value;
}

function response() {
  const headers = new Map();
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  return {
    statusCode: 200,
    headers,
    body: "",
    setHeader(name, value) {
      headers.set(name.toLowerCase(), String(value));
    },
    end(value = "") {
      this.body += String(value);
      resolveEnded();
    },
    ended,
  };
}

async function dispatch(handler, options) {
  const req = request(options);
  const res = response();
  await handler(req, res);
  await res.ended;
  return {
    statusCode: res.statusCode,
    headers: Object.fromEntries(res.headers),
    body: res.body,
    json: JSON.parse(res.body),
  };
}

function invocation(overrides = {}) {
  return {
    agentConfig: {
      agentId: "triage-agent",
      modelId: "provider/model",
    },
    prompt: "Classify this request.",
    maxTokens: 64,
    session: {
      sessionId: "session-1",
      metadata: {
        channel: "web",
        actor: "user-sub-123",
        requestId: "invoke-request-123",
        domainId: "customer_support",
        projectId: "case-assist",
      },
    },
    proof: {
      version: "v2",
      audience:
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
        + "runtime/AgenticPlatformRuntime-ABC1234567/"
        + "runtime-endpoint/Production",
      issuedAt: 1_000_000,
      expiresAt: 1_060_000,
      nonce: "a".repeat(43),
      signature: "b".repeat(43),
    },
    ...overrides,
  };
}

function handlerHarness() {
  const calls = [];
  return {
    calls,
    handler: createAgentRuntimeHttpHandler({
      service: {
        async invoke(input, context) {
          calls.push({
            input: structuredClone(input),
            aborted: context.abortSignal.aborted,
          });
          return {
            agentId: input.agentConfig.agentId,
            sessionId: input.session?.sessionId,
            output: "Account access.",
            upstreamRequestId: "gateway-request",
            usage: {
              inputTokens: 4,
              outputTokens: 2,
              totalTokens: 6,
            },
          };
        },
      },
    }),
  };
}

test("GET /ping reports a ready AgentCore Runtime", async () => {
  const { handler } = handlerHarness();

  const result = await dispatch(handler, {
    method: "GET",
    url: "/ping",
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json, { status: "Healthy" });
  assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.equal(
    Number(result.headers["content-length"]),
    Buffer.byteLength(result.body),
  );
});

test("POST /invocations parses JSON and returns the bounded service result", async () => {
  const { calls, handler } = handlerHarness();
  const body = JSON.stringify(invocation());

  const result = await dispatch(handler, {
    chunks: [body.slice(0, 30), Buffer.from(body.slice(30))],
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls, [{
    input: invocation(),
    aborted: false,
  }]);
  assert.deepEqual(result.json, {
    agentId: "triage-agent",
    sessionId: "session-1",
    output: "Account access.",
    upstreamRequestId: "gateway-request",
    usage: {
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    },
  });
});

test("rejects malformed JSON and unknown invocation fields", async () => {
  const { calls, handler } = handlerHarness();
  const malformed = await dispatch(handler, {
    chunks: ['{"agentConfig":'],
  });
  const unknown = await dispatch(handler, {
    chunks: [JSON.stringify(invocation({
      gatewayUrl: "https://attacker.example",
    }))],
  });

  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json.code, "INVALID_REQUEST");
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json.code, "INVALID_REQUEST");
  assert.equal(calls.length, 0);
});

test("rejects oversized request bodies before invoking the service", async () => {
  const { calls, handler } = handlerHarness();

  const result = await dispatch(handler, {
    chunks: [
      Buffer.alloc(20 * 1024, 0x61),
      Buffer.alloc(20 * 1024, 0x62),
    ],
  });

  assert.equal(result.statusCode, 413);
  assert.equal(result.json.code, "REQUEST_TOO_LARGE");
  assert.equal(calls.length, 0);
  assert.ok(Buffer.byteLength(result.body) < 512);
});

test("requires JSON content and exposes only the AgentCore protocol routes", async () => {
  const { handler } = handlerHarness();
  const notJson = await dispatch(handler, {
    headers: { "content-type": "text/plain" },
    chunks: [JSON.stringify(invocation())],
  });
  const query = await dispatch(handler, {
    url: "/invocations?target=other",
    chunks: [JSON.stringify(invocation())],
  });
  const route = await dispatch(handler, {
    method: "GET",
    url: "/admin",
  });

  assert.equal(notJson.statusCode, 415);
  assert.equal(notJson.json.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(query.statusCode, 404);
  assert.equal(query.json.code, "NOT_FOUND");
  assert.equal(route.statusCode, 404);
  assert.equal(route.json.code, "NOT_FOUND");
});

test("returns sanitized errors when the invocation service fails", async () => {
  const handler = createAgentRuntimeHttpHandler({
    service: {
      async invoke() {
        const error = new Error("secret upstream detail");
        error.code = "GATEWAY_UNAVAILABLE";
        error.statusCode = 504;
        error.retryable = true;
        throw error;
      },
    },
  });

  const result = await dispatch(handler, {
    chunks: [JSON.stringify(invocation())],
  });

  assert.equal(result.statusCode, 504);
  assert.deepEqual(result.json, {
    ok: false,
    code: "RUNTIME_UNAVAILABLE",
    message: "The runtime could not complete the invocation.",
    retryable: true,
  });
  assert.ok(!result.body.includes("secret"));
});

test("rejects invalid handler dependencies", () => {
  assert.throws(
    () => createAgentRuntimeHttpHandler(),
    /runtime HTTP configuration is invalid/i,
  );
  assert.throws(
    () => createAgentRuntimeHttpHandler({ service: {} }),
    /runtime HTTP configuration is invalid/i,
  );
});
