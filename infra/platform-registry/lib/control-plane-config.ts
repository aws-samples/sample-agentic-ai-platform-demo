import { createHash } from "crypto";

export type ControlPlaneMode = "reference-existing" | "provision";
export type AwsPartition = "aws" | "aws-cn" | "aws-us-gov";
export const CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME =
  "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary";

export const CONTROL_PLANE_DOMAIN_KEYS = [
  "platform",
  "customer_support",
  "operations",
] as const;

export type ControlPlaneDomainKey =
  (typeof CONTROL_PLANE_DOMAIN_KEYS)[number];

export interface ExistingControlPlaneIds {
  sharedRegistryId: string;
  domainRegistryIds: Record<ControlPlaneDomainKey, string>;
  llmGatewayId: string;
  llmGatewayRegion: string;
  toolsGatewayId: string;
}

interface ControlPlaneConfigInputBase {
  account: string;
  region: string;
  partition?: AwsPartition;
}

export interface ReferenceExistingControlPlaneConfigInput
  extends ControlPlaneConfigInputBase,
    ExistingControlPlaneIds {
  mode: "reference-existing";
  runtimePermissionsBoundaryArn?: never;
}

export interface ProvisionControlPlaneConfigInput
  extends ControlPlaneConfigInputBase {
  mode: "provision";
  runtimePermissionsBoundaryArn?: never;
  sharedRegistryId?: never;
  domainRegistryIds?: never;
  llmGatewayId?: never;
  llmGatewayRegion?: never;
  toolsGatewayId?: never;
  llmGatewayName?: string;
  toolsGatewayName?: string;
}

export type ControlPlaneConfigInput =
  | ReferenceExistingControlPlaneConfigInput
  | ProvisionControlPlaneConfigInput;

export interface ArnScope {
  partition: AwsPartition;
  account: string;
  region: string;
}

export interface ProvisionControlPlaneConfig extends ArnScope {
  mode: "provision";
  llmGatewayName: string;
  toolsGatewayName: string;
}

export interface ReferenceExistingControlPlaneConfig
  extends ArnScope,
    ExistingControlPlaneIds {
  mode: "reference-existing";
  sharedRegistryArn: string;
  domainRegistryArns: Record<ControlPlaneDomainKey, string>;
  llmGatewayName: string;
  llmGatewayArn: string;
  llmGatewayUrl: string;
  toolsGatewayName: string;
  toolsGatewayArn: string;
  toolsGatewayUrl: string;
}

export type ResolvedControlPlaneConfig =
  | ProvisionControlPlaneConfig
  | ReferenceExistingControlPlaneConfig;

export interface ControlPlaneContextInput {
  mode?: string;
  account: string;
  region: string;
  partition?: AwsPartition;
  sharedRegistryId?: string;
  registryPlatformId?: string;
  registryCustomerSupportId?: string;
  registryOperationsId?: string;
  llmGatewayId?: string;
  llmGatewayRegion?: string;
  toolsGatewayId?: string;
  llmGatewayName?: string;
  toolsGatewayName?: string;
  runtimePermissionsBoundaryArn?: string;
}

const ACCOUNT_PATTERN = /^\d{12}$/;
const SUPPORTED_REGION = "us-west-2";
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9]{12,16}$/;
const GATEWAY_ID_PATTERN =
  /^([a-z0-9]+(?:-[a-z0-9]+)*)-([a-z0-9]{10})$/;
const GATEWAY_PREFIX_MAX_LENGTH = 100;

/**
 * Base names for the gateways this stack provisions. These are prefixes only:
 * the deployed name always carries a deployment-scoped suffix so that two
 * different accounts (or regions) never collide in the AgentCore Gateway
 * namespace, which is account+region global and rejects duplicates with a 409
 * AlreadyExists error.
 */
export const GATEWAY_BASE_NAMES = {
  llm: "agentic-demo-llm-gateway",
  tools: "platform-tools-gw",
} as const;

export type GatewayKey = keyof typeof GATEWAY_BASE_NAMES;

/**
 * AgentCore appends "-<10 chars>" to the requested name to form the gateway
 * identifier, and the identifier prefix may not exceed 100 characters, so the
 * requested name is bound by the same limit.
 */
