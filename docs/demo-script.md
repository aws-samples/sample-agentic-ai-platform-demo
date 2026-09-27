# Demo Script: Enterprise Agentic AI Platform Console

Per-page talk tracks for a live demo. Every page in the console opens with a
**story strip** — *who am I / what do I own / where next* — so each section
below starts from that line and builds the beat on top of it. Total time:
20 to 30 minutes. Audience: enterprise platform, application, and governance
leaders.

## Before you start

1. `node console/server.mjs` and open http://localhost:4000.
2. Make sure `.demo-secrets/cognito.env` exists (demo users alice/bob/melanie)
   so chat works against auth-protected agents.
3. The `supportdesk` agent should be deployed and READY in the Operate view. It is
   the agent you will chat with and, if you want, approve live.
4. In Governance, leave `supportdesk` in DRAFT before the demo. Approving it live
   is the best moment of the End User segment.

## Running order

| # | Page (persona) | Beat | Time |
| --- | --- | --- | --- |
| 1 | Login (any) | SSO showcase, identity is a server session | 1 min |
| 2 | Overview (Admin) | Maturity framing + golden path + journeys animations | 4 min |
| 3 | Governance (Admin) | Seven sub-modules, the gates | 3 min |
| 4 | AI Registry (Admin) | Versioned lifecycle, MCP approval, skill pipeline, ML lineage | 3 min |
| 5 | Operate (Admin) | Live fleet, health, drill-down | 2 min |
| 6 | Cost (Admin) | Real ledger, budgets, honesty points | 2 min |
| 7 | Domains (Admin) | Vend a domain live — the L3 scale proof | 2 min |
| 8 | Integrations (Admin) | Five neighbours, derived numbers | 2 min |
| 9 | Memory (Admin) | Access inversion setup | 1 min |
| 10 | Observability (Admin) | Aggregates only, alerts SEV1 live | 3 min |
| 11 | Blueprints → Build an Agent (Builder) | Three doors, one gate; blueprint door: compose, deploy, eval, export | 6 min |
| 12 | Build → Design with Plato (Builder) | Spec-first: chat → contract → red-TDD repo → assistant builds it | 3 min |
| 13 | Build → Start from scratch (Builder) | The gate pack: nine files, nothing but the gate | 1 min |
| 14 | Observability → Traces (Builder + Lead) | Access-request workflow, PII reveal + audit | 3 min |
| 15 | Agents (End User) | Approval made this agent exist | 2 min |
| 16 | Overview (wrap) | L3 proven, L4 pointer | 1 min |

---

## Login — every identity is a server session

*One-liner:* three IdP tiles, one directory, zero client-side identity.

The Okta / Entra ID / Cognito tiles are an interchangeability showcase — all
three land on the same demo directory. Pick a user and the server issues a
real session token; from then on every API call derives user, role and domain
from that session — never from the client. Say it plainly: there is no
persona dropdown in this console; switching persona means re-authenticating
as a different person (two clicks: Switch user → account). Even the End User
tile issues a session silently — end users have identity too. The agents
behind the console use real Cognito identity. This demo marks every
illustrative element with a visible `illustrative` chip; what is not marked
is real.

## Overview — the whole platform in one screen

*Story strip:* Admin owns "the paved road"; Builder owns "your domain
harness"; End User owns "your conversations". Point at the strip — every
page has one, answering *who am I, what do I own, where next*.

Open on **Overview** as any persona. The framing is the platform maturity
journey (the ladder card):

- L1: individual experiments. L2: first production agents, hand-built.
- **L3: Scaling. This demo. "You are here."** Self-service on a paved road: a
  central control plane (catalog, governance, observability, evaluation,
  identity, guardrails) and a federated application plane where domain teams
  compose agents from approved parts.
- L4: the platform itself becomes an agent — AI-assisted onboarding, auto-tuned
  evaluation, and continuous self-optimization on top of this L3 topology. That
  platform-as-agent vision is the north star pointer. This console does not claim
  L4; it points at it.

Key vocabulary for the audience: **Foundation Harness** (what the platform
pre-wires: identity, memory, observability, guardrails, runtime) vs **Domain
Harness** (what the team owns: persona, skills, tools, evals).

