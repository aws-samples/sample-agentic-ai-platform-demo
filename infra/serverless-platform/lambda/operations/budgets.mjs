import { createHash } from "node:crypto";
import { OperationsServiceError } from "./service.mjs";
import { withBudgetDeadline } from "./budget-deadline.mjs";

const DAY = 86_400_000;
const MINUTE = 60_000;
export const budgetHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const budgetFail = (code = "OPERATIONS_UNAVAILABLE") => { throw new OperationsServiceError(code); };
export const budgetInstant = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
export const budgetExact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable === true && Object.hasOwn(field, "value");
  });
const subject = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value);
const requestId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value);
const nonnegative = value => Number.isFinite(value) && value >= 0;
export const budgetDestination = value => value === null || (typeof value === "string"
  && /^arn:aws(?:-us-gov|-cn)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/.test(value));

export function budgetScope(domainId, projectId) {
  if (typeof domainId !== "string" || domainId.length > 64 || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(domainId)
    || typeof projectId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) budgetFail("INVALID_REQUEST");
  return { domainId, projectId };
}

export function validBudgetConfig(value) {
  if (!budgetExact(value, ["schemaVersion", "domainId", "projectId", "version", "currency", "period",
    "monthlyLimitUsd", "thresholdPercent", "destination", "updatedAt", "updatedBy", "requestId"])) return false;
  try { budgetScope(value.domainId, value.projectId); } catch { return false; }
  return value.schemaVersion === 1 && Number.isSafeInteger(value.version) && value.version > 0
    && value.currency === "USD" && value.period === "CALENDAR_MONTH_UTC"
    && Number.isFinite(value.monthlyLimitUsd) && value.monthlyLimitUsd > 0 && value.monthlyLimitUsd <= 1e9
    && Number.isInteger(value.thresholdPercent) && value.thresholdPercent >= 1 && value.thresholdPercent <= 100
    && budgetDestination(value.destination) && budgetInstant(value.updatedAt)
    && subject(value.updatedBy) && requestId(value.requestId);
}

// Public configuration deliberately excludes the notification destination.
export function publicProjectBudget(config) {
  if (config === null) return null;
  if (!validBudgetConfig(config)) budgetFail();
  const { destination, ...budget } = config;
  return budget;
}

export function budgetWindow(now) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) budgetFail();
  const date = new Date(now);
  return {
    startTime: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(),
    endTime: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(),
    evaluatedThrough: new Date(Math.floor(now / MINUTE) * MINUTE).toISOString(),
    timezone: "UTC", interval: "[start,end)",
  };
}

export function budgetAlertId(config, window) {
  return budgetHash([config.domainId, config.projectId, config.version,
    window.startTime, window.endTime, config.thresholdPercent]);
}

function validPriceSource(source, now) {
  return source && typeof source.id === "string" && source.id.length > 0 && source.id.length <= 512
    && typeof source.url === "string" && source.url.length <= 4096 && source.url.startsWith("https://")
    && ["retrievedAt", "effectiveFrom", "effectiveTo"].every(key => budgetInstant(source[key]))
    && source.effectiveFrom < source.effectiveTo
    && Date.parse(source.retrievedAt) <= now && now - Date.parse(source.retrievedAt) <= 30 * DAY;
}

