import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createDynamoLease,
  parsePrivateSelection,
  readPrivateStdin,
  reconcileDemoOperator,
  runCli,
} from "./reconcile-demo-operator.mjs";

const REGION = "us-west-2";
const USER_POOL_ID = `${REGION}_PortableDemo`;
const GROUP_NAME = "demo-operator";
const PLATFORM_ADMIN_GROUP = "platform-admin";
const PLATFORM_STATE_TABLE_NAME = "AgenticPlatform-State";
const SELECTED_USERNAMES = Object.freeze([
  "selected-operator-a",
  "selected-operator-b",
]);
const [SELECTED_USERNAME, SECOND_SELECTED_USERNAME] = SELECTED_USERNAMES;
const STALE_USERNAME = "stale-operator";

function diagnosticText(error) {
  return [
    error?.message,
    error?.stack,
    error?.cause,
    error?.stdout,
    error?.stderr,
    error?.input,
  ]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function createCognitoHarness({
  enabled = true,
  members = [],
  onSend,
  pageSize = 60,
  selectedGroups = [PLATFORM_ADMIN_GROUP],
  userStatus = "CONFIRMED",
} = {}) {
  const calls = [];
  const state = {
    members: members.map((member) => ({ ...member })),
  };
  const client = {
    async send(command) {
      const call = {
        name: command.constructor.name,
        input: structuredClone(command.input),
      };
      calls.push(call);
      const override = await onSend?.({ call, calls, state });
      if (override !== undefined) return override;

      if (call.name === "AdminGetUserCommand") {
        const username = call.input.Username;
        return {
          Username: username,
          Enabled: typeof enabled === "boolean"
            ? enabled
            : enabled[username] ?? true,
          UserStatus: typeof userStatus === "string"
            ? userStatus
            : userStatus[username] ?? "CONFIRMED",
        };
      }
      if (call.name === "AdminListGroupsForUserCommand") {
        const groups = Array.isArray(selectedGroups)
          ? selectedGroups
          : selectedGroups[call.input.Username] ?? [PLATFORM_ADMIN_GROUP];
        return {
          Groups: groups.map((GroupName) => ({ GroupName })),
        };
      }
      if (call.name === "ListUsersInGroupCommand") {
        const offset = call.input.NextToken === undefined
          ? 0
          : Number(call.input.NextToken);
        const users = state.members
          .slice(offset, offset + pageSize)
          .map(({ username, memberEnabled = true }) => ({
            Username: username,
            Enabled: memberEnabled,
            UserStatus: "CONFIRMED",
          }));
        const nextOffset = offset + users.length;
        return {
          Users: users,
          ...(nextOffset < state.members.length
            ? { NextToken: String(nextOffset) }
            : {}),
        };
      }
      if (call.name === "AdminRemoveUserFromGroupCommand") {
        state.members = state.members.filter(
          ({ username }) => username !== call.input.Username,
        );
        return {};
      }
      if (call.name === "AdminAddUserToGroupCommand") {
        if (!state.members.some(
          ({ username }) => username === call.input.Username,
        )) {
          state.members.push({
            username: call.input.Username,
            memberEnabled: true,
          });
        }
        return {};
      }
      assert.fail(`Unexpected Cognito command ${call.name}`);
    },
  };
  return { calls, client, state };
}

function createLeaseHarness({
  acquireError,
  onCall,
  releaseError,
  renewError,
} = {}) {
  const calls = [];
  return {
    calls,
    lease: {
      async acquire() {
        calls.push("acquire");
        onCall?.("acquire");
        if (acquireError) throw acquireError;
      },
      async release() {
        calls.push("release");
        onCall?.("release");
        if (releaseError) throw releaseError;
      },
      async renew() {
        calls.push("renew");
        onCall?.("renew");
        if (renewError) throw renewError;
      },
    },
  };
}

function reconciliationInput(client, overrides = {}) {
  const { lease } = createLeaseHarness();
  return {
    client,
    groupName: GROUP_NAME,
    lease,
    maxMembers: 100,
    maxPages: 10,
    compensationQuiescenceMs: 1,
    operationTimeoutMs: 100,
    userPoolId: USER_POOL_ID,
    usernames: SELECTED_USERNAMES,
    ...overrides,
  };
}

test("only the demo-operator group can be reconciled", async () => {
  const { calls, client, state } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
  });
  const leaseHarness = createLeaseHarness();

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      groupName: PLATFORM_ADMIN_GROUP,
      lease: leaseHarness.lease,
    })),
    /COGNITO_DEMO_OPERATOR_GROUP must be demo-operator\./,
  );

  assert.deepEqual(leaseHarness.calls, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(state.members, [{ username: STALE_USERNAME }]);
});

