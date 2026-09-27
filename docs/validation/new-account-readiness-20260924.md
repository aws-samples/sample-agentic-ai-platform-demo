# New-account deployment readiness — 2026-09-24

This is a source, deployment-plan and synthesis verification against main
`607ab2d`, not evidence of a completed deployment in a second AWS account.
The existing demonstration account was not reinitialized.

## Verified

- `npm run platform:deploy:clean-account` checks STS against `AWS_ACCOUNT_ID`,
  deploys the provisioned Control Plane, reads its generated Gateway outputs,
  deploys Web, and passes discovered Web bindings to DomainBootstrap.
- Using synthetic account `111122223333` and `us-west-2`, all three stacks
  synthesized: Control Plane (60 resources), Web (337), DomainBootstrap (20).
  The generated templates contain none of the known existing demonstration
  account IDs (`534409838809`, `217522444267`, `820242898417`). This is a check
  for those identifiers, not a claim that every external integration is portable.
- Web includes baseline domain/project initialization and model-policy seeds.
  Demo Memory and Knowledge Base IDs are optional; this verification supplies none.
  The existing account's Memory/KB IDs are not required to synthesize a fresh stack.
- The deployment workflow contract tests pass (26 tests), including the ordered
  three-stack plan. GitHub export workflows and evaluation assets are repository
  files; their presence does not establish working AWS credentials or deployment.

## Required before a real new-account test

Follow [the serverless runbook](../../infra/serverless-platform/README.md) and
[Control Plane prerequisites](../../infra/platform-registry/README.md).

1. Designate a real target account and credentials; verify it with STS. Use
   `us-west-2`, the currently supported region, and a unique Cognito domain prefix.
2. Install locked dependencies and complete CDK bootstrap and the required security
   assessment/audits. The root wrapper is an ordered deployment command; it does
   not install dependencies, bootstrap the account or run every audit itself.
3. Confirm target-account service availability, model access, quotas and deployment
   permissions. Synthesis cannot validate service-side account admission.
4. Establish the first authorized administrator through the documented identity
   procedure. A provisioned Cognito pool is not a usable administrator session.
5. Verify real login, scoped resource selection, project creation, Generate and
   GitHub delivery. User GitHub authorization is separate from AWS deployment.
6. If end-to-end Agent delivery is required, configure the target's delivery
   roles/artifact storage/pipeline and release approval integration, develop and
   evaluate the exported Agent, then verify each promotion with a real release.

Seeded content does not mean every example Agent, external example tool, Memory,
Knowledge Base or business evaluator is deployed and usable. The new-account
claim remains **not live-verified** until these checks run against a designated
fresh account. Do not reuse the existing deployment as evidence of that claim.

## Registry selection regression

After a successful Registry load, `wireRegistryControls` overwrote the canonical
resource-type click handlers with a list-only refresh. The filter state changed
but the selected chip and page heading remained stale. Removing that overwrite
preserves the original guarded render path. Resource types are now native buttons
with `aria-pressed`, a visible selected underline/background and keyboard focus.
The browser regression uses the actual application with synthetic AWS-shaped
responses and checks Admin, Domain Lead and Builder; it is not a live login test.
