# Agentic AI Platform project memory

Current implementation map and verified operational context, consolidated on
2026-09-25. Requirements are in [agent.md](../../agent.md). Retired task diaries,
reviews and screenshots are recoverable through the [history index](../../docs/history/README.md).
This file distinguishes source implementation, dated live evidence and remaining
work. Do not treat an earlier deployment or simulated result as current acceptance.
Never store credentials, tokens, browser sessions or private user content here.

## Read first

1. `AGENTS.md` and `agent.md` for working rules and product invariants.
2. `infra/serverless-platform/README.md` for deployment and initialization.
3. `docs/API-GOTCHAS.md` and the current handler/service for API probes.
4. `docs/governed-agent-delivery.md`, `docs/github-builder-setup.md` and shared
   export contracts for GitHub/local-development/CI/CD changes.

Preserve unrelated working-tree edits and runtime stores. Verify STS and live
stack outputs before every AWS write. Profile names and old output files are not
account proof. Use the existing deployment's mode and configuration; a clean-
account command does not authorize replacing an existing shared deployment.

## Product model

- Domains are business/governance boundaries; each owns multiple persistent
  projects, each project can contain multiple agents, and users can have multiple
  project memberships. Platform is also an owning domain.
- Persona controls actions; membership controls scope. Browser selection is not
  authorization. The demo operator path is explicit and does not relax ordinary
  Builder scope checks.
- Main journey: project/blueprint bootstrap, GitHub export, local coding agent,
  tests/evaluation, CI, dev, preprod, human production approval, prod, telemetry.
- Review/export delivers an undeployed construct. Optional/custom evaluation
  assets can be exported before configuration, but must not be recorded as passed.
- Registry approval, resource access, tool-call HITL and production release
  approval are separate objects. Do not reuse one as proof of another.

## Implementation map

| Surface | Source |
| --- | --- |
| Console | `console/public/index.html`, `modules/app.mjs`, `styles/app.css`; deployment owns `runtime-config.js`. |
| Local server/state | `console/server.mjs` and local JSON adapters; not hosted AWS proof. |
| Registry/Gateway IaC | `infra/platform-registry/`; reference-existing and provision modes. |
| Hosted identity/authorization | `infra/serverless-platform/lambda/api/identity.mjs`, `authz/`. |
| Domain bootstrap | `lambda/domain-bootstrap/`, `lib/domain-bootstrap-stack.ts`. |
| Projects, agents, membership | `lambda/workspace/`, `lambda/access-admin/`. |
| Governance | `lambda/governance/`, `lambda/platform-admin/`, hosted decision services. |
| Model governance | `lambda/model-governance/`, scoped catalog readers and Gateway bindings. |
| Generation and handover | `lambda/journeys/`, `console/export-contract.mjs`, `console/export-composer.mjs`. |
| Local export gates | `console/ci-templates/`, evaluation asset generators and blueprint sources. |
| Governed Agent delivery | Dedicated AgentDelivery stack, release/approval API and native pipeline; see delivery runbook. |
| Older hosted deployment API | `lambda/deployment/`; inspect exact behavior, since runtime validation is not necessarily artifact deployment. |
| Cost/telemetry | `lambda/operations/` plus usage-ledger and pricing contracts; distinguish billed cost from inference estimates. |
| Demo workspace bootstrap | `scripts/initialize-demo-workspaces.mjs` under serverless infrastructure. |

Paths beginning `lambda/` or `lib/` above are relative to
`infra/serverless-platform/`. Prefer current code over historical API descriptions.

## Deployment targets

### Original account: 534409838809 / us-west-2

- Existing Console: https://d2s9ypdbjcdxm7.cloudfront.net/.
- This is a separate deployment/user pool from the newer account. Do not test it
  when the owner requests verification of the new Console.
- The September 15 read-only organization inspection found a management account
  with ALL features and no member accounts at that time. That dated observation
  does not certify current topology or SCP isolation. Real account vending was
  not implemented or authorized by that investigation.
- Preserve retained application data, Registry/Gateway configuration and shared
  bootstrap. Use current STS/stack inspection, not these historical facts, for writes.

### New-account verification: 820242898417 / us-west-2

Owner explicitly authorized reinstalling this deployment and initializing demo
access. No authorization should be inferred for unrelated account resources.