### Animation cue 1 — the golden path (60 seconds, over the animation)

The animated serpentine at the top of Overview is the whole demo in one
diagram — narrate it while the pulse makes one lap (~14s per lap, so you get
four laps in a minute):

> "This is the paved road, end to end. You **sign in** through your company
> IdP — role and domain come from the directory. You pick an approved,
> versioned **blueprint** — framework and hosting are choices, not projects.
> You **compose** only what's yours: a persona plus approved skills and tools —
> identity, memory, observability and guardrails are already wired. A
> golden-dataset **eval** gates promotion — evidence, not vibes. **Governance
> approves** — one queue, full audit trail. One click **deploys** to a managed
> runtime and the agent registers itself back. Your team **operates** it on a
> single pane of glass, **observes** it with role-scoped access — builders see
> their traces, the platform team sees aggregates, never payloads — and online
> eval keeps scoring production traffic so the loop **improves** the next
> version. Nine steps, one platform, no team ever re-solves the plumbing."

Click any stage: the panel splits that step into **platform provides** vs
**domain team owns** — the federated split made concrete — and the "Open →"
button jumps to the live view, so any stage can become a segue into its
segment. Stage ring colors carry the same split: purple = platform-provided,
green = domain-owned, blue = shared.

### Animation cue 2 — customer journeys (30 seconds, below the golden path)

The golden path is the *platform's* story; the journeys card below it is the
*people's* story — the same platform, four seats. Each tab is an animated
stepper mirroring the exact click-path of its demo segment (the glowing dot
walks the steps on a loop; click any step for the one-line story and an
"Open →" jump into the live view — links only appear for views the signed-in
persona can actually enter):

> "Four people, one platform. The **admin** governs — queue, registry,
> domains, cost. The **builder** composes and ships. The **domain lead**
> approves for their own domain — requester and approver can never be the
> same person. And the **end user** just picks an approved agent and chats."

Open the **End User** tab and land on the trace-flow diagram: one invocation
riding end-user → agent → tools / memory → response, with the pulse tracing
the hop. That is the Foundation Harness pitch in one picture — say it out
loud: "the domain team wrote none of this plumbing." Signed in as an End
User, Overview shows only their own journey plus this diagram — the other
seats' click-paths reference views this persona cannot enter.

---

## Governance (Admin) — every gate in one place

*Story strip:* you own "every gate: approvals, policies, guardrails, RBAC,
audit" — next stop Operate, to see what those gates let through.

