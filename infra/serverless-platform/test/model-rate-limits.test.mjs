import assert from "node:assert/strict";
import test from "node:test";

import {
  BatchPutGatewayRateLimitsCommand,
  ListGatewayRateLimitsCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

const GATEWAY_IDENTIFIER = "platform-llm-gateway-a1b2c3d4e5";
const RATE_LIMIT_ID = "platform-model-domain-limits";
const DESCRIPTION = "Platform-managed model and domain traffic limits.";
const NOW = new Date("2026-08-25T07:00:00.000Z");
const DIMENSION_KEYS = [
  "qualifiedModelId",
  "$.context.iam.sourceIdentity",
];

function managedRateLimit({
  gatewayIdentifier = GATEWAY_IDENTIFIER,
  rateLimitId = RATE_LIMIT_ID,
  description = DESCRIPTION,
  entries,
  status = "ACTIVE",
} = {}) {
  return {
    rateLimitId,
    gatewayIdentifier,
    description,
    dimensionKeys: [...DIMENSION_KEYS],
    entries: entries ?? [
      {
        dimensions: {
          qualifiedModelId: "anthropic.claude-sonnet",
          "$.context.iam.sourceIdentity": "domain_finance",
        },
        requests: [{ rate: 60, period: "minute" }],
      },
    ],
    status,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    updatedAt: new Date("2026-08-25T00:01:00.000Z"),
  };
}

function policies() {
  return [
    {
      modelId: "openai.gpt-oss",
      allowedDomains: ["operations"],
      requestableDomains: [],
      limits: {
        requestsPerMinute: null,
        tokensPerMinute: null,
        connectionsPerSecond: 3,
      },
    },
    {
      modelId: "anthropic.claude-sonnet",
      allowedDomains: ["finance"],
      requestableDomains: ["engineering"],
      limits: {
        requestsPerMinute: 60,
        tokensPerMinute: 120_000,
        connectionsPerSecond: 4,
      },
    },
  ];
}

function expectedEntries() {
  return [
    {
      dimensions: {
        qualifiedModelId: "anthropic.claude-sonnet",
        "$.context.iam.sourceIdentity": "domain_engineering",
      },
      requests: [{ rate: 60, period: "minute" }],
      tokens: [{ rate: 120_000, period: "minute" }],
      connections: [{ rate: 4, period: "second" }],
    },
    {
      dimensions: {
        qualifiedModelId: "anthropic.claude-sonnet",
        "$.context.iam.sourceIdentity": "domain_finance",
      },
      requests: [{ rate: 60, period: "minute" }],
      tokens: [{ rate: 120_000, period: "minute" }],
      connections: [{ rate: 4, period: "second" }],
    },
    {
      dimensions: {
        qualifiedModelId: "openai.gpt-oss",
        "$.context.iam.sourceIdentity": "domain_operations",
      },
      connections: [{ rate: 3, period: "second" }],
    },
  ];
}

async function loadSubject() {
  return import("../lambda/model-governance/rate-limits.mjs");
}

test("exports a native AgentCore Gateway rate-limit reconciler", async () => {
  const module = await loadSubject();

  assert.equal(typeof module.createGatewayRateLimitReconciler, "function");
});

test("translates policies into one deterministic native rate limit with exact ordered dimensions", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof ListGatewayRateLimitsCommand) {
        return { rateLimits: [] };
      }
      if (command instanceof BatchPutGatewayRateLimitsCommand) {
        const [rateLimit] = command.input.rateLimits;
        return {
          rateLimits: [
            managedRateLimit({
              entries: rateLimit.entries,
            }),
          ],
        };
      }
      throw new Error("Unexpected command.");
    },
  };

  const reconciler = createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    now: () => NOW,
  });
  const result = await reconciler.reconcile({ policies: policies().reverse() });

  assert.equal(commands.length, 2);
  assert.ok(commands[0] instanceof ListGatewayRateLimitsCommand);
  assert.deepEqual(commands[0].input, {
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    maxResults: 50,
  });
  assert.ok(commands[1] instanceof BatchPutGatewayRateLimitsCommand);
  assert.match(commands[1].input.clientToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(commands[1].input.rateLimits, [
    {
      rateLimitId: RATE_LIMIT_ID,
      description: DESCRIPTION,
      dimensionKeys: DIMENSION_KEYS,
      entries: expectedEntries(),
    },
  ]);
  assert.deepEqual(result, {
    changed: true,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    rateLimitId: RATE_LIMIT_ID,
    status: "ACTIVE",
    entryCount: 3,
    clientToken: commands[1].input.clientToken,
    synchronizedAt: NOW.toISOString(),
  });
});

