import {
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  ListUsersInGroupCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";

const OWNER_GROUP_PATTERN =
  /^domain-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const COMMERCIAL_USER_POOL_ID_PATTERN =
  /^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d+_[A-Za-z0-9]+$/;
const MAX_GROUP_NAME_LENGTH = 128;
const MAX_USER_POOL_ID_LENGTH = 55;
const DELETE_CONFIRMATION_ATTEMPTS = 3;
const DELETE_CONFIRMATION_DELAY_MS = 25;
const DATE_GET_TIME = Date.prototype.getTime;
const INTRINSIC_APPLY = Reflect.apply;
const GROUP_RESPONSE_KEYS = Object.freeze([
  "CreationDate",
  "Description",
  "GroupName",
  "LastModifiedDate",
  "Precedence",
  "RoleArn",
  "UserPoolId",
]);

export class DomainGroupConflictError extends Error {
  constructor() {
    super("The Cognito domain group is not managed by this operation.");
    this.name = "DomainGroupConflictError";
    this.code = "DOMAIN_GROUP_CONFLICT";
    this.statusCode = 409;
    this.retryable = false;
  }
}

function configurationError() {
  return new TypeError("Domain directory configuration is invalid.");
}

function groupNameError() {
  return new TypeError("Domain group name is invalid.");
}

function operationTokenError() {
  return new TypeError("Domain group operation token is invalid.");
}

function responseError() {
  return new TypeError("Cognito domain group response is invalid.");
}

function membershipResponseError() {
  return new TypeError(
    "Cognito domain group membership response is invalid.",
  );
}

function groupNotEmptyError() {
  return new TypeError("Cognito domain group is not empty.");
}

function deletionUnconfirmedError() {
  return new TypeError(
    "Cognito domain group deletion was not confirmed.",
  );
}

function isPlainObject(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value, key) {
  if (!isPlainObject(value)) {
    return Object.freeze({ present: false, value: undefined });
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  ) {
    return Object.freeze({ present: false, value: undefined });
  }
  return Object.freeze({ present: true, value: descriptor.value });
}

function dataMethod(value, key) {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }
  let current = value;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, "value")
        && typeof descriptor.value === "function"
        ? descriptor.value
        : null;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function exactOwnKeys(value, allowedKeys) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every(
      (key) => typeof key === "string" && allowedKeys.includes(key),
    )
    && new Set(keys).size === keys.length
  );
}

function validMetadataProperty(value) {
  const metadata = ownData(value, "$metadata");
  return (
    !Object.hasOwn(value, "$metadata")
    || (metadata.present && isPlainObject(metadata.value))
  );
}

function validDateProperty(value, key) {
  const property = ownData(value, key);
  if (!Object.hasOwn(value, key)) return true;
  if (!property.present) return false;
  try {
    return Number.isFinite(
      INTRINSIC_APPLY(DATE_GET_TIME, property.value, []),
    );
  } catch {
    return false;
  }
}

function validateOwnerGroup(ownerGroup) {
  if (
    typeof ownerGroup !== "string"
    || ownerGroup.length > MAX_GROUP_NAME_LENGTH
    || !OWNER_GROUP_PATTERN.test(ownerGroup)
  ) {
    throw groupNameError();
  }
  return ownerGroup;
}

function validateOperationToken(operationToken) {
  if (
    typeof operationToken !== "string"
    || !OPERATION_TOKEN_PATTERN.test(operationToken)
  ) {
    throw operationTokenError();
  }
  return operationToken;
}

export function domainGroupDescription(ownerGroup, operationToken) {
  const groupName = validateOwnerGroup(ownerGroup);
  const token = validateOperationToken(operationToken);
  return [
    "agentic-ai-platform-demo:domain-group:v2",
    `ownerGroup=${groupName}`,
    `operationToken=${token}`,
    "auto-delete=no",
  ].join(";");
}

function groupFromResponse(response) {
  if (
    !exactOwnKeys(response, ["Group", "$metadata"])
    || !validMetadataProperty(response)
  ) {
    throw responseError();
  }
  const groupProperty = ownData(response, "Group");
  if (
    !groupProperty.present
    || !exactOwnKeys(groupProperty.value, GROUP_RESPONSE_KEYS)
  ) {
    throw responseError();
  }
  const group = groupProperty.value;
  const name = ownData(group, "GroupName");
  const pool = ownData(group, "UserPoolId");
  const description = ownData(group, "Description");
  if (
    !name.present
    || typeof name.value !== "string"
    || !pool.present
    || typeof pool.value !== "string"
    || !description.present
    || typeof description.value !== "string"
    || !validDateProperty(group, "CreationDate")
    || !validDateProperty(group, "LastModifiedDate")
  ) {
    throw responseError();
  }
  return Object.freeze({
    description: description.value,
    hasPrecedence: Object.hasOwn(group, "Precedence"),
    hasRoleArn: Object.hasOwn(group, "RoleArn"),
    name: name.value,
    userPoolId: pool.value,
  });
}

function exactManagedGroup(group, expected) {
  return (
    group.name === expected.ownerGroup
    && group.userPoolId === expected.userPoolId
    && group.description === expected.description
    && !group.hasRoleArn
    && !group.hasPrecedence
  );
}

function validateCreatedGroup(response, expected) {
  if (!exactManagedGroup(groupFromResponse(response), expected)) {
    throw responseError();
  }
}

function validateExistingGroup(response, expected) {
  if (!exactManagedGroup(groupFromResponse(response), expected)) {
    throw new DomainGroupConflictError();
  }
}

