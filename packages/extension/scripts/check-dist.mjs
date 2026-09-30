// Verifies that every file referenced by dist/manifest.json exists in dist/.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const manifest = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"));
const refs = new Set([
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  "content.js", // injected via chrome.scripting.executeScript({ files })
]);
const missing = [...refs].filter((f) => f && !existsSync(resolve(dist, f)));
if (missing.length) {
  console.error("dist/manifest.json references missing files:", missing.join(", "));
  process.exit(1);
}
console.log(`dist ok: ${[...refs].filter(Boolean).join(", ")}`);
