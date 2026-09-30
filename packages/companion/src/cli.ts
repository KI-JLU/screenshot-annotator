import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { DEFAULT_COMPANION_PORT } from "@website-review/shared";
import { createApp } from "./app.ts";
import { getPaths } from "./paths.ts";
import { Store } from "./store/store.ts";
import { createKanClient } from "./kan/kanClient.ts";
import { createAnalysisRunner } from "./codex/analysisRunner.ts";
import { startGateway } from "./mcp/gateway.ts";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { port: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { console.log("Befehle: serve [--port PORT], pair, status, mcp"); return; }
  const command = positionals[0] ?? "serve";
  const port = values.port === undefined ? DEFAULT_COMPANION_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Ungültiger Port");
  const paths = getPaths();
  if (command === "pair") {
    const store = new Store(paths.dataDir);
    try { console.log(`Kopplungscode: ${store.createPairingCode()} (10 Minuten gültig)`); }
    finally { store.close(); }
    return;
  }
  if (command === "status") {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error("Begleitdienst nicht erreichbar");
    const health = await response.json() as { paired: boolean; version: string };
    console.log(`Begleitdienst ${health.version}: erreichbar, ${health.paired ? "gekoppelt" : "nicht gekoppelt"}`);
    return;
  }
  if (command === "mcp") {
    await startGateway(); return;
  }
  if (command !== "serve") throw new Error("Befehle: serve [--port PORT], pair, status, mcp");
  const app = createApp({ ...paths, port, kanClientFactory: createKanClient, analysisRunner: createAnalysisRunner(), cliPath: process.argv[1] });
  try {
    const address = await app.start();
    console.log(`Begleitdienst läuft unter ${address.url}`);
  } catch (error) { await app.stop(); throw error; }
  const stop = () => { void app.stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Begleitdienst konnte nicht gestartet werden. Befehl, Port und lokale Einrichtung prüfen."); process.exitCode = 1; });
}
