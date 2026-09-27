// T13 runner: executes the whole Playwright suite (task smokes + persona
// journeys) sequentially against a console server on :4000, and prints a
// scoreboard. Fails if any test fails.
// Run: cd e2e && npm run e2e     (or: node e2e/run-all.mjs from the repo root)
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const TESTS = [
  // unit tests (no browser): J-T2 export composer — manifest per preset
  '../console/export-composer.test.mjs',
  // G1 capability resolver unit tests: bundle resolution, overrides, default-bundle contract
  '../console/capabilities.test.mjs',
  // G3 grant-store unit tests: SPEC shape, evidence precondition, expiry sweep, legacy view
  '../console/grants.test.mjs',
  // G5 project-backfill unit tests: SPEC shape, idempotency, append-only migration
  '../console/projects.test.mjs',
  // per-task smokes (fast regression net)
  'smoke-gate.mjs',   // T07 phase gate: adversarial matrix A1/A2/A3/A6 + SSO tiles + H1 DOM sweep
  'smoke-auth-integration.mjs', // Task 6: Cognito loading, 401 sign-out, stream abort, and second-user state isolation
  'smoke-personas.mjs', 'smoke-registry.mjs', 'smoke-governance.mjs',
  'smoke-cost.mjs', 'smoke-memory.mjs', 'smoke-hitl.mjs', 'smoke-obs.mjs', 'smoke-wizard.mjs',
  'smoke-domains.mjs', // T12 domain vending (snapshots + restores domains.json)
  'smoke-alerts.mjs',  // T13B alerting: policy defs in Governance, firing feed in Obs, SEV1 auto-suspend
  'smoke-scale.mjs',   // T14 scale fixture (S1/S2): 100+ registry agents / 5+ domains (seeds + restores)
  'smoke-blueprints.mjs', // T15 blueprint expansion (T1/T2/S4): ADK+EKS instances, compat matrix, version pin
  'smoke-lineage.mjs', // T16 ML Platform model lineage (T3): fine-tuned model provenance + consumer derivation
  'smoke-goldenpath.mjs', // T18 golden path (M1/M4): 9 animated stages, ownership panels, deep links, reduced-motion, offline
  'smoke-journeys.mjs', // T19 persona journeys (M2/M4): 4 animated steppers, invocation trace flow, persona-gated deep links, reduced-motion
  'smoke-story.mjs',  // T20 per-page story strip (M3): who am I / what do I own / where next on every nav page, per persona
  'smoke-domain-governance.mjs', // L4 Melanie fixes: F1 domain drill-down, F2 memory governance (access reversal), F3 ownership differentiation
  'smoke-segregation.mjs', // L4 round-2 segregation audit: P0-1 eval-dataset triple gate, P0-2 HITL content masking, P1-2 memory single path, P2-1 ledger guard
  'smoke-doors.mjs',  // J-T1 builder journeys: three-door Build tab entry, per-persona rendering + routing
  'smoke-tlp-b8.mjs', // TLP-B8 GitHub-first flow: door reorder (AI-assisted/Foundation start/Blueprint), shared guardrails-configurator panel (toggle+priority reorder), no Deploy button anywhere in the flow, export -> 5-stage lifecycle tracker, fixture eval-results rendering
  'smoke-plato.mjs',  // J-T7/J-T8 Plato inception chat + contract: fixture server on :4100, session identity, transcript/contract lifecycle, SPEC export
  'smoke-markdown.mjs', // G11 chat markdown rendering: one <ol> with sequential numbering, no raw asterisks, snake_case spacing intact (fixture server on :4101)
  'smoke-plato-stream.mjs', // G15 streaming inception chat: SSE first-token-before-completion, progressive UI render, transcript consistency (fixture server on :4103)
  'smoke-plato-handoff.mjs', // G17 confirmation handoff: [[GENERATE_SPEC]] marker stripped from transcript/screen, handoff flag on both chat paths, UI auto-starts generation after explicit confirmation (fixture server on :4104)
  'smoke-scratch.mjs', // J-T10 from-scratch journey: minimal form, live MINIMAL-preset preview, single-digit gate-pack export
  'smoke-capabilities.mjs', // G1 capability bundles: gated admin API, validation, edit round-trip (snapshots + restores config)
  'smoke-grants.mjs', // G3 generalized grant-requests: one queue for all resource types, evidence gate, R-002/R-003, legacy facade compat
  'smoke-pii-split.mjs', // G4 PII split: metadata whitelist (R-004 adversarial fixture), platform break-glass grant + audit, expiry re-lock (snapshots + restores sim-memories.json)
  'smoke-memory-scope.mjs', // G12 memory scope isolation: admin default list = platform account only, domain metadata via domain view, cross-domain content = break-glass grant + audit
  'smoke-memory-attribute.mjs', // R-015 claim path: platform-admin-only POST /api/memory-attribute (unknown domain/id + already-owned rejected, audited), Memory-page Attribute owner action, Governance "N stores need an owner" badge (snapshots + restores sim-memories.json + memory-attributions.json)
  'smoke-obs-scope.mjs', // G13 obs trace scoping: Langfuse rows follow the deployment account (platform default = platform agents only, domain agents in domain view), per-agent filter narrows never widens (fixture server on :4102)
  'smoke-projects.mjs', // G5 durable projects: composition backfill (idempotent), SPEC shape, domain scoping/404s, compose-creates-project (snapshots + restores projects.json)
  'smoke-domain-project.mjs', // G14 Domain<->Project relation: no null-domain project (R-001), creation domain from session only (client field ignored), Domain › Project › Agent breadcrumbs wired (snapshots + restores projects.json)
  'smoke-members.mjs', // G6 Members page: capability-gated member writes (R-006), audited add/remove/reassign (R-007), platform-tier bundle guard, capability-scoped UI affordances (snapshots + restores projects.json)
  'smoke-inbox.mjs',  // G7 access-requests inbox (Governance › Access requests tab): one queue over all grant types, status/domain filters never widen scope, UI approve/reject with purpose+expiry, compat links from obs
  'smoke-profiles.mjs', // G8 domain profiles: factory palettes + runnable starter agents, create-from-profile pre-seeds workspace, foreign-domain palette entries dropped (snapshots + restores projects.json)
  'smoke-audit.mjs',  // G9 unified Audit page: one timeline over hitl-audit + obs-audit (grants, break-glass reads, member changes, bundle edits R-007), viewAuditTrail-gated, domain-scoped, per-session content masking (snapshots + restores projects.json)
  'smoke-visibility-matrix.mjs', // TLP-B1 spec §8 visibility matrix: memory grant-gated all roles (platform-peer 4-eyes), KB member-default vs cross-plane lock, trace tiers + platform-own exception, cost rollup gating, restricted registry redaction + registryUse escalation, QA B-face 403s + C-face default-deny
  'smoke-tlp-b2.mjs', // TLP-B2 v2 per-persona shells: exact nav DOM anchor per role, builder registry read-only (UI + 403), Memory collapsed / KB expanded, Domain Console Create Project, Platform Console hybrid + Templates stub
  'smoke-tlp-b3.mjs', // TLP-B3 Domain Console deepening: dashboard aggregates (domain-scoped 403s), project card fields + P2 fixes (pluralize, no "backfill"), users×projects matrix assign/revoke, approvals (self-approval 403, escalated read-only), domain policy persistence, D6 justification PII masking adversarial (snapshots + restores domain-policies.json + projects.json)
  'smoke-tlp-b4.mjs', // TLP-B4 6-step create-project wizard: per-step server validation 400s, template differentiation asserted on generated artifacts (blueprint/persona/model/skills diff), org+domain-enforced guardrails locked (step 5 reads the §6.4 store), create rides generate pipeline + shared member core, UI 6-step happy path (snapshots + restores projects.json)
  'smoke-tlp-b5.mjs', // TLP-B5 three-tier cost drill-down: platform->domain->project->agent, G1/G2 single-source cross-surface equality (/api/costs vs /api/domain-cost-rollup vs /api/project-detail), G3 shared-allocated reconciliation (components sum to cost exactly at every tier), G4 determinism (double-sample) + P95>P50 + no-negatives + token/cost correlation, tier gating reuse (builder 403, cross-domain 403+ownership pointer, unknown 404)
  'smoke-tlp-b6.mjs', // TLP-B6 close-out: 17 entry-point availability tests (7 builder + 4 domain + 6 platform, no 5xx on the wire), exemption expiry (TTL @ layer-2, read-time sweep) + revoke (403 wrong roles, self-revoke audited, harness restore), §10-4 justification masking across all render paths (email/phone/passport shapes), §10-2 bootstrap tag evidence, totalWithSharedUsd exact arithmetic + direct-cost footnote (snapshots + restores policy-exemptions.json + projects.json)
  'smoke-tlp-b7.mjs', // TLP-B7 IA restructure: 11-entry platform sidebar (exact list, every entry opens + highlights), Build workspace-reuse picker + /api/platform-build-open role gates (lead/builder/enduser 403, no scope widening B7-B10), blueprint submission lifecycle (platform-only submit, schema validation vs blueprintOptions, self-approval 403 + audited, approve→listed / reject→never listed, queue invisible to non-platform, audit entries) — snapshots + restores blueprint-submissions.json
  'smoke-tlp-b11.mjs', // TLP-B11 builder-journey gap fixes: test gate fail-closed + exemption, FULL export ships identity/memory/multiturn TDD tests + record-transcripts.mjs + deploy-dev.yml/promote.yml, baseline eval local-dev fallback source checks
  'smoke-tlp-b13.mjs', // TLP-B13 nav cleanup + demo seeds: admin single AI Registry entry (org-level, bwregistry gone; builder/lead untouched), Fleet onboarding empty state (stubbed-empty + real-data negative), seeded IN_REVIEW approval queue + warm cost ledger + enduser publish seed
  'smoke-tlp-b16.mjs', // TLP-B16 demo seed pack: pending guardrail-exemption + blueprint-submission queues warm on cold start, admin workspace Cost non-zero (platform-domain ledger rows), lead grant-request inbox >=1 pending, enduser Agents >=2 published (supportdesk + opsassistant APPROVED seeds)
  'smoke-tlp-b17.mjs', // TLP-B17 fleet cards + header/copy: workspace Fleet agent cards (lifecycle+approval badges, R2-4 follow-up note, health, 7d cost, Open/Chat/Traces), both fleet states (B13 onboarding card preserved), function-name workspace H1s (three admin pages distinct), lead Dashboard/Projects intro split, NEXT story step as unclipped link
  'smoke-tlp-b18.mjs', // TLP-B18 enduser landing: Overview >=2 recommendation cards (live /api/fleet APPROVED filter) each linking directly to the agent chat page, Agents page as cards (lifecycle badge + description + Chat, no approval/cost/delete surface)
  'smoke-tlp-b19.mjs', // TLP-B19 builder journey break-points: fleet-detail lifecycle stepper (5 stages, Advance persists across reload, terminal registered hides the button, enduser 403 + no UI surface), registry Use-in-Build (APPROVED Skill/MCPServer only, wizard pre-selection), builder blueprint submission -> platform approvals queue -> peer approve -> catalog/wizard step-1 closure — snapshots + restores blueprint-submissions.json + agent-lifecycle.json
  'smoke-tlp-b20.mjs', // TLP-B20 governance compliance + builder cost: compliance tab count cards reconcile with /api/registry + /api/blueprint-submissions, guardrail wiring %, oldest-pending SLA card, audit/queue jump links, honest empty state, builder Cost per-agent rows reconcile exactly with /api/costs, C1-C3 cold-start first-screen <=3s (spawns its own cold server on :4297)
  'smoke-tlp-b21.mjs', // TLP-B21 B16 seed idempotency: fresh-clone cold start reseeds all three approval surfaces, consumed in-memory grant seed self-heals on restart, JSON stores stay idempotent (no duplicate rows) — spawns its own servers on :4298/:4299, snapshots + restores policy-exemptions.json + blueprint-submissions.json
  'smoke-validation-readonly-blueprint-policy.mjs', // P0 item 2 validate-is-a-read: /api/validate on the committed data-analyst fixture and /api/wizard-validate with the seed-on-read stores removed leave the working tree and every console/*.json byte-identical, the suppressed seed is still enforced in memory (domain-enforced guardrail omission still rejected), and --write-env opts the write back in. P0 item 5 blueprint gate: /api/generate and the wizard's validate/create both refuse a non-APPROVED registry blueprint, a pending_approval or rejected contribution, an unknown id and another domain's APPROVED entry with a 400 naming the reason (the refusal lands before any project directory), while an APPROVED entry and a peer-approved contribution still pass — spawns its own servers on :4300/:4301, restores every console/*.json
  // persona journeys (admin tour, end-user positive approval path, domain-lead
  // full pass incl. grant decide + lifecycle + blueprint chain + cross-domain
  // 403s, builder full build-an-agent flow incl. a real eval run ~6 min)
  'journey-admin.mjs', 'journey-user.mjs', 'journey-lead.mjs', 'journey-builder.mjs',
]

if (process.env.HOSTED_ROLE_SWITCHING_ACCEPTANCE === '1') {
  TESTS.push('hosted-role-switching-acceptance.mjs')
}

// Preflight: server must be up.
try { await fetch((process.env.CONSOLE_BASE || 'http://localhost:4000') + '/api/blueprints') }
catch {
  console.error('Console server is not running. Start it first: node console/server.mjs')
  process.exit(1)
}

const results = []
for (const t of TESTS) {
  console.log(`\n========== ${t} ==========`)
  const r = spawnSync('node', [path.join(here, t)], { stdio: 'inherit' })
  results.push([t, r.status === 0])
}

console.log('\n========== SCOREBOARD ==========')
let failed = 0
for (const [t, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t}`)
  if (!ok) failed++
}
console.log(failed === 0 ? '\nALL TESTS PASSED' : `\n${failed} TEST FILE(S) FAILED`)
process.exit(failed ? 1 : 0)