- Console: https://d35q3a338iunvm.cloudfront.net/.
- Cognito pool: `us-west-2_u91B76GmI`; client: `6u033hr0jvkhf3jcad6hq9hrmr`.
- Cognito domain: `agentic-platform-820-reinstall-20260924.auth.us-west-2.amazoncognito.com`.
- Web distribution: `E2Q1C6QPE4N61V`; API: `0zl4ng6zai`.
- Ordered clean-account deployment from main `607ab2d` completed on September 24.
  ControlPlane-Provisioned, Web and DomainBootstrap all reached CREATE_COMPLETE.
  Other applications/shared CDK bootstrap and retained old data were preserved.
- Inventory: 3 domains, 6 projects (Platform 1, Customer Support 3, Operations 2),
  13 model policies and all five domain-bootstrap routes. Normal login,
  project/model selection, Generate201 and 59-file preview201 were verified.
  Evaluation remained NOT_RUN; that run did not exercise Agent production delivery.
- Test users/constructs were removed after verification. They were not permanent
  operator access and must not be described as an initialized administrator.

## Verified changes and important distinctions

### Domain/project resource selection

Domain environment foundation is independent of an agent blueprint. Catalog
selection reflects Registry content; runtime quota readiness is separate. Projects
can select subsets within domain scope, including legacy domains that lack an
explicit catalog-policy record. Servers validate current approved references on
create/retry; catalog failure prevents writes rather than granting everything.

September 21 hosted verification in the original account confirmed 28 selectable
resources, clear/select actions, Chat Assistant plus Claude Haiku 4.5 selection,
a real project201, refresh persistence and a Builder palette restricted to that
subset. A catalog-validation timeout required a 25-second project-create budget;
ordinary reads retain their shorter deadline. Temporary test project/user cleanup
was verified. That is dated original-account evidence, not new-account acceptance.

### Generate, evaluation and repository handover

Repairs separated agent names from persistent project names, rejected implicit
project creation during Compose, scoped model choices to approved project access,
preserved multiline instructions and delivered evaluation configuration/assets
inside the immutable export. GitHub repository name defaults to the Agent name.
A direct model test is not a deployed-Agent evaluation.

Archived projects must remain unavailable for new builds. Default project lists
show active entries with explicit archived/all filters. Do not revive archived
records to make a demo appear populated.

### Original-account governed production delivery, September 21

This was an actual release-specific run, not proof that every account can deploy.
The owner authorized delegated demo approval; the recording labels it as delegated
automation, not a manual human click or a replacement for the product requirement.

- Agent commit: `6d071782408ea909735255ee18b05a3632457962`.
- Artifact: `8ea96bea9e6e14355684d4059b5fe5e90b0590de4f78b4e152a6cab83cc9d3d0`.
- Execution: `4abc54a9-2d1c-45fe-b02d-160811944966` succeeded through Production.
- Same release verified across Dev v12, Preprod v4 and Prod v3.
- Production business invocation calculated a 30-day notice deadline correctly;
  observed window: 2 invocations, 2044 input tokens, 367 output tokens, 0 errors.
- PR60 fixed CodePipeline's 512-character approval-summary limit by preserving
  the full durable decision and sending a bounded release reference. The first
  approval submission had been unconfirmed; the retry preserved that decision.
- Native identity required a signed custom actor header and an exact Runtime
  allowlist entry. Anonymous persistent-memory access remained rejected.
- English recording covered export, actual local tool edits, AgentCore dev UI,
  tests, GitHub push/CI, promotion and production verification. Older captioned
  drafts and partial development segments are not the final evidence.

### New-account user/access checks, September 25

Real Console tests with temporary Admin, Lead and Builder identities verified
existing-user domain/project membership grants, scoped project visibility,
self-grant403 and immediate access loss after revocation. Test fixtures were
created outside Console, then removed. These checks did **not** prove Console
user creation/invitation, which remains unimplemented.

The permanent owner-requested `platform-admin` was later created in the new pool,
with email suppressed and only platform-admin/domain-platform initially assigned.
Normal login was verified. Passwords are not recorded. Missing demo-operator
membership explained the absent persona dropdown; adding the explicitly requested
membership and signing in again restored all four roles. Do not remove this
permanent operator during test cleanup.