export const GATEWAY_NAME_MAX_LENGTH = GATEWAY_PREFIX_MAX_LENGTH;
export const DEPLOYMENT_NAME_SUFFIX_LENGTH = 8;
const GATEWAY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Short explicit prefix for provisioned control-plane runtime resources
 * (Lambda functions and the provider waiter state machine).
 *
 * The permissions boundary matches these resources by name prefix, so the
 * prefix must survive verbatim into the physical name. CloudFormation-derived
 * names cannot guarantee that: CFN truncates the stack-name portion of a
 * generated Lambda name (observed at 25 characters for this stack), and the
 * provider waiter state machine gets no stack-name prefix at all, so a
 * boundary wildcard built from the 40-character stack name never matches
 * either of them and every provider invocation fails with a 403.
 */
export const PROVISIONED_RESOURCE_NAME_PREFIX = "acp-cp-prov";

/*
 * Lambda FunctionName constraints — sources:
 * - Length (preferred source, bare-name wording, no ARN ambiguity):
 *   "The name of the Lambda function, up to 64 characters in length. If you
 *   don't specify a name, CloudFormation generates one. If you specify a
 *   name, you cannot perform updates that require replacement of this
 *   resource. ... Update requires: Replacement"
 *   https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-function.html
 *   (FunctionName entry; the older /UserGuide/ path 301-redirects here)
 * - Length (API doc): "If you specify only the function name, it is limited to 64
 *   characters in length."
 *   https://docs.aws.amazon.com/lambda/latest/api/API_CreateFunction.html
 *   (FunctionName parameter) — NOTE: the "Maximum length of 140" figure on that
 *   same page is the constraint on the field as a whole because it also accepts
 *   the full ARN form; it is NOT the bare-name limit. 64 is the bare-name limit.
 * - Charset: the name segment of the FunctionName request pattern at the same
 *   URL is ([a-zA-Z0-9-_]+); the pattern below is the same charset written
 *   with the hyphen last for readability.
 * - aws-cdk-lib enforces the identical pair at synth time:
 *   node_modules/aws-cdk-lib/aws-lambda/lib/function.js, line 1 (the file
 *   ships minified on a single line) — search anchors "FunctionNameTooLong"
 *   (length > 64) and "InvalidFunctionNameFormat" (/^[a-zA-Z0-9-_]+$/).
 */
export const PROVISIONED_LAMBDA_NAME_MAX_LENGTH = 64;
export const PROVISIONED_LAMBDA_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/*
 * Step Functions StateMachineName constraints — sources:
 * - Length: 1 to 80 characters.
 *   https://docs.aws.amazon.com/step-functions/latest/apireference/API_CreateStateMachine.html
 *   (name parameter)
 * - Charset: the official constraint at the same URL is a BLACKLIST, not a
 *   whitelist — a name must NOT contain white space, wildcard characters
 *   (? *), bracket characters (< > { } [ ]), the special characters
 *   " # % \ ^ | ~ ` $ & , ; : /, or control characters
 *   (U+0000-001F, U+007F-009F, U+FFFE-FFFF) and surrogate code points
 *   (U+D800-DFFF).
 * - The pattern below is a TIGHTENED WHITELIST of that blacklist: it accepts
 *   only [a-zA-Z0-9_-], every character of which the official blacklist
 *   permits. Tightening rationale: provisioned names are machine-derived
 *   ("acp-cp-prov-<role>-<hex>") and never need the exotic-but-legal
 *   characters (+ ! @ . ( ) = '), and a closed whitelist keeps the name safe
 *   to embed verbatim in IAM Resource ARN patterns and shell/log contexts
 *   without escaping.
 * - aws-cdk-lib applies its own, wider whitelist /^[a-z0-9+!@.()-=_']+$/i at
 *   synth time: node_modules/aws-cdk-lib/aws-stepfunctions/lib/state-machine.js,
 *   line 1 (minified single-line file) — search anchors
 *   "InvalidStateMachineNameLength" and "InvalidStateMachineNamePattern".
 *   Our pattern is a strict subset of CDK's, so the two checks always agree.
 */
