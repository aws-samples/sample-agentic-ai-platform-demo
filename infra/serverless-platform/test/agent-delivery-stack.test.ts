import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { AgentDeliveryStack, AgentDeliveryTarget } from "../lib/agent-delivery-stack";

const target: AgentDeliveryTarget = {
  accountId: "123456789012", region: "us-west-2", apiId: "example",
  authorizerId: "jwt", tableName: "PlatformState", userPoolId: "us-west-2_example",
  trustedWorkflowRef: `owner/platform/.github/workflows/agent-delivery.yml@${"a".repeat(40)}`,
  bindings: [{
    id: "contract", domainId: "platform", projectId: "foundation", agentId: "contract",
    repository: "owner/contract", repositoryId: "123", requesterSubject: "builder",
    runtimeName: "contract", modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
    inferenceProfileId: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    entrypoint: "main.py", pythonRuntime: "PYTHON_3_14", evaluationThreshold: 0.8,
  }],
};
const template = Template.fromStack(new AgentDeliveryStack(new cdk.App(), "Delivery", target));
const resources = template.toJSON().Resources;

test("pipeline orders verified environments before native human approval and prod", () => {
  const pipeline: any = Object.values(resources).find((r: any) => r.Type === "AWS::CodePipeline::Pipeline");
  assert.deepEqual(pipeline.Properties.Stages.map((s: any) => s.Name),
    ["Source", "Dev", "Preprod", "ProductionApproval", "Production"]);
  assert.equal(pipeline.Properties.ExecutionMode, "QUEUED");
  assert.equal(pipeline.Properties.Stages[3].Actions[0].ActionTypeId.Provider, "Manual");
  assert.equal(pipeline.Properties.Stages[0].Actions[0].Configuration.PollForSourceChanges, false);
});

test("all delivery IAM roles have boundaries and uploader is pinned to repo ID and platform commit", () => {
  const roles: any[] = Object.values(resources).filter((r: any) => r.Type === "AWS::IAM::Role");
  assert.ok(roles.length >= 8);
  for (const role of roles) assert.ok(role.Properties.PermissionsBoundary);
  const uploader = roles.find(r => JSON.stringify(r).includes("job_workflow_ref:"));
  assert.ok(uploader);
  assert.match(JSON.stringify(uploader), /repository_id:123:job_workflow_ref:/);
  assert.ok(JSON.stringify(uploader).includes(target.trustedWorkflowRef));
});

test("human approval permission targets the exact native action in role and boundary", () => {
  const policies: any[] = Object.values(resources).filter((r: any) =>
    ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(r.Type) &&
    JSON.stringify(r).includes("codepipeline:PutApprovalResult"));
  assert.equal(policies.length, 2);
  for (const policy of policies) {
    const statement = policy.Properties.PolicyDocument.Statement.find((s: any) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("codepipeline:PutApprovalResult"));
    assert.equal(statement.Action, "codepipeline:PutApprovalResult");
    assert.match(JSON.stringify(statement.Resource), /\/ProductionApproval\/HumanDecision/);
    assert.doesNotMatch(JSON.stringify(statement.Resource), /\*/);
  }
});

test("verification actor permission stays within the owning runtime in role and boundary", () => {
  const statements = Object.values(resources).flatMap((resource: any) =>
    ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(resource.Type)
      ? resource.Properties.PolicyDocument.Statement : [])
    .filter((statement: any) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action])
        .includes("bedrock-agentcore:InvokeAgentRuntimeForUser"));
  assert.equal(statements.length, 6);
  for (const statement of statements) {
    assert.equal(statement.Resource.length, 2);
    for (const arn of statement.Resource) {
      assert.match(arn, /^arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime\/contract_(dev|preprod|prod)-\*/);
    }
  }
});

test("trusted buildspec does not run source scripts or deploy using builder credentials", () => {
  const builds: any[] = Object.values(resources).filter((r: any) => r.Type === "AWS::CodeBuild::Project");
  assert.equal(builds.length, 3);
  for (const build of builds) {
    const spec = JSON.stringify(build.Properties.Source.BuildSpec);
    assert.match(spec, /platform-deploy.py/);
    assert.doesNotMatch(spec, /agentcore deploy|npm run|bash |source |\.\/scripts/);
  }
});

