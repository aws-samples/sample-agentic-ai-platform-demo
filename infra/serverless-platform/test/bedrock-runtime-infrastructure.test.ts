import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { bedrockRuntimeResources, PLATFORM_WEB_RUNTIME_ROLE_NAMES } from "../lib/config";
import { PlatformWebStack } from "../lib/platform-web-stack";

const profiles = [
  "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "global.openai.gpt-6-astra",
];
const env = { account: "111122223333", region: "us-west-2" };
const list = (value: any): any[] => Array.isArray(value) ? value : [value];

test("profile IAM includes only exact selected profiles and evidenced backing foundation models", () => {
  const resources = bedrockRuntimeResources(profiles, { ...env, partition: "aws" });
  assert.equal(resources.length, 6);
  assert.deepEqual(resources, profiles.flatMap(profile => [
    `arn:aws:bedrock:us-west-2:111122223333:inference-profile/${profile}`,
    `arn:aws:bedrock:::foundation-model/${profile.slice(7)}`,
    `arn:aws:bedrock:us-west-2::foundation-model/${profile.slice(7)}`,
  ]));
  assert.equal(resources.some(value => value.includes("*")), false);
  const us = bedrockRuntimeResources(["us.openai.gpt-6-astra"], { ...env, partition: "aws" });
  assert.equal(us.length, 4);
  for (const region of ["us-east-1", "us-east-2", "us-west-2"]) {
    assert.ok(us.includes(`arn:aws:bedrock:${region}::foundation-model/openai.gpt-6-astra`));
  }
  for (const selection of [["*"], ["global.openai.gpt-5.5"], [profiles[0], profiles[0]]]) {
    assert.throws(() => bedrockRuntimeResources(selection, { ...env, partition: "aws" }));
  }
});

test("opt-in grants affect only Runtime/Builder and effective boundary; Gateway tools and disabled defaults remain", () => {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, "BedrockRuntimeInfrastructure", {
    env, cognitoDomainPrefix: "synthetic-runtime-inference",
    llmGatewayId: "test-gateway-abcdefghij", llmGatewayRegion: "us-west-2",
    starterBuilderModelId: "bedrock-claude/anthropic.claude-haiku-4-5",
    bedrockRuntimeProfileIds: profiles,
  });
  const template = Template.fromStack(stack);
  const roles = template.findResources("AWS::IAM::Role");
  const policies = template.findResources("AWS::IAM::Policy");
  const expected = stack.resolve(bedrockRuntimeResources(profiles, {
    ...env, partition: stack.partition,
  }));
  const consumers = [];
  for (const [roleId, role] of Object.entries(roles)) {
    const statements = [
      ...(role.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement),
      ...Object.values(policies).filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleId))
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement),
    ];
    const inference = statements.filter((s: any) => list(s.Action).includes("bedrock:InvokeModel"));
    for (const statement of inference) {
      consumers.push(role.Properties.RoleName);
      assert.deepEqual(list(statement.Action), ["bedrock:InvokeModel"]);
      assert.deepEqual(statement.Resource, expected);
      assert.ok(role.Properties.PermissionsBoundary);
    }
    if (role.Properties.RoleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.gatewayInvoker) {
      assert.ok(statements.some((s: any) => list(s.Action).includes("bedrock-agentcore:InvokeGateway")));
    }
    if (role.Properties.RoleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.builderApi) {
      assert.ok(statements.some((s: any) => list(s.Action).includes("bedrock-agentcore:ListGatewayTargets")));
    }
  }
  assert.deepEqual(consumers.sort(), [
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime, PLATFORM_WEB_RUNTIME_ROLE_NAMES.builderApi,
  ].sort());
  const boundaries = template.findResources("AWS::IAM::ManagedPolicy");
  const [boundaryId, boundaryResource] = Object.entries(boundaries).find(([, resource]) =>
    resource.Properties.ManagedPolicyName === "AgenticPlatform-Web-BedrockConsumerBoundary")!;
  const boundary = boundaryResource.Properties.PolicyDocument;
  const inference = boundary.Statement.filter((s: any) => list(s.Action).includes("bedrock:InvokeModel"));
  assert.equal(inference.length, 1);
  assert.deepEqual(inference[0].Resource, expected);
  assert.deepEqual(list(inference[0].Action), ["bedrock:InvokeModel"]);
  const size = JSON.stringify(boundary).length;
  assert.ok(size <= 6144, `symbolic opt-in boundary size ${size} exceeds 6144`);
  for (const role of Object.values(roles)) {
    const consumer = consumers.includes(role.Properties.RoleName);
    assert.equal(JSON.stringify(role.Properties.PermissionsBoundary ?? null).includes(boundaryId), consumer);
  }
  const allowed = boundary.Statement.flatMap((s: any) => list(s.Action));
  for (const [roleId, role] of Object.entries(roles)) {
    if (!consumers.includes(role.Properties.RoleName)) continue;
    const statements = [
      ...(role.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement),
      ...Object.values(policies).filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleId))
        .flatMap((p: any) => p.Properties.PolicyDocument.Statement),
    ];
    const missing = statements.flatMap((s: any) => list(s.Action)).filter(action =>
      !allowed.some((ceiling: string) => ceiling === action
        || (ceiling.endsWith("*") && action.startsWith(ceiling.slice(0, -1)))));
    assert.deepEqual(missing, [], `missing boundary actions for ${role.Properties.RoleName}`);
  }
  for (const resource of Object.values(template.findResources("AWS::BedrockAgentCore::Runtime"))) {
    assert.equal(resource.Properties.EnvironmentVariables.MODEL_INFERENCE_ROUTE, undefined);
    assert.equal(resource.Properties.EnvironmentVariables.RUNTIME_CONVERSE_READER_VERSION, undefined);
    assert.equal(resource.Properties.AgentRuntimeArtifact.CodeConfiguration.Runtime, "NODE_22");
  }
  // The Builder draft-test action reads this configuration; granting the IAM
  // without it leaves Converse permanently unusable. Every baseline domain is
  // authorized, platform included — the platform team builds its own agents.
  const builderEnv = Object.values(template.findResources("AWS::Lambda::Function"))
    .map((resource: any) => resource.Properties.Environment?.Variables)
    .filter((variables: any) => variables?.MODEL_INFERENCE_ROUTE !== undefined);
  assert.equal(builderEnv.length, 1);
  assert.equal(builderEnv[0].MODEL_INFERENCE_ROUTE, "bedrock-runtime-converse-v1");
  assert.equal(builderEnv[0].BEDROCK_RUNTIME_REGION, "us-west-2");
  assert.deepEqual(JSON.parse(builderEnv[0].BEDROCK_RUNTIME_MODELS_JSON), [{
    modelId: "bedrock-claude/anthropic.claude-haiku-4-5",
    domains: ["platform", "customer_support", "operations"],
  }]);
  const report = new AwsSolutionsChecks(undefined, { verbose: true }).validateScope(stack);
  assert.equal(report.success, true, JSON.stringify(report.violations, null, 2));
});
