import { createHash } from "node:crypto";
import { validateAggregateRequest, scopeDescriptors, encodeCursor, decodeCursor } from "./runtime.mjs";
import { createModelPriceBook } from "./model-prices.mjs";
import { createBudgetReader } from "./usage.mjs";
import { costJournalEnabled } from "../experience/journal-compatibility.mjs";

export const JOURNAL_USAGE_KEYS = [
  "source", "environment", "runCount", "runCountUnavailableReason", "acceptedDispatchCount",
  "knownEstimatedCostUsd", "pricingVersion", "pricingRevision",
  "priceSources", "updatedAt", "modelCoverage", "consistency", "windowBasis",
  "dispatchBoundary", "succeededDispatchCount", "failedDispatchCount", "unresolvedDispatchCount",
  "legacyRecordCount", "pricedDispatchCount",
];
export const NATIVE_USAGE_KEYS = [
  "runBoundary", "knownRunCount", "succeededRunCount", "failedRunCount", "unresolvedRunCount",
  "pricedAttemptCount", "pricingRevisions",
];

function unavailable() {
  throw new Error("Invocation journal aggregate is unavailable.");
}

function aggregate(records, request, book, descriptor) {
  const result = {
    ...descriptor, invocationCount: null, inputTokens: 0, outputTokens: 0,
    estimatedCostUsd: 0, knownEstimatedCostUsd: 0, runCount: null,
    runCountUnavailableReason: "actual-execution-start-unavailable", acceptedDispatchCount: 0,
    source: "experience-invocation-journal", environment: "PRODUCTION",
    pricingVersion: null, pricingRevision: book.fingerprint, priceSources: [], updatedAt: null,
    modelCoverage: "complete", consistency: "eventual",
    windowBasis: "dispatch-start-cohort", dispatchBoundary: "accepted-runtime-dispatch",
    succeededDispatchCount: 0, failedDispatchCount: 0, unresolvedDispatchCount: 0,
    legacyRecordCount: 0, pricedDispatchCount: 0,
  };
  const sources = new Map();
  let unknown = false;
  for (const record of records) {
    const unclassified = record.lifecycle === null
      || (record.lifecycle.startedAt === null && record.runtimeStatus === "SUCCEEDED");
    const at = record.lifecycle?.startedAt ?? record.accounting?.execution?.startedAt;
    // Old reservations may cross a window without a known execution start.
    // An overlapping possible execution interval cannot establish zero runs.
    if (unclassified && at == null) {
      if (record.createdAt >= request.endTime
        || (record.completedAt !== null && record.completedAt < request.startTime)) continue;
    } else if ((at ?? record.createdAt) < request.startTime || (at ?? record.createdAt) >= request.endTime) continue;
    const updatedAt = record.completedAt ?? record.createdAt;
    if (result.updatedAt === null || updatedAt > result.updatedAt) result.updatedAt = updatedAt;
    if (unclassified) {
      result.legacyRecordCount += 1;
      unknown = true;
      continue;
    }
    // This marker precedes SDK send; it cannot establish actual agent starts.
    if (record.lifecycle.startedAt === null) continue;
    result.acceptedDispatchCount += 1;
    if (record.phase === "STARTED") result.unresolvedDispatchCount += 1;
    else if (record.runtimeStatus === "FAILED") result.failedDispatchCount += 1;
    else if (record.runtimeStatus === "SUCCEEDED") result.succeededDispatchCount += 1;
    else unavailable();
    const cost = record.accounting === null ? null : book.estimate(record.accounting, record.lifecycle.region);
    if (cost?.priceSource) sources.set(cost.priceSource.id, cost.priceSource);
    if (cost?.estimatedCostUsd != null) {
      result.knownEstimatedCostUsd += cost.estimatedCostUsd;
      result.pricedDispatchCount += 1;
    } else unknown = true;
    for (const key of ["inputTokens", "outputTokens"]) {
      if (result[key] === null || record.accounting === null) result[key] = null;
      else result[key] += record.accounting.usage[key];
    }
  }
  if (result.legacyRecordCount > 0) {
    result.acceptedDispatchCount = null;
    result.inputTokens = null;
    result.outputTokens = null;
  }
  result.estimatedCostUsd = unknown ? null : result.knownEstimatedCostUsd;
  result.modelCoverage = unknown ? (result.pricedDispatchCount > 0 ? "partial" : "unavailable") : "complete";
  result.priceSources = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  result.pricingVersion = result.priceSources.length === 1 ? result.priceSources[0].id : null;
  for (const key of ["inputTokens", "outputTokens", "acceptedDispatchCount"]) {
    if (result[key] !== null && !Number.isSafeInteger(result[key])) unavailable();
  }
  if (!Number.isFinite(result.knownEstimatedCostUsd)) unavailable();
  return result;
}