The heart of the control plane, organised as seven sub-modules (rules and
approvals only — what's-running stays in Operate). Walk the tabs left to right:

- **Approval queue.** Every pending decision across every governed type in
  one queue: registry versions submitted for review and tool calls paused
  by an approval policy. Below it, the governed resources: every deployed
  agent auto-registers as DRAFT; the MCP and A2A rows read straight from
  the unified AI Registry — one store, one lifecycle, decided in this
  queue. The workflow logic is real and persisted server-side; the backing
  store is a JSON file standing in for a registry service. What approval
  gates: the Build wizard only offers APPROVED integrations, and End Users
  only see APPROVED agents. You will prove both later.
- **Approval policies.** Who and what needs human approval: policies match
  tool patterns (glob) per agent scope. Fire the demo interrupt here — an
  agent hits a gated tool, the request parks in the Approval queue, the
  admin approves or denies. The interrupt event is illustrative (marked);
  the policy store and per-agent audit trail are real records you can query.
- **Guardrail policy.** Which guardrail profile is mandated per blueprint
  class. The punchline: policy is *authored* here, *enforced* in the
  Foundation Harness on every agent's I/O path — the same
  policy-vs-enforcement split as RBAC.
- **Alerts & RACI.** Every alert is metric + threshold + severity + owner
  + runbook — a governed policy record, not a console knob. The RACI table
  below maps each alert class to who acts (Domain Builder is first
  responder for their own agents, Platform Admin is the accountable
  escalation point, End Users are informed through agent status only —
  never paged). Say the split out loud: definitions live *here*; the live
  incident feed fires under **Observability → Alerts** — the same
  authored-vs-runtime split as guardrails.
- **RBAC.** The role policy table behind every server-side check. Every
  row is enforced from the session — a builder token against a decide
  endpoint gets 403, no matter what the UI shows.
- **Audit trail.** Every interrupted tool call *and* registry decision,
  queryable per agent and status. Note the segregation split (PII protection
  follows the data, not the view): the admin sees every record's approval
  *metadata* — policy, status, who decided, when — platform-wide, but the
  tool-call *input summary* is PII-masked for platform sessions, because
  tool args can carry customer emails, order numbers or ticket text. Domain
  builders and leads see their own domain's summaries raw. Same rule on the
  SIEM export.
- **Compliance.** Is the platform governable at a glance: lifecycle counts
  per registry type, guardrail wiring across the deployed fleet, oldest
  unreviewed submission. Derived live from the registry — no separate
  compliance store.

## AI Registry (Admin) — one store, versioned, gated

*Story strip:* you own "every version of every governed type — approve one
and it reaches wizards and End Users"; the Next link jumps to Governance
where the decisions happen.

One typed, versioned registry for Agents, Skills, MCP servers, A2A agents,
Models and Blueprints — the *only* store; the old per-type registries are
gone. Three live beats worth doing:

- **MCP server approval.** Propose a new MCP server (any https URL),
  submit for review — auto-checks run synchronously (https scheme,
  transport declared, duplicate URL, reachability) — then flip to
  Governance and approve it from the queue. Now open the Build wizard:
  it's offered. That's the whole gate, demonstrated end to end.
- **Skill promotion pipeline: propose → rejected → resubmit.** Open a
  Skill, propose a new version whose content hides a fake API key —
  the secret-scan auto-check bounces it back to DRAFT before any human
  sees it. Fix the content, resubmit, approve from the queue; the
  default-version pointer advances and the wizard offers the new semver.
  The point: bad submissions cost zero reviewer time, and every version
  is immutable with a changelog.
- **ML Platform model lineage (WS-E).** Filter to Models and open
  **Support Triage FT 8B** — a fine-tuned model registered from the ML
  Platform. The drawer shows the full provenance chain: SageMaker
  training job → dataset → eval report → Bedrock custom-model import →
  this registry entry → the agents that run it. Every model entry also
  carries a **Used by** list derived from each project's *effective*
  model (the same resolution the Cost page uses), so registry and cost
  never disagree. The point: the AI platform and the ML platform meet in
  one registry — a data scientist ships a fine-tune, and agent builders
  discover it with its provenance attached. (The fine-tuned model itself
  is illustrative — no such training job exists in the account; the
  registry entry, lineage rendering and consumer derivation are live.)

Tool discovery and Agent Cards are illustrative (marked); the versioned
workflow is real.

## Operate (Admin) — the running fleet

*Story strip:* you own "the running fleet — health, approval state, versions
across all domains"; Next drills into Observability.

Live AgentCore runtimes in us-west-2, real. Each card shows the
approval badge, a cost badge, a health badge (healthy/degraded, derived from
the same error-rate metric Observability computes for that agent), and
version/last-deploy columns (real, pinned at deploy time). Click **View
observability →** on any row to drill straight into that agent's scope on
the Observability tab — closes the Operate→Observability gap live. As a
builder the same page is scoped to your domain; as an End User it renders as
**Agents** — same view code, three stories.

## Cost (Admin) — the bill, reconciled

*Story strip:* you own "the platform bill — every domain's burn against its
vended budget"; Next goes to Domains where budgets are set.

Per-agent token and dollar breakdown fed by real invocations, a
**per-model breakdown** table (same ledger, grouped by model instead of
agent — useful for "which model is driving spend"), a **per-agent cost
trend sparkline** (reused straight from the Observability stat-card
component, real daily buckets from the ledger), and the model rate card.
Three honesty points, say them out loud:

- Token counts fall back to a 4-characters-per-token heuristic, because the
  Bedrock CountTokens API rejects the `global.*` inference profiles this demo
  deploys with (ValidationException, verified 2026-07-23). The UI labels
  these as estimates.
- Pricing is demo metadata entered by the platform team in the catalog, not
  billing data from a pricing API.
- **Domain cost buckets** at the top: each domain's token burn rolls up from
  the same per-agent ledger rows below (the numbers reconcile by
  construction), compared against the token budget set when the domain was
  vended. At 80% the bucket flags a warning; over 100% it alerts — point at
  the budget bar.

## Domains (Admin) — the L3 scale proof

*Story strip:* you own "the domain roster — vend a namespace and a team is
self-serve in minutes"; Next watches their budget in Cost.

Vend a new domain live: name, owner, IdP group mapping, token budget → one
form, and the platform hands the new team a scoped AI Registry, the Build
wizard, a golden-set eval pipeline, an observability scope and a cost bucket
with budget alerts — plus a builder and Domain Lead sign-in. Then prove it:
Switch user → the new "… Builder" tile is on the login page → their console
is scoped to the new domain (foreign agents 404, own scope live). Say the
punchline: domain #30 costs the platform exactly what #2 did — a data row,
zero code. That is what self-service scale means.

### Domain drill-down — click a card

The roster cards are clickable. Click **Customer Support**: one page shows
the domain's whole operational slice — owner (Carol Diaz) and owning team,
the agents with the same status / approval / health / version data Operate
renders, the domain's **memory stores with governance metadata** (PII
classification badge, retention, counts), and the **token budget/usage bar**
fed by the same ledger as Cost. Each agent row has a "View observability →"
link-out that lands on Observability pre-scoped to that agent — the same
scope lock Operate uses. Note the **Platform** domain on the roster: the
platform team's own domain, owning the platform-assistant agent — the
platform manages its agents on the same paved road the domain teams use
(the Operate and Registry tables carry an **Owner team** column making the
platform-team vs domain-team split explicit).

