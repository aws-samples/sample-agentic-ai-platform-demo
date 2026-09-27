import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { createPlatformState } from "../lambda/platform-admin/state.mjs";

const NOW = "2026-08-23T01:02:03.000Z";
const TABLE_NAME = "PlatformState";
const MAX_REQUEST_RESULT_ITEM_BYTES = 256 * 1024;
const PAYLOAD_FINGERPRINT = "a".repeat(64);
const OWNER_TOKEN = "owner-token-123";
const CLEANUP_EXECUTION_TOKEN =
  "11111111-1111-4111-8111-111111111111";
const CLEANUP_LEASE_SECONDS = 90;
const GROUP_OPERATION_TOKEN = createHash("sha256")
  .update(
    "cognito-domain-group:v2\n"
      + createHash("sha256")
        .update("admin-sub-123\nrequest-123\ncustomer_support")
        .digest("hex"),
  )
  .digest("hex");
const OPERATIONS_GROUP_OPERATION_TOKEN = createHash("sha256")
  .update(
    "cognito-domain-group:v2\n"
      + createHash("sha256")
        .update("admin-sub-123\nrequest-123\noperations")
        .digest("hex"),
  )
  .digest("hex");
const OTHER_REQUEST_GROUP_OPERATION_TOKEN = createHash("sha256")
  .update(
    "cognito-domain-group:v2\n"
      + createHash("sha256")
        .update("admin-sub-123\nrequest-456\ncustomer_support")
        .digest("hex"),
  )
  .digest("hex");
const NOW_EPOCH = Math.floor(Date.parse(NOW) / 1000);
const REGISTRY_ROUTE = "POST /api/registry-decide";
const REGISTRY_KIND = "REGISTRY_DECISION";
const REGISTRY_ID = "SharedReg12345";
const REGISTRY_RECORD_ID = "Rec123456789";
const REGISTRY_SEMVER = "1.0.0";
const ACTOR_HASH = createHash("sha256")
  .update("admin-sub-123")
  .digest("hex");
const APPROVE_REASON = "Approved by platform administrator.";
const STATUS_REASON_HASH = createHash("sha256")
  .update(APPROVE_REASON)
  .digest("hex");

function domain(overrides = {}) {
  return {
    id: "customer_support",
    name: "Customer Support",
    owner: "Customer Support team",
    ownerGroup: "domain-customer-support",
    description: "Customer-facing support agents.",
    tokenBudget: 24000,
    registryId: "CustomerReg1234",
    registryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/CustomerReg1234",
    createdBy: "deployment:baseline",
    ...overrides,
  };
}

function recordingDynamo(responses = [{}]) {
  const commands = [];
  const options = [];
  return {
    commands,
    options,
    async send(command, sendOptions) {
      commands.push(command);
      options.push(sendOptions);
      if (responses.length === 0) {
        throw new Error("Unexpected DynamoDB command.");
      }
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function domainItem(value = domain()) {
  return {
    pk: { S: "DOMAIN" },
    sk: { S: `DOMAIN#${value.id}` },
    entityType: { S: "DOMAIN" },
    id: { S: value.id },
    name: { S: value.name },
    owner: { S: value.owner },
    ownerGroup: { S: value.ownerGroup },
    description: { S: value.description },
    tokenBudget: value.tokenBudget === null
      ? { NULL: true }
      : { N: String(value.tokenBudget) },
    registryId: { S: value.registryId },
    registryArn: { S: value.registryArn },
    createdBy: { S: value.createdBy },
    status: { S: value.status ?? "ACTIVE" },
    createdAt: { S: value.createdAt ?? NOW },
  };
}

function nativeResultValue(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "boolean") return { BOOL: value };
  if (typeof value === "number") return { N: String(value) };
  if (Array.isArray(value)) {
    return { L: value.map(nativeResultValue) };
  }
  return {
    M: Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        nativeResultValue(child),
      ]),
    ),
  };
}

function requestResultItem(result, overrides = {}) {
  return {
    pk: { S: "REQUEST#user-1234" },
    sk: { S: "REQUEST#POST /api/domains#request-size-boundary" },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: "user-1234" },
    route: { S: "POST /api/domains" },
    requestId: { S: "request-size-boundary" },
    result: nativeResultValue(result),
    expiresAt: { N: "1787533323" },
    createdAt: { S: NOW },
    ...overrides,
  };
}

function atomicRequestResult(value = domain()) {
  const storedDomain = {
    ...value,
    status: value.status ?? "ACTIVE",
    createdAt: value.createdAt ?? NOW,
  };
  return {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    result: {
      kind: "DOMAIN_CREATE",
      status: "SUCCEEDED",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      domain: storedDomain,
    },
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
  };
}

function domainRequestClaim(overrides = {}) {
  return {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    ownerToken: OWNER_TOKEN,
    claimExpiresAt: NOW_EPOCH + 300,
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
    ...overrides,
  };
}

function claimResult(overrides = {}) {
  return {
    kind: "DOMAIN_CREATE",
    status: "IN_PROGRESS",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    ownerToken: OWNER_TOKEN,
    claimExpiresAt: NOW_EPOCH + 300,
    ...overrides,
  };
}

function domainCleanup(overrides = {}) {
  return {
    status: "PENDING",
    registryId: "FinanceReg1234",
    registryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/FinanceReg1234",
    ...overrides,
  };
}

function ownedDomainCleanup(overrides = {}) {
  return domainCleanup({
    ownerGroup: {
      name: "domain-customer-support",
      operationToken: GROUP_OPERATION_TOKEN,
    },
    ...overrides,
  });
}

function cleaningDomainCleanup(overrides = {}) {
  return domainCleanup({
    status: "CLEANING",
    cleanupExecutionToken: CLEANUP_EXECUTION_TOKEN,
    cleanupClaimExpiresAt: NOW_EPOCH + CLEANUP_LEASE_SECONDS,
    ...overrides,
  });
}

function cleaningOwnedDomainCleanup(overrides = {}) {
  return ownedDomainCleanup({
    status: "CLEANING",
    cleanupExecutionToken: CLEANUP_EXECUTION_TOKEN,
    cleanupClaimExpiresAt: NOW_EPOCH + CLEANUP_LEASE_SECONDS,
    ...overrides,
  });
}

function domainConflictResult(overrides = {}) {
  return {
    kind: "DOMAIN_CREATE",
    status: "FAILED_FINAL",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    code: "DOMAIN_CONFLICT",
    cleanup: domainCleanup(),
    ...overrides,
  };
}

function domainProvisioningCleanupResult(overrides = {}) {
  return {
    kind: "DOMAIN_CREATE",
    status: "FAILED_FINAL",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    code: "DOMAIN_PROVISIONING_FAILED",
    cleanup: domainCleanup(),
    ...overrides,
  };
}

function domainCommitCleanupResult(overrides = {}) {
  return domainConflictResult({
    code: "DOMAIN_COMMIT_FAILED",
    cleanup: ownedDomainCleanup(),
    ...overrides,
  });
}

function registryRequestClaim(overrides = {}) {
  return {
    actor: "admin-sub-123",
    route: REGISTRY_ROUTE,
    requestId: "registry-request-123",
    kind: REGISTRY_KIND,
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    ownerToken: OWNER_TOKEN,
    claimExpiresAt: NOW_EPOCH + 300,
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
    ...overrides,
  };
}

function registryDecisionTarget(overrides = {}) {
  return {
    registryId: REGISTRY_ID,
    recordId: REGISTRY_RECORD_ID,
    semver: REGISTRY_SEMVER,
    targetStatus: "APPROVED",
    statusReasonHash: STATUS_REASON_HASH,
    ...overrides,
  };
}

function registryTargetClaim(overrides = {}) {
  const { expiresAt: _expiresAt, ...claim } = registryRequestClaim();
  return {
    ...claim,
    phase: "TARGET_BOUND",
    attemptCount: 0,
    retryAfter: 0,
    target: registryDecisionTarget(),
    ...overrides,
  };
}

function registryAudit(overrides = {}) {
  return {
    actor: "admin-sub-123",
    action: "registry.version.decide",
    resource: "registry/customer-support-blueprint/1.0.0",
    decision: "approve",
    reason: "Approved by platform administrator.",
    requestId: "registry-request-123",
    timestamp: NOW,
    ...overrides,
  };
}

function registryRequestResult(overrides = {}) {
  return {
    actor: "admin-sub-123",
    route: REGISTRY_ROUTE,
    requestId: "registry-request-123",
    result: {
      kind: REGISTRY_KIND,
      status: "SUCCEEDED",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      decision: "approve",
      reason: "Approved by platform administrator.",
      resource: "registry/customer-support-blueprint/1.0.0",
      version: {
        id: "customer-support-blueprint",
        semver: "1.0.0",
        status: "APPROVED",
        statusReason: "Approved by platform administrator.",
        _aws: {
          registryId: "SharedReg12345",
          recordId: REGISTRY_RECORD_ID,
        },
      },
    },
    createdAt: NOW,
    ...overrides,
  };
}

function registryFinalRequestResult(overrides = {}) {
  return {
    ...registryRequestResult(),
    result: {
      ...registryRequestResult().result,
      resource:
        `registry/${REGISTRY_ID}/record/${REGISTRY_RECORD_ID}`
        + `/version/${REGISTRY_SEMVER}`,
    },
    ...overrides,
  };
}

function atomicRequestResultItem(request = atomicRequestResult()) {
  return {
    pk: { S: `REQUEST#${request.actor}` },
    sk: {
      S: `REQUEST#${request.route}#${request.requestId}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: request.actor },
    route: { S: request.route },
    requestId: { S: request.requestId },
    result: nativeResultValue(request.result),
    expiresAt: { N: String(request.expiresAt) },
    createdAt: { S: request.createdAt },
  };
}

function permanentRegistryRequestItem(
  request = registryFinalRequestResult(),
) {
  return {
    pk: { S: `REQUEST#${request.actor}` },
    sk: {
      S: `REQUEST#${request.route}#${request.requestId}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: request.actor },
    route: { S: request.route },
    requestId: { S: request.requestId },
    result: nativeResultValue(request.result),
    createdAt: { S: request.createdAt },
  };
}

function permanentDomainConflictRequestItem(request) {
  return {
    pk: { S: `REQUEST#${request.actor}` },
    sk: {
      S: `REQUEST#${request.route}#${request.requestId}`,
    },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: request.actor },
    route: { S: request.route },
    requestId: { S: request.requestId },
    result: nativeResultValue(request.result),
    createdAt: { S: request.createdAt },
  };
}

function resultAtMarshalledItemSize(targetBytes) {
  const chunk = "x".repeat(32768);
  const result = {
    chunks: Array.from({ length: 7 }, () => chunk),
    padding: "",
  };
  const baseBytes = Buffer.byteLength(
    JSON.stringify(requestResultItem(result)),
  );
  const paddingLength = targetBytes - baseBytes;
  assert.ok(paddingLength >= 0);
  assert.ok(paddingLength <= 32768);
  result.padding = "p".repeat(paddingLength);
  assert.equal(
    Buffer.byteLength(JSON.stringify(requestResultItem(result))),
    targetBytes,
  );
  return result;
}

test("putDomain writes native attributes with an immutable create condition", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  const stored = await state.putDomain(domain());

  assert.deepEqual(stored, {
    ...domain(),
    status: "ACTIVE",
    createdAt: NOW,
  });
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: {
      pk: { S: "DOMAIN" },
      sk: { S: "DOMAIN#customer_support" },
      entityType: { S: "DOMAIN" },
      id: { S: "customer_support" },
      name: { S: "Customer Support" },
      owner: { S: "Customer Support team" },
      ownerGroup: { S: "domain-customer-support" },
      description: { S: "Customer-facing support agents." },
      tokenBudget: { N: "24000" },
      registryId: { S: "CustomerReg1234" },
      registryArn: {
        S:
          "arn:aws:agent-registry:us-west-2:111122223333:"
          + "registry/CustomerReg1234",
      },
      createdBy: { S: "deployment:baseline" },
      status: { S: "ACTIVE" },
      createdAt: { S: NOW },
    },
    ConditionExpression:
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  });
});

