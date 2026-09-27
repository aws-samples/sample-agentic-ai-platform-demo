# Direct Bedrock Runtime Haiku settlement

This source slice can settle measured synchronous Converse usage for the selected
Haiku **global** profile from `us-west-2`. Nothing is activated or deployed.
It uses no Gateway route attestation, Mantle endpoint or direct Anthropic rate.
Astra remains usable only through the existing explicit Runtime model allowlist
and remains **unpriced**. Other unsupported models still reject without fallback.

## Evidence and exact applicability

The public AWS `AmazonBedrockFoundationModels` catalog was independently
retrieved on 2026-09-11 at `02:57:42.490781Z`. Stored ISO timestamps use
millisecond precision (`02:57:42.490Z`). Source:

https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-west-2/index.json

Version `20260901183649`, published `2026-09-01T18:36:49Z`, OnDemand terms
effective `2026-08-01T00:00:00Z`, USD per **1M tokens**, range 0–Inf.
Catalog SHA256:
`2408c8b69b89853fa215e33385c51d6f0f6aae57256da59d56cfb70e97dc7536`.
The `current` URL is mutable; the version and retained digest identify the
reviewed evidence. Settlement performs no network lookup.

| Global standard / on-demand dimension | USD / million | SKU |
| --- | ---: | --- |
| Uncached input | 1.00 | `4JSTB8J9NP4VP73F` |
| Output, including billed reasoning | 5.00 | `JRZBRVPV4WU854WK` |
| Cache read | 0.10 | `JWC87WDBUGJS96NF` |
| Cache write 5m | 1.25 | `73F7XT6NJRHUGT6P` |
| Cache write 1h | 2.00 | `68HWT9R4XYRCD8UE` |

Each rate code appends `.4799GE89SK.6YS6EN2CT7`. The 5m write meaning is
corroborated by the AWS pricing page's backing map, manifest
`plc-bedrockfoundationmodels-usd-20260901183649`; its URL and SHA256 are sealed
in each selected entry. Geographic/regional, batch, priority, flex, reserved
and latency-optimized dimensions are not interchangeable with these rates.

The AWS SYSTEM_DEFINED profile metadata observed 2026-09-11 binds
`global.anthropic.claude-haiku-4-5-20251001-v1:0` to
`anthropic.claude-haiku-4-5-20251001-v1:0`. Its saved snapshot digest is
`c30ee7430bf614737f7ac05b7bfd06b5d1edda229ff2ea1df5d21453612c728d`.
The adapter's explicit platform alias maps to that exact profile. It records
both requested platform identity and profile, source endpoint/API/region,
foundation-model **pricing identity**, global mode, on-demand capacity,
`serviceTier: {type: "default"}` and `performanceConfig: {latency: "standard"}`.
The latter fields are explicitly serialized by the installed AWS SDK.
The SDK's `ServiceTierType` calls standard `default`, not `standard`.
AWS's saved [Haiku service-tier explanation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html#model-card-anthropic-claude-haiku-4-5-tiers)
describes default as standard pay-per-token. The model-card URL/digest are also
sealed in the entry. Reserved account commitments still require rollout review.

Converse does not require a returned model ID. `providerModelId` remains null,
separate from the request/profile pricing identity. Optional returned tier and
latency settings are retained separately; conflicting or malformed selectors
cannot use this rate. Neither Oregon pricing location nor source endpoint
claims to identify the Region that actually served a global request.

## Converse accounting basis

