# Serverless Platform Deployment

## Stage 1 scope

Stage 1 deploys:

- private S3 frontend storage served through CloudFront Origin Access Control;
- CloudFront HTTPS delivery for the console and `/api/*`;
- Cognito hosted authentication with the authorization code flow and PKCE;
- public `GET /api/health`;
- Cognito JWT-protected `GET /api/me`;
- task-specific IAM permissions boundaries on execution and provider roles, with
  the separately audited hosted-acceptance verifier role intentionally unbounded.

GitHub OIDC deployment is disabled by default. This private repository does not
currently support protected `main` governance, and the current GitHub token is
not an administrator token. Do not deploy `GitHubBootstrapStack` for this
target. Deploy the selected control-plane physical stack before
`PlatformWebStack` with an approved AWS identity.
GitHub deployment remains disabled until an administrator attests protected
`main` governance for a different eligible repository and explicitly deploys
the bootstrap stack.

The remaining application data APIs are not migrated in Stage 1; hosted domain
provisioning and Registry governance are AWS-backed and are no longer among
those remaining APIs. Other application panels whose routes have not yet
migrated may still be empty.

Every taggable resource must have these tags exactly:

- `auto-delete=no`
- `project=agentic-ai-platform-demo`
- `managedBy=cdk`

## Clean-account deployment

`PlatformWebStack` consumes stable exports from the ControlPlane and must not be
deployed first. For a new account, use the ordered root command:

```bash
export AWS_ACCOUNT_ID="<account-id>"
export AWS_REGION="us-west-2"
export COGNITO_DOMAIN_PREFIX="<globally-unique-prefix>"

npm run platform:deploy:clean-account
```

Run it after installing the locked root, `infra/platform-registry`, and
`infra/serverless-platform` dependencies and after the required security
assessment. It verifies the AWS caller, deploys
`AgenticPlatform-ControlPlane-Provisioned`, reads the generated LLM Gateway ID
and region, and supplies them to `PlatformWebStack`. Provision mode creates its
own Registry resources, AgentCore Gateways, inference targets, and runtime
permissions boundary.

CloudFormation's `AWS::IAM::ManagedPolicy` resource does not expose a `Tags`
property, so `Custom::RuntimePermissionsBoundaryTags` uses the dedicated
`AgenticPlatform-Web-RuntimeBoundaryTagProviderRole`. That role uses the runtime permissions boundary
`AgenticPlatform-Web-RuntimePermissionsBoundary`. Execution roles use the shared
runtime, Bedrock consumer, Operations, or read-only Policy inventory boundary
selected in CDK for their responsibilities. The separate unbounded
`AgenticPlatform-Web-HostedAcceptanceRole` is included in post-deployment
effective-policy auditing and must have no permissions boundary. The
tag provider can call only `ListPolicyTags`, `TagPolicy`, and `UntagPolicy` on
the exact root-path
`AgenticPlatform-Web-RuntimePermissionsBoundary` and
`AgenticPlatform-Web-PolicyInventoryBoundary` policy ARNs. The provider
validates that ARN and the exact `auto-delete=no`,
`project=agentic-ai-platform-demo`, and `managedBy=cdk` contract before reading
or mutating tags. Reconciliation is idempotent, rejects malformed, duplicate,
or paginated tag output, removes drift tags, and repairs required values. On
Delete it preserves tags because the managed policy is retained. The security
audit uses `list-policy-tags` and fails closed unless the retained boundary has
the exact mandatory tags.

## Registry governance state retention

Registry decision request claims, request results, semver-scoped record locks,
and immutable audit evidence are permanent governance records. Each omits the
DynamoDB `expiresAt` attribute and is not removed by TTL, so a later retry
remains bound to the original authoritative Registry record and revision.
Domain-create workflow records remain separate and retain their 24-hour TTL.

Governance records are removed only through a deliberate, reviewed retention
procedure after the applicable audit-retention requirement has ended and no
retry can remain valid. That procedure must treat the request result, record
lock, and audit evidence as one decision history; deleting only part of that
history is unsupported. The retained table and point-in-time recovery protect
these records from stack replacement or accidental deletion.

## Hosted domain provisioning and onboarding

`POST /api/domain-create` is a real control-plane mutation. It creates one
dedicated AWS Agent Registry for the domain, applies the mandatory project
tags, and persists the authoritative domain item in `PlatformStateTableName`.
`GET /api/domains` reads that persisted state, so a successful domain remains
visible after a browser reload.

Every domain creation creates or reconciles an operation-bound Cognito owner
group before committing the Registry and DynamoDB domain state. The response
continues to expose `ownerGroup` as a string alongside the real `registryId`
and `registryArn`. Domain creation does not create Cognito users and does not
create or assign memberships. Assigning builders to `ownerGroup` remains a
separate, explicit onboarding operation after the platform administrator
reviews the new domain.

Baseline domain groups are CDK-created. Dynamic Cognito groups are not
taggable, so their ownership is carried in a strict versioned description
marker that binds the group to the domain-create operation and includes
`auto-delete=no`. All taggable resources retain the exact required tags.
Rollback and hosted-acceptance cleanup delete only the exact empty
operation-owned group, and delete it before Registry and DynamoDB state.
Marker mismatch, malformed ownership, a non-empty group, or inability to
confirm absence fails closed.
The hosted console therefore reports:

```text
Domain <name> is active with Agent Registry <registryId>. Assign Cognito group <ownerGroup> to onboard builders.
```

Hosted Registry decisions are authoritative AWS mutations. The console
requires `approveRegistryVersion`, sends an explicit request ID, refreshes
`GET /api/registry`, keeps the selected entry and version drawer open, and
shows the refreshed `APPROVED` or `REJECTED` status. Registry request claims,
results, semver locks, and immutable audit evidence use the permanent
governance retention described above. The hosted UI does not substitute a
local JSON file for domain or Registry state.

## Starter builder model policy

`PlatformWebStack` requires the `starterBuilderModelId` CDK context. The
checked-in default is
`bedrock-claude/anthropic.claude-haiku-4-5`. The deployment fails closed if
that exact model is absent from the live AgentCore Gateway catalog.

To select another live Gateway model, use the CDK context override below and
pass the same value to every later `PlatformWebStack` diff and deploy:

```bash
npm --prefix infra/serverless-platform run synth -- \
  PlatformWebStack \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}" \
  -c "starterBuilderModelId=<gateway-model-id>"
```

The deployment seed grants the starter model to `platform`, `customer_support`
and `operations` with native AgentCore Gateway rate limits. It preserves an
existing compatible policy and refuses to overwrite a conflicting
administrator-managed policy. Newly created domains remain default-deny until
an administrator assigns a model policy.

Existing demo resources can be attached without hard-coding account-specific
IDs. Pass any applicable values to every synth, diff, and deploy:
`demoItHelpdeskMemoryId`, `demoSupportDeskMemoryId`, and
`demoReportRunnerKnowledgeBaseId`. Omit a context when that target account does
not have the resource; the corresponding Agent remains unbound.

An existing deployment-owned starter policy with the original two business
domains and unchanged baseline limits is migrated to include `platform`.
Administrator-owned or customized policies are never silently expanded.
Both `bedrock-claude/anthropic.claude-haiku-4-5` and
`bedrock-mantle/anthropic.claude-haiku-4-5` resolve to the supported Haiku
inference profile for tests and exported repositories. Catalog presence alone
does not grant invocation permission.

### Builder and governance acceptance

Deploy the complete Web stack, including Lambda packages, routes, permissions
boundaries and static assets. A frontend-only upload cannot repair a failing
model inventory or enable hosted exception requests.

After deployment, sign in and verify these authenticated workflows:

1. Create or select a project with an approved runnable blueprint and the
   configured starter model. Step 2 of **Build an Agent** must offer that model.
2. Generate the agent construct and reach **Review & export**. Verify the selected
   project, model, instructions and evaluation assets in the repository preview.
   This step does not deploy an agent; a direct model call is not an agent test.
   After local development and a real runtime deployment, verify invocation,
   evaluation and usage evidence separately.
3. Create the **FULL** repository preview and download its ZIP. Verify its
   manifest fingerprint, extract it, and follow its `AGENTS.md`. Direct GitHub delivery supports a caller-owned
   classic token by default; browser OAuth is an optional integration. See
   [Builder GitHub setup](../../docs/github-builder-setup.md) for the dedicated
   OAuth App, callback, secret format and real export acceptance procedure.
4. In Governance, verify the Guardrails catalog contains controls, and that
   `/api/governance/runtime-policies` still reports actual Gateway attachments.
5. Submit a configurable guardrail exception against a real project. Verify
   self-review is rejected, independent review is recorded, and revocation and
   expiration remove approval eligibility. Mandatory controls are ineligible.
6. Submit a blueprint draft and publication request. Use another authorized
   reviewer to decide it; refresh to verify durable state.

The exception routes are `GET /api/policy-exemptions`,
`POST /api/policy-exemption-request`, and `POST /api/policy-exemption-decide`.
Records and decision history reside in the retained platform state table.
The API enforces membership, expiration, immutable request IDs and revision
checks. Business-domain requests require domain review followed by a different
platform reviewer. Platform-domain requests require an independent platform
reviewer. Approval does not itself install or weaken a runtime guardrail:
configuration changes must still pass the project's delivery controls.

Fresh deployments ship the actual guardrail catalog and working request
forms. Queues start empty until users submit requests; no fictional approvals
or model responses are seeded. Production delivery still requires a real human
decision tied to the exact release and target.

The CloudFront invalidation provider validates `CreateInvalidation`, then polls
`GetInvalidation` while the status is `InProgress` until it is `Completed`.
Only those two documented statuses are accepted; malformed or unknown responses
and exhaustion of the bounded polling window fail closed. Both APIs are scoped
to the stack's exact distribution ARN. The `PlatformWeb` stack identity and
CloudFront distribution ID are embedded in the alarm name so each deployment
has its own deterministic alarm and ARN.

CloudFormation response delivery accepts only a `2xx` status and resolves only
after the response ends. A non-2xx status, request or response-stream error, or
bounded 10-second upload timeout fails closed without exposing the signed
response URL. Invalidation polling also reads the Lambda remaining-time
deadline and preserves a 45-second reserve for final AWS call handling and the
response upload before every sleep and poll call; the bounded attempt limit
remains a second stop condition.
`SUCCESS` retries reuse the identical operation result and
`PhysicalResourceId`, up to three attempts. If every SUCCESS
upload fails, it attempts `FAILED` with the exact operation result and
`PhysicalResourceId`; operation failures preserve the existing event identity.
Delivered responses do not rethrow, terminal delivery failures are logged
generically, and both provider Lambdas use zero Lambda retries to prevent
mutation replay.
Both `CreateInvalidation` and `GetInvalidation` use an `AbortController` and
forward its `abortSignal` through a 20-second maximum per-call deadline clipped
to the available remaining time. A call starts only when that deadline can
preserve the full response reserve, and every request timer is cleared.
The future CloudFormation execution role limits the event-invoke configuration
`Get`, `Put`, and `Delete` actions to `AgenticPlatform-Web-*` function ARNs.

For the replacement transition, the alarm provider role and runtime boundary
allow only
`PlatformWeb-AgenticPlatform-Web-*-CloudFront-5xx`, which covers the old and
new distribution-specific names. Exact event `AlarmArn` and
`PhysicalResourceId` binding plus ownership verification remain mandatory
before mutation. CloudFront invalidation permissions remain scoped to the exact
distribution ARN and are never broadened by this alarm transition.

The alarm provider calls `ListTagsForResource` on that exact ARN before either
`PutMetricAlarm` or `DeleteAlarms`. Existing alarms are considered owned only
when both immutable markers match: `project=agentic-ai-platform-demo` and
`managedBy=cdk`.
Initial Create proceeds only after proven absence. An in-place Update requires
`PhysicalResourceId` to equal the current alarm name, requires that alarm to
exist, and proves ownership before mutation. A replacement Update requires
`PhysicalResourceId` to exactly match `OldResourceProperties.AlarmName`,
validates the old alarm ARN and requires the old name to differ from the new
alarm name, then creates and tags the new alarm only when its exact ARN is
absent. CloudFormation later sends an old-resource Delete.

For absence-only Create and replacement Update, the provider validates
`event.RequestId` as a non-empty, bounded, tag-safe string and atomically adds
the provider-owned `cloudFormationRequestId=<event.RequestId>` tag. When lookup
finds an existing alarm, normal `project` and `managedBy` ownership must be
proven first. Only the exact same-request marker is accepted idempotently with
no put, tag, untag, or delete mutation. A missing, duplicate, malformed, or
different marker remains a collision, and a matching marker never substitutes
for ownership.

Every Delete requires `PhysicalResourceId` to equal the Delete event AlarmName
before any lookup. Absence is a no-op; a present alarm must be owned before
deleting only that name. The internal request marker does not block deletion.
Only the exact ResourceNotFoundException classification counts as absence.
Malformed or conflicting tags and all other lookup errors fail closed before
any put, delete, tag, or untag mutation.
For Create and replacement Update, `PutMetricAlarm` receives the full exact
`RequiredTags` set plus the internal marker in its `Tags` field so alarm
creation and tagging are atomic. `RequiredTags` remains exactly the three
user-visible tags `auto-delete=no`, `project=agentic-ai-platform-demo`, and
`managedBy=cdk`; the provider-owned request marker is separate. An in-place
Update omits `Tags` from `PutMetricAlarm`, retains ownership-first tag
reconciliation, and may remove the internal marker as drift. Tag keys remain
non-empty, while empty values on current non-ownership drift tags are valid and
removable during reconciliation.

Do not commit the current AWS account ID, passwords, tokens, client secrets, or
account-specific outputs. Use `<account-id>`, `<owner/repo>`, and
`<unique-cognito-prefix>` in committed documentation.

## Prerequisites and target confirmation

Run every `bash` block with Bash 3.2 or newer. Do not paste the blocks into zsh
or another shell. Required tools and access are:

- Bash 3.2+;
- Node.js 22;
- Python 3.10+ with pip, or a running Docker daemon, for Registry Lambda bundling
  in the combined clean-account deployment; check `python3` in the deployment shell;
