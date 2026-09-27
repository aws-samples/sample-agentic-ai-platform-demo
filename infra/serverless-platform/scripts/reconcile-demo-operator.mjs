import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
export const DEFAULT_MAX_MEMBERS = 1_000;
export const DEFAULT_MAX_PAGES = 100;
export const DEFAULT_LEASE_DURATION_SECONDS = 300;
export const DEFAULT_OPERATION_TIMEOUT_MS = 20_000;
export const DEFAULT_COMPENSATION_QUIESCENCE_MS = 40_000;

const PLATFORM_ADMIN_GROUP = "platform-admin";
const DEMO_OPERATOR_GROUP = "demo-operator";
const LEASE_PARTITION_KEY_PREFIX = "DEMO_OPERATOR_LEASE#";
const LEASE_SORT_KEY = "LOCK";
const COGNITO_NAME_PATTERN =
  /^[\p{L}\p{M}\p{S}\p{N}\p{P}]{1,128}$/u;
const DYNAMODB_TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION_PATTERN =
  /^(?:af|ap|ca|cn|eu|il|me|mx|sa|us)(?:-gov|-iso|-isob|-isoe|-isof)?-[a-z0-9-]+-[1-9][0-9]*$/;
const USER_POOL_ID_MAX_LENGTH = 55;
const PAGINATION_TOKEN_MAX_LENGTH = 131_072;
const PRIVATE_SELECTION_MAX_USERNAMES = 100;

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function fail(message) {
  const error = new Error(message);
  error.name = "DemoOperatorReconciliationError";
  throw error;
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

function validName(value) {
  return typeof value === "string" && COGNITO_NAME_PATTERN.test(value);
}

function validateRegion(value) {
  if (typeof value !== "string" || !REGION_PATTERN.test(value)) {
    fail("AWS_REGION is invalid.");
  }
  return value;
}

function validateUserPoolId(value, region) {
  if (
    typeof value !== "string"
    || value.length > USER_POOL_ID_MAX_LENGTH
    || !new RegExp(`^${region}_[A-Za-z0-9]+$`).test(value)
  ) {
    fail("COGNITO_USER_POOL_ID is invalid for AWS_REGION.");
  }
  return value;
}

function validateGroupName(value) {
  if (!validName(value) || value !== DEMO_OPERATOR_GROUP) {
    fail("COGNITO_DEMO_OPERATOR_GROUP must be demo-operator.");
  }
  return value;
}

function validateUsername(value) {
  if (!validName(value)) {
    fail("Private demo operator selection is invalid.");
  }
  return value;
}

function validateUsernames(value) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > PRIVATE_SELECTION_MAX_USERNAMES
  ) {
    fail("Private demo operator selection is invalid.");
  }
  const usernames = Array.from(value, validateUsername);
  if (new Set(usernames).size !== usernames.length) {
    fail("Private demo operator selection is invalid.");
  }
  return usernames;
}

function validateBound(value, name, maximum) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    fail(`${name} is outside its supported bound.`);
  }
  return value;
}

function requiredEnvironmentValue(env, name) {
  const value = env?.[name];
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
  ) {
    fail(`${name} is required.`);
  }
  return value;
}

