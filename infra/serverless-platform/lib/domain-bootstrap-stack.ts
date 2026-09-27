import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";

export interface DomainBootstrapTarget {
  accountId: string; region: string; apiId: string; authorizerId: string;
  tableName: string; userPoolId: string; catalogRoleArn: string; functions: { admin: string; catalog: string };
}
export class DomainBootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, target: DomainBootstrapTarget) {
    super(scope, id, { stackName: "AgenticPlatform-DomainBootstrap",
      env: { account: target.accountId, region: target.region }, terminationProtection: true });
    for (const [key, value] of Object.entries({ "auto-delete": "no", project: "agentic-ai-platform-demo", managedBy: "cdk" })) {
      cdk.Tags.of(this).add(key, value);
    }
    const arn = (service: string, resource: string) => this.formatArn({ service, resource });
    const tableArn = arn("dynamodb", `table/${target.tableName}`);
    const poolArn = arn("cognito-idp", `userpool/${target.userPoolId}`);
    // Add the new policy read without redeploying the shared Web stack.
    const catalogRole = iam.Role.fromRoleArn(this, "CatalogRole", target.catalogRoleArn);
    catalogRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"], resources: [tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["GRANT#*"] } },
    }));
    const domainRoleArn = arn("iam", "role/AgenticPlatform-Domain-*").replace(`:${this.region}:`, "::");
    const logResource = arn("logs", "log-group:/agentic-platform/domains/*");
    const boundary = new iam.ManagedPolicy(this, "DomainRuntimeBoundary", {
      managedPolicyName: "AgenticPlatform-DomainBootstrap-RuntimeBoundary",
      statements: [
        new iam.PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logResource] }),
        new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"],
          conditions: { StringLike: { "cloudwatch:namespace": "AgenticPlatform/Domain/*" } } }),
      ],
    });
    const execution = new iam.Role(this, "EnvironmentExecutionRole", {
      roleName: "AgenticPlatform-DomainBootstrap-EnvironmentExecution",
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
    });
    execution.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"],
      resources: [domainRoleArn], conditions: { StringEquals: { "iam:PermissionsBoundary": boundary.managedPolicyArn } },
    }));
    execution.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:GetRole", "iam:TagRole", "iam:UntagRole", "iam:PutRolePolicy", "iam:GetRolePolicy",
        "iam:DeleteRolePolicy", "iam:DeleteRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"],
      resources: [domainRoleArn],
    }));
    execution.addToPolicy(new iam.PolicyStatement({ actions: [
      "logs:CreateLogGroup", "logs:PutRetentionPolicy", "logs:DescribeLogStreams", "logs:TagResource",
      "logs:UntagResource", "logs:ListTagsForResource", "logs:TagLogGroup", "logs:ListTagsLogGroup",
    ], resources: [logResource] }));
    execution.addToPolicy(new iam.PolicyStatement({ actions: ["logs:DescribeLogGroups"], resources: ["*"] }));
    const logGroup = new logs.LogGroup(this, "ApiLogs", {
      logGroupName: "/agentic-platform/domain-bootstrap", retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const role = new iam.Role(this, "ApiRole", {
      roleName: "AgenticPlatform-DomainBootstrap-Api",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    const statements = [
      new iam.PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [`${logGroup.logGroupArn}:*`] }),
      new iam.PolicyStatement({ actions: ["dynamodb:GetItem", "dynamodb:Query"], resources: [tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DOMAIN", "DOMAIN_BOOTSTRAP#*",
          "MODEL_POLICY", "MUTATION#*", "GRANT#*"] } } }),
      new iam.PolicyStatement({ actions: ["dynamodb:PutItem", "dynamodb:TransactWriteItems"], resources: [tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DOMAIN_BOOTSTRAP#*",
          "MODEL_POLICY", "MODEL_POLICY_AUDIT#*", "MUTATION#*", "GRANT#*", "AUDIT#grant/*"] } } }),
      new iam.PolicyStatement({ actions: ["cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:ListUsers", "cognito-idp:AdminAddUserToGroup"], resources: [poolArn] }),
      new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"],
        resources: Object.values(target.functions).map(name => arn("lambda", `function:${name}`)) }),
      new iam.PolicyStatement({ actions: ["cloudformation:CreateStack", "cloudformation:DescribeStacks"],
        resources: [arn("cloudformation", "stack/AgenticPlatform-Domain-*/*")] }),
      new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: [execution.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } } }),
    ];
    // Bound the API's effective permissions to its exact operations and targets.
    const apiBoundary = new iam.ManagedPolicy(this, "ApiBoundary", {
      managedPolicyName: "AgenticPlatform-DomainBootstrap-ApiBoundary", statements,
    });
    iam.PermissionsBoundary.of(role).apply(apiBoundary);
    statements.forEach(statement => role.addToPolicy(statement));
    const fn = new nodejs.NodejsFunction(this, "Api", {
      functionName: "AgenticPlatform-DomainBootstrap-Api",
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "../lambda/domain-bootstrap/runtime.mjs"),
      handler: "handler", memorySize: 512, timeout: cdk.Duration.seconds(90),
      reservedConcurrentExecutions: 5, logGroup, role,
      depsLockFilePath: path.join(__dirname, "../package-lock.json"),
      bundling: { externalModules: ["@aws-sdk/*"] },
      environment: {
        PLATFORM_ACCOUNT_ID: target.accountId, PLATFORM_STATE_TABLE_NAME: target.tableName,
        COGNITO_USER_POOL_ID: target.userPoolId, PLATFORM_FUNCTIONS: JSON.stringify(target.functions),
        DOMAIN_RUNTIME_BOUNDARY_ARN: boundary.managedPolicyArn,
        ENVIRONMENT_EXECUTION_ROLE_ARN: execution.roleArn,
      },
    });
    const workflowRole = new iam.Role(this, "WorkflowRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
    });
    fn.grantInvoke(workflowRole);
    const stepIds = ["registry", "domain", "identity", "model", "environments", "verify"];
    const states: Record<string, unknown> = {};
    stepIds.forEach((step, index) => {
      states[step] = {
        Type: "Task", Resource: "arn:aws:states:::lambda:invoke",
        Parameters: { FunctionName: fn.functionArn, Payload: {
          worker: true, step, "domainId.$": "$.domainId", "attempt.$": "$.attempt",
        } }, ResultPath: null,
        Retry: ["domain", "environments"].includes(step) ? [{ ErrorEquals: ["FoundationInProgress"],
          IntervalSeconds: 10, BackoffRate: 1, MaxAttempts: step === "domain" ? 12 : 60 }] : [],
        Catch: [{ ErrorEquals: ["States.ALL"], ResultPath: "$.error", Next: "recordFailure" }],
        ...(index === stepIds.length - 1 ? { End: true } : { Next: stepIds[index + 1] }),
      };
    });
    states.recordFailure = { Type: "Task", Resource: "arn:aws:states:::lambda:invoke",
      Parameters: { FunctionName: fn.functionArn, Payload: { worker: true, step: "failure",
        "domainId.$": "$.domainId", "attempt.$": "$.attempt" } }, ResultPath: null, Next: "failed" };
    states.failed = { Type: "Fail", Error: "DomainBootstrapFailed" };
    const workflow = new sfn.CfnStateMachine(this, "Workflow", {
      stateMachineName: "AgenticPlatform-DomainBootstrap",
      roleArn: workflowRole.roleArn,
      definitionString: this.toJsonString({ StartAt: "registry", TimeoutSeconds: 1800, States: states }),
    });
    // The name is deterministic to avoid Lambda environment → workflow → Lambda cycles.
    const workflowArn = arn("states", "stateMachine:AgenticPlatform-DomainBootstrap");
    fn.addEnvironment("STATE_MACHINE_ARN", workflowArn);
    const start = new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: [workflowArn] });
    role.addToPolicy(start); apiBoundary.addStatements(start);
    const integration = new apigateway.CfnIntegration(this, "Integration", {
      apiId: target.apiId, integrationType: "AWS_PROXY", integrationUri: fn.functionArn,
      payloadFormatVersion: "2.0", timeoutInMillis: 30_000,
    });
    for (const [index, routeKey] of [
      "GET /api/domain-bootstrap/catalog", "GET /api/domain-bootstrap",
      "POST /api/domain-bootstrap/preview", "POST /api/domain-bootstrap",
      "POST /api/domain-bootstrap/retry",
    ].entries()) {
      new apigateway.CfnRoute(this, `Route${index}`, {
        apiId: target.apiId, routeKey, authorizationType: "JWT",
        authorizerId: target.authorizerId, target: `integrations/${integration.ref}`,
      });
    }
    fn.addPermission("ApiInvoke", { principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: arn("execute-api", `${target.apiId}/*/*/api/domain-bootstrap*`) });
    new cdk.CfnOutput(this, "WorkflowArn", { value: workflow.ref });
    new cdk.CfnOutput(this, "ApiFunctionName", { value: fn.functionName });
  }
}
