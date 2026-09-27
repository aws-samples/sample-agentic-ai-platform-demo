# Speaker Notes — L3 Builder Journey Demo (Final Cut, Take 1.6)

> **Version: v1.2** (2026-08-07) — changelog: v1 initial · v1.1 guardrails count fixed to "6 protected files, 3 controls" (SN-001, was a fabricated "25 files") · v1.2 eval unit fixed to "8/8 scoreable units across 3 scenarios" (SN-002, was mislabeled "8 scenarios"). Fact-checked by didi against frames, git history, and live repo runs.

Video: `/tmp/journey-recording-final.mp4` · 8:11 (491s) · 1600x1000 · recorded 2026-08-06/07 · everything shown is real.
Presenter: Melanie. All timestamps below were verified frame-by-frame against the final cut.

---

## 1. Elevator summary

This video shows one builder persona (Alice Chen, Domain Builder, Customer Support) going end to end on the Agentic AI Platform: she picks the Chat Assistant blueprint in the console wizard, deploys it for real to Amazon Bedrock AgentCore and chats with the live agent, exports a governed repo to GitHub, extends it locally with Claude Code under the repo's own guardrails, passes the three local quality gates, opens a PR, and then watches the platform's CI floor catch a genuinely breaking commit live and go back to green after the fix. Every pixel is a real recording: real console, real AWS deploy, real GitHub pages, real CI runs with verifiable run ids. The one-sentence story: **governance is compiled into the repo from day 0, and quality confidence climbs a ladder with evidence at every rung** (local gates → CI floor → PR scorecard → merge box).

---

## 2. Verified timestamp table

| Time (mm:ss) | Segment | What's on screen | Talking point |
| --- | --- | --- | --- |
| 0:00–0:05 | Intro card | "L3 Builder Journey — prebuilt blueprint, end to end" · take 1.6 · "everything shown is real" | Set the honesty bar up front: nothing staged, nothing simulated. |
| 0:05–0:12 | A2 framing card | "Stage 1–2 · Deploy & test on the platform (before export)" + separate-session disclosure | This first segment is a separate wizard session from the export session; same platform, same blueprint. |
| 0:12–1:47 | **Segment A2** — wizard, deploy, live chat | Sign-in (0:13) → wizard doors (0:20, with session banner) → compose from catalog, project `apd-rec-20260807` (0:30) → Validate + "Deploy to AgentCore" (0:42) → time-lapse banner (0:52–1:03) → live chat with the deployed agent (1:05–1:40) → "…then export to GitHub (shown next)" (1:45) | The wizard doesn't stop at generate: it deploys a real runtime to AgentCore and lets the builder test before exporting. Real deploy took 4m41s, shown as a labeled time-lapse. |
| 1:47–1:51 | Card A | "Stage 1–2 · Intake → Blueprint → Export" | Now the original export session. |
| 1:51–2:57 | **Segment A** — intake to export | Sign-in (1:53) → three doors (2:10) → compose from catalog, project `apd-rec-20260806` (2:30) → export handoff, 47-file manifest incl. CI gate files (2:48) → real GitHub export to `melanie531/apd-rec-20260806` (2:55) | The exported repo carries the harness and the CI gates on day 0. Export creates and pushes a real repo. |
| 2:57–3:02 | Card B | "Step 2 — Builder self-check (inner loop, local)" | Two runs of the same gates are the design, not duplication. |
| 3:02–4:28 | **Segment B** — local build with Claude Code | Terminal: clone + README/CLAUDE.md (3:04–3:20) → nested Claude Code implements the order-status tool → 3 "what the builder changed" cards: commit stat, full tool diff, TDD tests (3:35–4:05) → local gates run (4:10) → summary card: 7 passed · PASS · 100% (4:26) | The builder's change loop: edit, gates, green, PR. Local gates are the same definitions CI will enforce. |
| 4:28–4:33 | Card C | "Step 3 — Platform enforcement (CI floor: same gates re-run, cannot be bypassed)" | Local runs are advisory; CI is the floor. |
| 4:33–8:03 | **Segment C** — CI red → green, live | Break pushed live: one-line diff drops a trailing period (4:45) → commit + push, waiting for CI triggers "0 of 3 … 3 of 3" (5:10–5:30) → `gh run watch` to failure, real pytest log (5:30–5:43) → **GitHub web insert (5:44–6:29)**: PR #1 with scorecard + merge box (5:46), red run 31131716134 (6:10), green run 31131827030 (6:27) → back to terminal, failure log context (6:31) → revert commit pushed (6:50) → `gh run watch` to success (7:10) → all 3 workflows green + eval scorecard PR comment refreshed (7:50–8:01) | CI catches the break within a minute of push, the PR is unmergeable while red, and the fix restores green on camera. Run ids are on screen and publicly checkable. |
| 8:03–8:11 | Card D | "CD non-prod + promotion chain — in progress. Batch 1/2 (Track 3: B1-01..B2-06)" | No overclaiming: this recording covers Intake → Blueprint → Export → Local build → CI. CD is being built now. |