test("rejects a selected user without permanent platform-admin membership before mutation", async () => {
  const { calls, client, state } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
    selectedGroups: {
      [SECOND_SELECTED_USERNAME]: ["end-user"],
    },
  });
  const leaseHarness = createLeaseHarness();

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      lease: leaseHarness.lease,
    })),
    /Selected Cognito user must be a permanent platform administrator\./,
  );

  assert.deepEqual(
    leaseHarness.calls,
    ["acquire", "renew", "renew", "renew", "renew", "release"],
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
    ],
  );
  assert.equal(
    calls.some(({ name }) =>
      name === "ListUsersInGroupCommand"
      || name === "AdminAddUserToGroupCommand"
      || name === "AdminRemoveUserFromGroupCommand"),
    false,
  );
  assert.deepEqual(state.members, [{ username: STALE_USERNAME }]);
});

test("lease acquisition failure performs no Cognito operation", async () => {
  const { calls, client } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
  });
  const leaseHarness = createLeaseHarness({
    acquireError: new Error("held by another deployment"),
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      lease: leaseHarness.lease,
    })),
    /Demo operator reconciliation lease could not be acquired\./,
  );

  assert.deepEqual(leaseHarness.calls, ["acquire"]);
  assert.deepEqual(calls, []);
});

test("lease renewal failure stops before the next Cognito operation and still releases ownership", async () => {
  const { calls, client } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
  });
  const leaseHarness = createLeaseHarness({
    renewError: new Error("lease owner changed"),
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      lease: leaseHarness.lease,
    })),
    /Demo operator reconciliation lease ownership verification failed\./,
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(
    leaseHarness.calls,
    ["acquire", "renew", "release"],
  );
});

test("postcondition failure restores every original member and removes a selected member added by this run", async () => {
  let groupListCalls = 0;
  const { client, state } = createCognitoHarness({
    members: [
      { username: STALE_USERNAME },
      { username: "second-stale-operator" },
    ],
    onSend: ({ call }) => {
      if (call.name !== "ListUsersInGroupCommand") return undefined;
      groupListCalls += 1;
      return groupListCalls === 2
        ? { Users: "malformed-postcondition" }
        : undefined;
    },
  });
  const leaseHarness = createLeaseHarness();

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      lease: leaseHarness.lease,
    })),
    /Cognito group membership response was malformed\./,
  );

  assert.deepEqual(
    state.members,
    [
      { username: STALE_USERNAME, memberEnabled: true },
      { username: "second-stale-operator", memberEnabled: true },
    ],
  );
  assert.equal(leaseHarness.calls.at(-1), "release");
  assert.equal(
    leaseHarness.calls.filter((call) => call === "release").length,
    1,
  );
});

test("postcondition revalidates permanent platform-admin membership and rolls back on revocation", async () => {
  const selectedGroupReads = new Map();
  const { client, state } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
    onSend: ({ call }) => {
      if (call.name !== "AdminListGroupsForUserCommand") return undefined;
      const count = (selectedGroupReads.get(call.input.Username) ?? 0) + 1;
      selectedGroupReads.set(call.input.Username, count);
      return {
        Groups: [{
          GroupName: call.input.Username !== SECOND_SELECTED_USERNAME
            || count === 1
            ? PLATFORM_ADMIN_GROUP
            : "end-user",
        }],
      };
    },
  });
  const leaseHarness = createLeaseHarness();

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      lease: leaseHarness.lease,
    })),
    /Demo operator postcondition verification failed\./,
  );

  assert.deepEqual(state.members, [{
    username: STALE_USERNAME,
    memberEnabled: true,
  }]);
  assert.equal(leaseHarness.calls.at(-1), "release");
});

