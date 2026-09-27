import {
  createPlaywrightRoleSwitchingBrowserAdapter,
} from "./hosted-role-switching-acceptance.mjs";

const MAX_INPUT_BYTES = 1_048_576;

async function readPrivateInput() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
      throw new Error("Hosted role-switching browser input was invalid.");
    }
  }
  const parsed = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hosted role-switching browser input was invalid.");
  }
  return parsed;
}

async function run() {
  try {
    const input = await readPrivateInput();
    const operationTimeoutMs = input.operationTimeoutMs;
    delete input.operationTimeoutMs;
    const { chromium } = await import("playwright");
    const browser = createPlaywrightRoleSwitchingBrowserAdapter({
      chromium,
      operationTimeoutMs,
    });
    const result = await browser.verifyRoleJourney(input);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      cleanupCode:
        error?.cleanupCode === "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED"
        || error?.code === "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED"
          ? "HOSTED_ROLE_SWITCHING_CLEANUP_FAILED"
          : undefined,
      code: "HOSTED_ROLE_SWITCHING_FAILED",
      ok: false,
      stage: error?.stage,
    }));
    process.exitCode = 1;
  }
}

await run();
