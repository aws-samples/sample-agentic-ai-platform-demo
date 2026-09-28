#!/usr/bin/env node

import { inspectSynthesizedIam } from './synthesized-iam-audit.mjs';

import { execFileSync as nodeExecFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_REGION = "us-west-2";
const REQUIRED_PARTITION = "aws";
const CDK_BOOTSTRAP_QUALIFIER = "hnb659fds";
const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";
const BOOTSTRAP_PARAMETER = "/cdk-bootstrap/hnb659fds/version";
const MINIMUM_BOOTSTRAP_VERSION = 6;
const RUNTIME_PERMISSIONS_BOUNDARY_NAME =
  "AgenticPlatform-Web-RuntimePermissionsBoundary";
const CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME =
  "AgenticPlatform-ControlPlane-RuntimePermissionsBoundary";
const CLOUDFORMATION_EXECUTION_ROLE_NAME =
  "AgenticPlatformCloudFormationExecutionRole";
const CONTROL_PLANE_ROLE_PREFIX =
  "AgenticPlatform-ControlPlane-Provisioned-";
const PROVISIONED_CONTROL_PLANE_ROLE_EXPECTATIONS = [
  {
    logicalIdPattern: /^RegistryOnEventHandlerServiceRole[A-F0-9]+$/,
    service: "lambda.amazonaws.com",
  },
  {
    logicalIdPattern: /^RegistryIsCompleteHandlerServiceRole[A-F0-9]+$/,
    service: "lambda.amazonaws.com",
  },
  {
    logicalIdPattern:
      /^RegistryProviderframeworkonEventServiceRole[A-F0-9]+$/,
    service: "lambda.amazonaws.com",
  },
  {
    logicalIdPattern:
      /^RegistryProviderframeworkisCompleteServiceRole[A-F0-9]+$/,
    service: "lambda.amazonaws.com",
  },
  {
    logicalIdPattern:
      /^RegistryProviderframeworkonTimeoutServiceRole[A-F0-9]+$/,
    service: "lambda.amazonaws.com",
  },
  {
    logicalIdPattern:
      /^RegistryProviderwaiterstatemachineRole[A-F0-9]+$/,
    service: "states.amazonaws.com",
  },
  {
    logicalIdPattern: /^LlmGatewayRole[A-F0-9]+$/,
    service: "bedrock-agentcore.amazonaws.com",
  },
  {
    logicalIdPattern: /^ToolsGatewayRole[A-F0-9]+$/,
    service: "bedrock-agentcore.amazonaws.com",
  },
];
const CONTROL_PLANE_EXECUTION_POLICY_NAMES = [
  "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleManagement",
  "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleDelegation",
  "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleBoundary",
  "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment",
  "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment",
  "AgenticPlatform-GitHubBootstrap-ControlPlaneGatewayDeployment",
  "AgenticPlatform-GitHubBootstrap-AgentRuntimeDeployment",
  "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment",
];
const CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME =
  "CloudFormationExecutionRoleDefaultPolicy5CFF329B";
const CONTROL_PLANE_EXECUTION_INLINE_POLICY_HASH =
  "89c08ba5c75a7c070cf16bee8c1d32e79d6b0147153f5e210468527ce7e28252";
const CONTROL_PLANE_EXECUTION_MANAGED_POLICY_HASHES = new Map([
  [
    "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleManagement",
    "3200b4bd9f25d9ef919c6995a05490da4358639c7693a954d3624efcef1b26a9",
  ],
  [
    "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleDelegation",
    "8912bc8e0f0b2d7fb63d1dec5a96363ff876a665e0b2734c5e2f03a5309633ff",
  ],
  [
    "AgenticPlatform-GitHubBootstrap-Stage1RuntimeRoleBoundary",
    "89e3a789b230a47460f089bbb7b2b0bf17644fef046e939883299aa8d4e277ab",
  ],
  [
    "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment",
    "788b00c48e44abc447f2dbaaa8b4142fb562472fac697a3807ad09e3741f107f",
  ],
  [
    "AgenticPlatform-GitHubBootstrap-ControlPlaneRegistryDeployment",
    "ee6f0d3c2bbce82f168fa37badba55a1c5c3fd753db74be21ef730979c93a9df",
  ],
  [
    "AgenticPlatform-GitHubBootstrap-ControlPlaneGatewayDeployment",
    "b94226ba27a888edaa278e4a7d1925290253a2e13256ea960d843a8533613ac5",
  ],
  [
    "AgenticPlatform-GitHubBootstrap-AgentRuntimeDeployment",
    "4030dd6a5e13f37791e03ae57da4ec236fe0e848d41c10889cfa69fbd3e58f21",
  ],
  [
    "AgenticPlatform-GitHubBootstrap-AgentRuntimeObservabilityDeployment",
    "44168f34b9ebc046f7779f41f87a0cf20d7047704f918af5f8a251421a6840ab",
  ],
]);
const CONTROL_PLANE_DEPLOYMENT_POLICY_NAME =
  "AgenticPlatform-GitHubBootstrap-ControlPlaneDeployment";
const IDENTITY_ROLE_NAME =
  "AgenticPlatform-Web-IdentityApiRole";
const IDENTITY_POLICY_NAME = "IdentityApiLogging";
const IDENTITY_XRAY_POLICY_NAME =
  "IdentityApiRoleDefaultPolicyCE354674";
const GOVERNANCE_ROLE_NAME =
  "AgenticPlatform-Web-GovernanceApiRole";
const GOVERNANCE_POLICY_NAME = "GovernanceApi";
const GOVERNANCE_XRAY_POLICY_NAME =
  "GovernanceApiRoleDefaultPolicyB72CE6D3";
const AGENT_RUNTIME_ROLE_NAME =
  "AgenticPlatform-Web-AgentRuntimeRole";
const AGENT_RUNTIME_POLICY_NAME =
  "AgentRuntimeRoleDefaultPolicy28A421B5";
const BUILDER_ROLE_NAME = "AgenticPlatform-Web-BuilderApiRole";
const JOURNEY_ROLE_NAME = "AgenticPlatform-Web-JourneyApiRole";
const JOURNEY_POLICY_NAME = "JourneyApi";
const JOURNEY_DEFAULT_POLICY_NAME =
  "JourneyApiRoleDefaultPolicy21E813B6";
const BUILDER_POLICY_NAME = "BuilderApi";
const BUILDER_XRAY_POLICY_NAME =
  "BuilderApiRoleDefaultPolicy6FDD69BE";
const EXPERIENCE_ROLE_NAME =
  "AgenticPlatform-Web-ExperienceApiRole";
const EXPERIENCE_POLICY_NAME = "ExperienceApi";
const EXPERIENCE_XRAY_POLICY_NAME =
  "ExperienceApiRoleDefaultPolicyBF321106";
const GATEWAY_INVOKER_ROLE_NAME =
  "AgenticPlatform-Web-GatewayInvokerRole";
const GATEWAY_INVOKER_POLICY_NAME = "InvokeGovernedGateway";
const MODEL_GOVERNANCE_ROLE_NAME =
  "AgenticPlatform-Web-ModelGovernanceApiRole";
const MODEL_GOVERNANCE_POLICY_NAME = "ModelGovernanceApi";
const MODEL_GOVERNANCE_XRAY_POLICY_NAME =
  "ModelGovernanceApiRoleDefaultPolicy716A6728";
const WORKSPACE_ROLE_NAME =
  "AgenticPlatform-Web-WorkspaceApiRole";
const WORKSPACE_POLICY_NAME = "WorkspaceApi";
const WORKSPACE_XRAY_POLICY_NAME =
  "WorkspaceApiRoleDefaultPolicy2220EEC9";
const ACCESS_ADMIN_ROLE_NAME =
  "AgenticPlatform-Web-AccessAdminApiRole";
const ACCESS_ADMIN_POLICY_NAME = "AccessAdminApi";
const ACCESS_ADMIN_XRAY_POLICY_NAME =
  "AccessAdminApiRoleDefaultPolicyDD0CBA0A";
const PLATFORM_ADMIN_ROLE_NAME =
  "AgenticPlatform-Web-PlatformAdminApiRole";
const PLATFORM_ADMIN_POLICY_NAME = "PlatformStateAccess";
const PLATFORM_ADMIN_DOMAIN_GROUP_ACTIONS = [
  "cognito-idp:CreateGroup",
  "cognito-idp:DeleteGroup",
  "cognito-idp:GetGroup",
  "cognito-idp:ListUsersInGroup",
];
const CONTROL_PLANE_READ_ROLE_NAME =
  "AgenticPlatform-Web-ControlPlaneReadApiRole";
const CONTROL_PLANE_READ_POLICY_NAME = "ControlPlaneReadApi";
const CONTROL_PLANE_READ_XRAY_POLICY_NAME =
  "ControlPlaneReadApiRoleDefaultPolicyB50CA712";
const PLATFORM_STATE_SEED_ROLE_NAME =
  "AgenticPlatform-Web-PlatformStateSeedRole";
const PLATFORM_STATE_SEED_POLICY_NAME = "PlatformStateSeed";
const PLATFORM_AGENT_REGISTRY_SEED_ROLE_NAME =
  "AgenticPlatform-Web-PlatformAgentRegistrySeedRole";
const PLATFORM_WORKSPACE_SEED_ROLE_NAME =
  "AgenticPlatform-Web-PlatformWorkspaceSeedRole";
const PLATFORM_WORKSPACE_SEED_POLICY_NAME = "PlatformWorkspaceSeed";
const REGISTRY_DECISION_FINALIZER_ROLE_NAME =
  "AgenticPlatform-Web-RegistryDecisionFinalizerRole";
const REGISTRY_DECISION_FINALIZER_POLICY_NAME =
  "RegistryDecisionFinalization";
const REGISTRY_DECISION_FINALIZER_FUNCTION_NAME =
  "AgenticPlatform-Web-RegistryDecisionFinalizer";
const RUNTIME_PROOF_CONFIGURATOR_FUNCTION_NAME =
  "AgenticPlatform-Web-RuntimeProofConfigurator";
const RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME =
  "AgenticPlatform-Web-RuntimeProofConfiguratorRole";
const RUNTIME_PROOF_CONFIGURATOR_POLICY_NAME =
  "RuntimeProofConfiguration";
const RUNTIME_PROOF_PROVIDER_ROLE_NAME =
  "AgenticPlatform-Web-RuntimeProofProviderRole";
const RUNTIME_PROOF_PROVIDER_LOG_POLICY_NAME =
  "RuntimeProofProviderLogs";
const RUNTIME_PROOF_PROVIDER_DEFAULT_POLICY_NAME =
  "RuntimeProofProviderRoleDefaultPolicy5A650FD2";
const HOSTED_ACCEPTANCE_BROKER_ROLE_NAME =
  "AgenticPlatform-Web-HostedAcceptanceBrokerRole";
const HOSTED_ACCEPTANCE_BROKER_POLICY_NAME =
  "HostedAcceptanceBroker";
const HOSTED_ACCEPTANCE_BROKER_DOMAIN_GROUP_ACTIONS = [
  "cognito-idp:DeleteGroup",
  "cognito-idp:GetGroup",
  "cognito-idp:ListUsersInGroup",
];
const HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME =
  "AgenticPlatform-Web-HostedAcceptanceBroker";
const HOSTED_ACCEPTANCE_ROLE_NAME =
  "AgenticPlatform-Web-HostedAcceptanceRole";
const HOSTED_ACCEPTANCE_POLICY_NAME = "HostedAcceptance";
const GITHUB_DEPLOY_ROLE_NAME = "AgenticPlatformGitHubDeployRole";
const PLATFORM_STATE_TTL_ATTRIBUTE = "expiresAt";
const REQUIRED_TAGS = new Map([
  ["auto-delete", "no"],
  ["managedBy", "cdk"],
  ["project", "agentic-ai-platform-demo"],
]);
const PLATFORM_WEB_STACK_NAME = "AgenticPlatform-Web";
const CONTROL_PLANE_STACK_NAMES = new Map([
  ["reference-existing", "AgenticPlatform-ControlPlane"],
  ["provision", "AgenticPlatform-ControlPlane-Provisioned"],
]);
const CONTROL_PLANE_OUTPUT_CONTRACT = [
  {
    environmentName: "CONTROL_PLANE_SHARED_REGISTRY_ID",
    exportName: "AgenticPlatform-ControlPlane-SharedRegistryId",
    kind: "registry",
    outputKey: "SharedRegistryId",
    property: "sharedRegistryId",
  },
  {
    environmentName: "CONTROL_PLANE_REGISTRY_PLATFORM_ID",
    exportName: "AgenticPlatform-ControlPlane-Registry-platform-Id",
    kind: "registry",
    outputKey: "RegistryPlatformId",
    property: "registryPlatformId",
  },
  {
    environmentName: "CONTROL_PLANE_REGISTRY_CUSTOMER_SUPPORT_ID",
    exportName:
      "AgenticPlatform-ControlPlane-Registry-customer-support-Id",
    kind: "registry",
    outputKey: "RegistryCustomerSupportId",
    property: "registryCustomerSupportId",
  },
  {
    environmentName: "CONTROL_PLANE_REGISTRY_OPERATIONS_ID",
    exportName: "AgenticPlatform-ControlPlane-Registry-operations-Id",
    kind: "registry",
    outputKey: "RegistryOperationsId",
    property: "registryOperationsId",
  },
  {
    environmentName: "CONTROL_PLANE_LLM_GATEWAY_ID",
    exportName: "AgenticPlatform-ControlPlane-LlmGatewayId",
    kind: "gateway",
    outputKey: "LlmGatewayId",
    property: "llmGatewayId",
  },
  {
    environmentName: "CONTROL_PLANE_LLM_GATEWAY_REGION",
    exportName: "AgenticPlatform-ControlPlane-LlmGatewayRegion",
    kind: "region",
    outputKey: "LlmGatewayRegion",
    property: "llmGatewayRegion",
  },
  {
    environmentName: "CONTROL_PLANE_TOOLS_GATEWAY_ID",
    exportName: "AgenticPlatform-ControlPlane-ToolsGatewayId",
    kind: "gateway",
    outputKey: "ToolsGatewayId",
    property: "toolsGatewayId",
  },
];
const REGISTRY_ID_PATTERN = /^[A-Za-z0-9]{12,16}$/;
const GATEWAY_ID_PATTERN =
  /^([a-z0-9]+(?:-[a-z0-9]+)*)-([a-z0-9]{10})$/;
const GATEWAY_PREFIX_MAX_LENGTH = 100;
const CLOUDFRONT_ALARM_NAME_PREFIX =
  `PlatformWeb-${PLATFORM_WEB_STACK_NAME}-`;
const CLOUDFRONT_ALARM_NAME_SUFFIX = "-CloudFront-5xx";
const CLOUDFRONT_ALARM_NAME_PATTERN =
  `${CLOUDFRONT_ALARM_NAME_PREFIX}*${CLOUDFRONT_ALARM_NAME_SUFFIX}`;
const PLATFORM_WEB_RUNTIME_ROLE_NAMES = [
  "AgenticPlatform-Web-AgentRuntimeRole",
  "AgenticPlatform-Web-BuilderApiRole",
  "AgenticPlatform-Web-IdentityApiRole",
  "AgenticPlatform-Web-JourneyApiRole",
  "AgenticPlatform-Web-DeploymentApiRole",
  "AgenticPlatform-Web-ExperienceApiRole",
  "AgenticPlatform-Web-FrontendDeploymentRole",
  "AgenticPlatform-Web-GovernanceApiRole",
  ACCESS_ADMIN_ROLE_NAME,
  GATEWAY_INVOKER_ROLE_NAME,
  MODEL_GOVERNANCE_ROLE_NAME,
  "AgenticPlatform-Web-CloudFrontInvalidationProviderRole",
  "AgenticPlatform-Web-CloudFrontAlarmProviderRole",
  "AgenticPlatform-Web-ControlPlaneReadApiRole",
  "AgenticPlatform-Web-OperationsApiRole",
  "AgenticPlatform-Web-PlatformAdminApiRole",
  "AgenticPlatform-Web-PlatformAgentRegistrySeedRole",
  "AgenticPlatform-Web-RegistryDecisionFinalizerRole",
  "AgenticPlatform-Web-PlatformStateSeedRole",
  "AgenticPlatform-Web-PlatformWorkspaceSeedRole",
  "AgenticPlatform-Web-HostedAcceptanceBrokerRole",
  "AgenticPlatform-Web-RuntimeBoundaryTagProviderRole",
  RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
  RUNTIME_PROOF_PROVIDER_ROLE_NAME,
  "AgenticPlatform-Web-WorkspaceApiRole",
];
const DEFAULT_JOURNEY_INCEPTION_MODEL_ID =
  "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEPLOY_TRANSITION = {
  omittedBoundaryStatementSids: new Set([
    "ListDynamicControlPlaneRegistries",
    "ReadDynamicControlPlaneRegistryRecords",
    "TagPlatformDomainRegistry",
    "CreateHostedAcceptanceDomainRegistry",
    "TagHostedAcceptanceDomainRegistry",
    "InvokeRegistryDecisionFinalizer",
    "CreateHostedAcceptanceFixtureRecord",
    "TagHostedAcceptanceFixtureRecord",
    "ReadHostedAcceptanceFixtureRecord",
    "MutateHostedAcceptanceFixtureRecord",
    "ReadHostedAcceptanceDomainRegistry",
    "DeleteHostedAcceptanceDomainRegistry",
    "ReadDeleteHostedAcceptanceState",
    "ReadPlatformState",
    "ReadPlatformAuditMetadata",
    "WritePlatformState",
    "UpdateExperienceInvocation",
    "AssumeGatewayInvokerRole",
    "ReadRuntimeInvocationProofSecret",
    "WriteRuntimeInvocationProofSecret",
  ]),
};
const AUDIT_MODES = new Set([
  "deploy",
  "postdeploy",
  "bootstrap-new",
  "bootstrap-remediate",
]);
const DEFAULT_EVIDENCE_DIRECTORY = fileURLToPath(
  new URL("../security-audit/", import.meta.url),
);
const RUNTIME_PERMISSIONS_BOUNDARY_SOURCE = JSON.parse(
  readFileSync(
    new URL("../config/runtime-permissions-boundary.json", import.meta.url),
    "utf8",
  ),
);
const CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_SOURCE = JSON.parse(
  readFileSync(
    new URL(
      "../../platform-registry/config/"
        + "control-plane-runtime-permissions-boundary.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
// Newer AWS CLI v2 releases prefix service errors with "\naws: [ERROR]: " and
// exit 254 instead of 255 for CloudFormation ValidationError. Accept exactly
// those two formats; anything else still fails closed.
const MISSING_CDK_TOOLKIT_ERROR =
  /^(?:\r?\naws: \[ERROR\]: )?An error occurred \(ValidationError\) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist\r?\n?$/;
const MISSING_CLOUDFORMATION_STACK_ERROR =
  /^(?:\r?\naws: \[ERROR\]: )?An error occurred \(ValidationError\) when calling the (?:DescribeStacks|ListStackResources) operation: Stack with id ([A-Za-z0-9-]+) does not exist\r?\n?$/;
const MISSING_IAM_ROLE_ERROR =
  /^(?:\r?\naws: \[ERROR\]: )?An error occurred \(NoSuchEntity\) when calling the GetRole operation: The role with name ([A-Za-z0-9_+=,.@-]+) cannot be found\.\r?\n?$/;
const CLOUDFORMATION_MISSING_STACK_STATUSES = new Set([254, 255]);
const IAM_NAME_PATTERN = /^[A-Za-z0-9_+=,.@-]+$/;
const IAM_PATH_PATTERN = /^(?:\/|\/[\x21-\x7E]+\/)$/;
const IAM_PATH_MAX_LENGTH = 512;
const auditCommandClassifications = new WeakMap();

export class AuditCommandError extends Error {
  constructor(command, args, { status, stderr } = {}) {
    super(
      `${command} command failed with exit code `
        + `${Number.isInteger(status) ? status : "unknown"}.`,
    );
    this.name = "AuditCommandError";
    this.command = command;
    this.args = [...args];
    this.status = status;
    const stderrText = typeof stderr === "string" ? stderr : "";
    const stackNameIndex = args.indexOf("--stack-name");
    const roleNameIndex = args.indexOf("--role-name");
    const missingStackMatch =
      MISSING_CLOUDFORMATION_STACK_ERROR.exec(stderrText);
    const missingRoleMatch = MISSING_IAM_ROLE_ERROR.exec(stderrText);
    auditCommandClassifications.set(this, {
      missingCdkToolkit:
        command === "aws"
        && args[0] === "cloudformation"
        && args[1] === "describe-stacks"
        && args[stackNameIndex + 1] === "CDKToolkit"
        && CLOUDFORMATION_MISSING_STACK_STATUSES.has(status)
        && MISSING_CDK_TOOLKIT_ERROR.test(stderrText),
      missingCloudFormationStackName:
        command === "aws"
        && args[0] === "cloudformation"
        && (
          args[1] === "describe-stacks"
          || args[1] === "list-stack-resources"
        )
        && CLOUDFORMATION_MISSING_STACK_STATUSES.has(status)
        && missingStackMatch?.[1] === args[stackNameIndex + 1]
          ? missingStackMatch[1]
          : null,
      missingIamRoleName:
        command === "aws"
        && args[0] === "iam"
        && args[1] === "get-role"
        && status === 254
        && missingRoleMatch?.[1] === args[roleNameIndex + 1]
          ? missingRoleMatch[1]
          : null,
    });
  }
}

class AuditValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AuditValidationError";
    this.code = code;
  }
}

export function createCommandRunner(execFileSync = nodeExecFileSync) {
  return (command, args, { cwd } = {}) => {
    try {
      return execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new AuditCommandError(command, args, {
        status: Number.isInteger(error?.status) ? error.status : error?.code,
        stderr:
          typeof error?.stderr === "string"
            ? error.stderr
            : error?.stderr?.toString?.() ?? "",
      });
    }
  };
}

function repositoryPattern() {
  const owner = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?";
  const repository = "[A-Za-z0-9._-]{1,100}";
  return new RegExp(`^${owner}/${repository}$`);
}

function validateRepositoryName(value) {
  if (
    typeof value !== "string"
    || !repositoryPattern().test(value)
    || value.includes("<")
    || value.includes(">")
    || value.endsWith(".git")
  ) {
    throw new AuditValidationError(
      "GITHUB_REPOSITORY must be a real owner/repo without placeholders.",
      "INVALID_GITHUB_REPOSITORY",
    );
  }
  return value;
}

export function normalizeGitHubRepositoryRemote(remoteUrl) {
  const remote = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  let repository;

  const scpMatch = remote.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (scpMatch) {
    repository = `${scpMatch[1]}/${scpMatch[2]}`;
  } else if (remote.startsWith("ssh://")) {
    try {
      const parsed = new URL(remote);
      if (
        parsed.protocol !== "ssh:"
        || parsed.hostname !== "github.com"
        || parsed.username !== "git"
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
      ) {
        throw new Error("invalid SSH origin");
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length !== 2) {
        throw new Error("invalid SSH path");
      }
      repository = `${segments[0]}/${segments[1]}`;
    } catch {
      repository = undefined;
    }
  } else if (remote.startsWith("https://")) {
    try {
      const parsed = new URL(remote);
      if (
        parsed.protocol !== "https:"
        || parsed.hostname !== "github.com"
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.search
        || parsed.hash
      ) {
        throw new Error("invalid HTTPS origin");
      }
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length !== 2) {
        throw new Error("invalid HTTPS path");
      }
      repository = `${segments[0]}/${segments[1]}`;
    } catch {
      repository = undefined;
    }
  }

  if (repository?.endsWith(".git")) {
    repository = repository.slice(0, -4);
  }
  try {
    return validateRepositoryName(repository);
  } catch {
    throw new AuditValidationError(
      "git origin must be a supported GitHub HTTPS or SSH origin.",
      "INVALID_GIT_ORIGIN",
    );
  }
}

function maskAccountId(value) {
  return typeof value === "string" && /^[0-9]{12}$/.test(value)
    ? `********${value.slice(-4)}`
    : null;
}

export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/\b([0-9]{8})([0-9]{4})\b/g, "********$2")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED_GITHUB_TOKEN]",
    )
    .replace(
      /((?:password|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    );
}

function validateEnvironment(env) {
  const accountId = env.AWS_ACCOUNT_ID;
  if (typeof accountId !== "string" || !/^[0-9]{12}$/.test(accountId)) {
    throw new AuditValidationError(
      "AWS_ACCOUNT_ID must be exactly 12 digits.",
      "INVALID_AWS_ACCOUNT_ID",
    );
  }
  if (env.AWS_REGION !== REQUIRED_REGION) {
    throw new AuditValidationError(
      "AWS_REGION must be exactly us-west-2.",
      "INVALID_AWS_REGION",
    );
  }
  return {
    accountId,
    region: env.AWS_REGION,
    repository: validateRepositoryName(env.GITHUB_REPOSITORY),
  };
}

function strictBooleanEnvironmentFlag(env, name) {
  const value = env[name];
  if (value === undefined || value === "") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new AuditValidationError(
    `${name} must be exactly true or false when set.`,
    "INVALID_BOOLEAN_ENVIRONMENT_FLAG",
  );
}

function validateAuditOptions(env) {
  const mode = env.SECURITY_AUDIT_MODE || "deploy";
  if (!AUDIT_MODES.has(mode)) {
    throw new AuditValidationError(
      "SECURITY_AUDIT_MODE must be deploy, postdeploy, bootstrap-new, "
        + "or bootstrap-remediate.",
      "INVALID_SECURITY_AUDIT_MODE",
    );
  }
  return {
    branchProtectionAttested: strictBooleanEnvironmentFlag(
      env,
      "BRANCH_PROTECTION_ATTESTED",
    ),
    githubDeploymentEnabled: strictBooleanEnvironmentFlag(
      env,
      "ENABLE_GITHUB_DEPLOYMENT",
    ),
    mode,
    remediationApproved:
      mode === "bootstrap-remediate"
      && env.CDK_BOOTSTRAP_REMEDIATION_APPROVED === "yes",
  };
}

function validateControlPlaneDeploymentConfiguration(env) {
  const mode = env.CONTROL_PLANE_MODE;
  const stackName = CONTROL_PLANE_STACK_NAMES.get(mode);
  if (!stackName) {
    throw new AuditValidationError(
      "CONTROL_PLANE_MODE must be exactly reference-existing or provision.",
      "INVALID_CONTROL_PLANE_MODE",
    );
  }

  const expectedIds = {};
  for (const field of CONTROL_PLANE_OUTPUT_CONTRACT) {
    const value = env[field.environmentName];
    if (mode === "provision") {
      if (value !== undefined && value !== "") {
        throw new AuditValidationError(
          `${field.environmentName} must be empty in provision mode.`,
          "PROVISION_CONTROL_PLANE_ID_PRESENT",
        );
      }
      continue;
    }

    if (typeof value !== "string" || value.length === 0) {
      throw new AuditValidationError(
        `${field.environmentName} is required in reference-existing mode.`,
        "MISSING_REFERENCE_CONTROL_PLANE_ID",
      );
    }
    const matchesKind = field.kind === "registry"
      ? REGISTRY_ID_PATTERN.test(value)
      : field.kind === "region"
        ? /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(value)
        : (
          GATEWAY_ID_PATTERN.test(value)
          && GATEWAY_ID_PATTERN.exec(value)[1].length
            <= GATEWAY_PREFIX_MAX_LENGTH
        );
    if (!matchesKind) {
      throw new AuditValidationError(
        `${field.environmentName} is malformed for reference-existing mode.`,
        "INVALID_REFERENCE_CONTROL_PLANE_ID",
      );
    }
    expectedIds[field.property] = value;
  }

  return {
    expectedIds: mode === "reference-existing" ? expectedIds : null,
    mode,
    stackName,
  };
}

function enforceGitHubDeploymentGovernance(audit) {
  if (
    audit.githubDeploymentEnabled
    && !audit.branchProtectionAttested
  ) {
    throw new AuditValidationError(
      "ENABLE_GITHUB_DEPLOYMENT=true requires "
        + "BRANCH_PROTECTION_ATTESTED=true.",
      "GITHUB_DEPLOYMENT_NOT_ATTESTED",
    );
  }
}

function validateGitHubDeploymentMetadata(env, repository) {
  const metadata = {
    repositoryId: env.GITHUB_REPOSITORY_ID,
    repositoryOwnerId: env.GITHUB_REPOSITORY_OWNER_ID,
    subject: env.GITHUB_OIDC_SUBJECT,
    subjectMode: env.GITHUB_OIDC_SUBJECT_MODE,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  };
  const environmentNames = {
    repositoryId: "GITHUB_REPOSITORY_ID",
    repositoryOwnerId: "GITHUB_REPOSITORY_OWNER_ID",
    subject: "GITHUB_OIDC_SUBJECT",
    subjectMode: "GITHUB_OIDC_SUBJECT_MODE",
    workflowRef: "GITHUB_WORKFLOW_REF",
  };

  for (const [key, environmentName] of Object.entries(environmentNames)) {
    if (typeof metadata[key] !== "string" || !metadata[key]) {
      throw new AuditValidationError(
        `${environmentName} is required when GitHub deployment is enabled.`,
        "MISSING_GITHUB_DEPLOYMENT_METADATA",
      );
    }
  }
  if (!/^[1-9][0-9]*$/.test(metadata.repositoryId)) {
    throw new AuditValidationError(
      "GITHUB_REPOSITORY_ID must be a positive numeric GitHub ID.",
      "INVALID_GITHUB_REPOSITORY_ID",
    );
  }
  if (!/^[1-9][0-9]*$/.test(metadata.repositoryOwnerId)) {
    throw new AuditValidationError(
      "GITHUB_REPOSITORY_OWNER_ID must be a positive numeric GitHub owner ID.",
      "INVALID_GITHUB_REPOSITORY_OWNER_ID",
    );
  }

  const expectedWorkflowRef =
    `${repository}/.github/workflows/`
    + "deploy-serverless-platform.yml@refs/heads/main";
  if (metadata.workflowRef !== expectedWorkflowRef) {
    throw new AuditValidationError(
      `GITHUB_WORKFLOW_REF must equal ${expectedWorkflowRef}.`,
      "INVALID_GITHUB_WORKFLOW_REF",
    );
  }
  if (
    metadata.subjectMode !== "legacy"
    && metadata.subjectMode !== "immutable"
  ) {
    throw new AuditValidationError(
      "GITHUB_OIDC_SUBJECT_MODE must be legacy or immutable.",
      "INVALID_GITHUB_OIDC_SUBJECT_MODE",
    );
  }

  const [owner, repositoryName] = repository.split("/");
  const expectedSubject = metadata.subjectMode === "legacy"
    ? `repo:${repository}:ref:refs/heads/main`
    : `repo:${owner}@${metadata.repositoryOwnerId}/`
      + `${repositoryName}@${metadata.repositoryId}:ref:refs/heads/main`;
  if (metadata.subject !== expectedSubject) {
    throw new AuditValidationError(
      "GITHUB_OIDC_SUBJECT does not match declared "
        + `${metadata.subjectMode} mode.`,
      "INVALID_GITHUB_OIDC_SUBJECT",
    );
  }

  return metadata;
}

function parseJsonOutput(output, label) {
  try {
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new AuditValidationError(
      `${label} returned invalid JSON.`,
      "INVALID_COMMAND_OUTPUT",
    );
  }
}

function principalResourceSegments(resource, principalType) {
  const prefix = `${principalType}/`;
  if (!resource.startsWith(prefix)) {
    return null;
  }
  const segments = resource.slice(prefix.length).split("/");
  if (
    segments.length === 0
    || segments.some((segment) => segment.length === 0)
  ) {
    return null;
  }
  return segments;
}

function isValidIamName(value, minimumLength, maximumLength) {
  return typeof value === "string"
    && value.length >= minimumLength
    && value.length <= maximumLength
    && IAM_NAME_PATTERN.test(value);
}

function isValidIamPath(pathValue) {
  return pathValue.length <= IAM_PATH_MAX_LENGTH
    && IAM_PATH_PATTERN.test(pathValue);
}

function parseIamUserResource(resource) {
  const prefix = "user/";
  if (!resource.startsWith(prefix)) {
    return null;
  }
  const pathAndName = resource.slice(prefix.length);
  const finalSeparator = pathAndName.lastIndexOf("/");
  return {
    path: finalSeparator === -1
      ? "/"
      : `/${pathAndName.slice(0, finalSeparator)}/`,
    userName: pathAndName.slice(finalSeparator + 1),
  };
}

function validateCallerPrincipal(arn, accountId) {
  if (typeof arn !== "string") {
    throw new AuditValidationError(
      "STS caller ARN is malformed.",
      "INVALID_STS_CALLER_ARN",
    );
  }
  const match = arn.match(
    /^arn:([^:]+):(iam|sts)::([0-9]{12}):(.+)$/,
  );
  if (!match) {
    throw new AuditValidationError(
      "STS caller ARN is malformed.",
      "INVALID_STS_CALLER_ARN",
    );
  }
  const [, partition, service, arnAccountId, resource] = match;
  if (partition !== REQUIRED_PARTITION) {
    throw new AuditValidationError(
      `STS caller ARN partition must be ${REQUIRED_PARTITION}.`,
      "STS_CALLER_PARTITION_MISMATCH",
    );
  }
  if (arnAccountId !== accountId) {
    throw new AuditValidationError(
      "STS caller ARN account does not match AWS_ACCOUNT_ID.",
      "STS_CALLER_ARN_ACCOUNT_MISMATCH",
    );
  }
  if (service === "iam" && resource === "root") {
    throw new AuditValidationError(
      "AWS root caller is not allowed.",
      "ROOT_CALLER_REJECTED",
    );
  }

  if (service === "sts") {
    const segments = principalResourceSegments(resource, "assumed-role");
    if (segments?.length === 2) {
      const [roleName, sessionName] = segments;
      if (
        isValidIamName(roleName, 1, 64)
        && isValidIamName(sessionName, 2, 64)
      ) {
        return "assumed-role";
      }
    }
  }
  if (service === "iam") {
    const user = parseIamUserResource(resource);
    if (user) {
      if (
        isValidIamName(user.userName, 1, 64)
        && isValidIamPath(user.path)
      ) {
        return "iam-user";
      }
    }
  }
  if (service === "sts") {
    const segments = principalResourceSegments(resource, "federated-user");
    if (
      segments?.length === 1
      && isValidIamName(segments[0], 2, 32)
    ) {
      return "federated-user";
    }
  }
  throw new AuditValidationError(
    "STS caller ARN must identify a recognized non-root principal.",
    "UNRECOGNIZED_STS_CALLER",
  );
}

function githubProviderCandidates(document, accountId) {
  const providers = document.OpenIDConnectProviderList;
  if (!Array.isArray(providers)) {
    throw new AuditValidationError(
      "OIDC provider listing did not contain a provider list.",
      "INVALID_OIDC_LIST",
    );
  }
  const candidates = [];
  for (const provider of providers) {
    if (
      !provider
      || typeof provider !== "object"
      || Array.isArray(provider)
      || typeof provider.Arn !== "string"
    ) {
      throw new AuditValidationError(
        "Every OIDC provider list member must contain one ARN string.",
        "INVALID_OIDC_LIST_MEMBER",
      );
    }
    const match = provider.Arn.match(
      /^arn:([^:]+):iam::([0-9]{12}):oidc-provider\/([A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~+=,@-]+)*)$/,
    );
    if (
      !match
      || match[1] !== REQUIRED_PARTITION
      || match[2] !== accountId
    ) {
      throw new AuditValidationError(
        "OIDC provider ARN must exactly match the target partition and account.",
        "INVALID_OIDC_PROVIDER_ARN",
      );
    }
    const providerPath = match[3];
    if (
      providerPath.startsWith(GITHUB_OIDC_HOST)
      && providerPath !== GITHUB_OIDC_HOST
    ) {
      throw new AuditValidationError(
        "GitHub OIDC provider ARN must use the exact issuer host.",
        "INVALID_GITHUB_OIDC_PROVIDER_ARN",
      );
    }
    if (providerPath === GITHUB_OIDC_HOST) {
      candidates.push(provider);
    }
  }
  return candidates;
}

