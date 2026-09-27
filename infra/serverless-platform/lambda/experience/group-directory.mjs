import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const USER_POOL_ID_PATTERN =
  /^[a-z]{2}(?:-gov)?-[a-z]+-\d+_[A-Za-z0-9]+$/;
const MAX_USERNAME_LENGTH = 128;
const MAX_SUBJECT_LENGTH = 128;
const MAX_USER_ATTRIBUTES = 128;
const MAX_GROUP_NAME_LENGTH = 128;
const MAX_GROUP_PAGES = 10;
const GROUP_PAGE_LIMIT = 60;
const MAX_NEXT_TOKEN_LENGTH = 2048;
const INVALID_TEXT = /[\s\u0000-\u001f\u007f]/u;

export class CognitoGroupDirectoryError extends Error {
  constructor() {
    super("Current Cognito group membership is unavailable.");
    this.name = "CognitoGroupDirectoryError";
    this.code = "IDENTITY_UNAVAILABLE";
    this.statusCode = 503;
    this.retryable = true;
  }
}

function configurationError() {
  return new TypeError(
    "Cognito group directory configuration is invalid.",
  );
}

function unavailableError() {
  return new CognitoGroupDirectoryError();
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

function ownDataValue(value, key) {
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

function strictText(value, maximumLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || value !== value.trim()
    || INVALID_TEXT.test(value)
  ) {
    return null;
  }
  return value;
}

function ownStrictText(value, key, maximumLength) {
  const property = ownDataValue(value, key);
  if (!property.present) return null;
  return strictText(property.value, maximumLength);
}

function boundedArray(value, maximumLength) {
  if (!Array.isArray(value)) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, "value")
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumLength
  ) {
    return null;
  }

  const items = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    );
    if (
      descriptor === undefined
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      return null;
    }
    items.push(descriptor.value);
  }
  return items;
}

function claimsIdentity(claims) {
  if (!isPlainObject(claims)) return null;
  const subject = ownStrictText(claims, "sub", MAX_SUBJECT_LENGTH);
  if (!subject) return null;

  const usernameProperties = [
    ownDataValue(claims, "cognito:username"),
    ownDataValue(claims, "username"),
  ].filter(({ present }) => present);
  if (usernameProperties.length === 0) return null;

  const usernames = usernameProperties.map(({ value }) =>
    strictText(value, MAX_USERNAME_LENGTH));
  if (
    usernames.some((username) => username === null)
    || new Set(usernames).size !== 1
  ) {
    return null;
  }
  return Object.freeze({ subject, username: usernames[0] });
}

function authoritativeSubject(user) {
  const property = ownDataValue(user, "UserAttributes");
  if (!property.present) return null;
  const attributes = boundedArray(
    property.value,
    MAX_USER_ATTRIBUTES,
  );
  if (attributes === null) return null;

  const subjects = [];
  for (const attribute of attributes) {
    if (!isPlainObject(attribute)) return null;
    const name = ownStrictText(attribute, "Name", 128);
    const value = ownDataValue(attribute, "Value");
    if (
      !name
      || !value.present
      || typeof value.value !== "string"
      || value.value.length === 0
      || value.value.length > 2048
      || /[\u0000-\u001f\u007f]/u.test(value.value)
    ) {
      return null;
    }
    if (name === "sub") {
      const subject = strictText(value.value, MAX_SUBJECT_LENGTH);
      if (!subject) return null;
      subjects.push(subject);
    }
  }
  return subjects.length === 1 ? subjects[0] : null;
}

function validCurrentUser(user, identity) {
  if (!isPlainObject(user)) return false;
  const enabled = ownDataValue(user, "Enabled");
  return (
    ownStrictText(user, "Username", MAX_USERNAME_LENGTH)
      === identity.username
    && enabled.present
    && enabled.value === true
    && authoritativeSubject(user) === identity.subject
  );
}

function pageGroups(response) {
  if (!isPlainObject(response)) return null;
  const property = ownDataValue(response, "Groups");
  if (!property.present) return null;
  const groups = boundedArray(property.value, GROUP_PAGE_LIMIT);
  if (groups === null) return null;

  const names = [];
  for (const group of groups) {
    const name = ownStrictText(
      group,
      "GroupName",
      MAX_GROUP_NAME_LENGTH,
    );
    if (!name) return null;
    names.push(name);
  }
  return names;
}

function nextPageToken(response) {
  const property = ownDataValue(response, "NextToken");
  if (!property.present) {
    return Object.freeze({ continuation: null, done: true });
  }
  const continuation = strictText(property.value, MAX_NEXT_TOKEN_LENGTH);
  if (!continuation) return null;
  return Object.freeze({ continuation, done: false });
}

function sortedGroups(groups) {
  return Object.freeze(
    [...groups].sort((left, right) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
}

export function createCognitoGroupDirectory({
  client,
  userPoolId,
} = {}) {
  if (
    !client
    || typeof client.send !== "function"
    || typeof userPoolId !== "string"
    || !USER_POOL_ID_PATTERN.test(userPoolId)
  ) {
    throw configurationError();
  }

  return Object.freeze({
    async resolveCurrentGroups(claims) {
      try {
        const identity = claimsIdentity(claims);
        if (!identity) throw unavailableError();

        const user = await client.send(new AdminGetUserCommand({
          UserPoolId: userPoolId,
          Username: identity.username,
        }));
        if (!validCurrentUser(user, identity)) {
          throw unavailableError();
        }

        const groups = new Set();
        const seenTokens = new Set();
        let nextToken;
        for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
          const response = await client.send(
            new AdminListGroupsForUserCommand({
              UserPoolId: userPoolId,
              Username: identity.username,
              Limit: GROUP_PAGE_LIMIT,
              ...(nextToken ? { NextToken: nextToken } : {}),
            }),
          );
          const names = pageGroups(response);
          const pagination = nextPageToken(response);
          if (names === null || pagination === null) {
            throw unavailableError();
          }
          for (const name of names) groups.add(name);
          if (pagination.done) return sortedGroups(groups);
          if (
            seenTokens.has(pagination.continuation)
            || page + 1 >= MAX_GROUP_PAGES
          ) {
            throw unavailableError();
          }
          seenTokens.add(pagination.continuation);
          nextToken = pagination.continuation;
        }
        throw unavailableError();
      } catch {
        throw unavailableError();
      }
    },
  });
}
