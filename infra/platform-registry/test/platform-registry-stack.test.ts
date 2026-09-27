import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildSeedRecords } from "../bin/app";
import {
  PROVISIONED_LAMBDA_NAME_MAX_LENGTH,
  PROVISIONED_RESOURCE_NAME_PREFIX,
  PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH,
  deploymentNameSuffix,
  deriveGatewayName,
  resolveControlPlaneConfig,
  type ResolvedControlPlaneConfig,
} from "../lib/control-plane-config";
import {
  PlatformRegistryStack,
  type SeedRecord,
} from "../lib/platform-registry-stack";

const DOMAINS = [
  {
    id: "platform",
    name: "Platform",
    description: "Platform domain registry",
  },
  {
    id: "customer-support",
    name: "Customer Support",
    description: "Customer Support domain registry",
  },
  {
    id: "operations",
    name: "Operations",
    description: "Operations domain registry",
  },
];

const REFERENCE_CONFIG = resolveControlPlaneConfig({
  mode: "reference-existing",
  region: "us-west-2",
  account: "111122223333",
  sharedRegistryId: "SharedReg123456",
  domainRegistryIds: {
    platform: "PlatformReg1234",
    customer_support: "CustomerReg1234",
    operations: "OperatioReg1234",
  },
  llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
  llmGatewayRegion: "us-east-1",
  toolsGatewayId: "platform-tools-gw-klmnopqrst",
});
if (REFERENCE_CONFIG.mode !== "reference-existing") {
  throw new Error("Expected reference-existing test configuration");
}

const PROVISION_SCOPE = {
  account: "111111111111",
  region: "us-west-2",
} as const;
const PROVISION_CONFIG = resolveControlPlaneConfig({
  mode: "provision",
  region: PROVISION_SCOPE.region,
  account: PROVISION_SCOPE.account,
});
// Gateway names are deployment-scoped, so the expected template values come
// from the same derivation the stack uses rather than a hardcoded literal.
const EXPECTED_LLM_GATEWAY_NAME = deriveGatewayName("llm", PROVISION_SCOPE);
const EXPECTED_TOOLS_GATEWAY_NAME = deriveGatewayName(
  "tools",
  PROVISION_SCOPE,
);
const PROVISION_REGISTRY_ARN =
  "arn:<AWS::Partition>:agent-registry:us-west-2:111111111111:registry/*";
const PROVISION_REGISTRY_REQUEST_TAG_CONDITION = {
  "ForAllValues:StringEquals": {
    "aws:TagKeys": ["auto-delete", "managedBy", "project"],
  },
  StringEquals: {
    "aws:RequestTag/auto-delete": "no",
    "aws:RequestTag/managedBy": "cdk",
    "aws:RequestTag/project": "agentic-ai-platform-demo",
    "aws:RequestedRegion": "us-west-2",
  },
};
const PROVISION_REGISTRY_RESOURCE_TAG_CONDITION = {
  StringEquals: {
    "aws:ResourceTag/auto-delete": "no",
    "aws:ResourceTag/managedBy": "cdk",
    "aws:ResourceTag/project": "agentic-ai-platform-demo",
  },
};
const PROVISION_REGISTRY_CREATE_RECORD_CONDITION = {
  "ForAllValues:StringEquals":
    PROVISION_REGISTRY_REQUEST_TAG_CONDITION["ForAllValues:StringEquals"],
  StringEquals: {
    ...PROVISION_REGISTRY_REQUEST_TAG_CONDITION.StringEquals,
    ...PROVISION_REGISTRY_RESOURCE_TAG_CONDITION.StringEquals,
  },
};
const PROVISION_REGISTRY_TAG_MUTATION_CONDITION = {
  "ForAllValues:StringEquals": {
    "aws:TagKeys": ["auto-delete", "managedBy", "project"],
  },
  StringEquals: {
    "aws:RequestTag/auto-delete": "no",
    "aws:RequestTag/managedBy": "cdk",
    "aws:RequestTag/project": "agentic-ai-platform-demo",
    "aws:RequestedRegion": "us-west-2",
    "aws:ResourceTag/auto-delete": "no",
    "aws:ResourceTag/managedBy": "cdk",
    "aws:ResourceTag/project": "agentic-ai-platform-demo",
  },
};

