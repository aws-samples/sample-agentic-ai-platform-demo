#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import {
  CONTROL_PLANE_STACK_NAME,
  PlatformRegistryStack,
  PROVISIONED_CONTROL_PLANE_STACK_NAME,
  type SeedRecord,
} from "../lib/platform-registry-stack";
import { resolveControlPlaneContext } from "../lib/control-plane-config";
import {
  governedDescriptor,
  governedDomainId,
  governedRecordVersion,
  PLATFORM_BOOTSTRAP_OWNER_SUBJECT,
  type GovernedResourceType,
} from "../lib/governed-descriptor";
import { canonicalizeSeedRecordName } from "../lib/seed-record-name";
import { normalizeSeedRecordStatus } from "../lib/seed-record-status";
import * as fs from "fs";
import * as path from "path";

const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export type DeploymentRegionSources = {
  contextRegion?: string;
  awsRegion?: string;
  cdkDefaultRegion?: string;
};

function regionCandidate(
  value: string | undefined,
  source: string,
  emptyIsAbsent: boolean,
): string | undefined {
  if (value === undefined || (emptyIsAbsent && value === "")) {
    return undefined;
  }
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(
      `${source} must be a non-empty region without surrounding whitespace`,
    );
  }
  return value;
}

export function resolveDeploymentRegion(
  sources: DeploymentRegionSources,
): string {
  return regionCandidate(
    sources.contextRegion,
    "CDK context region",
    false,
  )
    ?? regionCandidate(sources.awsRegion, "AWS_REGION", true)
    ?? regionCandidate(
      sources.cdkDefaultRegion,
      "CDK_DEFAULT_REGION",
      true,
    )
    ?? "us-west-2";
}

function governedMetadata(
  domain: string,
  resourceId: string,
  resourceType: GovernedResourceType,
) {
  return {
    domainId: governedDomainId(domain),
    ownerSubject: PLATFORM_BOOTSTRAP_OWNER_SUBJECT,
    resourceId,
    resourceType,
    shared: domain === "shared",
  };
}

function a2aDescriptors(entry: any, version: any, domain: string) {
  const c = version.content || {};
  const card = governedDescriptor(clean({
    resourceKind: "agent",
    protocolVersion: "0.3.0",
    name: c.card?.name || entry.name,
    description: c.card?.description || entry.description,
    url: c.baseUrl,
    preferredTransport: "JSONRPC",
    version: c.card?.version || version.semver,
    provider: c.card?.provider,
    documentationUrl: c.card?.documentationUrl,
    capabilities: c.card?.capabilities || {},
    authentication: c.card?.authentication,
    defaultInputModes: c.card?.defaultInputModes || ["text/plain"],
    defaultOutputModes: c.card?.defaultOutputModes || ["text/plain"],
    skills: c.card?.skills || [],
    "x-platform-metadata": {
      displayName: entry.name,
      domain,
      governanceMode: entry.governanceMode,
      domainOwner: entry.domainOwner,
      access: c.access || ["admin"],
      changelog: version.changelog,
      createdBy: version.createdBy,
    },
  }), governedMetadata(domain, entry.id, "AGENT"));
  return { a2aAgentCard: { dataSchemaVersion: "0.3.0", data: JSON.stringify(card) } };
}

