# Platform Registry Infrastructure

The portable AI Registry and AgentCore Gateway control plane has two explicit
deployment modes with isolated physical stack names:

- `reference-existing` uses `AgenticPlatform-ControlPlane`;
- `provision` uses `AgenticPlatform-ControlPlane-Provisioned`.

Both modes retain the stable export contract with the canonical
`AgenticPlatform-ControlPlane-...` prefix.

The deployment workflow reads the mode and any existing resource identifiers
only from protected GitHub repository variables:

| Repository variable | Required mode |
|---|---|
| `CONTROL_PLANE_MODE` | Both; exactly `reference-existing` or `provision`. |
| `CONTROL_PLANE_SHARED_REGISTRY_ID` | `reference-existing` only. |
| `CONTROL_PLANE_REGISTRY_PLATFORM_ID` | `reference-existing` only. |
| `CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID` | `reference-existing` only. |
| `CONTROL_PLANE_REGISTRY_OPERATIONS_ID` | `reference-existing` only. |
| `CONTROL_PLANE_LLM_GATEWAY_ID` | `reference-existing` only. |
| `CONTROL_PLANE_LLM_GATEWAY_REGION` | `reference-existing` only; the signing region for model discovery and inference. |
| `CONTROL_PLANE_TOOLS_GATEWAY_ID` | `reference-existing` only. |

All seven existing-resource variables must be empty in `provision` mode. Do not commit
live Registry or Gateway IDs to this README, workflows, runtime files,
generated tracked configuration, or test fixtures.

## Deployment Modes

### `reference-existing`

Use this mode when the target account already contains the required Registry
and Gateway resources. The stack:

- creates no Agent Registry resources or records;
- creates no Registry custom-resource Lambda or provider;
- creates no AgentCore Gateway or Gateway IAM role;
- adds the portable `bedrock-claude` provider target to the referenced LLM
  Gateway so Claude Messages traffic is routed to the working `us-east-1`
  Bedrock Mantle endpoint;
- stores the supplied IDs, ARNs, and URLs in
  `/agentic-platform/control-plane/config`;
- exposes the same CloudFormation output contract as provision mode.

The referenced resources remain outside this stack's ownership and cannot be
deleted by deleting the stack.

### `provision`

Use this mode for a new customer account. The stack creates:

| Resource | Purpose |
|---|---|
| `platform_shared` | Shared AWS Agent Registry for blueprints (`CUSTOM`), shared skills (`SKILL`), and shared A2A agents (`AGENT`). |
| `domain_platform` | Platform domain Registry. |
| `domain_customer_support` | Customer Support domain Registry. |
| `domain_operations` | Operations domain Registry. |
| Registry seed records | Skills, A2A agents, and catalog blueprints using the Agent Registry record contract. |
| `agentic-demo-llm-gateway` | AgentCore Gateway for model inference. |
| `bedrock-mantle` | Inference target on the LLM Gateway. |
| `bedrock-claude` | Claude Messages provider target routed to the `us-east-1` Bedrock Mantle endpoint. |
| `platform-tools-gw` | AgentCore Gateway for MCP/tool targets. |
| `aws-docs` | AWS Knowledge MCP target on the tools Gateway. |
| LLM Gateway IAM role | Mantle access for the LLM Gateway only. |
| Tools Gateway IAM role | Gateway execution role with no model-inference permissions. |
| Registry provider | On-event and is-complete Lambdas with asynchronous delete stabilization. |
| Runtime permissions boundary | Stack-owned least-privilege boundary applied to every provisioned control-plane IAM role. |
| CloudWatch log groups | Explicit retained 90-day log groups for both handlers and the provider framework. |
| SSM configuration parameter | Resolved IDs, ARNs, URLs, account, region, and mode. |

Seed records are created only in provision mode.

All managed resources are tagged with:

```json
{ "auto-delete": "no", "project": "agentic-ai-platform-demo", "managedBy": "cdk" }
```

