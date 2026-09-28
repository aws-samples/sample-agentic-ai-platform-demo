import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PLATFORM_WEB_RUNTIME_ROLE_NAMES } from "../lib/config";
import { PlatformWebStack } from "../lib/platform-web-stack";

type Resource = {
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, any>;
};

const INCEPTION_MODEL_ID =
  "bedrock-mantle/anthropic.claude-haiku-4-5";
const GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890abcdef";
const GITHUB_SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:111122223333:"
  + "secret:agentic-platform/github-oauth-ABC123";
const ROUTES = [
  "GET /oauth/github/callback",
  "GET /api/delivery/{id}",
  "GET /api/delivery/github",
  "GET /api/journeys/{id}",
  "POST /api/delivery/github/authorizations",
  "POST /api/delivery/previews",
  "POST /api/journeys",
  "POST /api/journeys/{id}/contract",
  "POST /api/journeys/{id}/messages",
] as const;

function fixture(options: {
  githubOAuthClientId?: string;
  githubOAuthClientSecretArn?: string;
  inceptionModelId?: string;
} = {}) {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, "JourneyInfrastructureTest", {
    env: { account: "111122223333", region: "us-west-2" },
    cognitoDomainPrefix: "agentic-platform-journey-test",
    llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
    llmGatewayRegion: "us-east-1",
    starterBuilderModelId: INCEPTION_MODEL_ID,
    inceptionModelId: options.inceptionModelId ?? INCEPTION_MODEL_ID,
    githubOAuthClientId: options.githubOAuthClientId,
    githubOAuthClientSecretArn: options.githubOAuthClientSecretArn,
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

function actions(statement: Record<string, any>): string[] {
  return [statement.Action].flat().sort();
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

test("Journey API is one retained Node 22 ARM64 Lambda with bounded configuration", () => {
  const template = fixture({
    githubOAuthClientId: GITHUB_OAUTH_CLIENT_ID,
    githubOAuthClientSecretArn: GITHUB_SECRET_ARN,
  });
  const roleName =
    (PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>).journeyApi;
  assert.equal(roleName, "AgenticPlatform-Web-JourneyApiRole");
  const [roleId, role] = roleByName(template, roleName) ?? [];
  assert.ok(roleId);
  assert.ok(role);
  assert.ok(role.Properties?.PermissionsBoundary);

  const [tableId] = resources(template, "AWS::DynamoDB::Table")[0];
  const [userPoolId] = resources(template, "AWS::Cognito::UserPool")[0];
  const [functionId, fn] = resources(template, "AWS::Lambda::Function")
    .find(([, candidate]) =>
      candidate.Properties?.Description
        === "Runs hosted agent-building journeys and approved delivery"
    ) ?? [];
  assert.ok(functionId);
  assert.ok(fn);
  assert.equal(fn.Properties?.Runtime, "nodejs22.x");
  assert.equal(fn.Properties?.Handler, "index.handler");
  assert.deepEqual(fn.Properties?.Architectures, ["arm64"]);
  assert.equal(fn.Properties?.Timeout, 90);
  assert.equal(fn.Properties?.ReservedConcurrentExecutions, undefined);
  assert.deepEqual(fn.Properties?.TracingConfig, { Mode: "Active" });
  assert.deepEqual(fn.Properties?.Role, {
    "Fn::GetAtt": [roleId, "Arn"],
  });
  const variables = fn.Properties?.Environment?.Variables;
  assert.deepEqual(Object.keys(variables).sort(), [
    "AGENT_RUNTIME_ARN",
    "AGENT_RUNTIME_ENDPOINT_ARN",
    "AGENT_RUNTIME_ENDPOINT_NAME",
    "COGNITO_USER_POOL_ID",
    "CONTROL_PLANE_CONFIG",
    "APPLICATION_ROOT_URL",
    "GATEWAY_INVOKER_ROLE_ARN",
    "GITHUB_OAUTH_CALLBACK_URL",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET_ARN",
    "INCEPTION_MODEL_ID",
    "PLATFORM_STATE_TABLE_NAME",
    "RUNTIME_INVOCATION_PROOF_SECRET_ARN",
  ].sort());
  assert.deepEqual(variables.COGNITO_USER_POOL_ID, { Ref: userPoolId });
  assert.ok(variables.CONTROL_PLANE_CONFIG);
  assert.ok(variables.GATEWAY_INVOKER_ROLE_ARN);
  assert.equal(
    variables.GITHUB_OAUTH_CLIENT_SECRET_ARN,
    GITHUB_SECRET_ARN,
  );
  assert.equal(
    variables.GITHUB_OAUTH_CLIENT_ID,
    GITHUB_OAUTH_CLIENT_ID,
  );
  const [distributionId] = resources(
    template,
    "AWS::CloudFront::Distribution",
  )[0];
  const [apiId] = resources(template, "AWS::ApiGatewayV2::Api")[0];
  assert.deepEqual(variables.APPLICATION_ROOT_URL, {
    "Fn::Join": [
      "",
      [
        "https://",
        { "Fn::GetAtt": [distributionId, "DomainName"] },
        "/",
      ],
    ],
  });
  assert.deepEqual(variables.GITHUB_OAUTH_CALLBACK_URL, {
    "Fn::Join": [
      "",
      [
        { "Fn::GetAtt": [apiId, "ApiEndpoint"] },
        "/oauth/github/callback",
      ],
    ],
  });
  assert.equal(variables.INCEPTION_MODEL_ID, INCEPTION_MODEL_ID);
  const [runtimeId] = resources(
    template,
    "AWS::BedrockAgentCore::Runtime",
  )[0];
  const [endpointId] = resources(
    template,
    "AWS::BedrockAgentCore::RuntimeEndpoint",
  ).find(([, endpoint]) => endpoint.Properties?.Name === "Production")!;
  const [proofSecretId] = resources(
    template,
    "AWS::SecretsManager::Secret",
  ).find(([, secret]) =>
    secret.Properties?.Description
      === "HMAC secret for governed Runtime invocation proof verification"
  )!;
  assert.deepEqual(variables.AGENT_RUNTIME_ARN, {
    "Fn::GetAtt": [runtimeId, "AgentRuntimeArn"],
  });
  assert.deepEqual(variables.AGENT_RUNTIME_ENDPOINT_ARN, {
    "Fn::GetAtt": [endpointId, "AgentRuntimeEndpointArn"],
  });
  assert.ok(variables.AGENT_RUNTIME_ENDPOINT_NAME);
  assert.deepEqual(
    variables.RUNTIME_INVOCATION_PROOF_SECRET_ARN,
    { Ref: proofSecretId },
  );
  assert.deepEqual(
    variables.PLATFORM_STATE_TABLE_NAME,
    { Ref: tableId },
  );

  const [logGroupId, logGroup] = resources(
    template,
    "AWS::Logs::LogGroup",
  ).find(([logicalId]) => logicalId.startsWith("JourneyApiLogs")) ?? [];
  assert.ok(logGroupId);
  assert.ok(logGroup);
  assert.equal(logGroup.Properties?.RetentionInDays, 90);
  assert.equal(logGroup.DeletionPolicy, "Retain");
  assert.equal(logGroup.UpdateReplacePolicy, "Retain");
});

test("Journey routes are JWT protected while the server-side GitHub callback is public", () => {
  const template = fixture();
  const functionEntry = resources(template, "AWS::Lambda::Function")
    .find(([, candidate]) =>
      candidate.Properties?.Description
        === "Runs hosted agent-building journeys and approved delivery"
    );
  assert.ok(functionEntry);
  const [functionId] = functionEntry;
  const integrationEntry = resources(template, "AWS::ApiGatewayV2::Integration")
    .find(([, integration]) =>
      JSON.stringify(integration.Properties?.IntegrationUri)
        .includes(functionId)
    );
  assert.ok(integrationEntry);
  const [integrationId] = integrationEntry;
  const routeEntries = resources(template, "AWS::ApiGatewayV2::Route")
    .filter(([, route]) => ROUTES.includes(route.Properties?.RouteKey));
  assert.deepEqual(
    routeEntries
      .map(([, route]) => route.Properties?.RouteKey)
      .sort(),
    [...ROUTES].sort(),
  );
  for (const [, route] of routeEntries) {
    const callback =
      route.Properties?.RouteKey === "GET /oauth/github/callback";
    assert.equal(route.Properties?.AuthorizationType, callback ? "NONE" : "JWT");
    assert.equal(
      Boolean(route.Properties?.AuthorizerId?.Ref),
      !callback,
    );
    assert.deepEqual(route.Properties?.Target, {
      "Fn::Join": ["", ["integrations/", { Ref: integrationId }]],
    });
  }

  const [stage] = resources(template, "AWS::ApiGatewayV2::Stage");
  const logFormat = stage[1].Properties?.AccessLogSettings?.Format;
  assert.equal(typeof logFormat, "string");
  assert.doesNotMatch(
    logFormat,
    /query|string|path|url|header/i,
  );

  const invokePermissions = resources(
    template,
    "AWS::Lambda::Permission",
  ).filter(([, permission]) =>
    permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
      === functionId
  );
  assert.equal(invokePermissions.length, ROUTES.length);
  const sourceArns = invokePermissions.map(([, permission]) =>
    normalizedArn(permission.Properties?.SourceArn)
  );
  for (const suffix of [
    "/*/GET/api/delivery/*",
    "/*/GET/api/delivery/github",
    "/*/GET/api/journeys/*",
    "/*/GET/oauth/github/callback",
    "/*/POST/api/delivery/github/authorizations",
    "/*/POST/api/delivery/previews",
    "/*/POST/api/journeys",
    "/*/POST/api/journeys/*/contract",
    "/*/POST/api/journeys/*/messages",
  ]) {
    assert.equal(
      sourceArns.filter((arn) => arn.endsWith(suffix)).length,
      1,
      suffix,
    );
  }
});

test("Journey role has only the state, identity, inventory, model, and optional credential access it uses", () => {
  const template = fixture({
    githubOAuthClientId: GITHUB_OAUTH_CLIENT_ID,
    githubOAuthClientSecretArn: GITHUB_SECRET_ARN,
  });
  const roleName =
    (PLATFORM_WEB_RUNTIME_ROLE_NAMES as Record<string, string>).journeyApi;
  const [roleId] = roleByName(template, roleName) ?? [];
  assert.ok(roleId);
  const statements = statementsForRole(template, roleId);
  const dynamo = statements.filter((statement) =>
    actions(statement).some((action) => action.startsWith("dynamodb:"))
  );
  assert.deepEqual(
    dynamo.map((statement) => ({
      actions: actions(statement),
      leadingKeys:
        statement.Condition?.["ForAllValues:StringLike"]
          ?.["dynamodb:LeadingKeys"]
        ?? statement.Condition?.["ForAllValues:StringEquals"]
          ?.["dynamodb:LeadingKeys"],
    })),
    [
      {
        actions: ["dynamodb:GetItem"],
        leadingKeys: [
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
      {
        actions: ["dynamodb:Query"],
        leadingKeys: ["DOMAIN"],
      },
      {
        actions: ["dynamodb:PutItem"],
        leadingKeys: ["MUTATION#*"],
      },
      {
        actions: ["dynamodb:PutItem"],
        leadingKeys: ["GITHUB_AUTHORIZATION#*"],
      },
      {
        actions: ["dynamodb:PutItem"],
        leadingKeys: [
          "DELIVERY#*",
          "JOURNEY#*",
        ],
      },
      {
        actions: ["dynamodb:UpdateItem"],
        leadingKeys: [
          "DELIVERY#*",
          "GITHUB_AUTHORIZATION#*",
          "MUTATION#*",
        ],
      },
    ],
  );
  const transactionalPut = dynamo.find((statement) =>
    actions(statement).includes("dynamodb:PutItem")
    && statement.Condition?.["ForAnyValue:StringEquals"]
      ?.["dynamodb:EnclosingOperation"]
  );
  assert.deepEqual(
    transactionalPut?.Condition?.["ForAnyValue:StringEquals"],
    { "dynamodb:EnclosingOperation": ["TransactWriteItems"] },
  );
  assert.deepEqual(
    transactionalPut?.Condition?.["ForAllValues:StringLike"]
      ?.["dynamodb:LeadingKeys"],
    ["DELIVERY#*", "JOURNEY#*"],
  );
  assert.equal(
    statements.flatMap(actions).includes("dynamodb:TransactWriteItems"),
    false,
  );

  const cognito = statements.find((statement) =>
    actions(statement).includes("cognito-idp:AdminGetUser")
  );
  assert.deepEqual(actions(cognito!), [
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
  ]);
  const bedrock = statements.find((statement) =>
    actions(statement).includes("bedrock:InvokeModel")
  );
  assert.equal(bedrock, undefined);
  const secrets = statements.filter((statement) =>
    actions(statement).includes("secretsmanager:GetSecretValue")
  );
  assert.equal(secrets.length, 2);
  assert.equal(
    secrets.some((statement) => statement.Resource === GITHUB_SECRET_ARN),
    true,
  );

  const registryActions = statements
    .flatMap(actions)
    .filter((action) => action.startsWith("agent-registry:"))
    .sort();
  assert.deepEqual(registryActions, [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ]);
  const gatewayActions = statements
    .flatMap(actions)
    .filter((action) => action.startsWith("bedrock-agentcore:"))
    .sort();
  assert.deepEqual(gatewayActions, [
    "bedrock-agentcore:GetGatewayTarget",
    "bedrock-agentcore:InvokeAgentRuntime",
    "bedrock-agentcore:InvokeAgentRuntimeForUser",
    "bedrock-agentcore:ListGatewayTargets",
  ]);
  assert.deepEqual(
    statements.flatMap(actions)
      .filter((action) => action.startsWith("sts:"))
      .sort(),
    ["sts:AssumeRole", "sts:SetSourceIdentity"],
  );
});

test("GitHub delivery configuration is optional but must be complete", () => {
  const template = fixture();
  const functionEntry = resources(template, "AWS::Lambda::Function")
    .find(([, candidate]) =>
      candidate.Properties?.Description
        === "Runs hosted agent-building journeys and approved delivery"
    );
  assert.ok(functionEntry);
  const variables = functionEntry[1].Properties?.Environment?.Variables;
  assert.equal(
    Object.hasOwn(variables, "GITHUB_OAUTH_CLIENT_ID"),
    false,
  );
  assert.equal(
    Object.hasOwn(variables, "GITHUB_OAUTH_CLIENT_SECRET_ARN"),
    false,
  );
  assert.equal(
    Object.hasOwn(variables, "GITHUB_OAUTH_CALLBACK_URL"),
    false,
  );
  assert.equal(
    Object.hasOwn(variables, "APPLICATION_ROOT_URL"),
    true,
  );
  assert.equal(
    resources(template, "AWS::IAM::Role")
      .flatMap(([, role]) => role.Properties?.Policies ?? [])
      .some((policy) =>
        JSON.stringify(policy).includes("secretsmanager:GetSecretValue")
        && JSON.stringify(policy).includes("agentic-platform/github")
      ),
    false,
  );

  assert.throws(
    () => fixture({ githubOAuthClientId: GITHUB_OAUTH_CLIENT_ID }),
    /githubOAuthClientId and githubOAuthClientSecretArn must be configured together/,
  );
  assert.throws(
    () => fixture({ githubOAuthClientSecretArn: GITHUB_SECRET_ARN }),
    /githubOAuthClientId and githubOAuthClientSecretArn must be configured together/,
  );
  assert.throws(
    () => fixture({
      githubOAuthClientId: "not-a-client-id",
      githubOAuthClientSecretArn: GITHUB_SECRET_ARN,
    }),
    /githubOAuthClientId is invalid/,
  );
  assert.throws(
    () => fixture({
      githubOAuthClientId: GITHUB_OAUTH_CLIENT_ID,
      githubOAuthClientSecretArn:
        "arn:aws:secretsmanager:us-east-1:111122223333:"
        + "secret:agentic-platform/github-oauth-ABC123",
    }),
    /githubOAuthClientSecretArn is invalid/,
  );
  for (const resourceName of [
    "*",
    "agentic-platform/*",
    "agentic-platform/github-oauth-?",
  ]) {
    assert.throws(
      () => fixture({
        githubOAuthClientId: GITHUB_OAUTH_CLIENT_ID,
        githubOAuthClientSecretArn:
          "arn:aws:secretsmanager:us-west-2:111122223333:"
          + `secret:${resourceName}`,
      }),
      /githubOAuthClientSecretArn is invalid/,
    );
  }
});

test("Agent Design Assistant model IDs require an AgentCore Gateway target path", () => {
  assert.throws(
    () => fixture({
      inceptionModelId:
        "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    }),
    /inceptionModelId is invalid/,
  );

  const template = fixture({
    inceptionModelId:
      "bedrock-claude/anthropic.claude-sonnet-5",
  });
  const fn = resources(template, "AWS::Lambda::Function").find(
    ([, candidate]) =>
      candidate.Properties?.Description
        === "Runs hosted agent-building journeys and approved delivery",
  );
  assert.equal(
    fn?.[1].Properties?.Environment?.Variables?.INCEPTION_MODEL_ID,
    "bedrock-claude/anthropic.claude-sonnet-5",
  );
});
