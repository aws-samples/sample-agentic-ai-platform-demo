import {
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

const RUNTIME_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]{0,99}-[A-Za-z0-9]{10}$/;
const ENDPOINT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const ARN_PATTERN =
  /^arn:[A-Za-z0-9-]+:[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]*:.+$/;
const VERSION_PATTERN = /^[1-9][0-9]{0,4}$/;

function invalid(message) {
  throw new Error(message);
}

function ownString(value, key) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !Object.hasOwn(value, key)
    || typeof value[key] !== "string"
    || value[key].length === 0
  ) {
    return null;
  }
  return value[key];
}

export class AgentCoreRuntimeControl {
  constructor({
    client,
    runtimeId,
    sandboxEndpointName,
    productionEndpointName,
  } = {}) {
    if (
      !client
      || typeof client.send !== "function"
      || typeof runtimeId !== "string"
      || !RUNTIME_ID_PATTERN.test(runtimeId)
      || typeof sandboxEndpointName !== "string"
      || !ENDPOINT_NAME_PATTERN.test(sandboxEndpointName)
      || typeof productionEndpointName !== "string"
      || !ENDPOINT_NAME_PATTERN.test(productionEndpointName)
      || sandboxEndpointName === productionEndpointName
    ) {
      throw new TypeError(
        "AgentCore Runtime control configuration is invalid.",
      );
    }
    this.client = client;
    this.runtimeId = runtimeId;
    this.endpointNames = Object.freeze({
      SANDBOX: sandboxEndpointName,
      PRODUCTION: productionEndpointName,
    });
  }

  async resolveEndpoint(environment) {
    if (!Object.hasOwn(this.endpointNames, environment)) {
      invalid("AgentCore Runtime environment is invalid.");
    }
    const endpointName = this.endpointNames[environment];
    const runtime = await this.client.send(
      new GetAgentRuntimeCommand({
        agentRuntimeId: this.runtimeId,
      }),
    );
    const runtimeId = ownString(runtime, "agentRuntimeId");
    const runtimeArn = ownString(runtime, "agentRuntimeArn");
    const runtimeVersion = ownString(runtime, "agentRuntimeVersion");
    const runtimeStatus = ownString(runtime, "status");
    if (
      runtimeId !== this.runtimeId
      || !ARN_PATTERN.test(runtimeArn ?? "")
      || !VERSION_PATTERN.test(runtimeVersion ?? "")
    ) {
      invalid("AgentCore Runtime identity is malformed.");
    }
    if (runtimeStatus !== "READY") {
      invalid("AgentCore Runtime is not ready.");
    }

    const endpoint = await this.client.send(
      new GetAgentRuntimeEndpointCommand({
        agentRuntimeId: this.runtimeId,
        endpointName,
      }),
    );
    const returnedName = ownString(endpoint, "name");
    const endpointArn = ownString(endpoint, "agentRuntimeEndpointArn");
    const endpointRuntimeArn = ownString(endpoint, "agentRuntimeArn");
    const endpointStatus = ownString(endpoint, "status");
    const liveVersion = ownString(endpoint, "liveVersion");
    const hasTargetVersion =
      endpoint !== null
      && typeof endpoint === "object"
      && !Array.isArray(endpoint)
      && Object.hasOwn(endpoint, "targetVersion");
    const targetVersion = ownString(endpoint, "targetVersion");
    if (
      returnedName !== endpointName
      || endpointRuntimeArn !== runtimeArn
      || !ARN_PATTERN.test(endpointArn ?? "")
      || !VERSION_PATTERN.test(liveVersion ?? "")
      || (
        hasTargetVersion
        && (
          !VERSION_PATTERN.test(targetVersion ?? "")
          || liveVersion !== targetVersion
        )
      )
      || liveVersion !== runtimeVersion
    ) {
      invalid("AgentCore Runtime endpoint identity is malformed.");
    }
    if (endpointStatus !== "READY") {
      invalid("AgentCore Runtime endpoint is not ready.");
    }
    return {
      runtimeId,
      runtimeArn,
      runtimeStatus,
      endpointName,
      endpointArn,
      runtimeVersion,
    };
  }
}
