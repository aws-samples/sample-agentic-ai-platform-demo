import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const scriptPath = resolve(
  import.meta.dirname,
  "validate-deployed-tags.mjs",
);

async function loadValidator() {
  assert.ok(existsSync(scriptPath), "deployed-tag validator script is missing");
  return import(pathToFileURL(scriptPath).href);
}

test("deployed-tag validator script exists", () => {
  assert.ok(existsSync(scriptPath), "deployed-tag validator script is missing");
});

test("validator lets the AWS CLI aggregate complete stack inventories", async () => {
  const { stackResourceArguments } = await loadValidator();

  assert.deepEqual(
    stackResourceArguments("AgenticPlatform-Web", "us-west-2"),
    [
      "cloudformation",
      "list-stack-resources",
      "--stack-name",
      "AgenticPlatform-Web",
      "--region",
      "us-west-2",
      "--output",
      "json",
    ],
  );
});

test("validator builds a complete stack-owned inventory with explicit strategies", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-ControlPlane-Provisioned",
    resources: [
      {
        LogicalResourceId: "ControlPlaneConfig",
        PhysicalResourceId: "/agentic-platform/control-plane/config",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::SSM::Parameter",
      },
      {
        LogicalResourceId: "RegistryRole",
        PhysicalResourceId:
          "AgenticPlatform-ControlPlane-Provisioned-RegistryRole-ABC123",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::IAM::Role",
      },
      {
        LogicalResourceId: "RegistryHandler",
        PhysicalResourceId:
          "AgenticPlatform-ControlPlane-Provisioned-RegistryHandler-ABC123",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::Lambda::Function",
      },
      {
        LogicalResourceId: "RegistryWaiter",
        PhysicalResourceId:
          "arn:aws:states:us-west-2:111122223333:"
            + "stateMachine:AgenticPlatform-ControlPlane-Provisioned-Waiter",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::StepFunctions::StateMachine",
      },
      {
        LogicalResourceId: "SharedRegistry",
        PhysicalResourceId: "created::AbCdEfGhIjKl",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::CloudFormation::CustomResource",
      },
      {
        LogicalResourceId: "SeedRecord",
        PhysicalResourceId: "created::AbCdEfGhIjKl/Record123456",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::CloudFormation::CustomResource",
      },
      {
        LogicalResourceId: "LlmGateway",
        PhysicalResourceId: "agentic-demo-llm-gateway-abcdefghij",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::BedrockAgentCore::Gateway",
      },
      {
        LogicalResourceId: "MantleTarget",
        PhysicalResourceId: "target-abcdefghij",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::BedrockAgentCore::GatewayTarget",
      },
      {
        LogicalResourceId: "RegistryPolicy",
        PhysicalResourceId:
          "AgenticPlatform-ControlPlane-Provisioned-RegistryPolicy",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::IAM::Policy",
      },
      {
        LogicalResourceId: "CDKMetadata",
        PhysicalResourceId: "metadata",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::CDK::Metadata",
      },
    ],
  });

  assert.deepEqual(
    inventory.expected.map(({ arn, strategy }) => [arn, strategy]),
    [
      [
        "arn:aws:ssm:us-west-2:111122223333:"
          + "parameter/agentic-platform/control-plane/config",
        "resource-groups-tagging-api",
      ],
      [
        "arn:aws:iam::111122223333:"
          + "role/AgenticPlatform-ControlPlane-Provisioned-RegistryRole-ABC123",
        "iam-role",
      ],
      [
        "arn:aws:lambda:us-west-2:111122223333:"
          + "function:AgenticPlatform-ControlPlane-Provisioned-RegistryHandler-ABC123",
        "resource-groups-tagging-api",
      ],
      [
        "arn:aws:states:us-west-2:111122223333:"
          + "stateMachine:AgenticPlatform-ControlPlane-Provisioned-Waiter",
        "resource-groups-tagging-api",
      ],
      [
        "arn:aws:agent-registry:us-west-2:111122223333:"
          + "registry/AbCdEfGhIjKl",
        "agent-registry",
      ],
      [
        "arn:aws:agent-registry:us-west-2:111122223333:"
          + "registry/AbCdEfGhIjKl/record/Record123456",
        "agent-registry",
      ],
      [
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
          + "gateway/agentic-demo-llm-gateway-abcdefghij",
        "bedrock-agentcore",
      ],
    ],
  );
  assert.deepEqual(
    inventory.allowlisted.map(
      ({ logicalResourceId, resourceType }) => [
        logicalResourceId,
        resourceType,
      ],
    ),
    [
      ["MantleTarget", "AWS::BedrockAgentCore::GatewayTarget"],
      ["RegistryPolicy", "AWS::IAM::Policy"],
      ["CDKMetadata", "AWS::CDK::Metadata"],
    ],
  );
});

