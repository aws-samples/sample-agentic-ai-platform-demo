import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const groupDirectory = await import(
  "../lambda/experience/group-directory.mjs"
).catch(() => Object.freeze({}));

const {
  CognitoGroupDirectoryError,
  createCognitoGroupDirectory,
} = groupDirectory;

const USER_POOL_ID = "us-west-2_example";
const CLAIMS = Object.freeze({
  sub: "11111111-2222-3333-4444-555555555555",
  "cognito:username": "operator-user",
});

function cognitoUser({
  enabled = true,
  sub = CLAIMS.sub,
  username = CLAIMS["cognito:username"],
} = {}) {
  return {
    Username: username,
    Enabled: enabled,
    UserStatus: "CONFIRMED",
    UserAttributes: [
      { Name: "email", Value: "operator@example.com" },
      { Name: "sub", Value: sub },
    ],
  };
}

function sanitizedDirectoryFailure(secret = "") {
  return (error) => (
    error instanceof CognitoGroupDirectoryError
    && error.name === "CognitoGroupDirectoryError"
    && error.code === "IDENTITY_UNAVAILABLE"
    && error.statusCode === 503
    && error.retryable === true
    && error.message === "Current Cognito group membership is unavailable."
    && error.cause === undefined
    && (secret === "" || !String(error).includes(secret))
  );
}

test("resolves the current enabled user's exact paginated groups", async () => {
  assert.equal(typeof createCognitoGroupDirectory, "function");
  const calls = [];
  const pages = [
    {
      Groups: [
        { GroupName: "domain-operations" },
        { GroupName: "platform-admin" },
      ],
      NextToken: "page-two",
    },
    {
      Groups: [
        { GroupName: "demo-operator" },
        { GroupName: "platform-admin" },
      ],
    },
  ];
  const directory = createCognitoGroupDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        calls.push(command);
        if (command instanceof AdminGetUserCommand) {
          return cognitoUser();
        }
        return pages.shift();
      },
    },
  });

  const groups = await directory.resolveCurrentGroups(CLAIMS);

  assert.deepEqual(groups, [
    "demo-operator",
    "domain-operations",
    "platform-admin",
  ]);
  assert.equal(Object.isFrozen(groups), true);
  assert.equal(Object.isFrozen(directory), true);
  assert.deepEqual(
    calls.map((command) => ({
      name: command.constructor.name,
      input: command.input,
    })),
    [
      {
        name: "AdminGetUserCommand",
        input: {
          UserPoolId: USER_POOL_ID,
          Username: "operator-user",
        },
      },
      {
        name: "AdminListGroupsForUserCommand",
        input: {
          UserPoolId: USER_POOL_ID,
          Username: "operator-user",
          Limit: 60,
        },
      },
      {
        name: "AdminListGroupsForUserCommand",
        input: {
          UserPoolId: USER_POOL_ID,
          Username: "operator-user",
          Limit: 60,
          NextToken: "page-two",
        },
      },
    ],
  );
});

test("accepts the immutable access-token username claim", async () => {
  const calls = [];
  const directory = createCognitoGroupDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        calls.push(command);
        return command instanceof AdminGetUserCommand
          ? cognitoUser()
          : { Groups: [] };
      },
    },
  });

  assert.deepEqual(
    await directory.resolveCurrentGroups({
      sub: CLAIMS.sub,
      username: "operator-user",
    }),
    [],
  );
  assert.equal(calls[0].input.Username, "operator-user");
});

test("ignores valid non-subject attributes when binding the immutable subject", async () => {
  const user = cognitoUser();
  user.UserAttributes.unshift({
    Name: "name",
    Value: "Demo Operator",
  });
  const directory = createCognitoGroupDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        return command instanceof AdminGetUserCommand
          ? user
          : { Groups: [{ GroupName: "end-user" }] };
      },
    },
  });

  assert.deepEqual(
    await directory.resolveCurrentGroups(CLAIMS),
    ["end-user"],
  );
});

test("rejects malformed configuration before making requests", () => {
  assert.equal(typeof createCognitoGroupDirectory, "function");
  for (const configuration of [
    undefined,
    {},
    { client: { send() {} }, userPoolId: "" },
    { client: { send() {} }, userPoolId: "pool-id" },
    { client: {}, userPoolId: USER_POOL_ID },
  ]) {
    assert.throws(
      () => createCognitoGroupDirectory(configuration),
      /Cognito group directory configuration is invalid\./,
    );
  }
});

test("rejects missing, conflicting, inherited, and accessor token claims", async () => {
  let calls = 0;
  let getterCalls = 0;
  const directory = createCognitoGroupDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send() {
        calls += 1;
        return {};
      },
    },
  });
  const inherited = Object.create(CLAIMS);
  const accessor = { sub: CLAIMS.sub };
  Object.defineProperty(accessor, "cognito:username", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "operator-user";
    },
  });

  for (const claims of [
    undefined,
    {},
    { sub: CLAIMS.sub },
    { "cognito:username": "operator-user" },
    {
      sub: CLAIMS.sub,
      username: "other-user",
      "cognito:username": "operator-user",
    },
    { sub: ` ${CLAIMS.sub}`, username: "operator-user" },
    inherited,
    accessor,
  ]) {
    await assert.rejects(
      directory.resolveCurrentGroups(claims),
      sanitizedDirectoryFailure(),
    );
  }

  assert.equal(calls, 0);
  assert.equal(getterCalls, 0);
});