function validateEmptyMembership(response) {
  if (
    !exactOwnKeys(response, ["Users", "$metadata"])
    || !validMetadataProperty(response)
  ) {
    throw membershipResponseError();
  }
  const usersProperty = ownData(response, "Users");
  if (!usersProperty.present || !Array.isArray(usersProperty.value)) {
    throw membershipResponseError();
  }
  const users = usersProperty.value;
  const length = Object.getOwnPropertyDescriptor(users, "length");
  if (
    length === undefined
    || !Object.hasOwn(length, "value")
    || !Number.isSafeInteger(length.value)
    || length.value < 0
    || length.value > 1
  ) {
    throw membershipResponseError();
  }
  for (let index = 0; index < length.value; index += 1) {
    const item = Object.getOwnPropertyDescriptor(users, String(index));
    if (
      item === undefined
      || !Object.hasOwn(item, "value")
      || item.enumerable !== true
    ) {
      throw membershipResponseError();
    }
  }
  const expectedKeys = length.value === 0
    ? ["length"]
    : ["0", "length"];
  const keys = Reflect.ownKeys(users);
  if (
    keys.length !== expectedKeys.length
    || keys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    throw membershipResponseError();
  }
  if (length.value !== 0) throw groupNotEmptyError();
}

function validateDeleteResponse(response) {
  if (
    !exactOwnKeys(response, ["$metadata"])
    || !validMetadataProperty(response)
  ) {
    throw responseError();
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function readConfiguration(configuration) {
  if (!isPlainObject(configuration)) throw configurationError();
  const keys = Reflect.ownKeys(configuration);
  const hasSleep = keys.includes("sleep");
  const expectedKeys = hasSleep
    ? ["cognito", "sleep", "userPoolId"]
    : ["cognito", "userPoolId"];
  if (
    keys.length !== expectedKeys.length
    || keys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    throw configurationError();
  }

  const cognito = ownData(configuration, "cognito");
  const userPoolId = ownData(configuration, "userPoolId");
  const sleep = ownData(configuration, "sleep");
  const send = dataMethod(cognito.value, "send");
  if (
    !cognito.present
    || send === null
    || !userPoolId.present
    || typeof userPoolId.value !== "string"
    || userPoolId.value.length > MAX_USER_POOL_ID_LENGTH
    || !COMMERCIAL_USER_POOL_ID_PATTERN.test(userPoolId.value)
    || (
      hasSleep
      && (!sleep.present || typeof sleep.value !== "function")
    )
  ) {
    throw configurationError();
  }
  return Object.freeze({
    cognito: cognito.value,
    send,
    sleep: hasSleep ? sleep.value : defaultSleep,
    userPoolId: userPoolId.value,
  });
}

export function createDomainDirectory(configuration) {
  const {
    cognito,
    send,
    sleep,
    userPoolId,
  } = readConfiguration(configuration);

  async function getGroup(ownerGroup) {
    return Reflect.apply(send, cognito, [
      new GetGroupCommand({
        UserPoolId: userPoolId,
        GroupName: ownerGroup,
      }),
    ]);
  }

  async function confirmDeleted(expected, deleteFailure) {
    for (
      let attempt = 0;
      attempt < DELETE_CONFIRMATION_ATTEMPTS;
      attempt += 1
    ) {
      let response;
      try {
        response = await getGroup(expected.ownerGroup);
      } catch (lookupError) {
        if (lookupError instanceof ResourceNotFoundException) return;
        throw lookupError;
      }
      validateExistingGroup(response, expected);
      if (attempt + 1 < DELETE_CONFIRMATION_ATTEMPTS) {
        await sleep(DELETE_CONFIRMATION_DELAY_MS);
      }
    }
    if (deleteFailure !== null) throw deleteFailure;
    throw deletionUnconfirmedError();
  }

  return Object.freeze({
    async ensureGroup(ownerGroup, operationToken) {
      const description = domainGroupDescription(
        ownerGroup,
        operationToken,
      );
      const expected = {
        description,
        ownerGroup,
        userPoolId,
      };
      let response;
      try {
        response = await Reflect.apply(send, cognito, [
          new CreateGroupCommand({
            UserPoolId: userPoolId,
            GroupName: ownerGroup,
            Description: description,
          }),
        ]);
      } catch (createError) {
        try {
          response = await getGroup(ownerGroup);
        } catch (lookupError) {
          if (lookupError instanceof ResourceNotFoundException) {
            throw createError;
          }
          throw lookupError;
        }
        validateExistingGroup(response, expected);
        return;
      }
      validateCreatedGroup(response, expected);
    },

    async deleteGroupExact(ownerGroup, operationToken) {
      const description = domainGroupDescription(
        ownerGroup,
        operationToken,
      );
      const expected = {
        description,
        ownerGroup,
        userPoolId,
      };
      let response;
      try {
        response = await getGroup(ownerGroup);
      } catch (lookupError) {
        if (lookupError instanceof ResourceNotFoundException) return;
        throw lookupError;
      }
      validateExistingGroup(response, expected);

      response = await Reflect.apply(send, cognito, [
        new ListUsersInGroupCommand({
          UserPoolId: userPoolId,
          GroupName: ownerGroup,
          Limit: 1,
        }),
      ]);
      validateEmptyMembership(response);

      let deleteFailure = null;
      try {
        response = await Reflect.apply(send, cognito, [
          new DeleteGroupCommand({
            UserPoolId: userPoolId,
            GroupName: ownerGroup,
          }),
        ]);
        validateDeleteResponse(response);
      } catch (error) {
        deleteFailure = error;
      }
      await confirmDeleted(expected, deleteFailure);
    },
  });
}
