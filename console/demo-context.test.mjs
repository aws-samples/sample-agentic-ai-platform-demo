import assert from "node:assert/strict";
import test from "node:test";

import {
  availableDemoRoleOptions,
  clearDemoContext,
  demoContextHeaders,
  getDemoContext,
  setDemoContext,
} from "./public/demo-context.mjs";

const STORAGE_KEY = "console.demo-context";

class MemoryStorage {
  constructor(entries = {}, failures = {}) {
    this.values = new Map(Object.entries(entries));
    this.failures = failures;
    this.removedKeys = [];
  }

  getItem(key) {
    if (this.failures.get) throw new Error("storage get failed");
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.failures.set) throw new Error("storage set failed");
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.removedKeys.push(key);
    if (this.failures.remove) throw new Error("storage remove failed");
    this.values.delete(key);
  }
}

function installStorage(entries, failures) {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const storage = new MemoryStorage(entries, failures);
  globalThis.sessionStorage = storage;
  return {
    storage,
    restore() {
      if (previous) {
        Object.defineProperty(globalThis, "sessionStorage", previous);
      } else {
        delete globalThis.sessionStorage;
      }
    },
  };
}

test("stores Builder context per tab and emits both demo headers", (t) => {
  const browser = installStorage();
  t.after(browser.restore);

  setDemoContext({ role: "builder", domain: "operations" });

  assert.deepEqual(getDemoContext(), {
    role: "builder",
    domain: "operations",
  });
  assert.deepEqual(demoContextHeaders(), {
    "x-demo-role": "builder",
    "x-active-domain": "operations",
  });
  assert.deepEqual(
    JSON.parse(browser.storage.getItem(STORAGE_KEY)),
    { role: "builder", domain: "operations" },
  );
});

test("accepts only the four canonical role identifiers", (t) => {
  const browser = installStorage();
  t.after(browser.restore);

  for (const role of ["admin", "lead", "builder", "user"]) {
    const domain = ["lead", "builder"].includes(role)
      ? "customer_support"
      : null;
    assert.doesNotThrow(() => setDemoContext({ role, domain }));
  }

  for (const role of [
    "",
    "Admin",
    "owner",
    "platform-admin",
    42,
    null,
  ]) {
    assert.throws(
      () => setDemoContext({ role, domain: null }),
      /Demo role context is invalid\./,
    );
  }
});

test("demo role options come from the authoritative profile allowlist", () => {
  assert.deepEqual(
    availableDemoRoleOptions({
      availableDemoRoles: [
        "builder",
        "admin",
        "user",
        "lead",
        "builder",
        "owner",
      ],
    }),
    [
      { id: "admin", label: "Platform Admin" },
      { id: "lead", label: "Domain Lead" },
      { id: "builder", label: "Domain Builder" },
      { id: "user", label: "End User" },
    ],
  );
  assert.deepEqual(availableDemoRoleOptions(null), []);
  assert.deepEqual(
    availableDemoRoleOptions({ availableDemoRoles: "admin" }),
    [],
  );
});

test("Lead and Builder require a normalized real domain identifier", (t) => {
  const browser = installStorage();
  t.after(browser.restore);

  for (const role of ["lead", "builder"]) {
    for (const domain of [
      null,
      "",
      " operations ",
      "Operations",
      "customer-support",
      "shared",
      "platform",
      "a".repeat(65),
      { id: "operations" },
    ]) {
      assert.throws(
        () => setDemoContext({ role, domain }),
        /Demo role context is invalid\./,
      );
    }
  }
});

test("Admin and End User default to an unscoped context", (t) => {
  const browser = installStorage();
  t.after(browser.restore);

  setDemoContext({ role: "admin", domain: "operations" });
  assert.deepEqual(getDemoContext(), { role: "admin", domain: null });
  assert.deepEqual(demoContextHeaders(), {
    "x-demo-role": "admin",
  });

  setDemoContext(
    { role: "admin", domain: "operations" },
    { allowAdminDomain: true },
  );
  assert.deepEqual(getDemoContext(), {
    role: "admin",
    domain: "operations",
  });

  setDemoContext({ role: "user", domain: "operations" });
  assert.deepEqual(getDemoContext(), { role: "user", domain: null });
  assert.deepEqual(demoContextHeaders(), {
    "x-demo-role": "user",
  });
});

test("rejects extra identity, capability, token, and display fields", (t) => {
  const browser = installStorage();
  t.after(browser.restore);

  for (const key of [
    "actor",
    "assumedRole",
    "authenticatedRole",
    "capabilities",
    "email",
    "groups",
    "idToken",
    "name",
    "subject",
    "token",
    "user",
    "username",
  ]) {
    assert.throws(
      () => setDemoContext({
        role: "builder",
        domain: "operations",
        [key]: "must-not-persist",
      }),
      /Demo role context is invalid\./,
      key,
    );
  }
  assert.equal(browser.storage.getItem(STORAGE_KEY), null);
});

test("malformed or untrusted stored context is removed fail-closed", (t) => {
  const invalidValues = [
    "{not-json",
    JSON.stringify([]),
    JSON.stringify({ role: "owner", domain: null }),
    JSON.stringify({ role: "builder", domain: "Operations" }),
    JSON.stringify({
      role: "builder",
      domain: "operations",
      token: "must-not-survive",
    }),
  ];

  for (const value of invalidValues) {
    const browser = installStorage({ [STORAGE_KEY]: value });
    try {
      assert.equal(getDemoContext(), null);
      assert.equal(browser.storage.getItem(STORAGE_KEY), null);
      assert.deepEqual(browser.storage.removedKeys, [STORAGE_KEY]);
    } finally {
      browser.restore();
    }
  }
  t.after(() => {});
});

test("clear removes only the per-tab demo context", (t) => {
  const browser = installStorage({
    [STORAGE_KEY]: JSON.stringify({
      role: "builder",
      domain: "operations",
    }),
    unrelated: "preserved",
  });
  t.after(browser.restore);

  clearDemoContext();

  assert.equal(browser.storage.getItem(STORAGE_KEY), null);
  assert.equal(browser.storage.getItem("unrelated"), "preserved");
});

test("storage failures use one stable error without leaking browser details", (t) => {
  const browser = installStorage({}, { get: true });
  t.after(browser.restore);

  assert.throws(
    () => getDemoContext(),
    new Error("Browser session storage is unavailable."),
  );
});
