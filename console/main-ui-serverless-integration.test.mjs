import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  frontendSource,
} from "./test-support/frontend-source.mjs";

const html = frontendSource;

test("main retains hosted authorization controls without visible Demo mode", () => {
  assert.match(
    html,
    /@cloudscape-design\/design-tokens \(current AWS console visual refresh\)/,
  );
  assert.match(
    html,
    /--bg:#ffffff;[\s\S]*--accent:#006ce0;[\s\S]*--topbar:#0f141a;/,
  );
  assert.match(
    html,
    /Import <code>agent-config\.yaml<\/code>[\s\S]*\/agent-config-import/,
  );

  assert.match(
    html,
    /<script src="\/runtime-config\.js"><\/script>\s*<script type="module" src="\/modules\/app\.mjs"><\/script>/,
  );
  assert.match(html, /from "\.\.\/auth-client\.mjs"/);
  assert.match(html, /await import\("\.\.\/hosted-persona\.mjs"\)/);
  assert.match(html, /id="tbrole" aria-label="Authorized working role"/);
  assert.match(html, /id="tbdomain" aria-label="Authorized working domain"/);
  assert.doesNotMatch(html, /id="tbdemoassist"/);
  assert.match(
    html,
    /const activeShellNav = \(\) => SHELL_NAV/,
  );
  assert.match(
    html,
    /const allowedViews = \(\) => SHELL_VIEWS\[SHELL\(\)\]/,
  );
  assert.match(
    html,
    /const mainHomeView = \(\) => SHELL_HOME\[SHELL\(\)\]/,
  );
  assert.doesNotMatch(html, /S\.view==='hosteddashboard'/);
  assert.doesNotMatch(html, /S\.view==='hostedprojects'/);
  assert.doesNotMatch(html, /S\.view==='hostedagents'/);
  assert.doesNotMatch(html, /S\.view==='hostedbuild'/);
});