**RBAC on the drill-down.** As a builder, the Domains page becomes
"My Domain": your own card opens; every other domain is a name-and-owner
directory entry, and opening one lands on an access-denied state that names
the owning team and the IdP group to ask — resources never leak, the
org-chart does. Alice's and Bob's consoles are visibly different end to
end: domain name in the header, different agents, different memory, different
budgets.

## Integrations (Admin) — a node, not an island (deck slide 9)

*Story strip:* you own "the enterprise contracts — one named neighbour per
tile, every number live-derived".

Five neighbours, one tile each, and every number on a tile is derived live
from the same store as the page it links to — invite the audience to check.
**Security team**: guardrail policy is authored in Governance and enforced in
every Foundation Harness (the tile counts wired blueprint classes from the
same catalog the Governance tab reads); click "Export audit stream" and a
JSON file of every governance decision plus every content-access reveal
downloads — the stream a SIEM collector would pull. **Data & ML team**: the
fine-tuned model from the ML platform with its lineage and consuming-agent
count; the deep link lands on the registry filtered to Models. **Delivery
toolchain**: the GitHub-export graduation path with the org roster from the
catalog. **Observability export**: CloudWatch namespace, Langfuse host,
alert-policy count. **Identity provider**: Okta / Entra / Cognito with live
session and directory counts — "Open the sign-in showcase" drops you onto
the real login page (it signs you out: identity is a server session, there
is no preview mode). Punchline: integration isn't a logo wall — each tile is
a contract with a named team, and the demo can prove every number on it.

## Memory (Admin) — metadata here, content in the domain plane

*Story strip:* you own "resource metadata and access-grant audit — record
content stays in the domain plane"; Next shows the grant metadata table in
Observability.

Real AgentCore Memory resources listed from the account, with
their strategies (semantic, summary, user preference, episodic — each shown
with its extraction namespace inline), **attached-agents chips** (which
deployed agents reference each memory, resolved from the same project scan
Operate uses), and **event/record counts** per resource. Say the honest
caveat: AgentCore Memory's list APIs only enumerate events/records for a
known actor+session or namespace — there is no cheap "count everything on
this resource" call, so the counts are simulated and chipped; everything
else on this card (strategies, attached agents) is real.

**Memory is domain data (F2 governance).** Every store on this page is now
attributed to a **domain + agent** and carries a visible **PII badge**,
retention window and counts — that's the governance metadata layer, and it
is ALL the platform admin sees by default. Say Melanie's line: *memory is
data; the platform admin must not see all memory content.* Builders see
only their own domain's stores (Bob never sees a Customer Support store,
and vice versa).