PR67 (`8a235d5`) documents initial administrator and demo role setup. Role groups
must not conflict: adding domain-builder/domain-lead/end-user to an existing
platform-admin is not how demo role switching works.

### Demo Builder workspace initialization

PR68 (`8bc97d3`) adds `platform:initialize:demo-workspaces` plan/apply. It verifies
the target with STS/live stack outputs, validates enabled confirmed demo admins,
and preflights five active deployment-owned starter projects/agents before
conditional additive member writes. Partial failure is resumable; rerunning does
not duplicate grants, replace other members or touch custom project data.

New account: applied five grants, then a repeated plan reported zero. Actual UI
verification found each expected Agent in these project-scoped Builder Fleets:

| Domain | Project | Agent |
| --- | --- | --- |
| Customer Support | case-assist | case-resolution-agent |
| Customer Support | concierge | customer-concierge-agent |
| Customer Support | supportdesk | support-desk-agent |
| Operations | incident-triage | incident-triage-agent |
| Operations | report-runner | operations-report-agent |

All five Memory/KB pages opened in the correct scope, but there are **zero real
Memory/KB bindings** for those starter agents. Do not claim resource readiness.
Focused initialization/README/deployment tests:76 passed; membership/state/seed
regressions:173 passed; PR CI/security checks passed. Browser scripts initially
used stale selectors/readiness assumptions; corrected condition-based checks
passed all five projects. No Agent production deployment was performed here.

### Registry tab correction and remaining source integration

PR65 removes the duplicate post-load tab handler and uses native aria-pressed
buttons. It was deployed as a conditional two-asset patch to the new Console;
all seven actual tabs then matched their lists. Synthetic checks also covered
admin/lead/builder, search refresh and keyboard activation. No data/IAM change.

During cleanup integration, origin/main advanced to `287c681`: PR64 (Gateway
trust test), PR65 (Registry selected-type synchronization) and PR66 (first-user
setup during documented reinstall) are now merged. The cleanup branch was
rebased onto that revision. This confirms source integration, not a new deployment.

## Outstanding gaps and next checks

- Console user creation/invitation and complete first-user workflow are not
  implemented by the membership UI. Initial Cognito bootstrap is separate.
- New-account Memory/KB resources and ingestion are not configured. Agent cards
  and zero binding counts are not evidence of usable memory or knowledge data.
- New-account strict postdeployment audit fails on ControlPlane runtime-boundary
  drift. Investigation found the live IAM policy matched CDK-rendered source,
  while the audit omitted PROVISIONED_NAME_PREFIX expansion and compared another
  Registry-read contract. Default preaudit passed; strict acceptance did not.
  Do not bypass the audit or broaden IAM to make it green without review.
- Owner reports first sign-in failure followed by a successful retry. Three fresh
  sessions (two single clicks and one double click) succeeded with token200/me200;
  runtime callback/logout URLs matched Cognito, and auth tests44/44 passed. The
  intermittent failure is **not reproduced or resolved**.
- `/registry` direct navigation/refresh returned403 XML while `/` returned200.
  This confirmed routing gap is distinct from the unproven login failure cause.
- Do not equate an older runtime-validation deployment API with native immutable
  artifact deployment. Inspect the actual path used by the UI/request.
- Unified ownership tags, Billing activation and full FinOps attribution remain
  proposed work; see the retained English ownership/enforcement documents.
- Single-account success, source portability, clean-account installation and
  a complete new-account GitHub-to-production release are different acceptance
  levels. The entire new deployment is not certified production-ready.

## Evidence and repository hygiene

Owner-local `artifacts/` holds recordings and sanitized verification outputs;
it is not deployed source and should be ignored by Git. Relevant evidence folders
include `account820-reinstallation-20260924`, `console-users-20260925`,
`registry-tabs-account820-20260925`, `login-investigation-20260925`, and
`demo-workspace-initialization-20260925`. Availability depends on the owner's
workspace; do not claim a local path is a portable repository artifact.

Current cleanup removes retired diaries, superseded reviews/plans and screenshot
binaries, retains useful tests under descriptive names, and writes future captures
to ignored artifacts. Keep all maintained repository text in English. Historical
source/evidence can be recovered from the immutable Git revision in the history
index; do not revive old deployment commands as current instructions.

