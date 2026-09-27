#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import * as path from "path";
import {
  KNOWLEDGE_BASES_STACK_NAME,
  KnowledgeBaseStack,
  type KbProjectConfig,
} from "../lib/knowledge-base-stack";

const app = new cdk.App();

// ---------------------------------------------------------------------------
// CDK context helpers (mirrors pattern from infra/platform-registry/bin/app.ts)
// ---------------------------------------------------------------------------
const context = (key: string): string | undefined => {
  const value = app.node.tryGetContext(key);
  return value === undefined || value === null ? undefined : String(value);
};

const account =
  context("account") ||
  process.env.CDK_DEFAULT_ACCOUNT ||
  process.env.AWS_ACCOUNT_ID ||
  "";

const region =
  context("region") ||
  process.env.CDK_DEFAULT_REGION ||
  process.env.AWS_REGION ||
  "us-west-2";

// Optional: override the project list via CDK context.
// Format (JSON string): '[{"project":"concierge","domain":"customer_support","docsPath":"domain-examples/concierge/kb-docs"}]'
const projectsContextRaw = context("projects");
const projects: KbProjectConfig[] | undefined = projectsContextRaw
  ? (JSON.parse(projectsContextRaw) as KbProjectConfig[])
  : undefined;

// Repo root: bin/ → knowledge-bases/ → infra/ → workspace-projects/
const repoRoot = path.resolve(__dirname, "..", "..", "..");

new KnowledgeBaseStack(app, KNOWLEDGE_BASES_STACK_NAME, {
  env: { account, region },
  repoRoot,
  projects,
});
