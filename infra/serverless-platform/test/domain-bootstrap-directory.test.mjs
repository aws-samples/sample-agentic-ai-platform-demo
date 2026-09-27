import test from "node:test";
import assert from "node:assert/strict";
import { administratorCandidate, createAdministratorDirectory } from "../lambda/domain-bootstrap/administrator-directory.mjs";

const user = (name, enabled = true) => ({ Username: name, Enabled: enabled,
  Attributes: [{ Name: "sub", Value: `${name}-sub` }, { Name: "name", Value: name }] });

test("Platform Admins and Domain Admins are eligible without changing their roles", () => {
  assert.equal(administratorCandidate(user("platform"), ["platform-admin", "demo-operator"]).eligible, true);
  assert.equal(administratorCandidate(user("lead"), ["domain-lead", "domain-finance"]).eligible, true);
  assert.equal(administratorCandidate(user("disabled", false), ["platform-admin"]).eligible, false);
  assert.equal(administratorCandidate(user("builder"), ["domain-builder"]).eligible, false);
  assert.equal(administratorCandidate(user("conflict"), ["platform-admin", "domain-lead"]).eligible, false);
});
test("the directory lists actual users across pages even when no domain-lead group members exist", async () => {
  const calls = [];
  const directory = createAdministratorDirectory({ userPoolId: "pool",
    cognito: { async send(command) {
      calls.push(command);
      return command.input.PaginationToken
        ? { Users: [user("consumer")] }
        : { Users: [user("melanie")], PaginationToken: "next" };
    } }, groups: async name => name === "melanie" ? ["platform-admin"] : ["end-user"] });
  const users = await directory();
  assert.deepEqual(users.map(user => [user.username, user.eligible]), [["melanie", true], ["consumer", false]]);
  assert.deepEqual(calls.map(command => command.constructor.name), ["ListUsersCommand", "ListUsersCommand"]);
});
test("repeated directory continuation is an error rather than a misleading partial list", async () => {
  const directory = createAdministratorDirectory({ userPoolId: "pool",
    cognito: { async send() { return { Users: [], PaginationToken: "repeated" }; } }, groups: async () => [] });
  await assert.rejects(directory(), { code: "DIRECTORY_UNAVAILABLE" });
});
