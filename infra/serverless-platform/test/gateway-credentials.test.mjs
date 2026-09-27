import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  GatewayCredentialsError,
  createGatewayCredentialsProvider,
} from "../lambda/workspace/gateway-credentials.mjs";

const ROLE_ARN =
  "arn:aws:iam::111122223333:role/agentic-platform-gateway-invoker";
const NOW = new Date("2026-08-25T01:02:03.000Z");
const CUSTOMER_SOURCE_IDENTITY = "domain_customer_support";
const OPERATIONS_SOURCE_IDENTITY = "domain_operations";
const FINANCE_SOURCE_IDENTITY = "domain_finance";

function assumedCredentials(
  accessKeyId = "ASIAEXAMPLE1",
  expiration = "2026-08-25T01:17:03.000Z",
) {
  return {
    Credentials: {
      AccessKeyId: accessKeyId,
      SecretAccessKey: "assumed-secret",
      SessionToken: "assumed-session",
      Expiration: new Date(expiration),
    },
  };
}

function sessionName(sourceIdentity) {
  const digest = createHash("sha256")
    .update(sourceIdentity)
    .digest("hex")
    .slice(0, 32);
  return `agentic-gateway-${digest}`;
}

test("assumes the configured role with the exact canonical source identity", async () => {
  const calls = [];
  const abortController = new AbortController();
  const provider = createGatewayCredentialsProvider({
    stsClient: {
      async send(command, options) {
        calls.push({ command, options });
        return assumedCredentials();
      },
    },
    roleArn: ROLE_ARN,
    clock: () => NOW,
  });

  const result = await provider({
    sourceIdentity: CUSTOMER_SOURCE_IDENTITY,
    abortSignal: abortController.signal,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.constructor.name, "AssumeRoleCommand");
  assert.deepEqual(calls[0].command.input, {
    RoleArn: ROLE_ARN,
    RoleSessionName: sessionName(CUSTOMER_SOURCE_IDENTITY),
    DurationSeconds: 900,
    SourceIdentity: CUSTOMER_SOURCE_IDENTITY,
  });
  assert.deepEqual(calls[0].options, {
    abortSignal: abortController.signal,
  });
  assert.deepEqual(result, {
    accessKeyId: "ASIAEXAMPLE1",
    secretAccessKey: "assumed-secret",
    sessionToken: "assumed-session",
    expiration: new Date("2026-08-25T01:17:03.000Z"),
  });
  assert.equal(Object.isFrozen(result), true);
});

test("rejects invalid configuration and non-canonical provider input before STS", async () => {
  let sendCalls = 0;
  const stsClient = {
    async send() {
      sendCalls += 1;
      return assumedCredentials();
    },
  };
  const invalidRoleArns = [
    "",
    "arn:aws:iam::111122223333:user/not-a-role",
    "arn:aws:iam::111122223333:role/",
    "arn:aws:iam::111122223333:role/path//role",
    "arn:aws:iam::*:role/gateway",
    "arn:aws-invalid:iam::111122223333:role/gateway",
    `${ROLE_ARN} `,
  ];
  for (const roleArn of invalidRoleArns) {
    assert.throws(
      () => createGatewayCredentialsProvider({
        stsClient,
        roleArn,
      }),
      /Gateway credential configuration is invalid/,
    );
  }
  for (const partition of [
    "aws",
    "aws-us-gov",
    "aws-cn",
    "aws-iso",
    "aws-iso-b",
    "aws-iso-e",
    "aws-iso-f",
  ]) {
    assert.doesNotThrow(
      () => createGatewayCredentialsProvider({
        stsClient,
        roleArn:
          `arn:${partition}:iam::111122223333:role/path/gateway`,
      }),
    );
  }
  for (const durationSeconds of [899, 3_601, 900.5, "900"]) {
    assert.throws(
      () => createGatewayCredentialsProvider({
        stsClient,
        roleArn: ROLE_ARN,
        durationSeconds,
      }),
      /Gateway credential configuration is invalid/,
    );
  }

  const provider = createGatewayCredentialsProvider({
    stsClient,
    roleArn: ROLE_ARN,
    clock: () => NOW,
  });
  const hiddenRole = { sourceIdentity: CUSTOMER_SOURCE_IDENTITY };
  Object.defineProperty(hiddenRole, "roleArn", { value: ROLE_ARN });
  const accessorIdentity = {
    get sourceIdentity() {
      throw new Error("TOP-SECRET accessor executed");
    },
  };
  const invalidInputs = [
    undefined,
    {},
    { sourceIdentity: "a" },
    { sourceIdentity: "Customer_Support" },
    { sourceIdentity: "customer-support" },
    { sourceIdentity: "aws:customer_support" },
    { sourceIdentity: "customer_support" },
    { sourceIdentity: `a${"b".repeat(64)}` },
    { sourceIdentity: CUSTOMER_SOURCE_IDENTITY, roleArn: ROLE_ARN },
    { sourceIdentity: CUSTOMER_SOURCE_IDENTITY, abortSignal: "signal" },
    hiddenRole,
    accessorIdentity,
    {
      sourceIdentity: CUSTOMER_SOURCE_IDENTITY,
      [Symbol("credentials")]: "attacker",
    },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      provider(input),
      (error) => (
        error instanceof GatewayCredentialsError
        && error.code === "INVALID_GATEWAY_CREDENTIAL_REQUEST"
        && !String(error).includes("TOP-SECRET")
      ),
    );
  }
  assert.equal(sendCalls, 0);
});

