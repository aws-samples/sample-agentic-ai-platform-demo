import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const MAX_INPUT_BYTES = 16_384;

async function readInput() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
      throw new Error("Process-tree fixture input was invalid.");
    }
  }
  const parsed = JSON.parse(input);
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || typeof parsed.attemptLogPath !== "string"
    || typeof parsed.grandchildPidPath !== "string"
    || typeof parsed.grandchildScriptPath !== "string"
  ) {
    throw new Error("Process-tree fixture input was invalid.");
  }
  return parsed;
}

const input = await readInput();
const grandchild = spawn(
  "/bin/sh",
  [input.grandchildScriptPath, input.grandchildPidPath],
  {
    stdio: ["ignore", "inherit", "inherit"],
  },
);
appendFileSync(
  input.attemptLogPath,
  `${JSON.stringify({
    grandchildPid: grandchild.pid,
    workerPid: process.pid,
  })}\n`,
  { encoding: "utf8" },
);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
