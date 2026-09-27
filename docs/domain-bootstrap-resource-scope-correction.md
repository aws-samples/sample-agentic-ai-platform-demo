# Domain bootstrap resource scope correction

Owner clarification: 2026-09-16. The contract below describes this branch; deployment
evidence and validation limits are recorded in project memory.

## Required relationship

1. Platform owns the complete AI Registry catalog and shared governance.
2. Platform Admin initializes a domain and assigns a set of accessible
   templates, models, tools/MCP and skills from that catalog.
3. Domain Admin creates projects and selects their resources within the
   domain's assigned set.
4. Builders select concrete agent templates/models within the project's set.
   Test and deployment additionally require runtime configuration and policy.

Domain initialization prepares ownership and administrator membership,
account/region/environment bindings, identity and permissions boundaries,
Registry access, inherited controls, telemetry and cost attribution. It creates
zero projects and chooses no agent default template/model.

## Implemented contract

- The domain picker includes every model returned by the registered Gateway
  catalog, regardless of runtime policy readiness. Templates and other native
  Registry resources retain their approval requirements.
- Domain review/execution re-resolve selected references. The model bootstrap
  adapter records catalog access and reports runtime readiness; it does not
  mutate global runtime policies or require quotas to initialize a domain.
- Domain resource access is stored as stable Registry references. Select-all,
  clear, refresh and draft restore operate on this catalog, not copied templates.
- Project creation accepts and persists `resourcePolicy.resources`, a subset of
  the current domain palette. Invalid parent references are rejected before a
  write, and retries recheck parent revocation. Existing projects can inherit
  their domain palette. Explicit subsets require a bootstrapped domain palette.
- The hosted project wizard lets its owner select model/template/tool/skill
  subsets. Build Agent filters its choices by project. The backend rechecks the
  project selection for agent creation/configuration, tests, deployment and FULL
  export. Domain catalog model revocation is rechecked as well.
- Draft configuration uses catalog selection permission. Runtime model access,
  quotas and environment bindings remain required before inference. Existing
  tested-agent prerequisites for FULL delivery are preserved.
- The active Build Agent blueprint journey selects an existing project workspace
  before its template and model. Agent names identify agents inside that workspace;
  they do not implicitly create new projects. Domain-scoped draft model choices
  come directly from Registry even when the runtime Gateway catalog is unavailable.

## Verification

Tests cover independent project subset persistence, references outside the parent
scope, replay after parent revocation, forged schemas, draft selection without
runtime policies and denial before invocation. Hosted acceptance scripts compare
all Registry model IDs to the domain selector, initialize a validation domain,
create two different project subsets, check persisted selections and builder
choices, and exercise direct API scope denials. Actual deployment evidence is
recorded in project memory. The live checks passed with 47 models, 10 templates,
two different project subsets, backend scope denials, and an actual Build Agent
form submission into an existing project without creating another project.
Acceptance also hands validation projects to the persistent domain administrator
and verifies a Builder who is an assigned member, not the temporary creator.
Temporary user cleanup must remove temporary memberships and preserve the
administrator’s access. Runtime governance API and strict postdeploy audit limitations are recorded
separately; no model inference or production agent release was performed.

## Work isolation

Implementation belongs to `fix/domain-registry-catalog` in
`/private/tmp/platform-domain-registry-fix`. Do not modify, merge or push `main`
without a later explicit instruction. The authorized demo remains account
534409838809, us-west-2.