test("caches per domain, refreshes near expiry, and evicts deterministically", async () => {
  let now = NOW;
  let sendCalls = 0;
  const provider = createGatewayCredentialsProvider({
    stsClient: {
      async send() {
        sendCalls += 1;
        return assumedCredentials(
          `ASIAEXAMPLE${sendCalls}`,
          new Date(now.getTime() + (15 * 60 * 1000)).toISOString(),
        );
      },
    },
    roleArn: ROLE_ARN,
    clock: () => now,
    maxCacheEntries: 2,
  });

  assert.equal(
    (await provider({
      sourceIdentity: CUSTOMER_SOURCE_IDENTITY,
    })).accessKeyId,
    "ASIAEXAMPLE1",
  );
  assert.equal(
    (await provider({
      sourceIdentity: CUSTOMER_SOURCE_IDENTITY,
    })).accessKeyId,
    "ASIAEXAMPLE1",
  );
  assert.equal(
    (await provider({
      sourceIdentity: OPERATIONS_SOURCE_IDENTITY,
    })).accessKeyId,
    "ASIAEXAMPLE2",
  );
  assert.equal(
    (await provider({
      sourceIdentity: FINANCE_SOURCE_IDENTITY,
    })).accessKeyId,
    "ASIAEXAMPLE3",
  );
  assert.equal(
    (await provider({
      sourceIdentity: CUSTOMER_SOURCE_IDENTITY,
    })).accessKeyId,
    "ASIAEXAMPLE4",
  );

  now = new Date("2026-08-25T01:12:03.001Z");
  assert.equal(
    (await provider({
      sourceIdentity: FINANCE_SOURCE_IDENTITY,
    })).accessKeyId,
    "ASIAEXAMPLE5",
  );
  assert.equal(sendCalls, 5);
});

test("rejects malformed or near-expiry STS credentials without caching them", async () => {
  const malformed = [
    {},
    { Credentials: null },
    {
      Credentials: {
        AccessKeyId: "",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date("2026-08-25T01:17:03.000Z"),
      },
    },
    {
      Credentials: {
        AccessKeyId: "ASIAEXAMPLE",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date("2026-08-25T01:07:03.000Z"),
      },
    },
    {
      Credentials: {
        AccessKeyId: "ASIAEXAMPLE",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: "2026-08-25T01:17:03.000Z",
      },
    },
  ];
  const accessorCredentials = {};
  Object.defineProperty(accessorCredentials, "AccessKeyId", {
    enumerable: true,
    get() {
      throw new Error("TOP-SECRET accessor executed");
    },
  });
  Object.assign(accessorCredentials, {
    SecretAccessKey: "secret",
    SessionToken: "token",
    Expiration: new Date("2026-08-25T01:17:03.000Z"),
  });
  malformed.push({ Credentials: accessorCredentials });

  for (const response of malformed) {
    let calls = 0;
    const provider = createGatewayCredentialsProvider({
      stsClient: {
        async send() {
          calls += 1;
          return response;
        },
      },
      roleArn: ROLE_ARN,
      clock: () => NOW,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        provider({ sourceIdentity: CUSTOMER_SOURCE_IDENTITY }),
        (error) => (
          error instanceof GatewayCredentialsError
          && error.code === "GATEWAY_CREDENTIALS_UNAVAILABLE"
          && !String(error).includes("TOP-SECRET")
        ),
      );
    }
    assert.equal(calls, 2);
  }
});

test("rechecks expiry after a slow STS response", async () => {
  const times = [
    new Date("2026-08-25T01:02:03.000Z"),
    new Date("2026-08-25T01:13:03.001Z"),
  ];
  const provider = createGatewayCredentialsProvider({
    stsClient: {
      async send() {
        return assumedCredentials(
          "ASIAEXAMPLE",
          "2026-08-25T01:17:03.000Z",
        );
      },
    },
    roleArn: ROLE_ARN,
    clock: () => times.shift(),
  });

  await assert.rejects(
    provider({ sourceIdentity: CUSTOMER_SOURCE_IDENTITY }),
    (error) => (
      error instanceof GatewayCredentialsError
      && error.code === "GATEWAY_CREDENTIALS_UNAVAILABLE"
    ),
  );
});

test("sanitizes STS failures and retries instead of caching failures", async () => {
  let calls = 0;
  const provider = createGatewayCredentialsProvider({
    stsClient: {
      async send() {
        calls += 1;
        throw new Error(
          "TOP-SECRET assumed-secret assumed-session",
        );
      },
    },
    roleArn: ROLE_ARN,
    clock: () => NOW,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let caught;
    try {
      await provider({ sourceIdentity: CUSTOMER_SOURCE_IDENTITY });
      assert.fail("Expected STS failure.");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof GatewayCredentialsError);
    assert.equal(caught.code, "GATEWAY_CREDENTIALS_UNAVAILABLE");
    assert.equal(Object.hasOwn(caught, "cause"), false);
    assert.equal(String(caught).includes("TOP-SECRET"), false);
    assert.equal(String(caught.stack).includes("assumed-secret"), false);
    assert.equal(String(caught.stack).includes("assumed-session"), false);
  }
  assert.equal(calls, 2);
});
