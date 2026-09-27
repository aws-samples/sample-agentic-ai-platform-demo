import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { enabledHostedSurfaces } from "./public/hosted-persona.mjs";
const source = readFileSync(new URL("./public/modules/app.mjs", import.meta.url), "utf8");
const fn = name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
};

test("dirty context guard cancels before any role mutation and recognizes reverted edits", () => {
  const control = { type: "text", value: "draft", defaultValue: "original", disabled: false };
  let prompts = 0;
  const ctx = vm.createContext({
    S: {},
    domainBootstrapDirty: () => false,
    projectBudgetDirty: () => false, composeDirty:{isDirty:()=>false}, composeDraft:()=>({}),
    approvalReasonDrafts: { isDirty: () => false }, approvalReasonScope: () => ({}),
    businessForms: { isDirty: () => control.value !== control.defaultValue },
    wizardDirty: { isDirty: (_scope, data) => data?.name === "edited" },
    document: { querySelectorAll: () => [control] },
    confirm: () => { prompts++; return false; },
  });
  vm.runInContext(`${fn("hasUnsavedContextChanges")}\n${fn("confirmContextChange")}`, ctx);
  assert.equal(ctx.confirmContextChange(), false);
  assert.equal(prompts, 1);
  control.value = "original";
  assert.equal(ctx.confirmContextChange(), true);
  assert.equal(prompts, 1);
  ctx.S.wiz = { step: 2, data: { name: "edited" } };
  assert.equal(ctx.confirmContextChange(), false);
  assert.equal(prompts, 2);
  ctx.S.wiz = null;
  ctx.domainBootstrapDirty = () => true;
  assert.equal(ctx.confirmContextChange(), false, "an unsaved domain initialization guards context changes");
  assert.equal(prompts, 3);
  ctx.domainBootstrapDirty = () => false;
  const start = source.indexOf("async function switchDemoContext(");
  const end = source.indexOf("\nfunction closeProfile", start);
  const switcher = source.slice(start, end);
  assert.ok(switcher.indexOf("confirmContextChange()") < switcher.indexOf("setDemoContext(requested"));
  assert.match(switcher, /sameAuthenticatedIdentity\(profile,previousProfile\)/);
});

test("sidebar uses native text buttons and collapsible groups with current context", () => {
  const nav = fn("navSections");
  assert.match(nav, /<button type="button"/);
  assert.match(nav, /aria-current/);
  assert.match(nav, /<details/);
  assert.match(nav, /<summary/);
  assert.match(nav, /Current:/);
  assert.doesNotMatch(nav, /<span class="ic"/);
  assert.match(nav, /it\[0\]!=='bwregistry'/);
});

test("authenticated app has no generic intro or tour restoration and retains business actions", () => {
  assert.doesNotMatch(source, /goldenPathCard|journeysCard|maturityLadderHtml|renderActiveDemoJourney|reconcileActiveDemoJourney|data-demo-journey-next|Demo guide/);
  assert.match(source, /clearActiveDemoJourney\(\)/);
  assert.match(source, /await beginSignIn\(\)/);
  assert.match(source, /await completeSignIn\(\)/);
  assert.match(source, /sameAuthenticatedIdentity/);
  assert.match(source, /mountProjectBudget/);
  assert.match(source, /wizard-validate/);
  assert.match(source, /w\.step\+\+/);
  assert.match(source, /loadOverviewRecs/);
  assert.match(source, /id="pcallfleet"/);
});

test("Blueprints stays a catalog while publication approvals stay in Governance", () => {
  assert.doesNotMatch(source, /bppendingstrip|loadPendingBlueprintStrip/);
  assert.match(source, /id="bpsublist"/);
  assert.match(source, /runSessionTask\(loadBlueprintSubmissions\)/);
});

