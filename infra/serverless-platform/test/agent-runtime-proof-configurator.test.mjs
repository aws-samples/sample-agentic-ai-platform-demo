import assert from "node:assert/strict";
import test from "node:test";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  createRuntimeProofConfigurator,
} from "../lambda/agent-runtime/proof-configurator.mjs";

const SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:111122223333:"
  + "secret:agentic-platform/runtime-proof-AbCdEf";
const ENDPOINT_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567/"
  + "runtime-endpoint/Production";
const HMAC_KEY =
  "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function secretString(overrides = {}) {
  return JSON.stringify({
    hmacKey: HMAC_KEY,
    previousHmacKey: null,
    allowedEndpointArn: null,
    keyId: "runtime-proof-v1",
    ...overrides,
  });
}

function event(requestType = "Create", overrides = {}) {
  return {
    RequestType: requestType,
    ResourceProperties: {
      SecretArn: SECRET_ARN,
      AllowedEndpointArn: ENDPOINT_ARN,
    },
    ...overrides,
  };
}

test("finalizes the exact production endpoint while preserving key material", async () => {
  const calls = [];
  const configure = createRuntimeProofConfigurator({
    client: {
      async send(command) {
        calls.push(command);
        if (command instanceof GetSecretValueCommand) {
          return {
            ARN: SECRET_ARN,
            SecretString: secretString(),
            VersionStages: ["AWSCURRENT"],
          };
        }
        return {};
      },
    },
  });

  const result = await configure(event());

  assert.match(
    result.PhysicalResourceId,
    /^runtime-proof-config-[a-f0-9]{32}$/,
  );
  assert.equal(Reflect.ownKeys(result).length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0] instanceof GetSecretValueCommand);
  assert.deepEqual(calls[0].input, {
    SecretId: SECRET_ARN,
    VersionStage: "AWSCURRENT",
  });
  assert.ok(calls[1] instanceof PutSecretValueCommand);
  assert.equal(calls[1].input.SecretId, SECRET_ARN);
  assert.deepEqual(
    JSON.parse(calls[1].input.SecretString),
    {
      hmacKey: HMAC_KEY,
      previousHmacKey: null,
      allowedEndpointArn: ENDPOINT_ARN,
      keyId: "runtime-proof-v1",
    },
  );
  assert.equal(
    JSON.stringify(result).includes(HMAC_KEY),
    false,
  );
});

test("updates an existing endpoint binding without rotating keys", async () => {
  const calls = [];
  const configure = createRuntimeProofConfigurator({
    client: {
      async send(command) {
        calls.push(command);
        return command instanceof GetSecretValueCommand
          ? {
            ARN: SECRET_ARN,
            SecretString: secretString({
              allowedEndpointArn:
                `${ENDPOINT_ARN.slice(0, -"Production".length)}Old`,
            }),
            VersionStages: ["AWSCURRENT"],
          }
          : {};
      },
    },
  });

  await configure(event("Update"));

  assert.equal(calls.length, 2);
  assert.equal(
    JSON.parse(calls[1].input.SecretString).allowedEndpointArn,
    ENDPOINT_ARN,
  );
  assert.match(calls[1].input.ClientRequestToken, /^[a-f0-9]{64}$/);
});

test("duplicate deliveries do not create another secret version", async () => {
  const calls = [];
  const configure = createRuntimeProofConfigurator({
    client: {
      async send(command) {
        calls.push(command);
        return {
          ARN: SECRET_ARN,
          SecretString: secretString({
            allowedEndpointArn: ENDPOINT_ARN,
          }),
          VersionStages: ["AWSCURRENT"],
        };
      },
    },
  });

  await configure(event());
  await configure(event("Update"));

  assert.equal(calls.length, 2);
  assert.ok(calls.every(
    (command) => command instanceof GetSecretValueCommand,
  ));
});

test("concurrent retries use the same deterministic secret version token", async () => {
  const writes = [];
  const configure = createRuntimeProofConfigurator({
    client: {
      async send(command) {
        if (command instanceof GetSecretValueCommand) {
          return {
            ARN: SECRET_ARN,
            SecretString: secretString(),
            VersionStages: ["AWSCURRENT"],
          };
        }
        writes.push(command.input);
        return {};
      },
    },
  });

  await Promise.all([
    configure(event()),
    configure(event("Update")),
  ]);

  assert.equal(writes.length, 2);
  assert.equal(
    writes[0].ClientRequestToken,
    writes[1].ClientRequestToken,
  );
  assert.match(writes[0].ClientRequestToken, /^[a-f0-9]{64}$/);
  assert.equal(writes[0].SecretString, writes[1].SecretString);
});

test("delete is a stable no-op and never reads or mutates the retained secret", async () => {
  let calls = 0;
  const configure = createRuntimeProofConfigurator({
    client: {
      async send() {
        calls += 1;
      },
    },
  });

  const result = await configure(event("Delete"));

  assert.match(
    result.PhysicalResourceId,
    /^runtime-proof-config-[a-f0-9]{32}$/,
  );
  assert.equal(calls, 0);
});

test("fails closed on malformed configuration, events, and secret state", async () => {
  assert.throws(
    () => createRuntimeProofConfigurator(),
    /configurator configuration is invalid/i,
  );

  for (const candidate of [
    {},
    event("Read"),
    event("Create", { ResourceProperties: {} }),
    event("Create", {
      ResourceProperties: {
        SecretArn: SECRET_ARN,
        AllowedEndpointArn: "https://attacker.example",
      },
    }),
  ]) {
    const configure = createRuntimeProofConfigurator({
      client: { async send() { return {}; } },
    });
    await assert.rejects(
      configure(candidate),
      /proof configuration is unavailable/i,
    );
  }

  for (const response of [
    {},
    {
      ARN: SECRET_ARN,
      SecretString: "not-json",
      VersionStages: ["AWSCURRENT"],
    },
    {
      ARN: SECRET_ARN,
      SecretString: secretString({ hmacKey: "too-short" }),
      VersionStages: ["AWSCURRENT"],
    },
    {
      ARN: SECRET_ARN,
      SecretString: secretString({ unexpected: true }),
      VersionStages: ["AWSCURRENT"],
    },
  ]) {
    const configure = createRuntimeProofConfigurator({
      client: { async send() { return response; } },
    });
    await assert.rejects(
      configure(event()),
      /proof configuration is unavailable/i,
    );
  }
});

test("sanitizes Secrets Manager transport failures", async () => {
  const configure = createRuntimeProofConfigurator({
    client: {
      async send() {
        throw new Error(`do not expose ${HMAC_KEY}`);
      },
    },
  });

  await assert.rejects(
    configure(event()),
    (error) => (
      error.message === "Runtime proof configuration is unavailable."
      && !String(error).includes(HMAC_KEY)
      && error.cause === undefined
    ),
  );
});
