# Hosted project cost contract — bounded journal slice

The opt-in native execution path is documented in
[native-execution-contract.md](native-execution-contract.md). It adds durable
Runtime starts and provider usage in companion rows, and enables the KPI only
with that evidence. The dispatch-only/default behavior and existing
invocation-row compatibility rules below remain in force when native mode is
disabled.

This source line is based on cached main `38b3130`. It is not deployment
proof, a billing ledger, or full project-cost acceptance. Node **22** is the
execution/acceptance expectation (`.node-version`, existing CI and Lambda
runtime). Local checks on Node 26 are development evidence only.

## Cost API and scope

`GET /api/costs` retains the authorized `scope`, half-open UTC `window`,
`items`, and signed `cursor`. Once explicitly enabled as described below,
the configured Operations handler queries the existing Experience invocation
journal. By default `/api/costs` returns `503 OPERATIONS_UNAVAILABLE` before
querying the journal, including for empty scopes. Existing hosted cost views
display “Cost data is unavailable.” No zero cost or zero-run total is supplied
while gated. It does not price CloudWatch
completion metrics. The legacy CloudWatch usage provider remains available
for old callers and still returns unknown dollars and run accounting.

Operations resolves current authorized domain/project pairs before reading.
Admin and Domain rows sum those same project pairs; Builder rows include only
owned/member projects. Identical project slugs in different domains remain
distinct. The reader uses `EntityTypeIndex` with exact domain AND project
filters, validates returned rows, and exposes only accounting metadata (no
actor, prompt, or output). No new table, index, service, or scan was added.
Operations IAM gains only Query on `EXPERIENCE_INVOCATION` in that existing
index. These queries are authorized in the service, not by user-supplied
DynamoDB cursors. The service role itself can read that entity partition.

The index is ordered by request, not time, and is eventually consistent.
The reader follows empty filtered pages, rejects duplicate runs, malformed
or repeated cursors, and limits the entire aggregate request to 100 query
pages of at most 100 evaluated items each. Exceeding the bound fails the
request; it never returns a truncated numeric total. This is a bounded demo
reader, not a scalable history query: filters do not reduce evaluated reads.
Large histories or more than 100 nonempty project queries require future
query design work. Deadline/abort errors propagate; no fallback spend appears.

Clients load every page before summing. Signed public cursors bind identity,
authorized mappings, page size and window; the nested provider cursor also
binds the full price-book revision. The window is fixed across pages, but
there is **no snapshot isolation**: late writes/GSI propagation can change
values. `updatedAt` is the newest included record timestamp, not a GSI
watermark. Platform/domain/project copies must not be added together.

## Durable dispatch lifecycle and unavailable agent-run denominator

The requested KPI is **attributed project cost / actual started agent runs**.
Accepted dispatch is not an agent run. This journal has no trusted, complete
actual execution-start evidence. Its `runCount` and `costPerRunUsd` remain
null with `runCountUnavailableReason: actual-execution-start-unavailable`,
including priceable successful responses and empty cohorts. The journal's
generic `invocationCount` is also null rather than an alias for dispatches.
UI agent-run count and cost per run display N/A with that explanation; even
older responses with numeric dispatch-based `runCount` cannot populate them.

The existing conditional reservation (`phase: STARTED`) still precedes
Runtime invocation. With cost writes enabled, new reservations carry a version 1 `lifecycle` with
production environment, user purpose, and initially null `startedAt`/region.
After local payload validation and proof preparation, the adapter calls
`markDispatched` and awaits its conditional durable write before SDK send.
The marker records the accepted-dispatch timestamp and configured Runtime
region. A marker error fails closed without calling Runtime.

One actor/request pair is one logical request (SHA-256 of actor + NUL + request
ID). Identical completion redelivery returns the retained result; changed
usage conflicts. A new explicit request ID is a separate request, including a
user retry. The configured Experience SDK client uses `maxAttempts: 1`.
The adapter makes no internal retry loop. This does not establish general
billable-attempt coverage or provider exactly-once execution.

The durable transitions in the supported path are:

| Observed Experience path | Journal result | Accepted-dispatch diagnostic |
| --- | --- | --- |
| Authorization denial before reservation | No new record | Excluded |
| Local proof/preparation failure | COMPLETED / FAILED, no dispatch marker | Excluded |
| Accepted Runtime dispatch, success retained | COMPLETED / SUCCEEDED with marker | One dispatch |
| Accepted dispatch, caught transport/response failure | COMPLETED / FAILED with marker | One dispatch; unknown usage/cost |
| Process loss before SDK send or unsuccessful completion write after marker | STARTED with marker | One unresolved dispatch; unknown usage/cost |
| Reservation without dispatch marker | STARTED without marker | Excluded |

