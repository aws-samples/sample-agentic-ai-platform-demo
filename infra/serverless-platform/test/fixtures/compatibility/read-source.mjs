import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

// Frozen source keeps rollback tests runnable from a ZIP or shallow clone.
export function historicalSource(revision, path) {
  const expected = manifest[revision]?.[path];
  if (!expected) throw new Error("Unknown compatibility fixture");
  const source = readFileSync(new URL(`./${revision}/${path}`, import.meta.url), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== expected) {
    throw new Error("Compatibility fixture checksum mismatch");
  }
  return source;
}
