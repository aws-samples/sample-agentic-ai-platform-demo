# Unified frontend source on the cost-attribution branch

## Source selection

The accepted UI is the console restored by main `38b31309793b6b65bb1e9d4f6a07ea013ae1bc44` (console from `69458e7`). This integration does not merge the divergent cleanup branch or change backend/infra layout. It selectively maps reviewed frontend modules from `3cd2538e8ca95a71af2b04f9c4104456ce94fcb6:apps/console/public` into **`console/public`**, this branch's existing deployment input, then integrates the bounded modular cost contract.

The accepted sidebar entries and shell homes are preserved, with the demo visibility exception below. Builder additionally has the hosted governance drill-down. The light palette, topbar, sidebar and platform/domain Build Workspace split remain. YAML import, memory-plan preview, eval-gate preview, registry, approval/publication and project workspace functions remain. Of 196 accepted named functions, 195 retain their names; the old signed-out reset is replaced by the session-epoch-aware `resetSignedOutState`/`replaceSession` mechanism covered by auth tests.

### Demo visibility (2026-09-14)

Platform Monitoring and Observability are temporarily hidden from the demo.
Their sidebar entries, page cross-links, domain/fleet monitoring buttons and
workspace Traces shortcut are removed. Legacy page state returns to the
persona's shell home; a saved workspace `obs` tab returns to Fleet.

Operators can inspect telemetry in CloudWatch. This presentation change retains
the monitoring APIs, telemetry collection and underlying page implementations;
it does not add a CloudWatch integration or change authorization.

The cleanup branch had shortened/reordered guided demo steps. Those changes were **not retained**: all four accepted journey objects retain their steps, order, descriptions and required surfaces. Added role restrictions keep each journey within its eligible persona. Sessions and access requests remain in the User journey, mapped into Overview in the accepted shell.

`auth-client.mjs`, `auth-core.mjs` and `demo-context.mjs` are byte-identical to accepted main. Real Hosted UI PKCE, state checking, callback exchange, bearer headers, `/me` hydration, session cleanup and signout are not replaced by a mock login. Operator role/domain controls use backend-projected roles and rehydrate `/me`; frontend role choice is not backend authorization. No runtime config is changed.

## Actual build and deployment input

- HTML: `console/public/index.html`
- Entry module: `console/public/modules/app.mjs`
- Styles: `console/public/styles/app.css`
- Hosted coordinator: `console/public/main-ui-build.mjs`
- Backend compatibility adapter: `console/public/main-ui-compat.mjs`
- Cost contract/helper: `console/public/cost-view.mjs`
- Project USD editor/controller: `console/public/modules/project-budget.mjs`
- Auth: `console/public/auth-client.mjs`, `auth-core.mjs`, `demo-context.mjs`
- Standalone static artifact: `node console/build-frontend.mjs <new-output-directory>`

The builder copies the actual public source byte-for-byte and emits `frontend-manifest.json` with hashes and the entry/module names. It refuses an existing destination. It is not a bundler or deployment command. There are no frontend package installs. `runtime-config.js` is intentionally excluded: the existing `PlatformWebStack` packages `console/public` using `Source.asset` and then generates Cognito runtime config using `Source.data`. A raw artifact without that deployment-owned config is **not a complete hosted deployment**.

The self-contained existing `guardrail-chain.mjs` stays here. Cleanup's re-export into `src/platform/` was not copied; that directory does not exist on this branch. Fonts and auth source remain. The cost module is imported by both the actual app and actual adapter, and all local module imports resolve inside the packaged files. No inert `apps/console` duplicate is added.

## Cost behavior

Admin Cost, Domain dashboard and Project Cost use the integrated module. Complete pagination precedes totals. The adapter preserves scope/window/items and accounting metadata. Platform/domain/project aggregates cannot be added together. Project selection uses both domain and project; an aggregate-only API response explicitly cannot provide project detail. Missing costs/rates/runs remain unknown. USD budgets are not token budgets. Native run KPIs require durable Runtime starts and the versioned journal boundaries; accepted dispatch counts alone cannot enable a run KPI. Tiny positive costs remain visible at six decimals or scientific precision. Known subtotal is not a full total. Metadata is text-escaped; the UI does not infer prices or allocate shared costs.

