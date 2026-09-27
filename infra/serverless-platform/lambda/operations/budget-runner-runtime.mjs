import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createWorkspaceState } from "../workspace/state.mjs";
import { createPlatformState } from "../platform-admin/state.mjs";
import { createActiveDomainDirectory } from "../api/domain-directory.mjs";
import { createExperienceInvocationStore } from "../experience/invocation-store.mjs";
import { createNativeExecutionJournal, nativeExecutionEnabled } from "../agent-runtime/execution-journal.mjs";
import { journalCompatibilityFromEnv } from "../experience/journal-compatibility.mjs";
import { createJournalUsageProvider } from "./journal-usage.mjs";
import { createProjectBudgetState } from "./budget-state.mjs";
import { createBudgetRunnerState } from "./budget-runner-state.mjs";
import { createBudgetRunner } from "./budget-runner.mjs";
import { createBudgetSnsPublisher } from "./budget-sns-publisher.mjs";
import { boundedBudgetDynamo, withBudgetDeadline } from "./budget-deadline.mjs";
import { budgetExact } from "./budgets.mjs";

function scheduleEvent(event, arn) {
  const match = typeof arn === "string" && /^arn:(aws(?:-us-gov|-cn)?):events:([a-z0-9-]+):(\d{12}):rule\/[A-Za-z0-9_.-]{1,64}$/.exec(arn);
  if (!match || !budgetExact(event, ["version", "id", "detail-type", "source", "account", "time", "region", "resources", "detail"])
    || event.version !== "0" || event.source !== "aws.events" || event["detail-type"] !== "Scheduled Event"
    || event.account !== match[3] || event.region !== match[2]
    || !Array.isArray(event.resources) || event.resources.length !== 1 || event.resources[0] !== arn
    || !budgetExact(event.detail, []) || typeof event.id !== "string" || event.id.length > 128
    || typeof event.time !== "string" || !Number.isFinite(Date.parse(event.time))) {
    throw new TypeError("Budget runner requires its configured internal scheduled event.");
  }
}

function jsonObject(text) {
  if (text === undefined) return undefined;
  if (typeof text !== "string" || text.length > 65_536) throw new TypeError("Invalid budget reader config.");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid budget reader config.");
  return value;
}

export function createBudgetRunnerRuntime({ env = process.env, dynamo, publisher, clock = Date.now } = {}) {
  // An AWS client is not constructed until this explicitly enabled internal entry
  // receives the expected schedule envelope. IAM must restrict InvokeFunction.
  return async (event, context = {}) => {
    if (env.OPERATIONS_BUDGET_RUNNER_ENABLED !== "true") return { status: "DISABLED" };
    scheduleEvent(event, env.OPERATIONS_BUDGET_SCHEDULE_ARN);
    const tableName = env.PLATFORM_STATE_TABLE_NAME;
    if (typeof tableName !== "string" || !tableName.trim()) throw new TypeError("Budget runner table is unavailable.");
    const remaining = context.getRemainingTimeInMillis?.() ?? 30_000;
    if (!Number.isFinite(remaining) || remaining < 2_000) return { status: "INSUFFICIENT_TIME" };
    return withBudgetDeadline(async abortSignal => {
      const raw = dynamo ?? new DynamoDBClient({ maxAttempts: 1 });
      const bounded = boundedBudgetDynamo(raw, abortSignal);
      let requests = 0;
      let domainPages = 0;
      const client = { send(command, options) {
        // Includes common-reader fanout, empty pages and checkpoint requests.
        if (++requests > 1000 || (command.input.ExpressionAttributeValues?.[":pk"]?.S === "DOMAIN"
          && ++domainPages > 100)) throw new Error("Budget runner request/page limit exceeded.");
        return bounded.send(command, options);
      } };
      const now = () => new Date(clock());
      const nativeExecution = nativeExecutionEnabled(env.OPERATIONS_NATIVE_EXECUTION_VERSION);
      const budgetPublisher = publisher === undefined
        ? await createBudgetSnsPublisher({ destination: env.OPERATIONS_BUDGET_SNS_TOPIC_ARN ?? null }) : publisher;
      abortSignal.throwIfAborted();
      const run = createBudgetRunner({
        workspaceState: createWorkspaceState({ tableName, dynamo: client, now }),
        domainDirectory: createActiveDomainDirectory(createPlatformState({ tableName, dynamo: client, now })),
        budgetState: createProjectBudgetState({ tableName, dynamo: client }),
        runnerState: createBudgetRunnerState({ tableName, dynamo: client, clock }),
        usageProvider: createJournalUsageProvider({
          journal: createExperienceInvocationStore({ tableName, dynamo: client, now,
            ...(nativeExecution ? { nativeJournal: createNativeExecutionJournal({ tableName, dynamo: client, now }) } : {}) }),
          nativeExecution, compatibility: journalCompatibilityFromEnv(env),
          ...(env.OPERATIONS_MODEL_PRICES_JSON === undefined ? {} : { priceBook: jsonObject(env.OPERATIONS_MODEL_PRICES_JSON) }),
        }),
        publisher: budgetPublisher, destination: env.OPERATIONS_BUDGET_SNS_TOPIC_ARN ?? null, clock,
      });
      return run({ abortSignal });
    }, { timeoutMs: Math.min(20_000, Math.floor(remaining - 1_000)) });
  };
}

export const handler = createBudgetRunnerRuntime();
