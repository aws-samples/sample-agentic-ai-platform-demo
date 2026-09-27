# Bounded Bedrock Runtime inference

The configured shared AgentCore Runtime and Builder test factories use synchronous
Amazon Bedrock Runtime **Converse**. Agent hosting remains AgentCore Runtime.
They require explicit configuration and fail closed without it. There is no
Gateway inference, Mantle or external OpenAI fallback in these factories.
Deploying their code alone into an environment with only the old Gateway
settings will fail; configuration and reader rollout require separate approval.

## Selected model compatibility

The bounded adapter allows only the following server-selected identities, in
`us-west-2`. Domain access is an additional required server allowlist. This is
not proof of account entitlement or permission to perform a paid invocation.

| Platform model ID | Exact Runtime target |
| --- | --- |
| `bedrock-claude/anthropic.claude-haiku-4-5` | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Same |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Same |
| `global.openai.gpt-6-astra` | Same |
| `us.openai.gpt-6-astra` | Same |

AWS's [Haiku card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html)
and [Astra card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html)
document Converse support. Astra does not support InvokeModel.
[GPT-5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-55.html)
does not support the Runtime endpoint and is rejected without substitution.
The parent observed ACTIVE exact Haiku/Astra profiles on 2026-09-11.
Other catalog models, including GPT-5.6, require separate API/usage verification
and explicit allowlist changes; the regional metadata alone is insufficient.

## Configuration, initially absent

The following is a reviewable example, not activated settings:

```json
{
  "MODEL_INFERENCE_ROUTE": "bedrock-runtime-converse-v1",
  "BEDROCK_RUNTIME_REGION": "us-west-2",
  "BEDROCK_RUNTIME_MODELS_JSON": "[{\"modelId\":\"bedrock-claude/anthropic.claude-haiku-4-5\",\"domains\":[\"customer_support\",\"operations\"]}]"
}
```

Use the same selected-model configuration in the shared Runtime and Builder.
Keep the existing selected Haiku model identity. Astra is independently
selectable, never a replacement for another model. The endpoint cannot be
configured: SDK signing/serialization targets only
`https://bedrock-runtime.us-west-2.amazonaws.com/model/{encoded-profile}/converse`
with signing service `bedrock`. Transport rechecks host/path, rejects redirects,
limits the serialized request to 32 KiB and response to 256 KiB, and uses
`maxAttempts: 1`. Timeout defaults to ten seconds; external abort covers
credentials and transport. No streaming API or native InvokeModel body is added.

The selected provider route rejects requests above **128** output tokens.
For Experience, configure the existing exact domain/project/agent
`EXPERIENCE_OUTPUT_CAPS_JSON` with ceiling128 and persist a valid target128.
The existing factory signs that resulting cap; Runtime verifies the signature
and provider allowlist before nonce consumption and journal start.
Builder tests must explicitly submit `maxTokens: 128` or lower. A client cannot
raise the limit. Other existing callers of the shared Runtime, such as the
Design Assistant using a larger default, fail closed until separately adapted.

## Usage, pricing and retained records

Converse `TokenUsage` has its own fields: `inputTokens`, `outputTokens`,
`totalTokens`, optional `cacheReadInputTokens`, `cacheWriteInputTokens`, and
`cacheDetails: [{ttl, inputTokens}]`. The installed AWS SDK 3.1116.0 documents
the latter as cache-write TTL detail (5m/1h). Native Messages `cache_creation`
and OpenAI `prompt_tokens_details` are not parsed here.

New native Converse usage events use **version 3** with protocol
`bedrock-converse-v2`; retained version 2 / `bedrock-converse-v1` events remain
readable and unpriced. The existing attempt key `gateway-1` remains an opaque
deduplication key for compatibility; it is not a route assertion.
The observation retains:

- Normalized input/output and their sum under the existing usage contract.
- The provider's original total separately, including a cache-inclusive total
  when it equals the measured input/output/cache sum.
- Exact requested profile, source region, endpoint/API and HTTP request ID.
  `providerModelId` is null: Converse need not return a model field.
- Claude's uncached input basis and the measured cache categories. Astra's
  input/cache billing basis is explicitly unknown; Mantle caching features
  do not establish Runtime cache semantics.
