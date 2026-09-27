import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const USER_POOL_ID_PATTERN =
  /^[a-z]{2}(?:-gov)?-[a-z]+-\d+_[A-Za-z0-9]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const GROUP_PATTERN =
  /^domain-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const USER_STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,2048}$/;
const MAX_ATTRIBUTES = 128;
const MAX_USERS_PER_PAGE = 60;
const MAX_GROUPS_PER_PAGE = 60;
const MAX_INTERNAL_PAGES = 10;

export class AccessAdminCognitoDirectoryError extends Error {
  constructor() {
    super("The Cognito identity directory is temporarily unavailable.");
    this.name = "AccessAdminCognitoDirectoryError";
    this.code = "IDENTITY_UNAVAILABLE";
    this.statusCode = 503;
    this.retryable = true;
  }
}

function configurationError() {
  return new TypeError(
    "Access administration Cognito directory configuration is invalid.",
  );
}

function unavailable() {
  return new AccessAdminCognitoDirectoryError();
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

function boundedArray(value, maximum) {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    length === undefined
    || !Object.hasOwn(length, "value")
    || !Number.isSafeInteger(length.value)
    || length.value < 0
    || length.value > maximum
  ) {
    return null;
  }
  const result = [];
  for (let index = 0; index < length.value; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      item === undefined
      || !Object.hasOwn(item, "value")
      || item.enumerable !== true
    ) {
      return null;
    }
    result.push(item.value);
  }
  return result;
}

function validUsername(value) {
  return typeof value === "string" && USERNAME_PATTERN.test(value);
}

function validSubject(value) {
  return typeof value === "string" && SUBJECT_PATTERN.test(value);
}

function validGroupName(value) {
  return (
    typeof value === "string"
    && value.length <= 128
    && GROUP_PATTERN.test(value)
  );
}

function validToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function validateInput(value, keys) {
  if (
    !isPlainObject(value)
    || Reflect.ownKeys(value).length !== keys.length
    || Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    )
  ) {
    throw unavailable();
  }
}

function subjectFromAttributes(value) {
  const attributes = boundedArray(value, MAX_ATTRIBUTES);
  if (attributes === null) throw unavailable();
  const subjects = [];
  for (const attribute of attributes) {
    if (!isPlainObject(attribute)) throw unavailable();
    const name = ownData(attribute, "Name");
    const content = ownData(attribute, "Value");
    if (
      !name.present
      || typeof name.value !== "string"
      || name.value.length === 0
      || name.value.length > 128
      || !content.present
      || typeof content.value !== "string"
      || content.value.length === 0
      || content.value.length > 2048
      || /[\u0000-\u001f\u007f]/.test(content.value)
    ) {
      throw unavailable();
    }
    if (name.value === "sub") {
      if (!validSubject(content.value)) throw unavailable();
      subjects.push(content.value);
    }
  }
  if (subjects.length !== 1) throw unavailable();
  return subjects[0];
}

function projectUser(value, attributeKey, expected = {}) {
  if (!isPlainObject(value)) throw unavailable();
  const username = ownData(value, "Username");
  const enabled = ownData(value, "Enabled");
  const status = ownData(value, "UserStatus");
  const attributes = ownData(value, attributeKey);
  if (
    !username.present
    || !validUsername(username.value)
    || !enabled.present
    || typeof enabled.value !== "boolean"
    || !status.present
    || typeof status.value !== "string"
    || !USER_STATUS_PATTERN.test(status.value)
    || !attributes.present
  ) {
    throw unavailable();
  }
  const subject = subjectFromAttributes(attributes.value);
  if (
    (
      expected.username !== undefined
      && username.value !== expected.username
    )
    || (
      expected.subject !== undefined
      && subject !== expected.subject
    )
  ) {
    throw unavailable();
  }
  return Object.freeze({
    username: username.value,
    subject,
    enabled: enabled.value,
    userStatus: status.value,
  });
}

function usersPage(value, attributeKey, maximum) {
  const property = ownData(value, "Users");
  if (!property.present) throw unavailable();
  const users = boundedArray(property.value, maximum);
  if (users === null) throw unavailable();
  const items = users.map((user) => projectUser(user, attributeKey));
  if (
    new Set(items.map(({ username }) => username)).size !== items.length
    || new Set(items.map(({ subject }) => subject)).size !== items.length
  ) {
    throw unavailable();
  }
  return Object.freeze(items);
}

function pageToken(value, key) {
  const continuation = ownData(value, key);
  if (!continuation.present) return null;
  if (!validToken(continuation.value)) throw unavailable();
  return continuation.value;
}

function groupNames(value) {
  const property = ownData(value, "Groups");
  if (!property.present) throw unavailable();
  const groups = boundedArray(property.value, MAX_GROUPS_PER_PAGE);
  if (groups === null) throw unavailable();
  const names = [];
  for (const group of groups) {
    const name = ownData(group, "GroupName");
    if (
      !name.present
      || typeof name.value !== "string"
      || name.value.length === 0
      || name.value.length > 128
      || /[\s\u0000-\u001f\u007f]/.test(name.value)
    ) {
      throw unavailable();
    }
    names.push(name.value);
  }
  return names;
}

function isNotFound(error) {
  return error?.name === "UserNotFoundException";
}