---

## 3. Per-segment deep notes

### 3.1 Intro + A2 framing cards (0:00–0:12)

**What's on screen.** Two title cards: the take 1.6 intro ("everything shown is real") and the A2 honest-framing card explaining the separate session.

**Suggested narration.** "This is our builder journey, end to end, in about eight minutes. One thing before we start: everything you're about to see is real. Real console, real AWS deploy, real GitHub, real CI runs, and I'll give you the run ids so you can check them yourself afterwards. The first segment was recorded as its own wizard session, and the video says so on screen, because we hold ourselves to labeling everything honestly."

**Technical facts.**
- Final cut assembled 2026-08-07; 8:11, 14.6MB, full-decode clean.
- The only synthetic frames in the whole video are these title/summary cards; they only caption facts shown on camera.

**Honest labeling.** The separate-session disclosure is on screen, not just in internal reports. Two wizard sessions exist because the deploy-and-test segment was added after reviewer feedback on Take 1 (Stage-1 gap: the wizard's deploy step wasn't shown).

---

### 3.2 Segment A2 — Deploy and test on the platform, before export (0:12–1:47)

**What's on screen.** Alice signs in through the IdP tiles (Okta / Entra ID / Cognito land on the same demo directory). She opens Build an Agent, composes the Chat Assistant blueprint from the catalog as project `apd-rec-20260807`, clicks Validate, then Deploy to AgentCore. A banner appears: "time-lapse — real deploy wall-clock: 4 min 41 s (AgentCore provisions runtime, memory and identity in us-west-2; nothing but waiting is cut)". Once READY, she chats with the deployed agent, which streams back a real reply (greets Alice, offers order-status help). Closing caption: "…then export to GitHub (shown next)".

**Suggested narration.** "Alice is a domain builder in Customer Support. She signs in with her company identity, picks the Chat Assistant blueprint, and composes it with an approved skill and tool from the catalog. Notice she doesn't just generate config. She clicks deploy and the platform provisions a real runtime, memory, and identity on Amazon Bedrock AgentCore. That took four minutes and forty one seconds of wall-clock, which we've compressed here with the label you see on screen. And then she talks to the agent she just deployed. That reply is streaming from the live runtime, not a mock. So before anything ever reaches GitHub, the builder has already tested a running agent on the platform."

**Technical facts (Q&A depth).**
- Wizard session UTC: start 00:18:43Z, Generate 00:19:11Z, Validate OK 00:19:16Z, Deploy clicked 00:19:18Z, READY 00:23:59Z (4m41s = 280.8s), chat sent 00:24:09Z, reply complete 00:24:31Z (2026-08-07).
- Deployed runtime: `apdrec20260807_chat_agent-h0VY7M6ufi` (AgentCore, us-west-2); memory: `apdrec20260807_apdrec20260807Memory-a2GiriD01J`.
- The runtime was **deployed live during recording and cleaned up after review**. If asked "can I hit it now": no, it was torn down; the recording plus the timestamps are the evidence, and a fresh deploy reproduces it.
- Time-lapse is 25x (~11s of screen time); nothing besides waiting is cut.
- Identity: console federates to the company IdP (Okta SAML/OIDC, Entra ID OIDC, or Cognito user pool); the deployed runtime uses CUSTOM_JWT authorization against Cognito (discoveryUrl + allowedClients).
- What AgentCore provisions per project: Runtime + RuntimeEndpoint (CodeZip), Memory with 4 strategies (semantic, user preference, summarization, episodic; 30-day event expiry), IAM execution role, observability wiring (CloudWatch + OTEL dual export).

