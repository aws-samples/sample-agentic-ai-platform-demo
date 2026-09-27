# Explicit physical names: replacement and failed-stack recovery

Applies to explicitly named provider Lambdas and the waiter StateMachine in
`AgenticPlatform-ControlPlane-Provisioned`, using the `acp-cp-prov-` prefix and
hash suffix. Inspect the actual deployed template and current AWS behavior before
recovery. This document is not authorization to delete shared or retained data.

## Replacement risks

A logical-ID change can make CloudFormation create a replacement before deleting
the old resource. With the same explicit physical name, creation collides with
the existing resource. FunctionName, StateMachineName, StateMachineType and other
properties documented as replacement require a reviewed replacement plan.
Runtime/handler changes are not universally replacements: consult current resource
documentation and the change set, especially when refactoring construct identity.

AWS documents the Lambda limitation:

> If you specify a name, you cannot perform updates that require replacement of
> this resource.

[CloudFormation Lambda reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-function.html)

Typical events include UPDATE_FAILED/CREATE_FAILED with an already-existing
Lambda or waiter StateMachine name. The new resource cannot reuse the old name
during create-before-delete, so the stack rolls back.

## Recovery options

### Two-step physical-name change

Use a reviewed temporary unique name, deploy the replacement, then deploy the
intended final name if needed. Confirm the execution role/boundary still permits
the prefix and update dependent bindings. Do not broaden boundaries unnecessarily.
This can preserve availability, but verify actual dependencies and lifecycle;
provider Lambdas must remain callable during stack operations.

### Delete and recreate

Only when the scoped resource or entire stack is explicitly approved for rebuild,
remove the conflicting resource and redeploy. Expect an unavailable interval and
failed provider calls if operations overlap. Back up/review retained data,
ownership and dependencies first; do not use this as the routine update path.

## Failed-stack shells and retained resources

Inspect stack events and failing logical IDs before choosing delete/retain
options. In the recorded recovery, the stack first had to enter DELETE_FAILED
before its failed custom resources could be listed for retention. Do not infer
that every ROLLBACK_FAILED stack rejects delete requests or blindly replay the
historical sequence on another stack.

```bash
# Only for a specifically reviewed and authorized stack deletion.
aws cloudformation delete-stack \
  --stack-name AgenticPlatform-ControlPlane-Provisioned

# Inspect events and actual status; a failed wait is not successful cleanup.
aws cloudformation describe-stack-events \
  --stack-name AgenticPlatform-ControlPlane-Provisioned

# If DELETE_FAILED and retention is appropriate, use the verified logical IDs.
aws cloudformation delete-stack \
  --stack-name AgenticPlatform-ControlPlane-Provisioned \
  --retain-resources <verified-failed-logical-ids>
```

Retained resources survive as separately managed resources. Do not automatically
delete registries, gateways or data simply because the stack no longer owns them.

## Strict Registry record versions

The governance reader validates strict SemVer more narrowly than the Registry
service's permissive version pattern. A direct external write such as `1.0`,
`v2.1.0` or `2026.09` can cause a scoped governance read to fail closed with
REGISTRY_UNAVAILABLE. Investigate the offending record and correct it through an
authorized process. Do not silently relax the established version contract.
The impact can extend beyond that one record to the domain's read operation.

## Authoritative service schema

Use the SDK model actually imported by the code, currently
`@aws-sdk/client-agent-registry-control` with signing name `agent-registry`, for
field names, patterns, limits and enumerations. A botocore
`bedrock-agentcore-control` model is corroborating evidence, not an interchangeable
schema: recordType/descriptorType and displayName differences have been observed.
Consult current SDK/service responses before relying on historical constraints.
