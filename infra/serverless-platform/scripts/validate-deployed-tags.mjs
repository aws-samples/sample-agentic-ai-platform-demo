#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REQUIRED_TAGS = Object.freeze({
  "auto-delete": "no",
  managedBy: "cdk",
  project: "agentic-ai-platform-demo",
});

export const NON_TAGGABLE_RESOURCE_TYPES = Object.freeze({
  "AWS::ApiGatewayV2::Authorizer":
    "API authorizers do not expose an independent tag surface.",
  "AWS::ApiGatewayV2::Integration":
    "API integrations do not expose an independent tag surface.",
  "AWS::ApiGatewayV2::Route":
    "API routes do not expose an independent tag surface.",
  "AWS::BedrockAgentCore::GatewayTarget":
    "AgentCore Gateway targets are not independently taggable.",
  "AWS::CDK::Metadata":
    "CDK metadata is deployment metadata, not an AWS resource.",
  "AWS::CloudFront::OriginAccessControl":
    "Origin access controls are not returned by the tagging inventory.",
  "AWS::CloudFront::ResponseHeadersPolicy":
    "Response headers policies are not returned by the tagging inventory.",
  "AWS::Cognito::UserPoolClient":
    "User-pool clients inherit ownership from their user pool.",
  "AWS::Cognito::UserPoolDomain":
    "User-pool domains inherit ownership from their user pool.",
  "AWS::Cognito::UserPoolGroup":
    "User-pool groups inherit ownership from their user pool.",
  "AWS::IAM::Policy":
    "Inline role policies are not independently taggable.",
  "AWS::Lambda::EventInvokeConfig":
    "Lambda event invoke configurations are not independently taggable.",
  "AWS::Lambda::LayerVersion":
    "Lambda layer versions are immutable and not returned by this tag inventory.",
  "AWS::Lambda::Permission":
    "Lambda resource-policy statements are not independently taggable.",
  "AWS::Logs::ResourcePolicy":
    "CloudWatch Logs resource policies do not expose an independent tag surface.",
  "AWS::S3::BucketPolicy":
    "Bucket policies inherit ownership from their bucket.",
  "AWS::XRay::ResourcePolicy":
    "X-Ray resource policies do not expose an independent tag surface.",
  "Custom::CDKBucketDeployment":
    "The bucket deployment custom resource has no durable taggable resource.",
  "Custom::CloudFrontInvalidation":
    "A CloudFront invalidation is an operation, not a durable taggable resource.",
  "Custom::PlatformBaselineDomains":
    "The custom resource manages domain records without creating a durable taggable resource.",
  "Custom::PlatformBaselineProject":
    "The custom resource manages a retained platform project record without creating a durable taggable resource.",
  "Custom::PlatformAgentDesignAssistant":
    "The custom resource registers the platform-owned assistant without creating a durable taggable resource.",
  "Custom::PlatformBaselineModelPolicy":
    "The custom resource manages model policy and Gateway rate-limit configuration without creating a durable taggable resource.",
  "Custom::RuntimePermissionsBoundaryTags":
    "The tagged IAM managed policy is inventoried separately.",
  "Custom::RuntimeProofEndpointBinding":
    "The custom resource configures the proof secret without creating a durable taggable resource.",
});

const COMPLETE_RESOURCE_STATUS =
  /^(?:CREATE|IMPORT|UPDATE)_COMPLETE$/;
const COMPLETE_STACK_STATUS =
  /^(?:CREATE|IMPORT|UPDATE)_COMPLETE$/;

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function arnOrName(value, prefix) {
  return value.startsWith("arn:") ? value : `${prefix}${value}`;
}

function expectedResource(
  resource,
  arn,
  region,
  strategy,
) {
  return {
    arn,
    logicalResourceId: resource.LogicalResourceId,
    region,
    resourceType: resource.ResourceType,
    strategy,
  };
}