const SEED_RECORD: SeedRecord = {
  registryRef: "shared",
  name: "blueprint_test",
  displayName: "Test Blueprint",
  recordType: "CUSTOM",
  descriptors: {
    custom: {
      data: JSON.stringify({
        schemaVersion: 1,
        resourceKind: "blueprint",
        "x-platform": {
          domainId: "shared",
          ownerSubject: "platform-bootstrap",
          resourceId: "test-blueprint",
          resourceType: "BLUEPRINT",
          shared: true,
        },
      }),
    },
  },
  version: "1.0.0-platform-descriptor.1",
  status: "APPROVED",
  description: "Verifies that seed records are provision-only",
};

function loadRealSeedRecords(): SeedRecord[] {
  const consoleDir = path.resolve(__dirname, "..", "..", "..", "console");
  const seed = JSON.parse(
    fs.readFileSync(path.join(consoleDir, "registry-seed.json"), "utf8"),
  );
  const catalog = JSON.parse(
    fs.readFileSync(path.join(consoleDir, "catalog.json"), "utf8"),
  );
  return buildSeedRecords(seed, catalog);
}

const REAL_SEED_RECORDS = loadRealSeedRecords();

const EXPECTED_OUTPUT_EXPORTS = {
  SharedRegistryId: "AgenticPlatform-ControlPlane-SharedRegistryId",
  SharedRegistryArn: "AgenticPlatform-ControlPlane-SharedRegistryArn",
  RegistryPlatformId:
    "AgenticPlatform-ControlPlane-Registry-platform-Id",
  RegistryPlatformArn:
    "AgenticPlatform-ControlPlane-Registry-platform-Arn",
  RegistryCustomerSupportId:
    "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
  RegistryCustomerSupportArn:
    "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
  RegistryOperationsId:
    "AgenticPlatform-ControlPlane-Registry-operations-Id",
  RegistryOperationsArn:
    "AgenticPlatform-ControlPlane-Registry-operations-Arn",
  LlmGatewayId: "AgenticPlatform-ControlPlane-LlmGatewayId",
  LlmGatewayArn: "AgenticPlatform-ControlPlane-LlmGatewayArn",
  LlmGatewayUrl: "AgenticPlatform-ControlPlane-LlmGatewayUrl",
  LlmGatewayRegion: "AgenticPlatform-ControlPlane-LlmGatewayRegion",
  ToolsGatewayId: "AgenticPlatform-ControlPlane-ToolsGatewayId",
  ToolsGatewayArn: "AgenticPlatform-ControlPlane-ToolsGatewayArn",
  ToolsGatewayUrl: "AgenticPlatform-ControlPlane-ToolsGatewayUrl",
  Region: "AgenticPlatform-ControlPlane-Region",
  ControlPlaneConfigParameterName:
    "AgenticPlatform-ControlPlane-ConfigParameterName",
} as const;

function synthesize(
  config: ResolvedControlPlaneConfig,
  seedRecords: SeedRecord[] = [],
  tags?: Record<string, string>,
): {
  stack: PlatformRegistryStack;
  template: Template;
  document: Record<string, any>;
} {
  const app = new cdk.App();
  const stack = new PlatformRegistryStack(app, "ControlPlaneUnderTest", {
    env: {
      account: config.account,
      region: config.region,
    },
    config,
    domains: DOMAINS,
    seedRecords,
    tags,
  });
  const template = Template.fromStack(stack);
  return {
    stack,
    template,
    document: template.toJSON(),
  };
}

function assertStableOutputContract(document: Record<string, any>): void {
  assert.deepEqual(
    Object.keys(document.Outputs).sort(),
    Object.keys(EXPECTED_OUTPUT_EXPORTS).sort(),
  );

  for (const [outputName, exportName] of Object.entries(
    EXPECTED_OUTPUT_EXPORTS,
  )) {
    assert.equal(document.Outputs[outputName].Export.Name, exportName);
  }
}

function policyStatements(document: Record<string, any>): Record<string, any>[] {
  return Object.values(document.Resources)
    .filter((resource: any) => resource.Type === "AWS::IAM::Policy")
    .flatMap(
      (resource: any) =>
        resource.Properties.PolicyDocument.Statement ?? [],
    );
}

