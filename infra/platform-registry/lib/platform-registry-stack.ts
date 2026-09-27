import { execSync } from "child_process";
import { createHash } from "crypto";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import runtimePermissionsBoundary from
  "../config/control-plane-runtime-permissions-boundary.json";
import {
  CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  CONTROL_PLANE_DOMAIN_KEYS,
  PROVISIONED_RESOURCE_NAME_PREFIX,
  provisionedLambdaName,
  provisionedStateMachineName,
  type ControlPlaneDomainKey,
  type ReferenceExistingControlPlaneConfig,
  type ResolvedControlPlaneConfig,
} from "./control-plane-config";
import { canonicalizeSeedRecordName } from "./seed-record-name";
import type { SeedRecordStatus } from "./seed-record-status";
import {
  governedDomainId,
  hasGovernedRecordVersion,
  type GovernedDescriptorMetadata,
  type GovernedResourceType,
} from "./governed-descriptor";

export const CONTROL_PLANE_STACK_NAME = "AgenticPlatform-ControlPlane";
export const PROVISIONED_CONTROL_PLANE_STACK_NAME =
  "AgenticPlatform-ControlPlane-Provisioned";
export const CONTROL_PLANE_CONFIG_PARAMETER_NAME =
  "/agentic-platform/control-plane/config";

const DEFAULT_TAGS = {
  project: "agentic-ai-platform-demo",
  managedBy: "cdk",
  "auto-delete": "no",
};
const GOVERNED_X_PLATFORM_KEYS = [
  "domainId",
  "ownerSubject",
  "resourceId",
  "resourceType",
  "shared",
] as const;
const OWNER_SUBJECT_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const RESOURCE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,255}$/;

// LogGroup matching retains the full stack prefix: limit 512, required 85,
// leaving 427 characters. The current name fits without a shortened prefix.
function runtimePermissionsBoundaryDocument({
  account,
  partition,
  region,
}: {
  account: string;
  partition: string;
  region: string;
}): Record<string, unknown> {
  const render = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value
        .split("${ACCOUNT}").join(account)
        .split("${PARTITION}").join(partition)
        .split("${REGION}").join(region)
        .split("${PROVISIONED_NAME_PREFIX}")
        .join(PROVISIONED_RESOURCE_NAME_PREFIX);
    }
    if (Array.isArray(value)) {
      return value.map(render);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, render(child)]),
      );
    }
    return value;
  };

  return render(runtimePermissionsBoundary) as Record<string, unknown>;
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

const DOMAIN_RESOURCES: Record<
  ControlPlaneDomainKey,
  {
    sourceId: string;
    registryName: string;
    outputName: string;
    exportName: string;
  }
> = {
  platform: {
    sourceId: "platform",
    registryName: "domain_platform",
    outputName: "Platform",
    exportName: "platform",
  },
  customer_support: {
    sourceId: "customer-support",
    registryName: "domain_customer_support",
    outputName: "CustomerSupport",
    exportName: "customer-support",
  },
  operations: {
    sourceId: "operations",
    registryName: "domain_operations",
    outputName: "Operations",
    exportName: "operations",
  },
};

export interface DomainConfig {
  id: string;
  name: string;
  description: string;
}

export interface SeedRecord {
  registryRef: string;
  name: string;
  displayName: string;
  recordType: "AGENT" | "SKILL" | "CUSTOM";
  descriptors: Record<string, any>;
  version: string;
  status: SeedRecordStatus;
  description?: string;
}

export interface PlatformRegistryStackProps extends cdk.StackProps {
  config: ResolvedControlPlaneConfig;
  domains: DomainConfig[];
  seedRecords?: SeedRecord[];
}

interface ControlPlaneResources {
  sharedRegistryId: string;
  sharedRegistryArn: string;
  domainRegistryIds: Record<ControlPlaneDomainKey, string>;
  domainRegistryArns: Record<ControlPlaneDomainKey, string>;
  llmGatewayId: string;
  llmGatewayRegion: string;
  llmGatewayArn: string;
  llmGatewayUrl: string;
  toolsGatewayId: string;
  toolsGatewayArn: string;
  toolsGatewayUrl: string;
}

