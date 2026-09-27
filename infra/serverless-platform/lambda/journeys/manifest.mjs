import {evaluationAssets} from '../../../../console/evaluation-assets.mjs';
import { createHash } from "node:crypto";
import {
  specSection,
  tddSection,
} from "../../../../console/inception.mjs";
import {
  gateFilesForPreset,
  platformGateContract,
  starterGoldenDataset,
} from "../../../../console/export-contract.mjs";
import {
  JOURNEY_TEMPLATES,
} from "./template-assets.mjs";
import {
  validPortableResourceBinding,
} from "./resource-binding.mjs";
import { governedToolAssets, governedToolCiEntry } from "./governed-tool-assets.mjs";
import {
  validateGuardrailChain,
} from "../../../../console/public/guardrail-chain.mjs";

const PRESETS = new Set(["FULL", "MINIMAL", "SPEC"]);
const REPOSITORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const DOMAIN_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SECRET_PATTERNS = Object.freeze([
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bASIA[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]);

function plain(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function exact(value, keys) {
  return plain(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(message = "Journey manifest input is invalid.") {
  throw new TypeError(message);
}

function validPath(path) {
  return (
    typeof path === "string"
    && path.length > 0
    && path.length <= 512
    && !path.startsWith("/")
    && !path.includes("\\")
    && path.split("/").every((part) =>
      part.length > 0 && part !== "." && part !== "..")
    && !/[\u0000-\u001f\u007f]/.test(path)
  );
}

function validContent(content) {
  if (typeof content !== "string") invalid("Manifest content is invalid.");
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_FILE_BYTES) invalid("Manifest file is too large.");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
    invalid("Manifest content contains a secret-shaped value.");
  }
  return bytes;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function deploymentName(agentId) {
  const compact = agentId.replace(/[^A-Za-z0-9]/g, "");
  if (compact.length <= 23) return compact;
  const suffix = createHash("sha256").update(agentId).digest("hex").slice(0, 8);
  return `${compact.slice(0, 15)}${suffix}`;
}

function fingerprint(entries) {
  return createHash("sha256")
    .update(JSON.stringify(entries.map(({ path, content, mode }) => ({
      path,
      content,
      mode,
    }))))
    .digest("hex");
}

function templateEntries(value, label) {
  if (!Array.isArray(value)) invalid(`${label} template is invalid.`);
  return value.map((entry) => {
    if (!plain(entry) || !validPath(entry.path)) {
      invalid(`${label} template path is invalid.`);
    }
    if (
      typeof entry.content !== "string"
      || (
        entry.mode !== undefined
        && entry.mode !== "100644"
        && entry.mode !== "100755"
      )
    ) {
      invalid(`${label} template is invalid.`);
    }
    return {
      path: entry.path,
      content: entry.content,
      mode: entry.mode || "100644",
    };
  });
}

function ciEntries(templates, preset) {
  if (!plain(templates?.ci)) invalid("CI templates are invalid.");
  return gateFilesForPreset(preset)
    .map((path) => {
      if (!Object.hasOwn(templates.ci, path)) {
        invalid(`Required CI template is missing: ${path}`);
      }
      return {
        path,
        content: templates.ci[path],
        mode: "100644",
      };
    });
}

function gatesReadme(repositoryName, preset) {
  return `# Platform CI gate - ${repositoryName}

This ${preset} repository carries the platform eval, test, compliance, and
secret-hygiene gates.

Run locally:

\`\`\`bash
node gates/run-tests.mjs
node gates/check-guardrails.mjs
node gates/run-eval.mjs --mode assert
\`\`\`
`;
}

function minimalReadme(repositoryName, domainId) {
  return `# ${repositoryName} - foundation start

This repository was created for the ${domainId} domain. It intentionally
contains no agent application code and no runtime configuration. Add the
implementation behind a pull request while preserving the platform CI gate.

${gatesReadme(repositoryName, "MINIMAL")}`;
}

function specReadme(repositoryName, agent) {
  return `# ${repositoryName} - spec-first

The governed Agent \`${agent.agentId}\` is configured and ready for explicit
testing. Start with \`SPEC.md\`, \`CLAUDE.md\`, and \`agent-binding.json\`.
This repository contains the approved specification and test skeleton only;
it is not runnable and contains no runtime configuration.
`;
}

function fullClaude(snapshot) {
  const { agent, blueprint, resources } = snapshot;
  const list = (label, values) =>
    `**${label}:** ${values.length ? values.map((v) => `\`${v}\``).join(", ") : "none"}`;
  return `# ${agent.name} - Agent Project

This runnable AgentCore project was composed by the hosted platform from an
approved blueprint. Keep the platform identity, observability, guardrail, and
CI foundation intact.

**Model:** \`${agent.runtimeModelId || agent.modelId}\`

**Blueprint:** \`${blueprint.blueprintId}@${blueprint.version}\`

  ${list("Resolved resources", resources.map(({
    type,
    id,
    version,
    binding,
  }) => `${type}:${id}@${version} (${binding.status})`))}

Resources marked \`DEPLOYMENT_REQUIRED\` are portable governed references. Bind
them to the matching resource in the target environment before deployment.
`;
}

function fullContractTest({
  authorizerType,
  deployment,
  entrypoint,
  instructionsPath,
  runtimePath,
  runtimeModelId,
}) {
  const moduleName = entrypoint
    .split(":")[0]
    .replace(/\.py$/, "")
    .replaceAll("/", ".");
  return `import importlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_agentcore_configuration_is_portable_and_tagged():
    config = json.loads((ROOT / "agentcore/agentcore.json").read_text())
    assert config["name"] == ${JSON.stringify(deployment)}
    assert config["tags"]["auto-delete"] == "no"
    assert config["runtimes"][0].get("authorizerType") == ${JSON.stringify(authorizerType)}
    assert "authorizerConfiguration" not in config["runtimes"][0]


def test_selected_runtime_configuration_is_materialized():
    harness = json.loads((ROOT / "domain-harness.json").read_text())
    assert harness["runtimeModelId"] == ${JSON.stringify(runtimeModelId)}
    assert (ROOT / ${JSON.stringify(instructionsPath)}).read_text().strip() == harness["instructions"].strip()


def test_runtime_entrypoint_imports():
    sys.path.insert(0, str(ROOT / ${JSON.stringify(runtimePath)}))
    importlib.import_module(${JSON.stringify(moduleName)})
`;
}

function configuredModelLoader(content, agent) {
  const args = [`model_id=${JSON.stringify(agent.runtimeModelId)}`];
  if (agent.modelParameters.temperature !== null) {
    args.push(`temperature=${agent.modelParameters.temperature}`);
  }
  if (agent.modelParameters.maxTokens !== null) {
    args.push(`max_tokens=${agent.modelParameters.maxTokens}`);
  }
  if (content.includes("controls = platform_model_controls()")) args.push("**controls");
  const next = content.replace(
    /BedrockModel\([^)\n]*\)/,
    `BedrockModel(${args.join(", ")})`,
  );
  if (next === content) {
    invalid("Blueprint model loader is unsupported.");
  }
  return next;
}

