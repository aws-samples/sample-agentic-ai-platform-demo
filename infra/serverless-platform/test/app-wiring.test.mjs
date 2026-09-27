import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PLATFORM_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CDK = path.join(PLATFORM_ROOT, "node_modules", ".bin", "cdk");
const GITHUB_CONTEXT = {
  repository: "example-org/example-repo",
  repositoryId: "987654321",
  repositoryOwnerId: "12345678",
  workflowRef:
    "example-org/example-repo/.github/workflows/"
    + "deploy-serverless-platform.yml@refs/heads/main",
  githubOidcSubjectMode: "legacy",
  githubOidcSubject:
    "repo:example-org/example-repo:ref:refs/heads/main",
};

function listStacks(context = {}) {
  const args = [
    "list",
    "--context",
    "account=111122223333",
    "--context",
    "region=us-west-2",
    "--context",
    "cognitoDomainPrefix=agentic-platform-app-test",
    "--context",
    "llmGatewayId=agentic-demo-llm-gateway-abcdefghij",
    "--context",
    "llmGatewayRegion=us-east-1",
    "--context",
    "inceptionModelId="
      + "bedrock-mantle/anthropic.claude-haiku-4-5",
  ];
  for (const [key, value] of Object.entries(context)) {
    args.push("--context", `${key}=${value}`);
  }
  return spawnSync(CDK, args, {
    cwd: PLATFORM_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CDK_DEFAULT_ACCOUNT: "111122223333",
      CDK_DEFAULT_REGION: "us-west-2",
    },
  });
}

function stackNames(result) {
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\s+\([^)]*\)$/, ""));
}

test("default CDK app exposes only the manual PlatformWebStack", () => {
  const result = listStacks();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stackNames(result), ["PlatformWebStack"]);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /repository/i,
  );
});

test("Journey deployment context accepts optional complete GitHub OAuth configuration", () => {
  const result = listStacks({
    githubOAuthClientId: "Iv1.1234567890abcdef",
    githubOAuthClientSecretArn:
      "arn:aws:secretsmanager:us-west-2:111122223333:"
      + "secret:agentic-platform/github-oauth-ABC123",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stackNames(result), ["PlatformWebStack"]);
});

test("default CDK app ignores a conflicting profile region and targets us-west-2", () => {
  const result = spawnSync(CDK, [
    "list",
    "--long",
    "--json",
    "--context",
    "account=111122223333",
    "--context",
    "cognitoDomainPrefix=agentic-platform-app-test",
    "--context",
    "llmGatewayId=agentic-demo-llm-gateway-abcdefghij",
    "--context",
    "llmGatewayRegion=us-east-1",
  ], {
    cwd: PLATFORM_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CDK_DEFAULT_ACCOUNT: "111122223333",
      CDK_DEFAULT_REGION: "us-east-1",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const stacks = JSON.parse(result.stdout);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].environment.region, "us-west-2");
});

test("CDK app rejects an explicitly unsupported deployment region", () => {
  const result = listStacks({ region: "us-east-1" });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /region must be exactly us-west-2/i,
  );
});

test("GitHub deployment enablement fails closed without branch-protection attestation", () => {
  const result = listStacks({ enableGitHubDeployment: "true" });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /branchProtectionAttested.*true/i,
  );
});

test("an explicitly enabled and attested app exposes the bootstrap stack", () => {
  const result = listStacks({
    enableGitHubDeployment: "true",
    branchProtectionAttested: "true",
    ...GITHUB_CONTEXT,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(stackNames(result).sort(), [
    "GitHubBootstrapStack",
    "PlatformWebStack",
  ]);
});

test("GitHub deployment enablement fails closed without every immutable repository value", () => {
  for (const missingKey of Object.keys(GITHUB_CONTEXT)) {
    const context = {
      enableGitHubDeployment: "true",
      branchProtectionAttested: "true",
      ...GITHUB_CONTEXT,
    };
    delete context[missingKey];

    const result = listStacks(context);

    assert.notEqual(result.status, 0, missingKey);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      new RegExp(missingKey, "i"),
    );
  }
});
