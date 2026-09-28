import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GetItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { validUsage, validMetering } from "./usage.mjs";
import { createModelPriceBook, validUsageRoute } from "../operations/model-prices.mjs";
import { converseModelTarget, validConverseRuntime } from "./bedrock-inference.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const S = value => ({ S: value });
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable === true && Object.hasOwn(property, "value");
  });
const eventKey = request => ({
  pk: S(`NATIVE_EXECUTION_EVENT#${hash(request.proof.signature)}`), sk: S("EXECUTION"),
});
const bindingKey = runId => ({ pk: S(`NATIVE_EXECUTION_BINDING#${runId}`), sk: S("BINDING") });

export function nativeExecutionEnabled(version) {
  if (version === undefined || version === "disabled") return false;
  if (version !== "native-v1") throw new TypeError("Native execution version is invalid.");
  return true;
}

export function validExecutionBinding(value, metadata) {
  return exact(value, ["version", "runId", "payloadFingerprint", "attemptId", "environment", "purpose"])
    && value.version === 1 && value.runId === hash(`${metadata.actor}\0${metadata.requestId}`)
    && /^[a-f0-9]{64}$/.test(value.payloadFingerprint)
    && value.attemptId === "gateway-1" && value.environment === "PRODUCTION" && value.purpose === "user";
}

function fail(code = "EXECUTION_JOURNAL_UNAVAILABLE") {
  throw Object.assign(new Error("Native execution journal unavailable."), { code });
}

function timestamp(now) {
  const value = now();
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) fail();
  return result.toISOString();
}

function validObservation(value) {
  const converse = value?.protocol === "bedrock-converse-v1";
  return exact(value, ["protocol", "providerRequestId", "usage", "metering", ...(converse ? ["runtime"] : [])])
    && (converse ? validConverseRuntime(value.runtime) && value.metering === null
      : ["anthropic-v1", "openai-v1"].includes(value.protocol))
    && (value.providerRequestId === null || (typeof value.providerRequestId === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value.providerRequestId)))
    && validUsage(value.usage) && (value.metering === null || validMetering(value.metering));
}

function validPrice(value) {
  return exact(value, ["estimatedCostUsd", "pricingVersion", "priceSource", "pricingRevision"])
    && /^[a-f0-9]{64}$/.test(value.pricingRevision)
    && (value.estimatedCostUsd === null || (Number.isFinite(value.estimatedCostUsd) && value.estimatedCostUsd >= 0))
    && (value.pricingVersion === null || typeof value.pricingVersion === "string")
    && (value.priceSource === null || (exact(value.priceSource,
      ["id", "url", "retrievedAt", "effectiveFrom", "effectiveTo"])
      && value.priceSource.id === value.pricingVersion
      && typeof value.priceSource.url === "string" && value.priceSource.url.startsWith("https://")
      && ["retrievedAt", "effectiveFrom", "effectiveTo"].every(key => instant(value.priceSource[key]))))
    && (value.estimatedCostUsd === null || value.priceSource !== null);
}

function parseEvent(item, key) {
  if (!item || !isDeepStrictEqual(item.pk, key.pk) || !isDeepStrictEqual(item.sk, key.sk)
    || Reflect.ownKeys(item).some(name => !["pk", "sk", "startedAt", "usage", "terminal"].includes(name)
      || !exact(item[name], ["S"]) || typeof item[name].S !== "string")) fail();
  const startedAt = item.startedAt?.S ?? null;
  if (startedAt !== null && !instant(startedAt)) fail();
  let usage = null;
  let terminal = null;
  try {
    if (item.usage !== undefined) usage = JSON.parse(item.usage.S);
    if (item.terminal !== undefined) terminal = JSON.parse(item.terminal.S);
  } catch { fail(); }
  if ((item.usage !== undefined && usage === null) || (item.terminal !== undefined && terminal === null)) fail();
  if (usage !== null && (!exact(usage, ["version", "attemptId", "occurredAt", "observation", "route", "price"])
    || usage.version !== (usage.observation?.protocol === "bedrock-converse-v1" ? 2 : 1)
    || (usage.version === 2 && (usage.route !== null || usage.price?.estimatedCostUsd !== null))
    || usage.attemptId !== "gateway-1" || !instant(usage.occurredAt)
    || startedAt === null || usage.occurredAt < startedAt || !validObservation(usage.observation)
    || !(usage.route === null || validUsageRoute(usage.route)) || !validPrice(usage.price))) fail();
  if (terminal !== null && (!exact(terminal, ["status", "completedAt"])
    || !["SUCCEEDED", "FAILED", "UNKNOWN"].includes(terminal.status)
    || !instant(terminal.completedAt) || startedAt === null || terminal.completedAt < startedAt
    || (usage !== null && terminal.completedAt < usage.occurredAt))) fail();
  return { startedAt, usage, terminal };
}

