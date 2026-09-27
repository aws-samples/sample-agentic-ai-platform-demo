# Governed blueprint reuse: generated arithmetic Gateway path

This source slice connects a resolver-approved TOOL selection to an executable
Strands wrapper in a generated chatagent repository. It does not wire the hosted
synchronous model-only service to tools. Actual didi owns Runtime application
wiring, deployment, identity/IAM configuration and live evidence. Parent owns
review and publication. No cloud requests, credentials, models or actual tool
executions were used to implement or test this slice.

## Trust boundary and supported contract

The existing `createFullBuildSnapshotResolver` remains unchanged. It checks
approved default versions, the selected blueprint, model availability and active
cross-domain grants. The snapshot retains resource registry/record/version and
blueprint references. The new `resource-binding.mjs` contract copies only
validated `content.gatewayBinding`; unrelated metadata is discarded. Malformed
provided binding metadata rejects export rather than silently becoming runnable.
Existing publication decisions and requester-versus-approver checks are unchanged.

Version 1 supports **one TOOL with `toolType: "agentcore_gateway"`, chatagent,
authenticated Runtime access, and one harmless arithmetic operation**. Required
Gateway fields are:

| Field | Required value or constraint |
|---|---|
| `schemaVersion`, `operation` | `1`, `add_numbers` |
| `gatewayArn`, `region`, `endpoint` | Exact matching commercial AWS Gateway ARN and HTTPS `/mcp` endpoint; no credentials, query, fragment, custom port or wildcard |
| `targetId`, `targetName`, `qualifiedToolName` | Reviewed native target; actual tools/list name equal to `targetName___add_numbers` |
| `protocolVersion` | `2026-07-28`; Gateway's supportedVersions must include it |
| `auth` | `AWS_IAM`; tool authentication is independent of Bedrock model inference |
| `policy` | Exact `engineArn`, `policyId`, `definitionSha256`, `enforcementMode: "ENFORCE"` |

`definitionSha256` is a digest of the independently reviewed policy definition,
not an invented AWS version field. Didi must also retain the service's actual
revision/update identity and effective configuration in live evidence. Shape
validation does not prove a Gateway, target or policy exists or is deployed.
No real values are shipped by this change; test names are explicitly fixtures.

The current Registry parser does not project new governed `CUSTOM` TOOL records:
that branch supports blueprints. It also does not preserve `gatewayBinding` in
the legacy Skill tool projection. **This slice does not fix that reserved
parser.** Existing approved Skill entries with a toolType remain resolvable as
TOOL selections. For those and other legacy Gateway selections the exporter
creates a **required reviewed deployment file** with `gateway: null`, pinned to
the exact selected resource and blueprint identities/version and agent scope.
Tests cover the actual legacy parser projection into the unchanged resolver.
A new governance TOOL publication is not claimed to work end to end.

The operator can complete that null binding only through review of the generated
repository's `app/chat_agent/gateway-deployment.json`. Invocation payloads cannot
provide a tool name, endpoint, version, headers, principal or policy session.
Changing a pinned selection fails; an approved concrete Gateway contract, when
available to the resolver, cannot be substituted by that file. The fallback's
deployment file is trusted code/configuration, not a new platform approval API:
review is an external prerequisite, not a self-attested `approved: true` flag.
An exported repository owner can edit code; source hashes are not a signature
or a defense against that owner. Exported snapshots do not enforce future
platform grant revocation; native IAM and Policy remain authoritative.

## Generated files and executable behavior

- `app/chat_agent/main.py` imports and registers `build_governed_tools()`.
  Generation replaces the unconditional local addition tool and removes the
  generic MCP client module. Blueprint source and template assets remain intact.
- `app/chat_agent/governed_gateway.py` exposes `approved_add_numbers(a, b)` through
  the Strands decorator. Both values must be integers in `[-1000,1000]` (not bool).
  It POSTs exactly one JSON-RPC `tools/call` to the configured Gateway, with a
  fresh request ID, matching protocol header and `_meta`, `Mcp-Method` and
  `Mcp-Name`. It performs no initialization handshake for this stateless version.
