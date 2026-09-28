import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import {
  PLATFORM_WEB_RUNTIME_ROLE_NAMES,
  RUNTIME_PERMISSIONS_BOUNDARY_NAME,
} from "../lib/config";
import { GitHubBootstrapStack } from "../lib/github-bootstrap-stack";

type CfnResource = {
  Type: string;
  Properties?: Record<string, any>;
};

type PolicyStatement = Record<string, any>;

const ACCOUNT = "111122223333";
const REGION = "us-west-2";
const REPOSITORY = "example-org/example-repo";
const REPOSITORY_ID = "987654321";
const REPOSITORY_OWNER_ID = "12345678";
const WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/`
  + "deploy-serverless-platform.yml@refs/heads/main";
const LEGACY_SUBJECT = `repo:${REPOSITORY}:ref:refs/heads/main`;
const IMMUTABLE_SUBJECT =
  "repo:example-org@12345678/"
  + "example-repo@987654321:ref:refs/heads/main";
const BOUNDARY_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
  + RUNTIME_PERMISSIONS_BOUNDARY_NAME;
const CONTROL_PLANE_RUNTIME_BOUNDARY_NAME =
  "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary";
const CONTROL_PLANE_RUNTIME_BOUNDARY_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
  + CONTROL_PLANE_RUNTIME_BOUNDARY_NAME;
const WEB_ROLE_ARNS = Object.values(PLATFORM_WEB_RUNTIME_ROLE_NAMES)
  .map((roleName) =>
    `arn:<AWS::Partition>:iam::${ACCOUNT}:role/${roleName}`
  );
const HOSTED_ACCEPTANCE_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-HostedAcceptanceRole";
const WEB_MANAGED_ROLE_ARNS = [
  ...WEB_ROLE_ARNS,
  HOSTED_ACCEPTANCE_ROLE_ARN,
];
const PLATFORM_STATE_TABLE_ARN =
  `arn:<AWS::Partition>:dynamodb:${REGION}:${ACCOUNT}:`
  + "table/AgenticPlatform-Web-PlatformStateTable*";
const PLATFORM_STATE_SEED_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-PlatformStateSeedRole";
const PLATFORM_WORKSPACE_SEED_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-PlatformWorkspaceSeedRole";
const PLATFORM_ADMIN_API_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-PlatformAdminApiRole";
const ACCESS_ADMIN_API_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-AccessAdminApiRole";
const GOVERNANCE_API_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-GovernanceApiRole";
const REGISTRY_DECISION_FINALIZER_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-RegistryDecisionFinalizerRole";
const HOSTED_ACCEPTANCE_BROKER_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-Web-HostedAcceptanceBrokerRole";
const DEPLOYED_STACK_RESOURCES = [
  "AgenticPlatform-Web",
  "AgenticPlatform-ControlPlane",
  "AgenticPlatform-ControlPlane-Provisioned",
].flatMap((stackName) => [
  `arn:<AWS::Partition>:cloudformation:${REGION}:${ACCOUNT}:stack/${stackName}/*`,
  `arn:<AWS::Partition>:cloudformation:${REGION}:${ACCOUNT}:changeSet/${stackName}/*`,
]);
const CONTROL_PLANE_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:`
  + "role/AgenticPlatform-ControlPlane-Provisioned-*";
const CONTROL_PLANE_LAMBDA_BASIC_EXECUTION_POLICY_ARN =
  "arn:<AWS::Partition>:iam::aws:policy/service-role/"
  + "AWSLambdaBasicExecutionRole";
const CONTROL_PLANE_FUNCTION_ARN =
  `arn:<AWS::Partition>:lambda:${REGION}:${ACCOUNT}:`
  + "function:AgenticPlatform-ControlPlane-Provisioned-*";
const CONTROL_PLANE_LOG_GROUP_ARN =
  `arn:<AWS::Partition>:logs:${REGION}:${ACCOUNT}:`
  + "log-group:AgenticPlatform-ControlPlane-Provisioned-*";
const CONTROL_PLANE_STATE_MACHINE_ARN =
  `arn:<AWS::Partition>:states:${REGION}:${ACCOUNT}:`
  + "stateMachine:AgenticPlatform-ControlPlane-Provisioned-*";
const CONTROL_PLANE_PARAMETER_ARN =
  `arn:<AWS::Partition>:ssm:${REGION}:${ACCOUNT}:`
  + "parameter/agentic-platform/control-plane/config";
const CONTROL_PLANE_REGISTRY_ARNS = [
  `arn:<AWS::Partition>:agent-registry:${REGION}:${ACCOUNT}:registry/*`,
  `arn:<AWS::Partition>:agent-registry:${REGION}:${ACCOUNT}:`
    + "registry/*/record/*",
];
const CONTROL_PLANE_GATEWAY_ARN =
  `arn:<AWS::Partition>:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/*`;
const STAGE1_AGENT_RUNTIME_ARN =
  `arn:<AWS::Partition>:bedrock-agentcore:${REGION}:${ACCOUNT}:`
  + "runtime/AgenticPlatformRuntime-*";
const STAGE1_AGENT_RUNTIME_ENDPOINT_ARN =
  `${STAGE1_AGENT_RUNTIME_ARN}/runtime-endpoint/*`;
const STAGE1_AGENT_RUNTIME_WORKLOAD_IDENTITY_DIRECTORY_ARN =
  `arn:<AWS::Partition>:bedrock-agentcore:${REGION}:${ACCOUNT}:`
  + "workload-identity-directory/default";
const STAGE1_AGENT_RUNTIME_WORKLOAD_IDENTITY_ARN =
  `${STAGE1_AGENT_RUNTIME_WORKLOAD_IDENTITY_DIRECTORY_ARN}/`
  + "workload-identity/AgenticPlatformRuntime-*";
const AGENTCORE_RUNTIME_IDENTITY_SERVICE_LINKED_ROLE_ARN =
  `arn:<AWS::Partition>:iam::${ACCOUNT}:role/aws-service-role/`
  + "runtime-identity.bedrock-agentcore.amazonaws.com/"
  + "AWSServiceRoleForBedrockAgentCoreRuntimeIdentity";
const STAGE1_LOG_DELIVERY_SOURCE_ARN =
  `arn:<AWS::Partition>:logs:${REGION}:${ACCOUNT}:`
  + "delivery-source:AgenticPlatformWebGoverned*";
const STAGE1_LOG_DELIVERY_DESTINATION_ARN =
  `arn:<AWS::Partition>:logs:${REGION}:${ACCOUNT}:`
  + "delivery-destination:AgenticPlatformWebGoverned*";
const STAGE1_LOG_DELIVERY_ARN =
  `arn:<AWS::Partition>:logs:${REGION}:${ACCOUNT}:delivery:*`;
const EXPECTED_TAGS = {
  "auto-delete": "no",
  managedBy: "cdk",
  project: "agentic-ai-platform-demo",
};
const CONTROL_PLANE_REGISTRY_REQUEST_TAG_CONDITION = {
  "ForAllValues:StringEquals": {
    "aws:TagKeys": ["auto-delete", "managedBy", "project"],
  },
  StringEquals: {
    "aws:RequestTag/auto-delete": "no",
    "aws:RequestTag/managedBy": "cdk",
    "aws:RequestTag/project": "agentic-ai-platform-demo",
    "aws:RequestedRegion": REGION,
  },
};
const CONTROL_PLANE_REGISTRY_RESOURCE_TAG_CONDITION = {
  StringEquals: {
    "aws:ResourceTag/auto-delete": "no",
    "aws:ResourceTag/managedBy": "cdk",
    "aws:ResourceTag/project": "agentic-ai-platform-demo",
  },
};
const CONTROL_PLANE_REGISTRY_TAG_MUTATION_CONDITION = {
  "ForAllValues:StringEquals":
    CONTROL_PLANE_REGISTRY_REQUEST_TAG_CONDITION[
      "ForAllValues:StringEquals"
    ],
  StringEquals: {
    ...CONTROL_PLANE_REGISTRY_REQUEST_TAG_CONDITION.StringEquals,
    ...CONTROL_PLANE_REGISTRY_RESOURCE_TAG_CONDITION.StringEquals,
  },
};

const GITHUB_DEPLOYMENT_METADATA = {
  repositoryId: REPOSITORY_ID,
  repositoryOwnerId: REPOSITORY_OWNER_ID,
  workflowRef: WORKFLOW_REF,
  githubOidcSubjectMode: "legacy",
  githubOidcSubject: LEGACY_SUBJECT,
} as const;

function createStack(options: Record<string, unknown> = {}) {
  const app = new cdk.App();
  const props = {
    env: { account: ACCOUNT, region: REGION },
    repository: REPOSITORY,
    branchProtectionAttested: true,
    ...GITHUB_DEPLOYMENT_METADATA,
    ...options,
  };
  const stack = new GitHubBootstrapStack(
    app,
    "TestBootstrap",
    props as any,
  );
  return { app, stack, template: Template.fromStack(stack) };
}

let cachedFixture: ReturnType<typeof createStack> | undefined;

function fixture() {
  cachedFixture ??= createStack();
  return cachedFixture;
}

function resourceEntries(
  template: Template,
  type: string,
): Array<[string, CfnResource]> {
  return Object.entries(template.findResources(type)) as Array<
    [string, CfnResource]
  >;
}

function normalizedTags(resource: CfnResource): Record<string, string> {
  return Object.fromEntries(
    (resource.Properties?.Tags ?? []).map(
      (tag: { Key: string; Value: string }) => [tag.Key, tag.Value],
    ),
  );
}

function namedRole(template: Template, roleName: string): CfnResource {
  const match = resourceEntries(template, "AWS::IAM::Role").find(
    ([, role]) => role.Properties?.RoleName === roleName,
  );
  assert.ok(match, `missing role ${roleName}`);
  return match[1];
}

function namedManagedPolicy(
  template: Template,
  policyName: string,
): [string, CfnResource] {
  const match = resourceEntries(template, "AWS::IAM::ManagedPolicy").find(
    ([, policy]) => policy.Properties?.ManagedPolicyName === policyName,
  );
  assert.ok(match, `missing managed policy ${policyName}`);
  return match;
}

function identityPolicyStatements(template: Template): PolicyStatement[] {
  const roleStatements = resourceEntries(template, "AWS::IAM::Role")
    .flatMap(([, role]) => role.Properties?.Policies ?? [])
    .flatMap((policy: Record<string, any>) =>
      policy.PolicyDocument?.Statement ?? []
    );
  const managedStatements = resourceEntries(template, "AWS::IAM::Policy")
    .flatMap(([, policy]) =>
      policy.Properties?.PolicyDocument?.Statement ?? []
    );
  const customerManagedStatements = resourceEntries(
    template,
    "AWS::IAM::ManagedPolicy",
  )
    .filter(([, policy]) =>
      (policy.Properties?.Roles ?? []).length > 0
    )
    .flatMap(([, policy]) =>
      policy.Properties?.PolicyDocument?.Statement ?? []
    );
  return [
    ...roleStatements,
    ...managedStatements,
    ...customerManagedStatements,
  ];
}

function rolePolicyStatements(
  template: Template,
  roleName: string,
): PolicyStatement[] {
  const roleEntry = resourceEntries(template, "AWS::IAM::Role").find(
    ([, role]) => role.Properties?.RoleName === roleName,
  );
  assert.ok(roleEntry, `missing role ${roleName}`);
  const [roleId, role] = roleEntry;
  const inline = (role.Properties?.Policies ?? [])
    .flatMap((policy: Record<string, any>) =>
      policy.PolicyDocument?.Statement ?? []
    );
  const attached = resourceEntries(template, "AWS::IAM::Policy")
    .filter(([, policy]) =>
      JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId)
    )
    .flatMap(([, policy]) =>
      policy.Properties?.PolicyDocument?.Statement ?? []
    );
  const customerManaged = resourceEntries(
    template,
    "AWS::IAM::ManagedPolicy",
  )
    .filter(([, policy]) =>
      JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId)
    )
    .flatMap(([, policy]) =>
      policy.Properties?.PolicyDocument?.Statement ?? []
    );
  return [...inline, ...attached, ...customerManaged];
}

function actions(statement: PolicyStatement): string[] {
  return (Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action]).sort();
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

function resources(statement: PolicyStatement): string[] {
  const rawResources = Array.isArray(statement.Resource)
    ? statement.Resource
    : [statement.Resource];
  return rawResources.map(normalizeResource);
}

function resolveIamPolicyValue(value: any): any {
  if (Array.isArray(value)) {
    return value.map(resolveIamPolicyValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.keys(value).length === 1 && value.Ref !== undefined) {
    assert.equal(
      value.Ref,
      "AWS::Partition",
      `unsupported IAM policy Ref ${value.Ref}`,
    );
    return "aws";
  }
  if (
    Object.keys(value).length === 1
    && value["Fn::Join"] !== undefined
  ) {
    const join = value["Fn::Join"];
    assert.ok(Array.isArray(join) && join.length === 2);
    const [separator, parts] = join;
    assert.equal(typeof separator, "string");
    assert.ok(Array.isArray(parts));
    return parts.map((part: any) => {
      const resolved = resolveIamPolicyValue(part);
      assert.equal(typeof resolved, "string");
      return resolved;
    }).join(separator);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveIamPolicyValue(child),
    ]),
  );
}

function iamPolicyCharacterCount(document: any): number {
  return JSON.stringify(resolveIamPolicyValue(document))
    .replace(/\s/g, "")
    .length;
}

function statementBySid(
  template: Template,
  sid: string,
): PolicyStatement {
  const matches = identityPolicyStatements(template).filter(
    (statement) => statement.Sid === sid,
  );
  assert.equal(matches.length, 1, `expected exactly one statement ${sid}`);
  return matches[0];
}

test("stack creates the named provider, protected stack, and required outputs", () => {
  const { stack, template } = fixture();
  assert.equal(stack.stackName, "AgenticPlatform-GitHubBootstrap");
  assert.equal(stack.terminationProtection, true);

  const providers = resourceEntries(template, "AWS::IAM::OIDCProvider");
  assert.equal(providers.length, 1);
  assert.deepEqual(providers[0][1].Properties?.ClientIdList, [
    "sts.amazonaws.com",
  ]);
  assert.equal(
    providers[0][1].Properties?.Url,
    "https://token.actions.githubusercontent.com",
  );

  assert.deepEqual(Object.keys(template.findOutputs("*")).sort(), [
    "CloudFormationExecutionRoleArn",
    "GitHubDeployRoleArn",
    "GitHubOidcProviderArn",
  ]);
});

test("GitHub trust binds the repository, immutable IDs, protected main, audience, subject, and reusable workflow", () => {
  const { template } = fixture();
  const role = namedRole(template, "AgenticPlatformGitHubDeployRole");
  const statements = role.Properties?.AssumeRolePolicyDocument?.Statement ?? [];
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Action, "sts:AssumeRoleWithWebIdentity");
  assert.deepEqual(statements[0].Condition, {
    StringEquals: {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:job_workflow_ref": WORKFLOW_REF,
      "token.actions.githubusercontent.com:ref": "refs/heads/main",
      "token.actions.githubusercontent.com:repository": REPOSITORY,
      "token.actions.githubusercontent.com:repository_id": REPOSITORY_ID,
      "token.actions.githubusercontent.com:repository_owner_id":
        REPOSITORY_OWNER_ID,
      "token.actions.githubusercontent.com:sub": LEGACY_SUBJECT,
    },
  });

  const rendered = JSON.stringify(statements[0]);
  assert.doesNotMatch(rendered, /repo:[^"]*\*/);
  assert.doesNotMatch(rendered, /refs\/heads\/[^"]*\*/);
  assert.doesNotMatch(rendered, /:environment:/);
  assert.doesNotMatch(rendered, /feat\/|pull_request|refs\/heads\/\*/);
});

