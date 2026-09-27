import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { parseDocument } from "yaml";
import { evaluationAssets } from "../../../console/evaluation-assets.mjs";

test("all shipped workflow sources and evaluation overrides are valid GitHub workflow YAML", () => {
  const directory = new URL("../../../console/ci-templates/", import.meta.url);
  const workflows = readdirSync(directory).filter(name => name.endsWith(".yml"))
    .map(name => ({ path: name, content: readFileSync(new URL(name, directory), "utf8") }));
  workflows.push(...evaluationAssets().filter(file => file.path.startsWith(".github/workflows/")));
  for (const file of workflows) {
    const document = parseDocument(file.content, { uniqueKeys: true });
    assert.deepEqual(document.errors, [], file.path);
    const workflow = document.toJS();
    assert.ok(workflow.on && workflow.jobs, file.path);
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(Array.isArray(job.steps) && job.steps.length, file.path);
      for (const step of job.steps) {
        if (step.uses?.startsWith("actions/upload-artifact@")) {
          assert.equal(typeof step.with?.name, "string", file.path);
          assert.equal(typeof step.with?.path, "string", file.path);
        }
      }
    }
  }
});
