# Chat Agent — Foundation Harness Blueprint

> **This is a platform-provided Foundation Harness blueprint.** The platform team
> pre-wired identity, memory, observability, and guardrails. You (the domain team)
> add only your domain content. Read this section before you change anything.

## Verify an exported project locally

For a FULL console export (which contains `gates/` and `domain-harness.json`),
use Node.js 22 or newer, the AgentCore CLI, Python and `uv`. Work inside an
isolated environment before running the repository's gates:

```bash
uv venv --seed .venv
source .venv/bin/activate
agentcore validate
node gates/check-guardrails.mjs
node gates/run-tests.mjs
```

Then start `python app/chat_agent/main.py` with credentials for your authorized
AWS development account and `AWS_REGION` set to the target region. In another
terminal run `node gates/record-transcripts.mjs`, then
`node gates/run-eval.mjs --mode assert`. Missing transcripts must fail the gate;
never replace them with handwritten success evidence. The initial three smoke
scenarios are a starting point: add domain-specific quality and safety tests.

The MCP client uses the supported 1.x transport API; keep its declared major
version bound until that integration is explicitly upgraded and tested.
A local test does not provision memory, attach a runtime guardrail, configure
GitHub OIDC, or approve production. Use the shipped delivery workflows and the
platform's exact-release human approval for those stages.

## Foundation Harness vs Domain Harness — what you own

This blueprint follows the hybrid platform pattern: the **platform team owns the
control plane**, the **domain team owns the application plane**.

| Layer | Owner | Where it lives | Change it? |
| --- | --- | --- | --- |
| **Foundation Harness** (identity, memory, observability, guardrails, runtime) | Platform team | `agentcore/agentcore.json` (`runtimes`, `memories`, `policyEngines`), CDK | 🔒 **Do not edit** — locked by the platform |
| **Domain Harness** (persona, skills, domain tools, domain eval) | You (domain team) | `app/chat_agent/` (`main.py` system prompt + `tools`), and domain skills/tools you add | ✅ **This is your job** |

### What the platform already gave you (do NOT rebuild these)

- **Identity** — AgentCore Identity / IAM execution role, wired at deploy time.
- **Memory** — AgentCore Memory with SEMANTIC + USER_PREFERENCE + SUMMARIZATION +
  EPISODIC strategies, namespaced per user (`/users/{actorId}/...`). See
  `app/chat_agent/memory/session.py`. It is already connected in `main.py`.
- **Observability** — AgentCore Runtime auto-emits CloudWatch metrics + OTEL traces
  per session. No code needed.
- **Guardrails / policy** — attach a Cedar `policyEngine` (platform-managed) rather
  than hand-rolling content checks.
- **Runtime** — managed microVM-isolated sessions via `BedrockAgentCoreApp` in `main.py`.

### What YOU add (the Domain Harness)

1. **Persona** — edit `app/chat_agent/instructions.md`, the runtime instruction file.
2. **Domain skills** — `agentcore add skill --harness chat_agent --git <your-skill-repo>`
   (or `--aws-skills`, or `--path`).
3. **Domain tools** — `agentcore add tool --harness chat_agent --type <type>` (e.g.
   `agentcore_gateway` to reach your enterprise APIs, `remote_mcp`, `inline_function`),
   or add `@tool` functions directly in `main.py`.
4. **Domain eval** — add golden datasets + an evaluator (`agentcore add evaluator`) for
   your use-case quality bar.

### Golden rules

- **`agentcore.json` is the source of truth.** Do not edit generated CDK in `agentcore/cdk/`.
- **Do not touch `runtimes`, `memories`, or `policyEngines`** — those are the foundation
  the platform locked. If you need a change there, ask the platform team.
- Run `agentcore validate` after any config edit. Run `agentcore dev` to test locally.
- Keep the foundation intact; differentiate in the domain layer.

---

## AgentCore Project (reference)