function isMissingToolkit(error) {
  return error instanceof AuditCommandError
    && auditCommandClassifications.get(error)?.missingCdkToolkit === true;
}

function isMissingCloudFormationStack(error, stackName) {
  return error instanceof AuditCommandError
    && auditCommandClassifications.get(error)
      ?.missingCloudFormationStackName === stackName;
}

function isMissingRuntimeRole(error, roleName) {
  return error instanceof AuditCommandError
    && auditCommandClassifications.get(error)?.missingIamRoleName === roleName;
}

function defaultEvidenceWriter({ filename, evidence }) {
  mkdirSync(DEFAULT_EVIDENCE_DIRECTORY, {
    recursive: true,
    mode: 0o700,
  });
  const evidencePath = path.join(DEFAULT_EVIDENCE_DIRECTORY, filename);
  writeFileSync(
    evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  return evidencePath;
}

function evidenceFilename(date) {
  return `predeploy-security-audit-${date.toISOString().replace(
    /[:.]/g,
    "-",
  )}.json`;
}

function baseEvidence(env, generatedAt) {
  return {
    schemaVersion: 1,
    generatedAt,
    status: "failed",
    audit: {
      branchProtectionAttested: null,
      githubDeploymentEnabled: null,
      mode: null,
      remediationApproved: false,
    },
    target: {
      accountId: null,
      region: null,
      repository: null,
    },
    repository: null,
    caller: null,
    githubOidc: null,
    cdkToolkit: null,
    controlPlane: {
      mode: null,
      outputsMatch: null,
      required: null,
      stackName: null,
      status: "not-checked",
      tagsMatch: null,
    },
    controlPlaneExecutionRole: {
      required: null,
      status: "not-checked",
    },
    controlPlaneRuntimeBoundary: {
      arn: null,
      defaultVersionId: null,
      policyMatches: null,
      required: null,
      status: "not-checked",
      tagsMatch: null,
    },
    controlPlaneRuntimeRoles: {
      boundaryName: CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME,
      required: null,
      roles: [],
      status: "not-checked",
    },
    runtimeRoles: {
      boundaryName: RUNTIME_PERMISSIONS_BOUNDARY_NAME,
      required: null,
      roles: [],
      status: "not-checked",
    },
    runtimeBoundary: {
      arn: null,
      defaultVersionId: null,
      deployedHash: null,
      expectedHash: null,
      required: null,
      status: "not-checked",
      tagsMatch: null,
    },
  };
}

function runAws(runCommand, cwd, service, operation, args = []) {
  return runCommand(
    "aws",
    [
      service,
      operation,
      ...args,
      "--region",
      REQUIRED_REGION,
      "--output",
      "json",
    ],
    { cwd },
  );
}

function verifyExactTagList(tags, label) {
  if (!Array.isArray(tags)) {
    throw new AuditValidationError(
      `${label} must return tags.`,
      "INVALID_MANDATORY_TAGS",
    );
  }
  const observed = new Map();
  for (const tag of tags) {
    if (
      !tag
      || typeof tag !== "object"
      || Array.isArray(tag)
      || typeof tag.Key !== "string"
      || tag.Key.length === 0
      || typeof tag.Value !== "string"
    ) {
      throw new AuditValidationError(
        `${label} contains a malformed tag.`,
        "INVALID_MANDATORY_TAGS",
      );
    }
    if (observed.has(tag.Key)) {
      throw new AuditValidationError(
        `${label} contains duplicate tag keys.`,
        "DUPLICATE_MANDATORY_TAGS",
      );
    }
    observed.set(tag.Key, tag.Value);
  }
  if (
    observed.size !== REQUIRED_TAGS.size
    || [...REQUIRED_TAGS].some(
      ([key, value]) => observed.get(key) !== value,
    )
  ) {
    throw new AuditValidationError(
      `${label} must have the exact mandatory tags.`,
      "MANDATORY_TAG_DRIFT",
    );
  }
}

function validateControlPlaneId(value, field) {
  const matches = field.kind === "registry"
    ? REGISTRY_ID_PATTERN.test(value)
    : field.kind === "region"
      ? /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(value)
      : (
        GATEWAY_ID_PATTERN.test(value)
        && GATEWAY_ID_PATTERN.exec(value)[1].length
          <= GATEWAY_PREFIX_MAX_LENGTH
      );
  if (!matches) {
    throw new AuditValidationError(
      `Control-plane output ${field.outputKey} is malformed.`,
      "INVALID_CONTROL_PLANE_OUTPUT",
    );
  }
}

function inspectControlPlane({
  accountId,
  config,
  cwd,
  region,
  runCommand,
}) {
  const document = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "cloudformation",
      "describe-stacks",
      ["--stack-name", config.stackName],
    ),
    "Control-plane stack inspection",
  );
  if (!Array.isArray(document.Stacks) || document.Stacks.length !== 1) {
    throw new AuditValidationError(
      "Control-plane stack inspection must return exactly one stack.",
      "INVALID_CONTROL_PLANE_STACK",
    );
  }
  const stack = document.Stacks[0];
  if (
    !stack
    || typeof stack !== "object"
    || Array.isArray(stack)
    || stack.StackName !== config.stackName
  ) {
    throw new AuditValidationError(
      "Control-plane stack inspection returned an unexpected stack.",
      "CONTROL_PLANE_STACK_MISMATCH",
    );
  }
  verifyExactTagList(stack.Tags, "Control-plane stack");
  if (!Array.isArray(stack.Outputs)) {
    throw new AuditValidationError(
      "Control-plane stack inspection must return outputs.",
      "INVALID_CONTROL_PLANE_OUTPUTS",
    );
  }

  const outputMap = new Map();
  for (const output of stack.Outputs) {
    if (
      !output
      || typeof output !== "object"
      || Array.isArray(output)
      || typeof output.OutputKey !== "string"
      || output.OutputKey.length === 0
      || typeof output.OutputValue !== "string"
      || output.OutputValue.length === 0
    ) {
      throw new AuditValidationError(
        "Control-plane stack contains a malformed output.",
        "INVALID_CONTROL_PLANE_OUTPUTS",
      );
    }
    if (outputMap.has(output.OutputKey)) {
      throw new AuditValidationError(
        "Control-plane stack contains duplicate output keys.",
        "DUPLICATE_CONTROL_PLANE_OUTPUT",
      );
    }
    outputMap.set(output.OutputKey, output);
  }

  const ids = {};
  for (const field of CONTROL_PLANE_OUTPUT_CONTRACT) {
    const output = outputMap.get(field.outputKey);
    if (
      !output
      || output.ExportName !== field.exportName
    ) {
      throw new AuditValidationError(
        "Control-plane stack export contract is incomplete or inconsistent.",
        "CONTROL_PLANE_EXPORT_MISMATCH",
      );
    }
    validateControlPlaneId(output.OutputValue, field);
    if (
      config.expectedIds
      && output.OutputValue !== config.expectedIds[field.property]
    ) {
      throw new AuditValidationError(
        "Control-plane outputs do not match protected repository variables.",
        "REFERENCE_CONTROL_PLANE_ID_MISMATCH",
      );
    }
    ids[field.property] = output.OutputValue;
  }

  return {
    evidence: {
      mode: config.mode,
      outputsMatch: true,
      required: true,
      stackName: config.stackName,
      status: "passed",
      tagsMatch: true,
    },
    resources: {
      customerSupportRegistryArn:
        `arn:${REQUIRED_PARTITION}:agent-registry:${region}:`
        + `${accountId}:registry/${ids.registryCustomerSupportId}`,
      llmGatewayArn:
        `arn:${REQUIRED_PARTITION}:bedrock-agentcore:`
        + `${ids.llmGatewayRegion}:`
        + `${accountId}:gateway/${ids.llmGatewayId}`,
      operationsRegistryArn:
        `arn:${REQUIRED_PARTITION}:agent-registry:${region}:`
        + `${accountId}:registry/${ids.registryOperationsId}`,
      platformRegistryArn:
        `arn:${REQUIRED_PARTITION}:agent-registry:${region}:`
        + `${accountId}:registry/${ids.registryPlatformId}`,
      sharedRegistryArn:
        `arn:${REQUIRED_PARTITION}:agent-registry:${region}:`
        + `${accountId}:registry/${ids.sharedRegistryId}`,
      toolsGatewayArn:
        `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:`
        + `${accountId}:gateway/${ids.toolsGatewayId}`,
    },
  };
}

function inspectToolkit({ cwd, runCommand }) {
  let stackDocument;
  try {
    stackDocument = parseJsonOutput(
      runAws(
        runCommand,
        cwd,
        "cloudformation",
        "describe-stacks",
        ["--stack-name", "CDKToolkit"],
      ),
      "CDKToolkit inspection",
    );
  } catch (error) {
    if (isMissingToolkit(error)) {
      return {
        bootstrapVersion: null,
        compliant: null,
        issues: [],
        status: "absent",
        terminationProtection: null,
      };
    }
    throw error;
  }

  if (!Array.isArray(stackDocument.Stacks) || stackDocument.Stacks.length !== 1) {
    throw new AuditValidationError(
      "CDKToolkit inspection must return exactly one stack.",
      "INVALID_CDK_TOOLKIT",
    );
  }
  const stack = stackDocument.Stacks[0];
  if (
    stack.EnableTerminationProtection !== true
    && stack.EnableTerminationProtection !== false
  ) {
    throw new AuditValidationError(
      "CDKToolkit termination protection state must be boolean.",
      "INVALID_CDK_TOOLKIT",
    );
  }
  const issues = [];
  if (stack.EnableTerminationProtection === false) {
    issues.push("termination-protection-disabled");
  }
  const output = Array.isArray(stack.Outputs)
    ? stack.Outputs.find(({ OutputKey } = {}) =>
      OutputKey === "BootstrapVersion"
    )
    : undefined;
  const outputVersion = Number(output?.OutputValue);
  if (!Number.isInteger(outputVersion)) {
    throw new AuditValidationError(
      "CDKToolkit BootstrapVersion output must be numeric.",
      "INVALID_BOOTSTRAP_VERSION",
    );
  }

  const parameterVersionOutput = runCommand(
    "aws",
    [
      "ssm",
      "get-parameter",
      "--name",
      BOOTSTRAP_PARAMETER,
      "--region",
      REQUIRED_REGION,
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ],
    { cwd },
  );
  const parameterVersion = Number(parameterVersionOutput.trim());
  if (!Number.isInteger(parameterVersion)) {
    throw new AuditValidationError(
      "CDK bootstrap version parameter must be numeric.",
      "INVALID_BOOTSTRAP_VERSION",
    );
  }
  if (outputVersion !== parameterVersion) {
    throw new AuditValidationError(
      "CDKToolkit bootstrap version output does not match the SSM parameter.",
      "BOOTSTRAP_VERSION_MISMATCH",
    );
  }
  if (parameterVersion < MINIMUM_BOOTSTRAP_VERSION) {
    issues.push("bootstrap-version-below-6");
  }
  return {
    bootstrapVersion: parameterVersion,
    compliant: issues.length === 0,
    issues,
    status: "present",
    terminationProtection: stack.EnableTerminationProtection,
  };
}

function inspectRuntimeRoles({
  accountId,
  agentRuntimeArn,
  agentRuntimeProductionEndpointArn,
  accessAdminLogGroupArn,
  allowPlannedTransition,
  builderLogGroupArn,
  controlPlaneResources,
  controlPlaneReadLogGroupArn,
  cwd,
  experienceLogGroupArn,
  governanceLogGroupArn,
  hostedAcceptanceBrokerFunctionArn,
  hostedAcceptanceBrokerLogGroupArn,
  identityLogGroupArn,
  journeyGithubOAuthClientSecretArn,
  journeyPredecessorInceptionModelArns,
  journeyLogGroupArn,
  modelGovernanceLogGroupArn,
  platformAdminLogGroupArn,
  registryDecisionFinalizerLogGroupArn,
  platformStateSeedLogGroupArn,
  platformStateTableArn,
  region,
  runCommand,
  runtimeProofConfiguratorFunctionArn,
  runtimeProofConfiguratorLogGroupArn,
  runtimeProofProviderLogGroupArn,
  runtimeInvocationProofSecretArn,
  userPoolArn,
  workspaceLogGroupArn,
}) {
  const boundaryArn =
    `arn:aws:iam::${accountId}:policy/`
    + RUNTIME_PERMISSIONS_BOUNDARY_NAME;
  const roles = [];
  const runtimeProofPriorResourcesAbsent =
    runtimeInvocationProofSecretArn === null
    && runtimeProofConfiguratorFunctionArn === null
    && runtimeProofConfiguratorLogGroupArn === null
    && runtimeProofProviderLogGroupArn === null;

  for (const roleName of PLATFORM_WEB_RUNTIME_ROLE_NAMES) {
    let document;
    try {
      document = parseJsonOutput(
        runAws(
          runCommand,
          cwd,
          "iam",
          "get-role",
          ["--role-name", roleName],
        ),
        `${roleName} runtime role inspection`,
      );
    } catch (error) {
      if (
        allowPlannedTransition
        && (
          roleName === REGISTRY_DECISION_FINALIZER_ROLE_NAME
          || roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME
          || roleName === PLATFORM_AGENT_REGISTRY_SEED_ROLE_NAME
          || roleName === PLATFORM_WORKSPACE_SEED_ROLE_NAME
          || (
            roleName === GATEWAY_INVOKER_ROLE_NAME
            && runtimeInvocationProofSecretArn === null
          )
          || (
            roleName === MODEL_GOVERNANCE_ROLE_NAME
            && modelGovernanceLogGroupArn === null
          )
          || (
            roleName === ACCESS_ADMIN_ROLE_NAME
            && accessAdminLogGroupArn === null
          )
          || (
            (
              roleName === RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME
              || roleName === RUNTIME_PROOF_PROVIDER_ROLE_NAME
            )
            && runtimeProofPriorResourcesAbsent
          )
        )
        && isMissingRuntimeRole(error, roleName)
      ) {
        roles.push({
          roleName,
          status: "planned",
        });
        continue;
      }
      if (
        isMissingRuntimeRole(error, roleName)
        && (
          roleName === RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME
          || roleName === RUNTIME_PROOF_PROVIDER_ROLE_NAME
        )
      ) {
        throw new AuditValidationError(
          `${roleName} is required when Runtime proof resources exist.`,
          "RUNTIME_PROOF_ROLE_REQUIRED",
        );
      }
      throw error;
    }
    const role = document.Role;
    if (!role || typeof role !== "object" || Array.isArray(role)) {
      throw new AuditValidationError(
        `Runtime role inspection for ${roleName} must return one Role object.`,
        "INVALID_RUNTIME_ROLE",
      );
    }
    if (role.RoleName !== roleName) {
      throw new AuditValidationError(
        `Runtime role inspection returned an unexpected role name for ${roleName}.`,
        "RUNTIME_ROLE_NAME_MISMATCH",
      );
    }
    if (role.Arn !== `arn:aws:iam::${accountId}:role/${roleName}`) {
      throw new AuditValidationError(
        `Runtime role inspection returned an unexpected role ARN for ${roleName}.`,
        "RUNTIME_ROLE_ARN_MISMATCH",
      );
    }
    if (
      role.PermissionsBoundary?.PermissionsBoundaryArn !== boundaryArn
      || role.PermissionsBoundary?.PermissionsBoundaryType !== "Policy"
    ) {
      throw new AuditValidationError(
        `${roleName} must have the exact runtime permissions boundary.`,
        "RUNTIME_ROLE_BOUNDARY_MISMATCH",
      );
    }
    const roleEvidence = {
      arnMatches: true,
      boundaryMatches: true,
      roleName,
    };
    if (roleName === GATEWAY_INVOKER_ROLE_NAME) {
      inspectGatewayInvokerRole({
        accountId,
        controlPlaneResources,
        cwd,
        role,
        runCommand,
      });
      Object.assign(roleEvidence, {
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === MODEL_GOVERNANCE_ROLE_NAME) {
      if (
        modelGovernanceLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Model Governance role resources are missing.",
          "MODEL_GOVERNANCE_RESOURCES_MISSING",
        );
      }
      inspectModelGovernanceRole({
        accountId,
        controlPlaneResources,
        cwd,
        gatewayInvokerRoleArn:
          `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
          + GATEWAY_INVOKER_ROLE_NAME,
        logGroupArn: modelGovernanceLogGroupArn,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === BUILDER_ROLE_NAME) {
      if (
        builderLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Builder role resources are missing.",
          "BUILDER_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectBuilderRole({
        accountId,
        allowPlannedTransition,
        controlPlaneResources,
        cwd,
        gatewayInvokerRoleArn:
          `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
          + GATEWAY_INVOKER_ROLE_NAME,
        logGroupArn: builderLogGroupArn,
        region,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === JOURNEY_ROLE_NAME) {
      if (
        journeyLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Journey API role resources are missing.",
          "JOURNEY_ROLE_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectJourneyRole({
        agentRuntimeArn,
        agentRuntimeProductionEndpointArn,
        allowPlannedTransition,
        controlPlaneResources,
        cwd,
        gatewayInvokerRoleArn:
          `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
          + GATEWAY_INVOKER_ROLE_NAME,
        githubOAuthClientSecretArn:
          journeyGithubOAuthClientSecretArn,
        inceptionModelArns:
          journeyPredecessorInceptionModelArns,
        logGroupArn: journeyLogGroupArn,
        role,
        runCommand,
        runtimeInvocationProofSecretArn,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === AGENT_RUNTIME_ROLE_NAME) {
      const acceptedPolicyState = inspectAgentRuntimeRole({
        accountId,
        allowPlannedTransition,
        cwd,
        gatewayInvokerRoleArn:
          `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
          + GATEWAY_INVOKER_ROLE_NAME,
        region,
        role,
        runCommand,
        runtimeInvocationProofSecretArn,
        tableArn: platformStateTableArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === EXPERIENCE_ROLE_NAME) {
      if (
        experienceLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Experience role resources are missing.",
          "EXPERIENCE_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectExperienceRole({
        agentRuntimeArn,
        agentRuntimeProductionEndpointArn,
        allowPlannedTransition,
        cwd,
        logGroupArn: experienceLogGroupArn,
        role,
        runCommand,
        runtimeInvocationProofSecretArn,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === IDENTITY_ROLE_NAME) {
      if (
        identityLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Identity API role resources are missing.",
          "IDENTITY_API_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectIdentityRole({
        allowPlannedTransition,
        cwd,
        logGroupArn: identityLogGroupArn,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === GOVERNANCE_ROLE_NAME) {
      if (
        governanceLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Governance API role resources are missing.",
          "GOVERNANCE_API_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectGovernanceRole({
        accountId,
        allowPlannedTransition,
        controlPlaneResources,
        cwd,
        logGroupArn: governanceLogGroupArn,
        region,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === WORKSPACE_ROLE_NAME) {
      if (
        workspaceLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Workspace API role resources are missing.",
          "WORKSPACE_API_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectWorkspaceRole({
        allowPlannedTransition,
        cwd,
        logGroupArn: workspaceLogGroupArn,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === ACCESS_ADMIN_ROLE_NAME) {
      if (
        accessAdminLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Access Admin role resources are missing.",
          "ACCESS_ADMIN_RESOURCES_MISSING",
        );
      }
      inspectAccessAdminRole({
        cwd,
        logGroupArn: accessAdminLogGroupArn,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState: "target",
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === CONTROL_PLANE_READ_ROLE_NAME) {
      if (
        controlPlaneReadLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Control-plane read role resources are missing.",
          "CONTROL_PLANE_READ_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectControlPlaneReadRole({
        accountId,
        allowPlannedTransition,
        controlPlaneResources,
        cwd,
        logGroupArn: controlPlaneReadLogGroupArn,
        region,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === PLATFORM_ADMIN_ROLE_NAME) {
      if (platformStateTableArn === null || userPoolArn === null) {
        throw new AuditValidationError(
          "Platform admin role table resource is missing.",
          "PLATFORM_ADMIN_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectPlatformAdminRole({
        accountId,
        allowPlannedTransition,
        controlPlaneResources,
        cwd,
        logGroupArn: platformAdminLogGroupArn,
        region,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === PLATFORM_STATE_SEED_ROLE_NAME) {
      if (
        platformStateSeedLogGroupArn === null
        || platformStateTableArn === null
      ) {
        throw new AuditValidationError(
          "Platform state seed role resources are missing.",
          "PLATFORM_STATE_SEED_RESOURCES_MISSING",
        );
      }
      inspectPlatformSeedRole({
        accountId,
        allowPlannedTransition,
        codePrefix: "PLATFORM_STATE_SEED",
        cwd,
        label: "Platform state seed role",
        leadingKeys: ["DOMAIN"],
        logGroupArn: platformStateSeedLogGroupArn,
        policyName: PLATFORM_STATE_SEED_POLICY_NAME,
        role,
        roleName: PLATFORM_STATE_SEED_ROLE_NAME,
        runCommand,
        tableArn: platformStateTableArn,
      });
      Object.assign(roleEvidence, {
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === PLATFORM_WORKSPACE_SEED_ROLE_NAME) {
      if (
        platformStateSeedLogGroupArn === null
        || platformStateTableArn === null
      ) {
        throw new AuditValidationError(
          "Platform workspace seed role resources are missing.",
          "PLATFORM_WORKSPACE_SEED_RESOURCES_MISSING",
        );
      }
      inspectPlatformSeedRole({
        accountId,
        allowPlannedTransition,
        codePrefix: "PLATFORM_WORKSPACE_SEED",
        cwd,
        label: "Platform workspace seed role",
        leadingKeys: ["PROJECT#platform", "HITL_POLICY#platform"],
        logGroupArn: platformStateSeedLogGroupArn,
        policyName: PLATFORM_WORKSPACE_SEED_POLICY_NAME,
        role,
        roleName: PLATFORM_WORKSPACE_SEED_ROLE_NAME,
        runCommand,
        tableArn: platformStateTableArn,
      });
      Object.assign(roleEvidence, {
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === REGISTRY_DECISION_FINALIZER_ROLE_NAME) {
      if (
        registryDecisionFinalizerLogGroupArn === null
        || platformStateTableArn === null
      ) {
        throw new AuditValidationError(
          "Registry decision finalizer resources are missing.",
          "REGISTRY_DECISION_FINALIZER_RESOURCES_MISSING",
        );
      }
      inspectRegistryDecisionFinalizerRole({
        accountId,
        allowPlannedTransition,
        cwd,
        logGroupArn: registryDecisionFinalizerLogGroupArn,
        role,
        runCommand,
        tableArn: platformStateTableArn,
      });
      Object.assign(roleEvidence, {
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === HOSTED_ACCEPTANCE_BROKER_ROLE_NAME) {
      if (
        hostedAcceptanceBrokerLogGroupArn === null
        || platformStateTableArn === null
        || userPoolArn === null
      ) {
        throw new AuditValidationError(
          "Hosted acceptance broker role resources are missing.",
          "HOSTED_ACCEPTANCE_BROKER_RESOURCES_MISSING",
        );
      }
      const acceptedPolicyState = inspectHostedAcceptanceBrokerRole({
        accountId,
        agentRuntimeArn,
        agentRuntimeProductionEndpointArn,
        allowPlannedTransition,
        controlPlaneResources,
        cwd,
        logGroupArn: hostedAcceptanceBrokerLogGroupArn,
        region,
        role,
        runCommand,
        tableArn: platformStateTableArn,
        userPoolArn,
      });
      Object.assign(roleEvidence, {
        acceptedPolicyState,
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME) {
      if (
        runtimeProofConfiguratorLogGroupArn === null
        || runtimeInvocationProofSecretArn === null
      ) {
        throw new AuditValidationError(
          "Runtime proof configurator role resources are missing.",
          "RUNTIME_PROOF_CONFIGURATOR_RESOURCES_MISSING",
        );
      }
      inspectRuntimeProofConfiguratorRole({
        cwd,
        logGroupArn: runtimeProofConfiguratorLogGroupArn,
        role,
        runCommand,
        runtimeInvocationProofSecretArn,
      });
      Object.assign(roleEvidence, {
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    if (roleName === RUNTIME_PROOF_PROVIDER_ROLE_NAME) {
      if (
        runtimeProofConfiguratorFunctionArn === null
        || runtimeProofProviderLogGroupArn === null
      ) {
        throw new AuditValidationError(
          "Runtime proof provider role resources are missing.",
          "RUNTIME_PROOF_PROVIDER_RESOURCES_MISSING",
        );
      }
      inspectRuntimeProofProviderRole({
        configuratorFunctionArn: runtimeProofConfiguratorFunctionArn,
        cwd,
        logGroupArn: runtimeProofProviderLogGroupArn,
        role,
        runCommand,
      });
      Object.assign(roleEvidence, {
        attachedPoliciesAbsent: true,
        inlinePolicyMatches: true,
        trustMatches: true,
      });
    }
    roles.push(roleEvidence);
  }

  let hostedAcceptanceRoleDocument;
  try {
    hostedAcceptanceRoleDocument = parseJsonOutput(
      runAws(
        runCommand,
        cwd,
        "iam",
        "get-role",
        ["--role-name", HOSTED_ACCEPTANCE_ROLE_NAME],
      ),
      `${HOSTED_ACCEPTANCE_ROLE_NAME} role inspection`,
    );
  } catch (error) {
    if (
      allowPlannedTransition
      && hostedAcceptanceBrokerFunctionArn === null
      && isMissingRuntimeRole(error, HOSTED_ACCEPTANCE_ROLE_NAME)
    ) {
      roles.push({
        roleName: HOSTED_ACCEPTANCE_ROLE_NAME,
        status: "planned",
      });
      return {
        boundaryName: RUNTIME_PERMISSIONS_BOUNDARY_NAME,
        required: true,
        roles,
        status: "passed",
      };
    }
    if (isMissingRuntimeRole(error, HOSTED_ACCEPTANCE_ROLE_NAME)) {
      throw new AuditValidationError(
        "Hosted acceptance role is required in the postdeploy target.",
        "HOSTED_ACCEPTANCE_ROLE_REQUIRED",
      );
    }
    throw error;
  }
  const hostedAcceptanceRole = hostedAcceptanceRoleDocument.Role;
  if (
    !hostedAcceptanceRole
    || typeof hostedAcceptanceRole !== "object"
    || Array.isArray(hostedAcceptanceRole)
  ) {
    throw new AuditValidationError(
      "Hosted acceptance role inspection must return one Role object.",
      "INVALID_HOSTED_ACCEPTANCE_ROLE",
    );
  }
  if (hostedAcceptanceRole.RoleName !== HOSTED_ACCEPTANCE_ROLE_NAME) {
    throw new AuditValidationError(
      "Hosted acceptance role inspection returned an unexpected role name.",
      "HOSTED_ACCEPTANCE_ROLE_NAME_MISMATCH",
    );
  }
  if (
    hostedAcceptanceRole.Arn
    !== `arn:${REQUIRED_PARTITION}:iam::${accountId}:`
      + `role/${HOSTED_ACCEPTANCE_ROLE_NAME}`
  ) {
    throw new AuditValidationError(
      "Hosted acceptance role ARN has drifted.",
      "HOSTED_ACCEPTANCE_ROLE_ARN_DRIFT",
    );
  }
  if (hostedAcceptanceRole.PermissionsBoundary !== undefined) {
    throw new AuditValidationError(
      "Hosted acceptance role must not have a permissions boundary.",
      "HOSTED_ACCEPTANCE_ROLE_BOUNDARY_DRIFT",
    );
  }
  if (hostedAcceptanceBrokerFunctionArn === null || userPoolArn === null) {
    throw new AuditValidationError(
      "Hosted acceptance role resources are missing.",
      "HOSTED_ACCEPTANCE_ROLE_RESOURCES_MISSING",
    );
  }
  inspectHostedAcceptanceRole({
    accountId,
    brokerFunctionArn: hostedAcceptanceBrokerFunctionArn,
    cwd,
    role: hostedAcceptanceRole,
    runCommand,
    userPoolArn,
  });
  roles.push({
    arnMatches: true,
    attachedPoliciesAbsent: true,
    boundaryAbsent: true,
    inlinePolicyMatches: true,
    roleName: HOSTED_ACCEPTANCE_ROLE_NAME,
    trustMatches: true,
  });

  const inspection = {
    boundaryName: RUNTIME_PERMISSIONS_BOUNDARY_NAME,
    required: true,
    roles,
    status: "passed",
  };
  return inspection;
}

function inspectExactRolePolicyInventory({
  codePrefix,
  cwd,
  expectedPolicyNames,
  expectedTrust,
  label,
  role,
  roleName,
  runCommand,
}) {
  if (
    canonicalPolicyContent(decodePolicyDocument(
      role.AssumeRolePolicyDocument,
      `${label} trust policy`,
    )) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      `${label} trust policy has drifted.`,
      `${codePrefix}_TRUST_DRIFT`,
    );
  }

  const attached = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-attached-role-policies", [
      "--role-name", roleName,
    ]),
    `${label} attached policy inspection`,
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      `${label} must have no attached policies.`,
      `${codePrefix}_ATTACHED_POLICY_DRIFT`,
    );
  }

  const policyList = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-role-policies", [
      "--role-name", roleName,
    ]),
    `${label} inline policy listing`,
  );
  const actualPolicyNames = policyList.PolicyNames;
  if (
    !isCompleteIamListResponse(policyList)
    || !Array.isArray(actualPolicyNames)
    || actualPolicyNames.length !== expectedPolicyNames.length
    || new Set(actualPolicyNames).size !== actualPolicyNames.length
    || expectedPolicyNames.some(
      (policyName) => !actualPolicyNames.includes(policyName),
    )
  ) {
    throw new AuditValidationError(
      `${label} must have exactly the approved inline policies.`,
      `${codePrefix}_INLINE_POLICY_LIST_DRIFT`,
    );
  }

  return new Map(expectedPolicyNames.map((policyName) => {
    const inline = parseJsonOutput(
      runAws(runCommand, cwd, "iam", "get-role-policy", [
        "--role-name", roleName,
        "--policy-name", policyName,
      ]),
      `${label} ${policyName} policy inspection`,
    );
    if (
      inline.RoleName !== roleName
      || inline.PolicyName !== policyName
    ) {
      throw new AuditValidationError(
        `${label} inline policy metadata has drifted.`,
        `${codePrefix}_INLINE_POLICY_METADATA_DRIFT`,
      );
    }
    return [
      policyName,
      canonicalPolicyContent(decodePolicyDocument(
        inline.PolicyDocument,
        `${label} ${policyName} policy`,
      )),
    ];
  }));
}

function lambdaTrustPolicy() {
  return {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
}

function inspectRuntimeProofConfiguratorRole({
  cwd,
  logGroupArn,
  role,
  runCommand,
  runtimeInvocationProofSecretArn,
}) {
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "RUNTIME_PROOF_CONFIGURATOR_ROLE",
    cwd,
    expectedPolicyNames: [RUNTIME_PROOF_CONFIGURATOR_POLICY_NAME],
    expectedTrust: lambdaTrustPolicy(),
    label: "Runtime proof configurator role",
    role,
    roleName: RUNTIME_PROOF_CONFIGURATOR_ROLE_NAME,
    runCommand,
  });
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
        ],
        Effect: "Allow",
        Resource: runtimeInvocationProofSecretArn,
      },
    ],
  };
  if (
    policies.get(RUNTIME_PROOF_CONFIGURATOR_POLICY_NAME)
      !== canonicalPolicyContent(expectedPolicy)
  ) {
    throw new AuditValidationError(
      "Runtime proof configurator role inline policy has drifted.",
      "RUNTIME_PROOF_CONFIGURATOR_ROLE_INLINE_POLICY_DRIFT",
    );
  }
}

function inspectRuntimeProofProviderRole({
  configuratorFunctionArn,
  cwd,
  logGroupArn,
  role,
  runCommand,
}) {
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "RUNTIME_PROOF_PROVIDER_ROLE",
    cwd,
    expectedPolicyNames: [
      RUNTIME_PROOF_PROVIDER_LOG_POLICY_NAME,
      RUNTIME_PROOF_PROVIDER_DEFAULT_POLICY_NAME,
    ],
    expectedTrust: lambdaTrustPolicy(),
    label: "Runtime proof provider role",
    role,
    roleName: RUNTIME_PROOF_PROVIDER_ROLE_NAME,
    runCommand,
  });
  const expectedLogPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: `${logGroupArn}:*`,
    }],
  };
  if (
    policies.get(RUNTIME_PROOF_PROVIDER_LOG_POLICY_NAME)
      !== canonicalPolicyContent(expectedLogPolicy)
  ) {
    throw new AuditValidationError(
      "Runtime proof provider log policy has drifted.",
      "RUNTIME_PROOF_PROVIDER_ROLE_LOG_POLICY_DRIFT",
    );
  }
  const expectedDefaultPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: "lambda:InvokeFunction",
        Effect: "Allow",
        Resource: [
          configuratorFunctionArn,
          `${configuratorFunctionArn}:*`,
        ],
      },
      {
        Action: "lambda:GetFunction",
        Effect: "Allow",
        Resource: configuratorFunctionArn,
      },
    ],
  };
  if (
    policies.get(RUNTIME_PROOF_PROVIDER_DEFAULT_POLICY_NAME)
      !== canonicalPolicyContent(expectedDefaultPolicy)
  ) {
    throw new AuditValidationError(
      "Runtime proof provider default policy has drifted.",
      "RUNTIME_PROOF_PROVIDER_ROLE_DEFAULT_POLICY_DRIFT",
    );
  }
}

function xrayWritePolicy() {
  return {
    Version: "2012-10-17",
    Statement: [{
      Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
      Effect: "Allow",
      Resource: "*",
    }],
  };
}

function gatewaySessionActions() {
  return ["sts:AssumeRole", "sts:SetSourceIdentity"];
}

function inspectGatewayInvokerRole({
  accountId,
  controlPlaneResources,
  cwd,
  role,
  runCommand,
}) {
  const approvedCallerRoleNames = [
    BUILDER_ROLE_NAME,
    CONTROL_PLANE_READ_ROLE_NAME,
    JOURNEY_ROLE_NAME,
    AGENT_RUNTIME_ROLE_NAME,
    MODEL_GOVERNANCE_ROLE_NAME,
  ];
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "GATEWAY_INVOKER_ROLE",
    cwd,
    expectedPolicyNames: [GATEWAY_INVOKER_POLICY_NAME],
    expectedTrust: {
      Version: "2012-10-17",
      Statement: approvedCallerRoleNames.map((roleName) => ({
        Action: gatewaySessionActions(),
        Condition: {
          ArnEquals: {
            "aws:PrincipalArn":
              `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/${roleName}`,
          },
          ...(
            roleName === BUILDER_ROLE_NAME
            || roleName === JOURNEY_ROLE_NAME
            || roleName === AGENT_RUNTIME_ROLE_NAME
              ? {
                  StringLike: {
                    "sts:SourceIdentity": "domain_*",
                  },
                }
              : {
                  StringEquals: {
                    "sts:SourceIdentity": "platform",
                  },
                }
          ),
        },
        Effect: "Allow",
        Principal: {
          AWS:
            `arn:${REQUIRED_PARTITION}:iam::${accountId}:root`,
        },
      })),
    },
    label: "Gateway invoker role",
    role,
    roleName: GATEWAY_INVOKER_ROLE_NAME,
    runCommand,
  });
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Action: "bedrock-agentcore:InvokeGateway",
      Effect: "Allow",
      Resource: controlPlaneResources.llmGatewayArn,
    }],
  };
  if (
    policies.get(GATEWAY_INVOKER_POLICY_NAME)
      !== canonicalPolicyContent(expectedPolicy)
  ) {
    throw new AuditValidationError(
      "Gateway invoker role inline policy has drifted.",
      "GATEWAY_INVOKER_ROLE_INLINE_POLICY_DRIFT",
    );
  }
}

