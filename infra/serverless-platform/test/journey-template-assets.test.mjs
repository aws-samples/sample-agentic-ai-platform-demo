import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildJourneyTemplateAssets,
  renderJourneyTemplateAssets,
} from "../scripts/generate-journey-template-assets.mjs";
import {
  JOURNEY_TEMPLATES,
} from "../lambda/journeys/template-assets.mjs";

test("generated journey template module matches canonical source files", () => {
  const assets = buildJourneyTemplateAssets();
  assert.deepEqual(JOURNEY_TEMPLATES, assets);
  assert.match(
    renderJourneyTemplateAssets(assets),
    /export const JOURNEY_TEMPLATES/,
  );
  for (const templateId of ["chatagent", "workflowagent"]) {
    const paths = assets.blueprints[templateId].map(({ path }) => path);
    assert.ok(paths.includes("agentcore/agentcore.json"));
    assert.ok(paths.some((path) => path.endsWith("/main.py")));
    assert.equal(paths.some((path) => path.includes("node_modules")), false);
    assert.equal(paths.some((path) => path.includes("/dist/")), false);
    const config = assets.blueprints[templateId].find(({ path }) =>
      path === "agentcore/agentcore.json").content;
    assert.doesNotMatch(config, /cognito-idp\./);
    assert.doesNotMatch(config, /7d72mth9dp080jqkvc8kk586j8/);
  }
  for (const path of [
    ".github/workflows/compliance.yml",
    ".github/workflows/deploy-dev.yml",
    ".github/workflows/eval.yml",
    ".github/workflows/promote.yml",
    ".github/workflows/tests.yml",
    "gates/check-guardrails.mjs",
    "gates/check-resource-bindings.mjs",
    "gates/record-transcripts.mjs",
    "gates/run-eval.mjs",
    "gates/run-tests.mjs",
  ]) {
    assert.equal(typeof assets.ci[path], "string", path);
  }
  for (const path of [
    ".github/workflows/deploy-dev.yml",
    ".github/workflows/promote.yml",
  ]) {
    const workflow = assets.ci[path];
    assert.match(workflow, /npm install -g @aws\/agentcore/);
    assert.match(workflow, /pip install --quiet uv/);
    assert.match(workflow, /agentcore deploy --target/);
    assert.match(workflow, /--yes/);
    assert.match(workflow, /npm --prefix agentcore\/cdk install/);
    const bindingGate = workflow.indexOf(
      "node gates/check-resource-bindings.mjs",
    );
    const deploy = workflow.indexOf("agentcore deploy --target");
    assert.ok(bindingGate > -1 && bindingGate < deploy);
    const preflight = workflow.indexOf("- name: Check deployment configuration");
    const credentials = workflow.indexOf("- name: Configure AWS credentials");
    assert.ok(preflight > -1 && preflight < credentials);
    assert.match(workflow, /AWS_DEPLOY_ROLE_ARN: \$\{\{ vars\.AWS_DEPLOY_ROLE_ARN \}\}/);
    assert.match(
      workflow,
      /Configure AWS credentials[\s\S]*if: steps\.deployment\.outputs\.enabled == 'true'/,
    );
    assert.match(
      workflow,
      /Deploy <agent>-[\s\S]*if: steps\.deployment\.outputs\.enabled == 'true'/,
    );
    assert.doesNotMatch(
      workflow,
      /bedrock-agentcore-starter-toolkit|--agent-suffix|deploy -y/,
    );
  }
});