test("rejects missing, disabled, replaced, and mismatched Cognito users", async () => {
  const fixtures = [
    {
      failure: Object.assign(new Error("private missing-user detail"), {
        name: "UserNotFoundException",
      }),
    },
    { user: cognitoUser({ enabled: false }) },
    { user: cognitoUser({ username: "replacement-user" }) },
    { user: cognitoUser({ sub: "replacement-subject" }) },
  ];

  for (const fixture of fixtures) {
    let groupCalls = 0;
    const directory = createCognitoGroupDirectory({
      userPoolId: USER_POOL_ID,
      client: {
        async send(command) {
          if (command instanceof AdminGetUserCommand) {
            if (fixture.failure) throw fixture.failure;
            return fixture.user;
          }
          groupCalls += 1;
          return { Groups: [] };
        },
      },
    });

    await assert.rejects(
      directory.resolveCurrentGroups(CLAIMS),
      sanitizedDirectoryFailure("private missing-user detail"),
    );
    assert.equal(groupCalls, 0);
  }
});

test("rejects malformed Cognito user responses and subject attributes", async () => {
  const duplicateSubject = cognitoUser();
  duplicateSubject.UserAttributes.push({
    Name: "sub",
    Value: CLAIMS.sub,
  });
  const sparseAttributes = [];
  sparseAttributes.length = 1;
  const fixtures = [
    null,
    {},
    { ...cognitoUser(), Enabled: "true" },
    { ...cognitoUser(), UserAttributes: "invalid" },
    { ...cognitoUser(), UserAttributes: sparseAttributes },
    { ...cognitoUser(), UserAttributes: [] },
    duplicateSubject,
    {
      ...cognitoUser(),
      UserAttributes: [{ Name: "sub", Value: ` ${CLAIMS.sub}` }],
    },
  ];

  for (const user of fixtures) {
    const directory = createCognitoGroupDirectory({
      userPoolId: USER_POOL_ID,
      client: {
        async send(command) {
          return command instanceof AdminGetUserCommand
            ? user
            : { Groups: [] };
        },
      },
    });
    await assert.rejects(
      directory.resolveCurrentGroups(CLAIMS),
      sanitizedDirectoryFailure(),
    );
  }
});

test("rejects malformed and oversized Cognito group pages", async () => {
  const sparseGroups = [];
  sparseGroups.length = 1;
  const accessorResponse = {};
  let getterCalls = 0;
  Object.defineProperty(accessorResponse, "Groups", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [];
    },
  });
  const fixtures = [
    null,
    {},
    { Groups: "invalid" },
    { Groups: sparseGroups },
    {
      Groups: Array.from(
        { length: 61 },
        (_, index) => ({ GroupName: `group-${index}` }),
      ),
    },
    { Groups: [null] },
    { Groups: [{}] },
    { Groups: [{ GroupName: " invalid" }] },
    { Groups: [{ GroupName: "invalid\u0000group" }] },
    accessorResponse,
  ];

  for (const response of fixtures) {
    const directory = createCognitoGroupDirectory({
      userPoolId: USER_POOL_ID,
      client: {
        async send(command) {
          return command instanceof AdminGetUserCommand
            ? cognitoUser()
            : response;
        },
      },
    });
    await assert.rejects(
      directory.resolveCurrentGroups(CLAIMS),
      sanitizedDirectoryFailure(),
    );
  }
  assert.equal(getterCalls, 0);
});

test("rejects malformed, repeated, and excessive pagination", async () => {
  const paginationCases = [
    [{ Groups: [], NextToken: "" }],
    [{ Groups: [], NextToken: " page-two" }],
    [{ Groups: [], NextToken: "x".repeat(2049) }],
    [
      { Groups: [], NextToken: "repeat" },
      { Groups: [], NextToken: "repeat" },
    ],
    Array.from({ length: 10 }, (_, index) => ({
      Groups: [],
      NextToken: `page-${index + 2}`,
    })),
  ];

  for (const pages of paginationCases) {
    const responses = structuredClone(pages);
    const directory = createCognitoGroupDirectory({
      userPoolId: USER_POOL_ID,
      client: {
        async send(command) {
          return command instanceof AdminGetUserCommand
            ? cognitoUser()
            : responses.shift();
        },
      },
    });
    await assert.rejects(
      directory.resolveCurrentGroups(CLAIMS),
      sanitizedDirectoryFailure(),
    );
  }
});

test("sanitizes Cognito transport failures without caching them", async () => {
  const privateDetail = "private-cognito-transport-detail";
  let calls = 0;
  const directory = createCognitoGroupDirectory({
    userPoolId: USER_POOL_ID,
    client: {
      async send(command) {
        calls += 1;
        if (calls === 1) throw new Error(privateDetail);
        return command instanceof AdminGetUserCommand
          ? cognitoUser()
          : { Groups: [{ GroupName: "end-user" }] };
      },
    },
  });

  await assert.rejects(
    directory.resolveCurrentGroups(CLAIMS),
    sanitizedDirectoryFailure(privateDetail),
  );
  assert.deepEqual(
    await directory.resolveCurrentGroups(CLAIMS),
    ["end-user"],
  );
  assert.equal(calls, 3);
});
