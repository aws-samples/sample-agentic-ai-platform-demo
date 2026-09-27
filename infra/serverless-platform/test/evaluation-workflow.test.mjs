import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { evaluationAssets } from "../../../console/evaluation-assets.mjs";

test("exported evaluation workflow parses and uploads the actual report", () => {
  const workflow = evaluationAssets().find(
    (file) => file.path === ".github/workflows/eval.yml",
  );
  const document = parseDocument(workflow.content, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const config = document.toJS();
  assert.ok(Object.hasOwn(config.on, "pull_request"));
  const steps = config.jobs.eval.steps;
  assert.ok(steps.some((step) =>
    step.run === "python -m pytest evaluation/test_evaluation.py -q"));
  const upload = steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.if, "always()");
  assert.deepEqual(upload.with, {
    name: "eval-gate-report",
    path: "evaluation/report.json",
  });
});