test("an applied selected assignment with a lost SDK response restores the original membership snapshot", async () => {
  const { client, state } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
    onSend: ({ call, state: mutableState }) => {
      if (call.name !== "AdminAddUserToGroupCommand") return undefined;
      mutableState.members.push({
        username: call.input.Username,
        memberEnabled: true,
      });
      throw new Error("response lost after assignment");
    },
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client)),
    /Cognito group membership assignment failed\./,
  );

  assert.deepEqual(state.members, [{
    username: STALE_USERNAME,
  }]);
});

test("compensation restores a full membership snapshot after an ambiguous selected-user addition", async () => {
  const originalMembers = [
    { username: STALE_USERNAME },
    { username: "second-stale-operator" },
  ];
  let ambiguousAddition = true;
  const { client, state } = createCognitoHarness({
    members: originalMembers,
    onSend: ({ call, state: mutableState }) => {
      if (
        call.name !== "AdminAddUserToGroupCommand"
        || call.input.Username !== SELECTED_USERNAME
        || !ambiguousAddition
      ) {
        return undefined;
      }
      ambiguousAddition = false;
      mutableState.members.push({
        username: SELECTED_USERNAME,
        memberEnabled: true,
      });
      throw new Error("response lost after assignment");
    },
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      maxMembers: originalMembers.length,
    })),
    /Cognito group membership assignment failed\./,
  );

  assert.deepEqual(state.members, originalMembers);
});

test("compensation may read one extra page created by an ambiguous addition", async () => {
  const originalMembers = Array.from({ length: 60 }, (_, index) => ({
    username: `stale-operator-${String(index).padStart(2, "0")}`,
  }));
  let ambiguousAddition = true;
  const { client, state } = createCognitoHarness({
    members: originalMembers,
    pageSize: 60,
    onSend: ({ call, state: mutableState }) => {
      if (
        call.name !== "AdminAddUserToGroupCommand"
        || call.input.Username !== SELECTED_USERNAME
        || !ambiguousAddition
      ) {
        return undefined;
      }
      ambiguousAddition = false;
      mutableState.members.push({
        username: SELECTED_USERNAME,
        memberEnabled: true,
      });
      throw new Error("response lost after assignment");
    },
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      maxMembers: originalMembers.length,
      maxPages: 1,
    })),
    /Cognito group membership assignment failed\./,
  );

  assert.deepEqual(state.members, originalMembers);
});

test("compensation tolerates one-member pages after multiple selected additions", async () => {
  const originalMembers = [{ username: STALE_USERNAME }];
  let ambiguousAddition = true;
  const { client, state } = createCognitoHarness({
    members: originalMembers,
    pageSize: 1,
    onSend: ({ call, state: mutableState }) => {
      if (
        call.name !== "AdminAddUserToGroupCommand"
        || call.input.Username !== SECOND_SELECTED_USERNAME
        || !ambiguousAddition
      ) {
        return undefined;
      }
      ambiguousAddition = false;
      mutableState.members.push({
        username: SECOND_SELECTED_USERNAME,
        memberEnabled: true,
      });
      throw new Error("response lost after second assignment");
    },
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      maxMembers: originalMembers.length,
      maxPages: 1,
    })),
    /Cognito group membership assignment failed\./,
  );

  assert.deepEqual(state.members, originalMembers);
});

test("a selected assignment that lands after client timeout is removed before the lease is released", async () => {
  const state = {
    members: [{ username: STALE_USERNAME }],
  };
  const client = {
    async send(command, options) {
      const name = command.constructor.name;
      if (name === "AdminGetUserCommand") {
        return {
          Username: command.input.Username,
          Enabled: true,
          UserStatus: "CONFIRMED",
        };
      }
      if (name === "AdminListGroupsForUserCommand") {
        return {
          Groups: [{ GroupName: PLATFORM_ADMIN_GROUP }],
        };
      }
      if (name === "ListUsersInGroupCommand") {
        return {
          Users: state.members.map(({ username, memberEnabled = true }) => ({
            Username: username,
            Enabled: memberEnabled,
            UserStatus: "CONFIRMED",
          })),
        };
      }
      if (name === "AdminAddUserToGroupCommand") {
        setTimeout(() => {
          state.members.push({
            username: command.input.Username,
            memberEnabled: true,
          });
        }, 12);
        return new Promise((resolve, reject) => {
          options.abortSignal.addEventListener(
            "abort",
            () => reject(options.abortSignal.reason),
            { once: true },
          );
        });
      }
      if (name === "AdminRemoveUserFromGroupCommand") {
        state.members = state.members.filter(
          ({ username }) => username !== command.input.Username,
        );
        return {};
      }
      assert.fail(`Unexpected Cognito command ${name}`);
    },
  };
  const leaseHarness = createLeaseHarness();

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      compensationQuiescenceMs: 20,
      lease: leaseHarness.lease,
      operationTimeoutMs: 5,
    })),
    /Cognito group membership assignment failed\./,
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(state.members, [{
    username: STALE_USERNAME,
  }]);
  assert.equal(leaseHarness.calls.at(-1), "release");
});

