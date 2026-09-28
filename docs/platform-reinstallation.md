# Reinstalling an existing platform

Reinstallation requires owner authorization for the exact account and installation.
It differs from an upgrade. Running the clean-account command over existing stacks
does not reset application data.

## Preparation

Verify STS identity; save actual stack templates, resources, outputs, retention
policies and export consumers. Preserve unrelated applications and CDKToolkit.
Install locked dependencies, synthesize the replacement, and run the
[mandatory security audit](../infra/serverless-platform/README.md#mandatory-pre-deployment-security-audit).
Review the cleanup scope before disabling protection on any exact target stack.

## Delete dependent stacks first

Discover extension dependencies. For the basic installation, delete DomainBootstrap,
then Web, then ControlPlane, waiting for completion between dependent steps.
Do not delete exports still consumed by another application.

Web intentionally retains its Agent Registry descriptor: platform-agent-registry/seed.mjs
returns Retained: true on Delete. ControlPlane deletion can therefore fail with
ConflictException because its Registry still contains records, even after its own
seed records are deleted. For an authorized complete reset, list records in the
exact old stack-owned Registry and verify their tags, names and versions.
The built-in agent_design_assistant descriptor currently has version
1.0.0-platform-descriptor.1. Remove only individually verified records covered by
the cleanup scope, wait for removal, then retry stack deletion. Stop on foreign
or unclassified records; do not change the provider to purge nonempty registries.

## Retained-resource collisions

Web retains the fixed-name AgenticPlatform-Web-RuntimePermissionsBoundary policy.
Follow the [boundary recovery procedure](../infra/serverless-platform/README.md#retained-runtime-boundary-recovery):
verify old stack ownership, mandatory tags and policy document, save that document,
and inspect both permissions-policy and permissions-boundary consumers. Only a
verified unused policy covered by the cleanup scope may be removed for recreation.

The fixed log group /aws/bedrock-agentcore/runtimes/agentic-platform-governed can
also survive deletion. Inspect streams and retention requirements. An empty group
owned by the removed installation may be cleaned up; do not discard historical
log events merely to bypass a name collision.

Retained DynamoDB tables, S3 buckets, Cognito pools, secrets and generated-name
logs can remain as historical resources. The fresh installation creates new
application resources; it does not restore old data or users automatically.
Record retained physical IDs in private deployment evidence.

Transaction Search is a regional trace-ingestion setting and its access policy
is retained. Preserve it when other applications use it. Runtime trace delivery
destinations include the stack incarnation in their name, so a new installation
can use its own destination without deleting an old destination still referenced
by a separate application's delivery. Inspect live delivery sources before
removing any destination.

## Reinstall and verify

After deletion and reviewed collision cleanup, follow the root
[clean-account instructions](../README.md#deploy-to-a-clean-aws-account) with a
unique Cognito prefix. The command deploys ControlPlane, Web and DomainBootstrap
using newly discovered bindings. Run the strict postdeployment audit and verify
actual routes, baseline domains/projects/model policies, authentication and Builder
Generate/export. First-administrator setup and GitHub authorization are separate
configuration steps. CloudFormation completion alone does not prove these
journeys or the Agent production pipeline work.
