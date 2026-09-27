import assert from "node:assert/strict";
import test from "node:test";
import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";

const NOW = "2026-08-25T01:02:03.000Z";
const LATER = "2026-08-25T01:03:04.000Z";
const TABLE_NAME = "PlatformState";
const FINGERPRINT = "a".repeat(64);

let stateModule;

async function loadState() {
  stateModule ??= import("../lambda/model-governance/state.mjs");
  return stateModule;
}

async function stateWith(dynamo, now = () => NOW) {
  const { createModelPolicyState } = await loadState();
  return createModelPolicyState({
    tableName: TABLE_NAME,
    dynamo,
    now,
  });
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

function string(value) {
  return { S: value };
}

function nullableNumber(value) {
  return value === null ? { NULL: true } : { N: String(value) };
}

function nullableString(value) {
  return value === null ? { NULL: true } : string(value);
}

function policy(overrides = {}) {
  return {
    modelId: "anthropic.claude-sonnet",
    allowedDomains: ["customer_support"],
    requestableDomains: ["finance"],
    limits: {
      requestsPerMinute: 60,
      tokensPerMinute: 120000,
      connectionsPerSecond: 4,
    },
    revision: 1,
    applicationStatus: "PENDING",
    rateLimit: null,
    updatedBySubject: "admin-sub-123",
    updatedAt: NOW,
    ...overrides,
  };
}

function mutation(overrides = {}) {
  return {
    actor: "admin-sub-123",
    effectiveRole: "admin",
    route: "POST /api/ai-gateway/model-policies",
    requestId: "model-policy-request-123",
    payloadFingerprint: FINGERPRINT,
    resourceKey: "model-policy/anthropic.claude-sonnet",
    operation: "UPSERT",
    decision: "upsert",
    reason: "Platform administrator updated model access.",
    timestamp: NOW,
    ...overrides,
  };
}

function policyItem(value = policy()) {
  return {
    pk: string("MODEL_POLICY"),
    sk: string(`MODEL#${value.modelId}`),
    entityType: string("MODEL_POLICY"),
    modelId: string(value.modelId),
    allowedDomains: {
      L: value.allowedDomains.map(string),
    },
    requestableDomains: {
      L: value.requestableDomains.map(string),
    },
    limits: {
      M: {
        requestsPerMinute:
          nullableNumber(value.limits.requestsPerMinute),
        tokensPerMinute:
          nullableNumber(value.limits.tokensPerMinute),
        connectionsPerSecond:
          nullableNumber(value.limits.connectionsPerSecond),
      },
    },
    revision: { N: String(value.revision) },
    applicationStatus: string(value.applicationStatus),
    rateLimit: value.rateLimit === null
      ? { NULL: true }
      : {
          M: {
            id: nullableString(value.rateLimit.id),
            status: string(value.rateLimit.status),
            reason: nullableString(value.rateLimit.reason),
            reconciledAt: string(value.rateLimit.reconciledAt),
          },
        },
    updatedBySubject: string(value.updatedBySubject),
    updatedAt: string(value.updatedAt),
  };
}

function auditItem(
  policyValue = policy(),
  mutationValue = mutation(),
) {
  return {
    pk: string(`MODEL_POLICY_AUDIT#${policyValue.modelId}`),
    sk: string(`${mutationValue.timestamp}#${mutationValue.requestId}`),
    entityType: string("MODEL_POLICY_AUDIT"),
    actor: string(mutationValue.actor),
    action: string(
      mutationValue.operation === "UPSERT"
        ? "model_policy.upsert"
        : "model_policy.application",
    ),
    resource: string(mutationValue.resourceKey),
    decision: string(mutationValue.decision),
    reason: string(mutationValue.reason),
    requestId: string(mutationValue.requestId),
    payloadFingerprint: string(mutationValue.payloadFingerprint),
    timestamp: string(mutationValue.timestamp),
  };
}

function mutationItem(
  policyValue = policy(),
  mutationValue = mutation(),
) {
  return {
    pk: string(`MUTATION#${mutationValue.actor}`),
    sk: string(
      `MUTATION#${mutationValue.route}#${mutationValue.requestId}`,
    ),
    entityType: string("MODEL_POLICY_MUTATION"),
    actor: string(mutationValue.actor),
    effectiveRole: string(mutationValue.effectiveRole),
    route: string(mutationValue.route),
    requestId: string(mutationValue.requestId),
    payloadFingerprint: string(mutationValue.payloadFingerprint),
    resourceKey: string(mutationValue.resourceKey),
    operation: string(mutationValue.operation),
    decision: string(mutationValue.decision),
    reason: string(mutationValue.reason),
    timestamp: string(mutationValue.timestamp),
    result: {
      M: policyItem(policyValue),
    },
  };
}

function transactionCancellation(codes) {
  return new TransactionCanceledException({
    $metadata: {},
    message: "transaction cancelled",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("configuration is strict", async () => {
  const { createModelPolicyState } = await loadState();
  const valid = {
    tableName: TABLE_NAME,
    dynamo: recordingDynamo(),
    now: () => NOW,
  };
  for (const input of [
    {},
    { ...valid, tableName: "" },
    { ...valid, tableName: "x".repeat(256) },
    { ...valid, dynamo: {} },
    { ...valid, now: null },
    { ...valid, extra: true },
  ]) {
    assert.throws(
      () => createModelPolicyState(input),
      TypeError,
    );
  }
});

test("policy upsert atomically writes the exact policy, audit, and permanent mutation result", async () => {
  const record = policy();
  const request = mutation();
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);
  const transaction = state.beginTransaction();

  assert.deepEqual(
    await state.putModelPolicy({
      record,
      expectedRevision: null,
      mutation: request,
      transaction,
    }),
    record,
  );
  assert.equal(dynamo.commands.length, 1);
  assert.ok(dynamo.commands[0] instanceof TransactWriteItemsCommand);
  const [policyWrite, auditWrite, mutationWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(policyWrite.Put, {
    TableName: TABLE_NAME,
    Item: policyItem(record),
    ConditionExpression:
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  });
  assert.deepEqual(auditWrite.Put, {
    TableName: TABLE_NAME,
    Item: auditItem(record, request),
    ConditionExpression:
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  });
  assert.deepEqual(mutationWrite.Put, {
    TableName: TABLE_NAME,
    Item: mutationItem(record, request),
    ConditionExpression:
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  });
});

test("policy schema rejects unknown fields, malformed identifiers, unbounded domains, overlaps, and invalid limits", async () => {
  const valid = policy();
  const invalidPolicies = [
    { ...valid, extra: true },
    { ...valid, modelId: " model" },
    { ...valid, modelId: "x".repeat(257) },
    { ...valid, allowedDomains: "customer_support" },
    {
      ...valid,
      allowedDomains: Array.from(
        { length: 101 },
        (_, index) => `domain_${index}`,
      ),
      requestableDomains: [],
    },
    {
      ...valid,
      allowedDomains: ["customer_support", "customer_support"],
    },
    { ...valid, allowedDomains: ["Customer-Support"] },
    {
      ...valid,
      requestableDomains: ["customer_support"],
    },
    {
      ...valid,
      limits: {
        ...valid.limits,
        requestsPerMinute: 1_000_001,
      },
    },
    {
      ...valid,
      limits: {
        ...valid.limits,
        tokensPerMinute: 1_000_000_001,
      },
    },
    {
      ...valid,
      limits: {
        ...valid.limits,
        connectionsPerSecond: 10_001,
      },
    },
    {
      ...valid,
      limits: {
        requestsPerMinute: 60,
        tokensPerMinute: 120000,
      },
    },
    { ...valid, revision: 0 },
    {
      ...valid,
      applicationStatus: "ACTIVE",
    },
    {
      ...valid,
      applicationStatus: "RECONCILIATION_FAILED",
      rateLimit: {
        id: null,
        status: "RECONCILIATION_FAILED",
        reason: null,
        reconciledAt: NOW,
      },
    },
    {
      ...valid,
      applicationStatus: "ACTIVE",
      rateLimit: {
        id: "rate-limit-123",
        status: "ACTIVE",
        reason: null,
        reconciledAt: null,
      },
    },
    { ...valid, updatedBySubject: "person#123" },
    { ...valid, updatedAt: "2026-08-25" },
  ];

  for (const invalid of invalidPolicies) {
    const dynamo = recordingDynamo();
    const state = await stateWith(dynamo);
    await assert.rejects(
      state.putModelPolicy({
        record: invalid,
        expectedRevision: null,
        mutation: mutation(),
        transaction: state.beginTransaction(),
      }),
      expectCode("INVALID_MODEL_POLICY"),
    );
    assert.equal(dynamo.commands.length, 0);
  }

  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);
  const sparseLimits = policy({
    limits: {
      requestsPerMinute: null,
      tokensPerMinute: 120000,
      connectionsPerSecond: null,
    },
  });
  assert.deepEqual(
    await state.putModelPolicy({
      record: sparseLimits,
      expectedRevision: null,
      mutation: mutation(),
      transaction: state.beginTransaction(),
    }),
    sparseLimits,
  );
  assert.deepEqual(
    dynamo.commands[0].input.TransactItems[0].Put.Item.limits,
    {
      M: {
        requestsPerMinute: { NULL: true },
        tokensPerMinute: { N: "120000" },
        connectionsPerSecond: { NULL: true },
      },
    },
  );
});

test("policy state rejects an all-omitted limit set", async () => {
  const state = await stateWith(recordingDynamo());

  await assert.rejects(
    state.putModelPolicy({
      record: policy({
        limits: {
          requestsPerMinute: null,
          tokensPerMinute: null,
          connectionsPerSecond: null,
        },
      }),
      expectedRevision: null,
      mutation: mutation(),
      transaction: state.beginTransaction(),
    }),
    expectCode("INVALID_MODEL_POLICY"),
  );
});

test("mutation schema and policy binding fail closed before DynamoDB", async () => {
  const invalidMutations = [
    { ...mutation(), extra: true },
    { ...mutation(), actor: "person#123" },
    { ...mutation(), effectiveRole: "lead" },
    { ...mutation(), route: "POST /api/other" },
    { ...mutation(), requestId: "request#123" },
    { ...mutation(), payloadFingerprint: "a".repeat(63) },
    { ...mutation(), resourceKey: "model-policy/other.model" },
    { ...mutation(), operation: "UPDATE" },
    { ...mutation(), decision: "approve" },
    { ...mutation(), reason: "" },
    { ...mutation(), timestamp: "2026-08-25" },
  ];

  for (const invalid of invalidMutations) {
    const dynamo = recordingDynamo();
    const state = await stateWith(dynamo);
    await assert.rejects(
      state.putModelPolicy({
        record: policy(),
        expectedRevision: null,
        mutation: invalid,
        transaction: state.beginTransaction(),
      }),
      expectCode("INVALID_MODEL_POLICY_MUTATION"),
    );
    assert.equal(dynamo.commands.length, 0);
  }

  for (const [record, request] of [
    [
      policy({ updatedBySubject: "other-admin-sub" }),
      mutation(),
    ],
    [
      policy({ updatedAt: "2026-08-25T01:02:02.000Z" }),
      mutation(),
    ],
  ]) {
    const dynamo = recordingDynamo();
    const state = await stateWith(dynamo);
    await assert.rejects(
      state.putModelPolicy({
        record,
        expectedRevision: null,
        mutation: request,
        transaction: state.beginTransaction(),
      }),
      expectCode("MODEL_POLICY_MUTATION_MISMATCH"),
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("an exact committed mutation replays permanently from immutable result evidence", async () => {
  const record = policy();
  const request = mutation();
  const dynamo = recordingDynamo([
    transactionCancellation([
      "None",
      "None",
      "ConditionalCheckFailed",
    ]),
    { Item: mutationItem(record, request) },
  ]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.putModelPolicy({
      record,
      expectedRevision: null,
      mutation: request,
      transaction: state.beginTransaction(),
    }),
    record,
  );
  assert.equal(dynamo.commands.length, 2);
  assert.ok(dynamo.commands[1] instanceof GetItemCommand);
  assert.deepEqual(dynamo.commands[1].input, {
    TableName: TABLE_NAME,
    Key: {
      pk: string(`MUTATION#${request.actor}`),
      sk: string(
        `MUTATION#${request.route}#${request.requestId}`,
      ),
    },
    ConsistentRead: true,
  });
});

test("idempotency collisions never rebind a request or disclose stored policy state", async () => {
  const record = policy();
  const request = mutation();
  const mismatches = [
    mutation({ payloadFingerprint: "b".repeat(64) }),
    mutation({ actor: "other-admin-sub" }),
    mutation({ resourceKey: "model-policy/other.model" }),
  ];

  for (const storedRequest of mismatches) {
    const dynamo = recordingDynamo([
      transactionCancellation([
        "None",
        "None",
        "ConditionalCheckFailed",
      ]),
      { Item: mutationItem(record, storedRequest) },
    ]);
    const state = await stateWith(dynamo);
    await assert.rejects(
      state.putModelPolicy({
        record,
        expectedRevision: null,
        mutation: request,
        transaction: state.beginTransaction(),
      }),
      (error) => {
        assert.equal(error?.code, "MUTATION_CONFLICT");
        assert.doesNotMatch(
          error.message,
          /anthropic|customer_support|finance/,
        );
        return true;
      },
    );
  }

  for (const response of [
    {},
    { Item: { ...mutationItem(record, request), extra: string("bad") } },
  ]) {
    const dynamo = recordingDynamo([
      transactionCancellation([
        "None",
        "None",
        "ConditionalCheckFailed",
      ]),
      response,
    ]);
    const state = await stateWith(dynamo);
    await assert.rejects(
      state.putModelPolicy({
        record,
        expectedRevision: null,
        mutation: request,
        transaction: state.beginTransaction(),
      }),
      expectCode("MUTATION_CONFLICT"),
    );
  }
});

test("non-conditional transaction failures are propagated unchanged", async () => {
  const failure = transactionCancellation([
    "ValidationError",
    "None",
    "None",
  ]);
  const state = await stateWith(recordingDynamo([failure]));
  await assert.rejects(
    state.putModelPolicy({
      record: policy(),
      expectedRevision: null,
      mutation: mutation(),
      transaction: state.beginTransaction(),
    }),
    (error) => error === failure,
  );
});

test("exact lookup is strongly consistent and returns null only for an absent item", async () => {
  const record = policy();
  const controller = new AbortController();
  const dynamo = recordingDynamo([
    { Item: policyItem(record) },
    {},
  ]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.getModelPolicy({
      modelId: record.modelId,
      abortSignal: controller.signal,
    }),
    record,
  );
  assert.ok(dynamo.commands[0] instanceof GetItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Key: {
      pk: string("MODEL_POLICY"),
      sk: string(`MODEL#${record.modelId}`),
    },
    ConsistentRead: true,
  });
  assert.equal(dynamo.options[0].abortSignal, controller.signal);
  assert.equal(
    await state.getModelPolicy({ modelId: "other.model" }),
    null,
  );
});

test("exact lookup rejects malformed scope and stored records", async () => {
  for (const input of [
    {},
    { modelId: " bad" },
    { modelId: "x".repeat(257) },
    { modelId: "valid.model", extra: true },
    { modelId: "valid.model", abortSignal: {} },
  ]) {
    const dynamo = recordingDynamo();
    await assert.rejects(
      (await stateWith(dynamo)).getModelPolicy(input),
      expectCode("INVALID_MODEL_POLICY_READ"),
    );
    assert.equal(dynamo.commands.length, 0);
  }

  for (const item of [
    { ...policyItem(), extra: string("bad") },
    { ...policyItem(), entityType: string("OTHER") },
    {
      ...policyItem(),
      allowedDomains: { L: [string("Customer-Support")] },
    },
  ]) {
    const state = await stateWith(recordingDynamo([{ Item: item }]));
    await assert.rejects(
      state.getModelPolicy({ modelId: policy().modelId }),
      expectCode("MALFORMED_DYNAMODB_RESPONSE"),
    );
  }
});

test("policy listing uses one bounded strongly consistent partition query with an exact cursor", async () => {
  const record = policy();
  const lastKey = {
    pk: string("MODEL_POLICY"),
    sk: string("MODEL#next.model"),
  };
  const controller = new AbortController();
  const dynamo = recordingDynamo([{
    Items: [policyItem(record)],
    LastEvaluatedKey: lastKey,
  }]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.listModelPolicies({
      limit: 25,
      cursor: {
        pk: "MODEL_POLICY",
        sk: "MODEL#previous.model",
      },
      abortSignal: controller.signal,
    }),
    {
      items: [record],
      cursor: {
        pk: "MODEL_POLICY",
        sk: "MODEL#next.model",
      },
    },
  );
  assert.ok(dynamo.commands[0] instanceof QueryCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    KeyConditionExpression:
      "#pk = :pk AND begins_with(#sk, :skPrefix)",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#sk": "sk",
    },
    ExpressionAttributeValues: {
      ":pk": string("MODEL_POLICY"),
      ":skPrefix": string("MODEL#"),
    },
    ConsistentRead: true,
    ScanIndexForward: true,
    Limit: 25,
    ExclusiveStartKey: {
      pk: string("MODEL_POLICY"),
      sk: string("MODEL#previous.model"),
    },
  });
  assert.equal(dynamo.options[0].abortSignal, controller.signal);
});

test("policy listing rejects unbounded options and malformed DynamoDB pages", async () => {
  for (const input of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { cursor: { pk: "OTHER", sk: "MODEL#next.model" } },
    { cursor: { pk: "MODEL_POLICY", sk: "OTHER#next.model" } },
    { extra: true },
    { abortSignal: {} },
  ]) {
    const dynamo = recordingDynamo();
    await assert.rejects(
      (await stateWith(dynamo)).listModelPolicies(input),
      expectCode("INVALID_MODEL_POLICY_READ"),
    );
    assert.equal(dynamo.commands.length, 0);
  }

  for (const response of [
    { Items: {} },
    { Items: Array.from({ length: 2 }, () => policyItem()) },
    {
      Items: [],
      LastEvaluatedKey: {
        pk: string("OTHER"),
        sk: string("MODEL#next.model"),
      },
    },
    {
      Items: [],
      LastEvaluatedKey: {
        pk: string("MODEL_POLICY"),
        sk: string("OTHER#next.model"),
      },
    },
  ]) {
    const state = await stateWith(recordingDynamo([response]));
    await assert.rejects(
      state.listModelPolicies({ limit: 1 }),
      expectCode("MALFORMED_DYNAMODB_RESPONSE"),
    );
  }
});

test("transaction tokens are explicit, one-shot, and bind one authoritative clock", async () => {
  let clockReads = 0;
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo, () => {
    clockReads += 1;
    return NOW;
  });
  const transaction = state.beginTransaction();
  assert.equal(clockReads, 1);
  assert.deepEqual(transaction, {
    timestamp: NOW,
    epochSeconds: Math.floor(Date.parse(NOW) / 1000),
  });
  assert.equal(Object.isFrozen(transaction), true);

  await state.putModelPolicy({
    record: policy(),
    expectedRevision: null,
    mutation: mutation(),
    transaction,
  });
  assert.equal(clockReads, 1);

  for (const invalidTransaction of [transaction, {}, null]) {
    await assert.rejects(
      state.putModelPolicy({
        record: policy(),
        expectedRevision: null,
        mutation: mutation(),
        transaction: invalidTransaction,
      }),
      expectCode("INVALID_TRANSACTION"),
    );
  }
  assert.equal(dynamo.commands.length, 1);
});

test("policy updates require the expected revision and advance exactly once", async () => {
  const record = policy({
    revision: 2,
    allowedDomains: ["customer_support", "finance"],
    requestableDomains: [],
  });
  const request = mutation({
    requestId: "model-policy-request-456",
    payloadFingerprint: "b".repeat(64),
  });
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.putModelPolicy({
      record,
      expectedRevision: 1,
      mutation: request,
      transaction: state.beginTransaction(),
    }),
    record,
  );
  assert.deepEqual(
    dynamo.commands[0].input.TransactItems[0].Put,
    {
      TableName: TABLE_NAME,
      Item: policyItem(record),
      ConditionExpression:
        "#entityType = :entityType AND #revision = :expectedRevision",
      ExpressionAttributeNames: {
        "#entityType": "entityType",
        "#revision": "revision",
      },
      ExpressionAttributeValues: {
        ":entityType": string("MODEL_POLICY"),
        ":expectedRevision": { N: "1" },
      },
    },
  );

  for (const [expectedRevision, invalidRecord] of [
    [null, policy({ revision: 2 })],
    [1, policy({ revision: 1 })],
    [0, policy()],
  ]) {
    const isolatedDynamo = recordingDynamo();
    const isolatedState = await stateWith(isolatedDynamo);
    await assert.rejects(
      isolatedState.putModelPolicy({
        record: invalidRecord,
        expectedRevision,
        mutation: mutation(),
        transaction: isolatedState.beginTransaction(),
      }),
      expectCode("INVALID_MODEL_POLICY"),
    );
    assert.equal(isolatedDynamo.commands.length, 0);
  }
});

test("Gateway reconciliation must finalize PENDING policy application before ACTIVE is readable", async () => {
  const record = policy({
    applicationStatus: "ACTIVE",
    rateLimit: {
      id: "platform-llm-rate-limit",
      status: "ACTIVE",
      reason: null,
      reconciledAt: LATER,
    },
  });
  const request = mutation({
    route: "POST /internal/model-policies/application",
    requestId: "model-policy-request-123:application",
    operation: "FINALIZE",
    decision: "activate",
    reason: "AgentCore Gateway rate limits reconciled.",
    timestamp: LATER,
  });
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo, () => LATER);

  assert.deepEqual(
    await state.finalizeModelPolicyApplication({
      record,
      expectedStatus: "PENDING",
      mutation: request,
      transaction: state.beginTransaction(),
    }),
    record,
  );
  const [policyWrite, auditWrite, mutationWrite] =
    dynamo.commands[0].input.TransactItems;
  assert.deepEqual(policyWrite.Put, {
    TableName: TABLE_NAME,
    Item: policyItem(record),
    ConditionExpression:
      "#entityType = :entityType AND #revision = :revision "
      + "AND #applicationStatus = :expectedStatus "
      + "AND #updatedBySubject = :updatedBySubject "
      + "AND #updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#applicationStatus": "applicationStatus",
      "#entityType": "entityType",
      "#revision": "revision",
      "#updatedAt": "updatedAt",
      "#updatedBySubject": "updatedBySubject",
    },
    ExpressionAttributeValues: {
      ":entityType": string("MODEL_POLICY"),
      ":revision": { N: "1" },
      ":expectedStatus": string("PENDING"),
      ":updatedBySubject": string("admin-sub-123"),
      ":updatedAt": string(NOW),
    },
  });
  assert.deepEqual(auditWrite.Put.Item, auditItem(record, request));
  assert.deepEqual(mutationWrite.Put.Item, mutationItem(record, request));
});

