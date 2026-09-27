# Domain bootstrap deployment

The hosted Domains page creates a business domain with zero projects. Platform
Admin selects Registry references and an existing administrator identity. The Domain
Admin creates projects after the foundation is ready.

This feature has an independent `AgenticPlatform-DomainBootstrap` stack attached
to the existing Web HTTP API, JWT authorizer, Cognito pool and state table.
It does not redeploy `AgenticPlatform-Web`.

## Current scope

- Paginated domain/project overview with ownership; Registry-backed setup wizard.
- Durable bootstrap operation with reviewed configuration hash, step status and
  retry of the same reviewed selections.
- Existing domain Registry/group creation, Domain Lead group assignment, and
  domain resource palettes and independent project resource subsets.
- AgentCore Runtime foundation adapter in the connected account/region:
  per-environment scoped telemetry role, permissions boundary and log group.
- Domain Admin dashboard displays recorded foundation readiness.

The runtime role supplies telemetry only. Application runtime deployment,
tool adapters/credentials, application guardrail bindings, project template
consumption and repository CI/CD remain project integration work. This feature
does not implement account vending, cross-account trust or the production CD
human approval gate.

## Registry and identity prerequisites

Bootstrap reads approved current resource definitions from the hosted Registry API. It stores
resource identity/version references and an immutable execution snapshot; it does
not copy a second catalog into the Domains UI. Registry refresh updates selectable
definitions without silently changing an applied environment.

Domain initialization prepares AWS environment foundations, not an agent. It
requires no agent blueprint or model. The Registry page selects an optional set
of approved blueprints, models, tools/MCP servers and skills for the domain's
future projects. All categories allow multiple selections. A project chooses an
agent blueprint later and validates its application-specific dependencies then.

An unrelated unreadable Registry record is reported but does not block environment
initialization. Every selected resource must still resolve to its exact readable,
approved version at review and execution; an unavailable selection fails closed.
Every Gateway-registered model can be included in the domain palette. Bootstrap
does not create or modify global model runtime policies, quotas or other domain
memberships. Runtime configuration is reported separately and is checked before
model invocation and deployment.

`GET /api/registry` includes all Gateway-discovered models. Model-policy metadata
is read only to describe runtime readiness; it does not restrict domain catalog
selection. Non-model Registry resources still require their published approval.
All registered models appear in the wizard, with multiple selection, select-all
and clear controls. Selected references are resolved again at review/execution.

Domain Admins create projects with a `resourcePolicy` containing a subset of the
domain's resource references. This is persisted atomically with the project and
validated server-side against the current parent policy. Builders only see and
can configure resources from that project subset. Tests, deployment and FULL
export also recheck project scope; runtime model policy remains a separate gate.
Existing project records without `resourcePolicy` inherit domain access. Existing
domains without a bootstrap catalog policy retain their established inherited
behavior; explicit subsets require an authoritative domain palette.

### Publish baseline template sources in an existing account

Web deployment does not republish records in a referenced shared Registry.
After updating this repository, use the explicit baseline release command for
the approved platform-owned templates. New-account provisioning uses the same
`buildSeedRecords` definitions automatically.

```sh
export AWS_ACCOUNT_ID="<verified account>"
export AWS_REGION="us-west-2"
export BLUEPRINT_RELEASE_PLAN_FILE="/private/tmp/platform-blueprint-release.json"
npm run blueprints:plan
# Inspect the exact new versions and sources in the saved plan, then:
npm run blueprints:publish
```

Version 1.3.0 publishes explicit sources for every baseline blueprint. The
recommended Chat Assistant and Workflow Orchestrator use the real Strands +
AgentCore projects at `blueprints/chatagent` and `blueprints/workflowagent`.
Their model is selected from the domain's allowed set during agent setup.
External framework references and illustrative examples are labelled as such.
The publisher creates immutable versions, preserves existing Registry/name
identities and old versions, refuses conflicting or pending existing versions,
and checks the account, control-plane ownership and saved plan before writes.
It is a trusted baseline deployment operation, not a way to approve user
submissions. It never approves a model or changes model limits.

If an older installation also has repository baseline copies in the platform
Registry, repeat plan/publish with `BLUEPRINT_RELEASE_SCOPE=platform` and a
separate plan file. This mode updates only recognized existing baseline copies,
preserving their platform scope and resource identity; it creates no new copies.
Custom submissions and unrecognized records are not adopted by this migration.

Blueprint/tool/skill selections create audited workspace grants. A versioned
policy under `GRANT#<domain>/CATALOG#POLICY` limits shared resources exposed in
that domain's Registry, builder and export inventory. It stores resource identity
references, not copied template content, and follows current approved defaults.
Existing domains without this policy retain their established behavior. Domain
Admin revocations remain effective; initialization retries do not restore them.

The selector lists the actual Cognito user directory, including name, username,
email and existing role. Enabled users with exactly one permanent `platform-admin`
or `domain-lead` persona are eligible. Disabled users and incompatible/ambiguous
roles are shown as unavailable. The signed-in Platform Admin is selected by
default; the optional business owner defaults to the chosen administrator.
Refreshing users preserves the draft.

Bootstrap binds the selected username and immutable subject to the reviewed plan
and adds only the new domain group. Platform Admins retain their global access;
the service does not add a second permanent role, change existing roles, create
credentials or send invitations. A simulated admin persona cannot authorize
bootstrap writes without permanent platform administrator membership.