export class PlatformRegistryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlatformRegistryStackProps) {
    const {
      config,
      domains,
      seedRecords = [],
      env,
      tags: stackTags,
      ...stackProps
    } = props;
    super(scope, id, {
      ...stackProps,
      env: env ?? {
        account: config.account,
        region: config.region,
      },
      stackName:
        config.mode === "provision"
          ? PROVISIONED_CONTROL_PLANE_STACK_NAME
          : CONTROL_PLANE_STACK_NAME,
    });

    const tags = {
      ...(stackTags ?? {}),
      ...DEFAULT_TAGS,
    };
    for (const [key, value] of Object.entries(tags)) {
      cdk.Tags.of(this).add(key, value);
    }
    const runtimeBoundary = config.mode === "provision"
      ? new iam.ManagedPolicy(
        this,
        "ControlPlaneRuntimePermissionsBoundary",
        {
          managedPolicyName:
            CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME,
          description:
            "Maximum permissions for provisioned control-plane runtime roles",
          document: iam.PolicyDocument.fromJson(
            runtimePermissionsBoundaryDocument({
              account: this.account,
              partition: this.partition,
              region: this.region,
            }),
          ),
        },
      )
      : undefined;
    if (runtimeBoundary !== undefined) {
      iam.PermissionsBoundary.of(this).apply(runtimeBoundary);
    }

    const resources =
      config.mode === "reference-existing"
        ? this.referenceExistingResources(config)
        : this.provisionResources(
          domains,
          seedRecords,
          tags,
          runtimeBoundary!,
          {
            llm: config.llmGatewayName,
            tools: config.toolsGatewayName,
          },
        );

    const configParameter = new ssm.StringParameter(
      this,
      "ControlPlaneConfig",
      {
        parameterName: CONTROL_PLANE_CONFIG_PARAMETER_NAME,
        description:
          "Resolved Agentic Platform Registry and AgentCore Gateway configuration",
        stringValue: this.toJsonString({
          schemaVersion: 1,
          mode: config.mode,
          account: config.account,
          region: config.region,
          partition: config.partition,
          registries: {
            shared: {
              name: "platform_shared",
              registryId: resources.sharedRegistryId,
              registryArn: resources.sharedRegistryArn,
            },
            domains: {
              platform: {
                name: DOMAIN_RESOURCES.platform.registryName,
                registryId: resources.domainRegistryIds.platform,
                registryArn: resources.domainRegistryArns.platform,
              },
              customer_support: {
                name: DOMAIN_RESOURCES.customer_support.registryName,
                registryId: resources.domainRegistryIds.customer_support,
                registryArn:
                  resources.domainRegistryArns.customer_support,
              },
              operations: {
                name: DOMAIN_RESOURCES.operations.registryName,
                registryId: resources.domainRegistryIds.operations,
                registryArn: resources.domainRegistryArns.operations,
              },
            },
          },
          gateways: {
            llm: {
              name: config.llmGatewayName,
              gatewayId: resources.llmGatewayId,
              region: resources.llmGatewayRegion,
              gatewayArn: resources.llmGatewayArn,
              gatewayUrl: resources.llmGatewayUrl,
            },
            tools: {
              name: config.toolsGatewayName,
              gatewayId: resources.toolsGatewayId,
              gatewayArn: resources.toolsGatewayArn,
              gatewayUrl: resources.toolsGatewayUrl,
            },
          },
        }),
      },
    );

