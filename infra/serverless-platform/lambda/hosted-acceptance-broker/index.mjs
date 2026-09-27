import {
  AgentRegistryControlClient,
} from "@aws-sdk/client-agent-registry-control";
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  createDomainDirectory,
} from "../platform-admin/domain-directory.mjs";
import {
  createHostedAcceptanceBrokerService,
} from "./service.mjs";

const OPERATIONS = new Set([
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
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const SAFE_DENIED_ACTIONS = new Set([
  "agent-registry:CreateRegistryRecord",
  "agent-registry:TagResource",
  "bedrock-agentcore:GetAgentRuntime",
  "bedrock-agentcore:GetAgentRuntimeEndpoint",
  "cognito-idp:DeleteGroup",
  "cognito-idp:GetGroup",
  "cognito-idp:ListUsersInGroup",
  "dynamodb:DeleteItem",
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:Query",
  "dynamodb:TransactWriteItems",
  "iam:PassRole",
]);
const SAFE_ERROR_CLASSIFICATIONS = new Set([
  "AccessDeniedException",
  "ConditionalCheckFailedException",
  "ConflictException",
  "InternalServerException",
  "ProvisionedThroughputExceededException",
  "ResourceNotFoundException",
  "ServiceUnavailableException",
  "ThrottlingException",
  "TransactionCanceledException",
  "ValidationException",
]);
const RUNTIME_ID_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]{0,99}-[A-Za-z0-9]{10}$/;
const ENDPOINT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const ARN_PATTERN =
  /^arn:[A-Za-z0-9-]+:[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]*:.+$/;
const VERSION_PATTERN = /^[1-9][0-9]{0,4}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const USER_POOL_ID_PATTERN =
  /^([a-z]{2}(?:-[a-z0-9]+)+-\d)_[A-Za-z0-9]+$/;
let productionService;

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

function stableFailure(code, message) {
  return {
    ok: false,
    code,
    message,
    retryable: false,
  };
}

function ownString(value, key) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    !descriptor
    || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "string"
    || descriptor.value.length === 0
  ) {
    return null;
  }
  return descriptor.value;
}

export function createProductionRuntimeControl({
  client,
  runtimeId,
  productionEndpointName,
} = {}) {
  if (
    !client
    || typeof client.send !== "function"
    || typeof runtimeId !== "string"
    || !RUNTIME_ID_PATTERN.test(runtimeId)
    || typeof productionEndpointName !== "string"
    || !ENDPOINT_NAME_PATTERN.test(productionEndpointName)
  ) {
    throw new TypeError(
      "Hosted acceptance Runtime control configuration is invalid.",
    );
  }
  return Object.freeze({
    runtimeId,
    productionEndpointName,
    async resolveEndpoint(environment) {
      if (environment !== "PRODUCTION") {
        throw new Error("AgentCore Runtime environment is invalid.");
      }
      const runtime = await client.send(new GetAgentRuntimeCommand({
        agentRuntimeId: runtimeId,
      }));
      const returnedRuntimeId = ownString(runtime, "agentRuntimeId");
      const runtimeArn = ownString(runtime, "agentRuntimeArn");
      const runtimeVersion = ownString(runtime, "agentRuntimeVersion");
      const runtimeStatus = ownString(runtime, "status");
      if (
        returnedRuntimeId !== runtimeId
        || !ARN_PATTERN.test(runtimeArn ?? "")
        || !VERSION_PATTERN.test(runtimeVersion ?? "")
      ) {
        throw new Error("AgentCore Runtime identity is malformed.");
      }
      if (runtimeStatus !== "READY") {
        throw new Error("AgentCore Runtime is not ready.");
      }
      const endpoint = await client.send(
        new GetAgentRuntimeEndpointCommand({
          agentRuntimeId: runtimeId,
          endpointName: productionEndpointName,
        }),
      );
      const returnedEndpointName = ownString(endpoint, "name");
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
        returnedEndpointName !== productionEndpointName
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
        throw new Error(
          "AgentCore Runtime endpoint identity is malformed.",
        );
      }
      if (endpointStatus !== "READY") {
        throw new Error("AgentCore Runtime endpoint is not ready.");
      }
      return {
        runtimeId: returnedRuntimeId,
        runtimeArn,
        runtimeStatus,
        endpointName: returnedEndpointName,
        endpointArn,
        runtimeVersion,
      };
    },
  });
}

export function createProductionDomainDirectory({
  cognito,
  region,
  userPoolId,
} = {}) {
  const poolRegion = typeof userPoolId === "string"
    ? USER_POOL_ID_PATTERN.exec(userPoolId)?.[1]
    : undefined;
  if (
    !cognito
    || typeof cognito.send !== "function"
    || typeof region !== "string"
    || !REGION_PATTERN.test(region)
    || poolRegion !== region
  ) {
    throw new TypeError(
      "Hosted acceptance Cognito configuration is invalid.",
    );
  }
  return createDomainDirectory({
    cognito,
    userPoolId,
  });
}

