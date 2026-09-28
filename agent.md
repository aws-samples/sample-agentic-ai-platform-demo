# Enterprise Agentic AI Platform specification

Owner requirements recorded on 2026-09-14 and clarified through 2026-09-26.
This specification defines the product contract, not a claim that every feature
is implemented. See [project memory](memory/projects/agentic-ai-platform-demo.md)
for the implementation map, verified deployments and outstanding gaps. Current
owner instructions take precedence over historical plans.

Repository documentation, comments, UI copy, demo titles and captions must be
in English. Keep current contracts and actionable operational guidance here;
retired development diaries and screenshots remain in Git history.
The README must explain the platform purpose, high-level architecture, enterprise
ownership structure, governance framework and GitHub-first builder journey before
introducing maturity terminology. Explain all four maturity stages: Ad Hoc Agents,
Platform Foundation, Scale & Self-Service, and Adaptive Platform. Position this
repository as the Stage 3 demo in the maturity section, with Platform as Agent
as the Stage 4 vision. Keep stage numbers out of the README title and opening
introduction; explain the platform before introducing maturity terminology.
Use the owner-provided enterprise architecture to explain the hybrid operating
model, shared controls and domain accountability; distinguish reference
multi-account topology from verified deployment.

Maintain an English [Console walkthrough](docs/console-navigation.md) with current
reference screenshots, role/domain/project navigation, deployment acceptance checks
and troubleshooting. Distinguish seeded records from configured services and
verified runtime behavior; do not include credentials in documentation or images.

## 1. Product purpose

Build an enterprise agentic AI **control plane** for shared governance, reusable
foundations, controlled delivery and runtime feedback. Builders use platform
blueprints and a Foundation Harness, develop business behavior locally with a
coding agent, and release through governed CI/CD.

The platform provides:

- Registry, Gateway, policy, governance, guardrails, evaluation and observability.
- Versioned templates and onboarding, approval, access and revocation for models,
  MCP servers/tools, skills and reusable agents.
- Domain identity, account/environment bindings, permissions, model access,
  observability and inherited foundation configuration.
- Persistent project workspaces and exportable development repositories.
- Dev, preprod and prod promotion with an enforced human production decision.

A demonstration must show who can build, in which scope, using which resources,
who can approve a release, and where each control is actually enforced.

## 2. Ownership and organization

| Entity | Meaning |
| --- | --- |
| Organization | Enterprise governance baseline and its business units; not automatically an AWS Organizations OU. |
| Shared platform | Shared control-plane services and global governance. |
| Domain | Business unit and identity, policy, budget and data boundary. |
| Account/environment binding | Explicit domain/project mapping to account, region, environment, execution role and resources. |
| Project | Persistent workspace owned by exactly one domain, with members, agents, repositories and delivery records. |
| Agent | A testable/deployable business capability inside a project. |
| Persona | Permitted actions: platform admin, domain lead, builder or end user. Membership determines scope separately. |
| Foundation Harness | Versioned, platform-governed controls and development/runtime integration. |
| Domain Harness | Business instructions, code, skills, tools, knowledge and evaluation inside those controls. |

A domain owns multiple projects; a project can contain multiple agents; a user
can belong to multiple projects. Workspace access does not automatically confer
builder, administrator or production approval powers. End-user consumption does
not confer development access.

Platform is itself an owning domain for its own workspaces. Reuse internal
`platform` identities and registries; do not add another nested "platform domain"
product layer. Separate organization-wide inventory from Platform-owned projects.

Multiple logical domains can be demonstrated in one AWS account. That does not
prove cross-account isolation. Real AWS account creation is a separate,
explicitly configured capability, not an implicit effect of domain creation.

## 3. Governance and authorization

Controls apply at platform, domain, project, environment and runtime. Effective
access requires the intersection of persona capability, membership, resource
permission and environment policy. Lower scopes cannot weaken inherited controls.

- Resource records identify owner, scope, version, approval and usage policy.
  Registration, approval, domain entitlement and actual runtime access are
  distinct states. New domains without resource policy default to deny.
- Builders select approved versions allowed by their domain and project. Servers
  revalidate at submission, deployment and use; dropdown filtering is insufficient.
- Mandatory guardrails accumulate; applicable model/tool allowlists intersect;
  quotas can become stricter at lower scopes.
