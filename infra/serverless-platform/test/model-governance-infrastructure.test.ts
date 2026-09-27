import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
} from "../lib/config";
import { PlatformWebStack } from "../lib/platform-web-stack";
import { readFileSync } from "node:fs";

const STARTER_BUILDER_MODEL_ID =
  "bedrock-mantle/anthropic.claude-haiku-4-5";

type Resource = {
  Properties?: Record<string, any>;
  DependsOn?: string | string[];
};

function fixture() {
  const app = new cdk.App();
  const stack = new PlatformWebStack(
    app,
    "ModelGovernanceInfrastructureTest",
    {
      env: { account: "111122223333", region: "us-west-2" },
      cognitoDomainPrefix: "agentic-platform-model-governance-test",
      llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
      llmGatewayRegion: "us-east-1",
      starterBuilderModelId: STARTER_BUILDER_MODEL_ID,
    },
  );
  return Template.fromStack(stack);
}

function resources(
  template: Template,
  type: string,
): Array<[string, Resource]> {
  return Object.entries(template.findResources(type)) as
    Array<[string, Resource]>;
}

function roleByName(template: Template, roleName: string) {
  return resources(template, "AWS::IAM::Role")
    .find(([, role]) => role.Properties?.RoleName === roleName);
}

function statementsForRole(
  template: Template,
  roleId: string,
): Record<string, any>[] {
  return [
    ...(template.findResources("AWS::IAM::Role")[roleId]
      ?.Properties?.Policies ?? []).flatMap(
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

function actionList(statement: Record<string, any>): string[] {
  return (
    Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action]
  ).sort();
}

function roleReference(roleId: string) {
  return { "Fn::GetAtt": [roleId, "Arn"] };
}

test("Gateway invocation is isolated behind a domain-attributed role", () => {
  const template = fixture();
  const names = PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>;
  assert.equal(
    names.gatewayInvoker,
    "AgenticPlatform-Web-GatewayInvokerRole",
  );

  const [controlPlaneRoleId] =
    roleByName(template, names.controlPlaneReadApi) ?? [];
  const [workspaceRoleId] = roleByName(template, names.workspaceApi) ?? [];
  const [builderRoleId] = roleByName(template, names.builderApi) ?? [];
  const [journeyRoleId] = roleByName(template, names.journeyApi) ?? [];
  const [runtimeRoleId] = roleByName(template, names.agentRuntime) ?? [];
  const [modelGovernanceRoleId] =
    roleByName(template, names.modelGovernanceApi) ?? [];
  const [invokerRoleId, invokerRole] =
    roleByName(template, names.gatewayInvoker) ?? [];
  assert.ok(controlPlaneRoleId);
  assert.ok(builderRoleId);
  assert.ok(workspaceRoleId);
  assert.ok(journeyRoleId);
  assert.ok(runtimeRoleId);
  assert.ok(modelGovernanceRoleId);
  assert.ok(invokerRoleId);
  assert.ok(invokerRole);
  assert.ok(invokerRole.Properties?.PermissionsBoundary);

  const trust = invokerRole.Properties?.AssumeRolePolicyDocument?.Statement;
  assert.ok(Array.isArray(trust));
  assert.equal(trust.length, 6);
  const domainCallerRoles = new Set([
    names.workspaceApi,
    names.builderApi,
    names.journeyApi,
    names.agentRuntime,
  ]);
  for (const statement of trust) {
    assert.equal(statement.Effect, "Allow");
    assert.deepEqual(actionList(statement), [
      "sts:AssumeRole",
      "sts:SetSourceIdentity",
    ]);
    assert.match(
      JSON.stringify(statement.Principal?.AWS),
      /:iam::111122223333:root/,
    );
    const principalArn = JSON.stringify(
      statement.Condition?.ArnEquals?.["aws:PrincipalArn"],
    );
    const roleName = [
      names.controlPlaneReadApi,
      names.workspaceApi,
      names.builderApi,
      names.journeyApi,
      names.agentRuntime,
      names.modelGovernanceApi,
    ].find((candidate) => principalArn.includes(candidate));
    assert.ok(roleName);
    assert.deepEqual(
      statement.Condition,
      domainCallerRoles.has(roleName)
        ? {
            ArnEquals: {
              "aws:PrincipalArn":
                statement.Condition.ArnEquals["aws:PrincipalArn"],
            },
            StringLike: {
              "sts:SourceIdentity": "domain_*",
            },
          }
        : {
            ArnEquals: {
              "aws:PrincipalArn":
                statement.Condition.ArnEquals["aws:PrincipalArn"],
            },
            StringEquals: {
              "sts:SourceIdentity": "platform",
            },
          },
    );
  }
  const trustedRoleArns = trust.map((statement) =>
    JSON.stringify(
      statement.Condition?.ArnEquals?.["aws:PrincipalArn"],
    ));
  for (const roleName of [
    names.controlPlaneReadApi,
    names.workspaceApi,
    names.builderApi,
    names.journeyApi,
    names.agentRuntime,
    names.modelGovernanceApi,
  ]) {
    assert.equal(
      trustedRoleArns.filter((roleArn) =>
        roleArn.includes(`role/${roleName}`)).length,
      1,
      roleName,
    );
  }
  assert.doesNotMatch(trustedRoleArns.join("\n"), /role\/\*/);

  const roleStatements = new Map(
    resources(template, "AWS::IAM::Role").map(([roleId]) => [
      roleId,
      statementsForRole(template, roleId),
    ]),
  );
  const gatewayInvokeOwners = [...roleStatements.entries()]
    .filter(([, statements]) =>
      statements.some((statement) =>
        actionList(statement).includes(
          "bedrock-agentcore:InvokeGateway",
        )
      )
    )
    .map(([roleId]) => roleId);
  assert.deepEqual(gatewayInvokeOwners, [invokerRoleId]);

  for (const roleId of [
    controlPlaneRoleId,
    workspaceRoleId,
    builderRoleId,
    journeyRoleId,
    runtimeRoleId,
    modelGovernanceRoleId,
  ]) {
    const assume = roleStatements.get(roleId)?.find((statement) =>
      actionList(statement).includes("sts:AssumeRole")
    );
    assert.deepEqual(assume, {
      Action: [
        "sts:AssumeRole",
        "sts:SetSourceIdentity",
      ],
      Effect: "Allow",
      Resource: roleReference(invokerRoleId),
    });
  }

  const invoke = roleStatements.get(invokerRoleId)?.find((statement) =>
    actionList(statement).includes("bedrock-agentcore:InvokeGateway")
  );
  assert.deepEqual(invoke, {
    Action: "bedrock-agentcore:InvokeGateway",
    Effect: "Allow",
    Resource: {
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          ":bedrock-agentcore:us-east-1:111122223333:"
            + "gateway/agentic-demo-llm-gateway-abcdefghij",
        ],
      ],
    },
  });

  const controlPlaneFunction = resources(
    template,
    "AWS::Lambda::Function",
  ).find(([, candidate]) =>
    candidate.Properties?.Description
      === "Reads scoped AWS Registry and AgentCore Gateway inventory"
  )?.[1];
  assert.ok(controlPlaneFunction);
  assert.deepEqual(
    controlPlaneFunction.Properties?.Environment?.Variables
      ?.GATEWAY_INVOKER_ROLE_ARN,
    roleReference(invokerRoleId),
  );
});

