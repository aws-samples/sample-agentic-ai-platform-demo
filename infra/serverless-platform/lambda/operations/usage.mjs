const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/;
const MAX_BUDGETS = 500;
const AGGREGATE_KEYS = new Set([
  "scopeType",
  "domainId",
  "projectId",
  "runtimeCount",
  "healthyRuntimeCount",
  "invocationCount",
  "errorCount",
  "averageLatencyMs",
  "p95LatencyMs",
  "inputTokens",
  "outputTokens",
]);

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

function exactRecord(value, keys) {
  if (!isPlainObject(value)) return null;
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.size
    || actual.some(
      (key) => typeof key !== "string" || !keys.has(key),
    )
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

function nonNegativeNumber(value) {
  return (
    typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
  );
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function scopeKey(value) {
  if (value === "platform") {
    return {
      scopeType: "platform",
      domainId: null,
      projectId: null,
    };
  }
  if (typeof value !== "string") return null;
  const domain = /^domain:(.+)$/.exec(value);
  if (domain && DOMAIN_ID_PATTERN.test(domain[1])) {
    return {
      scopeType: "domain",
      domainId: domain[1],
      projectId: null,
    };
  }
  const project = /^project:([^/]+)\/([^/]+)$/.exec(value);
  if (
    project
    && DOMAIN_ID_PATTERN.test(project[1])
    && PROJECT_ID_PATTERN.test(project[2])
  ) {
    return {
      scopeType: "project",
      domainId: project[1],
      projectId: project[2],
    };
  }
  return null;
}

function normalizeBudgets(value) {
  if (!isPlainObject(value)) {
    throw new TypeError("Usage provider configuration is invalid.");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_BUDGETS
    || keys.some((key) => typeof key !== "string")
  ) {
    throw new TypeError("Usage provider configuration is invalid.");
  }
  const result = new Map();
  for (const key of keys) {
    const parsed = scopeKey(key);
    const property = ownDataValue(value, key);
    if (
      parsed === null
      || !property.present
      || !nonNegativeNumber(property.value)
    ) {
      throw new TypeError("Usage provider configuration is invalid.");
    }
    result.set(key, Object.freeze({
      ...parsed,
      monthlyLimitUsd: property.value,
      currency: "USD",
    }));
  }
  return result;
}

export function createBudgetReader(budgets = {}) {
  const configured = normalizeBudgets(budgets);
  return async input => {
    const keys = new Set(["scopeKeys", "scope", "abortSignal"]);
    if (!isPlainObject(input) || Reflect.ownKeys(input).some(key => !keys.has(key))) {
      throw new Error("Budget scope is invalid.");
    }
    const scopeKeys = ownDataValue(input, "scopeKeys").value;
    if (!Array.isArray(scopeKeys) || scopeKeys.length > MAX_BUDGETS
      || new Set(scopeKeys).size !== scopeKeys.length || scopeKeys.some(key => scopeKey(key) === null)) {
      throw new Error("Budget scope is invalid.");
    }
    return scopeKeys.filter(key => configured.has(key)).map(key => ({ ...configured.get(key) }));
  };
}

function validateAggregate(value) {
  const record = exactRecord(value, AGGREGATE_KEYS);
  if (
    record === null
    || !["platform", "domain", "project"].includes(record.scopeType)
    || (
      record.scopeType === "platform"
      && (record.domainId !== null || record.projectId !== null)
    )
    || (
      record.scopeType === "domain"
      && (
        !DOMAIN_ID_PATTERN.test(record.domainId)
        || record.projectId !== null
      )
    )
    || (
      record.scopeType === "project"
      && (
        !DOMAIN_ID_PATTERN.test(record.domainId)
        || !PROJECT_ID_PATTERN.test(record.projectId)
      )
    )
    || !["runtimeCount", "healthyRuntimeCount", "invocationCount",
      "errorCount", "inputTokens", "outputTokens"].every(
      (key) => record[key] === null || nonNegativeInteger(record[key]),
    )
    || (record.runtimeCount !== null
      && record.healthyRuntimeCount > record.runtimeCount)
    || (record.invocationCount !== null
      && record.errorCount > record.invocationCount)
    || !["averageLatencyMs", "p95LatencyMs"].every(
      (key) => record[key] === null || nonNegativeNumber(record[key]),
    )
  ) {
    throw new Error("CloudWatch usage metrics are invalid.");
  }
  return record;
}

function validatePage(value) {
  const page = exactRecord(value, new Set(["items", "cursor"]));
  if (
    page === null
    || !Array.isArray(page.items)
    || page.items.length > 50
    || (
      page.cursor !== null
      && (
        typeof page.cursor !== "string"
        || !CURSOR_PATTERN.test(page.cursor)
      )
    )
  ) {
    throw new Error("CloudWatch usage metrics are invalid.");
  }
  return {
    items: page.items.map(validateAggregate),
    cursor: page.cursor,
  };
}

export function createCloudWatchUsageProvider({
  runtimeProvider,
  pricing,
  budgets,
} = {}) {
  const inputPrice = ownDataValue(
    pricing,
    "inputUsdPerMillionTokens",
  );
  const outputPrice = ownDataValue(
    pricing,
    "outputUsdPerMillionTokens",
  );
  if (
    !runtimeProvider
    || typeof runtimeProvider.listRuntimeAggregates !== "function"
    || !isPlainObject(pricing)
    || Reflect.ownKeys(pricing).length !== 2
    || !inputPrice.present
    || !nonNegativeNumber(inputPrice.value)
    || !outputPrice.present
    || !nonNegativeNumber(outputPrice.value)
  ) {
    throw new TypeError("Usage provider configuration is invalid.");
  }
  const listBudgets = createBudgetReader(budgets);
  return Object.freeze({
    async listInvocationUsageAggregates(input) {
      const page = validatePage(
        await runtimeProvider.listRuntimeAggregates(input),
      );
      return {
        items: page.items.map((record) => ({
          scopeType: record.scopeType,
          domainId: record.domainId,
          projectId: record.projectId,
          invocationCount: record.invocationCount,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          // These dimensions contain neither model/cache identity nor a
          // versioned rate. A generic rate would fabricate a dollar amount.
          estimatedCostUsd: null,
        })),
        cursor: page.cursor,
      };
    },
    listBudgets,
  });
}
