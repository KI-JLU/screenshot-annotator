import { resolve } from "node:path";
import { defineConfig } from "vite";

const pkg = import.meta.dirname;

// Capture overlay: one self-contained classic script, injected on demand via
// chrome.scripting.executeScript({ files: ["content.js"] }).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(pkg, "dist"),
    emptyOutDir: false,
    target: "chrome116",
    sourcemap: false,
    lib: {
      entry: resolve(pkg, "src/content/overlay.ts"),
      formats: ["iife"],
      name: "WebsiteReviewOverlay",
      fileName: () => "content.js",
    },
    rollupOptions: { output: { extend: true } },
  },
});
