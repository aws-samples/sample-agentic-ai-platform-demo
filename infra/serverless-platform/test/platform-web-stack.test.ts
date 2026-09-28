import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import {
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
  RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  runtimePermissionsBoundaryDocument,
} from "../lib/config";
import { PlatformWebStack } from "../lib/platform-web-stack";

type CfnResource = {
  DeletionPolicy?: string;
  DependsOn?: string | string[];
  Metadata?: Record<string, any>;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, any>;
};

const EXPECTED_TAGS = {
  "auto-delete": "no",
  managedBy: "cdk",
  project: "agentic-ai-platform-demo",
};
const HOSTED_ACCEPTANCE_ROLE_NAME =
  "AgenticPlatform-Web-HostedAcceptanceRole";
const HOSTED_ACCEPTANCE_BROKER_ROLE_NAME =
  "AgenticPlatform-Web-HostedAcceptanceBrokerRole";
const HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME =
  "AgenticPlatform-Web-HostedAcceptanceBroker";
const PLATFORM_ADMIN_API_ROLE_NAME =
  "AgenticPlatform-Web-PlatformAdminApiRole";
const REGISTRY_DECISION_FINALIZER_ROLE_NAME =
  "AgenticPlatform-Web-RegistryDecisionFinalizerRole";
const GITHUB_DEPLOY_ROLE_ARN =
  "arn:<AWS::Partition>:iam::111122223333:"
  + "role/AgenticPlatformGitHubDeployRole";
const LLM_GATEWAY_ID = "agentic-demo-llm-gateway-abcdefghij";
const LLM_GATEWAY_REGION = "us-east-1";
const LLM_GATEWAY_URL =
  `https://${LLM_GATEWAY_ID}.gateway.bedrock-agentcore.`
  + `${LLM_GATEWAY_REGION}.amazonaws.com/inference/v1`;

const CONTROL_PLANE_EXPORTS = [
  "AgenticPlatform-ControlPlane-SharedRegistryId",
  "AgenticPlatform-ControlPlane-SharedRegistryArn",
  "AgenticPlatform-ControlPlane-Registry-platform-Id",
  "AgenticPlatform-ControlPlane-Registry-platform-Arn",
  "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
  "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
  "AgenticPlatform-ControlPlane-Registry-operations-Id",
  "AgenticPlatform-ControlPlane-Registry-operations-Arn",
  "AgenticPlatform-ControlPlane-ToolsGatewayId",
  "AgenticPlatform-ControlPlane-ToolsGatewayArn",
  "AgenticPlatform-ControlPlane-ToolsGatewayUrl",
  "AgenticPlatform-ControlPlane-Region",
] as const;

const importMarker = (exportName: string) => `<<import:${exportName}>>`;

function createStack(id = "TestWeb") {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, id, {
    env: { account: "111122223333", region: "us-west-2" },
    cognitoDomainPrefix: "agentic-platform-test",
    llmGatewayId: LLM_GATEWAY_ID,
    llmGatewayRegion: LLM_GATEWAY_REGION,
    demoItHelpdeskMemoryId: "ithelpdesk_testMemory-AbCd123456",
    demoSupportDeskMemoryId: "supportdesk_testMemory-AbCd123456",
    demoReportRunnerKnowledgeBaseId: "ABCDEFGHIJ",
    starterBuilderModelId:
      "bedrock-mantle/anthropic.claude-haiku-4-5",
  });
  return { app, stack, template: Template.fromStack(stack) };
}

function createOAuthStack(id = "TestWebOAuth") {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, id, {
    env: { account: "111122223333", region: "us-west-2" },
    cognitoDomainPrefix: "agentic-platform-test-oauth",
    githubOAuthClientId: "0123456789abcdefghij",
    githubOAuthClientSecretArn:
      "arn:aws:secretsmanager:us-west-2:111122223333:"
      + "secret:agentic-platform/github-oauth-ABC123",
    llmGatewayId: LLM_GATEWAY_ID,
    llmGatewayRegion: LLM_GATEWAY_REGION,
    starterBuilderModelId:
      "bedrock-mantle/anthropic.claude-haiku-4-5",
  });
  return { app, stack, template: Template.fromStack(stack) };
}

let cachedFixture: ReturnType<typeof createStack> | undefined;

function fixture() {
  cachedFixture ??= createStack();
  return cachedFixture;
}

test("demo functions share concurrency and reinstalls get a distinct trace destination", () => {
  const {template} = fixture();
  for (const resource of Object.values(template.findResources("AWS::Lambda::Function"))) {
    assert.equal(resource.Properties.ReservedConcurrentExecutions, undefined);
  }
  const destination = Object.values(template.findResources("AWS::Logs::DeliveryDestination"))
    .find(resource => resource.Properties.DeliveryDestinationType === "XRAY");
  assert.ok(destination);
  assert.deepEqual(destination.Properties.Name, {
    "Fn::Join": ["", ["AgenticPlatformWebGoverned", {
      "Fn::Join": ["", {"Fn::Split": ["-", {
        "Fn::Select": [2, {"Fn::Split": ["/", {"Ref": "AWS::StackId"}]}],
      }]}],
    }]],
  });
  const config = template.findResources("AWS::XRay::TransactionSearchConfig");
  assert.equal(Object.keys(config).length, 1);
  const configId = Object.keys(config)[0];
  assert.equal(config[configId].DeletionPolicy, "Retain");
  assert.ok(destination.DependsOn.includes(configId));
  const policies = Object.keys(template.findResources("AWS::XRay::ResourcePolicy"));
  for (const policyId of policies) assert.ok(destination.DependsOn.includes(policyId));
});

function resourceEntries(template: Template, type: string): Array<[string, CfnResource]> {
  return Object.entries(template.findResources(type)) as Array<[string, CfnResource]>;
}

function soleResource(template: Template, type: string): [string, CfnResource] {
  const resources = resourceEntries(template, type);
  assert.equal(resources.length, 1, `expected exactly one ${type}`);
  return resources[0];
}

function sharedRuntimeBoundary(template: Template): [string, CfnResource] {
  const resources = resourceEntries(template, 'AWS::IAM::ManagedPolicy').filter(([, policy]) =>
    policy.Properties?.ManagedPolicyName === RUNTIME_PERMISSIONS_BOUNDARY_NAME);
  assert.equal(resources.length, 1, 'exactly one shared runtime boundary');
  return resources[0];
}

function namedRole(template: Template, roleName: string): [string, CfnResource] {
  const match = resourceEntries(template, "AWS::IAM::Role").find(
    ([, role]) => role.Properties?.RoleName === roleName,
  );
  assert.ok(match, `missing role ${roleName}`);
  return match;
}

function normalizedArn(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const join = (value as Record<string, unknown>)["Fn::Join"];
  if (Array.isArray(join) && Array.isArray(join[1])) {
    return join[1].map((part) => {
      if (
        part
        && typeof part === "object"
        && (part as Record<string, unknown>).Ref === "AWS::Partition"
      ) {
        return "<AWS::Partition>";
      }
      return String(part);
    }).join(String(join[0]));
  }
  return JSON.stringify(value);
}

function normalizedTags(resource: CfnResource): Record<string, string> {
  const raw = resource.Properties?.UserPoolTags ?? resource.Properties?.Tags;
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((tag) => [tag.Key, tag.Value]));
  }
  return raw ?? {};
}

function cloudFrontRootUrl(distributionId: string) {
  return {
    "Fn::Join": [
      "",
      [
        "https://",
        { "Fn::GetAtt": [distributionId, "DomainName"] },
        "/",
      ],
    ],
  };
}

function cognitoHostedUrl(domainId: string) {
  return {
    "Fn::Join": [
      "",
      [
        "https://",
        { Ref: domainId },
        ".auth.us-west-2.amazoncognito.com",
      ],
    ],
  };
}

function iamStatements(template: Template) {
  const entries: Array<{
    owner: string;
    policyName: string;
    statement: Record<string, any>;
  }> = [];

  for (const [roleId, role] of resourceEntries(template, "AWS::IAM::Role")) {
    for (const policy of role.Properties?.Policies ?? []) {
      for (const statement of policy.PolicyDocument.Statement ?? []) {
        entries.push({
          owner: roleId,
          policyName: policy.PolicyName,
          statement,
        });
      }
    }
  }
  for (const [policyId, policy] of resourceEntries(template, "AWS::IAM::Policy")) {
    for (const statement of policy.Properties?.PolicyDocument?.Statement ?? []) {
      entries.push({
        owner: policyId,
        policyName: policy.Properties?.PolicyName,
        statement,
      });
    }
  }
  return entries;
}

function statementActions(statement: Record<string, any>): string[] {
  return (Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action]).sort();
}

function actionPatternMatches(pattern: string, action: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`).test(action);
}

function resourcePatternMatches(pattern: string, resource: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`).test(resource);
}

function collectImportValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectImportValues);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["Fn::ImportValue"] === "string") {
      return [record["Fn::ImportValue"]];
    }
    return Object.values(record).flatMap(collectImportValues);
  }
  return [];
}

function resolveImportValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(resolveImportValues);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["Fn::ImportValue"] === "string") {
      return importMarker(record["Fn::ImportValue"]);
    }
    const join = record["Fn::Join"];
    if (
      Array.isArray(join)
      && typeof join[0] === "string"
      && Array.isArray(join[1])
    ) {
      return join[1]
        .map((part) => String(resolveImportValues(part)))
        .join(join[0]);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [
        key,
        resolveImportValues(child),
      ]),
    );
  }
  return value;
}

function renderBoundaryTemplate(
  value: unknown,
  exactReplacements: Record<string, unknown> = {},
): unknown {
  if (typeof value === "string") {
    if (Object.hasOwn(exactReplacements, value)) {
      return exactReplacements[value];
    }
    return value
      .replaceAll("${PARTITION}", "<AWS::Partition>")
      .replaceAll("${REGION}", "us-west-2")
      .replaceAll("${ACCOUNT}", "111122223333")
      .replaceAll("${QUALIFIER}", cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER);
  }
  if (Array.isArray(value)) {
    return value.map((child) =>
      renderBoundaryTemplate(child, exactReplacements)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        renderBoundaryTemplate(child, exactReplacements),
      ]),
    );
  }
  return value;
}

function normalizeBoundaryPolicy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeBoundaryPolicy);
  }
  if (value && typeof value === "object") {
    const join = (value as Record<string, any>)["Fn::Join"];
    if (Array.isArray(join) && Array.isArray(join[1])) {
      return join[1]
        .map((part: any) => {
          if (part?.Ref === "AWS::Partition") return "<AWS::Partition>";
          const normalized = normalizeBoundaryPolicy(part);
          return typeof normalized === "string"
            ? normalized
            : JSON.stringify(normalized);
        })
        .join(join[0]);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeBoundaryPolicy(child),
      ]),
    );
  }
  return value;
}

function policyResourceIncludes(actual: unknown, expected: unknown): boolean {
  const actualResources = Array.isArray(actual) ? actual : [actual];
  const expectedResources = Array.isArray(expected) ? expected : [expected];
  const normalizedActual = actualResources.map(normalizeBoundaryPolicy);
  return expectedResources
    .map(normalizeBoundaryPolicy)
    .every((expectedResource) =>
      normalizedActual.some((actualResource) =>
        isDeepStrictEqual(actualResource, expectedResource)
        || (
          typeof actualResource === "string"
          && resourcePatternMatches(
            actualResource,
            typeof expectedResource === "string"
              ? expectedResource
              : JSON.stringify(expectedResource),
          )
        )
      )
    );
}

function canonicalBoundaryPolicy(value: unknown, key?: string): unknown {
  const normalized = normalizeBoundaryPolicy(value);
  if (key === "Action" || key === "Resource") {
    const values = Array.isArray(normalized) ? normalized : [normalized];
    return values
      .map((child) => canonicalBoundaryPolicy(child))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
  }
  if (Array.isArray(normalized)) {
    return normalized
      .map((child) => canonicalBoundaryPolicy(child))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
  }
  if (normalized && typeof normalized === "object") {
    return Object.fromEntries(
      Object.entries(normalized)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [
          childKey,
          canonicalBoundaryPolicy(child, childKey),
        ]),
    );
  }
  return normalized;
}

test("stack uses the required name and protects deployed resources", () => {
  const { stack } = fixture();
  assert.equal(stack.stackName, "AgenticPlatform-Web");
  assert.equal(stack.terminationProtection, true);
});

test("the twenty-five exact runtime roles have stable names and the fixed retained permissions boundary", () => {
  const { template } = fixture();
  const [boundaryId, boundary] = sharedRuntimeBoundary(template);

  assert.equal(
    boundary.Properties?.ManagedPolicyName,
    RUNTIME_PERMISSIONS_BOUNDARY_NAME,
  );
  assert.equal(boundary.DeletionPolicy, "Retain");
  assert.equal(boundary.UpdateReplacePolicy, "Retain");

  const roles = resourceEntries(template, "AWS::IAM::Role");
  assert.equal(roles.length, 27);
  const runtimeRoles = roles.filter(([, role]) =>
    Object.values(PLATFORM_WEB_RUNTIME_ROLE_NAMES).includes(
      role.Properties?.RoleName,
    )
  );
  assert.equal(runtimeRoles.length, 25);
  assert.deepEqual(
    runtimeRoles
      .map(([, role]) => role.Properties?.RoleName)
      .sort(),
    Object.values(PLATFORM_WEB_RUNTIME_ROLE_NAMES).sort(),
  );
  const operationsBoundaries = resourceEntries(template, 'AWS::IAM::ManagedPolicy')
    .filter(([, policy]) => policy.Properties?.ManagedPolicyName === 'AgenticPlatform-Web-OperationsBoundary');
  assert.equal(operationsBoundaries.length, 1);
  for (const [logicalId, role] of runtimeRoles) {
    const expectedBoundary = role.Properties?.RoleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi
      ? operationsBoundaries[0][0] : boundaryId;
    assert.deepEqual(
      role.Properties?.PermissionsBoundary,
      { Ref: expectedBoundary },
      `${logicalId} must use the runtime permissions boundary`,
    );
  }
  const [, hostedAcceptanceRole] = namedRole(
    template,
    HOSTED_ACCEPTANCE_ROLE_NAME,
  );
  assert.equal(hostedAcceptanceRole.Properties?.PermissionsBoundary, undefined);
});

test("all demo-role accepting APIs can read only current user and group state from the exact user pool", () => {
  const { template } = fixture();
  const [userPoolId] = soleResource(template, "AWS::Cognito::UserPool");

  for (const roleName of [
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.identityApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.journeyApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.controlPlaneReadApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformAdminApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.workspaceApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.builderApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.governanceApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi,
  ]) {
    const [roleId] = namedRole(template, roleName);
    const cognitoStatements = iamStatements(template)
      .filter(({ owner }) => owner === roleId)
      .map(({ statement }) => statement)
      .filter((statement) =>
        statementActions(statement).some((action) =>
          action.startsWith("cognito-idp:")
        )
      );
    assert.equal(
      cognitoStatements.length,
      roleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformAdminApi
        ? 2
        : 1,
      roleName,
    );
    const currentUserRead = cognitoStatements.find((statement) =>
      statementActions(statement).includes(
        "cognito-idp:AdminListGroupsForUser",
      )
    );
    assert.ok(currentUserRead, roleName);
    assert.deepEqual(
      statementActions(currentUserRead),
      [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminListGroupsForUser",
      ],
    );
    assert.deepEqual(currentUserRead.Resource, {
      "Fn::GetAtt": [userPoolId, "Arn"],
    });
    const groupLifecycle = cognitoStatements.find((statement) =>
      statementActions(statement).includes("cognito-idp:CreateGroup")
    );
    if (roleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformAdminApi) {
      assert.ok(groupLifecycle);
      assert.deepEqual(statementActions(groupLifecycle), [
        "cognito-idp:CreateGroup",
        "cognito-idp:DeleteGroup",
        "cognito-idp:GetGroup",
        "cognito-idp:ListUsersInGroup",
      ]);
      assert.deepEqual(groupLifecycle.Resource, {
        "Fn::GetAtt": [userPoolId, "Arn"],
      });
    } else {
      assert.equal(groupLifecycle, undefined, roleName);
    }
  }
});

