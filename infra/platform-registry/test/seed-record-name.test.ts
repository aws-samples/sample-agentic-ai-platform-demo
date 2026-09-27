import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { canonicalizeSeedRecordName } from "../lib/seed-record-name";

const consoleDir = path.resolve(__dirname, "..", "..", "..", "console");
const seed = JSON.parse(
  fs.readFileSync(path.join(consoleDir, "registry-seed.json"), "utf8"),
);
const catalog = JSON.parse(
  fs.readFileSync(path.join(consoleDir, "catalog.json"), "utf8"),
);

function configuredSeedNames(): string[] {
  const names: string[] = [];

  for (const entry of seed) {
    if (entry.type === "Skill") {
      for (const _version of entry.versions || []) {
        names.push(`skill_${entry.id}`);
      }
    }
    if (entry.type === "A2AAgent") {
      for (const _version of entry.versions || []) {
        names.push(`a2a_${entry.id}`);
      }
    }
  }

  for (const blueprint of catalog.blueprints || []) {
    names.push(`blueprint_${blueprint.id}`);
  }

  return names;
}

test("canonicalizes all 23 configured seed names without collisions", () => {
  const rawNames = configuredSeedNames();
  const canonicalNames = rawNames.map(canonicalizeSeedRecordName);

  assert.equal(rawNames.length, 23);
  assert.equal(
    rawNames.filter(
      (name, index) => name !== canonicalNames[index],
    ).length,
    17,
  );
  assert.deepEqual(canonicalNames, [
    "a2a_expense_auditor",
    "a2a_supply_chain_tracker",
    "skill_it_troubleshooting",
    "skill_customer_support",
    "skill_hr_policy",
    "skill_data_analysis",
    "skill_knowledge_base",
    "skill_employee_directory",
    "skill_order_lookup",
    "skill_product_catalogue",
    "skill_code_interpreter",
    "skill_web_browser",
    "a2a_contract_review",
    "blueprint_chat_assistant",
    "blueprint_workflow_orchestrator",
    "blueprint_rag_knowledge",
    "blueprint_claude_cos",
    "blueprint_langgraph_multiagent",
    "blueprint_mcp_tool_server",
    "blueprint_action_agent",
    "blueprint_edge_classifier",
    "blueprint_adk_data_agent",
    "blueprint_openai_ops_agent",
  ]);
  assert.equal(new Set(canonicalNames).size, canonicalNames.length);

  for (const name of canonicalNames) {
    assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/);
  }
});