**Honest labeling.** On-screen card and banner state: separate session (2026-08-07, `apd-rec-20260807`) from the Take-1 export session (`apd-rec-20260806`); same platform, same blueprint. The time-lapse banner states the real duration. A2 is placed before segment A so its closing caption "then export to GitHub, shown next" is literally true.

---

### 3.3 Segment A — Intake → Blueprint → Export (1:47–2:57)

**What's on screen.** The original 2026-08-06 session. Sign-in, the three "Build an Agent" doors (Start from Blueprint / Design with Plato / Start from scratch), blueprint composition as `apd-rec-20260806` (persona, approved skill and tool from the catalog), the export review showing what the repo carries (47 files: agent code + CLAUDE.md + the platform CI gate: eval.yml, tests.yml, compliance.yml, gates/run-eval.mjs, gates/run-tests.mjs, gates/check-guardrails.mjs, golden dataset), then "Authorize with SSO & Export to GitHub" and the success screen with the real repo URL.

**Suggested narration.** "Here's the export session from the day before. Same blueprint, and now Alice hands the project off to GitHub. Look at the manifest: the export isn't just her agent code. It ships the foundation harness, a CLAUDE.md that guides the coding assistant, the golden evaluation dataset, and the CI gate workflows. That's what we mean by governance compiled into the repo from day zero. The repo you see created here is real and public in the melanie531 org, and every artifact I show later lives in it."

**Technical facts.**
- Repo: `github.com/melanie531/apd-rec-20260806`; PR #1 comes later in segment B.
- Foundation harness is platform-owned and marked do-not-reimplement: Cognito CUSTOM_JWT authorizer, AgentCore Memory wiring, identity propagation, OTEL auto-instrumentation to CloudWatch traces and metrics.
- The three doors map to build modes; this journey is L3 prebuilt blueprint, the paved road.
- CI gate = 3 GitHub Actions workflows (tests, eval-gate, compliance) + `gates/` scripts + golden dataset; protected files are marked so the coding assistant will not touch runtime/memory/identity plumbing.
- Journey stages covered so far: Project Intake → Template Selection/Blueprint Synthesis → Export to GitHub (stages 1–3 of the 11-stage builder journey).

**Honest labeling.** This segment is unchanged from Take 1; it is the session all later CI evidence belongs to.

---

### 3.4 Segment B — Local build with Claude Code + local gates (2:57–4:28)

**What's on screen.** A real terminal (asciinema, idle time collapsed): clone the exported repo, read README and CLAUDE.md, then a nested Claude Code run implements `app/chat_agent/tools/order_status.py` plus `app/chat_agent/tests/test_order_status.py` (7 tests) following CLAUDE.md and avoiding protected files. Three inserted cards then show exactly what the builder changed: (1) `git show --stat 0e0999e`, 7 files, 71 insertions, with the caption "Builder task → CC implements → local gates verify. Change loop: edit → gates → green → PR"; (2) the full hunk of the order_status tool; (3) the first three TDD tests plus "4 more tests (7 total)". Then the local gates run: `run-tests.mjs` 7 passed, `check-guardrails.mjs` PASS, `run-eval.mjs --mode judge` 100% (8/8, Bedrock judge). Branch `feat/recorded-demo`, commit, push, PR #1 created. Summary card: same gates re-enforced in CI.

