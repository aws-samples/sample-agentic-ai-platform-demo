// Tests for buildRegistryDescriptors — verifies the exact descriptor shapes
// sent to the AWS AgentCore Registry API for each record type.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRegistryDescriptors,
} from "../lambda/platform-admin/index.mjs";

const BASE = {
  name: "my-agent",
  displayName: "My Agent",
  description: "A test agent",
  domain: "customer_support",
  actor: "user-sub-123",
};

test("buildRegistryDescriptors: A2AAgent produces correct shape", () => {
  const card = {
    name: "my-agent",
    url: "https://agent.example.com/a2a",
    description: "A test A2A agent",
    protocolVersion: "0.3.0",
  };
  const result = buildRegistryDescriptors("A2AAgent", {
    ...BASE,
    content: JSON.stringify(card),
  });

  assert.ok(result.a2aAgentCard, "must have a2aAgentCard key");
  assert.equal(result.a2aAgentCard.dataSchemaVersion, "0.3.0");
  const data = JSON.parse(result.a2aAgentCard.data);
  // Supplied card fields are preserved
  assert.equal(data.name, card.name);
  assert.equal(data.url, card.url);
  assert.equal(data.protocolVersion, card.protocolVersion);
  // x-platform metadata is injected
  assert.ok(data["x-platform"], "must have x-platform key");
  assert.equal(data["x-platform"].id, BASE.name);
  assert.equal(data["x-platform"].domain, BASE.domain);
  assert.equal(data["x-platform"].createdBy, BASE.actor);
  // No a2aAgentCard-level keys leaked into other descriptor types
  assert.equal(Object.keys(result).length, 1);
});

test("buildRegistryDescriptors: A2AAgent with invalid JSON content uses empty card", () => {
  const result = buildRegistryDescriptors("A2AAgent", {
    ...BASE,
    content: "not-valid-json",
  });
  assert.ok(result.a2aAgentCard);
  assert.equal(result.a2aAgentCard.dataSchemaVersion, "0.3.0");
  const data = JSON.parse(result.a2aAgentCard.data);
  // x-platform is still present
  assert.ok(data["x-platform"]);
  assert.equal(data["x-platform"].domain, BASE.domain);
});

test("buildRegistryDescriptors: Skill produces correct shape", () => {
  const markdown = "# My Agent\n\nDoes stuff.";
  const result = buildRegistryDescriptors("Skill", {
    ...BASE,
    content: markdown,
  });

  assert.ok(result.agentSkillsDefinition, "must have agentSkillsDefinition key");
  assert.equal(result.agentSkillsDefinition.dataSchemaVersion, "0.1.0");
  const definition = JSON.parse(result.agentSkillsDefinition.data);
  assert.equal(definition.id, BASE.name);
  assert.equal(definition.displayName, BASE.displayName);
  assert.equal(definition.description, BASE.description);
  assert.ok(definition["x-platform"]);
  assert.equal(definition["x-platform"].domain, BASE.domain);
  // Markdown goes into additionalData.skillMd.data
  assert.ok(result.agentSkillsDefinition.additionalData?.skillMd?.data);
  assert.equal(result.agentSkillsDefinition.additionalData.skillMd.data, markdown);
  assert.equal(Object.keys(result).length, 1);
});

test("buildRegistryDescriptors: Skill with structDef includes structuredDefinition", () => {
  const structDef = JSON.stringify({ inputSchema: { type: "object" } });
  const result = buildRegistryDescriptors("Skill", {
    ...BASE,
    content: "# Skill",
    structDef,
  });
  const definition = JSON.parse(result.agentSkillsDefinition.data);
  assert.deepEqual(definition.structuredDefinition, { inputSchema: { type: "object" } });
});

test("buildRegistryDescriptors: MCPServer produces correct shape", () => {
  const result = buildRegistryDescriptors("MCPServer", {
    ...BASE,
    endpoint: "https://mcp.example.com/server",
    transport: "streamable_http",
  });

  assert.ok(result.mcpServer, "must have mcpServer key");
  assert.equal(result.mcpServer.dataSchemaVersion, "2025-12-11");
  const data = JSON.parse(result.mcpServer.data);
  // Remote transport must use hyphen, not underscore
  assert.equal(data.remotes[0].type, "streamable-http");
  assert.equal(data.remotes[0].url, "https://mcp.example.com/server");
  assert.equal(data.name, `io.platform/${BASE.name}`);
  assert.equal(data.version, "1.0.0");
  // No x-platform at top level (MCP schema is strict)
  assert.equal(data["x-platform"], undefined);
  assert.equal(Object.keys(result).length, 1);
});

test("buildRegistryDescriptors: MCPServer transport underscore→hyphen conversion", () => {
  const result = buildRegistryDescriptors("MCPServer", {
    ...BASE,
    endpoint: "https://mcp.example.com/server",
    transport: "streamable_http",
  });
  const data = JSON.parse(result.mcpServer.data);
  assert.equal(data.remotes[0].type, "streamable-http");
});

test("buildRegistryDescriptors: MCPServer default transport is streamable-http", () => {
  const result = buildRegistryDescriptors("MCPServer", {
    ...BASE,
    endpoint: "https://mcp.example.com/server",
    // transport omitted
  });
  const data = JSON.parse(result.mcpServer.data);
  assert.equal(data.remotes[0].type, "streamable-http");
});

test("buildRegistryDescriptors: CUSTOM produces correct shape", () => {
  const customContent = JSON.stringify({ key: "value", nested: { a: 1 } });
  const result = buildRegistryDescriptors("CUSTOM", {
    ...BASE,
    content: customContent,
  });

  assert.ok(result.custom, "must have custom key");
  const data = JSON.parse(result.custom.data);
  assert.equal(data.resourceId, BASE.name);
  assert.equal(data.displayName, BASE.displayName);
  assert.equal(data.domain, BASE.domain);
  assert.deepEqual(data.content, { key: "value", nested: { a: 1 } });
  assert.ok(data["x-platform"]);
  assert.equal(Object.keys(result).length, 1);
});

test("buildRegistryDescriptors: CUSTOM with invalid JSON content uses empty object", () => {
  const result = buildRegistryDescriptors("CUSTOM", {
    ...BASE,
    content: "invalid json",
  });
  const data = JSON.parse(result.custom.data);
  assert.deepEqual(data.content, {});
});

test("buildRegistryDescriptors: actor defaults to platform-bootstrap when not provided", () => {
  const result = buildRegistryDescriptors("A2AAgent", {
    ...BASE,
    actor: undefined,
    content: JSON.stringify({ name: "x", url: "https://example.com" }),
  });
  const data = JSON.parse(result.a2aAgentCard.data);
  assert.equal(data["x-platform"].createdBy, "platform-bootstrap");
});

test("buildRegistryDescriptors: domain defaults to shared when not provided", () => {
  const result = buildRegistryDescriptors("A2AAgent", {
    ...BASE,
    domain: undefined,
    content: JSON.stringify({ name: "x", url: "https://example.com" }),
  });
  const data = JSON.parse(result.a2aAgentCard.data);
  assert.equal(data["x-platform"].domain, "shared");
});
