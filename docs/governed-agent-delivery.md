# Governed Agent delivery

This delivery stack is separate from the shared platform bootstrap. It binds an
existing domain/project Agent and GitHub repository to a versioned artifact
bucket and a CodePipeline with dev, preprod, native human approval and prod.
It is not an automatic deployment claim for exported repositories.

## Installation

Verify STS, inspect the existing Web stack, and run the mandatory predeployment
audit in [the serverless runbook](../infra/serverless-platform/README.md).
Use the deployed HTTP API, Cognito authorizer, user pool and project table.
Do not create a project implicitly. The platform operator must confirm the
repository, requester subject, approved model and owning project.

Prepare a private JSON configuration matching `AgentDeliveryTarget` in
`infra/serverless-platform/lib/agent-delivery-stack.ts`. No credentials belong
in it. `trustedWorkflowRef` must reference this repository's
`.github/workflows/agent-delivery.yml` at a full 40-character commit SHA.
Each binding supplies:

- Immutable GitHub numeric `repositoryId` and current `owner/repository`.
- Existing `domainId`, `projectId`, `agentId` and `requesterSubject`.
- Unique `id` and AgentCore-compatible `runtimeName`.
- Approved Bedrock `modelId` and `inferenceProfileId`.
- Packaged `entrypoint`, `pythonRuntime` and platform `evaluationThreshold`.
- Optional `verificationPrompt`: a non-sensitive business scenario appropriate
  for this Agent (up to 2,000 characters). This deployment probe complements
  the exported business evaluation; it does not replace that evaluation.

An existing GitHub OIDC provider must be supplied as `githubOidcProviderArn`.
If none exists, the stack creates the native IAM provider. Current installation
supports the repository's deployment region, us-west-2; account IDs are inputs.

```sh
cd infra/serverless-platform
export AGENT_DELIVERY_CONFIG=/absolute/path/reviewed-agent-delivery.json
npx cdk synth --app 'npx tsx bin/agent-delivery.ts'
npx cdk diff --app 'npx tsx bin/agent-delivery.ts'
npx cdk deploy --app 'npx tsx bin/agent-delivery.ts' --require-approval broadening \
  --outputs-file /absolute/path/cdk-outputs.json
```

Review the synthesized IAM policies, boundaries, retained resources, tags and
pipeline order before deployment. The Web-stack audit does not independently
audit this new stack; inspect its deployed roles and compare its deployed
template with the reviewed synthesis too. Run the read-only delivery audit from
the repository root, using the assembly reviewed for this deployment:

```sh
python infra/serverless-platform/delivery/audit.py \
  --config /absolute/path/reviewed-agent-delivery.json \
  --template /absolute/path/cdk.out/AgentDeliveryStack.template.json \
  --output /absolute/path/delivery-audit.json
```

It checks the caller account, stable stack, termination protection, deployed
template, and exact role trust, boundaries, inline permissions and required tags.

Runtime creation also authorizes its default endpoint and workload identity.
The deploy role therefore needs the creation actions and `TagResource` on both
the default workload identity directory and its child identities, as well as
the Runtime resource. These creation permissions retain the binding's exact
domain/project/environment request-tag conditions in both the role and its
boundary. Review the shared default-directory scope explicitly when installing
or updating this stack; granting only the child identity ARN fails on AWS.

Each deployment verification uses a fresh synthetic actor and session. The
native `runtimeUserId` parameter alone does not propagate an identity to Agent
code: reserved `x-amzn-*` headers cannot be allowlisted. The trusted deployment
script therefore sends the same actor in
`X-Amzn-Bedrock-AgentCore-Runtime-Custom-User-Id`, adds it before SigV4 signing,
and configures that single header in the Runtime allowlist. The Foundation
adapter reads the forwarded actor; persistent Memory rejects an anonymous
fallback. The invocation hook is removed even when the request fails.

`InvokeAgentRuntimeForUser` remains scoped to the binding's environment runtime
prefix in both the deployment role and permissions boundary. This does not
grant a Builder arbitrary user impersonation or change production approval.
Successful release evidence records `probeActorId` and `probeSessionId`.
See [AWS Runtime header forwarding](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html)
for the service and SDK forwarding contract.

Enable reusable workflow access for the private Agent repository. Configure that
repository's OIDC subject to include exactly `repository_id` and
`job_workflow_ref`; the uploader trust binds both values, including the immutable
platform workflow SHA. Install a main-only caller workflow using that same SHA,
passing the stack's artifact bucket, uploader role and pipeline name plus the
owning domain/project/Agent. The caller needs contents read, actions read and
id-token write; the reusable packaging job explicitly has contents read only.

Generate that caller from the reviewed configuration and actual stack outputs:

```sh
python infra/serverless-platform/delivery/configure_repository.py \
  --config /absolute/path/reviewed-agent-delivery.json \
  --outputs /absolute/path/cdk-outputs.json \
  --binding your-binding-id --repository /absolute/path/exported-agent
```

This prepares source changes for review and commit. It replaces the legacy
repository-controlled deploy/promotion workflows with the pinned delivery caller
and production-review guidance. It does not modify GitHub permissions or approve
a release. Review the generated diff and submit it through the Agent repository's
normal PR/CI workflow.

## Runtime and approval contract

The package job runs repository tests/evaluation and creates one Agent zip.
The publishing job runs on a fresh runner, never executes repository code,
revalidates artifact identity, uploads to versioned S3, and starts one pipeline
execution bound to that S3 version, source commit and artifact SHA-256.

Each environment uses a platform-owned CodeBuild script. It validates artifact
and evaluation digests, ownership and the platform evaluation threshold, deploys
an AWS-IAM-authenticated AgentCore Runtime, waits for READY, verifies that its
DEFAULT endpoint serves the deployed Runtime version, and requires a real
response with model output-token metadata before recording verification evidence.
Guardrail intervention or content filtering fails the probe even when the
service returns readable block text. Model permissions require the
platform Bedrock Guardrail's exact published version; source instructions cannot
remove that IAM ceiling. The `bedrock:GuardrailIdentifier` IAM condition includes
`ARN:version` for published versions; the bare ARN matches DRAFT, not version 1.
See [AWS Guardrail enforcement](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions-id.html).
Memory and metrics resources are scoped to the Agent and environment. The
session manager replaces some stored messages by deleting their previous event,
so Runtime roles include `DeleteEvent` on that environment's Memory only.
Failed synthetic deployment probes are retained in the private encrypted
evidence bucket for diagnosis; they never count as successful verification.
The runtime currently exposes an IAM interface; this stack does not install an
end-user Cognito application or prove per-user runtime isolation.

Governance displays the exact release and verified dev/preprod evidence.
The decision API checks current Cognito membership and active project ownership,
rejects requester self-approval, and compares the submitted identity with the
native pipeline execution. Only the backend receives the native approval token.
Production waits for a real human decision; an automation agent must not submit
one on behalf of a person.

Durable decision intent prevents conflicting decisions. An unconfirmed network
failure can be retried with exactly the same actor, release, reason and decision
while the native approval remains pending. If the native token was consumed but
the response was lost, investigate the native action audit before reconciling
the local intent; do not start another release or invent an approval.

Local tests verify contracts; a successful GitHub submission is not evidence of
successful deployment. Record the actual environment runtime versions, pipeline
execution and human decision before claiming an end-to-end production result.