Provision mode grants `agent-registry:CreateRegistry` on
`Resource: "*"` because the Registry ARN does not exist before creation. That
statement requires the exact mandatory request tags, the exact
`aws:TagKeys` set, and the configured `aws:RequestedRegion`. The dependent
`agent-registry:TagResource` statement uses the regional account Registry
wildcard and requires both the exact request tags and the resource's existing
mandatory ownership tags. Registry records receive the mandatory tags in their
initial create request. Existing Registry and record mutations require the
same exact resource tags, while reads remain scoped to regional account ARNs.

`reference-existing` creates no IAM role or policy and does not invoke the
custom-resource provider, so this unavoidable provision-only create permission
does not broaden reference mode.

`AWS::BedrockAgentCore::GatewayTarget` does not expose a `Tags` property in the
current CloudFormation schema. The stack tags the gateways, registries, registry
records, Lambda functions and IAM roles; target resources inherit ownership
through their parent gateway but are not directly tagged by CloudFormation.

## Prerequisites

- AWS credentials for the target account.
- The account must have access to `bedrock-mantle`. The LLM Gateway role is
  granted `bedrock-mantle:CreateInference` and
  `bedrock-mantle:GetProject` on the account's `project/default`, plus
  `bedrock-mantle:ListProjects` and
  `bedrock-mantle:ListTagsForResource` on `*` where the service requires it.
  The tools Gateway role receives none of these permissions.
- Region precedence is explicit CDK context `region`, then non-empty
  `AWS_REGION`, then non-empty `CDK_DEFAULT_REGION`, then `us-west-2`. Empty
  environment variables are skipped; whitespace-only or padded selected
  values are rejected.
- CDK bootstrapped in the target account/region.
- Node.js 22 for the combined clean-account deployment.
- **Agent Registry namespace**: registries use the standalone `agent-registry`
  service (the Registry feature moved out of `bedrock-agentcore`; the old
  namespace is discontinued **2026-09-17**). Client requirements:
  - JS SDK: `@aws-sdk/client-agent-registry-control` (>= 3.1110.0)
  - boto3 >= 1.43.71 (the custom-resource Lambda vendors it via
    `lambda/requirements.txt`, so synth needs Python 3.10+ with `python3 -m pip`
    or a running Docker daemon; the macOS system Python 3.9 is insufficient)
  - AWS CLI: `aws agent-registry-control ...` — note CLI 2.36.17 does NOT ship
    these commands yet; upgrade the CLI or use boto3 for manual checks.
  Gateway/runtime/memory resources correctly stay on `bedrock-agentcore`.

Quick checks before deploying:

```bash
# Is the AWS CLI new enough for registry smoke checks? (should not error)
aws agent-registry-control help

# Is the account/region already bootstrapped? (CREATE_COMPLETE or UPDATE_COMPLETE = yes, skip bootstrap)
aws cloudformation describe-stacks --stack-name CDKToolkit --region <region> --query 'Stacks[0].StackStatus'
```

If not bootstrapped (bootstrap is idempotent — re-running is safe):

```bash
npx cdk bootstrap aws://<account>/<region>
```

## Test

From the repository root:

```bash
npm --prefix infra/platform-registry run test:control-plane-config
npm --prefix infra/platform-registry run test:platform-registry-stack
npm --prefix infra/platform-registry run test:config-generator
python3 -m unittest infra/platform-registry/lambda/test_registry_handler.py
```

## Synthesize

The mode is required. Account can be supplied through CDK context or the
standard CDK environment variables. Region follows the precedence documented
in the prerequisites above.

### Current account: `reference-existing`

The currently deployed account uses `reference-existing`. Supply the seven
verified resource values through protected repository variables or an
untracked operator environment. The repository contains no fallback values.
No deployment mode accepts an external runtime permissions boundary ARN.

