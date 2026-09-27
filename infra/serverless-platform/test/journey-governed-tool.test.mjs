import assert from "node:assert/strict";
import test from "node:test";
import {
  createPortableResourceBinding,
  validPortableResourceBinding,
} from "../lambda/journeys/resource-binding.mjs";

// Offline fixture identifiers only. These do not describe deployed resources.
function approvedContent() {
  const account = "000000" + "000000";
  return {
    toolType: "agentcore_gateway",
    gatewayBinding: {
      schemaVersion: 1,
      operation: "add_numbers",
      region: "us-west-2",
      gatewayArn: `arn:aws:bedrock-agentcore:us-west-2:${account}:gateway/fixture-math-abcdefghij`,
      endpoint: "https://fixture-math-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp",
      targetId: "fixturetarget",
      targetName: "fixture-math",
      qualifiedToolName: "fixture-math___add_numbers",
      protocolVersion: "2026-07-28",
      auth: "AWS_IAM",
      policy: {
        engineArn: `arn:aws:bedrock-agentcore:us-west-2:${account}:policy-engine/fixture-engine`,
        policyId: "fixture-policy",
        definitionSha256: "a".repeat(64),
        enforcementMode: "ENFORCE",
      },
    },
  };
}

test("approved Gateway binding preserves only the strict reviewed contract", () => {
  const content = approvedContent();
  content.description = "ignored catalog text";
  const binding = createPortableResourceBinding("TOOL", content);
  assert.equal(binding.status, "MATERIALIZED");
  assert.deepEqual(binding.gateway, content.gatewayBinding);
  assert.equal(validPortableResourceBinding("TOOL", binding), true);
  content.gatewayBinding.targetId = "changed";
  assert.equal(binding.gateway.targetId, "fixturetarget");
  assert.equal(validPortableResourceBinding("MCP_SERVER", binding), false);
});

test("missing Gateway binding remains explicit DEPLOYMENT_REQUIRED", () => {
  assert.deepEqual(createPortableResourceBinding("TOOL", {
    toolType: "agentcore_gateway", gatewayUrl: "https://unapproved.invalid/mcp",
  }), { adapter: "agentcore_gateway", status: "DEPLOYMENT_REQUIRED" });
});

test("malicious, ambiguous and unsupported binding metadata fails closed", () => {
  const mutations = [
    (v) => { v.schemaVersion = 2; },
    (v) => { v.operation = "send_email"; },
    (v) => { v.auth = "NONE"; },
    (v) => { v.protocolVersion = "2025-06-18"; },
    (v) => { v.endpoint = "https://attacker.invalid/mcp"; },
    (v) => { v.endpoint += "?token=hidden"; },
    (v) => { v.endpoint += "#fragment"; },
    (v) => { v.endpoint = v.endpoint.replace("https://", "https://user:pass@"); },
    (v) => { v.endpoint = v.endpoint.replace("/mcp", ":443/mcp"); },
    (v) => { v.gatewayArn = v.gatewayArn.replace("fixture-math-", "other-"); },
    (v) => { v.region = "us-east-1"; },
    (v) => { v.qualifiedToolName = "other___add_numbers"; },
    (v) => { v.qualifiedToolName = "fixture-math___delete_all"; },
    (v) => { v.targetId = "*"; },
    (v) => { v.headers = { Authorization: "secret" }; },
    (v) => { v.policy.enforcementMode = "LOG_ONLY"; },
    (v) => { v.policy.definitionSha256 = "unknown"; },
    (v) => { v.policy.engineArn = v.policy.engineArn.replace("us-west-2", "us-east-1"); },
    (v) => { v.policy.sessionId = "caller-supplied"; },
  ];
  for (const mutate of mutations) {
    const content = approvedContent();
    mutate(content.gatewayBinding);
    assert.throws(() => createPortableResourceBinding("TOOL", content), /Gateway binding/);
    assert.equal(validPortableResourceBinding("TOOL", {
      adapter: "agentcore_gateway", status: "MATERIALIZED", gateway: content.gatewayBinding,
    }), false);
  }
  for (const gatewayBinding of [null, [], "url", {}]) {
    assert.throws(() => createPortableResourceBinding("TOOL", {
      toolType: "agentcore_gateway", gatewayBinding,
    }), /Gateway binding/);
  }
});
