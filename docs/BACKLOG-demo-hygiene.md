# Demo Hygiene Backlog (2026-08-08, flagged by deployment verifier in screenshot review)

Not urgent — scheduled after CD line (B1-01) closes. Same family as R-016/R-017 (test pollution of shared on-disk state).

## H-1: Governance pending queue polluted by smoke residue
- ~27 pending items `SmokeAuditPolicy*` / `audit-xxxx-ms*` (Aug 2-3 HITL smoke leftovers).
- Fix: (a) e2e HITL approval smokes get `finally` cleanup — deny/remove the pending items they created; (b) one-off sweep of existing residue.
- Verify: admin Governance queue shows 0 Smoke*/audit-* pendings after full suite run.

## H-2: Eval page ~all red (20/21 historical runs FAIL)
- workflowagent real historical runs, 0.38/0.50 < 0.6 threshold; only one 0.63 pass.
- Decision (source maintainer, refined per deployment verifier 2026-08-08): archive stale runs (old model/dataset era) + RE-RUN fresh evals for real (golden dataset has deterministic checks; real green is cheap). Do NOT lower thresholds just to look green.
- If any seeded/illustrative run is ever added, it MUST carry an explicit `[illustrative]` chip (D6 rule: no unlabeled simulated data) and must be visually distinguishable from real runs. Priority: real green > labeled illustrative > unlabeled fake (forbidden).
- Verify: Eval page default view tells a coherent story (mix of green + explainable reds), no wall of red.

## Note
- Screenshots 4 (Governance) and 6 (Eval) from 2026-08-08 batch should not be used externally until both fixed and re-captured.

## H-3: Promotion requester≠approver check is vacuous across identity namespaces (2026-08-26, source maintainer + deployment verifier)
- `/api/hitl-promotion-decide` blocks self-approval via bare string compare: `request.requester === session.user`.
- But `request.requester` = GitHub actor login (promote.yml writes `$GITHUB_ACTOR`) while `session.user` = console user id — different namespaces, no mapping. `melanie531` (GitHub) vs `melanie` (console) never match, so the same human can dispatch and approve.
- The deployment verifier's HITL signoff runs exercised the approve/deny flow itself, not this cross-namespace negative case.
- Fix options: (a) hitl-gate writes a mapped console principal into the request JSON at freeze time, or (b) decide route maps GitHub login → console identity before comparing. Either way add the negative test (same-human dispatch+approve must 403).
- Demo impact: none if recording uses a bot PAT to dispatch (requester shows bot identity, distinct from any console principal). Negative-case live test scheduled during recording prep for evidence.