test("domain request claims bind one owner to one payload fingerprint", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const claim = domainRequestClaim();
  const expected = {
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
    result: claimResult(),
    expiresAt: claim.expiresAt,
    createdAt: claim.createdAt,
  };

  assert.deepEqual(await state.claimDomainRequest(claim), expected);
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: atomicRequestResultItem(expected),
    ConditionExpression:
      "(attribute_not_exists(#pk) AND attribute_not_exists(#sk)) "
      + "OR #expiresAt <= :now "
      + "OR (#result.#kind = :kind "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND (#result.#status = :failedRetryable "
      + "OR (#result.#status = :inProgress "
      + "AND #result.#claimExpiresAt <= :now)))",
    ExpressionAttributeNames: {
      "#claimExpiresAt": "claimExpiresAt",
      "#expiresAt": "expiresAt",
      "#kind": "kind",
      "#payloadFingerprint": "payloadFingerprint",
      "#pk": "pk",
      "#result": "result",
      "#sk": "sk",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":failedRetryable": { S: "FAILED_RETRYABLE" },
      ":inProgress": { S: "IN_PROGRESS" },
      ":kind": { S: "DOMAIN_CREATE" },
      ":now": { N: String(NOW_EPOCH) },
      ":payloadFingerprint": { S: PAYLOAD_FINGERPRINT },
    },
  });
});

test("reclaimed domain request claims preserve the exact Registry target", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const claim = {
    ...domainRequestClaim(),
    registry: {
      registryId: domainCleanup().registryId,
      registryArn: domainCleanup().registryArn,
    },
  };
  const expected = {
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
    result: {
      ...claimResult(),
      registry: claim.registry,
    },
    expiresAt: claim.expiresAt,
    createdAt: claim.createdAt,
  };

  assert.deepEqual(await state.claimDomainRequest(claim), expected);
  assert.deepEqual(
    dynamo.commands[0].input.Item,
    atomicRequestResultItem(expected),
  );
});

test("retryable transition conditionally replaces only the matching owner claim", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = {
    ...domainRequestClaim(),
    registry: {
      registryId: domainCleanup().registryId,
      registryArn: domainCleanup().registryArn,
    },
  };
  const expected = {
    actor: transition.actor,
    route: transition.route,
    requestId: transition.requestId,
    result: {
      kind: "DOMAIN_CREATE",
      status: "FAILED_RETRYABLE",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      registry: transition.registry,
    },
    expiresAt: transition.expiresAt,
    createdAt: transition.createdAt,
  };

  assert.deepEqual(
    await state.markDomainRequestRetryable(transition),
    expected,
  );
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: atomicRequestResultItem(expected),
    ConditionExpression:
      "#result.#kind = :kind "
      + "AND #result.#status = :inProgress "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND #result.#ownerToken = :ownerToken",
    ExpressionAttributeNames: {
      "#kind": "kind",
      "#ownerToken": "ownerToken",
      "#payloadFingerprint": "payloadFingerprint",
      "#result": "result",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":inProgress": { S: "IN_PROGRESS" },
      ":kind": { S: "DOMAIN_CREATE" },
      ":ownerToken": { S: OWNER_TOKEN },
      ":payloadFingerprint": { S: PAYLOAD_FINGERPRINT },
    },
  });
});

test("domain conflict fence conditionally replaces only the matching owner claim", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = domainRequestClaim();
  const expected = {
    actor: transition.actor,
    route: transition.route,
    requestId: transition.requestId,
    result: {
      kind: "DOMAIN_CREATE",
      status: "FAILED_FINAL",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      code: "DOMAIN_CONFLICT",
      cleanup: domainCleanup(),
    },
    createdAt: transition.createdAt,
  };
  const fence = {
    ...transition,
    cleanup: {
      registryId: domainCleanup().registryId,
      registryArn: domainCleanup().registryArn,
    },
  };

  assert.equal(typeof state.markDomainRequestConflict, "function");
  assert.deepEqual(
    await state.markDomainRequestConflict(fence),
    expected,
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: permanentDomainConflictRequestItem(expected),
    ConditionExpression:
      "#createdAt = :createdAt "
      + "AND #result.#kind = :kind "
      + "AND #result.#status = :inProgress "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND #result.#ownerToken = :ownerToken",
    ExpressionAttributeNames: {
      "#createdAt": "createdAt",
      "#kind": "kind",
      "#ownerToken": "ownerToken",
      "#payloadFingerprint": "payloadFingerprint",
      "#result": "result",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":createdAt": { S: transition.createdAt },
      ":inProgress": { S: "IN_PROGRESS" },
      ":kind": { S: "DOMAIN_CREATE" },
      ":ownerToken": { S: OWNER_TOKEN },
      ":payloadFingerprint": { S: PAYLOAD_FINGERPRINT },
    },
  });
});

test("domain provisioning cleanup fence conditionally replaces only the matching owner claim", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = domainRequestClaim();
  const expected = {
    actor: transition.actor,
    route: transition.route,
    requestId: transition.requestId,
    result: domainProvisioningCleanupResult(),
    createdAt: transition.createdAt,
  };
  const fence = {
    ...transition,
    cleanup: {
      registryId: domainCleanup().registryId,
      registryArn: domainCleanup().registryArn,
    },
  };

  assert.equal(
    typeof state.markDomainRequestProvisioningCleanupPending,
    "function",
  );
  assert.deepEqual(
    await state.markDomainRequestProvisioningCleanupPending(fence),
    expected,
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: permanentDomainConflictRequestItem(expected),
    ConditionExpression:
      "#createdAt = :createdAt "
      + "AND #result.#kind = :kind "
      + "AND #result.#status = :inProgress "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND #result.#ownerToken = :ownerToken",
    ExpressionAttributeNames: {
      "#createdAt": "createdAt",
      "#kind": "kind",
      "#ownerToken": "ownerToken",
      "#payloadFingerprint": "payloadFingerprint",
      "#result": "result",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":createdAt": { S: transition.createdAt },
      ":inProgress": { S: "IN_PROGRESS" },
      ":kind": { S: "DOMAIN_CREATE" },
      ":ownerToken": { S: OWNER_TOKEN },
      ":payloadFingerprint": { S: PAYLOAD_FINGERPRINT },
    },
  });
});

test("domain commit cleanup fence durably binds exact Registry and group ownership", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = domainRequestClaim();
  const {
    status: _status,
    ...cleanup
  } = ownedDomainCleanup();

  assert.deepEqual(
    await state.markDomainRequestCommitCleanupPending({
      ...transition,
      cleanup,
    }),
    {
      actor: transition.actor,
      route: transition.route,
      requestId: transition.requestId,
      result: domainCommitCleanupResult(),
      createdAt: transition.createdAt,
    },
  );
  assert.equal(
    Object.hasOwn(dynamo.commands[0].input.Item, "expiresAt"),
    false,
  );
});

test("domain conflict cleanup durably binds an exact managed owner group", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = domainRequestClaim();
  const cleanup = ownedDomainCleanup();
  const expected = {
    actor: transition.actor,
    route: transition.route,
    requestId: transition.requestId,
    result: domainConflictResult({ cleanup }),
    createdAt: transition.createdAt,
  };

  assert.deepEqual(
    await state.markDomainRequestConflict({
      ...transition,
      cleanup: {
        registryId: cleanup.registryId,
        registryArn: cleanup.registryArn,
        ownerGroup: cleanup.ownerGroup,
      },
    }),
    expected,
  );
  assert.deepEqual(
    dynamo.commands[0].input.Item.result.M.cleanup.M.ownerGroup,
    {
      M: {
        name: { S: "domain-customer-support" },
        operationToken: { S: GROUP_OPERATION_TOKEN },
      },
    },
  );
});

test("owned domain cleanup round-trips the exact nested DynamoDB map", async () => {
  let storedItem;
  const dynamo = {
    async send(command) {
      if (command instanceof PutItemCommand) {
        storedItem = structuredClone(command.input.Item);
        return {};
      }
      if (command instanceof GetItemCommand) {
        return { Item: structuredClone(storedItem) };
      }
      throw new Error("Unexpected DynamoDB command.");
    },
  };
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = domainRequestClaim();
  const cleanup = ownedDomainCleanup();
  const expected = {
    actor: transition.actor,
    route: transition.route,
    requestId: transition.requestId,
    result: domainConflictResult({ cleanup }),
    createdAt: transition.createdAt,
  };

  await state.markDomainRequestConflict({
    ...transition,
    cleanup: {
      registryId: cleanup.registryId,
      registryArn: cleanup.registryArn,
      ownerGroup: cleanup.ownerGroup,
    },
  });

  assert.deepEqual(
    await state.getRequestResult({
      actor: transition.actor,
      route: transition.route,
      requestId: transition.requestId,
    }),
    expected,
  );
  assert.deepEqual(storedItem.result.M.cleanup.M.ownerGroup, {
    M: {
      name: { S: "domain-customer-support" },
      operationToken: { S: GROUP_OPERATION_TOKEN },
    },
  });
});

test("domain conflict fences reject well-formed ownership from another domain or request", async () => {
  const foreignOwnership = [
    {
      name: "domain-operations",
      operationToken: GROUP_OPERATION_TOKEN,
    },
    {
      name: "domain-customer-support",
      operationToken: OPERATIONS_GROUP_OPERATION_TOKEN,
    },
    {
      name: "domain-customer-support",
      operationToken: OTHER_REQUEST_GROUP_OPERATION_TOKEN,
    },
  ];

  for (const ownerGroup of foreignOwnership) {
    const dynamo = recordingDynamo();
    const {
      status: _status,
      ...cleanup
    } = ownedDomainCleanup({ ownerGroup });
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo,
        now: () => NOW,
      }).markDomainRequestConflict({
        ...domainRequestClaim(),
        cleanup,
      }),
      (error) => error?.code === "INVALID_REQUEST_RESULT",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("provisioning cleanup rejects an otherwise-valid owned group target", async () => {
  const {
    status: _status,
    ...cleanupTarget
  } = ownedDomainCleanup();
  const pendingDynamo = recordingDynamo();
  const pendingState = createPlatformState({
    tableName: TABLE_NAME,
    dynamo: pendingDynamo,
    now: () => NOW,
  });

  await assert.rejects(
    pendingState.markDomainRequestProvisioningCleanupPending({
      ...domainRequestClaim(),
      cleanup: cleanupTarget,
    }),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(pendingDynamo.commands.length, 0);

  const completionDynamo = recordingDynamo();
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: completionDynamo,
      now: () => NOW,
    }).markDomainRequestCleanupComplete({
      actor: "admin-sub-123",
      route: "POST /api/domain-create",
      requestId: "request-123",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      reason: "DOMAIN_PROVISIONING_FAILED",
      cleanup: ownedDomainCleanup(),
      expiresAt: NOW_EPOCH + 86_400,
      createdAt: NOW,
    }),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(completionDynamo.commands.length, 0);
});