- AWS CLI credentials for the intended account;
- CDK bootstrap status confirmed in `us-west-2`;
- repository write permission for branch and workflow changes;
- repository admin permission, or help from an admin, to set Actions variables.

Run these commands from the repository root:

```bash
set -euo pipefail

export AWS_ACCOUNT_ID="<account-id>"
export AWS_REGION="us-west-2"
export GITHUB_REPOSITORY="<owner/repo>"
export GITHUB_REPOSITORY_ID="<repository-id>"
export GITHUB_REPOSITORY_OWNER_ID="<repository-owner-id>"
export GITHUB_WORKFLOW_REF="${GITHUB_REPOSITORY}/.github/workflows/deploy-serverless-platform.yml@refs/heads/main"
export GITHUB_OIDC_SUBJECT_MODE="<legacy-or-immutable>"
export GITHUB_OIDC_SUBJECT="<exact-attested-main-subject>"
export COGNITO_DOMAIN_PREFIX="<unique-cognito-prefix>"
export CONTROL_PLANE_MODE="<reference-existing-or-provision>"

if (( BASH_VERSINFO[0] < 3 || (BASH_VERSINFO[0] == 3 && BASH_VERSINFO[1] < 2) )); then
  printf 'Bash 3.2 or newer is required.\n' >&2
  exit 1
fi
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "22" ]]
[[ "$AWS_REGION" == "us-west-2" ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
[[ "$COGNITO_DOMAIN_PREFIX" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
GITHUB_REPOSITORY_PATTERN='^[^/[:space:]]+/[^/[:space:]]+$'
[[ "$GITHUB_REPOSITORY" =~ $GITHUB_REPOSITORY_PATTERN ]]
[[ "$GITHUB_REPOSITORY" != *"<"* && "$GITHUB_REPOSITORY" != *">"* ]]
[[ "$GITHUB_REPOSITORY_ID" =~ ^[1-9][0-9]*$ ]]
[[ "$GITHUB_REPOSITORY_OWNER_ID" =~ ^[1-9][0-9]*$ ]]
[[ "$GITHUB_WORKFLOW_REF" == "${GITHUB_REPOSITORY}/.github/workflows/deploy-serverless-platform.yml@refs/heads/main" ]]
case "$GITHUB_OIDC_SUBJECT_MODE" in
  legacy)
    EXPECTED_GITHUB_OIDC_SUBJECT="repo:${GITHUB_REPOSITORY}:ref:refs/heads/main"
    ;;
  immutable)
    GITHUB_REPOSITORY_OWNER="${GITHUB_REPOSITORY%%/*}"
    GITHUB_REPOSITORY_NAME="${GITHUB_REPOSITORY#*/}"
    EXPECTED_GITHUB_OIDC_SUBJECT="repo:${GITHUB_REPOSITORY_OWNER}@${GITHUB_REPOSITORY_OWNER_ID}/${GITHUB_REPOSITORY_NAME}@${GITHUB_REPOSITORY_ID}:ref:refs/heads/main"
    ;;
  *)
    printf 'GITHUB_OIDC_SUBJECT_MODE must be legacy or immutable.\n' >&2
    exit 1
    ;;
esac
[[ "$GITHUB_OIDC_SUBJECT" == "$EXPECTED_GITHUB_OIDC_SUBJECT" ]]
case "$CONTROL_PLANE_MODE" in
  reference-existing)
    : "${CONTROL_PLANE_SHARED_REGISTRY_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_REGISTRY_PLATFORM_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_REGISTRY_OPERATIONS_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_LLM_GATEWAY_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_LLM_GATEWAY_REGION:?Required for reference-existing.}"
    : "${CONTROL_PLANE_TOOLS_GATEWAY_ID:?Required for reference-existing.}"
    ;;
  provision)
    for variable_name in \
      CONTROL_PLANE_SHARED_REGISTRY_ID \
      CONTROL_PLANE_REGISTRY_PLATFORM_ID \
      CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID \
      CONTROL_PLANE_REGISTRY_OPERATIONS_ID \
      CONTROL_PLANE_LLM_GATEWAY_ID \
      CONTROL_PLANE_LLM_GATEWAY_REGION \
      CONTROL_PLANE_TOOLS_GATEWAY_ID
    do
      [[ -z "${!variable_name:-}" ]]
    done
    ;;
  *)
    printf 'CONTROL_PLANE_MODE must be reference-existing or provision.\n' >&2
    exit 1
    ;;
esac

node --version
aws --version
aws sts get-caller-identity

CALLER_ACCOUNT="$(
  aws sts get-caller-identity \
    --region "$AWS_REGION" \
    --query Account \
    --output text
)"
[[ "$CALLER_ACCOUNT" == "$AWS_ACCOUNT_ID" ]] || {
  printf 'Caller account %s does not match AWS_ACCOUNT_ID.\n' \
    "$CALLER_ACCOUNT" >&2
  exit 1
}
```

The provisioned ControlPlane stack creates and owns its runtime permissions
boundary. Neither deployment mode accepts an external boundary ARN.

Stop if any target value is wrong. `GITHUB_REPOSITORY` must name the repository
at the clone's `origin`; the repository audit below enforces the exact match.
The Cognito prefix check is identical to the workflow check and rejects
`<unique-cognito-prefix>`. Use the audit modes in the one-time bootstrap section
to classify `CDKToolkit`. Do not use a suppressed AWS CLI failure as proof that
the stack is absent.

Choose one exact protected-main subject contract:

- legacy mode: `repo:<owner/repo>:ref:refs/heads/main`
- immutable mode:
  `repo:<owner>@<repository-owner-id>/<repo>@<repository-id>:ref:refs/heads/main`

The chosen mode and exact subject must be identical in the operator environment,
repository variables, deploy-phase audit, and CDK bootstrap contexts. Never
infer, translate, or broaden the selected value.

GitHub OIDC subject defaults depend on repository age. Repositories created
before July 15, 2026 retain legacy subjects unless administrators explicitly
opt in to immutable subjects. Applying an organization claim template may also
require repository-level OIDC claim-template configuration such as
`use_default=false`; organization templates do not automatically change every
repository. Inspect the repository's current OIDC settings and choose the mode
deliberately. There is no automated migration in this workflow. A wrong mode or
exact value fails closed in CDK validation, the deploy-phase audit, or IAM role
trust.

## Mandatory pre-deployment security audit

The repository command below is the portable enforced gate. It runs in the
GitHub workflow after OIDC account verification, before diff or deploy, and
again in strict target-state mode immediately after the web deployment. Run
the default mode again in the current Bash shell immediately before every
bootstrap-stack or application diff/deploy, then run `postdeploy` immediately
after the web deployment. Before a CDK bootstrap, run the applicable
`bootstrap-new` or `bootstrap-remediate` command in the one-time section.

```bash
set -euo pipefail
npm --prefix infra/serverless-platform run security:audit
```

The repository gate makes only read-only AWS calls. It validates
`AWS_ACCOUNT_ID`, `AWS_REGION=us-west-2`, and a real `GITHUB_REPOSITORY`;
compares that repository with the normalized HTTPS or SSH GitHub `origin`;
rejects the root caller; inspects GitHub OIDC providers; and checks `CDKToolkit`
termination protection and the `/cdk-bootstrap/hnb659fds/version` bootstrap
version when the stack exists. When `ENABLE_GITHUB_DEPLOYMENT=true`, it also
validates `CONTROL_PLANE_MODE`, the selected physical control-plane stack, its
six stable identifier exports, and exact mandatory stack tags. In
`reference-existing` mode the outputs must match the six protected repository
variables exactly; in `provision` mode those variables must be empty. The audit
uses the resolved exports to verify PlatformWeb resources, the twenty-five
boundary-constrained runtime roles at their exact ARNs, and the separate
hosted-acceptance verifier role's exact effective policy.

Manual provisioned deployments also require runtime verification in `postdeploy`
mode. The dedicated `AgenticPlatformCloudFormationExecutionRole` belongs to the
optional GitHub deployment bootstrap and is checked only when
`ENABLE_GITHUB_DEPLOYMENT=true`. Manual deployment still checks the provisioned
Control Plane boundary, its runtime roles and the Web runtime contracts. The
current Control Plane boundary contract is rendered from the same policy source
as CDK; legacy policies are accepted only in the documented deploy transitions.

`SECURITY_AUDIT_MODE` controls the required toolkit state:

- `deploy` is the default. It requires an existing supported `CDKToolkit` with
  termination protection enabled and validates the currently deployed stack
  contract. It accepts the exact Task 5 target, the exact Task 3 predecessor,
  the exact previously deployed transaction-authorization policy for the
  Governance API role, Platform Admin API role, Registry decision finalizer
  role, or runtime permissions boundary, or three exact broker-policy
  predecessors: the target without the actor-bound entitlement recovery query,
  the target whose endpoint read still names only the production endpoint, or
  the target whose experience fixture transaction still uses the ineffective
  `dynamodb:TransactWriteItems` IAM action instead of transaction-scoped
  underlying item actions. It also accepts three exact Registry workload
  identity cleanup predecessors: the cleanup statement is absent, it names
  only the generated `registry-*` workload identity child, or it names only the
  exact default directory. The transaction-authorization predecessors may
  coexist because they describe the same pending rollout. Broker-policy
  predecessors cannot be combined with one another.
  No other predecessor is accepted. The Task 3
  predecessor requires all eight prior runtime roles, the retained platform
  state table with TTL enabled, the seed role's exact effective policy, and the
  prior broad platform-state
  `AgenticPlatform-Web-PlatformAdminApiRole` inline policy. Its deployed
  boundary must equal the exact source-declared Task 3 predecessor; neither the
  finalizer role, the hosted acceptance broker role, nor either retained log
  group may already exist in that predecessor. The hosted acceptance broker
  function/output and `AgenticPlatform-Web-HostedAcceptanceRole` are also
  planned target resources and may be absent only in this exact deploy-mode
  predecessor.
- `postdeploy` requires the current synthesized CDK IAM contract. The CLI reads
  `cdk.out/PlatformWebStack.template.json` by default; set
  `SECURITY_AUDIT_WEB_TEMPLATE` when using another assembly directory. Use the
  template produced by the same checkout, context and build as the deployment.
  Missing templates, unsupported intrinsic expressions and incomplete inventories
  fail closed. The checker first compares deployed IAM template resources with
  the local source template, then verifies live trust policies, required tags,
  exact inline/attached policy inventories and contents, boundary bindings and
  default managed-policy versions. It checks all 26 bounded Web roles plus the
  separately constrained HostedAcceptanceRole. Runtime and Builder use the
  Bedrock consumer boundary when profiles are configured; Operations and Policy
  Inventory have their own boundaries. No role is forced onto the shared boundary.
  If the existing DomainBootstrap stack grants permissions to a Web role, synthesize
  that stack with its actual target bindings and set `SECURITY_AUDIT_DOMAIN_TEMPLATE`
  to its `DomainBootstrapStack.template.json`. The checker verifies that source
  against the deployed DomainBootstrap IAM template and includes the exact
  cross-stack grants. An extra live policy is never accepted by name alone.
  Shared runtime boundary, table TTL, account/region, toolkit and GitHub deployment
  checks remain mandatory according to the selected deployment configuration.
  The postdeployment source contract accepts no predecessor permissions.
- `bootstrap-new` requires `CDKToolkit` to be absent. Only the exact
  CloudFormation missing-stack response counts as absent.
- `bootstrap-remediate` requires an existing unprotected or outdated toolkit
  and `CDK_BOOTSTRAP_REMEDIATION_APPROVED=yes`. It rejects absent and compliant
  toolkits.

The `bootstrap-new` and `bootstrap-remediate` modes do not permit the Task 3
transition when GitHub deployment validation is enabled; bootstrap governance
continues to require the exact target runtime contract.

`AgenticPlatform-Web-GovernanceApiRole` must match its exact effective policy.
In `deploy` mode only, the audit also accepts the one exact previously deployed
policy whose transaction writes use the ineffective
`dynamodb:TransactWriteItems` action. `postdeploy` has no predecessor allowance.
The audit discovers `GovernanceApiLogs` as exactly one retained log group in
the `PlatformWeb` stack, then requires exact Lambda trust, no attached managed
policies, and exactly two inline policies: `GovernanceApi` and the exact CDK
X-Ray default policy. The target application policy must contain only the exact log,
DynamoDB, Cognito, and Registry permissions, including the exact table keys,
transaction-scoped underlying item actions, Registry ARNs, request-tag conditions,
resource-tag conditions, and `auto-delete=no`; no additional action, resource, condition,
statement, or policy is accepted. The GitHub deployment validation role has
policy-read permissions for only the audited governance roles, including
`AgenticPlatform-Web-GovernanceApiRole`.

Both `deploy` and `postdeploy` enforce the current Cognito domain owner-group
policy on the exact deployed user-pool ARN. The
`AgenticPlatform-Web-PlatformAdminApiRole` must have exactly
`cognito-idp:CreateGroup`, `cognito-idp:DeleteGroup`,
`cognito-idp:GetGroup`, and `cognito-idp:ListUsersInGroup` for this lifecycle.
The `AgenticPlatform-Web-HostedAcceptanceBrokerRole` must have exactly
`cognito-idp:DeleteGroup`, `cognito-idp:GetGroup`, and
`cognito-idp:ListUsersInGroup`. The runtime permissions boundary must retain
the exact canonical compacted Cognito action family on that same exact pool.
A missing or additional group action in either runtime-role policy, a wildcard
Cognito action or pool resource in either runtime-role policy, boundary drift,
or a predecessor that omits the canonical boundary action family fails both
modes.

Access denial, throttling, expired credentials, network failure, malformed
responses, version mismatch, and other AWS errors fail every mode. The modes
only inspect and report state. They do not change AWS resources.

Store the repository audit JSON, reviewed exceptions, and
approval evidence under `infra/serverless-platform/security-audit/`. The
directory is git-ignored. Do not copy passwords, tokens, client secrets, session
credentials, or private keys into evidence.

Review these areas before approving a deployment:

