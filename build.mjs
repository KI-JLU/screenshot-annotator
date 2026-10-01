// Bundles the service worker and the injected overlay as classic scripts and copies public/ into dist/.
import { cpSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
cpSync("public", "dist", { recursive: true });
await build({
  entryPoints: { background: "src/background.ts", content: "src/content/overlay.ts" },
  bundle: true,
  format: "iife",
  target: "chrome116",
  outdir: "dist",
  logLevel: "info",
});