test("direct bootstrap construction fails closed without protected-main attestation", () => {
  const app = new cdk.App();
  assert.throws(
    () => new GitHubBootstrapStack(app, "UnattestedBootstrap", {
      env: { account: ACCOUNT, region: REGION },
      repository: REPOSITORY,
      branchProtectionAttested: false,
      ...GITHUB_DEPLOYMENT_METADATA,
    }),
    /branch protection.*attested/i,
  );
});

test("bootstrap construction fails closed without complete immutable repository metadata", () => {
  const app = new cdk.App();
  const props = {
    env: { account: ACCOUNT, region: REGION },
    repository: REPOSITORY,
    branchProtectionAttested: true,
  };

  assert.throws(
    () => new GitHubBootstrapStack(
      app,
      "MissingRepositoryMetadata",
      props as any,
    ),
    /repositoryId|repositoryOwnerId|workflowRef|subject/i,
  );
});

test("legacy and immutable subject modes require their exact declared default subject", () => {
  assert.throws(
    () => createStack({ githubOidcSubject: IMMUTABLE_SUBJECT }),
    /subject.*legacy/i,
  );
  assert.throws(
    () => createStack({
      githubOidcSubjectMode: "immutable",
      githubOidcSubject: LEGACY_SUBJECT,
    }),
    /subject.*immutable/i,
  );
  assert.throws(
    () => createStack({ githubOidcSubjectMode: "guessed" }),
    /subject mode/i,
  );
});

test("immutable subject mode binds the exact immutable default subject", () => {
  const { template } = createStack({
    githubOidcSubjectMode: "immutable",
    githubOidcSubject: IMMUTABLE_SUBJECT,
  });
  const role = namedRole(template, "AgenticPlatformGitHubDeployRole");
  const condition =
    role.Properties?.AssumeRolePolicyDocument?.Statement?.[0]?.Condition;

  assert.equal(
    condition?.StringEquals?.["token.actions.githubusercontent.com:sub"],
    IMMUTABLE_SUBJECT,
  );
});

test("managed-policy tag provider uses the CDK log-group ARN without a second wildcard", () => {
  const { template } = fixture();
  const logStatement = rolePolicyStatements(
    template,
    "AgenticPlatform-GitHubBootstrap-ManagedPolicyTagProviderRole",
  ).find((statement) =>
    actions(statement).includes("logs:CreateLogStream")
  );
  assert.ok(logStatement);

  const logGroupIds = new Set(
    resourceEntries(template, "AWS::Logs::LogGroup")
      .map(([logicalId]) => logicalId),
  );
  const getAtt = logStatement.Resource?.["Fn::GetAtt"];
  assert.ok(Array.isArray(getAtt));
  assert.equal(getAtt.length, 2);
  assert.equal(getAtt[1], "Arn");
  assert.equal(logGroupIds.has(getAtt[0]), true);
});

test("an imported GitHub provider does not create a duplicate provider", () => {
  const providerArn =
    `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
  const { template } = createStack({
    githubOidcProviderArn: providerArn,
  });

  template.resourceCountIs("AWS::IAM::OIDCProvider", 0);
  assert.equal(
    template.findOutputs("GitHubOidcProviderArn")
      .GitHubOidcProviderArn.Value,
    providerArn,
  );
});

test("deploy role can pass only the dedicated execution role to CloudFormation", () => {
  const { template } = fixture();
  const statement = statementBySid(template, "PassCloudFormationExecutionRole");
  const executionRoleId =
    Object.keys(template.findResources("AWS::IAM::Role")).find((id) =>
      id.startsWith("CloudFormationExecutionRole")
    ) ?? "";
  assert.match(executionRoleId, /^CloudFormationExecutionRole/);
  assert.deepEqual(actions(statement), ["iam:PassRole"]);
  assert.deepEqual(statement.Resource, {
    "Fn::GetAtt": [executionRoleId, "Arn"],
  });
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      "iam:PassedToService": "cloudformation.amazonaws.com",
    },
  });

  const passRoleStatements = rolePolicyStatements(
    template,
    "AgenticPlatformGitHubDeployRole",
  ).filter(
    (candidate) => actions(candidate).includes("iam:PassRole"),
  );
  assert.deepEqual(passRoleStatements, [statement]);
});

test("GitHub deploy role has no Cognito user management or user-pool wildcard", () => {
  const { template } = fixture();
  const statements = rolePolicyStatements(
    template,
    "AgenticPlatformGitHubDeployRole",
  );

  assert.deepEqual(
    statements
      .flatMap((statement) => actions(statement))
      .filter((action) => action.startsWith("cognito-idp:")),
    [],
  );
  assert.doesNotMatch(
    JSON.stringify(statements),
    new RegExp(
      `arn:[^"]+:cognito-idp:${REGION}:${ACCOUNT}:userpool/\\\\\\*`,
    ),
  );
});

test("GitHub deploy role can assume only the exact hosted acceptance role", () => {
  const { template } = fixture();
  const statement = statementBySid(template, "AssumeHostedAcceptanceRole");

  assert.deepEqual(actions(statement), ["sts:AssumeRole"]);
  assert.deepEqual(resources(statement), [HOSTED_ACCEPTANCE_ROLE_ARN]);
  assert.equal(statement.Condition, undefined);

  const assumeRoleStatements = rolePolicyStatements(
    template,
    "AgenticPlatformGitHubDeployRole",
  ).filter((candidate) => actions(candidate).includes("sts:AssumeRole"));
  assert.deepEqual(assumeRoleStatements, [statement]);
  assert.doesNotMatch(JSON.stringify(statement.Resource), /\*/);
});

test("execution role is trusted only by CloudFormation for at most two hours", () => {
  const { template } = fixture();
  const role = namedRole(
    template,
    "AgenticPlatformCloudFormationExecutionRole",
  );
  assert.equal(role.Properties?.MaxSessionDuration, 7200);
  assert.deepEqual(role.Properties?.AssumeRolePolicyDocument?.Statement, [
    {
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "cloudformation.amazonaws.com" },
    },
  ]);
});

test("identity policies grant only the exact hosted acceptance role assumption and no wildcard IAM or actions", () => {
  const { template } = fixture();
  for (const statement of identityPolicyStatements(template)) {
    const statementActions = actions(statement);
    if (statementActions.includes("sts:AssumeRole")) {
      assert.equal(statement.Sid, "AssumeHostedAcceptanceRole");
      assert.deepEqual(resources(statement), [HOSTED_ACCEPTANCE_ROLE_ARN]);
    }
    assert.ok(!statementActions.includes("iam:*"), statement.Sid);
    assert.ok(!statementActions.includes("*"), statement.Sid);
  }
});

test("execution role includes Cognito user-pool MFA resource-provider calls", () => {
  const { template } = fixture();
  const cognitoActions = identityPolicyStatements(template)
    .filter((statement) =>
      resources(statement).includes(
        `arn:<AWS::Partition>:cognito-idp:${REGION}:${ACCOUNT}:userpool/*`,
      )
    )
    .flatMap(actions);

  for (const requiredAction of [
    "cognito-idp:GetUserPoolMfaConfig",
    "cognito-idp:SetUserPoolMfaConfig",
  ]) {
    assert.ok(cognitoActions.includes(requiredAction), requiredAction);
  }
});

