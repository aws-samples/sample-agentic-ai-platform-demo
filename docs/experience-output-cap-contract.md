# Scoped Experience output caps

This is an **unactivated opt-in** for a bounded Experience demo. It adds no
deployment settings, resources, dependencies, or public API fields.

## Configuration and trust

The existing Builder service validates and persists
`buildConfig.modelParameters.maxTokens` (null or an integer from 1 through 4096).
Experience reads the production candidate from Workspace state, verifies its
exact entitlement and deployment, and passes the full authorized record to the
Runtime adapter. The build configuration survives that projection.

Builder configuration is editable by authorized builders. It supplies the
requested target, **not the independent server ceiling**. The Experience
deployment owner can opt individual agents in through `EXPERIENCE_OUTPUT_CAPS_JSON`,
a JSON array of exact `{domainId, projectId, agentId, maxTokens}` entries:

```json
[
  {
    "domainId": "support",
    "projectId": "case-assist",
    "agentId": "triage",
    "maxTokens": 512
  }
]
```

These are synthetic identifiers, not deployed configuration. Each ceiling must
be a numeric safe integer from 1 through 512. Domain and project/agent names use
the existing identifier validators. Duplicate scopes, unknown entry fields,
wildcards, missing fields, and malformed entries are rejected. Matching uses the
complete domain/project/agent tuple; there are no project-wide or global matches.
The adapter snapshots entries at construction so later mutation of the supplied
configuration object cannot change its ceilings.

The public Experience invocation API still accepts only `agentId`, optional
`sessionId`, and `prompt`. Clients cannot supply a cap, scope, candidate, or build
configuration through that API. A server cap does not grant access to an agent.

## Effective limit and failure contract

For an exact opted-in scope:

```text
effective maxTokens = min(adapter maxTokens, persisted build target, server ceiling)
```

The adapter's existing default is 2048; an explicit adapter limit remains valid
from 1 through 8192. It can lower the effective limit but cannot override a lower
agent target or server ceiling. With the default adapter and a ceiling of 512,
targets 128 and 512 reach the provider as exactly 128 and 512. Valid build targets
513 through 4096 are clamped to 512. A ceiling of 128 enforces at most 128 even
if the builder later changes the target to 4096.

| Configuration condition | Behavior |
| --- | --- |
| Environment variable absent, or JSON `[]` | No scopes opted in; existing adapter behavior is preserved. |
| No entry matching the complete authorized tuple | Existing adapter limit, normally 2048; build target does not alter this legacy path. |
| Matching entry and target integer 1–4096 | Apply the minimum above. |
| Matching entry but absent/null build configuration, parameters, or target | Stop before proof preparation and Runtime/provider dispatch; no fallback to 2048. |
| Matching entry with zero, negative, fractional, string, null, unsafe/non-finite, or out-of-range target | Stop before dispatch. No coercion. Inherited/accessor targets are not accepted. |
| Present but invalid server JSON/array/entry/ceiling | Handler construction fails closed; no silent fallback or SDK call. |
| Invalid explicit adapter limit | Adapter construction fails, even if a valid scoped cap exists. |

Absent policy means **legacy, not bounded**. Removing an entry removes that
opt-in. The existence of a build target alone does not certify a bounded pilot.
This explicit absence contract preserves non-demo behavior without guessing
which agents are demos. Within an opted-in scope, missing targets cannot disable
the cap or trigger legacy fallback.

Malformed persisted records may fail earlier in Workspace validation. Experience
retains its existing unavailable errors and failed reservation/session behavior;
no journal/run/usage/pricing semantics change. A cap-validation failure does not
prepare a signed native execution or reach the Runtime durable-start boundary.

## Signed and provider boundaries

The effective numeric `maxTokens` is in the existing signed Runtime payload.
The existing proof binds that value together with agent/model, actor, request,
session, project/domain, and endpoint audience. Runtime validates and verifies
the payload before consuming a nonce or calling Gateway. Gateway serializes the
verified value as `max_tokens` for both `/messages` and `/chat/completions`.
Changing a valid signed 128 to 512 or 2048 is rejected before nonce consumption
and provider dispatch. No prompt instruction substitutes for this parameter.

The trust boundary remains the authorized Experience signer and its
server-owned configuration. Runtime needs no new client-supplied policy fields
or proof version. This change bounds the dispatched provider output parameter;
it does not establish live route support, input/context cost, billed usage, or
provider behavior independently of that parameter.

## Required later opt-in

Before a separately authorized future pilot, the deployment owner must install
the reviewed source and configure an exact entry for **each selected actual**
domain/project/agent with ceiling 512 (or lower), and persist a target of 128 in
each candidate's existing `buildConfig.modelParameters.maxTokens`. Verify the
actual selected identities and effective deployed configuration. No cap is
implicitly activated by this source or example, and none was activated here.
Native execution, authorization, pricing, artifact provenance, and paid-pilot
gates remain the independent requirements in the existing native execution
contract and parent reports.

Synthetic verification is in
`infra/serverless-platform/test/experience-output-cap.test.mjs`: the configured
Experience handler, production state parser and authorizer, installed Runtime
SDK serialization, Runtime service/proof checks, and real Gateway serialization
run with in-process SDK/fetch handlers. The storage fixture verifies composition,
not DynamoDB concurrency/IAM; existing native journal regression tests retain
their separate durability and failure checks.