All four pages remain navigable with Registry prerequisites outstanding. The
preview endpoint returns `ready: false` with blockers and no authorization hash.
Review shows the configuration, disables Bootstrap and offers Check again.
Strict validation is repeated by submission; a client cannot bypass a failed
review. A failed prerequisite does not create an operation. Registry creation
may exceed the domain API polling window: the workflow retries the same durable
request and Registry ARN instead of treating normal CREATING latency as a final
failure. Environment CloudFormation creation is also polled asynchronously.

## Deploy

Follow the existing [deployment runbook](README.md), including STS account
verification and its predeployment audit. Discover bindings from the live Web
stack and API resources, and write a local target JSON:

```json
{
  "accountId": "<verified account>",
  "region": "us-west-2",
  "apiId": "<existing HTTP API>",
  "authorizerId": "<existing JWT authorizer>",
  "tableName": "<existing platform state table>",
  "userPoolId": "<existing Cognito pool>",
  "catalogRoleArn": "<verified Registry reader Lambda execution role ARN>",
  "functions": {
    "admin": "<existing PlatformAdminApi function>",
    "catalog": "<existing ControlPlaneReadApi function>"
  }
}
```

From this directory, set `AWS_ACCOUNT_ID` and
`DOMAIN_BOOTSTRAP_TARGET_FILE` to the verified account and the JSON path. Run:

```sh
npx cdk diff --app 'node --import tsx bin/domain-bootstrap.ts' --no-change-set
npx cdk deploy --app 'node --import tsx bin/domain-bootstrap.ts'
```

Review the changes before deployment. The stack adds a scoped policy read to the verified Registry reader role and owns five authenticated routes
under `/api/domain-bootstrap`, one Lambda, an ordered Step Functions workflow and
scoped IAM policies. Its stack and provisioned domain stacks have termination
protection; environment logs/roles are retained.

For an existing frontend with concurrent changes, retrieve and back up its current
`modules/app.mjs`, then three-way merge only this branch's integration patch.
Upload `domain-foundation-catalog.mjs` and `domain-bootstrap-view.mjs` before the
merged app module. Use conditional S3 writes against the inspected ETag, preserve
runtime configuration, invalidate those three CloudFront paths and verify the
served bytes. Do not upload the whole worktree over concurrent changes.

## Verify

From the repository root:

```sh
node --test infra/serverless-platform/test/domain-bootstrap-service.test.mjs \
  infra/serverless-platform/test/domain-bootstrap-model-access.test.mjs \
  infra/serverless-platform/test/domain-bootstrap-directory.test.mjs \
  infra/serverless-platform/test/domain-bootstrap-resource-access.test.mjs
node e2e/domain-bootstrap-ui.mjs
```

`e2e/domain-bootstrap-hosted.mjs` defaults to a read-only four-page acceptance probe.
It uses an actual Cognito Platform Admin session with no pre-created Domain Lead.
It checks the real directory, default administrator, name-only continuation,
Registry selections, refresh/back controls, saved-draft reload, all environment
selections and executable review without submitting bootstrap. The local UI
probe additionally exercises blocked readiness and rechecking.
Set `DOMAIN_BOOTSTRAP_APP_URL`, `AWS_ACCOUNT_ID`,
`DOMAIN_BOOTSTRAP_IDENTITIES_FILE` and `DOMAIN_BOOTSTRAP_EVIDENCE_DIR`.
The identity file contains `{admin:{username,tokens}}`; `tokens` has
`accessToken`, `idToken`, and epoch-millisecond `expiresAt`. Keep this file private
and temporary. Provision test identities without notification, remove them after
testing, and never commit tokens/passwords.
Optionally set `DOMAIN_BOOTSTRAP_EXPECT_USER` to verify that a particular existing
directory user is visible, selectable and preserved across refresh.

Set `DOMAIN_BOOTSTRAP_SELECT_ALL=true` to assert that every Registry model appears
in the wizard and survives select-all, refresh, draft restore and review.
`e2e/project-resource-scope-hosted.mjs` verifies two distinct project subsets,
builder filtering and direct API denial of resources outside those subsets.

Once Registry and administrator prerequisites are met, complete live acceptance
must additionally verify all six workflow steps, actual group membership,
policy access, CloudFormation outputs, reload/retry and Domain Admin handover.
Passing prerequisite validation is not evidence of completed provisioning.

For an explicitly authorized live initialization test, set
`DOMAIN_BOOTSTRAP_SUBMIT=true` and `DOMAIN_BOOTSTRAP_TEST_DOMAIN` to a clearly
identified validation domain. This creates a real domain Registry, grants,
administrator membership and retained environment stack (dev/preprod/prod).
The probe waits for all six steps, verifies zero projects and reload, and saves
the operation as evidence. It does not approve models or create an application.
Retained resources and ownership must be accounted for after the test.

For the handover, supply a `lead` session in the same private identity file and
run `node e2e/domain-bootstrap-handover.mjs` from the repository root with
`DOMAIN_BOOTSTRAP_DOMAIN_ID` set to the initialized empty validation domain.
Optionally set `DOMAIN_BOOTSTRAP_OTHER_DOMAIN` to check cross-domain denials.
This read-only probe verifies the exact authorized resource set, zero projects,
the Domain Admin foundation dashboard and the Create project entry point.

The shared Registry, builder and journeys Lambda source also consumes the domain
resource policy. Deploy those consumers with the initialization service; changing
only the UI does not enforce domain resource access. On an existing deployment,
review differences against live packages and preserve unrelated changes. The
legacy MCP compatibility adapter reads the old native descriptor shape without
changing its ownership or approval status.
Resource policies retain the AWS Registry/name identity across version changes
and normalize scoped display aliases to the granted ID. This matters when the
platform-wide catalog qualifies duplicate aliases but a single-domain catalog
does not. Immutable AWS record IDs still identify the exact reviewed version.
