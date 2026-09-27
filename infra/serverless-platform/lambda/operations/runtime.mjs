import { createHash } from "node:crypto";

const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const MAX_DOMAIN_SCOPES = 100;
const MAX_PROJECT_SCOPES = 500;
const MAX_PAGE_SIZE = 50;
const MIN_TIMEOUT_MS = 20;
const MAX_TIMEOUT_MS = 10_000;
const MIN_WINDOW_MS = 60_000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const CONFIGURATION_KEYS = new Set([
  "client",
  "GetMetricDataCommand",
  "namespace",
  "timeoutMs",
]);
const REQUEST_KEYS = new Set([
  "scope",
  "startTime",
  "endTime",
  "limit",
  "cursor",
  "abortSignal",
]);
const SCOPE_KEYS = new Set(["type", "domainIds", "projectIds"]);
const RESPONSE_KEYS = new Set([
  "$metadata",
  "MetricDataResults",
  "Messages",
  "NextToken",
]);
const METADATA_KEYS = new Set([
  "httpStatusCode",
  "requestId",
  "extendedRequestId",
  "cfId",
  "attempts",
  "totalRetryDelay",
]);
const RESULT_KEYS = new Set([
  "Id",
  "Label",
  "Timestamps",
  "Values",
  "StatusCode",
  "Messages",
]);
const CURSOR_KEYS = new Set(["v", "offset", "binding"]);

const METRICS = Object.freeze([
  Object.freeze({
    key: "runtimeCount",
    name: "RuntimeCount",
    stat: "Maximum",
    integer: true,
  }),
  Object.freeze({
    key: "healthyRuntimeCount",
    name: "HealthyRuntimeCount",
    stat: "Maximum",
    integer: true,
  }),
  Object.freeze({
    key: "invocationCount",
    name: "InvocationCount",
    stat: "Sum",
    integer: true,
  }),
  Object.freeze({
    key: "errorCount",
    name: "ErrorCount",
    stat: "Sum",
    integer: true,
  }),
  Object.freeze({
    key: "averageLatencyMs",
    name: "Latency",
    stat: "Average",
    integer: false,
  }),
  Object.freeze({
    key: "p95LatencyMs",
    name: "Latency",
    stat: "p95",
    integer: false,
  }),
  Object.freeze({
    key: "inputTokens",
    name: "InputTokens",
    stat: "Sum",
    integer: true,
  }),
  Object.freeze({
    key: "outputTokens",
    name: "OutputTokens",
    stat: "Sum",
    integer: true,
  }),
]);

const ERRORS = Object.freeze({
  INVALID_REQUEST: "The CloudWatch operations request is invalid.",
  CLOUDWATCH_TIMEOUT: "CloudWatch metrics are temporarily unavailable.",
  CLOUDWATCH_UNAVAILABLE: "CloudWatch metrics are temporarily unavailable.",
});

export class CloudWatchRuntimeProviderError extends Error {
  constructor(code) {
    if (!Object.hasOwn(ERRORS, code)) {
      throw new TypeError("CloudWatch provider error code is invalid.");
    }
    super(ERRORS[code]);
    this.name = "CloudWatchRuntimeProviderError";
    this.code = code;
  }
}

function fail(code) {
  throw new CloudWatchRuntimeProviderError(code);
}

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

function hasOnlyKeys(value, allowed) {
  return (
    isPlainObject(value)
    && Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.has(key),
    )
  );
}

function ownData(value, key, required = true, errorCode = "INVALID_REQUEST") {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) fail(errorCode);
    return { present: false, value: undefined };
  }
  if (!Object.hasOwn(descriptor, "value")) fail(errorCode);
  return { present: true, value: descriptor.value };
}

function snapshotArray(value, maximum, errorCode = "INVALID_REQUEST") {
  if (!Array.isArray(value)) fail(errorCode);
  const length = ownData(value, "length", true, errorCode).value;
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || length > maximum
  ) {
    fail(errorCode);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    result.push(ownData(value, String(index), true, errorCode).value);
  }
  return result;
}

function validDomainId(value) {
  return (
    typeof value === "string"
    && value.length <= 64
    && DOMAIN_ID_PATTERN.test(value)
  );
}

