import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import { Construct } from "constructs";
import {
  applyRequiredTags,
  CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  GitHubOidcSubjectMode,
  HOSTED_ACCEPTANCE_ROLE_NAME,
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
  REQUIRED_TAGS,
  RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  stackName,
  validateGitHubDeploymentMetadata,
} from "./config";

export interface GitHubBootstrapStackProps extends cdk.StackProps {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  workflowRef: string;
  githubOidcSubjectMode: GitHubOidcSubjectMode;
  githubOidcSubject: string;
  branchProtectionAttested: boolean;
  githubOidcProviderArn?: string;
}

export class GitHubBootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubBootstrapStackProps) {
    if (props.branchProtectionAttested !== true) {
      throw new Error(
        "GitHub deployment requires protected main branch protection "
          + "to be explicitly attested.",
      );
    }
    const githubMetadata = validateGitHubDeploymentMetadata(props);
    super(scope, id, {
      ...props,
      stackName: stackName("GitHubBootstrap"),
      terminationProtection: true,
    });
    applyRequiredTags(this);

    let providerArn = props.githubOidcProviderArn;
    if (!providerArn) {
      const provider = new iam.CfnOIDCProvider(this, "GitHubProvider", {
        url: "https://token.actions.githubusercontent.com",
        clientIdList: ["sts.amazonaws.com"],
      });
      providerArn = provider.attrArn;
    }

    const executionRole = new iam.Role(this, "CloudFormationExecutionRole", {
      roleName: "AgenticPlatformCloudFormationExecutionRole",
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
      description:
        "CloudFormation execution role for the Stage 1 Agentic Platform stack",
      maxSessionDuration: cdk.Duration.hours(2),
    });
    const executionRoleArn =
      `arn:${this.partition}:iam::${this.account}:role/`
      + "AgenticPlatformCloudFormationExecutionRole";

