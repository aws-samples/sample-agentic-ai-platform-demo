import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
} from "../lib/config";
import { PlatformWebStack } from "../lib/platform-web-stack";

type Resource = {
  Properties?: Record<string, any>;
};

function fixture() {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, "BuilderInfrastructureTest", {
    env: { account: "111122223333", region: "us-west-2" },
    cognitoDomainPrefix: "agentic-platform-builder-test",
    llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
    llmGatewayRegion: "us-east-1",
    starterBuilderModelId:
      "bedrock-mantle/anthropic.claude-haiku-4-5",
  });
  return Template.fromStack(stack);
}

function resources(
  template: Template,
  type: string,
): Array<[string, Resource]> {
  return Object.entries(template.findResources(type)) as
    Array<[string, Resource]>;
}

function statementsForRole(
  template: Template,
  roleId: string,
): Record<string, any>[] {
  const role = template.findResources("AWS::IAM::Role")[roleId];
  return [
    ...(role?.Properties?.Policies ?? []).flatMap(
      (policy: Record<string, any>) =>
        policy.PolicyDocument.Statement,
    ),
    ...resources(template, "AWS::IAM::Policy")
      .filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles).includes(roleId)
      )
      .flatMap(([, policy]) =>
        policy.Properties?.PolicyDocument.Statement
      ),
  ];
}

function actions(statement: Record<string, any>): string[] {
  return (Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action]).sort();
}

test("builder API is deployed with exact state, Gateway invoker, and identity permissions", () => {
  const template = fixture();
  const roleNames =
    PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>;
  const roleName = roleNames.builderApi;
  assert.equal(
    roleName,
    "AgenticPlatform-Web-BuilderApiRole",
  );
  assert.equal(
    roleNames.gatewayInvoker,
    "AgenticPlatform-Web-GatewayInvokerRole",
  );
  const [roleId, role] = resources(template, "AWS::IAM::Role")
    .find(([, candidate]) =>
      candidate.Properties?.RoleName === roleName
  ) ?? [];
  const [gatewayInvokerRoleId] = resources(template, "AWS::IAM::Role")
    .find(([, candidate]) =>
      candidate.Properties?.RoleName === roleNames.gatewayInvoker
  ) ?? [];
  assert.ok(roleId);
  assert.ok(role);
  assert.ok(gatewayInvokerRoleId);
  assert.ok(role.Properties?.PermissionsBoundary);

  const [tableId] = resources(template, "AWS::DynamoDB::Table")[0];
  const [userPoolId] = resources(template, "AWS::Cognito::UserPool")[0];
  const [functionId, builderFunction] = resources(
    template,
    "AWS::Lambda::Function",
  ).find(([, candidate]) =>
    candidate.Properties?.Description
      === "Creates, configures, and tests governed agent drafts"
  ) ?? [];
  assert.ok(functionId);
  assert.ok(builderFunction);
  assert.equal(builderFunction.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(builderFunction.Properties?.Architectures, ["arm64"]);
  assert.equal(builderFunction.Properties?.Timeout, 30);
  assert.equal(builderFunction.Properties?.MemorySize, 512);
  assert.equal(builderFunction.Properties?.ReservedConcurrentExecutions, undefined);
  assert.deepEqual(builderFunction.Properties?.TracingConfig, {
    Mode: "Active",
  });
  assert.deepEqual(builderFunction.Properties?.Role, {
    "Fn::GetAtt": [roleId, "Arn"],
  });
  const {
    CONTROL_PLANE_CONFIG,
    ...builderVariables
  } = builderFunction.Properties?.Environment?.Variables;
  assert.ok(CONTROL_PLANE_CONFIG);
  assert.deepEqual(
    builderVariables,
    {
      COGNITO_USER_POOL_ID: { Ref: userPoolId },
      GATEWAY_INVOKER_ROLE_ARN: {
        "Fn::GetAtt": [gatewayInvokerRoleId, "Arn"],
      },
      LLM_GATEWAY_URL:
        "https://agentic-demo-llm-gateway-abcdefghij.gateway."
        + "bedrock-agentcore.us-east-1.amazonaws.com/inference/v1",
      LLM_GATEWAY_REGION: "us-east-1",
      PLATFORM_STATE_TABLE_NAME: { Ref: tableId },
    },
  );

  const statements = statementsForRole(template, roleId);
  const stateRead = statements.find((statement) =>
    JSON.stringify(actions(statement))
      === JSON.stringify(["dynamodb:GetItem"])
  );
  assert.deepEqual(stateRead, {
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
    Resource: {
      "Fn::GetAtt": [tableId, "Arn"],
    },
  });
  const domainDirectoryRead = statements.find((statement) =>
    JSON.stringify(actions(statement))
      === JSON.stringify(["dynamodb:Query"])
  );
  assert.deepEqual(domainDirectoryRead, {
    Action: "dynamodb:Query",
    Condition: {
      "ForAllValues:StringEquals": {
        "dynamodb:LeadingKeys": ["DOMAIN"],
      },
    },
    Effect: "Allow",
    Resource: {
      "Fn::GetAtt": [tableId, "Arn"],
    },
  });
  const directStateWrite = statements.find((statement) =>
    JSON.stringify(actions(statement))
      === JSON.stringify(["dynamodb:PutItem"])
    && statement.Condition?.["ForAnyValue:StringEquals"] === undefined
  );
  assert.deepEqual(directStateWrite, {
    Action: "dynamodb:PutItem",
    Condition: {
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": ["MUTATION#*"],
      },
    },
    Effect: "Allow",
    Resource: {
      "Fn::GetAtt": [tableId, "Arn"],
    },
  });
  const transactionStateWrite = statements.find((statement) =>
    statement.Condition?.["ForAnyValue:StringEquals"]
      ?.["dynamodb:EnclosingOperation"]?.includes("TransactWriteItems")
  );
  assert.deepEqual(transactionStateWrite, {
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
    Resource: {
      "Fn::GetAtt": [tableId, "Arn"],
    },
  });
  const gateway = statements.find((statement) =>
    actions(statement).includes("sts:AssumeRole")
  );
  assert.deepEqual(gateway, {
    Action: [
      "sts:AssumeRole",
      "sts:SetSourceIdentity",
    ],
    Effect: "Allow",
    Resource: {
      "Fn::GetAtt": [gatewayInvokerRoleId, "Arn"],
    },
  });
  assert.equal(
    statements.some((statement) =>
      actions(statement).includes("bedrock-agentcore:InvokeGateway")
    ),
    false,
  );
  const cognito = statements.find((statement) =>
    actions(statement).includes("cognito-idp:AdminGetUser")
  );
  assert.deepEqual(actions(cognito!), [
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
  ]);
  assert.deepEqual(cognito?.Resource, {
    "Fn::GetAtt": [userPoolId, "Arn"],
  });
  const dynamicRegistryReads = statements.filter((statement) =>
    statement.Condition?.StringEquals?.["aws:ResourceTag/managedBy"]
  );
  assert.equal(dynamicRegistryReads.length, 2);
  assert.deepEqual(
    dynamicRegistryReads.map((statement) => actions(statement)).sort(),
    [
      ["agent-registry:ListRegistryRecords"],
      [
        "agent-registry:GetDiscoverableRegistryRecord",
        "agent-registry:GetRegistryRecord",
      ],
    ].sort(),
  );
  for (const statement of dynamicRegistryReads) {
    assert.deepEqual(
      statement.Condition.StringEquals["aws:ResourceTag/managedBy"],
      ["cdk", "hosted-acceptance"],
    );
  }
  assert.doesNotMatch(
    statements.flatMap(actions).join("\n"),
    /dynamodb:(?:BatchWriteItem|DeleteItem|Scan|TransactWriteItems|UpdateItem)/,
  );
});

