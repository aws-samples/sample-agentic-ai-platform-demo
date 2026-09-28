import test from "node:test";
import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {Template} from "aws-cdk-lib/assertions";
import {lambdaReservedConcurrency} from "../lib/lambda-concurrency";

test("demo Lambda template omits reservations by default; reserved mode is explicit", () => {
  for (const mode of [undefined, "shared", "reserved"]) {
    const app = new cdk.App({context: mode ? {lambdaConcurrencyMode: mode} : {}});
    const stack = new cdk.Stack(app, "CapacityTest");
    new lambda.Function(stack, "Api", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => ({statusCode: 200});"),
      reservedConcurrentExecutions: lambdaReservedConcurrency(stack, 10),
    });
    const functions = Template.fromStack(stack).findResources("AWS::Lambda::Function");
    const fn = Object.values(functions)[0] as {Properties: Record<string, unknown>};
    assert.equal(fn.Properties.ReservedConcurrentExecutions, mode === "reserved" ? 10 : undefined);
  }
});

test("unknown concurrency modes fail instead of silently changing capacity", () => {
  const app = new cdk.App({context: {lambdaConcurrencyMode: "automatic"}});
  assert.throws(() => lambdaReservedConcurrency(app, 10), /shared or reserved/);
});