- The response must match the request ID and contain one text block with the
  actual integer sum. There is no local-success fallback. Missing configuration
  returns an explicit error before credential acquisition or transport.
- Botocore `Session` default credentials and `SigV4Auth` are loaded on invocation.
  No network or credential acquisition occurs at module import. The signer uses
  service `bedrock-agentcore` and the pinned region. Sensitive botocore signer
  DEBUG logging is disabled. No prompts, arguments, responses, headers or raw
  exception text are included in the new evidence events.
- Direct HTTPS has no redirects, proxy/environment URL override or retry.
  Response bodies are capped at 65,536 bytes with a five-second socket timeout
  and monotonic body deadline. OS DNS and SDK credential-provider resolution still need host-level
  limits; there is no claim of a hard whole-process deadline.
- `gates/check-resource-bindings.mjs` retains the established CI entry path and
  invokes `check-governed-tool.mjs`. It validates scope, selected version, pinned
  binding and other unresolved resources, and writes
  `artifacts/governed-binding-check.json`. A failed rerun removes stale evidence.
  Configuration PASS still has `liveGateway` and `nativePolicyEvidence` UNVERIFIED.
- Generated CDK `lib/cdk-stack.ts` invokes `governed-gateway.ts` for offline
  validation and outputs the binding digest, Gateway ARN, qualified tool and
  `UNVERIFIED` live status. It creates no IAM grant, Gateway, target or Policy.
  `agentcore/aws-targets.json` stays empty.
- Existing tests/compliance/eval/deploy/promote workflow paths remain. Generated
  `tests/test_governed_tool.py` uses offline transport fixtures. The existing eval
  runner writes `eval-scorecard.md` and fails without recorded transcripts.
  No offline assertion score is offered as model quality or native Policy proof.
  This governed export clears the inherited CI telemetry bucket destination to
  null; configure a reviewed project destination before any CI upload. Runtime
  trace and cost provenance are unchanged. Its generic test runner excludes
  compiled `dist` files so CDK's emitted Jest tests are not run as Node tests;
  CDK tests retain their dedicated `npm test` command.

## Response evidence is not native enforcement evidence

`governed_gateway.evidence` emits a selection digest, configured-binding digest,
domain/project/agent, local request ID, bounded provider request ID and category.
Existing Runtime trace/cost provenance and model transport are unchanged.

| Category | What it establishes |
|---|---|
| `GATEWAY_SUCCESS` | The wrapper received a correlated, valid arithmetic result |
| `POLICY_DENIAL_SHAPED` | HTTP 200 JSON-RPC result.isError plus the documented denial text prefix |
| `AUTHORIZATION_ERROR` | HTTP 401/403; not automatically native Policy |
| `CONFLICT` | HTTP 409; not automatically a policy-update/session invalidation |
| `RPC_ERROR`, `TOOL_ERROR`, `PROTOCOL_ERROR` | Failure at that response layer |
| `TRANSPORT_ERROR`, `HTTP_ERROR`, `UNCONFIGURED` | Transport/status/configuration failure |

Every response event says `nativePolicyEvidence: "UNVERIFIED"` and
`principalEvidence: "UNVERIFIED"`. Even a genuine native response shape is not
independently correlated Policy evidence. Synthetic test events are fixtures.
No trusted temporal session is invented; temporal limits are outside v1.

## Didi's next exact development actions

1. Review the parent's published fixed commit/tree and actual generated files.
   Preserve the accepted Arc3 first Runtime 200/SUCCEEDED call and closed budget
   work. Do not recreate them to validate this source slice.
2. Use existing independently approved catalog selection and active project/domain
   grants. Coordinate the reserved Registry projection gap with its owner if a
   new TOOL publication is required; do not relabel direct Gateway discovery or
   an invented principal as human publication approval.
3. In a reviewed generated repository, fill a null deployment binding with the
   real Gateway endpoint/ARN, native target ID/name, exact tools/list qualified
   name and arithmetic schema/output. Confirm the target has no side effects.
   Verify Gateway `supportedVersions` includes `2026-07-28`. Older initialized
   MCP versions are deliberately unsupported by this v1 path.