This project contains configuration and infrastructure for an Amazon Bedrock AgentCore application.

The `agentcore/` directory is a declarative model of the project. The `agentcore/cdk/` subdirectory uses the
`@aws/agentcore-cdk` L3 constructs to deploy the configuration to AWS.

## Mental Model

The project uses a **flat resource model**. Agents, memories, credentials, gateways, evaluators, and policies are
independent top-level arrays in `agentcore.json`. There is no binding between resources in the schema — each resource is
provisioned independently. Agents discover memories and credentials at runtime via environment variables or SDK calls.
Tags defined in `agentcore.json` flow through to deployed CloudFormation resources.

## Critical Invariants

1. **Schema-First Authority:** The `.json` files are the source of truth. Do not modify agent behavior by editing
   generated CDK code in `cdk/`.
2. **Resource Identity:** The `name` field determines the CloudFormation Logical ID.
   - **Renaming** a resource will **destroy and recreate** it.
   - **Modifying** other fields will update the resource **in-place**.
3. **Schema Validation:** Schema validation is necessary but does not prove deployment readiness. Verify target account, permissions, model access and runtime dependencies as well. Run
   `agentcore validate` to check.
4. **Resource Removal:** Use `agentcore remove` to remove resources. Run `agentcore deploy` after removal to tear down
   deployed infrastructure.

## Directory Structure

```
myProject/
├── AGENTS.md               # This file — AI coding assistant context
├── agentcore/
│   ├── agentcore.json      # Main project config (AgentCoreProjectSpec)
│   ├── aws-targets.json    # Deployment targets (account + region)
│   ├── .env.local          # Secrets — API keys (gitignored)
│   ├── .llm-context/       # TypeScript type definitions for AI assistants
│   │   ├── README.md       # Guide to using schema files
│   │   ├── agentcore.ts    # AgentCoreProjectSpec types
│   │   ├── aws-targets.ts  # AWS deployment target types
│   │   └── mcp.ts          # Gateway and MCP tool types
│   └── cdk/                # AWS CDK project (@aws/agentcore-cdk L3 constructs)
├── app/                    # Agent application code
└── evaluators/             # Custom evaluator code (if any)
```

## Schema Reference

The `agentcore/.llm-context/` directory contains TypeScript type definitions optimized for AI coding assistants. Each
file maps to a JSON config file and includes validation constraints as comments (`@regex`, `@min`, `@max`).

| JSON Config | Schema File | Root Type |
| --- | --- | --- |
| `agentcore/agentcore.json` | `agentcore/.llm-context/agentcore.ts` | `AgentCoreProjectSpec` |
| `agentcore/agentcore.json` (gateways) | `agentcore/.llm-context/mcp.ts` | `AgentCoreMcpSpec` |
| `agentcore/aws-targets.json` | `agentcore/.llm-context/aws-targets.ts` | `AwsDeploymentTarget[]` |

### Key Types

- **AgentCoreProjectSpec**: Root config with `runtimes`, `memories`, `credentials`, `agentCoreGateways`, `evaluators`, `onlineEvalConfigs`, `onlineInsightsConfigs`, `knowledgeBases`, `harnesses`, `policyEngines`, `policies`, `payments` (managers + connectors), `configBundles`, `datasets`, `runtimeEndpoints` arrays
- **AgentEnvSpec**: Agent configuration (build type, entrypoint, code location, runtime version, network mode)
- **Memory**: Memory resource with strategies (SEMANTIC, SUMMARIZATION, USER_PREFERENCE, EPISODIC) and expiry
- **Credential**: API key or OAuth credential provider
- **AgentCoreGateway**: MCP gateway with targets (Lambda, MCP server, OpenAPI, Smithy, API Gateway, web-search, knowledge-base)
- **Evaluator**: LLM-as-a-Judge or code-based evaluator
- **OnlineEvalConfig**: Continuous evaluation pipeline bound to an agent
- **OnlineInsightsConfig** _[preview]_: Continuous failure-pattern analysis bound to an agent
- **KnowledgeBase**: Managed Bedrock Knowledge Base auto-wired to a gateway
- **Harness**: Declarative agent — runtime + tools + skills + memory + observability without writing agent code
- **PolicyEngine** + **Policy**: Cedar policy engine with form-based guardrails (Bedrock content filters, prompt-attack, sensitive-info) or raw Cedar policies
- **PaymentManager** + **PaymentConnector**: x402-protocol payment orchestration with provider credentials (CoinbaseCDP, StripePrivy)
- **ConfigBundle**: Versioned runtime configuration as a separately-deployable resource
- **Dataset**: Curated session dataset for batch evaluation and recommendation runs
- **RuntimeEndpoint**: Named endpoint (e.g. `PROMPT_V1`) targeting a specific runtime version

