import assert from "node:assert/strict";
import test from "node:test";

import {
  createBuilderResourceAccessResolver,
} from "../lambda/builder/resource-access.mjs";

function entry({
  id,
  type = "Skill",
  domain = "customer_support",
  registryId = "registry123456",
  recordId = id,
  content = { toolType: "lambda" },
  status = "APPROVED",
}) {
  return {
    id,
    type,
    domain,
    defaultVersion: "1.0.0",
    versions: [{
      semver: "1.0.0",
      status,
      content,
      _aws: { registryId, recordId },
    }],
  };
}

function payload(overrides = {}) {
  return {
    domainId: "customer_support",
    toolIds: ["order_lookup"],
    mcpServerIds: [],
    skillIds: [],
    blueprintIds: ["chat-assistant"],
    memoryIds: [],
    knowledgeBaseIds: [],
    ...overrides,
  };
}

test("approved same-domain resources need no duplicate grant", async () => {
  const resolve = createBuilderResourceAccessResolver({
    inventoryProvider: async () => ({
      registry: {
        entries: [
          entry({ id: "order_lookup" }),
          entry({
            id: "chat-assistant",
            type: "Blueprint",
            domain: "shared",
            content: { template: {} },
          }),
        ],
      },
    }),
  });

  assert.deepEqual(
    await resolve({
      identity: {
        role: "builder",
        activeDomain: "customer_support",
      },
      payload: payload(),
    }),
    [],
  );
});

test("Platform Admin resolves resources in the selected authorized project domain", async () => {
  const scopes = [];
  const resolve = createBuilderResourceAccessResolver({
    inventoryProvider: async (scope) => {
      scopes.push(scope);
      return {
        registry: {
          entries: [
            entry({
              id: "chat-assistant",
              type: "Blueprint",
              domain: "shared",
              content: { template: {} },
            }),
          ],
        },
      };
    },
  });

  assert.deepEqual(
    await resolve({
      identity: {
        role: "admin",
        activeDomain: null,
        domainIds: ["customer_support", "operations", "platform"],
      },
      payload: payload({
        domainId: "platform",
        toolIds: [],
      }),
    }),
    [],
  );
  assert.deepEqual(scopes, [{
    role: "admin",
    activeDomain: "platform",
    allowedDomains: ["platform"],
  }]);
});

test("Platform Admin cannot resolve resources outside authoritative domains", async () => {
  const resolve = createBuilderResourceAccessResolver({
    inventoryProvider: async () => {
      assert.fail("Unauthorized Admin domains must fail before inventory.");
    },
  });

  await assert.rejects(
    resolve({
      identity: {
        role: "admin",
        activeDomain: null,
        domainIds: ["customer_support", "operations", "platform"],
      },
      payload: payload({
        domainId: "other",
        toolIds: [],
      }),
    }),
    /resource access request is invalid/,
  );
});

test("approved shared resources require their exact canonical grant", async () => {
  const shared = entry({
    id: "shared_search",
    domain: "shared",
    registryId: "sharedreg1234",
    recordId: "sharedrecord1234",
  });
  const resolve = createBuilderResourceAccessResolver({
    inventoryProvider: async () => ({
      registry: {
        entries: [
          shared,
          entry({
            id: "chat-assistant",
            type: "Blueprint",
            domain: "shared",
            content: { template: {} },
          }),
        ],
      },
    }),
  });

  assert.deepEqual(
    await resolve({
      identity: {
        role: "builder",
        activeDomain: "customer_support",
      },
      payload: payload({
        toolIds: ["sharedreg1234/sharedrecord1234"],
      }),
    }),
    [{
      resourceType: "TOOL",
      resourceId: "sharedreg1234/sharedrecord1234",
    }],
  );
});

test("missing, unapproved, or wrong-type selections fail closed", async () => {
  for (const entries of [
    [],
    [entry({ id: "order_lookup", status: "DRAFT" })],
    [entry({ id: "order_lookup", type: "MCPServer" })],
  ]) {
    const resolve = createBuilderResourceAccessResolver({
      inventoryProvider: async () => ({
        registry: {
          entries: [
            ...entries,
            entry({
              id: "chat-assistant",
              type: "Blueprint",
              domain: "shared",
              content: { template: {} },
            }),
          ],
        },
      }),
    });
    await assert.rejects(
      resolve({
        identity: {
          role: "builder",
          activeDomain: "customer_support",
        },
        payload: payload(),
      }),
      /selected resource is unavailable/,
    );
  }
});
