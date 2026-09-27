import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { GOLDEN_PATH, JOURNEYS, landingHtml } from "./public/modules/landing.mjs";

// Frozen accepted copy from the source commit named in the fixture. Keep this
// independent of the current implementation and usable in shallow CI checkouts.
const baseline = JSON.parse(readFileSync(new URL('./test-support/landing-baseline.json', import.meta.url), 'utf8'));
function originalConstant(name) { return structuredClone(baseline[name]); }

test("public landing retains all nine stages and all 22 original role stories in order", () => {
  assert.deepEqual(GOLDEN_PATH, originalConstant("GOLDEN_PATH", "// Serpentine geometry"));
  const journeys = originalConstant("JOURNEYS", "// Trace flow");
  journeys.user.steps[0].story = 'Sign in with your identity provider to access approved agents.';
  assert.deepEqual(JOURNEYS, journeys);
  assert.equal(GOLDEN_PATH.length, 9);
  assert.equal(Object.values(JOURNEYS).reduce((n, role) => n + role.steps.length, 0), 22);
});

test("landing has independent public controls, a real sign-in slot, and example labels", () => {
  const html = landingHtml('<button id="cognitosignin">Sign in</button>');
  assert.equal((html.match(/role="tab"/g) || []).length, 4);
  assert.equal((html.match(/data-gstage=/g) || []).length, 9);
  assert.match(html, /data-jtab="admin"[^>]*aria-selected="true"/);
  assert.match(html, /id="cognitosignin"/);
  assert.match(html, /Pause animation/);
  assert.match(html, /Example workflow/);
  assert.match(html, /Reference architecture/);
  assert.doesNotMatch(html, /authBoundary|demoGuide|data-jopen|data-gopen/);
  const source = readFileSync(new URL("./public/modules/landing.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sessionStorage|localStorage|auth-client|\/api\/|SESSION/);
});

test("full roadmap keeps original prose and diagrams without remote scripts", () => {
  const source = readFileSync(new URL("../docs/maturity-roadmap.html", import.meta.url), "utf8");
  const artifact = readFileSync(new URL("./public/landing-roadmap.html", import.meta.url), "utf8");
  const body = source.split("<body>")[1].split("<script>")[0];
  // Preserve every original section and diagram, except the misleading status claims.
  const revisedBody = body
    .replace('font-weight:700">NOW COMPLETE</span>', 'font-weight:700">L3 REFERENCE MODEL</span>')
    .replace('✓ OPS-MATURITY COMPONENTS NOW LIT UP (were missing at L2)', 'L3 OPERATIONS CAPABILITIES')
    .replace('This is exactly what the demo console provisions: a governance account vending per-domain dev/UAT/prod account sets.', 'This reference topology uses a governance account to provision per-domain dev/UAT/prod account sets.')
    .replace('The platform becomes a <b>product</b>.', 'In this reference design, the platform becomes a <b>product</b>.')
    .replace(' The governance account vends replicated per-team account sets — and it is exactly what the demo console implements.', '');
  assert.ok(artifact.includes(revisedBody));
  assert.doesNotMatch(artifact, /<script|cdn\.jsdelivr/);
  assert.match(artifact, /Reference architecture\./);
  assert.match(artifact, /data-roadmap-content/);
});
