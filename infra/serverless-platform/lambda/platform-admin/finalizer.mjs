import { isDeepStrictEqual } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createPlatformState } from "./state.mjs";

const OPERATION = "FINALIZE_REGISTRY_DECISION";
const STABLE_ERROR_CODES = new Set([
  "IDEMPOTENCY_CONFLICT",
  "REGISTRY_RESOURCE_CONFLICT",
  "REQUEST_CLAIM_CONFLICT",
]);

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

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.size
    && Object.keys(value).every((key) => keys.has(key));
}

function finalizerError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createRegistryDecisionFinalizer({ state } = {}) {
  if (
    !state
    || typeof state.putRegistryDecisionAuditWithRequestResult
      !== "function"
    || typeof state.getAudit !== "function"
    || typeof state.putRegistryDecisionResultForAuditReplay
      !== "function"
  ) {
    throw new TypeError("Registry decision finalizer state is invalid.");
  }
  return {
    async finalize(input) {
      try {
        await state.putRegistryDecisionAuditWithRequestResult(input);
        return { ok: true };
      } catch (error) {
        if (error?.code !== "AUDIT_CONFLICT") throw error;
      }

      let storedAudit;
      try {
        storedAudit = await state.getAudit({
          actor: input?.audit?.actor,
          timestamp: input?.audit?.timestamp,
          requestId: input?.audit?.requestId,
        });
      } catch {
        throw finalizerError(
          "FINALIZER_UNAVAILABLE",
          "Registry decision finalization is unavailable.",
        );
      }
      if (!isDeepStrictEqual(storedAudit, input.audit)) {
        throw finalizerError(
          "IDEMPOTENCY_CONFLICT",
          "Registry decision evidence conflicted.",
        );
      }
      await state.putRegistryDecisionResultForAuditReplay({
        requestResult: input.requestResult,
        claim: input.claim,
      });
      return { ok: true, replayed: true };
    },
  };
}

export function createRegistryDecisionFinalizerHandler({
  finalizer,
  logger = console,
} = {}) {
  if (!finalizer || typeof finalizer.finalize !== "function") {
    throw new TypeError("Registry decision finalizer is invalid.");
  }
  return async function registryDecisionFinalizerHandler(event) {
    if (
      !hasExactKeys(event, new Set(["operation", "payload"]))
      || event.operation !== OPERATION
      || !isPlainObject(event.payload)
    ) {
      return { ok: false, code: "FINALIZER_INVALID_REQUEST" };
    }
    try {
      return await finalizer.finalize(event.payload);
    } catch (error) {
      const code = STABLE_ERROR_CODES.has(error?.code)
        ? error.code
        : "FINALIZER_UNAVAILABLE";
      try {
        logger?.error?.({
          event: "registry_decision_finalization_failed",
          code,
        });
      } catch {
        // Logging must not change the stable internal response.
      }
      return { ok: false, code };
    }
  };
}

function createConfiguredFinalizer() {
  const tableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const region = process.env.AWS_REGION;
  if (
    typeof tableName !== "string"
    || !tableName.trim()
    || typeof region !== "string"
    || !region.trim()
  ) {
    throw new Error("Registry decision finalizer configuration is unavailable.");
  }
  return createRegistryDecisionFinalizer({
    state: createPlatformState({
      tableName,
      dynamo: new DynamoDBClient({ region }),
      now: () => new Date(),
    }),
  });
}

let configuredHandler;

export const handler = async (event) => {
  configuredHandler ??= createRegistryDecisionFinalizerHandler({
    finalizer: createConfiguredFinalizer(),
  });
  return configuredHandler(event);
};