- Only valid explicit TTL breakdowns; absent, invalid or inconsistent cache
  fields stay null. No missing quantity becomes zero.

Usage capture occurs after bounded JSON parsing, before SDK output
deserialization or answer validation. A malformed answer can therefore retain
measured usage. Missing base usage stays unknown. No raw prompt, response,
reasoning block or credential is persisted in accounting.

Direct events have `route: null` and `metering: null` for the old native-body
format. The separate `runtime` observation binds actual request/profile metadata,
explicit default service tier and standard performance latency. The optional
version 3 [direct price book](bedrock-runtime-pricing.md) can seal measured Haiku
global model costs with versioned AWS catalog evidence. No rates are enabled
by default; Astra and unsupported pricing routes stay unpriced.
`RUNTIME_USAGE_ROUTE_JSON` containing a Gateway attestation is rejected.
Existing v1/v2 price books remain compatible for old records and cannot price
direct events. New records retain the complete selected rate entry and quantities;
Operations cannot reprice them.

Upgrade Operations/native companion readers **before** setting
`RUNTIME_CONVERSE_READER_VERSION=converse-v2` alongside the existing
`RUNTIME_NATIVE_EXECUTION_VERSION=native-v1`. That value is an operator
attestation after verifying reader artifacts, not automatic proof of deployment.
Runtime rejects native startup without it; the journal writer also rejects
Converse observations without it. Experience's existing native flag and
Operations' cost-reader flags retain their existing meanings.

New readers accept v1, v2 and v3 events. The original d2aa8ca reader rejects
retained v3; the pre-Converse reader also rejects v2.
Turning writers off does **not** make those records readable by an old
native reader. Stop and drain writers while retaining compatible readers and
stored events; do not roll back native readers or delete records to avoid the
gate. Legacy invocation rows are unchanged. Tests exercise these combinations
using the actual base reader, not a simulated old implementation.

## IAM and enforcement

Optional CDK context `bedrockRuntimeProfileIds` accepts a JSON array of the exact
profiles above. It defaults absent. It adds `bedrock:InvokeModel` only to the
Runtime and Builder roles, using each exact selected profile ARN and the
foundation-model ARNs from the saved SYSTEM_DEFINED metadata. It adds no
InvokeModelWithResponseStream, wildcard provider, or tool Gateway permission.

The existing shared boundary is too close to IAM's 6,144-byte limit to append
these resources. The opt-in creates one retained
`AgenticPlatform-Web-BedrockConsumerBoundary` for only these two roles. It
filters the existing boundary to their required actions, preserves existing
resource/condition ceilings, and adds the exact model statement separately.
The shared boundary remains unchanged. Synthesis checks role separation,
required actions, exact resources and the optional boundary size.
Its introduction/role attachments require separate owner IAM approval.

Preserved: authenticated platform domain/project/agent authorization, signed
scope/model/cap, durable nonce replay prevention, actual Runtime start
denominator, measured failures, unknown outcomes and immutable deduplication.
Direct credentials belong to the Runtime/Builder execution role. The previous
Gateway STS source identity is not propagated as AWS principal identity; the
validated domain is request metadata and journal scope remains proof-bound.

**Lost for direct model requests:** native Gateway/arc4 model token quotas and
Gateway model-route policy enforcement. Platform allowlists and cap128 are
application/provider controls, not native Gateway quotas. No new provider
guardrail configuration is asserted. Native Policy remains a tool-layer demo.
Gateway inventory/tool clients, policies and architecture are retained.

## Scope and later deployment

The bounded source slice changes the shared Runtime, Builder model test route,
native companion reader and opt-in IAM definitions. No frontend is integrated
or replaced. Older local console/model-discovery paths and generated
blueprint/example `mantle_compat.py` modules remain nonselected legacy paths;
this is not repository-wide removal or certification. The older catalog
descriptions and prices are not authority for the selected hosted route.

Later approved rollout requires compatible Operations reader code, Runtime and
Builder bundles, the optional exact IAM policy/boundary slice, explicit route
and cap settings, and then native writer activation. Preserve existing
environment maps. Verify actual artifact digests/version bindings and account
entitlement before separately authorized paid acceptance. No cloud state,
configuration, prices, policy, model call or publication was changed here.
