import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  CLOUDFRONT_ALARM_NAME_PATTERN,
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
  PLATFORM_WEB_ROLE_PREFIX,
  PLATFORM_WEB_STACK_NAME,
  REQUIRED_TAGS,
  RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  applyRequiredTags,
  cloudFrontAlarmName,
  contextFlag,
  contextValue,
  requiredContext,
  runtimePermissionsBoundaryDocument,
} from "../lib/config";

test("required deployment tags protect resources from automatic deletion", () => {
  assert.deepEqual(REQUIRED_TAGS, {
    "auto-delete": "no",
    project: "agentic-ai-platform-demo",
    managedBy: "cdk",
  });
});

test("runtime IAM names are fixed to the protected PlatformWebStack namespace", () => {
  assert.equal(PLATFORM_WEB_ROLE_PREFIX, "AgenticPlatform-Web-");
  assert.deepEqual(PLATFORM_WEB_RUNTIME_ROLE_NAMES, {
    accessAdminApi:
      "AgenticPlatform-Web-AccessAdminApiRole",
    agentRuntime:
      "AgenticPlatform-Web-AgentRuntimeRole",
    builderApi:
      "AgenticPlatform-Web-BuilderApiRole",
    cloudFrontAlarmProvider:
      "AgenticPlatform-Web-CloudFrontAlarmProviderRole",
    cloudFrontInvalidationProvider:
      "AgenticPlatform-Web-CloudFrontInvalidationProviderRole",
    controlPlaneReadApi:
      "AgenticPlatform-Web-ControlPlaneReadApiRole",
    deploymentApi:
      "AgenticPlatform-Web-DeploymentApiRole",
    experienceApi:
      "AgenticPlatform-Web-ExperienceApiRole",
    frontendDeployment:
      "AgenticPlatform-Web-FrontendDeploymentRole",
    governanceApi:
      "AgenticPlatform-Web-GovernanceApiRole",
    gatewayInvoker:
      "AgenticPlatform-Web-GatewayInvokerRole",
    hostedAcceptanceBroker:
      "AgenticPlatform-Web-HostedAcceptanceBrokerRole",
    identityApi: "AgenticPlatform-Web-IdentityApiRole",
    journeyApi: "AgenticPlatform-Web-JourneyApiRole",
    modelGovernanceApi:
      "AgenticPlatform-Web-ModelGovernanceApiRole",
    operationsApi:
      "AgenticPlatform-Web-OperationsApiRole",
    platformAdminApi:
      "AgenticPlatform-Web-PlatformAdminApiRole",
    registryDecisionFinalizer:
      "AgenticPlatform-Web-RegistryDecisionFinalizerRole",
    platformStateSeed:
      "AgenticPlatform-Web-PlatformStateSeedRole",
    platformAgentRegistrySeed:
      "AgenticPlatform-Web-PlatformAgentRegistrySeedRole",
    platformWorkspaceSeed:
      "AgenticPlatform-Web-PlatformWorkspaceSeedRole",
    runtimeBoundaryTagProvider:
      "AgenticPlatform-Web-RuntimeBoundaryTagProviderRole",
    runtimeProofConfigurator:
      "AgenticPlatform-Web-RuntimeProofConfiguratorRole",
    runtimeProofProvider:
      "AgenticPlatform-Web-RuntimeProofProviderRole",
    workspaceApi:
      "AgenticPlatform-Web-WorkspaceApiRole",
  });
  assert.equal(
    RUNTIME_PERMISSIONS_BOUNDARY_NAME,
    "AgenticPlatform-Web-RuntimePermissionsBoundary",
  );
  assert.equal(PLATFORM_WEB_STACK_NAME, "AgenticPlatform-Web");
  assert.equal(
    CLOUDFRONT_ALARM_NAME_PATTERN,
    "PlatformWeb-AgenticPlatform-Web-*-CloudFront-5xx",
  );
  assert.equal(
    cloudFrontAlarmName("EDFDVBD6EXAMPLE"),
    "PlatformWeb-AgenticPlatform-Web-EDFDVBD6EXAMPLE-CloudFront-5xx",
  );
});

