const a = require("./deckv2.js"), b = require("./deckv2b.js"), c = require("./deckv2c.js");
(async () => {
  await a.build();
  const ctx = a._ctx;
  b.addHow(ctx);
  c.addRest(ctx);
  await ctx.p.writeFile({ fileName: "/tmp/deckgen/Agentic-AI-Platform-v2.pptx" });
  console.log("WROTE v2");
})().catch(e => { console.error(e); process.exit(1); });