function statementActions(statement: Record<string, any>): string[] {
  return Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action];
}

function normalizeResource(resource: any): string {
  if (typeof resource === "string") {
    return resource;
  }
  const join = resource?.["Fn::Join"];
  if (Array.isArray(join) && Array.isArray(join[1])) {
    return join[1]
      .map((part: any) =>
        part?.Ref === "AWS::Partition" ? "<AWS::Partition>" : String(part)
      )
      .join(join[0]);
  }
  return JSON.stringify(resource);
}

function statementResources(statement: Record<string, any>): string[] {
  const resources = Array.isArray(statement.Resource)
    ? statement.Resource
    : [statement.Resource];
  return resources.map(normalizeResource);
}

test("mandatory resource tags override conflicting StackProps tags", () => {
  const { template } = synthesize(REFERENCE_CONFIG, [], {
    "auto-delete": "yes",
    managedBy: "manual",
    project: "other-project",
    owner: "platform-team",
  });

  template.hasResourceProperties("AWS::SSM::Parameter", {
    Tags: {
      "auto-delete": "no",
      managedBy: "cdk",
      owner: "platform-team",
      project: "agentic-ai-platform-demo",
    },
  });
});

test("reference-existing mode references the external inference Gateway without taking target ownership", () => {
  const { stack, template, document } = synthesize(
    REFERENCE_CONFIG,
    [SEED_RECORD],
  );

  assert.equal(stack.stackName, "AgenticPlatform-ControlPlane");
  template.resourceCountIs("AWS::SSM::Parameter", 1);
  template.resourceCountIs("AWS::Lambda::Function", 0);
  template.resourceCountIs("AWS::CloudFormation::CustomResource", 0);
  template.resourceCountIs("AWS::BedrockAgentCore::Gateway", 0);
  template.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 0);
  template.resourceCountIs("AWS::IAM::Role", 0);
  template.resourceCountIs("AWS::IAM::Policy", 0);
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: "/agentic-platform/control-plane/config",
    Type: "String",
    Tags: {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  });

  assertStableOutputContract(document);
  assert.equal(
    document.Outputs.SharedRegistryId.Value,
    REFERENCE_CONFIG.sharedRegistryId,
  );
  assert.equal(
    document.Outputs.SharedRegistryArn.Value,
    REFERENCE_CONFIG.sharedRegistryArn,
  );
  assert.equal(
    document.Outputs.RegistryPlatformId.Value,
    REFERENCE_CONFIG.domainRegistryIds.platform,
  );
  assert.equal(
    document.Outputs.RegistryPlatformArn.Value,
    REFERENCE_CONFIG.domainRegistryArns.platform,
  );
  assert.equal(
    document.Outputs.RegistryCustomerSupportId.Value,
    REFERENCE_CONFIG.domainRegistryIds.customer_support,
  );
  assert.equal(
    document.Outputs.RegistryCustomerSupportArn.Value,
    REFERENCE_CONFIG.domainRegistryArns.customer_support,
  );
  assert.equal(
    document.Outputs.RegistryOperationsId.Value,
    REFERENCE_CONFIG.domainRegistryIds.operations,
  );
  assert.equal(
    document.Outputs.RegistryOperationsArn.Value,
    REFERENCE_CONFIG.domainRegistryArns.operations,
  );
  assert.equal(
    document.Outputs.LlmGatewayId.Value,
    REFERENCE_CONFIG.llmGatewayId,
  );
  assert.equal(
    document.Outputs.LlmGatewayArn.Value,
    REFERENCE_CONFIG.llmGatewayArn,
  );
  assert.equal(
    document.Outputs.LlmGatewayUrl.Value,
    REFERENCE_CONFIG.llmGatewayUrl,
  );
  assert.equal(
    document.Outputs.LlmGatewayRegion.Value,
    REFERENCE_CONFIG.llmGatewayRegion,
  );
  assert.equal(
    document.Outputs.ToolsGatewayId.Value,
    REFERENCE_CONFIG.toolsGatewayId,
  );
  assert.equal(
    document.Outputs.ToolsGatewayArn.Value,
    REFERENCE_CONFIG.toolsGatewayArn,
  );
  assert.equal(
    document.Outputs.ToolsGatewayUrl.Value,
    REFERENCE_CONFIG.toolsGatewayUrl,
  );
  assert.equal(document.Outputs.Region.Value, "us-west-2");
});

