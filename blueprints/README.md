# Foundation Harness Blueprints

Platform-owned **golden-path templates**. Each blueprint is a real
[`@aws/agentcore`](https://www.npmjs.com/package/@aws/agentcore) project where the
platform team has pre-wired the **Foundation Harness** — identity, memory,
observability, guardrails, and the managed runtime — so domain teams add only their
**Domain Harness** (persona, skills, tools, domain eval).

This is the hybrid platform pattern: platform owns the control plane (what's locked),
domain owns the application plane (what they fill in).

## Catalog

**Recommended default: Strands Agents + AgentCore Runtime**, using `chatagent`
for a conversational agent or `workflowagent` for orchestration. These are
exportable repository templates with actual Python agent code, AgentCore/CDK
configuration and coding-agent instructions. The shared AI Registry publishes
their source and recommendation; domain setup grants access to templates and
models, and project/agent setup selects one template plus an allowed model.

| Blueprint | Use case | Memory | Foundation (locked) | Domain (you add) |
| --- | --- | --- | --- | --- |
| [`chatagent/`](./chatagent) | Conversational / knowledge assistant | long + short term (SEMANTIC, USER_PREFERENCE, SUMMARIZATION, EPISODIC) | identity (Cognito profile forwarded so the agent greets the user by name; `sub` isolates memory), memory, observability, guardrails, runtime | persona, domain skills, domain tools, domain eval |
| [`workflowagent/`](./workflowagent) | Task / process orchestration | short term | identity, observability, guardrails, runtime | workflow logic, domain tools, approvals, domain eval |

Each blueprint's `AGENTS.md` is the contract for the domain team's coding assistant:
it states what is locked (foundation) and what to fill in (domain).

## How a domain team consumes a blueprint

**Path A — UI self-service** (low-code): pick a blueprint in the self-service
console (`console/`), compose the domain layer, deploy, chat, eval, and export to
GitHub — all without leaving the browser.

**Path B — CLI / clone** (for engineering teams that want flexibility):

```bash
# 1. Copy a blueprint as your starting point
cp -r blueprints/chatagent my-support-agent && cd my-support-agent

# 2. Read the contract
cat AGENTS.md

# 3. Rename the project so it deploys as YOUR own stack (not the blueprint's).
#    Edit agentcore/agentcore.json: set "name" and each memories[].name to a
#    unique value (e.g. "mysupport"). Renaming = a new CloudFormation identity.

# 4. Restore the CDK build deps (blueprints ship without node_modules)
( cd agentcore/cdk && npm install )

# 5. Add your domain content (foundation stays locked)
agentcore add tool  --harness chat_agent --type agentcore_gateway --gateway my-crm
agentcore add skill --harness chat_agent --git https://github.com/acme/support-skills
#    ...and edit DEFAULT_SYSTEM_PROMPT in app/chat_agent/main.py

# 6. Verify and run locally
agentcore validate
agentcore dev "hello"

# 7. Deploy to AWS (managed identity/memory/observability come with it)
agentcore deploy -y
```

Both paths produce the **same artifact** — a golden-path AgentCore project. This is
also what the L4 platform-as-agent generates on the fly in Demo 2 when no pre-built
blueprint fits.

## Regenerating a blueprint from scratch

Blueprints were scaffolded with the AgentCore CLI. To recreate `chatagent`:

```bash
agentcore create --name chat_agent --project-name chatagent \
  --framework Strands --model-provider Bedrock \
  --memory longAndShortTerm --protocol HTTP --defaults --build CodeZip --language Python
```

Then customize `AGENTS.md` with the Foundation/Domain contract and lock the
`runtimes` / `memories` / `policyEngines` sections in `agentcore/agentcore.json`.

> Generated dirs (`.venv`, `node_modules`, `.cli/`, `.env.local`) are gitignored.
> Run `agentcore` in a blueprint dir to have the CLI reinstall them.
