import { createHash } from "node:crypto";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  createRuntimeInvocationProof,
} from "./invocation-proof.mjs";

const SECRET_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;
const RUNTIME_ENDPOINT_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn|aws-iso|aws-iso-b|aws-iso-e|aws-iso-f):bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/[A-Za-z0-9_-]{1,48}\/runtime-endpoint\/[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONFIG_KEYS = Object.freeze([
  "hmacKey",
  "previousHmacKey",
  "allowedEndpointArn",
  "keyId",
]);

function configurationError() {
  return new TypeError(
    "Runtime proof configurator configuration is invalid.",
  );
}

function unavailableError() {
  return new Error("Runtime proof configuration is unavailable.");
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    )
  );
}

function ownDataValue(value, key) {
  if (!isPlainObject(value)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  ) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

function exactConfiguration(value) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CONFIG_KEYS.length
    || keys.some((key) => (
      typeof key !== "string"
      || !CONFIG_KEYS.includes(key)
      || !Object.hasOwn(descriptors[key], "value")
      || descriptors[key].enumerable !== true
    ))
  ) {
    return null;
  }
  return Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, descriptors[key].value]),
  );
}

function validHmacKey(value) {
  try {
    createRuntimeInvocationProof({ secret: value });
    return true;
  } catch {
    return false;
  }
}

function parseSecret(response, secretArn) {
  if (
    !isPlainObject(response)
    || ownDataValue(response, "ARN").value !== secretArn
    || typeof ownDataValue(response, "SecretString").value !== "string"
    || ownDataValue(response, "SecretBinary").present
  ) {
    return null;
  }
  const stages = ownDataValue(response, "VersionStages");
  if (
    !stages.present
    || !Array.isArray(stages.value)
    || !stages.value.includes("AWSCURRENT")
  ) {
    return null;
  }
  let configuration;
  try {
    configuration = exactConfiguration(
      JSON.parse(response.SecretString),
    );
  } catch {
    return null;
  }
  if (
    configuration === null
    || !validHmacKey(configuration.hmacKey)
    || (
      configuration.previousHmacKey !== null
      && (
        !validHmacKey(configuration.previousHmacKey)
        || configuration.previousHmacKey === configuration.hmacKey
      )
    )
    || (
      configuration.allowedEndpointArn !== null
      && (
        typeof configuration.allowedEndpointArn !== "string"
        || !RUNTIME_ENDPOINT_ARN_PATTERN.test(
          configuration.allowedEndpointArn,
        )
      )
    )
    || typeof configuration.keyId !== "string"
    || !KEY_ID_PATTERN.test(configuration.keyId)
  ) {
    return null;
  }
  return configuration;
}

function request(value) {
  const requestType = ownDataValue(value, "RequestType");
  const properties = ownDataValue(value, "ResourceProperties");
  if (
    !requestType.present
    || !["Create", "Update", "Delete"].includes(requestType.value)
    || !properties.present
  ) {
    return null;
  }
  const secretArn = ownDataValue(properties.value, "SecretArn");
  const allowedEndpointArn = ownDataValue(
    properties.value,
    "AllowedEndpointArn",
  );
  if (
    !secretArn.present
    || typeof secretArn.value !== "string"
    || !SECRET_ARN_PATTERN.test(secretArn.value)
    || !allowedEndpointArn.present
    || typeof allowedEndpointArn.value !== "string"
    || !RUNTIME_ENDPOINT_ARN_PATTERN.test(allowedEndpointArn.value)
  ) {
    return null;
  }
  return {
    requestType: requestType.value,
    secretArn: secretArn.value,
    allowedEndpointArn: allowedEndpointArn.value,
  };
}

function physicalResourceId(secretArn) {
  return `runtime-proof-config-${
    createHash("sha256")
      .update(secretArn, "utf8")
      .digest("hex")
      .slice(0, 32)
  }`;
}

function desiredSecret(configuration, allowedEndpointArn) {
  const secretString = JSON.stringify({
    ...configuration,
    allowedEndpointArn,
  });
  return {
    secretString,
    clientRequestToken: createHash("sha256")
      .update(secretString, "utf8")
      .digest("hex"),
  };
}

export function createRuntimeProofConfigurator({
  client,
} = {}) {
  if (!client || typeof client.send !== "function") {
    throw configurationError();
  }
  return async function configureRuntimeProof(event) {
    const input = request(event);
    if (input === null) throw unavailableError();
    const result = {
      PhysicalResourceId: physicalResourceId(input.secretArn),
    };
    if (input.requestType === "Delete") return result;
    try {
      const response = await client.send(new GetSecretValueCommand({
        SecretId: input.secretArn,
        VersionStage: "AWSCURRENT",
      }));
      const configuration = parseSecret(response, input.secretArn);
      if (configuration === null) throw unavailableError();
      if (configuration.allowedEndpointArn === input.allowedEndpointArn) {
        return result;
      }
      const desired = desiredSecret(
        configuration,
        input.allowedEndpointArn,
      );
      await client.send(new PutSecretValueCommand({
        SecretId: input.secretArn,
        SecretString: desired.secretString,
        ClientRequestToken: desired.clientRequestToken,
      }));
      return result;
    } catch {
      throw unavailableError();
    }
  };
}

let productionConfigurator;

export async function handler(event) {
  productionConfigurator ??= createRuntimeProofConfigurator({
    client: new SecretsManagerClient({}),
  });
  return productionConfigurator(event);
}
