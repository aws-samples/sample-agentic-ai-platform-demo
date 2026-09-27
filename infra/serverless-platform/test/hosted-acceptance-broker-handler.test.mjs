import assert from "node:assert/strict";
import test from "node:test";
import {
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

const OPERATIONS = [
  "persistActorMapping",
  "recoverActorMapping",
  "createRegistryFixture",
  "recoverRegistryFixture",
  "recoverDomain",
  "provisionExperienceFixture",
  "recoverExperienceFixture",
  "cleanupExperienceFixture",
  "persistPersonaJourneyFixture",
  "cleanupPersonaJourneyFixture",
  "cleanupAgentBuildingJourneyFixtures",
  "cleanupExactResources",
];

async function loadBroker() {
  return import("../lambda/hosted-acceptance-broker/index.mjs");
}

test("broker handler permits only the exact operation allowlist", async () => {
  const { createHostedAcceptanceBrokerHandler } = await loadBroker();
  const calls = [];
  const service = Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      async (input) => {
        calls.push([operation, input]);
        return { operation };
      },
    ]),
  );
  const handler = createHostedAcceptanceBrokerHandler({ service });

  for (const operation of OPERATIONS) {
    assert.deepEqual(
      await handler({ operation, input: { marker: operation } }),
      { ok: true, result: { operation } },
    );
  }
  assert.deepEqual(
    calls,
    OPERATIONS.map((operation) => [
      operation,
      { marker: operation },
    ]),
  );
});

test("broker handler rejects malformed and unsupported requests before service access", async () => {
  const { createHostedAcceptanceBrokerHandler } = await loadBroker();
  let calls = 0;
  const service = Object.fromEntries(
    OPERATIONS.map((operation) => [
      operation,
      async () => {
        calls += 1;
        return {};
      },
    ]),
  );
  const handler = createHostedAcceptanceBrokerHandler({ service });

  for (const event of [
    null,
    [],
    {},
    { operation: "unknown", input: {} },
    { operation: "recoverDomain" },
    { operation: "recoverDomain", input: [], extra: true },
  ]) {
    assert.deepEqual(await handler(event), {
      ok: false,
      code: "HOSTED_ACCEPTANCE_BROKER_INVALID_REQUEST",
      message: "Hosted acceptance broker request is invalid.",
      retryable: false,
    });
  }
  assert.equal(calls, 0);
});

test("broker handler returns bounded stable failures without leaking service errors", async () => {
  const { createHostedAcceptanceBrokerHandler } = await loadBroker();
  const secret = "never-return-this-service-detail";
  const logs = [];
  const handler = createHostedAcceptanceBrokerHandler({
    service: Object.fromEntries(
      OPERATIONS.map((operation) => [
        operation,
        async () => {
          const error = new Error(
            `User: ${secret} is not authorized to perform: `
              + "agent-registry:TagResource on resource: "
              + "arn:aws:agent-registry:us-west-2:123456789012:"
              + `registry/${secret} because no identity-based policy allows the `
              + "agent-registry:TagResource action",
          );
          error.name = "AccessDeniedException";
          error.code = "AccessDeniedException";
          error.$metadata = { httpStatusCode: 403 };
          throw error;
        },
      ]),
    ),
    logger: { error(entry) { logs.push(entry); } },
  });

  const response = await handler({
    operation: "cleanupExactResources",
    input: {},
  });
  assert.deepEqual(response, {
    ok: false,
    code: "HOSTED_ACCEPTANCE_BROKER_FAILED",
    message: "Hosted acceptance broker operation failed.",
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(response), new RegExp(secret));
  assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 1024);
  assert.deepEqual(logs, [{
    authorizationReason: "identity-policy",
    code: "HOSTED_ACCEPTANCE_BROKER_FAILED",
    deniedAction: "agent-registry:TagResource",
    deniedResourceKind: "registry",
    errorCode: "AccessDeniedException",
    errorName: "AccessDeniedException",
    httpStatusCode: 403,
    operation: "cleanupExactResources",
  }]);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(secret));
});