test("all accepted role menus keep their order and capability-based visibility", () => {
  const navStart = source.indexOf("const SHELL_NAV = ");
  const navEnd = source.indexOf("\nconst activeShellNav", navStart);
  assert.ok(navStart >= 0 && navEnd > navStart, "SHELL_NAV declaration boundaries");
  const roles = {
    admin: ["home","domains","blueprints","registry","governance","cost","bwfleet","bwbuild","bwmemorykb","bwcost"],
    lead: ["dashboard","projects","users","governance","bwfleet","bwbuild","bwmemorykb","bwcost","bwregistry"],
    builder: ["fleet","build","memorykb","cost","registry"],
    user: ["overview","fleet"],
  };
  const capabilities = ["viewPlatformInventory", "viewDomainInventory", "viewDomainRegistry",
    "createAgent", "viewPlatformOperations", "viewPlatformCost", "manageDomainEntitlements", "discoverEntitledAgents"];
  for (const [role, expected] of Object.entries(roles)) {
    const ctx = vm.createContext({
      ICONS: new Proxy({}, { get: () => "" }), S: { who: role, navClosed: {} }, SHELL: () => role,
      SESSION: { capabilities }, authoritativeCapabilities: value => value.capabilities,
      enabledHostedSurfaces, authMode: () => "cognito", navActive: () => false,
      esc: value => String(value), HAS_BUILD_SECTION: { admin: true, lead: true },
    });
    vm.runInContext(`${source.slice(navStart, navEnd)}\nconst activeShellNav=()=>SHELL_NAV;\n${fn("navItemVisible")}\n${fn("navSections")}`, ctx);
    assert.deepEqual([...ctx.navSections().matchAll(/data-shellnav="([^"]+)"/g)].map(match => match[1]), expected, role);
    ctx.SESSION.capabilities = [];
    assert.equal(ctx.navSections(), "", `${role} with no capabilities`);
  }
});

test("actual context switch requires /me and identical identity, replaces scoped caches only after acceptance", async () => {
  const initial = {
    ok: true, user: "synthetic-subject", name: "Synthetic User", role: "admin", authenticatedRole: "admin",
    domain: null, domains: ["domain_a"], capabilities: [], demoRoleActive: false,
    canSwitchDemoRole: true, availableDemoRoles: ["admin", "lead"],
    availableDemoDomains: [{ id: "domain_a", name: "Synthetic Domain" }],
  };
  for (const outcome of ["allowed", "denied", "identity-mismatch"]) {
    const calls = [];
    const main = { innerHTML: "old scope" };
    const result = outcome === "denied" ? { ok: false, code: "DEMO_ROLE_NOT_ALLOWED" }
      : { ...initial, role: "lead", domain: "domain_a", domains: ["domain_a"], demoRoleActive: true,
        user: outcome === "identity-mismatch" ? "other-subject" : initial.user };
    const ctx = vm.createContext({
      SESSION: structuredClone(initial), S: { view: "cost", workspaceProjects: ["old-project"] },
      demoContextSwitching: false, authMode: () => "cognito", confirmContextChange: () => true,
      sessionEpoch: 0, sessionEpochIsCurrent: epoch => epoch === ctx.sessionEpoch,
      invalidateSessionWork: () => ctx.sessionEpoch++,
      document: { getElementById: id => id === "main" ? main : null },
      getDemoContext: () => null, setDemoContext: () => calls.push("set-context"),
      setDemoControlsDisabled: () => {}, api: async route => { calls.push(route); return result; },
      usableDomainId: value => /^[a-z][a-z0-9_]*$/.test(value),
      restoreDemoContext: () => calls.push("restore"), authoritativeDemoContext: value => value,
      clearActiveDemoJourney: () => calls.push("clear-tour"), mainHomeView: () => "domainconsole",
      render: () => {}, alert: () => {}, cognitoErrorMessage: () => "", getAccessToken: () => "synthetic",
      failClosedCognitoSession: () => assert.fail("Unexpected session invalidation"),
    });
    ctx.replaceSession = value => { calls.push("replace"); ctx.SESSION = value; ctx.S.workspaceProjects = null; };
    vm.runInContext(`${fn("usableCognitoProfile")}\n${fn("sameAuthenticatedIdentity")}\nasync ${fn("switchDemoContext")}`, ctx);
    await ctx.switchDemoContext({ role: "lead", domain: "domain_a" });
    assert.ok(calls.indexOf("/me") < calls.indexOf("replace"));
    assert.equal(ctx.SESSION.role, outcome === "allowed" ? "lead" : "admin");
    assert.equal(ctx.SESSION.user, initial.user);
    assert.equal(ctx.S.workspaceProjects, null);
    assert.equal(ctx.S.view, outcome === "allowed" ? "domainconsole" : "cost");
    assert.match(main.innerHTML, /switching working context/);
  }
});
