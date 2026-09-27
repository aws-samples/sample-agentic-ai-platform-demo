# Chat Agent — Foundation Harness Blueprint

> **This is a platform-provided Foundation Harness blueprint.** The platform team
> pre-wired identity, memory, observability, and guardrails. You (the domain team)
> add only your domain content. Read this section before you change anything.

## Foundation Harness vs Domain Harness — what you own

This blueprint follows the hybrid platform pattern: the **platform team owns the
control plane**, the **domain team owns the application plane**.

| Layer | Owner | Where it lives | Change it? |
| --- | --- | --- | --- |
| **Foundation Harness** (identity, memory, observability, guardrails, runtime) | Platform team | `agentcore/agentcore.json` (`runtimes`, `memories`, `policyEngines`), CDK | 🔒 **Do not edit** — locked by the platform |
| **Domain Harness** (persona, skills, domain tools, domain eval) | You (domain team) | `app/chat_agent/` (`instructions.md` + `tools`), and domain skills/tools you add | ✅ **This is your job** |

### What the platform already gave you (do NOT rebuild these)

- **Identity** — AgentCore Identity / IAM execution role, wired at deploy time.
- **Memory** — AgentCore Memory with SEMANTIC + USER_PREFERENCE + SUMMARIZATION +
  EPISODIC strategies, namespaced per user (`/users/{actorId}/...`). See
  `app/chat_agent/memory/session.py`. It is already connected in `main.py`.
- **Observability** — AgentCore Runtime auto-emits CloudWatch metrics + OTEL traces
  per session. A second Langfuse exporter is attached in `telemetry.py` (fail-open;
  reads keys from SSM at `/agentic-platform/langfuse/`). Every span lands on both
  CloudWatch and Langfuse, so the end-user HITL feedback journey is fully observable:
  the session trace carries `session.id` and `user.id`, and thumbs-up / thumbs-down
  + comment feedback sent by the console attaches as a Langfuse score on the same
  trace, enabling per-session quality dashboards without extra instrumentation.
- **Guardrails / policy** — `platform_content_guardrails` Cedar policy engine attached
  in `agentcore.json`; the baseline policy is permissive — extend with domain-specific
  `forbid` rules if needed.
- **Runtime** — managed microVM-isolated sessions via `BedrockAgentCoreApp` in `main.py`.

### What YOU add (the Domain Harness)

1. **Persona** — edit `app/chat_agent/instructions.md`. The concierge persona (orders,
   returns, product Q&A) is pre-populated. Redeploy after editing.
2. **Domain tools** — add `@tool` functions in `main.py` (e.g. `lookup_order`,
   `check_return_eligibility`), or wire a gateway with
   `agentcore add tool --harness chat_agent --type agentcore_gateway`.
3. **Domain skills** — `agentcore add skill --harness chat_agent --git <your-skill-repo>`
   (or `--aws-skills`, or `--path`).
4. **Domain eval** — add golden datasets + an evaluator (`agentcore add evaluator`) for
   customer-support quality metrics (CSAT, first-contact resolution rate).

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
3. **Schema Validation:** If your JSON conforms to the types in `.llm-context/`, it will deploy successfully. Run
   `agentcore validate` to check.
4. **Resource Removal:** Use `agentcore remove` to remove resources. Run `agentcore deploy` after removal to tear down
   deployed infrastructure.

## Directory Structure

```
concierge/
├── AGENTS.md               # This file — AI coding assistant context
├── agentcore/
│   ├── agentcore.json      # Main project config (AgentCoreProjectSpec)
│   ├── aws-targets.json    # Deployment targets (account + region)
│   ├── .env.local          # Secrets — API keys (gitignored)
│   └── cdk/                # AWS CDK project (@aws/agentcore-cdk L3 constructs)
└── app/
    └── chat_agent/         # Strands agent application
        ├── main.py         # Entrypoint — BedrockAgentCoreApp + invoke handler
        ├── instructions.md # EDITABLE persona — edit + redeploy to change behavior
        ├── telemetry.py    # Dual OTEL: CloudWatch + Langfuse (fail-open)
        ├── identity/       # Foundation: resolves user from JWT headers
        ├── memory/         # Foundation: AgentCore Memory session manager
        ├── model/          # Foundation: BedrockModel loader (MODEL_ID env var)
        └── mcp_client/     # Foundation: Streamable HTTP MCP client stub
```

## End-User HITL Feedback Journey

The concierge is designed to demonstrate the Human-in-the-Loop (HITL) feedback loop:

1. **Chat** — user sends a message; the agent responds via streaming HTTP.
2. **Feedback** — the console renders a thumbs-up / thumbs-down widget with an optional
   comment field at the end of each assistant turn.
3. **Score on trace** — feedback is recorded as a Langfuse score on the session's OTEL
   trace (`session.id` matches the AgentCore session id). CloudWatch receives the same
   spans, so operational metrics (latency, error rate) live alongside quality scores.
4. **Observability loop** — product and ML teams query Langfuse for sessions with low
   scores, inspect the full turn-by-turn trace, and identify where the agent went wrong
   without re-running anything.

No extra code is needed to wire this up: `telemetry.py` attaches the Langfuse exporter
at first invocation, and the `trace_attributes` in `main.py` propagate `session.id` and
`user.id` to every span.

## Deployment

```bash
agentcore deploy    # Synthesizes CDK and deploys to AWS
agentcore status    # Shows deployment status
```