test("execution role includes IAM role attached-policy discovery", () => {
  const { template } = fixture();
  assert.ok(
    actions(statementBySid(template, "ManageWebRoles"))
      .includes("iam:ListAttachedRolePolicies"),
  );
});

test("execution role can provision only the tagged PlatformWeb state table without application data access", () => {
  const { template } = fixture();
  const create = statementBySid(
    template,
    "CreateTaggedPlatformStateTable",
  );
  assert.deepEqual(actions(create), ["dynamodb:CreateTable"]);
  assert.deepEqual(resources(create), [PLATFORM_STATE_TABLE_ARN]);
  assert.deepEqual(create.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
    },
  });

  const manage = statementBySid(template, "ManageStateTable");
  assert.deepEqual(actions(manage), [
    "dynamodb:DeleteTable",
    "dynamodb:DescribeContinuousBackups",
    "dynamodb:DescribeTable",
    "dynamodb:DescribeTimeToLive",
    "dynamodb:ListTagsOfResource",
    "dynamodb:TagResource",
    "dynamodb:UntagResource",
    "dynamodb:UpdateContinuousBackups",
    "dynamodb:UpdateTable",
    "dynamodb:UpdateTimeToLive",
  ]);
  assert.deepEqual(resources(manage), [PLATFORM_STATE_TABLE_ARN]);
  assert.equal(manage.Condition, undefined);

  const dynamodbActions = rolePolicyStatements(
    template,
    "AgenticPlatformCloudFormationExecutionRole",
  ).flatMap(actions).filter((action) => action.startsWith("dynamodb:"));
  assert.deepEqual(dynamodbActions.sort(), [
    "dynamodb:CreateTable",
    "dynamodb:DeleteTable",
    "dynamodb:DescribeContinuousBackups",
    "dynamodb:DescribeTable",
    "dynamodb:DescribeTimeToLive",
    "dynamodb:ListTagsOfResource",
    "dynamodb:TagResource",
    "dynamodb:UntagResource",
    "dynamodb:UpdateContinuousBackups",
    "dynamodb:UpdateTable",
    "dynamodb:UpdateTimeToLive",
  ]);
  for (const dataPlaneAction of [
    "dynamodb:BatchGetItem",
    "dynamodb:BatchWriteItem",
    "dynamodb:DeleteItem",
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:Query",
    "dynamodb:Scan",
    "dynamodb:TransactGetItems",
    "dynamodb:TransactWriteItems",
    "dynamodb:UpdateItem",
  ]) {
    assert.ok(!dynamodbActions.includes(dataPlaneAction), dataPlaneAction);
  }
});

test("execution role can create and update only bounded PlatformWeb roles and cannot detach the boundary", () => {
  const { template } = fixture();
  const create = statementBySid(
    template,
    "CreateWebRoles",
  );
  assert.deepEqual(actions(create), ["iam:CreateRole"]);
  assert.deepEqual(resources(create), WEB_ROLE_ARNS);
  assert.equal(
    normalizeResource(
      create.Condition?.StringEquals?.["iam:PermissionsBoundary"],
    ),
    BOUNDARY_ARN,
  );

  const createAcceptance = statementBySid(
    template,
    "CreateAcceptance",
  );
  assert.deepEqual(actions(createAcceptance), ["iam:CreateRole"]);
  assert.deepEqual(resources(createAcceptance), [HOSTED_ACCEPTANCE_ROLE_ARN]);
  assert.deepEqual(createAcceptance.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
    },
  });

  const apply = statementBySid(template, "ApplyStage1RoleBoundary");
  assert.deepEqual(actions(apply), ["iam:PutRolePermissionsBoundary"]);
  assert.deepEqual(resources(apply), WEB_ROLE_ARNS);
  assert.equal(
    normalizeResource(
      apply.Condition?.StringEquals?.["iam:PermissionsBoundary"],
    ),
    BOUNDARY_ARN,
  );

  const manage = statementBySid(template, "ManageWebRoles");
  assert.ok(actions(manage).includes("iam:PutRolePolicy"));
  assert.ok(!actions(manage).includes("iam:CreateRole"));
  assert.ok(!actions(manage).includes("iam:DeleteRolePermissionsBoundary"));
  assert.deepEqual(resources(manage), WEB_MANAGED_ROLE_ARNS);
  assert.equal(
    manage.Condition,
    undefined,
    "role-management actions do not support iam:PermissionsBoundary",
  );

  const denyRemoval = statementBySid(
    template,
    "DenyStage1RoleBoundaryRemoval",
  );
  assert.equal(denyRemoval.Effect, "Deny");
  assert.deepEqual(actions(denyRemoval), [
    "iam:DeleteRolePermissionsBoundary",
  ]);
  assert.deepEqual(resources(denyRemoval), WEB_ROLE_ARNS);
  assert.equal(
    denyRemoval.Condition,
    undefined,
    "boundary removal must be denied even when the request has no boundary key",
  );
});

test("only supported IAM actions carry the permissions-boundary condition", () => {
  const { template } = fixture();
  const boundaryConditionStatements = identityPolicyStatements(template)
    .filter((statement) =>
      statement.Condition?.StringEquals?.["iam:PermissionsBoundary"]
      !== undefined
    );

  assert.deepEqual(
    boundaryConditionStatements.map(({ Sid }) => Sid).sort(),
    [
      "ApplyControlPlaneRoleBoundary",
      "ApplyStage1RoleBoundary",
      "CreateControlPlaneIamRolesWithBoundary",
      "CreateWebRoles",
    ],
  );

  const unsupportedActions = [
    "iam:DeleteRole",
    "iam:DeleteRolePolicy",
    "iam:GetRole",
    "iam:GetRolePolicy",
    "iam:ListAttachedRolePolicies",
    "iam:ListRolePolicies",
    "iam:PutRolePolicy",
    "iam:TagRole",
    "iam:UntagRole",
    "iam:UpdateAssumeRolePolicy",
    "iam:UpdateRole",
    "iam:UpdateRoleDescription",
  ];
  for (const statement of identityPolicyStatements(template)) {
    if (actions(statement).some((action) =>
      unsupportedActions.includes(action)
    )) {
      assert.equal(
        statement.Condition?.StringEquals?.["iam:PermissionsBoundary"],
        undefined,
        statement.Sid,
      );
    }
  }
});

test("execution role passes only the governed Runtime role to AgentCore", () => {
  const { template } = fixture();
  const passRole = statementBySid(
    template,
    "PassAgentRuntimeRoleToAgentCore",
  );
  assert.deepEqual(actions(passRole), ["iam:PassRole"]);
  assert.deepEqual(resources(passRole), [
    `arn:<AWS::Partition>:iam::${ACCOUNT}:role/`
      + PLATFORM_WEB_RUNTIME_ROLE_NAMES.agentRuntime,
  ]);
  assert.deepEqual(passRole.Condition, {
    StringEquals: {
      "iam:PassedToService": "bedrock-agentcore.amazonaws.com",
    },
  });
});

test("execution role passes only the twenty-three exact boundary-constrained runtime roles to Lambda", () => {
  const { template } = fixture();
  const passRole = statementBySid(template, "PassStage1RolesToLambda");

  assert.deepEqual(actions(passRole), ["iam:PassRole"]);
  assert.deepEqual(resources(passRole), WEB_ROLE_ARNS);
  assert.deepEqual(passRole.Condition, {
    StringEquals: {
      "iam:PassedToService": "lambda.amazonaws.com",
    },
  });
});

test("GitHub deploy role can audit the twenty-three bounded roles and hosted acceptance role", () => {
  const { template } = fixture();
  const readRoles = statementBySid(template, "ReadStage1RuntimeRoles");

  assert.deepEqual(actions(readRoles), ["iam:GetRole", "iam:ListRoleTags"]);
  assert.deepEqual(resources(readRoles), WEB_MANAGED_ROLE_ARNS);
  assert.equal(readRoles.Condition, undefined);
});

test("GitHub deploy role can inspect only governance runtime role effective policies", () => {
  const { template } = fixture();
  const readPolicies = statementBySid(
    template,
    "ReadPlatformRuntimeRolePolicies",
  );

  assert.deepEqual(actions(readPolicies), [
    "iam:GetRolePolicy",
    "iam:ListAttachedRolePolicies",
    "iam:ListRolePolicies",
  ]);
  assert.deepEqual(
    resources(readPolicies).sort(),
    [
      ACCESS_ADMIN_API_ROLE_ARN,
      HOSTED_ACCEPTANCE_BROKER_ROLE_ARN,
      HOSTED_ACCEPTANCE_ROLE_ARN,
      GOVERNANCE_API_ROLE_ARN,
      PLATFORM_ADMIN_API_ROLE_ARN,
      REGISTRY_DECISION_FINALIZER_ROLE_ARN,
      PLATFORM_STATE_SEED_ROLE_ARN,
      PLATFORM_WORKSPACE_SEED_ROLE_ARN,
    ].sort(),
  );
  assert.equal(readPolicies.Condition, undefined);
});

test("GitHub deploy role can inspect TTL only on the platform state table", () => {
  const { template } = fixture();
  const readTtl = statementBySid(
    template,
    "ReadPlatformStateTableTimeToLive",
  );

  assert.deepEqual(actions(readTtl), ["dynamodb:DescribeTimeToLive"]);
  assert.deepEqual(resources(readTtl), [PLATFORM_STATE_TABLE_ARN]);
  assert.equal(readTtl.Condition, undefined);
});

test("active runtime-role test titles distinguish bounded and audited roles", () => {
  const source = readFileSync(__filename, "utf8");
  const staleTitles = [
    ["eight", "exact", "runtime", "roles"].join(" "),
    ["nine", "exact", "runtime", "roles"].join(" "),
    ["seventeen", "exact", "runtime", "roles"].join(" "),
  ];

  for (const staleTitle of staleTitles) {
    assert.doesNotMatch(source, new RegExp(staleTitle, "i"));
  }
  assert.match(
    source,
    /twenty-three exact boundary-constrained runtime roles/i,
  );
  assert.match(
    source,
    /twenty-three bounded roles and hosted acceptance role/i,
  );
});

test("execution role inline policies stay within the aggregate IAM role quota", () => {
  const { template } = fixture();
  const roleEntry = resourceEntries(template, "AWS::IAM::Role").find(
    ([, role]) =>
      role.Properties?.RoleName
      === "AgenticPlatformCloudFormationExecutionRole",
  );
  assert.ok(roleEntry);
  const [roleId, role] = roleEntry;
  const inlinePolicyDocuments = [
    ...(role.Properties?.Policies ?? [])
      .map((policy: Record<string, any>) => policy.PolicyDocument),
    ...resourceEntries(template, "AWS::IAM::Policy")
      .filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId)
      )
      .map(([, policy]) => policy.Properties?.PolicyDocument),
  ];
  const aggregateCharacters = inlinePolicyDocuments.reduce(
    (total, document) => total + iamPolicyCharacterCount(document),
    0,
  );
  const managedPolicyDocuments = resourceEntries(
    template,
    "AWS::IAM::ManagedPolicy",
  )
    .filter(([, policy]) =>
      JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId)
    )
    .map(([, policy]) => policy.Properties?.PolicyDocument);

  assert.equal(inlinePolicyDocuments.length, 1);
  assert.ok(
    aggregateCharacters < 10_240,
    `execution role inline policies use ${aggregateCharacters} characters`,
  );
  assert.equal(managedPolicyDocuments.length, 8);
  for (const document of managedPolicyDocuments) {
    const characters = iamPolicyCharacterCount(document);
    assert.ok(
      characters <= 6_144,
      `execution role managed policy uses ${characters} characters`,
    );
  }
});