export function validBudgetEvaluation(value) {
  if (!budgetExact(value, ["schemaVersion", "domainId", "projectId", "configVersion", "status",
    "thresholdPercent", "thresholdUsd", "currency", "basis", "knownEstimatedCostUsd", "estimatedCostUsd",
    "runCount", "costPerRunUsd", "source", "environment", "window", "windowBasis", "asOf", "updatedAt",
    "coverage", "completeness", "pricing", "reasons"])) return false;
  try {
    budgetScope(value.domainId, value.projectId);
    if (!budgetInstant(value.asOf)
      || JSON.stringify(value.window) !== JSON.stringify(budgetWindow(Date.parse(value.asOf)))) return false;
  } catch { return false; }
  return value.schemaVersion === 1 && Number.isSafeInteger(value.configVersion) && value.configVersion > 0
    && ["CROSSED", "UNKNOWN", "INCOMPLETE"].includes(value.status)
    && Number.isInteger(value.thresholdPercent) && value.thresholdPercent >= 1 && value.thresholdPercent <= 100
    && Number.isFinite(value.thresholdUsd) && value.thresholdUsd > 0
    && value.currency === "USD" && value.basis === "estimate"
    && (value.knownEstimatedCostUsd === null || nonnegative(value.knownEstimatedCostUsd))
    && (value.estimatedCostUsd === null || (nonnegative(value.estimatedCostUsd)
      && value.estimatedCostUsd === value.knownEstimatedCostUsd))
    && (value.runCount === null || (Number.isSafeInteger(value.runCount) && value.runCount >= 0))
    && value.costPerRunUsd === (value.estimatedCostUsd !== null && value.runCount > 0
      ? value.estimatedCostUsd / value.runCount : null)
    && (value.status !== "CROSSED" || (value.knownEstimatedCostUsd !== null
      && value.knownEstimatedCostUsd >= value.thresholdUsd && value.pricing?.valid === true))
    && value.source === "experience-invocation-journal" && value.environment === "PRODUCTION"
    && value.windowBasis === "usage-occurrence-and-execution-start"
    && (value.updatedAt === null || (budgetInstant(value.updatedAt) && value.updatedAt <= value.asOf))
    && budgetExact(value.coverage, ["project", "included", "excluded"]) && value.coverage.project === "partial"
    && JSON.stringify(value.coverage.included) === '["retained-provider-model-usage"]'
    && JSON.stringify(value.coverage.excluded) === '["unobserved-attempts","runtime","gateway","memory","tools","evaluation","shared"]'
    && ["unavailable", "partial"].includes(value.completeness)
    && budgetExact(value.pricing, ["revisions", "sources", "valid"])
    && typeof value.pricing.valid === "boolean"
    && Array.isArray(value.pricing.revisions) && value.pricing.revisions.length <= 1000
    && value.pricing.revisions.every(revision => typeof revision === "string" && /^[a-f0-9]{64}$/.test(revision))
    && Array.isArray(value.pricing.sources) && value.pricing.sources.length <= 1000
    && value.pricing.sources.every(source => validPriceSource(source, Date.parse(value.asOf)))
    && Array.isArray(value.reasons) && value.reasons.length <= 10
    && value.reasons.every(reason => typeof reason === "string" && /^[a-z-]{1,64}$/.test(reason));
}