test("platform state table is retained, protected, encrypted, tagged, and point-in-time recoverable", () => {
  const { template } = fixture();
  const [tableId, table] = soleResource(template, "AWS::DynamoDB::Table");

  assert.deepEqual(
    [...(table.Properties?.AttributeDefinitions ?? [])].sort(
      (left, right) =>
        left.AttributeName.localeCompare(right.AttributeName),
    ),
    [
    { AttributeName: "entityType", AttributeType: "S" },
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
    ],
  );
  assert.deepEqual(table.Properties?.KeySchema, [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ]);
  assert.deepEqual(table.Properties?.GlobalSecondaryIndexes, [
    {
      IndexName: "EntityTypeIndex",
      KeySchema: [
        { AttributeName: "entityType", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ]);
  assert.equal(table.Properties?.BillingMode, "PAY_PER_REQUEST");
  assert.deepEqual(table.Properties?.SSESpecification, {
    SSEEnabled: true,
  });
  assert.deepEqual(table.Properties?.PointInTimeRecoverySpecification, {
    PointInTimeRecoveryEnabled: true,
  });
  assert.deepEqual(table.Properties?.TimeToLiveSpecification, {
    AttributeName: "expiresAt",
    Enabled: true,
  });
  assert.equal(table.Properties?.DeletionProtectionEnabled, true);
  assert.equal(table.DeletionPolicy, "Retain");
  assert.equal(table.UpdateReplacePolicy, "Retain");
  assert.deepEqual(normalizedTags(table), EXPECTED_TAGS);

  assert.deepEqual(
    template.findOutputs("PlatformStateTableName"),
    {
      PlatformStateTableName: {
        Value: { Ref: tableId },
      },
    },
  );
});

test("platform admin API role uses exact state, Registry, and domain-group permissions", () => {
  const { template } = fixture();
  const [boundaryId] = sharedRuntimeBoundary(template);
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [userPoolId] = soleResource(template, "AWS::Cognito::UserPool");
  const [roleId, role] = namedRole(template, PLATFORM_ADMIN_API_ROLE_NAME);
  const logGroupEntry = resourceEntries(
    template,
    "AWS::Logs::LogGroup",
  ).find(([logicalId]) => logicalId.startsWith("PlatformAdminApiLogs"));
  assert.ok(logGroupEntry);
  const [logGroupId] = logGroupEntry;

  assert.deepEqual(role.Properties?.PermissionsBoundary, {
    Ref: boundaryId,
  });
  assert.deepEqual(role.Properties?.AssumeRolePolicyDocument?.Statement, [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    },
  ]);

  const statements = iamStatements(template)
    .filter(({ owner }) => owner === roleId)
    .map(({ statement }) => statement);
  assert.equal(statements.length, 16);
  const tableStatements = statements.filter((statement) =>
    statementActions(statement).some((action) =>
      action.startsWith("dynamodb:")
    )
  );
  const logStatement = statements.find((statement) =>
    statementActions(statement).includes("logs:CreateLogStream")
  );
  const registryCreateStatements = statements.filter((statement) =>
    statementActions(statement).includes("agent-registry:CreateRegistry")
  );
  const registryTagStatements = statements.filter((statement) =>
    statementActions(statement).includes("agent-registry:TagResource")
  );
  const registryListStatement = statements.find((statement) =>
    statementActions(statement).includes("agent-registry:ListRegistryRecords")
  );
  const registryDecisionStatement = statements.find((statement) =>
    statementActions(statement).includes(
      "agent-registry:UpdateRegistryRecordStatus",
    )
      && statement.Condition === undefined
  );
  const dynamicRegistryListStatement = statements.find((statement) =>
    statementActions(statement).includes("agent-registry:ListRegistryRecords")
      && statement.Condition !== undefined
  );
  const dynamicRegistryDecisionStatement = statements.find((statement) =>
    statementActions(statement).includes(
      "agent-registry:UpdateRegistryRecordStatus",
    )
      && statement.Condition !== undefined
  );
  const registryDeleteStatement = statements.find((statement) =>
    statementActions(statement).includes("agent-registry:DeleteRegistry")
  );
  const registryWorkloadIdentityStatement = statements.find((statement) =>
    statementActions(statement).includes(
      "bedrock-agentcore:CreateWorkloadIdentity",
    )
  );
  const domainGroupStatement = statements.find((statement) =>
    statementActions(statement).includes("cognito-idp:CreateGroup")
  );
  assert.equal(tableStatements.length, 3);
  assert.ok(logStatement);
  assert.equal(registryCreateStatements.length, 2);
  assert.equal(registryTagStatements.length, 2);
  assert.ok(registryListStatement);
  assert.ok(registryDecisionStatement);
  assert.ok(dynamicRegistryListStatement);
  assert.ok(dynamicRegistryDecisionStatement);
  assert.ok(registryDeleteStatement);
  assert.ok(registryWorkloadIdentityStatement);
  assert.ok(domainGroupStatement);
  assert.deepEqual(statementActions(domainGroupStatement), [
    "cognito-idp:CreateGroup",
    "cognito-idp:DeleteGroup",
    "cognito-idp:GetGroup",
    "cognito-idp:ListUsersInGroup",
  ]);
  assert.deepEqual(domainGroupStatement.Resource, {
    "Fn::GetAtt": [userPoolId, "Arn"],
  });
  assert.deepEqual(
    tableStatements.flatMap(statementActions).sort(),
    [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ],
  );
  for (const tableStatement of tableStatements) {
    assert.deepEqual(tableStatement.Resource, {
      "Fn::GetAtt": [tableId, "Arn"],
    });
    assert.doesNotMatch(JSON.stringify(tableStatement.Condition), /AUDIT#/);
  }
  assert.deepEqual(statementActions(logStatement), [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]);
  assert.deepEqual(logStatement.Resource, {
    "Fn::GetAtt": [logGroupId, "Arn"],
  });
  const expectedCreateConditions = (managedBy: string) => ({
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": managedBy,
      "aws:RequestTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": "us-west-2",
    },
  });
  for (const managedBy of ["cdk", "hosted-acceptance"]) {
    const create = registryCreateStatements.find((statement) =>
      statement.Condition?.StringEquals?.["aws:RequestTag/managedBy"]
        === managedBy
    );
    const tag = registryTagStatements.find((statement) =>
      statement.Condition?.StringEquals?.["aws:RequestTag/managedBy"]
        === managedBy
    );
    assert.ok(create);
    assert.deepEqual(statementActions(create), [
      "agent-registry:CreateRegistry",
    ]);
    assert.equal(create.Resource, "*");
    assert.deepEqual(create.Condition, expectedCreateConditions(managedBy));
    assert.ok(tag);
    assert.deepEqual(statementActions(tag), [
      "agent-registry:TagResource",
    ]);
    assert.equal(
      normalizedArn(tag.Resource),
      "arn:<AWS::Partition>:agent-registry:us-west-2:"
        + "111122223333:registry/*",
    );
    assert.deepEqual(tag.Condition, expectedCreateConditions(managedBy));
  }
  const registryArns = [
    "AgenticPlatform-ControlPlane-SharedRegistryArn",
    "AgenticPlatform-ControlPlane-Registry-platform-Arn",
    "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
    "AgenticPlatform-ControlPlane-Registry-operations-Arn",
  ];
  // CreateRegistryRecord joined via POST /api/registry-create
  // (release/platform-demo-dev), authorizing against the registry ARN.
  assert.deepEqual(statementActions(registryListStatement), [
    "agent-registry:CreateRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ]);
  assert.deepEqual(
    registryListStatement.Resource,
    registryArns.map((exportName) => ({
      "Fn::ImportValue": exportName,
    })),
  );
  // Create + Submit joined via POST /api/registry-create
  // (release/platform-demo-dev): both authorize against record child ARNs.
  assert.deepEqual(statementActions(registryDecisionStatement), [
    "agent-registry:CreateRegistryRecord",
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistryRecord",
    "agent-registry:SubmitRegistryRecordForApproval",
    "agent-registry:UpdateRegistryRecordStatus",
  ]);
  assert.deepEqual(
    registryDecisionStatement.Resource,
    registryArns.map((exportName) => ({
      "Fn::Join": [
        "",
        [
          { "Fn::ImportValue": exportName },
          "/record/*",
        ],
      ],
    })),
  );
  const dynamicRegistryCondition = {
    StringEquals: {
      "aws:RequestedRegion": "us-west-2",
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": ["cdk", "hosted-acceptance"],
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
    },
  };
  assert.deepEqual(statementActions(dynamicRegistryListStatement), [
    "agent-registry:DeleteRegistry",
    "agent-registry:GetRegistry",
    "agent-registry:ListRegistryRecords",
  ]);
  assert.equal(
    normalizedArn(dynamicRegistryListStatement.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*",
  );
  assert.deepEqual(
    dynamicRegistryListStatement.Condition,
    dynamicRegistryCondition,
  );
  assert.deepEqual(statementActions(dynamicRegistryDecisionStatement), [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistryRecord",
    "agent-registry:UpdateRegistryRecordStatus",
  ]);
  assert.equal(
    normalizedArn(dynamicRegistryDecisionStatement.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*/record/*",
  );
  assert.deepEqual(
    dynamicRegistryDecisionStatement.Condition,
    dynamicRegistryCondition,
  );
  assert.equal(registryDeleteStatement, dynamicRegistryListStatement);
  assert.equal(
    normalizedArn(registryDeleteStatement.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*",
  );
  assert.deepEqual(
    registryDeleteStatement.Condition,
    dynamicRegistryCondition,
  );
  assert.deepEqual(
    statementActions(registryWorkloadIdentityStatement),
    [
      "bedrock-agentcore:CreateWorkloadIdentity",
      "bedrock-agentcore:DeleteWorkloadIdentity",
    ],
  );
  assert.equal(
    normalizedArn(registryWorkloadIdentityStatement.Resource),
    "arn:<AWS::Partition>:bedrock-agentcore:us-west-2:"
      + "111122223333:workload-identity-directory/*",
  );
  assert.deepEqual(registryWorkloadIdentityStatement.Condition, {
    StringEquals: {
      "aws:RequestedRegion": "us-west-2",
    },
  });
  assert.deepEqual(
    statements
      .flatMap(statementActions)
      .filter((action) => action.startsWith("agent-registry:"))
      .sort(),
    [
      "agent-registry:CreateRegistry",
      "agent-registry:CreateRegistry",
      "agent-registry:CreateRegistryRecord",
      "agent-registry:CreateRegistryRecord",
      "agent-registry:DeleteRegistry",
      "agent-registry:GetDiscoverableRegistryRecord",
      "agent-registry:GetDiscoverableRegistryRecord",
      "agent-registry:GetRegistry",
      "agent-registry:GetRegistryRecord",
      "agent-registry:GetRegistryRecord",
      "agent-registry:ListRegistryRecords",
      "agent-registry:ListRegistryRecords",
      "agent-registry:SubmitRegistryRecordForApproval",
      "agent-registry:TagResource",
      "agent-registry:TagResource",
      "agent-registry:UpdateRegistryRecordStatus",
      "agent-registry:UpdateRegistryRecordStatus",
    ],
  );
  assert.doesNotMatch(
    statements.flatMap(statementActions).join("\n"),
    /(?:Scan|BatchWriteItem|CreateTable|DeleteTable|UpdateTable|DeleteRegistryRecord|GetWorkloadAccessToken|GetWorkloadIdentity|ListWorkloadIdentities)/,
  );
});

test("runtime log-write policies use each CDK log-group ARN without a second wildcard", () => {
  const { template } = fixture();
  const logGroupIds = new Set(
    resourceEntries(template, "AWS::Logs::LogGroup")
      .map(([logicalId]) => logicalId),
  );
  const logWriteStatements = iamStatements(template)
    .filter(({ statement }) => {
      const actions = statementActions(statement);
      return (
        actions.includes("logs:CreateLogStream")
        && actions.includes("logs:PutLogEvents")
      );
    });
  const agentRuntimeLogWrites = logWriteStatements.filter(({ owner }) =>
    owner.startsWith("AgentRuntimeRole")
  );
  assert.equal(agentRuntimeLogWrites.length, 1);
  assert.match(
    JSON.stringify(agentRuntimeLogWrites[0].statement.Resource),
    /bedrock-agentcore\/runtimes/,
  );

  const directLogWrites = logWriteStatements.filter(({ owner }) =>
    !owner.startsWith("AgentRuntimeRole")
  );
  assert.equal(directLogWrites.length, 24);
  for (const { owner, statement } of directLogWrites) {
    const getAtt = statement.Resource?.["Fn::GetAtt"];
    assert.ok(
      Array.isArray(getAtt),
      `${owner} must use the log group Arn directly`,
    );
    assert.equal(getAtt.length, 2);
    assert.equal(getAtt[1], "Arn");
    assert.equal(logGroupIds.has(getAtt[0]), true);
  }
});

test("Registry decision finalizer exclusively owns immutable audit finalization", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [adminRoleId] = namedRole(
    template,
    PLATFORM_ADMIN_API_ROLE_NAME,
  );
  const [finalizerRoleId] = namedRole(
    template,
    REGISTRY_DECISION_FINALIZER_ROLE_NAME,
  );
  const functionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Atomically finalizes Registry decision audit evidence"
  );
  assert.ok(functionEntry);
  const [functionId, finalizerFunction] = functionEntry;

  const adminStatements = iamStatements(template)
    .filter(({ owner }) => owner === adminRoleId)
    .map(({ statement }) => statement);
  const adminDynamo = adminStatements.filter((statement) =>
    statementActions(statement).some((action) =>
      action.startsWith("dynamodb:")
    )
  );
  assert.equal(adminDynamo.length, 3);
  assert.deepEqual(
    adminDynamo.flatMap(statementActions).sort(),
    [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ],
  );
  for (const statement of adminDynamo) {
    assert.deepEqual(statement.Resource, {
      "Fn::GetAtt": [tableId, "Arn"],
    });
    assert.doesNotMatch(
      JSON.stringify(statement.Condition),
      /AUDIT#/,
    );
  }
  const invoke = adminStatements.find((statement) =>
    statementActions(statement).includes("lambda:InvokeFunction")
  );
  assert.deepEqual(invoke, {
    Action: "lambda:InvokeFunction",
    Effect: "Allow",
    Resource: { "Fn::GetAtt": [functionId, "Arn"] },
  });

  const finalizerStatements = iamStatements(template)
    .filter(({ owner }) => owner === finalizerRoleId)
    .map(({ statement }) => statement);
  const finalizerRead = finalizerStatements.find((statement) =>
    statementActions(statement).includes("dynamodb:GetItem")
  );
  const finalizerDynamo = finalizerStatements.find((statement) =>
    statement.Condition?.["ForAnyValue:StringEquals"]
      ?.["dynamodb:EnclosingOperation"]?.includes("TransactWriteItems")
  );
  assert.ok(finalizerRead);
  assert.ok(finalizerDynamo);
  assert.deepEqual(statementActions(finalizerRead), [
    "dynamodb:GetItem",
  ]);
  assert.deepEqual(statementActions(finalizerDynamo), [
    "dynamodb:PutItem",
  ]);
  assert.deepEqual(finalizerDynamo.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(finalizerDynamo.Condition, {
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
  });
  assert.equal(finalizerFunction.Properties?.Runtime, "nodejs24.x");
  assert.deepEqual(finalizerFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(finalizerFunction.Properties?.Timeout, 10);
  assert.equal(finalizerFunction.Properties?.MemorySize, 256);
  assert.equal(
    finalizerFunction.Properties?.FunctionName,
    "AgenticPlatform-Web-RegistryDecisionFinalizer",
  );
  assert.deepEqual(normalizedTags(finalizerFunction), EXPECTED_TAGS);
});

test("platform admin API uses retained logs and a bounded Node.js 22 ARM function", () => {
  const { template } = fixture();
  const [boundaryId] = sharedRuntimeBoundary(template);
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [userPoolId] = soleResource(template, "AWS::Cognito::UserPool");
  const [roleId] = namedRole(template, PLATFORM_ADMIN_API_ROLE_NAME);
  const logGroupEntry = resourceEntries(
    template,
    "AWS::Logs::LogGroup",
  ).find(([logicalId]) => logicalId.startsWith("PlatformAdminApiLogs"));
  assert.ok(logGroupEntry);
  const [logGroupId, logGroup] = logGroupEntry;
  assert.equal(logGroup.Properties?.RetentionInDays, 90);
  assert.equal(logGroup.DeletionPolicy, "Retain");
  assert.equal(logGroup.UpdateReplacePolicy, "Retain");
  assert.deepEqual(normalizedTags(logGroup), EXPECTED_TAGS);

  const functionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Vends durable platform domains through AWS Agent Registry"
  );
  assert.ok(functionEntry);
  const [, platformAdminFunction] = functionEntry;
  assert.equal(platformAdminFunction.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(
    platformAdminFunction.Properties?.Architectures,
    ["arm64"],
  );
  assert.equal(platformAdminFunction.Properties?.Handler, "index.handler");
  assert.equal(platformAdminFunction.Properties?.Timeout, 30);
  assert.equal(platformAdminFunction.Properties?.MemorySize, 512);
  assert.equal(
    platformAdminFunction.Properties?.ReservedConcurrentExecutions,
    undefined,
  );
  assert.equal(platformAdminFunction.Properties?.TracingConfig, undefined);
  assert.deepEqual(platformAdminFunction.Properties?.Role, {
    "Fn::GetAtt": [roleId, "Arn"],
  });
  assert.deepEqual(platformAdminFunction.Properties?.LoggingConfig, {
    LogGroup: { Ref: logGroupId },
  });
  const finalizerFunction = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Atomically finalizes Registry decision audit evidence"
  );
  assert.ok(finalizerFunction);
  const registryInventoryConfig =
    platformAdminFunction.Properties?.Environment?.Variables
      ?.REGISTRY_INVENTORY_CONFIG;
  assert.ok(registryInventoryConfig);
  const controlPlaneConfig = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Reads scoped AWS Registry and AgentCore Gateway inventory"
  )?.[1].Properties?.Environment?.Variables?.CONTROL_PLANE_CONFIG;
  assert.ok(controlPlaneConfig);
  assert.deepEqual(
    platformAdminFunction.Properties?.Environment?.Variables,
    {
      COGNITO_USER_POOL_ID: { Ref: userPoolId },
      MANDATORY_TAGS_JSON:
        "{\"auto-delete\":\"no\",\"project\":\"agentic-ai-platform-demo\",\"managedBy\":\"cdk\"}",
      PLATFORM_ACCOUNT_ID: "111122223333",
      PLATFORM_STATE_TABLE_NAME: { Ref: tableId },
      REGISTRY_DECISION_FINALIZER_FUNCTION_NAME: {
        Ref: finalizerFunction[0],
      },
      REGISTRY_INVENTORY_CONFIG: registryInventoryConfig,
    },
  );
  assert.notDeepEqual(registryInventoryConfig, controlPlaneConfig);
  const parsedRegistryConfig = JSON.parse(
    resolveImportValues(registryInventoryConfig) as string,
  );
  assert.equal(parsedRegistryConfig.accountId, "111122223333");
  assert.equal(Object.hasOwn(parsedRegistryConfig, "llmGatewayId"), false);
  assert.equal(Object.hasOwn(parsedRegistryConfig, "toolsGatewayId"), false);
  assert.equal(
    Object.hasOwn(
      platformAdminFunction.Properties?.Environment?.Variables ?? {},
      "AWS_REGION",
    ),
    false,
  );
  assert.deepEqual(normalizedTags(platformAdminFunction), EXPECTED_TAGS);
  assert.deepEqual(
    template.findResources("AWS::IAM::Role")[roleId]
      .Properties?.PermissionsBoundary,
    { Ref: boundaryId },
  );
});

test("baseline domain seed uses a dedicated bounded runtime and exact retained records", () => {
  const { template } = fixture();
  const [boundaryId] = sharedRuntimeBoundary(template);
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [roleId, role] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformStateSeed,
  );
  const [workspaceRoleId, workspaceRole] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.platformWorkspaceSeed,
  );

  template.hasResource("Custom::PlatformHitlCatalog", {
    DependsOn: Match.arrayWith([workspaceRoleId]),
    Properties: Match.objectLike({InitializationVersion:1}),
  });
  assert.ok(workspaceRole.Properties?.Policies, "required grant is embedded in the depended-on IAM Role");
  assert.deepEqual(role.Properties?.PermissionsBoundary, {
    Ref: boundaryId,
  });
  assert.deepEqual(workspaceRole.Properties?.PermissionsBoundary, {
    Ref: boundaryId,
  });
  const roleStatements = iamStatements(template)
    .filter(({ owner }) => owner === roleId)
    .map(({ statement }) => statement);
  assert.equal(roleStatements.length, 2);
  const tableStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("dynamodb:GetItem")
  );
  const logStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("logs:CreateLogStream")
  );
  assert.ok(tableStatement);
  assert.ok(logStatement);
  assert.deepEqual(statementActions(tableStatement), [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
  ]);
  assert.deepEqual(tableStatement.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(tableStatement.Condition, {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["DOMAIN"],
    },
  });
  assert.deepEqual(statementActions(logStatement), [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]);
  assert.doesNotMatch(
    roleStatements.flatMap(statementActions).join("\n"),
    /(?:Scan|Query|BatchWriteItem|DeleteItem|CreateTable|DeleteTable|UpdateTable)/,
  );
  const workspaceRoleStatements = iamStatements(template)
    .filter(({ owner }) => owner === workspaceRoleId)
    .map(({ statement }) => statement);
  assert.equal(workspaceRoleStatements.length, 2);
  const workspaceTableStatement = workspaceRoleStatements.find((statement) =>
    statementActions(statement).includes("dynamodb:GetItem")
  );
  const workspaceLogStatement = workspaceRoleStatements.find((statement) =>
    statementActions(statement).includes("logs:CreateLogStream")
  );
  assert.ok(workspaceTableStatement);
  assert.ok(workspaceLogStatement);
  assert.deepEqual(statementActions(workspaceTableStatement), [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
  ]);
  assert.deepEqual(workspaceTableStatement.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(workspaceTableStatement.Condition, {
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
  });
  assert.deepEqual(statementActions(workspaceLogStatement), [
    "logs:CreateLogStream",
    "logs:PutLogEvents",
  ]);
  assert.doesNotMatch(
    workspaceRoleStatements.flatMap(statementActions).join("\n"),
    /(?:Scan|Query|BatchWriteItem|DeleteItem|CreateTable|DeleteTable|UpdateTable)/,
  );

  const functionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Seeds retained deployment-owned platform domains"
  );
  assert.ok(functionEntry);
  const [functionId, seedFunction] = functionEntry;
  assert.equal(seedFunction.Properties?.Runtime, "nodejs24.x");
  assert.deepEqual(seedFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(seedFunction.Properties?.Handler, "index.handler");
  assert.equal(seedFunction.Properties?.Timeout, 120);
  assert.equal(seedFunction.Properties?.MemorySize, 256);
  assert.equal(seedFunction.Properties?.Environment, undefined);
  assert.deepEqual(seedFunction.Properties?.Role, {
    "Fn::GetAtt": [roleId, "Arn"],
  });
  assert.deepEqual(normalizedTags(seedFunction), EXPECTED_TAGS);

  const logGroupEntry = resourceEntries(
    template,
    "AWS::Logs::LogGroup",
  ).find(([logicalId]) => logicalId.startsWith("PlatformStateSeedLogs"));
  assert.ok(logGroupEntry);
  const [logGroupId, logGroup] = logGroupEntry;
  assert.equal(logGroup.Properties?.RetentionInDays, 90);
  assert.equal(logGroup.DeletionPolicy, "Retain");
  assert.equal(logGroup.UpdateReplacePolicy, "Retain");
  assert.deepEqual(normalizedTags(logGroup), EXPECTED_TAGS);
  assert.deepEqual(seedFunction.Properties?.LoggingConfig?.LogGroup, {
    Ref: logGroupId,
  });
  assert.deepEqual(logStatement.Resource, {
    "Fn::GetAtt": [logGroupId, "Arn"],
  });

  const [domainSeedId, seedResource] = soleResource(
    template,
    "Custom::PlatformBaselineDomains",
  );
  assert.deepEqual(seedResource.Properties?.ServiceToken, {
    "Fn::GetAtt": [functionId, "Arn"],
  });
  assert.equal(seedResource.Properties?.ServiceTimeout, "180");
  assert.deepEqual(seedResource.Properties?.TableName, { Ref: tableId });
  assert.deepEqual(
    resolveImportValues(seedResource.Properties?.Domains),
    [
      {
        id: "platform",
        name: "Platform",
        owner: "Platform team",
        ownerGroup: "domain-platform",
        description:
          "Platform-owned agents and shared platform capabilities.",
        registryId:
          importMarker(
            "AgenticPlatform-ControlPlane-Registry-platform-Id",
          ),
        registryArn:
          importMarker(
            "AgenticPlatform-ControlPlane-Registry-platform-Arn",
          ),
        createdBy: "deployment:baseline",
      },
      {
        id: "customer_support",
        name: "Customer Support",
        owner: "Customer Support team",
        ownerGroup: "domain-customer-support",
        description: "Customer-facing support agents.",
        tokenBudget: 24000,
        registryId:
          importMarker(
            "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
          ),
        registryArn:
          importMarker(
            "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
          ),
        createdBy: "deployment:baseline",
      },
      {
        id: "operations",
        name: "Operations",
        owner: "Operations team",
        ownerGroup: "domain-operations",
        description:
          "Internal operations and workflow automation agents.",
        registryId:
          importMarker(
            "AgenticPlatform-ControlPlane-Registry-operations-Id",
          ),
        registryArn:
          importMarker(
            "AgenticPlatform-ControlPlane-Registry-operations-Arn",
          ),
        createdBy: "deployment:baseline",
      },
    ],
  );
  const dependencies = Array.isArray(seedResource.DependsOn)
    ? seedResource.DependsOn
    : [seedResource.DependsOn];
  assert.ok(dependencies.includes(tableId));
  assert.deepEqual(
    collectImportValues(seedResource.Properties?.Domains).sort(),
    [
      "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
      "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
      "AgenticPlatform-ControlPlane-Registry-operations-Arn",
      "AgenticPlatform-ControlPlane-Registry-operations-Id",
      "AgenticPlatform-ControlPlane-Registry-platform-Arn",
      "AgenticPlatform-ControlPlane-Registry-platform-Id",
    ].sort(),
  );

  const workspaceFunctionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Seeds retained deployment-owned demo projects and agents"
  );
  assert.ok(workspaceFunctionEntry);
  const [workspaceFunctionId, workspaceFunction] = workspaceFunctionEntry;
  assert.equal(workspaceFunction.Properties?.Runtime, "nodejs24.x");
  assert.deepEqual(workspaceFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(workspaceFunction.Properties?.Handler, "index.handler");
  assert.equal(workspaceFunction.Properties?.Timeout, 120);
  assert.equal(workspaceFunction.Properties?.MemorySize, 256);
  assert.equal(workspaceFunction.Properties?.Environment, undefined);
  assert.deepEqual(workspaceFunction.Properties?.Role, {
    "Fn::GetAtt": [workspaceRoleId, "Arn"],
  });
  assert.deepEqual(workspaceFunction.Properties?.LoggingConfig?.LogGroup, {
    Ref: logGroupId,
  });
  assert.deepEqual(normalizedTags(workspaceFunction), EXPECTED_TAGS);
  assert.deepEqual(workspaceLogStatement.Resource, {
    "Fn::GetAtt": [logGroupId, "Arn"],
  });

  // One seed per curated demo project, each with one honest DRAFT agent.
  const workspaceSeedResources = resourceEntries(
    template,
    "Custom::PlatformBaselineProject",
  );
  assert.equal(workspaceSeedResources.length, 6);
  const seededProjects = workspaceSeedResources
    .map(([, resource]) => resource.Properties?.Project)
    .sort((left, right) =>
      `${left.domainId}/${left.id}`.localeCompare(`${right.domainId}/${right.id}`));
  assert.deepEqual(
    seededProjects.map(({ domainId, id }) => `${domainId}/${id}`),
    [
      "customer_support/concierge",
      "customer_support/case-assist",
      "customer_support/supportdesk",
      "operations/incident-triage",
      "operations/report-runner",
      "platform/it-helpdesk",
    ].sort(),
  );
  for (const [, workspaceSeedResource] of workspaceSeedResources) {
    assert.deepEqual(workspaceSeedResource.Properties?.ServiceToken, {
      "Fn::GetAtt": [workspaceFunctionId, "Arn"],
    });
    assert.equal(workspaceSeedResource.Properties?.ServiceTimeout, "180");
    assert.deepEqual(workspaceSeedResource.Properties?.TableName, {
      Ref: tableId,
    });
    const project = workspaceSeedResource.Properties?.Project;
    assert.equal(project.ownerSubject, "deployment:baseline");
    assert.equal(project.createdBySubject, "deployment:baseline");
    assert.equal(project.status, "ACTIVE");
    assert.deepEqual(project.memberSubjects, []);
    const agent = workspaceSeedResource.Properties?.Agent;
    assert.equal(agent.domainId, project.domainId);
    assert.equal(agent.projectId, project.id);
    assert.equal(agent.ownerSubject, "deployment:baseline");
    assert.equal(agent.createdBySubject, "deployment:baseline");
    assert.equal(agent.status, "DRAFT");
    assert.equal("buildConfig" in agent, false);
    assert.equal(
      Object.values(agent).some((value) => value === null),
      false,
    );
    const workspaceDependencies = Array.isArray(workspaceSeedResource.DependsOn)
      ? workspaceSeedResource.DependsOn
      : [workspaceSeedResource.DependsOn];
    assert.ok(workspaceDependencies.includes(tableId));
    assert.ok(workspaceDependencies.includes(domainSeedId));
  }
});

test("hosted acceptance role has only exact Cognito and broker invocation permissions", () => {
  const { template } = fixture();
  const [userPoolId] = soleResource(template, "AWS::Cognito::UserPool");
  const [brokerFunctionId] = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.FunctionName
      === HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME
  ) ?? [];
  assert.ok(brokerFunctionId);
  const [, role] = namedRole(template, HOSTED_ACCEPTANCE_ROLE_NAME);
  const trustStatements =
    role.Properties?.AssumeRolePolicyDocument?.Statement ?? [];

  assert.equal(trustStatements.length, 1);
  assert.equal(trustStatements[0].Action, "sts:AssumeRole");
  assert.equal(
    normalizedArn(
      trustStatements[0].Condition.ArnEquals["aws:PrincipalArn"],
    ),
    GITHUB_DEPLOY_ROLE_ARN,
  );

  const statements = role.Properties?.Policies?.[0]
    ?.PolicyDocument?.Statement ?? [];
  assert.equal(statements.length, 2);
  const cognitoStatement = statements.find((statement: Record<string, any>) =>
    statementActions(statement).includes("cognito-idp:AdminCreateUser")
  );
  const brokerStatement = statements.find((statement: Record<string, any>) =>
    statementActions(statement).includes("lambda:InvokeFunction")
  );
  assert.ok(cognitoStatement);
  assert.deepEqual(cognitoStatement.Resource, {
    "Fn::GetAtt": [userPoolId, "Arn"],
  });
  assert.ok(brokerStatement);
  assert.deepEqual(statementActions(brokerStatement), [
    "lambda:InvokeFunction",
  ]);
  assert.deepEqual(brokerStatement.Resource, {
    "Fn::GetAtt": [brokerFunctionId, "Arn"],
  });
  assert.doesNotMatch(
    statements.flatMap(statementActions).join("\n"),
    /^(?:agent-registry|dynamodb):/m,
  );
});

test("private hosted acceptance broker owns only bounded Registry and exact state operations", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [userPoolId] = soleResource(template, "AWS::Cognito::UserPool");
  const [runtimeId] = soleResource(
    template,
    "AWS::BedrockAgentCore::Runtime",
  );
  const productionEndpointEntry = resourceEntries(
    template,
    "AWS::BedrockAgentCore::RuntimeEndpoint",
  ).find(([, resource]) => resource.Properties?.Name === "Production");
  assert.ok(productionEndpointEntry);
  const [productionEndpointId] = productionEndpointEntry;
  const [roleId, role] = namedRole(
    template,
    HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
  );
  const brokerFunctionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.FunctionName
      === HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME
  );
  assert.ok(brokerFunctionEntry);
  const [brokerFunctionId, brokerFunction] = brokerFunctionEntry;
  assert.deepEqual(brokerFunction.Properties?.Role, {
    "Fn::GetAtt": [roleId, "Arn"],
  });
  assert.equal(brokerFunction.Properties?.Timeout, 120);
  assert.equal(brokerFunction.Properties?.MemorySize, 512);
  assert.equal(brokerFunction.Properties?.ReservedConcurrentExecutions, undefined);
  assert.deepEqual(normalizedTags(brokerFunction), EXPECTED_TAGS);
  const deploymentFunction = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Executes governed sandbox and production AgentCore deployments"
  )?.[1];
  assert.ok(deploymentFunction);
  assert.deepEqual(
    brokerFunction.Properties?.Environment?.Variables?.AGENT_RUNTIME_ID,
    deploymentFunction.Properties?.Environment?.Variables?.AGENT_RUNTIME_ID,
  );
  assert.deepEqual(
    brokerFunction.Properties?.Environment?.Variables
      ?.PRODUCTION_ENDPOINT_NAME,
    deploymentFunction.Properties?.Environment?.Variables
      ?.PRODUCTION_ENDPOINT_NAME,
  );
  assert.deepEqual(
    brokerFunction.Properties?.Environment?.Variables
      ?.COGNITO_USER_POOL_ID,
    { Ref: userPoolId },
  );
  assert.equal(
    resourceEntries(template, "AWS::Lambda::Url").length,
    0,
  );

  const integrations = resourceEntries(
    template,
    "AWS::ApiGatewayV2::Integration",
  );
  assert.equal(
    integrations.some(([, integration]) =>
      JSON.stringify(integration).includes(brokerFunctionId)
    ),
    false,
  );

  const statements = iamStatements(template)
    .filter(({ owner }) => owner === roleId)
    .map(({ statement }) => statement);
  const actions = statements.flatMap(statementActions);
  assert.doesNotMatch(
    actions.join("\n"),
    /(?:Scan|BatchWriteItem|CreateTable|DeleteTable|UpdateTable|ListRegistries|CreateRegistry$)/,
  );
  const domainGroupCleanup = statements.find((candidate) =>
    statementActions(candidate).includes("cognito-idp:DeleteGroup")
  );
  assert.ok(domainGroupCleanup);
  assert.deepEqual(statementActions(domainGroupCleanup), [
    "cognito-idp:DeleteGroup",
    "cognito-idp:GetGroup",
    "cognito-idp:ListUsersInGroup",
  ]);
  assert.deepEqual(domainGroupCleanup.Resource, {
    "Fn::GetAtt": [userPoolId, "Arn"],
  });
  const sharedRegistryResource = {
    "Fn::ImportValue":
      "AgenticPlatform-ControlPlane-SharedRegistryArn",
  };
  const sharedRecordResource = {
    "Fn::Join": [
      "",
      [sharedRegistryResource, "/record/*"],
    ],
  };
  for (const action of ["agent-registry:ListRegistryRecords"]) {
    const statement = statements.find((candidate) =>
      statementActions(candidate).includes(action)
    );
    assert.ok(statement);
    assert.deepEqual(statement.Resource, sharedRegistryResource);
  }
  const recordCreate = statements.find((candidate) =>
    statementActions(candidate).includes("agent-registry:CreateRegistryRecord")
  );
  assert.ok(recordCreate);
  assert.deepEqual(recordCreate.Resource, [
    sharedRegistryResource,
    sharedRecordResource,
  ]);
  assert.equal(recordCreate.Sid, "CreateHostedAcceptanceFixtureRecord");
  for (const action of [
    "agent-registry:GetRegistryRecord",
    "agent-registry:SubmitRegistryRecordForApproval",
    "agent-registry:DeleteRegistryRecord",
  ]) {
    const statement = statements.find((candidate) =>
      statementActions(candidate).includes(action)
    );
    assert.ok(statement);
    assert.deepEqual(statement.Resource, sharedRecordResource);
  }
  const recordMutation = statements.find((candidate) =>
    statementActions(candidate).includes(
      "agent-registry:DeleteRegistryRecord",
    )
  );
  assert.deepEqual(recordMutation?.Condition, {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "hosted-acceptance",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": "us-west-2",
    },
  });
  const recordTag = statements.find((candidate) =>
    statementActions(candidate).includes("agent-registry:TagResource")
  );
  assert.ok(recordTag);
  assert.deepEqual(recordTag.Resource, [
    sharedRegistryResource,
    sharedRecordResource,
  ]);
  assert.equal(recordTag.Sid, "TagHostedAcceptanceFixtureRecord");
  assert.notEqual(recordCreate, recordTag);

  const accountRegistryRead = statements.find((candidate) =>
    statementActions(candidate).includes("agent-registry:GetRegistry")
  );
  assert.ok(accountRegistryRead);
  assert.deepEqual(statementActions(accountRegistryRead), [
    "agent-registry:GetRegistry",
    "agent-registry:ListTagsForResource",
  ]);
  assert.equal(accountRegistryRead.Condition, undefined);
  assert.equal(
    normalizedArn(accountRegistryRead.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*",
  );
  const registryDelete = statements.find((candidate) =>
    statementActions(candidate).includes("agent-registry:DeleteRegistry")
  );
  assert.ok(registryDelete);
  assert.deepEqual(registryDelete.Condition, {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "hosted-acceptance",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": "us-west-2",
    },
  });
  assert.equal(
    actions.filter((action) => action === "agent-registry:TagResource").length,
    1,
  );
  const registryWorkloadIdentityDelete = statements.find((candidate) =>
    statementActions(candidate).includes(
      "bedrock-agentcore:DeleteWorkloadIdentity",
    )
  );
  assert.ok(registryWorkloadIdentityDelete);
  assert.deepEqual(statementActions(registryWorkloadIdentityDelete), [
    "bedrock-agentcore:DeleteWorkloadIdentity",
  ]);
  assert.deepEqual(
    registryWorkloadIdentityDelete.Resource.map(normalizedArn),
    [
      "arn:<AWS::Partition>:bedrock-agentcore:us-west-2:"
        + "111122223333:workload-identity-directory/default",
      "arn:<AWS::Partition>:bedrock-agentcore:us-west-2:"
        + "111122223333:workload-identity-directory/default/"
        + "workload-identity/registry-*",
    ],
  );
  assert.deepEqual(registryWorkloadIdentityDelete.Condition, {
    StringEquals: {
      "aws:RequestedRegion": "us-west-2",
    },
  });

  const tableResource = {
    "Fn::GetAtt": [tableId, "Arn"],
  };
  const directReadKeys = [
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
  ];
  const directDeleteKeys = directReadKeys.filter(
    (key) =>
      !key.startsWith("PROJECT#")
      && key !== "APPROVAL#customer_support"
      && key !== "APPROVAL#operations"
      && key !== "DELIVERY#*"
      && key !== "JOURNEY#*",
  );
  const fixtureTransactionKeys = [
    "AGENT#customer_support#hosted-project-*",
    "AGENT#operations#hosted-project-*",
    "DEPLOYMENT#customer_support#hosted-project-*",
    "DEPLOYMENT#operations#hosted-project-*",
    "ENTITLEMENT#*",
    "PROJECT#customer_support",
    "PROJECT#operations",
  ];
  const personaCleanupTransactionKeys = [
    ...fixtureTransactionKeys.slice(0, 2),
    "APPROVAL#customer_support",
    "APPROVAL#operations",
    ...fixtureTransactionKeys.slice(2),
  ];
  const journeyCleanupTransactionKeys = [
    "DELIVERY#*",
    "JOURNEY#*",
    "MUTATION#*",
  ];
  const expectedDynamoStatements =
    new Map<string, Record<string, any>>([
    [
      "ReadHostedAcceptanceState",
      {
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": directReadKeys,
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
    ],
    [
      "DeleteHostedAcceptanceState",
      {
        Action: "dynamodb:DeleteItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": directDeleteKeys,
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
    ],
    [
      "WriteHostedAcceptanceMappings",
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
    ],
    [
      "QueryHostedAcceptanceEntitlements",
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
    ],
    [
      "WriteHostedAcceptanceExperienceFixture",
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": fixtureTransactionKeys,
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
    ],
    [
      "DeleteHostedAcceptanceExperienceFixture",
      {
        Action: "dynamodb:DeleteItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": personaCleanupTransactionKeys,
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
    ],
    [
      "DeleteHostedAcceptanceAgentBuildingJourneys",
      {
        Action: "dynamodb:DeleteItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": journeyCleanupTransactionKeys,
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
    ],
  ]);
  const actualDynamoStatements = new Map(
    statements
      .filter((statement) =>
        statementActions(statement).some((action) =>
          action.startsWith("dynamodb:")
        )
      )
      .map(({ Sid, ...statement }) => [Sid, statement]),
  );
  assert.deepEqual(actualDynamoStatements, expectedDynamoStatements);
  assert.equal(actions.includes("dynamodb:TransactWriteItems"), false);
  const runtimeRead = statements.find((candidate) =>
    statementActions(candidate).includes(
      "bedrock-agentcore:GetAgentRuntime",
    )
  );
  assert.ok(runtimeRead);
  assert.deepEqual(statementActions(runtimeRead), [
    "bedrock-agentcore:GetAgentRuntime",
  ]);
  assert.deepEqual(runtimeRead.Resource, {
    "Fn::GetAtt": [runtimeId, "AgentRuntimeArn"],
  });
  const endpointRead = statements.find((candidate) =>
    statementActions(candidate).includes(
      "bedrock-agentcore:GetAgentRuntimeEndpoint",
    )
  );
  assert.ok(endpointRead);
  assert.deepEqual(statementActions(endpointRead), [
    "bedrock-agentcore:GetAgentRuntimeEndpoint",
  ]);
  assert.deepEqual(endpointRead.Resource, [
    {
      "Fn::GetAtt": [runtimeId, "AgentRuntimeArn"],
    },
    {
      "Fn::GetAtt": [
        productionEndpointId,
        "AgentRuntimeEndpointArn",
      ],
    },
  ]);
  assert.deepEqual(role.Properties?.AssumeRolePolicyDocument?.Statement, [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    },
  ]);
});

test("canonical boundary adds no hosted-acceptance write allowance", async () => {
  const source = JSON.parse(
    await readFile(
      path.join(
        __dirname,
        "..",
        "config",
        "runtime-permissions-boundary.json",
      ),
      "utf8",
    ),
  );
  const statement = source.Statement.find(
    ({ Sid }: { Sid?: string }) => Sid === "ReadDeleteHostedAcceptanceState",
  );
  assert.deepEqual(statement.Action, [
    "dynamodb:DeleteItem",
    "dynamodb:GetItem",
  ]);
  assert.deepEqual(
    statement.Condition["ForAllValues:StringLike"]
      ["dynamodb:LeadingKeys"],
    [
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
  );
});

test("canonical boundary permits only the exact OAuth authorization item family", async () => {
  const source = JSON.parse(
    await readFile(
      path.join(
        __dirname,
        "..",
        "config",
        "runtime-permissions-boundary.json",
      ),
      "utf8",
    ),
  );
  const leadingKeys = (sid: string) => {
    const statement = source.Statement.find(
      ({ Sid }: { Sid?: string }) => Sid === sid,
    );
    assert.ok(statement);
    return statement.Condition["ForAllValues:StringLike"]
      ["dynamodb:LeadingKeys"];
  };

  for (const sid of [
    "ReadPlatformState",
    "WritePlatformState",
    "UpdateExperienceInvocation",
  ]) {
    assert.equal(
      leadingKeys(sid).filter(
        (key: string) => key === "GITHUB_AUTHORIZATION#*",
      ).length,
      1,
    );
  }
});

test("runtime boundary allows exactly the synthesized runtime action families and no escalation service", () => {
  const { template } = fixture();
  const [, boundary] = sharedRuntimeBoundary(template);
  const boundaryStatements =
    boundary.Properties?.PolicyDocument?.Statement ?? [];
  const boundaryActions = [
    ...new Set(
      boundaryStatements
        .flatMap((statement: Record<string, any>) =>
          statementActions(statement)
        ),
    ),
  ].sort();

  assert.deepEqual(boundaryActions, [
    "agent-registry:CreateRegistry",
    "agent-registry:CreateRegistryRecord",
    "agent-registry:DeleteRegistry",
    "agent-registry:DeleteRegistryRecord",
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistry",
    "agent-registry:GetRegistryRecord",
    "agent-registry:ListRegistryRecords",
    "agent-registry:ListTagsForResource",
    "agent-registry:SubmitRegistryRecordForApproval",
    "agent-registry:TagResource",
    "agent-registry:UpdateRegistryRecordStatus",
    "bedrock-agentcore:*GatewayRateLimits",
    "bedrock-agentcore:*Mem*",
    "bedrock-agentcore:CreateWorkloadIdentity",
    "bedrock-agentcore:DeleteWorkloadIdentity",
    "bedrock-agentcore:GetAgentRuntime*",
    "bedrock-agentcore:GetGatewayTarget",
    "bedrock-agentcore:GetWorkloadAccessToken*",
    "bedrock-agentcore:InvokeAgentRuntime*",
    "bedrock-agentcore:InvokeGateway",
    "bedrock-agentcore:ListGatewayTargets",
    "bedrock:GetKnow*",
    "ce:GetCostAndUsage",
    "cloudfront:CreateInvalidation",
    "cloudfront:GetInvalidation",
    "cloudwatch:DeleteAlarms",
    "cloudwatch:GetMetricData",
    "cloudwatch:ListTagsForResource",
    "cloudwatch:PutMetricAlarm",
    "cloudwatch:PutMetricData",
    "cloudwatch:TagResource",
    "cloudwatch:UntagResource",
    "cognito-idp:AdminAddUserToGroup",
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
    "cognito-idp:AdminRemoveUserFromGroup",
    "cognito-idp:CreateGroup",
    "cognito-idp:DeleteGroup",
    "cognito-idp:GetGroup",
    "cognito-idp:ListUsers",
    "cognito-idp:ListUsersInGroup",
    "dynamodb:DeleteItem",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
    "dynamodb:UpdateItem",
    "iam:ListPolicyTags",
    "iam:TagPolicy",
    "iam:UntagPolicy",
    "lambda:GetFunction",
    "lambda:InvokeFunction",
    "logs:CreateLogGroup",
    "logs:CreateLogStream",
    "logs:DescribeLogGroups",
    "logs:DescribeLogStreams",
    "logs:PutLogEvents",
    "s3:Abort*",
    "s3:DeleteObject*",
    "s3:GetBucket*",
    "s3:GetObject*",
    "s3:List*",
    "s3:PutObject",
    "s3:PutObjectLegalHold",
    "s3:PutObjectRetention",
    "s3:PutObjectTagging",
    "s3:PutObjectVersionTagging",
    "secretsmanager:GetSecretValue",
    "secretsmanager:PutSecretValue",
    "sts:AssumeRole",
    "sts:SetSourceIdentity",
    "xray:GetSamplingRules",
    "xray:GetSamplingTargets",
    "xray:PutTelemetryRecords",
    "xray:PutTraceSegments",
  ]);

  const permittedIamActions = new Set([
    "iam:ListPolicyTags",
    "iam:TagPolicy",
    "iam:UntagPolicy",
  ]);
  const permittedStsActions = new Set([
    "sts:AssumeRole",
    "sts:SetSourceIdentity",
  ]);
  for (const action of boundaryActions) {
    if (action.startsWith("iam:")) {
      assert.ok(
        permittedIamActions.has(action),
        `${action} must not be permitted by the runtime boundary`,
      );
    } else if (action.startsWith("sts:")) {
      assert.ok(
        permittedStsActions.has(action),
        `${action} must not be permitted by the runtime boundary`,
      );
    } else {
      assert.doesNotMatch(
        action,
        /^(?:account|organizations):/i,
        `${action} must not be permitted by the runtime boundary`,
      );
    }
    assert.notEqual(action.toLowerCase(), "iam:passrole");
  }

  const roleActions = iamStatements(template)
    // Operations has a dedicated, separately asserted budget-aware boundary.
    .filter(({ owner }) => !owner.startsWith("HostedAcceptanceRole") && !owner.startsWith("OperationsApiRole") && !owner.startsWith("PolicyInventoryRole"))
    .flatMap(({ statement }) => statementActions(statement));
  for (const action of roleActions) {
    assert.ok(
      boundaryActions.some((pattern) => actionPatternMatches(pattern, action)),
      `${action} is not admitted by the runtime permissions boundary`,
    );
  }
});

test("runtime boundary compaction removes duplicate resources", () => {
  const { template } = fixture();
  const [, boundary] = sharedRuntimeBoundary(template);
  const statements =
    boundary.Properties?.PolicyDocument?.Statement ?? [];

  for (const statement of statements) {
    const resources = Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource];
    assert.equal(
      new Set(resources.map((resource: unknown) => JSON.stringify(resource)))
        .size,
      resources.length,
    );
  }
  const cdkAssetResources = statements
    .flatMap((statement: Record<string, any>) =>
      Array.isArray(statement.Resource)
        ? statement.Resource
        : [statement.Resource]
    )
    .map(normalizedArn)
    .filter((resource: string) =>
      resource.includes(":s3:::cdk-hnb659fds-assets-")
    );
  assert.deepEqual(cdkAssetResources, [
    "arn:<AWS::Partition>:s3:::"
      + "cdk-hnb659fds-assets-111122223333-us-west-2*",
  ]);
});

test("runtime boundary uses the nested AgentCore RuntimeEndpoint ARN", () => {
  const { template } = fixture();
  const [, boundary] = sharedRuntimeBoundary(template);
  const endpointRead = boundary.Properties?.PolicyDocument?.Statement?.find(
    (statement: Record<string, any>) =>
      statementActions(statement).some((action) =>
        actionPatternMatches(
          action,
          "bedrock-agentcore:GetAgentRuntimeEndpoint",
        )
      ),
  );

  assert.ok(endpointRead);
  assert.ok(
    [endpointRead.Resource].flat().map(normalizedArn).includes(
      "arn:<AWS::Partition>:bedrock-agentcore:us-west-2:111122223333:"
        + "runtime/AgenticPlatformRuntime-*/runtime-endpoint/*",
    ),
  );
});

test("Journey role keeps Runtime access in its audited named policy", () => {
  const { template } = createOAuthStack();
  const [journeyRoleId, journeyRole] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.journeyApi,
  );
  const journeyPolicy = journeyRole.Properties?.Policies?.find(
    (policy: Record<string, any>) => policy.PolicyName === "JourneyApi",
  );
  assert.ok(journeyPolicy);
  const namedActions = journeyPolicy.PolicyDocument.Statement.flatMap(
    statementActions,
  );
  assert.ok(namedActions.includes("secretsmanager:GetSecretValue"));
  assert.ok(
    namedActions.includes("bedrock-agentcore:InvokeAgentRuntime"),
  );
  assert.ok(
    namedActions.includes("bedrock-agentcore:InvokeAgentRuntimeForUser"),
  );

  const generatedPolicies = resourceEntries(
    template,
    "AWS::IAM::Policy",
  ).filter(([, policy]) =>
    (policy.Properties?.Roles ?? []).some(
      (role: Record<string, any>) => role.Ref === journeyRoleId,
    )
  );
  assert.equal(generatedPolicies.length, 1);
  const generatedActions =
    generatedPolicies[0][1].Properties?.PolicyDocument?.Statement
      ?.flatMap(statementActions) ?? [];
  assert.deepEqual(generatedActions.sort(), [
    "sts:AssumeRole",
    "sts:SetSourceIdentity",
    "xray:PutTelemetryRecords",
    "xray:PutTraceSegments",
  ]);
});

test("AgentCore Runtime observability resources are complete and tagged", () => {
  const { template } = fixture();
  const expectedCounts = new Map([
    ["AWS::Logs::DeliverySource", 3],
    ["AWS::Logs::DeliveryDestination", 3],
    ["AWS::Logs::Delivery", 3],
  ]);

  for (const [resourceType, expectedCount] of expectedCounts) {
    const resources = resourceEntries(template, resourceType);
    assert.equal(resources.length, expectedCount, resourceType);
    for (const [, resource] of resources) {
      assert.deepEqual(
        Object.fromEntries(
          (resource.Properties?.Tags ?? []).map(
            ({ Key, Value }: Record<string, string>) => [Key, Value],
          ),
        ),
        EXPECTED_TAGS,
      );
    }
  }
  assert.equal(
    resourceEntries(template, "AWS::Logs::ResourcePolicy").length,
    2, // Runtime delivery plus the regional Transaction Search prerequisite.
  );
  assert.equal(
    resourceEntries(template, "AWS::XRay::ResourcePolicy").length,
    1,
  );
});

test("runtime boundary stays within the IAM managed-policy size limit", () => {
  const boundary = runtimePermissionsBoundaryDocument({
    account: "111122223333",
    agentRuntimeArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567",
    agentRuntimeEndpointArnPattern:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "runtime/AgenticPlatformRuntime-ABC1234567/runtime-endpoint/*",
    cloudFrontAlarmArnPattern:
      "arn:aws:cloudwatch:us-east-1:111122223333:"
      + "alarm:PlatformWeb-AgenticPlatform-Web-*-CloudFront-5xx",
    cloudFrontDistributionArn:
      "arn:aws:cloudfront::111122223333:distribution/E1234567890ABC",
    customerSupportRegistryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/CdEfGh3456789012",
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
      + "gateway/agentic-demo-llm-gateway-example12345",
    operationsRegistryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/DeFgHi4567890123",
    partition: "aws",
    platformStateTableArn:
      "arn:aws:dynamodb:us-west-2:111122223333:"
      + "table/AgenticPlatform-Web-PlatformStateTable-EXAMPLE",
    platformRegistryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/BcDeFg2345678901",
    qualifier: "hnb659fds",
    registryDecisionFinalizerFunctionArn:
      "arn:aws:lambda:us-west-2:111122223333:"
      + "function:AgenticPlatform-Web-RegistryDecisionFinalizer",
    region: "us-west-2",
    runtimeProofConfiguratorFunctionArn:
      "arn:aws:lambda:us-west-2:111122223333:"
      + "function:AgenticPlatform-Web-RuntimeProofConfigurator",
    runtimeProofConfiguratorRoleArn:
      "arn:aws:iam::111122223333:role/"
      + "AgenticPlatform-Web-RuntimeProofConfiguratorRole",
    runtimeInvocationProofSecretArn:
      "arn:aws:secretsmanager:us-west-2:111122223333:"
      + "secret:AgenticPlatform-Web-RuntimeInvocationProof-ABC123",
    runtimePermissionsBoundaryArn:
      "arn:aws:iam::111122223333:"
      + "policy/AgenticPlatform-Web-RuntimePermissionsBoundary",
    sharedRegistryArn:
      "arn:aws:agent-registry:us-west-2:111122223333:"
      + "registry/AbCdEf1234567890",
    toolsGatewayArn:
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
      + "gateway/platform-tools-gw-example1234",
    userPoolArn:
      "arn:aws:cognito-idp:us-west-2:111122223333:"
      + "userpool/us-west-2_EXAMPLE",
  });

  const boundaryLength = JSON.stringify(boundary).length;
  assert.ok(
    boundaryLength <= 6144,
    "runtime permissions boundary exceeds the IAM managed-policy limit "
      + `(${boundaryLength}/6144)`,
  );
});

test("runtime boundary is synthesized from the committed canonical policy document", async () => {
  const { template } = fixture();
  const [, boundary] = sharedRuntimeBoundary(template);
  const statements = iamStatements(template);
  const invalidationStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("cloudfront:CreateInvalidation")
  );
  const alarmStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("cloudwatch:PutMetricAlarm")
  );
  const registryRecordStatement = statements.find(({ statement }) =>
    statementActions(statement).includes(
      "agent-registry:UpdateRegistryRecordStatus",
    )
  );
  const registryListStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("agent-registry:ListRegistryRecords")
  );
  const registryCreateStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("agent-registry:CreateRegistry")
  );
  const registryRecordCreateStatement =
    boundary.Properties?.PolicyDocument?.Statement?.find(
      (statement: Record<string, any>) =>
        statementActions(statement).includes(
          "agent-registry:CreateRegistryRecord",
        ),
    );
  const registryDeleteStatements =
    boundary.Properties?.PolicyDocument?.Statement?.filter(
      (statement: Record<string, any>) =>
        statementActions(statement).includes(
          "agent-registry:DeleteRegistry",
        ),
    );
  const gatewayReadStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("bedrock-agentcore:GetGatewayTarget")
  );
  const gatewayInvokeStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("bedrock-agentcore:InvokeGateway")
  );
  const platformStateStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("dynamodb:PutItem")
      && statement.Condition?.["ForAnyValue:StringEquals"]
        ?.["dynamodb:EnclosingOperation"]?.includes("TransactWriteItems")
  )?.statement;
  const finalizerInvokeStatement = statements.find(({ statement }) =>
    statementActions(statement).includes("lambda:InvokeFunction")
  );
  const boundaryFinalizerInvoke =
    boundary.Properties?.PolicyDocument?.Statement?.find(
      (statement: Record<string, any>) =>
        statementActions(statement).includes("lambda:InvokeFunction"),
    );
  assert.ok(invalidationStatement);
  assert.ok(alarmStatement);
  assert.ok(registryRecordStatement);
  assert.ok(registryListStatement);
  assert.ok(registryCreateStatement);
  assert.ok(registryRecordCreateStatement);
  assert.equal(registryDeleteStatements.length, 1);
  assert.deepEqual(
    statementActions(registryDeleteStatements[0]).sort(),
    [
      "agent-registry:DeleteRegistry",
      "agent-registry:SubmitRegistryRecordForApproval",
    ],
  );
  assert.equal(
    normalizedArn(registryDeleteStatements[0].Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*",
  );
  assert.deepEqual(registryDeleteStatements[0].Condition, {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": ["cdk", "hosted-acceptance"],
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
    },
  });
  assert.ok(gatewayReadStatement);
  assert.ok(gatewayInvokeStatement);
  assert.ok(platformStateStatement);
  assert.deepEqual(statementActions(platformStateStatement), [
    "dynamodb:PutItem",
  ]);
  assert.ok(finalizerInvokeStatement);
  assert.ok(boundaryFinalizerInvoke);
  assert.deepEqual(
    registryRecordCreateStatement.Resource.map(normalizedArn),
    [
      "arn:<AWS::Partition>:agent-registry:us-west-2:"
        + "111122223333:registry/*",
      "arn:<AWS::Partition>:agent-registry:us-west-2:"
        + "111122223333:registry/*/record/*",
    ],
  );
  assert.deepEqual(registryRecordCreateStatement.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": ["cdk", "hosted-acceptance"],
      "aws:RequestTag/project": "agentic-ai-platform-demo",
    },
  });
  const source = JSON.parse(
    await readFile(
      path.join(
        __dirname,
        "..",
        "config",
        "runtime-permissions-boundary.json",
      ),
      "utf8",
    ),
  );
  const sourceRegistryCreate = source.Statement.find(
    ({ Sid }: { Sid?: string }) => Sid === "CreatePlatformDomainRegistry",
  );
  assert.equal(
    sourceRegistryCreate?.Condition?.StringEquals?.["aws:RequestedRegion"],
    "${REGION}",
  );
  assert.ok(
    JSON.stringify(boundaryFinalizerInvoke.Resource)
      .includes("function:AgenticPlatform-Web-R*"),
  );
  assert.ok(
    boundary.Properties?.PolicyDocument?.Statement?.every(
      (statement: Record<string, any>) => statement.Sid === undefined,
    ),
    "deployed boundary must omit non-semantic Sids",
  );
});

test("retained runtime boundary tags use a dedicated least-privilege provider", () => {
  const { template } = fixture();
  const [boundaryId, boundary] = sharedRuntimeBoundary(template);
  const tagResources = resourceEntries(template, "Custom::RuntimePermissionsBoundaryTags");
  assert.equal(tagResources.length, 2);
  const [, resource] = tagResources.find(([, value]) => value.Properties?.PolicyArn?.Ref === boundaryId)!;

  assert.deepEqual(resource.Properties?.PolicyArn, { Ref: boundaryId });
  assert.equal(resource.Properties?.AccountId, "111122223333");
  assert.deepEqual(resource.Properties?.Partition, {
    Ref: "AWS::Partition",
  });
  assert.deepEqual(
    Object.fromEntries(
      resource.Properties?.RequiredTags.map(
        (tag: { Key: string; Value: string }) => [tag.Key, tag.Value],
      ),
    ),
    EXPECTED_TAGS,
  );
  assert.equal(resource.Properties?.ServiceTimeout, "120");

  const functionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, candidate]) =>
    candidate.Properties?.Description
      === "Reconciles mandatory tags on the retained runtime permissions boundary"
  );
  assert.ok(functionEntry);
  const [functionId, providerFunction] = functionEntry;
  assert.deepEqual(resource.Properties?.ServiceToken, {
    "Fn::GetAtt": [functionId, "Arn"],
  });
  assert.equal(providerFunction.Properties?.Runtime, "nodejs24.x");
  assert.deepEqual(providerFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(
    providerFunction.Properties?.Handler,
    "index.runtimeBoundaryTagsHandler",
  );
  assert.equal(providerFunction.Properties?.Timeout, 60);
  assert.ok(providerFunction.Properties?.LoggingConfig?.LogGroup);

  const retryConfigs = resourceEntries(
    template,
    "AWS::Lambda::EventInvokeConfig",
  ).filter(([, candidate]) =>
    candidate.Properties?.FunctionName?.Ref === functionId
  );
  assert.equal(retryConfigs.length, 1);
  const [retryConfigId, retryConfig] = retryConfigs[0];
  assert.equal(retryConfig.Properties?.MaximumRetryAttempts, 0);
  const dependencies = Array.isArray(resource.DependsOn)
    ? resource.DependsOn
    : [resource.DependsOn];
  assert.ok(dependencies.includes(retryConfigId));

  const roleId = providerFunction.Properties?.Role?.["Fn::GetAtt"]?.[0];
  assert.ok(roleId);
  const role = template.findResources("AWS::IAM::Role")[roleId];
  assert.ok(role);
  assert.equal(
    role.Properties?.RoleName,
    "AgenticPlatform-Web-RuntimeBoundaryTagProviderRole",
  );
  assert.deepEqual(role.Properties?.PermissionsBoundary, {
    Ref: boundaryId,
  });
  const roleStatements = iamStatements(template).filter(
    ({ owner }) => owner === roleId,
  );
  assert.deepEqual(
    roleStatements.flatMap(({ statement }) =>
      statementActions(statement)
    ).sort(),
    [
      "iam:ListPolicyTags",
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ],
  );
  const tagStatement = roleStatements.find(({ statement }) =>
    statementActions(statement).includes("iam:TagPolicy")
  );
  assert.ok(tagStatement);
  const expectedBoundaryArn =
    "arn:<AWS::Partition>:iam::111122223333:"
    + "policy/AgenticPlatform-Web-RuntimePermissionsBoundary";
  assert.ok(policyResourceIncludes(tagStatement.statement.Resource, expectedBoundaryArn));
  assert.equal([tagStatement.statement.Resource].flat().length, 2);

  const boundaryStatement = (
    boundary.Properties?.PolicyDocument?.Statement ?? []
  ).find((statement: Record<string, any>) =>
    statementActions(statement).includes("iam:TagPolicy")
  );
  assert.ok(boundaryStatement);
  assert.deepEqual(
    statementActions(boundaryStatement)
      .filter((action) => action.startsWith("iam:")),
    ["iam:ListPolicyTags", "iam:TagPolicy", "iam:UntagPolicy"],
  );
  assert.ok(
    policyResourceIncludes(boundaryStatement.Resource, expectedBoundaryArn),
  );
});

test("both buckets are private, S3-encrypted, SSL-only, and retained", () => {
  const { template } = fixture();
  const buckets = resourceEntries(template, "AWS::S3::Bucket");
  assert.equal(buckets.length, 2);

  for (const [, bucket] of buckets) {
    assert.deepEqual(bucket.Properties?.BucketEncryption, {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
    assert.deepEqual(bucket.Properties?.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.equal(bucket.Properties?.WebsiteConfiguration, undefined);
    assert.notEqual(bucket.Properties?.AccessControl, "PublicRead");
    assert.equal(bucket.DeletionPolicy, "Retain");
    assert.equal(bucket.UpdateReplacePolicy, "Retain");
  }

  const bucketPolicies = resourceEntries(template, "AWS::S3::BucketPolicy");
  assert.equal(bucketPolicies.length, 2);
  for (const [, policy] of bucketPolicies) {
    const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
    const sslOnly = statements.find((statement: Record<string, any>) =>
      statement.Effect === "Deny"
      && statement.Action === "s3:*"
      && statement.Principal?.AWS === "*"
      && statement.Condition?.Bool?.["aws:SecureTransport"] === "false"
    );
    assert.ok(sslOnly, "bucket policy must deny insecure transport");
    const publicRead = statements.find((statement: Record<string, any>) =>
      statement.Effect === "Allow"
      && JSON.stringify(statement.Principal).includes("*")
      && JSON.stringify(statement.Action).includes("s3:GetObject")
    );
    assert.equal(publicRead, undefined);
  }
});

test("web assets are versioned and logged to a terminal ObjectWriter log bucket", () => {
  const { template } = fixture();
  const buckets = resourceEntries(template, "AWS::S3::Bucket");
  const [webId, webBucket] = buckets.find(([, bucket]) =>
    bucket.Properties?.VersioningConfiguration?.Status === "Enabled"
  ) ?? [];
  const [logId, logBucket] = buckets.find(([, bucket]) =>
    bucket.Properties?.OwnershipControls?.Rules?.[0]?.ObjectOwnership === "ObjectWriter"
  ) ?? [];

  assert.ok(webId);
  assert.ok(logId);
  assert.deepEqual(webBucket?.Properties?.LoggingConfiguration, {
    DestinationBucketName: { Ref: logId },
    LogFilePrefix: "s3/",
  });
  const lifecycleRules = logBucket?.Properties?.LifecycleConfiguration?.Rules;
  assert.equal(lifecycleRules.length, 1);
  assert.equal(lifecycleRules[0].ExpirationInDays, 365);
  assert.equal(lifecycleRules[0].Status, "Enabled");
});

test("Cognito user pool enforces the required identity, password, MFA, and retention settings", () => {
  const { template } = fixture();
  const [, userPool] = soleResource(template, "AWS::Cognito::UserPool");
  const properties = userPool.Properties ?? {};

  assert.equal(properties.UserPoolName, "agentic-platform-users");
  assert.deepEqual(properties.AdminCreateUserConfig, {
    AllowAdminCreateUserOnly: true,
  });
  assert.deepEqual(properties.AliasAttributes, ["email"]);
  assert.deepEqual(properties.AutoVerifiedAttributes, ["email"]);
  assert.deepEqual(properties.Policies?.PasswordPolicy, {
    MinimumLength: 14,
    RequireLowercase: true,
    RequireNumbers: true,
    RequireSymbols: true,
    RequireUppercase: true,
    TemporaryPasswordValidityDays: 3,
  });
  assert.deepEqual(properties.AccountRecoverySetting, {
    RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }],
  });
  assert.equal(properties.MfaConfiguration, "OPTIONAL");
  assert.deepEqual(properties.EnabledMfas, ["SOFTWARE_TOKEN_MFA"]);
  assert.equal(properties.DeletionProtection, "ACTIVE");
  assert.equal(userPool.DeletionPolicy, "Retain");
  assert.equal(userPool.UpdateReplacePolicy, "Retain");

  const schema = properties.Schema as Array<Record<string, any>>;
  assert.deepEqual(schema.find((attribute) => attribute.Name === "email"), {
    Mutable: true,
    Name: "email",
    Required: false,
  });
  assert.deepEqual(schema.find((attribute) => attribute.Name === "name"), {
    Mutable: true,
    Name: "name",
    Required: false,
  });
  const managedBy = schema.find(
    (attribute) => attribute.Name === "managed_by",
  );
  assert.equal(managedBy?.DeveloperOnlyAttribute ?? false, false);
  assert.equal(managedBy?.Required ?? false, false);
  assert.deepEqual(managedBy, {
    AttributeDataType: "String",
    Mutable: false,
    Name: "managed_by",
    StringAttributeConstraints: {
      MaxLength: "24",
      MinLength: "24",
    },
  });
});

test("Cognito groups and web client use exact code-flow settings and CloudFront URLs", () => {
  const { template } = fixture();
  const [distributionId] = soleResource(template, "AWS::CloudFront::Distribution");
  const [, userPoolClient] = soleResource(template, "AWS::Cognito::UserPoolClient");
  const client = userPoolClient.Properties ?? {};

  const groups = resourceEntries(template, "AWS::Cognito::UserPoolGroup")
    .map(([, group]) => ({
      description: group.Properties?.Description,
      groupName: group.Properties?.GroupName,
      precedence: group.Properties?.Precedence,
      roleArn: group.Properties?.RoleArn,
    }));
  const roleGroups = groups
    .filter(({ precedence }) => typeof precedence === "number")
    .map(({ roleArn: _roleArn, ...group }) => group)
    .sort((a, b) => a.precedence - b.precedence);
  assert.deepEqual(roleGroups, [
    { description: undefined, groupName: "platform-admin", precedence: 10 },
    { description: undefined, groupName: "domain-builder", precedence: 20 },
    { description: undefined, groupName: "end-user", precedence: 30 },
    { description: undefined, groupName: "demo-operator", precedence: 40 },
  ]);
  assert.deepEqual(
    groups
      .filter(({ groupName, precedence }) =>
        precedence === undefined && groupName.startsWith("domain-")
      )
      .map(({ roleArn: _roleArn, ...group }) => group)
      .sort((left, right) => left.groupName.localeCompare(right.groupName)),
    [
      {
        description:
          "agentic-ai-platform-demo:domain-group-baseline:v1;"
          + "ownerGroup=domain-customer-support;auto-delete=no",
        groupName: "domain-customer-support",
        precedence: undefined,
      },
      {
        description:
          "agentic-ai-platform-demo:domain-group-baseline:v1;"
          + "ownerGroup=domain-operations;auto-delete=no",
        groupName: "domain-operations",
        precedence: undefined,
      },
      {
        description:
          "agentic-ai-platform-demo:domain-group-baseline:v1;"
          + "ownerGroup=domain-platform;auto-delete=no",
        groupName: "domain-platform",
        precedence: undefined,
      },
    ],
  );
  assert.equal(
    groups.some(({ roleArn }) => roleArn !== undefined),
    false,
  );
  assert.deepEqual(
    groups.map(({ groupName }) => groupName).sort(),
    [
      "demo-operator",
      "domain-builder",
      "domain-customer-support",
      "domain-operations",
      "domain-platform",
      "end-user",
      "platform-admin",
    ],
  );
  assert.equal(
    groups.some(({ groupName }) => groupName === "domain-lead"),
    false,
  );

  assert.equal(client.ClientName, "agentic-platform-web");
  assert.equal(client.GenerateSecret, false);
  assert.equal(client.PreventUserExistenceErrors, "ENABLED");
  assert.equal(client.EnableTokenRevocation, true);
  assert.ok(
    client.ExplicitAuthFlows.includes("ALLOW_USER_SRP_AUTH"),
    "web client must explicitly allow SRP authentication",
  );
  assert.ok(
    client.ExplicitAuthFlows.includes("ALLOW_ADMIN_USER_PASSWORD_AUTH"),
    "web client must allow the server-side hosted acceptance verifier",
  );
  assert.deepEqual(client.AllowedOAuthFlows, ["code"]);
  assert.equal(client.AllowedOAuthFlowsUserPoolClient, true);
  assert.deepEqual(client.AllowedOAuthScopes, ["openid", "email", "profile"]);
  assert.deepEqual(client.SupportedIdentityProviders, ["COGNITO"]);
  assert.equal(client.AccessTokenValidity, 60);
  assert.equal(client.IdTokenValidity, 60);
  assert.equal(client.RefreshTokenValidity, 1440);
  assert.deepEqual(client.TokenValidityUnits, {
    AccessToken: "minutes",
    IdToken: "minutes",
    RefreshToken: "minutes",
  });
  assert.deepEqual(client.CallbackURLs, [cloudFrontRootUrl(distributionId)]);
  assert.deepEqual(client.LogoutURLs, [cloudFrontRootUrl(distributionId)]);

  template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
    Domain: "agentic-platform-test",
  });
});

test("CognitoDomain output uses the full regional hosted UI URL", () => {
  const { template } = fixture();
  const [domainId] = soleResource(template, "AWS::Cognito::UserPoolDomain");
  const outputs = template.findOutputs("CognitoDomain");

  assert.deepEqual(outputs.CognitoDomain.Value, cognitoHostedUrl(domainId));
});

test("identity Lambda is bundled with exact domain-state configuration and read permission", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [userPoolId] = soleResource(template, "AWS::Cognito::UserPool");
  const functions = resourceEntries(template, "AWS::Lambda::Function");
  const [functionId, identityFunction] = functions.find(([, resource]) =>
    resource.Properties?.Description ===
      "Stage 1 platform health and Cognito identity projection"
  ) ?? [];
  assert.ok(functionId);

  assert.equal(identityFunction?.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(identityFunction?.Properties?.Architectures, ["arm64"]);
  assert.equal(identityFunction?.Properties?.Handler, "index.handler");
  assert.equal(identityFunction?.Properties?.MemorySize, 256);
  assert.equal(identityFunction?.Properties?.Timeout, 5);
  assert.equal(identityFunction?.Properties?.ReservedConcurrentExecutions, undefined);
  assert.deepEqual(identityFunction?.Properties?.TracingConfig, { Mode: "Active" });
  assert.ok(identityFunction?.Properties?.Code?.S3Key);
  assert.deepEqual(identityFunction?.Properties?.Environment?.Variables, {
    COGNITO_USER_POOL_ID: { Ref: userPoolId },
    PLATFORM_STATE_TABLE_NAME: { Ref: tableId },
  });

  const roleReference = identityFunction?.Properties?.Role?.["Fn::GetAtt"];
  assert.ok(Array.isArray(roleReference));
  const executionRole = template.findResources("AWS::IAM::Role")[roleReference[0]];
  assert.ok(executionRole);
  assert.equal(executionRole.Properties?.ManagedPolicyArns, undefined);

  const allPolicyDocuments = [
    ...(executionRole.Properties?.Policies ?? []).map(
      (policy: Record<string, any>) => policy.PolicyDocument,
    ),
    ...resourceEntries(template, "AWS::IAM::Policy")
      .filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles).includes(roleReference[0])
      )
      .map(([, policy]) => policy.Properties?.PolicyDocument),
  ];
  const statements = allPolicyDocuments.flatMap((document) => document.Statement);
  const actions = new Set(
    statements.flatMap((statement: Record<string, any>) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    ),
  );
  assert.deepEqual([...actions].sort(), [
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
    "dynamodb:Query",
    "logs:CreateLogStream",
    "logs:PutLogEvents",
    "xray:PutTelemetryRecords",
    "xray:PutTraceSegments",
  ]);

  const stateStatement = statements.find((statement: Record<string, any>) =>
    statementActions(statement).includes("dynamodb:Query")
  );
  assert.deepEqual(stateStatement, {
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
    Resource: {
      "Fn::GetAtt": [tableId, "Arn"],
    },
  });
  assert.doesNotMatch(
    statements.flatMap(statementActions).join("\n"),
    /dynamodb:(?:BatchGetItem|DeleteItem|GetItem|PutItem|Scan|TransactWriteItems|UpdateItem)/,
  );

  const xrayStatement = statements.find((statement: Record<string, any>) =>
    JSON.stringify(statement.Action).includes("xray:PutTraceSegments")
  );
  assert.deepEqual(xrayStatement?.Resource, "*");
});

test("workspace Lambda is separately bundled with exact scoped state access", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [userPoolId] = soleResource(template, "AWS::Cognito::UserPool");
  const functions = resourceEntries(template, "AWS::Lambda::Function");
  const [functionId, workspaceFunction] = functions.find(([, resource]) =>
    resource.Properties?.Description ===
      "Reads authorized project, agent, deployment, and approval workspaces"
  ) ?? [];
  assert.ok(functionId);

  assert.equal(workspaceFunction?.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(workspaceFunction?.Properties?.Architectures, ["arm64"]);
  assert.equal(workspaceFunction?.Properties?.Handler, "index.handler");
  assert.equal(workspaceFunction?.Properties?.MemorySize, 512);
  assert.equal(workspaceFunction?.Properties?.Timeout, 30);
  assert.equal(
    workspaceFunction?.Properties?.ReservedConcurrentExecutions,
    undefined,
  );
  assert.deepEqual(
    workspaceFunction?.Properties?.TracingConfig,
    { Mode: "Active" },
  );
  assert.ok(workspaceFunction?.Properties?.Code?.S3Key);
  assert.deepEqual(workspaceFunction?.Properties?.Environment?.Variables, {
    COGNITO_USER_POOL_ID: { Ref: userPoolId },
    PLATFORM_STATE_TABLE_NAME: { Ref: tableId },
    CONTROL_PLANE_CONFIG: functions.find(([id]) => id.startsWith("ControlPlaneReadApiFunction"))?.[1].Properties?.Environment?.Variables.CONTROL_PLANE_CONFIG,
    GATEWAY_INVOKER_ROLE_ARN: { "Fn::GetAtt": [resourceEntries(template, "AWS::IAM::Role").find(([, r]) => r.Properties?.RoleName === PLATFORM_WEB_RUNTIME_ROLE_NAMES.gatewayInvoker)?.[0], "Arn"] },
  });

  const roleReference = workspaceFunction?.Properties?.Role?.["Fn::GetAtt"];
  assert.ok(Array.isArray(roleReference));
  const executionRole =
    template.findResources("AWS::IAM::Role")[roleReference[0]];
  assert.equal(
    executionRole?.Properties?.RoleName,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.workspaceApi,
  );
  assert.equal(executionRole?.Properties?.ManagedPolicyArns, undefined);

  const statements = [
    ...(executionRole?.Properties?.Policies ?? []).flatMap(
      (policy: Record<string, any>) =>
        policy.PolicyDocument.Statement,
    ),
    ...resourceEntries(template, "AWS::IAM::Policy")
      .filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles).includes(roleReference[0])
      )
      .flatMap(([, policy]) =>
        policy.Properties?.PolicyDocument.Statement
      ),
  ];
  assert.deepEqual(
    [...new Set(statements.flatMap(statementActions))].sort(),
    [
      "agent-registry:GetDiscoverableRegistryRecord",
      "agent-registry:GetRegistryRecord",
      "agent-registry:ListRegistryRecords",
      "bedrock-agentcore:GetGatewayTarget",
      "bedrock-agentcore:GetMemory",
      "bedrock-agentcore:ListGatewayTargets",
      "bedrock-agentcore:ListMemories",
      "bedrock:GetKnowledgeBase",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminListGroupsForUser",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "sts:AssumeRole",
      "sts:SetSourceIdentity",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ],
  );
  const stateStatement = statements.find((statement: Record<string, any>) =>
    statementActions(statement).includes("dynamodb:Query")
  );
  assert.deepEqual(stateStatement, {
    Action: [
      "dynamodb:GetItem",
      "dynamodb:Query",
    ],
    Condition: {
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
    Effect: "Allow",
    Resource: {
      "Fn::GetAtt": [tableId, "Arn"],
    },
  });
  const mutationStatement = statements.find(
    (statement: Record<string, any>) =>
      statementActions(statement).includes("dynamodb:PutItem"),
  );
  assert.deepEqual(mutationStatement, {
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
    Resource: {
      "Fn::GetAtt": [tableId, "Arn"],
    },
  });
  assert.doesNotMatch(
    statements.flatMap(statementActions).join("\n"),
    /dynamodb:(?:BatchGetItem|DeleteItem|Scan|TransactWriteItems|UpdateItem)/,
  );
});

test("web stack imports the complete stable control-plane export contract", () => {
  const { template } = fixture();
  assert.deepEqual(
    [...new Set(collectImportValues(template.toJSON()))].sort(),
    [...CONTROL_PLANE_EXPORTS].sort(),
  );
});

test("control-plane Lambda is separately bundled for Node.js 22 ARM64 with the exact service configuration", async () => {
  const { template } = fixture();
  const functions = resourceEntries(template, "AWS::Lambda::Function");
  const functionEntry = functions.find(([, resource]) =>
    resource.Properties?.Description ===
      "Reads scoped AWS Registry and AgentCore Gateway inventory"
  );
  assert.ok(functionEntry);
  const [, controlPlaneFunction] = functionEntry;

  assert.equal(controlPlaneFunction.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(controlPlaneFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(controlPlaneFunction.Properties?.Handler, "index.handler");
  assert.deepEqual(
    controlPlaneFunction.Properties?.TracingConfig,
    { Mode: "Active" },
  );
  assert.ok(controlPlaneFunction.Properties?.Code?.S3Key);
  const [platformStateTableId] = soleResource(
    template,
    "AWS::DynamoDB::Table",
  );
  assert.deepEqual(
    controlPlaneFunction.Properties?.Environment?.Variables
      ?.PLATFORM_STATE_TABLE_NAME,
    { Ref: platformStateTableId },
  );

  const serializedConfig = resolveImportValues(
    controlPlaneFunction.Properties?.Environment?.Variables
      ?.CONTROL_PLANE_CONFIG,
  );
  assert.equal(typeof serializedConfig, "string");
  const controlPlaneConfig = JSON.parse(serializedConfig as string);
  assert.equal(
    Object.hasOwn(
      controlPlaneConfig.domainRegistryIds,
      "customer-support",
    ),
    false,
  );
  assert.deepEqual(controlPlaneConfig, {
    accountId: "111122223333",
    region: importMarker("AgenticPlatform-ControlPlane-Region"),
    sharedRegistryId:
      importMarker("AgenticPlatform-ControlPlane-SharedRegistryId"),
    domainRegistryIds: {
      platform:
        importMarker(
          "AgenticPlatform-ControlPlane-Registry-platform-Id",
        ),
      customer_support:
        importMarker(
          "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
        ),
      operations:
        importMarker(
          "AgenticPlatform-ControlPlane-Registry-operations-Id",
        ),
    },
    llmGatewayId: LLM_GATEWAY_ID,
    llmGatewayRegion: LLM_GATEWAY_REGION,
    llmGatewayUrl: LLM_GATEWAY_URL,
    toolsGatewayId:
      importMarker("AgenticPlatform-ControlPlane-ToolsGatewayId"),
    toolsGatewayUrl:
      importMarker("AgenticPlatform-ControlPlane-ToolsGatewayUrl"),
  });

  const stackSource = await readFile(
    path.join(__dirname, "..", "lib", "platform-web-stack.ts"),
    "utf8",
  );
  assert.match(
    stackSource,
    /new nodejs\.NodejsFunction\([\s\S]*?bundleAwsSDK:\s*true/,
  );
  const serviceSource = await readFile(
    path.join(
      __dirname,
      "..",
      "lambda",
      "control-plane",
      "service.mjs",
    ),
    "utf8",
  );
  assert.match(serviceSource, /@aws-sdk\/client-agent-registry-control/);
  assert.match(
    serviceSource,
    /@aws-sdk\/client-bedrock-agentcore-control/,
  );
});

test("governance, experience, and operations APIs are separately deployed with bounded AWS integrations", () => {
  const { template } = fixture();
  const functions = resourceEntries(template, "AWS::Lambda::Function");
  const expected = [
    {
      description:
        "Runs domain-scoped Agent Registry publication and access governance",
      roleName: "AgenticPlatform-Web-GovernanceApiRole",
      requiredActions: [
        "agent-registry:CreateRegistryRecord",
        "agent-registry:GetRegistryRecord",
        "agent-registry:ListRegistryRecords",
        "agent-registry:SubmitRegistryRecordForApproval",
        "agent-registry:UpdateRegistryRecordStatus",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
      ],
    },
    {
      description:
        "Serves entitled approved agents and governed Runtime invocation",
      roleName: "AgenticPlatform-Web-ExperienceApiRole",
      requiredActions: [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeForUser",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
      ],
    },
    {
      description:
        "Reads scoped AgentCore operational metrics and estimated cost",
      roleName: "AgenticPlatform-Web-OperationsApiRole",
      requiredActions: [
        "cloudwatch:GetMetricData",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
      ],
    },
  ] as const;

  for (const contract of expected) {
    const functionEntry = functions.find(([, resource]) =>
      resource.Properties?.Description === contract.description
    );
    assert.ok(functionEntry, contract.description);
    const [, deployedFunction] = functionEntry;
    assert.equal(deployedFunction.Properties?.Runtime, "nodejs22.x");
    assert.deepEqual(deployedFunction.Properties?.Architectures, ["arm64"]);
    assert.deepEqual(deployedFunction.Properties?.TracingConfig, {
      Mode: "Active",
    });
    assert.equal(deployedFunction.Properties?.ReservedConcurrentExecutions, undefined);
    const roleReference = deployedFunction.Properties?.Role?.["Fn::GetAtt"];
    assert.ok(Array.isArray(roleReference));
    const role =
      template.findResources("AWS::IAM::Role")[roleReference[0]];
    assert.equal(role.Properties?.RoleName, contract.roleName);
    const actions = iamStatements(template)
      .filter(({ owner }) => owner === roleReference[0])
      .flatMap(({ statement }) => statementActions(statement));
    for (const action of contract.requiredActions) {
      assert.ok(actions.includes(action), `${contract.roleName}: ${action}`);
    }
    assert.deepEqual(
      actions.filter((action) => action.startsWith("cognito-idp:")).sort(),
      [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminListGroupsForUser",
      ],
    );
  }

  const routeKeys = resourceEntries(template, "AWS::ApiGatewayV2::Route")
    .map(([, route]) => route.Properties?.RouteKey);
  for (const routeKey of [
    "POST /api/governance/agent-publications",
    "POST /api/governance/resources",
    "POST /api/governance/publications",
    "POST /api/governance/publication-decisions",
    "GET /api/governance/shared-resources",
    "POST /api/governance/access-requests",
    "POST /api/governance/access-decisions",
    "POST /api/governance/access-revocations",
    "GET /api/governance/agent-entitlements",
    "POST /api/governance/agent-entitlements",
    "POST /api/governance/agent-entitlement-revocations",
    "GET /api/experience/agents",
    "POST /api/experience/invocations",
    "GET /api/experience/sessions",
    "GET /api/experience/access-requests",
    "POST /api/experience/feedback",
    "POST /api/experience/issues",
    "POST /api/experience/access-requests",
    "GET /api/operations",
    "GET /api/costs",
    "GET /api/operations/audit",
    "GET /api/incidents",
    "POST /api/incidents",
    "POST /api/incidents/{id}/actions",
    "GET /api/break-glass",
    "POST /api/break-glass/requests",
    "POST /api/break-glass/decisions",
    "POST /api/break-glass/activations",
    "POST /api/break-glass/revocations",
  ]) {
    assert.ok(routeKeys.includes(routeKey), routeKey);
  }

  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [governanceRoleId] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.governanceApi,
  );
  const entitlementIndexQuery = iamStatements(template)
    .filter(({ owner }) => owner === governanceRoleId)
    .map(({ statement }) => statement)
    .find((statement) =>
      JSON.stringify(statement.Resource).includes("EntityTypeIndex")
    );
  assert.ok(entitlementIndexQuery);
  assert.deepEqual(
    statementActions(entitlementIndexQuery),
    ["dynamodb:Query"],
  );
  assert.deepEqual(entitlementIndexQuery.Resource, {
    "Fn::Join": [
      "",
      [
        { "Fn::GetAtt": [tableId, "Arn"] },
        "/index/EntityTypeIndex",
      ],
    ],
  });
  assert.deepEqual(entitlementIndexQuery.Condition, {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["ENTITLEMENT"],
    },
  });

  const governanceStateRead = iamStatements(template)
    .filter(({ owner }) => owner === governanceRoleId)
    .map(({ statement }) => statement)
    .find((statement) =>
      statementActions(statement).includes("dynamodb:GetItem")
      && statementActions(statement).includes("dynamodb:Query")
      && !JSON.stringify(statement.Resource).includes("EntityTypeIndex")
      && !JSON.stringify(statement.Condition).includes("GUARDRAIL_EXCEPTION")
    );
  assert.ok(governanceStateRead);
  assert.deepEqual(governanceStateRead.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(statementActions(governanceStateRead), [
    "dynamodb:GetItem",
    "dynamodb:Query",
  ]);
  assert.deepEqual(governanceStateRead.Condition, {
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
  });

  const operationsFunction = functions.find(([, resource]) =>
    resource.Properties?.Description ===
      "Reads scoped AgentCore operational metrics and estimated cost"
  )?.[1];
  assert.ok(operationsFunction);
  // The deployed price book is the committed, activated Haiku catalog —
  // the same canonical document the direct-runtime price validators pin.
  const deployedPriceBook = JSON.parse(
    operationsFunction.Properties?.Environment?.Variables
      ?.OPERATIONS_MODEL_PRICES_JSON,
  );
  assert.equal(deployedPriceBook.version, 3);
  assert.equal(deployedPriceBook.entries.length, 1);
  assert.equal(deployedPriceBook.entries[0].activation, "active");
  assert.equal(
    deployedPriceBook.entries[0].request.modelId,
    "bedrock-claude/anthropic.claude-haiku-4-5",
  );
  assert.equal(
    operationsFunction.Properties?.Environment?.Variables
      ?.OPERATIONS_BUDGETS_JSON,
    "{}",
  );
  assert.ok(
    operationsFunction.Properties?.Environment?.Variables
      ?.OPERATIONS_CURSOR_SIGNING_KEY,
  );
});

test("operations state access is exact and audit metadata queries cannot mutate the table", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [roleId] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi,
  );
  const statements = iamStatements(template)
    .filter(({ owner }) => owner === roleId)
    .map(({ statement }) => statement);
  const dynamoStatements = statements.filter((statement) =>
    statementActions(statement).some((action) =>
      action.startsWith("dynamodb:")
    )
  );
  assert.equal(dynamoStatements.length, 6);
  const legacyStatements = dynamoStatements.filter(statement =>
    !JSON.stringify(statement.Condition ?? {}).includes('PROJECT_BUDGET#*'));
  assert.equal(legacyStatements.length, 4);

  const read = legacyStatements.find((statement) =>
    statementActions(statement).includes("dynamodb:Query")
  );
  const auditQuery = dynamoStatements.find((statement) =>
    JSON.stringify(statement.Resource).includes("EntityTypeIndex")
  );
  const write = legacyStatements.find((statement) =>
    statementActions(statement).includes("dynamodb:PutItem")
  );
  assert.ok(read);
  assert.ok(auditQuery);
  assert.ok(write);
  assert.deepEqual(read.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(statementActions(read), [
    "dynamodb:GetItem",
    "dynamodb:Query",
  ]);
  assert.deepEqual(read.Condition, {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": [
        "BREAK_GLASS",
        "DOMAIN",
        "INCIDENT#*",
        "MUTATION#*",
        "PROJECT#*",
      ],
    },
  });
  assert.deepEqual(statementActions(auditQuery), ["dynamodb:Query"]);
  assert.deepEqual(auditQuery.Resource, {
    "Fn::Join": [
      "",
      [
        { "Fn::GetAtt": [tableId, "Arn"] },
        "/index/EntityTypeIndex",
      ],
    ],
  });
  assert.deepEqual(auditQuery.Condition, {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["WORKSPACE_AUDIT", "EXPERIENCE_INVOCATION"],
    },
  });
  assert.deepEqual(write.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(statementActions(write), [
    "dynamodb:PutItem",
  ]);
  assert.deepEqual(write.Condition, {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": [
        "AUDIT#*",
        "BREAK_GLASS",
        "INCIDENT#*",
        "MUTATION#*",
      ],
    },
    "ForAnyValue:StringEquals": {
      "dynamodb:EnclosingOperation": ["TransactWriteItems"],
    },
  });
  assert.doesNotMatch(
    dynamoStatements.flatMap(statementActions).join("\n"),
    /dynamodb:(?:BatchWriteItem|DeleteItem|Scan|TransactWriteItems|UpdateItem)/,
  );
});

test("state-writing runtime roles authorize transactions through exact item actions", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const expected = [
    {
      roleName: PLATFORM_ADMIN_API_ROLE_NAME,
      actions: ["dynamodb:PutItem"],
      leadingKeys: ["DOMAIN", "REGISTRY_RECORD#*", "REQUEST#*"],
    },
    {
      roleName: REGISTRY_DECISION_FINALIZER_ROLE_NAME,
      actions: ["dynamodb:PutItem"],
      leadingKeys: ["AUDIT#*", "REGISTRY_RECORD#*", "REQUEST#*"],
    },
    {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.builderApi,
      actions: ["dynamodb:PutItem"],
      leadingKeys: ["AGENT#*", "AUDIT#*", "MUTATION#*"],
    },
    {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.deploymentApi,
      actions: ["dynamodb:PutItem"],
      leadingKeys: [
        "AGENT#*",
        "APPROVAL#*",
        "AUDIT#*",
        "DEPLOYMENT#*",
        "MUTATION#*",
      ],
    },
    {
      // Base governed writes plus the HITL and alert draft catalogs
      // (release/platform-demo-dev), each written inside TransactWriteItems.
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.governanceApi,
      actions: [
        ["dynamodb:PutItem"],
        ["dynamodb:PutItem"],
        ["dynamodb:PutItem"],
      ],
      leadingKeySets: [
        ["APPROVAL#*", "AUDIT#*", "ENTITLEMENT#*", "GRANT#*", "MUTATION#*"],
        ["HITL_POLICY#platform"],
        ["ALERT_POLICY#platform"],
      ],
    },
    {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi,
      actions: ["dynamodb:PutItem"],
      leadingKeys: [
        "APPROVAL#*",
        "AUDIT#*",
        "MUTATION#*",
        "NATIVE_EXECUTION_BINDING#*",
        "NATIVE_EXECUTION_EVENT#*",
        "SESSION#*",
      ],
    },
    {
      roleName: PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi,
      actions: [["dynamodb:PutItem"], ["dynamodb:ConditionCheckItem"]],
      leadingKeysByAction: {
        "dynamodb:PutItem": ["AUDIT#*", "BREAK_GLASS", "INCIDENT#*", "MUTATION#*"],
        "dynamodb:ConditionCheckItem": ["PROJECT_BUDGET#*"],
      },
    },
    {
      roleName: HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
      actions: [
        ["dynamodb:DeleteItem"],
        ["dynamodb:DeleteItem"],
        ["dynamodb:PutItem"],
      ],
      leadingKeysBySid: {
        DeleteHostedAcceptanceExperienceFixture: [
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
        DeleteHostedAcceptanceAgentBuildingJourneys: [
          "DELIVERY#*",
          "JOURNEY#*",
          "MUTATION#*",
        ],
        WriteHostedAcceptanceExperienceFixture: [
          "AGENT#customer_support#hosted-project-*",
          "AGENT#operations#hosted-project-*",
          "DEPLOYMENT#customer_support#hosted-project-*",
          "DEPLOYMENT#operations#hosted-project-*",
          "ENTITLEMENT#*",
          "PROJECT#customer_support",
          "PROJECT#operations",
        ],
      },
    },
  ] as const;

  for (const contract of expected) {
    const [roleId] = namedRole(template, contract.roleName);
    const statements = iamStatements(template)
      .filter(({ owner }) => owner === roleId)
      .map(({ statement }) => statement);
    const transactionStatements = statements.filter((statement) =>
      statement.Condition?.["ForAnyValue:StringEquals"]
        ?.["dynamodb:EnclosingOperation"]?.includes("TransactWriteItems")
    );
    const expectedActionSets =
      Array.isArray(contract.actions[0])
        ? contract.actions
        : [contract.actions];
    assert.equal(
      transactionStatements.length,
      expectedActionSets.length,
      `${contract.roleName} transaction item-action statement count`,
    );
    assert.deepEqual(
      transactionStatements.map(statementActions).sort(),
      expectedActionSets.map((actions) => [...actions].sort()).sort(),
      `${contract.roleName} transaction actions`,
    );
    for (const statement of transactionStatements) {
      // Draft-catalog writes pin their single key with StringEquals; the
      // governed base writes use StringLike patterns.
      const actualLeadingKeys =
        statement.Condition?.["ForAllValues:StringLike"]
          ?.["dynamodb:LeadingKeys"]
        ?? statement.Condition?.["ForAllValues:StringEquals"]
          ?.["dynamodb:LeadingKeys"];
      const expectedLeadingKeys = "leadingKeysBySid" in contract
        ? (
          contract.leadingKeysBySid as Record<
            string,
            readonly string[]
          >
        )[statement.Sid]
        : "leadingKeysByAction" in contract
        ? (
          contract.leadingKeysByAction as Record<
            string,
            readonly string[]
          >
        )[statementActions(statement).join(",")]
        : "leadingKeySets" in contract
        ? (contract.leadingKeySets as readonly (readonly string[])[])
          .find((candidate) =>
            JSON.stringify([...candidate])
              === JSON.stringify(actualLeadingKeys))
        : contract.leadingKeys;
      assert.ok(
        expectedLeadingKeys,
        `${contract.roleName} unexpected leading keys `
          + JSON.stringify(actualLeadingKeys),
      );
      assert.deepEqual(statement.Resource, {
        "Fn::GetAtt": [tableId, "Arn"],
      });
      assert.deepEqual(
        actualLeadingKeys,
        [...expectedLeadingKeys],
        `${contract.roleName} transaction leading keys`,
      );
    }
    assert.equal(
      statements.flatMap(statementActions)
        .includes("dynamodb:TransactWriteItems"),
      false,
      `${contract.roleName} must not use the ineffective transaction action`,
    );
  }
});

test("experience access-request tracking queries only approval metadata", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [roleId] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi,
  );
  const statements = iamStatements(template)
    .filter(({ owner }) => owner === roleId)
    .map(({ statement }) => statement);
  const approvalQuery = statements.find((statement) =>
    JSON.stringify(statement.Resource).includes("EntityTypeIndex")
  );

  assert.ok(approvalQuery);
  assert.deepEqual(statementActions(approvalQuery), ["dynamodb:Query"]);
  assert.deepEqual(approvalQuery.Resource, {
    "Fn::Join": [
      "",
      [
        { "Fn::GetAtt": [tableId, "Arn"] },
        "/index/EntityTypeIndex",
      ],
    ],
  });
  assert.deepEqual(approvalQuery.Condition, {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["APPROVAL"],
    },
  });
});

test("experience invocation journal access is limited to its actor-bound partition", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [roleId] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi,
  );
  const statements = iamStatements(template)
    .filter(({ owner }) => owner === roleId)
    .map(({ statement }) => statement);
  const invocationJournal = statements.find((statement) =>
    statementActions(statement).includes("dynamodb:UpdateItem")
  );

  assert.ok(invocationJournal);
  assert.deepEqual(statementActions(invocationJournal), [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
  ]);
  assert.deepEqual(invocationJournal.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(invocationJournal.Condition, {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": ["EXPERIENCE_INVOCATION#*"],
    },
  });
});

test("native execution evidence separates immutable Experience bindings from Runtime writes and remains disabled", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const statementsFor = (name: string) => {
    const [roleId] = namedRole(template, name);
    const policies = new Set(resourceEntries(template, "AWS::IAM::Policy")
      .filter(([, resource]) => resource.Properties?.Roles?.some((role: any) => role.Ref === roleId))
      .map(([id]) => id));
    return iamStatements(template).filter(({ owner }) => owner === roleId || policies.has(owner))
      .map(({ statement }) => statement);
  };
  const runtime = statementsFor(PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime);
  const event = runtime.find(statement => statementActions(statement).includes("dynamodb:UpdateItem"));
  assert.deepEqual(statementActions(event!), ["dynamodb:GetItem", "dynamodb:UpdateItem"]);
  assert.deepEqual(event!.Resource, { "Fn::GetAtt": [tableId, "Arn"] });
  assert.deepEqual(event!.Condition, {
    "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["NATIVE_EXECUTION_EVENT#*"] },
  });
  assert.equal(JSON.stringify(runtime).includes("NATIVE_EXECUTION_BINDING"), false);
  assert.equal(runtime.some(statement => statementActions(statement).some(action =>
    ["dynamodb:Query", "dynamodb:Scan", "dynamodb:DeleteItem", "dynamodb:TransactWriteItems"].includes(action))), false);
  const experience = statementsFor(PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi);
  const binding = experience.find(statement =>
    statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]?.includes("NATIVE_EXECUTION_BINDING#*"));
  assert.deepEqual(statementActions(binding!), ["dynamodb:PutItem"]);
  assert.deepEqual(binding!.Condition["ForAnyValue:StringEquals"], {
    "dynamodb:EnclosingOperation": ["TransactWriteItems"],
  });
  assert.equal(experience.some(statement => statementActions(statement).includes("dynamodb:ConditionCheckItem")), false);
  const operations = statementsFor(PLATFORM_WEB_RUNTIME_ROLE_NAMES.operationsApi);
  const read = operations.find(statement =>
    statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]?.includes("NATIVE_EXECUTION_BINDING#*"));
  assert.deepEqual(statementActions(read!), ["dynamodb:GetItem"]);
  const boundary = resourceEntries(template, "AWS::IAM::ManagedPolicy")
    .find(([, resource]) => resource.Properties?.ManagedPolicyName === RUNTIME_PERMISSIONS_BOUNDARY_NAME)![1];
  const maximum = boundary.Properties!.PolicyDocument.Statement;
  for (const action of ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]) {
    const rule = maximum.find((statement: any) => statementActions(statement).includes(action)
      && !statement.Condition && JSON.stringify(statement.Resource).includes(tableId));
    assert.ok(rule, `${action} must also be allowed on this table by the synthesized boundary`);
  }
  for (const [, resource] of [...resourceEntries(template, "AWS::Lambda::Function"),
    ...resourceEntries(template, "AWS::BedrockAgentCore::Runtime")]) {
    const env = resource.Properties?.Environment?.Variables ?? resource.Properties?.EnvironmentVariables ?? {};
    assert.equal(Object.keys(env).some(key => key.endsWith("NATIVE_EXECUTION_VERSION")), false);
    assert.equal(Object.hasOwn(env, "RUNTIME_USAGE_ROUTE_JSON"), false);
  }
});

test("experience submission replays can read only actor-bound submission records", () => {
  const { template } = fixture();
  const [tableId] = soleResource(template, "AWS::DynamoDB::Table");
  const [roleId] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.experienceApi,
  );
  const statements = iamStatements(template)
    .filter(({ owner }) => owner === roleId)
    .map(({ statement }) => statement);
  const submissionJournal = statements.find((statement) =>
    statement.Condition?.["ForAllValues:StringLike"]
      ?.["dynamodb:LeadingKeys"]?.includes("SUBMISSION#*")
  );

  assert.ok(submissionJournal);
  assert.deepEqual(statementActions(submissionJournal), [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
  ]);
  assert.deepEqual(submissionJournal.Resource, {
    "Fn::GetAtt": [tableId, "Arn"],
  });
  assert.deepEqual(submissionJournal.Condition, {
    "ForAllValues:StringLike": {
      "dynamodb:LeadingKeys": ["SUBMISSION#*"],
    },
  });
});

test("control-plane role reads durable domains and tag-owned dynamic Registries without delete access", () => {
  const { template } = fixture();
  const [platformStateTableId] = soleResource(
    template,
    "AWS::DynamoDB::Table",
  );
  const controlRoleEntry = resourceEntries(template, "AWS::IAM::Role")
    .find(([, role]) =>
      role.Properties?.RoleName
        === PLATFORM_WEB_RUNTIME_ROLE_NAMES.controlPlaneReadApi
    );
  assert.ok(controlRoleEntry);
  const [controlRoleId] = controlRoleEntry;
  const roleStatements = iamStatements(template)
    .filter(({ owner }) => owner === controlRoleId)
    .map(({ statement }) => statement);
  const controlRole = template.findResources("AWS::IAM::Role")[controlRoleId];
  const controlPlanePolicyDocuments = [
    ...(controlRole.Properties?.Policies ?? []).map(
      (policy: Record<string, any>) => policy.PolicyDocument,
    ),
    ...resourceEntries(template, "AWS::IAM::Policy")
      .filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles).includes(controlRoleId)
      )
      .map(([, policy]) => policy.Properties?.PolicyDocument),
  ];
  const controlPlaneStatements = controlPlanePolicyDocuments.flatMap(
    (document) => document.Statement,
  );

  const staticRegistryGetStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("agent-registry:GetRegistryRecord")
      && statement.Condition === undefined
  );
  const staticRegistryDiscoverableStatement = roleStatements.find((statement) =>
    statementActions(statement).includes(
      "agent-registry:GetDiscoverableRegistryRecord",
    )
      && statement.Condition === undefined
  );
  const staticRegistryListStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("agent-registry:ListRegistryRecords")
      && statement.Condition === undefined
  );
  const dynamicRegistryListStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("agent-registry:ListRegistryRecords")
      && statement.Condition !== undefined
  );
  const dynamicRegistryRecordStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("agent-registry:GetRegistryRecord")
      && statement.Condition !== undefined
  );
  const platformStateStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("dynamodb:Query")
  );
  const gatewayReadStatement = roleStatements.find((statement) =>
    statementActions(statement).includes("bedrock-agentcore:GetGatewayTarget")
  );
  const gatewayAssumeStatement = controlPlaneStatements.find((statement) =>
    statementActions(statement).includes("sts:AssumeRole")
  );
  assert.ok(staticRegistryGetStatement);
  assert.ok(staticRegistryDiscoverableStatement);
  assert.ok(staticRegistryListStatement);
  assert.ok(dynamicRegistryListStatement);
  assert.ok(dynamicRegistryRecordStatement);
  assert.ok(platformStateStatement);
  assert.ok(gatewayReadStatement);
  assert.ok(gatewayAssumeStatement);

  assert.deepEqual(statementActions(platformStateStatement), [
    "dynamodb:GetItem",
    "dynamodb:Query",
  ]);
  assert.deepEqual(platformStateStatement.Resource, {
    "Fn::GetAtt": [platformStateTableId, "Arn"],
  });
  assert.deepEqual(platformStateStatement.Condition, {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["DOMAIN", "MODEL_POLICY"],
    },
  });
  assert.doesNotMatch(
    roleStatements.flatMap(statementActions).join("\n"),
    /dynamodb:(?:BatchWriteItem|DeleteItem|PutItem|Scan|TransactWriteItems|UpdateItem)/,
  );

  assert.deepEqual(statementActions(staticRegistryListStatement), [
    "agent-registry:ListRegistryRecords",
  ]);
  const registryArns = [
    importMarker("AgenticPlatform-ControlPlane-SharedRegistryArn"),
    importMarker("AgenticPlatform-ControlPlane-Registry-platform-Arn"),
    importMarker(
      "AgenticPlatform-ControlPlane-Registry-customer-support-Arn",
    ),
    importMarker("AgenticPlatform-ControlPlane-Registry-operations-Arn"),
  ];
  assert.deepEqual(
    resolveImportValues(staticRegistryListStatement.Resource),
    registryArns,
  );
  assert.deepEqual(statementActions(staticRegistryGetStatement), [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistryRecord",
  ]);
  assert.deepEqual(
    resolveImportValues(staticRegistryGetStatement.Resource),
    registryArns.map((registryArn) => `${registryArn}/record/*`),
  );
  assert.deepEqual(statementActions(staticRegistryDiscoverableStatement), [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistryRecord",
  ]);
  assert.deepEqual(
    resolveImportValues(staticRegistryDiscoverableStatement.Resource),
    registryArns.map((registryArn) => `${registryArn}/record/*`),
  );
  assert.doesNotMatch(
    roleStatements.flatMap(statementActions).join("\n"),
    /agent-registry:BatchGetDiscoverableRegistryRecord/,
  );

  const dynamicRegistryCondition = {
    StringEquals: {
      "aws:RequestedRegion": "us-west-2",
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": ["cdk", "hosted-acceptance"],
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
    },
  };
  assert.deepEqual(statementActions(dynamicRegistryListStatement), [
    "agent-registry:ListRegistryRecords",
  ]);
  assert.equal(
    normalizedArn(dynamicRegistryListStatement.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*",
  );
  assert.deepEqual(
    dynamicRegistryListStatement.Condition,
    dynamicRegistryCondition,
  );
  assert.deepEqual(statementActions(dynamicRegistryRecordStatement), [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistryRecord",
  ]);
  assert.equal(
    normalizedArn(dynamicRegistryRecordStatement.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*/record/*",
  );
  assert.deepEqual(
    dynamicRegistryRecordStatement.Condition,
    dynamicRegistryCondition,
  );
  assert.deepEqual(statementActions(gatewayReadStatement), [
    "bedrock-agentcore:GetGatewayTarget",
    "bedrock-agentcore:ListGatewayTargets",
  ]);
  assert.equal(
    resolveImportValues(gatewayReadStatement.Resource),
    importMarker("AgenticPlatform-ControlPlane-ToolsGatewayArn"),
  );
  assert.deepEqual(statementActions(gatewayAssumeStatement), [
    "sts:AssumeRole",
    "sts:SetSourceIdentity",
  ]);
  assert.deepEqual(
    gatewayAssumeStatement.Resource,
    {
      "Fn::GetAtt": [
        resourceEntries(template, "AWS::IAM::Role").find(([, role]) =>
          role.Properties?.RoleName
            === PLATFORM_WEB_RUNTIME_ROLE_NAMES.gatewayInvoker
        )?.[0],
        "Arn",
      ],
    },
  );
  assert.doesNotMatch(
    controlPlaneStatements.flatMap(statementActions).join("\n"),
    /bedrock-agentcore:InvokeGateway/,
  );
  const xrayStatement = controlPlaneStatements.find(
    (statement: Record<string, any>) =>
      statementActions(statement).includes("xray:PutTraceSegments"),
  );
  assert.ok(xrayStatement);
  assert.deepEqual(statementActions(xrayStatement), [
    "xray:PutTelemetryRecords",
    "xray:PutTraceSegments",
  ]);
  assert.equal(xrayStatement.Resource, "*");
  const accountWideRoleStatements = controlPlaneStatements.filter(
    (statement: Record<string, any>) => statement.Resource === "*",
  );
  assert.deepEqual(accountWideRoleStatements, [xrayStatement]);

  const controlPlaneActions = roleStatements.flatMap(statementActions);
  assert.doesNotMatch(
    controlPlaneActions.join("\n"),
    /agent-registry:(?:Create|Delete|Submit|Approve|Put|UpdateRegistryRecordStatus)|bedrock-agentcore:DeleteGateway/,
  );
  const roleRegistryStatements = roleStatements.filter((statement) =>
    statementActions(statement).some((action) =>
      action.startsWith("agent-registry:")
    )
  );
  assert.equal(roleRegistryStatements.length, 4);

  const [, boundary] = sharedRuntimeBoundary(template);
  const boundaryStatements =
    boundary.Properties?.PolicyDocument?.Statement ?? [];
  const boundaryRegistryGetStatements = boundaryStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes("agent-registry:GetRegistryRecord"),
  );
  assert.equal(boundaryRegistryGetStatements.length, 1);
  const [boundaryRegistryRecords] = boundaryRegistryGetStatements;
  assert.equal(boundaryRegistryRecords.Condition, undefined);
  const boundaryRegistryDiscoverableStatements = boundaryStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes(
        "agent-registry:GetDiscoverableRegistryRecord",
      ),
  );
  assert.equal(boundaryRegistryDiscoverableStatements.length, 1);
  const boundaryRegistryListStatements = boundaryStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes(
        "agent-registry:ListRegistryRecords",
      ),
  );
  assert.equal(boundaryRegistryListStatements.length, 1);
  const [boundaryRegistryList] = boundaryRegistryListStatements;
  assert.equal(boundaryRegistryList.Condition, undefined);
  const boundaryGatewayInvokeStatements = boundaryStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes(
        "bedrock-agentcore:InvokeGateway",
      ),
  );
  const boundaryGatewayAssumeStatements = boundaryStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes("sts:AssumeRole"),
  );
  assert.equal(boundaryGatewayInvokeStatements.length, 1);
  assert.ok(
    statementActions(boundaryGatewayInvokeStatements[0]).includes(
      "bedrock-agentcore:InvokeGateway",
    ),
  );
  assert.ok(
    policyResourceIncludes(
      boundaryGatewayInvokeStatements[0].Resource,
      {
        "Fn::Join": [
          "",
          [
            "arn:",
            { Ref: "AWS::Partition" },
            `:bedrock-agentcore:${LLM_GATEWAY_REGION}:111122223333:`
              + `gateway/${LLM_GATEWAY_ID}`,
          ],
        ],
      },
    ),
  );
  assert.equal(
    collectImportValues(
      boundaryGatewayInvokeStatements[0].Resource,
    ).some((exportName) => exportName.includes("LlmGateway")),
    false,
  );
  assert.equal(
    normalizedArn(
      boundaryGatewayInvokeStatements[0].Condition
        ?.ArnEquals?.["aws:PrincipalArn"],
    ),
    "arn:<AWS::Partition>:iam::111122223333:role/"
      + "AgenticPlatform-Web-GatewayInvokerRole",
  );
  assert.equal(boundaryGatewayAssumeStatements.length, 1);
  assert.ok(
    statementActions(boundaryGatewayAssumeStatements[0]).includes(
      "sts:AssumeRole",
    ),
  );
  assert.ok(
    statementActions(boundaryGatewayAssumeStatements[0]).includes(
      "sts:SetSourceIdentity",
    ),
  );
  assert.ok(
    [boundaryGatewayAssumeStatements[0].Resource].flat()
      .map(normalizedArn)
      .includes(
        "arn:<AWS::Partition>:iam::111122223333:role/"
          + "AgenticPlatform-Web-GatewayInvokerRole",
      ),
  );
  assert.equal(
    normalizedArn(boundaryRegistryList.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*",
  );
  assert.deepEqual(
    statementActions(boundaryRegistryList),
    ["agent-registry:ListRegistryRecords"],
  );
  assert.equal(
    normalizedArn(boundaryRegistryRecords.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*/record/*",
  );
  assert.deepEqual(
    statementActions(boundaryRegistryRecords),
    [
      "agent-registry:GetDiscoverableRegistryRecord",
      "agent-registry:GetRegistryRecord",
      "agent-registry:UpdateRegistryRecordStatus",
    ],
  );
  for (const roleStatement of [
    dynamicRegistryListStatement,
    dynamicRegistryRecordStatement,
    platformStateStatement,
    gatewayReadStatement,
  ]) {
    const boundaryStatement = boundaryStatements.find(
      (statement: Record<string, any>) =>
        statementActions(roleStatement).every((action) =>
          statementActions(statement).includes(action)
        )
        && policyResourceIncludes(
          statement.Resource,
          roleStatement.Resource,
        ),
    );
    assert.ok(
      boundaryStatement,
      `Missing boundary coverage for ${JSON.stringify(roleStatement)}`,
    );
  }
  for (const statement of [
    staticRegistryGetStatement,
    staticRegistryDiscoverableStatement,
  ]) {
    const boundaryStatement = statement === staticRegistryGetStatement
      ? boundaryRegistryRecords
      : boundaryRegistryList;
    assert.ok(
      statementActions(statement).every((action) =>
        statementActions(boundaryStatement).includes(action)
      ),
    );
  }
  const accountWideBoundaryStatements = boundaryStatements.filter(
    (statement: Record<string, any>) => statement.Resource === "*",
  );
  assert.equal(accountWideBoundaryStatements.length, 3);
  const accountWideActions = accountWideBoundaryStatements.map(
    (statement: Record<string, any>) => statementActions(statement),
  );
  assert.ok(
    accountWideActions.some((actions: string[]) =>
      actions.length === 1
      && actions[0] === "agent-registry:CreateRegistry"
    ),
  );
  assert.ok(
    accountWideActions.some((actions: string[]) =>
      actions.length === 1
      && actions[0] === "cloudwatch:PutMetricData"
    ),
  );
  const telemetryActions = accountWideActions.find((actions: string[]) =>
    actions.includes("xray:GetSamplingRules")
  );
  assert.ok(telemetryActions);
  assert.deepEqual([...telemetryActions].sort(), [
    // Cost Explorer has no resource-level scoping; it shares the merged
    // account-wide read statement with metrics and telemetry. The bedrock
    // actions are compacted wildcard ceilings for the workspace lambda's
    // memory/KB status reads; these do not support resource-level scoping.
    "bedrock-agentcore:*Mem*",
    "bedrock:GetKnow*",
    "ce:GetCostAndUsage",
    "cloudwatch:GetMetricData",
    "xray:GetSamplingRules",
    "xray:GetSamplingTargets",
    "xray:PutTelemetryRecords",
    "xray:PutTraceSegments",
  ]);
});

test("control-plane role scopes discoverable reads while its boundary compacts dynamic Registry access", () => {
  const { template } = fixture();
  const [controlRoleId] = namedRole(
    template,
    PLATFORM_WEB_RUNTIME_ROLE_NAMES.controlPlaneReadApi,
  );
  const roleStatements = iamStatements(template)
    .filter(({ owner }) => owner === controlRoleId)
    .map(({ statement }) => statement);
  const [, boundary] = sharedRuntimeBoundary(template);
  const boundaryStatements =
    boundary.Properties?.PolicyDocument?.Statement ?? [];

  const roleDiscoverable = roleStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes(
        "agent-registry:GetDiscoverableRegistryRecord",
      ),
  );
  assert.equal(roleDiscoverable.length, 2);
  for (const statement of roleDiscoverable) {
    const resources = Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource];
    assert.ok(
      resources.every((resource: unknown) =>
        String(resolveImportValues(resource)).endsWith("/record/*")
      ),
    );
    assert.ok(
      !statementActions(statement).includes(
        "agent-registry:ListRegistryRecords",
      ),
    );
  }

  const roleList = roleStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes(
        "agent-registry:ListRegistryRecords",
      ),
  );
  assert.equal(roleList.length, 2);
  for (const statement of roleList) {
    const resources = Array.isArray(statement.Resource)
      ? statement.Resource
      : [statement.Resource];
    assert.ok(
      resources.every((resource: unknown) =>
        !String(resolveImportValues(resource)).includes("/record/")
      ),
    );
    assert.ok(
      !statementActions(statement).includes(
        "agent-registry:GetDiscoverableRegistryRecord",
      ),
    );
  }

  const boundaryDiscoverable = boundaryStatements.filter(
    (statement: Record<string, any>) =>
      statementActions(statement).includes(
        "agent-registry:GetDiscoverableRegistryRecord",
      ),
  );
  assert.equal(boundaryDiscoverable.length, 1);
  const [compactedBoundary] = boundaryDiscoverable;
  assert.equal(compactedBoundary.Condition, undefined);
  assert.equal(
    normalizedArn(compactedBoundary.Resource),
    "arn:<AWS::Partition>:agent-registry:us-west-2:"
      + "111122223333:registry/*/record/*",
  );
  assert.ok(
    !statementActions(compactedBoundary).includes(
      "agent-registry:ListRegistryRecords",
    ),
  );
});

test("HTTP API integrations, logs, throttles, routes, JWT authorizer, and invoke permissions are scoped", () => {
  const { template } = fixture();
  const [apiId] = soleResource(template, "AWS::ApiGatewayV2::Api");
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    Name: "agentic-platform-api",
    ProtocolType: "HTTP",
    DisableExecuteApiEndpoint: false,
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
    ApiId: { Ref: apiId },
    IntegrationMethod: "POST",
    IntegrationType: "AWS_PROXY",
    PayloadFormatVersion: "2.0",
    TimeoutInMillis: 5000,
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    ApiId: { Ref: apiId },
    StageName: "$default",
    AutoDeploy: true,
    DefaultRouteSettings: {
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    },
  });

  const [, stage] = soleResource(template, "AWS::ApiGatewayV2::Stage");
  assert.deepEqual(normalizedTags(stage), EXPECTED_TAGS);
  const accessLogFormat = stage.Properties?.AccessLogSettings?.Format;
  assert.equal(typeof accessLogFormat, "string");
  assert.doesNotThrow(() => JSON.parse(accessLogFormat));
  assert.doesNotMatch(accessLogFormat, /authorization|auth|email|token/i);
  const accessLogDestination =
    stage.Properties?.AccessLogSettings?.DestinationArn;
  assert.notEqual(accessLogDestination?.["Fn::GetAtt"]?.[1], "Arn");
  assert.doesNotMatch(JSON.stringify(accessLogDestination), /:\*/);

  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /api/health",
    AuthorizationType: "NONE",
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /api/me",
    AuthorizationType: "JWT",
    AuthorizerId: Match.anyValue(),
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "GET /oauth/github/callback",
    AuthorizationType: "NONE",
  });
  for (const routeKey of [
    "GET /api/registry",
    "GET /api/ai-gateway",
    "POST /api/ai-gateway/model-policies",
    "POST /api/ai-gateway/model-access-requests",
    "POST /api/ai-gateway/model-access-decisions",
    "GET /api/domains",
    "GET /api/projects",
    "POST /api/projects",
    "GET /api/agents",
    "GET /api/deployments",
    "GET /api/approvals",
    "POST /api/agents",
    "PUT /api/agents/{id}",
    "POST /api/agents/{id}/test",
    "GET /api/delivery/{id}",
    "GET /api/delivery/github",
    "POST /api/delivery/github/authorizations",
    "POST /api/delivery/previews",
    "GET /api/journeys/{id}",
    "POST /api/journeys",
    "POST /api/journeys/{id}/contract",
    "POST /api/journeys/{id}/messages",
    "POST /api/deployments/sandbox",
    "POST /api/deployments/production",
    "POST /api/deployment-decisions",
    "POST /api/domain-create",
    "POST /api/registry-decide",
    "POST /api/governance/resources",
    "POST /api/governance/publications",
    "POST /api/governance/publication-decisions",
    "GET /api/governance/shared-resources",
    "POST /api/governance/access-requests",
    "POST /api/governance/access-decisions",
    "POST /api/governance/access-revocations",
    "GET /api/governance/agent-entitlements",
    "POST /api/governance/agent-entitlements",
    "POST /api/governance/agent-entitlement-revocations",
    "GET /api/experience/agents",
    "POST /api/experience/invocations",
    "GET /api/experience/sessions",
    "GET /api/experience/access-requests",
    "POST /api/experience/feedback",
    "POST /api/experience/issues",
    "POST /api/experience/access-requests",
    "GET /api/operations",
    "GET /api/costs",
    "GET /api/operations/audit",
    "GET /api/incidents",
    "POST /api/incidents",
    "POST /api/incidents/{id}/actions",
    "GET /api/break-glass",
    "POST /api/break-glass/requests",
    "POST /api/break-glass/decisions",
    "POST /api/break-glass/activations",
    "POST /api/break-glass/revocations",
  ]) {
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: routeKey,
      AuthorizationType: "JWT",
      AuthorizerId: Match.anyValue(),
    });
  }
  template.resourceCountIs("AWS::ApiGatewayV2::Integration", 13);

  const [, client] = soleResource(template, "AWS::Cognito::UserPoolClient");
  const [, userPool] = soleResource(template, "AWS::Cognito::UserPool");
  template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
    ApiId: { Ref: apiId },
    AuthorizerType: "JWT",
    IdentitySource: ["$request.header.Authorization"],
    JwtConfiguration: {
      Audience: [{ Ref: resourceEntries(template, "AWS::Cognito::UserPoolClient")[0][0] }],
      Issuer: {
        "Fn::Join": [
          "",
          [
            "https://cognito-idp.us-west-2.",
            { Ref: "AWS::URLSuffix" },
            "/",
            { Ref: resourceEntries(template, "AWS::Cognito::UserPool")[0][0] },
          ],
        ],
      },
    },
  });
  assert.ok(client);
  assert.ok(userPool);

  // 78 = 72 (68 base + HITL policy read + governance HITL route +
  // platform-costs + publication initiation) + 4 domain-bootstrap routes
  // (merged untested at 76) + catalog-visibility set/read.
  // +1 = GET /api/project-memories workspace route.
  const permissions = resourceEntries(template, "AWS::Lambda::Permission");
  assert.equal(permissions.length, 84);
  const apiPermissions = permissions.filter(([, permission]) =>
    permission.Properties?.Principal === "apigateway.amazonaws.com"
  );
  assert.equal(apiPermissions.length, 83);
  const routeKeys = resourceEntries(template, "AWS::ApiGatewayV2::Route")
    .map(([, route]) => route.Properties?.RouteKey)
    .filter((routeKey): routeKey is string => typeof routeKey === "string");
  assert.equal(routeKeys.length, 84);
  const permissionSourceArns = apiPermissions.map(([, permission]) =>
    JSON.stringify(permission.Properties?.SourceArn)
  );
  for (const routeKey of routeKeys) {
    const separator = routeKey.indexOf(" ");
    const method = routeKey.slice(0, separator);
    const path = routeKey.slice(separator + 1).replace(/^\//, "");
    const expectedPaths =
      routeKey === "GET /api/health" || routeKey === "GET /api/me"
        ? ["/*/GET/api/*"]
        : [
            `/*/${method}/${path}`,
            `/*/${method}/${path.replace(/\{[^/]+\}/g, "*")}`,
          ];
    assert.ok(
      permissionSourceArns.some((sourceArn) =>
        expectedPaths.some((expectedPath) =>
          sourceArn.includes(expectedPath)
        )
      ),
      `Missing API Gateway invoke permission for ${routeKey}`,
    );
  }
  for (const [, permission] of apiPermissions) {
    assert.equal(
      permission.Properties?.Principal,
      "apigateway.amazonaws.com",
    );
    const sourceArn = JSON.stringify(permission.Properties?.SourceArn);
    assert.match(sourceArn, new RegExp(apiId));
    assert.match(sourceArn, /execute-api/);
  }
  const brokerPermission = permissions.find(([, permission]) =>
    permission.Properties?.Principal?.["Fn::GetAtt"]
  );
  assert.ok(brokerPermission);
  const [hostedAcceptanceRoleId] = namedRole(
    template,
    HOSTED_ACCEPTANCE_ROLE_NAME,
  );
  assert.deepEqual(brokerPermission[1].Properties, {
    Action: "lambda:InvokeFunction",
    FunctionName: {
      "Fn::GetAtt": [
        resourceEntries(template, "AWS::Lambda::Function").find(
          ([, resource]) =>
            resource.Properties?.FunctionName
              === HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME,
        )?.[0],
        "Arn",
      ],
    },
    Principal: {
      "Fn::GetAtt": [hostedAcceptanceRoleId, "Arn"],
    },
  });
  const controlPlaneFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description ===
      "Reads scoped AWS Registry and AgentCore Gateway inventory"
  )?.[0];
  assert.ok(controlPlaneFunctionId);
  const controlPlanePermissionArns = apiPermissions
    .filter(([, permission]) =>
      permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
        === controlPlaneFunctionId
    )
    .map(([, permission]) =>
      JSON.stringify(permission.Properties?.SourceArn)
    )
    .sort();
  assert.equal(controlPlanePermissionArns.length, 1);
  assert.match(controlPlanePermissionArns[0], /GET\/api\/registry/);
  for (const sourceArn of controlPlanePermissionArns) {
    assert.doesNotMatch(sourceArn, /GET\/api\/\*/);
  }
  const modelGovernanceFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Governs model access and AgentCore Gateway rate limits"
  )?.[0];
  assert.ok(modelGovernanceFunctionId);
  const modelGovernanceIntegrationIds = resourceEntries(
    template,
    "AWS::ApiGatewayV2::Integration",
  )
    .filter(([, integration]) =>
      JSON.stringify(integration.Properties?.IntegrationUri)
        .includes(modelGovernanceFunctionId)
    )
    .map(([logicalId]) => logicalId);
  assert.equal(modelGovernanceIntegrationIds.length, 1);
  const aiGatewayCatalogRoute = resourceEntries(
    template,
    "AWS::ApiGatewayV2::Route",
  ).find(([, route]) =>
    route.Properties?.RouteKey === "GET /api/ai-gateway"
  )?.[1];
  assert.ok(aiGatewayCatalogRoute);
  assert.match(
    JSON.stringify(aiGatewayCatalogRoute.Properties?.Target),
    new RegExp(modelGovernanceIntegrationIds[0]),
  );
  const modelGovernancePermissionArns = apiPermissions
    .filter(([, permission]) =>
      permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
        === modelGovernanceFunctionId
    )
    .map(([, permission]) =>
      JSON.stringify(permission.Properties?.SourceArn)
    )
    .sort();
  assert.equal(modelGovernancePermissionArns.length, 4);
  for (const expectedPath of [
    /GET\/api\/ai-gateway/,
    /POST\/api\/ai-gateway\/model-access-decisions/,
    /POST\/api\/ai-gateway\/model-access-requests/,
    /POST\/api\/ai-gateway\/model-policies/,
  ]) {
    assert.ok(
      modelGovernancePermissionArns.some((sourceArn) =>
        expectedPath.test(sourceArn)
      ),
      `Missing model governance invoke permission for ${expectedPath}`,
    );
  }
  for (const sourceArn of modelGovernancePermissionArns) {
    assert.doesNotMatch(sourceArn, /(?:GET|POST)\/api\/\*/);
  }
  const platformAdminFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Vends durable platform domains through AWS Agent Registry"
  )?.[0];
  assert.ok(platformAdminFunctionId);
  const platformAdminPermissionArns = apiPermissions
    .filter(([, permission]) =>
      permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
        === platformAdminFunctionId
    )
    .map(([, permission]) =>
      JSON.stringify(permission.Properties?.SourceArn)
    )
    .sort();
  assert.equal(platformAdminPermissionArns.length, 4);
  assert.match(platformAdminPermissionArns[0], /GET\/api\/domains/);
  assert.match(platformAdminPermissionArns[1], /POST\/api\/domain-create/);
  assert.match(platformAdminPermissionArns[2], /POST\/api\/registry-create/);
  assert.match(platformAdminPermissionArns[3], /POST\/api\/registry-decide/);
  for (const sourceArn of platformAdminPermissionArns) {
    assert.doesNotMatch(sourceArn, /(?:GET|POST)\/api\/\*/);
  }
  const workspaceFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Reads authorized project, agent, deployment, and approval workspaces"
  )?.[0];
  assert.ok(workspaceFunctionId);
  const workspacePermissionArns = apiPermissions
    .filter(([, permission]) =>
      permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
        === workspaceFunctionId
    )
    .map(([, permission]) =>
      JSON.stringify(permission.Properties?.SourceArn)
    )
    .sort();
  assert.equal(workspacePermissionArns.length, 6);
  assert.ok(
    workspacePermissionArns.some((value) =>
      /GET\/api\/projects/.test(value)
    ),
  );
  assert.ok(
    workspacePermissionArns.some((value) =>
      /POST\/api\/projects/.test(value)
    ),
  );
  for (const sourceArn of workspacePermissionArns) {
    assert.doesNotMatch(sourceArn, /(?:GET|POST)\/api\/\*/);
  }
  const governanceFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Runs domain-scoped Agent Registry publication and access governance"
  )?.[0];
  assert.ok(governanceFunctionId);
  const governancePermissionArns = apiPermissions
    .filter(([, permission]) =>
      permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
        === governanceFunctionId
    )
    .map(([, permission]) =>
      JSON.stringify(permission.Properties?.SourceArn)
    )
    .sort();
  // 19 = 14 (11 base + GET /api/hitl + POST /api/governance/resources
  // + POST publication initiation) + 3 governance draft/alert routes merged
  // untested + catalog-visibility set/read.
  assert.equal(governancePermissionArns.length, 23);
  for (const expectedPath of [
    /GET\/api\/governance\/agent-entitlements/,
    /POST\/api\/governance\/agent-entitlements/,
    /POST\/api\/governance\/agent-entitlement-revocations/,
  ]) {
    assert.ok(
      governancePermissionArns.some((sourceArn) =>
        expectedPath.test(sourceArn)
      ),
      `Missing governance invoke permission for ${expectedPath}`,
    );
  }
  for (const sourceArn of governancePermissionArns) {
    assert.doesNotMatch(sourceArn, /(?:GET|POST)\/api\/\*/);
  }
});

