import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  composeJourneyManifest,
} from "../lambda/journeys/manifest.mjs";

const CI = Object.freeze({
  ".github/workflows/compliance.yml": "name: compliance\n",
  ".github/workflows/deploy-dev.yml": "name: deploy-dev\n",
  ".github/workflows/eval.yml": "name: eval\n",
  ".github/workflows/promote.yml": "name: promote\n",
  ".github/workflows/tests.yml": "name: tests\n",
  "gates/check-guardrails.mjs": "export default true\n",
  "gates/guardrail-chain.mjs": "export default true\n",
  "gates/check-resource-bindings.mjs": "export default true\n",
  "gates/record-transcripts.mjs": "export default true\n",
  "gates/run-eval.mjs": "export default true\n",
  "gates/run-tests.mjs": "export default true\n",
});

const CHAT_CONFIG = {
  $schema: "https://schema.agentcore.aws.dev/v1/agentcore.json",
  name: "chatagent",
  version: 1,
  managedBy: "CDK",
  tags: {
    "agentcore:created-by": "agentcore-cli",
    "agentcore:project-name": "chatagent",
  },
  runtimes: [{
    name: "chat_agent",
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: "app/chat_agent/",
    runtimeVersion: "PYTHON_3_14",
    networkMode: "PUBLIC",
    protocol: "HTTP",
    authorizerType: "CUSTOM_JWT",
    authorizerConfiguration: {
      customJwtAuthorizer: {
        discoveryUrl:
          "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_Test/.well-known/openid-configuration",
        allowedClients: ["7d72mth9dp080jqkvc8kk586j8"],
      },
    },
  }],
  memories: [{ name: "chat_agentMemory", strategies: [] }],
  knowledgeBases: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [],
  configBundles: [],
  abTests: [],
  harnesses: [],
  datasets: [],
  payments: [],
};

const TEMPLATES = Object.freeze({
  blueprints: {
    chatagent: [
      {
        path: "agentcore/agentcore.json",
        content: `${JSON.stringify(CHAT_CONFIG, null, 2)}\n`,
      },
      {
        path: "agentcore/aws-targets.json",
        content: '[{"account":"must-not-leak"}]\n',
      },
      {
        path: "app/chat_agent/instructions.md",
        content: "# Role\nYou are a helpful assistant.\n",
      },
      {
        path: "app/chat_agent/main.py",
        content: "print('runnable')\n",
      },
      {
        path: "app/chat_agent/model/load.py",
        content: [
          "from strands.models.bedrock import BedrockModel",
          "",
          "",
          "def load_model() -> BedrockModel:",
          "    return BedrockModel(model_id=\"global.default\")",
          "",
        ].join("\n"),
      },
      {
        path: "app/chat_agent/pyproject.toml",
        content: "[project]\nname='chat-agent'\n",
      },
    ],
    workflowagent: [{
      path: "agentcore/agentcore.json",
      content: `${JSON.stringify({
        ...CHAT_CONFIG,
        name: "workflowagent",
        runtimes: [{
          ...CHAT_CONFIG.runtimes[0],
          name: "workflow_agent",
          codeLocation: "app/workflow_agent/",
        }],
      }, null, 2)}\n`,
    }],
  },
  ci: CI,
});

function fullSource(overrides = {}) {
  return {
    snapshot: {
      snapshotVersion: 1,
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        id: "triage-agent",
        name: "Triage Agent",
        instructions: "Routes incoming cases.",
        modelId: "bedrock-claude/anthropic.claude-sonnet-5",
        runtimeModelId: "global.anthropic.claude-sonnet-5",
        modelParameters: { maxTokens: 1024, temperature: 0.2 },
        buildOptions: {
          framework: "Strands",
          deployTarget: "AgentCore Runtime",
          memory: "longAndShortTerm",
          streaming: true,
          identity: true,
          guardrails: true,
        },
        guardrailChain: guardrailChain(),
        testEvidenceHash: "a".repeat(64),
        ...overrides,
      },
      blueprint: {
        registryId: "SharedReg123456",
        recordId: "blueprint_chat-assistant",
        version: "1.0.0",
        blueprintId: "chat-assistant",
        templateId: "chatagent",
        scope: "shared",
        template: {
          framework: "Strands",
          deployTarget: "AgentCore Runtime",
          build: "CodeZip",
          protocol: "HTTP",
          memory: "longAndShortTerm",
          streaming: true,
          identity: true,
          guardrails: true,
        },
      },
      resources: [{
        type: "TOOL",
        registryId: "SharedReg123456",
        recordId: "tool_browser",
        version: "1.0.0",
        id: "web-browser",
        binding: {
          adapter: "browser",
          status: "MATERIALIZED",
        },
      }],
    },
  };
}