test("stored cleanup decoding rejects legacy, foreign, and provisioning ownership", async () => {
  const results = [
    domainConflictResult({
      cleanup: domainCleanup({
        ownerGroup: "domain-customer-support",
      }),
    }),
    domainConflictResult({
      cleanup: ownedDomainCleanup({
        ownerGroup: {
          name: "domain-operations",
          operationToken: GROUP_OPERATION_TOKEN,
        },
      }),
    }),
    domainConflictResult({
      cleanup: ownedDomainCleanup({
        ownerGroup: {
          name: "domain-customer-support",
          operationToken: OPERATIONS_GROUP_OPERATION_TOKEN,
        },
      }),
    }),
    domainConflictResult({
      cleanup: ownedDomainCleanup({
        ownerGroup: {
          name: "domain-customer-support",
          operationToken: OTHER_REQUEST_GROUP_OPERATION_TOKEN,
        },
      }),
    }),
    domainProvisioningCleanupResult({
      cleanup: ownedDomainCleanup(),
    }),
  ];

  for (const result of results) {
    const request = {
      actor: "admin-sub-123",
      route: "POST /api/domain-create",
      requestId: "request-123",
      result,
      createdAt: NOW,
    };
    const state = createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([{
        Item: permanentDomainConflictRequestItem(request),
      }]),
      now: () => NOW,
    });

    await assert.rejects(
      state.getRequestResult({
        actor: request.actor,
        route: request.route,
        requestId: request.requestId,
      }),
      (error) => error?.code === "MALFORMED_REQUEST_RESULT_ITEM",
    );
  }
});

test("domain cleanup fences reject a replaced claim generation as request claim conflict", async () => {
  const storedCreatedAt = "2026-08-23T01:02:04.000Z";
  const transition = {
    ...domainRequestClaim(),
    cleanup: {
      registryId: domainCleanup().registryId,
      registryArn: domainCleanup().registryArn,
    },
  };

  for (const method of [
    "markDomainRequestConflict",
    "markDomainRequestProvisioningCleanupPending",
  ]) {
    const dynamo = {
      async send(command) {
        const input = command.input;
        const bindsCreatedAt =
          input.ConditionExpression.includes("#createdAt = :createdAt")
          && input.ExpressionAttributeNames?.["#createdAt"] === "createdAt";
        if (
          bindsCreatedAt
          && input.ExpressionAttributeValues?.[":createdAt"]?.S
            !== storedCreatedAt
        ) {
          throw new ConditionalCheckFailedException({
            $metadata: {},
            message: "claim generation changed",
          });
        }
        return {};
      },
    };

    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo,
        now: () => NOW,
      })[method](transition),
      (error) =>
        error?.code === "REQUEST_CLAIM_CONFLICT"
        && error?.name === "RequestClaimConflictError",
    );
  }
});

test("pending domain conflict cleanup remains readable without an expiration", async () => {
  const request = {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    result: domainConflictResult(),
    createdAt: NOW,
  };
  const dynamo = recordingDynamo([{
    Item: permanentDomainConflictRequestItem(request),
  }]);
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => "2026-09-23T01:02:03.000Z",
  });

  assert.deepEqual(await state.getRequestResult({
    actor: request.actor,
    route: request.route,
    requestId: request.requestId,
  }), request);
});

test("pending domain provisioning cleanup remains readable without an expiration", async () => {
  const request = {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    result: domainProvisioningCleanupResult(),
    createdAt: NOW,
  };
  const dynamo = recordingDynamo([{
    Item: permanentDomainConflictRequestItem(request),
  }]);
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => "2026-09-23T01:02:03.000Z",
  });

  assert.deepEqual(await state.getRequestResult({
    actor: request.actor,
    route: request.route,
    requestId: request.requestId,
  }), request);
});

test("post-group commit cleanup remains permanent beyond 24 hours", async () => {
  const request = {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    result: domainCommitCleanupResult(),
    createdAt: NOW,
  };
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo: recordingDynamo([{
      Item: permanentDomainConflictRequestItem(request),
    }]),
    now: () => "2026-09-23T01:02:03.000Z",
  });

  assert.deepEqual(await state.getRequestResult({
    actor: request.actor,
    route: request.route,
    requestId: request.requestId,
  }), request);
});

test("domain cleanup execution claims and releases the exact permanent target", async () => {
  const claimDynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo: claimDynamo,
    now: () => NOW,
  });
  const identity = {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    reason: "DOMAIN_CONFLICT",
    createdAt: NOW,
  };

  assert.equal(typeof state.claimDomainRequestCleanup, "function");
  const claimed = await state.claimDomainRequestCleanup({
    ...identity,
    cleanup: ownedDomainCleanup(),
    cleanupExecutionToken: CLEANUP_EXECUTION_TOKEN,
  });
  assert.deepEqual(
    claimed.result.cleanup,
    cleaningOwnedDomainCleanup(),
  );
  const claimInput = claimDynamo.commands[0].input;
  assert.match(
    claimInput.ConditionExpression,
    /#result\.#cleanup\.#cleanupStatus = :pending/,
  );
  assert.match(
    claimInput.ConditionExpression,
    /#result\.#cleanup\.#ownerGroup\.#operationToken = :operationToken/,
  );
  assert.deepEqual(
    claimInput.Item.result.M.cleanup.M.cleanupExecutionToken,
    { S: CLEANUP_EXECUTION_TOKEN },
  );
  assert.deepEqual(
    claimInput.Item.result.M.cleanup.M.cleanupClaimExpiresAt,
    { N: String(NOW_EPOCH + CLEANUP_LEASE_SECONDS) },
  );

  const releaseDynamo = recordingDynamo();
  const releaseState = createPlatformState({
    tableName: TABLE_NAME,
    dynamo: releaseDynamo,
    now: () => NOW,
  });
  assert.equal(typeof releaseState.releaseDomainRequestCleanup, "function");
  const released = await releaseState.releaseDomainRequestCleanup({
    ...identity,
    cleanup: cleaningOwnedDomainCleanup(),
  });
  assert.deepEqual(released.result.cleanup, ownedDomainCleanup());
  assert.match(
    releaseDynamo.commands[0].input.ConditionExpression,
    /#result\.#cleanup\.#cleanupStatus = :cleaning/,
  );
  assert.match(
    releaseDynamo.commands[0].input.ConditionExpression,
    /#result\.#cleanup\.#cleanupExecutionToken = :expectedCleanupExecutionToken/,
  );
  assert.match(
    releaseDynamo.commands[0].input.ConditionExpression,
    /#result\.#cleanup\.#cleanupClaimExpiresAt = :expectedCleanupClaimExpiresAt/,
  );
});

test("expired CLEANING takeover binds the exact prior execution lease", async () => {
  const expiredCleanup = cleaningOwnedDomainCleanup({
    cleanupExecutionToken:
      "22222222-2222-4222-8222-222222222222",
    cleanupClaimExpiresAt: NOW_EPOCH - 1,
  });
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  const claimed = await state.claimDomainRequestCleanup({
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    reason: "DOMAIN_CONFLICT",
    cleanup: expiredCleanup,
    cleanupExecutionToken: CLEANUP_EXECUTION_TOKEN,
    createdAt: NOW,
  });

  assert.deepEqual(claimed.result.cleanup, cleaningOwnedDomainCleanup());
  const input = dynamo.commands[0].input;
  assert.match(
    input.ConditionExpression,
    /#result\.#cleanup\.#cleanupClaimExpiresAt <= :now/,
  );
  assert.deepEqual(
    input.ExpressionAttributeValues[":expectedCleanupExecutionToken"],
    { S: expiredCleanup.cleanupExecutionToken },
  );
  assert.deepEqual(
    input.ExpressionAttributeValues[":expectedCleanupClaimExpiresAt"],
    { N: String(expiredCleanup.cleanupClaimExpiresAt) },
  );
});

test("domain cleanup completion replaces only the exact CLEANING lease with bounded retention", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    cleanup: cleaningDomainCleanup(),
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
  };
  const expected = {
    actor: transition.actor,
    route: transition.route,
    requestId: transition.requestId,
    result: domainConflictResult({
      cleanup: domainCleanup({ status: "COMPLETE" }),
    }),
    expiresAt: transition.expiresAt,
    createdAt: transition.createdAt,
  };

  assert.equal(
    typeof state.markDomainRequestCleanupComplete,
    "function",
  );
  assert.deepEqual(
    await state.markDomainRequestCleanupComplete(transition),
    expected,
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: atomicRequestResultItem(expected),
    ConditionExpression:
      "#entityType = :entityType "
      + "AND #actor = :actor "
      + "AND #route = :route "
      + "AND #requestId = :requestId "
      + "AND #createdAt = :createdAt "
      + "AND attribute_not_exists(#expiresAt) "
      + "AND size(#result) = :resultSize "
      + "AND #result.#kind = :kind "
      + "AND #result.#status = :failedFinal "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND #result.#code = :code "
      + "AND size(#result.#cleanup) = :cleanupSize "
      + "AND #result.#cleanup.#cleanupStatus = :cleaning "
      + "AND #result.#cleanup.#registryId = :registryId "
      + "AND #result.#cleanup.#registryArn = :registryArn "
      + "AND #result.#cleanup.#cleanupExecutionToken "
      + "= :expectedCleanupExecutionToken "
      + "AND #result.#cleanup.#cleanupClaimExpiresAt "
      + "= :expectedCleanupClaimExpiresAt",
    ExpressionAttributeNames: {
      "#actor": "actor",
      "#cleanup": "cleanup",
      "#cleanupClaimExpiresAt": "cleanupClaimExpiresAt",
      "#cleanupExecutionToken": "cleanupExecutionToken",
      "#cleanupStatus": "status",
      "#code": "code",
      "#createdAt": "createdAt",
      "#entityType": "entityType",
      "#expiresAt": "expiresAt",
      "#kind": "kind",
      "#payloadFingerprint": "payloadFingerprint",
      "#registryArn": "registryArn",
      "#registryId": "registryId",
      "#requestId": "requestId",
      "#result": "result",
      "#route": "route",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":actor": { S: transition.actor },
      ":cleaning": { S: "CLEANING" },
      ":cleanupSize": { N: "5" },
      ":code": { S: "DOMAIN_CONFLICT" },
      ":createdAt": { S: transition.createdAt },
      ":entityType": { S: "REQUEST_RESULT" },
      ":failedFinal": { S: "FAILED_FINAL" },
      ":kind": { S: "DOMAIN_CREATE" },
      ":payloadFingerprint": { S: transition.payloadFingerprint },
      ":expectedCleanupClaimExpiresAt": {
        N: String(transition.cleanup.cleanupClaimExpiresAt),
      },
      ":expectedCleanupExecutionToken": {
        S: transition.cleanup.cleanupExecutionToken,
      },
      ":registryArn": { S: transition.cleanup.registryArn },
      ":registryId": { S: transition.cleanup.registryId },
      ":requestId": { S: transition.requestId },
      ":resultSize": { N: "5" },
      ":route": { S: transition.route },
    },
  });
});