- IAM trust, exact repository and branch subjects, and the STS audience;
- IAM permissions, wildcard boundaries, and role passing;
- mandatory tags;
- S3 public access blocks, encryption, versioning, logging, and retention;
- CloudFront origin access, origin TLS, viewer HTTPS, logging, and headers;
- Cognito sign-up, password, MFA, token lifetime, deletion protection,
  callback, logout, domain, and client-secret settings;
- API authorization and throttling;
- Lambda IAM, logging, tracing, concurrency, runtime, timeout, and memory;
- log retention, dashboards, and alarms.

Block the deployment for unresolved high or critical findings unless a named
approver records a time-bounded exception in the local evidence directory.

## One-time AWS bootstrap

`CDKToolkit` is shared account infrastructure. The default modern CDK bootstrap
uses `AdministratorAccess` for its CloudFormation execution role when no custom
execution policy is supplied. Do not accept that default silently.

For an existing bootstrapped account, run the default `security:audit`,
inspect the current template and execution policies,
and do not rebootstrap casually. Coordinate changes with owners of every CDK
workload that shares `CDKToolkit`. If the default audit passes, do not run
either bootstrap command below.

For a new customer account, obtain a customer-approved managed policy ARN and
set `CDK_BOOTSTRAP_EXECUTION_POLICY_ARN`. The approved policy must be sufficient
for other CDK workloads sharing the bootstrap, not only this Stage 1 stack.
Use `bootstrap-new` for this audit. This mode stops if
any `CDKToolkit` stack exists. In `us-west-2`, the policy ARN must use the
commercial `arn:aws` partition, match `AWS_ACCOUNT_ID`, and contain one
nonempty IAM-safe policy name without a path or trailing content.

```bash
set -euo pipefail

: "${CDK_BOOTSTRAP_EXECUTION_POLICY_ARN:?Set a customer-approved managed policy ARN.}"
[[ "$AWS_REGION" == "us-west-2" ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
CDK_BOOTSTRAP_EXECUTION_POLICY_PATTERN="^arn:aws:iam::${AWS_ACCOUNT_ID}:policy/[A-Za-z0-9+=,.@_-]+$"
[[ "$CDK_BOOTSTRAP_EXECUTION_POLICY_ARN" =~ $CDK_BOOTSTRAP_EXECUTION_POLICY_PATTERN ]] || {
  printf 'CDK_BOOTSTRAP_EXECUTION_POLICY_ARN must be a commercial IAM managed policy ARN for AWS_ACCOUNT_ID with one nonempty safe policy name.\n' >&2
  exit 1
}

npm ci
npm --prefix infra/serverless-platform ci
SECURITY_AUDIT_MODE=bootstrap-new \
  npm --prefix infra/serverless-platform run security:audit

npm --prefix infra/serverless-platform exec -- cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}" \
  --cloudformation-execution-policies "$CDK_BOOTSTRAP_EXECUTION_POLICY_ARN" \
  --termination-protection \
  --tags "auto-delete=no" \
  --tags "project=agentic-ai-platform-demo" \
  --tags "managedBy=cdk"

npm --prefix infra/serverless-platform run security:audit
```

The final default audit verifies the new toolkit version and termination
protection.

For an existing toolkit that fails only because it is unprotected, outdated,
or both, obtain explicit customer approval for remediation and a
customer-approved execution policy. Record both approvals in the local
security-audit evidence directory. Run this separate remediation block.
`bootstrap-remediate` stops if the toolkit is
absent, already compliant, malformed, or fails for any other AWS reason.

```bash
set -euo pipefail

: "${CDK_BOOTSTRAP_EXECUTION_POLICY_ARN:?Set a customer-approved managed policy ARN.}"
[[ "$AWS_REGION" == "us-west-2" ]]
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]
CDK_BOOTSTRAP_EXECUTION_POLICY_PATTERN="^arn:aws:iam::${AWS_ACCOUNT_ID}:policy/[A-Za-z0-9+=,.@_-]+$"
[[ "$CDK_BOOTSTRAP_EXECUTION_POLICY_ARN" =~ $CDK_BOOTSTRAP_EXECUTION_POLICY_PATTERN ]] || {
  printf 'CDK_BOOTSTRAP_EXECUTION_POLICY_ARN must be a commercial IAM managed policy ARN for AWS_ACCOUNT_ID with one nonempty safe policy name.\n' >&2
  exit 1
}

npm ci
npm --prefix infra/serverless-platform ci
CDK_BOOTSTRAP_REMEDIATION_APPROVED=yes \
SECURITY_AUDIT_MODE=bootstrap-remediate \
  npm --prefix infra/serverless-platform run security:audit

npm --prefix infra/serverless-platform exec -- cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}" \
  --cloudformation-execution-policies "$CDK_BOOTSTRAP_EXECUTION_POLICY_ARN" \
  --termination-protection \
  --tags "auto-delete=no" \
  --tags "project=agentic-ai-platform-demo" \
  --tags "managedBy=cdk"

npm --prefix infra/serverless-platform run security:audit
```

The final default audit must pass before any stack diff or deployment. The
remediation approval flag is runtime-only and does not authorize future
bootstrap changes.

Do not deploy `GitHubBootstrapStack` for the current target. The repository is
private, its current plan does not support branch protection, and the current
token cannot provide administrator attestation. A GitHub Environment is not a
workaround.

For a different repository, an administrator must first protect `main`, attest
that governance, and explicitly approve GitHub AWS deployment. Only then, use `create` when the audited provider status is absent and `import` when it is present.
Set `GITHUB_OIDC_PROVIDER_MODE` to that value, record the choice, and reuse it
on every update.

Manually deploy the selected control-plane stack and then `PlatformWebStack`.
Before GitHub deployment can be enabled, the audit requires all twenty-five exact
boundary-constrained runtime roles to exist:

- `AgenticPlatform-Web-AccessAdminApiRole`
- `AgenticPlatform-Web-AgentRuntimeRole`
- `AgenticPlatform-Web-BuilderApiRole`
- `AgenticPlatform-Web-IdentityApiRole`
- `AgenticPlatform-Web-JourneyApiRole`
- `AgenticPlatform-Web-DeploymentApiRole`
- `AgenticPlatform-Web-ExperienceApiRole`
- `AgenticPlatform-Web-FrontendDeploymentRole`
- `AgenticPlatform-Web-GovernanceApiRole`
- `AgenticPlatform-Web-GatewayInvokerRole`
- `AgenticPlatform-Web-CloudFrontInvalidationProviderRole`
- `AgenticPlatform-Web-CloudFrontAlarmProviderRole`
- `AgenticPlatform-Web-ControlPlaneReadApiRole`
- `AgenticPlatform-Web-OperationsApiRole`
- `AgenticPlatform-Web-PlatformAdminApiRole`
- `AgenticPlatform-Web-PlatformAgentRegistrySeedRole`
- `AgenticPlatform-Web-RegistryDecisionFinalizerRole`
- `AgenticPlatform-Web-PlatformStateSeedRole`
- `AgenticPlatform-Web-PlatformWorkspaceSeedRole`
- `AgenticPlatform-Web-HostedAcceptanceBrokerRole`
- `AgenticPlatform-Web-RuntimeBoundaryTagProviderRole`
- `AgenticPlatform-Web-WorkspaceApiRole`
- `AgenticPlatform-Web-ModelGovernanceApiRole`
- `AgenticPlatform-Web-RuntimeProofConfiguratorRole`
- `AgenticPlatform-Web-RuntimeProofProviderRole`

Each role must have its exact root-path ARN and the exact runtime permissions
boundary `AgenticPlatform-Web-RuntimePermissionsBoundary`. Missing, renamed,
path-qualified, or differently bounded roles fail closed.

The audit also requires the exact root-path
`AgenticPlatform-Web-HostedAcceptanceRole`. This separate audited role is
intentionally unbounded: any permissions boundary is drift. Its trust and sole
inline policy must match the exact postdeploy contract described below, and it
must have no attached managed policies. This preflight order prevents the
bootstrap stack from trusting a pre-existing, over-privileged role. The GitHub
CloudFormation execution role intentionally cannot create, update, version, or
delete the boundary managed policy.

Before each bootstrap-stack diff or deploy, the following function resets the
context array and re-lists and validates `token.actions.githubusercontent.com`
in the current shell. AWS list/get failures stop the block. The explicit
deploy-phase audit runs after this preparation and directly before each CDK
command. It rejects placeholders and requires `GITHUB_REPOSITORY` to match the
clone's git origin. In `import` mode the context preparation passes
`-c githubOidcProviderArn=<arn>`. In `create` mode it either confirms absence
before the first deployment or verifies that the existing provider is owned by
`AgenticPlatform-GitHubBootstrap`. Duplicates, malformed URLs, and a missing
`sts.amazonaws.com` audience stop the block.

Run this entire block in one Bash process:

```bash
set -euo pipefail

export ENABLE_GITHUB_DEPLOYMENT=true
export BRANCH_PROTECTION_ATTESTED=true
: "${GITHUB_REPOSITORY_ID:?Run target confirmation with the repository ID.}"
: "${GITHUB_REPOSITORY_OWNER_ID:?Run target confirmation with the owner ID.}"
: "${GITHUB_WORKFLOW_REF:?Run target confirmation with the reusable workflow ref.}"
: "${GITHUB_OIDC_SUBJECT_MODE:?Choose legacy or immutable subject mode.}"
: "${GITHUB_OIDC_SUBJECT:?Set the exact subject for the chosen mode.}"

prepare_github_bootstrap_context() {
  : "${GITHUB_OIDC_PROVIDER_MODE:?Set GITHUB_OIDC_PROVIDER_MODE to create or import.}"
  case "$GITHUB_OIDC_PROVIDER_MODE" in
    create|import) ;;
    *)
      printf 'GITHUB_OIDC_PROVIDER_MODE must be create or import.\n' >&2
      return 1
      ;;
  esac

  GITHUB_OIDC_CONTEXT=()
  GITHUB_OIDC_PROVIDER_ARN=""

  local oidc_list_json
  local github_provider_arns
  local provider_json
  local stack_resources_json

  oidc_list_json="$(
    aws iam list-open-id-connect-providers \
      --region "$AWS_REGION" \
      --output json
  )"
  github_provider_arns="$(
    OIDC_LIST_JSON="$oidc_list_json" node <<'NODE'
const document = JSON.parse(process.env.OIDC_LIST_JSON);
if (!Array.isArray(document.OpenIDConnectProviderList)) {
  throw new Error("OIDC provider list is malformed.");
}
const providerMarker = "oidc-provider/token.actions.githubusercontent.com";
const arns = document.OpenIDConnectProviderList
  .map((provider) => provider?.Arn)
  .filter(
    (arn) => typeof arn === "string" && arn.includes(providerMarker),
  );
process.stdout.write(arns.join("\n"));
NODE
  )"

  if [[ "$github_provider_arns" == *$'\n'* ]]; then
    printf 'Multiple GitHub Actions OIDC providers found.\n' >&2
    return 1
  fi
  if [[ -z "$github_provider_arns" ]]; then
    if [[ "$GITHUB_OIDC_PROVIDER_MODE" == "import" ]]; then
      printf 'Import mode requires an existing GitHub Actions OIDC provider.\n' >&2
      return 1
    fi
    printf 'GitHub Actions OIDC provider is absent; the stack will create it.\n'
    return 0
  fi

  GITHUB_OIDC_PROVIDER_ARN="$github_provider_arns"
  provider_json="$(
    aws iam get-open-id-connect-provider \
      --open-id-connect-provider-arn "$GITHUB_OIDC_PROVIDER_ARN" \
      --region "$AWS_REGION" \
      --output json
  )"
  OIDC_PROVIDER_JSON="$provider_json" node <<'NODE'
const provider = JSON.parse(process.env.OIDC_PROVIDER_JSON);
if (provider.Url !== "token.actions.githubusercontent.com") {
  throw new Error("GitHub Actions OIDC provider URL is malformed.");
}
if (
  !Array.isArray(provider.ClientIDList)
  || !provider.ClientIDList.includes("sts.amazonaws.com")
) {
  throw new Error("GitHub Actions OIDC provider lacks sts.amazonaws.com.");
}
NODE

  if [[ "$GITHUB_OIDC_PROVIDER_MODE" == "import" ]]; then
    GITHUB_OIDC_CONTEXT=(
      -c "githubOidcProviderArn=${GITHUB_OIDC_PROVIDER_ARN}"
    )
    return 0
  fi

  if [[ "$GITHUB_OIDC_PROVIDER_MODE" == "create" ]]; then
    stack_resources_json="$(
      aws cloudformation list-stack-resources \
        --stack-name AgenticPlatform-GitHubBootstrap \
        --region "$AWS_REGION" \
        --output json
    )"
    STACK_RESOURCES_JSON="$stack_resources_json" \
      EXPECTED_PROVIDER_ARN="$GITHUB_OIDC_PROVIDER_ARN" \
      node <<'NODE'
const document = JSON.parse(process.env.STACK_RESOURCES_JSON);
const owned = document.StackResourceSummaries?.some(
  (resource) =>
    resource.ResourceType === "AWS::IAM::OIDCProvider"
    && resource.PhysicalResourceId === process.env.EXPECTED_PROVIDER_ARN,
);
if (!owned) {
  throw new Error(
    "Create mode requires the bootstrap stack to own the existing provider.",
  );
}
NODE
  fi
}

prepare_github_bootstrap_context
SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/serverless-platform run diff -- GitHubBootstrapStack \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "repository=${GITHUB_REPOSITORY}" \
  -c "repositoryId=${GITHUB_REPOSITORY_ID}" \
  -c "repositoryOwnerId=${GITHUB_REPOSITORY_OWNER_ID}" \
  -c "workflowRef=${GITHUB_WORKFLOW_REF}" \
  -c "githubOidcSubjectMode=${GITHUB_OIDC_SUBJECT_MODE}" \
  -c "githubOidcSubject=${GITHUB_OIDC_SUBJECT}" \
  -c enableGitHubDeployment=true \
  -c branchProtectionAttested=true \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}" \
  ${GITHUB_OIDC_CONTEXT[@]+"${GITHUB_OIDC_CONTEXT[@]}"}

prepare_github_bootstrap_context
SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/serverless-platform run deploy:bootstrap -- \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "repository=${GITHUB_REPOSITORY}" \
  -c "repositoryId=${GITHUB_REPOSITORY_ID}" \
  -c "repositoryOwnerId=${GITHUB_REPOSITORY_OWNER_ID}" \
  -c "workflowRef=${GITHUB_WORKFLOW_REF}" \
  -c "githubOidcSubjectMode=${GITHUB_OIDC_SUBJECT_MODE}" \
  -c "githubOidcSubject=${GITHUB_OIDC_SUBJECT}" \
  -c enableGitHubDeployment=true \
  -c branchProtectionAttested=true \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}" \
  ${GITHUB_OIDC_CONTEXT[@]+"${GITHUB_OIDC_CONTEXT[@]}"}
```