test("an applied stale removal with a lost SDK response restores the original membership snapshot", async () => {
  const { client, state } = createCognitoHarness({
    members: [
      { username: SELECTED_USERNAME },
      { username: STALE_USERNAME },
    ],
    onSend: ({ call, state: mutableState }) => {
      if (
        call.name !== "AdminRemoveUserFromGroupCommand"
        || call.input.Username !== STALE_USERNAME
      ) {
        return undefined;
      }
      mutableState.members = mutableState.members.filter(
        ({ username }) => username !== STALE_USERNAME,
      );
      throw new Error("response lost after removal");
    },
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client)),
    /Cognito group membership removal failed\./,
  );

  assert.deepEqual(state.members, [
    { username: SELECTED_USERNAME },
    { username: STALE_USERNAME, memberEnabled: true },
  ]);
});

test("every bounded Cognito call is preceded by an owner-conditioned lease renewal", async () => {
  const sequence = [];
  const { client } = createCognitoHarness({
    members: [
      { username: STALE_USERNAME },
      { username: SELECTED_USERNAME },
    ],
    onSend: ({ call }) => {
      sequence.push(`cognito:${call.name}`);
      return undefined;
    },
  });
  const leaseHarness = createLeaseHarness({
    onCall: (name) => sequence.push(`lease:${name}`),
  });

  await reconcileDemoOperator(reconciliationInput(client, {
    lease: leaseHarness.lease,
  }));

  for (let index = 0; index < sequence.length; index += 1) {
    if (!sequence[index].startsWith("cognito:")) continue;
    assert.equal(sequence[index - 1], "lease:renew");
  }
  assert.equal(sequence[0], "lease:acquire");
  assert.equal(sequence.at(-1), "lease:release");
});

test("a hanging Cognito call is aborted within the configured bound and releases the lease", async () => {
  let receivedAbortSignal;
  const client = {
    async send(_command, options) {
      receivedAbortSignal = options?.abortSignal;
      return new Promise((resolve, reject) => {
        receivedAbortSignal.addEventListener(
          "abort",
          () => reject(receivedAbortSignal.reason),
          { once: true },
        );
      });
    },
  };
  const leaseHarness = createLeaseHarness();

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      lease: leaseHarness.lease,
      operationTimeoutMs: 5,
    })),
    /Selected Cognito user could not be verified\./,
  );

  assert.equal(receivedAbortSignal.aborted, true);
  assert.equal(leaseHarness.calls.at(-1), "release");
});

test("adds every missing selected user, removes stale members, and verifies the exact set", async () => {
  const { calls, client, state } = createCognitoHarness({
    members: [
      { username: STALE_USERNAME },
      { username: "second-stale-operator" },
    ],
    pageSize: 1,
  });

  const result = await reconcileDemoOperator(reconciliationInput(client));

  assert.deepEqual(result, {
    changed: true,
    finalMemberCount: 2,
    addedMemberCount: 2,
    removedMemberCount: 2,
  });
  assert.deepEqual(
    state.members,
    SELECTED_USERNAMES.map((username) => ({
      username,
      memberEnabled: true,
    })),
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
      "ListUsersInGroupCommand",
      "ListUsersInGroupCommand",
      "AdminAddUserToGroupCommand",
      "AdminAddUserToGroupCommand",
      "AdminRemoveUserFromGroupCommand",
      "AdminRemoveUserFromGroupCommand",
      "ListUsersInGroupCommand",
      "ListUsersInGroupCommand",
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
    ],
  );
  for (const { input } of calls) {
    assert.equal(input.UserPoolId, USER_POOL_ID);
    if (Object.hasOwn(input, "GroupName")) {
      assert.equal(input.GroupName, GROUP_NAME);
    }
  }
});