test("provisioning cleanup completion makes the same request retryable", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const transition = {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    reason: "DOMAIN_PROVISIONING_FAILED",
    cleanup: cleaningDomainCleanup(),
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
  };
  const expected = {
    actor: transition.actor,
    route: transition.route,
    requestId: transition.requestId,
    result: {
      kind: "DOMAIN_CREATE",
      status: "FAILED_RETRYABLE",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
    },
    expiresAt: transition.expiresAt,
    createdAt: transition.createdAt,
  };

  assert.deepEqual(
    await state.markDomainRequestCleanupComplete(transition),
    expected,
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: atomicRequestResultItem(expected),
    ConditionExpression:
      "#entityType = :entityType "
      + "AND #actor = :actor "
      + "AND #route = :route "
      + "AND #requestId = :requestId "
      + "AND #createdAt = :createdAt "
      + "AND attribute_not_exists(#expiresAt) "
      + "AND size(#result) = :resultSize "
      + "AND #result.#kind = :kind "
      + "AND #result.#status = :failedFinal "
      + "AND #result.#payloadFingerprint = :payloadFingerprint "
      + "AND #result.#code = :code "
      + "AND size(#result.#cleanup) = :cleanupSize "
      + "AND #result.#cleanup.#cleanupStatus = :cleaning "
      + "AND #result.#cleanup.#registryId = :registryId "
      + "AND #result.#cleanup.#registryArn = :registryArn "
      + "AND #result.#cleanup.#cleanupExecutionToken "
      + "= :expectedCleanupExecutionToken "
      + "AND #result.#cleanup.#cleanupClaimExpiresAt "
      + "= :expectedCleanupClaimExpiresAt",
    ExpressionAttributeNames: {
      "#actor": "actor",
      "#cleanup": "cleanup",
      "#cleanupClaimExpiresAt": "cleanupClaimExpiresAt",
      "#cleanupExecutionToken": "cleanupExecutionToken",
      "#cleanupStatus": "status",
      "#code": "code",
      "#createdAt": "createdAt",
      "#entityType": "entityType",
      "#expiresAt": "expiresAt",
      "#kind": "kind",
      "#payloadFingerprint": "payloadFingerprint",
      "#registryArn": "registryArn",
      "#registryId": "registryId",
      "#requestId": "requestId",
      "#result": "result",
      "#route": "route",
      "#status": "status",
    },
    ExpressionAttributeValues: {
      ":actor": { S: transition.actor },
      ":cleaning": { S: "CLEANING" },
      ":cleanupSize": { N: "5" },
      ":code": { S: transition.reason },
      ":createdAt": { S: transition.createdAt },
      ":entityType": { S: "REQUEST_RESULT" },
      ":failedFinal": { S: "FAILED_FINAL" },
      ":kind": { S: "DOMAIN_CREATE" },
      ":payloadFingerprint": { S: transition.payloadFingerprint },
      ":expectedCleanupClaimExpiresAt": {
        N: String(transition.cleanup.cleanupClaimExpiresAt),
      },
      ":expectedCleanupExecutionToken": {
        S: transition.cleanup.cleanupExecutionToken,
      },
      ":registryArn": { S: transition.cleanup.registryArn },
      ":registryId": { S: transition.cleanup.registryId },
      ":requestId": { S: transition.requestId },
      ":resultSize": { N: "5" },
      ":route": { S: transition.route },
    },
  });
});

test("domain cleanup completion binds the exact nested managed owner group", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const cleanup = cleaningOwnedDomainCleanup();

  await state.markDomainRequestCleanupComplete({
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    cleanup,
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
  });

  const input = dynamo.commands[0].input;
  assert.match(
    input.ConditionExpression,
    /size\(#result\.#cleanup\.#ownerGroup\) = :ownerGroupSize/,
  );
  assert.match(
    input.ConditionExpression,
    /#result\.#cleanup\.#ownerGroup\.#ownerGroupName = :ownerGroupName/,
  );
  assert.match(
    input.ConditionExpression,
    /#result\.#cleanup\.#ownerGroup\.#operationToken = :operationToken/,
  );
  assert.equal(input.ExpressionAttributeNames["#ownerGroup"], "ownerGroup");
  assert.equal(
    input.ExpressionAttributeNames["#ownerGroupName"],
    "name",
  );
  assert.equal(
    input.ExpressionAttributeNames["#operationToken"],
    "operationToken",
  );
  assert.deepEqual(
    input.ExpressionAttributeValues[":ownerGroupName"],
    { S: "domain-customer-support" },
  );
  assert.deepEqual(
    input.ExpressionAttributeValues[":operationToken"],
    { S: GROUP_OPERATION_TOKEN },
  );
  assert.deepEqual(
    input.ExpressionAttributeValues[":ownerGroupSize"],
    { N: "2" },
  );
  assert.deepEqual(
    input.ExpressionAttributeValues[":cleanupSize"],
    { N: "6" },
  );
});

test("domain cleanup completion rejects well-formed changed ownership", async () => {
  const foreignOwnership = [
    {
      name: "domain-operations",
      operationToken: GROUP_OPERATION_TOKEN,
    },
    {
      name: "domain-customer-support",
      operationToken: OPERATIONS_GROUP_OPERATION_TOKEN,
    },
    {
      name: "domain-customer-support",
      operationToken: OTHER_REQUEST_GROUP_OPERATION_TOKEN,
    },
  ];

  for (const ownerGroup of foreignOwnership) {
    const dynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo,
        now: () => NOW,
      }).markDomainRequestCleanupComplete({
        actor: "admin-sub-123",
        route: "POST /api/domain-create",
        requestId: "request-123",
        payloadFingerprint: PAYLOAD_FINGERPRINT,
        cleanup: cleaningOwnedDomainCleanup({ ownerGroup }),
        expiresAt: NOW_EPOCH + 86_400,
        createdAt: NOW,
      }),
      (error) => error?.code === "INVALID_REQUEST_RESULT",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("domain cleanup transitions reject malformed or changed targets before DynamoDB", async () => {
  const invalidFenceTargets = [
    {
      registryId: "FinanceReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/ChangedReg123",
    },
    {
      registryId: "FinanceReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/FinanceReg1234",
      extra: "unsafe",
    },
    {
      registryId: "FinanceReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/FinanceReg1234",
      ownerGroup: "platform-admin",
    },
    {
      registryId: "FinanceReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/FinanceReg1234",
      ownerGroup: "domain-finance",
    },
    {
      registryId: "FinanceReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/FinanceReg1234",
      ownerGroup: {
        name: "domain-finance",
        operationToken: "A".repeat(64),
      },
    },
    {
      registryId: "FinanceReg1234",
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/FinanceReg1234",
      ownerGroup: {
        name: "domain-finance",
        operationToken: GROUP_OPERATION_TOKEN,
        requestId: "request-123",
      },
    },
  ];
  for (const cleanup of invalidFenceTargets) {
    const dynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo,
        now: () => NOW,
      }).markDomainRequestConflict({
        ...domainRequestClaim(),
        cleanup,
      }),
      (error) => error?.code === "INVALID_REQUEST_RESULT",
    );
    assert.equal(dynamo.commands.length, 0);
  }

  const dynamo = recordingDynamo();
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo,
      now: () => NOW,
    }).markDomainRequestCleanupComplete({
      actor: "admin-sub-123",
      route: "POST /api/domain-create",
      requestId: "request-123",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      cleanup: domainCleanup({
        registryId: "ChangedReg1234",
      }),
      expiresAt: NOW_EPOCH + 86_400,
      createdAt: NOW,
    }),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("domain cleanup completion maps only a conditional target race to request claim conflict", async () => {
  const conditional = new ConditionalCheckFailedException({
    $metadata: {},
    message: "cleanup target changed",
  });
  const transition = {
    actor: "admin-sub-123",
    route: "POST /api/domain-create",
    requestId: "request-123",
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    cleanup: cleaningDomainCleanup(),
    expiresAt: NOW_EPOCH + 86_400,
    createdAt: NOW,
  };

  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([conditional]),
      now: () => NOW,
    }).markDomainRequestCleanupComplete(transition),
    (error) =>
      error?.code === "REQUEST_CLAIM_CONFLICT"
      && error?.name === "RequestClaimConflictError",
  );

  const unrelated = new Error("network failure");
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([unrelated]),
      now: () => NOW,
    }).markDomainRequestCleanupComplete(transition),
    (error) => error === unrelated,
  );
});

test("domain conflict fence maps only conditional PutItem failure to request claim conflict", async () => {
  const conditional = new ConditionalCheckFailedException({
    $metadata: {},
    message: "claim changed",
  });
  const transition = {
    ...domainRequestClaim(),
    cleanup: {
      registryId: domainCleanup().registryId,
      registryArn: domainCleanup().registryArn,
    },
  };

  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([conditional]),
      now: () => NOW,
    }).markDomainRequestConflict(transition),
    (error) =>
      error?.code === "REQUEST_CLAIM_CONFLICT"
      && error?.name === "RequestClaimConflictError",
  );

  const unrelated = new Error("network failure");
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([unrelated]),
      now: () => NOW,
    }).markDomainRequestConflict(transition),
    (error) => error === unrelated,
  );
});

test("putDomainWithRequestResult atomically replaces the matching claim with success", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const storedDomain = {
    ...domain(),
    status: "ACTIVE",
    createdAt: NOW,
  };
  const requestResult = atomicRequestResult(storedDomain);

  assert.deepEqual(
    await state.putDomainWithRequestResult({
      domain: storedDomain,
      requestResult,
      claim: {
        payloadFingerprint: PAYLOAD_FINGERPRINT,
        ownerToken: OWNER_TOKEN,
      },
    }),
    {
      domain: storedDomain,
      requestResult,
    },
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TransactItems: [
      {
        Put: {
          TableName: TABLE_NAME,
          Item: domainItem(storedDomain),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      },
      {
        Put: {
          TableName: TABLE_NAME,
          Item: atomicRequestResultItem(requestResult),
          ConditionExpression:
            "#result.#kind = :kind "
            + "AND #result.#status = :inProgress "
            + "AND #result.#payloadFingerprint = :payloadFingerprint "
            + "AND #result.#ownerToken = :ownerToken",
          ExpressionAttributeNames: {
            "#kind": "kind",
            "#ownerToken": "ownerToken",
            "#payloadFingerprint": "payloadFingerprint",
            "#result": "result",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":inProgress": { S: "IN_PROGRESS" },
            ":kind": { S: "DOMAIN_CREATE" },
            ":ownerToken": { S: OWNER_TOKEN },
            ":payloadFingerprint": { S: PAYLOAD_FINGERPRINT },
          },
        },
      },
    ],
  });
});