test("provision mode creates the portable control plane and the same output contract", () => {
  const { stack, template, document } = synthesize(
    PROVISION_CONFIG,
    [SEED_RECORD],
  );

  assert.equal(stack.stackName, "AgenticPlatform-ControlPlane-Provisioned");
  template.resourceCountIs("AWS::SSM::Parameter", 1);
  template.resourceCountIs("AWS::IAM::ManagedPolicy", 1);
  template.resourceCountIs("AWS::BedrockAgentCore::Gateway", 2);
  template.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 3);
  template.hasResourceProperties("AWS::IAM::ManagedPolicy", {
    ManagedPolicyName:
      "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary",
  });

  const customResources = Object.values(
    template.findResources("AWS::CloudFormation::CustomResource"),
  ) as Array<{ Properties: Record<string, any> }>;
  const registries = customResources.filter(
    (resource) => resource.Properties.ResourceType === "Registry",
  );
  const records = customResources.filter(
    (resource) => resource.Properties.ResourceType === "RegistryRecord",
  );
  const boundaryTags = customResources.filter(
    (resource) =>
      resource.Properties.ResourceType === "ManagedPolicyTags",
  );
  assert.deepEqual(
    registries
      .map((resource) => resource.Properties.RegistryName)
      .sort(),
    [
      "domain_customer_support",
      "domain_operations",
      "domain_platform",
      "platform_shared",
    ],
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].Properties.RecordName, "blueprint_test");
  assert.equal(boundaryTags.length, 1);
  assert.deepEqual(boundaryTags[0].Properties.Tags, {
    "auto-delete": "no",
    managedBy: "cdk",
    project: "agentic-ai-platform-demo",
  });

  const gateways = Object.values(
    template.findResources("AWS::BedrockAgentCore::Gateway"),
  ) as Array<{ Properties: Record<string, any> }>;
  assert.deepEqual(
    gateways.map((resource) => resource.Properties.Name).sort(),
    [EXPECTED_LLM_GATEWAY_NAME, EXPECTED_TOOLS_GATEWAY_NAME].sort(),
  );
  // Every provisioned gateway name must be fully resolved at synth time (a
  // plain string, not a CloudFormation token) and must carry the
  // deployment-scoped suffix so a second account cannot collide.
  for (const resource of gateways) {
    assert.equal(typeof resource.Properties.Name, "string");
    assert.match(resource.Properties.Name, /-[0-9a-f]{8}$/);
  }
  for (const gateway of gateways) {
    assert.deepEqual(gateway.Properties.Tags, {
      "auto-delete": "no",
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    });
  }

  const targets = Object.values(
    template.findResources("AWS::BedrockAgentCore::GatewayTarget"),
  ) as Array<{ Properties: Record<string, any> }>;
  assert.deepEqual(
    targets.map((resource) => resource.Properties.Name).sort(),
    ["aws-docs", "bedrock-claude", "bedrock-mantle"],
  );
  const claudeTarget = targets.find(
    (resource) => resource.Properties.Name === "bedrock-claude",
  );
  assert.deepEqual(claudeTarget?.Properties.TargetConfiguration, {
    Inference: {
      Provider: {
        Endpoint: "https://bedrock-mantle.us-west-2.api.aws",
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
  });

  assertStableOutputContract(document);
});