test("adds the selected user before removing stale members", async () => {
  const { calls, client, state } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
    onSend: ({ call }) => {
      if (call.name === "AdminAddUserToGroupCommand") {
        throw new Error(`assignment failed for ${SELECTED_USERNAME}`);
      }
      return undefined;
    },
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client)),
    (error) => {
      assert.equal(
        error.message,
        "Cognito group membership assignment failed.",
      );
      assert.equal(diagnosticText(error).includes(SELECTED_USERNAME), false);
      return true;
    },
  );
  assert.deepEqual(state.members, [{ username: STALE_USERNAME }]);
  assert.equal(
    calls.some(({ name }) => name === "AdminRemoveUserFromGroupCommand"),
    false,
  );
});

test("is idempotent when the selected enabled set is already exact", async () => {
  const { calls, client, state } = createCognitoHarness({
    members: [...SELECTED_USERNAMES].reverse().map((username) => ({
      username,
      memberEnabled: true,
    })),
  });

  const result = await reconcileDemoOperator(reconciliationInput(client));

  assert.deepEqual(result, {
    changed: false,
    finalMemberCount: 2,
    addedMemberCount: 0,
    removedMemberCount: 0,
  });
  assert.deepEqual(
    state.members,
    [...SELECTED_USERNAMES].reverse().map((username) => ({
      username,
      memberEnabled: true,
    })),
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
      "ListUsersInGroupCommand",
      "ListUsersInGroupCommand",
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
      "AdminGetUserCommand",
      "AdminListGroupsForUserCommand",
    ],
  );
});

test("DynamoDB lease conditionally acquires, renews, and owner-condition releases the exact fence", async () => {
  const calls = [];
  const client = {
    async send(command) {
      calls.push({
        name: command.constructor.name,
        input: structuredClone(command.input),
      });
      return {};
    },
  };
  let nowMilliseconds = 1_800_000;
  const lease = createDynamoLease({
    client,
    durationSeconds: 300,
    now: () => nowMilliseconds,
    owner: "00000000-0000-4000-8000-000000000001",
    tableName: PLATFORM_STATE_TABLE_NAME,
    userPoolId: USER_POOL_ID,
  });

  await lease.acquire();
  nowMilliseconds += 10_000;
  await lease.renew();
  await lease.release();

  assert.deepEqual(
    calls.map(({ name }) => name),
    ["PutItemCommand", "UpdateItemCommand", "DeleteItemCommand"],
  );
  assert.deepEqual(calls[0].input, {
    TableName: PLATFORM_STATE_TABLE_NAME,
    Item: {
      pk: { S: `DEMO_OPERATOR_LEASE#${USER_POOL_ID}` },
      sk: { S: "LOCK" },
      owner: { S: "00000000-0000-4000-8000-000000000001" },
      expiresAt: { N: "2100" },
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
      ":now": { N: "1800" },
    },
    ReturnConsumedCapacity: "NONE",
  });
  assert.equal(
    calls[1].input.ConditionExpression,
    "#owner = :owner AND #expiresAt >= :now",
  );
  assert.equal(calls[1].input.ExpressionAttributeValues[":now"].N, "1810");
  assert.equal(
    calls[1].input.ExpressionAttributeValues[":expiresAt"].N,
    "2110",
  );
  assert.equal(calls[2].input.ConditionExpression, "#owner = :owner");
});

test("a lease release failure does not mask failed compensating cleanup", async () => {
  let membershipReads = 0;
  const { client } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
    onSend: ({ call }) => {
      if (call.name !== "ListUsersInGroupCommand") return undefined;
      membershipReads += 1;
      return membershipReads === 1
        ? undefined
        : { Users: "malformed" };
    },
  });
  const leaseHarness = createLeaseHarness({
    releaseError: new Error("release failed"),
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      compensationQuiescenceMs: 5,
      lease: leaseHarness.lease,
    })),
    (error) => {
      assert.equal(
        error.message,
        "Demo operator compensating cleanup failed.",
      );
      assert.equal(
        error.cause?.message,
        "Demo operator reconciliation lease release failed.",
      );
      return true;
    },
  );
});

