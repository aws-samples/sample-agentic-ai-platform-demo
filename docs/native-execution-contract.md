# One synchronous native execution and usage path

This describes the retained Experience → AgentCore Runtime → Gateway protocol.
The configured direct Runtime path and its v3 Haiku settlement extend it in
[bedrock-runtime-pricing.md](bedrock-runtime-pricing.md). Use that document's
reader gate and price configuration for current direct inference.
It is source implementation, not deployment or live execution evidence.
Runtime/Lambda build targets remain Node 22. All activation flags default off.
The prior cost-v1 dispatch contract and rollback gates remain described in
[project-cost-contract.md](project-cost-contract.md).

## Durable boundary and identity

1. Experience resolves the authorized candidate and creates its existing
   actor/request reservation. No browser-supplied project/start claim is used.
2. The adapter adds versioned accounting identity to the HMAC v2 signed payload:
   run hash, existing payload fingerprint, `gateway-1`, `PRODUCTION`, `user`.
   The signature also covers actor, request, domain, project, session, model,
   prompt, token cap, endpoint audience and nonce.
3. Before dispatch, Experience performs one DynamoDB transaction on the
   existing state table: check the complete reservation binding and STARTED
   phase; create `NATIVE_EXECUTION_BINDING#<runHash>`; create an empty
   `NATIVE_EXECUTION_EVENT#<SHA256(proof.signature)>` slot. Each uses a fixed
   sort key. The binding includes the reservation, model, endpoint and event
   key, but no prompt/output/secret. Duplicate preparation cannot allocate a
   fresh proof/event for the same run.
4. Runtime validates the complete proof, then consumes the nonce in the
   existing durable replay ledger. It conditionally writes `startedAt` on
   the prepared event slot and awaits success **before Gateway execution**.
   A signed accounting request without a configured writer fails here.
   This is the defined agent execution-entry boundary, not a provider charge.
5. Gateway captures validated final provider usage before parsing the answer.
   Runtime persists one immutable usage event with observation timestamp,
   protocol adapter version, input/output/cache counters, provider model,
   request ID, attested route (or null), and sealed price result/revision.
   Output validation failure therefore retains billable usage. Runtime then
   writes a terminal `SUCCEEDED`, `FAILED` or `UNKNOWN` event independently
   of the outer Experience response.

Runtime IAM allows only GetItem/UpdateItem on event keys. It cannot read or
write binding/reservation keys or query/scan their capabilities. Scope comes
exclusively from the Experience binding checked against the existing
reservation. A fabricated event key has no binding and is never included.
The opaque proof-derived event key cannot be chosen in a request; changing
domain, project, run, fingerprint, model, prompt or nonce produces a different,
unprepared slot. Event records carry no writable domain/project labels.
Runtime is trusted to report its own lifecycle/usage; this is not protection
against a compromised process falsifying an invocation capability it already
possesses.

The stack encodes these narrow role grants. Experience uses its existing
UpdateItem grant for a conditional same-value fingerprint update inside the
transaction, and gets transaction-only PutItem on binding/event namespaces.
Operations gets GetItem on those two namespaces. The existing synthesized
permissions boundary already allows these item actions on the state table;
its compactor removes the canonical file's state key conditions. The effective
key restrictions come from the role policies. No boundary expansion is added.

## Failure, retry and crash semantics

| Interval / outcome | Accounting result |
| --- | --- |
| Denied before reservation | No run |
| Prepared/accepted dispatch, proof rejected or SDK never sent | Empty event slot; zero native starts |
| Definite start-write failure | No Gateway execution; no start |
| Start committed but acknowledgement lost | Counted start, unknown cost; Gateway is not sent |
| Crash after durable start and before Gateway send | Counted execution entry, unresolved; provider billing unknown |
| Provider counters retained, answer validation fails | Failed run with retained measured cost |
| Timeout/network error without final usage | Counted UNKNOWN run; costs incomplete |
| Usage persisted, terminal or outer response lost | Counted start; retained cost survives |
| Provider may bill, but process dies before usage durability | Counted start; missing billable usage remains unknown |

Start persistence and Gateway are not an atomic transaction. No distributed
exactly-once or proof-of-billing guarantee is made. An ambiguous write never
permits Gateway execution; a repeated start returns “already recorded” and
does not execute. There is no automatic nonce renewal or crash reinvocation.
Experience's existing reservation/recovery rules remain in force.

SDK delivery retries of the same immutable event and repeated identical
usage/terminal delivery do not add runs or cost. A changed usage observation
for `gateway-1` conflicts. This slice makes exactly one Gateway call:
there is no internal model retry loop. A new explicitly authorized request ID
is a separate user run, with its own cost. Multiple billable attempts inside
one run require a later explicit attempt protocol; they must not reuse this
slot. Provider-internal retries are not separately visible.

Non-2xx provider/Gateway bodies remain unread; no usage is guessed from them.
Oversized/unparseable responses and missing counters can also leave usage
unknown. Missing cache counters are never converted to zero.

## Costs and UI

