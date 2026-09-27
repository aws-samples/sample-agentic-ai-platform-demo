import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { adaptFleet } from "./public/main-ui-compat.mjs";
const source = readFileSync(new URL("./public/modules/app.mjs", import.meta.url), "utf8");
const fn = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
};
const hostedAgentDetail = vm.runInNewContext(
  `${fn("hostedAgentDetail")}; hostedAgentDetail`,
  {},
);

const agent = {
  domainId: "customer_support",
  projectId: "case-assist",
  id: "case-summarizer",
  name: "Case Summarizer",
  description: "Summarizes an open case.",
  ownerSubject: "operator",
  modelId: "bedrock-claude/anthropic.claude-haiku-4-5",
  blueprintIds: [],
  skillIds: ["customer-support"],
  toolIds: ["order_lookup"],
  mcpServerIds: ["platform-tools"],
  memoryIds: [],
  knowledgeBaseIds: [],
  buildConfig: {
    instructions: "Summarize the case.",
    modelParameters: { temperature: 0.2, maxTokens: 1024 },
    buildOptions: {
      framework: "Strands",
      deployTarget: "AgentCore Runtime",
      memory: "shortTerm",
      streaming: true,
      identity: true,
      guardrails: true,
    },
  },
  status: "DRAFT",
  updatedAt: "2026-09-14T01:00:00.000Z",
};

// The fleet projection is the detail panel's only source in hosted mode, so a
// dropped field here renders as blank metadata rather than an error.
test("fleet projection carries the configuration the detail panel reads", () => {
  const fleet = adaptFleet({ ok: true, items: [agent] }, { ok: true, items: [] }, { ok: true, items: [] });
  const record = fleet.agents[0];
  const detail = hostedAgentDetail(record);
  assert.equal(detail.runtime, "AgentCore Runtime");
  assert.equal(detail.model, "bedrock-claude/anthropic.claude-haiku-4-5");
  assert.equal(detail.persona, "Summarize the case.");
  // vm realm objects are not reference-equal to this realm's, so compare JSON.
  assert.equal(JSON.stringify(detail.skills), JSON.stringify([{ id: "customer-support" }]));
  assert.equal(JSON.stringify(detail.tools), JSON.stringify([
    { id: "order_lookup", type: "tool" },
    { id: "platform-tools", type: "MCP" },
  ]));
  assert.equal(detail.identity, "Cognito CUSTOM_JWT");
  assert.equal(detail.domain, "customer_support");
  assert.equal(detail.owningProject, "case-assist");
});

// Undeployed agents must not claim runtime telemetry or a provisioned store.
test("an undeployed agent reports unset configuration instead of inventing it", () => {
  const detail = hostedAgentDetail(hostedRecord({ status: "DRAFT" }));
  assert.equal(detail.observability, "not deployed yet");
  assert.equal(detail.memory, null);
  assert.equal(detail.memoryMode, "shortTerm");
  assert.equal(detail.deployedArn, null);
  const bare = hostedAgentDetail({ domainId: "d", projectId: "p", id: "a", name: "A" });
  assert.equal(bare.runtime, "not configured");
  assert.equal(bare.identity, "none");
  assert.equal(bare.model, null);
  assert.equal(bare.skills.length, 0);
  assert.equal(hostedAgentDetail(null), null);
});

test("a deployed agent reports live observability", () => {
  assert.equal(
    hostedAgentDetail(hostedRecord({ status: "READY" })).observability,
    "CloudWatch + OTEL",
  );
});

function hostedRecord(overrides) {
  const fleet = adaptFleet(
    { ok: true, items: [{ ...agent, ...overrides }] },
    { ok: true, items: [] },
    { ok: true, items: [] },
  );
  return { ...fleet.agents[0], ...overrides };
}