- Route approvals to authorized decision makers. Enforce separation of duties;
  requesters cannot self-approve critical releases. An AI decision does not
  replace the required production human decision.
- Platform monitoring authority does not grant access to all prompts, traces or
  memory contents. Sensitive content requires separate permission and auditing.
- Validate actor, scope, state and bindings on the server. Persona controls,
  browser storage, URL parameters and client-supplied approval flags are not
  authorization evidence.

## 4. Domain and project bootstrap

### Domain foundation

Domain bootstrap is a tracked preparation process, not merely a domain row.
Bind an existing account by default. Account vending or OU placement must be a
separately defined and authorized workflow; see the
[account/environment proposal](docs/domain-account-bootstrap-proposal.md).

Domain foundation is independent of an application-agent blueprint. It prepares
identity, permissions, environment bindings and observability. Do not require an
agent blueprint, default model, project name or first project to create a domain.
An environment can be initialized with no agent resources selected; that grants
no resource access.

Platform Admin can browse the full Registry blueprint/model catalog and select
sets allowed for a domain, including catalog records without runtime quota
configuration. Catalog visibility, entitlement, project selection and runtime
readiness must remain distinct. An unrelated unreadable catalog record may be
reported without blocking environment initialization; an unreadable, unapproved
or inconsistent selected resource must not be granted.

Domain administrators select project subsets inside the approved domain scope.
Hosted projects store these in `resourcePolicy`; legacy projects without that
field inherit domain scope. Legacy domains must still permit explicit project
subsets from their approved catalog rather than displaying disabled checkboxes.
Servers reread trusted catalog state on creation and retries, reject forged or
out-of-scope references, and stop writes if validation is unavailable.

Bootstrap outputs include domain ownership, account/region/environment mappings,
identity groups and trust, least-privilege boundaries, resource entitlements,
Gateway/authentication bindings, quotas, telemetry, audit/cost context, and
versioned Foundation Harness references. Show readiness, missing prerequisites,
completed steps and safely retryable failures. Configuration is not provisioning.

### Domain management UI

- Create a domain with a business owner and an existing responsible administrator.
  The identity picker uses the real directory and must not require prior
  `domain-lead` membership. An existing platform administrator can own a domain
  without receiving conflicting permanent personas. Default to the current
  administrator; an omitted business owner can use that administrator.
- Preserve form contents across catalog refresh, Back and draft restoration.
  All four configuration pages must reach Review. List missing prerequisites
  there, prevent execution, and provide revalidation rather than trapping users
  on an intermediate page.
- Domain details show actual project counts, project overview and owner.
- Users & Access uses the top-level working domain as its only domain selector.
  Domain membership and project assignment are distinct from production-agent
  end-user access.
- Platform Admin's builder workspace contains Platform-owned projects. Domain
  Builder sees only assigned projects in the authorized domain.
- Blueprint/model/tool/skill content comes from Registry. Do not maintain a
  competing domain-level catalog or edit template definitions in this form.
- Catalog refresh reflects approved definitions; applied environments retain
  exact versions. A catalog update must not silently update production.
- Revalidate selected identity, version, approval and environment prerequisites
  at submission/execution. Agent-specific model/tool dependencies are checked
  later when an agent is built in a project.
- Identity groups, telemetry roles and logs alone do not prove applications,
  adapters, guardrails, GitHub delivery or production approval are deployed.

### Project creation and handover

Only an explicit confirmed project-creation workflow for a Domain Lead or
Platform Admin creates a project. Builders create agents inside assigned
projects. Compose, specification design, previews, exports and list reads must
not implicitly create projects. Tests must not accumulate active workspaces.

Every builder entry uses the same project resource scope. Switching projects
invalidates the previous agent/export preview as the current handover target.

Project bootstrap supplies identity, ownership, membership and repo association;
blueprint and foundation versions; business extension points; runtime/framework
and dependency instructions; environment examples; tests, datasets and CI gates;
dev/preprod/prod target contracts; and coding-agent instructions such as
`SPEC.md`, `AGENTS.md` and compatible `CLAUDE.md`. Export resource references and
credential-acquisition instructions, never platform credentials, private content
or another account's deployed state.

## 5. Builder journey

1. Select an authorized project and enter through a blueprint, foundation start
   or specification-driven design; all three inherit the same governance.