function parseProjectRef(value) {
  if (typeof value !== "string" || value.length > 129) return null;
  const slash = value.indexOf("/");
  if (slash < 1 || value.indexOf("/", slash + 1) !== -1) return null;
  const domainId = value.slice(0, slash);
  const projectId = value.slice(slash + 1);
  if (
    !validDomainId(domainId)
    || !PROJECT_ID_PATTERN.test(projectId)
  ) {
    return null;
  }
  return Object.freeze({ domainId, projectId });
}

function validAbortSignal(value) {
  return (
    value === undefined
    || (
      value !== null
      && typeof value === "object"
      && typeof value.aborted === "boolean"
      && typeof value.addEventListener === "function"
      && typeof value.removeEventListener === "function"
    )
  );
}

function validateScope(value, multiDomainProjects) {
  if (
    !hasOnlyKeys(value, SCOPE_KEYS)
    || Reflect.ownKeys(value).length !== SCOPE_KEYS.size
  ) {
    fail("INVALID_REQUEST");
  }
  const type = ownData(value, "type").value;
  const domainIds = snapshotArray(
    ownData(value, "domainIds").value,
    MAX_DOMAIN_SCOPES,
  );
  const projectIds = snapshotArray(
    ownData(value, "projectIds").value,
    MAX_PROJECT_SCOPES,
  );
  if (
    !["platform", "domain", "projects"].includes(type)
    || domainIds.some((domainId) => !validDomainId(domainId))
    || new Set(domainIds).size !== domainIds.length
    || new Set(projectIds).size !== projectIds.length
  ) {
    fail("INVALID_REQUEST");
  }
  const projects = projectIds.map((projectRef) => {
    const parsed = parseProjectRef(projectRef);
    if (
      parsed === null
      || !domainIds.includes(parsed.domainId)
    ) {
      fail("INVALID_REQUEST");
    }
    return parsed;
  });
  if (
    (type === "domain" || (type === "projects" && !multiDomainProjects))
    && domainIds.length !== 1
  ) {
    fail("INVALID_REQUEST");
  }
  return Object.freeze({
    type,
    domainIds: Object.freeze(domainIds),
    projectIds: Object.freeze(projectIds),
    projects: Object.freeze(projects),
  });
}

function validateInstant(value) {
  if (
    typeof value !== "string"
    || !ISO_INSTANT.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("INVALID_REQUEST");
  }
  return value;
}

function validateRequest(value, { multiDomainProjects = false } = {}) {
  if (
    !hasOnlyKeys(value, REQUEST_KEYS)
    || !Object.hasOwn(value, "scope")
    || !Object.hasOwn(value, "startTime")
    || !Object.hasOwn(value, "endTime")
    || !Object.hasOwn(value, "limit")
  ) {
    fail("INVALID_REQUEST");
  }
  const scope = validateScope(ownData(value, "scope").value, multiDomainProjects);
  const startTime = validateInstant(ownData(value, "startTime").value);
  const endTime = validateInstant(ownData(value, "endTime").value);
  const limit = ownData(value, "limit").value;
  const cursorProperty = ownData(value, "cursor", false);
  const signalProperty = ownData(value, "abortSignal", false);
  const duration = Date.parse(endTime) - Date.parse(startTime);
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_PAGE_SIZE
    || !Number.isSafeInteger(duration)
    || duration < MIN_WINDOW_MS
    || duration > MAX_WINDOW_MS
    || duration % 60_000 !== 0
    || (
      cursorProperty.present
      && (
        typeof cursorProperty.value !== "string"
        || !CURSOR_PATTERN.test(cursorProperty.value)
      )
    )
    || !validAbortSignal(signalProperty.value)
  ) {
    fail("INVALID_REQUEST");
  }
  return Object.freeze({
    scope,
    startTime,
    endTime,
    duration,
    limit,
    cursor: cursorProperty.value,
    abortSignal: signalProperty.value,
  });
}

function scopeDescriptors(scope) {
  if (scope.type === "platform") {
    return [Object.freeze({
      scopeType: "platform",
      domainId: null,
      projectId: null,
    })];
  }
  if (scope.type === "domain") {
    return [Object.freeze({
      scopeType: "domain",
      domainId: scope.domainIds[0],
      projectId: null,
    })];
  }
  return scope.projects.map(({ domainId, projectId }) =>
    Object.freeze({
      scopeType: "project",
      domainId,
      projectId,
    }));
}

function cursorBinding(request, descriptors, namespace) {
  return createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      namespace,
      startTime: request.startTime,
      endTime: request.endTime,
      limit: request.limit,
      scopes: descriptors,
    }))
    .digest("hex");
}

