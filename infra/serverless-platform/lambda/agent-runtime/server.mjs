import { createServer } from "node:http";
import {
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createConfiguredBedrockInference } from "./bedrock-inference.mjs";
import {
  createIamCredentialsProvider,
} from "./credentials.mjs";
import {
  createAgentRuntimeHttpHandler,
} from "./http.mjs";
import {
  createAgentRuntimeMetrics,
} from "./metrics.mjs";
import {
  createRuntimeProofSecretProvider,
} from "./proof-secret.mjs";
import {
  createRuntimeProofReplayLedger,
} from "./replay-ledger.mjs";
import {
  createAgentRuntimeService,
} from "./service.mjs";
import { createExecutionWriter, nativeExecutionEnabled } from "./execution-journal.mjs";

export function resolveRuntimePort(env = process.env) {
  if (env.PORT === undefined) return 8080;
  if (!/^(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/.test(
    env.PORT,
  )) {
    throw new TypeError("PORT must be an integer between 1 and 65535.");
  }
  return Number(env.PORT);
}

export function createConfiguredAgentRuntime({
  env = process.env,
  credentialsProvider,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  metricWriter = (line) => process.stdout.write(`${line}\n`),
  proofConfigProvider,
  proofReplayLedger,
  executionWriter,
} = {}) {
  if (typeof metricWriter !== "function") {
    throw new TypeError("Agent Runtime configuration is invalid.");
  }
  const gateway = createConfiguredBedrockInference({
    env,
    credentialsProvider: credentialsProvider ?? createIamCredentialsProvider({ env, fetchImpl, clock }),
    fetchImpl,
  });
  const service = createAgentRuntimeService({
    gateway,
    metrics: createAgentRuntimeMetrics({
      write: metricWriter,
      clock,
    }),
    clock,
    proofConfigProvider,
    proofReplayLedger,
    executionWriter,
  });
  const handler = createAgentRuntimeHttpHandler({ service });
  return Object.freeze({ handler, service });
}

export async function startAgentRuntime({
  env = process.env,
  credentialsProvider,
  fetchImpl,
  clock,
  metricWriter,
  proofConfigProvider,
  proofReplayLedger,
  executionWriter,
  secretsClientFactory = (config) =>
    new SecretsManagerClient(config),
  dynamoClientFactory = (config) => new DynamoDBClient(config),
  createServerImpl = createServer,
} = {}) {
  if (
    typeof createServerImpl !== "function"
    || (
      proofConfigProvider !== undefined
      && typeof proofConfigProvider !== "function"
    )
    || typeof secretsClientFactory !== "function"
    || typeof dynamoClientFactory !== "function"
    || (
      proofReplayLedger !== undefined
      && (
        !proofReplayLedger
        || typeof proofReplayLedger.consume !== "function"
      )
    )
  ) {
    throw new TypeError("Agent Runtime server factory is invalid.");
  }
  const resolvedProofConfigProvider = proofConfigProvider
    ?? createRuntimeProofSecretProvider({
      client: secretsClientFactory({ region: env.AWS_REGION }),
      secretArn: env.RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    });
  const resolvedProofReplayLedger = proofReplayLedger
    ?? createRuntimeProofReplayLedger({
      tableName: env.PLATFORM_STATE_TABLE_NAME,
      dynamo: dynamoClientFactory({ region: env.AWS_REGION }),
      clock: clock ?? Date.now,
    });
  const nativeEnabled = nativeExecutionEnabled(env.RUNTIME_NATIVE_EXECUTION_VERSION);
  const usageRoute = nativeEnabled && env.RUNTIME_USAGE_ROUTE_JSON !== undefined
    ? JSON.parse(env.RUNTIME_USAGE_ROUTE_JSON) : null;
  if (usageRoute !== null) {
    throw new TypeError("A Gateway usage route cannot attest direct Bedrock Runtime inference.");
  }
  if (nativeEnabled && env.RUNTIME_CONVERSE_READER_VERSION !== "converse-v2") {
    throw new TypeError("Converse native writes require upgraded reader attestation.");
  }
  const resolvedExecutionWriter = executionWriter ?? (nativeEnabled
    ? createExecutionWriter({
      tableName: env.PLATFORM_STATE_TABLE_NAME,
      dynamo: dynamoClientFactory({ region: env.AWS_REGION }),
      now: clock ?? Date.now,
      route: usageRoute,
      converseReaderVersion: env.RUNTIME_CONVERSE_READER_VERSION,
      priceBook: env.OPERATIONS_MODEL_PRICES_JSON === undefined
        ? { version: 2, entries: [] } : JSON.parse(env.OPERATIONS_MODEL_PRICES_JSON),
    }) : undefined);
  const runtime = createConfiguredAgentRuntime({
    env,
    ...(credentialsProvider === undefined
      ? {}
      : { credentialsProvider }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(clock === undefined ? {} : { clock }),
    ...(metricWriter === undefined ? {} : { metricWriter }),
    proofConfigProvider: resolvedProofConfigProvider,
    proofReplayLedger: resolvedProofReplayLedger,
    executionWriter: resolvedExecutionWriter,
  });
  const server = createServerImpl(runtime.handler);
  server.listen(resolveRuntimePort(env), "0.0.0.0");
  return server;
}