test("builder mutation routes target only the builder Lambda and are monitored", () => {
  const template = fixture();
  const [functionId] = resources(
    template,
    "AWS::Lambda::Function",
  ).find(([, candidate]) =>
    candidate.Properties?.Description
      === "Creates, configures, and tests governed agent drafts"
  ) ?? [];
  assert.ok(functionId);

  const integrationIds = new Set(
    resources(template, "AWS::ApiGatewayV2::Integration")
      .filter(([, integration]) =>
        JSON.stringify(integration.Properties?.IntegrationUri)
          .includes(functionId)
      )
      .map(([id]) => id),
  );
  assert.equal(integrationIds.size, 1);
  for (const routeKey of [
    "POST /api/agents",
    "PUT /api/agents/{id}",
    "POST /api/agents/{id}/test",
  ]) {
    const route = resources(template, "AWS::ApiGatewayV2::Route")
      .find(([, candidate]) =>
        candidate.Properties?.RouteKey === routeKey
      )?.[1];
    assert.ok(route, routeKey);
    assert.equal(route.Properties?.AuthorizationType, "JWT");
    assert.ok(
      [...integrationIds].some((integrationId) =>
        JSON.stringify(route.Properties?.Target).includes(integrationId)
      ),
      routeKey,
    );
  }

  const permissionArns = resources(template, "AWS::Lambda::Permission")
    .filter(([, permission]) =>
      permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
        === functionId
    )
    .map(([, permission]) =>
      JSON.stringify(permission.Properties?.SourceArn)
    );
  assert.equal(permissionArns.length, 3);
  assert.ok(permissionArns.some((value) =>
    value.includes("POST/api/agents")));
  assert.ok(permissionArns.some((value) =>
    value.includes("PUT/api/agents/{id}")));
  assert.ok(permissionArns.some((value) =>
    value.includes("POST/api/agents/{id}/test")));
  assert.ok(permissionArns.every((value) =>
    !value.includes("/api/*")));

  const alarm = resources(template, "AWS::CloudWatch::Alarm")
    .find(([, candidate]) =>
      candidate.Properties?.AlarmName
        === "AgenticPlatform-BuilderApi-Errors"
    )?.[1];
  assert.ok(alarm);
  assert.deepEqual(alarm.Properties?.Dimensions, [{
    Name: "FunctionName",
    Value: { Ref: functionId },
  }]);
  const dashboard = resources(
    template,
    "AWS::CloudWatch::Dashboard",
  )[0][1];
  assert.match(
    JSON.stringify(dashboard.Properties?.DashboardBody),
    /Builder API/,
  );
});