test("accepts omitted optional limit dimensions", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof ListGatewayRateLimitsCommand) {
        return { rateLimits: [] };
      }
      return {
        rateLimits: [
          managedRateLimit({
            entries: command.input.rateLimits[0].entries,
          }),
        ],
      };
    },
  };

  await createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
  }).reconcile({
    policies: [{
      modelId: "openai.gpt-oss",
      allowedDomains: ["operations"],
      requestableDomains: [],
      limits: { connectionsPerSecond: 3 },
    }],
  });

  assert.deepEqual(commands[1].input.rateLimits[0].entries, [
    {
      dimensions: {
        qualifiedModelId: "openai.gpt-oss",
        "$.context.iam.sourceIdentity": "domain_operations",
      },
      connections: [{ rate: 3, period: "second" }],
    },
  ]);
});

test("bounds long canonical domain identities for STS source identity", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const domainId = `a${"b".repeat(63)}`;
  let batched;
  const client = {
    async send(command) {
      if (command instanceof ListGatewayRateLimitsCommand) {
        return { rateLimits: [] };
      }
      batched = structuredClone(command.input);
      return {
        rateLimits: [
          managedRateLimit({
            entries: command.input.rateLimits[0].entries,
          }),
        ],
      };
    },
  };

  await createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
  }).reconcile({
    policies: [{
      modelId: "openai.gpt-oss",
      allowedDomains: [domainId],
      requestableDomains: [],
      limits: { connectionsPerSecond: 3 },
    }],
  });

  const sourceIdentity = batched.rateLimits[0].entries[0]
    .dimensions["$.context.iam.sourceIdentity"];
  assert.match(sourceIdentity, /^domain_[a-z0-9_]+$/);
  assert.equal(sourceIdentity.length, 64);
  assert.notEqual(sourceIdentity, domainId);
});

test("keeps the platform domain distinct from platform services", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  let batched;
  const client = {
    async send(command) {
      if (command instanceof ListGatewayRateLimitsCommand) {
        return { rateLimits: [] };
      }
      batched = structuredClone(command.input);
      return {
        rateLimits: [
          managedRateLimit({
            entries: command.input.rateLimits[0].entries,
          }),
        ],
      };
    },
  };

  await createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
  }).reconcile({
    policies: [{
      modelId: "openai.gpt-oss",
      allowedDomains: ["platform"],
      requestableDomains: [],
      limits: { connectionsPerSecond: 3 },
    }],
  });

  assert.equal(
    batched.rateLimits[0].entries[0]
      .dimensions["$.context.iam.sourceIdentity"],
    "domain_platform",
  );
});

test("replaces stale Gateway rate limits with an empty complete set", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof ListGatewayRateLimitsCommand) {
        return { rateLimits: [managedRateLimit()] };
      }
      assert.ok(command instanceof BatchPutGatewayRateLimitsCommand);
      assert.deepEqual(command.input.rateLimits, []);
      return { rateLimits: [] };
    },
  };

  const result = await createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    now: () => NOW,
  }).reconcile({ policies: [] });

  assert.equal(commands.length, 2);
  assert.deepEqual(result, {
    changed: true,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    rateLimitId: RATE_LIMIT_ID,
    status: "ACTIVE",
    entryCount: 0,
    clientToken: commands[1].input.clientToken,
    synchronizedAt: NOW.toISOString(),
  });
});

