import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import runtimePermissionsBoundary from
  "../config/runtime-permissions-boundary.json";

export const REQUIRED_TAGS = {
  "auto-delete": "no",
  project: "agentic-ai-platform-demo",
  managedBy: "cdk",
} as const;

export const DEFAULT_REGION = "us-west-2";
export const PLATFORM_WEB_STACK_NAME = "AgenticPlatform-Web";
const CLOUDFRONT_ALARM_NAME_PREFIX =
  `PlatformWeb-${PLATFORM_WEB_STACK_NAME}-`;
const CLOUDFRONT_ALARM_NAME_SUFFIX = "-CloudFront-5xx";
export const CLOUDFRONT_ALARM_NAME_PATTERN =
  `${CLOUDFRONT_ALARM_NAME_PREFIX}*${CLOUDFRONT_ALARM_NAME_SUFFIX}`;
export const PLATFORM_WEB_ROLE_PREFIX = "AgenticPlatform-Web-";
export const HOSTED_ACCEPTANCE_ROLE_NAME =
  `${PLATFORM_WEB_ROLE_PREFIX}HostedAcceptanceRole`;
export const PLATFORM_WEB_RUNTIME_ROLE_NAMES = {
  accessAdminApi: `${PLATFORM_WEB_ROLE_PREFIX}AccessAdminApiRole`,
  agentRuntime: `${PLATFORM_WEB_ROLE_PREFIX}AgentRuntimeRole`,
  builderApi: `${PLATFORM_WEB_ROLE_PREFIX}BuilderApiRole`,
  cloudFrontAlarmProvider:
    `${PLATFORM_WEB_ROLE_PREFIX}CloudFrontAlarmProviderRole`,
  cloudFrontInvalidationProvider:
    `${PLATFORM_WEB_ROLE_PREFIX}CloudFrontInvalidationProviderRole`,
  controlPlaneReadApi:
    `${PLATFORM_WEB_ROLE_PREFIX}ControlPlaneReadApiRole`,
  deploymentApi: `${PLATFORM_WEB_ROLE_PREFIX}DeploymentApiRole`,
  experienceApi: `${PLATFORM_WEB_ROLE_PREFIX}ExperienceApiRole`,
  frontendDeployment: `${PLATFORM_WEB_ROLE_PREFIX}FrontendDeploymentRole`,
  governanceApi: `${PLATFORM_WEB_ROLE_PREFIX}GovernanceApiRole`,
  gatewayInvoker: `${PLATFORM_WEB_ROLE_PREFIX}GatewayInvokerRole`,
  hostedAcceptanceBroker:
    `${PLATFORM_WEB_ROLE_PREFIX}HostedAcceptanceBrokerRole`,
  identityApi: `${PLATFORM_WEB_ROLE_PREFIX}IdentityApiRole`,
  journeyApi: `${PLATFORM_WEB_ROLE_PREFIX}JourneyApiRole`,
  modelGovernanceApi:
    `${PLATFORM_WEB_ROLE_PREFIX}ModelGovernanceApiRole`,
  operationsApi: `${PLATFORM_WEB_ROLE_PREFIX}OperationsApiRole`,
  platformAdminApi: `${PLATFORM_WEB_ROLE_PREFIX}PlatformAdminApiRole`,
  platformAgentRegistrySeed:
    `${PLATFORM_WEB_ROLE_PREFIX}PlatformAgentRegistrySeedRole`,
  registryDecisionFinalizer:
    `${PLATFORM_WEB_ROLE_PREFIX}RegistryDecisionFinalizerRole`,
  platformStateSeed:
    `${PLATFORM_WEB_ROLE_PREFIX}PlatformStateSeedRole`,
  platformWorkspaceSeed:
    `${PLATFORM_WEB_ROLE_PREFIX}PlatformWorkspaceSeedRole`,
  runtimeBoundaryTagProvider:
    `${PLATFORM_WEB_ROLE_PREFIX}RuntimeBoundaryTagProviderRole`,
  runtimeProofConfigurator:
    `${PLATFORM_WEB_ROLE_PREFIX}RuntimeProofConfiguratorRole`,
  runtimeProofProvider:
    `${PLATFORM_WEB_ROLE_PREFIX}RuntimeProofProviderRole`,
  workspaceApi: `${PLATFORM_WEB_ROLE_PREFIX}WorkspaceApiRole`,
} as const;
export const RUNTIME_PERMISSIONS_BOUNDARY_NAME =
  "AgenticPlatform-Web-RuntimePermissionsBoundary";
