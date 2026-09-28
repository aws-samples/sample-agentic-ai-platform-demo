import { lambdaReservedConcurrency } from "./lambda-concurrency";
import { addTracePrerequisites } from "./trace-prerequisites";
import { addPolicyInventory } from './policy-inventory';
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { buildSync } from "esbuild";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as customresources from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import bedrockRuntimePrices from "../config/bedrock-runtime-prices.json";
import {
  applyRequiredTags,
  bedrockRuntimeResources,
  bedrockConsumerBoundary,
  CLOUDFRONT_ALARM_NAME_PATTERN,
  cloudFrontAlarmName,
  HOSTED_ACCEPTANCE_ROLE_NAME,
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
  PLATFORM_WEB_STACK_NAME,
  REQUIRED_TAGS,
  RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  runtimePermissionsBoundaryDocument,
} from "./config";

export interface PlatformWebStackProps extends cdk.StackProps {
  cognitoDomainPrefix: string;
  githubOAuthClientId?: string;
  githubOAuthClientSecretArn?: string;
  inceptionModelId?: string;
  llmGatewayId: string;
  llmGatewayRegion: string;
  starterBuilderModelId: string;
  demoItHelpdeskMemoryId?: string;
  demoSupportDeskMemoryId?: string;
  demoReportRunnerKnowledgeBaseId?: string;
  bedrockRuntimeProfileIds?: string[];
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const GATEWAY_MODEL_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const GITHUB_OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9.]{20}$/;
const GATEWAY_ID_PATTERN =
  /^([a-z0-9]+(?:-[a-z0-9]+)*)-([a-z0-9]{10})$/;
const GATEWAY_PREFIX_MAX_LENGTH = 100;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/;
const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const KNOWLEDGE_BASE_ID_PATTERN = /^[A-Z0-9]{10}$/;

function validateStarterBuilderModelId(value: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !MODEL_ID_PATTERN.test(value)
  ) {
    throw new Error("starterBuilderModelId is invalid.");
  }
  return value;
}

function validateInceptionModelId(value: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !GATEWAY_MODEL_ID_PATTERN.test(value)
  ) {
    throw new Error("inceptionModelId is invalid.");
  }
  return value;
}

function validateLlmGatewayId(value: string): string {
  const match = typeof value === "string"
    && value === value.trim()
    ? GATEWAY_ID_PATTERN.exec(value)
    : null;
  if (match === null || match[1].length > GATEWAY_PREFIX_MAX_LENGTH) {
    throw new Error("llmGatewayId is invalid.");
  }
  return value;
}

function validateLlmGatewayRegion(value: string): string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || !AWS_REGION_PATTERN.test(value)
    || value.startsWith("cn-")
    || value.startsWith("us-gov-")
  ) {
    throw new Error(
      "llmGatewayRegion must be a commercial AWS region.",
    );
  }
  return value;
}