The construct ID is `GitHubBootstrapStack`; the physical stack is
`AgenticPlatform-GitHubBootstrap`. Record whether the stack created or imported
the provider. Keep that ownership mode on later updates. Confirm the
`GitHubDeployRoleArn`, `CloudFormationExecutionRoleArn`, and
`GitHubOidcProviderArn` outputs locally.

AWS references:

- https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html
- https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html
- https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-protect-stacks.html

## GitHub repository configuration

Set these repository-level Actions variables. Values are raw values, not
`NAME=value` assignment strings.

| Repository variable | Value |
| --- | --- |
| `AWS_ACCOUNT_ID` | `<account-id>` |
| `AWS_REGION` | `us-west-2` |
| `ENABLE_GITHUB_DEPLOYMENT` | `true` |
| `BRANCH_PROTECTION_ATTESTED` | `true` |
| `GITHUB_DEPLOY_ROLE_NAME` | `AgenticPlatformGitHubDeployRole` |
| `CFN_EXECUTION_ROLE_NAME` | `AgenticPlatformCloudFormationExecutionRole` |
| `COGNITO_DOMAIN_PREFIX` | `<unique-cognito-prefix>` |
| `GITHUB_OIDC_SUBJECT_MODE` | legacy or immutable |
| `GITHUB_OIDC_SUBJECT` | `<exact-attested-main-subject>` |
| `CONTROL_PLANE_MODE` | reference-existing or provision |
| `CONTROL_PLANE_SHARED_REGISTRY_ID` | required only for reference-existing |
| `CONTROL_PLANE_REGISTRY_PLATFORM_ID` | required only for reference-existing |
| `CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID` | required only for reference-existing |
| `CONTROL_PLANE_REGISTRY_OPERATIONS_ID` | required only for reference-existing |
| `CONTROL_PLANE_LLM_GATEWAY_ID` | required only for reference-existing |
| `CONTROL_PLANE_LLM_GATEWAY_REGION` | required only for reference-existing |
| `CONTROL_PLANE_TOOLS_GATEWAY_ID` | required only for reference-existing |
| `JOURNEY_GITHUB_OAUTH_CLIENT_ID` | optional GitHub OAuth App client ID for per-repository authorization |
| `JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN` | optional same-account secret ARN containing the OAuth App client secret |
| `STARTER_BUILDER_MODEL_ID` | exact model ID exposed by the selected inference Gateway |

The two GitHub OAuth variables configure the hosted platform application, not
a repository owner or reusable user credential. Store an exact JSON document
such as `{"clientSecret":"<oauth-app-client-secret>"}` in the referenced
Secrets Manager secret. For every new or resumed Agent repository, the Domain
Builder approves the immutable preview and signs in to GitHub in the browser;
GitHub returns directly to the API Gateway callback, which uses that short-lived
authorization for the selected GitHub account and revokes it after delivery.
The callback redirects to CloudFront with only a durable delivery ID or stable
error; the browser never receives the GitHub authorization code.

The GitHub-to-AWS flags `ENABLE_GITHUB_DEPLOYMENT` and
`BRANCH_PROTECTION_ATTESTED` are separate from Builder repository export.
Leave these deployment flags unset or false here. Set them to `true` only after
an administrator has supplied protected-main governance and the bootstrap stack
has been explicitly deployed with matching CDK contexts.

The reusable deployment workflow takes `GITHUB_REPOSITORY_ID` from
`github.repository_id` and `GITHUB_REPOSITORY_OWNER_ID` from
`github.repository_owner_id`. Its deploy-phase audit receives
`GITHUB_WORKFLOW_REF` as the exact trusted path
`<owner/repo>/.github/workflows/deploy-serverless-platform.yml@refs/heads/main`.
Set `GITHUB_OIDC_SUBJECT_MODE` and `GITHUB_OIDC_SUBJECT` to the same explicit
mode and exact subject used when deploying `GitHubBootstrapStack`; do not infer
or broaden either value.

For the current account, set `CONTROL_PLANE_MODE=reference-existing` and supply
all six existing IDs only through the protected variables above. For a clean
customer account, set `CONTROL_PLANE_MODE=provision`; all six existing-ID
variables must be empty. Provision mode must not require existing IDs and
deploys `AgenticPlatform-ControlPlane-Provisioned`, which publishes the same
stable exports consumed by `PlatformWebStack`. There is no checked-in
environment-specific Registry or Gateway config and no fallback ID in the
workflow, documentation, runtime files, or generated tracked files.

The bootstrap
`AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment` policy is a
dedicated managed policy so Registry permissions remain below the IAM document
quota. Provision mode grants `agent-registry:CreateRegistry` on
`Resource: "*"` because the Registry ARN is assigned only after creation. It
requires the exact mandatory request tags, exact `aws:TagKeys`, and the
configured `aws:RequestedRegion`. The dependent
`agent-registry:TagResource` permission uses the regional account Registry
wildcard and requires both exact request tags and existing mandatory ownership
tags. Registry records receive the mandatory tags in the initial create
request. Existing Registry and record mutations require the same exact
resource tags; reads remain scoped to regional account Registry and record
ARNs.

Normal manual and GitHub deployments do not seed users. Existing users are
preserved. The optional seed utility accepts deployment-private
`COGNITO_DEMO_USERS_JSON` persona configuration and
`COGNITO_DEMO_USER_PASSWORDS_JSON` password configuration only through its
environment. The password JSON keys exactly match all configured usernames.
Every value must be distinct and meet the Cognito policy: at least
14 characters with an uppercase letter, lowercase letter, digit, and symbol.
Do not commit persona or password values to repository files or variables,
issues, documentation, tests, or returned objects.

The hosted web client retains authorization-code PKCE and
`ALLOW_USER_SRP_AUTH`, and additionally enables
`ALLOW_ADMIN_USER_PASSWORD_AUTH` only for the server-side post-deployment
acceptance verifier. `AgenticPlatform-Web-HostedAcceptanceRole` owns exactly
`cognito-idp:AdminGetUser`, `cognito-idp:AdminCreateUser`,
`cognito-idp:AdminSetUserPassword`, `cognito-idp:AdminAddUserToGroup`,
`cognito-idp:AdminListGroupsForUser`, `cognito-idp:AdminInitiateAuth`, and
`cognito-idp:AdminDeleteUser` on the exact deployed `userPool.userPoolArn`.
Its only non-Cognito data-plane permission is `lambda:InvokeFunction` on the
exact private `AgenticPlatform-Web-HostedAcceptanceBroker` function. The
`HostedAcceptanceRole` has no direct `agent-registry` or DynamoDB action. The
role itself keeps the stack tags `auto-delete=no`,
`project=agentic-ai-platform-demo`, and `managedBy=cdk`, and trusts only
`AgenticPlatformGitHubDeployRole` through the exact principal-ARN condition.
`AgenticPlatformGitHubDeployRole` has no Cognito user-management action and no
`userpool/*` resource. For seeding and hosted acceptance it retains only
`sts:AssumeRole` to the exact
`AgenticPlatform-Web-HostedAcceptanceRole` ARN.

The `postdeploy` security audit resolves exactly one Cognito user-pool resource
and matching `UserPoolId` stack output, plus exactly one hosted-acceptance
broker function and matching `HostedAcceptanceBrokerFunctionArn` output. It
then audits the `HostedAcceptanceRole` exact effective policy: account-root
principal constrained only by `ArnEquals aws:PrincipalArn` to the exact
`AgenticPlatformGitHubDeployRole` ARN, no permissions boundary, no attached
managed policies, exactly one `HostedAcceptance` inline policy, the seven
Cognito actions above on that resolved user-pool ARN, and only
`lambda:InvokeFunction` on the resolved broker ARN. Missing, duplicate,
malformed, wildcard, additional-action, or resource-mismatched state fails
closed.

Each secret-bearing Cognito create or reset uses an exclusive short-lived
private temporary directory with mode `0700` and an exclusively created private
JSON file with mode `0600`. AWS CLI receives a shell-free literal
`file://<absolute path>` reference; spaces remain literal and are not
percent-encoded, so the argument contains no `%20`. The password never enters
process argv or stdin, logs, errors, or evidence. The complete runtime password
JSON is removed from every AWS CLI child-process environment. Immediate cleanup
begins as soon as the private directory is created. If initial removal fails,
the runner scrubs the JSON file and performs a removal retry; the deployment
stops on any cleanup failure, with persistent cleanup failure reported
separately through generic diagnostics.
The optional seed path validates and applies a safe 20-second per-call AWS CLI
timeout to every lookup, mutation, and cleanup call. Operators should place a
separate five-minute bound around an explicit utility invocation.

`seed-demo-users.mjs --validate-only` validates the deployment-private persona
and password configuration, returns no sensitive values, and makes no AWS
calls. The reusable deployment workflow does not invoke validation or seeding.

Before normal seeding, the complete runtime password object is parsed and every
configured password is validated before any Cognito mutation. Every configured
user's lookup, identity, status, and attribute verification, and exact group
verification then completes before any Cognito mutation occurs. Mutation-specific
password retrieval is deferred until the mutation phase, and its input uses only
the private temporary JSON file described above.

Each created user receives `custom:managed_by=agentic-ai-platform-demo` as an
immutable ownership marker. An existing user is assigned to its configured
group only after parsed `admin-get-user` output confirms the exact `Username`,
`Enabled=true`, expected `name`, and exact ownership marker; any mismatch causes
the seed to fail closed. For every existing owned user,
`admin-list-groups-for-user` must return unpaginated JSON with zero memberships
or exactly the expected group. The only supported groups are `platform-admin`,
`domain-builder`, and `end-user`. A malformed or duplicate group record, any
other membership, or any `NextToken` fails closed before password reset or group
addition.

`UserStatus=CONFIRMED` proceeds without reading or resetting a password.
`UserStatus=FORCE_CHANGE_PASSWORD` refreshes the temporary password through
`admin-set-user-password` with `Permanent=false` through the private temporary
JSON file, then adds the expected group only when it was absent. Any other
status fails closed before password reset or group assignment. Absent users use
the same private temporary JSON file transport for `admin-create-user`. Only the
exact UserNotFoundException stderr classification permits creation. Malformed
lookup JSON and every other lookup failure cause no create or group assignment.

### Create the initial administrator

Use the [Console walkthrough and deployment checks](../../docs/console-navigation.md)
to verify the resulting login, role controls and domain workspaces with reference
screenshots. Complete all initialization steps below before handing over a demo.

A new deployment creates a user pool and groups, **not a permanent login user**.
Temporary acceptance users are removed after testing. Before handing over a new
installation, complete these steps with an authorized operator:

1. Run `aws sts get-caller-identity` with the intended AWS profile. Inspect
   `aws cloudformation describe-stacks --stack-name AgenticPlatform-Web
   --region us-west-2` with that same profile. Use the live `UserPoolId` and
   `ApplicationUrl` outputs; an old account's user or retained pool is unrelated.
2. In the AWS Cognito Console, open that exact pool and choose **Users → Create
   user**. Choose a username and a unique temporary password meeting the pool
   policy. Choose no invitation for manual onboarding; email is not required for
   username sign-in. Transfer the temporary password privately. Never commit it
   or put it in shell history, screenshots, documentation or GitHub variables.
3. Assign the user to `platform-admin` and `domain-platform`. Assign exactly one
   persona group: adding `domain-builder`, `domain-lead` or `end-user` alongside
   `platform-admin` intentionally fails closed.
4. Open the live `ApplicationUrl`, sign in and complete the temporary-password
   change. Verify **Platform Admin** and Platform-owned Build project choices.
   Keep this permanent administrator when cleaning up temporary test users.