### Common Enum Values

- **BuildType**: `'CodeZip'` | `'Container'`
- **NetworkMode**: `'PUBLIC'` | `'VPC'`
- **RuntimeVersion**: `'PYTHON_3_10'` | `'PYTHON_3_11'` | `'PYTHON_3_12'` | `'PYTHON_3_13'` | `'PYTHON_3_14'` | `'NODE_18'` | `'NODE_20'` | `'NODE_22'`
- **MemoryStrategyType**: `'SEMANTIC'` | `'SUMMARIZATION'` | `'USER_PREFERENCE'` | `'EPISODIC'`
- **GatewayTargetType**: `'lambda'` | `'mcpServer'` | `'openApiSchema'` | `'smithyModel'` | `'apiGateway'` | `'lambdaFunctionArn'` | `'connector'` (web-search, bedrock-knowledge-bases)
- **ModelProvider**: `'Bedrock'` | `'Gemini'` | `'OpenAI'` | `'Anthropic'`
- **PaymentProvider**: `'CoinbaseCDP'` | `'StripePrivy'`
- **PolicyEnforcementMode**: `'ACTIVE'` | `'PASSIVE'`
- **GuardrailContentFilter**: `'VIOLENCE'` | `'HATE'` | `'SEXUAL'` | `'MISCONDUCT'` | `'INSULTS'`

### Build Types

- **CodeZip**: Python source packaged as a zip and deployed directly to AgentCore Runtime.
- **Container**: Docker image built in CodeBuild (ARM64), pushed to a per-agent ECR repository. Requires a `Dockerfile`
  in the agent's `codeLocation` directory. For local development (`agentcore dev`), the container is built and run
  locally with volume-mounted hot-reload.

### Supported Frameworks (for template agents)

- **Strands** — Bedrock, Anthropic, OpenAI, Gemini
- **LangChain/LangGraph** — Bedrock, Anthropic, OpenAI, Gemini
- **GoogleADK** — Gemini
- **OpenAI Agents** — OpenAI
- **Autogen** — Bedrock, Anthropic, OpenAI, Gemini

### Protocols

- **HTTP** — Standard HTTP agent endpoint
- **MCP** — Model Context Protocol server
- **A2A** — Agent-to-Agent protocol (Google A2A)

## Deployment

Deployments are orchestrated through the CLI:

```bash
agentcore deploy    # Synthesizes CDK and deploys to AWS
agentcore status    # Shows deployment status
```

Alternatively, deploy directly via CDK:

```bash
cd agentcore/cdk
npm install
npx cdk synth
npx cdk deploy
```

## Editing Schemas

When modifying JSON config files:

1. Read the corresponding `agentcore/.llm-context/*.ts` file for type definitions
2. Check validation constraint comments (`@regex`, `@min`, `@max`)
3. Use exact enum values as string literals
4. Use CloudFormation-safe names (alphanumeric, start with letter)
5. Run `agentcore validate` to verify changes

## Harness Export

`agentcore export harness` converts a harness configuration into a deployable Strands Python agent under `app/<agentName>/`.

