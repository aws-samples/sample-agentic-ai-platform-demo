import assert from "node:assert/strict";
import test from "node:test";
import {
  createActiveDomainDirectory,
  createActiveDomainRecordDirectory,
} from "../lambda/api/domain-directory.mjs";

test("active domain directory omits absent read options", async () => {
  const calls = [];
  const directory = createActiveDomainDirectory({
    async listDomains(...args) {
      calls.push(args);
      return [
        { id: "customer_support", status: "ACTIVE" },
        { id: "operations", status: "SUSPENDED" },
      ];
    },
  });

  assert.deepEqual(await directory.listActiveDomains(), [
    { id: "customer_support" },
  ]);
  assert.deepEqual(calls, [[]]);
});

test("active domain directory forwards an exact abort signal option", async () => {
  const calls = [];
  const controller = new AbortController();
  const directory = createActiveDomainDirectory({
    async listDomains(...args) {
      calls.push(args);
      return [];
    },
  });

  assert.deepEqual(
    await directory.listActiveDomains({
      abortSignal: controller.signal,
    }),
    [],
  );
  assert.deepEqual(calls, [[{ abortSignal: controller.signal }]]);
});

test("active domain directory rejects malformed dependencies and options", async () => {
  assert.throws(
    () => createActiveDomainDirectory(),
    /configuration is invalid/i,
  );
  assert.throws(
    () => createActiveDomainDirectory({ listDomains: "invalid" }),
    /configuration is invalid/i,
  );

  const directory = createActiveDomainDirectory({
    async listDomains() {
      return [];
    },
  });
  await assert.rejects(
    directory.listActiveDomains({ abortSignal: undefined }),
    /options are invalid/i,
  );
});

test("active domain directory rejects accessors without executing them", async () => {
  let getterCalls = 0;
  const options = {};
  Object.defineProperty(options, "abortSignal", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return new AbortController().signal;
    },
  });
  const directory = createActiveDomainDirectory({
    async listDomains() {
      return [];
    },
  });

  await assert.rejects(
    directory.listActiveDomains(options),
    /options are invalid/i,
  );
  assert.equal(getterCalls, 0);
});

test("active domain directory rejects hidden option properties", async () => {
  let stateCalls = 0;
  const options = {};
  Object.defineProperty(options, "abortSignal", {
    enumerable: false,
    value: new AbortController().signal,
  });
  const directory = createActiveDomainDirectory({
    async listDomains() {
      stateCalls += 1;
      return [];
    },
  });

  await assert.rejects(
    directory.listActiveDomains(options),
    /options are invalid/i,
  );
  assert.equal(stateCalls, 0);
});

test("active domain record directory preserves records and strict options", async () => {
  const calls = [];
  const active = { id: "customer_support", status: "ACTIVE" };
  const controller = new AbortController();
  const directory = createActiveDomainRecordDirectory({
    async getDomain(...args) {
      calls.push(["get", args]);
      return active;
    },
    async listDomains(...args) {
      calls.push(["list", args]);
      return [active, { id: "operations", status: "SUSPENDED" }];
    },
  });

  assert.deepEqual(await directory.listActiveDomains(), [active]);
  assert.equal(await directory.getDomain("customer_support"), active);
  assert.deepEqual(
    await directory.listActiveDomains({
      abortSignal: controller.signal,
    }),
    [active],
  );
  assert.equal(
    await directory.getDomain("customer_support", {
      abortSignal: controller.signal,
    }),
    active,
  );
  await assert.rejects(
    directory.listActiveDomains({ abortSignal: undefined }),
    /options are invalid/i,
  );
  await assert.rejects(
    directory.getDomain("customer_support", {
      abortSignal: undefined,
    }),
    /options are invalid/i,
  );
  assert.deepEqual(calls, [
    ["list", []],
    ["get", ["customer_support"]],
    ["list", [{ abortSignal: controller.signal }]],
    ["get", ["customer_support", { abortSignal: controller.signal }]],
  ]);
});
