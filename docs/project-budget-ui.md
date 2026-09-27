# Project USD budget UI and durable read-back

This bounded source slice connects the existing project budget writer to the actual `console/public/modules/app.mjs` console. It adds a read-only budget GET, durable project budget enrichment for `/api/costs`, and an opt-in authorized project cost breakdown. It does not deploy routes, send notifications, query Cost Explorer, or complete the four demo arcs.

## User path

- Builder: My Projects and the workspace provide **Create project & review USD budget**. An empty hosted workspace opens project setup. Project creation commits through the existing `/api/projects` boundary; the next step loads the budget from Operations. Builders with existing owner/member permission can read it and see plain guidance to ask an authorized admin or domain lead. No budget request/approval workflow or Builder write elevation is implemented.
- Lead: the accepted Domain Console → Projects page uses the hosted project list/create path and opens the same budget step. Admins/leads can edit only when the authenticated budget GET returns `access.canEdit: true`.
- Existing project: **Cost & Budget** is reachable from the hosted project list, domain/platform cost rows, project details and the workspace Cost tab. Owner, effective role/access, ACTIVE project status, persisted config/version, monthly preview, actual native-start run metric and an authorized agent list are displayed.
- The ordinary Agent build flow is preserved. Project setup is independently available; this slice does not change automatic project/Agent creation internals, model controls or delivery workflows.

The form sends positive finite `monthlyLimitUsd` (at most 1 billion USD), integer `thresholdPercent` (1–100), `currency: USD`, `period: CALENDAR_MONTH_UTC` and `expectedVersion`. It uses the existing authenticated request transport and stable request ID for a retry of the same uncertain mutation. No budget is stored in localStorage.

After POST acknowledges a version, the controller issues GET and verifies the persisted version/values before saying “Saved and verified.” A failed GET is explicitly unconfirmed and offers refresh without another write. A 409 reloads the persisted version, retains the unsaved draft and requires deliberate review/resubmission. A failed write never replaces the persisted display with the draft. Failed initial reads disable editing. Session/scope changes invalidate mounted work.

Project creation and budget saving are separate transactions. The post-create panel explicitly says setup is incomplete until a budget save is verified. A read/save failure leaves the project created and provides retry/refresh. “Continue to Build (budget may be pending)” does not claim the budget is configured. A Builder may continue while an authorized lead/admin handles budget configuration.

## Three levels and measurement rules

| Level | Implemented presentation | Unknown/unsupported information |
| --- | --- | --- |
| Platform | Sum of disjoint authorized project model estimates, grouped by domain; separate unallocated shared/platform cost field | Full platform cost and unallocated shared dollars remain N/A without a supported attributed/shared source. Account-wide CE spend/forecast is separate Admin context and never substituted. |
| Domain | Project rows with selected-window model consumption, persisted monthly USD budget/version/threshold and a link to project preview/edit | Remaining full-project budget and monthly alert status remain unknown until supported monthly evidence exists; partial model coverage cannot assert “under budget.” |
| Project | Same selected-window cost contract, started native agent runs, per-run model estimate, token usage, provenance/freshness, authorized agents and monthly budget form/preview | Shared Runtime, Gateway, memory, tools, evaluation and unobserved attempts are excluded. Full cost/remaining/recipient receipt are not inferred. |

Selected cost rows share the same UTC half-open window, authorized scope and USD currency. The monthly budget preview separately labels UTC month bounds, whole-minute observation cutoff and last update. It reuses `evaluateProjectBudget`; it does not divide a rolling 24-hour cost by a monthly budget to invent utilization or forecast. Below-threshold partial coverage is INCOMPLETE; absent/stale pricing/history is UNKNOWN; a valid known lower bound can be CROSSED.

Domain totals sum project rows exactly once. Platform/domain aggregates cannot be mixed into that sum. Shared Runtime is neither assigned to every project nor added twice. Unsupported components stay null. Tiny positive costs remain visible at six decimals or scientific precision. Usage freshness is disclosed against the response window; a recent timestamp is not a completeness watermark. Token allowances stay separate from USD budgets.

## Backend and deployment-owner handoff

API details and existing writer/outbox semantics are in [project-budget-alerts.md](project-budget-alerts.md).

1. Didi owns the held stack/state files. Add `GET /api/operations/project-budgets` to `operationsIntegration` with the existing JWT authorizer and corresponding Operations Lambda invoke permission. The previously implemented POST writer and POST evaluate routes also still need activation. Use exact method/path suffixes `GET/api/operations/project-budgets`, `POST/api/operations/project-budgets`, `POST/api/operations/project-budgets/evaluate` under the existing API/stage ARN convention. Do not send budget GET to Workspace or the legacy mock server.
2. On the existing state table, grant `dynamodb:GetItem`, `Query`, `PutItem`, `ConditionCheckItem` restricted to `PROJECT_BUDGET#*` LeadingKeys, as described in the alert contract. GET and cost enrichment require consistent `GetItem`. Existing `PROJECT#*` reads support authoritative membership lookup. No new table/index or workspace-state schema is required.
3. `/api/costs?groupBy=project` uses the existing GET route. Production must inject `createProjectBudgetState` and the existing native journal provider. An unavailable state table/IAM causes an explicit failed read, not a legacy configuration fallback. Preserve journal reader/writer compatibility and sealed pricing configuration.
4. Package `console/public` from the reviewed revision, including `modules/project-budget.mjs`, `modules/app.mjs`, `cost-view.mjs`, existing adapters, styles and Cognito companions. Use a fresh `console/build-frontend.mjs` output and compare its hashes. Generate target `runtime-config.js` separately; never upload tracked mock config over Cognito config.
5. Verify request latency with the deployed bounds: Operations HTTP source deadline remains 1.5 seconds, API integration 9 seconds and Lambda 10 seconds at the held baseline. GET can perform a bounded monthly preview (at most two journal aggregate requests); a cost page can read up to 50 config records. Test realistic scope/page sizes before acceptance. A separately bounded publisher/runner is still required for delivery.
6. Read back deployed artifacts and real persisted GET values with authorized lead/admin and Builder identities. Test denied/foreign/archived scopes, same-slug cross-domain isolation, optimistic conflict, failed save and post-create partial setup, refresh/new session, and two-project native run/cost precision. Confirm Cognito callback/signout and the accepted layout/journeys. Notification delivery/recipient receipt and all four end-to-end arcs remain independent acceptance work.

## Test boundary

`console/project-budget.test.mjs` exercises the exported controller, validation, rendering and save/read-back state machine. `console/modular-cost.test.mjs` executes actual app functions with DOM-light fixtures. `operations-budget-read.test.mjs` exercises the real identity projection, authorizer, handler, journal provider and durable state adapter using synthetic DynamoDB commands, including a round trip through the actual frontend controller and cost adapter. Tests do not establish browser/E2E, deployed IAM, real DynamoDB persistence or recipient receipt.