// The journal remains the accounting authority. No event writes, synthetic
// allocations, token conversions or caller-provided spend enter this evaluator.
export async function evaluateProjectBudget({ config, usageProvider, now, abortSignal } = {}) {
  if (!validBudgetConfig(config) || typeof usageProvider?.listInvocationUsageAggregates !== "function") budgetFail();
  const window = budgetWindow(now);
  const reasons = new Set(["partial-project-coverage", "eventual-journal-consistency"]);
  const rows = [];
  let readFailed = false;
  try {
    for (let start = Date.parse(window.startTime); start < Date.parse(window.evaluatedThrough);) {
      abortSignal?.throwIfAborted();
      const end = Math.min(start + 30 * DAY, Date.parse(window.evaluatedThrough));
      const page = await usageProvider.listInvocationUsageAggregates({
        scope: { type: "projects", domainIds: [config.domainId], projectIds: [`${config.domainId}/${config.projectId}`] },
        startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(), limit: 1,
        ...(abortSignal ? { abortSignal } : {}),
      });
      const row = page?.items?.[0];
      if (page?.cursor !== null || !Array.isArray(page.items) || page.items.length !== 1
        || row?.scopeType !== "project" || row.domainId !== config.domainId || row.projectId !== config.projectId
        || row.source !== "experience-invocation-journal" || row.environment !== "PRODUCTION"
        || row.windowBasis !== "usage-occurrence-and-execution-start" || row.runBoundary !== "runtime-durable-start"
        || !nonnegative(row.knownEstimatedCostUsd)
        || !(row.estimatedCostUsd === null || (nonnegative(row.estimatedCostUsd)
          && row.estimatedCostUsd === row.knownEstimatedCostUsd))
        || !(row.runCount === null || (Number.isSafeInteger(row.runCount) && row.runCount >= 0))
        || !["complete", "partial", "unavailable"].includes(row.modelCoverage)
        || !Array.isArray(row.priceSources) || row.priceSources.length > 500
        || !Array.isArray(row.pricingRevisions) || row.pricingRevisions.length > 500
        || row.pricingRevisions.some(revision => typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision))
        || !(row.updatedAt === null || (budgetInstant(row.updatedAt) && Date.parse(row.updatedAt) <= now))) budgetFail();
      rows.push(row);
      start = end;
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    readFailed = true;
    reasons.add("usage-unavailable");
  }
  const sources = new Map();
  let pricingValid = true;
  for (const row of rows) {
    if (row.knownEstimatedCostUsd > 0 && (!row.priceSources.length || !row.pricingRevisions.length)) pricingValid = false;
    for (const source of row.priceSources) {
      if (!validPriceSource(source, now)
        || (sources.has(source.id) && JSON.stringify(sources.get(source.id)) !== JSON.stringify(source))) pricingValid = false;
      else sources.set(source.id, source);
    }
  }
  if (!pricingValid) reasons.add("pricing-stale-or-unknown");
  const updatedAt = rows.map(row => row.updatedAt).filter(Boolean).sort().at(-1) ?? null;
  if (updatedAt === null) reasons.add("empty-history");
  else if (now - Date.parse(updatedAt) > 15 * MINUTE) reasons.add("stale-usage");
  if (rows.some(row => row.modelCoverage !== "complete" || row.estimatedCostUsd === null)) reasons.add("incomplete-model-usage");
  const usable = !readFailed && pricingValid && updatedAt !== null && rows.length > 0;
  const known = usable ? rows.reduce((sum, row) => sum + row.knownEstimatedCostUsd, 0) : null;
  const runCount = !readFailed && rows.length && rows.every(row => row.runCount !== null)
    ? rows.reduce((sum, row) => sum + row.runCount, 0) : null;
  if ((known !== null && !nonnegative(known)) || (runCount !== null && !Number.isSafeInteger(runCount))) budgetFail();
  const completeModel = usable && rows.every(row => row.estimatedCostUsd !== null && row.modelCoverage === "complete");
  const thresholdUsd = config.monthlyLimitUsd * config.thresholdPercent / 100;
  const result = {
    schemaVersion: 1, domainId: config.domainId, projectId: config.projectId, configVersion: config.version,
    status: known !== null && known >= thresholdUsd ? "CROSSED" : known === null ? "UNKNOWN" : "INCOMPLETE",
    thresholdPercent: config.thresholdPercent, thresholdUsd, currency: "USD", basis: "estimate",
    knownEstimatedCostUsd: known, estimatedCostUsd: completeModel ? known : null,
    runCount, costPerRunUsd: completeModel && runCount > 0 ? known / runCount : null,
    source: "experience-invocation-journal", environment: "PRODUCTION",
    window, windowBasis: "usage-occurrence-and-execution-start", asOf: new Date(now).toISOString(), updatedAt,
    coverage: { project: "partial", included: ["retained-provider-model-usage"],
      excluded: ["unobserved-attempts", "runtime", "gateway", "memory", "tools", "evaluation", "shared"] },
    completeness: known === null ? "unavailable" : "partial",
    pricing: { revisions: [...new Set(rows.flatMap(row => row.pricingRevisions))].sort(),
      sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), valid: pricingValid },
    reasons: [...reasons].sort(),
  };
  if (!validBudgetEvaluation(result)) budgetFail();
  return result;
}