async function abortableSend(client, command, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("AWS operation timed out.")),
    timeoutMs,
  );
  try {
    return await client.send(command, {
      abortSignal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createDynamoLease({
  client,
  durationSeconds = DEFAULT_LEASE_DURATION_SECONDS,
  now = Date.now,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  owner = randomUUID(),
  tableName,
  userPoolId,
} = {}) {
  if (!client || typeof client.send !== "function") {
    fail("DynamoDB lease client configuration is invalid.");
  }
  if (
    typeof tableName !== "string"
    || !DYNAMODB_TABLE_NAME_PATTERN.test(tableName)
  ) {
    fail("PLATFORM_STATE_TABLE_NAME is invalid.");
  }
  if (
    typeof userPoolId !== "string"
    || userPoolId.length === 0
    || userPoolId.length > USER_POOL_ID_MAX_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(userPoolId)
  ) {
    fail("Cognito user pool configuration is invalid.");
  }
  validateBound(
    durationSeconds,
    "Lease duration",
    3_600,
  );
  validateBound(
    operationTimeoutMs,
    "AWS call timeout",
    120_000,
  );
  if (operationTimeoutMs >= durationSeconds * 1_000) {
    fail("DynamoDB lease configuration is invalid.");
  }
  if (typeof now !== "function" || !UUID_PATTERN.test(owner)) {
    fail("DynamoDB lease configuration is invalid.");
  }

  const key = Object.freeze({
    pk: { S: `${LEASE_PARTITION_KEY_PREFIX}${userPoolId}` },
    sk: { S: LEASE_SORT_KEY },
  });
  let acquired = false;
  let expiresAt;

  function currentEpochSeconds() {
    const value = now();
    if (
      !Number.isSafeInteger(value)
      || value < 0
    ) {
      fail("DynamoDB lease clock is invalid.");
    }
    return Math.floor(value / 1_000);
  }

  return {
    async acquire() {
      const currentTime = currentEpochSeconds();
      expiresAt = currentTime + durationSeconds;
      await abortableSend(client, new PutItemCommand({
        TableName: tableName,
        Item: {
          ...key,
          owner: { S: owner },
          expiresAt: { N: String(expiresAt) },
          purpose: { S: "demo-operator-reconciliation" },
        },
        ConditionExpression:
          "(attribute_not_exists(#pk) AND attribute_not_exists(#sk))"
          + " OR #expiresAt < :now",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
          "#expiresAt": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":now": { N: String(currentTime) },
        },
        ReturnConsumedCapacity: "NONE",
      }), operationTimeoutMs);
      acquired = true;
    },
    async renew() {
      if (!acquired) {
        fail("DynamoDB lease ownership verification failed.");
      }
      const currentTime = currentEpochSeconds();
      expiresAt = currentTime + durationSeconds;
      await abortableSend(client, new UpdateItemCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: "SET #expiresAt = :expiresAt",
        ConditionExpression:
          "#owner = :owner AND #expiresAt >= :now",
        ExpressionAttributeNames: {
          "#owner": "owner",
          "#expiresAt": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":owner": { S: owner },
          ":expiresAt": { N: String(expiresAt) },
          ":now": { N: String(currentTime) },
        },
        ReturnConsumedCapacity: "NONE",
        ReturnValues: "NONE",
      }), operationTimeoutMs);
    },
    async release() {
      if (!acquired) {
        fail("DynamoDB lease release failed.");
      }
      await abortableSend(client, new DeleteItemCommand({
        TableName: tableName,
        Key: key,
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: {
          "#owner": "owner",
        },
        ExpressionAttributeValues: {
          ":owner": { S: owner },
        },
        ReturnConsumedCapacity: "NONE",
        ReturnValues: "NONE",
      }), operationTimeoutMs);
      acquired = false;
    },
  };
}

export function parsePrivateSelection(document) {
  let value;
  try {
    value = JSON.parse(document);
  } catch {
    fail("Private demo operator selection is invalid.");
  }
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, "usernames")
  ) {
    fail("Private demo operator selection is invalid.");
  }
  return {
    usernames: validateUsernames(value.usernames),
  };
}

export async function readPrivateStdin(
  stdin,
  maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
) {
  validateBound(maxInputBytes, "Private input byte limit", 1024 * 1024);
  if (!stdin || typeof stdin[Symbol.asyncIterator] !== "function") {
    fail("Private demo operator input is unavailable.");
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    for await (const chunk of stdin) {
      if (
        typeof chunk !== "string"
        && !(chunk instanceof Uint8Array)
      ) {
        fail("Private demo operator input is invalid.");
      }
      const bytes = Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxInputBytes) {
        fail("Private demo operator input exceeded its bound.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error?.name === "DemoOperatorReconciliationError") throw error;
    fail("Private demo operator input could not be read.");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, totalBytes),
    );
  } catch {
    fail("Private demo operator input is invalid.");
  }
}