```bash
set -euo pipefail

export AWS_ACCOUNT_ID="<account-id>"
export AWS_REGION="us-west-2"
export CONTROL_PLANE_MODE="reference-existing"
: "${CONTROL_PLANE_SHARED_REGISTRY_ID:?Required for reference-existing.}"
: "${CONTROL_PLANE_REGISTRY_PLATFORM_ID:?Required for reference-existing.}"
: "${CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID:?Required for reference-existing.}"
: "${CONTROL_PLANE_REGISTRY_OPERATIONS_ID:?Required for reference-existing.}"
: "${CONTROL_PLANE_LLM_GATEWAY_ID:?Required for reference-existing.}"
: "${CONTROL_PLANE_LLM_GATEWAY_REGION:?Required for reference-existing.}"
: "${CONTROL_PLANE_TOOLS_GATEWAY_ID:?Required for reference-existing.}"

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

npm run infra:synth -- \
  "$CONTROL_PLANE_STACK_NAME" \
  "${CONTROL_PLANE_CONTEXT[@]}"
```

### Clean customer account: `provision`

`provision` must not require or receive existing IDs. It creates
`AgenticPlatform-ControlPlane-Provisioned` and publishes the same stable
exports consumed by `AgenticPlatform-Web`.

```bash
set -euo pipefail

export AWS_ACCOUNT_ID="<account-id>"
export AWS_REGION="us-west-2"
export CONTROL_PLANE_MODE="provision"
unset CONTROL_PLANE_SHARED_REGISTRY_ID
unset CONTROL_PLANE_REGISTRY_PLATFORM_ID
unset CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID
unset CONTROL_PLANE_REGISTRY_OPERATIONS_ID
unset CONTROL_PLANE_LLM_GATEWAY_ID
unset CONTROL_PLANE_LLM_GATEWAY_REGION
unset CONTROL_PLANE_TOOLS_GATEWAY_ID

CONTROL_PLANE_STACK_NAME="AgenticPlatform-ControlPlane-Provisioned"
CONTROL_PLANE_CONTEXT=(
  --context "mode=${CONTROL_PLANE_MODE}"
  --context "account=${AWS_ACCOUNT_ID}"
  --context "region=${AWS_REGION}"
)

npm run infra:synth -- \
  "$CONTROL_PLANE_STACK_NAME" \
  "${CONTROL_PLANE_CONTEXT[@]}"
```

## Deploy

From the repository root:

```bash
npm ci
npm run infra:install
npm run infra:verify
```

After building the applicable context array above, run the repository security
audit immediately before both the control-plane diff and deploy:

```bash
npm --prefix infra/serverless-platform run security:audit
npm run infra:diff -- \
  "$CONTROL_PLANE_STACK_NAME" \
  "${CONTROL_PLANE_CONTEXT[@]}"

npm --prefix infra/serverless-platform run security:audit
npm run infra:deploy -- \
  "$CONTROL_PLANE_STACK_NAME" \
  --require-approval never \
  "${CONTROL_PLANE_CONTEXT[@]}"
```

Reference mode requires all seven existing-resource values. Provision mode rejects existing
resource IDs so an operator cannot accidentally mix ownership models.

Do not change the mode of an existing physical stack. The separate stack names
prevent a provisioned stack from being updated as a reference stack and
deleting resources it owns. The stable exports, and the shared SSM parameter
name, intentionally prevent both stacks from coexisting. A mode transition
must therefore be an explicit, reviewed replacement operation.

## Output Contract

Both modes write the complete resolved configuration to the tagged SSM
parameter `/agentic-platform/control-plane/config` and expose these output
values:

- shared Registry ID and ARN;
- Platform, Customer Support, and Operations Registry IDs and ARNs;
- LLM Gateway ID, ARN, and inference URL;
- tools Gateway ID, ARN, and MCP URL;
- region;
- SSM configuration parameter name.

The seven reference-contract exports are:

```text
AgenticPlatform-ControlPlane-SharedRegistryId
AgenticPlatform-ControlPlane-Registry-platform-Id
AgenticPlatform-ControlPlane-Registry-customer-support-Id
AgenticPlatform-ControlPlane-Registry-operations-Id
AgenticPlatform-ControlPlane-LlmGatewayId
AgenticPlatform-ControlPlane-LlmGatewayRegion
AgenticPlatform-ControlPlane-ToolsGatewayId
```