The README now introduces the control/application planes, enterprise ownership,
governance responsibilities and GitHub-first builder journey before L3/L4 maturity.
Removed the obsolete deploy-before-export flow and distinguished hosted Cognito
from local demo login. Cleanup verification: console tests 1,409 passed, 10 skipped;
focused deployment README/service tests 127 passed; 54 E2E scripts syntax-checked.
README local links resolve. These are source checks, not a new cloud deployment.

The owner clarified the README framing using the Enterprise Agentic AI Platform
and AWS Cloud Day 2026 demo presentations. It now starts with the six enterprise
scaling gaps, explains Model + Harness and hybrid ownership, includes the supplied
organization diagram, and positions the demo at Stage 3 of the full four-stage
model. The diagram is a reference topology; its UAT maps to repository preprod.
This documentation revision does not establish new deployment or runtime evidence.

## 2026-09-26 — clean-account console onboarding and navigation guide

- Reinstalled the authorized 820 test deployment from GitHub main `22f6567`.
  Live STS identity was verified before writes; all three application stacks
  (`AgenticPlatform-ControlPlane-Provisioned`, `AgenticPlatform-Web`,
  `AgenticPlatform-DomainBootstrap`) reached `CREATE_COMPLETE`. The current
  ApplicationUrl is `https://dq32k0leo7y4u.cloudfront.net`; prior 820 installation
  URLs and pools are retired. Shared bootstrap and unrelated applications were
  preserved. Infrastructure completion is distinct from full delivery acceptance.
- Created and confirmed a permanent administrator; first hosted sign-in and
  required password change succeeded. No credentials are stored in this file.
- The first demo-operator initialization attempt omitted the documented
  `COGNITO_DEMO_OPERATOR_GROUP` environment variable and failed. Re-running with
  `demo-operator` succeeded. A fresh sign-in displayed all four working roles.
  Applied five starter-project grants for the authorized operator; repeated plan
  returned `operators=1`, `projects=5`, `agents=5`, `plannedGrants=0`.
- Browser navigation confirmed Domain Lead's Customer Support active project list
  (Case Assist, Concierge, Support Desk), Builder workspace choices in Customer
  Support and Operations (Incident Triage, Report Runner), and Blueprint filter
  highlighting consistent with Registry result types. Current reference images
  are maintained in `docs/images/console-guide/` for `docs/console-navigation.md`.
  Opening Case Assist showed one in-development agent, zero deployed agents, and
  no declared memory stores or knowledge bases. Nine screenshots capture these
  reference states; they are not runtime execution evidence.
- Initializer reports zero memory and knowledge-base bindings. Do not describe
  those services as provisioned or their agent behavior as verified. This capture
  does not establish ordinary non-member denial, successful Generate/export,
  local agent development, or end-to-end production delivery acceptance.
- The account billing implementation uses the deployed Lambda role's default
  credentials, not a fixed account ID. Its SERVICE-grouped Cost Explorer query
  has no project-tag filter; other applications' service costs may be included.
- README/setup documentation now links the illustrated Console walkthrough,
  explains the Python packaging prerequisite and distinguishes GitHub token
  delivery from optional OAuth. README contract checks: 42 passed. Strict live
  postdeploy audit remains pending resolution of a manual-provision audit check
  that incorrectly expects the optional GitHub bootstrap execution role; no
  audit-related IAM permissions were weakened during documentation work.

## 2026-09-27 — fresh deployment in account 537

The owner authorized a fresh installation in 537124949553/us-west-2. STS proved
that target before writes. Main `b4c595d` was cloned independently and deployed
through `npm run platform:deploy:clean-account`; ControlPlane-Provisioned, Web
and DomainBootstrap all reached CREATE_COMPLETE. Existing unrelated stacks were
preserved. The existing v30 CDKToolkit needed only termination protection enabled;
its execution policy and resources were not redeployed.

Current console: https://d25vwv5n65rn8x.cloudfront.net. A permanent administrator
was created and completed the actual initial password-change login. Explicit demo
operator reconciliation and all five project grants succeeded; repeated plan
reported zero missing grants. No credentials are recorded here.

Live verification found and reproduced defects now fixed on the verification
branch, with Web redeployment and final acceptance in progress:

- Strict audit rendered a different ControlPlane boundary from CDK, required an
  optional GitHub deployment execution role in manual mode, and rejected IAM names
  truncated by CloudFormation. Audit now renders the committed policy source and
  checks roles via exact stack logical inventory, account ARN, trust, tags and
  boundary. 372 audit tests pass; strict live audit passed against authoritative
  Web and DomainBootstrap templates before the application correction.