test("requires each exact selected user to be enabled and confirmed before mutation", async (t) => {
  for (const scenario of [
    {
      name: "disabled user",
      response: {
        Username: SELECTED_USERNAME,
        Enabled: false,
        UserStatus: "CONFIRMED",
      },
    },
    {
      name: "unconfirmed user",
      response: {
        Username: SELECTED_USERNAME,
        Enabled: true,
        UserStatus: "FORCE_CHANGE_PASSWORD",
      },
    },
    {
      name: "different username",
      response: {
        Username: "different-operator",
        Enabled: true,
        UserStatus: "CONFIRMED",
      },
    },
    {
      name: "malformed response",
      response: { Enabled: true },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { calls, client } = createCognitoHarness({
        members: [{ username: STALE_USERNAME }],
        onSend: ({ call }) =>
          call.name === "AdminGetUserCommand"
            ? scenario.response
            : undefined,
      });

      await assert.rejects(
        reconcileDemoOperator(reconciliationInput(client)),
        /Selected Cognito user could not be verified\./,
      );
      assert.deepEqual(
        calls.map(({ name }) => name),
        ["AdminGetUserCommand"],
      );
    });
  }
});

test("fails when mutations do not produce the exact enabled selected set", async (t) => {
  for (const scenario of [
    {
      name: "stale removal did not take effect",
      members: [
        { username: STALE_USERNAME },
        { username: SELECTED_USERNAME },
        { username: SECOND_SELECTED_USERNAME },
      ],
      commandName: "AdminRemoveUserFromGroupCommand",
    },
    {
      name: "selected addition did not take effect",
      members: [{ username: STALE_USERNAME }],
      commandName: "AdminAddUserToGroupCommand",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const { client } = createCognitoHarness({
        members: scenario.members,
        onSend: ({ call }) => {
          if (call.name !== scenario.commandName) return undefined;
          if (
            call.name === "AdminAddUserToGroupCommand"
            && call.input.Username !== SELECTED_USERNAME
          ) {
            return undefined;
          }
          return {};
        },
      });

      await assert.rejects(
        reconcileDemoOperator(reconciliationInput(client)),
        /Demo operator postcondition verification failed\./,
      );
    });
  }
});

test("bounds and validates group-member pagination before mutation", async (t) => {
  const cases = [
    {
      name: "repeated token",
      maxPages: 3,
      response: {
        Users: [],
        NextToken: "repeat",
      },
      message: /pagination was invalid/,
    },
    {
      name: "page overflow",
      maxPages: 1,
      response: {
        Users: [],
        NextToken: "next",
      },
      message: /pagination exceeded its bound/,
    },
    {
      name: "member overflow",
      maxMembers: 1,
      response: {
        Users: [
          { Username: "stale-a", Enabled: true },
          { Username: "stale-b", Enabled: true },
        ],
      },
      message: /membership exceeded its bound/,
    },
    {
      name: "duplicate member",
      response: {
        Users: [
          { Username: STALE_USERNAME, Enabled: true },
          { Username: STALE_USERNAME, Enabled: true },
        ],
      },
      message: /membership response was malformed/,
    },
    {
      name: "malformed users",
      response: { Users: "not-an-array" },
      message: /membership response was malformed/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { calls, client } = createCognitoHarness({
        onSend: ({ call }) => {
          if (call.name !== "ListUsersInGroupCommand") return undefined;
          return scenario.response;
        },
      });

      await assert.rejects(
        reconcileDemoOperator(reconciliationInput(client, {
          maxMembers: scenario.maxMembers ?? 100,
          maxPages: scenario.maxPages ?? 10,
        })),
        scenario.message,
      );
      assert.equal(
        calls.some(({ name }) =>
          name === "AdminRemoveUserFromGroupCommand"
          || name === "AdminAddUserToGroupCommand"),
        false,
      );
    });
  }
});

