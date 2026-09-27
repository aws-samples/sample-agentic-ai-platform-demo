import { isDeepStrictEqual } from "node:util";
import {
  AgentRegistryControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  ListTagsForResourceCommand,
  SubmitRegistryRecordForApprovalCommand,
  TagResourceCommand,
  UpdateRegistryRecordStatusCommand,
} from "@aws-sdk/client-agent-registry-control";
import {
  sendCloudFormationResponse,
} from "../platform-admin/seed.mjs";

const RESOURCE_PROPERTY_KEYS = new Set([
  "ServiceToken",
  "ServiceTimeout",
  "PlatformRegistryId",
  "PlatformRegistryArn",
  "Region",
  "AccountId",
  "RuntimeArn",
  "ProductionEndpointArn",
  "ProductionEndpointName",
  "GatewayModelId",
]);
const REQUIRED_TAGS = Object.freeze({
  "auto-delete": "no",
  project: "agentic-ai-platform-demo",
  managedBy: "cdk",
});
const RECORD_NAME = "agent_design_assistant";
const RECORD_DISPLAY_NAME = "Agent Design Assistant";
const RECORD_DESCRIPTION =
  "Deployment-owned platform AgentCore Runtime assistant for Agent design discovery.";
const RECORD_VERSION = "1.0.0-platform-descriptor.1";
const PROJECT_ID = "platform-foundation";
const PHYSICAL_RESOURCE_PREFIX = "platform-agent-design-assistant:";
const MAX_LIST_RESULTS = 10;
const DEFAULT_MAX_LIST_PAGES = 3;
const DEFAULT_MAX_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_DELAY_MS = 1_000;
const APPROVAL_REASON =
  "Approved by deployment-owned platform Agent Design Assistant seeder.";

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
const ACCOUNT_ID_PATTERN = /^\d{12}$/;
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUNTIME_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
const ENDPOINT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function invalidProperties() {
  throw new TypeError("Platform Agent Registry seed properties are invalid.");
}