**Suggested narration.** "Now Alice works like any developer. She clones the repo and her coding assistant reads CLAUDE.md, which tells it the house rules, including which files are protected platform plumbing. It implements a small domain tool, order status formatting, with tests written first. These cards show the actual diff: one tool, seven tests, seventy one lines. Then she runs the gates locally: unit tests, guardrail conformance, and the evaluation gate in judge mode, where a Bedrock model scores the agent's replies against the golden dataset. Everything green, so she opens the PR. The point of this inner loop is fast feedback against the exact same gate definitions the platform will enforce."

**Technical facts.**
- Nested Claude Code ran one-shot, headless (`claude -p`), ~3.5 min real time; terminal recording is genuine execution, not a replay; agg idle-time collapse renders 275s as ~74s, further compressed in this cut (splice at the gates boundary is disclosed; no terminal content altered).
- Commit `0e0999e` on branch `feat/recorded-demo`; PR #1.
- Local gates detail: `run-tests.mjs` wraps pytest (7 passed); `check-guardrails.mjs` checks guardrail conformance and protected-file integrity (PASS: 6 protected files, 3 controls, threshold 0.8); `run-eval.mjs --mode judge` scored 100% (8/8 scoreable units across 3 scenarios), threshold 80%, using real AWS credentials against a Bedrock judge model.
- Eval has two modes: **assert** (deterministic checks on transcripts, no AWS creds needed) and **judge** (LLM-as-judge scores replies, 80% threshold). Golden dataset ships in the export; `gates/transcripts/` must be populated first (shown handled on camera).
- Known judge blind spot: it scores reply text only, it cannot verify tool-usage claims; deterministic assertions cover that.

**Honest labeling.** The cards between the two terminal halves are rendered from the real repo state; the split point is documented and changes no recorded content. Claude Code usage is explicit on screen.

---

### 3.5 Segment C — Platform enforcement: red → green, live (4:33–8:03)

**What's on screen.** Terminal header: "the SAME gates from the local self-check re-run in CI, and cannot be bypassed." Then, live: a one-line breaking change (drops the trailing period from `format_order_status`), `git diff` shown, committed with an honest message ("refactor: simplify status line ... # deliberately wrong, the CI floor should catch it") and pushed. The screen shows the real wait for CI triggers ("0 of 3 … 3 of 3 workflow runs"), then `gh run watch` following the tests run to **failure**, and `gh run view --log-failed` with the actual pytest assertion error. At 5:44 the video cuts to the real GitHub web UI (read-only, saved login): PR #1 with the gate summary comment and merge box, the red tests run 31131716134 with the failure annotation, and the green run 31131827030. Back in the terminal: the fix (revert) is committed and pushed, `gh run watch` follows tests to **success**, all three workflows green, and the eval scorecard PR comment (PASS, 100%... assertion-only in CI) is fetched via the API. Caption: red then green, on real GitHub Actions, triggered during this recording.

**Suggested narration.** "This is the part I most want you to see. Local gates are advisory. The floor is CI, and you can't bypass it. So we break the code on purpose, live: one character, a missing period, exactly the kind of subtle regression a human reviewer might wave through. We push it and wait for GitHub Actions, in real time. The tests gate goes red within about a minute, and there's the actual pytest failure. While it's red, that PR cannot merge. Then we look at the same evidence in the GitHub web UI: the pull request, the failing run, and after the fix, the passing run. Those run ids are on screen and public, so you can pull them up yourself after this. We push the fix, watch it back to green, and the eval scorecard on the PR refreshes. Red to green, with evidence at every step."

**Technical facts.**
- Breaking commit `97bda4f7` (drops trailing period); revert `4993541b`. Both pushed on camera 2026-08-06 23:34–23:39 UTC.
- Red runs (created 23:35Z): tests **31131716134 failure**, eval-gate 31131716228 success, compliance 31131716113 success. Only the tests gate goes red for this break; the golden dataset doesn't assert on the trailing period. The PR is unmergeable with any required gate red, so "CI is RED" is accurate.
- Green runs (23:37Z): tests **31131827030 success**, eval-gate 31131826867, compliance 31131826573.
- CI eval ran assertion-only in these runs (no `AWS_EVAL_ROLE_ARN` repo variable configured, so "judge skipped — no AWS credentials"); it is still a real scoring gate, and judge mode was demonstrated locally at 100%. In a production setup CI judge mode runs via OIDC-assumed AWS credentials.
- The eval scorecard is posted by github-actions[bot] as a PR comment: mode, per-scenario score table, threshold 80%, PASS.
- gh CLI caveat shown honestly on screen: this fine-grained PAT lacks `checks:read` (not grantable for fine-grained PATs), so evidence uses the Actions runs API and `gh run list/watch/view` rather than `gh pr checks`; annotations request 403s are visible and explained.
- Branch end state: `feat/recorded-demo` ends green at `4993541b`; `order_status.py` byte-identical to the pre-break state.