export function createAccessAdminCognitoDirectory({
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

  async function getUserInternal(username) {
    try {
      const response = await client.send(new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }));
      return projectUser(response, "UserAttributes", { username });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw unavailable();
    }
  }

  async function currentGroups(username) {
    const names = new Set();
    const seenTokens = new Set();
    let nextToken;
    for (let page = 0; page < MAX_INTERNAL_PAGES; page += 1) {
      let response;
      try {
        response = await client.send(
          new AdminListGroupsForUserCommand({
            UserPoolId: userPoolId,
            Username: username,
            Limit: MAX_GROUPS_PER_PAGE,
            ...(nextToken === undefined
              ? {}
              : { NextToken: nextToken }),
          }),
        );
      } catch {
        throw unavailable();
      }
      for (const name of groupNames(response)) names.add(name);
      const continuation = pageToken(response, "NextToken");
      if (continuation === null) return names;
      if (
        continuation === nextToken
        || seenTokens.has(continuation)
        || page + 1 >= MAX_INTERNAL_PAGES
      ) {
        throw unavailable();
      }
      seenTokens.add(continuation);
      nextToken = continuation;
    }
    throw unavailable();
  }

  async function exactMembership({ username, subject, groupName }) {
    const user = await getUserInternal(username);
    if (user === null || user.subject !== subject) throw unavailable();
    return (await currentGroups(username)).has(groupName);
  }

  async function mutateMembership({
    username,
    subject,
    groupName,
    desired,
  }) {
    const current = (await currentGroups(username)).has(groupName);
    const user = await getUserInternal(username);
    if (user === null || user.subject !== subject) throw unavailable();
    if (current === desired) {
      return Object.freeze({ changed: false });
    }
    try {
      await client.send(
        desired
          ? new AdminAddUserToGroupCommand({
              UserPoolId: userPoolId,
              Username: username,
              GroupName: groupName,
            })
          : new AdminRemoveUserFromGroupCommand({
              UserPoolId: userPoolId,
              Username: username,
              GroupName: groupName,
            }),
      );
    } catch {
      throw unavailable();
    }
    const verified = await getUserInternal(username);
    if (verified === null || verified.subject !== subject) {
      throw unavailable();
    }
    return Object.freeze({ changed: true });
  }

  return Object.freeze({
    async listDomainMembers(input) {
      if (
        !isPlainObject(input)
        || Reflect.ownKeys(input).some(
          (key) =>
            typeof key !== "string"
            || !["groupName", "limit", "cursor"].includes(key),
        )
        || !Object.hasOwn(input, "groupName")
        || !Object.hasOwn(input, "limit")
        || !validGroupName(input.groupName)
        || !Number.isSafeInteger(input.limit)
        || input.limit < 1
        || input.limit > 50
        || (
          Object.hasOwn(input, "cursor")
          && !validToken(input.cursor)
        )
      ) {
        throw unavailable();
      }
      try {
        const response = await client.send(
          new ListUsersInGroupCommand({
            UserPoolId: userPoolId,
            GroupName: input.groupName,
            Limit: input.limit,
            ...(Object.hasOwn(input, "cursor")
              ? { NextToken: input.cursor }
              : {}),
          }),
        );
        const items = usersPage(
          response,
          "Attributes",
          input.limit,
        );
        const cursor = pageToken(response, "NextToken");
        if (
          cursor !== null
          && Object.hasOwn(input, "cursor")
          && cursor === input.cursor
        ) {
          throw unavailable();
        }
        return Object.freeze({ items, cursor });
      } catch (error) {
        if (error instanceof AccessAdminCognitoDirectoryError) throw error;
        throw unavailable();
      }
    },

    async getUser(input) {
      validateInput(input, ["username"]);
      if (!validUsername(input.username)) throw unavailable();
      return getUserInternal(input.username);
    },

    async getUserBySubject(input) {
      validateInput(input, ["subject"]);
      if (!validSubject(input.subject)) throw unavailable();
      const matches = [];
      const seenTokens = new Set();
      let paginationToken;
      for (let page = 0; page < MAX_INTERNAL_PAGES; page += 1) {
        let response;
        try {
          response = await client.send(new ListUsersCommand({
            UserPoolId: userPoolId,
            Filter: `sub = "${input.subject}"`,
            Limit: MAX_USERS_PER_PAGE,
            ...(paginationToken === undefined
              ? {}
              : { PaginationToken: paginationToken }),
          }));
        } catch {
          throw unavailable();
        }
        for (const user of usersPage(
          response,
          "Attributes",
          MAX_USERS_PER_PAGE,
        )) {
          if (user.subject !== input.subject) throw unavailable();
          matches.push(user);
          if (matches.length > 1) throw unavailable();
        }
        const continuation = pageToken(response, "PaginationToken");
        if (continuation === null) return matches[0] ?? null;
        if (
          continuation === paginationToken
          || seenTokens.has(continuation)
          || page + 1 >= MAX_INTERNAL_PAGES
        ) {
          throw unavailable();
        }
        seenTokens.add(continuation);
        paginationToken = continuation;
      }
      throw unavailable();
    },

    async isDomainMember(input) {
      validateInput(input, ["username", "subject", "groupName"]);
      if (
        !validUsername(input.username)
        || !validSubject(input.subject)
        || !validGroupName(input.groupName)
      ) {
        throw unavailable();
      }
      return exactMembership(input);
    },

    async addDomainMember(input) {
      validateInput(input, ["username", "subject", "groupName"]);
      if (
        !validUsername(input.username)
        || !validSubject(input.subject)
        || !validGroupName(input.groupName)
      ) {
        throw unavailable();
      }
      return mutateMembership({ ...input, desired: true });
    },

    async removeDomainMember(input) {
      validateInput(input, ["username", "subject", "groupName"]);
      if (
        !validUsername(input.username)
        || !validSubject(input.subject)
        || !validGroupName(input.groupName)
      ) {
        throw unavailable();
      }
      return mutateMembership({ ...input, desired: false });
    },
  });
}
