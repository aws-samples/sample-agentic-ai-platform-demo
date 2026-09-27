import assert from "node:assert/strict";
import test from "node:test";
import {
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  createRuntimeProofSecretProvider,
} from "../lambda/agent-runtime/proof-secret.mjs";

const SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:111122223333:"
  + "secret:agentic-platform/runtime-proof-AbCdEf";
const SECRET =
  "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ENDPOINT_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567/"
  + "runtime-endpoint/Production";

function secretString(overrides = {}) {
  return JSON.stringify({
    hmacKey: SECRET,
    previousHmacKey: null,
    allowedEndpointArn: ENDPOINT_ARN,
    keyId: "runtime-proof-v1",
    ...overrides,
  });
}

test("loads and briefly caches the exact deployment proof configuration", async () => {
  const calls = [];
  let now = 1_777_777_777_000;
  const provider = createRuntimeProofSecretProvider({
    client: {
      async send(command) {
        calls.push(command);
        return {
          ARN: SECRET_ARN,
          SecretString: secretString(),
          VersionStages: ["AWSCURRENT"],
        };
      },
    },
    secretArn: SECRET_ARN,
    clock: () => now,
    cacheTtlMs: 30_000,
  });

  assert.deepEqual(await provider(), {
    hmacKey: SECRET,
    previousHmacKey: null,
    allowedEndpointArn: ENDPOINT_ARN,
    keyId: "runtime-proof-v1",
  });
  assert.deepEqual(await provider(), {
    hmacKey: SECRET,
    previousHmacKey: null,
    allowedEndpointArn: ENDPOINT_ARN,
    keyId: "runtime-proof-v1",
  });
  assert.equal(calls.length, 1);
  now += 30_001;
  await provider();
  assert.equal(calls.length, 2);
  assert.ok(calls[0] instanceof GetSecretValueCommand);
  assert.deepEqual(calls[0].input, {
    SecretId: SECRET_ARN,
    VersionStage: "AWSCURRENT",
  });
});

test("fails closed on malformed configuration or secret responses", async () => {
  for (const secretArn of [
    undefined,
    "",
    "agentic-platform/runtime-proof",
    `${SECRET_ARN} `,
  ]) {
    assert.throws(
      () => createRuntimeProofSecretProvider({
        client: { send() {} },
        secretArn,
      }),
      /proof secret configuration is invalid/i,
    );
  }

  for (const response of [
    {},
    { ARN: SECRET_ARN, SecretString: "not-json" },
    {
      ARN: SECRET_ARN,
      SecretString: secretString({ hmacKey: "too-short" }),
      VersionStages: ["AWSCURRENT"],
    },
    {
      ARN: SECRET_ARN,
      SecretString: secretString({ allowedEndpointArn: null }),
      VersionStages: ["AWSCURRENT"],
    },
    {
      ARN: SECRET_ARN,
      SecretString: secretString({ unexpected: true }),
      VersionStages: ["AWSCURRENT"],
    },
    {
      ARN: `${SECRET_ARN}-other`,
      SecretString: secretString(),
      VersionStages: ["AWSCURRENT"],
    },
    {
      ARN: SECRET_ARN,
      SecretString: secretString(),
      VersionStages: ["AWSPREVIOUS"],
    },
    {
      ARN: SECRET_ARN,
      SecretBinary: Buffer.from(secretString()),
      VersionStages: ["AWSCURRENT"],
    },
  ]) {
    const provider = createRuntimeProofSecretProvider({
      client: { async send() { return response; } },
      secretArn: SECRET_ARN,
    });
    await assert.rejects(
      provider(),
      /runtime invocation proof secret is unavailable/i,
    );
  }
});

test("sanitizes backend failures and retries after a failed load", async () => {
  let calls = 0;
  const provider = createRuntimeProofSecretProvider({
    client: {
      async send() {
        calls += 1;
        if (calls === 1) {
          throw new Error(`do not expose ${SECRET}`);
        }
        return {
          ARN: SECRET_ARN,
          SecretString: secretString(),
          VersionStages: ["AWSCURRENT"],
        };
      },
    },
    secretArn: SECRET_ARN,
  });

  await assert.rejects(
    provider(),
    (error) => (
      error.message === "Runtime invocation proof secret is unavailable."
      && !String(error).includes(SECRET)
    ),
  );
  assert.equal((await provider()).hmacKey, SECRET);
  assert.equal(calls, 2);
});

test("accepts a bounded previous key for coordinated rotation", async () => {
  const previous =
    "previous-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const provider = createRuntimeProofSecretProvider({
    client: {
      async send() {
        return {
          ARN: SECRET_ARN,
          SecretString: secretString({ previousHmacKey: previous }),
          VersionStages: ["AWSCURRENT"],
        };
      },
    },
    secretArn: SECRET_ARN,
  });

  assert.equal((await provider()).previousHmacKey, previous);
});