    this.createOutputs(resources, config.region, configParameter.parameterName);
  }

  private referenceExistingResources(
    config: ReferenceExistingControlPlaneConfig,
  ): ControlPlaneResources {
    return {
      sharedRegistryId: config.sharedRegistryId,
      sharedRegistryArn: config.sharedRegistryArn,
      domainRegistryIds: config.domainRegistryIds,
      domainRegistryArns: config.domainRegistryArns,
      llmGatewayId: config.llmGatewayId,
      llmGatewayRegion: config.llmGatewayRegion,
      llmGatewayArn: config.llmGatewayArn,
      llmGatewayUrl: config.llmGatewayUrl,
      toolsGatewayId: config.toolsGatewayId,
      toolsGatewayArn: config.toolsGatewayArn,
      toolsGatewayUrl: config.toolsGatewayUrl,
    };
  }

  private provisionResources(
    domains: DomainConfig[],
    seedRecords: SeedRecord[],
    tags: Record<string, string>,
    runtimeBoundary: iam.ManagedPolicy,
    gatewayNames: { llm: string; tools: string },
  ): ControlPlaneResources {
    const region = this.region;
    const account = this.account;
    const partition = this.partition;
    const registryTags = { ...DEFAULT_TAGS };
    const registryRequestTagConditions = {
      "ForAllValues:StringEquals": {
        "aws:TagKeys": Object.keys(registryTags).sort(),
      },
      StringEquals: {
        ...Object.fromEntries(
          Object.entries(registryTags).map(([key, value]) => [
            `aws:RequestTag/${key}`,
            value,
          ]),
        ),
        "aws:RequestedRegion": region,
      },
    };
    const registryResourceTagConditions = {
      StringEquals: Object.fromEntries(
        Object.entries(registryTags).map(([key, value]) => [
          `aws:ResourceTag/${key}`,
          value,
        ]),
      ),
    };
    const registryCreateRecordConditions = {
      "ForAllValues:StringEquals":
        registryRequestTagConditions["ForAllValues:StringEquals"],
      StringEquals: {
        ...registryRequestTagConditions.StringEquals,
        ...registryResourceTagConditions.StringEquals,
      },
    };
    const registryArn =
      `arn:${partition}:agent-registry:${region}:${account}:registry/*`;
    const registryRecordArn = `${registryArn}/record/*`;
    const domainsById = new Map(domains.map((domain) => [domain.id, domain]));

    for (const domain of Object.values(DOMAIN_RESOURCES)) {
      if (!domainsById.has(domain.sourceId)) {
        throw new Error(
          `Missing required domain configuration: ${domain.sourceId}`,
        );
      }
    }

    const canonicalSeeds = this.validateAndCanonicalizeSeeds(seedRecords);
    // The runtime permissions boundary matches provider Lambdas and the
    // waiter state machine by name prefix, so every one of them needs an
    // explicit physical name carrying that prefix (CloudFormation-generated
    // names truncate or drop the stack-name prefix and never match).
    const nameScope = { account, region };
    const lambdaName = (role: string) =>
      provisionedLambdaName(nameScope, role);
    const lambdaDir = path.join(__dirname, "..", "lambda");
    const registryCode = lambda.Code.fromAsset(lambdaDir, {
      bundling: {
        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
        user: "root",
        bundlingFileAccess: cdk.BundlingFileAccess.VOLUME_COPY,
        command: [
          "bash",
          "-c",
          "PIP_DISABLE_PIP_VERSION_CHECK=1 pip install --quiet --root-user-action=ignore -r requirements.txt -t /asset-output && cp registry_handler.py /asset-output/",
        ],
        local: {
          tryBundle(outputDir: string): boolean {
            try {
              execSync(
                `python3 -m pip install -r "${lambdaDir}/requirements.txt" -t "${outputDir}" --quiet && cp "${lambdaDir}/registry_handler.py" "${outputDir}/"`,
                { stdio: "ignore" },
              );
              return true;
            } catch {
              return false;
            }
          },
        },
      },
    });
    const onEventLogGroup = new logs.LogGroup(
      this,
      "RegistryOnEventLogGroup",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const isCompleteLogGroup = new logs.LogGroup(
      this,
      "RegistryIsCompleteLogGroup",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );
    const providerLogGroup = new logs.LogGroup(
      this,
      "RegistryProviderLogGroup",
      {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );

    const registryOnEventLambda = new lambda.Function(
      this,
      "RegistryOnEventHandler",
      {
      functionName: lambdaName("on-event"),
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "registry_handler.handler",
      code: registryCode,
      timeout: cdk.Duration.minutes(5),
      description:
        "Custom Resource on-event handler for Agent Registry lifecycle",
      environment: {
        REGISTRY_REGION: region,
      },
      logGroup: onEventLogGroup,
    });
    const registryIsCompleteLambda = new lambda.Function(
      this,
      "RegistryIsCompleteHandler",
      {
        functionName: lambdaName("is-complete"),
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "registry_handler.is_complete_handler",
        code: registryCode,
        timeout: cdk.Duration.minutes(1),
        description:
          "Custom Resource is-complete handler for Agent Registry deletion",
        environment: {
          REGISTRY_REGION: region,
        },
        logGroup: isCompleteLogGroup,
      },
    );

    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["agent-registry:CreateRegistry"],
        resources: ["*"],
        conditions: registryRequestTagConditions,
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "iam:ListPolicyTags",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ],
        resources: [runtimeBoundary.managedPolicyArn],
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["agent-registry:TagResource"],
        resources: [registryArn],
        conditions: registryCreateRecordConditions,
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["agent-registry:CreateRegistryRecord"],
        resources: [registryArn],
        conditions: registryCreateRecordConditions,
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "agent-registry:GetRegistry",
          "agent-registry:ListRegistryRecords",
        ],
        resources: [registryArn],
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["agent-registry:GetRegistryRecord"],
        resources: [registryRecordArn],
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "agent-registry:UpdateRegistry",
          "agent-registry:DeleteRegistry",
        ],
        resources: [registryArn],
        conditions: registryResourceTagConditions,
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "agent-registry:DeleteRegistryRecord",
          "agent-registry:SubmitRegistryRecordForApproval",
          "agent-registry:UpdateRegistryRecordStatus",
        ],
        resources: [registryRecordArn],
        conditions: registryResourceTagConditions,
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["agent-registry:ListRegistries"],
        resources: ["*"],
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:CreateWorkloadIdentity",
          "bedrock-agentcore:GetWorkloadIdentity",
          "bedrock-agentcore:DeleteWorkloadIdentity",
        ],
        resources: [
          `arn:${partition}:bedrock-agentcore:${region}:${account}:workload-identity-directory/*`,
        ],
      }),
    );
    registryOnEventLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:CreateServiceLinkedRole"],
        resources: [
          `arn:${partition}:iam::${account}:role/aws-service-role/`
            + "agent-registry.amazonaws.com/"
            + "AWSServiceRoleForAgentRegistry",
        ],
        conditions: {
          StringEquals: {
            "iam:AWSServiceName": "agent-registry.amazonaws.com",
          },
        },
      }),
    );
    registryIsCompleteLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "agent-registry:GetRegistry",
          "agent-registry:GetRegistryRecord",
        ],
        resources: [
          `arn:${partition}:agent-registry:${region}:${account}:registry/*`,
          `arn:${partition}:agent-registry:${region}:${account}:registry/*/record/*`,
        ],
      }),
    );

    const provider = new cr.Provider(this, "RegistryProvider", {
      onEventHandler: registryOnEventLambda,
      isCompleteHandler: registryIsCompleteLambda,
      queryInterval: cdk.Duration.seconds(10),
      totalTimeout: cdk.Duration.minutes(10),
      logGroup: providerLogGroup,
      providerFunctionName: lambdaName("fw-on-event"),
    });
    // cr.Provider only exposes a name prop for its framework onEvent Lambda
    // (providerFunctionName above). The framework isComplete/onTimeout
    // Lambdas and the waiter state machine must be named through escape
    // hatches so the boundary's name-prefix wildcards match them too.
    for (const [childId, role] of [
      ["framework-isComplete", "fw-is-complete"],
      ["framework-onTimeout", "fw-on-timeout"],
    ] as const) {
      const frameworkFn = provider.node.findChild(
        childId,
      ) as lambda.Function;
      const cfnFn = frameworkFn.node.defaultChild as lambda.CfnFunction;
      cfnFn.addPropertyOverride("FunctionName", lambdaName(role));
    }
    const waiterStateMachine = provider.node
      .findChild("waiter-state-machine")
      .node.findChild("Resource") as cdk.CfnResource;
    waiterStateMachine.addPropertyOverride(
      "StateMachineName",
      provisionedStateMachineName(nameScope, "waiter"),
    );
    const runtimeBoundaryTags = new cdk.CustomResource(
      this,
      "ControlPlaneRuntimePermissionsBoundaryTags",
      {
        serviceToken: provider.serviceToken,
        properties: {
          ResourceType: "ManagedPolicyTags",
          PolicyArn: runtimeBoundary.managedPolicyArn,
          Tags: registryTags,
        },
      },
    );
    runtimeBoundaryTags.node.addDependency(runtimeBoundary);

    const sharedRegistry = new cdk.CustomResource(this, "SharedRegistry", {
      serviceToken: provider.serviceToken,
      properties: {
        ResourceType: "Registry",
        RegistryName: "platform_shared",
        Description:
          "Platform-shared registry for blueprints, shared skills, and A2A agents.",
        Tags: registryTags,
      },
    });

    const domainRegistries = {} as Record<
      ControlPlaneDomainKey,
      cdk.CustomResource
    >;
    const seedRegistryRefs: Record<string, cdk.CustomResource> = {
      shared: sharedRegistry,
    };
    for (const domainKey of CONTROL_PLANE_DOMAIN_KEYS) {
      const resourceConfig = DOMAIN_RESOURCES[domainKey];
      const domain = domainsById.get(resourceConfig.sourceId)!;
      const registry = new cdk.CustomResource(
        this,
        `Registry${resourceConfig.outputName}`,
        {
          serviceToken: provider.serviceToken,
          properties: {
            ResourceType: "Registry",
            RegistryName: resourceConfig.registryName,
            Description: domain.description,
            Tags: registryTags,
          },
        },
      );
      registry.node.addDependency(sharedRegistry);
      domainRegistries[domainKey] = registry;
      seedRegistryRefs[domain.id] = registry;
    }

    for (const seed of canonicalSeeds) {
      const registry = seedRegistryRefs[seed.registryRef];
      if (registry === undefined) {
        throw new Error(`Unknown seed registryRef: ${seed.registryRef}`);
      }

      const record = new cdk.CustomResource(
        this,
        this.recordConstructId(seed),
        {
          serviceToken: provider.serviceToken,
          properties: {
            ResourceType: "RegistryRecord",
            RegistryId: registry.getAttString("RegistryId"),
            RecordName: seed.name,
            DisplayName: seed.displayName,
            RecordType: seed.recordType,
            Descriptors: seed.descriptors,
            RecordVersion: seed.version,
            StatusTarget: seed.status,
            Description: seed.description ?? "",
            Tags: registryTags,
          },
        },
      );
      record.node.addDependency(registry);
    }

    const gatewayTrustConditions = {
      StringEquals: {
        "aws:SourceAccount": account,
      },
      ArnLike: {
        "aws:SourceArn":
          `arn:${partition}:bedrock-agentcore:${region}:${account}:gateway/*`,
      },
    };
    const llmGatewayRole = new iam.Role(this, "LlmGatewayRole", {
      assumedBy: new iam.ServicePrincipal(
        "bedrock-agentcore.amazonaws.com",
        {
          conditions: gatewayTrustConditions,
        },
      ),
      description: "IAM role for the platform LLM Gateway",
    });
    llmGatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-mantle:CreateInference",
          "bedrock-mantle:GetModel",
          "bedrock-mantle:GetProject",
          "bedrock-mantle:ListModels",
        ],
        resources: [
          `arn:${partition}:bedrock-mantle:${region}:${account}:project/default`,
        ],
      }),
    );
    llmGatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-mantle:ListProjects",
          "bedrock-mantle:ListTagsForResource",
        ],
        resources: ["*"],
      }),
    );
    const toolsGatewayRole = new iam.Role(this, "ToolsGatewayRole", {
      assumedBy: new iam.ServicePrincipal(
        "bedrock-agentcore.amazonaws.com",
        {
          conditions: gatewayTrustConditions,
        },
      ),
      description: "IAM role for the platform tools Gateway",
    });

    const llmGateway = new cdk.CfnResource(this, "LlmGateway", {
      type: "AWS::BedrockAgentCore::Gateway",
      properties: {
        Name: gatewayNames.llm,
        Description:
          "Platform LLM Gateway for Bedrock Mantle multi-model inference",
        ProtocolType: "MCP",
        AuthorizerType: "AWS_IAM",
        RoleArn: llmGatewayRole.roleArn,
        Tags: tags,
      },
    });
    const llmGatewayId = cdk.Fn.getAtt(
      llmGateway.logicalId,
      "GatewayIdentifier",
    ).toString();

    const mantleTarget = new cdk.CfnResource(this, "MantleTarget", {
      type: "AWS::BedrockAgentCore::GatewayTarget",
      properties: {
        GatewayIdentifier: llmGatewayId,
        Name: "bedrock-mantle",
        Description:
          "Amazon Bedrock Mantle inference connector for multiple models",
        TargetConfiguration: {
          Inference: {
            Connector: {
              Source: {
                ConnectorId: "bedrock-mantle",
              },
            },
          },
        },
        CredentialProviderConfigurations: [
          {
            CredentialProviderType: "GATEWAY_IAM_ROLE",
          },
        ],
      },
    });
    mantleTarget.addResourceDependency(llmGateway);
    this.createClaudeProviderTarget(llmGatewayId, region, llmGateway);

    const toolsGateway = new cdk.CfnResource(this, "ToolsGateway", {
      type: "AWS::BedrockAgentCore::Gateway",
      properties: {
        Name: gatewayNames.tools,
        Description: "Platform MCP tools gateway",
        ProtocolType: "MCP",
        AuthorizerType: "AWS_IAM",
        RoleArn: toolsGatewayRole.roleArn,
        Tags: tags,
      },
    });
    const toolsGatewayId = cdk.Fn.getAtt(
      toolsGateway.logicalId,
      "GatewayIdentifier",
    ).toString();

    const awsDocsTarget = new cdk.CfnResource(this, "AwsDocsTarget", {
      type: "AWS::BedrockAgentCore::GatewayTarget",
      properties: {
        GatewayIdentifier: toolsGatewayId,
        Name: "aws-docs",
        Description: "AWS Knowledge MCP server",
        TargetConfiguration: {
          Mcp: {
            McpServer: {
              Endpoint: "https://knowledge-mcp.global.api.aws",
            },
          },
        },
      },
    });
    awsDocsTarget.addResourceDependency(toolsGateway);

    return {
      sharedRegistryId: sharedRegistry.getAttString("RegistryId"),
      sharedRegistryArn: sharedRegistry.getAttString("RegistryArn"),
      domainRegistryIds: {
        platform:
          domainRegistries.platform.getAttString("RegistryId"),
        customer_support:
          domainRegistries.customer_support.getAttString("RegistryId"),
        operations:
          domainRegistries.operations.getAttString("RegistryId"),
      },
      domainRegistryArns: {
        platform:
          domainRegistries.platform.getAttString("RegistryArn"),
        customer_support:
          domainRegistries.customer_support.getAttString("RegistryArn"),
        operations:
          domainRegistries.operations.getAttString("RegistryArn"),
      },
      llmGatewayId,
      llmGatewayRegion: region,
      llmGatewayArn:
        `arn:${partition}:bedrock-agentcore:${region}:${account}:gateway/${llmGatewayId}`,
      llmGatewayUrl:
        `https://${llmGatewayId}.gateway.bedrock-agentcore.${region}.${this.urlSuffix}/inference/v1`,
      toolsGatewayId,
      toolsGatewayArn:
        `arn:${partition}:bedrock-agentcore:${region}:${account}:gateway/${toolsGatewayId}`,
      toolsGatewayUrl:
        `https://${toolsGatewayId}.gateway.bedrock-agentcore.${region}.${this.urlSuffix}/mcp`,
    };
  }

  private createClaudeProviderTarget(
    gatewayIdentifier: string,
    region: string,
    gateway?: cdk.CfnResource,
  ): cdk.CfnResource {
    const target = new cdk.CfnResource(
      this,
      "ClaudeProviderTarget",
      {
        type: "AWS::BedrockAgentCore::GatewayTarget",
        properties: {
          GatewayIdentifier: gatewayIdentifier,
          Name: "bedrock-claude",
          Description:
            "Claude Messages inference provider in the Gateway region",
          TargetConfiguration: {
            Inference: {
              Provider: {
                Endpoint: `https://bedrock-mantle.${region}.api.aws`,
                ModelMapping: {
                  ProviderPrefix: {
                    Separator: ".",
                    Strip: true,
                  },
                },
                Operations: [
                  {
                    Models: [{ Model: "anthropic.claude-*" }],
                    Path: "/v1/messages",
                    ProviderPath: "/anthropic/v1/messages",
                  },
                ],
              },
            },
          },
          CredentialProviderConfigurations: [
            {
              CredentialProviderType: "GATEWAY_IAM_ROLE",
            },
          ],
        },
      },
    );
    if (gateway !== undefined) {
      target.addResourceDependency(gateway);
    }
    return target;
  }

  private createOutputs(
    resources: ControlPlaneResources,
    region: string,
    configParameterName: string,
  ): void {
    this.createOutput(
      "SharedRegistryId",
      resources.sharedRegistryId,
      "Platform shared registry ID",
      `${CONTROL_PLANE_STACK_NAME}-SharedRegistryId`,
    );
    this.createOutput(
      "SharedRegistryArn",
      resources.sharedRegistryArn,
      "Platform shared registry ARN",
      `${CONTROL_PLANE_STACK_NAME}-SharedRegistryArn`,
    );

    for (const domainKey of CONTROL_PLANE_DOMAIN_KEYS) {
      const domainResource = DOMAIN_RESOURCES[domainKey];
      const outputName = domainResource.outputName;
      this.createOutput(
        `Registry${outputName}Id`,
        resources.domainRegistryIds[domainKey],
        `Domain registry ID: ${domainKey}`,
        `${CONTROL_PLANE_STACK_NAME}-Registry-${domainResource.exportName}-Id`,
      );
      this.createOutput(
        `Registry${outputName}Arn`,
        resources.domainRegistryArns[domainKey],
        `Domain registry ARN: ${domainKey}`,
        `${CONTROL_PLANE_STACK_NAME}-Registry-${domainResource.exportName}-Arn`,
      );
    }

    this.createOutput(
      "LlmGatewayId",
      resources.llmGatewayId,
      "Platform LLM Gateway ID",
      `${CONTROL_PLANE_STACK_NAME}-LlmGatewayId`,
    );
    this.createOutput(
      "LlmGatewayArn",
      resources.llmGatewayArn,
      "Platform LLM Gateway ARN",
      `${CONTROL_PLANE_STACK_NAME}-LlmGatewayArn`,
    );
    this.createOutput(
      "LlmGatewayUrl",
      resources.llmGatewayUrl,
      "Platform LLM Gateway inference URL",
      `${CONTROL_PLANE_STACK_NAME}-LlmGatewayUrl`,
    );
    this.createOutput(
      "LlmGatewayRegion",
      resources.llmGatewayRegion,
      "Platform LLM Gateway AWS region",
      `${CONTROL_PLANE_STACK_NAME}-LlmGatewayRegion`,
    );
    this.createOutput(
      "ToolsGatewayId",
      resources.toolsGatewayId,
      "Platform Tools Gateway ID",
      `${CONTROL_PLANE_STACK_NAME}-ToolsGatewayId`,
    );
    this.createOutput(
      "ToolsGatewayArn",
      resources.toolsGatewayArn,
      "Platform Tools Gateway ARN",
      `${CONTROL_PLANE_STACK_NAME}-ToolsGatewayArn`,
    );
    this.createOutput(
      "ToolsGatewayUrl",
      resources.toolsGatewayUrl,
      "Platform Tools Gateway MCP URL",
      `${CONTROL_PLANE_STACK_NAME}-ToolsGatewayUrl`,
    );
    this.createOutput(
      "Region",
      region,
      "Control-plane AWS region",
      `${CONTROL_PLANE_STACK_NAME}-Region`,
    );
    this.createOutput(
      "ControlPlaneConfigParameterName",
      configParameterName,
      "SSM parameter containing the resolved control-plane configuration",
      `${CONTROL_PLANE_STACK_NAME}-ConfigParameterName`,
    );
  }

  private createOutput(
    id: string,
    value: string,
    description: string,
    exportName: string,
  ): void {
    new cdk.CfnOutput(this, id, {
      value,
      description,
      exportName,
    });
  }

  private safeConstructId(value: string): string {
    const safe = value.replace(/[^A-Za-z0-9]/g, "");
    return safe.length > 0 ? safe : "Record";
  }

  private validateAndCanonicalizeSeeds(
    seeds: SeedRecord[],
  ): SeedRecord[] {
    const validRegistryRefs = new Set([
      "shared",
      ...Object.values(DOMAIN_RESOURCES).map(
        (resource) => resource.sourceId,
      ),
    ]);
    const identities = new Set<string>();
    const logicalOwners = new Map<string, string>();
    const nameOwners = new Map<string, string>();

    return seeds.map((seed) => {
      if (!validRegistryRefs.has(seed.registryRef)) {
        throw new Error(`Unknown seed registryRef: ${seed.registryRef}`);
      }
      const canonicalName = canonicalizeSeedRecordName(seed.name);
      const identity =
        `${seed.registryRef}/${canonicalName}@${seed.version}`;
      if (identities.has(identity)) {
        throw new Error(
          `Duplicate canonical seed record identity: ${identity}`,
        );
      }
      identities.add(identity);
      const metadata = this.validateGovernedSeed(seed);
      const logicalIdentity = [
        metadata.domainId,
        metadata.resourceType,
        metadata.resourceId,
      ].join("/");
      const nameIdentity = `${seed.registryRef}/${canonicalName}`;
      const existingLogicalIdentity = nameOwners.get(nameIdentity);
      if (
        existingLogicalIdentity !== undefined
        && existingLogicalIdentity !== logicalIdentity
      ) {
        throw new Error(
          `Governed seed name identity drift: ${nameIdentity}`,
        );
      }
      nameOwners.set(nameIdentity, logicalIdentity);
      const existingName = logicalOwners.get(logicalIdentity);
      if (
        existingName !== undefined
        && existingName !== canonicalName
      ) {
        throw new Error(
          `Duplicate governed seed logical identity: ${logicalIdentity}`,
        );
      }
      logicalOwners.set(logicalIdentity, canonicalName);
      return {
        ...seed,
        name: canonicalName,
      };
    });
  }

  private validateGovernedSeed(
    seed: SeedRecord,
  ): GovernedDescriptorMetadata {
    if (!hasGovernedRecordVersion(seed.version)) {
      throw new Error("Governed seed record version is malformed.");
    }
    const descriptor = seed.recordType === "AGENT"
      ? seed.descriptors?.a2aAgentCard?.data
      : seed.recordType === "SKILL"
        ? seed.descriptors?.agentSkillsDefinition?.data
        : seed.descriptors?.custom?.data;
    if (typeof descriptor !== "string" || descriptor.length === 0) {
      throw new Error("Governed seed descriptor is malformed.");
    }
    let document: unknown;
    try {
      document = JSON.parse(descriptor);
    } catch {
      throw new Error("Governed seed descriptor is malformed.");
    }
    if (!isPlainObject(document) || document.schemaVersion !== 1) {
      throw new Error("Governed seed descriptor is malformed.");
    }
    const metadata = document["x-platform"];
    const expectedResourceType: GovernedResourceType =
      seed.recordType === "AGENT"
        ? "AGENT"
        : seed.recordType === "SKILL"
          ? "SKILL"
          : "BLUEPRINT";
    const expectedResourceKind = expectedResourceType.toLowerCase();
    if (
      !isPlainObject(metadata)
      || Object.keys(metadata).sort().join("\u0000")
        !== [...GOVERNED_X_PLATFORM_KEYS].sort().join("\u0000")
      || metadata.domainId !== governedDomainId(seed.registryRef)
      || !OWNER_SUBJECT_PATTERN.test(String(metadata.ownerSubject ?? ""))
      || !RESOURCE_ID_PATTERN.test(String(metadata.resourceId ?? ""))
      || metadata.resourceType !== expectedResourceType
      || metadata.shared !== (seed.registryRef === "shared")
      || document.resourceKind !== expectedResourceKind
    ) {
      throw new Error("Governed seed descriptor is malformed.");
    }
    return metadata as unknown as GovernedDescriptorMetadata;
  }

  private recordConstructId(seed: SeedRecord): string {
    const identity = `${seed.registryRef}/${seed.name}@${seed.version}`;
    const readable = this.safeConstructId(identity).slice(0, 48);
    const hash = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 12);
    return `Record${readable}${hash}`;
  }
}