The saved official [Converse prompt-caching documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html#prompt-caching-converse)
explicitly says:

> When prompt caching is enabled, the `inputTokens` field represents only the
> non-cached input tokens (tokens that were not read from or written to the cache).
> `total input tokens = inputTokens + cacheReadInputTokens + cacheWriteInputTokens`

This is the Converse basis, not an assumption copied from native Messages.
The saved public fetch digest is
`6611ac3dec8da66c1e66994d1e9342faaa5621b765fb494275d580e21d5798e1`.
It also documents implicit caching for Anthropic models. The adapter requests
no explicit checkpoints; that does **not** establish zero caching or warrant
inference-only pricing when counters are omitted.

Both read and write counters must be measured. Positive writes require an
exact `cacheDetails` TTL partition. A valid partition may contain only one TTL;
its sum must equal all written tokens, establishing zero for the other TTL.
Contradictory/invalid supplied details invalidate the write basis. Missing TTL
details are sufficient only with a measured zero write counter. Missing rates
are tolerated only for measured zero quantities. No absent counter becomes zero.

Normalized `usage.inputTokens` retains uncached input, `usage.outputTokens`
retains the entire provider output counter, and their sum preserves the
existing usage contract. The original provider total is retained separately;
the parser accepts its established base-only or cache-inclusive forms.
Cache counters are not subtracted again from uncached input. Reasoning blocks
are not persisted or displayed, but their billed output consumption remains
in the output counter. Output validation, including an over-cap response,
happens after usage capture; measured cost survives that failure.

Example: 12 input, 3 output, 40 cache read, 10 write at 5m and 50 at 1h costs
`(12×1 + 3×5 + 40×0.10 + 10×1.25 + 50×2) / 1,000,000 = $0.0001435`.

## Price book and immutable journal

[bedrock-runtime-prices.example.json](bedrock-runtime-prices.example.json) is
a **candidate** version 3 book, never loaded by the stack. Its one-day window
is a proposed demo applicability interval, not an AWS historical expiry.
An approved rollout must select the actual bounded interval, after evidence
retrieval, and explicitly activate the entry on Runtime via
`OPERATIONS_MODEL_PRICES_JSON`. Putting it only on Operations cannot price runs.
An alias entry and an exact-profile entry are different requested identities;
configure the actual selected identity. Missing or inactive entries, missing
dimensions, mismatched identities, unsupported routes and out-of-interval usage
all leave the estimate null.

Version 3 validation accepts only the reviewed AWS snapshot and its exact rates
(or explicit null rates), source, mode, currency and request binding. It rejects
overlapping intervals for the same identity. A later AWS rate revision requires
new evidence and an additive validator; preserve support for retained revisions.

New `bedrock-converse-v2` observations use companion usage **version 3**.
`route` and native-body `metering` remain null. Each event seals the selected
entry, all rate/provenance fields, charged quantities, settlement reason, amount,
source/version and full book revision at actual usage observation time.
Replay verifies the stored entry/calculation, without consulting today's book.
Duplicate delivery retains the first event even after the interval expires or
prices are removed. Changed usage conflicts. No automatic backfill/repricing.
Operations exposes the retained source/version/date through its existing API;
the full settlement remains in the native event.

Starts and usage use their own timestamps in the same half-open UTC scope/window.
Failures after start still count; unknown is not zero. Two distinct logical
agents can share Runtime and accrue separate project usage. Domain/platform
aggregation counts each event once. Runtime, Builder test calls, tools, memory,
evaluation, shared and other infrastructure charges remain unallocated/excluded.
The existing UI therefore labels model-only coverage partial even when every
observed model call is priced.

## Rollout and retained-record matrix

All existing activation defaults remain off. Upgrade compatible readers before
attesting `RUNTIME_CONVERSE_READER_VERSION=converse-v2` and enabling the existing
native flags. Old `converse-v1` attestation rejects the new writer. The server
also rejects any Gateway route configuration for direct inference.

| Retained usage | New reader | Original d2aa8ca reader |
| --- | --- | --- |
| v1 native Gateway | Supported; sealed price retained | Supported |
| v2 original Converse | Supported; stays unpriced | Supported |
| v3 direct settlement (priced or unpriced) | Supported | Rejects, including with writers disabled |

Tests load actual pinned original writer/provider/reader source, plus older
invocation-row readers. No invocation-row migration or deletion is required.
Rollback must stop and drain writers while retaining compatible readers and
records. Turning off writes does not make v3 readable by old binaries.

Still required: independent review of the final SHA, approved artifact/IAM/config
rollout with digest verification, account entitlement and effective tier, two
actual Builder projects with distinct authorized deployed logical agents,
separately authorized paid runs with returned usage/cost/trace linkage, and
budget notification delivery. No live acceptance or all-OpenAI pricing completion
is claimed. Astra's exact Runtime cache and context-dependent pricing dimensions
remain outside this slice.
