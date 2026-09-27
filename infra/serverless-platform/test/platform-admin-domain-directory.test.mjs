import assert from "node:assert/strict";
import test from "node:test";
import {
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupCommand,
  GroupExistsException,
  ListUsersInGroupCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DomainGroupConflictError,
  createDomainDirectory,
  domainGroupDescription,
} from "../lambda/platform-admin/domain-directory.mjs";

const USER_POOL_ID = "us-west-2_Example123";
const OWNER_GROUP = "domain-finance-operations";
const OPERATION_TOKEN = "a".repeat(64);
const OTHER_OPERATION_TOKEN = "b".repeat(64);

function sdkError(Type, message) {
  return new Type({ message, $metadata: {} });
}

function managedGroup(
  operationToken = OPERATION_TOKEN,
  overrides = {},
) {
  return {
    GroupName: OWNER_GROUP,
    UserPoolId: USER_POOL_ID,
    Description: domainGroupDescription(
      OWNER_GROUP,
      operationToken,
    ),
    ...overrides,
  };
}

function directoryFor(send, { sleep } = {}) {
  const configuration = {
    cognito: { send },
    userPoolId: USER_POOL_ID,
    ...(sleep === undefined ? {} : { sleep }),
  };
  return createDomainDirectory(configuration);
}

function commandNames(calls) {
  return calls.map((command) => command.constructor.name);
}

function sanitizedConflict(error) {
  return (
    error instanceof DomainGroupConflictError
    && error.name === "DomainGroupConflictError"
    && error.code === "DOMAIN_GROUP_CONFLICT"
    && error.statusCode === 409
    && error.retryable === false
    && error.cause === undefined
    && !String(error).includes(OPERATION_TOKEN)
    && !String(error).includes(OTHER_OPERATION_TOKEN)
  );
}

test("builds a versioned operation-bound portable ownership marker", () => {
  const description = domainGroupDescription(
    OWNER_GROUP,
    OPERATION_TOKEN,
  );

  assert.equal(
    description,
    domainGroupDescription(OWNER_GROUP, OPERATION_TOKEN),
  );
  assert.match(description, /agentic-ai-platform-demo/);
  assert.match(description, /domain-group:v2/);
  assert.match(description, new RegExp(OWNER_GROUP));
  assert.match(description, new RegExp(OPERATION_TOKEN));
  assert.match(description, /auto-delete=no/);
  assert.doesNotMatch(
    description,
    /@|arn:|account|email|region|request|subject|username|us-west-2/i,
  );

  for (const ownerGroup of [
    undefined,
    "",
    "domain-",
    "domain-Finance",
    "domain-finance_operations",
    "domain--finance",
    "domain-finance-",
    `domain-${"a".repeat(122)}`,
  ]) {
    assert.throws(
      () => domainGroupDescription(ownerGroup, OPERATION_TOKEN),
      /domain group name is invalid/i,
    );
  }
  for (const operationToken of [
    undefined,
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
  ]) {
    assert.throws(
      () => domainGroupDescription(OWNER_GROUP, operationToken),
      /operation token is invalid/i,
    );
  }

  assert.equal(
    new DomainGroupConflictError().code,
    "DOMAIN_GROUP_CONFLICT",
  );
});

test("validates exact dependencies and optional strict sleep injection", () => {
  const cognito = { async send() {} };
  const sleep = async () => {};
  assert.equal(
    Object.isFrozen(createDomainDirectory({
      cognito,
      userPoolId: USER_POOL_ID,
    })),
    true,
  );
  assert.doesNotThrow(() => createDomainDirectory({
    cognito,
    userPoolId: USER_POOL_ID,
    sleep,
  }));

  for (const configuration of [
    undefined,
    null,
    {},
    { cognito, userPoolId: USER_POOL_ID, extra: true },
    { cognito: {}, userPoolId: USER_POOL_ID },
    { cognito: { send: "invalid" }, userPoolId: USER_POOL_ID },
    { cognito, userPoolId: USER_POOL_ID, sleep: "invalid" },
    { cognito, userPoolId: "us-gov-west-1_Example123" },
    { cognito, userPoolId: "cn-north-1_Example123" },
    { cognito, userPoolId: "pool-id" },
  ]) {
    assert.throws(
      () => createDomainDirectory(configuration),
      /domain directory configuration is invalid/i,
    );
  }

  let getterCalls = 0;
  const accessorConfiguration = { userPoolId: USER_POOL_ID };
  Object.defineProperty(accessorConfiguration, "cognito", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return cognito;
    },
  });
  assert.throws(
    () => createDomainDirectory(accessorConfiguration),
    /domain directory configuration is invalid/i,
  );
  assert.equal(getterCalls, 0);
});

