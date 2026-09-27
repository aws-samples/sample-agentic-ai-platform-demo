import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = path.join(
  TEST_DIR,
  "..",
  "lambda",
  "agent-runtime",
  "server.js",
);

test("managed Node entrypoint loads the ESM AgentCore runtime", async () => {
  const child = spawn(process.execPath, [ENTRYPOINT], {
    env: {
      ...process.env,
      AWS_REGION: "",
      LLM_GATEWAY_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /Agent Runtime failed to start\./);
  assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND/);
});
