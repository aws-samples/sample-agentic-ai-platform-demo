# Project working context

Read [agent.md](agent.md) before changing this repository. It is the project
specification requested by the owner, recorded on 2026-09-14.
Read [project memory](memory/projects/agentic-ai-platform-demo.md) for the
implementation map, verified deployment context, and known gaps.

## Product invariants

- Build an enterprise agentic AI **control plane**: shared templates, Registry,
  Gateway, policy, governance, evaluation, observability, and domain bootstrap.
- A domain is a business unit and governance boundary. Each domain owns multiple
  projects; each project is a persistent build workspace and can contain multiple
  agents. A user can belong to multiple projects.
- Platform is also an owning domain for its own projects. Reuse that ownership
  model; do not introduce a second, nested “platform domain” product layer.
  Existing internal `platform` IDs and registries are compatible with this rule.
- The main builder journey is bootstrap → GitHub export → local coding agent →
  CI → dev → preprod → platform human approval → prod → telemetry feedback.
- Foundation Harness supplies inherited controls. Builders implement the Domain
  Harness inside those controls. Lower scopes cannot silently weaken them.
- Persona determines actions; domain/project membership determines scope.
  Workspace navigation and browser state are not authorization.
- Production requires a real human decision enforced by the delivery pipeline,
  tied to the exact release and target. A UI status or an AI decision is insufficient.
- Separate current implementation, target design, illustrative behavior, and
  verified live evidence in documentation and completion reports.

## Deployment context

- The owner designated AWS account **534409838809** for deployment testing.
- Current repository deployment region: **us-west-2**.
- Before AWS writes, verify the caller with STS and inspect the target stacks.
  Profile names, local outputs, and historical examples are not account proof.
- This is an existing deployment. Use its discovered resources and reviewed
  configuration; the clean-account provision command is not the default here.
- Follow the current runbook in
  [infra/serverless-platform/README.md](infra/serverless-platform/README.md),
  including its predeployment audit. Keep deployable code account-portable.
- Preserve required tags, permissions boundaries, and retained data. Do not turn
  a deployment test into an unreviewed shared-bootstrap or production change.
- Fresh verification results belong in project memory; never store credentials,
  tokens, session payloads, or private user content there.

## Working conventions

- Frontend entry: `console/public/index.html`; main source:
  `console/public/modules/app.mjs`. Deployment owns `runtime-config.js`.
- Local console: `console/server.mjs`. Hosted APIs:
  `infra/serverless-platform/lambda/`. Check the implementation being changed;
  local JSON behavior does not prove hosted AWS behavior.
- **Post-deploy verification is mandatory and must happen on the real hosted
  console.** After every deploy that touches user-visible behavior, sign in to
  the deployed CloudFront console with a real persona and open every affected
  page (screenshot or equivalent evidence). Local mock-mode checks and
  grepping the deployed JS bundle do NOT count: the hosted console renders
  through different lambdas, data stores, and code paths, and has shipped
  broken while local looked fine. Do not report "deployed and working"
  without this evidence.
- Never reset or change a real user's password or other credentials to
  unblock verification. Ask the owner for the credential or for a test
  identity instead.
- Shared exports: `console/export-contract.mjs`, `console/export-composer.mjs`,
  `console/ci-templates/`, and hosted `lambda/journeys/`.
- Read [docs/API-GOTCHAS.md](docs/API-GOTCHAS.md) before writing API probes.
  Inspect handlers for current routes and schemas.
- Preserve unrelated working-tree changes and runtime stores. Keep edits focused.
- Run checks appropriate to the changed behavior. Root tests use `npm test`;
  infrastructure verification uses `npm run infra:verify` and
  `npm run serverless:verify`; browser tests live in `e2e/`.
- For documentation-only edits, verify references and consistency. Do not add
  tests that merely repeat prose.
- Real deployed resources (AgentCore runtimes, memories, KBs, registries) are
  the demo's substance. Do not replace them with fixtures, placeholders, or
  "illustrative" content — the owner requires real scenarios end to end.
- Test servers spawned by `console/*.test.mjs` must not pollute real runtime
  stores: the server honors `CONSOLE_DATA_DIR`; keep it that way.
- Deploys can reset drifted resources (e.g. Cognito client auth flows).
  Manual AWS fixes must also land in CDK or they will be overwritten.
- Update `agent.md` when the owner changes requirements; update project memory
  when implementation or observed deployment facts change. Do not promote an
  intended feature to “implemented” without evidence.