    const assetBucketName =
      `cdk-${cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER}-assets-`
      + `${this.account}-${this.region}`;
    const assetBucketArn = `arn:${this.partition}:s3:::${assetBucketName}`;
    const webRoleArns = Object.values(PLATFORM_WEB_RUNTIME_ROLE_NAMES)
      .map((roleName) =>
        `arn:${this.partition}:iam::${this.account}:role/${roleName}`
      );
    const agentRuntimeRoleArn =
      `arn:${this.partition}:iam::${this.account}:role/`
      + PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime;
    const hostedAcceptanceRoleArn =
      `arn:${this.partition}:iam::${this.account}:role/`
      + HOSTED_ACCEPTANCE_ROLE_NAME;
    const webManagedRoleArns = [
      ...webRoleArns,
      hostedAcceptanceRoleArn,
    ];
    const boundaryArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + RUNTIME_PERMISSIONS_BOUNDARY_NAME;
    const controlPlaneRuntimeBoundaryArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME;
    const webFunctionArn =
      `arn:${this.partition}:lambda:${this.region}:${this.account}:`
      + "function:AgenticPlatform-Web-*";
    const webLayerArn =
      `arn:${this.partition}:lambda:${this.region}:${this.account}:`
      + "layer:AgenticPlatform-Web-*";
    const webLogGroupArn =
      `arn:${this.partition}:logs:${this.region}:${this.account}:`
      + "log-group:AgenticPlatform-Web-*";
    const webUserPoolArn =
      `arn:${this.partition}:cognito-idp:${this.region}:${this.account}:`
      + "userpool/*";
    const webApiCollectionArn =
      `arn:${this.partition}:apigateway:${this.region}::/apis`;
    const webApiArn = `${webApiCollectionArn}/*`;
    const webApiTagArn =
      `arn:${this.partition}:apigateway:${this.region}::/tags/*`;
    const webDistributionArn =
      `arn:${this.partition}:cloudfront::${this.account}:distribution/*`;
    const webDashboardArn =
      `arn:${this.partition}:cloudwatch::${this.account}:`
      + "dashboard/AgenticPlatform-WebIdentity";
    const webIdentityAlarmArn =
      `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:`
      + "alarm:AgenticPlatform-IdentityApi-Errors";
    const platformStateTableArn =
      `arn:${this.partition}:dynamodb:${this.region}:${this.account}:`
      + "table/AgenticPlatform-Web-PlatformStateTable*";
    const deployedStackResources = [
      "AgenticPlatform-Web",
      "AgenticPlatform-ControlPlane",
      "AgenticPlatform-ControlPlane-Provisioned",
    ].flatMap((deployedStackName) => [
      `arn:${this.partition}:cloudformation:${this.region}:${this.account}:`
        + `stack/${deployedStackName}/*`,
      `arn:${this.partition}:cloudformation:${this.region}:${this.account}:`
        + `changeSet/${deployedStackName}/*`,
    ]);
    const controlPlaneResourcePrefix =
      "AgenticPlatform-ControlPlane-Provisioned-*";
    const controlPlaneRoleArn =
      `arn:${this.partition}:iam::${this.account}:`
      + `role/${controlPlaneResourcePrefix}`;
    const controlPlaneLambdaBasicExecutionPolicyArn =
      `arn:${this.partition}:iam::aws:policy/service-role/`
      + "AWSLambdaBasicExecutionRole";
    const controlPlaneFunctionArn =
      `arn:${this.partition}:lambda:${this.region}:${this.account}:`
      + `function:${controlPlaneResourcePrefix}`;
    const controlPlaneLogGroupArn =
      `arn:${this.partition}:logs:${this.region}:${this.account}:`
      + `log-group:${controlPlaneResourcePrefix}`;
    const controlPlaneStateMachineArn =
      `arn:${this.partition}:states:${this.region}:${this.account}:`
      + `stateMachine:${controlPlaneResourcePrefix}`;
    const controlPlaneParameterArn =
      `arn:${this.partition}:ssm:${this.region}:${this.account}:`
      + "parameter/agentic-platform/control-plane/config";
    const controlPlaneRegistryArns = [
      `arn:${this.partition}:agent-registry:${this.region}:${this.account}:`
        + "registry/*",
      `arn:${this.partition}:agent-registry:${this.region}:${this.account}:`
        + "registry/*/record/*",
    ];
    const controlPlaneGatewayArn =
      `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:`
      + "gateway/*";
    const ownedControlPlaneGatewayArns = [
      `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:`
        + "gateway/agentic-demo-llm-gateway-*",
      `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:`
        + "gateway/platform-tools-gw-*",
    ];
    const controlPlaneMantleProjectArn =
      `arn:${this.partition}:bedrock-mantle:${this.region}:${this.account}:`
      + "project/default";
    const stage1AgentRuntimeArn =
      `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:`
      + "runtime/AgenticPlatformRuntime-*";
    const stage1AgentRuntimeEndpointArn =
      `${stage1AgentRuntimeArn}/runtime-endpoint/*`;
    const stage1LogDeliverySourceArn =
      `arn:${this.partition}:logs:${this.region}:${this.account}:`
      + "delivery-source:AgenticPlatformWebGoverned*";
    const stage1LogDeliveryDestinationArn =
      `arn:${this.partition}:logs:${this.region}:${this.account}:`
      + "delivery-destination:AgenticPlatformWebGoverned*";
    const stage1LogDeliveryArn =
      `arn:${this.partition}:logs:${this.region}:${this.account}:delivery:*`;
    const stage1AgentRuntimeWorkloadIdentityDirectoryArn =
      `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:`
      + "workload-identity-directory/default";
    const stage1AgentRuntimeWorkloadIdentityArn =
      `${stage1AgentRuntimeWorkloadIdentityDirectoryArn}/`
      + "workload-identity/AgenticPlatformRuntime-*";
    const agentCoreRuntimeIdentityServiceLinkedRoleArn =
      `arn:${this.partition}:iam::${this.account}:role/aws-service-role/`
      + "runtime-identity.bedrock-agentcore.amazonaws.com/"
      + "AWSServiceRoleForBedrockAgentCoreRuntimeIdentity";
    const controlPlaneWorkloadIdentityArn =
      `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:`
      + "workload-identity-directory/*";
    const controlPlaneRegistryServiceRoleArn =
      `arn:${this.partition}:iam::${this.account}:`
      + "role/aws-service-role/agent-registry.amazonaws.com/"
      + "AWSServiceRoleForAgentRegistry";
    const requiredRequestTagConditions = {
      "ForAllValues:StringEquals": {
        "aws:TagKeys": Object.keys(REQUIRED_TAGS).sort(),
      },
      StringEquals: Object.fromEntries(
        Object.entries(REQUIRED_TAGS).map(([key, value]) => [
          `aws:RequestTag/${key}`,
          value,
        ]),
      ),
    };
    const requiredResourceTagConditions = {
      StringEquals: Object.fromEntries(
        Object.entries(REQUIRED_TAGS).map(([key, value]) => [
          `aws:ResourceTag/${key}`,
          value,
        ]),
      ),
    };
    const requiredTagMutationConditions = {
      "ForAllValues:StringEquals":
        requiredRequestTagConditions["ForAllValues:StringEquals"],
      StringEquals: {
        ...requiredRequestTagConditions.StringEquals,
        ...requiredResourceTagConditions.StringEquals,
      },
    };
    const controlPlaneRegistryRequestTagConditions = {
      "ForAllValues:StringEquals":
        requiredRequestTagConditions["ForAllValues:StringEquals"],
      StringEquals: {
        ...requiredRequestTagConditions.StringEquals,
        "aws:RequestedRegion": this.region,
      },
    };
    const controlPlaneRegistryTagMutationConditions = {
      "ForAllValues:StringEquals":
        controlPlaneRegistryRequestTagConditions[
          "ForAllValues:StringEquals"
        ],
      StringEquals: {
        ...controlPlaneRegistryRequestTagConditions.StringEquals,
        ...requiredResourceTagConditions.StringEquals,
      },
    };
    const controlPlaneRoleRequestConditions = {
      "ForAllValues:StringEquals":
        requiredRequestTagConditions["ForAllValues:StringEquals"],
      StringEquals: {
        ...requiredRequestTagConditions.StringEquals,
        "iam:PermissionsBoundary": controlPlaneRuntimeBoundaryArn,
      },
    };
    const stage1AgentRuntimeRequestTagConditions = {
      "ForAllValues:StringEquals":
        requiredRequestTagConditions["ForAllValues:StringEquals"],
      StringEquals: {
        ...requiredRequestTagConditions.StringEquals,
        "aws:RequestedRegion": this.region,
      },
    };
    const stage1AgentRuntimeTagMutationConditions = {
      "ForAllValues:StringEquals":
        stage1AgentRuntimeRequestTagConditions[
          "ForAllValues:StringEquals"
        ],
      StringEquals: {
        ...stage1AgentRuntimeRequestTagConditions.StringEquals,
        ...requiredResourceTagConditions.StringEquals,
      },
    };
    const stage1AgentRuntimeResourceTagConditions = {
      StringEquals: {
        ...requiredResourceTagConditions.StringEquals,
        "aws:RequestedRegion": this.region,
      },
    };
    const stage1AgentRuntimeOptionalUntagConditions = {
      "ForAllValues:StringNotEquals": {
        "aws:TagKeys": Object.keys(REQUIRED_TAGS).sort(),
      },
      StringEquals: stage1AgentRuntimeResourceTagConditions.StringEquals,
    };
    const stage1LogDeliveryCreateConditions = {
      "ForAllValues:StringEquals":
        stage1AgentRuntimeRequestTagConditions[
          "ForAllValues:StringEquals"
        ],
      StringEquals: {
        ...stage1AgentRuntimeRequestTagConditions.StringEquals,
        ...requiredResourceTagConditions.StringEquals,
      },
    };

    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateStage1Resources",
      actions: [
        "cloudfront:CreateOriginAccessControl",
        "cloudfront:CreateResponseHeadersPolicy",
        "cognito-idp:DescribeUserPoolDomain",
      ],
      resources: ["*"],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageStage1Dashboard",
      actions: [
        "cloudwatch:DeleteDashboards",
        "cloudwatch:GetDashboard",
        "cloudwatch:PutDashboard",
      ],
      resources: [webDashboardArn],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateTaggedStage1Resources",
      actions: [
        "cloudfront:CreateDistribution",
        "cognito-idp:CreateUserPool",
      ],
      resources: ["*"],
      conditions: requiredRequestTagConditions,
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateTaggedPlatformStateTable",
      actions: ["dynamodb:CreateTable"],
      resources: [platformStateTableArn],
      conditions: requiredRequestTagConditions,
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadCdkBootstrapAssets",
      actions: ["s3:GetObject", "s3:GetObjectVersion"],
      resources: [`${assetBucketArn}/*`],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageStage1S3Buckets",
      actions: [
        "s3:AbortMultipartUpload",
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:DeleteBucketPolicy",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:GetAccelerateConfiguration",
        "s3:GetBucketAcl",
        "s3:GetBucketCORS",
        "s3:GetBucketLocation",
        "s3:GetBucketLogging",
        "s3:GetBucketNotification",
        "s3:GetBucketObjectLockConfiguration",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketTagging",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:PutBucketAcl",
        "s3:PutBucketLogging",
        "s3:PutBucketOwnershipControls",
        "s3:PutBucketPolicy",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketTagging",
        "s3:PutBucketVersioning",
        "s3:PutEncryptionConfiguration",
        "s3:PutLifecycleConfiguration",
        "s3:PutObject",
      ],
      resources: [
        `arn:${this.partition}:s3:::agenticplatform-web-*`,
        `arn:${this.partition}:s3:::agenticplatform-web-*/*`,
      ],
    }));
    const runtimeRoleManagementPolicyName =
      "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleManagement";
    const runtimeRoleManagementPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + runtimeRoleManagementPolicyName;
    const runtimeRoleDelegationPolicyName =
      "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleDelegation";
    const runtimeRoleDelegationPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + runtimeRoleDelegationPolicyName;
    const runtimeRoleBoundaryPolicyName =
      "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleBoundary";
    const runtimeRoleBoundaryPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + runtimeRoleBoundaryPolicyName;
    const runtimeRoleManagementPolicy = new iam.ManagedPolicy(
      this,
      "Stage1RuntimeRoleManagementPolicy",
      {
        managedPolicyName: runtimeRoleManagementPolicyName,
        roles: [executionRole],
        statements: [
          new iam.PolicyStatement({
            sid: "CreateWebRoles",
            actions: ["iam:CreateRole"],
            resources: webRoleArns,
            conditions: {
              StringEquals: {
                "iam:PermissionsBoundary": boundaryArn,
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "CreateAcceptance",
            actions: ["iam:CreateRole"],
            resources: [hostedAcceptanceRoleArn],
            conditions: requiredRequestTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "ManageWebRoles",
            actions: [
              "iam:DeleteRole",
              "iam:DeleteRolePolicy",
              "iam:GetRole",
              "iam:GetRolePolicy",
              "iam:ListAttachedRolePolicies",
              "iam:ListRolePolicies",
              "iam:PutRolePolicy",
              "iam:TagRole",
              "iam:UntagRole",
              "iam:UpdateAssumeRolePolicy",
              "iam:UpdateRole",
              "iam:UpdateRoleDescription",
            ],
            resources: webManagedRoleArns,
          }),
          new iam.PolicyStatement({
            sid: "ManageStateTable",
            actions: [
              "dynamodb:DeleteTable",
              "dynamodb:DescribeContinuousBackups",
              "dynamodb:DescribeTable",
              "dynamodb:DescribeTimeToLive",
              "dynamodb:ListTagsOfResource",
              "dynamodb:TagResource",
              "dynamodb:UntagResource",
              "dynamodb:UpdateContinuousBackups",
              "dynamodb:UpdateTable",
              "dynamodb:UpdateTimeToLive",
            ],
            resources: [platformStateTableArn],
          }),
          new iam.PolicyStatement({
            sid: "ManageControlPlanePolicy",
            actions: [
              "iam:AttachRolePolicy",
              "iam:DetachRolePolicy",
            ],
            resources: [controlPlaneRoleArn],
            conditions: {
              ArnEquals: {
                "iam:PolicyARN":
                  controlPlaneLambdaBasicExecutionPolicyArn,
              },
            },
          }),
        ],
      },
    );
    const runtimeRoleDelegationPolicy = new iam.ManagedPolicy(
      this,
      "Stage1RuntimeRoleDelegationPolicy",
      {
        managedPolicyName: runtimeRoleDelegationPolicyName,
        roles: [executionRole],
        statements: [
          new iam.PolicyStatement({
            sid: "ApplyStage1RoleBoundary",
            actions: ["iam:PutRolePermissionsBoundary"],
            resources: webRoleArns,
            conditions: {
              StringEquals: {
                "iam:PermissionsBoundary": boundaryArn,
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "PassStage1RolesToLambda",
            actions: ["iam:PassRole"],
            resources: webRoleArns,
            conditions: {
              StringEquals: {
                "iam:PassedToService": "lambda.amazonaws.com",
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "PassAgentRuntimeRoleToAgentCore",
            actions: ["iam:PassRole"],
            resources: [agentRuntimeRoleArn],
            conditions: {
              StringEquals: {
                "iam:PassedToService":
                  "bedrock-agentcore.amazonaws.com",
              },
            },
          }),
        ],
      },
    );
    const runtimeRoleBoundaryPolicy = new iam.ManagedPolicy(
      this,
      "Stage1RuntimeRoleBoundaryPolicy",
      {
        managedPolicyName: runtimeRoleBoundaryPolicyName,
        roles: [executionRole],
        statements: [
          new iam.PolicyStatement({
            sid: "DenyStage1RoleBoundaryRemoval",
            effect: iam.Effect.DENY,
            actions: ["iam:DeleteRolePermissionsBoundary"],
            resources: webRoleArns,
          }),
        ],
      },
    );
    const controlPlaneDeploymentPolicyName =
      "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment";
    const controlPlaneDeploymentPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + controlPlaneDeploymentPolicyName;
    const controlPlaneRegistryDeploymentPolicyName =
      "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment";
    const controlPlaneRegistryDeploymentPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + controlPlaneRegistryDeploymentPolicyName;
    const controlPlaneGatewayDeploymentPolicyName =
      "AgenticPlatform-GitHubBootstrap-ControlPlaneGatewayDeployment";
    const controlPlaneGatewayDeploymentPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + controlPlaneGatewayDeploymentPolicyName;
    const agentRuntimeDeploymentPolicyName =
      "AgenticPlatform-GitHubBootstrap-AgentRuntimeDeployment";
    const agentRuntimeDeploymentPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + agentRuntimeDeploymentPolicyName;
    const agentRuntimeObservabilityDeploymentPolicyName =
      "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment";
    const agentRuntimeObservabilityDeploymentPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + agentRuntimeObservabilityDeploymentPolicyName;
    const deploymentValidationPolicyName =
      "AgenticPlatform-GitHubBootstrap-DeploymentValidation";
    const deploymentValidationPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + deploymentValidationPolicyName;
    const controlPlaneDeploymentValidationPolicyName =
      "AgenticPlatform-GitHubBootstrap-ControlPlaneDeploymentValidation";
    const controlPlaneDeploymentValidationPolicyArn =
      `arn:${this.partition}:iam::${this.account}:policy/`
      + controlPlaneDeploymentValidationPolicyName;
    const controlPlaneDeploymentPolicy = new iam.ManagedPolicy(
      this,
      "ControlPlaneDeploymentPolicy",
      {
        managedPolicyName: controlPlaneDeploymentPolicyName,
        roles: [executionRole],
        statements: [
          new iam.PolicyStatement({
            sid: "ManageControlPlaneRuntimeBoundary",
            actions: [
              "iam:CreatePolicy",
              "iam:CreatePolicyVersion",
              "iam:DeletePolicy",
              "iam:DeletePolicyVersion",
              "iam:GetPolicy",
              "iam:GetPolicyVersion",
              "iam:ListPolicyVersions",
              "iam:SetDefaultPolicyVersion",
              "iam:TagPolicy",
              "iam:UntagPolicy",
            ],
            resources: [controlPlaneRuntimeBoundaryArn],
          }),
          new iam.PolicyStatement({
            sid: "ManageControlPlaneSsmParameter",
            actions: [
              "ssm:AddTagsToResource",
              "ssm:DeleteParameter",
              "ssm:GetParameter",
              "ssm:GetParameters",
              "ssm:ListTagsForResource",
              "ssm:PutParameter",
              "ssm:RemoveTagsFromResource",
            ],
            resources: [controlPlaneParameterArn],
          }),
          new iam.PolicyStatement({
            sid: "CreateControlPlaneIamRolesWithBoundary",
            actions: ["iam:CreateRole"],
            resources: [controlPlaneRoleArn],
            conditions: controlPlaneRoleRequestConditions,
          }),
          new iam.PolicyStatement({
            sid: "ApplyControlPlaneRoleBoundary",
            actions: ["iam:PutRolePermissionsBoundary"],
            resources: [controlPlaneRoleArn],
            conditions: {
              StringEquals: {
                "iam:PermissionsBoundary":
                  controlPlaneRuntimeBoundaryArn,
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "DenyControlPlaneRoleBoundaryRemoval",
            effect: iam.Effect.DENY,
            actions: ["iam:DeleteRolePermissionsBoundary"],
            resources: [controlPlaneRoleArn],
          }),
          new iam.PolicyStatement({
            sid: "ManageControlPlaneIamRoles",
            actions: [
              "iam:DeleteRole",
              "iam:DeleteRolePolicy",
              "iam:GetRole",
              "iam:GetRolePolicy",
              "iam:ListAttachedRolePolicies",
              "iam:ListRolePolicies",
              "iam:PutRolePolicy",
              "iam:TagRole",
              "iam:UntagRole",
              "iam:UpdateAssumeRolePolicy",
              "iam:UpdateRole",
              "iam:UpdateRoleDescription",
            ],
            resources: [controlPlaneRoleArn],
          }),
          ...[
            ["PassControlPlaneRolesToLambda", "lambda.amazonaws.com"],
            [
              "PassControlPlaneRolesToStepFunctions",
              "states.amazonaws.com",
            ],
            [
              "PassControlPlaneRolesToAgentCore",
              "bedrock-agentcore.amazonaws.com",
            ],
          ].map(([sid, service]) =>
            new iam.PolicyStatement({
              sid,
              actions: ["iam:PassRole"],
              resources: [controlPlaneRoleArn],
              conditions: {
                StringEquals: {
                  "iam:PassedToService": service,
                },
              },
            })
          ),
          new iam.PolicyStatement({
            sid: "CreateRegistryServiceLinkedRole",
            actions: ["iam:CreateServiceLinkedRole"],
            resources: [controlPlaneRegistryServiceRoleArn],
            conditions: {
              StringEquals: {
                "iam:AWSServiceName": "agent-registry.amazonaws.com",
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "ManageControlPlaneLambda",
            actions: [
              "lambda:AddPermission",
              "lambda:CreateFunction",
              "lambda:DeleteFunction",
              "lambda:DeleteFunctionConcurrency",
              "lambda:GetFunction",
              "lambda:GetFunctionCodeSigningConfig",
              "lambda:GetFunctionConfiguration",
              "lambda:GetFunctionConcurrency",
              "lambda:GetFunctionRecursionConfig",
              "lambda:GetFunctionScalingConfig",
              "lambda:GetPolicy",
              "lambda:GetRuntimeManagementConfig",
              "lambda:InvokeFunction",
              "lambda:ListTags",
              "lambda:PutFunctionConcurrency",
              "lambda:RemovePermission",
              "lambda:TagResource",
              "lambda:UntagResource",
              "lambda:UpdateFunctionCode",
              "lambda:UpdateFunctionConfiguration",
            ],
            resources: [controlPlaneFunctionArn],
          }),
          new iam.PolicyStatement({
            sid: "ManageControlPlaneLogGroups",
            actions: [
              "logs:CreateLogGroup",
              "logs:DeleteLogGroup",
              "logs:DeleteRetentionPolicy",
              "logs:ListTagsForResource",
              "logs:PutRetentionPolicy",
              "logs:TagResource",
              "logs:UntagResource",
            ],
            resources: [controlPlaneLogGroupArn],
          }),
          new iam.PolicyStatement({
            sid: "ManageControlPlaneStateMachine",
            actions: [
              "states:CreateStateMachine",
              "states:DeleteStateMachine",
              "states:DescribeStateMachine",
              "states:ListTagsForResource",
              "states:TagResource",
              "states:UntagResource",
              "states:UpdateStateMachine",
            ],
            resources: [controlPlaneStateMachineArn],
          }),
          new iam.PolicyStatement({
            sid: "ManageControlPlaneWorkloadIdentities",
            actions: [
              "bedrock-agentcore:CreateWorkloadIdentity",
              "bedrock-agentcore:DeleteWorkloadIdentity",
              "bedrock-agentcore:GetWorkloadIdentity",
            ],
            resources: [controlPlaneWorkloadIdentityArn],
          }),
          new iam.PolicyStatement({
            sid: "CreateTaggedControlPlaneGateways",
            actions: ["bedrock-agentcore:CreateGateway"],
            resources: ["*"],
            conditions: requiredRequestTagConditions,
          }),
        ],
      },
    );
    const controlPlaneRegistryDeploymentPolicy = new iam.ManagedPolicy(
      this,
      "ControlPlaneRegistryDeploymentPolicy",
      {
        managedPolicyName: controlPlaneRegistryDeploymentPolicyName,
        roles: [executionRole],
        statements: [
          new iam.PolicyStatement({
            sid: "CreateTaggedControlPlaneRegistries",
            actions: ["agent-registry:CreateRegistry"],
            resources: ["*"],
            conditions: controlPlaneRegistryRequestTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "TagControlPlaneRegistries",
            actions: ["agent-registry:TagResource"],
            resources: [controlPlaneRegistryArns[0]],
            conditions: controlPlaneRegistryTagMutationConditions,
          }),
          new iam.PolicyStatement({
            sid: "CreateTaggedControlPlaneRegistryRecords",
            actions: ["agent-registry:CreateRegistryRecord"],
            resources: [controlPlaneRegistryArns[0]],
            conditions: controlPlaneRegistryTagMutationConditions,
          }),
          new iam.PolicyStatement({
            sid: "ReadControlPlaneRegistries",
            actions: [
              "agent-registry:GetRegistry",
              "agent-registry:ListRegistryRecords",
            ],
            resources: [controlPlaneRegistryArns[0]],
          }),
          new iam.PolicyStatement({
            sid: "ReadControlPlaneRegistryRecords",
            actions: ["agent-registry:GetRegistryRecord"],
            resources: [controlPlaneRegistryArns[1]],
          }),
          new iam.PolicyStatement({
            sid: "MutateTaggedControlPlaneRegistries",
            actions: [
              "agent-registry:DeleteRegistry",
              "agent-registry:UpdateRegistry",
            ],
            resources: [controlPlaneRegistryArns[0]],
            conditions: requiredResourceTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "MutateTaggedControlPlaneRegistryRecords",
            actions: [
              "agent-registry:DeleteRegistryRecord",
              "agent-registry:SubmitRegistryRecordForApproval",
              "agent-registry:UpdateRegistryRecordStatus",
            ],
            resources: [controlPlaneRegistryArns[1]],
            conditions: requiredResourceTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "ListControlPlaneRegistries",
            actions: ["agent-registry:ListRegistries"],
            resources: ["*"],
          }),
        ],
      },
    );
    const controlPlaneGatewayDeploymentPolicy = new iam.ManagedPolicy(
      this,
      "ControlPlaneGatewayDeploymentPolicy",
      {
        managedPolicyName: controlPlaneGatewayDeploymentPolicyName,
        roles: [executionRole],
        statements: [
          new iam.PolicyStatement({
            sid: "ReadControlPlaneGateways",
            actions: [
              "bedrock-agentcore:GetGateway",
              "bedrock-agentcore:GetGatewayTarget",
              "bedrock-agentcore:ListGatewayTargets",
              "bedrock-agentcore:ListTagsForResource",
            ],
            resources: ownedControlPlaneGatewayArns,
          }),
          new iam.PolicyStatement({
            sid: "CreateControlPlaneGatewayTargets",
            actions: ["bedrock-agentcore:CreateGatewayTarget"],
            resources: ownedControlPlaneGatewayArns,
          }),
          new iam.PolicyStatement({
            sid: "MutateTaggedControlPlaneGateways",
            actions: [
              "bedrock-agentcore:DeleteGateway",
              "bedrock-agentcore:DeleteGatewayTarget",
              "bedrock-agentcore:SynchronizeGatewayTargets",
              "bedrock-agentcore:TagResource",
              "bedrock-agentcore:UntagResource",
              "bedrock-agentcore:UpdateGateway",
              "bedrock-agentcore:UpdateGatewayTarget",
            ],
            resources: ownedControlPlaneGatewayArns,
            conditions: requiredResourceTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "ReadBedrockMantleModels",
            actions: [
              "bedrock-mantle:GetModel",
              "bedrock-mantle:ListModels",
            ],
            resources: [controlPlaneMantleProjectArn],
          }),
        ],
      },
    );
    const agentRuntimeDeploymentPolicy = new iam.ManagedPolicy(
      this,
      "AgentRuntimeDeploymentPolicy",
      {
        managedPolicyName: agentRuntimeDeploymentPolicyName,
        roles: [executionRole],
        statements: [
          new iam.PolicyStatement({
            sid: "CreateTaggedStage1AgentRuntime",
            actions: ["bedrock-agentcore:CreateAgentRuntime"],
            resources: ["*"],
            conditions: stage1AgentRuntimeRequestTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "TagStage1AgentRuntimeResources",
            actions: ["bedrock-agentcore:TagResource"],
            resources: [
              stage1AgentRuntimeArn,
              stage1AgentRuntimeEndpointArn,
            ],
            conditions: stage1AgentRuntimeRequestTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "ManageStage1AgentRuntimeWorkloadIdentity",
            actions: [
              "bedrock-agentcore:CreateWorkloadIdentity",
              "bedrock-agentcore:DeleteWorkloadIdentity",
            ],
            resources: [
              stage1AgentRuntimeWorkloadIdentityDirectoryArn,
              stage1AgentRuntimeWorkloadIdentityArn,
            ],
            conditions: {
              StringEquals: {
                "aws:RequestedRegion": this.region,
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "CreateAgentCoreRuntimeIdentityServiceLinkedRole",
            actions: ["iam:CreateServiceLinkedRole"],
            resources: [agentCoreRuntimeIdentityServiceLinkedRoleArn],
            conditions: {
              StringEquals: {
                "iam:AWSServiceName":
                  "runtime-identity.bedrock-agentcore.amazonaws.com",
              },
            },
          }),
          new iam.PolicyStatement({
            sid: "CreateTaggedStage1AgentRuntimeEndpoints",
            actions: [
              "bedrock-agentcore:CreateAgentRuntimeEndpoint",
            ],
            resources: [stage1AgentRuntimeArn],
            conditions: stage1AgentRuntimeTagMutationConditions,
          }),
          new iam.PolicyStatement({
            sid: "ManageTaggedStage1AgentRuntime",
            actions: [
              "bedrock-agentcore:DeleteAgentRuntime",
              "bedrock-agentcore:GetAgentRuntime",
              "bedrock-agentcore:ListTagsForResource",
              "bedrock-agentcore:UpdateAgentRuntime",
            ],
            resources: [stage1AgentRuntimeArn],
            conditions: stage1AgentRuntimeResourceTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "ManageTaggedStage1AgentRuntimeEndpoints",
            actions: [
              "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
              "bedrock-agentcore:GetAgentRuntimeEndpoint",
              "bedrock-agentcore:ListTagsForResource",
              "bedrock-agentcore:UpdateAgentRuntimeEndpoint",
            ],
            resources: [
              stage1AgentRuntimeArn,
              stage1AgentRuntimeEndpointArn,
            ],
            conditions: stage1AgentRuntimeResourceTagConditions,
          }),
          new iam.PolicyStatement({
            sid: "UntagOptionalStage1AgentRuntimeTags",
            actions: ["bedrock-agentcore:UntagResource"],
            resources: [
              stage1AgentRuntimeArn,
              stage1AgentRuntimeEndpointArn,
            ],
            conditions: stage1AgentRuntimeOptionalUntagConditions,
          }),
          new iam.PolicyStatement({
            sid: "DenyMandatoryStage1AgentRuntimeTagRemoval",
            effect: iam.Effect.DENY,
            actions: ["bedrock-agentcore:UntagResource"],
            resources: [
              stage1AgentRuntimeArn,
              stage1AgentRuntimeEndpointArn,
            ],
            conditions: {
              "ForAnyValue:StringEquals": {
                "aws:TagKeys": Object.keys(REQUIRED_TAGS).sort(),
              },
            },
          }),
        ],
      },
    );
    const agentRuntimeObservabilityDeploymentPolicy =
      new iam.ManagedPolicy(
        this,
        "AgentRuntimeObservabilityDeploymentPolicy",
        {
          managedPolicyName:
            agentRuntimeObservabilityDeploymentPolicyName,
          roles: [executionRole],
          statements: [
            new iam.PolicyStatement({
              sid:
                "CreateTaggedStage1LogDeliverySourcesAndDestinations",
              actions: [
                "logs:PutDeliveryDestination",
                "logs:PutDeliverySource",
              ],
              resources: [
                stage1LogDeliverySourceArn,
                stage1LogDeliveryDestinationArn,
              ],
              conditions: stage1AgentRuntimeRequestTagConditions,
            }),
            new iam.PolicyStatement({
              sid:
                "UpdateTaggedStage1LogDeliverySourcesAndDestinations",
              actions: [
                "logs:PutDeliveryDestination",
                "logs:PutDeliverySource",
              ],
              resources: [
                stage1LogDeliverySourceArn,
                stage1LogDeliveryDestinationArn,
              ],
              conditions: stage1AgentRuntimeResourceTagConditions,
            }),
            new iam.PolicyStatement({
              sid: "CreateTaggedStage1LogDeliveries",
              actions: ["logs:CreateDelivery"],
              resources: [
                stage1LogDeliverySourceArn,
                stage1LogDeliveryDestinationArn,
              ],
              conditions: stage1LogDeliveryCreateConditions,
            }),
            new iam.PolicyStatement({
              sid: "ManageTaggedStage1LogDeliveryResources",
              actions: [
                "logs:DeleteDelivery",
                "logs:DeleteDeliveryDestination",
                "logs:DeleteDeliveryDestinationPolicy",
                "logs:DeleteDeliverySource",
                "logs:GetDelivery",
                "logs:GetDeliveryDestination",
                "logs:GetDeliveryDestinationPolicy",
                "logs:GetDeliverySource",
                "logs:ListTagsForResource",
                "logs:PutDeliveryDestinationPolicy",
                "logs:UpdateDeliveryConfiguration",
              ],
              resources: [
                stage1LogDeliverySourceArn,
                stage1LogDeliveryDestinationArn,
                stage1LogDeliveryArn,
              ],
              conditions: stage1AgentRuntimeResourceTagConditions,
            }),
            new iam.PolicyStatement({
              sid: "DescribeStage1LogDeliveries",
              actions: ["logs:DescribeDeliveries"],
              resources: ["*"],
              conditions: {
                StringEquals: {
                  "aws:RequestedRegion": this.region,
                },
              },
            }),
            new iam.PolicyStatement({
              sid: "AllowStage1AgentRuntimeVendedLogDelivery",
              actions: [
                "logs:AllowVendedLogDeliveryForResource",
              ],
              resources: ["*"],
              conditions: stage1AgentRuntimeResourceTagConditions,
            }),
            new iam.PolicyStatement({
              sid: "TagStage1LogDeliveryResources",
              actions: ["logs:TagResource"],
              resources: [
                stage1LogDeliverySourceArn,
                stage1LogDeliveryDestinationArn,
                stage1LogDeliveryArn,
              ],
              conditions: stage1AgentRuntimeRequestTagConditions,
            }),
            new iam.PolicyStatement({
              sid: "UntagOptionalStage1LogDeliveryTags",
              actions: ["logs:UntagResource"],
              resources: [
                stage1LogDeliverySourceArn,
                stage1LogDeliveryDestinationArn,
                stage1LogDeliveryArn,
              ],
              conditions: stage1AgentRuntimeOptionalUntagConditions,
            }),
            new iam.PolicyStatement({
              sid: "DenyMandatoryStage1LogDeliveryTagRemoval",
              effect: iam.Effect.DENY,
              actions: ["logs:UntagResource"],
              resources: [
                stage1LogDeliverySourceArn,
                stage1LogDeliveryDestinationArn,
                stage1LogDeliveryArn,
              ],
              conditions: {
                "ForAnyValue:StringEquals": {
                  "aws:TagKeys": Object.keys(REQUIRED_TAGS).sort(),
                },
              },
            }),
            new iam.PolicyStatement({
              sid: "ManageStage1LogsDeliveryResourcePolicy",
              actions: [
                "logs:DeleteResourcePolicy",
                "logs:DescribeResourcePolicies",
                "logs:PutResourcePolicy",
              ],
              resources: ["*"],
              conditions: {
                StringEquals: {
                  "aws:RequestedRegion": this.region,
                },
              },
            }),
            new iam.PolicyStatement({
              sid: "ManageStage1XRayDeliveryResourcePolicy",
              actions: [
                "xray:DeleteResourcePolicy",
                "xray:ListResourcePolicies",
                "xray:PutResourcePolicy",
              ],
              resources: ["*"],
              conditions: {
                StringEquals: {
                  "aws:RequestedRegion": this.region,
                },
              },
            }),
          ],
        },
      );
    const managedPolicyTagLogs = new logs.LogGroup(
      this,
      "ManagedPolicyTagProviderLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const managedPolicyTagRole = new iam.Role(
      this,
      "ManagedPolicyTagProviderRole",
      {
        roleName:
          "AgenticPlatform-GitHubBootstrap-ManagedPolicyTagProviderRole",
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Reconciles mandatory tags on the bootstrap managed policy",
        inlinePolicies: {
          ManagedPolicyTagProvider: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [managedPolicyTagLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "iam:ListPolicyTags",
                  "iam:TagPolicy",
                  "iam:UntagPolicy",
                ],
                resources: [
                  runtimeRoleManagementPolicyArn,
                  runtimeRoleDelegationPolicyArn,
                  runtimeRoleBoundaryPolicyArn,
                  controlPlaneDeploymentPolicyArn,
                  controlPlaneRegistryDeploymentPolicyArn,
                  controlPlaneGatewayDeploymentPolicyArn,
                  agentRuntimeDeploymentPolicyArn,
                  agentRuntimeObservabilityDeploymentPolicyArn,
                  deploymentValidationPolicyArn,
                  controlPlaneDeploymentValidationPolicyArn,
                ],
              }),
            ],
          }),
        },
      },
    );
    const managedPolicyTagCode = lambda.Code.fromAsset(
      path.join(__dirname, "..", "lambda", "platform-web-provider"),
      { exclude: ["*.test.mjs"] },
    );
    const createManagedPolicyTagResource = (
      id: string,
      policy: iam.ManagedPolicy,
      policyName: string,
    ): void => {
      const tagFunction = new lambda.Function(
        this,
        `${id}Provider`,
        {
          runtime: lambda.Runtime.NODEJS_24_X,
          architecture: lambda.Architecture.ARM_64,
          code: managedPolicyTagCode,
          handler: "index.managedPolicyTagsHandler",
          description:
            "Reconciles mandatory tags on a bootstrap managed policy",
          timeout: cdk.Duration.minutes(1),
          memorySize: 128,
          role: managedPolicyTagRole,
          logGroup: managedPolicyTagLogs,
          environment: {
            MANAGED_POLICY_NAME: policyName,
          },
        },
      );
      const retryConfig = new lambda.EventInvokeConfig(
        this,
        `${id}ProviderRetryConfig`,
        {
          function: tagFunction,
          retryAttempts: 0,
        },
      );
      const tagResource = new cdk.CustomResource(
        this,
        id,
        {
          resourceType: "Custom::ManagedPolicyTags",
          serviceToken: tagFunction.functionArn,
          serviceTimeout: cdk.Duration.minutes(2),
          properties: {
            AccountId: this.account,
            Partition: this.partition,
            PolicyArn: policy.managedPolicyArn,
            RequiredTags: Object.entries(REQUIRED_TAGS)
              .map(([Key, Value]) => ({ Key, Value })),
          },
        },
      );
      tagResource.node.addDependency(retryConfig);
    };
    createManagedPolicyTagResource(
      "Stage1RuntimeRoleManagementPolicyTags",
      runtimeRoleManagementPolicy,
      runtimeRoleManagementPolicyName,
    );
    createManagedPolicyTagResource(
      "Stage1RuntimeRoleDelegationPolicyTags",
      runtimeRoleDelegationPolicy,
      runtimeRoleDelegationPolicyName,
    );
    createManagedPolicyTagResource(
      "Stage1RuntimeRoleBoundaryPolicyTags",
      runtimeRoleBoundaryPolicy,
      runtimeRoleBoundaryPolicyName,
    );
    createManagedPolicyTagResource(
      "ControlPlaneDeploymentPolicyTags",
      controlPlaneDeploymentPolicy,
      controlPlaneDeploymentPolicyName,
    );
    createManagedPolicyTagResource(
      "ControlPlaneRegistryDeploymentPolicyTags",
      controlPlaneRegistryDeploymentPolicy,
      controlPlaneRegistryDeploymentPolicyName,
    );
    createManagedPolicyTagResource(
      "ControlPlaneGatewayDeploymentPolicyTags",
      controlPlaneGatewayDeploymentPolicy,
      controlPlaneGatewayDeploymentPolicyName,
    );
    createManagedPolicyTagResource(
      "AgentRuntimeDeploymentPolicyTags",
      agentRuntimeDeploymentPolicy,
      agentRuntimeDeploymentPolicyName,
    );
    createManagedPolicyTagResource(
      "AgentRuntimeObservabilityDeploymentPolicyTags",
      agentRuntimeObservabilityDeploymentPolicy,
      agentRuntimeObservabilityDeploymentPolicyName,
    );
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageStage1Lambda",
      actions: [
        "lambda:AddPermission",
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:DeleteFunctionConcurrency",
        "lambda:DeleteLayerVersion",
        "lambda:GetFunction",
        "lambda:GetFunctionCodeSigningConfig",
        "lambda:GetFunctionConfiguration",
        "lambda:GetFunctionConcurrency",
        "lambda:GetFunctionRecursionConfig",
        "lambda:GetFunctionScalingConfig",
        "lambda:GetLayerVersion",
        "lambda:GetPolicy",
        "lambda:GetRuntimeManagementConfig",
        "lambda:InvokeFunction",
        "lambda:ListTags",
        "lambda:PublishLayerVersion",
        "lambda:PutFunctionConcurrency",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
      ],
      resources: [webFunctionArn, webLayerArn],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageStage1LambdaAsyncInvoke",
      actions: [
        "lambda:DeleteFunctionEventInvokeConfig",
        "lambda:GetFunctionEventInvokeConfig",
        "lambda:PutFunctionEventInvokeConfig",
      ],
      resources: [webFunctionArn],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageStage1LogGroups",
      actions: [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DeleteRetentionPolicy",
        "logs:ListTagsForResource",
        "logs:PutRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
      ],
      resources: [webLogGroupArn],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadStage1LogMetadata",
      actions: ["logs:DescribeLogGroups"],
      resources: ["*"],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateTaggedStage1Api",
      actions: ["apigateway:POST"],
      resources: [webApiCollectionArn],
      conditions: requiredRequestTagConditions,
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageTaggedStage1Resources",
      actions: [
        "apigateway:DELETE",
        "apigateway:PATCH",
        "apigateway:POST",
        "cloudfront:DeleteDistribution",
        "cloudfront:UpdateDistribution",
        "cognito-idp:CreateGroup",
        "cognito-idp:CreateUserPoolClient",
        "cognito-idp:CreateUserPoolDomain",
        "cognito-idp:DeleteGroup",
        "cognito-idp:DeleteUserPool",
        "cognito-idp:DeleteUserPoolClient",
        "cognito-idp:DeleteUserPoolDomain",
        "cognito-idp:SetUserPoolMfaConfig",
        "cognito-idp:UpdateGroup",
        "cognito-idp:UpdateUserPool",
        "cognito-idp:UpdateUserPoolClient",
      ],
      resources: [
        webApiArn,
        webDistributionArn,
        webUserPoolArn,
      ],
      conditions: requiredResourceTagConditions,
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "TagStage1Resources",
      actions: [
        "cloudfront:TagResource",
        "cognito-idp:TagResource",
      ],
      resources: [webDistributionArn, webUserPoolArn],
      conditions: requiredTagMutationConditions,
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "TagStage1ApiResources",
      actions: ["apigateway:PUT"],
      resources: [webApiTagArn],
      conditions: requiredRequestTagConditions,
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadStage1ServiceResources",
      actions: [
        "apigateway:GET",
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "cloudfront:GetInvalidation",
        "cloudfront:ListTagsForResource",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:GetGroup",
        "cognito-idp:GetUserPoolMfaConfig",
        "cognito-idp:ListGroups",
        "cognito-idp:ListTagsForResource",
      ],
      resources: [
        webApiCollectionArn,
        webApiArn,
        webApiTagArn,
        webDistributionArn,
        webUserPoolArn,
      ],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageStage1CloudFrontSupportingResources",
      actions: [
        "cloudfront:DeleteOriginAccessControl",
        "cloudfront:DeleteResponseHeadersPolicy",
        "cloudfront:GetOriginAccessControl",
        "cloudfront:GetOriginAccessControlConfig",
        "cloudfront:GetResponseHeadersPolicy",
        "cloudfront:GetResponseHeadersPolicyConfig",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:UpdateResponseHeadersPolicy",
      ],
      resources: [
        `arn:${this.partition}:cloudfront::${this.account}:origin-access-control/*`,
        `arn:${this.partition}:cloudfront::${this.account}:response-headers-policy/*`,
      ],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageStage1CloudWatchAlarm",
      actions: [
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:ListTagsForResource",
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource",
      ],
      resources: [webIdentityAlarmArn],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: "TagStage1Dashboard",
      actions: [
        "cloudwatch:ListTagsForResource",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource",
      ],
      resources: [webDashboardArn],
    }));
    const deployRole = new iam.Role(this, "GitHubDeployRole", {
      roleName: "AgenticPlatformGitHubDeployRole",
      assumedBy: new iam.WebIdentityPrincipal(
        providerArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:job_workflow_ref":
              githubMetadata.workflowRef,
            "token.actions.githubusercontent.com:ref": "refs/heads/main",
            "token.actions.githubusercontent.com:repository":
              githubMetadata.repository,
            "token.actions.githubusercontent.com:repository_id":
              githubMetadata.repositoryId,
            "token.actions.githubusercontent.com:repository_owner_id":
              githubMetadata.repositoryOwnerId,
            "token.actions.githubusercontent.com:sub":
              githubMetadata.githubOidcSubject,
          },
        },
      ),
      description:
        `GitHub deployment role restricted to ${props.repository}`,
      maxSessionDuration: cdk.Duration.hours(1),
    });

    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateOrUpdateAgenticPlatformWebStack",
      actions: [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
      ],
      resources: deployedStackResources,
      conditions: requiredRequestTagConditions,
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ExecuteOrDeleteAgenticPlatformWebChangeSet",
      actions: [
        "cloudformation:DeleteChangeSet",
        "cloudformation:ExecuteChangeSet",
      ],
      resources: deployedStackResources,
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadAgenticPlatformWebStack",
      actions: [
        "cloudformation:DescribeChangeSet",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:DescribeStacks",
        "cloudformation:GetTemplate",
        "cloudformation:ListStackResources",
      ],
      resources: deployedStackResources,
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ManageAgenticPlatformWebStack",
      actions: [
        "cloudformation:UpdateTerminationProtection",
      ],
      resources: deployedStackResources,
      conditions: requiredResourceTagConditions,
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "UseCdkBootstrapBucket",
      actions: [
        "s3:DeleteObject",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:PutObject",
      ],
      resources: [assetBucketArn, `${assetBucketArn}/*`],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadCdkBootstrapVersion",
      actions: ["ssm:GetParameter"],
      resources: [
        `arn:${this.partition}:ssm:${this.region}:${this.account}:`
        + `parameter/cdk-bootstrap/`
        + `${cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER}/version`,
      ],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ListGitHubOidcProviders",
      actions: ["iam:ListOpenIDConnectProviders"],
      resources: ["*"],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadGitHubOidcProvider",
      actions: ["iam:GetOpenIDConnectProvider"],
      resources: [
        `arn:${this.partition}:iam::${this.account}:`
        + "oidc-provider/token.actions.githubusercontent.com*",
      ],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadCdkToolkitStack",
      actions: ["cloudformation:DescribeStacks"],
      resources: [
        `arn:${this.partition}:cloudformation:${this.region}:${this.account}:`
        + "stack/CDKToolkit/*",
      ],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadCloudFormationAccountMetadata",
      actions: [
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStacks",
        "cloudformation:ValidateTemplate",
      ],
      resources: ["*"],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "PassCloudFormationExecutionRole",
      actions: ["iam:PassRole"],
      resources: [executionRole.roleArn],
      conditions: {
        StringEquals: {
          "iam:PassedToService": "cloudformation.amazonaws.com",
        },
      },
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: "AssumeHostedAcceptanceRole",
      actions: ["sts:AssumeRole"],
      resources: [hostedAcceptanceRoleArn],
    }));
    const deploymentValidationPolicy = new iam.ManagedPolicy(
      this,
      "DeploymentValidationPolicy",
      {
        managedPolicyName: deploymentValidationPolicyName,
        roles: [deployRole],
        statements: [
          new iam.PolicyStatement({
            sid: "ReadStage1RuntimeRoles",
            actions: ["iam:GetRole", "iam:ListRoleTags"],
            resources: webManagedRoleArns,
          }),
          new iam.PolicyStatement({
            sid: "ReadPlatformRuntimeRolePolicies",
            actions: [
              "iam:GetRolePolicy",
              "iam:ListAttachedRolePolicies",
              "iam:ListRolePolicies",
            ],
            resources: [
              `arn:${this.partition}:iam::${this.account}:role/`
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.accessAdminApi,
              `arn:${this.partition}:iam::${this.account}:role/`
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformStateSeed,
              `arn:${this.partition}:iam::${this.account}:role/`
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformWorkspaceSeed,
              `arn:${this.partition}:iam::${this.account}:role/`
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformAdminApi,
              `arn:${this.partition}:iam::${this.account}:role/`
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.governanceApi,
              `arn:${this.partition}:iam::${this.account}:role/`
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.registryDecisionFinalizer,
              `arn:${this.partition}:iam::${this.account}:role/`
              + PLATFORM_WEB_RUNTIME_ROLE_NAMES.hostedAcceptanceBroker,
              hostedAcceptanceRoleArn,
            ],
          }),
          new iam.PolicyStatement({
            sid: "ReadPlatformStateTableTimeToLive",
            actions: ["dynamodb:DescribeTimeToLive"],
            resources: [platformStateTableArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadControlPlaneRoleTags",
            actions: ["iam:ListRoleTags"],
            resources: [controlPlaneRoleArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadRuntimeBoundaryPolicy",
            actions: [
              "iam:GetPolicy",
              "iam:GetPolicyVersion",
              "iam:ListPolicyTags",
            ],
            resources: [boundaryArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadDeployedDashboardTags",
            actions: ["cloudwatch:ListTagsForResource"],
            resources: [webDashboardArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadControlPlaneRegistryTags",
            actions: ["agent-registry:ListTagsForResource"],
            resources: controlPlaneRegistryArns,
          }),
          new iam.PolicyStatement({
            sid: "ReadControlPlaneGatewayTags",
            actions: ["bedrock-agentcore:ListTagsForResource"],
            resources: [controlPlaneGatewayArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadDeployedResourceTags",
            actions: ["tag:GetResources"],
            resources: ["*"],
          }),
        ],
      },
    );
    const controlPlaneDeploymentValidationPolicy = new iam.ManagedPolicy(
      this,
      "ControlPlaneDeploymentValidationPolicy",
      {
        managedPolicyName: controlPlaneDeploymentValidationPolicyName,
        roles: [deployRole],
        statements: [
          new iam.PolicyStatement({
            sid: "ReadControlPlaneRuntimeBoundaryPolicy",
            actions: [
              "iam:GetPolicy",
              "iam:GetPolicyVersion",
              "iam:ListPolicyTags",
            ],
            resources: [controlPlaneRuntimeBoundaryArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadControlPlaneExecutionRolePolicies",
            actions: [
              "iam:GetRole",
              "iam:GetRolePolicy",
              "iam:ListAttachedRolePolicies",
              "iam:ListRolePolicies",
            ],
            resources: [executionRoleArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadControlPlaneExecutionManagedPolicies",
            actions: [
              "iam:GetPolicy",
              "iam:GetPolicyVersion",
            ],
            resources: [
              runtimeRoleManagementPolicyArn,
              runtimeRoleDelegationPolicyArn,
              runtimeRoleBoundaryPolicyArn,
              controlPlaneDeploymentPolicyArn,
              controlPlaneRegistryDeploymentPolicyArn,
              controlPlaneGatewayDeploymentPolicyArn,
              agentRuntimeDeploymentPolicyArn,
              agentRuntimeObservabilityDeploymentPolicyArn,
            ],
          }),
          new iam.PolicyStatement({
            sid: "ReadProvisionedControlPlaneRoles",
            actions: ["iam:GetRole"],
            resources: [controlPlaneRoleArn],
          }),
          new iam.PolicyStatement({
            sid: "ReadStage1AgentRuntimeTags",
            actions: ["bedrock-agentcore:ListTagsForResource"],
            resources: [
              stage1AgentRuntimeArn,
              stage1AgentRuntimeEndpointArn,
            ],
          }),
          new iam.PolicyStatement({
            sid: "ReadStage1LogDeliveryTags",
            actions: ["logs:ListTagsForResource"],
            resources: [
              stage1LogDeliverySourceArn,
              stage1LogDeliveryDestinationArn,
              stage1LogDeliveryArn,
            ],
          }),
        ],
      },
    );
    createManagedPolicyTagResource(
      "DeploymentValidationPolicyTags",
      deploymentValidationPolicy,
      deploymentValidationPolicyName,
    );
    createManagedPolicyTagResource(
      "ControlPlaneDeploymentValidationPolicyTags",
      controlPlaneDeploymentValidationPolicy,
      controlPlaneDeploymentValidationPolicyName,
    );

    const assetObjectFinding =
      "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::"
      + `${assetBucketName}/*]`;
    const platformStateTableFinding =
      "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:dynamodb:"
      + `${this.region}:${this.account}:table/`
      + "AgenticPlatform-Web-PlatformStateTable*]";
    const platformStateTableFindingReason =
      "DynamoDB permissions are limited to the CloudFormation-generated "
      + "PlatformStateTable name beneath the exact AgenticPlatform-Web "
      + "stack and contain no application data-plane actions.";
    cdk.Validations.of(executionRole).acknowledge(
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "The listed CloudFront and Cognito create calls and read-only service metadata calls lack resource-level IAM support; the role is trusted solely by CloudFormation.",
      },
    );
    cdk.Validations.of(managedPolicyTagRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(managedPolicyTagLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The bootstrap policy-tag provider writes only child log streams beneath its one retained log group; IAM tag operations are scoped to the exact customer-managed policy ARN.",
    });
    executionRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        [assetObjectFinding]:
          "CloudFormation reads only content-addressed Lambda and layer archives beneath this account and region's CDK bootstrap asset bucket.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::"
          + "agenticplatform-web-*]"]:
          "CloudFormation may create and manage only Stage 1 buckets with the fixed agenticplatform-web- name prefix.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::"
          + "agenticplatform-web-*/*]"]:
          "Object permissions are limited to all keys beneath CloudFormation-generated Stage 1 buckets with the fixed agenticplatform-web- prefix.",
        [platformStateTableFinding]: platformStateTableFindingReason,
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:lambda:"
          + `${this.region}:${this.account}:function:AgenticPlatform-Web-*]`]:
          "Lambda permissions are limited to functions whose generated names belong to the protected AgenticPlatform-Web stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:lambda:"
          + `${this.region}:${this.account}:layer:AgenticPlatform-Web-*]`]:
          "Layer permissions are limited to versions whose generated names belong to the protected AgenticPlatform-Web stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:log-group:AgenticPlatform-Web-*]`]:
          "Log permissions are limited to groups whose generated names belong to the protected AgenticPlatform-Web stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:apigateway:"
          + `${this.region}::/apis/*]`]:
          "The API identifier is assigned by API Gateway, so CloudFormation requires child-resource access beneath only this region's HTTP APIs collection.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:apigateway:"
          + `${this.region}::/tags/*]`]:
          "API Gateway tag resources use service-assigned identifiers and remain limited to this region's API tag namespace.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudfront::"
          + `${this.account}:distribution/*]`]:
          "CloudFront assigns distribution IDs, while this boundary still limits access to distributions owned by this account.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudfront::"
          + `${this.account}:origin-access-control/*]`]:
          "CloudFront assigns origin access control IDs, while this boundary still limits access to this account.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudfront::"
          + `${this.account}:response-headers-policy/*]`]:
          "CloudFront assigns response headers policy IDs, while this boundary still limits access to this account.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cognito-idp:"
          + `${this.region}:${this.account}:userpool/*]`]:
          "Cognito assigns user pool IDs, while this boundary limits provisioning to user pools in this account and deployment region.",
      },
    );
    runtimeRoleManagementPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        [platformStateTableFinding]: platformStateTableFindingReason,
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::"
          + `${this.account}:role/${controlPlaneResourcePrefix}]`]:
          "CloudFormation attaches only AWSLambdaBasicExecutionRole to IAM roles whose generated names belong to the provisioned control-plane stack.",
      },
    );
    deploymentValidationPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        [platformStateTableFinding]:
          "The deployment audit inspects TTL only on the "
          + "CloudFormation-generated PlatformStateTable name beneath the "
          + "exact AgenticPlatform-Web stack.",
      },
    );
    cdk.Validations.of(controlPlaneDeploymentPolicy).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "Tagged AgentCore Gateway creation lacks resource-level IAM support; all other control-plane operations remain scoped to this account, region, and fixed stack prefixes.",
    });
    controlPlaneDeploymentPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::"
          + `${this.account}:role/${controlPlaneResourcePrefix}]`]:
          "CloudFormation manages only IAM roles whose generated names belong to the provisioned control-plane stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::"
          + `${this.account}:role/aws-service-role/`
          + "agent-registry.amazonaws.com/*]"]:
          "Agent Registry may create only its own account-local service-linked role, with the exact service-name condition.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:lambda:"
          + `${this.region}:${this.account}:`
          + `function:${controlPlaneResourcePrefix}]`]:
          "Lambda permissions are limited to functions whose generated names belong to the provisioned control-plane stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + `log-group:${controlPlaneResourcePrefix}]`]:
          "Log permissions are limited to groups whose generated names belong to the provisioned control-plane stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:states:"
          + `${this.region}:${this.account}:`
          + `stateMachine:${controlPlaneResourcePrefix}]`]:
          "Step Functions permissions are limited to the CDK custom-resource waiter generated by the provisioned control-plane stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "workload-identity-directory/*]"]:
          "Agent Registry provisions workload identities with service-assigned directory IDs only in this account and region.",
      },
    );
    cdk.Validations.of(controlPlaneRegistryDeploymentPolicy).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "Agent Registry listing and exact-request-tagged Registry creation lack resource-level IAM support.",
    });
    controlPlaneRegistryDeploymentPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:agent-registry:"
          + `${this.region}:${this.account}:registry/*]`]:
          "Registry IDs are service-assigned, while permissions remain limited to the deployment account and region and creation requires exact mandatory request tags.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:agent-registry:"
          + `${this.region}:${this.account}:registry/*/record/*]`]:
          "Registry record IDs are service-assigned, while permissions remain limited to records beneath account-local regional registries.",
      },
    );
    controlPlaneGatewayDeploymentPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:gateway/*]`]:
          "AgentCore assigns Gateway IDs, while this boundary limits lifecycle operations to Gateways in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "gateway/agentic-demo-llm-gateway-*]"]:
          "The suffix is service-assigned; access remains limited to the "
          + "fixed agentic-demo-llm-gateway name family in this account "
          + "and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "gateway/platform-tools-gw-*]"]:
          "The suffix is service-assigned; access remains limited to the "
          + "fixed platform-tools-gw name family in this account and region.",
      },
    );
    cdk.Validations.of(agentRuntimeDeploymentPolicy).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "AgentCore Runtime IDs are assigned during tagged creation; every "
        + "subsequent action is limited to the fixed governed Runtime name "
        + "prefix in this account and region.",
    });
    agentRuntimeDeploymentPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "runtime/AgenticPlatformRuntime-*]"]:
          "CloudFormation manages only the governed Runtime family with the "
          + "fixed AgenticPlatformRuntime name prefix and mandatory tags.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "runtime/AgenticPlatformRuntime-*/runtime-endpoint/*]"]:
          "Endpoint access is limited to endpoints beneath the governed "
          + "AgenticPlatformRuntime family in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "workload-identity-directory/default/workload-identity/"
          + "AgenticPlatformRuntime-*]"]:
          "The Runtime resource provider creates and removes only the "
          + "workload identity whose service-assigned suffix belongs to the "
          + "fixed AgenticPlatformRuntime family.",
      },
    );
    cdk.Validations.of(
      agentRuntimeObservabilityDeploymentPolicy,
    ).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "CloudWatch Logs delivery enumeration and Logs/X-Ray resource-policy "
        + "APIs do not support resource-level authorization; every call is "
        + "restricted to the deployment region and the policy grants no "
        + "unrelated Logs or X-Ray capability.",
    });
    agentRuntimeObservabilityDeploymentPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "delivery-source:AgenticPlatformWebGoverned*]"]:
          "Delivery-source lifecycle access is limited to names generated "
          + "for the governed Runtime in this stack, with mandatory request "
          + "or resource tags and the exact deployment region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "delivery-destination:AgenticPlatformWebGoverned*]"]:
          "Delivery-destination lifecycle access is limited to names "
          + "generated for the governed Runtime in this stack, with mandatory "
          + "request or resource tags and the exact deployment region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:delivery:*]`]:
          "CloudWatch Logs assigns delivery IDs; mutation remains limited to "
          + "account-local regional deliveries carrying every mandatory "
          + "ownership tag.",
      },
    );
    cdk.Validations.of(deploymentValidationPolicy).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "Resource Groups Tagging API inventory is read-only and does not support resource-level IAM scoping.",
    });
    deploymentValidationPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::"
          + `${this.account}:role/${controlPlaneResourcePrefix}]`]:
          "Post-deployment tag validation reads only IAM roles whose generated names belong to the provisioned control-plane stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:agent-registry:"
          + `${this.region}:${this.account}:registry/*]`]:
          "Post-deployment tag validation reads only regional account-local Registry resources with service-assigned IDs.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:agent-registry:"
          + `${this.region}:${this.account}:registry/*/record/*]`]:
          "Post-deployment tag validation reads only records beneath regional account-local Registry resources.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:gateway/*]`]:
          "Post-deployment tag validation reads only AgentCore Gateways in this account and deployment region.",
      },
    );
    controlPlaneDeploymentValidationPolicy.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::"
          + `${this.account}:role/${controlPlaneResourcePrefix}]`]:
          "Boundary validation reads only IAM roles whose generated names belong to the provisioned control-plane stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "runtime/AgenticPlatformRuntime-*]"]:
          "Post-deployment tag validation reads only the governed Runtime family in this account and deployment region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "runtime/AgenticPlatformRuntime-*/runtime-endpoint/*]"]:
          "Post-deployment tag validation reads only endpoints beneath the governed Runtime family in this account and deployment region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "delivery-source:AgenticPlatformWebGoverned*]"]:
          "Post-deployment tag validation reads only governed Runtime delivery sources in this account and deployment region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "delivery-destination:AgenticPlatformWebGoverned*]"]:
          "Post-deployment tag validation reads only governed Runtime delivery destinations in this account and deployment region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:delivery:*]`]:
          "CloudWatch Logs assigns delivery IDs, so post-deployment validation reads account-local deliveries in the deployment region.",
      },
    );
    cdk.Validations.of(deployRole).acknowledge(
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "GitHub OIDC provider listing, CloudFormation account metadata, and Resource Groups Tagging API inventory are read-only operations without resource-level IAM support.",
      },
    );
    deployRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        [assetObjectFinding]:
          "GitHub publishes content-addressed assets only beneath this account and region's CDK bootstrap asset bucket.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:"
          + `${this.region}:${this.account}:stack/AgenticPlatform-Web/*]`]:
          "Deployment is limited to the exact AgenticPlatform-Web stack in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:"
          + `${this.region}:${this.account}:changeSet/AgenticPlatform-Web/*]`]:
          "Deployment is limited to change sets for the exact AgenticPlatform-Web stack in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:"
          + `${this.region}:${this.account}:`
          + "stack/AgenticPlatform-ControlPlane/*]"]:
          "Deployment is limited to the exact reference-existing control-plane stack in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:"
          + `${this.region}:${this.account}:`
          + "changeSet/AgenticPlatform-ControlPlane/*]"]:
          "Deployment is limited to change sets for the exact reference-existing control-plane stack in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:"
          + `${this.region}:${this.account}:`
          + "stack/AgenticPlatform-ControlPlane-Provisioned/*]"]:
          "Deployment is limited to the exact provisioned control-plane stack in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:"
          + `${this.region}:${this.account}:`
          + "changeSet/AgenticPlatform-ControlPlane-Provisioned/*]"]:
          "Deployment is limited to change sets for the exact provisioned control-plane stack in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:"
          + `${this.region}:${this.account}:stack/CDKToolkit/*]`]:
          "The repository audit reads only the shared CDKToolkit stack in this account and deployment region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::"
          + `${this.account}:oidc-provider/`
          + "token.actions.githubusercontent.com*]"]:
          "The repository audit reads only OIDC providers whose provider path starts with the exact GitHub Actions issuer host, including malformed suffixes that must be rejected.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::"
          + `${this.account}:role/${controlPlaneResourcePrefix}]`]:
          "Post-deployment tag validation reads only IAM roles whose generated names belong to the provisioned control-plane stack.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:agent-registry:"
          + `${this.region}:${this.account}:registry/*]`]:
          "Post-deployment tag validation reads only regional account-local Registry resources with service-assigned IDs.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:agent-registry:"
          + `${this.region}:${this.account}:registry/*/record/*]`]:
          "Post-deployment tag validation reads only records beneath regional account-local Registry resources.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:gateway/*]`]:
          "Post-deployment tag validation reads only AgentCore Gateways in this account and deployment region.",
      },
    );

    new cdk.CfnOutput(this, "GitHubDeployRoleArn", {
      value: deployRole.roleArn,
    });
    new cdk.CfnOutput(this, "CloudFormationExecutionRoleArn", {
      value: executionRole.roleArn,
    });
    new cdk.CfnOutput(this, "GitHubOidcProviderArn", {
      value: providerArn,
    });
  }
}