5. **For an explicitly authorized demo operator**, also complete
   [Reconcile a demo operator portably](#reconcile-a-demo-operator-portably) below.
   This is what enables the top-right **Working role** dropdown. A normal
   administrator without `demo-operator` will not see that dropdown. Supply the
   complete intended operator list: reconciliation removes unlisted operators.
   Sign out and sign in afterwards so Cognito issues fresh group claims. Verify
   role selection and the **Working domain** selector for lead/builder views,
   then return to Platform Admin. Also complete
   [Initialize demo workspaces](#initialize-demo-workspaces) before handover;
   role switching alone grants no project membership. This is deliberate demo authorization, not an
   unrestricted client-side role picker or a default for all administrators.

Do not automatically reset an existing user's password or replace memberships
on redeployment. A login failure must be checked against the actual target pool;
creating stack resources alone is not evidence of usable operator access.
The platform's existing Users & Access membership forms do not create Cognito
users; in-Console identity creation/invitation remains separate implementation.

### Initialize demo workspaces

**Required for the demo Builder experience after administrator creation and demo
operator authorization.** The baseline deploy creates three Customer Support
projects and two Operations projects with no human members. Explicitly enroll
the authorized demo operators so Builder Fleet/Build Agent can see their agents.
This never grants ordinary users access to all projects.

Use the same private `{"usernames":["..."]}` selection file as the operator
reconciliation below, containing existing confirmed administrators already in
`platform-admin` and `demo-operator`. Set `AWS_PROFILE` to the intended profile,
`AWS_ACCOUNT_ID` to the intended account and `AWS_REGION=us-west-2`. The command
checks STS and discovers the actual Cognito pool and state table from the live
Web stack, rather than local output files. Set `PLATFORM_WEB_STACK_NAME` only if
the deployment uses a different Web stack name.

```bash
# Keep PRIVATE_DEMO_OPERATOR_FILE outside the repository with mode 0600.
# It contains usernames only; no passwords or session tokens.
npm run platform:initialize:demo-workspaces < "$PRIVATE_DEMO_OPERATOR_FILE"
npm run platform:initialize:demo-workspaces -- --apply < "$PRIVATE_DEMO_OPERATOR_FILE"
# Run the plan again: plannedGrants must be 0.
npm run platform:initialize:demo-workspaces < "$PRIVATE_DEMO_OPERATOR_FILE"
```

The first command is read-only. Apply adds missing memberships only to the five
active deployment-owned starter projects; existing members, owners, resource
policies, agent configurations and custom projects are preserved. Every user,
project and starter agent is validated before the first write. Conditional
updates stop on concurrent changes. If a provider call fails partway through,
already completed grants remain; inspect the plan and rerun to finish safely.
This is additive onboarding, not offboarding: remove unwanted project access
through the normal membership-management workflow.

Before handover, sign in and switch to Domain Builder in **each** domain:
Customer Support must expose Case Assist, Concierge and Supportdesk; Operations
must expose Incident Triage and Report Runner. Open each project's Fleet and
Build Agent, verify model selection and Generate/repository preview, and open
Memory & KB. Also verify a non-member Builder cannot see those projects. Keep
these results distinct from infrastructure deployment success.

The result reports `memoryBindings` and `knowledgeBaseBindings`. Zero means the
agents have no configured resource IDs; it does not prove memory/KB availability.
Real AgentCore Memory and Knowledge Base provisioning/data ingestion are separate
configuration steps. Do not invent bindings or label those services ready merely
because the demo project/agent cards are visible. Configure resources in the
target account, then verify access and ingestion independently if required for
the demonstration. Region support remains the repository's current `us-west-2`.

### Reconcile a demo operator portably

`reconcile:demo-operator` is the portable SDK-based path for multiple exact
private operators. It reads one document shaped exactly as
`{"usernames":["..."]}` from a private JSON file redirected to standard input,
never from command arguments or environment variables. The array must contain
1 to 100 unique valid Cognito usernames. Before any membership mutation, every
selected user must exist, be enabled, have status `CONFIRMED`, and remain a
permanent member of `platform-admin`; the command also conditionally acquires
an owner-fenced lease in the deployed platform state table. It adds every
missing selected user, removes every non-selected stale member, verifies that
the final enabled membership exactly equals the selected set regardless of
order, and compensates back to the original membership snapshot when a later
step fails. After an ambiguous timed-out mutation, it keeps the lease through a
bounded quiescence period and re-verifies the restored snapshot before release.
Results contain only aggregate counts. Real identities must not be committed to
the repository, placed in process arguments, written to generated deployment
configuration, or emitted in routine output or diagnostics.

Create the input file outside the repository with mode `0600`, run the command,
then remove the file:

```bash
(
  set +x
  set -eu
  umask 077
  PRIVATE_DEMO_OPERATOR_FILE="$(
    mktemp "${TMPDIR:-/tmp}/agentic-demo-operators.XXXXXX"
  )"
  trap 'rm -f -- "$PRIVATE_DEMO_OPERATOR_FILE"' EXIT HUP INT TERM
  DEMO_OPERATOR_USERNAMES=()
  while true
  do
    printf "Existing platform administrator username (blank to finish): " >&2
    IFS= read -r -s DEMO_OPERATOR_USERNAME
    printf "\n" >&2
    [ -n "$DEMO_OPERATOR_USERNAME" ] || break
    DEMO_OPERATOR_USERNAMES+=("$DEMO_OPERATOR_USERNAME")
  done
  printf "%s\0" "${DEMO_OPERATOR_USERNAMES[@]}" | node -e '
    const fs = require("node:fs");
    const usernames = fs.readFileSync(0, "utf8").split("\0");
    usernames.pop();
    fs.writeFileSync(
      process.argv[1],
      `${JSON.stringify({ usernames })}\n`,
      { mode: 0o600 },
    );
  ' "$PRIVATE_DEMO_OPERATOR_FILE"
  unset DEMO_OPERATOR_USERNAME DEMO_OPERATOR_USERNAMES

  export AWS_REGION="<commercial-aws-region>"
  export COGNITO_USER_POOL_ID="<deployed-user-pool-id>"
  export COGNITO_DEMO_OPERATOR_GROUP="demo-operator"
  export PLATFORM_STATE_TABLE_NAME="<PlatformStateTableName-stack-output>"

  npm --prefix infra/serverless-platform run reconcile:demo-operator \
    < "$PRIVATE_DEMO_OPERATOR_FILE"

  # With AWS_ACCOUNT_ID set to the verified target, complete workspace access.
  npm --prefix infra/serverless-platform run initialize:demo-workspaces -- --apply \
    < "$PRIVATE_DEMO_OPERATOR_FILE"

  unset PLATFORM_STATE_TABLE_NAME
  unset COGNITO_DEMO_OPERATOR_GROUP
  unset COGNITO_USER_POOL_ID
  unset AWS_REGION
)
```

The portable command creates no AWS resources and therefore performs no tagging.
Its temporary lease is an item in the already tagged platform state table and is
deleted with an owner condition. If a future version creates a resource, that
resource must be tagged `auto-delete=no`. The command also ignores SDK endpoint
overrides so signed Cognito and DynamoDB requests cannot be redirected by
endpoint settings. Its expected least-privilege IAM policy grants only these
actions on the exact configured user pool and state table:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminListGroupsForUser",
        "cognito-idp:ListUsersInGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:AdminAddUserToGroup"
      ],
      "Resource": "arn:${Partition}:cognito-idp:${Region}:${Account}:userpool/${PoolId}"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:${Partition}:dynamodb:${Region}:${Account}:table/${PlatformStateTableName}",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": [
            "DEMO_OPERATOR_LEASE#${PoolId}"
          ]
        }
      }
    }
  ]
}
```

### Configure the hosted demo operator

`configure:demo-operator` is a compatibility alias for
`reconcile:demo-operator`. Both package commands execute the same portable SDK
implementation documented above. There is no separate AWS CLI reconciliation
algorithm.

Use the same private JSON standard-input file, environment variables, exact IAM
permissions, lease, and cleanup procedure shown in
"Reconcile a demo operator portably." If any membership mutation or final
verification fails, the command restores and verifies the exact original
`demo-operator` membership snapshot before releasing the lease. Selected
usernames are never accepted in command arguments or environment variables and
are not written to normal output or diagnostics.

### Hosted role-switching acceptance

Run the hosted acceptance only after the web stack is deployed and the
`demo-operator` group is reconciled. The runner creates one temporary
administrator and one temporary ordinary user, exercises every effective role
against the real hosted APIs, verifies the End User Overview and approved Agent
catalog in desktop and mobile Chromium, and removes the temporary users and
owned fixture resources in `finally`.
Cleanup covers both temporary identities and every exact acceptance-owned
resource, including failure paths.

Screenshots are written only to a private mode-`0700` temporary directory and
are removed before the runner returns. Passwords and tokens do not enter command
arguments, environment variables, tracked files, or normal output. Acceptance
requires a fresh mode-`0600` private exact operator set with the same
`{"usernames":["..."]}` shape used by reconciliation.

Use the deployed output files and a unique numeric run identity:

```bash
set -euo pipefail

export AWS_ACCOUNT_ID="$(
  aws sts get-caller-identity --query Account --output text
)"
export AWS_REGION="<commercial-aws-region>"
export HOSTED_ROLE_SWITCHING_RUN_ID="$(date +%s)"
export HOSTED_ROLE_SWITCHING_RUN_ATTEMPT="1"
export HOSTED_ROLE_SWITCHING_OPERATORS_FILE="\
/path/to/fresh-private-demo-operators.json"

node e2e/hosted-role-switching-acceptance.mjs

rm -f -- "$HOSTED_ROLE_SWITCHING_OPERATORS_FILE"
unset HOSTED_ROLE_SWITCHING_OPERATORS_FILE
unset HOSTED_ROLE_SWITCHING_RUN_ATTEMPT
unset HOSTED_ROLE_SWITCHING_RUN_ID
unset AWS_REGION
unset AWS_ACCOUNT_ID
```

Create that fresh file outside the repository using the secure prompt and JSON
writer from "Reconcile a demo operator portably." The runner treats every
selected account as a read-only postcondition: it verifies the enabled status,
`CONFIRMED` status, `platform-admin` membership, and `demo-operator` membership
before and after acceptance. It does not authenticate the selected accounts,
reset passwords, change groups, delete users, or emit identities. The temporary
administrator has the same two groups and exercises all four effective roles
and Demo Assist; the temporary ordinary user proves the controls are absent.

`HOSTED_ROLE_SWITCHING_ACCEPTANCE=1` is the explicit opt-in used by
`e2e/run-all.mjs`; the direct command above runs only the hosted
role-switching acceptance and does not require a local console server.

If the process is interrupted, rerun cleanup with the same
`HOSTED_ROLE_SWITCHING_RUN_ID` and `HOSTED_ROLE_SWITCHING_RUN_ATTEMPT`.
Cleanup-only recovers the exact broker-owned fixture and deterministic verifier
users; it does not start Chromium or create or authenticate users:

```bash
node e2e/hosted-role-switching-acceptance.mjs --cleanup-only
```

Configure no GitHub Environment. When explicitly enabled for an eligible
repository, the branch-scoped role trust uses exactly one selected
protected-main subject:

- legacy mode: `repo:<owner/repo>:ref:refs/heads/main`
- immutable mode:
  `repo:<owner>@<repository-owner-id>/<repo>@<repository-id>:ref:refs/heads/main`

The chosen mode and exact subject must match the deploy-phase audit and CDK
bootstrap deployment. A GitHub Environment changes the OIDC subject and does
not match either contract. No feature branch is ever trusted for AWS deployment.

## Manual pre-commit deployment

Re-run the target-confirmation block in the same Bash
process so the exact Cognito prefix check passes before synth. Run the
deterministic Task 6 workflow, audit, documentation, and tag-validator
contracts with:

```bash
npm --prefix infra/serverless-platform run test:task6
```

Install locked dependencies and run the same verification used by the workflow:

```bash
set -euo pipefail

npm ci
npm --prefix e2e ci
npm --prefix infra/platform-registry ci
npm --prefix infra/serverless-platform ci
npm --prefix e2e exec -- playwright install --with-deps --only-shell chromium
npm test
npm --prefix infra/platform-registry test
npm --prefix infra/platform-registry run build
npm --prefix infra/serverless-platform test
npm --prefix infra/serverless-platform run build
npm audit --audit-level=high
npm --prefix e2e audit --audit-level=high
npm --prefix infra/platform-registry audit --audit-level=high
npm --prefix infra/serverless-platform run audit
npm --prefix infra/serverless-platform run security:audit

case "$CONTROL_PLANE_MODE" in
  reference-existing)
    CONTROL_PLANE_STACK_NAME="AgenticPlatform-ControlPlane"
    : "${CONTROL_PLANE_SHARED_REGISTRY_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_REGISTRY_PLATFORM_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_REGISTRY_OPERATIONS_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_LLM_GATEWAY_ID:?Required for reference-existing.}"
    : "${CONTROL_PLANE_LLM_GATEWAY_REGION:?Required for reference-existing.}"
    : "${CONTROL_PLANE_TOOLS_GATEWAY_ID:?Required for reference-existing.}"
    CONTROL_PLANE_CONTEXT=(
      --context "mode=${CONTROL_PLANE_MODE}"
      --context "account=${AWS_ACCOUNT_ID}"
      --context "region=${AWS_REGION}"
      --context "sharedRegistryId=${CONTROL_PLANE_SHARED_REGISTRY_ID}"
      --context "registryPlatformId=${CONTROL_PLANE_REGISTRY_PLATFORM_ID}"
      --context "registryCustomerSupportId=${CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID}"
      --context "registryOperationsId=${CONTROL_PLANE_REGISTRY_OPERATIONS_ID}"
      --context "llmGatewayId=${CONTROL_PLANE_LLM_GATEWAY_ID}"
      --context "llmGatewayRegion=${CONTROL_PLANE_LLM_GATEWAY_REGION}"
      --context "toolsGatewayId=${CONTROL_PLANE_TOOLS_GATEWAY_ID}"
    )
    ;;
  provision)
    CONTROL_PLANE_STACK_NAME="AgenticPlatform-ControlPlane-Provisioned"
    for variable_name in \
      CONTROL_PLANE_SHARED_REGISTRY_ID \
      CONTROL_PLANE_REGISTRY_PLATFORM_ID \
      CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID \
      CONTROL_PLANE_REGISTRY_OPERATIONS_ID \
      CONTROL_PLANE_LLM_GATEWAY_ID \
      CONTROL_PLANE_LLM_GATEWAY_REGION \
      CONTROL_PLANE_TOOLS_GATEWAY_ID
    do
      [[ -z "${!variable_name:-}" ]]
    done
    CONTROL_PLANE_CONTEXT=(
      --context "mode=${CONTROL_PLANE_MODE}"
      --context "account=${AWS_ACCOUNT_ID}"
      --context "region=${AWS_REGION}"
    )
    ;;
  *)
    printf 'CONTROL_PLANE_MODE must be reference-existing or provision.\n' >&2
    exit 1
    ;;
esac

npm --prefix infra/platform-registry run synth -- \
  "$CONTROL_PLANE_STACK_NAME" \
  "${CONTROL_PLANE_CONTEXT[@]}"
npm --prefix infra/serverless-platform run synth -- \
  PlatformWebStack \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}"
node --test e2e/smoke-auth-integration.mjs
```

For the current target, do not create or assume the GitHub-created
CloudFormation execution role. Use the approved manual AWS identity established
in the target-confirmation block. Before the application diff and again before
deploy, rerun the repository gate in the current shell:

```bash
set -euo pipefail

