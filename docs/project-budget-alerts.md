# Project USD budget alerts

Current baseline: Project Budget create/edit/save/read/refresh/new-session persistence, stale-version 409 and authenticated in-domain Builder 403 were accepted in dev on `587798cc6a8986de99d61a3001d2b5cc2d4fe1ca`. These substeps are DONE; older source-only reports do not reopen them. Notification delivery and full Arc 4 remain unaccepted.

This increment supplies SNS publisher source and configured Operations wiring, a scheduled internal runner source, durable continuation, and bounded cancellation. **The source dependency blocker is resolved:** `@aws-sdk/client-sns@3.1116.0` is pinned in the package manifest and generated lockfile. The three real SDK transport/chain tests are mandatory, with no SDK-availability skip, and both configured Operations and runner bundles include the SDK. The real adapter dynamically imports that package and fails activation if a destination is configured but the SDK is missing; the absent-destination path remains usable. The earlier registry DNS failure is historical, not a current installation gate. No infrastructure, schedule, topic, subscription, recipient or cloud execution was created by this writer. Parent owns source integration/verification; didi owns activation and real evidence. Passing source tests does not prove recipient confirmation or live delivery.

## Operations API contract

All handlers use the existing JWT and verified identity projection. An admin or a lead in the selected authoritative domain may write or trigger alert evaluation on an ACTIVE project returned by workspace state. Builders, including assigned project members, cannot write or trigger alerts. Authorized owners/members may read the project budget and a read-only threshold preview. The existing project authorization check also runs; its Operations project resolver now loads authoritative owner/membership/state for reads. Unknown/foreign projects are concealed; body identity, recipient, cost and time fields are rejected.

`GET /api/operations/project-budgets?domainId=support&projectId=case-assist` accepts exactly those two query parameters, with no body. It returns `resource: "project-budget"`, the requested scope, `project` (name, owner and ACTIVE status), `access` (effective role and server-computed `canEdit`), `budget` (null if unset), and `evaluation` (null if unset). The budget uses a consistent durable config read and excludes the notification destination. The evaluation is a pure call to the existing monthly evaluator: it creates no crossing/outbox record and invokes no publisher. Unknown usage does not prevent reading/editing the config. Query duplicates, foreign scope and malformed input fail closed. The write response also excludes the destination.

`POST /api/operations/project-budgets`, with a stable `x-request-id`:

```json
{
  "domainId": "support",
  "projectId": "case-assist",
  "expectedVersion": 0,
  "currency": "USD",
  "period": "CALENDAR_MONTH_UTC",
  "monthlyLimitUsd": 10,
  "thresholdPercent": 80
}
```

`expectedVersion: 0` creates version 1. Updates specify the current version and increment it. Currency is USD, limits are positive and at most 1 billion USD, and the threshold is an integer percentage from 1 through 100. The response contains the committed budget version, trusted actor, request ID and timestamp. Config and immutable replay result are committed together. Repeating the same actor/request/payload returns its original committed result even after later config versions; a changed payload or stale expected version returns 409. Retries after a deployment destination change also conflict rather than silently changing the destination.

`POST /api/operations/project-budgets/evaluate`, also with `x-request-id`, accepts only:

```json
{ "domainId": "support", "projectId": "case-assist" }
```

It returns the current budget, evaluation, crossing outbox record if present, and a bounded delivery reconciliation result. HTTP evaluation has a 1,400 ms internal deadline, inherits the existing HTTP abort signal, and attempts at most one alert with a 1,000 ms delivery bound. If work cannot finish it returns an unavailable/timeout response; the durable outbox is resumed by the scheduler. There is no background work after cancellation that can initiate a new publish. Repeated evaluations derive fresh usage and converge on the same semantic alert; the HTTP request ID does not create another alert. The request cannot fire an arbitrary alert or supply spend.

The established `monthlyLimitUsd`/`currency` names are retained. The evaluator consumes the durable versioned config. Production `/api/costs` project rows now read the same durable config, returning `monthlyBudgetUsd` and a redacted `projectBudget` with version and threshold. An unset stored config remains null even if `OPERATIONS_BUDGETS_JSON` has a project value. A failed durable read fails the cost request; it never silently falls back. Legacy platform/domain aggregate accounting and their environment budgets remain compatible. Direct legacy service/provider callers without injected budget state retain their old contract; the configured production runtime always injects it.