async function send(client, command, message) {
  try {
    return await client.send(command);
  } catch (error) {
    if (error?.name === "DemoOperatorReconciliationError") throw error;
    fail(message);
  }
}

async function verifySelectedUser(client, userPoolId, username) {
  const response = await send(
    client,
    new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    }),
    "Selected Cognito user could not be verified.",
  );
  if (
    !isPlainObject(response)
    || response.Username !== username
    || response.Enabled !== true
    || response.UserStatus !== "CONFIRMED"
  ) {
    fail("Selected Cognito user could not be verified.");
  }
}

async function listSelectedUserGroups({
  client,
  maxPages,
  userPoolId,
  username,
}) {
  const groups = new Set();
  const seenTokens = new Set();
  let nextToken;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await send(
      client,
      new AdminListGroupsForUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        Limit: 60,
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
      "Selected Cognito user group lookup failed.",
    );
    if (!isPlainObject(response) || !Array.isArray(response.Groups)) {
      fail("Selected Cognito user group response was malformed.");
    }
    for (const value of response.Groups) {
      if (
        !isPlainObject(value)
        || !validName(value.GroupName)
        || groups.has(value.GroupName)
      ) {
        fail("Selected Cognito user group response was malformed.");
      }
      groups.add(value.GroupName);
    }

    const parsedToken = parseNextToken(response.NextToken, seenTokens);
    if (parsedToken === null) return groups;
    if (page + 1 >= maxPages) {
      fail("Selected Cognito user group pagination exceeded its bound.");
    }
    nextToken = parsedToken;
  }

  fail("Selected Cognito user group pagination exceeded its bound.");
}

async function verifySelectedAdmin({
  client,
  maxPages,
  postcondition = false,
  userPoolId,
  username,
}) {
  await verifySelectedUser(client, userPoolId, username);
  const groups = await listSelectedUserGroups({
    client,
    maxPages,
    userPoolId,
    username,
  });
  if (!groups.has(PLATFORM_ADMIN_GROUP)) {
    fail(
      postcondition
        ? "Demo operator postcondition verification failed."
        : "Selected Cognito user must be a permanent platform administrator.",
    );
  }
}

function parseMember(value) {
  if (
    !isPlainObject(value)
    || !validName(value.Username)
    || typeof value.Enabled !== "boolean"
  ) {
    fail("Cognito group membership response was malformed.");
  }
  return {
    enabled: value.Enabled,
    username: value.Username,
  };
}

function parseNextToken(value, seenTokens) {
  if (value === undefined) return null;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > PAGINATION_TOKEN_MAX_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || seenTokens.has(value)
  ) {
    fail("Cognito group membership pagination was invalid.");
  }
  seenTokens.add(value);
  return value;
}

async function listMembers({
  client,
  groupName,
  maxMembers,
  maxPages,
  userPoolId,
}) {
  const members = [];
  const usernames = new Set();
  const seenTokens = new Set();
  let nextToken;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await send(
      client,
      new ListUsersInGroupCommand({
        UserPoolId: userPoolId,
        GroupName: groupName,
        Limit: 60,
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
      "Cognito group membership lookup failed.",
    );
    if (!isPlainObject(response) || !Array.isArray(response.Users)) {
      fail("Cognito group membership response was malformed.");
    }
    for (const value of response.Users) {
      const member = parseMember(value);
      if (usernames.has(member.username)) {
        fail("Cognito group membership response was malformed.");
      }
      usernames.add(member.username);
      members.push(member);
      if (members.length > maxMembers) {
        fail("Cognito group membership exceeded its bound.");
      }
    }

    const parsedToken = parseNextToken(response.NextToken, seenTokens);
    if (parsedToken === null) return members;
    if (page + 1 >= maxPages) {
      fail("Cognito group membership pagination exceeded its bound.");
    }
    nextToken = parsedToken;
  }

  fail("Cognito group membership pagination exceeded its bound.");
}

async function removeMember(client, userPoolId, groupName, username) {
  const response = await send(
    client,
    new AdminRemoveUserFromGroupCommand({
      UserPoolId: userPoolId,
      GroupName: groupName,
      Username: username,
    }),
    "Cognito group membership removal failed.",
  );
  if (!isPlainObject(response)) {
    fail("Cognito group membership removal failed.");
  }
}

async function addMember(client, userPoolId, groupName, username) {
  const response = await send(
    client,
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      GroupName: groupName,
      Username: username,
    }),
    "Cognito group membership assignment failed.",
  );
  if (!isPlainObject(response)) {
    fail("Cognito group membership assignment failed.");
  }
}