2. Compose the Foundation/Domain Harness and preview the actual repository files.
3. Export directly to authorized GitHub. The repository name defaults to the
   Agent name from Compose step two, not the owning Project name. Provide the
   repository URL and local checkout instructions; ZIP is an optional copy.
4. Clone locally and implement business behavior, instructions, integrations and
   evaluation using a coding agent. Hosted editing is optional, not a requirement.
5. Run local tests and evaluation, open a PR, and execute CI tests, security scans,
   evaluation, policy/guardrail conformance and code review.
6. Deploy the checked release to dev, then preprod/UAT with target-specific proof.
7. Submit a production promotion request and wait for the platform human decision.
8. Deploy only the approved release/target; return health, business acceptance,
   version and telemetry to the platform.

The reference demo recording must be reproduced with the current UI and real
local edits, PR/CI, dev/preprod, approval and prod delivery. Associate each stage
with actual commit, run, target and decision evidence. Status text or simulated
success is not proof. Local development still requires connectivity for remote
models, GitHub, AWS and approval services.

### Compose and evaluation acceptance

Generate must work from step two of the main Build Agent journey, preserve
multiline instructions, show missing fields before submission, and reach the
handover page. An alternative form or direct API create is not UI acceptance.

Registry Model and Builder use the same registered catalog. Model options are
the intersection of registration, domain entitlement and project policy. An
entitlement read failure cannot fall back to all models. Verify a project with
one permitted model and rejection of direct submission of an unassigned model.

Review & export delivers an **undeployed construct** and development assets.
A direct model call is not an Agent evaluation or a prerequisite to GitHub export.
Builders may upload JSONL, use starter data, reference private data or defer data
setup. Evaluators can be built-in, custom Python, AgentCore-based or deferred.
Include configuration and actual files in the immutable preview/fingerprint.
Missing business evaluation does not block export, but must never count as a
pass. Custom evaluation cannot weaken foundation controls or human approval.
AgentCore integration uses an actual trace-based on-demand adapter; do not imply
that it deploys an evaluator, configures online evaluation or hosts arbitrary
local Python evaluator code automatically.

## 6. Foundation Harness contract

Foundation supplies identity/authentication, runtime/resource bindings, mandatory
guardrails, observability, memory/knowledge integration and evaluation/CI/CD hooks.
Recommend Strands Agents with AgentCore Runtime, backed by actual exportable
source and deployment configuration published through Registry. Label external
references and illustrative templates honestly. Template model defaults do not
replace domain/project authorization.

Version all foundations and preserve provenance. Enforce locked controls in
runtime, cloud permissions or CI; Markdown declarations alone are insufficient.
Editing local foundation files must not grant broader cloud permissions.
Platform maintainers can upgrade foundations through governed platform projects.
Reuse the export/gate contract in local and hosted paths. Instructions must work
across coding agents and distinguish protected controls from business extension
points. Complete generated `EXPORT_NOTES.md` prerequisites before deployment.

## 7. Production promotion

Use `dev → preprod → prod`. Document any UAT/staging mapping to preprod;
`SANDBOX/PRODUCTION` labels alone do not prove a three-environment delivery.

Production requests bind domain/project, repo, commit SHA, artifact digest,
target account/environment, harness versions and test/eval/security/review proof.
Persist request, policy verdict, human decision, actor, time and reason.

Pending, rejected, expired, revoked, missing-evidence and unavailable-platform
states must prevent prod execution. Revalidate exact release, target and current
authorization immediately before deployment. Changed artifacts/configuration
require fresh verification and approval. Use authenticated pipeline identities
and idempotent callbacks/retries; production credentials are available only
through the enforced delivery path. A bypassable UI button is insufficient.

GitHub Environment reviewers can add protection; if used as the execution gate,
link them verifiably to the platform decision and exact release. Distinguish
requested, approved, deploying, deployed, failed and skipped outcomes, including
runtime/version and rollback records. Registry publication, access grants,
runtime tool-call HITL and release promotion are separate approval objects.
Extend existing hosted delivery/approval mechanisms before inventing another
approval service; this target contract does not assert an API already exists.

## 8. Ownership tags and FinOps

