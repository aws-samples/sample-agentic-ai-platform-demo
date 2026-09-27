import { Buffer } from "node:buffer";
import { validMetering } from "./usage.mjs";
import { validExecutionBinding } from "./execution-journal.mjs";
import {
  createRuntimeInvocationProof,
} from "./invocation-proof.mjs";
import {
  domainGatewaySourceIdentity,
} from "../workspace/gateway-source-identity.mjs";

const ERROR_DEFINITIONS = Object.freeze({
  INVALID_REQUEST: Object.freeze({
    message: "The invocation request is invalid.",
    statusCode: 400,
    retryable: false,
  }),
  INVALID_GATEWAY_RESPONSE: Object.freeze({
    message: "The Gateway returned an invalid response.",
    statusCode: 502,
    retryable: false,
  }),
  GATEWAY_UNAVAILABLE: Object.freeze({
    message: "The Gateway invocation is unavailable.",
    statusCode: 502,
    retryable: true,
  }),
  RUNTIME_PROOF_UNAVAILABLE: Object.freeze({
    message: "Runtime invocation authorization is unavailable.",
    statusCode: 503,
    retryable: true,
  }),
  EXECUTION_JOURNAL_UNAVAILABLE: Object.freeze({
    message: "Native execution accounting is unavailable.",
    statusCode: 503,
    retryable: false,
  }),
});

