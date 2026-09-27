# Ownership tagging, deployment enforcement and Billing plan

Plan recorded on 2026-09-15. **Not implemented or deployed as a unified contract.**
Use the [ownership contract](ownership-tagging-and-finops.md) for tag semantics.
Historical observations below do not override current deployment code or memory.

## Goal and current limitations

Make ownership part of installation, domain/project creation, export, deployment
and runtime resource creation. Existing-resource backfill is a migration path,
not an undocumented requirement for each new installation.

Existing IaC uses legacy mandatory deployment tags with IAM dependencies. Domain
resources and exports use inconsistent domain keys; project state has no unified
ownership contract; some manifest tags do not prove propagation to every child
or SDK-created resource. Exact Registry TagKeys permissions must change together
with writers. Editable repository checks alone cannot enforce cloud ownership.
Earlier account-wide service cost queries did not establish installation-level
attribution. Recheck current implementations before changing them.

The ordered clean-account command now includes DomainBootstrap and explicitly
requires operator/workspace initialization (PR68). This supersedes the original
plan's September 15 observation that only ControlPlane and Web were orchestrated.
It does not implement Billing initialization or the unified ownership contract.

## Versioned contract

Use a shared schema/resolver for IaC, hosted/local services, exporters and delivery
workers. Persist a stable installation ID; never generate a different ID on each
update or encode the test account. Resolve protected domain/project/environment
from actual records. Optional cost-center metadata must be authorized.

Shared resources have no business domain/project ID. Classify mixed stacks by
resource, not with one blanket ownership value. Keep old tags for compatibility,
separate names from IDs, reject protected-key removal/override, and validate
service-specific formats/counts. Store schema versions, deployment snapshots and
bindings where required, with compatible upgrades for strict record validators.
No personally identifying owner fields belong in cost tags.

## Creation and delivery stages

| Stage | Required behavior |
| --- | --- |
| Install | Stable platform identity, per-resource classification, synth checks and postdeployment inventory. |
| Domain | Server-resolved ownership, domain-shared tags on owned resources, zero implicit projects. |
| Project | Authorized parent domain and metadata, persistent context; no retagging shared DynamoDB. |
| Agent export/deploy | Same ownership/target contract in every export mode, controlled execution identity and resource read-back. |
| Runtime creates | Same trusted-context adapter or restricted runtime role, not arbitrary model/tool-supplied ownership. |

Registry remains the definition source for foundations. Ownership is deployment
context, not another content catalog. Referencing a shared Gateway/model/store
does not change physical ownership; record the consuming project for access and
allocation instead.

## Controlled deployment path

Local build/CI submits an immutable artifact to the platform delivery service,
which validates project, target, repo, commit/digest, harness/ownership versions
and evidence before obtaining project/environment-specific execution authority.
Extend existing delivery/approval mechanisms instead of creating a parallel gate.

- Re-resolve trusted ownership and reject target substitution.
- Restrict CloudFormation execution roles, runtime roles, boundaries and PassRole.
  Builders must not acquire the entire platform deployment/bootstrap role.
- Where supported, enforce required RequestTag/TagKeys at creation and ResourceTag
  at later operations, together with ARN/namespace limits.
- Protect Tag/Untag, trust/policy/boundary changes, PassRole and session-tag paths.
  Trusted identity mappings, not builder assertions, set session ownership.
- For unsupported condition keys, use a controlled resource adapter. Record parent
  bindings for untaggable objects; reject unsupported resource types until an
  adapter and recovery path exist.
- For post-create tagging, retain pending state until write/read-back success.
  Preserve retry/compensation evidence on failure; do not show Ready.
- Cover pre-deploy CLI/SDK steps such as credentials, memory and tool creation,
  not only the final CloudFormation template.
- Publish a per-service matrix: create/tag/read actions, condition support,
  propagation, billing coverage, caller identity and failure recovery.