test("explicit service and provider log groups retain three months of logs", () => {
  const { template } = fixture();
  const logGroups = resourceEntries(template, "AWS::Logs::LogGroup");
  assert.equal(logGroups.length, 25);
  assert.ok(
    logGroups.some(([logicalId]) =>
      logicalId.startsWith("RuntimeBoundaryTagProviderLogs")
    ),
  );
  for (const [, logGroup] of logGroups) {
    assert.equal(logGroup.Properties?.RetentionInDays, 90);
    assert.equal(logGroup.DeletionPolicy, "Retain");
    assert.equal(logGroup.UpdateReplacePolicy, "Retain");
  }
});

test("CloudFront uses OAC, exact web/runtime/API behaviors, and access logging", () => {
  const { template } = fixture();
  const [distributionId, distribution] = soleResource(
    template,
    "AWS::CloudFront::Distribution",
  );
  const config = distribution.Properties?.DistributionConfig;

  const [, originAccessControl] = soleResource(
    template,
    "AWS::CloudFront::OriginAccessControl",
  );
  const originAccessControlConfig =
    originAccessControl.Properties?.OriginAccessControlConfig;
  assert.equal(originAccessControlConfig.SigningBehavior, "always");
  assert.equal(originAccessControlConfig.SigningProtocol, "sigv4");
  assert.equal(originAccessControlConfig.OriginAccessControlOriginType, "s3");
  assert.equal(config.Enabled, true);
  assert.equal(config.DefaultRootObject, "index.html");
  assert.equal(config.HttpVersion, "http2and3");
  assert.equal(config.PriceClass, "PriceClass_200");
  assert.equal(config.ViewerCertificate, undefined);
  assert.ok(config.Logging.Bucket);
  assert.equal(config.Logging.IncludeCookies, false);
  assert.equal(config.Logging.Prefix, "cloudfront/");
  assert.equal(config.CustomErrorResponses, undefined);

  const s3Origin = config.Origins.find(
    (origin: Record<string, any>) => origin.S3OriginConfig,
  );
  assert.ok(s3Origin?.OriginAccessControlId);
  assert.deepEqual(s3Origin.S3OriginConfig, { OriginAccessIdentity: "" });

  const apiOrigin = config.Origins.find(
    (origin: Record<string, any>) => origin.CustomOriginConfig,
  );
  assert.deepEqual(apiOrigin.CustomOriginConfig, {
    OriginProtocolPolicy: "https-only",
    OriginSSLProtocols: ["TLSv1.2"],
  });
  assert.equal(apiOrigin.ConnectionAttempts, 2);
  assert.equal(apiOrigin.ConnectionTimeout, 5);
  assert.match(JSON.stringify(apiOrigin.DomainName), /execute-api/);
  assert.match(JSON.stringify(apiOrigin.DomainName), /us-west-2/);

  assert.deepEqual(
    config.DefaultCacheBehavior.AllowedMethods,
    ["GET", "HEAD", "OPTIONS"],
  );
  assert.equal(
    config.DefaultCacheBehavior.CachePolicyId,
    "658327ea-f89d-4fab-a63d-7e88639e58f6",
  );
  assert.equal(config.DefaultCacheBehavior.Compress, true);
  assert.equal(
    config.DefaultCacheBehavior.ViewerProtocolPolicy,
    "redirect-to-https",
  );

  const runtimeBehavior = config.CacheBehaviors.find(
    (behavior: Record<string, any>) => behavior.PathPattern === "runtime-config.js",
  );
  assert.deepEqual(
    runtimeBehavior.AllowedMethods,
    ["GET", "HEAD", "OPTIONS"],
  );
  assert.equal(
    runtimeBehavior.CachePolicyId,
    "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
  );
  assert.equal(runtimeBehavior.Compress, true);
  assert.equal(runtimeBehavior.ViewerProtocolPolicy, "redirect-to-https");

  const apiBehavior = config.CacheBehaviors.find(
    (behavior: Record<string, any>) => behavior.PathPattern === "api/*",
  );
  assert.deepEqual(new Set(apiBehavior.AllowedMethods), new Set([
    "DELETE",
    "GET",
    "HEAD",
    "OPTIONS",
    "PATCH",
    "POST",
    "PUT",
  ]));
  assert.equal(
    apiBehavior.CachePolicyId,
    "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
  );
  assert.equal(apiBehavior.Compress, true);
  assert.equal(
    apiBehavior.OriginRequestPolicyId,
    "b689b0a8-53d0-40ab-baf2-68738e2966ac",
  );
  assert.equal(apiBehavior.ViewerProtocolPolicy, "redirect-to-https");

  for (const behavior of [
    config.DefaultCacheBehavior,
    runtimeBehavior,
    apiBehavior,
  ]) {
    assert.ok(behavior.ResponseHeadersPolicyId);
  }
  assert.ok(distributionId);
});