export const PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH = 80;
export const PROVISIONED_STATE_MACHINE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/*
 * Boundary name-prefix constraints — source:
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_resource.html
 * IAM treats "*" and "?" inside a Resource ARN as wildcards, so the literal
 * prefix that the runtime permissions boundary matches on
 * ("...function:<prefix>-*" / "...stateMachine:<prefix>-*") must not itself
 * contain either wildcard or the policy would over-match. The pattern below
 * (lowercase alphanumeric segments joined by single hyphens) structurally
 * excludes both wildcards and is a subset of the Lambda and Step Functions
 * name charsets above, so the prefix survives verbatim into every physical
 * name the boundary must match.
 */
export const PROVISIONED_NAME_PREFIX_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PROVISIONED_ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Deterministic per-deployment suffix derived from account + region.
 *
 * Determinism is a hard requirement, not a preference: a random or
 * time-derived suffix would change the resource name on every synth, turning
 * every update into a replacement and leaving orphaned gateways behind on
 * destroy. Both inputs are validated concrete values (the account is checked
 * against /^\d{12}$/ before it reaches here), never CloudFormation tokens, so
 * the hash is resolved at synth time and appears in the template as a literal.
 */
export function deploymentNameSuffix(scope: {
  account: string;
  region: string;
}): string {
  validateAccount(scope.account);
  validateAwsRegion(scope.region);
  return createHash("sha256")
    .update(`${scope.account}:${scope.region}`)
    .digest("hex")
    .slice(0, DEPLOYMENT_NAME_SUFFIX_LENGTH);
}

/**
 * Resolve the gateway name to request from AgentCore. Defaults to a unique
 * deployment-scoped name; an explicit override is honoured for callers that
 * must pin a name (for example to adopt a gateway created out of band).
 */
export function deriveGatewayName(
  key: GatewayKey,
  scope: { account: string; region: string },
  override?: string,
): string {
  if (override !== undefined) {
    validateGatewayName(override, `${key}GatewayName`);
    return override;
  }
  const name = `${GATEWAY_BASE_NAMES[key]}-${deploymentNameSuffix(scope)}`;
  validateGatewayName(name, `${key}GatewayName`);
  return name;
}

function validateGatewayName(name: string, field: string): void {
  if (typeof name !== "string" || !GATEWAY_NAME_PATTERN.test(name)) {
    throw new Error(
      `${field} must be lowercase alphanumeric segments separated by hyphens`,
    );
  }
  if (name.length > GATEWAY_NAME_MAX_LENGTH) {
    throw new Error(
      `${field} must be at most ${GATEWAY_NAME_MAX_LENGTH} characters`,
    );
  }
}

/**
 * Validate a Lambda FunctionName against the service constraints documented
 * above PROVISIONED_LAMBDA_NAME_MAX_LENGTH / PROVISIONED_LAMBDA_NAME_PATTERN.
 */
export function validateProvisionedLambdaName(name: string): void {
  if (
    typeof name !== "string"
    || !PROVISIONED_LAMBDA_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      `Lambda function name "${name}" must match ${PROVISIONED_LAMBDA_NAME_PATTERN}`,
    );
  }
  if (name.length > PROVISIONED_LAMBDA_NAME_MAX_LENGTH) {
    throw new Error(
      `Lambda function name "${name}" must be at most ${PROVISIONED_LAMBDA_NAME_MAX_LENGTH} characters`,
    );
  }
}

/**
 * Validate a Step Functions StateMachineName against the service constraints
 * documented above PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH /
 * PROVISIONED_STATE_MACHINE_NAME_PATTERN (a tightened whitelist of the
 * official blacklist-style restriction).
 */
export function validateProvisionedStateMachineName(name: string): void {
  if (
    typeof name !== "string"
    || !PROVISIONED_STATE_MACHINE_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      `State machine name "${name}" must match ${PROVISIONED_STATE_MACHINE_NAME_PATTERN}`,
    );
  }
  if (name.length > PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH) {
    throw new Error(
      `State machine name "${name}" must be at most ${PROVISIONED_STATE_MACHINE_NAME_MAX_LENGTH} characters`,
    );
  }
}