test("validator allowlists PlatformBaselineDomains as non-taggable", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [{
      LogicalResourceId: "PlatformBaselineDomains",
      PhysicalResourceId: "platform-baseline-domains",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "Custom::PlatformBaselineDomains",
    }],
  });

  assert.deepEqual(inventory.expected, []);
  assert.deepEqual(inventory.allowlisted, [{
    logicalResourceId: "PlatformBaselineDomains",
    reason:
      "The custom resource manages domain records without creating a durable taggable resource.",
    resourceType: "Custom::PlatformBaselineDomains",
  }]);
});

test("validator allowlists PlatformBaselineProject as non-taggable", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [{
      LogicalResourceId: "PlatformBaselineProject",
      PhysicalResourceId:
        "platform-baseline-project:platform-state:platform:platform-foundation",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "Custom::PlatformBaselineProject",
    }],
  });

  assert.deepEqual(inventory.expected, []);
  assert.deepEqual(inventory.allowlisted, [{
    logicalResourceId: "PlatformBaselineProject",
    reason:
      "The custom resource manages a retained platform project record without creating a durable taggable resource.",
    resourceType: "Custom::PlatformBaselineProject",
  }]);
});

test("validator allowlists PlatformAgentDesignAssistant as non-taggable", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [{
      LogicalResourceId: "PlatformAgentDesignAssistant",
      PhysicalResourceId: "platform-agent-design-assistant",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "Custom::PlatformAgentDesignAssistant",
    }],
  });

  assert.deepEqual(inventory.expected, []);
  assert.deepEqual(inventory.allowlisted, [{
    logicalResourceId: "PlatformAgentDesignAssistant",
    reason:
      "The custom resource registers the platform-owned assistant without creating a durable taggable resource.",
    resourceType: "Custom::PlatformAgentDesignAssistant",
  }]);
});

test("validator allowlists PlatformBaselineModelPolicy as non-taggable", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [{
      LogicalResourceId: "PlatformBaselineModelPolicy",
      PhysicalResourceId:
        "platform-baseline-model-policy:agentic-platform-state",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "Custom::PlatformBaselineModelPolicy",
    }],
  });

  assert.deepEqual(inventory.expected, []);
  assert.deepEqual(inventory.allowlisted, [{
    logicalResourceId: "PlatformBaselineModelPolicy",
    reason:
      "The custom resource manages model policy and Gateway rate-limit configuration without creating a durable taggable resource.",
    resourceType: "Custom::PlatformBaselineModelPolicy",
  }]);
});

test("validator allowlists RuntimeProofEndpointBinding as non-taggable", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [{
      LogicalResourceId: "RuntimeProofEndpointBinding",
      PhysicalResourceId: "runtime-proof-config-example",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "Custom::RuntimeProofEndpointBinding",
    }],
  });

  assert.deepEqual(inventory.expected, []);
  assert.deepEqual(inventory.allowlisted, [{
    logicalResourceId: "RuntimeProofEndpointBinding",
    reason:
      "The custom resource configures the proof secret without creating a durable taggable resource.",
    resourceType: "Custom::RuntimeProofEndpointBinding",
  }]);
});

test("validator maps a complete DynamoDB table into the tag inventory", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [{
      LogicalResourceId: "PlatformStateTable",
      PhysicalResourceId: "agentic-platform-state",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "AWS::DynamoDB::Table",
    }],
  });

  assert.deepEqual(inventory.allowlisted, []);
  assert.deepEqual(inventory.expected, [{
    arn:
      "arn:aws:dynamodb:us-west-2:111122223333:"
        + "table/agentic-platform-state",
    logicalResourceId: "PlatformStateTable",
    region: "us-west-2",
    resourceType: "AWS::DynamoDB::Table",
    strategy: "resource-groups-tagging-api",
  }]);
});

test("validator maps a Secrets Manager physical ARN into the tag inventory", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const secretArn =
    "arn:aws:secretsmanager:us-west-2:111122223333:"
    + "secret:RuntimeInvocationProofSecre-AbCdEfGhIjKl-ABC123";
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [{
      LogicalResourceId: "RuntimeInvocationProofSecret551AA3CA",
      PhysicalResourceId: secretArn,
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "AWS::SecretsManager::Secret",
    }],
  });

  assert.deepEqual(inventory.allowlisted, []);
  assert.deepEqual(inventory.expected, [{
    arn: secretArn,
    logicalResourceId: "RuntimeInvocationProofSecret551AA3CA",
    region: "us-west-2",
    resourceType: "AWS::SecretsManager::Secret",
    strategy: "resource-groups-tagging-api",
  }]);
});

