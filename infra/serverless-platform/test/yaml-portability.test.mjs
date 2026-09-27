import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageDocument = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const parserConsumers = [
  new URL("./deploy-workflow.test.mjs", import.meta.url),
  new URL("./readme-contract.test.mjs", import.meta.url),
];

test("workflow contracts use the pinned Node YAML parser without Ruby", () => {
  assert.equal(packageDocument.devDependencies.yaml, "2.9.0");

  for (const sourceUrl of parserConsumers) {
    const source = readFileSync(sourceUrl, "utf8");
    assert.match(source, /from "yaml"/);
    assert.doesNotMatch(source, /\bruby\b|require\s+["']yaml["']/i);
  }

  const deployContractSource = readFileSync(parserConsumers[0], "utf8");
  assert.match(
    deployContractSource,
    /deploy-serverless-platform\.yml/,
  );
  assert.match(
    deployContractSource,
    /verify-serverless-platform\.yml/,
  );
});