test("generic expiring request claims reject Registry governance state", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const claim = registryRequestClaim();

  await assert.rejects(
    state.claimRequest(claim),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("Registry target binding atomically persists exact AWS IDs and claims the authoritative record", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const claim = registryTargetClaim();

  assert.deepEqual(await state.claimRegistryDecisionTarget(claim), {
    actor: claim.actor,
    route: claim.route,
    requestId: claim.requestId,
    result: {
      kind: REGISTRY_KIND,
      status: "IN_PROGRESS",
      phase: "TARGET_BOUND",
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      ownerToken: OWNER_TOKEN,
      claimExpiresAt: NOW_EPOCH + 300,
      attemptCount: 0,
      retryAfter: 0,
      target: registryDecisionTarget(),
    },
    createdAt: NOW,
  });
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  const [requestWrite, resourceWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(
    requestWrite.Put.Item.result.M.target,
    nativeResultValue(registryDecisionTarget()),
  );
  assert.equal(Object.hasOwn(requestWrite.Put.Item, "expiresAt"), false);
  assert.equal(
    requestWrite.Put.ConditionExpression,
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );
  assert.deepEqual(resourceWrite.Put.Item, {
    pk: { S: `REGISTRY_RECORD#${REGISTRY_ID}` },
    sk: {
      S: `RECORD#${REGISTRY_RECORD_ID}#VERSION#${REGISTRY_SEMVER}`,
    },
    entityType: { S: "REGISTRY_DECISION_CLAIM" },
    registryId: { S: REGISTRY_ID },
    recordId: { S: REGISTRY_RECORD_ID },
    semver: { S: REGISTRY_SEMVER },
    actor: { S: claim.actor },
    route: { S: claim.route },
    requestId: { S: claim.requestId },
    kind: { S: REGISTRY_KIND },
    payloadFingerprint: { S: PAYLOAD_FINGERPRINT },
    ownerToken: { S: OWNER_TOKEN },
    targetStatus: { S: "APPROVED" },
    statusReasonHash: { S: STATUS_REASON_HASH },
    phase: { S: "TARGET_BOUND" },
    attemptCount: { N: "0" },
    retryAfter: { N: "0" },
    createdAt: { S: NOW },
  });
  assert.equal(
    resourceWrite.Put.ConditionExpression,
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );
});

test("Registry target binding distinguishes request and authoritative-record claim conflicts", async () => {
  for (const [CancellationReasons, code] of [
    [[
      { Code: "ConditionalCheckFailed" },
      { Code: "None" },
    ], "REQUEST_CLAIM_CONFLICT"],
    [[
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ], "REGISTRY_RESOURCE_CONFLICT"],
  ]) {
    const cancellation = new TransactionCanceledException({
      $metadata: {},
      message: "claim conflict",
      CancellationReasons,
    });
    const state = createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([cancellation]),
      now: () => NOW,
    });

    await assert.rejects(
      state.claimRegistryDecisionTarget(registryTargetClaim()),
      (error) => error?.code === code,
    );
  }
});

test("Registry record locks are scoped to the exact semver revision", async () => {
  const dynamo = recordingDynamo([{}, {}]);
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  await state.claimRegistryDecisionTarget(registryTargetClaim());
  await state.claimRegistryDecisionTarget(registryTargetClaim({
    requestId: "registry-request-456",
    target: registryDecisionTarget({ semver: "2.0.0" }),
  }));

  const lockKeys = dynamo.commands.map((command) =>
    command.input.TransactItems[1].Put.Item.sk.S
  );
  assert.deepEqual(lockKeys, [
    `RECORD#${REGISTRY_RECORD_ID}#VERSION#1.0.0`,
    `RECORD#${REGISTRY_RECORD_ID}#VERSION#2.0.0`,
  ]);
});

test("Registry mutation-attempt transition atomically validates request and record ownership", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const claim = registryTargetClaim();

  assert.deepEqual(
    await state.markRegistryDecisionMutationAttempted(claim),
    {
      actor: claim.actor,
      route: claim.route,
      requestId: claim.requestId,
      result: {
        kind: REGISTRY_KIND,
        status: "IN_PROGRESS",
        phase: "MUTATION_ATTEMPTED",
        payloadFingerprint: PAYLOAD_FINGERPRINT,
        ownerToken: OWNER_TOKEN,
        claimExpiresAt: NOW_EPOCH + 300,
        attemptCount: 1,
        retryAfter: 0,
        target: registryDecisionTarget(),
      },
      createdAt: NOW,
    },
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  const [requestWrite, resourceWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(
    requestWrite.Put.Item.result.M.phase,
    { S: "MUTATION_ATTEMPTED" },
  );
  assert.match(
    requestWrite.Put.ConditionExpression,
    /#phase = :expectedPhase/,
  );
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":expectedPhase"],
    { S: "TARGET_BOUND" },
  );
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":registryId"],
    { S: REGISTRY_ID },
  );
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":recordId"],
    { S: REGISTRY_RECORD_ID },
  );
  assert.deepEqual(
    resourceWrite.Put.Item.phase,
    { S: "MUTATION_ATTEMPTED" },
  );
  assert.match(
    resourceWrite.Put.ConditionExpression,
    /#phase = :expectedPhase/,
  );
  assert.deepEqual(
    resourceWrite.Put.ExpressionAttributeValues[":ownerToken"],
    { S: OWNER_TOKEN },
  );
});

test("Registry mutation-attempt transition classifies request and record ownership loss", async () => {
  for (const [CancellationReasons, code] of [
    [[
      { Code: "ConditionalCheckFailed" },
      { Code: "None" },
    ], "REQUEST_CLAIM_CONFLICT"],
    [[
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ], "REGISTRY_RESOURCE_CONFLICT"],
  ]) {
    const cancellation = new TransactionCanceledException({
      $metadata: {},
      message: "phase conflict",
      CancellationReasons,
    });
    const state = createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([cancellation]),
      now: () => NOW,
    });

    await assert.rejects(
      state.markRegistryDecisionMutationAttempted(
        registryTargetClaim(),
      ),
      (error) => error?.code === code,
    );
  }
});

test("Registry mutation-attempt transition honors the durable record owner after the short claim lease expires", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  assert.equal(
    (await state.markRegistryDecisionMutationAttempted(
      registryTargetClaim({
        claimExpiresAt: NOW_EPOCH - 1,
      }),
    )).result.phase,
    "MUTATION_ATTEMPTED",
  );
  assert.equal(dynamo.commands.length, 1);
});

test("Registry retryable transition atomically preserves ownership while writing future backoff", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const retryAfter = NOW_EPOCH + 30;
  const claim = registryTargetClaim({
    phase: "MUTATION_ATTEMPTED",
    attemptCount: 1,
    retryAfter,
  });

  assert.equal(
    (await state.markRegistryDecisionRetryable(claim)).result.phase,
    "RETRYABLE",
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  const [requestWrite, resourceWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(requestWrite.Put.Item.result.M.retryAfter, {
    N: String(retryAfter),
  });
  assert.deepEqual(resourceWrite.Put.Item.retryAfter, {
    N: String(retryAfter),
  });
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":retryAfter"],
    { N: "0" },
  );
  assert.deepEqual(
    resourceWrite.Put.ExpressionAttributeValues[":retryAfter"],
    { N: "0" },
  );
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":ownerToken"],
    { S: OWNER_TOKEN },
  );
  assert.deepEqual(
    resourceWrite.Put.ExpressionAttributeValues[":ownerToken"],
    { S: OWNER_TOKEN },
  );
});

test("Registry retryable transition recycles an exhausted same-owner window after a durable cooldown", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const retryAfter = NOW_EPOCH + 300;
  const claim = registryTargetClaim({
    phase: "MUTATION_ATTEMPTED",
    attemptCount: 3,
    retryAfter,
  });

  const result = await state.markRegistryDecisionRetryable(claim);

  assert.equal(result.result.phase, "RETRYABLE");
  assert.equal(result.result.attemptCount, 0);
  assert.equal(result.result.retryAfter, retryAfter);
  const [requestWrite, resourceWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(requestWrite.Put.Item.result.M.attemptCount, {
    N: "0",
  });
  assert.deepEqual(resourceWrite.Put.Item.attemptCount, { N: "0" });
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":attemptCount"],
    { N: "3" },
  );
  assert.deepEqual(
    resourceWrite.Put.ExpressionAttributeValues[":attemptCount"],
    { N: "3" },
  );
});

test("Registry retryable transition classifies request and record ownership loss", async () => {
  for (const [CancellationReasons, code] of [
    [[
      { Code: "ConditionalCheckFailed" },
      { Code: "None" },
    ], "REQUEST_CLAIM_CONFLICT"],
    [[
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ], "REGISTRY_RESOURCE_CONFLICT"],
  ]) {
    const cancellation = new TransactionCanceledException({
      $metadata: {},
      message: "retry phase conflict",
      CancellationReasons,
    });
    const state = createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([cancellation]),
      now: () => NOW,
    });

    await assert.rejects(
      state.markRegistryDecisionRetryable(registryTargetClaim({
        phase: "MUTATION_ATTEMPTED",
        attemptCount: 1,
        retryAfter: NOW_EPOCH + 30,
      })),
      (error) => error?.code === code,
    );
  }
});

test("Registry decision finalization atomically writes audit, success, and the terminal record lock", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const resource =
    `registry/${REGISTRY_ID}/record/${REGISTRY_RECORD_ID}`
    + `/version/${REGISTRY_SEMVER}`;
  const audit = registryAudit({ resource });
  const requestResult = registryFinalRequestResult();
  const claim = {
    kind: REGISTRY_KIND,
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    ownerToken: OWNER_TOKEN,
    attemptCount: 1,
    target: registryDecisionTarget(),
  };

  assert.deepEqual(
    await state.putRegistryDecisionAuditWithRequestResult({
      audit,
      requestResult,
      claim,
    }),
    { audit, requestResult },
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  const [auditWrite, requestWrite, resourceWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(auditWrite.Put.Item.resource, { S: resource });
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":expectedPhase"],
    { S: "MUTATION_ATTEMPTED" },
  );
  assert.deepEqual(resourceWrite.Put.Item, {
    pk: { S: `REGISTRY_RECORD#${REGISTRY_ID}` },
    sk: {
      S: `RECORD#${REGISTRY_RECORD_ID}#VERSION#${REGISTRY_SEMVER}`,
    },
    entityType: { S: "REGISTRY_DECISION_CLAIM" },
    registryId: { S: REGISTRY_ID },
    recordId: { S: REGISTRY_RECORD_ID },
    semver: { S: REGISTRY_SEMVER },
    actor: { S: "admin-sub-123" },
    route: { S: REGISTRY_ROUTE },
    requestId: { S: "registry-request-123" },
    kind: { S: REGISTRY_KIND },
    payloadFingerprint: { S: PAYLOAD_FINGERPRINT },
    ownerToken: { S: OWNER_TOKEN },
    targetStatus: { S: "APPROVED" },
    statusReasonHash: { S: STATUS_REASON_HASH },
    phase: { S: "SUCCEEDED" },
    attemptCount: { N: "1" },
    retryAfter: { N: "0" },
    createdAt: { S: NOW },
  });
  assert.deepEqual(
    resourceWrite.Put.ExpressionAttributeValues[":expectedPhase"],
    { S: "MUTATION_ATTEMPTED" },
  );
});

