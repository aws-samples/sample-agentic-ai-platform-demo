import {
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { createHash } from "node:crypto";
import { validMetering, validExecution } from "../agent-runtime/usage.mjs";
import {
  createRuntimeInvocationProof,
} from "../agent-runtime/invocation-proof.mjs";

const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SESSION_ID_PATTERN =
  /^session-[a-f0-9]{16}-[a-f0-9]{16}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const RESULT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RUNTIME_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/[A-Za-z0-9_-]{1,48}$/;
const RUNTIME_ENDPOINT_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/[A-Za-z0-9_-]{1,48}\/runtime-endpoint\/[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const ENDPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROOF_CONFIG_KEYS = Object.freeze([
  "hmacKey",
  "previousHmacKey",
  "allowedEndpointArn",
  "keyId",
]);
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const MAX_PROMPT_LENGTH = 16_384;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

export const DEFAULT_RUNTIME_TIMEOUT_MS = 25_000;

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

function ownDataValue(value, key) {
  if (!isPlainObject(value)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  ) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

function exactValues(value, keys) {
  if (!isPlainObject(value)) return null;
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return null;
  }
  const result = {};
  for (const key of keys) {
    const property = ownDataValue(value, key);
    if (!property.present) return null;
    result[key] = property.value;
  }
  return result;
}

function validText(value, maxLength) {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function outputCapConfiguration(value) {
  const invalid = () => new TypeError("Experience output cap configuration is invalid.");
  if (!Array.isArray(value)) throw invalid();
  const caps = new Map();
  for (const item of value) {
    const entry = exactValues(item, ["domainId", "projectId", "agentId", "maxTokens"]);
    if (
      entry === null
      || typeof entry.domainId !== "string"
      || !DOMAIN_ID_PATTERN.test(entry.domainId)
      || typeof entry.projectId !== "string"
      || !SLUG_PATTERN.test(entry.projectId)
      || typeof entry.agentId !== "string"
      || !SLUG_PATTERN.test(entry.agentId)
      || !Number.isSafeInteger(entry.maxTokens)
      || entry.maxTokens < 1
      || entry.maxTokens > 512
    ) {
      throw invalid();
    }
    const key = `${entry.domainId}/${entry.projectId}/${entry.agentId}`;
    if (caps.has(key)) throw invalid();
    caps.set(key, entry.maxTokens);
  }
  return caps;
}

function invocationInput(value) {
  const root = exactValues(value, [
    "actor",
    "requestId",
    "sessionId",
    "prompt",
    "agent",
    "deployment",
    ...(isPlainObject(value) && Object.hasOwn(value, "onDispatch") ? ["onDispatch"] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, "nativeExecution") ? ["nativeExecution"] : []),
  ]);
  if (root === null) return null;
  const agentId = ownDataValue(root.agent, "id");
  const domainId = ownDataValue(root.agent, "domainId");
  const projectId = ownDataValue(root.agent, "projectId");
  const modelId = ownDataValue(root.agent, "modelId");
  const agentStatus = ownDataValue(root.agent, "status");
  const environment = ownDataValue(root.deployment, "environment");
  const status = ownDataValue(root.deployment, "status");
  const runtimeStatus = ownDataValue(
    root.deployment,
    "runtimeStatus",
  );
  const runtimeArn = ownDataValue(root.deployment, "runtimeArn");
  const endpointName = ownDataValue(root.deployment, "endpointName");
  const endpointArn = ownDataValue(root.deployment, "endpointArn");
  if (
    !SUBJECT_PATTERN.test(root.actor)
    || (root.onDispatch !== undefined && typeof root.onDispatch !== "function")
    || (root.nativeExecution !== undefined && (
      exactValues(root.nativeExecution, ["payloadFingerprint", "prepare"]) === null
      || !/^[a-f0-9]{64}$/.test(root.nativeExecution.payloadFingerprint)
      || typeof root.nativeExecution.prepare !== "function"))
    || !REQUEST_ID_PATTERN.test(root.requestId)
    || !SESSION_ID_PATTERN.test(root.sessionId)
    || !validText(root.prompt, MAX_PROMPT_LENGTH)
    || !domainId.present
    || !DOMAIN_ID_PATTERN.test(domainId.value)
    || !projectId.present
    || !SLUG_PATTERN.test(projectId.value)
    || !agentId.present
    || !SLUG_PATTERN.test(agentId.value)
    || !modelId.present
    || !MODEL_ID_PATTERN.test(modelId.value)
    || modelId.value.includes("://")
    || !agentStatus.present
    || agentStatus.value !== "PRODUCTION_DEPLOYED"
    || !environment.present
    || environment.value !== "PRODUCTION"
    || !status.present
    || status.value !== "DEPLOYED"
    || !runtimeStatus.present
    || runtimeStatus.value !== "READY"
    || !runtimeArn.present
    || !RUNTIME_ARN_PATTERN.test(runtimeArn.value)
    || !endpointName.present
    || !ENDPOINT_PATTERN.test(endpointName.value)
    || !endpointArn.present
    || !RUNTIME_ENDPOINT_ARN_PATTERN.test(endpointArn.value)
    || endpointArn.value
      !== `${runtimeArn.value}/runtime-endpoint/${endpointName.value}`
  ) {
    return null;
  }
  return {
    actor: root.actor,
    requestId: root.requestId,
    sessionId: root.sessionId,
    prompt: root.prompt,
    domainId: domainId.value,
    projectId: projectId.value,
    agentId: agentId.value,
    modelId: modelId.value,
    configuredMaxTokens: ownDataValue(
      ownDataValue(ownDataValue(root.agent, "buildConfig").value, "modelParameters").value,
      "maxTokens",
    ).value,
    runtimeArn: runtimeArn.value,
    endpointName: endpointName.value,
    endpointArn: endpointArn.value,
    onDispatch: root.onDispatch,
    nativeExecution: root.nativeExecution,
  };
}

function proofConfiguration(value) {
  const configuration = exactValues(value, PROOF_CONFIG_KEYS);
  if (
    configuration === null
    || typeof configuration.allowedEndpointArn !== "string"
    || !RUNTIME_ENDPOINT_ARN_PATTERN.test(
      configuration.allowedEndpointArn,
    )
    || typeof configuration.keyId !== "string"
    || !KEY_ID_PATTERN.test(configuration.keyId)
    || configuration.previousHmacKey !== null
      && typeof configuration.previousHmacKey !== "string"
  ) {
    return null;
  }
  try {
    validateProofSecret(configuration.hmacKey);
    if (configuration.previousHmacKey !== null) {
      validateProofSecret(configuration.previousHmacKey);
    }
  } catch {
    return null;
  }
  return configuration;
}

function validateProofSecret(proofSecret) {
  createRuntimeInvocationProof({
    secret: proofSecret,
  });
}

function validUsage(value) {
  const usage = exactValues(value, [
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ]);
  return Boolean(
    usage
    && Number.isSafeInteger(usage.inputTokens)
    && usage.inputTokens >= 0
    && Number.isSafeInteger(usage.outputTokens)
    && usage.outputTokens >= 0
    && Number.isSafeInteger(usage.totalTokens)
    && usage.totalTokens === usage.inputTokens + usage.outputTokens,
  );
}

async function readResponseBody(body) {
  if (body === null || body === undefined) {
    throw new Error("Agent Runtime response is invalid.");
  }
  let bytes;
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      if (
        typeof chunk !== "string"
        && !Buffer.isBuffer(chunk)
        && !(chunk instanceof Uint8Array)
      ) {
        throw new Error("Agent Runtime response is invalid.");
      }
      const current = Buffer.from(chunk);
      total += current.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error("Agent Runtime response is invalid.");
      }
      chunks.push(current);
    }
    bytes = Buffer.concat(chunks, total);
  } else if (typeof body.transformToByteArray === "function") {
    bytes = Buffer.from(await body.transformToByteArray());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("Agent Runtime response is invalid.");
    }
  } else {
    throw new Error("Agent Runtime response is invalid.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Agent Runtime response is invalid.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Agent Runtime response is invalid.");
  }
}