test("every customer-managed policy stays within the IAM document limit", () => {
  const { template } = fixture();

  for (const [, policy] of resourceEntries(
    template,
    "AWS::IAM::ManagedPolicy",
  )) {
    const policyName = policy.Properties?.ManagedPolicyName;
    const characters = iamPolicyCharacterCount(
      policy.Properties?.PolicyDocument,
    );
    assert.ok(
      characters <= 6_144,
      `${policyName} managed policy uses ${characters} characters`,
    );
  }
});

test("GitHub deploy role stays within IAM policy quotas without unnamed overflow policies", () => {
  const { template } = fixture();
  const roleEntry = resourceEntries(template, "AWS::IAM::Role").find(
    ([, role]) =>
      role.Properties?.RoleName === "AgenticPlatformGitHubDeployRole",
  );
  assert.ok(roleEntry);
  const [roleId, role] = roleEntry;
  const inlinePolicyDocuments = [
    ...(role.Properties?.Policies ?? [])
      .map((policy: Record<string, any>) => policy.PolicyDocument),
    ...resourceEntries(template, "AWS::IAM::Policy")
      .filter(([, policy]) =>
        JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId)
      )
      .map(([, policy]) => policy.Properties?.PolicyDocument),
  ];
  const aggregateCharacters = inlinePolicyDocuments.reduce(
    (total, document) => total + JSON.stringify(document).length,
    0,
  );
  assert.ok(
    aggregateCharacters < 10_240,
    `deploy role inline policies use ${aggregateCharacters} characters`,
  );

  const attachedManagedPolicies = resourceEntries(
    template,
    "AWS::IAM::ManagedPolicy",
  ).filter(([, policy]) =>
    JSON.stringify(policy.Properties?.Roles ?? []).includes(roleId)
  );
  assert.deepEqual(
    attachedManagedPolicies
      .map(([, policy]) => policy.Properties?.ManagedPolicyName)
      .sort(),
    [
      "AgenticPlatform-GitHubBootstrap-ControlPlaneDeploymentValidation",
      "AgenticPlatform-GitHubBootstrap-DeploymentValidation",
    ],
  );
  for (const [, policy] of attachedManagedPolicies) {
    assert.ok(
      JSON.stringify(policy.Properties?.PolicyDocument).length < 6_144,
    );
  }
  for (const [, policy] of resourceEntries(
    template,
    "AWS::IAM::ManagedPolicy",
  )) {
    assert.ok(
      policy.Properties?.ManagedPolicyName,
      "every customer-managed policy must be explicitly named and tagged",
    );
  }
});

test("execution role manages only the provisioned control-plane boundary", () => {
  const { template } = fixture();
  const boundary = statementBySid(
    template,
    "ManageControlPlaneRuntimeBoundary",
  );
  assert.deepEqual(actions(boundary), [
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:DeletePolicy",
    "iam:DeletePolicyVersion",
    "iam:GetPolicy",
    "iam:GetPolicyVersion",
    "iam:ListPolicyVersions",
    "iam:SetDefaultPolicyVersion",
    "iam:TagPolicy",
    "iam:UntagPolicy",
  ]);
  assert.deepEqual(
    resources(boundary),
    [CONTROL_PLANE_RUNTIME_BOUNDARY_ARN],
  );
});

test("execution role includes Lambda function resource-provider reads", () => {
  const { template } = fixture();
  const lambdaActions = actions(
    statementBySid(template, "ManageStage1Lambda"),
  );

  for (const requiredAction of [
    "lambda:GetFunctionCodeSigningConfig",
    "lambda:GetFunctionRecursionConfig",
    "lambda:GetFunctionScalingConfig",
    "lambda:GetRuntimeManagementConfig",
  ]) {
    assert.ok(lambdaActions.includes(requiredAction), requiredAction);
  }
});

test("GitHub deployment role is limited to the exact web and control-plane stacks", () => {
  const { template } = fixture();
  const stackStatements = [
    "CreateOrUpdateAgenticPlatformWebStack",
    "ExecuteOrDeleteAgenticPlatformWebChangeSet",
    "ManageAgenticPlatformWebStack",
    "ReadAgenticPlatformWebStack",
  ].map((sid) => statementBySid(template, sid));

  for (const statement of stackStatements) {
    assert.deepEqual(resources(statement), DEPLOYED_STACK_RESOURCES);
  }
});

test("execution role can deploy only the provisioned control-plane resources", () => {
  const { template } = fixture();

  const ssm = statementBySid(template, "ManageControlPlaneSsmParameter");
  assert.deepEqual(actions(ssm), [
    "ssm:AddTagsToResource",
    "ssm:DeleteParameter",
    "ssm:GetParameter",
    "ssm:GetParameters",
    "ssm:ListTagsForResource",
    "ssm:PutParameter",
    "ssm:RemoveTagsFromResource",
  ]);
  assert.deepEqual(resources(ssm), [CONTROL_PLANE_PARAMETER_ARN]);

  const createRole = statementBySid(
    template,
    "CreateControlPlaneIamRolesWithBoundary",
  );
  assert.deepEqual(actions(createRole), ["iam:CreateRole"]);
  assert.deepEqual(resources(createRole), [CONTROL_PLANE_ROLE_ARN]);
  assert.deepEqual({
    ...createRole.Condition,
    StringEquals: {
      ...createRole.Condition?.StringEquals,
      "iam:PermissionsBoundary": normalizeResource(
        createRole.Condition?.StringEquals?.[
          "iam:PermissionsBoundary"
        ],
      ),
    },
  }, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
      "iam:PermissionsBoundary":
        CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
    },
  });

  const applyBoundary = statementBySid(
    template,
    "ApplyControlPlaneRoleBoundary",
  );
  assert.deepEqual(actions(applyBoundary), [
    "iam:PutRolePermissionsBoundary",
  ]);
  assert.deepEqual(resources(applyBoundary), [CONTROL_PLANE_ROLE_ARN]);
  assert.equal(
    normalizeResource(
      applyBoundary.Condition?.StringEquals?.[
        "iam:PermissionsBoundary"
      ],
    ),
    CONTROL_PLANE_RUNTIME_BOUNDARY_ARN,
  );

  const denyBoundaryRemoval = statementBySid(
    template,
    "DenyControlPlaneRoleBoundaryRemoval",
  );
  assert.equal(denyBoundaryRemoval.Effect, "Deny");
  assert.deepEqual(actions(denyBoundaryRemoval), [
    "iam:DeleteRolePermissionsBoundary",
  ]);
  assert.deepEqual(
    resources(denyBoundaryRemoval),
    [CONTROL_PLANE_ROLE_ARN],
  );
  assert.equal(denyBoundaryRemoval.Condition, undefined);

  const manageRole = statementBySid(
    template,
    "ManageControlPlaneIamRoles",
  );
  assert.deepEqual(actions(manageRole), [
    "iam:DeleteRole",
    "iam:DeleteRolePolicy",
    "iam:GetRole",
    "iam:GetRolePolicy",
    "iam:ListAttachedRolePolicies",
    "iam:ListRolePolicies",
    "iam:PutRolePolicy",
    "iam:TagRole",
    "iam:UntagRole",
    "iam:UpdateAssumeRolePolicy",
    "iam:UpdateRole",
    "iam:UpdateRoleDescription",
  ]);
  assert.deepEqual(resources(manageRole), [CONTROL_PLANE_ROLE_ARN]);
  assert.equal(
    manageRole.Condition,
    undefined,
    "role-management actions do not support iam:PermissionsBoundary",
  );

  const managedPolicyAttachment = statementBySid(
    template,
    "ManageControlPlanePolicy",
  );
  assert.deepEqual(actions(managedPolicyAttachment), [
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
  ]);
  assert.deepEqual(
    resources(managedPolicyAttachment),
    [CONTROL_PLANE_ROLE_ARN],
  );
  assert.deepEqual(
    normalizeResource(
      managedPolicyAttachment.Condition?.ArnEquals?.["iam:PolicyARN"],
    ),
    CONTROL_PLANE_LAMBDA_BASIC_EXECUTION_POLICY_ARN,
  );

  const passRoleCases = [
    ["PassControlPlaneRolesToLambda", "lambda.amazonaws.com"],
    ["PassControlPlaneRolesToStepFunctions", "states.amazonaws.com"],
    [
      "PassControlPlaneRolesToAgentCore",
      "bedrock-agentcore.amazonaws.com",
    ],
  ];
  for (const [sid, service] of passRoleCases) {
    const passRole = statementBySid(template, sid);
    assert.deepEqual(actions(passRole), ["iam:PassRole"]);
    assert.deepEqual(resources(passRole), [CONTROL_PLANE_ROLE_ARN]);
    assert.deepEqual(passRole.Condition, {
      StringEquals: { "iam:PassedToService": service },
    });
  }

  const lambda = statementBySid(template, "ManageControlPlaneLambda");
  assert.ok(actions(lambda).includes("lambda:CreateFunction"));
  assert.ok(actions(lambda).includes("lambda:UpdateFunctionCode"));
  assert.ok(actions(lambda).includes("lambda:DeleteFunction"));
  assert.deepEqual(resources(lambda), [CONTROL_PLANE_FUNCTION_ARN]);

  const logs = statementBySid(template, "ManageControlPlaneLogGroups");
  assert.deepEqual(actions(logs), [
    "logs:CreateLogGroup",
    "logs:DeleteLogGroup",
    "logs:DeleteRetentionPolicy",
    "logs:ListTagsForResource",
    "logs:PutRetentionPolicy",
    "logs:TagResource",
    "logs:UntagResource",
  ]);
  assert.deepEqual(resources(logs), [CONTROL_PLANE_LOG_GROUP_ARN]);

  const stateMachine = statementBySid(
    template,
    "ManageControlPlaneStateMachine",
  );
  assert.deepEqual(actions(stateMachine), [
    "states:CreateStateMachine",
    "states:DeleteStateMachine",
    "states:DescribeStateMachine",
    "states:ListTagsForResource",
    "states:TagResource",
    "states:UntagResource",
    "states:UpdateStateMachine",
  ]);
  assert.deepEqual(resources(stateMachine), [
    CONTROL_PLANE_STATE_MACHINE_ARN,
  ]);
});

test("bootstrap leaves the control-plane runtime boundary to the provisioned stack", () => {
  const { template } = fixture();
  assert.equal(
    resourceEntries(template, "AWS::IAM::ManagedPolicy").some(
      ([, policy]) =>
        policy.Properties?.ManagedPolicyName
          === CONTROL_PLANE_RUNTIME_BOUNDARY_NAME,
    ),
    false,
  );
});

test("deployment validation can audit the control-plane boundary, execution role, and provisioned roles", () => {
  const { template } = fixture();
  const executionRoleArn =
    `arn:<AWS::Partition>:iam::${ACCOUNT}:role/`
    + "AgenticPlatformCloudFormationExecutionRole";

  const readBoundary = statementBySid(
    template,
    "ReadControlPlaneRuntimeBoundaryPolicy",
  );
  assert.deepEqual(actions(readBoundary), [
    "iam:GetPolicy",
    "iam:GetPolicyVersion",
    "iam:ListPolicyTags",
  ]);
  assert.deepEqual(
    resources(readBoundary),
    [CONTROL_PLANE_RUNTIME_BOUNDARY_ARN],
  );

  const readExecutionRole = statementBySid(
    template,
    "ReadControlPlaneExecutionRolePolicies",
  );
  assert.deepEqual(actions(readExecutionRole), [
    "iam:GetRole",
    "iam:GetRolePolicy",
    "iam:ListAttachedRolePolicies",
    "iam:ListRolePolicies",
  ]);
  assert.deepEqual(resources(readExecutionRole), [executionRoleArn]);

  const readProvisionedRoles = statementBySid(
    template,
    "ReadProvisionedControlPlaneRoles",
  );
  assert.deepEqual(actions(readProvisionedRoles), ["iam:GetRole"]);
  assert.deepEqual(resources(readProvisionedRoles), [
    CONTROL_PLANE_ROLE_ARN,
  ]);
});