function validateLease(lease) {
  if (
    !isPlainObject(lease)
    || typeof lease.acquire !== "function"
    || typeof lease.renew !== "function"
    || typeof lease.release !== "function"
  ) {
    fail("Demo operator reconciliation lease configuration is invalid.");
  }
  return lease;
}

function leasedClient(client, lease, operationTimeoutMs) {
  return {
    async send(command) {
      await renewLease(lease);
      return abortableSend(client, command, operationTimeoutMs);
    },
  };
}

async function acquireLease(lease) {
  try {
    await lease.acquire();
  } catch {
    fail("Demo operator reconciliation lease could not be acquired.");
  }
}

async function renewLease(lease) {
  try {
    await lease.renew();
  } catch {
    fail("Demo operator reconciliation lease ownership verification failed.");
  }
}

async function releaseLease(lease) {
  try {
    await lease.release();
  } catch {
    fail("Demo operator reconciliation lease release failed.");
  }
}

function sameMembership(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Map(
    left.map((member) => [member.username, member.enabled]),
  );
  return right.every(
    (member) => expected.get(member.username) === member.enabled,
  );
}

async function restoreMembershipSnapshot({
  additionalMemberLimit,
  client,
  compensationQuiescenceMs,
  groupName,
  maxMembers,
  maxPages,
  originalMembers,
  sleep,
  userPoolId,
}) {
  const compensationMemberLimit = maxMembers + additionalMemberLimit;
  const compensationPageLimit = maxPages + additionalMemberLimit;
  const originalByUsername = new Map(
    originalMembers.map((member) => [member.username, member]),
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let currentMembers;
    try {
      currentMembers = await listMembers({
        client,
        groupName,
        maxMembers: compensationMemberLimit,
        maxPages: compensationPageLimit,
        userPoolId,
      });
      if (!sameMembership(originalMembers, currentMembers)) {
        const currentUsernames = new Set(
          currentMembers.map(({ username }) => username),
        );
        for (const member of originalMembers) {
          if (currentUsernames.has(member.username)) continue;
          try {
            await addMember(
              client,
              userPoolId,
              groupName,
              member.username,
            );
          } catch {
            // The mutation may have succeeded even when its response was lost.
          }
        }
        for (const member of currentMembers) {
          if (originalByUsername.has(member.username)) continue;
          try {
            await removeMember(
              client,
              userPoolId,
              groupName,
              member.username,
            );
          } catch {
            // Re-read under the lease before deciding whether compensation failed.
          }
        }
      }
      await sleep(compensationQuiescenceMs);
      const settledMembers = await listMembers({
        client,
        groupName,
        maxMembers: compensationMemberLimit,
        maxPages: compensationPageLimit,
        userPoolId,
      });
      if (sameMembership(originalMembers, settledMembers)) return;
    } catch {
      // Retry while the owner-fenced lease remains held.
    }
  }
  try {
    const finalMembers = await listMembers({
      client,
      groupName,
      maxMembers: compensationMemberLimit,
      maxPages: compensationPageLimit,
      userPoolId,
    });
    if (sameMembership(originalMembers, finalMembers)) return;
  } catch {
    // Collapse all compensation failures to one non-disclosing error.
  }
  fail("Demo operator compensating cleanup failed.");
}