test("empty Gateway rate-limit reconciliation is idempotent", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      return { rateLimits: [] };
    },
  };

  const result = await createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    now: () => NOW,
  }).reconcile({ policies: [] });

  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof ListGatewayRateLimitsCommand);
  assert.equal(result.changed, false);
  assert.equal(result.rateLimitId, RATE_LIMIT_ID);
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.entryCount, 0);
});

test("lists every page then replaces the complete set without preserving unmanaged definitions", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const commands = [];
  const existingEntry = managedRateLimit().entries[0];
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof ListGatewayRateLimitsCommand) {
        if (command.input.nextToken === undefined) {
          return {
            rateLimits: [
              managedRateLimit({
                rateLimitId: "legacy-platform-limit",
                entries: [existingEntry],
              }),
            ],
            nextToken: "next-page",
          };
        }
        return {
          rateLimits: [
            managedRateLimit({
              rateLimitId: "customer-limit-to-replace",
              entries: [existingEntry],
            }),
          ],
        };
      }
      if (command instanceof BatchPutGatewayRateLimitsCommand) {
        return {
          rateLimits: [
            managedRateLimit({
              entries: command.input.rateLimits[0].entries,
            }),
          ],
        };
      }
      throw new Error("Unexpected command.");
    },
  };

  await createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
  }).reconcile({ policies: policies() });

  assert.equal(commands.length, 3);
  assert.deepEqual(commands[1].input, {
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    maxResults: 50,
    nextToken: "next-page",
  });
  assert.equal(commands[2].input.rateLimits.length, 1);
  assert.equal(commands[2].input.rateLimits[0].rateLimitId, RATE_LIMIT_ID);
});

test("is idempotent for the same semantic policy set and skips an identical batch", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const batchInputs = [];

  async function firstRun(inputPolicies) {
    const client = {
      async send(command) {
        if (command instanceof ListGatewayRateLimitsCommand) {
          return { rateLimits: [] };
        }
        batchInputs.push(structuredClone(command.input));
        return {
          rateLimits: [
            managedRateLimit({
              entries: command.input.rateLimits[0].entries,
            }),
          ],
        };
      },
    };
    return createGatewayRateLimitReconciler({
      client,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
    }).reconcile({ policies: inputPolicies });
  }

  await firstRun(policies());
  await firstRun([
    {
      ...policies()[1],
      allowedDomains: ["finance"],
      requestableDomains: ["engineering"],
    },
    policies()[0],
  ]);

  assert.deepEqual(batchInputs[0], batchInputs[1]);

  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      return {
        rateLimits: [
          managedRateLimit({
            entries: expectedEntries(),
          }),
        ],
      };
    },
  };

  const result = await createGatewayRateLimitReconciler({
    client,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    now: () => NOW,
  }).reconcile({ policies: policies() });

  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof ListGatewayRateLimitsCommand);
  assert.deepEqual(result, {
    changed: false,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    rateLimitId: RATE_LIMIT_ID,
    status: "ACTIVE",
    entryCount: 3,
    clientToken: batchInputs[0].clientToken,
    synchronizedAt: NOW.toISOString(),
  });
});

test("rejects more than the native maximum of 1000 entries before any AWS call", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  let calls = 0;
  const client = {
    async send() {
      calls += 1;
      throw new Error("AWS should not be called.");
    },
  };
  const domains = Array.from(
    { length: 1001 },
    (_, index) => `domain-${String(index).padStart(4, "0")}`,
  );

  await assert.rejects(
    createGatewayRateLimitReconciler({
      client,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
    }).reconcile({
      policies: [
        {
          modelId: "anthropic.claude-sonnet",
          allowedDomains: domains,
          requestableDomains: [],
          limits: {
            requestsPerMinute: 1,
            tokensPerMinute: null,
            connectionsPerSecond: null,
          },
        },
      ],
    }),
    (error) => error?.code === "RATE_LIMIT_ENTRY_LIMIT_EXCEEDED",
  );

  await assert.rejects(
    createGatewayRateLimitReconciler({
      client,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
    }).reconcile({
      policies: Array.from(
        { length: 1001 },
        (_, index) => ({
          modelId: `provider.model-${index}`,
          allowedDomains: ["finance"],
          requestableDomains: [],
          limits: {
            requestsPerMinute: 1,
            tokensPerMinute: null,
            connectionsPerSecond: null,
          },
        }),
      ),
    }),
    (error) => error?.code === "RATE_LIMIT_ENTRY_LIMIT_EXCEEDED",
  );
  assert.equal(calls, 0);
});