Production authorization must bind a real human decision to the same artifact
and target. Pending, rejected, expired or changed releases cannot obtain prod
execution rights. Editable GitHub workflows alone are not approval evidence.
These controls govern platform-issued identities, not an independently held AWS
account-administrator credential. A management-account simulation proves no SCP
isolation. Inspect native delivery and older runtime-validation paths separately.

## Billing initialization

Use a narrowly scoped reconciler and durable, asynchronous status. Request
platform-id, cost-scope, domain-id, project-id and environment keys; request
cost-center only when configured. Preserve legacy project for compatibility.

ListCostAllocationTags and UpdateCostAllocationTagsStatus require an authorized
management/standalone billing context. Handle per-key Errors even on HTTP200 and
read back Active state. New keys may appear only after tagged resources exist;
retry with backoff after installation, resource creation and scheduled checks.
Never invent business tags on shared resources to make a key appear.

Do not block a CloudFormation custom resource for 24-48 hours. Report waiting for
key visibility, activating, active and administrator-action-required states,
coverage, first attributable date and bill freshness. Member/restricted accounts
must expose the payer prerequisites or integrate an authorized enterprise billing
source. Cost Explorer first enablement has no API and requires a console action.

Allocation keys are account-wide; deleting this demo must not deactivate shared
keys or alter unrelated budgets, payment data or organization preferences.

Cost queries require platform-id and, where applicable, linked-account filtering,
plus server-authorized domain/project scope. Exclude unrelated account charges,
paginate and cache appropriately. Unknown coverage is not zero. Show billed,
allocated and estimated costs separately and never double count. New tags cannot
reconstruct historical ownership that never existed.

## Existing deployment migration

1. Read inventory from stacks, outputs, Registry/runtime settings and persistent
   bindings, including reference-existing resources. Record ARNs, old/proposed
   tags, ownership proof, write method and risks.
2. Classify verified owned resources; leave unknown/external ownership unresolved.
3. Deploy compatible readers/schema/IAM, then writers. Review exact TagKeys during
   transition and preserve retained data and active configuration.
4. Produce a reviewable tag plan, apply only authorized records, read back changes
   and retain retry/failure evidence. A console-only manual repair is not the
   portable implementation.
5. Validate restricted-role denial cases, then Billing activation and eventual
   actual attribution. Resource read-back is not invoice evidence.

## Work packages and acceptance

| Package | Main locations | Required proof |
| --- | --- | --- |
| Schema/install | shared module, both infrastructure packages, clean-account command | Stable identity, portable account configuration, correct shared/seed classification. |
| Domain/project | platform-admin, domain-bootstrap, workspace, local handlers and IAM | Correct parent scope, protected-key denial, old-record compatibility, retryable failure. |
| Export/delivery | export composer, CI templates, journeys, blueprints, delivery roles | Same contract in all modes; target/role/tag tampering denied; prod human decision bound to release. |
| Billing/migration | reconciler, plan/apply utility, platform-costs reader and UI | Visible per-key status/prerequisites, scoped queries, no false shared ownership. |
| FinOps | operations, domain/platform views, usage allocation | Same-named projects isolated; estimates/allocation/bills separated; latency and gaps visible. |

Test initial create, update and replacement with actual restricted execution
identities where live proof is needed. Administrator success is not enforcement
proof. This plan does not add budget thresholds, email notifications or account
vending. Current region support remains the repository's explicit region contract.

## References

- [SageMaker custom tags](https://docs.aws.amazon.com/sagemaker/latest/dg/custom-tags.html)
- [AgentCore tagging](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/tagging.html)
- [Billing allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html)
- [Activation delays](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html)
- [Per-key activation errors](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_UpdateCostAllocationTagsStatus.html)
- [Cost Explorer enablement](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-enable.html)
- [Historical backfill](https://docs.aws.amazon.com/cost-management/latest/userguide/cost-allocation-backfill.html)