test("Registry decision finalization rejects target and immutable-evidence mismatches", async () => {
  const valid = {
    audit: registryAudit({
      resource:
        `registry/${REGISTRY_ID}/record/${REGISTRY_RECORD_ID}`
        + `/version/${REGISTRY_SEMVER}`,
    }),
    requestResult: registryFinalRequestResult(),
    claim: {
      kind: REGISTRY_KIND,
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      ownerToken: OWNER_TOKEN,
      attemptCount: 1,
      target: registryDecisionTarget(),
    },
  };
  const cases = [
    (() => {
      const value = structuredClone(valid);
      value.audit.resource =
        "registry/OtherReg12345/record/Rec123456789";
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.requestResult.result.resource =
        "registry/OtherReg12345/record/Rec123456789";
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.requestResult.result.version._aws.recordId = "Mov123456789";
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.requestResult.result.version.status = "REJECTED";
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.claim.target.statusReasonHash = "b".repeat(64);
      return value;
    })(),
  ];

  for (const value of cases) {
    const dynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo,
        now: () => NOW,
      }).putRegistryDecisionAuditWithRequestResult(value),
      (error) => error?.code === "INVALID_REQUEST_RESULT",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("Registry decision finalization classifies audit, request, and record-lock conflicts", async () => {
  const input = {
    audit: registryAudit({
      resource:
        `registry/${REGISTRY_ID}/record/${REGISTRY_RECORD_ID}`
        + `/version/${REGISTRY_SEMVER}`,
    }),
    requestResult: registryFinalRequestResult(),
    claim: {
      kind: REGISTRY_KIND,
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      ownerToken: OWNER_TOKEN,
      attemptCount: 1,
      target: registryDecisionTarget(),
    },
  };
  for (const [CancellationReasons, code] of [
    [[
      { Code: "ConditionalCheckFailed" },
      { Code: "None" },
      { Code: "None" },
    ], "AUDIT_CONFLICT"],
    [[
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
      { Code: "None" },
    ], "REQUEST_CLAIM_CONFLICT"],
    [[
      { Code: "None" },
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ], "REGISTRY_RESOURCE_CONFLICT"],
  ]) {
    const cancellation = new TransactionCanceledException({
      $metadata: {},
      message: "finalization conflict",
      CancellationReasons,
    });
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: recordingDynamo([cancellation]),
        now: () => NOW,
      }).putRegistryDecisionAuditWithRequestResult(input),
      (error) => error?.code === code,
    );
  }
});

test("Registry audit replay atomically finalizes the request and original record lock", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const requestResult = registryFinalRequestResult();
  const claim = {
    kind: REGISTRY_KIND,
    payloadFingerprint: PAYLOAD_FINGERPRINT,
    ownerToken: OWNER_TOKEN,
    attemptCount: 1,
    target: registryDecisionTarget(),
  };

  assert.deepEqual(
    await state.putRegistryDecisionResultForAuditReplay({
      requestResult,
      claim,
    }),
    requestResult,
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  const [requestWrite, resourceWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(
    requestWrite.Put.ExpressionAttributeValues[":expectedPhase"],
    { S: "MUTATION_ATTEMPTED" },
  );
  assert.deepEqual(resourceWrite.Put.Item.phase, { S: "SUCCEEDED" });
  assert.deepEqual(
    resourceWrite.Put.Item.registryId,
    { S: REGISTRY_ID },
  );
  assert.deepEqual(
    resourceWrite.Put.Item.recordId,
    { S: REGISTRY_RECORD_ID },
  );
});

test("Registry audit replay classifies request and record-lock ownership loss", async () => {
  const input = {
    requestResult: registryFinalRequestResult(),
    claim: {
      kind: REGISTRY_KIND,
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      ownerToken: OWNER_TOKEN,
      attemptCount: 1,
      target: registryDecisionTarget(),
    },
  };
  for (const [CancellationReasons, code] of [
    [[
      { Code: "ConditionalCheckFailed" },
      { Code: "None" },
    ], "REQUEST_CLAIM_CONFLICT"],
    [[
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ], "REGISTRY_RESOURCE_CONFLICT"],
  ]) {
    const cancellation = new TransactionCanceledException({
      $metadata: {},
      message: "replay conflict",
      CancellationReasons,
    });
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: recordingDynamo([cancellation]),
        now: () => NOW,
      }).putRegistryDecisionResultForAuditReplay(input),
      (error) => error?.code === code,
    );
  }
});

test("generic expiring audit transactions reject Registry governance results", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const audit = registryAudit();
  const requestResult = registryRequestResult({
    expiresAt: NOW_EPOCH + 86_400,
  });

  await assert.rejects(
    state.putAuditWithRequestResult({
      audit,
      requestResult,
      claim: {
        kind: REGISTRY_KIND,
        payloadFingerprint: PAYLOAD_FINGERPRINT,
        ownerToken: OWNER_TOKEN,
      },
    }),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("generic expiring retry transitions reject Registry governance claims", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const claim = registryRequestClaim();

  await assert.rejects(
    state.markRequestRetryable(claim),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("getAudit reads and validates exact immutable Registry decision evidence", async () => {
  const audit = registryAudit();
  const dynamo = recordingDynamo([{
    Item: {
      pk: { S: "AUDIT#2026-08" },
      sk: { S: `${NOW}#${ACTOR_HASH}#registry-request-123` },
      entityType: { S: "AUDIT" },
      actor: { S: audit.actor },
      action: { S: audit.action },
      resource: { S: audit.resource },
      decision: { S: audit.decision },
      reason: { S: audit.reason },
      requestId: { S: audit.requestId },
      timestamp: { S: audit.timestamp },
    },
  }]);
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  assert.deepEqual(await state.getAudit({
    actor: "admin-sub-123",
    timestamp: NOW,
    requestId: "registry-request-123",
  }), audit);
  assert.ok(dynamo.commands[0] instanceof GetItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Key: {
      pk: { S: "AUDIT#2026-08" },
      sk: { S: `${NOW}#${ACTOR_HASH}#registry-request-123` },
    },
    ConsistentRead: true,
  });
});

test("generic expiring audit replay rejects Registry governance results", async () => {
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const requestResult = registryRequestResult({
    expiresAt: NOW_EPOCH + 86_400,
  });

  await assert.rejects(
    state.putRequestResultForAuditReplay({
      requestResult,
      claim: {
        kind: REGISTRY_KIND,
        payloadFingerprint: PAYLOAD_FINGERPRINT,
        ownerToken: OWNER_TOKEN,
      },
    }),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("atomic domain creation classifies only conditional transaction cancellation as conflict", async () => {
  const input = {
    domain: {
      ...domain(),
      status: "ACTIVE",
      createdAt: NOW,
    },
    requestResult: atomicRequestResult(),
    claim: {
      payloadFingerprint: PAYLOAD_FINGERPRINT,
      ownerToken: OWNER_TOKEN,
    },
  };
  for (const [CancellationReasons, code] of [
    [[
      { Code: "ConditionalCheckFailed" },
      { Code: "None" },
    ], "DOMAIN_CONFLICT"],
    [[
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ], "REQUEST_CLAIM_CONFLICT"],
  ]) {
    const cancellation = new TransactionCanceledException({
      $metadata: {},
      message: "transaction conflict",
      CancellationReasons,
    });
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: recordingDynamo([cancellation]),
        now: () => NOW,
      }).putDomainWithRequestResult(input),
      (error) =>
        error?.code === code,
    );
  }

  const unrelated = new Error("network failure");
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([unrelated]),
      now: () => NOW,
    }).putDomainWithRequestResult(input),
    (error) => error === unrelated,
  );
});

test("generated timestamps accept Date clocks and normalize once per write", async () => {
  const cases = [
    {
      field: "createdAt",
      invoke: (state) => state.putDomain(domain()),
    },
    {
      field: "createdAt",
      invoke: (state) => state.putRequestResult({
        actor: "user-1234",
        route: "POST /api/domains",
        requestId: "request-clock",
        result: { ok: true },
        expiresAt: 1787533323,
      }),
    },
    {
      field: "timestamp",
      invoke: (state) => state.appendAudit({
        actor: "user-1234",
        action: "domain.create",
        resource: "domain/customer_support",
        decision: "allowed",
        reason: "Platform administrator approved the request.",
        requestId: "request-clock",
      }),
    },
  ];

  for (const { field, invoke } of cases) {
    let clockCalls = 0;
    const dynamo = recordingDynamo();
    const state = createPlatformState({
      tableName: TABLE_NAME,
      dynamo,
      now: () => {
        clockCalls += 1;
        return new Date(NOW);
      },
    });

    const result = await invoke(state);

    assert.equal(clockCalls, 1);
    assert.equal(result[field], NOW);
    assert.deepEqual(dynamo.commands[0].input.Item[field], { S: NOW });
  }
});

test("generated timestamps reject invalid Date and malformed clock values", async () => {
  const operations = [
    {
      code: "INVALID_DOMAIN",
      invoke: (state) => state.putDomain(domain()),
    },
    {
      code: "INVALID_REQUEST_RESULT",
      invoke: (state) => state.putRequestResult({
        actor: "user-1234",
        route: "POST /api/domains",
        requestId: "request-invalid-clock",
        result: { ok: true },
        expiresAt: 1787533323,
      }),
    },
    {
      code: "INVALID_AUDIT",
      invoke: (state) => state.appendAudit({
        actor: "user-1234",
        action: "domain.create",
        resource: "domain/customer_support",
        decision: "allowed",
        reason: "Platform administrator approved the request.",
        requestId: "request-invalid-clock",
      }),
    },
  ];

  for (const clockValue of [
    new Date("invalid"),
    "2026-08-23",
    {},
  ]) {
    for (const { code, invoke } of operations) {
      const dynamo = recordingDynamo();
      await assert.rejects(
        invoke(createPlatformState({
          tableName: TABLE_NAME,
          dynamo,
          now: () => clockValue,
        })),
        (error) => error?.code === code,
      );
      assert.equal(dynamo.commands.length, 0);
    }
  }
});

test("domain validation supports null budgets and rejects unsafe shapes", async () => {
  const nullBudgetDynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo: nullBudgetDynamo,
    now: () => NOW,
  });
  await state.putDomain(domain({
    id: "platform",
    name: "Platform",
    ownerGroup: "domain-platform",
    tokenBudget: null,
    registryId: "PlatformReg1234",
    registryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/PlatformReg1234",
  }));
  assert.deepEqual(
    nullBudgetDynamo.commands[0].input.Item.tokenBudget,
    { NULL: true },
  );

  const activeDynamo = recordingDynamo();
  await createPlatformState({
    tableName: TABLE_NAME,
    dynamo: activeDynamo,
    now: () => NOW,
  }).putDomain(domain({ status: "ACTIVE" }));
  assert.deepEqual(
    activeDynamo.commands[0].input.Item.status,
    { S: "ACTIVE" },
  );

  const invalidDomains = [
    domain({ id: "customer-support" }),
    domain({ ownerGroup: "idp-group:customer-support-builders" }),
    domain({ ownerGroup: "domain-Customer-Support" }),
    domain({ ownerGroup: "domain-operations" }),
    domain({ tokenBudget: 0 }),
    domain({ tokenBudget: -1 }),
    domain({ tokenBudget: 1.5 }),
    domain({ tokenBudget: "24000" }),
    domain({ registryId: "short" }),
    domain({
      registryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/OperationsReg12",
    }),
    domain({ registryArn: "arn:aws:agent-registry:bad" }),
    domain({
      registryArn:
        "arn:aws-cn:agent-registry:cn-north-1:111122223333:"
        + "registry/CustomerReg1234",
    }),
    domain({
      registryArn:
        "arn:aws-us-gov:agent-registry:us-gov-west-1:111122223333:"
        + "registry/CustomerReg1234",
    }),
    domain({
      registryArn:
        "arn:aws:agent-registry:us-iso-east-1:111122223333:"
        + "registry/CustomerReg1234",
    }),
    domain({
      registryArn:
        "arn:aws:agent-registry:eu-isoe-west-1:111122223333:"
        + "registry/CustomerReg1234",
    }),
    domain({
      registryArn:
        "arn:aws:agent-registry:eusc-de-east-1:111122223333:"
        + "registry/CustomerReg1234",
    }),
    domain({ status: "active" }),
    domain({ status: "pending" }),
    domain({ createdAt: "2026-08-23" }),
    domain({ agents: [] }),
    { ...domain(), owner: undefined },
  ];

  for (const invalid of invalidDomains) {
    const isolatedDynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: isolatedDynamo,
        now: () => NOW,
      }).putDomain(invalid),
      (error) => error?.code === "INVALID_DOMAIN",
    );
    assert.equal(isolatedDynamo.commands.length, 0);
  }
});

