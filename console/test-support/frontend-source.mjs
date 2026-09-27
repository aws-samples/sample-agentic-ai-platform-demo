import { readFileSync } from "node:fs";

export const htmlShell = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
export const appSource = readFileSync(
  new URL("../public/modules/app.mjs", import.meta.url),
  "utf8",
);
export const styleSource = readFileSync(
  new URL("../public/styles/app.css", import.meta.url),
  "utf8",
);
export const frontendSource = [
  htmlShell,
  styleSource,
  appSource,
].join("\n");
