import {
  InvokeCommand,
  LambdaClient,
} from "@aws-sdk/client-lambda";

const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9-_]{1,64}$/;
const STABLE_ERROR_CODES = new Set([
  "IDEMPOTENCY_CONFLICT",
  "REGISTRY_RESOURCE_CONFLICT",
  "REQUEST_CLAIM_CONFLICT",
]);

function unavailable() {
  return Object.assign(
    new Error("Registry decision finalization is unavailable."),
    { code: "FINALIZER_UNAVAILABLE" },
  );
}

function decodeResponse(response) {
  if (
    !response
    || typeof response !== "object"
    || response.StatusCode !== 200
    || response.FunctionError !== undefined
    || !(response.Payload instanceof Uint8Array)
  ) {
    throw unavailable();
  }
  let parsed;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.Payload),
    );
  } catch {
    throw unavailable();
  }
  if (
    parsed?.ok === true
    && Object.keys(parsed).every(
      (key) => key === "ok" || key === "replayed",
    )
    && (
      parsed.replayed === undefined
      || typeof parsed.replayed === "boolean"
    )
  ) {
    return parsed;
  }
  if (
    parsed?.ok === false
    && typeof parsed.code === "string"
    && STABLE_ERROR_CODES.has(parsed.code)
    && Object.keys(parsed).length === 2
  ) {
    throw Object.assign(new Error("Registry decision finalization conflicted."), {
      code: parsed.code,
    });
  }
  throw unavailable();
}

export function createRegistryDecisionFinalizerClient({
  functionName,
  lambdaClient,
  region,
} = {}) {
  if (
    typeof functionName !== "string"
    || !FUNCTION_NAME_PATTERN.test(functionName)
  ) {
    throw new TypeError("Registry decision finalizer function is invalid.");
  }
  const client = lambdaClient || new LambdaClient({ region });
  if (!client || typeof client.send !== "function") {
    throw new TypeError("Registry decision finalizer client is invalid.");
  }
  return {
    async finalize(payload) {
      let response;
      try {
        response = await client.send(new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(JSON.stringify({
            operation: "FINALIZE_REGISTRY_DECISION",
            payload,
          })),
        }));
      } catch {
        throw unavailable();
      }
      return decodeResponse(response);
    },
  };
}