The project budget slice now requests `groupBy=project` from `/api/costs` for the hosted views. It shows attributed domain/project model costs and separate unknown unallocated shared/platform cost. The default backend aggregation contract stays compatible. Project rows receive durable monthly USD config; platform/domain legacy environment budget settings remain separate. The accepted main Builder project picker/workspace and Lead Projects page reach the hosted project setup form. Project details/Cost tabs use the same authorized GET editor and persisted save/read-back controller. See [project-budget-ui.md](project-budget-ui.md) for permission, conflict, partial setup and exact didi handoff details.

## Verification

Use Node 22:

```sh
node --test console/*.test.mjs
node console/build-frontend.mjs /path/to/new/frontend-public
```

`frontend-artifact.test.mjs` compares fixed accepted navigation/journey evidence, verifies auth Git blob identities, builds the actual files, checks every byte/hash and relative import, and verifies the existing CDK input/config split. `modular-cost.test.mjs` executes the real adapter and actual app functions with synthetic API/DOM fixtures. Existing auth, demo, persona and cost tests are retained with module source readers and explicit contract metadata; incomplete cost pages now reject rendering rather than show a partial total. No test assertion is removed to conceal a runtime failure.

## Explicit boundaries and remaining work

- This is source/artifact integration, **not a dev deployment or live journey acceptance**. Didi owns deployment, URL delivery and authenticated browser verification. Parent coordinates branch/file ownership.
- The existing local `console/server.mjs` has a fixed static whitelist and does not serve the newly extracted module/CSS/coordinator paths. It is intentionally unchanged because backend/server edits are outside this worker's ownership. CloudFront/S3 packaging is independent of that local whitelist. If local mock-server UI support is required, its owner must add the exact static paths with correct MIME and path safety, or use a separate static frontend server. Do not call the legacy local server UI accepted yet.
- Hosted runtime config must be generated for the target Cognito app/client; never upload the tracked mock runtime config over it. HTML and every static source file, including the new budget module, must come from the same reviewed SHA.
- Four-arc E2E, actual independent approver identity, two-project real runs/cost isolation, tools allow/deny, budget notification delivery, evaluation/trace linkage, backend route coverage and compatible reader rollout still require peer verification. Frontend tests do not prove those services are deployed or available.

## Well-Architected review

- **Security:** preserved real auth/PKCE and backend capability checks; escaped cost metadata, no credentials/config changes. Authenticated E2E remains unverified.
- **Reliability:** import closure, exact artifact/source hashes, pagination/unknown-state tests; legacy local static-server gap explicitly outstanding.
- **Performance:** local static ES modules and fonts, no added external dependency; browser navigation performance not benchmarked.
- **Cost:** measured model-only estimate boundaries retained, no fabricated full totals or prices; no cloud inference or deployment performed here.
- **Operational excellence:** one real frontend input on the shared feature branch, immutable provenance, builder manifest, explicit deployment ownership and acceptance limits.
- **Sustainability:** reuse existing modules/fonts, no duplicate application tree or new infrastructure; no measured sustainability claim.

### Observed integration checks and known downstream test gap

Node 22 console suite: 292/292 passed before final fixed-SHA rerun. All 10 public ES modules pass syntax checks. Static artifact contains 30 source files plus a hash manifest; generated runtime config remains separate. Local browser smoke was blocked by browser navigation policy; no bypass was attempted.

Read-only dev observation during this task: index was a 454,310-byte inline module document, SHA256 `07bcd0021e234416fdda93c06521c3594a32511e32783e605967cbf0ce6f8baf`, no external script sources, and not byte-identical to accepted main, feature baseline, or cleanup index. Requests for `auth-client.mjs`, `modules/app.mjs`, `styles/app.css`, and `cost-view.mjs` returned 403. Browser requested `/api/login-users` and received 404. This is an observed wrong artifact/auth-input boundary, not a diagnosis of all dev infrastructure or the user's authenticated session.

The unchanged backend file `infra/serverless-platform/test/native-execution.test.mjs` has **one incompatible helper fixture** at line 363: `{ok:true,cursor:null,items:[aggregate]}` omits the actual HTTP envelope's resource, scope, window, and descriptor metadata. The strict frontend helper correctly refuses this incomplete shape. Its test at line 348 fails (expected priced KPI vs null). The remaining 26 tests pass, including real Operations -> two-project/direct-Converse helper results and Admin/Lead aggregation. Do not relax frontend scope validation to make the incomplete fixture pass. Backend test owner must supply the actual versioned API envelope for that fixture; no backend file was changed here. This is **not an all-repository-green claim**.