**After every export, you MUST read `app/<agentName>/EXPORT_NOTES.md` before proceeding.**

This file lists any manual follow-up items required before the agent will deploy or run correctly — missing files to create, IAM policies to add, or configuration steps the exporter could not automate. A clean export produces "No manual steps required." Complete every item in the file before running `agentcore deploy`.

```bash
agentcore export harness --name <harnessName>   # generates app/<agentName>/EXPORT_NOTES.md
cat app/<agentName>/EXPORT_NOTES.md             # read this before touching anything else
```

## CLI Commands

Run `agentcore --help` or `agentcore <command> --help` for full flags. Commonly used:

**Project lifecycle**

| Command | Description |
| --- | --- |
| `agentcore create` | Create a new project |
| `agentcore dev` | Run agent locally with hot-reload |
| `agentcore deploy` | Deploy to AWS |
| `agentcore invoke` | Invoke agent (local or deployed) |
| `agentcore status` | Show deployment status |
| `agentcore validate` | Validate configuration |
| `agentcore package` | Package agent artifacts |
| `agentcore import` | Import resources from a Bedrock AgentCore Starter Toolkit project |

**Resources**

| Command | Description |
| --- | --- |
| `agentcore add <resource>` | Add agent, memory, credential, gateway, gateway-target, evaluator, online-eval, online-insights, knowledge-base, harness, policy-engine, policy, payment-manager, payment-connector, config-bundle, dataset, runtime-endpoint |
| `agentcore remove <resource>` | Remove any resource |
| `agentcore export harness` | Export a harness to a Strands runtime agent under `app/<agentName>/` |

**Jobs (run, view, archive, lifecycle)**

| Command | Description |
| --- | --- |
| `agentcore run eval` | Run on-demand evaluation against agent traces |
| `agentcore run batch-evaluation` | Run evaluators across all sessions at scale |
| `agentcore run recommendation` | Optimize prompts or tool descriptions from real traces |
| `agentcore run insights` _[preview]_ | Run failure-pattern analysis across sessions |
| `agentcore run ab-test` | Start an A/B test (config-bundle or target-based) |
| `agentcore run ingest` | Start a fresh ingestion job for every data source on a deployed knowledge base |
| `agentcore view <type>` | List or view jobs (recommendation, batch-evaluation, ab-test, insights) |
| `agentcore archive <type>` | Delete a job on the service + clear local history |
| `agentcore stop <type>` | Stop a running batch-evaluation or ab-test |
| `agentcore promote ab-test` | Apply the winning variant to `agentcore.json` |
| `agentcore pause <type>` / `agentcore resume <type>` | Pause/resume a deployed online-eval, online-insights, or ab-test |

**Config bundles & datasets**

| Command | Description |
| --- | --- |
| `agentcore config-bundle versions` (alias `cb versions`) | List version history for a bundle |
| `agentcore config-bundle diff` | Diff two versions of a bundle |
| `agentcore config-bundle create-branch` | Create a new branch on an existing bundle |
| `agentcore dataset download` | Download a dataset version locally |
| `agentcore dataset publish-version` | Publish a new dataset version |
| `agentcore dataset remove-version` | Remove a dataset version |

**Observability & history**

| Command | Description |
| --- | --- |
| `agentcore logs` | Stream/search agent runtime logs |
| `agentcore logs evals` | Stream/search online-eval logs |
| `agentcore traces list` / `agentcore traces get` | List recent traces or download one to JSON |
| `agentcore evals history` | View past on-demand eval results |

**Utilities**

| Command | Description |
| --- | --- |
| `agentcore fetch access` | Fetch access info for deployed gateway or agent |
| `agentcore feedback` | Send feedback (with optional screenshot) to the AgentCore team |
| `agentcore update` | Check for and install CLI updates |
| `agentcore telemetry` | View or change telemetry preferences |