case "$CONTROL_PLANE_MODE" in
  reference-existing)
    CONTROL_PLANE_STACK_NAME="AgenticPlatform-ControlPlane"
    CONTROL_PLANE_CONTEXT=(
      --context "mode=${CONTROL_PLANE_MODE}"
      --context "account=${AWS_ACCOUNT_ID}"
      --context "region=${AWS_REGION}"
      --context "sharedRegistryId=${CONTROL_PLANE_SHARED_REGISTRY_ID}"
      --context "registryPlatformId=${CONTROL_PLANE_REGISTRY_PLATFORM_ID}"
      --context "registryCustomerSupportId=${CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID}"
      --context "registryOperationsId=${CONTROL_PLANE_REGISTRY_OPERATIONS_ID}"
      --context "llmGatewayId=${CONTROL_PLANE_LLM_GATEWAY_ID}"
      --context "llmGatewayRegion=${CONTROL_PLANE_LLM_GATEWAY_REGION}"
      --context "toolsGatewayId=${CONTROL_PLANE_TOOLS_GATEWAY_ID}"
    )
    ;;
  provision)
    CONTROL_PLANE_STACK_NAME="AgenticPlatform-ControlPlane-Provisioned"
    CONTROL_PLANE_CONTEXT=(
      --context "mode=${CONTROL_PLANE_MODE}"
      --context "account=${AWS_ACCOUNT_ID}"
      --context "region=${AWS_REGION}"
    )
    ;;
  *)
    printf 'CONTROL_PLANE_MODE must be reference-existing or provision.\n' >&2
    exit 1
    ;;
esac

SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/platform-registry run diff -- \
  "$CONTROL_PLANE_STACK_NAME" \
  "${CONTROL_PLANE_CONTEXT[@]}"

SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/platform-registry run deploy -- \
  "$CONTROL_PLANE_STACK_NAME" \
  --require-approval never \
  --outputs-file control-plane-outputs.json \
  "${CONTROL_PLANE_CONTEXT[@]}"

SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/serverless-platform run diff -- PlatformWebStack \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}"

SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/serverless-platform run deploy:web -- \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}"

SECURITY_AUDIT_MODE=postdeploy npm --prefix infra/serverless-platform run security:audit
```

The selected physical control-plane stack is deployed first and publishes the
stable `AgenticPlatform-ControlPlane-...` exports. The web construct ID is
`PlatformWebStack`; its physical stack is `AgenticPlatform-Web`. The
control-plane deploy writes
`infra/platform-registry/control-plane-outputs.json`, and `deploy:web` writes
`infra/serverless-platform/deployment-outputs.json`. Both files are ignored.
The repository security audit runs immediately before every control-plane and
web diff and deploy, then `postdeploy` enforces the exact new target before
outputs are consumed.

Normal deployment preserves all existing Cognito users and does not create,
delete, or reset named users. For an explicitly approved optional seed run,
read the user-pool ID from the local output and enter both the persona and
password JSON through hidden runtime input. Keep those deployment-private
values out of command arguments:

```bash
set -euo pipefail

export COGNITO_USER_POOL_ID="$(
  node -e '
    const fs = require("node:fs");
    const document = JSON.parse(
      fs.readFileSync("infra/serverless-platform/deployment-outputs.json", "utf8"),
    );
    const matches = Object.values(document).filter(
      (stack) => stack && typeof stack.UserPoolId === "string",
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one UserPoolId output; found ${matches.length}.`);
    }
    process.stdout.write(matches[0].UserPoolId);
  '
)"

read -r -s -p "Cognito persona JSON: " COGNITO_DEMO_USERS_JSON
printf '\n'
export COGNITO_DEMO_USERS_JSON

read -r -s -p "Cognito password JSON: " \
  COGNITO_DEMO_USER_PASSWORDS_JSON
printf '\n'
export COGNITO_DEMO_USER_PASSWORDS_JSON

clear_seed_environment() {
  unset COGNITO_DEMO_USERS_JSON
  unset COGNITO_DEMO_USER_PASSWORDS_JSON
  unset COGNITO_USER_POOL_ID
}
trap clear_seed_environment EXIT

AWS_REGION="$AWS_REGION" \
  node infra/serverless-platform/scripts/seed-demo-users.mjs

clear_seed_environment
trap - EXIT
```

Before the protected workflow role-chains for hosted acceptance, it performs
post-deployment validation by building the expected
supported/taggable inventory from CloudFormation resources in the selected
control-plane stack and `AgenticPlatform-Web`. Query each expected ARN through
Resource Groups Tagging API or its explicit service tag API. Every expected
resource must be present with `auto-delete=no`,
`project=agentic-ai-platform-demo`, and `managedBy=cdk`. The protected workflow
implements this as `Validate deployed project tags`, uses an explicit
non-taggable resource-type allowlist, and fails closed on an unknown type or
malformed, incomplete, empty, or partial tag inventory.

After tag validation and the unauthenticated health smoke,
`Assume hosted acceptance role` role-chains from the deploy role into
`AgenticPlatform-Web-HostedAcceptanceRole` for a 3600-second role session.
`Run hosted control-plane acceptance` then runs with a 20-minute acceptance
limit. It reads the two ignored stack-output files and receives only the AWS
account, AWS region, and non-secret GitHub run identity. The two deterministic
verifier usernames are
`hosted-acceptance-admin-${{ github.run_id }}-${{ github.run_attempt }}` and
`hosted-acceptance-isolation-${{ github.run_id }}-${{ github.run_attempt }}`.
Their strong passwords remain runtime-random and secret. The runner creates a
`platform-admin` verifier and an `end-user` isolation verifier, authenticates
them with `ADMIN_USER_PASSWORD_AUTH`, and checks the canonical real identity,
Registry, and AI Gateway API contracts.

Task 5 hosted acceptance runs with the provisioned
`AgenticPlatform-Web-HostedAcceptanceRole`. It invokes the private
`AgenticPlatform-Web-HostedAcceptanceBroker` Lambda and has no direct Registry
or DynamoDB permissions. The broker is not exposed through API Gateway or a
Function URL. Its resource policy admits the exact hosted acceptance role, and
its non-user-assumable
`AgenticPlatform-Web-HostedAcceptanceBrokerRole` owns the bounded underlying
operations.

Application roles that use DynamoDB transactions authorize the transaction
through its actual underlying `dynamodb:PutItem` or `dynamodb:DeleteItem`
operations. Those statements require
`dynamodb:EnclosingOperation=TransactWriteItems` and restrict
`dynamodb:LeadingKeys` to the exact entity families used by each handler.
Non-transaction writes remain in separate statements with their own narrower
key sets. No application role grants the ineffective
`dynamodb:TransactWriteItems` IAM action.

The broker execution role has these exact permissions:

- `agent-registry:ListRegistryRecords` and
  `agent-registry:CreateRegistryRecord` on the configured shared fixture Registry;
  the dependent `agent-registry:TagResource`,
  `agent-registry:GetRegistryRecord`,
  `agent-registry:ListTagsForResource`,
  `agent-registry:SubmitRegistryRecordForApproval`, and
  `agent-registry:DeleteRegistryRecord` are scoped to that Registry's record descendants.
  Creation and the dependent tag authorization require all
  mandatory request tags and exact tag keys. Submit and delete require all
  acceptance resource tags, including `managedBy=hosted-acceptance`;
- `agent-registry:GetRegistry` and
  `agent-registry:ListTagsForResource` on this account and region's
  `registry/*` resources without unsupported resource-tag conditions.
  `agent-registry:DeleteRegistry` uses the same account-and-region resource
  ceiling but requires `auto-delete=no`,
  `project=agentic-ai-platform-demo`, and
  `managedBy=hosted-acceptance`. Exact handler validation also binds the
  supplied Registry ID, ARN, account, region, deterministic name,
  description, domain identity, and run ownership before deletion. The broker
  has no domain-Registry `agent-registry:TagResource` permission;
- `bedrock-agentcore:DeleteWorkloadIdentity` on exactly two resources in the
  deployment account and region:
  `workload-identity-directory/default` and
  `workload-identity-directory/default/workload-identity/registry-*`.
  Agent Registry deletion authorizes removal against both the directory
  resource and its generated `registry-<registryId>` workload identity child.
  The broker receives no other AgentCore Identity action and its handler has no
  direct AgentCore Identity client path to create, read, list, or delete an
  unrelated workload identity;
- `dynamodb:GetItem`, `dynamodb:PutItem`, and `dynamodb:DeleteItem`. Transaction
  writes authorize the underlying `PutItem` and `DeleteItem` operations only when
  `dynamodb:EnclosingOperation=TransactWriteItems`; the broker role does not
  grant the ineffective `dynamodb:TransactWriteItems` IAM action. All of these
  permissions are scoped to the exact `PlatformStateTableName`. Existing
  actor-mapping and request cleanup remains limited to `HOSTED_ACCEPTANCE` and
  `REQUEST#*`; domain reads remain limited to `DOMAIN`. Writes of the durable
  actor mapping are limited to the exact `HOSTED_ACCEPTANCE` partition key. The
  positive End User acceptance fixture is one atomic transaction over only
  `PROJECT#*`, `AGENT#*`, `DEPLOYMENT#*`, and `ENTITLEMENT#*`, followed by four
  exact consistent reads and an atomic child-first cleanup transaction. Every
  item key and field is derived from the run ownership, selected active domain,
  and authenticated Cognito subject. The broker never receives `Scan`,
  `BatchWriteItem`, table-management actions, or prefix-based deletion;
- `bedrock-agentcore:GetAgentRuntime` and
  `bedrock-agentcore:GetAgentRuntimeEndpoint` on the exact governed Runtime and
  production endpoint. AgentCore authorization requires the endpoint read to
  name both the Runtime and its exact production endpoint. The broker resolves
  the live READY Runtime identity and matching endpoint live version before it
  writes the temporary production deployment record. If AgentCore returns the
  optional endpoint target version, it must also match; an omitted target on a
  stable READY endpoint is accepted. Recovery and cleanup validate the persisted
  provision-time identity and its bound test-evidence hash without re-reading
  live Runtime state, so a later Runtime version change or temporary non-READY
  state cannot strand the four acceptance records;

Ignored deployment outputs include
`HostedAcceptanceBrokerFunctionArn`. The production adapter uses Lambda Invoke
against that exact identifier for nine allowlisted operations:
`persistActorMapping`, `recoverActorMapping`, `createRegistryFixture`,
`recoverRegistryFixture`, `recoverDomain`, `provisionExperienceFixture`,
`recoverExperienceFixture`, `cleanupExperienceFixture`, and
`cleanupExactResources`.
Requests and responses are bounded and stable; production composition does not
construct direct Registry or DynamoDB clients under hosted acceptance role
credentials.

The broker Lambda timeout is 120 seconds. Its resource-operation caller
deadline is 150 seconds, so a caller cannot time out and retry while the prior
Lambda invocation is still running. Resource cleanup retries remain sequential.
API, browser, and Cognito operation deadlines remain independently bounded at
20 seconds.

The temporary domain path is classified server-side only when the authenticated
verifier username is exactly either
`hosted-acceptance-admin-<runId>-<attempt>` or
`hosted-role-switching-admin-<runId>-<attempt>`, and the generated domain ID,
name, owner group, and deterministic request ID all match that run. The initial CreateRegistry
call includes `auto-delete=no`,
`project=agentic-ai-platform-demo`, and
`managedBy=hosted-acceptance`. Normal domain creation remains
`managedBy=cdk`. Both paths include the dependent
`agent-registry:TagResource` authorization with exact request-tag and
`aws:TagKeys` conditions; no client-supplied acceptance flag is trusted.

Do not grant `Scan`, an unfiltered Registry listing permission, prefix-based
deletion, or deletion of baseline Registries and records. The acceptance
fixture is one uniquely named CUSTOM Blueprint in an existing Registry
discovered from the live `/api/registry` response. Every taggable fixture
resource keeps `auto-delete=no`, `project=agentic-ai-platform-demo`, and
`managedBy=hosted-acceptance`; explicit exact-resource acceptance cleanup is
still permitted.

Production browser verification runs in a killable child process. Tokens cross
the process boundary only through private stdin, never argv or environment.
The worker and Chromium receive a minimal explicit environment allowlist;
`AWS_*`, `ACTIONS_*`, `GITHUB_TOKEN`, and all unrelated variables are excluded.
The child injects the tokens into `console.cognito.tokens` in browser
`sessionStorage`. It creates the unique temporary domain through the visible
Domains form, checks the returned Registry ID and separate Cognito-group
instruction, reloads and confirms persistence, opens the unique `IN_REVIEW`
fixture, makes the administrator decision, and confirms the selected drawer
shows the refreshed authoritative status. It also checks the live AWS label,
exact representative Blueprint, Skill, Model, and MCPServer row IDs and types,
and desktop/mobile layout bounds.
Worker stdout contains only an explicit allowlist of resource identities,
authoritative statuses, and mutation request IDs needed by the parent for
verification and cleanup. It contains no request payloads.
It contains no arbitrary API response bodies. The parent reconstructs both
deterministic mutation payloads
from the run ownership values and compares only allowlisted response identity
and status fields during idempotent replay.
The worker uses an isolated POSIX process group.
If a browser operation or close hangs, the parent sends the negative PID a
`SIGKILL`, falls back to a direct child `SIGKILL` when group delivery fails,
destroys the worker stdio handles, and uses a secondary bounded close deadline
to wait for exit. It returns a stable sanitized failure before any bounded retry,
so browser attempts never overlap. A browser retry is allowed only when the
process-group `SIGKILL` was delivered and the worker exit was confirmed within
the bounded wait. Under that confirmed process-group cleanup, the worker and its
in-group descendant processes are terminated before a retry. If process-group
delivery fails and the direct-child fallback closes the worker, that failure is
not retried because descendants may remain alive. If exit remains unconfirmed,
group and direct-child termination are retried, all stdio handles are destroyed,
and the child is released with `unref()` before the bounded return. That
unconfirmed fallback is not retried and does not guarantee descendant
termination.
An explicit worker cleanup/close failure follows the same rule: the parent sends
process-group `SIGKILL`, checks that the complete group is absent, and retries
only after that confirmation. A failed kill or a group that remains signalable
fails without retry.

Password-bearing AWS CLI requests reuse the private JSON-file transport; no
password or token is placed in argv, workflow outputs, summaries, logs,
returned objects, or tracked files. Browser screenshots exist only in a
mode-`0700` temporary directory. The runner removes that directory and attempts
deletion of both verifier usernames plus exact resource cleanup in `finally`,
including after partial fixture creation, API failure, browser failure, absent
browser output, or one cleanup failure. The parent process, not the killable
browser child, owns cleanup. It recovers the deterministic domain through
administrator `GET /api/domains` and then exact DynamoDB lookup when needed.
Experience-fixture responses are validated against the deterministic run-owned
identity. If a successful provision response is missing or mismatched, exact
recovery remains authoritative for deletion before the runner reports the
sanitized integrity failure.
It deletes only the verified fixture `registryId`/`recordId`, returned empty
domain Registry, deterministic domain item, and exact temporary domain-create
request state.
Hosted control-plane acceptance writes its durable actor mapping before it
creates the positive End User fixture or launches the browser. Cleanup-only
recovers that mapping with one exact `GetItem` and never scans the table. The
authenticated Cognito subject remains authoritative for domain recovery; if both
the verifier subject and actor mapping are unavailable, cleanup fails closed.
Role-switching does not create a durable actor mapping. Cleanup-only first
validates the exact managed verifier username, its run-bound `name`, and its
`custom:managed_by=agentic-ai-platform-demo` ownership marker, then reads the
immutable Cognito subject. Normal acceptance records a verifier only after
`AdminCreateUser` succeeds and deletes only those users created by that
invocation; a create collision is never cleanup-owned. Cleanup-only uses one
actor-bound Query on only the
`ENTITLEMENT#<subject>` partition to discover at most one deterministic
experience fixture, followed by exact consistent reads of all four records
before deletion. Hosted acceptance deletes temporary verifier users before
exact group cleanup, then verifies group absence before deleting the owned
Registry and DynamoDB state. If verifier deletion, exact group ownership
validation, empty-membership validation, group deletion, or absence
confirmation fails, cleanup fails closed and retains the later state needed for
recovery. An exact actor mapping written by another hosted acceptance phase for
the same run may be used as a validated fallback, but role-switching does not
rely on creating one.
Hosted control-plane acceptance cleanup intentionally preserves the Registry decision
request result, immutable audit, and semver record lock. It deletes only the exact temporary domain-create request state.
Any recovered actor mapping is deleted only after all temporary resource cleanup succeeds;
exact request-item cleanup succeeds before
deletion.
These permanent records remain coherent for idempotent replay and the
governance retention contract. A deterministic Cognito username is never
sufficient ownership proof: a missing or mismatched managed marker fails closed
without deleting that user. Exact not-found from the initial user lookup is
success; every other lookup, validation, or deletion error fails the deployment
with a generic redacted error.

The workflow does not rely only on in-process cleanup. Three adjacent
`if: always()` recovery steps run after acceptance: the first reacquires
`AgenticPlatformGitHubDeployRole` through OIDC, the second role-chains to
`AgenticPlatform-Web-HostedAcceptanceRole`, and the third invokes
`--cleanup-only`. Despite its legacy step label, that mode first validates and
deletes both temporary verifier users, then deletes the exact empty
operation-owned group, verifies group absence, and only then deletes the
remaining run-owned AWS resources. Recovery uses the non-secret run ID and attempt plus the
ignored `infra/platform-registry/control-plane-outputs.json` and
`infra/serverless-platform/deployment-outputs.json` files. It treats exact
not-found as success and runs before `Publish deployment summary`.

For manual recovery, use the same account and region as the output files.
Cleanup can recover the administrator subject from the exact durable actor
mapping even when the verifier user or domain item is already absent:

```bash
set -euo pipefail

export AWS_ACCOUNT_ID="<account-id>"
export AWS_REGION="us-west-2"
export HOSTED_ACCEPTANCE_RUN_ID="<run-id>"
export HOSTED_ACCEPTANCE_RUN_ATTEMPT="<run-attempt>"
export HOSTED_ACCEPTANCE_CONTROL_PLANE_OUTPUTS_FILE="$PWD/infra/platform-registry/control-plane-outputs.json"
export HOSTED_ACCEPTANCE_WEB_OUTPUTS_FILE="$PWD/infra/serverless-platform/deployment-outputs.json"

node e2e/hosted-control-plane-acceptance.mjs --cleanup-only
```

No password, token, request body, or credential belongs in these arguments.
Recovery validates the output documents, account, region, deterministic
run-owned names and IDs, AWS ARNs, descriptors, and required tags before any
delete.

Newly created users and refreshed `FORCE_CHANGE_PASSWORD` users must complete
the password-change challenge at first sign-in. Verified `CONFIRMED` users keep
their existing permanent passwords.

## GitHub deployment after push

After commit and push,
`.github/workflows/verify-serverless-platform.yml` runs for `main` and
`feat/serverless-aws-deployment`. It contains the push and manual triggers,
verification job, main-only deployment gate, and local reusable-workflow call.
The trusted path `.github/workflows/deploy-serverless-platform.yml` has
`workflow_call` only and contains the AWS deployment job required by the
`job_workflow_ref` trust condition.

Feature-branch pushes run verification only. The deploy job is main-only and is
skipped unless the event is a push, the ref is exactly `refs/heads/main`,
`github.ref_protected == true`, and both `ENABLE_GITHUB_DEPLOYMENT=true` and
`BRANCH_PROTECTION_ATTESTED=true`. Manual `workflow_dispatch` runs are
verification-only because both the deployment call and called job repeat that
exact push-only gate. For the current target those controls remain disabled, so
pushes cannot reach AWS.

Immediately after checkout, `Verify checked commit is current main head` runs
`git ls-remote --exit-code origin refs/heads/main` and requires exactly one
well-formed result whose SHA equals both the checked-out commit and
`GITHUB_SHA`. Missing, duplicate, malformed, or mismatched results fail before
OIDC credential configuration. A historical rerun therefore fails closed after
`main` advances instead of deploying an older commit as a rollback.

`.github/workflows/verify-serverless-platform.yml` runs a targeted secretless
browser authentication fixture. Its checkout sets `persist-credentials: false`,
and its Node cache is keyed by `package-lock.json`, `e2e/package-lock.json`,
`infra/platform-registry/package-lock.json`, and
`infra/serverless-platform/package-lock.json`. It installs and audits all four
locked dependency trees, tests/builds/synthesizes the control plane before the
web synth, then runs
`npm --prefix e2e exec -- playwright install --with-deps --only-shell chromium`
with a 10-minute timeout. After CDK synth it directly runs
`node --test e2e/smoke-auth-integration.mjs` with a 5-minute timeout. It does not
run `e2e/run-all.mjs` or `npm --prefix e2e test`. The fixture receives no
credentials, secret environment, or `COGNITO_DEMO_USER_PASSWORDS_JSON`.
`.github/workflows/deploy-serverless-platform.yml` also sets
`persist-credentials: false`. Its protected deployment job installs the locked
e2e dependency tree and Chromium headless shell so it can run only the hosted
post-deployment acceptance gate; it does not run the broad local
`e2e/run-all.mjs` suite.

The implemented sequence is:

1. `Verify serverless platform` installs locked root, e2e, control-plane, and
   web dependencies; runs root/control-plane/web tests and builds; audits all
   four dependency trees; synthesizes `AgenticPlatform-ControlPlane-Provisioned` in
   secretless provision mode before `PlatformWebStack`; and then runs only the
   targeted browser authentication fixture.
2. The main-only call invokes the reusable deployment workflow only after
   verification and only when the push, exact main ref, live protected-ref, and
   both governance-variable checks pass.
3. `Checkout repository` disables persisted GitHub credentials.
4. `Verify checked commit is current main head` confirms the checkout and
   current remote `main` SHA before any OIDC credential configuration.
5. `Install locked deployment dependencies` installs root, e2e, control-plane,
   and web dependencies, then `Install Chromium headless shell` installs the
   pinned Playwright browser before AWS credentials are configured.
6. `Validate deployment configuration` checks repository settings, mode,
   mode-specific protected variables, immutable repository IDs, workflow ref,
   and explicit OIDC subject metadata.
7. `Configure AWS credentials with GitHub OIDC` assumes
   `AgenticPlatformGitHubDeployRole`.
8. `Verify AWS caller and CDK bootstrap` enforces account, region, and bootstrap
   version guards.
9. `Run security audit before control-plane diff` runs immediately before
   `Review control-plane changes`.
10. `Run security audit before control-plane deploy` runs immediately before
    `Deploy control-plane stack`.
11. `Validate control-plane outputs and tags` verifies the selected physical
    stack, stable export names, mandatory tags, and exact protected IDs in
    `reference-existing` mode.
12. `Run security audit before web diff` runs immediately before
    `Review web changes`.
13. `Run security audit before web deploy` runs immediately before
    `Deploy PlatformWebStack`, which writes `deployment-outputs.json`.
14. `Validate security target after web deploy` runs `postdeploy` immediately
    after `Deploy PlatformWebStack`. It uses that deployment’s synthesized Web
    template to check all current IAM roles, policy contents and boundary
    bindings, plus the existing table and shared boundary checks, before any
    deployment output is consumed.
15. `Parse deployment outputs` validates and emits the application URL,
    user-pool ID, and user-pool client ID without credentials.
16. `Validate deployed project tags` verifies the mandatory tags, including
    `auto-delete=no`, on supported/taggable project resources while the deploy
    role is still active.
17. `Smoke test deployed application` checks health and unauthenticated identity
    behavior under the deploy-role phase.
18. `Assume hosted acceptance role` role-chains to the exact web-stack role for
    a 3600-second session.
19. `Run hosted control-plane acceptance` has a 20-minute limit and proves
    canonical authenticated administrator APIs, real domain provisioning and
    reload persistence, end-user mutation isolation, idempotent replay,
    authoritative Registry governance, and desktop/mobile live-AWS browser
    rendering through the killable worker.
20. `Reacquire GitHub deploy role for verifier cleanup` runs with
    `if: always()` and obtains fresh OIDC credentials.
21. `Assume hosted acceptance role for verifier cleanup` also runs with
    `if: always()` and role-chains to the exact acceptance role.
22. `Delete hosted acceptance verifier users` runs with `if: always()`. Its
    legacy step label invokes `--cleanup-only`, which has a 20-minute recovery
    limit, exact AWS resource recovery and deletion, and bounded retries for
    both deterministic verifier names.
23. `Publish deployment summary` runs only after recovery cleanup.

The verification job has only `contents: read`. `id-token: write` exists only
on the main-gated reusable-workflow call and the called deployment job. When
enabled, deployment uses OIDC, not long-lived AWS keys. Account and region
guards, audit failure, diff/deploy failure, invalid outputs, or
smoke-test, acceptance, or cleanup failure stop the job.

## Smoke tests

Load the application URL from the local outputs:

```bash
set -euo pipefail

export APPLICATION_URL="$(
  node -e '
    const fs = require("node:fs");
    const document = JSON.parse(
      fs.readFileSync("infra/serverless-platform/deployment-outputs.json", "utf8"),
    );
    const matches = Object.values(document).filter(
      (stack) => stack && typeof stack.ApplicationUrl === "string",
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one ApplicationUrl output; found ${matches.length}.`);
    }
    process.stdout.write(matches[0].ApplicationUrl.replace(/\/+$/, ""));
  '
)"

