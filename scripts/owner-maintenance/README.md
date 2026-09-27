# Legacy Gateway owner: offline exact-profile read candidate

This maintenance tool is separate from every CDK app/deploy entrypoint. It does not restore the historical stack, import/adopt resources, modify the replacement ControlPlane stack, or change Builder/agentRuntime roles. It contains no AWS SDK, network client, credential loading, deployment command, execution flag, or elevated fallback.

## Fixed scope

Owner: `PlatformRegistryStack`, region `us-west-2`, commercial AWS partition.
Role: `GatewayRole0A0569CA`. Inline policy resource/name: `GatewayRoleDefaultPolicyF4BF688C`.
Both `LlmGateway` and `ToolsGateway` must reference that role.
The sole permitted addition is `ReadGlobalAstraInferenceProfile`, Allow `bedrock:GetInferenceProfile`, on the exact account's `inference-profile/global.openai.gpt-6-astra` ARN. No action/target configuration knobs exist.

**The role is shared: Tools Gateway receives this exact profile-read permission too. It is not LLM-exclusive.** Existing permissions (including broad legacy permissions), role/trust, attachments, other resources, outputs and template metadata remain structurally unchanged. JSON formatting is regenerated, not byte-for-byte preserved.

This closes a source-maintenance gap only. Prior identity-only `implicitDeny` establishes a permission gap, not the cause of the historical Chat 401. Neither tests nor candidate generation establish live drift absence, service acceptance, or successful Runtime inference.

## Reproduce offline, using synthetic data only

From the product repository root:

```sh
npm run owner-maintenance:test
# The following paths must be new; never use a deployed template here.
node scripts/owner-maintenance/synthetic-fixture.mjs > /tmp/synthetic-owner-input.json
node scripts/owner-maintenance/gateway-profile-read.mjs \
  --input /tmp/synthetic-owner-input.json \
  --output-dir /tmp/synthetic-owner-candidate
```

The generated fixture is deliberately minimal and is **never a deployment template**. It contains synthetic account/role data only. The output directory must not exist; it is created with mode 0700 and files with mode 0600. Validated results only are written. Failure before output creation leaves no candidate; filesystem failure during writing may leave a partial directory, which is not a successful result. The tool never overwrites previous output or logs an input document/ARN. Output is exactly `candidate-template.json` and `delta-manifest.json`; the manifest has hashes, not raw physical identifiers.

For an owner who already has approved in-memory snapshots, import `prepareCandidate()` and pass the bundle directly. It returns objects and does not persist inputs or outputs. **This implementation batch did not retrieve, persist, or run against live templates/policies.** Do not persist sensitive live snapshots just to exercise the CLI.

## Input contract and trust boundary

The bundle has exactly these top-level keys:

- `owner`: independently owner-read `stackId`, fixed `roleLogicalId` and `policyLogicalId`, physical `rolePhysicalId`, full unchanged template `roleResource`, and `gateways` mapping the two fixed logical Gateway IDs to their actual execution role ARNs.
- `template`: full original CloudFormation template supplied by the owner, not a newly synthesized replacement stack or a minimal extracted template for deployment.
- `actualPolicy`: actual inline-policy response projection `{RoleName, PolicyName, PolicyDocument}`. Its role/name must match the owner and fixed policy. `PolicyDocument` is a decoded JSON object, not URL-encoded text.
- `profileArn`: exact already-verified Global Astra profile ARN in that stack's account and `us-west-2`.
- `proposedStatement`: the exact statement shown in `gateway-profile-read.mjs`, matching the existing `gateway-role-owner-patch/proposed-statement.json`.

The tool checks internal consistency of **trusted owner-supplied** snapshots; it cannot authenticate a hand-edited snapshot, prove its freshness, or discover a role replacement performed before the supplied snapshot. The independent `owner.roleResource` pin rejects a different role/trust in the template. Full AWS ownership verification already exists in the owner report; this tool deliberately does not repeat it.

Template policy is resolved only for known account/region/partition `Ref`, simple `Fn::Sub`, and `Fn::Join`, then compared against the actual policy. All other intrinsics fail closed. Statement order, array order, scalar-versus-array differences and Sid differences also fail closed even when IAM might regard them as equivalent. Unknown expressions or legitimate drift require owner review, not a bypass flag. Missing bindings, extra Gateway scope, alternate policy targets, wrong profile/account/region, wildcard proposals, extra actions and altered role/trust are rejected.

A single exact existing statement in BOTH template and actual policy returns `ALREADY_APPLIED` with no changes. Actual-only presence is drift, not permission to reconcile the template automatically. Duplicate grants, duplicate Sid, or conflicting Sid are rejected. The tool appends only after all validations and checks a full-template reversible delta.

## Source provenance

Historical owning construct: product revision `8bf70bc6649b62e18875394a4f0eb9a9ed3ae21e`, `infra/platform-registry/lib/platform-registry-stack.ts:218–281`. The existing `historical-owner-minimal.patch` adds the same Sid/action and partition/account expression immediately after its original role policy. It is review provenance, **not a patch to apply to the current replacement-stack source**.

Historical owner/runtime reports are available through `docs/history/README.md`. Recheck current source, target identity and permissions before using maintenance tooling.

## Separate authorization gates

1. Review this source and explicitly accept the shared LLM/Tools role impact.
2. Separately authorize the owner to refresh read-only snapshots, pass them in memory to this tool, and prepare a **non-executed CloudFormation change set for the existing PlatformRegistryStack only**. Confirm the full candidate hash and that the only change is a non-replacement Modify of `GatewayRoleDefaultPolicyF4BF688C`; all role/trust and other resources must remain unchanged. IAM capability acknowledgement, owner identity, stack ID, baseline freshness and rollback constraints belong to that review. This tool has no create-change-set operation.
3. Separately authorize execution only after that real change-set review, fresh drift checks and shared-role acceptance. Do not execute a stale candidate or roll back over later out-of-band changes.
4. Permission verification, target creation and bounded inference are independent later gates. Keep inference.provider with bare `GATEWAY_IAM_ROLE`; never retry explicit `iamCredentialProvider`, broaden Invoke permissions, bypass Gateway or switch to Mantle fallback.

A passing offline test does not grant any of these authorizations.

## Review dimensions

- Security: exact new action/resource; strict owner/policy checks; shared-role blast radius disclosed. Existing broad grants are preserved, not remediated or endorsed.
- Reliability: deterministic candidate and before/after hashes; strict drift rejection; live acceptance remains untested.
- Operational excellence: independent offline command, reproducible tests and manifest; no implicit deployment coupling.
- Performance: bounded local JSON work; no cloud performance claim.
- Cost: no infrastructure or model calls.
- Sustainability: reuses the existing role and offline tooling; no new persistent cloud resources.
