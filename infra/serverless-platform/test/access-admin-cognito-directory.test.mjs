import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const directoryModule = await import(
  "../lambda/access-admin/cognito-directory.mjs"
).catch(() => Object.freeze({}));

const {
  AccessAdminCognitoDirectoryError,
  createAccessAdminCognitoDirectory,
} = directoryModule;

const USER_POOL_ID = "us-west-2_example";
const USERNAME = "member.one";
const SUBJECT = "11111111-2222-3333-4444-555555555555";
const GROUP_NAME = "domain-customer-support";

function cognitoUser(overrides = {}) {
  return {
    Username: USERNAME,
    Enabled: true,
    UserStatus: "CONFIRMED",
    Attributes: [
      { Name: "email", Value: "private@example.com" },
      { Name: "sub", Value: SUBJECT },
    ],
    ...overrides,
  };
}

function adminUser(overrides = {}) {
  const user = cognitoUser(overrides);
  return {
    Username: user.Username,
    Enabled: user.Enabled,
    UserStatus: user.UserStatus,
    UserAttributes: user.Attributes,
  };
}

function safeUser() {
  return {
    username: USERNAME,
    subject: SUBJECT,
    enabled: true,
    userStatus: "CONFIRMED",
  };
}

function sanitizedFailure(secret = "") {
  return (error) => (
    error instanceof AccessAdminCognitoDirectoryError
    && error.code === "IDENTITY_UNAVAILABLE"
    && error.statusCode === 503
    && error.retryable === true
    && error.cause === undefined
    && (secret === "" || !String(error).includes(secret))
  );
}

test("lists one bounded domain-group page with safe user projection", async () => {
  assert.equal(typeof createAccessAdminCognitoDirectory, "function");
  const calls = [];
  const directory = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        calls.push(command);
        return {
          Users: [cognitoUser()],
          NextToken: "next-page",
          $metadata: { requestId: "private-provider-request" },
        };
      },
    },
  });

  const result = await directory.listDomainMembers({
    groupName: GROUP_NAME,
    limit: 25,
    cursor: "current-page",
  });

  assert.deepEqual(result, {
    items: [safeUser()],
    cursor: "next-page",
  });
  assert.equal(JSON.stringify(result).includes("private@example.com"), false);
  assert.ok(calls[0] instanceof ListUsersInGroupCommand);
  assert.deepEqual(calls[0].input, {
    UserPoolId: USER_POOL_ID,
    GroupName: GROUP_NAME,
    Limit: 25,
    NextToken: "current-page",
  });
});

test("rejects malformed and immediately cyclic group pagination", async () => {
  for (const response of [
    { Users: [cognitoUser()], NextToken: "same-page" },
    { Users: [cognitoUser(), cognitoUser()] },
    { Users: [{ ...cognitoUser(), Username: "member two" }] },
    { Users: [cognitoUser({ Attributes: [] })] },
  ]) {
    const directory = createAccessAdminCognitoDirectory({
      userPoolId: USER_POOL_ID,
      client: {
        async send() {
          return response;
        },
      },
    });
    await assert.rejects(
      directory.listDomainMembers({
        groupName: GROUP_NAME,
        limit: 20,
        ...(response.NextToken === "same-page"
          ? { cursor: "same-page" }
          : {}),
      }),
      sanitizedFailure(),
    );
  }
});

test("gets a user by exact username without exposing attributes", async () => {
  const calls = [];
  const directory = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        calls.push(command);
        return adminUser();
      },
    },
  });

  assert.deepEqual(
    await directory.getUser({ username: USERNAME }),
    safeUser(),
  );
  assert.ok(calls[0] instanceof AdminGetUserCommand);
  assert.deepEqual(calls[0].input, {
    UserPoolId: USER_POOL_ID,
    Username: USERNAME,
  });
});

test("returns null only for exact Cognito not-found responses", async () => {
  const directory = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send() {
        throw Object.assign(new Error("private missing user"), {
          name: "UserNotFoundException",
        });
      },
    },
  });

  assert.equal(
    await directory.getUser({ username: USERNAME }),
    null,
  );
});

