import assert from "node:assert/strict";
import test from "node:test";
import {
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  AgentCoreRuntimeControl,
} from "../lambda/deployment/runtime-control.mjs";

const RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567";
const ENDPOINT_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime-endpoint/Sandbox";

function recordingClient(responses) {
  return {
    commands: [],
    async send(command) {
      this.commands.push(command);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("Runtime control resolves a ready environment to exact AWS identity", async () => {
  const client = recordingClient([
    {
      agentRuntimeId: "AgenticPlatformRuntime-ABC1234567",
      agentRuntimeArn: RUNTIME_ARN,
      agentRuntimeName: "AgenticPlatformRuntime",
      agentRuntimeVersion: "1",
      status: "READY",
    },
    {
      agentRuntimeEndpointArn: ENDPOINT_ARN,
      agentRuntimeArn: RUNTIME_ARN,
      id: "Sandbox-ABC1234567",
      name: "Sandbox",
      liveVersion: "1",
      status: "READY",
    },
  ]);
  const control = new AgentCoreRuntimeControl({
    client,
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    sandboxEndpointName: "Sandbox",
    productionEndpointName: "Production",
  });

  assert.deepEqual(
    await control.resolveEndpoint("SANDBOX"),
    {
      runtimeId: "AgenticPlatformRuntime-ABC1234567",
      runtimeArn: RUNTIME_ARN,
      runtimeStatus: "READY",
      endpointName: "Sandbox",
      endpointArn: ENDPOINT_ARN,
      runtimeVersion: "1",
    },
  );
  assert.ok(client.commands[0] instanceof GetAgentRuntimeCommand);
  assert.deepEqual(client.commands[0].input, {
    agentRuntimeId: "AgenticPlatformRuntime-ABC1234567",
  });
  assert.ok(client.commands[1] instanceof GetAgentRuntimeEndpointCommand);
  assert.deepEqual(client.commands[1].input, {
    agentRuntimeId: "AgenticPlatformRuntime-ABC1234567",
    endpointName: "Sandbox",
  });
});

test("Runtime control rejects unknown environments and non-ready resources", async () => {
  const control = new AgentCoreRuntimeControl({
    client: recordingClient([]),
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    sandboxEndpointName: "Sandbox",
    productionEndpointName: "Production",
  });
  await assert.rejects(
    control.resolveEndpoint("PREVIEW"),
    /environment is invalid/i,
  );

  const notReady = new AgentCoreRuntimeControl({
    client: recordingClient([
      {
        agentRuntimeId: "AgenticPlatformRuntime-ABC1234567",
        agentRuntimeArn: RUNTIME_ARN,
        agentRuntimeVersion: "1",
        status: "UPDATING",
      },
    ]),
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    sandboxEndpointName: "Sandbox",
    productionEndpointName: "Production",
  });
  await assert.rejects(
    notReady.resolveEndpoint("PRODUCTION"),
    /not ready/i,
  );
});

test("Runtime control fails closed on mismatched runtime or endpoint identity", async () => {
  const control = new AgentCoreRuntimeControl({
    client: recordingClient([
      {
        agentRuntimeId: "DifferentRuntime-ABC1234567",
        agentRuntimeArn: RUNTIME_ARN,
        agentRuntimeVersion: "1",
        status: "READY",
      },
    ]),
    runtimeId: "AgenticPlatformRuntime-ABC1234567",
    sandboxEndpointName: "Sandbox",
    productionEndpointName: "Production",
  });

  await assert.rejects(
    control.resolveEndpoint("SANDBOX"),
    /identity is malformed/i,
  );
});