test("provisioned runtime resources carry the explicit boundary-matching name prefix", () => {
  const { template, document } = synthesize(
    PROVISION_CONFIG,
    [SEED_RECORD],
  );
  const suffix = deploymentNameSuffix(PROVISION_SCOPE);
  const namePattern = new RegExp(
    `^${PROVISIONED_RESOURCE_NAME_PREFIX}-[a-z0-9-]+-${suffix}$`,
  );

  // Every provider Lambda (2 handlers + 3 framework functions) must carry an
  // explicit synth-time name with the boundary prefix; CFN-generated names
  // truncate the stack name and never match the boundary wildcard.
  const functions = Object.entries(
    template.findResources("AWS::Lambda::Function"),
  ) as Array<[string, { Properties: Record<string, any> }]>;
  assert.equal(functions.length, 5);
  for (const [logicalId, fn] of functions) {
    const name = fn.Properties.FunctionName;
    assert.equal(
      typeof name,
      "string",
      `${logicalId} must have an explicit FunctionName`,
    );
    assert.match(name, namePattern, logicalId);
    assert.ok(
      name.length <= PROVISIONED_LAMBDA_NAME_MAX_LENGTH,
      `${logicalId} name exceeds ${PROVISIONED_LAMBDA_NAME_MAX_LENGTH}`,
    );
  }
  assert.equal(
    new Set(functions.map(([, fn]) => fn.Properties.FunctionName)).size,
    functions.length,
  );

  // The provider waiter state machine gets no stack-name prefix at all from
  // CFN, so it too must be explicitly named.
  const stateMachines = Object.entries(
    template.findResources("AWS::StepFunctions::StateMachine"),
  ) as Array<[string, { Properties: Record<string, any> }]>;
  assert.equal(stateMachines.length, 1);
  const [waiterId, waiter] = stateMachines[0];
  const waiterName = waiter.Properties.StateMachineName;
  assert.equal(typeof waiterName, "string", waiterId);
  assert.match(waiterName, namePattern, waiterId);
  assert.ok(
    waiterName.length <= PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH,
  );

  // The boundary must gate lambda/states access on exactly that prefix.
  const boundary = Object.values(document.Resources).find(
    (resource: any) => resource.Type === "AWS::IAM::ManagedPolicy",
  ) as any;
  const boundaryResources = boundary.Properties.PolicyDocument.Statement
    .flatMap((statement: any) => statementResources(statement));
  assert.ok(
    boundaryResources.includes(
      "arn:<AWS::Partition>:lambda:us-west-2:111111111111:function:"
        + `${PROVISIONED_RESOURCE_NAME_PREFIX}-*`,
    ),
    `boundary lambda resource missing; got ${boundaryResources}`,
  );
  assert.ok(
    boundaryResources.includes(
      "arn:<AWS::Partition>:states:us-west-2:111111111111:stateMachine:"
        + `${PROVISIONED_RESOURCE_NAME_PREFIX}-*`,
    ),
    `boundary states resource missing; got ${boundaryResources}`,
  );
  // The log-group statement keeps matching on the stack name: CFN gives log
  // groups the full 40-character stack-name prefix, so it works as-is.
  // intentional literal: sentinel — asserts logs section unchanged
  assert.ok(
    boundaryResources.includes(
      "arn:<AWS::Partition>:logs:us-west-2:111111111111:"
        + "log-group:AgenticPlatform-ControlPlane-Provisioned-*:*",
    ),
    `boundary logs resource missing; got ${boundaryResources}`,
  );
});

test("every provisioned IAM role uses the exact control-plane runtime boundary", () => {
  const { template, document } = synthesize(
    PROVISION_CONFIG,
    [SEED_RECORD],
  );
  const roles = Object.entries(
    template.findResources("AWS::IAM::Role"),
  );
  const boundaryEntry = Object.entries(document.Resources).find(
    ([, resource]: [string, any]) =>
      resource.Type === "AWS::IAM::ManagedPolicy"
      && resource.Properties.ManagedPolicyName
        === "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary",
  );
  assert.ok(boundaryEntry);
  const [boundaryLogicalId] = boundaryEntry;

  assert.equal(roles.length, 8);
  for (const [logicalId, role] of roles) {
    assert.deepEqual(
      (role as any).Properties.PermissionsBoundary,
      { Ref: boundaryLogicalId },
      `${logicalId} must use the exact provision boundary`,
    );
  }
});

