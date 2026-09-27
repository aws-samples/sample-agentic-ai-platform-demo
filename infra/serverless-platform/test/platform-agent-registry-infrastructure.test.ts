import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
} from "../lib/config";
import { PlatformWebStack } from "../lib/platform-web-stack";

type Resource = {
  DependsOn?: string | string[];
  DeletionPolicy?: string;
  Properties?: Record<string, any>;
  UpdateReplacePolicy?: string;
};

const MODEL_ID = "bedrock-mantle/anthropic.claude-haiku-4-5";

function fixture() {
  const app = new cdk.App();
  const stack = new PlatformWebStack(
    app,
    "PlatformAgentRegistryInfrastructureTest",
    {
      env: { account: "111122223333", region: "us-west-2" },
      cognitoDomainPrefix: "platform-agent-registry-test",
      llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
      llmGatewayRegion: "us-west-2",
      starterBuilderModelId: MODEL_ID,
      inceptionModelId: MODEL_ID,
    },
  );
  return Template.fromStack(stack);
}

function resources(
  template: Template,
  type: string,
): Array<[string, Resource]> {
  return Object.entries(template.findResources(type)) as
    Array<[string, Resource]>;
}

function roleByName(template: Template, roleName: string) {
  return resources(template, "AWS::IAM::Role")
    .find(([, role]) => role.Properties?.RoleName === roleName);
}

function statementsForRole(
  template: Template,
  roleId: string,
): Record<string, any>[] {
  return [
    ...(template.findResources("AWS::IAM::Role")[roleId]
      ?.Properties?.Policies ?? []).flatMap(
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

function actions(statement: Record<string, any>): string[] {
  return [statement.Action].flat().sort();
}

test("deployment seeds one retained platform Agent Design Assistant record after the production Runtime exists", () => {
  const template = fixture();
  const roleName =
    (PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>)
      .platformAgentRegistrySeed;
  assert.equal(
    roleName,
    "AgenticPlatform-Web-PlatformAgentRegistrySeedRole",
  );
  const [roleId, role] = roleByName(template, roleName) ?? [];
  assert.ok(roleId);
  assert.ok(role?.Properties?.PermissionsBoundary);

  const [functionId, fn] = resources(template, "AWS::Lambda::Function")
    .find(([, candidate]) =>
      candidate.Properties?.Description
        === "Seeds the platform Agent Design Assistant Registry record"
  ) ?? [];
  assert.ok(functionId);
  assert.ok(fn);
  assert.equal(fn.Properties?.Runtime, "nodejs24.x");
  assert.deepEqual(fn.Properties?.Architectures, ["arm64"]);
  assert.deepEqual(fn.Properties?.Role, {
    "Fn::GetAtt": [roleId, "Arn"],
  });
  assert.equal(fn.Properties?.Timeout, 120);

  const [runtimeId] = resources(
    template,
    "AWS::BedrockAgentCore::Runtime",
  )[0];
  const [endpointId] = resources(
    template,
    "AWS::BedrockAgentCore::RuntimeEndpoint",
  ).find(([, endpoint]) => endpoint.Properties?.Name === "Production")!;
  const [seedId, seed] = resources(
    template,
    "Custom::PlatformAgentDesignAssistant",
  )[0] ?? [];
  assert.ok(seedId);
  assert.deepEqual(seed.Properties, {
    ServiceToken: {
      "Fn::GetAtt": [functionId, "Arn"],
    },
    ServiceTimeout: "180",
    AccountId: "111122223333",
    GatewayModelId: MODEL_ID,
    PlatformRegistryArn: {
      "Fn::ImportValue":
        "AgenticPlatform-ControlPlane-Registry-platform-Arn",
    },
    PlatformRegistryId: {
      "Fn::ImportValue":
        "AgenticPlatform-ControlPlane-Registry-platform-Id",
    },
    ProductionEndpointArn: {
      "Fn::GetAtt": [endpointId, "AgentRuntimeEndpointArn"],
    },
    ProductionEndpointName: "Production",
    Region: "us-west-2",
    RuntimeArn: {
      "Fn::GetAtt": [runtimeId, "AgentRuntimeArn"],
    },
  });
  const dependencies = [seed.DependsOn].flat();
  assert.equal(dependencies.includes(endpointId), true);
  assert.equal(dependencies.includes(functionId), true);

  const [, logGroup] = resources(template, "AWS::Logs::LogGroup")
    .find(([logicalId]) =>
      logicalId.startsWith("PlatformAgentRegistrySeedLogs")
    ) ?? [];
  assert.ok(logGroup);
  assert.equal(logGroup.Properties?.RetentionInDays, 90);
  assert.equal(logGroup.DeletionPolicy, "Retain");
  assert.equal(logGroup.UpdateReplacePolicy, "Retain");
});

test("platform assistant seeder IAM is restricted to logs and the imported Platform Registry", () => {
  const template = fixture();
  const roleName =
    (PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>)
      .platformAgentRegistrySeed;
  const [roleId] = roleByName(template, roleName) ?? [];
  assert.ok(roleId);
  const statements = statementsForRole(template, roleId);
  assert.deepEqual(
    statements.flatMap(actions).sort(),
    [
      "agent-registry:CreateRegistryRecord",
      "agent-registry:GetRegistryRecord",
      "agent-registry:ListRegistryRecords",
      "agent-registry:ListTagsForResource",
      "agent-registry:SubmitRegistryRecordForApproval",
      "agent-registry:TagResource",
      "agent-registry:UpdateRegistryRecordStatus",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ].sort(),
  );
  assert.equal(
    statements.some((statement) =>
      JSON.stringify(statement.Resource).includes(
        "AgenticPlatform-ControlPlane-Registry-platform-Arn",
      )),
    true,
  );
  assert.equal(
    statements.some((statement) =>
      JSON.stringify(statement.Resource).includes(
        "AgenticPlatform-ControlPlane-SharedRegistryArn",
      )),
    false,
  );
  assert.equal(
    statements.some((statement) =>
      [statement.Resource].flat().includes("*")
    ),
    false,
  );
});