test("validator derives API stage and global resource ARNs from the complete stack inventory", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [
      {
        LogicalResourceId: "HttpApi",
        PhysicalResourceId: "api123",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::ApiGatewayV2::Api",
      },
      {
        LogicalResourceId: "DefaultStage",
        PhysicalResourceId: "$default",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::ApiGatewayV2::Stage",
      },
      {
        LogicalResourceId: "Distribution",
        PhysicalResourceId: "EDFDVBD6EXAMPLE",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::CloudFront::Distribution",
      },
      {
        LogicalResourceId: "Dashboard",
        PhysicalResourceId: "AgenticPlatform-WebIdentity",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::CloudWatch::Dashboard",
      },
      {
        LogicalResourceId: "Boundary",
        PhysicalResourceId:
          "arn:aws:iam::111122223333:"
            + "policy/AgenticPlatform-Web-RuntimePermissionsBoundary",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::IAM::ManagedPolicy",
      },
      {
        LogicalResourceId: "CloudFront5xxAlarm",
        PhysicalResourceId:
          "arn:aws:cloudwatch:us-east-1:111122223333:"
            + "alarm:AgenticPlatform-Web-CloudFront-5xx",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "Custom::CloudFrontAlarm",
      },
    ],
  });

  assert.deepEqual(
    inventory.expected.map(({ arn, region, strategy }) => [
      arn,
      region,
      strategy,
    ]),
    [
      [
        "arn:aws:apigateway:us-west-2::/apis/api123",
        "us-west-2",
        "resource-groups-tagging-api",
      ],
      [
        "arn:aws:apigateway:us-west-2::/apis/api123/stages/$default",
        "us-west-2",
        "resource-groups-tagging-api",
      ],
      [
        "arn:aws:cloudfront::111122223333:distribution/EDFDVBD6EXAMPLE",
        "us-east-1",
        "resource-groups-tagging-api",
      ],
      [
        "arn:aws:cloudwatch::111122223333:"
          + "dashboard/AgenticPlatform-WebIdentity",
        "us-east-1",
        "cloudwatch",
      ],
      [
        "arn:aws:iam::111122223333:"
          + "policy/AgenticPlatform-Web-RuntimePermissionsBoundary",
        "us-east-1",
        "iam-policy",
      ],
      [
        "arn:aws:cloudwatch:us-east-1:111122223333:"
          + "alarm:AgenticPlatform-Web-CloudFront-5xx",
        "us-east-1",
        "resource-groups-tagging-api",
      ],
    ],
  );
});

test("validator maps AgentCore Runtime and Logs delivery tag surfaces", async () => {
  const { buildExpectedTagInventory } = await loadValidator();
  const runtimeId = "AgenticPlatformRuntime-ABC1234567";
  const endpointArn =
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
    + `runtime/${runtimeId}/runtime-endpoint/Sandbox`;
  const inventory = buildExpectedTagInventory({
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
    resources: [
      {
        LogicalResourceId: "GovernedRuntime",
        PhysicalResourceId: runtimeId,
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::BedrockAgentCore::Runtime",
      },
      {
        LogicalResourceId: "SandboxEndpoint",
        PhysicalResourceId: endpointArn,
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::BedrockAgentCore::RuntimeEndpoint",
      },
      {
        LogicalResourceId: "ApplicationDeliverySource",
        PhysicalResourceId:
          "AgenticPlatformWebGovernedApplicationDeliverySourceABC123",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::Logs::DeliverySource",
      },
      {
        LogicalResourceId: "ApplicationDeliveryDestination",
        PhysicalResourceId:
          "AgenticPlatformWebGovernedApplicationDestinationABC123",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::Logs::DeliveryDestination",
      },
      {
        LogicalResourceId: "ApplicationDelivery",
        PhysicalResourceId: "delivery-0123456789abcdef",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::Logs::Delivery",
      },
      {
        LogicalResourceId: "LogsDeliveryPolicy",
        PhysicalResourceId: "AgenticPlatformWebLogsDeliveryPolicy",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::Logs::ResourcePolicy",
      },
      {
        LogicalResourceId: "XRayDeliveryPolicy",
        PhysicalResourceId: "AgenticPlatformWebXRayDeliveryPolicy",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::XRay::ResourcePolicy",
      },
    ],
  });

  assert.deepEqual(
    inventory.expected.map(({ arn, strategy }) => [arn, strategy]),
    [
      [
        "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
          + `runtime/${runtimeId}`,
        "bedrock-agentcore",
      ],
      [endpointArn, "bedrock-agentcore"],
      [
        "arn:aws:logs:us-west-2:111122223333:"
          + "delivery-source:"
          + "AgenticPlatformWebGovernedApplicationDeliverySourceABC123",
        "cloudwatch-logs",
      ],
      [
        "arn:aws:logs:us-west-2:111122223333:"
          + "delivery-destination:"
          + "AgenticPlatformWebGovernedApplicationDestinationABC123",
        "cloudwatch-logs",
      ],
      [
        "arn:aws:logs:us-west-2:111122223333:"
          + "delivery:delivery-0123456789abcdef",
        "cloudwatch-logs",
      ],
    ],
  );
  assert.deepEqual(
    inventory.allowlisted.map(
      ({ logicalResourceId, resourceType }) => [
        logicalResourceId,
        resourceType,
      ],
    ),
    [
      ["LogsDeliveryPolicy", "AWS::Logs::ResourcePolicy"],
      ["XRayDeliveryPolicy", "AWS::XRay::ResourcePolicy"],
    ],
  );
});