export const CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME =
  "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary";

// Opt-in source policy only; exact SYSTEM_DEFINED profile/backing-model
// metadata captured in us-west-2. This does not establish account entitlement.
export function bedrockRuntimeResources(
  profiles: string[],
  { partition, account, region }: { partition: string; account: string; region: string },
): string[] {
  const supported = [
    "global.anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "global.openai.gpt-6-astra", "us.openai.gpt-6-astra",
    "global.moonshotai.kimi-k3", "us.moonshotai.kimi-k3",
  ];
  if (!Array.isArray(profiles) || new Set(profiles).size !== profiles.length
    || profiles.some(profile => !supported.includes(profile))
    || (profiles.length > 0 && ((partition !== "aws" && !cdk.Token.isUnresolved(partition)) || region !== "us-west-2"))) {
    throw new Error("Bedrock Runtime inference profiles are invalid.");
  }
  return [...new Set(profiles.flatMap(profile => {
    const model = profile.slice(profile.indexOf(".") + 1);
    const regions = profile.startsWith("global.") ? ["", "us-west-2"] : ["us-east-1", "us-east-2", "us-west-2"];
    return [
      `arn:${partition}:bedrock:${region}:${account}:inference-profile/${profile}`,
      ...regions.map(targetRegion => `arn:${partition}:bedrock:${targetRegion}::foundation-model/${model}`),
    ];
  }))];
}

export function bedrockConsumerBoundary(
  existing: Record<string, any>,
  modelArns: string[],
): Record<string, any> {
  // Restrict the existing shared ceiling to the two consumers' actions. Do not
  // merge InvokeModel into a wildcard-resource statement to fit the IAM limit.
  const actions = new Set([
    "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups",
    "s3:GetObject*", "s3:GetBucket*", "s3:List*",
    "xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets",
    "cloudwatch:PutMetricData", "secretsmanager:GetSecretValue",
    "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query",
    "agent-registry:ListRegistryRecords", "agent-registry:GetDiscoverableRegistryRecord", "agent-registry:GetRegistryRecord",
    "bedrock-agentcore:GetGatewayTarget", "bedrock-agentcore:ListGatewayTargets",
    "bedrock-agentcore:GetWorkloadAccessToken*",
    "cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser",
    "sts:AssumeRole", "sts:SetSourceIdentity",
  ]);
  return {
    Version: existing.Version,
    Statement: [
      ...existing.Statement.map((statement: Record<string, any>) => ({
        ...statement, Action: [statement.Action].flat().filter(action => actions.has(action)),
      })).filter((statement: Record<string, any>) => statement.Action.length > 0),
      { Effect: "Allow", Action: "bedrock:InvokeModel", Resource: modelArns },
    ],
  };
}

export function cloudFrontAlarmName(distributionId: string): string {
  return `${CLOUDFRONT_ALARM_NAME_PREFIX}${distributionId}`
    + CLOUDFRONT_ALARM_NAME_SUFFIX;
}

export type GitHubOidcSubjectMode = "legacy" | "immutable";

export interface GitHubDeploymentMetadata {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  workflowRef: string;
  githubOidcSubjectMode: GitHubOidcSubjectMode;
  githubOidcSubject: string;
}

export type ContextSource = Record<string, unknown>;

