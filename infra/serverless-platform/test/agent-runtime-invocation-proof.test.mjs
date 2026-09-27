import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeInvocationProof,
} from "../lambda/agent-runtime/invocation-proof.mjs";

const SECRET =
  "test-only-runtime-proof-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const AUDIENCE =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567/"
  + "runtime-endpoint/Production";
const OTHER_AUDIENCE =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:"
  + "runtime/AgenticPlatformRuntime-ABC1234567/"
  + "runtime-endpoint/Sandbox";

function payload() {
  return {
    agentConfig: {
      agentId: "triage-agent",
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
    },
    prompt: "Classify this customer request.",
    maxTokens: 2_048,
    session: {
      sessionId: "session-0123456789abcdef-abcdef0123456789",
      metadata: {
        actor: "user-sub-123",
        requestId: "invoke-request-123",
        domainId: "customer_support",
        projectId: "case-assist",
      },
    },
  };
}

test("signs and verifies a canonical bounded runtime payload", () => {
  const proofOptions = {
    secret: SECRET,
    clock: () => 1_000_000,
    nonce: () => Buffer.alloc(32, 1),
  };
  const proof = createRuntimeInvocationProof(proofOptions);
  const input = payload();
  const reordered = {
    session: {
      metadata: {
        projectId: "case-assist",
        domainId: "customer_support",
        requestId: "invoke-request-123",
        actor: "user-sub-123",
      },
      sessionId: "session-0123456789abcdef-abcdef0123456789",
    },
    maxTokens: 2_048,
    prompt: "Classify this customer request.",
    agentConfig: {
      modelId: "bedrock-claude/anthropic.claude-sonnet-5",
      agentId: "triage-agent",
    },
  };

  const envelope = proof.sign(input, AUDIENCE);
  const reorderedEnvelope = createRuntimeInvocationProof(
    proofOptions,
  ).sign(reordered, AUDIENCE);

  assert.deepEqual(envelope, {
    version: "v2",
    audience: AUDIENCE,
    issuedAt: 1_000_000,
    expiresAt: 1_060_000,
    nonce: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    signature: envelope.signature,
  });
  assert.match(envelope.signature, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(reorderedEnvelope, envelope);
  assert.equal(proof.verify(input, envelope, AUDIENCE), true);
});

test("rejects any change to signed runtime attribution or content", () => {
  const proof = createRuntimeInvocationProof({
    secret: SECRET,
    clock: () => 1_000_000,
    nonce: () => Buffer.alloc(32, 2),
  });
  const envelope = proof.sign(payload(), AUDIENCE);
  const mutations = [
    (value) => { value.agentConfig.agentId = "other-agent"; },
    (value) => { value.agentConfig.modelId = "provider/other-model"; },
    (value) => { value.prompt = "Different request."; },
    (value) => { value.maxTokens = 2_049; },
    (value) => { value.session.sessionId = "session-other"; },
    (value) => { value.session.metadata.actor = "other-sub"; },
    (value) => { value.session.metadata.requestId = "other-request"; },
    (value) => { value.session.metadata.domainId = "operations"; },
    (value) => { value.session.metadata.projectId = "foreign-project"; },
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(payload());
    mutate(changed);
    assert.equal(proof.verify(changed, envelope, AUDIENCE), false);
  }
});

test("rejects altered well-formed proof envelope fields", () => {
  let nonceByte = 10;
  const proof = createRuntimeInvocationProof({
    secret: SECRET,
    clock: () => 1_000_000,
    nonce: () => Buffer.alloc(32, nonceByte += 1),
  });
  const envelope = proof.sign(payload(), AUDIENCE);
  const otherEnvelope = proof.sign(payload(), AUDIENCE);
  const alterations = [
    [
      { ...envelope, audience: OTHER_AUDIENCE },
      OTHER_AUDIENCE,
    ],
    [
      {
        ...envelope,
        issuedAt: envelope.issuedAt + 1,
        expiresAt: envelope.expiresAt + 1,
      },
      AUDIENCE,
    ],
    [
      { ...envelope, nonce: otherEnvelope.nonce },
      AUDIENCE,
    ],
    [
      { ...envelope, signature: otherEnvelope.signature },
      AUDIENCE,
    ],
  ];

  for (const [altered, audience] of alterations) {
    assert.equal(proof.verify(payload(), altered, audience), false);
  }
});

test("fails closed on weak secrets, malformed proofs, and unsafe payloads", () => {
  assert.throws(
    () => createRuntimeInvocationProof({ secret: "too-short" }),
    /proof configuration is invalid/i,
  );

  const proof = createRuntimeInvocationProof({
    secret: SECRET,
    clock: () => 1_000_000,
    nonce: () => Buffer.alloc(32, 3),
  });
  const envelope = proof.sign(payload(), AUDIENCE);
  for (const invalid of [
    undefined,
    null,
    "",
    {},
    { ...envelope, version: "v1" },
    { ...envelope, audience: OTHER_AUDIENCE },
    { ...envelope, issuedAt: -1 },
    { ...envelope, expiresAt: envelope.issuedAt },
    { ...envelope, nonce: "a".repeat(42) },
    { ...envelope, signature: "a".repeat(42) },
    { ...envelope, signature: "!".repeat(43) },
    { ...envelope, extra: "not signed" },
  ]) {
    assert.equal(proof.verify(payload(), invalid, AUDIENCE), false);
  }

  const accessor = payload();
  Object.defineProperty(accessor.session.metadata, "actor", {
    enumerable: true,
    get() {
      throw new Error(`must not expose ${SECRET}`);
    },
  });
  const symbol = payload();
  symbol[Symbol("secret")] = "hidden";
  const oversized = payload();
  oversized.prompt = "x".repeat(32 * 1024);

  for (const invalid of [accessor, symbol, oversized]) {
    assert.throws(
      () => proof.sign(invalid, AUDIENCE),
      (error) => (
        /proof payload is invalid/i.test(error.message)
        && !String(error).includes(SECRET)
      ),
    );
    assert.equal(proof.verify(invalid, envelope, AUDIENCE), false);
  }
});

test("uses an injected cache only after authentic proof verification", () => {
  const cacheCalls = [];
  const proof = createRuntimeInvocationProof({
    secret: SECRET,
    clock: () => 1_000_000,
    nonce: () => Buffer.alloc(32, 9),
    replayCache: {
      consume(...args) {
        cacheCalls.push(args);
        return true;
      },
    },
  });
  const envelope = proof.sign(payload(), AUDIENCE);

  assert.equal(
    proof.verify(
      { ...payload(), prompt: "Altered." },
      envelope,
      AUDIENCE,
    ),
    false,
  );
  assert.deepEqual(cacheCalls, []);
  assert.equal(proof.verify(payload(), envelope, AUDIENCE), true);
  assert.deepEqual(cacheCalls, [[
    envelope.nonce,
    envelope.expiresAt,
    1_000_000,
  ]]);
});

test("rejects an immediate replay of an accepted proof", () => {
  const proof = createRuntimeInvocationProof({ secret: SECRET });
  const signature = proof.sign(payload(), AUDIENCE);

  assert.equal(proof.verify(payload(), signature, AUDIENCE), true);
  assert.equal(proof.verify(payload(), signature, AUDIENCE), false);
});

test("rejects a proof at its expiry without sleeping", () => {
  let now = 1_000_000;
  const proof = createRuntimeInvocationProof({
    secret: SECRET,
    clock: () => now,
  });
  const signature = proof.sign(payload(), AUDIENCE);
  now += 60_000;

  assert.equal(proof.verify(payload(), signature, AUDIENCE), false);
});

test("rejects a proof issued beyond the allowed future skew", () => {
  let now = 1_006_000;
  const proof = createRuntimeInvocationProof({
    secret: SECRET,
    clock: () => now,
  });
  const signature = proof.sign(payload(), AUDIENCE);
  now = 1_000_000;

  assert.equal(proof.verify(payload(), signature, AUDIENCE), false);
});

test("rejects a proof issued for a different Runtime endpoint audience", () => {
  const proof = createRuntimeInvocationProof({ secret: SECRET });
  const signature = proof.sign(payload(), AUDIENCE);

  assert.equal(
    proof.verify(payload(), signature, OTHER_AUDIENCE),
    false,
  );
});

test("process-local nonce cache stays bounded and fails closed at capacity", () => {
  let now = 1_000_000;
  let nonceByte = 0;
  const proof = createRuntimeInvocationProof({
    secret: SECRET,
    clock: () => now,
    nonce: () => Buffer.alloc(32, nonceByte += 1),
    replayCacheMaxEntries: 2,
  });
  const signatures = [
    proof.sign(payload(), AUDIENCE),
    proof.sign(payload(), AUDIENCE),
    proof.sign(payload(), AUDIENCE),
  ];

  assert.deepEqual(
    signatures.map((signature) =>
      proof.verify(payload(), signature, AUDIENCE)
    ),
    [true, true, false],
  );

  now += 60_000;
  const afterExpiry = proof.sign(payload(), AUDIENCE);
  assert.equal(proof.verify(payload(), afterExpiry, AUDIENCE), true);
});