function skillDescriptors(entry: any, version: any, domain: string) {
  const c = version.content || {};
  const slug = String(entry.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const definition = governedDescriptor({
    resourceKind: "skill",
    id: entry.id,
    name: slug,
    displayName: entry.name,
    description: entry.description,
    tags: [domain, c.toolType || "skill"].filter(Boolean),
    "x-platform-metadata": {
      displayName: entry.name,
      domain,
      governanceMode: entry.governanceMode,
      domainOwner: entry.domainOwner,
      tools: c.tools || [],
      toolType: c.toolType || null,
      gateway: c.gateway || null,
      auth: c.auth || null,
      access: c.access || ["admin", "builder"],
      changelog: version.changelog,
      createdBy: version.createdBy,
    },
  }, governedMetadata(domain, entry.id, "SKILL"));
  const skillMd = [
    "---",
    `name: ${slug}`,
    `description: ${entry.description}`,
    "---",
    "",
    `# ${entry.name}`,
    "",
    entry.description,
    "",
    c.toolType
      ? `Typed tool (${c.toolType})${c.gateway ? ` served via the \`${c.gateway}\` gateway` : ""}.`
      : `Tools used: ${(c.tools || []).join(", ") || "none"}.`,
  ].join("\n");
  return {
    agentSkillsDefinition: {
      dataSchemaVersion: "0.1.0",
      data: JSON.stringify(definition),
      additionalData: { skillMd: { data: skillMd } },
    },
  };
}

function blueprintDescriptors(bp: any, compat: any, version: string) {
  return {
    custom: {
      data: JSON.stringify(governedDescriptor({
        resourceKind: "blueprint",
        blueprintId: bp.id,
        displayName: bp.name,
        useCase: bp.useCase,
        icon: bp.icon,
        template: bp.template || {},
        source: bp.source || { kind: "illustrative" },
        recommended: bp.recommended === true,
        compat,
        version,
        defaultVersion: version,
      }, governedMetadata("shared", bp.id, "BLUEPRINT"))),
    },
  };
}

// Blueprints are the platform's published contract: a builder picking one must
// see which model, tools and observability the platform pre-wired. Enforced at
// synth so a deploy can never publish a blueprint with dangling or missing
// metadata — catalog.json edits fail here, not in a live console.
export function validateBlueprintTemplates(
  catalog: any,
  seed: any[],
): void {
  const approvedModelIds = new Set(
    (catalog.models || [])
      .filter((model: any) => model.approved === true)
      .map((model: any) => model.id),
  );
  const seededResourceIds = new Set(
    seed
      .filter((entry: any) => ["Skill", "MCPServer"].includes(entry.type))
      .map((entry: any) => entry.id),
  );
  for (const bp of catalog.blueprints || []) {
    const template = bp.template;
    const problems: string[] = [];
    if (!template || typeof template !== "object") {
      throw new Error(`Blueprint ${bp.id} has no template.`);
    }
    if (
      template.defaultModel !== null
      && !approvedModelIds.has(template.defaultModel)
    ) {
      problems.push(
        `defaultModel ${JSON.stringify(template.defaultModel)} is not an `
          + "approved catalog model (null = intentionally modelless)",
      );
    }
    if (!Array.isArray(template.tools)) {
      problems.push("tools must be an array of registry Skill/MCPServer ids");
    } else {
      for (const tool of template.tools) {
        if (!seededResourceIds.has(tool)) {
          problems.push(
            `tool ${JSON.stringify(tool)} is not a seeded registry `
              + "Skill/MCPServer",
          );
        }
      }
    }
    if (
      typeof template.observability !== "string"
      || template.observability.trim().length === 0
    ) {
      problems.push("observability must name the pre-wired telemetry");
    }
    problems.push(...blueprintSourceProblems(bp.source));
    if (problems.length > 0) {
      throw new Error(
        `Blueprint ${bp.id} template metadata is invalid:\n  `
          + problems.join("\n  "),
      );
    }
  }
}

// Source declares where the harness code actually lives. kind=repo must point
// at a real blueprints/<templateId> directory in this repository (the compose
// flow exports exactly those files); github/s3 references are shape-checked.
function blueprintSourceProblems(source: any): string[] {
  if (source == null) {
    return ["source is required ({kind: repo|github|s3|illustrative})"];
  }
  if (typeof source !== "object" || Array.isArray(source)) {
    return ["source must be an object"];
  }
  if (source.kind === "illustrative") return [];
  if (source.kind === "repo") {
    const dir = path.resolve(
      __dirname, "..", "..", "..", "blueprints", String(source.templateId || ""),
    );
    return /^[a-z0-9-]+$/.test(String(source.templateId || ""))
      && fs.existsSync(path.join(dir, "AGENTS.md"))
      ? []
      : [
        `source.templateId ${JSON.stringify(source.templateId)} has no `
          + "blueprints/<templateId>/AGENTS.md harness in this repository",
      ];
  }
  if (source.kind === "github") {
    return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(String(source.url || ""))
      ? []
      : ["source.url must be https://github.com/org/repo"];
  }
  if (source.kind === "s3") {
    return /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/.+$/.test(String(source.uri || ""))
      ? []
      : ["source.uri must be s3://bucket/key"];
  }
  return ["source.kind must be one of: repo, github, s3, illustrative"];
}

export function buildSeedRecords(seed: any[], catalog: any): SeedRecord[] {
  validateBlueprintTemplates(catalog, seed);
  const seedRecords: SeedRecord[] = [];

  for (const entry of seed) {
    if (entry.type === "MCPServer") continue;
    if (entry.type === "Skill") {
      const domain = entry.domain || "shared";
      for (const version of entry.versions || []) {
        seedRecords.push({
          registryRef: domain,
          name: canonicalizeSeedRecordName(`skill_${entry.id}`),
          displayName: entry.name || entry.id,
          recordType: "SKILL",
          descriptors: skillDescriptors(entry, version, domain),
          version: governedRecordVersion(version.semver),
          status: normalizeSeedRecordStatus(version.status),
          description: entry.description || entry.name || entry.id,
        });
      }
    }
    if (entry.type === "A2AAgent") {
      const domain = entry.domain || "shared";
      for (const version of entry.versions || []) {
        seedRecords.push({
          registryRef: domain,
          name: canonicalizeSeedRecordName(`a2a_${entry.id}`),
          displayName: entry.name || entry.id,
          recordType: "AGENT",
          descriptors: a2aDescriptors(entry, version, domain),
          version: governedRecordVersion(version.semver),
          status: normalizeSeedRecordStatus(version.status),
          description: entry.description || entry.name || entry.id,
        });
      }
    }
  }

  // Registry record versions are immutable — the seed handler rejects changed
  // content under an existing (name, version) key. 1.1.0 publishes the
  // model/tools/observability template contract; accounts seeded at 1.0.0
  // gain it as a new approved version on their next deploy.
  const BLUEPRINT_SEED_VERSION = "1.3.0";
  const compat = catalog.blueprintOptions?.compatibility || {};
  for (const bp of catalog.blueprints || []) {
    seedRecords.push({
      registryRef: "shared",
      name: canonicalizeSeedRecordName(`blueprint_${bp.id}`),
      displayName: bp.name || bp.id,
      recordType: "CUSTOM",
      descriptors: blueprintDescriptors(bp, compat, BLUEPRINT_SEED_VERSION),
      version: governedRecordVersion(BLUEPRINT_SEED_VERSION),
      status: "APPROVED",
      description: bp.useCase || bp.name || bp.id,
    });
  }

  return seedRecords;
}

function main(): void {
  const app = new cdk.App();
  const consoleDir = path.resolve(__dirname, "..", "..", "..", "console");
  const seed = JSON.parse(
    fs.readFileSync(path.join(consoleDir, "registry-seed.json"), "utf8"),
  );
  const catalog = JSON.parse(
    fs.readFileSync(path.join(consoleDir, "catalog.json"), "utf8"),
  );
  const domains = JSON.parse(
    fs.readFileSync(path.join(consoleDir, "domains.json"), "utf8"),
  );
  const seedRecords = buildSeedRecords(seed, catalog);

  const context = (key: string): string | undefined => {
    const value = app.node.tryGetContext(key);
    return value === undefined || value === null
      ? undefined
      : String(value);
  };

  const mode = context("mode") || process.env.CONTROL_PLANE_MODE;
  const account =
    context("account")
    || process.env.CDK_DEFAULT_ACCOUNT
    || process.env.AWS_ACCOUNT_ID
    || "";
  const region = resolveDeploymentRegion({
    contextRegion: context("region"),
    awsRegion: process.env.AWS_REGION,
    cdkDefaultRegion: process.env.CDK_DEFAULT_REGION,
  });

  const config = resolveControlPlaneContext({
    mode,
    account,
    region,
    sharedRegistryId: context("sharedRegistryId"),
    registryPlatformId: context("registryPlatformId"),
    registryCustomerSupportId: context("registryCustomerSupportId"),
    registryOperationsId: context("registryOperationsId"),
    llmGatewayId: context("llmGatewayId"),
    llmGatewayRegion: context("llmGatewayRegion"),
    toolsGatewayId: context("toolsGatewayId"),
    llmGatewayName: context("llmGatewayName"),
    toolsGatewayName: context("toolsGatewayName"),
  });
  const stackName =
    config.mode === "provision"
      ? PROVISIONED_CONTROL_PLANE_STACK_NAME
      : CONTROL_PLANE_STACK_NAME;

  new PlatformRegistryStack(app, stackName, {
    env: {
      account: config.account,
      region: config.region,
    },
    config,
    domains: domains.map((domain: any) => ({
      id: domain.id,
      name: domain.name || domain.id,
      description:
        domain.description
        || `${domain.name || domain.id} domain registry`,
    })),
    seedRecords: config.mode === "provision" ? seedRecords : [],
  });
}

if (require.main === module) {
  main();
}