**Record content follows the ownership plane.** The access story in one
line: **own-plane content by default (masked), cross-plane only via grant +
audit.** Extraction previews can retain PII (an email, a phone number) long
after the source trace is deleted, so record *content* lives with the plane
that OWNS the store. Platform-domain stores (the platform team's own
agents) open for the admin directly — masked, reveals audited — because the
platform team owns that data plane. A domain team's store stays
metadata-only: the server 403s its content routes for a platform session.
If the admin genuinely needs domain content, click **"Request content
access"** on the store: the request routes to the **owning domain's lead**
(justification + duration), the lead approves, the grant is **time-boxed**
(expiry checked per request) and every step — request, approval, reveal,
revoke, expiry — lands in the audit trail. It's the same access-request
machinery Traces use, extended to memory. Show the content flow as the
Domain Builder too (their Memory page has "recent extractions": masked by
default with the same full-span placeholders as Traces, reveal audited
under `kind: memory`). The create form is simulated (marked).

## Observability (Admin) — aggregates, plus your own plane's traces

*Story strip:* you own "the aggregate signals plus your own Platform
agents' traces — domain-team content only via grant + audit"; Next follows
the spend into Cost.

**Platform traces tab (ownership plane).** The admin's Observability now
has a Platform traces tab: the agents the platform team itself owns and
operates (the Platform domain — `platform-assistant`). Open by default,
masked with the same full-span placeholders, reveals audited — the platform
team reads its OWN data plane exactly the way a domain team reads theirs.
Domain-team agents never appear in this tab; their content still answers
403 to a platform session.

Real CloudWatch metrics grouped under four plain-language headers —
**Service health**, **Model performance**, **Agent reasoning**, **Cost &
usage** — instead of the old L1–L4 chart labels; same underlying series,
honest renaming so a non-platform stakeholder doesn't need the
maturity-model vocabulary to read the chart. Langfuse traces too.

Logs definition (segregation audit P1-3): in this platform "logs" are
trace-derived — there is no independent log endpoint or log stream in the
console. Anything log-like (execution steps, tool calls, errors) surfaces
through the trace views and is therefore covered by the trace controls:
domain-plane-only content, always-on masking, access-request + time-boxed
grant + audit. If a separate log stream is ever added, it must adopt the
same controls before shipping.

- **Online evaluation.** Below the charts: production sampled scoring. The
  sample denominators come from the real usage ledger — the same source the
  Cost page derives from — so samples never exceed invocations and the
  numbers reconcile across pages. Judge scores are illustrative (marked).
  The platform view shows only the aggregate quality score; the per-day
  trend detail lives in each domain team's builder view — say it out loud:
  quality *detail* is domain-owned, the platform sees the rollup.
  Build-time quality (golden-set gate) lives on each agent's detail page as
  promotion evidence.
- **Alerts tab — fire a SEV1 live.** The catalog is read from the
  Governance-owned policy store; the trigger stands in for a CloudWatch
  alarm crossing its threshold (say that honestly), but everything
  downstream is real state: fire the guardrail block-rate anomaly on
  `supportdesk`, flip to Operate — the card shows **suspended** (SEV1
  auto-suspends pending review, the HITL-gated pattern applied at the alert
  layer). The End User's agent list shows the same status: informed, never
  paged. Resolve it, watch the card recover, then show the fired /
  auto-suspended / resolved entries in the Governance audit trail.

## Blueprints (Builder) — the choice, not the plumbing

*Story strip (builder):* you own "the choice, not the plumbing — pick a
template, the harness comes pre-wired"; Next is Build an Agent. (As admin
the same page reads "the paved-road templates — versioned registry entries
every agent pins" and links to the Registry.)

