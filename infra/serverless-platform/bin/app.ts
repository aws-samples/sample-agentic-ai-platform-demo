#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import {
  DEFAULT_REGION,
  GitHubOidcSubjectMode,
  contextFlag,
  contextValue,
  requiredContext,
} from "../lib/config";
import { GitHubBootstrapStack } from "../lib/github-bootstrap-stack";
import { PlatformWebStack } from "../lib/platform-web-stack";

const app = new cdk.App();
const context = {
  account: app.node.tryGetContext("account"),
  region: app.node.tryGetContext("region"),
  repository: app.node.tryGetContext("repository"),
  enableGitHubDeployment:
    app.node.tryGetContext("enableGitHubDeployment"),
  branchProtectionAttested:
    app.node.tryGetContext("branchProtectionAttested"),
  repositoryId: app.node.tryGetContext("repositoryId"),
  repositoryOwnerId: app.node.tryGetContext("repositoryOwnerId"),
  workflowRef: app.node.tryGetContext("workflowRef"),
  githubOidcSubjectMode:
    app.node.tryGetContext("githubOidcSubjectMode"),
  githubOidcSubject: app.node.tryGetContext("githubOidcSubject"),
  cognitoDomainPrefix: app.node.tryGetContext("cognitoDomainPrefix"),
  starterBuilderModelId:
    app.node.tryGetContext("starterBuilderModelId"),
  inceptionModelId: app.node.tryGetContext("inceptionModelId"),
  githubOAuthClientId:
    app.node.tryGetContext("githubOAuthClientId"),
  githubOAuthClientSecretArn:
    app.node.tryGetContext("githubOAuthClientSecretArn"),
  llmGatewayId: app.node.tryGetContext("llmGatewayId"),
  llmGatewayRegion: app.node.tryGetContext("llmGatewayRegion"),
  demoItHelpdeskMemoryId:
    app.node.tryGetContext("demoItHelpdeskMemoryId"),
  demoSupportDeskMemoryId:
    app.node.tryGetContext("demoSupportDeskMemoryId"),
  demoReportRunnerKnowledgeBaseId:
    app.node.tryGetContext("demoReportRunnerKnowledgeBaseId"),
  bedrockRuntimeProfileIds: app.node.tryGetContext("bedrockRuntimeProfileIds"),
  githubOidcProviderArn: app.node.tryGetContext("githubOidcProviderArn"),
};

const account = requiredContext(
  {
    account: contextValue(
      context,
      "account",
      process.env.CDK_DEFAULT_ACCOUNT,
    ),
  },
  "account",
);
const region = contextValue(
  context,
  "region",
  DEFAULT_REGION,
)!;
if (region !== DEFAULT_REGION) {
  throw new Error(`region must be exactly ${DEFAULT_REGION}.`);
}
const enableGitHubDeployment = contextFlag(
  context,
  "enableGitHubDeployment",
);
const branchProtectionAttested = contextFlag(
  context,
  "branchProtectionAttested",
);
if (enableGitHubDeployment && !branchProtectionAttested) {
  throw new Error(
    "enableGitHubDeployment=true requires "
      + "branchProtectionAttested=true.",
  );
}
const cognitoDomainPrefix = contextValue(
  context,
  "cognitoDomainPrefix",
  `agentic-platform-${account}`,
)!;
const starterBuilderModelId = requiredContext(
  context,
  "starterBuilderModelId",
);
const inceptionModelId = contextValue(context, "inceptionModelId");
const githubOAuthClientId = contextValue(
  context,
  "githubOAuthClientId",
);
const githubOAuthClientSecretArn = contextValue(
  context,
  "githubOAuthClientSecretArn",
);
const llmGatewayId = requiredContext(context, "llmGatewayId");
const llmGatewayRegion = requiredContext(context, "llmGatewayRegion");
const githubOidcProviderArn = contextValue(
  context,
  "githubOidcProviderArn",
);

if (enableGitHubDeployment) {
  const explicitRepository = requiredContext(context, "repository");
  const repositoryId = requiredContext(context, "repositoryId");
  const repositoryOwnerId = requiredContext(context, "repositoryOwnerId");
  const workflowRef = requiredContext(context, "workflowRef");
  const githubOidcSubjectModeValue = requiredContext(
    context,
    "githubOidcSubjectMode",
  );
  if (
    githubOidcSubjectModeValue !== "legacy"
    && githubOidcSubjectModeValue !== "immutable"
  ) {
    throw new Error(
      "githubOidcSubjectMode must be legacy or immutable.",
    );
  }
  const githubOidcSubjectMode: GitHubOidcSubjectMode =
    githubOidcSubjectModeValue;
  const githubOidcSubject = requiredContext(context, "githubOidcSubject");

  new GitHubBootstrapStack(app, "GitHubBootstrapStack", {
    env: { account, region },
    repository: explicitRepository,
    repositoryId,
    repositoryOwnerId,
    workflowRef,
    githubOidcSubjectMode,
    githubOidcSubject,
    branchProtectionAttested: true,
    githubOidcProviderArn,
  });
}

const platformWebStackProps = {
  env: { account, region },
  cognitoDomainPrefix,
  githubOAuthClientId,
  githubOAuthClientSecretArn,
  inceptionModelId,
  starterBuilderModelId,
  llmGatewayId,
  llmGatewayRegion,
  demoItHelpdeskMemoryId: context.demoItHelpdeskMemoryId,
  demoSupportDeskMemoryId: context.demoSupportDeskMemoryId,
  demoReportRunnerKnowledgeBaseId:
    context.demoReportRunnerKnowledgeBaseId,
  bedrockRuntimeProfileIds: typeof context.bedrockRuntimeProfileIds === "string"
    ? JSON.parse(context.bedrockRuntimeProfileIds) : context.bedrockRuntimeProfileIds,
  synthesizer: new cdk.CliCredentialsStackSynthesizer(),
};
new PlatformWebStack(app, "PlatformWebStack", platformWebStackProps);

cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
