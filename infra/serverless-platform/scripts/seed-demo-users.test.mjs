import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync as nodeChmodSync,
  existsSync,
  mkdtempSync as nodeMkdtempSync,
  readFileSync,
  rmSync as nodeRmSync,
  statSync,
  symlinkSync as nodeSymlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isAwsCliUserNotFound,
  parseDemoUsersJson,
  runAwsCli,
  runCli,
  seedDemoUsers,
  SUPPORTED_GROUPS,
} from "./seed-demo-users.mjs";

const USER_POOL_ID = "us-west-2_example";
const REGION = "us-west-2";
const OWNERSHIP_ATTRIBUTE = "custom:managed_by";
const OWNERSHIP_VALUE = "agentic-ai-platform-demo";
const NOT_FOUND_STDERR =
  "An error occurred (UserNotFoundException) when calling the "
  + "AdminGetUser operation: User does not exist.\n";
const CURRENT_NOT_FOUND_STDERR =
  "\naws: [ERROR]: An error occurred (UserNotFoundException) when calling the "
  + "AdminGetUser operation: User does not exist.\n";
const DELETE_NOT_FOUND_STDERR =
  "An error occurred (UserNotFoundException) when calling the "
  + "AdminDeleteUser operation: User does not exist.\n";

const PRIMARY_ADMIN = {
  username: "platform_admin_01",
  name: "Platform Administrator",
  group: "platform-admin",
};
const SECONDARY_ADMIN = {
  username: "platform_admin_02",
  email: "platform-admin@example.invalid",
  name: "Secondary Administrator",
  group: "platform-admin",
};
const DEMO_USERS = Object.freeze([
  PRIMARY_ADMIN,
  SECONDARY_ADMIN,
  {
    username: "builder_01",
    name: "Domain Builder One",
    group: "domain-builder",
  },
  {
    username: "builder_02",
    name: "Domain Builder Two",
    group: "domain-builder",
  },
  {
    username: "builder_03",
    name: "Domain Builder Three",
    group: "domain-builder",
  },
  {
    username: "end_user_01",
    name: "End User",
    group: "end-user",
  },
].map(Object.freeze));
const DEMO_USERS_JSON = JSON.stringify(DEMO_USERS);

function createPasswords(users = DEMO_USERS) {
  const nonce = randomUUID().replaceAll("-", "");
  return Object.fromEntries(users.map((user, index) => [
    user.username,
    `${String.fromCharCode(65 + index)}`
      + `${String.fromCharCode(97 + index)}${index}!${nonce}`,
  ]));
}

function passwordProvider(passwords) {
  return (username) => {
    assert.ok(Object.hasOwn(passwords, username));
    return passwords[username];
  };
}

