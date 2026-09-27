import https from "node:https";

const EXPECTED_ALARM_OWNERSHIP = new Map([
  ["managedBy", "cdk"],
  ["project", "agentic-ai-platform-demo"],
]);
const EXPECTED_ALARM_REQUIRED_TAGS = new Map([
  ["auto-delete", "no"],
  ...EXPECTED_ALARM_OWNERSHIP,
]);
const RUNTIME_BOUNDARY_NAME =
  "AgenticPlatform-Web-RuntimePermissionsBoundary";
const EXPECTED_RUNTIME_BOUNDARY_TAGS = new Map([
  ["auto-delete", "no"],
  ["managedBy", "cdk"],
  ["project", "agentic-ai-platform-demo"],
]);
const ALARM_REQUEST_MARKER_KEY = "cloudFormationRequestId";
const MAX_ALARM_REQUEST_ID_LENGTH = 256;
const ALARM_REQUEST_ID_PATTERN = /^[A-Za-z0-9 _.:/=+\-@]+$/;
const INVALIDATION_STATUSES = new Set(["InProgress", "Completed"]);
const DEFAULT_INVALIDATION_POLL_INTERVAL_MS = 5_000;
const DEFAULT_INVALIDATION_MAX_ATTEMPTS = 100;
const DEFAULT_INVALIDATION_RESPONSE_RESERVE_MS = 45_000;
const DEFAULT_INVALIDATION_SDK_ATTEMPT_DURATION_MS = 20_000;
const MINIMUM_INVALIDATION_RESPONSE_RESERVE_MS = 30_000;
const DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_SUCCESS_RESPONSE_ATTEMPTS = 3;
const DEFAULT_RESPONSE_RETRY_DELAY_MS = 250;
const OPERATION_FAILED_REASON = "Custom resource operation failed.";
const RESPONSE_DELIVERY_FAILED_REASON =
  "Custom resource response delivery failed.";