test("runtime permissions boundary fits the IAM managed-policy quota", () => {
  const boundary = runtimePermissionsBoundaryDocument({
      account: "111122223333",
      agentRuntimeArn:
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
        + "runtime/AgenticPlatformRuntime-ABC1234567",
      agentRuntimeEndpointArnPattern:
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
        + "runtime/AgenticPlatformRuntime-ABC1234567/runtime-endpoint/*",
      cloudFrontAlarmArnPattern:
        "arn:aws:cloudwatch:us-east-1:111122223333:alarm:"
        + "PlatformWeb-AgenticPlatform-Web-*-CloudFront-5xx",
      cloudFrontDistributionArn:
        "arn:aws:cloudfront::111122223333:distribution/E2Q1GZIZ437RNS",
      customerSupportRegistryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/CustomerReg1234",
      gatewayInvokerRoleArn:
        "arn:aws:iam::111122223333:role/"
        + "AgenticPlatform-Web-GatewayInvokerRole",
      journeyGithubOAuthClientSecretArn:
        "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:agentic-platform/github-oauth-ABC123",
      journeyInceptionModelArns: [
        "arn:aws:bedrock:us-west-2:111122223333:"
          + "inference-profile/"
          + "global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:::foundation-model/"
          + "anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:us-west-2::foundation-model/"
          + "anthropic.claude-haiku-4-5-20251001-v1:0",
      ],
      llmGatewayArn:
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
        + "gateway/agentic-demo-llm-gateway-abcdefghij",
      operationsRegistryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/OperatioReg1234",
      partition: "aws",
      platformStateTableArn:
        "arn:aws:dynamodb:us-west-2:111122223333:table/"
        + "AgenticPlatform-Web-PlatformStateTableB6A04393-EXAMPLE01234",
      platformRegistryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/PlatformReg1234",
      qualifier: "hnb659fds",
      registryDecisionFinalizerFunctionArn:
        "arn:aws:lambda:us-west-2:111122223333:function:"
        + "AgenticPlatform-Web-RegistryDecisionFinalizer",
      region: "us-west-2",
      runtimeProofConfiguratorFunctionArn:
        "arn:aws:lambda:us-west-2:111122223333:function:"
        + "AgenticPlatform-Web-RuntimeProofConfigurator",
      runtimeProofConfiguratorRoleArn:
        "arn:aws:iam::111122223333:role/"
        + "AgenticPlatform-Web-RuntimeProofConfiguratorRole",
      runtimeInvocationProofSecretArn:
        "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:AgenticPlatform-Web-RuntimeInvocationProof-ABC123",
      runtimePermissionsBoundaryArn:
        "arn:aws:iam::111122223333:policy/"
        + "AgenticPlatform-Web-RuntimePermissionsBoundary",
      sharedRegistryArn:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/SharedReg123456",
      toolsGatewayArn:
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
        + "gateway/platform-tools-gw-klmnopqrst",
      userPoolArn:
        "arn:aws:cognito-idp:us-west-2:111122223333:"
        + "userpool/us-west-2_EXAMPLE",
    }) as {
      Statement: Record<string, any>[];
    };
  const document = iam.PolicyDocument.fromJson(boundary).toJSON();
  const cognitoActions = boundary.Statement
    .flatMap((statement) => [statement.Action].flat())
    .filter((action) => action.startsWith("cognito-idp:"))
    .sort();
  assert.deepEqual(cognitoActions, [
    "cognito-idp:AdminAddUserToGroup",
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
    "cognito-idp:AdminRemoveUserFromGroup",
    "cognito-idp:CreateGroup",
    "cognito-idp:DeleteGroup",
    "cognito-idp:GetGroup",
    "cognito-idp:ListUsers",
    "cognito-idp:ListUsersInGroup",
  ]);
  assert.equal(
    cognitoActions.some((action) =>
      action === "cognito-idp:Admin*User*Group"
      || action === "cognito-idp:ListUsers*"
    ),
    false,
  );

  const deleteRegistryStatements = boundary.Statement.filter((statement) =>
    [statement.Action].flat().includes("agent-registry:DeleteRegistry")
  );
  assert.deepEqual(deleteRegistryStatements, [{
    Effect: "Allow",
    Action: [
      "agent-registry:SubmitRegistryRecordForApproval",
      "agent-registry:DeleteRegistry",
    ],
    Resource:
      "arn:aws:agent-registry:us-west-2:111122223333:registry/*",
    Condition: {
      StringEquals: {
        "aws:ResourceTag/auto-delete": "no",
        "aws:ResourceTag/managedBy": ["cdk", "hosted-acceptance"],
        "aws:ResourceTag/project": "agentic-ai-platform-demo",
      },
    },
  }]);

  const gatewayInvoke = boundary.Statement.find((statement) =>
    statement.Action.includes("bedrock-agentcore:InvokeGateway")
  );
  assert.deepEqual(gatewayInvoke, {
    Effect: "Allow",
    Action: "bedrock-agentcore:InvokeGateway",
    Resource:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "gateway/agentic-demo-llm-gateway-abcdefghij",
    Condition: {
      ArnEquals: {
        "aws:PrincipalArn":
          "arn:aws:iam::111122223333:role/"
          + "AgenticPlatform-Web-GatewayInvokerRole",
      },
    },
  });
  const gatewayAssume = boundary.Statement.find((statement) =>
    [statement.Action].flat().includes("sts:SetSourceIdentity")
  );
  assert.ok(gatewayAssume);
  assert.ok([gatewayAssume.Action].flat().includes("sts:AssumeRole"));
  assert.ok(
    [gatewayAssume.Action].flat().includes("sts:SetSourceIdentity"),
  );
  const secretRead = boundary.Statement.find((statement) =>
    [statement.Action].flat().includes("secretsmanager:GetSecretValue")
  );
  assert.deepEqual(secretRead, {
    Effect: "Allow",
    Action: "secretsmanager:GetSecretValue",
    Resource: [
      "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:AgenticPlatform-Web-RuntimeInvocationProof-ABC123",
      "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:agentic-platform/github-oauth-ABC123",
    ],
  });
  const proofSecretWrite = boundary.Statement.find((statement) =>
    [statement.Action].flat().includes("secretsmanager:PutSecretValue")
  );
  assert.deepEqual(proofSecretWrite, {
    Effect: "Allow",
    Action: "secretsmanager:PutSecretValue",
    Resource:
      "arn:aws:secretsmanager:us-west-2:111122223333:"
      + "secret:AgenticPlatform-Web-RuntimeInvocationProof-ABC123",
    Condition: {
      ArnEquals: {
        "aws:PrincipalArn":
          "arn:aws:iam::111122223333:role/"
          + "AgenticPlatform-Web-RuntimeProofConfiguratorRole",
      },
    },
  });
  const oauthSecretRead = boundary.Statement.find((statement) =>
    [statement.Action].flat().includes("secretsmanager:GetSecretValue")
    && [statement.Resource].flat().includes(
      "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:agentic-platform/github-oauth-ABC123",
    )
  );
  assert.equal(oauthSecretRead?.Effect, "Allow");
  assert.equal(
    [oauthSecretRead?.Action].flat().includes(
      "secretsmanager:GetSecretValue",
    ),
    true,
  );
  const secretResources = [oauthSecretRead?.Resource].flat()
    .filter((resource) =>
      typeof resource === "string"
      && resource.startsWith(
        "arn:aws:secretsmanager:us-west-2:111122223333:secret:",
      )
    );
  assert.deepEqual(
    secretResources.sort(),
    [
      "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:AgenticPlatform-Web-RuntimeInvocationProof-ABC123",
      "arn:aws:secretsmanager:us-west-2:111122223333:"
        + "secret:agentic-platform/github-oauth-ABC123",
    ].sort(),
  );
  assert.equal(
    secretResources.some((resource) =>
      typeof resource === "string" && resource.includes("*")
    ),
    false,
  );

  const boundaryLength = JSON.stringify(document).length;
  assert.ok(
    boundaryLength <= 6_144,
    "runtime boundary must fit IAM's 6,144-character managed-policy quota "
      + `(rendered ${boundaryLength})`,
  );
});

