// Platform-level AWS billing view (admin only).
//
// The invocation journal attributes model usage to domains/projects/agents,
// but the AWS bill also carries everything the journal cannot see: the shared
// AgentCore runtime, DynamoDB, Lambda, CloudFront, S3, memory and knowledge
// base storage. Cost Explorer is the only truthful source for that layer, and
// it can only answer at account granularity here — the runtime is a single
// shared deployment with no per-domain resource tags, so this module never
// pretends to split the bill below the service dimension.
//
// Data is ~24h delayed (Cost Explorer refresh cadence) and the current month
// is always partial. Both facts are surfaced in the response rather than
// hidden, so the console can label the numbers honestly.

const SERVICE_LIMIT = 25;
const AMOUNT_PATTERN = /^-?\d+(?:\.\d+)?$/;

function fail(message) {
  const error = new Error(message);
  error.code = "PLATFORM_COSTS_UNAVAILABLE";
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utcDate(value) {
  return value.toISOString().slice(0, 10);
}

function monthStart(now) {
  return `${now.toISOString().slice(0, 7)}-01`;
}

function previousMonthStart(now) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return utcDate(new Date(Date.UTC(year, month - 1, 1)));
}

function parseAmount(metric) {
  if (
    !isPlainObject(metric)
    || typeof metric.Amount !== "string"
    || !AMOUNT_PATTERN.test(metric.Amount)
    || metric.Unit !== "USD"
  ) {
    fail("Cost Explorer returned a malformed amount.");
  }
  return Number(metric.Amount);
}

function serviceGroups(resultByTime) {
  if (
    !isPlainObject(resultByTime)
    || !Array.isArray(resultByTime.Groups)
  ) {
    fail("Cost Explorer returned a malformed result window.");
  }
  // Returns the FULL list — capping happens after cross-bucket merging,
  // otherwise the tail would be dropped before it can roll into otherUsd.
  return resultByTime.Groups.map((group) => {
    if (
      !isPlainObject(group)
      || !Array.isArray(group.Keys)
      || group.Keys.length !== 1
      || typeof group.Keys[0] !== "string"
      || group.Keys[0].length === 0
      || group.Keys[0].length > 200
    ) {
      fail("Cost Explorer returned a malformed service group.");
    }
    return {
      service: group.Keys[0],
      amountUsd: parseAmount(group.Metrics?.UnblendedCost),
    };
  });
}

// costExplorerClient: { getCostAndUsage(params, options) } — the AWS SDK v3
// CostExplorerClient wrapped by the runtime; injected so tests stay hermetic.
export function createPlatformCostsReader({ costExplorer, clock } = {}) {
  if (!costExplorer || typeof costExplorer.getCostAndUsage !== "function") {
    throw new TypeError("Cost Explorer client is invalid.");
  }
  if (typeof clock !== "function") {
    throw new TypeError("Platform costs clock is invalid.");
  }

  async function window(start, end, abortSignal) {
    let payload;
    try {
      payload = await costExplorer.getCostAndUsage(
        {
          TimePeriod: { Start: start, End: end },
          Granularity: "MONTHLY",
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        },
        abortSignal ? { abortSignal } : undefined,
      );
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      fail("Cost Explorer request failed.");
    }
    if (
      !isPlainObject(payload)
      || !Array.isArray(payload.ResultsByTime)
      || payload.ResultsByTime.length === 0
    ) {
      fail("Cost Explorer returned a malformed response.");
    }
    // MONTHLY granularity may split a window across month boundaries;
    // aggregate every returned bucket into one view.
    const merged = new Map();
    let estimated = false;
    for (const bucket of payload.ResultsByTime) {
      if (bucket?.Estimated === true) estimated = true;
      for (const entry of serviceGroups(bucket)) {
        merged.set(
          entry.service,
          (merged.get(entry.service) ?? 0) + entry.amountUsd,
        );
      }
    }
    const services = [...merged.entries()]
      .map(([service, amountUsd]) => ({ service, amountUsd }))
      .sort((left, right) => right.amountUsd - left.amountUsd);
    const totalUsd = services.reduce((sum, entry) => sum + entry.amountUsd, 0);
    return {
      startDate: start,
      endDate: end,
      estimated,
      totalUsd,
      services: services.slice(0, SERVICE_LIMIT),
      otherUsd: services
        .slice(SERVICE_LIMIT)
        .reduce((sum, entry) => sum + entry.amountUsd, 0),
    };
  }

  return Object.freeze({
    async read({ abortSignal } = {}) {
      const now = clock();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        fail("Platform costs clock produced an invalid time.");
      }
      // Cost Explorer requires End > Start; on the 1st of the month the
      // month-to-date window is [monthStart, tomorrow) to stay non-empty.
      const today = utcDate(now);
      const tomorrow = utcDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      const mtdStart = monthStart(now);
      const [monthToDate, previousMonth] = await Promise.all([
        window(mtdStart, mtdStart === today ? tomorrow : today, abortSignal),
        window(previousMonthStart(now), mtdStart, abortSignal),
      ]);
      return {
        source: "aws-cost-explorer",
        basis: "unblended-cost",
        currency: "USD",
        granularity: "service",
        dataDelayNote: "Cost Explorer data is typically ~24h behind.",
        monthToDate,
        previousMonth,
      };
    },
  });
}
