import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
  RUNTIME_PERMISSIONS_BOUNDARY_NAME,
} from "../lib/config";
import { PlatformWebStack } from "../lib/platform-web-stack";

type Resource = {
  DeletionPolicy?: string;
  Properties?: Record<string, any>;
  UpdateReplacePolicy?: string;
};

function fixture() {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, "DeploymentInfrastructureTest", {
    env: { account: "111122223333", region: "us-west-2" },
    cognitoDomainPrefix: "agentic-platform-deployment-test",
    llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
    llmGatewayRegion: "us-east-1",
    starterBuilderModelId:
      "bedrock-mantle/anthropic.claude-haiku-4-5",
  });
  return Template.fromStack(stack);
}

function resources(
  template: Template,
  type: string,
): Array<[string, Resource]> {
  return Object.entries(template.findResources(type)) as
    Array<[string, Resource]>;
}

function statementsForRole(
  template: Template,
  roleId: string,
): Record<string, any>[] {
  const role = template.findResources("AWS::IAM::Role")[roleId];
  return [
    ...(role?.Properties?.Policies ?? []).flatMap(
      (policy: Record<string, any>) =>
        policy.PolicyDocument.Statement,
    ),
    ...resources(template, "AWS::IAM::Policy")
      .filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles).includes(roleId)
      )
      .flatMap(([, policy]) =>
        policy.Properties?.PolicyDocument.Statement
      ),
  ];
}

function actionList(statement: Record<string, any>): string[] {
  return (Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action]).sort();
}

function normalizedTags(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map(({ Key, Value }) => [Key, Value]),
    );
  }
  return value && typeof value === "object"
    ? value as Record<string, string>
    : {};
}

async function relativeFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      return relativeFiles(root, absolutePath);
    }
    return [path.relative(root, absolutePath)];
  }));
  return files.flat().sort();
}

async function runEntrypoint(entrypoint: string) {
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      AWS_REGION: "",
      LLM_GATEWAY_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stderr };
}

async function probeRunningEntrypoint(entrypoint: string) {
  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolve);
  });
  const address = portProbe.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    portProbe.close((error) => error ? reject(error) : resolve());
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ACCESS_KEY_ID: "AKIAEXECUTION",
    AWS_REGION: "us-west-2",
    AWS_SECRET_ACCESS_KEY: "execution-secret",
    AWS_SESSION_TOKEN: "execution-session",
    MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1",
    BEDROCK_RUNTIME_REGION: "us-west-2",
    BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{
      modelId: "bedrock-claude/anthropic.claude-haiku-4-5", domains: ["customer_support"],
    }]),
    GATEWAY_INVOKER_ROLE_ARN:
      "arn:aws:iam::111122223333:role/agentic-platform-gateway-invoker",
    LLM_GATEWAY_REGION: "us-east-1",
    LLM_GATEWAY_URL:
      "https://agentic-demo-llm-gateway-abcdefghij.gateway."
      + "bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
    PLATFORM_STATE_TABLE_NAME: "AgenticPlatform-Web-State",
    PORT: String(address.port),
    RUNTIME_INVOCATION_PROOF_SECRET_ARN:
      "arn:aws:secretsmanager:us-west-2:111122223333:"
      + "secret:runtime-proof",
  };
  delete env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  delete env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete env.AWS_PROFILE;

  const child = spawn(process.execPath, [entrypoint], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let exitCode: number | null | undefined;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      exitCode = code;
      resolve();
    });
  });
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  const exitedDuringProbe = exitCode !== undefined;
  if (!exitedDuringProbe) {
    child.kill("SIGTERM");
    await exited;
  }
  return { exitCode, exitedDuringProbe, stderr };
}