test("validator rejects unknown types, malformed resources, and non-owned custom resources safely", async () => {
  const {
    buildExpectedTagInventory,
    NON_TAGGABLE_RESOURCE_TYPES,
  } = await loadValidator();

  assert.equal(
    typeof NON_TAGGABLE_RESOURCE_TYPES["AWS::IAM::Policy"],
    "string",
  );
  assert.equal(
    typeof NON_TAGGABLE_RESOURCE_TYPES[
      "AWS::BedrockAgentCore::GatewayTarget"
    ],
    "string",
  );

  const base = {
    accountId: "111122223333",
    partition: "aws",
    region: "us-west-2",
    stackName: "AgenticPlatform-Web",
  };
  assert.throws(
    () => buildExpectedTagInventory({
      ...base,
      resources: [{
        LogicalResourceId: "Unknown",
        PhysicalResourceId: "unknown",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::Example::NewTaggableThing",
      }],
    }),
    /unsupported CloudFormation resource type/i,
  );
  assert.throws(
    () => buildExpectedTagInventory({
      ...base,
      resources: [{
        LogicalResourceId: "Logs",
        ResourceStatus: "CREATE_COMPLETE",
        ResourceType: "AWS::Logs::LogGroup",
      }],
    }),
    /physical resource ID/i,
  );

  const referenced = buildExpectedTagInventory({
    ...base,
    resources: [{
      LogicalResourceId: "ReferencedRecord",
      PhysicalResourceId: "referenced::AbCdEfGhIjKl/Record123456",
      ResourceStatus: "CREATE_COMPLETE",
      ResourceType: "AWS::CloudFormation::CustomResource",
    }],
  });
  assert.deepEqual(referenced.expected, []);
  assert.match(referenced.allowlisted[0].reason, /not stack-owned/i);
});

test("validator fails on empty, missing, malformed, or drifted tag inventory", async () => {
  const { validateObservedTags } = await loadValidator();
  const expected = [{
    arn: "arn:aws:lambda:us-west-2:111122223333:function:Example",
    logicalResourceId: "Example",
    resourceType: "AWS::Lambda::Function",
    strategy: "resource-groups-tagging-api",
  }];
  const exactTags = [
    { Key: "auto-delete", Value: "no" },
    { Key: "managedBy", Value: "cdk" },
    { Key: "project", Value: "agentic-ai-platform-demo" },
  ];

  assert.throws(
    () => validateObservedTags([], new Map()),
    /no stack-owned taggable resources/i,
  );
  assert.throws(
    () => validateObservedTags(expected, new Map()),
    /missing from tag validation/i,
  );
  assert.throws(
    () => validateObservedTags(expected, new Map([
      [expected[0].arn, exactTags.slice(1)],
    ])),
    /auto-delete/i,
  );
  assert.throws(
    () => validateObservedTags(expected, new Map([
      [expected[0].arn, [
        ...exactTags.slice(0, 2),
        { Key: "project", Value: "wrong-project" },
      ]],
    ])),
    /project/i,
  );
  assert.throws(
    () => validateObservedTags(expected, new Map([
      [expected[0].arn, [
        ...exactTags,
        { Key: "project", Value: "duplicate" },
      ]],
    ])),
    /duplicate tag/i,
  );
  assert.doesNotThrow(() => validateObservedTags(expected, new Map([
    [expected[0].arn, [
      ...exactTags,
      { Key: "aws:cloudformation:stack-name", Value: "Example" },
    ]],
  ])));
});