The configuration document keeps `customer_support` as its domain key.
CloudFormation export names use `customer-support` because export names permit
alphanumeric characters, colons, and hyphens, but not underscores.

ARNs, URLs, region, and the parameter name are exported using the same
`AgenticPlatform-ControlPlane-...` naming convention.

## Generate Console Configuration

The root `infra:config` command converts a CDK outputs file into the current
`console/registry-config.json` and `console/gateway-config.json` contracts:

```bash
npm run infra:config
```

The generator accepts a flat output object or an outputs file wrapped by either
physical stack name:

- `AgenticPlatform-ControlPlane`;
- `AgenticPlatform-ControlPlane-Provisioned`.

If one file contains both stacks, set `CDK_STACK_NAME` explicitly. Generated
configuration uses `platform_shared`, the three `domain_...` Registry names,
`platform-tools-gw`, and `agentic-demo-llm-gateway`. It does not emit a Gateway
execution role or hardcoded target state; those remain AWS-managed resources
queried through the configured Gateway IDs.

## Smoke Checks

After deployment and config generation:

```bash
# requires an AWS CLI new enough to include agent-registry-control
# (2.36.17 lacks it — use boto3 if upgrading is not an option)
aws agent-registry-control list-registries --region <region>
aws agent-registry-control list-registry-records --registry-id <shared-registry-id> --region <region>
```

Expected shared-registry seed shape:

- 10 `CUSTOM` blueprint records.
- shared `SKILL` records.
- shared `AGENT` (A2A) records where present.

Domain registries contain the skills/A2A agents owned by that domain.

## Registry Record Lifecycle

Record identity is `registryRef + canonical name + version`. CDK rejects
duplicate canonical identities and unknown Registry references, and derives
each custom-resource construct ID from that identity so seed reordering does
not replace records.

Record content is immutable at a given name and version. Updating
`displayName`, `description`, `recordType`, `recordVersion`, or `descriptors`
requires a version bump. A name or version change creates a new physical record
and allows CloudFormation to delete the old stack-owned record.

On same-key updates, `StatusTarget` is a minimum lifecycle stage ordered as
`DRAFT < PENDING_APPROVAL < APPROVED`. If the actual status already satisfies
the requested minimum, including during rollback to an earlier minimum, the
handler preserves the physical ID without mutating the record. Advancing beyond
the actual status requires a version bump.

Create-time referenced conflicts are accepted only when their content matches
and their current status already equals `StatusTarget`. Referenced records are
never tagged, submitted, approved, status-mutated, or deleted.

Console seed status `IN_REVIEW` is normalized to the AWS
`PENDING_APPROVAL` target. Provisioning supports `DRAFT`,
`PENDING_APPROVAL`, and `APPROVED`; a pending target submits the record and
verifies that it reached `PENDING_APPROVAL` without auto-approving it.

Registry and record create requests use deterministic SHA-256 client tokens
derived from the CloudFormation stack ID, logical resource ID, request ID, and
immutable resource key. Same-event retries therefore retain `created::`
ownership, while a later remove/re-add operation receives a different token.
Create responses missing an ARN are recovered by exact name/version where
possible and compensating deletion is stabilized before a failure is returned.

Registry updates reconcile both name and description, verify the resulting
`READY` state, and use the same path for forward changes and CloudFormation
rollback.

## Current Notes

Agent Registry is managed through a CDK custom resource in provision mode
because Registry resources are not represented by stable L2 CDK constructs in
this project. Gateways use native CloudFormation resources and remain on the
`bedrock-agentcore` namespace. Reference mode does not invoke the custom
resource or take ownership of existing Registry and Gateway resources.

The custom resource uses one bounded record-lifecycle deadline plus a separate
bounded cleanup deadline. A failure after creating a Registry or record
triggers compensating deletion and waits for actual absence; a failed or timed
out compensation reports that manual cleanup is required. CloudFormation
deletion uses the provider's is-complete handler and does not finish until the
stack-created resource is absent.
