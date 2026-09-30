import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
});
