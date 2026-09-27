// v2 part 2 — light HOW slides (reference-grade) + close.
module.exports.addHow = function (ctx) {
  const { p, C, W, H, FH, FB, I, img, shp, titleLight, titleDark, footerL, footerD } = ctx;

  // ========================= 4 · Capability stack + ownership (light) =========================
  let s = p.addSlide(); s.background = { color: C.paper };
  titleLight(s, "Platform capability stack & ownership", "Architectural target state · ownership split");
  const topY = 1.85, rows = 5, rh = 0.78, rgap = 0.13;
  const railW = 0.62, sx = 0.55 + railW + 0.18, sw = W - sx - (railW + 0.18) - 0.55;
  // rails
  const railH = rows * rh + (rows - 1) * rgap;
  // rotated label box: width = railH so when rotated it spans the rail's height; centered ON the rail (no edge overhang)
  const lblW = railH, lblH = 0.3;
  shp(s, "RECTANGLE", { x: 0.55, y: topY, w: railW, h: railH, fill: { color: C.edge } });
  s.addText("RESPONSIBLE AI", { x: 0.55 + railW / 2 - lblW / 2, y: topY + railH / 2 - lblH / 2, w: lblW, h: lblH, align: "center", valign: "middle", color: C.dimL, fontSize: 10, bold: true, charSpacing: 1, fontFace: FB, rotate: 270, margin: 0 });
  const rrx = W - 0.55 - railW;
  shp(s, "RECTANGLE", { x: rrx, y: topY, w: railW, h: railH, fill: { color: C.edge } });
  s.addText("OBSERVABILITY", { x: rrx + railW / 2 - lblW / 2, y: topY + railH / 2 - lblH / 2, w: lblW, h: lblH, align: "center", valign: "middle", color: C.dimL, fontSize: 10, bold: true, charSpacing: 1, fontFace: FB, rotate: 90, margin: 0 });
  function capblk(x, y, w, title, sub, icn, own) {
    const fill = own === "f" ? C.foundationBg : (own === "d" ? C.domainBg : C.panel);
    const edge = own === "f" ? C.foundation : (own === "d" ? C.domain : C.edge);
    shp(s, "ROUNDED_RECTANGLE", { x, y, w, h: rh, rectRadius: 0.05, fill: { color: fill }, line: { color: edge, width: 1.25 } });
    if (icn) img(s, icn, x + w / 2 - 0.6, y + 0.1, 0.24, 0.24);
    s.addText(title, { x, y: y + 0.34, w, h: 0.26, align: "center", color: C.inkL, fontSize: 12.5, bold: true, fontFace: FB, margin: 0 });
    if (sub) s.addText(sub, { x, y: y + 0.58, w, h: 0.18, align: "center", color: C.dimL, fontSize: 8.5, fontFace: FB, margin: 0 });
  }
  const rowY = i => topY + i * (rh + rgap);
  const half = sw / 2 - 0.09;
  capblk(sx, rowY(0), sw, "Playground & Self-Service Console", "where domain teams compose and test agents", I.console, "d");
  capblk(sx, rowY(1), half, "Model Gateway", "routing · auth · cost", I.gw, "f");
  capblk(sx + half + 0.18, rowY(1), half, "Agent & Tool Gateway", "MCP · A2A · 3P", I.shield, "f");
  capblk(sx, rowY(2), half, "Model Hub", "Bedrock · SageMaker", I.hub, "f");
  capblk(sx + half + 0.18, rowY(2), half, "AI Registry", "agent · MCP · skill/tool", I.boxes, "f");
  capblk(sx, rowY(3), half, "Model Hosting", "managed endpoints", I.chip, "f");
  capblk(sx + half + 0.18, rowY(3), half, "Agent & Tool Runtime", "AgentCore · containers", I.chip, "d");
  capblk(sx, rowY(4), half, "Enterprise Data", "datasets · vector · graph", I.db, "d");
  capblk(sx + half + 0.18, rowY(4), half, "Memory & Context", "session · long-term", I.brain, "d");
  // operations band
  const opsY = rowY(5);
  shp(s, "RECTANGLE", { x: sx, y: opsY, w: sw, h: 0.42, fill: { color: C.edge } });
  s.addText("OPERATIONS  ·  Evaluation · Version control · Config · Automation · Cost tracking · Access control · Usage limits",
    { x: sx, y: opsY, w: sw, h: 0.42, align: "center", valign: "middle", color: C.dimL, fontSize: 9.5, bold: true, fontFace: FB, margin: 0 });
  // legend
  shp(s, "RECTANGLE", { x: 4.3, y: H - 0.62, w: 0.16, h: 0.16, fill: { color: C.foundation } });
  s.addText("Foundation Harness (platform team)", { x: 4.52, y: H - 0.66, w: 3.3, h: 0.24, color: C.dimL, fontSize: 10, fontFace: FB, margin: 0 });
  shp(s, "RECTANGLE", { x: 7.7, y: H - 0.62, w: 0.16, h: 0.16, fill: { color: C.domain } });
  s.addText("Domain Harness (domain teams)", { x: 7.92, y: H - 0.66, w: 3.3, h: 0.24, color: C.dimL, fontSize: 10, fontFace: FB, margin: 0 });
  s.addNotes("The target architecture. Two rails wrap everything: Responsible AI (security, governance, privacy, guardrails, explainability) and Observability (audit, monitoring, tracing, feedback). The stack: a self-service console on top; then gateways, hubs/registry, hosting/runtime, and data/memory. Ownership is the key message — amber blocks are the Foundation Harness owned by the platform team (gateways, model hub, AI registry, hosting); green blocks are the Domain Harness owned by domain teams (console experience, agent runtime, data, memory). Operations runs underneath. Platform centralises what needs consistency; domains differentiate where it matters.");

  // ========================= 5 · Four stages overview (light, watermark) =========================
  s = p.addSlide(); s.background = { color: C.paper };
  titleLight(s, "Four stages of agentic AI maturity", "The maturity roadmap · L1 → L4");
  s.addText("L1–L4", { x: 0.2, y: 2.6, w: 4.2, h: 1.8, color: C.edge, fontSize: 96, bold: true, fontFace: FH, align: "center", margin: 0 });
  s.addText("Strategic evolution", { x: 0.2, y: 4.5, w: 4.2, h: 0.5, color: C.accentBlue, fontSize: 18, bold: true, fontFace: FH, align: "center", margin: 0 });
  const L = [
    ["L1: Ad Hoc Agents", "BUILD AT ALL", "“Can we build an agent at all?”", "Isolated pilots, local prompts, manual deployments. Proving feasibility without shared controls.", C.red, C.redBg],
    ["L2: Platform Foundation", "GOVERN CONSISTENTLY", "“Can we govern agents consistently?”", "Centralised shared services, a unified AI Registry, basic audit logging. Platform team is still the primary operator.", C.amber, C.amberBg],
    ["L3: Self-Service Scale", "SCALE SAFELY", "“Can many domain teams ship independently?”", "Complete control plane with blueprint-driven account vending. Federated teams own runtimes under central governance.", C.green, C.greenBg],
    ["L4: Adaptive Platform", "SELF-OPTIMIZE", "“Can the platform continuously optimize itself?”", "AI-assisted onboarding, auto-tuned evaluation, feedback-driven loops. The north-star for operational excellence.", C.violet, C.violetBg],
  ];
  const lx = 4.55, lw = W - lx - 0.55, lh = 1.13, ly0 = 1.75;
  L.forEach(([nm, tag, q, d, col, bg], i) => {
    const y = ly0 + i * (lh + 0.09);
    s.addText(nm, { x: lx, y, w: 4.0, h: 0.4, color: col, fontSize: 17, bold: true, fontFace: FH, margin: 0, valign: "middle" });
    shp(s, "ROUNDED_RECTANGLE", { x: lx + 3.65, y: y + 0.06, w: 1.9, h: 0.3, rectRadius: 0.14, fill: { color: bg }, line: { type: "none" } });
    s.addText(tag, { x: lx + 3.65, y: y + 0.06, w: 1.9, h: 0.3, align: "center", valign: "middle", color: col, fontSize: 8.5, bold: true, charSpacing: 1, fontFace: FB, margin: 0 });
    s.addText(q, { x: lx, y: y + 0.42, w: lw, h: 0.3, color: C.inkL, fontSize: 12.5, bold: true, italic: true, fontFace: FB, margin: 0 });
    s.addText(d, { x: lx, y: y + 0.72, w: lw, h: 0.42, color: C.dimL, fontSize: 10.5, fontFace: FB, margin: 0, valign: "top" });
  });
  footerL(s, 5, "How — maturity model");
  s.addNotes([
    "The spine of the deck: four levels, each defined by the question it answers. Use it to locate a customer and pick the next realistic step.",
    "",
    "L1 — AD HOC AGENTS (\"build at all\"): isolated pilots, local prompt management, custom code, manual deployments. Secrets often live in notebooks; agents call models directly; one account per team; no shared registry or governance. Value is proven, but nothing is reusable, governed or observable. Target action: establish a shared platform mandate and minimum controls.",
    "",
    "L2 — PLATFORM FOUNDATION (\"govern consistently\"): the first shared services appear — a unified AI Registry (agents, MCP servers, skills, tools), an optional gateway (routing/auth/cost, adopt-as-you-go, not yet mandatory), approved production runtimes, and basic audit logging. Crucial nuance: the control plane is still PARTIAL and the platform team is the primary operator. No self-service, no prebuilt eval pipeline, no policy-as-code yet. Target action: standardize templates, onboarding and release gates.",
    "",
    "L3 — SELF-SERVICE SCALE (\"scale safely\"): the platform becomes a product. Complete control plane (blueprint catalog, gateway+registry, policy-as-code, automated CI/CD gates, prebuilt evaluation pipeline), a governance landing zone that vends per-domain dev/UAT/prod account sets, and federated domain-owned runtimes with data residency in the domain account. Evaluation is the promotion gate. Target action: scale reuse, automate evidence, improve domain ownership.",
    "",
    "L4 — ADAPTIVE PLATFORM (\"self-optimize\"): a north-star. An AI-automation layer over the governed L3 foundation — assisted onboarding, auto-tuned evaluation and tools, intelligent operations, and feedback-driven autonomous improvement. Same topology as L3; AI drives the toil out of running it. Be explicit: aspirational, sequenced last, NOT a first-implementation promise.",
  ].join("\n"));

  // ========================= 6 · L1 → L2 transition (light) =========================
  s = p.addSlide(); s.background = { color: C.paper };
  titleLight(s, "L1 → L2: standardizing the foundation", "Maturity roadmap · phase 2 transition", C.amber);
  // left L1 card
  const cy = 1.85, ch = 4.55, cwv = 5.7;
  shp(s, "RECTANGLE", { x: 0.55, y: cy, w: cwv, h: ch, fill: { color: C.redBg }, line: { color: C.red, width: 1.25 } });
  s.addText("LEVEL 1 · AD-HOC SYMPTOMS", { x: 0.85, y: cy + 0.28, w: cwv - 0.6, h: 0.35, color: C.red, fontSize: 13, bold: true, charSpacing: 1, fontFace: FB, margin: 0 });
  [["Isolated pilots with local prompt management and custom code"],
   ["Inconsistent security; secrets often embedded in code / notebooks"],
   ["Direct model calls without a shared gateway or routing control"],
   ["Unsanctioned channels; one account per team; no shared registry"]].forEach(([t], i) => {
    const y = cy + 0.95 + i * 0.72;
    s.addText("✗", { x: 0.85, y, w: 0.35, h: 0.4, color: C.red, fontSize: 15, bold: true, fontFace: FB, margin: 0, valign: "middle" });
    s.addText(t, { x: 1.25, y, w: cwv - 1.5, h: 0.55, color: C.inkL, fontSize: 12.5, fontFace: FB, margin: 0, valign: "middle" });
  });
  s.addText("Current topology: fragmented, ungoverned.", { x: 0.85, y: cy + ch - 0.55, w: cwv - 0.6, h: 0.35, color: C.dimL, fontSize: 10.5, italic: true, fontFace: FB, margin: 0 });
  // arrow
  s.addText("→", { x: 0.55 + cwv, y: cy + ch / 2 - 0.4, w: 0.55, h: 0.8, align: "center", valign: "middle", color: C.amber, fontSize: 30, bold: true, margin: 0 });
  // right L2 card
  const rx = 0.55 + cwv + 0.55;
  shp(s, "RECTANGLE", { x: rx, y: cy, w: cwv, h: ch, fill: { color: C.amberBg }, line: { color: C.amber, width: 1.25 } });
  s.addText("LEVEL 2 · PLATFORM FOUNDATION", { x: rx + 0.3, y: cy + 0.28, w: cwv - 0.6, h: 0.35, color: C.amber, fontSize: 13, bold: true, charSpacing: 1, fontFace: FB, margin: 0 });
  [["Unified AI Registry", "discovery for agents, MCP servers, skills and tools"],
   ["Optional AI Gateway", "routing, auth, cost attribution — not yet mandatory"],
   ["Approved production runtimes", "sanctioned execution replaces laptops"],
   ["Basic governance & audit logging", "a first, partial control plane"]].forEach(([t, d], i) => {
    const y = cy + 0.95 + i * 0.82;
    img(s, I.check, rx + 0.3, y + 0.05, 0.28, 0.28);
    s.addText([{ text: t + "  ", options: { bold: true, color: C.inkL } }, { text: d, options: { color: C.dimL } }],
      { x: rx + 0.7, y, w: cwv - 1.0, h: 0.7, fontSize: 12, fontFace: FB, margin: 0, valign: "middle" });
  });
  footerL(s, 6, "How — L1 to L2");
  s.addNotes("The first move: consolidate. L1 is fragmented — local prompts, secrets in code, direct model calls, one account per team, no registry. L2 introduces the first shared services: a unified AI Registry (the single most valuable early asset — one place to discover agents, MCP servers, skills and tools), an optional gateway (adopt-as-you-go, not yet mandatory), approved runtimes, and basic audit logging. Important nuance: at L2 the control plane is only partial and the platform team is still the primary operator. Self-service, evaluation pipelines and policy-as-code come at L3.");

  module.exports._ctx2 = { s };
  return { p, s };
};