test("sanitizes SDK failures so diagnostics never contain usernames", async () => {
  const { client } = createCognitoHarness({
    onSend: ({ call }) => {
      if (call.name !== "ListUsersInGroupCommand") return undefined;
      const error = new Error(
        `lookup failed for ${SELECTED_USERNAME} and ${STALE_USERNAME}`,
      );
      error.request = { Username: SELECTED_USERNAME };
      throw error;
    },
  });

  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client)),
    (error) => {
      assert.equal(
        diagnosticText(error).includes(SELECTED_USERNAME),
        false,
      );
      assert.equal(
        diagnosticText(error).includes(SECOND_SELECTED_USERNAME),
        false,
      );
      assert.equal(
        diagnosticText(error).includes(STALE_USERNAME),
        false,
      );
      assert.equal(error.message, "Cognito group membership lookup failed.");
      return true;
    },
  );
});

test("private selection JSON is exact, bounded, and stdin-only", async () => {
  const document = JSON.stringify({
    usernames: SELECTED_USERNAMES,
  });
  assert.deepEqual(
    parsePrivateSelection(document),
    { usernames: SELECTED_USERNAMES },
  );
  for (const invalidDocument of [
    "",
    "not-json",
    "[]",
    JSON.stringify({}),
    JSON.stringify({ username: SELECTED_USERNAME }),
    JSON.stringify({ usernames: SELECTED_USERNAMES, extra: true }),
    JSON.stringify({ usernames: "not-an-array" }),
    JSON.stringify({ usernames: [] }),
    JSON.stringify({ usernames: [SELECTED_USERNAME, SELECTED_USERNAME] }),
    JSON.stringify({ usernames: [""] }),
    JSON.stringify({ usernames: ["contains space"] }),
    JSON.stringify({
      usernames: Array.from(
        { length: 101 },
        (_, index) => `selected-operator-${index}`,
      ),
    }),
  ]) {
    assert.throws(
      () => parsePrivateSelection(invalidDocument),
      /Private demo operator selection is invalid\./,
    );
  }

  assert.equal(
    await readPrivateStdin(Readable.from([document])),
    document,
  );
  const maximumUsernames = Array.from(
    { length: 100 },
    (_, index) =>
      `operator-${String(index).padStart(3, "0")}-${"x".repeat(115)}`,
  );
  const maximumDocument = JSON.stringify({
    usernames: maximumUsernames,
  });
  assert.equal(
    await readPrivateStdin(Readable.from([maximumDocument])),
    maximumDocument,
  );
  assert.deepEqual(
    parsePrivateSelection(maximumDocument),
    { usernames: maximumUsernames },
  );
  await assert.rejects(
    readPrivateStdin(Readable.from(["x".repeat(64 * 1024 + 1)])),
    /Private demo operator input exceeded its bound\./,
  );

  const { calls, client } = createCognitoHarness();
  const leaseHarness = createLeaseHarness();
  await assert.rejects(
    reconcileDemoOperator(reconciliationInput(client, {
      lease: leaseHarness.lease,
      usernames: Array(1),
    })),
    /Private demo operator selection is invalid\./,
  );
  assert.deepEqual(leaseHarness.calls, []);
  assert.deepEqual(calls, []);
});