function guardrailChain() {
  return [
    {
      id: "pii-detection",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "Remove personal data before continuing.",
      priority: 0,
    },
    {
      id: "harmful-content",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "",
      priority: 1,
    },
    {
      id: "jailbreaking",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "",
      priority: 2,
    },
    {
      id: "prompt-injection",
      enabled: true,
      action: "Block",
      runMode: "Pre-Agent Execution",
      message: "",
      priority: 3,
    },
    {
      id: "topic-restriction",
      enabled: true,
      action: "Flag",
      runMode: "Post-Agent Execution",
      message: "",
      priority: 4,
    },
  ];
}

function inception() {
  return {
    profile: {
      name: "billing-assistant",
      summary: "Explains invoices to internal support staff.",
      targetUsers: "Internal support staff",
      userTypes: ["internal"],
      channels: ["web"],
      capabilities: ["Explain an invoice"],
      dataSources: ["Billing API"],
      compliance: ["PII"],
      deployment: "AgentCore",
      performsActions: false,
      failureHandling: "State when the billing API is unavailable.",
      openQuestions: [],
      owner: "authenticated actor",
      domain: "customer_support",
    },
    complexity: { score: 2, level: "SIMPLE" },
    risk: {
      score: 2,
      level: "medium",
      factors: [{ points: 2, why: "compliance obligations: PII" }],
    },
    recommendations: {
      framework: {
        choice: "Strands",
        why: "platform default for single-agent conversational scope",
      },
      hosting: {
        choice: "AgentCore Runtime",
        why: "matches the deployment target named in the inception",
      },
      guardrailProfile: {
        choice: "platform-default-v1 + PII masking & audit",
        why: "compliance names PII",
      },
      riskClass: {
        choice: "medium",
        why: "compliance obligations: PII",
      },
    },
    acceptance: [{
      id: "AC-001",
      text: "Agent supports: Explain an invoice",
      test: {
        prompt: "Show me: Explain an invoice",
        kind: "capability",
        label: "Explain an invoice",
      },
    }],
  };
}