`dispatchBoundary: accepted-runtime-dispatch` describes only the diagnostic. The marker
is **not proof of remote execution, a model call, or a charge**. Process loss
between marker and SDK send cannot be distinguished from an in-flight remote
call. A caught failure is terminal for Experience, not proof the remote
Runtime stopped. Runtime-side pre-execution rejection classification is not
retained separately. Remote cancellations/timeouts, crash reconciliation,
other execution entry points, judge/evaluation runs and internal/provider
retry attempts remain unsupported. No CANCELLED or crash-terminal state is
fabricated. `acceptedDispatchCount`, `succeededDispatchCount`,
`failedDispatchCount`, `unresolvedDispatchCount` and `pricedDispatchCount`
describe the observed dispatch cohort only. They replace the misleading
dispatch-based run count fields and `runBoundary` in the cost read contract;
the persisted journal schema and compatibility gates are unchanged.
No cost-per-dispatch ratio is substituted for the requested KPI.

Legacy records lack this dispatch boundary. If such records fall in the
window, `legacyRecordCount` is nonzero and `acceptedDispatchCount` is null. A new
success without a marker (for example mixed old adapter/new writer) is also
unclassified. Old records remain readable without mutation or backfill.

## Matching numerator and window

`windowBasis: dispatch-start-cohort` selects requests whose durable dispatch
timestamp is `>= startTime` and `< endTime`. Cost estimates and dispatch
diagnostics use that cohort and production/user scope. Retained completion usage can arrive
after the window; this is not usage incurred during the wall-clock window,
calendar month-to-date consumption, or invoice spend. Legacy/unclassified
records use retained execution time when available; otherwise any possible
execution interval from reservation through completion (or still unresolved)
overlapping the requested window makes the dispatch total unknown.

Every item retains `contractVersion: 1`, `basis: estimate`, `currency: USD`,
coverage, source and completeness. Journal items also include lifecycle
counts, `modelCoverage`, `knownEstimatedCostUsd`, `pricingRevision`,
`priceSources`, `consistency: eventual`, `windowBasis` and `dispatchBoundary`.

- `estimatedCostUsd` is the sum only when every selected started dispatch
  has successful retained usage that can be priced. Otherwise it is null.
- `knownEstimatedCostUsd` is explicitly the priced subset, never a full
  numerator. It may be zero even when total cost is unknown.
- `modelCoverage` describes the **retained-response** subset: complete,
  partial or unavailable. Overall project coverage is always partial when
  an estimate exists. Unobserved attempts, Runtime, Gateway, memory, tools,
  evaluation and shared costs are excluded. There is no arbitrary overhead.
- Failed/unresolved dispatches remain in the diagnostic count but have unknown
  usage/cost. Missing tokens are not zero. Empty classified cohorts have
  zero accepted dispatches and zero retained-response cost; actual agent-run
  count and the requested KPI remain null.
- Agent cost/run requires attributed project cost and a trusted actual-start
  denominator for the same scope/window. It is unavailable in this slice.
  UI sums available costs and explicitly named dispatch diagnostics separately;
  it never divides costs by dispatches or treats missing counts as zero.

Monthly USD budgets remain `monthlyBudgetUsd`, separate from token
allowances. Cohort-based monthly projection is null. No budget writer,
notifier, threshold delivery, or hard-dollar-cap claim is included.

## Explicit injectable pricing

`OPERATIONS_MODEL_PRICES_JSON` defaults to `{ "version": 1, "entries": [] }`.
No usable dated public price source was available in the inspected local cost
documentation, and no network lookup was attempted. **No live price entries
ship.** Tests use synthetic rates with an `example.invalid` provenance URL.
The previous generic input/output environment price is unused and removed
from the generated Operations configuration.

Each injected entry must contain exactly:

| Field | Meaning |
| --- | --- |
| `id` | Immutable price version ID |
| `modelId`, `providerModelId` | Exact configured route/model and provider-returned model identity; no guessed aliases |
| `region`, `inputTokenBasis` | Configured Runtime region and `uncached` or `includes-cache` basis |
| `currency` | USD |
| `effectiveFrom`, `effectiveTo` | Canonical UTC timestamps, half-open interval |
| `source` | HTTPS `url` plus dated `retrievedAt` |
| `usdPerMillionTokens` | Explicit `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`; unknown rates are null |

An operator installing an entry must verify its applicability to the actual
deployed Gateway/model route, including provider/billing region and any
cross-region routing. Runtime region alone does not prove the billing
region. Unverified route applicability means no entry. This slice provides
an injectable contract, not live route/pricing attestation.

Duplicate IDs and overlapping intervals for the same identity are rejected.
The retained Runtime response execution timestamp selects the rate version;
missing execution time, provider identity or matching rate gives null.
That response timestamp surrounds the successful Gateway call in application
code; it is not a durable native start event covering all actual agent runs.
Priceability therefore does not enable an agent-run count or cost/run KPI.
Anthropic-style uncached input is charged separately from cache reads and
TTL-specific cache writes. Inclusive-cache input subtracts reads from normal
input before applying the cache-read rate. Required unknown counters or
positive quantities with unknown rates make the result null. A known zero
quantity contributes zero without manufacturing a rate. No intermediate
cent rounding is used. Overflow fails closed.