function configuredMain(content, templateId, instructions) {
  if (templateId !== "workflowagent") return content;
  const next = content.replace(
    /DEFAULT_SYSTEM_PROMPT = """[\s\S]*?"""/,
    `DEFAULT_SYSTEM_PROMPT = ${JSON.stringify(instructions)}`,
  );
  if (next === content) {
    invalid("Workflow blueprint instructions are unsupported.");
  }
  return next;
}

function resourceConnection(resource) {
  if (resource.binding.status === "DEPLOYMENT_REQUIRED") return null;
  // External Gateway binding is consumed by generated Python, not a managed
  // browser/codeInterpreter connection or a newly provisioned Gateway.
  if (resource.binding.adapter === "agentcore_gateway") return null;
  if (resource.type === "TOOL" && resource.binding.adapter === "browser") {
    return { id: resource.id, to: { type: "browser" } };
  }
  if (
    resource.type === "TOOL"
    && resource.binding.adapter === "codeInterpreter"
  ) {
    return { id: resource.id, to: { type: "codeInterpreter" } };
  }
  invalid(
    `Selected resource ${resource.id} has no executable AgentCore binding.`,
  );
}

function portableResource(resource) {
  return {
    type: resource.type,
    id: resource.id,
    version: resource.version,
    binding: canonical(resource.binding),
  };
}