**Honest labeling.** The web insert carries a persistent banner: read-only web view recorded 2026-08-07 with a saved login; the terminal gh/API evidence remains authoritative; these are the same runs (red 31131716134, green 31131827030). During capture there were no mutating clicks of any kind. The insert lands exactly where Take 1.5's on-screen caption promised it.

---

### 3.6 Closing card (8:03–8:11)

**What's on screen.** "CD non-prod + promotion chain — in progress. Batch 1/2 (Track 3: B1-01..B2-06). This recording covers Intake → Blueprint → Export → Local build → CI. CD will be appended when built."

**Suggested narration.** "And that's where the recording honestly stops. Continuous deployment to non-prod and the promotion chain to production are in progress right now, Batch 1 of Track 3. When they're built we'll extend this same journey, same repo, same evidence standard. What you've seen is the foundation: governance in the repo from day zero, and a confidence ladder where every rung produces evidence."

**Technical facts.** See Q&A group C for the Batch 1 breakdown (B1-01..B1-05) and the full 11-stage journey.

**Honest labeling.** Deliberate no-overclaiming: nothing is shown that doesn't exist yet.

---

## 4. Q&A appendix

### A. Platform & architecture

**A1. What exactly gets provisioned when she clicks Deploy?**
An Amazon Bedrock AgentCore Runtime + RuntimeEndpoint (CodeZip packaging, HTTP protocol, CUSTOM_JWT auth), an AgentCore Memory with four strategies (semantic, user preference, summarization, episodic; 30-day event expiry), an IAM execution role, and observability wiring (CloudWatch plus OTEL dual export, Langfuse OTLP supported). In this demo: runtime `apdrec20260807_chat_agent-h0VY7M6ufi`, memory `apdrec20260807_apdrec20260807Memory-a2GiriD01J`, region us-west-2. Deploy wall-clock was 4m41s.

**A2. How does identity work end to end?**
The console federates to the company IdP (Okta SAML/OIDC, Microsoft Entra ID OIDC, or an Amazon Cognito user pool; all three tiles land on the same demo directory). The deployed runtime validates caller JWTs via a Cognito app client (discoveryUrl + allowedClients). Builder identity is forwarded to the agent when chatting (the chat panel shows "Signed in as Alice Chen"). Roles and domain membership are resolved server-side by the platform, not by the client.

**A3. Is the infrastructure defined as code?**
Yes. CDK/CloudFormation is the Batch 1 flavor, using the `@aws/agentcore-cdk` L3 constructs; the IaC coverage study (B1-04) enumerated eight resource classes (runtime, memory, Cognito reference, IAM roles, optional gateway targets, guardrails config, SSM SecureStrings, observability) with zero CDK gaps. A Terraform awscc flavor was assessed and deferred because the awscc provider is missing GatewayTarget and Dataset resources.

**A4. How do you avoid resource-name collisions across environments?**
AgentCore control-plane names are account-global with a `<project>_<resource>` convention today. The Batch 1 acceptance criteria require per-environment name isolation via prefix/suffix injection, so dev/non-prod/prod copies of the same project can coexist.

**A5. What is the "foundation harness" and why can't the builder edit it?**
It's the platform-owned scaffold in the exported repo: the Cognito JWT authorizer, memory wiring, identity propagation, and OTEL auto-instrumentation. It's provisioned on deploy and marked protected; CLAUDE.md instructs the coding assistant not to touch it, and the guardrails gate checks protected-file integrity. Builders extend `app/` code and tests, not the plumbing.