test("model governance API has exact AWS state and native Gateway routes", () => {
  const template = fixture();
  const names = PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>;
  assert.equal(
    names.modelGovernanceApi,
    "AgenticPlatform-Web-ModelGovernanceApiRole",
  );
  const [roleId, role] =
    roleByName(template, names.modelGovernanceApi) ?? [];
  assert.ok(roleId);
  assert.ok(role);
  assert.ok(role.Properties?.PermissionsBoundary);

  const [tableId] = resources(template, "AWS::DynamoDB::Table")[0];
  const [userPoolId] = resources(template, "AWS::Cognito::UserPool")[0];
  const [functionId, functionResource] = resources(
    template,
    "AWS::Lambda::Function",
  ).find(([, candidate]) =>
    candidate.Properties?.Description
      === "Governs model access and AgentCore Gateway rate limits"
  ) ?? [];
  assert.ok(functionId);
  assert.ok(functionResource);
  assert.equal(functionResource.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(functionResource.Properties?.Architectures, ["arm64"]);
  assert.equal(functionResource.Properties?.Timeout, 30);
  assert.equal(functionResource.Properties?.MemorySize, 512);
  assert.deepEqual(functionResource.Properties?.Role, roleReference(roleId));
  const environment =
    functionResource.Properties?.Environment?.Variables;
  assert.deepEqual(Object.keys(environment).sort(), [
    "COGNITO_USER_POOL_ID",
    "CONTROL_PLANE_CONFIG",
    "GATEWAY_INVOKER_ROLE_ARN",
    "PLATFORM_STATE_TABLE_NAME",
  ]);
  assert.deepEqual(
    environment.COGNITO_USER_POOL_ID,
    { Ref: userPoolId },
  );
  assert.match(
    JSON.stringify(environment.CONTROL_PLANE_CONFIG),
    /agentic-demo-llm-gateway-abcdefghij/,
  );
  assert.doesNotMatch(
    JSON.stringify(environment.CONTROL_PLANE_CONFIG),
    /AgenticPlatform-ControlPlane-LlmGateway/,
  );
  assert.deepEqual(
    environment.GATEWAY_INVOKER_ROLE_ARN,
    roleReference(
      roleByName(template, names.gatewayInvoker)?.[0] ?? "",
    ),
  );
  assert.deepEqual(
    environment.PLATFORM_STATE_TABLE_NAME,
    { Ref: tableId },
  );
  const [seedId, seedResource] = resources(
    template,
    "Custom::PlatformBaselineModelPolicy",
  )[0] ?? [];
  assert.ok(seedId);
  assert.ok(seedResource);
  assert.deepEqual(seedResource.Properties, {
    ServiceToken: { "Fn::GetAtt": [functionId, "Arn"] },
    ServiceTimeout: "180",
    TableName: { Ref: tableId },
    ModelId: STARTER_BUILDER_MODEL_ID,
    ModelIds: JSON.parse(readFileSync(`${__dirname}/../config/baseline-model-catalog.json`, "utf8"))
      .models.map((model: {id: string}) => model.id),
    AllowedDomains: ["customer_support", "operations", "platform"],
    Limits: {
      requestsPerMinute: 60,
      tokensPerMinute: 120000,
      connectionsPerSecond: 4,
    },
  });
  assert.match(
    JSON.stringify(seedResource.DependsOn),
    /PlatformBaselineDomains/,
  );

  const statements = statementsForRole(template, roleId);
  assert.ok(
    statements.some((statement) =>
      actionList(statement).includes("dynamodb:GetItem")
      && actionList(statement).includes("dynamodb:Query")
      && JSON.stringify(statement.Condition).includes("MODEL_POLICY")
      && JSON.stringify(statement.Condition).includes("APPROVAL#*")
      && JSON.stringify(statement.Condition).includes("GRANT#*")
    ),
  );
  assert.ok(
    statements.some((statement) =>
      actionList(statement).includes("dynamodb:PutItem")
      && JSON.stringify(
        statement.Condition?.["ForAnyValue:StringEquals"],
      ).includes("TransactWriteItems")
      && JSON.stringify(statement.Condition).includes("MODEL_POLICY")
      && JSON.stringify(statement.Condition).includes("APPROVAL#*")
      && JSON.stringify(statement.Condition).includes("GRANT#*")
      && JSON.stringify(statement.Condition).includes("MUTATION#*")
    ),
  );
  assert.ok(
    statements.some((statement) =>
      actionList(statement).includes(
        "bedrock-agentcore:BatchPutGatewayRateLimits",
      )
      && actionList(statement).includes(
        "bedrock-agentcore:ListGatewayRateLimits",
      )
    ),
  );
  const assume = statements.find((statement) =>
    actionList(statement).includes("sts:AssumeRole")
  );
  assert.deepEqual(assume, {
    Action: [
      "sts:AssumeRole",
      "sts:SetSourceIdentity",
    ],
    Effect: "Allow",
    Resource: roleReference(
      roleByName(template, names.gatewayInvoker)?.[0] ?? "",
    ),
  });
  assert.equal(
    statements.some((statement) =>
      actionList(statement).includes(
        "bedrock-agentcore:InvokeGateway",
      )
    ),
    false,
  );

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
    "GET /api/ai-gateway",
    "POST /api/ai-gateway/model-policies",
    "POST /api/ai-gateway/model-access-requests",
    "POST /api/ai-gateway/model-access-decisions",
  ]) {
    const [, route] = resources(
      template,
      "AWS::ApiGatewayV2::Route",
    ).find(([, candidate]) =>
      candidate.Properties?.RouteKey === routeKey
    ) ?? [];
    assert.ok(route, routeKey);
    assert.equal(route.Properties?.AuthorizationType, "JWT");
    assert.ok(
      [...integrationIds].some((integrationId) =>
        JSON.stringify(route.Properties?.Target).includes(integrationId)
      ),
      routeKey,
    );
  }
});