Switch to **Domain Builder** (note the nav change: build tools appear,
governance disappears). Foundation Harness templates. `chatagent` and
`workflowagent` deploy for real; the other cards are concept-level (marked).
The catalog spans five frameworks (Strands, Claude Agent SDK, LangGraph,
OpenAI Agents SDK, Google ADK) and four hosting targets (AgentCore Runtime,
Lambda, ECS Fargate, EKS) — point at the ADK-on-EKS card: bring your
framework AND your compute, the foundation contract stays the same. Every
card carries a version chip: blueprints are versioned AI Registry entries,
and each agent pins the blueprint version it was composed from. Bump a
blueprint and existing agents keep running on their pinned version with an
"upgrade available" badge in Operate — never a forced rebuild (same §4.1.1
pin mechanism as MCP/A2A).

## Build an Agent (Builder) — three doors, one gate

*Story strip:* you own "the domain harness — persona, model, skills, tools;
identity to guardrails come wired"; Next operates it after deploy.

The Build tab opens on **three doors** — Start from Blueprint (FULL), Design
with Plato (SPEC), Start from scratch (MINIMAL). Say the frame before
clicking anything:

> "Three ways in, one gate out. The doors differ only in how much the
> platform prescribes — the CI/CD + eval gate every exported repo carries is
> identical. The platform's product is the gate, not the code."

Then take the **blueprint door** (the full wizard):

1. **Step 1.** Pick `chatagent`.
2. **Step 2, compose the Domain Harness.** Name, persona prompt, an approved
   model with parameter controls (temperature, max tokens), skills from the
   platform library, tools, APPROVED MCP servers only (the governance gate,
   live), and built-in tools (code interpreter, browser) at concept level
   (marked). Framework × hosting is a compatibility matrix, not a
   free-for-all: switch the framework to Claude Agent SDK and Lambda greys
   out with the reason — the same rule is enforced server-side on generate
   and by the registry auto-check on any proposed blueprint version. One
   model quirk if asked: Claude Sonnet 5 and Opus 4.8 reject `temperature`
   on Bedrock, so the catalog marks them and the generator omits the
   parameter.
3. **Step 3.** Validate (real agentcore CLI), Deploy (real CDK deploy to
   AgentCore, a few minutes; for a live demo prefer the already-deployed
   `supportdesk`), then chat. Chat is real streaming, and the agent greets the
   signed-in Cognito user by name; switch users to show memory isolation.
4. **Eval as the promotion gate.** Run the golden dataset: real invocations of
   the deployed agent, scored by an LLM-as-judge. Saved runs are comparable, so
   a model or prompt change gets re-scored against the same dataset. Governance
   note if asked: golden scenarios are treated as *domain content* — in a real
   enterprise they're sampled from actual tickets and conversations — so the
   platform admin sees scenario text PII-masked (with a visible chip), and raw
   text requires the same domain-owner-approved, time-boxed, audited grant as
   trace and memory content. The domain's own builders and lead always see
   their dataset raw.
5. **GitHub delivery.** The handoff artifact: a real private repo created after
   the Domain Builder approves the immutable preview and authorizes GitHub in
   the browser. Before delivery, point at the **"What the exported
   repo carries"** preview: the file list is computed server-side from the
   real export manifest, and the gate files — `eval.yml`, `tests.yml`,
   `compliance.yml`, the runner scripts, the golden dataset, the gate-rules
   README — are grouped as one unit. Say the proof line: "these gates really
   ran — on real GitHub PRs, a Bedrock judge blocked the dishonest transcript
   at 71% and passed the honest one at 100%; the PR links are in the evidence
   ledger" (`docs/gates-setup.md`).
6. **Operate, integration panel.** For a deployed agent, the external
   integration panel shows the real invocation URL, the auth requirements, and
   a copy-ready boto3 snippet: how the rest of the enterprise calls this agent.

Talk track close: "The domain team never touched identity, memory, guardrails,
or observability. They composed, deployed, proved quality, and handed off."

## Design with Plato (Builder) — the spec-first door

*One-liner:* "Answer Plato's questions, hit Generate — the conversation
becomes a contract, and the contract becomes a repo whose red tests are the
acceptance bar."

Back out to **All journeys** and open **Design with Plato**. Beats, in order:

1. **The chat is real.** Plato is the platform's advisor persona running on
   Bedrock, under YOUR login — the server-side session (name, role, domain)
   is in the system prompt; there is no client-supplied identity. First
   response is always discovery questions, never architecture — advisor, not
   implementer. Answer two or three (a live conversation takes ~30s per
   turn; have one pre-run if time is tight).