test("broker handler safely identifies denied broker runtime actions", async () => {
  const { createHostedAcceptanceBrokerHandler } = await loadBroker();
  const logs = [];
  const handler = createHostedAcceptanceBrokerHandler({
    service: {
      async provisionExperienceFixture() {
        const error = new Error(
          "User is not authorized to perform: "
            + "bedrock-agentcore:GetAgentRuntimeEndpoint on resource: "
            + "arn:aws:bedrock-agentcore:us-west-2:123456789012:"
            + "runtime/example/runtime-endpoint/Production because no "
            + "identity-based policy allows the action",
        );
        error.name = "AccessDeniedException";
        error.code = "AccessDeniedException";
        error.$metadata = { httpStatusCode: 400 };
        throw error;
      },
    },
    logger: { error(entry) { logs.push(entry); } },
  });

  assert.equal(
    (await handler({
      operation: "provisionExperienceFixture",
      input: {},
    })).ok,
    false,
  );
  assert.deepEqual(logs, [{
    authorizationReason: "identity-policy",
    code: "HOSTED_ACCEPTANCE_BROKER_FAILED",
    deniedAction: "bedrock-agentcore:GetAgentRuntimeEndpoint",
    errorCode: "AccessDeniedException",
    errorName: "AccessDeniedException",
    httpStatusCode: 400,
    operation: "provisionExperienceFixture",
  }]);
});

test("broker handler safely identifies only the Cognito group cleanup actions", async () => {
  const { createHostedAcceptanceBrokerHandler } = await loadBroker();
  for (const deniedAction of [
    "cognito-idp:GetGroup",
    "cognito-idp:ListUsersInGroup",
    "cognito-idp:DeleteGroup",
  ]) {
    const logs = [];
    const handler = createHostedAcceptanceBrokerHandler({
      service: {
        async cleanupExactResources() {
          const error = new Error(
            `User is not authorized to perform: ${deniedAction} `
              + "on resource: arn:aws:cognito-idp:us-west-2:"
              + "111122223333:userpool/us-west-2_Example123 because no "
              + "identity-based policy allows the action",
          );
          error.name = "AccessDeniedException";
          error.code = "AccessDeniedException";
          error.$metadata = { httpStatusCode: 400 };
          throw error;
        },
      },
      logger: { error(entry) { logs.push(entry); } },
    });

    assert.equal(
      (await handler({
        operation: "cleanupExactResources",
        input: {},
      })).ok,
      false,
    );
    assert.deepEqual(logs, [{
      authorizationReason: "identity-policy",
      code: "HOSTED_ACCEPTANCE_BROKER_FAILED",
      deniedAction,
      errorCode: "AccessDeniedException",
      errorName: "AccessDeniedException",
      httpStatusCode: 400,
      operation: "cleanupExactResources",
    }]);
  }
});

test("production Cognito directory requires a commercial pool in the configured region", async () => {
  const { createProductionDomainDirectory } = await loadBroker();
  assert.equal(typeof createProductionDomainDirectory, "function");
  if (typeof createProductionDomainDirectory !== "function") return;
  const cognito = { async send() {} };

  for (const configuration of [
    {},
    { cognito, region: "us-west-2" },
    {
      cognito,
      region: "us-west-2",
      userPoolId: "eu-west-1_Example123",
    },
    {
      cognito,
      region: "US-WEST-2",
      userPoolId: "us-west-2_Example123",
    },
  ]) {
    assert.throws(
      () => createProductionDomainDirectory(configuration),
      /configuration is invalid/i,
    );
  }

  assert.equal(
    typeof createProductionDomainDirectory({
      cognito,
      region: "us-west-2",
      userPoolId: "us-west-2_Example123",
    }).deleteGroupExact,
    "function",
  );
});