test("rejects Object.prototype send pollution without invocation", () => {
  const original = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "send",
  );
  let invocations = 0;
  Object.defineProperty(Object.prototype, "send", {
    configurable: true,
    value() {
      invocations += 1;
      throw new Error("polluted Object.prototype.send invoked");
    },
  });

  try {
    assert.throws(
      () => createDomainDirectory({
        cognito: {},
        userPoolId: USER_POOL_ID,
      }),
      /domain directory configuration is invalid/i,
    );
    assert.equal(invocations, 0);

    const sdkClient = new CognitoIdentityProviderClient({
      region: "us-west-2",
    });
    try {
      assert.doesNotThrow(() => createDomainDirectory({
        cognito: sdkClient,
        userPoolId: USER_POOL_ID,
      }));
    } finally {
      sdkClient.destroy();
    }
    assert.equal(invocations, 0);
  } finally {
    if (original === undefined) {
      delete Object.prototype.send;
    } else {
      Object.defineProperty(Object.prototype, "send", original);
    }
  }
});

test("validates names and operation tokens before SDK calls", async () => {
  let calls = 0;
  const directory = directoryFor(async () => {
    calls += 1;
    return {};
  });

  for (const operation of [
    directory.ensureGroup,
    directory.deleteGroupExact,
  ]) {
    await assert.rejects(
      operation("domain-Finance", OPERATION_TOKEN),
      /domain group name is invalid/i,
    );
    await assert.rejects(
      operation(OWNER_GROUP, "A".repeat(64)),
      /operation token is invalid/i,
    );
  }
  assert.equal(calls, 0);
});