`GET /api/costs?groupBy=project&window=24h&limit=50` opts into non-overlapping ACTIVE project rows for admins/leads as well as Builders. Domain/project membership is selected from authoritative workspace state. The optional grouping does not grant access to more projects; Builder scope remains owned/assigned projects. Pagination binds identity, scope, window, limit and grouping. The default aggregate contract is unchanged. The journal opts into multi-domain project validation for this breakdown; the CloudWatch validator keeps its existing single-domain project default.

The modular console now has a separate post-create budget step and project Cost & Budget editor, using this GET for permissions and persisted read-back after every successful write. See [project-budget-ui.md](project-budget-ui.md) for UI states, coverage and deployment boundaries. No accounting primitive or token allowance was changed.

## Measurement and missing data

Evaluation reuses the injected `createJournalUsageProvider`, with native execution enabled and existing compatible journal readers. It requests exactly one authorized project. No new ledger or price calculator is introduced.

The stable period is the UTC calendar month `[monthStart, nextMonthStart)`. Usage is observed through the current whole UTC minute, exclusively; the remaining partial minute is unobserved. A 31-day month uses at most two non-overlapping queries because the existing provider accepts windows of at most 30 days. Each query retains the journal provider's existing bounded pagination and duplicate-record rejection. At the first minute of a month the result is unknown, not zero.

The threshold is `monthlyLimitUsd * thresholdPercent / 100`; equality crosses. A valid known lower bound may cross even with missing costs elsewhere. Below that threshold the result is `INCOMPLETE`; absent history, unavailable provider data or untrusted/stale price provenance gives `UNKNOWN`. Neither means under budget. Duplicate usage rows rejected by the common provider cannot manufacture a new crossing.

Output and the immutable crossing snapshot retain basis, partial coverage, UTC window/cutoff, pricing revisions and source URLs/dates, completeness reasons, usage update time and evaluation `asOf`. The freshness policy is explicit: an event update older than 15 minutes is labelled stale; a price source retrieved more than 30 days before evaluation, a future retrieval time, or conflicting source identity makes the lower bound unavailable. These conservative freshness limits do not prove complete ingestion. Historical effective intervals remain sealed by the journal; Operations does not reprice events. A stale usage snapshot with valid retained prices can still establish a crossing lower bound.

Coverage is retained model inference only, excluding unobserved attempts, Runtime, Gateway, memory, tools, evaluation and shared cost. Every evaluation remains partial project coverage. `costPerRunUsd` uses that attributed model estimate divided by **actual native-start agent runs in the same window**; it is null when run counts or covered-model cost are unavailable or the denominator is zero. Dispatches never supply the denominator. This does not enforce full project dollars, suspend runs or control model tokens. Native Gateway model limits do not govern direct Bedrock Runtime inference, including OpenAI.

## Durable storage and delivery

The adapter uses the existing `PLATFORM_STATE_TABLE_NAME` and DynamoDB client, native AttributeValue encoding, consistent reads and conditional transactions. Keys are:

| Partition key | Sort key | Record |
|---|---|---|
| `PROJECT_BUDGET#<domain>#<project>` | `CONFIG` | Current versioned budget |
| Same | `MUTATION#<sha256(actor, requestId)>` | Immutable config replay/audit result |
| Same | `ALERT#<semantic-id>` | Crossing snapshot and delivery state in one durable record |
| Same | `RUNNER_CURSOR` | Revision-fenced next alert position for this project |
| `PROJECT_BUDGET#RUNNER` | `CHECKPOINT` | Global runner lease and domain/project directory position |

Each item contains only `pk`, `sk`, numeric `revision` and serialized `record`. These keys have no EntityTypeIndex attributes and cannot appear in the existing `PROJECT#` queries or entity-index readers. Existing records/strict schemas are unchanged. No automatic deletion or TTL is introduced; preserving dedupe and replay history is intentional. Rollback stops evaluation/delivery while leaving these independent records intact.

The semantic alert ID hashes domain, project, config version, calendar-window bounds and threshold percentage. A transaction checks the config version and conditionally creates the crossing/outbox. There is no separate crossing marker that can commit without a notification record. An already-existing alert is returned on repeat evaluation.

Delivery pins the destination from the config version. Changing a budget version supersedes older pending alerts when reconciled; changing only the publisher's destination reports `DESTINATION_MISMATCH` and never reroutes an old alert. A claim transaction checks the current config version and replaces the alert only at its expected revision. A 30-second lease and revision checks fence concurrent workers and delayed responses. A version update cannot cancel a publish already in flight; a previously accepted alert remains accepted.