2. **Generate the contract.** The LLM only *extracts* the inception profile;
   everything after that is deterministic — say it out loud: "the same
   conversation produces byte-identical spec files; the model can't smuggle
   anything into the contract." The panel shows the scored profile
   (complexity + risk, each factor with its why), four reasoned
   recommendations (framework, hosting, guardrail profile, risk class), and
   collapsible previews of the real composer output: CLAUDE.md (three zones:
   🔒 Foundation / ✅ Composed / 🔨 BUILD THIS with interface contract +
   acceptance criteria), SPEC.md, and the TDD skeleton — tests that say
   DELIBERATELY RED right in the file.
3. **Export and the before/after.** The SPEC repo ships NO app code — the
   red tests ARE the acceptance criteria. Then tell the proven story (PR
   links in `docs/gates-setup.md`, repo `apd-journey-spec`): "we exported
   exactly this contract to a real repo — the eval gate judged transcripts on
   real PRs while the tests gate honestly stayed red. Then a headless AI
   coding assistant read the contract, implemented the agent until all four
   acceptance tests passed, and the same gate that blocked the empty spec let
   the built agent merge. The `spec-only` tag vs `main` compare is exactly
   the assistant's diff."

Talk track close: "Spec-first isn't a document convention — it's an
executable contract, and the gate is how an AI-built agent earns the merge."

## Start from scratch (Builder) — nothing but the gate

*One-liner:* "Type a name, get nine files that are nothing but the gate."

Back out and open **Start from scratch**. Type an agent name and the file
list previews live: three CI workflows, the runner scripts, a baseline
golden dataset (three org smoke scenarios — scope, honesty, injection — that
the team replaces), and a one-page README of the gate rules. Domain comes
from your session; the gates are not optional — say why: "the org baseline
is the point; a gate picker would be fake choice." Proof line: this exact
nine-file pack ran on real PRs too — dishonest transcript blocked at 75%,
honest one green at 100% (`docs/gates-setup.md`).

Talk track close for all three doors: "Whichever door a team walks through —
full blueprint, spec contract, or bring-your-own — they exit through the
same gate. That's what the platform actually sells."

## Observability → Traces (Builder + Domain Lead) — PII reveal + audit, live

*Story strip (builder):* you own "your agents' metrics and content traces —
request access, your Domain Lead decides". *(Lead):* "your domain's metrics,
traces and the access decisions — you approve, you never self-approve".

Switch to Domain Builder → Observability → Traces to show the full loop:
a builder's traces are locked behind a **human approval workflow** — the
builder files a request with a justification and a time-box (4h/1h
presets), the same-domain **Domain Lead** approves it from their "Access
requests" tab (the server rejects self-approval — requester and approver
must be different people), and the grant expires automatically, checked on
every request. Once unlocked, traces are still masked by default (full-span
placeholders, demo-grade pattern masking — say explicitly this is *not* a
production PII detector; in production this regex pass maps to CloudWatch
Logs data protection policies / Amazon Comprehend PII detection), Reveal on
one trace, and the "Recently revealed" audit list updates live. This is the
same reveal/audit mechanism as the Memory extractions in the builder's
Memory page — one control, two content surfaces.

Then switch to **carol (Domain Lead)** and open the same tab: hers is
**open by default** — no request form, chip reads "own plane · default
access". Say the ownership rule: the lead IS the approver for this domain's
content, so routing her through her own queue would be a self-approval
loop; she reads her own plane by default (still masked, reveals still
audited). Builders keep the request path even in-domain — approval means a
*second* person. And note the cross-plane inversion still holds: try a
domain agent's routes as the admin and the server answers 403 — the
platform team reads only its OWN plane (the Platform traces tab) by
default; for domain content its Observability page shows the **grant
metadata table** (who/what/why/how long/who decided) — never the content.
Bonus story: bob in Operations has no Domain Lead, so his request stays
pending forever — the governance gap the deck's lead-redundancy suggestion
addresses.