function lookupDocument(user, overrides = {}) {
  return {
    Username: user.username,
    Enabled: true,
    UserStatus: "CONFIRMED",
    UserAttributes: [
      { Name: "name", Value: user.name },
      ...(user.email
        ? [
            { Name: "email", Value: user.email },
            { Name: "email_verified", Value: "true" },
          ]
        : []),
      { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
    ],
    ...overrides,
  };
}

function lookupOutput(user, overrides = {}) {
  return {
    stdout: JSON.stringify(lookupDocument(user, overrides)),
    stderr: "",
  };
}

function groupOutput(groupNames = [], overrides = {}) {
  return {
    stdout: JSON.stringify({
      Groups: groupNames.map((GroupName) => ({ GroupName })),
      ...overrides,
    }),
    stderr: "",
  };
}

async function classifiedNotFound(args, options) {
  return runAwsCli(args, options, () => {
    const error = new Error("lookup failed");
    error.status = 254;
    error.stderr = NOT_FOUND_STDERR;
    throw error;
  });
}

function diagnosticText(error) {
  return [
    error?.message,
    error?.stack,
    error?.stderr,
    error?.stdout,
    error?.input,
  ]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function inspectTemporaryJsonInput({
  args,
  expectedInput,
  options,
  secret,
}) {
  const optionIndex = args.indexOf("--cli-input-json");
  assert.notEqual(optionIndex, -1);
  const fileUrl = args[optionIndex + 1];
  assert.notEqual(fileUrl, "file:///dev/stdin");
  assert.equal(fileUrl.startsWith("file:"), true);
  assert.equal(args.some((argument) => argument.includes(secret)), false);
  assert.equal(Object.hasOwn(options, "input"), false);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);

  const filePath = fileURLToPath(fileUrl);
  const directoryPath = dirname(filePath);
  assert.equal(statSync(directoryPath).mode & 0o777, 0o700);
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.equal(readFileSync(filePath, "utf8"), expectedInput);
  return { directoryPath, filePath, fileUrl };
}

async function assertCliRejectsSafely({
  passwords,
  passwordsJson = JSON.stringify(passwords),
  expected,
}) {
  let seedCalls = 0;
  await assert.rejects(
    runCli({
      env: {
        COGNITO_USER_POOL_ID: USER_POOL_ID,
        COGNITO_DEMO_USERS_JSON: DEMO_USERS_JSON,
        COGNITO_DEMO_USER_PASSWORDS_JSON: passwordsJson,
      },
      seed: async () => {
        seedCalls += 1;
      },
    }),
    (error) => {
      const diagnostics = diagnosticText(error);
      for (const password of Object.values(passwords)) {
        assert.equal(diagnostics.includes(password), false);
        assert.equal(
          diagnostics.includes(JSON.stringify(password).slice(1, -1)),
          false,
        );
      }
      assert.match(error.message, expected);
      return true;
    },
  );
  assert.equal(seedCalls, 0);
}

test("demo users exactly match the intended principals and one supported group each", () => {
  assert.deepEqual(SUPPORTED_GROUPS, [
    "platform-admin",
    "domain-builder",
    "end-user",
  ]);
  assert.deepEqual(DEMO_USERS, [
    PRIMARY_ADMIN,
    SECONDARY_ADMIN,
    {
      username: "builder_01",
      name: "Domain Builder One",
      group: "domain-builder",
    },
    {
      username: "builder_02",
      name: "Domain Builder Two",
      group: "domain-builder",
    },
    {
      username: "builder_03",
      name: "Domain Builder Three",
      group: "domain-builder",
    },
    {
      username: "end_user_01",
      name: "End User",
      group: "end-user",
    },
  ]);

  for (const user of DEMO_USERS) {
    assert.deepEqual(
      Object.keys(user).sort(),
      user.email
        ? ["email", "group", "name", "username"]
        : ["group", "name", "username"],
    );
    assert.ok(SUPPORTED_GROUPS.includes(user.group));
  }
});

test("private persona JSON accepts generic users and rejects malformed identity records", () => {
  assert.deepEqual(parseDemoUsersJson(DEMO_USERS_JSON), DEMO_USERS);

  for (const document of [
    "not-json",
    "[]",
    JSON.stringify([{ ...PRIMARY_ADMIN, unexpected: true }]),
    JSON.stringify([{ ...PRIMARY_ADMIN, username: " bad" }]),
    JSON.stringify([{ ...PRIMARY_ADMIN, name: " bad" }]),
    JSON.stringify([{ ...PRIMARY_ADMIN, group: "demo-operator" }]),
    JSON.stringify([PRIMARY_ADMIN, PRIMARY_ADMIN]),
  ]) {
    assert.throws(
      () => parseDemoUsersJson(document),
      /COGNITO_DEMO_USERS_JSON/,
    );
  }
});

test("a confirmed owned user with no memberships is assigned to its configured group without reading a password", async () => {
  const operations = [];
  const timeouts = [];
  let passwordReads = 0;

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: () => {
      passwordReads += 1;
      throw new Error("password must not be read for an existing user");
    },
    region: REGION,
    users: [PRIMARY_ADMIN],
    runAws: async (args, options) => {
      operations.push(args[1]);
      timeouts.push(options?.timeoutMs);
      if (args[1] === "admin-get-user") {
        return lookupOutput(PRIMARY_ADMIN);
      }
      if (args[1] === "admin-list-groups-for-user") {
        return groupOutput();
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(passwordReads, 0);
  assert.deepEqual(operations, [
    "admin-get-user",
    "admin-list-groups-for-user",
    "admin-add-user-to-group",
  ]);
  assert.deepEqual(timeouts, [20_000, 20_000, 20_000]);
});

test("seedDemoUsers rejects unsafe per-call timeouts before AWS access", async () => {
  for (const timeoutMs of [0, 1.5, 60_001, Number.POSITIVE_INFINITY]) {
    let calls = 0;
    await assert.rejects(
      seedDemoUsers({
        userPoolId: USER_POOL_ID,
        passwordFor: passwordProvider(createPasswords([PRIMARY_ADMIN])),
        region: REGION,
        users: [PRIMARY_ADMIN],
        timeoutMs,
        runAws: async () => {
          calls += 1;
          return lookupOutput(PRIMARY_ADMIN);
        },
      }),
      /timeoutMs must be an integer from 1 through 60000/,
    );
    assert.equal(calls, 0);
  }
});

test("the production seed path bounds a stalled CLI and removes private password input", async () => {
  const secret = `${createPasswords([PRIMARY_ADMIN]).platform_admin_01}"\\`;
  let temporaryInput;
  const childTimeouts = [];
  const runAws = (args, options = {}) =>
    runAwsCli(args, options, (_file, receivedArgs, childOptions) => {
      childTimeouts.push(childOptions.timeout);
      if (args[1] === "admin-get-user") {
        const error = new Error("lookup failed");
        error.status = 254;
        error.stderr = NOT_FOUND_STDERR;
        throw error;
      }
      if (args[1] === "admin-create-user") {
        temporaryInput = inspectTemporaryJsonInput({
          args: receivedArgs,
          expectedInput: options.input,
          options: childOptions,
          secret,
        });
        const error = new Error(`timed out with ${secret}`);
        error.status = 124;
        error.stdout = options.input;
        error.stderr = options.input;
        throw error;
      }
      assert.fail(`Unexpected AWS operation ${args[1]}`);
    });

  await assert.rejects(
    seedDemoUsers({
      userPoolId: USER_POOL_ID,
      passwordFor: () => secret,
      region: REGION,
      users: [PRIMARY_ADMIN],
      runAws,
    }),
    (error) => {
      assert.equal(error.message, "AWS CLI admin-create-user failed (exit code 124).");
      assert.equal(diagnosticText(error).includes(secret), false);
      return true;
    },
  );

  assert.deepEqual(childTimeouts, [20_000, 20_000]);
  assert.ok(temporaryInput);
  assert.equal(existsSync(temporaryInput.filePath), false);
  assert.equal(existsSync(temporaryInput.directoryPath), false);
});

test("a confirmed owned user already in exactly the expected group has no mutation or password read", async () => {
  const operations = [];
  let passwordReads = 0;

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: () => {
      passwordReads += 1;
      throw new Error("password must not be read for a confirmed user");
    },
    region: REGION,
    users: [PRIMARY_ADMIN],
    runAws: async (args) => {
      operations.push(args[1]);
      if (args[1] === "admin-get-user") {
        return lookupOutput(PRIMARY_ADMIN);
      }
      if (args[1] === "admin-list-groups-for-user") {
        return groupOutput([PRIMARY_ADMIN.group]);
      }
      assert.fail(`unexpected mutation ${args[1]}`);
    },
  });

  assert.equal(passwordReads, 0);
  assert.deepEqual(operations, [
    "admin-get-user",
    "admin-list-groups-for-user",
  ]);
});

test("a FORCE_CHANGE_PASSWORD owned user is reset from stdin before adding its missing group", async () => {
  const passwords = createPasswords([PRIMARY_ADMIN]);
  const operations = [];
  const argumentLists = [];
  let resetInput;

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: passwordProvider(passwords),
    region: REGION,
    users: [PRIMARY_ADMIN],
    runAws: async (args, options = {}) => {
      operations.push(args[1]);
      argumentLists.push(args);
      if (args[1] === "admin-get-user") {
        return lookupOutput(PRIMARY_ADMIN, {
          UserStatus: "FORCE_CHANGE_PASSWORD",
        });
      }
      if (args[1] === "admin-list-groups-for-user") {
        return groupOutput();
      }
      if (args[1] === "admin-set-user-password") {
        resetInput = options.input;
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(operations, [
    "admin-get-user",
    "admin-list-groups-for-user",
    "admin-set-user-password",
    "admin-add-user-to-group",
  ]);
  for (const args of argumentLists) {
    assert.equal(args.includes(passwords.platform_admin_01), false);
  }

  let resetPayload;
  try {
    resetPayload = JSON.parse(resetInput);
  } catch {
    assert.fail("set-user-password stdin must contain valid JSON");
  }
  assert.equal(resetPayload.Password === passwords.platform_admin_01, true);
  delete resetPayload.Password;
  assert.deepEqual(resetPayload, {
    UserPoolId: USER_POOL_ID,
    Username: PRIMARY_ADMIN.username,
    Permanent: false,
  });
});

test("all users are verified before any password read or mutation", async () => {
  const passwords = createPasswords([PRIMARY_ADMIN, SECONDARY_ADMIN]);
  const operations = [];
  let passwordReads = 0;

  await assert.rejects(
    seedDemoUsers({
      userPoolId: USER_POOL_ID,
      passwordFor: (username) => {
        passwordReads += 1;
        return passwords[username];
      },
      region: REGION,
      users: [PRIMARY_ADMIN, SECONDARY_ADMIN],
      runAws: async (args) => {
        const username = args[args.indexOf("--username") + 1];
        operations.push(`${args[1]}:${username}`);
        if (args[1] === "admin-get-user") {
          return lookupOutput(
            username === PRIMARY_ADMIN.username ? PRIMARY_ADMIN : SECONDARY_ADMIN,
            username === PRIMARY_ADMIN.username
              ? { UserStatus: "FORCE_CHANGE_PASSWORD" }
              : {},
          );
        }
        if (args[1] === "admin-list-groups-for-user") {
          return username === PRIMARY_ADMIN.username
            ? groupOutput()
            : groupOutput(["domain-builder"]);
        }
        return { stdout: "", stderr: "" };
      },
    }),
    /Existing Cognito demo user platform_admin_02 has unexpected group membership\./,
  );

  assert.equal(passwordReads, 0);
  assert.deepEqual(operations, [
    "admin-get-user:platform_admin_01",
    "admin-list-groups-for-user:platform_admin_01",
    "admin-get-user:platform_admin_02",
    "admin-list-groups-for-user:platform_admin_02",
  ]);
});

for (const userStatus of [
  undefined,
  "ARCHIVED",
  "COMPROMISED",
  "RESET_REQUIRED",
  "UNCONFIRMED",
  "UNKNOWN",
]) {
  test(`an owned user with ${userStatus ?? "missing"} status fails before group lookup or mutation`, async () => {
    const operations = [];
    const document = lookupDocument(PRIMARY_ADMIN);
    if (userStatus === undefined) {
      delete document.UserStatus;
    } else {
      document.UserStatus = userStatus;
    }

    await assert.rejects(
      seedDemoUsers({
        userPoolId: USER_POOL_ID,
        passwordFor: () => {
          throw new Error("password must not be read");
        },
        region: REGION,
        users: [PRIMARY_ADMIN],
        runAws: async (args) => {
          operations.push(args[1]);
          return {
            stdout: JSON.stringify(document),
            stderr: "",
          };
        },
      }),
      /Existing Cognito demo user platform_admin_01 is not managed by this deployment\./,
    );

    assert.deepEqual(operations, ["admin-get-user"]);
  });
}

const INVALID_GROUP_OUTPUTS = [
  {
    label: "empty output",
    stdout: "",
  },
  {
    label: "invalid JSON",
    stdout: "{",
  },
  {
    label: "array document",
    stdout: "[]",
  },
  {
    label: "missing Groups",
    stdout: "{}",
  },
  {
    label: "non-array Groups",
    stdout: JSON.stringify({ Groups: "platform-admin" }),
  },
  {
    label: "malformed group record",
    stdout: JSON.stringify({ Groups: [{}] }),
  },
  {
    label: "duplicate expected group",
    stdout: JSON.stringify({
      Groups: [
        { GroupName: PRIMARY_ADMIN.group },
        { GroupName: PRIMARY_ADMIN.group },
      ],
    }),
  },
  {
    label: "unexpected supported group",
    stdout: JSON.stringify({
      Groups: [{ GroupName: "domain-builder" }],
    }),
  },
  {
    label: "expected and unexpected groups",
    stdout: JSON.stringify({
      Groups: [
        { GroupName: PRIMARY_ADMIN.group },
        { GroupName: "end-user" },
      ],
    }),
  },
  {
    label: "unknown group",
    stdout: JSON.stringify({
      Groups: [{ GroupName: "unexpected-group" }],
    }),
  },
  {
    label: "paginated result",
    stdout: JSON.stringify({
      Groups: [{ GroupName: PRIMARY_ADMIN.group }],
      NextToken: "more-groups",
    }),
  },
  {
    label: "malformed pagination marker",
    stdout: JSON.stringify({
      Groups: [{ GroupName: PRIMARY_ADMIN.group }],
      NextToken: null,
    }),
  },
];

for (const groupOutputCase of INVALID_GROUP_OUTPUTS) {
  test(`${groupOutputCase.label} group membership fails closed before reset or add`, async () => {
    const operations = [];

    await assert.rejects(
      seedDemoUsers({
        userPoolId: USER_POOL_ID,
        passwordFor: () => {
          throw new Error("password must not be read");
        },
        region: REGION,
        users: [PRIMARY_ADMIN],
        runAws: async (args) => {
          operations.push(args[1]);
          if (args[1] === "admin-get-user") {
            return lookupOutput(PRIMARY_ADMIN);
          }
          return {
            stdout: groupOutputCase.stdout,
            stderr: "",
          };
        },
      }),
      /Existing Cognito demo user platform_admin_01 has unexpected group membership\./,
    );

    assert.deepEqual(operations, [
      "admin-get-user",
      "admin-list-groups-for-user",
    ]);
  });
}

test("an absent user is created from stdin with its own password, name, ownership marker, and suppressed message", async () => {
  const passwords = createPasswords([PRIMARY_ADMIN]);
  const operations = [];
  const argumentLists = [];
  let createInput;

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: passwordProvider(passwords),
    region: REGION,
    users: [PRIMARY_ADMIN],
    runAws: async (args, options = {}) => {
      operations.push(args[1]);
      argumentLists.push(args);
      if (args[1] === "admin-get-user") {
        await classifiedNotFound(args, options);
      }
      if (args[1] === "admin-create-user") {
        createInput = options.input;
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(operations, [
    "admin-get-user",
    "admin-create-user",
    "admin-add-user-to-group",
  ]);
  for (const args of argumentLists) {
    for (const password of Object.values(passwords)) {
      assert.equal(args.includes(password), false);
    }
  }

  let createPayload;
  try {
    createPayload = JSON.parse(createInput);
  } catch {
    assert.fail("create-user stdin must contain valid JSON");
  }
  assert.equal(
    createPayload.TemporaryPassword === passwords.platform_admin_01,
    true,
  );
  delete createPayload.TemporaryPassword;
  assert.deepEqual(createPayload, {
    UserPoolId: USER_POOL_ID,
    Username: "platform_admin_01",
    UserAttributes: [
      { Name: "name", Value: "Platform Administrator" },
      { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
    ],
    MessageAction: "SUPPRESS",
  });
});

test("each absent demo user receives only its own distinct password", async () => {
  const users = DEMO_USERS.slice(0, 2);
  const passwords = createPasswords(users);
  const createMatches = [];

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: passwordProvider(passwords),
    region: REGION,
    users,
    runAws: async (args, options = {}) => {
      if (args[1] === "admin-get-user") {
        await classifiedNotFound(args, options);
      }
      if (args[1] === "admin-create-user") {
        const payload = JSON.parse(options.input);
        createMatches.push(
          payload.TemporaryPassword === passwords[payload.Username],
        );
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(createMatches, [true, true]);
  assert.equal(new Set(Object.values(passwords)).size, users.length);
});

test("Secondary administrator is created with a matching verified email address", async () => {
  const passwords = createPasswords([SECONDARY_ADMIN]);
  let createInput;

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: passwordProvider(passwords),
    region: REGION,
    users: [SECONDARY_ADMIN],
    runAws: async (args, options = {}) => {
      if (args[1] === "admin-get-user") {
        await classifiedNotFound(args, options);
      }
      if (args[1] === "admin-create-user") {
        createInput = options.input;
      }
      return { stdout: "", stderr: "" };
    },
  });

  const createPayload = JSON.parse(createInput);
  assert.equal(createPayload.Username, "platform_admin_02");
  assert.deepEqual(createPayload.UserAttributes, [
    { Name: "name", Value: "Secondary Administrator" },
    { Name: "email", Value: "platform-admin@example.invalid" },
    { Name: "email_verified", Value: "true" },
    { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
  ]);
});

test("an existing secondary administrator must retain the matching verified email", async () => {
  const userAttributes = lookupDocument(SECONDARY_ADMIN).UserAttributes.filter(
    (attribute) => attribute.Name !== "email_verified",
  );

  await assert.rejects(
    seedDemoUsers({
      userPoolId: USER_POOL_ID,
      passwordFor: () => {
        throw new Error("password must not be read");
      },
      region: REGION,
      users: [SECONDARY_ADMIN],
      runAws: async (args) => {
        if (args[1] === "admin-get-user") {
          return lookupOutput(SECONDARY_ADMIN, { UserAttributes: userAttributes });
        }
        return groupOutput(["platform-admin"]);
      },
    }),
    /Existing Cognito demo user platform_admin_02 is not managed by this deployment\./,
  );
});

const UNEXPECTED_EXISTING_IDENTITIES = [
  {
    name: "mismatched username",
    overrides: { Username: "someone-else" },
  },
  {
    name: "disabled user",
    overrides: { Enabled: false },
  },
  {
    name: "missing name",
    overrides: {
      UserAttributes: [
        { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
      ],
    },
  },
  {
    name: "mismatched name",
    overrides: {
      UserAttributes: [
        { Name: "name", Value: "Unexpected Name" },
        { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
      ],
    },
  },
  {
    name: "duplicate name",
    overrides: {
      UserAttributes: [
        { Name: "name", Value: PRIMARY_ADMIN.name },
        { Name: "name", Value: PRIMARY_ADMIN.name },
        { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
      ],
    },
  },
  {
    name: "conflicting duplicate name",
    overrides: {
      UserAttributes: [
        { Name: "name", Value: PRIMARY_ADMIN.name },
        { Name: "name", Value: "Unexpected Name" },
        { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
      ],
    },
  },
  {
    name: "missing ownership marker",
    overrides: {
      UserAttributes: [{ Name: "name", Value: PRIMARY_ADMIN.name }],
    },
  },
  {
    name: "mismatched ownership marker",
    overrides: {
      UserAttributes: [
        { Name: "name", Value: PRIMARY_ADMIN.name },
        { Name: OWNERSHIP_ATTRIBUTE, Value: "another-controller" },
      ],
    },
  },
  {
    name: "duplicate ownership marker",
    overrides: {
      UserAttributes: [
        { Name: "name", Value: PRIMARY_ADMIN.name },
        { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
        { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
      ],
    },
  },
  {
    name: "conflicting duplicate ownership marker",
    overrides: {
      UserAttributes: [
        { Name: "name", Value: PRIMARY_ADMIN.name },
        { Name: OWNERSHIP_ATTRIBUTE, Value: OWNERSHIP_VALUE },
        { Name: OWNERSHIP_ATTRIBUTE, Value: "another-controller" },
      ],
    },
  },
  {
    name: "malformed attributes",
    overrides: { UserAttributes: "not-an-array" },
  },
];

for (const identity of UNEXPECTED_EXISTING_IDENTITIES) {
  test(`an existing ${identity.name} fails closed before group assignment`, async () => {
    const operations = [];

    await assert.rejects(
      seedDemoUsers({
        userPoolId: USER_POOL_ID,
        passwordFor: () => {
          throw new Error("password must not be read");
        },
        region: REGION,
        users: [PRIMARY_ADMIN],
        runAws: async (args) => {
          operations.push(args[1]);
          return {
            stdout: JSON.stringify(
              lookupDocument(PRIMARY_ADMIN, identity.overrides),
            ),
            stderr: "",
          };
        },
      }),
      /Existing Cognito demo user platform_admin_01 is not managed by this deployment\./,
    );

    assert.deepEqual(operations, ["admin-get-user"]);
  });
}

for (const malformedOutput of [
  "",
  "{",
  "[]",
  JSON.stringify({ Username: PRIMARY_ADMIN.username }),
]) {
  test("malformed admin-get-user JSON stops without create or group assignment", async () => {
    const operations = [];

    await assert.rejects(
      seedDemoUsers({
        userPoolId: USER_POOL_ID,
        passwordFor: () => {
          throw new Error("password must not be read");
        },
        region: REGION,
        users: [PRIMARY_ADMIN],
        runAws: async (args) => {
          operations.push(args[1]);
          return { stdout: malformedOutput, stderr: "" };
        },
      }),
      /Existing Cognito demo user platform_admin_01 is not managed by this deployment\./,
    );

    assert.deepEqual(operations, ["admin-get-user"]);
  });
}

test("enumerable stderr on an injected error is not trusted as user absence", async () => {
  const calls = [];
  const lookupError = new Error("lookup failed");
  lookupError.code = 254;
  lookupError.stderr = NOT_FOUND_STDERR;

  await assert.rejects(
    seedDemoUsers({
      userPoolId: USER_POOL_ID,
      passwordFor: passwordProvider(createPasswords([PRIMARY_ADMIN])),
      region: REGION,
      users: [PRIMARY_ADMIN],
      runAws: async (args) => {
        calls.push(args);
        throw lookupError;
      },
    }),
    (error) => error === lookupError,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "admin-get-user");
});

const MISLEADING_LOOKUP_FAILURES = [
  {
    name: "authorization output mentioning UserNotFoundException",
    code: 254,
    stderr:
      "An error occurred (AccessDeniedException) when calling the "
      + "AdminGetUser operation: UserNotFoundException is not authorized.\n",
  },
  {
    name: "network failure mentioning UserNotFoundException",
    code: 255,
    stderr:
      "Could not connect to the endpoint URL: "
      + "\"https://UserNotFoundException.invalid\"\n",
  },
  {
    name: "malformed command output mentioning UserNotFoundException",
    code: 252,
    stderr: "Unknown options: UserNotFoundException\n",
  },
  {
    name: "mixed output containing an otherwise exact not-found line",
    code: 254,
    stderr: `${NOT_FOUND_STDERR}warning: retry mentioned UserNotFoundException\n`,
  },
  {
    name: "current CLI output followed by an extra warning",
    code: 254,
    stderr: `${CURRENT_NOT_FOUND_STDERR}warning: retry mentioned UserNotFoundException\n`,
  },
  {
    name: "current CLI output preceded by a warning",
    code: 254,
    stderr: `warning: retrying\n${CURRENT_NOT_FOUND_STDERR}`,
  },
  {
    name: "legacy output without its final newline",
    code: 254,
    stderr: NOT_FOUND_STDERR.slice(0, -1),
  },
  {
    name: "legacy output with a CRLF final newline",
    code: 254,
    stderr: NOT_FOUND_STDERR.replace(/\n$/, "\r\n"),
  },
  {
    name: "current CLI output without its final newline",
    code: 254,
    stderr: CURRENT_NOT_FOUND_STDERR.slice(0, -1),
  },
  {
    name: "current CLI output with a CRLF final newline",
    code: 254,
    stderr: CURRENT_NOT_FOUND_STDERR.replace(/\n$/, "\r\n"),
  },
  {
    name: "current CLI output with CRLF line endings",
    code: 254,
    stderr: CURRENT_NOT_FOUND_STDERR.replaceAll("\n", "\r\n"),
  },
  {
    name: "exact not-found output with the wrong exit code",
    code: 255,
    stderr: NOT_FOUND_STDERR,
  },
  {
    name: "not-found output for the wrong Cognito operation",
    code: 254,
    stderr:
      "An error occurred (UserNotFoundException) when calling the "
      + "AdminCreateUser operation: User does not exist.\n",
  },
  {
    name: "current CLI prefix for the wrong Cognito operation",
    code: 254,
    stderr:
      "\naws: [ERROR]: An error occurred (UserNotFoundException) when calling "
      + "the AdminCreateUser operation: User does not exist.\n",
  },
];

for (const failure of MISLEADING_LOOKUP_FAILURES) {
  test(`${failure.name} is rethrown without creating a user`, async () => {
    const calls = [];
    const execFileSync = (_file, args) => {
      calls.push(args);
      if (args[1] !== "admin-get-user") {
        return "";
      }
      const error = new Error("lookup failed");
      error.status = failure.code;
      error.stderr = failure.stderr;
      throw error;
    };

    await assert.rejects(
      seedDemoUsers({
        userPoolId: USER_POOL_ID,
        passwordFor: passwordProvider(createPasswords([PRIMARY_ADMIN])),
        region: REGION,
        users: [PRIMARY_ADMIN],
        runAws: (args, options) => runAwsCli(args, options, execFileSync),
      }),
      (error) => {
        assert.equal(error.name, "AwsCliError");
        assert.equal(
          error.message,
          `AWS CLI admin-get-user failed (exit code ${failure.code}).`,
        );
        assert.equal(error.code, failure.code);
        assert.equal(Object.hasOwn(error, "stderr"), false);
        assert.equal(diagnosticText(error).includes(failure.stderr), false);
        return true;
      },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "cognito-idp",
      "admin-get-user",
      "--user-pool-id",
      USER_POOL_ID,
      "--username",
      "platform_admin_01",
      "--region",
      REGION,
    ]);
  });
}

test("runCli requires the pool, private users JSON, and password JSON without returning values", async () => {
  const passwords = createPasswords();
  let seedCalls = 0;
  const seed = async () => {
    seedCalls += 1;
  };

  await assert.rejects(
    runCli({
      env: {
        COGNITO_DEMO_USER_PASSWORDS_JSON: JSON.stringify(passwords),
      },
      seed,
    }),
    /COGNITO_USER_POOL_ID is required\./,
  );
  await assert.rejects(
    runCli({
      env: {
        COGNITO_USER_POOL_ID: USER_POOL_ID,
        COGNITO_DEMO_USERS_JSON: DEMO_USERS_JSON,
      },
      seed,
    }),
    /COGNITO_DEMO_USER_PASSWORDS_JSON is required\./,
  );
  await assert.rejects(
    runCli({
      env: {
        COGNITO_USER_POOL_ID: USER_POOL_ID,
        COGNITO_DEMO_USER_PASSWORDS_JSON: JSON.stringify(passwords),
      },
      seed,
    }),
    /COGNITO_DEMO_USERS_JSON is required\./,
  );
  assert.equal(seedCalls, 0);
});

test("runCli validates exact keys and passes an opaque password provider", async () => {
  const passwords = createPasswords();
  const calls = [];

  const result = await runCli({
    env: {
      COGNITO_USER_POOL_ID: USER_POOL_ID,
      COGNITO_DEMO_USERS_JSON: DEMO_USERS_JSON,
      COGNITO_DEMO_USER_PASSWORDS_JSON: JSON.stringify(passwords),
    },
    seed: async (configuration) => {
      calls.push(configuration);
    },
  });
  await runCli({
    env: {
      COGNITO_USER_POOL_ID: USER_POOL_ID,
      COGNITO_DEMO_USERS_JSON: DEMO_USERS_JSON,
      COGNITO_DEMO_USER_PASSWORDS_JSON: JSON.stringify(passwords),
      AWS_REGION: "ap-southeast-2",
    },
    seed: async (configuration) => {
      calls.push(configuration);
    },
  });

  assert.equal(result, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ passwordFor, ...configuration }) => ({
      ...configuration,
      passwordProviderType: typeof passwordFor,
    })),
    [
      {
        userPoolId: USER_POOL_ID,
        region: "us-west-2",
        users: DEMO_USERS,
        passwordProviderType: "function",
      },
      {
        userPoolId: USER_POOL_ID,
        region: "ap-southeast-2",
        users: DEMO_USERS,
        passwordProviderType: "function",
      },
    ],
  );
  for (const call of calls) {
    assert.deepEqual(Object.keys(call).sort(), [
      "passwordFor",
      "region",
      "userPoolId",
      "users",
    ]);
    for (const user of DEMO_USERS) {
      assert.equal(call.passwordFor(user.username) === passwords[user.username], true);
    }
    assert.throws(
      () => call.passwordFor("unexpected-user"),
      /Unknown demo user requested\./,
    );
  }
});

test("runCli validation-only mode validates runtime configuration without AWS or returned values", async () => {
  const passwords = createPasswords();
  let seedCalls = 0;

  const result = await runCli({
    argv: ["--validate-only"],
    env: {
      COGNITO_DEMO_USERS_JSON: DEMO_USERS_JSON,
      COGNITO_DEMO_USER_PASSWORDS_JSON: JSON.stringify(passwords),
      AWS_REGION: REGION,
    },
    seed: async () => {
      seedCalls += 1;
    },
  });

  assert.equal(result, undefined);
  assert.equal(seedCalls, 0);
});

test("runCli validation-only mode rejects invalid password JSON without AWS or secret exposure", async () => {
  const passwords = createPasswords();
  const malformed = JSON.stringify(passwords).slice(0, -1);
  let seedCalls = 0;

  await assert.rejects(
    runCli({
      argv: ["--validate-only"],
      env: {
        COGNITO_DEMO_USERS_JSON: DEMO_USERS_JSON,
        COGNITO_DEMO_USER_PASSWORDS_JSON: malformed,
        AWS_REGION: REGION,
      },
      seed: async () => {
        seedCalls += 1;
      },
    }),
    (error) => {
      const diagnostics = diagnosticText(error);
      for (const password of Object.values(passwords)) {
        assert.equal(diagnostics.includes(password), false);
      }
      assert.match(error.message, /must be a valid JSON object\./);
      return true;
    },
  );
  assert.equal(seedCalls, 0);
});

test("runCli rejects malformed password JSON without exposing its contents", async () => {
  const passwords = createPasswords();
  const malformed = JSON.stringify(passwords).slice(0, -1);
  await assertCliRejectsSafely({
    passwords,
    passwordsJson: malformed,
    expected: /must be a valid JSON object\./,
  });
});

test("runCli rejects password JSON that is not an object", async () => {
  await assertCliRejectsSafely({
    passwords: {},
    passwordsJson: "[]",
    expected: /must be a valid JSON object\./,
  });
});

test("runCli rejects missing and extra usernames", async () => {
  const missingPasswords = createPasswords();
  delete missingPasswords[DEMO_USERS.at(-1).username];
  await assertCliRejectsSafely({
    passwords: missingPasswords,
    expected: /keys must exactly match all configured usernames\./,
  });

  const extraPasswords = {
    ...createPasswords(),
    "unexpected-user": createPasswords([PRIMARY_ADMIN]).platform_admin_01,
  };
  await assertCliRejectsSafely({
    passwords: extraPasswords,
    expected: /keys must exactly match all configured usernames\./,
  });
});

test("runCli rejects non-string password values", async () => {
  const passwords = createPasswords();
  passwords.platform_admin_01 = null;
  await assertCliRejectsSafely({
    passwords,
    expected: /password for platform_admin_01 does not meet the Cognito policy\./,
  });
});

test("runCli rejects every Cognito password-policy violation", async (t) => {
  const upper = String.fromCharCode(65);
  const lower = String.fromCharCode(97);
  const digit = String.fromCharCode(49);
  const symbol = String.fromCharCode(33);
  const nonce = randomUUID().replaceAll("-", "");
  const invalidValues = {
    "fewer than fourteen characters": [upper, lower, digit, symbol].join(""),
    "no uppercase character": `${nonce}${lower}${digit}${symbol}`,
    "no lowercase character": `${nonce.toUpperCase()}${upper}${digit}${symbol}`,
    "no digit": `${upper}${lower}${symbol}${nonce.replace(/[0-9]/g, lower)}`,
    "no Cognito symbol": `${upper}${lower}${digit}${nonce}`,
  };

  for (const [label, invalidValue] of Object.entries(invalidValues)) {
    await t.test(label, async () => {
      const passwords = createPasswords();
      passwords.platform_admin_01 = invalidValue;
      await assertCliRejectsSafely({
        passwords,
        expected: /password for platform_admin_01 does not meet the Cognito policy\./,
      });
    });
  }
});

test("runCli rejects reused passwords", async () => {
  const passwords = createPasswords();
  passwords[SECONDARY_ADMIN.username] = passwords[PRIMARY_ADMIN.username];
  await assertCliRejectsSafely({
    passwords,
    expected: /must contain a distinct password for every demo user\./,
  });
});

test("AWS CLI subprocesses preserve AWS settings without inheriting the password JSON", async () => {
  const secret = JSON.stringify(createPasswords());
  const environment = {
    AWS_REGION: REGION,
    AWS_PROFILE: "customer-profile",
    PATH: "/usr/bin",
    COGNITO_DEMO_USER_PASSWORDS_JSON: secret,
  };
  let childEnvironment;

  await runAwsCli(
    [
      "cognito-idp",
      "admin-get-user",
      "--user-pool-id",
      USER_POOL_ID,
      "--username",
      PRIMARY_ADMIN.username,
      "--region",
      REGION,
    ],
    { environment },
    (_file, _args, options) => {
      childEnvironment = options.env;
      return JSON.stringify({ Username: PRIMARY_ADMIN.username });
    },
  );

  assert.deepEqual(childEnvironment, {
    AWS_REGION: REGION,
    AWS_PROFILE: "customer-profile",
    PATH: "/usr/bin",
  });
  assert.equal(
    JSON.stringify(childEnvironment).includes(secret),
    false,
  );
});

test("AWS CLI subprocesses receive the explicit bounded timeout", async () => {
  let childTimeout;

  await runAwsCli(
    [
      "cognito-idp",
      "admin-get-user",
      "--user-pool-id",
      USER_POOL_ID,
      "--username",
      PRIMARY_ADMIN.username,
      "--region",
      REGION,
    ],
    { timeoutMs: 20_000 },
    (_file, _args, options) => {
      childTimeout = options.timeout;
      return JSON.stringify({ Username: PRIMARY_ADMIN.username });
    },
  );

  assert.equal(childTimeout, 20_000);
});

test("runAwsCli hard-kills a child that ignores SIGTERM within a bounded wall clock", {
  timeout: 16_000,
}, async () => {
  const directoryPath = nodeMkdtempSync(
    join(tmpdir(), "agentic-platform-aws-timeout-"),
  );
  const fakeAwsPath = join(directoryPath, "aws");
  const fakeAwsScriptPath = join(directoryPath, "fake-aws.sh");
  const pidPath = join(directoryPath, "aws.pid");
  const timeoutMs = 5_000;
  const wallClockLimitMs = 12_000;
  const moduleUrl = new URL("./seed-demo-users.mjs", import.meta.url).href;
  let child;
  let childExit;

  nodeWriteFileSync(
    fakeAwsScriptPath,
    [
      "trap '' TERM",
      "printf '%s' \"$$\" > \"$FAKE_AWS_PID_FILE\"",
      "exec /usr/bin/tail -f /dev/null",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  nodeSymlinkSync("/bin/sh", fakeAwsPath);

  const runnerSource = `
    import { runAwsCli } from ${JSON.stringify(moduleUrl)};
    try {
      await runAwsCli(
        [${JSON.stringify(fakeAwsScriptPath)}, "hard-kill-probe"],
        { timeoutMs: ${timeoutMs} },
      );
      process.exitCode = 2;
    } catch (error) {
      if (error?.name !== "AwsCliError") {
        throw error;
      }
    }
  `;
  const startedAt = Date.now();

  try {
    child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", runnerSource],
      {
        env: {
          ...process.env,
          FAKE_AWS_PID_FILE: pidPath,
          PATH: `${directoryPath}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    childExit = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    let watchdog;
    const outcome = await Promise.race([
      childExit.then((exit) => ({ exit, timedOut: false })),
      new Promise((resolve) => {
        watchdog = setTimeout(
          () => resolve({ timedOut: true }),
          wallClockLimitMs,
        );
      }),
    ]);
    clearTimeout(watchdog);

    if (outcome.timedOut) {
      if (existsSync(pidPath)) {
        process.kill(Number(readFileSync(pidPath, "utf8")), "SIGKILL");
      }
      child.kill("SIGKILL");
      await childExit;
    }

    assert.equal(
      outcome.timedOut,
      false,
      `runAwsCli exceeded ${wallClockLimitMs}ms; stderr: ${stderr}`,
    );
    assert.equal(outcome.exit.code, 0, stderr);
    assert.ok(Date.now() - startedAt < wallClockLimitMs);
    assert.equal(
      existsSync(pidPath),
      true,
      "fake AWS CLI must write its PID marker before timeout",
    );
    const awsPid = Number(readFileSync(pidPath, "utf8"));
    assert.throws(
      () => process.kill(awsPid, 0),
      (error) => error?.code === "ESRCH",
      "timed-out AWS CLI child must not remain alive",
    );
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGKILL");
      await childExit;
    }
    if (existsSync(pidPath)) {
      const awsPid = Number(readFileSync(pidPath, "utf8"));
      try {
        process.kill(awsPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") {
          throw error;
        }
      }
    }
    nodeRmSync(directoryPath, { recursive: true, force: true });
  }
});

test("create and reset use unique private temporary JSON files and clean up after success", async () => {
  const fileUrls = new Set();
  for (const operation of [
    "admin-create-user",
    "admin-set-user-password",
  ]) {
    const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
    const input = JSON.stringify({
      [operation === "admin-create-user"
        ? "TemporaryPassword"
        : "Password"]: secret,
    });
    const args = [
      "cognito-idp",
      operation,
      "--cli-input-json",
      "file:///dev/stdin",
      "--region",
      REGION,
    ];
    let temporaryInput;
    const execFileSync = (file, receivedArgs, options) => {
      assert.equal(file, "aws");
      temporaryInput = inspectTemporaryJsonInput({
        args: receivedArgs,
        expectedInput: input,
        options,
        secret,
      });
      fileUrls.add(temporaryInput.fileUrl);
      return JSON.stringify({ ok: true });
    };

    const result = await runAwsCli(args, { input }, execFileSync);

    assert.deepEqual(result, {
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    });
    assert.equal(temporaryInput === undefined, false);
    assert.equal(existsSync(temporaryInput.filePath), false);
    assert.equal(existsSync(temporaryInput.directoryPath), false);
    assert.equal(args[3], "file:///dev/stdin");
    assert.equal(args.some((argument) => argument.includes(secret)), false);
  }
  assert.equal(fileUrls.size, 2);
});

test("temporary JSON file arguments preserve literal spaces without URL encoding", async () => {
  const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
  const input = JSON.stringify({ TemporaryPassword: secret });
  const args = [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///dev/stdin",
    "--region",
    REGION,
  ];
  let directoryPath;
  let receivedFileArgument;
  const inputFileSystem = {
    chmodSync: nodeChmodSync,
    mkdtempSync() {
      directoryPath = nodeMkdtempSync(
        join(tmpdir(), "agentic platform temp "),
      );
      return directoryPath;
    },
    rmSync: nodeRmSync,
    writeFileSync: nodeWriteFileSync,
  };

  await runAwsCli(
    args,
    { input, inputFileSystem },
    (_file, receivedArgs) => {
      receivedFileArgument = receivedArgs[
        receivedArgs.indexOf("--cli-input-json") + 1
      ];
      return "";
    },
  );

  const expectedFilePath = join(directoryPath, "input.json");
  assert.equal(receivedFileArgument, `file://${expectedFilePath}`);
  assert.equal(receivedFileArgument.includes("%20"), false);
  assert.equal(existsSync(directoryPath), false);
});

test("exclusive 0600 creation performs no chmod after writing the secret", async () => {
  const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
  const input = JSON.stringify({ TemporaryPassword: secret });
  const args = [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///dev/stdin",
  ];
  let writeCompleted = false;
  const inputFileSystem = {
    chmodSync(path, mode) {
      assert.equal(
        writeCompleted,
        false,
        "secret-bearing file must not require a post-write chmod",
      );
      return nodeChmodSync(path, mode);
    },
    mkdtempSync: nodeMkdtempSync,
    rmSync: nodeRmSync,
    writeFileSync(path, contents, options) {
      const result = nodeWriteFileSync(path, contents, options);
      writeCompleted = true;
      return result;
    },
  };

  await runAwsCli(args, { input, inputFileSystem }, () => "");

  assert.equal(writeCompleted, true);
});

test("create and reset clean private JSON files after failure without exposing passwords", async () => {
  const fileUrls = new Set();
  for (const operation of [
    "admin-create-user",
    "admin-set-user-password",
  ]) {
    const secret = `${createPasswords([PRIMARY_ADMIN]).platform_admin_01}"\\`;
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    const input = JSON.stringify({
      [operation === "admin-create-user"
        ? "TemporaryPassword"
        : "Password"]: secret,
    });
    const args = [
      "cognito-idp",
      operation,
      "--cli-input-json",
      "file:///dev/stdin",
      "--region",
      REGION,
    ];
    let temporaryInput;
    const execFileSync = (_file, receivedArgs, options) => {
      temporaryInput = inspectTemporaryJsonInput({
        args: receivedArgs,
        expectedInput: input,
        options,
        secret,
      });
      fileUrls.add(temporaryInput.fileUrl);
      const error = new Error(`Command failed with input: ${input}`);
      error.status = 255;
      error.stdout = `Echoed stdout: ${input}`;
      error.stderr = `Echoed stderr: ${input}`;
      throw error;
    };

    await assert.rejects(
      runAwsCli(args, { input }, execFileSync),
      (error) => {
        const diagnostics = diagnosticText(error);
        assert.equal(diagnostics.includes(secret), false);
        assert.equal(diagnostics.includes(escapedSecret), false);
        assert.equal(
          error.message,
          `AWS CLI ${operation} failed (exit code 255).`,
        );
        assert.equal(error.code, 255);
        assert.equal(Object.hasOwn(error, "stderr"), false);
        assert.equal(Object.hasOwn(error, "stdout"), false);
        assert.equal(Object.hasOwn(error, "input"), false);
        return true;
      },
    );

    assert.equal(temporaryInput === undefined, false);
    assert.equal(existsSync(temporaryInput.filePath), false);
    assert.equal(existsSync(temporaryInput.directoryPath), false);
    assert.equal(args.some((argument) => argument.includes(secret)), false);
  }
  assert.equal(fileUrls.size, 2);
});

for (const failureStep of [
  "directory chmod",
  "file write",
]) {
  test(`temporary JSON preparation cleans up after ${failureStep} failure`, async () => {
    const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
    const input = JSON.stringify({ TemporaryPassword: secret });
    const args = [
      "cognito-idp",
      "admin-create-user",
      "--cli-input-json",
      "file:///dev/stdin",
      "--region",
      REGION,
    ];
    let chmodCalls = 0;
    let directoryPath;
    let executions = 0;
    const inputFileSystem = {
      chmodSync(path, mode) {
        chmodCalls += 1;
        if (
          failureStep === "directory chmod" && chmodCalls === 1
        ) {
          throw new Error(`setup failed for ${path} with ${secret}`);
        }
        return nodeChmodSync(path, mode);
      },
      mkdtempSync(...parameters) {
        directoryPath = nodeMkdtempSync(...parameters);
        return directoryPath;
      },
      rmSync: nodeRmSync,
      writeFileSync(path, contents, options) {
        if (failureStep === "file write") {
          throw new Error(`setup failed for ${path} with ${secret}`);
        }
        return nodeWriteFileSync(path, contents, options);
      },
    };

    await assert.rejects(
      runAwsCli(
        args,
        { input, inputFileSystem },
        () => {
          executions += 1;
          return "";
        },
      ),
      (error) => {
        assert.equal(
          error.message,
          "AWS CLI admin-create-user failed (exit code unknown).",
        );
        assert.equal(directoryPath === undefined, false);
        const diagnostics = diagnosticText(error);
        assert.equal(diagnostics.includes(secret), false);
        assert.equal(diagnostics.includes(directoryPath), false);
        return true;
      },
    );

    assert.equal(executions, 0);
    assert.equal(existsSync(join(directoryPath, "input.json")), false);
    assert.equal(existsSync(directoryPath), false);
  });
}

test("setup and recovered cleanup failures return the dedicated cleanup error without residue", async () => {
  const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
  const input = JSON.stringify({ TemporaryPassword: secret });
  const args = [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///dev/stdin",
  ];
  let directoryPath;
  let removalAttempts = 0;
  let executions = 0;
  const inputFileSystem = {
    chmodSync(path) {
      throw new Error(`setup failed for ${path} with ${secret}`);
    },
    mkdtempSync(...parameters) {
      directoryPath = nodeMkdtempSync(...parameters);
      return directoryPath;
    },
    rmSync(path, options) {
      removalAttempts += 1;
      if (removalAttempts === 1) {
        throw new Error(`removal failed for ${path} with ${secret}`);
      }
      return nodeRmSync(path, options);
    },
    writeFileSync: nodeWriteFileSync,
  };

  try {
    await assert.rejects(
      runAwsCli(
        args,
        { input, inputFileSystem },
        () => {
          executions += 1;
          return "";
        },
      ),
      (error) => {
        assert.equal(error.name, "TemporaryInputCleanupError");
        assert.equal(error.code, "TEMP_INPUT_CLEANUP_RECOVERED");
        assert.equal(
          error.message,
          "AWS CLI temporary input cleanup required secure recovery.",
        );
        assert.equal(directoryPath === undefined, false);
        const diagnostics = diagnosticText(error);
        assert.equal(diagnostics.includes(secret), false);
        assert.equal(diagnostics.includes(directoryPath), false);
        return true;
      },
    );

    assert.equal(executions, 0);
    assert.equal(removalAttempts, 2);
    assert.equal(existsSync(directoryPath), false);
  } finally {
    if (directoryPath !== undefined) {
      nodeRmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

test("command and persistent cleanup failures report cleanup failure after secret scrubbing", async () => {
  const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
  const input = JSON.stringify({ TemporaryPassword: secret });
  const args = [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///dev/stdin",
  ];
  let directoryPath;
  let removalAttempts = 0;
  let executions = 0;
  const inputFileSystem = {
    chmodSync: nodeChmodSync,
    mkdtempSync(...parameters) {
      directoryPath = nodeMkdtempSync(...parameters);
      return directoryPath;
    },
    rmSync(path) {
      removalAttempts += 1;
      throw new Error(`removal failed for ${path} with ${secret}`);
    },
    writeFileSync: nodeWriteFileSync,
  };

  try {
    await assert.rejects(
      runAwsCli(
        args,
        { input, inputFileSystem },
        () => {
          executions += 1;
          const error = new Error(
            `command failed for ${directoryPath} with ${secret}`,
          );
          error.status = 255;
          error.stderr = `command failed with ${secret}`;
          throw error;
        },
      ),
      (error) => {
        assert.equal(error.name, "TemporaryInputCleanupError");
        assert.equal(
          error.code,
          "TEMP_INPUT_CLEANUP_FAILED_AFTER_SECRET_SCRUBBING",
        );
        assert.equal(
          error.message,
          "AWS CLI temporary input cleanup failed after secret scrubbing.",
        );
        const diagnostics = diagnosticText(error);
        assert.equal(diagnostics.includes(secret), false);
        assert.equal(diagnostics.includes(directoryPath), false);
        return true;
      },
    );

    const filePath = join(directoryPath, "input.json");
    assert.equal(executions, 1);
    assert.equal(removalAttempts, 2);
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, "utf8"), "");
  } finally {
    if (directoryPath !== undefined) {
      nodeRmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

test("command, cleanup, and secret scrubbing failures return the conservative cleanup error", async () => {
  const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
  const input = JSON.stringify({ TemporaryPassword: secret });
  const args = [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///dev/stdin",
  ];
  let directoryPath;
  let removalAttempts = 0;
  let writeAttempts = 0;
  let executions = 0;
  const inputFileSystem = {
    chmodSync: nodeChmodSync,
    mkdtempSync(...parameters) {
      directoryPath = nodeMkdtempSync(...parameters);
      return directoryPath;
    },
    rmSync(path) {
      removalAttempts += 1;
      throw new Error(`removal failed for ${path} with ${secret}`);
    },
    writeFileSync(path, contents, options) {
      writeAttempts += 1;
      if (writeAttempts === 2) {
        throw new Error(`scrub failed for ${path} with ${secret}`);
      }
      return nodeWriteFileSync(path, contents, options);
    },
  };

  try {
    await assert.rejects(
      runAwsCli(
        args,
        { input, inputFileSystem },
        () => {
          executions += 1;
          const error = new Error(
            `command failed for ${directoryPath} with ${secret}`,
          );
          error.status = 255;
          error.stderr = `command failed with ${secret}`;
          throw error;
        },
      ),
      (error) => {
        assert.equal(error.name, "TemporaryInputCleanupError");
        assert.equal(
          error.code,
          "TEMP_INPUT_CLEANUP_AND_SECRET_SCRUBBING_FAILED",
        );
        assert.equal(
          error.message,
          "AWS CLI temporary input cleanup and secret scrubbing failed.",
        );
        const diagnostics = diagnosticText(error);
        assert.equal(diagnostics.includes(secret), false);
        assert.equal(diagnostics.includes(directoryPath), false);
        return true;
      },
    );

    const filePath = join(directoryPath, "input.json");
    assert.equal(executions, 1);
    assert.equal(removalAttempts, 2);
    assert.equal(writeAttempts, 2);
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, "utf8").includes(secret), true);
  } finally {
    if (directoryPath !== undefined) {
      nodeRmSync(directoryPath, { recursive: true, force: true });
    }
  }
});

for (const invalidArgs of [
  [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///tmp/input.json",
  ],
  [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///dev/stdin ",
  ],
  [
    "cognito-idp",
    "admin-create-user",
    "file:///dev/stdin",
  ],
  [
    "cognito-idp",
    "admin-create-user",
    "--cli-input-json",
    "file:///dev/stdin",
    "--cli-input-json",
    "file:///dev/stdin",
  ],
]) {
  test("input-bearing AWS calls reject invalid stdin sentinel usage before execution", async () => {
    const secret = createPasswords([PRIMARY_ADMIN]).platform_admin_01;
    const input = JSON.stringify({ TemporaryPassword: secret });
    let executions = 0;

    await assert.rejects(
      runAwsCli(invalidArgs, { input }, () => {
        executions += 1;
        return "";
      }),
      (error) => {
        assert.equal(error.name, "AwsCliError");
        assert.equal(
          error.message,
          "AWS CLI admin-create-user failed (exit code unknown).",
        );
        assert.equal(diagnosticText(error).includes(secret), false);
        return true;
      },
    );

    assert.equal(executions, 0);
  });
}

test("AWS CLI errors hide stderr while retaining exact user-not-found classification", async () => {
  const calls = [];
  let lookupError;
  const execFileSync = () => {
    const error = new Error("lookup failed");
    error.status = 254;
    error.stderr = NOT_FOUND_STDERR;
    throw error;
  };
  const runAws = async (args, options = {}) => {
    calls.push({ args, hasInput: Object.hasOwn(options, "input") });
    if (args[1] !== "admin-get-user") {
      return { stdout: "", stderr: "" };
    }
    try {
      await runAwsCli(args, options, execFileSync);
    } catch (error) {
      lookupError = error;
      throw error;
    }
  };

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: passwordProvider(createPasswords([PRIMARY_ADMIN])),
    region: REGION,
    users: [PRIMARY_ADMIN],
    runAws,
  });

  assert.equal(lookupError.code, 254);
  assert.equal(lookupError.stderr, undefined);
  assert.equal(Object.hasOwn(lookupError, "stderr"), false);
  assert.equal(Object.keys(lookupError).includes("stderr"), false);
  assert.equal(JSON.stringify(lookupError).includes(NOT_FOUND_STDERR), false);
  assert.deepEqual(calls.map(({ args }) => args[1]), [
    "admin-get-user",
    "admin-create-user",
    "admin-add-user-to-group",
  ]);
  assert.deepEqual(calls.map(({ hasInput }) => hasInput), [false, true, false]);
});

test("exact admin-delete-user absence is classified without exposing AWS stderr", async () => {
  let sanitizedError;
  try {
    await runAwsCli(
      [
        "cognito-idp",
        "admin-delete-user",
        "--user-pool-id",
        USER_POOL_ID,
        "--username",
        "hosted-acceptance-user",
        "--region",
        REGION,
      ],
      undefined,
      () => {
        const error = new Error("delete failed");
        error.status = 254;
        error.stderr = DELETE_NOT_FOUND_STDERR;
        throw error;
      },
    );
  } catch (error) {
    sanitizedError = error;
  }

  assert.ok(sanitizedError);
  assert.equal(isAwsCliUserNotFound(sanitizedError), true);
  assert.equal(Object.hasOwn(sanitizedError, "stderr"), false);
  assert.doesNotMatch(diagnosticText(sanitizedError), /UserNotFoundException/);
});

test("current AWS CLI exact user-not-found stderr permits safe creation", async () => {
  const calls = [];
  let lookupError;
  const execFileSync = () => {
    const error = new Error("lookup failed");
    error.status = 254;
    error.stderr = CURRENT_NOT_FOUND_STDERR;
    throw error;
  };
  const runAws = async (args, options = {}) => {
    calls.push({ args, hasInput: Object.hasOwn(options, "input") });
    if (args[1] !== "admin-get-user") {
      return { stdout: "", stderr: "" };
    }
    try {
      await runAwsCli(args, options, execFileSync);
    } catch (error) {
      lookupError = error;
      throw error;
    }
  };

  await seedDemoUsers({
    userPoolId: USER_POOL_ID,
    passwordFor: passwordProvider(createPasswords([PRIMARY_ADMIN])),
    region: REGION,
    users: [PRIMARY_ADMIN],
    runAws,
  });

  assert.equal(lookupError.code, 254);
  assert.equal(Object.hasOwn(lookupError, "stderr"), false);
  assert.equal(
    JSON.stringify(lookupError).includes(CURRENT_NOT_FOUND_STDERR),
    false,
  );
  assert.deepEqual(calls.map(({ args }) => args[1]), [
    "admin-get-user",
    "admin-create-user",
    "admin-add-user-to-group",
  ]);
  assert.deepEqual(calls.map(({ hasInput }) => hasInput), [false, true, false]);
});

for (const operation of ['admin-get-user', 'admin-delete-user']) {
  const api = operation === 'admin-get-user' ? 'AdminGetUser' : 'AdminDeleteUser';
  const actualCliOutput = `\nAn error occurred (UserNotFoundException) when calling the ${api} operation: User does not exist.\n`;
  for (const [name, stderr, accepted] of [
    ['leading blank line', actualCliOutput, true],
    ['leading blank line plus warning', actualCliOutput + 'warning: retrying\n', false],
  ]) {
    test(`${operation} ${name} preserves exact absence classification`, async () => {
      await assert.rejects(runAwsCli(['cognito-idp', operation], undefined, () => {
        const error = new Error('AWS lookup failed');
        error.status = 254;
        error.stderr = stderr;
        throw error;
      }), error => {
        assert.equal(isAwsCliUserNotFound(error), accepted);
        assert.equal(Object.hasOwn(error, 'stderr'), false);
        return true;
      });
    });
  }
}
