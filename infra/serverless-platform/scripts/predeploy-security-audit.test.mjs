import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import configModule from "../lib/config.ts";
import bootstrapStackModule from "../lib/github-bootstrap-stack.ts";
import {
  AuditCommandError,
  auditPredeploy,
  compactRuntimeBoundary,
  createCommandRunner,
  normalizeGitHubRepositoryRemote,
  redactSensitiveText,
} from "./predeploy-security-audit.mjs";

const { runtimePermissionsBoundaryDocument } = configModule;
const { GitHubBootstrapStack } = bootstrapStackModule;

const packageDocument = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const auditScriptUrl = new URL("./predeploy-security-audit.mjs", import.meta.url);

const ACCOUNT_ID = ["1111", "2222", "3333"].join("");
const REGION = "us-west-2";
const REPOSITORY = "example-org/example-repo";
const OIDC_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:`
  + "oidc-provider/token.actions.githubusercontent.com";
const CALLER_ARN =
  `arn:aws:sts::${ACCOUNT_ID}:assumed-role/DeploymentRole/session`;
const BOOTSTRAP_PARAMETER = "/cdk-bootstrap/hnb659fds/version";
const RUNTIME_BOUNDARY_NAME =
  "AgenticPlatform-Web-RuntimePermissionsBoundary";
const RUNTIME_BOUNDARY_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:policy/${RUNTIME_BOUNDARY_NAME}`;
const GATEWAY_INVOKER_ROLE_NAME =
  "AgenticPlatform-Web-GatewayInvokerRole";
const GATEWAY_INVOKER_ROLE_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:role/${GATEWAY_INVOKER_ROLE_NAME}`;
const GATEWAY_INVOKER_POLICY_NAME = "InvokeGovernedGateway";
const MODEL_GOVERNANCE_ROLE_NAME =
  "AgenticPlatform-Web-ModelGovernanceApiRole";
const MODEL_GOVERNANCE_POLICY_NAME = "ModelGovernanceApi";
const MODEL_GOVERNANCE_XRAY_POLICY_NAME =
  "ModelGovernanceApiRoleDefaultPolicy716A6728";
const RUNTIME_INVOCATION_PROOF_SECRET_NAME =
  "RuntimeInvocationProofSecre-AbCdEfGhIjKl-ABC123";
const RUNTIME_INVOCATION_PROOF_SECRET_ARN =
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:`
  + `secret:${RUNTIME_INVOCATION_PROOF_SECRET_NAME}`;
const JOURNEY_INCEPTION_MODEL_ARNS = [
  `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/`
    + "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "arn:aws:bedrock:::foundation-model/"
    + "anthropic.claude-haiku-4-5-20251001-v1:0",
  `arn:aws:bedrock:${REGION}::foundation-model/`
    + "anthropic.claude-haiku-4-5-20251001-v1:0",
];
const JOURNEY_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890abcdef";
const JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN =
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:`
  + "secret:AgenticPlatform-GitHubOAuth-ABC123";
const RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN =
  `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
  + "function:AgenticPlatform-Web-RuntimeProofConfigurator";
const RUNTIME_PROOF_CONFIGURATOR_FUNCTION_NAME =
  "AgenticPlatform-Web-RuntimeProofConfigurator";
const RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME =
  "AgenticPlatform-Web-RuntimeProofConfiguratorRole";
const RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:role/`
  + RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME;
const RUNTIME_PROOF_CONFIGURATOR_POLICY_NAME =
  "RuntimeProofConfiguration";
const RUNTIME_PROOF_PROVIDER_ROLE_NAME =
  "AgenticPlatform-Web-RuntimeProofProviderRole";
const RUNTIME_PROOF_PROVIDER_LOG_POLICY_NAME =
  "RuntimeProofProviderLogs";
const RUNTIME_PROOF_PROVIDER_DEFAULT_POLICY_NAME =
  "RuntimeProofProviderRoleDefaultPolicy5A650FD2";
const CONTROL_PLANE_RUNTIME_BOUNDARY_NAME =
  "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary";
const CONTROL_PLANE_RUNTIME_BOUNDARY_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:policy/`
  + CONTROL_PLANE_RUNTIME_BOUNDARY_NAME;
const CLOUDFORMATION_EXECUTION_ROLE_NAME =
  "AgenticPlatformCloudFormationExecutionRole";
const CLOUDFORMATION_EXECUTION_ROLE_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:role/`
  + CLOUDFORMATION_EXECUTION_ROLE_NAME;
const CLOUDFORMATION_EXECUTION_ROLE_TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Service: "cloudformation.amazonaws.com" },
    Action: "sts:AssumeRole",
  }],
};
const CONTROL_PLANE_ROLE_PREFIX =
  "AgenticPlatform-ControlPlane-Provisioned-";
const CONTROL_PLANE_ROLE_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:role/${CONTROL_PLANE_ROLE_PREFIX}*`;
const CONTROL_PLANE_EXECUTION_POLICY_NAMES = [
  "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleManagement",
  "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleDelegation",
  "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleBoundary",
  "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment",
  "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment",
  "AgenticPlatform-GitHubBootstrap-ControlPlaneGatewayDeployment",
  "AgenticPlatform-GitHubBootstrap-AgentRuntimeDeployment",
  "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment",
];
const CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME =
  "CloudFormationExecutionRoleDefaultPolicy5CFF329B";
const CONTROL_PLANE_DEPLOYMENT_POLICY_NAME =
  "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment";
const CONTROL_PLANE_DEPLOYMENT_POLICY_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:policy/`
  + CONTROL_PLANE_DEPLOYMENT_POLICY_NAME;
const CONTROL_PLANE_REGISTRY_DEPLOYMENT_POLICY_NAME =
  "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment";
const PROVISIONED_CONTROL_PLANE_ROLE_NAMES = [
  `${CONTROL_PLANE_ROLE_PREFIX}RegistryOnEventHandlerRole`,
  `${CONTROL_PLANE_ROLE_PREFIX}RegistryIsCompleteHandlerRole`,
  `${CONTROL_PLANE_ROLE_PREFIX}ProviderOnEventRole`,
  `${CONTROL_PLANE_ROLE_PREFIX}ProviderIsCompleteRole`,
  `${CONTROL_PLANE_ROLE_PREFIX}ProviderOnTimeoutRole`,
  `${CONTROL_PLANE_ROLE_PREFIX}ProviderWaiterRole`,
  `${CONTROL_PLANE_ROLE_PREFIX}LlmGatewayRole`,
  `${CONTROL_PLANE_ROLE_PREFIX}ToolsGatewayRole`,
];
const PROVISIONED_CONTROL_PLANE_ROLE_FIXTURES = [
  ["RegistryOnEventHandlerServiceRoleABC123", "lambda.amazonaws.com"],
  ["RegistryIsCompleteHandlerServiceRoleABC123", "lambda.amazonaws.com"],
  ["RegistryProviderframeworkonEventServiceRoleABC123", "lambda.amazonaws.com"],
  [
    "RegistryProviderframeworkisCompleteServiceRoleABC123",
    "lambda.amazonaws.com",
  ],
  ["RegistryProviderframeworkonTimeoutServiceRoleABC123", "lambda.amazonaws.com"],
  ["RegistryProviderwaiterstatemachineRoleABC123", "states.amazonaws.com"],
  ["LlmGatewayRoleABC123", "bedrock-agentcore.amazonaws.com"],
  ["ToolsGatewayRoleABC123", "bedrock-agentcore.amazonaws.com"],
].map(([logicalResourceId, service], index) => ({
  logicalResourceId,
  roleName: PROVISIONED_CONTROL_PLANE_ROLE_NAMES[index],
  service,
}));
const CONTROL_PLANE_STACK_NAME = "AgenticPlatform-ControlPlane";
const PROVISIONED_CONTROL_PLANE_STACK_NAME =
  "AgenticPlatform-ControlPlane-Provisioned";
const CONTROL_PLANE_IDS = {
  sharedRegistryId: "SharedReg123456",
  registryPlatformId: "PlatformReg1234",
  registryCustomerSupportId: "CustomerReg1234",
  registryOperationsId: "OperatioReg1234",
  llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  llmGatewayRegion: "us-east-1",
  toolsGatewayId: "platform-tools-gw-klmnopqrst",
};
const CONTROL_PLANE_ARNS = {
  sharedRegistryArn:
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
    + `registry/${CONTROL_PLANE_IDS.sharedRegistryId}`,
  platformRegistryArn:
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
    + `registry/${CONTROL_PLANE_IDS.registryPlatformId}`,
  customerSupportRegistryArn:
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
    + `registry/${CONTROL_PLANE_IDS.registryCustomerSupportId}`,
  operationsRegistryArn:
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
    + `registry/${CONTROL_PLANE_IDS.registryOperationsId}`,
  llmGatewayArn:
    `arn:aws:bedrock-agentcore:${CONTROL_PLANE_IDS.llmGatewayRegion}:`
    + `${ACCOUNT_ID}:`
    + `gateway/${CONTROL_PLANE_IDS.llmGatewayId}`,
  toolsGatewayArn:
    `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
    + `gateway/${CONTROL_PLANE_IDS.toolsGatewayId}`,
};
const CLOUDFRONT_DISTRIBUTION_ID = "EDFDVBD6EXAMPLE";
const CLOUDFRONT_ALARM_NAME =
  `PlatformWeb-AgenticPlatform-Web-${CLOUDFRONT_DISTRIBUTION_ID}`
  + "-CloudFront-5xx";
const CLOUDFRONT_DISTRIBUTION_ARN =
  `arn:aws:cloudfront::${ACCOUNT_ID}:`
  + `distribution/${CLOUDFRONT_DISTRIBUTION_ID}`;
const CLOUDFRONT_ALARM_ARN_PATTERN =
  `arn:aws:cloudwatch:us-east-1:${ACCOUNT_ID}:`
  + "alarm:PlatformWeb-AgenticPlatform-Web-*-CloudFront-5xx";
const PLATFORM_STATE_TABLE_NAME =
  "AgenticPlatform-Web-PlatformStateTable-EXAMPLE";
const PLATFORM_STATE_TABLE_ARN =
  `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:`
  + `table/${PLATFORM_STATE_TABLE_NAME}`;
const AGENT_RUNTIME_ARN =
  `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
  + "runtime/AgenticPlatformRuntime-*";
const AGENT_RUNTIME_ENDPOINT_ARN_PATTERN =
  `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
  + "runtime/AgenticPlatformRuntime-*/runtime-endpoint/*";
const AGENT_RUNTIME_ID = "AgenticPlatformRuntime-ABC1234567";
const AGENT_RUNTIME_EXACT_ARN =
  `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
  + `runtime/${AGENT_RUNTIME_ID}`;
const AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN =
  `${AGENT_RUNTIME_EXACT_ARN}/runtime-endpoint/Production`;
const PLATFORM_STATE_SEED_LOG_GROUP_NAME =
  "AgenticPlatform-Web-PlatformStateSeedLogs-EXAMPLE";
const PLATFORM_STATE_SEED_LOG_GROUP_CHILD_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${PLATFORM_STATE_SEED_LOG_GROUP_NAME}:*`;
const RUNTIME_PROOF_CONFIGURATOR_LOG_GROUP_NAME =
  "AgenticPlatform-Web-RuntimeProofConfiguratorLogs-EXAMPLE";
const RUNTIME_PROOF_CONFIGURATOR_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${RUNTIME_PROOF_CONFIGURATOR_LOG_GROUP_NAME}`;
const RUNTIME_PROOF_PROVIDER_LOG_GROUP_NAME =
  "AgenticPlatform-Web-RuntimeProofProviderLogs-EXAMPLE";
const RUNTIME_PROOF_PROVIDER_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${RUNTIME_PROOF_PROVIDER_LOG_GROUP_NAME}`;
const PLATFORM_ADMIN_LOG_GROUP_NAME =
  "AgenticPlatform-Web-PlatformAdminApiLogs-EXAMPLE";
const PLATFORM_ADMIN_LOG_GROUP_CHILD_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${PLATFORM_ADMIN_LOG_GROUP_NAME}:*`;
const IDENTITY_LOG_GROUP_NAME =
  "AgenticPlatform-Web-IdentityApiLogs-EXAMPLE";
const IDENTITY_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${IDENTITY_LOG_GROUP_NAME}`;
const IDENTITY_LOG_GROUP_CHILD_ARN = `${IDENTITY_LOG_GROUP_ARN}:*`;
const GOVERNANCE_LOG_GROUP_NAME =
  "AgenticPlatform-Web-GovernanceApiLogs-EXAMPLE";
const GOVERNANCE_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${GOVERNANCE_LOG_GROUP_NAME}`;
const GOVERNANCE_LOG_GROUP_CHILD_ARN = `${GOVERNANCE_LOG_GROUP_ARN}:*`;
const MODEL_GOVERNANCE_LOG_GROUP_NAME =
  "AgenticPlatform-Web-ModelGovernanceApiLogs-EXAMPLE";
const MODEL_GOVERNANCE_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${MODEL_GOVERNANCE_LOG_GROUP_NAME}`;
const MODEL_GOVERNANCE_LOG_GROUP_CHILD_ARN =
  `${MODEL_GOVERNANCE_LOG_GROUP_ARN}:*`;
const BUILDER_LOG_GROUP_NAME =
  "AgenticPlatform-Web-BuilderApiLogs-EXAMPLE";
const BUILDER_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${BUILDER_LOG_GROUP_NAME}`;
const BUILDER_LOG_GROUP_CHILD_ARN = `${BUILDER_LOG_GROUP_ARN}:*`;
const JOURNEY_LOG_GROUP_NAME =
  "AgenticPlatform-Web-JourneyApiLogs-EXAMPLE";
const JOURNEY_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${JOURNEY_LOG_GROUP_NAME}`;
const EXPERIENCE_LOG_GROUP_NAME =
  "AgenticPlatform-Web-ExperienceApiLogs-EXAMPLE";
const EXPERIENCE_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${EXPERIENCE_LOG_GROUP_NAME}`;
const EXPERIENCE_LOG_GROUP_CHILD_ARN = `${EXPERIENCE_LOG_GROUP_ARN}:*`;
const WORKSPACE_LOG_GROUP_NAME =
  "AgenticPlatform-Web-WorkspaceApiLogs-EXAMPLE";
const WORKSPACE_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${WORKSPACE_LOG_GROUP_NAME}`;
const WORKSPACE_LOG_GROUP_CHILD_ARN = `${WORKSPACE_LOG_GROUP_ARN}:*`;
const ACCESS_ADMIN_LOG_GROUP_NAME =
  "AgenticPlatform-Web-AccessAdminApiLogs-EXAMPLE";
const ACCESS_ADMIN_LOG_GROUP_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${ACCESS_ADMIN_LOG_GROUP_NAME}`;
const ACCESS_ADMIN_LOG_GROUP_CHILD_ARN =
  `${ACCESS_ADMIN_LOG_GROUP_ARN}:*`;
const CONTROL_PLANE_READ_ROLE_NAME =
  "AgenticPlatform-Web-ControlPlaneReadApiRole";
const CONTROL_PLANE_READ_POLICY_NAME = "ControlPlaneReadApi";
const CONTROL_PLANE_READ_XRAY_POLICY_NAME =
  "ControlPlaneReadApiRoleDefaultPolicyB50CA712";
const CONTROL_PLANE_READ_LOG_GROUP_NAME =
  "AgenticPlatform-Web-ControlPlaneReadApiLogs-EXAMPLE";
const CONTROL_PLANE_READ_LOG_GROUP_CHILD_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${CONTROL_PLANE_READ_LOG_GROUP_NAME}:*`;
const REGISTRY_DECISION_FINALIZER_LOG_GROUP_NAME =
  "AgenticPlatform-Web-RegistryDecisionFinalizerLogs-EXAMPLE";
const REGISTRY_DECISION_FINALIZER_LOG_GROUP_CHILD_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${REGISTRY_DECISION_FINALIZER_LOG_GROUP_NAME}:*`;
const REGISTRY_DECISION_FINALIZER_FUNCTION_ARN =
  `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
  + "function:AgenticPlatform-Web-RegistryDecisionFinalizer";
const HOSTED_ACCEPTANCE_BROKER_LOG_GROUP_NAME =
  "AgenticPlatform-Web-HostedAcceptanceBrokerLogs-EXAMPLE";
const HOSTED_ACCEPTANCE_BROKER_LOG_GROUP_CHILD_ARN =
  `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
  + `log-group:${HOSTED_ACCEPTANCE_BROKER_LOG_GROUP_NAME}:*`;
const HOSTED_ACCEPTANCE_BROKER_ROLE_NAME =
  "AgenticPlatform-Web-HostedAcceptanceBrokerRole";
const HOSTED_ACCEPTANCE_BROKER_POLICY_NAME =
  "HostedAcceptanceBroker";
const HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME =
  "AgenticPlatform-Web-HostedAcceptanceBroker";
const HOSTED_ACCEPTANCE_BROKER_FUNCTION_ARN =
  `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
  + `function:${HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME}`;
const HOSTED_ACCEPTANCE_ROLE_NAME =
  "AgenticPlatform-Web-HostedAcceptanceRole";
const HOSTED_ACCEPTANCE_POLICY_NAME = "HostedAcceptance";
const GITHUB_DEPLOY_ROLE_NAME = "AgenticPlatformGitHubDeployRole";
const GITHUB_DEPLOY_ROLE_ARN =
  `arn:aws:iam::${ACCOUNT_ID}:role/${GITHUB_DEPLOY_ROLE_NAME}`;
const USER_POOL_ID = `${REGION}_HostedAcceptance`;
const USER_POOL_ARN =
  `arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${USER_POOL_ID}`;
const PLATFORM_ADMIN_DOMAIN_GROUP_ACTIONS = [
  "cognito-idp:CreateGroup",
  "cognito-idp:DeleteGroup",
  "cognito-idp:GetGroup",
  "cognito-idp:ListUsersInGroup",
];
const HOSTED_ACCEPTANCE_BROKER_DOMAIN_GROUP_ACTIONS = [
  "cognito-idp:DeleteGroup",
  "cognito-idp:GetGroup",
  "cognito-idp:ListUsersInGroup",
];
const ACCOUNT_REGISTRY_ARN =
  `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*`;
const ACCOUNT_REGISTRY_RECORD_ARN = `${ACCOUNT_REGISTRY_ARN}/record/*`;
const REPOSITORY_ID = "987654321";
const REPOSITORY_OWNER_ID = "12345678";
const WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/`
  + "deploy-serverless-platform.yml@refs/heads/main";
const LEGACY_SUBJECT = `repo:${REPOSITORY}:ref:refs/heads/main`;
const IMMUTABLE_SUBJECT =
  `repo:example-org@${REPOSITORY_OWNER_ID}/`
  + `example-repo@${REPOSITORY_ID}:ref:refs/heads/main`;
const RUNTIME_BOUNDARY_SOURCE = JSON.parse(
  readFileSync(
    new URL(
      "../config/runtime-permissions-boundary.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const RUNTIME_ROLE_NAMES = [
  "AgenticPlatform-Web-AgentRuntimeRole",
  "AgenticPlatform-Web-BuilderApiRole",
  "AgenticPlatform-Web-IdentityApiRole",
  "AgenticPlatform-Web-JourneyApiRole",
  "AgenticPlatform-Web-DeploymentApiRole",
  "AgenticPlatform-Web-ExperienceApiRole",
  "AgenticPlatform-Web-FrontendDeploymentRole",
  "AgenticPlatform-Web-GovernanceApiRole",
  "AgenticPlatform-Web-AccessAdminApiRole",
  GATEWAY_INVOKER_ROLE_NAME,
  MODEL_GOVERNANCE_ROLE_NAME,
  "AgenticPlatform-Web-CloudFrontInvalidationProviderRole",
  "AgenticPlatform-Web-CloudFrontAlarmProviderRole",
  "AgenticPlatform-Web-ControlPlaneReadApiRole",
  "AgenticPlatform-Web-OperationsApiRole",
  "AgenticPlatform-Web-PlatformAdminApiRole",
  "AgenticPlatform-Web-PlatformAgentRegistrySeedRole",
  "AgenticPlatform-Web-RegistryDecisionFinalizerRole",
  "AgenticPlatform-Web-PlatformStateSeedRole",
  "AgenticPlatform-Web-PlatformWorkspaceSeedRole",
  HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
  "AgenticPlatform-Web-RuntimeBoundaryTagProviderRole",
  RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
  RUNTIME_PROOF_PROVIDER_ROLE_NAME,
  "AgenticPlatform-Web-WorkspaceApiRole",
];
const REQUIRED_BOUNDARY_TAGS = [
  { Key: "auto-delete", Value: "no" },
  { Key: "managedBy", Value: "cdk" },
  { Key: "project", Value: "agentic-ai-platform-demo" },
];
const CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "WriteControlPlaneLogs",
      Effect: "Allow",
      Action: [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      Resource: [
        `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
          + `log-group:${CONTROL_PLANE_ROLE_PREFIX}*:*`,
      ],
    },
    {
      Sid: "CreateTaggedControlPlaneRegistries",
      Effect: "Allow",
      Action: ["agent-registry:CreateRegistry"],
      Resource: ["*"],
      Condition: {
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["auto-delete", "managedBy", "project"],
        },
        StringEquals: {
          "aws:RequestTag/auto-delete": "no",
          "aws:RequestTag/managedBy": "cdk",
          "aws:RequestTag/project": "agentic-ai-platform-demo",
          "aws:RequestedRegion": REGION,
        },
      },
    },
    {
      Sid: "TagControlPlaneRegistries",
      Effect: "Allow",
      Action: ["agent-registry:TagResource"],
      Resource: [
        `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*`,
      ],
      Condition: {
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["auto-delete", "managedBy", "project"],
        },
        StringEquals: {
          "aws:RequestTag/auto-delete": "no",
          "aws:RequestTag/managedBy": "cdk",
          "aws:RequestTag/project": "agentic-ai-platform-demo",
          "aws:RequestedRegion": REGION,
          "aws:ResourceTag/auto-delete": "no",
          "aws:ResourceTag/managedBy": "cdk",
          "aws:ResourceTag/project": "agentic-ai-platform-demo",
        },
      },
    },
    {
      Sid: "CreateTaggedControlPlaneRegistryRecords",
      Effect: "Allow",
      Action: ["agent-registry:CreateRegistryRecord"],
      Resource: [
        `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*`,
        `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*/record/*`,
      ],
      Condition: {
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["auto-delete", "managedBy", "project"],
        },
        StringEquals: {
          "aws:RequestTag/auto-delete": "no",
          "aws:RequestTag/managedBy": "cdk",
          "aws:RequestTag/project": "agentic-ai-platform-demo",
          "aws:RequestedRegion": REGION,
          "aws:ResourceTag/auto-delete": "no",
          "aws:ResourceTag/managedBy": "cdk",
          "aws:ResourceTag/project": "agentic-ai-platform-demo",
        },
      },
    },
    {
      Sid: "ReadControlPlaneRegistries",
      Effect: "Allow",
      Action: ["agent-registry:GetRegistry", "agent-registry:ListRegistryRecords"],
      Resource: [
        `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*`,
      ],
    },
    {
      Sid: "ReadControlPlaneRegistryRecords",
      Effect: "Allow",
      Action: [
        "agent-registry:GetRegistryRecord",
      ],
      Resource: [
        `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*/record/*`,
      ],
    },
    {
      Sid: "MutateTaggedControlPlaneRegistries",
      Effect: "Allow",
      Action: [
        "agent-registry:DeleteRegistry",
        "agent-registry:UpdateRegistry",
      ],
      Resource: [
        `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*`,
      ],
      Condition: {
        StringEquals: {
          "aws:ResourceTag/auto-delete": "no",
          "aws:ResourceTag/managedBy": "cdk",
          "aws:ResourceTag/project": "agentic-ai-platform-demo",
        },
      },
    },
    {
      Sid: "MutateTaggedControlPlaneRegistryRecords",
      Effect: "Allow",
      Action: [
        "agent-registry:DeleteRegistryRecord",
        "agent-registry:SubmitRegistryRecordForApproval",
        "agent-registry:UpdateRegistryRecordStatus",
      ],
      Resource: [
        `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:`
          + "registry/*/record/*",
      ],
      Condition: {
        StringEquals: {
          "aws:ResourceTag/auto-delete": "no",
          "aws:ResourceTag/managedBy": "cdk",
          "aws:ResourceTag/project": "agentic-ai-platform-demo",
        },
      },
    },
    {
      Sid: "ListControlPlaneRegistries",
      Effect: "Allow",
      Action: ["agent-registry:ListRegistries"],
      Resource: ["*"],
    },
    {
      Sid: "ManageControlPlaneWorkloadIdentities",
      Effect: "Allow",
      Action: [
        "bedrock-agentcore:CreateWorkloadIdentity",
        "bedrock-agentcore:DeleteWorkloadIdentity",
        "bedrock-agentcore:GetWorkloadIdentity",
      ],
      Resource: [
        `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
          + "workload-identity-directory/*",
      ],
    },
    {
      Sid: "CreateAgentRegistryServiceLinkedRole",
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: [
        `arn:aws:iam::${ACCOUNT_ID}:role/aws-service-role/`
          + "agent-registry.amazonaws.com/AWSServiceRoleForAgentRegistry",
      ],
      Condition: {
        StringEquals: {
          "iam:AWSServiceName": "agent-registry.amazonaws.com",
        },
      },
    },
    {
      Sid: "InvokeControlPlaneProviderFunctions",
      Effect: "Allow",
      Action: [
        "lambda:GetFunction",
        "lambda:InvokeFunction",
      ],
      Resource: [
        `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
          + "function:acp-cp-prov-*",
      ],
    },
    {
      Sid: "StartControlPlaneProviderWaiter",
      Effect: "Allow",
      Action: ["states:StartExecution"],
      Resource: [
        `arn:aws:states:${REGION}:${ACCOUNT_ID}:`
          + "stateMachine:acp-cp-prov-*",
      ],
    },
    {
      Sid: "ReconcileControlPlaneBoundaryTags",
      Effect: "Allow",
      Action: [
        "iam:ListPolicyTags",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource: [CONTROL_PLANE_RUNTIME_BOUNDARY_ARN],
    },
    {
      Sid: "UseBedrockMantleProject",
      Effect: "Allow",
      Action: [
        "bedrock-mantle:CreateInference",
        "bedrock-mantle:GetModel",
        "bedrock-mantle:GetProject",
        "bedrock-mantle:ListModels",
      ],
      Resource: [
        `arn:aws:bedrock-mantle:${REGION}:${ACCOUNT_ID}:project/default`,
      ],
    },
    {
      Sid: "ListBedrockMantleProjects",
      Effect: "Allow",
      Action: [
        "bedrock-mantle:ListProjects",
        "bedrock-mantle:ListTagsForResource",
      ],
      Resource: ["*"],
    },
  ],
};
const LEGACY_CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY = structuredClone(CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY);
for (const statement of LEGACY_CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY.Statement) {
  if (statement.Sid === "ReadControlPlaneRegistries") {
    statement.Action = ["agent-registry:ListRegistryRecords"];
    statement.Resource = Object.values(CONTROL_PLANE_ARNS).filter((arn) => arn.includes(":registry/"));
  }
  if (statement.Sid === "ReadControlPlaneRegistryRecords") {
    statement.Action = ["agent-registry:GetDiscoverableRegistryRecord", "agent-registry:GetRegistryRecord", "agent-registry:UpdateRegistryRecordStatus"];
    statement.Resource = Object.values(CONTROL_PLANE_ARNS).filter((arn) => arn.includes(":registry/")).map((arn) => `${arn}/record/*`);
  }
}
const EXPECTED_CONTROL_PLANE_EXECUTION_POLICIES =
  synthesizeControlPlaneExecutionPolicies();
const CONTROL_PLANE_DEPLOYMENT_POLICY =
  EXPECTED_CONTROL_PLANE_EXECUTION_POLICIES.managedPolicies.get(
    CONTROL_PLANE_DEPLOYMENT_POLICY_NAME,
  );
assert.ok(CONTROL_PLANE_DEPLOYMENT_POLICY);

function resolveSynthesizedPolicyValue(value) {
  if (Array.isArray(value)) {
    return value.map(resolveSynthesizedPolicyValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Object.hasOwn(value, "Ref")) {
    const replacements = {
      "AWS::AccountId": ACCOUNT_ID,
      "AWS::Partition": "aws",
      "AWS::Region": REGION,
    };
    const replacement = replacements[value.Ref];
    if (replacement === undefined) {
      throw new Error(`Unsupported synthesized policy Ref ${value.Ref}.`);
    }
    return replacement;
  }
  if (Object.hasOwn(value, "Fn::Join")) {
    const [separator, values] = value["Fn::Join"];
    return values
      .map(resolveSynthesizedPolicyValue)
      .join(separator);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveSynthesizedPolicyValue(child),
    ]),
  );
}

function synthesizeControlPlaneExecutionPolicies() {
  const app = new cdk.App();
  const stack = new GitHubBootstrapStack(app, "AuditPolicyFixture", {
    env: { account: ACCOUNT_ID, region: REGION },
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    workflowRef: WORKFLOW_REF,
    githubOidcSubjectMode: "legacy",
    githubOidcSubject: LEGACY_SUBJECT,
    branchProtectionAttested: true,
  });
  const template = Template.fromStack(stack).toJSON();
  const resources = Object.entries(template.Resources);
  const executionRoleEntry = resources.find(
    ([, resource]) =>
      resource.Type === "AWS::IAM::Role"
      && resource.Properties?.RoleName
        === CLOUDFORMATION_EXECUTION_ROLE_NAME,
  );
  assert.ok(executionRoleEntry);
  const [executionRoleLogicalId] = executionRoleEntry;
  const managedPolicies = new Map(
    CONTROL_PLANE_EXECUTION_POLICY_NAMES.map((policyName) => {
      const matches = resources.filter(
        ([, resource]) =>
          resource.Type === "AWS::IAM::ManagedPolicy"
          && resource.Properties?.ManagedPolicyName === policyName,
      );
      assert.equal(matches.length, 1, policyName);
      return [
        policyName,
        resolveSynthesizedPolicyValue(
          matches[0][1].Properties.PolicyDocument,
        ),
      ];
    }),
  );
  const inlinePolicies = resources.filter(
    ([, resource]) =>
      resource.Type === "AWS::IAM::Policy"
      && resource.Properties?.Roles?.some(
        (role) => role.Ref === executionRoleLogicalId,
      ),
  );
  assert.equal(inlinePolicies.length, 1);
  assert.equal(
    inlinePolicies[0][1].Properties.PolicyName,
    CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME,
  );
  return {
    inlinePolicy: resolveSynthesizedPolicyValue(
      inlinePolicies[0][1].Properties.PolicyDocument,
    ),
    managedPolicies,
  };
}

test("runtime boundary compaction normalizes redundant deployed Registry reads without Sids", () => {
  const root = `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/`;
  const foreign = `arn:aws:agent-registry:us-east-1:${ACCOUNT_ID}:registry/shared/record/*`;
  const compacted = compactRuntimeBoundary({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["agent-registry:GetRegistry", "agent-registry:ListTagsForResource"],
      Resource: [root + "*", root + "shared/record/*", foreign],
    }],
  });
  assert.deepEqual(compacted.Statement[0].Resource, [root + "*", foreign]);
  const extraAction = compactRuntimeBoundary({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["agent-registry:GetRegistry", "agent-registry:ListTagsForResource", "agent-registry:DeleteRegistry"],
      Resource: [root + "*", root + "shared/record/*"],
    }],
  });
  assert.equal(extraAction.Statement[0].Action.includes("agent-registry:DeleteRegistry"), true);
  assert.equal(extraAction.Statement[0].Resource.length, 2);
});

test("runtime boundary compaction does not merge obsolete Registry SIDs", () => {
  const compacted = compactRuntimeBoundary({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ListControlPlaneRegistries",
        Effect: "Allow",
        Action: ["agent-registry:ListRegistryRecords"],
        Resource: ["arn:aws:agent-registry:us-west-2:111122223333:registry/A"],
      },
      {
        Sid: "GetControlPlaneRegistryRecords",
        Effect: "Allow",
        Action: ["agent-registry:GetRegistryRecord"],
        Resource: [
          "arn:aws:agent-registry:us-west-2:111122223333:registry/A",
        ],
      },
      {
        Sid: "DecideControlPlaneRegistryRecords",
        Effect: "Allow",
        Action: ["agent-registry:UpdateRegistryRecordStatus"],
        Resource: [
          "arn:aws:agent-registry:us-west-2:111122223333:registry/A",
        ],
      },
    ],
  });

  assert.deepEqual(compacted.Statement, [
    {
      Effect: "Allow",
      Action: "agent-registry:ListRegistryRecords",
      Resource:
        "arn:aws:agent-registry:us-west-2:111122223333:registry/A",
    },
    {
      Effect: "Allow",
      Action: "agent-registry:GetRegistryRecord",
      Resource:
        "arn:aws:agent-registry:us-west-2:111122223333:registry/A",
    },
    {
      Effect: "Allow",
      Action: "agent-registry:UpdateRegistryRecordStatus",
      Resource:
        "arn:aws:agent-registry:us-west-2:111122223333:registry/A",
    },
  ]);
});

test("runtime boundary compaction removes unused direct inception access", () => {
  const compacted = compactRuntimeBoundary({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "InvokeJourneyInceptionModel",
        Effect: "Allow",
        Action: ["bedrock:InvokeModel"],
        Resource: ["${JOURNEY_INCEPTION_MODEL_ARNS}"],
      },
      {
        Sid: "InvokeJourneyAgentRuntime",
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeAgentRuntime"],
        Resource: ["runtime"],
      },
    ],
  });

  assert.deepEqual(compacted.Statement, [{
    Effect: "Allow",
    Action: "bedrock-agentcore:InvokeAgentRuntime",
    Resource: "runtime",
  }]);
});

test("runtime boundary compaction combines dynamic Registry access", () => {
  const compacted = compactRuntimeBoundary({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ListDynamicControlPlaneRegistries",
        Effect: "Allow",
        Action: ["agent-registry:ListRegistryRecords"],
        Resource: [ACCOUNT_REGISTRY_ARN],
        Condition: registryResourceTagCondition([
          "cdk",
          "hosted-acceptance",
        ]),
      },
      {
        Sid: "ReadDynamicControlPlaneRegistryRecords",
        Effect: "Allow",
        Action: [
          "agent-registry:GetDiscoverableRegistryRecord",
          "agent-registry:GetRegistryRecord",
          "agent-registry:UpdateRegistryRecordStatus",
        ],
        Resource: [ACCOUNT_REGISTRY_RECORD_ARN],
        Condition: registryResourceTagCondition([
          "cdk",
          "hosted-acceptance",
        ]),
      },
      {
        Sid: "MutateHostedAcceptanceFixtureRecord",
        Effect: "Allow",
        Action: [
          "agent-registry:DeleteRegistryRecord",
          "agent-registry:SubmitRegistryRecordForApproval",
        ],
        Resource: [
          "arn:aws:agent-registry:us-west-2:111122223333:"
            + "registry/SharedReg1234/record/*",
        ],
        Condition: registryResourceTagCondition("hosted-acceptance"),
      },
      {
        Sid: "DeleteHostedAcceptanceDomainRegistry",
        Effect: "Allow",
        Action: ["agent-registry:DeleteRegistry"],
        Resource: [ACCOUNT_REGISTRY_ARN],
        Condition: registryResourceTagCondition([
          "cdk",
          "hosted-acceptance",
        ]),
      },
    ],
  });

  assert.deepEqual(compacted.Statement, [
    {
      Effect: "Allow",
      Action: [
        "agent-registry:ListRegistryRecords",
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
        "agent-registry:UpdateRegistryRecordStatus",
        "agent-registry:DeleteRegistry",
      ],
      Resource: [ACCOUNT_REGISTRY_ARN, ACCOUNT_REGISTRY_RECORD_ARN],
      Condition: registryResourceTagCondition([
        "cdk",
        "hosted-acceptance",
      ]),
    },
    {
      Effect: "Allow",
      Action: [
        "agent-registry:DeleteRegistryRecord",
        "agent-registry:SubmitRegistryRecordForApproval",
      ],
      Resource:
        "arn:aws:agent-registry:us-west-2:111122223333:"
        + "registry/SharedReg1234/record/*",
      Condition: registryResourceTagCondition("hosted-acceptance"),
    },
  ]);
});

test("runtime boundary compaction keeps constrained Gateway invocation separate", () => {
  const compacted = compactRuntimeBoundary({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "WritePlatformLogs",
        Effect: "Allow",
        Action: ["logs:PutLogEvents"],
        Resource: ["logs"],
      },
      {
        Sid: "ListControlPlaneRegistries",
        Effect: "Allow",
        Action: ["agent-registry:ListRegistryRecords"],
        Resource: ["registries"],
      },
      {
        Sid: "ReadControlPlaneRegistryRecords",
        Effect: "Allow",
        Action: [
          "agent-registry:GetDiscoverableRegistryRecord",
          "agent-registry:GetRegistryRecord",
        ],
        Resource: ["records"],
      },
      {
        Sid: "InvokeControlPlaneLlmGateway",
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeGateway"],
        Resource: ["llm-gateway"],
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn": "gateway-invoker",
          },
        },
      },
      {
        Sid: "GetControlPlaneRegistryRecords",
        Effect: "Allow",
        Action: ["obsolete:Get"],
        Resource: ["obsolete-get"],
      },
      {
        Sid: "DecideControlPlaneRegistryRecords",
        Effect: "Allow",
        Action: ["obsolete:Decide"],
        Resource: ["obsolete-decide"],
      },
    ],
  });

  assert.deepEqual(compacted.Statement, [
    {
      Effect: "Allow",
      Action: "logs:PutLogEvents",
      Resource: "logs",
    },
    {
      Effect: "Allow",
      Action: "agent-registry:ListRegistryRecords",
      Resource: "registries",
    },
    {
      Effect: "Allow",
      Action: [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
      ],
      Resource: "records",
    },
    {
      Effect: "Allow",
      Action: "bedrock-agentcore:InvokeGateway",
      Resource: "llm-gateway",
      Condition: {
        ArnEquals: {
          "aws:PrincipalArn": "gateway-invoker",
        },
      },
    },
    {
      Effect: "Allow",
      Action: "obsolete:Get",
      Resource: "obsolete-get",
    },
    {
      Effect: "Allow",
      Action: "obsolete:Decide",
      Resource: "obsolete-decide",
    },
  ]);
});

function renderBoundaryTemplate(value) {
  if (typeof value === "string") {
    return value
      .replaceAll("${ACCOUNT}", ACCOUNT_ID)
      .replaceAll("${AGENT_RUNTIME_ARN}", AGENT_RUNTIME_ARN)
      .replaceAll(
        "${AGENT_RUNTIME_ENDPOINT_ARN_PATTERN}",
        AGENT_RUNTIME_ENDPOINT_ARN_PATTERN,
      )
      .replaceAll(
        "${CLOUDFRONT_ALARM_ARN_PATTERN}",
        CLOUDFRONT_ALARM_ARN_PATTERN,
      )
      .replaceAll(
        "${CLOUDFRONT_DISTRIBUTION_ARN}",
        CLOUDFRONT_DISTRIBUTION_ARN,
      )
      .replaceAll("${GATEWAY_INVOKER_ROLE_ARN}", GATEWAY_INVOKER_ROLE_ARN)
      .replaceAll(
        "${JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN}",
        JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN,
      )
      .replaceAll(
        "${JOURNEY_INCEPTION_MODEL_ARN}",
        JOURNEY_INCEPTION_MODEL_ARNS[0],
      )
      .replaceAll("${PARTITION}", "aws")
      .replaceAll("${PLATFORM_STATE_TABLE_ARN}", PLATFORM_STATE_TABLE_ARN)
      .replaceAll(
        "${REGISTRY_DECISION_FINALIZER_FUNCTION_ARN}",
        REGISTRY_DECISION_FINALIZER_FUNCTION_ARN,
      )
      .replaceAll("${QUALIFIER}", "hnb659fds")
      .replaceAll("${REGION}", REGION)
      .replaceAll(
        "${RUNTIME_INVOCATION_PROOF_SECRET_ARN}",
        RUNTIME_INVOCATION_PROOF_SECRET_ARN,
      )
      .replaceAll(
        "${SHARED_REGISTRY_ARN}",
        CONTROL_PLANE_ARNS.sharedRegistryArn,
      )
      .replaceAll(
        "${PLATFORM_REGISTRY_ARN}",
        CONTROL_PLANE_ARNS.platformRegistryArn,
      )
      .replaceAll(
        "${CUSTOMER_SUPPORT_REGISTRY_ARN}",
        CONTROL_PLANE_ARNS.customerSupportRegistryArn,
      )
      .replaceAll(
        "${OPERATIONS_REGISTRY_ARN}",
        CONTROL_PLANE_ARNS.operationsRegistryArn,
      )
      .replaceAll("${LLM_GATEWAY_ARN}", CONTROL_PLANE_ARNS.llmGatewayArn)
      .replaceAll(
        "${TOOLS_GATEWAY_ARN}",
        CONTROL_PLANE_ARNS.toolsGatewayArn,
      )
      .replaceAll(
        "${RUNTIME_PERMISSIONS_BOUNDARY_ARN}",
        RUNTIME_BOUNDARY_ARN,
      )
      .replaceAll(
        "${RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN}",
        RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN,
      )
      .replaceAll(
        "${RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN}",
        RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN,
      )
      .replaceAll("${USER_POOL_ARN}", USER_POOL_ARN);
  }
  if (Array.isArray(value)) {
    return value.map(renderBoundaryTemplate);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        renderBoundaryTemplate(child),
      ]),
    );
  }
  return value;
}

const RENDERED_RUNTIME_BOUNDARY_POLICY =
  renderBoundaryTemplate(RUNTIME_BOUNDARY_SOURCE);
const EXPECTED_RUNTIME_BOUNDARY_POLICY =
  structuredClone(RENDERED_RUNTIME_BOUNDARY_POLICY);
EXPECTED_RUNTIME_BOUNDARY_POLICY.Statement =
  EXPECTED_RUNTIME_BOUNDARY_POLICY.Statement.filter(
    ({ Sid }) =>
      Sid !== "InvokeJourneyInceptionModel"
      && Sid !== "ReadJourneyGitHubOAuthClientSecret",
  );
const JOURNEY_OAUTH_RUNTIME_BOUNDARY_POLICY =
  structuredClone(RENDERED_RUNTIME_BOUNDARY_POLICY);
JOURNEY_OAUTH_RUNTIME_BOUNDARY_POLICY.Statement =
  JOURNEY_OAUTH_RUNTIME_BOUNDARY_POLICY.Statement.filter(
    ({ Sid }) => Sid !== "InvokeJourneyInceptionModel",
  );
const JOURNEY_PREDECESSOR_RUNTIME_BOUNDARY_POLICY =
  structuredClone(RENDERED_RUNTIME_BOUNDARY_POLICY);
JOURNEY_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement =
  JOURNEY_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.filter(
    ({ Sid }) => Sid !== "ReadJourneyGitHubOAuthClientSecret",
  );
const EXPECTED_RUNTIME_BOUNDARY_HASH =
  "01a6b31ce570ec82d8c4e295b03e8f3808189f265ad622f0f86add70e09c5ae5";
const GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY =
  structuredClone(EXPECTED_RUNTIME_BOUNDARY_POLICY);
GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement =
  GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.filter(
    ({ Sid }) =>
      Sid !== "AssumeGatewayInvokerRole"
      && Sid !== "ReadRuntimeInvocationProofSecret"
      && Sid !== "WriteRuntimeInvocationProofSecret",
  );
GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.find(
  ({ Sid }) => Sid === "InvokeControlPlaneLlmGateway",
).Action = ["bedrock-agentcore:InvokeGateway"];
delete GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.find(
  ({ Sid }) => Sid === "InvokeControlPlaneLlmGateway",
).Condition;
GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.find(
  ({ Sid }) => Sid === "InvokeRegistryDecisionFinalizer",
).Resource = [REGISTRY_DECISION_FINALIZER_FUNCTION_ARN];
const LEGACY_TRANSACTION_AUTHORIZATION_RUNTIME_BOUNDARY_POLICY =
  structuredClone(EXPECTED_RUNTIME_BOUNDARY_POLICY);
{
  const writeStatement =
    LEGACY_TRANSACTION_AUTHORIZATION_RUNTIME_BOUNDARY_POLICY.Statement.find(
      ({ Sid }) => Sid === "WritePlatformState",
    );
  writeStatement.Action = [
    "dynamodb:PutItem",
    "dynamodb:TransactWriteItems",
  ];
}

test("audit-compacted runtime boundary matches config rendering", () => {
  const renderedByConfig = runtimePermissionsBoundaryDocument({
    account: ACCOUNT_ID,
    agentRuntimeArn: AGENT_RUNTIME_ARN,
    agentRuntimeEndpointArnPattern:
      AGENT_RUNTIME_ENDPOINT_ARN_PATTERN,
    cloudFrontAlarmArnPattern: CLOUDFRONT_ALARM_ARN_PATTERN,
    cloudFrontDistributionArn: CLOUDFRONT_DISTRIBUTION_ARN,
    customerSupportRegistryArn: CONTROL_PLANE_ARNS.customerSupportRegistryArn,
    gatewayInvokerRoleArn:
      `arn:aws:iam::${ACCOUNT_ID}:role/`
      + "AgenticPlatform-Web-GatewayInvokerRole",
    journeyInceptionModelArns: [],
    llmGatewayArn: CONTROL_PLANE_ARNS.llmGatewayArn,
    operationsRegistryArn: CONTROL_PLANE_ARNS.operationsRegistryArn,
    partition: "aws",
    platformStateTableArn: PLATFORM_STATE_TABLE_ARN,
    platformRegistryArn: CONTROL_PLANE_ARNS.platformRegistryArn,
    qualifier: "hnb659fds",
    registryDecisionFinalizerFunctionArn:
      REGISTRY_DECISION_FINALIZER_FUNCTION_ARN,
    region: REGION,
    runtimeProofConfiguratorFunctionArn:
      RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN,
    runtimeProofConfiguratorRoleArn:
      RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN,
    runtimeInvocationProofSecretArn:
      RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    runtimePermissionsBoundaryArn: RUNTIME_BOUNDARY_ARN,
    sharedRegistryArn: CONTROL_PLANE_ARNS.sharedRegistryArn,
    toolsGatewayArn: CONTROL_PLANE_ARNS.toolsGatewayArn,
    userPoolArn: USER_POOL_ARN,
  });

  const compacted = compactRuntimeBoundary(
    EXPECTED_RUNTIME_BOUNDARY_POLICY,
    { journeyInceptionModelArns: [] },
  );
  assert.deepEqual(compacted, renderedByConfig);
  const compactedActions = compacted.Statement.flatMap(({ Action }) =>
    Array.isArray(Action) ? Action : [Action]
  );
  for (const action of [
    "cognito-idp:AdminAddUserToGroup",
    "cognito-idp:AdminRemoveUserFromGroup",
    "cognito-idp:ListUsers",
    "cognito-idp:ListUsersInGroup",
    "logs:DescribeLogGroups",
    "logs:DescribeLogStreams",
    "xray:GetSamplingRules",
    "xray:GetSamplingTargets",
  ]) {
    assert.ok(compactedActions.includes(action));
  }
  assert.equal(compactedActions.includes("cognito-idp:Admin*User*Group"), false);
  assert.equal(compactedActions.includes("cognito-idp:ListUsers*"), false);
  assert.equal(compactedActions.includes("logs:DescribeLog*"), false);
  assert.equal(compactedActions.includes("xray:GetSampling*"), false);
});

test("live boundary audit rejects X-Ray and Logs action wildcards", async (t) => {
  const cases = [
    {
      name: "X-Ray sampling wildcard",
      mutate(policy) {
        const statement = policy.Statement.find(
          ({ Sid }) => Sid === "WriteXRayTelemetry",
        );
        assert.ok(statement);
        statement.Action = statement.Action.filter(
          (action) =>
            action !== "xray:GetSamplingRules"
            && action !== "xray:GetSamplingTargets",
        );
        statement.Action.push("xray:GetSampling*");
      },
    },
    {
      name: "Logs describe wildcard",
      mutate(policy) {
        const streams = policy.Statement.find(
          ({ Sid }) => Sid === "WriteAgentRuntimeLogs",
        );
        const groups = policy.Statement.find(
          ({ Sid }) => Sid === "DescribeAgentRuntimeLogs",
        );
        assert.ok(streams);
        assert.ok(groups);
        streams.Action = streams.Action.filter(
          (action) => action !== "logs:DescribeLogStreams",
        );
        streams.Action.push("logs:DescribeLog*");
        groups.Action = [];
      },
    },
  ];

  for (const drift of cases) {
    await t.test(drift.name, () => {
      const responses = githubEnabledResponses();
      const responseKey = key(...COMMANDS.boundaryVersion);
      const document = JSON.parse(responses.get(responseKey));
      drift.mutate(document.PolicyVersion.Document);
      responses.set(responseKey, JSON.stringify(document));

      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /runtime permissions boundary|drift/i,
      );
    });
  }
});
const INVOCATION_JOURNAL_PREDECESSOR_RUNTIME_BOUNDARY_POLICY =
  structuredClone(EXPECTED_RUNTIME_BOUNDARY_POLICY);
INVOCATION_JOURNAL_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement =
  INVOCATION_JOURNAL_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.filter(
    ({ Sid }) => Sid !== "UpdateExperienceInvocation",
  );
for (const sid of ["ReadPlatformState", "WritePlatformState"]) {
  const statement =
    INVOCATION_JOURNAL_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.find(
      (candidate) => candidate.Sid === sid,
    );
  statement.Condition["ForAllValues:StringLike"][
    "dynamodb:LeadingKeys"
  ] = statement.Condition["ForAllValues:StringLike"][
    "dynamodb:LeadingKeys"
  ].filter((key) => key !== "EXPERIENCE_INVOCATION#*");
}
const DELETE_CONDITION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY =
  structuredClone(EXPECTED_RUNTIME_BOUNDARY_POLICY);
{
  const statements =
    DELETE_CONDITION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement;
  const mutate = statements.find(
    ({ Sid }) => Sid === "MutateHostedAcceptanceFixtureRecord",
  );
  const deleteRegistry = statements.find(
    ({ Sid }) => Sid === "DeleteHostedAcceptanceDomainRegistry",
  );
  mutate.Action = [...mutate.Action, ...deleteRegistry.Action];
  mutate.Resource = [...mutate.Resource, ...deleteRegistry.Resource];
  DELETE_CONDITION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement =
    statements.filter(
      ({ Sid }) => Sid !== "DeleteHostedAcceptanceDomainRegistry",
    );
}
const DISCOVERABLE_RESOURCE_PREDECESSOR_RUNTIME_BOUNDARY_POLICY =
  structuredClone(EXPECTED_RUNTIME_BOUNDARY_POLICY);
for (const [listSid, readSid] of [
  ["ListControlPlaneRegistries", "ReadControlPlaneRegistryRecords"],
  [
    "ListDynamicControlPlaneRegistries",
    "ReadDynamicControlPlaneRegistryRecords",
  ],
]) {
  const listStatement =
    DISCOVERABLE_RESOURCE_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.find(
      (candidate) => candidate.Sid === listSid,
    );
  const readStatement =
    DISCOVERABLE_RESOURCE_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.find(
      (candidate) => candidate.Sid === readSid,
    );
  listStatement.Action.push(
    "agent-registry:GetDiscoverableRegistryRecord",
  );
  readStatement.Action = readStatement.Action.filter(
    (action) =>
      action !== "agent-registry:GetDiscoverableRegistryRecord",
  );
}
const BATCH_GET_PREDECESSOR_RUNTIME_BOUNDARY_POLICY =
  structuredClone(
    DISCOVERABLE_RESOURCE_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
  );
for (const sid of [
  "ListControlPlaneRegistries",
  "ListDynamicControlPlaneRegistries",
]) {
  const listStatement =
    BATCH_GET_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.find(
      (candidate) => candidate.Sid === sid,
    );
  listStatement.Action = listStatement.Action.map((action) =>
    action === "agent-registry:GetDiscoverableRegistryRecord"
      ? "agent-registry:BatchGetDiscoverableRegistryRecord"
      : action
  );
}
const TASK3_PREDECESSOR_RUNTIME_BOUNDARY_POLICY = {
  ...structuredClone(
    GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
  ),
  Statement: [
    ...GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.filter(
      ({ Sid }) =>
      !new Set([
        "ListDynamicControlPlaneRegistries",
        "ReadDynamicControlPlaneRegistryRecords",
        "TagPlatformDomainRegistry",
        "CreateHostedAcceptanceDomainRegistry",
        "TagHostedAcceptanceDomainRegistry",
        "InvokeRegistryDecisionFinalizer",
        "CreateHostedAcceptanceFixtureRecord",
        "TagHostedAcceptanceFixtureRecord",
        "ReadHostedAcceptanceFixtureRecord",
        "MutateHostedAcceptanceFixtureRecord",
        "ReadHostedAcceptanceDomainRegistry",
        "DeleteHostedAcceptanceDomainRegistry",
        "ReadDeleteHostedAcceptanceState",
        "ReadPlatformState",
        "ReadPlatformAuditMetadata",
        "WritePlatformState",
        "UpdateExperienceInvocation",
      ]).has(Sid),
    ),
    {
      Sid: "ReadWritePlatformState",
      Effect: "Allow",
      Action: [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:TransactWriteItems",
      ],
      Resource: [PLATFORM_STATE_TABLE_ARN],
    },
  ],
};
const TASK1_PREDECESSOR_RUNTIME_BOUNDARY_POLICY = {
  ...structuredClone(TASK3_PREDECESSOR_RUNTIME_BOUNDARY_POLICY),
  Statement: TASK3_PREDECESSOR_RUNTIME_BOUNDARY_POLICY.Statement.filter(
    ({ Sid }) => Sid !== "ReadWritePlatformState",
  ),
};
const TASK1_PREDECESSOR_RUNTIME_BOUNDARY_HASH =
  "59e971c9bf403bd6023002110d162c19d877dfe7feedd7379a77dd9bef6d6b84";
const PLATFORM_ADMIN_ROLE_NAME =
  "AgenticPlatform-Web-PlatformAdminApiRole";
const PLATFORM_ADMIN_POLICY_NAME = "PlatformStateAccess";
const AGENT_RUNTIME_ROLE_NAME =
  "AgenticPlatform-Web-AgentRuntimeRole";
const AGENT_RUNTIME_POLICY_NAME =
  "AgentRuntimeRoleDefaultPolicy28A421B5";
const BUILDER_ROLE_NAME = "AgenticPlatform-Web-BuilderApiRole";
const JOURNEY_ROLE_NAME = "AgenticPlatform-Web-JourneyApiRole";
const JOURNEY_POLICY_NAME = "JourneyApi";
const JOURNEY_DEFAULT_POLICY_NAME =
  "JourneyApiRoleDefaultPolicy21E813B6";
const BUILDER_POLICY_NAME = "BuilderApi";
const BUILDER_XRAY_POLICY_NAME =
  "BuilderApiRoleDefaultPolicy6FDD69BE";
const EXPERIENCE_ROLE_NAME =
  "AgenticPlatform-Web-ExperienceApiRole";
const EXPERIENCE_POLICY_NAME = "ExperienceApi";
const EXPERIENCE_XRAY_POLICY_NAME =
  "ExperienceApiRoleDefaultPolicyBF321106";
const IDENTITY_ROLE_NAME = "AgenticPlatform-Web-IdentityApiRole";
const IDENTITY_POLICY_NAME = "IdentityApiLogging";
const IDENTITY_XRAY_POLICY_NAME =
  "IdentityApiRoleDefaultPolicyCE354674";
const GOVERNANCE_ROLE_NAME =
  "AgenticPlatform-Web-GovernanceApiRole";
const GOVERNANCE_POLICY_NAME = "GovernanceApi";
const GOVERNANCE_XRAY_POLICY_NAME =
  "GovernanceApiRoleDefaultPolicyB72CE6D3";
const WORKSPACE_ROLE_NAME =
  "AgenticPlatform-Web-WorkspaceApiRole";
const WORKSPACE_POLICY_NAME = "WorkspaceApi";
const WORKSPACE_XRAY_POLICY_NAME =
  "WorkspaceApiRoleDefaultPolicy2220EEC9";
const ACCESS_ADMIN_ROLE_NAME =
  "AgenticPlatform-Web-AccessAdminApiRole";
const ACCESS_ADMIN_POLICY_NAME = "AccessAdminApi";
const ACCESS_ADMIN_XRAY_POLICY_NAME =
  "AccessAdminApiRoleDefaultPolicyDD0CBA0A";
const PLATFORM_STATE_SEED_ROLE_NAME =
  "AgenticPlatform-Web-PlatformStateSeedRole";
const PLATFORM_STATE_SEED_POLICY_NAME = "PlatformStateSeed";
const PLATFORM_WORKSPACE_SEED_ROLE_NAME =
  "AgenticPlatform-Web-PlatformWorkspaceSeedRole";
const PLATFORM_WORKSPACE_SEED_POLICY_NAME = "PlatformWorkspaceSeed";
const REGISTRY_DECISION_FINALIZER_ROLE_NAME =
  "AgenticPlatform-Web-RegistryDecisionFinalizerRole";
const REGISTRY_DECISION_FINALIZER_POLICY_NAME =
  "RegistryDecisionFinalization";
const PLATFORM_STATE_SEED_TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: "sts:AssumeRole",
    Effect: "Allow",
    Principal: { Service: "lambda.amazonaws.com" },
  }],
};
const LAMBDA_TRUST_POLICY = structuredClone(
  PLATFORM_STATE_SEED_TRUST_POLICY,
);
const RUNTIME_PROOF_CONFIGURATOR_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: `${RUNTIME_PROOF_CONFIGURATOR_LOG_GROUP_ARN}:*`,
    },
    {
      Action: [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
      ],
      Effect: "Allow",
      Resource: RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    },
  ],
};
const RUNTIME_PROOF_PROVIDER_LOG_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Effect: "Allow",
    Resource: `${RUNTIME_PROOF_PROVIDER_LOG_GROUP_ARN}:*`,
  }],
};
const RUNTIME_PROOF_PROVIDER_DEFAULT_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: "lambda:InvokeFunction",
      Effect: "Allow",
      Resource: [
        RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN,
        `${RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN}:*`,
      ],
    },
    {
      Action: "lambda:GetFunction",
      Effect: "Allow",
      Resource: RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN,
    },
  ],
};
const AGENT_RUNTIME_TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: "sts:AssumeRole",
    Condition: {
      StringEquals: {
        "aws:SourceAccount": ACCOUNT_ID,
      },
      ArnLike: {
        "aws:SourceArn":
          `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
          + "runtime/AgenticPlatformRuntime*",
      },
    },
    Effect: "Allow",
    Principal: { Service: "bedrock-agentcore.amazonaws.com" },
  }],
};
const GATEWAY_DOMAIN_SOURCE_IDENTITY_CONDITION = {
  StringLike: {
    "sts:SourceIdentity": "domain_*",
  },
};
const GATEWAY_PLATFORM_SOURCE_IDENTITY_CONDITION = {
  StringEquals: {
    "sts:SourceIdentity": "platform",
  },
};
const GATEWAY_APPROVED_CALLER_ROLE_NAMES = [
  BUILDER_ROLE_NAME,
  CONTROL_PLANE_READ_ROLE_NAME,
  JOURNEY_ROLE_NAME,
  AGENT_RUNTIME_ROLE_NAME,
  MODEL_GOVERNANCE_ROLE_NAME,
];
const GATEWAY_INVOKER_TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: GATEWAY_APPROVED_CALLER_ROLE_NAMES.map((roleName) => ({
    Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
    Condition: {
      ArnEquals: {
        "aws:PrincipalArn":
          `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
      },
      ...(
        roleName === BUILDER_ROLE_NAME
        || roleName === JOURNEY_ROLE_NAME
        || roleName === AGENT_RUNTIME_ROLE_NAME
          ? GATEWAY_DOMAIN_SOURCE_IDENTITY_CONDITION
          : GATEWAY_PLATFORM_SOURCE_IDENTITY_CONDITION
      ),
    },
    Effect: "Allow",
    Principal: {
      AWS: `arn:aws:iam::${ACCOUNT_ID}:root`,
    },
  })),
};
const GATEWAY_INVOKER_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: "bedrock-agentcore:InvokeGateway",
    Effect: "Allow",
    Resource: CONTROL_PLANE_ARNS.llmGatewayArn,
  }],
};
const XRAY_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
    Effect: "Allow",
    Resource: "*",
  }],
};
const BUILDER_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: BUILDER_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: "dynamodb:GetItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "AUDIT#*",
            "DOMAIN",
            "GRANT#*",
            "MODEL_POLICY",
            "MUTATION#*",
            "PROJECT#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:Query",
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["DOMAIN"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["MUTATION#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "AUDIT#*",
            "MUTATION#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "agent-registry:ListRegistryRecords",
      Effect: "Allow",
      Resource: [
        CONTROL_PLANE_ARNS.sharedRegistryArn,
        CONTROL_PLANE_ARNS.platformRegistryArn,
        CONTROL_PLANE_ARNS.customerSupportRegistryArn,
        CONTROL_PLANE_ARNS.operationsRegistryArn,
      ],
    },
    {
      Action: [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
      ],
      Effect: "Allow",
      Resource: [
        CONTROL_PLANE_ARNS.sharedRegistryArn,
        CONTROL_PLANE_ARNS.platformRegistryArn,
        CONTROL_PLANE_ARNS.customerSupportRegistryArn,
        CONTROL_PLANE_ARNS.operationsRegistryArn,
      ].map((arn) => `${arn}/record/*`),
    },
    {
      Action: "agent-registry:ListRegistryRecords",
      Condition: registryResourceTagCondition(
        ["cdk", "hosted-acceptance"],
      ),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_ARN,
    },
    {
      Action: [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
      ],
      Condition: registryResourceTagCondition(
        ["cdk", "hosted-acceptance"],
      ),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_RECORD_ARN,
    },
    {
      Action: [
        "bedrock-agentcore:GetGatewayTarget",
        "bedrock-agentcore:ListGatewayTargets",
      ],
      Effect: "Allow",
      Resource: CONTROL_PLANE_ARNS.toolsGatewayArn,
    },
    {
      Action: [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminListGroupsForUser",
      ],
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
  ],
};
const BUILDER_DOMAIN_GET_PREDECESSOR_INLINE_POLICY =
  structuredClone(BUILDER_INLINE_POLICY);
BUILDER_DOMAIN_GET_PREDECESSOR_INLINE_POLICY.Statement.find(
  ({ Action }) => Action === "dynamodb:GetItem",
).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] =
  BUILDER_DOMAIN_GET_PREDECESSOR_INLINE_POLICY.Statement.find(
    ({ Action }) => Action === "dynamodb:GetItem",
  ).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"].filter(
    (key) => key !== "DOMAIN",
  );
const BUILDER_RESOURCE_AUTH_PREDECESSOR_INLINE_POLICY =
  structuredClone(BUILDER_DOMAIN_GET_PREDECESSOR_INLINE_POLICY);
BUILDER_RESOURCE_AUTH_PREDECESSOR_INLINE_POLICY.Statement =
  BUILDER_RESOURCE_AUTH_PREDECESSOR_INLINE_POLICY.Statement.filter(
    ({ Action }) => {
      const actions = [Action].flat();
      return !actions.includes("agent-registry:ListRegistryRecords")
        && !actions.includes("agent-registry:GetRegistryRecord")
        && !actions.includes("bedrock-agentcore:GetGatewayTarget");
    },
  );
const BUILDER_XRAY_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      Effect: "Allow",
      Resource: GATEWAY_INVOKER_ROLE_ARN,
    },
    ...XRAY_INLINE_POLICY.Statement,
  ],
};
function journeyInlinePolicy(
  githubOAuthClientSecretArn = null,
  { runtimeBacked = true } = {},
) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${JOURNEY_LOG_GROUP_ARN}:*`,
      },
      {
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "DELIVERY#*",
              "DOMAIN",
              "GITHUB_AUTHORIZATION#*",
              "GRANT#*",
              "JOURNEY#*",
              "MODEL_POLICY",
              "MUTATION#*",
              "PROJECT#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: PLATFORM_STATE_TABLE_ARN,
      },
      {
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["DOMAIN"],
          },
        },
        Effect: "Allow",
        Resource: PLATFORM_STATE_TABLE_ARN,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MUTATION#*"],
          },
        },
        Effect: "Allow",
        Resource: PLATFORM_STATE_TABLE_ARN,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["GITHUB_AUTHORIZATION#*"],
          },
        },
        Effect: "Allow",
        Resource: PLATFORM_STATE_TABLE_ARN,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["DELIVERY#*", "JOURNEY#*"],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: PLATFORM_STATE_TABLE_ARN,
      },
      {
        Action: "dynamodb:UpdateItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "DELIVERY#*",
              "GITHUB_AUTHORIZATION#*",
              "MUTATION#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: PLATFORM_STATE_TABLE_ARN,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: USER_POOL_ARN,
      },
      {
        Action: "agent-registry:ListRegistryRecords",
        Effect: "Allow",
        Resource: [
          CONTROL_PLANE_ARNS.sharedRegistryArn,
          CONTROL_PLANE_ARNS.platformRegistryArn,
          CONTROL_PLANE_ARNS.customerSupportRegistryArn,
          CONTROL_PLANE_ARNS.operationsRegistryArn,
        ],
      },
      {
        Action: [
          "agent-registry:GetDiscoverableRegistryRecord",
          "agent-registry:GetRegistryRecord",
        ],
        Effect: "Allow",
        Resource: [
          `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
          `${CONTROL_PLANE_ARNS.platformRegistryArn}/record/*`,
          `${CONTROL_PLANE_ARNS.customerSupportRegistryArn}/record/*`,
          `${CONTROL_PLANE_ARNS.operationsRegistryArn}/record/*`,
        ],
      },
      {
        Action: [
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:ListGatewayTargets",
        ],
        Effect: "Allow",
        Resource: CONTROL_PLANE_ARNS.toolsGatewayArn,
      },
      ...(runtimeBacked
        ? [
            {
              Action: "secretsmanager:GetSecretValue",
              Effect: "Allow",
              Resource: githubOAuthClientSecretArn
                ? [
                    githubOAuthClientSecretArn,
                    RUNTIME_INVOCATION_PROOF_SECRET_ARN,
                  ]
                : RUNTIME_INVOCATION_PROOF_SECRET_ARN,
            },
            {
              Action: [
                "bedrock-agentcore:InvokeAgentRuntime",
                "bedrock-agentcore:InvokeAgentRuntimeForUser",
              ],
              Effect: "Allow",
              Resource: [
                AGENT_RUNTIME_EXACT_ARN,
                AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN,
              ],
            },
          ]
        : [{
            Action: "bedrock:InvokeModel",
            Effect: "Allow",
            Resource: JOURNEY_INCEPTION_MODEL_ARNS,
          }]),
    ],
  };
}
const JOURNEY_INLINE_POLICY = journeyInlinePolicy();
const JOURNEY_PREDECESSOR_INLINE_POLICY = journeyInlinePolicy(
  null,
  { runtimeBacked: false },
);
const JOURNEY_OAUTH_INLINE_POLICY = journeyInlinePolicy(
  JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN,
);
const JOURNEY_OAUTH_PREDECESSOR_INLINE_POLICY = journeyInlinePolicy(
  null,
  { runtimeBacked: false },
);
const JOURNEY_DEFAULT_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      Effect: "Allow",
      Resource: GATEWAY_INVOKER_ROLE_ARN,
    },
    ...XRAY_INLINE_POLICY.Statement,
  ],
};
const BUILDER_MODEL_POLICY_READ_PREDECESSOR_INLINE_POLICY =
  structuredClone(BUILDER_RESOURCE_AUTH_PREDECESSOR_INLINE_POLICY);
BUILDER_MODEL_POLICY_READ_PREDECESSOR_INLINE_POLICY.Statement.find(
  ({ Action }) => Action === "dynamodb:GetItem",
).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] =
  BUILDER_MODEL_POLICY_READ_PREDECESSOR_INLINE_POLICY.Statement.find(
    ({ Action }) => Action === "dynamodb:GetItem",
  ).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"].filter(
    (key) => key !== "MODEL_POLICY",
  );
BUILDER_MODEL_POLICY_READ_PREDECESSOR_INLINE_POLICY.Statement =
  BUILDER_MODEL_POLICY_READ_PREDECESSOR_INLINE_POLICY.Statement.filter(
    ({ Action }) => Action !== "dynamodb:Query",
  );
const BUILDER_GATEWAY_PREDECESSOR_XRAY_INLINE_POLICY = structuredClone(
  XRAY_INLINE_POLICY,
);
const MODEL_GOVERNANCE_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: MODEL_GOVERNANCE_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "APPROVAL#*",
            "DOMAIN",
            "GRANT#*",
            "MODEL_POLICY",
            "MUTATION#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "APPROVAL#*",
            "AUDIT#*",
            "GRANT#*",
            "MODEL_POLICY",
            "MODEL_POLICY_AUDIT#*",
            "MUTATION#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminListGroupsForUser",
      ],
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
    {
      Action: [
        "bedrock-agentcore:GetGatewayTarget",
        "bedrock-agentcore:ListGatewayTargets",
      ],
      Effect: "Allow",
      Resource: CONTROL_PLANE_ARNS.toolsGatewayArn,
    },
    {
      Action: [
        "bedrock-agentcore:BatchPutGatewayRateLimits",
        "bedrock-agentcore:ListGatewayRateLimits",
      ],
      Effect: "Allow",
      Resource: CONTROL_PLANE_ARNS.llmGatewayArn,
    },
    {
      Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      Effect: "Allow",
      Resource: GATEWAY_INVOKER_ROLE_ARN,
    },
  ],
};
const MODEL_GOVERNANCE_XRAY_INLINE_POLICY = structuredClone(
  XRAY_INLINE_POLICY,
);
const AGENT_RUNTIME_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      Effect: "Allow",
      Resource: GATEWAY_INVOKER_ROLE_ARN,
    },
    {
      Action: "secretsmanager:GetSecretValue",
      Effect: "Allow",
      Resource: RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["RUNTIME_PROOF#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Sid: "LogGroupAccess",
      Action: ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
      Effect: "Allow",
      Resource:
        `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
        + "log-group:/aws/bedrock-agentcore/runtimes/*",
    },
    {
      Sid: "DescribeLogGroups",
      Action: "logs:DescribeLogGroups",
      Effect: "Allow",
      Resource:
        `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*`,
    },
    {
      Sid: "LogStreamAccess",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource:
        `arn:aws:logs:${REGION}:${ACCOUNT_ID}:`
        + "log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*",
    },
    {
      Sid: "XRayAccess",
      Action: [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "xray:GetSamplingRules",
        "xray:GetSamplingTargets",
      ],
      Effect: "Allow",
      Resource: "*",
    },
    {
      Sid: "CloudWatchMetrics",
      Action: "cloudwatch:PutMetricData",
      Condition: {
        StringEquals: {
          "cloudwatch:namespace": "bedrock-agentcore",
        },
      },
      Effect: "Allow",
      Resource: "*",
    },
    {
      Sid: "GetAgentAccessToken",
      Action: [
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
        "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
      ],
      Effect: "Allow",
      Resource: [
        `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
          + "workload-identity-directory/default",
        `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
          + "workload-identity-directory/default/workload-identity/*",
      ],
    },
    {
      Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
      Effect: "Allow",
      Resource: [
        `arn:aws:s3:::cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}`,
        `arn:aws:s3:::cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}/*`,
      ],
    },
  ],
};
const AGENT_RUNTIME_GATEWAY_PREDECESSOR_INLINE_POLICY =
  structuredClone(AGENT_RUNTIME_INLINE_POLICY);
AGENT_RUNTIME_GATEWAY_PREDECESSOR_INLINE_POLICY.Statement =
  AGENT_RUNTIME_GATEWAY_PREDECESSOR_INLINE_POLICY.Statement.slice(3);
const EXPERIENCE_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: EXPERIENCE_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "DEPLOYMENT#*",
            "DOMAIN",
            "ENTITLEMENT#*",
            "MUTATION#*",
            "PROJECT#*",
            "SESSION#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:Query",
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["APPROVAL"],
        },
      },
      Effect: "Allow",
      Resource: `${PLATFORM_STATE_TABLE_ARN}/index/EntityTypeIndex`,
    },
    {
      Action: [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      ],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["EXPERIENCE_INVOCATION#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["MUTATION#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["SUBMISSION#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "APPROVAL#*",
            "AUDIT#*",
            "MUTATION#*",
            "SESSION#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminListGroupsForUser",
      ],
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
    {
      Action: "secretsmanager:GetSecretValue",
      Effect: "Allow",
      Resource: RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    },
    {
      Action: [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeForUser",
      ],
      Effect: "Allow",
      Resource: [
        AGENT_RUNTIME_EXACT_ARN,
        AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN,
      ],
    },
  ],
};
const EXPERIENCE_SUBMISSION_REPLAY_PREDECESSOR_INLINE_POLICY =
  structuredClone(EXPERIENCE_INLINE_POLICY);
EXPERIENCE_SUBMISSION_REPLAY_PREDECESSOR_INLINE_POLICY.Statement.splice(
  4,
  2,
  {
    Action: "dynamodb:PutItem",
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": ["MUTATION#*", "SUBMISSION#*"],
      },
    },
    Effect: "Allow",
    Resource: PLATFORM_STATE_TABLE_ARN,
  },
);
const EXPERIENCE_GATEWAY_PREDECESSOR_INLINE_POLICY =
  structuredClone(
    EXPERIENCE_SUBMISSION_REPLAY_PREDECESSOR_INLINE_POLICY,
  );
EXPERIENCE_GATEWAY_PREDECESSOR_INLINE_POLICY.Statement =
  EXPERIENCE_GATEWAY_PREDECESSOR_INLINE_POLICY.Statement.filter(
    ({ Action }) => Action !== "secretsmanager:GetSecretValue",
  );
const EXPERIENCE_XRAY_INLINE_POLICY = structuredClone(
  XRAY_INLINE_POLICY,
);
const PLATFORM_STATE_SEED_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: PLATFORM_STATE_SEED_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["DOMAIN"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
  ],
};
const PLATFORM_WORKSPACE_SEED_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: PLATFORM_STATE_SEED_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["PROJECT#platform", "HITL_POLICY#platform"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
  ],
};
const PLATFORM_ADMIN_TRUST_POLICY = structuredClone(
  PLATFORM_STATE_SEED_TRUST_POLICY,
);
const IDENTITY_TRUST_POLICY = structuredClone(
  PLATFORM_STATE_SEED_TRUST_POLICY,
);
const GOVERNANCE_TRUST_POLICY = structuredClone(
  PLATFORM_STATE_SEED_TRUST_POLICY,
);
const WORKSPACE_TRUST_POLICY = structuredClone(
  PLATFORM_STATE_SEED_TRUST_POLICY,
);
const IDENTITY_PREDECESSOR_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
    Effect: "Allow",
    Resource: IDENTITY_LOG_GROUP_CHILD_ARN,
  }],
};
const AUTHORITATIVE_DEMO_OPERATOR_READ_STATEMENT = {
  Action: [
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
  ],
  Effect: "Allow",
  Resource: USER_POOL_ARN,
};
const IDENTITY_TARGET_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    ...IDENTITY_PREDECESSOR_INLINE_POLICY.Statement,
    {
      Action: "dynamodb:Query",
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:Attributes": [
            "pk",
            "sk",
            "entityType",
            "id",
            "name",
            "status",
          ],
          "dynamodb:LeadingKeys": ["DOMAIN"],
        },
        StringEquals: {
          "dynamodb:Select": "SPECIFIC_ATTRIBUTES",
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    AUTHORITATIVE_DEMO_OPERATOR_READ_STATEMENT,
  ],
};
const IDENTITY_XRAY_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
    Effect: "Allow",
    Resource: "*",
  }],
};
const GOVERNANCE_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: GOVERNANCE_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "APPROVAL#*",
            "DEPLOYMENT#*",
            "DOMAIN",
            "ENTITLEMENT#*",
            "GRANT#*",
            "MUTATION#*",
            "PROJECT#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:Query",
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["ENTITLEMENT"],
        },
      },
      Effect: "Allow",
      Resource: `${PLATFORM_STATE_TABLE_ARN}/index/EntityTypeIndex`,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["MUTATION#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "APPROVAL#*",
            "AUDIT#*",
            "ENTITLEMENT#*",
            "GRANT#*",
            "MUTATION#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    AUTHORITATIVE_DEMO_OPERATOR_READ_STATEMENT,
    {
      Action: "agent-registry:ListRegistryRecords",
      Effect: "Allow",
      Resource: [
        CONTROL_PLANE_ARNS.sharedRegistryArn,
        CONTROL_PLANE_ARNS.platformRegistryArn,
        CONTROL_PLANE_ARNS.customerSupportRegistryArn,
        CONTROL_PLANE_ARNS.operationsRegistryArn,
      ],
    },
    {
      Action: "agent-registry:GetRegistryRecord",
      Effect: "Allow",
      Resource: [
        `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.platformRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.customerSupportRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.operationsRegistryArn}/record/*`,
      ],
    },
    {
      Action: [
        "agent-registry:CreateRegistryRecord",
        "agent-registry:TagResource",
      ],
      Condition: registryRequestTagCondition("cdk"),
      Effect: "Allow",
      Resource: [
        ACCOUNT_REGISTRY_ARN,
        ACCOUNT_REGISTRY_RECORD_ARN,
      ],
    },
    {
      Action: [
        "agent-registry:GetRegistryRecord",
        "agent-registry:SubmitRegistryRecordForApproval",
        "agent-registry:UpdateRegistryRecordStatus",
      ],
      Condition: registryResourceTagCondition("cdk"),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_RECORD_ARN,
    },
    {
      Action: "agent-registry:ListRegistryRecords",
      Condition: registryResourceTagCondition("cdk"),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_ARN,
    },
  ],
};
const GOVERNANCE_LEGACY_TRANSACTION_INLINE_POLICY =
  structuredClone(GOVERNANCE_INLINE_POLICY);
GOVERNANCE_LEGACY_TRANSACTION_INLINE_POLICY.Statement.splice(
  3,
  2,
  {
    Action: ["dynamodb:PutItem", "dynamodb:TransactWriteItems"],
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": [
          "APPROVAL#*",
          "AUDIT#*",
          "ENTITLEMENT#*",
          "GRANT#*",
          "MUTATION#*",
        ],
      },
    },
    Effect: "Allow",
    Resource: PLATFORM_STATE_TABLE_ARN,
  },
);
const GOVERNANCE_XRAY_INLINE_POLICY =
  structuredClone(IDENTITY_XRAY_INLINE_POLICY);
const WORKSPACE_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: WORKSPACE_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "APPROVAL#*",
            "DEPLOYMENT#*",
            "DOMAIN",
            "GRANT#*",
            "MUTATION#*",
            "PROJECT#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AUDIT#*",
            "MUTATION#*",
            "PROJECT#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    AUTHORITATIVE_DEMO_OPERATOR_READ_STATEMENT,
  ],
};
const WORKSPACE_XRAY_INLINE_POLICY =
  structuredClone(IDENTITY_XRAY_INLINE_POLICY);
const ACCESS_ADMIN_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: ACCESS_ADMIN_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "BREAK_GLASS",
            "DOMAIN",
            "MUTATION#*",
            "PROJECT#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["MUTATION#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["AUDIT#*", "MUTATION#*"],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:UpdateItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["PROJECT#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: [
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:ListUsers",
        "cognito-idp:ListUsersInGroup",
      ],
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
  ],
};
const ACCESS_ADMIN_XRAY_INLINE_POLICY =
  structuredClone(IDENTITY_XRAY_INLINE_POLICY);
const HOSTED_ACCEPTANCE_TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Action: "sts:AssumeRole",
    Condition: {
      ArnEquals: {
        "aws:PrincipalArn": GITHUB_DEPLOY_ROLE_ARN,
      },
    },
    Effect: "Allow",
    Principal: {
      AWS: `arn:aws:iam::${ACCOUNT_ID}:root`,
    },
  }],
};
const HOSTED_ACCEPTANCE_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: [
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminInitiateAuth",
        "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:AdminSetUserPassword",
      ],
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
    {
      Action: "lambda:InvokeFunction",
      Effect: "Allow",
      Resource: HOSTED_ACCEPTANCE_BROKER_FUNCTION_ARN,
    },
  ],
};
const PLATFORM_ADMIN_PREDECESSOR_TABLE_STATEMENT = {
  Action: [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
    "dynamodb:TransactWriteItems",
    "dynamodb:UpdateItem",
  ],
  Effect: "Allow",
  Resource: PLATFORM_STATE_TABLE_ARN,
};
function registryRequestTagCondition(managedBy) {
  return {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": managedBy,
      "aws:RequestTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
    },
  };
}

function regionalArnRequestTagCondition(managedBy) {
  const condition = registryRequestTagCondition(managedBy);
  delete condition.StringEquals["aws:RequestedRegion"];
  return condition;
}

function registryResourceTagCondition(managedBy = "hosted-acceptance") {
  return {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": managedBy,
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
    },
  };
}

function regionalArnResourceTagCondition(
  managedBy = "hosted-acceptance",
) {
  const condition = registryResourceTagCondition(managedBy);
  delete condition.StringEquals["aws:RequestedRegion"];
  return condition;
}

const PLATFORM_ADMIN_CREATE_REGISTRY_STATEMENT = {
  Action: "agent-registry:CreateRegistry",
  Condition: registryRequestTagCondition("cdk"),
  Effect: "Allow",
  Resource: "*",
};
const PLATFORM_ADMIN_TAG_REGISTRY_STATEMENT = {
  Action: "agent-registry:TagResource",
  Condition: registryRequestTagCondition("cdk"),
  Effect: "Allow",
  Resource: ACCOUNT_REGISTRY_ARN,
};
const PLATFORM_ADMIN_CREATE_ACCEPTANCE_REGISTRY_STATEMENT = {
  Action: "agent-registry:CreateRegistry",
  Condition: registryRequestTagCondition("hosted-acceptance"),
  Effect: "Allow",
  Resource: "*",
};
const PLATFORM_ADMIN_TAG_ACCEPTANCE_REGISTRY_STATEMENT = {
  Action: "agent-registry:TagResource",
  Condition: registryRequestTagCondition("hosted-acceptance"),
  Effect: "Allow",
  Resource: ACCOUNT_REGISTRY_ARN,
};
const PLATFORM_ADMIN_MANAGE_REGISTRY_WORKLOAD_IDENTITY_STATEMENT = {
  Action: [
    "bedrock-agentcore:CreateWorkloadIdentity",
    "bedrock-agentcore:DeleteWorkloadIdentity",
  ],
  Condition: {
    StringEquals: {
      "aws:RequestedRegion": REGION,
    },
  },
  Effect: "Allow",
  Resource:
    `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
    + "workload-identity-directory/*",
};
const PLATFORM_ADMIN_PREDECESSOR_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: PLATFORM_ADMIN_LOG_GROUP_CHILD_ARN,
    },
    PLATFORM_ADMIN_PREDECESSOR_TABLE_STATEMENT,
    PLATFORM_ADMIN_CREATE_REGISTRY_STATEMENT,
    {
      Action: PLATFORM_ADMIN_DOMAIN_GROUP_ACTIONS,
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
  ],
};
const PLATFORM_ADMIN_TARGET_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    PLATFORM_ADMIN_PREDECESSOR_INLINE_POLICY.Statement[0],
    {
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["DOMAIN", "REQUEST#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["REQUEST#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "DOMAIN",
            "REGISTRY_RECORD#*",
            "REQUEST#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "lambda:InvokeFunction",
      Effect: "Allow",
      Resource: REGISTRY_DECISION_FINALIZER_FUNCTION_ARN,
    },
    PLATFORM_ADMIN_CREATE_REGISTRY_STATEMENT,
    PLATFORM_ADMIN_TAG_REGISTRY_STATEMENT,
    PLATFORM_ADMIN_CREATE_ACCEPTANCE_REGISTRY_STATEMENT,
    PLATFORM_ADMIN_TAG_ACCEPTANCE_REGISTRY_STATEMENT,
    PLATFORM_ADMIN_MANAGE_REGISTRY_WORKLOAD_IDENTITY_STATEMENT,
    {
      Action: "agent-registry:ListRegistryRecords",
      Effect: "Allow",
      Resource: [
        CONTROL_PLANE_ARNS.sharedRegistryArn,
        CONTROL_PLANE_ARNS.platformRegistryArn,
        CONTROL_PLANE_ARNS.customerSupportRegistryArn,
        CONTROL_PLANE_ARNS.operationsRegistryArn,
      ],
    },
    {
      Action: [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
        "agent-registry:UpdateRegistryRecordStatus",
      ],
      Effect: "Allow",
      Resource: [
        `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.platformRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.customerSupportRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.operationsRegistryArn}/record/*`,
      ],
    },
    {
      Action: [
        "agent-registry:DeleteRegistry",
        "agent-registry:GetRegistry",
        "agent-registry:ListRegistryRecords",
      ],
      Condition: registryResourceTagCondition([
        "cdk",
        "hosted-acceptance",
      ]),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_ARN,
    },
    {
      Action: [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
        "agent-registry:UpdateRegistryRecordStatus",
      ],
      Condition: registryResourceTagCondition([
        "cdk",
        "hosted-acceptance",
      ]),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_RECORD_ARN,
    },
    {
      Action: [
        ...AUTHORITATIVE_DEMO_OPERATOR_READ_STATEMENT.Action,
        ...PLATFORM_ADMIN_DOMAIN_GROUP_ACTIONS,
      ],
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
  ],
};
const PLATFORM_ADMIN_DISCOVERABLE_READ_PREDECESSOR_INLINE_POLICY =
  structuredClone(PLATFORM_ADMIN_TARGET_INLINE_POLICY);
for (const statement of
  PLATFORM_ADMIN_DISCOVERABLE_READ_PREDECESSOR_INLINE_POLICY.Statement) {
  if (
    Array.isArray(statement.Action)
    && statement.Action.includes(
      "agent-registry:UpdateRegistryRecordStatus",
    )
  ) {
    statement.Action = statement.Action.filter(
      (action) =>
        action !== "agent-registry:GetDiscoverableRegistryRecord",
    );
  }
}
const PLATFORM_ADMIN_LEGACY_TRANSACTION_INLINE_POLICY =
  structuredClone(PLATFORM_ADMIN_TARGET_INLINE_POLICY);
PLATFORM_ADMIN_LEGACY_TRANSACTION_INLINE_POLICY.Statement.splice(
  2,
  2,
  {
    Action: ["dynamodb:PutItem", "dynamodb:TransactWriteItems"],
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": [
          "DOMAIN",
          "REGISTRY_RECORD#*",
          "REQUEST#*",
        ],
      },
    },
    Effect: "Allow",
    Resource: PLATFORM_STATE_TABLE_ARN,
  },
);
const PLATFORM_ADMIN_PREVIOUS_TARGET_INLINE_POLICY =
  structuredClone(PLATFORM_ADMIN_TARGET_INLINE_POLICY);
{
  const registryLifecycleStatement =
    PLATFORM_ADMIN_PREVIOUS_TARGET_INLINE_POLICY.Statement.find(
      ({ Action }) =>
        Array.isArray(Action)
        && Action.includes("agent-registry:DeleteRegistry"),
    );
  registryLifecycleStatement.Action =
    registryLifecycleStatement.Action.filter(
      (action) => action !== "agent-registry:GetRegistry",
    );
}
const PLATFORM_ADMIN_PREVIOUS_WORKLOAD_IDENTITY_INLINE_POLICY =
  structuredClone(PLATFORM_ADMIN_PREVIOUS_TARGET_INLINE_POLICY);
{
  const workloadIdentityStatement =
    PLATFORM_ADMIN_PREVIOUS_WORKLOAD_IDENTITY_INLINE_POLICY.Statement.find(
      ({ Action }) =>
        Array.isArray(Action)
        && Action.includes("bedrock-agentcore:CreateWorkloadIdentity"),
    );
  workloadIdentityStatement.Resource =
    `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
    + "workload-identity-directory/default/workload-identity/registry-*";
}
const CONTROL_PLANE_READ_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: CONTROL_PLANE_READ_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: "agent-registry:ListRegistryRecords",
      Effect: "Allow",
      Resource: [
        CONTROL_PLANE_ARNS.sharedRegistryArn,
        CONTROL_PLANE_ARNS.platformRegistryArn,
        CONTROL_PLANE_ARNS.customerSupportRegistryArn,
        CONTROL_PLANE_ARNS.operationsRegistryArn,
      ],
    },
    {
      Action: [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
      ],
      Effect: "Allow",
      Resource: [
        `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.platformRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.customerSupportRegistryArn}/record/*`,
        `${CONTROL_PLANE_ARNS.operationsRegistryArn}/record/*`,
      ],
    },
    {
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["DOMAIN", "MODEL_POLICY"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "agent-registry:ListRegistryRecords",
      Condition: registryResourceTagCondition([
        "cdk",
        "hosted-acceptance",
      ]),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_ARN,
    },
    {
      Action: [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
      ],
      Condition: registryResourceTagCondition([
        "cdk",
        "hosted-acceptance",
      ]),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_RECORD_ARN,
    },
    {
      Action: [
        "bedrock-agentcore:GetGatewayTarget",
        "bedrock-agentcore:ListGatewayTargets",
      ],
      Effect: "Allow",
      Resource: CONTROL_PLANE_ARNS.toolsGatewayArn,
    },
    AUTHORITATIVE_DEMO_OPERATOR_READ_STATEMENT,
  ],
};
const CONTROL_PLANE_READ_XRAY_INLINE_POLICY = {
  ...structuredClone(XRAY_INLINE_POLICY),
  Statement: [
    ...XRAY_INLINE_POLICY.Statement,
    {
      Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      Effect: "Allow",
      Resource: GATEWAY_INVOKER_ROLE_ARN,
    },
  ],
};
const CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_INLINE_POLICY =
  structuredClone(CONTROL_PLANE_READ_INLINE_POLICY);
CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_INLINE_POLICY.Statement[3].Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"] = ["DOMAIN"];
CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_INLINE_POLICY.Statement.splice(
  -1,
  0,
  {
    Action: "bedrock-agentcore:InvokeGateway",
    Effect: "Allow",
    Resource: CONTROL_PLANE_ARNS.llmGatewayArn,
  },
);
const CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_XRAY_INLINE_POLICY =
  structuredClone(XRAY_INLINE_POLICY);
const CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY =
  structuredClone(CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_INLINE_POLICY);
CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY.Statement.pop();
CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY.Statement[1].Action = [
  "agent-registry:GetDiscoverableRegistryRecord",
  "agent-registry:ListRegistryRecords",
];
CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY.Statement[2].Action =
  "agent-registry:GetRegistryRecord";
CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY.Statement[4].Action = [
  "agent-registry:GetDiscoverableRegistryRecord",
  "agent-registry:ListRegistryRecords",
];
CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY.Statement[5].Action =
  "agent-registry:GetRegistryRecord";
const HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: HOSTED_ACCEPTANCE_BROKER_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: HOSTED_ACCEPTANCE_BROKER_DOMAIN_GROUP_ACTIONS,
      Effect: "Allow",
      Resource: USER_POOL_ARN,
    },
    {
      Action: "agent-registry:ListRegistryRecords",
      Effect: "Allow",
      Resource: CONTROL_PLANE_ARNS.sharedRegistryArn,
    },
    {
      Action: "agent-registry:CreateRegistryRecord",
      Condition: registryRequestTagCondition("hosted-acceptance"),
      Effect: "Allow",
      Resource: [
        CONTROL_PLANE_ARNS.sharedRegistryArn,
        `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
      ],
    },
    {
      Action: "agent-registry:TagResource",
      Condition: registryRequestTagCondition("hosted-acceptance"),
      Effect: "Allow",
      Resource: [
        CONTROL_PLANE_ARNS.sharedRegistryArn,
        `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
      ],
    },
    {
      Action: [
        "agent-registry:GetRegistryRecord",
        "agent-registry:ListTagsForResource",
      ],
      Effect: "Allow",
      Resource: `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
    },
    {
      Action: [
        "agent-registry:SubmitRegistryRecordForApproval",
        "agent-registry:DeleteRegistryRecord",
      ],
      Condition: registryResourceTagCondition(),
      Effect: "Allow",
      Resource: `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
    },
    {
      Action: [
        "agent-registry:GetRegistry",
        "agent-registry:ListTagsForResource",
      ],
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_ARN,
    },
    {
      Action: "agent-registry:DeleteRegistry",
      Condition: registryResourceTagCondition(),
      Effect: "Allow",
      Resource: ACCOUNT_REGISTRY_ARN,
    },
    {
      Sid: "DeleteHostedAcceptanceRegistryWorkloadIdentity",
      Action: "bedrock-agentcore:DeleteWorkloadIdentity",
      Condition: {
        StringEquals: {
          "aws:RequestedRegion": REGION,
        },
      },
      Effect: "Allow",
      Resource: [
        `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
          + "workload-identity-directory/default",
        `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
          + "workload-identity-directory/default/"
          + "workload-identity/registry-*",
      ],
    },
    {
      Sid: "ReadHostedAcceptanceState",
      Action: "dynamodb:GetItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#customer_support#hosted-project-*",
            "AGENT#operations#hosted-project-*",
            "APPROVAL#customer_support",
            "APPROVAL#operations",
            "APPROVAL#hosted_acceptance_*",
            "AUDIT#*",
            "DEPLOYMENT#customer_support#hosted-project-*",
            "DEPLOYMENT#operations#hosted-project-*",
            "DELIVERY#*",
            "DOMAIN",
            "ENTITLEMENT#*",
            "EXPERIENCE_INVOCATION#*",
            "HOSTED_ACCEPTANCE",
            "HOSTED_ROLE_SWITCHING",
            "JOURNEY#*",
            "MUTATION#*",
            "PROJECT#customer_support",
            "PROJECT#operations",
            "REQUEST#*",
            "SESSION#*",
            "SUBMISSION#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Sid: "DeleteHostedAcceptanceState",
      Action: "dynamodb:DeleteItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#customer_support#hosted-project-*",
            "AGENT#operations#hosted-project-*",
            "APPROVAL#hosted_acceptance_*",
            "AUDIT#*",
            "DEPLOYMENT#customer_support#hosted-project-*",
            "DEPLOYMENT#operations#hosted-project-*",
            "DOMAIN",
            "ENTITLEMENT#*",
            "EXPERIENCE_INVOCATION#*",
            "HOSTED_ACCEPTANCE",
            "HOSTED_ROLE_SWITCHING",
            "MUTATION#*",
            "REQUEST#*",
            "SESSION#*",
            "SUBMISSION#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Sid: "WriteHostedAcceptanceMappings",
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "HOSTED_ACCEPTANCE",
            "HOSTED_ROLE_SWITCHING",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Sid: "QueryHostedAcceptanceEntitlements",
      Action: "dynamodb:Query",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["ENTITLEMENT#*"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Sid: "WriteHostedAcceptanceExperienceFixture",
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#customer_support#hosted-project-*",
              "AGENT#operations#hosted-project-*",
              "DEPLOYMENT#customer_support#hosted-project-*",
            "DEPLOYMENT#operations#hosted-project-*",
            "ENTITLEMENT#*",
            "PROJECT#customer_support",
            "PROJECT#operations",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Sid: "DeleteHostedAcceptanceExperienceFixture",
      Action: "dynamodb:DeleteItem",
      Condition: {
        "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#customer_support#hosted-project-*",
              "AGENT#operations#hosted-project-*",
              "APPROVAL#customer_support",
              "APPROVAL#operations",
              "DEPLOYMENT#customer_support#hosted-project-*",
            "DEPLOYMENT#operations#hosted-project-*",
            "ENTITLEMENT#*",
            "PROJECT#customer_support",
            "PROJECT#operations",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Sid: "DeleteHostedAcceptanceAgentBuildingJourneys",
      Action: "dynamodb:DeleteItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "DELIVERY#*",
            "JOURNEY#*",
            "MUTATION#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "bedrock-agentcore:GetAgentRuntime",
      Effect: "Allow",
      Resource: AGENT_RUNTIME_EXACT_ARN,
    },
    {
      Action: "bedrock-agentcore:GetAgentRuntimeEndpoint",
      Effect: "Allow",
      Resource: [
        AGENT_RUNTIME_EXACT_ARN,
        AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN,
      ],
    },
  ],
};

function priorHostedAcceptanceBrokerInlinePolicy() {
  const policy = structuredClone(HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY);
  const tableResource = PLATFORM_STATE_TABLE_ARN;
  policy.Statement = [
    ...policy.Statement.filter(({ Action }) =>
      !(Array.isArray(Action) ? Action : [Action])
        .some((action) => action.startsWith("dynamodb:"))
    ),
    {
      Action: ["dynamodb:DeleteItem", "dynamodb:GetItem"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "APPROVAL#*",
            "AUDIT#*",
            "DEPLOYMENT#*",
            "DOMAIN",
            "ENTITLEMENT#*",
            "EXPERIENCE_INVOCATION#*",
            "HOSTED_ACCEPTANCE",
            "HOSTED_ROLE_SWITCHING",
            "MUTATION#*",
            "REQUEST#*",
            "SESSION#*",
            "SUBMISSION#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: tableResource,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "HOSTED_ACCEPTANCE",
            "HOSTED_ROLE_SWITCHING",
          ],
        },
      },
      Effect: "Allow",
      Resource: tableResource,
    },
    {
      Action: "dynamodb:Query",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["ENTITLEMENT#*"],
        },
      },
      Effect: "Allow",
      Resource: tableResource,
    },
    {
      Action: "dynamodb:GetItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "DEPLOYMENT#*",
            "ENTITLEMENT#*",
            "PROJECT#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: tableResource,
    },
    {
      Action: ["dynamodb:DeleteItem", "dynamodb:PutItem"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AGENT#*",
            "DEPLOYMENT#*",
            "ENTITLEMENT#*",
            "PROJECT#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: tableResource,
    },
  ];
  return policy;
}

function priorBusinessDomainFixtureBrokerInlinePolicy() {
  const policy = structuredClone(HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY);
  const oldReadKeys = [
    "AGENT#hosted_acceptance_*",
    "APPROVAL#hosted_acceptance_*",
    "AUDIT#*",
    "DEPLOYMENT#hosted_acceptance_*",
    "DOMAIN",
    "ENTITLEMENT#*",
    "EXPERIENCE_INVOCATION#*",
    "HOSTED_ACCEPTANCE",
    "HOSTED_ROLE_SWITCHING",
    "MUTATION#*",
    "PROJECT#hosted_acceptance_*",
    "REQUEST#*",
    "SESSION#*",
    "SUBMISSION#*",
  ];
  const oldFixtureKeys = [
    "AGENT#hosted_acceptance_*",
    "DEPLOYMENT#hosted_acceptance_*",
    "ENTITLEMENT#*",
    "PROJECT#hosted_acceptance_*",
  ];
  for (const statement of policy.Statement) {
    const leadingKeys =
      statement.Condition?.["ForAllValues:StringLike"]
        ?.["dynamodb:LeadingKeys"];
    if (statement.Sid === "ReadHostedAcceptanceState") {
      statement.Condition["ForAllValues:StringLike"][
        "dynamodb:LeadingKeys"
      ] = oldReadKeys;
    } else if (statement.Sid === "DeleteHostedAcceptanceState") {
      statement.Condition["ForAllValues:StringLike"][
        "dynamodb:LeadingKeys"
      ] = oldReadKeys.filter(
        (key) => key !== "PROJECT#hosted_acceptance_*",
      );
    } else if (
      statement.Sid === "WriteHostedAcceptanceExperienceFixture"
      || statement.Sid === "DeleteHostedAcceptanceExperienceFixture"
    ) {
      assert.ok(leadingKeys);
      statement.Condition["ForAllValues:StringLike"][
        "dynamodb:LeadingKeys"
      ] = oldFixtureKeys;
    }
  }
  return policy;
}

function priorBusinessDomainApprovalCleanupBrokerInlinePolicy() {
  const policy = structuredClone(HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY);
  const businessDomainApprovalKeys = new Set([
    "APPROVAL#customer_support",
    "APPROVAL#operations",
  ]);
  for (const statement of policy.Statement) {
    if (
      statement.Sid !== "ReadHostedAcceptanceState"
      && statement.Sid !== "DeleteHostedAcceptanceExperienceFixture"
    ) {
      continue;
    }
    statement.Condition["ForAllValues:StringLike"][
      "dynamodb:LeadingKeys"
    ] = statement.Condition["ForAllValues:StringLike"][
      "dynamodb:LeadingKeys"
    ].filter((key) => !businessDomainApprovalKeys.has(key));
  }
  return policy;
}

function priorAgentBuildingAcceptanceBrokerInlinePolicy() {
  const policy = structuredClone(HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY);
  policy.Statement = policy.Statement.filter(
    ({ Sid }) => Sid !== "DeleteHostedAcceptanceAgentBuildingJourneys",
  );
  const read = policy.Statement.find(
    ({ Sid }) => Sid === "ReadHostedAcceptanceState",
  );
  read.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] =
    read.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"].filter(
      (key) => key !== "DELIVERY#*" && key !== "JOURNEY#*",
    );
  return policy;
}

test("runtime boundary and broker role encode the effective acceptance write limit", () => {
  const hostedState = EXPECTED_RUNTIME_BOUNDARY_POLICY.Statement.find(
    ({ Sid }) => Sid === "ReadDeleteHostedAcceptanceState",
  );
  assert.deepEqual(hostedState, {
    Sid: "ReadDeleteHostedAcceptanceState",
    Effect: "Allow",
    Action: ["dynamodb:DeleteItem", "dynamodb:GetItem"],
    Resource: [PLATFORM_STATE_TABLE_ARN],
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": [
          "AGENT#customer_support#hosted-project-*",
          "AGENT#operations#hosted-project-*",
          "APPROVAL#hosted_acceptance_*",
          "AUDIT#*",
          "DEPLOYMENT#customer_support#hosted-project-*",
          "DEPLOYMENT#operations#hosted-project-*",
          "DELIVERY#*",
          "DOMAIN",
          "ENTITLEMENT#*",
          "EXPERIENCE_INVOCATION#*",
          "HOSTED_ACCEPTANCE",
          "HOSTED_ROLE_SWITCHING",
          "JOURNEY#*",
          "MUTATION#*",
          "PROJECT#customer_support",
          "PROJECT#operations",
          "REQUEST#*",
          "SESSION#*",
          "SUBMISSION#*",
        ],
      },
    },
  });
  const brokerPutKeys = HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY.Statement
    .filter(({ Action }) =>
      (Array.isArray(Action) ? Action : [Action])
        .includes("dynamodb:PutItem")
    )
    .flatMap((statement) =>
      statement.Condition?.["ForAllValues:StringLike"]
        ?.["dynamodb:LeadingKeys"] ?? []
    );
  assert.deepEqual([...new Set(brokerPutKeys)].sort(), [
    "AGENT#customer_support#hosted-project-*",
    "AGENT#operations#hosted-project-*",
    "DEPLOYMENT#customer_support#hosted-project-*",
    "DEPLOYMENT#operations#hosted-project-*",
    "ENTITLEMENT#*",
    "HOSTED_ACCEPTANCE",
    "HOSTED_ROLE_SWITCHING",
    "PROJECT#customer_support",
    "PROJECT#operations",
  ]);
  for (const forbidden of [
    "AGENT#*",
    "APPROVAL#*",
    "AUDIT#*",
    "DEPLOYMENT#*",
    "DOMAIN",
    "MUTATION#*",
    "PROJECT#*",
    "REQUEST#*",
    "SESSION#*",
    "SUBMISSION#*",
  ]) {
    assert.equal(brokerPutKeys.includes(forbidden), false, forbidden);
  }
});
const REGISTRY_DECISION_FINALIZER_INLINE_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: REGISTRY_DECISION_FINALIZER_LOG_GROUP_CHILD_ARN,
    },
    {
      Action: "dynamodb:GetItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AUDIT#*",
            "REGISTRY_RECORD#*",
            "REQUEST#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
    {
      Action: "dynamodb:PutItem",
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AUDIT#*",
            "REGISTRY_RECORD#*",
            "REQUEST#*",
          ],
        },
        "ForAnyValue:StringEquals": {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
  ],
};
const REGISTRY_DECISION_FINALIZER_LEGACY_TRANSACTION_INLINE_POLICY = {
  ...REGISTRY_DECISION_FINALIZER_INLINE_POLICY,
  Statement: [
    REGISTRY_DECISION_FINALIZER_INLINE_POLICY.Statement[0],
    {
      Action: ["dynamodb:GetItem", "dynamodb:TransactWriteItems"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "AUDIT#*",
            "REGISTRY_RECORD#*",
            "REQUEST#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: PLATFORM_STATE_TABLE_ARN,
    },
  ],
};

test("runtime boundary fixtures resolve exact invalidation and narrow alarm resources", () => {
  const invalidation = EXPECTED_RUNTIME_BOUNDARY_POLICY.Statement.find(
    ({ Sid }) => Sid === "InvalidateCloudFront",
  );
  const alarm = EXPECTED_RUNTIME_BOUNDARY_POLICY.Statement.find(
    ({ Sid }) => Sid === "ReconcileCloudFrontAlarm",
  );

  assert.deepEqual(invalidation?.Resource, [CLOUDFRONT_DISTRIBUTION_ARN]);
  assert.deepEqual(alarm?.Resource, [CLOUDFRONT_ALARM_ARN_PATTERN]);
  const alarmPattern = new RegExp(
    "^"
      + CLOUDFRONT_ALARM_ARN_PATTERN
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*")
      + "$",
  );
  for (const distributionId of ["EOLD123", "ENEW456"]) {
    assert.match(
      `arn:aws:cloudwatch:us-east-1:${ACCOUNT_ID}:`
        + "alarm:PlatformWeb-AgenticPlatform-Web-"
        + `${distributionId}-CloudFront-5xx`,
      alarmPattern,
    );
  }
  for (const unrelatedArn of [
    `arn:aws:cloudwatch:us-east-1:${ACCOUNT_ID}:`
      + "alarm:PlatformWeb-OtherStack-EOLD123-CloudFront-5xx",
    `arn:aws:cloudwatch:us-east-1:${ACCOUNT_ID}:`
      + "alarm:PlatformWeb-AgenticPlatform-Web-EOLD123-CloudFront-4xx",
  ]) {
    assert.doesNotMatch(unrelatedArn, alarmPattern);
  }
  assert.doesNotMatch(
    JSON.stringify(EXPECTED_RUNTIME_BOUNDARY_POLICY),
    /\$\{CLOUDFRONT_(?:ALARM_ARN_PATTERN|DISTRIBUTION_ARN)\}/,
  );
});

test("runtime boundary fixtures prove the exact Task 5 Registry broker permissions", () => {
  const statements = new Map(
    EXPECTED_RUNTIME_BOUNDARY_POLICY.Statement.map((statement) => [
      statement.Sid,
      statement,
    ]),
  );
  assert.deepEqual(statements.get("CreatePlatformDomainRegistry"), {
    Sid: "CreatePlatformDomainRegistry",
    Effect: "Allow",
    Action: ["agent-registry:CreateRegistry"],
    Resource: ["*"],
    Condition: {
      "ForAllValues:StringEquals": {
        "aws:TagKeys": ["auto-delete", "managedBy", "project"],
      },
      StringEquals: {
        "aws:RequestTag/auto-delete": "no",
        "aws:RequestTag/managedBy": "cdk",
        "aws:RequestTag/project": "agentic-ai-platform-demo",
        "aws:RequestedRegion": REGION,
      },
    },
  });
  assert.deepEqual(statements.get("TagPlatformDomainRegistry"), {
    Sid: "TagPlatformDomainRegistry",
    Effect: "Allow",
    Action: ["agent-registry:TagResource"],
    Resource: [ACCOUNT_REGISTRY_ARN],
    Condition: regionalArnRequestTagCondition("cdk"),
  });
  assert.deepEqual(
    statements.get("CreateHostedAcceptanceDomainRegistry"),
    {
      Sid: "CreateHostedAcceptanceDomainRegistry",
      Effect: "Allow",
      Action: ["agent-registry:CreateRegistry"],
      Resource: ["*"],
      Condition: registryRequestTagCondition("hosted-acceptance"),
    },
  );
  assert.deepEqual(
    statements.get("TagHostedAcceptanceDomainRegistry"),
    {
      Sid: "TagHostedAcceptanceDomainRegistry",
      Effect: "Allow",
      Action: ["agent-registry:TagResource"],
      Resource: [ACCOUNT_REGISTRY_ARN],
      Condition: regionalArnRequestTagCondition("hosted-acceptance"),
    },
  );
  assert.deepEqual(statements.get("ReadHostedAcceptanceDomainRegistry"), {
    Sid: "ReadHostedAcceptanceDomainRegistry",
    Effect: "Allow",
    Action: [
      "agent-registry:GetRegistry",
      "agent-registry:ListTagsForResource",
    ],
    Resource: [ACCOUNT_REGISTRY_ARN],
  });
  assert.deepEqual(statements.get("DeleteHostedAcceptanceDomainRegistry"), {
    Sid: "DeleteHostedAcceptanceDomainRegistry",
    Effect: "Allow",
    Action: ["agent-registry:DeleteRegistry"],
    Resource: [ACCOUNT_REGISTRY_ARN],
    Condition: regionalArnResourceTagCondition([
      "cdk",
      "hosted-acceptance",
    ]),
  });
  assert.doesNotMatch(
    JSON.stringify(statements.get("ReadHostedAcceptanceDomainRegistry")),
    /aws:ResourceTag/,
  );
  assert.doesNotMatch(
    JSON.stringify(statements.get("TagHostedAcceptanceDomainRegistry")),
    /aws:ResourceTag/,
  );

  assert.deepEqual(statements.get("ListControlPlaneRegistries"), {
    Sid: "ListControlPlaneRegistries",
    Effect: "Allow",
    Action: ["agent-registry:ListRegistryRecords"],
    Resource: [
      CONTROL_PLANE_ARNS.sharedRegistryArn,
      CONTROL_PLANE_ARNS.platformRegistryArn,
      CONTROL_PLANE_ARNS.customerSupportRegistryArn,
      CONTROL_PLANE_ARNS.operationsRegistryArn,
    ],
  });
  assert.deepEqual(statements.get("ReadControlPlaneRegistryRecords"), {
    Sid: "ReadControlPlaneRegistryRecords",
    Effect: "Allow",
    Action: [
      "agent-registry:GetDiscoverableRegistryRecord",
      "agent-registry:GetRegistryRecord",
      "agent-registry:UpdateRegistryRecordStatus",
    ],
    Resource: [
      `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
      `${CONTROL_PLANE_ARNS.platformRegistryArn}/record/*`,
      `${CONTROL_PLANE_ARNS.customerSupportRegistryArn}/record/*`,
      `${CONTROL_PLANE_ARNS.operationsRegistryArn}/record/*`,
    ],
  });
  assert.deepEqual(statements.get("ListDynamicControlPlaneRegistries"), {
    Sid: "ListDynamicControlPlaneRegistries",
    Effect: "Allow",
    Action: ["agent-registry:ListRegistryRecords"],
    Resource: [ACCOUNT_REGISTRY_ARN],
    Condition: regionalArnResourceTagCondition([
      "cdk",
      "hosted-acceptance",
    ]),
  });
  assert.deepEqual(
    statements.get("ReadDynamicControlPlaneRegistryRecords"),
    {
    Sid: "ReadDynamicControlPlaneRegistryRecords",
    Effect: "Allow",
    Action: [
      "agent-registry:GetDiscoverableRegistryRecord",
      "agent-registry:GetRegistryRecord",
      "agent-registry:UpdateRegistryRecordStatus",
      ],
      Resource: [ACCOUNT_REGISTRY_RECORD_ARN],
      Condition: regionalArnResourceTagCondition([
        "cdk",
        "hosted-acceptance",
      ]),
    },
  );
  assert.deepEqual(statements.get("ReadControlPlaneToolsGateway"), {
    Sid: "ReadControlPlaneToolsGateway",
    Effect: "Allow",
    Action: [
      "bedrock-agentcore:GetGatewayTarget",
      "bedrock-agentcore:ListGatewayTargets",
    ],
    Resource: [CONTROL_PLANE_ARNS.toolsGatewayArn],
  });
  assert.deepEqual(statements.get("InvokeControlPlaneLlmGateway"), {
    Sid: "InvokeControlPlaneLlmGateway",
    Effect: "Allow",
    Action: ["bedrock-agentcore:InvokeGateway"],
    Resource: [CONTROL_PLANE_ARNS.llmGatewayArn],
    Condition: {
      ArnEquals: {
        "aws:PrincipalArn": GATEWAY_INVOKER_ROLE_ARN,
      },
    },
  });
  assert.deepEqual(statements.get("AssumeGatewayInvokerRole"), {
    Sid: "AssumeGatewayInvokerRole",
    Effect: "Allow",
    Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
    Resource: [GATEWAY_INVOKER_ROLE_ARN],
  });
  assert.deepEqual(statements.get("ReadRuntimeInvocationProofSecret"), {
    Sid: "ReadRuntimeInvocationProofSecret",
    Effect: "Allow",
    Action: ["secretsmanager:GetSecretValue"],
    Resource: [RUNTIME_INVOCATION_PROOF_SECRET_ARN],
  });
  assert.deepEqual(statements.get("WriteRuntimeInvocationProofSecret"), {
    Sid: "WriteRuntimeInvocationProofSecret",
    Effect: "Allow",
    Action: ["secretsmanager:PutSecretValue"],
    Resource: [RUNTIME_INVOCATION_PROOF_SECRET_ARN],
    Condition: {
      ArnEquals: {
        "aws:PrincipalArn": RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN,
      },
    },
  });
  assert.deepEqual(statements.get("ReadPlatformState"), {
    Sid: "ReadPlatformState",
    Effect: "Allow",
    Action: ["dynamodb:GetItem", "dynamodb:Query"],
    Resource: [PLATFORM_STATE_TABLE_ARN],
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": [
          "AGENT#*",
          "APPROVAL#*",
          "AUDIT#*",
          "BREAK_GLASS",
          "DEPLOYMENT#*",
          "DELIVERY#*",
          "DOMAIN",
          "ENTITLEMENT#*",
          "EXPERIENCE_INVOCATION#*",
          "GITHUB_AUTHORIZATION#*",
          "GRANT#*",
          "GUARDRAIL_EXCEPTION#*",
          "CATALOG_VISIBILITY#platform",
          "HITL_POLICY#platform",
          "ALERT_POLICY#platform",
          "INCIDENT#*",
          "JOURNEY#*",
          "MODEL_POLICY",
          "MODEL_POLICY_AUDIT#*",
          "MUTATION#*",
          "PROJECT#*",
          "REGISTRY_RECORD#*",
          "REQUEST#*",
          "SESSION#*",
          "SUBMISSION#*",
        ],
      },
    },
  });
  assert.deepEqual(statements.get("ReadPlatformAuditMetadata"), {
    Sid: "ReadPlatformAuditMetadata",
    Effect: "Allow",
    Action: ["dynamodb:Query"],
    Resource: [
      `${PLATFORM_STATE_TABLE_ARN}/index/EntityTypeIndex`,
    ],
  });
  assert.deepEqual(statements.get("WritePlatformState"), {
    Sid: "WritePlatformState",
    Effect: "Allow",
    Action: ["dynamodb:PutItem"],
    Resource: [PLATFORM_STATE_TABLE_ARN],
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": [
          "AGENT#*",
          "APPROVAL#*",
          "AUDIT#*",
          "BREAK_GLASS",
          "DEPLOYMENT#*",
          "DELIVERY#*",
          "DOMAIN",
          "ENTITLEMENT#*",
          "EXPERIENCE_INVOCATION#*",
          "GITHUB_AUTHORIZATION#*",
          "GRANT#*",
          "GUARDRAIL_EXCEPTION#*",
          "CATALOG_VISIBILITY#platform",
          "HITL_POLICY#platform",
          "ALERT_POLICY#platform",
          "INCIDENT#*",
          "JOURNEY#*",
          "MODEL_POLICY",
          "MODEL_POLICY_AUDIT#*",
          "MUTATION#*",
          "PROJECT#*",
          "REGISTRY_RECORD#*",
          "REQUEST#*",
          "SESSION#*",
          "SUBMISSION#*",
        ],
      },
    },
  });
  assert.deepEqual(statements.get("UpdateExperienceInvocation"), {
    Sid: "UpdateExperienceInvocation",
    Effect: "Allow",
    Action: ["dynamodb:UpdateItem"],
    Resource: [PLATFORM_STATE_TABLE_ARN],
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": [
          "DELIVERY#*",
          "EXPERIENCE_INVOCATION#*",
          "GITHUB_AUTHORIZATION#*",
          "MUTATION#*",
          "PROJECT#*",
        ],
      },
    },
  });
  assert.deepEqual(statements.get("InvokeRegistryDecisionFinalizer"), {
    Sid: "InvokeRegistryDecisionFinalizer",
    Effect: "Allow",
    Action: ["lambda:GetFunction", "lambda:InvokeFunction"],
    Resource: [
      REGISTRY_DECISION_FINALIZER_FUNCTION_ARN,
      RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN,
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(EXPECTED_RUNTIME_BOUNDARY_POLICY),
    /\$\{(?:SHARED|PLATFORM|CUSTOMER_SUPPORT|OPERATIONS|LLM|TOOLS)_[^}]+\}/,
  );
});

function reorderedBoundaryPolicy(policy = EXPECTED_RUNTIME_BOUNDARY_POLICY) {
  return {
    Statement: [...policy.Statement].reverse().map((statement) => ({
      Resource: Array.isArray(statement.Resource)
        ? [...statement.Resource].reverse()
        : statement.Resource,
      Action: Array.isArray(statement.Action)
        ? [...statement.Action].reverse()
        : statement.Action,
      ...(statement.Condition === undefined
        ? {}
        : { Condition: structuredClone(statement.Condition) }),
      Effect: statement.Effect,
      Sid: statement.Sid,
    })),
    Version: policy.Version,
  };
}

function scalarBoundaryPolicy() {
  const policy = structuredClone(EXPECTED_RUNTIME_BOUNDARY_POLICY);
  policy.Statement = policy.Statement.map((statement) => ({
    ...statement,
    Action: statement.Action.length === 1
      ? statement.Action[0]
      : statement.Action,
    Resource: statement.Resource.length === 1
      ? statement.Resource[0]
      : statement.Resource,
  }));
  return policy;
}

function githubEnabledEnvironment(overrides = {}) {
  return {
    ENABLE_GITHUB_DEPLOYMENT: "true",
    BRANCH_PROTECTION_ATTESTED: "true",
    CONTROL_PLANE_MODE: "reference-existing",
    CONTROL_PLANE_SHARED_REGISTRY_ID:
      CONTROL_PLANE_IDS.sharedRegistryId,
    CONTROL_PLANE_REGISTRY_PLATFORM_ID:
      CONTROL_PLANE_IDS.registryPlatformId,
    CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID:
      CONTROL_PLANE_IDS.registryCustomerSupportId,
    CONTROL_PLANE_REGISTRY_OPERATIONS_ID:
      CONTROL_PLANE_IDS.registryOperationsId,
    CONTROL_PLANE_LLM_GATEWAY_ID: CONTROL_PLANE_IDS.llmGatewayId,
    CONTROL_PLANE_LLM_GATEWAY_REGION:
      CONTROL_PLANE_IDS.llmGatewayRegion,
    CONTROL_PLANE_TOOLS_GATEWAY_ID: CONTROL_PLANE_IDS.toolsGatewayId,
    GITHUB_REPOSITORY_ID: REPOSITORY_ID,
    GITHUB_REPOSITORY_OWNER_ID: REPOSITORY_OWNER_ID,
    GITHUB_WORKFLOW_REF: WORKFLOW_REF,
    GITHUB_OIDC_SUBJECT_MODE: "legacy",
    GITHUB_OIDC_SUBJECT: LEGACY_SUBJECT,
    ...overrides,
  };
}

function journeyOAuthEnvironment(overrides = {}) {
  return githubEnabledEnvironment({
    JOURNEY_GITHUB_OAUTH_CLIENT_ID:
      JOURNEY_GITHUB_OAUTH_CLIENT_ID,
    JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN:
      JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN,
    ...overrides,
  });
}

function provisionedControlPlaneEnvironment(overrides = {}) {
  return githubEnabledEnvironment({
    CONTROL_PLANE_MODE: "provision",
    CONTROL_PLANE_SHARED_REGISTRY_ID: "",
    CONTROL_PLANE_REGISTRY_PLATFORM_ID: "",
    CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID: "",
    CONTROL_PLANE_REGISTRY_OPERATIONS_ID: "",
    CONTROL_PLANE_LLM_GATEWAY_ID: "",
    CONTROL_PLANE_LLM_GATEWAY_REGION: "",
    CONTROL_PLANE_TOOLS_GATEWAY_ID: "",
    ...overrides,
  });
}

function manualPostdeployEnvironment(overrides = {}) {
  return {
    SECURITY_AUDIT_MODE: "postdeploy",
    CONTROL_PLANE_MODE: "reference-existing",
    CONTROL_PLANE_SHARED_REGISTRY_ID:
      CONTROL_PLANE_IDS.sharedRegistryId,
    CONTROL_PLANE_REGISTRY_PLATFORM_ID:
      CONTROL_PLANE_IDS.registryPlatformId,
    CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID:
      CONTROL_PLANE_IDS.registryCustomerSupportId,
    CONTROL_PLANE_REGISTRY_OPERATIONS_ID:
      CONTROL_PLANE_IDS.registryOperationsId,
    CONTROL_PLANE_LLM_GATEWAY_ID: CONTROL_PLANE_IDS.llmGatewayId,
    CONTROL_PLANE_LLM_GATEWAY_REGION:
      CONTROL_PLANE_IDS.llmGatewayRegion,
    CONTROL_PLANE_TOOLS_GATEWAY_ID: CONTROL_PLANE_IDS.toolsGatewayId,
    ...overrides,
  };
}

function runtimeRoleCommand(roleName) {
  return [
    "aws",
    "iam",
    "get-role",
    "--role-name",
    roleName,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function roleListAttachedPoliciesCommand(roleName) {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    roleName,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function roleListPoliciesCommand(roleName) {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    roleName,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function roleGetPolicyCommand(roleName, policyName) {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    roleName,
    "--policy-name",
    policyName,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function identityRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    IDENTITY_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function identityRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    IDENTITY_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function identityRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    IDENTITY_ROLE_NAME,
    "--policy-name",
    IDENTITY_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function identityRoleGetXrayPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    IDENTITY_ROLE_NAME,
    "--policy-name",
    IDENTITY_XRAY_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function governanceRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    GOVERNANCE_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function governanceRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    GOVERNANCE_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function governanceRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    GOVERNANCE_ROLE_NAME,
    "--policy-name",
    GOVERNANCE_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function governanceRoleGetXrayPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    GOVERNANCE_ROLE_NAME,
    "--policy-name",
    GOVERNANCE_XRAY_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function workspaceRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    WORKSPACE_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function workspaceRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    WORKSPACE_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function workspaceRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    WORKSPACE_ROLE_NAME,
    "--policy-name",
    WORKSPACE_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function workspaceRoleGetXrayPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    WORKSPACE_ROLE_NAME,
    "--policy-name",
    WORKSPACE_XRAY_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function seedRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    PLATFORM_STATE_SEED_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function seedRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    PLATFORM_STATE_SEED_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function seedRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    PLATFORM_STATE_SEED_ROLE_NAME,
    "--policy-name",
    PLATFORM_STATE_SEED_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function workspaceSeedRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    PLATFORM_WORKSPACE_SEED_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function workspaceSeedRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    PLATFORM_WORKSPACE_SEED_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function workspaceSeedRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    PLATFORM_WORKSPACE_SEED_ROLE_NAME,
    "--policy-name",
    PLATFORM_WORKSPACE_SEED_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function finalizerRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    REGISTRY_DECISION_FINALIZER_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function finalizerRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    REGISTRY_DECISION_FINALIZER_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function finalizerRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    REGISTRY_DECISION_FINALIZER_ROLE_NAME,
    "--policy-name",
    REGISTRY_DECISION_FINALIZER_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function adminRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    PLATFORM_ADMIN_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function adminRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    PLATFORM_ADMIN_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function adminRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    PLATFORM_ADMIN_ROLE_NAME,
    "--policy-name",
    PLATFORM_ADMIN_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function controlPlaneReadRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    CONTROL_PLANE_READ_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function controlPlaneReadRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    CONTROL_PLANE_READ_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function controlPlaneReadRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    CONTROL_PLANE_READ_ROLE_NAME,
    "--policy-name",
    CONTROL_PLANE_READ_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function controlPlaneReadRoleGetXrayPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    CONTROL_PLANE_READ_ROLE_NAME,
    "--policy-name",
    CONTROL_PLANE_READ_XRAY_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function brokerRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function brokerRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function brokerRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    "--policy-name",
    HOSTED_ACCEPTANCE_BROKER_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function hostedAcceptanceRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    HOSTED_ACCEPTANCE_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function hostedAcceptanceRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    HOSTED_ACCEPTANCE_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function hostedAcceptanceRoleGetPolicyCommand() {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    HOSTED_ACCEPTANCE_ROLE_NAME,
    "--policy-name",
    HOSTED_ACCEPTANCE_POLICY_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function runtimeBoundaryVersionCommand(versionId) {
  return [
    "aws",
    "iam",
    "get-policy-version",
    "--policy-arn",
    RUNTIME_BOUNDARY_ARN,
    "--version-id",
    versionId,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function controlPlaneRuntimeBoundaryVersionCommand(versionId) {
  return [
    "aws",
    "iam",
    "get-policy-version",
    "--policy-arn",
    CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
    "--version-id",
    versionId,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function executionRoleCommand() {
  return runtimeRoleCommand(CLOUDFORMATION_EXECUTION_ROLE_NAME);
}

function executionRoleListAttachedPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-attached-role-policies",
    "--role-name",
    CLOUDFORMATION_EXECUTION_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function executionRoleListPoliciesCommand() {
  return [
    "aws",
    "iam",
    "list-role-policies",
    "--role-name",
    CLOUDFORMATION_EXECUTION_ROLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function executionRoleGetPolicyCommand(policyName) {
  return [
    "aws",
    "iam",
    "get-role-policy",
    "--role-name",
    CLOUDFORMATION_EXECUTION_ROLE_NAME,
    "--policy-name",
    policyName,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function managedPolicyGetCommand(policyName) {
  return [
    "aws",
    "iam",
    "get-policy",
    "--policy-arn",
    `arn:aws:iam::${ACCOUNT_ID}:policy/${policyName}`,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

function managedPolicyVersionCommand(policyName, versionId = "v1") {
  return [
    "aws",
    "iam",
    "get-policy-version",
    "--policy-arn",
    `arn:aws:iam::${ACCOUNT_ID}:policy/${policyName}`,
    "--version-id",
    versionId,
    "--region",
    REGION,
    "--output",
    "json",
  ];
}

const COMMANDS = {
  origin: ["git", "remote", "get-url", "origin"],
  caller: [
    "aws",
    "sts",
    "get-caller-identity",
    "--region",
    REGION,
    "--output",
    "json",
  ],
  oidcList: [
    "aws",
    "iam",
    "list-open-id-connect-providers",
    "--region",
    REGION,
    "--output",
    "json",
  ],
  oidcGet: [
    "aws",
    "iam",
    "get-open-id-connect-provider",
    "--open-id-connect-provider-arn",
    OIDC_ARN,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  toolkit: [
    "aws",
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "CDKToolkit",
    "--region",
    REGION,
    "--output",
    "json",
  ],
  bootstrapVersion: [
    "aws",
    "ssm",
    "get-parameter",
    "--name",
    BOOTSTRAP_PARAMETER,
    "--region",
    REGION,
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ],
  controlPlane: [
    "aws",
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    CONTROL_PLANE_STACK_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  webStack: [
    "aws",
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "AgenticPlatform-Web",
    "--region",
    REGION,
    "--output",
    "json",
  ],
  boundaryGet: [
    "aws",
    "iam",
    "get-policy",
    "--policy-arn",
    RUNTIME_BOUNDARY_ARN,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  boundaryVersion: runtimeBoundaryVersionCommand("v3"),
  boundaryTags: [
    "aws",
    "iam",
    "list-policy-tags",
    "--policy-arn",
    RUNTIME_BOUNDARY_ARN,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  controlPlaneBoundaryGet: [
    "aws",
    "iam",
    "get-policy",
    "--policy-arn",
    CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  controlPlaneBoundaryVersion:
    controlPlaneRuntimeBoundaryVersionCommand("v1"),
  controlPlaneBoundaryTags: [
    "aws",
    "iam",
    "list-policy-tags",
    "--policy-arn",
    CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  provisionedControlPlane: [
    "aws",
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    PROVISIONED_CONTROL_PLANE_STACK_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  provisionedControlPlaneResources: [
    "aws",
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    PROVISIONED_CONTROL_PLANE_STACK_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ],
  webResources: [
    "aws",
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    "AgenticPlatform-Web",
    "--region",
    REGION,
    "--output",
    "json",
  ],
  platformStateTtl: [
    "aws",
    "dynamodb",
    "describe-time-to-live",
    "--table-name",
    PLATFORM_STATE_TABLE_NAME,
    "--region",
    REGION,
    "--output",
    "json",
  ],
};

function controlPlaneStackDocument({
  mode = "reference-existing",
  outputOverrides = {},
  tags = REQUIRED_BOUNDARY_TAGS,
} = {}) {
  const stackName = mode === "provision"
    ? PROVISIONED_CONTROL_PLANE_STACK_NAME
    : CONTROL_PLANE_STACK_NAME;
  const outputValues = {
    SharedRegistryId: CONTROL_PLANE_IDS.sharedRegistryId,
    RegistryPlatformId: CONTROL_PLANE_IDS.registryPlatformId,
    RegistryCustomerSupportId:
      CONTROL_PLANE_IDS.registryCustomerSupportId,
    RegistryOperationsId: CONTROL_PLANE_IDS.registryOperationsId,
    LlmGatewayId: CONTROL_PLANE_IDS.llmGatewayId,
    LlmGatewayRegion: CONTROL_PLANE_IDS.llmGatewayRegion,
    ToolsGatewayId: CONTROL_PLANE_IDS.toolsGatewayId,
    ...outputOverrides,
  };
  const exportNames = {
    SharedRegistryId:
      "AgenticPlatform-ControlPlane-SharedRegistryId",
    RegistryPlatformId:
      "AgenticPlatform-ControlPlane-Registry-platform-Id",
    RegistryCustomerSupportId:
      "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
    RegistryOperationsId:
      "AgenticPlatform-ControlPlane-Registry-operations-Id",
    LlmGatewayId:
      "AgenticPlatform-ControlPlane-LlmGatewayId",
    LlmGatewayRegion:
      "AgenticPlatform-ControlPlane-LlmGatewayRegion",
    ToolsGatewayId:
      "AgenticPlatform-ControlPlane-ToolsGatewayId",
  };

  return {
    Stacks: [{
      StackName: stackName,
      Outputs: Object.entries(outputValues).map(([OutputKey, OutputValue]) => ({
        ExportName: exportNames[OutputKey],
        OutputKey,
        OutputValue,
      })),
      Tags: tags,
    }],
  };
}

function key(command, ...args) {
  const normalizedArgs =
    args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return [command, ...normalizedArgs].join("\u0000");
}

function baseResponses() {
  return new Map([
    [key(...COMMANDS.origin), "git@github.com:example-org/example-repo.git\n"],
    [
      key(...COMMANDS.caller),
      JSON.stringify({
        Account: ACCOUNT_ID,
        Arn: CALLER_ARN,
        UserId: "deployment-session",
      }),
    ],
    [
      key(...COMMANDS.oidcList),
      JSON.stringify({
        OpenIDConnectProviderList: [{ Arn: OIDC_ARN }],
      }),
    ],
    [
      key(...COMMANDS.oidcGet),
      JSON.stringify({
        Url: "token.actions.githubusercontent.com",
        ClientIDList: ["sts.amazonaws.com"],
        ThumbprintList: ["thumbprint"],
      }),
    ],
    [
      key(...COMMANDS.toolkit),
      JSON.stringify({
        Stacks: [{
          StackName: "CDKToolkit",
          EnableTerminationProtection: true,
          Outputs: [{ OutputKey: "BootstrapVersion", OutputValue: "21" }],
        }],
      }),
    ],
    [key(...COMMANDS.bootstrapVersion), "21\n"],
  ]);
}

function absentToolkitResponses() {
  const responses = baseResponses();
  responses.set(
    key(...COMMANDS.toolkit),
    new AuditCommandError("aws", COMMANDS.toolkit.slice(1), {
      status: 255,
      stderr:
        "An error occurred (ValidationError) when calling the "
        + "DescribeStacks operation: Stack with id CDKToolkit does not exist",
    }),
  );
  responses.delete(key(...COMMANDS.bootstrapVersion));
  return responses;
}

function addControlPlaneBootstrapSecurityResponses(responses) {
  responses.set(
    key(...COMMANDS.controlPlaneBoundaryGet),
    JSON.stringify({
      Policy: {
        Arn: CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v1",
        PolicyName: CONTROL_PLANE_RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.set(
    key(...COMMANDS.controlPlaneBoundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document: CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v1",
      },
    }),
  );
  responses.set(
    key(...COMMANDS.controlPlaneBoundaryTags),
    JSON.stringify({
      IsTruncated: false,
      Tags: REQUIRED_BOUNDARY_TAGS,
    }),
  );
  responses.set(
    key(...executionRoleCommand()),
    JSON.stringify({
      Role: {
        Arn: CLOUDFORMATION_EXECUTION_ROLE_ARN,
        AssumeRolePolicyDocument:
          CLOUDFORMATION_EXECUTION_ROLE_TRUST_POLICY,
        RoleName: CLOUDFORMATION_EXECUTION_ROLE_NAME,
      },
    }),
  );
  responses.set(
    key(...executionRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: CONTROL_PLANE_EXECUTION_POLICY_NAMES.map(
        (PolicyName) => ({
          PolicyArn:
            `arn:aws:iam::${ACCOUNT_ID}:policy/${PolicyName}`,
          PolicyName,
        }),
      ),
      IsTruncated: false,
    }),
  );
  const inlinePolicyName = CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME;
  responses.set(
    key(...executionRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [inlinePolicyName],
    }),
  );
  responses.set(
    key(...executionRoleGetPolicyCommand(inlinePolicyName)),
    JSON.stringify({
      PolicyDocument:
        EXPECTED_CONTROL_PLANE_EXECUTION_POLICIES.inlinePolicy,
      PolicyName: inlinePolicyName,
      RoleName: CLOUDFORMATION_EXECUTION_ROLE_NAME,
    }),
  );
  for (const policyName of CONTROL_PLANE_EXECUTION_POLICY_NAMES) {
    responses.set(
      key(...managedPolicyGetCommand(policyName)),
      JSON.stringify({
        Policy: {
          Arn: `arn:aws:iam::${ACCOUNT_ID}:policy/${policyName}`,
          DefaultVersionId: "v1",
          PolicyName: policyName,
        },
      }),
    );
    responses.set(
      key(...managedPolicyVersionCommand(policyName)),
      JSON.stringify({
        PolicyVersion: {
          Document:
            EXPECTED_CONTROL_PLANE_EXECUTION_POLICIES.managedPolicies.get(
              policyName,
            ),
          IsDefaultVersion: true,
          VersionId: "v1",
        },
      }),
    );
  }
  return responses;
}

function addExactInlineRoleResponses(responses, {
  policies,
  roleName,
}) {
  responses.set(
    key(...roleListAttachedPoliciesCommand(roleName)),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...roleListPoliciesCommand(roleName)),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: Object.keys(policies),
    }),
  );
  for (const [policyName, policyDocument] of Object.entries(policies)) {
    responses.set(
      key(...roleGetPolicyCommand(roleName, policyName)),
      JSON.stringify({
        PolicyDocument: policyDocument,
        PolicyName: policyName,
        RoleName: roleName,
      }),
    );
  }
  return responses;
}

function missingRoleResponse(roleName) {
  const command = runtimeRoleCommand(roleName);
  return new AuditCommandError("aws", command.slice(1), {
    status: 254,
    stderr:
      "An error occurred (NoSuchEntity) when calling the GetRole "
      + `operation: The role with name ${roleName} cannot be found.`,
  });
}

function githubEnabledResponses() {
  const responses = addControlPlaneBootstrapSecurityResponses(
    baseResponses(),
  );
  responses.set(
    key(...COMMANDS.controlPlane),
    JSON.stringify(controlPlaneStackDocument()),
  );
  responses.set(
    key(...COMMANDS.webStack),
    JSON.stringify({
      Stacks: [{
        Outputs: [
          {
            OutputKey: "UserPoolId",
            OutputValue: USER_POOL_ID,
          },
          {
            OutputKey: "HostedAcceptanceBrokerFunctionArn",
            OutputValue: HOSTED_ACCEPTANCE_BROKER_FUNCTION_ARN,
          },
        ],
        StackName: "AgenticPlatform-Web",
      }],
    }),
  );
  responses.set(
    key(...COMMANDS.webResources),
    JSON.stringify({
      StackResources: [
        {
          LogicalResourceId: "Distribution830FAC52",
          PhysicalResourceId: CLOUDFRONT_DISTRIBUTION_ID,
          ResourceType: "AWS::CloudFront::Distribution",
        },
        {
          LogicalResourceId: "CloudFront5xxAlarm",
          PhysicalResourceId: CLOUDFRONT_ALARM_NAME,
          ResourceType: "Custom::CloudFrontAlarm",
        },
        {
          LogicalResourceId: "PlatformStateTable",
          PhysicalResourceId: PLATFORM_STATE_TABLE_NAME,
          ResourceType: "AWS::DynamoDB::Table",
        },
        {
          LogicalResourceId: "IdentityApiLogs",
          PhysicalResourceId: IDENTITY_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "GovernanceApiLogs",
          PhysicalResourceId: GOVERNANCE_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "ModelGovernanceApiLogs",
          PhysicalResourceId: MODEL_GOVERNANCE_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "BuilderApiLogs",
          PhysicalResourceId: BUILDER_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "JourneyApiLogs",
          PhysicalResourceId: JOURNEY_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "ExperienceApiLogs",
          PhysicalResourceId: EXPERIENCE_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "WorkspaceApiLogs",
          PhysicalResourceId: WORKSPACE_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "AccessAdminApiLogs",
          PhysicalResourceId: ACCESS_ADMIN_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "PlatformStateSeedLogs",
          PhysicalResourceId: PLATFORM_STATE_SEED_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "RuntimeProofConfiguratorLogs34CC1EB8",
          PhysicalResourceId:
            RUNTIME_PROOF_CONFIGURATOR_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "RuntimeProofProviderLogs2BF47004",
          PhysicalResourceId: RUNTIME_PROOF_PROVIDER_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "PlatformAdminApiLogs",
          PhysicalResourceId: PLATFORM_ADMIN_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "ControlPlaneReadApiLogs",
          PhysicalResourceId: CONTROL_PLANE_READ_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "RegistryDecisionFinalizerLogs",
          PhysicalResourceId:
            REGISTRY_DECISION_FINALIZER_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "HostedAcceptanceBrokerLogs",
          PhysicalResourceId:
            HOSTED_ACCEPTANCE_BROKER_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        },
        {
          LogicalResourceId: "UserPool6BA7E5F2",
          PhysicalResourceId: USER_POOL_ID,
          ResourceType: "AWS::Cognito::UserPool",
        },
        {
          LogicalResourceId: "HostedAcceptanceBrokerFunction4C320540",
          PhysicalResourceId: HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME,
          ResourceType: "AWS::Lambda::Function",
        },
        {
          LogicalResourceId:
            "RuntimeProofConfiguratorFunctionC49E3577",
          PhysicalResourceId:
            RUNTIME_PROOF_CONFIGURATOR_FUNCTION_NAME,
          ResourceType: "AWS::Lambda::Function",
        },
        {
          LogicalResourceId: "GovernedAgentRuntime6E767EC6",
          PhysicalResourceId: AGENT_RUNTIME_ID,
          ResourceType: "AWS::BedrockAgentCore::Runtime",
        },
        {
          LogicalResourceId:
            "GovernedAgentRuntimeEndpointProductionCE79AE1A",
          PhysicalResourceId: AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN,
          ResourceType: "AWS::BedrockAgentCore::RuntimeEndpoint",
        },
        {
          LogicalResourceId:
            "GovernedAgentRuntimeEndpointSandboxF5272A38",
          PhysicalResourceId:
            `${AGENT_RUNTIME_EXACT_ARN}/runtime-endpoint/Sandbox`,
          ResourceType: "AWS::BedrockAgentCore::RuntimeEndpoint",
        },
        {
          LogicalResourceId:
            "RuntimeInvocationProofSecret551AA3CA",
          PhysicalResourceId: RUNTIME_INVOCATION_PROOF_SECRET_ARN,
          ResourceType: "AWS::SecretsManager::Secret",
        },
      ],
    }),
  );
  responses.set(
    key(...COMMANDS.platformStateTtl),
    JSON.stringify({
      TimeToLiveDescription: {
        AttributeName: "expiresAt",
        TimeToLiveStatus: "ENABLED",
      },
    }),
  );
  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v3",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.set(
    key(...COMMANDS.boundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document: EXPECTED_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  );
  responses.set(
    key(...COMMANDS.boundaryTags),
    JSON.stringify({
      IsTruncated: false,
      Tags: REQUIRED_BOUNDARY_TAGS,
    }),
  );
  for (const roleName of RUNTIME_ROLE_NAMES) {
    responses.set(
      key(...runtimeRoleCommand(roleName)),
      JSON.stringify({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
          ...(
            roleName === GATEWAY_INVOKER_ROLE_NAME
            || roleName === AGENT_RUNTIME_ROLE_NAME
            || roleName === BUILDER_ROLE_NAME
            || roleName === JOURNEY_ROLE_NAME
            || roleName === EXPERIENCE_ROLE_NAME
            || roleName === MODEL_GOVERNANCE_ROLE_NAME
            || roleName === PLATFORM_STATE_SEED_ROLE_NAME
            || roleName === "AgenticPlatform-Web-PlatformAgentRegistrySeedRole"
            || roleName === PLATFORM_WORKSPACE_SEED_ROLE_NAME
            || roleName === PLATFORM_ADMIN_ROLE_NAME
            || roleName === IDENTITY_ROLE_NAME
            || roleName === GOVERNANCE_ROLE_NAME
            || roleName === WORKSPACE_ROLE_NAME
            || roleName === ACCESS_ADMIN_ROLE_NAME
            || roleName === CONTROL_PLANE_READ_ROLE_NAME
            || roleName === REGISTRY_DECISION_FINALIZER_ROLE_NAME
            || roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME
            || roleName === RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME
            || roleName === RUNTIME_PROOF_PROVIDER_ROLE_NAME
            ? {
              AssumeRolePolicyDocument:
                roleName === GATEWAY_INVOKER_ROLE_NAME
                  ? GATEWAY_INVOKER_TRUST_POLICY
                  : roleName === AGENT_RUNTIME_ROLE_NAME
                  ? AGENT_RUNTIME_TRUST_POLICY
                  : LAMBDA_TRUST_POLICY,
            }
            : {}),
          PermissionsBoundary: {
            PermissionsBoundaryArn: RUNTIME_BOUNDARY_ARN,
            PermissionsBoundaryType: "Policy",
          },
          RoleName: roleName,
        },
      }),
    );
  }
  responses.set(
    key(...runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME)),
    JSON.stringify({
      Role: {
        Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${HOSTED_ACCEPTANCE_ROLE_NAME}`,
        AssumeRolePolicyDocument: HOSTED_ACCEPTANCE_TRUST_POLICY,
        RoleName: HOSTED_ACCEPTANCE_ROLE_NAME,
      },
    }),
  );
  addExactInlineRoleResponses(responses, {
    roleName: GATEWAY_INVOKER_ROLE_NAME,
    policies: {
      [GATEWAY_INVOKER_POLICY_NAME]: GATEWAY_INVOKER_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: BUILDER_ROLE_NAME,
    policies: {
      [BUILDER_POLICY_NAME]: BUILDER_INLINE_POLICY,
      [BUILDER_XRAY_POLICY_NAME]: BUILDER_XRAY_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: JOURNEY_ROLE_NAME,
    policies: {
      [JOURNEY_POLICY_NAME]: JOURNEY_INLINE_POLICY,
      [JOURNEY_DEFAULT_POLICY_NAME]: JOURNEY_DEFAULT_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: AGENT_RUNTIME_ROLE_NAME,
    policies: {
      [AGENT_RUNTIME_POLICY_NAME]: AGENT_RUNTIME_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: MODEL_GOVERNANCE_ROLE_NAME,
    policies: {
      [MODEL_GOVERNANCE_POLICY_NAME]: MODEL_GOVERNANCE_INLINE_POLICY,
      [MODEL_GOVERNANCE_XRAY_POLICY_NAME]:
        MODEL_GOVERNANCE_XRAY_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: EXPERIENCE_ROLE_NAME,
    policies: {
      [EXPERIENCE_POLICY_NAME]: EXPERIENCE_INLINE_POLICY,
      [EXPERIENCE_XRAY_POLICY_NAME]: EXPERIENCE_XRAY_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: ACCESS_ADMIN_ROLE_NAME,
    policies: {
      [ACCESS_ADMIN_POLICY_NAME]: ACCESS_ADMIN_INLINE_POLICY,
      [ACCESS_ADMIN_XRAY_POLICY_NAME]:
        ACCESS_ADMIN_XRAY_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
    policies: {
      [RUNTIME_PROOF_CONFIGURATOR_POLICY_NAME]:
        RUNTIME_PROOF_CONFIGURATOR_INLINE_POLICY,
    },
  });
  addExactInlineRoleResponses(responses, {
    roleName: RUNTIME_PROOF_PROVIDER_ROLE_NAME,
    policies: {
      [RUNTIME_PROOF_PROVIDER_LOG_POLICY_NAME]:
        RUNTIME_PROOF_PROVIDER_LOG_INLINE_POLICY,
      [RUNTIME_PROOF_PROVIDER_DEFAULT_POLICY_NAME]:
        RUNTIME_PROOF_PROVIDER_DEFAULT_INLINE_POLICY,
    },
  });
  responses.set(
    key(...identityRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...identityRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [
        IDENTITY_POLICY_NAME,
        IDENTITY_XRAY_POLICY_NAME,
      ],
    }),
  );
  responses.set(
    key(...identityRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: IDENTITY_TARGET_INLINE_POLICY,
      PolicyName: IDENTITY_POLICY_NAME,
      RoleName: IDENTITY_ROLE_NAME,
    }),
  );
  responses.set(
    key(...identityRoleGetXrayPolicyCommand()),
    JSON.stringify({
      PolicyDocument: IDENTITY_XRAY_INLINE_POLICY,
      PolicyName: IDENTITY_XRAY_POLICY_NAME,
      RoleName: IDENTITY_ROLE_NAME,
    }),
  );
  responses.set(
    key(...governanceRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...governanceRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [
        GOVERNANCE_POLICY_NAME,
        GOVERNANCE_XRAY_POLICY_NAME,
      ],
    }),
  );
  responses.set(
    key(...governanceRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: GOVERNANCE_INLINE_POLICY,
      PolicyName: GOVERNANCE_POLICY_NAME,
      RoleName: GOVERNANCE_ROLE_NAME,
    }),
  );
  responses.set(
    key(...governanceRoleGetXrayPolicyCommand()),
    JSON.stringify({
      PolicyDocument: GOVERNANCE_XRAY_INLINE_POLICY,
      PolicyName: GOVERNANCE_XRAY_POLICY_NAME,
      RoleName: GOVERNANCE_ROLE_NAME,
    }),
  );
  responses.set(
    key(...workspaceRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...workspaceRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [
        WORKSPACE_POLICY_NAME,
        WORKSPACE_XRAY_POLICY_NAME,
      ],
    }),
  );
  responses.set(
    key(...workspaceRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: WORKSPACE_INLINE_POLICY,
      PolicyName: WORKSPACE_POLICY_NAME,
      RoleName: WORKSPACE_ROLE_NAME,
    }),
  );
  responses.set(
    key(...workspaceRoleGetXrayPolicyCommand()),
    JSON.stringify({
      PolicyDocument: WORKSPACE_XRAY_INLINE_POLICY,
      PolicyName: WORKSPACE_XRAY_POLICY_NAME,
      RoleName: WORKSPACE_ROLE_NAME,
    }),
  );
  responses.set(
    key(...seedRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...seedRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [PLATFORM_STATE_SEED_POLICY_NAME],
    }),
  );
  responses.set(
    key(...seedRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: PLATFORM_STATE_SEED_INLINE_POLICY,
      PolicyName: PLATFORM_STATE_SEED_POLICY_NAME,
      RoleName: PLATFORM_STATE_SEED_ROLE_NAME,
    }),
  );
  responses.set(
    key(...workspaceSeedRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...workspaceSeedRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [PLATFORM_WORKSPACE_SEED_POLICY_NAME],
    }),
  );
  responses.set(
    key(...workspaceSeedRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: PLATFORM_WORKSPACE_SEED_INLINE_POLICY,
      PolicyName: PLATFORM_WORKSPACE_SEED_POLICY_NAME,
      RoleName: PLATFORM_WORKSPACE_SEED_ROLE_NAME,
    }),
  );
  responses.set(
    key(...adminRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...adminRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [PLATFORM_ADMIN_POLICY_NAME],
    }),
  );
  responses.set(
    key(...adminRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: PLATFORM_ADMIN_TARGET_INLINE_POLICY,
      PolicyName: PLATFORM_ADMIN_POLICY_NAME,
      RoleName: PLATFORM_ADMIN_ROLE_NAME,
    }),
  );
  responses.set(
    key(...controlPlaneReadRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...controlPlaneReadRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [
        CONTROL_PLANE_READ_POLICY_NAME,
        CONTROL_PLANE_READ_XRAY_POLICY_NAME,
      ],
    }),
  );
  responses.set(
    key(...controlPlaneReadRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: CONTROL_PLANE_READ_INLINE_POLICY,
      PolicyName: CONTROL_PLANE_READ_POLICY_NAME,
      RoleName: CONTROL_PLANE_READ_ROLE_NAME,
    }),
  );
  responses.set(
    key(...controlPlaneReadRoleGetXrayPolicyCommand()),
    JSON.stringify({
      PolicyDocument: CONTROL_PLANE_READ_XRAY_INLINE_POLICY,
      PolicyName: CONTROL_PLANE_READ_XRAY_POLICY_NAME,
      RoleName: CONTROL_PLANE_READ_ROLE_NAME,
    }),
  );
  responses.set(
    key(...finalizerRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...finalizerRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [REGISTRY_DECISION_FINALIZER_POLICY_NAME],
    }),
  );
  responses.set(
    key(...finalizerRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: REGISTRY_DECISION_FINALIZER_INLINE_POLICY,
      PolicyName: REGISTRY_DECISION_FINALIZER_POLICY_NAME,
      RoleName: REGISTRY_DECISION_FINALIZER_ROLE_NAME,
    }),
  );
  responses.set(
    key(...brokerRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...brokerRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [HOSTED_ACCEPTANCE_BROKER_POLICY_NAME],
    }),
  );
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY,
      PolicyName: HOSTED_ACCEPTANCE_BROKER_POLICY_NAME,
      RoleName: HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    }),
  );
  responses.set(
    key(...hostedAcceptanceRoleListAttachedPoliciesCommand()),
    JSON.stringify({
      AttachedPolicies: [],
      IsTruncated: false,
    }),
  );
  responses.set(
    key(...hostedAcceptanceRoleListPoliciesCommand()),
    JSON.stringify({
      IsTruncated: false,
      PolicyNames: [HOSTED_ACCEPTANCE_POLICY_NAME],
    }),
  );
  responses.set(
    key(...hostedAcceptanceRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: HOSTED_ACCEPTANCE_INLINE_POLICY,
      PolicyName: HOSTED_ACCEPTANCE_POLICY_NAME,
      RoleName: HOSTED_ACCEPTANCE_ROLE_NAME,
    }),
  );
  return responses;
}

function journeyOAuthResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.boundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document: JOURNEY_OAUTH_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  );
  responses.set(
    key(...roleGetPolicyCommand(
      JOURNEY_ROLE_NAME,
      JOURNEY_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument: JOURNEY_OAUTH_INLINE_POLICY,
      PolicyName: JOURNEY_POLICY_NAME,
      RoleName: JOURNEY_ROLE_NAME,
    }),
  );
  return responses;
}

function journeyBoundaryPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.boundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document: JOURNEY_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  );
  return responses;
}

function provisionedControlPlaneResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.provisionedControlPlane),
    JSON.stringify(controlPlaneStackDocument({ mode: "provision" })),
  );
  responses.set(
    key(...COMMANDS.provisionedControlPlaneResources),
    JSON.stringify({
      StackResourceSummaries:
        PROVISIONED_CONTROL_PLANE_ROLE_FIXTURES.map(
          ({ logicalResourceId, roleName }) => ({
            LogicalResourceId: logicalResourceId,
            PhysicalResourceId: roleName,
            ResourceStatus: "CREATE_COMPLETE",
            ResourceType: "AWS::IAM::Role",
          }),
        ),
    }),
  );
  for (const {
    roleName,
    service,
  } of PROVISIONED_CONTROL_PLANE_ROLE_FIXTURES) {
    const trust = {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: service },
        Action: "sts:AssumeRole",
        ...(service === "bedrock-agentcore.amazonaws.com"
          ? {
            Condition: {
              StringEquals: {
                "aws:SourceAccount": ACCOUNT_ID,
              },
              ArnLike: {
                "aws:SourceArn":
                  `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
                  + "gateway/*",
              },
            },
          }
          : {}),
      }],
    };
    responses.set(
      key(...runtimeRoleCommand(roleName)),
      JSON.stringify({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${roleName}`,
          AssumeRolePolicyDocument: trust,
          PermissionsBoundary: {
            PermissionsBoundaryArn:
              CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
            PermissionsBoundaryType: "Policy",
          },
          RoleName: roleName,
          Tags: REQUIRED_BOUNDARY_TAGS,
        },
      }),
    );
  }
  return responses;
}

function task1PredecessorResponses({
  includePlatformAdminRole = false,
  includePlatformStateSeedRole = false,
  includePlatformStateTable = false,
} = {}) {
  const responses = githubEnabledResponses();
  const finalizerRoleCommand =
    runtimeRoleCommand(REGISTRY_DECISION_FINALIZER_ROLE_NAME);
  responses.set(
    key(...finalizerRoleCommand),
    new AuditCommandError("aws", finalizerRoleCommand.slice(1), {
      status: 254,
      stderr:
        "An error occurred (NoSuchEntity) when calling the GetRole "
        + "operation: The role with name "
        + `${REGISTRY_DECISION_FINALIZER_ROLE_NAME} cannot be found.`,
    }),
  );
  const brokerRoleCommand =
    runtimeRoleCommand(HOSTED_ACCEPTANCE_BROKER_ROLE_NAME);
  responses.set(
    key(...brokerRoleCommand),
    new AuditCommandError("aws", brokerRoleCommand.slice(1), {
      status: 254,
      stderr:
        "An error occurred (NoSuchEntity) when calling the GetRole "
        + "operation: The role with name "
        + `${HOSTED_ACCEPTANCE_BROKER_ROLE_NAME} cannot be found.`,
    }),
  );
  const hostedAcceptanceRoleCommand =
    runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME);
  responses.set(
    key(...hostedAcceptanceRoleCommand),
    new AuditCommandError(
      "aws",
      hostedAcceptanceRoleCommand.slice(1),
      {
        status: 254,
        stderr:
          "An error occurred (NoSuchEntity) when calling the GetRole "
          + "operation: The role with name "
          + `${HOSTED_ACCEPTANCE_ROLE_NAME} cannot be found.`,
      },
    ),
  );
  const oldResources = JSON.parse(
    responses.get(key(...COMMANDS.webResources)),
  );
  oldResources.StackResources = oldResources.StackResources.filter(
    ({ LogicalResourceId }) =>
      !LogicalResourceId.startsWith("RegistryDecisionFinalizerLogs"),
  );
  oldResources.StackResources = oldResources.StackResources.filter(
    ({ LogicalResourceId }) =>
      !LogicalResourceId.startsWith("HostedAcceptanceBrokerLogs"),
  );
  oldResources.StackResources = oldResources.StackResources.filter(
    ({ LogicalResourceId }) =>
      !LogicalResourceId.startsWith("HostedAcceptanceBrokerFunction"),
  );
  responses.set(
    key(...COMMANDS.webResources),
    JSON.stringify(oldResources),
  );
  const oldStack = JSON.parse(responses.get(key(...COMMANDS.webStack)));
  oldStack.Stacks[0].Outputs = oldStack.Stacks[0].Outputs.filter(
    ({ OutputKey }) =>
      OutputKey !== "HostedAcceptanceBrokerFunctionArn",
  );
  responses.set(key(...COMMANDS.webStack), JSON.stringify(oldStack));
  if (!includePlatformAdminRole) {
    const command = runtimeRoleCommand(PLATFORM_ADMIN_ROLE_NAME);
    responses.set(
      key(...command),
      new AuditCommandError("aws", command.slice(1), {
        status: 254,
        stderr:
          "An error occurred (NoSuchEntity) when calling the GetRole "
          + `operation: The role with name ${PLATFORM_ADMIN_ROLE_NAME} `
          + "cannot be found.",
      }),
    );
  }
  if (!includePlatformStateSeedRole) {
    const command = runtimeRoleCommand(PLATFORM_STATE_SEED_ROLE_NAME);
    responses.set(
      key(...command),
      new AuditCommandError("aws", command.slice(1), {
        status: 254,
        stderr:
          "An error occurred (NoSuchEntity) when calling the GetRole "
          + `operation: The role with name ${PLATFORM_STATE_SEED_ROLE_NAME} `
          + "cannot be found.",
      }),
    );
  }
  if (!includePlatformStateTable) {
    const document = JSON.parse(responses.get(key(...COMMANDS.webResources)));
    document.StackResources = document.StackResources.filter(
      ({ ResourceType }) => ResourceType !== "AWS::DynamoDB::Table",
    );
    responses.set(key(...COMMANDS.webResources), JSON.stringify(document));
  } else {
    responses.set(
      key(...COMMANDS.platformStateTtl),
      JSON.stringify({
        TimeToLiveDescription: {
          TimeToLiveStatus: "DISABLED",
        },
      }),
    );
  }

  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v2",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.delete(key(...COMMANDS.boundaryVersion));
  responses.set(
    key(...runtimeBoundaryVersionCommand("v2")),
    JSON.stringify({
      PolicyVersion: {
        Document: TASK1_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v2",
      },
    }),
  );
  return responses;
}

function task3PredecessorResponses() {
  const responses = githubEnabledResponses();
  const finalizerRoleCommand =
    runtimeRoleCommand(REGISTRY_DECISION_FINALIZER_ROLE_NAME);
  responses.set(
    key(...finalizerRoleCommand),
    new AuditCommandError("aws", finalizerRoleCommand.slice(1), {
      status: 254,
      stderr:
        "An error occurred (NoSuchEntity) when calling the GetRole "
        + "operation: The role with name "
        + `${REGISTRY_DECISION_FINALIZER_ROLE_NAME} cannot be found.`,
    }),
  );
  const brokerRoleCommand =
    runtimeRoleCommand(HOSTED_ACCEPTANCE_BROKER_ROLE_NAME);
  responses.set(
    key(...brokerRoleCommand),
    new AuditCommandError("aws", brokerRoleCommand.slice(1), {
      status: 254,
      stderr:
        "An error occurred (NoSuchEntity) when calling the GetRole "
        + "operation: The role with name "
        + `${HOSTED_ACCEPTANCE_BROKER_ROLE_NAME} cannot be found.`,
    }),
  );
  const hostedAcceptanceRoleCommand =
    runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME);
  responses.set(
    key(...hostedAcceptanceRoleCommand),
    new AuditCommandError(
      "aws",
      hostedAcceptanceRoleCommand.slice(1),
      {
        status: 254,
        stderr:
          "An error occurred (NoSuchEntity) when calling the GetRole "
          + "operation: The role with name "
          + `${HOSTED_ACCEPTANCE_ROLE_NAME} cannot be found.`,
      },
    ),
  );
  const webResources = JSON.parse(
    responses.get(key(...COMMANDS.webResources)),
  );
  webResources.StackResources = webResources.StackResources.filter(
    ({ LogicalResourceId }) =>
      !LogicalResourceId.startsWith("RegistryDecisionFinalizerLogs"),
  );
  webResources.StackResources = webResources.StackResources.filter(
    ({ LogicalResourceId }) =>
      !LogicalResourceId.startsWith("HostedAcceptanceBrokerLogs"),
  );
  webResources.StackResources = webResources.StackResources.filter(
    ({ LogicalResourceId }) =>
      !LogicalResourceId.startsWith("HostedAcceptanceBrokerFunction"),
  );
  responses.set(
    key(...COMMANDS.webResources),
    JSON.stringify(webResources),
  );
  const webStack = JSON.parse(responses.get(key(...COMMANDS.webStack)));
  webStack.Stacks[0].Outputs = webStack.Stacks[0].Outputs.filter(
    ({ OutputKey }) =>
      OutputKey !== "HostedAcceptanceBrokerFunctionArn",
  );
  responses.set(key(...COMMANDS.webStack), JSON.stringify(webStack));
  responses.set(
    key(...adminRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: PLATFORM_ADMIN_PREDECESSOR_INLINE_POLICY,
      PolicyName: PLATFORM_ADMIN_POLICY_NAME,
      RoleName: PLATFORM_ADMIN_ROLE_NAME,
    }),
  );
  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v2",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.delete(key(...COMMANDS.boundaryVersion));
  responses.set(
    key(...runtimeBoundaryVersionCommand("v2")),
    JSON.stringify({
      PolicyVersion: {
        Document: TASK3_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v2",
      },
    }),
  );
  return responses;
}

function gatewayIsolationPredecessorResponses() {
  const responses = githubEnabledResponses();
  const resources = JSON.parse(
    responses.get(key(...COMMANDS.webResources)),
  );
  resources.StackResources = resources.StackResources.filter(
    ({ LogicalResourceId }) =>
      LogicalResourceId !== "ModelGovernanceApiLogs"
      && LogicalResourceId !== "RuntimeInvocationProofSecret551AA3CA"
      && !LogicalResourceId.startsWith("RuntimeProofConfiguratorFunction")
      && !LogicalResourceId.startsWith("RuntimeProofConfiguratorLogs")
      && !LogicalResourceId.startsWith("RuntimeProofProviderLogs"),
  );
  responses.set(
    key(...COMMANDS.webResources),
    JSON.stringify(resources),
  );

  for (const roleName of [
    GATEWAY_INVOKER_ROLE_NAME,
    MODEL_GOVERNANCE_ROLE_NAME,
    RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
    RUNTIME_PROOF_PROVIDER_ROLE_NAME,
  ]) {
    const command = runtimeRoleCommand(roleName);
    responses.set(
      key(...command),
      missingRoleResponse(roleName),
    );
  }

  responses.set(
    key(...roleGetPolicyCommand(
      JOURNEY_ROLE_NAME,
      JOURNEY_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument: JOURNEY_PREDECESSOR_INLINE_POLICY,
      PolicyName: JOURNEY_POLICY_NAME,
      RoleName: JOURNEY_ROLE_NAME,
    }),
  );
  responses.set(
    key(...roleGetPolicyCommand(
      BUILDER_ROLE_NAME,
      BUILDER_XRAY_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument: BUILDER_GATEWAY_PREDECESSOR_XRAY_INLINE_POLICY,
      PolicyName: BUILDER_XRAY_POLICY_NAME,
      RoleName: BUILDER_ROLE_NAME,
    }),
  );
  responses.set(
    key(...roleGetPolicyCommand(
      AGENT_RUNTIME_ROLE_NAME,
      AGENT_RUNTIME_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument: AGENT_RUNTIME_GATEWAY_PREDECESSOR_INLINE_POLICY,
      PolicyName: AGENT_RUNTIME_POLICY_NAME,
      RoleName: AGENT_RUNTIME_ROLE_NAME,
    }),
  );
  responses.set(
    key(...roleGetPolicyCommand(
      EXPERIENCE_ROLE_NAME,
      EXPERIENCE_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument: EXPERIENCE_GATEWAY_PREDECESSOR_INLINE_POLICY,
      PolicyName: EXPERIENCE_POLICY_NAME,
      RoleName: EXPERIENCE_ROLE_NAME,
    }),
  );
  responses.set(
    key(...controlPlaneReadRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument:
        CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_INLINE_POLICY,
      PolicyName: CONTROL_PLANE_READ_POLICY_NAME,
      RoleName: CONTROL_PLANE_READ_ROLE_NAME,
    }),
  );
  responses.set(
    key(...controlPlaneReadRoleGetXrayPolicyCommand()),
    JSON.stringify({
      PolicyDocument:
        CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_XRAY_INLINE_POLICY,
      PolicyName: CONTROL_PLANE_READ_XRAY_POLICY_NAME,
      RoleName: CONTROL_PLANE_READ_ROLE_NAME,
    }),
  );
  responses.set(
    key(...COMMANDS.boundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document:
          GATEWAY_ISOLATION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  );
  return responses;
}

function builderModelPolicyReadPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...roleGetPolicyCommand(
      BUILDER_ROLE_NAME,
      BUILDER_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument:
        BUILDER_MODEL_POLICY_READ_PREDECESSOR_INLINE_POLICY,
      PolicyName: BUILDER_POLICY_NAME,
      RoleName: BUILDER_ROLE_NAME,
    }),
  );
  return responses;
}

function builderResourceAuthorizationPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...roleGetPolicyCommand(
      BUILDER_ROLE_NAME,
      BUILDER_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument:
        BUILDER_RESOURCE_AUTH_PREDECESSOR_INLINE_POLICY,
      PolicyName: BUILDER_POLICY_NAME,
      RoleName: BUILDER_ROLE_NAME,
    }),
  );
  return responses;
}

function builderDomainGetPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...roleGetPolicyCommand(
      BUILDER_ROLE_NAME,
      BUILDER_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument:
        BUILDER_DOMAIN_GET_PREDECESSOR_INLINE_POLICY,
      PolicyName: BUILDER_POLICY_NAME,
      RoleName: BUILDER_ROLE_NAME,
    }),
  );
  return responses;
}

function invocationJournalPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v2",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.delete(key(...COMMANDS.boundaryVersion));
  responses.set(
    key(...runtimeBoundaryVersionCommand("v2")),
    JSON.stringify({
      PolicyVersion: {
        Document: INVOCATION_JOURNAL_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v2",
      },
    }),
  );
  return responses;
}

function batchReadPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v2",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.delete(key(...COMMANDS.boundaryVersion));
  responses.set(
    key(...runtimeBoundaryVersionCommand("v2")),
    JSON.stringify({
      PolicyVersion: {
        Document: BATCH_GET_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v2",
      },
    }),
  );
  return responses;
}

function discoverableResourcePredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v2",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.delete(key(...COMMANDS.boundaryVersion));
  responses.set(
    key(...runtimeBoundaryVersionCommand("v2")),
    JSON.stringify({
      PolicyVersion: {
        Document:
          DISCOVERABLE_RESOURCE_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v2",
      },
    }),
  );
  return responses;
}

function deleteConditionPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v2",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.delete(key(...COMMANDS.boundaryVersion));
  responses.set(
    key(...runtimeBoundaryVersionCommand("v2")),
    JSON.stringify({
      PolicyVersion: {
        Document: DELETE_CONDITION_PREDECESSOR_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v2",
      },
    }),
  );
  return responses;
}

function transactionAuthorizationPredecessorResponses() {
  const responses = githubEnabledResponses();
  responses.set(
    key(...COMMANDS.boundaryGet),
    JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "v2",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  );
  responses.delete(key(...COMMANDS.boundaryVersion));
  responses.set(
    key(...runtimeBoundaryVersionCommand("v2")),
    JSON.stringify({
      PolicyVersion: {
        Document:
          LEGACY_TRANSACTION_AUTHORIZATION_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: true,
        VersionId: "v2",
      },
    }),
  );
  return responses;
}

function toolkitResponses({
  bootstrapVersion = 21,
  outputVersion = bootstrapVersion,
  terminationProtection = true,
} = {}) {
  const responses = baseResponses();
  responses.set(
    key(...COMMANDS.toolkit),
    JSON.stringify({
      Stacks: [{
        StackName: "CDKToolkit",
        EnableTerminationProtection: terminationProtection,
        Outputs: [{
          OutputKey: "BootstrapVersion",
          OutputValue: String(outputVersion),
        }],
      }],
    }),
  );
  responses.set(
    key(...COMMANDS.bootstrapVersion),
    `${bootstrapVersion}\n`,
  );
  return responses;
}

function fixture({
  env = {},
  responses = baseResponses(),
  now = new Date("2026-08-22T01:02:03.456Z"),
} = {}) {
  const calls = [];
  const evidenceWrites = [];
  const runCommand = (command, args, options = {}) => {
    calls.push({ command, args, options });
    const response = responses.get(key(command, args));
    if (response instanceof Error) {
      throw response;
    }
    assert.notEqual(
      response,
      undefined,
      `unexpected command: ${command} ${args.join(" ")}`,
    );
    return response;
  };
  const writeEvidence = ({ filename, evidence }) => {
    evidenceWrites.push({ filename, evidence });
    return `/evidence/${filename}`;
  };

  return {
    calls,
    evidenceWrites,
    options: {
      cwd: "/workspace/repository/infra/serverless-platform",
      env: {
        AWS_ACCOUNT_ID: ACCOUNT_ID,
        AWS_REGION: REGION,
        GITHUB_REPOSITORY: REPOSITORY,
        ...env,
      },
      now: () => now,
      runCommand,
      writeEvidence,
    },
  };
}

function assertAuditValidationCode(options, expectedCode) {
  assert.throws(
    () => auditPredeploy(options),
    (error) => {
      assert.equal(error?.name, "AuditValidationError");
      assert.equal(error?.code, expectedCode);
      return true;
    },
  );
}

test("normalizes supported GitHub origin URLs and rejects other remotes", () => {
  for (const remote of [
    "https://github.com/example-org/example-repo.git",
    "git@github.com:example-org/example-repo.git",
    "ssh://git@github.com/example-org/example-repo.git",
  ]) {
    assert.equal(normalizeGitHubRepositoryRemote(remote), REPOSITORY);
  }

  for (const remote of [
    "http://github.com/example-org/example-repo.git",
    "https://gitlab.com/example-org/example-repo.git",
    "https://user:password@github.com/example-org/example-repo.git",
    "git@github.com:example-org/example-repo/extra.git",
    "<owner/repo>",
  ]) {
    assert.throws(
      () => normalizeGitHubRepositoryRemote(remote),
      /supported GitHub HTTPS or SSH origin/,
    );
  }
});

test("package exposes the executable pre-deployment audit", () => {
  assert.equal(
    packageDocument.scripts["security:audit"],
    "node scripts/predeploy-security-audit.mjs",
  );
  assert.match(readFileSync(auditScriptUrl, "utf8"), /^#!\/usr\/bin\/env node\n/);
  assert.notEqual(
    statSync(auditScriptUrl).mode & 0o111,
    0,
    "pre-deployment audit must be executable",
  );
});

test("passes with exact target, non-root caller, valid OIDC, and protected bootstrap", () => {
  const { calls, evidenceWrites, options } = fixture();

  const result = auditPredeploy(options);

  assert.equal(result.evidence.status, "passed");
  assert.equal(
    result.evidencePath,
    "/evidence/predeploy-security-audit-2026-08-22T01-02-03-456Z.json",
  );
  assert.deepEqual(
    result.evidence.target,
    {
      accountId: "********3333",
      region: REGION,
      repository: REPOSITORY,
    },
  );
  assert.deepEqual(result.evidence.repository, {
    originMatches: true,
    normalizedOrigin: REPOSITORY,
  });
  assert.deepEqual(result.evidence.caller, {
    accountMatches: true,
    principalType: "assumed-role",
  });
  assert.deepEqual(result.evidence.githubOidc, {
    audiencePresent: true,
    providerCount: 1,
    status: "present",
    url: "token.actions.githubusercontent.com",
  });
  assert.deepEqual(result.evidence.cdkToolkit, {
    bootstrapVersion: 21,
    compliant: true,
    issues: [],
    status: "present",
    terminationProtection: true,
  });
  assert.deepEqual(result.evidence.audit, {
    branchProtectionAttested: false,
    githubDeploymentEnabled: false,
    mode: "deploy",
    remediationApproved: false,
  });
  assert.deepEqual(result.evidence.runtimeRoles, {
    boundaryName: RUNTIME_BOUNDARY_NAME,
    required: false,
    roles: [],
    status: "not-required",
  });
  assert.equal(
    calls.some(({ args }) =>
      args[0] === "iam" && args[1] === "get-role"
    ),
    false,
  );
  assert.equal(evidenceWrites.length, 1);
  assert.equal(
    evidenceWrites[0].filename,
    "predeploy-security-audit-2026-08-22T01-02-03-456Z.json",
  );
  assert.deepEqual(evidenceWrites[0].evidence, result.evidence);
  assert.equal(
    calls.every(({ options: commandOptions }) =>
      commandOptions.cwd === options.cwd
    ),
    true,
  );

  const serializedEvidence = JSON.stringify(result.evidence);
  assert.doesNotMatch(serializedEvidence, new RegExp(ACCOUNT_ID));
  assert.doesNotMatch(
    serializedEvidence,
    /password|access[_-]?token|refresh[_-]?token|client[_-]?secret/i,
  );
});

test("bootstrap-new reports an absent OIDC provider and CDKToolkit", () => {
  const responses = absentToolkitResponses();
  responses.set(
    key(...COMMANDS.oidcList),
    JSON.stringify({ OpenIDConnectProviderList: [] }),
  );
  responses.delete(key(...COMMANDS.oidcGet));
  const { evidenceWrites, options } = fixture({
    env: { SECURITY_AUDIT_MODE: "bootstrap-new" },
    responses,
  });

  const result = auditPredeploy(options);

  assert.deepEqual(result.evidence.githubOidc, {
    audiencePresent: null,
    providerCount: 0,
    status: "absent",
    url: null,
  });
  assert.deepEqual(result.evidence.cdkToolkit, {
    bootstrapVersion: null,
    compliant: null,
    issues: [],
    status: "absent",
    terminationProtection: null,
  });
  assert.deepEqual(result.evidence.audit, {
    branchProtectionAttested: false,
    githubDeploymentEnabled: false,
    mode: "bootstrap-new",
    remediationApproved: false,
  });
  assert.equal(evidenceWrites[0].evidence.status, "passed");
});

test("deploy mode requires an existing compliant CDKToolkit", () => {
  const { evidenceWrites, options } = fixture({
    responses: absentToolkitResponses(),
  });

  assert.throws(
    () => auditPredeploy(options),
    /deploy mode requires an existing compliant CDKToolkit/,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
  assert.deepEqual(evidenceWrites[0].evidence.cdkToolkit, {
    bootstrapVersion: null,
    compliant: null,
    issues: [],
    status: "absent",
    terminationProtection: null,
  });
});

test("GitHub deployment enablement fails closed without branch-protection attestation", () => {
  const { evidenceWrites, options } = fixture({
    env: { ENABLE_GITHUB_DEPLOYMENT: "true" },
  });

  assert.throws(
    () => auditPredeploy(options),
    /BRANCH_PROTECTION_ATTESTED=true/,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
  assert.deepEqual(evidenceWrites[0].evidence.audit, {
    branchProtectionAttested: false,
    githubDeploymentEnabled: true,
    mode: "deploy",
    remediationApproved: false,
  });
});

test("GitHub deployment audit requires exact boolean deployment flags", () => {
  for (const [name, value] of [
    ["ENABLE_GITHUB_DEPLOYMENT", "TRUE"],
    ["ENABLE_GITHUB_DEPLOYMENT", "yes"],
    ["ENABLE_GITHUB_DEPLOYMENT", " false "],
    ["BRANCH_PROTECTION_ATTESTED", "TRUE"],
    ["BRANCH_PROTECTION_ATTESTED", "yes"],
    ["BRANCH_PROTECTION_ATTESTED", " false "],
  ]) {
    const { calls, evidenceWrites, options } = fixture({
      env: { [name]: value },
    });

    assert.throws(
      () => auditPredeploy(options),
      new RegExp(`${name}.*exactly true or false`),
    );
    assert.deepEqual(calls, [], `${name}=${value}`);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
  }

  const result = auditPredeploy(fixture({
    env: {
      ENABLE_GITHUB_DEPLOYMENT: "false",
      BRANCH_PROTECTION_ATTESTED: "false",
    },
  }).options);
  assert.equal(result.evidence.audit.githubDeploymentEnabled, false);
  assert.equal(result.evidence.audit.branchProtectionAttested, false);
});

test("GitHub deployment audit records explicit protected-main enablement", () => {
  const { calls, options } = fixture({
    env: githubEnabledEnvironment(),
    responses: githubEnabledResponses(),
  });

  const result = auditPredeploy(options);

  assert.deepEqual(result.evidence.audit, {
    branchProtectionAttested: true,
    githubDeploymentEnabled: true,
    mode: "deploy",
    remediationApproved: false,
  });
  assert.deepEqual(result.evidence.controlPlane, {
    mode: "reference-existing",
    outputsMatch: true,
    required: true,
    stackName: CONTROL_PLANE_STACK_NAME,
    status: "passed",
    tagsMatch: true,
  });
  assert.equal(
    result.evidence.controlPlaneRuntimeBoundary.arn,
    CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
  );
  assert.equal(
    result.evidence.controlPlaneRuntimeBoundary.tagsMatch,
    true,
  );
  assert.equal(
    result.evidence.controlPlaneRuntimeBoundary.policyMatches,
    true,
  );
  assert.equal(
    result.evidence.controlPlaneRuntimeBoundary.status,
    "passed",
  );
  assert.deepEqual(result.evidence.controlPlaneExecutionRole, {
    arnMatches: true,
    attachedPoliciesMatch: true,
    boundaryEnforcementMatches: true,
    required: true,
    roleName: CLOUDFORMATION_EXECUTION_ROLE_NAME,
    status: "passed",
    trustMatches: true,
  });
  assert.deepEqual(result.evidence.controlPlaneRuntimeRoles, {
    boundaryName: CONTROL_PLANE_RUNTIME_BOUNDARY_NAME,
    required: false,
    roles: [],
    status: "not-required",
  });
  assert.deepEqual(result.evidence.runtimeRoles, {
    boundaryName: RUNTIME_BOUNDARY_NAME,
    required: true,
    roles: [
      ...RUNTIME_ROLE_NAMES.map((roleName) => ({
        arnMatches: true,
        boundaryMatches: true,
        roleName,
        ...(
          roleName === PLATFORM_STATE_SEED_ROLE_NAME
          || roleName === PLATFORM_WORKSPACE_SEED_ROLE_NAME
          || roleName === GATEWAY_INVOKER_ROLE_NAME
          || roleName === MODEL_GOVERNANCE_ROLE_NAME
          || roleName === AGENT_RUNTIME_ROLE_NAME
          || roleName === BUILDER_ROLE_NAME
          || roleName === JOURNEY_ROLE_NAME
          || roleName === EXPERIENCE_ROLE_NAME
          || roleName === PLATFORM_ADMIN_ROLE_NAME
          || roleName === IDENTITY_ROLE_NAME
          || roleName === GOVERNANCE_ROLE_NAME
          || roleName === WORKSPACE_ROLE_NAME
          || roleName === ACCESS_ADMIN_ROLE_NAME
          || roleName === CONTROL_PLANE_READ_ROLE_NAME
          || roleName === REGISTRY_DECISION_FINALIZER_ROLE_NAME
          || roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME
          || roleName === RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME
          || roleName === RUNTIME_PROOF_PROVIDER_ROLE_NAME
          ? {
            attachedPoliciesAbsent: true,
            inlinePolicyMatches: true,
            trustMatches: true,
            ...(
              roleName === PLATFORM_ADMIN_ROLE_NAME
              || roleName === AGENT_RUNTIME_ROLE_NAME
              || roleName === BUILDER_ROLE_NAME
              || roleName === JOURNEY_ROLE_NAME
              || roleName === EXPERIENCE_ROLE_NAME
              || roleName === IDENTITY_ROLE_NAME
              || roleName === GOVERNANCE_ROLE_NAME
              || roleName === WORKSPACE_ROLE_NAME
              || roleName === ACCESS_ADMIN_ROLE_NAME
              || roleName === CONTROL_PLANE_READ_ROLE_NAME
              || roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME
              ? { acceptedPolicyState: "target" }
              : {}
            ),
          }
          : {}),
      })),
      {
        arnMatches: true,
        attachedPoliciesAbsent: true,
        boundaryAbsent: true,
        inlinePolicyMatches: true,
        roleName: HOSTED_ACCEPTANCE_ROLE_NAME,
        trustMatches: true,
      },
    ],
    status: "passed",
  });
  assert.deepEqual(result.evidence.runtimeBoundary, {
    acceptedState: "target",
    arn: RUNTIME_BOUNDARY_ARN,
    defaultVersionId: "v3",
    deployedHash: EXPECTED_RUNTIME_BOUNDARY_HASH,
    expectedHash: EXPECTED_RUNTIME_BOUNDARY_HASH,
    platformStateTableStatus: "present",
    platformStateTimeToLiveStatus: "enabled",
    required: true,
    status: "passed",
    tagsMatch: true,
  });
  assert.deepEqual(result.evidence.githubDeployment, {
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    subject: LEGACY_SUBJECT,
    subjectMode: "legacy",
    workflowRef: WORKFLOW_REF,
  });
  assert.deepEqual(
    calls
      .filter(({ args }) =>
        args[0] === "iam"
        && [
          "get-policy",
          "get-policy-version",
          "list-policy-tags",
        ].includes(args[1])
        && args.includes(RUNTIME_BOUNDARY_ARN)
      )
      .map(({ command, args }) => [command, ...args]),
    [
      COMMANDS.boundaryGet,
      COMMANDS.boundaryTags,
      COMMANDS.boundaryVersion,
    ],
  );
  assert.deepEqual(
    calls
      .filter(({ args }) =>
        args[0] === "iam"
        && args[1] === "get-role"
        && (
          RUNTIME_ROLE_NAMES.includes(
            args[args.indexOf("--role-name") + 1],
          )
          || args.includes(HOSTED_ACCEPTANCE_ROLE_NAME)
        )
      )
      .map(({ command, args }) => [command, ...args]),
    [
      ...RUNTIME_ROLE_NAMES.map(runtimeRoleCommand),
      runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
    ],
  );
  assert.ok(
    calls.some(({ command, args }) =>
      key(command, args) === key(...COMMANDS.webResources)
    ),
    "audit must resolve the exact stack distribution and alarm",
  );
  assert.ok(
    calls.some(({ command, args }) =>
      key(command, args) === key(...COMMANDS.controlPlane)
    ),
    "audit must validate the selected control-plane stack and exports",
  );
  for (const expectedCommand of [
    COMMANDS.platformStateTtl,
    roleListAttachedPoliciesCommand(GATEWAY_INVOKER_ROLE_NAME),
    roleListPoliciesCommand(GATEWAY_INVOKER_ROLE_NAME),
    roleGetPolicyCommand(
      GATEWAY_INVOKER_ROLE_NAME,
      GATEWAY_INVOKER_POLICY_NAME,
    ),
    roleListAttachedPoliciesCommand(BUILDER_ROLE_NAME),
    roleListPoliciesCommand(BUILDER_ROLE_NAME),
    roleGetPolicyCommand(BUILDER_ROLE_NAME, BUILDER_POLICY_NAME),
    roleGetPolicyCommand(BUILDER_ROLE_NAME, BUILDER_XRAY_POLICY_NAME),
    roleListAttachedPoliciesCommand(AGENT_RUNTIME_ROLE_NAME),
    roleListPoliciesCommand(AGENT_RUNTIME_ROLE_NAME),
    roleGetPolicyCommand(
      AGENT_RUNTIME_ROLE_NAME,
      AGENT_RUNTIME_POLICY_NAME,
    ),
    roleListAttachedPoliciesCommand(MODEL_GOVERNANCE_ROLE_NAME),
    roleListPoliciesCommand(MODEL_GOVERNANCE_ROLE_NAME),
    roleGetPolicyCommand(
      MODEL_GOVERNANCE_ROLE_NAME,
      MODEL_GOVERNANCE_POLICY_NAME,
    ),
    roleGetPolicyCommand(
      MODEL_GOVERNANCE_ROLE_NAME,
      MODEL_GOVERNANCE_XRAY_POLICY_NAME,
    ),
    roleListAttachedPoliciesCommand(EXPERIENCE_ROLE_NAME),
    roleListPoliciesCommand(EXPERIENCE_ROLE_NAME),
    roleGetPolicyCommand(EXPERIENCE_ROLE_NAME, EXPERIENCE_POLICY_NAME),
    roleGetPolicyCommand(
      EXPERIENCE_ROLE_NAME,
      EXPERIENCE_XRAY_POLICY_NAME,
    ),
    roleListAttachedPoliciesCommand(ACCESS_ADMIN_ROLE_NAME),
    roleListPoliciesCommand(ACCESS_ADMIN_ROLE_NAME),
    roleGetPolicyCommand(
      ACCESS_ADMIN_ROLE_NAME,
      ACCESS_ADMIN_POLICY_NAME,
    ),
    roleGetPolicyCommand(
      ACCESS_ADMIN_ROLE_NAME,
      ACCESS_ADMIN_XRAY_POLICY_NAME,
    ),
    roleListAttachedPoliciesCommand(
      RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
    ),
    roleListPoliciesCommand(RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME),
    roleGetPolicyCommand(
      RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
      RUNTIME_PROOF_CONFIGURATOR_POLICY_NAME,
    ),
    roleListAttachedPoliciesCommand(RUNTIME_PROOF_PROVIDER_ROLE_NAME),
    roleListPoliciesCommand(RUNTIME_PROOF_PROVIDER_ROLE_NAME),
    roleGetPolicyCommand(
      RUNTIME_PROOF_PROVIDER_ROLE_NAME,
      RUNTIME_PROOF_PROVIDER_LOG_POLICY_NAME,
    ),
    roleGetPolicyCommand(
      RUNTIME_PROOF_PROVIDER_ROLE_NAME,
      RUNTIME_PROOF_PROVIDER_DEFAULT_POLICY_NAME,
    ),
    identityRoleListAttachedPoliciesCommand(),
    identityRoleListPoliciesCommand(),
    identityRoleGetPolicyCommand(),
    identityRoleGetXrayPolicyCommand(),
    governanceRoleListAttachedPoliciesCommand(),
    governanceRoleListPoliciesCommand(),
    governanceRoleGetPolicyCommand(),
    governanceRoleGetXrayPolicyCommand(),
    workspaceRoleListAttachedPoliciesCommand(),
    workspaceRoleListPoliciesCommand(),
    workspaceRoleGetPolicyCommand(),
    workspaceRoleGetXrayPolicyCommand(),
    seedRoleListAttachedPoliciesCommand(),
    seedRoleListPoliciesCommand(),
    seedRoleGetPolicyCommand(),
    adminRoleListAttachedPoliciesCommand(),
    adminRoleListPoliciesCommand(),
    adminRoleGetPolicyCommand(),
    brokerRoleListAttachedPoliciesCommand(),
    brokerRoleListPoliciesCommand(),
    brokerRoleGetPolicyCommand(),
    hostedAcceptanceRoleListAttachedPoliciesCommand(),
    hostedAcceptanceRoleListPoliciesCommand(),
    hostedAcceptanceRoleGetPolicyCommand(),
  ]) {
    assert.ok(
      calls.some(({ command, args }) =>
        key(command, args) === key(...expectedCommand)
      ),
      expectedCommand.join(" "),
    );
  }
  for (const expectedCommand of [
    COMMANDS.controlPlaneBoundaryGet,
    COMMANDS.controlPlaneBoundaryTags,
    COMMANDS.controlPlaneBoundaryVersion,
    executionRoleCommand(),
    executionRoleListAttachedPoliciesCommand(),
    executionRoleListPoliciesCommand(),
  ]) {
    assert.ok(
      calls.some(({ command, args }) =>
        key(command, args) === key(...expectedCommand)
      ),
      expectedCommand.join(" "),
    );
  }
});

test("deploy accepts only the exact Gateway isolation predecessor and postdeploy requires the target", () => {
  const responses = gatewayIsolationPredecessorResponses();
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeBoundary.acceptedState,
    "gateway-isolation-predecessor",
  );
  for (const roleName of [
    GATEWAY_INVOKER_ROLE_NAME,
    MODEL_GOVERNANCE_ROLE_NAME,
  ]) {
    assert.deepEqual(
      deploy.evidence.runtimeRoles.roles.find(
        (role) => role.roleName === roleName,
      ),
      {
        roleName,
        status: "planned",
      },
    );
  }
  for (const roleName of [
    BUILDER_ROLE_NAME,
    AGENT_RUNTIME_ROLE_NAME,
    EXPERIENCE_ROLE_NAME,
  ]) {
    assert.equal(
      deploy.evidence.runtimeRoles.roles.find(
        (role) => role.roleName === roleName,
      ).acceptedPolicyState,
      "gateway-isolation-predecessor",
    );
  }
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === CONTROL_PLANE_READ_ROLE_NAME,
    ).acceptedPolicyState,
    "predecessor",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Runtime (?:invocation )?proof secret|post-deployment target state/i,
  );
});

test("deploy accepts only the exact Experience submission-replay predecessor and postdeploy requires the target", () => {
  const responses = githubEnabledResponses();
  responses.set(
    key(...roleGetPolicyCommand(
      EXPERIENCE_ROLE_NAME,
      EXPERIENCE_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument:
        EXPERIENCE_SUBMISSION_REPLAY_PREDECESSOR_INLINE_POLICY,
      PolicyName: EXPERIENCE_POLICY_NAME,
      RoleName: EXPERIENCE_ROLE_NAME,
    }),
  );

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === EXPERIENCE_ROLE_NAME,
    ).acceptedPolicyState,
    "submission-replay-predecessor",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Experience role/i,
  );
});

test("deploy accepts only the exact Builder read predecessor and postdeploy requires the target", () => {
  const responses = builderModelPolicyReadPredecessorResponses();
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === BUILDER_ROLE_NAME,
    ).acceptedPolicyState,
    "builder-read-predecessor",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Builder role/i,
  );
});

test("deploy accepts the exact Builder resource authorization predecessor and postdeploy requires the target", () => {
  const responses = builderResourceAuthorizationPredecessorResponses();
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === BUILDER_ROLE_NAME,
    ).acceptedPolicyState,
    "resource-authorization-predecessor",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Builder role/i,
  );
});

test("deploy accepts the exact Builder domain GetItem predecessor and postdeploy requires the target", () => {
  const responses = builderDomainGetPredecessorResponses();
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === BUILDER_ROLE_NAME,
    ).acceptedPolicyState,
    "domain-get-predecessor",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Builder role/i,
  );
});

test("deploy mode rejects obsolete runtime state older than Task 3", () => {
  const { evidenceWrites, options } = fixture({
    env: githubEnabledEnvironment(),
    responses: task1PredecessorResponses(),
  });

  assert.throws(
    () => auditPredeploy(options),
    /Task 3 predecessor|platform state table|runtime boundary|drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deploy accepts only the exact Task 3 predecessor and audits its effective admin role policy", () => {
  const { calls, options } = fixture({
    env: githubEnabledEnvironment(),
    responses: task3PredecessorResponses(),
  });

  const result = auditPredeploy(options);

  assert.equal(result.evidence.status, "passed");
  assert.equal(
    result.evidence.runtimeBoundary.acceptedState,
    "predecessor",
  );
  const adminRole = result.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === PLATFORM_ADMIN_ROLE_NAME,
  );
  assert.deepEqual(adminRole, {
    acceptedPolicyState: "predecessor",
    arnMatches: true,
    attachedPoliciesAbsent: true,
    boundaryMatches: true,
    inlinePolicyMatches: true,
    roleName: PLATFORM_ADMIN_ROLE_NAME,
    trustMatches: true,
  });
  assert.deepEqual(
    result.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_ROLE_NAME,
    ),
    {
      roleName: HOSTED_ACCEPTANCE_ROLE_NAME,
      status: "planned",
    },
  );
  for (const expectedCommand of [
    adminRoleListAttachedPoliciesCommand(),
    adminRoleListPoliciesCommand(),
    adminRoleGetPolicyCommand(),
  ]) {
    assert.ok(
      calls.some(({ command, args }) =>
        key(command, args) === key(...expectedCommand)
      ),
      expectedCommand.join(" "),
    );
  }
});

test("postdeploy rejects the exact Task 3 predecessor and requires the Task 5 target", () => {
  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: task3PredecessorResponses(),
    }).options),
    /target state|Task 5|runtime permissions boundary|platform admin|Registry decision finalizer|hosted acceptance broker/i,
  );

  const target = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "postdeploy",
    }),
    responses: githubEnabledResponses(),
  }).options);
  assert.equal(target.evidence.status, "passed");
  assert.equal(target.evidence.runtimeBoundary.acceptedState, "target");
  const adminRole = target.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === PLATFORM_ADMIN_ROLE_NAME,
  );
  assert.equal(adminRole.acceptedPolicyState, "target");
  const brokerRole = target.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
  );
  assert.deepEqual(brokerRole, {
    acceptedPolicyState: "target",
    arnMatches: true,
    attachedPoliciesAbsent: true,
    boundaryMatches: true,
    inlinePolicyMatches: true,
    roleName: HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    trustMatches: true,
  });
  const hostedAcceptanceRole = target.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === HOSTED_ACCEPTANCE_ROLE_NAME,
  );
  assert.deepEqual(hostedAcceptanceRole, {
    arnMatches: true,
    attachedPoliciesAbsent: true,
    boundaryAbsent: true,
    inlinePolicyMatches: true,
    roleName: HOSTED_ACCEPTANCE_ROLE_NAME,
    trustMatches: true,
  });
});

test("deploy and postdeploy require the exact domain owner-group policies", () => {
  const exactResponses = () => githubEnabledResponses();

  for (const mode of ["deploy", "postdeploy"]) {
    const result = auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: mode,
      }),
      responses: exactResponses(),
    }).options);
    assert.equal(result.evidence.status, "passed", mode);
  }

  const mutations = [
    {
      label: "platform admin missing CreateGroup",
      command: adminRoleGetPolicyCommand(),
      mutate(statement) {
        statement.Action = statement.Action.filter(
          (action) => action !== "cognito-idp:CreateGroup",
        );
      },
    },
    {
      label: "broker extra CreateGroup",
      command: brokerRoleGetPolicyCommand(),
      mutate(statement) {
        statement.Action.push("cognito-idp:CreateGroup");
      },
    },
    {
      label: "wildcard Cognito action",
      command: adminRoleGetPolicyCommand(),
      mutate(statement) {
        statement.Action = ["cognito-idp:*Group"];
      },
    },
    {
      label: "wildcard Cognito resource",
      command: brokerRoleGetPolicyCommand(),
      mutate(statement) {
        statement.Resource =
          `arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/*`;
      },
    },
  ];
  for (const { label, command, mutate } of mutations) {
    for (const mode of ["deploy", "postdeploy"]) {
      const responses = exactResponses();
      const document = JSON.parse(responses.get(key(...command)));
      const statement = document.PolicyDocument.Statement.find(
        ({ Action }) => {
          const actions = Array.isArray(Action) ? Action : [Action];
          return actions.includes("cognito-idp:DeleteGroup");
        },
      );
      assert.ok(statement, label);
      mutate(statement);
      responses.set(key(...command), JSON.stringify(document));
      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: mode,
          }),
          responses,
        }).options),
        /platform admin role|hosted acceptance broker role|inline policy/i,
        `${mode} accepted ${label}`,
      );
    }
  }
});

test("runtime boundary keeps only the canonical domain group action family", () => {
  const statement = EXPECTED_RUNTIME_BOUNDARY_POLICY.Statement.find(
    ({ Action, Resource }) =>
      Array.isArray(Resource)
      && Resource.length === 1
      && Resource[0] === USER_POOL_ARN
      && (Array.isArray(Action) ? Action : [Action])
        .includes("cognito-idp:CreateGroup"),
  );
  assert.ok(statement);
  assert.deepEqual(statement.Action, [
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
  assert.deepEqual(statement.Resource, [USER_POOL_ARN]);
  assert.equal(
    statement.Action.some((action) => action.includes("*")),
    false,
  );
});

test("postdeploy requires the exact Identity API target policy", () => {
  const { calls, options } = fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "postdeploy",
    }),
    responses: githubEnabledResponses(),
  });

  const result = auditPredeploy(options);
  const identityRole = result.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === IDENTITY_ROLE_NAME,
  );

  assert.deepEqual(identityRole, {
    acceptedPolicyState: "target",
    arnMatches: true,
    attachedPoliciesAbsent: true,
    boundaryMatches: true,
    inlinePolicyMatches: true,
    roleName: IDENTITY_ROLE_NAME,
    trustMatches: true,
  });
  for (const expectedCommand of [
    identityRoleListAttachedPoliciesCommand(),
    identityRoleListPoliciesCommand(),
    identityRoleGetPolicyCommand(),
    identityRoleGetXrayPolicyCommand(),
  ]) {
    assert.ok(
      calls.some(({ command, args }) =>
        key(command, args) === key(...expectedCommand)
      ),
      expectedCommand.join(" "),
    );
  }
});

test("deploy and postdeploy require the exact Governance API effective policy", () => {
  for (const mode of ["deploy", "postdeploy"]) {
    const { calls, options } = fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: mode,
      }),
      responses: githubEnabledResponses(),
    });

    const result = auditPredeploy(options);
    const governanceRole = result.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === GOVERNANCE_ROLE_NAME,
    );

    assert.deepEqual(governanceRole, {
      acceptedPolicyState: "target",
      arnMatches: true,
      attachedPoliciesAbsent: true,
      boundaryMatches: true,
      inlinePolicyMatches: true,
      roleName: GOVERNANCE_ROLE_NAME,
      trustMatches: true,
    });
    for (const expectedCommand of [
      governanceRoleListAttachedPoliciesCommand(),
      governanceRoleListPoliciesCommand(),
      governanceRoleGetPolicyCommand(),
      governanceRoleGetXrayPolicyCommand(),
    ]) {
      assert.ok(
        calls.some(({ command, args }) =>
          key(command, args) === key(...expectedCommand)
        ),
        `${mode}: ${expectedCommand.join(" ")}`,
      );
    }
  }
});

test("deploy accepts only the exact Governance transaction predecessor", () => {
  const responses = githubEnabledResponses();
  responses.set(
    key(...governanceRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: GOVERNANCE_LEGACY_TRANSACTION_INLINE_POLICY,
      PolicyName: GOVERNANCE_POLICY_NAME,
      RoleName: GOVERNANCE_ROLE_NAME,
    }),
  );

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === GOVERNANCE_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-transaction-authorization",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Governance API role inline policy|exact target/i,
  );

  const broadened = structuredClone(
    GOVERNANCE_LEGACY_TRANSACTION_INLINE_POLICY,
  );
  broadened.Statement[3].Condition["ForAllValues:StringLike"][
    "dynamodb:LeadingKeys"
  ].push("DOMAIN");
  const broadenedResponses = githubEnabledResponses();
  broadenedResponses.set(
    key(...governanceRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: broadened,
      PolicyName: GOVERNANCE_POLICY_NAME,
      RoleName: GOVERNANCE_ROLE_NAME,
    }),
  );
  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses: broadenedResponses,
    }).options),
    /Governance API role inline policy|exact target/i,
  );
});

test("Governance API effective-policy audit rejects every privilege drift", async (t) => {
  const findStatement = (document, predicate) => {
    const statement = document.PolicyDocument.Statement.find(predicate);
    assert.ok(statement);
    return statement;
  };
  const hasAction = (statement, action) =>
    (Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action]).includes(action);
  const failureCases = [
    {
      name: "non-Lambda trust",
      command: runtimeRoleCommand(GOVERNANCE_ROLE_NAME),
      expectedError: /Governance API role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      name: "attached managed policy",
      command: governanceRoleListAttachedPoliciesCommand(),
      expectedError: /Governance API role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      name: "extra inline policy",
      command: governanceRoleListPoliciesCommand(),
      expectedError: /Governance API role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
    {
      name: "application policy metadata",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|metadata/i,
      mutate(document) {
        document.PolicyName = "OtherPolicy";
      },
    },
    {
      name: "extra logging action",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "logs:CreateLogGroup",
        );
      },
    },
    {
      name: "broadened read keys",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("SESSION#*");
      },
    },
    {
      name: "changed write table",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "dynamodb:PutItem")
            && statement.Condition?.["ForAnyValue:StringEquals"]
              ?.["dynamodb:EnclosingOperation"],
        ).Resource =
          `${PLATFORM_STATE_TABLE_ARN}-other`;
      },
    },
    {
      name: "extra Cognito action",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "cognito-idp:AdminGetUser"),
        ).Action.push(
          "cognito-idp:AdminUpdateUserAttributes",
        );
      },
    },
    {
      name: "broadened static Registry list",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "agent-registry:ListRegistryRecords")
            && statement.Condition === undefined,
        ).Resource = "*";
      },
    },
    {
      name: "broadened static Registry record read",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "agent-registry:GetRegistryRecord")
            && statement.Condition === undefined,
        ).Resource.push(
          ACCOUNT_REGISTRY_RECORD_ARN,
        );
      },
    },
    {
      name: "missing exact request tag keys",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        delete findStatement(
          document,
          (statement) =>
            hasAction(statement, "agent-registry:CreateRegistryRecord"),
        ).Condition["ForAllValues:StringEquals"];
      },
    },
    {
      name: "changed required request tag",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "agent-registry:CreateRegistryRecord"),
        ).Condition.StringEquals[
          "aws:RequestTag/auto-delete"
        ] = "yes";
      },
    },
    {
      name: "missing mutation resource tags",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        delete findStatement(
          document,
          (statement) =>
            hasAction(
              statement,
              "agent-registry:SubmitRegistryRecordForApproval",
            ),
        ).Condition.StringEquals["aws:ResourceTag/managedBy"];
      },
    },
    {
      name: "broadened dynamic Registry list resource",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "agent-registry:ListRegistryRecords")
            && statement.Condition !== undefined,
        ).Resource = "*";
      },
    },
    {
      name: "missing dynamic record resource condition",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        delete findStatement(
          document,
          (statement) =>
            hasAction(statement, "agent-registry:UpdateRegistryRecordStatus")
            && statement.Condition !== undefined,
        ).Condition;
      },
    },
    {
      name: "extra application statement",
      command: governanceRoleGetPolicyCommand(),
      expectedError: /Governance API role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.push({
          Action: "dynamodb:DescribeTable",
          Effect: "Allow",
          Resource: PLATFORM_STATE_TABLE_ARN,
        });
      },
    },
    {
      name: "broadened X-Ray policy",
      command: governanceRoleGetXrayPolicyCommand(),
      expectedError: /Governance API role|X-Ray/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "xray:GetTraceSummaries",
        );
      },
    },
  ];

  for (const { name, command, expectedError, mutate } of failureCases) {
    await t.test(name, () => {
      for (const mode of ["deploy", "postdeploy"]) {
        const responses = githubEnabledResponses();
        const document = JSON.parse(responses.get(key(...command)));
        mutate(document);
        responses.set(key(...command), JSON.stringify(document));

        assert.throws(
          () => auditPredeploy(fixture({
            env: githubEnabledEnvironment({
              SECURITY_AUDIT_MODE: mode,
            }),
            responses,
          }).options),
          expectedError,
          `${mode} accepted Governance API drift: ${name}`,
        );
      }
    });
  }
});

test("deploy and postdeploy discover exactly one valid Governance API log group", async (t) => {
  const failureCases = [
    {
      name: "missing",
      mutate(resources) {
        resources.StackResources = resources.StackResources.filter(
          ({ LogicalResourceId }) =>
            !LogicalResourceId.startsWith("GovernanceApiLogs"),
        );
      },
    },
    {
      name: "duplicate",
      mutate(resources) {
        resources.StackResources.push({
          LogicalResourceId: "GovernanceApiLogsDuplicate",
          PhysicalResourceId: GOVERNANCE_LOG_GROUP_NAME,
          ResourceType: "AWS::Logs::LogGroup",
        });
      },
    },
    {
      name: "malformed",
      mutate(resources) {
        resources.StackResources.find(
          ({ LogicalResourceId }) =>
            LogicalResourceId.startsWith("GovernanceApiLogs"),
        ).PhysicalResourceId = "invalid log group";
      },
    },
  ];

  for (const { name, mutate } of failureCases) {
    await t.test(name, () => {
      for (const mode of ["deploy", "postdeploy"]) {
        const responses = githubEnabledResponses();
        const resources = JSON.parse(
          responses.get(key(...COMMANDS.webResources)),
        );
        mutate(resources);
        responses.set(
          key(...COMMANDS.webResources),
          JSON.stringify(resources),
        );

        assert.throws(
          () => auditPredeploy(fixture({
            env: githubEnabledEnvironment({
              SECURITY_AUDIT_MODE: mode,
            }),
            responses,
          }).options),
          /Governance API log group|exactly one|malformed/i,
          `${mode} accepted ${name} Governance API log group`,
        );
      }
    });
  }
});

test("deploy and postdeploy discover exactly one valid Runtime proof secret without reading it", async (t) => {
  for (const mode of ["deploy", "postdeploy"]) {
    const { calls, options } = fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: mode,
      }),
      responses: githubEnabledResponses(),
    });
    const result = auditPredeploy(options);
    assert.equal(result.evidence.status, "passed");
    assert.equal(
      calls.some(({ args }) =>
        args[0] === "secretsmanager"
        && args[1] === "get-secret-value"
      ),
      false,
    );
  }

  const failureCases = [
    {
      name: "missing",
      mutate(resources) {
        resources.StackResources = resources.StackResources.filter(
          ({ ResourceType }) =>
            ResourceType !== "AWS::SecretsManager::Secret",
        );
      },
    },
    {
      name: "duplicate",
      mutate(resources) {
        const secret = resources.StackResources.find(
          ({ ResourceType }) =>
            ResourceType === "AWS::SecretsManager::Secret",
        );
        resources.StackResources.push({
          ...secret,
          LogicalResourceId:
            "RuntimeInvocationProofSecretDUPLICATE",
        });
      },
    },
    {
      name: "renamed logical resource",
      mutate(resources) {
        resources.StackResources.find(
          ({ ResourceType }) =>
            ResourceType === "AWS::SecretsManager::Secret",
        ).LogicalResourceId = "UnexpectedSecret551AA3CA";
      },
    },
    {
      name: "malformed physical ARN",
      mutate(resources) {
        resources.StackResources.find(
          ({ ResourceType }) =>
            ResourceType === "AWS::SecretsManager::Secret",
        ).PhysicalResourceId =
          "AgenticPlatform-Web-RuntimeInvocationProofSecret";
      },
    },
    {
      name: "wrong secret name",
      mutate(resources) {
        resources.StackResources.find(
          ({ ResourceType }) =>
            ResourceType === "AWS::SecretsManager::Secret",
        ).PhysicalResourceId =
          `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:`
          + "secret:UnrelatedSecret-ABC123";
      },
    },
  ];
  for (const { name, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const resources = JSON.parse(
        responses.get(key(...COMMANDS.webResources)),
      );
      mutate(resources);
      responses.set(
        key(...COMMANDS.webResources),
        JSON.stringify(resources),
      );
      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Runtime (?:invocation )?proof secret|Secrets Manager secret/i,
      );
    });
  }
});

test("deploy and postdeploy require the exact Access Admin role contract", () => {
  for (const mode of ["deploy", "postdeploy"]) {
    const { calls, options } = fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: mode,
      }),
      responses: githubEnabledResponses(),
    });

    const result = auditPredeploy(options);
    assert.deepEqual(
      result.evidence.runtimeRoles.roles.find(
        ({ roleName }) => roleName === ACCESS_ADMIN_ROLE_NAME,
      ),
      {
        acceptedPolicyState: "target",
        arnMatches: true,
        attachedPoliciesAbsent: true,
        boundaryMatches: true,
        inlinePolicyMatches: true,
        roleName: ACCESS_ADMIN_ROLE_NAME,
        trustMatches: true,
      },
    );
    for (const expectedCommand of [
      roleListAttachedPoliciesCommand(ACCESS_ADMIN_ROLE_NAME),
      roleListPoliciesCommand(ACCESS_ADMIN_ROLE_NAME),
      roleGetPolicyCommand(
        ACCESS_ADMIN_ROLE_NAME,
        ACCESS_ADMIN_POLICY_NAME,
      ),
      roleGetPolicyCommand(
        ACCESS_ADMIN_ROLE_NAME,
        ACCESS_ADMIN_XRAY_POLICY_NAME,
      ),
    ]) {
      assert.ok(
        calls.some(({ command, args }) =>
          key(command, args) === key(...expectedCommand)
        ),
        `${mode}: ${expectedCommand.join(" ")}`,
      );
    }
  }
});

test("Access Admin role audit rejects every privilege and inventory drift", async (t) => {
  const applicationPolicyCommand = roleGetPolicyCommand(
    ACCESS_ADMIN_ROLE_NAME,
    ACCESS_ADMIN_POLICY_NAME,
  );
  const xrayPolicyCommand = roleGetPolicyCommand(
    ACCESS_ADMIN_ROLE_NAME,
    ACCESS_ADMIN_XRAY_POLICY_NAME,
  );
  const failureCases = [
    {
      name: "non-Lambda trust",
      command: runtimeRoleCommand(ACCESS_ADMIN_ROLE_NAME),
      expectedError: /Access Admin.*trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      name: "attached managed policy",
      command: roleListAttachedPoliciesCommand(ACCESS_ADMIN_ROLE_NAME),
      expectedError: /Access Admin.*attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      name: "extra inline policy",
      command: roleListPoliciesCommand(ACCESS_ADMIN_ROLE_NAME),
      expectedError: /Access Admin.*inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
    {
      name: "broadened log access",
      command: applicationPolicyCommand,
      expectedError: /Access Admin.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "logs:CreateLogGroup",
        );
      },
    },
    {
      name: "broadened read key",
      command: applicationPolicyCommand,
      expectedError: /Access Admin.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("AGENT#*");
      },
    },
    {
      name: "broadened direct mutation claim",
      command: applicationPolicyCommand,
      expectedError: /Access Admin.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[2].Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("AUDIT#*");
      },
    },
    {
      name: "transaction fence removed",
      command: applicationPolicyCommand,
      expectedError: /Access Admin.*inline policy/i,
      mutate(document) {
        delete document.PolicyDocument.Statement[3].Condition[
          "ForAnyValue:StringEquals"
        ];
      },
    },
    {
      name: "project update broadened",
      command: applicationPolicyCommand,
      expectedError: /Access Admin.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[4].Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("DOMAIN");
      },
    },
    {
      name: "extra Cognito action",
      command: applicationPolicyCommand,
      expectedError: /Access Admin.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[5].Action.push(
          "cognito-idp:AdminUpdateUserAttributes",
        );
      },
    },
    {
      name: "broadened Cognito resource",
      command: applicationPolicyCommand,
      expectedError: /Access Admin.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[5].Resource = "*";
      },
    },
    {
      name: "broadened X-Ray policy",
      command: xrayPolicyCommand,
      expectedError: /Access Admin.*X-Ray/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "xray:GetTraceSummaries",
        );
      },
    },
  ];

  for (const { name, command, expectedError, mutate } of failureCases) {
    await t.test(name, () => {
      for (const mode of ["deploy", "postdeploy"]) {
        const responses = githubEnabledResponses();
        const document = JSON.parse(responses.get(key(...command)));
        mutate(document);
        responses.set(key(...command), JSON.stringify(document));

        assert.throws(
          () => auditPredeploy(fixture({
            env: githubEnabledEnvironment({
              SECURITY_AUDIT_MODE: mode,
            }),
            responses,
          }).options),
          expectedError,
        );
      }
    });
  }
});

test("postdeploy requires exactly one valid Access Admin log group", async (t) => {
  const failureCases = [
    {
      name: "missing",
      mutate(resources) {
        resources.StackResources = resources.StackResources.filter(
          ({ LogicalResourceId }) =>
            !LogicalResourceId.startsWith("AccessAdminApiLogs"),
        );
      },
    },
    {
      name: "duplicate",
      mutate(resources) {
        resources.StackResources.push({
          LogicalResourceId: "AccessAdminApiLogsDuplicate",
          PhysicalResourceId: `${ACCESS_ADMIN_LOG_GROUP_NAME}-duplicate`,
          ResourceType: "AWS::Logs::LogGroup",
        });
      },
    },
    {
      name: "malformed",
      mutate(resources) {
        resources.StackResources.find(
          ({ LogicalResourceId }) =>
            LogicalResourceId.startsWith("AccessAdminApiLogs"),
        ).PhysicalResourceId = "invalid log group";
      },
    },
  ];

  for (const { name, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const resources = JSON.parse(
        responses.get(key(...COMMANDS.webResources)),
      );
      mutate(resources);
      responses.set(
        key(...COMMANDS.webResources),
        JSON.stringify(resources),
      );
      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Access Admin.*log group/i,
      );
    });
  }
});

test("deploy permits a planned Access Admin transition but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const resources = JSON.parse(
    responses.get(key(...COMMANDS.webResources)),
  );
  resources.StackResources = resources.StackResources.filter(
    ({ LogicalResourceId }) =>
      !LogicalResourceId.startsWith("AccessAdminApiLogs"),
  );
  responses.set(
    key(...COMMANDS.webResources),
    JSON.stringify(resources),
  );
  responses.set(
    key(...runtimeRoleCommand(ACCESS_ADMIN_ROLE_NAME)),
    missingRoleResponse(ACCESS_ADMIN_ROLE_NAME),
  );

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "deploy",
    }),
    responses,
  }).options);
  assert.deepEqual(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === ACCESS_ADMIN_ROLE_NAME,
    ),
    {
      roleName: ACCESS_ADMIN_ROLE_NAME,
      status: "planned",
    },
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Access Admin.*log group/i,
  );
});

test("Runtime proof roles are audited against the exact target contracts", () => {
  assert.equal(RUNTIME_ROLE_NAMES.length, 25);

  for (const mode of ["deploy", "postdeploy"]) {
    const { calls, options } = fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: mode,
      }),
      responses: githubEnabledResponses(),
    });

    const result = auditPredeploy(options);
    for (const roleName of [
      RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
      RUNTIME_PROOF_PROVIDER_ROLE_NAME,
    ]) {
      assert.deepEqual(
        result.evidence.runtimeRoles.roles.find(
          (role) => role.roleName === roleName,
        ),
        {
          arnMatches: true,
          attachedPoliciesAbsent: true,
          boundaryMatches: true,
          inlinePolicyMatches: true,
          roleName,
          trustMatches: true,
        },
      );
      for (const command of [
        roleListAttachedPoliciesCommand(roleName),
        roleListPoliciesCommand(roleName),
      ]) {
        assert.ok(
          calls.some(({ command: actualCommand, args }) =>
            key(actualCommand, args) === key(...command)
          ),
          `${mode} did not audit ${command.join(" ")}`,
        );
      }
    }
  }
});

test("Runtime proof role audits reject identity, trust, attachment, and inventory drift", async (t) => {
  for (const roleName of [
    RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
    RUNTIME_PROOF_PROVIDER_ROLE_NAME,
  ]) {
    const failureCases = [
      {
        name: "non-root role ARN",
        command: runtimeRoleCommand(roleName),
        mutate(document) {
          document.Role.Arn =
            `arn:aws:iam::${ACCOUNT_ID}:role/service-role/${roleName}`;
        },
      },
      {
        name: "extra trusted principal",
        command: runtimeRoleCommand(roleName),
        mutate(document) {
          document.Role.AssumeRolePolicyDocument.Statement.push({
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
          });
        },
      },
      {
        name: "attached policy",
        command: roleListAttachedPoliciesCommand(roleName),
        mutate(document) {
          document.AttachedPolicies.push({
            PolicyArn: "arn:aws:iam::aws:policy/ReadOnlyAccess",
            PolicyName: "ReadOnlyAccess",
          });
        },
      },
      {
        name: "paginated attached policy inventory",
        command: roleListAttachedPoliciesCommand(roleName),
        mutate(document) {
          document.IsTruncated = true;
          document.Marker = "next";
        },
      },
      {
        name: "paginated inline policy inventory",
        command: roleListPoliciesCommand(roleName),
        mutate(document) {
          document.IsTruncated = true;
          document.Marker = "next";
        },
      },
      {
        name: "extra inline policy",
        command: roleListPoliciesCommand(roleName),
        mutate(document) {
          document.PolicyNames.push("UnexpectedPolicy");
        },
      },
    ];

    for (const { name, command, mutate } of failureCases) {
      await t.test(`${roleName}: ${name}`, () => {
        const responses = githubEnabledResponses();
        const document = JSON.parse(responses.get(key(...command)));
        mutate(document);
        responses.set(key(...command), JSON.stringify(document));

        assert.throws(
          () => auditPredeploy(fixture({
            env: githubEnabledEnvironment({
              SECURITY_AUDIT_MODE: "postdeploy",
            }),
            responses,
          }).options),
          /Runtime proof|runtime role|approved inline policies|attached policies|trust policy/i,
        );
      });
    }
  }
});

test("Runtime proof configurator audit rejects extra actions and resources", async (t) => {
  const command = roleGetPolicyCommand(
    RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
    RUNTIME_PROOF_CONFIGURATOR_POLICY_NAME,
  );
  const failureCases = [
    {
      name: "extra log action",
      mutate(policy) {
        policy.Statement[0].Action.push("logs:CreateLogGroup");
      },
    },
    {
      name: "extra log resource",
      mutate(policy) {
        policy.Statement[0].Resource = [
          policy.Statement[0].Resource,
          "*",
        ];
      },
    },
    {
      name: "extra secret action",
      mutate(policy) {
        policy.Statement[1].Action.push("secretsmanager:DeleteSecret");
      },
    },
    {
      name: "extra secret resource",
      mutate(policy) {
        policy.Statement[1].Resource = [
          policy.Statement[1].Resource,
          "arn:aws:secretsmanager:us-west-2:111122223333:secret:*",
        ];
      },
    },
  ];

  for (const { name, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const document = JSON.parse(responses.get(key(...command)));
      mutate(document.PolicyDocument);
      responses.set(key(...command), JSON.stringify(document));

      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Runtime proof configurator.*policy.*drift/i,
      );
    });
  }
});

test("Runtime proof provider audit rejects extra actions and resources", async (t) => {
  const logCommand = roleGetPolicyCommand(
    RUNTIME_PROOF_PROVIDER_ROLE_NAME,
    RUNTIME_PROOF_PROVIDER_LOG_POLICY_NAME,
  );
  const defaultCommand = roleGetPolicyCommand(
    RUNTIME_PROOF_PROVIDER_ROLE_NAME,
    RUNTIME_PROOF_PROVIDER_DEFAULT_POLICY_NAME,
  );
  const failureCases = [
    {
      name: "extra log action",
      command: logCommand,
      mutate(policy) {
        policy.Statement[0].Action.push("logs:CreateLogGroup");
      },
    },
    {
      name: "extra log resource",
      command: logCommand,
      mutate(policy) {
        policy.Statement[0].Resource = [
          policy.Statement[0].Resource,
          "*",
        ];
      },
    },
    {
      name: "extra Lambda action",
      command: defaultCommand,
      mutate(policy) {
        policy.Statement[0].Action = [
          policy.Statement[0].Action,
          "lambda:UpdateFunctionCode",
        ];
      },
    },
    {
      name: "extra Lambda resource",
      command: defaultCommand,
      mutate(policy) {
        policy.Statement[0].Resource.push(
          `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:OtherFunction`,
        );
      },
    },
  ];

  for (const { name, command, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const document = JSON.parse(responses.get(key(...command)));
      mutate(document.PolicyDocument);
      responses.set(key(...command), JSON.stringify(document));

      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Runtime proof provider.*policy.*drift/i,
      );
    });
  }
});

test("Runtime proof resource discovery rejects missing, duplicate, and malformed target resources", async (t) => {
  const failureCases = [
    {
      name: "missing configurator log group",
      mutate(resources) {
        resources.StackResources = resources.StackResources.filter(
          ({ LogicalResourceId }) =>
            !LogicalResourceId.startsWith("RuntimeProofConfiguratorLogs"),
        );
      },
    },
    {
      name: "duplicate provider log group",
      mutate(resources) {
        const source = resources.StackResources.find(
          ({ LogicalResourceId }) =>
            LogicalResourceId.startsWith("RuntimeProofProviderLogs"),
        );
        resources.StackResources.push({
          ...source,
          LogicalResourceId: "RuntimeProofProviderLogsDUPLICATE",
        });
      },
    },
    {
      name: "malformed configurator log group name",
      mutate(resources) {
        resources.StackResources.find(
          ({ LogicalResourceId }) =>
            LogicalResourceId.startsWith("RuntimeProofConfiguratorLogs"),
        ).PhysicalResourceId = "invalid log group!";
      },
    },
    {
      name: "missing configurator function",
      mutate(resources) {
        resources.StackResources = resources.StackResources.filter(
          ({ LogicalResourceId }) =>
            !LogicalResourceId.startsWith(
              "RuntimeProofConfiguratorFunction",
            ),
        );
      },
    },
    {
      name: "unexpected configurator function name",
      mutate(resources) {
        resources.StackResources.find(
          ({ LogicalResourceId }) =>
            LogicalResourceId.startsWith(
              "RuntimeProofConfiguratorFunction",
            ),
        ).PhysicalResourceId = "UnexpectedFunction";
      },
    },
  ];

  for (const { name, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const resources = JSON.parse(
        responses.get(key(...COMMANDS.webResources)),
      );
      mutate(resources);
      responses.set(
        key(...COMMANDS.webResources),
        JSON.stringify(resources),
      );

      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Runtime proof.*(log group|configurator function)|exactly one/i,
      );
    });
  }
});

test("deploy allows missing Runtime proof roles only for the complete prior resource state", () => {
  const predecessor = gatewayIsolationPredecessorResponses();
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: predecessor,
  }).options);
  for (const roleName of [
    RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
    RUNTIME_PROOF_PROVIDER_ROLE_NAME,
  ]) {
    assert.deepEqual(
      deploy.evidence.runtimeRoles.roles.find(
        (role) => role.roleName === roleName,
      ),
      { roleName, status: "planned" },
    );
  }

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: predecessor,
    }).options),
    /Runtime proof|proof secret|configurator|required/i,
  );

  for (const restoredResource of [
    {
      LogicalResourceId: "RuntimeInvocationProofSecret551AA3CA",
      PhysicalResourceId: RUNTIME_INVOCATION_PROOF_SECRET_ARN,
      ResourceType: "AWS::SecretsManager::Secret",
    },
    {
      LogicalResourceId: "RuntimeProofConfiguratorFunctionC49E3577",
      PhysicalResourceId: RUNTIME_PROOF_CONFIGURATOR_FUNCTION_NAME,
      ResourceType: "AWS::Lambda::Function",
    },
  ]) {
    const partial = gatewayIsolationPredecessorResponses();
    const resources = JSON.parse(
      partial.get(key(...COMMANDS.webResources)),
    );
    resources.StackResources.push(restoredResource);
    partial.set(
      key(...COMMANDS.webResources),
      JSON.stringify(resources),
    );
    assert.throws(
      () => auditPredeploy(fixture({
        env: githubEnabledEnvironment(),
        responses: partial,
      }).options),
      /Runtime proof|proof secret|configurator|required|exactly one/i,
    );
  }
});

test("Journey role audit requires the exact OAuth-enabled live policy", () => {
  const { calls, options } = fixture({
    env: journeyOAuthEnvironment({
      SECURITY_AUDIT_MODE: "postdeploy",
    }),
    responses: journeyOAuthResponses(),
  });

  const result = auditPredeploy(options);
  assert.deepEqual(
    result.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === JOURNEY_ROLE_NAME,
    ),
    {
      acceptedPolicyState: "target",
      arnMatches: true,
      attachedPoliciesAbsent: true,
      boundaryMatches: true,
      inlinePolicyMatches: true,
      roleName: JOURNEY_ROLE_NAME,
      trustMatches: true,
    },
  );
  for (const command of [
    roleListAttachedPoliciesCommand(JOURNEY_ROLE_NAME),
    roleListPoliciesCommand(JOURNEY_ROLE_NAME),
    roleGetPolicyCommand(JOURNEY_ROLE_NAME, JOURNEY_POLICY_NAME),
    roleGetPolicyCommand(
      JOURNEY_ROLE_NAME,
      JOURNEY_DEFAULT_POLICY_NAME,
    ),
  ]) {
    assert.ok(
      calls.some(({ command: actual, args }) =>
        key(actual, args) === key(...command)
      ),
      command.join(" "),
    );
  }
});

test("Journey role deploy audit accepts only the exact AgentCore predecessor", () => {
  const responses = journeyOAuthResponses();
  responses.set(
    key(...roleGetPolicyCommand(
      JOURNEY_ROLE_NAME,
      JOURNEY_POLICY_NAME,
    )),
    JSON.stringify({
      PolicyDocument: JOURNEY_OAUTH_PREDECESSOR_INLINE_POLICY,
      PolicyName: JOURNEY_POLICY_NAME,
      RoleName: JOURNEY_ROLE_NAME,
    }),
  );

  const deploy = auditPredeploy(fixture({
    env: journeyOAuthEnvironment(),
    responses,
  }).options);
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === JOURNEY_ROLE_NAME,
    ).acceptedPolicyState,
    "agentcore-runtime-predecessor",
  );
  assert.throws(
    () => auditPredeploy(fixture({
      env: journeyOAuthEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /Journey role|Journey API role|inline polic/i,
  );
});

test("Journey role audit rejects trust and least-privilege drift", async (t) => {
  const hasAction = (statement, action) =>
    [statement.Action].flat().includes(action);
  const findStatement = (document, predicate) => {
    const statement = document.PolicyDocument.Statement.find(predicate);
    assert.ok(statement);
    return statement;
  };
  const cases = [
    {
      name: "non-Lambda trust",
      command: runtimeRoleCommand(JOURNEY_ROLE_NAME),
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      name: "attached managed policy",
      command: roleListAttachedPoliciesCommand(JOURNEY_ROLE_NAME),
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      name: "wrong OAuth secret",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        const statement = findStatement(
          document,
          (statement) =>
            hasAction(statement, "secretsmanager:GetSecretValue")
            && Array.isArray(statement.Resource)
            && statement.Resource.includes(
              JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN,
            ),
        );
        statement.Resource = statement.Resource.map((resource) =>
          resource === JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN
            ? `${resource}-other`
            : resource
        );
      },
    },
    {
      name: "OAuth authorization PutItem becomes transaction-only",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "dynamodb:PutItem")
            && statement.Condition?.["ForAllValues:StringLike"]
              ?.["dynamodb:LeadingKeys"]
              ?.includes("GITHUB_AUTHORIZATION#*"),
        ).Condition["ForAnyValue:StringEquals"] = {
          "dynamodb:EnclosingOperation": ["TransactWriteItems"],
        };
      },
    },
    {
      name: "transactional PutItem includes OAuth authorization state",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "dynamodb:PutItem")
            && statement.Condition?.["ForAnyValue:StringEquals"]
              ?.["dynamodb:EnclosingOperation"],
        ).Condition["ForAllValues:StringLike"][
          "dynamodb:LeadingKeys"
        ].push("GITHUB_AUTHORIZATION#*");
      },
    },
    {
      name: "transactional PutItem loses enclosing-operation condition",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        delete findStatement(
          document,
          (statement) =>
            hasAction(statement, "dynamodb:PutItem")
            && statement.Condition?.["ForAnyValue:StringEquals"]
              ?.["dynamodb:EnclosingOperation"],
        ).Condition["ForAnyValue:StringEquals"];
      },
    },
    {
      name: "UpdateItem broadens state keys",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "dynamodb:UpdateItem"),
        ).Condition["ForAllValues:StringLike"][
          "dynamodb:LeadingKeys"
        ].push("PROJECT#*");
      },
    },
    {
      name: "broad Registry resource",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "agent-registry:ListRegistryRecords"),
        ).Resource = "*";
      },
    },
    {
      name: "broad AgentCore Runtime action",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "bedrock-agentcore:InvokeAgentRuntime"),
        ).Action = "bedrock-agentcore:*";
      },
    },
    {
      name: "broad AgentCore Runtime resource",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "bedrock-agentcore:InvokeAgentRuntime"),
        ).Resource = "*";
      },
    },
    {
      name: "wrong runtime proof secret",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_POLICY_NAME,
      ),
      mutate(document) {
        const statement = findStatement(
          document,
          (statement) =>
            hasAction(statement, "secretsmanager:GetSecretValue")
            && Array.isArray(statement.Resource)
            && statement.Resource.includes(
              RUNTIME_INVOCATION_PROOF_SECRET_ARN,
            ),
        );
        statement.Resource = statement.Resource.map((resource) =>
          resource === RUNTIME_INVOCATION_PROOF_SECRET_ARN
            ? `${resource}-other`
            : resource
        );
      },
    },
    {
      name: "broad STS assume-role resource",
      command: roleGetPolicyCommand(
        JOURNEY_ROLE_NAME,
        JOURNEY_DEFAULT_POLICY_NAME,
      ),
      mutate(document) {
        findStatement(
          document,
          (statement) =>
            hasAction(statement, "sts:AssumeRole"),
        ).Resource = "*";
      },
    },
  ];

  for (const drift of cases) {
    await t.test(drift.name, () => {
      const responses = journeyOAuthResponses();
      const responseKey = key(...drift.command);
      const document = JSON.parse(responses.get(responseKey));
      drift.mutate(document);
      responses.set(responseKey, JSON.stringify(document));

      assert.throws(
        () => auditPredeploy(fixture({
          env: journeyOAuthEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Journey role|Journey API role|trust|attached polic|inline polic/i,
      );
    });
  }
});

test("Gateway invoker role audit rejects every trust and policy drift", async (t) => {
  const failureCases = [
    {
      name: "unapproved trusted principal",
      command: runtimeRoleCommand(GATEWAY_INVOKER_ROLE_NAME),
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement.push({
          Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
          Condition: {
            ArnEquals: {
              "aws:PrincipalArn":
                `arn:aws:iam::${ACCOUNT_ID}:role/UnapprovedRole`,
            },
            ...GATEWAY_DOMAIN_SOURCE_IDENTITY_CONDITION,
          },
          Effect: "Allow",
          Principal: {
            AWS: `arn:aws:iam::${ACCOUNT_ID}:root`,
          },
        });
      },
    },
    {
      name: "missing SourceIdentity condition",
      command: runtimeRoleCommand(GATEWAY_INVOKER_ROLE_NAME),
      mutate(document) {
        delete document.Role.AssumeRolePolicyDocument.Statement[0].Condition;
      },
    },
    {
      name: "missing SetSourceIdentity trust action",
      command: runtimeRoleCommand(GATEWAY_INVOKER_ROLE_NAME),
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Action =
          "sts:AssumeRole";
      },
    },
    {
      name: "attached policy",
      command: roleListAttachedPoliciesCommand(
        GATEWAY_INVOKER_ROLE_NAME,
      ),
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      name: "extra inline policy",
      command: roleListPoliciesCommand(GATEWAY_INVOKER_ROLE_NAME),
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
    {
      name: "broadened Gateway resource",
      command: roleGetPolicyCommand(
        GATEWAY_INVOKER_ROLE_NAME,
        GATEWAY_INVOKER_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement[0].Resource = "*";
      },
    },
    {
      name: "extra Gateway action",
      command: roleGetPolicyCommand(
        GATEWAY_INVOKER_ROLE_NAME,
        GATEWAY_INVOKER_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement[0].Action = [
          "bedrock-agentcore:InvokeGateway",
          "bedrock-agentcore:DeleteGateway",
        ];
      },
    },
  ];
  for (const { name, command, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const document = JSON.parse(responses.get(key(...command)));
      mutate(document);
      responses.set(key(...command), JSON.stringify(document));
      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Gateway invoker role/i,
      );
    });
  }
});

test("Model Governance role audit rejects every trust and policy drift", async (t) => {
  const failureCases = [
    {
      name: "non-Lambda trust",
      command: runtimeRoleCommand(MODEL_GOVERNANCE_ROLE_NAME),
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      name: "attached policy",
      command: roleListAttachedPoliciesCommand(
        MODEL_GOVERNANCE_ROLE_NAME,
      ),
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      name: "extra inline policy",
      command: roleListPoliciesCommand(MODEL_GOVERNANCE_ROLE_NAME),
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
    {
      name: "missing rate-limit write",
      command: roleGetPolicyCommand(
        MODEL_GOVERNANCE_ROLE_NAME,
        MODEL_GOVERNANCE_POLICY_NAME,
      ),
      mutate(document) {
        const statement = document.PolicyDocument.Statement.find(
          ({ Action }) =>
            Array.isArray(Action)
            && Action.includes(
              "bedrock-agentcore:BatchPutGatewayRateLimits",
            ),
        );
        statement.Action = ["bedrock-agentcore:ListGatewayRateLimits"];
      },
    },
    {
      name: "broadened AssumeRole target",
      command: roleGetPolicyCommand(
        MODEL_GOVERNANCE_ROLE_NAME,
        MODEL_GOVERNANCE_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) =>
            [Action].flat().includes("sts:AssumeRole"),
        ).Resource = "*";
      },
    },
    {
      name: "missing SetSourceIdentity caller action",
      command: roleGetPolicyCommand(
        MODEL_GOVERNANCE_ROLE_NAME,
        MODEL_GOVERNANCE_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) =>
            [Action].flat().includes("sts:AssumeRole"),
        ).Action = "sts:AssumeRole";
      },
    },
    {
      name: "direct Gateway invocation",
      command: roleGetPolicyCommand(
        MODEL_GOVERNANCE_ROLE_NAME,
        MODEL_GOVERNANCE_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.push({
          Action: "bedrock-agentcore:InvokeGateway",
          Effect: "Allow",
          Resource: CONTROL_PLANE_ARNS.llmGatewayArn,
        });
      },
    },
    {
      name: "broadened X-Ray policy",
      command: roleGetPolicyCommand(
        MODEL_GOVERNANCE_ROLE_NAME,
        MODEL_GOVERNANCE_XRAY_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "xray:GetTraceSummaries",
        );
      },
    },
  ];
  for (const { name, command, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const document = JSON.parse(responses.get(key(...command)));
      mutate(document);
      responses.set(key(...command), JSON.stringify(document));
      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Model Governance role/i,
      );
    });
  }
});

test("Gateway callers require exact AssumeRole and proof-secret policies", async (t) => {
  const failureCases = [
    {
      name: "Builder removes governed model-policy reads",
      command: roleGetPolicyCommand(BUILDER_ROLE_NAME, BUILDER_POLICY_NAME),
      mutate(document) {
        const read = document.PolicyDocument.Statement.find(
          ({ Action }) => Action === "dynamodb:GetItem",
        );
        read.Condition["ForAllValues:StringLike"][
          "dynamodb:LeadingKeys"
        ] = read.Condition["ForAllValues:StringLike"][
          "dynamodb:LeadingKeys"
        ].filter((key) => key !== "MODEL_POLICY");
      },
    },
    {
      name: "Builder removes authoritative domain-directory queries",
      command: roleGetPolicyCommand(BUILDER_ROLE_NAME, BUILDER_POLICY_NAME),
      mutate(document) {
        document.PolicyDocument.Statement =
          document.PolicyDocument.Statement.filter(
            ({ Action }) => Action !== "dynamodb:Query",
          );
      },
    },
    {
      name: "Builder uses direct InvokeGateway",
      command: roleGetPolicyCommand(BUILDER_ROLE_NAME, BUILDER_POLICY_NAME),
      mutate(document) {
        document.PolicyDocument.Statement.push({
          Action: "bedrock-agentcore:InvokeGateway",
          Effect: "Allow",
          Resource: CONTROL_PLANE_ARNS.llmGatewayArn,
        });
      },
    },
    {
      name: "Builder broadens AssumeRole",
      command: roleGetPolicyCommand(
        BUILDER_ROLE_NAME,
        BUILDER_XRAY_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) =>
            [Action].flat().includes("sts:AssumeRole"),
        ).Resource = "*";
      },
    },
    {
      name: "Builder omits SetSourceIdentity",
      command: roleGetPolicyCommand(
        BUILDER_ROLE_NAME,
        BUILDER_XRAY_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) =>
            [Action].flat().includes("sts:AssumeRole"),
        ).Action = "sts:AssumeRole";
      },
    },
    {
      name: "Control-plane read omits SetSourceIdentity",
      command: controlPlaneReadRoleGetXrayPolicyCommand(),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) =>
            [Action].flat().includes("sts:AssumeRole"),
        ).Action = "sts:AssumeRole";
      },
    },
    {
      name: "Agent Runtime omits SetSourceIdentity",
      command: roleGetPolicyCommand(
        AGENT_RUNTIME_ROLE_NAME,
        AGENT_RUNTIME_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) =>
            [Action].flat().includes("sts:AssumeRole"),
        ).Action = "sts:AssumeRole";
      },
    },
    {
      name: "Agent Runtime broadens proof secret",
      command: roleGetPolicyCommand(
        AGENT_RUNTIME_ROLE_NAME,
        AGENT_RUNTIME_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) => Action === "secretsmanager:GetSecretValue",
        ).Resource = "*";
      },
    },
    {
      name: "Agent Runtime removes proof secret",
      command: roleGetPolicyCommand(
        AGENT_RUNTIME_ROLE_NAME,
        AGENT_RUNTIME_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement =
          document.PolicyDocument.Statement.filter(
            ({ Action }) => Action !== "secretsmanager:GetSecretValue",
          );
      },
    },
    {
      name: "Agent Runtime uses direct InvokeGateway",
      command: roleGetPolicyCommand(
        AGENT_RUNTIME_ROLE_NAME,
        AGENT_RUNTIME_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.push({
          Action: "bedrock-agentcore:InvokeGateway",
          Effect: "Allow",
          Resource: CONTROL_PLANE_ARNS.llmGatewayArn,
        });
      },
    },
    {
      name: "Experience broadens proof secret",
      command: roleGetPolicyCommand(
        EXPERIENCE_ROLE_NAME,
        EXPERIENCE_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) => Action === "secretsmanager:GetSecretValue",
        ).Resource = "*";
      },
    },
    {
      name: "Experience removes proof secret",
      command: roleGetPolicyCommand(
        EXPERIENCE_ROLE_NAME,
        EXPERIENCE_POLICY_NAME,
      ),
      mutate(document) {
        document.PolicyDocument.Statement =
          document.PolicyDocument.Statement.filter(
            ({ Action }) => Action !== "secretsmanager:GetSecretValue",
          );
      },
    },
  ];
  for (const { name, command, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const document = JSON.parse(responses.get(key(...command)));
      mutate(document);
      responses.set(key(...command), JSON.stringify(document));
      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /Builder role|Control-plane read role|Agent Runtime role|Experience role/i,
      );
    });
  }
});

test("deploy accepts only the exact logging-only Identity API predecessor", () => {
  const predecessorResponses = githubEnabledResponses();
  predecessorResponses.set(
    key(...identityRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: IDENTITY_PREDECESSOR_INLINE_POLICY,
      PolicyName: IDENTITY_POLICY_NAME,
      RoleName: IDENTITY_ROLE_NAME,
    }),
  );

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "deploy",
    }),
    responses: predecessorResponses,
  }).options);
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === IDENTITY_ROLE_NAME,
    ).acceptedPolicyState,
    "predecessor",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: predecessorResponses,
    }).options),
    /Identity API role inline policy|target/i,
  );
});

function identityPolicyResponses(policy) {
  const responses = githubEnabledResponses();
  responses.set(
    key(...identityRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: policy,
      PolicyName: IDENTITY_POLICY_NAME,
      RoleName: IDENTITY_ROLE_NAME,
    }),
  );
  return responses;
}

function auditIdentityPolicy(policy, mode) {
  return auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: mode,
    }),
    responses: identityPolicyResponses(policy),
  }).options);
}

function mutateIdentityPolicy(basePolicy, mutate) {
  const policy = structuredClone(basePolicy);
  mutate(policy);
  return policy;
}

test("Identity API target rejects every near-match privilege drift", async (t) => {
  const driftedPolicies = [
    {
      name: "extra action",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Action = ["dynamodb:Query", "dynamodb:Scan"];
      }),
    },
    {
      name: "extra resource in an array",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Resource = [
          PLATFORM_STATE_TABLE_ARN,
          `${PLATFORM_STATE_TABLE_ARN}-other`,
        ];
      }),
    },
    {
      name: "wildcard resource",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Resource = "*";
      }),
    },
    {
      name: "changed resource",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Resource = `${PLATFORM_STATE_TABLE_ARN}-other`;
      }),
    },
    {
      name: "extra statement",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement.push({
          Action: "dynamodb:DescribeTable",
          Effect: "Allow",
          Resource: PLATFORM_STATE_TABLE_ARN,
        });
      }),
    },
    {
      name: "missing Attributes condition key",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        delete policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:Attributes"];
      }),
    },
    {
      name: "missing LeadingKeys condition key",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        delete policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"];
      }),
    },
    {
      name: "missing Select condition key",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        delete policy.Statement[1].Condition.StringEquals[
          "dynamodb:Select"
        ];
      }),
    },
    {
      name: "ForAnyValue operator replaces ForAllValues",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition["ForAnyValue:StringEquals"] =
          policy.Statement[1].Condition["ForAllValues:StringEquals"];
        delete policy.Statement[1].Condition["ForAllValues:StringEquals"];
      }),
    },
    {
      name: "LeadingKeys uses StringEquals",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition.StringEquals[
          "dynamodb:LeadingKeys"
        ] = policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"];
        delete policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"];
      }),
    },
    {
      name: "Select uses ForAllValues StringEquals",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:Select"] =
          policy.Statement[1].Condition.StringEquals["dynamodb:Select"];
        delete policy.Statement[1].Condition.StringEquals[
          "dynamodb:Select"
        ];
      }),
    },
    {
      name: "changed Attributes value",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:Attributes"][5] = "owner";
      }),
    },
    {
      name: "extra Attributes value",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:Attributes"].push("owner");
      }),
    },
    {
      name: "missing Attributes value",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:Attributes"].pop();
      }),
    },
    {
      name: "changed LeadingKeys value",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"] = ["REQUEST#*"];
      }),
    },
    {
      name: "extra LeadingKeys value",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"].push("REQUEST#*");
      }),
    },
    {
      name: "changed Select value",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition.StringEquals[
          "dynamodb:Select"
        ] = "ALL_ATTRIBUTES";
      }),
    },
    {
      name: "extra condition",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition.StringEquals[
          "aws:RequestedRegion"
        ] = REGION;
      }),
    },
    {
      name: "Attributes scalar changes the required list",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:Attributes"] = "pk";
      }),
    },
    {
      name: "LeadingKeys scalar changes the canonical condition shape",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"] = "DOMAIN";
      }),
    },
    {
      name: "Select array changes the canonical condition shape",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Condition.StringEquals[
          "dynamodb:Select"
        ] = ["SPECIFIC_ATTRIBUTES"];
      }),
    },
  ];

  for (const { name, policy } of driftedPolicies) {
    await t.test(name, () => {
      for (const mode of ["deploy", "postdeploy"]) {
        assert.throws(
          () => auditIdentityPolicy(policy, mode),
          /Identity API role inline policy/i,
          `${mode} accepted target drift: ${name}`,
        );
      }
    });
  }
});

test("Identity API predecessor rejects every broadened or extra policy shape", async (t) => {
  const driftedPolicies = [
    {
      name: "extra action",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement[0].Action.push("logs:CreateLogGroup");
        },
      ),
    },
    {
      name: "broadened action",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement[0].Action = "logs:*";
        },
      ),
    },
    {
      name: "extra resource",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement[0].Resource = [
            IDENTITY_LOG_GROUP_CHILD_ARN,
            `${IDENTITY_LOG_GROUP_CHILD_ARN}-other`,
          ];
        },
      ),
    },
    {
      name: "broadened resource",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement[0].Resource = "*";
        },
      ),
    },
    {
      name: "extra statement",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement.push({
            Action: "logs:DescribeLogGroups",
            Effect: "Allow",
            Resource: "*",
          });
        },
      ),
    },
    {
      name: "extra condition",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement[0].Condition = {
            StringEquals: {
              "aws:RequestedRegion": REGION,
            },
          };
        },
      ),
    },
  ];

  for (const { name, policy } of driftedPolicies) {
    await t.test(name, () => {
      for (const mode of ["deploy", "postdeploy"]) {
        assert.throws(
          () => auditIdentityPolicy(policy, mode),
          /Identity API role inline policy/i,
          `${mode} accepted predecessor drift: ${name}`,
        );
      }
    });
  }
});

test("Identity API target accepts safe canonical IAM equivalents", async (t) => {
  const equivalentPolicies = [
    {
      name: "reordered statements",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement.reverse();
      }),
    },
    {
      name: "reordered actions",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[0].Action.reverse();
      }),
    },
    {
      name: "reordered condition keys and Attributes",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        const query = policy.Statement[1];
        const attributes = query.Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:Attributes"].reverse();
        query.Condition = {
          StringEquals: {
            "dynamodb:Select": "SPECIFIC_ATTRIBUTES",
          },
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["DOMAIN"],
            "dynamodb:Attributes": attributes,
          },
        };
      }),
    },
    {
      name: "singleton Action array",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[1].Action = ["dynamodb:Query"];
      }),
    },
    {
      name: "singleton Resource arrays",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        for (const statement of policy.Statement) {
          statement.Resource = [statement.Resource];
        }
        policy.Statement.reverse();
      }),
    },
    {
      name: "irrelevant Sid values",
      policy: mutateIdentityPolicy(IDENTITY_TARGET_INLINE_POLICY, (policy) => {
        policy.Statement[0].Sid = "WriteIdentityLogs";
        policy.Statement[1].Sid = "ReadDomainCatalog";
      }),
    },
  ];

  for (const { name, policy } of equivalentPolicies) {
    await t.test(name, () => {
      for (const mode of ["deploy", "postdeploy"]) {
        const result = auditIdentityPolicy(policy, mode);
        assert.equal(
          result.evidence.runtimeRoles.roles.find(
            ({ roleName }) => roleName === IDENTITY_ROLE_NAME,
          ).acceptedPolicyState,
          "target",
          `${mode} rejected target canonical equivalent: ${name}`,
        );
      }
    });
  }
});

test("Identity API predecessor canonical equivalents remain deploy-only", async (t) => {
  const equivalentPolicies = [
    {
      name: "reordered actions and singleton Resource array",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement[0].Action.reverse();
          policy.Statement[0].Resource = [policy.Statement[0].Resource];
        },
      ),
    },
    {
      name: "irrelevant Sid value",
      policy: mutateIdentityPolicy(
        IDENTITY_PREDECESSOR_INLINE_POLICY,
        (policy) => {
          policy.Statement[0].Sid = "WriteIdentityLogs";
        },
      ),
    },
  ];

  for (const { name, policy } of equivalentPolicies) {
    await t.test(name, () => {
      const deploy = auditIdentityPolicy(policy, "deploy");
      assert.equal(
        deploy.evidence.runtimeRoles.roles.find(
          ({ roleName }) => roleName === IDENTITY_ROLE_NAME,
        ).acceptedPolicyState,
        "predecessor",
      );

      assert.throws(
        () => auditIdentityPolicy(policy, "postdeploy"),
        /Identity API role inline policy|target/i,
        `postdeploy accepted predecessor canonical equivalent: ${name}`,
      );
    });
  }
});

test("Identity API contract mutation matrix stays on the actual role audit path", () => {
  for (const policy of [
    IDENTITY_TARGET_INLINE_POLICY,
    IDENTITY_PREDECESSOR_INLINE_POLICY,
  ]) {
    const responses = githubEnabledResponses();
    responses.set(
      key(...identityRoleGetPolicyCommand()),
      JSON.stringify({
        PolicyDocument: structuredClone(policy),
        PolicyName: IDENTITY_POLICY_NAME,
        RoleName: IDENTITY_ROLE_NAME,
      }),
    );

    const result = auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "deploy",
      }),
      responses,
    }).options);
    assert.ok(
      result.evidence.runtimeRoles.roles.some(
        ({ roleName }) => roleName === IDENTITY_ROLE_NAME,
      ),
    );
  }
});

test("deploy accepts the prior workload identity scope only as a planned transition", () => {
  const previousTargetResponses = () => {
    const responses = githubEnabledResponses();
    responses.set(
      key(...adminRoleGetPolicyCommand()),
      JSON.stringify({
        PolicyDocument:
          PLATFORM_ADMIN_PREVIOUS_WORKLOAD_IDENTITY_INLINE_POLICY,
        PolicyName: PLATFORM_ADMIN_POLICY_NAME,
        RoleName: PLATFORM_ADMIN_ROLE_NAME,
      }),
    );
    return responses;
  };

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "deploy",
    }),
    responses: previousTargetResponses(),
  }).options);
  const adminRole = deploy.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === PLATFORM_ADMIN_ROLE_NAME,
  );
  assert.equal(adminRole.acceptedPolicyState, "predecessor");

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: previousTargetResponses(),
    }).options),
    /platform admin role inline policy|Task 5 target/i,
  );
});

test("deploy accepts the prior Registry readiness permission only as a planned transition", () => {
  const previousTargetResponses = () => {
    const responses = githubEnabledResponses();
    responses.set(
      key(...adminRoleGetPolicyCommand()),
      JSON.stringify({
        PolicyDocument: PLATFORM_ADMIN_PREVIOUS_TARGET_INLINE_POLICY,
        PolicyName: PLATFORM_ADMIN_POLICY_NAME,
        RoleName: PLATFORM_ADMIN_ROLE_NAME,
      }),
    );
    return responses;
  };

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "deploy",
    }),
    responses: previousTargetResponses(),
  }).options);
  const adminRole = deploy.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === PLATFORM_ADMIN_ROLE_NAME,
  );
  assert.equal(adminRole.acceptedPolicyState, "predecessor");

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: previousTargetResponses(),
    }).options),
    /platform admin role inline policy|Task 5 target/i,
  );
});

test("deploy accepts the Registry discoverable-read predecessor only as a planned transition", () => {
  const predecessorResponses = () => {
    const responses = githubEnabledResponses();
    responses.set(
      key(...adminRoleGetPolicyCommand()),
      JSON.stringify({
        PolicyDocument:
          PLATFORM_ADMIN_DISCOVERABLE_READ_PREDECESSOR_INLINE_POLICY,
        PolicyName: PLATFORM_ADMIN_POLICY_NAME,
        RoleName: PLATFORM_ADMIN_ROLE_NAME,
      }),
    );
    return responses;
  };

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "deploy",
    }),
    responses: predecessorResponses(),
  }).options);
  const adminRole = deploy.evidence.runtimeRoles.roles.find(
    ({ roleName }) => roleName === PLATFORM_ADMIN_ROLE_NAME,
  );
  assert.equal(adminRole.acceptedPolicyState, "predecessor");

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: predecessorResponses(),
    }).options),
    /platform admin role inline policy|Task 5 target/i,
  );
});

test("deploy accepts only the exact platform-admin transaction predecessor", () => {
  const predecessorResponses = () => {
    const responses = githubEnabledResponses();
    responses.set(
      key(...adminRoleGetPolicyCommand()),
      JSON.stringify({
        PolicyDocument:
          PLATFORM_ADMIN_LEGACY_TRANSACTION_INLINE_POLICY,
        PolicyName: PLATFORM_ADMIN_POLICY_NAME,
        RoleName: PLATFORM_ADMIN_ROLE_NAME,
      }),
    );
    return responses;
  };

  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: predecessorResponses(),
  }).options);
  assert.equal(
    deploy.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === PLATFORM_ADMIN_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-transaction-authorization",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: predecessorResponses(),
    }).options),
    /platform admin role inline policy|Task 5 target/i,
  );
});

test("postdeploy accepts complete IAM policy lists when pagination metadata is omitted", () => {
  const responses = githubEnabledResponses();
  const listCommands = [
    identityRoleListAttachedPoliciesCommand(),
    identityRoleListPoliciesCommand(),
    governanceRoleListAttachedPoliciesCommand(),
    governanceRoleListPoliciesCommand(),
    seedRoleListAttachedPoliciesCommand(),
    seedRoleListPoliciesCommand(),
    adminRoleListAttachedPoliciesCommand(),
    adminRoleListPoliciesCommand(),
    controlPlaneReadRoleListAttachedPoliciesCommand(),
    controlPlaneReadRoleListPoliciesCommand(),
    finalizerRoleListAttachedPoliciesCommand(),
    finalizerRoleListPoliciesCommand(),
    brokerRoleListAttachedPoliciesCommand(),
    brokerRoleListPoliciesCommand(),
    hostedAcceptanceRoleListAttachedPoliciesCommand(),
    hostedAcceptanceRoleListPoliciesCommand(),
  ];

  for (const command of listCommands) {
    const document = JSON.parse(responses.get(key(...command)));
    delete document.IsTruncated;
    delete document.Marker;
    responses.set(key(...command), JSON.stringify(document));
  }

  const result = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "postdeploy",
    }),
    responses,
  }).options);

  assert.equal(result.evidence.status, "passed");
});

test("deploy accepts only the exact prior control-plane read policy and postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  responses.set(
    key(...controlPlaneReadRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY,
      PolicyName: CONTROL_PLANE_READ_POLICY_NAME,
      RoleName: CONTROL_PLANE_READ_ROLE_NAME,
    }),
  );
  responses.set(
    key(...controlPlaneReadRoleGetXrayPolicyCommand()),
    JSON.stringify({
      PolicyDocument:
        CONTROL_PLANE_READ_GATEWAY_PREDECESSOR_XRAY_INLINE_POLICY,
      PolicyName: CONTROL_PLANE_READ_XRAY_POLICY_NAME,
      RoleName: CONTROL_PLANE_READ_ROLE_NAME,
    }),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(deployResult.evidence.status, "passed");
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === CONTROL_PLANE_READ_ROLE_NAME,
    ).acceptedPolicyState,
    "predecessor",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /control-plane read role|inline policy/i,
  );

  const driftedResponses = new Map(responses);
  const driftedPolicy = structuredClone(
    CONTROL_PLANE_READ_PREDECESSOR_INLINE_POLICY,
  );
  driftedPolicy.Statement[7].Resource = CONTROL_PLANE_ARNS.toolsGatewayArn;
  driftedResponses.set(
    key(...controlPlaneReadRoleGetPolicyCommand()),
    JSON.stringify({
      PolicyDocument: driftedPolicy,
      PolicyName: CONTROL_PLANE_READ_POLICY_NAME,
      RoleName: CONTROL_PLANE_READ_ROLE_NAME,
    }),
  );
  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses: driftedResponses,
    }).options),
    /control-plane read role|inline policy/i,
  );
});

test("deploy accepts only the exact prior CDK log-resource shape during transition", () => {
  const responses = githubEnabledResponses();
  for (const command of [
    seedRoleGetPolicyCommand(),
    adminRoleGetPolicyCommand(),
    finalizerRoleGetPolicyCommand(),
  ]) {
    const document = JSON.parse(responses.get(key(...command)));
    const logStatement = document.PolicyDocument.Statement.find(
      ({ Action }) => {
        const actions = Array.isArray(Action) ? Action : [Action];
        return (
          actions.includes("logs:CreateLogStream")
          && actions.includes("logs:PutLogEvents")
        );
      },
    );
    assert.ok(logStatement);
    logStatement.Resource += ":*";
    responses.set(key(...command), JSON.stringify(document));
  }

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(deployResult.evidence.status, "passed");
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === PLATFORM_ADMIN_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-log-resource",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /inline policy/i,
  );
});

test("deploy rejects a broker legacy log-resource variant", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  const logStatement = brokerPolicy.PolicyDocument.Statement.find(
    ({ Action }) =>
      Array.isArray(Action)
      && Action.includes("logs:CreateLogStream")
      && Action.includes("logs:PutLogEvents"),
  );
  assert.ok(logStatement);
  logStatement.Resource += ":*";
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("provision audit verifies every deployed control-plane role boundary", () => {
  const { calls, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses: provisionedControlPlaneResponses(),
  });

  const result = auditPredeploy(options);

  assert.deepEqual(result.evidence.controlPlaneRuntimeRoles, {
    boundaryName: CONTROL_PLANE_RUNTIME_BOUNDARY_NAME,
    required: true,
    roles: PROVISIONED_CONTROL_PLANE_ROLE_FIXTURES.map(({
      logicalResourceId,
      roleName,
    }) => ({
      arnMatches: true,
      boundaryMatches: true,
      logicalResourceId,
      roleName,
      tagsMatch: true,
      trustMatches: true,
    })),
    status: "passed",
  });
  assert.ok(
    calls.some(({ command, args }) =>
      key(command, args)
        === key(...COMMANDS.provisionedControlPlaneResources)
    ),
  );
  for (const roleName of PROVISIONED_CONTROL_PLANE_ROLE_NAMES) {
    assert.ok(
      calls.some(({ command, args }) =>
        key(command, args) === key(...runtimeRoleCommand(roleName))
      ),
      roleName,
    );
  }
});

test("deploy accepts the registered 940713a control-plane boundary predecessor and postdeploy requires the target", () => {
  const predecessorDocument = structuredClone(
    LEGACY_CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY,
  );
  predecessorDocument.Statement.find(
    ({ Sid }) => Sid === "InvokeControlPlaneProviderFunctions",
  ).Resource = [
    `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
      + `function:${CONTROL_PLANE_ROLE_PREFIX}*`,
  ];
  predecessorDocument.Statement.find(
    ({ Sid }) => Sid === "StartControlPlaneProviderWaiter",
  ).Resource = [
    `arn:aws:states:${REGION}:${ACCOUNT_ID}:`
      + `stateMachine:${CONTROL_PLANE_ROLE_PREFIX}*`,
  ];
  predecessorDocument.Statement.find(
    ({ Sid }) => Sid === "CreateTaggedControlPlaneRegistryRecords",
  ).Resource = [
    `arn:aws:agent-registry:${REGION}:${ACCOUNT_ID}:registry/*`,
  ];
  const responses = provisionedControlPlaneResponses();
  responses.set(
    key(...COMMANDS.controlPlaneBoundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document: predecessorDocument,
        IsDefaultVersion: true,
        VersionId: "v1",
      },
    }),
  );

  const deploy = auditPredeploy(fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  }).options);
  assert.equal(deploy.evidence.status, "passed");
  assert.equal(deploy.evidence.controlPlaneRuntimeBoundary.status, "passed");
  assert.equal(
    deploy.evidence.controlPlaneRuntimeBoundary.policyMatches,
    true,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: provisionedControlPlaneEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /control-plane runtime permissions boundary.*drift/i,
  );
});

test("deploy still rejects an unregistered third control-plane boundary version", () => {
  const unregisteredDocument = structuredClone(
    CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY,
  );
  unregisteredDocument.Statement.find(
    ({ Sid }) => Sid === "InvokeControlPlaneProviderFunctions",
  ).Resource = [
    `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:`
      + "function:SomeOtherPrefix-*",
  ];
  const responses = provisionedControlPlaneResponses();
  responses.set(
    key(...COMMANDS.controlPlaneBoundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document: unregisteredDocument,
        IsDefaultVersion: true,
        VersionId: "v1",
      },
    }),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /control-plane runtime permissions boundary.*drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deployment audit fails closed for missing or drifted control-plane boundary enforcement", () => {
  const failureCases = [
    {
      expectedError: /control-plane runtime permissions boundary|command failed/i,
      mutate(responses) {
        responses.set(
          key(...COMMANDS.controlPlaneBoundaryGet),
          new AuditCommandError(
            "aws",
            COMMANDS.controlPlaneBoundaryGet.slice(1),
            {
              status: 254,
              stderr:
                "An error occurred (NoSuchEntity) when calling the GetPolicy operation.",
            },
          ),
        );
      },
      name: "missing boundary",
    },
    {
      expectedError: /control-plane runtime permissions boundary.*drift/i,
      mutate(responses) {
        const document = structuredClone(
          CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY,
        );
        document.Statement.push({
          Sid: "Escalate",
          Effect: "Allow",
          Action: ["iam:PassRole"],
          Resource: ["*"],
        });
        responses.set(
          key(...COMMANDS.controlPlaneBoundaryVersion),
          JSON.stringify({
            PolicyVersion: {
              Document: document,
              IsDefaultVersion: true,
              VersionId: "v1",
            },
          }),
        );
      },
      name: "boundary policy drift",
    },
    {
      expectedError: /execution role.*boundary enforcement|CreateRole/i,
      mutate(responses) {
        const document = structuredClone(
          CONTROL_PLANE_DEPLOYMENT_POLICY,
        );
        const statement = document.Statement.find(
          ({ Sid }) => Sid === "CreateControlPlaneIamRolesWithBoundary",
        );
        assert.ok(statement);
        delete statement.Condition.StringEquals[
          "iam:PermissionsBoundary"
        ];
        responses.set(
          key(...managedPolicyVersionCommand(
            CONTROL_PLANE_DEPLOYMENT_POLICY_NAME,
          )),
          JSON.stringify({
            PolicyVersion: {
              Document: document,
              IsDefaultVersion: true,
              VersionId: "v1",
            },
          }),
        );
      },
      name: "unbounded CreateRole",
    },
    {
      expectedError: /execution role.*trust/i,
      mutate(responses) {
        const document = JSON.parse(
          responses.get(key(...executionRoleCommand())),
        );
        document.Role.AssumeRolePolicyDocument.Statement.push({
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${ACCOUNT_ID}:root` },
          Action: "sts:AssumeRole",
        });
        responses.set(
          key(...executionRoleCommand()),
          JSON.stringify(document),
        );
      },
      name: "execution role trust drift",
    },
  ];

  for (const { expectedError, mutate, name } of failureCases) {
    const responses = provisionedControlPlaneResponses();
    mutate(responses);
    const { evidenceWrites, options } = fixture({
      env: provisionedControlPlaneEnvironment(),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError, name);
    assert.equal(evidenceWrites[0].evidence.status, "failed", name);
  }
});

test("provision audit fails closed when any deployed role boundary is missing or drifted", () => {
  for (const permissionsBoundary of [
    undefined,
    {
      PermissionsBoundaryArn:
        `arn:aws:iam::${ACCOUNT_ID}:policy/AnotherBoundary`,
      PermissionsBoundaryType: "Policy",
    },
  ]) {
    const roleName = PROVISIONED_CONTROL_PLANE_ROLE_NAMES[0];
    const responses = provisionedControlPlaneResponses();
    const command = runtimeRoleCommand(roleName);
    const document = JSON.parse(responses.get(key(...command)));
    if (permissionsBoundary === undefined) {
      delete document.Role.PermissionsBoundary;
    } else {
      document.Role.PermissionsBoundary = permissionsBoundary;
    }
    responses.set(
      key(...command),
      JSON.stringify(document),
    );
    const { evidenceWrites, options } = fixture({
      env: provisionedControlPlaneEnvironment(),
      responses,
    });

    assert.throws(
      () => auditPredeploy(options),
      /provisioned control-plane role.*exact runtime permissions boundary/i,
    );
    assert.equal(
      evidenceWrites[0].evidence.controlPlaneRuntimeRoles.status,
      "failed",
    );
  }
});

test("deployment audit treats IAM action names case-insensitively", () => {
  const responses = provisionedControlPlaneResponses();
  const policyName = CONTROL_PLANE_EXECUTION_POLICY_NAMES[0];
  responses.set(
    key(...managedPolicyVersionCommand(policyName)),
    JSON.stringify({
      PolicyVersion: {
        Document: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Action: "IAM:CreateRole",
            Resource: CONTROL_PLANE_ROLE_ARN,
          }],
        },
        IsDefaultVersion: true,
        VersionId: "v1",
      },
    }),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /alternate unbounded CreateRole/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deployment audit rejects alternate IAM escalation paths outside the control-plane prefix", () => {
  const responses = provisionedControlPlaneResponses();
  const policyName = CONTROL_PLANE_EXECUTION_POLICY_NAMES[0];
  responses.set(
    key(...managedPolicyVersionCommand(policyName)),
    JSON.stringify({
      PolicyVersion: {
        Document: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Action: [
              "IAM:CreateRole",
              "iam:PutRolePolicy",
              "iam:PassRole",
            ],
            Resource:
              `arn:aws:iam::${ACCOUNT_ID}:role/UnboundedDeploymentRole`,
          }],
        },
        IsDefaultVersion: true,
        VersionId: "v1",
      },
    }),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /alternate unbounded CreateRole/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

for (const { action, resource } of [
  {
    action: "IAM:PutRolePolicy",
    resource: `arn:aws:iam::${ACCOUNT_ID}:role/UnboundedDeploymentRole`,
  },
  {
    action: "iam:AttachRolePolicy",
    resource: `arn:aws:iam::${ACCOUNT_ID}:role/UnboundedDeploymentRole`,
  },
  {
    action: "iAm:UpdateAssumeRolePolicy",
    resource: `arn:aws:iam::${ACCOUNT_ID}:role/UnboundedDeploymentRole`,
  },
  {
    action: "IAM:CreatePolicyVersion",
    resource: `arn:aws:iam::${ACCOUNT_ID}:policy/UnboundedDeploymentPolicy`,
  },
  {
    action: "iam:SetDefaultPolicyVersion",
    resource: `arn:aws:iam::${ACCOUNT_ID}:policy/UnboundedDeploymentPolicy`,
  },
  {
    action: "iam:DeletePolicyVersion",
    resource: `arn:aws:iam::${ACCOUNT_ID}:policy/UnboundedDeploymentPolicy`,
  },
  {
    action: "IaM:*PolicyVersion",
    resource: `arn:aws:iam::${ACCOUNT_ID}:policy/UnboundedDeploymentPolicy`,
  },
]) {
  test(`deployment audit rejects alternate IAM escalation action ${action}`, () => {
    const responses = provisionedControlPlaneResponses();
    const policyName = CONTROL_PLANE_EXECUTION_POLICY_NAMES[0];
    responses.set(
      key(...managedPolicyVersionCommand(policyName)),
      JSON.stringify({
        PolicyVersion: {
          Document: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Action: action,
              Resource: resource,
            }],
          },
          IsDefaultVersion: true,
          VersionId: "v1",
        },
      }),
    );
    const { evidenceWrites, options } = fixture({
      env: provisionedControlPlaneEnvironment(),
      responses,
    });

    assert.throws(
      () => auditPredeploy(options),
      /alternate unbounded.*IAM|alternate IAM escalation/i,
    );
    assert.equal(evidenceWrites[0].evidence.status, "failed");
  });
}

for (const { label, statement } of [
  {
    label: "NotAction",
    statement: {
      Effect: "Allow",
      NotAction: "iam:GetRole",
      Resource:
        `arn:aws:iam::${ACCOUNT_ID}:role/UnboundedDeploymentRole`,
      Condition: {
        StringEquals: {
          "aws:ResourceTag/project": "another-project",
        },
      },
    },
  },
  {
    label: "iam:*",
    statement: {
      Effect: "Allow",
      Action: "iam:*",
      Resource:
        `arn:aws:iam::${ACCOUNT_ID}:role/UnboundedDeploymentRole`,
      Condition: {
        StringLike: {
          "iam:PermissionsBoundary":
            `arn:aws:iam::${ACCOUNT_ID}:policy/*`,
        },
      },
    },
  },
  {
    label: "global *",
    statement: {
      Effect: "Allow",
      Action: "*",
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:RequestedRegion": REGION,
        },
      },
    },
  },
  {
    label: "iam:PutRolePolic?",
    statement: {
      Effect: "Allow",
      Action: "iam:PutRolePolic?",
      Resource:
        `arn:aws:iam::${ACCOUNT_ID}:role/UnboundedDeploymentRole`,
      Condition: {
        StringEquals: {
          "aws:ResourceTag/auto-delete": "yes",
        },
      },
    },
  },
  {
    label: "iam:*PolicyVersion",
    statement: {
      Effect: "Allow",
      Action: "iam:*PolicyVersion",
      Resource:
        `arn:aws:iam::${ACCOUNT_ID}:policy/UnboundedDeploymentPolicy`,
      Condition: {
        ArnLike: {
          "iam:PolicyARN": `arn:aws:iam::${ACCOUNT_ID}:policy/*`,
        },
      },
    },
  },
]) {
  test(
    `deployment audit rejects noncanonical sensitive IAM mutation via ${label}`,
    () => {
      const responses = provisionedControlPlaneResponses();
      const policyName = CONTROL_PLANE_EXECUTION_POLICY_NAMES[0];
      responses.set(
        key(...managedPolicyVersionCommand(policyName)),
        JSON.stringify({
          PolicyVersion: {
            Document: {
              Version: "2012-10-17",
              Statement: [statement],
            },
            IsDefaultVersion: true,
            VersionId: "v1",
          },
        }),
      );
      const { evidenceWrites, options } = fixture({
        env: provisionedControlPlaneEnvironment(),
        responses,
      });

      assertAuditValidationCode(
        options,
        "CONTROL_PLANE_EXECUTION_ALTERNATE_ROLE_PATH",
      );
      assert.equal(evidenceWrites[0].evidence.status, "failed");
    },
  );
}

for (const { expectedCode, label, mutate } of [
  {
    expectedCode: "CONTROL_PLANE_EXECUTION_ATTACHED_POLICY_DRIFT",
    label: "an extra attached policy",
    mutate(attachedPolicies) {
      attachedPolicies.push({
        PolicyArn:
          `arn:aws:iam::${ACCOUNT_ID}:policy/UnexpectedExecutionPolicy`,
        PolicyName: "UnexpectedExecutionPolicy",
      });
    },
  },
  {
    expectedCode: "CONTROL_PLANE_EXECUTION_ATTACHED_POLICY_DRIFT",
    label: "a missing attached policy",
    mutate(attachedPolicies) {
      attachedPolicies.pop();
    },
  },
  {
    expectedCode: "INVALID_CONTROL_PLANE_EXECUTION_ATTACHED_POLICY",
    label: "a duplicate attached policy name",
    mutate(attachedPolicies) {
      attachedPolicies.push({ ...attachedPolicies[0] });
    },
  },
  {
    expectedCode: "INVALID_CONTROL_PLANE_EXECUTION_ATTACHED_POLICY",
    label: "a duplicate attached policy ARN",
    mutate(attachedPolicies) {
      attachedPolicies[1].PolicyArn = attachedPolicies[0].PolicyArn;
    },
  },
]) {
  test(`deployment audit rejects ${label}`, () => {
    const responses = provisionedControlPlaneResponses();
    const commandKey = key(...executionRoleListAttachedPoliciesCommand());
    const document = JSON.parse(responses.get(commandKey));
    mutate(document.AttachedPolicies);
    responses.set(commandKey, JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: provisionedControlPlaneEnvironment(),
      responses,
    });

    assertAuditValidationCode(options, expectedCode);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
  });
}

test("deployment audit rejects a paginated attached policy list", () => {
  const responses = provisionedControlPlaneResponses();
  const commandKey = key(...executionRoleListAttachedPoliciesCommand());
  const document = JSON.parse(responses.get(commandKey));
  document.IsTruncated = true;
  document.Marker = "next-attached-policy-page";
  responses.set(commandKey, JSON.stringify(document));
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assertAuditValidationCode(
    options,
    "INVALID_CONTROL_PLANE_EXECUTION_POLICY_LIST",
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

for (const { expectedCode, label, policyNames } of [
  {
    expectedCode: "INVALID_CONTROL_PLANE_EXECUTION_INLINE_POLICY",
    label: "an extra inline policy",
    policyNames: [
      CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME,
      "UnexpectedExecutionInlinePolicy",
    ],
  },
  {
    expectedCode: "CONTROL_PLANE_EXECUTION_INLINE_POLICY_MISMATCH",
    label: "a missing canonical inline policy",
    policyNames: ["UnexpectedExecutionInlinePolicy"],
  },
  {
    expectedCode: "INVALID_CONTROL_PLANE_EXECUTION_INLINE_POLICY",
    label: "a duplicate inline policy name",
    policyNames: [
      CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME,
      CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME,
    ],
  },
  {
    expectedCode: "INVALID_CONTROL_PLANE_EXECUTION_INLINE_POLICY",
    label: "a malformed inline policy name",
    policyNames: [null],
  },
]) {
  test(`deployment audit rejects ${label}`, () => {
    const responses = provisionedControlPlaneResponses();
    const commandKey = key(...executionRoleListPoliciesCommand());
    responses.set(
      commandKey,
      JSON.stringify({
        IsTruncated: false,
        PolicyNames: policyNames,
      }),
    );
    if (label === "a missing canonical inline policy") {
      responses.set(
        key(...executionRoleGetPolicyCommand(policyNames[0])),
        JSON.stringify({
          PolicyDocument:
            EXPECTED_CONTROL_PLANE_EXECUTION_POLICIES.inlinePolicy,
          PolicyName: policyNames[0],
          RoleName: CLOUDFORMATION_EXECUTION_ROLE_NAME,
        }),
      );
    }
    const { evidenceWrites, options } = fixture({
      env: provisionedControlPlaneEnvironment(),
      responses,
    });

    assertAuditValidationCode(options, expectedCode);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
  });
}

test("deployment audit rejects a paginated inline policy list", () => {
  const responses = provisionedControlPlaneResponses();
  const commandKey = key(...executionRoleListPoliciesCommand());
  const document = JSON.parse(responses.get(commandKey));
  document.IsTruncated = true;
  document.Marker = "next-inline-policy-page";
  responses.set(commandKey, JSON.stringify(document));
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assertAuditValidationCode(
    options,
    "INVALID_CONTROL_PLANE_EXECUTION_POLICY_LIST",
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deployment audit preserves exact bounded Stage 1 role permissions", () => {
  const responses = provisionedControlPlaneResponses();
  const webRoleArns = [
    "AccessAdminApiRole",
    "AgentRuntimeRole",
    "BuilderApiRole",
    "IdentityApiRole",
    "JourneyApiRole",
    "DeploymentApiRole",
    "FrontendDeploymentRole",
    "CloudFrontInvalidationProviderRole",
    "CloudFrontAlarmProviderRole",
    "ControlPlaneReadApiRole",
    "PlatformAdminApiRole",
    "PlatformAgentRegistrySeedRole",
    "RegistryDecisionFinalizerRole",
    "PlatformStateSeedRole",
    "PlatformWorkspaceSeedRole",
    "HostedAcceptanceBrokerRole",
    "RuntimeBoundaryTagProviderRole",
    "RuntimeProofConfiguratorRole",
    "RuntimeProofProviderRole",
    "WorkspaceApiRole",
    "ExperienceApiRole",
    "GatewayInvokerRole",
    "GovernanceApiRole",
    "ModelGovernanceApiRole",
    "OperationsApiRole",
  ].map((suffix) =>
    `arn:aws:iam::${ACCOUNT_ID}:role/AgenticPlatform-Web-${suffix}`
  ).sort();
  const hostedAcceptanceRoleArn =
    `arn:aws:iam::${ACCOUNT_ID}:role/`
    + "AgenticPlatform-Web-HostedAcceptanceRole";
  const managementPolicy = JSON.parse(
    responses.get(key(...managedPolicyVersionCommand(
      CONTROL_PLANE_EXECUTION_POLICY_NAMES[0],
    ))),
  ).PolicyVersion.Document;
  const sortedStatementResources = (statement) => ({
    ...statement,
    Resource: [statement.Resource].flat().sort(),
  });
  assert.deepEqual(
    sortedStatementResources(
      managementPolicy.Statement.find(
        ({ Sid }) => Sid === "CreateWebRoles",
      ),
    ),
    {
      Sid: "CreateWebRoles",
      Effect: "Allow",
      Action: "iam:CreateRole",
      Resource: webRoleArns,
      Condition: {
        StringEquals: {
          "iam:PermissionsBoundary": RUNTIME_BOUNDARY_ARN,
        },
      },
    },
  );
  assert.deepEqual(
    managementPolicy.Statement.find(
      ({ Sid }) => Sid === "CreateAcceptance",
    ),
    {
      Sid: "CreateAcceptance",
      Effect: "Allow",
      Action: "iam:CreateRole",
      Resource: hostedAcceptanceRoleArn,
      Condition: {
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["auto-delete", "managedBy", "project"],
        },
        StringEquals: {
          "aws:RequestTag/auto-delete": "no",
          "aws:RequestTag/managedBy": "cdk",
          "aws:RequestTag/project": "agentic-ai-platform-demo",
        },
      },
    },
  );
  const delegationPolicy = JSON.parse(
    responses.get(key(...managedPolicyVersionCommand(
      CONTROL_PLANE_EXECUTION_POLICY_NAMES[1],
    ))),
  ).PolicyVersion.Document;
  const boundaryPolicy = JSON.parse(
    responses.get(key(...managedPolicyVersionCommand(
      CONTROL_PLANE_EXECUTION_POLICY_NAMES[2],
    ))),
  ).PolicyVersion.Document;
  assert.deepEqual(
    sortedStatementResources(
      delegationPolicy.Statement.find(
        ({ Sid }) => Sid === "ApplyStage1RoleBoundary",
      ),
    ),
    {
      Sid: "ApplyStage1RoleBoundary",
      Effect: "Allow",
      Action: "iam:PutRolePermissionsBoundary",
      Resource: webRoleArns,
      Condition: {
        StringEquals: {
          "iam:PermissionsBoundary": RUNTIME_BOUNDARY_ARN,
        },
      },
    },
  );
  assert.deepEqual(
    sortedStatementResources(
      boundaryPolicy.Statement.find(
        ({ Sid }) => Sid === "DenyStage1RoleBoundaryRemoval",
      ),
    ),
    {
      Sid: "DenyStage1RoleBoundaryRemoval",
      Effect: "Deny",
      Action: "iam:DeleteRolePermissionsBoundary",
      Resource: webRoleArns,
    },
  );
  assert.deepEqual(
    sortedStatementResources(
      delegationPolicy.Statement.find(
        ({ Sid }) => Sid === "PassStage1RolesToLambda",
      ),
    ),
    {
      Sid: "PassStage1RolesToLambda",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: webRoleArns,
      Condition: {
        StringEquals: {
          "iam:PassedToService": "lambda.amazonaws.com",
        },
      },
    },
  );

  const result = auditPredeploy(fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  }).options);

  assert.equal(result.evidence.status, "passed");
});

test("deployment audit rejects a truncated execution-role managed policy", () => {
  const responses = provisionedControlPlaneResponses();
  const policyName = CONTROL_PLANE_EXECUTION_POLICY_NAMES[0];
  responses.set(
    key(...managedPolicyVersionCommand(policyName)),
    JSON.stringify({
      PolicyVersion: {
        Document: {
          Version: "2012-10-17",
          Statement: [],
        },
        IsDefaultVersion: true,
        VersionId: "v1",
      },
    }),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /execution-role managed policy.*drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deployment audit rejects a missing required managed-policy action", () => {
  const responses = provisionedControlPlaneResponses();
  const policyName = CONTROL_PLANE_DEPLOYMENT_POLICY_NAME;
  const response = JSON.parse(
    responses.get(key(...managedPolicyVersionCommand(policyName))),
  );
  const statement = response.PolicyVersion.Document.Statement.find(
    ({ Sid }) => Sid === "ManageControlPlaneLambda",
  );
  assert.ok(statement);
  statement.Action = statement.Action.filter(
    (action) => action !== "lambda:UpdateFunctionCode",
  );
  responses.set(
    key(...managedPolicyVersionCommand(policyName)),
    JSON.stringify(response),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /execution-role managed policy.*drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deployment audit rejects missing Runtime observability resource-policy access", () => {
  const responses = provisionedControlPlaneResponses();
  const policyName =
    "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment";
  const response = JSON.parse(
    responses.get(key(...managedPolicyVersionCommand(policyName))),
  );
  const statement = response.PolicyVersion.Document.Statement.find(
    ({ Sid }) => Sid === "ManageStage1LogsDeliveryResourcePolicy",
  );
  assert.ok(statement);
  statement.Action = statement.Action.filter(
    (action) => action !== "logs:PutResourcePolicy",
  );
  responses.set(
    key(...managedPolicyVersionCommand(policyName)),
    JSON.stringify(response),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /execution-role managed policy.*drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deployment audit rejects missing Registry mutation tag conditions", () => {
  const responses = provisionedControlPlaneResponses();
  const response = JSON.parse(
    responses.get(
      key(...managedPolicyVersionCommand(
        CONTROL_PLANE_REGISTRY_DEPLOYMENT_POLICY_NAME,
      )),
    ),
  );
  const statement = response.PolicyVersion.Document.Statement.find(
    ({ Action }) =>
      [Action].flat().includes("agent-registry:CreateRegistryRecord"),
  );
  assert.ok(statement);
  delete statement.Condition;
  responses.set(
    key(...managedPolicyVersionCommand(
      CONTROL_PLANE_REGISTRY_DEPLOYMENT_POLICY_NAME,
    )),
    JSON.stringify(response),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /execution-role managed policy.*drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("deployment audit rejects a truncated execution-role inline policy", () => {
  const responses = provisionedControlPlaneResponses();
  const [policyName] = JSON.parse(
    responses.get(key(...executionRoleListPoliciesCommand())),
  ).PolicyNames;
  responses.set(
    key(...executionRoleGetPolicyCommand(policyName)),
    JSON.stringify({
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [],
      },
      PolicyName: policyName,
      RoleName: CLOUDFORMATION_EXECUTION_ROLE_NAME,
    }),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /execution-role inline policy.*drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("provision audit fails closed on provisioned role trust drift", () => {
  for (const { roleName } of PROVISIONED_CONTROL_PLANE_ROLE_FIXTURES) {
    const responses = provisionedControlPlaneResponses();
    const command = runtimeRoleCommand(roleName);
    const document = JSON.parse(responses.get(key(...command)));
    document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
      AWS: `arn:aws:iam::${ACCOUNT_ID}:root`,
    };
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: provisionedControlPlaneEnvironment(),
      responses,
    });

    assert.throws(
      () => auditPredeploy(options),
      /provisioned control-plane role.*trust/i,
      roleName,
    );
    assert.equal(
      evidenceWrites[0].evidence.controlPlaneRuntimeRoles.status,
      "failed",
      roleName,
    );
  }
});

test("provision audit fails closed on Gateway role trust condition drift", () => {
  const gatewayRoles = PROVISIONED_CONTROL_PLANE_ROLE_FIXTURES.filter(
    ({ service }) => service === "bedrock-agentcore.amazonaws.com",
  );
  const mutations = [
    (statement) => {
      delete statement.Condition;
    },
    (statement) => {
      statement.Condition.StringEquals["aws:SourceAccount"] =
        "999999999999";
    },
    (statement) => {
      statement.Condition.ArnLike["aws:SourceArn"] = "*";
    },
  ];

  for (const { roleName } of gatewayRoles) {
    for (const mutate of mutations) {
      const responses = provisionedControlPlaneResponses();
      const command = runtimeRoleCommand(roleName);
      const document = JSON.parse(responses.get(key(...command)));
      mutate(document.Role.AssumeRolePolicyDocument.Statement[0]);
      responses.set(key(...command), JSON.stringify(document));
      const { evidenceWrites, options } = fixture({
        env: provisionedControlPlaneEnvironment(),
        responses,
      });

      assert.throws(
        () => auditPredeploy(options),
        /provisioned control-plane role.*trust/i,
        roleName,
      );
      assert.equal(
        evidenceWrites[0].evidence.controlPlaneRuntimeRoles.status,
        "failed",
        roleName,
      );
    }
  }
});

test("provision audit fails closed on provisioned role tag drift", () => {
  for (const { roleName } of PROVISIONED_CONTROL_PLANE_ROLE_FIXTURES) {
    const responses = provisionedControlPlaneResponses();
    const command = runtimeRoleCommand(roleName);
    const document = JSON.parse(responses.get(key(...command)));
    document.Role.Tags = document.Role.Tags.filter(
      ({ Key }) => Key !== "auto-delete",
    );
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: provisionedControlPlaneEnvironment(),
      responses,
    });

    assert.throws(
      () => auditPredeploy(options),
      /provisioned control-plane role.*mandatory tags/i,
      roleName,
    );
    assert.equal(
      evidenceWrites[0].evidence.controlPlaneRuntimeRoles.status,
      "failed",
      roleName,
    );
  }
});

test("provision audit rejects unknown provisioned role logical IDs", () => {
  const responses = provisionedControlPlaneResponses();
  const document = JSON.parse(
    responses.get(key(...COMMANDS.provisionedControlPlaneResources)),
  );
  document.StackResourceSummaries[0].LogicalResourceId =
    "UnexpectedControlPlaneRoleABC123";
  responses.set(
    key(...COMMANDS.provisionedControlPlaneResources),
    JSON.stringify(document),
  );
  const { evidenceWrites, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /provisioned control-plane role inventory|logical/i,
  );
  assert.equal(
    evidenceWrites[0].evidence.controlPlaneRuntimeRoles.status,
    "failed",
  );
});

test("deploy rejects prior broker record-tag resource variants", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  const tagStatement = brokerPolicy.PolicyDocument.Statement.find(
    ({ Action }) => Action === "agent-registry:TagResource",
  );
  assert.deepEqual(tagStatement.Resource, [
    CONTROL_PLANE_ARNS.sharedRegistryArn,
    `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
  ]);
  tagStatement.Resource = `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`;
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts the exact prior broad broker policy but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument = priorHostedAcceptanceBrokerInlinePolicy();
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-broad-state-partitions",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts the exact pre-business-domain broker fixture scope but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument =
    priorBusinessDomainFixtureBrokerInlinePolicy();
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-pre-business-domain-experience-fixture-scope",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts the exact pre-approval-cleanup broker scope but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument =
    priorBusinessDomainApprovalCleanupBrokerInlinePolicy();
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-pre-business-domain-approval-cleanup-scope",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts the pre-agent-building acceptance broker policy but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument =
    priorAgentBuildingAcceptanceBrokerInlinePolicy();
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-pre-agent-building-acceptance-cleanup",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts the broker predecessor without Registry workload identity cleanup but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument.Statement =
    brokerPolicy.PolicyDocument.Statement.filter(
      ({ Sid }) =>
        Sid !== "DeleteHostedAcceptanceRegistryWorkloadIdentity",
    );
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-without-registry-workload-identity-delete",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts the exact child-scoped Registry workload identity predecessor but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument.Statement.find(
    ({ Sid }) => Sid === "DeleteHostedAcceptanceRegistryWorkloadIdentity",
  ).Resource =
    `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
    + "workload-identity-directory/default/workload-identity/registry-*";
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-child-scoped-registry-workload-identity-delete",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts the exact directory-only Registry workload identity predecessor but postdeploy rejects it", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument.Statement.find(
    ({ Sid }) => Sid === "DeleteHostedAcceptanceRegistryWorkloadIdentity",
  ).Resource =
    `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
    + "workload-identity-directory/default";
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-directory-only-registry-workload-identity-delete",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts only the exact broker predecessor without experience recovery Query", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument.Statement =
    brokerPolicy.PolicyDocument.Statement.filter(({ Action, Condition }) =>
      !(
        Action === "dynamodb:Query"
        && Condition?.["ForAllValues:StringLike"]
          ?.["dynamodb:LeadingKeys"]?.[0] === "ENTITLEMENT#*"
      )
    );
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(deployResult.evidence.status, "passed");
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-without-experience-recovery-query",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("broker audit requires the exact governed Runtime and Production endpoint ARNs", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  const runtime = brokerPolicy.PolicyDocument.Statement.find(
    ({ Action }) => Action === "bedrock-agentcore:GetAgentRuntime",
  );
  const endpoint = brokerPolicy.PolicyDocument.Statement.find(
    ({ Action }) =>
      Action === "bedrock-agentcore:GetAgentRuntimeEndpoint",
  );
  assert.equal(
    auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options).evidence.status,
    "passed",
  );
  assert.deepEqual(endpoint.Resource, [
    AGENT_RUNTIME_EXACT_ARN,
    AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN,
  ]);

  for (const [runtimeResource, endpointResource] of [
    [
      AGENT_RUNTIME_ARN,
      [
        AGENT_RUNTIME_EXACT_ARN,
        AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN,
      ],
    ],
    [
      AGENT_RUNTIME_EXACT_ARN,
      [AGENT_RUNTIME_EXACT_ARN, AGENT_RUNTIME_ENDPOINT_ARN_PATTERN],
    ],
    [
      `arn:aws:bedrock-agentcore:${REGION}:999999999999:`
        + `runtime/${AGENT_RUNTIME_ID}`,
      [
        AGENT_RUNTIME_EXACT_ARN,
        AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN,
      ],
    ],
    [AGENT_RUNTIME_EXACT_ARN, AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN],
    [AGENT_RUNTIME_EXACT_ARN, [AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN]],
    [AGENT_RUNTIME_EXACT_ARN, [AGENT_RUNTIME_EXACT_ARN]],
  ]) {
    runtime.Resource = runtimeResource;
    endpoint.Resource = endpointResource;
    responses.set(
      key(...brokerRoleGetPolicyCommand()),
      JSON.stringify(brokerPolicy),
    );
    assert.throws(
      () => auditPredeploy(fixture({
        env: githubEnabledEnvironment({
          SECURITY_AUDIT_MODE: "postdeploy",
        }),
        responses,
      }).options),
      /runtime resources|inline policy/i,
    );
  }
});

test("deploy accepts only the exact broker endpoint-only predecessor", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  const endpoint = brokerPolicy.PolicyDocument.Statement.find(
    ({ Action }) =>
      Action === "bedrock-agentcore:GetAgentRuntimeEndpoint",
  );
  endpoint.Resource = AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN;
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(deployResult.evidence.status, "passed");
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-endpoint-only-resource",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );

  brokerPolicy.PolicyDocument.Statement =
    brokerPolicy.PolicyDocument.Statement.filter(({ Action }) =>
      Action !== "dynamodb:Query"
    );
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );
  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy accepts only the exact broker legacy transaction authorization", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  brokerPolicy.PolicyDocument = priorHostedAcceptanceBrokerInlinePolicy();
  const fixtureLeadingKeys = [
    "AGENT#*",
    "DEPLOYMENT#*",
    "ENTITLEMENT#*",
    "PROJECT#*",
  ];
  brokerPolicy.PolicyDocument.Statement =
    brokerPolicy.PolicyDocument.Statement.filter(({ Action, Condition }) =>
      !(
        Action === "dynamodb:GetItem"
        && JSON.stringify(
          Condition?.["ForAllValues:StringLike"]
            ?.["dynamodb:LeadingKeys"],
        ) === JSON.stringify(fixtureLeadingKeys)
      )
      && !(
        JSON.stringify(Action)
          === JSON.stringify(["dynamodb:DeleteItem", "dynamodb:PutItem"])
        && JSON.stringify(
          Condition?.["ForAnyValue:StringEquals"]
            ?.["dynamodb:EnclosingOperation"],
        ) === JSON.stringify(["TransactWriteItems"])
      )
    );
  brokerPolicy.PolicyDocument.Statement.push({
    Action: ["dynamodb:GetItem", "dynamodb:TransactWriteItems"],
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": fixtureLeadingKeys,
      },
    },
    Effect: "Allow",
    Resource: PLATFORM_STATE_TABLE_ARN,
  });
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(deployResult.evidence.status, "passed");
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
    ).acceptedPolicyState,
    "legacy-transaction-authorization",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /broker role|inline policy/i,
  );

  brokerPolicy.PolicyDocument.Statement.find(
    ({ Action }) =>
      Action === "bedrock-agentcore:GetAgentRuntimeEndpoint",
  ).Resource = AGENT_RUNTIME_PRODUCTION_ENDPOINT_ARN;
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );
  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy rejects prior broker record-create resource variants", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  const createStatement = brokerPolicy.PolicyDocument.Statement.find(
    ({ Action }) => Action === "agent-registry:CreateRegistryRecord",
  );
  assert.deepEqual(createStatement.Resource, [
    CONTROL_PLANE_ARNS.sharedRegistryArn,
    `${CONTROL_PLANE_ARNS.sharedRegistryArn}/record/*`,
  ]);
  createStatement.Resource = CONTROL_PLANE_ARNS.sharedRegistryArn;
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("deploy rejects CDK-merged broker create-tag statement variants", () => {
  const responses = githubEnabledResponses();
  const brokerPolicy = JSON.parse(
    responses.get(key(...brokerRoleGetPolicyCommand())),
  );
  const statements = brokerPolicy.PolicyDocument.Statement;
  const createIndex = statements.findIndex(
    ({ Action }) => Action === "agent-registry:CreateRegistryRecord",
  );
  const tagIndex = statements.findIndex(
    ({ Action }) => Action === "agent-registry:TagResource",
  );
  assert.notEqual(createIndex, -1);
  assert.notEqual(tagIndex, -1);
  const createStatement = statements[createIndex];
  const tagStatement = statements[tagIndex];
  assert.deepEqual(createStatement.Condition, tagStatement.Condition);
  assert.deepEqual(createStatement.Resource, tagStatement.Resource);
  brokerPolicy.PolicyDocument.Statement = statements.filter(
    (_, index) => index !== createIndex && index !== tagIndex,
  );
  brokerPolicy.PolicyDocument.Statement.push({
    ...createStatement,
    Action: [
      "agent-registry:CreateRegistryRecord",
      "agent-registry:TagResource",
    ],
  });
  responses.set(
    key(...brokerRoleGetPolicyCommand()),
    JSON.stringify(brokerPolicy),
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses,
    }).options),
    /broker role|inline policy/i,
  );
});

test("effective role audit rejects paginated or malformed IAM policy lists", () => {
  const failureCases = [
    {
      command: seedRoleListAttachedPoliciesCommand(),
      mutate(document) {
        document.IsTruncated = true;
      },
    },
    {
      command: adminRoleListPoliciesCommand(),
      mutate(document) {
        document.Marker = "next-page";
      },
    },
    {
      command: finalizerRoleListAttachedPoliciesCommand(),
      mutate(document) {
        document.IsTruncated = "false";
      },
    },
  ];

  for (const { command, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));

    assert.throws(
      () => auditPredeploy(fixture({
        env: githubEnabledEnvironment({
          SECURITY_AUDIT_MODE: "postdeploy",
        }),
        responses,
      }).options),
      /attached polic|inline polic/i,
    );
  }
});

test("deploy accepts only the exact read-only Workspace API predecessor", () => {
  const responses = githubEnabledResponses();
  const workspacePolicy = JSON.parse(
    responses.get(key(...workspaceRoleGetPolicyCommand())),
  );
  workspacePolicy.PolicyDocument.Statement[1].Condition[
    "ForAllValues:StringLike"
  ]["dynamodb:LeadingKeys"] = workspacePolicy.PolicyDocument.Statement[1]
    .Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
    .filter((value) => !["MUTATION#*", "GRANT#*"].includes(value));
  workspacePolicy.PolicyDocument.Statement.splice(2, 1);
  responses.set(
    key(...workspaceRoleGetPolicyCommand()),
    JSON.stringify(workspacePolicy),
  );

  const deployResult = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses,
  }).options);
  assert.equal(
    deployResult.evidence.runtimeRoles.roles.find(
      ({ roleName }) => roleName === WORKSPACE_ROLE_NAME,
    ).acceptedPolicyState,
    "read-only",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    }).options),
    /workspace.*inline policy/i,
  );
});

test("effective Workspace API role audit rejects privilege drift", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(WORKSPACE_ROLE_NAME),
      expectedError: /workspace.*trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      command: workspaceRoleGetPolicyCommand(),
      expectedError: /workspace.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Action.push("dynamodb:Scan");
      },
    },
    {
      command: workspaceRoleGetPolicyCommand(),
      expectedError: /workspace.*inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("AUDIT#*");
      },
    },
    {
      command: workspaceRoleListAttachedPoliciesCommand(),
      expectedError: /workspace.*attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: workspaceRoleListPoliciesCommand(),
      expectedError: /workspace.*inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
    {
      command: workspaceRoleGetXrayPolicyCommand(),
      expectedError: /workspace.*x-ray/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "xray:GetTraceSummaries",
        );
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.status, "failed");
  }
});

test("effective seed-role audit rejects trust, action, resource, and policy-list drift", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(PLATFORM_STATE_SEED_ROLE_NAME),
      expectedError: /seed role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      command: seedRoleGetPolicyCommand(),
      expectedError: /seed role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "logs:CreateLogGroup",
        );
      },
    },
    {
      command: seedRoleGetPolicyCommand(),
      expectedError: /seed role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Resource += "/index/*";
      },
    },
    {
      command: seedRoleGetPolicyCommand(),
      expectedError: /seed role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"].push("AUDIT#*");
      },
    },
    {
      command: seedRoleListAttachedPoliciesCommand(),
      expectedError: /seed role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: seedRoleListPoliciesCommand(),
      expectedError: /seed role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment(),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
    assert.equal(
      evidenceWrites[0].evidence.runtimeRoles.status === "failed"
      || evidenceWrites[0].evidence.runtimeBoundary.status === "failed",
      true,
    );
  }
});

test("effective platform workspace seed-role audit rejects cross-partition access", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(PLATFORM_WORKSPACE_SEED_ROLE_NAME),
      expectedError: /workspace seed role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      command: workspaceSeedRoleGetPolicyCommand(),
      expectedError: /workspace seed role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Condition[
          "ForAllValues:StringEquals"
        ]["dynamodb:LeadingKeys"].push("DOMAIN");
      },
    },
    {
      command: workspaceSeedRoleListAttachedPoliciesCommand(),
      expectedError: /workspace seed role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: workspaceSeedRoleListPoliciesCommand(),
      expectedError: /workspace seed role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.status, "failed");
  }
});

test("effective admin-role audit rejects trust, action, condition, resource, and policy-list drift", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(PLATFORM_ADMIN_ROLE_NAME),
      expectedError: /admin role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      command: adminRoleGetPolicyCommand(),
      expectedError: /admin role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "logs:CreateLogGroup",
        );
      },
    },
    {
      command: adminRoleGetPolicyCommand(),
      expectedError: /admin role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Resource += "/index/*";
      },
    },
    {
      command: adminRoleGetPolicyCommand(),
      expectedError: /admin role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("AUDIT#*");
      },
    },
    {
      command: adminRoleGetPolicyCommand(),
      expectedError: /admin role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement =
          document.PolicyDocument.Statement.filter(
            ({ Action }) => Action !== "agent-registry:TagResource",
          );
      },
    },
    {
      command: adminRoleGetPolicyCommand(),
      expectedError: /admin role|inline policy/i,
      mutate(document) {
        const statement = document.PolicyDocument.Statement.find(
          ({ Action, Condition }) =>
            Action === "agent-registry:CreateRegistry"
            && Condition?.StringEquals?.["aws:RequestTag/managedBy"]
              === "hosted-acceptance",
        );
        statement.Condition.StringEquals[
          "aws:RequestTag/managedBy"
        ] = "cdk";
      },
    },
    {
      command: adminRoleListAttachedPoliciesCommand(),
      expectedError: /admin role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: adminRoleListPoliciesCommand(),
      expectedError: /admin role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment(),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.status, "failed");
  }
});

test("effective control-plane read role audit rejects policy drift", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(CONTROL_PLANE_READ_ROLE_NAME),
      expectedError: /control-plane read role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      command: controlPlaneReadRoleGetPolicyCommand(),
      expectedError: /control-plane read role|inline policy/i,
      mutate(document) {
        const action = document.PolicyDocument.Statement[1].Action;
        document.PolicyDocument.Statement[1].Action = [
          ...(Array.isArray(action) ? action : [action]),
          "agent-registry:DeleteRegistry",
        ];
      },
    },
    {
      command: controlPlaneReadRoleGetPolicyCommand(),
      expectedError: /control-plane read role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[2].Resource[0] =
          ACCOUNT_REGISTRY_RECORD_ARN;
      },
    },
    {
      command: controlPlaneReadRoleGetPolicyCommand(),
      expectedError: /control-plane read role|inline policy/i,
      mutate(document) {
        delete document.PolicyDocument.Statement[4].Condition;
      },
    },
    {
      command: controlPlaneReadRoleListAttachedPoliciesCommand(),
      expectedError: /control-plane read role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: controlPlaneReadRoleListPoliciesCommand(),
      expectedError: /control-plane read role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
    {
      command: controlPlaneReadRoleGetXrayPolicyCommand(),
      expectedError: /control-plane read role|inline policy|x-ray/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "xray:GetTraceSummaries",
        );
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));

    assert.throws(
      () => auditPredeploy(fixture({
        env: githubEnabledEnvironment(),
        responses,
      }).options),
      expectedError,
    );
  }
});

test("effective broker-role audit rejects trust, action, condition, resource, and policy-list drift", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_BROKER_ROLE_NAME),
      expectedError: /broker role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) =>
            Array.isArray(Action)
            && Action.includes(
              "agent-registry:SubmitRegistryRecordForApproval",
            ),
        ).Condition = {
          StringEquals: {
            "aws:ResourceTag/managedBy": "hosted-acceptance",
          },
        };
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) => Action === "agent-registry:DeleteRegistry",
        ).Condition = undefined;
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Action }) => Action === "agent-registry:DeleteRegistry",
        ).Condition =
          registryResourceTagCondition("cdk");
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Sid }) => Sid === "ReadHostedAcceptanceState",
        ).Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("AUDIT#*");
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Sid }) =>
            Sid === "DeleteHostedAcceptanceRegistryWorkloadIdentity",
        ).Action = [
          "bedrock-agentcore:CreateWorkloadIdentity",
          "bedrock-agentcore:DeleteWorkloadIdentity",
        ];
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.find(
          ({ Sid }) =>
            Sid === "DeleteHostedAcceptanceRegistryWorkloadIdentity",
        ).Resource =
          `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:`
          + "workload-identity-directory/*";
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        delete document.PolicyDocument.Statement.find(
          ({ Sid }) =>
            Sid === "DeleteHostedAcceptanceRegistryWorkloadIdentity",
        ).Condition;
      },
    },
    {
      command: brokerRoleGetPolicyCommand(),
      expectedError: /broker role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.push({
          Action: "agent-registry:ListRegistries",
          Effect: "Allow",
          Resource: "*",
        });
      },
    },
    {
      command: brokerRoleListAttachedPoliciesCommand(),
      expectedError: /broker role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: brokerRoleListPoliciesCommand(),
      expectedError: /broker role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment(),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.status, "failed");
  }
});

test("effective hosted-acceptance role audit rejects trust, boundary, action, resource, and policy-list drift", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
      expectedError: /hosted acceptance role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          AWS: `arn:aws:iam::${ACCOUNT_ID}:role/${GITHUB_DEPLOY_ROLE_NAME}`,
        };
      },
    },
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
      expectedError: /hosted acceptance role|trust/i,
      mutate(document) {
        delete document.Role.AssumeRolePolicyDocument.Statement[0].Condition;
      },
    },
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
      expectedError: /hosted acceptance role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Condition[
          "StringEquals"
        ] = {
          "sts:ExternalId": "unexpected",
        };
      },
    },
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
      expectedError: /hosted acceptance role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Condition
          .ArnEquals["aws:PrincipalArn"] =
            `arn:aws:iam::${ACCOUNT_ID}:role/OtherDeployRole`;
      },
    },
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
      expectedError: /hosted acceptance role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement.push({
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { AWS: "*" },
        });
      },
    },
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
      expectedError: /hosted acceptance role|permissions boundary/i,
      mutate(document) {
        document.Role.PermissionsBoundary = {
          PermissionsBoundaryArn: RUNTIME_BOUNDARY_ARN,
          PermissionsBoundaryType: "Policy",
        };
      },
    },
    {
      command: runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME),
      expectedError: /hosted acceptance role|ARN/i,
      mutate(document) {
        document.Role.Arn =
          `arn:aws:iam::${ACCOUNT_ID}:role/path/${HOSTED_ACCEPTANCE_ROLE_NAME}`;
      },
    },
    {
      command: hostedAcceptanceRoleListAttachedPoliciesCommand(),
      expectedError: /hosted acceptance role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: hostedAcceptanceRoleListPoliciesCommand(),
      expectedError: /hosted acceptance role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
    {
      command: hostedAcceptanceRoleListPoliciesCommand(),
      expectedError: /hosted acceptance role|inline polic/i,
      mutate(document) {
        document.PolicyNames = [];
      },
    },
    {
      command: hostedAcceptanceRoleGetPolicyCommand(),
      expectedError: /hosted acceptance role|inline policy/i,
      mutate(document) {
        document.PolicyName = "UnexpectedPolicy";
      },
    },
    ...[
      "agent-registry:DeleteRegistry",
      "dynamodb:DeleteItem",
      "iam:PassRole",
      "sts:AssumeRole",
      "cognito-idp:AdminSetUserMFAPreference",
    ].map((action) => ({
      command: hostedAcceptanceRoleGetPolicyCommand(),
      expectedError: /hosted acceptance role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement.push({
          Action: action,
          Effect: "Allow",
          Resource: "*",
        });
      },
    })),
    {
      command: hostedAcceptanceRoleGetPolicyCommand(),
      expectedError: /hosted acceptance role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Resource = "*";
      },
    },
    {
      command: hostedAcceptanceRoleGetPolicyCommand(),
      expectedError: /hosted acceptance role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Resource = "*";
      },
    },
    {
      command: hostedAcceptanceRoleGetPolicyCommand(),
      expectedError: /hosted acceptance role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Resource =
          `arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/OtherPool`;
      },
    },
    {
      command: hostedAcceptanceRoleGetPolicyCommand(),
      expectedError: /hosted acceptance role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Resource =
          `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:OtherBroker`;
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.status, "failed");
  }
});

test("postdeploy requires exact hosted-acceptance role and stack identities", () => {
  const failureCases = [
    {
      expectedError: /hosted acceptance role|required|missing/i,
      mutate(responses) {
        const command = runtimeRoleCommand(HOSTED_ACCEPTANCE_ROLE_NAME);
        responses.set(
          key(...command),
          new AuditCommandError("aws", command.slice(1), {
            status: 254,
            stderr:
              "An error occurred (NoSuchEntity) when calling the GetRole "
              + "operation: The role with name "
              + `${HOSTED_ACCEPTANCE_ROLE_NAME} cannot be found.`,
          }),
        );
      },
    },
    {
      expectedError: /user pool|exactly one/i,
      mutate(responses) {
        const document = JSON.parse(
          responses.get(key(...COMMANDS.webResources)),
        );
        document.StackResources = document.StackResources.filter(
          ({ ResourceType }) => ResourceType !== "AWS::Cognito::UserPool",
        );
        responses.set(key(...COMMANDS.webResources), JSON.stringify(document));
      },
    },
    {
      expectedError: /user pool|exactly one/i,
      mutate(responses) {
        const document = JSON.parse(
          responses.get(key(...COMMANDS.webResources)),
        );
        document.StackResources.push({
          LogicalResourceId: "OtherUserPool",
          PhysicalResourceId: `${REGION}_OtherPool`,
          ResourceType: "AWS::Cognito::UserPool",
        });
        responses.set(key(...COMMANDS.webResources), JSON.stringify(document));
      },
    },
    {
      expectedError: /user pool|malformed/i,
      mutate(responses) {
        const document = JSON.parse(
          responses.get(key(...COMMANDS.webResources)),
        );
        document.StackResources.find(
          ({ ResourceType }) => ResourceType === "AWS::Cognito::UserPool",
        ).PhysicalResourceId = "not-a-user-pool";
        responses.set(key(...COMMANDS.webResources), JSON.stringify(document));
      },
    },
    {
      expectedError: /UserPoolId output|exactly one|match/i,
      mutate(responses) {
        const document = JSON.parse(responses.get(key(...COMMANDS.webStack)));
        document.Stacks[0].Outputs = document.Stacks[0].Outputs.filter(
          ({ OutputKey }) => OutputKey !== "UserPoolId",
        );
        responses.set(key(...COMMANDS.webStack), JSON.stringify(document));
      },
    },
    {
      expectedError: /UserPoolId output|exactly one|match/i,
      mutate(responses) {
        const document = JSON.parse(responses.get(key(...COMMANDS.webStack)));
        document.Stacks[0].Outputs.push({
          OutputKey: "UserPoolId",
          OutputValue: USER_POOL_ID,
        });
        responses.set(key(...COMMANDS.webStack), JSON.stringify(document));
      },
    },
    {
      expectedError: /UserPoolId output|match/i,
      mutate(responses) {
        const document = JSON.parse(responses.get(key(...COMMANDS.webStack)));
        document.Stacks[0].Outputs.find(
          ({ OutputKey }) => OutputKey === "UserPoolId",
        ).OutputValue = `${REGION}_OtherPool`;
        responses.set(key(...COMMANDS.webStack), JSON.stringify(document));
      },
    },
    {
      expectedError: /broker function|exactly one/i,
      mutate(responses) {
        const document = JSON.parse(
          responses.get(key(...COMMANDS.webResources)),
        );
        document.StackResources = document.StackResources.filter(
          ({ LogicalResourceId }) =>
            !LogicalResourceId.startsWith("HostedAcceptanceBrokerFunction"),
        );
        responses.set(key(...COMMANDS.webResources), JSON.stringify(document));
      },
    },
    {
      expectedError: /broker function|exactly one/i,
      mutate(responses) {
        const document = JSON.parse(
          responses.get(key(...COMMANDS.webResources)),
        );
        document.StackResources.push({
          LogicalResourceId: "HostedAcceptanceBrokerFunctionDuplicate",
          PhysicalResourceId: HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME,
          ResourceType: "AWS::Lambda::Function",
        });
        responses.set(key(...COMMANDS.webResources), JSON.stringify(document));
      },
    },
    {
      expectedError: /broker function|name|malformed/i,
      mutate(responses) {
        const document = JSON.parse(
          responses.get(key(...COMMANDS.webResources)),
        );
        document.StackResources.find(
          ({ LogicalResourceId }) =>
            LogicalResourceId.startsWith("HostedAcceptanceBrokerFunction"),
        ).PhysicalResourceId = "OtherBroker";
        responses.set(key(...COMMANDS.webResources), JSON.stringify(document));
      },
    },
    {
      expectedError: /broker function ARN output|exactly one|match/i,
      mutate(responses) {
        const document = JSON.parse(responses.get(key(...COMMANDS.webStack)));
        document.Stacks[0].Outputs = document.Stacks[0].Outputs.filter(
          ({ OutputKey }) =>
            OutputKey !== "HostedAcceptanceBrokerFunctionArn",
        );
        responses.set(key(...COMMANDS.webStack), JSON.stringify(document));
      },
    },
    {
      expectedError: /broker function ARN output|exactly one|match/i,
      mutate(responses) {
        const document = JSON.parse(responses.get(key(...COMMANDS.webStack)));
        document.Stacks[0].Outputs.push({
          OutputKey: "HostedAcceptanceBrokerFunctionArn",
          OutputValue: HOSTED_ACCEPTANCE_BROKER_FUNCTION_ARN,
        });
        responses.set(key(...COMMANDS.webStack), JSON.stringify(document));
      },
    },
    {
      expectedError: /broker function ARN output|match/i,
      mutate(responses) {
        const document = JSON.parse(responses.get(key(...COMMANDS.webStack)));
        document.Stacks[0].Outputs.find(
          ({ OutputKey }) =>
            OutputKey === "HostedAcceptanceBrokerFunctionArn",
        ).OutputValue =
          `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:OtherBroker`;
        responses.set(key(...COMMANDS.webStack), JSON.stringify(document));
      },
    },
  ];

  for (const { expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    mutate(responses);
    const { evidenceWrites, options } = fixture({
      env: manualPostdeployEnvironment(),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
    assert.equal(
      evidenceWrites[0].evidence.runtimeRoles.status === "failed"
      || evidenceWrites[0].evidence.runtimeBoundary.status === "failed",
      true,
    );
  }
});

test("deploy accepts only the exact finalizer transaction predecessor", () => {
  const predecessorResponses = () => {
    const responses = githubEnabledResponses();
    responses.set(
      key(...finalizerRoleGetPolicyCommand()),
      JSON.stringify({
        PolicyDocument:
          REGISTRY_DECISION_FINALIZER_LEGACY_TRANSACTION_INLINE_POLICY,
        PolicyName: REGISTRY_DECISION_FINALIZER_POLICY_NAME,
        RoleName: REGISTRY_DECISION_FINALIZER_ROLE_NAME,
      }),
    );
    return responses;
  };

  assert.equal(
    auditPredeploy(fixture({
      env: githubEnabledEnvironment(),
      responses: predecessorResponses(),
    }).options).evidence.status,
    "passed",
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: predecessorResponses(),
    }).options),
    /finalizer role|inline policy/i,
  );
});

test("effective finalizer-role audit rejects trust, action, condition, resource, and policy-list drift", () => {
  const failureCases = [
    {
      command: runtimeRoleCommand(REGISTRY_DECISION_FINALIZER_ROLE_NAME),
      expectedError: /finalizer role|trust/i,
      mutate(document) {
        document.Role.AssumeRolePolicyDocument.Statement[0].Principal = {
          Service: "ec2.amazonaws.com",
        };
      },
    },
    {
      command: finalizerRoleGetPolicyCommand(),
      expectedError: /finalizer role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[0].Action.push(
          "logs:CreateLogGroup",
        );
      },
    },
    {
      command: finalizerRoleGetPolicyCommand(),
      expectedError: /finalizer role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Resource += "/index/*";
      },
    },
    {
      command: finalizerRoleGetPolicyCommand(),
      expectedError: /finalizer role|inline policy/i,
      mutate(document) {
        document.PolicyDocument.Statement[1].Condition[
          "ForAllValues:StringLike"
        ]["dynamodb:LeadingKeys"].push("DOMAIN");
      },
    },
    {
      command: finalizerRoleListAttachedPoliciesCommand(),
      expectedError: /finalizer role|attached polic/i,
      mutate(document) {
        document.AttachedPolicies.push({
          PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
          PolicyName: "AdministratorAccess",
        });
      },
    },
    {
      command: finalizerRoleListPoliciesCommand(),
      expectedError: /finalizer role|inline polic/i,
      mutate(document) {
        document.PolicyNames.push("UnexpectedPolicy");
      },
    },
  ];

  for (const { command, expectedError, mutate } of failureCases) {
    const responses = githubEnabledResponses();
    const document = JSON.parse(responses.get(key(...command)));
    mutate(document);
    responses.set(key(...command), JSON.stringify(document));
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment(),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.status, "failed");
  }
});

test("platform state TTL audit requires the exact enabled target in deploy and postdeploy", () => {
  const disabledResponses = githubEnabledResponses();
  disabledResponses.set(
    key(...COMMANDS.platformStateTtl),
    JSON.stringify({
      TimeToLiveDescription: {
        TimeToLiveStatus: "DISABLED",
      },
    }),
  );
  for (const mode of ["deploy", "postdeploy"]) {
    assert.throws(
      () => auditPredeploy(fixture({
        env: githubEnabledEnvironment({
          SECURITY_AUDIT_MODE: mode,
        }),
        responses: disabledResponses,
      }).options),
      /time to live|TTL|expiresAt/i,
    );
  }

  for (const ttlDescription of [
    {
      AttributeName: "wrongAttribute",
      TimeToLiveStatus: "ENABLED",
    },
    {
      AttributeName: "expiresAt",
      TimeToLiveStatus: "DISABLING",
    },
  ]) {
    const responses = githubEnabledResponses();
    responses.set(
      key(...COMMANDS.platformStateTtl),
      JSON.stringify({ TimeToLiveDescription: ttlDescription }),
    );
    assert.throws(
      () => auditPredeploy(fixture({
        env: githubEnabledEnvironment(),
        responses,
      }).options),
      /time to live|TTL|expiresAt/i,
    );
  }
});

test("deploy mode accepts only the exact source-declared Task 3 boundary predecessor", () => {
  const { options } = fixture({
    env: githubEnabledEnvironment(),
    responses: task3PredecessorResponses(),
  });

  const result = auditPredeploy(options);

  assert.equal(result.evidence.status, "passed");
  assert.equal(
    result.evidence.runtimeBoundary.acceptedState,
    "predecessor",
  );
  assert.notEqual(
    result.evidence.runtimeBoundary.deployedHash,
    result.evidence.runtimeBoundary.expectedHash,
  );
  assert.equal(
    result.evidence.runtimeBoundary.platformStateTableStatus,
    "present",
  );
  assert.equal(
    result.evidence.runtimeBoundary.platformStateTimeToLiveStatus,
    "enabled",
  );
});

test("deploy accepts the exact invocation-journal predecessor but postdeploy rejects it", () => {
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: invocationJournalPredecessorResponses(),
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeBoundary.acceptedState,
    "predecessor",
  );
  assert.notEqual(
    deploy.evidence.runtimeBoundary.deployedHash,
    deploy.evidence.runtimeBoundary.expectedHash,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: invocationJournalPredecessorResponses(),
    }).options),
    /runtime permissions boundary.*target state|drift/i,
  );
});

test("deploy accepts the exact BatchGet-named IAM predecessor but postdeploy rejects it", () => {
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: batchReadPredecessorResponses(),
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeBoundary.acceptedState,
    "predecessor",
  );
  assert.notEqual(
    deploy.evidence.runtimeBoundary.deployedHash,
    deploy.evidence.runtimeBoundary.expectedHash,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: batchReadPredecessorResponses(),
    }).options),
    /runtime permissions boundary.*target state|drift/i,
  );
});

test("deploy accepts the Registry-ARN discoverable predecessor but postdeploy rejects it", () => {
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: discoverableResourcePredecessorResponses(),
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeBoundary.acceptedState,
    "predecessor",
  );
  assert.notEqual(
    deploy.evidence.runtimeBoundary.deployedHash,
    deploy.evidence.runtimeBoundary.expectedHash,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: discoverableResourcePredecessorResponses(),
    }).options),
    /runtime permissions boundary.*target state|drift/i,
  );
});

test("deploy accepts the condition-losing delete predecessor but postdeploy rejects it", () => {
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: deleteConditionPredecessorResponses(),
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeBoundary.acceptedState,
    "predecessor",
  );
  assert.notEqual(
    deploy.evidence.runtimeBoundary.deployedHash,
    deploy.evidence.runtimeBoundary.expectedHash,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: deleteConditionPredecessorResponses(),
    }).options),
    /runtime permissions boundary.*target state|drift/i,
  );
});

test("deploy accepts the exact boundary transaction predecessor but postdeploy rejects it", () => {
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: transactionAuthorizationPredecessorResponses(),
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeBoundary.acceptedState,
    "legacy-transaction-authorization",
  );
  assert.notEqual(
    deploy.evidence.runtimeBoundary.deployedHash,
    deploy.evidence.runtimeBoundary.expectedHash,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: transactionAuthorizationPredecessorResponses(),
    }).options),
    /runtime permissions boundary.*target state|drift/i,
  );
});

test("deploy accepts direct-Bedrock Journey boundary predecessor but postdeploy rejects it", () => {
  const deploy = auditPredeploy(fixture({
    env: githubEnabledEnvironment(),
    responses: journeyBoundaryPredecessorResponses(),
  }).options);

  assert.equal(deploy.evidence.status, "passed");
  assert.equal(
    deploy.evidence.runtimeBoundary.acceptedState,
    "journey-predecessor",
  );
  assert.notEqual(
    deploy.evidence.runtimeBoundary.deployedHash,
    deploy.evidence.runtimeBoundary.expectedHash,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: githubEnabledEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses: journeyBoundaryPredecessorResponses(),
    }).options),
    /runtime permissions boundary.*target state|drift/i,
  );
});

test("postdeploy mode enforces and accepts only the exact Task 5 target boundary", () => {
  const predecessorResponses = task3PredecessorResponses();
  const predecessor = fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "postdeploy",
    }),
    responses: predecessorResponses,
  });
  assert.throws(
    () => auditPredeploy(predecessor.options),
    /platform admin log group|Registry decision finalizer log group|runtime permissions boundary.*target state|drift/i,
  );

  const target = auditPredeploy(fixture({
    env: githubEnabledEnvironment({
      SECURITY_AUDIT_MODE: "postdeploy",
    }),
    responses: githubEnabledResponses(),
  }).options);
  assert.equal(target.evidence.status, "passed");
  assert.equal(target.evidence.runtimeBoundary.acceptedState, "target");
  assert.equal(
    target.evidence.runtimeBoundary.deployedHash,
    EXPECTED_RUNTIME_BOUNDARY_HASH,
  );
});

test("postdeploy boundary requires exact Gateway session and principal controls", async (t) => {
  const failureCases = [
    {
      name: "missing Gateway principal condition",
      mutate(policy) {
        delete policy.Statement.find(
          ({ Sid }) => Sid === "InvokeControlPlaneLlmGateway",
        ).Condition;
      },
    },
    {
      name: "broadened Gateway principal condition",
      mutate(policy) {
        policy.Statement.find(
          ({ Sid }) => Sid === "InvokeControlPlaneLlmGateway",
        ).Condition.ArnEquals["aws:PrincipalArn"] = "*";
      },
    },
    {
      name: "missing SetSourceIdentity boundary action",
      mutate(policy) {
        policy.Statement.find(
          ({ Sid }) => Sid === "AssumeGatewayInvokerRole",
        ).Action = ["sts:AssumeRole"];
      },
    },
  ];

  for (const { name, mutate } of failureCases) {
    await t.test(name, () => {
      const responses = githubEnabledResponses();
      const version = JSON.parse(
        responses.get(key(...COMMANDS.boundaryVersion)),
      );
      mutate(version.PolicyVersion.Document);
      responses.set(
        key(...COMMANDS.boundaryVersion),
        JSON.stringify(version),
      );

      assert.throws(
        () => auditPredeploy(fixture({
          env: githubEnabledEnvironment({
            SECURITY_AUDIT_MODE: "postdeploy",
          }),
          responses,
        }).options),
        /runtime permissions boundary.*target state|drift/i,
      );
    });
  }
});

test("GitHub-disabled postdeploy rejects every incomplete runtime target state", () => {
  const missingTable = githubEnabledResponses();
  const webResources = JSON.parse(
    missingTable.get(key(...COMMANDS.webResources)),
  );
  webResources.StackResources = webResources.StackResources.filter(
    ({ ResourceType }) => ResourceType !== "AWS::DynamoDB::Table",
  );
  missingTable.set(
    key(...COMMANDS.webResources),
    JSON.stringify(webResources),
  );

  const missingRole = githubEnabledResponses();
  const platformAdminRoleCommand =
    runtimeRoleCommand(PLATFORM_ADMIN_ROLE_NAME);
  missingRole.set(
    key(...platformAdminRoleCommand),
    new AuditCommandError("aws", platformAdminRoleCommand.slice(1), {
      status: 254,
      stderr:
        "An error occurred (NoSuchEntity) when calling the GetRole "
        + `operation: The role with name ${PLATFORM_ADMIN_ROLE_NAME} `
        + "cannot be found.",
    }),
  );

  const missingBoundary = githubEnabledResponses();
  missingBoundary.set(
    key(...COMMANDS.boundaryGet),
    new AuditCommandError("aws", COMMANDS.boundaryGet.slice(1), {
      status: 254,
      stderr:
        "An error occurred (NoSuchEntity) when calling the GetPolicy "
        + "operation: Policy not found.",
    }),
  );

  const predecessorBoundary = task1PredecessorResponses({
    includePlatformAdminRole: true,
    includePlatformStateSeedRole: true,
    includePlatformStateTable: true,
  });
  predecessorBoundary.set(
    key(...COMMANDS.platformStateTtl),
    JSON.stringify({
      TimeToLiveDescription: {
        AttributeName: "expiresAt",
        TimeToLiveStatus: "ENABLED",
      },
    }),
  );

  for (const [label, responses, expectedError] of [
    ["missing table", missingTable, /platform state table/i],
    ["missing role", missingRole, /command failed/i],
    ["missing boundary", missingBoundary, /command failed/i],
    [
      "predecessor boundary",
      predecessorBoundary,
      /Registry decision finalizer log group|target state|drift/i,
    ],
  ]) {
    const { evidenceWrites, options } = fixture({
      env: manualPostdeployEnvironment(),
      responses,
    });

    assert.throws(
      () => auditPredeploy(options),
      expectedError,
      label,
    );
    assert.equal(evidenceWrites[0].evidence.status, "failed", label);
  }
});

test("GitHub-disabled postdeploy accepts the exact runtime target without GitHub metadata", () => {
  const { calls, options } = fixture({
    env: manualPostdeployEnvironment(),
    responses: githubEnabledResponses(),
  });

  const result = auditPredeploy(options);

  assert.equal(result.evidence.status, "passed");
  assert.equal(result.evidence.audit.githubDeploymentEnabled, false);
  assert.equal(result.evidence.githubDeployment, undefined);
  assert.equal(result.evidence.controlPlane.required, true);
  assert.equal(result.evidence.controlPlane.status, "passed");
  assert.equal(result.evidence.runtimeRoles.required, true);
  assert.equal(
    result.evidence.runtimeRoles.roles.length,
    RUNTIME_ROLE_NAMES.length + 1,
  );
  assert.equal(result.evidence.runtimeRoles.status, "passed");
  assert.equal(result.evidence.runtimeBoundary.required, true);
  assert.equal(result.evidence.runtimeBoundary.acceptedState, "target");
  assert.equal(result.evidence.runtimeBoundary.status, "passed");
  assert.ok(
    calls.some(({ command, args }) =>
      key(command, args) === key(...COMMANDS.boundaryGet)
    ),
  );
  assert.ok(
    calls.some(({ command, args }) =>
      key(command, args) === key(...COMMANDS.webResources)
    ),
  );
});

test("postdeploy audits the complete web stack inventory beyond 100 resources", () => {
  const responses = githubEnabledResponses();
  const resources = JSON.parse(
    responses.get(key(...COMMANDS.webResources)),
  );
  const stackResourceSummaries = resources.StackResources.map(
    (resource, index) => ({
      ...resource,
      ResourceStatus: "CREATE_COMPLETE",
      Timestamp: `2026-08-25T00:00:${String(index).padStart(2, "0")}Z`,
    }),
  );
  for (let index = stackResourceSummaries.length; index < 125; index += 1) {
    stackResourceSummaries.push({
      LogicalResourceId: `AdditionalRoute${index}`,
      PhysicalResourceId: `route-${index}`,
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "AWS::ApiGatewayV2::Route",
      Timestamp: "2026-08-25T00:01:00Z",
    });
  }
  responses.set(
    key(...COMMANDS.webResources),
    JSON.stringify({ StackResourceSummaries: stackResourceSummaries }),
  );
  const { calls, options } = fixture({
    env: manualPostdeployEnvironment(),
    responses,
  });

  const result = auditPredeploy(options);

  assert.equal(result.evidence.status, "passed");
  assert.ok(
    calls.some(({ command, args }) =>
      key(command, args) === key(...COMMANDS.webResources)
    ),
  );
});

test("GitHub deployment audit accepts provision mode without existing-ID variables", () => {
  const responses = provisionedControlPlaneResponses();
  const { options } = fixture({
    env: githubEnabledEnvironment({
      CONTROL_PLANE_MODE: "provision",
      CONTROL_PLANE_SHARED_REGISTRY_ID: "",
      CONTROL_PLANE_REGISTRY_PLATFORM_ID: "",
      CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID: "",
      CONTROL_PLANE_REGISTRY_OPERATIONS_ID: "",
      CONTROL_PLANE_LLM_GATEWAY_ID: "",
      CONTROL_PLANE_LLM_GATEWAY_REGION: "",
      CONTROL_PLANE_TOOLS_GATEWAY_ID: "",
    }),
    responses,
  });

  const result = auditPredeploy(options);

  assert.deepEqual(result.evidence.controlPlane, {
    mode: "provision",
    outputsMatch: true,
    required: true,
    stackName: PROVISIONED_CONTROL_PLANE_STACK_NAME,
    status: "passed",
    tagsMatch: true,
  });
});

test("first provision deploy treats absent platform stacks as planned", () => {
  const responses = provisionedControlPlaneResponses();
  responses.set(
    key(...COMMANDS.provisionedControlPlane),
    new AuditCommandError(
      "aws",
      COMMANDS.provisionedControlPlane.slice(1),
      {
        status: 255,
        stderr:
          "An error occurred (ValidationError) when calling the "
          + "DescribeStacks operation: Stack with id "
          + `${PROVISIONED_CONTROL_PLANE_STACK_NAME} does not exist`,
      },
    ),
  );
  const { calls, options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  const result = auditPredeploy(options);

  assert.deepEqual(result.evidence.controlPlane, {
    mode: "provision",
    outputsMatch: null,
    required: true,
    stackName: PROVISIONED_CONTROL_PLANE_STACK_NAME,
    status: "planned",
    tagsMatch: null,
  });
  assert.equal(result.evidence.controlPlaneExecutionRole.status, "passed");
  assert.equal(result.evidence.controlPlaneRuntimeBoundary.status, "planned");
  assert.equal(result.evidence.controlPlaneRuntimeRoles.status, "planned");
  assert.equal(result.evidence.runtimeBoundary.status, "planned");
  assert.equal(result.evidence.runtimeRoles.status, "planned");
  assert.ok(
    !calls.some(({ command, args }) =>
      key(command, args) === key(...COMMANDS.controlPlaneBoundaryGet)
    ),
  );
  assert.ok(
    !calls.some(({ command, args }) =>
      key(command, args) === key(...COMMANDS.webResources)
    ),
  );
});

test("first web deploy treats an absent web stack as planned", () => {
  const responses = provisionedControlPlaneResponses();
  responses.set(
    key(...COMMANDS.webResources),
    new AuditCommandError(
      "aws",
      COMMANDS.webResources.slice(1),
      {
        status: 255,
        stderr:
          "An error occurred (ValidationError) when calling the "
          + "ListStackResources operation: Stack with id "
          + "AgenticPlatform-Web does not exist",
      },
    ),
  );
  const { options } = fixture({
    env: provisionedControlPlaneEnvironment(),
    responses,
  });

  const result = auditPredeploy(options);

  assert.equal(result.evidence.controlPlane.status, "passed");
  assert.equal(result.evidence.controlPlaneRuntimeBoundary.status, "passed");
  assert.equal(result.evidence.controlPlaneRuntimeRoles.status, "passed");
  assert.equal(result.evidence.runtimeBoundary.status, "planned");
  assert.equal(result.evidence.runtimeRoles.status, "planned");
});

test("postdeploy still rejects absent provisioned platform stacks", () => {
  const cases = [
    {
      command: COMMANDS.provisionedControlPlane,
      operation: "DescribeStacks",
    },
    {
      command: COMMANDS.webResources,
      operation: "ListStackResources",
    },
  ];

  for (const { command, operation } of cases) {
    const responses = provisionedControlPlaneResponses();
    const stackName = command.includes(PROVISIONED_CONTROL_PLANE_STACK_NAME)
      ? PROVISIONED_CONTROL_PLANE_STACK_NAME
      : "AgenticPlatform-Web";
    responses.set(
      key(...command),
      new AuditCommandError("aws", command.slice(1), {
        status: 255,
        stderr:
          `An error occurred (ValidationError) when calling the ${operation} `
          + `operation: Stack with id ${stackName} does not exist`,
      }),
    );
    const { options } = fixture({
      env: provisionedControlPlaneEnvironment({
        SECURITY_AUDIT_MODE: "postdeploy",
      }),
      responses,
    });

    assert.throws(() => auditPredeploy(options), /command failed/i);
  }
});

test("GitHub deployment audit rejects invalid mode-specific control-plane variables before AWS calls", () => {
  const cases = [
    githubEnabledEnvironment({ CONTROL_PLANE_MODE: "invalid" }),
    githubEnabledEnvironment({
      CONTROL_PLANE_SHARED_REGISTRY_ID: "",
    }),
    githubEnabledEnvironment({
      CONTROL_PLANE_MODE: "provision",
    }),
  ];

  for (const env of cases) {
    const { calls, evidenceWrites, options } = fixture({
      env,
      responses: githubEnabledResponses(),
    });

    assert.throws(
      () => auditPredeploy(options),
      /CONTROL_PLANE_MODE|reference-existing|provision|must be empty|required/i,
    );
    assert.deepEqual(calls, []);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
  }
});

test("GitHub deployment audit fails closed on control-plane output or tag drift", () => {
  const failureCases = [
    controlPlaneStackDocument({
      outputOverrides: {
        SharedRegistryId: "DifferentReg1234",
      },
    }),
    controlPlaneStackDocument({
      tags: [
        ...REQUIRED_BOUNDARY_TAGS.filter(({ Key }) => Key !== "auto-delete"),
        { Key: "auto-delete", Value: "yes" },
      ],
    }),
  ];

  for (const stackDocument of failureCases) {
    const responses = githubEnabledResponses();
    responses.set(
      key(...COMMANDS.controlPlane),
      JSON.stringify(stackDocument),
    );
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment(),
      responses,
    });

    assert.throws(
      () => auditPredeploy(options),
      /control-plane|mandatory tags|protected repository variables/i,
    );
    assert.equal(evidenceWrites[0].evidence.controlPlane.status, "failed");
  }
});

for (const canonicalizationCase of [
  {
    document: reorderedBoundaryPolicy(),
    name: "reordered keys, statements, actions, and resources",
  },
  {
    document: scalarBoundaryPolicy(),
    name: "scalar singleton actions and resources",
  },
  {
    document: encodeURIComponent(
      JSON.stringify(reorderedBoundaryPolicy(scalarBoundaryPolicy())),
    ),
    name: "URL-encoded reordered scalar policy",
  },
]) {
  test(
    `GitHub deployment audit canonicalizes ${
      canonicalizationCase.name
    }`,
    () => {
      const responses = githubEnabledResponses();
      responses.set(
        key(...COMMANDS.boundaryVersion),
        JSON.stringify({
          PolicyVersion: {
            Document: canonicalizationCase.document,
            IsDefaultVersion: true,
            VersionId: "v3",
          },
        }),
      );
      const { options } = fixture({
        env: githubEnabledEnvironment(),
        responses,
      });

      const result = auditPredeploy(options);

      assert.deepEqual(result.evidence.runtimeBoundary, {
        acceptedState: "target",
        arn: RUNTIME_BOUNDARY_ARN,
        defaultVersionId: "v3",
        deployedHash: EXPECTED_RUNTIME_BOUNDARY_HASH,
        expectedHash: EXPECTED_RUNTIME_BOUNDARY_HASH,
        platformStateTableStatus: "present",
        platformStateTimeToLiveStatus: "enabled",
        required: true,
        status: "passed",
        tagsMatch: true,
      });
    },
  );
}

test("GitHub deployment audit fails closed for inconsistent CloudFront provider resources", () => {
  const failureCases = [
    [
      {},
      /complete resource array/i,
    ],
    [
      {
        StackResources: [
          {
            LogicalResourceId: "DistributionOne",
            PhysicalResourceId: CLOUDFRONT_DISTRIBUTION_ID,
            ResourceType: "AWS::CloudFront::Distribution",
          },
          {
            LogicalResourceId: "DistributionTwo",
            PhysicalResourceId: "EOTHEREXAMPLE",
            ResourceType: "AWS::CloudFront::Distribution",
          },
          {
            LogicalResourceId: "CloudFront5xxAlarm",
            PhysicalResourceId: CLOUDFRONT_ALARM_NAME,
            ResourceType: "Custom::CloudFrontAlarm",
          },
        ],
      },
      /exactly one CloudFront distribution/i,
    ],
    [
      {
        StackResources: [
          {
            LogicalResourceId: "Distribution830FAC52",
            PhysicalResourceId: CLOUDFRONT_DISTRIBUTION_ID,
            ResourceType: "AWS::CloudFront::Distribution",
          },
          {
            LogicalResourceId: "CloudFront5xxAlarm",
            PhysicalResourceId: "PlatformWeb-unrelated-CloudFront-5xx",
            ResourceType: "Custom::CloudFrontAlarm",
          },
        ],
      },
      /alarm name does not match/i,
    ],
  ];

  for (const [stackResources, expectedError] of failureCases) {
    const responses = githubEnabledResponses();
    responses.set(
      key(...COMMANDS.webResources),
      JSON.stringify(stackResources),
    );
    const { evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment(),
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
    assert.equal(
      evidenceWrites[0].evidence.runtimeBoundary.status,
      "failed",
    );
  }
});

test("GitHub deployment audit accepts the exact immutable repository subject", () => {
  const { options } = fixture({
    env: githubEnabledEnvironment({
      GITHUB_OIDC_SUBJECT_MODE: "immutable",
      GITHUB_OIDC_SUBJECT: IMMUTABLE_SUBJECT,
    }),
    responses: githubEnabledResponses(),
  });

  const result = auditPredeploy(options);

  assert.deepEqual(result.evidence.githubDeployment, {
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    subject: IMMUTABLE_SUBJECT,
    subjectMode: "immutable",
    workflowRef: WORKFLOW_REF,
  });
});

test("GitHub deployment audit rejects subjects inconsistent with immutable IDs", () => {
  for (const env of [
    githubEnabledEnvironment({
      GITHUB_OIDC_SUBJECT_MODE: "immutable",
      GITHUB_OIDC_SUBJECT: LEGACY_SUBJECT,
    }),
    githubEnabledEnvironment({
      GITHUB_REPOSITORY_ID: "987654322",
      GITHUB_OIDC_SUBJECT_MODE: "immutable",
      GITHUB_OIDC_SUBJECT: IMMUTABLE_SUBJECT,
    }),
  ]) {
    const { calls, evidenceWrites, options } = fixture({
      env,
      responses: githubEnabledResponses(),
    });

    assert.throws(
      () => auditPredeploy(options),
      /declared immutable mode/,
    );
    assert.deepEqual(calls, []);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
  }
});

test("GitHub deployment audit fails closed for missing, malformed, renamed, or unbounded runtime roles", () => {
  const enabledEnvironment = githubEnabledEnvironment();
  const firstRoleName = RUNTIME_ROLE_NAMES[0];
  const firstRoleCommand = runtimeRoleCommand(firstRoleName);
  const failureCases = [
    [
      new AuditCommandError("aws", firstRoleCommand.slice(1), {
        status: 254,
        stderr: "NoSuchEntity",
      }),
      /command failed/,
    ],
    [JSON.stringify({}), /runtime role inspection.*Role object/i],
    [
      JSON.stringify({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${firstRoleName}`,
          PermissionsBoundary: {
            PermissionsBoundaryArn: RUNTIME_BOUNDARY_ARN,
            PermissionsBoundaryType: "Policy",
          },
          RoleName: "AgenticPlatform-Web-RenamedRole",
        },
      }),
      /unexpected role name/i,
    ],
    [
      JSON.stringify({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/path/${firstRoleName}`,
          PermissionsBoundary: {
            PermissionsBoundaryArn: RUNTIME_BOUNDARY_ARN,
            PermissionsBoundaryType: "Policy",
          },
          RoleName: firstRoleName,
        },
      }),
      /unexpected role ARN/i,
    ],
    [
      JSON.stringify({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${firstRoleName}`,
          RoleName: firstRoleName,
        },
      }),
      /exact runtime permissions boundary/i,
    ],
    [
      JSON.stringify({
        Role: {
          Arn: `arn:aws:iam::${ACCOUNT_ID}:role/${firstRoleName}`,
          PermissionsBoundary: {
            PermissionsBoundaryArn:
              `arn:aws:iam::${ACCOUNT_ID}:policy/AnotherBoundary`,
            PermissionsBoundaryType: "Policy",
          },
          RoleName: firstRoleName,
        },
      }),
      /exact runtime permissions boundary/i,
    ],
  ];

  for (const [roleResponse, expectedError] of failureCases) {
    const responses = githubEnabledResponses();
    responses.set(key(...firstRoleCommand), roleResponse);
    const { evidenceWrites, options } = fixture({
      env: enabledEnvironment,
      responses,
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.required, true);
    assert.equal(evidenceWrites[0].evidence.runtimeRoles.status, "failed");
  }
});

const SENSITIVE_BOUNDARY_MARKER =
  "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const runtimeBoundaryFailureCases = [
  {
    command: COMMANDS.boundaryTags,
    expectedError: /returned invalid JSON/,
    name: "malformed list-policy-tags JSON",
    response: "not-json",
  },
  {
    command: COMMANDS.boundaryTags,
    expectedError: /exact mandatory tags/,
    name: "missing policy tags",
    response: JSON.stringify({
      IsTruncated: false,
      Tags: [],
    }),
  },
  {
    command: COMMANDS.boundaryTags,
    expectedError: /exact mandatory tags/,
    name: "wrong policy tag value",
    response: JSON.stringify({
      IsTruncated: false,
      Tags: [
        ...REQUIRED_BOUNDARY_TAGS.filter(
          ({ Key }) => Key !== "auto-delete",
        ),
        { Key: "auto-delete", Value: "yes" },
      ],
    }),
  },
  {
    command: COMMANDS.boundaryTags,
    expectedError: /exact mandatory tags/,
    name: "extra policy tag",
    response: JSON.stringify({
      IsTruncated: false,
      Tags: [
        ...REQUIRED_BOUNDARY_TAGS,
        { Key: "unexpected", Value: "" },
      ],
    }),
  },
  {
    command: COMMANDS.boundaryTags,
    expectedError: /duplicate tag keys/,
    name: "duplicate policy tag",
    response: JSON.stringify({
      IsTruncated: false,
      Tags: [
        ...REQUIRED_BOUNDARY_TAGS,
        { Key: "project", Value: "duplicate" },
      ],
    }),
  },
  {
    command: COMMANDS.boundaryTags,
    expectedError: /pagination/,
    name: "paginated policy tags",
    response: JSON.stringify({
      IsTruncated: true,
      Marker: "next-page",
      Tags: REQUIRED_BOUNDARY_TAGS,
    }),
  },
  {
    command: COMMANDS.boundaryGet,
    expectedError: /command failed/,
    name: "get-policy command failure",
    response: new AuditCommandError("aws", COMMANDS.boundaryGet.slice(1), {
      status: 254,
      stderr: `NoSuchEntity ${SENSITIVE_BOUNDARY_MARKER}`,
    }),
  },
  {
    command: COMMANDS.boundaryGet,
    expectedError: /returned invalid JSON/,
    name: "malformed get-policy JSON",
    response: "not-json",
  },
  {
    command: COMMANDS.boundaryGet,
    expectedError: /one Policy object/,
    name: "missing Policy object",
    response: JSON.stringify({}),
  },
  {
    command: COMMANDS.boundaryGet,
    expectedError: /metadata is inconsistent/,
    name: "inconsistent Policy metadata",
    response: JSON.stringify({
      Policy: {
        Arn: `${RUNTIME_BOUNDARY_ARN}-renamed`,
        DefaultVersionId: "v3",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  },
  {
    command: COMMANDS.boundaryGet,
    expectedError: /valid default version/,
    name: "missing default version",
    response: JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  },
  {
    command: COMMANDS.boundaryGet,
    expectedError: /valid default version/,
    name: "malformed default version",
    response: JSON.stringify({
      Policy: {
        Arn: RUNTIME_BOUNDARY_ARN,
        DefaultVersionId: "latest",
        PolicyName: RUNTIME_BOUNDARY_NAME,
      },
    }),
  },
  {
    command: COMMANDS.boundaryVersion,
    expectedError: /command failed/,
    name: "get-policy-version command failure",
    response: new AuditCommandError("aws", COMMANDS.boundaryVersion.slice(1), {
      status: 254,
      stderr: `NoSuchEntity ${SENSITIVE_BOUNDARY_MARKER}`,
    }),
  },
  {
    command: COMMANDS.boundaryVersion,
    expectedError: /returned invalid JSON/,
    name: "malformed get-policy-version JSON",
    response: "not-json",
  },
  {
    command: COMMANDS.boundaryVersion,
    expectedError: /version metadata is inconsistent/,
    name: "missing PolicyVersion object",
    response: JSON.stringify({}),
  },
  {
    command: COMMANDS.boundaryVersion,
    expectedError: /version metadata is inconsistent/,
    name: "inconsistent PolicyVersion metadata",
    response: JSON.stringify({
      PolicyVersion: {
        Document: EXPECTED_RUNTIME_BOUNDARY_POLICY,
        IsDefaultVersion: false,
        VersionId: "v3",
      },
    }),
  },
  {
    command: COMMANDS.boundaryVersion,
    expectedError: /must be a policy object/,
    name: "missing policy version document",
    response: JSON.stringify({
      PolicyVersion: {
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  },
  {
    command: COMMANDS.boundaryVersion,
    expectedError: /URL-encoded JSON/,
    name: "malformed URL-encoded policy version document",
    response: JSON.stringify({
      PolicyVersion: {
        Document: `%E0%A4%A${SENSITIVE_BOUNDARY_MARKER}`,
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  },
  {
    command: COMMANDS.boundaryVersion,
    expectedError: /must be a policy object/,
    name: "malformed policy version document",
    response: JSON.stringify({
      PolicyVersion: {
        Document: [],
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  },
];

for (const failureCase of runtimeBoundaryFailureCases) {
  test(
    `GitHub deployment audit records failed boundary evidence for ${
      failureCase.name
    }`,
    () => {
      const responses = githubEnabledResponses();
      responses.set(key(...failureCase.command), failureCase.response);
      const { evidenceWrites, options } = fixture({
        env: githubEnabledEnvironment(),
        responses,
      });

      assert.throws(
        () => auditPredeploy(options),
        failureCase.expectedError,
      );
      assert.equal(evidenceWrites.length, 1);
      assert.equal(evidenceWrites[0].evidence.status, "failed");
      assert.equal(
        evidenceWrites[0].evidence.runtimeBoundary.status,
        "failed",
      );
      const serializedEvidence = JSON.stringify(
        evidenceWrites[0].evidence,
      );
      assert.equal(
        serializedEvidence.includes(SENSITIVE_BOUNDARY_MARKER),
        false,
      );
      assert.doesNotMatch(
        serializedEvidence,
        /WritePlatformLogs|logs:CreateLogStream/,
      );
    },
  );
}

test("GitHub deployment audit fails closed when immutable metadata is missing or inconsistent", () => {
  const cases = [
    ["GITHUB_REPOSITORY_ID", "", /GITHUB_REPOSITORY_ID/],
    ["GITHUB_REPOSITORY_OWNER_ID", "", /GITHUB_REPOSITORY_OWNER_ID/],
    ["GITHUB_WORKFLOW_REF", "", /GITHUB_WORKFLOW_REF/],
    ["GITHUB_OIDC_SUBJECT_MODE", "", /GITHUB_OIDC_SUBJECT_MODE/],
    ["GITHUB_OIDC_SUBJECT", "", /GITHUB_OIDC_SUBJECT/],
    ["GITHUB_REPOSITORY_ID", "not-numeric", /numeric GitHub ID/],
    [
      "GITHUB_WORKFLOW_REF",
      `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`,
      /deploy-serverless-platform\.yml/,
    ],
    ["GITHUB_OIDC_SUBJECT_MODE", "guessed", /legacy or immutable/],
    [
      "GITHUB_OIDC_SUBJECT",
      "repo:another/repository:ref:refs/heads/main",
      /declared legacy mode/,
    ],
  ];

  for (const [keyName, value, expectedError] of cases) {
    const { calls, evidenceWrites, options } = fixture({
      env: githubEnabledEnvironment({ [keyName]: value }),
      responses: githubEnabledResponses(),
    });

    assert.throws(() => auditPredeploy(options), expectedError);
    assert.deepEqual(calls, [], keyName);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
  }
});

test("GitHub deployment audit rejects any deployed runtime-boundary drift", () => {
  const responses = githubEnabledResponses();
  const broadenedPolicy = structuredClone(EXPECTED_RUNTIME_BOUNDARY_POLICY);
  broadenedPolicy.Statement.push({
    Sid: "Escalate",
    Effect: "Allow",
    Action: "iam:PassRole",
    Resource: "*",
  });
  responses.set(
    key(...COMMANDS.boundaryVersion),
    JSON.stringify({
      PolicyVersion: {
        Document: broadenedPolicy,
        IsDefaultVersion: true,
        VersionId: "v3",
      },
    }),
  );
  const { evidenceWrites, options } = fixture({
    env: githubEnabledEnvironment(),
    responses,
  });

  assert.throws(
    () => auditPredeploy(options),
    /runtime permissions boundary.*drift/i,
  );
  assert.equal(evidenceWrites[0].evidence.runtimeBoundary.status, "failed");
  assert.equal(
    evidenceWrites[0].evidence.runtimeBoundary.expectedHash,
    EXPECTED_RUNTIME_BOUNDARY_HASH,
  );
  assert.notEqual(
    evidenceWrites[0].evidence.runtimeBoundary.deployedHash,
    EXPECTED_RUNTIME_BOUNDARY_HASH,
  );
});

test("bootstrap-new refuses every existing CDKToolkit state", () => {
  for (const responses of [
    toolkitResponses(),
    toolkitResponses({ terminationProtection: false }),
    toolkitResponses({ bootstrapVersion: 5 }),
  ]) {
    const { options } = fixture({
      env: { SECURITY_AUDIT_MODE: "bootstrap-new" },
      responses,
    });
    assert.throws(
      () => auditPredeploy(options),
      /bootstrap-new mode requires CDKToolkit to be absent/,
    );
  }
});

test("bootstrap-remediate requires an existing noncompliant toolkit and approval", () => {
  assert.throws(
    () => auditPredeploy(fixture({
      env: {
        SECURITY_AUDIT_MODE: "bootstrap-remediate",
        CDK_BOOTSTRAP_REMEDIATION_APPROVED: "yes",
      },
      responses: absentToolkitResponses(),
    }).options),
    /bootstrap-remediate mode requires an existing CDKToolkit/,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: {
        SECURITY_AUDIT_MODE: "bootstrap-remediate",
        CDK_BOOTSTRAP_REMEDIATION_APPROVED: "yes",
      },
      responses: toolkitResponses(),
    }).options),
    /CDKToolkit is already compliant/,
  );

  assert.throws(
    () => auditPredeploy(fixture({
      env: { SECURITY_AUDIT_MODE: "bootstrap-remediate" },
      responses: toolkitResponses({ terminationProtection: false }),
    }).options),
    /CDK_BOOTSTRAP_REMEDIATION_APPROVED=yes/,
  );
});

test("bootstrap-remediate reports approved unprotected and outdated states", () => {
  for (const [responses, expectedToolkit] of [
    [
      toolkitResponses({ terminationProtection: false }),
      {
        bootstrapVersion: 21,
        compliant: false,
        issues: ["termination-protection-disabled"],
        status: "present",
        terminationProtection: false,
      },
    ],
    [
      toolkitResponses({ bootstrapVersion: 5 }),
      {
        bootstrapVersion: 5,
        compliant: false,
        issues: ["bootstrap-version-below-6"],
        status: "present",
        terminationProtection: true,
      },
    ],
    [
      toolkitResponses({
        bootstrapVersion: 5,
        terminationProtection: false,
      }),
      {
        bootstrapVersion: 5,
        compliant: false,
        issues: [
          "termination-protection-disabled",
          "bootstrap-version-below-6",
        ],
        status: "present",
        terminationProtection: false,
      },
    ],
  ]) {
    const { evidenceWrites, options } = fixture({
      env: {
        SECURITY_AUDIT_MODE: "bootstrap-remediate",
        CDK_BOOTSTRAP_REMEDIATION_APPROVED: "yes",
      },
      responses,
    });

    const result = auditPredeploy(options);

    assert.equal(result.evidence.status, "passed");
    assert.deepEqual(result.evidence.audit, {
      branchProtectionAttested: false,
      githubDeploymentEnabled: false,
      mode: "bootstrap-remediate",
      remediationApproved: true,
    });
    assert.deepEqual(result.evidence.cdkToolkit, expectedToolkit);
    assert.deepEqual(evidenceWrites[0].evidence, result.evidence);
  }
});

test("rejects unsupported audit modes before executing commands", () => {
  const { calls, evidenceWrites, options } = fixture({
    env: { SECURITY_AUDIT_MODE: "bootstrap" },
  });

  assert.throws(
    () => auditPredeploy(options),
    /SECURITY_AUDIT_MODE must be deploy, postdeploy, bootstrap-new, or bootstrap-remediate/,
  );
  assert.deepEqual(calls, []);
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("rejects invalid target configuration before executing commands", () => {
  const invalidEnvironments = [
    [{ AWS_ACCOUNT_ID: "123" }, /AWS_ACCOUNT_ID must be exactly 12 digits/],
    [{ AWS_REGION: "us-east-1" }, /AWS_REGION must be exactly us-west-2/],
    [{ GITHUB_REPOSITORY: "<owner/repo>" }, /real owner\/repo/],
    [{ GITHUB_REPOSITORY: "owner" }, /real owner\/repo/],
  ];

  for (const [env, expected] of invalidEnvironments) {
    const { calls, evidenceWrites, options } = fixture({ env });
    assert.throws(() => auditPredeploy(options), expected);
    assert.deepEqual(calls, []);
    assert.equal(evidenceWrites.length, 1);
    assert.equal(evidenceWrites[0].evidence.status, "failed");
    assert.deepEqual(evidenceWrites[0].evidence.target, {
      accountId: null,
      region: null,
      repository: null,
    });
  }
});

test("requires the configured repository to match the clone origin exactly", () => {
  const responses = baseResponses();
  responses.set(
    key(...COMMANDS.origin),
    "https://github.com/another-org/example-repo.git\n",
  );
  const { calls, evidenceWrites, options } = fixture({ responses });

  assert.throws(
    () => auditPredeploy(options),
    /GITHUB_REPOSITORY does not match git origin/,
  );
  assert.equal(calls.length, 1);
  assert.equal(evidenceWrites[0].evidence.status, "failed");
});

test("GitHub deployment audit accepts recognized non-root caller ARNs", () => {
  for (const [arn, principalType] of [
    [
      `arn:aws:iam::${ACCOUNT_ID}:user/deployers!//platform/alice`,
      "iam-user",
    ],
    [
      `arn:aws:sts::${ACCOUNT_ID}:`
        + "assumed-role/DeploymentRole/session",
      "assumed-role",
    ],
    [
      `arn:aws:sts::${ACCOUNT_ID}:federated-user/deployment-session`,
      "federated-user",
    ],
  ]) {
    const responses = baseResponses();
    responses.set(
      key(...COMMANDS.caller),
      JSON.stringify({
        Account: ACCOUNT_ID,
        Arn: arn,
        UserId: "deployment-session",
      }),
    );

    const result = auditPredeploy(fixture({ responses }).options);

    assert.deepEqual(result.evidence.caller, {
      accountMatches: true,
      principalType,
    });
  }
});

const invalidCallerCases = [
  {
    document: {
      Account: ["4444", "5555", "6666"].join(""),
      Arn:
        "arn:aws:sts::444455556666:"
        + "assumed-role/DeploymentRole/session",
    },
    expectedError: /caller account does not match AWS_ACCOUNT_ID/,
    name: "mismatched Account field",
  },
  {
    document: { Account: ACCOUNT_ID },
    expectedError: /caller ARN is malformed/,
    name: "missing ARN",
  },
  {
    document: { Account: ACCOUNT_ID, Arn: "not-an-arn" },
    expectedError: /caller ARN is malformed/,
    name: "malformed ARN",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws-us-gov:sts::${ACCOUNT_ID}:`
        + "assumed-role/DeploymentRole/session",
    },
    expectedError: /caller ARN partition must be aws/,
    name: "wrong ARN partition",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        "arn:aws:sts::444455556666:"
        + "assumed-role/DeploymentRole/session",
    },
    expectedError: /caller ARN account does not match AWS_ACCOUNT_ID/,
    name: "other-account ARN",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:iam::${ACCOUNT_ID}:root`,
    },
    expectedError: /AWS root caller is not allowed/,
    name: "root ARN",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:iam::${ACCOUNT_ID}:role/DeploymentRole`,
    },
    expectedError: /recognized non-root principal/,
    name: "direct IAM role ARN",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/DeploymentRole`,
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN without a session",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role//session`,
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with an empty role name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:sts::${ACCOUNT_ID}:`
        + "assumed-role/platform/DeploymentRole/session",
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with a role path",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:sts::${ACCOUNT_ID}:`
        + "assumed-role/DeploymentRole/session/extra",
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with an extra trailing segment",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:sts::${ACCOUNT_ID}:`
        + "assumed-role/platform//DeploymentRole/session",
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with an empty path segment",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/DeploymentRole/`,
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with an empty session name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/DeploymentRole/a`,
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with a one-character session name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:sts::${ACCOUNT_ID}:assumed-role/`
        + `${"r".repeat(65)}/session`,
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with an overlong role name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:sts::${ACCOUNT_ID}:assumed-role/DeploymentRole/`
        + "s".repeat(65),
    },
    expectedError: /recognized non-root principal/,
    name: "assumed-role ARN with an overlong session name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:iam::${ACCOUNT_ID}:user/`,
    },
    expectedError: /recognized non-root principal/,
    name: "IAM user ARN without a user name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:iam::${ACCOUNT_ID}:user/platform//`,
    },
    expectedError: /recognized non-root principal/,
    name: "IAM user ARN with a valid path but no user name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:iam::${ACCOUNT_ID}:user/${"u".repeat(65)}`,
    },
    expectedError: /recognized non-root principal/,
    name: "IAM user ARN with an overlong user name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:iam::${ACCOUNT_ID}:user/`
        + `${"p".repeat(511)}/alice`,
    },
    expectedError: /recognized non-root principal/,
    name: "IAM user ARN with an overlong path",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn: `arn:aws:sts::${ACCOUNT_ID}:federated-user/a`,
    },
    expectedError: /recognized non-root principal/,
    name: "federated-user ARN with a one-character name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:sts::${ACCOUNT_ID}:federated-user/`
        + "f".repeat(33),
    },
    expectedError: /recognized non-root principal/,
    name: "federated-user ARN with an overlong name",
  },
  {
    document: {
      Account: ACCOUNT_ID,
      Arn:
        `arn:aws:sts::${ACCOUNT_ID}:`
        + "federated-user/deployment-session/extra",
    },
    expectedError: /recognized non-root principal/,
    name: "federated-user ARN with an extra path segment",
  },
];

for (const callerCase of invalidCallerCases) {
  test(`GitHub deployment audit rejects ${callerCase.name}`, () => {
    const responses = baseResponses();
    responses.set(
      key(...COMMANDS.caller),
      JSON.stringify(callerCase.document),
    );
    const { calls, evidenceWrites, options } = fixture({ responses });

    assert.throws(
      () => auditPredeploy(options),
      callerCase.expectedError,
    );
    assert.deepEqual(
      calls.map(({ command, args }) => [command, ...args]),
      [COMMANDS.origin, COMMANDS.caller],
    );
    assert.equal(evidenceWrites[0].evidence.status, "failed");
    assert.equal(evidenceWrites[0].evidence.caller, null);
  });
}

test("rejects duplicate, malformed, and incorrectly audience-scoped GitHub OIDC providers", () => {
  const duplicateResponses = baseResponses();
  duplicateResponses.set(
    key(...COMMANDS.oidcList),
    JSON.stringify({
      OpenIDConnectProviderList: [
        { Arn: OIDC_ARN },
        { Arn: OIDC_ARN },
      ],
    }),
  );
  assert.throws(
    () => auditPredeploy(fixture({ responses: duplicateResponses }).options),
    /multiple token.actions.githubusercontent.com OIDC providers/,
  );

  const malformedResponses = baseResponses();
  malformedResponses.set(
    key(...COMMANDS.oidcGet),
    JSON.stringify({
      Url: "token.actions.githubusercontent.com/",
      ClientIDList: ["sts.amazonaws.com"],
    }),
  );
  assert.throws(
    () => auditPredeploy(fixture({ responses: malformedResponses }).options),
    /OIDC provider URL is malformed/,
  );

  const audienceResponses = baseResponses();
  audienceResponses.set(
    key(...COMMANDS.oidcGet),
    JSON.stringify({
      Url: "token.actions.githubusercontent.com",
      ClientIDList: ["another-audience.example"],
    }),
  );
  assert.throws(
    () => auditPredeploy(fixture({ responses: audienceResponses }).options),
    /sts.amazonaws.com audience/,
  );
});

const malformedOidcListMembers = [
  null,
  "not-an-object",
  {},
  { Arn: 42 },
  { Arn: `arn:aws:iam::${ACCOUNT_ID}:oidc-provider/` },
  {
    Arn:
      `arn:aws-us-gov:iam::${ACCOUNT_ID}:`
      + "oidc-provider/token.actions.githubusercontent.com",
  },
  {
    Arn:
      "arn:aws:iam::444455556666:"
      + "oidc-provider/token.actions.githubusercontent.com",
  },
  { Arn: `arn:aws:sts::${ACCOUNT_ID}:oidc-provider/example.com` },
  { Arn: `${OIDC_ARN}/duplicate` },
  {
    Arn:
      `arn:aws:iam::${ACCOUNT_ID}:`
      + "oidc-provider/https://token.actions.githubusercontent.com",
  },
];

for (const [index, member] of malformedOidcListMembers.entries()) {
  test(
    `GitHub deployment audit rejects malformed OIDC list member ${index + 1}`,
    () => {
      const responses = baseResponses();
      responses.set(
        key(...COMMANDS.oidcList),
        JSON.stringify({ OpenIDConnectProviderList: [member] }),
      );
      const { evidenceWrites, options } = fixture({ responses });

      assert.throws(
        () => auditPredeploy(options),
        /OIDC provider (list member|ARN)/,
      );
      assert.equal(evidenceWrites[0].evidence.status, "failed");
      assert.equal(evidenceWrites[0].evidence.githubOidc, null);
    },
  );
}

test("GitHub deployment audit ignores a valid unrelated OIDC provider", () => {
  const responses = baseResponses();
  responses.set(
    key(...COMMANDS.oidcList),
    JSON.stringify({
      OpenIDConnectProviderList: [{
        Arn:
          `arn:aws:iam::${ACCOUNT_ID}:`
          + "oidc-provider/accounts.google.com",
      }],
    }),
  );

  const result = auditPredeploy(fixture({ responses }).options);

  assert.deepEqual(result.evidence.githubOidc, {
    audiencePresent: null,
    providerCount: 0,
    status: "absent",
    url: null,
  });
});

test("never treats OIDC list or get failures as provider absence", () => {
  for (const command of [COMMANDS.oidcList, COMMANDS.oidcGet]) {
    const responses = baseResponses();
    responses.set(
      key(...command),
      new AuditCommandError(command[0], command.slice(1), {
        status: 255,
        stderr: "AccessDenied",
      }),
    );
    assert.throws(
      () => auditPredeploy(fixture({ responses }).options),
      /command failed/,
    );
  }
});

test("requires CDKToolkit termination protection and a matching modern bootstrap version", () => {
  const unprotectedResponses = baseResponses();
  const unprotected = JSON.parse(
    unprotectedResponses.get(key(...COMMANDS.toolkit)),
  );
  unprotected.Stacks[0].EnableTerminationProtection = false;
  unprotectedResponses.set(key(...COMMANDS.toolkit), JSON.stringify(unprotected));
  assert.throws(
    () => auditPredeploy(fixture({ responses: unprotectedResponses }).options),
    /CDKToolkit termination protection must be enabled/,
  );

  const oldVersionResponses = toolkitResponses({ bootstrapVersion: 5 });
  assert.throws(
    () => auditPredeploy(fixture({ responses: oldVersionResponses }).options),
    /bootstrap version must be at least 6/,
  );

  const mismatchResponses = baseResponses();
  mismatchResponses.set(key(...COMMANDS.bootstrapVersion), "22\n");
  assert.throws(
    () => auditPredeploy(fixture({ responses: mismatchResponses }).options),
    /bootstrap version output does not match/,
  );
});

test("does not hide non-missing CDKToolkit inspection failures", () => {
  const responses = baseResponses();
  responses.set(
    key(...COMMANDS.toolkit),
    new AuditCommandError("aws", COMMANDS.toolkit.slice(1), {
      status: 255,
      stderr: "AccessDenied",
    }),
  );

  assert.throws(
    () => auditPredeploy(fixture({ responses }).options),
    /command failed/,
  );
});

test("default command runner uses execFile without a shell", () => {
  const invocations = [];
  const runner = createCommandRunner((command, args, options) => {
    invocations.push({ command, args, options });
    return "output\n";
  });

  assert.equal(
    runner("git", ["remote", "get-url", "origin"], { cwd: "/workspace" }),
    "output\n",
  );
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, "git");
  assert.deepEqual(invocations[0].args, ["remote", "get-url", "origin"]);
  assert.equal(invocations[0].options.shell, false);
  assert.equal(invocations[0].options.cwd, "/workspace");
});

test("GitHub deployment audit command errors never expose raw stderr", () => {
  const sensitiveStderr =
    "AccessDenied github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
  const runner = createCommandRunner(() => {
    const error = new Error("command failed");
    error.status = 255;
    error.stderr = sensitiveStderr;
    throw error;
  });

  assert.throws(
    () => runner("aws", ["iam", "list-open-id-connect-providers"]),
    (error) => {
      assert.equal(error instanceof AuditCommandError, true);
      assert.equal(error.stderr, undefined);
      assert.equal(Object.hasOwn(error, "stderr"), false);
      assert.equal(Object.keys(error).includes("stderr"), false);
      assert.equal(JSON.stringify(error).includes(sensitiveStderr), false);
      return true;
    },
  );

  const responses = baseResponses();
  responses.set(
    key(...COMMANDS.toolkit),
    new AuditCommandError("aws", COMMANDS.toolkit.slice(1), {
      status: 255,
      stderr: sensitiveStderr,
    }),
  );
  assert.throws(
    () => auditPredeploy(fixture({ responses }).options),
    (error) => {
      assert.equal(error.stderr, undefined);
      assert.equal(Object.hasOwn(error, "stderr"), false);
      assert.equal(JSON.stringify(error).includes(sensitiveStderr), false);
      return true;
    },
  );
});

test("redacts account, key, token, password, and client-secret material", () => {
  const unsafe = [
    ACCOUNT_ID,
    "AKIA" + "A".repeat(16),
    "ghp_" + "a".repeat(36),
    "github_pat_" + "a".repeat(82),
    "password=DoNotWriteThis",
    "client_secret=DoNotWriteThis",
    "access_token=DoNotWriteThis",
  ].join(" ");

  const redacted = redactSensitiveText(unsafe);

  assert.equal(redacted.includes(ACCOUNT_ID), false);
  assert.doesNotMatch(redacted, /DoNotWriteThis|AKIA|ghp_|github_pat_/);
});

test('control-plane model-policy read is required after deployment and grants no writes', () => {
  const command=key(...controlPlaneReadRoleGetPolicyCommand());
  const responses=githubEnabledResponses();
  const previous=JSON.parse(responses.get(command));
  previous.PolicyDocument.Statement[3].Condition['ForAllValues:StringEquals']['dynamodb:LeadingKeys']=['DOMAIN'];
  responses.set(command,JSON.stringify(previous));
  assert.equal(auditPredeploy(fixture({env:githubEnabledEnvironment(),responses}).options).evidence.status,'passed');
  assert.throws(()=>auditPredeploy(fixture({env:githubEnabledEnvironment({SECURITY_AUDIT_MODE:'postdeploy'}),responses}).options),/control-plane read role|inline policy/i);
  const writable=githubEnabledResponses();
  const policy=JSON.parse(writable.get(command));
  policy.PolicyDocument.Statement[3].Action.push('dynamodb:PutItem');
  writable.set(command,JSON.stringify(policy));
  assert.throws(()=>auditPredeploy(fixture({env:githubEnabledEnvironment({SECURITY_AUDIT_MODE:'postdeploy'}),responses:writable}).options),/control-plane read role|inline policy/i);
});

test("control-plane boundary fixture follows the deployable CDK source contract", () => {
  const source = readFileSync(new URL(
    "../../platform-registry/config/control-plane-runtime-permissions-boundary.json",
    import.meta.url,
  ), "utf8");
  const expected = JSON.parse(source
    .replaceAll("${ACCOUNT}", ACCOUNT_ID)
    .replaceAll("${REGION}", REGION)
    .replaceAll("${PARTITION}", "aws")
    .replaceAll("${PROVISIONED_NAME_PREFIX}", "acp-cp-prov"));
  assert.deepEqual(CONTROL_PLANE_RUNTIME_BOUNDARY_POLICY, expected);
});

test("manual provisioned postdeploy audits runtime controls without requiring GitHub bootstrap roles", () => {
  const { calls, options } = fixture({
    env: provisionedControlPlaneEnvironment({
      SECURITY_AUDIT_MODE: "postdeploy",
      ENABLE_GITHUB_DEPLOYMENT: "false",
      BRANCH_PROTECTION_ATTESTED: "false",
    }),
    responses: provisionedControlPlaneResponses(),
  });
  const result = auditPredeploy(options);
  assert.equal(result.evidence.status, "passed");
  assert.equal(result.evidence.controlPlaneExecutionRole.required, false);
  assert.equal(result.evidence.controlPlaneExecutionRole.status, "not-required");
  assert.equal(result.evidence.controlPlaneRuntimeBoundary.status, "passed");
  assert.equal(result.evidence.controlPlaneRuntimeRoles.status, "passed");
  assert.equal(result.evidence.runtimeRoles.status, "passed");
  assert.ok(!calls.some(({ args }) => args.includes(CLOUDFORMATION_EXECUTION_ROLE_NAME)));
});

test("provision audit verifies CloudFormation-truncated role names by stack identity", () => {
  const responses = provisionedControlPlaneResponses();
  const resources = JSON.parse(responses.get(key(...COMMANDS.provisionedControlPlaneResources)));
  const resource = resources.StackResourceSummaries[0];
  const oldName = resource.PhysicalResourceId;
  const name = "AgenticPlatform-ControlPl-RegistryOnEventHandlerSer-AbCd12345678";
  const role = JSON.parse(responses.get(key(...runtimeRoleCommand(oldName))));
  resource.PhysicalResourceId = name;
  role.Role.RoleName = name;
  role.Role.Arn = `arn:aws:iam::${ACCOUNT_ID}:role/${name}`;
  responses.set(key(...COMMANDS.provisionedControlPlaneResources), JSON.stringify(resources));
  responses.set(key(...runtimeRoleCommand(name)), JSON.stringify(role));
  const { options } = fixture({ env: provisionedControlPlaneEnvironment(), responses });
  const result = auditPredeploy(options);
  assert.equal(result.evidence.controlPlaneRuntimeRoles.status, "passed");
  assert.ok(result.evidence.controlPlaneRuntimeRoles.roles.some((r) => r.roleName === name && r.arnMatches && r.boundaryMatches));
});

test("provision audit rejects malformed physical role names from stack inventory", () => {
  const responses = provisionedControlPlaneResponses();
  const resources = JSON.parse(responses.get(key(...COMMANDS.provisionedControlPlaneResources)));
  resources.StackResourceSummaries[0].PhysicalResourceId = "invalid/role";
  responses.set(key(...COMMANDS.provisionedControlPlaneResources), JSON.stringify(resources));
  const { options } = fixture({ env: provisionedControlPlaneEnvironment(), responses });
  assert.throws(() => auditPredeploy(options), /invalid physical role name/i);
});