The injected contract is:

```js
publisher.publish({
  destination,       // exact approved topic ARN from deployment configuration
  idempotencyKey,    // stable semantic alert ID; not an exactly-once guarantee
  message,          // bounded JSON of evaluation/provenance, no prompt or actor
  abortSignal
}) // resolves to { MessageId }
```

The adapter uses a five-second publish deadline, at most three attempts, and 60/120-second backoff after transient failures. It never sleeps for backoff; the durable `nextAttemptAt` gates later reconciliation. Permission/other permanent errors become `FAILED`; exhausted retries become `EXHAUSTED`. A missing acknowledgement is ambiguous and retryable. The SNS client has `maxAttempts: 1`; only the outbox controls attempts. SNS `Throttled`, `KMSThrottling`, `KMSInternalError`, HTTP 429/5xx and transport timeouts are transient; authorization/invalid-parameter failures are permanent. Payloads must be JSON objects no larger than 65,536 UTF-8 bytes. Topic region/partition/name and exact requested ARN are validated; standard topics omit FIFO fields, FIFO topics use `MessageGroupId: project-budget` and the semantic alert hash as `MessageDeduplicationId`. SNS FIFO deduplication windows do not guarantee recipient exactly-once delivery.

`deliverProject(scope, cursor?, options?)` reads at most ten records and returns a scope-bound continuation key, including when `maxAlerts` stops within a page. Its total default bound is eight seconds. `deliverAlert` lets the runner use an already validated stored record without rereading a page. Both pass abort through claims and publishes. A timeout during a claim or publish can leave `SENDING`; it must not trigger an immediate retry.

The scheduled entry is [budget-runner-runtime.mjs](../infra/serverless-platform/lambda/operations/budget-runner-runtime.mjs), exported `handler`. It is **source only**, with no HTTP route. It constructs existing `createPlatformState`/active-domain directory, `createWorkspaceState.listProjects`/`getProject`, `createJournalUsageProvider`, budget state/evaluator/delivery and runner checkpoint state. It accepts only its configured EventBridge Rule scheduled envelope with empty detail; caller-supplied principal, spend, recipient and directory fields are rejected. The envelope check complements IAM; it is not authentication for someone already allowed to invoke the Lambda.

The runner loads up to 1,000 active domains using the existing authoritative reader (at most 100 DynamoDB domain pages), then visits at most ten one-project directory pages per invocation. It follows empty project pages and stores the current domain/project cursor. Each project gets an authoritative ACTIVE point read. Directory progress commits **before** project work, so a hung project is revisited next sweep without blocking later projects. Each visit evaluates the budget and advances one alert position; the project cursor survives invocations, including across pages of more than ten alerts. Advancing before send means interruption may defer that record until the next sweep, never lose its outbox record. End of either traversal wraps to the beginning, so due retries are revisited. Next-attempt time remains authoritative; the runner never sleeps/retries immediately. Repeated cursor values fail closed.

Bounds: 20 seconds per invocation (or Lambda remaining time minus one second), eight seconds per project, two seconds per evaluation and individual DynamoDB request, six seconds per single delivery including its five-second publish limit, ten projects/directory pages and at most 1,000 DynamoDB commands total. Existing common usage reads also cap journal pages at 100 per query and reject truncated numeric aggregation. Domain inventory above its explicit limit fails unavailable; it is not silently truncated. A hung usage read stays unknown but does not suppress an earlier durable crossing. The runner summary contains status/counts only, never prompts or recipients.

The global checkpoint's conditional 60-second lease serializes runners; each update checks revision, and an expired owner cannot advance. `BUSY` duplicates do no project work. Successful bounded slices release the lease; errors/timeouts leave it until expiry. Alert claims retain the existing config-version fence, revision and 30-second lease. **Activation must use a Lambda hard timeout no greater than 30 seconds** so an old invocation cannot still be running when its alert lease expires. Aborted requests/SDK calls get no hidden retry. The scheduler must disable service retries too. Crashes and provider acceptance before durable acknowledgement can still cause duplicates on later sweeps; do not infer receipt.

States distinguish `UNCONFIGURED`, `PUBLISHER_UNAVAILABLE`, `DESTINATION_MISMATCH`, `PENDING`, `SENDING`, `RETRY`, `FAILED`, `EXHAUSTED`, `SUPERSEDED` and `PROVIDER_ACCEPTED`. `recipientReceipt` remains `UNVERIFIED`.