4. Independently verify effective Runtime execution principal, default credential
   provider, exact Gateway `InvokeGateway` authorization and IAM authorizer.
   Keep Runtime inbound authorization enabled. Verify Bedrock inference grants
   separately. This code neither creates nor changes IAM.
5. Verify the attached Policy engine, actual policy definition/revision and
   `ENFORCE` mode. Check the official Gateway IAM SigV4 documentation before live
   activation: the writer's documentation tool was blocked by the session's
   approval policy. Botocore 1.43.92 source confirms the signing API and service
   signing name, but no successful Gateway IAM exchange was observed.
6. Run the generated configuration, offline test and CDK build checks, then perform
   the separately authorized dev deployment/application wiring. The hosted
   synchronous model-only route remains unchanged; selecting a catalog tool
   there still does not prove it ran.
7. Within the existing bounded pilot, retain one allowed arithmetic call and one
   Policy-denied call. Correlate JSON-RPC/provider request IDs, native logs,
   effective principal, Gateway/target, actual policy/revision/definition digest,
   decision and no target side effect. A 403 or denial text alone remains
   unverified. Do not claim temporal/session allowance behavior from these calls.
8. Reuse the same approved blueprint/version for a real second project with its
   own identity, authorization, configuration and deployment. Offline fixture
   separation proves generation behavior only. Retain repository SHA/artifact,
   actual CI run, deployment and per-project execution evidence. Hosted CI/run
   correlation is still a separate application gap.

## Verification and remaining acceptance

Focused Node tests exercise the existing resolver's approval/grant/version
checks, strict metadata, deterministic generation, two project configurations,
materialized Python compilation/import with dependency doubles, invocation of
the selected wrapper, transport limits, denial classification and gate failures.
The existing independent-approver regression is reused; no principal is created.
The implementation handoff records exact final committed-tree commands, exits,
Node binary hash, Python/dependency versions, full fixture files and CDK outputs.
It is not a claim that the entire repository test suite ran.

The new wrapper has no dependency additions. Generated blueprint dependency
ranges and unpinned CI actions/CLI installation are inherited weaknesses; the
verification dependency tree is recorded separately from a reproducible package
lock claim. A real installed Strands/AgentCore runtime import remains a distinct
check from dependency-double imports where those packages are unavailable.

| Well-Architected pillar | State for this source slice |
|---|---|
| Security | SOURCE VALIDATED: strict selected surface, independent approval preserved, IAM signer, no secret payload logging. LIVE UNVERIFIED: principal/grants/Policy, target provenance, repository review and later revocation. Legacy parser integration remains limited. |
| Reliability | SOURCE VALIDATED: fail closed, no retries/redirects, finite response handling. LIVE UNVERIFIED: provider/DNS limits, native failures, target availability. |
| Operational excellence | SOURCE VALIDATED: pinned selection, generated gate/CDK outputs and safe correlation hook. LIVE MISSING: native correlation, hosted CI/deployment ingestion and Runtime wiring. |
| Performance efficiency | SOURCE BOUNDED: small integer arguments, one HTTP call, bounded response. LIVE UNMEASURED: end-to-end latency and capacity. |
| Cost optimization | SOURCE LIMITED: offline verification makes no paid calls; model/cost attribution unchanged. LIVE MISSING: real per-project usage and total tool/runtime cost. |
| Sustainability | SOURCE REUSE: one unchanged blueprint baseline with isolated generated configuration; no new infrastructure or polling. LIVE UNMEASURED: resource efficiency of actual deployments. |

## Factual references

These are AWS documentation references supplied in the September 11 parent
handoff, not successful documentation fetches by this writer:

- [Gateway MCP versions and sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using.html)
- [Exact tools/call wire contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-call.html)
- [Gateway authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-auth.html)
- [Gateway with Policy and denial example](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/use-gateway-with-policy.html)
- [Policy errors](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-use-errors.html)
- [Policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html)
- [Supported Gateway targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-supported-targets.html)