test("execution role bounds control-plane Registry and Gateway operations", () => {
  const { template } = fixture();

  const createRegistry = statementBySid(
    template,
    "CreateTaggedControlPlaneRegistries",
  );
  assert.deepEqual(actions(createRegistry), [
    "agent-registry:CreateRegistry",
  ]);
  assert.deepEqual(resources(createRegistry), ["*"]);
  assert.deepEqual(
    createRegistry.Condition,
    CONTROL_PLANE_REGISTRY_REQUEST_TAG_CONDITION,
  );

  const tagRegistry = statementBySid(
    template,
    "TagControlPlaneRegistries",
  );
  assert.deepEqual(actions(tagRegistry), [
    "agent-registry:TagResource",
  ]);
  assert.deepEqual(resources(tagRegistry), [
    CONTROL_PLANE_REGISTRY_ARNS[0],
  ]);
  assert.deepEqual(
    tagRegistry.Condition,
    CONTROL_PLANE_REGISTRY_TAG_MUTATION_CONDITION,
  );

  const createRegistryRecord = statementBySid(
    template,
    "CreateTaggedControlPlaneRegistryRecords",
  );
  assert.deepEqual(actions(createRegistryRecord), [
    "agent-registry:CreateRegistryRecord",
  ]);
  assert.deepEqual(resources(createRegistryRecord), [
    CONTROL_PLANE_REGISTRY_ARNS[0],
  ]);
  assert.deepEqual(
    createRegistryRecord.Condition,
    CONTROL_PLANE_REGISTRY_TAG_MUTATION_CONDITION,
  );

  const readRegistries = statementBySid(
    template,
    "ReadControlPlaneRegistries",
  );
  assert.deepEqual(actions(readRegistries), [
    "agent-registry:GetRegistry",
    "agent-registry:ListRegistryRecords",
  ]);
  assert.deepEqual(resources(readRegistries), [
    CONTROL_PLANE_REGISTRY_ARNS[0],
  ]);

  const readRegistryRecords = statementBySid(
    template,
    "ReadControlPlaneRegistryRecords",
  );
  assert.deepEqual(actions(readRegistryRecords), [
    "agent-registry:GetRegistryRecord",
  ]);
  assert.deepEqual(resources(readRegistryRecords), [
    CONTROL_PLANE_REGISTRY_ARNS[1],
  ]);

  const mutateRegistries = statementBySid(
    template,
    "MutateTaggedControlPlaneRegistries",
  );
  assert.deepEqual(actions(mutateRegistries), [
    "agent-registry:DeleteRegistry",
    "agent-registry:UpdateRegistry",
  ]);
  assert.deepEqual(resources(mutateRegistries), [
    CONTROL_PLANE_REGISTRY_ARNS[0],
  ]);
  assert.deepEqual(
    mutateRegistries.Condition,
    CONTROL_PLANE_REGISTRY_RESOURCE_TAG_CONDITION,
  );

  const mutateRegistryRecords = statementBySid(
    template,
    "MutateTaggedControlPlaneRegistryRecords",
  );
  assert.deepEqual(actions(mutateRegistryRecords), [
    "agent-registry:DeleteRegistryRecord",
    "agent-registry:SubmitRegistryRecordForApproval",
    "agent-registry:UpdateRegistryRecordStatus",
  ]);
  assert.deepEqual(resources(mutateRegistryRecords), [
    CONTROL_PLANE_REGISTRY_ARNS[1],
  ]);
  assert.deepEqual(
    mutateRegistryRecords.Condition,
    CONTROL_PLANE_REGISTRY_RESOURCE_TAG_CONDITION,
  );

  const listRegistries = statementBySid(
    template,
    "ListControlPlaneRegistries",
  );
  assert.deepEqual(actions(listRegistries), [
    "agent-registry:ListRegistries",
  ]);
  assert.deepEqual(resources(listRegistries), ["*"]);

  const workloadIdentities = statementBySid(
    template,
    "ManageControlPlaneWorkloadIdentities",
  );
  assert.deepEqual(actions(workloadIdentities), [
    "bedrock-agentcore:CreateWorkloadIdentity",
    "bedrock-agentcore:DeleteWorkloadIdentity",
    "bedrock-agentcore:GetWorkloadIdentity",
  ]);
  assert.deepEqual(resources(workloadIdentities), [
    `arn:<AWS::Partition>:bedrock-agentcore:${REGION}:${ACCOUNT}:`
      + "workload-identity-directory/*",
  ]);

  const createGateway = statementBySid(
    template,
    "CreateTaggedControlPlaneGateways",
  );
  assert.deepEqual(actions(createGateway), [
    "bedrock-agentcore:CreateGateway",
  ]);
  assert.deepEqual(resources(createGateway), ["*"]);
  assert.deepEqual(createGateway.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
    },
  });
});

test("execution role uses a dedicated bounded Registry deployment policy", () => {
  const { template } = fixture();
  const executionRoleEntry = resourceEntries(
    template,
    "AWS::IAM::Role",
  ).find(([, role]) =>
    role.Properties?.RoleName
      === "AgenticPlatformCloudFormationExecutionRole"
  );
  assert.ok(executionRoleEntry);
  const [executionRoleId] = executionRoleEntry;
  const [, registryPolicy] = namedManagedPolicy(
    template,
    "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment",
  );
  assert.deepEqual(registryPolicy.Properties?.Roles, [
    { Ref: executionRoleId },
  ]);
  assert.deepEqual(
    registryPolicy.Properties?.PolicyDocument?.Statement
      .map((statement: PolicyStatement) => statement.Sid)
      .sort(),
    [
      "CreateTaggedControlPlaneRegistries",
      "CreateTaggedControlPlaneRegistryRecords",
      "ListControlPlaneRegistries",
      "MutateTaggedControlPlaneRegistries",
      "MutateTaggedControlPlaneRegistryRecords",
      "ReadControlPlaneRegistries",
      "ReadControlPlaneRegistryRecords",
      "TagControlPlaneRegistries",
    ],
  );

  const [, controlPlanePolicy] = namedManagedPolicy(
    template,
    "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment",
  );
  const registrySids = new Set(
    registryPolicy.Properties?.PolicyDocument?.Statement
      .map((statement: PolicyStatement) => statement.Sid),
  );
  assert.equal(
    controlPlanePolicy.Properties?.PolicyDocument?.Statement?.some(
      (statement: PolicyStatement) => registrySids.has(statement.Sid),
    ),
    false,
  );
});

test("execution role uses a dedicated bounded Gateway deployment policy", () => {
  const { template } = fixture();
  const executionRoleEntry = resourceEntries(
    template,
    "AWS::IAM::Role",
  ).find(([, role]) =>
    role.Properties?.RoleName
      === "AgenticPlatformCloudFormationExecutionRole"
  );
  assert.ok(executionRoleEntry);
  const [executionRoleId] = executionRoleEntry;
  const [, gatewayPolicy] = namedManagedPolicy(
    template,
    "AgenticPlatform-GitHubBootstrap-ControlPlaneGatewayDeployment",
  );
  assert.deepEqual(gatewayPolicy.Properties?.Roles, [
    { Ref: executionRoleId },
  ]);

  const gatewayStatements =
    gatewayPolicy.Properties?.PolicyDocument?.Statement ?? [];
  assert.equal(gatewayStatements.length, 4);
  const expectedGatewayArns = [
    `arn:<AWS::Partition>:bedrock-agentcore:${REGION}:${ACCOUNT}:`
      + "gateway/agentic-demo-llm-gateway-*",
    `arn:<AWS::Partition>:bedrock-agentcore:${REGION}:${ACCOUNT}:`
      + "gateway/platform-tools-gw-*",
  ];
  const reads = gatewayStatements.find(
    (statement: PolicyStatement) =>
      statement.Sid === "ReadControlPlaneGateways",
  );
  assert.ok(reads);
  assert.deepEqual(actions(reads), [
    "bedrock-agentcore:GetGateway",
    "bedrock-agentcore:GetGatewayTarget",
    "bedrock-agentcore:ListGatewayTargets",
    "bedrock-agentcore:ListTagsForResource",
  ]);
  assert.deepEqual(resources(reads), expectedGatewayArns);

  const creates = gatewayStatements.find(
    (statement: PolicyStatement) =>
      statement.Sid === "CreateControlPlaneGatewayTargets",
  );
  assert.ok(creates);
  assert.deepEqual(actions(creates), [
    "bedrock-agentcore:CreateGatewayTarget",
  ]);
  assert.deepEqual(resources(creates), expectedGatewayArns);

  const mutations = gatewayStatements.find(
    (statement: PolicyStatement) =>
      statement.Sid === "MutateTaggedControlPlaneGateways",
  );
  assert.ok(mutations);
  assert.deepEqual(actions(mutations), [
    "bedrock-agentcore:DeleteGateway",
    "bedrock-agentcore:DeleteGatewayTarget",
    "bedrock-agentcore:SynchronizeGatewayTargets",
    "bedrock-agentcore:TagResource",
    "bedrock-agentcore:UntagResource",
    "bedrock-agentcore:UpdateGateway",
    "bedrock-agentcore:UpdateGatewayTarget",
  ]);
  assert.deepEqual(resources(mutations), expectedGatewayArns);
  assert.deepEqual(
    mutations.Condition,
    CONTROL_PLANE_REGISTRY_RESOURCE_TAG_CONDITION,
  );

  const mantle = gatewayStatements.find(
    (statement: PolicyStatement) =>
      statement.Sid === "ReadBedrockMantleModels",
  );
  assert.ok(mantle);
  assert.deepEqual(actions(mantle), [
    "bedrock-mantle:GetModel",
    "bedrock-mantle:ListModels",
  ]);
  assert.deepEqual(resources(mantle), [
    `arn:<AWS::Partition>:bedrock-mantle:${REGION}:${ACCOUNT}:`
      + "project/default",
  ]);

  const [, controlPlanePolicy] = namedManagedPolicy(
    template,
    "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment",
  );
  assert.equal(
    controlPlanePolicy.Properties?.PolicyDocument?.Statement?.some(
      (statement: PolicyStatement) =>
        [
          "ReadControlPlaneGateways",
          "CreateControlPlaneGatewayTargets",
          "MutateTaggedControlPlaneGateways",
          "ReadBedrockMantleModels",
        ].includes(statement.Sid),
    ),
    false,
  );
});