function requiredProperty(event, name) {
  const value = event.ResourceProperties?.[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required resource property: ${name}`);
  }
  return value;
}

function parseTags(value, propertyName) {
  if (!Array.isArray(value)) {
    throw new Error(`${propertyName} must be an array of tags.`);
  }

  const tags = new Map();
  for (const tag of value) {
    if (
      !tag
      || typeof tag !== "object"
      || Array.isArray(tag)
      || typeof tag.Key !== "string"
      || tag.Key.length === 0
      || typeof tag.Value !== "string"
    ) {
      throw new Error(`${propertyName} contains a malformed tag.`);
    }
    if (tags.has(tag.Key)) {
      throw new Error(`${propertyName} contains duplicate tag keys.`);
    }
    tags.set(tag.Key, tag.Value);
  }
  return tags;
}

function verifyExactTags(actual, expected, propertyName) {
  if (actual.size !== expected.size) {
    throw new Error(`${propertyName} must contain the exact expected tags.`);
  }
  for (const [key, value] of expected) {
    if (actual.get(key) !== value) {
      throw new Error(
        `${propertyName} must contain the expected ${key} tag.`,
      );
    }
  }
}

function alarmTagConfiguration(event) {
  const ownershipTags = requiredProperty(event, "OwnershipTags");
  const requiredTags = requiredProperty(event, "RequiredTags");
  const ownership = parseTags(ownershipTags, "OwnershipTags");
  const required = parseTags(requiredTags, "RequiredTags");

  verifyExactTags(
    ownership,
    EXPECTED_ALARM_OWNERSHIP,
    "OwnershipTags",
  );
  verifyExactTags(
    required,
    EXPECTED_ALARM_REQUIRED_TAGS,
    "RequiredTags",
  );

  return { ownership, required, requiredTags };
}

function isAlarmNotFound(error) {
  return Boolean(
    error
    && typeof error === "object"
    && error.name === "ResourceNotFoundException",
  );
}

async function lookupAlarmTags(cloudWatch, alarmArn) {
  try {
    return {
      exists: true,
      response: await cloudWatch.listTagsForResource({
        ResourceARN: alarmArn,
      }),
    };
  } catch (error) {
    if (isAlarmNotFound(error)) {
      return { exists: false };
    }
    throw error;
  }
}

function verifyAlarmOwnership(response, ownership) {
  if (!response || typeof response !== "object") {
    throw new Error("Alarm tag lookup returned a malformed response.");
  }
  const current = parseTags(response.Tags, "Alarm tags");
  for (const [key, value] of ownership) {
    if (current.get(key) !== value) {
      throw new Error("Alarm ownership could not be verified.");
    }
  }
  return current;
}

function alarmRequestMarker(event) {
  const requestId = event.RequestId;
  if (
    typeof requestId !== "string"
    || requestId.length === 0
    || requestId.length > MAX_ALARM_REQUEST_ID_LENGTH
    || requestId.trim().length === 0
    || !ALARM_REQUEST_ID_PATTERN.test(requestId)
  ) {
    throw new Error(
      "CloudFormation request ID must be a bounded tag-safe string.",
    );
  }
  return { Key: ALARM_REQUEST_MARKER_KEY, Value: requestId };
}

function verifyMatchingAlarmRequest(current, requestId, alarmName) {
  const marker = current.get(ALARM_REQUEST_MARKER_KEY);
  if (
    typeof marker !== "string"
    || marker.length === 0
    || marker.length > MAX_ALARM_REQUEST_ID_LENGTH
    || marker.trim().length === 0
    || !ALARM_REQUEST_ID_PATTERN.test(marker)
  ) {
    if (marker === undefined) {
      throw new Error(`CloudWatch alarm ${alarmName} already exists.`);
    }
    throw new Error("CloudWatch alarm request marker is malformed.");
  }
  if (marker !== requestId) {
    throw new Error(`CloudWatch alarm ${alarmName} already exists.`);
  }
}

function alarmIdentity(properties, propertyName) {
  const propertyLabel = propertyName === "OldResourceProperties"
    ? "Old resource properties"
    : "Resource properties";
  if (
    !properties
    || typeof properties !== "object"
    || Array.isArray(properties)
  ) {
    throw new Error(`${propertyLabel} must be an object.`);
  }
  const alarmName = properties.AlarmName;
  const alarmArn = properties.AlarmArn;
  if (typeof alarmName !== "string" || alarmName.length === 0) {
    throw new Error(`${propertyLabel} AlarmName must be a non-empty string.`);
  }
  if (typeof alarmArn !== "string" || alarmArn.length === 0) {
    throw new Error(`${propertyLabel} Alarm ARN must be a non-empty string.`);
  }
  const suffix = `:alarm:${alarmName}`;
  const arnPrefix = alarmArn.slice(0, -suffix.length);
  if (
    !alarmArn.endsWith(suffix)
    || !/^arn:[a-z0-9-]+:cloudwatch:us-east-1:[0-9]{12}$/.test(arnPrefix)
  ) {
    throw new Error(
      `${propertyLabel} Alarm ARN must exactly identify its AlarmName.`,
    );
  }
  return { alarmArn, alarmName, arnPrefix };
}

function requiredPhysicalResourceId(event) {
  const physicalResourceId = event.PhysicalResourceId;
  if (
    typeof physicalResourceId !== "string"
    || physicalResourceId.length === 0
  ) {
    throw new Error("Physical resource ID must be a non-empty string.");
  }
  return physicalResourceId;
}

function managedPolicyTagConfiguration(
  properties,
  expectedPolicyName,
  propertyLabel = "Resource properties",
) {
  if (
    !properties
    || typeof properties !== "object"
    || Array.isArray(properties)
  ) {
    throw new Error(`${propertyLabel} must be an object.`);
  }
  const property = (name) => {
    const value = properties[name];
    if (value === undefined || value === null || value === "") {
    throw new Error(`${propertyLabel} is missing ${name}.`);
    }
    return value;
  };
  if (
    typeof expectedPolicyName !== "string"
    || !/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(expectedPolicyName)
  ) {
    throw new Error("Expected managed-policy name is malformed.");
  }
  const accountId = property("AccountId");
  const partition = property("Partition");
  const policyArn = property("PolicyArn");
  const requiredTags = property("RequiredTags");
  if (
    typeof accountId !== "string"
    || !/^[0-9]{12}$/.test(accountId)
    || typeof partition !== "string"
    || !/^[a-z0-9-]+$/.test(partition)
  ) {
    throw new Error(
      `${propertyLabel} runtime boundary account or partition is malformed.`,
    );
  }
  const expectedPolicyArn =
    `arn:${partition}:iam::${accountId}:policy/${expectedPolicyName}`;
  if (policyArn !== expectedPolicyArn) {
    throw new Error(
      `${propertyLabel} policy ARN must identify the exact root policy.`,
    );
  }
  const required = parseTags(
    requiredTags,
    "Runtime boundary RequiredTags",
  );
  verifyExactTags(
    required,
    EXPECTED_RUNTIME_BOUNDARY_TAGS,
    "Runtime boundary RequiredTags",
  );
  return { policyArn, required, requiredTags };
}

function runtimeBoundaryTagConfiguration(
  properties,
  propertyLabel = "Resource properties",
) {
  return managedPolicyTagConfiguration(
    properties,
    RUNTIME_BOUNDARY_NAME,
    propertyLabel,
  );
}

export async function reconcileManagedPolicyTags(
  event,
  iam,
  expectedPolicyName,
  policyLabel = "managed policy",
) {
  if (
    event.RequestType !== "Create"
    && event.RequestType !== "Update"
    && event.RequestType !== "Delete"
  ) {
    throw new Error(`Unsupported request type: ${event.RequestType}`);
  }
  const { policyArn, required, requiredTags } =
    managedPolicyTagConfiguration(
      event.ResourceProperties,
      expectedPolicyName,
    );
  if (event.RequestType === "Create") {
    if (event.PhysicalResourceId !== undefined) {
      throw new Error("Create must not include a Physical resource ID.");
    }
  } else {
    const physicalResourceId = requiredPhysicalResourceId(event);
    if (physicalResourceId !== policyArn) {
      throw new Error(
        `Physical resource ID must match the exact ${policyLabel} policy ARN.`,
      );
    }
    if (event.RequestType === "Delete") {
      return { PhysicalResourceId: policyArn };
    }
    const oldConfiguration = managedPolicyTagConfiguration(
      event.OldResourceProperties,
      expectedPolicyName,
      "Old resource properties",
    );
    if (oldConfiguration.policyArn !== policyArn) {
      throw new Error(
        `Old resource properties must match the current ${policyLabel}.`,
      );
    }
  }

  const response = await iam.listPolicyTags({ PolicyArn: policyArn });
  if (
    !response
    || typeof response !== "object"
    || Array.isArray(response)
    || (
      response.IsTruncated !== undefined
      && typeof response.IsTruncated !== "boolean"
    )
  ) {
    throw new Error(
      "Runtime boundary policy tag lookup returned a malformed response.",
    );
  }
  if (response.IsTruncated === true || response.Marker !== undefined) {
    throw new Error(
      "Runtime boundary policy tag lookup pagination is not supported.",
    );
  }
  const current = parseTags(
    response.Tags,
    "Runtime boundary policy tags",
  );
  const driftedKeys = [...current.keys()]
    .filter((key) => !required.has(key));
  const requiredDrift = requiredTags.filter(
    ({ Key, Value }) => current.get(Key) !== Value,
  );

  if (driftedKeys.length > 0) {
    await iam.untagPolicy({
      PolicyArn: policyArn,
      TagKeys: driftedKeys,
    });
  }
  if (requiredDrift.length > 0) {
    await iam.tagPolicy({
      PolicyArn: policyArn,
      Tags: requiredDrift,
    });
  }
  return { PhysicalResourceId: policyArn };
}

export async function reconcileRuntimeBoundaryTags(event, iam) {
  return reconcileManagedPolicyTags(
    event,
    iam,
    RUNTIME_BOUNDARY_NAME,
    "runtime boundary",
  );
}

export async function reconcileCloudFrontAlarm(event, cloudWatch) {
  if (
    event.RequestType !== "Create"
    && event.RequestType !== "Update"
    && event.RequestType !== "Delete"
  ) {
    throw new Error(`Unsupported request type: ${event.RequestType}`);
  }

  const {
    alarmName,
    alarmArn,
    arnPrefix,
  } = alarmIdentity(event.ResourceProperties, "ResourceProperties");
  const { ownership, required, requiredTags } =
    alarmTagConfiguration(event);
  let current = new Map();
  let createWithTags = false;
  let createTags;

  if (event.RequestType === "Create") {
    if (event.PhysicalResourceId !== undefined) {
      throw new Error(
        "Create must not include a Physical resource ID.",
      );
    }
    const requestMarker = alarmRequestMarker(event);
    const lookup = await lookupAlarmTags(cloudWatch, alarmArn);
    if (lookup.exists) {
      const existing = verifyAlarmOwnership(lookup.response, ownership);
      verifyMatchingAlarmRequest(
        existing,
        requestMarker.Value,
        alarmName,
      );
      return { PhysicalResourceId: alarmName };
    }
    createWithTags = true;
    createTags = [...requiredTags, requestMarker];
  } else if (event.RequestType === "Delete") {
    const physicalResourceId = requiredPhysicalResourceId(event);
    if (physicalResourceId !== alarmName) {
      throw new Error(
        "Physical resource ID must match the Delete event AlarmName.",
      );
    }
    const lookup = await lookupAlarmTags(cloudWatch, alarmArn);
    if (!lookup.exists) {
      return { PhysicalResourceId: alarmName };
    }
    verifyAlarmOwnership(lookup.response, ownership);
    await cloudWatch.deleteAlarms({ AlarmNames: [alarmName] });
    return { PhysicalResourceId: alarmName };
  } else {
    const physicalResourceId = requiredPhysicalResourceId(event);
    const oldIdentity = alarmIdentity(
      event.OldResourceProperties,
      "OldResourceProperties",
    );
    if (oldIdentity.arnPrefix !== arnPrefix) {
      throw new Error(
        "Old resource properties Alarm ARN must share the current alarm ARN scope.",
      );
    }

    if (physicalResourceId === alarmName) {
      if (
        oldIdentity.alarmName !== alarmName
        || oldIdentity.alarmArn !== alarmArn
      ) {
        throw new Error(
          "Old resource properties must match an in-place alarm update.",
        );
      }
      const lookup = await lookupAlarmTags(cloudWatch, alarmArn);
      if (!lookup.exists) {
        throw new Error(`CloudWatch alarm ${alarmName} does not exist.`);
      }
      current = verifyAlarmOwnership(lookup.response, ownership);
    } else {
      if (physicalResourceId !== oldIdentity.alarmName) {
        throw new Error(
          "Physical resource ID must match old resource properties AlarmName.",
        );
      }
      if (oldIdentity.alarmName === alarmName) {
        throw new Error(
          "Replacement Update requires different old and new alarm names.",
        );
      }
      const requestMarker = alarmRequestMarker(event);
      const lookup = await lookupAlarmTags(cloudWatch, alarmArn);
      if (lookup.exists) {
        const existing = verifyAlarmOwnership(lookup.response, ownership);
        verifyMatchingAlarmRequest(
          existing,
          requestMarker.Value,
          alarmName,
        );
        return { PhysicalResourceId: alarmName };
      }
      createWithTags = true;
      createTags = [...requiredTags, requestMarker];
    }
  }

  const distributionId = requiredProperty(event, "DistributionId");

  await cloudWatch.putMetricAlarm({
    AlarmName: alarmName,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    Dimensions: [
      { Name: "DistributionId", Value: distributionId },
      { Name: "Region", Value: "Global" },
    ],
    EvaluationPeriods: 2,
    MetricName: "5xxErrorRate",
    Namespace: "AWS/CloudFront",
    Period: 300,
    Statistic: "Average",
    Threshold: 5,
    TreatMissingData: "notBreaching",
    ...(createWithTags ? { Tags: createTags } : {}),
  });

  if (createWithTags) {
    return { PhysicalResourceId: alarmName };
  }

  const driftedKeys = [...current.keys()]
    .filter((key) => !required.has(key));

  if (driftedKeys.length > 0) {
    await cloudWatch.untagResource({
      ResourceARN: alarmArn,
      TagKeys: driftedKeys,
    });
  }

  await cloudWatch.tagResource({
    ResourceARN: alarmArn,
    Tags: requiredTags,
  });

  return { PhysicalResourceId: alarmName };
}

function invalidationState(response, expectedId) {
  const invalidation = response?.Invalidation;
  if (
    !invalidation
    || typeof invalidation !== "object"
    || typeof invalidation.Id !== "string"
    || invalidation.Id.length === 0
    || typeof invalidation.Status !== "string"
  ) {
    throw new Error("CloudFront returned a malformed invalidation response.");
  }
  if (expectedId !== undefined && invalidation.Id !== expectedId) {
    throw new Error("CloudFront returned a mismatched invalidation ID.");
  }
  if (!INVALIDATION_STATUSES.has(invalidation.Status)) {
    throw new Error(
      `CloudFront returned an unknown invalidation status: `
        + `${invalidation.Status}`,
    );
  }
  return invalidation;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateInvalidationTiming({
  clearTimer,
  createAbortController,
  getRemainingTimeInMillis,
  maxAttempts,
  maxSdkAttemptDurationMs,
  pollIntervalMs,
  responseReserveMs,
  setTimer,
  sleep,
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Invalidation maxAttempts must be a positive integer.");
  }
  if (
    typeof pollIntervalMs !== "number"
    || !Number.isFinite(pollIntervalMs)
    || pollIntervalMs < 0
  ) {
    throw new Error("Invalidation pollIntervalMs must be non-negative.");
  }
  if (
    typeof responseReserveMs !== "number"
    || !Number.isFinite(responseReserveMs)
    || responseReserveMs < MINIMUM_INVALIDATION_RESPONSE_RESERVE_MS
  ) {
    throw new Error(
      "Invalidation response reserve must be at least 30 seconds.",
    );
  }
  if (typeof getRemainingTimeInMillis !== "function") {
    throw new Error(
      "Invalidation remaining-time reader must be a function.",
    );
  }
  if (
    typeof maxSdkAttemptDurationMs !== "number"
    || !Number.isFinite(maxSdkAttemptDurationMs)
    || maxSdkAttemptDurationMs <= 0
  ) {
    throw new Error(
      "Invalidation SDK attempt duration must be positive.",
    );
  }
  if (typeof createAbortController !== "function") {
    throw new Error(
      "Invalidation AbortController factory must be a function.",
    );
  }
  if (
    typeof setTimer !== "function"
    || typeof clearTimer !== "function"
  ) {
    throw new Error("Invalidation deadline timers must be functions.");
  }
  if (typeof sleep !== "function") {
    throw new Error("Invalidation sleep must be a function.");
  }
}

function invalidationRemainingTime(getRemainingTimeInMillis) {
  const remainingMilliseconds = getRemainingTimeInMillis();
  if (
    typeof remainingMilliseconds !== "number"
    || Number.isNaN(remainingMilliseconds)
  ) {
    throw new Error(
      "CloudFront invalidation remaining time is malformed.",
    );
  }
  return remainingMilliseconds;
}

function requireInvalidationTime(
  getRemainingTimeInMillis,
  requiredMilliseconds,
) {
  if (
    invalidationRemainingTime(getRemainingTimeInMillis)
      <= requiredMilliseconds
  ) {
    throw new Error(
      "CloudFront invalidation stopped because the remaining-time "
        + "deadline reserve would be crossed.",
    );
  }
}

async function requestWithinInvalidationDeadline(
  operation,
  {
    clearTimer,
    createAbortController,
    getRemainingTimeInMillis,
    maxSdkAttemptDurationMs,
    responseReserveMs,
    setTimer,
  },
) {
  const callBudgetMs = Math.min(
    maxSdkAttemptDurationMs,
    invalidationRemainingTime(getRemainingTimeInMillis)
      - responseReserveMs,
  );
  if (!(callBudgetMs > 0)) {
    throw new Error(
      "CloudFront invalidation stopped because no SDK call budget "
        + "remains before the response-reserve deadline.",
    );
  }

  const controller = createAbortController();
  if (
    !controller
    || typeof controller !== "object"
    || typeof controller.abort !== "function"
    || !controller.signal
  ) {
    throw new Error(
      "CloudFront invalidation AbortController is malformed.",
    );
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => {
      reject(
        new Error(
          "CloudFront invalidation SDK request exceeded its deadline.",
        ),
      );
      try {
        controller.abort();
      } catch {
        // The controlled deadline error is already settled.
      }
    }, callBudgetMs);
  });
  const request = Promise.resolve().then(
    () => operation(controller.signal),
  );

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimer(timer);
    }
  }
}

export async function requestCloudFrontInvalidation(
  event,
  cloudFront,
  {
    clearTimer = clearTimeout,
    createAbortController = () => new AbortController(),
    getRemainingTimeInMillis = () => Number.POSITIVE_INFINITY,
    maxAttempts = DEFAULT_INVALIDATION_MAX_ATTEMPTS,
    maxSdkAttemptDurationMs =
      DEFAULT_INVALIDATION_SDK_ATTEMPT_DURATION_MS,
    pollIntervalMs = DEFAULT_INVALIDATION_POLL_INTERVAL_MS,
    responseReserveMs = DEFAULT_INVALIDATION_RESPONSE_RESERVE_MS,
    setTimer = setTimeout,
    sleep = defaultSleep,
  } = {},
) {
  const distributionId = requiredProperty(event, "DistributionId");
  const physicalResourceId = `cloudfront-invalidation-${distributionId}`;

  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: physicalResourceId };
  }

  validateInvalidationTiming({
    clearTimer,
    createAbortController,
    getRemainingTimeInMillis,
    maxAttempts,
    maxSdkAttemptDurationMs,
    pollIntervalMs,
    responseReserveMs,
    setTimer,
    sleep,
  });

  const paths = requiredProperty(event, "Paths");
  const created = await requestWithinInvalidationDeadline(
    (abortSignal) => cloudFront.createInvalidation(
      {
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: event.RequestId,
          Paths: {
            Items: paths,
            Quantity: paths.length,
          },
        },
      },
      { abortSignal },
    ),
    {
      clearTimer,
      createAbortController,
      getRemainingTimeInMillis,
      maxSdkAttemptDurationMs,
      responseReserveMs,
      setTimer,
    },
  );
  const invalidation = invalidationState(created);
  if (invalidation.Status === "Completed") {
    return { PhysicalResourceId: physicalResourceId };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    requireInvalidationTime(
      getRemainingTimeInMillis,
      responseReserveMs + pollIntervalMs,
    );
    await sleep(pollIntervalMs);
    const polled = invalidationState(
      await requestWithinInvalidationDeadline(
        (abortSignal) => cloudFront.getInvalidation(
          {
            DistributionId: distributionId,
            Id: invalidation.Id,
          },
          { abortSignal },
        ),
        {
          clearTimer,
          createAbortController,
          getRemainingTimeInMillis,
          maxSdkAttemptDurationMs,
          responseReserveMs,
          setTimer,
        },
      ),
      invalidation.Id,
    );
    if (polled.Status === "Completed") {
      return { PhysicalResourceId: physicalResourceId };
    }
  }

  throw new Error(
    `CloudFront invalidation ${invalidation.Id} did not complete after `
      + `${maxAttempts} attempts.`,
  );
}

export function sendCloudFormationResponse(
  event,
  context,
  status,
  result,
  reason,
  {
    requestTransport = https.request,
    timeoutMs = DEFAULT_RESPONSE_UPLOAD_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason ?? `See CloudWatch Logs: ${context.logStreamName}`,
    PhysicalResourceId:
      result?.PhysicalResourceId
      ?? event.PhysicalResourceId
      ?? context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: result?.Data ?? {},
  });
  let responseUrl;
  try {
    responseUrl = new URL(event.ResponseURL);
  } catch {
    return Promise.reject(
      new Error("CloudFormation response upload URL is invalid."),
    );
  }
  if (
    typeof requestTransport !== "function"
    || typeof setTimer !== "function"
    || typeof clearTimer !== "function"
    || typeof timeoutMs !== "number"
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
  ) {
    return Promise.reject(
      new Error("CloudFormation response upload configuration is invalid."),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let request;

    const settle = (operation, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimer(timer);
      }
      operation(value);
    };
    const rejectUpload = (message) => {
      settle(reject, new Error(message));
    };

    try {
      request = requestTransport(
        {
          hostname: responseUrl.hostname,
          path: `${responseUrl.pathname}${responseUrl.search}`,
          method: "PUT",
          headers: {
            "content-length": Buffer.byteLength(body),
            "content-type": "",
          },
        },
        (response) => {
          response.once("error", () => {
            rejectUpload("CloudFormation response upload failed.");
          });
          response.once("end", () => {
            if (
              Number.isInteger(response.statusCode)
              && response.statusCode >= 200
              && response.statusCode < 300
            ) {
              settle(resolve);
              return;
            }
            rejectUpload(
              "CloudFormation response upload returned a non-2xx status.",
            );
          });
          response.resume();
        },
      );
      request.once("error", () => {
        rejectUpload("CloudFormation response upload failed.");
      });
      timer = setTimer(() => {
        rejectUpload("CloudFormation response upload timed out.");
        try {
          request.destroy();
        } catch {
          // The controlled timeout result is already settled.
        }
      }, timeoutMs);
      request.end(body);
    } catch {
      rejectUpload("CloudFormation response upload failed.");
    }
  });
}

function defaultOperationFailureResult(event) {
  if (
    typeof event.PhysicalResourceId === "string"
    && event.PhysicalResourceId.length > 0
  ) {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  return undefined;
}

function resolveOperationFailureResult(event, operationFailureResult) {
  try {
    return operationFailureResult(event)
      ?? defaultOperationFailureResult(event);
  } catch {
    return defaultOperationFailureResult(event);
  }
}

function logTerminalResponseError(logTerminalError) {
  try {
    logTerminalError(RESPONSE_DELIVERY_FAILED_REASON);
  } catch {
    // Logging failure must not trigger an asynchronous mutation replay.
  }
}

export async function handleCustomResource(
  event,
  context,
  operation,
  {
    logTerminalError = console.error,
    operationFailureResult = defaultOperationFailureResult,
    responseRetryDelayMs = DEFAULT_RESPONSE_RETRY_DELAY_MS,
    sendResponse = sendCloudFormationResponse,
    sleep = defaultSleep,
    successResponseAttempts = DEFAULT_SUCCESS_RESPONSE_ATTEMPTS,
  } = {},
) {
  let result;
  try {
    result = await operation();
  } catch {
    const failureResult = resolveOperationFailureResult(
      event,
      operationFailureResult,
    );
    try {
      await sendResponse(
        event,
        context,
        "FAILED",
        failureResult,
        OPERATION_FAILED_REASON,
      );
    } catch {
      logTerminalResponseError(logTerminalError);
    }
    return failureResult;
  }

  for (let attempt = 0; attempt < successResponseAttempts; attempt += 1) {
    try {
      await sendResponse(event, context, "SUCCESS", result);
      return result;
    } catch {
      if (attempt + 1 < successResponseAttempts) {
        try {
          await sleep(responseRetryDelayMs);
        } catch {
          // A failed backoff must not replay the completed operation.
        }
      }
    }
  }

  try {
    await sendResponse(
      event,
      context,
      "FAILED",
      result,
      RESPONSE_DELIVERY_FAILED_REASON,
    );
  } catch {
    logTerminalResponseError(logTerminalError);
  }
  return result;
}

async function cloudWatchAdapter() {
  const {
    CloudWatchClient,
    DeleteAlarmsCommand,
    ListTagsForResourceCommand,
    PutMetricAlarmCommand,
    TagResourceCommand,
    UntagResourceCommand,
  } = await import("@aws-sdk/client-cloudwatch");
  const client = new CloudWatchClient({ region: "us-east-1" });

  return {
    deleteAlarms: (input) => client.send(new DeleteAlarmsCommand(input)),
    listTagsForResource: (input) =>
      client.send(new ListTagsForResourceCommand(input)),
    putMetricAlarm: (input) =>
      client.send(new PutMetricAlarmCommand(input)),
    tagResource: (input) => client.send(new TagResourceCommand(input)),
    untagResource: (input) => client.send(new UntagResourceCommand(input)),
  };
}

async function cloudFrontAdapter() {
  const {
    CloudFrontClient,
    CreateInvalidationCommand,
    GetInvalidationCommand,
  } = await import("@aws-sdk/client-cloudfront");
  const client = new CloudFrontClient({});

  return {
    createInvalidation: (input, { abortSignal } = {}) =>
      client.send(
        new CreateInvalidationCommand(input),
        { abortSignal },
      ),
    getInvalidation: (input, { abortSignal } = {}) =>
      client.send(
        new GetInvalidationCommand(input),
        { abortSignal },
      ),
  };
}

async function iamPolicyAdapter() {
  const {
    IAMClient,
    ListPolicyTagsCommand,
    TagPolicyCommand,
    UntagPolicyCommand,
  } = await import("@aws-sdk/client-iam");
  const client = new IAMClient({});

  return {
    listPolicyTags: (input) =>
      client.send(new ListPolicyTagsCommand(input)),
    tagPolicy: (input) => client.send(new TagPolicyCommand(input)),
    untagPolicy: (input) => client.send(new UntagPolicyCommand(input)),
  };
}

export async function alarmHandler(event, context) {
  const cloudWatch = await cloudWatchAdapter();
  return handleCustomResource(
    event,
    context,
    () => reconcileCloudFrontAlarm(event, cloudWatch),
  );
}

export async function handleRuntimeBoundaryTags(
  event,
  context,
  iam,
  handlerOptions = {},
) {
  return handleCustomResource(
    event,
    context,
    () => reconcileRuntimeBoundaryTags(event, iam),
    {
      ...handlerOptions,
      operationFailureResult: () => {
        const { policyArn } =
          runtimeBoundaryTagConfiguration(event.ResourceProperties);
        return { PhysicalResourceId: policyArn };
      },
    },
  );
}

export async function handleManagedPolicyTags(
  event,
  context,
  iam,
  expectedPolicyName,
  handlerOptions = {},
) {
  return handleCustomResource(
    event,
    context,
    () => reconcileManagedPolicyTags(
      event,
      iam,
      expectedPolicyName,
    ),
    {
      ...handlerOptions,
      operationFailureResult: () => {
        const { policyArn } = managedPolicyTagConfiguration(
          event.ResourceProperties,
          expectedPolicyName,
        );
        return { PhysicalResourceId: policyArn };
      },
    },
  );
}

export async function managedPolicyTagsHandler(event, context) {
  const expectedPolicyName = process.env.MANAGED_POLICY_NAME;
  if (!expectedPolicyName) {
    throw new Error("MANAGED_POLICY_NAME is required.");
  }
  const iam = await iamPolicyAdapter();
  return handleManagedPolicyTags(
    event,
    context,
    iam,
    expectedPolicyName,
  );
}

export async function runtimeBoundaryTagsHandler(event, context) {
  const iam = await iamPolicyAdapter();
  const inventoryBoundary = "AgenticPlatform-Web-PolicyInventoryBoundary";
  // Only these two stack-owned policies share this tag provider. The generic
  // reconciler still verifies the exact account, root ARN and physical ID.
  const expectedName = event?.ResourceProperties?.PolicyArn?.endsWith(
    ":policy/" + inventoryBoundary,
  ) ? inventoryBoundary : RUNTIME_BOUNDARY_NAME;
  return handleManagedPolicyTags(event, context, iam, expectedName);
}

export async function invalidationHandler(event, context) {
  const cloudFront = await cloudFrontAdapter();
  return handleCustomResource(
    event,
    context,
    () => requestCloudFrontInvalidation(
      event,
      cloudFront,
      {
        getRemainingTimeInMillis: () =>
          context.getRemainingTimeInMillis(),
      },
    ),
  );
}