test("Agent Registry service-linked-role creation is exact and service constrained", () => {
  const { document } = synthesize(PROVISION_CONFIG, [SEED_RECORD]);
  const statements = policyStatements(document).filter((statement) =>
    statementActions(statement).includes("iam:CreateServiceLinkedRole")
  );

  assert.equal(statements.length, 1);
  assert.deepEqual(statementActions(statements[0]), [
    "iam:CreateServiceLinkedRole",
  ]);
  assert.deepEqual(statementResources(statements[0]), [
    "arn:<AWS::Partition>:iam::111111111111:role/aws-service-role/"
      + "agent-registry.amazonaws.com/AWSServiceRoleForAgentRegistry",
  ]);
  assert.deepEqual(statements[0].Condition, {
    StringEquals: {
      "iam:AWSServiceName": "agent-registry.amazonaws.com",
    },
  });
});

test("provision Registry mutations remain confined to mandatory-tagged resources", () => {
  const { document } = synthesize(PROVISION_CONFIG, [SEED_RECORD]);
  const statements = policyStatements(document);
  const createStatements = statements.filter((statement) =>
    statementActions(statement).includes("agent-registry:CreateRegistry")
  );
  const createRecordStatements = statements.filter((statement) =>
    statementActions(statement).includes(
      "agent-registry:CreateRegistryRecord",
    )
  );
  const tagStatements = statements.filter((statement) =>
    statementActions(statement).includes("agent-registry:TagResource")
  );
  const destructiveStatements = statements.filter((statement) =>
    statementActions(statement).some((action) =>
      [
        "agent-registry:DeleteRegistry",
        "agent-registry:DeleteRegistryRecord",
      ].includes(action)
    )
  );

  assert.equal(createStatements.length, 1);
  assert.deepEqual(statementActions(createStatements[0]), [
    "agent-registry:CreateRegistry",
  ]);
  assert.deepEqual(statementResources(createStatements[0]), ["*"]);
  assert.deepEqual(
    createStatements[0].Condition,
    PROVISION_REGISTRY_REQUEST_TAG_CONDITION,
  );

  assert.equal(createRecordStatements.length, 1);
  assert.deepEqual(
    createRecordStatements[0].Condition,
    PROVISION_REGISTRY_CREATE_RECORD_CONDITION,
  );

  assert.equal(tagStatements.length, 1);
  assert.deepEqual(statementActions(tagStatements[0]), [
    "agent-registry:TagResource",
  ]);
  assert.deepEqual(statementResources(tagStatements[0]), [
    PROVISION_REGISTRY_ARN,
  ]);
  assert.deepEqual(
    tagStatements[0].Condition,
    PROVISION_REGISTRY_TAG_MUTATION_CONDITION,
  );

  assert.ok(destructiveStatements.length > 0);
  for (const statement of destructiveStatements) {
    assert.deepEqual(
      statement.Condition,
      PROVISION_REGISTRY_RESOURCE_TAG_CONDITION,
    );
  }
});

test("the real 23 seeds synthesize with unique canonical identities", () => {
  assert.equal(REAL_SEED_RECORDS.length, 23);
  const { template } = synthesize(PROVISION_CONFIG, REAL_SEED_RECORDS);
  const records = Object.values(
    template.findResources("AWS::CloudFormation::CustomResource"),
  ).filter(
    (resource: any) =>
      resource.Properties.ResourceType === "RegistryRecord",
  ) as Array<{ Properties: Record<string, any> }>;

  assert.equal(records.length, 23);
  const identities = records.map((resource) =>
    [
      JSON.stringify(resource.Properties.RegistryId),
      resource.Properties.RecordName,
      resource.Properties.RecordVersion,
    ].join("|"),
  );
  assert.equal(new Set(identities).size, 23);
  assert.deepEqual(
    new Set(records.map((resource) => resource.Properties.StatusTarget)),
    new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED"]),
  );
  const contractReview = records.find(
    (resource) =>
      resource.Properties.RecordName === "a2a_contract_review",
  );
  assert.equal(
    contractReview?.Properties.StatusTarget,
    "PENDING_APPROVAL",
  );
});