export function createProjectBudgetService({ workspaceState, budgetState, usageProvider, authorizer, clock,
  destination = null, delivery } = {}) {
  if (!budgetDestination(destination)) throw new TypeError("Budget destination is invalid.");
  async function authorize(input, write, read = false) {
    const keys = ["identity", ...(read ? ["abortSignal"] : ["requestId"]), "domainId", "projectId",
      ...(input && Object.hasOwn(input, "abortSignal") && !read ? ["abortSignal"] : []),
      ...(write ? ["expectedVersion", "currency", "period", "monthlyLimitUsd", "thresholdPercent"] : [])];
    if (!budgetExact(input, keys) || (!read && !requestId(input.requestId))) budgetFail("INVALID_REQUEST");
    const identity = input.identity;
    if (!budgetExact(identity, ["actor", "role", "activeDomain", "domainIds"])
      || !subject(identity.actor) || !Array.isArray(identity.domainIds)) budgetFail("INVALID_REQUEST");
    if (!(read ? ["admin", "lead", "builder"] : ["admin", "lead"]).includes(identity.role)) budgetFail("FORBIDDEN");
    const scope = budgetScope(input.domainId, input.projectId);
    if (!identity.domainIds.includes(scope.domainId)
      || (identity.role !== "admin" && (identity.activeDomain !== scope.domainId
        || identity.domainIds.length !== 1))) budgetFail("NOT_FOUND");
    const project = await workspaceState.getProject({ ...scope,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}) });
    input.abortSignal?.throwIfAborted();
    if (project === null) budgetFail("NOT_FOUND");
    if (!project || project.domainId !== scope.domainId || project.id !== scope.projectId
      || !subject(project.ownerSubject) || !Array.isArray(project.memberSubjects)) budgetFail();
    if (project.status !== "ACTIVE") budgetFail("CONFLICT");
    if (identity.role === "builder" && project.ownerSubject !== identity.actor
      && !project.memberSubjects.includes(identity.actor)) budgetFail("NOT_FOUND");
    // Existing trusted principal/resource projection, plus the lead/admin-only
    // budget policy above; no new auth policy or body identity is introduced.
    const resource = { v: 1, type: "project", id: project.id, domainId: project.domainId,
      projectId: project.id, ownerSubject: project.ownerSubject, lifecycleState: project.status };
    let decision;
    try {
      decision = await authorizer({
        requestContext: { source: "operations-api", subject: identity.actor, role: identity.role,
          activeDomain: identity.activeDomain, domainIds: [...identity.domainIds] },
        action: "workspace.projects.read",
        resourceRef: `operations-resource:${Buffer.from(JSON.stringify(resource)).toString("base64url")}`,
      });
    } catch { budgetFail("FORBIDDEN"); }
    if (!budgetExact(decision, ["ok"]) || decision.ok !== true) budgetFail("FORBIDDEN");
    if (!budgetState) budgetFail();
    return { scope, project };
  }
  return Object.freeze({
    async readProjectBudget(input) {
      const { scope, project } = await authorize(input, false, true);
      input.abortSignal?.throwIfAborted();
      const config = await budgetState.getConfig(scope);
      const budget = publicProjectBudget(config);
      if (budget && (budget.domainId !== scope.domainId || budget.projectId !== scope.projectId)) budgetFail();
      // GET computes a preview only: no crossing, outbox or delivery mutations.
      const evaluation = config ? await evaluateProjectBudget({
        config, usageProvider, now: clock(), abortSignal: input.abortSignal,
      }) : null;
      return {
        resource: "project-budget", scope, budget, evaluation,
        project: { ...scope, name: project.name, ownerSubject: project.ownerSubject, status: project.status },
        access: { canEdit: ["admin", "lead"].includes(input.identity.role), role: input.identity.role },
      };
    },
    async writeProjectBudget(input) {
      const { scope } = await authorize(input, true);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
        || input.expectedVersion >= Number.MAX_SAFE_INTEGER) budgetFail("INVALID_REQUEST");
      const config = { schemaVersion: 1, ...scope, version: input.expectedVersion + 1,
        currency: input.currency, period: input.period, monthlyLimitUsd: input.monthlyLimitUsd,
        thresholdPercent: input.thresholdPercent, destination,
        updatedAt: new Date(clock()).toISOString(), updatedBy: input.identity.actor, requestId: input.requestId };
      if (!validBudgetConfig(config)) budgetFail("INVALID_REQUEST");
      const budget = await budgetState.writeConfig(config, input.expectedVersion);
      return { budget: publicProjectBudget(budget) };
    },
    async evaluateProjectBudget(input) {
      return withBudgetDeadline(async abortSignal => {
        const { scope } = await authorize({ ...input, abortSignal }, false);
        abortSignal.throwIfAborted();
        const budget = await budgetState.getConfig(scope, { abortSignal });
        abortSignal.throwIfAborted();
        if (budget === null) budgetFail("NOT_FOUND");
        const evaluation = await evaluateProjectBudget({ config: budget, usageProvider, now: clock(), abortSignal });
        abortSignal.throwIfAborted();
        const outbox = evaluation.status === "CROSSED"
          ? await budgetState.recordCrossing(budget, evaluation, { abortSignal }) : null;
        abortSignal.throwIfAborted();
        // One bounded attempt only; the scheduled runner owns durable paging.
        const deliveries = delivery ? await delivery.deliverProject(scope, undefined,
          { abortSignal, timeoutMs: 1_000, maxAlerts: 1 }) : [];
        return { budget, evaluation, outbox, deliveries };
      }, { abortSignal: input.abortSignal, timeoutMs: 1_400 });
    },
  });
}
