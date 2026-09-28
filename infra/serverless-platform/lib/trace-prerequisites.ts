import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import * as xray from "aws-cdk-lib/aws-xray";

/** AgentCore trace deliveries require the regional CloudWatch Logs destination. */
export function addTracePrerequisites(stack: cdk.Stack): xray.CfnTransactionSearchConfig {
  const policy = new logs.CfnResourcePolicy(stack, "TransactionSearchLogsPolicy", {
    policyName: cdk.Fn.join("", [
      "agentic-platform-traces-",
      cdk.Fn.select(2, cdk.Fn.split("/", stack.stackId)),
    ]),
    policyDocument: stack.toJsonString({
      Version: "2012-10-17",
      Statement: [{
        Sid: "TransactionSearchXRayAccess",
        Effect: "Allow",
        Principal: {Service: "xray.amazonaws.com"},
        Action: "logs:PutLogEvents",
        Resource: [
          stack.formatArn({service: "logs", resource: "log-group", resourceName: "aws/spans:*", arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME}),
          stack.formatArn({service: "logs", resource: "log-group", resourceName: "/aws/application-signals/data:*", arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME}),
        ],
        Condition: {
          StringEquals: {"aws:SourceAccount": stack.account},
          ArnLike: {"aws:SourceArn": stack.formatArn({service: "xray", resource: "*"})},
        },
      }],
    }),
  });
  const config = new xray.CfnTransactionSearchConfig(stack, "TransactionSearch", {
    indexingPercentage: 1,
  });
  config.addDependency(policy);
  // This destination is regional and may also serve other applications.
  // Removing a demo must not disable their trace ingestion.
  policy.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  config.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  return config;
}