The repository/shared platform is not a business agent project. Shared resources
must not acquire a requesting domain/project's ownership tags. Real domain and
project creation resolves protected ownership from server records, and owned AWS
resources carry that context through creation, export, CI and runtime adapters.
A DynamoDB project item is not an independently taggable AWS resource.

Preserve legacy deployment labels: `project=agentic-ai-platform-demo` is not the
business project ID. Business ownership uses domain plus project identity and
explicit target environment. Separate shared-cost allocation from physical
ownership. Distinguish resource tags, Billing activation, billed cost, shared
allocation and inference estimates; do not double count or fabricate zeros.
Tags are not a replacement for IAM or membership checks.

Installation must expose tag/Billing prerequisites, capability checks and
asynchronous readiness. Account permissions, Cost Explorer activation and data
latency cannot be reported as already ready. See the pending
[ownership contract](docs/ownership-tagging-and-finops.md) and
[enforcement plan](docs/tagging-enforcement-implementation-plan.md); these remain
requirements/proposals unless current implementation and live evidence prove them.

## 9. Implementation and deployment discipline

| Path | Responsibility |
| --- | --- |
| `console/public/modules/app.mjs` | Main Console UI; deployment generates `runtime-config.js`. |
| `console/server.mjs` | Local API/server; local or illustrative behavior does not prove AWS behavior. |
| `infra/platform-registry/` | Shared Registry/Gateway control-plane infrastructure. |
| `infra/serverless-platform/` | Hosted UI, Cognito/API, state, governance and delivery. |
| `blueprints/`, `platform-skills/` | Reusable foundation source and skills. |
| `console/export-contract.mjs`, `console/export-composer.mjs`, `console/ci-templates/` | Shared/local export and delivery contracts. |
| `infra/serverless-platform/lambda/journeys/` | Hosted generation, manifests and GitHub delivery. |
| `domain-examples/` | Example projects, not portable pre-existing cloud resources. |
| `e2e/` | Browser and end-to-end verification. |

Extend existing model, domain, project, authorization and approval contracts.
Inspect current hosted handlers and [API notes](docs/API-GOTCHAS.md), not retired
plans. Preserve unrelated user edits and runtime stores. Validate documentation
links and consistency; run behavior-specific tests for source changes and denial
cases for authorization/delivery changes.

Use the owner-designated account and verify it with STS before AWS mutations.
Historical verification accounts are evidence only. They must never become
deployment targets or hard-coded portable runtime/template defaults.
Inspect live stacks, outputs, reviewed configuration and planned changes. Follow
the [deployment runbook](infra/serverless-platform/README.md), including audit,
diff, postdeployment checks and acceptance. Existing deployments are not an
excuse to provision duplicate shared infrastructure.

Use scoped, temporary deployment identities; retain permission boundaries, data
and required `auto-delete=no`, `project=agentic-ai-platform-demo`, `managedBy=cdk`
tags. Test-account authorization does not replace product production approval.
Distinguish local tests, synthesis, live smoke, authenticated acceptance, actual
deployment and cross-account verification.

Demo deployments default to shared Lambda concurrency without fixed per-function
reservations. Dedicated reservations are an explicit deployment option, not a
prerequisite for a small demo. Check capacity before creating resources and
document the selected mode; shared capacity remains subject to account throttling.

## 10. Handover acceptance

- Governance approval requests, guardrail exceptions and blueprint submissions
  use real hosted workflows. Guardrails display controls/scope/enforcement, not
  a blueprint list. Use service-console-quality forms, queues and feedback.
- Verify project creation only on confirmation; assigned project selection;
  Generate; model access denial; immutable export; local development and CI;
  production pending/reject/approve/expiry/change/retry/revocation cases; and
  target-scoped telemetry without leaking sensitive content.
- New-account initialization ships with code and the runbook, not undocumented
  repairs in a test account. Create a permanent initial administrator, explicitly
  authorize demo persona switching, and initialize selected operators' seeded
  Customer Support and Operations workspace memberships. Repeated initialization
  preserves existing members/custom projects and ordinary Builder boundaries.
- Verify both domain Builder workspaces and their agents. Report real Memory/KB
  bindings separately; visible project cards are not proof of provisioned memory
  or ingested knowledge data.
- Record illustrative behavior, implementation and fresh live verification as
  separate facts. Do not report the whole platform ready because one page or
  deployment command succeeded.