/**
 * Validate the boundary name prefix against the IAM wildcard constraints
 * documented above PROVISIONED_NAME_PREFIX_PATTERN.
 */
export function validateProvisionedNamePrefix(prefix: string): void {
  if (
    typeof prefix !== "string"
    || !PROVISIONED_NAME_PREFIX_PATTERN.test(prefix)
  ) {
    throw new Error(
      `provisioned name prefix "${prefix}" must be lowercase alphanumeric segments separated by hyphens`,
    );
  }
}

/**
 * Build the explicit physical name of a provisioned control-plane runtime
 * resource: "acp-cp-prov-<role>-<8 hex chars>". The suffix is the same
 * deterministic account+region hash used for gateway names (the single
 * deploymentNameSuffix implementation), so the name is stable across synths
 * and unique per deployment target.
 */
function buildProvisionedName(
  scope: { account: string; region: string },
  role: string,
): string {
  validateProvisionedNamePrefix(PROVISIONED_RESOURCE_NAME_PREFIX);
  if (typeof role !== "string" || !PROVISIONED_ROLE_PATTERN.test(role)) {
    throw new Error(
      `provisioned resource role "${role}" must be lowercase alphanumeric segments separated by hyphens`,
    );
  }
  return `${PROVISIONED_RESOURCE_NAME_PREFIX}-${role}-${deploymentNameSuffix(scope)}`;
}

export function provisionedLambdaName(
  scope: { account: string; region: string },
  role: string,
): string {
  const name = buildProvisionedName(scope, role);
  validateProvisionedLambdaName(name);
  return name;
}

export function provisionedStateMachineName(
  scope: { account: string; region: string },
  role: string,
): string {
  const name = buildProvisionedName(scope, role);
  validateProvisionedStateMachineName(name);
  return name;
}

/**
 * Recover the gateway name from an existing gateway identifier. AgentCore
 * identifiers are "<name>-<10 chars>", so the prefix is the real name of a
 * referenced gateway -- more accurate than assuming a hardcoded default.
 */
export function gatewayNameFromId(gatewayId: string): string {
  const match = GATEWAY_ID_PATTERN.exec(gatewayId);
  if (match === null) {
    throw new Error(
      "gatewayId must be an AgentCore Gateway ID of the form <name>-<10 chars>",
    );
  }
  return match[1];
}
const EXISTING_CONTROL_PLANE_ID_FIELDS = [
  "sharedRegistryId",
  "domainRegistryIds",
  "llmGatewayId",
  "llmGatewayRegion",
  "toolsGatewayId",
] as const;
const EXISTING_CONTROL_PLANE_CONTEXT_FIELDS = [
  "sharedRegistryId",
  "registryPlatformId",
  "registryCustomerSupportId",
  "registryOperationsId",
  "llmGatewayId",
  "llmGatewayRegion",
  "toolsGatewayId",
] as const;

function validateAccount(account: string): void {
  if (typeof account !== "string" || !ACCOUNT_PATTERN.test(account)) {
    throw new Error("account must be a 12-digit AWS account ID");
  }
}

function validateAwsRegion(region: string): void {
  if (
    typeof region !== "string"
    || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region)
  ) {
    throw new Error("region must be a valid AWS region");
  }
}

function validateRegion(region: string): void {
  if (region !== SUPPORTED_REGION) {
    throw new Error(
      `region must be ${SUPPORTED_REGION} for this implementation`,
    );
  }
}

function partitionForRegion(region: string): AwsPartition {
  if (region.startsWith("cn-")) {
    return "aws-cn";
  }
  if (region.startsWith("us-gov-")) {
    return "aws-us-gov";
  }
  return "aws";
}

function resolvePartition(
  region: string,
  partition?: AwsPartition,
): AwsPartition {
  const expected = partitionForRegion(region);
  if (partition !== undefined && partition !== expected) {
    throw new Error(`partition ${partition} does not match region ${region}`);
  }
  return partition ?? expected;
}