**A6. What's the L1/L2/L3 layering the title refers to?**
L1 is foundation infrastructure needed even for non-agent workloads; L2 is agentic primitives that exist only because agents exist (runtime, memory, gateways, guardrails); L3 is user journeys, where personas compose L1+L2 for an outcome. This video is the L3 prebuilt-blueprint builder journey, the fastest paved road: catalog blueprints, capability bundles per persona (Platform Admin, Domain Lead, Domain Builder, End User), and a governed AI registry with semver and immutable versions.

**A7. What are the 11 journey stages, and which are built?**
1 Project Intake, 2 Template Selection/Blueprint Synthesis, 3 Export to GitHub, 4 Environment Provisioning + Onboarding One-Pager, 5 Local Development + Local Quality Gates, 6 CI Dual Ownership, 7 CD Non-Prod, 8 Offline Eval Gate, 9 Staging + Shadow Eval, 10 Prod Promotion, 11 Operate & Improve (continuous, cycles back to stage 5). Built today: 1, 2, 3, 5, 6 (red path shown live in this video). Planned in Batches 1–3: 4, 7–11.

**A8. Which model does the deployed agent use?**
The blueprint pins an approved model from the catalog ("Blueprint default" is shown in the wizard). Model parameters are written into the deployed runtime client config. The eval judge (local run) used a Bedrock-hosted judge model with real AWS credentials.

### B. Harness & gates

**B1. What are the three gates and what does each check?**
`tests` runs the repo's pytest suite (here 7 unit tests). `eval-gate` scores the agent against the golden dataset and posts a scorecard PR comment (threshold 80%). `compliance` runs repository compliance checks including secret scanning (gitleaks). All three run on every PR via GitHub Actions; the same definitions run locally via `gates/run-tests.mjs`, `gates/run-eval.mjs`, `gates/check-guardrails.mjs`.

**B2. Assert mode vs judge mode in the eval gate?**
Assert mode runs deterministic checks against recorded transcripts and needs no AWS credentials; every golden scenario ships with at least one deterministic check. Judge mode has an LLM (Bedrock) score the agent's replies; it enforces the 80% threshold and degrades gracefully to assert-only when credentials are absent. In the video: local run was full judge mode at 100% (8/8); the CI runs were assertion-only because the demo repo has no `AWS_EVAL_ROLE_ARN` variable, and the scorecard says so explicitly.

**B3. Where does the golden dataset come from?**
It's shipped by the platform in the export (`golden.jsonl`), scoped to the blueprint's scenarios (3 scenarios here: scope, honesty, injection resistance — each with deterministic checks plus judge assertions, 8 scoreable units total). The roadmap defines a promotion path where reviewed real production conversations become new golden scenarios via PR (stage 11 feeding back to stage 5).

**B4. What's the known limitation of judge mode?**
The judge sees transcripts only, so it can verify what the agent said but not tool-usage claims. Deterministic assertions and unit tests cover tool behavior. This is documented, not hidden.

**B5. Why do the gates run twice, locally and in CI? Isn't that duplication?**
It's the design. The local run is the builder's inner loop: fast feedback, same gate definitions, before a PR exists. The CI run is the platform floor: it re-runs the identical gates on every PR and cannot be bypassed by the builder. Local green is advisory; CI green is enforced.

**B6. What stops a builder from editing the gates or workflows to pass?**
The workflow and gate files are platform-owned with a tamper-resistant platform-gate marker (`platform-gate: v1`); guardrail conformance checks protected files; and branch protection requires the platform's checks. Weakening the gate fails the gate. In the video the break commit touched only domain code, and CI caught it.

**B7. What did the guardrails gate actually check in segment B?**
Guardrail conformance (6 protected files, 3 controls, threshold 0.8 in this run): protected-file integrity for the harness and guardrail configuration presence as wired by the blueprint. Verdict PASS. Bedrock Guardrails themselves are wired in the blueprint runtime config.