function customRegistryResource(resource, scope) {
  const physicalId = requiredString(
    resource.PhysicalResourceId,
    `${resource.LogicalResourceId} physical resource ID`,
  );
  const separator = physicalId.indexOf("::");
  if (separator === -1) {
    throw new Error(
      `${resource.LogicalResourceId} custom resource ownership is malformed.`,
    );
  }
  const ownership = physicalId.slice(0, separator);
  const resourceKey = physicalId.slice(separator + 2);
  if (ownership === "referenced") {
    return {
      allowlisted: {
        logicalResourceId: resource.LogicalResourceId,
        reason:
          "Referenced Registry resources are not stack-owned and are excluded.",
        resourceType: resource.ResourceType,
      },
    };
  }
  if (ownership !== "created") {
    throw new Error(
      `${resource.LogicalResourceId} custom resource ownership is malformed.`,
    );
  }
  const parts = resourceKey.split("/");
  if (
    parts.length < 1
    || parts.length > 2
    || parts.some((part) => !/^[A-Za-z0-9]+$/.test(part))
  ) {
    throw new Error(
      `${resource.LogicalResourceId} Registry physical resource ID is malformed.`,
    );
  }
  const suffix = parts.length === 1
    ? `registry/${parts[0]}`
    : `registry/${parts[0]}/record/${parts[1]}`;
  return {
    expected: expectedResource(
      resource,
      `arn:${scope.partition}:agent-registry:${scope.region}:`
        + `${scope.accountId}:${suffix}`,
      scope.region,
      "agent-registry",
    ),
  };
}