test("execution role uses a dedicated bounded AgentCore Runtime deployment policy", () => {
  const { template } = fixture();
  const executionRoleEntry = resourceEntries(
    template,
    "AWS::IAM::Role",
  ).find(([, role]) =>
    role.Properties?.RoleName
      === "AgenticPlatformCloudFormationExecutionRole"
  );
  assert.ok(executionRoleEntry);
  const [executionRoleId] = executionRoleEntry;
  const [, runtimePolicy] = namedManagedPolicy(
    template,
    "AgenticPlatform-GitHubBootstrap-AgentRuntimeDeployment",
  );
  assert.deepEqual(runtimePolicy.Properties?.Roles, [
    { Ref: executionRoleId },
  ]);

  const createRuntime = statementBySid(
    template,
    "CreateTaggedStage1AgentRuntime",
  );
  assert.deepEqual(actions(createRuntime), [
    "bedrock-agentcore:CreateAgentRuntime",
  ]);
  assert.deepEqual(resources(createRuntime), ["*"]);
  assert.deepEqual(createRuntime.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
    },
  });

  const tagRuntimeResources = statementBySid(
    template,
    "TagStage1AgentRuntimeResources",
  );
  assert.deepEqual(actions(tagRuntimeResources), [
    "bedrock-agentcore:TagResource",
  ]);
  assert.deepEqual(resources(tagRuntimeResources), [
    STAGE1_AGENT_RUNTIME_ARN,
    STAGE1_AGENT_RUNTIME_ENDPOINT_ARN,
  ]);
  assert.deepEqual(
    tagRuntimeResources.Condition,
    createRuntime.Condition,
  );

  const workloadIdentity = statementBySid(
    template,
    "ManageStage1AgentRuntimeWorkloadIdentity",
  );
  assert.deepEqual(actions(workloadIdentity), [
    "bedrock-agentcore:CreateWorkloadIdentity",
    "bedrock-agentcore:DeleteWorkloadIdentity",
  ]);
  assert.deepEqual(resources(workloadIdentity), [
    STAGE1_AGENT_RUNTIME_WORKLOAD_IDENTITY_DIRECTORY_ARN,
    STAGE1_AGENT_RUNTIME_WORKLOAD_IDENTITY_ARN,
  ]);
  assert.deepEqual(workloadIdentity.Condition, {
    StringEquals: {
      "aws:RequestedRegion": REGION,
    },
  });

  const serviceLinkedRole = statementBySid(
    template,
    "CreateAgentCoreRuntimeIdentityServiceLinkedRole",
  );
  assert.deepEqual(actions(serviceLinkedRole), [
    "iam:CreateServiceLinkedRole",
  ]);
  assert.deepEqual(resources(serviceLinkedRole), [
    AGENTCORE_RUNTIME_IDENTITY_SERVICE_LINKED_ROLE_ARN,
  ]);
  assert.deepEqual(serviceLinkedRole.Condition, {
    StringEquals: {
      "iam:AWSServiceName":
        "runtime-identity.bedrock-agentcore.amazonaws.com",
    },
  });

  const createEndpoint = statementBySid(
    template,
    "CreateTaggedStage1AgentRuntimeEndpoints",
  );
  assert.deepEqual(actions(createEndpoint), [
    "bedrock-agentcore:CreateAgentRuntimeEndpoint",
  ]);
  assert.deepEqual(resources(createEndpoint), [
    STAGE1_AGENT_RUNTIME_ARN,
  ]);
  assert.deepEqual(createEndpoint.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "cdk",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
    },
  });

  const manageRuntime = statementBySid(
    template,
    "ManageTaggedStage1AgentRuntime",
  );
  assert.deepEqual(actions(manageRuntime), [
    "bedrock-agentcore:DeleteAgentRuntime",
    "bedrock-agentcore:GetAgentRuntime",
    "bedrock-agentcore:ListTagsForResource",
    "bedrock-agentcore:UpdateAgentRuntime",
  ]);
  assert.deepEqual(resources(manageRuntime), [
    STAGE1_AGENT_RUNTIME_ARN,
  ]);
  assert.deepEqual(manageRuntime.Condition, {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "cdk",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
    },
  });

  const manageEndpoints = statementBySid(
    template,
    "ManageTaggedStage1AgentRuntimeEndpoints",
  );
  assert.deepEqual(actions(manageEndpoints), [
    "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
    "bedrock-agentcore:GetAgentRuntimeEndpoint",
    "bedrock-agentcore:ListTagsForResource",
    "bedrock-agentcore:UpdateAgentRuntimeEndpoint",
  ]);
  assert.deepEqual(resources(manageEndpoints), [
    STAGE1_AGENT_RUNTIME_ARN,
    STAGE1_AGENT_RUNTIME_ENDPOINT_ARN,
  ]);
  assert.deepEqual(manageEndpoints.Condition, manageRuntime.Condition);

  const untagRuntimeResources = statementBySid(
    template,
    "UntagOptionalStage1AgentRuntimeTags",
  );
  assert.deepEqual(actions(untagRuntimeResources), [
    "bedrock-agentcore:UntagResource",
  ]);
  assert.deepEqual(resources(untagRuntimeResources), [
    STAGE1_AGENT_RUNTIME_ARN,
    STAGE1_AGENT_RUNTIME_ENDPOINT_ARN,
  ]);
  assert.deepEqual(untagRuntimeResources.Condition, {
    "ForAllValues:StringNotEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "cdk",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
    },
  });

  const denyMandatoryTagRemoval = statementBySid(
    template,
    "DenyMandatoryStage1AgentRuntimeTagRemoval",
  );
  assert.equal(denyMandatoryTagRemoval.Effect, "Deny");
  assert.deepEqual(actions(denyMandatoryTagRemoval), [
    "bedrock-agentcore:UntagResource",
  ]);
  assert.deepEqual(resources(denyMandatoryTagRemoval), [
    STAGE1_AGENT_RUNTIME_ARN,
    STAGE1_AGENT_RUNTIME_ENDPOINT_ARN,
  ]);
  assert.deepEqual(denyMandatoryTagRemoval.Condition, {
    "ForAnyValue:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
  });
});

test("execution role uses a dedicated tagged Runtime observability deployment policy", () => {
  const { template } = fixture();
  const executionRoleEntry = resourceEntries(
    template,
    "AWS::IAM::Role",
  ).find(([, role]) =>
    role.Properties?.RoleName
      === "AgenticPlatformCloudFormationExecutionRole"
  );
  assert.ok(executionRoleEntry);
  const [executionRoleId] = executionRoleEntry;
  const [, observabilityPolicy] = namedManagedPolicy(
    template,
    "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment",
  );
  assert.deepEqual(observabilityPolicy.Properties?.Roles, [
    { Ref: executionRoleId },
  ]);

  const requestTags = {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
    },
  };
  const resourceTags = {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "cdk",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": REGION,
    },
  };

  const createSourcesAndDestinations = statementBySid(
    template,
    "CreateTaggedStage1LogDeliverySourcesAndDestinations",
  );
  assert.deepEqual(actions(createSourcesAndDestinations), [
    "logs:PutDeliveryDestination",
    "logs:PutDeliverySource",
  ]);
  assert.deepEqual(resources(createSourcesAndDestinations), [
    STAGE1_LOG_DELIVERY_SOURCE_ARN,
    STAGE1_LOG_DELIVERY_DESTINATION_ARN,
  ]);
  assert.deepEqual(createSourcesAndDestinations.Condition, requestTags);

  const updateSourcesAndDestinations = statementBySid(
    template,
    "UpdateTaggedStage1LogDeliverySourcesAndDestinations",
  );
  assert.deepEqual(actions(updateSourcesAndDestinations), [
    "logs:PutDeliveryDestination",
    "logs:PutDeliverySource",
  ]);
  assert.deepEqual(
    resources(updateSourcesAndDestinations),
    resources(createSourcesAndDestinations),
  );
  assert.deepEqual(updateSourcesAndDestinations.Condition, resourceTags);

  const createDeliveries = statementBySid(
    template,
    "CreateTaggedStage1LogDeliveries",
  );
  assert.deepEqual(actions(createDeliveries), ["logs:CreateDelivery"]);
  assert.deepEqual(resources(createDeliveries), [
    STAGE1_LOG_DELIVERY_SOURCE_ARN,
    STAGE1_LOG_DELIVERY_DESTINATION_ARN,
  ]);
  assert.deepEqual(createDeliveries.Condition, {
    "ForAllValues:StringEquals":
      requestTags["ForAllValues:StringEquals"],
    StringEquals: {
      ...requestTags.StringEquals,
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "cdk",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
    },
  });

  const manageResources = statementBySid(
    template,
    "ManageTaggedStage1LogDeliveryResources",
  );
  assert.deepEqual(actions(manageResources), [
    "logs:DeleteDelivery",
    "logs:DeleteDeliveryDestination",
    "logs:DeleteDeliveryDestinationPolicy",
    "logs:DeleteDeliverySource",
    "logs:GetDelivery",
    "logs:GetDeliveryDestination",
    "logs:GetDeliveryDestinationPolicy",
    "logs:GetDeliverySource",
    "logs:ListTagsForResource",
    "logs:PutDeliveryDestinationPolicy",
    "logs:UpdateDeliveryConfiguration",
  ]);
  assert.deepEqual(resources(manageResources), [
    STAGE1_LOG_DELIVERY_SOURCE_ARN,
    STAGE1_LOG_DELIVERY_DESTINATION_ARN,
    STAGE1_LOG_DELIVERY_ARN,
  ]);
  assert.deepEqual(manageResources.Condition, resourceTags);

  const describeDeliveries = statementBySid(
    template,
    "DescribeStage1LogDeliveries",
  );
  assert.deepEqual(actions(describeDeliveries), [
    "logs:DescribeDeliveries",
  ]);
  assert.deepEqual(resources(describeDeliveries), ["*"]);
  assert.deepEqual(describeDeliveries.Condition, {
    StringEquals: { "aws:RequestedRegion": REGION },
  });

  const allowVendedDelivery = statementBySid(
    template,
    "AllowStage1AgentRuntimeVendedLogDelivery",
  );
  assert.deepEqual(actions(allowVendedDelivery), [
    "logs:AllowVendedLogDeliveryForResource",
  ]);
  assert.deepEqual(resources(allowVendedDelivery), ["*"]);
  assert.deepEqual(allowVendedDelivery.Condition, resourceTags);

  const tagResources = statementBySid(
    template,
    "TagStage1LogDeliveryResources",
  );
  assert.deepEqual(actions(tagResources), ["logs:TagResource"]);
  assert.deepEqual(resources(tagResources), [
    STAGE1_LOG_DELIVERY_SOURCE_ARN,
    STAGE1_LOG_DELIVERY_DESTINATION_ARN,
    STAGE1_LOG_DELIVERY_ARN,
  ]);
  assert.deepEqual(tagResources.Condition, requestTags);

  const untagResources = statementBySid(
    template,
    "UntagOptionalStage1LogDeliveryTags",
  );
  assert.deepEqual(actions(untagResources), ["logs:UntagResource"]);
  assert.deepEqual(resources(untagResources), resources(tagResources));
  assert.deepEqual(untagResources.Condition, {
    "ForAllValues:StringNotEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    ...resourceTags,
  });

  const denyMandatoryTagRemoval = statementBySid(
    template,
    "DenyMandatoryStage1LogDeliveryTagRemoval",
  );
  assert.equal(denyMandatoryTagRemoval.Effect, "Deny");
  assert.deepEqual(actions(denyMandatoryTagRemoval), [
    "logs:UntagResource",
  ]);
  assert.deepEqual(
    resources(denyMandatoryTagRemoval),
    resources(tagResources),
  );
  assert.deepEqual(denyMandatoryTagRemoval.Condition, {
    "ForAnyValue:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
  });

  const logsPolicy = statementBySid(
    template,
    "ManageStage1LogsDeliveryResourcePolicy",
  );
  assert.deepEqual(actions(logsPolicy), [
    "logs:DeleteResourcePolicy",
    "logs:DescribeResourcePolicies",
    "logs:PutResourcePolicy",
  ]);
  assert.deepEqual(resources(logsPolicy), ["*"]);
  assert.deepEqual(logsPolicy.Condition, {
    StringEquals: { "aws:RequestedRegion": REGION },
  });

  const xrayPolicy = statementBySid(
    template,
    "ManageStage1XRayDeliveryResourcePolicy",
  );
  assert.deepEqual(actions(xrayPolicy), [
    "xray:DeleteResourcePolicy",
    "xray:ListResourcePolicies",
    "xray:PutResourcePolicy",
  ]);
  assert.deepEqual(resources(xrayPolicy), ["*"]);
  assert.deepEqual(xrayPolicy.Condition, logsPolicy.Condition);

  const transactionSearch = statementBySid(template, "TraceSearchConfiguration");
  assert.deepEqual(actions(transactionSearch), [
    "application-signals:StartDiscovery",
    "xray:GetIndexingRules",
    "xray:GetTraceSegmentDestination",
    "xray:UpdateIndexingRule",
    "xray:UpdateTraceSegmentDestination",
  ]);
  assert.deepEqual(resources(transactionSearch), ["*"]);
  assert.deepEqual(transactionSearch.Condition, logsPolicy.Condition);
  const serviceRole = statementBySid(template, "TraceSearchServiceRole");
  assert.deepEqual(actions(serviceRole), ["iam:CreateServiceLinkedRole"]);
  assert.deepEqual(serviceRole.Condition, {
    StringEquals: {"iam:AWSServiceName": "application-signals.cloudwatch.amazonaws.com"},
  });
  assert.ok(resources(serviceRole).every(resource => String(resource).includes("AWSServiceRoleForCloudWatchApplicationSignals")));
  const traceLogs = statementBySid(template, "TraceSearchLogGroups");
  assert.deepEqual(actions(traceLogs), ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutRetentionPolicy"]);
  assert.equal(resources(traceLogs).length, 2);
  assert.ok(resources(traceLogs).every(resource =>
    String(resource).endsWith(":log-group:aws/spans:*")
    || String(resource).endsWith(":log-group:/aws/application-signals/data:*")));
});