HEALTH_STATUS=""
for attempt in {1..12}; do
  HEALTH_STATUS="$(
    curl \
      --silent \
      --show-error \
      --connect-timeout 10 \
      --max-time 30 \
      --output /dev/null \
      --write-out '%{http_code}' \
      "${APPLICATION_URL}/api/health" \
      || true
  )"
  if [[ "$HEALTH_STATUS" == "200" ]]; then
    break
  fi
  printf 'Health check attempt %s returned HTTP %s.\n' \
    "$attempt" "${HEALTH_STATUS:-curl-error}"
  if (( attempt < 12 )); then
    sleep 10
  fi
done
[[ "$HEALTH_STATUS" == "200" ]] || {
  printf 'GET /api/health returned HTTP %s instead of 200.\n' \
    "${HEALTH_STATUS:-curl-error}" >&2
  exit 1
}

ME_STATUS=""
for attempt in {1..12}; do
  ME_STATUS="$(
    curl \
      --silent \
      --show-error \
      --connect-timeout 10 \
      --max-time 30 \
      --output /dev/null \
      --write-out '%{http_code}' \
      "${APPLICATION_URL}/api/me" \
      || true
  )"
  if [[ "$ME_STATUS" == "401" ]]; then
    break
  fi
  printf 'Identity check attempt %s returned HTTP %s.\n' \
    "$attempt" "${ME_STATUS:-curl-error}"
  if (( attempt < 12 )); then
    sleep 10
  fi