test("validates the complete policy set before listing or mutating the Gateway", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const invalidPolicies = [
    {
      name: "overlapping domains",
      value: [{
        modelId: "anthropic.claude-sonnet",
        allowedDomains: ["finance"],
        requestableDomains: ["finance"],
        limits: {
          requestsPerMinute: 1,
          tokensPerMinute: null,
          connectionsPerSecond: null,
        },
      }],
    },
    {
      name: "duplicate model-domain entries",
      value: [
        {
          modelId: "anthropic.claude-sonnet",
          allowedDomains: ["finance"],
          requestableDomains: [],
          limits: {
            requestsPerMinute: 1,
            tokensPerMinute: null,
            connectionsPerSecond: null,
          },
        },
        {
          modelId: "anthropic.claude-sonnet",
          allowedDomains: ["finance"],
          requestableDomains: [],
          limits: {
            requestsPerMinute: null,
            tokensPerMinute: 1,
            connectionsPerSecond: null,
          },
        },
      ],
    },
    {
      name: "missing limits",
      value: [{
        modelId: "anthropic.claude-sonnet",
        allowedDomains: ["finance"],
        requestableDomains: [],
        limits: {
          requestsPerMinute: null,
          tokensPerMinute: null,
          connectionsPerSecond: null,
        },
      }],
    },
    {
      name: "unsafe request rate value",
      value: [{
        modelId: "anthropic.claude-sonnet",
        allowedDomains: ["finance"],
        requestableDomains: [],
        limits: {
          requestsPerMinute: 1_000_001,
          tokensPerMinute: 1,
          connectionsPerSecond: 1,
        },
      }],
    },
    {
      name: "unsafe token rate value",
      value: [{
        modelId: "anthropic.claude-sonnet",
        allowedDomains: ["finance"],
        requestableDomains: [],
        limits: {
          requestsPerMinute: 1,
          tokensPerMinute: 1_000_000_001,
          connectionsPerSecond: 1,
        },
      }],
    },
    {
      name: "unsafe connection rate value",
      value: [{
        modelId: "anthropic.claude-sonnet",
        allowedDomains: ["finance"],
        requestableDomains: [],
        limits: {
          requestsPerMinute: 1,
          tokensPerMinute: 1,
          connectionsPerSecond: 10_001,
        },
      }],
    },
  ];

  for (const fixture of invalidPolicies) {
    let calls = 0;
    const client = {
      async send() {
        calls += 1;
      },
    };
    await assert.rejects(
      createGatewayRateLimitReconciler({
        client,
        gatewayIdentifier: GATEWAY_IDENTIFIER,
      }).reconcile({ policies: fixture.value }),
      (error) => {
        assert.equal(error?.code, "INVALID_GATEWAY_RATE_LIMIT_POLICY");
        assert.match(error.message, new RegExp(fixture.name.split(" ")[0], "i"));
        return true;
      },
    );
    assert.equal(calls, 0);
  }
});

