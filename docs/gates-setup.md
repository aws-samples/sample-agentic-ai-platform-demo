# Platform gate credentials — setup & round-trip harness (J-T4)

How the exported repos' CI gates authenticate, and how we prove they really run.

## Eval judge via GitHub OIDC (no stored secrets)

The `eval-gate` workflow scores natural-language assertions with a Bedrock
judge. It gets AWS credentials through GitHub's OIDC federation — no keys are
ever stored in the repo, workflows, or Actions secrets.

Already provisioned in account `820242898417` (created 2026-07-31 via aws cli):

| Piece | Value |
| --- | --- |
| OIDC provider | `arn:aws:iam::820242898417:oidc-provider/token.actions.githubusercontent.com` |
| IAM role | `arn:aws:iam::820242898417:role/apd-journey-eval-judge` |
| Role permissions | `bedrock:InvokeModel` only (inline policy `bedrock-invoke-only`) |
| Trust condition | `token.actions.githubusercontent.com:sub` matching `repo:ao-lab-531/apd-journey-*` or `repo:melanie531/apd-journey-*` (plus the ID-enriched forms `repo:<owner>@<owner_id>/apd-journey-*` — GitHub's OIDC sub claim carries account IDs on these repos, discovered live 2026-07-31 when the judge got `AccessDenied` without them); audience `sts.amazonaws.com` |

Wiring a repo for judge mode is two repo **variables** (not secrets — the ARN
is not sensitive):

```bash
gh variable set AWS_EVAL_ROLE_ARN --body arn:aws:iam::820242898417:role/apd-journey-eval-judge --repo <owner>/<repo>
gh variable set AWS_EVAL_REGION  --body us-west-2 --repo <owner>/<repo>
```

Without the variable the eval gate still runs deterministic checks
(assertion-only mode) and says exactly what was skipped; `--mode judge` fails
with these setup instructions rather than pretending to pass.

## GitHub PAT (harness only)

The round-trip harness needs a PAT to create/push the test repo. It is read
from SSM (us-west-2) at runtime and never printed, logged, or passed in
process args/remote URLs (git auth goes through an inline credential helper
reading the env).

- Spec location `/openclaw/github/ao-lab-531-pat`: **does not exist** in the
  account today. The harness tries it first, then falls back to
  `/openclaw/github/melanie531-pat` (which exists).

## PAT scopes (fine-grained token from SSM; grants updated 2026-07-31)

The `melanie531` fine-grained PAT (the only GitHub credential on this
machine; the gh keychain token is the same token). Current capability matrix:

| Capability | Result |
| --- | --- |
| Create private repo under `melanie531` | ✅ works |
| Push plain content (git https) | ✅ works |
| Push `.github/workflows/*` | ✅ works (Workflows: read/write granted 2026-07-31) |
| Set Actions repo variables | ✅ works (Variables: read/write granted 2026-07-31) |
| Read commit check-runs API | ❌ 403 (no Checks: read) — harness falls back to the workflow-runs API automatically |
| Re-run a workflow run | ❌ `Resource not accessible by personal access token` — retrigger by re-running the harness (force-push reopens the PR heads) |
| Branch protection on a private repo | ❌ 403 `Upgrade to GitHub Pro or make this repository public` (plan limit, not PAT) — harness records `protection: "unavailable"` and asserts check conclusions directly; the gate verdict is still real, only the merge-button block is deferred |
| Create repo in `ao-lab-531` org | ❌ 403 `You need admin access to the organization` — test repos live under `melanie531` instead; PAT at `/openclaw/github/ao-lab-531-pat` still does not exist (harness tries it first, falls back) |

The harness fails fast with exact-grant instructions when it hits a scope
rejection, and never weakens the gates to work around it.

## Live round-trip evidence (honest ledger)

Each run's full evidence JSON is written to
`.export-staging/<repo>-evidence.json`. Verdicts below are real GitHub
Actions conclusions on real PRs — nothing simulated.

| Date | Journey / preset | Project | Repo | Fail PR (eval must block) | Pass PR (all green) | Judge mode |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-31 | C / MINIMAL (T4b proof) | opsassistant | `melanie531/apd-journey-minimal` | [#3](https://github.com/melanie531/apd-journey-minimal/pull/3) eval=failure, tests+compliance=success | [#4](https://github.com/melanie531/apd-journey-minimal/pull/4) all success | assertion-only (OIDC sub mismatch at run time, fixed below) |
| 2026-07-31 | A / FULL (T6) | supportdesk | `melanie531/apd-journey-full` | [#3](https://github.com/melanie531/apd-journey-full/pull/3) eval=failure (71% < 80%), tests+compliance=success | [#4](https://github.com/melanie531/apd-journey-full/pull/4) all success (100%) | **Bedrock judge via OIDC** (scorecards on the PRs say `Mode: judge`) |
| 2026-07-31 | B / SPEC depth 1 (T9a) | billing-support-copilot (Plato inception fixture) | `melanie531/apd-journey-spec` | [#1](https://github.com/melanie531/apd-journey-spec/pull/1) eval=failure, tests=failure (red TDD by design), compliance=success | [#2](https://github.com/melanie531/apd-journey-spec/pull/2) eval=success (judge, 100%), tests=failure (red TDD by design), compliance=success | **Bedrock judge via OIDC** (`Mode: judge` on the PR scorecard) |
| 2026-07-31 | B / SPEC depth 2 (T9b) | billing-support-copilot (built by assistant) | `melanie531/apd-journey-spec` | n/a (depth 2 has one PR: the build) | [#3](https://github.com/melanie531/apd-journey-spec/pull/3) all success — eval=success (judge), tests=success (TDD flipped green), compliance=success; **merged** (`db2c1d5`) | **Bedrock judge via OIDC** (`Mode: judge` on the PR scorecard) |
| 2026-07-31 | C / MINIMAL (T11, judge-mode rerun) | opsassistant | `melanie531/apd-journey-minimal` | [#5](https://github.com/melanie531/apd-journey-minimal/pull/5) eval=failure (judge, 75% < 80%), tests+compliance=success | [#6](https://github.com/melanie531/apd-journey-minimal/pull/6) all success (judge, 100% 8/8) | **Bedrock judge via OIDC** (`Mode: judge` on both PR scorecards) |

Journey B depth-1 note (2026-07-31): a SPEC export ships **no application
code** — its TDD skeleton (`tests/test_acceptance.py`) is deliberately red, so
the `tests` gate concluding `failure` on BOTH PRs is the asserted, correct
pre-build state (the harness expects `tests=failure` for the SPEC preset).
The export was composed from the recorded Plato inception profile
(`console/plato-fixture.json`) via `--inception`, exactly the contract the
console generates. Depth 2 (assistant builds until green on
`built-by-assistant`) flips the tests gate and is recorded separately.

Journey B depth-2 note (2026-07-31): the build was performed by Claude Code
running headless (`claude -p`, Bedrock backend) against a fresh clone, with
tools restricted to read/edit/write + `python3`/`pytest` and an explicit
prohibition on touching `.github/`, `gates/`, `tests/`, `agentcore/`,
`CLAUDE.md`, `SPEC.md` — it implemented `app/main.py` (122 lines) from the
CLAUDE.md 🔨 zone until all 4 acceptance tests passed, and generated real
`handle()` transcripts for every golden scenario. Full run log:
`.export-staging/build-t9b/cc-build-log.txt`; evidence JSON:
`.export-staging/apd-journey-spec-built-evidence.json`. The pre-build state is
preserved as tag `spec-only`; `spec-only...main` compare shows exactly the
assistant's diff. Merge performed by the operator after all three gates
concluded `success` (branch protection unavailable on the free-plan private
repo, per the fallback above).

Journey A run notes (2026-07-31): the first FULL attempt (PRs #1/#2) ran
assertion-only — CloudTrail showed `AccessDenied` on
`sts:AssumeRoleWithWebIdentity` because GitHub's OIDC sub claim on these repos
is ID-enriched (`repo:melanie531@54656186/apd-journey-full@…`), which the
plain `repo:melanie531/apd-journey-*` pattern doesn't match. Fix: added the
`repo:<owner>@<owner_id>/apd-journey-*` patterns to the role trust policy
(IAM only; no code change). The rerun (PRs #3/#4) judged with Bedrock:
supportdesk's real golden dataset (4 scenarios, judge-only assertions), pass
transcripts scored 100%, the deliberately-dishonest balance reply dropped the
fail case to 71% and the eval gate blocked it. Transcript fixtures live in
`scripts/fixtures/journey-a-supportdesk/{pass,fail}/`.

Journey C note (2026-07-31): the T4b run (PRs #3/#4) predates the OIDC
trust-policy fix and ran assertion-only. The T11 rerun (PRs #5/#6, same repo,
same 9-file MINIMAL pack) proves the judge path for Journey C too: the
composer-seeded baseline dataset (3 org smoke scenarios: scope / honesty /
injection, deterministic checks + judge assertions) scored the dishonest
transcript 75% (< 80%, eval gate red) and the honest set 100%. Evidence JSON:
`.export-staging/apd-journey-minimal-evidence.json`.

## Round-trip harness

```bash
node scripts/journey-roundtrip.mjs --project <name> --preset FULL|SPEC|MINIMAL \
  [--inception console/plato-fixture.json]  # SPEC: compose from a Plato inception profile (no project dir)
  [--owner melanie531] [--repo apd-journey-<preset>] [--pass-dir d] [--fail-dir d] [--cleanup]
```

What it proves, per run (evidence JSON written to
`.export-staging/<repo>-evidence.json` and quoted in the ledger):

1. Stages the export with the shared composer (the real product path).
2. Creates/reuses the private test repo, force-pushes `main` (harness owns it).
3. Sets branch protection: `eval`, `tests`, `compliance` as required checks.
4. Opens two PRs committing agent transcripts for the golden scenarios:
   `case-fail` (one deliberately dishonest reply) and `case-pass`.
5. Polls check runs until all three gates conclude on both heads.
6. Asserts: fail case → eval gate `failure` and the merge API refuses the PR;
   pass case → all green and the PR merges. SPEC preset exception: the TDD
   skeleton is red by design, so `tests=failure` is expected on both PRs and
   merges are not attempted pre-build.

Repo hygiene: repos are prefixed `apd-journey-`, reused across runs
(force-push baseline), and deletable with `--cleanup` (needs `delete_repo`
scope). Keep the set small per the rate-limit rule.