test("putDomain classifies only the real conditional exception as conflict", async () => {
  const conditional = new ConditionalCheckFailedException({
    $metadata: {},
    message: "already exists",
  });
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([conditional]),
      now: () => NOW,
    }).putDomain(domain()),
    (error) =>
      error?.code === "DOMAIN_CONFLICT"
      && error?.message === "Domain already exists.",
  );

  const unrelated = new Error("network failure");
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([unrelated]),
      now: () => NOW,
    }).putDomain(domain()),
    (error) => error === unrelated,
  );

  const imposter = Object.assign(new Error("not an SDK exception"), {
    name: "ConditionalCheckFailedException",
  });
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([imposter]),
      now: () => NOW,
    }).putDomain(domain()),
    (error) => error === imposter,
  );

  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([null]),
      now: () => NOW,
    }).putDomain(domain()),
    (error) => error?.code === "MALFORMED_DYNAMODB_RESPONSE",
  );
});

test("listDomains queries every domain page and returns deterministic order", async () => {
  const platform = domain({
    id: "platform",
    name: "Platform",
    owner: "Platform team",
    ownerGroup: "domain-platform",
    tokenBudget: null,
    registryId: "PlatformReg1234",
    registryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/PlatformReg1234",
  });
  const operations = domain({
    id: "operations",
    name: "Operations",
    owner: "Operations team",
    ownerGroup: "domain-operations",
    tokenBudget: null,
    registryId: "OperatioReg1234",
    registryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/OperatioReg1234",
  });
  const lastKey = {
    pk: { S: "DOMAIN" },
    sk: { S: "DOMAIN#platform" },
  };
  const dynamo = recordingDynamo([
    { Items: [domainItem(platform)], LastEvaluatedKey: lastKey },
    { Items: [domainItem(operations)] },
  ]);

  const result = await createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  }).listDomains();

  assert.deepEqual(result.map(({ id }) => id), ["operations", "platform"]);
  assert.equal(dynamo.commands.length, 2);
  assert.ok(dynamo.commands.every((command) => command instanceof QueryCommand));
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: { "#pk": "pk" },
    ExpressionAttributeValues: { ":pk": { S: "DOMAIN" } },
    ConsistentRead: true,
    ScanIndexForward: true,
  });
  assert.deepEqual(dynamo.commands[1].input, {
    ...dynamo.commands[0].input,
    ExclusiveStartKey: lastKey,
  });
});

test("listDomains fails closed on malformed pages, keys, and stored items", async () => {
  const validItem = domainItem();
  const malformedResponses = [
    null,
    { Items: {} },
    { Items: [], LastEvaluatedKey: {} },
    {
      Items: [],
      LastEvaluatedKey: {
        pk: { S: "OTHER" },
        sk: { S: "DOMAIN#customer_support" },
      },
    },
    {
      Items: [{ ...validItem, pk: { S: "OTHER" } }],
    },
    {
      Items: [{ ...validItem, sk: { S: "DOMAIN#operations" } }],
    },
    {
      Items: [{ ...validItem, status: { S: "active" } }],
    },
    {
      Items: [{ ...validItem, extra: { S: "unsafe" } }],
    },
    {
      Items: [{
        ...validItem,
        tokenBudget: { N: "24000.5" },
      }],
    },
    {
      Items: [validItem, structuredClone(validItem)],
    },
  ];

  for (const response of malformedResponses) {
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: recordingDynamo([response]),
        now: () => NOW,
      }).listDomains(),
      (error) => error?.code === "MALFORMED_DYNAMODB_RESPONSE",
    );
  }
});

test("listDomains forwards one abort signal across every DynamoDB page", async () => {
  const abortSignal = new AbortController().signal;
  const lastKey = {
    pk: { S: "DOMAIN" },
    sk: { S: "DOMAIN#customer_support" },
  };
  const dynamo = recordingDynamo([
    { Items: [], LastEvaluatedKey: lastKey },
    { Items: [] },
  ]);

  await createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  }).listDomains({ abortSignal });

  assert.equal(dynamo.commands.length, 2);
  assert.deepEqual(dynamo.options, [
    { abortSignal },
    { abortSignal },
  ]);
});

test("listDomains rejects malformed read options before DynamoDB", async () => {
  const abortSignal = new AbortController().signal;
  for (const options of [
    null,
    [],
    {},
    { abortSignal: null },
    { abortSignal, extra: true },
  ]) {
    const dynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo,
        now: () => NOW,
      }).listDomains(options),
      (error) =>
        error?.code === "INVALID_DOMAIN_READ_OPTIONS"
        && error.message === "Domain read options are malformed.",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("getDomain validates the key, response, and stored domain shape", async () => {
  const dynamo = recordingDynamo([{ Item: domainItem() }]);
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  assert.deepEqual(await state.getDomain("customer_support"), {
    ...domain(),
    status: "ACTIVE",
    createdAt: NOW,
  });
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof GetItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Key: {
      pk: { S: "DOMAIN" },
      sk: { S: "DOMAIN#customer_support" },
    },
    ConsistentRead: true,
  });

  assert.equal(
    await createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([{}]),
      now: () => NOW,
    }).getDomain("customer_support"),
    null,
  );

  const invalidIdDynamo = recordingDynamo();
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: invalidIdDynamo,
      now: () => NOW,
    }).getDomain("customer-support"),
    (error) => error?.code === "INVALID_DOMAIN_ID",
  );
  assert.equal(invalidIdDynamo.commands.length, 0);

  for (const response of [
    null,
    { Item: { ...domainItem(), extra: { S: "unsafe" } } },
    {
      Item: {
        ...domainItem(),
        ownerGroup: { S: "domain-operations" },
      },
    },
  ]) {
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: recordingDynamo([response]),
        now: () => NOW,
      }).getDomain("customer_support"),
      (error) => error?.code === "MALFORMED_DYNAMODB_RESPONSE",
    );
  }
});

test("getDomain forwards its abort signal to DynamoDB", async () => {
  const abortSignal = new AbortController().signal;
  const dynamo = recordingDynamo([{}]);

  await createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  }).getDomain("customer_support", { abortSignal });

  assert.equal(dynamo.commands.length, 1);
  assert.deepEqual(dynamo.options, [{ abortSignal }]);
});

test("getDomain rejects malformed read options before DynamoDB", async () => {
  const abortSignal = new AbortController().signal;
  for (const options of [
    null,
    [],
    {},
    { abortSignal: null },
    { abortSignal, extra: true },
  ]) {
    const dynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo,
        now: () => NOW,
      }).getDomain("customer_support", options),
      (error) =>
        error?.code === "INVALID_DOMAIN_READ_OPTIONS"
        && error.message === "Domain read options are malformed.",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("request results use native attributes and preserve the first result", async () => {
  const request = {
    actor: "user-1234",
    route: "POST /api/domains",
    requestId: "request-1234",
    result: {
      ok: true,
      domain: { id: "customer_support", version: 1 },
      warnings: ["review-owner", null],
    },
    expiresAt: 1787533323,
  };
  const dynamo = recordingDynamo([{}, {
    Item: {
      pk: { S: "REQUEST#user-1234" },
      sk: { S: "REQUEST#POST /api/domains#request-1234" },
      entityType: { S: "REQUEST_RESULT" },
      actor: { S: "user-1234" },
      route: { S: "POST /api/domains" },
      requestId: { S: "request-1234" },
      result: {
        M: {
          ok: { BOOL: true },
          domain: {
            M: {
              id: { S: "customer_support" },
              version: { N: "1" },
            },
          },
          warnings: {
            L: [
              { S: "review-owner" },
              { NULL: true },
            ],
          },
        },
      },
      expiresAt: { N: "1787533323" },
      createdAt: { S: NOW },
    },
  }]);
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  assert.deepEqual(await state.putRequestResult(request), {
    ...request,
    createdAt: NOW,
  });
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: {
      pk: { S: "REQUEST#user-1234" },
      sk: { S: "REQUEST#POST /api/domains#request-1234" },
      entityType: { S: "REQUEST_RESULT" },
      actor: { S: "user-1234" },
      route: { S: "POST /api/domains" },
      requestId: { S: "request-1234" },
      result: {
        M: {
          ok: { BOOL: true },
          domain: {
            M: {
              id: { S: "customer_support" },
              version: { N: "1" },
            },
          },
          warnings: {
            L: [
              { S: "review-owner" },
              { NULL: true },
            ],
          },
        },
      },
      expiresAt: { N: "1787533323" },
      createdAt: { S: NOW },
    },
    ConditionExpression:
      "(attribute_not_exists(#pk) AND attribute_not_exists(#sk)) "
      + "OR #expiresAt <= :now",
    ExpressionAttributeNames: {
      "#expiresAt": "expiresAt",
      "#pk": "pk",
      "#sk": "sk",
    },
    ExpressionAttributeValues: {
      ":now": { N: String(Math.floor(Date.parse(NOW) / 1000)) },
    },
  });

  assert.deepEqual(await state.getRequestResult({
    actor: request.actor,
    route: request.route,
    requestId: request.requestId,
  }), {
    ...request,
    createdAt: NOW,
  });
  assert.ok(dynamo.commands[1] instanceof GetItemCommand);
  assert.deepEqual(dynamo.commands[1].input, {
    TableName: TABLE_NAME,
    Key: {
      pk: { S: "REQUEST#user-1234" },
      sk: { S: "REQUEST#POST /api/domains#request-1234" },
    },
    ConsistentRead: true,
  });
});

test("request result numbers round-trip through native DynamoDB attributes", async () => {
  let storedItem;
  const dynamo = {
    async send(command) {
      if (command instanceof PutItemCommand) {
        storedItem = structuredClone(command.input.Item);
        return {};
      }
      if (command instanceof GetItemCommand) {
        return { Item: structuredClone(storedItem) };
      }
      throw new Error("Unexpected DynamoDB command.");
    },
  };
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });
  const request = {
    actor: "user-1234",
    route: "POST /api/domains",
    requestId: "request-number-round-trip",
    result: {
      large: 1e21,
      small: 1e-7,
      decimal: 0.25,
    },
    expiresAt: 1787533323,
  };

  await state.putRequestResult(request);

  assert.deepEqual(
    await state.getRequestResult({
      actor: request.actor,
      route: request.route,
      requestId: request.requestId,
    }),
    {
      ...request,
      createdAt: NOW,
    },
  );
});

