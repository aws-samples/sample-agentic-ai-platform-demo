import assert from "node:assert/strict";
import test from "node:test";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import {
  createRegistryDecisionFinalizer,
  createRegistryDecisionFinalizerHandler,
} from "../lambda/platform-admin/finalizer.mjs";
import {
  createRegistryDecisionFinalizerClient,
} from "../lambda/platform-admin/finalizer-client.mjs";

const AUDIT = {
  actor: "admin-sub-123",
  action: "registry.version.decide",
  resource:
    "registry/SharedReg12345/record/Rec123456789/version/1.0.0",
  decision: "approve",
  reason: "Approved by platform administrator.",
  requestId: "request-123",
  timestamp: "2026-08-23T01:02:03.000Z",
};
const PAYLOAD = {
  audit: AUDIT,
  requestResult: {
    actor: AUDIT.actor,
    route: "POST /api/registry-decide",
    requestId: AUDIT.requestId,
    result: {
      kind: "REGISTRY_DECISION",
      status: "SUCCEEDED",
      payloadFingerprint: "a".repeat(64),
      resource: AUDIT.resource,
      decision: AUDIT.decision,
      reason: AUDIT.reason,
      version: {
        id: "customer-support-blueprint",
        semver: "1.0.0",
        status: "APPROVED",
        statusReason: AUDIT.reason,
        _aws: {
          registryId: "SharedReg12345",
          recordId: "Rec123456789",
        },
      },
    },
    createdAt: AUDIT.timestamp,
  },
  claim: {
    kind: "REGISTRY_DECISION",
    payloadFingerprint: "a".repeat(64),
    ownerToken: "owner-token-123",
    attemptCount: 1,
    target: {
      registryId: "SharedReg12345",
      recordId: "Rec123456789",
      semver: "1.0.0",
      targetStatus: "APPROVED",
      statusReasonHash:
        "f88f7ab6010977c689f86dbc76c22ae3e3600ad22878941751f923b1fe06ea43",
    },
  },
};

function stateHarness({ conflict = false, storedAudit = AUDIT } = {}) {
  const calls = [];
  return {
    calls,
    state: {
      async putRegistryDecisionAuditWithRequestResult(value) {
        calls.push(["finalize", structuredClone(value)]);
        if (conflict) {
          throw Object.assign(new Error("audit exists"), {
            code: "AUDIT_CONFLICT",
          });
        }
        return structuredClone(value);
      },
      async getAudit(value) {
        calls.push(["getAudit", structuredClone(value)]);
        return structuredClone(storedAudit);
      },
      async putRegistryDecisionResultForAuditReplay(value) {
        calls.push(["replay", structuredClone(value)]);
        return structuredClone(value.requestResult);
      },
    },
  };
}

test("finalizer atomically writes immutable audit and result through its state boundary", async () => {
  const harness = stateHarness();
  const finalizer = createRegistryDecisionFinalizer(harness);

  assert.deepEqual(await finalizer.finalize(PAYLOAD), { ok: true });
  assert.deepEqual(harness.calls, [["finalize", PAYLOAD]]);
});

test("finalizer replays an audit conflict only for the same actor-safe evidence", async () => {
  const harness = stateHarness({ conflict: true });
  const finalizer = createRegistryDecisionFinalizer(harness);

  assert.deepEqual(await finalizer.finalize(PAYLOAD), {
    ok: true,
    replayed: true,
  });
  assert.deepEqual(harness.calls[1], [
    "getAudit",
    {
      actor: AUDIT.actor,
      timestamp: AUDIT.timestamp,
      requestId: AUDIT.requestId,
    },
  ]);
  assert.deepEqual(harness.calls[2], [
    "replay",
    {
      requestResult: PAYLOAD.requestResult,
      claim: PAYLOAD.claim,
    },
  ]);

  const mismatch = stateHarness({
    conflict: true,
    storedAudit: { ...AUDIT, actor: "other-admin" },
  });
  await assert.rejects(
    createRegistryDecisionFinalizer(mismatch).finalize(PAYLOAD),
    (error) => error?.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    mismatch.calls.some(([method]) => method === "replay"),
    false,
  );
});