test("security headers contain the exact Cognito-aware CSP and browser protections", () => {
  const { template } = fixture();
  const [domainId] = soleResource(template, "AWS::Cognito::UserPoolDomain");
  const [, policy] = soleResource(
    template,
    "AWS::CloudFront::ResponseHeadersPolicy",
  );
  const config = policy.Properties?.ResponseHeadersPolicyConfig;
  assert.equal(config.Name, "agentic-platform-security-headers");
  assert.equal(config.SecurityHeadersConfig.ContentSecurityPolicy.Override, true);
  const csp = JSON.stringify(
    config.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy,
  );
  assert.match(csp, new RegExp(domainId));
  assert.match(csp, /\.auth\.us-west-2\.amazoncognito\.com/);
  for (const directive of [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https://",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(csp, /UserPoolHostedDomain/);
  assert.deepEqual(config.SecurityHeadersConfig.ContentTypeOptions, {
    Override: true,
  });
  assert.deepEqual(config.SecurityHeadersConfig.FrameOptions, {
    FrameOption: "DENY",
    Override: true,
  });
  assert.deepEqual(config.SecurityHeadersConfig.ReferrerPolicy, {
    Override: true,
    ReferrerPolicy: "strict-origin-when-cross-origin",
  });
  assert.deepEqual(config.SecurityHeadersConfig.StrictTransportSecurity, {
    AccessControlMaxAgeSec: 31536000,
    IncludeSubdomains: true,
    Override: true,
    Preload: true,
  });
  assert.deepEqual(config.SecurityHeadersConfig.XSSProtection, {
    ModeBlock: true,
    Override: true,
    Protection: true,
  });
});

test("frontend deployment prunes and retains while a scoped provider invalidates all paths afterward", async () => {
  const { app, template } = fixture();
  const [deploymentId, deployment] = soleResource(
    template,
    "Custom::CDKBucketDeployment",
  );
  assert.equal(deployment.Properties?.Prune, true);
  assert.equal(deployment.Properties?.RetainOnDelete, true);
  assert.deepEqual(deployment.Properties?.SystemMetadata, {
    "cache-control": "no-store",
  });
  assert.equal(deployment.Properties?.DistributionPaths, undefined);
  assert.equal(deployment.Properties?.DistributionId, undefined);
  assert.equal(deployment.Properties?.SourceBucketNames?.length, 2);
  assert.equal(deployment.Properties?.SourceObjectKeys?.length, 2);
  assert.equal(deployment.Properties?.SourceMarkers?.length, 2);
  assert.deepEqual(deployment.Properties?.SourceMarkers?.[0], {});
  assert.equal(
    Object.keys(deployment.Properties?.SourceMarkers?.[1] ?? {}).length,
    5,
  );
  const generatedAssetKey = deployment.Properties?.SourceObjectKeys?.[1];
  assert.equal(typeof generatedAssetKey, "string");
  const generatedRuntimeConfig = await readFile(
    path.join(
      app.outdir,
      `asset.${generatedAssetKey.replace(/\.zip$/, "")}`,
      "runtime-config.js",
    ),
    "utf8",
  );
  assert.match(
    generatedRuntimeConfig,
    /"domain":"https:\/\/<<marker:[^>]+>>\.auth\.us-west-2\.amazoncognito\.com"/,
  );

  const source = await readFile(
    path.join(__dirname, "..", "lib", "platform-web-stack.ts"),
    "utf8",
  );
  assert.match(source, /exclude:\s*\[\s*"runtime-config\.js"\s*\]/);
  assert.match(
    source,
    /Source\.data\(\s*"runtime-config\.js",\s*runtimeConfig\s*\)/,
  );
  for (const requiredValue of [
    "window.__RUNTIME_CONFIG__",
    'authMode: "cognito"',
    'apiBaseUrl: "/api"',
    "awsRegion",
    "userPoolId",
    "clientId",
    "domain: cognitoHostedDomain",
    "redirectUri",
    "logoutUri",
    '"openid", "email", "profile"',
    "minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021",
  ]) {
    assert.match(source, new RegExp(requiredValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const runtimeConfigSource = source.slice(
    source.indexOf("const runtimeConfig"),
    source.indexOf("const deploymentLogs"),
  );
  assert.doesNotMatch(
    runtimeConfigSource,
    /clientSecret|accessToken|idToken|refreshToken|password|secret/i,
  );

  const [distributionId] = soleResource(
    template,
    "AWS::CloudFront::Distribution",
  );
  const [, invalidation] = soleResource(
    template,
    "Custom::CloudFrontInvalidation",
  );
  assert.deepEqual(invalidation.Properties?.DistributionId, {
    Ref: distributionId,
  });
  assert.deepEqual(invalidation.Properties?.Paths, ["/*"]);
  assert.ok(invalidation.Properties?.DeploymentVersion);
  const dependencies = Array.isArray(invalidation.DependsOn)
    ? invalidation.DependsOn
    : [invalidation.DependsOn];
  assert.ok(
    dependencies.includes(deploymentId),
    "invalidation must run after the BucketDeployment custom resource",
  );

  const invalidationFunctionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description ===
      "Invalidates the Stage 1 CloudFront distribution after frontend deployment"
  );
  assert.ok(invalidationFunctionEntry);
  const [invalidationFunctionId, invalidationFunction] =
    invalidationFunctionEntry;
  assert.deepEqual(invalidation.Properties?.ServiceToken, {
    "Fn::GetAtt": [invalidationFunctionId, "Arn"],
  });
  assert.equal(invalidation.Properties?.ServiceTimeout, "660");
  assert.equal(invalidationFunction.Properties?.Runtime, "nodejs24.x");
  assert.deepEqual(invalidationFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(invalidationFunction.Properties?.Timeout, 600);
  assert.equal(
    invalidationFunction.Properties?.Handler,
    "index.invalidationHandler",
  );
  assert.ok(invalidationFunction.Properties?.LoggingConfig?.LogGroup);
  const invalidationRetryConfigs = resourceEntries(
    template,
    "AWS::Lambda::EventInvokeConfig",
  ).filter(([, resource]) =>
    resource.Properties?.FunctionName?.Ref === invalidationFunctionId
  );
  assert.equal(invalidationRetryConfigs.length, 1);
  const [invalidationRetryConfigId, invalidationRetryConfig] =
    invalidationRetryConfigs[0];
  assert.equal(
    invalidationRetryConfig.Properties?.MaximumRetryAttempts,
    0,
  );
  assert.ok(
    dependencies.includes(invalidationRetryConfigId),
    "invalidation custom resource must wait for zero-retry configuration",
  );

  const roleId = invalidationFunction.Properties?.Role?.["Fn::GetAtt"]?.[0];
  assert.ok(roleId);
  const role = template.findResources("AWS::IAM::Role")[roleId];
  assert.ok(role);
  assert.equal(role.Properties?.ManagedPolicyArns, undefined);
  const roleStatements = iamStatements(template).filter(
    ({ owner }) => owner === roleId,
  );
  assert.deepEqual(
    roleStatements.flatMap(({ statement }) =>
      statementActions(statement)
    ).sort(),
    [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ],
  );
  const cloudFrontStatements = roleStatements.filter(
    ({ owner, statement }) =>
      owner === roleId
      && statementActions(statement).some((action) =>
        action.startsWith("cloudfront:")
      ),
  );
  assert.equal(cloudFrontStatements.length, 1);
  assert.deepEqual(
    statementActions(cloudFrontStatements[0].statement),
    [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ],
  );
  assert.notEqual(cloudFrontStatements[0].statement.Resource, "*");
  const invalidationPolicyResource =
    cloudFrontStatements[0].statement.Resource;
  const invalidationResource = JSON.stringify(
    invalidationPolicyResource,
  );
  assert.match(invalidationResource, /cloudfront/);
  assert.match(invalidationResource, /distribution\//);
  assert.match(invalidationResource, new RegExp(distributionId));

  const [, boundary] = sharedRuntimeBoundary(template);
  const invalidationBoundary = (
    boundary.Properties?.PolicyDocument?.Statement ?? []
  ).find((statement: Record<string, any>) =>
    statementActions(statement).includes("cloudfront:CreateInvalidation")
  );
  assert.ok(invalidationBoundary);
  assert.ok(
    policyResourceIncludes(
      invalidationBoundary.Resource,
      invalidationPolicyResource,
    ),
  );
});

test("dashboard and alarms monitor Lambda and CloudFront with exact thresholds", () => {
  const { template } = fixture();
  const controlPlaneFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description ===
      "Reads scoped AWS Registry and AgentCore Gateway inventory"
  )?.[0];
  assert.ok(controlPlaneFunctionId);
  const workspaceFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Reads authorized project, agent, deployment, and approval workspaces"
  )?.[0];
  assert.ok(workspaceFunctionId);
  const builderFunctionId = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description
      === "Creates, configures, and tests governed agent drafts"
  )?.[0];
  assert.ok(builderFunctionId);
  const [, dashboard] = soleResource(template, "AWS::CloudWatch::Dashboard");
  assert.equal(dashboard.Properties?.DashboardName, "AgenticPlatform-WebIdentity");
  const dashboardBody = JSON.stringify(dashboard.Properties?.DashboardBody);
  for (const metricName of [
    "Invocations",
    "Errors",
    "Duration",
    "Requests",
    "5xxErrorRate",
  ]) {
    assert.match(dashboardBody, new RegExp(metricName));
  }
  assert.match(dashboardBody, /Control Plane Read API/);
  assert.match(dashboardBody, new RegExp(controlPlaneFunctionId));
  assert.match(dashboardBody, /Workspace API/);
  assert.match(dashboardBody, new RegExp(workspaceFunctionId));
  assert.match(dashboardBody, /Builder API/);
  assert.match(dashboardBody, new RegExp(builderFunctionId));
  for (const metricName of [
    "Invocations",
    "Errors",
    "Duration",
    "Throttles",
  ]) {
    assert.match(
      dashboardBody,
      new RegExp(
        `${metricName}[\\s\\S]*${controlPlaneFunctionId}`
          + `|${controlPlaneFunctionId}[\\s\\S]*${metricName}`,
      ),
    );
  }

  template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    AlarmName: "AgenticPlatform-IdentityApi-Errors",
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    EvaluationPeriods: 1,
    MetricName: "Errors",
    Period: 300,
    Threshold: 1,
    TreatMissingData: "notBreaching",
  });
  const controlPlaneAlarm = resourceEntries(
    template,
    "AWS::CloudWatch::Alarm",
  ).find(([, alarm]) =>
    alarm.Properties?.AlarmName
      === "AgenticPlatform-ControlPlaneReadApi-Errors"
  )?.[1];
  assert.ok(controlPlaneAlarm);
  assert.deepEqual(normalizedTags(controlPlaneAlarm), EXPECTED_TAGS);
  assert.equal(
    controlPlaneAlarm.Properties?.ComparisonOperator,
    "GreaterThanOrEqualToThreshold",
  );
  assert.equal(controlPlaneAlarm.Properties?.EvaluationPeriods, 1);
  assert.equal(controlPlaneAlarm.Properties?.MetricName, "Errors");
  assert.equal(controlPlaneAlarm.Properties?.Period, 300);
  assert.equal(controlPlaneAlarm.Properties?.Threshold, 1);
  assert.equal(controlPlaneAlarm.Properties?.TreatMissingData, "notBreaching");
  assert.deepEqual(
    controlPlaneAlarm.Properties?.Dimensions,
    [{
      Name: "FunctionName",
      Value: { Ref: controlPlaneFunctionId },
    }],
  );
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    AlarmName: "AgenticPlatform-WorkspaceApi-Errors",
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    Dimensions: [{
      Name: "FunctionName",
      Value: { Ref: workspaceFunctionId },
    }],
    EvaluationPeriods: 1,
    MetricName: "Errors",
    Period: 300,
    Threshold: 1,
    TreatMissingData: "notBreaching",
  });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", {
    AlarmName: "AgenticPlatform-BuilderApi-Errors",
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    Dimensions: [{
      Name: "FunctionName",
      Value: { Ref: builderFunctionId },
    }],
    EvaluationPeriods: 1,
    MetricName: "Errors",
    Period: 300,
    Threshold: 1,
    TreatMissingData: "notBreaching",
  });

  const [distributionId] = soleResource(
    template,
    "AWS::CloudFront::Distribution",
  );
  const [, cloudFrontAlarm] = soleResource(
    template,
    "Custom::CloudFrontAlarm",
  );
  const alarmName = JSON.stringify(cloudFrontAlarm.Properties?.AlarmName);
  assert.match(alarmName, /PlatformWeb/);
  assert.match(alarmName, /AgenticPlatform-Web/);
  assert.match(alarmName, new RegExp(distributionId));
  assert.match(alarmName, /CloudFront/);
  assert.match(alarmName, /5xx/);
  assert.doesNotMatch(alarmName, /^"AgenticPlatform-CloudFront-5xx"$/);
  assert.deepEqual(cloudFrontAlarm.Properties?.DistributionId, {
    Ref: distributionId,
  });
  assert.deepEqual(
    Object.fromEntries(
      cloudFrontAlarm.Properties?.OwnershipTags.map(
        (tag: { Key: string; Value: string }) => [tag.Key, tag.Value],
      ),
    ),
    {
      managedBy: "cdk",
      project: "agentic-ai-platform-demo",
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      cloudFrontAlarm.Properties?.RequiredTags.map(
        (tag: { Key: string; Value: string }) => [tag.Key, tag.Value],
      ),
    ),
    EXPECTED_TAGS,
  );
  const alarmArn = JSON.stringify(cloudFrontAlarm.Properties?.AlarmArn);
  assert.match(alarmArn, /cloudwatch/);
  assert.match(alarmArn, /us-east-1/);
  assert.match(alarmArn, /PlatformWeb/);
  assert.match(alarmArn, /AgenticPlatform-Web/);
  assert.match(alarmArn, new RegExp(distributionId));
  assert.doesNotMatch(alarmArn, /alarm:AgenticPlatform-CloudFront-5xx/);

  const alarmFunctionEntry = resourceEntries(
    template,
    "AWS::Lambda::Function",
  ).find(([, resource]) =>
    resource.Properties?.Description ===
      "Reconciles the global CloudFront 5xx alarm and mandatory tags"
  );
  assert.ok(alarmFunctionEntry);
  const [alarmFunctionId, alarmFunction] = alarmFunctionEntry;
  assert.deepEqual(cloudFrontAlarm.Properties?.ServiceToken, {
    "Fn::GetAtt": [alarmFunctionId, "Arn"],
  });
  assert.equal(alarmFunction.Properties?.Runtime, "nodejs24.x");
  assert.deepEqual(alarmFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(alarmFunction.Properties?.Handler, "index.alarmHandler");
  assert.ok(alarmFunction.Properties?.LoggingConfig?.LogGroup);
  const alarmRetryConfigs = resourceEntries(
    template,
    "AWS::Lambda::EventInvokeConfig",
  ).filter(([, resource]) =>
    resource.Properties?.FunctionName?.Ref === alarmFunctionId
  );
  assert.equal(alarmRetryConfigs.length, 1);
  const [alarmRetryConfigId, alarmRetryConfig] = alarmRetryConfigs[0];
  assert.equal(
    alarmRetryConfig.Properties?.MaximumRetryAttempts,
    0,
  );
  const alarmDependencies = Array.isArray(cloudFrontAlarm.DependsOn)
    ? cloudFrontAlarm.DependsOn
    : [cloudFrontAlarm.DependsOn];
  assert.ok(
    alarmDependencies.includes(alarmRetryConfigId),
    "alarm custom resource must wait for zero-retry configuration",
  );

  const roleId = alarmFunction.Properties?.Role?.["Fn::GetAtt"]?.[0];
  assert.ok(roleId);
  const alarmRole = template.findResources("AWS::IAM::Role")[roleId];
  assert.ok(alarmRole);
  assert.equal(alarmRole.Properties?.ManagedPolicyArns, undefined);
  const roleStatements = iamStatements(template).filter(
    ({ owner }) => owner === roleId,
  );
  assert.deepEqual(
    roleStatements.flatMap(({ statement }) =>
      statementActions(statement)
    ).sort(),
    [
      "cloudwatch:DeleteAlarms",
      "cloudwatch:ListTagsForResource",
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:TagResource",
      "cloudwatch:UntagResource",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ],
  );
  const cloudWatchStatements = roleStatements.filter(
    ({ owner, statement }) =>
      owner === roleId
      && statementActions(statement).some((action) =>
        action.startsWith("cloudwatch:")
      ),
  );
  assert.equal(cloudWatchStatements.length, 1);
  assert.deepEqual(statementActions(cloudWatchStatements[0].statement), [
    "cloudwatch:DeleteAlarms",
    "cloudwatch:ListTagsForResource",
    "cloudwatch:PutMetricAlarm",
    "cloudwatch:TagResource",
    "cloudwatch:UntagResource",
  ]);
  assert.notEqual(cloudWatchStatements[0].statement.Resource, "*");
  const alarmPolicyResource = normalizeBoundaryPolicy(
    cloudWatchStatements[0].statement.Resource,
  );
  const expectedAlarmPolicyResource =
    "arn:<AWS::Partition>:cloudwatch:us-east-1:111122223333:"
    + "alarm:PlatformWeb-AgenticPlatform-Web-*-CloudFront-5xx";
  assert.equal(alarmPolicyResource, expectedAlarmPolicyResource);
  assert.notEqual(alarmPolicyResource, "*");
  assert.doesNotMatch(alarmPolicyResource, /alarm:\*$/);

  const concreteAlarmPattern = expectedAlarmPolicyResource.replace(
    "<AWS::Partition>",
    "aws",
  );
  for (const distribution of ["EOLD123", "ENEW456"]) {
    assert.equal(
      resourcePatternMatches(
        concreteAlarmPattern,
        `arn:aws:cloudwatch:us-east-1:111122223333:`
          + `alarm:PlatformWeb-AgenticPlatform-Web-${distribution}`
          + "-CloudFront-5xx",
      ),
      true,
      `${distribution} must be authorized during replacement`,
    );
  }
  for (const unrelatedResource of [
    "arn:aws:cloudwatch:us-east-1:111122223333:"
      + "alarm:PlatformWeb-OtherStack-EOLD123-CloudFront-5xx",
    "arn:aws:cloudwatch:us-east-1:111122223333:"
      + "alarm:PlatformWeb-AgenticPlatform-Web-EOLD123-CloudFront-4xx",
    "arn:aws:cloudwatch:us-east-1:111122223333:"
      + "alarm:Unrelated-AgenticPlatform-Web-EOLD123-CloudFront-5xx",
  ]) {
    assert.equal(
      resourcePatternMatches(concreteAlarmPattern, unrelatedResource),
      false,
      `${unrelatedResource} must remain unauthorized`,
    );
  }

  const [, boundary] = sharedRuntimeBoundary(template);
  const alarmBoundary = (
    boundary.Properties?.PolicyDocument?.Statement ?? []
  ).find((statement: Record<string, any>) =>
    statementActions(statement).includes("cloudwatch:PutMetricAlarm")
  );
  assert.ok(alarmBoundary);
  assert.ok(
    policyResourceIncludes(
      alarmBoundary.Resource,
      expectedAlarmPolicyResource,
    ),
  );
});