function unavailable(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function exactKeys(value, allowedKeys) {
  return isPlainObject(value)
    && Object.keys(value).every((key) => allowedKeys.has(key));
}

function physicalResourceId(registryId) {
  return `${PHYSICAL_RESOURCE_PREFIX}${registryId}`;
}

function validPhysicalResourceId(value) {
  if (typeof value !== "string" || !value.startsWith(PHYSICAL_RESOURCE_PREFIX)) {
    return null;
  }
  const registryId = value.slice(PHYSICAL_RESOURCE_PREFIX.length);
  return REGISTRY_ID_PATTERN.test(registryId)
    && value === physicalResourceId(registryId)
      ? value
      : null;
}

function validateProperties(properties) {
  if (
    !exactKeys(properties, RESOURCE_PROPERTY_KEYS)
    || typeof properties.PlatformRegistryId !== "string"
    || !REGISTRY_ID_PATTERN.test(properties.PlatformRegistryId)
    || typeof properties.PlatformRegistryArn !== "string"
    || typeof properties.Region !== "string"
    || !REGION_PATTERN.test(properties.Region)
    || typeof properties.AccountId !== "string"
    || !ACCOUNT_ID_PATTERN.test(properties.AccountId)
    || typeof properties.RuntimeArn !== "string"
    || typeof properties.ProductionEndpointArn !== "string"
    || typeof properties.ProductionEndpointName !== "string"
    || !ENDPOINT_NAME_PATTERN.test(properties.ProductionEndpointName)
    || typeof properties.GatewayModelId !== "string"
    || !MODEL_ID_PATTERN.test(properties.GatewayModelId)
    || properties.GatewayModelId.includes("://")
  ) {
    invalidProperties();
  }

  const expectedRegistryArn =
    `arn:aws:agent-registry:${properties.Region}:${properties.AccountId}:`
    + `registry/${properties.PlatformRegistryId}`;
  const runtimePrefix =
    `arn:aws:bedrock-agentcore:${properties.Region}:${properties.AccountId}:`
    + "runtime/";
  const runtimeName = properties.RuntimeArn.slice(runtimePrefix.length);
  if (
    properties.PlatformRegistryArn !== expectedRegistryArn
    || !properties.RuntimeArn.startsWith(runtimePrefix)
    || !RUNTIME_NAME_PATTERN.test(runtimeName)
    || properties.ProductionEndpointArn
      !== `${properties.RuntimeArn}/runtime-endpoint/${properties.ProductionEndpointName}`
  ) {
    invalidProperties();
  }

  return Object.freeze({
    accountId: properties.AccountId,
    endpointArn: properties.ProductionEndpointArn,
    endpointName: properties.ProductionEndpointName,
    modelId: properties.GatewayModelId,
    platformRegistryArn: properties.PlatformRegistryArn,
    platformRegistryId: properties.PlatformRegistryId,
    region: properties.Region,
    runtimeArn: properties.RuntimeArn,
  });
}

function desiredDescriptor(config) {
  const invocationUrl =
    `https://bedrock-agentcore.${config.region}.amazonaws.com/runtimes/`
    + `${encodeURIComponent(config.runtimeArn)}/invocations?qualifier=`
    + encodeURIComponent(config.endpointName);
  return {
    schemaVersion: 1,
    resourceKind: "agent",
    name: RECORD_DISPLAY_NAME,
    description: RECORD_DESCRIPTION,
    url: invocationUrl,
    version: "1.0.0",
    specification: {
      runtimeArn: config.runtimeArn,
      endpointArn: config.endpointArn,
      endpointName: config.endpointName,
      modelId: config.modelId,
      projectId: PROJECT_ID,
      invocationUrl,
    },
    "x-platform": {
      domainId: "platform",
      ownerSubject: "platform-bootstrap",
      resourceId: "agent-design-assistant",
      resourceType: "AGENT",
      shared: false,
    },
    "x-platform-metadata": {
      displayName: RECORD_DISPLAY_NAME,
      domain: "platform",
      governanceMode: "owned",
      domainOwner: "Platform",
      access: ["admin"],
      createdBy: "platform-bootstrap",
      changelog: "Deployment-owned platform design assistant.",
    },
  };
}

function desiredRecord(config) {
  return {
    name: RECORD_NAME,
    displayName: RECORD_DISPLAY_NAME,
    description: RECORD_DESCRIPTION,
    recordType: "AGENT",
    recordVersion: RECORD_VERSION,
    descriptors: {
      custom: {
        data: JSON.stringify(desiredDescriptor(config)),
      },
    },
  };
}

function descriptorMatches(record, config) {
  const data = record?.descriptors?.custom?.data;
  if (typeof data !== "string") return false;
  let descriptor;
  try {
    descriptor = JSON.parse(data);
  } catch {
    return false;
  }
  return isDeepStrictEqual(descriptor, desiredDescriptor(config));
}

function assertExactRecord(record, config, recordId) {
  const expectedRecordArn =
    `${config.platformRegistryArn}/record/${recordId}`;
  if (
    !isPlainObject(record)
    || record.registryArn !== config.platformRegistryArn
    || record.recordArn !== expectedRecordArn
    || record.recordId !== recordId
    || record.name !== RECORD_NAME
    || record.displayName !== RECORD_DISPLAY_NAME
    || record.description !== RECORD_DESCRIPTION
    || record.recordType !== "AGENT"
    || record.recordVersion !== RECORD_VERSION
  ) {
    unavailable("Existing platform Agent Design Assistant record is invalid.");
  }
  if (!descriptorMatches(record, config)) {
    unavailable(
      "Existing platform Agent Design Assistant immutable descriptor differs.",
    );
  }
  if (
    typeof record.status !== "string"
    || !new Set([
      "CREATING",
      "DRAFT",
      "PENDING_APPROVAL",
      "APPROVED",
      "REJECTED",
      "DEPRECATED",
      "UPDATING",
      "CREATE_FAILED",
      "UPDATE_FAILED",
    ]).has(record.status)
  ) {
    unavailable("Existing platform Agent Design Assistant status is invalid.");
  }
  return record;
}

function recordIdFromArn(recordArn, config) {
  const prefix = `${config.platformRegistryArn}/record/`;
  if (
    typeof recordArn !== "string"
    || !recordArn.startsWith(prefix)
  ) {
    unavailable("Created platform Agent Design Assistant record ARN is invalid.");
  }
  const recordId = recordArn.slice(prefix.length);
  if (!RECORD_ID_PATTERN.test(recordId) || recordArn !== `${prefix}${recordId}`) {
    unavailable("Created platform Agent Design Assistant record ARN is invalid.");
  }
  return recordId;
}

function listToken(page) {
  if (!isPlainObject(page)) {
    unavailable("Platform Registry list response is invalid.");
  }
  if (
    page.nextToken !== undefined
    && (typeof page.nextToken !== "string" || page.nextToken.length === 0)
  ) {
    unavailable("Platform Registry list response is invalid.");
  }
  return page.nextToken;
}

function listedRecordId(summary, config) {
  if (
    !isPlainObject(summary)
    || summary.registryArn !== config.platformRegistryArn
    || typeof summary.recordId !== "string"
    || !RECORD_ID_PATTERN.test(summary.recordId)
    || summary.recordArn
      !== `${config.platformRegistryArn}/record/${summary.recordId}`
    || summary.name !== RECORD_NAME
  ) {
    unavailable("Platform Registry listed record is invalid.");
  }
  return summary.recordId;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPlatformAgentRegistrySeeder({
  registryClient,
  maxListPages = DEFAULT_MAX_LIST_PAGES,
  maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
  pollDelayMs = DEFAULT_POLL_DELAY_MS,
  sleep = defaultSleep,
} = {}) {
  if (
    !registryClient
    || typeof registryClient.send !== "function"
    || !Number.isInteger(maxListPages)
    || maxListPages < 1
    || !Number.isInteger(maxPollAttempts)
    || maxPollAttempts < 1
    || !Number.isFinite(pollDelayMs)
    || pollDelayMs < 0
    || typeof sleep !== "function"
  ) {
    throw new TypeError("Platform Agent Registry seeder configuration is invalid.");
  }

  async function findExistingRecord(config) {
    let nextToken;
    const seenTokens = new Set();
    const matches = [];
    for (let pageNumber = 0; pageNumber < maxListPages; pageNumber += 1) {
      const page = await registryClient.send(new ListRegistryRecordsCommand({
        registryId: config.platformRegistryId,
        maxResults: MAX_LIST_RESULTS,
        filters: [{ name: "name", values: [RECORD_NAME] }],
        ...(nextToken === undefined ? {} : { nextToken }),
      }));
      if (
        !Array.isArray(page?.registryRecords)
        || page.registryRecords.length > MAX_LIST_RESULTS
      ) {
        unavailable("Platform Registry list response is invalid.");
      }
      for (const summary of page.registryRecords) {
        if (summary?.name === RECORD_NAME) {
          matches.push(listedRecordId(summary, config));
        }
      }
      if (matches.length > 1) {
        unavailable("Platform Registry contains multiple Agent Design Assistant records.");
      }
      const cursor = listToken(page);
      if (cursor === undefined) return matches[0] ?? null;
      if (seenTokens.has(cursor)) {
        unavailable("Platform Registry listing contains a repeated continuation token.");
      }
      seenTokens.add(cursor);
      nextToken = cursor;
    }
    unavailable("Platform Registry listing exceeded its bounded limit.");
  }

  async function getExactRecord(config, recordId) {
    const record = await registryClient.send(new GetRegistryRecordCommand({
      registryId: config.platformRegistryId,
      recordId,
    }));
    return assertExactRecord(record, config, recordId);
  }

  async function convergeToApproved(config, recordId) {
    let submitted = false;
    let approved = false;
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const record = await getExactRecord(config, recordId);
      if (record.status === "APPROVED") return record;
      if (record.status === "CREATING" || record.status === "UPDATING") {
        await sleep(pollDelayMs);
        continue;
      }
      if (record.status === "DRAFT") {
        if (!submitted) {
          await registryClient.send(new SubmitRegistryRecordForApprovalCommand({
            registryId: config.platformRegistryId,
            recordId,
          }));
          submitted = true;
        }
        await sleep(pollDelayMs);
        continue;
      }
      if (record.status === "PENDING_APPROVAL") {
        if (!approved) {
          await registryClient.send(new UpdateRegistryRecordStatusCommand({
            registryId: config.platformRegistryId,
            recordId,
            status: "APPROVED",
            statusReason: APPROVAL_REASON,
          }));
          approved = true;
        }
        await sleep(pollDelayMs);
        continue;
      }
      unavailable(
        "Platform Agent Design Assistant did not reach the expected state.",
      );
    }
    unavailable(
      "Platform Agent Design Assistant did not reach the expected state.",
    );
  }

  async function reconcileTags(recordArn) {
    const listed = await registryClient.send(new ListTagsForResourceCommand({
      resourceArn: recordArn,
    }));
    if (!isPlainObject(listed) || !isPlainObject(listed.tags)) {
      unavailable("Platform Agent Design Assistant tags are invalid.");
    }
    const outOfDate = Object.entries(REQUIRED_TAGS).some(
      ([key, value]) => listed.tags[key] !== value,
    );
    if (!outOfDate) return;
    await registryClient.send(new TagResourceCommand({
      resourceArn: recordArn,
      tags: REQUIRED_TAGS,
    }));
  }

  async function reconcile(event) {
    if (!isPlainObject(event)) invalidProperties();
    if (event.RequestType === "Delete") {
      return {
        PhysicalResourceId:
          validPhysicalResourceId(event.PhysicalResourceId)
          ?? `${PHYSICAL_RESOURCE_PREFIX}retained`,
        Data: { Retained: true },
      };
    }
    if (event.RequestType !== "Create" && event.RequestType !== "Update") {
      invalidProperties();
    }
    if (event.RequestType === "Create" && event.PhysicalResourceId !== undefined) {
      invalidProperties();
    }
    const config = validateProperties(event.ResourceProperties);
    const expectedPhysicalResourceId = physicalResourceId(
      config.platformRegistryId,
    );
    if (event.RequestType === "Update") {
      const oldConfig = validateProperties(event.OldResourceProperties);
      if (
        event.PhysicalResourceId !== physicalResourceId(
          oldConfig.platformRegistryId,
        )
        || event.PhysicalResourceId !== expectedPhysicalResourceId
      ) {
        invalidProperties();
      }
    }

    let recordId = await findExistingRecord(config);
    if (recordId === null) {
      const created = await registryClient.send(new CreateRegistryRecordCommand({
        registryId: config.platformRegistryId,
        ...desiredRecord(config),
        clientToken: "platform-agent-design-assistant-v1",
        tags: REQUIRED_TAGS,
      }));
      if (created?.status !== "CREATING") {
        unavailable("Platform Agent Design Assistant creation did not start.");
      }
      recordId = recordIdFromArn(created.recordArn, config);
    }

    const record = await convergeToApproved(config, recordId);
    await reconcileTags(record.recordArn);
    return {
      PhysicalResourceId: expectedPhysicalResourceId,
      Data: {
        RecordArn: record.recordArn,
        RecordId: record.recordId,
        Status: record.status,
      },
    };
  }

  return Object.freeze({ reconcile });
}

function failurePhysicalResourceId(event) {
  return validPhysicalResourceId(event?.PhysicalResourceId)
    ?? `${PHYSICAL_RESOURCE_PREFIX}failed`;
}

export async function handlePlatformAgentRegistrySeed(
  event,
  context,
  registryClient,
  {
    sendResponse = sendCloudFormationResponse,
  } = {},
) {
  const seeder = createPlatformAgentRegistrySeeder({ registryClient });
  try {
    const result = await seeder.reconcile(event);
    if (typeof event?.ResponseURL === "string") {
      await sendResponse(
        event,
        context,
        "SUCCESS",
        result,
        "Platform Agent Design Assistant Registry seed operation completed.",
      );
    }
    return result;
  } catch (error) {
    console.error("PlatformAgentRegistrySeed failed:", error);
    const result = { PhysicalResourceId: failurePhysicalResourceId(event) };
    if (typeof event?.ResponseURL === "string") {
      await sendResponse(
        event,
        context,
        "FAILED",
        result,
        "Platform Agent Design Assistant Registry seed operation failed.",
      );
      return result;
    }
    throw error;
  }
}

const registry = new AgentRegistryControlClient({});

export async function handler(event, context) {
  return handlePlatformAgentRegistrySeed(event, context, registry);
}
