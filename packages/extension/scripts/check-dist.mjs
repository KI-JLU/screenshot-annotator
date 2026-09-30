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

// The native host manifest's allowed_origins lists EXTENSION_ID, so the key must produce exactly it.
const { extensionIdFromKey } = await import("../src/lib/extensionId.ts");
const nativeSrc = readFileSync(resolve(import.meta.dirname, "../../shared/src/native.ts"), "utf8");
const expectedId = /EXTENSION_ID = "([a-p]{32})"/.exec(nativeSrc)?.[1];
const actualId = manifest.key ? await extensionIdFromKey(manifest.key) : undefined;
if (!expectedId || actualId !== expectedId) {
  console.error(`dist/manifest.json key yields extension id ${actualId ?? "(no key)"}, expected EXTENSION_ID ${expectedId}`);
  process.exit(1);
}
if (!manifest.permissions?.includes("nativeMessaging")) {
  console.error("dist/manifest.json lacks the nativeMessaging permission");
  process.exit(1);
}
console.log(`dist ok: ${[...refs].filter(Boolean).join(", ")}; extension id ${actualId}`);
