# Resource ownership and FinOps contract

Owner requirements and research recorded on 2026-09-15. **The unified ownership
and Billing contract below is proposed, not deployed.** See the
[implementation plan](tagging-enforcement-implementation-plan.md) and current
[project memory](../memory/projects/agentic-ai-platform-demo.md) for later facts.

## Scope and ownership

The shared platform repository/deployment is not a business agent project.
Shared frontend, APIs, Cognito, state tables, runtimes and Gateways must not be
assigned to whichever business domain/project happens to use them. Platform's
own real development projects follow the same ownership model as other domains.
The current simulation does not require AWS account vending or prove SCP-based
isolation; cross-account deployment and isolation require separate acceptance.

A project is a persistent domain-owned workspace with members, agents, repo,
environments and release records. Only resources actually owned by that project
receive its business identity. A DynamoDB project item cannot be independently
AWS-tagged; do not retag the shared table for each item.

## Proposed protected tags

| Tag | Trusted source |
| --- | --- |
| `platform-id` | Stable installation identity shared by platform resources and managed workloads. |
| `cost-scope` | Actual ownership: `platform-shared`, `domain-shared`, or `project`. |
| `domain-id` | Actual domain, present only on domain/project-owned resources. |
| `project-id` | Actual agent-project identity, always interpreted with domain ID. |
| `environment` | Explicit dev/preprod/prod target binding, omitted for cross-environment shared resources. |
| `cost-center` | Optional authorized business metadata, never guessed. |

Keep existing `project=agentic-ai-platform-demo`, `managedBy=cdk` and
`auto-delete=no` tags and their IAM semantics. The old `project` key is a
repository/deployment label, not the business project dimension. Review policy
conditions before any schema migration. Display names are not ownership IDs.

| Resource | Cost scope | Domain/project tags |
| --- | --- | --- |
| Shared platform API/frontend/state | platform-shared | Neither |
| Finance-only domain foundation | domain-shared | finance only |
| Finance fraud-agent runtime | project | finance and fraud-agent |

Do not retag shared resources to allocate costs. Allocation records are separate
from physical ownership. Reject attempts to override protected fields; permit
extra business tags only through an explicit allowlist and service-specific
format/count checks. Do not place personal owner data in cost tags.

## Propagation and enforcement

Resolve ownership from server-side domain/project/target records. Reuse one
versioned contract across bootstrap, SDK adapters, IaC, local/hosted exports,
CI/CD and runtime resource creation. Include tags on supported create operations.
For resources tagged after creation, persist pending status until tagging and
read-back succeed. Track unsupported objects through parent/resource bindings.

Local coding-agent development has no implicit Studio tagging context. Exported
instructions/IaC carry defaults; the controlled deployment service revalidates
actual ownership and target. Editing project files must not grant another
project's deployment identity. Validate each service's create/tag/read APIs,
condition keys and CloudFormation propagation rather than assuming stack tags
cover every child resource. Tags supplement IAM and membership, not replace them.

Backfill only resources with trustworthy ARN/ownership bindings. Unknown owners
remain unresolved; names alone are insufficient. Referenced external resources
do not become writable platform-owned resources merely because they are used.

## Three distinct financial measures

1. **Direct billed cost:** Cost Explorer/CUR data with activated allocation tags
   and verified service coverage. Separate platform, domain and project-owned
   costs. Show unallocated/unavailable when attribution is incomplete.
2. **Shared allocation:** distribute known shared billed cost using a trusted
   domain/project/environment usage ledger. Preserve billing period, method,
   version, denominator and remainder. Do not add the allocated amount to the
   same billed cost again.
3. **Inference estimate:** observed model/token use with a price book and explicit
   coverage. Label it an estimate; do not add it to bills that already include
   the model cost or present partial usage as a complete invoice.

Platform FinOps shows shared costs, domain rollups, unallocated amounts and
coverage. Domain FinOps shows its shared costs, project direct/allocated costs,
environment, budgets and trends. These are views of the same costs, not amounts
to sum across hierarchy levels. Cost queries need installation and authorized
scope filters; do not forward arbitrary client tag filters to Cost Explorer.

Application inference profiles may improve attribution for supported Bedrock
on-demand calls, but the actual request must use the profile and its route/model
must support it. Creating a tagged profile alone proves no attribution.

## Billing readiness and historical limits

Resource tags and activated Billing allocation keys are separate. Newly available
user tags can take 24 hours to appear and activation another 24 hours; bill data
has its own latency. Validate coverage for each billable service. Historical
backfill requires the resource to have had the tag at the relevant time; adding
a tag now cannot reconstruct previously absent business ownership.

The September 15 read-only inspection found legacy `project` Inactive and the
proposed ownership keys not listed. This is a dated observation, not current
account readiness. No Billing activation/backfill or resource-tag write was
performed in that investigation. First Cost Explorer enablement requires a
console action; do not promise a completely unattended first-account bill view.

## Implementation entry points

Review platform-admin Registry creation, domain-bootstrap resource tags,
workspace project records, journeys manifests, Registry IAM exact TagKeys,
platform-cost queries and resource bindings together. Some hosted manifests
already use domain-id/project-id, while older domain resources use `domain`.
Unify the contract without breaking strict record validators or IAM boundaries.

Sequence: ownership schema; domain/project defaults; export/deployment/runtime
propagation and enforcement; existing-resource audit/backfill; Billing activation
and coverage; scoped FinOps queries/allocation. Verify same-named projects in
different domains do not mix, unknown coverage never appears as zero, and local
and hosted delivery obey the same controls.

## References

SageMaker provides a useful trusted-context propagation pattern, but its automatic
system tags and optional custom propagation are distinct. Custom propagation
requires ENABLED configuration, may require restarting existing apps, and does
not retroactively update old child resources. Do not introduce Studio merely to
borrow its tag behavior, or use sagemaker-prefixed tags for this platform.

- [SageMaker automatic tags](https://docs.aws.amazon.com/sagemaker/latest/dg/domain-multiple-tag.html)
- [SageMaker custom propagation](https://docs.aws.amazon.com/sagemaker/latest/dg/custom-tags.html)
- [Configure custom tags](https://docs.aws.amazon.com/sagemaker/latest/dg/custom-tags-add.html)
- [Studio display filtering is distinct from authorization](https://docs.aws.amazon.com/sagemaker/latest/dg/domain-multiple-filtering.html)
- [AgentCore tagging](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/tagging.html)
- [Bedrock inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)
- [Billing activation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html)
- [Historical backfill](https://docs.aws.amazon.com/cost-management/latest/userguide/cost-allocation-backfill.html)