function encodeCursor(offset, binding) {
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    offset,
    binding,
  })).toString("base64url");
  if (!CURSOR_PATTERN.test(encoded)) fail("CLOUDWATCH_UNAVAILABLE");
  return encoded;
}

function decodeCursor(value, binding, descriptorCount) {
  if (value === undefined) return 0;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) {
      fail("INVALID_REQUEST");
    }
    const parsed = JSON.parse(decoded.toString("utf8"));
    if (
      !hasOnlyKeys(parsed, CURSOR_KEYS)
      || Reflect.ownKeys(parsed).length !== CURSOR_KEYS.size
    ) {
      fail("INVALID_REQUEST");
    }
    const version = ownData(parsed, "v").value;
    const offset = ownData(parsed, "offset").value;
    const parsedBinding = ownData(parsed, "binding").value;
    if (
      version !== 1
      || !Number.isSafeInteger(offset)
      || offset < 1
      || offset >= descriptorCount
      || parsedBinding !== binding
    ) {
      fail("INVALID_REQUEST");
    }
    return offset;
  } catch (error) {
    if (error instanceof CloudWatchRuntimeProviderError) throw error;
    fail("INVALID_REQUEST");
  }
}

function metricDimensions(descriptor) {
  const dimensions = [
    { Name: "ScopeType", Value: descriptor.scopeType },
  ];
  if (descriptor.domainId !== null) {
    dimensions.push({ Name: "DomainId", Value: descriptor.domainId });
  }
  if (descriptor.projectId !== null) {
    dimensions.push({ Name: "ProjectId", Value: descriptor.projectId });
  }
  return dimensions;
}

function metricLabel(descriptor, metric) {
  const scope = descriptor.projectId === null
    ? descriptor.domainId ?? "platform"
    : `${descriptor.domainId}/${descriptor.projectId}`;
  return `${scope}|${metric.name}|${metric.stat}`;
}

function metricQueries(descriptors, namespace, periodSeconds) {
  return descriptors.flatMap((descriptor, scopeIndex) =>
    METRICS.map((metric, metricIndex) => ({
      Id: `s${scopeIndex}m${metricIndex}`,
      Label: metricLabel(descriptor, metric),
      MetricStat: {
        Metric: {
          Namespace: namespace,
          MetricName: metric.name,
          Dimensions: metricDimensions(descriptor),
        },
        Period: periodSeconds,
        Stat: metric.stat,
      },
      ReturnData: true,
    })));
}