- Model-governance's administrator projection dropped the real Tools Gateway and
  region fields, breaking hosted acceptance. Preserve those inventory fields for
  administrators; domain personas retain their redacted response. 20 service/runtime
  tests pass, including the restored administrator fields and domain redaction.
- Hosted Domain Dashboard and project promotion strips called local-only health
  and promotion routes, producing 404s and an unhandled cancellation. Use scoped
  hosted project/agent inventory and production approval records, keep deployment
  status distinct from health, and handle navigation cancellation. Browser route
  regression passes for Lead/Builder; 20 cost/dashboard checks pass.

Actual Compose Generate and GitHub export passed in Platform / IT Helpdesk:
https://github.com/melanie531/account537-builder-verification at initial commit
`fc936e7a60607d70824b7a3c3f26ae2e68d4527f`. All 59 exported files matched the preview;
no project was implicitly created. The exported application ran locally using
537 model credentials and recorded three genuine smoke-scenario transcripts.
Business evaluation was deliberately deferred in the export, so its gate reports
NOT_CONFIGURED. Compliance CI passes; production delivery is not established by
export, transcripts or the configuration-skipped deploy-dev workflow. Memory/KB
bindings remain zero in starter projects; no provisioning or ingestion is claimed.

Private execution evidence is under /tmp/platform537-evidence, outside Git history.
Full source verification initially had seven CDK wiring failures because a concurrent
deploy held cdk.out; sequential rerun passed those seven and 42 README checks. The
console suite had 1,408 passes, one outdated isolated-dashboard fixture failure and
10 skips; the updated fixture and its 20-test suite passed. Final hosted verification
will be recorded separately after redeployment.

### Final checks and remaining acceptance gaps

Both Web corrections deployed successfully. The administrator inventory and
hosted dashboard correction passed the strict postdeployment audit against live
CloudFormation templates. A subsequent frontend-only correction prevents the
hosted governance page from requesting the local-only `/api/memories` endpoint.
The complete console suite now passes: 1,409 passed, 10 skipped, zero failures.
The browser route regression covers administrator governance and Lead/Builder
workspace navigation. Source fixes are tracked in PR #73.

A separately created ordinary Builder, without project membership, received
empty hosted project and agent lists. Attempting to impersonate administrator
using the demo-role request header returned 403. That temporary identity was
deleted; the permanent administrator and explicit demo-operator grants remain.

The repository's canonical `hosted-control-plane-acceptance.mjs` runner still
fails its browser stage: it expects removed `#dcreate` controls and the legacy
`/api/domain-create` flow, while the deployed Domains page mounts the domain
bootstrap wizard. It also expects the old `#regstore` badge. This runner has not
been adapted or bypassed, and full canonical hosted acceptance is not a pass.
Independent browser navigation and real export evidence do not prove every
mutation, invitation, domain provisioning or production release.

The optional AgentDelivery stack was not configured. Its `/api/release-delivery`
route returns 404 and the console explicitly reports that governed delivery is
not configured. The exported repository's compliance run passed; tests and
evaluation failed on the deliberately deferred business evaluation
(`NOT_CONFIGURED`), and deploy-dev skipped its actual deployment step because
AWS delivery credentials/targets were absent. No dev/preprod/prod promotion or
human production approval is claimed. These configuration and acceptance gaps
must be resolved before describing a new installation as a verified production
delivery environment.

Final verification completed on the deployed corrections: 33 browser page
captures, all seven Registry filters, both domains' five workspaces and zero
unhandled page exceptions. The only recorded HTTP failure was the explicitly
unconfigured optional delivery route above. The current domain wizard selected
the signed-in administrator by default and allowed blueprint/model checkbox
selection; its draft was not submitted. All temporary test identities were
removed, leaving the permanent administrator.

The final strict live audit passed after the frontend-only update
(`predeploy-security-audit-2026-09-27T11-02-00-009Z.json`). The complete sequential
serverless suite passed all 3,030 tests and TypeScript compilation. PR checks
passed for source commit `05bc295`. Final private evidence and the acceptance
limitations are summarized in `/tmp/platform537-evidence/VERIFICATION.md`.