test("failed reconciliation is durable evidence and cannot be projected as ACTIVE", async () => {
  const failed = policy({
    applicationStatus: "RECONCILIATION_FAILED",
    rateLimit: {
      id: null,
      status: "RECONCILIATION_FAILED",
      reason: "AgentCore Gateway rejected the rate-limit set.",
      reconciledAt: LATER,
    },
  });
  const request = mutation({
    route: "POST /internal/model-policies/application",
    requestId: "model-policy-request-123:application",
    operation: "FINALIZE",
    decision: "fail",
    reason: failed.rateLimit.reason,
    timestamp: LATER,
  });
  const dynamo = recordingDynamo([{}]);
  const state = await stateWith(dynamo, () => LATER);

  assert.deepEqual(
    await state.finalizeModelPolicyApplication({
      record: failed,
      expectedStatus: "PENDING",
      mutation: request,
      transaction: state.beginTransaction(),
    }),
    failed,
  );
  assert.equal(
    dynamo.commands[0].input.TransactItems[0]
      .Put.Item.applicationStatus.S,
    "RECONCILIATION_FAILED",
  );

  const invalid = policy({
    applicationStatus: "ACTIVE",
    rateLimit: {
      id: null,
      status: "ACTIVE",
      reason: failed.rateLimit.reason,
      reconciledAt: LATER,
    },
  });
  const isolatedState = await stateWith(recordingDynamo(), () => LATER);
  await assert.rejects(
    isolatedState.finalizeModelPolicyApplication({
      record: invalid,
      expectedStatus: "PENDING",
      mutation: {
        ...request,
        decision: "activate",
      },
      transaction: isolatedState.beginTransaction(),
    }),
    expectCode("INVALID_MODEL_POLICY"),
  );
});

test("getMutationResult exposes only exact permanent orchestration evidence", async () => {
  const record = policy();
  const request = mutation();
  const controller = new AbortController();
  const dynamo = recordingDynamo([
    { Item: mutationItem(record, request) },
    {},
  ]);
  const state = await stateWith(dynamo);

  assert.deepEqual(
    await state.getMutationResult({
      actor: request.actor,
      route: request.route,
      requestId: request.requestId,
      abortSignal: controller.signal,
    }),
    { record, mutation: request },
  );
  assert.ok(dynamo.commands[0] instanceof GetItemCommand);
  assert.deepEqual(dynamo.commands[0].input, {
    TableName: TABLE_NAME,
    Key: {
      pk: string(`MUTATION#${request.actor}`),
      sk: string(
        `MUTATION#${request.route}#${request.requestId}`,
      ),
    },
    ConsistentRead: true,
  });
  assert.equal(dynamo.options[0].abortSignal, controller.signal);
  assert.equal(
    await state.getMutationResult({
      actor: request.actor,
      route: request.route,
      requestId: "missing-request",
    }),
    null,
  );
});
