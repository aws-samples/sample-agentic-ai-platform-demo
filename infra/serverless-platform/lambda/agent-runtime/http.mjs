import { Buffer } from "node:buffer";
import {
  AgentRuntimeError,
  validateAgentRuntimeRequest,
} from "./service.mjs";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 160 * 1024;
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

const ERROR_RESPONSES = Object.freeze({
  INVALID_REQUEST: Object.freeze({
    statusCode: 400,
    message: "The invocation request is invalid.",
    retryable: false,
  }),
  REQUEST_TOO_LARGE: Object.freeze({
    statusCode: 413,
    message: "The invocation request is too large.",
    retryable: false,
  }),
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({
    statusCode: 415,
    message: "The invocation request must use JSON.",
    retryable: false,
  }),
  NOT_FOUND: Object.freeze({
    statusCode: 404,
    message: "The requested runtime route is not available.",
    retryable: false,
  }),
  RUNTIME_UNAVAILABLE: Object.freeze({
    statusCode: 502,
    message: "The runtime could not complete the invocation.",
    retryable: true,
  }),
});

class HttpRequestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function jsonText(value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new HttpRequestError("RUNTIME_UNAVAILABLE");
  }
  return body;
}

function writeJson(response, statusCode, value) {
  const body = jsonText(value);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-length", Buffer.byteLength(body, "utf8"));
  response.end(body);
}

function writeError(response, code, overrides = {}) {
  const definition = ERROR_RESPONSES[code]
    || ERROR_RESPONSES.RUNTIME_UNAVAILABLE;
  writeJson(response, overrides.statusCode ?? definition.statusCode, {
    ok: false,
    code: ERROR_RESPONSES[code] ? code : "RUNTIME_UNAVAILABLE",
    message: definition.message,
    retryable: overrides.retryable ?? definition.retryable,
  });
}

function requestContentType(request) {
  const value = request.headers?.["content-type"];
  return Array.isArray(value) ? null : value;
}

async function readJsonBody(request) {
  const contentLength = request.headers?.["content-length"];
  if (contentLength !== undefined) {
    if (
      Array.isArray(contentLength)
      || !/^(?:0|[1-9][0-9]*)$/.test(contentLength)
    ) {
      throw new HttpRequestError("INVALID_REQUEST");
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      throw new HttpRequestError("REQUEST_TOO_LARGE");
    }
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const value of request) {
    if (
      typeof value !== "string"
      && !Buffer.isBuffer(value)
      && !(value instanceof Uint8Array)
    ) {
      throw new HttpRequestError("INVALID_REQUEST");
    }
    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new HttpRequestError("REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (totalBytes === 0) {
    throw new HttpRequestError("INVALID_REQUEST");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, totalBytes),
    );
  } catch {
    throw new HttpRequestError("INVALID_REQUEST");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpRequestError("INVALID_REQUEST");
  }
}

function serviceErrorDetails(error) {
  if (
    error instanceof AgentRuntimeError
    && error.code === "INVALID_REQUEST"
  ) {
    return {
      code: "INVALID_REQUEST",
      statusCode: 400,
      retryable: false,
    };
  }
  return {
    code: "RUNTIME_UNAVAILABLE",
    statusCode: [502, 503, 504].includes(error?.statusCode)
      ? error.statusCode
      : 502,
    retryable: error?.retryable === true,
  };
}

export function createAgentRuntimeHttpHandler({ service } = {}) {
  if (!service || typeof service.invoke !== "function") {
    throw new TypeError(
      "Agent Runtime HTTP configuration is invalid.",
    );
  }

  return async function agentRuntimeHttpHandler(request, response) {
    if (request.method === "GET" && request.url === "/ping") {
      writeJson(response, 200, { status: "Healthy" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/invocations") {
      writeError(response, "NOT_FOUND");
      return;
    }
    if (!JSON_CONTENT_TYPE.test(requestContentType(request) ?? "")) {
      writeError(response, "UNSUPPORTED_MEDIA_TYPE");
      return;
    }

    const abortController = new AbortController();
    const onAborted = () => abortController.abort();
    request.once?.("aborted", onAborted);
    try {
      const input = await readJsonBody(request);
      validateAgentRuntimeRequest(input);
      const result = await service.invoke(input, {
        abortSignal: abortController.signal,
      });
      writeJson(response, 200, result);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeError(response, error.code);
        return;
      }
      const detail = serviceErrorDetails(error);
      writeError(response, detail.code, detail);
    } finally {
      request.removeListener?.("aborted", onAborted);
    }
  };
}
