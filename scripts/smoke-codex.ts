/**
 * Integration proof: one real analysis turn against the installed `codex app-server`.
 * Usage: node scripts/smoke-codex.ts <checkoutDir> [gatewayCommand gatewayArgs...]
 * Without a gateway the review MCP server is replaced by `false` (Codex must tolerate it).
 */
import { execFileSync } from "node:child_process";
import { createAnalysisRunner } from "../packages/companion/src/codex/analysisRunner.ts";

const [checkout, gatewayCommand = "false", ...gatewayArgs] = process.argv.slice(2);
if (!checkout) throw new Error("checkout dir required");
const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const runner = createAnalysisRunner({ turnTimeoutMs: 10 * 60_000 });
console.log("probe", await runner.probe());
const started = Date.now();
const result = await runner.analyze({
  review: { id: "smoke-review", projectName: "Smoke" },
  checkouts: [{ alias: "frontend", path: checkout, headCommit: head, hasUncommittedChanges: false }],
  comments: [
    {
      commentId: "c1",
      revision: 1,
      text: "Hier mehr Luft.",
      markKind: "element",
      context: {
        url: "http://localhost:3000/search",
        pageTitle: "Suche",
        viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
        scroll: { x: 0, y: 0 },
        elementText: "Suche",
        elementDescription: "section.filters",
      },
      questions: [],
    },
  ],
  otherComments: [],
  gateway: { command: gatewayCommand, args: gatewayArgs, env: {} },
});
console.log(JSON.stringify(result, null, 2));
console.log("seconds", Math.round((Date.now() - started) / 1000));
await runner.close();