function abortError() {
  const error = new Error("CloudWatch metrics request was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

async function sendWithDeadline({
  client,
  command,
  abortSignal,
  timeoutMs,
}) {
  throwIfAborted(abortSignal);
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let rejectCancellation;
  const cancellation = new Promise((resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (error) => {
    controller.abort();
    rejectCancellation(error);
  };
  const onCallerAbort = () => {
    callerAborted = true;
    cancel(abortError());
  };
  abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    cancel(new CloudWatchRuntimeProviderError("CLOUDWATCH_TIMEOUT"));
  }, timeoutMs);
  const request = Promise.resolve().then(() =>
    client.send(command, { abortSignal: controller.signal }));
  try {
    return await Promise.race([request, cancellation]);
  } catch (error) {
    if (callerAborted || abortSignal?.aborted) throw abortError();
    if (timedOut) fail("CLOUDWATCH_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function validateMetadata(value) {
  if (!hasOnlyKeys(value, METADATA_KEYS)) {
    fail("CLOUDWATCH_UNAVAILABLE");
  }
  for (const key of Reflect.ownKeys(value)) {
    ownData(value, key, true, "CLOUDWATCH_UNAVAILABLE");
  }
  if (ownData(
    value,
    "httpStatusCode",
    true,
    "CLOUDWATCH_UNAVAILABLE",
  ).value !== 200) {
    fail("CLOUDWATCH_UNAVAILABLE");
  }
}

function validateEmptyMessages(value) {
  const messages = snapshotArray(
    value,
    10,
    "CLOUDWATCH_UNAVAILABLE",
  );
  if (messages.length !== 0) fail("CLOUDWATCH_UNAVAILABLE");
}

function validateMetricResult(
  value,
  expected,
  startEpoch,
  endEpoch,
) {
  if (
    !hasOnlyKeys(value, RESULT_KEYS)
    || !Object.hasOwn(value, "Id")
    || !Object.hasOwn(value, "Timestamps")
    || !Object.hasOwn(value, "Values")
    || !Object.hasOwn(value, "StatusCode")
  ) {
    fail("CLOUDWATCH_UNAVAILABLE");
  }
  const id = ownData(
    value,
    "Id",
    true,
    "CLOUDWATCH_UNAVAILABLE",
  ).value;
  const label = ownData(
    value,
    "Label",
    false,
    "CLOUDWATCH_UNAVAILABLE",
  );
  const timestamps = snapshotArray(
    ownData(
      value,
      "Timestamps",
      true,
      "CLOUDWATCH_UNAVAILABLE",
    ).value,
    1,
    "CLOUDWATCH_UNAVAILABLE",
  );
  const values = snapshotArray(
    ownData(
      value,
      "Values",
      true,
      "CLOUDWATCH_UNAVAILABLE",
    ).value,
    1,
    "CLOUDWATCH_UNAVAILABLE",
  );
  const status = ownData(
    value,
    "StatusCode",
    true,
    "CLOUDWATCH_UNAVAILABLE",
  ).value;
  const messages = ownData(
    value,
    "Messages",
    false,
    "CLOUDWATCH_UNAVAILABLE",
  );
  if (
    id !== expected.Id
    || (
      label.present
      && label.value !== expected.Label
    )
    || status !== "Complete"
    || timestamps.length !== values.length
  ) {
    fail("CLOUDWATCH_UNAVAILABLE");
  }
  if (messages.present) validateEmptyMessages(messages.value);
  if (values.length === 0) return null;
  const timestamp = timestamps[0];
  const timestampEpoch = timestamp instanceof Date
    ? timestamp.getTime()
    : Number.NaN;
  const metricValue = values[0];
  if (
    !Number.isFinite(timestampEpoch)
    || timestampEpoch < startEpoch
    || timestampEpoch >= endEpoch
    || typeof metricValue !== "number"
    || !Number.isFinite(metricValue)
    || metricValue < 0
  ) {
    fail("CLOUDWATCH_UNAVAILABLE");
  }
  return metricValue;
}

function validateResponse(response, queries, startTime, endTime) {
  if (
    !hasOnlyKeys(response, RESPONSE_KEYS)
    || !Object.hasOwn(response, "$metadata")
    || !Object.hasOwn(response, "MetricDataResults")
  ) {
    fail("CLOUDWATCH_UNAVAILABLE");
  }
  validateMetadata(
    ownData(
      response,
      "$metadata",
      true,
      "CLOUDWATCH_UNAVAILABLE",
    ).value,
  );
  const nextToken = ownData(
    response,
    "NextToken",
    false,
    "CLOUDWATCH_UNAVAILABLE",
  );
  if (nextToken.present && nextToken.value !== undefined) {
    fail("CLOUDWATCH_UNAVAILABLE");
  }
  const messages = ownData(
    response,
    "Messages",
    false,
    "CLOUDWATCH_UNAVAILABLE",
  );
  if (messages.present) validateEmptyMessages(messages.value);
  const results = snapshotArray(
    ownData(
      response,
      "MetricDataResults",
      true,
      "CLOUDWATCH_UNAVAILABLE",
    ).value,
    queries.length,
    "CLOUDWATCH_UNAVAILABLE",
  );
  if (results.length !== queries.length) fail("CLOUDWATCH_UNAVAILABLE");
  const expectedById = new Map(queries.map((query) => [query.Id, query]));
  const valuesById = new Map();
  for (const result of results) {
    if (!isPlainObject(result)) fail("CLOUDWATCH_UNAVAILABLE");
    const idProperty = Object.getOwnPropertyDescriptor(result, "Id");
    if (
      idProperty === undefined
      || !Object.hasOwn(idProperty, "value")
      || typeof idProperty.value !== "string"
      || !expectedById.has(idProperty.value)
      || valuesById.has(idProperty.value)
    ) {
      fail("CLOUDWATCH_UNAVAILABLE");
    }
    valuesById.set(
      idProperty.value,
      validateMetricResult(
        result,
        expectedById.get(idProperty.value),
        Date.parse(startTime),
        Date.parse(endTime),
      ),
    );
  }
  if (valuesById.size !== queries.length) fail("CLOUDWATCH_UNAVAILABLE");
  return valuesById;
}

function aggregatePage(descriptors, queries, valuesById) {
  return descriptors.map((descriptor, scopeIndex) => {
    const aggregate = {
      scopeType: descriptor.scopeType,
      domainId: descriptor.domainId,
      projectId: descriptor.projectId,
    };
    for (let metricIndex = 0; metricIndex < METRICS.length; metricIndex += 1) {
      const metric = METRICS[metricIndex];
      const value = valuesById.get(`s${scopeIndex}m${metricIndex}`);
      if (
        value !== null && (
        typeof value !== "number"
        || !Number.isFinite(value)
        || value < 0
        || (metric.integer && !Number.isSafeInteger(value))
        )
      ) {
        fail("CLOUDWATCH_UNAVAILABLE");
      }
      aggregate[metric.key] = value;
    }
    if (
      (aggregate.runtimeCount !== null
        && aggregate.healthyRuntimeCount > aggregate.runtimeCount)
      || (aggregate.invocationCount !== null
        && aggregate.errorCount > aggregate.invocationCount)
    ) {
      fail("CLOUDWATCH_UNAVAILABLE");
    }
    return aggregate;
  });
}

// Cost readers share the same bounded scope/window and pagination validation.
export { validateRequest as validateAggregateRequest, scopeDescriptors, encodeCursor, decodeCursor };

export function createCloudWatchRuntimeProvider(configuration) {
  if (
    !hasOnlyKeys(configuration, CONFIGURATION_KEYS)
    || !Object.hasOwn(configuration, "client")
    || !Object.hasOwn(configuration, "GetMetricDataCommand")
  ) {
    throw new TypeError("CloudWatch provider configuration is invalid.");
  }
  const client = ownData(
    configuration,
    "client",
    true,
    "CLOUDWATCH_UNAVAILABLE",
  ).value;
  const GetMetricDataCommand = ownData(
    configuration,
    "GetMetricDataCommand",
    true,
    "CLOUDWATCH_UNAVAILABLE",
  ).value;
  const namespace = ownData(
    configuration,
    "namespace",
    false,
    "CLOUDWATCH_UNAVAILABLE",
  ).value ?? "bedrock-agentcore";
  const timeoutMs = ownData(
    configuration,
    "timeoutMs",
    false,
    "CLOUDWATCH_UNAVAILABLE",
  ).value ?? 1_500;
  if (
    client === null
    || typeof client !== "object"
    || typeof client.send !== "function"
    || typeof GetMetricDataCommand !== "function"
    || typeof namespace !== "string"
    || !NAMESPACE_PATTERN.test(namespace)
    || namespace.startsWith("AWS/")
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_TIMEOUT_MS
    || timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError("CloudWatch provider configuration is invalid.");
  }

  return Object.freeze({
    async listRuntimeAggregates(input) {
      // groupBy=project fans an admin scope out across every domain, exactly
      // like the journal usage provider — accept multi-domain project scopes.
      const request = validateRequest(input, { multiDomainProjects: true });
      throwIfAborted(request.abortSignal);
      const descriptors = scopeDescriptors(request.scope);
      if (descriptors.length === 0) {
        return { items: [], cursor: null };
      }
      const binding = cursorBinding(request, descriptors, namespace);
      const offset = decodeCursor(
        request.cursor,
        binding,
        descriptors.length,
      );
      const pageDescriptors = descriptors.slice(
        offset,
        offset + request.limit,
      );
      const queries = metricQueries(
        pageDescriptors,
        namespace,
        request.duration / 1000,
      );
      const command = new GetMetricDataCommand({
        StartTime: new Date(request.startTime),
        EndTime: new Date(request.endTime),
        MetricDataQueries: queries,
        MaxDatapoints: queries.length,
        ScanBy: "TimestampDescending",
      });
      let response;
      try {
        response = await sendWithDeadline({
          client,
          command,
          abortSignal: request.abortSignal,
          timeoutMs,
        });
      } catch (error) {
        if (
          error?.name === "AbortError"
          || error instanceof CloudWatchRuntimeProviderError
        ) {
          throw error;
        }
        fail("CLOUDWATCH_UNAVAILABLE");
      }
      const valuesById = validateResponse(
        response,
        queries,
        request.startTime,
        request.endTime,
      );
      const nextOffset = offset + pageDescriptors.length;
      return {
        items: aggregatePage(pageDescriptors, queries, valuesById),
        cursor: nextOffset < descriptors.length
          ? encodeCursor(nextOffset, binding)
          : null,
      };
    },
  });
}
