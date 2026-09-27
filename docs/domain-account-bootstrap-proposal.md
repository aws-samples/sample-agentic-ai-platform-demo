# Domain, account and environment bootstrap proposal

Design proposal recorded on 2026-09-15; **not an implemented account-vending
service or authorization to create AWS accounts**. The owner subsequently
clarified that current work uses a single-account simulation and prioritizes
[ownership tagging and FinOps](ownership-tagging-and-finops.md). Account vending
is a future option, not a prerequisite for the current demo.

Current domain bootstrap prepares Registry/groups, resource access and telemetry
inside a connected account. A successful domain wizard does not prove that an
AWS account or complete landing-zone foundation was created.

## Entities

| Entity | Meaning |
| --- | --- |
| Domain | Business unit, owner/administrator, members and projects. |
| AWS account | Cloud resource, billing and permission boundary across regions. |
| Account connection | Verified account ID, management source, access role and governance state. |
| Environment binding | Domain/project dev/preprod/prod mapping to account, region, role and resources. |
| Domain foundation profile | Governed identity, model/Gateway, observability and runtime integration references. |
| Agent blueprint | Application/framework template selected within a project. |

A domain is not necessarily one AWS account or an Organizations OU. Dev/preprod
may share a governed nonprod account while prod uses a separate workload account.
Projects sharing an account still require independently verified resource and
role isolation.

## Proposed workflow

1. Create the logical domain and select its owner/administrator without requiring
   an agent blueprint or first project. Show pending environment configuration.
2. Connect governed existing accounts or submit account requests. Missing bindings
   must not be displayed as three newly created accounts.
3. Verify cloud baseline, then apply an approved Registry foundation profile.
4. Hand over per-environment readiness and missing prerequisites to Domain Admin,
   who can create projects and select application blueprints later.
5. Export projects to GitHub, develop locally and use governed CI/promotion.
   Production release approval remains separate from account provisioning.

Environment configuration should be resumable from domain details. One failed
binding must not hide the domain or other completed environments. An unrelated
catalog outage must not be confused with account creation readiness.

## Connect an existing account

Prefer accounts already managed by the enterprise cloud platform/landing zone.
Show alias, account ID, management source, intended use, owner, governance and
existing bindings. An account ID alone does not establish a connection.

The target administrator provisions a restricted bootstrap/deployment role via
reviewed IaC or existing automation. Verify the assumed caller's account, trust,
required permissions, organization/OU/baseline, service support and connectivity
before Connected state. No root credentials or long-lived keys belong in the
form. Cognito domain membership is separate from AWS access; enterprise users,
pipelines and workloads use their respective governed identities.

## Request a new account

Integrate an existing enterprise vending process:

- Control Tower Account Factory or an existing AFT/GitOps flow when available.
  AFT requires an existing landing zone and dedicated management resources;
  do not deploy it implicitly because a form requests an account.
- A restricted Organizations CreateAccount adapter in the management account
  when appropriate. Ordinary member-account credentials cannot do this merely
  by knowing an account ID.

Requests include purpose, owner, environment class, target OU, cost tags and
controlled account contact details. Root account email must be valid and unused,
provided by enterprise policy rather than inferred from a domain owner/name.
Apply the enterprise account approval process, then track asynchronous stages:

```text
Requested -> Approved -> Creating account -> Account created
          -> Applying cloud baseline -> Connecting platform
          -> Applying AI foundation -> Verifying -> Ready
```

Persist provider request/status IDs and rejected/failed/needs-attention outcomes.
An API200 or assigned account ID is not environment readiness. Reconcile uncertain
results before retrying creation. Retry baseline setup on the existing account;
never close an account as automatic rollback or create another on every retry.
Account approval and exact-release production approval remain different objects.

## Cloud baseline versus AI foundation

Landing zones own OU/SCP configuration, centralized audit/security, enterprise
identity, networking/DNS/egress, encryption and billing requirements. Reference
and verify these states; a role and log group alone do not implement them.

Registry is the AI foundation definition source for models, Gateways, tools,
skills, observability and harness constraints. Domain pages reference approved
versions rather than duplicate their content. Verify actual account governance
through the appropriate AWS services, not Registry approval metadata.

Model approval, domain entitlement, region/service availability and an actual
credential/network invocation are separate checks. Domain foundation supports
multiple projects with different application blueprints. Applied environments
retain version/drift state; updates use a separate governed reconcile process,
not silent production upgrades after catalog refresh.

## Historical context and future validation

The September 15 read-only inspection found the original test account was an
Organizations management account with ALL features and no members at that time.
Control Tower/AFT availability was unconfirmed. AWS recommends limiting management
account workloads; SCPs do not restrict its principals. Reinspect current state
before any topology decision. No accounts, OUs or cloud resources were changed
by that investigation.

A future implementation must verify missing/incorrect account connections,
AssumeRole denial, baseline failures, async pending/timeout/recovery without
repeat account creation, explicit environment mappings and real cross-account
role boundaries. Management-account simulation must remain visibly limited,
not a default production target. Move long-lived platform workloads to an
appropriate shared-services member account only through a separately reviewed
migration. This proposal itself grants no authority to make that migration.

## References

- [Organizations CreateAccount](https://docs.aws.amazon.com/organizations/latest/APIReference/API_CreateAccount.html)
- [Control Tower Account Factory](https://docs.aws.amazon.com/controltower/latest/userguide/account-factory.html)
- [Account Factory for Terraform](https://docs.aws.amazon.com/controltower/latest/userguide/aft-overview.html)
- [Management account best practices](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_best-practices_mgmt-acct.html)