function safeErrorClassification(error) {
  if (!error || typeof error !== "object") return {};
  const classification = {};
  if (SAFE_ERROR_CLASSIFICATIONS.has(error.code)) {
    classification.errorCode = error.code;
  }
  if (SAFE_ERROR_CLASSIFICATIONS.has(error.name)) {
    classification.errorName = error.name;
  }
  const httpStatusCode = error.$metadata?.httpStatusCode;
  if (Number.isInteger(httpStatusCode) && httpStatusCode >= 100 && httpStatusCode <= 599) {
    classification.httpStatusCode = httpStatusCode;
  }
  if (typeof error.message === "string") {
    const action = /not authorized to perform(?: action)?:\s*([A-Za-z0-9-]+:[A-Za-z0-9*]+)/i
      .exec(error.message)?.[1];
    if (SAFE_DENIED_ACTIONS.has(action)) {
      classification.deniedAction = action;
    }
    const deniedResource = /on resource:\s*(\*|arn:[^\s]+)/i
      .exec(error.message)?.[1];
    if (deniedResource === "*") {
      classification.deniedResourceKind = "wildcard";
    } else if (
      /^arn:[^:]+:agent-registry:[^:]+:[0-9]{12}:registry\/[^/\s]+\/record\/[^/\s]+$/
        .test(deniedResource)
    ) {
      classification.deniedResourceKind = "registry-record";
    } else if (
      /^arn:[^:]+:agent-registry:[^:]+:[0-9]{12}:registry\/[^/\s]+$/
        .test(deniedResource)
    ) {
      classification.deniedResourceKind = "registry";
    }
    if (/service control policy/i.test(error.message)) {
      classification.authorizationReason = "service-control-policy";
    } else if (/permissions boundary/i.test(error.message)) {
      classification.authorizationReason = "permissions-boundary";
    } else if (/no identity-based policy allows/i.test(error.message)) {
      classification.authorizationReason = "identity-policy";
    } else if (/explicit deny/i.test(error.message)) {
      classification.authorizationReason = "explicit-deny";
    }
  }
  return classification;
}

function validRequest(event) {
  if (
    !isPlainObject(event)
    || Object.keys(event).length !== 2
    || !Object.hasOwn(event, "operation")
    || !Object.hasOwn(event, "input")
    || !OPERATIONS.has(event.operation)
    || !isPlainObject(event.input)
  ) {
    return false;
  }
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8")
      <= MAX_REQUEST_BYTES;
  } catch {
    return false;
  }
}

function configuredService() {
  if (productionService) return productionService;
  const accountId = process.env.PLATFORM_ACCOUNT_ID;
  const fixtureRegistryId = process.env.SHARED_REGISTRY_ID;
  const platformStateTableName = process.env.PLATFORM_STATE_TABLE_NAME;
  const region = process.env.AWS_REGION;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const runtimeId = process.env.AGENT_RUNTIME_ID;
  const productionEndpointName = process.env.PRODUCTION_ENDPOINT_NAME;
  productionService = createHostedAcceptanceBrokerService({
    accountId,
    fixtureRegistryId,
    platformStateTableName,
    region,
    domainDirectory: createProductionDomainDirectory({
      cognito: new CognitoIdentityProviderClient({ region }),
      region,
      userPoolId,
    }),
    registryClient: new AgentRegistryControlClient({ region }),
    dynamoClient: new DynamoDBClient({ region }),
    runtimeControl: createProductionRuntimeControl({
      client: new BedrockAgentCoreControlClient({ region }),
      runtimeId,
      productionEndpointName,
    }),
  });
  return productionService;
}

export function createHostedAcceptanceBrokerHandler({
  logger = console,
  service,
  serviceFactory = configuredService,
} = {}) {
  let resolvedService = service;
  return async function hostedAcceptanceBrokerHandler(event) {
    if (!validRequest(event)) {
      return stableFailure(
        "HOSTED_ACCEPTANCE_BROKER_INVALID_REQUEST",
        "Hosted acceptance broker request is invalid.",
      );
    }
    try {
      resolvedService ??= serviceFactory();
      const operation = resolvedService?.[event.operation];
      if (typeof operation !== "function") throw new Error("Invalid service.");
      const result = await operation.call(resolvedService, event.input);
      const response = { ok: true, result };
      if (
        Buffer.byteLength(JSON.stringify(response), "utf8")
          > MAX_RESPONSE_BYTES
      ) {
        throw new Error("Response too large.");
      }
      return response;
    } catch (error) {
      logger.error?.({
        code: "HOSTED_ACCEPTANCE_BROKER_FAILED",
        ...safeErrorClassification(error),
        operation: event.operation,
      });
      return stableFailure(
        "HOSTED_ACCEPTANCE_BROKER_FAILED",
        "Hosted acceptance broker operation failed.",
      );
    }
  };
}

export const handler = createHostedAcceptanceBrokerHandler();