test("dedicated custom providers cannot accumulate unrelated wildcard permissions", () => {
  const { template } = fixture();
  const exactWildcardStatements = iamStatements(template).filter(
    ({ statement }) => statement.Resource === "*",
  );

  assert.equal(
    exactWildcardStatements.length,
    18,
    JSON.stringify(exactWildcardStatements, null, 2),
  );
  const registryCreates = exactWildcardStatements.filter(({ statement }) =>
    statementActions(statement).includes("agent-registry:CreateRegistry")
  );
  assert.equal(registryCreates.length, 2);
  for (const managedBy of ["cdk", "hosted-acceptance"]) {
    const registryCreate = registryCreates.find(({ statement }) =>
      statement.Condition?.StringEquals?.["aws:RequestTag/managedBy"]
        === managedBy
    );
    assert.ok(registryCreate);
    assert.deepEqual(statementActions(registryCreate.statement), [
      "agent-registry:CreateRegistry",
    ]);
    assert.deepEqual(registryCreate.statement.Condition, {
      "ForAllValues:StringEquals": {
        "aws:TagKeys": ["auto-delete", "managedBy", "project"],
      },
      StringEquals: {
        "aws:RequestTag/auto-delete": "no",
        "aws:RequestTag/managedBy": managedBy,
        "aws:RequestTag/project": "agentic-ai-platform-demo",
        "aws:RequestedRegion": "us-west-2",
      },
    });
  }
  const xrayWildcards = exactWildcardStatements.filter(({ statement }) =>
    statementActions(statement).includes("xray:PutTraceSegments")
  );
  assert.equal(xrayWildcards.length, 12);
  for (const { statement } of xrayWildcards) {
    const actions = statementActions(statement);
    if (actions.includes("xray:GetSamplingRules")) {
      assert.deepEqual(actions, [
        "xray:GetSamplingRules",
        "xray:GetSamplingTargets",
        "xray:PutTelemetryRecords",
        "xray:PutTraceSegments",
      ]);
      continue;
    }
    assert.deepEqual(statementActions(statement), [
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]);
  }
  const metricWildcards = exactWildcardStatements.filter(({ statement }) =>
    statementActions(statement).includes("cloudwatch:PutMetricData")
  );
  assert.equal(metricWildcards.length, 1);
  assert.deepEqual(metricWildcards[0].statement.Condition, {
    StringEquals: {
      "cloudwatch:namespace": "bedrock-agentcore",
    },
  });
  const metricReadWildcards = exactWildcardStatements.filter(
    ({ statement }) =>
      statementActions(statement).includes("cloudwatch:GetMetricData"),
  );
  assert.equal(metricReadWildcards.length, 1);
  assert.equal(metricReadWildcards[0].statement.Condition, undefined);

  const bedrockMemoryWildcards = exactWildcardStatements.filter(
    ({ statement }) =>
      statementActions(statement).some((a: string) =>
        a.includes("bedrock-agentcore:") && a.includes("Mem"),
      ),
  );
  assert.equal(bedrockMemoryWildcards.length, 1);

  const bedrockKbWildcards = exactWildcardStatements.filter(
    ({ statement }) =>
      statementActions(statement).some((a: string) =>
        a.startsWith("bedrock:GetKnow"),
      ),
  );
  assert.equal(bedrockKbWildcards.length, 1);

  const cloudFrontWildcardStatements = iamStatements(template).filter(
    ({ statement }) =>
      statement.Resource === "*"
      && statementActions(statement).some((action) =>
        action.startsWith("cloudfront:")
      ),
  );
  assert.deepEqual(cloudFrontWildcardStatements, []);
});

