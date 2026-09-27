import assert from "node:assert/strict";
import test from "node:test";
import {
  createIamCredentialsProvider,
} from "../lambda/agent-runtime/credentials.mjs";

test("uses execution-role credentials supplied by the runtime environment", async () => {
  let fetchCalls = 0;
  const provider = createIamCredentialsProvider({
    env: {
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "environment-secret",
      AWS_SESSION_TOKEN: "environment-session",
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    },
  });

  assert.deepEqual(await provider(), {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "environment-secret",
    sessionToken: "environment-session",
  });
  assert.equal(fetchCalls, 0);
});

test("loads execution-role credentials from the fixed AWS container endpoint", async () => {
  let request;
  const provider = createIamCredentialsProvider({
    env: {
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:
        "/v2/credentials/runtime-task",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "runtime-token",
    },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        AccessKeyId: "ASIAEXAMPLE",
        SecretAccessKey: "container-secret",
        Token: "container-session",
        Expiration: "2026-08-25T12:00:00.000Z",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    clock: () => new Date("2026-08-25T10:00:00.000Z"),
  });

  assert.deepEqual(await provider(), {
    accessKeyId: "ASIAEXAMPLE",
    secretAccessKey: "container-secret",
    sessionToken: "container-session",
    expiration: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(
    request.url,
    "http://169.254.170.2/v2/credentials/runtime-task",
  );
  assert.deepEqual(request.init.headers, {
    authorization: "runtime-token",
    accept: "application/json",
  });
});

test("caches container credentials until shortly before expiration", async () => {
  let fetchCalls = 0;
  let now = new Date("2026-08-25T10:00:00.000Z");
  const provider = createIamCredentialsProvider({
    env: {
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:
        "/v2/credentials/runtime-task",
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        AccessKeyId: `ASIAEXAMPLE${fetchCalls}`,
        SecretAccessKey: "container-secret",
        Token: "container-session",
        Expiration: "2026-08-25T10:10:00.000Z",
      }), { status: 200 });
    },
    clock: () => now,
  });

  assert.equal((await provider()).accessKeyId, "ASIAEXAMPLE1");
  assert.equal((await provider()).accessKeyId, "ASIAEXAMPLE1");
  now = new Date("2026-08-25T10:06:00.001Z");
  assert.equal((await provider()).accessKeyId, "ASIAEXAMPLE2");
  assert.equal(fetchCalls, 2);
});

test("loads AgentCore execution-role credentials from MMDS", async () => {
  let factoryOptions;
  let providerOptions;
  const provider = createIamCredentialsProvider({
    env: {},
    instanceMetadataProviderFactory(options) {
      factoryOptions = options;
      return async (requestOptions) => {
        providerOptions = requestOptions;
        return {
          accessKeyId: "ASIAEXAMPLE",
          secretAccessKey: "metadata-secret",
          sessionToken: "metadata-session",
          expiration: new Date("2026-08-25T12:00:00.000Z"),
        };
      };
    },
  });
  const abortController = new AbortController();

  assert.deepEqual(
    await provider({ abortSignal: abortController.signal }),
    {
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "metadata-secret",
      sessionToken: "metadata-session",
      expiration: new Date("2026-08-25T12:00:00.000Z"),
    },
  );
  assert.deepEqual(factoryOptions, {
    ec2MetadataV1Disabled: true,
    maxRetries: 1,
    timeout: 1_000,
  });
  assert.deepEqual(providerOptions, {
    abortSignal: abortController.signal,
  });
});

test("rejects partial credentials and arbitrary credential URLs", () => {
  const invalidEnvironments = [
    { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE" },
    {
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/credentials",
    },
    {
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:
        "http://attacker.example/credentials",
    },
    {
      AWS_CONTAINER_CREDENTIALS_FULL_URI:
        "https://attacker.example/credentials",
    },
  ];

  for (const env of invalidEnvironments) {
    assert.throws(
      () => createIamCredentialsProvider({ env }),
      /IAM credential configuration is invalid/,
    );
  }
});

test("rejects malformed and oversized credential responses", async () => {
  const responses = [
    new Response("not-json", { status: 200 }),
    new Response(JSON.stringify({
      AccessKeyId: "ASIAEXAMPLE",
      SecretAccessKey: "container-secret",
    }), { status: 500 }),
    new Response("x".repeat(16 * 1024 + 1), { status: 200 }),
    new Response(JSON.stringify({
      AccessKeyId: "ASIAEXAMPLE",
      SecretAccessKey: "container-secret",
      Token: "container-session",
      Expiration: "not-a-date",
    }), { status: 200 }),
  ];

  for (const response of responses) {
    const provider = createIamCredentialsProvider({
      env: {
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:
          "/v2/credentials/runtime-task",
      },
      fetchImpl: async () => response,
    });
    await assert.rejects(
      provider(),
      /IAM credentials are unavailable/,
    );
  }
});