test("reordering the real seeds preserves every record logical ID", () => {
  const first = synthesize(PROVISION_CONFIG, REAL_SEED_RECORDS).document;
  const reordered = synthesize(
    PROVISION_CONFIG,
    [...REAL_SEED_RECORDS].reverse(),
  ).document;

  const logicalIdsByIdentity = (document: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(document.Resources)
        .filter(
          ([, resource]: [string, any]) =>
            resource.Type === "AWS::CloudFormation::CustomResource"
            && resource.Properties.ResourceType === "RegistryRecord",
        )
        .map(([logicalId, resource]: [string, any]) => [
          [
            JSON.stringify(resource.Properties.RegistryId),
            resource.Properties.RecordName,
            resource.Properties.RecordVersion,
          ].join("|"),
          logicalId,
        ]),
    );

  assert.deepEqual(
    logicalIdsByIdentity(reordered),
    logicalIdsByIdentity(first),
  );
});

test("duplicate canonical record identities are rejected", () => {
  const duplicateA: SeedRecord = {
    ...SEED_RECORD,
    name: "blueprint_duplicate-name",
  };
  const duplicateB: SeedRecord = {
    ...SEED_RECORD,
    name: "blueprint_duplicate_name",
  };

  assert.throws(
    () => synthesize(PROVISION_CONFIG, [duplicateA, duplicateB]),
    /Duplicate canonical seed record identity: shared\/blueprint_duplicate_name@1\.0\.0-platform-descriptor\.1/,
  );
});

test("malformed or unsuffixed governed seeds are rejected before synthesis", () => {
  assert.throws(
    () => synthesize(PROVISION_CONFIG, [{
      ...SEED_RECORD,
      version: "1.0.0",
    }]),
    /governed seed record version/i,
  );
  assert.throws(
    () => synthesize(PROVISION_CONFIG, [{
      ...SEED_RECORD,
      version: "1.0.0-01.platform-descriptor.1",
    }]),
    /governed seed record version/i,
  );

  const malformed = structuredClone(SEED_RECORD);
  const descriptor = JSON.parse(malformed.descriptors.custom.data);
  descriptor.schemaVersion = 2;
  malformed.descriptors.custom.data = JSON.stringify(descriptor);
  assert.throws(
    () => synthesize(PROVISION_CONFIG, [malformed]),
    /governed seed descriptor/i,
  );
});

test("one canonical governed record may carry multiple unique versions", () => {
  assert.doesNotThrow(
    () => synthesize(PROVISION_CONFIG, [
      SEED_RECORD,
      {
        ...SEED_RECORD,
        version: "2.0.0-platform-descriptor.1",
      },
    ]),
  );
});

test("versioned governed records cannot change logical identity", () => {
  const drifted = structuredClone(SEED_RECORD);
  drifted.version = "2.0.0-platform-descriptor.1";
  const descriptor = JSON.parse(drifted.descriptors.custom.data);
  descriptor["x-platform"].resourceId = "replacement-blueprint";
  drifted.descriptors.custom.data = JSON.stringify(descriptor);

  assert.throws(
    () => synthesize(PROVISION_CONFIG, [SEED_RECORD, drifted]),
    /Governed seed name identity drift: shared\/blueprint_test/,
  );
});

test("different seed names cannot claim the same governed logical identity", () => {
  assert.throws(
    () => synthesize(PROVISION_CONFIG, [
      SEED_RECORD,
      {
        ...SEED_RECORD,
        name: "blueprint_other_name",
      },
    ]),
    /Duplicate governed seed logical identity: shared\/BLUEPRINT\/test-blueprint/,
  );
});

test("unknown seed registry references are rejected", () => {
  assert.throws(
    () =>
      synthesize(PROVISION_CONFIG, [
        {
          ...SEED_RECORD,
          registryRef: "unknown-domain",
        },
      ]),
    /Unknown seed registryRef: unknown-domain/,
  );
});