test("generated resource binding gate blocks unresolved resources and passes materialized resources", () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-binding-gate-"));
  try {
    mkdirSync(join(directory, "gates"), { recursive: true });
    writeFileSync(
      join(directory, "gates", "check-resource-bindings.mjs"),
      JOURNEY_TEMPLATES.ci["gates/check-resource-bindings.mjs"],
    );
    writeFileSync(
      join(directory, "domain-harness.json"),
      `${JSON.stringify({
        resources: [{
          type: "TOOL",
          id: "case-search",
          version: "1.0.0",
          binding: {
            adapter: "mcp",
            status: "DEPLOYMENT_REQUIRED",
          },
        }],
      })}\n`,
    );

    const blocked = spawnSync(
      process.execPath,
      ["gates/check-resource-bindings.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(blocked.status, 0, blocked.stdout || blocked.stderr);
    assert.match(`${blocked.stdout}${blocked.stderr}`, /DEPLOYMENT_REQUIRED/);
    assert.match(`${blocked.stdout}${blocked.stderr}`, /TOOL:case-search@1\.0\.0/);

    writeFileSync(
      join(directory, "domain-harness.json"),
      `${JSON.stringify({
        resources: [{
          type: "TOOL",
          id: "case-search",
          version: "1.0.0",
          binding: {
            adapter: "mcp",
            status: "MATERIALIZED",
          },
        }],
      })}\n`,
    );
    const passed = spawnSync(
      process.execPath,
      ["gates/check-resource-bindings.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(passed.status, 0, passed.stderr || passed.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generated test gate checks resource bindings before running tests", () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-binding-tests-"));
  try {
    mkdirSync(join(directory, "gates"), { recursive: true });
    writeFileSync(
      join(directory, "gates", "check-resource-bindings.mjs"),
      JOURNEY_TEMPLATES.ci["gates/check-resource-bindings.mjs"],
    );
    writeFileSync(
      join(directory, "gates", "run-tests.mjs"),
      JOURNEY_TEMPLATES.ci["gates/run-tests.mjs"],
    );
    writeFileSync(
      join(directory, "domain-harness.json"),
      '{"resources":[{"type":"TOOL","id":"case-search","version":"1.0.0","binding":{"adapter":"mcp","status":"DEPLOYMENT_REQUIRED"}}]}\n',
    );
    writeFileSync(
      join(directory, "package.json"),
      '{"scripts":{"test":"node -e \\"require(\\\'node:fs\\\').writeFileSync(\\\'test-ran\\\',\\\'yes\\\')\\""}}\n',
    );

    const result = spawnSync(
      process.execPath,
      ["gates/run-tests.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
    assert.equal(existsSync(join(directory, "test-ran")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("test gate ignores packaged dependencies and CDK build output without passing vacuously", () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-generated-tests-"));
  try {
    for (const folder of ["gates", "tests", "agentcore/cdk/dist/test", "agentcore/chat_agent/dependency"]) {
      mkdirSync(join(directory, folder), {recursive:true});
    }
    writeFileSync(join(directory, "gates/run-tests.mjs"), JOURNEY_TEMPLATES.ci["gates/run-tests.mjs"]);
    writeFileSync(join(directory, "agentcore/agentcore.json"), '{"runtimes":[{"name":"chat_agent"}]}');
    writeFileSync(join(directory, "agentcore/cdk/dist/test/cdk.test.js"), 'throw Error("compiled Jest output");');
    writeFileSync(join(directory, "agentcore/chat_agent/dependency/vendor.test.js"), 'throw Error("packaged dependency");');
    const sourceTest = join(directory, "tests/source.test.mjs");
    writeFileSync(sourceTest, 'import test from "node:test";import {writeFileSync} from "node:fs";test("actual source test",()=>writeFileSync("source-test-ran","yes"));');
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, ["gates/run-tests.mjs"], {cwd:directory,encoding:"utf8",env});
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(directory, "source-test-ran"), "utf8"), "yes");
    rmSync(join(directory, "tests"), {recursive:true});
    const empty = run();
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /TEST GATE FAILED/);
  } finally {
    rmSync(directory, {recursive:true,force:true});
  }
});

test("generated Python test gate stops when editable installation fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-test-gate-"));
  try {
    mkdirSync(join(directory, "gates"), { recursive: true });
    mkdirSync(join(directory, "tests"), { recursive: true });
    mkdirSync(join(directory, "app", "broken"), { recursive: true });
    mkdirSync(join(directory, "bin"), { recursive: true });
    writeFileSync(
      join(directory, "gates", "run-tests.mjs"),
      JOURNEY_TEMPLATES.ci["gates/run-tests.mjs"],
    );
    writeFileSync(
      join(directory, "gates", "platform-gates.json"),
      '{"preset":"FULL","allowNoTests":false}\n',
    );
    writeFileSync(join(directory, "tests", "test_smoke.py"), "def test_ok(): assert True\n");
    writeFileSync(join(directory, "app", "broken", "pyproject.toml"), "[project]\nname='broken'\n");
    writeFileSync(
      join(directory, "bin", "pip"),
      "#!/bin/sh\ncase \" $* \" in *\" -e \"*) exit 7;; *) exit 0;; esac\n",
    );
    writeFileSync(join(directory, "bin", "pytest"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, "bin", "pip"), 0o755);
    chmodSync(join(directory, "bin", "pytest"), 0o755);

    const result = spawnSync(
      process.execPath,
      ["gates/run-tests.mjs"],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}:${process.env.PATH}`,
        },
      },
    );

    assert.notEqual(result.status, 0, result.stdout || result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