async function restoreMembershipSnapshotSafely(input) {
  try {
    await restoreMembershipSnapshot(input);
  } catch {
    fail("Demo operator compensating cleanup failed.");
  }
}

async function ensureExactFinalMembership({
  client,
  groupName,
  maxMembers,
  maxPages,
  userPoolId,
  usernames,
}) {
  const finalMembers = await listMembers({
    client,
    groupName,
    maxMembers,
    maxPages,
    userPoolId,
  });
  const selectedUsernames = new Set(usernames);
  if (
    finalMembers.length !== selectedUsernames.size
    || finalMembers.some((member) =>
      member.enabled !== true
      || !selectedUsernames.has(member.username))
  ) {
    fail("Demo operator postcondition verification failed.");
  }
  return finalMembers;
}

async function reconcileMembership({
  client,
  currentMembers,
  groupName,
  userPoolId,
  usernames,
}) {
  const selectedUsernames = new Set(usernames);
  const currentByUsername = new Map(
    currentMembers.map((member) => [member.username, member]),
  );
  for (const username of usernames) {
    const selectedMember = currentByUsername.get(username);
    if (selectedMember?.enabled === false) {
      fail("Selected Cognito user could not be verified.");
    }
  }

  let addedMemberCount = 0;
  for (const username of usernames) {
    if (currentByUsername.has(username)) continue;
    await addMember(client, userPoolId, groupName, username);
    addedMemberCount += 1;
  }
  let removedMemberCount = 0;
  for (const member of currentMembers) {
    if (selectedUsernames.has(member.username)) continue;
    await removeMember(
      client,
      userPoolId,
      groupName,
      member.username,
    );
    removedMemberCount += 1;
  }
  return {
    addedMemberCount,
    removedMemberCount,
  };
}

async function verifyFinalSelectedAdmin({
  client,
  groupName,
  maxMembers,
  maxPages,
  userPoolId,
  usernames,
}) {
  const finalMembers = await ensureExactFinalMembership({
    client,
    groupName,
    maxMembers,
    maxPages,
    userPoolId,
    usernames,
  });
  for (const username of usernames) {
    await verifySelectedAdmin({
      client,
      maxPages,
      postcondition: true,
      userPoolId,
      username,
    });
  }
  return finalMembers;
}

async function verifyInitialSelectedAdmin({
  client,
  maxPages,
  userPoolId,
  usernames,
}) {
  for (const username of usernames) {
    await verifySelectedAdmin({
      client,
      maxPages,
      userPoolId,
      username,
    });
  }
}

async function performReconciliation({
  client,
  compensationQuiescenceMs,
  groupName,
  maxMembers,
  maxPages,
  sleep,
  userPoolId,
  usernames,
}) {
  await verifyInitialSelectedAdmin({
    client,
    maxPages,
    userPoolId,
    usernames,
  });
  const originalMembers = await listMembers({
    client,
    groupName,
    maxMembers,
    maxPages,
    userPoolId,
  });
  const selectedUsernames = new Set(usernames);
  if (originalMembers.some((member) =>
    selectedUsernames.has(member.username)
    && member.enabled !== true)) {
    fail("Selected Cognito user could not be verified.");
  }
  const originalUsernames = new Set(
    originalMembers.map((member) => member.username),
  );
  const willMutate = usernames.some(
    (username) => !originalUsernames.has(username),
  ) || originalMembers.some(
    (member) => !selectedUsernames.has(member.username),
  );
  let mutationAttempted = false;
  try {
    mutationAttempted = willMutate;
    const change = await reconcileMembership({
      client,
      currentMembers: originalMembers,
      groupName,
      userPoolId,
      usernames,
    });
    const finalMembers = await verifyFinalSelectedAdmin({
      client,
      groupName,
      maxMembers,
      maxPages,
      userPoolId,
      usernames,
    });
    return {
      changed:
        change.addedMemberCount > 0 || change.removedMemberCount > 0,
      finalMemberCount: finalMembers.length,
      ...change,
    };
  } catch (error) {
    if (mutationAttempted) {
      await restoreMembershipSnapshotSafely({
        additionalMemberLimit: usernames.length,
        client,
        compensationQuiescenceMs,
        groupName,
        maxMembers,
        maxPages,
        originalMembers,
        sleep,
        userPoolId,
      });
    }
    throw error;
  }
}