export function contextValue(
  source: ContextSource,
  key: string,
  fallback?: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function contextFlag(source: ContextSource, key: string): boolean {
  const value = source[key];
  return value === true || value === "true";
}

export function requiredContext(source: ContextSource, key: string): string {
  const value = contextValue(source, key);
  if (!value) {
    throw new Error(`Missing required CDK context: ${key}`);
  }
  return value;
}

export function validateGitHubDeploymentMetadata(
  metadata: GitHubDeploymentMetadata,
): GitHubDeploymentMetadata {
  for (const key of [
    "repository",
    "repositoryId",
    "repositoryOwnerId",
    "workflowRef",
    "githubOidcSubjectMode",
    "githubOidcSubject",
  ] as const) {
    if (
      typeof metadata[key] !== "string"
      || !metadata[key].trim()
    ) {
      throw new Error(`GitHub deployment requires ${key}.`);
    }
  }
  if (!/^[1-9][0-9]*$/.test(metadata.repositoryId)) {
    throw new Error("repositoryId must be a positive numeric GitHub ID.");
  }
  if (!/^[1-9][0-9]*$/.test(metadata.repositoryOwnerId)) {
    throw new Error(
      "repositoryOwnerId must be a positive numeric GitHub owner ID.",
    );
  }
  const [owner, repositoryName, ...extra] = metadata.repository.split("/");
  if (!owner || !repositoryName || extra.length > 0) {
    throw new Error("repository must be an exact GitHub owner/repository.");
  }
  const expectedWorkflowRef =
    `${metadata.repository}/.github/workflows/`
    + "deploy-serverless-platform.yml@refs/heads/main";
  if (metadata.workflowRef !== expectedWorkflowRef) {
    throw new Error(
      `workflowRef must equal ${expectedWorkflowRef}.`,
    );
  }
  if (
    metadata.githubOidcSubjectMode !== "legacy"
    && metadata.githubOidcSubjectMode !== "immutable"
  ) {
    throw new Error(
      "GitHub OIDC subject mode must be legacy or immutable.",
    );
  }
  const expectedSubject = metadata.githubOidcSubjectMode === "legacy"
    ? `repo:${metadata.repository}:ref:refs/heads/main`
    : `repo:${owner}@${metadata.repositoryOwnerId}/`
      + `${repositoryName}@${metadata.repositoryId}:ref:refs/heads/main`;
  if (metadata.githubOidcSubject !== expectedSubject) {
    throw new Error(
      `GitHub OIDC subject does not match declared `
        + `${metadata.githubOidcSubjectMode} mode.`,
    );
  }
  return metadata;
}

export function runtimePermissionsBoundaryDocument({
  account,
  agentRuntimeArn,
  agentRuntimeEndpointArnPattern,
  cloudFrontAlarmArnPattern,
  cloudFrontDistributionArn,
  customerSupportRegistryArn,
  gatewayInvokerRoleArn,
  journeyGithubOAuthClientSecretArn,
  journeyInceptionModelArns,
  llmGatewayArn,
  operationsRegistryArn,
  partition,
  platformStateTableArn,
  platformRegistryArn,
  qualifier,
  registryDecisionFinalizerFunctionArn,
  region,
  runtimeProofConfiguratorFunctionArn,
  runtimeProofConfiguratorRoleArn,
  runtimeInvocationProofSecretArn,
  runtimePermissionsBoundaryArn,
  sharedRegistryArn,
  toolsGatewayArn,
  userPoolArn,
}: {
  account: string;
  agentRuntimeArn: string;
  agentRuntimeEndpointArnPattern: string;
  cloudFrontAlarmArnPattern: string;
  cloudFrontDistributionArn: string;
  customerSupportRegistryArn: string;
  gatewayInvokerRoleArn: string;
  journeyGithubOAuthClientSecretArn?: string;
  journeyInceptionModelArns: string[];
  llmGatewayArn: string;
  operationsRegistryArn: string;
  partition: string;
  platformStateTableArn: string;
  platformRegistryArn: string;
  qualifier: string;
  registryDecisionFinalizerFunctionArn: string;
  region: string;
  runtimeProofConfiguratorFunctionArn: string;
  runtimeProofConfiguratorRoleArn: string;
  runtimeInvocationProofSecretArn: string;
  runtimePermissionsBoundaryArn: string;
  sharedRegistryArn: string;
  toolsGatewayArn: string;
  userPoolArn: string;
}): Record<string, unknown> {
  type BoundaryStatement = {
    Sid?: string;
    Effect: string;
    Action: string[];
    Resource: unknown[];
    Condition?: Record<string, any>;
  };

  function render(value: unknown): unknown {
    if (typeof value === "string") {
      return value
        .replaceAll("${ACCOUNT}", account)
        .replaceAll("${AGENT_RUNTIME_ARN}", agentRuntimeArn)
        .replaceAll(
          "${AGENT_RUNTIME_ENDPOINT_ARN_PATTERN}",
          agentRuntimeEndpointArnPattern,
        )
        .replaceAll(
          "${CLOUDFRONT_ALARM_ARN_PATTERN}",
          cloudFrontAlarmArnPattern,
        )
        .replaceAll(
          "${CLOUDFRONT_DISTRIBUTION_ARN}",
          cloudFrontDistributionArn,
        )
        .replaceAll(
          "${CUSTOMER_SUPPORT_REGISTRY_ARN}",
          customerSupportRegistryArn,
        )
        .replaceAll(
          "${GATEWAY_INVOKER_ROLE_ARN}",
          gatewayInvokerRoleArn,
        )
        .replaceAll(
          "${JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN}",
          journeyGithubOAuthClientSecretArn ?? "",
        )
        .replaceAll(
          "${JOURNEY_INCEPTION_MODEL_ARN}",
          journeyInceptionModelArns[0] ?? "",
        )
        .replaceAll("${LLM_GATEWAY_ARN}", llmGatewayArn)
        .replaceAll(
          "${OPERATIONS_REGISTRY_ARN}",
          operationsRegistryArn,
        )
        .replaceAll("${PARTITION}", partition)
        .replaceAll("${PLATFORM_STATE_TABLE_ARN}", platformStateTableArn)
        .replaceAll("${PLATFORM_REGISTRY_ARN}", platformRegistryArn)
        .replaceAll("${QUALIFIER}", qualifier)
        .replaceAll(
          "${REGISTRY_DECISION_FINALIZER_FUNCTION_ARN}",
          registryDecisionFinalizerFunctionArn,
        )
        .replaceAll("${REGION}", region)
        .replaceAll(
          "${RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN}",
          runtimeProofConfiguratorFunctionArn,
        )
        .replaceAll(
          "${RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN}",
          runtimeProofConfiguratorRoleArn,
        )
        .replaceAll(
          "${RUNTIME_INVOCATION_PROOF_SECRET_ARN}",
          runtimeInvocationProofSecretArn,
        )
        .replaceAll(
          "${RUNTIME_PERMISSIONS_BOUNDARY_ARN}",
          runtimePermissionsBoundaryArn,
        )
        .replaceAll("${SHARED_REGISTRY_ARN}", sharedRegistryArn)
        .replaceAll("${TOOLS_GATEWAY_ARN}", toolsGatewayArn)
        .replaceAll("${USER_POOL_ARN}", userPoolArn);
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
  }

  const rendered = render(runtimePermissionsBoundary) as {
    Version: string;
    Statement: BoundaryStatement[];
  };
  const statements = structuredClone(rendered.Statement);
  const bySid = (sid: string): BoundaryStatement | undefined =>
    statements.find((statement) => statement.Sid === sid);
  const remove = (...sids: string[]): void => {
    const removed = new Set(sids);
    for (let index = statements.length - 1; index >= 0; index -= 1) {
      const sid = statements[index].Sid;
      if (sid && removed.has(sid)) {
        statements.splice(index, 1);
      }
    }
  };
  if (!journeyGithubOAuthClientSecretArn) {
    remove("ReadJourneyGitHubOAuthClientSecret");
  }
  const journeyInception = bySid("InvokeJourneyInceptionModel");
  if (journeyInceptionModelArns.length === 0) {
    remove("InvokeJourneyInceptionModel");
  } else if (!journeyInception) {
    throw new Error("Journey inception model boundary is missing.");
  } else {
    journeyInception.Resource = [...journeyInceptionModelArns];
  }
  const merge = (targetSid: string, sourceSids: string[]): void => {
    const target = bySid(targetSid);
    if (!target) {
      return;
    }
    for (const sourceSid of sourceSids) {
      const source = bySid(sourceSid);
      if (!source) {
        continue;
      }
      if (
        target.Effect !== source.Effect
        || JSON.stringify(target.Condition ?? null)
          !== JSON.stringify(source.Condition ?? null)
      ) {
        throw new Error(
          `${targetSid} and ${sourceSid} must have identical conditions.`,
        );
      }
      target.Action = [...new Set([...target.Action, ...source.Action])];
      target.Resource = [
        ...new Set([...target.Resource, ...source.Resource]),
      ];
      remove(sourceSid);
    }
  };
  const allowManagedByValues = (
    targetSid: string,
    sourceSid: string,
  ): void => {
    const target = bySid(targetSid);
    const source = bySid(sourceSid);
    if (!target || !source) {
      return;
    }
    const targetValue =
      target.Condition?.StringEquals?.["aws:RequestTag/managedBy"];
    const sourceValue =
      source.Condition?.StringEquals?.["aws:RequestTag/managedBy"];
    if (typeof targetValue !== "string" || typeof sourceValue !== "string") {
      throw new Error(
        `${targetSid} and ${sourceSid} must declare managedBy conditions.`,
      );
    }
    target.Condition!.StringEquals["aws:RequestTag/managedBy"] = [
      targetValue,
      sourceValue,
    ];
    remove(sourceSid);
  };

  allowManagedByValues(
    "CreatePlatformDomainRegistry",
    "CreateHostedAcceptanceDomainRegistry",
  );
  allowManagedByValues(
    "TagPlatformDomainRegistry",
    "TagHostedAcceptanceDomainRegistry",
  );

  const listControlPlaneRegistries = bySid("ListControlPlaneRegistries");
  const tagPlatformDomainRegistry = bySid("TagPlatformDomainRegistry");
  if (listControlPlaneRegistries && tagPlatformDomainRegistry) {
    listControlPlaneRegistries.Resource = [
      tagPlatformDomainRegistry.Resource[0],
    ];
  }
  const readControlPlaneRegistryRecords = bySid(
    "ReadControlPlaneRegistryRecords",
  );
  const readDynamicControlPlaneRegistryRecords = bySid(
    "ReadDynamicControlPlaneRegistryRecords",
  );
  if (
    readControlPlaneRegistryRecords
    && readDynamicControlPlaneRegistryRecords
  ) {
    readControlPlaneRegistryRecords.Resource = [
      readDynamicControlPlaneRegistryRecords.Resource[0],
    ];
  }

  const readAgentRuntimeWorkloadIdentity = bySid(
    "ReadAgentRuntimeWorkloadIdentity",
  );
  if (readAgentRuntimeWorkloadIdentity) {
    readAgentRuntimeWorkloadIdentity.Action = [
      "bedrock-agentcore:GetWorkloadAccessToken*",
    ];
    readAgentRuntimeWorkloadIdentity.Resource = [
      [...readAgentRuntimeWorkloadIdentity.Resource].sort(
        (left, right) =>
          JSON.stringify(left).length - JSON.stringify(right).length,
      )[0],
    ];
  }
  const currentDemoOperator = bySid("ReadCurrentDemoOperator");
  if (currentDemoOperator) {
    currentDemoOperator.Action = [
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListGroupsForUser",
      "cognito-idp:AdminRemoveUserFromGroup",
      "cognito-idp:CreateGroup",
      "cognito-idp:DeleteGroup",
      "cognito-idp:GetGroup",
      "cognito-idp:ListUsers",
      "cognito-idp:ListUsersInGroup",
    ];
  }
  const readGovernedAgentRuntime = bySid("ReadGovernedAgentRuntime");
  const readGovernedAgentRuntimeEndpoints = bySid(
    "ReadGovernedAgentRuntimeEndpoints",
  );
  if (readGovernedAgentRuntime && readGovernedAgentRuntimeEndpoints) {
    readGovernedAgentRuntime.Action = [
      "bedrock-agentcore:GetAgentRuntime*",
    ];
    readGovernedAgentRuntime.Resource = [
      ...readGovernedAgentRuntime.Resource,
      ...readGovernedAgentRuntimeEndpoints.Resource,
    ];
    remove("ReadGovernedAgentRuntimeEndpoints");
  }
  const invokeGovernedAgentRuntime = bySid(
    "InvokeGovernedAgentRuntime",
  );
  if (invokeGovernedAgentRuntime) {
    invokeGovernedAgentRuntime.Action = [
      "bedrock-agentcore:InvokeAgentRuntime*",
    ];
  }

  merge(
    "CreateHostedAcceptanceFixtureRecord",
    ["TagHostedAcceptanceFixtureRecord"],
  );
  allowManagedByValues(
    "CreateGovernedRegistryRecords",
    "CreateHostedAcceptanceFixtureRecord",
  );
  const governedRegistryCreate = bySid(
    "CreateGovernedRegistryRecords",
  );
  if (governedRegistryCreate?.Condition?.StringEquals) {
    delete governedRegistryCreate.Condition.StringEquals[
      "aws:RequestedRegion"
    ];
  }
  merge(
    "CreateGovernedRegistryRecords",
    ["TagPlatformDomainRegistry"],
  );
  merge(
    "ReadHostedAcceptanceFixtureRecord",
    ["ReadHostedAcceptanceDomainRegistry"],
  );
  // IAM wildcards cross "/": registry/* already matches every
  // registry/<id>/record/<id>, so any record ARN riding along in this
  // conditionless read is redundant with the registry wildcard it merged in.
  const hostedAcceptanceReads = bySid("ReadHostedAcceptanceFixtureRecord");
  if (hostedAcceptanceReads) {
    const registryWildcardArn =
      `arn:${partition}:agent-registry:${region}:${account}:registry/*`;
    if (hostedAcceptanceReads.Resource.includes(registryWildcardArn)) {
      hostedAcceptanceReads.Resource = hostedAcceptanceReads.Resource.filter(
        (resource) =>
          resource === registryWildcardArn
          || typeof resource !== "string"
          || !resource.startsWith(
            registryWildcardArn.slice(0, -1),
          ),
      );
    }
  }
  const dynamicRegistryAccess = bySid(
    "ListDynamicControlPlaneRegistries",
  );
  const governedRegistryMutation = bySid(
    "MutateGovernedRegistryRecords",
  );
  if (dynamicRegistryAccess && governedRegistryMutation) {
    dynamicRegistryAccess.Action = [
      ...new Set([
        ...dynamicRegistryAccess.Action,
        ...governedRegistryMutation.Action,
      ]),
    ];
    remove("MutateGovernedRegistryRecords");
  }
  merge(
    "ListDynamicControlPlaneRegistries",
    [
      "ReadDynamicControlPlaneRegistryRecords",
      "DeleteHostedAcceptanceDomainRegistry",
    ],
  );
  if (
    dynamicRegistryAccess
    && listControlPlaneRegistries
    && readControlPlaneRegistryRecords
  ) {
    const conditionlessRegistryActions = new Set([
      ...listControlPlaneRegistries.Action,
      ...readControlPlaneRegistryRecords.Action,
    ]);
    dynamicRegistryAccess.Action = dynamicRegistryAccess.Action.filter(
      (action) => !conditionlessRegistryActions.has(action),
    );
    const registryWildcard =
      `arn:${partition}:agent-registry:${region}:${account}:registry/*`;
    const registryRecordWildcard = `${registryWildcard}/record/*`;
    if (
      dynamicRegistryAccess.Resource.includes(registryWildcard)
      && dynamicRegistryAccess.Resource.includes(registryRecordWildcard)
    ) {
      dynamicRegistryAccess.Resource =
        dynamicRegistryAccess.Resource.filter(
          (resource) => resource !== registryRecordWildcard,
        );
    }
  }
  merge("ReadPlatformState", ["WritePlatformState"]);
  merge(
    "WriteXRayTelemetry",
    ["ReadAgentRuntimeMetrics", "InvokeJourneyInceptionModel"],
  );
  merge(
    "ReadRuntimeInvocationProofSecret",
    ["ReadJourneyGitHubOAuthClientSecret"],
  );
  const telemetry = bySid("WriteXRayTelemetry");
  if (telemetry) {
    telemetry.Resource = ["*"];
    // Compact read-only memory and knowledge-base actions into shorter wildcards
    // to stay within IAM's 6,144-byte managed-policy size limit.
    const memoryActions = [
      "bedrock-agentcore:GetMemory",
      "bedrock-agentcore:ListMemories",
    ];
    if (memoryActions.every((a) => telemetry.Action.includes(a))) {
      telemetry.Action = telemetry.Action.filter(
        (a) => !memoryActions.includes(a),
      );
      telemetry.Action.push("bedrock-agentcore:*Mem*");
    }
    const kbActionIndex = telemetry.Action.indexOf("bedrock:GetKnowledgeBase");
    if (kbActionIndex !== -1) {
      telemetry.Action[kbActionIndex] = "bedrock:GetKnow*";
    }
  }
  for (const sid of [
    "ReadPlatformState",
    "ReadDeleteHostedAcceptanceState",
    "UpdateExperienceInvocation",
    "ReadHitlPolicyCatalog",
  ]) {
    const statement = bySid(sid);
    if (statement) {
      delete statement.Condition;
    }
  }
  // ReadHitlPolicyCatalog folds away entirely: once conditions are dropped,
  // ReadPlatformState already ceilings GetItem on the same table. The HITL
  // partition scoping stays enforced by the governance role's identity policy.
  merge("ReadPlatformState", [
    "UpdateExperienceInvocation",
    "ReadHitlPolicyCatalog",
  ]);

  const cdkAssets = bySid("ReadCdkAssets");
  const webAssets = bySid("DeployWebAssets");
  if (cdkAssets && webAssets) {
    const cdkBucketArn = cdkAssets.Resource.find(
      (resource) =>
        typeof resource === "string"
        && cdkAssets.Resource.includes(`${resource}/*`),
    );
    if (typeof cdkBucketArn !== "string") {
      throw new Error("CDK asset boundary resources are inconsistent.");
    }
    cdkAssets.Resource = [`${cdkBucketArn}*`];
    webAssets.Resource = [[...webAssets.Resource].sort(
      (left, right) =>
        JSON.stringify(left).length - JSON.stringify(right).length,
    )[0]];
    cdkAssets.Resource = [...cdkAssets.Resource, ...webAssets.Resource];
    const readActions = new Set(cdkAssets.Action);
    webAssets.Action = webAssets.Action.filter(
      (action) => !readActions.has(action),
    );
  }

  merge(
    "WritePlatformLogs",
    [
      "ReadControlPlaneToolsGateway",
      "ManageRegistryWorkloadIdentity",
      "AssumeGatewayInvokerRole",
      "InvokeRegistryDecisionFinalizer",
      "ReadWritePlatformState",
      "ReadDeleteHostedAcceptanceState",
      "ReadCdkAssets",
      "InvalidateCloudFront",
      "ReconcileCloudFrontAlarm",
      "ReconcileRuntimeBoundaryTags",
      "WriteAgentRuntimeLogs",
      "DescribeAgentRuntimeLogs",
      "ReadAgentRuntimeWorkloadIdentity",
      "ReadGovernedAgentRuntime",
      "InvokeGovernedAgentRuntime",
      "ManageControlPlaneLlmGatewayRateLimits",
      "ReadCurrentDemoOperator",
      "ReadPlatformState",
      "ReadPlatformAuditMetadata",
    ],
  );
  const compactedRuntimeAccess = bySid("WritePlatformLogs");
  if (compactedRuntimeAccess) {
    if (
      compactedRuntimeAccess.Resource.includes(
        registryDecisionFinalizerFunctionArn,
      )
      && compactedRuntimeAccess.Resource.includes(
        runtimeProofConfiguratorFunctionArn,
      )
    ) {
      compactedRuntimeAccess.Resource = [
        ...compactedRuntimeAccess.Resource.filter(
          (resource) =>
            resource !== registryDecisionFinalizerFunctionArn
            && resource !== runtimeProofConfiguratorFunctionArn,
        ),
        `arn:${partition}:lambda:${region}:${account}:`
          + "function:AgenticPlatform-Web-R*",
      ];
    }
    const workloadIdentityDirectoryArn =
      `arn:${partition}:bedrock-agentcore:${region}:${account}:`
      + "workload-identity-directory/*";
    if (
      compactedRuntimeAccess.Resource.includes(
        workloadIdentityDirectoryArn,
      )
    ) {
      const workloadIdentityDirectoryPrefix =
        workloadIdentityDirectoryArn.slice(0, -1);
      compactedRuntimeAccess.Resource =
        compactedRuntimeAccess.Resource.filter(
          (resource) =>
            resource === workloadIdentityDirectoryArn
            || typeof resource !== "string"
            || !resource.startsWith(workloadIdentityDirectoryPrefix),
        );
    }
    const logGroupWildcard =
      `arn:${partition}:logs:${region}:${account}:log-group:*`;
    if (compactedRuntimeAccess.Resource.includes(logGroupWildcard)) {
      const logGroupPrefix =
        `arn:${partition}:logs:${region}:${account}:log-group:`;
      compactedRuntimeAccess.Resource =
        compactedRuntimeAccess.Resource.filter(
          (resource) =>
            resource === logGroupWildcard
            || typeof resource !== "string"
            || !resource.startsWith(logGroupPrefix),
        );
    }
    const auditIndexArn =
      `${platformStateTableArn}/index/EntityTypeIndex`;
    if (
      compactedRuntimeAccess.Resource.includes(platformStateTableArn)
      && compactedRuntimeAccess.Resource.includes(auditIndexArn)
    ) {
      compactedRuntimeAccess.Resource = [
        ...compactedRuntimeAccess.Resource.filter(
          (resource) =>
            resource !== platformStateTableArn
            && resource !== auditIndexArn,
        ),
        `${platformStateTableArn}*`,
      ];
    }
  }

  // Compact BatchPutGatewayRateLimits + ListGatewayRateLimits into a single
  // suffix wildcard to reclaim ~49 bytes and stay within IAM's policy size limit.
  if (compactedRuntimeAccess) {
    const rateLimitActions = [
      "bedrock-agentcore:BatchPutGatewayRateLimits",
      "bedrock-agentcore:ListGatewayRateLimits",
    ];
    if (rateLimitActions.every((a) => compactedRuntimeAccess.Action.includes(a))) {
      compactedRuntimeAccess.Action = compactedRuntimeAccess.Action.filter(
        (a) => !rateLimitActions.includes(a),
      );
      compactedRuntimeAccess.Action.push("bedrock-agentcore:*GatewayRateLimits");
    }
  }

  // The tag-constrained registry/* grant already covers hosted-acceptance
  // record submissions. Remove only that identical permission; keep deletion
  // independently constrained. This also normalizes earlier deployed policies.
  const actionValues = (value: any) => Array.isArray(value) ? value : [value];
  const submit = "agent-registry:SubmitRegistryRecordForApproval";
  for (const specific of statements) {
    const tags = specific.Condition?.StringEquals;
    if (specific.Effect !== "Allow" || !actionValues(specific.Action).includes(submit)
      || tags?.["aws:ResourceTag/managedBy"] !== "hosted-acceptance"
      || Object.keys(specific.Condition || {}).join() !== "StringEquals") continue;
    const covering = statements.find(other => other !== specific && other.Effect === "Allow"
      && actionValues(other.Action).includes(submit)
      && Object.keys(other.Condition || {}).join() === "StringEquals"
      && JSON.stringify(Object.keys(other.Condition?.StringEquals || {}).sort()) === JSON.stringify(Object.keys(tags).sort())
      && Object.entries(tags).every(([key,value]) => actionValues(other.Condition?.StringEquals?.[key]).includes(value))
      && actionValues(specific.Resource).every(resource => actionValues(other.Resource).some(parent =>
        typeof resource === "string" && typeof parent === "string" && parent.endsWith(":registry/*")
        && resource.startsWith(parent.slice(0,-1)))));
    if (covering) specific.Action = actionValues(specific.Action).filter(action => action !== submit);
  }

  return {
    Version: rendered.Version,
    Statement: statements.map(({ Sid: _sid, ...statement }) => ({
      ...statement,
      Action: statement.Action.length === 1
        ? statement.Action[0]
        : statement.Action,
      Resource: statement.Resource.length === 1
        ? statement.Resource[0]
        : statement.Resource,
    })),
  };
}

export function applyRequiredTags(scope: Construct): void {
  for (const [key, value] of Object.entries(REQUIRED_TAGS)) {
    cdk.Tags.of(scope).add(key, value);
  }
}

export function stackName(suffix: string): string {
  return `AgenticPlatform-${suffix}`;
}