test("finalizer handler accepts only the exact internal operation envelope", async () => {
  const calls = [];
  const handler = createRegistryDecisionFinalizerHandler({
    finalizer: {
      async finalize(value) {
        calls.push(structuredClone(value));
        return { ok: true };
      },
    },
    logger: { error() {} },
  });

  assert.deepEqual(await handler({
    operation: "FINALIZE_REGISTRY_DECISION",
    payload: PAYLOAD,
  }), { ok: true });
  for (const event of [
    null,
    {},
    { operation: "OTHER", payload: PAYLOAD },
    {
      operation: "FINALIZE_REGISTRY_DECISION",
      payload: PAYLOAD,
      extra: true,
    },
  ]) {
    assert.deepEqual(await handler(event), {
      ok: false,
      code: "FINALIZER_INVALID_REQUEST",
    });
  }
  assert.deepEqual(calls, [PAYLOAD]);
});

test("finalizer client invokes only the configured function synchronously", async () => {
  const commands = [];
  const client = createRegistryDecisionFinalizerClient({
    functionName: "AgenticPlatform-Web-RegistryDecisionFinalizer",
    lambdaClient: {
      async send(command) {
        commands.push(command);
        return {
          StatusCode: 200,
          Payload: Buffer.from(JSON.stringify({ ok: true })),
        };
      },
    },
  });

  assert.deepEqual(await client.finalize(PAYLOAD), { ok: true });
  assert.ok(commands[0] instanceof InvokeCommand);
  assert.equal(
    commands[0].input.FunctionName,
    "AgenticPlatform-Web-RegistryDecisionFinalizer",
  );
  assert.equal(commands[0].input.InvocationType, "RequestResponse");
  assert.deepEqual(
    JSON.parse(Buffer.from(commands[0].input.Payload).toString("utf8")),
    {
      operation: "FINALIZE_REGISTRY_DECISION",
      payload: PAYLOAD,
    },
  );
});

test("finalizer client preserves only stable remote conflict codes", async () => {
  for (const [response, expectedCode] of [
    [
      {
        StatusCode: 200,
        Payload: Buffer.from(JSON.stringify({
          ok: false,
          code: "REQUEST_CLAIM_CONFLICT",
        })),
      },
      "REQUEST_CLAIM_CONFLICT",
    ],
    [
      {
        StatusCode: 200,
        FunctionError: "Unhandled",
        Payload: Buffer.from("secret stack"),
      },
      "FINALIZER_UNAVAILABLE",
    ],
    [
      { StatusCode: 200, Payload: Buffer.from("{") },
      "FINALIZER_UNAVAILABLE",
    ],
  ]) {
    const client = createRegistryDecisionFinalizerClient({
      functionName: "AgenticPlatform-Web-RegistryDecisionFinalizer",
      lambdaClient: { async send() { return response; } },
    });
    await assert.rejects(
      client.finalize(PAYLOAD),
      (error) =>
        error?.code === expectedCode
        && !error.message.includes("secret"),
    );
  }
});

test("finalizer client accepts only an exact synchronous Lambda status code", async () => {
  for (const StatusCode of [undefined, 202, "200", null]) {
    const client = createRegistryDecisionFinalizerClient({
      functionName: "AgenticPlatform-Web-RegistryDecisionFinalizer",
      lambdaClient: {
        async send() {
          return {
            ...(StatusCode === undefined ? {} : { StatusCode }),
            Payload: Buffer.from(JSON.stringify({ ok: true })),
          };
        },
      },
    });
    await assert.rejects(
      client.finalize(PAYLOAD),
      (error) => error?.code === "FINALIZER_UNAVAILABLE",
      String(StatusCode),
    );
  }
});
