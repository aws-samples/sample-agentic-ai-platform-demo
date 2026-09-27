import { budgetFail, budgetScope, evaluateProjectBudget } from "./budgets.mjs";
import { withBudgetDeadline } from "./budget-deadline.mjs";
import { createBudgetDelivery } from "./budget-delivery.mjs";

// Dependencies are constructed from server configuration, never event fields.
export function createBudgetRunner({ workspaceState, domainDirectory, budgetState, runnerState,
  usageProvider, publisher = null, destination = null, clock = Date.now } = {}) {
  if (typeof workspaceState?.listProjects !== "function" || typeof workspaceState?.getProject !== "function"
    || typeof domainDirectory?.listActiveDomains !== "function" || !budgetState || !runnerState
    || typeof usageProvider?.listInvocationUsageAggregates !== "function") throw new TypeError("Invalid budget runner.");
  const delivery = createBudgetDelivery({ budgetState, publisher, destination, clock });
  return async function run({ abortSignal } = {}) {
    const summary = { status: "COMPLETE", projects: 0, directoryPages: 0, alertPages: 0,
      crossed: 0, unknown: 0, errors: 0, deliveries: {} };
    return withBudgetDeadline(async signal => {
      const request = operation => withBudgetDeadline(operation, { abortSignal: signal });
      let checkpoint = await request(() => runnerState.claim());
      signal.throwIfAborted();
      if (!checkpoint) return { ...summary, status: "BUSY" };
      const advance = async (position, release = false) => {
        checkpoint = await request(() => runnerState.advance(checkpoint, position, release));
        signal.throwIfAborted();
        if (!checkpoint) budgetFail("CONFLICT");
      };
      const domains = await request(abortSignal => domainDirectory.listActiveDomains({ abortSignal }));
      signal.throwIfAborted();
      if (!Array.isArray(domains) || domains.length > 1000) budgetFail();
      const ids = domains.map(domain => budgetScope(domain.id, "validation").domainId).sort();
      if (new Set(ids).size !== ids.length) budgetFail();
      let domainIndex = checkpoint.position.domainId === null ? 0
        : ids.findIndex(id => id >= checkpoint.position.domainId);
      if (domainIndex < 0) domainIndex = ids.length;
      const seen = new Set();
      while (domainIndex < ids.length && summary.directoryPages < 10 && summary.projects < 10) {
        signal.throwIfAborted();
        const domainId = ids[domainIndex];
        const cursor = checkpoint.position.domainId === domainId ? checkpoint.position.projectCursor : null;
        const binding = JSON.stringify([domainId, cursor]);
        if (seen.has(binding)) budgetFail();
        seen.add(binding);
        const page = await request(abortSignal => workspaceState.listProjects({
          domainId, limit: 1, ...(cursor ? { cursor } : {}), abortSignal,
        }));
        signal.throwIfAborted();
        summary.directoryPages++;
        if (!Array.isArray(page?.items) || page.items.length > 1 || page.cursor === undefined) budgetFail();
        if (page.cursor !== null && JSON.stringify(page.cursor) === JSON.stringify(cursor)) budgetFail();
        const next = page.cursor === null
          ? { domainId: ids[domainIndex + 1] ?? null, projectCursor: null }
          : { domainId, projectCursor: page.cursor };
        // Commit traversal progress BEFORE work. A failed/hung project is retried
        // next sweep, rather than starving all later projects on every schedule.
        await advance(next);
        if (page.cursor === null) domainIndex++;
        for (const listed of page.items) {
          if (listed.domainId !== domainId) budgetFail();
          const scope = budgetScope(domainId, listed.id);
          summary.projects++;
          try {
            await withBudgetDeadline(async projectSignal => {
              // Re-read ACTIVE status from the authoritative project record.
              const project = await workspaceState.getProject({ ...scope, abortSignal: projectSignal });
              projectSignal.throwIfAborted();
              if (project === null || project.status !== "ACTIVE") return;
              if (project.domainId !== domainId || project.id !== scope.projectId) budgetFail();
              const config = await budgetState.getConfig(scope, { abortSignal: projectSignal });
              projectSignal.throwIfAborted();
              if (!config) return;
              let evaluation;
              try {
                evaluation = await withBudgetDeadline(abortSignal =>
                  evaluateProjectBudget({ config, usageProvider, now: clock(), abortSignal }),
                { abortSignal: projectSignal, timeoutMs: 2_000 });
              } catch {
                projectSignal.throwIfAborted();
                summary.errors++;
                // Unknown current usage does not suppress an earlier durable crossing.
                summary.unknown++;
              }
              projectSignal.throwIfAborted();
              if (evaluation?.status === "UNKNOWN") summary.unknown++;
              if (evaluation?.status === "CROSSED") {
                await budgetState.recordCrossing(config, evaluation, { abortSignal: projectSignal });
                projectSignal.throwIfAborted();
                summary.crossed++;
              }
              const saved = await runnerState.getCursor(scope);
              projectSignal.throwIfAborted();
              const cursor = saved?.cursor ?? undefined;
              const alerts = await budgetState.listAlerts(scope, cursor, { abortSignal: projectSignal });
              projectSignal.throwIfAborted();
              summary.alertPages++;
              // Persist one-record progress before a potentially ambiguous send.
              // On wrap, retries are still gated by the outbox's nextAttemptAt.
              const nextCursor = alerts.items.length > 1
                ? { pk: { S: `PROJECT_BUDGET#${domainId}#${scope.projectId}` }, sk: { S: `ALERT#${alerts.items[0].id}` } }
                : alerts.cursor;
              if (!await runnerState.saveCursor(scope, saved, nextCursor)) budgetFail("CONFLICT");
              projectSignal.throwIfAborted();
              if (alerts.items.length) {
                const item = await delivery.deliverAlert(alerts.items[0], { abortSignal: projectSignal });
                if (item) summary.deliveries[item.status] = (summary.deliveries[item.status] ?? 0) + 1;
              }
            }, { abortSignal: signal, timeoutMs: 8_000 });
          } catch (error) {
            signal.throwIfAborted();
            // Config conflicts and per-project failures don't block the sweep.
            // No retry inside this invocation; the next sweep revisits it.
            summary.errors++;
          }
        }
      }
      if (domainIndex < ids.length) summary.status = "CONTINUED";
      else await advance({ domainId: null, projectCursor: null });
      await advance(checkpoint.position, true);
      return summary;
    }, { abortSignal, timeoutMs: 20_000 });
  };
}