test("ensureGroup creates and validates the exact token-bound group", async () => {
  const calls = [];
  const directory = directoryFor(async (command) => {
    calls.push(command);
    return { Group: managedGroup() };
  });

  assert.equal(
    await directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
    undefined,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof CreateGroupCommand);
  assert.deepEqual(calls[0].input, {
    UserPoolId: USER_POOL_ID,
    GroupName: OWNER_GROUP,
    Description: domainGroupDescription(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
  });
  assert.deepEqual(Reflect.ownKeys(calls[0].input), [
    "UserPoolId",
    "GroupName",
    "Description",
  ]);
});

test("ensureGroup rejects malformed and non-exact create responses", async () => {
  const responses = [
    undefined,
    null,
    {},
    { Group: null },
    { Group: {} },
    {
      Group: {
        GroupName: OWNER_GROUP,
        Description: domainGroupDescription(
          OWNER_GROUP,
          OPERATION_TOKEN,
        ),
      },
    },
    { Group: managedGroup(OPERATION_TOKEN, {
      GroupName: "domain-other",
    }) },
    { Group: managedGroup(OTHER_OPERATION_TOKEN) },
    { Group: managedGroup(OPERATION_TOKEN, {
      RoleArn: undefined,
    }) },
    { Group: managedGroup(OPERATION_TOKEN, {
      Precedence: 0,
    }) },
  ];

  for (const response of responses) {
    const directory = directoryFor(async (command) => {
      assert.ok(command instanceof CreateGroupCommand);
      return response;
    });
    await assert.rejects(
      directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
      /Cognito domain group response is invalid/i,
    );
  }
});

test("every create failure performs one exact reconciliation read", async () => {
  const failures = [
    sdkError(GroupExistsException, "private collision"),
    new Error("private ambiguous create"),
    new TypeError("private transport failure"),
    Object.assign(new Error("private lookalike"), {
      name: "GroupExistsException",
    }),
  ];

  for (const createFailure of failures) {
    const calls = [];
    const directory = directoryFor(async (command) => {
      calls.push(command);
      if (command instanceof CreateGroupCommand) throw createFailure;
      return { Group: managedGroup() };
    });

    assert.equal(
      await directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
      undefined,
    );
    assert.deepEqual(commandNames(calls), [
      "CreateGroupCommand",
      "GetGroupCommand",
    ]);
    assert.deepEqual(calls[1].input, {
      UserPoolId: USER_POOL_ID,
      GroupName: OWNER_GROUP,
    });
  }
});

test("create reconciliation rethrows the original error only for real absence", async () => {
  const createFailure = new Error("private ambiguous create");
  const calls = [];
  const directory = directoryFor(async (command) => {
    calls.push(command);
    if (command instanceof CreateGroupCommand) throw createFailure;
    throw sdkError(
      ResourceNotFoundException,
      "private absent group",
    );
  });

  await assert.rejects(
    directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
    (error) => error === createFailure,
  );
  assert.deepEqual(commandNames(calls), [
    "CreateGroupCommand",
    "GetGroupCommand",
  ]);
});

test("create reconciliation rejects a concurrent operation's group", async () => {
  const calls = [];
  const directory = directoryFor(async (command) => {
    calls.push(command);
    if (command instanceof CreateGroupCommand) {
      throw sdkError(GroupExistsException, "private collision");
    }
    return { Group: managedGroup(OTHER_OPERATION_TOKEN) };
  });

  await assert.rejects(
    directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
    sanitizedConflict,
  );
  assert.deepEqual(commandNames(calls), [
    "CreateGroupCommand",
    "GetGroupCommand",
  ]);
});

test("create reconciliation fails closed on malformed or foreign groups", async () => {
  for (const response of [
    {},
    { Group: {} },
    { Group: managedGroup(OPERATION_TOKEN, { RoleArn: "foreign" }) },
    { Group: managedGroup(OPERATION_TOKEN, { Precedence: 1 }) },
  ]) {
    const directory = directoryFor(async (command) => {
      if (command instanceof CreateGroupCommand) {
        throw new Error("private create failure");
      }
      return response;
    });
    await assert.rejects(
      directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
      response.Group?.GroupName === OWNER_GROUP
        ? sanitizedConflict
        : /Cognito domain group response is invalid/i,
    );
  }
});

test("create reconciliation rethrows lookup errors and not-found lookalikes", async () => {
  for (const lookupFailure of [
    new Error("private lookup failure"),
    Object.assign(new Error("private lookup lookalike"), {
      name: "ResourceNotFoundException",
    }),
  ]) {
    const directory = directoryFor(async (command) => {
      if (command instanceof CreateGroupCommand) {
        throw new Error("private create failure");
      }
      throw lookupFailure;
    });
    await assert.rejects(
      directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
      (error) => error === lookupFailure,
    );
  }
});

test("deleteGroupExact treats real pre-delete absence as idempotent success", async () => {
  const calls = [];
  const directory = directoryFor(async (command) => {
    calls.push(command);
    throw sdkError(
      ResourceNotFoundException,
      "private absent group",
    );
  });

  assert.equal(
    await directory.deleteGroupExact(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
    undefined,
  );
  assert.deepEqual(commandNames(calls), ["GetGroupCommand"]);
});

test("deleteGroupExact refuses a concurrent operation's group before membership lookup", async () => {
  const calls = [];
  const directory = directoryFor(async (command) => {
    calls.push(command);
    return { Group: managedGroup(OTHER_OPERATION_TOKEN) };
  });

  await assert.rejects(
    directory.deleteGroupExact(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
    sanitizedConflict,
  );
  assert.deepEqual(commandNames(calls), ["GetGroupCommand"]);
});

test("deleteGroupExact refuses a nonempty exact group without deleting", async () => {
  const calls = [];
  const directory = directoryFor(async (command) => {
    calls.push(command);
    if (command instanceof GetGroupCommand) {
      return { Group: managedGroup() };
    }
    assert.ok(command instanceof ListUsersInGroupCommand);
    return { Users: [{ Username: "private-member" }] };
  });

  await assert.rejects(
    directory.deleteGroupExact(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
    /Cognito domain group is not empty/i,
  );
  assert.deepEqual(commandNames(calls), [
    "GetGroupCommand",
    "ListUsersInGroupCommand",
  ]);
});

test("deleteGroupExact rejects malformed membership pages without deleting", async () => {
  const sparseUsers = [];
  sparseUsers.length = 1;
  for (const response of [
    undefined,
    null,
    {},
    { Users: null },
    { Users: sparseUsers },
    { Users: [], NextToken: "unexpected" },
    { Users: [], Extra: true },
  ]) {
    const calls = [];
    const directory = directoryFor(async (command) => {
      calls.push(command);
      return command instanceof GetGroupCommand
        ? { Group: managedGroup() }
        : response;
    });

    await assert.rejects(
      directory.deleteGroupExact(
        OWNER_GROUP,
        OPERATION_TOKEN,
      ),
      /Cognito domain group membership response is invalid/i,
    );
    assert.deepEqual(commandNames(calls), [
      "GetGroupCommand",
      "ListUsersInGroupCommand",
    ]);
  }
});

test("deleteGroupExact uses exact order and confirms real absence", async () => {
  const calls = [];
  let getCalls = 0;
  const directory = directoryFor(async (command) => {
    calls.push(command);
    if (command instanceof GetGroupCommand) {
      getCalls += 1;
      if (getCalls === 1) return { Group: managedGroup() };
      throw sdkError(
        ResourceNotFoundException,
        "private confirmed absence",
      );
    }
    if (command instanceof ListUsersInGroupCommand) {
      return { Users: [] };
    }
    assert.ok(command instanceof DeleteGroupCommand);
    return {};
  });

  assert.equal(
    await directory.deleteGroupExact(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
    undefined,
  );
  assert.deepEqual(commandNames(calls), [
    "GetGroupCommand",
    "ListUsersInGroupCommand",
    "DeleteGroupCommand",
    "GetGroupCommand",
  ]);
  assert.deepEqual(calls[1].input, {
    UserPoolId: USER_POOL_ID,
    GroupName: OWNER_GROUP,
    Limit: 1,
  });
  assert.deepEqual(calls[2].input, {
    UserPoolId: USER_POOL_ID,
    GroupName: OWNER_GROUP,
  });
});

test("deleteGroupExact polls a bounded number of times before confirmed absence", async () => {
  const calls = [];
  const sleeps = [];
  let getCalls = 0;
  const directory = directoryFor(async (command) => {
    calls.push(command);
    if (command instanceof GetGroupCommand) {
      getCalls += 1;
      if (getCalls < 4) return { Group: managedGroup() };
      throw sdkError(
        ResourceNotFoundException,
        "private confirmed absence",
      );
    }
    if (command instanceof ListUsersInGroupCommand) {
      return { Users: [] };
    }
    return {};
  }, {
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
    },
  });

  await directory.deleteGroupExact(
    OWNER_GROUP,
    OPERATION_TOKEN,
  );
  assert.equal(
    commandNames(calls).filter((name) => name === "GetGroupCommand")
      .length,
    4,
  );
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every(
    (value) => Number.isSafeInteger(value) && value > 0,
  ));
});

test("delete ambiguity succeeds only after confirmed absence", async () => {
  const deleteFailure = new Error("private ambiguous delete");
  const calls = [];
  let getCalls = 0;
  const directory = directoryFor(async (command) => {
    calls.push(command);
    if (command instanceof GetGroupCommand) {
      getCalls += 1;
      if (getCalls <= 2) return { Group: managedGroup() };
      throw sdkError(
        ResourceNotFoundException,
        "private confirmed absence",
      );
    }
    if (command instanceof ListUsersInGroupCommand) {
      return { Users: [] };
    }
    throw deleteFailure;
  }, {
    async sleep() {},
  });

  assert.equal(
    await directory.deleteGroupExact(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
    undefined,
  );
  assert.deepEqual(commandNames(calls), [
    "GetGroupCommand",
    "ListUsersInGroupCommand",
    "DeleteGroupCommand",
    "GetGroupCommand",
    "GetGroupCommand",
  ]);
});

test("delete ambiguity rethrows its error when bounded polling never confirms absence", async () => {
  for (const deleteFailure of [
    new Error("private ambiguous delete"),
    sdkError(
      ResourceNotFoundException,
      "private unconfirmed delete absence",
    ),
  ]) {
    const calls = [];
    const directory = directoryFor(async (command) => {
      calls.push(command);
      if (command instanceof GetGroupCommand) {
        return { Group: managedGroup() };
      }
      if (command instanceof ListUsersInGroupCommand) {
        return { Users: [] };
      }
      throw deleteFailure;
    }, {
      async sleep() {},
    });

    await assert.rejects(
      directory.deleteGroupExact(
        OWNER_GROUP,
        OPERATION_TOKEN,
      ),
      (error) => error === deleteFailure,
    );
    assert.equal(
      commandNames(calls).filter(
        (name) => name === "GetGroupCommand",
      ).length,
      4,
    );
  }
});

test("post-delete polling fails closed on replacement, malformed, and lookup errors", async () => {
  const cases = [
    {
      response: { Group: managedGroup(OTHER_OPERATION_TOKEN) },
      expected: sanitizedConflict,
    },
    {
      response: {},
      expected: /Cognito domain group response is invalid/i,
    },
    {
      failure: Object.assign(new Error("private not-found lookalike"), {
        name: "ResourceNotFoundException",
      }),
    },
  ];

  for (const fixture of cases) {
    let getCalls = 0;
    const directory = directoryFor(async (command) => {
      if (command instanceof GetGroupCommand) {
        getCalls += 1;
        if (getCalls === 1) return { Group: managedGroup() };
        if (fixture.failure) throw fixture.failure;
        return fixture.response;
      }
      if (command instanceof ListUsersInGroupCommand) {
        return { Users: [] };
      }
      return {};
    });

    await assert.rejects(
      directory.deleteGroupExact(
        OWNER_GROUP,
        OPERATION_TOKEN,
      ),
      fixture.failure
        ? (error) => error === fixture.failure
        : fixture.expected,
    );
  }
});

test("delete lookup does not trust ResourceNotFoundException lookalikes", async () => {
  const lookalike = Object.assign(
    new Error("private pre-delete lookalike"),
    { name: "ResourceNotFoundException" },
  );
  const calls = [];
  const directory = directoryFor(async (command) => {
    calls.push(command);
    throw lookalike;
  });

  await assert.rejects(
    directory.deleteGroupExact(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
    (error) => error === lookalike,
  );
  assert.deepEqual(commandNames(calls), ["GetGroupCommand"]);
});

test("rejects accessor and extra-property SDK shapes without invoking getters", async () => {
  let getterCalls = 0;
  const createResponse = { Group: managedGroup() };
  Object.defineProperty(createResponse.Group, "CreationDate", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return new Date();
    },
  });
  const createDirectory = directoryFor(async () => createResponse);
  await assert.rejects(
    createDirectory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
    /Cognito domain group response is invalid/i,
  );

  const users = [];
  users.extra = true;
  const membershipDirectory = directoryFor(async (command) => {
    if (command instanceof GetGroupCommand) {
      return { Group: managedGroup() };
    }
    return { Users: users };
  });
  await assert.rejects(
    membershipDirectory.deleteGroupExact(
      OWNER_GROUP,
      OPERATION_TOKEN,
    ),
    /Cognito domain group membership response is invalid/i,
  );

  const metadataResponse = { Group: managedGroup() };
  Object.defineProperty(metadataResponse, "$metadata", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });
  const metadataDirectory = directoryFor(async () => metadataResponse);
  await assert.rejects(
    metadataDirectory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
    /Cognito domain group response is invalid/i,
  );
  assert.equal(getterCalls, 0);
});

test("validates genuine SDK Dates without invoking response-controlled getTime", async () => {
  const invocations = [];
  const ownAccessorDate = new Date("2026-08-26T00:00:00.000Z");
  Object.defineProperty(ownAccessorDate, "getTime", {
    configurable: true,
    get() {
      invocations.push("own-accessor");
      throw new Error("response-controlled own accessor invoked");
    },
  });

  const prototypeMethodDate = new Date("2026-08-26T00:00:01.000Z");
  const controlledPrototype = Object.create(Date.prototype);
  Object.defineProperty(controlledPrototype, "getTime", {
    configurable: true,
    value() {
      invocations.push("prototype-method");
      throw new Error("response-controlled prototype method invoked");
    },
  });
  Object.setPrototypeOf(prototypeMethodDate, controlledPrototype);

  const directory = directoryFor(async () => ({
    Group: managedGroup(OPERATION_TOKEN, {
      CreationDate: ownAccessorDate,
      LastModifiedDate: prototypeMethodDate,
    }),
  }));

  assert.equal(
    await directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
    undefined,
  );
  assert.deepEqual(invocations, []);
});

test("rejects Date-prototype lookalikes without invoking their fake getTime", async () => {
  let invocations = 0;
  const controlledPrototype = Object.create(Date.prototype);
  Object.defineProperty(controlledPrototype, "getTime", {
    configurable: true,
    value() {
      invocations += 1;
      return 0;
    },
  });
  const slotlessDateLookalike = Object.create(controlledPrototype);
  assert.equal(slotlessDateLookalike instanceof Date, true);

  const directory = directoryFor(async () => ({
    Group: managedGroup(OPERATION_TOKEN, {
      CreationDate: slotlessDateLookalike,
    }),
  }));

  await assert.rejects(
    directory.ensureGroup(OWNER_GROUP, OPERATION_TOKEN),
    /Cognito domain group response is invalid/i,
  );
  assert.equal(invocations, 0);
});
