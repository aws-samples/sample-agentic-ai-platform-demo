// Enterprise Agentic AI Platform — v2 deck. WHY (dark) → HOW (light, reference-grade) → close.
const pptxgen = require("pptxgenjs");
const React = require("react"), RD = require("react-dom/server"), sharp = require("sharp");
const FA = require("react-icons/fa");

async function ic(Comp, color, size = 256) {
  const svg = RD.renderToStaticMarkup(React.createElement(Comp, { color, size: String(size) }));
  return "image/png;base64," + (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}

// palette
const C = {
  dark: "0A0E17", dark2: "121A2E", card: "1A2338", cardHi: "22304C",
  ink: "1A2233", text: "E6ECF7", dim: "9AA7BF", muted: "667891",
  // light theme
  paper: "F6F8FC", panel: "FFFFFF", edge: "E2E8F2", inkL: "1E2A44", dimL: "5B6B84",
  // level + role colors (match reference)
  red: "E05260", amber: "E08A1E", green: "1F9D6B", violet: "6D4FD6",
  foundation: "E08A1E", domain: "1F9D6B",
  foundationBg: "FBEFE0", domainBg: "E7F4EE", violetBg: "EDE8FB", redBg: "FBE9EB", amberBg: "FBF1E0", greenBg: "E7F4EE",
  accentBlue: "3B4CB8",
};
const FH = "Georgia", FB = "Calibri";
const W = 13.333, H = 7.5;
const p = new pptxgen();
p.defineLayout({ name: "W", width: W, height: H }); p.layout = "W";
p.author = "Platform CoE"; p.title = "Enterprise Agentic AI Platform — Maturity Journey";

// ---- helpers ----
const shp = (s, type, o) => s.addShape(p.shapes[type], o);
function titleLight(s, t, kick, kickColor = C.accentBlue) {
  // left blue rule motif + title + kicker (reference style)
  shp(s, "RECTANGLE", { x: 0.55, y: 0.55, w: 0.09, h: 0.72, fill: { color: kickColor } });
  s.addText(t, { x: 0.78, y: 0.5, w: 12, h: 0.75, color: C.inkL, fontSize: 30, bold: true, fontFace: FH, margin: 0, valign: "middle" });
  s.addText((kick || "").toUpperCase(), { x: 0.8, y: 1.28, w: 12, h: 0.3, color: kickColor, fontSize: 11, bold: true, charSpacing: 2, fontFace: FB, margin: 0 });
}
function titleDark(s, t, kick, kickColor = C.violet) {
  s.addText((kick || "").toUpperCase(), { x: 0.72, y: 0.62, w: 12, h: 0.3, color: kickColor, fontSize: 11, bold: true, charSpacing: 3, fontFace: FB, margin: 0 });
  s.addText(t, { x: 0.67, y: 0.95, w: 12.2, h: 1.0, color: C.text, fontSize: 30, bold: true, fontFace: FH, margin: 0 });
}
function footerL(s, n, sec) {
  s.addText([{ text: "Enterprise Agentic AI Platform", options: { color: C.muted } }, { text: "   ·   " + sec, options: { color: C.accentBlue } }],
    { x: 0.55, y: H - 0.4, w: 9, h: 0.28, fontSize: 8, fontFace: FB, margin: 0 });
  s.addText(String(n).padStart(2, "0"), { x: W - 1.05, y: H - 0.4, w: 0.5, h: 0.28, align: "right", color: C.muted, fontSize: 8, fontFace: FB, margin: 0 });
}
function footerD(s, n, sec) {
  s.addText([{ text: "Enterprise Agentic AI Platform", options: { color: C.muted } }, { text: "   ·   " + sec, options: { color: C.violet } }],
    { x: 0.55, y: H - 0.4, w: 9, h: 0.28, fontSize: 8, fontFace: FB, margin: 0 });
  s.addText(String(n).padStart(2, "0"), { x: W - 1.05, y: H - 0.4, w: 0.5, h: 0.28, align: "right", color: C.muted, fontSize: 8, fontFace: FB, margin: 0 });
}

async function build() {
  const I = {
    console: await ic(FA.FaDesktop, "#1F9D6B"), gw: await ic(FA.FaDoorOpen, "#E08A1E"),
    shield: await ic(FA.FaShieldAlt, "#E08A1E"), boxes: await ic(FA.FaBoxes, "#E08A1E"),
    hub: await ic(FA.FaLayerGroup, "#E08A1E"), chip: await ic(FA.FaMicrochip, "#1F9D6B"),
    db: await ic(FA.FaDatabase, "#1F9D6B"), brain: await ic(FA.FaBrain, "#1F9D6B"),
    reg: await ic(FA.FaBoxes, "#1F9D6B"),
    sprawlW: await ic(FA.FaClone, "#E05260"), shadowW: await ic(FA.FaUserSecret, "#E05260"),
    costW: await ic(FA.FaCoins, "#E05260"), obsW: await ic(FA.FaEyeSlash, "#E05260"),
    build: await ic(FA.FaFlask, "#E05260"), found: await ic(FA.FaCubes, "#E08A1E"),
    scale: await ic(FA.FaUsersCog, "#1F9D6B"), magic: await ic(FA.FaMagic, "#6D4FD6"),
    check: await ic(FA.FaCheckCircle, "#1F9D6B"), gears: await ic(FA.FaCogs, "#1F9D6B"),
    cloud: await ic(FA.FaCloud, "#1F9D6B"), sitemap: await ic(FA.FaSitemap, "#1F9D6B"),
    codeW: await ic(FA.FaFileCode, "#3B4CB8"), rocket: await ic(FA.FaRocket, "#3B4CB8"),
    loop: await ic(FA.FaSyncAlt, "#3B4CB8"), chart: await ic(FA.FaChartLine, "#3B4CB8"),
    robot: await ic(FA.FaRobot, "#6D4FD6"), flag: await ic(FA.FaFlagCheckered, "#E08A1E"),
    gaugeV: await ic(FA.FaTachometerAlt, "#6D4FD6"),
  };
  const img = (s, d, x, y, w, h) => s.addImage({ data: d, x, y, w, h });

  // ========================= 1 · TITLE (dark) =========================
  let s = p.addSlide(); s.background = { color: C.dark };
  shp(s, "OVAL", { x: 9.6, y: -1.7, w: 5.6, h: 5.6, fill: { type: "none" }, line: { color: C.violet, width: 1, transparency: 72 } });
  shp(s, "OVAL", { x: 10.7, y: -0.6, w: 3.4, h: 3.4, fill: { type: "none" }, line: { color: C.violet, width: 1, transparency: 55 } });
  s.addText("ENTERPRISE", { x: 0.72, y: 2.2, w: 10, h: 0.5, color: C.violet, fontSize: 16, bold: true, charSpacing: 8, fontFace: FB, margin: 0 });
  s.addText("Agentic AI Platform", { x: 0.67, y: 2.6, w: 11.5, h: 1.3, color: C.text, fontSize: 54, bold: true, fontFace: FH, margin: 0 });
  s.addText("The maturity journey — from ad-hoc agents to a self-optimizing platform", { x: 0.72, y: 3.95, w: 11, h: 0.5, color: C.text, fontSize: 20, fontFace: FB, margin: 0 });
  shp(s, "RECTANGLE", { x: 0.72, y: 4.75, w: 2.2, h: 0.06, fill: { color: C.green } });
  s.addText("Build · govern · operate agents at enterprise scale — a point of view.", { x: 0.72, y: 5.0, w: 9.5, h: 0.5, color: C.dim, fontSize: 13, italic: true, fontFace: FB, margin: 0 });
  s.addNotes("Framing: agents are proliferating across the enterprise. The question is not whether to build them, but whether you can build them fast, safely and at scale on shared, governed foundations. This deck lays out the WHY (the cost of fragmented pilots) and the HOW (a four-level maturity journey from ad-hoc agents to a self-optimizing platform).");

  // ========================= 2 · WHY pains (dark) =========================
  s = p.addSlide(); s.background = { color: C.dark };
  titleDark(s, "Agents are proliferating faster than we can govern them", "The status quo · the paradox of fragmented pilots", C.red);
  s.addText("Every team is shipping agents. Without a platform, that speed turns into risk, waste and blind spots — and the cost of doing nothing compounds.",
    { x: 0.72, y: 1.95, w: 11.7, h: 0.5, color: C.dim, fontSize: 14, fontFace: FB, margin: 0 });
  const pains = [
    [I.sprawlW, "Agent Sprawl", "Disconnected teams duplicate prompts, tools and integrations. High technical debt; assets impossible to discover or reuse."],
    [I.shadowW, "Shadow AI", "Agents run outside sanctioned channels. Inconsistent PII/privacy guardrails and fragmented identity — real enterprise risk."],
    [I.costW, "Cost Blindness", "No per-agent cost attribution. Runaway token spend and no credible way to prove ROI on AI investment."],
    [I.obsW, "Observability Gap", "No unified tracing across agentic loops. Near-impossible to debug, and impossible to trust in production."],
  ];
  const pw = 2.86, pg = 0.24, px0 = 0.72, py = 2.75, ph = 3.35;
  pains.forEach(([icn, t, d], i) => {
    const x = px0 + i * (pw + pg);
    shp(s, "RECTANGLE", { x, y: py, w: pw, h: ph, fill: { color: C.card }, line: { color: "2A3450", width: 1 } });
    shp(s, "RECTANGLE", { x, y: py, w: pw, h: 0.08, fill: { color: C.red } });
    shp(s, "OVAL", { x: x + 0.32, y: py + 0.38, w: 0.86, h: 0.86, fill: { color: C.ink }, line: { color: C.red, width: 1.25 } });
    img(s, icn, x + 0.55, py + 0.6, 0.4, 0.4);
    s.addText(t, { x: x + 0.28, y: py + 1.4, w: pw - 0.5, h: 0.45, color: C.text, fontSize: 17, bold: true, fontFace: FH, margin: 0 });
    s.addText(d, { x: x + 0.28, y: py + 1.9, w: pw - 0.5, h: 1.3, color: C.dim, fontSize: 11.5, fontFace: FB, margin: 0, valign: "top" });
  });
  footerD(s, 2, "Why — the status quo");
  s.addNotes("Four recurring failure modes when there's no platform. Agent Sprawl: redundant engineering, slow delivery. Shadow AI: unsanctioned deployments, security and compliance exposure. Cost Blindness: no chargeback, runaway spend, no ROI story. Observability Gap: no unified tracing, so nothing is trustworthy in production. These are symptoms of the same root cause — no shared foundation.");

  // ========================= 3 · WHY strategic case (dark, stat callouts) =========================
  s = p.addSlide(); s.background = { color: C.dark2 };
  titleDark(s, "The strategic case for a shared platform", "Why it matters now", C.amber);
  const stats = [["Weeks", "to onboard each new agent when every team starts from scratch", C.red],
    ["0%", "reuse of skills, tools and evaluation across teams", C.amber],
    ["None", "no single pane of glass for cost, quality or security", C.violet]];
  stats.forEach(([big, lab, col], i) => {
    const y = 2.15 + i * 1.45;
    shp(s, "RECTANGLE", { x: 0.72, y: y + 0.16, w: 0.09, h: 0.64, fill: { color: col } });
    s.addText(big, { x: 0.97, y, w: 2.5, h: 1.0, color: C.text, fontSize: 44, bold: true, fontFace: FH, margin: 0, valign: "middle" });
    s.addText(lab, { x: 3.55, y: y + 0.1, w: 4.4, h: 0.9, color: C.text, fontSize: 13, fontFace: FB, margin: 0, valign: "middle" });
  });
  shp(s, "RECTANGLE", { x: 8.5, y: 2.05, w: 4.15, h: 4.1, fill: { color: C.cardHi }, line: { color: C.violet, width: 2 } });
  s.addText("The question isn't whether to build agents.", { x: 8.85, y: 2.4, w: 3.5, h: 0.85, color: C.dim, fontSize: 16, italic: true, fontFace: FB, margin: 0 });
  s.addText("It's whether you can build them fast, safely and at scale — on shared, governed foundations.", { x: 8.85, y: 3.3, w: 3.5, h: 1.6, color: C.text, fontSize: 18, bold: true, fontFace: FH, margin: 0 });
  s.addText("That is what a platform provides.", { x: 8.85, y: 5.35, w: 3.5, h: 0.5, color: C.green, fontSize: 14, bold: true, fontFace: FB, margin: 0 });
  footerD(s, 3, "Why — the strategic case");
  s.addNotes("Reframe from problem to opportunity. Three costs of inaction: onboarding measured in weeks, zero reuse, and no unified visibility. The turn: the decision is not whether to build agents — that's already happening — but whether the enterprise can do it fast, safe and at scale. That capability is exactly what a shared platform delivers, and the rest of the deck shows how it's built, level by level.");

  module.exports._ctx = { p, C, W, H, FH, FB, I, img, s, shp, titleLight, titleDark, footerL, footerD };
  return { p, I };
}
module.exports.build = build;