test("rejects malformed paginated ListGatewayRateLimits responses without batching", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const fixtures = [
    {
      name: "missing collection",
      response: {},
    },
    {
      name: "foreign gateway detail",
      response: {
        rateLimits: [
          managedRateLimit({
            gatewayIdentifier: "foreign-gateway-z9y8x7w6v5",
          }),
        ],
      },
    },
    {
      name: "too many definitions",
      response: {
        rateLimits: Array.from(
          { length: 51 },
          (_, index) => managedRateLimit({
            rateLimitId: `existing-${index}`,
          }),
        ),
      },
    },
  ];

  for (const fixture of fixtures) {
    const commands = [];
    const client = {
      async send(command) {
        commands.push(command);
        return fixture.response;
      },
    };
    await assert.rejects(
      createGatewayRateLimitReconciler({
        client,
        gatewayIdentifier: GATEWAY_IDENTIFIER,
      }).reconcile({ policies: policies() }),
      (error) => error?.code === "MALFORMED_GATEWAY_RATE_LIMIT_RESPONSE",
      fixture.name,
    );
    assert.equal(commands.length, 1, fixture.name);
    assert.ok(commands[0] instanceof ListGatewayRateLimitsCommand);
  }

  const repeatedTokenCommands = [];
  const repeatedTokenClient = {
    async send(command) {
      repeatedTokenCommands.push(command);
      return {
        rateLimits: [],
        nextToken: "same-token",
      };
    },
  };
  await assert.rejects(
    createGatewayRateLimitReconciler({
      client: repeatedTokenClient,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
    }).reconcile({ policies: policies() }),
    (error) => error?.code === "MALFORMED_GATEWAY_RATE_LIMIT_RESPONSE",
  );
  assert.equal(repeatedTokenCommands.length, 2);
});

test("rejects malformed or partial BatchPutGatewayRateLimits responses", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const fixtures = [
    {
      name: "missing collection",
      response: {},
    },
    {
      name: "empty collection",
      response: { rateLimits: [] },
    },
    {
      name: "wrong identifier",
      response: {
        rateLimits: [
          managedRateLimit({ rateLimitId: "unexpected-rate-limit" }),
        ],
      },
    },
    {
      name: "partial entries",
      response: {
        rateLimits: [
          managedRateLimit({ entries: expectedEntries().slice(0, 1) }),
        ],
      },
    },
  ];

  for (const fixture of fixtures) {
    const commands = [];
    const client = {
      async send(command) {
        commands.push(command);
        if (command instanceof ListGatewayRateLimitsCommand) {
          return { rateLimits: [] };
        }
        return fixture.response;
      },
    };
    await assert.rejects(
      createGatewayRateLimitReconciler({
        client,
        gatewayIdentifier: GATEWAY_IDENTIFIER,
      }).reconcile({ policies: policies() }),
      (error) => error?.code === "MALFORMED_GATEWAY_RATE_LIMIT_RESPONSE",
      fixture.name,
    );
    assert.equal(commands.length, 2, fixture.name);
    assert.ok(commands[1] instanceof BatchPutGatewayRateLimitsCommand);
  }
});

test("propagates a failed atomic batch and never reports partial success", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const commands = [];
  const expected = Object.assign(new Error("AgentCore rejected the batch."), {
    name: "ValidationException",
  });
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof ListGatewayRateLimitsCommand) {
        return { rateLimits: [] };
      }
      throw expected;
    },
  };

  await assert.rejects(
    createGatewayRateLimitReconciler({
      client,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
    }).reconcile({ policies: policies() }),
    (error) => error === expected,
  );
  assert.equal(commands.length, 2);
  assert.ok(commands[1] instanceof BatchPutGatewayRateLimitsCommand);
});

test("does not report reconciliation evidence until AgentCore returns ACTIVE", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  const client = {
    async send(command) {
      if (command instanceof ListGatewayRateLimitsCommand) {
        return { rateLimits: [] };
      }
      return {
        rateLimits: [
          managedRateLimit({
            entries: expectedEntries(),
            status: "UPDATING",
          }),
        ],
      };
    },
  };

  await assert.rejects(
    createGatewayRateLimitReconciler({
      client,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
    }).reconcile({ policies: policies() }),
    (error) => error?.code === "GATEWAY_RATE_LIMIT_NOT_ACTIVE",
  );
});

test("rejects an invalid reconciliation clock before any AWS operation", async () => {
  const { createGatewayRateLimitReconciler } = await loadSubject();
  let calls = 0;
  const client = {
    async send() {
      calls += 1;
      return { rateLimits: [] };
    },
  };

  await assert.rejects(
    createGatewayRateLimitReconciler({
      client,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
      now: () => new Date("invalid"),
    }).reconcile({ policies: policies() }),
    (error) => error?.code === "INVALID_GATEWAY_RATE_LIMIT_CONFIG",
  );
  assert.equal(calls, 0);
});