test("resolves a subject with strict bounded and cycle-safe pagination", async () => {
  const calls = [];
  const pages = [
    { Users: [], PaginationToken: "page-two" },
    { Users: [cognitoUser()] },
  ];
  const directory = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        calls.push(command);
        return pages.shift();
      },
    },
  });

  assert.deepEqual(
    await directory.getUserBySubject({ subject: SUBJECT }),
    safeUser(),
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((command) => command instanceof ListUsersCommand));
  assert.deepEqual(calls.map(({ input }) => input), [
    {
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${SUBJECT}"`,
      Limit: 60,
    },
    {
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${SUBJECT}"`,
      Limit: 60,
      PaginationToken: "page-two",
    },
  ]);
});

test("rejects repeated subject-search tokens and ambiguous exact subjects", async () => {
  const repeated = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send() {
        return { Users: [], PaginationToken: "repeat" };
      },
    },
  });
  await assert.rejects(
    repeated.getUserBySubject({ subject: SUBJECT }),
    sanitizedFailure(),
  );

  const ambiguous = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send() {
        return {
          Users: [
            cognitoUser(),
            cognitoUser({ Username: "member.two" }),
          ],
        };
      },
    },
  });
  await assert.rejects(
    ambiguous.getUserBySubject({ subject: SUBJECT }),
    sanitizedFailure(),
  );
});

test("binds domain membership checks to exact username and subject", async () => {
  const calls = [];
  const pages = [
    {
      Groups: [{ GroupName: "platform-admin" }],
      NextToken: "groups-two",
    },
    {
      Groups: [{ GroupName: GROUP_NAME }],
    },
  ];
  const directory = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        calls.push(command);
        if (command instanceof AdminGetUserCommand) return adminUser();
        return pages.shift();
      },
    },
  });

  assert.equal(
    await directory.isDomainMember({
      username: USERNAME,
      subject: SUBJECT,
      groupName: GROUP_NAME,
    }),
    true,
  );
  assert.ok(calls[1] instanceof AdminListGroupsForUserCommand);
  assert.deepEqual(calls[1].input, {
    UserPoolId: USER_POOL_ID,
    Username: USERNAME,
    Limit: 60,
  });
  assert.deepEqual(calls[2].input, {
    UserPoolId: USER_POOL_ID,
    Username: USERNAME,
    Limit: 60,
    NextToken: "groups-two",
  });
});

test("domain membership mutations are idempotent and use server group names", async () => {
  const commands = [];
  let groups = [];
  const directory = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        commands.push(command);
        if (command instanceof AdminGetUserCommand) return adminUser();
        if (command instanceof AdminListGroupsForUserCommand) {
          return { Groups: groups.map((GroupName) => ({ GroupName })) };
        }
        if (command instanceof AdminAddUserToGroupCommand) {
          groups = [GROUP_NAME];
          return {};
        }
        if (command instanceof AdminRemoveUserFromGroupCommand) {
          groups = [];
          return {};
        }
        throw new Error("unexpected command");
      },
    },
  });

  assert.deepEqual(
    await directory.addDomainMember({
      username: USERNAME,
      subject: SUBJECT,
      groupName: GROUP_NAME,
    }),
    { changed: true },
  );
  assert.deepEqual(
    await directory.addDomainMember({
      username: USERNAME,
      subject: SUBJECT,
      groupName: GROUP_NAME,
    }),
    { changed: false },
  );
  assert.deepEqual(
    await directory.removeDomainMember({
      username: USERNAME,
      subject: SUBJECT,
      groupName: GROUP_NAME,
    }),
    { changed: true },
  );
  assert.deepEqual(
    await directory.removeDomainMember({
      username: USERNAME,
      subject: SUBJECT,
      groupName: GROUP_NAME,
    }),
    { changed: false },
  );
  const add = commands.find(
    (command) => command instanceof AdminAddUserToGroupCommand,
  );
  const remove = commands.find(
    (command) => command instanceof AdminRemoveUserFromGroupCommand,
  );
  assert.deepEqual(add.input, {
    UserPoolId: USER_POOL_ID,
    Username: USERNAME,
    GroupName: GROUP_NAME,
  });
  assert.deepEqual(remove.input, add.input);
});

