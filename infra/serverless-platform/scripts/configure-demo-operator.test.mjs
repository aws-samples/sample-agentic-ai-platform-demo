import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  configureDemoOperator,
  runCli,
} from "./configure-demo-operator.mjs";
import {
  reconcileDemoOperator,
} from "./reconcile-demo-operator.mjs";

const REGION = "us-west-2";
const USER_POOL_ID = `${REGION}_LegacyAlias`;
const GROUP_NAME = "demo-operator";
const PLATFORM_ADMIN_GROUP = "platform-admin";
const PLATFORM_STATE_TABLE_NAME = "AgenticPlatform-State";
const SELECTED_USERNAMES = Object.freeze([
  "selected-operator-a",
  "selected-operator-b",
]);
const [SELECTED_USERNAME, SECOND_SELECTED_USERNAME] = SELECTED_USERNAMES;
const STALE_USERNAME = "stale-operator";

function createCognitoHarness({
  members = [],
  onSend,
  selectedGroups = [PLATFORM_ADMIN_GROUP],
} = {}) {
  const state = {
    members: members.map((member) => ({ ...member })),
  };
  const client = {
    async send(command) {
      const call = {
        name: command.constructor.name,
        input: structuredClone(command.input),
      };
      const override = await onSend?.({ call, state });
      if (override !== undefined) return override;

      if (call.name === "AdminGetUserCommand") {
        return {
          Username: call.input.Username,
          Enabled: true,
          UserStatus: "CONFIRMED",
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
        return {
          Users: state.members.map(
            ({ username, memberEnabled = true }) => ({
              Username: username,
              Enabled: memberEnabled,
              UserStatus: "CONFIRMED",
            }),
          ),
        };
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
      if (call.name === "AdminRemoveUserFromGroupCommand") {
        state.members = state.members.filter(
          ({ username }) => username !== call.input.Username,
        );
        return {};
      }
      assert.fail(`Unexpected Cognito command ${call.name}`);
    },
  };
  return { client, state };
}

function createLease() {
  return {
    async acquire() {},
    async renew() {},
    async release() {},
  };
}

function configureInput(client) {
  return {
    client,
    compensationQuiescenceMs: 1,
    groupName: GROUP_NAME,
    lease: createLease(),
    maxMembers: 100,
    maxPages: 10,
    operationTimeoutMs: 100,
    userPoolId: USER_POOL_ID,
    usernames: SELECTED_USERNAMES,
  };
}

test("legacy configure entry point delegates to the canonical reconciler", () => {
  assert.equal(configureDemoOperator, reconcileDemoOperator);
});

test("legacy configure restores the exact snapshot when selected-member addition fails ambiguously", async () => {
  const originalMembers = [
    { username: STALE_USERNAME, memberEnabled: true },
    { username: "second-stale-operator", memberEnabled: true },
  ];
  let failSelectedAddition = true;
  const { client, state } = createCognitoHarness({
    members: originalMembers,
    onSend: ({ call, state: mutableState }) => {
      if (
        call.name !== "AdminAddUserToGroupCommand"
        || call.input.Username !== SELECTED_USERNAME
        || !failSelectedAddition
      ) {
        return undefined;
      }
      failSelectedAddition = false;
      mutableState.members.push({
        username: SELECTED_USERNAME,
        memberEnabled: true,
      });
      throw new Error("lost response after selected-member assignment");
    },
  });

  await assert.rejects(
    configureDemoOperator(configureInput(client)),
    /Cognito group membership assignment failed\./,
  );

  assert.deepEqual(state.members, originalMembers);
});

test("legacy configure restores the exact snapshot when final verification fails", async () => {
  const originalMembers = [
    { username: STALE_USERNAME, memberEnabled: true },
    { username: "second-stale-operator", memberEnabled: true },
  ];
  let membershipReads = 0;
  const { client, state } = createCognitoHarness({
    members: originalMembers,
    onSend: ({ call }) => {
      if (call.name !== "ListUsersInGroupCommand") return undefined;
      membershipReads += 1;
      return membershipReads === 2
        ? { Users: "malformed-final-verification" }
        : undefined;
    },
  });

  await assert.rejects(
    configureDemoOperator(configureInput(client)),
    /Cognito group membership response was malformed\./,
  );

  assert.deepEqual(state.members, originalMembers);
});

test("legacy CLI reconciles the exact selected set from private JSON stdin", async () => {
  const { client, state } = createCognitoHarness({
    members: [{ username: STALE_USERNAME }],
  });
  const output = [];
  const result = await runCli({
    argv: [],
    clientFactory() {
      return client;
    },
    dynamoClientFactory() {
      return {
        async send() {
          return {};
        },
      };
    },
    env: {
      AWS_REGION: REGION,
      COGNITO_USER_POOL_ID: USER_POOL_ID,
      COGNITO_DEMO_OPERATOR_GROUP: GROUP_NAME,
      COGNITO_DEMO_OPERATOR_USERNAME: "ignored-legacy-value",
      PLATFORM_STATE_TABLE_NAME,
    },
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
  assert.deepEqual(output, [
    "Demo operator membership reconciled.\n",
  ]);
  assert.equal(output.join("").includes(SELECTED_USERNAME), false);
  assert.equal(output.join("").includes(SECOND_SELECTED_USERNAME), false);

  await assert.rejects(
    runCli({
      argv: [SELECTED_USERNAME],
      env: {},
    }),
    (error) => {
      assert.equal(error.message.includes(SELECTED_USERNAME), false);
      assert.match(error.message, /^Usage: /);
      return true;
    },
  );
});

test("package and README expose configure as an alias of the portable command", () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageDocument = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");

  assert.equal(
    packageDocument.scripts["configure:demo-operator"],
    "node scripts/reconcile-demo-operator.mjs",
  );
  assert.match(
    readme,
    /`configure:demo-operator` is a compatibility alias/,
  );
  assert.doesNotMatch(
    readme,
    /COGNITO_DEMO_OPERATOR_USERNAME="<existing-platform-admin-username>"/,
  );
});

test("legacy wrapper, tests, and operator documentation contain no personal identity", () => {
  const sourcePath = fileURLToPath(
    new URL("./configure-demo-operator.mjs", import.meta.url),
  );
  const testPath = fileURLToPath(import.meta.url);
  const readmePath = join(dirname(dirname(testPath)), "README.md");
  const emailAddress = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  for (const path of [sourcePath, testPath, readmePath]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), emailAddress);
  }
});
