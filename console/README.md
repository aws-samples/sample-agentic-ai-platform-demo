# Self-Service Console (L3)

A dependency-free orchestrator + single-page UI for the domain-team self-service
flow. No framework, no build step, no Cognito/DynamoDB/Lambda/Docker of its own — it
reads the blueprints and shells out to the proven `agentcore`, `aws`, `gh` and `git`
CLIs. The AgentCore CLI is what provisions the managed Foundation Harness (identity,
memory, observability, runtime).

## Run

```bash
node console/server.mjs          # serves UI + API on http://localhost:4000
```

Requires the `@aws/agentcore` CLI on PATH and AWS credentials for **us-west-2**.
`PORT` overrides the port. See the root README for the optional Cognito identity
config and GitHub-export PAT.

## Files

| File | What it is |
| --- | --- |
| `server.mjs` | The whole backend — an ~800-line Node HTTP server, no dependencies. |
| `public/index.html` | The entire SPA (vanilla JS, inline styles). |
| `catalog.json` | The platform-curated registry (models, blueprints, skills, tools, MCP servers, export orgs). |
| `org-guardrails.json` | The authoritative org default guardrail pack. Project overrides may add guardrails but cannot remove this pack. |
| `projects.seed.json` | Checked-in first-run project fixture. If `projects.json` is missing, the server initializes it from this file. |

`console/projects.json` remains runtime state and is gitignored. For tests or
isolated runs, set `CONSOLE_DATA_DIR=/tmp/some-dir`; the project store will be
created there and seeded from `projects.seed.json` if missing.

## Views

- **Overview** — the platform/domain split.
- **Catalog** — the control-plane registry, read-only.
- **Blueprints** — the Foundation Harness templates and what each pre-wires.
- **Build an Agent** — the 3-step wizard (below).
- **Operate** — live deployed AgentCore runtimes; click one for its metadata and a streaming chat.
- **Observability** — real CloudWatch metrics across the four observability layers.

## The 3-step wizard

1. **Choose a Foundation Blueprint** — the locked foundation (identity, memory,
   observability, guardrails, runtime) is platform-owned; the card shows what's wired.
2. **Add the Domain Harness** — name, persona, model, skills, tools, memory, streaming,
   identity. A live preview shows amber (locked foundation) vs blue (your domain harness).
3. **Test & hand off** — `agentcore validate` -> **Deploy to AgentCore** -> streaming
   chat -> **Run eval** as a promotion gate -> **Export to GitHub** as the final handoff.

## API

| Endpoint | Does |
| --- | --- |
| `GET /api/blueprints` | List blueprints + their locked foundation. |
| `GET /api/catalog` | The full platform registry. |
| `GET /api/fleet` | Live deployed AgentCore runtimes (via `aws bedrock-agentcore-control`). |
| `GET /api/metrics` | CloudWatch metrics for the observability view. |
| `POST /api/generate` | Clone a blueprint + apply the Domain Harness form (-> `domain-examples/generated/<name>`). |
| `POST /api/validate` | `agentcore validate` a project. |
| `POST /api/deploy` | `npm install` (first time) then `agentcore deploy -y`. |
| `POST /api/invoke` | `agentcore invoke` a deployed project (optionally with a Cognito bearer token). |
| `POST /api/invoke-stream` | Streaming chat over Server-Sent Events. |
| `POST /api/agent-detail` | One agent's config/metadata (model, memory, auth, domain harness). |
| `POST /api/eval` | `agentcore run eval` — LLM-as-judge over recent traces. |
| `POST /api/export` | Stage a clean copy, git-commit it, and (for a real org) create the GitHub repo via `gh`. |

## Identity

When a project enforces CUSTOM_JWT, the console signs a demo user in to Cognito and
forwards their profile to the agent as custom runtime headers: `user-id` (Cognito
`sub`, scopes memory), `user-name` and `user-email` (so the agent can greet them).
Those header names must be in the runtime's `requestHeaderAllowlist` in
`agentcore.json`, or AgentCore drops them.

## Streaming note

`agentcore invoke --stream` emits the answer token-by-token; each fragment already
carries its own leading spaces. The server forwards fragments verbatim (it does not
trim per line, which would glue words together) and the UI renders the accumulated
text as markdown.