**B8. The builder used Claude Code. Is the platform tied to it?**
No. The repo ships CLAUDE.md as guidance for a coding assistant, and the demo uses Claude Code headless to show an assistant following house rules (including not touching protected files). Any editor or assistant works; the gates are what's binding.

### C. CI/CD & roadmap

**C1. What exactly happens when CI goes red?**
The failing workflow marks the PR check failed; with required checks, GitHub blocks merge. The builder reads the failure log (shown: `gh run view --log-failed` with the real pytest assertion), fixes locally, re-runs local gates, pushes; CI re-runs automatically. In the video the red-to-green cycle took about two minutes of wall-clock.

**C2. Only the tests gate went red. Why?**
The break dropped a trailing period in the formatted status line. The 7 unit tests assert exact strings, so tests failed. The golden dataset doesn't assert on that punctuation, so eval-gate stayed green; compliance is unrelated. One red required gate is enough to block the merge, so "CI is red" is accurate.

**C3. What's in Batch 1 (the "in progress" on the closing card)?**
Track 3, Batch 1 covers CD non-prod: B1-01 auto-deploy to non-prod on CI green (deploy event + artifact version recorded, no human action), B1-02 runtime pluggable per intake (AgentCore Runtime or ECS), B1-03 environment wiring auto-provisioned (observability, identity, gateway, verified by invoking the deployed agent), B1-04 IaC verification (done, CDK chosen, deploy spike verified in us-west-2), B1-05 onboarding one-pager generated at bootstrap. Identity prerequisite for B1-03: a Cognito user pool must pre-exist or be CDK-provisioned in the target account. Batch 2 (B2-x) adds the promotion evidence pack, evidence freshness, one-click prod approval, override handling, and one eval-config source of truth.

**C4. When CD lands, what changes in this demo?**
After CI green on merge, the agent auto-deploys to non-prod with its wiring; then the offline eval gate (stage 8) builds a promotion evidence pack, staging runs shadow eval (stage 9), and prod promotion (stage 10) requires an explicit one-click approval with requester-not-equal-approver enforced. The video will be extended along the same repo and evidence standard.

**C5. Are the CI runs in the video reusable evidence?**
Yes. Public run ids on repo `melanie531/apd-rec-20260806`: red tests 31131716134 (plus 31131716228 eval-gate, 31131716113 compliance), green tests 31131827030 (plus 31131826867, 31131826573), all created 2026-08-06 23:35–23:37 UTC, triggered by the on-camera pushes to PR #1.

**C6. How long from push to CI verdict?**
Trigger latency was about 60 seconds on camera (the "0 of 3 … 3 of 3" wait is unedited), and the tests job itself ran 34–39s. So roughly 90 seconds from push to a red or green verdict on this repo.

### D. Demo authenticity

**D1. Is any of this staged or mocked?**
No. Real console UI, real AgentCore deploy and chat reply, real GitHub repo/PR/Actions pages, real terminal sessions. The only synthetic frames are title and summary cards, which caption facts shown on camera. The intro card states this and the run ids let anyone verify.

**D2. What was edited, and how do we know?**
Three disclosed edits: the A2 deploy wait is a 25x time-lapse with the real duration (4m41s) on the banner; segment B's terminal cast was split at the gates boundary to insert the "what changed" cards (no terminal content altered or re-recorded); the GitHub web view was inserted into segment C at the exact point the previous cut's caption promised. Idle time in terminal casts is collapsed. Nothing that happened was changed; only waiting was compressed.

**D3. Why two wizard sessions (apd-rec-20260807 vs apd-rec-20260806)?**
The deploy-and-test segment (A2) was added after review of Take 1 to show the wizard's full stage 1: deploy and test before export. It was recorded 2026-08-07 as a fresh session; the export and all CI evidence belong to the original 2026-08-06 session. This is disclosed on screen at 0:05 and 0:20, and the ordering was chosen so "then export to GitHub, shown next" is literally true.

**D4. Can I chat with the deployed agent now?**
No; the A2 runtime was deployed live during recording and cleaned up after review. The wall-clock timestamps, resource ids, and the on-camera streamed reply are the evidence, and the deploy is reproducible from the same blueprint.