test("applyRequiredTags adds every required tag to taggable resources", () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TaggedStack");
  new s3.CfnBucket(stack, "Bucket");

  applyRequiredTags(stack);

  Template.fromStack(stack).hasResourceProperties("AWS::S3::Bucket", {
    Tags: Match.arrayWith([
      { Key: "auto-delete", Value: "no" },
      { Key: "managedBy", Value: "cdk" },
      { Key: "project", Value: "agentic-ai-platform-demo" },
    ]),
  });
});

test("contextValue prefers a string context value and otherwise uses the fallback", () => {
  assert.equal(contextValue({ value: "  from-context  " }, "value", "fallback"), "from-context");
  assert.equal(contextValue({ value: "   " }, "value", "fallback"), "fallback");
  assert.equal(contextValue({}, "value", "fallback"), "fallback");
});

test("contextFlag enables a feature only for an explicit boolean or lowercase true string", () => {
  assert.equal(contextFlag({ value: true }, "value"), true);
  assert.equal(contextFlag({ value: "true" }, "value"), true);

  for (const value of [undefined, false, "false", "TRUE", "1", 1, " yes "]) {
    assert.equal(contextFlag({ value }, "value"), false);
  }
});

test("requiredContext rejects an absent value", () => {
  assert.throws(() => requiredContext({}, "account"), /Missing required CDK context: account/);
});