test("runtime model permission requires the published guardrail version rather than DRAFT", () => {
  const guardrail = Object.keys(resources).find(k => resources[k].Type === "AWS::Bedrock::Guardrail")!;
  const version = Object.keys(resources).find(k => resources[k].Type === "AWS::Bedrock::GuardrailVersion")!;
  const policies: any[] = Object.values(resources).filter((r: any) =>
    ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(r.Type) &&
    JSON.stringify(r).includes("bedrock:InvokeModelWithResponseStream"));
  assert.equal(policies.length, 6);
  for (const policy of policies) {
    const invoke = policy.Properties.PolicyDocument.Statement.find((s: any) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes("bedrock:InvokeModelWithResponseStream"));
    assert.deepEqual(invoke.Condition.StringEquals["bedrock:GuardrailIdentifier"], {
      "Fn::Join": ["", [{"Fn::GetAtt": [guardrail, "GuardrailArn"]}, ":", {"Fn::GetAtt": [version, "Version"]}]],
    });
  }
});

test("session message replacement can delete events only from the environment Memory", () => {
  const policies: any[] = Object.values(resources).filter((r: any) =>
    ["AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"].includes(r.Type) &&
    JSON.stringify(r).includes("bedrock-agentcore:DeleteEvent"));
  assert.equal(policies.length, 6);
  for (const policy of policies) {
    const statement = policy.Properties.PolicyDocument.Statement.find((s: any) =>
      Array.isArray(s.Action) && s.Action.includes("bedrock-agentcore:DeleteEvent"));
    assert.equal(statement.Resource.length, 2);
    const memoryRef = statement.Resource[0]["Fn::GetAtt"];
    assert.equal(memoryRef[1], "MemoryArn");
    assert.equal(resources[memoryRef[0]].Type, "AWS::BedrockAgentCore::Memory");
    assert.deepEqual(statement.Resource[1], {"Fn::Join": ["", [
      {"Fn::GetAtt": memoryRef}, "/*",
    ]]});
  }
});

test("runtime creation dependency retains the environment ownership conditions", () => {
  const boundaries: any[] = Object.values(resources).filter((r: any) =>
    r.Type === "AWS::IAM::ManagedPolicy" && JSON.stringify(r).includes("CreateAgentRuntimeEndpoint"));
  assert.equal(boundaries.length, 3);
  const environments = new Set<string>();
  for (const boundary of boundaries) {
    const statement = boundary.Properties.PolicyDocument.Statement.find((s: any) =>
      s.Action.includes("bedrock-agentcore:CreateAgentRuntimeEndpoint"));
    assert.ok(statement.Action.includes("bedrock-agentcore:CreateAgentRuntime"));
    const tags = statement.Condition.StringEquals;
    assert.equal(tags["aws:RequestTag/domain-id"], "platform");
    assert.equal(tags["aws:RequestTag/project-id"], "foundation");
    environments.add(tags["aws:RequestTag/environment"]);
    const creationTags = boundary.Properties.PolicyDocument.Statement.find((s: any) =>
      s.Action === "bedrock-agentcore:TagResource" && s.Condition);
    assert.deepEqual(creationTags.Resource, [
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/*",
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default",
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default/workload-identity/*",
    ]);
    assert.deepEqual(creationTags.Condition, statement.Condition);
    const identity = boundary.Properties.PolicyDocument.Statement.find((s: any) =>
      s.Action === "bedrock-agentcore:CreateWorkloadIdentity");
    assert.deepEqual(identity.Resource, [
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default",
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default/workload-identity/*",
    ]);
    assert.deepEqual(identity.Condition, statement.Condition);
  }
  assert.deepEqual([...environments].sort(), ["dev", "preprod", "prod"]);
});

test("source, audit and memory persist, and release API requires JWT", () => {
  for (const resource of Object.values(resources) as any[]) {
    if (["AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::BedrockAgentCore::Memory"].includes(resource.Type))
      assert.equal(resource.DeletionPolicy, "Retain");
    if (resource.Type === "AWS::ApiGatewayV2::Route") assert.equal(resource.Properties.AuthorizationType, "JWT");
  }
});

test("reject mutable trusted workflow references", () => {
  assert.throws(() => new AgentDeliveryStack(new cdk.App(), "Invalid", {
    ...target, trustedWorkflowRef: "owner/platform/.github/workflows/agent-delivery.yml@main",
  }), /immutable/);
});

test("packaging cannot request OIDC; publisher starts a clean runner and never checks out caller code", () => {
  const workflow = parse(readFileSync("../../.github/workflows/agent-delivery.yml", "utf8"));
  assert.equal(workflow.permissions["id-token"], undefined);
  assert.equal(workflow.jobs.package.permissions["id-token"], undefined);
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.equal(workflow.jobs.publish.needs, "package");
  const steps = workflow.jobs.publish.steps;
  assert.equal(steps.some((s: any) => s.uses?.startsWith("actions/checkout")), false);
  assert.equal(steps.some((s: any) => s.uses?.startsWith("actions/download-artifact")), true);
});