function aggregateNative(records, request, book, descriptor) {
  const result = {
    ...aggregate([], request, book, descriptor),
    windowBasis: "usage-occurrence-and-execution-start",
    runBoundary: "runtime-durable-start", runCount: 0, runCountUnavailableReason: null,
    knownRunCount: 0, succeededRunCount: 0, failedRunCount: 0, unresolvedRunCount: 0,
    pricedAttemptCount: 0,
    pricingRevisions: [],
  };
  const within = at => at !== null && at >= request.startTime && at < request.endTime;
  let unknownCost = false;
  const sources = new Map();
  const revisions = new Set();
  for (const record of records) {
    if (within(record.lifecycle?.startedAt ?? null)) {
      result.acceptedDispatchCount += 1;
      if (record.phase === "STARTED") result.unresolvedDispatchCount += 1;
      else if (record.runtimeStatus === "FAILED") result.failedDispatchCount += 1;
      else result.succeededDispatchCount += 1;
    }
    const execution = record.nativeExecution;
    if (execution == null) {
      // Mixed rollout: an overlapping uninstrumented reservation cannot prove
      // absence of an actual start or of billable usage.
      if (record.createdAt < request.endTime
        && (record.completedAt === null || record.completedAt >= request.startTime)) {
        result.legacyRecordCount += 1;
        unknownCost = true;
        result.inputTokens = null;
        result.outputTokens = null;
      }
      continue;
    }
    if (execution.startedAt === null) continue;
    const terminal = execution.terminal;
    if (within(execution.startedAt)) {
      result.knownRunCount += 1;
      if (terminal?.status === "SUCCEEDED") result.succeededRunCount += 1;
      else if (terminal?.status === "FAILED") result.failedRunCount += 1;
      else result.unresolvedRunCount += 1;
    }
    const updatedAt = terminal?.completedAt ?? execution.usage?.occurredAt ?? execution.startedAt;
    if (result.updatedAt === null || updatedAt > result.updatedAt) result.updatedAt = updatedAt;
    const event = execution.usage;
    if (event === null) {
      if (execution.startedAt < request.endTime
        && (terminal === null || terminal.completedAt >= request.startTime)) {
        unknownCost = true;
        result.inputTokens = null;
        result.outputTokens = null;
      }
      continue;
    }
    if (!within(event.occurredAt)) continue;
    // Price is sealed by Runtime with the usage event. A new Operations price
    // book cannot silently reprice historical calls, including failed runs.
    const cost = event.price;
    revisions.add(cost.pricingRevision);
    if (cost.priceSource) {
      const previous = sources.get(cost.priceSource.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(cost.priceSource)) unavailable();
      sources.set(cost.priceSource.id, cost.priceSource);
    }
    if (cost.estimatedCostUsd !== null) {
      result.knownEstimatedCostUsd += cost.estimatedCostUsd;
      result.pricedAttemptCount += 1;
    } else unknownCost = true;
    for (const key of ["inputTokens", "outputTokens"]) {
      if (result[key] !== null) result[key] += event.observation.usage[key];
    }
  }
  result.runCount = result.legacyRecordCount ? null : result.knownRunCount;
  result.runCountUnavailableReason = result.legacyRecordCount ? "actual-execution-start-unavailable" : null;
  result.estimatedCostUsd = unknownCost ? null : result.knownEstimatedCostUsd;
  result.modelCoverage = unknownCost ? (result.pricedAttemptCount ? "partial" : "unavailable") : "complete";
  result.priceSources = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
  result.pricingVersion = result.priceSources.length === 1 ? result.priceSources[0].id : null;
  result.pricingRevisions = [...revisions].sort();
  result.pricingRevision = createHash("sha256").update(JSON.stringify(result.pricingRevisions)).digest("hex");
  if (!Number.isFinite(result.knownEstimatedCostUsd)
    || ["knownRunCount", "inputTokens", "outputTokens"].some(key =>
      result[key] !== null && !Number.isSafeInteger(result[key]))) unavailable();
  return result;
}

export function createJournalUsageProvider({ journal, priceBook, budgets = {}, compatibility, nativeExecution = false } = {}) {
  const enabled = costJournalEnabled(compatibility);
  if (!journal || typeof journal.listByProject !== "function" || typeof nativeExecution !== "boolean") {
    throw new TypeError("Invocation journal reader is invalid.");
  }
  const book = createModelPriceBook(priceBook);
  return Object.freeze({
    listBudgets: createBudgetReader(budgets),
    async listInvocationUsageAggregates(input) {
      if (!enabled) unavailable();
      const request = validateAggregateRequest(input, { multiDomainProjects: true });
      const descriptors = scopeDescriptors(request.scope);
      const binding = createHash("sha256").update(JSON.stringify({
        source: "experience-invocation-journal", priceBook: book.fingerprint, nativeExecution,
        scope: request.scope, startTime: request.startTime, endTime: request.endTime, limit: request.limit,
      })).digest("hex");
      const offset = decodeCursor(request.cursor, binding, descriptors.length);
      const items = [];
      let pageCount = 0;
      for (const descriptor of descriptors.slice(offset, offset + request.limit)) {
        const records = [];
        const runIds = new Set();
        const projects = request.scope.projects.filter(project => descriptor.scopeType !== "project"
          || (project.domainId === descriptor.domainId && project.projectId === descriptor.projectId));
        for (const project of projects) {
          let cursor;
          const cursors = new Set();
          do {
            // Bound total work across the authorized page, including empty
            // filtered GSI pages. Never return a truncated numeric aggregate.
            if (++pageCount > 100) unavailable();
            if (request.abortSignal?.aborted) {
              throw Object.assign(new Error("Journal read aborted."), { name: "AbortError" });
            }
            const page = await journal.listByProject({
              ...project, ...(cursor ? { cursor } : {}),
              ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
            });
            if (!page || !Array.isArray(page.items) || page.items.length > 100 || page.cursor === undefined) unavailable();
            for (const record of page.items) {
              if (record.domainId !== project.domainId || record.projectId !== project.projectId
                || typeof record.runId !== "string" || runIds.has(record.runId)) unavailable();
              runIds.add(record.runId);
              records.push(record);
            }
            cursor = page.cursor;
            if (cursor !== null) {
              const encoded = JSON.stringify(cursor);
              if (cursors.has(encoded)) unavailable();
              cursors.add(encoded);
            }
          } while (cursor !== null);
        }
        items.push((nativeExecution ? aggregateNative : aggregate)(records, request, book, descriptor));
      }
      const nextOffset = offset + request.limit;
      return { items, cursor: nextOffset < descriptors.length ? encodeCursor(nextOffset, binding) : null };
    },
  });
}