test("broker handler omits unrecognized or unsafe error classifications", async () => {
  const { createHostedAcceptanceBrokerHandler } = await loadBroker();
  for (const [errorCode, errorName] of [
    ["AccessDeniedException\nprivate", "Access Denied Exception"],
    ["AccessDeniedException!", "AccessDeniedException/private"],
    ["PrivateClassification", "PrivateErrorName"],
  ]) {
    const logs = [];
    const handler = createHostedAcceptanceBrokerHandler({
      service: {
        async cleanupExactResources() {
          const error = new Error("private detail");
          error.code = errorCode;
          error.name = errorName;
          throw error;
        },
      },
      logger: { error(entry) { logs.push(entry); } },
    });

    assert.equal(
      (await handler({
        operation: "cleanupExactResources",
        input: {},
      })).ok,
      false,
    );
    assert.deepEqual(logs, [{
      code: "HOSTED_ACCEPTANCE_BROKER_FAILED",
      operation: "cleanupExactResources",
    }]);
  }
});

test("production runtime resolver accepts only the configured ready production endpoint", async () => {
  const { createProductionRuntimeControl } = await loadBroker();
  const runtimeId = "AgenticPlatformRuntime-ABC1234567";
  const runtimeArn =
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
    + `runtime/${runtimeId}`;
  const endpointName = "Production";
  const endpointArn = `${runtimeArn}/runtime-endpoint/${endpointName}`;
  const commands = [];
  const control = createProductionRuntimeControl({
    client: {
      async send(command) {
        commands.push(command);
        if (command instanceof GetAgentRuntimeCommand) {
          return {
            agentRuntimeId: runtimeId,
            agentRuntimeArn: runtimeArn,
            agentRuntimeVersion: "7",
            status: "READY",
          };
        }
        if (command instanceof GetAgentRuntimeEndpointCommand) {
          return {
            name: endpointName,
            agentRuntimeEndpointArn: endpointArn,
            agentRuntimeArn: runtimeArn,
            liveVersion: "7",
            status: "READY",
          };
        }
        throw new Error(`Unexpected ${command.constructor.name}`);
      },
    },
    runtimeId,
    productionEndpointName: endpointName,
  });

  assert.equal(control.runtimeId, runtimeId);
  assert.equal(control.productionEndpointName, endpointName);
  assert.deepEqual(await control.resolveEndpoint("PRODUCTION"), {
    runtimeId,
    runtimeArn,
    runtimeStatus: "READY",
    endpointName,
    endpointArn,
    runtimeVersion: "7",
  });
  assert.deepEqual(commands.map((command) => command.input), [
    { agentRuntimeId: runtimeId },
    { agentRuntimeId: runtimeId, endpointName },
  ]);
  await assert.rejects(
    control.resolveEndpoint("SANDBOX"),
    /environment is invalid/i,
  );
});

test("production runtime resolver fails closed on non-ready or mismatched live identity", async () => {
  const { createProductionRuntimeControl } = await loadBroker();
  const runtimeId = "AgenticPlatformRuntime-ABC1234567";
  const runtimeArn =
    "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
    + `runtime/${runtimeId}`;
  const control = createProductionRuntimeControl({
    client: {
      responses: [
        {
          agentRuntimeId: runtimeId,
          agentRuntimeArn: runtimeArn,
          agentRuntimeVersion: "7",
          status: "READY",
        },
        {
          name: "Production",
          agentRuntimeEndpointArn:
            "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
            + "runtime-endpoint/Production",
          agentRuntimeArn: runtimeArn,
          liveVersion: "7",
          targetVersion: "8",
          status: "READY",
        },
      ],
      async send() {
        return this.responses.shift();
      },
    },
    runtimeId,
    productionEndpointName: "Production",
  });

  await assert.rejects(
    control.resolveEndpoint("PRODUCTION"),
    /identity is malformed/i,
  );
});
