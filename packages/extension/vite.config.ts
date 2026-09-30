import { resolve } from "node:path";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const pkg = import.meta.dirname;
const src = resolve(pkg, "src");

// Side panel (HTML) + background service worker (ES module). The content script is built
// separately as a classic IIFE (vite.content.config.ts) because chrome.scripting.executeScript
// cannot inject ES modules.
export default defineConfig({
  root: src,
  base: "./",
  publicDir: resolve(pkg, "public"),
  plugins: [preact()],
  build: {
    outDir: resolve(pkg, "dist"),
    emptyOutDir: true,
    target: "chrome116",
    modulePreload: { polyfill: false },
    sourcemap: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(src, "sidepanel.html"),
        background: resolve(src, "background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