test("dashboard reads global CloudFront metrics from us-east-1", () => {
  const { template } = fixture();
  const [, dashboard] = soleResource(template, "AWS::CloudWatch::Dashboard");
  const dashboardBody = JSON.stringify(dashboard.Properties?.DashboardBody);

  assert.match(dashboardBody, /CloudFront.*region.*us-east-1/);
  assert.match(dashboardBody, /Requests.*Region.*Global/);
  assert.match(dashboardBody, /5xxErrorRate.*Region.*Global/);
});

test("every expected taggable resource has exactly the mandatory tags", () => {
  const { template } = fixture();
  for (const type of [
    "AWS::DynamoDB::Table",
    "AWS::S3::Bucket",
    "AWS::CloudFront::Distribution",
    "AWS::Cognito::UserPool",
    "AWS::Lambda::Function",
    "AWS::IAM::Role",
    "AWS::ApiGatewayV2::Api",
    "AWS::ApiGatewayV2::Stage",
    "AWS::Logs::LogGroup",
    "AWS::CloudWatch::Alarm",
    "AWS::CloudWatch::Dashboard",
  ]) {
    const resources = resourceEntries(template, type);
    assert.ok(resources.length > 0, `expected at least one ${type}`);
    for (const [logicalId, resource] of resources) {
      const tags = normalizedTags(resource);
      assert.deepEqual(
        tags,
        EXPECTED_TAGS,
        `${type} ${logicalId} exact tags`,
      );
    }
  }
});