test("FULL contains runnable AgentCore source and deployment workflows", () => {
  const result = composeJourneyManifest({
    preset: "FULL",
    repositoryName: "triage-agent",
    source: fullSource(),
    templates: TEMPLATES,
  });

  const paths = result.entries.map(({ path }) => path);
  assert.ok(paths.includes("agentcore/agentcore.json"));
  assert.ok(paths.includes("app/chat_agent/main.py"));
  assert.ok(paths.includes("CLAUDE.md"));
  assert.ok(paths.includes("tests/test_export_contract.py"));
  assert.ok(paths.includes(".github/workflows/deploy-dev.yml"));
  assert.ok(paths.includes(".github/workflows/promote.yml"));
  assert.ok(paths.includes(".github/workflows/eval.yml"));
  assert.ok(paths.includes("gates/run-eval.mjs"));
  assert.ok(paths.includes("gates/check-resource-bindings.mjs"));
  assert.ok(paths.includes("gates/record-transcripts.mjs"));
  assert.ok(paths.includes("agentcore/datasets/golden.jsonl"));
  assert.equal(
    result.entries.find(({ path }) =>
      path === "agentcore/aws-targets.json").content,
    "[]\n",
  );
  const config = JSON.parse(
    result.entries.find(({ path }) =>
      path === "agentcore/agentcore.json").content,
  );
  assert.match(config.name, /^[A-Za-z][A-Za-z0-9]{0,22}$/);
  assert.equal(config.tags["auto-delete"], "no");
  assert.equal(config.tags["domain-id"], "customer_support");
  assert.equal(config.tags["project-id"], "case-assist");
  assert.equal(config.tags.component, "runtime");
  assert.equal(config.tags["managed-by"], "agentic-platform");
  assert.equal(config.runtimes[0].authorizerConfiguration, undefined);
  assert.equal(
    JSON.stringify(config).includes("cognito-idp.us-west-2.amazonaws.com"),
    false,
  );
  assert.equal(
    JSON.stringify(config).includes("7d72mth9dp080jqkvc8kk586j8"),
    false,
  );
  assert.deepEqual(config.runtimes[0].connections, [{
    id: "web-browser",
    to: { type: "browser" },
  }]);
  assert.ok(
    config.memories.every(({ name }) =>
      /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name)),
  );
  assert.equal(
    result.entries.find(({ path }) =>
      path === "app/chat_agent/instructions.md").content,
    "Routes incoming cases.\n",
  );
  const modelLoader = result.entries.find(({ path }) =>
    path === "app/chat_agent/model/load.py").content;
  assert.match(
    modelLoader,
    /model_id="global\.anthropic\.claude-sonnet-5"/,
  );
  assert.match(modelLoader, /temperature=0\.2/);
  assert.match(modelLoader, /max_tokens=1024/);
  const harness = JSON.parse(
    result.entries.find(({ path }) =>
      path === "domain-harness.json").content,
  );
  assert.equal(harness.instructions, "Routes incoming cases.");
  assert.deepEqual(result.workflows, [
    ".github/workflows/compliance.yml",
    ".github/workflows/deploy-dev.yml",
    ".github/workflows/eval.yml",
    ".github/workflows/promote.yml",
    ".github/workflows/tests.yml",
  ]);
});

test("workflow FULL applies selected instructions to the runnable source", () => {
  const source = fullSource();
  source.snapshot.blueprint = {
    ...source.snapshot.blueprint,
    blueprintId: "workflow-orchestrator",
    templateId: "workflowagent",
    template: {
      framework: "Strands",
      deployTarget: "AgentCore Runtime",
      build: "CodeZip",
      protocol: "HTTP",
      memory: "shortTerm",
      streaming: true,
      identity: false,
      guardrails: true,
    },
  };
  source.snapshot.agent.buildOptions = {
    framework: "Strands",
    deployTarget: "AgentCore Runtime",
    memory: "shortTerm",
    streaming: true,
    identity: false,
    guardrails: true,
  };
  const result = composeJourneyManifest({
    preset: "FULL",
    repositoryName: "workflow-agent",
    source,
  });
  const main = result.entries.find(({ path }) =>
    path === "app/workflow_agent/main.py").content;
  assert.match(main, /DEFAULT_SYSTEM_PROMPT = "Routes incoming cases\."/);
  assert.equal(
    result.entries.find(({ path }) =>
      path === "app/workflow_agent/instructions.md").content,
    "Routes incoming cases.\n",
  );
  const config = JSON.parse(
    result.entries.find(({ path }) =>
      path === "agentcore/agentcore.json").content,
  );
  assert.equal(config.runtimes[0].authorizerType, "NONE");
  assert.equal(config.memories.length, 1);
  assert.deepEqual(config.memories[0].strategies, []);
});

test("FULL exports the persisted guardrail chain into harness and gate contracts", () => {
  const source = fullSource({ guardrailChain: guardrailChain() });
  const result = composeJourneyManifest({
    preset: "FULL",
    repositoryName: "guarded-agent",
    source,
  });
  const harness = JSON.parse(
    result.entries.find(({ path }) =>
      path === "domain-harness.json").content,
  );
  const gates = JSON.parse(
    result.entries.find(({ path }) =>
      path === "gates/platform-gates.json").content,
  );

  assert.deepEqual(harness.guardrailChain, guardrailChain());
  assert.deepEqual(gates.guardrailChain, guardrailChain());
  assert.match(
    gates.guardrails["content-guardrails"].description,
    /configuration conformance/i,
  );
  assert.doesNotMatch(
    gates.guardrails["content-guardrails"].description,
    /protects model calls|runtime enforcement/i,
  );
});