export async function reconcileDemoOperator({
  client,
  compensationQuiescenceMs = DEFAULT_COMPENSATION_QUIESCENCE_MS,
  groupName,
  lease,
  maxMembers = DEFAULT_MAX_MEMBERS,
  maxPages = DEFAULT_MAX_PAGES,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  sleep = defaultSleep,
  userPoolId,
  usernames,
} = {}) {
  if (!client || typeof client.send !== "function") {
    fail("Cognito client configuration is invalid.");
  }
  validateGroupName(groupName);
  usernames = validateUsernames(usernames);
  validateLease(lease);
  validateBound(maxMembers, "Member count", 100_000);
  validateBound(maxPages, "Pagination page count", 1_000);
  validateBound(operationTimeoutMs, "AWS call timeout", 120_000);
  validateBound(
    compensationQuiescenceMs,
    "Compensation quiescence",
    120_000,
  );
  if (typeof sleep !== "function") {
    fail("Compensation sleep configuration is invalid.");
  }
  if (
    typeof userPoolId !== "string"
    || userPoolId.length === 0
    || userPoolId.length > USER_POOL_ID_MAX_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(userPoolId)
  ) {
    fail("Cognito user pool configuration is invalid.");
  }

  let leaseAcquired = false;
  let primaryError;
  let result;
  try {
    await acquireLease(lease);
    leaseAcquired = true;
    result = await performReconciliation({
      client: leasedClient(client, lease, operationTimeoutMs),
      compensationQuiescenceMs,
      groupName,
      maxMembers,
      maxPages,
      sleep,
      userPoolId,
      usernames,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    if (leaseAcquired) {
      await releaseLease(lease);
    }
  } catch (releaseError) {
    if (!primaryError) throw releaseError;
    if (!Object.hasOwn(primaryError, "cause")) {
      Object.defineProperty(primaryError, "cause", {
        configurable: true,
        enumerable: false,
        value: releaseError,
        writable: false,
      });
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function runCli({
  argv = process.argv.slice(2),
  clientFactory = (configuration) =>
    new CognitoIdentityProviderClient(configuration),
  dynamoClientFactory = (configuration) =>
    new DynamoDBClient(configuration),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    fail("Usage: reconcile-demo-operator.mjs");
  }
  const region = validateRegion(
    requiredEnvironmentValue(env, "AWS_REGION"),
  );
  const userPoolId = validateUserPoolId(
    requiredEnvironmentValue(env, "COGNITO_USER_POOL_ID"),
    region,
  );
  const groupName = validateGroupName(
    requiredEnvironmentValue(env, "COGNITO_DEMO_OPERATOR_GROUP"),
  );
  const tableName = requiredEnvironmentValue(
    env,
    "PLATFORM_STATE_TABLE_NAME",
  );
  const selection = parsePrivateSelection(
    await readPrivateStdin(stdin),
  );

  let client;
  let dynamoClient;
  try {
    const configuration = {
      ignoreConfiguredEndpointUrls: true,
      region,
    };
    client = clientFactory(configuration);
    dynamoClient = dynamoClientFactory(configuration);
  } catch {
    fail("AWS client configuration failed.");
  }
  const lease = createDynamoLease({
    client: dynamoClient,
    tableName,
    userPoolId,
  });
  const result = await reconcileDemoOperator({
    client,
    groupName,
    lease,
    userPoolId,
    usernames: selection.usernames,
  });
  try {
    stdout.write("Demo operator membership reconciled.\n");
  } catch {
    fail("Demo operator status output failed.");
  }
  return result;
}

const isExecutable = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isExecutable) {
  try {
    await runCli();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Demo operator reconciliation failed.",
    );
    process.exitCode = 1;
  }
}
