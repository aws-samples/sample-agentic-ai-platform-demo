import { randomUUID } from "node:crypto";
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { budgetExact, budgetFail, budgetScope } from "./budgets.mjs";

const globalKey = { pk: { S: "PROJECT_BUDGET#RUNNER" }, sk: { S: "CHECKPOINT" } };
const cursorKey = scope => {
  budgetScope(scope.domainId, scope.projectId);
  return { pk: { S: `PROJECT_BUDGET#${scope.domainId}#${scope.projectId}` }, sk: { S: "RUNNER_CURSOR" } };
};
const validPosition = position => {
  if (!budgetExact(position, ["domainId", "projectCursor"])) return false;
  if (position.domainId === null) return position.projectCursor === null;
  try { budgetScope(position.domainId, "validation"); } catch { return false; }
  const cursor = position.projectCursor;
  return cursor === null || (budgetExact(cursor, ["pk", "sk"])
    && cursor.pk === `PROJECT#${position.domainId}` && typeof cursor.sk === "string"
    && /^PROJECT#[a-z][a-z0-9-]{0,63}$/.test(cursor.sk));
};
const validCursor = (cursor, key) => cursor === null || (budgetExact(cursor, ["pk", "sk"])
  && budgetExact(cursor.pk, ["S"]) && cursor.pk.S === key.pk.S
  && budgetExact(cursor.sk, ["S"]) && /^ALERT#[a-f0-9]{64}$/.test(cursor.sk.S));

// No workspace entities, indexes, TTL or recipient data in these records.
export function createBudgetRunnerState({ tableName, dynamo, clock = Date.now } = {}) {
  if (typeof tableName !== "string" || !tableName.trim() || typeof dynamo?.send !== "function") throw new TypeError("Invalid runner storage.");
  const validate = (record, key) => {
    if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1) return false;
    return key === globalKey
      ? budgetExact(record, ["revision", "leaseToken", "leaseUntil", "position"])
        && /^[a-f0-9-]{36}$/.test(record.leaseToken) && Number.isSafeInteger(record.leaseUntil)
        && record.leaseUntil >= 0 && validPosition(record.position)
      : budgetExact(record, ["revision", "cursor"]) && validCursor(record.cursor, key);
  };
  async function read(key) {
    const result = await dynamo.send(new GetItemCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    if (!result || typeof result !== "object") budgetFail();
    if (result.Item === undefined) return null;
    const item = result.Item;
    if (!budgetExact(item, ["pk", "sk", "revision", "record"])
      || !budgetExact(item.pk, ["S"]) || item.pk.S !== key.pk.S
      || !budgetExact(item.sk, ["S"]) || item.sk.S !== key.sk.S
      || !budgetExact(item.record, ["S"]) || typeof item.record.S !== "string" || item.record.S.length > 4096
      || !budgetExact(item.revision, ["N"])) budgetFail();
    let record;
    try { record = JSON.parse(item.record.S); } catch { budgetFail(); }
    if (!validate(record, key) || item.revision.N !== String(record.revision)) budgetFail();
    return record;
  }
  async function put(key, previous, record) {
    if (!validate(record, key) || record.revision !== (previous?.revision ?? 0) + 1) budgetFail();
    try {
      await dynamo.send(new PutItemCommand({
        TableName: tableName,
        Item: { ...key, revision: { N: String(record.revision) }, record: { S: JSON.stringify(record) } },
        ConditionExpression: previous ? "#revision = :version" : "attribute_not_exists(pk)",
        ...(previous ? { ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":version": { N: String(previous.revision) } } } : {}),
      }));
      return record;
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException") return null;
      throw error;
    }
  }
  return Object.freeze({
    async claim() {
      const previous = await read(globalKey);
      const now = clock();
      if (previous && previous.leaseUntil > now) return null;
      return put(globalKey, previous, { revision: (previous?.revision ?? 0) + 1,
        leaseToken: randomUUID(), leaseUntil: now + 60_000,
        position: previous?.position ?? { domainId: null, projectCursor: null } });
    },
    async advance(previous, position, release = false) {
      if (previous.leaseUntil <= clock()) budgetFail("CONFLICT");
      return put(globalKey, previous, { ...previous, revision: previous.revision + 1,
        position, ...(release ? { leaseUntil: 0 } : {}) });
    },
    getCursor(scope) { return read(cursorKey(scope)); },
    saveCursor(scope, previous, cursor) {
      return put(cursorKey(scope), previous, { revision: (previous?.revision ?? 0) + 1, cursor });
    },
  });
}