test("FULL rejects immutable legacy snapshots without a guardrail chain", () => {
  const source = fullSource();
  delete source.snapshot.agent.guardrailChain;

  assert.throws(
    () => composeJourneyManifest({
      preset: "FULL",
      repositoryName: "legacy-agent",
      source,
    }),
    /valid guardrail chain/i,
  );
});

test("FULL generated runtime contract fails on an entrypoint import error", () => {
  const templates = structuredClone(TEMPLATES);
  templates.blueprints.chatagent.find(({ path }) =>
    path === "app/chat_agent/main.py").content =
      "import missing_runtime_dependency\n";
  const manifest = composeJourneyManifest({
    preset: "FULL",
    repositoryName: "broken-runtime",
    source: fullSource(),
    templates,
  });
  const directory = mkdtempSync(join(tmpdir(), "journey-runtime-import-"));
  try {
    for (const entry of manifest.entries) {
      const output = join(directory, entry.path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.content, { mode: 0o644 });
    }
    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import importlib.util",
          "p='tests/test_export_contract.py'",
          "s=importlib.util.spec_from_file_location('contract', p)",
          "m=importlib.util.module_from_spec(s)",
          "s.loader.exec_module(m)",
          "m.test_runtime_entrypoint_imports()",
        ].join(";"),
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing_runtime_dependency/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MINIMAL contains foundation gates and no app, spec, or deployment workflow", () => {
  const result = composeJourneyManifest({
    preset: "MINIMAL",
    repositoryName: "new-agent-foundation",
    source: { domainId: "customer_support" },
    templates: TEMPLATES,
  });

  const paths = result.entries.map(({ path }) => path);
  assert.equal(paths.some((path) => path.startsWith("app/")), false);
  assert.equal(paths.includes("CLAUDE.md"), false);
  assert.equal(paths.includes("SPEC.md"), false);
  assert.equal(paths.includes(".github/workflows/deploy-dev.yml"), false);
  assert.equal(paths.includes(".github/workflows/promote.yml"), false);
  assert.ok(paths.includes(".github/workflows/eval.yml"));
  assert.ok(paths.includes("gates/run-eval.mjs"));
  assert.equal(paths.includes("gates/record-transcripts.mjs"), false);
  assert.ok(paths.includes("agentcore/datasets/golden.jsonl"));
  assert.ok(paths.includes("README.md"));
  const gates = JSON.parse(
    result.entries.find(({ path }) =>
      path === "gates/platform-gates.json").content,
  );
  assert.equal(gates.allowNoTests, true);
  assert.equal(
    Object.hasOwn(gates.guardrails, "content-guardrails"),
    false,
  );
  assert.equal(
    gates.protectedFiles.includes("gates/platform-gates.json"),
    false,
  );
});

test("bundled canonical templates are the default runtime source", () => {
  const result = composeJourneyManifest({
    preset: "MINIMAL",
    repositoryName: "bundled-foundation",
    source: { domainId: "customer_support" },
  });
  assert.ok(
    result.entries.some(({ path }) =>
      path === ".github/workflows/compliance.yml"),
  );
});