function inspectModelGovernanceRole({
  accountId: _accountId,
  controlPlaneResources,
  cwd,
  gatewayInvokerRoleArn,
  logGroupArn,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "MODEL_GOVERNANCE_ROLE",
    cwd,
    expectedPolicyNames: [
      MODEL_GOVERNANCE_POLICY_NAME,
      MODEL_GOVERNANCE_XRAY_POLICY_NAME,
    ],
    expectedTrust: lambdaTrustPolicy(),
    label: "Model Governance role",
    role,
    roleName: MODEL_GOVERNANCE_ROLE_NAME,
    runCommand,
  });
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "APPROVAL#*",
              "DOMAIN",
              "GRANT#*",
              "MODEL_POLICY",
              "MUTATION#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "APPROVAL#*",
              "AUDIT#*",
              "GRANT#*",
              "MODEL_POLICY",
              "MODEL_POLICY_AUDIT#*",
              "MUTATION#*",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
      {
        Action: [
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:ListGatewayTargets",
        ],
        Effect: "Allow",
        Resource: controlPlaneResources.toolsGatewayArn,
      },
      {
        Action: [
          "bedrock-agentcore:BatchPutGatewayRateLimits",
          "bedrock-agentcore:ListGatewayRateLimits",
        ],
        Effect: "Allow",
        Resource: controlPlaneResources.llmGatewayArn,
      },
      {
        Action: gatewaySessionActions(),
        Effect: "Allow",
        Resource: gatewayInvokerRoleArn,
      },
    ],
  };
  if (
    policies.get(MODEL_GOVERNANCE_POLICY_NAME)
      !== canonicalPolicyContent(expectedPolicy)
  ) {
    throw new AuditValidationError(
      "Model Governance role application policy has drifted.",
      "MODEL_GOVERNANCE_ROLE_INLINE_POLICY_DRIFT",
    );
  }
  if (
    policies.get(MODEL_GOVERNANCE_XRAY_POLICY_NAME)
      !== canonicalPolicyContent(xrayWritePolicy())
  ) {
    throw new AuditValidationError(
      "Model Governance role X-Ray policy has drifted.",
      "MODEL_GOVERNANCE_ROLE_XRAY_POLICY_DRIFT",
    );
  }
}

function inspectBuilderRole({
  accountId,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  gatewayInvokerRoleArn,
  logGroupArn,
  region,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "BUILDER_ROLE",
    cwd,
    expectedPolicyNames: [
      BUILDER_POLICY_NAME,
      BUILDER_XRAY_POLICY_NAME,
    ],
    expectedTrust: lambdaTrustPolicy(),
    label: "Builder role",
    role,
    roleName: BUILDER_ROLE_NAME,
    runCommand,
  });
  const registryArns = [
    controlPlaneResources.sharedRegistryArn,
    controlPlaneResources.platformRegistryArn,
    controlPlaneResources.customerSupportRegistryArn,
    controlPlaneResources.operationsRegistryArn,
  ];
  const accountRegistryArn =
    `arn:${REQUIRED_PARTITION}:agent-registry:${region}:${accountId}:`
    + "registry/*";
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "AUDIT#*",
              "DOMAIN",
              "GRANT#*",
              "MODEL_POLICY",
              "MUTATION#*",
              "PROJECT#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["DOMAIN"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MUTATION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "AUDIT#*",
              "MUTATION#*",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "agent-registry:ListRegistryRecords",
        Effect: "Allow",
        Resource: registryArns,
      },
      {
        Action: [
          "agent-registry:GetDiscoverableRegistryRecord",
          "agent-registry:GetRegistryRecord",
        ],
        Effect: "Allow",
        Resource: registryArns.map((arn) => `${arn}/record/*`),
      },
      {
        Action: "agent-registry:ListRegistryRecords",
        Condition: registryResourceTagCondition(
          ["cdk", "hosted-acceptance"],
          region,
        ),
        Effect: "Allow",
        Resource: accountRegistryArn,
      },
      {
        Action: [
          "agent-registry:GetDiscoverableRegistryRecord",
          "agent-registry:GetRegistryRecord",
        ],
        Condition: registryResourceTagCondition(
          ["cdk", "hosted-acceptance"],
          region,
        ),
        Effect: "Allow",
        Resource: `${accountRegistryArn}/record/*`,
      },
      {
        Action: [
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:ListGatewayTargets",
        ],
        Effect: "Allow",
        Resource: controlPlaneResources.toolsGatewayArn,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
    ],
  };
  const expectedXrayPolicy = xrayWritePolicy();
  expectedXrayPolicy.Statement.unshift({
    Action: gatewaySessionActions(),
    Effect: "Allow",
    Resource: gatewayInvokerRoleArn,
  });
  const domainGetPredecessorPolicy = structuredClone(expectedPolicy);
  domainGetPredecessorPolicy.Statement.find(
    ({ Action }) => Action === "dynamodb:GetItem",
  ).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] =
    domainGetPredecessorPolicy.Statement.find(
      ({ Action }) => Action === "dynamodb:GetItem",
    ).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
      .filter((key) => key !== "DOMAIN");
  const resourceAccessPredecessorPolicy =
    structuredClone(domainGetPredecessorPolicy);
  resourceAccessPredecessorPolicy.Statement =
    resourceAccessPredecessorPolicy.Statement.filter(({ Action }) => {
      const actions = [Action].flat();
      return !actions.includes("agent-registry:ListRegistryRecords")
        && !actions.includes("agent-registry:GetRegistryRecord")
        && !actions.includes("bedrock-agentcore:GetGatewayTarget");
    });
  const predecessorPolicy = structuredClone(resourceAccessPredecessorPolicy);
  predecessorPolicy.Statement.find(
    ({ Action }) => Action === "dynamodb:GetItem",
  ).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] =
    predecessorPolicy.Statement.find(
      ({ Action }) => Action === "dynamodb:GetItem",
    ).Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]
      .filter((key) => key !== "MODEL_POLICY");
  predecessorPolicy.Statement = predecessorPolicy.Statement.filter(
    ({ Action }) => Action !== "dynamodb:Query",
  );
  const applicationPolicy = policies.get(BUILDER_POLICY_NAME);
  const applicationMatches =
    applicationPolicy === canonicalPolicyContent(expectedPolicy);
  const applicationMatchesResourceAccessPredecessor =
    applicationPolicy
    === canonicalPolicyContent(resourceAccessPredecessorPolicy);
  const applicationMatchesDomainGetPredecessor =
    applicationPolicy === canonicalPolicyContent(domainGetPredecessorPolicy);
  const applicationMatchesPredecessor =
    applicationPolicy === canonicalPolicyContent(predecessorPolicy);
  const xrayContent = policies.get(BUILDER_XRAY_POLICY_NAME);
  if (
    applicationMatches
    && xrayContent === canonicalPolicyContent(expectedXrayPolicy)
  ) {
    return "target";
  }
  if (
    allowPlannedTransition
    && applicationMatchesDomainGetPredecessor
    && xrayContent === canonicalPolicyContent(expectedXrayPolicy)
  ) {
    return "domain-get-predecessor";
  }
  if (
    allowPlannedTransition
    && applicationMatchesResourceAccessPredecessor
    && xrayContent === canonicalPolicyContent(expectedXrayPolicy)
  ) {
    return "resource-authorization-predecessor";
  }
  if (
    allowPlannedTransition
    && applicationMatchesPredecessor
    && xrayContent === canonicalPolicyContent(expectedXrayPolicy)
  ) {
    return "builder-read-predecessor";
  }
  if (
    allowPlannedTransition
    && applicationMatches
    && xrayContent === canonicalPolicyContent(xrayWritePolicy())
  ) {
    return "gateway-isolation-predecessor";
  }
  throw new AuditValidationError(
    "Builder role inline policies have drifted.",
    "BUILDER_ROLE_INLINE_POLICY_DRIFT",
  );
}

function inspectJourneyRole({
  agentRuntimeArn,
  agentRuntimeProductionEndpointArn,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  gatewayInvokerRoleArn,
  githubOAuthClientSecretArn,
  inceptionModelArns,
  logGroupArn,
  role,
  runCommand,
  runtimeInvocationProofSecretArn,
  tableArn,
  userPoolArn,
}) {
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "JOURNEY_ROLE",
    cwd,
    expectedPolicyNames: [
      JOURNEY_POLICY_NAME,
      JOURNEY_DEFAULT_POLICY_NAME,
    ],
    expectedTrust: lambdaTrustPolicy(),
    label: "Journey API role",
    role,
    roleName: JOURNEY_ROLE_NAME,
    runCommand,
  });
  const registryArns = [
    controlPlaneResources.sharedRegistryArn,
    controlPlaneResources.platformRegistryArn,
    controlPlaneResources.customerSupportRegistryArn,
    controlPlaneResources.operationsRegistryArn,
  ];
  const baseStatements = [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "DELIVERY#*",
              "DOMAIN",
              "GITHUB_AUTHORIZATION#*",
              "GRANT#*",
              "JOURNEY#*",
              "MODEL_POLICY",
              "MUTATION#*",
              "PROJECT#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["DOMAIN"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MUTATION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["GITHUB_AUTHORIZATION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["DELIVERY#*", "JOURNEY#*"],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:UpdateItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "DELIVERY#*",
              "GITHUB_AUTHORIZATION#*",
              "MUTATION#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
      {
        Action: "agent-registry:ListRegistryRecords",
        Effect: "Allow",
        Resource: registryArns,
      },
      {
        Action: [
          "agent-registry:GetDiscoverableRegistryRecord",
          "agent-registry:GetRegistryRecord",
        ],
        Effect: "Allow",
        Resource: registryArns.map((arn) => `${arn}/record/*`),
      },
      {
        Action: [
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:ListGatewayTargets",
        ],
        Effect: "Allow",
        Resource: controlPlaneResources.toolsGatewayArn,
      },
  ];
  const targetApplicationPolicy = (
    agentRuntimeArn !== null
    && agentRuntimeProductionEndpointArn !== null
    && runtimeInvocationProofSecretArn !== null
  )
    ? {
        Version: "2012-10-17",
        Statement: [
          ...baseStatements,
          {
            Action: "secretsmanager:GetSecretValue",
            Effect: "Allow",
            Resource: githubOAuthClientSecretArn
              ? [
                  githubOAuthClientSecretArn,
                  runtimeInvocationProofSecretArn,
                ]
              : runtimeInvocationProofSecretArn,
          },
          {
            Action: [
              "bedrock-agentcore:InvokeAgentRuntime",
              "bedrock-agentcore:InvokeAgentRuntimeForUser",
            ],
            Effect: "Allow",
            Resource: [
              agentRuntimeArn,
              agentRuntimeProductionEndpointArn,
            ],
          },
        ],
      }
    : null;
  const predecessorApplicationPolicy = {
    Version: "2012-10-17",
    Statement: [
      ...baseStatements,
      {
        Action: "bedrock:InvokeModel",
        Effect: "Allow",
        Resource: inceptionModelArns,
      },
    ],
  };
  const expectedDefaultPolicy = xrayWritePolicy();
  expectedDefaultPolicy.Statement.unshift({
    Action: gatewaySessionActions(),
    Effect: "Allow",
    Resource: gatewayInvokerRoleArn,
  });
  const applicationContent = policies.get(JOURNEY_POLICY_NAME);
  const defaultMatches = policies.get(JOURNEY_DEFAULT_POLICY_NAME)
    === canonicalPolicyContent(expectedDefaultPolicy);
  if (
    targetApplicationPolicy !== null
    && applicationContent === canonicalPolicyContent(targetApplicationPolicy)
    && defaultMatches
  ) {
    return "target";
  }
  if (
    allowPlannedTransition
    && applicationContent
      === canonicalPolicyContent(predecessorApplicationPolicy)
    && defaultMatches
  ) {
    return "agentcore-runtime-predecessor";
  }
  throw new AuditValidationError(
    "Journey API role inline policies have drifted.",
    "JOURNEY_ROLE_INLINE_POLICY_DRIFT",
  );
}

function inspectAgentRuntimeRole({
  accountId,
  allowPlannedTransition,
  cwd,
  gatewayInvokerRoleArn,
  region,
  role,
  runCommand,
  runtimeInvocationProofSecretArn,
  tableArn,
}) {
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "AGENT_RUNTIME_ROLE",
    cwd,
    expectedPolicyNames: [AGENT_RUNTIME_POLICY_NAME],
    expectedTrust: {
      Version: "2012-10-17",
      Statement: [{
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: {
            "aws:SourceAccount": accountId,
          },
          ArnLike: {
            "aws:SourceArn":
              `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:`
              + `${accountId}:runtime/AgenticPlatformRuntime*`,
          },
        },
        Effect: "Allow",
        Principal: {
          Service: "bedrock-agentcore.amazonaws.com",
        },
      }],
    },
    label: "Agent Runtime role",
    role,
    roleName: AGENT_RUNTIME_ROLE_NAME,
    runCommand,
  });
  const predecessorPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "LogGroupAccess",
        Action: ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
        Effect: "Allow",
        Resource:
          `arn:${REQUIRED_PARTITION}:logs:${region}:${accountId}:`
          + "log-group:/aws/bedrock-agentcore/runtimes/*",
      },
      {
        Sid: "DescribeLogGroups",
        Action: "logs:DescribeLogGroups",
        Effect: "Allow",
        Resource:
          `arn:${REQUIRED_PARTITION}:logs:${region}:${accountId}:`
          + "log-group:*",
      },
      {
        Sid: "LogStreamAccess",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource:
          `arn:${REQUIRED_PARTITION}:logs:${region}:${accountId}:`
          + "log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*",
      },
      {
        Sid: "XRayAccess",
        Action: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
        ],
        Effect: "Allow",
        Resource: "*",
      },
      {
        Sid: "CloudWatchMetrics",
        Action: "cloudwatch:PutMetricData",
        Condition: {
          StringEquals: {
            "cloudwatch:namespace": "bedrock-agentcore",
          },
        },
        Effect: "Allow",
        Resource: "*",
      },
      {
        Sid: "GetAgentAccessToken",
        Action: [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        ],
        Effect: "Allow",
        Resource: [
          `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:`
            + `${accountId}:workload-identity-directory/default`,
          `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:`
            + `${accountId}:workload-identity-directory/default/`
            + "workload-identity/*",
        ],
      },
      {
        Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
        Effect: "Allow",
        Resource: [
          `arn:${REQUIRED_PARTITION}:s3:::`
            + `cdk-hnb659fds-assets-${accountId}-${region}`,
          `arn:${REQUIRED_PARTITION}:s3:::`
            + `cdk-hnb659fds-assets-${accountId}-${region}/*`,
        ],
      },
    ],
  };
  const policyContent = policies.get(AGENT_RUNTIME_POLICY_NAME);
  if (runtimeInvocationProofSecretArn !== null) {
    const targetPolicy = structuredClone(predecessorPolicy);
    targetPolicy.Statement.unshift(
      {
        Action: gatewaySessionActions(),
        Effect: "Allow",
        Resource: gatewayInvokerRoleArn,
      },
      {
        Action: "secretsmanager:GetSecretValue",
        Effect: "Allow",
        Resource: runtimeInvocationProofSecretArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["RUNTIME_PROOF#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
    );
    if (policyContent === canonicalPolicyContent(targetPolicy)) {
      return "target";
    }
  }
  if (
    allowPlannedTransition
    && policyContent === canonicalPolicyContent(predecessorPolicy)
  ) {
    return "gateway-isolation-predecessor";
  }
  throw new AuditValidationError(
    "Agent Runtime role inline policy has drifted.",
    "AGENT_RUNTIME_ROLE_INLINE_POLICY_DRIFT",
  );
}

function inspectExperienceRole({
  agentRuntimeArn,
  agentRuntimeProductionEndpointArn,
  allowPlannedTransition,
  cwd,
  logGroupArn,
  role,
  runCommand,
  runtimeInvocationProofSecretArn,
  tableArn,
  userPoolArn,
}) {
  const policies = inspectExactRolePolicyInventory({
    codePrefix: "EXPERIENCE_ROLE",
    cwd,
    expectedPolicyNames: [
      EXPERIENCE_POLICY_NAME,
      EXPERIENCE_XRAY_POLICY_NAME,
    ],
    expectedTrust: lambdaTrustPolicy(),
    label: "Experience role",
    role,
    roleName: EXPERIENCE_ROLE_NAME,
    runCommand,
  });
  const predecessorPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "DEPLOYMENT#*",
              "DOMAIN",
              "ENTITLEMENT#*",
              "MUTATION#*",
              "PROJECT#*",
              "SESSION#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["APPROVAL"],
          },
        },
        Effect: "Allow",
        Resource: `${tableArn}/index/EntityTypeIndex`,
      },
      {
        Action: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["EXPERIENCE_INVOCATION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MUTATION#*", "SUBMISSION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "APPROVAL#*",
              "AUDIT#*",
              "MUTATION#*",
              "SESSION#*",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
      {
        Action: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgentRuntimeForUser",
        ],
        Effect: "Allow",
        Resource: [
          agentRuntimeArn,
          agentRuntimeProductionEndpointArn,
        ],
      },
    ],
  };
  const applicationContent = policies.get(EXPERIENCE_POLICY_NAME);
  const xrayMatches =
    policies.get(EXPERIENCE_XRAY_POLICY_NAME)
      === canonicalPolicyContent(xrayWritePolicy());
  if (runtimeInvocationProofSecretArn !== null) {
    const submissionReplayPredecessorPolicy =
      structuredClone(predecessorPolicy);
    submissionReplayPredecessorPolicy.Statement.splice(-1, 0, {
      Action: "secretsmanager:GetSecretValue",
      Effect: "Allow",
      Resource: runtimeInvocationProofSecretArn,
    });
    const targetPolicy =
      structuredClone(submissionReplayPredecessorPolicy);
    targetPolicy.Statement.splice(
      4,
      1,
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MUTATION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["SUBMISSION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
    );
    if (
      applicationContent === canonicalPolicyContent(targetPolicy)
      && xrayMatches
    ) {
      return "target";
    }
    if (
      allowPlannedTransition
      && applicationContent
        === canonicalPolicyContent(submissionReplayPredecessorPolicy)
      && xrayMatches
    ) {
      return "submission-replay-predecessor";
    }
  }
  if (
    allowPlannedTransition
    && applicationContent === canonicalPolicyContent(predecessorPolicy)
    && xrayMatches
  ) {
    return "gateway-isolation-predecessor";
  }
  throw new AuditValidationError(
    "Experience role inline policies have drifted.",
    "EXPERIENCE_ROLE_INLINE_POLICY_DRIFT",
  );
}

function registryRequestTagCondition(managedBy, region) {
  return {
    "ForAllValues:StringEquals": {
      "aws:TagKeys": ["auto-delete", "managedBy", "project"],
    },
    StringEquals: {
      "aws:RequestTag/auto-delete": "no",
      "aws:RequestTag/managedBy": managedBy,
      "aws:RequestTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": region,
    },
  };
}

function inspectIdentityRole({
  allowPlannedTransition,
  cwd,
  logGroupArn,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(decodePolicyDocument(
      role.AssumeRolePolicyDocument,
    )) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Identity API role trust policy has drifted.",
      "IDENTITY_API_TRUST_DRIFT",
    );
  }
  const attached = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-attached-role-policies", [
      "--role-name", IDENTITY_ROLE_NAME,
    ]),
    "Identity API role attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Identity API role must have no attached policies.",
      "IDENTITY_API_ATTACHED_POLICY_DRIFT",
    );
  }
  const policyList = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-role-policies", [
      "--role-name", IDENTITY_ROLE_NAME,
    ]),
    "Identity API role inline policy listing",
  );
  if (
    !isCompleteIamListResponse(policyList)
    || !Array.isArray(policyList.PolicyNames)
    || policyList.PolicyNames.length !== 2
    || !policyList.PolicyNames.includes(IDENTITY_POLICY_NAME)
    || !policyList.PolicyNames.includes(IDENTITY_XRAY_POLICY_NAME)
  ) {
    throw new AuditValidationError(
      "Identity API role must have exactly the application and X-Ray inline policies.",
      "IDENTITY_API_INLINE_POLICY_LIST_DRIFT",
    );
  }
  const inline = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", IDENTITY_ROLE_NAME,
      "--policy-name", IDENTITY_POLICY_NAME,
    ]),
    "Identity API role inline policy inspection",
  );
  if (
    inline.RoleName !== IDENTITY_ROLE_NAME
    || inline.PolicyName !== IDENTITY_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Identity API role inline policy metadata has drifted.",
      "IDENTITY_API_INLINE_POLICY_METADATA_DRIFT",
    );
  }
  const predecessorPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Effect: "Allow",
      Resource: `${logGroupArn}:*`,
    }],
  };
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      ...predecessorPolicy.Statement,
      {
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:Attributes": [
              "pk",
              "sk",
              "entityType",
              "id",
              "name",
              "status",
            ],
            "dynamodb:LeadingKeys": ["DOMAIN"],
          },
          StringEquals: {
            "dynamodb:Select": "SPECIFIC_ATTRIBUTES",
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
    ],
  };
  const currentTargetPredecessorPolicy = structuredClone(expectedPolicy);
  currentTargetPredecessorPolicy.Statement.pop();
  const policyContent = canonicalPolicyContent(
    decodePolicyDocument(inline.PolicyDocument),
  );
  let acceptedPolicyState;
  if (policyContent === canonicalPolicyContent(expectedPolicy)) {
    acceptedPolicyState = "target";
  } else if (
    allowPlannedTransition
    && (
      policyContent === canonicalPolicyContent(predecessorPolicy)
      || policyContent
        === canonicalPolicyContent(currentTargetPredecessorPolicy)
    )
  ) {
    acceptedPolicyState = "predecessor";
  } else {
    throw new AuditValidationError(
      "Identity API role inline policy has drifted from the exact target.",
      "IDENTITY_API_INLINE_POLICY_DRIFT",
    );
  }
  const xray = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", IDENTITY_ROLE_NAME,
      "--policy-name", IDENTITY_XRAY_POLICY_NAME,
    ]),
    "Identity API role X-Ray policy inspection",
  );
  const expectedXrayPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
      Effect: "Allow",
      Resource: "*",
    }],
  };
  if (
    xray.RoleName !== IDENTITY_ROLE_NAME
    || xray.PolicyName !== IDENTITY_XRAY_POLICY_NAME
    || canonicalPolicyContent(decodePolicyDocument(xray.PolicyDocument))
      !== canonicalPolicyContent(expectedXrayPolicy)
  ) {
    throw new AuditValidationError(
      "Identity API role X-Ray policy has drifted.",
      "IDENTITY_API_XRAY_POLICY_DRIFT",
    );
  }
  return acceptedPolicyState;
}

function inspectWorkspaceRole({
  allowPlannedTransition,
  cwd,
  logGroupArn,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(decodePolicyDocument(
      role.AssumeRolePolicyDocument,
    )) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Workspace API role trust policy has drifted.",
      "WORKSPACE_API_TRUST_DRIFT",
    );
  }

  const attached = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-attached-role-policies", [
      "--role-name", WORKSPACE_ROLE_NAME,
    ]),
    "Workspace API role attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Workspace API role must have no attached policies.",
      "WORKSPACE_API_ATTACHED_POLICY_DRIFT",
    );
  }

  const policyList = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-role-policies", [
      "--role-name", WORKSPACE_ROLE_NAME,
    ]),
    "Workspace API role inline policy listing",
  );
  if (
    !isCompleteIamListResponse(policyList)
    || !Array.isArray(policyList.PolicyNames)
    || policyList.PolicyNames.length !== 2
    || !policyList.PolicyNames.includes(WORKSPACE_POLICY_NAME)
    || !policyList.PolicyNames.includes(WORKSPACE_XRAY_POLICY_NAME)
  ) {
    throw new AuditValidationError(
      "Workspace API role must have exactly the application and X-Ray inline policies.",
      "WORKSPACE_API_INLINE_POLICY_LIST_DRIFT",
    );
  }

  const inline = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", WORKSPACE_ROLE_NAME,
      "--policy-name", WORKSPACE_POLICY_NAME,
    ]),
    "Workspace API role inline policy inspection",
  );
  if (
    inline.RoleName !== WORKSPACE_ROLE_NAME
    || inline.PolicyName !== WORKSPACE_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Workspace API role inline policy metadata has drifted.",
      "WORKSPACE_API_INLINE_POLICY_METADATA_DRIFT",
    );
  }

  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "APPROVAL#*",
              "DEPLOYMENT#*",
              "DOMAIN",
              "GRANT#*",
              "MUTATION#*",
              "PROJECT#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AUDIT#*",
              "MUTATION#*",
              "PROJECT#*",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
    ],
  };
  const beforeProjectResourcePolicy = structuredClone(expectedPolicy);
  beforeProjectResourcePolicy.Statement[1].Condition[
    "ForAllValues:StringLike"
  ]["dynamodb:LeadingKeys"] = beforeProjectResourcePolicy.Statement[1].Condition[
    "ForAllValues:StringLike"
  ]["dynamodb:LeadingKeys"].filter((value) => value !== "GRANT#*");
  const predecessorPolicy = structuredClone(beforeProjectResourcePolicy);
  predecessorPolicy.Statement[1].Condition[
    "ForAllValues:StringLike"
  ]["dynamodb:LeadingKeys"] = predecessorPolicy.Statement[1].Condition[
    "ForAllValues:StringLike"
  ]["dynamodb:LeadingKeys"].filter((value) => value !== "MUTATION#*");
  predecessorPolicy.Statement.splice(2, 1);
  const policyContent = canonicalPolicyContent(
    decodePolicyDocument(inline.PolicyDocument),
  );
  let acceptedPolicyState;
  if (policyContent === canonicalPolicyContent(expectedPolicy)) {
    acceptedPolicyState = "target";
  } else if (
    allowPlannedTransition
    && policyContent === canonicalPolicyContent(beforeProjectResourcePolicy)
  ) {
    acceptedPolicyState = "before-project-resources";
  } else if (
    allowPlannedTransition
    && policyContent === canonicalPolicyContent(predecessorPolicy)
  ) {
    acceptedPolicyState = "read-only";
  } else {
    throw new AuditValidationError(
      "Workspace API role inline policy has drifted from the exact target.",
      "WORKSPACE_API_INLINE_POLICY_DRIFT",
    );
  }

  const xray = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", WORKSPACE_ROLE_NAME,
      "--policy-name", WORKSPACE_XRAY_POLICY_NAME,
    ]),
    "Workspace API role X-Ray policy inspection",
  );
  const expectedXrayPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
      Effect: "Allow",
      Resource: "*",
    }],
  };
  if (
    xray.RoleName !== WORKSPACE_ROLE_NAME
    || xray.PolicyName !== WORKSPACE_XRAY_POLICY_NAME
    || canonicalPolicyContent(decodePolicyDocument(xray.PolicyDocument))
      !== canonicalPolicyContent(expectedXrayPolicy)
  ) {
    throw new AuditValidationError(
      "Workspace API role X-Ray policy has drifted.",
      "WORKSPACE_API_XRAY_POLICY_DRIFT",
    );
  }
  return acceptedPolicyState;
}

function inspectAccessAdminRole({
  cwd,
  logGroupArn,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(decodePolicyDocument(
      role.AssumeRolePolicyDocument,
    )) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Access Admin role trust policy has drifted.",
      "ACCESS_ADMIN_TRUST_DRIFT",
    );
  }

  const attached = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-attached-role-policies", [
      "--role-name", ACCESS_ADMIN_ROLE_NAME,
    ]),
    "Access Admin role attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Access Admin role must have no attached policies.",
      "ACCESS_ADMIN_ATTACHED_POLICY_DRIFT",
    );
  }

  const policyList = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-role-policies", [
      "--role-name", ACCESS_ADMIN_ROLE_NAME,
    ]),
    "Access Admin role inline policy listing",
  );
  if (
    !isCompleteIamListResponse(policyList)
    || !Array.isArray(policyList.PolicyNames)
    || policyList.PolicyNames.length !== 2
    || !policyList.PolicyNames.includes(ACCESS_ADMIN_POLICY_NAME)
    || !policyList.PolicyNames.includes(ACCESS_ADMIN_XRAY_POLICY_NAME)
  ) {
    throw new AuditValidationError(
      "Access Admin role must have exactly the application and X-Ray inline policies.",
      "ACCESS_ADMIN_INLINE_POLICY_LIST_DRIFT",
    );
  }

  const inline = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", ACCESS_ADMIN_ROLE_NAME,
      "--policy-name", ACCESS_ADMIN_POLICY_NAME,
    ]),
    "Access Admin role inline policy inspection",
  );
  if (
    inline.RoleName !== ACCESS_ADMIN_ROLE_NAME
    || inline.PolicyName !== ACCESS_ADMIN_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Access Admin role inline policy metadata has drifted.",
      "ACCESS_ADMIN_INLINE_POLICY_METADATA_DRIFT",
    );
  }

  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "BREAK_GLASS",
              "DOMAIN",
              "MUTATION#*",
              "PROJECT#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MUTATION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["AUDIT#*", "MUTATION#*"],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:UpdateItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["PROJECT#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: [
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:ListUsers",
          "cognito-idp:ListUsersInGroup",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
    ],
  };
  if (
    canonicalPolicyContent(decodePolicyDocument(inline.PolicyDocument))
      !== canonicalPolicyContent(expectedPolicy)
  ) {
    throw new AuditValidationError(
      "Access Admin role inline policy has drifted from the exact target.",
      "ACCESS_ADMIN_INLINE_POLICY_DRIFT",
    );
  }

  const xray = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", ACCESS_ADMIN_ROLE_NAME,
      "--policy-name", ACCESS_ADMIN_XRAY_POLICY_NAME,
    ]),
    "Access Admin role X-Ray policy inspection",
  );
  const expectedXrayPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
      Effect: "Allow",
      Resource: "*",
    }],
  };
  if (
    xray.RoleName !== ACCESS_ADMIN_ROLE_NAME
    || xray.PolicyName !== ACCESS_ADMIN_XRAY_POLICY_NAME
    || canonicalPolicyContent(decodePolicyDocument(xray.PolicyDocument))
      !== canonicalPolicyContent(expectedXrayPolicy)
  ) {
    throw new AuditValidationError(
      "Access Admin role X-Ray policy has drifted.",
      "ACCESS_ADMIN_XRAY_POLICY_DRIFT",
    );
  }
}

function hostedAcceptanceResourceTagCondition(region) {
  return registryResourceTagCondition("hosted-acceptance", region);
}

function registryResourceTagCondition(managedBy, region) {
  return {
    StringEquals: {
      "aws:ResourceTag/auto-delete": "no",
      "aws:ResourceTag/managedBy": managedBy,
      "aws:ResourceTag/project": "agentic-ai-platform-demo",
      "aws:RequestedRegion": region,
    },
  };
}

function inspectGovernanceRole({
  accountId,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  logGroupArn,
  region,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(decodePolicyDocument(
      role.AssumeRolePolicyDocument,
    )) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Governance API role trust policy has drifted.",
      "GOVERNANCE_API_TRUST_DRIFT",
    );
  }

  const attached = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-attached-role-policies", [
      "--role-name", GOVERNANCE_ROLE_NAME,
    ]),
    "Governance API role attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Governance API role must have no attached policies.",
      "GOVERNANCE_API_ATTACHED_POLICY_DRIFT",
    );
  }

  const policyList = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-role-policies", [
      "--role-name", GOVERNANCE_ROLE_NAME,
    ]),
    "Governance API role inline policy listing",
  );
  if (
    !isCompleteIamListResponse(policyList)
    || !Array.isArray(policyList.PolicyNames)
    || policyList.PolicyNames.length !== 2
    || !policyList.PolicyNames.includes(GOVERNANCE_POLICY_NAME)
    || !policyList.PolicyNames.includes(GOVERNANCE_XRAY_POLICY_NAME)
  ) {
    throw new AuditValidationError(
      "Governance API role must have exactly the application and X-Ray inline policies.",
      "GOVERNANCE_API_INLINE_POLICY_LIST_DRIFT",
    );
  }

  const inline = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", GOVERNANCE_ROLE_NAME,
      "--policy-name", GOVERNANCE_POLICY_NAME,
    ]),
    "Governance API role inline policy inspection",
  );
  if (
    inline.RoleName !== GOVERNANCE_ROLE_NAME
    || inline.PolicyName !== GOVERNANCE_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Governance API role inline policy metadata has drifted.",
      "GOVERNANCE_API_INLINE_POLICY_METADATA_DRIFT",
    );
  }

  const registryArns = [
    controlPlaneResources.sharedRegistryArn,
    controlPlaneResources.platformRegistryArn,
    controlPlaneResources.customerSupportRegistryArn,
    controlPlaneResources.operationsRegistryArn,
  ];
  const accountRegistryArn =
    `arn:${REQUIRED_PARTITION}:agent-registry:${region}:${accountId}:`
    + "registry/*";
  const accountRegistryRecordArn = `${accountRegistryArn}/record/*`;
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:Query"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "APPROVAL#*",
              "DEPLOYMENT#*",
              "DOMAIN",
              "ENTITLEMENT#*",
              "GRANT#*",
              "MUTATION#*",
              "PROJECT#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["ENTITLEMENT"],
          },
        },
        Effect: "Allow",
        Resource: `${tableArn}/index/EntityTypeIndex`,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["MUTATION#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "APPROVAL#*",
              "AUDIT#*",
              "ENTITLEMENT#*",
              "GRANT#*",
              "MUTATION#*",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
      {
        Action: "agent-registry:ListRegistryRecords",
        Effect: "Allow",
        Resource: registryArns,
      },
      {
        Action: "agent-registry:GetRegistryRecord",
        Effect: "Allow",
        Resource: registryArns.map((arn) => `${arn}/record/*`),
      },
      {
        Action: [
          "agent-registry:CreateRegistryRecord",
          "agent-registry:TagResource",
        ],
        Condition: registryRequestTagCondition("cdk", region),
        Effect: "Allow",
        Resource: [
          accountRegistryArn,
          accountRegistryRecordArn,
        ],
      },
      {
        Action: [
          "agent-registry:GetRegistryRecord",
          "agent-registry:SubmitRegistryRecordForApproval",
          "agent-registry:UpdateRegistryRecordStatus",
        ],
        Condition: registryResourceTagCondition("cdk", region),
        Effect: "Allow",
        Resource: accountRegistryRecordArn,
      },
      {
        Action: "agent-registry:ListRegistryRecords",
        Condition: registryResourceTagCondition("cdk", region),
        Effect: "Allow",
        Resource: accountRegistryArn,
      },
    ],
  };
  const legacyTransactionPolicy = structuredClone(expectedPolicy);
  legacyTransactionPolicy.Statement.splice(
    3,
    2,
    {
      Action: ["dynamodb:PutItem", "dynamodb:TransactWriteItems"],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "APPROVAL#*",
            "AUDIT#*",
            "ENTITLEMENT#*",
            "GRANT#*",
            "MUTATION#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: tableArn,
    },
  );
  const policyContent = canonicalPolicyContent(
    decodePolicyDocument(inline.PolicyDocument),
  );
  let acceptedPolicyState;
  if (policyContent === canonicalPolicyContent(expectedPolicy)) {
    acceptedPolicyState = "target";
  } else if (
    allowPlannedTransition
    && policyContent === canonicalPolicyContent(legacyTransactionPolicy)
  ) {
    acceptedPolicyState = "legacy-transaction-authorization";
  } else {
    throw new AuditValidationError(
      "Governance API role inline policy has drifted from the exact target.",
      "GOVERNANCE_API_INLINE_POLICY_DRIFT",
    );
  }

  const xray = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", GOVERNANCE_ROLE_NAME,
      "--policy-name", GOVERNANCE_XRAY_POLICY_NAME,
    ]),
    "Governance API role X-Ray policy inspection",
  );
  const expectedXrayPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
      Effect: "Allow",
      Resource: "*",
    }],
  };
  if (
    xray.RoleName !== GOVERNANCE_ROLE_NAME
    || xray.PolicyName !== GOVERNANCE_XRAY_POLICY_NAME
    || canonicalPolicyContent(decodePolicyDocument(xray.PolicyDocument))
      !== canonicalPolicyContent(expectedXrayPolicy)
  ) {
    throw new AuditValidationError(
      "Governance API role X-Ray policy has drifted.",
      "GOVERNANCE_API_XRAY_POLICY_DRIFT",
    );
  }
  return acceptedPolicyState;
}

