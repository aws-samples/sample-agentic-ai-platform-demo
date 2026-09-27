import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { isDeepStrictEqual } from "node:util";
import {
  budgetAlertId, budgetDestination, budgetExact, budgetFail, budgetHash, budgetInstant,
  budgetScope, validBudgetConfig, validBudgetEvaluation,
} from "./budgets.mjs";

const S = value => ({ S: value });
const key = (scope, sk) => {
  budgetScope(scope.domainId, scope.projectId);
  return { pk: S(`PROJECT_BUDGET#${scope.domainId}#${scope.projectId}`), sk: S(sk) };
};
const configKey = scope => key(scope, "CONFIG");
const alertKey = alert => key(alert, `ALERT#${alert.id}`);
const conditional = error => error?.name === "ConditionalCheckFailedException"
  || (error?.name === "TransactionCanceledException"
    && error.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed"));
function item(storageKey, record, revision) {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > 200_000) budgetFail();
  return { ...storageKey, revision: { N: String(revision) }, record: S(serialized) };
}
const mutationFingerprint = config => budgetHash({ ...config, updatedAt: null });
const statuses = ["PENDING", "UNCONFIGURED", "PUBLISHER_UNAVAILABLE", "DESTINATION_MISMATCH",
  "SENDING", "RETRY", "PROVIDER_ACCEPTED", "FAILED", "EXHAUSTED", "SUPERSEDED"];

function validAlert(alert) {
  return budgetExact(alert, ["schemaVersion", "id", "domainId", "projectId", "configVersion", "destination",
    "evaluation", "status", "revision", "attempts", "leaseToken", "leaseUntil", "nextAttemptAt",
    "createdAt", "updatedAt", "providerMessageId", "recipientReceipt"])
    && alert.schemaVersion === 1 && typeof alert.id === "string" && /^[a-f0-9]{64}$/.test(alert.id)
    && Number.isSafeInteger(alert.configVersion) && alert.configVersion > 0
    && budgetDestination(alert.destination) && statuses.includes(alert.status)
    && Number.isSafeInteger(alert.revision) && alert.revision > 0
    && Number.isInteger(alert.attempts) && alert.attempts >= 0 && alert.attempts <= 3
    && (alert.leaseToken === null || (typeof alert.leaseToken === "string" && /^[a-f0-9-]{36}$/.test(alert.leaseToken)))
    && (alert.leaseUntil === null || budgetInstant(alert.leaseUntil))
    && (alert.nextAttemptAt === null || budgetInstant(alert.nextAttemptAt))
    && budgetInstant(alert.createdAt) && budgetInstant(alert.updatedAt) && alert.updatedAt >= alert.createdAt
    && alert.recipientReceipt === "UNVERIFIED"
    && (alert.providerMessageId === null || (typeof alert.providerMessageId === "string"
      && /^[A-Za-z0-9_-]{1,256}$/.test(alert.providerMessageId)))
    && (alert.status === "PROVIDER_ACCEPTED" ? alert.providerMessageId !== null : alert.providerMessageId === null)
    && (alert.status === "SENDING" ? alert.leaseToken !== null && alert.leaseUntil !== null
      : alert.leaseToken === null && alert.leaseUntil === null)
    && validBudgetEvaluation(alert.evaluation) && alert.evaluation.status === "CROSSED" && alert.evaluation.domainId === alert.domainId
    && alert.evaluation.projectId === alert.projectId && alert.evaluation.configVersion === alert.configVersion
    && alert.evaluation.currency === "USD" && alert.evaluation.basis === "estimate"
    && Number.isFinite(alert.evaluation.knownEstimatedCostUsd)
    && alert.evaluation.knownEstimatedCostUsd >= alert.evaluation.thresholdUsd
    && budgetInstant(alert.evaluation.window?.startTime) && budgetInstant(alert.evaluation.window?.endTime)
    && alert.id === budgetAlertId({ ...alert, version: alert.configVersion,
      thresholdPercent: alert.evaluation.thresholdPercent }, alert.evaluation.window);
}