If a process dies after SNS accepts a message but before acceptance is saved, the lease can expire and a later attempt can publish again. Delivery is at least once **with possible duplicates**, bounded attempts and possible terminal failure. SNS `MessageId` means provider acceptance, never recipient receipt. A runner/publisher that ignores abort can also accept after the local deadline. Destination confirmation and actual recipient-observed delivery are separate evidence.

## Exact deployment-owner handoff

Existing demo deployment/testing authority remains valid. No repeat blanket approval or repeat of accepted budget settings tests is requested. Didi activates a parent-reviewed, published, dependency-complete SHA; no main/prod update is implied.

1. **Parent integrated-source gate:** use the published combined SHA with the existing exact `@aws-sdk/client-sns@3.1116.0` pin and generated lockfile. Restore locked dependencies with ordinary `npm ci`, verify Node 22 and complete historical Git objects, then run the mandatory SNSClient/stub-request-handler tests, full serverless suite, console tests and typecheck. Bundle the configured Operations `handler-runtime.mjs` and separate runner with the SDK included. Do not externally exclude SNS or assume Lambda supplies the intended version. The dependency fix is already committed; do not repeat dependency edits or treat a subset rerun as a full-suite pass.
2. **Didi bundle/entry:** bundle `lambda/operations/budget-runner-runtime.mjs`, export `handler`, Node 22, including the shared modules and pinned SNS/DynamoDB clients. A normal esbuild Lambda artifact may name this `index.handler`. Operations retains `lambda/operations/handler-runtime.mjs` and its three existing JWT budget routes. Add a separate EventBridge **Rule** target for the runner; do not map it through API Gateway, a Function URL, or caller impersonation. Use the default Scheduled Event envelope, empty `detail`, and its exact rule ARN in configuration. Lambda resource permission: `events.amazonaws.com`, exact rule `SourceArn` and account `SourceAccount`. The runner role needs no invoke/model permissions.
3. **Didi scheduling:** recommended rule `rate(1 minute)`, Lambda timeout **30 seconds**, reserved concurrency **1**, EventBridge target `MaximumRetryAttempts: 0`, and Lambda asynchronous invoke `MaximumRetryAttempts: 0`. Disable unbounded replay/redrive. A failed slice relies on durable progress/lease expiry and the next regular schedule. Ten directory pages and one alert per project per sweep trade latency for bounded work; receipt latency depends on backlog and must be measured. Do not shorten the 60-second runner lease or lengthen the hard timeout beyond the 30-second alert lease. No new table/index/TTL is required.
4. Configure the following environment (values come from the reviewed deployment, never placeholders):

| Environment | Default / required meaning |
|---|---|
| `PLATFORM_STATE_TABLE_NAME` | Required existing platform table, shared with current Operations/workspace |
| `OPERATIONS_BUDGET_RUNNER_ENABLED` | Off unless exactly `true`; enable only after dependency/IAM/config readiness |
| `OPERATIONS_BUDGET_SCHEDULE_ARN` | Required when enabled; exact approved EventBridge Rule ARN, standard default-bus rule shape |
| `OPERATIONS_BUDGET_SNS_TOPIC_ARN` | Optional; absent gives `UNCONFIGURED`, no invented destination; same ARN on writer, Operations publisher and runner |
| `OPERATIONS_NATIVE_EXECUTION_VERSION` | Existing `native-v1` reader activation; absent preserves legacy mode, which cannot establish this native-start budget |
| `EXPERIENCE_JOURNAL_WRITE_VERSION` / `EXPERIENCE_JOURNAL_READER_VERSION` | Existing common-reader compatibility; `cost-v1`/`cost-v1` for current accounting; omitted is legacy |
| `OPERATIONS_MODEL_PRICES_JSON` | Existing optional versioned book; reuse reviewed sealed-price-compatible config, no new rate source. Missing book uses common provider defaults; retained usage keeps its sealed price. Runtime must separately have the approved active price interval and compatible readers as in [bedrock-runtime-pricing.md](bedrock-runtime-pricing.md). |

The runner does not require `OPERATIONS_CURSOR_SIGNING_KEY`, `OPERATIONS_BUDGETS_JSON`, JWT credentials or a user identity. It never reads an HTTP principal. Operations' existing HTTP cursor key remains required there. Event timestamps do not supply evaluation time; the server clock does.