test("FULL preserves portable governed resources without leaking source content", () => {
  const input = fullSource();
  input.snapshot.resources = [
    {
      type: "TOOL",
      registryId: "SharedReg123456",
      recordId: "tool_browser",
      version: "1.0.0",
      id: "web-browser",
      binding: {
        adapter: "browser",
        status: "MATERIALIZED",
      },
    },
    {
      type: "MCP_SERVER",
      registryId: "SharedReg123456",
      recordId: "mcp_support",
      version: "1.0.0",
      id: "support-mcp",
      binding: {
        adapter: "remote_mcp",
        status: "DEPLOYMENT_REQUIRED",
      },
    },
    {
      type: "SKILL",
      registryId: "SharedReg123456",
      recordId: "skill_case-triage",
      version: "1.0.0",
      id: "case-triage",
      binding: {
        adapter: "skill",
        status: "DEPLOYMENT_REQUIRED",
      },
    },
    {
      type: "MEMORY",
      registryId: "SharedReg123456",
      recordId: "memory_support",
      version: "1.0.0",
      id: "support-memory",
      binding: {
        adapter: "memory",
        status: "DEPLOYMENT_REQUIRED",
      },
    },
    {
      type: "KNOWLEDGE_BASE",
      registryId: "SharedReg123456",
      recordId: "kb_support",
      version: "1.0.0",
      id: "support-kb",
      binding: {
        adapter: "knowledge_base",
        status: "DEPLOYMENT_REQUIRED",
      },
    },
  ];

  const result = composeJourneyManifest({
    preset: "FULL",
    repositoryName: "triage-agent",
    source: input,
    templates: TEMPLATES,
  });
  const config = JSON.parse(
    result.entries.find(({ path }) =>
      path === "agentcore/agentcore.json").content,
  );
  assert.deepEqual(config.runtimes[0].connections, [{
    id: "web-browser",
    to: { type: "browser" },
  }]);
  const harness = JSON.parse(
    result.entries.find(({ path }) =>
      path === "domain-harness.json").content,
  );
  assert.deepEqual(
    harness.resources,
    input.snapshot.resources.map(({ type, version, id, binding }) => ({
      type,
      version,
      id,
      binding,
    })),
  );
  const serialized = JSON.stringify(result.entries);
  for (const forbidden of [
    "registryId",
    "recordId",
    "resource.content",
    "arn:aws",
    "111122223333",
    "operator@example.com",
    "clientSecret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("FULL rejects arbitrary Registry content in a frozen resource", () => {
  const input = fullSource();
  input.snapshot.resources[0].content = {
    clientSecret: "must-not-export",
  };

  assert.throws(
    () => composeJourneyManifest({
      preset: "FULL",
      repositoryName: "triage-agent",
      source: input,
      templates: TEMPLATES,
    }),
    /resolved resources are invalid/i,
  );
});

test("SPEC contains deterministic contract and no runnable source or deployment workflow", () => {
  const input = {
    preset: "SPEC",
    repositoryName: "billing-assistant",
    source: {
      journeyId: "journey-1",
      inception: inception(),
      agent: {
        domainId: "customer_support",
        projectId: "case-assist",
        agentId: "billing-assistant",
        status: "READY_FOR_TEST",
        contractFingerprint: "a".repeat(64),
        configurationFingerprint: "b".repeat(64),
      },
    },
    templates: TEMPLATES,
  };
  const first = composeJourneyManifest(input);
  const second = composeJourneyManifest(structuredClone(input));
  const paths = first.entries.map(({ path }) => path);

  assert.equal(paths.some((path) => path.startsWith("app/")), false);
  assert.equal(paths.includes(".github/workflows/deploy-dev.yml"), false);
  assert.ok(paths.includes(".github/workflows/eval.yml"));
  assert.ok(paths.includes("gates/run-eval.mjs"));
  assert.equal(paths.includes("gates/record-transcripts.mjs"), false);
  assert.ok(paths.includes("agentcore/datasets/golden.jsonl"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("agent-binding.json"));
  assert.ok(paths.includes("CLAUDE.md"));
  assert.ok(paths.includes("SPEC.md"));
  assert.ok(paths.includes("tests/test_acceptance.py"));
  const gates = JSON.parse(
    first.entries.find(({ path }) =>
      path === "gates/platform-gates.json").content,
  );
  assert.equal(
    Object.hasOwn(gates.guardrails, "content-guardrails"),
    false,
  );
  assert.deepEqual(first, second);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  const content = first.entries.map((entry) => entry.content).join("\n");
  assert.doesNotMatch(content, /authenticated actor/i);
  assert.match(content, /authenticated builder/i);
  assert.match(content, /configured and ready for explicit\s+testing/i);
  assert.match(content, /not runnable/i);
  assert.deepEqual(
    JSON.parse(
      first.entries.find(({ path }) =>
        path === "agent-binding.json").content,
    ),
    {
      version: 1,
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "billing-assistant",
      status: "READY_FOR_TEST",
      contractFingerprint: "a".repeat(64),
      configurationFingerprint: "b".repeat(64),
    },
  );
});

test("SPEC rejects malformed or draft Agent bindings", () => {
  const source = {
    journeyId: "journey-1",
    inception: inception(),
    agent: {
      domainId: "customer_support",
      projectId: "case-assist",
      agentId: "billing-assistant",
      status: "READY_FOR_TEST",
      contractFingerprint: "a".repeat(64),
      configurationFingerprint: "b".repeat(64),
    },
  };
  for (const agent of [
    { ...source.agent, status: "DRAFT" },
    { ...source.agent, agentId: undefined },
    { ...source.agent, unexpected: true },
  ]) {
    assert.throws(
      () => composeJourneyManifest({
        preset: "SPEC",
        repositoryName: "billing-assistant",
        source: { ...source, agent },
        templates: TEMPLATES,
      }),
      /SPEC Agent binding is invalid/i,
    );
  }
});

test("manifest rejects malformed evidence, unsupported blueprints, and unsafe files", () => {
  const mismatchedOptions = fullSource();
  mismatchedOptions.snapshot.agent.buildOptions = {
    ...mismatchedOptions.snapshot.agent.buildOptions,
    identity: false,
  };
  const unguarded = fullSource();
  unguarded.snapshot.agent.buildOptions = {
    ...unguarded.snapshot.agent.buildOptions,
    guardrails: false,
  };
  unguarded.snapshot.blueprint.template = {
    ...unguarded.snapshot.blueprint.template,
    guardrails: false,
  };
  for (const source of [
    fullSource({ testEvidenceHash: "not-a-hash" }),
    mismatchedOptions,
    unguarded,
    {
      ...fullSource(),
      snapshot: {
        ...fullSource().snapshot,
        blueprint: {
          ...fullSource().snapshot.blueprint,
          templateId: "published-concept-only",
        },
      },
    },
  ]) {
    assert.throws(
      () => composeJourneyManifest({
        preset: "FULL",
        repositoryName: "triage-agent",
        source,
        templates: TEMPLATES,
      }),
      /invalid|tested|blueprint/i,
    );
  }
  assert.throws(
    () => composeJourneyManifest({
      preset: "FULL",
      repositoryName: "triage-agent",
      source: fullSource(),
      templates: {
        ...TEMPLATES,
        blueprints: {
          ...TEMPLATES.blueprints,
          chatagent: [
            ...TEMPLATES.blueprints.chatagent,
            { path: "../escape", content: "bad" },
          ],
        },
      },
    }),
    /path/i,
  );
  assert.throws(
    () => composeJourneyManifest({
      preset: "MINIMAL",
      repositoryName: "safe-name",
      source: { domainId: "customer_support" },
      templates: {
        ...TEMPLATES,
        ci: {
          ...CI,
          ".github/workflows/compliance.yml":
            `github_pat_${"a".repeat(40)}`,
        },
      },
    }),
    /secret/i,
  );
});

test("materialized compliance gate cannot be weakened through its config", () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-gate-tamper-"));
  try {
    const manifest = composeJourneyManifest({
      preset: "FULL",
      repositoryName: "triage-agent",
      source: fullSource(),
    });
    for (const entry of manifest.entries) {
      const output = join(directory, entry.path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.content, { mode: 0o644 });
    }
    const gatePath = join(directory, "gates/platform-gates.json");
    const gate = JSON.parse(
      manifest.entries.find(({ path }) =>
        path === "gates/platform-gates.json").content,
    );
    gate.guardrailChain[0].enabled = false;
    writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);
    const weakenedGuardrailCheck = spawnSync(
      process.execPath,
      ["gates/check-guardrails.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(weakenedGuardrailCheck.status, 0);
    assert.match(
      `${weakenedGuardrailCheck.stderr}\n${weakenedGuardrailCheck.stdout}`,
      /mandatory guardrail.*cannot be disabled/i,
    );

    gate.guardrailChain[0].enabled = true;
    gate.allowNoTests = true;
    writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);
    const exemptionCheck = spawnSync(
      process.execPath,
      ["gates/check-guardrails.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(exemptionCheck.status, 0);
    assert.match(
      `${exemptionCheck.stderr}\n${exemptionCheck.stdout}`,
      /allowNoTests must be true only for MINIMAL/i,
    );

    gate.protectedFiles = [];
    gate.guardrails = {};
    writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);

    const check = spawnSync(
      process.execPath,
      ["gates/check-guardrails.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(check.status, 0);
    assert.match(
      `${check.stderr}\n${check.stdout}`,
      /required protected gate file|required guardrail control/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("guardrail conformance does not claim unimplemented runtime enforcement", () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-guardrail-contract-"));
  try {
    const manifest = composeJourneyManifest({
      preset: "FULL",
      repositoryName: "triage-agent",
      source: fullSource(),
    });
    for (const entry of manifest.entries) {
      const output = join(directory, entry.path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.content, { mode: 0o644 });
    }
    const configPath = join(directory, "agentcore/agentcore.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.policyEngines = [];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const check = spawnSync(
      process.execPath,
      ["gates/check-guardrails.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(
      check.status,
      0,
      `${check.stderr}\n${check.stdout}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("generated guardrail conformance rejects fields outside the canonical contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "journey-guardrail-shape-"));
  try {
    const manifest = composeJourneyManifest({
      preset: "FULL",
      repositoryName: "triage-agent",
      source: fullSource(),
    });
    for (const entry of manifest.entries) {
      const output = join(directory, entry.path);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.content, { mode: 0o644 });
    }
    const gatePath = join(directory, "gates/platform-gates.json");
    const harnessPath = join(directory, "domain-harness.json");
    const gate = JSON.parse(readFileSync(gatePath, "utf8"));
    const harness = JSON.parse(readFileSync(harnessPath, "utf8"));
    gate.guardrailChain[0].unexpected = true;
    harness.guardrailChain[0].unexpected = true;
    writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);
    writeFileSync(harnessPath, `${JSON.stringify(harness, null, 2)}\n`);

    const check = spawnSync(
      process.execPath,
      ["gates/check-guardrails.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    assert.notEqual(check.status, 0);
    assert.match(
      `${check.stderr}\n${check.stdout}`,
      /guardrailChain.*malformed|canonical guardrail/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("materialized presets pass their bundled guardrail checker", () => {
  const cases = [
    {
      preset: "FULL",
      repositoryName: "triage-agent",
      source: fullSource(),
    },
    {
      preset: "MINIMAL",
      repositoryName: "foundation-only",
      source: { domainId: "customer_support" },
    },
    {
      preset: "SPEC",
      repositoryName: "billing-assistant",
      source: {
        journeyId: "journey-1",
        inception: inception(),
        agent: {
          domainId: "customer_support",
          projectId: "case-assist",
          agentId: "billing-assistant",
          status: "READY_FOR_TEST",
          contractFingerprint: "a".repeat(64),
          configurationFingerprint: "b".repeat(64),
        },
      },
    },
  ];
  for (const input of cases) {
    const directory = mkdtempSync(join(tmpdir(), "journey-manifest-"));
    try {
      const manifest = composeJourneyManifest(input);
      for (const entry of manifest.entries) {
        const output = join(directory, entry.path);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, entry.content, { mode: 0o644 });
      }
      const check = spawnSync(
        process.execPath,
        ["gates/check-guardrails.mjs"],
        { cwd: directory, encoding: "utf8" },
      );
      assert.equal(
        check.status,
        0,
        `${input.preset}: ${check.stderr || check.stdout}`,
      );
      if (input.preset === "MINIMAL") {
        const tests = spawnSync(
          process.execPath,
          ["gates/run-tests.mjs"],
          { cwd: directory, encoding: "utf8" },
        );
        assert.equal(
          tests.status,
          0,
          `${input.preset}: ${tests.stderr || tests.stdout}`,
        );
      }
      if (input.preset === "FULL") {
        const contractSource = manifest.entries.find(({ path }) =>
          path === "tests/test_export_contract.py").content;
        assert.match(contractSource, /importlib\.import_module/);
        const contract = spawnSync(
          "python3",
          [
            "-c",
            [
              "import importlib.util",
              "p='tests/test_export_contract.py'",
              "s=importlib.util.spec_from_file_location('contract', p)",
              "m=importlib.util.module_from_spec(s)",
              "s.loader.exec_module(m)",
              "m.test_agentcore_configuration_is_portable_and_tagged()",
              "m.test_selected_runtime_configuration_is_materialized()",
            ].join(";"),
          ],
          { cwd: directory, encoding: "utf8" },
        );
        assert.equal(
          contract.status,
          0,
          `${input.preset}: ${contract.stderr || contract.stdout}`,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("FULL preview bytes survive DynamoDB map property reordering", () => {
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
 const source=fullSource();const options={preset:"FULL",repositoryName:"stable-customer-care",templates:TEMPLATES};
 const before=composeJourneyManifest({...options,source});
 const after=composeJourneyManifest({...options,source:reorder(source)});
 assert.equal(after.fingerprint,before.fingerprint);assert.deepEqual(after.entries,before.entries);assert.deepEqual(after.summary,before.summary);
});

test('untested constructs export real optional evaluation assets in the immutable manifest',()=>{
 const source=fullSource({testEvidenceHash:null});
 source.snapshot.evaluation={dataset:{source:'upload',content:'{"id":"own-case","input":"Help","expected":"answer"}\n'},evaluator:{type:'python',code:'def evaluate(case, result):\n    return {"score": 0, "reason": "implement"}\n'}};
 const manifest=composeJourneyManifest({preset:'FULL',repositoryName:'triage-agent',source,templates:TEMPLATES});
 assert.equal(manifest.entries.find(f=>f.path==='evaluation/dataset.jsonl').content,source.snapshot.evaluation.dataset.content);
 assert.equal(manifest.entries.find(f=>f.path==='evaluation/evaluator.py').content,source.snapshot.evaluation.evaluator.code);
 assert.match(manifest.entries.find(f=>f.path==='.github/workflows/eval.yml').content,/pytest/);
 assert.ok(manifest.entries.some(f=>f.path==='gates/check-guardrails.mjs'));
 assert.ok(manifest.entries.some(f=>f.path==='AGENTS.md'));
 source.snapshot.evaluation.dataset={source:'later'};
 const deferred=composeJourneyManifest({preset:'FULL',repositoryName:'triage-agent',source,templates:TEMPLATES});
 assert.notEqual(deferred.fingerprint,manifest.fingerprint);
 assert.ok(!deferred.entries.some(f=>f.path==='evaluation/dataset.jsonl'));
});

test('configured evaluation exports preserve executable Foundation conformance checks',()=>{
 const source=fullSource({testEvidenceHash:null});
 source.snapshot.evaluation={dataset:{source:'later'},evaluator:{type:'later'}};
 const manifest=composeJourneyManifest({preset:'FULL',repositoryName:'triage-agent',source});
 const root=mkdtempSync(join(tmpdir(),'handoff-foundation-'));
 try{
  for(const file of manifest.entries){const target=join(root,file.path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,file.content);}
  const result=spawnSync(process.execPath,['gates/check-guardrails.mjs'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const gate=JSON.parse(readFileSync(join(root,'gates/platform-gates.json')));gate.guardrails['content-guardrails'].enabled=false;writeFileSync(join(root,'gates/platform-gates.json'),JSON.stringify(gate));
  assert.notEqual(spawnSync(process.execPath,['gates/check-guardrails.mjs'],{cwd:root}).status,0,'Custom evaluation must not bypass Foundation controls');
 }finally{rmSync(root,{recursive:true,force:true});}
});