test("rejects username replacement immediately before group mutations", async (t) => {
  for (const [name, method, mutationType, initialGroups] of [
    ["add", "addDomainMember", AdminAddUserToGroupCommand, []],
    [
      "remove",
      "removeDomainMember",
      AdminRemoveUserFromGroupCommand,
      [GROUP_NAME],
    ],
  ]) {
    await t.test(name, async () => {
      const commands = [];
      const directory = createAccessAdminCognitoDirectory({
        userPoolId: USER_POOL_ID,
        client: {
          async send(command) {
            commands.push(command);
            if (command instanceof AdminGetUserCommand) {
              return adminUser({
                Attributes: [{
                  Name: "sub",
                  Value: "replacement-sub",
                }],
              });
            }
            if (command instanceof AdminListGroupsForUserCommand) {
              return {
                Groups: initialGroups.map(
                  (GroupName) => ({ GroupName }),
                ),
              };
            }
            throw new Error("unexpected command");
          },
        },
      });

      await assert.rejects(
        directory[method]({
          username: USERNAME,
          subject: SUBJECT,
          groupName: GROUP_NAME,
        }),
        sanitizedFailure(),
      );
      assert.equal(
        commands.some((command) => command instanceof mutationType),
        false,
      );
      assert.equal(
        commands.filter(
          (command) => command instanceof AdminGetUserCommand,
        ).length,
        1,
      );
    });
  }
});

test("detects username replacement immediately after group mutations", async (t) => {
  for (const [name, method, mutationType, initialGroups] of [
    ["add", "addDomainMember", AdminAddUserToGroupCommand, []],
    [
      "remove",
      "removeDomainMember",
      AdminRemoveUserFromGroupCommand,
      [GROUP_NAME],
    ],
  ]) {
    await t.test(name, async () => {
      const commands = [];
      let userReads = 0;
      const directory = createAccessAdminCognitoDirectory({
        userPoolId: USER_POOL_ID,
        client: {
          async send(command) {
            commands.push(command);
            if (command instanceof AdminGetUserCommand) {
              userReads += 1;
              return userReads === 1
                ? adminUser()
                : adminUser({
                    Attributes: [{
                      Name: "sub",
                      Value: "replacement-sub",
                    }],
                  });
            }
            if (command instanceof AdminListGroupsForUserCommand) {
              return {
                Groups: initialGroups.map(
                  (GroupName) => ({ GroupName }),
                ),
              };
            }
            if (command instanceof mutationType) return {};
            throw new Error("unexpected command");
          },
        },
      });

      await assert.rejects(
        directory[method]({
          username: USERNAME,
          subject: SUBJECT,
          groupName: GROUP_NAME,
        }),
        sanitizedFailure(),
      );
      assert.equal(
        commands.filter(
          (command) => command instanceof mutationType,
        ).length,
        1,
      );
      assert.equal(userReads, 2);
    });
  }
});

test("configuration and provider failures are strict and non-disclosing", async () => {
  for (const configuration of [
    undefined,
    {},
    { client: {}, userPoolId: USER_POOL_ID },
    { client: { send() {} }, userPoolId: "pool-id" },
  ]) {
    assert.throws(
      () => createAccessAdminCognitoDirectory(configuration),
      /Access administration Cognito directory configuration is invalid/,
    );
  }

  const secret = "private-cognito-detail";
  const directory = createAccessAdminCognitoDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send() {
        throw new Error(secret);
      },
    },
  });
  await assert.rejects(
    directory.listDomainMembers({
      groupName: GROUP_NAME,
      limit: 20,
    }),
    sanitizedFailure(secret),
  );
});