// Runtime has GetItem/UpdateItem on EVENT keys only. It cannot create or edit
// BINDING rows, list their capabilities, or set domain/project/model identity.
// Orphan event upserts by that role are never an accounting authority.
export function createExecutionWriter({ tableName, dynamo, now, route = null, priceBook, converseReaderVersion } = {}) {
  if (!tableName || typeof dynamo?.send !== "function" || typeof now !== "function"
    || !(route === null || validUsageRoute(route))) throw new TypeError("Native execution writer is invalid.");
  const book = createModelPriceBook(priceBook);
  const attestedRoute = route === null ? null : Object.freeze({ ...route });
  async function write(request, field, value) {
    const key = eventKey(request);
    try {
      const result = await dynamo.send(new UpdateItemCommand({
        TableName: tableName, Key: key,
        UpdateExpression: "SET #field = :value",
        ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(#field)${
          field === "startedAt" ? "" : " AND attribute_exists(startedAt)"
        }${field === "usage" ? " AND attribute_not_exists(terminal)" : ""}`,
        ExpressionAttributeNames: { "#field": field },
        ExpressionAttributeValues: { ":value": S(field === "startedAt" ? value : JSON.stringify(value)) },
        ReturnValues: "NONE",
      }));
      if (!result || typeof result !== "object") fail();
      return true;
    } catch (error) {
      if (error?.name !== "ConditionalCheckFailedException") fail();
      const response = await dynamo.send(new GetItemCommand({
        TableName: tableName, Key: key, ConsistentRead: true,
      }));
      const stored = parseEvent(response?.Item, key);
      if (field === "usage" && stored.usage !== null
        && isDeepStrictEqual(stored.usage.observation, value.observation)
        && isDeepStrictEqual(stored.usage.route, value.route)) return false;
      if (!isDeepStrictEqual(stored[field], value)) fail("EXECUTION_JOURNAL_CONFLICT");
      return false;
    }
  }
  return Object.freeze({
    async start(request, startedAt) {
      if (!validExecutionBinding(request.accounting, request.session.metadata) || !instant(startedAt)) fail();
      return write(request, "startedAt", startedAt);
    },
    async recordUsage(request, observation) {
      if (!validObservation(observation)) fail();
      const converse = observation.protocol === "bedrock-converse-v1";
      if (converse && (converseReaderVersion !== "converse-v1" || attestedRoute !== null
        || converseModelTarget(request.agentConfig.modelId) !== observation.runtime.requestModelId)) fail();
      const occurredAt = timestamp(now);
      const selectedRoute = !converse && attestedRoute?.modelId === request.agentConfig.modelId ? attestedRoute : null;
      const price = book.estimateUsage(observation, selectedRoute, occurredAt);
      await write(request, "usage", {
        version: converse ? 2 : 1, attemptId: request.accounting.attemptId, occurredAt, observation,
        route: selectedRoute, price: { ...price, pricingRevision: book.fingerprint },
      });
    },
    async finish(request, terminal) {
      if (!exact(terminal, ["status", "completedAt"])
        || !["SUCCEEDED", "FAILED", "UNKNOWN"].includes(terminal.status) || !instant(terminal.completedAt)) fail();
      await write(request, "terminal", terminal);
    },
  });
}

// Experience is the sole binding writer. The binding is separate from legacy
// invocation rows, which keeps existing strict readers/rollback binaries safe.
export function createNativeExecutionJournal({ tableName, dynamo, now } = {}) {
  if (!tableName || typeof dynamo?.send !== "function" || typeof now !== "function") {
    throw new TypeError("Native execution journal is invalid.");
  }
  return Object.freeze({
    async prepare(reservation, { payload, proof }) {
      const metadata = payload.session?.metadata;
      if (!metadata || !validExecutionBinding(payload.accounting, metadata)
        || ["actor", "requestId", "domainId", "projectId"].some(key => metadata[key] !== reservation[key])
        || payload.accounting.payloadFingerprint !== reservation.payloadFingerprint
        || payload.agentConfig.agentId !== reservation.agentId || payload.session.sessionId !== reservation.sessionId
        || typeof proof?.signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof.signature)) fail();
      const key = eventKey({ proof });
      const binding = {
        version: 1, runId: payload.accounting.runId,
        reservation, modelId: payload.agentConfig.modelId,
        endpointArn: proof.audience, eventKey: key, createdAt: timestamp(now),
      };
      const names = Object.fromEntries(Object.keys(reservation).map(name => [`#${name}`, name]));
      const values = Object.fromEntries(Object.entries(reservation).map(([name, value]) =>
        [`:${name}`, S(value === null ? "NONE" : value)]));
      // Atomic reservation check + immutable authorization + empty event slot.
      // No raw prompts, proof secrets, outputs or bearer capabilities in logs.
      const result = await dynamo.send(new TransactWriteItemsCommand({
        TransactItems: [
          { Update: {
            TableName: tableName,
            Key: { pk: S(`EXPERIENCE_INVOCATION#${reservation.actor}`), sk: S(`REQUEST#${reservation.requestId}`) },
            // Same-value update uses the existing narrow UpdateItem grant. It
            // checks the reservation atomically without adding attributes.
            UpdateExpression: "SET #payloadFingerprint = :payloadFingerprint",
            ConditionExpression: Object.keys(reservation).map(name => `#${name} = :${name}`).join(" AND ")
              + " AND #phase = :phase",
            ExpressionAttributeNames: { ...names, "#phase": "phase" },
            ExpressionAttributeValues: { ...values, ":phase": S("STARTED") },
          } },
          { Put: { TableName: tableName,
            Item: { ...bindingKey(binding.runId), binding: S(JSON.stringify(binding)) },
            ConditionExpression: "attribute_not_exists(pk)" } },
          { Put: { TableName: tableName, Item: key, ConditionExpression: "attribute_not_exists(pk)" } },
        ],
      }));
      if (!result || typeof result !== "object") fail();
    },
    async read(reservation, { abortSignal } = {}) {
      const runId = hash(`${reservation.actor}\0${reservation.requestId}`);
      abortSignal?.throwIfAborted();
      const response = await dynamo.send(new GetItemCommand({
        TableName: tableName, Key: bindingKey(runId), ConsistentRead: true,
      }), abortSignal ? { abortSignal } : undefined);
      if (response?.Item === undefined) return null;
      if (!exact(response.Item, ["pk", "sk", "binding"])
        || !isDeepStrictEqual(response.Item.pk, bindingKey(runId).pk)
        || !isDeepStrictEqual(response.Item.sk, bindingKey(runId).sk)
        || !exact(response.Item.binding, ["S"]) || typeof response.Item.binding.S !== "string") fail();
      let binding;
      try { binding = JSON.parse(response.Item.binding.S); } catch { fail(); }
      if (!exact(binding, ["version", "runId", "reservation", "modelId", "endpointArn", "eventKey", "createdAt"])
        || binding.version !== 1 || binding.runId !== runId
        || !isDeepStrictEqual(binding.reservation, reservation) || !instant(binding.createdAt)
        || !exact(binding.eventKey, ["pk", "sk"])
        || !/^NATIVE_EXECUTION_EVENT#[a-f0-9]{64}$/.test(binding.eventKey.pk?.S)
        || binding.eventKey.sk?.S !== "EXECUTION") fail();
      const event = await dynamo.send(new GetItemCommand({
        TableName: tableName, Key: binding.eventKey, ConsistentRead: true,
      }), abortSignal ? { abortSignal } : undefined);
      const result = parseEvent(event?.Item, binding.eventKey);
      if ((result.startedAt !== null && result.startedAt < binding.createdAt)
        || (result.usage?.version === 2
          && converseModelTarget(binding.modelId) !== result.usage.observation.runtime.requestModelId)
        || (result.usage?.route != null && result.usage.route.modelId !== binding.modelId)) fail();
      return { ...result, modelId: binding.modelId, endpointArn: binding.endpointArn };
    },
  });
}