function fullEntries(source, templates) {
  const snapshot = source?.snapshot;
  const agent = snapshot?.agent;
  const blueprintRecord = snapshot?.blueprint;
  if (
    !plain(snapshot)
    || snapshot.snapshotVersion !== 1
    || !plain(agent)
    || !DOMAIN_PATTERN.test(agent.domainId)
    || !SLUG_PATTERN.test(agent.projectId)
    || !SLUG_PATTERN.test(agent.id)
    || typeof agent.name !== "string"
    || agent.name.length === 0
    || agent.name.length > 128
    || typeof agent.instructions !== "string"
    || agent.instructions.length === 0
    || agent.instructions.length > 16_384
    || typeof agent.modelId !== "string"
    || agent.modelId.length === 0
    || typeof agent.runtimeModelId !== "string"
    || agent.runtimeModelId.length === 0
    || (agent.testEvidenceHash !== null && !/^[a-f0-9]{64}$/.test(agent.testEvidenceHash))
    || !plain(agent.modelParameters)
    || !plain(agent.buildOptions)
    || Object.keys(agent.modelParameters).sort().join(",")
      !== "maxTokens,temperature"
    || (
      agent.modelParameters.temperature !== null
      && (
        typeof agent.modelParameters.temperature !== "number"
        || !Number.isFinite(agent.modelParameters.temperature)
        || agent.modelParameters.temperature < 0
        || agent.modelParameters.temperature > 1
      )
    )
    || (
      agent.modelParameters.maxTokens !== null
      && (
        !Number.isSafeInteger(agent.modelParameters.maxTokens)
        || agent.modelParameters.maxTokens < 1
        || agent.modelParameters.maxTokens > 4096
      )
    )
    || Object.keys(agent.buildOptions).sort().join(",")
      !== "deployTarget,framework,guardrails,identity,memory,streaming"
    || typeof agent.buildOptions.framework !== "string"
    || typeof agent.buildOptions.deployTarget !== "string"
    || !new Set(["none", "shortTerm", "longAndShortTerm"])
      .has(agent.buildOptions.memory)
    || typeof agent.buildOptions.streaming !== "boolean"
    || typeof agent.buildOptions.identity !== "boolean"
    || typeof agent.buildOptions.guardrails !== "boolean"
  ) {
    invalid("FULL requires a valid tested build snapshot.");
  }
  let guardrailChain;
  try {
    guardrailChain = validateGuardrailChain(agent.guardrailChain);
  } catch {
    invalid("FULL requires a valid guardrail chain.");
  }
  if (
    !plain(blueprintRecord)
    || !new Set(["chatagent", "workflowagent"])
      .has(blueprintRecord.templateId)
    || typeof blueprintRecord.blueprintId !== "string"
    || typeof blueprintRecord.version !== "string"
    || !plain(blueprintRecord.template)
    || blueprintRecord.template.guardrails !== true
    || Object.entries(agent.buildOptions).some(
      ([key, value]) => blueprintRecord.template[key] !== value,
    )
  ) {
    invalid("FULL requires one supported blueprint.");
  }
  if (
    !Array.isArray(snapshot.resources)
    || snapshot.resources.length > 100
    || snapshot.resources.some((resource) =>
      !plain(resource)
      || Object.keys(resource).sort().join(",")
        !== "binding,id,recordId,registryId,type,version"
      || typeof resource.type !== "string"
      || typeof resource.registryId !== "string"
      || resource.registryId.length === 0
      || resource.registryId.length > 256
      || typeof resource.recordId !== "string"
      || resource.recordId.length === 0
      || resource.recordId.length > 256
      || typeof resource.id !== "string"
      || resource.id.length === 0
      || resource.id.length > 256
      || typeof resource.version !== "string"
      || resource.version.length === 0
      || resource.version.length > 128
      || !validPortableResourceBinding(resource.type, resource.binding))
  ) {
    invalid("FULL resolved resources are invalid.");
  }
  const blueprint = templateEntries(
    templates?.blueprints?.[blueprintRecord.templateId],
    blueprintRecord.templateId,
  );
  const configEntry = blueprint.find(({ path }) =>
    path === "agentcore/agentcore.json");
  if (!configEntry) invalid("Blueprint AgentCore configuration is missing.");
  let config;
  try {
    config = JSON.parse(configEntry.content);
  } catch {
    invalid("Blueprint AgentCore configuration is invalid.");
  }
  const deployedName = deploymentName(agent.id);
  config.name = deployedName;
  config.tags = {
    ...(plain(config.tags) ? config.tags : {}),
    "agentcore:project-name": deployedName,
    "auto-delete": "no",
    "domain-id": agent.domainId,
    "project-id": agent.projectId,
    component: "runtime",
    "managed-by": "agentic-platform",
  };
  if (!Array.isArray(config.runtimes) || config.runtimes.length !== 1) {
    invalid("Blueprint runtime configuration is invalid.");
  }
  const runtime = config.runtimes[0];
  if (
    !plain(runtime)
    || typeof runtime.codeLocation !== "string"
    || !validPath(runtime.codeLocation.replace(/\/$/, ""))
  ) {
    invalid("Blueprint runtime location is invalid.");
  }
  runtime.authorizerType = agent.buildOptions.identity
    ? "AWS_IAM"
    : "NONE";
  delete runtime.authorizerConfiguration;
  delete runtime.requestHeaderAllowlist;
  if (Array.isArray(config.memories)) {
    for (const memory of config.memories) {
      if (plain(memory)) memory.name = `${deployedName}Memory`;
    }
  }
  if (agent.buildOptions.memory === "none") {
    config.memories = [];
  } else if (agent.buildOptions.memory === "shortTerm") {
    config.memories = config.memories.map((memory) => ({
      ...memory,
      strategies: [],
    }));
  }
  if (!agent.buildOptions.guardrails) config.policyEngines = [];
  const connections = snapshot.resources
    .map(resourceConnection)
    .filter(Boolean);
  if (connections.length > 0) {
    const existing = Array.isArray(runtime.connections)
      ? runtime.connections
      : [];
    const ids = new Set(existing.map(({ id }) => id).filter(Boolean));
    for (const connection of connections) {
      if (ids.has(connection.id)) {
        invalid(`Selected resource ${connection.id} conflicts with the Blueprint.`);
      }
      ids.add(connection.id);
    }
    runtime.connections = [...existing, ...connections];
  }
  const runtimePath = runtime.codeLocation.replace(/\/$/, "");
  const instructionsPath = `${runtimePath}/instructions.md`;
  const modelLoaderPath = `${runtimePath}/model/load.py`;
  const mainPath = `${runtimePath}/main.py`;
  const governed = governedToolAssets(snapshot, runtimePath);
  const harness = {
    project: agent.projectId,
    domain: agent.domainId,
    agent: agent.id,
    blueprint: blueprintRecord.blueprintId,
    blueprintVersion: blueprintRecord.version,
    templateId: blueprintRecord.templateId,
    model: agent.modelId,
    runtimeModelId: agent.runtimeModelId,
    instructions: agent.instructions,
    modelParameters: canonical(agent.modelParameters),
    buildOptions: canonical(agent.buildOptions),
    guardrailChain: canonical(guardrailChain),
    resources: snapshot.resources.map(portableResource),
    testEvidenceHash: agent.testEvidenceHash,
  };
  return [
    ...blueprint.map((entry) => {
      if (entry.path === "agentcore/agentcore.json") {
        return {
          ...entry,
          content: `${JSON.stringify(config, null, 2)}\n`,
        };
      }
      if (entry.path === "agentcore/aws-targets.json") {
        return { ...entry, content: "[]\n" };
      }
      if (entry.path === instructionsPath) {
        return { ...entry, content: `${agent.instructions.trimEnd()}\n` };
      }
      if (entry.path === modelLoaderPath) {
        return {
          ...entry,
          content: configuredModelLoader(entry.content, agent),
        };
      }
      if (entry.path === mainPath) {
        return {
          ...entry,
          content: configuredMain(
            entry.content,
            blueprintRecord.templateId,
            agent.instructions,
          ),
        };
      }
      return entry;
    }).map((entry) => governed ? governed.transform(entry) : entry).filter(Boolean),
    ...(governed?.files || []),
    ...(
      blueprint.some(({ path }) => path === instructionsPath)
        ? []
        : [{
            path: instructionsPath,
            content: `${agent.instructions.trimEnd()}\n`,
            mode: "100644",
          }]
    ),
    {
      path: "CLAUDE.md",
      content: fullClaude(snapshot),
      mode: "100644",
    },
    {
      path: "tests/test_export_contract.py",
      content: fullContractTest({
        authorizerType: runtime.authorizerType,
        deployment: deployedName,
        entrypoint: runtime.entrypoint,
        instructionsPath,
        runtimePath,
        runtimeModelId: agent.runtimeModelId,
      }),
      mode: "100644",
    },
    {
      path: "domain-harness.json",
      content: `${JSON.stringify(harness, null, 2)}\n`,
      mode: "100644",
    },
  ];
}