function normalizeResponse(response, request) {
  if (
    !isPlainObject(response)
    || response.statusCode !== 200
    || !JSON_CONTENT_TYPE.test(response.contentType ?? "")
    || response.runtimeSessionId !== request.sessionId
  ) {
    throw new Error("Agent Runtime response is invalid.");
  }
  return readResponseBody(response.response).then((body) => {
    if (!isPlainObject(body)) {
      throw new Error("Agent Runtime response is invalid.");
    }
    const values = exactValues(body, [
      "agentId",
      "sessionId",
      "output",
      "upstreamRequestId",
      "usage",
      ...(Object.hasOwn(body, "metering") ? ["metering"] : []),
      ...(Object.hasOwn(body, "execution") ? ["execution"] : []),
    ]);
    if (
      values === null
      || values.agentId !== request.agentId
      || values.sessionId !== request.sessionId
      || typeof values.output !== "string"
      || Buffer.byteLength(values.output, "utf8") > MAX_OUTPUT_BYTES
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
        values.output,
      )
      || (
        values.upstreamRequestId !== null
        && (
          typeof values.upstreamRequestId !== "string"
          || !RESULT_ID_PATTERN.test(values.upstreamRequestId)
        )
      )
      || !validUsage(values.usage)
      || (values.metering !== undefined && !validMetering(values.metering))
      || (values.execution !== undefined && !validExecution(values.execution))
      || (
        response.traceId !== undefined
        && !RESULT_ID_PATTERN.test(response.traceId)
      )
    ) {
      throw new Error("Agent Runtime response is invalid.");
    }
    return {
      output: values.output,
      invocationId:
        response.traceId
        || values.upstreamRequestId
        || request.requestId,
      accounting: {
        version: 1,
        runId: createHash("sha256").update(`${request.actor}\0${request.requestId}`).digest("hex"),
        // This adapter dispatches exactly one Gateway call and has no retry loop.
        attemptId: "gateway-1",
        environment: "PRODUCTION",
        purpose: "user",
        modelId: request.modelId,
        providerRequestId: values.upstreamRequestId,
        traceId: response.traceId ?? null,
        usage: values.usage,
        metering: values.metering ?? null,
        execution: values.execution ?? null,
        pricingVersion: null,
        estimatedCostUsd: null,
      },
    };
  });
}