test("Runtime deployment permissions exclude unused network, encryption, invocation, and list capabilities", () => {
  const { template } = fixture();
  const allActions = identityPolicyStatements(template).flatMap(actions);

  for (const excludedAction of [
    "bedrock-agentcore:InvokeAgentRuntime",
    "bedrock-agentcore:ListAgentRuntimeEndpoints",
    "bedrock-agentcore:ListAgentRuntimes",
    "bedrock-agentcore:PassCapacityProvider",
    "ec2:CreateNetworkInterface",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeSubnets",
    "ec2:DescribeVpcs",
    "kms:Decrypt",
    "logs:DescribeDeliveryDestinations",
    "logs:DescribeDeliverySources",
    "vpc-lattice:AssociateViaAWSService",
    "vpc-lattice:CreateServiceNetworkResourceAssociation",
    "vpc-lattice:GetResourceConfiguration",
    "vpc-lattice:GetServiceNetworkResourceAssociation",
    "vpc-lattice:ListServiceNetworkResourceAssociations",
  ]) {
    assert.ok(!allActions.includes(excludedAction), excludedAction);
  }
});

test("GitHub deploy role has only the resource-tag inventory read needed by validation", () => {
  const { template } = fixture();
  const statement = statementBySid(template, "ReadDeployedResourceTags");

  assert.deepEqual(actions(statement), ["tag:GetResources"]);
  assert.deepEqual(resources(statement), ["*"]);
  assert.equal(statement.Condition, undefined);
});

test("GitHub deploy role can read tags only from stack-owned resources unsupported by the tagging API", () => {
  const { template } = fixture();

  const roles = statementBySid(template, "ReadStage1RuntimeRoles");
  assert.deepEqual(actions(roles), ["iam:GetRole", "iam:ListRoleTags"]);
  assert.deepEqual(resources(roles), WEB_MANAGED_ROLE_ARNS);

  const controlPlaneRole = statementBySid(
    template,
    "ReadControlPlaneRoleTags",
  );
  assert.deepEqual(actions(controlPlaneRole), ["iam:ListRoleTags"]);
  assert.deepEqual(resources(controlPlaneRole), [CONTROL_PLANE_ROLE_ARN]);

  const dashboard = statementBySid(
    template,
    "ReadDeployedDashboardTags",
  );
  assert.deepEqual(actions(dashboard), [
    "cloudwatch:ListTagsForResource",
  ]);
  assert.deepEqual(resources(dashboard), [
    `arn:<AWS::Partition>:cloudwatch::${ACCOUNT}:`
      + "dashboard/AgenticPlatform-WebIdentity",
  ]);

  const registries = statementBySid(
    template,
    "ReadControlPlaneRegistryTags",
  );
  assert.deepEqual(actions(registries), [
    "agent-registry:ListTagsForResource",
  ]);
  assert.deepEqual(resources(registries), CONTROL_PLANE_REGISTRY_ARNS);

  const gateways = statementBySid(
    template,
    "ReadControlPlaneGatewayTags",
  );
  assert.deepEqual(actions(gateways), [
    "bedrock-agentcore:ListTagsForResource",
  ]);
  assert.deepEqual(resources(gateways), [CONTROL_PLANE_GATEWAY_ARN]);

  const runtimeResources = statementBySid(
    template,
    "ReadStage1AgentRuntimeTags",
  );
  assert.deepEqual(actions(runtimeResources), [
    "bedrock-agentcore:ListTagsForResource",
  ]);
  assert.deepEqual(resources(runtimeResources), [
    STAGE1_AGENT_RUNTIME_ARN,
    STAGE1_AGENT_RUNTIME_ENDPOINT_ARN,
  ]);

  const logDeliveryResources = statementBySid(
    template,
    "ReadStage1LogDeliveryTags",
  );
  assert.deepEqual(actions(logDeliveryResources), [
    "logs:ListTagsForResource",
  ]);
  assert.deepEqual(resources(logDeliveryResources), [
    STAGE1_LOG_DELIVERY_SOURCE_ARN,
    STAGE1_LOG_DELIVERY_DESTINATION_ARN,
    STAGE1_LOG_DELIVERY_ARN,
  ]);
});

test("execution role manages async invoke retry configuration only on Stage 1 functions", () => {
  const { template } = fixture();
  const statement = statementBySid(
    template,
    "ManageStage1LambdaAsyncInvoke",
  );

  assert.deepEqual(actions(statement), [
    "lambda:DeleteFunctionEventInvokeConfig",
    "lambda:GetFunctionEventInvokeConfig",
    "lambda:PutFunctionEventInvokeConfig",
  ]);
  assert.deepEqual(resources(statement), [
    `arn:<AWS::Partition>:lambda:${REGION}:${ACCOUNT}:`
      + "function:AgenticPlatform-Web-*",
  ]);
});

test("CreateBucket is scoped to the Stage 1 bucket-name boundary", () => {
  const { template } = fixture();
  const genericActions = actions(
    statementBySid(template, "CreateStage1Resources"),
  );
  const s3Statement = statementBySid(template, "ManageStage1S3Buckets");

  assert.ok(!genericActions.includes("s3:CreateBucket"));
  assert.ok(actions(s3Statement).includes("s3:CreateBucket"));
  assert.deepEqual(resources(s3Statement), [
    "arn:<AWS::Partition>:s3:::agenticplatform-web-*",
    "arn:<AWS::Partition>:s3:::agenticplatform-web-*/*",
  ]);
});

test("CloudWatch deployment permissions are limited to the exact dashboard and alarm", () => {
  const { template } = fixture();
  const genericActions = actions(
    statementBySid(template, "CreateStage1Resources"),
  );
  for (const action of [
    "cloudwatch:DeleteDashboards",
    "cloudwatch:GetDashboard",
    "cloudwatch:PutDashboard",
  ]) {
    assert.ok(!genericActions.includes(action), action);
  }

  const dashboard = statementBySid(template, "ManageStage1Dashboard");
  assert.deepEqual(actions(dashboard), [
    "cloudwatch:DeleteDashboards",
    "cloudwatch:GetDashboard",
    "cloudwatch:PutDashboard",
  ]);
  assert.deepEqual(resources(dashboard), [
    `arn:<AWS::Partition>:cloudwatch::${ACCOUNT}:`
      + "dashboard/AgenticPlatform-WebIdentity",
  ]);

  const alarm = statementBySid(
    template,
    "ManageStage1CloudWatchAlarm",
  );
  assert.deepEqual(actions(alarm), [
    "cloudwatch:DeleteAlarms",
    "cloudwatch:DescribeAlarms",
    "cloudwatch:ListTagsForResource",
    "cloudwatch:PutMetricAlarm",
    "cloudwatch:TagResource",
    "cloudwatch:UntagResource",
  ]);
  assert.deepEqual(resources(alarm), [
    `arn:<AWS::Partition>:cloudwatch:${REGION}:${ACCOUNT}:`
      + "alarm:AgenticPlatform-IdentityApi-Errors",
  ]);
});

test("execution role excludes obsolete API Gateway log-delivery calls", () => {
  const { template } = fixture();
  const allActions = identityPolicyStatements(template)
    .flatMap(actions);

  for (const excludedAction of [
    "logs:CreateLogDelivery",
    "logs:DeleteLogDelivery",
    "logs:GetLogDelivery",
    "logs:UpdateLogDelivery",
  ]) {
    assert.ok(!allActions.includes(excludedAction), excludedAction);
  }
});

test("GitHub deployment role can update termination protection only on named stacks", () => {
  const { template } = fixture();
  const statement = statementBySid(
    template,
    "ManageAgenticPlatformWebStack",
  );

  assert.ok(
    actions(statement).includes(
      "cloudformation:UpdateTerminationProtection",
    ),
  );
  assert.deepEqual(resources(statement), DEPLOYED_STACK_RESOURCES);
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": "cdk",
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
    },
  });
});

test("GitHub deployment role can perform only the read calls required by the repository audit", () => {
  const { template } = fixture();

  assert.deepEqual(
    actions(statementBySid(template, "ListGitHubOidcProviders")),
    ["iam:ListOpenIDConnectProviders"],
  );
  assert.deepEqual(
    resources(statementBySid(template, "ListGitHubOidcProviders")),
    ["*"],
  );
  assert.deepEqual(
    actions(statementBySid(template, "ReadGitHubOidcProvider")),
    ["iam:GetOpenIDConnectProvider"],
  );
  assert.deepEqual(
    resources(statementBySid(template, "ReadGitHubOidcProvider")),
    [
      `arn:<AWS::Partition>:iam::${ACCOUNT}:`
        + "oidc-provider/token.actions.githubusercontent.com*",
    ],
  );
  assert.deepEqual(
    actions(statementBySid(template, "ReadCdkToolkitStack")),
    ["cloudformation:DescribeStacks"],
  );
  assert.deepEqual(
    resources(statementBySid(template, "ReadCdkToolkitStack")),
    [
      `arn:<AWS::Partition>:cloudformation:${REGION}:${ACCOUNT}:`
        + "stack/CDKToolkit/*",
    ],
  );
  assert.deepEqual(
    actions(statementBySid(template, "ReadRuntimeBoundaryPolicy")),
    ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyTags"],
  );
  assert.deepEqual(
    resources(statementBySid(template, "ReadRuntimeBoundaryPolicy")),
    [BOUNDARY_ARN],
  );
});