function journeyEntries(preset, repositoryName, source, templates) {
  if (preset === "FULL") return fullEntries(source, templates);
  if (preset === "MINIMAL") {
    const domainId = source?.domainId;
    if (!DOMAIN_PATTERN.test(domainId)) {
      invalid("MINIMAL foundation domain is invalid.");
    }
    return [{
      path: "README.md",
      content: minimalReadme(repositoryName, domainId),
      mode: "100644",
    }];
  }
  const inception = source?.inception;
  if (!plain(inception)) invalid("SPEC inception is invalid.");
  const agent = source?.agent;
  if (
    !exact(agent, [
      "domainId",
      "projectId",
      "agentId",
      "status",
      "contractFingerprint",
      "configurationFingerprint",
    ])
    || typeof agent.domainId !== "string"
    || !DOMAIN_PATTERN.test(agent.domainId)
    || typeof agent.projectId !== "string"
    || !SLUG_PATTERN.test(agent.projectId)
    || typeof agent.agentId !== "string"
    || !SLUG_PATTERN.test(agent.agentId)
    || agent.status !== "READY_FOR_TEST"
    || !FINGERPRINT_PATTERN.test(agent.contractFingerprint)
    || !FINGERPRINT_PATTERN.test(agent.configurationFingerprint)
  ) {
    invalid("SPEC Agent binding is invalid.");
  }
  const context = {
    inception: canonical({
      ...inception,
      profile: {
        ...inception.profile,
        owner: "authenticated builder",
      },
    }),
    project: repositoryName,
  };
  return [
    {
      path: "README.md",
      content: specReadme(repositoryName, agent),
      mode: "100644",
    },
    {
      path: "agent-binding.json",
      content: `${JSON.stringify({
        version: 1,
        domainId: agent.domainId,
        projectId: agent.projectId,
        agentId: agent.agentId,
        status: agent.status,
        contractFingerprint: agent.contractFingerprint,
        configurationFingerprint: agent.configurationFingerprint,
      }, null, 2)}\n`,
      mode: "100644",
    },
    ...specSection(context),
    ...tddSection(context),
  ]
    .map((entry) => ({
      path: entry.path,
      content: entry.content,
      mode: entry.mode || "100644",
    }));
}

