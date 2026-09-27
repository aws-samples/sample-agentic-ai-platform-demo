// v2 part 3 — L3 deep-dive, golden path, service mapping, L4, principles, close.
module.exports.addRest = function (ctx) {
  const { p, C, W, H, FH, FB, I, img, shp, titleLight, titleDark, footerL, footerD } = ctx;

  // ========================= 7 · L3 deep dive (light, 3 columns + env band) =========================
  let s = p.addSlide(); s.background = { color: C.paper };
  titleLight(s, "L3: scaling through self-service & federation", "Maturity roadmap · phase 3", C.green);
  const cy = 1.8, ch = 3.55, cwv = 3.95, cg = 0.24, cx0 = 0.55;
  const cols = [
    ["Complete Control Plane", I.gears, ["Self-service blueprint catalog", "AI Gateway & unified registry", "Policy-as-code (Cedar)", "Automated CI/CD quality gates", "Prebuilt evaluation pipeline"]],
    ["Governance Landing Zone", I.shield, ["Automated account vending", "Control Tower & Service Catalog", "Per-domain Dev/UAT/Prod sets", "Bedrock Guardrails enforcement", "Centralised identity mapping"]],
    ["Federated Runtimes", I.sitemap, ["Domain-owned run & data planes", "Data residency in domain account", "Telemetry uplink to central plane", "Differentiated tools & logic", "Sandboxed microVM execution"]],
  ];
  cols.forEach(([hd, icn, items], ci) => {
    const x = cx0 + ci * (cwv + cg);
    shp(s, "RECTANGLE", { x, y: cy, w: cwv, h: ch, fill: { color: C.panel }, line: { color: C.edge, width: 1 } });
    shp(s, "RECTANGLE", { x, y: cy, w: cwv, h: 0.07, fill: { color: C.green } });
    img(s, icn, x + 0.28, cy + 0.28, 0.32, 0.32);
    s.addText(hd, { x: x + 0.72, y: cy + 0.26, w: cwv - 0.9, h: 0.4, color: C.inkL, fontSize: 14, bold: true, fontFace: FH, margin: 0, valign: "middle" });
    items.forEach((it, i) => {
      const y = cy + 0.9 + i * 0.5;
      img(s, I.check, x + 0.28, y + 0.02, 0.2, 0.2);
      s.addText(it, { x: x + 0.58, y, w: cwv - 0.8, h: 0.4, color: C.inkL, fontSize: 10.5, fontFace: FB, margin: 0, valign: "middle" });
    });
  });
  // environment behavior band
  const eby = cy + ch + 0.18;
  shp(s, "RECTANGLE", { x: 0.55, y: eby, w: W - 1.1, h: 0.95, fill: { color: C.edge } });
  s.addText("ENVIRONMENT\nBEHAVIOR", { x: 0.75, y: eby + 0.2, w: 1.7, h: 0.6, color: C.dimL, fontSize: 10, bold: true, fontFace: FB, margin: 0, lineSpacingMultiple: 0.95 });
  const envs = [["DEVELOPMENT", "Synthetic data, verbose tracing, guardrails in warn mode.", C.green],
    ["STAGING / UAT", "PII-masked data, prod parity, SME sign-off gates.", C.amber],
    ["PRODUCTION", "Real data, canary / blue-green, human-in-the-loop.", C.violet]];
  envs.forEach(([t, d, col], i) => {
    const x = 2.7 + i * 3.35;
    shp(s, "RECTANGLE", { x, y: eby + 0.15, w: 0.06, h: 0.65, fill: { color: col } });
    s.addText([{ text: t + "\n", options: { bold: true, color: C.inkL, fontSize: 10 } }, { text: d, options: { color: C.dimL, fontSize: 9 } }],
      { x: x + 0.16, y: eby + 0.13, w: 3.05, h: 0.7, fontFace: FB, margin: 0, valign: "middle", lineSpacingMultiple: 0.95 });
  });
  s.addText("Target operating model: the platform becomes a product — teams scale safely and independently.", { x: 0.55, y: H - 0.62, w: 11, h: 0.3, color: C.green, fontSize: 11.5, bold: true, fontFace: FB, margin: 0 });
  s.addNotes("L3 is where the platform becomes a product. Three pillars: (1) a complete control plane — self-service blueprint catalog, gateway + registry, policy-as-code with Cedar, automated CI/CD quality gates, and a prebuilt evaluation pipeline (the components that were missing at L2 now light up); (2) a governance landing zone that vends full per-domain account sets automatically via Control Tower/Service Catalog with guardrails and identity mapping; (3) federated runtimes — domain teams own their run and data planes, data stays resident in their account, only telemetry flows up. Environments are gated: dev (synthetic, warn) → UAT (masked, SME sign-off) → prod (real, canary, HITL).");

  // ========================= 8 · Golden path (light, principles + step grid) =========================
  s = p.addSlide(); s.background = { color: C.paper };
  titleLight(s, "The Golden Path — governed agent lifecycle", "L3: self-service scale · AALOE (operational excellence)");
  // left principles panel
  const px = 0.55, pyy = 1.75, pwv = 3.55, phv = 4.75;
  shp(s, "RECTANGLE", { x: px, y: pyy, w: pwv, h: phv, fill: { color: C.panel }, line: { color: C.edge, width: 1 } });
  img(s, I.codeW, px + 0.3, pyy + 0.32, 0.42, 0.42);
  s.addText("Agent-as-Code", { x: px + 0.85, y: pyy + 0.3, w: pwv - 1, h: 0.45, color: C.inkL, fontSize: 17, bold: true, fontFace: FH, margin: 0, valign: "middle" });
  s.addText("Treating agents as software artifacts makes them reviewed, versioned and reversible.", { x: px + 0.3, y: pyy + 0.95, w: pwv - 0.6, h: 0.7, color: C.dimL, fontSize: 11.5, fontFace: FB, margin: 0, valign: "top" });
  [["Unified Source", "Prompts, tools & harness bindings in Git."],
   ["Environment Parity", "One IaC definition across Dev, UAT, Prod."],
   ["Auditability", "Direct linkage: trace → commit → deployment."]].forEach(([t, d], i) => {
    const y = pyy + 1.75 + i * 0.98;
    shp(s, "RECTANGLE", { x: px + 0.3, y, w: 0.06, h: 0.78, fill: { color: C.accentBlue } });
    s.addText([{ text: t + "\n", options: { bold: true, color: C.inkL, fontSize: 12 } }, { text: d, options: { color: C.dimL, fontSize: 10 } }],
      { x: px + 0.48, y, w: pwv - 0.8, h: 0.8, fontFace: FB, margin: 0, valign: "middle", lineSpacingMultiple: 0.95 });
  });
  // right step grid (3 cols x 3 rows; last cell AALOE)
  const steps = [
    ["01", "Build Time", "Compose harness, prompts & skill bindings.", I.found, false],
    ["02", "Golden Path CI", "Security scans, unit tests, registry publish.", I.shield, false],
    ["03", "CD Non-Prod", "Automated deploy to Dev/UAT, E2E tests.", I.cloud, false],
    ["04", "Offline Evaluation", "LLM-as-judge + golden datasets = promotion gate.", I.check, true],
    ["05", "CD Production", "Canary / blue-green with human-in-the-loop.", I.rocket, false],
    ["06", "Online Evaluation", "Real-time traffic scoring & threshold alerts.", I.chart, false],
    ["07", "Feedback Loop", "User feedback + SME review → improvements.", I.loop, false],
  ];
  const gx = px + pwv + 0.35, gcols = 3, gw = (W - gx - 0.55 - (gcols - 1) * 0.2) / gcols, gh = 1.4, gyy = 1.75;
  steps.forEach(([n, t, d, icn, gate], i) => {
    const col = i % gcols, row = Math.floor(i / gcols);
    const x = gx + col * (gw + 0.2), y = gyy + row * (gh + 0.18);
    shp(s, "RECTANGLE", { x, y, w: gw, h: gh, fill: { color: gate ? C.greenBg : C.panel }, line: { color: gate ? C.green : C.edge, width: gate ? 1.5 : 1 } });
    shp(s, "ROUNDED_RECTANGLE", { x: x + 0.18, y: y + 0.18, w: 0.42, h: 0.28, rectRadius: 0.06, fill: { color: gate ? C.green : C.accentBlue } });
    s.addText(n, { x: x + 0.18, y: y + 0.18, w: 0.42, h: 0.28, align: "center", valign: "middle", color: "FFFFFF", fontSize: 10, bold: true, fontFace: FB, margin: 0 });
    img(s, icn, x + 0.72, y + 0.2, 0.24, 0.24);
    s.addText(t, { x: x + 1.02, y: y + 0.16, w: gw - 1.1, h: 0.32, color: C.inkL, fontSize: 12, bold: true, fontFace: FB, margin: 0, valign: "middle" });
    s.addText(d, { x: x + 0.18, y: y + 0.56, w: gw - 0.34, h: 0.7, color: C.dimL, fontSize: 9.5, fontFace: FB, margin: 0, valign: "top" });
  });
  // AALOE accent in the 8th (last) grid cell
  const ax = gx + 2 * (gw + 0.2), ay = gyy + 2 * (gh + 0.18);
  shp(s, "RECTANGLE", { x: ax, y: ay, w: gw, h: gh, fill: { color: C.accentBlue } });
  s.addText("AALOE", { x: ax, y: ay + 0.35, w: gw, h: 0.45, align: "center", color: "FFFFFF", fontSize: 20, bold: true, fontFace: FH, margin: 0 });
  s.addText("DEVELOP • MEASURE • IMPROVE", { x: ax, y: ay + 0.82, w: gw, h: 0.3, align: "center", color: "CFE0FF", fontSize: 9, bold: true, charSpacing: 1, fontFace: FB, margin: 0 });
  footerL(s, 8, "How — golden path / AALOE");
  s.addNotes("The lifecycle is a loop, not a line — this is AALOE: Agentic AI Lifecycle Operational Excellence. Everything that defines an agent lives in Git (Agent-as-Code): unified source, environment parity from one IaC definition, and auditability from trace to commit to deployment. Seven steps: Build → CI → CD non-prod → Offline Eval (the promotion gate — nothing advances until it clears both platform checks and the domain's golden-dataset bar) → CD prod → Online Eval → Feedback. Step 7 feeds signals back to Build Time. Change a model or prompt, re-run, compare — the loop makes iteration fast and safe.");

  // ========================= 9 · L3 service mapping (light table) =========================
  s = p.addSlide(); s.background = { color: C.paper };
  titleLight(s, "L3 service mapping & technical components", "Maturity roadmap · phase 3 · logical → AWS", C.green);
  const map = [
    ["Foundation Harness Catalog", "Blueprint templates & golden-path", "Service Catalog + Git golden-path repo"],
    ["Governance & Account Vending", "Vend per-domain account sets", "Control Tower · CloudFormation · DynamoDB"],
    ["Sandboxed Domain Execution", "Isolated per-agent runtime", "AgentCore Runtime (microVM)"],
    ["Identity & Memory Scoping", "Per-user auth, memory isolation", "AgentCore Identity + Amazon Cognito"],
    ["Policy & Guardrails", "Policy-as-code, I/O filtering", "Cedar · Bedrock Guardrails"],
    ["Evaluation Pipeline", "Golden-dataset promotion gate", "AgentCore Evaluations (LLM-as-judge)"],
    ["Observability", "Dual-backend tracing", "CloudWatch + Langfuse (OTEL)"],
  ];
  const tx = 0.55, ty = 1.85, tw = W - 1.1;
  const cW = [3.5, 4.4, tw - 3.5 - 4.4];
  const heads = ["HARNESS COMPONENT", "WHAT IT DOES", "AWS SERVICE / TOOLING"];
  // header row
  let cxp = tx;
  heads.forEach((h, i) => {
    shp(s, "RECTANGLE", { x: cxp, y: ty, w: cW[i], h: 0.5, fill: { color: C.inkL } });
    s.addText(h, { x: cxp + 0.18, y: ty, w: cW[i] - 0.3, h: 0.5, color: "FFFFFF", fontSize: 11, bold: true, charSpacing: 1, fontFace: FB, margin: 0, valign: "middle" });
    cxp += cW[i];
  });
  const rowH = 0.58;
  map.forEach((r, ri) => {
    const y = ty + 0.5 + ri * rowH;
    cxp = tx;
    r.forEach((cell, ci) => {
      shp(s, "RECTANGLE", { x: cxp, y, w: cW[ci], h: rowH, fill: { color: ri % 2 ? C.paper : C.panel }, line: { color: C.edge, width: 0.75 } });
      s.addText(cell, { x: cxp + 0.18, y, w: cW[ci] - 0.3, h: rowH, color: ci === 2 ? C.accentBlue : C.inkL, fontSize: 11, bold: ci === 0, fontFace: ci === 2 ? "Consolas" : FB, margin: 0, valign: "middle" });
      cxp += cW[ci];
    });
  });
  footerL(s, 9, "How — L3 service mapping");
  s.addNotes("This is the credibility slide for architects: every logical component maps to a concrete AWS/AgentCore service. Foundation Harness catalog → Service Catalog + Git. Governance/vending → Control Tower, CloudFormation, DynamoDB. Runtime → AgentCore Runtime microVMs. Identity → AgentCore Identity + Cognito. Policy → Cedar + Bedrock Guardrails. Evaluation → AgentCore Evaluations. Observability → CloudWatch + Langfuse via OpenTelemetry. Nothing here is hand-wavy — it's buildable today.");

  // ========================= 10 · L4 adaptive (dark, north-star) =========================
  s = p.addSlide(); s.background = { color: C.dark };
  shp(s, "OVAL", { x: -2.0, y: 3.2, w: 5.6, h: 5.6, fill: { type: "none" }, line: { color: C.violet, width: 1, transparency: 68 } });
  titleDark(s, "L4: the adaptive, self-optimizing platform", "North-star vision · phase four", C.violet);
  s.addText("L4 adds an AI-automation layer over the governed L3 foundation — shifting from manual scaling to feedback-driven autonomous evolution.",
    { x: 0.72, y: 1.95, w: 11.5, h: 0.6, color: C.dim, fontSize: 14, fontFace: FB, margin: 0 });
  const l4 = [
    [I.robot, "Assisted Onboarding", "AI-assisted scaffolding composes the foundation harness and repo from a high-level intent description."],
    [I.gaugeV, "Auto-Tuned Eval", "The platform proposes prompt, model and tool changes from live evaluation signal."],
    [I.gears, "Intelligent Operations", "Model routing, cost and rollout strategy tuned automatically against objectives."],
    [I.loop, "Autonomous Improvement", "Feedback-driven lifecycle updates — a continuously self-optimizing operating model."],
  ];
  const qw = 2.86, qg = 0.24, qx0 = 0.72, qy = 2.75, qh = 3.0;
  l4.forEach(([icn, t, d], i) => {
    const x = qx0 + i * (qw + qg);
    shp(s, "RECTANGLE", { x, y: qy, w: qw, h: qh, fill: { color: C.card }, line: { color: "3A3260", width: 1 } });
    shp(s, "OVAL", { x: x + 0.3, y: qy + 0.32, w: 0.8, h: 0.8, fill: { color: C.ink }, line: { color: C.violet, width: 1.25 } });
    img(s, icn, x + 0.5, qy + 0.52, 0.4, 0.4);
    s.addText(t, { x: x + 0.28, y: qy + 1.25, w: qw - 0.5, h: 0.45, color: C.text, fontSize: 14.5, bold: true, fontFace: FH, margin: 0 });
    s.addText(d, { x: x + 0.28, y: qy + 1.72, w: qw - 0.5, h: 1.15, color: C.dim, fontSize: 10.5, fontFace: FB, margin: 0, valign: "top" });
  });
  s.addText("Key question: can the platform continuously optimize itself?   ·   A north-star maturity level — not a promise for the first implementation.",
    { x: 0.72, y: H - 0.6, w: 12, h: 0.3, color: C.violet, fontSize: 11, bold: true, fontFace: FB, margin: 0 });
  s.addNotes("L4 is the north-star. The topology from L3 doesn't change — what's new is an AI-automation layer that drives the toil out of running it. Four capabilities: assisted onboarding (describe intent → composed harness + repo), auto-tuned evaluation (the platform proposes prompt/model/tool changes from eval signal), intelligent operations (routing, cost, rollout tuned automatically), and autonomous improvement (feedback-driven lifecycle updates). Be explicit with customers: this is aspirational and sequenced last — you earn it by nailing L1–L3 first. It is not a first-implementation promise.");

  // ========================= 11 · Principles / close (dark) =========================
  s = p.addSlide(); s.background = { color: C.dark2 };
  titleDark(s, "Architectural principles & how to start", "Getting started", C.green);
  const pr = [
    ["Reproducibility", "Agent-as-Code in Git — versioned, reversible, testable across every environment."],
    ["Auditability", "End-to-end traceability from production traces back to commits, scans and gates."],
    ["Reusability", "Standardised blueprints and central skill/tool registries eliminate duplication."],
    ["Environment Parity", "Dev, UAT and Prod instantiated from one IaC definition."],
  ];
  pr.forEach(([t, d], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.72 + col * 6.15, y = 2.15 + row * 1.35;
    shp(s, "RECTANGLE", { x, y, w: 0.07, h: 1.0, fill: { color: C.green } });
    s.addText(t, { x: x + 0.25, y, w: 5.6, h: 0.4, color: C.text, fontSize: 16, bold: true, fontFace: FH, margin: 0 });
    s.addText(d, { x: x + 0.25, y: y + 0.4, w: 5.6, h: 0.75, color: C.dim, fontSize: 11.5, fontFace: FB, margin: 0, valign: "top" });
  });
  shp(s, "RECTANGLE", { x: 0.72, y: 5.2, w: 11.9, h: 1.15, fill: { color: C.card }, line: { color: C.violet, width: 1.25 } });
  s.addText([{ text: "Where to begin:  ", options: { bold: true, color: C.text } },
    { text: "assess your maturity (locate on L1–L4) → stand up the foundation (gateway, AI Registry, identity, observability) → enable self-service (blueprints + eval gates) so domain teams ship safely.", options: { color: C.dim } }],
    { x: 1.0, y: 5.35, w: 11.3, h: 0.85, fontSize: 13.5, fontFace: FB, margin: 0, valign: "middle" });
  footerD(s, 11, "Getting started");
  s.addNotes("Close on the durable tenets that hold across all four levels: reproducibility (agent-as-code), auditability (trace→commit→gate), reusability (blueprints + registries), and environment parity (one IaC across dev/UAT/prod). Then the call to action: assess maturity, stand up the foundation, enable self-service. Meet teams where they are and move them up one realistic level at a time.");
};