test("the asynchronous Registry provider uses explicit tagged log groups", () => {
  const { template, document } = synthesize(PROVISION_CONFIG, [SEED_RECORD]);

  template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
  const functions = Object.values(
    template.findResources("AWS::Lambda::Function"),
  ) as Array<{ Properties: Record<string, any> }>;
  assert.ok(
    functions.some(
      (fn) => fn.Properties.Handler === "registry_handler.handler",
    ),
  );
  assert.ok(
    functions.some(
      (fn) =>
        fn.Properties.Handler === "registry_handler.is_complete_handler",
    ),
  );

  const logGroups = Object.values(
    template.findResources("AWS::Logs::LogGroup"),
  ) as Array<Record<string, any>>;
  assert.equal(logGroups.length, 3);
  for (const logGroup of logGroups) {
    assert.equal(logGroup.Properties.RetentionInDays, 90);
    assert.deepEqual(logGroup.Properties.Tags, [
      { Key: "auto-delete", Value: "no" },
      { Key: "managedBy", Value: "cdk" },
      { Key: "project", Value: "agentic-ai-platform-demo" },
    ]);
    assert.equal(logGroup.DeletionPolicy, "Retain");
    assert.equal(logGroup.UpdateReplacePolicy, "Retain");
    assert.equal(logGroup.Properties.LogGroupName, undefined);
  }

  const synthesized = JSON.stringify(document);
  assert.match(synthesized, /registry_handler\.is_complete_handler/);
  assert.match(synthesized, /\\"IntervalSeconds\\":10/);
  assert.match(synthesized, /\\"MaxAttempts\\":60/);
});

test("gateway roles have separate least-privilege trust and Mantle policies", () => {
  const { template } = synthesize(PROVISION_CONFIG, [SEED_RECORD]);
  const roles = template.findResources("AWS::IAM::Role") as Record<
    string,
    any
  >;
  const roleEntry = (description: string) => {
    const entry = Object.entries(roles).find(
      ([, role]) => role.Properties.Description === description,
    );
    assert.ok(entry, `Missing IAM role: ${description}`);
    return entry;
  };
  const [llmRoleId, llmRole] = roleEntry(
    "IAM role for the platform LLM Gateway",
  );
  const [toolsRoleId, toolsRole] = roleEntry(
    "IAM role for the platform tools Gateway",
  );
  const expectedTrustCondition = {
    ArnLike: {
      "aws:SourceArn": {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":bedrock-agentcore:us-west-2:111111111111:gateway/*",
          ],
        ],
      },
    },
    StringEquals: {
      "aws:SourceAccount": "111111111111",
    },
  };
  assert.deepEqual(
    llmRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition,
    expectedTrustCondition,
  );
  assert.deepEqual(
    toolsRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition,
    expectedTrustCondition,
  );

  const gateways = Object.values(
    template.findResources("AWS::BedrockAgentCore::Gateway"),
  ) as Array<{ Properties: Record<string, any> }>;
  const llmGateway = gateways.find(
    (gateway) =>
      gateway.Properties.Name === EXPECTED_LLM_GATEWAY_NAME,
  );
  const toolsGateway = gateways.find(
    (gateway) => gateway.Properties.Name === EXPECTED_TOOLS_GATEWAY_NAME,
  );
  assert.deepEqual(llmGateway?.Properties.RoleArn, {
    "Fn::GetAtt": [llmRoleId, "Arn"],
  });
  assert.deepEqual(toolsGateway?.Properties.RoleArn, {
    "Fn::GetAtt": [toolsRoleId, "Arn"],
  });

  const policies = Object.values(
    template.findResources("AWS::IAM::Policy"),
  ) as Array<{ Properties: Record<string, any> }>;
  const policiesForRole = (logicalId: string) =>
    policies.filter((policy) =>
      (policy.Properties.Roles ?? []).some(
        (role: any) => role.Ref === logicalId,
      ),
    );
  const llmStatements = policiesForRole(llmRoleId).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement,
  );
  assert.deepEqual(llmStatements, [
    {
      Action: [
        "bedrock-mantle:CreateInference",
        "bedrock-mantle:GetModel",
        "bedrock-mantle:GetProject",
        "bedrock-mantle:ListModels",
      ],
      Effect: "Allow",
      Resource: {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            ":bedrock-mantle:us-west-2:111111111111:project/default",
          ],
        ],
      },
    },
    {
      Action: [
        "bedrock-mantle:ListProjects",
        "bedrock-mantle:ListTagsForResource",
      ],
      Effect: "Allow",
      Resource: "*",
    },
  ]);

  const toolsStatements = policiesForRole(toolsRoleId).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement,
  );
  assert.equal(
    toolsStatements.some((statement: any) =>
      JSON.stringify(statement.Action).match(
        /bedrock|mantle|InvokeModel|CreateInference/,
      ),
    ),
    false,
  );
});
