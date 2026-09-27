import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const source = async (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("normal deployment neither requires nor runs Cognito demo-user seeding", async () => {
  const deployWorkflow = parse(
    await source("../../.github/workflows/deploy-serverless-platform.yml"),
  );
  const triggerWorkflow = parse(
    await source("../../.github/workflows/verify-serverless-platform.yml"),
  );
  const serializedDeploy = JSON.stringify(deployWorkflow);

  assert.deepEqual(deployWorkflow.on.workflow_call, {});
  assert.deepEqual(triggerWorkflow.jobs.deploy.secrets, undefined);
  assert.doesNotMatch(serializedDeploy, /seed-demo-users/i);
  assert.doesNotMatch(serializedDeploy, /COGNITO_DEMO_USER_PASSWORDS_JSON/);
});

test("optional user seeding is generic and accepts deployment-private persona configuration", async () => {
  const seedSource = await source("scripts/seed-demo-users.mjs");
  const seedTests = await source("scripts/seed-demo-users.test.mjs");
  const readme = await source("README.md");

  assert.doesNotMatch(seedSource, /export const DEMO_USERS\s*=/);
  assert.match(seedSource, /COGNITO_DEMO_USERS_JSON/);
  assert.match(seedTests, /platform_admin_01/);
  assert.match(seedTests, /example\.invalid/);
  assert.doesNotMatch(seedTests, /@amazon\.com/);
  assert.match(readme, /optional[\s\S]+deployment-private/i);
  assert.match(readme, /existing users[\s\S]+preserved/i);
});

test("manual deployment has no implicit GitHub repository metadata", async () => {
  const configSource = await source("lib/config.ts");
  const appSource = await source("bin/app.ts");

  assert.doesNotMatch(configSource, /DEFAULT_REPOSITORY/);
  assert.doesNotMatch(appSource, /DEFAULT_REPOSITORY/);
  assert.match(
    appSource,
    /enableGitHubDeployment[\s\S]+requiredContext\(context,\s*"repository"\)/,
  );
});
