# Governance policy controls

The Policies tab separates resource allocation, agent actions and human decisions.
Platform administrators see shared Gateway configuration plus the approval catalog
for the active domain. Domain reviewers use the scoped Approval requests inbox.
A policy declaration, an AWS binding, an observed decision and a deployment approval
are separate evidence; none implies the others.

| Control | Configuration / evidence | Scope and enforcement |
| --- | --- | --- |
| Registry publication and resource access | AI Registry, Domains, project resource policy, approval records | Platform ceiling → domain allocation → project subset, checked by hosted APIs |
| AgentCore Policy | Actual Gateway attachment, Policy Engine status, native policy definitions | Gateway tool calls; caller identity, tool/action, resource and arguments |
| Bedrock Guardrails | Guardrail configuration and actual runtime binding | Content controls where attached; a blueprint flag is only a declaration |
| Human approval | Request, eligible reviewer, decision and audit record | Publication, access, release or tool workflow; requester cannot self-approve |
| Production promotion | Exact release/target plus delivery evidence | Exported-project CD still needs integration with the platform human decision; a UI approval alone is insufficient |

## AgentCore Policy inspection

`GET /api/governance/runtime-policies` is an authenticated, platform-admin-only,
read-only API. It reads the two server-configured shared Gateway ARNs, follows
validated same-account/region engine attachments and paginates `ListPolicies`.
It accepts no client-selected Gateway, engine, query parameters or request body.
Authenticated and effective roles must both be admin; demo role switching cannot
escalate a domain user. The response contains configuration metadata and native
Cedar statements, never agent transcripts or credentials.

The dedicated Lambda role and permissions boundary allow only these AWS reads,
identity verification and writing its own logs. Native Policy writes are absent.
The shared tag reconciler also tags the independent retained managed boundary
using the repository's existing required tag contract, scoped to its exact ARN.

The view distinguishes:

- no engine attached: observed absence, while Gateway IAM/JWT authentication remains;
- LOG_ONLY: decisions are observed without blocking calls;
- ENFORCE: configured blocking mode; engine/Gateway readiness are also shown;
- unavailable or partial: retain readable records and report unknown coverage.

Cedar uses default-deny and forbid-wins in enforcement. Attachment does not prove
all project execution routes through that Gateway. Start with trusted project
identity and tool schema, author/validate policies, test permit and deny cases,
observe candidate policies, then review and deploy the approved configuration.
The console does not activate policies or manufacture an engine when none exists.
Session-aware policy can use prior events/guardrail signals; a human approval
workflow must still establish trusted evidence before those signals can authorize
an action. Disabled tool-approval drafts remain a separate, collapsed editor;
saving them neither attaches an engine nor wires agent pause/resume.

AWS sources checked 2026-09-17:

- [Policy overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html)
- [Core concepts](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html)
- [Getting started](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-getting-started.html)
- [Using policies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-use-policies.html)

## Compliance report completeness

The report lists every readable pending approval with its request ID/type,
domain/project, resource, requester and submission time. Native Registry versions
awaiting review initiation are listed separately and deduplicated against linked
publication requests. Gateway-projected models/targets are not native Registry
lifecycle entries. The approval inbox remains the decision surface.

Registry reads share a pending promise for the same authenticated context, even
when the request takes longer than one second. A successful response is reusable
for five seconds; explicit refresh and context/mutation invalidation still apply.
Failures are not cached as successful inventory. This prevents simultaneous
Governance loaders from issuing redundant heavy reads and replacing an available
snapshot with a subsequent 503.

If a source fails or returns malformed/partial records, known pending requests and
readable Registry lifecycle data remain visible. Partial counts are labelled;
the total remains unknown until all required sources are complete. The report is
an operational governance snapshot, not a compliance certification.

Live follow-up also identified `registry-detail / THROTTLED` diagnostics from AWS
`GetRegistryRecord`. Registry clients now use adaptive SDK retries within the
existing operation deadline. Display-only reads may reuse validated details for
15 seconds, keyed by exact Registry/record ARN, status, type, version and update
time. Every request still lists its currently authorized Registries first. A
changed summary, missing/mismatched update time, failed read or projection fault
cannot use that cache. Strict Registry reads used by decisions and authorization
bypass it. Cached objects are cloned and the cache is bounded per service instance.