**D5. Anything go wrong during recording?**
Yes, and it's documented: GitHub Actions had a major outage mid-recording (2026-08-06 ~22:16 UTC; githubstatus.com showed "Incident with Actions"). The first red-path push produced zero runs, was reverted off-camera, and the take restarted after recovery; probe commits verified trigger latency was back to ~60s before re-recording. Every run shown in the video was created on camera; the off-camera outage commits are listed in the take report and none appear in the video.

**D6. Why does the terminal, not the web UI, carry the CI evidence?**
The recording rig's fine-grained PAT cannot read the Checks API (GitHub doesn't offer `checks:read` for fine-grained PATs), so evidence uses the Actions runs API and gh CLI, which are authoritative. The web view was added with a saved browser login, strictly read-only (navigation and scrolling only), and its banner says the terminal evidence remains authoritative and the runs are the same.

**D7. Was anything pushed to GitHub while making the final cut?**
No. Take 1.6 made zero pushes and zero new CI runs; branch `feat/recorded-demo` still ends at the on-camera revert `4993541b`, and the domain tool file is byte-identical to its pre-break state.

**D8. Were any secrets exposed?**
No. Cognito demo credentials were fetched from SSM SecureString at setup, mode 600, never committed or echoed, and deleted after recording. All casts, drivers, reports, and video metadata were scanned for token/key patterns (GitHub PATs, AKIA/ASIA keys, client secrets): clean. Git pushes authenticated via gh's credential helper, so no token appears in any URL on camera.

### E. Security & governance

**E1. What does "governance compiled into the repo" mean concretely?**
The export itself carries the controls: protected harness files, CLAUDE.md rules for assistants, the golden dataset, the three gate workflows with a tamper-resistant platform-gate marker, and secret scanning. Governance isn't a wiki page; it's files that execute on every PR from day 0.

**E2. Who approves what, and can someone approve their own request?**
Access grants, prod promotions, and override exceptions all require approval, and requester-not-equal-approver is enforced server-side (the R-002 pattern); self-approval attempts are rejected, including for admins. Prod promotion (B2-04) is an explicit one-click approval with the approval record and evidence pack attached to the audit trail.

**E3. What's audited?**
All governance writes, with a fixed nine-field audit projection; view access is capability-gated and cross-domain isolated. CI adds its own evidence layer: gate verdicts as PR scorecard comments and, in Batch 2, versioned promotion evidence packs.

**E4. How is prompt injection or unsafe output handled?**
Two layers: Bedrock Guardrails are wired into the blueprint runtime config (L2), and the golden dataset includes injection-resistance and honesty scenarios that the eval gate scores on every PR (the scorecard's smoke-injection and smoke-honesty rows are visible in the video at 7:50–8:01).

**E5. Can a domain builder reach another domain's agents or data?**
No. Capability bundles are resolved server-side per persona and domain; Alice's console shows only her domain's blueprints, registry entries, and agents, and cross-domain audit isolation applies.

**E6. What least-privilege story applies to the demo rig itself?**
The recording PAT was fine-grained and deliberately narrow (it couldn't even read Checks or dispatch workflows, both 403s are shown or documented); AWS eval credentials were used locally only; CI would use OIDC role assumption rather than long-lived keys.

---

## 5. If asked something not in this doc

- Say what is known and shown: "What I can tell you from the recording and its reports is X." Anchor to the artifacts: repo `melanie531/apd-rec-20260806`, PR #1, the six run ids, the take reports.
- Do not guess about unbuilt stages (CD, staging, prod promotion) beyond the Batch 1/2 scope stated here; say "that's in the batch we're building now, let me follow up with the design doc."
- For deep AgentCore internals or pricing, defer: "I'll take that offline and send the reference."
- If someone challenges authenticity, offer verification live: open the public repo, the PR, and the Actions runs and compare ids with the video.
- Log the question and follow up within a day; the platform docs (Track 3 requirements, IaC coverage study, dogfood findings) cover most depth questions.
