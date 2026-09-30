import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
});