test("hosted main journeys use the canonical serverless build coordinator", () => {
  assert.match(
    html,
    /import \{\s*createMainUiBuildActions,\s*activeBuildProjects,\s*\} from "\.\.\/main-ui-build\.mjs"/,
  );
  assert.match(
    html,
    /const mainBuildActions=createMainUiBuildActions\(\{[\s\S]*readHostedCollection\(resource,options\)[\s\S]*requestId:createRequestId/,
  );
  assert.match(
    html,
    /mainBuildActions\.previewFoundation\(/,
  );
  assert.match(
    html,
    /mainBuildActions\.createSpecContract\(/,
  );
  assert.match(
    html,
    /const prepared=await mainBuildActions\.prepareAgent/,
  );
  assert.match(
    html,
    /const tested=await mainBuildActions\.testAgent/,
  );
  assert.match(
    html,
    /const published=await mainBuildActions\.publishAgent/,
  );
  assert.match(
    html,
    /const previewed=await mainBuildActions\.previewFull/,
  );
  assert.match(
    html,
    /mainBuildActions\.deploySandbox\(/,
  );
  assert.match(
    html,
    /mainBuildActions\.submitProduction\(/,
  );
  assert.match(html, /evaluationSetupHtml/);
  assert.doesNotMatch(html, /id="build-test-prompt"/);
  assert.match(html, /data-delivery-download/);
  assert.doesNotMatch(html, /id="psandbox"/);
  assert.doesNotMatch(html, /id="pproduction"/);
});

test("hosted Agent publication decisions use canonical approval records", () => {
  const loadStart = html.indexOf("async function loadRegistry(){");
  const loadEnd = html.indexOf("\n// Simple line-diff", loadStart);
  const loadSource = html.slice(loadStart, loadEnd);
  assert.match(loadSource, /readHostedCollection\('approvals'\)/);
  assert.match(
    loadSource,
    /approval\.resourceId===`\$\{aws\.registryId\}\/\$\{aws\.recordId\}`/,
  );

  const drawerStart = html.indexOf("function renderRegistryDrawer(){");
  const drawerEnd = html.indexOf("\nasync function doRegistryPropose", drawerStart);
  const drawerSource = html.slice(drawerStart, drawerEnd);
  assert.match(drawerSource, /\/governance\/publication-decisions/);
  assert.match(drawerSource, /approvalId:/);
  assert.match(drawerSource, /requesterSubject===SESSION\?\.actor/);
});

test("hosted Governance queue keeps Agent and production decisions on canonical endpoints", () => {
  const start = html.indexOf("async function readGovPendingWork(){");
  const end = html.indexOf("\n// Promotion approvals", start);
  const source = html.slice(start, end);
  assert.match(source, /readHostedCollection\('approvals'\)/);
  assert.match(source, /RESOURCE_PUBLICATION/);
  assert.match(source, /PRODUCTION_DEPLOYMENT/);
  assert.match(source, /wireHostedApprovalActions\(box,loadGovQueue,pendingApprovals\)/);
});

test("Domain Lead and Builder Governance navigation opens the canonical queue", () => {
  assert.match(
    html,
    /builder:\s*\[[^\]]*'governance'/,
  );
  assert.match(
    html,
    /lead:\s*\[[^\]]*'governance'/,
  );
  const start = html.indexOf("const GOV_TABS = ");
  const end = html.indexOf("\nconst govTabLabel", start);
  assert.ok(start >= 0 && end > start, "active Governance tab selector boundaries");
  for (const role of ["lead", "builder"]) {
    for (const govTab of [undefined, "queue", "requests", "exemptions", "policies", "audit"]) {
      const selected = vm.runInNewContext(`${html.slice(start, end)}\nactiveGovTab()`, {
        S: { who: role, govTab }, hasCap: () => false,
      });
      assert.equal(selected, "queue", `${role}/${govTab}`);
    }
  }
  assert.match(html, /function vGovernance\(\)\{\s*const tab = activeGovTab\(\)/);
  assert.match(html, /async function loadGovernance\(\)\{\s*const tab=activeGovTab\(\)[\s\S]*if\(tab==='queue'\)\{[\s\S]*runSessionTask\(loadGovQueue\)/);
  // Unified decision inbox: non-platform reviewers see only the 'queue' tab,
  // which now carries access requests as a section (former 'requests' tab).
  assert.match(
    html,
    /const govTabsVisible = \(\) => hasCap\('viewAllDomains'\)[\s\S]*id==='queue'\)/,
  );
});

test("hosted workspace collections page through every authoritative response", () => {
  assert.match(
    html,
    /async function readHostedCollection\(resource,options\)[\s\S]*collectPagedItems\([\s\S]*rawApi\(`\/\$\{resource\}\?limit=50/,
  );
  assert.match(
    html,
    /if\(p==='\/fleet'\)[\s\S]*readHostedCollection\('agents',options\)[\s\S]*readHostedCollection\('deployments',options\)[\s\S]*readHostedCollection\('approvals',options\)/,
  );
  assert.match(
    html,
    /async function hostedCollectionRequest\(resource\)[\s\S]*readHostedCollection\(resource\)/,
  );
});

test("workspace Fleet does not present unknown health as healthy", () => {
  const start = html.indexOf("async function loadWorkspaceTab(p){");
  const end = html.indexOf("\nasync function loadWorkspaceMemoryKb", start);
  const source = html.slice(start, end);
  assert.match(source, /a\.health==='unknown'[\s\S]*unknown/);
  assert.match(source, /a\.status==='READY'\?'deployed':'in_development'/);
});

test("hosted main UI coalesces repeated Registry reads for one session", () => {
  assert.match(html, /let hostedRegistryReadCache=null/);
  assert.match(html, /function clearHostedRegistryReadCache\(\)/);
  assert.match(html, /async function readHostedRegistry\(options\)/);
  assert.match(
    html,
    /hostedRegistryReadCache\?\.context===context/,
  );
  assert.match(html, /const context=hostedModelReadContext\(\)/);
  assert.match(html, /return JSON\.stringify\(\[sessionEpoch,SESSION\?\.actor\|\|SESSION\?\.user,SESSION\?\.role,activeDomain\(\)/);
  assert.ok(
    (html.match(/readHostedRegistry\(options\)/g) || []).length >= 4,
  );
});

test("hosted mutations invalidate Registry reads before and after the request", () => {
  const start = html.indexOf("const rawApi = async");
  const end = html.indexOf("\nfunction clearHostedRegistryReadCache()", start);
  const source = html.slice(start, end);
  assert.match(
    source,
    /if\(requestMethod!=='GET'\)clearHostedRegistryReadCache\(\)/,
  );
  assert.ok(
    (source.match(/clearHostedRegistryReadCache\(\)/g) || []).length >= 2,
  );
});

test("Registry decisions keep the authoritative mutation result during list convergence", () => {
  const helperStart = html.indexOf(
    "function applyRegistryDecisionResult(result){",
  );
  const helperEnd = html.indexOf(
    "\nfunction renderRegistryDrawer(){",
    helperStart,
  );
  const helper = html.slice(helperStart, helperEnd);
  assert.match(
    helper,
    /authoritativeRegistryVersion\(result\.id,result\.semver\)/,
  );
  assert.match(
    helper,
    /\['APPROVED','REJECTED'\]\.includes\(result\?\.status\)/,
  );

  const handlerStart = html.indexOf(
    "wrap.querySelectorAll('.regapprove,.regreject')",
  );
  const handlerEnd = html.indexOf(
    "\n  const proposeBtn=",
    handlerStart,
  );
  const handler = html.slice(handlerStart, handlerEnd);
  assert.ok(
    handler.indexOf("await loadRegistry()")
      < handler.indexOf("applyRegistryDecisionResult(r.version)"),
  );
});

test("AI-assisted design uses the same approved-model resolver as Blueprint builds", () => {
  const start = html.indexOf("function mainSpecAgentInput(journey){");
  const end = html.indexOf("\nfunction mainBuildNotice(){", start);
  const source = html.slice(start, end);
  assert.match(
    source,
    /modelId:resolveBuildModelId\(mainProjectCatalog\(\)\.models\)/,
  );
  assert.doesNotMatch(
    source,
    /const model=\(S\.catalog\?\.models\|\|\[\]\)\[0\]/,
  );
});

test("main blueprint business inputs remain available after retiring assist", () => {
  for (const [id, field] of [
    ["pname", "projectName"],
    ["persona", "agentInstructions"],
    ["mp-temp", "modelTemperature"],
    ["mp-maxtok", "modelMaxTokens"],
  ]) {
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*data-demo-assist-field="${field}"`),
    );
  }
  assert.match(
    html,
    /data-gmsg="\$\{esc\(g\.id\)\}" data-demo-assist-field="guardrailMessage"/,
  );
  assert.doesNotMatch(html, /demoAssistEnabled\(SESSION\)/);
});

test("retired assistance hook after async guardrail rows is inert", () => {
  assert.doesNotMatch(html, /DEMO_ASSIST\?\.applyDemoAssist/);
  const loadStart = html.indexOf("async function loadGuardrailPanel(prefix){");
  const loadEnd = html.indexOf("\nconst GUARDRAIL_ACTION_OPTS", loadStart);
  const loadSource = html.slice(loadStart, loadEnd);
  assert.ok(
    loadSource.indexOf("applyDemoAssistToHostedView()")
      > loadSource.indexOf("host.outerHTML="),
  );

  const wireStart = html.indexOf("function wireGuardrailPanel(prefix){");
  const wireEnd = html.indexOf("\n// TLP-B8", wireStart);
  const wireSource = html.slice(wireStart, wireEnd);
  assert.ok(
    wireSource.indexOf("applyDemoAssistToHostedView()")
      > wireSource.indexOf("host.outerHTML="),
  );
});