// DynamoDB maps do not preserve JavaScript property insertion order. Export
// bytes must be identical before and after storing the frozen source.
function canonicalSource(value) {
  if (Array.isArray(value)) return value.map(canonicalSource);
  if (plain(value)) return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalSource(value[key])]),
  );
  return value;
}

export function composeJourneyManifest({
  preset,
  repositoryName,
  source,
  templates = JOURNEY_TEMPLATES,
} = {}) {
  if (
    !PRESETS.has(preset)
    || !REPOSITORY_PATTERN.test(repositoryName)
    || !plain(source)
    || !plain(templates)
  ) {
    invalid();
  }
  source = canonicalSource(source);
  const applicationEntries = journeyEntries(preset, repositoryName, source, templates);
  const hasGovernedTool = applicationEntries.some(({ path }) =>
    path === "gates/check-governed-tool.mjs");
  let gateContract = platformGateContract({
    project: repositoryName,
    preset,
    template: preset === "FULL"
      ? source.snapshot.blueprint.template
      : {},
    guardrailChain: preset === "FULL"
      ? source.snapshot.agent.guardrailChain
      : undefined,
  });
  if (hasGovernedTool) {
    // A reusable export must not inherit another project's CI upload destination.
    gateContract = `${JSON.stringify({
      ...JSON.parse(gateContract), telemetryBucket: null,
    }, null, 2)}\n`;
  }
  const evaluation = preset === "FULL" && source.snapshot.evaluation ? evaluationAssets(source.snapshot.evaluation,{starterDataset:source.snapshot.blueprint.template.evaluationDataset}) : [];
  for(const entry of evaluation){if(entry.path==="AGENTS.md"){const prior=applicationEntries.find(f=>f.path==="AGENTS.md");if(prior)entry.content=prior.content+"\n"+entry.content;}}
  const replaced = new Set(evaluation.map(e=>e.path));
  const entries = [
    ...applicationEntries,
    ...ciEntries(templates, preset).map((entry) =>
      hasGovernedTool ? governedToolCiEntry(entry) : entry),
    {
      path: "gates/platform-gates.json",
      content: gateContract,
      mode: "100644",
    },
    {
      path: "agentcore/datasets/golden.jsonl",
      content: starterGoldenDataset(),
      mode: "100644",
    },
    ...(preset === "MINIMAL"
      ? []
      : [{
          path: "gates/README.md",
          content: gatesReadme(repositoryName, preset),
          mode: "100644",
        }]),
  ].filter(entry=>!replaced.has(entry.path)).concat(evaluation).sort((left, right) => left.path.localeCompare(right.path));

  const seen = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    if (!validPath(entry.path)) invalid("Manifest path is invalid.");
    if (seen.has(entry.path)) invalid("Manifest path is duplicated.");
    seen.add(entry.path);
    totalBytes += validContent(entry.content);
  }
  if (totalBytes > MAX_MANIFEST_BYTES) {
    invalid("Manifest is too large.");
  }
  const workflows = entries
    .map(({ path }) => path)
    .filter((path) => path.startsWith(".github/workflows/"));
  return canonical({
    version: 1,
    preset,
    repositoryName,
    entries,
    workflows,
    summary: {
      fileCount: entries.length,
      workflowCount: workflows.length,
    },
    fingerprint: fingerprint(entries),
  });
}