function inspectControlPlaneReadRole({
  accountId,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  logGroupArn,
  region,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(decodePolicyDocument(
      role.AssumeRolePolicyDocument,
    )) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Control-plane read role trust policy has drifted.",
      "CONTROL_PLANE_READ_TRUST_DRIFT",
    );
  }
  const attached = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-attached-role-policies", [
      "--role-name", CONTROL_PLANE_READ_ROLE_NAME,
    ]),
    "Control-plane read role attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Control-plane read role must have no attached policies.",
      "CONTROL_PLANE_READ_ATTACHED_POLICY_DRIFT",
    );
  }
  const policyList = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "list-role-policies", [
      "--role-name", CONTROL_PLANE_READ_ROLE_NAME,
    ]),
    "Control-plane read role inline policy listing",
  );
  if (
    !isCompleteIamListResponse(policyList)
    || !Array.isArray(policyList.PolicyNames)
    || policyList.PolicyNames.length !== 2
    || !policyList.PolicyNames.includes(CONTROL_PLANE_READ_POLICY_NAME)
    || !policyList.PolicyNames.includes(CONTROL_PLANE_READ_XRAY_POLICY_NAME)
  ) {
    throw new AuditValidationError(
      "Control-plane read role must have exactly the application and X-Ray inline policies.",
      "CONTROL_PLANE_READ_INLINE_POLICY_LIST_DRIFT",
    );
  }
  const inline = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", CONTROL_PLANE_READ_ROLE_NAME,
      "--policy-name", CONTROL_PLANE_READ_POLICY_NAME,
    ]),
    "Control-plane read role inline policy inspection",
  );
  if (
    inline.RoleName !== CONTROL_PLANE_READ_ROLE_NAME
    || inline.PolicyName !== CONTROL_PLANE_READ_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Control-plane read role inline policy metadata has drifted.",
      "CONTROL_PLANE_READ_INLINE_POLICY_METADATA_DRIFT",
    );
  }
  const registryArns = [
    controlPlaneResources.sharedRegistryArn,
    controlPlaneResources.platformRegistryArn,
    controlPlaneResources.customerSupportRegistryArn,
    controlPlaneResources.operationsRegistryArn,
  ];
  const accountRegistryArn =
    `arn:${REQUIRED_PARTITION}:agent-registry:${region}:${accountId}:registry/*`;
  const tagCondition = registryResourceTagCondition(
    ["cdk", "hosted-acceptance"],
    region,
  );
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      { Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Effect: "Allow", Resource: `${logGroupArn}:*` },
      { Action: "agent-registry:ListRegistryRecords", Effect: "Allow", Resource: registryArns },
      { Action: ["agent-registry:GetDiscoverableRegistryRecord", "agent-registry:GetRegistryRecord"], Effect: "Allow", Resource: registryArns.map((arn) => `${arn}/record/*`) },
      { Action: ["dynamodb:GetItem", "dynamodb:Query"], Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["DOMAIN", "MODEL_POLICY"] } }, Effect: "Allow", Resource: tableArn },
      { Action: "agent-registry:ListRegistryRecords", Condition: tagCondition, Effect: "Allow", Resource: accountRegistryArn },
      { Action: ["agent-registry:GetDiscoverableRegistryRecord", "agent-registry:GetRegistryRecord"], Condition: tagCondition, Effect: "Allow", Resource: `${accountRegistryArn}/record/*` },
      { Action: ["bedrock-agentcore:GetGatewayTarget", "bedrock-agentcore:ListGatewayTargets"], Effect: "Allow", Resource: controlPlaneResources.toolsGatewayArn },
      {
        Action: [
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminListGroupsForUser",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
    ],
  };
  const modelPolicyReadPredecessorPolicy = structuredClone(expectedPolicy);
  modelPolicyReadPredecessorPolicy.Statement[3].Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"] = ["DOMAIN"];
  const gatewayIsolationPredecessorPolicy = structuredClone(modelPolicyReadPredecessorPolicy);
  gatewayIsolationPredecessorPolicy.Statement.splice(-1, 0, {
    Action: "bedrock-agentcore:InvokeGateway",
    Effect: "Allow",
    Resource: controlPlaneResources.llmGatewayArn,
  });
  const currentTargetPredecessorPolicy = structuredClone(
    gatewayIsolationPredecessorPolicy,
  );
  currentTargetPredecessorPolicy.Statement.pop();
  const predecessorPolicy = structuredClone(
    gatewayIsolationPredecessorPolicy,
  );
  predecessorPolicy.Statement.pop();
  predecessorPolicy.Statement[1].Action = [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ];
  predecessorPolicy.Statement[2].Action =
    "agent-registry:GetRegistryRecord";
  predecessorPolicy.Statement[4].Action = [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ];
  predecessorPolicy.Statement[5].Action =
    "agent-registry:GetRegistryRecord";
  const batchReadPredecessorPolicy = structuredClone(predecessorPolicy);
  batchReadPredecessorPolicy.Statement[1].Action = [
    "agent-registry:BatchGetDiscoverableRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ];
  batchReadPredecessorPolicy.Statement[4].Action = [
    "agent-registry:BatchGetDiscoverableRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ];
  const policyContent = canonicalPolicyContent(
    decodePolicyDocument(inline.PolicyDocument),
  );
  const xray = parseJsonOutput(
    runAws(runCommand, cwd, "iam", "get-role-policy", [
      "--role-name", CONTROL_PLANE_READ_ROLE_NAME,
      "--policy-name", CONTROL_PLANE_READ_XRAY_POLICY_NAME,
    ]),
    "Control-plane read role X-Ray policy inspection",
  );
  const expectedXrayPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
        Effect: "Allow",
        Resource: "*",
      },
      {
        Action: gatewaySessionActions(),
        Effect: "Allow",
        Resource:
          `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
          + GATEWAY_INVOKER_ROLE_NAME,
      },
    ],
  };
  const gatewayIsolationPredecessorXrayPolicy = {
    Version: "2012-10-17",
    Statement: [expectedXrayPolicy.Statement[0]],
  };
  const xrayContent = canonicalPolicyContent(
    decodePolicyDocument(xray.PolicyDocument),
  );
  if (
    xray.RoleName !== CONTROL_PLANE_READ_ROLE_NAME
    || xray.PolicyName !== CONTROL_PLANE_READ_XRAY_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Control-plane read role X-Ray policy has drifted.",
      "CONTROL_PLANE_READ_XRAY_POLICY_DRIFT",
    );
  }
  if (
    policyContent === canonicalPolicyContent(expectedPolicy)
    && xrayContent === canonicalPolicyContent(expectedXrayPolicy)
  ) {
    return "target";
  }
  if (
    allowPlannedTransition
    && policyContent === canonicalPolicyContent(modelPolicyReadPredecessorPolicy)
    && xrayContent === canonicalPolicyContent(expectedXrayPolicy)
  ) {
    return "predecessor";
  }
  if (
    allowPlannedTransition
    && xrayContent
      === canonicalPolicyContent(gatewayIsolationPredecessorXrayPolicy)
    && (
      policyContent
        === canonicalPolicyContent(gatewayIsolationPredecessorPolicy)
      || policyContent === canonicalPolicyContent(predecessorPolicy)
      || policyContent === canonicalPolicyContent(batchReadPredecessorPolicy)
      || policyContent
        === canonicalPolicyContent(currentTargetPredecessorPolicy)
    )
  ) {
    return "predecessor";
  }
  throw new AuditValidationError(
    "Control-plane read role inline and X-Ray policies have drifted.",
    "CONTROL_PLANE_READ_INLINE_POLICY_DRIFT",
  );
}

function inspectPlatformAdminRole({
  accountId,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  logGroupArn,
  region,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  const trust = decodePolicyDocument(role.AssumeRolePolicyDocument);
  if (
    canonicalPolicyContent(trust)
    !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Platform admin role trust policy has drifted.",
      "PLATFORM_ADMIN_TRUST_DRIFT",
    );
  }

  const attachedDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-attached-role-policies",
      ["--role-name", PLATFORM_ADMIN_ROLE_NAME],
    ),
    "Platform admin role attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attachedDocument)
    || !Array.isArray(attachedDocument.AttachedPolicies)
    || attachedDocument.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Platform admin role must have no attached policies.",
      "PLATFORM_ADMIN_ATTACHED_POLICY_DRIFT",
    );
  }

  const inlineListDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-role-policies",
      ["--role-name", PLATFORM_ADMIN_ROLE_NAME],
    ),
    "Platform admin role inline policy listing",
  );
  if (
    !isCompleteIamListResponse(inlineListDocument)
    || !Array.isArray(inlineListDocument.PolicyNames)
    || inlineListDocument.PolicyNames.length !== 1
    || inlineListDocument.PolicyNames[0] !== PLATFORM_ADMIN_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Platform admin role must have exactly one inline policy.",
      "PLATFORM_ADMIN_INLINE_POLICY_LIST_DRIFT",
    );
  }

  const inlineDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-role-policy",
      [
        "--role-name",
        PLATFORM_ADMIN_ROLE_NAME,
        "--policy-name",
        PLATFORM_ADMIN_POLICY_NAME,
      ],
    ),
    "Platform admin role inline policy inspection",
  );
  if (
    inlineDocument.RoleName !== PLATFORM_ADMIN_ROLE_NAME
    || inlineDocument.PolicyName !== PLATFORM_ADMIN_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Platform admin role inline policy metadata has drifted.",
      "PLATFORM_ADMIN_INLINE_POLICY_METADATA_DRIFT",
    );
  }
  const predecessorTableStatement = {
    Action: [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:TransactWriteItems",
      "dynamodb:UpdateItem",
    ],
    Effect: "Allow",
    Resource: tableArn,
  };
  const predecessorPolicy = logGroupArn === null
    ? null
    : {
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Effect: "Allow",
            Resource: `${logGroupArn}:*`,
          },
          predecessorTableStatement,
          {
            Action: "agent-registry:CreateRegistry",
            Condition: registryRequestTagCondition("cdk", region),
            Effect: "Allow",
            Resource: "*",
          },
          {
            Action: PLATFORM_ADMIN_DOMAIN_GROUP_ACTIONS,
            Effect: "Allow",
            Resource: userPoolArn,
          },
        ],
      };
  const registryArns = [
    controlPlaneResources.sharedRegistryArn,
    controlPlaneResources.platformRegistryArn,
    controlPlaneResources.customerSupportRegistryArn,
    controlPlaneResources.operationsRegistryArn,
  ];
  const accountRegistryArn =
    `arn:${REQUIRED_PARTITION}:agent-registry:${region}:${accountId}:`
    + "registry/*";
  const targetPolicy = predecessorPolicy === null
    ? null
    : {
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Effect: "Allow",
            Resource: `${logGroupArn}:*`,
          },
          {
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Condition: {
              "ForAllValues:StringLike": {
                "dynamodb:LeadingKeys": ["DOMAIN", "REQUEST#*"],
              },
            },
            Effect: "Allow",
            Resource: tableArn,
          },
          {
            Action: "dynamodb:PutItem",
            Condition: {
              "ForAllValues:StringLike": {
                "dynamodb:LeadingKeys": ["REQUEST#*"],
              },
            },
            Effect: "Allow",
            Resource: tableArn,
          },
          {
            Action: "dynamodb:PutItem",
            Condition: {
              "ForAllValues:StringLike": {
                "dynamodb:LeadingKeys": [
                  "DOMAIN",
                  "REGISTRY_RECORD#*",
                  "REQUEST#*",
                ],
              },
              "ForAnyValue:StringEquals": {
                "dynamodb:EnclosingOperation": ["TransactWriteItems"],
              },
            },
            Effect: "Allow",
            Resource: tableArn,
          },
          {
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
            Resource:
              `arn:${REQUIRED_PARTITION}:lambda:${region}:${accountId}:`
              + `function:${REGISTRY_DECISION_FINALIZER_FUNCTION_NAME}`,
          },
          predecessorPolicy.Statement[2],
          {
            Action: "agent-registry:TagResource",
            Condition: registryRequestTagCondition("cdk", region),
            Effect: "Allow",
            Resource: accountRegistryArn,
          },
          {
            Action: "agent-registry:CreateRegistry",
            Condition:
              registryRequestTagCondition("hosted-acceptance", region),
            Effect: "Allow",
            Resource: "*",
          },
          {
            Action: "agent-registry:TagResource",
            Condition:
              registryRequestTagCondition("hosted-acceptance", region),
            Effect: "Allow",
            Resource: accountRegistryArn,
          },
          {
            Action: [
              "bedrock-agentcore:CreateWorkloadIdentity",
              "bedrock-agentcore:DeleteWorkloadIdentity",
            ],
            Condition: {
              StringEquals: {
                "aws:RequestedRegion": region,
              },
            },
            Effect: "Allow",
            Resource:
              `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:`
              + `${accountId}:workload-identity-directory/*`,
          },
          {
            Action: "agent-registry:ListRegistryRecords",
            Effect: "Allow",
            Resource: registryArns,
          },
          {
            Action: [
              "agent-registry:GetDiscoverableRegistryRecord",
              "agent-registry:GetRegistryRecord",
              "agent-registry:UpdateRegistryRecordStatus",
            ],
            Effect: "Allow",
            Resource: registryArns.map((registryArn) =>
              `${registryArn}/record/*`
            ),
          },
          {
            Action: [
              "agent-registry:DeleteRegistry",
              "agent-registry:GetRegistry",
              "agent-registry:ListRegistryRecords",
            ],
            Condition: registryResourceTagCondition(
              ["cdk", "hosted-acceptance"],
              region,
            ),
            Effect: "Allow",
            Resource: accountRegistryArn,
          },
          {
            Action: [
              "agent-registry:GetDiscoverableRegistryRecord",
              "agent-registry:GetRegistryRecord",
              "agent-registry:UpdateRegistryRecordStatus",
            ],
            Condition: registryResourceTagCondition(
              ["cdk", "hosted-acceptance"],
              region,
            ),
            Effect: "Allow",
            Resource: `${accountRegistryArn}/record/*`,
          },
          {
            Action: [
              "cognito-idp:AdminGetUser",
              "cognito-idp:AdminListGroupsForUser",
              ...PLATFORM_ADMIN_DOMAIN_GROUP_ACTIONS,
            ],
            Effect: "Allow",
            Resource: userPoolArn,
          },
        ],
      };
  const discoverableReadPredecessorPolicy = targetPolicy === null
    ? null
    : structuredClone(targetPolicy);
  if (discoverableReadPredecessorPolicy !== null) {
    for (const statement of discoverableReadPredecessorPolicy.Statement) {
      if (
        Array.isArray(statement.Action)
        && statement.Action.includes(
          "agent-registry:UpdateRegistryRecordStatus",
        )
      ) {
        statement.Action = statement.Action.filter(
          (action) =>
            action !== "agent-registry:GetDiscoverableRegistryRecord",
        );
      }
    }
  }
  const currentTargetPredecessorPolicy = targetPolicy === null
    ? null
    : structuredClone(targetPolicy);
  if (currentTargetPredecessorPolicy !== null) {
    const cognitoStatement =
      currentTargetPredecessorPolicy.Statement.find(
        ({ Action, Resource }) =>
          Resource === userPoolArn
          && (Array.isArray(Action) ? Action : [Action]).includes(
            "cognito-idp:CreateGroup",
          ),
      );
    cognitoStatement.Action = cognitoStatement.Action.filter(
      (action) =>
        action !== "cognito-idp:AdminGetUser"
        && action !== "cognito-idp:AdminListGroupsForUser",
    );
  }
  const legacyTransactionPolicy = targetPolicy === null
    ? null
    : structuredClone(targetPolicy);
  legacyTransactionPolicy?.Statement.splice(
    2,
    2,
    {
      Action: [
        "dynamodb:PutItem",
        "dynamodb:TransactWriteItems",
      ],
      Condition: {
        "ForAllValues:StringLike": {
          "dynamodb:LeadingKeys": [
            "DOMAIN",
            "REGISTRY_RECORD#*",
            "REQUEST#*",
          ],
        },
      },
      Effect: "Allow",
      Resource: tableArn,
    },
  );
  const previousTargetPolicy = targetPolicy === null
    ? null
    : structuredClone(targetPolicy);
  if (previousTargetPolicy !== null) {
    const registryLifecycleStatement = previousTargetPolicy.Statement.find(
      ({ Action }) =>
        (Array.isArray(Action) ? Action : [Action]).includes(
          "agent-registry:DeleteRegistry",
        ),
    );
    registryLifecycleStatement.Action =
      registryLifecycleStatement.Action.filter(
        (action) => action !== "agent-registry:GetRegistry",
      );
  }
  const previousWorkloadIdentityPolicy = previousTargetPolicy === null
    ? null
    : structuredClone(previousTargetPolicy);
  if (previousWorkloadIdentityPolicy !== null) {
    const workloadIdentityStatement =
      previousWorkloadIdentityPolicy.Statement.find(
      ({ Action }) =>
        (Array.isArray(Action) ? Action : [Action]).includes(
          "bedrock-agentcore:CreateWorkloadIdentity",
        ),
    );
    workloadIdentityStatement.Resource =
      `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:`
      + `${accountId}:workload-identity-directory/default/`
      + "workload-identity/registry-*";
  }
  const policy = decodePolicyDocument(inlineDocument.PolicyDocument);
  const policyContent = canonicalPolicyContent(policy);
  if (targetPolicy !== null) {
    const targetState = exactPolicyStateWithLegacyLogTransition({
      allowPlannedTransition,
      logGroupArn,
      policyContent,
      targetPolicy,
    });
    if (targetState !== null) {
      return targetState;
    }
  }
  if (
    allowPlannedTransition
    && (
      (
        discoverableReadPredecessorPolicy !== null
        && policyContent
          === canonicalPolicyContent(discoverableReadPredecessorPolicy)
      )
      ||
      (
        currentTargetPredecessorPolicy !== null
        && policyContent
          === canonicalPolicyContent(currentTargetPredecessorPolicy)
      )
      ||
      (
        previousTargetPolicy !== null
        && policyContent === canonicalPolicyContent(previousTargetPolicy)
      )
      || (
        previousWorkloadIdentityPolicy !== null
        && policyContent
          === canonicalPolicyContent(previousWorkloadIdentityPolicy)
      )
      || (
        legacyTransactionPolicy !== null
        && policyContent === canonicalPolicyContent(legacyTransactionPolicy)
      )
    )
  ) {
    return (
      legacyTransactionPolicy !== null
      && policyContent === canonicalPolicyContent(legacyTransactionPolicy)
    )
      ? "legacy-transaction-authorization"
      : "predecessor";
  }
  if (
    allowPlannedTransition
    && predecessorPolicy !== null
    && policyContent === canonicalPolicyContent(predecessorPolicy)
  ) {
    return "predecessor";
  }
  throw new AuditValidationError(
    allowPlannedTransition
      ? (
        "Platform admin role inline policy has drifted from both the "
        + "exact Task 5 target and Task 3 predecessor."
      )
      : "Platform admin role inline policy has drifted from the Task 5 target.",
    "PLATFORM_ADMIN_INLINE_POLICY_DRIFT",
  );
}

function inspectPlatformSeedRole({
  accountId,
  allowPlannedTransition,
  codePrefix,
  cwd,
  label,
  leadingKeys,
  logGroupArn,
  policyName,
  role,
  roleName,
  runCommand,
  tableArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  const trust = decodePolicyDocument(role.AssumeRolePolicyDocument);
  if (
    canonicalPolicyContent(trust)
    !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      `${label} trust policy has drifted.`,
      `${codePrefix}_TRUST_DRIFT`,
    );
  }

  const attachedDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-attached-role-policies",
      ["--role-name", roleName],
    ),
    `${label} attached policy inspection`,
  );
  if (
    !isCompleteIamListResponse(attachedDocument)
    || !Array.isArray(attachedDocument.AttachedPolicies)
    || attachedDocument.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      `${label} must have no attached policies.`,
      `${codePrefix}_ATTACHED_POLICY_DRIFT`,
    );
  }

  const inlineListDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-role-policies",
      ["--role-name", roleName],
    ),
    `${label} inline policy listing`,
  );
  if (
    !isCompleteIamListResponse(inlineListDocument)
    || !Array.isArray(inlineListDocument.PolicyNames)
    || inlineListDocument.PolicyNames.length !== 1
    || inlineListDocument.PolicyNames[0] !== policyName
  ) {
    throw new AuditValidationError(
      `${label} must have exactly one inline policy.`,
      `${codePrefix}_INLINE_POLICY_LIST_DRIFT`,
    );
  }

  const inlineDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-role-policy",
      [
        "--role-name",
        roleName,
        "--policy-name",
        policyName,
      ],
    ),
    `${label} inline policy inspection`,
  );
  if (
    inlineDocument.RoleName !== roleName
    || inlineDocument.PolicyName !== policyName
  ) {
    throw new AuditValidationError(
      `${label} inline policy metadata has drifted.`,
      `${codePrefix}_INLINE_POLICY_METADATA_DRIFT`,
    );
  }
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
        Condition: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": leadingKeys,
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
    ],
  };
  const policy = decodePolicyDocument(inlineDocument.PolicyDocument);
  const matchesTarget = exactPolicyStateWithLegacyLogTransition({
    allowPlannedTransition,
    logGroupArn,
    policyContent: canonicalPolicyContent(policy),
    targetPolicy: expectedPolicy,
  }) !== null;
  const previousPolicy = structuredClone(expectedPolicy);
  previousPolicy.Statement[1].Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"] = ["PROJECT#platform"];
  const matchesReviewedPredecessor = allowPlannedTransition
    && roleName === PLATFORM_WORKSPACE_SEED_ROLE_NAME
    && canonicalPolicyContent(policy) === canonicalPolicyContent(previousPolicy);
  if (!matchesTarget && !matchesReviewedPredecessor) {
    throw new AuditValidationError(
      `${label} inline policy has drifted.`,
      `${codePrefix}_INLINE_POLICY_DRIFT`,
    );
  }
  if (
    role.Arn
    !== `arn:${REQUIRED_PARTITION}:iam::${accountId}:`
      + `role/${roleName}`
  ) {
    throw new AuditValidationError(
      `${label} ARN has drifted.`,
      `${codePrefix}_ROLE_ARN_DRIFT`,
    );
  }
}

function inspectRegistryDecisionFinalizerRole({
  accountId,
  allowPlannedTransition,
  cwd,
  logGroupArn,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(
      decodePolicyDocument(role.AssumeRolePolicyDocument),
    ) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Registry decision finalizer role trust policy has drifted.",
      "REGISTRY_DECISION_FINALIZER_TRUST_DRIFT",
    );
  }
  const attached = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-attached-role-policies",
      ["--role-name", REGISTRY_DECISION_FINALIZER_ROLE_NAME],
    ),
    "Registry decision finalizer attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Registry decision finalizer role must have no attached policies.",
      "REGISTRY_DECISION_FINALIZER_ATTACHED_POLICY_DRIFT",
    );
  }
  const listed = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-role-policies",
      ["--role-name", REGISTRY_DECISION_FINALIZER_ROLE_NAME],
    ),
    "Registry decision finalizer inline policy listing",
  );
  if (
    !isCompleteIamListResponse(listed)
    || !Array.isArray(listed.PolicyNames)
    || listed.PolicyNames.length !== 1
    || listed.PolicyNames[0] !== REGISTRY_DECISION_FINALIZER_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Registry decision finalizer role must have exactly one inline policy.",
      "REGISTRY_DECISION_FINALIZER_INLINE_POLICY_LIST_DRIFT",
    );
  }
  const inline = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-role-policy",
      [
        "--role-name",
        REGISTRY_DECISION_FINALIZER_ROLE_NAME,
        "--policy-name",
        REGISTRY_DECISION_FINALIZER_POLICY_NAME,
      ],
    ),
    "Registry decision finalizer inline policy inspection",
  );
  if (
    inline.RoleName !== REGISTRY_DECISION_FINALIZER_ROLE_NAME
    || inline.PolicyName !== REGISTRY_DECISION_FINALIZER_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Registry decision finalizer inline policy metadata has drifted.",
      "REGISTRY_DECISION_FINALIZER_INLINE_POLICY_METADATA_DRIFT",
    );
  }
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AUDIT#*",
              "REGISTRY_RECORD#*",
              "REQUEST#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AUDIT#*",
              "REGISTRY_RECORD#*",
              "REQUEST#*",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
    ],
  };
  const targetState = exactPolicyStateWithLegacyLogTransition({
    allowPlannedTransition,
    logGroupArn,
    policyContent: canonicalPolicyContent(
      decodePolicyDocument(inline.PolicyDocument),
    ),
    targetPolicy: expectedPolicy,
  });
  const legacyTransactionPolicy = {
    ...expectedPolicy,
    Statement: [
      expectedPolicy.Statement[0],
      {
        Action: [
          "dynamodb:GetItem",
          "dynamodb:TransactWriteItems",
        ],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AUDIT#*",
              "REGISTRY_RECORD#*",
              "REQUEST#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
    ],
  };
  const policyContent = canonicalPolicyContent(
    decodePolicyDocument(inline.PolicyDocument),
  );
  if (
    targetState === null
    && !(
      allowPlannedTransition
      && policyContent === canonicalPolicyContent(legacyTransactionPolicy)
    )
  ) {
    throw new AuditValidationError(
      "Registry decision finalizer inline policy has drifted.",
      "REGISTRY_DECISION_FINALIZER_INLINE_POLICY_DRIFT",
    );
  }
  if (
    role.Arn
    !== `arn:${REQUIRED_PARTITION}:iam::${accountId}:`
      + `role/${REGISTRY_DECISION_FINALIZER_ROLE_NAME}`
  ) {
    throw new AuditValidationError(
      "Registry decision finalizer role ARN has drifted.",
      "REGISTRY_DECISION_FINALIZER_ROLE_ARN_DRIFT",
    );
  }
}

function inspectHostedAcceptanceBrokerRole({
  accountId,
  agentRuntimeArn,
  agentRuntimeProductionEndpointArn,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  logGroupArn,
  region,
  role,
  runCommand,
  tableArn,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(
      decodePolicyDocument(role.AssumeRolePolicyDocument),
    ) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Hosted acceptance broker role trust policy has drifted.",
      "HOSTED_ACCEPTANCE_BROKER_TRUST_DRIFT",
    );
  }

  const attached = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-attached-role-policies",
      ["--role-name", HOSTED_ACCEPTANCE_BROKER_ROLE_NAME],
    ),
    "Hosted acceptance broker attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Hosted acceptance broker role must have no attached policies.",
      "HOSTED_ACCEPTANCE_BROKER_ATTACHED_POLICY_DRIFT",
    );
  }

  const listed = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-role-policies",
      ["--role-name", HOSTED_ACCEPTANCE_BROKER_ROLE_NAME],
    ),
    "Hosted acceptance broker inline policy listing",
  );
  if (
    !isCompleteIamListResponse(listed)
    || !Array.isArray(listed.PolicyNames)
    || listed.PolicyNames.length !== 1
    || listed.PolicyNames[0] !== HOSTED_ACCEPTANCE_BROKER_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Hosted acceptance broker role must have exactly one inline policy.",
      "HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY_LIST_DRIFT",
    );
  }

  const inline = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-role-policy",
      [
        "--role-name",
        HOSTED_ACCEPTANCE_BROKER_ROLE_NAME,
        "--policy-name",
        HOSTED_ACCEPTANCE_BROKER_POLICY_NAME,
      ],
    ),
    "Hosted acceptance broker inline policy inspection",
  );
  if (
    inline.RoleName !== HOSTED_ACCEPTANCE_BROKER_ROLE_NAME
    || inline.PolicyName !== HOSTED_ACCEPTANCE_BROKER_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Hosted acceptance broker inline policy metadata has drifted.",
      "HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY_METADATA_DRIFT",
    );
  }

  const sharedRegistryArn = controlPlaneResources.sharedRegistryArn;
  const sharedRecordArn = `${sharedRegistryArn}/record/*`;
  const accountRegistryArn =
    `arn:${REQUIRED_PARTITION}:agent-registry:${region}:${accountId}:`
    + "registry/*";
  const hostedAcceptanceRegistryWorkloadIdentityArns = [
    `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:${accountId}:`
      + "workload-identity-directory/default",
    `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:${accountId}:`
      + "workload-identity-directory/default/"
      + "workload-identity/registry-*",
  ];
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Effect: "Allow",
        Resource: `${logGroupArn}:*`,
      },
      {
        Action: HOSTED_ACCEPTANCE_BROKER_DOMAIN_GROUP_ACTIONS,
        Effect: "Allow",
        Resource: userPoolArn,
      },
      {
        Action: "agent-registry:ListRegistryRecords",
        Effect: "Allow",
        Resource: sharedRegistryArn,
      },
      {
        Action: "agent-registry:CreateRegistryRecord",
        Condition:
          registryRequestTagCondition("hosted-acceptance", region),
        Effect: "Allow",
        Resource: [sharedRegistryArn, sharedRecordArn],
      },
      {
        Action: "agent-registry:TagResource",
        Condition:
          registryRequestTagCondition("hosted-acceptance", region),
        Effect: "Allow",
        Resource: [sharedRegistryArn, sharedRecordArn],
      },
      {
        Action: [
          "agent-registry:GetRegistryRecord",
          "agent-registry:ListTagsForResource",
        ],
        Effect: "Allow",
        Resource: sharedRecordArn,
      },
      {
        Action: [
          "agent-registry:SubmitRegistryRecordForApproval",
          "agent-registry:DeleteRegistryRecord",
        ],
        Condition: hostedAcceptanceResourceTagCondition(region),
        Effect: "Allow",
        Resource: sharedRecordArn,
      },
      {
        Action: [
          "agent-registry:GetRegistry",
          "agent-registry:ListTagsForResource",
        ],
        Effect: "Allow",
        Resource: accountRegistryArn,
      },
      {
        Action: "agent-registry:DeleteRegistry",
        Condition: hostedAcceptanceResourceTagCondition(region),
        Effect: "Allow",
        Resource: accountRegistryArn,
      },
      {
        Sid: "DeleteHostedAcceptanceRegistryWorkloadIdentity",
        Action: "bedrock-agentcore:DeleteWorkloadIdentity",
        Condition: {
          StringEquals: {
            "aws:RequestedRegion": region,
          },
        },
        Effect: "Allow",
        Resource: hostedAcceptanceRegistryWorkloadIdentityArns,
      },
      {
        Sid: "ReadHostedAcceptanceState",
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#customer_support#hosted-project-*",
              "AGENT#operations#hosted-project-*",
              "APPROVAL#customer_support",
              "APPROVAL#operations",
              "APPROVAL#hosted_acceptance_*",
              "AUDIT#*",
              "DEPLOYMENT#customer_support#hosted-project-*",
              "DEPLOYMENT#operations#hosted-project-*",
              "DELIVERY#*",
              "DOMAIN",
              "ENTITLEMENT#*",
              "EXPERIENCE_INVOCATION#*",
              "HOSTED_ACCEPTANCE",
              "HOSTED_ROLE_SWITCHING",
              "JOURNEY#*",
              "MUTATION#*",
              "PROJECT#customer_support",
              "PROJECT#operations",
              "REQUEST#*",
              "SESSION#*",
              "SUBMISSION#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Sid: "DeleteHostedAcceptanceState",
        Action: "dynamodb:DeleteItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#customer_support#hosted-project-*",
              "AGENT#operations#hosted-project-*",
              "APPROVAL#hosted_acceptance_*",
              "AUDIT#*",
              "DEPLOYMENT#customer_support#hosted-project-*",
              "DEPLOYMENT#operations#hosted-project-*",
              "DOMAIN",
              "ENTITLEMENT#*",
              "EXPERIENCE_INVOCATION#*",
              "HOSTED_ACCEPTANCE",
              "HOSTED_ROLE_SWITCHING",
              "MUTATION#*",
              "REQUEST#*",
              "SESSION#*",
              "SUBMISSION#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Sid: "WriteHostedAcceptanceMappings",
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "HOSTED_ACCEPTANCE",
              "HOSTED_ROLE_SWITCHING",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Sid: "QueryHostedAcceptanceEntitlements",
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["ENTITLEMENT#*"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Sid: "WriteHostedAcceptanceExperienceFixture",
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#customer_support#hosted-project-*",
              "AGENT#operations#hosted-project-*",
              "DEPLOYMENT#customer_support#hosted-project-*",
              "DEPLOYMENT#operations#hosted-project-*",
              "ENTITLEMENT#*",
              "PROJECT#customer_support",
              "PROJECT#operations",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Sid: "DeleteHostedAcceptanceExperienceFixture",
        Action: "dynamodb:DeleteItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#customer_support#hosted-project-*",
              "AGENT#operations#hosted-project-*",
              "APPROVAL#customer_support",
              "APPROVAL#operations",
              "DEPLOYMENT#customer_support#hosted-project-*",
              "DEPLOYMENT#operations#hosted-project-*",
              "ENTITLEMENT#*",
              "PROJECT#customer_support",
              "PROJECT#operations",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Sid: "DeleteHostedAcceptanceAgentBuildingJourneys",
        Action: "dynamodb:DeleteItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "DELIVERY#*",
              "JOURNEY#*",
              "MUTATION#*",
            ],
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableArn,
      },
      {
        Action: "bedrock-agentcore:GetAgentRuntime",
        Effect: "Allow",
        Resource: agentRuntimeArn,
      },
      {
        Action: "bedrock-agentcore:GetAgentRuntimeEndpoint",
        Effect: "Allow",
        Resource: [
          agentRuntimeArn,
          agentRuntimeProductionEndpointArn,
        ],
      },
    ],
  };
  const acceptedPolicyState = exactHostedAcceptanceBrokerPolicyState({
    allowPlannedTransition,
    policyContent: canonicalPolicyContent(
      decodePolicyDocument(inline.PolicyDocument),
    ),
    targetPolicy: expectedPolicy,
  });
  if (acceptedPolicyState === null) {
    throw new AuditValidationError(
      "Hosted acceptance broker role inline policy has drifted.",
      "HOSTED_ACCEPTANCE_BROKER_INLINE_POLICY_DRIFT",
    );
  }
  if (
    role.Arn
    !== `arn:${REQUIRED_PARTITION}:iam::${accountId}:`
      + `role/${HOSTED_ACCEPTANCE_BROKER_ROLE_NAME}`
  ) {
    throw new AuditValidationError(
      "Hosted acceptance broker role ARN has drifted.",
      "HOSTED_ACCEPTANCE_BROKER_ROLE_ARN_DRIFT",
    );
  }
  return acceptedPolicyState;
}

function inspectHostedAcceptanceRole({
  accountId,
  brokerFunctionArn,
  cwd,
  role,
  runCommand,
  userPoolArn,
}) {
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Condition: {
        ArnEquals: {
          "aws:PrincipalArn":
            `arn:${REQUIRED_PARTITION}:iam::${accountId}:`
            + `role/${GITHUB_DEPLOY_ROLE_NAME}`,
        },
      },
      Effect: "Allow",
      Principal: {
        AWS: `arn:${REQUIRED_PARTITION}:iam::${accountId}:root`,
      },
    }],
  };
  if (
    canonicalPolicyContent(
      decodePolicyDocument(role.AssumeRolePolicyDocument),
    ) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Hosted acceptance role trust policy has drifted.",
      "HOSTED_ACCEPTANCE_ROLE_TRUST_DRIFT",
    );
  }

  const attached = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-attached-role-policies",
      ["--role-name", HOSTED_ACCEPTANCE_ROLE_NAME],
    ),
    "Hosted acceptance role attached policy inspection",
  );
  if (
    !isCompleteIamListResponse(attached)
    || !Array.isArray(attached.AttachedPolicies)
    || attached.AttachedPolicies.length !== 0
  ) {
    throw new AuditValidationError(
      "Hosted acceptance role must have no attached policies.",
      "HOSTED_ACCEPTANCE_ROLE_ATTACHED_POLICY_DRIFT",
    );
  }

  const listed = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-role-policies",
      ["--role-name", HOSTED_ACCEPTANCE_ROLE_NAME],
    ),
    "Hosted acceptance role inline policy listing",
  );
  if (
    !isCompleteIamListResponse(listed)
    || !Array.isArray(listed.PolicyNames)
    || listed.PolicyNames.length !== 1
    || listed.PolicyNames[0] !== HOSTED_ACCEPTANCE_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Hosted acceptance role must have exactly one inline policy.",
      "HOSTED_ACCEPTANCE_ROLE_INLINE_POLICY_LIST_DRIFT",
    );
  }

  const inline = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-role-policy",
      [
        "--role-name",
        HOSTED_ACCEPTANCE_ROLE_NAME,
        "--policy-name",
        HOSTED_ACCEPTANCE_POLICY_NAME,
      ],
    ),
    "Hosted acceptance role inline policy inspection",
  );
  if (
    inline.RoleName !== HOSTED_ACCEPTANCE_ROLE_NAME
    || inline.PolicyName !== HOSTED_ACCEPTANCE_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Hosted acceptance role inline policy metadata has drifted.",
      "HOSTED_ACCEPTANCE_ROLE_INLINE_POLICY_METADATA_DRIFT",
    );
  }
  const expectedPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Action: [
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminSetUserPassword",
        ],
        Effect: "Allow",
        Resource: userPoolArn,
      },
      {
        Action: "lambda:InvokeFunction",
        Effect: "Allow",
        Resource: brokerFunctionArn,
      },
    ],
  };
  if (
    canonicalPolicyContent(
      decodePolicyDocument(inline.PolicyDocument),
    ) !== canonicalPolicyContent(expectedPolicy)
  ) {
    throw new AuditValidationError(
      "Hosted acceptance role inline policy has drifted.",
      "HOSTED_ACCEPTANCE_ROLE_INLINE_POLICY_DRIFT",
    );
  }
}

function inspectCloudFrontProviderResources({
  accountId,
  allowPlannedTransition,
  cwd,
  runCommand,
}) {
  const document = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "cloudformation",
      "list-stack-resources",
      ["--stack-name", PLATFORM_WEB_STACK_NAME],
    ),
    "PlatformWebStack resource inspection",
  );
  const stackResources =
    document.StackResourceSummaries ?? document.StackResources;
  if (
    document.NextToken !== undefined
    || !Array.isArray(stackResources)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack resource inspection must return a complete resource array.",
      "INVALID_PLATFORM_WEB_RESOURCES",
    );
  }
  document.StackResources = stackResources;

  for (const resource of document.StackResources) {
    if (
      !resource
      || typeof resource !== "object"
      || Array.isArray(resource)
      || typeof resource.LogicalResourceId !== "string"
      || resource.LogicalResourceId.length === 0
      || typeof resource.PhysicalResourceId !== "string"
      || resource.PhysicalResourceId.length === 0
      || typeof resource.ResourceType !== "string"
      || resource.ResourceType.length === 0
    ) {
      throw new AuditValidationError(
        "PlatformWebStack resource inspection returned a malformed record.",
        "INVALID_PLATFORM_WEB_RESOURCE",
      );
    }
  }

  const stackDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "cloudformation",
      "describe-stacks",
      ["--stack-name", PLATFORM_WEB_STACK_NAME],
    ),
    "PlatformWebStack output inspection",
  );
  if (
    !Array.isArray(stackDocument.Stacks)
    || stackDocument.Stacks.length !== 1
  ) {
    throw new AuditValidationError(
      "PlatformWebStack output inspection must return exactly one stack.",
      "INVALID_PLATFORM_WEB_STACK_COUNT",
    );
  }
  const stack = stackDocument.Stacks[0];
  if (
    !stack
    || typeof stack !== "object"
    || Array.isArray(stack)
    || stack.StackName !== PLATFORM_WEB_STACK_NAME
    || !Array.isArray(stack.Outputs)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack output inspection is malformed.",
      "INVALID_PLATFORM_WEB_STACK_OUTPUTS",
    );
  }
  for (const output of stack.Outputs) {
    if (
      !output
      || typeof output !== "object"
      || Array.isArray(output)
      || typeof output.OutputKey !== "string"
      || output.OutputKey.length === 0
      || typeof output.OutputValue !== "string"
      || output.OutputValue.length === 0
    ) {
      throw new AuditValidationError(
        "PlatformWebStack output inspection returned a malformed output.",
        "INVALID_PLATFORM_WEB_STACK_OUTPUT",
      );
    }
  }

  const runtimeInvocationProofSecrets = document.StackResources.filter(
    ({ ResourceType }) =>
      ResourceType === "AWS::SecretsManager::Secret",
  );
  const runtimeProofConfiguratorFunctions =
    document.StackResources.filter(
      ({ LogicalResourceId, ResourceType }) =>
        ResourceType === "AWS::Lambda::Function"
        && LogicalResourceId.startsWith(
          "RuntimeProofConfiguratorFunction",
        ),
    );
  const runtimeProofConfiguratorLogGroups =
    document.StackResources.filter(
      ({ LogicalResourceId, ResourceType }) =>
        ResourceType === "AWS::Logs::LogGroup"
        && LogicalResourceId.startsWith("RuntimeProofConfiguratorLogs"),
    );
  const runtimeProofProviderLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("RuntimeProofProviderLogs"),
  );
  const runtimeProofResourceCollections = [
    runtimeInvocationProofSecrets,
    runtimeProofConfiguratorFunctions,
    runtimeProofConfiguratorLogGroups,
    runtimeProofProviderLogGroups,
  ];
  const runtimeProofResourcesPresent =
    runtimeProofResourceCollections.every(({ length }) => length === 1);
  const runtimeProofResourcesAbsent =
    runtimeProofResourceCollections.every(({ length }) => length === 0);
  if (
    !runtimeProofResourcesPresent
    && !(allowPlannedTransition && runtimeProofResourcesAbsent)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one complete Runtime proof "
        + "secret, configurator function, configurator log group, and "
        + "provider log group target.",
      "INVALID_RUNTIME_PROOF_RESOURCE_SET",
    );
  }
  const runtimeInvocationProofSecret =
    runtimeInvocationProofSecrets[0] ?? null;
  if (
    runtimeInvocationProofSecret !== null
    && !/^RuntimeInvocationProofSecret[A-F0-9]{8}$/.test(
      runtimeInvocationProofSecret.LogicalResourceId,
    )
  ) {
    throw new AuditValidationError(
      "PlatformWebStack Runtime invocation proof secret logical resource "
        + "is malformed.",
      "INVALID_RUNTIME_INVOCATION_PROOF_SECRET_LOGICAL_ID",
    );
  }
  const runtimeInvocationProofSecretArn =
    runtimeInvocationProofSecret?.PhysicalResourceId ?? null;
  const runtimeInvocationProofSecretArnPattern = new RegExp(
    `^arn:${REQUIRED_PARTITION}:secretsmanager:${REQUIRED_REGION}:`
      + `${accountId}:secret:`
      + "RuntimeInvocationProofSecre-"
      + "[A-Za-z0-9]{12}-[A-Za-z0-9]{6}$",
  );
  if (
    runtimeInvocationProofSecretArn !== null
    && !runtimeInvocationProofSecretArnPattern.test(
      runtimeInvocationProofSecretArn,
    )
  ) {
    throw new AuditValidationError(
      "PlatformWebStack Runtime invocation proof secret physical ARN/name "
        + "is malformed.",
      "INVALID_RUNTIME_INVOCATION_PROOF_SECRET_ARN",
    );
  }
  const runtimeProofConfiguratorFunction =
    runtimeProofConfiguratorFunctions[0] ?? null;
  if (
    runtimeProofConfiguratorFunction !== null
    && !/^RuntimeProofConfiguratorFunction[A-F0-9]{8}$/.test(
      runtimeProofConfiguratorFunction.LogicalResourceId,
    )
  ) {
    throw new AuditValidationError(
      "PlatformWebStack Runtime proof configurator function logical "
        + "resource is malformed.",
      "INVALID_RUNTIME_PROOF_CONFIGURATOR_FUNCTION_LOGICAL_ID",
    );
  }
  const runtimeProofConfiguratorFunctionName =
    runtimeProofConfiguratorFunction?.PhysicalResourceId ?? null;
  if (
    runtimeProofConfiguratorFunctionName !== null
    && runtimeProofConfiguratorFunctionName
      !== RUNTIME_PROOF_CONFIGURATOR_FUNCTION_NAME
  ) {
    throw new AuditValidationError(
      "PlatformWebStack Runtime proof configurator function name is malformed.",
      "INVALID_RUNTIME_PROOF_CONFIGURATOR_FUNCTION_NAME",
    );
  }
  const runtimeProofConfiguratorFunctionArn =
    runtimeProofConfiguratorFunctionName === null
      ? null
      : (
        `arn:${REQUIRED_PARTITION}:lambda:${REQUIRED_REGION}:${accountId}:`
        + `function:${runtimeProofConfiguratorFunctionName}`
      );
  const validateRuntimeProofLogGroup = (
    resource,
    logicalIdPattern,
    label,
    codePrefix,
  ) => {
    if (resource === null) {
      return null;
    }
    if (!logicalIdPattern.test(resource.LogicalResourceId)) {
      throw new AuditValidationError(
        `PlatformWebStack ${label} logical resource is malformed.`,
        `${codePrefix}_LOGICAL_ID`,
      );
    }
    const logGroupName = resource.PhysicalResourceId;
    if (
      logGroupName.length > 512
      || !/^[A-Za-z0-9._/#-]+$/.test(logGroupName)
    ) {
      throw new AuditValidationError(
        `PlatformWebStack ${label} name is malformed.`,
        `${codePrefix}_NAME`,
      );
    }
    return (
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${logGroupName}`
    );
  };
  const runtimeProofConfiguratorLogGroupArn =
    validateRuntimeProofLogGroup(
      runtimeProofConfiguratorLogGroups[0] ?? null,
      /^RuntimeProofConfiguratorLogs[A-F0-9]{8}$/,
      "Runtime proof configurator log group",
      "INVALID_RUNTIME_PROOF_CONFIGURATOR_LOG_GROUP",
    );
  const runtimeProofProviderLogGroupArn =
    validateRuntimeProofLogGroup(
      runtimeProofProviderLogGroups[0] ?? null,
      /^RuntimeProofProviderLogs[A-F0-9]{8}$/,
      "Runtime proof provider log group",
      "INVALID_RUNTIME_PROOF_PROVIDER_LOG_GROUP",
    );

  const distributions = document.StackResources.filter(
    ({ ResourceType }) =>
      ResourceType === "AWS::CloudFront::Distribution",
  );
  if (distributions.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one CloudFront distribution.",
      "INVALID_CLOUDFRONT_DISTRIBUTION_COUNT",
    );
  }
  const distributionId = distributions[0].PhysicalResourceId;
  if (!/^[A-Z0-9]+$/.test(distributionId)) {
    throw new AuditValidationError(
      "PlatformWebStack CloudFront distribution ID is malformed.",
      "INVALID_CLOUDFRONT_DISTRIBUTION_ID",
    );
  }

  const alarms = document.StackResources.filter(
    ({ ResourceType }) => ResourceType === "Custom::CloudFrontAlarm",
  );
  if (alarms.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one CloudFront alarm provider resource.",
      "INVALID_CLOUDFRONT_ALARM_COUNT",
    );
  }
  const expectedAlarmName =
    `${CLOUDFRONT_ALARM_NAME_PREFIX}${distributionId}`
    + CLOUDFRONT_ALARM_NAME_SUFFIX;
  if (alarms[0].PhysicalResourceId !== expectedAlarmName) {
    throw new AuditValidationError(
      "PlatformWebStack CloudFront alarm name does not match its distribution.",
      "CLOUDFRONT_ALARM_NAME_MISMATCH",
    );
  }

  const platformStateTables = document.StackResources.filter(
    ({ ResourceType }) => ResourceType === "AWS::DynamoDB::Table",
  );
  if (platformStateTables.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one platform state table.",
      "INVALID_PLATFORM_STATE_TABLE_COUNT",
    );
  }
  const platformStateTableName =
    platformStateTables[0]?.PhysicalResourceId ?? null;
  if (
    platformStateTableName !== null
    && !/^[A-Za-z0-9_.-]{3,255}$/.test(platformStateTableName)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack platform state table name is malformed.",
      "INVALID_PLATFORM_STATE_TABLE_NAME",
    );
  }
  const seedLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("PlatformStateSeedLogs"),
  );
  if (seedLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one platform state seed log group.",
      "INVALID_PLATFORM_STATE_SEED_LOG_GROUP_COUNT",
    );
  }
  const seedLogGroupName = seedLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    seedLogGroupName !== null
    && (
      seedLogGroupName.length > 512
      || !/^[A-Za-z0-9._/#-]+$/.test(seedLogGroupName)
    )
  ) {
    throw new AuditValidationError(
      "Platform state seed log group name is malformed.",
      "INVALID_PLATFORM_STATE_SEED_LOG_GROUP_NAME",
    );
  }
  const identityLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("IdentityApiLogs"),
  );
  if (identityLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Identity API log group.",
      "INVALID_IDENTITY_API_LOG_GROUP_COUNT",
    );
  }
  const identityLogGroupName =
    identityLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    identityLogGroupName === null
    || identityLogGroupName.length > 512
    || !/^[A-Za-z0-9._/#-]+$/.test(identityLogGroupName)
  ) {
    throw new AuditValidationError(
      "Identity API log group name is malformed.",
      "INVALID_IDENTITY_API_LOG_GROUP_NAME",
    );
  }
  const governanceLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("GovernanceApiLogs"),
  );
  if (governanceLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Governance API log group.",
      "INVALID_GOVERNANCE_API_LOG_GROUP_COUNT",
    );
  }
  const governanceLogGroupName =
    governanceLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    governanceLogGroupName === null
    || governanceLogGroupName.length > 512
    || !/^[A-Za-z0-9._/#-]+$/.test(governanceLogGroupName)
  ) {
    throw new AuditValidationError(
      "Governance API log group name is malformed.",
      "INVALID_GOVERNANCE_API_LOG_GROUP_NAME",
    );
  }
  const modelGovernanceLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("ModelGovernanceApiLogs"),
  );
  if (
    modelGovernanceLogGroups.length > 1
    || (
      modelGovernanceLogGroups.length === 0
      && !allowPlannedTransition
    )
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Model Governance API "
        + "log group.",
      "INVALID_MODEL_GOVERNANCE_LOG_GROUP_COUNT",
    );
  }
  const modelGovernanceLogGroupName =
    modelGovernanceLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    modelGovernanceLogGroupName !== null
    && (
      modelGovernanceLogGroupName.length > 512
      || !/^[A-Za-z0-9._/#-]+$/.test(modelGovernanceLogGroupName)
    )
  ) {
    throw new AuditValidationError(
      "Model Governance API log group name is malformed.",
      "INVALID_MODEL_GOVERNANCE_LOG_GROUP_NAME",
    );
  }
  const builderLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("BuilderApiLogs"),
  );
  if (builderLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Builder API log group.",
      "INVALID_BUILDER_API_LOG_GROUP_COUNT",
    );
  }
  const builderLogGroupName = builderLogGroups[0].PhysicalResourceId;
  if (
    builderLogGroupName.length > 512
    || !/^[A-Za-z0-9._/#-]+$/.test(builderLogGroupName)
  ) {
    throw new AuditValidationError(
      "Builder API log group name is malformed.",
      "INVALID_BUILDER_API_LOG_GROUP_NAME",
    );
  }
  const journeyLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("JourneyApiLogs"),
  );
  if (journeyLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Journey API log group.",
      "INVALID_JOURNEY_API_LOG_GROUP_COUNT",
    );
  }
  const journeyLogGroupName = journeyLogGroups[0].PhysicalResourceId;
  if (
    journeyLogGroupName.length > 512
    || !/^[A-Za-z0-9._/#-]+$/.test(journeyLogGroupName)
  ) {
    throw new AuditValidationError(
      "Journey API log group name is malformed.",
      "INVALID_JOURNEY_API_LOG_GROUP_NAME",
    );
  }
  const experienceLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("ExperienceApiLogs"),
  );
  if (experienceLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Experience API log group.",
      "INVALID_EXPERIENCE_API_LOG_GROUP_COUNT",
    );
  }
  const experienceLogGroupName =
    experienceLogGroups[0].PhysicalResourceId;
  if (
    experienceLogGroupName.length > 512
    || !/^[A-Za-z0-9._/#-]+$/.test(experienceLogGroupName)
  ) {
    throw new AuditValidationError(
      "Experience API log group name is malformed.",
      "INVALID_EXPERIENCE_API_LOG_GROUP_NAME",
    );
  }
  const workspaceLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("WorkspaceApiLogs"),
  );
  if (workspaceLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Workspace API log group.",
      "INVALID_WORKSPACE_API_LOG_GROUP_COUNT",
    );
  }
  const workspaceLogGroupName =
    workspaceLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    workspaceLogGroupName === null
    || workspaceLogGroupName.length > 512
    || !/^[A-Za-z0-9._/#-]+$/.test(workspaceLogGroupName)
  ) {
    throw new AuditValidationError(
      "Workspace API log group name is malformed.",
      "INVALID_WORKSPACE_API_LOG_GROUP_NAME",
    );
  }
  const accessAdminLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("AccessAdminApiLogs"),
  );
  if (
    accessAdminLogGroups.length > 1
    || (
      accessAdminLogGroups.length === 0
      && !allowPlannedTransition
    )
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Access Admin API log group.",
      "INVALID_ACCESS_ADMIN_LOG_GROUP_COUNT",
    );
  }
  const accessAdminLogGroupName =
    accessAdminLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    accessAdminLogGroupName !== null
    && (
      accessAdminLogGroupName.length > 512
      || !/^[A-Za-z0-9._/#-]+$/.test(accessAdminLogGroupName)
    )
  ) {
    throw new AuditValidationError(
      "Access Admin API log group name is malformed.",
      "INVALID_ACCESS_ADMIN_LOG_GROUP_NAME",
    );
  }
  const controlPlaneReadLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("ControlPlaneReadApiLogs"),
  );
  if (controlPlaneReadLogGroups.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one control-plane read log group.",
      "INVALID_CONTROL_PLANE_READ_LOG_GROUP_COUNT",
    );
  }
  const controlPlaneReadLogGroupName =
    controlPlaneReadLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    controlPlaneReadLogGroupName === null
    || controlPlaneReadLogGroupName.length > 512
    || !/^[A-Za-z0-9._/#-]+$/.test(controlPlaneReadLogGroupName)
  ) {
    throw new AuditValidationError(
      "Control-plane read log group name is malformed.",
      "INVALID_CONTROL_PLANE_READ_LOG_GROUP_NAME",
    );
  }
  const adminLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("PlatformAdminApiLogs"),
  );
  if (
    adminLogGroups.length > 1
    || (adminLogGroups.length === 0 && !allowPlannedTransition)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one platform admin log group.",
      "INVALID_PLATFORM_ADMIN_LOG_GROUP_COUNT",
    );
  }
  const adminLogGroupName =
    adminLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    adminLogGroupName !== null
    && (
      adminLogGroupName.length > 512
      || !/^[A-Za-z0-9._/#-]+$/.test(adminLogGroupName)
    )
  ) {
    throw new AuditValidationError(
      "Platform admin log group name is malformed.",
      "INVALID_PLATFORM_ADMIN_LOG_GROUP_NAME",
    );
  }
  const finalizerLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("RegistryDecisionFinalizerLogs"),
  );
  if (
    finalizerLogGroups.length > 1
    || (finalizerLogGroups.length === 0 && !allowPlannedTransition)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Registry decision finalizer log group.",
      "INVALID_REGISTRY_DECISION_FINALIZER_LOG_GROUP_COUNT",
    );
  }
  const finalizerLogGroupName =
    finalizerLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    finalizerLogGroupName !== null
    && (
      finalizerLogGroupName.length > 512
      || !/^[A-Za-z0-9._/#-]+$/.test(finalizerLogGroupName)
    )
  ) {
    throw new AuditValidationError(
      "Registry decision finalizer log group name is malformed.",
      "INVALID_REGISTRY_DECISION_FINALIZER_LOG_GROUP_NAME",
    );
  }
  const brokerLogGroups = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Logs::LogGroup"
      && LogicalResourceId.startsWith("HostedAcceptanceBrokerLogs"),
  );
  if (
    brokerLogGroups.length > 1
    || (brokerLogGroups.length === 0 && !allowPlannedTransition)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one hosted acceptance broker log group.",
      "INVALID_HOSTED_ACCEPTANCE_BROKER_LOG_GROUP_COUNT",
    );
  }
  const brokerLogGroupName =
    brokerLogGroups[0]?.PhysicalResourceId ?? null;
  if (
    brokerLogGroupName !== null
    && (
      brokerLogGroupName.length > 512
      || !/^[A-Za-z0-9._/#-]+$/.test(brokerLogGroupName)
    )
  ) {
    throw new AuditValidationError(
      "Hosted acceptance broker log group name is malformed.",
      "INVALID_HOSTED_ACCEPTANCE_BROKER_LOG_GROUP_NAME",
    );
  }

  const userPools = document.StackResources.filter(
    ({ ResourceType }) => ResourceType === "AWS::Cognito::UserPool",
  );
  if (userPools.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one Cognito user pool.",
      "INVALID_HOSTED_ACCEPTANCE_USER_POOL_COUNT",
    );
  }
  const userPoolId = userPools[0].PhysicalResourceId;
  if (!new RegExp(`^${REQUIRED_REGION}_[A-Za-z0-9]+$`).test(userPoolId)) {
    throw new AuditValidationError(
      "PlatformWebStack Cognito user pool ID is malformed.",
      "INVALID_HOSTED_ACCEPTANCE_USER_POOL_ID",
    );
  }
  const userPoolOutputs = stack.Outputs.filter(
    ({ OutputKey }) => OutputKey === "UserPoolId",
  );
  if (userPoolOutputs.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one UserPoolId output.",
      "INVALID_HOSTED_ACCEPTANCE_USER_POOL_OUTPUT_COUNT",
    );
  }
  if (userPoolOutputs[0].OutputValue !== userPoolId) {
    throw new AuditValidationError(
      "PlatformWebStack UserPoolId output does not match its user pool.",
      "HOSTED_ACCEPTANCE_USER_POOL_OUTPUT_MISMATCH",
    );
  }
  const userPoolArn =
    `arn:${REQUIRED_PARTITION}:cognito-idp:${REQUIRED_REGION}:${accountId}:`
    + `userpool/${userPoolId}`;

  const brokerFunctions = document.StackResources.filter(
    ({ LogicalResourceId, ResourceType }) =>
      ResourceType === "AWS::Lambda::Function"
      && LogicalResourceId.startsWith("HostedAcceptanceBrokerFunction"),
  );
  if (
    brokerFunctions.length > 1
    || (brokerFunctions.length === 0 && !allowPlannedTransition)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one hosted acceptance broker function.",
      "INVALID_HOSTED_ACCEPTANCE_BROKER_FUNCTION_COUNT",
    );
  }
  const brokerFunctionName =
    brokerFunctions[0]?.PhysicalResourceId ?? null;
  if (
    brokerFunctionName !== null
    && brokerFunctionName !== HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME
  ) {
    throw new AuditValidationError(
      "PlatformWebStack hosted acceptance broker function name is malformed.",
      "INVALID_HOSTED_ACCEPTANCE_BROKER_FUNCTION_NAME",
    );
  }
  const brokerFunctionOutputs = stack.Outputs.filter(
    ({ OutputKey }) =>
      OutputKey === "HostedAcceptanceBrokerFunctionArn",
  );
  if (
    brokerFunctionOutputs.length
      !== (brokerFunctionName === null ? 0 : 1)
  ) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one broker function ARN output when the broker exists.",
      "INVALID_HOSTED_ACCEPTANCE_BROKER_FUNCTION_OUTPUT_COUNT",
    );
  }
  const hostedAcceptanceBrokerFunctionArn =
    brokerFunctionName === null
      ? null
      : (
        `arn:${REQUIRED_PARTITION}:lambda:${REQUIRED_REGION}:${accountId}:`
        + `function:${brokerFunctionName}`
      );
  if (
    hostedAcceptanceBrokerFunctionArn !== null
    && brokerFunctionOutputs[0].OutputValue
      !== hostedAcceptanceBrokerFunctionArn
  ) {
    throw new AuditValidationError(
      "PlatformWebStack broker function ARN output does not match its function.",
      "HOSTED_ACCEPTANCE_BROKER_FUNCTION_OUTPUT_MISMATCH",
    );
  }

  const agentRuntimes = document.StackResources.filter(
    ({ ResourceType }) =>
      ResourceType === "AWS::BedrockAgentCore::Runtime",
  );
  if (agentRuntimes.length !== 1) {
    throw new AuditValidationError(
      "PlatformWebStack must contain exactly one governed AgentCore Runtime.",
      "INVALID_AGENT_RUNTIME_COUNT",
    );
  }
  const agentRuntimeId = agentRuntimes[0].PhysicalResourceId;
  if (!/^AgenticPlatformRuntime-[A-Za-z0-9]{10}$/.test(agentRuntimeId)) {
    throw new AuditValidationError(
      "PlatformWebStack governed AgentCore Runtime ID is malformed.",
      "INVALID_AGENT_RUNTIME_ID",
    );
  }
  const agentRuntimeArn =
    `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${REQUIRED_REGION}:`
    + `${accountId}:runtime/${agentRuntimeId}`;
  const expectedEndpointArns = new Set([
    `${agentRuntimeArn}/runtime-endpoint/Production`,
    `${agentRuntimeArn}/runtime-endpoint/Sandbox`,
  ]);
  const agentRuntimeEndpoints = document.StackResources.filter(
    ({ ResourceType }) =>
      ResourceType === "AWS::BedrockAgentCore::RuntimeEndpoint",
  );
  if (
    agentRuntimeEndpoints.length !== expectedEndpointArns.size
    || new Set(
      agentRuntimeEndpoints.map(({ PhysicalResourceId }) =>
        PhysicalResourceId
      ),
    ).size !== expectedEndpointArns.size
    || agentRuntimeEndpoints.some(({ PhysicalResourceId }) =>
      !expectedEndpointArns.has(PhysicalResourceId)
    )
  ) {
    throw new AuditValidationError(
      "PlatformWebStack governed AgentCore Runtime endpoints are invalid.",
      "INVALID_AGENT_RUNTIME_ENDPOINTS",
    );
  }
  const agentRuntimeProductionEndpointArn =
    `${agentRuntimeArn}/runtime-endpoint/Production`;

  const ttlDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "dynamodb",
      "describe-time-to-live",
      ["--table-name", platformStateTableName],
    ),
    "Platform state table time to live inspection",
  );
  const ttl = ttlDocument.TimeToLiveDescription;
  if (!ttl || typeof ttl !== "object" || Array.isArray(ttl)) {
    throw new AuditValidationError(
      "Platform state table time to live inspection is malformed.",
      "INVALID_PLATFORM_STATE_TTL",
    );
  }
  if (
    ttl.TimeToLiveStatus !== "ENABLED"
    || ttl.AttributeName !== PLATFORM_STATE_TTL_ATTRIBUTE
  ) {
    throw new AuditValidationError(
      "Platform state table time to live must be enabled on expiresAt.",
      "PLATFORM_STATE_TTL_DRIFT",
    );
  }

  return {
    accessAdminLogGroupArn:
      accessAdminLogGroupName === null
        ? null
        : (
          `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
          + `log-group:${accessAdminLogGroupName}`
        ),
    agentRuntimeArn,
    agentRuntimeProductionEndpointArn,
    alarmArnPattern:
      `arn:${REQUIRED_PARTITION}:cloudwatch:us-east-1:${accountId}:`
      + `alarm:${CLOUDFRONT_ALARM_NAME_PATTERN}`,
    distributionArn:
      `arn:${REQUIRED_PARTITION}:cloudfront::${accountId}:`
      + `distribution/${distributionId}`,
    controlPlaneReadLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${controlPlaneReadLogGroupName}`,
    builderLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${builderLogGroupName}`,
    journeyLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${journeyLogGroupName}`,
    experienceLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${experienceLogGroupName}`,
    governanceLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${governanceLogGroupName}`,
    hostedAcceptanceBrokerLogGroupArn:
      brokerLogGroupName === null
        ? null
        : (
          `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
          + `log-group:${brokerLogGroupName}`
        ),
    hostedAcceptanceBrokerFunctionArn,
    identityLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${identityLogGroupName}`,
    modelGovernanceLogGroupArn:
      modelGovernanceLogGroupName === null
        ? null
        : (
          `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
          + `log-group:${modelGovernanceLogGroupName}`
        ),
    platformAdminLogGroupArn: adminLogGroupName === null
      ? null
      : (
        `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
        + `log-group:${adminLogGroupName}`
      ),
    registryDecisionFinalizerLogGroupArn:
      finalizerLogGroupName === null
        ? null
        : (
          `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
          + `log-group:${finalizerLogGroupName}`
        ),
    runtimeProofConfiguratorFunctionArn,
    runtimeProofConfiguratorLogGroupArn,
    runtimeProofProviderLogGroupArn,
    runtimeInvocationProofSecretArn,
    platformStateTableArn:
      `arn:${REQUIRED_PARTITION}:dynamodb:${REQUIRED_REGION}:${accountId}:`
      + `table/${platformStateTableName}`,
    platformStateTableStatus: "present",
    platformStateSeedLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${seedLogGroupName}`,
    platformStateTimeToLiveStatus: "enabled",
    userPoolArn,
    workspaceLogGroupArn:
      `arn:${REQUIRED_PARTITION}:logs:${REQUIRED_REGION}:${accountId}:`
      + `log-group:${workspaceLogGroupName}`,
  };
}

function renderRuntimeBoundaryTemplate(value, {
  accountId,
  alarmArnPattern,
  boundaryArn,
  controlPlaneResources,
  distributionArn,
  gatewayInvokerRoleArn,
  journeyGithubOAuthClientSecretArn,
  platformStateTableArn,
  region,
  runtimeProofConfiguratorRoleArn,
  runtimeInvocationProofSecretArn,
  userPoolArn,
}) {
  if (typeof value === "string") {
    return value
      .replaceAll("${ACCOUNT}", accountId)
      .replaceAll(
        "${AGENT_RUNTIME_ARN}",
        `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:${accountId}:`
          + "runtime/AgenticPlatformRuntime-*",
      )
      .replaceAll(
        "${AGENT_RUNTIME_ENDPOINT_ARN_PATTERN}",
        `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:${accountId}:`
          + "runtime/AgenticPlatformRuntime-*/runtime-endpoint/*",
      )
      .replaceAll("${CLOUDFRONT_ALARM_ARN_PATTERN}", alarmArnPattern)
      .replaceAll("${CLOUDFRONT_DISTRIBUTION_ARN}", distributionArn)
      .replaceAll("${GATEWAY_INVOKER_ROLE_ARN}", gatewayInvokerRoleArn)
      .replaceAll(
        "${JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN}",
        journeyGithubOAuthClientSecretArn ?? "",
      )
      .replaceAll(
        "${CUSTOMER_SUPPORT_REGISTRY_ARN}",
        controlPlaneResources.customerSupportRegistryArn,
      )
      .replaceAll("${LLM_GATEWAY_ARN}", controlPlaneResources.llmGatewayArn)
      .replaceAll(
        "${OPERATIONS_REGISTRY_ARN}",
        controlPlaneResources.operationsRegistryArn,
      )
      .replaceAll("${PARTITION}", REQUIRED_PARTITION)
      .replaceAll("${PLATFORM_STATE_TABLE_ARN}", platformStateTableArn)
      .replaceAll(
        "${REGISTRY_DECISION_FINALIZER_FUNCTION_ARN}",
        `arn:${REQUIRED_PARTITION}:lambda:${region}:${accountId}:`
          + `function:${REGISTRY_DECISION_FINALIZER_FUNCTION_NAME}`,
      )
      .replaceAll(
        "${PLATFORM_REGISTRY_ARN}",
        controlPlaneResources.platformRegistryArn,
      )
      .replaceAll("${QUALIFIER}", CDK_BOOTSTRAP_QUALIFIER)
      .replaceAll("${REGION}", region)
      .replaceAll(
        "${RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN}",
        `arn:${REQUIRED_PARTITION}:lambda:${region}:${accountId}:`
          + `function:${RUNTIME_PROOF_CONFIGURATOR_FUNCTION_NAME}`,
      )
      .replaceAll(
        "${RUNTIME_INVOCATION_PROOF_SECRET_ARN}",
        runtimeInvocationProofSecretArn,
      )
      .replaceAll(
        "${RUNTIME_PROOF_CONFIGURATOR_ROLE_ARN}",
        runtimeProofConfiguratorRoleArn,
      )
      .replaceAll(
        "${SHARED_REGISTRY_ARN}",
        controlPlaneResources.sharedRegistryArn,
      )
      .replaceAll(
        "${TOOLS_GATEWAY_ARN}",
        controlPlaneResources.toolsGatewayArn,
      )
      .replaceAll("${RUNTIME_PERMISSIONS_BOUNDARY_ARN}", boundaryArn)
      .replaceAll("${USER_POOL_ARN}", userPoolArn);
  }
  if (Array.isArray(value)) {
    return value.map((child) =>
      renderRuntimeBoundaryTemplate(child, {
        accountId,
        alarmArnPattern,
        boundaryArn,
        controlPlaneResources,
        distributionArn,
        gatewayInvokerRoleArn,
        journeyGithubOAuthClientSecretArn,
        platformStateTableArn,
        region,
        runtimeProofConfiguratorRoleArn,
        runtimeInvocationProofSecretArn,
        userPoolArn,
      })
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        renderRuntimeBoundaryTemplate(child, {
          accountId,
          alarmArnPattern,
          boundaryArn,
          controlPlaneResources,
          distributionArn,
          gatewayInvokerRoleArn,
          journeyGithubOAuthClientSecretArn,
          platformStateTableArn,
          region,
          runtimeProofConfiguratorRoleArn,
          runtimeInvocationProofSecretArn,
          userPoolArn,
        }),
      ]),
    );
  }
  return value;
}

export function compactRuntimeBoundary(
  policy,
  {
    journeyGithubOAuthClientSecretArn = null,
    journeyInceptionModelArns = [],
    preserveOptionalStatements = false,
  } = {},
) {
  const compacted = structuredClone(policy);
  const statements = compacted.Statement;
  const asArray = (value) => Array.isArray(value) ? value : [value];
  const bySid = (sid) =>
    statements.find((statement) => statement.Sid === sid);
  const remove = (...sids) => {
    const removed = new Set(sids);
    for (let index = statements.length - 1; index >= 0; index -= 1) {
      if (removed.has(statements[index].Sid)) {
        statements.splice(index, 1);
      }
    }
  };
  if (
    !journeyGithubOAuthClientSecretArn
    && !preserveOptionalStatements
  ) {
    remove("ReadJourneyGitHubOAuthClientSecret");
  }
  const journeyInception = bySid("InvokeJourneyInceptionModel");
  if (journeyInception && !preserveOptionalStatements) {
    if (journeyInceptionModelArns.length < 1) {
      remove("InvokeJourneyInceptionModel");
    } else {
      journeyInception.Resource = [...journeyInceptionModelArns];
    }
  }
  const merge = (targetSid, sourceSids) => {
    const target = bySid(targetSid);
    if (!target) {
      return;
    }
    for (const sourceSid of sourceSids) {
      const source = bySid(sourceSid);
      if (!source) {
        continue;
      }
      if (
        target.Effect !== source.Effect
        || JSON.stringify(target.Condition ?? null)
          !== JSON.stringify(source.Condition ?? null)
      ) {
        throw new AuditValidationError(
          `${targetSid} and ${sourceSid} must have identical conditions.`,
          "INVALID_RUNTIME_BOUNDARY_SOURCE",
        );
      }
      target.Action = [
        ...new Set([...asArray(target.Action), ...asArray(source.Action)]),
      ];
      target.Resource = [
        ...new Set([
          ...asArray(target.Resource),
          ...asArray(source.Resource),
        ]),
      ];
      remove(sourceSid);
    }
  };
  const allowManagedByValues = (targetSid, sourceSid) => {
    const target = bySid(targetSid);
    const source = bySid(sourceSid);
    if (!target || !source) {
      return;
    }
    const targetValue =
      target.Condition?.StringEquals?.["aws:RequestTag/managedBy"];
    const sourceValue =
      source.Condition?.StringEquals?.["aws:RequestTag/managedBy"];
    if (typeof targetValue !== "string" || typeof sourceValue !== "string") {
      throw new AuditValidationError(
        `${targetSid} and ${sourceSid} must declare managedBy conditions.`,
        "INVALID_RUNTIME_BOUNDARY_SOURCE",
      );
    }
    target.Condition.StringEquals["aws:RequestTag/managedBy"] = [
      targetValue,
      sourceValue,
    ];
    remove(sourceSid);
  };

  allowManagedByValues(
    "CreatePlatformDomainRegistry",
    "CreateHostedAcceptanceDomainRegistry",
  );
  allowManagedByValues(
    "TagPlatformDomainRegistry",
    "TagHostedAcceptanceDomainRegistry",
  );

  const listControlPlaneRegistries = bySid("ListControlPlaneRegistries");
  const tagPlatformDomainRegistry = bySid("TagPlatformDomainRegistry");
  if (listControlPlaneRegistries && tagPlatformDomainRegistry) {
    listControlPlaneRegistries.Resource = [
      asArray(tagPlatformDomainRegistry.Resource)[0],
    ];
  }
  const readControlPlaneRegistryRecords = bySid(
    "ReadControlPlaneRegistryRecords",
  );
  const readDynamicControlPlaneRegistryRecords = bySid(
    "ReadDynamicControlPlaneRegistryRecords",
  );
  if (
    readControlPlaneRegistryRecords
    && readDynamicControlPlaneRegistryRecords
  ) {
    readControlPlaneRegistryRecords.Resource = [
      asArray(readDynamicControlPlaneRegistryRecords.Resource)[0],
    ];
  }

  const readAgentRuntimeWorkloadIdentity = bySid(
    "ReadAgentRuntimeWorkloadIdentity",
  );
  if (readAgentRuntimeWorkloadIdentity) {
    readAgentRuntimeWorkloadIdentity.Action = [
      "bedrock-agentcore:GetWorkloadAccessToken*",
    ];
    readAgentRuntimeWorkloadIdentity.Resource = [
      [...asArray(readAgentRuntimeWorkloadIdentity.Resource)].sort(
        (left, right) =>
          JSON.stringify(left).length - JSON.stringify(right).length,
      )[0],
    ];
  }
  const readGovernedAgentRuntime = bySid("ReadGovernedAgentRuntime");
  const readGovernedAgentRuntimeEndpoints = bySid(
    "ReadGovernedAgentRuntimeEndpoints",
  );
  if (readGovernedAgentRuntime && readGovernedAgentRuntimeEndpoints) {
    readGovernedAgentRuntime.Action = [
      "bedrock-agentcore:GetAgentRuntime*",
    ];
    readGovernedAgentRuntime.Resource = [
      ...asArray(readGovernedAgentRuntime.Resource),
      ...asArray(readGovernedAgentRuntimeEndpoints.Resource),
    ];
    remove("ReadGovernedAgentRuntimeEndpoints");
  }
  const invokeGovernedAgentRuntime = bySid(
    "InvokeGovernedAgentRuntime",
  );
  if (invokeGovernedAgentRuntime) {
    invokeGovernedAgentRuntime.Action = [
      "bedrock-agentcore:InvokeAgentRuntime*",
    ];
  }

  merge(
    "CreateHostedAcceptanceFixtureRecord",
    ["TagHostedAcceptanceFixtureRecord"],
  );
  allowManagedByValues(
    "CreateGovernedRegistryRecords",
    "CreateHostedAcceptanceFixtureRecord",
  );
  const governedRegistryCreate = bySid(
    "CreateGovernedRegistryRecords",
  );
  if (governedRegistryCreate?.Condition?.StringEquals) {
    delete governedRegistryCreate.Condition.StringEquals[
      "aws:RequestedRegion"
    ];
  }
  merge(
    "CreateGovernedRegistryRecords",
    ["TagPlatformDomainRegistry"],
  );
  merge(
    "ReadHostedAcceptanceFixtureRecord",
    ["ReadHostedAcceptanceDomainRegistry"],
  );
  // IAM wildcards cross "/": registry/* already matches every
  // registry/<id>/record/<id>, so any record ARN riding along in this
  // conditionless read is redundant with the registry wildcard it merged in.
  // Mirrors runtimePermissionsBoundaryDocument in lib/config.ts.
  // IAM/CDK can omit Sids in the deployed document. Recognize the same exact
  // read statement so a redundant child ARN does not become false drift.
  const hostedAcceptanceReads = bySid("ReadHostedAcceptanceFixtureRecord")
    || statements.find(statement => statement.Effect === "Allow"
      && !statement.Condition
      && asArray(statement.Action).length === 2
      && asArray(statement.Action).includes("agent-registry:GetRegistry")
      && asArray(statement.Action).includes("agent-registry:ListTagsForResource"));
  if (hostedAcceptanceReads) {
    const registryWildcardArn = asArray(hostedAcceptanceReads.Resource).find(
      (resource) =>
        typeof resource === "string"
        && /^arn:[^:]*:agent-registry:[^:]*:[^:]*:registry\/\*$/.test(resource),
    );
    if (registryWildcardArn) {
      hostedAcceptanceReads.Resource = asArray(hostedAcceptanceReads.Resource)
        .filter(
          (resource) =>
            resource === registryWildcardArn
            || typeof resource !== "string"
            || !resource.startsWith(registryWildcardArn.slice(0, -1)),
        );
    }
  }
  const dynamicRegistryAccess = bySid(
    "ListDynamicControlPlaneRegistries",
  );
  const governedRegistryMutation = bySid(
    "MutateGovernedRegistryRecords",
  );
  if (dynamicRegistryAccess && governedRegistryMutation) {
    dynamicRegistryAccess.Action = [
      ...new Set([
        ...asArray(dynamicRegistryAccess.Action),
        ...asArray(governedRegistryMutation.Action),
      ]),
    ];
    remove("MutateGovernedRegistryRecords");
  }
  merge(
    "ListDynamicControlPlaneRegistries",
    [
      "ReadDynamicControlPlaneRegistryRecords",
      "DeleteHostedAcceptanceDomainRegistry",
    ],
  );
  if (
    dynamicRegistryAccess
    && listControlPlaneRegistries
    && readControlPlaneRegistryRecords
  ) {
    const conditionlessRegistryActions = new Set([
      ...asArray(listControlPlaneRegistries.Action),
      ...asArray(readControlPlaneRegistryRecords.Action),
    ]);
    dynamicRegistryAccess.Action = asArray(
      dynamicRegistryAccess.Action,
    ).filter((action) => !conditionlessRegistryActions.has(action));
    const registryWildcard =
      asArray(listControlPlaneRegistries.Resource)[0];
    const registryRecordWildcard = `${registryWildcard}/record/*`;
    if (
      asArray(dynamicRegistryAccess.Resource).includes(registryWildcard)
      && asArray(dynamicRegistryAccess.Resource).includes(
        registryRecordWildcard,
      )
    ) {
      dynamicRegistryAccess.Resource =
        asArray(dynamicRegistryAccess.Resource).filter(
          (resource) => resource !== registryRecordWildcard,
        );
    }
  }
  merge("ReadPlatformState", ["WritePlatformState"]);
  merge(
    "WriteXRayTelemetry",
    ["ReadAgentRuntimeMetrics", "InvokeJourneyInceptionModel"],
  );
  merge(
    "ReadRuntimeInvocationProofSecret",
    ["ReadJourneyGitHubOAuthClientSecret"],
  );
  const telemetry = bySid("WriteXRayTelemetry");
  if (telemetry) {
    telemetry.Resource = ["*"];
    // Compact read-only memory and knowledge-base actions into shorter wildcards
    // to stay within IAM's 6,144-byte managed-policy size limit.
    // Mirrors runtimePermissionsBoundaryDocument in lib/config.ts.
    const memoryActions = [
      "bedrock-agentcore:GetMemory",
      "bedrock-agentcore:ListMemories",
    ];
    if (memoryActions.every((a) => asArray(telemetry.Action).includes(a))) {
      telemetry.Action = asArray(telemetry.Action).filter(
        (a) => !memoryActions.includes(a),
      );
      telemetry.Action.push("bedrock-agentcore:*Mem*");
    }
    const kbActionIndex = asArray(telemetry.Action).indexOf(
      "bedrock:GetKnowledgeBase",
    );
    if (kbActionIndex !== -1) {
      telemetry.Action[kbActionIndex] = "bedrock:GetKnow*";
    }
  }
  for (const sid of [
    "ReadPlatformState",
    "ReadDeleteHostedAcceptanceState",
    "UpdateExperienceInvocation",
    "ReadHitlPolicyCatalog",
  ]) {
    const statement = bySid(sid);
    if (statement) {
      delete statement.Condition;
    }
  }
  // ReadHitlPolicyCatalog folds away entirely: once conditions are dropped,
  // ReadPlatformState already ceilings GetItem on the same table. The HITL
  // partition scoping stays enforced by the governance role's identity policy.
  // Mirrors runtimePermissionsBoundaryDocument in lib/config.ts.
  merge("ReadPlatformState", [
    "UpdateExperienceInvocation",
    "ReadHitlPolicyCatalog",
  ]);

  const cdkAssets = bySid("ReadCdkAssets");
  const webAssets = bySid("DeployWebAssets");
  if (cdkAssets && webAssets) {
    const cdkResources = asArray(cdkAssets.Resource);
    const cdkBucketArn = cdkResources.find(
      (resource) =>
        typeof resource === "string"
        && cdkResources.includes(`${resource}/*`),
    );
    if (typeof cdkBucketArn !== "string") {
      throw new AuditValidationError(
        "CDK asset boundary resources are inconsistent.",
        "INVALID_RUNTIME_BOUNDARY_SOURCE",
      );
    }
    cdkAssets.Resource = [`${cdkBucketArn}*`];
    webAssets.Resource = [[...asArray(webAssets.Resource)].sort(
      (left, right) =>
        JSON.stringify(left).length - JSON.stringify(right).length,
    )[0]];
    cdkAssets.Resource = [
      ...asArray(cdkAssets.Resource),
      ...asArray(webAssets.Resource),
    ];
    const readActions = new Set(asArray(cdkAssets.Action));
    webAssets.Action = asArray(webAssets.Action).filter(
      (action) => !readActions.has(action),
    );
  }

  merge(
    "WritePlatformLogs",
    [
      "ReadControlPlaneToolsGateway",
      "ManageRegistryWorkloadIdentity",
      "AssumeGatewayInvokerRole",
      "InvokeRegistryDecisionFinalizer",
      "ReadWritePlatformState",
      "ReadDeleteHostedAcceptanceState",
      "ReadCdkAssets",
      "InvalidateCloudFront",
      "ReconcileCloudFrontAlarm",
      "ReconcileRuntimeBoundaryTags",
      "WriteAgentRuntimeLogs",
      "DescribeAgentRuntimeLogs",
      "ReadAgentRuntimeWorkloadIdentity",
      "ReadGovernedAgentRuntime",
      "InvokeGovernedAgentRuntime",
      "ManageControlPlaneLlmGatewayRateLimits",
      "ReadCurrentDemoOperator",
      "ReadPlatformState",
      "ReadPlatformAuditMetadata",
    ],
  );
  const compactedRuntimeAccess = bySid("WritePlatformLogs");
  if (compactedRuntimeAccess) {
    const registryDecisionFinalizerFunctionArn =
      asArray(compactedRuntimeAccess.Resource).find(
        (resource) =>
          typeof resource === "string"
          && resource.endsWith(
            ":function:AgenticPlatform-Web-RegistryDecisionFinalizer",
          ),
      );
    const runtimeProofConfiguratorFunctionArn =
      asArray(compactedRuntimeAccess.Resource).find(
        (resource) =>
          typeof resource === "string"
          && resource.endsWith(
            ":function:AgenticPlatform-Web-RuntimeProofConfigurator",
          ),
      );
    if (
      registryDecisionFinalizerFunctionArn
      && runtimeProofConfiguratorFunctionArn
    ) {
      const registryPrefix = registryDecisionFinalizerFunctionArn.slice(
        0,
        -"RegistryDecisionFinalizer".length,
      );
      const configuratorPrefix = runtimeProofConfiguratorFunctionArn.slice(
        0,
        -"RuntimeProofConfigurator".length,
      );
      if (registryPrefix !== configuratorPrefix) {
        throw new AuditValidationError(
          "Runtime helper function ARNs are inconsistent.",
          "INVALID_RUNTIME_BOUNDARY_SOURCE",
        );
      }
      compactedRuntimeAccess.Resource = [
        ...asArray(compactedRuntimeAccess.Resource).filter(
          (resource) =>
            resource !== registryDecisionFinalizerFunctionArn
            && resource !== runtimeProofConfiguratorFunctionArn,
        ),
        `${registryPrefix}R*`,
      ];
    }
    const workloadIdentityDirectoryArn =
      asArray(compactedRuntimeAccess.Resource).find(
        (resource) =>
          typeof resource === "string"
          && resource.endsWith("workload-identity-directory/*"),
      );
    if (workloadIdentityDirectoryArn) {
      const workloadIdentityDirectoryPrefix =
        workloadIdentityDirectoryArn.slice(0, -1);
      compactedRuntimeAccess.Resource =
        asArray(compactedRuntimeAccess.Resource).filter(
          (resource) =>
            resource === workloadIdentityDirectoryArn
            || typeof resource !== "string"
            || !resource.startsWith(workloadIdentityDirectoryPrefix),
        );
    }
    const logGroupWildcard = asArray(
      compactedRuntimeAccess.Resource,
    ).find(
      (resource) =>
        typeof resource === "string"
        && resource.endsWith(":log-group:*"),
    );
    if (logGroupWildcard) {
      const logGroupPrefix = logGroupWildcard.slice(0, -1);
      compactedRuntimeAccess.Resource =
        asArray(compactedRuntimeAccess.Resource).filter(
          (resource) =>
            resource === logGroupWildcard
            || typeof resource !== "string"
            || !resource.startsWith(logGroupPrefix),
        );
    }
    const auditIndexArn = asArray(compactedRuntimeAccess.Resource).find(
      (resource) =>
        typeof resource === "string"
        && resource.endsWith("/index/EntityTypeIndex"),
    );
    const tableArn = auditIndexArn?.slice(
      0,
      -"/index/EntityTypeIndex".length,
    );
    if (
      tableArn
      && asArray(compactedRuntimeAccess.Resource).includes(tableArn)
    ) {
      compactedRuntimeAccess.Resource = [
        ...asArray(compactedRuntimeAccess.Resource).filter(
          (resource) =>
            resource !== tableArn
            && resource !== auditIndexArn,
        ),
        `${tableArn}*`,
      ];
    }
    // Compact BatchPutGatewayRateLimits + ListGatewayRateLimits into a single
    // suffix wildcard to reclaim ~49 bytes and stay within IAM's policy size limit.
    // Mirrors runtimePermissionsBoundaryDocument in lib/config.ts.
    const rateLimitActions = [
      "bedrock-agentcore:BatchPutGatewayRateLimits",
      "bedrock-agentcore:ListGatewayRateLimits",
    ];
    if (rateLimitActions.every(
      (a) => asArray(compactedRuntimeAccess.Action).includes(a),
    )) {
      compactedRuntimeAccess.Action = asArray(
        compactedRuntimeAccess.Action,
      ).filter((a) => !rateLimitActions.includes(a));
      compactedRuntimeAccess.Action.push("bedrock-agentcore:*GatewayRateLimits");
    }
  }
  // The tag-constrained registry/* grant already covers hosted-acceptance
  // record submissions. Remove only that identical permission; keep deletion
  // independently constrained. This also normalizes earlier deployed policies.
  const actionValues = (value) => Array.isArray(value) ? value : [value];
  const submit = "agent-registry:SubmitRegistryRecordForApproval";
  for (const specific of statements) {
    const tags = specific.Condition?.StringEquals;
    if (specific.Effect !== "Allow" || !actionValues(specific.Action).includes(submit)
      || tags?.["aws:ResourceTag/managedBy"] !== "hosted-acceptance"
      || Object.keys(specific.Condition).join() !== "StringEquals") continue;
    const covering = statements.find(other => other !== specific && other.Effect === "Allow"
      && actionValues(other.Action).includes(submit)
      && Object.keys(other.Condition || {}).join() === "StringEquals"
      && JSON.stringify(Object.keys(other.Condition.StringEquals).sort()) === JSON.stringify(Object.keys(tags).sort())
      && Object.entries(tags).every(([key,value]) => actionValues(other.Condition.StringEquals[key]).includes(value))
      && actionValues(specific.Resource).every(resource => actionValues(other.Resource).some(parent =>
        typeof resource === "string" && typeof parent === "string" && parent.endsWith(":registry/*")
        && resource.startsWith(parent.slice(0,-1)))));
    if (covering) specific.Action = actionValues(specific.Action).filter(action => action !== submit);
  }

  compacted.Statement = statements.map(
    ({ Sid: _sid, ...statement }) => ({
      ...statement,
      Action: asArray(statement.Action).length === 1
        ? asArray(statement.Action)[0]
        : statement.Action,
      Resource: asArray(statement.Resource).length === 1
        ? asArray(statement.Resource)[0]
        : statement.Resource,
    }),
  );
  return compacted;
}

function canonicalPolicy(value, key) {
  if (key === "Sid") {
    return undefined;
  }
  if (key === "Action" || key === "Resource") {
    const values = Array.isArray(value) ? value : [value];
    return values
      .map((child) => canonicalPolicy(child))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
  }
  if (Array.isArray(value)) {
    return value
      .map((child) => canonicalPolicy(child))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([childKey]) => childKey !== "Sid")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, child]) => [
          childKey,
          canonicalPolicy(child, childKey),
        ]),
    );
  }
  return value;
}

export function canonicalPolicyContent(policy) {
  return JSON.stringify(canonicalPolicy(policy));
}

function policyHash(canonicalContent) {
  return createHash("sha256").update(canonicalContent).digest("hex");
}

function normalizeExecutionRolePolicyValue(value, { accountId, region }) {
  if (Array.isArray(value)) {
    return value.map((child) =>
      normalizeExecutionRolePolicyValue(child, { accountId, region })
    );
  }
  if (typeof value === "string") {
    return value
      .split(accountId).join("<ACCOUNT_ID>")
      .split(region).join("<REGION>");
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeExecutionRolePolicyValue(child, { accountId, region }),
      ]),
    );
  }
  return value;
}

function executionRolePolicyHash(document, context) {
  return policyHash(
    canonicalPolicyContent(
      normalizeExecutionRolePolicyValue(document, context),
    ),
  );
}

function exactPolicyStateWithLegacyLogTransition({
  allowPlannedTransition,
  logGroupArn,
  policyContent,
  targetPolicy,
}) {
  if (policyContent === canonicalPolicyContent(targetPolicy)) {
    return "target";
  }
  if (!allowPlannedTransition) {
    return null;
  }

  let replacementCount = 0;
  const legacyPolicy = {
    ...targetPolicy,
    Statement: targetPolicy.Statement.map((statement) => {
      if (statement.Resource !== `${logGroupArn}:*`) {
        return statement;
      }
      replacementCount += 1;
      return {
        ...statement,
        Resource: `${logGroupArn}:*:*`,
      };
    }),
  };
  if (
    replacementCount === 1
    && policyContent === canonicalPolicyContent(legacyPolicy)
  ) {
    return "legacy-log-resource";
  }
  return null;
}

function exactHostedAcceptanceBrokerPolicyState({
  allowPlannedTransition,
  policyContent,
  targetPolicy,
}) {
  if (policyContent === canonicalPolicyContent(targetPolicy)) return "target";
  if (!allowPlannedTransition) return null;

  const actions = (statement) =>
    Array.isArray(statement.Action)
      ? statement.Action
      : [statement.Action];
  const priorAgentBuildingAcceptancePolicy =
    structuredClone(targetPolicy);
  priorAgentBuildingAcceptancePolicy.Statement =
    priorAgentBuildingAcceptancePolicy.Statement.filter(
      ({ Sid }) =>
        Sid !== "DeleteHostedAcceptanceAgentBuildingJourneys",
    );
  const priorAgentBuildingAcceptanceRead =
    priorAgentBuildingAcceptancePolicy.Statement.find(
      ({ Sid }) => Sid === "ReadHostedAcceptanceState",
    );
  const priorAgentBuildingAcceptanceKeys =
    priorAgentBuildingAcceptanceRead?.Condition
      ?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"];
  if (
    !Array.isArray(priorAgentBuildingAcceptanceKeys)
    || !priorAgentBuildingAcceptanceKeys.includes("DELIVERY#*")
    || !priorAgentBuildingAcceptanceKeys.includes("JOURNEY#*")
  ) {
    return null;
  }
  priorAgentBuildingAcceptanceRead.Condition[
    "ForAllValues:StringLike"
  ]["dynamodb:LeadingKeys"] =
    priorAgentBuildingAcceptanceKeys.filter(
      (key) => key !== "DELIVERY#*" && key !== "JOURNEY#*",
    );
  if (
    policyContent
      === canonicalPolicyContent(priorAgentBuildingAcceptancePolicy)
  ) {
    return "legacy-pre-agent-building-acceptance-cleanup";
  }
  const targetRegistryWorkloadIdentityDelete =
    targetPolicy.Statement.find(
      ({ Sid }) =>
        Sid === "DeleteHostedAcceptanceRegistryWorkloadIdentity",
    );
  const targetRegistryWorkloadIdentityResources =
    targetRegistryWorkloadIdentityDelete?.Resource;
  if (
    !Array.isArray(targetRegistryWorkloadIdentityResources)
    || targetRegistryWorkloadIdentityResources.length !== 2
  ) {
    return null;
  }
  const directoryResource =
    targetRegistryWorkloadIdentityResources.find((resource) =>
      typeof resource === "string"
      && resource.endsWith("workload-identity-directory/default")
    );
  const childResource =
    targetRegistryWorkloadIdentityResources.find((resource) =>
      typeof resource === "string"
      && resource.endsWith(
        "workload-identity-directory/default/"
          + "workload-identity/registry-*",
      )
    );
  if (directoryResource === undefined || childResource === undefined) {
    return null;
  }
  const withRegistryWorkloadIdentityResource = (resource) => ({
    ...targetPolicy,
    Statement: targetPolicy.Statement.map((statement) =>
      statement.Sid
          === "DeleteHostedAcceptanceRegistryWorkloadIdentity"
        ? { ...statement, Resource: resource }
        : statement
    ),
  });
  const childScopedRegistryWorkloadIdentityDelete =
    withRegistryWorkloadIdentityResource(childResource);
  if (
    policyContent
      === canonicalPolicyContent(childScopedRegistryWorkloadIdentityDelete)
  ) {
    return "legacy-child-scoped-registry-workload-identity-delete";
  }
  const directoryOnlyRegistryWorkloadIdentityDelete =
    withRegistryWorkloadIdentityResource(directoryResource);
  if (
    policyContent
      === canonicalPolicyContent(directoryOnlyRegistryWorkloadIdentityDelete)
  ) {
    return "legacy-directory-only-registry-workload-identity-delete";
  }
  const withoutRegistryWorkloadIdentityDelete = {
    ...targetPolicy,
    Statement: targetPolicy.Statement.filter(
      ({ Sid }) =>
        Sid !== "DeleteHostedAcceptanceRegistryWorkloadIdentity",
    ),
  };
  if (
    policyContent
      === canonicalPolicyContent(withoutRegistryWorkloadIdentityDelete)
  ) {
    return "legacy-without-registry-workload-identity-delete";
  }
  const businessDomainApprovalKeys = new Set([
    "APPROVAL#customer_support",
    "APPROVAL#operations",
  ]);
  const priorBusinessDomainApprovalCleanupPolicy = {
    ...targetPolicy,
    Statement: targetPolicy.Statement.map((statement) => {
      if (
        statement.Sid !== "ReadHostedAcceptanceState"
        && statement.Sid !== "DeleteHostedAcceptanceExperienceFixture"
      ) {
        return statement;
      }
      const leadingKeys = statement.Condition
        ?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"];
      if (!Array.isArray(leadingKeys)) return statement;
      return {
        ...statement,
        Condition: {
          ...statement.Condition,
          "ForAllValues:StringLike": {
            ...statement.Condition["ForAllValues:StringLike"],
            "dynamodb:LeadingKeys": leadingKeys.filter(
              (key) => !businessDomainApprovalKeys.has(key),
            ),
          },
        },
      };
    }),
  };
  if (
    policyContent
      === canonicalPolicyContent(priorBusinessDomainApprovalCleanupPolicy)
  ) {
    return "legacy-pre-business-domain-approval-cleanup-scope";
  }
  const priorBusinessDomainReadKeys = [
    "AGENT#hosted_acceptance_*",
    "APPROVAL#hosted_acceptance_*",
    "AUDIT#*",
    "DEPLOYMENT#hosted_acceptance_*",
    "DOMAIN",
    "ENTITLEMENT#*",
    "EXPERIENCE_INVOCATION#*",
    "HOSTED_ACCEPTANCE",
    "HOSTED_ROLE_SWITCHING",
    "MUTATION#*",
    "PROJECT#hosted_acceptance_*",
    "REQUEST#*",
    "SESSION#*",
    "SUBMISSION#*",
  ];
  const priorBusinessDomainFixtureKeys = [
    "AGENT#hosted_acceptance_*",
    "DEPLOYMENT#hosted_acceptance_*",
    "ENTITLEMENT#*",
    "PROJECT#hosted_acceptance_*",
  ];
  const priorBusinessDomainFixturePolicy = {
    ...targetPolicy,
    Statement: targetPolicy.Statement.map((statement) => {
      let leadingKeys;
      switch (statement.Sid) {
        case "ReadHostedAcceptanceState":
          leadingKeys = priorBusinessDomainReadKeys;
          break;
        case "DeleteHostedAcceptanceState":
          leadingKeys = priorBusinessDomainReadKeys.filter(
            (key) => key !== "PROJECT#hosted_acceptance_*",
          );
          break;
        case "WriteHostedAcceptanceExperienceFixture":
        case "DeleteHostedAcceptanceExperienceFixture":
          leadingKeys = priorBusinessDomainFixtureKeys;
          break;
        default:
          return statement;
      }
      return {
        ...statement,
        Condition: {
          ...statement.Condition,
          "ForAllValues:StringLike": {
            ...statement.Condition?.["ForAllValues:StringLike"],
            "dynamodb:LeadingKeys": leadingKeys,
          },
        },
      };
    }),
  };
  if (
    policyContent
      === canonicalPolicyContent(priorBusinessDomainFixturePolicy)
  ) {
    return "legacy-pre-business-domain-experience-fixture-scope";
  }
  const isDynamoStatement = (statement) =>
    actions(statement).some((action) => action.startsWith("dynamodb:"));
  const priorFixtureLeadingKeys = [
    "AGENT#*",
    "DEPLOYMENT#*",
    "ENTITLEMENT#*",
    "PROJECT#*",
  ];
  const tableResource = targetPolicy.Statement.find(
    isDynamoStatement,
  )?.Resource;
  if (tableResource === undefined) return null;
  const priorTargetPolicy = {
    ...targetPolicy,
    Statement: [
      ...targetPolicy.Statement.filter(
        (statement) => !isDynamoStatement(statement),
      ),
      {
        Action: ["dynamodb:DeleteItem", "dynamodb:GetItem"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "AGENT#*",
              "APPROVAL#*",
              "AUDIT#*",
              "DEPLOYMENT#*",
              "DOMAIN",
              "ENTITLEMENT#*",
              "EXPERIENCE_INVOCATION#*",
              "HOSTED_ACCEPTANCE",
              "HOSTED_ROLE_SWITCHING",
              "MUTATION#*",
              "REQUEST#*",
              "SESSION#*",
              "SUBMISSION#*",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
      {
        Action: "dynamodb:PutItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              "HOSTED_ACCEPTANCE",
              "HOSTED_ROLE_SWITCHING",
            ],
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
      {
        Action: "dynamodb:Query",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["ENTITLEMENT#*"],
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
      {
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": priorFixtureLeadingKeys,
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
      {
        Action: ["dynamodb:DeleteItem", "dynamodb:PutItem"],
        Condition: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": priorFixtureLeadingKeys,
          },
          "ForAnyValue:StringEquals": {
            "dynamodb:EnclosingOperation": ["TransactWriteItems"],
          },
        },
        Effect: "Allow",
        Resource: tableResource,
      },
    ],
  };
  if (
    policyContent === canonicalPolicyContent(priorTargetPolicy)
  ) {
    return "legacy-broad-state-partitions";
  }

  const withoutRecoveryQuery = (policy) => ({
    ...policy,
    Statement: policy.Statement.filter(
      (statement) => statement.Action !== "dynamodb:Query",
    ),
  });
  if (
    policyContent === canonicalPolicyContent(
      withoutRecoveryQuery(targetPolicy),
    )
    || policyContent === canonicalPolicyContent(
      withoutRecoveryQuery(priorTargetPolicy),
    )
  ) {
    return "legacy-without-experience-recovery-query";
  }

  const priorFixtureRead = priorTargetPolicy.Statement.find((statement) =>
    statement.Action === "dynamodb:GetItem"
    && canonicalPolicyContent(
      statement.Condition?.["ForAllValues:StringLike"]
        ?.["dynamodb:LeadingKeys"],
    ) === canonicalPolicyContent(priorFixtureLeadingKeys)
  );
  const priorFixtureTransaction = priorTargetPolicy.Statement.find(
    (statement) =>
      canonicalPolicyContent(statement.Action)
        === canonicalPolicyContent([
          "dynamodb:DeleteItem",
          "dynamodb:PutItem",
        ])
      && canonicalPolicyContent(
        statement.Condition?.["ForAnyValue:StringEquals"]
          ?.["dynamodb:EnclosingOperation"],
      ) === canonicalPolicyContent(["TransactWriteItems"]),
  );
  if (priorFixtureRead && priorFixtureTransaction) {
    const legacyTransactionPolicy = {
      ...priorTargetPolicy,
      Statement: [
        ...priorTargetPolicy.Statement.filter((statement) =>
          statement !== priorFixtureRead
          && statement !== priorFixtureTransaction
        ),
        {
          Action: [
            "dynamodb:GetItem",
            "dynamodb:TransactWriteItems",
          ],
          Condition: priorFixtureRead.Condition,
          Effect: priorFixtureRead.Effect,
          Resource: priorFixtureRead.Resource,
        },
      ],
    };
    if (
      policyContent === canonicalPolicyContent(legacyTransactionPolicy)
    ) {
      return "legacy-transaction-authorization";
    }
  }

  for (const policy of [targetPolicy, priorTargetPolicy]) {
    const legacyEndpointOnlyPolicy = {
      ...policy,
      Statement: policy.Statement.map((statement) =>
        statement.Action === "bedrock-agentcore:GetAgentRuntimeEndpoint"
          ? {
              ...statement,
              Resource: statement.Resource[1],
            }
          : statement
      ),
    };
    if (
      policyContent === canonicalPolicyContent(legacyEndpointOnlyPolicy)
    ) {
      return "legacy-endpoint-only-resource";
    }
  }
  return null;
}

function isCompleteIamListResponse(document) {
  return (
    (
      document.IsTruncated === undefined
      || document.IsTruncated === false
    )
    && document.Marker === undefined
  );
}

function decodePolicyDocument(
  document,
  label = "Runtime permissions boundary",
) {
  let decoded = document;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decodeURIComponent(decoded));
    } catch {
      throw new AuditValidationError(
        `${label} document is not valid URL-encoded JSON.`,
        "INVALID_RUNTIME_BOUNDARY_DOCUMENT",
      );
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new AuditValidationError(
      `${label} document must be a policy object.`,
      "INVALID_RUNTIME_BOUNDARY_DOCUMENT",
    );
  }
  return decoded;
}

function verifyRuntimeBoundaryTags(document) {
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || (
      document.IsTruncated !== undefined
      && typeof document.IsTruncated !== "boolean"
    )
  ) {
    throw new AuditValidationError(
      "Runtime permissions boundary tag inspection is malformed.",
      "INVALID_RUNTIME_BOUNDARY_TAGS",
    );
  }
  if (document.IsTruncated === true || document.Marker !== undefined) {
    throw new AuditValidationError(
      "Runtime permissions boundary tag inspection pagination is not supported.",
      "PAGINATED_RUNTIME_BOUNDARY_TAGS",
    );
  }
  if (!Array.isArray(document.Tags)) {
    throw new AuditValidationError(
      "Runtime permissions boundary tag inspection must return tags.",
      "INVALID_RUNTIME_BOUNDARY_TAGS",
    );
  }
  const tags = new Map();
  for (const tag of document.Tags) {
    if (
      !tag
      || typeof tag !== "object"
      || Array.isArray(tag)
      || typeof tag.Key !== "string"
      || tag.Key.length === 0
      || typeof tag.Value !== "string"
    ) {
      throw new AuditValidationError(
        "Runtime permissions boundary contains a malformed tag.",
        "INVALID_RUNTIME_BOUNDARY_TAGS",
      );
    }
    if (tags.has(tag.Key)) {
      throw new AuditValidationError(
        "Runtime permissions boundary contains duplicate tag keys.",
        "DUPLICATE_RUNTIME_BOUNDARY_TAGS",
      );
    }
    tags.set(tag.Key, tag.Value);
  }
  if (
    tags.size !== REQUIRED_TAGS.size
    || [...REQUIRED_TAGS].some(([key, value]) => tags.get(key) !== value)
  ) {
    throw new AuditValidationError(
      "Runtime permissions boundary must have the exact mandatory tags.",
      "RUNTIME_BOUNDARY_TAG_DRIFT",
    );
  }
}

function renderControlPlaneRuntimeBoundaryTemplate(
  value,
  { accountId, region },
) {
  if (typeof value === "string") {
    return value
      .replaceAll("${ACCOUNT}", accountId)
      .replaceAll("${PARTITION}", REQUIRED_PARTITION)
      .replaceAll("${REGION}", region)
      .replaceAll("${PROVISIONED_NAME_PREFIX}", "acp-cp-prov");
  }
  if (Array.isArray(value)) {
    return value.map((child) =>
      renderControlPlaneRuntimeBoundaryTemplate(
        child,
        { accountId, region },
      )
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        renderControlPlaneRuntimeBoundaryTemplate(
          child,
          { accountId, region },
        ),
      ]),
    );
  }
  return value;
}

function verifyCompletePolicyTagDocument(document, label) {
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || (
      document.IsTruncated !== undefined
      && typeof document.IsTruncated !== "boolean"
    )
  ) {
    throw new AuditValidationError(
      `${label} tag inspection is malformed.`,
      "INVALID_CONTROL_PLANE_BOUNDARY_TAGS",
    );
  }
  if (document.IsTruncated === true || document.Marker !== undefined) {
    throw new AuditValidationError(
      `${label} tag inspection must be complete and non-paginated.`,
      "PAGINATED_CONTROL_PLANE_BOUNDARY_TAGS",
    );
  }
  verifyExactTagList(document.Tags, label);
}

function inspectControlPlaneRuntimeBoundary({
  accountId,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  region,
  runCommand,
}) {
  const boundaryArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:policy/`
    + CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME;
  const expectedPolicy = renderControlPlaneRuntimeBoundaryTemplate(
    CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
    { accountId, region },
  );
  // Keep historical scoped contracts only as deploy-mode predecessors.
  // The current boundary must match the same source rendered by CDK.
  const legacyScopedPolicy = structuredClone(expectedPolicy);
  const registryArns = [
    controlPlaneResources.sharedRegistryArn,
    controlPlaneResources.platformRegistryArn,
    controlPlaneResources.customerSupportRegistryArn,
    controlPlaneResources.operationsRegistryArn,
  ];
  const listRegistries = legacyScopedPolicy.Statement.find(
    ({ Sid }) => Sid === "ReadControlPlaneRegistries",
  );
  const readRecords = legacyScopedPolicy.Statement.find(
    ({ Sid }) => Sid === "ReadControlPlaneRegistryRecords",
  );
  if (!listRegistries || !readRecords) {
    throw new AuditValidationError(
      "Control-plane runtime boundary source is inconsistent.",
      "INVALID_CONTROL_PLANE_RUNTIME_BOUNDARY_SOURCE",
    );
  }
  listRegistries.Action = ["agent-registry:ListRegistryRecords"];
  listRegistries.Resource = registryArns;
  readRecords.Action = [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:GetRegistryRecord",
    "agent-registry:UpdateRegistryRecordStatus",
  ];
  readRecords.Resource = registryArns.map((registryArn) =>
    `${registryArn}/record/*`
  );
  const predecessorPolicy = structuredClone(legacyScopedPolicy);
  const predecessorListRegistries = predecessorPolicy.Statement.find(
    ({ Sid }) => Sid === "ReadControlPlaneRegistries",
  );
  const predecessorReadRecords = predecessorPolicy.Statement.find(
    ({ Sid }) => Sid === "ReadControlPlaneRegistryRecords",
  );
  predecessorListRegistries.Action = [
    "agent-registry:GetDiscoverableRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ];
  predecessorReadRecords.Action = [
    "agent-registry:GetRegistryRecord",
    "agent-registry:UpdateRegistryRecordStatus",
  ];
  const batchReadPredecessorPolicy = structuredClone(predecessorPolicy);
  const batchReadPredecessorList =
    batchReadPredecessorPolicy.Statement.find(
      ({ Sid }) => Sid === "ReadControlPlaneRegistries",
    );
  batchReadPredecessorList.Action = [
    "agent-registry:BatchGetDiscoverableRegistryRecord",
    "agent-registry:ListRegistryRecords",
  ];
  // Predecessor registration: boundary source as of 940713a (deployed
  // 2026-09-02), before the provider-function resources moved to the
  // ${PROVISIONED_NAME_PREFIX} template placeholder. Differs from the
  // committed source only in the two provider resource prefixes.
  const provisionedNamePrefixPredecessorPolicy =
    structuredClone(legacyScopedPolicy);
  provisionedNamePrefixPredecessorPolicy.Statement.find(
    ({ Sid }) => Sid === "InvokeControlPlaneProviderFunctions",
  ).Resource = [
    `arn:${REQUIRED_PARTITION}:lambda:${region}:${accountId}:`
      + `function:${CONTROL_PLANE_ROLE_PREFIX}*`,
  ];
  provisionedNamePrefixPredecessorPolicy.Statement.find(
    ({ Sid }) => Sid === "StartControlPlaneProviderWaiter",
  ).Resource = [
    `arn:${REQUIRED_PARTITION}:states:${region}:${accountId}:`
      + `stateMachine:${CONTROL_PLANE_ROLE_PREFIX}*`,
  ];
  // PR #6 (0083196) added registry/*/record/* to this statement; the 940713a
  // predecessor deployed on 2026-09-02 only had registry/*.
  provisionedNamePrefixPredecessorPolicy.Statement.find(
    ({ Sid }) => Sid === "CreateTaggedControlPlaneRegistryRecords",
  ).Resource = [
    `arn:${REQUIRED_PARTITION}:agent-registry:${region}:${accountId}:`
      + "registry/*",
  ];
  const policyDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-policy",
      ["--policy-arn", boundaryArn],
    ),
    "Control-plane runtime permissions boundary inspection",
  );
  const policy = policyDocument.Policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new AuditValidationError(
      "Control-plane runtime permissions boundary inspection must return "
        + "one Policy object.",
      "INVALID_CONTROL_PLANE_RUNTIME_BOUNDARY",
    );
  }
  if (
    policy.Arn !== boundaryArn
    || policy.PolicyName
      !== CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME
  ) {
    throw new AuditValidationError(
      "Control-plane runtime permissions boundary metadata is inconsistent.",
      "CONTROL_PLANE_RUNTIME_BOUNDARY_METADATA_MISMATCH",
    );
  }
  if (
    typeof policy.DefaultVersionId !== "string"
    || !/^v[1-9][0-9]*$/.test(policy.DefaultVersionId)
  ) {
    throw new AuditValidationError(
      "Control-plane runtime permissions boundary must have a valid "
        + "default version.",
      "INVALID_CONTROL_PLANE_RUNTIME_BOUNDARY_VERSION",
    );
  }

  const tagDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-policy-tags",
      ["--policy-arn", boundaryArn],
    ),
    "Control-plane runtime permissions boundary tag inspection",
  );
  verifyCompletePolicyTagDocument(
    tagDocument,
    "Control-plane runtime permissions boundary",
  );

  const versionDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-policy-version",
      [
        "--policy-arn",
        boundaryArn,
        "--version-id",
        policy.DefaultVersionId,
      ],
    ),
    "Control-plane runtime permissions boundary version inspection",
  );
  const policyVersion = versionDocument.PolicyVersion;
  if (
    !policyVersion
    || typeof policyVersion !== "object"
    || Array.isArray(policyVersion)
    || policyVersion.VersionId !== policy.DefaultVersionId
    || policyVersion.IsDefaultVersion !== true
  ) {
    throw new AuditValidationError(
      "Control-plane runtime permissions boundary version metadata "
        + "is inconsistent.",
      "CONTROL_PLANE_RUNTIME_BOUNDARY_VERSION_MISMATCH",
    );
  }
  const deployedPolicy = decodePolicyDocument(
    policyVersion.Document,
    "Control-plane runtime permissions boundary",
  );
  const policyContent = canonicalPolicyContent(deployedPolicy);
  if (
    policyContent !== canonicalPolicyContent(expectedPolicy)
    && !(
      allowPlannedTransition
      && (
        policyContent === canonicalPolicyContent(predecessorPolicy)
        || policyContent
          === canonicalPolicyContent(batchReadPredecessorPolicy)
        || policyContent === canonicalPolicyContent(
          provisionedNamePrefixPredecessorPolicy,
        )
      )
    )
  ) {
    throw new AuditValidationError(
      "Control-plane runtime permissions boundary policy has drifted "
        + "from the committed source.",
      "CONTROL_PLANE_RUNTIME_BOUNDARY_DRIFT",
    );
  }

  return {
    arn: boundaryArn,
    defaultVersionId: policy.DefaultVersionId,
    policyMatches: true,
    required: true,
    status: "passed",
    tagsMatch: true,
  };
}

function requireCompleteIamList(document, property, label) {
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || !isCompleteIamListResponse(document)
    || !Array.isArray(document[property])
  ) {
    throw new AuditValidationError(
      `${label} must be complete and non-paginated.`,
      "INVALID_CONTROL_PLANE_EXECUTION_POLICY_LIST",
    );
  }
  return document[property];
}

function policyDocumentStatements(document, label) {
  const decoded = decodePolicyDocument(document, label);
  if (
    decoded.Version !== "2012-10-17"
    || !Array.isArray(decoded.Statement)
    || decoded.Statement.some(
      (statement) =>
        !statement
        || typeof statement !== "object"
        || Array.isArray(statement),
    )
  ) {
    throw new AuditValidationError(
      `${label} must be a valid IAM policy document.`,
      "INVALID_CONTROL_PLANE_EXECUTION_POLICY",
    );
  }
  return { document: decoded, statements: decoded.Statement };
}

function inspectManagedPolicyDocument({
  accountId,
  cwd,
  policyName,
  runCommand,
}) {
  const policyArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:policy/${policyName}`;
  const metadataDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-policy",
      ["--policy-arn", policyArn],
    ),
    `${policyName} managed policy inspection`,
  );
  const policy = metadataDocument.Policy;
  if (
    !policy
    || typeof policy !== "object"
    || Array.isArray(policy)
    || policy.Arn !== policyArn
    || policy.PolicyName !== policyName
    || typeof policy.DefaultVersionId !== "string"
    || !/^v[1-9][0-9]*$/.test(policy.DefaultVersionId)
  ) {
    throw new AuditValidationError(
      `${policyName} managed policy metadata is inconsistent.`,
      "CONTROL_PLANE_EXECUTION_POLICY_METADATA_MISMATCH",
    );
  }
  const versionDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-policy-version",
      [
        "--policy-arn",
        policyArn,
        "--version-id",
        policy.DefaultVersionId,
      ],
    ),
    `${policyName} managed policy version inspection`,
  );
  const policyVersion = versionDocument.PolicyVersion;
  if (
    !policyVersion
    || typeof policyVersion !== "object"
    || Array.isArray(policyVersion)
    || policyVersion.VersionId !== policy.DefaultVersionId
    || policyVersion.IsDefaultVersion !== true
  ) {
    throw new AuditValidationError(
      `${policyName} managed policy version metadata is inconsistent.`,
      "CONTROL_PLANE_EXECUTION_POLICY_VERSION_MISMATCH",
    );
  }
  return policyDocumentStatements(
    policyVersion.Document,
    `${policyName} managed policy`,
  );
}

function expectedControlPlaneBoundaryEnforcementStatements(accountId) {
  const roleArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
    + `${CONTROL_PLANE_ROLE_PREFIX}*`;
  const boundaryArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:policy/`
    + CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME;
  return [
    {
      Sid: "CreateControlPlaneIamRolesWithBoundary",
      Effect: "Allow",
      Action: "iam:CreateRole",
      Resource: roleArn,
      Condition: {
        "ForAllValues:StringEquals": {
          "aws:TagKeys": [...REQUIRED_TAGS.keys()].sort(),
        },
        StringEquals: {
          ...Object.fromEntries(
            [...REQUIRED_TAGS].map(([key, value]) => [
              `aws:RequestTag/${key}`,
              value,
            ]),
          ),
          "iam:PermissionsBoundary": boundaryArn,
        },
      },
    },
    {
      Sid: "ApplyControlPlaneRoleBoundary",
      Effect: "Allow",
      Action: "iam:PutRolePermissionsBoundary",
      Resource: roleArn,
      Condition: {
        StringEquals: {
          "iam:PermissionsBoundary": boundaryArn,
        },
      },
    },
    {
      Sid: "DenyControlPlaneRoleBoundaryRemoval",
      Effect: "Deny",
      Action: "iam:DeleteRolePermissionsBoundary",
      Resource: roleArn,
    },
    {
      Sid: "ManageControlPlaneIamRoles",
      Effect: "Allow",
      Action: [
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:PutRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:UpdateRole",
        "iam:UpdateRoleDescription",
      ],
      Resource: roleArn,
    },
    ...[
      ["PassControlPlaneRolesToLambda", "lambda.amazonaws.com"],
      ["PassControlPlaneRolesToStepFunctions", "states.amazonaws.com"],
      [
        "PassControlPlaneRolesToAgentCore",
        "bedrock-agentcore.amazonaws.com",
      ],
    ].map(([Sid, service]) => ({
      Sid,
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: roleArn,
      Condition: {
        StringEquals: {
          "iam:PassedToService": service,
        },
      },
    })),
  ];
}

function expectedStage1SensitiveRoleStatements(accountId) {
  const roleArns = PLATFORM_WEB_RUNTIME_ROLE_NAMES.map((roleName) =>
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/${roleName}`
  );
  const hostedAcceptanceRoleArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
    + HOSTED_ACCEPTANCE_ROLE_NAME;
  const managedRoleArns = [...roleArns, hostedAcceptanceRoleArn];
  const controlPlaneRoleArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
    + `${CONTROL_PLANE_ROLE_PREFIX}*`;
  const boundaryArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:policy/`
    + RUNTIME_PERMISSIONS_BOUNDARY_NAME;
  return [
    {
      Effect: "Allow",
      Action: "iam:CreateRole",
      Resource: roleArns,
      Condition: {
        StringEquals: {
          "iam:PermissionsBoundary": boundaryArn,
        },
      },
    },
    {
      Effect: "Allow",
      Action: "iam:CreateRole",
      Resource: hostedAcceptanceRoleArn,
      Condition: {
        "ForAllValues:StringEquals": {
          "aws:TagKeys": [...REQUIRED_TAGS.keys()].sort(),
        },
        StringEquals: Object.fromEntries(
          [...REQUIRED_TAGS].map(([key, value]) => [
            `aws:RequestTag/${key}`,
            value,
          ]),
        ),
      },
    },
    {
      Effect: "Allow",
      Action: [
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:PutRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:UpdateRole",
        "iam:UpdateRoleDescription",
      ],
      Resource: managedRoleArns,
    },
    {
      Effect: "Allow",
      Action: [
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
      ],
      Resource: controlPlaneRoleArn,
      Condition: {
        ArnEquals: {
          "iam:PolicyARN":
            `arn:${REQUIRED_PARTITION}:iam::aws:policy/service-role/`
            + "AWSLambdaBasicExecutionRole",
        },
      },
    },
    {
      Effect: "Allow",
      Action: "iam:PutRolePermissionsBoundary",
      Resource: roleArns,
      Condition: {
        StringEquals: {
          "iam:PermissionsBoundary": boundaryArn,
        },
      },
    },
    {
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: roleArns,
      Condition: {
        StringEquals: {
          "iam:PassedToService": "lambda.amazonaws.com",
        },
      },
    },
    {
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource:
        `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
        + "AgenticPlatform-Web-AgentRuntimeRole",
      Condition: {
        StringEquals: {
          "iam:PassedToService": "bedrock-agentcore.amazonaws.com",
        },
      },
    },
  ];
}

function expectedControlPlaneAdditionalSensitiveStatements(accountId) {
  return [
    {
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource:
        `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/aws-service-role/`
        + "application-signals.cloudwatch.amazonaws.com/"
        + "AWSServiceRoleForCloudWatchApplicationSignals",
      Condition: {
        StringEquals: {
          "iam:AWSServiceName": "application-signals.cloudwatch.amazonaws.com",
        },
      },
    },
    {
      Effect: "Allow",
      Action: [
        "iam:CreatePolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      Resource:
        `arn:${REQUIRED_PARTITION}:iam::${accountId}:policy/`
        + CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME,
    },
    {
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource:
        `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/aws-service-role/`
        + "agent-registry.amazonaws.com/AWSServiceRoleForAgentRegistry",
      Condition: {
        StringEquals: {
          "iam:AWSServiceName": "agent-registry.amazonaws.com",
        },
      },
    },
    {
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource:
        `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/aws-service-role/`
        + "runtime-identity.bedrock-agentcore.amazonaws.com/"
        + "AWSServiceRoleForBedrockAgentCoreRuntimeIdentity",
      Condition: {
        StringEquals: {
          "iam:AWSServiceName":
            "runtime-identity.bedrock-agentcore.amazonaws.com",
        },
      },
    },
  ];
}

function iamActionPatternMatches(pattern, action) {
  if (typeof pattern !== "string") {
    return false;
  }
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${expression}$`, "i").test(action);
}

function iamActionPatternCanMutate(pattern) {
  if (typeof pattern !== "string") {
    return true;
  }
  const separator = pattern.indexOf(":");
  if (separator === -1) {
    return iamActionPatternMatches(pattern, "iam:PutRolePolicy");
  }
  const servicePattern = pattern.slice(0, separator);
  const actionPattern = pattern.slice(separator + 1);
  const targetsIam = iamActionPatternMatches(
    `${servicePattern}:*`,
    "iam:AnyAction",
  );
  if (!targetsIam) {
    return false;
  }
  return !(
    servicePattern.toLowerCase() === "iam"
    && /^(?:Get|List)[A-Za-z0-9*?]*$/i.test(actionPattern)
  );
}

function statementAllowsSensitiveIamMutation(statement) {
  if (statement.Effect !== "Allow") {
    return false;
  }
  if (statement.NotAction !== undefined) {
    return true;
  }
  const actions = Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action];
  return actions.some(iamActionPatternCanMutate);
}

function inspectControlPlaneExecutionRole({
  accountId,
  cwd,
  region,
  runCommand,
}) {
  const roleArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
    + CLOUDFORMATION_EXECUTION_ROLE_NAME;
  const roleDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-role",
      ["--role-name", CLOUDFORMATION_EXECUTION_ROLE_NAME],
    ),
    "Control-plane CloudFormation execution role inspection",
  );
  const role = roleDocument.Role;
  if (
    !role
    || typeof role !== "object"
    || Array.isArray(role)
    || role.RoleName !== CLOUDFORMATION_EXECUTION_ROLE_NAME
    || role.Arn !== roleArn
  ) {
    throw new AuditValidationError(
      "Control-plane CloudFormation execution role metadata is inconsistent.",
      "CONTROL_PLANE_EXECUTION_ROLE_MISMATCH",
    );
  }
  const expectedTrust = {
    Version: "2012-10-17",
    Statement: [{
      Action: "sts:AssumeRole",
      Effect: "Allow",
      Principal: { Service: "cloudformation.amazonaws.com" },
    }],
  };
  if (
    canonicalPolicyContent(
      decodePolicyDocument(
        role.AssumeRolePolicyDocument,
        "Control-plane CloudFormation execution role trust policy",
      ),
    ) !== canonicalPolicyContent(expectedTrust)
  ) {
    throw new AuditValidationError(
      "Control-plane CloudFormation execution role trust policy has drifted.",
      "CONTROL_PLANE_EXECUTION_ROLE_TRUST_DRIFT",
    );
  }

  const attachedDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-attached-role-policies",
      ["--role-name", CLOUDFORMATION_EXECUTION_ROLE_NAME],
    ),
    "Control-plane execution role attached policy inspection",
  );
  const attachedPolicies = requireCompleteIamList(
    attachedDocument,
    "AttachedPolicies",
    "Control-plane execution role attached policy inspection",
  );
  const observedAttachedPolicies = new Map();
  const observedAttachedPolicyArns = new Set();
  for (const policy of attachedPolicies) {
    if (
      !policy
      || typeof policy !== "object"
      || Array.isArray(policy)
      || typeof policy.PolicyName !== "string"
      || typeof policy.PolicyArn !== "string"
      || observedAttachedPolicies.has(policy.PolicyName)
      || observedAttachedPolicyArns.has(policy.PolicyArn)
    ) {
      throw new AuditValidationError(
        "Control-plane execution role attached policy list is malformed.",
        "INVALID_CONTROL_PLANE_EXECUTION_ATTACHED_POLICY",
      );
    }
    observedAttachedPolicies.set(policy.PolicyName, policy.PolicyArn);
    observedAttachedPolicyArns.add(policy.PolicyArn);
  }
  if (
    observedAttachedPolicies.size !== CONTROL_PLANE_EXECUTION_POLICY_NAMES.length
    || CONTROL_PLANE_EXECUTION_POLICY_NAMES.some(
      (policyName) =>
        observedAttachedPolicies.get(policyName)
          !== `arn:${REQUIRED_PARTITION}:iam::${accountId}:policy/${policyName}`,
    )
  ) {
    throw new AuditValidationError(
      "Control-plane execution role must have exactly "
        + `${CONTROL_PLANE_EXECUTION_POLICY_NAMES.length} declared managed `
        + "policies.",
      "CONTROL_PLANE_EXECUTION_ATTACHED_POLICY_DRIFT",
    );
  }

  const inlineDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-role-policies",
      ["--role-name", CLOUDFORMATION_EXECUTION_ROLE_NAME],
    ),
    "Control-plane execution role inline policy inspection",
  );
  const inlinePolicyNames = requireCompleteIamList(
    inlineDocument,
    "PolicyNames",
    "Control-plane execution role inline policy inspection",
  );
  if (
    inlinePolicyNames.length !== 1
    ||
    inlinePolicyNames.some(
      (policyName) =>
        typeof policyName !== "string"
        || policyName.length === 0,
    )
    || new Set(inlinePolicyNames).size !== inlinePolicyNames.length
  ) {
    throw new AuditValidationError(
      "Control-plane execution role inline policy list is malformed.",
      "INVALID_CONTROL_PLANE_EXECUTION_INLINE_POLICY",
    );
  }
  if (
    inlinePolicyNames[0] !== CONTROL_PLANE_EXECUTION_INLINE_POLICY_NAME
  ) {
    throw new AuditValidationError(
      "Control-plane execution role canonical inline policy is missing.",
      "CONTROL_PLANE_EXECUTION_INLINE_POLICY_MISMATCH",
    );
  }

  const managedPolicies = new Map();
  const allStatements = [];
  let inlinePolicy;
  for (const policyName of CONTROL_PLANE_EXECUTION_POLICY_NAMES) {
    const inspected = inspectManagedPolicyDocument({
      accountId,
      cwd,
      policyName,
      runCommand,
    });
    managedPolicies.set(policyName, inspected);
    allStatements.push(...inspected.statements);
  }
  for (const policyName of inlinePolicyNames) {
    const policyDocument = parseJsonOutput(
      runAws(
        runCommand,
        cwd,
        "iam",
        "get-role-policy",
        [
          "--role-name",
          CLOUDFORMATION_EXECUTION_ROLE_NAME,
          "--policy-name",
          policyName,
        ],
      ),
      `${policyName} execution role inline policy inspection`,
    );
    if (
      policyDocument.RoleName !== CLOUDFORMATION_EXECUTION_ROLE_NAME
      || policyDocument.PolicyName !== policyName
    ) {
      throw new AuditValidationError(
        `${policyName} execution role inline policy metadata is inconsistent.`,
        "CONTROL_PLANE_EXECUTION_INLINE_POLICY_MISMATCH",
      );
    }
    const inspected = policyDocumentStatements(
      policyDocument.PolicyDocument,
      `${policyName} execution role inline policy`,
    );
    inlinePolicy = inspected;
    allStatements.push(...inspected.statements);
  }

  const deploymentPolicy = managedPolicies.get(
    CONTROL_PLANE_DEPLOYMENT_POLICY_NAME,
  );
  const expectedStatements =
    expectedControlPlaneBoundaryEnforcementStatements(accountId);
  const allowedSensitiveStatements = new Set();
  for (const expectedStatement of expectedStatements) {
    const matches = deploymentPolicy.statements.filter(
      (statement) => statement.Sid === expectedStatement.Sid,
    );
    if (
      matches.length !== 1
      || canonicalPolicyContent(matches[0])
        !== canonicalPolicyContent(expectedStatement)
    ) {
      throw new AuditValidationError(
        "Control-plane execution role boundary enforcement has drifted "
          + `at ${expectedStatement.Sid}.`,
        "CONTROL_PLANE_EXECUTION_BOUNDARY_ENFORCEMENT_DRIFT",
      );
    }
    if (expectedStatement.Effect === "Allow") {
      allowedSensitiveStatements.add(matches[0]);
    }
  }

  const allowedSensitiveStatementContents = new Set(
    [
      ...expectedStage1SensitiveRoleStatements(accountId),
      ...expectedControlPlaneAdditionalSensitiveStatements(accountId),
      ...[...allowedSensitiveStatements],
    ].map(canonicalPolicyContent),
  );
  for (const statement of allStatements) {
    if (
      statementAllowsSensitiveIamMutation(statement)
      && !allowedSensitiveStatementContents.has(
        canonicalPolicyContent(statement),
      )
    ) {
      throw new AuditValidationError(
        "Control-plane execution role has an alternate unbounded CreateRole, "
          + "permissions-boundary, PassRole, or other IAM escalation path.",
        "CONTROL_PLANE_EXECUTION_ALTERNATE_ROLE_PATH",
      );
    }
  }

  for (const [policyName, inspected] of managedPolicies) {
    if (
      executionRolePolicyHash(inspected.document, { accountId, region })
        !== CONTROL_PLANE_EXECUTION_MANAGED_POLICY_HASHES.get(policyName)
    ) {
      throw new AuditValidationError(
        `Control-plane execution-role managed policy ${policyName} `
          + "has drifted from the canonical bootstrap policy.",
        "CONTROL_PLANE_EXECUTION_MANAGED_POLICY_DRIFT",
      );
    }
  }
  if (
    !inlinePolicy
    || executionRolePolicyHash(inlinePolicy.document, { accountId, region })
      !== CONTROL_PLANE_EXECUTION_INLINE_POLICY_HASH
  ) {
    throw new AuditValidationError(
      "Control-plane execution-role inline policy has drifted from "
        + "the canonical bootstrap policy.",
      "CONTROL_PLANE_EXECUTION_INLINE_POLICY_DRIFT",
    );
  }

  return {
    arnMatches: true,
    attachedPoliciesMatch: true,
    boundaryEnforcementMatches: true,
    required: true,
    roleName: CLOUDFORMATION_EXECUTION_ROLE_NAME,
    status: "passed",
    trustMatches: true,
  };
}

function inspectProvisionedControlPlaneRoles({
  accountId,
  cwd,
  region,
  runCommand,
  stackName,
}) {
  const boundaryArn =
    `arn:${REQUIRED_PARTITION}:iam::${accountId}:policy/`
    + CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME;
  const resourcesDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "cloudformation",
      "list-stack-resources",
      ["--stack-name", stackName],
    ),
    "Provisioned control-plane stack resource inspection",
  );
  if (
    resourcesDocument.NextToken !== undefined
    || !Array.isArray(resourcesDocument.StackResourceSummaries)
  ) {
    throw new AuditValidationError(
      "Provisioned control-plane stack resource inspection must be complete "
        + "and non-paginated.",
      "INVALID_PROVISIONED_CONTROL_PLANE_RESOURCES",
    );
  }
  const roleInventory = [];
  const matchedExpectations = new Set();
  for (const resource of resourcesDocument.StackResourceSummaries) {
    if (
      !resource
      || typeof resource !== "object"
      || Array.isArray(resource)
      || typeof resource.LogicalResourceId !== "string"
      || resource.LogicalResourceId.length === 0
      || typeof resource.ResourceType !== "string"
      || resource.ResourceType.length === 0
      || typeof resource.ResourceStatus !== "string"
      || resource.ResourceStatus.length === 0
    ) {
      throw new AuditValidationError(
        "Provisioned control-plane stack contains a malformed resource.",
        "INVALID_PROVISIONED_CONTROL_PLANE_RESOURCE",
      );
    }
    if (
      resource.ResourceType !== "AWS::IAM::Role"
      || resource.ResourceStatus === "DELETE_COMPLETE"
    ) {
      continue;
    }
    if (
      typeof resource.PhysicalResourceId !== "string"
      || !IAM_NAME_PATTERN.test(resource.PhysicalResourceId)
    ) {
      throw new AuditValidationError(
        "Provisioned control-plane role has an invalid physical role name.",
        "INVALID_PROVISIONED_CONTROL_PLANE_ROLE_NAME",
      );
    }
    // CloudFormation truncates generated IAM names to fit service limits.
    // Ownership is established by this stack's exact logical-role inventory
    // and the account ARN, trust, tags and boundary verified below.
    const expectationMatches =
      PROVISIONED_CONTROL_PLANE_ROLE_EXPECTATIONS.filter(
        ({ logicalIdPattern }) =>
          logicalIdPattern.test(resource.LogicalResourceId),
      );
    if (
      expectationMatches.length !== 1
      || matchedExpectations.has(expectationMatches[0])
    ) {
      throw new AuditValidationError(
        "Provisioned control-plane role inventory contains an unknown, "
          + "duplicate, or unexpected logical resource ID.",
        "INVALID_PROVISIONED_CONTROL_PLANE_ROLE_INVENTORY",
      );
    }
    matchedExpectations.add(expectationMatches[0]);
    roleInventory.push({
      expectation: expectationMatches[0],
      logicalResourceId: resource.LogicalResourceId,
      roleName: resource.PhysicalResourceId,
    });
  }
  if (
    roleInventory.length !== PROVISIONED_CONTROL_PLANE_ROLE_EXPECTATIONS.length
    || matchedExpectations.size
      !== PROVISIONED_CONTROL_PLANE_ROLE_EXPECTATIONS.length
    || new Set(roleInventory.map(({ roleName }) => roleName)).size
      !== roleInventory.length
  ) {
    throw new AuditValidationError(
      "Provisioned control-plane stack must contain exactly the expected "
        + "unique IAM role inventory.",
      "INVALID_PROVISIONED_CONTROL_PLANE_ROLE_INVENTORY",
    );
  }

  const roles = [];
  for (const {
    expectation,
    logicalResourceId,
    roleName,
  } of roleInventory) {
    const roleDocument = parseJsonOutput(
      runAws(
        runCommand,
        cwd,
        "iam",
        "get-role",
        ["--role-name", roleName],
      ),
      `${roleName} provisioned control-plane role inspection`,
    );
    const role = roleDocument.Role;
    if (
      !role
      || typeof role !== "object"
      || Array.isArray(role)
      || role.RoleName !== roleName
      || role.Arn
        !== `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/${roleName}`
    ) {
      throw new AuditValidationError(
        "Provisioned control-plane role must have the exact root-path ARN.",
        "PROVISIONED_CONTROL_PLANE_ROLE_ARN_MISMATCH",
      );
    }
    const expectedTrust = {
      Version: "2012-10-17",
      Statement: [{
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: { Service: expectation.service },
        ...(expectation.service === "bedrock-agentcore.amazonaws.com"
          ? {
            Condition: {
              ArnLike: {
                "aws:SourceArn":
                  `arn:${REQUIRED_PARTITION}:bedrock-agentcore:${region}:`
                  + `${accountId}:gateway/*`,
              },
              StringEquals: {
                "aws:SourceAccount": accountId,
              },
            },
          }
          : {}),
      }],
    };
    if (
      canonicalPolicyContent(
        decodePolicyDocument(
          role.AssumeRolePolicyDocument,
          `${roleName} provisioned control-plane role trust policy`,
        ),
      ) !== canonicalPolicyContent(expectedTrust)
    ) {
      throw new AuditValidationError(
        "Provisioned control-plane role trust policy has drifted "
          + `for ${roleName}.`,
        "PROVISIONED_CONTROL_PLANE_ROLE_TRUST_DRIFT",
      );
    }
    verifyExactTagList(
      role.Tags,
      `${roleName} provisioned control-plane role mandatory tags`,
    );
    if (
      role.PermissionsBoundary?.PermissionsBoundaryArn !== boundaryArn
      || role.PermissionsBoundary?.PermissionsBoundaryType !== "Policy"
    ) {
      throw new AuditValidationError(
        "Provisioned control-plane role must have the exact runtime "
          + "permissions boundary.",
        "PROVISIONED_CONTROL_PLANE_ROLE_BOUNDARY_MISMATCH",
      );
    }
    roles.push({
      arnMatches: true,
      boundaryMatches: true,
      logicalResourceId,
      roleName,
      tagsMatch: true,
      trustMatches: true,
    });
  }

  return {
    boundaryName: CONTROL_PLANE_RUNTIME_PERMISSIONS_BOUNDARY_NAME,
    required: true,
    roles,
    status: "passed",
  };
}

function journeyBoundaryConfiguration(env, accountId, region) {
  const modelId =
    env.JOURNEY_INCEPTION_MODEL_ID?.trim()
    || DEFAULT_JOURNEY_INCEPTION_MODEL_ID;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(modelId)
    || /^(?:eu|apac)\./.test(modelId)
  ) {
    throw new AuditValidationError(
      "JOURNEY_INCEPTION_MODEL_ID is invalid.",
      "INVALID_JOURNEY_INCEPTION_MODEL_ID",
    );
  }
  const profile = /^(global|us)\.(.+)$/.exec(modelId);
  const modelArns = profile
    ? [
        `arn:${REQUIRED_PARTITION}:bedrock:${region}:${accountId}:`
          + `inference-profile/${modelId}`,
        ...(profile[1] === "global"
          ? [
              `arn:${REQUIRED_PARTITION}:bedrock:::`
                + `foundation-model/${profile[2]}`,
              `arn:${REQUIRED_PARTITION}:bedrock:${region}::`
                + `foundation-model/${profile[2]}`,
            ]
          : ["us-east-1", "us-east-2", "us-west-2"].map(
              (modelRegion) =>
                `arn:${REQUIRED_PARTITION}:bedrock:${modelRegion}::`
                + `foundation-model/${profile[2]}`,
            )),
      ]
    : [
        `arn:${REQUIRED_PARTITION}:bedrock:${region}::`
          + `foundation-model/${modelId}`,
      ];
  const clientId = env.JOURNEY_GITHUB_OAUTH_CLIENT_ID?.trim() || null;
  const secretArn =
    env.JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN?.trim() || null;
  const secretPrefix =
    `arn:${REQUIRED_PARTITION}:secretsmanager:${region}:${accountId}:secret:`;
  if ((clientId === null) !== (secretArn === null)) {
    throw new AuditValidationError(
      "GitHub OAuth App configuration must be complete.",
      "INVALID_JOURNEY_GITHUB_OAUTH_CONFIGURATION",
    );
  }
  if (clientId && !/^[A-Za-z0-9.]{20}$/.test(clientId)) {
    throw new AuditValidationError(
      "JOURNEY_GITHUB_OAUTH_CLIENT_ID is invalid.",
      "INVALID_JOURNEY_GITHUB_OAUTH_CLIENT_ID",
    );
  }
  if (
    secretArn
    && (
      !secretArn.startsWith(secretPrefix)
      || secretArn.length === secretPrefix.length
      || secretArn.includes("*")
    )
  ) {
    throw new AuditValidationError(
      "JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN is invalid.",
      "INVALID_JOURNEY_GITHUB_OAUTH_CLIENT_SECRET_ARN",
    );
  }
  return {
    journeyGithubOAuthClientSecretArn: secretArn,
    journeyInceptionModelArns: [],
    journeyPredecessorInceptionModelArns: modelArns,
  };
}

function inspectRuntimeBoundary({
  accountId,
  allowPlannedTransition,
  controlPlaneResources,
  cwd,
  evidence,
  env,
  region,
  runCommand,
}) {
  const boundaryArn =
    `arn:aws:iam::${accountId}:policy/`
    + RUNTIME_PERMISSIONS_BOUNDARY_NAME;
  const providerResources = inspectCloudFrontProviderResources({
    accountId,
    allowPlannedTransition,
    cwd,
    runCommand,
  });
  const predecessorSource = structuredClone(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
  );
  const gatewayIsolationPredecessorSource = structuredClone(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
  );
  gatewayIsolationPredecessorSource.Statement =
    gatewayIsolationPredecessorSource.Statement.filter(
      ({ Sid }) =>
        Sid !== "AssumeGatewayInvokerRole"
        && Sid !== "ReadRuntimeInvocationProofSecret"
        && Sid !== "WriteRuntimeInvocationProofSecret",
    );
  const gatewayIsolationInvoke =
    gatewayIsolationPredecessorSource.Statement.find(
      ({ Sid }) => Sid === "InvokeControlPlaneLlmGateway",
    );
  if (
    !gatewayIsolationInvoke
    || !Array.isArray(gatewayIsolationInvoke.Action)
    || !gatewayIsolationInvoke.Action.includes(
      "bedrock-agentcore:InvokeGateway",
    )
  ) {
    throw new AuditValidationError(
      "Gateway-isolation boundary transition source is inconsistent.",
      "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
    );
  }
  gatewayIsolationInvoke.Action = [
    "bedrock-agentcore:InvokeGateway",
  ];
  delete gatewayIsolationInvoke.Condition;
  const gatewayIsolationFinalizer =
    gatewayIsolationPredecessorSource.Statement.find(
      ({ Sid }) => Sid === "InvokeRegistryDecisionFinalizer",
    );
  if (
    !gatewayIsolationFinalizer
    || !Array.isArray(gatewayIsolationFinalizer.Resource)
    || !gatewayIsolationFinalizer.Resource.includes(
      "${REGISTRY_DECISION_FINALIZER_FUNCTION_ARN}",
    )
    || !gatewayIsolationFinalizer.Resource.includes(
      "${RUNTIME_PROOF_CONFIGURATOR_FUNCTION_ARN}",
    )
  ) {
    throw new AuditValidationError(
      "Runtime-proof boundary transition source is inconsistent.",
      "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
    );
  }
  gatewayIsolationFinalizer.Resource = [
    "${REGISTRY_DECISION_FINALIZER_FUNCTION_ARN}",
  ];
  const invocationJournalPredecessorSource = structuredClone(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
  );
  invocationJournalPredecessorSource.Statement =
    invocationJournalPredecessorSource.Statement.filter(
      ({ Sid }) => Sid !== "UpdateExperienceInvocation",
    );
  for (const sid of ["ReadPlatformState", "WritePlatformState"]) {
    const statement = invocationJournalPredecessorSource.Statement.find(
      (candidate) => candidate.Sid === sid,
    );
    const leadingKeys =
      statement?.Condition?.["ForAllValues:StringLike"]?.[
        "dynamodb:LeadingKeys"
      ];
    if (
      !Array.isArray(leadingKeys)
      || !leadingKeys.includes("EXPERIENCE_INVOCATION#*")
    ) {
      throw new AuditValidationError(
        "Invocation-journal boundary transition source is inconsistent.",
        "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
      );
    }
    statement.Condition["ForAllValues:StringLike"][
      "dynamodb:LeadingKeys"
    ] = leadingKeys.filter(
      (key) => key !== "EXPERIENCE_INVOCATION#*",
    );
  }
  const discoverableResourcePredecessorSource = structuredClone(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
  );
  const registryReadTransitions = [
    [
      "ListControlPlaneRegistries",
      "ReadControlPlaneRegistryRecords",
    ],
    [
      "ListDynamicControlPlaneRegistries",
      "ReadDynamicControlPlaneRegistryRecords",
    ],
  ];
  for (const [listSid, readSid] of registryReadTransitions) {
    const listStatement =
      discoverableResourcePredecessorSource.Statement.find(
        (candidate) => candidate.Sid === listSid,
      );
    const readStatement =
      discoverableResourcePredecessorSource.Statement.find(
        (candidate) => candidate.Sid === readSid,
      );
    if (
      !listStatement
      || !readStatement
      || !Array.isArray(listStatement.Action)
      || !Array.isArray(readStatement.Action)
      || listStatement.Action.includes(
        "agent-registry:GetDiscoverableRegistryRecord",
      )
      || !readStatement.Action.includes(
        "agent-registry:GetDiscoverableRegistryRecord",
      )
    ) {
      throw new AuditValidationError(
        "Discoverable-read boundary transition source is inconsistent.",
        "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
      );
    }
    listStatement.Action.push(
      "agent-registry:GetDiscoverableRegistryRecord",
    );
    readStatement.Action = readStatement.Action.filter(
      (action) =>
        action !== "agent-registry:GetDiscoverableRegistryRecord",
    );
  }
  const batchReadPredecessorSource = structuredClone(
    discoverableResourcePredecessorSource,
  );
  const deleteConditionPredecessorSource = structuredClone(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
  );
  const transactionAuthorizationPredecessorSource = structuredClone(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
  );
  const journeyPredecessorSource = structuredClone(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
  );
  journeyPredecessorSource.Statement =
    journeyPredecessorSource.Statement.filter(
      ({ Sid }) => Sid !== "ReadJourneyGitHubOAuthClientSecret",
    );
  const legacyPlatformStateWrite =
    transactionAuthorizationPredecessorSource.Statement.find(
      ({ Sid }) => Sid === "WritePlatformState",
    );
  if (
    !legacyPlatformStateWrite
    || canonicalPolicyContent(legacyPlatformStateWrite.Action)
      !== canonicalPolicyContent(["dynamodb:PutItem"])
  ) {
    throw new AuditValidationError(
      "Transaction authorization boundary transition source is inconsistent.",
      "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
    );
  }
  legacyPlatformStateWrite.Action = [
    "dynamodb:PutItem",
    "dynamodb:TransactWriteItems",
  ];
  for (const sid of [
    "ListControlPlaneRegistries",
    "ListDynamicControlPlaneRegistries",
  ]) {
    const statement = batchReadPredecessorSource.Statement.find(
      (candidate) => candidate.Sid === sid,
    );
    if (
      !statement
      || !Array.isArray(statement.Action)
      || !statement.Action.includes(
        "agent-registry:GetDiscoverableRegistryRecord",
      )
    ) {
      throw new AuditValidationError(
        "Batch-read boundary transition source is inconsistent.",
        "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
      );
    }
    statement.Action = statement.Action.map((action) =>
      action === "agent-registry:GetDiscoverableRegistryRecord"
        ? "agent-registry:BatchGetDiscoverableRegistryRecord"
        : action
    );
  }
  const legacyMutateStatement =
    deleteConditionPredecessorSource.Statement.find(
      ({ Sid }) => Sid === "MutateHostedAcceptanceFixtureRecord",
    );
  const legacyDeleteStatement =
    deleteConditionPredecessorSource.Statement.find(
      ({ Sid }) => Sid === "DeleteHostedAcceptanceDomainRegistry",
    );
  if (!legacyMutateStatement || !legacyDeleteStatement) {
    throw new AuditValidationError(
      "DeleteRegistry boundary transition source is inconsistent.",
      "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
    );
  }
  legacyMutateStatement.Action = [
    ...legacyMutateStatement.Action,
    ...legacyDeleteStatement.Action,
  ];
  legacyMutateStatement.Resource = [
    ...legacyMutateStatement.Resource,
    ...legacyDeleteStatement.Resource,
  ];
  deleteConditionPredecessorSource.Statement =
    deleteConditionPredecessorSource.Statement.filter(
      ({ Sid }) => Sid !== "DeleteHostedAcceptanceDomainRegistry",
    );
  const omittedStatements = predecessorSource.Statement.filter(({ Sid }) =>
    DEPLOY_TRANSITION.omittedBoundaryStatementSids.has(Sid)
  );
  if (
    omittedStatements.length
      !== DEPLOY_TRANSITION.omittedBoundaryStatementSids.size
  ) {
    throw new AuditValidationError(
      "Task 3 boundary transition source is inconsistent.",
      "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
    );
  }
  predecessorSource.Statement = predecessorSource.Statement.filter(
    ({ Sid }) => !DEPLOY_TRANSITION.omittedBoundaryStatementSids.has(Sid),
  );
  const predecessorInvoke = predecessorSource.Statement.find(
    ({ Sid }) => Sid === "InvokeControlPlaneLlmGateway",
  );
  if (
    !predecessorInvoke
    || !Array.isArray(predecessorInvoke.Action)
    || !predecessorInvoke.Action.includes(
      "bedrock-agentcore:InvokeGateway",
    )
  ) {
    throw new AuditValidationError(
      "Task 3 gateway boundary transition source is inconsistent.",
      "INVALID_RUNTIME_BOUNDARY_TRANSITION_SOURCE",
    );
  }
  predecessorInvoke.Action = ["bedrock-agentcore:InvokeGateway"];
  delete predecessorInvoke.Condition;
  predecessorSource.Statement.push({
    Sid: "ReadWritePlatformState",
    Effect: "Allow",
    Action: [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:TransactWriteItems",
    ],
    Resource: ["${PLATFORM_STATE_TABLE_ARN}"],
  });
  const journeyBoundary = journeyBoundaryConfiguration(
    env,
    accountId,
    region,
  );
  const renderOptions = {
    accountId,
    alarmArnPattern: providerResources.alarmArnPattern,
    boundaryArn,
    controlPlaneResources,
    distributionArn: providerResources.distributionArn,
    gatewayInvokerRoleArn:
      `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
      + GATEWAY_INVOKER_ROLE_NAME,
    journeyGithubOAuthClientSecretArn:
      journeyBoundary.journeyGithubOAuthClientSecretArn,
    platformStateTableArn: providerResources.platformStateTableArn ?? "",
    region,
    runtimeProofConfiguratorRoleArn:
      `arn:${REQUIRED_PARTITION}:iam::${accountId}:role/`
      + "AgenticPlatform-Web-RuntimeProofConfiguratorRole",
    runtimeInvocationProofSecretArn:
      providerResources.runtimeInvocationProofSecretArn ?? "",
    userPoolArn: providerResources.userPoolArn ?? "",
  };
  const compact = (policy) =>
    compactRuntimeBoundary(policy, journeyBoundary);
  const renderedGatewayIsolationPredecessorPolicy =
    renderRuntimeBoundaryTemplate(
      gatewayIsolationPredecessorSource,
      renderOptions,
    );
  const gatewayIsolationPredecessorContent = canonicalPolicyContent(
    compact(
      renderedGatewayIsolationPredecessorPolicy,
    ),
  );
  const renderedPredecessorPolicy = renderRuntimeBoundaryTemplate(
    predecessorSource,
    renderOptions,
  );
  const predecessorContent = canonicalPolicyContent(
    compact(renderedPredecessorPolicy),
  );
  const renderedInvocationJournalPredecessorPolicy =
    renderRuntimeBoundaryTemplate(
      invocationJournalPredecessorSource,
      renderOptions,
    );
  const invocationJournalPredecessorContent = canonicalPolicyContent(
    compact(
      renderedInvocationJournalPredecessorPolicy,
    ),
  );
  const renderedBatchReadPredecessorPolicy = renderRuntimeBoundaryTemplate(
    batchReadPredecessorSource,
    renderOptions,
  );
  const batchReadPredecessorContent = canonicalPolicyContent(
    compact(renderedBatchReadPredecessorPolicy),
  );
  const renderedDiscoverableResourcePredecessorPolicy =
    renderRuntimeBoundaryTemplate(
      discoverableResourcePredecessorSource,
      renderOptions,
    );
  const discoverableResourcePredecessorContent = canonicalPolicyContent(
    compact(
      renderedDiscoverableResourcePredecessorPolicy,
    ),
  );
  const renderedDeleteConditionPredecessorPolicy =
    renderRuntimeBoundaryTemplate(
      deleteConditionPredecessorSource,
      renderOptions,
    );
  const deleteConditionPredecessorContent = canonicalPolicyContent(
    compact(renderedDeleteConditionPredecessorPolicy),
  );
  const renderedTransactionAuthorizationPredecessorPolicy =
    renderRuntimeBoundaryTemplate(
      transactionAuthorizationPredecessorSource,
      renderOptions,
    );
  const transactionAuthorizationPredecessorContent =
    canonicalPolicyContent(
      compact(
        renderedTransactionAuthorizationPredecessorPolicy,
      ),
    );
  const renderedJourneyPredecessorPolicy = renderRuntimeBoundaryTemplate(
    journeyPredecessorSource,
    renderOptions,
  );
  const journeyPredecessorContent = canonicalPolicyContent(
    compactRuntimeBoundary(renderedJourneyPredecessorPolicy, {
      journeyInceptionModelArns:
        journeyBoundary.journeyPredecessorInceptionModelArns,
    }),
  );
  const renderedTargetPolicy = renderRuntimeBoundaryTemplate(
    RUNTIME_PERMISSIONS_BOUNDARY_SOURCE,
    renderOptions,
  );
  const targetPolicy = compact(renderedTargetPolicy);
  const targetContent = canonicalPolicyContent(targetPolicy);
  Object.assign(evidence, {
    arn: boundaryArn,
    expectedHash: policyHash(
      providerResources.runtimeInvocationProofSecretArn === null
        ? gatewayIsolationPredecessorContent
        : targetContent,
    ),
    platformStateTableStatus: providerResources.platformStateTableStatus,
    platformStateTimeToLiveStatus:
      providerResources.platformStateTimeToLiveStatus,
    required: true,
    status: "checking",
  });

  const policyDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-policy",
      ["--policy-arn", boundaryArn],
    ),
    "Runtime permissions boundary inspection",
  );
  const policy = policyDocument.Policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new AuditValidationError(
      "Runtime permissions boundary inspection must return one Policy object.",
      "INVALID_RUNTIME_BOUNDARY",
    );
  }
  if (
    policy.Arn !== boundaryArn
    || policy.PolicyName !== RUNTIME_PERMISSIONS_BOUNDARY_NAME
  ) {
    throw new AuditValidationError(
      "Runtime permissions boundary metadata is inconsistent.",
      "RUNTIME_BOUNDARY_METADATA_MISMATCH",
    );
  }
  if (
    typeof policy.DefaultVersionId !== "string"
    || !/^v[1-9][0-9]*$/.test(policy.DefaultVersionId)
  ) {
    throw new AuditValidationError(
      "Runtime permissions boundary must have a valid default version.",
      "INVALID_RUNTIME_BOUNDARY_VERSION",
    );
  }
  evidence.defaultVersionId = policy.DefaultVersionId;

  const tagDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "list-policy-tags",
      ["--policy-arn", boundaryArn],
    ),
    "Runtime permissions boundary tag inspection",
  );
  verifyRuntimeBoundaryTags(tagDocument);
  evidence.tagsMatch = true;

  const versionDocument = parseJsonOutput(
    runAws(
      runCommand,
      cwd,
      "iam",
      "get-policy-version",
      [
        "--policy-arn",
        boundaryArn,
        "--version-id",
        policy.DefaultVersionId,
      ],
    ),
    "Runtime permissions boundary version inspection",
  );
  const policyVersion = versionDocument.PolicyVersion;
  if (
    !policyVersion
    || typeof policyVersion !== "object"
    || Array.isArray(policyVersion)
    || policyVersion.VersionId !== policy.DefaultVersionId
    || policyVersion.IsDefaultVersion !== true
  ) {
    throw new AuditValidationError(
      "Runtime permissions boundary version metadata is inconsistent.",
      "RUNTIME_BOUNDARY_VERSION_MISMATCH",
    );
  }

  const deployedPolicy = compactRuntimeBoundary(
    decodePolicyDocument(policyVersion.Document),
    { preserveOptionalStatements: true },
  );
  const deployedContent = canonicalPolicyContent(deployedPolicy);
  evidence.deployedHash = policyHash(deployedContent);
  if (deployedContent === targetContent) {
    evidence.acceptedState = "target";
  } else if (
    allowPlannedTransition
    && (
      deployedContent === predecessorContent
      || deployedContent === gatewayIsolationPredecessorContent
      || deployedContent === invocationJournalPredecessorContent
      || deployedContent === discoverableResourcePredecessorContent
      || deployedContent === batchReadPredecessorContent
      || deployedContent === deleteConditionPredecessorContent
      || deployedContent === transactionAuthorizationPredecessorContent
      || deployedContent === journeyPredecessorContent
    )
  ) {
    evidence.acceptedState =
      deployedContent === transactionAuthorizationPredecessorContent
        ? "legacy-transaction-authorization"
        : deployedContent === journeyPredecessorContent
        ? "journey-predecessor"
        : deployedContent === gatewayIsolationPredecessorContent
        ? "gateway-isolation-predecessor"
        : "predecessor";
  } else {
    evidence.status = "failed";
    throw new AuditValidationError(
      allowPlannedTransition
        ? (
          "Deployed runtime permissions boundary has drifted from both "
          + "the exact target and declared deployment predecessors."
        )
        : (
          "Deployed runtime permissions boundary does not match the exact "
          + "post-deployment target state."
        ),
      "RUNTIME_BOUNDARY_DRIFT",
    );
  }
  evidence.status = "passed";
  return {
    ...providerResources,
    ...journeyBoundary,
  };
}

function enforceToolkitPolicy(toolkit, audit) {
  if (audit.mode === "deploy" || audit.mode === "postdeploy") {
    if (toolkit.status === "absent") {
      throw new AuditValidationError(
        "deploy mode requires an existing compliant CDKToolkit.",
        "CDK_TOOLKIT_REQUIRED",
      );
    }
    if (toolkit.issues.includes("termination-protection-disabled")) {
      throw new AuditValidationError(
        "CDKToolkit termination protection must be enabled.",
        "UNPROTECTED_CDK_TOOLKIT",
      );
    }
    if (toolkit.issues.includes("bootstrap-version-below-6")) {
      throw new AuditValidationError(
        `CDK bootstrap version must be at least ${MINIMUM_BOOTSTRAP_VERSION}.`,
        "OUTDATED_BOOTSTRAP_VERSION",
      );
    }
    return;
  }

  if (audit.mode === "bootstrap-new") {
    if (toolkit.status !== "absent") {
      throw new AuditValidationError(
        "bootstrap-new mode requires CDKToolkit to be absent.",
        "CDK_TOOLKIT_ALREADY_EXISTS",
      );
    }
    return;
  }

  if (toolkit.status === "absent") {
    throw new AuditValidationError(
      "bootstrap-remediate mode requires an existing CDKToolkit.",
      "CDK_TOOLKIT_REMEDIATION_REQUIRES_EXISTING",
    );
  }
  if (toolkit.compliant) {
    throw new AuditValidationError(
      "CDKToolkit is already compliant; bootstrap remediation is not allowed.",
      "CDK_TOOLKIT_REMEDIATION_NOT_REQUIRED",
    );
  }
  if (!audit.remediationApproved) {
    throw new AuditValidationError(
      "bootstrap-remediate mode requires "
        + "CDK_BOOTSTRAP_REMEDIATION_APPROVED=yes.",
      "CDK_TOOLKIT_REMEDIATION_NOT_APPROVED",
    );
  }
}

export function auditPredeploy({
  cwd = process.cwd(),
  env = process.env,
  now = () => new Date(),
  runCommand = createCommandRunner(),
  writeEvidence = defaultEvidenceWriter,
} = {}) {
  const generatedAt = now().toISOString();
  const filename = evidenceFilename(new Date(generatedAt));
  const evidence = baseEvidence(env, generatedAt);

  try {
    const audit = validateAuditOptions(env);
    const runtimeContractRequired =
      audit.githubDeploymentEnabled || audit.mode === "postdeploy";
    evidence.audit = audit;
    evidence.controlPlane.required = runtimeContractRequired;
    evidence.runtimeRoles.required = runtimeContractRequired;
    evidence.runtimeBoundary.required = runtimeContractRequired;
    if (!runtimeContractRequired) {
      evidence.controlPlane.status = "not-required";
      evidence.controlPlaneExecutionRole.required = false;
      evidence.controlPlaneExecutionRole.status = "not-required";
      evidence.controlPlaneRuntimeBoundary.required = false;
      evidence.controlPlaneRuntimeBoundary.status = "not-required";
      evidence.controlPlaneRuntimeRoles.required = false;
      evidence.controlPlaneRuntimeRoles.status = "not-required";
      evidence.runtimeRoles.status = "not-required";
      evidence.runtimeBoundary.status = "not-required";
    }
    enforceGitHubDeploymentGovernance(audit);
    const target = validateEnvironment(env);
    evidence.target = {
      accountId: maskAccountId(target.accountId),
      region: target.region,
      repository: target.repository,
    };
    if (audit.githubDeploymentEnabled) {
      evidence.githubDeployment = validateGitHubDeploymentMetadata(
        env,
        target.repository,
      );
    }
    const controlPlaneConfig = runtimeContractRequired
      ? validateControlPlaneDeploymentConfiguration(env)
      : null;
    if (controlPlaneConfig) {
      Object.assign(evidence.controlPlane, {
        mode: controlPlaneConfig.mode,
        stackName: controlPlaneConfig.stackName,
        status: "checking",
      });
      const bootstrapSecurityRequired =
        audit.githubDeploymentEnabled
        || controlPlaneConfig.mode === "provision";
      evidence.controlPlaneExecutionRole.required =
        audit.githubDeploymentEnabled;
      evidence.controlPlaneRuntimeBoundary.required =
        bootstrapSecurityRequired;
      evidence.controlPlaneRuntimeRoles.required =
        controlPlaneConfig.mode === "provision";
      if (!audit.githubDeploymentEnabled) {
        evidence.controlPlaneExecutionRole.status = "not-required";
      }
      if (!bootstrapSecurityRequired) {
        evidence.controlPlaneRuntimeBoundary.status = "not-required";
      }
      if (controlPlaneConfig.mode !== "provision") {
        evidence.controlPlaneRuntimeRoles.status = "not-required";
      }
    }

    const normalizedOrigin = normalizeGitHubRepositoryRemote(
      runCommand("git", ["remote", "get-url", "origin"], { cwd }),
    );
    if (normalizedOrigin !== target.repository) {
      throw new AuditValidationError(
        "GITHUB_REPOSITORY does not match git origin.",
        "GITHUB_REPOSITORY_MISMATCH",
      );
    }
    evidence.repository = {
      originMatches: true,
      normalizedOrigin,
    };

    const caller = parseJsonOutput(
      runAws(runCommand, cwd, "sts", "get-caller-identity"),
      "STS caller identity",
    );
    if (caller.Account !== target.accountId) {
      throw new AuditValidationError(
        "STS caller account does not match AWS_ACCOUNT_ID.",
        "STS_ACCOUNT_MISMATCH",
      );
    }
    const principalType = validateCallerPrincipal(
      caller.Arn,
      target.accountId,
    );
    evidence.caller = {
      accountMatches: true,
      principalType,
    };

    let controlPlaneResources;
    if (runtimeContractRequired) {
      const allowPlannedTransition = audit.mode === "deploy";
      let initialProvision = false;
      try {
        const inspection = inspectControlPlane({
          accountId: target.accountId,
          config: controlPlaneConfig,
          cwd,
          region: target.region,
          runCommand,
        });
        evidence.controlPlane = inspection.evidence;
        controlPlaneResources = inspection.resources;
      } catch (error) {
        if (
          allowPlannedTransition
          && controlPlaneConfig.mode === "provision"
          && isMissingCloudFormationStack(
            error,
            controlPlaneConfig.stackName,
          )
        ) {
          initialProvision = true;
          Object.assign(evidence.controlPlane, {
            outputsMatch: null,
            status: "planned",
            tagsMatch: null,
          });
        } else {
          evidence.controlPlane.status = "failed";
          throw error;
        }
      }
      if (evidence.controlPlaneRuntimeBoundary.required) {
        if (initialProvision) {
          evidence.controlPlaneRuntimeBoundary.status = "planned";
        } else {
          evidence.controlPlaneRuntimeBoundary.status = "checking";
          try {
            evidence.controlPlaneRuntimeBoundary =
              inspectControlPlaneRuntimeBoundary({
                accountId: target.accountId,
                allowPlannedTransition,
                controlPlaneResources,
                cwd,
                region: target.region,
                runCommand,
              });
          } catch (error) {
            evidence.controlPlaneRuntimeBoundary.status = "failed";
            throw error;
          }
        }
      }
      if (evidence.controlPlaneExecutionRole.required) {
        evidence.controlPlaneExecutionRole.status = "checking";
        try {
          evidence.controlPlaneExecutionRole =
            inspectControlPlaneExecutionRole({
              accountId: target.accountId,
              cwd,
              region: target.region,
              runCommand,
            });
        } catch (error) {
          evidence.controlPlaneExecutionRole.status = "failed";
          throw error;
        }
      }
      if (evidence.controlPlaneRuntimeRoles.required) {
        if (initialProvision) {
          evidence.controlPlaneRuntimeRoles.status = "planned";
        } else {
          evidence.controlPlaneRuntimeRoles.status = "checking";
          try {
            evidence.controlPlaneRuntimeRoles =
              inspectProvisionedControlPlaneRoles({
                accountId: target.accountId,
                cwd,
                region: target.region,
                runCommand,
                stackName: controlPlaneConfig.stackName,
              });
          } catch (error) {
            evidence.controlPlaneRuntimeRoles.status = "failed";
            throw error;
          }
        }
      }
      let runtimeResources;
      let webStackPlanned = initialProvision;
      if (!webStackPlanned) {
        try {
          runtimeResources = inspectRuntimeBoundary({
            accountId: target.accountId,
            allowPlannedTransition,
            controlPlaneResources,
            cwd,
            evidence: evidence.runtimeBoundary,
            env,
            region: target.region,
            runCommand,
          });
        } catch (error) {
          if (
            allowPlannedTransition
            && isMissingCloudFormationStack(error, PLATFORM_WEB_STACK_NAME)
          ) {
            webStackPlanned = true;
          } else {
            evidence.runtimeBoundary.status = "failed";
            throw error;
          }
        }
      }
      if (webStackPlanned) {
        evidence.runtimeBoundary.status = "planned";
        evidence.runtimeRoles.status = "planned";
      } else {
        evidence.runtimeRoles.status = "checking";
        try {
          evidence.runtimeRoles = audit.mode === "postdeploy" && env.SECURITY_AUDIT_WEB_TEMPLATE
            ? inspectSynthesizedIam({
              templatePath: path.resolve(cwd, env.SECURITY_AUDIT_WEB_TEMPLATE),
              domainTemplatePath: env.SECURITY_AUDIT_DOMAIN_TEMPLATE
                ? path.resolve(cwd, env.SECURITY_AUDIT_DOMAIN_TEMPLATE) : undefined,
              accountId: target.accountId, region: target.region,
              stackName: PLATFORM_WEB_STACK_NAME,
              requiredRoleNames: [...PLATFORM_WEB_RUNTIME_ROLE_NAMES,
                "AgenticPlatform-Web-PolicyInventoryRole", "AgenticPlatform-Web-HostedAcceptanceRole"],
              canonicalPolicyContent,
              aws: (service, operation, args) => parseJsonOutput(
                runAws(runCommand, cwd, service, operation, args), `${service} ${operation} IAM verification`),
            }) : inspectRuntimeRoles({
            accountId: target.accountId,
            accessAdminLogGroupArn:
              runtimeResources.accessAdminLogGroupArn,
            agentRuntimeArn: runtimeResources.agentRuntimeArn,
            agentRuntimeProductionEndpointArn:
              runtimeResources.agentRuntimeProductionEndpointArn,
            allowPlannedTransition,
            builderLogGroupArn:
              runtimeResources.builderLogGroupArn,
            controlPlaneResources,
            controlPlaneReadLogGroupArn:
              runtimeResources.controlPlaneReadLogGroupArn,
            cwd,
            experienceLogGroupArn:
              runtimeResources.experienceLogGroupArn,
            governanceLogGroupArn:
              runtimeResources.governanceLogGroupArn,
            hostedAcceptanceBrokerFunctionArn:
              runtimeResources.hostedAcceptanceBrokerFunctionArn,
            hostedAcceptanceBrokerLogGroupArn:
              runtimeResources.hostedAcceptanceBrokerLogGroupArn,
            identityLogGroupArn:
              runtimeResources.identityLogGroupArn,
            journeyGithubOAuthClientSecretArn:
              runtimeResources.journeyGithubOAuthClientSecretArn,
            journeyPredecessorInceptionModelArns:
              runtimeResources.journeyPredecessorInceptionModelArns,
            journeyLogGroupArn:
              runtimeResources.journeyLogGroupArn,
            modelGovernanceLogGroupArn:
              runtimeResources.modelGovernanceLogGroupArn,
            platformAdminLogGroupArn:
              runtimeResources.platformAdminLogGroupArn,
            registryDecisionFinalizerLogGroupArn:
              runtimeResources.registryDecisionFinalizerLogGroupArn,
            platformStateSeedLogGroupArn:
              runtimeResources.platformStateSeedLogGroupArn,
            platformStateTableArn: runtimeResources.platformStateTableArn,
            region: target.region,
            runCommand,
            runtimeProofConfiguratorFunctionArn:
              runtimeResources.runtimeProofConfiguratorFunctionArn,
            runtimeProofConfiguratorLogGroupArn:
              runtimeResources.runtimeProofConfiguratorLogGroupArn,
            runtimeProofProviderLogGroupArn:
              runtimeResources.runtimeProofProviderLogGroupArn,
            runtimeInvocationProofSecretArn:
              runtimeResources.runtimeInvocationProofSecretArn,
            userPoolArn: runtimeResources.userPoolArn,
            workspaceLogGroupArn:
              runtimeResources.workspaceLogGroupArn,
          });
        } catch (error) {
          evidence.runtimeRoles.status = "failed";
          throw error;
        }
      }
    }

    const providerList = parseJsonOutput(
      runAws(runCommand, cwd, "iam", "list-open-id-connect-providers"),
      "OIDC provider listing",
    );
    const candidates = githubProviderCandidates(
      providerList,
      target.accountId,
    );
    if (candidates.length > 1) {
      throw new AuditValidationError(
        "Found multiple token.actions.githubusercontent.com OIDC providers.",
        "DUPLICATE_GITHUB_OIDC_PROVIDER",
      );
    }
    if (candidates.length === 0) {
      evidence.githubOidc = {
        audiencePresent: null,
        providerCount: 0,
        status: "absent",
        url: null,
      };
    } else {
      const providerArn = candidates[0].Arn;
      const provider = parseJsonOutput(
        runAws(
          runCommand,
          cwd,
          "iam",
          "get-open-id-connect-provider",
          ["--open-id-connect-provider-arn", providerArn],
        ),
        "GitHub OIDC provider inspection",
      );
      if (provider.Url !== GITHUB_OIDC_HOST) {
        throw new AuditValidationError(
          "GitHub OIDC provider URL is malformed.",
          "MALFORMED_GITHUB_OIDC_URL",
        );
      }
      if (
        !Array.isArray(provider.ClientIDList)
        || !provider.ClientIDList.includes(GITHUB_OIDC_AUDIENCE)
      ) {
        throw new AuditValidationError(
          "GitHub OIDC provider is missing the sts.amazonaws.com audience.",
          "MISSING_GITHUB_OIDC_AUDIENCE",
        );
      }
      evidence.githubOidc = {
        audiencePresent: true,
        providerCount: 1,
        status: "present",
        url: provider.Url,
      };
    }

    evidence.cdkToolkit = inspectToolkit({ cwd, runCommand });
    enforceToolkitPolicy(evidence.cdkToolkit, audit);
    evidence.status = "passed";
    const evidencePath = writeEvidence({ filename, evidence });
    return { evidence, evidencePath };
  } catch (error) {
    evidence.status = "failed";
    evidence.error = {
      code:
        typeof error?.code === "string"
          ? error.code
          : "PREDEPLOY_SECURITY_AUDIT_FAILED",
      message: redactSensitiveText(
        error instanceof Error ? error.message : String(error),
      ),
    };
    const evidencePath = writeEvidence({ filename, evidence });
    if (error && typeof error === "object") {
      error.evidencePath = evidencePath;
    }
    throw error;
  }
}

const isExecutable = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isExecutable) {
  try {
    const env = { ...process.env };
    if (env.SECURITY_AUDIT_MODE === "postdeploy") {
      env.SECURITY_AUDIT_WEB_TEMPLATE ||= path.resolve("cdk.out/PlatformWebStack.template.json");
    }
    const result = auditPredeploy({ env });
    console.log(
      `Pre-deployment security audit passed. Evidence: ${result.evidencePath}`,
    );
  } catch (error) {
    console.error(
      "Pre-deployment security audit failed: "
        + redactSensitiveText(
          error instanceof Error ? error.message : String(error),
        ),
    );
    if (error?.evidencePath) {
      console.error(`Evidence: ${error.evidencePath}`);
    }
    process.exitCode = 1;
  }
}
