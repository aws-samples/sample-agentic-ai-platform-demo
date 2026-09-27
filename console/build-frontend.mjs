import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));

// This is the same static input used by PlatformWebStack.Source.asset.
// Runtime config is deployment-owned and intentionally not packaged here.
export async function buildFrontend(output) {
  const target = path.resolve(output);
  if (target === publicRoot || target.startsWith(publicRoot + path.sep)) {
    throw new Error("Build output must be outside the frontend source directory.");
  }
  await mkdir(target); // Refuse an existing output; never overwrite someone else's artifact.
  const files = [];
  async function copy(relative = "") {
    const entries = await readdir(path.join(publicRoot, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = path.join(relative, entry.name);
      if (name === "runtime-config.js") continue;
      if (entry.isDirectory()) {
        await mkdir(path.join(target, name));
        await copy(name);
      } else if (entry.isFile()) {
        const bytes = await readFile(path.join(publicRoot, name));
        await writeFile(path.join(target, name), bytes, { flag: "wx" });
        files.push({ path: name.split(path.sep).join("/"), bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      } else {
        throw new Error(`Non-regular frontend source is not allowed: ${name}`);
      }
    }
  }
  await copy();
  const manifest = { entry: "index.html", module: "modules/app.mjs", source: "console/public",
    generatedSeparately: ["runtime-config.js"], files };
  await writeFile(path.join(target, "frontend-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: node console/build-frontend.mjs <new-output-directory>");
  const manifest = await buildFrontend(process.argv[2]);
  console.log(JSON.stringify({ entry: manifest.entry, module: manifest.module, files: manifest.files.length,
    generatedSeparately: manifest.generatedSeparately }));
}