Operations retains its bounded, authorized project-pair GSI query, then uses
strongly consistent point reads for each companion binding/event. No scan,
index, table, event bus or new service is introduced. Missing/malformed
prepared event data fails the read. Legacy records without a native binding
that could overlap the window leave the complete denominator/cost unknown.
The GSI remains eventual and this is not a snapshot or a complete history
watermark. Point-read work is bounded by the existing page/record limit.

`runBoundary: runtime-durable-start` is the only new contract that enables
`runCount` and cost/run. `knownRunCount` counts observed native starts even
when a mixed legacy cohort makes the complete count null. Failures after
start count. Accepted dispatches remain separate diagnostics.

`windowBasis: usage-occurrence-and-execution-start` sums final usage observations
and counts starts independently in the same half-open UTC window, project,
production environment and user purpose. A run can start before the window
and produce usage inside it: zero starts then means cost/run N/A, not zero
cost. A lost usage outcome whose possible execution interval overlaps the
window makes its cost incomplete. Provider occurrence is measured at receipt
of the final usage response; an unreported provider billing timestamp is not
invented.

Failed runs with measured usage contribute to `knownEstimatedCostUsd`.
Any missing billable usage/price leaves `estimatedCostUsd` null, while the
known subtotal remains visible. UI computes sum(cost)/sum(native starts)
only for complete pages and available model estimates/counts. Coverage always
excludes Runtime, Gateway, memory, tools, evaluation, shared and unobserved
attempt costs; this is a partial model-inference estimate, not invoice spend
or full project-cost acceptance. Monthly projection stays null.

## Versioned price configuration

Legacy version 1 pricing remains compatible for the dispatch reader. Native
Gateway settlement accepts version 2 entries and exact Runtime route attestation.
Each v2 entry adds `activation` (`candidate` or `active`) and `route` to the
existing exact rate schema. Route fields are:

- `attestationId`: reference to the deployment owner's immutable route evidence.
- `modelId`, `providerModelId`, `provider`: requested alias and actual provider identity.
- `gatewayRegion`, `billingRegion`, `inferenceMode`: Gateway location is distinct
  from billing geography; mode is regional, cross-region or global.
- `serviceTier`: standard, priority, flex or batch.
- `cacheMode`: explicit-counters; the existing cache basis/TTL fields still apply.

The Runtime config (`RUNTIME_USAGE_ROUTE_JSON`) must match the requested
model and every price route field; the response must match the provider model
and cache basis. Price selection uses final usage observation time and the
half-open effective interval. Candidate entries never price usage. Active
Bedrock entries reject Anthropic direct-rate source URLs. Source URL validation
is not independent price verification: the deployment owner must verify the
exact AWS route, mode, tier, region, cache applicability and effective interval.

The selected amount/source/version and full price-book hash are sealed with
the usage event. Operations cannot reprice those events by changing its env.
`pricingRevisions` lists retained revisions and `pricingRevision` hashes that
ordered set for native aggregates. Missing rates stay missing; later
reconciliation/backfill is not implemented.

[native-execution-prices.example.json](native-execution-prices.example.json)
records the report's **unactivated candidate**, not verified Bedrock rates.
The direct Anthropic values and retrieval date come from the existing
delivery report; no fresh network lookup occurred here. Midnight normalizes
the report's date, and the one-day effective interval is illustrative, not
an asserted AWS historical rate interval. The alias/provider/global route is
unattested. The file is not loaded by the stack, and simply flipping activation
to active rejects its direct-provider source for Bedrock. Synthetic tests use
separate `example.invalid` rates.

## Activation and rollback

No CDK env enables the feature or installs a rate/route. A separately authorized
rollout must establish artifact/source provenance, install the compatible
Runtime/Experience/Operations readers and IAM boundary, then explicitly set:

| Component | Setting |
| --- | --- |
| Runtime | `RUNTIME_NATIVE_EXECUTION_VERSION=native-v1` |
| Experience | `EXPERIENCE_NATIVE_EXECUTION_VERSION=native-v1` |
| Operations | `OPERATIONS_NATIVE_EXECUTION_VERSION=native-v1` plus existing cost-reader compatibility flags |
| Runtime pricing | Verified `RUNTIME_USAGE_ROUTE_JSON` and v2 `OPERATIONS_MODEL_PRICES_JSON`; omitted means unpriced |

Companion rows have no `entityType`, so old GSI invocation readers do not see
them. They do not add attributes to existing invocation rows. Native writes
can coexist with legacy invocation-format writes; tests load pinned old
readers against retained companion rows. If existing cost-v1/accounting
invocation rows exist, the **previous rollback rejection still applies**.
Disabling flags never converts/deletes retained records. Rollback also
requires draining writers and disabling the native cost UI/read contract;
old readers cannot provide native KPIs.

Live Node 22 reruns, deployed artifact mapping, exact selected-agent Gateway
route, AWS rate verification, real usage/trace/cross-domain acceptance and
delivered budget alerts remain required. Budget notifier implementation is
the next slice; no alert delivery is claimed by these tests.