test("CLI accepts usernames only from stdin and emits generic aggregate output", async () => {
  const { client, state } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
  });
  const clientConfigurations = [];
  const dynamoClientConfigurations = [];
  const dynamoCalls = [];
  const output = [];
  const env = {
    AWS_REGION: REGION,
    COGNITO_USER_POOL_ID: USER_POOL_ID,
    COGNITO_DEMO_OPERATOR_GROUP: GROUP_NAME,
    COGNITO_DEMO_OPERATOR_USERNAME: "ignored-legacy-value",
    PLATFORM_STATE_TABLE_NAME,
  };

  const result = await runCli({
    argv: [],
    clientFactory(configuration) {
      clientConfigurations.push(structuredClone(configuration));
      return client;
    },
    dynamoClientFactory(configuration) {
      dynamoClientConfigurations.push(structuredClone(configuration));
      return {
        async send(command) {
          dynamoCalls.push(command.constructor.name);
          return {};
        },
      };
    },
    env,
    stdin: Readable.from([
      JSON.stringify({ usernames: SELECTED_USERNAMES }),
    ]),
    stdout: {
      write(value) {
        output.push(String(value));
        return true;
      },
    },
  });

  assert.deepEqual(result, {
    changed: true,
    finalMemberCount: 2,
    addedMemberCount: 2,
    removedMemberCount: 1,
  });
  assert.deepEqual(
    state.members,
    SELECTED_USERNAMES.map((username) => ({
      username,
      memberEnabled: true,
    })),
  );
  assert.deepEqual(clientConfigurations, [{
    ignoreConfiguredEndpointUrls: true,
    region: REGION,
  }]);
  assert.deepEqual(dynamoClientConfigurations, [{
    ignoreConfiguredEndpointUrls: true,
    region: REGION,
  }]);
  assert.equal(dynamoCalls[0], "PutItemCommand");
  assert.equal(dynamoCalls.at(-1), "DeleteItemCommand");
  assert.equal(
    JSON.stringify(clientConfigurations).includes(SELECTED_USERNAME),
    false,
  );
  assert.equal(
    JSON.stringify(clientConfigurations).includes(SECOND_SELECTED_USERNAME),
    false,
  );
  assert.equal(output.join(""), "Demo operator membership reconciled.\n");
  assert.equal(output.join("").includes(SELECTED_USERNAME), false);

  await assert.rejects(
    runCli({
      argv: [SELECTED_USERNAME],
      clientFactory: () => client,
      env,
      stdin: Readable.from([
        JSON.stringify({ usernames: SELECTED_USERNAMES }),
      ]),
    }),
    (error) => {
      assert.equal(error.message, "Usage: reconcile-demo-operator.mjs");
      assert.equal(diagnosticText(error).includes(SELECTED_USERNAME), false);
      return true;
    },
  );
});

test("package and README expose the portable path and exact IAM contract", () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageDocument = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  const portableSection = readme
    .split("### Reconcile a demo operator portably")[1]
    ?.split("### Configure the hosted demo operator")[0];

  assert.equal(
    packageDocument.scripts["reconcile:demo-operator"],
    "node scripts/reconcile-demo-operator.mjs",
  );
  assert.equal(typeof portableSection, "string");
  assert.match(readme, /portable SDK-based path/i);
  assert.match(readme, /COGNITO_DEMO_OPERATOR_GROUP/);
  assert.match(readme, /private JSON file/i);
  assert.match(portableSection, /multiple exact\s+private operators/i);
  assert.match(readme, /mode `0600`/);
  assert.match(portableSection, /\(\n\s+set \+x/);
  assert.match(portableSection, /DEMO_OPERATOR_USERNAMES/);
  assert.doesNotMatch(portableSection, /\{"usernames":\["<[^"]+>"\]\}/);
  assert.match(portableSection, /mktemp/);
  assert.match(portableSection, /trap[\s\S]*PRIVATE_DEMO_OPERATOR_FILE/);
  assert.match(portableSection, /rm -f -- "\$PRIVATE_DEMO_OPERATOR_FILE"/);
  assert.doesNotMatch(portableSection, /RECONCILE_STATUS/);
  assert.match(readme, /auto-delete=no/);
  assert.match(readme, /creates no AWS resources/i);
  for (const action of [
    "cognito-idp:AdminGetUser",
    "cognito-idp:AdminListGroupsForUser",
    "cognito-idp:ListUsersInGroup",
    "cognito-idp:AdminRemoveUserFromGroup",
    "cognito-idp:AdminAddUserToGroup",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
  ]) {
    assert.match(portableSection, new RegExp(action));
  }
  assert.match(
    portableSection,
    /dynamodb:LeadingKeys[\s\S]+DEMO_OPERATOR_LEASE#\$\{PoolId\}/,
  );
});

test("portable command source and tests contain no person-specific identity", () => {
  const source = readFileSync(
    new URL("./reconcile-demo-operator.mjs", import.meta.url),
    "utf8",
  );
  const testSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const emailAddress = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  assert.doesNotMatch(source, emailAddress);
  assert.doesNotMatch(testSource, emailAddress);
  assert.doesNotMatch(source, /Create[A-Za-z]+Command/);
  assert.doesNotMatch(source, /TagResourceCommand/);
});