export function createAgentRuntimeAdapter({
  client,
  timeoutMs = DEFAULT_RUNTIME_TIMEOUT_MS,
  maxTokens = 2_048,
  outputCaps = [],
  proofConfigProvider,
  proofClock = Date.now,
  proofNonce,
} = {}) {
  if (
    !client
    || typeof client.send !== "function"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 120_000
    || !Number.isSafeInteger(maxTokens)
    || maxTokens < 1
    || maxTokens > 8_192
    || typeof proofConfigProvider !== "function"
  ) {
    throw new TypeError("Agent Runtime adapter configuration is invalid.");
  }
  const caps = outputCapConfiguration(outputCaps);

  return Object.freeze({
    async invoke(input) {
      const request = invocationInput(input);
      if (request === null) {
        throw new TypeError("Agent Runtime invocation input is invalid.");
      }
      const ceiling = caps.get(`${request.domainId}/${request.projectId}/${request.agentId}`);
      let effectiveMaxTokens = maxTokens;
      if (ceiling !== undefined) {
        // The authorized persisted target may lower, but never raise, this
        // server-owned opt-in ceiling. Missing targets must not use the default.
        if (
          !Number.isSafeInteger(request.configuredMaxTokens)
          || request.configuredMaxTokens < 1
          || request.configuredMaxTokens > 4_096
        ) {
          throw new TypeError("Agent Runtime bounded output configuration is invalid.");
        }
        effectiveMaxTokens = Math.min(maxTokens, request.configuredMaxTokens, ceiling);
      }
      const signedPayload = {
        agentConfig: {
          agentId: request.agentId,
          modelId: request.modelId,
        },
        ...(request.nativeExecution === undefined ? {} : { accounting: {
          version: 1,
          runId: createHash("sha256").update(`${request.actor}\0${request.requestId}`).digest("hex"),
          payloadFingerprint: request.nativeExecution.payloadFingerprint,
          attemptId: "gateway-1", environment: "PRODUCTION", purpose: "user",
        } }),
        prompt: request.prompt,
        maxTokens: effectiveMaxTokens,
        session: {
          sessionId: request.sessionId,
          metadata: {
            actor: request.actor,
            requestId: request.requestId,
            domainId: request.domainId,
            projectId: request.projectId,
          },
        },
      };
      let payload;
      try {
        const configuration = proofConfiguration(
          await proofConfigProvider(),
        );
        if (
          configuration === null
          || configuration.allowedEndpointArn !== request.endpointArn
        ) {
          throw new Error("Runtime proof configuration mismatch.");
        }
        const proofSecret = configuration.hmacKey;
        const invocationProof = createRuntimeInvocationProof({
          secret: proofSecret,
          clock: proofClock,
          nonce: proofNonce,
        });
        const proof = invocationProof.sign(signedPayload, request.endpointArn);
        await request.nativeExecution?.prepare({ payload: signedPayload, proof });
        payload = Buffer.from(JSON.stringify({
          ...signedPayload,
          proof,
        }));
      } catch {
        throw new Error("Agent Runtime invocation failed.");
      }
      // A crash between this durable accepted-dispatch marker and send remains
      // indeterminate; the marker is not proof that the provider was billed.
      await request.onDispatch?.({ region: request.runtimeArn.split(":")[3] });
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(), timeoutMs);
      timer.unref?.();
      try {
        const response = await client.send(
          new InvokeAgentRuntimeCommand({
            agentRuntimeArn: request.runtimeArn,
            qualifier: request.endpointName,
            contentType: "application/json",
            accept: "application/json",
            runtimeSessionId: request.sessionId,
            runtimeUserId: request.actor,
            payload,
          }),
          { abortSignal: abortController.signal },
        );
        return await normalizeResponse(response, request);
      } catch (error) {
        if (error?.message === "Agent Runtime response is invalid.") {
          throw error;
        }
        throw new Error("Agent Runtime invocation failed.");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
