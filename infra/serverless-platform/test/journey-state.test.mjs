import assert from "node:assert/strict";
import test from "node:test";
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createJourneyState,
} from "../lambda/journeys/state.mjs";

const TABLE_NAME = "PlatformState";
const NOW = "2026-08-27T01:02:03.000Z";
const ACTOR = "builder-sub-123";
const DOMAIN = "customer_support";
const FINGERPRINT = "a".repeat(64);
const EVIDENCE_HASH = "b".repeat(64);
const RETENTION_SECONDS = 365 * 24 * 60 * 60;

function expiresAt(timestamp = NOW) {
  return Math.floor(Date.parse(timestamp) / 1000) + RETENTION_SECONDS;
}

function recordingDynamo(responses = [{}]) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      if (responses.length === 0) {
        throw new Error("Unexpected DynamoDB command.");
      }
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function stateWith(dynamo, now = () => NOW) {
  return createJourneyState({
    tableName: TABLE_NAME,
    dynamo,
    now,
  });
}

function mutation(overrides = {}) {
  return {
    actor: ACTOR,
    domainId: DOMAIN,
    requestId: "journey-request-123",
    payloadFingerprint: FINGERPRINT,
    expectedUpdatedAt: null,
    ...overrides,
  };
}

function minimalJourney(overrides = {}) {
  return {
    version: 1,
    actor: ACTOR,
    id: "minimal-journey",
    domainId: DOMAIN,
    preset: "MINIMAL",
    repositoryName: "support-foundation",
    status: "DRAFT",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function specJourney(overrides = {}) {
  return {
    version: 1,
    actor: ACTOR,
    id: "spec-journey",
    domainId: DOMAIN,
    preset: "SPEC",
    repositoryName: "support-spec",
    status: "DRAFT",
    transcript: [
      {
        role: "user",
        text: "Build a read-only support triage agent.\nKeep an audit trail.",
      },
      {
        role: "assistant",
        text: "Which channels and data sources should it use?",
      },
    ],
    inception: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fullSnapshot() {
  return {
    snapshotVersion: 1,
    agent: {
      domainId: DOMAIN,
      projectId: "case-assist",
      id: "triage-agent",
      name: "Triage Agent",
      instructions:
        "Triage support requests.\nDo not change customer data.",
      modelId: "anthropic.claude-sonnet",
      runtimeModelId: "us.anthropic.claude-sonnet-v1:0",
      modelParameters: {
        temperature: 0,
        maxTokens: 1024,
      },
      buildOptions: {
        framework: "Strands",
        deployTarget: "AgentCore Runtime",
        memory: "longAndShortTerm",
        streaming: true,
        identity: true,
        guardrails: true,
      },
      testEvidenceHash: EVIDENCE_HASH,
    },
    blueprint: {
      registryId: "platform-registry",
      recordId: "support-blueprint",
      version: "7",
      blueprintId: "chat-assistant",
      templateId: "chatagent",
      scope: "shared",
      template: {
        protocol: "HTTP",
      },
    },
    resources: [
      {
        type: "TOOL",
        registryId: "platform-registry",
        recordId: "case-search",
        version: "3",
        id: "case-search",
        binding: {
          adapter: "agentcore_gateway",
          status: "DEPLOYMENT_REQUIRED",
        },
      },
    ],
  };
}

function delivery(overrides = {}) {
  return {
    version: 1,
    actor: ACTOR,
    id: "delivery-123",
    domainId: DOMAIN,
    role: "builder",
    preset: "FULL",
    repositoryName: "support-triage-agent",
    visibility: "private",
    source: {
      snapshot: fullSnapshot(),
    },
    manifest: {
      summary: {
        fileCount: 18,
        workflowCount: 5,
      },
      fingerprint: FINGERPRINT,
    },
    status: "PREVIEWED",
    previewExpiresAt: "2026-08-27T01:17:03.000Z",
    checkpoints: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function githubAuthorizationIntent(overrides = {}) {
  return {
    version: 1,
    actor: ACTOR,
    domainId: DOMAIN,
    role: "builder",
    state: `gho_${"a".repeat(32)}`,
    deliveryId: "delivery-123",
    manifestFingerprint: FINGERPRINT,
    repositoryName: "support-triage-agent",
    visibility: "private",
    requestId: "github-authorization-request-123",
    expiresAt: "2026-08-27T01:12:03.000Z",
    createdAt: NOW,
    consumedAt: null,
    ...overrides,
  };
}

function specSource(overrides = {}) {
  return {
    journeyId: "spec-journey",
    inception: {
      profile: {
        name: "support-triage",
        domain: DOMAIN,
      },
    },
    agent: {
      domainId: DOMAIN,
      projectId: "case-assist",
      agentId: "triage-agent",
      status: "READY_FOR_TEST",
      contractFingerprint: "a".repeat(64),
      configurationFingerprint: "b".repeat(64),
    },
    ...overrides,
  };
}

function attribute(value) {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  return {
    M: Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, attribute(item)]),
    ),
  };
}

function conditionalConflict() {
  return new ConditionalCheckFailedException({
    $metadata: {},
    message: "sensitive conditional detail",
  });
}

function checkpointedItem(initialItem, checkpoints) {
  const result = structuredClone(initialItem);
  const latest = checkpoints.at(-1);
  result.status = { S: latest.status };
  result.updatedAt = { S: latest.at };
  result.expiresAt = { N: String(expiresAt(latest.at)) };
  result.record.M.status = { S: latest.status };
  result.record.M.updatedAt = { S: latest.at };
  result.record.M.checkpoints = attribute(checkpoints);
  return result;
}

test("MINIMAL and SPEC journeys use exact preset-specific schemas", async () => {
  const minimalDynamo = recordingDynamo([{}]);
  const minimalState = stateWith(minimalDynamo);
  const minimal = minimalJourney();

  assert.deepEqual(
    await minimalState.putJourney({
      record: minimal,
      mutation: mutation(),
    }),
    minimal,
  );
  assert.ok(minimalDynamo.commands[0] instanceof PutItemCommand);
  assert.deepEqual(minimalDynamo.commands[0].input.Key, undefined);
  assert.deepEqual(minimalDynamo.commands[0].input.Item.pk, {
    S: `JOURNEY#${ACTOR}#minimal-journey`,
  });
  assert.deepEqual(minimalDynamo.commands[0].input.Item.sk, {
    S: "JOURNEY",
  });
  assert.deepEqual(minimalDynamo.commands[0].input.Item.expiresAt, {
    N: String(expiresAt()),
  });
  assert.equal(
    minimalDynamo.commands[0].input.Item.record.M.expiresAt,
    undefined,
  );
  assert.equal(
    minimalDynamo.commands[0].input.ConditionExpression,
    "attribute_not_exists(pk) AND attribute_not_exists(sk)",
  );

  const specDynamo = recordingDynamo([{}]);
  const specState = stateWith(specDynamo);
  const spec = specJourney();
  assert.deepEqual(
    await specState.putJourney({
      record: spec,
      mutation: mutation({ requestId: "spec-request-123" }),
    }),
    spec,
  );

  for (const record of [
    { ...minimal, unexpected: true },
    { ...minimal, preset: "FULL" },
    { ...spec, transcript: [{ role: "system", text: "unsafe" }] },
    { ...spec, transcript: [{ role: "user", text: "x".repeat(8_001) }] },
    { ...spec, inception: { token: "ghp_" + "x".repeat(40) } },
  ]) {
    const dynamo = recordingDynamo([]);
    await assert.rejects(
      stateWith(dynamo).putJourney({
        record,
        mutation: mutation(),
      }),
      (error) => error.code === "INVALID_JOURNEY",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("mutation claims replay completed pointers and complete entity writes atomically", async () => {
  const request = {
    actor: ACTOR,
    domainId: DOMAIN,
    effectiveRole: "builder",
    operation: "CREATE_JOURNEY",
    requestId: "create-once",
    payloadFingerprint: FINGERPRINT,
    resourceType: "JOURNEY",
    proposedResourceId: "minimal-journey",
  };
  const claimWriter = recordingDynamo([{}]);
  const claimed = await stateWith(claimWriter).claimMutation(request);
  assert.equal(claimed.status, "CLAIMED");
  assert.ok(claimWriter.commands[0] instanceof PutItemCommand);
  assert.deepEqual(claimWriter.commands[0].input.Item.pk, {
    S: `MUTATION#${ACTOR}`,
  });
  assert.deepEqual(claimWriter.commands[0].input.Item.sk, {
    S: "JOURNEY#CREATE_JOURNEY#create-once",
  });
  assert.deepEqual(claimWriter.commands[0].input.Item.expiresAt, {
    N: String(expiresAt()),
  });

  const entityWriter = recordingDynamo([{}]);
  assert.deepEqual(
    await stateWith(entityWriter).putJourney({
      record: minimalJourney(),
      mutation: mutation({ requestId: "create-once" }),
      claim: claimed.claim,
    }),
    minimalJourney(),
  );
  assert.ok(entityWriter.commands[0] instanceof TransactWriteItemsCommand);
  assert.equal(entityWriter.commands[0].input.TransactItems.length, 2);
  assert.deepEqual(
    entityWriter.commands[0].input.TransactItems[1].Update.Key,
    {
      pk: { S: `MUTATION#${ACTOR}` },
      sk: { S: "JOURNEY#CREATE_JOURNEY#create-once" },
    },
  );
  const mutationUpdate =
    entityWriter.commands[0].input.TransactItems[1].Update;
  assert.match(mutationUpdate.UpdateExpression, /#expiresAt = :expiresAt/);
  assert.equal(mutationUpdate.ExpressionAttributeNames["#expiresAt"], "expiresAt");
  assert.deepEqual(mutationUpdate.ExpressionAttributeValues[":expiresAt"], {
    N: String(expiresAt()),
  });

  const completedItem = structuredClone(claimWriter.commands[0].input.Item);
  completedItem.status = { S: "SUCCEEDED" };
  completedItem.result = attribute({
    resourceType: "JOURNEY",
    resourceId: "minimal-journey",
  });
  const replay = recordingDynamo([
    conditionalConflict(),
    { Item: completedItem },
  ]);
  assert.deepEqual(
    await stateWith(replay).claimMutation({
      ...request,
      proposedResourceId: "unused-retry-id",
    }),
    {
      status: "SUCCEEDED",
      result: {
        resourceType: "JOURNEY",
        resourceId: "minimal-journey",
      },
    },
  );

  const changed = recordingDynamo([
    conditionalConflict(),
    { Item: completedItem },
  ]);
  await assert.rejects(
    stateWith(changed).claimMutation({
      ...request,
      payloadFingerprint: "c".repeat(64),
    }),
    (error) => error.code === "MUTATION_CONFLICT",
  );
});

test("journey reads are actor- and domain-bound and decode strict state", async () => {
  const writer = recordingDynamo([{}]);
  await stateWith(writer).putJourney({
    record: specJourney(),
    mutation: mutation(),
  });
  const item = writer.commands[0].input.Item;
  const reader = recordingDynamo([{ Item: item }]);
  const state = stateWith(reader);

  assert.deepEqual(
    await state.getJourney({
      actor: ACTOR,
      domainId: DOMAIN,
      journeyId: "spec-journey",
    }),
    specJourney(),
  );
  assert.ok(reader.commands[0] instanceof GetItemCommand);
  assert.deepEqual(reader.commands[0].input.Key, {
    pk: { S: `JOURNEY#${ACTOR}#spec-journey` },
    sk: { S: "JOURNEY" },
  });
  assert.equal(reader.commands[0].input.ConsistentRead, true);

  for (const input of [
    {
      actor: "other-builder-sub",
      domainId: DOMAIN,
      journeyId: "spec-journey",
    },
    {
      actor: ACTOR,
      domainId: "finance",
      journeyId: "spec-journey",
    },
  ]) {
    await assert.rejects(
      stateWith(recordingDynamo([{ Item: item }])).getJourney(input),
      (error) => error.code === "JOURNEY_SCOPE_MISMATCH"
        && !error.message.includes(ACTOR)
        && !error.message.includes(DOMAIN),
    );
  }
});

test("FULL is persisted only as an immutable delivery snapshot", async () => {
  const dynamo = recordingDynamo([{}]);
  const state = stateWith(dynamo);
  const record = delivery();

  assert.deepEqual(
    await state.putDeliveryIntent({
      record,
      mutation: mutation({ requestId: "delivery-request-123" }),
    }),
    record,
  );
  const command = dynamo.commands[0];
  assert.ok(command instanceof PutItemCommand);
  assert.deepEqual(command.input.Item.pk, {
    S: `DELIVERY#${ACTOR}#delivery-123`,
  });
  assert.deepEqual(command.input.Item.sk, { S: "DELIVERY" });
  assert.deepEqual(
    command.input.Item.record.M.source.M.snapshot.M.snapshotVersion,
    { N: "1" },
  );
  assert.deepEqual(
    command.input.Item.manifestFingerprint,
    { S: FINGERPRINT },
  );
  assert.deepEqual(command.input.Item.role, { S: "builder" });
  assert.deepEqual(command.input.Item.createdAt, { S: NOW });
  assert.deepEqual(command.input.Item.expiresAt, {
    N: String(expiresAt()),
  });
  assert.equal(command.input.Item.record.M.expiresAt, undefined);

  const invalid = [
    { ...record, unexpected: true },
    {
      ...record,
      source: {
        snapshot: {
          ...fullSnapshot(),
          unexpected: true,
        },
      },
    },
    {
      ...record,
      source: {
        snapshot: {
          ...fullSnapshot(),
          agent: {
            ...fullSnapshot().agent,
            testEvidenceHash: "not-a-hash",
          },
        },
      },
    },
    {
      ...record,
      source: {
        snapshot: {
          ...fullSnapshot(),
          agent: {
            ...fullSnapshot().agent,
            buildOptions: {
              ...fullSnapshot().agent.buildOptions,
              memory: "forever",
            },
          },
        },
      },
    },
    {
      ...record,
      status: "APPROVED",
    },
    {
      ...record,
      role: "user",
    },
  ];
  for (const candidate of invalid) {
    const invalidDynamo = recordingDynamo([]);
    await assert.rejects(
      stateWith(invalidDynamo).putDeliveryIntent({
        record: candidate,
        mutation: mutation(),
      }),
      (error) => error.code === "INVALID_DELIVERY",
    );
    assert.equal(invalidDynamo.commands.length, 0);
  }
});

test("delivery records stay below the DynamoDB item ceiling", async () => {
  const record = delivery();
  record.source.snapshot.blueprint.template = {
    text: "x".repeat(330_000),
  };
  const dynamo = recordingDynamo([]);

  await assert.rejects(
    stateWith(dynamo).putDeliveryIntent({
      record,
      mutation: mutation(),
    }),
    (error) => error.code === "INVALID_DELIVERY",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("delivery records reject excessive JSON nesting", async () => {
  const record = delivery();
  let nested = {};
  record.source.snapshot.blueprint.template = nested;
  for (let depth = 0; depth < 10_000; depth += 1) {
    nested.value = {};
    nested = nested.value;
  }
  const dynamo = recordingDynamo([]);

  await assert.rejects(
    stateWith(dynamo).putDeliveryIntent({
      record,
      mutation: mutation(),
    }),
    (error) => error.code === "INVALID_DELIVERY",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("delivery records include DynamoDB attribute encoding in their size bound", async () => {
  const record = delivery();
  record.source.snapshot.blueprint.template = {
    values: Array(45_000).fill(""),
  };
  const dynamo = recordingDynamo([]);

  await assert.rejects(
    stateWith(dynamo).putDeliveryIntent({
      record,
      mutation: mutation(),
    }),
    (error) => error.code === "INVALID_DELIVERY",
  );
  assert.equal(dynamo.commands.length, 0);
});

test("valid FULL, MINIMAL, and SPEC delivery records remain accepted", async () => {
  const records = [
    delivery(),
    delivery({
      preset: "MINIMAL",
      source: { domainId: DOMAIN },
    }),
    delivery({
      preset: "MINIMAL",
      source: { domainId: DOMAIN, journeyId: "journey-1" },
    }),
    delivery({
      preset: "SPEC",
      source: specSource(),
    }),
  ];

  for (const record of records) {
    const dynamo = recordingDynamo([{}]);
    assert.deepEqual(
      await stateWith(dynamo).putDeliveryIntent({
        record,
        mutation: mutation(),
      }),
      record,
    );
    assert.ok(dynamo.commands[0] instanceof PutItemCommand);
  }
});

test("SPEC delivery source requires one exact configured Agent binding", async () => {
  const base = delivery({
    preset: "SPEC",
    source: specSource(),
  });
  for (const source of [
    { ...specSource(), unexpected: true },
    { ...specSource(), agent: { ...specSource().agent, unexpected: true } },
    {
      ...specSource(),
      agent: { ...specSource().agent, agentId: undefined },
    },
    {
      ...specSource(),
      agent: { ...specSource().agent, status: "DRAFT" },
    },
    {
      ...specSource(),
      agent: { ...specSource().agent, domainId: "other_domain" },
    },
  ]) {
    const dynamo = recordingDynamo([]);
    await assert.rejects(
      stateWith(dynamo).putDeliveryIntent({
        record: { ...base, source },
        mutation: mutation(),
      }),
      (error) => error.code === "INVALID_DELIVERY",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("delivery previews require a future expiry no more than fifteen minutes away", async () => {
  for (const previewExpiresAt of [
    NOW,
    "2026-08-27T01:17:03.001Z",
    "not-a-time",
  ]) {
    const dynamo = recordingDynamo([]);
    await assert.rejects(
      stateWith(dynamo).putDeliveryIntent({
        record: delivery({ previewExpiresAt }),
        mutation: mutation(),
      }),
      (error) => error.code === "INVALID_DELIVERY",
    );
    assert.equal(dynamo.commands.length, 0);
  }
});

test("conditional puts replay only an exact record and mutation", async () => {
  const first = recordingDynamo([{}]);
  const record = delivery();
  const request = mutation({ requestId: "delivery-request-123" });
  await stateWith(first).putDeliveryIntent({
    record,
    mutation: request,
  });
  const item = first.commands[0].input.Item;

  const replay = recordingDynamo([
    conditionalConflict(),
    { Item: item },
  ]);
  assert.deepEqual(
    await stateWith(replay).putDeliveryIntent({
      record,
      mutation: request,
    }),
    record,
  );
  assert.ok(replay.commands[0] instanceof PutItemCommand);
  assert.ok(replay.commands[1] instanceof GetItemCommand);

  for (const changed of [
    {
      record: delivery({ repositoryName: "different-repository" }),
      mutation: request,
    },
    {
      record,
      mutation: {
        ...request,
        payloadFingerprint: "c".repeat(64),
      },
    },
  ]) {
    await assert.rejects(
      stateWith(recordingDynamo([
        conditionalConflict(),
        { Item: item },
      ])).putDeliveryIntent(changed),
      (error) => error.code === "DELIVERY_CONFLICT"
        && !error.message.includes(record.repositoryName),
    );
  }
});

test("journey updates preserve immutable scope and replay exact state", async () => {
  const next = "2026-08-27T01:03:03.000Z";
  const record = specJourney({
    status: "CONTRACT_READY",
    inception: {
      profile: {
        name: "support-triage",
        owner: "authenticated builder",
        domain: DOMAIN,
      },
    },
    updatedAt: next,
  });
  const request = mutation({
    requestId: "spec-contract-request-123",
    expectedUpdatedAt: NOW,
  });
  const first = recordingDynamo([{}]);

  assert.deepEqual(
    await stateWith(first, () => next).putJourney({
      record,
      mutation: request,
    }),
    record,
  );
  const put = first.commands[0];
  assert.deepEqual(put.input.Item.expiresAt, {
    N: String(expiresAt(next)),
  });
  assert.match(put.input.ConditionExpression, /#actor = :actor/);
  assert.match(put.input.ConditionExpression, /#domainId = :domainId/);
  assert.match(put.input.ConditionExpression, /#preset = :preset/);
  assert.match(put.input.ConditionExpression, /#createdAt = :createdAt/);
  assert.match(put.input.ConditionExpression, /#updatedAt = :expectedUpdatedAt/);

  const replay = recordingDynamo([
    conditionalConflict(),
    { Item: put.input.Item },
  ]);
  assert.deepEqual(
    await stateWith(replay, () => next).putJourney({
      record,
      mutation: request,
    }),
    record,
  );
});

test("delivery reads reject cross-actor and cross-domain records", async () => {
  const writer = recordingDynamo([{}]);
  await stateWith(writer).putDeliveryIntent({
    record: delivery(),
    mutation: mutation(),
  });
  const item = writer.commands[0].input.Item;

  assert.deepEqual(
    await stateWith(recordingDynamo([{ Item: item }])).getDelivery({
      actor: ACTOR,
      domainId: DOMAIN,
      deliveryId: "delivery-123",
    }),
    delivery(),
  );

  for (const input of [
    {
      actor: "other-builder-sub",
      domainId: DOMAIN,
      deliveryId: "delivery-123",
    },
    {
      actor: ACTOR,
      domainId: "finance",
      deliveryId: "delivery-123",
    },
  ]) {
    await assert.rejects(
      stateWith(recordingDynamo([{ Item: item }])).getDelivery(input),
      (error) => error.code === "DELIVERY_SCOPE_MISMATCH",
    );
  }
});

test("delivery checkpoints follow the exact ordered transition contract", async () => {
  const writer = recordingDynamo([{}]);
  await stateWith(writer).putDeliveryIntent({
    record: delivery(),
    mutation: mutation(),
  });
  const initialItem = writer.commands[0].input.Item;
  const checkpoints = [
    {
      status: "APPROVED",
      at: NOW,
      github: {
        owner: "DemoPlatformOwner",
        repository: "support-triage-agent",
        visibility: "private",
      },
    },
    {
      status: "REPOSITORY_CREATING",
      at: NOW,
      github: {
        owner: "DemoPlatformOwner",
        repository: "support-triage-agent",
        visibility: "private",
      },
    },
    {
      status: "REPOSITORY_CREATED",
      at: NOW,
      github: {
        repositoryId: 123456,
        repositoryNodeId: "R_kgDOExample",
        htmlUrl: "https://github.com/DemoPlatformOwner/support-triage-agent",
      },
    },
    {
      status: "MAIN_BOOTSTRAPPED",
      at: NOW,
      github: {
        commitSha: "1".repeat(40),
      },
    },
    {
      status: "BRANCH_CREATED",
      at: NOW,
      github: {
        branchName: "platform/source",
        baseSha: "1".repeat(40),
      },
    },
    {
      status: "SOURCE_COMMITTED",
      at: NOW,
      github: {
        commitSha: "2".repeat(40),
        treeSha: "3".repeat(40),
      },
    },
    {
      status: "PULL_REQUEST_OPENED",
      at: NOW,
      github: {
        pullRequestNumber: 17,
        pullRequestNodeId: "PR_kwDOExample",
        htmlUrl:
          "https://github.com/DemoPlatformOwner/support-triage-agent/pull/17",
      },
    },
    {
      status: "COMPLETED",
      at: NOW,
      github: null,
    },
  ];

  let stored = initialItem;
  let expectedStatus = "PREVIEWED";
  const applied = [];
  for (const checkpoint of checkpoints) {
    applied.push(checkpoint);
    stored = checkpointedItem(stored, applied);
    const dynamo = recordingDynamo([{ Attributes: stored }]);
    const result = await stateWith(dynamo).checkpointDelivery({
      actor: ACTOR,
      domainId: DOMAIN,
      role: "builder",
      deliveryId: "delivery-123",
      expectedStatus,
      checkpoint,
    });
    assert.equal(result.status, checkpoint.status);
    assert.deepEqual(result.checkpoints, applied);
    const command = dynamo.commands[0];
    assert.ok(command instanceof UpdateItemCommand);
    assert.match(command.input.ConditionExpression, /#status = :expectedStatus/);
    assert.match(command.input.ConditionExpression, /#actor = :actor/);
    assert.match(command.input.ConditionExpression, /#domainId = :domainId/);
    assert.match(command.input.UpdateExpression, /#expiresAt = :expiresAt/);
    assert.equal(
      command.input.ExpressionAttributeNames["#expiresAt"],
      "expiresAt",
    );
    assert.deepEqual(
      command.input.ExpressionAttributeValues[":expiresAt"],
      { N: String(expiresAt(checkpoint.at)) },
    );
    if (checkpoint.status === "APPROVED") {
      assert.match(
        command.input.ConditionExpression,
        /#previewExpiresAt > :now/,
      );
    }
    expectedStatus = checkpoint.status;
  }
});

test("GitHub authorization intents are one-time state-bound records carrying the immutable actor scope", async () => {
  const record = githubAuthorizationIntent();
  const writer = recordingDynamo([{}]);
  assert.deepEqual(
    await stateWith(writer).putGitHubAuthorizationIntent({ record }),
    record,
  );
  assert.ok(writer.commands[0] instanceof PutItemCommand);
  const item = writer.commands[0].input.Item;
  assert.deepEqual(item.pk, {
    S: `GITHUB_AUTHORIZATION#${record.state}`,
  });
  assert.deepEqual(item.sk, { S: "GITHUB_AUTHORIZATION" });
  assert.deepEqual(item.expiresAt, {
    N: String(Math.floor(Date.parse(record.expiresAt) / 1000)),
  });
  assert.equal(item.record.M.accessToken, undefined);
  assert.equal(item.record.M.code, undefined);

  const consumedAt = "2026-08-27T01:03:03.000Z";
  const consumedItem = structuredClone(item);
  consumedItem.consumedAt = { S: consumedAt };
  consumedItem.record.M.consumedAt = { S: consumedAt };
  const reader = recordingDynamo([{ Attributes: consumedItem }]);
  const consumed = await stateWith(
    reader,
    () => consumedAt,
  ).consumeGitHubAuthorizationIntent({
    state: record.state,
  });
  assert.deepEqual(consumed, {
    ...record,
    consumedAt,
  });
  assert.ok(reader.commands[0] instanceof UpdateItemCommand);
  assert.doesNotMatch(
    reader.commands[0].input.ConditionExpression,
    /#actor|#domainId|#role/,
  );
  assert.match(
    reader.commands[0].input.ConditionExpression,
    /#consumedAt = :unconsumed/,
  );
  assert.match(
    reader.commands[0].input.ConditionExpression,
    /#expiresAt > :now/,
  );
  assert.equal(reader.commands.length, 1);

  await assert.rejects(
    stateWith(recordingDynamo([conditionalConflict()]))
      .consumeGitHubAuthorizationIntent({ state: record.state }),
    (error) => error.code === "GITHUB_AUTHORIZATION_CONFLICT",
  );
});

test("GitHub authorization intent creation replays only the same unconsumed binding", async () => {
  const original = githubAuthorizationIntent();
  const writer = recordingDynamo([{}]);
  await stateWith(writer).putGitHubAuthorizationIntent({
    record: original,
  });
  const item = writer.commands[0].input.Item;
  const retryAt = "2026-08-27T01:03:03.000Z";
  const retry = {
    ...original,
    createdAt: retryAt,
    expiresAt: "2026-08-27T01:13:03.000Z",
  };
  const replay = recordingDynamo([
    conditionalConflict(),
    { Item: item },
  ]);
  assert.deepEqual(
    await stateWith(replay, () => retryAt)
      .putGitHubAuthorizationIntent({ record: retry }),
    original,
  );
  assert.ok(replay.commands[0] instanceof PutItemCommand);
  assert.ok(replay.commands[1] instanceof GetItemCommand);
  assert.equal(replay.commands[1].input.ConsistentRead, true);

  const changed = recordingDynamo([
    conditionalConflict(),
    { Item: item },
  ]);
  await assert.rejects(
    stateWith(changed, () => retryAt).putGitHubAuthorizationIntent({
      record: {
        ...retry,
        requestId: "different-github-authorization-request",
      },
    }),
    (error) => error.code === "GITHUB_AUTHORIZATION_CONFLICT",
  );
});

test("GitHub authorization intents reject expiry, replay, and secret-bearing input", async () => {
  const record = githubAuthorizationIntent();

  for (const candidate of [
    {
      ...record,
      expiresAt: "2026-08-27T01:12:02.999Z",
    },
    {
      ...record,
      expiresAt: "2026-08-27T01:12:04.000Z",
    },
    {
      ...record,
      consumedAt: NOW,
    },
    {
      ...record,
      requestId: `ghp_${"x".repeat(40)}`,
    },
    {
      ...record,
      accessToken: `ghp_${"x".repeat(40)}`,
    },
    {
      ...record,
      code: "github-authorization-code",
    },
  ]) {
    const dynamo = recordingDynamo([]);
    await assert.rejects(
      stateWith(dynamo).putGitHubAuthorizationIntent({ record: candidate }),
      (error) => error.code === "INVALID_GITHUB_AUTHORIZATION",
    );
    assert.equal(dynamo.commands.length, 0);
  }

  await assert.rejects(
    stateWith(
      recordingDynamo([conditionalConflict()]),
      () => record.expiresAt,
    ).consumeGitHubAuthorizationIntent({
      state: record.state,
    }),
    (error) => error.code === "GITHUB_AUTHORIZATION_CONFLICT",
  );

  await assert.rejects(
    stateWith(recordingDynamo([conditionalConflict()]))
      .consumeGitHubAuthorizationIntent({
        state: record.state,
      }),
    (error) => error.code === "GITHUB_AUTHORIZATION_CONFLICT",
  );
});

test("journey and delivery decode fail closed on invalid TTL metadata", async () => {
  for (const [write, read, corruptCode] of [
    [
      (state) => state.putJourney({
        record: minimalJourney(),
        mutation: mutation(),
      }),
      (state) => state.getJourney({
        actor: ACTOR,
        domainId: DOMAIN,
        journeyId: "minimal-journey",
      }),
      "CORRUPT_JOURNEY_STATE",
    ],
    [
      (state) => state.putDeliveryIntent({
        record: delivery(),
        mutation: mutation(),
      }),
      (state) => state.getDelivery({
        actor: ACTOR,
        domainId: DOMAIN,
        deliveryId: "delivery-123",
      }),
      "CORRUPT_JOURNEY_STATE",
    ],
  ]) {
    const writer = recordingDynamo([{}]);
    await write(stateWith(writer));
    const validItem = writer.commands[0].input.Item;
    const invalidItems = [
      (() => {
        const item = structuredClone(validItem);
        delete item.expiresAt;
        return item;
      })(),
      {
        ...structuredClone(validItem),
        expiresAt: { S: String(expiresAt()) },
      },
      {
        ...structuredClone(validItem),
        expiresAt: { N: String(expiresAt() + 1) },
      },
    ];

    for (const item of invalidItems) {
      await assert.rejects(
        read(stateWith(recordingDynamo([{ Item: item }]))),
        (error) => error.code === corruptCode,
      );
    }
  }
});

test("journey and delivery remain readable after eight days and pending TTL deletion", async () => {
  const eightDaysLater = new Date(
    Date.parse(NOW) + (8 * 24 * 60 * 60 * 1000),
  ).toISOString();
  const afterExpiry = new Date((expiresAt() + 1) * 1000).toISOString();

  for (const [write, read, record] of [
    [
      (state) => state.putJourney({
        record: minimalJourney(),
        mutation: mutation(),
      }),
      (state) => state.getJourney({
        actor: ACTOR,
        domainId: DOMAIN,
        journeyId: "minimal-journey",
      }),
      minimalJourney(),
    ],
    [
      (state) => state.putDeliveryIntent({
        record: delivery(),
        mutation: mutation(),
      }),
      (state) => state.getDelivery({
        actor: ACTOR,
        domainId: DOMAIN,
        deliveryId: "delivery-123",
      }),
      delivery(),
    ],
  ]) {
    const writer = recordingDynamo([{}]);
    await write(stateWith(writer));
    const item = writer.commands[0].input.Item;

    for (const timestamp of [eightDaysLater, afterExpiry]) {
      assert.deepEqual(
        await read(stateWith(
          recordingDynamo([{ Item: item }]),
          () => timestamp,
        )),
        record,
      );
    }
  }
});

test("journey mutation updates refresh TTL and mutation decode validates it", async () => {
  const request = {
    actor: ACTOR,
    domainId: DOMAIN,
    effectiveRole: "builder",
    operation: "CREATE_JOURNEY",
    requestId: "ttl-mutation",
    payloadFingerprint: FINGERPRINT,
    resourceType: "JOURNEY",
    proposedResourceId: "minimal-journey",
  };
  const earlier = "2026-08-27T01:01:00.000Z";
  const writer = recordingDynamo([{}]);
  const claimed = await stateWith(writer, () => earlier).claimMutation(request);
  const item = writer.commands[0].input.Item;
  assert.deepEqual(item.expiresAt, { N: String(expiresAt(earlier)) });

  const reclaimed = recordingDynamo([
    conditionalConflict(),
    { Item: item },
    {},
  ]);
  await stateWith(reclaimed).claimMutation(request);
  const leaseUpdate = reclaimed.commands[2];
  assert.ok(leaseUpdate instanceof UpdateItemCommand);
  assert.match(leaseUpdate.input.UpdateExpression, /#expiresAt = :expiresAt/);
  assert.deepEqual(leaseUpdate.input.ExpressionAttributeValues[":expiresAt"], {
    N: String(expiresAt()),
  });

  const completed = recordingDynamo([{}]);
  await stateWith(completed).completeMutation({
    claim: claimed.claim,
    result: {
      resourceType: "JOURNEY",
      resourceId: "minimal-journey",
    },
  });
  assert.match(
    completed.commands[0].input.UpdateExpression,
    /#expiresAt = :expiresAt/,
  );
  assert.deepEqual(
    completed.commands[0].input.ExpressionAttributeValues[":expiresAt"],
    { N: String(expiresAt()) },
  );

  for (const expiresAtAttribute of [
    undefined,
    { S: String(expiresAt(earlier)) },
    { N: String(expiresAt(earlier) + 1) },
  ]) {
    const invalid = structuredClone(item);
    if (expiresAtAttribute === undefined) delete invalid.expiresAt;
    else invalid.expiresAt = expiresAtAttribute;
    await assert.rejects(
      stateWith(recordingDynamo([
        conditionalConflict(),
        { Item: invalid },
      ])).claimMutation(request),
      (error) => error.code === "CORRUPT_MUTATION_STATE",
    );
  }

  for (const timestamp of [
    new Date(Date.parse(earlier) + (8 * 24 * 60 * 60 * 1000)).toISOString(),
    new Date((expiresAt(earlier) + 1) * 1000).toISOString(),
  ]) {
    const delayedRetry = recordingDynamo([
      conditionalConflict(),
      { Item: item },
      {},
    ]);
    assert.equal(
      (await stateWith(
        delayedRetry,
        () => timestamp,
      ).claimMutation(request)).status,
      "CLAIMED",
    );
  }
});

test("checkpoint replay is exact and skipped or secret-bearing checkpoints fail closed", async () => {
  const writer = recordingDynamo([{}]);
  await stateWith(writer).putDeliveryIntent({
    record: delivery(),
    mutation: mutation(),
  });
  const checkpoint = {
    status: "APPROVED",
    at: NOW,
    github: {
      owner: "DemoPlatformOwner",
      repository: "support-triage-agent",
      visibility: "private",
    },
  };
  const approvedItem = checkpointedItem(
    writer.commands[0].input.Item,
    [checkpoint],
  );
  const replay = recordingDynamo([
    conditionalConflict(),
    { Item: approvedItem },
  ]);
  const result = await stateWith(replay).checkpointDelivery({
    actor: ACTOR,
    domainId: DOMAIN,
    role: "builder",
    deliveryId: "delivery-123",
    expectedStatus: "PREVIEWED",
    checkpoint,
  });
  assert.equal(result.status, "APPROVED");
  assert.ok(replay.commands[1] instanceof GetItemCommand);

  const later = "2026-08-27T01:03:03.000Z";
  const delayedReplay = recordingDynamo([
    conditionalConflict(),
    { Item: approvedItem },
  ]);
  const delayedResult = await stateWith(
    delayedReplay,
    () => later,
  ).checkpointDelivery({
    actor: ACTOR,
    domainId: DOMAIN,
    role: "builder",
    deliveryId: "delivery-123",
    expectedStatus: "PREVIEWED",
    checkpoint: {
      ...checkpoint,
      at: later,
    },
  });
  assert.equal(delayedResult.status, "APPROVED");
  assert.equal(delayedResult.checkpoints.at(-1).at, NOW);

  const invalid = [
    {
      expectedStatus: "PREVIEWED",
      checkpoint: {
        status: "BRANCH_CREATED",
        at: NOW,
        github: {
          branchName: "platform/source",
          baseSha: "1".repeat(40),
        },
      },
    },
    {
      expectedStatus: "PREVIEWED",
      checkpoint: {
        ...checkpoint,
        github: {
          ...checkpoint.github,
          repository: "ghp_" + "x".repeat(40),
        },
      },
    },
  ];
  for (const candidate of invalid) {
    const dynamo = recordingDynamo([]);
    await assert.rejects(
      stateWith(dynamo).checkpointDelivery({
        actor: ACTOR,
        domainId: DOMAIN,
        role: "builder",
        deliveryId: "delivery-123",
        ...candidate,
      }),
      (error) => error.code === "INVALID_DELIVERY_CHECKPOINT",
    );
    assert.equal(dynamo.commands.length, 0);
  }

  const changedCheckpoint = {
    ...checkpoint,
    github: {
      ...checkpoint.github,
      repository: "other-repository",
    },
  };
  await assert.rejects(
    stateWith(recordingDynamo([
      conditionalConflict(),
      { Item: approvedItem },
    ])).checkpointDelivery({
      actor: ACTOR,
      domainId: DOMAIN,
      role: "builder",
      deliveryId: "delivery-123",
      expectedStatus: "PREVIEWED",
      checkpoint: changedCheckpoint,
    }),
    (error) => error.code === "DELIVERY_CONFLICT",
  );
});

test("FULL snapshots persist only exact portable resource bindings", async () => {
  const record = delivery();
  const dynamo = recordingDynamo([{}]);
  assert.deepEqual(
    await stateWith(dynamo).putDeliveryIntent({
      record,
      mutation: mutation(),
    }),
    record,
  );
  assert.ok(dynamo.commands[0] instanceof PutItemCommand);

  for (const resource of [
    {
      ...record.source.snapshot.resources[0],
      content: {
        credential: `ghp_${"x".repeat(40)}`,
      },
    },
    {
      ...record.source.snapshot.resources[0],
      binding: {
        ...record.source.snapshot.resources[0].binding,
        secret: "not-portable",
      },
    },
    {
      ...record.source.snapshot.resources[0],
      binding: {
        adapter: "browser",
        status: "DEPLOYMENT_REQUIRED",
      },
    },
  ]) {
    const candidate = structuredClone(record);
    candidate.source.snapshot.resources[0] = resource;
    await assert.rejects(
      stateWith(recordingDynamo([])).putDeliveryIntent({
        record: candidate,
        mutation: mutation(),
      }),
      (error) => error.code === "INVALID_DELIVERY",
    );
  }
});

test('initial export commits complete main source before completion and retains legacy histories',async()=>{
 const writer=recordingDynamo([{}]);await stateWith(writer).putDeliveryIntent({record:delivery(),mutation:mutation()});let stored=writer.commands[0].input.Item;
 const owner={owner:'DemoPlatformOwner',repository:'support-triage-agent',visibility:'private'};
 const history=[{status:'APPROVED',at:NOW,github:owner},{status:'REPOSITORY_CREATING',at:NOW,github:owner},{status:'REPOSITORY_CREATED',at:NOW,github:{repositoryId:123456,repositoryNodeId:'R_example',htmlUrl:'https://github.com/DemoPlatformOwner/support-triage-agent'}},{status:'INITIAL_SOURCE_COMMITTED',at:NOW,github:{commitSha:'1'.repeat(40),treeSha:'2'.repeat(40)}},{status:'COMPLETED',at:NOW,github:null}];
 let expectedStatus='PREVIEWED';const applied=[];
 for(const checkpoint of history){applied.push(checkpoint);stored=checkpointedItem(stored,applied);const dynamo=recordingDynamo([{Attributes:stored}]);const result=await stateWith(dynamo).checkpointDelivery({actor:ACTOR,domainId:DOMAIN,role:'builder',deliveryId:'delivery-123',expectedStatus,checkpoint});assert.equal(result.status,checkpoint.status);assert.deepEqual(result.checkpoints,applied);expectedStatus=checkpoint.status;}
 const denied=recordingDynamo([]);await assert.rejects(stateWith(denied).checkpointDelivery({actor:ACTOR,domainId:DOMAIN,role:'builder',deliveryId:'delivery-123',expectedStatus:'REPOSITORY_CREATED',checkpoint:{status:'COMPLETED',at:NOW,github:null}}));assert.equal(denied.commands.length,0);
});
