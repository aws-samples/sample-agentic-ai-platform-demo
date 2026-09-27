import { pathToFileURL } from "node:url";
import {
  reconcileDemoOperator,
  runCli as runCanonicalCli,
} from "./reconcile-demo-operator.mjs";

export {
  DEFAULT_COMPENSATION_QUIESCENCE_MS,
  DEFAULT_LEASE_DURATION_SECONDS,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_PAGES,
  DEFAULT_OPERATION_TIMEOUT_MS,
  createDynamoLease,
  parsePrivateSelection,
  readPrivateStdin,
  reconcileDemoOperator,
} from "./reconcile-demo-operator.mjs";

export const configureDemoOperator = reconcileDemoOperator;
export const runCli = runCanonicalCli;

const isExecutable = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isExecutable) {
  try {
    await runCli();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Demo operator reconciliation failed.",
    );
    process.exitCode = 1;
  }
}
