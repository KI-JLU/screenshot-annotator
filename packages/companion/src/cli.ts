import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Keep app imports dynamic: logging must be redirected before any app module runs.
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "native-host") {
    for (const method of ["log", "info", "warn", "debug"] as const) console[method] = console.error.bind(console);
    const { startNativeHost } = await import("./native/host.ts");
    await startNativeHost(args[1]); return;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: "boolean" }, browser: { type: "string" }, "extension-id": { type: "string" },
  } });
  const help = "Befehle: native-host, install-native-host [--browser chrome|chromium|all] [--extension-id ID], uninstall-native-host, status, mcp, --help";
  if (values.help || !positionals.length) { console.log(help); return; }
  const command = positionals[0];
  if (command === "mcp") { const { startGateway } = await import("./mcp/gateway.ts"); await startGateway(); return; }
  const { installNativeHost, uninstallNativeHost, manifestPaths } = await import("./native/install.ts");
  if (command === "install-native-host") { installNativeHost(values.browser, values["extension-id"]); return; }
  if (command === "uninstall-native-host") { uninstallNativeHost(); return; }
  if (command === "status") {
    const { existsSync } = await import("node:fs");
    const { lockHeld } = await import("./native/lock.ts");
    const { getPaths } = await import("./paths.ts");
    for (const [browser, path] of Object.entries(manifestPaths())) console.log(`${browser}: Native-Host-Manifest ${existsSync(path) ? "installiert" : "nicht installiert"} (${path})`);
    console.log(`Begleitdienst: Instanzsperre ${lockHeld(getPaths().runtimeDir) ? "belegt" : "frei"}`); return;
  }
  throw new Error(help);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`Begleitdienst konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