function resourceToInventory(resource, scope, apiId) {
  const physicalId = () => requiredString(
    resource.PhysicalResourceId,
    `${resource.LogicalResourceId} physical resource ID`,
  );
  const regionalPrefix =
    `arn:${scope.partition}`;
  switch (resource.ResourceType) {
    case "AWS::S3::Bucket":
      return expectedResource(
        resource,
        `arn:${scope.partition}:s3:::${physicalId()}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::Cognito::UserPool":
      return expectedResource(
        resource,
        `${regionalPrefix}:cognito-idp:${scope.region}:`
          + `${scope.accountId}:userpool/${physicalId()}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::DynamoDB::Table":
      return expectedResource(
        resource,
        `${regionalPrefix}:dynamodb:${scope.region}:${scope.accountId}:`
          + `table/${physicalId()}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::SecretsManager::Secret": {
      const secretArn = physicalId();
      const secretArnPattern = new RegExp(
        `^${regionalPrefix}:secretsmanager:${scope.region}:`
          + `${scope.accountId}:secret:[A-Za-z0-9/_+=.@-]{1,512}$`,
      );
      if (!secretArnPattern.test(secretArn)) {
        throw new Error(
          `${resource.LogicalResourceId} secret ARN is malformed.`,
        );
      }
      return expectedResource(
        resource,
        secretArn,
        scope.region,
        "resource-groups-tagging-api",
      );
    }
    case "AWS::Logs::LogGroup":
      return expectedResource(
        resource,
        `${regionalPrefix}:logs:${scope.region}:${scope.accountId}:`
          + `log-group:${physicalId()}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::IAM::Role":
      return expectedResource(
        resource,
        `arn:${scope.partition}:iam::${scope.accountId}:role/${physicalId()}`,
        "us-east-1",
        "iam-role",
      );
    case "AWS::IAM::ManagedPolicy":
      return expectedResource(
        resource,
        arnOrName(
          physicalId(),
          `arn:${scope.partition}:iam::${scope.accountId}:policy/`,
        ),
        "us-east-1",
        "iam-policy",
      );
    case "AWS::Lambda::Function":
      return expectedResource(
        resource,
        `${regionalPrefix}:lambda:${scope.region}:${scope.accountId}:`
          + `function:${physicalId()}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::ApiGatewayV2::Api":
      return expectedResource(
        resource,
        `${regionalPrefix}:apigateway:${scope.region}::/apis/${physicalId()}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::ApiGatewayV2::Stage":
      if (!apiId) {
        throw new Error(
          `${resource.LogicalResourceId} cannot resolve its API physical ID.`,
        );
      }
      return expectedResource(
        resource,
        `${regionalPrefix}:apigateway:${scope.region}::/apis/`
          + `${apiId}/stages/${physicalId()}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::CloudFront::Distribution":
      return expectedResource(
        resource,
        `arn:${scope.partition}:cloudfront::${scope.accountId}:`
          + `distribution/${physicalId()}`,
        "us-east-1",
        "resource-groups-tagging-api",
      );
    case "AWS::CloudWatch::Alarm":
      return expectedResource(
        resource,
        arnOrName(
          physicalId(),
          `${regionalPrefix}:cloudwatch:${scope.region}:${scope.accountId}:`
            + "alarm:",
        ),
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::CloudWatch::Dashboard":
      return expectedResource(
        resource,
        `arn:${scope.partition}:cloudwatch::${scope.accountId}:`
          + `dashboard/${physicalId()}`,
        "us-east-1",
        "cloudwatch",
      );
    case "AWS::SSM::Parameter": {
      const name = physicalId();
      if (!name.startsWith("/")) {
        throw new Error(
          `${resource.LogicalResourceId} SSM parameter name is malformed.`,
        );
      }
      return expectedResource(
        resource,
        `${regionalPrefix}:ssm:${scope.region}:${scope.accountId}:`
          + `parameter${name}`,
        scope.region,
        "resource-groups-tagging-api",
      );
    }
    case "AWS::StepFunctions::StateMachine":
      return expectedResource(
        resource,
        arnOrName(
          physicalId(),
          `${regionalPrefix}:states:${scope.region}:${scope.accountId}:`
            + "stateMachine:",
        ),
        scope.region,
        "resource-groups-tagging-api",
      );
    case "AWS::BedrockAgentCore::Gateway":
      return expectedResource(
        resource,
        `${regionalPrefix}:bedrock-agentcore:${scope.region}:`
          + `${scope.accountId}:gateway/${physicalId()}`,
        scope.region,
        "bedrock-agentcore",
      );
    case "AWS::BedrockAgentCore::Runtime": {
      const runtimeId = physicalId();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,58}$/.test(runtimeId)) {
        throw new Error(
          `${resource.LogicalResourceId} Runtime physical resource ID is malformed.`,
        );
      }
      return expectedResource(
        resource,
        `${regionalPrefix}:bedrock-agentcore:${scope.region}:`
          + `${scope.accountId}:runtime/${runtimeId}`,
        scope.region,
        "bedrock-agentcore",
      );
    }
    case "AWS::BedrockAgentCore::RuntimeEndpoint": {
      const endpointArn = physicalId();
      const runtimeEndpointPrefix =
        `${regionalPrefix}:bedrock-agentcore:${scope.region}:`
        + `${scope.accountId}:runtime/`;
      const endpointSegments = endpointArn.startsWith(runtimeEndpointPrefix)
        ? endpointArn.slice(runtimeEndpointPrefix.length).split("/")
        : [];
      if (
        endpointSegments.length !== 3
        || !/^[A-Za-z][A-Za-z0-9_-]{0,58}$/.test(endpointSegments[0])
        || endpointSegments[1] !== "runtime-endpoint"
        || !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(endpointSegments[2])
      ) {
        throw new Error(
          `${resource.LogicalResourceId} Runtime endpoint ARN is malformed.`,
        );
      }
      return expectedResource(
        resource,
        endpointArn,
        scope.region,
        "bedrock-agentcore",
      );
    }
    case "AWS::Logs::DeliverySource":
      return expectedResource(
        resource,
        `${regionalPrefix}:logs:${scope.region}:${scope.accountId}:`
          + `delivery-source:${physicalId()}`,
        scope.region,
        "cloudwatch-logs",
      );
    case "AWS::Logs::DeliveryDestination":
      return expectedResource(
        resource,
        `${regionalPrefix}:logs:${scope.region}:${scope.accountId}:`
          + `delivery-destination:${physicalId()}`,
        scope.region,
        "cloudwatch-logs",
      );
    case "AWS::Logs::Delivery":
      return expectedResource(
        resource,
        `${regionalPrefix}:logs:${scope.region}:${scope.accountId}:`
          + `delivery:${physicalId()}`,
        scope.region,
        "cloudwatch-logs",
      );
    case "AWS::CloudFormation::CustomResource":
      return customRegistryResource(resource, scope);
    case "Custom::CloudFrontAlarm":
      return expectedResource(
        resource,
        arnOrName(
          physicalId(),
          `${regionalPrefix}:cloudwatch:us-east-1:${scope.accountId}:alarm:`,
        ),
        "us-east-1",
        "resource-groups-tagging-api",
      );
    default:
      return undefined;
  }
}

export function buildExpectedTagInventory({
  accountId,
  partition,
  region,
  resources,
  stackName,
}) {
  requiredString(stackName, "stack name");
  if (!/^[0-9]{12}$/.test(accountId ?? "")) {
    throw new Error("account ID must contain exactly 12 digits.");
  }
  if (!/^[a-z0-9-]+$/.test(partition ?? "")) {
    throw new Error("partition is malformed.");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+$/.test(region ?? "")) {
    throw new Error("region is malformed.");
  }
  if (!Array.isArray(resources)) {
    throw new Error("CloudFormation stack resources must be an array.");
  }

  const logicalIds = new Set();
  for (const resource of resources) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      throw new Error("CloudFormation stack resource is malformed.");
    }
    const logicalId = requiredString(
      resource.LogicalResourceId,
      "logical resource ID",
    );
    const resourceType = requiredString(
      resource.ResourceType,
      `${logicalId} resource type`,
    );
    if (logicalIds.has(logicalId)) {
      throw new Error(`Duplicate logical resource ID: ${logicalId}.`);
    }
    logicalIds.add(logicalId);
    if (!COMPLETE_RESOURCE_STATUS.test(resource.ResourceStatus ?? "")) {
      throw new Error(`${logicalId} is not in a complete resource status.`);
    }
    if (!resourceType.includes("::")) {
      throw new Error(`${logicalId} resource type is malformed.`);
    }
  }

  const apiResources = resources.filter(
    (resource) => resource.ResourceType === "AWS::ApiGatewayV2::Api",
  );
  if (
    resources.some(
      (resource) => resource.ResourceType === "AWS::ApiGatewayV2::Stage",
    )
    && apiResources.length !== 1
  ) {
    throw new Error(
      "API stage tag validation requires exactly one stack-owned HTTP API.",
    );
  }
  const apiId = apiResources.length === 1
    ? requiredString(
      apiResources[0].PhysicalResourceId,
      `${apiResources[0].LogicalResourceId} physical resource ID`,
    )
    : undefined;

  const expected = [];
  const allowlisted = [];
  for (const resource of resources) {
    const mapped = resourceToInventory(
      resource,
      { accountId, partition, region },
      apiId,
    );
    if (mapped?.expected) {
      expected.push(mapped.expected);
      continue;
    }
    if (mapped?.allowlisted) {
      allowlisted.push(mapped.allowlisted);
      continue;
    }
    if (mapped) {
      expected.push(mapped);
      continue;
    }
    const reason = NON_TAGGABLE_RESOURCE_TYPES[resource.ResourceType];
    if (!reason) {
      throw new Error(
        `Unsupported CloudFormation resource type: ${resource.ResourceType}.`,
      );
    }
    allowlisted.push({
      logicalResourceId: resource.LogicalResourceId,
      reason,
      resourceType: resource.ResourceType,
    });
  }

  const arns = new Set();
  for (const resource of expected) {
    if (arns.has(resource.arn)) {
      throw new Error(`Duplicate expected resource ARN: ${resource.arn}.`);
    }
    arns.add(resource.arn);
  }
  return { allowlisted, expected };
}

function tagMap(tags, resourceArn) {
  if (!Array.isArray(tags)) {
    throw new Error(`Tag result for ${resourceArn} is malformed.`);
  }
  const result = new Map();
  for (const tag of tags) {
    if (
      !tag
      || typeof tag !== "object"
      || Array.isArray(tag)
      || typeof tag.Key !== "string"
      || tag.Key.length === 0
      || typeof tag.Value !== "string"
    ) {
      throw new Error(`Tag result for ${resourceArn} is malformed.`);
    }
    if (result.has(tag.Key)) {
      throw new Error(`Tag result for ${resourceArn} has a duplicate tag.`);
    }
    result.set(tag.Key, tag.Value);
  }
  return result;
}

export function validateObservedTags(expected, observed) {
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error("No stack-owned taggable resources were found.");
  }
  if (!(observed instanceof Map)) {
    throw new Error("Observed tag inventory must be a Map.");
  }
  for (const resource of expected) {
    if (!observed.has(resource.arn)) {
      throw new Error(
        `${resource.logicalResourceId} is missing from tag validation.`,
      );
    }
    const tags = tagMap(observed.get(resource.arn), resource.arn);
    for (const [key, value] of Object.entries(REQUIRED_TAGS)) {
      if (tags.get(key) !== value) {
        throw new Error(
          `${resource.logicalResourceId} has an invalid ${key} tag.`,
        );
      }
    }
  }
}

function awsJson(args, label) {
  try {
    const output = execFileSync("aws", args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("malformed JSON");
    }
    return parsed;
  } catch {
    throw new Error(`AWS ${label} failed.`);
  }
}

function validateStackDocument(document, stackName) {
  if (!Array.isArray(document.Stacks) || document.Stacks.length !== 1) {
    throw new Error(`Expected exactly one ${stackName} stack.`);
  }
  const stack = document.Stacks[0];
  if (
    stack?.StackName !== stackName
    || !COMPLETE_STACK_STATUS.test(stack?.StackStatus ?? "")
  ) {
    throw new Error(`${stackName} is not in a complete stack status.`);
  }
  const tags = tagMap(stack.Tags, `${stackName} stack`);
  for (const [key, value] of Object.entries(REQUIRED_TAGS)) {
    if (tags.get(key) !== value) {
      throw new Error(`${stackName} has an invalid ${key} stack tag.`);
    }
  }
}

export function stackResourceArguments(stackName, region) {
  return [
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    stackName,
    "--region",
    region,
    "--output",
    "json",
  ];
}

function stackResources(stackName, region) {
  const document = awsJson(
    stackResourceArguments(stackName, region),
    "CloudFormation resource inventory",
  );
  if (
    !Array.isArray(document.StackResourceSummaries)
    || (document.NextToken !== undefined && document.NextToken !== "")
  ) {
    throw new Error(`${stackName} resource inventory is incomplete.`);
  }
  return document.StackResourceSummaries;
}

function stackDocument(stackName, region) {
  const document = awsJson([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
    "--region",
    region,
    "--output",
    "json",
  ], "CloudFormation stack lookup");
  validateStackDocument(document, stackName);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function addObserved(observed, arn, tags) {
  if (observed.has(arn)) {
    throw new Error(`Duplicate observed resource ARN: ${arn}.`);
  }
  observed.set(arn, tags);
}

async function collectObservedTags(expected) {
  const observed = new Map();
  const byRegion = new Map();
  for (const resource of expected.filter(
    ({ strategy }) => strategy === "resource-groups-tagging-api",
  )) {
    const resources = byRegion.get(resource.region) ?? [];
    resources.push(resource);
    byRegion.set(resource.region, resources);
  }
  for (const [region, resources] of byRegion) {
    for (const batch of chunks(resources, 100)) {
      const document = awsJson([
        "resourcegroupstaggingapi",
        "get-resources",
        "--resource-arn-list",
        ...batch.map(({ arn }) => arn),
        "--region",
        region,
        "--no-paginate",
        "--output",
        "json",
      ], "Resource Groups Tagging API inventory");
      if (
        !Array.isArray(document.ResourceTagMappingList)
        || (
          document.PaginationToken !== undefined
          && document.PaginationToken !== ""
        )
      ) {
        throw new Error("Resource Groups tag inventory is incomplete.");
      }
      for (const mapping of document.ResourceTagMappingList) {
        const arn = requiredString(mapping?.ResourceARN, "observed resource ARN");
        addObserved(observed, arn, mapping.Tags);
      }
    }
  }

  let registryClient;
  let registryListTags;
  let gatewayClient;
  let gatewayListTags;
  for (const resource of expected.filter(
    ({ strategy }) => strategy !== "resource-groups-tagging-api",
  )) {
    if (resource.strategy === "iam-role") {
      const roleName = resource.arn.split("/").at(-1);
      const document = awsJson([
        "iam",
        "list-role-tags",
        "--role-name",
        roleName,
        "--no-paginate",
        "--output",
        "json",
      ], "IAM role tag lookup");
      if (
        !Array.isArray(document.Tags)
        || document.IsTruncated === true
        || document.Marker
      ) {
        throw new Error("IAM role tag inventory is incomplete.");
      }
      addObserved(observed, resource.arn, document.Tags);
      continue;
    }
    if (resource.strategy === "iam-policy") {
      const document = awsJson([
        "iam",
        "list-policy-tags",
        "--policy-arn",
        resource.arn,
        "--no-paginate",
        "--output",
        "json",
      ], "IAM policy tag lookup");
      if (
        !Array.isArray(document.Tags)
        || document.IsTruncated === true
        || document.Marker
      ) {
        throw new Error("IAM policy tag inventory is incomplete.");
      }
      addObserved(observed, resource.arn, document.Tags);
      continue;
    }
    if (resource.strategy === "cloudwatch") {
      const document = awsJson([
        "cloudwatch",
        "list-tags-for-resource",
        "--resource-arn",
        resource.arn,
        "--region",
        resource.region,
        "--output",
        "json",
      ], "CloudWatch tag lookup");
      addObserved(observed, resource.arn, document.Tags);
      continue;
    }
    if (resource.strategy === "cloudwatch-logs") {
      const document = awsJson([
        "logs",
        "list-tags-for-resource",
        "--resource-arn",
        resource.arn,
        "--region",
        resource.region,
        "--output",
        "json",
      ], "CloudWatch Logs tag lookup");
      if (
        !document.tags
        || typeof document.tags !== "object"
        || Array.isArray(document.tags)
      ) {
        throw new Error(
          `CloudWatch Logs tag result for ${resource.arn} is malformed.`,
        );
      }
      addObserved(
        observed,
        resource.arn,
        Object.entries(document.tags).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      );
      continue;
    }
    if (resource.strategy === "agent-registry") {
      if (!registryClient) {
        const registry = await import(
          "@aws-sdk/client-agent-registry-control"
        );
        registryClient = new registry.AgentRegistryControlClient({
          region: resource.region,
        });
        registryListTags = registry.ListTagsForResourceCommand;
      }
      const response = await registryClient.send(
        new registryListTags({ resourceArn: resource.arn }),
      );
      addObserved(
        observed,
        resource.arn,
        Object.entries(response.tags ?? {}).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      );
      continue;
    }
    if (resource.strategy === "bedrock-agentcore") {
      if (!gatewayClient) {
        const gateway = await import(
          "@aws-sdk/client-bedrock-agentcore-control"
        );
        gatewayClient = new gateway.BedrockAgentCoreControlClient({
          region: resource.region,
        });
        gatewayListTags = gateway.ListTagsForResourceCommand;
      }
      const response = await gatewayClient.send(
        new gatewayListTags({ resourceArn: resource.arn }),
      );
      addObserved(
        observed,
        resource.arn,
        Object.entries(response.tags ?? {}).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      );
      continue;
    }
    throw new Error(`Unsupported tag lookup strategy: ${resource.strategy}.`);
  }
  registryClient?.destroy();
  gatewayClient?.destroy();
  return observed;
}

function parseArguments(argv) {
  const result = {
    accountId: "",
    partition: "aws",
    region: "",
    stacks: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--account-id", "--partition", "--region", "--stack"].includes(
      argument,
    )) {
      throw new Error(`Unknown argument: ${argument}.`);
    }
    requiredString(value, `${argument} value`);
    index += 1;
    if (argument === "--stack") {
      result.stacks.push(value);
    } else if (argument === "--account-id") {
      result.accountId = value;
    } else if (argument === "--partition") {
      result.partition = value;
    } else {
      result.region = value;
    }
  }
  const uniqueStacks = new Set(result.stacks);
  const controlPlaneStacks = result.stacks.filter((stackName) =>
    stackName === "AgenticPlatform-ControlPlane"
    || stackName === "AgenticPlatform-ControlPlane-Provisioned"
  );
  if (
    uniqueStacks.size !== 2
    || !uniqueStacks.has("AgenticPlatform-Web")
    || controlPlaneStacks.length !== 1
  ) {
    throw new Error(
      "Tag validation requires AgenticPlatform-Web and one control-plane stack.",
    );
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const expected = [];
  let allowlistedCount = 0;
  for (const stackName of options.stacks) {
    stackDocument(stackName, options.region);
    const inventory = buildExpectedTagInventory({
      accountId: options.accountId,
      partition: options.partition,
      region: options.region,
      resources: stackResources(stackName, options.region),
      stackName,
    });
    expected.push(...inventory.expected);
    allowlistedCount += inventory.allowlisted.length;
  }
  const observed = await collectObservedTags(expected);
  validateObservedTags(expected, observed);
  process.stdout.write(
    `Validated mandatory tags on ${expected.length} stack-owned resources; `
      + `${allowlistedCount} explicitly non-taggable resources skipped.\n`,
  );
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `Deployed tag validation failed: ${error?.message ?? "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