done
[[ "$ME_STATUS" == "401" ]] || {
  printf 'Unauthenticated GET /api/me returned HTTP %s instead of 401.\n' \
    "${ME_STATUS:-curl-error}" >&2
  exit 1
}
```

`GET /api/health` must return HTTP `200`. An unauthenticated `GET /api/me` must
return HTTP `401`. Do not require a Lambda-specific response body because API
Gateway can reject the request before Lambda runs.

Complete these browser checks:

1. Start the Cognito hosted login.
2. Sign in as an existing authorized user.
3. Confirm the browser returns to the CloudFront URL.
4. Inspect the authenticated `GET /api/me` projection for the Cognito subject,
   username, name, optional email, projected role, groups, domains,
   capabilities, and `identityProvider`.
5. Confirm the authorizer claims contain an own `token_use=access`. Missing,
   inherited, or `token_use=id` claims are rejected; ID tokens receive HTTP
   `401`.
6. Confirm no token, password, authorization header, client secret, API key, or
   other secret appears in the response.
7. Log out and confirm the Cognito session is cleared.
8. Request `/api/me` without authentication and confirm HTTP `401`.

Do not paste browser tokens into logs, issues, terminal history, or evidence.

## Account portability

For another account:

1. Set `AWS_ACCOUNT_ID=<account-id>`, `AWS_REGION=us-west-2`,
   `GITHUB_REPOSITORY=<owner/repo>`, `GITHUB_REPOSITORY_ID=<repository-id>`,
   `GITHUB_REPOSITORY_OWNER_ID=<repository-owner-id>`,
   `GITHUB_WORKFLOW_REF=<owner/repo>/.github/workflows/deploy-serverless-platform.yml@refs/heads/main`,
   one exact legacy or immutable subject-mode/value pair, and
   `COGNITO_DOMAIN_PREFIX=<unique-cognito-prefix>`.
2. Confirm Bash, Node, AWS CLI identity, clone origin, and bootstrap status.
3. Run the repository audit. Use `bootstrap-new` when `CDKToolkit` is
   expected to be absent, default `deploy` mode for a compliant existing
   toolkit, or the separately approved `bootstrap-remediate` path for an
   existing unprotected or outdated toolkit.
4. For a new account, obtain a customer-approved
   `CDK_BOOTSTRAP_EXECUTION_POLICY_ARN` and bootstrap with the required policy,
   termination protection, and tags.
5. For the current-account path, use `reference-existing` and supply all six
   Registry/Gateway IDs at runtime without writing them to tracked files. For a
   clean customer account, use `provision`, supply no existing IDs, and deploy
   `AgenticPlatform-ControlPlane-Provisioned`.
6. Deploy the selected control-plane physical stack first, validate its stable
   exports, then synthesize, diff, and deploy `PlatformWebStack`.
7. Leave GitHub AWS deployment disabled unless an administrator confirms the
   repository supports protected `main` and supplies that governance.
8. For an eligible protected repository only, re-detect the OIDC provider,
   explicitly deploy `GitHubBootstrapStack` with
   `enableGitHubDeployment=true`, `branchProtectionAttested=true`, all six
   exact repository/workflow/subject contexts, and the optional provider
   context, then set the protected repository variables.

Choose a unique Cognito prefix. Do not copy outputs, ARNs, resource IDs,
passwords, or tokens between accounts.

## Post-merge trust cleanup

There is no feature-branch trust to remove: the bootstrap stack can trust only
protected `main`. Feature-branch pushes may remain as verification-only
triggers.

After an administrator enables GitHub deployment for a different eligible
repository and the protected `main` deployment passes smoke tests:

1. Set `GITHUB_OIDC_PROVIDER_MODE` to the recorded OIDC provider ownership mode:
   `create` for stack-owned or `import` for a pre-existing provider.
2. Run the repository `security:audit`.
3. Re-detect and validate the provider immediately before both the bootstrap
   diff and deploy.
4. Confirm the role trust contains the exact selected legacy or immutable
   protected-`main` subject.

The audit must again confirm these exact pre-existing roles use
`AgenticPlatform-Web-RuntimePermissionsBoundary`:

- `AgenticPlatform-Web-AccessAdminApiRole`
- `AgenticPlatform-Web-AgentRuntimeRole`
- `AgenticPlatform-Web-BuilderApiRole`
- `AgenticPlatform-Web-IdentityApiRole`
- `AgenticPlatform-Web-JourneyApiRole`
- `AgenticPlatform-Web-DeploymentApiRole`
- `AgenticPlatform-Web-ExperienceApiRole`
- `AgenticPlatform-Web-FrontendDeploymentRole`
- `AgenticPlatform-Web-GovernanceApiRole`
- `AgenticPlatform-Web-GatewayInvokerRole`
- `AgenticPlatform-Web-CloudFrontInvalidationProviderRole`
- `AgenticPlatform-Web-CloudFrontAlarmProviderRole`
- `AgenticPlatform-Web-ControlPlaneReadApiRole`
- `AgenticPlatform-Web-OperationsApiRole`
- `AgenticPlatform-Web-PlatformAdminApiRole`
- `AgenticPlatform-Web-PlatformAgentRegistrySeedRole`
- `AgenticPlatform-Web-RegistryDecisionFinalizerRole`
- `AgenticPlatform-Web-PlatformStateSeedRole`
- `AgenticPlatform-Web-PlatformWorkspaceSeedRole`
- `AgenticPlatform-Web-HostedAcceptanceBrokerRole`
- `AgenticPlatform-Web-RuntimeBoundaryTagProviderRole`
- `AgenticPlatform-Web-WorkspaceApiRole`
- `AgenticPlatform-Web-ModelGovernanceApiRole`
- `AgenticPlatform-Web-RuntimeProofConfiguratorRole`
- `AgenticPlatform-Web-RuntimeProofProviderRole`

The audit must separately confirm that
`AgenticPlatform-Web-HostedAcceptanceRole` has no permissions boundary and
matches its exact trust and inline-policy contract.

Run this entire block in one Bash process:

```bash
set -euo pipefail

export ENABLE_GITHUB_DEPLOYMENT=true
export BRANCH_PROTECTION_ATTESTED=true
: "${GITHUB_REPOSITORY_ID:?Run target confirmation with the repository ID.}"
: "${GITHUB_REPOSITORY_OWNER_ID:?Run target confirmation with the owner ID.}"
: "${GITHUB_WORKFLOW_REF:?Run target confirmation with the reusable workflow ref.}"
: "${GITHUB_OIDC_SUBJECT_MODE:?Choose legacy or immutable subject mode.}"
: "${GITHUB_OIDC_SUBJECT:?Set the exact subject for the chosen mode.}"

prepare_github_bootstrap_context() {
  : "${GITHUB_OIDC_PROVIDER_MODE:?Set the recorded mode: create or import.}"
  case "$GITHUB_OIDC_PROVIDER_MODE" in
    create|import) ;;
    *)
      printf 'GITHUB_OIDC_PROVIDER_MODE must be create or import.\n' >&2
      return 1
      ;;
  esac

  GITHUB_OIDC_CONTEXT=()
  GITHUB_OIDC_PROVIDER_ARN=""

  local oidc_list_json
  local github_provider_arns
  local provider_json
  local stack_resources_json

  oidc_list_json="$(
    aws iam list-open-id-connect-providers \
      --region "$AWS_REGION" \
      --output json
  )"
  github_provider_arns="$(
    OIDC_LIST_JSON="$oidc_list_json" node <<'NODE'
const document = JSON.parse(process.env.OIDC_LIST_JSON);
if (!Array.isArray(document.OpenIDConnectProviderList)) {
  throw new Error("OIDC provider list is malformed.");
}
const providerMarker = "oidc-provider/token.actions.githubusercontent.com";
const arns = document.OpenIDConnectProviderList
  .map((provider) => provider?.Arn)
  .filter(
    (arn) => typeof arn === "string" && arn.includes(providerMarker),
  );
process.stdout.write(arns.join("\n"));
NODE
  )"

  if [[ "$github_provider_arns" == *$'\n'* ]]; then
    printf 'Multiple GitHub Actions OIDC providers found.\n' >&2
    return 1
  fi
  if [[ -z "$github_provider_arns" ]]; then
    printf 'GitHub Actions OIDC provider is absent; refusing trust cleanup.\n' >&2
    return 1
  fi

  GITHUB_OIDC_PROVIDER_ARN="$github_provider_arns"
  provider_json="$(
    aws iam get-open-id-connect-provider \
      --open-id-connect-provider-arn "$GITHUB_OIDC_PROVIDER_ARN" \
      --region "$AWS_REGION" \
      --output json
  )"
  OIDC_PROVIDER_JSON="$provider_json" node <<'NODE'
const provider = JSON.parse(process.env.OIDC_PROVIDER_JSON);
if (provider.Url !== "token.actions.githubusercontent.com") {
  throw new Error("GitHub Actions OIDC provider URL is malformed.");
}
if (
  !Array.isArray(provider.ClientIDList)
  || !provider.ClientIDList.includes("sts.amazonaws.com")
) {
  throw new Error("GitHub Actions OIDC provider lacks sts.amazonaws.com.");
}
NODE

  if [[ "$GITHUB_OIDC_PROVIDER_MODE" == "import" ]]; then
    GITHUB_OIDC_CONTEXT=(
      -c "githubOidcProviderArn=${GITHUB_OIDC_PROVIDER_ARN}"
    )
    return 0
  fi

  if [[ "$GITHUB_OIDC_PROVIDER_MODE" == "create" ]]; then
    stack_resources_json="$(
      aws cloudformation list-stack-resources \
        --stack-name AgenticPlatform-GitHubBootstrap \
        --region "$AWS_REGION" \
        --output json
    )"
    STACK_RESOURCES_JSON="$stack_resources_json" \
      EXPECTED_PROVIDER_ARN="$GITHUB_OIDC_PROVIDER_ARN" \
      node <<'NODE'
const document = JSON.parse(process.env.STACK_RESOURCES_JSON);
const owned = document.StackResourceSummaries?.some(
  (resource) =>
    resource.ResourceType === "AWS::IAM::OIDCProvider"
    && resource.PhysicalResourceId === process.env.EXPECTED_PROVIDER_ARN,
);
if (!owned) {
  throw new Error(
    "Create mode requires the bootstrap stack to own the existing provider.",
  );
}
NODE
  fi
}

prepare_github_bootstrap_context
SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/serverless-platform run diff -- GitHubBootstrapStack \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "repository=${GITHUB_REPOSITORY}" \
  -c "repositoryId=${GITHUB_REPOSITORY_ID}" \
  -c "repositoryOwnerId=${GITHUB_REPOSITORY_OWNER_ID}" \
  -c "workflowRef=${GITHUB_WORKFLOW_REF}" \
  -c "githubOidcSubjectMode=${GITHUB_OIDC_SUBJECT_MODE}" \
  -c "githubOidcSubject=${GITHUB_OIDC_SUBJECT}" \
  -c enableGitHubDeployment=true \
  -c branchProtectionAttested=true \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}" \
  ${GITHUB_OIDC_CONTEXT[@]+"${GITHUB_OIDC_CONTEXT[@]}"}

prepare_github_bootstrap_context
SECURITY_AUDIT_MODE=deploy npm --prefix infra/serverless-platform run security:audit
npm --prefix infra/serverless-platform run deploy:bootstrap -- \
  -c "account=${AWS_ACCOUNT_ID}" \
  -c "region=${AWS_REGION}" \
  -c "repository=${GITHUB_REPOSITORY}" \
  -c "repositoryId=${GITHUB_REPOSITORY_ID}" \
  -c "repositoryOwnerId=${GITHUB_REPOSITORY_OWNER_ID}" \
  -c "workflowRef=${GITHUB_WORKFLOW_REF}" \
  -c "githubOidcSubjectMode=${GITHUB_OIDC_SUBJECT_MODE}" \
  -c "githubOidcSubject=${GITHUB_OIDC_SUBJECT}" \
  -c enableGitHubDeployment=true \
  -c branchProtectionAttested=true \
  -c "cognitoDomainPrefix=${COGNITO_DOMAIN_PREFIX}" \
  ${GITHUB_OIDC_CONTEXT[@]+"${GITHUB_OIDC_CONTEXT[@]}"}

aws iam get-role \
  --role-name AgenticPlatformGitHubDeployRole \
  --query Role.AssumeRolePolicyDocument \
  --output json
```

Do not add feature branches, pull-request subjects, or environment subjects to
deployment-role trust.

## Stage 1 exceptions and cautions

- The source specifies `TLS_V1_2_2021`, but Stage 1 uses the CloudFront default certificate
  and hostname. The custom-certificate TLS policy annotation does not change
  the default-certificate endpoint.
- CloudFront WAF requires a separate `us-east-1` edge stack before production.
- Both CDK stacks use termination protection. S3 buckets, Cognito, and log
  groups use `RETAIN` where loss would be unsafe.
- Stack deletion is not cleanup. Disable protection and remove retained
  resources only through a reviewed, deliberate cleanup plan.
- non-migrated panels may be empty even when authentication and `/api/me` work.

## Troubleshooting

### Cognito domain collision

Choose another globally unique lowercase prefix containing letters, numbers,
and internal hyphens. Update `COGNITO_DOMAIN_PREFIX`, run the repository audit,
review the application diff, and redeploy.

### Duplicate GitHub OIDC provider

Run `security:audit`. It fails if more than one provider ARN contains
`oidc-provider/token.actions.githubusercontent.com`. Do not treat list/get
failures as provider absence. Resolve ownership with the dependent teams; do
not delete a provider until all trusting roles are known.

### Retained runtime boundary recovery

`AgenticPlatform-Web-RuntimePermissionsBoundary` has a fixed name and a
`RETAIN` policy. After stack deletion or recreation, verify ownership and the
deployed policy hash against
`config/runtime-permissions-boundary.json` before taking any action. Under an
approved recovery procedure, either import or adopt the verified retained
policy into the recreated stack, or deliberately remove it before recreation.
Never overwrite or delete an unknown policy.

### 401 after login

Confirm the callback completed and `runtime-config.js` contains the expected
region, user-pool ID, client ID, Cognito domain, callback, and logout URLs.
Confirm `/api/me` receives an unexpired access token and that the deployed JWT
issuer and audience match the user pool and client. Inspect metadata without
printing the token.

### GitHub OIDC subject mismatch

Compare the repository, immutable IDs, selected mode, and branch with the role
trust. Legacy mode expects `repo:<owner/repo>:ref:refs/heads/main`; immutable
mode expects
`repo:<owner>@<repository-owner-id>/<repo>@<repository-id>:ref:refs/heads/main`.
The chosen mode and exact subject must match the deploy-phase audit and CDK
contexts. A fork, renamed repository, pull-request subject, feature branch,
other branch, or GitHub Environment does not match. Update
`GitHubBootstrapStack`, rerun audit and provider detection, then diff and deploy
with an approved identity.

## Domain bootstrap extension

The hosted Domains creation and foundation workflow has a separate deployment
runbook: [DOMAIN-BOOTSTRAP.md](DOMAIN-BOOTSTRAP.md). It connects to the existing
Web stack and Registry; it does not replace the normal Web deployment above.

## Governance Policy inventory

`GET /api/governance/runtime-policies` inspects the configured shared Gateways and
attached AgentCore Policy Engines for authenticated platform administrators.
It is a read-only JWT route with a dedicated `PolicyInventoryRole` and independent
`PolicyInventoryBoundary`; it does not inherit the shared write-capable runtime
ceiling. The boundary tag provider reconciles the exact new managed policy ARN
with the same required deployment tags. No policy authoring, attachment or
activation permission is granted. See [policy controls](../../docs/governance-policy-controls.md)
for scope, failure states and the distinction from approval drafts and CD gates.