const ROOT_KEYS = new Set([
  "agentConfig",
  "prompt",
  "maxTokens",
  "session",
  "proof",
  "accounting",
]);
const AGENT_CONFIG_KEYS = new Set([
  "agentId",
  "modelId",
  "instructions",
]);
const SESSION_KEYS = new Set([
  "sessionId",
  "metadata",
]);
const MAX_PROMPT_LENGTH = 16_384;
const MAX_INSTRUCTIONS_LENGTH = 4_096;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_TOKENS = 8_192;
const MAX_METADATA_ENTRIES = 16;
const MAX_METADATA_VALUE_LENGTH = 256;
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const RUNTIME_ENDPOINT_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/[A-Za-z0-9_-]{1,48}\/runtime-endpoint\/[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const PROOF_CONFIG_KEYS = Object.freeze([
  "hmacKey",
  "previousHmacKey",
  "allowedEndpointArn",
  "keyId",
]);
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NON_CONSUMING_REPLAY_CACHE = Object.freeze({
  consume() {
    return true;
  },
});

export class AgentRuntimeError extends Error {
  constructor(code, overrides = {}) {
    const definition = ERROR_DEFINITIONS[code];
    if (!definition) {
      throw new TypeError("Agent Runtime error code is invalid.");
    }
    super(definition.message);
    this.name = "AgentRuntimeError";
    this.code = code;
    this.statusCode = overrides.statusCode ?? definition.statusCode;
    this.retryable = overrides.retryable ?? definition.retryable;
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

function strictValues(
  value,
  allowedKeys,
  requiredKeys,
  errorCode = "INVALID_REQUEST",
) {
  if (!isPlainObject(value)) {
    throw new AgentRuntimeError(errorCode);
  }
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
    throw new AgentRuntimeError(errorCode);
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  );
}

function validText(value, maxLength, { allowNewlines = true } = {}) {
  const excludedControls = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim().length > 0
    && !excludedControls.test(value)
  );
}

function validDomainId(value) {
  return (
    typeof value === "string"
    && value.length >= 2
    && value.length <= 64
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function validateMetadata(value) {
  if (!isPlainObject(value)) {
    throw new AgentRuntimeError("INVALID_REQUEST");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || keys.some((key) => (
      !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
    || keys.length > MAX_METADATA_ENTRIES
    || keys.some((key) => !METADATA_KEY_PATTERN.test(key))
    || keys.some((key) => !validText(
      descriptors[key].value,
      MAX_METADATA_VALUE_LENGTH,
      { allowNewlines: false },
    ))
  ) {
    throw new AgentRuntimeError("INVALID_REQUEST");
  }
  const entries = Object.fromEntries(
    keys.map((key) => [key, descriptors[key].value]),
  );
  return Object.freeze({ ...entries });
}

export function validateAgentRuntimeRequest(input) {
  const root = strictValues(
    input,
    ROOT_KEYS,
    ["agentConfig", "prompt", "maxTokens", "session", "proof"],
  );
  const agentConfig = strictValues(
    root.agentConfig,
    AGENT_CONFIG_KEYS,
    ["agentId", "modelId"],
  );
  if (
    !AGENT_ID_PATTERN.test(agentConfig.agentId)
    || !MODEL_ID_PATTERN.test(agentConfig.modelId)
    || agentConfig.modelId.includes("://")
    || !validText(root.prompt, MAX_PROMPT_LENGTH)
    || !Number.isInteger(root.maxTokens)
    || root.maxTokens < 1
    || root.maxTokens > MAX_TOKENS
    || !isPlainObject(root.proof)
    || (
      agentConfig.instructions !== undefined
      && !validText(
        agentConfig.instructions,
        MAX_INSTRUCTIONS_LENGTH,
      )
    )
  ) {
    throw new AgentRuntimeError("INVALID_REQUEST");
  }

  const prompt = agentConfig.instructions === undefined
    ? root.prompt
    : (
      "Agent instructions:\n"
      + `${agentConfig.instructions}\n\n`
      + "User request:\n"
      + root.prompt
    );
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new AgentRuntimeError("INVALID_REQUEST");
  }

  const sessionValues = strictValues(
    root.session,
    SESSION_KEYS,
    ["sessionId", "metadata"],
  );
  const metadata = validateMetadata(sessionValues.metadata);
  if (
    !SESSION_ID_PATTERN.test(sessionValues.sessionId)
    || !SUBJECT_PATTERN.test(metadata.actor ?? "")
    || !REQUEST_ID_PATTERN.test(metadata.requestId ?? "")
    || !validDomainId(metadata.domainId)
    || !PROJECT_ID_PATTERN.test(metadata.projectId ?? "")
  ) {
    throw new AgentRuntimeError("INVALID_REQUEST");
  }
  const session = {
    sessionId: sessionValues.sessionId,
    metadata,
  };
  if (root.accounting !== undefined && !validExecutionBinding(root.accounting, metadata)) {
    throw new AgentRuntimeError("INVALID_REQUEST");
  }

  const normalizedAgentConfig = Object.freeze({
    agentId: agentConfig.agentId,
    modelId: agentConfig.modelId,
    ...(agentConfig.instructions === undefined
      ? {}
      : { instructions: agentConfig.instructions }),
  });
  const proofPayload = Object.freeze({
    agentConfig: normalizedAgentConfig,
    prompt: root.prompt,
    maxTokens: root.maxTokens,
    session: Object.freeze(session),
    ...(root.accounting === undefined ? {} : { accounting: Object.freeze({ ...root.accounting }) }),
  });
  return Object.freeze({
    ...proofPayload,
    gatewayPrompt: prompt,
    proof: root.proof,
    proofPayload,
  });
}

function validUsage(value) {
  let usage;
  try {
    usage = strictValues(
      value,
      new Set(["inputTokens", "outputTokens", "totalTokens"]),
      ["inputTokens", "outputTokens", "totalTokens"],
      "INVALID_GATEWAY_RESPONSE",
    );
  } catch {
    return false;
  }
  const { inputTokens, outputTokens, totalTokens } = usage;
  return (
    Number.isSafeInteger(inputTokens)
    && inputTokens >= 0
    && Number.isSafeInteger(outputTokens)
    && outputTokens >= 0
    && Number.isSafeInteger(totalTokens)
    && totalTokens === inputTokens + outputTokens
  );
}

function normalizeGatewayResult(value, request) {
  const result = strictValues(
    value,
    new Set(["output", "requestId", "usage", "metering"]),
    ["output", "usage"],
    "INVALID_GATEWAY_RESPONSE",
  );
  if (
    typeof result.output !== "string"
    || Buffer.byteLength(result.output, "utf8") > MAX_OUTPUT_BYTES
    || (
      result.requestId !== undefined
      && !REQUEST_ID_PATTERN.test(result.requestId)
    )
    || !validUsage(result.usage)
    || (result.metering !== undefined && !validMetering(result.metering))
  ) {
    throw new AgentRuntimeError("INVALID_GATEWAY_RESPONSE");
  }
  return {
    agentId: request.agentConfig.agentId,
    sessionId: request.session.sessionId,
    output: result.output,
    upstreamRequestId: result.requestId ?? null,
    ...(result.metering === undefined ? {} : { metering: result.metering }),
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}

function gatewayFailure(error) {
  const statusCode = [502, 503, 504].includes(error?.statusCode)
    ? error.statusCode
    : 502;
  return new AgentRuntimeError("GATEWAY_UNAVAILABLE", {
    statusCode,
    retryable: error?.retryable === true,
  });
}

function metricScope(request) {
  const metadata = request.session.metadata;
  return {
    domainId: metadata.domainId,
    projectId: metadata.projectId,
  };
}

function readClock(clock) {
  try {
    const value = clock();
    const result = value instanceof Date ? value.getTime() : value;
    return Number.isFinite(result) && result >= 0 ? result : null;
  } catch {
    return null;
  }
}

function executionTimestamp(clock) {
  const value = readClock(clock);
  if (value === null) throw new AgentRuntimeError("EXECUTION_JOURNAL_UNAVAILABLE");
  return new Date(value).toISOString();
}

function recordMetrics(metrics, clock, scope, startedAt, values) {
  if (scope === null || startedAt === null) return;
  const completedAt = readClock(clock);
  if (completedAt === null || completedAt < startedAt) return;
  try {
    metrics.recordInvocation({
      ...scope,
      ...values,
      latencyMs: completedAt - startedAt,
    });
  } catch {
    // Metrics are intentionally best effort and never affect an invocation.
  }
  return completedAt;
}

function proofConfiguration(value) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== PROOF_CONFIG_KEYS.length
    || keys.some((key) => (
      typeof key !== "string"
      || !PROOF_CONFIG_KEYS.includes(key)
      || !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
  ) {
    return null;
  }
  const configuration = Object.fromEntries(
    PROOF_CONFIG_KEYS.map((key) => [key, descriptors[key].value]),
  );
  if (
    typeof configuration.allowedEndpointArn !== "string"
    || !RUNTIME_ENDPOINT_ARN_PATTERN.test(
      configuration.allowedEndpointArn,
    )
    || typeof configuration.keyId !== "string"
    || !KEY_ID_PATTERN.test(configuration.keyId)
    || (
      configuration.previousHmacKey !== null
      && configuration.previousHmacKey === configuration.hmacKey
    )
  ) {
    return null;
  }
  const keysToValidate = [
    configuration.hmacKey,
    ...(configuration.previousHmacKey === null
      ? []
      : [configuration.previousHmacKey]),
  ];
  try {
    for (const secret of keysToValidate) {
      createRuntimeInvocationProof({
        secret,
        replayCache: NON_CONSUMING_REPLAY_CACHE,
      });
    }
  } catch {
    return null;
  }
  return configuration;
}

function verifyProof(request, configuration, clock) {
  for (const secret of [
    configuration.hmacKey,
    ...(configuration.previousHmacKey === null
      ? []
      : [configuration.previousHmacKey]),
  ]) {
    const verifier = createRuntimeInvocationProof({
      secret,
      clock,
      replayCache: NON_CONSUMING_REPLAY_CACHE,
    });
    if (verifier.verify(
      request.proofPayload,
      request.proof,
      configuration.allowedEndpointArn,
    )) {
      return true;
    }
  }
  return false;
}

export function createAgentRuntimeService({
  gateway,
  metrics,
  clock,
  proofConfigProvider,
  proofReplayLedger,
  executionWriter,
} = {}) {
  if (
    !gateway
    || typeof gateway.invoke !== "function"
    || !metrics
    || typeof metrics.recordInvocation !== "function"
    || typeof clock !== "function"
    || typeof proofConfigProvider !== "function"
    || !proofReplayLedger
    || typeof proofReplayLedger.consume !== "function"
    || (executionWriter !== undefined && ["start", "recordUsage", "finish"]
      .some(name => typeof executionWriter?.[name] !== "function"))
  ) {
    throw new TypeError("Agent Runtime service configuration is invalid.");
  }
  return Object.freeze({
    async invoke(input, { abortSignal } = {}) {
      const request = validateAgentRuntimeRequest(input);
      let configuration;
      try {
        configuration = proofConfiguration(
          await proofConfigProvider(),
        );
      } catch {
        configuration = null;
      }
      if (configuration === null) {
        throw new AgentRuntimeError("RUNTIME_PROOF_UNAVAILABLE");
      }
      if (!verifyProof(request, configuration, clock)) {
        throw new AgentRuntimeError("INVALID_REQUEST");
      }
      // The configured provider checks its server allowlist and cap only after
      // proof validation, before consuming a nonce or recording execution.
      if (gateway.validateModel) {
        try {
          gateway.validateModel({
            modelId: request.agentConfig.modelId,
            sourceIdentity: domainGatewaySourceIdentity(request.session.metadata.domainId),
            maxTokens: request.maxTokens,
          });
        } catch {
          throw new AgentRuntimeError("INVALID_REQUEST");
        }
      }
      let consumed;
      try {
        consumed = await proofReplayLedger.consume({
          audience: configuration.allowedEndpointArn,
          nonce: request.proof.nonce,
          expiresAt: request.proof.expiresAt,
        });
      } catch {
        throw new AgentRuntimeError("RUNTIME_PROOF_UNAVAILABLE");
      }
      if (consumed !== true) {
        throw new AgentRuntimeError("INVALID_REQUEST");
      }
      const scope = metricScope(request);
      const startedAt = readClock(clock);
      const native = request.accounting !== undefined;
      // Both sides must opt in. A signed accounting request cannot silently
      // fall back to unjournaled execution during a mismatched rollout.
      if (native) {
        try {
          if (!executionWriter || startedAt === null
            || await executionWriter.start(request, new Date(startedAt).toISOString()) === false) {
            throw new Error("Execution start unavailable or already recorded.");
          }
        } catch {
          throw new AgentRuntimeError("EXECUTION_JOURNAL_UNAVAILABLE");
        }
      }
      let result;
      try {
        result = await gateway.invoke({
          modelId: request.agentConfig.modelId,
          prompt: request.gatewayPrompt,
          maxTokens: request.maxTokens,
          sourceIdentity: domainGatewaySourceIdentity(scope.domainId),
          ...(abortSignal === undefined ? {} : { abortSignal }),
          ...(native ? { onUsage: observation => executionWriter.recordUsage(request, observation) } : {}),
        });
        const normalized = normalizeGatewayResult(result, request);
        if (native) await executionWriter.finish(request, {
          status: "SUCCEEDED", completedAt: executionTimestamp(clock),
        });
        const completedAt = recordMetrics(metrics, clock, scope, startedAt, {
          succeeded: true,
          inputTokens: normalized.usage.inputTokens,
          outputTokens: normalized.usage.outputTokens,
        });
        if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) {
          normalized.execution = {
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
          };
        }
        return normalized;
      } catch (error) {
        if (native) {
          const knownFailure = ["GATEWAY_CREDENTIALS_UNAVAILABLE", "INVALID_GATEWAY_REQUEST",
            "GATEWAY_INVOCATION_REJECTED", "MALFORMED_GATEWAY_RESPONSE", "INVALID_GATEWAY_RESPONSE",
            "INVALID_BEDROCK_REQUEST", "INVALID_BEDROCK_RESPONSE", "BEDROCK_INVOCATION_REJECTED",
            "BEDROCK_CREDENTIALS_UNAVAILABLE"]
            .includes(error?.code);
          try {
            await executionWriter.finish(request, {
              status: knownFailure ? "FAILED" : "UNKNOWN",
              completedAt: executionTimestamp(clock),
            });
          } catch {
            // A lost completion/usage write leaves the durable start unresolved.
            // Do not retry the Gateway to repair accounting.
            throw new AgentRuntimeError("EXECUTION_JOURNAL_UNAVAILABLE");
          }
        }
        recordMetrics(metrics, clock, scope, startedAt, {
          succeeded: false,
          inputTokens: null,
          outputTokens: null,
        });
        if (error instanceof AgentRuntimeError) throw error;
        throw gatewayFailure(error);
      }
    },
  });
}