function parse(stored, storageKey, validate, revisionOf) {
  if (!budgetExact(stored, ["pk", "sk", "revision", "record"])
    || !isDeepStrictEqual(stored.pk, storageKey.pk) || !isDeepStrictEqual(stored.sk, storageKey.sk)
    || !budgetExact(stored.record, ["S"]) || typeof stored.record.S !== "string"
    || Buffer.byteLength(stored.record.S) > 200_000 || !budgetExact(stored.revision, ["N"])) budgetFail();
  let record;
  try { record = JSON.parse(stored.record.S); } catch { budgetFail(); }
  if (!validate(record) || stored.revision.N !== String(revisionOf(record))) budgetFail();
  return record;
}

// Same table and native AttributeValue/conditional transaction conventions as
// workspace state. No workspace entity schema, index or existing row changes.
export function createProjectBudgetState({ tableName, dynamo } = {}) {
  if (typeof tableName !== "string" || !tableName.trim() || typeof dynamo?.send !== "function") {
    throw new TypeError("Budget state configuration is invalid.");
  }
  async function get(storageKey, validate, revisionOf, options) {
    const response = await dynamo.send(new GetItemCommand({ TableName: tableName, Key: storageKey, ConsistentRead: true }), options);
    if (!response || typeof response !== "object") budgetFail();
    return response.Item === undefined ? null : parse(response.Item, storageKey, validate, revisionOf);
  }
  const getConfig = (scope, options) => get(configKey(scope), record => validBudgetConfig(record)
    && record.domainId === scope.domainId && record.projectId === scope.projectId, record => record.version, options);
  const getAlert = (alert, options) => get(alertKey(alert), record => validAlert(record)
    && record.id === alert.id && record.domainId === alert.domainId && record.projectId === alert.projectId,
  record => record.revision, options);
  const currentVersion = (scope, version) => ({
    ConditionCheck: { TableName: tableName, Key: configKey(scope),
      ConditionExpression: "#revision = :version", ExpressionAttributeNames: { "#revision": "revision" },
      ExpressionAttributeValues: { ":version": { N: String(version) } } },
  });
  return Object.freeze({
    getConfig,
    async writeConfig(config, expectedVersion) {
      if (!validBudgetConfig(config) || config.version !== expectedVersion + 1
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) budgetFail("INVALID_REQUEST");
      const replayKey = key(config, `MUTATION#${budgetHash([config.updatedBy, config.requestId])}`);
      const replay = () => get(replayKey, validBudgetConfig, record => record.version);
      const checkReplay = stored => {
        if (mutationFingerprint(stored) !== mutationFingerprint(config)) budgetFail("CONFLICT");
        return stored;
      };
      const previous = await replay();
      if (previous !== null) return checkReplay(previous);
      try {
        await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: tableName, Item: item(configKey(config), config, config.version),
              ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(pk)" : "#revision = :version",
              ...(expectedVersion === 0 ? {} : { ExpressionAttributeNames: { "#revision": "revision" },
                ExpressionAttributeValues: { ":version": { N: String(expectedVersion) } } }) } },
            { Put: { TableName: tableName, Item: item(replayKey, config, config.version),
              ConditionExpression: "attribute_not_exists(pk)" } },
          ],
        }));
        return config;
      } catch (error) {
        if (!conditional(error)) throw error;
        const stored = await replay();
        if (stored !== null) return checkReplay(stored);
        budgetFail("CONFLICT");
      }
    },
    async recordCrossing(config, evaluation, options) {
      if (!validBudgetConfig(config) || !validBudgetEvaluation(evaluation) || evaluation.status !== "CROSSED"
        || evaluation.configVersion !== config.version || evaluation.domainId !== config.domainId
        || evaluation.projectId !== config.projectId || evaluation.thresholdPercent !== config.thresholdPercent
        || evaluation.thresholdUsd !== config.monthlyLimitUsd * config.thresholdPercent / 100) budgetFail();
      const alert = {
        schemaVersion: 1, id: budgetAlertId(config, evaluation.window),
        domainId: config.domainId, projectId: config.projectId, configVersion: config.version,
        destination: config.destination, evaluation, status: config.destination === null ? "UNCONFIGURED" : "PENDING",
        revision: 1, attempts: 0, leaseToken: null, leaseUntil: null, nextAttemptAt: null,
        createdAt: evaluation.asOf, updatedAt: evaluation.asOf, providerMessageId: null, recipientReceipt: "UNVERIFIED",
      };
      if (!validAlert(alert)) budgetFail();
      try {
        await dynamo.send(new TransactWriteItemsCommand({
          TransactItems: [
            currentVersion(config, config.version),
            { Put: { TableName: tableName, Item: item(alertKey(alert), alert, 1),
              ConditionExpression: "attribute_not_exists(pk)" } },
          ],
        }), options);
        return alert;
      } catch (error) {
        if (!conditional(error)) throw error;
        if ((await getConfig(config, options))?.version !== config.version) budgetFail("CONFLICT");
        const stored = await getAlert(alert, options);
        if (stored === null) budgetFail("CONFLICT");
        return stored;
      }
    },
    async listAlerts(scope, cursor, options) {
      const storageKey = key(scope, "ALERT#");
      if (cursor !== undefined && (!budgetExact(cursor, ["pk", "sk"])
        || !isDeepStrictEqual(cursor.pk, storageKey.pk) || !budgetExact(cursor.sk, ["S"])
        || !/^ALERT#[a-f0-9]{64}$/.test(cursor.sk.S))) budgetFail("INVALID_REQUEST");
      const response = await dynamo.send(new QueryCommand({
        TableName: tableName, ConsistentRead: true, Limit: 10,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": storageKey.pk, ":prefix": S("ALERT#") },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }), options);
      if (!Array.isArray(response?.Items) || response.Items.length > 10) budgetFail();
      const alerts = response.Items.map(stored => {
        if (typeof stored.sk?.S !== "string" || !/^ALERT#[a-f0-9]{64}$/.test(stored.sk.S)) budgetFail();
        const alert = parse(stored, { pk: storageKey.pk, sk: stored.sk }, validAlert, record => record.revision);
        if (alert.domainId !== scope.domainId || alert.projectId !== scope.projectId
          || !isDeepStrictEqual(alertKey(alert), { pk: stored.pk, sk: stored.sk })) budgetFail();
        return alert;
      });
      const next = response.LastEvaluatedKey;
      if (next !== undefined && (!budgetExact(next, ["pk", "sk"]) || !isDeepStrictEqual(next.pk, storageKey.pk)
        || !budgetExact(next.sk, ["S"]) || !/^ALERT#[a-f0-9]{64}$/.test(next.sk.S))) budgetFail();
      return { items: alerts, cursor: next ?? null };
    },
    async saveAlert(previous, next, requireCurrentVersion = false, options) {
      if (!validAlert(previous) || !validAlert(next) || next.revision !== previous.revision + 1
        || next.id !== previous.id || next.domainId !== previous.domainId || next.projectId !== previous.projectId
        || next.configVersion !== previous.configVersion || next.destination !== previous.destination
        || !isDeepStrictEqual(next.evaluation, previous.evaluation) || next.createdAt !== previous.createdAt) budgetFail();
      const put = { TableName: tableName, Item: item(alertKey(next), next, next.revision),
        ConditionExpression: "#revision = :version", ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":version": { N: String(previous.revision) } } };
      try {
        await dynamo.send(requireCurrentVersion
          ? new TransactWriteItemsCommand({ TransactItems: [currentVersion(next, next.configVersion), { Put: put }] })
          : new PutItemCommand(put), options);
        return next;
      } catch (error) {
        if (!conditional(error)) throw error;
        return null;
      }
    },
  });
}