5. **Didi exact effective IAM:** authorize the following on the existing table/index, including its permissions boundary. No scans, deletes, broad tables, topic creation or subscription permissions.

| Consumer / resource | Actions and exact key families |
|---|---|
| Runner, existing table ARN | `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:Query`, `dynamodb:ConditionCheckItem`, restricted to `PROJECT_BUDGET#*` (includes `PROJECT_BUDGET#RUNNER` and scoped config/outbox/cursor records). Writes are config-fenced transactions or revision-conditional puts; runner does not call the config writer. |
| Runner, existing table ARN | `dynamodb:Query` on leading key `DOMAIN` and `PROJECT#*`; `dynamodb:GetItem` on `PROJECT#*`, for authoritative directory/status only |
| Runner, existing table ARN | `dynamodb:GetItem` on `NATIVE_EXECUTION_BINDING#*` and `NATIVE_EXECUTION_EVENT#*`; no writes |
| Runner, existing table `/index/EntityTypeIndex` ARN | `dynamodb:Query`, existing journal partition `entityType = EXPERIENCE_INVOCATION`, filtered by the trusted domain/project pair. Use index-leading-key `EXPERIENCE_INVOCATION` if retaining a LeadingKeys condition; do not incorrectly constrain it to the base-table budget prefix. This legacy GSI is eventually consistent. |
| Operations publisher and runner, one confirmed topic ARN | `sns:Publish` only on that exact ARN; no wildcard resource, `CreateTopic`, `Subscribe` or `SetTopicAttributes` |
| Only if that SNS topic uses customer-managed KMS | Applicable key policy plus `kms:GenerateDataKey*` and `kms:Decrypt` on the exact key ARN, limited to SNS via the regional service and the topic encryption context where supported; verify actual topic/key configuration before granting |

`TransactWriteItems` is an API operation; IAM authorizes constituent PutItem/ConditionCheckItem actions. Operations budget IAM/routes and UI acceptance already exist; this adds the publisher permission and separate scheduled consumer. Preserve didi's stack/tests/boundary ownership and Runtime config boundaries.

6. **Didi destination/evidence:** confirm the actual topic ARN, topic type, protocol, owner, permitted message scope, confirmed subscription and recipient, and topic/KMS policy. Do not create a topic, subscribe anyone or use a placeholder because configuration is absent. Existing budget versions pin the destination: if it was null or changes, use an authorized new budget version and re-evaluate; old records are not rerouted. This recipient fact remains missing; the implementation does not choose it.
7. Bind source SHA/tree to artifacts and effective configuration; read back the schedule and narrow permissions. Use only the already authorized bounded Runtime pilot (at most three agents, six short calls, 128 output tokens/call, model estimate at most USD 1, synthetic prompts; didi executes). Retain actual usage/threshold crossing, semantic alert/version/window, attempt and SNS MessageId, then separate recipient-observed receipt. An injected test, `PROVIDER_ACCEPTED`, or a lowered limit crossing old spend does not prove a new live consumption crossing. Tool Policy denial/throttling and temporal allowance remain separate Arc 4 evidence.

## Review and verification boundaries

Synthetic tests exercise calendar/equality boundaries, real common-provider occurrence selection and duplicate rejection, incomplete/stale prices/usage, conditional config replay/conflicts, atomic outbox and crash recovery, concurrency/leases, bounded retries/timeouts, destination/version changes, JWT/project authorization and MessageId-versus-receipt semantics. The DynamoDB command model is synthetic, not a real DynamoDB integration test.

| Well-Architected pillar | This delta |
|---|---|
| Security | Reuses projected identity and authoritative project lookup; explicit admin/lead scope; rejects forged body fields; immutable destination and narrow same-table/IAM handoff. |
| Reliability | Atomic crossing/outbox and config replay, revision-fenced leases, bounded retries; crash-after-acceptance duplicates, continuation and deadline/lease behavior explicit. |
| Operational excellence | Versioned config and retained provenance/audit fields; observable delivery states; final-SHA test evidence external; no live-proof claim. |
| Performance efficiency | At most two common usage queries, existing bounded journal paging, 10-record delivery pages and bounded provider calls; bounded runner progresses across invocations. |
| Cost optimization | No inference/notification/cloud actions during implementation; partial estimates and actual-run denominator; no hard-dollar enforcement claim. |
| Sustainability | Reuses existing table and journal; no new data store; one pinned SDK package, bounded scheduled work rather than unbounded polling. |