test("stack exposes the required deployment outputs", () => {
  const { template } = fixture();
  const outputs = template.findOutputs("*");
  assert.deepEqual(Object.keys(outputs).sort(), [
    "ApplicationUrl",
    "CognitoDomain",
    "ControlPlaneReadApiFunctionName",
    "ControlPlaneReadApiRoleArn",
    "DistributionId",
    "HostedAcceptanceBrokerFunctionArn",
    "HttpApiId",
    "HttpApiUrl",
    "JwtAuthorizerId",
    "PlatformAdminApiFunctionName",
    "PlatformStateTableName",
    "StarterBuilderModelId",
    "UserPoolClientId",
    "UserPoolId",
  ]);
  assert.match(JSON.stringify(outputs.ApplicationUrl.Value), /https:\/\//);
  assert.match(
    JSON.stringify(outputs.HostedAcceptanceBrokerFunctionArn.Value),
    /HostedAcceptanceBroker/,
  );
  assert.match(JSON.stringify(outputs.HttpApiUrl.Value), /ApiEndpoint/);
  assert.equal(
    outputs.StarterBuilderModelId.Value,
    "bedrock-mantle/anthropic.claude-haiku-4-5",
  );
});

test("AwsSolutions checks have zero unexplained findings", () => {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, "NagWeb", {
    env: { account: "111122223333", region: "us-west-2" },
    cognitoDomainPrefix: "agentic-platform-nag-test",
    llmGatewayId: LLM_GATEWAY_ID,
    llmGatewayRegion: LLM_GATEWAY_REGION,
    starterBuilderModelId:
      "bedrock-mantle/anthropic.claude-haiku-4-5",
  });
  assert.doesNotThrow(() => app.synth());
  const report = new AwsSolutionsChecks(undefined, {
    verbose: true,
  }).validateScope(stack);
  assert.equal(report.success, true, JSON.stringify(report.violations, null, 2));
  assert.deepEqual(report.violations, []);
});