function validateScope(scope: ArnScope): void {
  validateAccount(scope.account);
  validateAwsRegion(scope.region);
  resolvePartition(scope.region, scope.partition);
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required in reference-existing mode`);
  }
  return value;
}

function validateRegistryId(registryId: string, field: string): void {
  if (!REGISTRY_ID_PATTERN.test(registryId)) {
    throw new Error(
      `${field} must be a 12 to 16 character Agent Registry ID containing only letters and digits`,
    );
  }
}

function validateGatewayId(gatewayId: string, field: string): void {
  const match = GATEWAY_ID_PATTERN.exec(gatewayId);
  if (
    match === null
    || match[1].length > GATEWAY_PREFIX_MAX_LENGTH
  ) {
    throw new Error(
      `${field} must be an AgentCore Gateway ID with a lowercase prefix of at most 100 characters and 10-character suffix`,
    );
  }
}

function validateProvisionInput(
  input: ProvisionControlPlaneConfigInput,
): void {
  const runtimeInput = input as unknown as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(
      runtimeInput,
      "runtimePermissionsBoundaryArn",
    )
  ) {
    throw new Error(
      "runtimePermissionsBoundaryArn is not allowed in provision mode",
    );
  }
  for (const field of EXISTING_CONTROL_PLANE_ID_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(runtimeInput, field)) {
      throw new Error(`${field} is not allowed in provision mode`);
    }
  }
}

function validateReferenceInput(
  input: ReferenceExistingControlPlaneConfigInput,
): void {
  if (
    Object.prototype.hasOwnProperty.call(
      input,
      "runtimePermissionsBoundaryArn",
    )
  ) {
    throw new Error(
      "runtimePermissionsBoundaryArn is not allowed in reference-existing mode",
    );
  }
}

function validateDomainRegistryIds(
  value: unknown,
): Record<ControlPlaneDomainKey, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "domainRegistryIds is required in reference-existing mode",
    );
  }

  const input = value as Record<string, unknown>;
  const unknownKey = Object.keys(input).find(
    (key) =>
      !CONTROL_PLANE_DOMAIN_KEYS.includes(key as ControlPlaneDomainKey),
  );
  if (unknownKey !== undefined) {
    throw new Error(`Unknown domain registry key: ${unknownKey}`);
  }

  const result = {} as Record<ControlPlaneDomainKey, string>;
  for (const domain of CONTROL_PLANE_DOMAIN_KEYS) {
    const field = `domainRegistryIds.${domain}`;
    const registryId = requiredId(input[domain], field);
    validateRegistryId(registryId, field);
    result[domain] = registryId;
  }
  return result;
}

export function buildRegistryArn(
  scope: ArnScope,
  registryId: string,
): string {
  validateScope(scope);
  validateRegistryId(registryId, "registryId");
  return `arn:${scope.partition}:agent-registry:${scope.region}:${scope.account}:registry/${registryId}`;
}

export function buildGatewayArn(
  scope: ArnScope,
  gatewayId: string,
): string {
  validateScope(scope);
  validateGatewayId(gatewayId, "gatewayId");
  return `arn:${scope.partition}:bedrock-agentcore:${scope.region}:${scope.account}:gateway/${gatewayId}`;
}

function buildGatewayUrl(
  region: string,
  gatewayId: string,
  path: "inference/v1" | "mcp",
): string {
  validateAwsRegion(region);
  validateGatewayId(gatewayId, "gatewayId");
  const dnsSuffix = region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  return `https://${gatewayId}.gateway.bedrock-agentcore.${region}.${dnsSuffix}/${path}`;
}

export function buildGatewayInferenceUrl(
  region: string,
  gatewayId: string,
): string {
  return buildGatewayUrl(region, gatewayId, "inference/v1");
}

export function buildGatewayMcpUrl(
  region: string,
  gatewayId: string,
): string {
  return buildGatewayUrl(region, gatewayId, "mcp");
}

