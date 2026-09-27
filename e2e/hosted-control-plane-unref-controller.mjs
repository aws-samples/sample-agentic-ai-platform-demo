import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPlaywrightBrowserProcessAdapter } from "./hosted-control-plane-acceptance.mjs";

const [
  killMode,
  workerPath,
  attemptLogPath,
  grandchildPidPath,
  grandchildScriptPath,
  outcomePath,
] = process.argv.slice(2);

if (
  !["fail-group-and-direct", "fail-group-only"].includes(killMode)
  || !workerPath
  || !attemptLogPath
  || !grandchildPidPath
  || !grandchildScriptPath
  || !outcomePath
) {
  throw new Error("Unref controller fixture arguments were invalid.");
}

let spawnCount = 0;
let workerPid;
const adapter = createPlaywrightBrowserProcessAdapter({
  cleanupAttempts: 2,
  killProcess() {
    throw new Error("Injected process-group kill failure.");
  },
  operationTimeoutMs: 400,
  processTerminationTimeoutMs: 250,
  spawnProcess(command, args, options) {
    spawnCount += 1;
    const child = spawn(command, args, options);
    workerPid = child.pid;
    if (killMode === "fail-group-and-direct") {
      child.kill = () => {
        throw new Error("Injected direct-child kill failure.");
      };
    }
    return child;
  },
  workerUrl: pathToFileURL(workerPath),
});

const startedAt = Date.now();
let code = "UNEXPECTED_SUCCESS";
try {
  await adapter.verifyRegistry({
    attemptLogPath,
    grandchildPidPath,
    grandchildScriptPath,
  });
} catch (error) {
  code = error?.code;
}

writeFileSync(
  outcomePath,
  JSON.stringify({
    code,
    elapsedMs: Date.now() - startedAt,
    spawnCount,
    workerPid,
  }),
  { encoding: "utf8", mode: 0o600 },
);
