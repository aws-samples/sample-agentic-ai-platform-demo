import { randomUUID } from "node:crypto";
import { budgetDestination, budgetFail, budgetScope } from "./budgets.mjs";
import { withBudgetDeadline } from "./budget-deadline.mjs";

const TERMINAL = new Set(["PROVIDER_ACCEPTED", "FAILED", "EXHAUSTED", "SUPERSEDED"]);
const transient = error => error?.retryable === true || ["AbortError", "TimeoutError", "TimeoutException",
  "Throttled", "Throttling", "KMSThrottling", "KMSThrottlingException",
  "ThrottlingException", "TooManyRequestsException", "ServiceUnavailable", "InternalError", "KMSInternalError",
  "ECONNRESET", "ETIMEDOUT"].includes(error?.name)
  || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(error?.code)
  || error?.$metadata?.httpStatusCode === 429 || error?.$metadata?.httpStatusCode >= 500;

// Publish only to the exact deployment-approved destination.
export function createBudgetDelivery({ budgetState, publisher = null, destination = null, clock = Date.now } = {}) {
  if (!budgetState || !budgetDestination(destination) || typeof clock !== "function"
    || !(publisher === null || typeof publisher.publish === "function")) throw new TypeError("Budget delivery is invalid.");
  async function deliver(alert, abortSignal) {
    abortSignal.throwIfAborted();
    const now = clock();
    if (!Number.isSafeInteger(now) || now < Date.parse(alert.updatedAt)) budgetFail();
    const timestamp = new Date(now).toISOString();
    const change = (fields, current = false) => budgetState.saveAlert(alert, {
      ...alert, ...fields, revision: alert.revision + 1, updatedAt: timestamp,
    }, current, { abortSignal });
    if (TERMINAL.has(alert.status)) return alert;
    if (alert.status === "SENDING" && Date.parse(alert.leaseUntil) > now) return alert;
    const config = await budgetState.getConfig(alert, { abortSignal });
    abortSignal.throwIfAborted();
    if (!config || config.version !== alert.configVersion) {
      return change({ status: "SUPERSEDED", leaseToken: null, leaseUntil: null, nextAttemptAt: null });
    }
    let unavailable;
    if (alert.destination === null) unavailable = "UNCONFIGURED";
    else if (alert.destination !== destination) unavailable = "DESTINATION_MISMATCH";
    else if (publisher === null) unavailable = "PUBLISHER_UNAVAILABLE";
    if (unavailable) {
      return alert.status === unavailable ? alert : change({
        status: unavailable, leaseToken: null, leaseUntil: null, nextAttemptAt: null,
      });
    }
    if (alert.attempts >= 3) return change({ status: "EXHAUSTED", leaseToken: null, leaseUntil: null, nextAttemptAt: null });
    if (alert.nextAttemptAt !== null && Date.parse(alert.nextAttemptAt) > now) return alert;
    const claimed = await change({
      status: "SENDING", attempts: alert.attempts + 1, leaseToken: randomUUID(),
      leaseUntil: new Date(now + 30_000).toISOString(), nextAttemptAt: null,
    }, true);
    if (claimed === null) return null;
    abortSignal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    abortSignal.addEventListener("abort", onAbort, { once: true });
    let timeout;
    let outcome;
    try {
      const accepted = await Promise.race([
        Promise.resolve().then(() => publisher.publish({
          destination: claimed.destination,
          idempotencyKey: claimed.id,
          message: JSON.stringify({ alertId: claimed.id, ...claimed.evaluation,
            notice: "Partial model estimate; provider acceptance is not recipient receipt." }),
          abortSignal: AbortSignal.any([controller.signal, abortSignal]),
        })),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error("Budget publish timed out."), { name: "TimeoutError" }));
          }, 5_000);
        }),
      ]);
      if (typeof accepted?.MessageId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(accepted.MessageId)) {
        throw Object.assign(new Error("Budget publish acknowledgement is unknown."), { retryable: true });
      }
      outcome = { status: "PROVIDER_ACCEPTED", providerMessageId: accepted.MessageId, nextAttemptAt: null };
    } catch (error) {
      const retryable = transient(error);
      outcome = { status: !retryable ? "FAILED" : claimed.attempts >= 3 ? "EXHAUSTED" : "RETRY",
        nextAttemptAt: retryable && claimed.attempts < 3
          ? new Date(clock() + 60_000 * 2 ** (claimed.attempts - 1)).toISOString() : null };
    } finally {
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", onAbort);
    }
    abortSignal.throwIfAborted();
    // If the process/storage fails after provider acceptance the lease permits
    // retry. Delivery is at least once; even the stable key cannot promise SNS
    // or recipient deduplication. A receipt is never inferred from MessageId.
    return budgetState.saveAlert(claimed, {
      ...claimed, ...outcome, revision: claimed.revision + 1,
      updatedAt: new Date(clock()).toISOString(), leaseToken: null, leaseUntil: null,
    }, false, { abortSignal });
  }
  return Object.freeze({
    deliverAlert(alert, { abortSignal, timeoutMs = 6_000 } = {}) {
      return withBudgetDeadline(signal => deliver(alert, signal), { abortSignal, timeoutMs });
    },
    async deliverProject(scope, cursor, { abortSignal, timeoutMs = 8_000, maxAlerts = 10 } = {}) {
      budgetScope(scope.domainId, scope.projectId);
      if (!Number.isInteger(maxAlerts) || maxAlerts < 1 || maxAlerts > 10) throw new TypeError("Invalid delivery bound.");
      return withBudgetDeadline(async signal => {
        const page = await budgetState.listAlerts(scope, cursor, { abortSignal: signal });
        signal.throwIfAborted();
        const items = [];
        for (const alert of page.items.slice(0, maxAlerts)) {
          signal.throwIfAborted();
          items.push(await deliver(alert, signal));
        }
        const last = page.items[maxAlerts - 1];
        return { items: items.filter(Boolean), cursor: page.items.length > maxAlerts
          ? { pk: { S: `PROJECT_BUDGET#${scope.domainId}#${scope.projectId}` }, sk: { S: `ALERT#${last.id}` } }
          : page.cursor };
      }, { abortSignal, timeoutMs });
    },
  });
}