export function resolveControlPlaneConfig(
  input: ControlPlaneConfigInput,
): ResolvedControlPlaneConfig {
  if (
    input.mode !== "reference-existing"
    && input.mode !== "provision"
  ) {
    throw new Error(
      "mode must be either reference-existing or provision",
    );
  }

  validateAccount(input.account);
  validateRegion(input.region);
  const partition = resolvePartition(input.region, input.partition);
  const scope = {
    account: input.account,
    region: input.region,
    partition,
  };

  if (input.mode === "provision") {
    validateProvisionInput(input);
    return {
      mode: input.mode,
      ...scope,
      llmGatewayName: deriveGatewayName("llm", scope, input.llmGatewayName),
      toolsGatewayName: deriveGatewayName(
        "tools",
        scope,
        input.toolsGatewayName,
      ),
    };
  }

  validateReferenceInput(input);
  const sharedRegistryId = requiredId(
    input.sharedRegistryId,
    "sharedRegistryId",
  );
  validateRegistryId(sharedRegistryId, "sharedRegistryId");
  const domainRegistryIds = validateDomainRegistryIds(
    input.domainRegistryIds,
  );
  const llmGatewayId = requiredId(input.llmGatewayId, "llmGatewayId");
  validateGatewayId(llmGatewayId, "llmGatewayId");
  const llmGatewayRegion = requiredId(
    input.llmGatewayRegion,
    "llmGatewayRegion",
  );
  validateAwsRegion(llmGatewayRegion);
  const toolsGatewayId = requiredId(
    input.toolsGatewayId,
    "toolsGatewayId",
  );
  validateGatewayId(toolsGatewayId, "toolsGatewayId");

  return {
    mode: input.mode,
    ...scope,
    sharedRegistryId,
    sharedRegistryArn: buildRegistryArn(scope, sharedRegistryId),
    domainRegistryIds,
    domainRegistryArns: {
      platform: buildRegistryArn(scope, domainRegistryIds.platform),
      customer_support: buildRegistryArn(
        scope,
        domainRegistryIds.customer_support,
      ),
      operations: buildRegistryArn(scope, domainRegistryIds.operations),
    },
    llmGatewayId,
    llmGatewayRegion,
    llmGatewayName: gatewayNameFromId(llmGatewayId),
    llmGatewayArn: buildGatewayArn(
      {
        ...scope,
        region: llmGatewayRegion,
        partition: resolvePartition(llmGatewayRegion, input.partition),
      },
      llmGatewayId,
    ),
    llmGatewayUrl: buildGatewayInferenceUrl(
      llmGatewayRegion,
      llmGatewayId,
    ),
    toolsGatewayId,
    toolsGatewayName: gatewayNameFromId(toolsGatewayId),
    toolsGatewayArn: buildGatewayArn(scope, toolsGatewayId),
    toolsGatewayUrl: buildGatewayMcpUrl(input.region, toolsGatewayId),
  };
}

export function resolveControlPlaneContext(
  input: ControlPlaneContextInput,
): ResolvedControlPlaneConfig {
  if (input.mode === "provision") {
    if (input.runtimePermissionsBoundaryArn !== undefined) {
      throw new Error(
        "runtimePermissionsBoundaryArn is not allowed in provision mode",
      );
    }
    for (const field of EXISTING_CONTROL_PLANE_CONTEXT_FIELDS) {
      if (input[field] !== undefined) {
        throw new Error(`${field} is not allowed in provision mode`);
      }
    }
    return resolveControlPlaneConfig({
      mode: input.mode,
      account: input.account,
      region: input.region,
      partition: input.partition,
      llmGatewayName: input.llmGatewayName,
      toolsGatewayName: input.toolsGatewayName,
    });
  }

  if (input.mode === "reference-existing") {
    if (input.runtimePermissionsBoundaryArn !== undefined) {
      throw new Error(
        "runtimePermissionsBoundaryArn is not allowed in "
          + "reference-existing mode",
      );
    }
    return resolveControlPlaneConfig({
      mode: input.mode,
      account: input.account,
      region: input.region,
      partition: input.partition,
      sharedRegistryId: input.sharedRegistryId ?? "",
      domainRegistryIds: {
        platform: input.registryPlatformId ?? "",
        customer_support: input.registryCustomerSupportId ?? "",
        operations: input.registryOperationsId ?? "",
      },
      llmGatewayId: input.llmGatewayId ?? "",
      llmGatewayRegion: input.llmGatewayRegion ?? "",
      toolsGatewayId: input.toolsGatewayId ?? "",
    });
  }

  throw new Error("mode must be either reference-existing or provision");
}