Raw accounting remains immutable and unpriced (`pricingVersion` and dollars
in the original accounting record stay null). Query-time estimates attach
the selected version IDs, effective dates/source, and a SHA-256 revision of
the complete configured price book. Multiple versions are listed in
`priceSources`; singular `pricingVersion` is null for mixed versions.
Repricing under another book is visible, not silently written back to runs.

## Usage, identity and compatibility rollout gate

Provider usage retains input/output, cache counters and explicit input basis.
Legacy `usage.totalTokens` remains input plus output; do not price cache from
that field. The native `accounting.traceId` stays null when absent. It is
separate from provider request ID, logical run ID and the legacy response
`invocationId`, which is not proof of a native trace.

| Reader | Legacy row | Accounting-only row | New lifecycle row |
| --- | --- | --- | --- |
| Cached main `38b3130` | Reads | Rejects | Rejects |
| First slice `1feeae25` | Reads | Reads | Rejects |
| This slice | Reads | Reads; unknown dispatch boundary | Reads |

### Default and explicit activation

Both factory callers (`compatibility`) and configured handlers use the same
strict version check:

| Setting | Default | Explicit enable value |
| --- | --- | --- |
| `EXPERIENCE_JOURNAL_WRITE_VERSION` / `writerVersion` | `legacy` | `cost-v1` |
| `EXPERIENCE_JOURNAL_READER_VERSION` / `readerVersion` | `legacy` | `cost-v1` |

Reader values `legacy`, `accounting-v1`, and `cost-v1` correspond respectively
to the three rows in the compatibility table. Invalid values, boolean-like
strings, and `cost-v1` writes without a `cost-v1` reader attestation fail
configuration. Reader capability alone never enables writes or cost queries.
No activation settings ship in the CDK configuration.

Default reservations and completions retain the exact baseline writer shape.
There is no dispatch callback; even if Runtime returns valid accounting, the
store omits it from new writes. It never removes accounting or lifecycle from
existing rows. Current readers accept all three schemas regardless of writer
settings. Identical terminal retries retain existing accounting; changed
retained accounting still conflicts after disabling.

Before setting both values to `cost-v1` on Experience and Operations, the
operator must verify that **every reader that can access these rows** has
the compatible artifact, including recovery and rollback binaries. The
setting is an explicit operator attestation, not automatic discovery or
proof of deployed versions. Install compatible readers with writes still
`legacy`, verify the artifacts, then enable writes and cost reads. Configuration
is captured when handlers/stores are constructed; warm handlers and in-flight
writers do not observe a later environment edit automatically.

### Rollback prerequisite after records exist

**Disabling new writes does not make old-reader rollback safe.** Even a
reservation with a null lifecycle start is incompatible with both older
readers. Accounting-only records are incompatible with baseline `38b3130`.
These rows may already exist from earlier commits; this change does not
inspect deployed data or assert that any deployment is rollback-safe.

The exported `assertInvocationJournalRollbackSafe` in
`lambda/experience/invocation-store.mjs` is an offline preflight contract.
It takes raw DynamoDB `items`, the target `readerVersion`, explicit
`writerVersion: "legacy"`, and attestations `writersDrained: true` and
`inventoryComplete: true`. It validates every supplied row and throws
`UNSAFE_INVOCATION_JOURNAL_ROLLBACK` for incompatible rows, malformed records,
unknown versions, or missing prerequisites. It makes no cloud calls and
neither changes data nor controls deployment.

A rollback operator must first disable writes and cost reads, drain all
enabled handlers/in-flight writers, then establish a complete stable inventory
of all rows reachable by the target reader. A scoped/eventually consistent
`EntityTypeIndex` query, a cost window, an empty sample, or a boolean asserted
without evidence is **not** that inventory. The helper trusts the caller's
attestations; the deployment process must obtain and enforce that evidence.
If incompatible rows exist or completeness cannot be established, reject the
rollback. Retain compatible readers or require a separately reviewed,
lossless compatibility migration/release with its own acceptance evidence.
No deletion, backfill, migration, inventory scan, or deployment integration
was performed here.

Reproduce the synthetic compatibility matrix, defaults, activation rejection,
disable/replay behavior, unavailable costs and rollback contract from the
repository root:

```sh
node --test infra/serverless-platform/test/project-cost-compatibility.test.mjs
```

The test loads historical reader source and its local usage validator using
read-only `git show` at exact commits
`38b31309793b6b65bb1e9d4f6a07ea013ae1bc44`,
`1feeae25f786da0a952102f62f18044eb70ce4da`, and
`4e4a5fe916994d4ce8ba4b4ca03df53ffa51484b`. Those objects must be present
locally; the test never fetches them or changes a checkout. SDK command
classes use the current locked local dependency. This verifies journal
record compatibility, not every cross-version service or deployment contract.

Real Node 22 CI, native Runtime start/trace verification, deployment-to-commit
mapping, bounded live cross-scope acceptance and deployment verifier review remain
parent-owned gates. Local synthetic tests, CDK synthesis and typecheck are
not real acceptance. No deployment, paid call, cloud write or notification
was performed.