test("execution role can create the tagged CloudFront distribution", () => {
  const { template } = fixture();
  const statement = identityPolicyStatements(template).find((candidate) =>
    actions(candidate).includes("cloudfront:CreateDistribution")
  );
  assert.ok(statement);

  assert.ok(actions(statement).includes("cloudfront:CreateDistribution"));
  assert.ok(!actions(statement).includes("cloudfront:CreateDistributionWithTags"));
  assert.deepEqual(resources(statement), ["*"]);
  assert.deepEqual(statement.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
    },
  });
  const allActions = identityPolicyStatements(template).flatMap(actions);
  assert.ok(allActions.includes("cloudfront:TagResource"));
  assert.ok(!allActions.includes("cloudfront:CreateDistributionWithTags"));
});

test("deploy permissions stay within named stacks, regional assets, metadata, and user pools", () => {
  const { template } = fixture();

  const stackStatements = [
    "CreateOrUpdateAgenticPlatformWebStack",
    "ExecuteOrDeleteAgenticPlatformWebChangeSet",
    "ManageAgenticPlatformWebStack",
    "ReadAgenticPlatformWebStack",
  ].map((sid) => statementBySid(template, sid));
  assert.deepEqual(
    [...new Set(stackStatements.flatMap(actions))].sort(),
    [
      "cloudformation:CreateChangeSet",
      "cloudformation:CreateStack",
      "cloudformation:DeleteChangeSet",
      "cloudformation:DescribeChangeSet",
      "cloudformation:DescribeStackEvents",
      "cloudformation:DescribeStackResources",
      "cloudformation:DescribeStacks",
      "cloudformation:ExecuteChangeSet",
      "cloudformation:GetTemplate",
      "cloudformation:ListStackResources",
      "cloudformation:UpdateStack",
      "cloudformation:UpdateTerminationProtection",
    ],
  );
  for (const statement of stackStatements) {
    assert.deepEqual(resources(statement), DEPLOYED_STACK_RESOURCES);
  }
  assert.deepEqual(
    statementBySid(
      template,
      "CreateOrUpdateAgenticPlatformWebStack",
    ).Condition,
    {
      "ForAllValues:StringEquals": {
        "aws:TagKeys": ["auto-delete", "managedBy", "project"],
      },
      StringEquals: {
        "aws:RequestTag/auto-delete": "no",
        "aws:RequestTag/managedBy": "cdk",
        "aws:RequestTag/project": "agentic-ai-platform-demo",
      },
    },
  );
  assert.deepEqual(
    resources(statementBySid(template, "UseCdkBootstrapBucket")),
    [
      `arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${ACCOUNT}-${REGION}`,
      `arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${ACCOUNT}-${REGION}/*`,
    ],
  );
  assert.deepEqual(
    resources(statementBySid(template, "ReadCdkBootstrapVersion")),
    [
      `arn:<AWS::Partition>:ssm:${REGION}:${ACCOUNT}:parameter/cdk-bootstrap/hnb659fds/version`,
    ],
  );
});

test("tag conditions are attached only to supported create and mutable resource actions", () => {
  const { template } = fixture();
  const requiredResourceTags = {
    "aws:ResourceTag/auto-delete": "no",
    "aws:ResourceTag/managedBy": "cdk",
    "aws:ResourceTag/project": "agentic-ai-platform-demo",
  };
  const resourceTaggedActionSets = [
    ["cloudfront:DeleteDistribution", "cloudfront:UpdateDistribution"],
    [
      "cognito-idp:CreateGroup",
      "cognito-idp:CreateUserPoolClient",
      "cognito-idp:CreateUserPoolDomain",
      "cognito-idp:DeleteGroup",
      "cognito-idp:DeleteUserPool",
      "cognito-idp:DeleteUserPoolClient",
      "cognito-idp:DeleteUserPoolDomain",
      "cognito-idp:SetUserPoolMfaConfig",
      "cognito-idp:UpdateGroup",
      "cognito-idp:UpdateUserPool",
      "cognito-idp:UpdateUserPoolClient",
    ],
    ["apigateway:DELETE", "apigateway:PATCH", "apigateway:POST"],
  ];
  for (const requiredActions of resourceTaggedActionSets) {
    const statement = identityPolicyStatements(template).find((candidate) =>
      requiredActions.every((action) => actions(candidate).includes(action))
    );
    assert.ok(statement, requiredActions.join(","));
    assert.deepEqual(
      statement.Condition?.StringEquals,
      requiredResourceTags,
      statement.Sid,
    );
  }

  const apiCreate = identityPolicyStatements(template).find((statement) =>
    actions(statement).includes("apigateway:POST")
    && resources(statement).length === 1
    && resources(statement)[0].endsWith("::/apis")
  );
  assert.ok(apiCreate);
  assert.deepEqual(apiCreate.Condition, {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": "cdk",
      "aws:RequestTag/project": "agentic-ai-platform-demo",
    },
  });

  const unconditionedReadActions = new Set([
    "apigateway:GET",
    "cloudfront:GetDistribution",
    "cloudfront:GetDistributionConfig",
    "cognito-idp:DescribeUserPool",
    "cognito-idp:ListTagsForResource",
  ]);
  for (const statement of identityPolicyStatements(template)) {
    if (actions(statement).some((action) =>
      unconditionedReadActions.has(action)
    )) {
      assert.equal(statement.Condition, undefined, statement.Sid);
    }
  }
});

test("every managed role and created provider has exactly the mandatory tags", () => {
  const { template } = fixture();
  const taggableResources = [
    ...resourceEntries(template, "AWS::IAM::Role"),
    ...resourceEntries(template, "AWS::IAM::OIDCProvider"),
    ...resourceEntries(template, "AWS::Lambda::Function"),
    ...resourceEntries(template, "AWS::Logs::LogGroup"),
  ];
  assert.equal(taggableResources.length, 15);
  for (const [logicalId, resource] of taggableResources) {
    assert.deepEqual(
      normalizedTags(resource),
      EXPECTED_TAGS,
      `${logicalId} exact tags`,
    );
  }
});

test("bootstrap reconciles exact mandatory tags on its customer-managed policies", () => {
  const { template } = fixture();
  const managedPolicies = resourceEntries(
    template,
    "AWS::IAM::ManagedPolicy",
  );
  assert.deepEqual(
    managedPolicies
      .map(([, policy]) => policy.Properties?.ManagedPolicyName)
      .sort(),
    [
      "AgenticPlatform-GitHubBootstrap-AgentRuntimeDeployment",
      "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment",
      "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment",
      "AgenticPlatform-GitHubBootstrap-ControlPlaneDeploymentValidation",
      "AgenticPlatform-GitHubBootstrap-ControlPlaneGatewayDeployment",
      "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment",
      "AgenticPlatform-GitHubBootstrap-DeploymentValidation",
      "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleBoundary",
      "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleDelegation",
      "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleManagement",
    ],
  );

  const tagResources = resourceEntries(
    template,
    "Custom::ManagedPolicyTags",
  );
  assert.equal(tagResources.length, managedPolicies.length);
  for (const [policyLogicalId] of managedPolicies) {
    const matchingTagResource = tagResources.find(([, resource]) =>
      resource.Properties?.PolicyArn?.Ref === policyLogicalId
    );
    assert.ok(matchingTagResource, `missing tags for ${policyLogicalId}`);
    assert.deepEqual(
      Object.fromEntries(
        matchingTagResource[1].Properties?.RequiredTags.map(
          (tag: { Key: string; Value: string }) => [tag.Key, tag.Value],
        ),
      ),
      EXPECTED_TAGS,
    );
  }

  const providerStatement = identityPolicyStatements(template).find(
    (statement) =>
      actions(statement).includes("iam:ListPolicyTags")
      && actions(statement).includes("iam:TagPolicy")
      && actions(statement).includes("iam:UntagPolicy")
      && resources(statement).length === managedPolicies.length,
  );
  assert.ok(providerStatement);
  assert.deepEqual(resources(providerStatement).sort(), [
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-AgentRuntimeDeployment",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-ControlPlaneDeploymentValidation",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-ControlPlaneGatewayDeployment",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-DeploymentValidation",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleBoundary",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleDelegation",
    `arn:<AWS::Partition>:iam::${ACCOUNT}:policy/`
      + "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleManagement",
  ]);
});

test("the CDK app gates GitHub bootstrap on explicit enablement and protected-main attestation", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "bin", "app.ts"),
    "utf8",
  );
  const normalizedSource = source.replace(/\s+/g, " ");

  for (const expected of [
    'tryGetContext("account")',
    'tryGetContext("region")',
    'tryGetContext("repository")',
    'tryGetContext("enableGitHubDeployment")',
    'tryGetContext("branchProtectionAttested")',
    'tryGetContext("repositoryId")',
    'tryGetContext("repositoryOwnerId")',
    'tryGetContext("workflowRef")',
    'tryGetContext("githubOidcSubjectMode")',
    'tryGetContext("githubOidcSubject")',
    'tryGetContext("cognitoDomainPrefix")',
    'tryGetContext("starterBuilderModelId")',
    'tryGetContext("llmGatewayId")',
    'tryGetContext("llmGatewayRegion")',
    'tryGetContext("githubOidcProviderArn")',
    "process.env.CDK_DEFAULT_ACCOUNT",
    "DEFAULT_REGION",
    "region !== DEFAULT_REGION",
    "region must be exactly ${DEFAULT_REGION}",
    "`agentic-platform-${account}`",
    "enableGitHubDeployment && !branchProtectionAttested",
    "if (enableGitHubDeployment)",
    'new GitHubBootstrapStack(app, "GitHubBootstrapStack"',
    "branchProtectionAttested: true",
    'new PlatformWebStack(app, "PlatformWebStack"',
    "new cdk.CliCredentialsStackSynthesizer()",
    "cdk.Validations.of(app).addPlugins("
      + "new AwsSolutionsChecks(app, { verbose: true }))",
  ]) {
    assert.ok(normalizedSource.includes(expected), expected);
  }
  assert.match(
    source,
    /const starterBuilderModelId = requiredContext\(\s*context,\s*"starterBuilderModelId",?\s*\);/,
  );
  assert.match(
    source,
    /const llmGatewayId = requiredContext\(\s*context,\s*"llmGatewayId",?\s*\);/,
  );
  assert.match(
    source,
    /const llmGatewayRegion = requiredContext\(\s*context,\s*"llmGatewayRegion",?\s*\);/,
  );
  assert.match(
    source,
    /const platformWebStackProps = \{[\s\S]+starterBuilderModelId,\s*[\s\S]+llmGatewayId,\s*[\s\S]+llmGatewayRegion,\s*[\s\S]+synthesizer:/,
  );
  assert.match(
    source,
    /new PlatformWebStack\(\s*app,\s*"PlatformWebStack",\s*platformWebStackProps,?\s*\);/,
  );
  assert.ok(!normalizedSource.includes("process.env.CDK_DEFAULT_REGION"));
});

test("AwsSolutions checks have zero unexplained findings", () => {
  const app = new cdk.App();
  const stack = new GitHubBootstrapStack(app, "NagBootstrap", {
    env: { account: ACCOUNT, region: REGION },
    repository: REPOSITORY,
    branchProtectionAttested: true,
    ...GITHUB_DEPLOYMENT_METADATA,
  });
  assert.doesNotThrow(() => app.synth());
  const report = new AwsSolutionsChecks(undefined, {
    verbose: true,
  }).validateScope(stack);
  assert.equal(report.success, true, JSON.stringify(report.violations, null, 2));
  assert.deepEqual(report.violations, []);
});
