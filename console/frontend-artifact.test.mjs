import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildFrontend, publicRoot } from "./build-frontend.mjs";
import { appSource, htmlShell, styleSource } from "./test-support/frontend-source.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

function declaration(source, name) {
  const match = source.match(new RegExp(`const ${name} = (\\{[^\\n]+\\}|\\{[\\s\\S]*?\\n\\})`));
  assert.ok(match, name);
  return match[1];
}
function evaluate(value) {
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${value})`, {
    ICONS: new Proxy({}, { get: (_, name) => String(name) }),
  })));
}

test("accepted persona navigation is retained except the hidden monitoring pages", async () => {
  const accepted = JSON.parse(await readFile(new URL("./test-support/accepted-ui-constants.json", import.meta.url)));
  const hiddenViews = ["monitoring", "observability"];
  const expectedNav = Object.fromEntries(
    Object.entries(evaluate(accepted.constants.SHELL_NAV))
      .map(([role, items]) => [role, items.filter(item => !hiddenViews.includes(item[3]))]),
  );
  assert.deepEqual(evaluate(declaration(appSource, "SHELL_NAV")), expectedNav);
  assert.deepEqual(evaluate(declaration(appSource, "SHELL_HOME")), evaluate(accepted.constants.SHELL_HOME));
  const views = evaluate(declaration(appSource, "SHELL_VIEWS"));
  for (const [role, destinations] of Object.entries(evaluate(accepted.constants.SHELL_VIEWS))) {
    for (const destination of destinations) {
      assert.equal(views[role].includes(destination), !hiddenViews.includes(destination), `${role}/${destination}`);
    }
  }
  for (const marker of ["agent-config.yaml", "/agent-config-import", "evalGateCardHtml", "memoryPlan", "loadDomainPromotions", "wireHostedDeliveryApproval"]) {
    assert.ok(appSource.includes(marker), marker);
  }
  assert.match(styleSource, /--bg:#ffffff/);
  assert.match(styleSource, /--topbar:#0f141a/);
  assert.match(htmlShell, /<nav class="side" id="side"><\/nav>/);
});

test("accepted real Cognito modules are byte-identical and loaded before app hydration", async () => {
  // Immutable accepted-main Git blob hashes, not mutable branch references.
  for (const [name, blob] of Object.entries({
    "auth-client.mjs": "adb7e9e60c81ef4b8e94281f011dcfa4b0253ebc",
    "auth-core.mjs": "efd05ffeb44ba15bb3d28bfe7402344b84929edf",
    "demo-context.mjs": "24d9fbe9bff9152d9ea81cd5735393ab6912f27f",
  })) {
    const bytes = await readFile(path.join(publicRoot, name));
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), blob, name);
  }
  assert.match(htmlShell, /runtime-config\.js[\s\S]*modules\/app\.mjs/);
  assert.match(appSource, /await hydrateCognitoSession\(\)/);
  assert.match(appSource, /id="tbrole" aria-label="Authorized working role"/);
  assert.match(appSource, /id="tbdomain" aria-label="Authorized working domain"/);
});

test("actual static artifact includes the cost import graph and no dangling local modules", async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), "frontend-artifact-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const output = path.join(scratch, "public");
  const manifest = await buildFrontend(output);
  const names = new Set(manifest.files.map(item => item.path));
  assert.equal(names.has("runtime-config.js"), false);
  for (const required of ["index.html", "modules/app.mjs", "styles/app.css", "modules/landing.mjs", "styles/landing.css", "landing-roadmap.html", "cost-view.mjs", "main-ui-compat.mjs", "main-ui-build.mjs", "auth-client.mjs", "auth-core.mjs", "guardrail-chain.mjs"]) {
    assert.ok(names.has(required), required);
  }
  for (const item of manifest.files) {
    const bytes = await readFile(path.join(output, item.path));
    assert.equal(sha(bytes), item.sha256, item.path);
    assert.deepEqual(bytes, await readFile(path.join(publicRoot, item.path)), item.path);
    if (item.path.endsWith(".css")) {
      for (const [, reference] of bytes.toString().matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        const resolved = reference.startsWith("/") ? reference.slice(1)
          : path.posix.normalize(path.posix.join(path.posix.dirname(item.path), reference));
        assert.ok(names.has(resolved), `${item.path} -> ${resolved}`);
      }
    }
    if (!item.path.endsWith(".mjs")) continue;
    const imports = [...bytes.toString().matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)];
    for (const [, specifier] of imports) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(item.path), specifier));
      assert.ok(names.has(resolved), `${item.path} -> ${resolved}`);
    }
  }
  const artifactApp = await readFile(path.join(output, "modules/app.mjs"), "utf8");
  assert.match(artifactApp, /from "\.\.\/cost-view\.mjs"/);
  assert.match(artifactApp, /hostedCostHtml\(/);
  assert.match(await readFile(path.join(output, "main-ui-compat.mjs"), "utf8"), /from "\.\/cost-view\.mjs"/);
  await assert.rejects(buildFrontend(output), /EEXIST/);
});

test("existing deployment packaging points at the same source and keeps config separate", async () => {
  const stack = await readFile(new URL("../infra/serverless-platform/lib/platform-web-stack.ts", import.meta.url), "utf8");
  assert.match(stack, /const consolePublicPath = path.join\([\s\S]*?"console",\s*"public",\s*\)/);
  assert.match(stack, /s3deploy.Source.asset\(\s*consolePublicPath,\s*\{ exclude: \["runtime-config.js"\] \}/);
  assert.match(stack, /s3deploy.Source.data\("runtime-config.js", runtimeConfig\)/);
});


test("every accepted guided journey step, order, and required surface is retained", async () => {
  const accepted = JSON.parse(await readFile(new URL("./test-support/accepted-ui-constants.json", import.meta.url)));
  const journeys = JSON.parse(JSON.stringify(vm.runInNewContext(accepted.journeysExpression)));
  const { availableDemoJourneys } = await import("./public/demo-assist.mjs");
  const surfaceIds = [...new Set(journeys.flatMap(journey => journey.requiredSurfaces))];
  const actual = availableDemoJourneys(surfaceIds);
  assert.deepEqual(actual.map(({ roles, ...journey }) => journey), journeys);
  assert.deepEqual(availableDemoJourneys(surfaceIds, "user").map(journey => journey.id), ["use-approved-agent"]);
  assert.deepEqual(availableDemoJourneys(surfaceIds, "builder").map(journey => journey.id), ["build-agent"]);
});