test("request result expiry preserves an unexpired first writer and replaces an expired item", async () => {
  let storedItem;
  const commands = [];
  const dynamo = {
    async send(command) {
      commands.push(command);
      if (!(command instanceof PutItemCommand)) {
        throw new Error("Unexpected DynamoDB command.");
      }
      const currentEpoch = Number(
        command.input.ExpressionAttributeValues[":now"].N,
      );
      if (
        storedItem
        && Number(storedItem.expiresAt.N) > currentEpoch
      ) {
        throw new ConditionalCheckFailedException({
          $metadata: {},
          message: "unexpired result exists",
        });
      }
      storedItem = structuredClone(command.input.Item);
      return {};
    },
  };
  let clock = NOW;
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => new Date(clock),
  });
  const first = {
    actor: "user-1234",
    route: "POST /api/domains",
    requestId: "request-expiry-race",
    result: { version: 1 },
    expiresAt: 1787533323,
  };

  await state.putRequestResult(first);
  await assert.rejects(
    state.putRequestResult({
      ...first,
      result: { version: 2 },
    }),
    (error) => error?.code === "REQUEST_CONFLICT",
  );
  assert.deepEqual(storedItem.result, {
    M: { version: { N: "1" } },
  });

  clock = "2026-08-24T01:02:04.000Z";
  const replacement = {
    ...first,
    result: { version: 3 },
    expiresAt: 1787619724,
  };
  assert.deepEqual(await state.putRequestResult(replacement), {
    ...replacement,
    createdAt: clock,
  });
  assert.deepEqual(storedItem.result, {
    M: { version: { N: "3" } },
  });
  assert.equal(commands.length, 3);
});

test("getRequestResult samples the clock once and hides expired items", async () => {
  const currentEpoch = Math.floor(Date.parse(NOW) / 1000);
  let clockCalls = 0;
  const expiredItem = requestResultItem(
    { ok: true },
    {
      expiresAt: { N: String(currentEpoch) },
      createdAt: { S: "2026-08-22T01:02:03.000Z" },
    },
  );
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo: recordingDynamo([{ Item: expiredItem }]),
    now: () => {
      clockCalls += 1;
      return new Date(NOW);
    },
  });

  assert.equal(
    await state.getRequestResult({
      actor: "user-1234",
      route: "POST /api/domains",
      requestId: "request-size-boundary",
    }),
    null,
  );
  assert.equal(clockCalls, 1);
});

test("getRequestResult preserves permanent Registry governance evidence beyond 24 hours", async () => {
  const request = registryFinalRequestResult({
    createdAt: "2026-08-21T01:02:03.000Z",
  });
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo: recordingDynamo([{
      Item: permanentRegistryRequestItem(request),
    }]),
    now: () => NOW,
  });

  assert.deepEqual(await state.getRequestResult({
    actor: request.actor,
    route: request.route,
    requestId: request.requestId,
  }), request);
});

test("request result writes reject expiry that is not future at write time", async () => {
  const dynamo = recordingDynamo();

  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo,
      now: () => NOW,
    }).putRequestResult({
      actor: "user-1234",
      route: "POST /api/domains",
      requestId: "request-already-expired",
      result: { ok: true },
      createdAt: "2026-08-22T01:02:03.000Z",
      expiresAt: Math.floor(Date.parse(NOW) / 1000),
    }),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("request result numbers enforce DynamoDB exponent limits", async () => {
  const accepted = {
    actor: "user-1234",
    route: "POST /api/domains",
    requestId: "request-number-limits",
    result: {
      cost: 0.0000025,
      error: { retryable: false, statusCode: 429 },
      maximumExponent: 1e125,
      minimumExponent: 1e-130,
      tokenUsage: { inputTokens: 1500, outputTokens: 250 },
      zero: 0,
    },
    expiresAt: 1787533323,
  };
  const acceptedDynamo = recordingDynamo();

  await createPlatformState({
    tableName: TABLE_NAME,
    dynamo: acceptedDynamo,
    now: () => NOW,
  }).putRequestResult(accepted);

  assert.equal(acceptedDynamo.commands.length, 1);
  for (const number of [1e126, -1e126, 1e-131, -1e-131]) {
    const rejectedDynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: rejectedDynamo,
        now: () => NOW,
      }).putRequestResult({
        ...accepted,
        result: { number },
      }),
      (error) => error?.code === "INVALID_REQUEST_RESULT",
    );
    assert.equal(rejectedDynamo.commands.length, 0);
  }
});

test("request results enforce the exact marshalled item-size ceiling", async () => {
  const atLimit = resultAtMarshalledItemSize(
    MAX_REQUEST_RESULT_ITEM_BYTES,
  );
  const acceptedDynamo = recordingDynamo();
  await createPlatformState({
    tableName: TABLE_NAME,
    dynamo: acceptedDynamo,
    now: () => NOW,
  }).putRequestResult({
    actor: "user-1234",
    route: "POST /api/domains",
    requestId: "request-size-boundary",
    result: atLimit,
    expiresAt: 1787533323,
  });
  assert.equal(
    Buffer.byteLength(JSON.stringify(acceptedDynamo.commands[0].input.Item)),
    MAX_REQUEST_RESULT_ITEM_BYTES,
  );

  const overLimit = resultAtMarshalledItemSize(
    MAX_REQUEST_RESULT_ITEM_BYTES + 1,
  );
  const rejectedDynamo = recordingDynamo();
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: rejectedDynamo,
      now: () => NOW,
    }).putRequestResult({
      actor: "user-1234",
      route: "POST /api/domains",
      requestId: "request-size-boundary",
      result: overLimit,
      expiresAt: 1787533323,
    }),
    (error) => error?.code === "INVALID_REQUEST_RESULT",
  );
  assert.equal(rejectedDynamo.commands.length, 0);

  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([{
        Item: requestResultItem(overLimit),
      }]),
      now: () => NOW,
    }).getRequestResult({
      actor: "user-1234",
      route: "POST /api/domains",
      requestId: "request-size-boundary",
    }),
    (error) => error?.code === "MALFORMED_REQUEST_RESULT_ITEM",
  );
});

test("request result validation and conflicts fail closed", async () => {
  const valid = {
    actor: "user-1234",
    route: "POST /api/domains",
    requestId: "request-1234",
    result: { ok: true },
    expiresAt: 1787533323,
  };
  const invalidInputs = [
    { ...valid, actor: "user#1234" },
    { ...valid, route: "/api/domains" },
    { ...valid, requestId: "request#1234" },
    { ...valid, result: ["not", "an", "object"] },
    { ...valid, result: { value: undefined } },
    { ...valid, result: { value: Number.NaN } },
    { ...valid, result: { constructor: "unsafe" } },
    { ...valid, expiresAt: 0 },
    { ...valid, expiresAt: 1787533323.5 },
    { ...valid, expiresAt: 1787446923 },
    { ...valid, createdAt: "2026-08-23" },
    { ...valid, extra: true },
  ];
  for (const input of invalidInputs) {
    const isolatedDynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: isolatedDynamo,
        now: () => NOW,
      }).putRequestResult(input),
      (error) => error?.code === "INVALID_REQUEST_RESULT",
    );
    assert.equal(isolatedDynamo.commands.length, 0);
  }

  const conditional = new ConditionalCheckFailedException({
    $metadata: {},
    message: "already exists",
  });
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([conditional]),
      now: () => NOW,
    }).putRequestResult(valid),
    (error) =>
      error?.code === "REQUEST_CONFLICT"
      && error?.message === "Request result already exists.",
  );

  assert.equal(
    await createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([{}]),
      now: () => NOW,
    }).getRequestResult({
      actor: valid.actor,
      route: valid.route,
      requestId: valid.requestId,
    }),
    null,
  );

  const malformedItem = {
    pk: { S: "REQUEST#user-1234" },
    sk: { S: "REQUEST#POST /api/domains#request-1234" },
    entityType: { S: "REQUEST_RESULT" },
    actor: { S: "user-1234" },
    route: { S: "POST /api/domains" },
    requestId: { S: "request-1234" },
    result: { M: { value: { N: "NaN" } } },
    expiresAt: { N: "1787533323" },
    createdAt: { S: NOW },
  };
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([{ Item: malformedItem }]),
      now: () => NOW,
    }).getRequestResult({
      actor: valid.actor,
      route: valid.route,
      requestId: valid.requestId,
    }),
    (error) => error?.code === "MALFORMED_REQUEST_RESULT_ITEM",
  );
});

test("getRequestResult exposes genuine request-result corruption provenance", async () => {
  const stateModule = await import("../lambda/platform-admin/state.mjs");
  assert.equal(
    typeof stateModule.RequestResultCorruptionError,
    "function",
  );

  const malformedItem = requestResultItem({ value: Number.NaN });
  await assert.rejects(
    stateModule.createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([{ Item: malformedItem }]),
      now: () => NOW,
    }).getRequestResult({
      actor: "user-1234",
      route: "POST /api/domains",
      requestId: "request-size-boundary",
    }),
    (error) =>
      error instanceof stateModule.RequestResultCorruptionError
      && error.code === "MALFORMED_REQUEST_RESULT_ITEM",
  );
});

test("appendAudit writes validated immutable native audit evidence", async () => {
  const audit = {
    actor: "user-1234",
    action: "domain.create",
    resource: "domain/customer_support",
    decision: "allowed",
    reason: "Platform administrator approved the request.",
    requestId: "request-1234",
  };
  const dynamo = recordingDynamo();
  const state = createPlatformState({
    tableName: TABLE_NAME,
    dynamo,
    now: () => NOW,
  });

  assert.deepEqual(await state.appendAudit(audit), {
    ...audit,
    timestamp: NOW,
  });
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Item: {
      pk: { S: "AUDIT#2026-08" },
      sk: {
        S:
          `${NOW}#`
          + createHash("sha256").update("user-1234").digest("hex")
          + "#request-1234",
      },
      entityType: { S: "AUDIT" },
      actor: { S: "user-1234" },
      action: { S: "domain.create" },
      resource: { S: "domain/customer_support" },
      decision: { S: "allowed" },
      reason: { S: "Platform administrator approved the request." },
      requestId: { S: "request-1234" },
      timestamp: { S: NOW },
    },
    ConditionExpression:
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  });

  const emptyReasonDynamo = recordingDynamo();
  assert.deepEqual(
    await createPlatformState({
      tableName: TABLE_NAME,
      dynamo: emptyReasonDynamo,
      now: () => NOW,
    }).appendAudit({ ...audit, reason: "" }),
    { ...audit, reason: "", timestamp: NOW },
  );
  assert.deepEqual(
    emptyReasonDynamo.commands[0].input.Item.reason,
    { S: "" },
  );

  const invalidAudits = [
    { ...audit, actor: "user#1234" },
    { ...audit, action: "Domain Create" },
    { ...audit, resource: "" },
    { ...audit, decision: "ALLOWED" },
    { ...audit, reason: "   " },
    { ...audit, reason: " approval pending " },
    { ...audit, reason: "approval\npending" },
    { ...audit, reason: "x".repeat(2049) },
    { ...audit, requestId: "request#1234" },
    { ...audit, timestamp: "2026-08-23" },
    { ...audit, extra: true },
  ];
  for (const invalid of invalidAudits) {
    const isolatedDynamo = recordingDynamo();
    await assert.rejects(
      createPlatformState({
        tableName: TABLE_NAME,
        dynamo: isolatedDynamo,
        now: () => NOW,
      }).appendAudit(invalid),
      (error) => error?.code === "INVALID_AUDIT",
    );
    assert.equal(isolatedDynamo.commands.length, 0);
  }

  const conditional = new ConditionalCheckFailedException({
    $metadata: {},
    message: "already exists",
  });
  await assert.rejects(
    createPlatformState({
      tableName: TABLE_NAME,
      dynamo: recordingDynamo([conditional]),
      now: () => NOW,
    }).appendAudit(audit),
    (error) =>
      error?.code === "AUDIT_CONFLICT"
      && error?.message === "Audit evidence already exists.",
  );
});
