import {
  createPlaywrightBrowserAdapter,
  projectBrowserWorkerEvidence,
} from
  "./hosted-control-plane-acceptance.mjs";

const MAX_INPUT_BYTES = 1_048_576;

async function readPrivateInput() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
      throw new Error("Hosted browser worker input was invalid.");
    }
  }
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hosted browser worker input was invalid.");
  }
  return parsed;
}

async function run() {
  try {
    const input = await readPrivateInput();
    const timeoutMs = input.operationTimeoutMs;
    delete input.operationTimeoutMs;
    const { chromium } = await import("playwright");
    const browser = createPlaywrightBrowserAdapter({
      chromium,
      cleanupAttempts: 1,
      operationTimeoutMs: timeoutMs,
      runWithDeadline: (operation) =>
        Promise.resolve().then(() => operation()),
    });
    const rawResult = await browser.verifyRegistry(input);
    let result;
    if (input.ownership !== undefined) {
      result = projectBrowserWorkerEvidence(rawResult);
    }
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      cleanupCode:
        error?.cleanupCode === "HOSTED_ACCEPTANCE_CLEANUP_FAILED"
          ? error.cleanupCode
          : undefined,
      code: "HOSTED_BROWSER_FAILED",
      ok: false,
    }));
    process.exitCode = 1;
  }
}

await run();
