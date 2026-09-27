import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PlatformWebStack } from "../lib/platform-web-stack";

type Resource = {
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, any>;
};

function template() {
  const app = new cdk.App();
  const stack = new PlatformWebStack(app, "AccessAdminInfrastructure", {
    env: { account: "111122223333", region: "us-west-2" },
    cognitoDomainPrefix: "agentic-platform-access-admin",
    llmGatewayId: "agentic-demo-llm-gateway-abcdefghij",
    llmGatewayRegion: "us-east-1",
    starterBuilderModelId:
      "bedrock-mantle/anthropic.claude-haiku-4-5",
  });
  return Template.fromStack(stack);
}

function resources(
  synthesized: Template,
  type: string,
): Array<[string, Resource]> {
  return Object.entries(
    synthesized.findResources(type),
  ) as Array<[string, Resource]>;
}

function actions(statement: Record<string, any>): string[] {
  return Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action];
}

function statementsForRole(
  synthesized: Template,
  roleLogicalId: string,
): Record<string, any>[] {
  const role = synthesized.findResources("AWS::IAM::Role")[roleLogicalId];
  return (role.Properties?.Policies ?? [])
    .flatMap((policy: Record<string, any>) =>
      policy.PolicyDocument?.Statement ?? []
    );
}

test("access administration deploys as a bounded JWT API vertical slice", () => {
  const synthesized = template();
  const roles = resources(synthesized, "AWS::IAM::Role");
  const roleEntry = roles.find(([, role]) =>
    role.Properties?.RoleName ===
      "AgenticPlatform-Web-AccessAdminApiRole"
  );
  assert.ok(roleEntry);
  const [roleLogicalId, role] = roleEntry;

  const functions = resources(synthesized, "AWS::Lambda::Function");
  const functionEntry = functions.find(([, fn]) =>
    fn.Properties?.Description ===
      "Manages governed domain and project memberships"
  );
  assert.ok(functionEntry);
  const [functionLogicalId, fn] = functionEntry;
  assert.equal(fn.Properties?.Runtime, "nodejs22.x");
  assert.deepEqual(fn.Properties?.Architectures, ["arm64"]);
  assert.deepEqual(fn.Properties?.TracingConfig, { Mode: "Active" });
  assert.equal(fn.Properties?.ReservedConcurrentExecutions, 10);
  assert.deepEqual(
    fn.Properties?.Role?.["Fn::GetAtt"],
    [roleLogicalId, "Arn"],
  );
  assert.ok(
    Object.hasOwn(
      fn.Properties?.Environment?.Variables ?? {},
      "COGNITO_USER_POOL_ID",
    ),
  );
  assert.ok(
    Object.hasOwn(
      fn.Properties?.Environment?.Variables ?? {},
      "PLATFORM_STATE_TABLE_NAME",
    ),
  );

  const logGroups = resources(synthesized, "AWS::Logs::LogGroup");
  const accessLog = logGroups.find(([logicalId]) =>
    logicalId.startsWith("AccessAdminApiLogs")
  );
  assert.ok(accessLog);
  assert.equal(accessLog[1].Properties?.RetentionInDays, 90);
  assert.equal(accessLog[1].DeletionPolicy, "Retain");
  assert.equal(accessLog[1].UpdateReplacePolicy, "Retain");

  const statements = statementsForRole(synthesized, roleLogicalId);
  const cognito = statements.find((statement) =>
    actions(statement).includes("cognito-idp:AdminAddUserToGroup")
  );
  assert.ok(cognito);
  assert.deepEqual(actions(cognito).sort(), [
    "cognito-idp:AdminAddUserToGroup",
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
    "cognito-idp:AdminRemoveUserFromGroup",
    "cognito-idp:ListUsers",
    "cognito-idp:ListUsersInGroup",
  ]);
  assert.notEqual(cognito.Resource, "*");

  const update = statements.find((statement) =>
    actions(statement).includes("dynamodb:UpdateItem")
  );
  assert.ok(update);
  assert.deepEqual(
    update.Condition?.["ForAllValues:StringLike"]
      ?.["dynamodb:LeadingKeys"],
    ["PROJECT#*"],
  );

  const reads = statements.find((statement) =>
    actions(statement).includes("dynamodb:Query")
    && actions(statement).includes("dynamodb:GetItem")
  );
  assert.ok(reads);
  assert.deepEqual(
    reads.Condition?.["ForAllValues:StringLike"]
      ?.["dynamodb:LeadingKeys"],
    ["BREAK_GLASS", "DOMAIN", "MUTATION#*", "PROJECT#*"],
  );

  const claimWrite = statements.find((statement) =>
    actions(statement).includes("dynamodb:PutItem")
    && statement.Condition?.["ForAnyValue:StringEquals"] === undefined
  );
  assert.ok(claimWrite);
  assert.deepEqual(
    claimWrite.Condition?.["ForAllValues:StringLike"]
      ?.["dynamodb:LeadingKeys"],
    ["MUTATION#*"],
  );

  const auditWrite = statements.find((statement) =>
    actions(statement).includes("dynamodb:PutItem")
    && statement.Condition?.["ForAnyValue:StringEquals"] !== undefined
  );
  assert.ok(auditWrite);
  assert.deepEqual(
    auditWrite.Condition?.["ForAllValues:StringLike"]
      ?.["dynamodb:LeadingKeys"],
    ["AUDIT#*", "MUTATION#*"],
  );
  assert.deepEqual(
    auditWrite.Condition?.["ForAnyValue:StringEquals"]
      ?.["dynamodb:EnclosingOperation"],
    ["TransactWriteItems"],
  );

  const expectedRoutes = new Set([
    "GET /api/access/domain-members",
    "POST /api/access/domain-memberships",
    "POST /api/access/domain-membership-revocations",
    "GET /api/access/project-members",
    "POST /api/access/project-memberships",
    "POST /api/access/project-membership-revocations",
  ]);
  const routes = resources(synthesized, "AWS::ApiGatewayV2::Route")
    .filter(([, route]) => expectedRoutes.has(route.Properties?.RouteKey));
  assert.equal(routes.length, expectedRoutes.size);
  for (const [, route] of routes) {
    assert.equal(route.Properties?.AuthorizationType, "JWT");
  }

  const permissions = resources(synthesized, "AWS::Lambda::Permission")
    .filter(([, permission]) =>
      permission.Properties?.FunctionName?.Ref === functionLogicalId
      || permission.Properties?.FunctionName?.["Fn::GetAtt"]?.[0]
        === functionLogicalId
    );
  assert.equal(permissions.length, expectedRoutes.size);
  for (const [, permission] of permissions) {
    assert.equal(
      permission.Properties?.Principal,
      "apigateway.amazonaws.com",
    );
    const source = JSON.stringify(permission.Properties?.SourceArn);
    assert.match(source, /execute-api/);
    assert.doesNotMatch(source, /\/api\/\*/);
  }

  const boundary = resources(synthesized, "AWS::IAM::ManagedPolicy")
    .find(([, policy]) =>
      policy.Properties?.ManagedPolicyName ===
        "AgenticPlatform-Web-RuntimePermissionsBoundary"
    );
  assert.ok(boundary);
  const boundaryStatements =
    boundary[1].Properties?.PolicyDocument?.Statement ?? [];
  const directory = boundaryStatements.find(
    (statement: Record<string, any>) =>
      actions(statement).includes("cognito-idp:AdminAddUserToGroup")
      && actions(statement).includes("cognito-idp:ListUsersInGroup"),
  );
  assert.ok(directory);
  for (const action of [
    "cognito-idp:AdminAddUserToGroup",
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
    "cognito-idp:AdminRemoveUserFromGroup",
    "cognito-idp:CreateGroup",
    "cognito-idp:DeleteGroup",
    "cognito-idp:GetGroup",
    "cognito-idp:ListUsers",
    "cognito-idp:ListUsersInGroup",
  ]) {
    assert.ok(actions(directory).includes(action));
  }
  assert.equal(
    actions(directory).some(
      (action: string) =>
        action.startsWith("cognito-idp:") && action.includes("*"),
    ),
    false,
  );
  assert.match(JSON.stringify(directory.Resource), /UserPool.*Arn/);
  const projectUpdate = boundaryStatements.find(
    (statement: Record<string, any>) =>
      actions(statement).includes("dynamodb:UpdateItem"),
  );
  assert.ok(projectUpdate);
  assert.match(JSON.stringify(projectUpdate.Resource), /PlatformStateTable/);
});