test("CDK provisions one governed AgentCore Runtime and two tagged endpoints", () => {
  const template = fixture();
  const runtimes = resources(
    template,
    "AWS::BedrockAgentCore::Runtime",
  );
  assert.equal(runtimes.length, 1);
  const [, runtime] = runtimes[0];
  assert.equal(runtime.Properties?.AgentRuntimeName, "AgenticPlatformRuntime");
  assert.deepEqual(runtime.Properties?.ProtocolConfiguration, "HTTP");
  assert.deepEqual(runtime.Properties?.NetworkConfiguration, {
    NetworkMode: "PUBLIC",
  });
  assert.equal(
    runtime.Properties?.EnvironmentVariables?.LLM_GATEWAY_URL,
    "https://agentic-demo-llm-gateway-abcdefghij.gateway."
      + "bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
  );
  assert.equal(
    runtime.Properties?.EnvironmentVariables?.LLM_GATEWAY_REGION,
    "us-east-1",
  );
  assert.equal(
    runtime.Properties?.AgentRuntimeArtifact?.CodeConfiguration?.Runtime,
    "NODE_22",
  );
  assert.deepEqual(
    runtime.Properties?.AgentRuntimeArtifact?.CodeConfiguration?.EntryPoint,
    ["server.js"],
  );
  assert.ok(
    runtime.Properties?.EnvironmentVariables
      ?.GATEWAY_INVOKER_ROLE_ARN,
  );
  assert.deepEqual(
    normalizedTags(runtime.Properties?.Tags),
    {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  );

  const endpoints = resources(
    template,
    "AWS::BedrockAgentCore::RuntimeEndpoint",
  );
  assert.equal(endpoints.length, 2);
  assert.deepEqual(
    endpoints.map(([, endpoint]) => endpoint.Properties?.Name).sort(),
    ["Production", "Sandbox"],
  );
  for (const [, endpoint] of endpoints) {
    assert.deepEqual(
      normalizedTags(endpoint.Properties?.Tags),
      {
        "auto-delete": "no",
        managedBy: "cdk",
        project: "agentic-ai-platform-demo",
      },
    );
  }
});

test("runtime invocation proof uses one generated retained secret with exact consumers", async () => {
  const template = fixture();
  const secrets = resources(template, "AWS::SecretsManager::Secret");
  assert.equal(secrets.length, 1);
  const [secretId, secret] = secrets[0];
  assert.equal(secret.DeletionPolicy, "Retain");
  assert.equal(secret.UpdateReplacePolicy, "Retain");
  assert.equal(secret.Properties?.SecretString, undefined);
  assert.deepEqual(secret.Properties?.GenerateSecretString, {
    ExcludePunctuation: true,
    GenerateStringKey: "hmacKey",
    IncludeSpace: false,
    PasswordLength: 64,
    RequireEachIncludedType: true,
    SecretStringTemplate: JSON.stringify({
      previousHmacKey: null,
      allowedEndpointArn: null,
      keyId: "runtime-proof-v1",
    }),
  });
  assert.deepEqual(
    normalizedTags(secret.Properties?.Tags),
    {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  );

  const secretArn = { Ref: secretId };
  const runtime = resources(
    template,
    "AWS::BedrockAgentCore::Runtime",
  )[0]?.[1];
  assert.ok(runtime);
  assert.deepEqual(
    runtime.Properties?.EnvironmentVariables
      ?.RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    secretArn,
  );
  const [stateTableId] = resources(
    template,
    "AWS::DynamoDB::Table",
  )[0];
  assert.deepEqual(
    runtime.Properties?.EnvironmentVariables
      ?.PLATFORM_STATE_TABLE_NAME,
    { Ref: stateTableId },
  );
  assert.equal(
    runtime.Properties?.EnvironmentVariables
      ?.RUNTIME_INVOCATION_PROOF_AUDIENCE,
    undefined,
  );
  const experienceFunction = resources(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Serves entitled approved agents and governed Runtime invocation"
  )?.[1];
  assert.ok(experienceFunction);
  assert.deepEqual(
    experienceFunction.Properties?.Environment?.Variables
      ?.RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    secretArn,
  );

  const secretConsumers = resources(template, "AWS::IAM::Role")
    .flatMap(([roleId, role]) =>
      statementsForRole(template, roleId)
        .filter((statement) =>
          actionList(statement).some((action) =>
            action.startsWith("secretsmanager:"))
        )
        .map((statement) => ({
          roleName: role.Properties?.RoleName,
          statement,
        }))
    );
  assert.deepEqual(
    secretConsumers.map(({ roleName }) => roleName).sort(),
    [
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime,
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi,
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.journeyApi,
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeProofConfigurator,
    ].sort(),
  );
  for (const { roleName, statement } of secretConsumers) {
    assert.deepEqual(actionList(statement), [
      "secretsmanager:GetSecretValue",
      ...(roleName
        === PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeProofConfigurator
        ? ["secretsmanager:PutSecretValue"]
        : []),
    ]);
    assert.deepEqual(statement.Resource, secretArn);
  }

  const allBoundaries = resources(template, "AWS::IAM::ManagedPolicy");
  assert.equal(allBoundaries.length, 3);
  const boundaries = allBoundaries.filter(([,policy]) =>
    policy.Properties?.ManagedPolicyName === RUNTIME_PERMISSIONS_BOUNDARY_NAME);
  assert.equal(boundaries.length, 1);
  const operations = allBoundaries.filter(([,policy]) =>
    policy.Properties?.ManagedPolicyName === 'AgenticPlatform-Web-OperationsBoundary');
  assert.equal(operations.length, 1);
  assert.ok(operations[0][1].Properties?.PolicyDocument.Statement.every((statement: Record<string, any>) =>
    actionList(statement).every((action: string) => !action.startsWith('secretsmanager:'))));
  const boundaryReads =
    boundaries[0][1].Properties?.PolicyDocument?.Statement
      ?.filter((statement: Record<string, any>) =>
        actionList(statement).includes(
          "secretsmanager:GetSecretValue",
        )
      ) ?? [];
  assert.equal(boundaryReads.length, 1);
  assert.deepEqual(actionList(boundaryReads[0]), [
    "secretsmanager:GetSecretValue",
  ]);
  assert.deepEqual([boundaryReads[0].Resource].flat(), [secretArn]);
  const boundaryWrites =
    boundaries[0][1].Properties?.PolicyDocument?.Statement
      ?.filter((statement: Record<string, any>) =>
        actionList(statement).includes(
          "secretsmanager:PutSecretValue",
        )
      ) ?? [];
  assert.equal(boundaryWrites.length, 1);
  assert.deepEqual(actionList(boundaryWrites[0]), [
    "secretsmanager:PutSecretValue",
  ]);
  assert.deepEqual([boundaryWrites[0].Resource].flat(), [secretArn]);
  assert.deepEqual(boundaryWrites[0].Condition, {
    ArnEquals: {
      "aws:PrincipalArn": {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":iam::111122223333:role/"
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeProofConfigurator,
          ],
        ],
      },
    },
  });

  const canonicalBoundary = JSON.parse(
    await readFile(
      path.join(
        __dirname,
        "..",
        "config",
        "runtime-permissions-boundary.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    canonicalBoundary.Statement.find(
      ({ Sid }: { Sid?: string }) =>
        Sid === "ReadRuntimeInvocationProofSecret",
    ),
    {
      Sid: "ReadRuntimeInvocationProofSecret",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: ["${RUNTIME_INVOCATION_PROOF_SECRET_ARN}"],
    },
  );
  assert.deepEqual(
    canonicalBoundary.Statement.find(
      ({ Sid }: { Sid?: string }) =>
        Sid === "WriteRuntimeInvocationProofSecret",
    ),
    {
      Sid: "WriteRuntimeInvocationProofSecret",
      Effect: "Allow",
      Action: ["secretsmanager:PutSecretValue"],
      Resource: ["${RUNTIME_INVOCATION_PROOF_SECRET_ARN}"],
      Condition: {
        ArnEquals: {
          "aws:PrincipalArn":
            "${RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN}",
        },
      },
    },
  );

  const [productionEndpointId, productionEndpoint] = resources(
    template,
    "AWS::BedrockAgentCore::RuntimeEndpoint",
  ).find(([, endpoint]) =>
    endpoint.Properties?.Name === "Production"
  ) ?? [];
  assert.ok(productionEndpointId);
  assert.ok(productionEndpoint);
  const [configuratorId, configurator] = resources(
    template,
    "AWS::Lambda::Function",
  ).find(([, candidate]) =>
    candidate.Properties?.Description
      === "Finalizes the governed Runtime proof endpoint binding"
  ) ?? [];
  assert.ok(configuratorId);
  assert.ok(configurator);
  const binding = resources(
    template,
    "Custom::RuntimeProofEndpointBinding",
  )[0]?.[1];
  assert.ok(binding);
  assert.deepEqual(binding.Properties?.SecretArn, secretArn);
  assert.deepEqual(binding.Properties?.AllowedEndpointArn, {
    "Fn::GetAtt": [
      productionEndpointId,
      "AgentRuntimeEndpointArn",
    ],
  });
  assert.ok(
    [binding.Properties?.ServiceToken].flat().length > 0,
  );

  const [providerRoleId] = resources(template, "AWS::IAM::Role")
    .find(([, role]) =>
      role.Properties?.RoleName
        === PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeProofProvider
    ) ?? [];
  assert.ok(providerRoleId);
  const providerInvocationActions = statementsForRole(
    template,
    providerRoleId,
  ).filter((statement) =>
    JSON.stringify(statement.Resource).includes(configuratorId)
  ).flatMap(actionList).sort();
  assert.deepEqual(providerInvocationActions, [
    "lambda:GetFunction",
    "lambda:InvokeFunction",
  ]);
});

test("AgentCore Runtime artifact is one self-contained Node bundle", async () => {
  const outdir = await mkdtemp(
    path.join(tmpdir(), "agentic-platform-runtime-asset-"),
  );
  try {
    const app = new cdk.App({ outdir });
    const stack = new PlatformWebStack(app, "RuntimeAssetTest", {
      env: { account: "111122223333", region: "us-west-2" },
      cognitoDomainPrefix: "agentic-platform-runtime-asset-test",
      llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
      llmGatewayRegion: "us-east-1",
      starterBuilderModelId:
        "bedrock-mantle/anthropic.claude-haiku-4-5",
    });
    app.synth();
    const manifest = JSON.parse(
      await readFile(
        path.join(outdir, `${stack.artifactId}.assets.json`),
        "utf8",
      ),
    );
    const runtimeAsset = Object.values(
      manifest.files as Record<string, any>,
    ).find(
      (asset: any) =>
        asset.displayName ===
        "GovernedAgentRuntime/AgentRuntimeArtifact",
    ) as any;
    assert.ok(runtimeAsset, "missing governed AgentCore Runtime asset");
    const assetRoot = path.join(outdir, runtimeAsset.source.path);
    assert.deepEqual(await relativeFiles(assetRoot), ["server.js"]);
    const bundle = await readFile(
      path.join(assetRoot, "server.js"),
      "utf8",
    );
    assert.match(bundle, /ConverseCommand/);
    assert.doesNotMatch(bundle, /from\s+["']@aws-sdk\//);
    assert.doesNotMatch(
      bundle,
      /fileURLToPath\(import\.meta\.url\)[\s\S]{0,160}startAgentRuntime\(\)/,
    );
    const launched = await runEntrypoint(
      path.join(assetRoot, "server.js"),
    );
    assert.equal(launched.exitCode, 1);
    assert.match(launched.stderr, /Agent Runtime failed to start\./);
    assert.doesNotMatch(launched.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.doesNotMatch(
      launched.stderr,
      /Dynamic require of "node:https" is not supported/,
    );
    assert.doesNotMatch(launched.stderr, /ERR_INVALID_ARG_TYPE/);
    const running = await probeRunningEntrypoint(
      path.join(assetRoot, "server.js"),
    );
    assert.equal(running.exitedDuringProbe, false, running.stderr);
    assert.doesNotMatch(running.stderr, /EADDRINUSE/);
  } finally {
    await rm(outdir, { force: true, recursive: true });
  }
});

test("AgentCore Runtime asset hash depends only on the bundled output", async () => {
  const source = await readFile(
    path.join(__dirname, "..", "lib", "platform-web-stack.ts"),
    "utf8",
  );
  const artifactStart = source.indexOf(
    "bedrockagentcore.AgentRuntimeArtifact.fromCodeAsset({",
  );
  const artifactEnd = source.indexOf(
    "executionRole: agentRuntimeRole",
    artifactStart,
  );

  assert.ok(artifactStart >= 0, "missing AgentCore Runtime code asset");
  assert.ok(
    artifactEnd > artifactStart,
    "missing AgentCore Runtime execution role",
  );
  assert.match(
    source.slice(artifactStart, artifactEnd),
    /assetHashType:\s*cdk\.AssetHashType\.OUTPUT/,
  );
});

test("Runtime and deployment API roles are least privilege and boundary protected", () => {
  const template = fixture();
  const roleNames = PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>;
  const [runtimeId] = resources(
    template,
    "AWS::BedrockAgentCore::Runtime",
  )[0];
  const endpointEntries = resources(
    template,
    "AWS::BedrockAgentCore::RuntimeEndpoint",
  );
  const sandboxEndpointId = endpointEntries.find(
    ([, endpoint]) => endpoint.Properties?.Name === "Sandbox",
  )?.[0];
  const productionEndpointId = endpointEntries.find(
    ([, endpoint]) => endpoint.Properties?.Name === "Production",
  )?.[0];
  assert.ok(runtimeId);
  assert.ok(sandboxEndpointId);
  assert.ok(productionEndpointId);
  const [runtimeRoleId, runtimeRole] = resources(
    template,
    "AWS::IAM::Role",
  ).find(([, role]) =>
    role.Properties?.RoleName === roleNames.agentRuntime
  ) ?? [];
  const [deploymentRoleId, deploymentRole] = resources(
    template,
    "AWS::IAM::Role",
  ).find(([, role]) =>
    role.Properties?.RoleName === roleNames.deploymentApi
  ) ?? [];
  assert.ok(runtimeRoleId);
  assert.ok(runtimeRole?.Properties?.PermissionsBoundary);
  assert.ok(deploymentRoleId);
  assert.ok(deploymentRole?.Properties?.PermissionsBoundary);

  const runtimeStatements = statementsForRole(template, runtimeRoleId);
  const gatewayInvoke = runtimeStatements.find((statement) =>
    actionList(statement).includes("bedrock-agentcore:InvokeGateway")
  );
  assert.equal(gatewayInvoke, undefined);
  const assumeGatewayRole = runtimeStatements.find((statement) =>
    actionList(statement).includes("sts:AssumeRole")
  );
  assert.deepEqual(assumeGatewayRole, {
    Action: [
      "sts:AssumeRole",
      "sts:SetSourceIdentity",
    ],
    Effect: "Allow",
    Resource: {
      "Fn::GetAtt": [
        resources(template, "AWS::IAM::Role")
          .find(([, role]) =>
            role.Properties?.RoleName === roleNames.gatewayInvoker
          )?.[0],
        "Arn",
      ],
    },
  });
  const replayWrite = runtimeStatements.find((statement) =>
    actionList(statement).includes("dynamodb:PutItem")
  );
  assert.deepEqual(actionList(replayWrite!), ["dynamodb:PutItem"]);
  assert.deepEqual(
    replayWrite!.Condition?.["ForAllValues:StringLike"]?.[
      "dynamodb:LeadingKeys"
    ],
    ["RUNTIME_PROOF#*"],
  );

  const deploymentStatements = statementsForRole(
    template,
    deploymentRoleId,
  );
  const stateRead = deploymentStatements.find((statement) =>
    actionList(statement).includes("dynamodb:GetItem")
  );
  assert.ok(stateRead);
  assert.deepEqual(actionList(stateRead), [
    "dynamodb:GetItem",
    "dynamodb:Query",
  ]);
  assert.deepEqual(
    stateRead.Condition?.["ForAllValues:StringLike"]
      ? stateRead.Condition["ForAllValues:StringLike"][
        "dynamodb:LeadingKeys"
      ]
      : undefined,
    [
      "AGENT#*",
      "APPROVAL#*",
      "BREAK_GLASS",
      "DEPLOYMENT#*",
      "DOMAIN",
      "GRANT#*",
      "MODEL_POLICY",
      "MUTATION#*",
      "PROJECT#*",
    ],
  );
  const runtimeRead = deploymentStatements.find((statement) =>
    actionList(statement).includes("bedrock-agentcore:GetAgentRuntime")
  );
  assert.deepEqual(actionList(runtimeRead!), [
    "bedrock-agentcore:GetAgentRuntime",
  ]);
  const endpointRead = deploymentStatements.find((statement) =>
    actionList(statement).includes(
      "bedrock-agentcore:GetAgentRuntimeEndpoint",
    )
  );
  assert.deepEqual(actionList(endpointRead!), [
    "bedrock-agentcore:GetAgentRuntimeEndpoint",
  ]);
  assert.deepEqual(endpointRead!.Resource, [
    {
      "Fn::GetAtt": [runtimeId, "AgentRuntimeArn"],
    },
    {
      "Fn::GetAtt": [
        sandboxEndpointId,
        "AgentRuntimeEndpointArn",
      ],
    },
    {
      "Fn::GetAtt": [
        productionEndpointId,
        "AgentRuntimeEndpointArn",
      ],
    },
  ]);
  assert.doesNotMatch(
    deploymentStatements.flatMap(actionList).join("\n"),
    /CreateAgentRuntime|UpdateAgentRuntime|DeleteAgentRuntime|InvokeAgentRuntime/,
  );
});

test("Experience API has only the two governed Runtime invocation actions", () => {
  const template = fixture();
  const roleName = (
    PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>
  ).experienceApi;
  const [roleId] = resources(template, "AWS::IAM::Role")
    .find(([, role]) => role.Properties?.RoleName === roleName) ?? [];
  assert.ok(roleId);
  const invocationStatements = statementsForRole(template, roleId)
    .filter((statement) =>
      actionList(statement).some((action) =>
        action.startsWith("bedrock-agentcore:InvokeAgentRuntime")
      )
    );
  assert.equal(invocationStatements.length, 1);
  assert.deepEqual(
    actionList(invocationStatements[0]),
    [
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:InvokeAgentRuntimeForUser",
    ],
  );
  const runtimeId = resources(
    template,
    "AWS::BedrockAgentCore::Runtime",
  )[0]?.[0];
  const productionEndpointId = resources(
    template,
    "AWS::BedrockAgentCore::RuntimeEndpoint",
  ).find(([, endpoint]) =>
    endpoint.Properties?.Name === "Production"
  )?.[0];
  assert.ok(runtimeId);
  assert.ok(productionEndpointId);
  assert.deepEqual(invocationStatements[0].Resource, [
    {
      "Fn::GetAtt": [runtimeId, "AgentRuntimeArn"],
    },
    {
      "Fn::GetAtt": [
        productionEndpointId,
        "AgentRuntimeEndpointArn",
      ],
    },
  ]);
});

test("deployment API exposes only the three authenticated mutation routes", () => {
  const template = fixture();
  const roleName = (
    PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>
  ).deploymentApi;
  const [roleId] = resources(template, "AWS::IAM::Role")
    .find(([, role]) => role.Properties?.RoleName === roleName) ?? [];
  assert.ok(roleId);
  const [functionId, fn] = resources(template, "AWS::Lambda::Function")
    .find(([, candidate]) =>
      candidate.Properties?.Description
        === "Executes governed sandbox and production AgentCore deployments"
  ) ?? [];
  assert.ok(functionId);
  assert.ok(fn);
  assert.equal(fn!.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(fn!.Properties?.Role, {
    "Fn::GetAtt": [roleId, "Arn"],
  });
  assert.ok(fn!.Properties?.Environment?.Variables?.AGENT_RUNTIME_ID);
  assert.equal(
    fn!.Properties?.Environment?.Variables?.SANDBOX_ENDPOINT_NAME,
    "Sandbox",
  );
  assert.equal(
    fn!.Properties?.Environment?.Variables?.PRODUCTION_ENDPOINT_NAME,
    "Production",
  );

  const integrationIds = new Set(
    resources(template, "AWS::ApiGatewayV2::Integration")
      .filter(([, integration]) =>
        JSON.stringify(integration.Properties?.IntegrationUri)
          .includes(functionId)
      )
      .map(([id]) => id),
  );
  assert.equal(integrationIds.size, 1);
  for (const routeKey of [
    "POST /api/deployments/sandbox",
    "POST /api/deployments/production",
    "POST /api/deployment-decisions",
  ]) {
    const route = resources(template, "AWS::ApiGatewayV2::Route")
      .find(([, candidate]) =>
        candidate.Properties?.RouteKey === routeKey
      )?.[1];
    assert.ok(route, routeKey);
    assert.equal(route.Properties?.AuthorizationType, "JWT");
    assert.ok(
      [...integrationIds].some((integrationId) =>
        JSON.stringify(route.Properties?.Target).includes(integrationId)
      ),
      routeKey,
    );
  }
});
