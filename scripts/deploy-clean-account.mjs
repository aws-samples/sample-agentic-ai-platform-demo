#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const CONTROL_PLANE_OUTPUTS = path.join(
  ROOT,
  "infra/platform-registry/control-plane-outputs.json",
);

function required(value, name, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid.`);
  }
  return value;
}

function deploymentConfig(env = process.env) {
  const githubClientId = env.JOURNEY_GITHUB_OAUTH_CLIENT_ID || "";
  const githubSecretArn = env.JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN || "";
  if (Boolean(githubClientId) !== Boolean(githubSecretArn)) {
    throw new Error(
      "JOURNEY_GITHUB_OAUTH_CLIENT_ID and "
        + "JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN must be set together.",
    );
  }

  return {
    account: required(env.AWS_ACCOUNT_ID, "AWS_ACCOUNT_ID", /^\d{12}$/),
    region: required(env.AWS_REGION, "AWS_REGION", /^us-west-2$/),
    cognitoDomainPrefix: required(
      env.COGNITO_DOMAIN_PREFIX,
      "COGNITO_DOMAIN_PREFIX",
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    ),
    starterBuilderModelId:
      env.STARTER_BUILDER_MODEL_ID
      || "bedrock-claude/anthropic.claude-haiku-4-5",
    githubOAuthClientId: githubClientId,
    githubOAuthClientSecretArn: githubSecretArn,
    inceptionModelId: env.INCEPTION_MODEL_ID || "",
  };
}

function cdkContext(name, value) {
  return ["--context", `${name}=${value}`];
}

function controlPlaneStep(config) {
  return {
    name: "control-plane",
    cwd: path.join(ROOT, "infra/platform-registry"),
    args: [
      "exec",
      "--",
      "cdk",
      "deploy",
      "AgenticPlatform-ControlPlane-Provisioned",
      "--require-approval",
      "never",
      "--outputs-file",
      "control-plane-outputs.json",
      ...cdkContext("mode", "provision"),
      ...cdkContext("account", config.account),
      ...cdkContext("region", config.region),
    ],
  };
}

function webStep(config, controlPlaneOutputs) {
  const args = [
    "exec",
    "--",
    "cdk",
    "deploy",
    "PlatformWebStack",
    "--require-approval",
    "never",
    "--outputs-file",
    "deployment-outputs.json",
    ...cdkContext("account", config.account),
    ...cdkContext("region", config.region),
    ...cdkContext("cognitoDomainPrefix", config.cognitoDomainPrefix),
    ...cdkContext(
      "starterBuilderModelId",
      config.starterBuilderModelId,
    ),
    ...cdkContext("llmGatewayId", controlPlaneOutputs.LlmGatewayId),
    ...cdkContext(
      "llmGatewayRegion",
      controlPlaneOutputs.LlmGatewayRegion,
    ),
  ];
  if (config.githubOAuthClientId) {
    args.push(
      ...cdkContext("githubOAuthClientId", config.githubOAuthClientId),
      ...cdkContext(
        "githubOAuthClientSecretArn",
        config.githubOAuthClientSecretArn,
      ),
    );
  }
  if (config.inceptionModelId) {
    args.push(...cdkContext("inceptionModelId", config.inceptionModelId));
  }
  return {
    name: "web",
    cwd: path.join(ROOT, "infra/serverless-platform"),
    args,
  };
}

// The domain-create wizard's five /api/domain-bootstrap* routes live in a
// separate stack that binds to the deployed Web stack's API, authorizer,
// state table, user pool and two Lambda functions. Skipping it ships a
// console whose Domains pages fail with bare "Not Found" responses.
function domainBootstrapStep(config, targetFile) {
  return {
    name: "domain-bootstrap",
    cwd: path.join(ROOT, "infra/serverless-platform"),
    env: {
      AWS_ACCOUNT_ID: config.account,
      DOMAIN_BOOTSTRAP_TARGET_FILE: targetFile,
    },
    args: [
      "exec",
      "--",
      "cdk",
      "deploy",
      "--app",
      "node --import tsx bin/domain-bootstrap.ts",
      "--require-approval",
      "never",
    ],
  };
}

export function buildCleanAccountDeploymentPlan({
  controlPlaneOutputs,
  domainBootstrapTargetFile = "<written after web deploy>",
  ...config
}) {
  return [
    controlPlaneStep(config),
    webStep(config, controlPlaneOutputs),
    domainBootstrapStep(config, domainBootstrapTargetFile),
  ];
}

function readWebOutputs() {
  const file = path.join(
    ROOT,
    "infra/serverless-platform/deployment-outputs.json",
  );
  const stack = JSON.parse(readFileSync(file, "utf8"))["AgenticPlatform-Web"];
  if (!stack || typeof stack !== "object" || Array.isArray(stack)) {
    throw new Error("PlatformWebStack outputs are missing.");
  }
  return stack;
}

function writeDomainBootstrapTarget(config, web) {
  const target = {
    accountId: config.account,
    region: config.region,
    apiId: required(web.HttpApiId, "Web HttpApiId", /^[a-z0-9]+$/),
    authorizerId: required(
      web.JwtAuthorizerId,
      "Web JwtAuthorizerId",
      /^[a-z0-9]+$/,
    ),
    tableName: required(
      web.PlatformStateTableName,
      "Web PlatformStateTableName",
      /^[A-Za-z0-9._-]+$/,
    ),
    userPoolId: required(
      web.UserPoolId,
      "Web UserPoolId",
      /^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/,
    ),
    catalogRoleArn: required(
      web.ControlPlaneReadApiRoleArn,
      "Web ControlPlaneReadApiRoleArn",
      new RegExp(`^arn:aws:iam::${config.account}:role/`),
    ),
    functions: {
      admin: required(
        web.PlatformAdminApiFunctionName,
        "Web PlatformAdminApiFunctionName",
        /^[A-Za-z0-9_-]+$/,
      ),
      catalog: required(
        web.ControlPlaneReadApiFunctionName,
        "Web ControlPlaneReadApiFunctionName",
        /^[A-Za-z0-9_-]+$/,
      ),
    },
  };
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "domain-bootstrap-")),
    "target.json",
  );
  writeFileSync(file, JSON.stringify(target, null, 2));
  return file;
}

function readControlPlaneOutputs() {
  const document = JSON.parse(readFileSync(CONTROL_PLANE_OUTPUTS, "utf8"));
  const stack = document["AgenticPlatform-ControlPlane-Provisioned"];
  if (!stack || typeof stack !== "object" || Array.isArray(stack)) {
    throw new Error("Provisioned ControlPlane outputs are missing.");
  }
  return {
    LlmGatewayId: required(
      stack.LlmGatewayId,
      "ControlPlane LlmGatewayId",
      /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{10}$/,
    ),
    LlmGatewayRegion: required(
      stack.LlmGatewayRegion,
      "ControlPlane LlmGatewayRegion",
      /^us-west-2$/,
    ),
  };
}

function run(command, args, cwd = ROOT, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}.`);
  }
}

function verifyCaller(config) {
  const result = spawnSync(
    "aws",
    [
      "sts",
      "get-caller-identity",
      "--region",
      config.region,
      "--query",
      "Account",
      "--output",
      "text",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || result.stdout.trim() !== config.account) {
    throw new Error("AWS credentials do not match AWS_ACCOUNT_ID.");
  }
}

function runStep(step) {
  console.log(`\nDeploying ${step.name}...`);
  run("npm", step.args, step.cwd, step.env);
}

function main() {
  const config = deploymentConfig();
  verifyCaller(config);
  runStep(controlPlaneStep(config));
  runStep(webStep(config, readControlPlaneOutputs()));
  const targetFile = writeDomainBootstrapTarget(config, readWebOutputs());
  runStep(domainBootstrapStep(config, targetFile));
  console.log("Infrastructure deployed. Operator initialization is still required: create the initial administrator, authorize demo operators, then run npm run platform:initialize:demo-workspaces -- --apply with the private operator selection on stdin. See the deployment README; verify both domain Builder workspaces before handover.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