Admin talk track close: "One pane of glass. The platform team approves what
exists, watches what it costs, and keeps a human in the loop where policy
demands it."

## Agents (End User) — approval made this agent exist

*Story strip:* you own "your conversations — every agent here passed the
approval gate".

This is the payoff of governance. Do it in two steps:

1. As **Platform Admin**, go to Governance and approve `supportdesk` live.
2. Switch to **End User**. The nav collapses to Overview and **Agents**. The
   Agents list contains exactly the APPROVED agents, nothing in DRAFT, no build
   or admin surfaces anywhere. Open `supportdesk` and chat for real: streaming
   answer, greeted by name.

Talk track close: "Visibility filtering is not a slide. Approval in the control
plane is what made this agent exist for this user."

## Wrap (1 minute)

Back to **Overview**. Recap the L3 claims just proven: paved-road self-service
(blueprints and wizard), control plane governance (DRAFT to APPROVED, gating),
FinOps visibility (cost), human control (HITL), federated personas. Then the
pointer: L4 is the platform as an active participant — an agentic platform that
onboards and optimizes on its own. That is the north star, not a claim this console makes.

## Real vs simulated, one table for Q&A

| Capability | Status |
| --- | --- |
| AgentCore deploy, streaming chat, Cognito identity | Real |
| Operate list/detail/delete, health badge, version/last-deploy, drill-down to Observability | Real |
| CloudWatch + Langfuse observability (plain-language groups) | Real |
| Golden-dataset eval, LLM-as-judge scoring | Real |
| Online-eval sample counts (from the usage ledger) | Real |
| Online-eval judge scores | Simulated (marked) |
| GitHub delivery (fresh browser authorization per repository) | Real |
| Plato inception chat (Bedrock, server-side session identity) | Real (e2e replays a recorded fixture; provenance noted in `console/plato-fixture.json`) |
| Inception → contract generation (profile scoring, recommendations, CLAUDE.md/SPEC.md/TDD skeleton) | Real and deterministic (LLM extracts the profile only; same inception → byte-identical files) |
| Exported repos' CI gates (eval threshold, tests, compliance + secret scan) | Real GitHub Actions runs with real verdicts — evidence ledger with PR links in `docs/gates-setup.md` |
| Eval-gate judge scoring in CI | Real Bedrock judge via GitHub OIDC (no stored secrets); degrades to deterministic assertion-only without creds and says so on the scorecard |
| Journey B assistant build (spec repo → green tests → merge) | Real headless Claude Code run — log + evidence JSON in `.export-staging/`, `spec-only` tag vs `main` on the test repo |
| Memory resource listing, strategies, attached-agents chips | Real (create form simulated, marked) |
| Memory event/record counts | Simulated — no cheap real aggregate-count API for unscoped actors/namespaces (marked) |
| Memory extraction preview + masking + reveal/audit | Simulated content, real reveal/audit workflow (same store as trace reveals, marked) |
| Trace masking + reveal/audit | Demo-grade pattern masking (simulated), real reveal/audit workflow (marked) |
| Governance workflow logic and persistence | Real (store is a JSON file, marked) |
| HITL policies and audit trail | Real (interrupt event simulated, marked) |
| Cost per-agent + per-model breakdown, cost trend sparkline | Real (same usage ledger) |
| Cost budget bar (domain buckets vs vended token budget) | Real rollup from the usage ledger (budget is platform-entered metadata) |
| Alert policies + RACI, audit entries, Operate card flip / SEV1 auto-suspend | Real (policy store is a JSON file; firing trigger is a demo control standing in for a CloudWatch alarm, marked) |
| Token counting | Heuristic estimate (CountTokens rejects `global.*` profiles) |
| Pricing | Demo metadata, not billing data |
| Console login (SSO picker) | Mock SSO — real server-side sessions, demo user directory (docs-only disclosure; login page says "demo directory") |
| MCP tool discovery, A2A card fetch | Simulated (marked) |
| Built-in tools (code interpreter, browser) | Concept-level (marked) |

Every simulated element carries a visible `illustrative` chip in the UI (the
rendered UI never says "mock" or "simulated" — this table is the honest
inventory). If it has no chip, it is real.