function validateOptionalId(
  value: string | undefined,
  name: string,
  pattern: RegExp,
): string | undefined {
  if (value === undefined) return undefined;
  if (value !== value.trim() || !pattern.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function managedDomainGroupDescription(ownerGroup: string): string {
  return [
    "agentic-ai-platform-demo:domain-group-baseline:v1",
    `ownerGroup=${ownerGroup}`,
    "auto-delete=no",
  ].join(";");
}

export class PlatformWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlatformWebStackProps) {
    super(scope, id, {
      ...props,
      stackName: PLATFORM_WEB_STACK_NAME,
      terminationProtection: true,
    });
    const starterBuilderModelId = validateStarterBuilderModelId(
      props.starterBuilderModelId,
    );
    const demoItHelpdeskMemoryId = validateOptionalId(
      props.demoItHelpdeskMemoryId,
      "demoItHelpdeskMemoryId",
      MEMORY_ID_PATTERN,
    );
    const demoSupportDeskMemoryId = validateOptionalId(
      props.demoSupportDeskMemoryId,
      "demoSupportDeskMemoryId",
      MEMORY_ID_PATTERN,
    );
    const demoReportRunnerKnowledgeBaseId = validateOptionalId(
      props.demoReportRunnerKnowledgeBaseId,
      "demoReportRunnerKnowledgeBaseId",
      KNOWLEDGE_BASE_ID_PATTERN,
    );
    // Platform-curated launch-window model catalog (config/baseline-model-
    // catalog.json): every listed model gets a baseline policy at deploy so
    // fresh accounts open with the full approved set, not just the starter.
    const baselineModelCatalog = JSON.parse(readFileSync(
      path.join(__dirname, "..", "config", "baseline-model-catalog.json"),
      "utf8",
    ));
    if (
      baselineModelCatalog?.schemaVersion !== 1
      || !Array.isArray(baselineModelCatalog.models)
      || baselineModelCatalog.models.length < 1
      || baselineModelCatalog.models.length > 32
      || baselineModelCatalog.models.some(
        (entry: { id?: unknown }) =>
          typeof entry?.id !== "string" || !MODEL_ID_PATTERN.test(entry.id),
      )
    ) {
      throw new Error("baseline-model-catalog.json is invalid.");
    }
    const baselineModelIds: string[] = [...new Set(
      baselineModelCatalog.models.map((entry: { id: string }) => entry.id),
    )] as string[];
    const bedrockRuntimeModelArns = bedrockRuntimeResources(props.bedrockRuntimeProfileIds ?? [], {
      partition: this.partition, account: this.account, region: this.region,
    });
    const inceptionModelId = validateInceptionModelId(
      props.inceptionModelId ?? starterBuilderModelId,
    );
    const githubOAuthClientId = props.githubOAuthClientId?.trim();
    const githubOAuthClientSecretArn =
      props.githubOAuthClientSecretArn?.trim();
    if (
      Boolean(githubOAuthClientId)
      !== Boolean(githubOAuthClientSecretArn)
    ) {
      throw new Error(
        "githubOAuthClientId and githubOAuthClientSecretArn "
          + "must be configured together.",
      );
    }
    if (
      githubOAuthClientId
      && !GITHUB_OAUTH_CLIENT_ID_PATTERN.test(githubOAuthClientId)
    ) {
      throw new Error("githubOAuthClientId is invalid.");
    }
    if (githubOAuthClientSecretArn) {
      const secretArn = cdk.Arn.split(
        githubOAuthClientSecretArn,
        cdk.ArnFormat.COLON_RESOURCE_NAME,
      );
      if (
        secretArn.service !== "secretsmanager"
        || secretArn.region !== this.region
        || secretArn.account !== this.account
        || secretArn.resource !== "secret"
        || !secretArn.resourceName
        || /[*?]/.test(secretArn.resourceName)
      ) {
        throw new Error("githubOAuthClientSecretArn is invalid.");
      }
    }
    const inceptionModelArns: string[] = [];
    const llmGatewayId = validateLlmGatewayId(props.llmGatewayId);
    const llmGatewayRegion = validateLlmGatewayRegion(
      props.llmGatewayRegion,
    );
    const llmGatewayArn = this.formatArn({
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      region: llmGatewayRegion,
      resource: "gateway",
      resourceName: llmGatewayId,
      service: "bedrock-agentcore",
    });
    const llmGatewayUrl =
      `https://${llmGatewayId}.gateway.bedrock-agentcore.`
      + `${llmGatewayRegion}.amazonaws.com/inference/v1`;
    applyRequiredTags(this);

    const sharedRegistryId = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-SharedRegistryId",
    );
    const sharedRegistryArn = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-SharedRegistryArn",
    );
    const platformRegistryId = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-Registry-platform-Id",
    );
    const platformRegistryArn = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-Registry-platform-Arn",
    );
    const customerSupportRegistryId = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
    );
    const customerSupportRegistryArn = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
    );
    const operationsRegistryId = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-Registry-operations-Id",
    );
    const operationsRegistryArn = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-Registry-operations-Arn",
    );
    const toolsGatewayId = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-ToolsGatewayId",
    );
    const toolsGatewayArn = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-ToolsGatewayArn",
    );
    const toolsGatewayUrl = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-ToolsGatewayUrl",
    );
    const controlPlaneRegion = cdk.Fn.importValue(
      "AgenticPlatform-ControlPlane-Region",
    );
    const registryArns = [
      sharedRegistryArn,
      platformRegistryArn,
      customerSupportRegistryArn,
      operationsRegistryArn,
    ];
    const registryRecordArns = registryArns.map((registryArn) =>
      cdk.Fn.join("", [registryArn, "/record/*"])
    );
    const accountRegistryArn = this.formatArn({
      service: "agent-registry",
      resource: "registry",
      resourceName: "*",
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const accountRegistryRecordArn = this.formatArn({
      service: "agent-registry",
      resource: "registry",
      resourceName: "*/record/*",
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const registryWorkloadIdentityArn = this.formatArn({
      service: "bedrock-agentcore",
      resource: "workload-identity-directory",
      resourceName: "*",
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const hostedAcceptanceRegistryWorkloadIdentityArns = [
      this.formatArn({
        service: "bedrock-agentcore",
        resource: "workload-identity-directory",
        resourceName: "default",
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }),
      this.formatArn({
        service: "bedrock-agentcore",
        resource: "workload-identity-directory",
        resourceName: "default/workload-identity/registry-*",
        arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
      }),
    ];
    const registryRecordNagFindings = [
      "AgenticPlatform-ControlPlane-SharedRegistryArn",
      "AgenticPlatform-ControlPlane-Registry-platform-Arn",
      "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
      "AgenticPlatform-ControlPlane-Registry-operations-Arn",
    ].map((exportName) =>
      `AwsSolutions-IAM5[Resource::${exportName}/record/*]`
    );
    const registryRecordWildcardReason =
      "GetDiscoverableRegistryRecord, GetRegistryRecord, and "
      + "UpdateRegistryRecordStatus require record child ARNs beneath exactly "
      + "four imported Registry ARNs; "
      + "ListRegistryRecords remains scoped to the bare Registry ARNs.";
    const controlPlaneConfig = JSON.stringify({
      accountId: this.account,
      region: controlPlaneRegion,
      sharedRegistryId,
      domainRegistryIds: {
        platform: platformRegistryId,
        customer_support: customerSupportRegistryId,
        operations: operationsRegistryId,
      },
      llmGatewayId,
      llmGatewayRegion,
      llmGatewayUrl,
      toolsGatewayId,
      toolsGatewayUrl,
    });
    const registryInventoryConfig = JSON.stringify({
      accountId: this.account,
      region: controlPlaneRegion,
      sharedRegistryId,
      domainRegistryIds: {
        platform: platformRegistryId,
        customer_support: customerSupportRegistryId,
        operations: operationsRegistryId,
      },
    });

    const accessLogs = new s3.Bucket(this, "AccessLogs", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ expiration: cdk.Duration.days(365) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const webBucket = new s3.Bucket(this, "WebAssets", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: "s3/",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const platformStateTable = new dynamodb.Table(
      this,
      "PlatformStateTable",
      {
        partitionKey: {
          name: "pk",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: {
          name: "sk",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        timeToLiveAttribute: "expiresAt",
        deletionProtection: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    platformStateTable.addGlobalSecondaryIndex({
      indexName: "EntityTypeIndex",
      partitionKey: {
        name: "entityType",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "sk",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    const platformAdminLogs = new logs.LogGroup(
      this,
      "PlatformAdminApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const registryDecisionFinalizerLogs = new logs.LogGroup(
      this,
      "RegistryDecisionFinalizerLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const registryDecisionFinalizerRole = new iam.Role(
      this,
      "RegistryDecisionFinalizerRole",
      {
        roleName:
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.registryDecisionFinalizer,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Atomically finalizes immutable Registry governance evidence",
        inlinePolicies: {
          RegistryDecisionFinalization: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [registryDecisionFinalizerLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: ["dynamodb:GetItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      "AUDIT#*",
                      "REGISTRY_RECORD#*",
                      "REQUEST#*",
                    ],
                  },
                },
              }),
              new iam.PolicyStatement({
                actions: ["dynamodb:PutItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      "AUDIT#*",
                      "REGISTRY_RECORD#*",
                      "REQUEST#*",
                    ],
                  },
                  "ForAnyValue:StringEquals": {
                    "dynamodb:EnclosingOperation": [
                      "TransactWriteItems",
                    ],
                  },
                },
              }),
            ],
          }),
        },
      },
    );
    const registryDecisionFinalizerFunctionName =
      "AgenticPlatform-Web-RegistryDecisionFinalizer";
    const registryDecisionFinalizerFunctionArn = this.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: registryDecisionFinalizerFunctionName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const registryDecisionFinalizerFunction =
      new nodejs.NodejsFunction(
        this,
        "RegistryDecisionFinalizerFunction",
        {
          functionName:
            registryDecisionFinalizerFunctionName,
          runtime: lambda.Runtime.NODEJS_24_X,
          architecture: lambda.Architecture.ARM_64,
          entry: path.join(
            __dirname,
            "..",
            "lambda",
            "platform-admin",
            "finalizer.mjs",
          ),
          handler: "handler",
          description:
            "Atomically finalizes Registry decision audit evidence",
          timeout: cdk.Duration.seconds(10),
          memorySize: 256,
          reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
          role: registryDecisionFinalizerRole,
          logGroup: registryDecisionFinalizerLogs,
          environment: {
            PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          },
          depsLockFilePath: path.join(
            __dirname,
            "..",
            "package-lock.json",
          ),
          bundling: {
            bundleAwsSDK: true,
          },
        },
      );
    const hostedAcceptanceTags = {
      ...REQUIRED_TAGS,
      managedBy: "hosted-acceptance",
    };
    const requestTagConditions = (tags: Record<string, string>) => ({
      "ForAllValues:StringEquals": {
        "aws:TagKeys": Object.keys(tags).sort(),
      },
      StringEquals: Object.fromEntries(
        [
          ...Object.entries(tags).map(([key, value]) => [
            `aws:RequestTag/${key}`,
            value,
          ]),
          ["aws:RequestedRegion", this.region],
        ],
      ),
    });
    const resourceTagConditions = (
      tags: Record<string, string | string[]>,
    ) => ({
      StringEquals: Object.fromEntries(
        [
          ...Object.entries(tags).map(([key, value]) => [
            `aws:ResourceTag/${key}`,
            value,
          ]),
          ["aws:RequestedRegion", this.region],
        ],
      ),
    });
    const requiredRequestTagConditions =
      requestTagConditions(REQUIRED_TAGS);
    const dynamicRegistryOwnership = {
      ...REQUIRED_TAGS,
      managedBy: [REQUIRED_TAGS.managedBy, "hosted-acceptance"],
    };
    const hostedAcceptanceRequestTagConditions =
      requestTagConditions(hostedAcceptanceTags);
    const platformStateAccessPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [platformAdminLogs.logGroupArn],
        }),
        new iam.PolicyStatement({
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
          ],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": [
                "DOMAIN",
                "REQUEST#*",
              ],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem"],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": ["REQUEST#*"],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem"],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": [
                "DOMAIN",
                "REGISTRY_RECORD#*",
                "REQUEST#*",
              ],
            },
            "ForAnyValue:StringEquals": {
              "dynamodb:EnclosingOperation": [
                "TransactWriteItems",
              ],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [registryDecisionFinalizerFunction.functionArn],
        }),
        new iam.PolicyStatement({
          actions: ["agent-registry:CreateRegistry"],
          resources: ["*"],
          conditions: requiredRequestTagConditions,
        }),
        new iam.PolicyStatement({
          actions: ["agent-registry:TagResource"],
          resources: [accountRegistryArn],
          conditions: requiredRequestTagConditions,
        }),
        new iam.PolicyStatement({
          actions: ["agent-registry:CreateRegistry"],
          resources: ["*"],
          conditions: hostedAcceptanceRequestTagConditions,
        }),
        new iam.PolicyStatement({
          actions: ["agent-registry:TagResource"],
          resources: [accountRegistryArn],
          conditions: hostedAcceptanceRequestTagConditions,
        }),
        new iam.PolicyStatement({
          actions: [
            "bedrock-agentcore:CreateWorkloadIdentity",
            "bedrock-agentcore:DeleteWorkloadIdentity",
          ],
          resources: [registryWorkloadIdentityArn],
          conditions: {
            StringEquals: {
              "aws:RequestedRegion": this.region,
            },
          },
        }),
        new iam.PolicyStatement({
          actions: [
            "agent-registry:ListRegistryRecords",
            "agent-registry:CreateRegistryRecord",
          ],
          resources: registryArns,
        }),
        new iam.PolicyStatement({
          actions: [
            "agent-registry:GetDiscoverableRegistryRecord",
            "agent-registry:GetRegistryRecord",
            // CreateRegistryRecord authorizes against registry/<id>/record/*
            // in addition to the registry itself.
            "agent-registry:CreateRegistryRecord",
            "agent-registry:SubmitRegistryRecordForApproval",
            "agent-registry:UpdateRegistryRecordStatus",
          ],
          resources: registryRecordArns,
        }),
        new iam.PolicyStatement({
          actions: [
            "agent-registry:DeleteRegistry",
            "agent-registry:GetRegistry",
            "agent-registry:ListRegistryRecords",
          ],
          resources: [accountRegistryArn],
          conditions: resourceTagConditions(dynamicRegistryOwnership),
        }),
        new iam.PolicyStatement({
          actions: [
            "agent-registry:GetDiscoverableRegistryRecord",
            "agent-registry:GetRegistryRecord",
            "agent-registry:UpdateRegistryRecordStatus",
          ],
          resources: [accountRegistryRecordArn],
          conditions: resourceTagConditions(dynamicRegistryOwnership),
        }),
      ],
    });
    const platformAdminRole = new iam.Role(this, "PlatformAdminApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformAdminApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Least-privilege execution role for durable platform administration",
      inlinePolicies: {
        PlatformStateAccess: platformStateAccessPolicy,
      },
    });
    const platformStateSeedLogs = new logs.LogGroup(
      this,
      "PlatformStateSeedLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const platformStateSeedRole = new iam.Role(
      this,
      "PlatformStateSeedRole",
      {
        roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformStateSeed,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Seeds retained deployment-owned platform domain metadata",
        inlinePolicies: {
          PlatformStateSeed: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [platformStateSeedLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": ["DOMAIN"],
                  },
                },
              }),
            ],
          }),
        },
      },
    );
    const platformWorkspaceSeedRole = new iam.Role(
      this,
      "PlatformWorkspaceSeedRole",
      {
        roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformWorkspaceSeed,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Seeds retained deployment-owned demo projects and agents",
        inlinePolicies: {
          PlatformWorkspaceSeed: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [platformStateSeedLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": [
                      "PROJECT#platform",
                      "PROJECT#customer_support",
                      "PROJECT#operations",
                      "AGENT#platform#it-helpdesk",
                      "AGENT#customer_support#case-assist",
                      "AGENT#customer_support#concierge",
                      "AGENT#customer_support#supportdesk",
                      "AGENT#operations#incident-triage",
                      "AGENT#operations#report-runner",
                      "HITL_POLICY#platform",
                    ],
                  },
                },
              }),
            ],
          }),
        },
      },
    );
    const platformWorkspaceSeedFunction = new nodejs.NodejsFunction(
      this,
      "PlatformWorkspaceSeedFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "workspace",
          "seed.mjs",
        ),
        handler: "handler",
        description:
          "Seeds retained deployment-owned demo projects and agents",
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        role: platformWorkspaceSeedRole,
        logGroup: platformStateSeedLogs,
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    const platformHitlCatalog = new cdk.CustomResource(this, "PlatformHitlCatalog", {
      resourceType: "Custom::PlatformHitlCatalog",
      serviceToken: platformWorkspaceSeedFunction.functionArn,
      serviceTimeout: cdk.Duration.minutes(3),
      properties: { TableName: platformStateTable.tableName, InitializationVersion: 1 },
    });
    platformHitlCatalog.node.addDependency(platformWorkspaceSeedRole);
    const platformStateSeedFunction = new nodejs.NodejsFunction(
      this,
      "PlatformStateSeedFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "platform-admin",
          "seed.mjs",
        ),
        handler: "handler",
        description: "Seeds retained deployment-owned platform domains",
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        role: platformStateSeedRole,
        logGroup: platformStateSeedLogs,
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    const baselineDomains = [
      {
        id: "platform",
        name: "Platform",
        owner: "Platform team",
        ownerGroup: "domain-platform",
        description:
          "Platform-owned agents and shared platform capabilities.",
        registryId: platformRegistryId,
        registryArn: platformRegistryArn,
        createdBy: "deployment:baseline",
      },
      {
        id: "customer_support",
        name: "Customer Support",
        owner: "Customer Support team",
        ownerGroup: "domain-customer-support",
        description: "Customer-facing support agents.",
        tokenBudget: 24000,
        registryId: customerSupportRegistryId,
        registryArn: customerSupportRegistryArn,
        createdBy: "deployment:baseline",
      },
      {
        id: "operations",
        name: "Operations",
        owner: "Operations team",
        ownerGroup: "domain-operations",
        description:
          "Internal operations and workflow automation agents.",
        registryId: operationsRegistryId,
        registryArn: operationsRegistryArn,
        createdBy: "deployment:baseline",
      },
    ];
    const baselineBusinessDomainIds = baselineDomains
      .map(({ id }) => id)
      .filter((id) => id !== "platform");
    // Hosted Converse stays off unless profiles are opted in. Authorize the
    // starter model for every baseline domain (platform included — the platform
    // team builds its own agents) so the IAM grant and the runtime allowlist
    // are derived from one decision and cannot drift apart.
    const bedrockRuntimeInferenceEnv: Record<string, string> =
      bedrockRuntimeModelArns.length > 0
      ? {
        MODEL_INFERENCE_ROUTE: "bedrock-runtime-converse-v1",
        BEDROCK_RUNTIME_REGION: this.region,
        BEDROCK_RUNTIME_MODELS_JSON: JSON.stringify([{
          modelId: starterBuilderModelId,
          domains: baselineDomains.map(({ id }) => id),
        }]),
      }
      : {};
    const hostedAcceptanceAgentKeys = baselineBusinessDomainIds.map(
      (domainId) => `AGENT#${domainId}#hosted-project-*`,
    );
    const hostedAcceptanceApprovalKeys = baselineBusinessDomainIds.map(
      (domainId) => `APPROVAL#${domainId}`,
    );
    const hostedAcceptanceDeploymentKeys = baselineBusinessDomainIds.map(
      (domainId) => `DEPLOYMENT#${domainId}#hosted-project-*`,
    );
    const hostedAcceptanceProjectKeys = baselineBusinessDomainIds.map(
      (domainId) => `PROJECT#${domainId}`,
    );
    const hostedAcceptanceExperienceFixtureKeys = [
      ...hostedAcceptanceAgentKeys,
      ...hostedAcceptanceDeploymentKeys,
      "ENTITLEMENT#*",
      ...hostedAcceptanceProjectKeys,
    ];
    const hostedAcceptancePersonaCleanupKeys = [
      ...hostedAcceptanceAgentKeys,
      ...hostedAcceptanceApprovalKeys,
      ...hostedAcceptanceDeploymentKeys,
      "ENTITLEMENT#*",
      ...hostedAcceptanceProjectKeys,
    ];
    const platformBaselineDomains = new cdk.CustomResource(
      this,
      "PlatformBaselineDomains",
      {
        resourceType: "Custom::PlatformBaselineDomains",
        serviceToken: platformStateSeedFunction.functionArn,
        serviceTimeout: cdk.Duration.minutes(3),
        properties: {
          TableName: platformStateTable.tableName,
          Domains: baselineDomains,
        },
      },
    );
    platformBaselineDomains.node.addDependency(platformStateTable);
    // Demo projects and their honest DRAFT agents. Memory/KB identifiers point
    // at the real resources surfaced by the workspace Memory & KB API.
    const baselineProjects = [
      {
        constructId: "BaselineProjectItHelpdesk",
        domainId: "platform",
        id: "it-helpdesk",
        name: "IT Helpdesk",
        description:
          "Internal IT helpdesk agent with memory and knowledge base support.",
        agent: {
          id: "it-helpdesk-agent",
          name: "IT Helpdesk Agent",
          description:
            "Answers internal IT questions using the deployed helpdesk memory.",
          memoryIds: demoItHelpdeskMemoryId
            ? [demoItHelpdeskMemoryId] : [],
          knowledgeBaseIds: [],
        },
      },
      {
        constructId: "BaselineProjectCaseAssist",
        domainId: "customer_support",
        id: "case-assist",
        name: "Case Assist",
        description:
          "Agent-assisted customer case resolution.",
        agent: {
          id: "case-resolution-agent",
          name: "Case Resolution Agent",
          description:
            "Triages customer cases and recommends the next resolution step.",
          memoryIds: [],
          knowledgeBaseIds: [],
        },
      },
      {
        constructId: "BaselineProjectConcierge",
        domainId: "customer_support",
        id: "concierge",
        name: "Concierge",
        description:
          "Customer concierge agent with personalised memory and KB lookup.",
        agent: {
          id: "customer-concierge-agent",
          name: "Customer Concierge Agent",
          description:
            "Provides personalised customer assistance.",
          memoryIds: [],
          knowledgeBaseIds: [],
        },
      },
      {
        constructId: "BaselineProjectSupportdesk",
        domainId: "customer_support",
        id: "supportdesk",
        name: "Support Desk",
        description:
          "Customer support desk agent backed by a Bedrock Knowledge Base.",
        agent: {
          id: "support-desk-agent",
          name: "Support Desk Agent",
          description:
            "Handles support requests while retaining conversation context.",
          memoryIds: demoSupportDeskMemoryId
            ? [demoSupportDeskMemoryId] : [],
          knowledgeBaseIds: [],
        },
      },
      {
        constructId: "BaselineProjectIncidentTriage",
        domainId: "operations",
        id: "incident-triage",
        name: "Incident Triage",
        description:
          "First-pass incident classification and routing.",
        agent: {
          id: "incident-triage-agent",
          name: "Incident Triage Agent",
          description:
            "Classifies operational incidents and recommends an owning response queue.",
          memoryIds: [],
          knowledgeBaseIds: [],
        },
      },
      {
        constructId: "BaselineProjectReportRunner",
        domainId: "operations",
        id: "report-runner",
        name: "Report Runner",
        description:
          "Scheduled operational reporting agents.",
        agent: {
          id: "operations-report-agent",
          name: "Operations Report Agent",
          description:
            "Produces recurring operational summaries from approved project data.",
          memoryIds: [],
          knowledgeBaseIds: demoReportRunnerKnowledgeBaseId
            ? [demoReportRunnerKnowledgeBaseId] : [],
        },
      },
    ];
    baselineProjects.forEach(({ constructId, agent, ...project }) => {
      const resource = new cdk.CustomResource(this, constructId, {
        resourceType: "Custom::PlatformBaselineProject",
        serviceToken: platformWorkspaceSeedFunction.functionArn,
        serviceTimeout: cdk.Duration.minutes(3),
        properties: {
          TableName: platformStateTable.tableName,
          Project: {
            ...project,
            ownerSubject: "deployment:baseline",
            memberSubjects: [],
            status: "ACTIVE",
            createdBySubject: "deployment:baseline",
          },
          Agent: {
            domainId: project.domainId,
            projectId: project.id,
            ...agent,
            ownerSubject: "deployment:baseline",
            modelId: starterBuilderModelId,
            toolIds: [],
            mcpServerIds: [],
            skillIds: [],
            blueprintIds: [],
            status: "DRAFT",
            createdBySubject: "deployment:baseline",
          },
        },
      });
      resource.node.addDependency(platformStateTable);
      resource.node.addDependency(platformBaselineDomains);
    });
    const platformAdminFunction = new nodejs.NodejsFunction(
      this,
      "PlatformAdminApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "platform-admin",
          "index.mjs",
        ),
        handler: "handler",
        description:
          "Vends durable platform domains through AWS Agent Registry",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        role: platformAdminRole,
        logGroup: platformAdminLogs,
        environment: {
          REGISTRY_INVENTORY_CONFIG: registryInventoryConfig,
          REGISTRY_DECISION_FINALIZER_FUNCTION_NAME:
            registryDecisionFinalizerFunction.functionName,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          PLATFORM_ACCOUNT_ID: this.account,
          MANDATORY_TAGS_JSON: JSON.stringify(REQUIRED_TAGS),
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "agentic-platform-users",
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      standardAttributes: {
        email: { required: false, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        managed_by: new cognito.StringAttribute({
          mutable: false,
          minLen: 24,
          maxLen: 24,
        }),
      },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const currentDemoOperatorReadActions = [
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListGroupsForUser",
    ];
    platformStateAccessPolicy.addStatements(new iam.PolicyStatement({
      actions: currentDemoOperatorReadActions,
      resources: [userPool.userPoolArn],
    }));
    platformStateAccessPolicy.addStatements(new iam.PolicyStatement({
      actions: [
        "cognito-idp:CreateGroup",
        "cognito-idp:DeleteGroup",
        "cognito-idp:GetGroup",
        "cognito-idp:ListUsersInGroup",
      ],
      resources: [userPool.userPoolArn],
    }));
    platformAdminFunction.addEnvironment(
      "COGNITO_USER_POOL_ID",
      userPool.userPoolId,
    );
    const githubDeployRoleArn = this.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: "AgenticPlatformGitHubDeployRole",
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const hostedAcceptanceResourceTagConditions = {
      StringEquals: Object.fromEntries(
        [
          ...Object.entries(hostedAcceptanceTags).map(([key, value]) => [
            `aws:ResourceTag/${key}`,
            value,
          ]),
          ["aws:RequestedRegion", this.region],
        ],
      ),
    };
    const sharedRegistryRecordArn = cdk.Fn.join("", [
      sharedRegistryArn,
      "/record/*",
    ]);
    let agentRuntime: bedrockagentcore.Runtime;
    let productionRuntimeEndpoint: bedrockagentcore.RuntimeEndpoint;
    const hostedAcceptanceRuntimeId = cdk.Lazy.string({
      produce: () => agentRuntime.agentRuntimeId,
    });
    const hostedAcceptanceRuntimeArn = cdk.Lazy.string({
      produce: () => agentRuntime.agentRuntimeArn,
    });
    const hostedAcceptanceProductionEndpointName = cdk.Lazy.string({
      produce: () => productionRuntimeEndpoint.endpointName,
    });
    const hostedAcceptanceProductionEndpointArn = cdk.Lazy.string({
      produce: () =>
        productionRuntimeEndpoint.agentRuntimeEndpointArn,
    });
    const hostedAcceptanceBrokerLogs = new logs.LogGroup(
      this,
      "HostedAcceptanceBrokerLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const hostedAcceptanceBrokerRole = new iam.Role(
      this,
      "HostedAcceptanceBrokerRole",
      {
        roleName:
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.hostedAcceptanceBroker,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Executes validated exact hosted acceptance resource operations",
        inlinePolicies: {
          HostedAcceptanceBroker: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [hostedAcceptanceBrokerLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "cognito-idp:DeleteGroup",
                  "cognito-idp:GetGroup",
                  "cognito-idp:ListUsersInGroup",
                ],
                resources: [userPool.userPoolArn],
              }),
              new iam.PolicyStatement({
                actions: ["agent-registry:ListRegistryRecords"],
                resources: [sharedRegistryArn],
              }),
              new iam.PolicyStatement({
                sid: "CreateHostedAcceptanceFixtureRecord",
                actions: ["agent-registry:CreateRegistryRecord"],
                resources: [
                  sharedRegistryArn,
                  sharedRegistryRecordArn,
                ],
                conditions: hostedAcceptanceRequestTagConditions,
              }),
              new iam.PolicyStatement({
                sid: "TagHostedAcceptanceFixtureRecord",
                actions: ["agent-registry:TagResource"],
                resources: [
                  sharedRegistryArn,
                  sharedRegistryRecordArn,
                ],
                conditions: hostedAcceptanceRequestTagConditions,
              }),
              new iam.PolicyStatement({
                actions: [
                  "agent-registry:GetRegistryRecord",
                  "agent-registry:ListTagsForResource",
                ],
                resources: [sharedRegistryRecordArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "agent-registry:SubmitRegistryRecordForApproval",
                  "agent-registry:DeleteRegistryRecord",
                ],
                resources: [sharedRegistryRecordArn],
                conditions: hostedAcceptanceResourceTagConditions,
              }),
              new iam.PolicyStatement({
                actions: [
                  "agent-registry:GetRegistry",
                  "agent-registry:ListTagsForResource",
                ],
                resources: [accountRegistryArn],
              }),
              new iam.PolicyStatement({
                actions: ["agent-registry:DeleteRegistry"],
                resources: [accountRegistryArn],
                conditions: hostedAcceptanceResourceTagConditions,
              }),
              new iam.PolicyStatement({
                sid: "DeleteHostedAcceptanceRegistryWorkloadIdentity",
                actions: ["bedrock-agentcore:DeleteWorkloadIdentity"],
                resources: hostedAcceptanceRegistryWorkloadIdentityArns,
                conditions: {
                  StringEquals: {
                    "aws:RequestedRegion": this.region,
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: "ReadHostedAcceptanceState",
                actions: ["dynamodb:GetItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      ...hostedAcceptanceAgentKeys,
                      ...hostedAcceptanceApprovalKeys,
                      "APPROVAL#hosted_acceptance_*",
                      "AUDIT#*",
                      ...hostedAcceptanceDeploymentKeys,
                      "DELIVERY#*",
                      "DOMAIN",
                      "ENTITLEMENT#*",
                      "EXPERIENCE_INVOCATION#*",
                      "HOSTED_ACCEPTANCE",
                      "HOSTED_ROLE_SWITCHING",
                      "JOURNEY#*",
                      "MUTATION#*",
                      ...hostedAcceptanceProjectKeys,
                      "REQUEST#*",
                      "SESSION#*",
                      "SUBMISSION#*",
                    ],
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: "DeleteHostedAcceptanceState",
                actions: ["dynamodb:DeleteItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      ...hostedAcceptanceAgentKeys,
                      "APPROVAL#hosted_acceptance_*",
                      "AUDIT#*",
                      ...hostedAcceptanceDeploymentKeys,
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
              }),
              new iam.PolicyStatement({
                sid: "WriteHostedAcceptanceMappings",
                actions: ["dynamodb:PutItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      "HOSTED_ACCEPTANCE",
                      "HOSTED_ROLE_SWITCHING",
                    ],
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: "QueryHostedAcceptanceEntitlements",
                actions: ["dynamodb:Query"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": ["ENTITLEMENT#*"],
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: "WriteHostedAcceptanceExperienceFixture",
                actions: ["dynamodb:PutItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys":
                      hostedAcceptanceExperienceFixtureKeys,
                  },
                  "ForAnyValue:StringEquals": {
                    "dynamodb:EnclosingOperation": [
                      "TransactWriteItems",
                    ],
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: "DeleteHostedAcceptanceExperienceFixture",
                actions: ["dynamodb:DeleteItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys":
                      hostedAcceptancePersonaCleanupKeys,
                  },
                  "ForAnyValue:StringEquals": {
                    "dynamodb:EnclosingOperation": [
                      "TransactWriteItems",
                    ],
                  },
                },
              }),
              new iam.PolicyStatement({
                sid: "DeleteHostedAcceptanceAgentBuildingJourneys",
                actions: ["dynamodb:DeleteItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      "DELIVERY#*",
                      "JOURNEY#*",
                      "MUTATION#*",
                    ],
                  },
                  "ForAnyValue:StringEquals": {
                    "dynamodb:EnclosingOperation": [
                      "TransactWriteItems",
                    ],
                  },
                },
              }),
              new iam.PolicyStatement({
                actions: ["bedrock-agentcore:GetAgentRuntime"],
                resources: [hostedAcceptanceRuntimeArn],
              }),
              new iam.PolicyStatement({
                actions: ["bedrock-agentcore:GetAgentRuntimeEndpoint"],
                resources: [
                  hostedAcceptanceRuntimeArn,
                  hostedAcceptanceProductionEndpointArn,
                ],
              }),
            ],
          }),
        },
      },
    );
    const hostedAcceptanceBrokerFunction = new nodejs.NodejsFunction(
      this,
      "HostedAcceptanceBrokerFunction",
      {
        functionName: "AgenticPlatform-Web-HostedAcceptanceBroker",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "hosted-acceptance-broker",
          "index.mjs",
        ),
        handler: "handler",
        description:
          "Private broker for exact hosted acceptance resource operations",
        timeout: cdk.Duration.seconds(120),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 2),
        role: hostedAcceptanceBrokerRole,
        logGroup: hostedAcceptanceBrokerLogs,
        environment: {
          AGENT_RUNTIME_ID: hostedAcceptanceRuntimeId,
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          PLATFORM_ACCOUNT_ID: this.account,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          PRODUCTION_ENDPOINT_NAME:
            hostedAcceptanceProductionEndpointName,
          SHARED_REGISTRY_ID: sharedRegistryId,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    const hostedAcceptanceRole = new iam.Role(
      this,
      "HostedAcceptanceRole",
      {
        roleName: HOSTED_ACCEPTANCE_ROLE_NAME,
        assumedBy: new iam.AccountRootPrincipal().withConditions({
          ArnEquals: {
            "aws:PrincipalArn": githubDeployRoleArn,
          },
        }),
        description:
          "Runs hosted acceptance identity and invokes its private broker",
        maxSessionDuration: cdk.Duration.hours(1),
        inlinePolicies: {
          HostedAcceptance: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: [
                  "cognito-idp:AdminAddUserToGroup",
                  "cognito-idp:AdminCreateUser",
                  "cognito-idp:AdminDeleteUser",
                  "cognito-idp:AdminGetUser",
                  "cognito-idp:AdminInitiateAuth",
                  "cognito-idp:AdminListGroupsForUser",
                  "cognito-idp:AdminSetUserPassword",
                ],
                resources: [userPool.userPoolArn],
              }),
              new iam.PolicyStatement({
                actions: ["lambda:InvokeFunction"],
                resources: [hostedAcceptanceBrokerFunction.functionArn],
              }),
            ],
          }),
        },
      },
    );
    hostedAcceptanceBrokerFunction.addPermission(
      "AllowHostedAcceptanceRoleInvoke",
      {
        principal: new iam.ArnPrincipal(hostedAcceptanceRole.roleArn),
        action: "lambda:InvokeFunction",
      },
    );

    const userPoolDomain = userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
    });

    for (const [groupName, precedence] of [
      ["platform-admin", 10],
      ["domain-builder", 20],
      ["end-user", 30],
      ["demo-operator", 40],
    ] as const) {
      new cognito.CfnUserPoolGroup(this, `Group${precedence}`, {
        userPoolId: userPool.userPoolId,
        groupName,
        precedence,
      });
    }
    for (const ownerGroup of [
      "domain-platform",
      "domain-customer-support",
      "domain-operations",
    ] as const) {
      new cognito.CfnUserPoolGroup(
        this,
        `BaselineDomainGroup${ownerGroup.replaceAll("-", "")}`,
        {
          userPoolId: userPool.userPoolId,
          groupName: ownerGroup,
          description: managedDomainGroupDescription(ownerGroup),
        },
      );
    }

    const identityLogs = new logs.LogGroup(this, "IdentityApiLogs", {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const identityRole = new iam.Role(this, "IdentityApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.identityApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Least-privilege execution role for the Stage 1 identity API",
      inlinePolicies: {
        IdentityApiLogging: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [identityLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [platformStateTable.tableArn],
              conditions: {
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
            }),
            new iam.PolicyStatement({
              actions: currentDemoOperatorReadActions,
              resources: [userPool.userPoolArn],
            }),
          ],
        }),
      },
    });

    const apiFunction = new nodejs.NodejsFunction(
      this,
      "IdentityApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "api",
          "index.mjs",
        ),
        handler: "handler",
        description:
          "Stage 1 platform health and Cognito identity projection",
        timeout: cdk.Duration.seconds(5),
        memorySize: 256,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: identityRole,
        logGroup: identityLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
        },
        depsLockFilePath: path.join(
          __dirname,
          "..",
          "package-lock.json",
        ),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const controlPlaneLogs = new logs.LogGroup(
      this,
      "ControlPlaneReadApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const controlPlaneRole = new iam.Role(
      this,
      "ControlPlaneReadApiRole",
      {
        roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.controlPlaneReadApi,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Least-privilege execution role for scoped Registry and Gateway reads",
        inlinePolicies: {
          ControlPlaneReadApi: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [controlPlaneLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: ["agent-registry:ListRegistryRecords"],
                resources: registryArns,
              }),
              new iam.PolicyStatement({
                actions: [
                  "agent-registry:GetDiscoverableRegistryRecord",
                  "agent-registry:GetRegistryRecord",
                ],
                resources: registryRecordArns,
              }),
              new iam.PolicyStatement({
                actions: ["dynamodb:GetItem", "dynamodb:Query"],
                resources: [platformStateTable.tableArn],
                conditions: {
                  "ForAllValues:StringEquals": {
                    "dynamodb:LeadingKeys": ["DOMAIN", "MODEL_POLICY"],
                  },
                },
              }),
              new iam.PolicyStatement({
                actions: ["agent-registry:ListRegistryRecords"],
                resources: [accountRegistryArn],
                conditions: resourceTagConditions(dynamicRegistryOwnership),
              }),
              new iam.PolicyStatement({
                actions: [
                  "agent-registry:GetDiscoverableRegistryRecord",
                  "agent-registry:GetRegistryRecord",
                ],
                resources: [accountRegistryRecordArn],
                conditions: resourceTagConditions(dynamicRegistryOwnership),
              }),
              new iam.PolicyStatement({
                actions: [
                  "bedrock-agentcore:GetGatewayTarget",
                  "bedrock-agentcore:ListGatewayTargets",
                ],
                resources: [toolsGatewayArn],
              }),
              new iam.PolicyStatement({
                actions: currentDemoOperatorReadActions,
                resources: [userPool.userPoolArn],
              }),
            ],
          }),
        },
      },
    );
    const controlPlaneFunction = new nodejs.NodejsFunction(
      this,
      "ControlPlaneReadApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "control-plane",
          "index.mjs",
        ),
        handler: "handler",
        description:
          "Reads scoped AWS Registry and AgentCore Gateway inventory",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: controlPlaneRole,
        logGroup: controlPlaneLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          CONTROL_PLANE_CONFIG: controlPlaneConfig,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const workspaceLogs = new logs.LogGroup(
      this,
      "WorkspaceApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const workspaceRole = new iam.Role(this, "WorkspaceApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.workspaceApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Least-privilege execution role for scoped workspace inventory",
      inlinePolicies: {
        WorkspaceApi: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [workspaceLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "AGENT#*",
                    "APPROVAL#*",
                    "DEPLOYMENT#*",
                    "DOMAIN",
                    "GRANT#*",
                    "MODEL_POLICY",
                    "MUTATION#*",
                    "PROJECT#*",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "AUDIT#*",
                    "MUTATION#*",
                    "PROJECT#*",
                  ],
                },
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": [
                    "TransactWriteItems",
                  ],
                },
              },
            }),
            // Validate legacy project subsets against the same authoritative
            // scoped Registry/Gateway catalog used by the console.
            new iam.PolicyStatement({ actions: ["agent-registry:ListRegistryRecords"], resources: registryArns }),
            new iam.PolicyStatement({ actions: ["agent-registry:GetDiscoverableRegistryRecord", "agent-registry:GetRegistryRecord"], resources: registryRecordArns }),
            new iam.PolicyStatement({ actions: ["agent-registry:ListRegistryRecords"], resources: [accountRegistryArn], conditions: resourceTagConditions(dynamicRegistryOwnership) }),
            new iam.PolicyStatement({ actions: ["agent-registry:GetDiscoverableRegistryRecord", "agent-registry:GetRegistryRecord"], resources: [accountRegistryRecordArn], conditions: resourceTagConditions(dynamicRegistryOwnership) }),
            new iam.PolicyStatement({ actions: ["bedrock-agentcore:GetGatewayTarget", "bedrock-agentcore:ListGatewayTargets"], resources: [toolsGatewayArn] }),
            new iam.PolicyStatement({
              actions: currentDemoOperatorReadActions,
              resources: [userPool.userPoolArn],
            }),
            new iam.PolicyStatement({
              // bedrock-agentcore:ListMemories does not support resource-level
              // permissions; GetMemory requires the memory ARN but we read
              // the four demo project memories only. Both are read-only.
              actions: [
                "bedrock-agentcore:GetMemory",
                "bedrock-agentcore:ListMemories",
              ],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              // bedrock:GetKnowledgeBase requires the KB ARN but we only read
              // the two demo project KBs. Read-only status enrichment.
              actions: ["bedrock:GetKnowledgeBase"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });
    const workspaceFunction = new nodejs.NodejsFunction(
      this,
      "WorkspaceApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "workspace",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Reads authorized project, agent, deployment, and approval workspaces",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: workspaceRole,
        logGroup: workspaceLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          CONTROL_PLANE_CONFIG: controlPlaneConfig,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    const builderLogs = new logs.LogGroup(
      this,
      "BuilderApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const builderRole = new iam.Role(this, "BuilderApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.builderApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Least-privilege execution role for governed agent authoring",
      inlinePolicies: {
        BuilderApi: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [builderLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
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
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": ["DOMAIN"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["MUTATION#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "AGENT#*",
                    "AUDIT#*",
                    "MUTATION#*",
                  ],
                },
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": [
                    "TransactWriteItems",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["agent-registry:ListRegistryRecords"],
              resources: registryArns,
            }),
            new iam.PolicyStatement({
              actions: [
                "agent-registry:GetDiscoverableRegistryRecord",
                "agent-registry:GetRegistryRecord",
              ],
              resources: registryRecordArns,
            }),
            new iam.PolicyStatement({
              actions: ["agent-registry:ListRegistryRecords"],
              resources: [accountRegistryArn],
              conditions: resourceTagConditions(dynamicRegistryOwnership),
            }),
            new iam.PolicyStatement({
              actions: [
                "agent-registry:GetDiscoverableRegistryRecord",
                "agent-registry:GetRegistryRecord",
              ],
              resources: [accountRegistryRecordArn],
              conditions: resourceTagConditions(dynamicRegistryOwnership),
            }),
            new iam.PolicyStatement({
              actions: [
                "bedrock-agentcore:GetGatewayTarget",
                "bedrock-agentcore:ListGatewayTargets",
              ],
              resources: [toolsGatewayArn],
            }),
            new iam.PolicyStatement({
              actions: currentDemoOperatorReadActions,
              resources: [userPool.userPoolArn],
            }),
          ],
        }),
      },
    });
    const gatewaySourceIdentityCondition = (roleName: string) => (
      roleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.builderApi
      || roleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.workspaceApi
      || roleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.journeyApi
      || roleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime
        ? {
            StringLike: {
              "sts:SourceIdentity": "domain_*",
            },
          }
        : {
            StringEquals: {
              "sts:SourceIdentity": "platform",
            },
          }
    );
    const runtimeRoleArn = (roleName: string) => this.formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: roleName,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const gatewayAssumePrincipal = (
      roleName: string,
    ): iam.IAssumeRolePrincipal => {
      const principal = new iam.AccountRootPrincipal();
      return {
        addToAssumeRolePolicy(document: iam.PolicyDocument): void {
          document.addStatements(new iam.PolicyStatement({
            actions: [
              "sts:AssumeRole",
              "sts:SetSourceIdentity",
            ],
            principals: [principal],
            conditions: {
              ArnEquals: {
                "aws:PrincipalArn": runtimeRoleArn(roleName),
              },
              ...gatewaySourceIdentityCondition(roleName),
            },
          }));
        },
        addToPrincipalPolicy(statement: iam.PolicyStatement) {
          return principal.addToPrincipalPolicy(statement);
        },
        assumeRoleAction: "sts:AssumeRole",
        grantPrincipal: principal,
        policyFragment: principal.policyFragment,
        principalAccount: principal.principalAccount,
      };
    };
    const gatewayInvokerRole = new iam.Role(
      this,
      "GatewayInvokerRole",
      {
        roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.gatewayInvoker,
        assumedBy: gatewayAssumePrincipal(
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.builderApi,
        ),
        description:
          "Invokes the platform LLM Gateway with an attributed domain session",
        maxSessionDuration: cdk.Duration.hours(1),
        inlinePolicies: {
          InvokeGovernedGateway: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["bedrock-agentcore:InvokeGateway"],
                resources: [llmGatewayArn],
              }),
            ],
          }),
        },
      },
    );
    builderRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "sts:AssumeRole",
        "sts:SetSourceIdentity",
      ],
      resources: [gatewayInvokerRole.roleArn],
    }));
    controlPlaneRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "sts:AssumeRole",
        "sts:SetSourceIdentity",
      ],
      resources: [gatewayInvokerRole.roleArn],
    }));
    gatewayAssumePrincipal(
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.controlPlaneReadApi,
    ).addToAssumeRolePolicy(
      gatewayInvokerRole.assumeRolePolicy!,
    );
    controlPlaneFunction.addEnvironment(
      "GATEWAY_INVOKER_ROLE_ARN",
      gatewayInvokerRole.roleArn,
    );
    workspaceRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole", "sts:SetSourceIdentity"],
      resources: [gatewayInvokerRole.roleArn],
    }));
    gatewayAssumePrincipal(PLATFORM_WEB_RUNTIME_ROLE_NAMES.workspaceApi)
      .addToAssumeRolePolicy(gatewayInvokerRole.assumeRolePolicy!);
    workspaceFunction.addEnvironment("GATEWAY_INVOKER_ROLE_ARN", gatewayInvokerRole.roleArn);
    const builderFunction = new nodejs.NodejsFunction(
      this,
      "BuilderApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "builder",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Creates, configures, and tests governed agent drafts",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: builderRole,
        logGroup: builderLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          CONTROL_PLANE_CONFIG: controlPlaneConfig,
          GATEWAY_INVOKER_ROLE_ARN: gatewayInvokerRole.roleArn,
          LLM_GATEWAY_REGION: llmGatewayRegion,
          LLM_GATEWAY_URL: llmGatewayUrl,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          ...bedrockRuntimeInferenceEnv,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    const journeyLogs = new logs.LogGroup(
      this,
      "JourneyApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const journeyApplicationPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [journeyLogs.logGroupArn],
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:GetItem"],
          resources: [platformStateTable.tableArn],
          conditions: {
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
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:Query"],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringEquals": {
              "dynamodb:LeadingKeys": ["DOMAIN"],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem"],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": ["MUTATION#*"],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem"],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": ["GITHUB_AUTHORIZATION#*"],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem"],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": ["DELIVERY#*", "JOURNEY#*"],
            },
            "ForAnyValue:StringEquals": {
              "dynamodb:EnclosingOperation": ["TransactWriteItems"],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: ["dynamodb:UpdateItem"],
          resources: [platformStateTable.tableArn],
          conditions: {
            "ForAllValues:StringLike": {
              "dynamodb:LeadingKeys": [
                "DELIVERY#*",
                "GITHUB_AUTHORIZATION#*",
                "MUTATION#*",
              ],
            },
          },
        }),
        new iam.PolicyStatement({
          actions: currentDemoOperatorReadActions,
          resources: [userPool.userPoolArn],
        }),
        new iam.PolicyStatement({
          actions: ["agent-registry:ListRegistryRecords"],
          resources: registryArns,
        }),
        new iam.PolicyStatement({
          actions: [
            "agent-registry:GetDiscoverableRegistryRecord",
            "agent-registry:GetRegistryRecord",
          ],
          resources: registryRecordArns,
        }),
        new iam.PolicyStatement({
          actions: [
            "bedrock-agentcore:GetGatewayTarget",
            "bedrock-agentcore:ListGatewayTargets",
          ],
          resources: [toolsGatewayArn],
        }),
        ...(githubOAuthClientSecretArn
          ? [
              new iam.PolicyStatement({
                actions: ["secretsmanager:GetSecretValue"],
                resources: [githubOAuthClientSecretArn],
              }),
            ]
          : []),
      ],
    });
    const journeyRole = new iam.Role(this, "JourneyApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.journeyApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Least-privilege execution role for hosted agent-building journeys",
      inlinePolicies: {
        JourneyApi: journeyApplicationPolicy,
      },
    });
    journeyRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "sts:AssumeRole",
        "sts:SetSourceIdentity",
      ],
      resources: [gatewayInvokerRole.roleArn],
    }));
    gatewayAssumePrincipal(
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.journeyApi,
    ).addToAssumeRolePolicy(
      gatewayInvokerRole.assumeRolePolicy!,
    );
    let journeyFunction: nodejs.NodejsFunction;
    const runtimeInvocationProofSecret = new secretsmanager.Secret(
      this,
      "RuntimeInvocationProofSecret",
      {
        description:
          "HMAC secret for governed Runtime invocation proof verification",
        generateSecretString: {
          excludePunctuation: true,
          generateStringKey: "hmacKey",
          includeSpace: false,
          passwordLength: 64,
          requireEachIncludedType: true,
          secretStringTemplate: JSON.stringify({
            previousHmacKey: null,
            allowedEndpointArn: null,
            keyId: "runtime-proof-v1",
          }),
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    runtimeInvocationProofSecret.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        "AwsSolutions-SMG4":
          "The retained HMAC proof secret is deployment-generated and must "
          + "remain stable until coordinated runtime proof-key rotation is "
          + "implemented.",
      },
    );
    const runtimeProofConfiguratorLogs = new logs.LogGroup(
      this,
      "RuntimeProofConfiguratorLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const runtimeProofConfiguratorRole = new iam.Role(
      this,
      "RuntimeProofConfiguratorRole",
      {
        roleName:
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeProofConfigurator,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Finalizes the exact governed Runtime proof endpoint binding",
        inlinePolicies: {
          RuntimeProofConfiguration: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [runtimeProofConfiguratorLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "secretsmanager:GetSecretValue",
                  "secretsmanager:PutSecretValue",
                ],
                resources: [runtimeInvocationProofSecret.secretArn],
              }),
            ],
          }),
        },
      },
    );
    const runtimeProofConfiguratorFunctionName =
      "AgenticPlatform-Web-RuntimeProofConfigurator";
    const runtimeProofConfiguratorFunctionArn = this.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: runtimeProofConfiguratorFunctionName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const runtimeProofConfiguratorFunction = new nodejs.NodejsFunction(
      this,
      "RuntimeProofConfiguratorFunction",
      {
        functionName: runtimeProofConfiguratorFunctionName,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "agent-runtime",
          "proof-configurator.mjs",
        ),
        handler: "handler",
        description:
          "Finalizes the governed Runtime proof endpoint binding",
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 1),
        role: runtimeProofConfiguratorRole,
        logGroup: runtimeProofConfiguratorLogs,
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    const runtimeProofProviderLogs = new logs.LogGroup(
      this,
      "RuntimeProofProviderLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const runtimeProofProviderRole = new iam.Role(
      this,
      "RuntimeProofProviderRole",
      {
        roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeProofProvider,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Invokes the Runtime proof endpoint binding configurator",
        inlinePolicies: {
          RuntimeProofProviderLogs: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [runtimeProofProviderLogs.logGroupArn],
              }),
            ],
          }),
        },
      },
    );
    const runtimeProofProvider = new customresources.Provider(
      this,
      "RuntimeProofProvider",
      {
        onEventHandler: runtimeProofConfiguratorFunction,
        frameworkOnEventRole: runtimeProofProviderRole,
        providerFunctionName:
          "AgenticPlatform-Web-RuntimeProofProvider",
        logGroup: runtimeProofProviderLogs,
        frameworkLambdaLoggingLevel:
          lambda.ApplicationLogLevel.FATAL,
      },
    );
    const agentRuntimeLogs = new logs.LogGroup(
      this,
      "AgentRuntimeLogs",
      {
        logGroupName:
          "/aws/bedrock-agentcore/runtimes/agentic-platform-governed",
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const agentRuntimeRole = new iam.Role(this, "AgentRuntimeRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime,
      assumedBy: new iam.ServicePrincipal(
        "bedrock-agentcore.amazonaws.com",
        {
          conditions: {
            StringEquals: {
              "aws:SourceAccount": this.account,
            },
            ArnLike: {
              "aws:SourceArn": this.formatArn({
                service: "bedrock-agentcore",
                resource: "runtime",
                resourceName: "AgenticPlatformRuntime*",
                arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
              }),
            },
          },
        },
      ),
      description:
        "Executes the governed shared AgentCore Runtime",
      maxSessionDuration: cdk.Duration.hours(8),
    });
    agentRuntimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "sts:AssumeRole",
        "sts:SetSourceIdentity",
      ],
      resources: [gatewayInvokerRole.roleArn],
    }));
    if (bedrockRuntimeModelArns.length > 0) {
      for (const role of [agentRuntimeRole, builderRole]) {
        role.addToPolicy(new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: bedrockRuntimeModelArns,
        }));
      }
    }
    agentRuntimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [runtimeInvocationProofSecret.secretArn],
    }));
    agentRuntimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [platformStateTable.tableArn],
      conditions: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["RUNTIME_PROOF#*"],
        },
      },
    }));
    agentRuntimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [platformStateTable.tableArn],
      conditions: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": ["NATIVE_EXECUTION_EVENT#*"],
        },
      },
    }));
    gatewayAssumePrincipal(
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime,
    ).addToAssumeRolePolicy(
      gatewayInvokerRole.assumeRolePolicy!,
    );
    agentRuntime = new bedrockagentcore.Runtime(
      this,
      "GovernedAgentRuntime",
      {
        runtimeName: "AgenticPlatformRuntime",
        description:
          "Shared governed runtime for approved platform agent configurations",
        agentRuntimeArtifact:
          bedrockagentcore.AgentRuntimeArtifact.fromCodeAsset({
            path: path.join(__dirname, "..", "lambda"),
            runtime: bedrockagentcore.AgentCoreRuntime.NODE_22,
            entrypoint: ["server.js"],
            assetHashType: cdk.AssetHashType.OUTPUT,
            bundling: {
              image: cdk.DockerImage.fromRegistry(
                "public.ecr.aws/sam/build-nodejs22.x:latest",
              ),
              command: ["true"],
              outputType: cdk.BundlingOutput.NOT_ARCHIVED,
              local: {
                tryBundle(outputDir: string): boolean {
                  buildSync({
                    entryPoints: [
                      path.join(
                        __dirname,
                        "..",
                        "lambda",
                        "agent-runtime",
                        "server.js",
                      ),
                    ],
                    outfile: path.join(outputDir, "server.js"),
                    bundle: true,
                    platform: "node",
                    target: "node22",
                    format: "esm",
                    banner: {
                      js:
                        'import { createRequire } from "node:module"; '
                        + "const require = createRequire(import.meta.url);",
                    },
                    legalComments: "none",
                    sourcemap: false,
                  });
                  return true;
                },
              },
            },
          }),
        executionRole: agentRuntimeRole,
        networkConfiguration:
          bedrockagentcore.RuntimeNetworkConfiguration
            .usingPublicNetwork(),
        protocolConfiguration: bedrockagentcore.ProtocolType.HTTP,
        environmentVariables: {
          GATEWAY_INVOKER_ROLE_ARN: gatewayInvokerRole.roleArn,
          LLM_GATEWAY_REGION: llmGatewayRegion,
          LLM_GATEWAY_URL: llmGatewayUrl,
          RUNTIME_INVOCATION_PROOF_SECRET_ARN:
            runtimeInvocationProofSecret.secretArn,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
        },
        tracingEnabled: true,
        loggingConfigs: [
          {
            logType: bedrockagentcore.LogType.APPLICATION_LOGS,
            destination:
              bedrockagentcore.LoggingDestination.cloudWatchLogs(
                agentRuntimeLogs,
              ),
          },
          {
            logType: bedrockagentcore.LogType.USAGE_LOGS,
            destination:
              bedrockagentcore.LoggingDestination.cloudWatchLogs(
                agentRuntimeLogs,
              ),
          },
        ],
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: cdk.Duration.minutes(15),
          maxLifetime: cdk.Duration.hours(8),
        },
        tags: REQUIRED_TAGS,
      },
    );
    // A retained destination can still serve another application's deliveries.
    // Scope this destination to the stack incarnation so reinstalls do not
    // collide with it or require deleting another application's trace link.
    const traceDestination = agentRuntime.node.tryFindChild("TracesDeliveryDest");
    if (traceDestination instanceof logs.CfnDeliveryDestination) {
      traceDestination.name = cdk.Fn.join("", [
        "AgenticPlatformWebGoverned",
        cdk.Fn.join("", cdk.Fn.split("-", cdk.Fn.select(2, cdk.Fn.split("/", this.stackId)))),
      ]);
      traceDestination.addDependency(addTracePrerequisites(this));
      for (const resource of this.node.findAll()) {
        if (resource instanceof cdk.CfnResource && resource.cfnResourceType === "AWS::XRay::ResourcePolicy") {
          traceDestination.addDependency(resource);
        }
      }
    }
    const sandboxRuntimeEndpoint = agentRuntime.addEndpoint("Sandbox", {
      description: "Governed sandbox endpoint for domain testing",
    });
    productionRuntimeEndpoint = agentRuntime.addEndpoint(
      "Production",
      {
        description: "Governed production endpoint for approved agents",
      },
    );
    const runtimeProofEndpointBinding = new cdk.CustomResource(
      this,
      "RuntimeProofEndpointBinding",
      {
        resourceType: "Custom::RuntimeProofEndpointBinding",
        serviceToken: runtimeProofProvider.serviceToken,
        properties: {
          SecretArn: runtimeInvocationProofSecret.secretArn,
          AllowedEndpointArn:
            productionRuntimeEndpoint.agentRuntimeEndpointArn,
        },
      },
    );
    runtimeProofEndpointBinding.node.addDependency(
      productionRuntimeEndpoint,
    );
    const platformAgentRegistrySeedLogs = new logs.LogGroup(
      this,
      "PlatformAgentRegistrySeedLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const platformAgentRegistrySeedRole = new iam.Role(
      this,
      "PlatformAgentRegistrySeedRole",
      {
        roleName:
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformAgentRegistrySeed,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Seeds the deployment-owned platform Agent Registry record",
        inlinePolicies: {
          PlatformAgentRegistrySeed: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [platformAgentRegistrySeedLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: ["agent-registry:ListRegistryRecords"],
                resources: [platformRegistryArn],
              }),
              new iam.PolicyStatement({
                actions: ["agent-registry:CreateRegistryRecord"],
                resources: [
                  platformRegistryArn,
                  cdk.Fn.join("", [platformRegistryArn, "/record/*"]),
                ],
                conditions: requiredRequestTagConditions,
              }),
              new iam.PolicyStatement({
                actions: [
                  "agent-registry:GetRegistryRecord",
                  "agent-registry:ListTagsForResource",
                ],
                resources: [
                  cdk.Fn.join("", [platformRegistryArn, "/record/*"]),
                ],
              }),
              new iam.PolicyStatement({
                actions: ["agent-registry:TagResource"],
                resources: [
                  cdk.Fn.join("", [platformRegistryArn, "/record/*"]),
                ],
                conditions: requiredRequestTagConditions,
              }),
              new iam.PolicyStatement({
                actions: [
                  "agent-registry:SubmitRegistryRecordForApproval",
                  "agent-registry:UpdateRegistryRecordStatus",
                ],
                resources: [
                  cdk.Fn.join("", [platformRegistryArn, "/record/*"]),
                ],
                conditions: resourceTagConditions(REQUIRED_TAGS),
              }),
            ],
          }),
        },
      },
    );
    const platformAgentRegistrySeedFunction =
      new nodejs.NodejsFunction(
        this,
        "PlatformAgentRegistrySeedFunction",
        {
          runtime: lambda.Runtime.NODEJS_24_X,
          architecture: lambda.Architecture.ARM_64,
          entry: path.join(
            __dirname,
            "..",
            "lambda",
            "platform-agent-registry",
            "seed.mjs",
          ),
          handler: "handler",
          description:
            "Seeds the platform Agent Design Assistant Registry record",
          timeout: cdk.Duration.minutes(2),
          memorySize: 256,
          role: platformAgentRegistrySeedRole,
          logGroup: platformAgentRegistrySeedLogs,
          depsLockFilePath: path.join(
            __dirname,
            "..",
            "package-lock.json",
          ),
          bundling: {
            bundleAwsSDK: true,
          },
        },
      );
    const platformAgentDesignAssistant = new cdk.CustomResource(
      this,
      "PlatformAgentDesignAssistant",
      {
        resourceType: "Custom::PlatformAgentDesignAssistant",
        serviceToken:
          platformAgentRegistrySeedFunction.functionArn,
        serviceTimeout: cdk.Duration.minutes(3),
        properties: {
          AccountId: this.account,
          GatewayModelId: inceptionModelId,
          PlatformRegistryArn: platformRegistryArn,
          PlatformRegistryId: platformRegistryId,
          ProductionEndpointArn:
            productionRuntimeEndpoint.agentRuntimeEndpointArn,
          ProductionEndpointName:
            productionRuntimeEndpoint.endpointName,
          Region: this.region,
          RuntimeArn: agentRuntime.agentRuntimeArn,
        },
      },
    );
    platformAgentDesignAssistant.node.addDependency(
      platformAgentRegistrySeedFunction,
    );
    platformAgentDesignAssistant.node.addDependency(
      productionRuntimeEndpoint,
    );
    journeyApplicationPolicy.addStatements(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [runtimeInvocationProofSecret.secretArn],
    }));
    journeyApplicationPolicy.addStatements(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeForUser",
      ],
      resources: [
        agentRuntime.agentRuntimeArn,
        productionRuntimeEndpoint.agentRuntimeEndpointArn,
      ],
    }));
    journeyFunction = new nodejs.NodejsFunction(
      this,
      "JourneyApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "journeys",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Runs hosted agent-building journeys and approved delivery",
        timeout: cdk.Duration.seconds(90),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: journeyRole,
        logGroup: journeyLogs,
        environment: {
          AGENT_RUNTIME_ARN: agentRuntime.agentRuntimeArn,
          AGENT_RUNTIME_ENDPOINT_ARN:
            productionRuntimeEndpoint.agentRuntimeEndpointArn,
          AGENT_RUNTIME_ENDPOINT_NAME:
            productionRuntimeEndpoint.endpointName,
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          CONTROL_PLANE_CONFIG: controlPlaneConfig,
          GATEWAY_INVOKER_ROLE_ARN: gatewayInvokerRole.roleArn,
          INCEPTION_MODEL_ID: inceptionModelId,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          RUNTIME_INVOCATION_PROOF_SECRET_ARN:
            runtimeInvocationProofSecret.secretArn,
          ...(githubOAuthClientId && githubOAuthClientSecretArn
            ? {
                GITHUB_OAUTH_CLIENT_ID: githubOAuthClientId,
                GITHUB_OAUTH_CLIENT_SECRET_ARN:
                  githubOAuthClientSecretArn,
              }
            : {}),
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    journeyFunction.node.addDependency(runtimeProofEndpointBinding);

    const deploymentApiLogs = new logs.LogGroup(
      this,
      "DeploymentApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const deploymentApiRole = new iam.Role(this, "DeploymentApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.deploymentApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Runs governed sandbox and production deployment workflows",
      inlinePolicies: {
        DeploymentApi: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [deploymentApiLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: [
                "dynamodb:GetItem",
                "dynamodb:Query",
              ],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
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
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "AGENT#*",
                    "APPROVAL#*",
                    "AUDIT#*",
                    "DEPLOYMENT#*",
                    "MUTATION#*",
                  ],
                },
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": [
                    "TransactWriteItems",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: currentDemoOperatorReadActions,
              resources: [userPool.userPoolArn],
            }),
            new iam.PolicyStatement({
              actions: ["bedrock-agentcore:GetAgentRuntime"],
              resources: [agentRuntime.agentRuntimeArn],
            }),
            new iam.PolicyStatement({
              actions: ["bedrock-agentcore:GetAgentRuntimeEndpoint"],
              resources: [
                agentRuntime.agentRuntimeArn,
                sandboxRuntimeEndpoint.agentRuntimeEndpointArn,
                productionRuntimeEndpoint.agentRuntimeEndpointArn,
              ],
            }),
          ],
        }),
      },
    });
    const deploymentApiFunction = new nodejs.NodejsFunction(
      this,
      "DeploymentApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "deployment",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Executes governed sandbox and production AgentCore deployments",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: deploymentApiRole,
        logGroup: deploymentApiLogs,
        environment: {
          AGENT_RUNTIME_ID: agentRuntime.agentRuntimeId,
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          PRODUCTION_ENDPOINT_NAME:
            productionRuntimeEndpoint.endpointName,
          SANDBOX_ENDPOINT_NAME: sandboxRuntimeEndpoint.endpointName,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const modelGovernanceLogs = new logs.LogGroup(
      this,
      "ModelGovernanceApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const modelGovernanceRole = new iam.Role(
      this,
      "ModelGovernanceApiRole",
      {
        roleName:
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.modelGovernanceApi,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Governs model access and native AgentCore Gateway rate limits",
        inlinePolicies: {
          ModelGovernanceApi: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [modelGovernanceLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: ["dynamodb:GetItem", "dynamodb:Query"],
                resources: [platformStateTable.tableArn],
                conditions: {
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
              }),
              new iam.PolicyStatement({
                actions: ["dynamodb:PutItem"],
                resources: [platformStateTable.tableArn],
                conditions: {
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
                    "dynamodb:EnclosingOperation": [
                      "TransactWriteItems",
                    ],
                  },
                },
              }),
              new iam.PolicyStatement({
                actions: currentDemoOperatorReadActions,
                resources: [userPool.userPoolArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "bedrock-agentcore:GetGatewayTarget",
                  "bedrock-agentcore:ListGatewayTargets",
                ],
                resources: [toolsGatewayArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "bedrock-agentcore:BatchPutGatewayRateLimits",
                  "bedrock-agentcore:ListGatewayRateLimits",
                ],
                resources: [llmGatewayArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "sts:AssumeRole",
                  "sts:SetSourceIdentity",
                ],
                resources: [gatewayInvokerRole.roleArn],
              }),
            ],
          }),
        },
      },
    );
    gatewayAssumePrincipal(
      PLATFORM_WEB_RUNTIME_ROLE_NAMES.modelGovernanceApi,
    ).addToAssumeRolePolicy(
      gatewayInvokerRole.assumeRolePolicy!,
    );
    const modelGovernanceFunction = new nodejs.NodejsFunction(
      this,
      "ModelGovernanceApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "model-governance",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Governs model access and AgentCore Gateway rate limits",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: modelGovernanceRole,
        logGroup: modelGovernanceLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          CONTROL_PLANE_CONFIG: controlPlaneConfig,
          GATEWAY_INVOKER_ROLE_ARN: gatewayInvokerRole.roleArn,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );
    const platformBaselineModelPolicy = new cdk.CustomResource(
      this,
      "PlatformBaselineModelPolicy",
      {
        resourceType: "Custom::PlatformBaselineModelPolicy",
        serviceToken: modelGovernanceFunction.functionArn,
        serviceTimeout: cdk.Duration.minutes(3),
        properties: {
          TableName: platformStateTable.tableName,
          ModelId: starterBuilderModelId,
          ModelIds: baselineModelIds,
          AllowedDomains: baselineDomains.map(({ id }) => id).sort(),
          Limits: {
            requestsPerMinute: 60,
            tokensPerMinute: 120000,
            connectionsPerSecond: 4,
          },
        },
      },
    );
    platformBaselineModelPolicy.node.addDependency(
      platformBaselineDomains,
    );
    platformBaselineModelPolicy.node.addDependency(
      modelGovernanceFunction,
    );

    const governanceLogs = new logs.LogGroup(
      this,
      "GovernanceApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const governanceRole = new iam.Role(this, "GovernanceApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.governanceApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Runs domain-scoped Registry publication and access governance",
      inlinePolicies: {
        GovernanceApi: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["GUARDRAIL_EXCEPTION#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [governanceLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["HITL_POLICY#*"] },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["HITL_POLICY#platform"] },
                "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem"], resources: [platformStateTable.tableArn],
              conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["ALERT_POLICY#platform"] } },
            }),
            // Catalog visibility document: the platform team's post-approval
            // decision on which domains may discover a shared-catalog record.
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": ["CATALOG_VISIBILITY#platform"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"], resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["ALERT_POLICY#platform"] },
                "ForAnyValue:StringEquals": { "dynamodb:EnclosingOperation": ["TransactWriteItems"] },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [platformStateTable.tableArn],
              conditions: {
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
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [
                `${platformStateTable.tableArn}/index/EntityTypeIndex`,
              ],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": ["ENTITLEMENT"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["MUTATION#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
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
                  "dynamodb:EnclosingOperation": [
                    "TransactWriteItems",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: currentDemoOperatorReadActions,
              resources: [userPool.userPoolArn],
            }),
            new iam.PolicyStatement({
              actions: ["agent-registry:ListRegistryRecords"],
              resources: registryArns,
            }),
            new iam.PolicyStatement({
              actions: ["agent-registry:GetRegistryRecord"],
              resources: registryRecordArns,
            }),
            new iam.PolicyStatement({
              actions: [
                "agent-registry:CreateRegistryRecord",
                "agent-registry:TagResource",
              ],
              resources: [accountRegistryArn, accountRegistryRecordArn],
              conditions: requiredRequestTagConditions,
            }),
            new iam.PolicyStatement({
              actions: [
                "agent-registry:SubmitRegistryRecordForApproval",
                "agent-registry:UpdateRegistryRecordStatus",
              ],
              resources: [accountRegistryRecordArn],
              conditions: resourceTagConditions(REQUIRED_TAGS),
            }),
            new iam.PolicyStatement({
              actions: ["agent-registry:ListRegistryRecords"],
              resources: [accountRegistryArn],
              conditions: resourceTagConditions(REQUIRED_TAGS),
            }),
            new iam.PolicyStatement({
              actions: ["agent-registry:GetRegistryRecord"],
              resources: [accountRegistryRecordArn],
              conditions: resourceTagConditions(REQUIRED_TAGS),
            }),
          ],
        }),
      },
    });
    const governanceFunction = new nodejs.NodejsFunction(
      this,
      "GovernanceApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "governance",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Runs domain-scoped Agent Registry publication and access governance",
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: governanceRole,
        logGroup: governanceLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          // Enables review of shared-registry records as the virtual "shared"
          // domain; without these the queue's Initiate review dead-ends in
          // NOT_FOUND for every platform-curated cross-domain resource.
          SHARED_REGISTRY_ID: sharedRegistryId,
          SHARED_REGISTRY_ARN: sharedRegistryArn,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const experienceLogs = new logs.LogGroup(
      this,
      "ExperienceApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const experienceRole = new iam.Role(this, "ExperienceApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Serves entitled approved agents through governed Runtime invocation",
      inlinePolicies: {
        ExperienceApi: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [experienceLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [platformStateTable.tableArn],
              conditions: {
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
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [
                `${platformStateTable.tableArn}/index/EntityTypeIndex`,
              ],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": ["APPROVAL"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:UpdateItem",
              ],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "EXPERIENCE_INVOCATION#*",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["MUTATION#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["SUBMISSION#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "APPROVAL#*",
                    "AUDIT#*",
                    "MUTATION#*",
                    "NATIVE_EXECUTION_BINDING#*",
                    "NATIVE_EXECUTION_EVENT#*",
                    "SESSION#*",
                  ],
                },
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": [
                    "TransactWriteItems",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: currentDemoOperatorReadActions,
              resources: [userPool.userPoolArn],
            }),
            new iam.PolicyStatement({
              actions: ["secretsmanager:GetSecretValue"],
              resources: [runtimeInvocationProofSecret.secretArn],
            }),
            new iam.PolicyStatement({
              actions: [
                "bedrock-agentcore:InvokeAgentRuntime",
                "bedrock-agentcore:InvokeAgentRuntimeForUser",
              ],
              resources: [
                agentRuntime.agentRuntimeArn,
                productionRuntimeEndpoint.agentRuntimeEndpointArn,
              ],
            }),
          ],
        }),
      },
    });
    const experienceFunction = new nodejs.NodejsFunction(
      this,
      "ExperienceApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "experience",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Serves entitled approved agents and governed Runtime invocation",
        timeout: cdk.Duration.seconds(60),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: experienceRole,
        logGroup: experienceLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          EXPERIENCE_JOURNAL_WRITE_VERSION: "cost-v1",
          EXPERIENCE_JOURNAL_READER_VERSION: "cost-v1",
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
          RUNTIME_INVOCATION_PROOF_SECRET_ARN:
            runtimeInvocationProofSecret.secretArn,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const operationsLogs = new logs.LogGroup(
      this,
      "OperationsApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const operationsRole = new iam.Role(this, "OperationsApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Reads authorized operational aggregates and estimated model cost",
      inlinePolicies: {
        OperationsApi: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["PROJECT_BUDGET#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:ConditionCheckItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["PROJECT_BUDGET#*"],
                },
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": ["TransactWriteItems"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["NATIVE_EXECUTION_BINDING#*", "NATIVE_EXECUTION_EVENT#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [operationsLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "BREAK_GLASS",
                    "DOMAIN",
                    "INCIDENT#*",
                    "MUTATION#*",
                    "PROJECT#*",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [
                `${platformStateTable.tableArn}/index/EntityTypeIndex`,
              ],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": ["WORKSPACE_AUDIT", "EXPERIENCE_INVOCATION"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "AUDIT#*",
                    "BREAK_GLASS",
                    "INCIDENT#*",
                    "MUTATION#*",
                  ],
                },
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": [
                    "TransactWriteItems",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: currentDemoOperatorReadActions,
              resources: [userPool.userPoolArn],
            }),
            new iam.PolicyStatement({
              // ce:GetCostAndUsage does not support resource-level scoping.
              actions: ["ce:GetCostAndUsage", "cloudwatch:GetMetricData"],
              resources: ["*"],
            }),
          ],
        }),
      },
    });
    const operationsFunction = new nodejs.NodejsFunction(
      this,
      "OperationsApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "operations",
          "handler-runtime.mjs",
        ),
        handler: "handler",
        description:
          "Reads scoped AgentCore operational metrics and estimated cost",
        timeout: cdk.Duration.seconds(10),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: operationsRole,
        logGroup: operationsLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          OPERATIONS_BUDGETS_JSON: "{}",
          OPERATIONS_CURSOR_SIGNING_KEY: cdk.Fn.join("", [
            this.stackId,
            ":",
            platformStateTable.tableArn,
          ]),
          EXPERIENCE_JOURNAL_WRITE_VERSION: "cost-v1",
          EXPERIENCE_JOURNAL_READER_VERSION: "cost-v1",
          OPERATIONS_MODEL_PRICES_JSON: JSON.stringify(bedrockRuntimePrices),
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const accessAdminLogs = new logs.LogGroup(
      this,
      "AccessAdminApiLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const accessAdminRole = new iam.Role(this, "AccessAdminApiRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.accessAdminApi,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description:
        "Manages governed domain and project membership assignments",
      inlinePolicies: {
        AccessAdminApi: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [accessAdminLogs.logGroupArn],
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "BREAK_GLASS",
                    "DOMAIN",
                    "MUTATION#*",
                    "PROJECT#*",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["MUTATION#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:PutItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": [
                    "AUDIT#*",
                    "MUTATION#*",
                  ],
                },
                "ForAnyValue:StringEquals": {
                  "dynamodb:EnclosingOperation": [
                    "TransactWriteItems",
                  ],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["dynamodb:UpdateItem"],
              resources: [platformStateTable.tableArn],
              conditions: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["PROJECT#*"],
                },
              },
            }),
            new iam.PolicyStatement({
              actions: [
                "cognito-idp:AdminAddUserToGroup",
                "cognito-idp:AdminGetUser",
                "cognito-idp:AdminListGroupsForUser",
                "cognito-idp:AdminRemoveUserFromGroup",
                "cognito-idp:ListUsers",
                "cognito-idp:ListUsersInGroup",
              ],
              resources: [userPool.userPoolArn],
            }),
          ],
        }),
      },
    });
    const accessAdminFunction = new nodejs.NodejsFunction(
      this,
      "AccessAdminApiFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(
          __dirname,
          "..",
          "lambda",
          "access-admin",
          "runtime.mjs",
        ),
        handler: "handler",
        description:
          "Manages governed domain and project memberships",
        timeout: cdk.Duration.seconds(10),
        memorySize: 512,
        reservedConcurrentExecutions: lambdaReservedConcurrency(this, 10),
        tracing: lambda.Tracing.ACTIVE,
        role: accessAdminRole,
        logGroup: accessAdminLogs,
        environment: {
          COGNITO_USER_POOL_ID: userPool.userPoolId,
          PLATFORM_STATE_TABLE_NAME: platformStateTable.tableName,
        },
        depsLockFilePath: path.join(__dirname, "..", "package-lock.json"),
        bundling: {
          bundleAwsSDK: true,
        },
      },
    );

    const api = new apigwv2.CfnApi(this, "HttpApi", {
      name: "agentic-platform-api",
      protocolType: "HTTP",
      disableExecuteApiEndpoint: false,
    });

    const integration = new apigwv2.CfnIntegration(this, "LambdaIntegration", {
      apiId: api.ref,
      integrationType: "AWS_PROXY",
      integrationMethod: "POST",
      integrationUri:
        `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
        + `functions/${apiFunction.functionArn}/invocations`,
      payloadFormatVersion: "2.0",
      timeoutInMillis: 5000,
    });
    const controlPlaneIntegration = new apigwv2.CfnIntegration(
      this,
      "ControlPlaneLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${controlPlaneFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const platformAdminIntegration = new apigwv2.CfnIntegration(
      this,
      "PlatformAdminLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${platformAdminFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const workspaceIntegration = new apigwv2.CfnIntegration(
      this,
      "WorkspaceLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${workspaceFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 9000,
      },
    );
    const builderIntegration = new apigwv2.CfnIntegration(
      this,
      "BuilderLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${builderFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const journeyIntegration = new apigwv2.CfnIntegration(
      this,
      "JourneyLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${journeyFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const modelGovernanceIntegration = new apigwv2.CfnIntegration(
      this,
      "ModelGovernanceLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${modelGovernanceFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const deploymentApiIntegration = new apigwv2.CfnIntegration(
      this,
      "DeploymentLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${deploymentApiFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const governanceIntegration = new apigwv2.CfnIntegration(
      this,
      "GovernanceLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${governanceFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const experienceIntegration = new apigwv2.CfnIntegration(
      this,
      "ExperienceLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${experienceFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 29000,
      },
    );
    const operationsIntegration = new apigwv2.CfnIntegration(
      this,
      "OperationsLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${operationsFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 9000,
      },
    );
    const accessAdminIntegration = new apigwv2.CfnIntegration(
      this,
      "AccessAdminLambdaIntegration",
      {
        apiId: api.ref,
        integrationType: "AWS_PROXY",
        integrationMethod: "POST",
        integrationUri:
          `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/`
          + `functions/${accessAdminFunction.functionArn}/invocations`,
        payloadFormatVersion: "2.0",
        timeoutInMillis: 9000,
      },
    );

    const apiLogs = new logs.LogGroup(this, "HttpApiLogs", {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: api.ref,
      stageName: "$default",
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
      },
      accessLogSettings: {
        destinationArn: this.formatArn({
          service: "logs",
          resource: "log-group",
          resourceName: apiLogs.logGroupName,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
        format: JSON.stringify({
          requestId: "$context.requestId",
          routeKey: "$context.routeKey",
          status: "$context.status",
          responseLength: "$context.responseLength",
          integrationError: "$context.integrationErrorMessage",
        }),
      },
    });

    const healthRoute = new apigwv2.CfnRoute(this, "HealthRoute", {
      apiId: api.ref,
      routeKey: "GET /api/health",
      authorizationType: "NONE",
      target: `integrations/${integration.ref}`,
    });
    healthRoute.addResourceDependency(integration);

    apiFunction.addPermission("AllowHttpApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn:
        `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
        + `${api.ref}/*/GET/api/*`,
    });

    const apiOrigin = new origins.HttpOrigin(
      `${api.ref}.execute-api.${this.region}.${this.urlSuffix}`,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        connectionAttempts: 2,
        connectionTimeout: cdk.Duration.seconds(5),
      },
    );

    const cognitoHostedDomain = userPoolDomain.baseUrl();
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        responseHeadersPolicyName: "agentic-platform-security-headers",
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            override: true,
            contentSecurityPolicy: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              `connect-src 'self' ${cognitoHostedDomain}`,
              "font-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
        },
      },
    );

    const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "Agentic AI Platform console",
      defaultRootObject: "index.html",
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logBucket: accessLogs,
      logFilePrefix: "cloudfront/",
      logIncludesCookies: false,
      defaultBehavior: {
        origin: webOrigin,
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        "runtime-config.js": {
          origin: webOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
          responseHeadersPolicy: securityHeaders,
        },
        "api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
          responseHeadersPolicy: securityHeaders,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });
    const distributionArn = this.formatArn({
      service: "cloudfront",
      region: "",
      resource: "distribution",
      resourceName: distribution.distributionId,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const cloudFrontAlarmNameValue =
      cloudFrontAlarmName(distribution.distributionId);
    const cloudFrontAlarmArn = this.formatArn({
      service: "cloudwatch",
      region: "us-east-1",
      resource: "alarm",
      resourceName: cloudFrontAlarmNameValue,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const cloudFrontAlarmArnPattern = this.formatArn({
      service: "cloudwatch",
      region: "us-east-1",
      resource: "alarm",
      resourceName: CLOUDFRONT_ALARM_NAME_PATTERN,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const cloudFrontAlarmNagResource =
      `arn:<AWS::Partition>:cloudwatch:us-east-1:${this.account}:`
      + `alarm:${CLOUDFRONT_ALARM_NAME_PATTERN}`;
    const runtimePermissionsBoundaryArn = this.formatArn({
      service: "iam",
      region: "",
      resource: "policy",
      resourceName: RUNTIME_PERMISSIONS_BOUNDARY_NAME,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    const runtimeBoundary = new iam.ManagedPolicy(
      this,
      "RuntimePermissionsBoundary",
      {
        managedPolicyName: RUNTIME_PERMISSIONS_BOUNDARY_NAME,
        description:
          "Immutable maximum permissions for AgenticPlatform-Web runtime roles",
        document: iam.PolicyDocument.fromJson(
          runtimePermissionsBoundaryDocument({
            account: this.account,
            agentRuntimeArn: this.formatArn({
              service: "bedrock-agentcore",
              resource: "runtime",
              resourceName: "AgenticPlatformRuntime-*",
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
            agentRuntimeEndpointArnPattern: this.formatArn({
              service: "bedrock-agentcore",
              resource: "runtime",
              resourceName:
                "AgenticPlatformRuntime-*/runtime-endpoint/*",
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
            cloudFrontAlarmArnPattern,
            cloudFrontDistributionArn: distributionArn,
            customerSupportRegistryArn,
            gatewayInvokerRoleArn: runtimeRoleArn(
              PLATFORM_WEB_RUNTIME_ROLE_NAMES.gatewayInvoker,
            ),
            journeyGithubOAuthClientSecretArn:
              githubOAuthClientSecretArn,
            journeyInceptionModelArns: inceptionModelArns,
            llmGatewayArn,
            operationsRegistryArn,
            partition: this.partition,
            platformStateTableArn: platformStateTable.tableArn,
            platformRegistryArn,
            qualifier: cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER,
            registryDecisionFinalizerFunctionArn:
              registryDecisionFinalizerFunctionArn,
            region: this.region,
            runtimeInvocationProofSecretArn:
              runtimeInvocationProofSecret.secretArn,
            runtimeProofConfiguratorFunctionArn:
              runtimeProofConfiguratorFunctionArn,
            runtimeProofConfiguratorRoleArn: runtimeRoleArn(
              PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeProofConfigurator,
            ),
            runtimePermissionsBoundaryArn,
            sharedRegistryArn,
            toolsGatewayArn,
            userPoolArn: userPool.userPoolArn,
          }),
        ),
      },
    );
    runtimeBoundary.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    iam.PermissionsBoundary.of(this).apply(runtimeBoundary);
    iam.PermissionsBoundary.of(hostedAcceptanceRole).clear();
    runtimeBoundary.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "log-group:AgenticPlatform-Web-*:*]"]:
          "The boundary permits only log-stream writes under log groups generated by the protected PlatformWebStack role namespace.",
        [`AwsSolutions-IAM5[Resource::${cloudFrontAlarmNagResource}]`]:
          "The boundary admits only deployment-specific CloudFront 5xx alarms under the fixed PlatformWeb stack prefix so replacement cleanup can reach both old and new names; provider ownership and physical-ID checks remain exact.",
        ["AwsSolutions-IAM5[Resource::*]"]:
          "X-Ray telemetry and Agent Registry CreateRegistry do not support resource-level permissions; the boundary also admits Bedrock InvokeModel only as an action ceiling while the Journey role grants the exact configured inference-profile and foundation-model ARNs. CreateRegistry is constrained by all three exact mandatory request tags and exact TagKeys.",
        ["AwsSolutions-IAM5[Action::s3:GetObject*]"]:
          "The CDK BucketDeployment provider synthesizes this read family for versioned and tagged objects; resources remain limited to the regional asset bucket and Stage 1 web buckets.",
        ["AwsSolutions-IAM5[Action::s3:GetBucket*]"]:
          "The deployment provider reads bucket metadata only for the regional CDK asset bucket and Stage 1 web buckets.",
        ["AwsSolutions-IAM5[Action::s3:List*]"]:
          "The deployment provider lists only the regional CDK asset bucket and Stage 1 web buckets for sync and prune.",
        ["AwsSolutions-IAM5[Action::s3:DeleteObject*]"]:
          "Prune may delete stale object versions only beneath Stage 1 web buckets.",
        ["AwsSolutions-IAM5[Action::s3:Abort*]"]:
          "The deployment provider may abort incomplete multipart uploads only beneath Stage 1 web buckets.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-"
          + `${cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER}-assets-`
          + `${this.account}-${this.region}*]`]:
          "The boundary compacts the exact CDK asset bucket ARN and its "
          + "object child ARN into one fixed account-and-region prefix. "
          + "Deployment role policies still grant the exact bucket and "
          + "object resources, so the boundary alone cannot authorize a "
          + "different bucket.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::"
          + "agenticplatform-web-*]"]:
          "The boundary applies S3 deployment permissions only to buckets in the protected Stage 1 naming namespace.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::"
          + "agenticplatform-web-*/*]"]:
          "The boundary applies object deployment permissions only beneath buckets in the protected Stage 1 naming namespace.",
        [`AwsSolutions-IAM5[Resource::<${this.getLogicalId(
          platformStateTable.node.defaultChild as dynamodb.CfnTable,
        )}.Arn>*]`]:
          "The managed boundary compacts the exact platform-state table ARN "
          + "and its single EntityTypeIndex child ARN into one resource "
          + "pattern to stay within IAM's policy-size limit. Runtime role "
          + "policies still grant exact table or index actions and leading "
          + "keys, so the boundary alone cannot authorize broader access.",
        ...Object.fromEntries(
          registryRecordNagFindings.map((finding) => [
            finding,
            registryRecordWildcardReason,
          ]),
        ),
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:registry/*]`]:
          "The boundary admits account-registry ARNs only for PlatformAdmin "
          + "creation-time TagResource, broker exact-ID reads, and "
          + "tag-constrained dynamic listing. DeleteRegistry is limited to "
          + "the two validated ownership variants and exact mandatory tags.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:`
          + "registry/*/record/*]"]:
          "Dynamic Registry record discovery, reads, and PlatformAdmin status "
          + "updates require exact mandatory ownership tags and deployment "
          + "region; no record create or delete action is admitted.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "workload-identity-directory/*]"]:
          "AgentCore authorizes Registry-managed workload identity creation "
          + "and deletion at the workload identity directory resource; the "
          + "statement grants no other action and is region constrained.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "log-group:/aws/bedrock-agentcore/runtimes/*]"]:
          "The boundary admits only AgentCore-managed runtime log groups in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:log-group:*]`]:
          "DescribeLogGroups does not support narrowing to one log group; the execution role grants only that read action.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "workload-identity-directory/default/workload-identity/*]"]:
          "AgentCore Runtime obtains short-lived workload tokens only from the default workload identity directory in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:lambda:"
          + `${this.region}:${this.account}:`
          + "function:AgenticPlatform-Web-R*]"]:
          "The boundary compacts the two retained runtime helper function "
          + "ARNs into the fixed AgenticPlatform-Web-R namespace. Runtime "
          + "role policies still grant only the exact finalizer and proof "
          + "configurator function ARNs.",
        ["AwsSolutions-IAM5[Action::bedrock-agentcore:"
          + "GetWorkloadAccessToken*]"]:
          "The boundary compacts the three read-only workload token variants; the AgentCore execution role still grants the exact required actions.",
        ["AwsSolutions-IAM5[Action::bedrock-agentcore:GetAgentRuntime*]"]:
          "The boundary compacts read-only Runtime and RuntimeEndpoint lookups; the deployment API role grants each exact action and resource.",
        ["AwsSolutions-IAM5[Action::bedrock-agentcore:"
          + "InvokeAgentRuntime*]"]:
          "The boundary compacts the two governed Runtime invocation variants "
          + "to stay within IAM's managed-policy size limit. The experience "
          + "and Gateway invoker roles still grant only their exact required "
          + "actions on exact Runtime resources.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "runtime/AgenticPlatformRuntime-*]"]:
          "Runtime reads remain within the fixed governed Runtime naming prefix in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "runtime/AgenticPlatformRuntime-*/runtime-endpoint/*]"]:
          "The boundary admits read-only endpoint lookup in this account and region; the deployment role grants only the two synthesized endpoint ARNs.",
        ["AwsSolutions-IAM5[Action::bedrock-agentcore:*Mem*]"]:
          "The boundary compacts GetMemory and ListMemories into a single "
          + "prefix wildcard to stay within IAM's managed-policy size limit. "
          + "The workspace API role still grants only those two read-only "
          + "memory actions.",
        ["AwsSolutions-IAM5[Action::bedrock:GetKnow*]"]:
          "The boundary compacts GetKnowledgeBase into a prefix wildcard to "
          + "stay within IAM's managed-policy size limit. The workspace API "
          + "role still grants only the exact GetKnowledgeBase action.",
        ["AwsSolutions-IAM5[Action::bedrock-agentcore:*GatewayRateLimits]"]:
          "The boundary compacts BatchPutGatewayRateLimits and "
          + "ListGatewayRateLimits into a suffix wildcard to stay within "
          + "IAM's managed-policy size limit. The control-plane roles still "
          + "grant only those two specific gateway rate-limit actions.",
      },
    );

    if (bedrockRuntimeModelArns.length > 0) {
      const modelBoundary = new iam.ManagedPolicy(this, "BedrockConsumerPermissionsBoundary", {
        managedPolicyName: "AgenticPlatform-Web-BedrockConsumerBoundary",
        description: "Existing Runtime/Builder ceiling restricted to consumer actions plus exact Converse models",
        document: iam.PolicyDocument.fromJson(bedrockConsumerBoundary(
          runtimeBoundary.document.toJSON(), bedrockRuntimeModelArns,
        )),
      });
      modelBoundary.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      // This is a restriction of the existing ceiling. Reuse its reviewed
      // wildcard explanations; the new InvokeModel statement is exact.
      const inheritedAcknowledgements = runtimeBoundary.node.metadata.find(entry =>
        entry.type === cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY)?.data;
      modelBoundary.node.addMetadata(cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
        ...inheritedAcknowledgements,
        ["AwsSolutions-IAM5[Resource::*]"]:
          "Inherited telemetry actions require Resource *. Bedrock InvokeModel is a separate statement containing only exact selected profile and foundation-model ARNs.",
      });
      for (const role of [agentRuntimeRole, builderRole]) {
        iam.PermissionsBoundary.of(role).apply(modelBoundary);
      }
    }

    // Operations needs transactional budget checks without widening the shared
    // runtime boundary (which is already near the managed-policy size limit).
    const operationsActions = new Set([
      "logs:CreateLogStream", "logs:PutLogEvents", "cloudwatch:GetMetricData",
      "ce:GetCostAndUsage",
      "xray:PutTraceSegments", "xray:PutTelemetryRecords",
      "dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem",
      ...currentDemoOperatorReadActions,
    ]);
    const operationsCeiling = runtimeBoundary.document.toJSON();
    const operationsBoundary = new iam.ManagedPolicy(this, "OperationsPermissionsBoundary", {
      managedPolicyName: "AgenticPlatform-Web-OperationsBoundary",
      description: "Operations-only ceiling with partition-scoped project budget transactions",
      document: iam.PolicyDocument.fromJson({
        Version: operationsCeiling.Version,
        Statement: [
          ...operationsCeiling.Statement.map((statement: any) => ({
            ...statement,
            Action: (Array.isArray(statement.Action) ? statement.Action : [statement.Action])
              .filter((action: string) => operationsActions.has(action)),
          })).filter((statement: any) => statement.Action.length > 0),
          {
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:ConditionCheckItem"],
            Resource: platformStateTable.tableArn,
            Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["PROJECT_BUDGET#*"] } },
          },
        ],
      }),
    });
    operationsBoundary.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    operationsBoundary.node.addMetadata(cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      runtimeBoundary.node.metadata.find(entry =>
        entry.type === cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY)?.data ?? {});
    iam.PermissionsBoundary.of(operationsRole).apply(operationsBoundary);

    const applicationUrl = `https://${distribution.distributionDomainName}`;
    const applicationRootUrl = `${applicationUrl}/`;
    journeyFunction.addEnvironment(
      "APPLICATION_ROOT_URL",
      applicationRootUrl,
    );
    if (githubOAuthClientId && githubOAuthClientSecretArn) {
      journeyFunction.addEnvironment(
        "GITHUB_OAUTH_CALLBACK_URL",
        `${api.attrApiEndpoint}/oauth/github/callback`,
      );
    }
    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: "agentic-platform-web",
      generateSecret: false,
      authFlows: {
        adminUserPassword: true,
        userSrp: true,
        // The local console's cognitoLogin() uses USER_PASSWORD_AUTH to mint
        // the bearer token forwarded to CUSTOM_JWT runtimes (end-user chat).
        userPassword: true,
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [applicationRootUrl],
        logoutUrls: [applicationRootUrl],
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });

    const authorizer = new apigwv2.CfnAuthorizer(this, "JwtAuthorizer", {
      apiId: api.ref,
      name: "cognito",
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      jwtConfiguration: {
        issuer:
          `https://cognito-idp.${this.region}.${this.urlSuffix}/`
          + userPool.userPoolId,
        audience: [userPoolClient.userPoolClientId],
      },
    });

    const policyInventory = addPolicyInventory(this, {
      userPoolArn: userPool.userPoolArn, userPoolId: userPool.userPoolId,
      gateways: [{arn: toolsGatewayArn, label: 'Shared tools Gateway'}, {arn: llmGatewayArn, label: 'Shared LLM Gateway'}],
      api, authorizer,
    });
    iam.PermissionsBoundary.of(policyInventory.role).apply(policyInventory.boundary);

    const meRoute = new apigwv2.CfnRoute(this, "MeRoute", {
      apiId: api.ref,
      routeKey: "GET /api/me",
      authorizationType: "JWT",
      authorizerId: authorizer.ref,
      target: `integrations/${integration.ref}`,
    });
    meRoute.addResourceDependency(authorizer);
    meRoute.addResourceDependency(integration);

    for (const [constructId, routeKey] of [
      ["RegistryRoute", "GET /api/registry"],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${controlPlaneIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(controlPlaneIntegration);
    }
    for (const [constructId, routeKey] of [
      ["AiGatewayRoute", "GET /api/ai-gateway"],
      [
        "ModelPolicyRoute",
        "POST /api/ai-gateway/model-policies",
      ],
      [
        "ModelAccessRequestRoute",
        "POST /api/ai-gateway/model-access-requests",
      ],
      [
        "ModelAccessDecisionRoute",
        "POST /api/ai-gateway/model-access-decisions",
      ],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${modelGovernanceIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(modelGovernanceIntegration);
    }
    for (const [constructId, routeKey] of [
      ["DomainsRoute", "GET /api/domains"],
      ["DomainCreateRoute", "POST /api/domain-create"],
      ["RegistryDecideRoute", "POST /api/registry-decide"],
      ["RegistryCreateRoute", "POST /api/registry-create"],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${platformAdminIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(platformAdminIntegration);
    }
    for (const [constructId, routeKey] of [
      ["ProjectsRoute", "GET /api/projects"],
      ["ProjectCreateRoute", "POST /api/projects"],
      ["AgentsRoute", "GET /api/agents"],
      ["DeploymentsRoute", "GET /api/deployments"],
      ["ApprovalsRoute", "GET /api/approvals"],
      ["ProjectMemoriesRoute", "GET /api/project-memories"],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${workspaceIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(workspaceIntegration);
    }
    for (const [constructId, routeKey] of [
      ["AgentCreateRoute", "POST /api/agents"],
      ["AgentConfigureRoute", "PUT /api/agents/{id}"],
      ["AgentTestRoute", "POST /api/agents/{id}/test"],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${builderIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(builderIntegration);
    }
    for (const [constructId, routeKey] of [
      ["JourneyCreateRoute", "POST /api/journeys"],
      ["JourneyGetRoute", "GET /api/journeys/{id}"],
      [
        "JourneyMessageRoute",
        "POST /api/journeys/{id}/messages",
      ],
      [
        "JourneyContractRoute",
        "POST /api/journeys/{id}/contract",
      ],
      ["DeliveryPreviewRoute", "POST /api/delivery/previews"],
      ["DeliveryGetRoute", "GET /api/delivery/{id}"],
      ["DeliveryGitHubRoute", "GET /api/delivery/github"],
      [
        "DeliveryGitHubAuthorizationRoute",
        "POST /api/delivery/github/authorizations",
      ],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${journeyIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(journeyIntegration);
    }
    const deliveryGitHubCallbackRoute = new apigwv2.CfnRoute(
      this,
      "DeliveryGitHubCallbackRoute",
      {
        apiId: api.ref,
        routeKey: "GET /oauth/github/callback",
        authorizationType: "NONE",
        target: `integrations/${journeyIntegration.ref}`,
      },
    );
    deliveryGitHubCallbackRoute.addResourceDependency(journeyIntegration);
    for (const [constructId, routeKey] of [
      [
        "SandboxDeploymentRoute",
        "POST /api/deployments/sandbox",
      ],
      [
        "ProductionDeploymentRoute",
        "POST /api/deployments/production",
      ],
      [
        "ProductionDeploymentDecisionRoute",
        "POST /api/deployment-decisions",
      ],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${deploymentApiIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(deploymentApiIntegration);
    }
    for (const [constructId, routeKey] of [
      [
        "GovernanceAgentPublicationRoute",
        "POST /api/governance/agent-publications",
      ],
      ["GovernanceGuardrailReadRoute", "GET /api/governance/guardrails"],
      ["GovernanceExceptionListRoute", "GET /api/policy-exemptions"],
      ["GovernanceExceptionRequestRoute", "POST /api/policy-exemption-request"],
      ["GovernanceExceptionDecisionRoute", "POST /api/policy-exemption-decide"],
      ["GovernanceAlertReadRoute", "GET /api/alerts"],
      ["GovernanceAlertDraftRoute", "POST /api/governance/alert-drafts"],
      ["GovernancePolicyDraftRoute", "POST /api/governance/policy-drafts"],
      ["GovernancePublicationContextRoute", "GET /api/governance/publication-context"],
      ["GovernanceResourceRoute", "POST /api/governance/resources"],
      ["GovernancePublicationRoute", "POST /api/governance/publications"],
      ["GovernancePublicationInitiationRoute", "POST /api/governance/publication-initiations"],
      [
        "GovernancePublicationDecisionRoute",
        "POST /api/governance/publication-decisions",
      ],
      [
        "GovernanceHitlPolicyReadRoute",
        "GET /api/hitl",
      ],
      [
        "GovernanceSharedResourcesRoute",
        "GET /api/governance/shared-resources",
      ],
      [
        "GovernanceCatalogVisibilitySetRoute",
        "POST /api/governance/catalog-visibility",
      ],
      [
        "GovernanceCatalogVisibilityReadRoute",
        "GET /api/governance/catalog-visibility",
      ],
      [
        "GovernanceAgentEntitlementListRoute",
        "GET /api/governance/agent-entitlements",
      ],
      [
        "GovernanceAccessRequestRoute",
        "POST /api/governance/access-requests",
      ],
      [
        "GovernanceAccessDecisionRoute",
        "POST /api/governance/access-decisions",
      ],
      [
        "GovernanceAccessRevocationRoute",
        "POST /api/governance/access-revocations",
      ],
      [
        "GovernanceAgentEntitlementRoute",
        "POST /api/governance/agent-entitlements",
      ],
      [
        "GovernanceAgentEntitlementRevocationRoute",
        "POST /api/governance/agent-entitlement-revocations",
      ],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${governanceIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(governanceIntegration);
    }
    for (const [constructId, routeKey] of [
      ["ExperienceAgentsRoute", "GET /api/experience/agents"],
      [
        "ExperienceInvocationsRoute",
        "POST /api/experience/invocations",
      ],
      ["ExperienceSessionsRoute", "GET /api/experience/sessions"],
      [
        "ExperienceAccessRequestListRoute",
        "GET /api/experience/access-requests",
      ],
      ["ExperienceFeedbackRoute", "POST /api/experience/feedback"],
      ["ExperienceIssuesRoute", "POST /api/experience/issues"],
      [
        "ExperienceAccessRequestsRoute",
        "POST /api/experience/access-requests",
      ],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${experienceIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(experienceIntegration);
    }
    for (const [constructId, routeKey] of [
      [
        "AccessDomainMembersRoute",
        "GET /api/access/domain-members",
      ],
      [
        "AccessDomainMembershipRoute",
        "POST /api/access/domain-memberships",
      ],
      [
        "AccessDomainMembershipRevocationRoute",
        "POST /api/access/domain-membership-revocations",
      ],
      [
        "AccessProjectMembersRoute",
        "GET /api/access/project-members",
      ],
      [
        "AccessProjectMembershipRoute",
        "POST /api/access/project-memberships",
      ],
      [
        "AccessProjectMembershipRevocationRoute",
        "POST /api/access/project-membership-revocations",
      ],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${accessAdminIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(accessAdminIntegration);
    }
    for (const [constructId, routeKey] of [
      ["OperationsRoute", "GET /api/operations"],
      ["CostsRoute", "GET /api/costs"],
      ["PlatformCostsRoute", "GET /api/platform-costs"],
      ["ProjectBudgetReadRoute", "GET /api/operations/project-budgets"],
      ["ProjectBudgetWriteRoute", "POST /api/operations/project-budgets"],
      ["ProjectBudgetEvaluateRoute", "POST /api/operations/project-budgets/evaluate"],
      ["OperationsAuditRoute", "GET /api/operations/audit"],
      ["IncidentsRoute", "GET /api/incidents"],
      ["IncidentCreateRoute", "POST /api/incidents"],
      [
        "IncidentActionRoute",
        "POST /api/incidents/{id}/actions",
      ],
      ["BreakGlassRoute", "GET /api/break-glass"],
      [
        "BreakGlassRequestRoute",
        "POST /api/break-glass/requests",
      ],
      [
        "BreakGlassDecisionRoute",
        "POST /api/break-glass/decisions",
      ],
      [
        "BreakGlassActivationRoute",
        "POST /api/break-glass/activations",
      ],
      [
        "BreakGlassRevocationRoute",
        "POST /api/break-glass/revocations",
      ],
    ] as const) {
      const route = new apigwv2.CfnRoute(this, constructId, {
        apiId: api.ref,
        routeKey,
        authorizationType: "JWT",
        authorizerId: authorizer.ref,
        target: `integrations/${operationsIntegration.ref}`,
      });
      route.addResourceDependency(authorizer);
      route.addResourceDependency(operationsIntegration);
    }

    for (const [permissionId, routePath] of [
      ["AllowRegistryRouteInvoke", "registry"],
    ] as const) {
      controlPlaneFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/GET/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowAiGatewayRouteInvoke", "GET", "ai-gateway"],
      [
        "AllowModelPolicyRouteInvoke",
        "POST",
        "ai-gateway/model-policies",
      ],
      [
        "AllowModelAccessRequestRouteInvoke",
        "POST",
        "ai-gateway/model-access-requests",
      ],
      [
        "AllowModelAccessDecisionRouteInvoke",
        "POST",
        "ai-gateway/model-access-decisions",
      ],
    ] as const) {
      modelGovernanceFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowDomainsRouteInvoke", "GET", "domains"],
      ["AllowDomainCreateRouteInvoke", "POST", "domain-create"],
      ["AllowRegistryDecideRouteInvoke", "POST", "registry-decide"],
      ["AllowRegistryCreateRouteInvoke", "POST", "registry-create"],
    ] as const) {
      platformAdminFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowProjectsRouteInvoke", "GET", "projects"],
      ["AllowProjectCreateRouteInvoke", "POST", "projects"],
      ["AllowAgentsRouteInvoke", "GET", "agents"],
      ["AllowDeploymentsRouteInvoke", "GET", "deployments"],
      ["AllowApprovalsRouteInvoke", "GET", "approvals"],
      ["AllowProjectMemoriesRouteInvoke", "GET", "project-memories"],
    ] as const) {
      workspaceFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowAgentCreateRouteInvoke", "POST", "agents"],
      ["AllowAgentConfigureRouteInvoke", "PUT", "agents/{id}"],
      ["AllowAgentTestRouteInvoke", "POST", "agents/{id}/test"],
    ] as const) {
      builderFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
        + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowJourneyCreateRouteInvoke", "POST", "journeys"],
      ["AllowJourneyGetRouteInvoke", "GET", "journeys/*"],
      [
        "AllowJourneyMessageRouteInvoke",
        "POST",
        "journeys/*/messages",
      ],
      [
        "AllowJourneyContractRouteInvoke",
        "POST",
        "journeys/*/contract",
      ],
      [
        "AllowDeliveryPreviewRouteInvoke",
        "POST",
        "delivery/previews",
      ],
      ["AllowDeliveryGetRouteInvoke", "GET", "delivery/*"],
      ["AllowDeliveryGitHubRouteInvoke", "GET", "delivery/github"],
      [
        "AllowDeliveryGitHubAuthorizationRouteInvoke",
        "POST",
        "delivery/github/authorizations",
      ],
    ] as const) {
      journeyFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    journeyFunction.addPermission("AllowDeliveryGitHubCallbackRouteInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn:
        `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
        + `${api.ref}/*/GET/oauth/github/callback`,
    });
    for (const [permissionId, routePath] of [
      [
        "AllowSandboxDeploymentRouteInvoke",
        "deployments/sandbox",
      ],
      [
        "AllowProductionDeploymentRouteInvoke",
        "deployments/production",
      ],
      [
        "AllowProductionDeploymentDecisionRouteInvoke",
        "deployment-decisions",
      ],
    ] as const) {
      deploymentApiFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/POST/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowGovernanceGuardrailReadInvoke", "GET", "governance/guardrails"],
      ["AllowGovernanceExceptionListInvoke", "GET", "policy-exemptions"],
      ["AllowGovernanceExceptionRequestInvoke", "POST", "policy-exemption-request"],
      ["AllowGovernanceExceptionDecisionInvoke", "POST", "policy-exemption-decide"],
      ["AllowGovernanceAlertReadInvoke", "GET", "alerts"],
      ["AllowGovernanceAlertDraftInvoke", "POST", "governance/alert-drafts"],
      ["AllowGovernancePolicyDraftInvoke", "POST", "governance/policy-drafts"],
      ["AllowGovernanceHitlPolicyReadInvoke", "GET", "hitl"],
      [
        "AllowGovernanceAgentPublicationInvoke",
        "POST",
        "governance/agent-publications",
      ],
      ["AllowGovernancePublicationContextInvoke", "GET", "governance/publication-context"],
      ["AllowGovernanceResourceInvoke", "POST", "governance/resources"],
      ["AllowGovernancePublicationInitiationInvoke", "POST", "governance/publication-initiations"],
      [
        "AllowGovernancePublicationInvoke",
        "POST",
        "governance/publications",
      ],
      [
        "AllowGovernancePublicationDecisionInvoke",
        "POST",
        "governance/publication-decisions",
      ],
      [
        "AllowGovernanceSharedResourcesInvoke",
        "GET",
        "governance/shared-resources",
      ],
      [
        "AllowGovernanceCatalogVisibilitySetInvoke",
        "POST",
        "governance/catalog-visibility",
      ],
      [
        "AllowGovernanceCatalogVisibilityReadInvoke",
        "GET",
        "governance/catalog-visibility",
      ],
      [
        "AllowGovernanceAgentEntitlementListInvoke",
        "GET",
        "governance/agent-entitlements",
      ],
      [
        "AllowGovernanceAccessRequestInvoke",
        "POST",
        "governance/access-requests",
      ],
      [
        "AllowGovernanceAccessDecisionInvoke",
        "POST",
        "governance/access-decisions",
      ],
      [
        "AllowGovernanceAccessRevocationInvoke",
        "POST",
        "governance/access-revocations",
      ],
      [
        "AllowGovernanceAgentEntitlementInvoke",
        "POST",
        "governance/agent-entitlements",
      ],
      [
        "AllowGovernanceAgentEntitlementRevocationInvoke",
        "POST",
        "governance/agent-entitlement-revocations",
      ],
    ] as const) {
      governanceFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowExperienceAgentsInvoke", "GET", "experience/agents"],
      [
        "AllowExperienceInvocationsInvoke",
        "POST",
        "experience/invocations",
      ],
      ["AllowExperienceSessionsInvoke", "GET", "experience/sessions"],
      [
        "AllowExperienceAccessRequestListInvoke",
        "GET",
        "experience/access-requests",
      ],
      ["AllowExperienceFeedbackInvoke", "POST", "experience/feedback"],
      ["AllowExperienceIssuesInvoke", "POST", "experience/issues"],
      [
        "AllowExperienceAccessRequestsInvoke",
        "POST",
        "experience/access-requests",
      ],
    ] as const) {
      experienceFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      [
        "AllowAccessDomainMembersInvoke",
        "GET",
        "access/domain-members",
      ],
      [
        "AllowAccessDomainMembershipInvoke",
        "POST",
        "access/domain-memberships",
      ],
      [
        "AllowAccessDomainMembershipRevocationInvoke",
        "POST",
        "access/domain-membership-revocations",
      ],
      [
        "AllowAccessProjectMembersInvoke",
        "GET",
        "access/project-members",
      ],
      [
        "AllowAccessProjectMembershipInvoke",
        "POST",
        "access/project-memberships",
      ],
      [
        "AllowAccessProjectMembershipRevocationInvoke",
        "POST",
        "access/project-membership-revocations",
      ],
    ] as const) {
      accessAdminFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }
    for (const [permissionId, method, routePath] of [
      ["AllowOperationsInvoke", "GET", "operations"],
      ["AllowCostsInvoke", "GET", "costs"],
      ["AllowPlatformCostsInvoke", "GET", "platform-costs"],
      ["AllowProjectBudgetReadInvoke", "GET", "operations/project-budgets"],
      ["AllowProjectBudgetWriteInvoke", "POST", "operations/project-budgets"],
      ["AllowProjectBudgetEvaluateInvoke", "POST", "operations/project-budgets/evaluate"],
      ["AllowOperationsAuditInvoke", "GET", "operations/audit"],
      ["AllowIncidentsInvoke", "GET", "incidents"],
      ["AllowIncidentCreateInvoke", "POST", "incidents"],
      [
        "AllowIncidentActionInvoke",
        "POST",
        "incidents/{id}/actions",
      ],
      ["AllowBreakGlassInvoke", "GET", "break-glass"],
      [
        "AllowBreakGlassRequestInvoke",
        "POST",
        "break-glass/requests",
      ],
      [
        "AllowBreakGlassDecisionInvoke",
        "POST",
        "break-glass/decisions",
      ],
      [
        "AllowBreakGlassActivationInvoke",
        "POST",
        "break-glass/activations",
      ],
      [
        "AllowBreakGlassRevocationInvoke",
        "POST",
        "break-glass/revocations",
      ],
    ] as const) {
      operationsFunction.addPermission(permissionId, {
        principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        sourceArn:
          `arn:${this.partition}:execute-api:${this.region}:${this.account}:`
          + `${api.ref}/*/${method}/api/${routePath}`,
      });
    }

    const runtimeConfig = [
      "window.__RUNTIME_CONFIG__ = ",
      JSON.stringify({
        authMode: "cognito",
        apiBaseUrl: "/api",
        awsRegion: this.region,
        cognito: {
          userPoolId: userPool.userPoolId,
          clientId: userPoolClient.userPoolClientId,
          domain: cognitoHostedDomain,
          redirectUri: applicationRootUrl,
          logoutUri: applicationRootUrl,
          scopes: ["openid", "email", "profile"],
        },
      }),
      ";\n",
    ].join("");

    const deploymentLogs = new logs.LogGroup(this, "FrontendDeploymentLogs", {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const deploymentRole = new iam.Role(this, "FrontendDeploymentRole", {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.frontendDeployment,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the frontend S3 deployment provider",
      inlinePolicies: {
        FrontendDeploymentLogging: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [deploymentLogs.logGroupArn],
            }),
          ],
        }),
      },
    });

    const consolePublicPath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "console",
      "public",
    );
    const publicAssetVersion = cdk.FileSystem.fingerprint(consolePublicPath, {
      exclude: ["runtime-config.js"],
    });
    const frontendDeployment = new s3deploy.BucketDeployment(
      this,
      "PublishFrontend",
      {
        destinationBucket: webBucket,
        prune: true,
        retainOnDelete: true,
        cacheControl: [s3deploy.CacheControl.noStore()],
        role: deploymentRole,
        logGroup: deploymentLogs,
        sources: [
          s3deploy.Source.asset(
            consolePublicPath,
            { exclude: ["runtime-config.js"] },
          ),
          s3deploy.Source.data("runtime-config.js", runtimeConfig),
        ],
      },
    );
    const deploymentResource = frontendDeployment.node.findAll().find(
      (construct) => construct instanceof cdk.CustomResource,
    );
    if (!deploymentResource) {
      throw new Error("BucketDeployment custom resource was not created.");
    }
    // retainOnDelete bypasses the provider's ownership check, so the marker is unnecessary.
    cdk.Tags.of(webBucket).remove(
      `aws-cdk:cr-owned:${deploymentResource.node.addr.slice(-8)}`,
    );

    const platformProviderCode = lambda.Code.fromAsset(
      path.join(__dirname, "..", "lambda", "platform-web-provider"),
      { exclude: ["*.test.mjs"] },
    );
    const runtimeBoundaryTagLogs = new logs.LogGroup(
      this,
      "RuntimeBoundaryTagProviderLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const runtimeBoundaryTagRole = new iam.Role(
      this,
      "RuntimeBoundaryTagProviderRole",
      {
        roleName:
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.runtimeBoundaryTagProvider,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Reconciles mandatory tags on the retained runtime permissions boundary",
        inlinePolicies: {
          RuntimeBoundaryTagProvider: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [runtimeBoundaryTagLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "iam:ListPolicyTags",
                  "iam:TagPolicy",
                  "iam:UntagPolicy",
                ],
                resources: [runtimePermissionsBoundaryArn, policyInventory.boundary.managedPolicyArn],
              }),
            ],
          }),
        },
      },
    );
    const runtimeBoundaryTagFunction = new lambda.Function(
      this,
      "RuntimeBoundaryTagProvider",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        code: platformProviderCode,
        handler: "index.runtimeBoundaryTagsHandler",
        description:
          "Reconciles mandatory tags on the retained runtime permissions boundary",
        timeout: cdk.Duration.minutes(1),
        memorySize: 128,
        role: runtimeBoundaryTagRole,
        logGroup: runtimeBoundaryTagLogs,
      },
    );
    const runtimeBoundaryTagRetryConfig = new lambda.EventInvokeConfig(
      this,
      "RuntimeBoundaryTagProviderRetryConfig",
      {
        function: runtimeBoundaryTagFunction,
        retryAttempts: 0,
      },
    );
    const runtimeBoundaryTagResource = new cdk.CustomResource(
      this,
      "RuntimePermissionsBoundaryTags",
      {
        resourceType: "Custom::RuntimePermissionsBoundaryTags",
        serviceToken: runtimeBoundaryTagFunction.functionArn,
        serviceTimeout: cdk.Duration.minutes(2),
        properties: {
          AccountId: this.account,
          Partition: this.partition,
          PolicyArn: runtimeBoundary.managedPolicyArn,
          RequiredTags: Object.entries(REQUIRED_TAGS).map(([Key, Value]) => ({
            Key,
            Value,
          })),
        },
      },
    );
    runtimeBoundaryTagResource.node.addDependency(
      runtimeBoundaryTagRetryConfig,
    );

    const policyInventoryTags = new cdk.CustomResource(this, "PolicyInventoryBoundaryTags", {
      resourceType: "Custom::RuntimePermissionsBoundaryTags",
      serviceToken: runtimeBoundaryTagFunction.functionArn,
      serviceTimeout: cdk.Duration.minutes(2),
      properties: {AccountId: this.account, Partition: this.partition,
        PolicyArn: policyInventory.boundary.managedPolicyArn,
        RequiredTags: Object.entries(REQUIRED_TAGS).map(([Key, Value]) => ({Key, Value})),
      },
    });
    policyInventoryTags.node.addDependency(runtimeBoundaryTagRetryConfig);

    const invalidationLogs = new logs.LogGroup(
      this,
      "CloudFrontInvalidationProviderLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const invalidationRole = new iam.Role(
      this,
      "CloudFrontInvalidationProviderRole",
      {
        roleName:
          PLATFORM_WEB_RUNTIME_ROLE_NAMES.cloudFrontInvalidationProvider,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Invalidates only the Stage 1 CloudFront distribution after deployment",
        inlinePolicies: {
          CloudFrontInvalidationProvider: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [invalidationLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "cloudfront:CreateInvalidation",
                  "cloudfront:GetInvalidation",
                ],
                resources: [distributionArn],
              }),
            ],
          }),
        },
      },
    );
    const invalidationFunction = new lambda.Function(
      this,
      "CloudFrontInvalidationProvider",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        code: platformProviderCode,
        handler: "index.invalidationHandler",
        description:
          "Invalidates the Stage 1 CloudFront distribution after frontend deployment",
        timeout: cdk.Duration.minutes(10),
        memorySize: 128,
        role: invalidationRole,
        logGroup: invalidationLogs,
      },
    );
    const invalidationRetryConfig = new lambda.EventInvokeConfig(
      this,
      "CloudFrontInvalidationProviderRetryConfig",
      {
        function: invalidationFunction,
        retryAttempts: 0,
      },
    );
    const invalidationResource = new cdk.CustomResource(
      this,
      "CloudFrontInvalidation",
      {
        resourceType: "Custom::CloudFrontInvalidation",
        serviceToken: invalidationFunction.functionArn,
        serviceTimeout: cdk.Duration.minutes(11),
        properties: {
          DistributionId: distribution.distributionId,
          Paths: ["/*"],
          DeploymentVersion: cdk.Fn.join("|", [
            publicAssetVersion,
            runtimeConfig,
          ]),
        },
      },
    );
    invalidationResource.node.addDependency(deploymentResource);
    invalidationResource.node.addDependency(invalidationRetryConfig);

    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: "AgenticPlatform-WebIdentity",
    });
    const cloudFrontMetricOptions = {
      dimensionsMap: {
        DistributionId: distribution.distributionId,
        Region: "Global",
      },
      region: "us-east-1",
    };
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Identity API",
        left: [apiFunction.metricInvocations(), apiFunction.metricErrors()],
        right: [apiFunction.metricDuration()],
      }),
      new cloudwatch.GraphWidget({
        title: "Control Plane Read API",
        left: [
          controlPlaneFunction.metricInvocations(),
          controlPlaneFunction.metricErrors(),
          controlPlaneFunction.metricThrottles(),
        ],
        right: [controlPlaneFunction.metricDuration()],
      }),
      new cloudwatch.GraphWidget({
        title: "Workspace API",
        left: [
          workspaceFunction.metricInvocations(),
          workspaceFunction.metricErrors(),
          workspaceFunction.metricThrottles(),
        ],
        right: [workspaceFunction.metricDuration()],
      }),
      new cloudwatch.GraphWidget({
        title: "Builder API",
        left: [
          builderFunction.metricInvocations(),
          builderFunction.metricErrors(),
          builderFunction.metricThrottles(),
        ],
        right: [builderFunction.metricDuration()],
      }),
      new cloudwatch.GraphWidget({
        title: "CloudFront",
        left: [
          distribution.metricRequests(cloudFrontMetricOptions),
          distribution.metric5xxErrorRate(cloudFrontMetricOptions),
        ],
      }),
    );

    new cloudwatch.Alarm(this, "LambdaErrorsAlarm", {
      alarmName: "AgenticPlatform-IdentityApi-Errors",
      metric: apiFunction.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "ControlPlaneErrorsAlarm", {
      alarmName: "AgenticPlatform-ControlPlaneReadApi-Errors",
      metric: controlPlaneFunction.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "WorkspaceErrorsAlarm", {
      alarmName: "AgenticPlatform-WorkspaceApi-Errors",
      metric: workspaceFunction.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "BuilderErrorsAlarm", {
      alarmName: "AgenticPlatform-BuilderApi-Errors",
      metric: builderFunction.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      evaluationPeriods: 1,
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const cloudFrontAlarmLogs = new logs.LogGroup(
      this,
      "CloudFrontAlarmProviderLogs",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const cloudFrontAlarmRole = new iam.Role(
      this,
      "CloudFrontAlarmProviderRole",
      {
        roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.cloudFrontAlarmProvider,
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        description:
          "Creates the global CloudFront error-rate alarm in us-east-1",
        inlinePolicies: {
          CloudFrontAlarmProvider: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                resources: [cloudFrontAlarmLogs.logGroupArn],
              }),
              new iam.PolicyStatement({
                actions: [
                  "cloudwatch:PutMetricAlarm",
                  "cloudwatch:DeleteAlarms",
                  "cloudwatch:ListTagsForResource",
                  "cloudwatch:TagResource",
                  "cloudwatch:UntagResource",
                ],
                resources: [cloudFrontAlarmArnPattern],
              }),
            ],
          }),
        },
      },
    );
    const cloudFrontAlarmFunction = new lambda.Function(
      this,
      "CloudFrontAlarmProvider",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        code: platformProviderCode,
        handler: "index.alarmHandler",
        description:
          "Reconciles the global CloudFront 5xx alarm and mandatory tags",
        timeout: cdk.Duration.minutes(1),
        memorySize: 128,
        role: cloudFrontAlarmRole,
        logGroup: cloudFrontAlarmLogs,
      },
    );
    const cloudFrontAlarmRetryConfig = new lambda.EventInvokeConfig(
      this,
      "CloudFrontAlarmProviderRetryConfig",
      {
        function: cloudFrontAlarmFunction,
        retryAttempts: 0,
      },
    );
    const cloudFrontAlarmResource = new cdk.CustomResource(
      this,
      "CloudFront5xxAlarm",
      {
        resourceType: "Custom::CloudFrontAlarm",
        serviceToken: cloudFrontAlarmFunction.functionArn,
        serviceTimeout: cdk.Duration.minutes(2),
        properties: {
          AlarmName: cloudFrontAlarmNameValue,
          AlarmArn: cloudFrontAlarmArn,
          DistributionId: distribution.distributionId,
          OwnershipTags: [
            { Key: "project", Value: REQUIRED_TAGS.project },
            { Key: "managedBy", Value: REQUIRED_TAGS.managedBy },
          ],
          RequiredTags: Object.entries(REQUIRED_TAGS).map(([Key, Value]) => ({
            Key,
            Value,
          })),
        },
      },
    );
    cloudFrontAlarmResource.node.addDependency(cloudFrontAlarmRetryConfig);

    cdk.Validations.of(userPool).acknowledge(
      {
        id: "AwsSolutions-COG2",
        reason:
          "Stage 1 requires optional TOTP MFA so seeded demo users can complete first login; SMS MFA is disabled.",
      },
      {
        id: "AwsSolutions-COG8",
        reason:
          "Cognito Plus threat protection is a production identity-onboarding decision; Stage 1 uses short tokens, no self-signup, deletion protection, and TOTP support.",
      },
    );
    cdk.Validations.of(healthRoute).acknowledge({
      id: "AwsSolutions-APIG4",
      reason:
        "GET /api/health intentionally returns only static service status; the identity-bearing /api/me route requires the Cognito JWT authorizer.",
    });
    cdk.Validations.of(deliveryGitHubCallbackRoute).acknowledge({
      id: "AwsSolutions-APIG4",
      reason:
        "GitHub cannot present the platform Cognito JWT on its OAuth callback. "
        + "This exact GET route accepts only a short-lived, one-time state "
        + "record and a strict GitHub query shape before completing delivery.",
    });
    cdk.Validations.of(apiFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for this deployment stage.",
    });
    cdk.Validations.of(controlPlaneFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the control-plane read API.",
    });
    cdk.Validations.of(workspaceFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the workspace API.",
    });
    cdk.Validations.of(accessAdminFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the governed access administration API.",
    });
    cdk.Validations.of(builderFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the builder API.",
    });
    cdk.Validations.of(journeyFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the Journey and Delivery API.",
    });
    cdk.Validations.of(runtimeProofConfiguratorFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the Runtime proof endpoint configurator.",
    });
    cdk.Validations.of(deploymentApiFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the governed deployment API.",
    });
    cdk.Validations.of(modelGovernanceFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the model governance API.",
    });
    cdk.Validations.of(governanceFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the governance API.",
    });
    cdk.Validations.of(experienceFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the governed end-user experience API.",
    });
    cdk.Validations.of(operationsFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the scoped operations and cost API.",
    });
    cdk.Validations.of(platformAdminFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the platform administration API.",
    });
    cdk.Validations.of(registryDecisionFinalizerFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the Registry decision finalizer.",
    });
    cdk.Validations.of(registryDecisionFinalizerRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(registryDecisionFinalizerLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The Registry decision finalizer writes only child log streams beneath its one retained log group.",
    });
    cdk.Validations.of(accessAdminRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(accessAdminLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The access administration API writes only child log streams beneath its one retained log group.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; no other access administration action uses the wildcard resource.",
      },
    );
    cdk.Validations.of(platformAdminRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(platformAdminLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The platform administration API writes only child log streams beneath its one retained log group.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "CreateRegistry cannot target a pre-existing ARN; the statement permits no other Registry action and requires all three exact mandatory request tags with exact TagKeys.",
      },
      ...registryRecordNagFindings.map((id) => ({
        id,
        reason: registryRecordWildcardReason,
      })),
    );
    platformAdminRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:registry/*]`]:
          "PlatformAdmin uses the account-registry ARN for creation-time "
          + "TagResource, tag-constrained dynamic listing, and compensation "
          + "delete. Both ownership variants require exact mandatory tags "
          + "and region; no post-creation retagging is granted.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:`
          + "registry/*/record/*]"]:
          "PlatformAdmin discovery, reads, and status updates for dynamic "
          + "records require exact mandatory ownership tags and region; "
          + "record create and delete are not granted.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "workload-identity-directory/*]"]:
          "AgentCore authorizes Registry-managed workload identity creation "
          + "and deletion at the workload identity directory resource; the "
          + "statement grants no other action and is region constrained.",
      },
    );
    cdk.Validations.of(hostedAcceptanceBrokerFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "Node.js 22 is the runtime explicitly required for the private hosted acceptance broker.",
    });
    hostedAcceptanceBrokerRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        [`AwsSolutions-IAM5[Resource::<${this.getLogicalId(
          hostedAcceptanceBrokerLogs.node.defaultChild as logs.CfnLogGroup,
        )}.Arn>:*]`]:
          "The private hosted acceptance broker writes only child log streams beneath its one retained log group.",
        ["AwsSolutions-IAM5[Resource::"
          + "AgenticPlatform-ControlPlane-SharedRegistryArn/record/*]"]:
          "The broker can address only records beneath the exact imported "
          + "shared fixture Registry. Record creation requires all mandatory "
          + "request tags, and submit/delete is bounded by all acceptance "
          + "resource tags plus exact handler ownership validation.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:registry/*]`]:
          "The broker accepts only an exact supplied domain Registry ID. "
          + "Reads support identity validation without unsupported tag "
          + "conditions, while DeleteRegistry requires all three "
          + "platform ownership tags and exact handler ownership checks.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "workload-identity-directory/default/workload-identity/"
          + "registry-*]"]:
          "Agent Registry authorizes deletion against both its default "
          + "directory and generated registry-<registryId> workload identity. "
          + "The broker grants only DeleteWorkloadIdentity for that generated "
          + "identity naming family in the deployment region.",
      },
    );
    cdk.Validations.of(identityRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(identityLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "Lambda log streams are child resources beneath this one retained log group; no other CloudWatch Logs resources are allowed.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the role's only account-wide actions.",
      },
    );
    cdk.Validations.of(controlPlaneRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(controlPlaneLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The control-plane API writes only child log streams beneath its one retained log group; Registry and Gateway permissions use exact imported ARNs.",
      },
      ...registryRecordNagFindings.map((id) => ({
        id,
        reason: registryRecordWildcardReason,
      })),
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the role's only account-wide actions.",
      },
    );
    cdk.Validations.of(workspaceRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(workspaceLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The workspace API writes only child log streams beneath its one retained log group.",
      },
      ...registryRecordNagFindings.map((id) => ({ id, reason: registryRecordWildcardReason })),
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray telemetry actions do not support resource-level permissions; "
          + "bedrock-agentcore:GetMemory/ListMemories and bedrock:GetKnowledgeBase "
          + "are scoped to account and region at runtime via the IAM policy conditions "
          + "and are used only for read-only status enrichment of the four demo baseline projects.",
      },
    );
    workspaceRole.node.addMetadata(cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
      ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:" + `agent-registry:${this.region}:${this.account}:registry/*]`]:
        "Project subset validation lists only the authoritative active domain Registry with exact cdk or hosted-acceptance ownership tags.",
      ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:" + `agent-registry:${this.region}:${this.account}:registry/*/record/*]`]:
        "Project subset validation reads approved records in the authoritative domain Registry, constrained by deployment region and exact ownership tags.",
    });
    cdk.Validations.of(builderRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(builderLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The builder API writes only child log streams beneath its one retained log group.",
      },
      ...registryRecordNagFindings.map((id) => ({
        id,
        reason:
          "Builder resource authorization resolves approved versions only beneath the four exact imported Registry ARNs.",
      })),
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the role's only account-wide actions.",
      },
    );
    builderRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:registry/*]`]:
          "Builder authorization lists only the authoritative active domain "
          + "Registry and requires exact cdk or hosted-acceptance ownership tags.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:`
          + "registry/*/record/*]"]:
          "Builder authorization reads approved records only from the "
          + "authoritative active domain Registry and requires exact ownership tags.",
      },
    );
    cdk.Validations.of(journeyRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(journeyLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The Journey API writes only child log streams beneath its one retained log group.",
      },
      ...registryRecordNagFindings.map((id) => ({
        id,
        reason:
          "Journey delivery resolves approved resource versions only beneath the four exact imported Registry ARNs.",
      })),
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the Journey role's only account-wide actions.",
      },
    );
    const runtimeProofConfiguratorFunctionLogicalId = this.getLogicalId(
      runtimeProofConfiguratorFunction.node.defaultChild as lambda.CfnFunction,
    );
    cdk.Validations.of(runtimeProofProviderRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${runtimeProofConfiguratorFunctionLogicalId}.Arn>:*]`,
      reason:
        "The CloudFormation provider framework invokes and inspects only the exact Runtime proof configurator Lambda, including its version or alias child ARN form.",
    });
    cdk.Validations.of(deploymentApiRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(deploymentApiLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The deployment API writes only child log streams beneath its one retained log group.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the role's only account-wide actions.",
      },
    );
    cdk.Validations.of(modelGovernanceRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(modelGovernanceLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The model governance API writes only child log streams beneath its one retained log group.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the model governance role's only account-wide actions.",
      },
    );
    cdk.Validations.of(governanceRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(governanceLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The governance API writes only child log streams beneath its one retained log group.",
      },
      ...registryRecordNagFindings.map((id) => ({
        id,
        reason:
          "Governance reads and mutates only record children beneath the four exact imported domain Registries; every write is also constrained by the service's domain authorization and durable audit transaction.",
      })),
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the governance role's only account-wide actions.",
      },
    );
    governanceRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:registry/*]`]:
          "Governance uses account Registry ARNs only for tag-constrained "
          + "record creation and discovery of CDK-owned domain Registries; "
          + "mandatory ownership tags and server-side domain authorization "
          + "are enforced.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:`
          + "registry/*/record/*]"]:
          "Governance uses account record child ARNs only for "
          + "tag-constrained publication, status decisions, and reads after "
          + "validating the caller's effective domain permissions.",
      },
    );
    cdk.Validations.of(experienceRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(experienceLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The experience API writes only child log streams beneath its one retained log group.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "X-Ray PutTraceSegments and PutTelemetryRecords do not support resource-level permissions; these are the experience role's only account-wide actions.",
      },
    );
    cdk.Validations.of(operationsRole).acknowledge(
      {
        id:
          `AwsSolutions-IAM5[Resource::<`
          + `${this.getLogicalId(operationsLogs.node.defaultChild as logs.CfnLogGroup)}`
          + ".Arn>:*]",
        reason:
          "The operations API writes only child log streams beneath its one retained log group.",
      },
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "CloudWatch GetMetricData and X-Ray telemetry do not support resource-level permissions; the handler permits only read-only, server-scoped aggregate retrieval plus trace publication.",
      },
    );
    cdk.Validations.of(agentRuntimeRole).acknowledge(
      {
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "AgentCore Runtime requires X-Ray sampling and trace writes plus namespace-constrained CloudWatch metric publication; no mutation-capable AWS API is granted account-wide.",
      },
      {
        id: "AwsSolutions-IAM5[Action::s3:GetObject*]",
        reason:
          "AgentCore reads only its immutable content-addressed Runtime artifact from this account and region's CDK asset bucket.",
      },
      {
        id: "AwsSolutions-IAM5[Action::s3:GetBucket*]",
        reason:
          "AgentCore reads metadata only for this account and region's CDK asset bucket.",
      },
      {
        id: "AwsSolutions-IAM5[Action::s3:List*]",
        reason:
          "AgentCore lists only this account and region's CDK asset bucket to retrieve the immutable Runtime artifact.",
      },
    );
    agentRuntimeRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "log-group:/aws/bedrock-agentcore/runtimes/*]"]:
          "AgentCore writes only its service-managed Runtime log groups in this account and region.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:log-group:*]`]:
          "DescribeLogGroups is a read-only AgentCore prerequisite and cannot be narrowed to one log group.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:"
          + `${this.region}:${this.account}:`
          + "log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*]"]:
          "AgentCore writes only child streams beneath its service-managed Runtime log groups.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `bedrock-agentcore:${this.region}:${this.account}:`
          + "workload-identity-directory/default/workload-identity/*]"]:
          "The Runtime obtains short-lived tokens only for AgentCore-managed workload identities in the default directory.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-"
          + `${cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER}-assets-`
          + `${this.account}-${this.region}/*]`]:
          "The Runtime reads only its immutable asset beneath this account and region's CDK asset bucket.",
      },
    );
    controlPlaneRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:registry/*]`]:
          "Dynamic Registry listing is limited to this account and region "
          + "and requires exact cdk or hosted-acceptance ownership tags.",
        ["AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:"
          + `agent-registry:${this.region}:${this.account}:`
          + "registry/*/record/*]"]:
          "Dynamic record discovery and reads are limited to this account "
          + "and region and require exact cdk or hosted-acceptance ownership "
          + "tags; no mutation or delete action is granted.",
      },
    );
    cdk.Validations.of(deploymentRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(deploymentLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The deployment provider writes only child log streams beneath its one retained log group.",
    }, {
      id: "AwsSolutions-IAM5[Action::s3:GetObject*]",
      reason:
        "CDK BucketDeployment expands this read family for versioned and tagged objects while syncing two content-addressed source archives and the destination.",
    }, {
      id: "AwsSolutions-IAM5[Action::s3:GetBucket*]",
      reason:
        "The generated sync provider reads bucket metadata for only the CDK asset bucket and this stack's web bucket.",
    }, {
      id: "AwsSolutions-IAM5[Action::s3:List*]",
      reason:
        "Prune and sync require listing only the CDK asset bucket and this stack's web bucket.",
    }, {
      id: "AwsSolutions-IAM5[Action::s3:DeleteObject*]",
      reason:
        "Prune requires deleting stale object versions only beneath this stack's web asset bucket.",
    }, {
      id: "AwsSolutions-IAM5[Action::s3:Abort*]",
      reason:
        "The deployment provider may abort incomplete multipart uploads only in this stack's web asset bucket.",
    }, {
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(webBucket.node.defaultChild as s3.CfnBucket)}`
        + ".Arn>/*]",
      reason:
        "The deployment intentionally owns, updates, and prunes all keys in the dedicated web asset bucket.",
    });
    cdk.Validations.of(invalidationRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(invalidationLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The invalidation provider writes only child log streams beneath its one retained log group; CreateInvalidation and GetInvalidation are scoped to this stack's exact distribution ARN.",
    });
    cdk.Validations.of(runtimeBoundaryTagRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(runtimeBoundaryTagLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The boundary-tag provider writes only child log streams beneath its one retained log group; IAM tag operations are scoped to the exact retained boundary policy ARN.",
    });
    cdk.Validations.of(platformStateSeedRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(platformStateSeedLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The baseline seed writes only child log streams beneath its one retained log group; DynamoDB access is limited to GetItem and conditional PutItem on the exact platform state table.",
    });
    cdk.Validations.of(platformWorkspaceSeedRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(platformStateSeedLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The platform workspace seed writes only child log streams beneath its one retained log group; DynamoDB access is limited to GetItem and conditional PutItem on the exact platform project partition.",
    });
    cdk.Validations.of(platformAgentRegistrySeedRole).acknowledge({
      id:
        "AwsSolutions-IAM5[Resource::"
        + "AgenticPlatform-ControlPlane-Registry-platform-Arn/record/*]",
      reason:
        "The deployment seeder reconciles exactly one fixed-name platform "
        + "Agent record. Child-record access is limited to the imported "
        + "Platform Registry, required deployment tags, and bounded "
        + "create, read, submit, approve, and tag operations.",
    });
    cdk.Validations.of(cloudFrontAlarmRole).acknowledge({
      id:
        `AwsSolutions-IAM5[Resource::<`
        + `${this.getLogicalId(cloudFrontAlarmLogs.node.defaultChild as logs.CfnLogGroup)}`
        + ".Arn>:*]",
      reason:
        "The alarm provider writes only child log streams beneath its one retained log group.",
    });
    cloudFrontAlarmRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        [`AwsSolutions-IAM5[Resource::${cloudFrontAlarmNagResource}]`]:
          "The provider can reconcile only deployment-specific CloudFront 5xx alarms under the fixed PlatformWeb stack prefix so replacement cleanup can reach both old and new names; exact event binding and ownership verification precede mutation.",
      },
    );
    const bootstrapAssetFinding =
      "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::"
      + `cdk-${cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER}-assets-`
      + `${this.account}-${this.region}/*]`;
    deploymentRole.node.addMetadata(
      cdk.Validations.ACKNOWLEDGED_RULES_METADATA_KEY,
      {
        [bootstrapAssetFinding]:
          "The provider reads content-addressed deployment archives from this account and region's CDK bootstrap asset bucket.",
      },
    );
    const deploymentProviderFunction = this.node.findAll().find(
      (construct) =>
        construct instanceof lambda.CfnFunction
        && construct.node.path.includes("Custom::CDKBucketDeployment"),
    );
    if (!deploymentProviderFunction) {
      throw new Error("BucketDeployment provider Lambda was not created.");
    }
    cdk.Validations.of(deploymentProviderFunction).acknowledge({
      id: "AwsSolutions-L1",
      reason:
        "The BucketDeployment provider runtime is selected internally by aws-cdk-lib 2.266.0 and cannot be overridden by this stack.",
    });
    cdk.Validations.of(distribution).acknowledge(
      {
        id: "AwsSolutions-CFR1",
        reason:
          "Stage 1 is an intentionally global demo console and has no approved country allow or deny list; geographic restriction is deferred until deployment geography is defined.",
      },
      {
        id: "AwsSolutions-CFR2",
        reason:
          "A CloudFront-scope WAF must be created in a separate us-east-1 edge stack; that narrowly bounded control is deferred beyond Task 3.",
      },
      {
        id: "AwsSolutions-CFR4",
        reason:
          "Stage 1 uses the CloudFront default hostname and certificate. Enforcing TLSv1.2_2021 requires an ACM certificate and custom alias, which are outside the approved Stage 1 scope.",
      },
    );
    new cdk.CfnOutput(this, "ApplicationUrl", {
      value: applicationUrl,
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, "HttpApiUrl", {
      value: api.attrApiEndpoint,
    });
    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
    });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "CognitoDomain", {
      value: cognitoHostedDomain,
    });
    new cdk.CfnOutput(this, "HostedAcceptanceBrokerFunctionArn", {
      value: hostedAcceptanceBrokerFunction.functionArn,
    });
    new cdk.CfnOutput(this, "PlatformStateTableName", {
      value: platformStateTable.tableName,
    });
    new cdk.CfnOutput(this, "StarterBuilderModelId", {
      value: starterBuilderModelId,
    });
    // Deployment bindings for the companion AgenticPlatform-DomainBootstrap
    // stack (bin/domain-bootstrap.ts). Without them, discovering the target
    // JSON requires manual console spelunking, and skipping that stack ships
    // a broken domain-create wizard: its five /api/domain-bootstrap* routes
    // belong to that stack, not to this one.
    new cdk.CfnOutput(this, "HttpApiId", {
      value: api.ref,
    });
    new cdk.CfnOutput(this, "JwtAuthorizerId", {
      value: authorizer.ref,
    });
    new cdk.CfnOutput(this, "PlatformAdminApiFunctionName", {
      value: platformAdminFunction.functionName,
    });
    new cdk.CfnOutput(this, "ControlPlaneReadApiFunctionName", {
      value: controlPlaneFunction.functionName,
    });
    new cdk.CfnOutput(this, "ControlPlaneReadApiRoleArn", {
      value: controlPlaneFunction.role!.roleArn,
    });
  }
}
